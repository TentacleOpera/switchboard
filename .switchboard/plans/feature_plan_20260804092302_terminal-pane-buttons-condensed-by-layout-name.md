# Terminal pane buttons condensed to single letters by layout name, not by actual width

## Goal

In the Terminals view, when a multi-pane layout like 2x3 (6 panes) or 3x3 (9 panes) is selected, the per-pane `clear` and `hide` action buttons collapse to the single letters `c` and `h`. The user reports there is "heaps of room" — the condensation fires even on wide monitors where the full words fit easily. This is a UX regression: the buttons become ambiguous (c vs h are not self-explanatory) and the condensation is driven by the layout name, not by any measurement of available header width.

### Problem Analysis & Root Cause

The pane header is a flex row (`justify-content: space-between`) with two children:
- `.pane-title` — flex, with `overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0` (already designed to truncate gracefully when space is tight).
- `.pane-actions` — `flex-shrink: 0` (holds the buttons, designed to keep its full width).

This layout already has the correct overflow behavior: when the header is genuinely too narrow, the **title ellipsizes** while the buttons keep their full labels. The infrastructure for graceful degradation is already in place.

The bug is a **premature, layout-name-based shortcut** that bypasses this mechanism:

1. **`src/webview/terminals.js:1225`** — `const terse = effectiveLayout === '2x3' || effectiveLayout === '3x3';` hardcodes the condensation by layout name. Whenever the layout is 2x3 or 3x3, the button labels are set to `'c'` / `'h'` regardless of the actual rendered pane width. On a wide monitor, a 2x3 layout (3 columns) gives each pane far more than the ~50px needed to render "clear" and "hide" at 10px font.

2. **`src/webview/terminals.html:548-610`** —配套 CSS shrinks `.pane-header` padding/font-size and `.btn-unassign-pane` padding specifically for `.layout-2x3` / `.layout-3x3`, with comments asserting "The 6- and 9-pane headers are too narrow for two words." This assertion is false on wide displays and is the rationalization for the JS-side condensation.

3. **`withClearingFeedback` (`terminals.js:1746-1755`)** — the restore label passed in is `terse ? 'c' : 'clear'`, so the terse flag also controls the transient "clearing" feedback text. Removing `terse` means the full `'clear'` label is always passed, which correctly triggers the `'clearing'` transient state (length > 1 branch at line 1749).

**Root cause:** The condensation is keyed on layout name (`'2x3'` / `'3x3'`) rather than on measured available width. The existing flex + ellipsis CSS already handles true overflow correctly — the `terse` flag is redundant and fires far too aggressively.

## Metadata

**Complexity:** 2
**Tags:** frontend, ui, ux, bugfix
**Project:** Browser Switchboard

## Complexity Audit (Routine vs Complex/Risky)

**Routine.** This is a small, localized change to two files:
- Remove a boolean flag and its three ternary usages in `terminals.js`.
- Remove two layout-specific CSS rule blocks in `terminals.html`.

No new logic, no new dependencies, no state changes, no backend involvement. The flex layout that already handles overflow is untouched. Risk is limited to the visual appearance of pane headers in 2x3/3x3 layouts on genuinely narrow viewports — but even there, the title ellipsizes first (by design), so the buttons retain their full labels until the header is so narrow that the title is already reduced to near-zero. That is the correct degradation order.

## Edge-Case & Dependency Audit

- **Narrow viewports / small webview panels:** With `terse` removed, on a very narrow viewport the full "clear"/"hide" labels plus a long terminal name could in theory crowd the header. But `.pane-title` has `min-width: 0` + ellipsis and `.pane-actions` has `flex-shrink: 0`, so the title truncates first. The buttons only become a problem if the title is already empty and the buttons still don't fit — an extreme case that does not occur with 3 columns on any realistic VS Code panel width. The existing 2x3/3x3 title-ellipsis CSS (lines 553-559) is retained, so narrow-viewport title truncation still works.
- **`withClearingFeedback` transient label:** Currently `restoreLabel = terse ? 'c' : 'clear'`. After the fix, `restoreLabel` is always `'clear'` (length 5 > 1), so line 1749 shows `'clearing'` during the 600ms feedback window — the intended full-word treatment. The `hide` button does not pass a `restoreLabel`, so it is unaffected.
- **No existing tests reference the terse labels:** A grep across `src/test/*terminal*` for `terse`, `'c'`, `'h'`, `btn-unassign`, `paneClear`, `unassignBtn` returned no matches. The condensation is untested, so removing it breaks no contracts.
- **Sidebar list buttons (`terminals.js:751-760`):** The sidebar's per-terminal `clear` button already always uses the full `'clear'` label (no terse flag). This plan aligns the pane-grid buttons with the sidebar's behavior — consistency win.
- **Layout buttons in the toolbar (`terminals.html:848-853`):** Unrelated; the `2x3`/`3x3` toolbar buttons keep their labels.

## Proposed Changes

### `src/webview/terminals.js` — remove the `terse` flag and always use full labels

At lines 1222-1235 (pane clear button), remove the `terse` declaration and collapse the ternaries:

```js
// BEFORE
if (assignedName) {
    // Same two words the extension sidebar uses. The 6- and 9-pane
    // headers cannot fit them, so those fall back to initials.
    const terse = effectiveLayout === '2x3' || effectiveLayout === '3x3';

    const paneClearBtn = document.createElement('button');
    paneClearBtn.className = 'btn-unassign-pane';
    paneClearBtn.textContent = terse ? 'c' : 'clear';
    paneClearBtn.title = 'Send /clear to this terminal';
    paneClearBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        withClearingFeedback(paneClearBtn, () => clearTerminal(assignedName), terse ? 'c' : 'clear');
    });
    actionsEl.appendChild(paneClearBtn);

    const unassignBtn = document.createElement('button');
    unassignBtn.className = 'btn-unassign-pane';
    unassignBtn.textContent = terse ? 'h' : 'hide';
    ...

// AFTER
if (assignedName) {
    // Same two words the extension sidebar uses. The pane-title flexes
    // and ellipsizes when the header is genuinely narrow, so the buttons
    // keep their full labels at every layout.
    const paneClearBtn = document.createElement('button');
    paneClearBtn.className = 'btn-unassign-pane';
    paneClearBtn.textContent = 'clear';
    paneClearBtn.title = 'Send /clear to this terminal';
    paneClearBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        withClearingFeedback(paneClearBtn, () => clearTerminal(assignedName), 'clear');
    });
    actionsEl.appendChild(paneClearBtn);

    const unassignBtn = document.createElement('button');
    unassignBtn.className = 'btn-unassign-pane';
    unassignBtn.textContent = 'hide';
    ...
```

The `unassignBtn` click handler body (lines 1241-1250) is unchanged — it never referenced `terse`.

### `src/webview/terminals.html` — remove the layout-specific button-shrink CSS, keep title ellipsis

Remove the button-padding override block at lines 605-610:

```css
/* REMOVE — the pane-title ellipsizes when narrow; buttons keep full labels. */
/* The 6- and 9-pane headers are too narrow for two words, so the label
   collapses to the first letter there rather than overflowing the title. */
.pane-grid.layout-2x3 .btn-unassign-pane,
.pane-grid.layout-3x3 .btn-unassign-pane {
    padding: 2px 4px;
}
```

**Keep** the title-ellipsis rules at lines 553-559 (`.pane-grid.layout-2x3 .pane-title, .pane-grid.layout-3x3 .pane-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }`) — these are the correct overflow mechanism and remain needed for narrow viewports.

**Keep** the header padding/font shrink at lines 548-552 (`.pane-grid.layout-2x3 .pane-header, .pane-grid.layout-3x3 .pane-header { padding: 2px 4px; font-size: 10px; }`) — this is a reasonable density tweak for multi-pane layouts and does not affect label text.

## Verification Plan

1. **Build/typecheck:** Run the project's standard webview build/lint step (e.g. `npm run build` or the webview lint target) and confirm no new errors.
2. **Manual — 2x3 layout on a wide window:**
   - Open the Terminals view, assign terminals to panes, select the `2x3` layout.
   - Confirm each pane header shows full `clear` and `hide` button labels (not `c` / `h`).
   - Confirm a long terminal name in a pane title ellipsizes (trailing `…`) rather than the buttons shrinking.
3. **Manual — 3x3 layout on a wide window:** Same checks as above for `3x3`.
4. **Manual — narrow viewport regression check:** Narrow the VS Code panel / webview window sharply while in `2x3` or `3x3` layout. Confirm the title ellipsizes first and the buttons remain labeled `clear` / `hide` until the header is too narrow for even the title — at which point the title is already near-empty and the buttons are the only readable content (correct degradation order).
5. **Manual — clearing feedback:** Click `clear` on a pane button in `2x3` layout. Confirm the button label changes to `clearing` for ~600ms then reverts to `clear` (the `withClearingFeedback` full-word path).
6. **Existing tests:** Run `npm test` (or the project's test command) and confirm no regressions in the terminal contract tests under `src/test/`.
