# Fix Kanban Card Prompt Labels to Respect Custom Columns

## Goal

Change the Kanban card copy-prompt button labels from source-based to destination-based logic so they correctly reflect the next column's role, including custom columns.

## Metadata

- **Tags:** frontend, UI, bugfix
- **Complexity:** 2

## User Review Required

- Confirm that custom columns should always display **"Copy advance prompt"** regardless of whether their `dragDropMode` is `cli` or `prompt`.
- Confirm whether a card in `CODE REVIEWED` advancing to `ACCEPTANCE TESTED` should remain **"Copy advance prompt"** (current implied behavior) or receive a new **"Copy testing prompt"** label.

## Complexity Audit

### Routine
- Single-file conditional refactor in `src/webview/kanban.html`.
- Reuses existing `getNextColumn()` and `columnDefinitions` in scope.
- No backend coordination; no new dependencies.

### Complex / Risky
- None

## Edge-Case & Dependency Audit

- **Race Conditions:** None. Label is computed synchronously during card HTML generation inside `renderBoard`.
- **Security:** None. No user input is evaluated; only `columnDefinitions` properties are read.
- **Side Effects:**
  - If the next visible column is a custom column, the label changes from a hardcoded built-in label to `"Copy advance prompt"`.
  - If a built-in column is hidden (e.g., `INTERN CODED`), `getNextColumn` skips it and labels reflect the next *visible* column. This is desired behavior.
  - `CONTEXT GATHERER` (`role: 'gatherer'`) does not match any explicit role mapping and falls back to `"Copy advance prompt"`. It has `dragDropMode: 'disabled'`, so cards do not typically advance there.
- **Dependencies & Conflicts:** None. No other open plans touch `kanban.html:3996-4003`.

## Dependencies

- None

## Adversarial Synthesis

Key risks: (1) `CODED_AUTO` synthetic column not being normalized before `getNextColumn`, creating a hidden dependency on `card.column` never being `'CODED_AUTO'`; (2) no automated regression test for label logic, raising reversion risk. Mitigations: mirror the click handler's `CODED_AUTO`→real-column fallback in the label logic, and extract the label function for a minimal unit test.

## Problem

Kanban card prompt button labels in `src/webview/kanban.html` are hardcoded based on the **source column**, not the **actual next column**. When a custom or non-standard built-in column (e.g. `RESEARCHER`) is placed between `CREATED` and `PLAN REVIEWED`, cards in `CREATED` still display **"Copy planning prompt"** even though the copied prompt targets the researcher role.

Current hardcoded logic (`kanban.html:3996-4003`):
```javascript
let copyLabel = 'Copy Prompt';
if (card.column === 'CREATED') {
    copyLabel = 'Copy planning prompt';
} else if (card.column === 'PLAN REVIEWED') {
    copyLabel = 'Copy coder prompt';
} else if (card.column === 'LEAD CODED' || card.column === 'CODER CODED' || card.column === 'INTERN CODED') {
    copyLabel = 'Copy review prompt';
}
```

## Root Cause

The label logic assumes a fixed pipeline (`CREATED` → `PLAN REVIEWED` → `CODED` → `CODE REVIEWED`). It does not query `getNextColumn()` or inspect the next column's definition to determine what the prompt will actually target.

## Desired Behavior

- Labels must reflect the **destination** column's role/kind, not the source column.
- If the next column is a **custom column** (`kind: 'custom-user'` or `kind: 'custom-agent'`), the label must be **"Copy advance prompt"**.
- For built-in columns, map the next column to a specific label where known; fall back to **"Copy advance prompt"** for unmapped built-in roles.

## Proposed Changes

### `src/webview/kanban.html`

- **Context:** Card action buttons are built inline during `renderBoard` (`kanban.html:3991-4005`). The copy-prompt button label is currently derived from `card.column` (source), but the prompt that gets copied targets the *next* column (destination).
- **Logic:** Query `getNextColumn(card.column)` to resolve the destination column ID, look up its definition in `columnDefinitions`, and map `kind`/`role` to the appropriate label. Defensively normalize `CODED_AUTO` to a real coder column before calling `getNextColumn`, matching the existing click-handler pattern at `kanban.html:3558`.
- **Implementation:** Replace the source-based `if/else` block at `kanban.html:3996-4003` with:

```javascript
let copyLabel = 'Copy Prompt';
// Defensively normalize CODED_AUTO so getNextColumn works on a real column ID
const sourceColumn = (card.column === 'CODED_AUTO')
    ? (columnDefinitions.find(d => d.kind === 'coded')?.id || 'LEAD CODED')
    : card.column;
const nextColId = getNextColumn(sourceColumn);
if (nextColId) {
    const nextDef = columnDefinitions.find(d => d.id === nextColId);
    if (nextDef) {
        const isCustom = nextDef.kind === 'custom-user' || nextDef.kind === 'custom-agent';
        if (isCustom) {
            copyLabel = 'Copy advance prompt';
        } else if (nextDef.role === 'planner' || nextDef.id === 'PLAN REVIEWED') {
            copyLabel = 'Copy planning prompt';
        } else if (['lead', 'coder', 'intern'].includes(nextDef.role)) {
            copyLabel = 'Copy coder prompt';
        } else if (nextDef.role === 'reviewer' || nextDef.id === 'CODE REVIEWED') {
            copyLabel = 'Copy review prompt';
        } else {
            copyLabel = 'Copy advance prompt';
        }
    }
}
```

- **Edge Cases:**
  - `nextDef` missing from `columnDefinitions` (should not happen unless backend/front-end desync): falls back to `'Copy Prompt'`.
  - `nextDef.role` is `undefined`/omitted: safely falls through to `'Copy advance prompt'` because `['lead', 'coder', 'intern'].includes(undefined)` is `false`.
  - Hidden coder columns: `getNextColumn` operates on the filtered `columns` array, so labels reflect the next *visible* stage.

### No Backend Changes Required

`KanbanProvider._generatePromptForColumn()` already correctly resolves prompts using `_getNextColumnId()` and the destination column's role. Only the **frontend label** is wrong.

## Verification Plan

### Manual Tests

1. Configure a workspace with a custom column (e.g. `my_custom`) between `CREATED` and `PLAN REVIEWED`.
2. Open the Switchboard Kanban panel.
3. Verify that a card in `CREATED` shows **"Copy advance prompt"** (not "Copy planning prompt").
4. Verify that a card in `PLAN REVIEWED` with `LEAD CODED` as the next column still shows **"Copy coder prompt"**.
5. Verify that a card in `LEAD CODED` with `CODE REVIEWED` as the next column still shows **"Copy review prompt"**.
6. Remove the custom column and verify standard pipeline labels restore correctly.

### Automated Tests

- Add a minimal unit test extracting the label resolution logic (or a DOM assertion in an existing webview test) to prevent regression. The test should assert:
  - `CREATED` → custom column → `"Copy advance prompt"`
  - `CREATED` → `PLAN REVIEWED` → `"Copy planning prompt"`
  - `PLAN REVIEWED` → `LEAD CODED` → `"Copy coder prompt"`
  - `LEAD CODED` → `CODE REVIEWED` → `"Copy review prompt"`
  - `CODED_AUTO` synthetic card → next real column resolved correctly

## Files Changed

- `src/webview/kanban.html` (lines 3996–4018)

## Implementation Notes

- Replaced the source-based `if/else` block with destination-based logic that queries `getNextColumn()` and inspects `columnDefinitions`.
- `CODED_AUTO` is normalized to a real coder column before calling `getNextColumn()`, mirroring the existing click-handler pattern at line 3558.
- Custom columns (`kind: 'custom-user'` or `kind: 'custom-agent'`) correctly receive the label **"Copy advance prompt"**.
- Built-in columns map by `role` with `id` fallbacks: `planner`/`PLAN REVIEWED` → "Copy planning prompt", `lead`/`coder`/`intern` → "Copy coder prompt", `reviewer`/`CODE REVIEWED` → "Copy review prompt".
- Unmapped roles fall back to "Copy advance prompt".

## Validation

- `getNextColumn` and `columnDefinitions` are in scope (confirmed at lines 3200 and 2876).
- The `CODED_AUTO` normalization pattern matches the existing backendColumn fallback at line 3558.
- No other files modified; no backend changes required.

## Recommendation

Implemented. Ready for user commit.
