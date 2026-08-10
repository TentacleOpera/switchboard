# A Never-Opened Terminals Panel Holds a WebGL Context Per Terminal, Starving Every Other Window

## Goal

Stop acquiring GPU renderer contexts for terminal views that have no box to draw into,
and release the ones held by a panel that has been hidden long enough to stop mattering.
A `display:none` panel has no pixels; it must not consume a process-wide resource that a
visible window needs.

### Root Cause

`attachRenderer` (`src/webview/terminals.js:278`) takes a WebGL context the moment a
terminal view is *materialized*, with no regard for whether the view can still be seen
afterwards:

```javascript
if (window.WebglAddon && window.WebglAddon.WebglAddon && liveWebglContexts < MAX_WEBGL_CONTEXTS) {
```

The only guard is `liveWebglContexts < MAX_WEBGL_CONTEXTS` (12), and that counter is a
module-scope `let` inside the panel's IIFE (line 227) — **per document**. The browser's
real limit is **per renderer process** (~16 in Chromium), shared by every same-origin
document in it.

> **Superseded:** "The shell mounts the Terminals panel whether or not you ever open it …
> from cockpit load, a panel the operator has never clicked has already run
> `renderPaneGrid`, called `createTerminalView` for each assigned terminal, opened a
> WebSocket per terminal, and taken **one WebGL context per view** — all behind
> `display:none`."
> **Reason:** Not true at HEAD. `createTerminalView` (line 4258) claims the name and builds
> an empty container, then hands off to `whenRendered(entry, () => materializeTerminalView(entry))`
> (line 4306). `whenRendered` (line 4318) gates on `isRendered(entry.container)` and parks a
> `ResizeObserver` until the container has a real box. Both `attachRenderer` (line 4435) and
> `connectTerminalSocket` (line 4625) live *inside* `materializeTerminalView` (line 4333), so
> a never-opened Terminals panel holds **zero** xterm instances, **zero** WebSockets and
> **zero** WebGL contexts today. `whenRendered`'s own doc comment names this case exactly
> ("the whole panel may sit in a `display:none` iframe for the entire session until the
> operator clicks the Terminals icon"). That deferral landed in commit `99914d22`
> (2026-08-02), before this plan was drafted.
> **Replaced with:** The defect is not *acquisition against a boxless container* — that is
> already prevented. It is that **nothing ever gives a context back**. `whenRendered` fires
> once and is then gone; from materialization onward there is no path in the file that
> releases a WebGL context short of `destroyTerminalView`. Three states therefore hold a
> process-wide GPU resource behind zero pixels, and the first of them needs no second window
> at all:

**1. An unassigned-but-retained view keeps its context forever.** When a terminal is dropped
from the grid, `updatePaneElement` clears the slot and the container is **detached from the
DOM** — the entry survives in `terminalsMap` (lines 2600–2602: *"The node survives in
terminalsMap; only its parentage is dropped"*), deliberately, so the xterm scrollback
survives a reassignment. `armDetachTimer` only ever destroys views whose terminal has
**exited**; a live unassigned terminal is retained indefinitely by design. So an operator
working in a 1x1 layout who cycles through terminals accumulates held contexts up to
`MAX_WEBGL_CONTEXTS`, every one of them attached to a detached node with no box. This is
the leak with the widest blast radius and it exists in a single window with no pop-out
involved.

**2. A panel switched away from keeps every context it took.** The shell mounts all panel
iframes up front and toggles them with `display` (`shell.html:144-153`,
`.panel-frame { display: none } / .panel-frame.is-active { display: block }`, driven by
`selectPanel` at `shell.js:32`). From `shell.js`'s header comment (line 5):

> All iframes are mounted up-front and toggled via display; each panel keeps its state and
> its live WebSocket across switches (instant switch, no reconnect).

Once Terminals has been opened even once, its panes are materialized and hold their
contexts for the life of the page — including every minute the operator spends on the
Board. The gateway documents the same mount policy from its end, in
`reconcileTerminalSize`:

> That is how a hidden tab came to dictate the size: the browser shell mounts every panel
> iframe up front with `display:none`, so the Terminals panel connects while measuring
> 0x0, and an xterm with no layout reports its 80x24 construction default.

**3. "New window" is a second full panel, not a view onto the first.** The button
(lines 474–492) runs `window.open('/terminals', 'sb-terminals-panel', 'width=1200,height=800')`
— same origin, with an opener, so the browser keeps it in the *same renderer process*. It is
a complete second instance of `terminals.js` with its own `liveWebglContexts = 0`. Popping
out therefore does not cost N contexts; it costs 2N, and each document's ceiling sees only
its own half. The budget the pop-out cannot get is precisely the budget states 1 and 2 are
sitting on.

When the process cap is crossed, the browser force-loses contexts — and its eviction policy
is **least-recently-used: the 17th acquisition kills the OLDEST live context**, logging
`WARNING: Too many active WebGL contexts. Oldest context will be lost.` That is why the
damage never lands on the pane that was just touched. The oldest contexts are exactly the
long-lived idle panes — the ones sitting at a static CLI mode strip that nothing rewrites —
which is the reported symptom, arriving in a batch, on panes that did nothing.
`onContextLoss` drops to the canvas renderer, which paints only rows subsequently marked
dirty, so an idle terminal keeps whatever the dead surface left behind. (That repaint is
already fixed at line 306; see Dependencies.)

The failure is invisible in the holder and visible in the pop-out, which reads as "the
pop-out is broken". It is exactly backwards: the retained and hidden views are the ones
consuming the budget, and they never paint, so they never reveal their own loss.

### Background Context

`destroyTerminalView` (line 4202) already carries most of this understanding:

> Before `term.dispose()`: the GPU renderers hold a WebGL context / canvas that browsers
> cap **per page** (~16 contexts), so leaking one per closed terminal eventually forces
> every terminal back to the DOM renderer.

The cap is right, the number is right, and "per page" is the blind spot — it is per
*process*, which is why a second window and a hidden iframe both count and neither
document can see the other. Teardown is already correct; what is missing is any release
short of teardown.

`isRendered(el)` (line 170) is the existing, already-trusted answer to "does this have a
box":

```javascript
function isRendered(el) {
    if (!el) { return false; }
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
}
```

`fitAndReportSize`, `inspectPaneFit` and `whenRendered` all gate on it, and it is true for
exactly the conditions that matter here: an element inside a `display:none` iframe has a
zero rect, and so does a detached one.

Every materialized view already gets a per-container `ResizeObserver` (lines 4497–4510)
with a 100 ms debounce, and its comment records that `active` is assignment rather than
visibility. It is the natural carrier for the upgrade/downgrade hook, and Resolved Assumption 1
confirms it receives the iframe-hide transition before the frame throttler suspends the child
document.

`resyncPaneRenderer` (line 3333) is the repair that must follow any renderer swap **that
happens on screen**: a new renderer starts on an empty surface and paints only dirty rows,
so without `clearTextureAtlas()` + `refresh(0, rows-1)` + `handleResize`, every already-drawn
row keeps the outgoing renderer's pixels.

## Metadata

**Tags:** frontend, bugfix, performance, reliability
**Complexity:** 7

## User Review Required

None. Three decisions were made inside this plan rather than deferred:

- **Release delay is 5 s** (`RENDERER_RELEASE_DELAY_MS`), not configurable and not surfaced
  in Setup. It exists only to stop panel flipping from thrashing the GPU; a setting would be
  a knob nobody can reason about.
- **A `WebglAddon` constructor throw retires that pane for the life of the page** rather
  than being retried on every resize tick. Other panes are unaffected.
- **`noopener` on the pop-out is not adopted** — see Adversarial Synthesis for why it was
  considered and rejected.

## Complexity Audit

### Routine
- Adding a box check and a `rendererDeferred` field to `attachRenderer` and the entry literal.
- Clearing one more timer in `destroyTerminalView`.
- Correcting the "per page" / "per document" doc comments.
- A source-scanning contract test in the established style of `terminal-pane-fit-verification-contract.test.js`.

### Complex / Risky
- **`WebglAddon.dispose()` does not free the GL context, so the naive version of this feature
  frees nothing.** The vendored `src/webview/vendor/xterm/addon-webgl.js` contains **zero**
  references to `WEBGL_lose_context` or `loseContext`; `dispose()` clears intervals, removes
  the atlas page canvases and disposes listeners, then leaves the live WebGL2 context to the
  garbage collector. The browser's per-process ceiling is charged against the **live** context,
  not against our intent to drop it. Without an explicit `loseContext()` this plan would
  decrement `liveWebglContexts`, flip `isWebgl` to `false`, and satisfy every check in its own
  verification plan while the process budget is completely unchanged. This is the single
  highest-risk item in the change and the reason `forceReleaseWebglContext` exists in File 2.
- **Runtime renderer swaps on a live terminal.** Release-then-dispose-then-attach on a
  `Terminal` that is attached, scrolled, and receiving pty output. Ordering is load-bearing
  (two loaded renderers on one `Terminal` is not a supported xterm state; and `dispose()`
  drops the only reference by which the context can be reached) and every on-screen swap must
  be followed by `resyncPaneRenderer` or it strands pixels — the same defect the
  `onContextLoss` handler had.
- **Deliberately losing a context re-enters our own loss handler.** `loseContext()` fires
  `webglcontextlost`, which the addon forwards to the `onContextLoss` callback this file
  registers — the callback whose job is to recover by attaching a canvas renderer. Firing it
  in the middle of a controlled swap would double-attach and race the swap's own replacement.
- **Context accounting must not drift.** Increment and decrement are currently spread across
  `attachRenderer`, `onContextLoss` and `destroyTerminalView` with no interlock; adding a
  fourth release site by hand is how a counter goes wrong. This plan replaces the scheme with
  a one-shot release closure rather than adding to it, and folds the real context release into
  that same closure so the two can never diverge.
- **Two reaches into private vendored surface** — `term._core._renderService` (existing,
  precedented) and `addon._renderer._gl` (new). Both are defensively guarded, but a vendored
  xterm upgrade can silently turn either into a no-op, and the `_gl` one fails *silently and
  invisibly* (the budget quietly stops being freed). A contract test pins the exact property
  path so a bundle bump breaks the build rather than the feature.

## Edge-Case & Dependency Audit

### Race Conditions

- **Release timer vs. re-show.** A pane hidden for 4.9 s and re-shown must cancel its pending
  release; otherwise the timer fires against a now-visible pane and drops it to canvas.
  `cancelRendererRelease` runs on every visible-trigger before anything else.
- **Release timer vs. teardown.** `destroyTerminalView` must clear `entry.releaseTimer`, or a
  timer fires against a disposed entry. `reconcileRendererForVisibility` also guards on
  `entry.disposed` as a second line.
- **Repeated observations, one action.** The `ResizeObserver` fires on every geometry change,
  not only on visibility transitions. `armRendererRelease` early-returns on an already-armed
  timer and `reconcileRendererForVisibility` re-reads `isRendered` and does nothing when the
  state already matches, so both are idempotent under repeat firing.
- **Deliberate context loss re-entering the loss handler.** `loseContext()` dispatches
  `webglcontextlost`, which the addon forwards to the `onContextLoss` callback whose job is to
  recover onto canvas — while `swapRenderer` is mid-swap and about to attach the replacement
  itself. Resolved by ordering: `release()` sets `released = true` *before* calling
  `loseContext()`, and the handler's first statement is `if (released) { return; }`. The
  guard cannot be skipped by dispatch timing, synchronous or queued.
- **Budget won by another pane between check and swap.** JavaScript is single-threaded and
  `liveWebglContexts` is only mutated synchronously inside these functions, so the check and
  the acquisition cannot interleave *within* a document. Across documents there is no
  interlock at all and none is claimed — the process cap is enforced by the browser, and the
  `onContextLoss` repair is what covers being on the losing side of it.
- **Swap during pty output.** `entry.batchQueue` is drained on a shared rAF; a swap between
  frames leaves the buffer untouched (dispose/attach touch only the renderer) and the
  following `resyncPaneRenderer` repaints the whole viewport, so no output is lost or
  duplicated.

### Security

None. No new network surface, no new message handler, no user-controlled input reaches any
of the added code. Everything runs inside the existing panel IIFE against DOM state it
already owns.

### Side Effects

- **Panes may render on canvas for one frame** on their first paint and after each upgrade.
  Canvas is a fully working renderer; this is a throughput change, never a correctness one.
- **`resyncPaneRenderer` call frequency rises.** It now also fires on every on-screen
  renderer swap, not only on a failed fit verdict. Each call is one forced layout read plus a
  full `refresh()` — noticeable only if swaps become frequent, which the 5 s release delay is
  what prevents.
- **A `webglcontextlost` event is now dispatched on purpose, per release.** It is swallowed by
  the `released` guard, but it is real and will appear to anything else listening on the
  canvas. Nothing in this codebase does; a future addon might.
- **A retained, unassigned terminal loses WebGL.** By design — it has no box. Reassigning it
  upgrades it on the next observer tick.

### Dependencies & Conflicts

- **`onContextLoss` repaint — already landed.** `attachRenderer`'s handler calls
  `resyncPaneRenderer(entry, 'stale-canvas')` at line 306. This plan reuses the same
  primitive and no longer waits on it.
- **`terminal-pane-fit-verification-contract.test.js` asserts declaration order** for
  `readRenderedGrid -> inspectPaneFit -> resyncPaneRenderer -> startFitLadder ->
  batchFitVisiblePanes -> const DEFAULT_ROLES` and slices source spans between those markers.
  The new functions must be declared **outside** those spans — put `forceReleaseWebglContext`,
  `reconcileRendererForVisibility`, `swapRenderer`, `armRendererRelease` and
  `cancelRendererRelease` next to `attachRenderer` (~line 320), which is well above
  `readRenderedGrid`. Declaring them between the existing markers would silently widen another
  test's spans.
- **`src/webview/vendor/xterm/addon-webgl.js` is a vendored bundle** and
  `forceReleaseWebglContext` depends on its private shape (`_renderer._gl`). Any xterm upgrade
  must re-verify that path; the contract test below pins it so a bump fails the build rather
  than silently stopping the release.
- **No shell change.** `shell.js`'s mount-everything-up-front policy is deliberate ("instant
  switch, no reconnect") and is not altered. The panel detects its own visibility.
- **No gateway or protocol change.** No resize frame is sent from any path this plan adds;
  `fitAndReportSize` remains the only sender and remains gated on `isRendered`.
- **Applies to the browser cockpit and the pop-out alike** — same file, same IIFE, no
  host-specific branch.

## Dependencies

- None. (The `onContextLoss` → `resyncPaneRenderer` repair this plan builds on is already in
  `src/webview/terminals.js:306`; it was previously listed here as a blocking prerequisite.)

## Adversarial Synthesis

**Key risks:** (1) `WebglAddon.dispose()` does not free the GL context — it leaves it to GC —
so a release path that only disposes would report a freed budget the process has not freed,
passing every self-check while fixing nothing; (2) runtime renderer swaps on a live terminal
strand already-drawn pixels unless every on-screen swap is followed by `resyncPaneRenderer`,
and the deliberate `loseContext()` re-enters the very handler that recovers from context loss;
(3) context accounting drifts if a fourth decrement site is added to the three that already
exist.

**Mitigations:** an explicit `WEBGL_lose_context.loseContext()` folded into a one-shot
per-acquisition release closure, so the real release and the accounting release are the same
call and cannot diverge — and whose `released` flag doubles as the re-entrancy guard on
`onContextLoss`; every swap ending in a `resyncPaneRenderer` gated on the pane actually having
a box; and a strict release → dispose → attach ordering, each step of which is pinned by a
contract test.

## Proposed Changes

### File 1: `src/webview/terminals.js` — one-shot release + a box check on acquisition

Replace the ad-hoc `liveWebglContexts` decrements with a release closure created at the
moment of acquisition, and record whether an upgrade is owed. Around lines 278–319:

```javascript
    /** Is a WebGL renderer even possible in this document? */
    function webglAvailable() {
        return !!(window.WebglAddon && window.WebglAddon.WebglAddon);
    }

    function attachRenderer(term, entry) {
        // `release` is a no-op on every non-WebGL path, so callers never branch.
        const holder = { current: null, release: () => {} };
        // A container with no box cannot be painted, and a WebGL context is a
        // PROCESS-wide resource. createTerminalView already defers materialization
        // until the container has a box (see whenRendered), so this is a belt on top
        // of braces for the ORIGINAL acquisition — but swapRenderer re-enters here on
        // the upgrade path, and this is what keeps that path honest without the caller
        // having to re-check. MAX_WEBGL_CONTEXTS cannot catch a boxless acquisition:
        // it counts THIS document's contexts, and the pop-out is a second document in
        // the same process with its own counter starting at zero.
        const hasBox = entry ? isRendered(entry.container) : true;
        if (webglAvailable() && hasBox && liveWebglContexts < MAX_WEBGL_CONTEXTS) {
            try {
                const webgl = new window.WebglAddon.WebglAddon();
                // EXACTLY ONE decrement per acquisition, from any path, in any order.
                // Before this there were three independent decrement sites keyed on
                // entry.isWebgl; a renderer swap makes that a fourth, and hand-pairing
                // four sites is how a counter drifts low and over-allocates (or drifts
                // high and pins every pane to canvas for the life of the page).
                let released = false;
                holder.release = () => {
                    if (released) { return; }
                    released = true;
                    liveWebglContexts = Math.max(0, liveWebglContexts - 1);
                    if (entry) { entry.isWebgl = false; }
                    // The ONLY call site. Folding the real release into the accounting
                    // release is what makes it impossible for the counter to say
                    // "freed" while the process still holds the context.
                    forceReleaseWebglContext(webgl);
                };
                webgl.onContextLoss(() => {
                    // A release WE initiated. forceReleaseWebglContext calls
                    // loseContext(), which fires webglcontextlost right back into this
                    // handler — and swapRenderer/destroyTerminalView are mid-teardown
                    // and will attach the replacement themselves. Recovering here would
                    // double-attach and race them. `released` is already true by the
                    // time loseContext() runs, so this guard is exact.
                    if (released) { return; }
                    console.warn('[Terminals] WebGL context lost — falling back to canvas renderer');
                    holder.release();
                    try { webgl.dispose(); } catch { /* ignore */ }
                    holder.current = attachCanvasRenderer(term);
                    if (entry) {
                        // Debt, not defeat: the context was taken away, not declined.
                        // The next visibility tick retries once the budget allows.
                        entry.rendererDeferred = webglAvailable();
                        // …existing comment block on why the repaint is mandatory…
                        resyncPaneRenderer(entry, 'stale-canvas');
                    }
                });
                term.loadAddon(webgl);
                holder.current = webgl;
                if (entry) { entry.isWebgl = true; entry.rendererDeferred = false; }
                liveWebglContexts++;
                return holder;
            } catch (err) {
                console.warn('[Terminals] WebGL renderer unavailable, falling back:', err);
                // No debt recorded. A constructor that threw will throw again on the
                // next tick, and retrying it per tick is exactly the churn this
                // machinery exists to avoid. This pane stays on canvas for the life of
                // the page; every other pane is unaffected.
                if (entry) { entry.rendererDeferred = false; }
                holder.current = attachCanvasRenderer(term);
                return holder;
            }
        }
        // Boxless, budget-exhausted, or no addon at all — one expression covers all
        // three: a debt is owed exactly when WebGL is possible but not held.
        if (entry) { entry.rendererDeferred = webglAvailable(); }
        holder.current = attachCanvasRenderer(term);
        return holder;
    }
```

> **Superseded:** `if (entry) { entry.rendererDeferred = !hasBox; }` placed after the WebGL
> block, with the decrement scheme left as "three places … each gated on `entry.isWebgl`".
> **Reason:** Two defects. (a) The WebGL arm `return`s from inside the `try`, so that
> assignment is unreachable on the success path and reachable only by accident on the
> failure paths — and it records `false` when the real reason for being on canvas is an
> exhausted budget, which is a debt that *should* be retried. (b) Keeping `entry.isWebgl` as
> the decrement guard means a fourth release site (the swap) must be hand-paired with three
> existing ones, and `onContextLoss` currently decrements *unguarded*, so a loss arriving
> after a swap would double-decrement.
> **Replaced with:** `rendererDeferred = webglAvailable()` on every canvas path except a
> constructor throw (which retires the pane), and a per-acquisition one-shot `holder.release()`
> that every site calls instead of touching `liveWebglContexts` directly.

Seed `rendererDeferred: false` and `releaseTimer: null` in the entry literal beside
`rendererAddon: null` / `isWebgl: false` (lines 4280–4281).

### File 2: `src/webview/terminals.js` — settle the debt on the visibility transition

Declared immediately after `attachRenderer` (~line 320) — **above** `readRenderedGrid`, so the
declaration-order spans in `terminal-pane-fit-verification-contract.test.js` are untouched.

```javascript
    /** Hidden long enough to be worth reclaiming. Short flips between shell panels
     *  must not thrash the GPU: a switch out and back inside this window keeps its
     *  context and costs nothing. */
    const RENDERER_RELEASE_DELAY_MS = 5000;

    /**
     * Hand the GL context back to the browser NOW, rather than whenever GC runs.
     *
     * The vendored addon-webgl.js contains ZERO references to WEBGL_lose_context.
     * WebglAddon.dispose() tears down its renderer, listeners and atlas page canvases
     * and then leaves the live WebGL2 context to the garbage collector. The browser's
     * per-process ceiling is charged against the LIVE context, not against our intent
     * to drop it, so a disposed-but-uncollected addon still occupies a slot for an
     * unbounded time. Without this call the entire release half of this change is
     * cosmetic: liveWebglContexts and __sbTerminalStats would both report a freed
     * budget that the process has not freed.
     *
     * Private surface, same precedent and same defensive shape as
     * term._core._renderService in readRenderedGrid/resyncPaneRenderer: every hop
     * guarded, whole thing inside a try, silent no-op if a vendored xterm upgrade
     * changes the shape. MUST run BEFORE dispose() — dispose() drops the renderer
     * reference, and with it the only path to the context.
     */
    function forceReleaseWebglContext(addon) {
        try {
            const gl = addon && addon._renderer && addon._renderer._gl;
            if (!gl || typeof gl.getExtension !== 'function') { return; }
            const ext = gl.getExtension('WEBGL_lose_context');
            if (ext && typeof ext.loseContext === 'function') { ext.loseContext(); }
        } catch { /* vendored shape changed — dispose() below still runs */ }
    }

    /**
     * Bring `entry`'s renderer in line with whether it currently has a box.
     *
     * This function is the AUTHORITY — every trigger (the ResizeObserver and the release
     * timer) funnels here, and here alone re-reads isRendered. Triggers may be cheap
     * and approximate; this is not.
     */
    function reconcileRendererForVisibility(entry) {
        if (!entry || entry.disposed || !entry.term || !entry.rendererAddon) { return; }
        const hasBox = isRendered(entry.container);

        if (hasBox) {
            // Budget still exhausted -> keep the debt and return; the next tick retries,
            // and a released context (a closed terminal, another pane hidden) is what
            // lets it through.
            if (!entry.isWebgl && entry.rendererDeferred
                && webglAvailable() && liveWebglContexts < MAX_WEBGL_CONTEXTS) {
                swapRenderer(entry, /* wantWebgl */ true);
            }
            return;
        }
        // Released, not merely idle. Without this a panel switched away from — or a
        // terminal unassigned from the grid but retained for its scrollback — keeps its
        // context for the life of the page, which is the exact budget a popped-out
        // window then cannot get.
        if (entry.isWebgl) { swapRenderer(entry, /* wantWebgl */ false); }
    }

    function swapRenderer(entry, wantWebgl) {
        const outgoing = entry.rendererAddon;
        // RELEASE, then DISPOSE, then attach. All three orderings are load-bearing:
        //  - release BEFORE dispose, because release() reaches addon._renderer._gl and
        //    dispose() drops _renderer — after it, the context is unreachable and can
        //    only be reclaimed by a GC we do not control.
        //  - release BEFORE the try, so a dispose() that throws still gives the budget
        //    back. Otherwise the counter is short by one for the life of the page and
        //    every pane ends up pinned to canvas with no diagnostic.
        //  - dispose BEFORE attach, because two renderers loaded on one Terminal is not
        //    a supported xterm state and the outgoing one owns the surface the incoming
        //    one needs.
        // release() is one-shot, so the webglcontextlost it provokes cannot re-enter
        // this swap through the addon's own onContextLoss handler.
        outgoing.release();
        try { if (outgoing.current) { outgoing.current.dispose(); } } catch { /* ignore */ }
        outgoing.current = null;

        // A NEW holder, deliberately. The outgoing addon's onContextLoss closure captured
        // the OLD holder, and the incoming WebGL addon's closure must write to the new
        // one — which attachRenderer returning a fresh holder gives for free. Do not
        // "optimise" this into mutating the holder in place.
        entry.rendererAddon = wantWebgl
            ? attachRenderer(entry.term, entry)          // sets isWebgl + rendererDeferred
            : { current: attachCanvasRenderer(entry.term), release: () => {} };
        if (!wantWebgl) { entry.rendererDeferred = webglAvailable(); }

        // ONLY when there is something on screen to repair. A renderer swap does not
        // repaint what is already drawn — the incoming renderer starts empty and paints
        // only rows the terminal later marks dirty, which is the same defect the
        // onContextLoss handler had. But on the RELEASE direction there are no pixels to
        // strand, and driving _renderService.handleResize against a zero-size box makes
        // the canvas renderer measure a zero cell and size itself to nothing. The pane
        // would self-heal on its next fit ladder, but there is no reason to break it in
        // the first place.
        if (isRendered(entry.container)) { resyncPaneRenderer(entry, 'stale-canvas'); }
    }

    function cancelRendererRelease(entry) {
        if (entry.releaseTimer) {
            clearTimeout(entry.releaseTimer);
            entry.releaseTimer = null;
        }
    }

    function armRendererRelease(entry) {
        if (entry.releaseTimer || entry.disposed) { return; }   // idempotent
        entry.releaseTimer = setTimeout(() => {
            entry.releaseTimer = null;
            reconcileRendererForVisibility(entry);
        }, RENDERER_RELEASE_DELAY_MS);
    }

```

> **Superseded:** a module-level `sweepRendererVisibility()` on a 4 s `setInterval`, added as a
> backstop on the assumption that a `ResizeObserver` inside an iframe the parent just set to
> `display:none` might never deliver its 0x0 observation.
> **Reason:** research settled it (see Resolved Assumptions). The observation **is** delivered,
> on the style/layout pass of the frame in which the parent applies `display:none`, before the
> frame throttler suspends the child's rendering pipeline; and detachment from the DOM fires
> `0x0` on all three engines. Both of this plan's hide triggers therefore arrive. The sweep was
> insurance against a hazard that does not exist, and it carried real cost: a permanent timer
> per document, a second trigger path to keep idempotent, and an `isConnected` heuristic that
> silently disagrees with `isRendered` for the solo pop-out's `display` flip.
> **Replaced with:** the per-entry `ResizeObserver` as the sole trigger. The one thing the
> backstop was genuinely needed for — that the release must still *complete* after the frame
> stops rendering — is covered by the timers the observer callback sets, which research
> confirms keep firing in a hidden foreground iframe (aligned to a 30–100 ms floor, which is
> immaterial to a 5 s release).

Wire the primary trigger into the existing per-entry `ResizeObserver` (lines 4497–4510),
keeping its current `active`/fit-ladder behaviour intact:

```javascript
        let resizeTimer = null;
        const resizeObserver = new ResizeObserver(() => {
            if (resizeTimer) clearTimeout(resizeTimer);
            resizeTimer = setTimeout(() => {
                if (isRendered(entry.container)) {
                    cancelRendererRelease(entry);
                    // BEFORE the fit ladder: the ladder inspects the PAINTED grid via
                    // readRenderedGrid, and running it across a renderer swap would have
                    // it measure a surface that is about to be replaced.
                    reconcileRendererForVisibility(entry);
                } else {
                    armRendererRelease(entry);
                }
                // `active` is pane ASSIGNMENT, not visibility — a hidden panel's panes
                // are still "active". inspectPaneFit/fitAndReportSize gate on actually
                // having a box.
                if (entry.container.classList.contains('active')) {
                    startFitLadder(entry.name);
                }
            }, 100);
        });
```

In `destroyTerminalView` (line 4202), clear the release timer alongside `reconnectTimer`, and
route the context drop through the holder's one-shot release:

```javascript
        cancelRendererRelease(entry);
        …
        // Before term.dispose(): the GPU renderers hold a WebGL context / canvas that
        // browsers cap per RENDERER PROCESS (~16 contexts) — shared with every
        // same-origin document in it, including a popped-out second panel — so leaking
        // one per closed terminal eventually forces every terminal back to the DOM
        // renderer.
        if (entry.rendererAddon) {
            entry.rendererAddon.release();   // BEFORE the try and BEFORE dispose — see swapRenderer
            try {
                if (entry.rendererAddon.current) { entry.rendererAddon.current.dispose(); }
            } catch { /* ignore */ }
            entry.rendererAddon.current = null;
        }
```

> **Superseded:** the original `destroyTerminalView` shape, which decremented
> `liveWebglContexts` **inside** the same `try` as `dispose()`, after it.
> **Reason:** two defects. A `dispose()` that throws skips the decrement and nothing ever
> restores it — the document's budget is permanently short by one, and after enough of them
> every terminal is pinned to the DOM/canvas renderer for the life of the page with no
> diagnostic. And because `dispose()` drops `addon._renderer`, running it first destroys the
> only path to the GL context, so the slot could not be handed back explicitly even in the
> success case — it would wait on GC.
> **Replaced with:** `release()` before the `try` and before `dispose()`. One-shot, so it is
> safe even if a context loss for the same addon arrives afterwards.

### File 3: `src/webview/terminals.js` — correct the cap's doc comments

Three sites state or imply the wrong scope, and the wrong word is what makes the pop-out
interaction invisible when reading this file:

1. `destroyTerminalView` (lines 4225–4227): "cap per page (~16 contexts)" → "cap per renderer
   process (~16 contexts), shared with every same-origin document in it, including a
   popped-out second panel". (Included in the File 2 snippet above.)
2. Beside `MAX_WEBGL_CONTEXTS` (line 226): note that it is a **per-document** ceiling and is
   therefore *not* the control that keeps the process under its limit — `liveWebglContexts`
   is a `let` inside this IIFE and a second document has its own, starting at zero.
3. `__sbTerminalStats` (lines 5030–5037) already states the per-process/per-document split
   correctly; leave it, and add `rendererDeferred: entry.rendererDeferred === true` to the
   emitted stats so the manual verification below can distinguish "on canvas, owed an
   upgrade" from "on canvas, retired".

## Edge Cases

**Unassigned-but-retained terminal.** Its container is detached (`updatePaneElement`, lines
2600–2602) and `armDetachTimer` never destroys it while the terminal is alive. Detaching an
observed element fires a `0x0` observation (Resolved Assumption 2), so the release arms and the
context comes back 5 s later; reassigning the terminal re-parents the container, the observer
fires with a real box, and the upgrade runs. This is the case that makes the release half worth
shipping even for an operator who never opens a second window.

**Pane visible but budget exhausted.** `reconcileRendererForVisibility` returns with the debt
intact, so the pane runs on canvas and retries on the next observer tick. Canvas is
a fully working renderer — this degrades throughput, never correctness. This is also the case
that makes the `onContextLoss` repaint load-bearing rather than redundant: two visible windows
can still cross the process cap between them, and nothing in this plan can prevent that from
one document.

**Rapid panel flipping.** The 5 s release delay is cancelled by any re-show, so a switch out
and back keeps the context and costs nothing — preserving the shell's "instant switch"
property. Only a sustained hide reclaims.

**First paint of a genuinely visible panel.** `whenRendered` already guarantees the container
has a box before `attachRenderer` runs, so a first-open pane takes WebGL immediately. The
`hasBox` guard in `attachRenderer` therefore changes nothing on this path; it exists for the
upgrade path and for any future caller.

**Solo pop-out (`?solo=`).** `checkSoloNotFound` flips the container's own `display`, which the
`ResizeObserver` observes directly. The reconcile rides that transition with no extra wiring.

**Whole tab backgrounded.** `setTimeout` is clamped to ≥1 s (and ≥1 min for chained timers) in a
background tab, so a pending release can land well after its nominal 5 s. Harmless: a
backgrounded tab is not competing for contexts with anything, and the release is not
latency-critical. On return, any transition that happened meanwhile is carried by the observer.

**Counter drift.** After this change there is exactly **one** increment (`attachRenderer`) and
exactly **one** decrement path — `holder.release()`, created at the moment of acquisition,
one-shot, called from `onContextLoss`, `swapRenderer` and `destroyTerminalView`. Order and
duplication are structurally impossible rather than review-enforced. A test asserts that
`liveWebglContexts--` / `- 1` appears nowhere outside that closure.

**DOM-renderer fallback.** When `CanvasAddon` is unavailable `attachCanvasRenderer` returns
`null` and xterm uses its built-in DOM renderer. `swapRenderer` guards the `dispose()` on
`current` being truthy, the canvas-side holder carries a no-op `release`, and
`resyncPaneRenderer` already tolerates a renderer without an atlas.

**No `WebglAddon` at all.** `webglAvailable()` is false, so `rendererDeferred` is false on
every pane, the upgrade arm never runs, and the release arm never runs (`isWebgl` is never
true). The observer callback keeps doing exactly what it does today. No churn.

**Firefox and Safari.** Safari shares Chromium's 16-per-process ceiling, so the release matters
there identically. Firefox allows 200 contexts per principal, which this panel cannot
realistically exhaust — the change is inert rather than harmful there, and no engine-specific
branch is warranted.

## Resolved Assumptions

Settled by web research (2026-08-09) plus a direct read of the vendored bundle. **Authoritative
— do not re-open these during implementation.**

1. **A `ResizeObserver` inside an iframe DOES receive the hide transition.** When the parent
   sets the iframe to `display:none`, the element loses its principal layout box, reports
   `0x0`, and the observation is gathered and broadcast during the same rendering pass —
   *before* Blink's frame throttler suspends the child's pipeline. Exactly one observation is
   delivered; no further ones occur until the frame is shown again. One is all this design
   needs. → the primary trigger works; the periodic sweep was cut.
2. **`ResizeObserver` fires `0x0` on DOM detachment** while the element remains observed —
   specified (csswg-drafts #3664, #7808) and implemented in Blink, Gecko and WebKit. → the
   unassigned-but-retained view (the widest-blast-radius case) is carried by the observer.
   Caveat recorded: an element already rendered at `0x0` before removal produces no new
   observation, which cannot apply here — a pane only holds a context if it was materialized
   against a real box.
3. **`setTimeout` / `setInterval` keep firing in a `display:none` iframe of a foreground tab**,
   subject to task-alignment throttling with a floor somewhere in the 30–100 ms range (Blink
   Finch trials vary it). This is *not* the 1 s/1 min background-tab clamp. → the observer
   callback's 100 ms debounce and the 5 s `releaseTimer` both complete after the frame stops
   rendering, which is what makes a single hide observation sufficient. `requestAnimationFrame`
   and `IntersectionObserver`, by contrast, are fully suspended — neither is usable here.
4. **The WebGL ceiling is 16 live contexts per RENDERER PROCESS in Chromium** (Safari the same;
   Firefox is effectively unbounded for this purpose at 200 per principal). Eviction is
   **least-recently-used** — the 17th acquisition force-loses the oldest live context and logs
   `WARNING: Too many active WebGL contexts. Oldest context will be lost.` → confirms both the
   "per process, not per page" doc-comment correction and why the damage lands on idle panes.
5. **A same-origin `window.open` retaining an opener shares the opener's renderer process** —
   guaranteed, because same-origin synchronous cross-window scripting requires it. → the
   pop-out genuinely competes for the same 16 slots. `noopener` starts a new browsing context
   group and *usually* gets its own process, but it is heuristic (process-count cap, memory
   pressure), and it breaks window-name targeting — see the rejection in Adversarial Synthesis.
6. **`WebglAddon.dispose()` does NOT release the GL context.** `WEBGL_lose_context` and
   `loseContext` appear **zero** times in `src/webview/vendor/xterm/addon-webgl.js` (verified by
   direct grep, not inference). The renderer holds the context at `this._gl` on a canvas at
   `this._canvas`; `dispose()` clears timers, removes atlas page canvases and disposes
   listeners, leaving the context for GC. Chromium charges the ceiling against the live context.
   → File 3 (`forceReleaseWebglContext`) is mandatory, not an optimisation; without it this
   change is cosmetic.

## Design Rationale — Rejected Alternatives

*(The required 2–3 sentence Risk Summary lives in `## Adversarial Synthesis` above; this
section carries the reasoning behind the chosen approach.)*

### Rejected alternatives

**"Just lower `MAX_WEBGL_CONTEXTS`."** It is per document. Halving it to 6 still allows
6 + 6 across two windows, still spends the budget on invisible panes, and costs the main
window WebGL on terminals 7–12 that are genuinely on screen. It tunes the wrong axis: the
problem is not how many contexts one document takes, it is that contexts are held by views
with no pixels.

**"Don't mount the Terminals panel until it is opened."** A shell-wide policy change trading
a documented feature — instant switch with live sockets preserved — for a narrower fix. It is
also now moot: `whenRendered` already makes an unopened panel cost nothing.

**"Make the pop-out `noopener` so it gets its own process and its own budget."** Tempting as a
one-line fix, and rejected on three counts. It does not address the leak at all — it only
gives the second window a fresh budget while the first keeps holding contexts behind zero
pixels, so the single-window unassigned-view case is untouched. It breaks
`window.opener.document.body` (line 344), which is how the pop-out inherits the shell's theme
class. And `noopener` causes the window **name** to be ignored, so `'sb-terminals-panel'` no
longer focuses the existing pop-out — every click opens another one, which makes the budget
problem worse rather than better. Worth revisiting only alongside a themed-URL parameter and a
different focus strategy.

**"Make `liveWebglContexts` process-wide by sharing the count across documents."** The honest
fix to the counter's blindness — a `SharedWorker` or `localStorage` tally the pop-out and the
main window both read. Rejected as the wrong first move: it makes the *ceiling* accurate but
still lets invisible views spend it, so it needs everything in this plan anyway; and a shared
counter has no crash recovery (a closed or crashed window leaks its tally permanently, pinning
every surviving window to canvas with no way back short of a full reload).

**"Release-on-hide adds churn for little gain."** With `whenRendered` already covering the
never-opened panel, release-on-hide is not the second half of this plan — it is the *whole*
plan. Without it nothing in the file ever returns a context short of destroying the view, and
the retained-unassigned-view case leaks in a single window with no pop-out involved. The 5 s
delay is what keeps it from becoming churn.

### The Grumpy Architect's remaining objections, kept

**Risk: a runtime renderer swap is more invasive than a guard.** Real, and unavoidable — the
guard alone is now a no-op, so the swap *is* the change. Mitigated by making every on-screen
swap end in `resyncPaneRenderer` and by asserting that pairing in a contract test.

**Risk: the process-level cap is inferred, not measured.** ~16 per process is the documented
Chromium behaviour and matches the number already recorded in `destroyTerminalView`, but the
exact limit varies by browser and GPU. The design does not depend on the number — it depends
on not holding contexts for invisible views, which is correct at any cap.

**Risk: the release can succeed on paper and free nothing.** The sharpest objection, and the
one that survived research rather than being answered by it: `dispose()` does not hand the
context back, so every in-panel signal this plan reads — `liveWebglContexts`, `isWebgl`,
`rendererDeferred` — would agree the budget was freed while the process held it. Mitigated by
`forceReleaseWebglContext`, by a contract test that pins the vendored property path, and by a
manual verification whose step 0 establishes a process-level ground truth *before* any
`isWebgl` reading is trusted.

> **Superseded:** "Risk: the hide trigger is the least certain part of the most valuable half…
> which is why the sweep exists."
> **Reason:** research settled the trigger (Resolved Assumptions 1–3); the sweep was removed.
> The residual risk moved from *detection* to *release*, which is a different and worse
> problem than the one originally flagged.
> **Replaced with:** the release-succeeds-on-paper risk above.

## Verification Plan

### Automated Tests

New `src/test/terminal-renderer-lifecycle-contract.test.js`, source-scanning in the style of
`terminal-pane-fit-verification-contract.test.js`, wired as
`test:contract:terminal-renderer-lifecycle` in `package.json`. Declare the new functions above
`readRenderedGrid` so the existing pane-fit spans stay forward-only.

1. **Exactly one increment, exactly one decrement path.** Assert `liveWebglContexts++` appears
   once and only inside `attachRenderer`, and that no `liveWebglContexts` decrement (`--` or
   `- 1`) appears outside the `holder.release` closure. This is the invariant that replaces
   hand-paired accounting.
2. **`release()` is one-shot.** Assert the closure guards on a `released` flag set before the
   decrement.
3. **The context is actually handed back.** Assert `holder.release` calls
   `forceReleaseWebglContext`, and that `forceReleaseWebglContext` reaches
   `getExtension('WEBGL_lose_context')` and calls `loseContext()`. Without this the whole
   change is cosmetic, so it gets its own test rather than riding on #1.
4. **The vendored private path still exists.** Read
   `src/webview/vendor/xterm/addon-webgl.js` and assert it contains `this._renderer`,
   `this._gl` and `getContext("webgl2"` — i.e. that the `addon._renderer._gl` hop
   `forceReleaseWebglContext` depends on is still real. An xterm bump that renames it must
   break the build, not the feature. Assert in the same test that the bundle still contains
   **no** `loseContext` of its own, so if a future xterm starts releasing properly we find out
   and can delete our helper instead of double-releasing.
5. **`onContextLoss` is guarded against our own deliberate loss.** Assert its first statement is
   an early return on the `released` flag — the re-entrancy that would otherwise double-attach.
6. **Ordering: release → dispose → attach.** Assert in both `swapRenderer` and
   `destroyTerminalView` that `.release()` precedes `dispose()`, and that it sits outside the
   `try` wrapping `dispose()`. Release-after-dispose is unreachable-context; release-inside-try
   is the permanent-leak-on-throw regression; dispose-after-attach is two loaded renderers on
   one `Terminal`.
7. **Every release site goes through the holder.** Assert `onContextLoss`, `swapRenderer` and
   `destroyTerminalView` each call `.release()`.
8. **Every renderer swap is followed by a repaint, guarded on a box.** Assert `swapRenderer`
   ends in `resyncPaneRenderer(...)` wrapped in an `isRendered(entry.container)` check, and
   that `onContextLoss` still calls `resyncPaneRenderer` — this permanently guards the already
   landed fix as well.
9. **WebGL acquisition is gated on a box.** Assert `attachRenderer`'s WebGL condition includes
   an `isRendered`-derived `hasBox` term alongside the `MAX_WEBGL_CONTEXTS` term.
10. **The deferred path never leaves a terminal with no renderer.** Assert every non-WebGL exit
    from `attachRenderer` assigns `holder.current` from `attachCanvasRenderer`.
11. **The debt expression is the availability check, not `!hasBox`.** Assert the canvas paths
    set `rendererDeferred = webglAvailable()` and that the constructor-throw path sets it to
    `false`.
12. **The release is debounced and cancellable.** Assert `armRendererRelease` is idempotent
    (early-returns on an existing `releaseTimer`), that `cancelRendererRelease` is called on
    the visible branch of the `ResizeObserver`, and that `destroyTerminalView` calls it.
13. **Reconcile precedes the fit ladder** in the `ResizeObserver` callback.
14. **Declaration order.** Assert every new function (`webglAvailable`,
    `forceReleaseWebglContext`, `reconcileRendererForVisibility`, `swapRenderer`,
    `armRendererRelease`, `cancelRendererRelease`) is declared before
    `function readRenderedGrid(` so `terminal-pane-fit-verification-contract.test.js`'s spans
    are unaffected.

`terminal-pane-fit-verification-contract.test.js` must stay green — `resyncPaneRenderer`'s
`'stale-canvas'` gating is asserted there and this plan is a new caller of it.

### Manual Verification

> **Superseded:** the original steps 1–3, which had the operator load the cockpit, never open
> Terminals, and verify that every terminal reports `isWebgl: false` — *"this is the whole
> defect in one reading; today they are all `true`."*
> **Reason:** it does not reproduce at HEAD. A never-opened panel has no materialized
> terminals at all (`whenRendered`), so `__sbTerminalStats()` already reports
> `isWebgl: false` with `cols`/`rows` null — the "before" and "after" readings are identical
> and the check would pass against unmodified code.
> **Replaced with:** the sequence below, which exercises the three states that actually hold
> contexts.

**`isWebgl` is not proof of release.** It is this panel's own bookkeeping, and the entire risk
identified in the Complexity Audit is that the bookkeeping can say "freed" while the process
still holds the context. Step 0 establishes a process-level ground truth first; every later
step that claims a release must be read against it.

0. **Establish the process ceiling, before and after.** Open the cockpit, open Terminals, and
   open terminals until Chromium logs
   `WARNING: Too many active WebGL contexts. Oldest context will be lost.` Note the count `N`
   at which it first appears — that is the process ceiling reached through this panel. Repeat
   the whole exercise on the built change. **Verify:** with the release working, the sequence
   in step 2 below (assign, unassign, repeat) no longer walks toward that warning at all,
   whereas before the change every unassigned-but-retained terminal moves it closer. If the
   warning still arrives at the same `N` after a wait, `loseContext()` is not reaching the
   context and the feature is cosmetic — check `forceReleaseWebglContext` against the vendored
   bundle's shape before believing any `isWebgl` reading below.
1. Open **Terminals** and assign three or more terminals to a 2x2 grid. Open DevTools on the
   Terminals iframe and run `__sbTerminalStats()`. **Verify:** every assigned pane reports
   `isWebgl: true`.
2. Drop one terminal from the grid (leave it running — it stays in `terminalsMap` for its
   scrollback). Wait 10 s, re-run. **Verify:** the unassigned terminal reports
   `isWebgl: false, rendererDeferred: true`; the panes still in the grid are untouched.
   *This is the single-window leak and the primary reason to ship.* Repeat assign/unassign
   fifteen-plus times. **Verify:** no context-limit warning ever appears — the pre-change build
   reaches it.
3. Re-assign it. **Verify:** within ~1 s it is back to `isWebgl: true` and its scrollback is
   intact and correctly painted — no stale or blank regions from the upgrade swap.
4. Switch to the Board panel, wait 10 s, re-run in the Terminals iframe console.
   **Verify:** every pane reports `isWebgl: false`.
5. Switch back to Terminals. **Verify:** panes return to `isWebgl: true` and every pane's
   content is intact.
6. Switch Terminals → Board → Terminals three times quickly. **Verify:** `isWebgl` stays
   `true` throughout — the release delay was cancelled each time, and the switch stays
   instant.
7. With Terminals open in the main window, switch the main window to Board, wait 10 s, then
   switch back and click **new window**. In the pop-out's *own* console (a separate window has
   its own DevTools), run `__sbTerminalStats()`. **Verify:** its terminals report
   `isWebgl: true` and no `[Terminals] WebGL context lost` warning appears in either console.
8. In the pop-out, run several Claude CLI terminals in 1x3 and leave them idle at their mode
   strip. Swap the terminal in the third pane. **Verify:** the two idle panes are untouched —
   the reproduction from the original report.
9. Open enough terminals across both windows to exceed the process cap deliberately.
   **Verify:** the overflow panes run on canvas (`isWebgl: false, rendererDeferred: true`) and
   render *correctly* — degraded throughput, no corruption — and that closing a terminal lets a
   waiting pane upgrade on its next resize tick.
10. **Confirm no self-inflicted loss warnings.** Across all of the above, `[Terminals] WebGL
    context lost` must never appear on a pane we released deliberately — that message means the
    `released` re-entrancy guard let our own `loseContext()` through into the recovery handler.

---

**Recommendation: Send to Lead Coder** (complexity 7 — runtime renderer swaps on live
terminals, two reaches into private vendored xterm surface, and a release path whose failure
mode is silent success).
