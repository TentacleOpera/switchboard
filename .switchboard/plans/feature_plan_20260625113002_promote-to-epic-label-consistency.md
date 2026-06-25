# Promote to Epic Button Label Consistency

## Goal

Make the kanban EPIC action button (`#btn-epic-action`) display `PROMOTE TO EPIC` consistently across all non-epic-selection states, eliminating the inconsistent labels (`EPIC`, `EPIC (n)`) that currently appear depending on selection count.

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

Additionally, the static HTML label on line 2515 (`>EPIC</button>`) shows `EPIC` before JavaScript runs and overwrites it via `updateEpicActionButton()`. This should also be updated for consistency.

### Desired Behavior
- **0 cards selected** → `PROMOTE TO EPIC` (disabled)
- **1 non-epic card** → `PROMOTE TO EPIC` (enabled)
- **Multiple non-epic cards** → `PROMOTE TO EPIC` (enabled)
- **1 epic + non-epic cards** → `ADD n TO EPIC` (enabled) — *unchanged, this is a different action*
- **1 epic alone** → `PROMOTE TO EPIC` (disabled) — *label consistent, action disabled*

## Metadata
- **Tags:** frontend, ui, ux, bugfix
- **Complexity:** 2/10

## User Review Required
No. This is a pure label-text consistency fix with no behavioral, backend, or data-layer changes. The click handler dispatches on selection composition (`epics.length` / `nonEpics.length`), not on the button's `textContent`, so changing labels has zero dispatch impact.

## Complexity Audit

### Routine
- Changing `textContent` string literals in a single function (`updateEpicActionButton`, lines 6694–6720).
- Changing the static HTML label on line 2515 from `EPIC` to `PROMOTE TO EPIC`.
- No backend, DB, file-system, or migration involvement.
- No new patterns — reuses the existing branch structure exactly.

### Complex / Risky
- None

## Edge-Case & Dependency Audit

- **Race Conditions:** None. `updateEpicActionButton()` is called synchronously after every selection change (card click, clear, drag-end) and during board render (line 5248). There is no async path that could leave the label stale.
- **Security:** None. No user input, no data exfiltration, no auth surface.
- **Side Effects:** The `ADD n TO EPIC` branch (1 epic + non-epics) must remain unchanged — it triggers `addSubtaskToEpic`, a different action. The click handler (lines 9322–9362) dispatches based on `epics.length` and `nonEpics.length`, NOT on the button label. Changing the label text does not affect dispatch logic.
- **Dependencies & Conflicts:** The `data-tooltip` attribute on the button (line 2515) says "Convert selected plans to epic or manage existing epic" — this remains accurate. No other code references the button's `textContent` for logic decisions (confirmed via grep: only 3 references to `btn-epic-action` exist — the HTML definition, the function, and the click handler).

## Dependencies
- None

## Adversarial Synthesis

Key risks: (1) The static HTML label on line 2515 is a pre-JS flash of `EPIC` that the original plan missed — must be updated alongside the JS. (2) Accidentally altering the `ADD n TO EPIC` branch would break the subtask-add action. Mitigations: Update both the static HTML and all JS branches in one pass; leave the `ADD ${nonEpics.length} TO EPIC` line untouched; verify dispatch logic is label-independent (confirmed).

## Proposed Changes

### `src/webview/kanban.html` — Static HTML label (line 2515)

Change the initial button text from `EPIC` to `PROMOTE TO EPIC` so it matches before JavaScript runs:

```html
<button class="strip-btn is-teal" id="btn-epic-action" data-tooltip="Convert selected plans to epic or manage existing epic" disabled>PROMOTE TO EPIC</button>
```

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
- Line 2515: `>EPIC</button>` → `>PROMOTE TO EPIC</button>` (static HTML, pre-JS flash)
- Line 6702: `'EPIC'` → `'PROMOTE TO EPIC'` (0 selected)
- Line 6706: `'EPIC'` → `'PROMOTE TO EPIC'` (lone epic)
- Line 6715: `` `EPIC (${nonEpics.length})` `` → `'PROMOTE TO EPIC'` (multiple non-epics)
- Line 6718: `'EPIC'` → `'PROMOTE TO EPIC'` (fallback)

**Unchanged:**
- Line 6709: `` `ADD ${nonEpics.length} TO EPIC` `` — this is the subtask-add action, not a promote action.

## Verification Plan

### Automated Tests
No automated tests required — this is a pure UI label change with no logic dispatch dependency. The test suite will be run separately by the user.

### Manual Verification
1. Open the kanban board in VS Code.
2. With **no cards selected**, confirm the EPIC button reads `PROMOTE TO EPIC` and is disabled.
3. Select **one non-epic card**, confirm the button reads `PROMOTE TO EPIC` and is enabled.
4. Select **multiple non-epic cards**, confirm the button reads `PROMOTE TO EPIC` (not `EPIC (n)`) and is enabled.
5. Select **one epic + one non-epic**, confirm the button reads `ADD 1 TO EPIC` (unchanged).
6. Select **one epic alone**, confirm the button reads `PROMOTE TO EPIC` and is disabled.
7. Click the button with multiple non-epics selected — confirm the epic create modal still opens.
8. Reload the webview and observe the button **before** interacting — confirm it reads `PROMOTE TO EPIC` (not `EPIC`) from the static HTML.

## Recommendation
Complexity is 2/10 → **Send to Intern**.
