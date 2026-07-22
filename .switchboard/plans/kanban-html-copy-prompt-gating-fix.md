# kanban.html Copy-Prompt Button Gating Fix

## Metadata
**Complexity:** 4
**Tags:** frontend, ui, bugfix
**Project:** Browser Switchboard

## Goal

Fix the copy-prompt button in `kanban.html` (the board view) so it does not render when a card is at the last actionable column before COMPLETED, and so its label is not hardcoded to `CODE REVIEWED` but derives dynamically from the actual next column.

### Problem Analysis & Root Cause

**File:** `src/webview/kanban.html`

**Root cause:** The copy-prompt button is rendered unconditionally at line 6298:
```javascript
primaryActionBtn = `<button class="card-btn copy" ...>${copyLabel}</button>`;
```
The label derivation (lines 6278-6296) only runs inside `if (nextColId)`, but the button itself is always created. When `getNextColumn(sourceColumn)` returns `null` (card is at the last column), the button still renders with the default label `'Copy Prompt'` — which is misleading because there is no next stage to copy a prompt for.

Additionally, the label logic hardcodes specific column IDs (`CODE REVIEWED`, `PLAN REVIEWED`) and roles (`planner`, `reviewer`, `lead`, `coder`, `intern`) instead of deriving generically from the next column's `kind` and `role`. This means custom column configurations produce wrong labels, and the logic doesn't adapt when columns are added, removed, or reordered.

The `getNextColumn` function (lines 4902-4906) correctly returns `null` when the card is at the last column — the bug is purely that the button rendering doesn't check this return value.

### Background Context

- `kanban.html` is the pure board view (no preview panel, no meta bar). Each card renders its own action buttons inline.
- The copy-prompt button copies a dispatch prompt for the **next** stage's agent role. If there is no next stage, the button has no valid action.
- `getNextColumn(col)` (line 4902) returns the next column ID or `null` if at the end.
- `columnDefinitions` (populated from backend) contains `kind`, `role`, `id` for each column.
- The AUTOCODE bucket special-case (lines 6272-6276) remaps `CODED_AUTO`/coded IDs to the last visible coded column before computing next — this logic is correct and should be preserved.

## Changes

### 1. Gate button rendering on `nextColId`

**File:** `src/webview/kanban.html` (lines 6265-6298)

Replace the unconditional button rendering with a conditional:
```javascript
const nextColId = getNextColumn(sourceColumn);
if (nextColId) {
    const nextDef = columnDefinitions.find(d => d.id === nextColId);
    if (nextDef) {
        // derive label from nextDef.kind / nextDef.role
        copyLabel = _deriveCopyPromptLabel(nextDef);
    }
    primaryActionBtn = `<button class="card-btn copy" ...>${copyLabel}</button>`;
} else {
    primaryActionBtn = ''; // no next column — no copy-prompt button
}
```

When `nextColId` is `null`, `primaryActionBtn` becomes an empty string — no button is rendered.

### 2. Generalize label derivation

**File:** `src/webview/kanban.html` (lines 6278-6296)

Extract the label logic into a helper function `_deriveCopyPromptLabel(nextDef)` that derives from `kind` and `role` without hardcoding specific column IDs:

```javascript
function _deriveCopyPromptLabel(nextDef) {
    const isCustom = nextDef.kind === 'custom-user' || nextDef.kind === 'custom-agent';
    if (isCustom) return 'Copy advance prompt';
    if (nextDef.kind === 'created' || nextDef.role === 'planner') return 'Copy planning prompt';
    if (nextDef.kind === 'coded' || ['lead', 'coder', 'intern'].includes(nextDef.role)) return 'Copy coder prompt';
    if (nextDef.kind === 'review' || nextDef.role === 'reviewer') return 'Copy review prompt';
    if (nextDef.kind === 'reviewed' && nextDef.role === 'tester') return 'Copy acceptance test prompt';
    if (nextDef.kind === 'completed') return null; // terminal — no button
    return 'Copy advance prompt'; // fallback for unknown kinds
}
```

This replaces the hardcoded `if (plan.column === 'CODE REVIEWED')` check with a `kind === 'reviewed' && role === 'tester'` check, which only matches ACCEPTANCE TESTED (or any custom column with `kind: 'reviewed'` and `role: 'tester'`). If no such column exists in the board, the label naturally never appears because `getNextColumn` won't return a tester column that isn't there.

### 3. Preserve the AUTOCODE bucket special-case

The existing logic at lines 6272-6276 (remapping `CODED_AUTO`/coded IDs to the last visible coded column) must be preserved. This ensures cards in the collapsed AUTOCODE bucket compute their next column correctly (skipping over the coded lanes they're already past).

## Verification Plan

1. **Card at CREATED** (next is RESEARCHER or PLAN REVIEWED): button shows "Copy planning prompt" (or "Copy research prompt" if RESEARCHER is next).
2. **Card at PLAN REVIEWED** (next is a coded column): button shows "Copy coder prompt".
3. **Card at CODE REVIEWED** with ACCEPTANCE TESTED column present: button shows "Copy acceptance test prompt".
4. **Card at CODE REVIEWED** with NO ACCEPTANCE TESTED column (next is TICKET UPDATER or COMPLETED): button shows the correct label for the actual next column, or no button if next is COMPLETED.
5. **Card at the last column before COMPLETED** (e.g., ACCEPTANCE TESTED if TICKET UPDATER is absent, or TICKET UPDATER if it's last): **no copy-prompt button rendered.**
6. **Card in AUTOCODE bucket**: button correctly derives from the column after the coded lanes.
7. **Completed card**: still shows Recover button (unchanged).
