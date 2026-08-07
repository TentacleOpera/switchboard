# A Never-Opened Terminals Panel Holds a WebGL Context Per Terminal, Starving Every Other Window

## Metadata

**Complexity:** 5
**Tags:** frontend, bugfix, terminals, performance, reliability

## Goal

Stop acquiring GPU renderer contexts for terminal views that have no box to draw into,
and release the ones held by a panel that has been hidden long enough to stop mattering.
A `display:none` panel has no pixels; it must not consume a process-wide resource that a
visible window needs.

### Root Cause

`attachRenderer` (`src/webview/terminals.js:270`) takes a WebGL context the moment a
terminal view is created, with no regard for whether the view can be seen:

```javascript
if (window.WebglAddon && window.WebglAddon.WebglAddon && liveWebglContexts < MAX_WEBGL_CONTEXTS) {
```

The only guard is `liveWebglContexts < MAX_WEBGL_CONTEXTS` (12), and that counter is a
module-scope `let` inside the panel's IIFE (line 219) — **per document**. The browser's
real limit is **per renderer process** (~16 in Chromium), shared by every same-origin
document in it.

Two things conspire to blow past that budget with no terminal ever visibly misbehaving:

**1. The shell mounts the Terminals panel whether or not you ever open it.** From
`shell.js`'s header comment (line 5):

> All iframes are mounted up-front and toggled via display; each panel keeps its state and
> its live WebSocket across switches (instant switch, no reconnect).

So from cockpit load, a panel the operator has never clicked has already run
`renderPaneGrid`, called `createTerminalView` for each assigned terminal, opened a
WebSocket per terminal, and taken **one WebGL context per view** — all behind
`display:none`. The gateway documents the same behaviour from its end, in
`reconcileTerminalSize`:

> That is how a hidden tab came to dictate the size: the browser shell mounts every panel
> iframe up front with `display:none`, so the Terminals panel connects while measuring
> 0x0, and an xterm with no layout reports its 80x24 construction default.

**2. "New window" is a second full panel, not a view onto the first.** The button at line
473 runs `window.open('/terminals', 'sb-terminals-panel', 'width=1200,height=800')` — same
origin, with an opener, so the browser keeps it in the *same renderer process*. It is a
complete second instance of `terminals.js` with its own `liveWebglContexts = 0`. Popping
out therefore does not cost N contexts; it costs 2N, and each document's ceiling sees only
its own half.

When the process cap is crossed, the browser force-loses contexts. `onContextLoss` drops
to the canvas renderer, which paints only rows subsequently marked dirty — so a terminal
that is idle keeps whatever the dead surface left behind. (The missing repaint on that
path is fixed separately; this plan removes the pressure that triggers it.)

The failure is invisible in the hidden panel and visible in the pop-out, which reads as
"the pop-out is broken". It is exactly backwards: the hidden panel is the one consuming
the budget, and it never paints, so it never reveals its own loss.

### Background Context

`destroyTerminalView` (line 4016) already carries most of this understanding:

> Before `term.dispose()`: the GPU renderers hold a WebGL context / canvas that browsers
> cap **per page** (~16 contexts), so leaking one per closed terminal eventually forces
> every terminal back to the DOM renderer.

The cap is right, the number is right, and "per page" is the blind spot — it is per
*process*, which is why a second window and a hidden iframe both count and neither
document can see the other. Teardown is already correct; **acquisition** is what is
unguarded.

`isRendered(el)` (line 162) is the existing, already-trusted answer to "does this have a
box":

```javascript
function isRendered(el) {
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
}
```

`fitAndReportSize` and `inspectPaneFit` both gate on it, and it is true for exactly the
condition that matters here: an element inside a `display:none` iframe has a zero rect.

The upgrade/downgrade hook also already exists. Every view gets a per-container
`ResizeObserver` (line 4291) with a 100 ms debounce, and its comment records that `active`
is assignment rather than visibility — so it already fires on the 0 → real transition when
the shell flips `display`, and on real → 0 when it flips back.

`resyncPaneRenderer` (line 3129) is the repair that must follow any renderer swap: a new
renderer starts on an empty surface and paints only dirty rows, so without
`clearTextureAtlas()` + `refresh(0, rows-1)` + `handleResize`, every already-drawn row
keeps the outgoing renderer's pixels.

## Proposed Changes

### File 1: `src/webview/terminals.js` — acquire only against a real box

Add the box check to `attachRenderer`'s WebGL arm and record that the upgrade is owed:

```javascript
    function attachRenderer(term, entry) {
        const holder = { current: null };
        // A container with no box cannot be painted, and a WebGL context is a
        // PROCESS-wide resource — the shell mounts this panel at load and leaves it
        // display:none until it is first opened, so an unguarded acquisition spends
        // the whole budget on views nobody can see. MAX_WEBGL_CONTEXTS cannot catch
        // this: it counts THIS document's contexts, and the pop-out is a second
        // document in the same process with its own counter starting at zero.
        //
        // Deferred, not denied. rendererDeferred is the debt; the ResizeObserver
        // settles it the moment the container gets real geometry.
        const hasBox = entry ? isRendered(entry.container) : true;
        if (window.WebglAddon && window.WebglAddon.WebglAddon
            && hasBox && liveWebglContexts < MAX_WEBGL_CONTEXTS) {
            …unchanged…
        }
        if (entry) { entry.rendererDeferred = !hasBox; }
        holder.current = attachCanvasRenderer(term);
        return holder;
    }
```

Seed `rendererDeferred: false` in the entry literal beside `rendererAddon: null`
(line ~4073).

The interim renderer is canvas (or DOM if `CanvasAddon` is unavailable), which is what
`attachCanvasRenderer` already returns. A boxless pane paints nothing either way, so the
interim choice costs nothing until it becomes visible — at which point it is replaced.

### File 2: `src/webview/terminals.js` — settle the debt on the visibility transition

One function, both directions, so acquisition and release cannot drift apart:

```javascript
    /**
     * Bring `entry`'s renderer in line with whether it currently has a box.
     *
     * Both directions run through resyncPaneRenderer because a renderer swap does
     * NOT repaint what is on screen — the incoming renderer starts empty and paints
     * only rows the terminal later marks dirty. That is the same defect the
     * onContextLoss handler had, and it must not be reintroduced here.
     */
    function reconcileRendererForVisibility(entry) {
        if (!entry || entry.disposed || !entry.term || !entry.rendererAddon) { return; }
        const hasBox = isRendered(entry.container);

        if (hasBox && entry.rendererDeferred) {
            // Budget still exhausted — stay on canvas and keep the debt. The next
            // ResizeObserver tick retries, and a released context (a closed terminal,
            // another panel hidden) is what lets it through.
            if (!(window.WebglAddon && window.WebglAddon.WebglAddon)) {
                entry.rendererDeferred = false;   // no addon at all: nothing to owe
                return;
            }
            if (liveWebglContexts >= MAX_WEBGL_CONTEXTS) { return; }
            swapRenderer(entry, /* deferred */ false);
            return;
        }

        if (!hasBox && !entry.rendererDeferred && entry.isWebgl) {
            // Released, not merely idle. A panel switched away from in the shell keeps
            // its context for the life of the page otherwise, which is the exact
            // budget a popped-out window then cannot get.
            swapRenderer(entry, /* deferred */ true);
        }
    }

    function swapRenderer(entry, deferred) {
        // Dispose FIRST. Two renderers loaded on one Terminal is not a supported
        // xterm state, and the outgoing one owns the surface the incoming one needs.
        try { entry.rendererAddon.current?.dispose(); } catch { /* ignore */ }
        if (entry.isWebgl) { liveWebglContexts = Math.max(0, liveWebglContexts - 1); }
        entry.rendererAddon.current = null;
        entry.isWebgl = false;
        entry.rendererDeferred = deferred;
        entry.rendererAddon = deferred
            ? { current: attachCanvasRenderer(entry.term) }
            : attachRenderer(entry.term, entry);
        resyncPaneRenderer(entry, 'stale-canvas');
    }

    /** Hidden long enough to be worth reclaiming. Short flips between shell panels
     *  must not thrash the GPU: a switch out and back inside this window keeps its
     *  context and costs nothing. */
    const RENDERER_RELEASE_DELAY_MS = 5000;
```

Wire it into the existing `ResizeObserver` (line 4291), which already fires on both
transitions:

```javascript
        const resizeObserver = new ResizeObserver(() => {
            if (resizeTimer) clearTimeout(resizeTimer);
            resizeTimer = setTimeout(() => {
                if (isRendered(entry.container)) {
                    if (entry.releaseTimer) {
                        clearTimeout(entry.releaseTimer);
                        entry.releaseTimer = null;
                    }
                    reconcileRendererForVisibility(entry);
                } else if (!entry.releaseTimer && !entry.rendererDeferred) {
                    entry.releaseTimer = setTimeout(() => {
                        entry.releaseTimer = null;
                        reconcileRendererForVisibility(entry);
                    }, RENDERER_RELEASE_DELAY_MS);
                }
                if (entry.container.classList.contains('active')) {
                    startFitLadder(entry.name);
                }
            }, 100);
        });
```

Clear `entry.releaseTimer` in `destroyTerminalView` alongside the other per-entry timers.

**`swapRenderer` reassigns `entry.rendererAddon` to a new holder.** That is safe: the old
holder is referenced only by the outgoing addon's `onContextLoss` closure, and that addon
has just been disposed. `destroyTerminalView` reads `entry.rendererAddon.current`, which is
the new holder. Do not "optimise" this into mutating the existing holder in place — the
`onContextLoss` closure captured for the *new* WebGL addon must write to the new holder,
which is what `attachRenderer` returning a fresh one gives for free.

### File 3: `src/webview/terminals.js` — correct the cap's doc comment

`destroyTerminalView`'s comment says browsers cap contexts "per page". Change to "per
renderer process — shared with every same-origin document, including a popped-out second
panel", and note beside `MAX_WEBGL_CONTEXTS` that it is a per-document ceiling and
therefore *not* the control that keeps the process under its limit. The wrong word is what
makes the pop-out interaction invisible when reading this file.

## Edge Cases

**Pane visible but budget exhausted.** `reconcileRendererForVisibility` returns with the
debt intact, so the pane runs on canvas and retries on the next ResizeObserver tick. Canvas
is a fully working renderer — this degrades throughput, never correctness. This is also the
case that makes the separate `onContextLoss` repaint fix load-bearing rather than
redundant: two visible windows can still cross the process cap between them, and nothing in
this plan can prevent that from one document.

**Rapid panel flipping.** The 5 s release delay is cancelled by any re-show, so a switch out
and back keeps the context and costs nothing — preserving the shell's "instant switch"
property. Only a sustained hide reclaims.

**First paint of a genuinely visible panel.** `createTerminalView` may run before layout
settles even in a visible panel, so a first-open pane can start deferred. The
ResizeObserver's first tick (100 ms debounce) upgrades it. The cost is one canvas frame
before WebGL takes over — invisible, and strictly better than today's behaviour of taking
a context against a box that does not exist yet.

**Solo pop-out (`?solo=`).** `checkSoloNotFound` flips the container's `display`, which the
ResizeObserver already observes. The reconcile rides that transition with no extra wiring.

**Counter drift.** `liveWebglContexts` is decremented in exactly three places after this
change — `destroyTerminalView`, `onContextLoss`, and `swapRenderer` — each gated on
`entry.isWebgl` being true at the moment of the drop, and `swapRenderer` clears `isWebgl`
immediately after. `attachRenderer` remains the only increment. A test asserts the pairing
rather than leaving it to inspection.

**DOM-renderer fallback.** When `CanvasAddon` is unavailable `attachCanvasRenderer` returns
`null` and xterm uses its built-in DOM renderer. `swapRenderer` handles a null `current`
(the optional-chained `dispose` is a no-op) and `resyncPaneRenderer` is already written to
tolerate a renderer without an atlas.

## Dependencies

**Ordering — the `onContextLoss` repaint must land first.** This plan performs deliberate
runtime renderer swaps, which is precisely the operation that strands already-drawn pixels.
Without `resyncPaneRenderer` on the swap path, every upgrade and release would corrupt the
pane it was meant to help. That repair is already applied at `attachRenderer`'s
`onContextLoss` handler; this plan reuses the same primitive and must not ship ahead of it.

Otherwise self-contained. No gateway change, no protocol change, no shell change —
`shell.js`'s mount-everything-up-front policy is deliberate ("instant switch, no
reconnect") and is not being altered.

## Adversarial Synthesis

**"Just lower `MAX_WEBGL_CONTEXTS`."** It is per document. Halving it to 6 still allows
6 + 6 across two windows, still spends the budget on invisible panes, and costs the main
window WebGL on terminals 7-12 that are genuinely on screen. It tunes the wrong axis: the
problem is not how many contexts one document takes, it is that contexts are taken for
views with no pixels.

**"Don't mount the Terminals panel until it is opened."** That is a shell-wide policy
change trading a documented feature — instant switch with live sockets preserved — for a
narrower fix, and it would break the panel's other reason to run hidden: keeping WebSockets
attached so scrollback is warm on first open. Lazy *renderer* acquisition gets the same
budget back without touching the mount policy.

**"Release-on-hide adds churn for little gain."** The acquisition gate alone handles the
dominant case (never-opened panel), and release-on-hide only matters once the operator has
actually viewed terminals in the main window and then switched away — which is exactly the
workflow that precedes clicking "new window". Without it, the pop-out still meets a
budget the main window is holding but not using. The 5 s delay is what keeps it from
becoming churn.

**Risk: a runtime renderer swap is more invasive than a guard.** Real, and the reason the
upgrade path is mandatory rather than optional: gating acquisition *without* it would leave
main-window terminals permanently on canvas, a clear regression in the primary use case.
The two halves ship together or not at all.

**Risk: the process-level cap is inferred, not measured.** ~16 per process is the
documented Chromium behaviour and matches the number already recorded in
`destroyTerminalView`, but the exact limit varies by browser and GPU. The design does not
depend on the number — it depends on not spending contexts on invisible views, which is
correct at any cap.

## Verification Plan

### Automated Tests

New `src/test/terminal-renderer-lifecycle-contract.test.js`, source-scanning in the style
of the existing webview contract tests:

1. **WebGL acquisition is gated on a box.** Assert `attachRenderer`'s WebGL condition
   includes an `isRendered` check, and that the `rendererDeferred` flag is set on the
   boxless path.
2. **Every renderer swap is followed by a repaint.** Extract each site that assigns
   `rendererAddon` or calls `dispose()` on one, and assert `resyncPaneRenderer` follows.
   This is the invariant the whole plan rests on; it also permanently guards the
   `onContextLoss` fix.
3. **Increment/decrement pairing.** Assert `liveWebglContexts++` appears exactly once
   (`attachRenderer`) and every decrement is guarded by `entry.isWebgl`.
4. **Dispose precedes attach in `swapRenderer`.** Two loaded renderers on one Terminal is
   the failure this ordering exists to prevent.
5. **The release is debounced and cancellable.** Assert `releaseTimer` is cleared on
   re-show and in `destroyTerminalView`.
6. **The deferred path never leaves a terminal with no renderer.** Assert the boxless
   branch still assigns from `attachCanvasRenderer`.

`terminal-pane-fit-verification-contract.test.js` must stay green — `resyncPaneRenderer`'s
`'stale-canvas'` gating is asserted there and this plan is a new caller of it.

### Manual Verification

1. Load the cockpit and go straight to the Board panel — never open Terminals.
2. Open DevTools on the main window, switch the console context to the Terminals iframe,
   and run `__sbTerminalStats()`. **Verify:** every terminal reports `isWebgl: false`. This
   is the whole defect in one reading; today they are all `true`.
3. Click the Terminals rail icon. Re-run. **Verify:** the visible panes have flipped to
   `isWebgl: true` within a second, and their content is intact — no stale or blank
   regions from the upgrade swap.
4. Switch back to Board, wait 10 s, re-run. **Verify:** `isWebgl: false` again.
5. Switch to Terminals and back three times quickly. **Verify:** `isWebgl` stays `true`
   throughout — the release delay was cancelled each time, and the switch stays instant.
6. With Terminals open in the main window, click **new window**. In the pop-out's *own*
   console (a separate window has its own DevTools), run `__sbTerminalStats()`.
   **Verify:** its terminals report `isWebgl: true`, and no
   `[Terminals] WebGL context lost` warning appears in either console.
7. In the pop-out, run several Claude CLI terminals in 1x3 and leave them idle at their
   mode strip. Swap the terminal in the third pane. **Verify:** the two idle panes are
   untouched — the reproduction from the original report.
8. Open enough terminals across both windows to exceed the process cap deliberately.
   **Verify:** the overflow panes run on canvas (`isWebgl: false`) and render *correctly* —
   degraded throughput, no corruption — and that a closed terminal lets a waiting pane
   upgrade on its next resize tick.
