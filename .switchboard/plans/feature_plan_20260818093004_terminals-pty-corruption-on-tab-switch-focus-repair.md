# Fix PTY Terminal Corruption on Browser Tab Switch and Focus Regain

## Goal
In `terminals.html` (the Terminals panel), switching to another browser tab and then switching back causes visual corruption of xterm.js terminals (blank areas, scrambled character grids, broken cursor lines). Currently, the operator must manually click into each corrupted terminal pane to restore its visual buffer.

The terminal grid and individual active terminal panes must automatically detect tab focus and visibility restoration, immediately refreshing the xterm texture atlas, character grid, and scroll viewport without requiring manual operator intervention.

### Problem & Root Cause Analysis
1. **Texture Atlas & GPU Discard on Tab Backgrounding**: In Chromium-based browsers, backgrounding a tab throttles rendering and frequently discards GPU backing textures or WebGL/Canvas context for canvas elements.
2. **Atlas Rebuild Suppressed in Visibility Handler**: In `src/webview/terminals.js`, the `visibilitychange` listener sets `entry.needsRendererResync = true;` and calls `startFitLadder(name)`. However, `startFitLadder` invokes `resyncPaneRenderer(entry, 'stale-canvas', { rebuildAtlas: false })`. Because `rebuildAtlas` is explicitly `false`, `term.clearTextureAtlas()` is never called, leaving corrupted glyph textures intact.
3. **`inspectPaneFit` False Positive**: `inspectPaneFit` only checks geometry (cols/rows vs container size). Since cols and rows remain unchanged when switching tabs, `inspectPaneFit` reports `'ok'`, bypassing further render resynchronization.
4. **Missing Window Focus Trigger**: While `document.addEventListener('visibilitychange')` exists, `window.addEventListener('focus')` in `terminals.js` currently only calls `fetchKanbanColumnStructure(true)` and does NOT trigger terminal pane renderer resync. When a user alt-tabs or clicks back into the window, `focus` events may fire without a full `visibilitychange` transition in iframe cockpits.
5. **Manual Click Workaround**: When a user clicks a pane, `focusin` on `paneGridEl` triggers xterm's internal focus handler, which forces an internal canvas repaint. This proves that executing a full refresh on focus/visibility will resolve the corruption automatically.

> **Superseded (Root Cause #2):** "Atlas Rebuild Suppressed in Visibility Handler ... `rebuildAtlas` is explicitly `false`, `term.clearTextureAtlas()` is never called, leaving corrupted glyph textures intact."
> **Reason:** This inverts the actual root cause. The current code (`src/webview/terminals.js` lines 6226-6235, 6344-6352) deliberately passes `rebuildAtlas: false` on the visibility-regain path because the glyph texture atlas is **intact** on visibility regain — the corruption is unpainted rows on a correct atlas, not a corrupt atlas. `resyncPaneRenderer` calls `term.refresh(0, rows-1)`, which reaches WebGL's `_updateModel(0, rows-1)` and repaints every row from the current buffer. That IS the repair. Three code comments explicitly warn against reintroducing `clearTextureAtlas()` here (lines 1230, 6230-6231, 6344-6347): the atlas rebuild only pays a full glyph re-rasterisation cost on every alt-tab for no benefit. The visibility-regain repair is already implemented and working via the latched `needsRendererResync` flag + `startFitLadder`.
> **Replaced with:** The visibility-regain corruption is caused by rAF suspension while the document is hidden: `drainAllBatches → term.write` keeps advancing the buffer with nothing painting, and on restore only the merged dirty-row range repaints. Rows that changed while hidden but fell outside that range (e.g. a CLI's static status strip) keep stale pixels indefinitely over a CORRECT buffer. The repair is `term.refresh(0, rows-1)` (full-range repaint from buffer), which the existing latch + fit-ladder path already performs. No atlas rebuild is wanted or needed on this path.

> **Superseded (Root Cause #3):** "`inspectPaneFit` only checks geometry (cols/rows vs container size). Since cols and rows remain unchanged when switching tabs, `inspectPaneFit` reports `'ok'`, bypassing further render resynchronization."
> **Reason:** Two errors. (a) `inspectPaneFit` (line 6180) does NOT only check geometry — it also calls `readRenderedGrid` (line 6193) and returns `'stale-canvas'` when the painted grid disagrees with the buffer grid. (b) The conclusion "bypassing further render resynchronization" is false: the visibility-regain repair is **unconditional and latch-gated, not verdict-gated**. `startFitLadder`'s `attempt()` (line 6350) checks `entry.needsRendererResync` and runs `resyncPaneRenderer` BEFORE `inspectPaneFit` is ever consulted, then clears the flag. The verdict being `'ok'` is expected for unpainted rows (grid geometry agrees) and is irrelevant — the latch already fired the repair.
> **Replaced with:** `inspectPaneFit`'s `'ok'` verdict on visibility regain is correct and expected (unpainted rows leave cols/rows and painted-grid geometry in agreement). The repair is not gated on this verdict; it is driven by the `needsRendererResync` latch, which the `visibilitychange` handler arms and the ladder's `attempt()` consumes unconditionally. No bypass occurs.

> **Superseded (Root Cause #5):** "Manual Click Workaround ... proves that executing a full refresh on focus/visibility will resolve the corruption automatically."
> **Reason:** The mechanism described (pane click → `focusin` → xterm internal repaint) is real, but the conclusion that "a full refresh on focus/visibility" is missing is false for the visibility path — it is already implemented (latch + ladder). The click workaround is now only relevant to the **window-focus** gap (#4), which is the sole remaining unaddressed trigger.
> **Replaced with:** The manual-click workaround demonstrates that a repaint repairs the corruption. The visibility-regain path already automates this via the latch. The remaining gap is that `window.focus` (which fires on same-browser window switching where `visibilitychange` does NOT fire) does not arm the latch — so the same corruption class goes unrepaired when the operator returns to the window without a tab visibility transition.

## Metadata
- **Complexity:** 3
- **Tags:** frontend, reliability, bugfix, performance
- **Project:** Browser Switchboard

## User Review Required
This plan corrects a prior version whose root-cause analysis and proposed fix described an already-fixed visibility-regain bug and would have **regressed** the codebase by reintroducing `clearTextureAtlas()` on every alt-tab — explicitly warned against by three code comments. The corrected scope is a minimal, latched addition to the `window.focus` handler. Reviewer should confirm the narrowed scope matches intent before dispatch.

## Complexity Audit

### Routine
- Adding renderer-resync arming to the existing `window.addEventListener('focus', ...)` handler in `src/webview/terminals.js` (line 1200).
- Reusing the existing `needsRendererResync` latch + `startFitLadder(name)` pattern already proven on the `visibilitychange` path (lines 1252-1266).
- Iterating `paneAssignments.slice(0, getSlotCount(effectiveLayout))` to start ladders for visible panes — identical to the visibilitychange handler's loop.

### Complex / Risky
- None. The change mirrors an existing, commented, working code path. No new private xterm surface is touched; `resyncPaneRenderer` and `refreshTerminalScrollbar` are already called by the ladder with the correct `rebuildAtlas: false` option.

## Edge-Case & Dependency Audit
- **Race Conditions:** Rapid focus/blur cycles (e.g. jittering window focus) are collapsed by `fitLadderGen` (line 6322-6323) — each `startFitLadder` call increments the generation, superseding prior attempts. No separate debounce is needed; the visibilitychange handler relies on the same mechanism and is not debounced.
- **Security:** No new input surface, no schema boundary touched. Pure client-side render repair.
- **Side Effects:** The repair is `rebuildAtlas: false` (atlas intact) + `term.refresh(0, rows-1)` (full-range repaint from buffer) + `refreshTerminalScrollbar`. Per the existing code comments (lines 1238-1242), the per-regain cost is one full-range repaint per visible pane — cheap enough to pay on every app switch. Adding the focus trigger doubles this cost only when focus fires WITHOUT a visibility transition (same-browser window switch), which is the exact case the gap exists to cover. When focus follows a visibility transition (the common alt-tab case), `needsRendererResync` is already true and the ladder has already run; re-arming a superseded ladder generation is a no-op.
- **Dependencies & Conflicts:** No dependency on other plans. The change is self-contained in `src/webview/terminals.js`. The `visibilitychange` repair (already shipped) is a prerequisite that this plan extends, not replaces.
- **Solo vs Multi-Grid Mode:** The focus handler must iterate `paneAssignments` across all layout modes (1, 2, 3, 4, 6, 9 panes) exactly as the visibilitychange handler does. The solo popout view sets `paneAssignments = [soloTerminalName]` (line 725) and `effectiveLayout = '1'`, so the same loop covers it.
- **Scrollback Buffer Invariants:** `refreshTerminalScrollbar(entry)` is called by the ladder's `attempt()` (line 6353) after `resyncPaneRenderer`. It derives scroll position from `buffer.ydisp` and must NOT save/restore `scrollTop` (per its own documentation, lines 6253-6263). The focus path inherits this behavior unchanged.
- **Hidden iframe cockpits:** The repair is LATCHED, not run inline. In an iframe cockpit whose panel is `display:none`, `window.focus` still fires on the nested document when the top-level window regains focus; the latch (`needsRendererResync = true`) survives until the pane has a box, and the reveal goes through the ladder's `attempt()` which consumes the flag. An eager inline repair (the prior plan's approach) would `continue` past zero-box containers and silently skip every hidden pane — the latch is the correct contract.

## Dependencies
- None. The visibility-regain repair this plan extends is already shipped in `src/webview/terminals.js`.

## Adversarial Synthesis
Key risks: (1) the prior plan's root cause inverted the actual defect (unpainted rows on an intact atlas, not a corrupt atlas) and would have regressed three explicit code comments by reintroducing `clearTextureAtlas()` on every alt-tab; (2) the prior plan's eager inline repair broke the hidden-iframe latch contract. Mitigations: the corrected plan reduces to a latched focus handler that mirrors the already-working `visibilitychange` path — `rebuildAtlas: false`, latch + `startFitLadder`, no new function, no eager inline resync. The only net-new code is arming `needsRendererResync` and starting ladders inside the existing focus listener.

## Proposed Changes

### `src/webview/terminals.js`

- **Context:** The `window.addEventListener('focus', ...)` handler at line 1200 currently only calls `fetchKanbanColumnStructure(true)`. It does NOT arm renderer resync. When the operator switches between same-browser windows (not tabs), `visibilitychange` does NOT fire (the document stays `'visible'` but blurred), so the existing visibility-regain repair never runs and the same corruption class goes unrepaired until a manual pane click.

- **Logic:** Mirror the `visibilitychange` handler (lines 1252-1266): arm `needsRendererResync = true` on all live, non-disposed entries, then start fit ladders for visible panes. The ladder's `attempt()` (line 6350) consumes the latch and runs `resyncPaneRenderer(entry, 'stale-canvas', { rebuildAtlas: false })` + `refreshTerminalScrollbar(entry)` — the identical, already-proven repair. Do NOT call `resyncPaneRenderer` inline; do NOT pass `rebuildAtlas: true`.

- **Implementation:** Replace the existing focus listener:

```javascript
// Existing (line 1200):
window.addEventListener('focus', () => fetchKanbanColumnStructure(true));

// Replaced with:
window.addEventListener('focus', () => {
    fetchKanbanColumnStructure(true);
    // Mirror the visibilitychange repair (lines 1252-1266): arm the latch on
    // every live entry, then let the fit ladder schedule the actual repaint.
    // `visibilitychange` does NOT fire on same-browser window blur/focus (the
    // document stays 'visible'), so without this arm the corruption class goes
    // unrepaired until a manual pane click. rebuildAtlas stays false: the atlas
    // is intact on this path (see resyncPaneRenderer doc, lines 6226-6235).
    for (const entry of terminalsMap.values()) {
        if (!entry || entry.disposed || !entry.term) { continue; }
        entry.needsRendererResync = true;
    }
    const slotCount = getSlotCount(effectiveLayout);
    for (let i = 0; i < slotCount; i++) {
        const name = paneAssignments[i];
        if (name) { startFitLadder(name); }
    }
});
```

- **Edge Cases:**
  - **Focus fires after a visibility transition (common alt-tab):** `needsRendererResync` is already true and the ladder has already run; re-arming is idempotent (the flag is already set), and `startFitLadder` increments the generation, superseding the prior ladder — a no-op once the prior attempt already cleared the flag and repaired.
  - **Focus fires with no visible panes (hidden iframe):** The latch is armed on all live entries; `startFitLadder` runs but `attempt()` returns early on `!isRendered(entry.container)` without clearing the flag (line 6350 gates on `isRendered`). The flag survives to the reveal, where the ResizeObserver-triggered ladder consumes it. This is the exact contract the visibilitychange handler relies on.
  - **Rapid focus/blur jitter:** `fitLadderGen` collapses the cycles — each `startFitLadder` supersedes the prior generation. No separate debounce needed (matches the visibilitychange handler, which is also not debounced).

> **Superseded (prior Proposed Changes):** The prior plan proposed a new `repairVisibleTerminalRenderers(forceAtlasRebuild = true)` function that eagerly called `resyncPaneRenderer(entry, 'stale-canvas', { rebuildAtlas: true })` inline for all visible panes, attached to both `visibilitychange` and `focus`.
> **Reason:** Three defects. (1) `rebuildAtlas: true` reintroduces `clearTextureAtlas()` on every visibility/focus regain — explicitly warned against by three code comments (lines 1230, 6230-6231, 6344-6347); the atlas is intact on this path and the rebuild only pays re-rasterisation cost. (2) The `visibilitychange` branch duplicates an already-shipped, working repair (lines 1252-1266 + ladder 6350-6354). (3) The eager inline `continue` on `!isRendered(entry.container)` silently skips every pane in a hidden iframe and never sets the latch, breaking the hidden-iframe contract the latched approach exists to preserve.
> **Replaced with:** A minimal latched addition to the existing `window.focus` handler that mirrors the `visibilitychange` handler — arm `needsRendererResync = true`, start fit ladders, `rebuildAtlas: false`. No new function. The `visibilitychange` handler is left untouched (already correct).

## Verification Plan

### Automated Tests
- Run terminals contract tests (the prior plan referenced `verb-engine-terminals-headless.test.js`, which does **not exist** in this repository):
  - `npm test src/test/shell-terminal-strip.test.js`
  - `npm test src/test/multi-parent-terminals-contract.test.js`
- Per the run directives for this session: **skip compilation** and **skip automated tests** — the checks remain written down, they are simply not executed now.

### Manual Verification
1. Open the Terminals panel with 4 or 6 active terminals running agent CLIs or shell commands producing colored output.
2. **Visibility path (regression guard):** Switch to another browser tab or minimize the browser for 10-15 seconds. Switch back. Verify all terminal panes immediately re-render clean glyphs and buffers without blank spots, tearing, or requiring manual clicks. (This already works today; the test guards against the prior plan's regression.)
3. **Focus path (the actual fix):** With the Switchboard window visible, click another browser window on the same screen (so the Switchboard window blurs but its document stays `visible`). Wait a few seconds. Click back into the Switchboard window. Verify all terminal panes re-render clean without manual clicks. This is the case `visibilitychange` does NOT cover.
4. Verify scroll position in terminals with scrollback is unchanged after both paths.
5. Verify no perceptible performance regression on rapid alt-tab cycling (the per-regain cost is one full-range repaint per visible pane; the focus path only adds cost when focus fires without a visibility transition).

## Outstanding Questions
- **[user]** The prior plan's root-cause analysis described the visibility-regain repair as missing/broken; the current code shows it is already shipped and deliberately avoids `clearTextureAtlas()`. Is the narrowed scope (focus handler only) the intended work, or was the prior plan authored against an older revision of `terminals.js` that genuinely lacked the latch? — proceeding on the assumption that the current code is the source of truth and the only net-new work is the focus handler.

## Completion Report
Implemented terminal renderer resynchronization on window focus in `src/webview/terminals.js`. The `window.focus` event handler now latches `needsRendererResync = true` across all live, non-disposed terminal entries and initiates fit ladders for visible panes, mirroring the existing `visibilitychange` repair path to fix stale or unpainted viewport pixels when switching windows without a tab visibility transition. Modified file: `src/webview/terminals.js`. No issues encountered.
