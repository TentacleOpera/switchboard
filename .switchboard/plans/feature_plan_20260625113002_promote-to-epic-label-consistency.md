# Promote to Epic Button Label Consistency

## Goal

### Problem
In the kanban board (`kanban.html`), the EPIC action button (`#btn-epic-action`) displays inconsistent labels depending on how many cards are selected:

- **0 cards selected** → label is `EPIC` (disabled)
- **1 non-epic card selected** → label is `PROMOTE TO EPIC` (enabled)
- **Multiple non-epic cards selected** → label is `EPIC (n)` (enabled)
- **1 epic + non-epic cards** → label is `ADD n TO EPIC` (enabled)
- **1 epic alone** → label is `EPIC` (disabled)

The user reports that when one card is selected the wording is "promote to epic", but when multiple are selected it is just "epic". The label should **always** read `PROMOTE TO EPIC` for the non-epic selection states (including when no cards are selected, though it remains disabled in that case).

### Root Cause
The `updateEpicActionButton()` function in `kanban.html` (lines 6694–6720) branches on the selection composition and assigns different `textContent` values per branch. The multiple-non-epic branch (line 6713–6715) uses `EPIC (${nonEpics.length})` instead of `PROMOTE TO EPIC`, and the zero-selection / lone-epic / fallback branches use the bare string `EPIC`.

### Desired Behavior
- **0 cards selected** → `PROMOTE TO EPIC` (disabled)
- **1 non-epic card** → `PROMOTE TO EPIC` (enabled)
- **Multiple non-epic cards** → `PROMOTE TO EPIC` (enabled)
- **1 epic + non-epic cards** → `ADD n TO EPIC` (enabled) — *unchanged, this is a different action*
- **1 epic alone** → `PROMOTE TO EPIC` (disabled) — *label consistent, action disabled*

## Metadata
- **Tags:** kanban, ui, epic, label, frontend
- **Complexity:** 2/10

## Complexity Audit
**Routine.** This is a pure frontend label change in a single function with no backend, DB, or file-system involvement. No migrations, no data loss risk.

## Edge-Case & Dependency Audit
- The `ADD n TO EPIC` branch (1 epic + non-epics) must remain unchanged — it triggers `addSubtaskToEpic`, a different action.
- The click handler (lines 9322–9361) dispatches based on `epics.length` and `nonEpics.length`, NOT on the button label. Changing the label text does not affect dispatch logic.
- The `data-tooltip` attribute on the button (line 2515) says "Convert selected plans to epic or manage existing epic" — this remains accurate.
- No other code references the button's `textContent` for logic decisions.

## Proposed Changes

### `src/webview/kanban.html` — `updateEpicActionButton()` (lines 6694–6720)

Replace the label assignments so that every non-`ADD TO EPIC` branch uses `PROMOTE TO EPIC`:

```javascript
function updateEpicActionButton() {
    const btn = document.getElementById('btn-epic-action');
    if (!btn) return;
    const selected = Array.from(selectedCards.values());
    const epics = selected.filter(s => s.isEpic);
    const nonEpics = selected.filter(s => !s.isEpic);
    if (selected.length === 0) {
        btn.disabled = true;
        btn.textContent = 'PROMOTE TO EPIC';
    } else if (epics.length === 1 && nonEpics.length === 0) {
        // On-board epic management moved to the Epics tab — no lone-epic board action.
        btn.disabled = true;
        btn.textContent = 'PROMOTE TO EPIC';
    } else if (epics.length === 1 && nonEpics.length > 0) {
        btn.disabled = false;
        btn.textContent = `ADD ${nonEpics.length} TO EPIC`;
    } else if (epics.length === 0 && nonEpics.length === 1) {
        btn.disabled = false;
        btn.textContent = 'PROMOTE TO EPIC';
    } else if (epics.length === 0 && nonEpics.length > 1) {
        btn.disabled = false;
        btn.textContent = 'PROMOTE TO EPIC';
    } else {
        btn.disabled = true;
        btn.textContent = 'PROMOTE TO EPIC';
    }
}
```

**Key changes:**
- Line 6702: `'EPIC'` → `'PROMOTE TO EPIC'` (0 selected)
- Line 6706: `'EPIC'` → `'PROMOTE TO EPIC'` (lone epic)
- Line 6715: `` `EPIC (${nonEpics.length})` `` → `'PROMOTE TO EPIC'` (multiple non-epics)
- Line 6718: `'EPIC'` → `'PROMOTE TO EPIC'` (fallback)

## Verification Plan
1. Open the kanban board in VS Code.
2. With **no cards selected**, confirm the EPIC button reads `PROMOTE TO EPIC` and is disabled.
3. Select **one non-epic card**, confirm the button reads `PROMOTE TO EPIC` and is enabled.
4. Select **multiple non-epic cards**, confirm the button reads `PROMOTE TO EPIC` (not `EPIC (n)`) and is enabled.
5. Select **one epic + one non-epic**, confirm the button reads `ADD 1 TO EPIC` (unchanged).
6. Select **one epic alone**, confirm the button reads `PROMOTE TO EPIC` and is disabled.
7. Click the button with multiple non-epics selected — confirm the epic create modal still opens.
