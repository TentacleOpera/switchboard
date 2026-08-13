# Seating a Terminal Into an Empty Grid Slot Corrupts the Glyphs in Its Neighbours

## Goal

Make seating a terminal into an empty pane a **local** operation: the pane being filled
changes, and every other pane in the grid keeps painting exactly what it was painting.
Today, filling one empty slot leaves one or more *unrelated* panes showing garbled text —
overprinted glyphs, ghost rows, characters at the wrong column stride — that does not
self-heal on scroll and survives until the running CLI happens to rewrite those rows.

### The problem

Grid has, say, five terminals in a `2x3` layout with one empty slot. Click a sidebar row
(or create a new terminal) so it seats into that slot. The new pane renders fine. One or
more of the *other five* panes now shows corrupted text.

This has been attacked several times, each time at a different layer, and each of those
fixes is still in the codebase and still correct for the trigger it was written for. None
of them covers this trigger. Enumerating them is the point — the gap is what is left over:

| Existing repair | What it covers | Why it does not cover this |
| :--- | :--- | :--- |
| `startFitLadder` / `inspectPaneFit` / `resyncPaneRenderer` | A pane whose **buffer** or **canvas** is sized wrong after a layout change | On this trigger the grid tracks are `minmax(0, 1fr)` — sibling geometry does not change, so `inspectPaneFit` returns `ok` and the ladder correctly does nothing |
| `fitAndReportSize`'s `resized → resyncPaneRenderer(entry, 'stale-canvas')` with the atlas rebuild | The WebGL glyph model going stale **when cols/rows actually change** | Siblings' cols/rows do not change here, so `resized` is false and the atlas rebuild never runs |
| Four client-side notices removed from the xterm buffer (`[Pasting…]`, `[Disconnected…]`, …) | Client writes shifting a TUI's screen model | Seating a terminal writes nothing into any buffer |
| `entry.needsRendererResync` set on a structural grid delta | Repainting panes after a re-parent / visibility regain | It *is* set here — but it is consumed with `{ rebuildAtlas: false }`, which is the visibility-regain tuning, not the glyph-model tuning |

### Root cause

**A WebGL context budget that is counted per document while the browser enforces it per
renderer process.** `src/webview/terminals.js`:

```js
// Our own per-document ceiling. It is NOT the process cap: liveWebglContexts
// is a `let` inside this IIFE, and a second same-origin document (a pop-out)
// starts its own counter at zero. The real cap is ~16 live contexts per
// renderer process, shared across every same-origin document in it.
const MAX_WEBGL_CONTEXTS = 12;
let liveWebglContexts = 0;
```

The comment states the defect precisely and the code does not act on it. Every terminals
document — the cockpit panel iframe and **every `?solo=<name>` pop-out** — runs its own
copy of this IIFE with its own counter starting at zero and its own ceiling of 12. Two
documents can therefore believe they are well under the limit while jointly holding 24
contexts against a process ceiling of roughly 16.

Chromium does not fail the 17th `getContext('webgl2')`. It **force-loses the oldest live
contexts** to make room. Those are, by definition, contexts belonging to panes the operator
opened *earlier* — the neighbours. So seating one terminal (which materialises a view and
calls `attachRenderer`, which acquires a context) evicts a renderer from a sibling pane
that has nothing to do with the action.

The eviction lands in `attachRenderer`'s loss handler:

```js
webgl.onContextLoss(() => {
    if (released) { return; }
    console.warn('[Terminals] WebGL context lost — falling back to canvas renderer');
    holder.release();
    try { webgl.dispose(); } catch { /* ignore */ }
    holder.current = attachCanvasRenderer(term);
    if (entry) {
        entry.rendererDeferred = webglAvailable();
        resyncPaneRenderer(entry, 'stale-canvas');
    }
});
```

Three things make this recovery leave residue rather than repair it:

1. **The repair is fired once, synchronously, inside the loss event.** Every other repair
   in this file goes through `startFitLadder`, which *verifies* and *retries* across a
   double-rAF plus 60/180/420 ms timers — precisely because `RenderService` parks resizes
   while its `IntersectionObserver` says the screen is not intersecting, and **drops** them
   outright while no renderer is installed (`readRenderedGrid` returns `'swapping'` for
   exactly this window). A single synchronous call fired mid-swap is the one shape known to
   lose that race, with no retry behind it.

2. **`webgl.dispose()` is inside a swallowing `try`.** If it throws, the dead WebGL canvas
   layers stay in the terminal element and the incoming canvas renderer paints *underneath*
   the frozen last WebGL frame. That reads as permanently corrupt text.

3. **Nothing repaints the rows the incoming renderer never marks dirty.** The handler's own
   comment on the sibling code path says it: *"A renderer swap does NOT repaint what is
   already on screen. The incoming canvas renderer starts with an empty surface and then
   paints only rows the terminal subsequently marks dirty."* On an idle CLI that is the
   whole screen. `resyncPaneRenderer` is meant to close this — and it is exactly the call
   that (1) shows losing its race.

Secondary contributor, on the same trigger: `renderPaneGrid()` flags **every** seated pane
`needsRendererResync = true` on any structural key change (the seat qualifies), and
`startFitLadder` consumes that flag with `{ rebuildAtlas: false }`. That option was tuned
for visibility regain, where the atlas is intact. A pane that just had its WebGL context
taken away and swapped for canvas needs the full rebuild, and gets the cheap repaint.

### Why the count is reached in ordinary use

`MAX_WEBGL_CONTEXTS` is 12 per document, `RENDERER_RELEASE_DELAY_MS` is 5 s, and release
only happens via `reconcileRendererForVisibility` when a pane loses its box. A cockpit with
a `3x3` grid plus a handful of pop-out windows for the terminals under active watch reaches
the process cap without any single document approaching its own ceiling — and the cockpit
grid holds contexts for terminals that are *seated but off the rendered slot count*, since
`paneAssignments` is padded to nine regardless of layout.

## Metadata

- **Complexity:** 7
- **Tags:** frontend, ui, bugfix, reliability, performance
- **Project:** Browser Switchboard

## Complexity Audit

**Complex / risky.**

- The fix spans a cross-document coordination mechanism that does not exist in this
  codebase today (no `BroadcastChannel` and no `localStorage` use anywhere in
  `terminals.js` or `shell.js`), plus surgery on the renderer-loss recovery path.
- The failure is a **paint** failure with no assertion surface — every automated gate stays
  green whether or not it is fixed. Verification has to be instrumented (`__sbTerminalStats`
  + a loss counter) and visual, not test-suite-driven.
- The renderer machinery has an explicitly documented invariant set (release-before-dispose,
  dispose-before-attach, one decrement per acquisition, a fresh holder per swap). Every one
  of those comments is load-bearing and must survive.
- Getting the coordination wrong in the *conservative* direction is safe (a pane silently
  runs on canvas, which is slower but correct). Getting it wrong in the permissive
  direction reproduces the bug. Bias every ambiguous case toward canvas.

**Diagnostic gate before coding.** The primary hypothesis above must be confirmed, not
assumed, because the fix is expensive. Reproduce, then in each open terminals document run
`__sbTerminalStats()` and read the `isWebgl` / `rendererDeferred` fields. Confirmation is:
the sum of `isWebgl === true` across all documents exceeded ~16 at the moment of the seat,
**and** a corrupted pane reports `isWebgl: false, rendererDeferred: true` (it held a context
and lost it) while its neighbours that stayed clean report `isWebgl: true`. A `[Terminals]
WebGL context lost` line in that document's console is the direct confirmation. If instead
every pane reports `isWebgl: true` and no loss was logged, this root cause is wrong — stop
and re-diagnose against the `needsRendererResync` / `rebuildAtlas: false` path in §3, which
is a real gap in its own right and the second half of this plan.

## Edge-Case & Dependency Audit

1. **Pop-out windows are separate documents in the same process — usually.** Chromium may
   or may not put a `window.open()` same-origin popup in the same renderer process. The
   coordination must therefore be advisory (it can over-restrain) and must never *require*
   another document to answer. A document that hears nothing back keeps its own local
   ceiling.

2. **A document that closes without releasing.** Crash, force-quit, or a tab killed by the
   OS leaves its contexts charged to a shared ledger that nothing decrements. The shared
   count must be reconstructed from live participants (each document reports its own count
   on a heartbeat), never accumulated as a single shared integer.

3. **`BroadcastChannel` is asynchronous.** A burst of nine terminal creations can acquire
   nine contexts before the first peer report is delivered. Acquisition must therefore also
   be **rate-limited locally**: never acquire more than one new context per animation frame,
   so peer reports have a chance to land between acquisitions.

4. **The existing counter invariants.** `holder.release()` is one-shot and is the ONLY
   decrement site; `forceReleaseWebglContext` must run BEFORE `dispose()`; a swap must build
   a FRESH holder. Any shared-ledger reporting must hang off `holder.release()` and the
   post-`attachRenderer` increment, not off new call sites.

5. **`isRendered(entry.container)` is already a precondition for acquisition** (`hasBox`).
   Do not weaken it — a boxless acquisition is a context spent on nothing and is what the
   cap cannot catch.

6. **Solo pop-outs are the highest-value viewer.** A pop-out exists because the operator
   wants that one terminal full size. When the budget is tight, a solo document's single
   terminal must win over a cockpit grid cell. Give a solo document a small reserved
   allowance rather than making it queue behind a nine-pane cockpit.

7. **Canvas fallback is a real, working renderer.** Degrading to canvas is not a failure
   mode to be avoided at the cost of correctness. The `rendererDeferred` debt mechanism
   already retries the upgrade when budget frees up.

8. **`term.clearTextureAtlas()` is only meaningful on a WebGL renderer.** Calling it on a
   canvas/DOM renderer is a guarded no-op today (`try { … } catch {}`) and must stay
   guarded.

9. **Do not write anything into a terminal buffer.** Diagnostics go to `console`, to
   `__sbTerminalStats`, and to pane chrome — never to `entry.term.write`. That prohibition
   is established in this file and applies to any new instrumentation.

10. **Extension-host webview.** The panel also runs inside a VS Code webview, which is a
    single document with no pop-outs. The coordination must be a no-op there (one
    participant, local ceiling applies) and must not depend on APIs the webview sandbox
    blocks. `BroadcastChannel` is same-origin and available in both hosts; if construction
    throws, fall back to local-only accounting.

## Proposed Changes

### 1. `src/webview/terminals.js` — a process-wide WebGL budget shared across documents

Replace the per-document counter with a coordinated one. Each document keeps its own
`liveWebglContexts` (unchanged, still the one decrement site) and additionally publishes it;
acquisition consults the **sum** across live participants.

```js
    /**
     * Cross-document WebGL accounting.
     *
     * MAX_WEBGL_CONTEXTS was a per-DOCUMENT ceiling against a per-PROCESS limit — the
     * defect the old comment described and did not act on. Two same-origin documents
     * (the cockpit panel and any ?solo= pop-out) each started at zero and each allowed
     * itself 12, so the pair could hold 24 against a browser ceiling of ~16. Chromium
     * does not fail the over-budget acquisition; it force-loses the OLDEST live
     * contexts — i.e. panes the operator opened earlier, in a DIFFERENT window from the
     * one that just acquired.
     *
     * Advisory by design: a peer that never answers simply is not counted, and the
     * local ceiling still applies. This can over-restrain (a pane runs on canvas that
     * could have had WebGL); it must never under-restrain.
     */
    const WEBGL_BUDGET_CHANNEL = 'sb-terminals-webgl-budget';
    const PROCESS_WEBGL_CEILING = 14;      // headroom under the ~16 browser limit
    const SOLO_RESERVED_CONTEXTS = 2;      // a ?solo= pop-out never queues behind a grid
    const PEER_REPORT_TTL_MS = 4000;       // a report older than this is a dead document
    const PEER_REPORT_INTERVAL_MS = 1500;

    const peerWebglCounts = new Map();     // documentId -> { count, at }
    const selfDocumentId = 'doc_' + Math.random().toString(36).slice(2, 10);
    let webglBudgetChannel = null;
    let lastAcquireFrame = -1;

    function publishWebglCount() {
        if (!webglBudgetChannel) { return; }
        try {
            webglBudgetChannel.postMessage({
                id: selfDocumentId,
                count: liveWebglContexts,
                solo: !!soloTerminalName
            });
        } catch { /* channel closed — fall back to local accounting */ }
    }

    function peerWebglTotal() {
        const now = Date.now();
        let total = 0;
        for (const [id, rec] of Array.from(peerWebglCounts.entries())) {
            if (now - rec.at > PEER_REPORT_TTL_MS) { peerWebglCounts.delete(id); continue; }
            total += rec.count;
        }
        return total;
    }

    function initWebglBudgetChannel() {
        try { webglBudgetChannel = new BroadcastChannel(WEBGL_BUDGET_CHANNEL); }
        catch { webglBudgetChannel = null; return; }   // local-only accounting
        webglBudgetChannel.onmessage = (ev) => {
            const d = ev && ev.data;
            if (!d || typeof d.id !== 'string' || typeof d.count !== 'number') { return; }
            if (d.id === selfDocumentId) { return; }
            peerWebglCounts.set(d.id, { count: d.count, at: Date.now() });
            // A peer that just freed budget is our cue to pay down renderer debt.
            for (const entry of terminalsMap.values()) { reconcileRendererForVisibility(entry); }
        };
        setInterval(publishWebglCount, PEER_REPORT_INTERVAL_MS);
        publishWebglCount();
    }

    /**
     * May THIS document take one more WebGL context right now?
     *
     * Three gates, all of which must pass:
     *  - the local per-document ceiling (unchanged);
     *  - the coordinated process ceiling, minus the allowance reserved for solo
     *    pop-outs when this document is not one;
     *  - one acquisition per animation frame, because BroadcastChannel delivery is
     *    asynchronous and a nine-terminal burst would otherwise acquire nine contexts
     *    before the first peer report lands.
     */
    function webglBudgetAllows() {
        if (liveWebglContexts >= MAX_WEBGL_CONTEXTS) { return false; }
        const isSolo = !!soloTerminalName;
        const ceiling = isSolo ? PROCESS_WEBGL_CEILING : PROCESS_WEBGL_CEILING - SOLO_RESERVED_CONTEXTS;
        if (liveWebglContexts + peerWebglTotal() >= ceiling) { return false; }
        const frame = Math.floor(performance.now() / 16);
        if (frame === lastAcquireFrame) { return false; }
        lastAcquireFrame = frame;
        return true;
    }
```

Then the two sites that consult the budget switch to the helper:

```js
-        if (webglAvailable() && hasBox && liveWebglContexts < MAX_WEBGL_CONTEXTS) {
+        if (webglAvailable() && hasBox && webglBudgetAllows()) {
```

```js
             if (!entry.isWebgl && entry.rendererDeferred
-                && webglAvailable() && liveWebglContexts < MAX_WEBGL_CONTEXTS) {
+                && webglAvailable() && webglBudgetAllows()) {
                 swapRenderer(entry, /* wantWebgl */ true);
             }
```

Publish on both edges of the count so peers see changes promptly rather than up to
`PEER_REPORT_INTERVAL_MS` late — inside `holder.release()` after the decrement, and
immediately after `liveWebglContexts++`:

```js
                 holder.release = () => {
                     if (released) { return; }
                     released = true;
                     liveWebglContexts = Math.max(0, liveWebglContexts - 1);
                     if (entry) { entry.isWebgl = false; }
                     forceReleaseWebglContext(webgl);
                     publishWebglCount();
                 };
```

```js
                 term.loadAddon(webgl);
                 holder.current = webgl;
                 if (entry) { entry.isWebgl = true; entry.rendererDeferred = false; }
                 liveWebglContexts++;
                 publishWebglCount();
                 return holder;
```

Call `initWebglBudgetChannel()` from `init()`, before the first `fetchTerminalList()`.

### 2. `src/webview/terminals.js` — make loss recovery use the verifying ladder

Replace the single synchronous repair in `onContextLoss` with the same
verify-resync-retry machinery every other repair in this file uses.

```js
                 webgl.onContextLoss(() => {
                     if (released) { return; }
                     console.warn('[Terminals] WebGL context lost — falling back to canvas renderer');
                     holder.release();
                     // NOT swallowed silently any more. If dispose() throws, the dead
                     // WebGL canvas layers stay in the terminal element and the incoming
                     // canvas renderer paints UNDERNEATH the frozen last frame — which
                     // reads as permanently corrupt text and is indistinguishable from a
                     // stale glyph model.
                     try {
                         webgl.dispose();
                     } catch (disposeErr) {
                         console.error('[Terminals] WebglAddon.dispose() threw after context loss — '
                             + 'dead canvas layers may remain:', disposeErr);
                         try {
                             term.element.querySelectorAll('canvas.xterm-link-layer, canvas').forEach(c => {
                                 if (c.parentNode && c.dataset.sbLive !== '1') { c.parentNode.removeChild(c); }
                             });
                         } catch { /* nothing more we can do */ }
                     }
                     holder.current = attachCanvasRenderer(term);
                     if (entry) {
                         entry.rendererDeferred = webglAvailable();
                         // A single synchronous resync loses the race it is meant to win:
                         // RenderService PARKS resizes while its IntersectionObserver says
                         // the screen is not intersecting, and DROPS them outright while no
                         // renderer is installed (readRenderedGrid's 'swapping' verdict).
                         // The ladder verifies and retries across a double-rAF plus
                         // 60/180/420ms, which is the only shape in this file that
                         // converges through that window.
                         entry.needsRendererResync = true;
                         entry.needsAtlasRebuild = true;
                         startFitLadder(entry.name);
                     }
                 });
```

`swapRenderer`'s trailing repair gets the same treatment on the **upgrade** direction (the
release direction is correctly left alone — there are no pixels to strand):

```js
         if (isRendered(entry.container)) {
-            resyncPaneRenderer(entry, 'stale-canvas');
+            entry.needsRendererResync = true;
+            entry.needsAtlasRebuild = true;
+            startFitLadder(entry.name);
         }
```

### 3. `src/webview/terminals.js` — stop consuming a glyph-model repair as a repaint

`startFitLadder` currently hard-codes `{ rebuildAtlas: false }` for the
`needsRendererResync` repair. That is right for a visibility regain (atlas intact) and
wrong for a renderer swap (atlas gone, vertex array indexed for the old grid). Carry the
distinction on the entry instead of assuming it.

```js
             if (entry.needsRendererResync && entry.term && isRendered(entry.container)) {
                 const rebuildAtlas = entry.needsAtlasRebuild === true;
                 entry.needsRendererResync = false;
                 entry.needsAtlasRebuild = false;
                 // rebuildAtlas true ONLY when the renderer itself was replaced: the
                 // incoming renderer's glyph model is empty / indexed for the old grid,
                 // and clearTextureAtlas() is the only call that reaches
                 // _clearModel(true) -> GlyphRenderer.clear(). On visibility regain the
                 // atlas is intact and rebuilding it costs re-rasterisation on every
                 // alt-tab for no gain.
                 resyncPaneRenderer(entry, 'stale-canvas', { rebuildAtlas });
                 refreshTerminalScrollbar(entry);
             }
```

Add `needsAtlasRebuild: false` to the entry literal in `createTerminalView` alongside the
other renderer fields.

### 4. `src/webview/terminals.js` — make the failure observable

Extend `__sbTerminalStats` so the diagnostic in the Complexity Audit is a one-liner rather
than a console-watching exercise, and count losses.

```js
    let webglLossCount = 0;   // incremented in onContextLoss, before the release
```

```js
    window.__sbTerminalStats = function() {
        const stats = {
            __budget: {
                documentId: selfDocumentId,
                solo: !!soloTerminalName,
                local: liveWebglContexts,
                peers: Object.fromEntries(peerWebglCounts),
                peerTotal: peerWebglTotal(),
                processCeiling: PROCESS_WEBGL_CEILING,
                lossCount: webglLossCount
            }
        };
        for (const [name, entry] of terminalsMap.entries()) {
            stats[name] = { /* … unchanged … */ };
        }
        return stats;
    };
```

The `__budget` key is deliberately not a terminal name (terminals are named `role-N`), so
existing readers that iterate the object need no change beyond skipping keys starting with
`__`.

## Verification Plan

1. **Confirm the root cause before coding.** Reproduce at HEAD: open a `3x3` cockpit grid
   plus three pop-outs, then seat one more terminal into an empty slot. In the cockpit
   console, expect `[Terminals] WebGL context lost` and `__sbTerminalStats()` showing at
   least one pane with `isWebgl: false, rendererDeferred: true`. Record the numbers. If no
   loss is logged, stop and re-diagnose per the Complexity Audit gate.
2. **Budget coordination.** After the change, open the cockpit and two pop-outs. In each
   document run `__sbTerminalStats().__budget`. Expect `peers` to list the other two
   documents with non-stale timestamps and `local + peerTotal` never to exceed
   `PROCESS_WEBGL_CEILING`.
3. **The reported repro.** Five terminals in `2x3` with one empty slot plus two pop-outs.
   Seat a sixth terminal into the empty slot. Expect: no `WebGL context lost` warning, no
   glyph corruption in any neighbour, `__budget.lossCount === 0`.
4. **Over-budget behaviour is graceful.** Force the budget to exhaust (open pop-outs until
   `local + peerTotal` reaches the ceiling), then seat another terminal. Expect the new
   pane to come up on **canvas** (`isWebgl: false, rendererDeferred: true`), render
   correctly, and no sibling to lose its context.
5. **Debt is repaid.** From the exhausted state, close a pop-out. Within
   `RENDERER_RELEASE_DELAY_MS + PEER_REPORT_INTERVAL_MS`, expect a deferred pane to upgrade
   to WebGL (`isWebgl` flips true) with no visible flicker or residue.
6. **Loss recovery when a loss is unavoidable.** Force a context loss directly:
   `__sbTerminalStats` to find a WebGL pane, then in the console
   `t = /* that pane's term */; t._core._renderService …` — simplest is to open enough
   documents in another browser tab to push the process over. Expect the affected pane to
   repaint **fully** (not just rows the CLI rewrites) within ~500 ms, driven by the ladder.
   Leave an idle CLI in that pane so nothing marks rows dirty on its own; this is the case
   the single synchronous resync lost.
7. **`dispose()` throw path.** Temporarily patch `webgl.dispose` to throw, force a loss,
   and confirm the console carries the new error and the pane still ends up readable rather
   than showing a frozen frame over live output.
8. **Atlas-rebuild discrimination.** Instrument `resyncPaneRenderer` with a temporary log of
   its `rebuildAtlas` argument. Confirm: alt-tab away and back → `false`; renderer swap →
   `true`. This is the assertion that the two triggers stopped sharing one tuning.
9. **No buffer writes.** Grep the diff for `term.write` — expect zero additions.
10. **Extension-host webview.** Load the panel inside VS Code (single document, no
    pop-outs). Confirm `__budget.peers` is empty, `peerTotal` is 0, panes come up on WebGL,
    and behaviour is identical to before the change. If `BroadcastChannel` construction is
    blocked, confirm the local-only fallback engages silently.
11. **Sustained soak.** Run a nine-terminal planning fan-out for 30 minutes with periodic
    seat/unseat and pop-out open/close. Expect `__budget.lossCount` to stay at 0 and
    `local` to return to a steady value rather than drifting upward (a drifting counter
    means a missed `release()`).
12. `node --check src/webview/terminals.js` clean.
