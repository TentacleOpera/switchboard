# Dynamic Copy Prompt Label for Planning Kanban Cards

## Goal
Update the 'copy prompt' button label on kanban plan cards in planning.html to use dynamic labels (e.g., "Copy planning prompt", "Copy coder prompt") based on the destination column, matching the pattern used in kanban.html.

### Problem
The kanban plan cards in planning.html currently use a static "Copy Prompt" label, while kanban.html uses dynamic labels that reference the destination column (e.g., "Copy planning prompt" when advancing to PLAN REVIEWED, "Copy coder prompt" when advancing to CODER CODED). This creates inconsistency between the two views.

### Background
- In `kanban.html` (lines 4867-4896), the copy label is determined dynamically by:
  1. Getting the next column using `getNextColumn(sourceColumn)` (line 3796)
  2. Checking the next column's role or ID
  3. Setting the label based on the role:
     - `planner` or `PLAN REVIEWED` → "Copy planning prompt"
     - `lead`, `coder`, or `intern` → "Copy coder prompt"
     - `reviewer` or `CODE REVIEWED` → "Copy review prompt"
     - Custom columns → "Copy advance prompt"
     - Default → "Copy advance prompt"

- In `planning.js`, a helper function `_getCopyLabel(sourceColumn)` already exists at lines 3732-3754. It derives the next column from `_kanbanAvailableColumns` (which is sorted by `order` and contains `{id, label, kind, order}`) and applies the same role/kind/ID logic.
- The card rendering at lines 4025-4028 already calls `_getCopyLabel(plan.column)` and stores the result in `data-copy-label`.
- The reset logic at lines 2530-2542 already reads `btn.dataset.copyLabel` when reverting the button text after copy.
- **Data-contract gap:** `PlanningPanelProvider.ts` (line 1588) strips the `role` field when building the `mergedColumns` payload, sending only `{id, label, kind, order}`. Consequently, `_getCopyLabel` silently falls through to "Copy advance prompt" for transitions to coder columns (`LEAD CODED`, `CODER CODED`, `INTERN CODED`) because `nextDef.role` is `undefined`.

## Metadata
**Tags:** ui, frontend
**Complexity:** 3

## User Review Required
No

## Complexity Audit

### Routine
- Update a single helper function with an additional fallback condition (`kind === 'coded'`)
- Add a regression test file mirroring the existing kanban.html test
- Update plan documentation and line-number references

### Complex / Risky
- None

## Edge-Case & Dependency Audit

### Race Conditions
- None. Label computation is synchronous and deterministic during render.

### Security
- None. No new data paths, trust boundaries, or user input parsing.

### Side Effects
- Button label change is UI-only; no state mutation or external side effects.

### Dependencies & Conflicts
- `src/services/PlanningPanelProvider.ts` currently strips `role` from the `columns` payload sent to the webview. The fix should work around this by using the existing `kind` field rather than requiring a backend change, keeping the scope localized.
- Must not regress the existing `kanban-card-prompt-labels-regression.test.js` for `kanban.html`.

## Dependencies
- None

## Adversarial Synthesis
Key risks: the original plan described already-implemented scaffolding (helper, rendering hook, reset logic) while missing the silent label-failure caused by the missing `role` field in `_kanbanAvailableColumns`. Mitigations: add a `kind === 'coded'` fallback in `_getCopyLabel` to cover coder columns without a backend change, add a `planning.js` regression test, and refresh all stale line-number references.

## Proposed Changes

### Current Implementation Status
The following steps from the original plan are **already implemented** in `src/webview/planning.js`:
1. `_getCopyLabel(sourceColumn)` helper exists at lines 3732-3754.
2. Card rendering already calls `_getCopyLabel` and uses `data-copy-label` at lines 4025-4028.
3. Reset logic already reads `dataset.copyLabel` at lines 2530-2542.

The remaining bug is that `_getCopyLabel` relies on `nextDef.role`, which is absent from the webview payload.

### `src/webview/planning.js`
- **Context:** The `_getCopyLabel` function at lines 3732-3754 determines the copy label by inspecting the next column definition. It currently checks `nextDef.role` for `'planner'`, `'lead'`, `'coder'`, `'intern'`, and `'reviewer'`.
- **Logic / Implementation:** Add a fallback check for `nextDef.kind === 'coded'` before the final default case. Since all built-in coder columns (`LEAD CODED`, `CODER CODED`, `INTERN CODED`) have `kind: 'coded'`, this reliably maps them to `"Copy coder prompt"` even when `role` is missing.
- **Edge Cases:**
  - Custom user/agent columns (`kind: 'custom-user'` or `kind: 'custom-agent'`) already map to `"Copy advance prompt"`.
  - The last column (no next column) already returns `"Copy Prompt"` because `idx >= cols.length - 1` triggers an early return.
  - Plans without `sessionId` do not render the button; unaffected.

### `src/test/planning-copy-labels-regression.test.js` (New)
- **Context:** The existing `kanban-card-prompt-labels-regression.test.js` validates `kanban.html` label logic. There is no equivalent test for `planning.js`.
- **Logic / Implementation:** Create a new test that:
  1. Reads `src/webview/planning.js` and extracts the `_getCopyLabel` function body.
  2. Executes it against mock `_kanbanAvailableColumns` arrays (standard and custom columns).
  3. Asserts expected labels for transitions: `CREATED` → `PLAN REVIEWED`, `PLAN REVIEWED` → `LEAD CODED`, `CODER CODED` → `CODE REVIEWED`, and custom-column cases.
- **Edge Cases:** Test should verify behavior when `role` is absent (current payload format) to ensure the `kind` fallback is active.

## Verification Plan

### Automated Tests
- Create and run `src/test/planning-copy-labels-regression.test.js`.
- Verify existing `src/test/kanban-card-prompt-labels-regression.test.js` still passes (no `kanban.html` changes).
- Manually inspect the planning kanban view to confirm labels update correctly for plans in each column.

### Manual Verification
- Open the Planning panel and verify that a plan in `CREATED` shows "Copy planning prompt" (next column `PLAN REVIEWED`).
- Verify a plan in `PLAN REVIEWED` shows "Copy coder prompt" (next column `LEAD CODED` / `CODER CODED` / `INTERN CODED`).
- Verify a plan in `CODER CODED` shows "Copy review prompt" (next column `CODE REVIEWED`).
- Verify a plan in a custom column shows "Copy advance prompt".
- Click a copy button, wait for the reset, and confirm the label reverts to the dynamic value (not the static "Copy Prompt").

## Files to Modify
- `src/webview/planning.js` (update `_getCopyLabel` fallback)
- `src/test/planning-copy-labels-regression.test.js` (new)

## Original Implementation Plan (Preserved for Reference)
> ### 1. Add helper function to determine copy label
> In `planning.js`, add a function to determine the copy label based on the source column and available columns.
>
> ### 2. Update kanban plan card rendering
> Modify the card rendering logic in `planning.js` to call the helper function and use the dynamic label.
>
> ### 3. Update button reset logic
> Ensure the button reset logic uses the stored copy label from the data attribute.

**Recommendation:** Send to Intern

## Review Findings

Review completed: the `_getCopyLabel` helper in `planning.js` was missing the `kind === 'coded'` fallback identified in the plan, so coder columns still silently fell through to "Copy advance prompt." Added `|| nextDef.kind === 'coded'` at line 3745 and created the missing `src/test/planning-copy-labels-regression.test.js`. Both the new planning test and the existing kanban test pass. No regressions detected. Remaining risk: the dead `role` checks in `_getCopyLabel` (planner/reviewer) are misleading but harmless since the `id` fallbacks cover them.
