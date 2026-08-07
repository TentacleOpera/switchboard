# Fix Terminal Renderer Desync on Window Minimize/Restore

## Metadata

**Complexity:** 3
**Tags:** frontend, bugfix, ui, reliability
**Project:** Browser Switchboard

## Goal

Terminal output in the browser cockpit's PTY panes occasionally shows corrupted ANSI — garbled characters, misaligned rows, stale glyph fragments — that persists until the operator types something into the terminal. The corruption is triggered by window minimize/restore (and sometimes by switching between terminals), and heals on any input that triggers a repaint of the affected cells.

### Root Cause

xterm.js's `RenderService` pauses when its `IntersectionObserver` reports `isIntersecting: false` (window minimized, tab hidden). While paused, the renderer parks all repaint requests and renderer resizes. The `BATCH_FALLBACK_MS` timer (200ms `setTimeout` at `terminals.js:4527`) still fires in background tabs (throttled, not suspended), so `drainAllBatches()` runs → `term.write(combined)` is called while the renderer is paused. The write updates the buffer but the render is parked. On macOS, the GPU may also reclaim the WebGL context for minimized windows, triggering the `onContextLoss` handler (line 253) which disposes WebGL and attaches a canvas fallback — but this happens while paused, so the canvas fallback does no initial paint.

On window restore, rAF resumes and the IntersectionObserver should fire `isIntersecting: true` to unpause the renderer. But there is a race: the rAF callback (which flushes batched writes) can fire BEFORE the IntersectionObserver delivers the "intersecting" record. When the renderer finally unpauses, it may only paint dirty cells from the queued write — not a full repaint — and the canvas/WebGL texture atlas is stale or corrupted (wrong glyph textures, wrong cell metrics). The result is garbled output that persists until new input triggers a repaint of the affected cells.

**There is no `visibilitychange` listener anywhere in `terminals.js`.** The codebase already has the fix primitives — `resyncPaneRenderer` (line 3043) does `clearTextureAtlas()` + `refresh()` + `handleResize()`, and `startFitLadder` (line 3131) handles dimension changes — but these are only triggered by `ResizeObserver` callbacks (pane switches, layout changes). Window minimize/restore is an unhandled visibility transition.

### Background Context

The fit ladder (`startFitLadder`, line 3131) was designed to handle a similar race for pane switches: `renderPaneGrid` reparents xterm containers, which can cause the IntersectionObserver to fire `isIntersecting: false` then `true`, and the ladder's double-rAF attempt 0 (line 3202) ensures the IntersectionObserver records are delivered before inspecting the pane fit. But `startFitLadder` is only called from:
- `ResizeObserver` callback (line 4161) — fires on container resize, not on window visibility change
- `batchFitVisiblePanes` (line 2937) — called after layout changes
- `updatePaneElement` re-parent branch (line 2316) — called on pane assignment change

None of these fire on window minimize/restore.

The `resyncPaneRenderer` function (line 3043) is the key repair primitive:
1. `getBoundingClientRect()` — forces a style/layout flush, which lets the next IntersectionObserver computation see real geometry and unpause `RenderService`
2. `clearTextureAtlas()` — forces the renderer to rebuild its glyph texture atlas (fixes WebGL context loss corruption)
3. `refresh(0, rows-1)` — marks all rows as dirty, requesting a full repaint
4. `_renderService.handleResize(cols, rows)` — re-runs `_updateDimensions()` to re-size the canvas and `.xterm-screen` (fixes stale canvas dimensions)

But `resyncPaneRenderer` is only called from the fit ladder when `inspectPaneFit` returns `'stale-canvas'` or `'mismatch'`. If the dimensions are correct but the texture atlas is corrupted, `inspectPaneFit` returns `'ok'` and the resync is skipped.

## Proposed Changes

### File 1: `src/webview/terminals.js` — Add `visibilitychange` listener for renderer resync

Add a `visibilitychange` event listener in the `init()` function (after the existing `window.addEventListener('focus', ...)` at line 581, before `fetchKanbanColumnStructure(true)` at line 583).

The listener:
1. Checks `document.visibilityState === 'visible'` (ignore hidden transitions)
2. Uses a double-rAF to ensure the IntersectionObserver has delivered "intersecting" records and the renderer has unpaused before attempting repair (same pattern as fit ladder attempt 0 at line 3202)
3. After the double rAF, iterates all entries in `terminalsMap`
4. For each entry that has a live `term`, is not `disposed`, and is assigned to a visible pane:
   - Calls `resyncPaneRenderer(entry, 'stale-canvas')` unconditionally — this clears the texture atlas, forces a full repaint, and re-syncs the canvas dimensions. The `'stale-canvas'` verdict ensures step 4 (`_renderService.handleResize`) runs.
   - Calls `refreshTerminalScrollbar(entry)` — fixes any stale scroll area from the hidden period
   - Calls `startFitLadder(entry.name)` — handles any dimension changes that occurred while the window was minimized (e.g., window was resized while minimized)

```javascript
        // Renderer resync on window regain. Minimizing the window pauses xterm's
        // RenderService (IntersectionObserver → isIntersecting:false → _isPaused),
        // and the BATCH_FALLBACK_MS timer can flush writes while the renderer is
        // still paused — the buffer updates but the canvas is not repainted. On
        // macOS the GPU may also reclaim the WebGL context for minimized windows,
        // and the onContextLoss canvas fallback is attached while paused (no
        // initial paint). On restore, a race between rAF and the IntersectionObserver
        // delivery can leave the renderer painting dirty cells only, with a stale
        // or corrupted texture atlas — garbled ANSI that persists until new input
        // triggers a repaint of the affected cells.
        //
        // The double rAF matches the fit ladder's attempt 0 pattern (line 3202):
        // the first frame lands after the visibility change, the second after the
        // IntersectionObserver records are delivered and the renderer unpauses.
        // resyncPaneRenderer is called UNCONDITIONALLY — not gated on
        // inspectPaneFit — because the texture atlas can be corrupted even when
        // the canvas dimensions are correct (inspectPaneFit returns 'ok').
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState !== 'visible') { return; }
            requestAnimationFrame(() => requestAnimationFrame(() => {
                for (const [name, entry] of terminalsMap) {
                    if (!entry || entry.disposed || !entry.term) { continue; }
                    // Only resync terminals assigned to a visible pane — an
                    // unassigned terminal's container is detached and
                    // isRendered() would return false, making the resync a no-op
                    // anyway, but skipping avoids the forced layout flush.
                    if (!paneAssignments.slice(0, getSlotCount(effectiveLayout)).includes(name)) { continue; }
                    resyncPaneRenderer(entry, 'stale-canvas');
                    refreshTerminalScrollbar(entry);
                    startFitLadder(name);
                }
            }));
        });
```

**Placement:** Insert immediately after the `window.addEventListener('focus', ...)` block (line 581) and before `fetchKanbanColumnStructure(true)` (line 583). This keeps all window-level event listeners grouped together.

**Why double rAF and not a single rAF or setTimeout:** The IntersectionObserver callback is delivered as part of the browser's rendering pipeline, which runs AFTER rAF callbacks in the same frame. A single rAF would fire before the IntersectionObserver record is delivered, so `_isPaused` would still be true and `resyncPaneRenderer`'s `refresh()` call would be a no-op. The double rAF ensures the first frame's IntersectionObserver records are processed before the second frame's rAF callback runs. This is the same reasoning documented at line 3195-3198 for the fit ladder.

**Why `resyncPaneRenderer(entry, 'stale-canvas')` and not just `startFitLadder(name)`:** `startFitLadder` calls `inspectPaneFit` first, and only calls `resyncPaneRenderer` if the verdict is `'stale-canvas'` or `'mismatch'`. If the canvas dimensions are correct but the texture atlas is corrupted (the common case after WebGL context loss), `inspectPaneFit` returns `'ok'` and the resync is skipped. The unconditional `resyncPaneRenderer` call ensures the texture atlas is always rebuilt. The subsequent `startFitLadder` call handles any dimension changes that the unconditional resync doesn't cover (it also calls `resyncPaneRenderer` internally if needed, but that's idempotent — `clearTextureAtlas()` and `refresh()` are safe to call twice).

**Why not also flush `pendingBatchEntries` before the resync:** The rAF callback in `scheduleBatchFlush` (line 4520) will fire on the next frame after rAF resumes, which is the same frame as our first rAF. By the time our second rAF fires, the batch has already been flushed and `term.write()` has been called. The `resyncPaneRenderer`'s `refresh(0, rows-1)` marks all rows as dirty, so the next render cycle will paint everything including the newly written content.

## Edge Cases

**WebGL context loss during minimize:** The `onContextLoss` handler (line 253) disposes the WebGL addon and attaches a canvas fallback. This happens while the renderer is paused, so the canvas fallback does no initial paint. On restore, the double-rAF `resyncPaneRenderer` call will force a full repaint of the canvas fallback, fixing the blank/garbled display. The `clearTextureAtlas()` call is a no-op for the canvas renderer (it only affects WebGL), but `refresh()` and `handleResize()` are effective for both renderers.

**Multiple minimize/restore cycles in rapid succession:** Each `visibilitychange` event schedules a double-rAF. If the window is minimized again before the second rAF fires, the rAF callbacks are suspended (rAF doesn't fire in hidden tabs), so no repair runs — which is correct (the renderer is paused anyway). When the window is finally restored, the last `visibilitychange` event's double-rAF fires and repairs all terminals. Earlier suspended rAF callbacks may also fire, but `resyncPaneRenderer` is idempotent (safe to call multiple times).

**Terminal exited during minimize:** If a terminal exits while the window is minimized, the exit frame is processed by the WebSocket `onmessage` handler (which runs regardless of visibility), `entry.exited` is set to true, and the terminal shows the exit message. On restore, the `resyncPaneRenderer` call will repaint the terminal showing the exit message correctly. The `entry.disposed` guard prevents resync of destroyed views.

**Solo mode (pop-out window):** In solo mode, `paneAssignments` has one slot and `getSlotCount(effectiveLayout)` returns 1. The `paneAssignments.slice(0, 1).includes(name)` check correctly identifies the solo terminal. The resync runs on the solo terminal as expected.

**Direct navigation to `/terminals` (not in shell iframe):** The `visibilitychange` event fires on the document regardless of whether the page is in an iframe or standalone. The listener works in both contexts.

## Dependencies

None — this is a standalone bugfix. The fix uses existing functions (`resyncPaneRenderer`, `refreshTerminalScrollbar`, `startFitLadder`) that are already tested by the pane-switch fit ladder path. No new dependencies, no new APIs, no changes to the gateway or backend.

## Adversarial Synthesis

**Risk: forced layout flush on every restore.** `resyncPaneRenderer` calls `getBoundingClientRect()` (step 1), which forces a style/layout flush. With 9 terminals in a 3x3 grid, that's 9 forced flushes. But this is a one-time cost on window restore — not a per-frame cost — and the fit ladder already does the same thing on pane switches. The cost is negligible.

**Risk: `startFitLadder` called after `resyncPaneRenderer` may be redundant.** `resyncPaneRenderer` already calls `handleResize`, which re-sizes the canvas. `startFitLadder` may detect no mismatch and exit early. But `startFitLadder` also handles the case where the terminal's container changed size while minimized (e.g., the window was resized while in the dock), which `resyncPaneRenderer` does not. The redundancy is safe — both functions are idempotent.

**Risk: the double rAF may not be enough on all browsers.** The IntersectionObserver delivery timing is not guaranteed by the spec. In practice, Chromium delivers IntersectionObserver records in the "rendering" step of the event loop, which runs after rAF callbacks. The double rAF pattern is used by the existing fit ladder (line 3202) and has been validated in production. If a browser delivers IntersectionObserver records before rAF, the first rAF would see the renderer unpaused, and the second rAF would be a no-op (safe). If a browser delivers them after the second rAF (theoretically possible but not observed in practice), the `resyncPaneRenderer` call would be a no-op while paused, and the subsequent `startFitLadder` timer-based attempts (60ms, 180ms, 420ms) would catch up. The combination is robust.

**Risk: the fix doesn't address the underlying race between `BATCH_FALLBACK_MS` and the renderer pause.** The `BATCH_FALLBACK_MS` timer can flush writes while the renderer is paused, which is the root cause of the stale buffer. An alternative fix would be to skip `drainAllBatches()` when `document.visibilityState === 'hidden'`. But this would leave output queued indefinitely if the window stays hidden for a long time, and the queue could grow large. The current approach (let the queue flush, then resync the renderer on restore) is simpler and handles the queue naturally. The `resyncPaneRenderer` call ensures the flushed content is repainted correctly.

## Verification Plan

### Automated Tests

No automated tests required — this is a browser-level visibility/rendering interaction that cannot be simulated in a Node.js test harness. The existing `pty-route-surface-contract.test.js` and other contract tests do not cover browser renderer state. Verification is manual.

### Manual Verification

1. Open the browser cockpit (`/shell` or standalone `/terminals`).
2. Create 2-3 terminals with CLI agents (Claude, Gemini, or plain shells).
3. Wait for each terminal to produce some output (a prompt, a few lines).
4. **Minimize the browser window** (Cmd+M on macOS, or click the minimize button).
5. Wait 5-10 seconds (allow time for the GPU to potentially reclaim the WebGL context).
6. **Restore the window** (click the dock icon, or Cmd+Tab to the browser).
7. **Verify:** All terminal panes show correct, non-garbled output immediately after restore. No garbled ANSI, no stale fragments, no misaligned rows.
8. **Verify:** If any terminal produced output while the window was minimized (e.g., a shell prompt timer, an agent thinking output), that output is visible and correctly rendered after restore.
9. **Repeat steps 4-7 five times** to verify the fix is reliable (the bug was intermittent).
10. **Test with WebGL renderer:** Open Chrome DevTools → Console, run `__sbTerminalStats()`, verify at least one terminal shows `isWebgl: true` (if the GPU supports WebGL). Minimize and restore — verify no corruption.
11. **Test with canvas renderer:** If WebGL is available, force canvas fallback by opening enough terminals to exceed `MAX_WEBGL_CONTEXTS` (12). Minimize and restore — verify no corruption in the canvas-rendered terminals.
12. **Test rapid minimize/restore:** Minimize and restore the window 3 times in quick succession (within 2 seconds). Verify no corruption after the final restore.
13. **Test with a terminal that exits during minimize:** Start a terminal with a command that exits in 3 seconds (e.g., `sleep 3 && exit`). Minimize the window immediately. Wait 5 seconds. Restore. Verify the terminal shows the exit message correctly (not garbled).
14. **Test solo mode:** Open a terminal in a pop-out window (`/terminals?solo=<name>`). Minimize and restore the pop-out. Verify no corruption.
