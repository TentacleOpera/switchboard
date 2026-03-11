# Fix Incorrect Agent Role Mapping in 'Plan Reviewed' Kanban Column

## Goal
Correct a visual bug in the Kanban board where the "PLAN REVIEWED" column incorrectly displays the assigned "Reviewer" agent's name instead of the "Planner" agent's name.

## User Review Required
> [!NOTE]
> This is purely a frontend UI fix. The backend routing for the "PLAN REVIEWED" column is already correctly mapping to the Planner, so task dispatches are unaffected.

## Complexity Audit
### Band A — Routine
- Change a single string value inside the frontend `columnToRole(col)` mapping dictionary in `kanban.html`.

### Band B — Complex / Risky
- None. This is an isolated, low-risk typo correction.

## Edge-Case Audit
- **Race Conditions**: None. This is a static UI mapping evaluated synchronously when rendering the board.
- **Security**: None.
- **Side Effects**: The text under the "Plan Reviewed" column will instantly update to match the "Planner" dropdown selection from the sidebar setup menu.

## Adversarial Synthesis
### Grumpy Critique
You're changing the frontend mapping, but what about the backend?! Is this really the only place this mapping exists? If the frontend was wrong, the backend `KanbanProvider.ts` probably has the exact same broken mapping! Did you even check `_columnToRole` in the backend before declaring this a "simple UI fix"?

### Balanced Response
Grumpy raises a valid concern about duplicated logic between the frontend and backend. However, a review of `src/services/KanbanProvider.ts` confirms that the backend `_columnToRole(column: string)` function is actually correct: it safely maps `case 'PLAN REVIEWED': return 'planner';`. The bug is completely isolated to the webview's JavaScript implementation in `kanban.html`. Fixing just the frontend is the correct and complete solution.

## Proposed Changes
### Kanban Webview
#### [MODIFY] `src/webview/kanban.html`
- Locate the `columnToRole(col)` function inside the webview's `<script>` block.
- Update the `mapping` object to correctly associate `'PLAN REVIEWED'` with `'planner'` instead of `'reviewer'`.

## Verification Plan
### Manual Testing
1. Open the Switchboard setup menu in the sidebar.
2. Assign two completely different agents to the Planner and Reviewer roles (e.g., set Planner to `Gemini CLI` and Reviewer to `Codex CLI`).
3. Open the CLI-BAN view.
4. Verify that the sub-label under the "Plan Reviewed" column correctly reads `GEMINI CLI` (matching the Planner), rather than `CODEX CLI`.

***

# Appendix: Implementation Patch

Apply the following patch to `src/webview/kanban.html`:

```diff
--- src/webview/kanban.html
+++ src/webview/kanban.html
@@ -... +... @@
 function columnToRole(col) {
     const mapping = {
         'CREATED': 'planner',
-        'PLAN REVIEWED': 'reviewer',
+        'PLAN REVIEWED': 'planner',
         'CODED': currentCodedTarget,
         'CODE REVIEWED': 'reviewer'
     };
     return mapping[col] || null;
 }
```

## Reviewer-Executor Pass (2026-03-11)

### Findings Summary
- CRITICAL: None.
- MAJOR: None.
- NIT: `src/webview/kanban.html` contains unrelated in-flight UI/layout edits that are outside this plan's scope.

### Plan Requirement Check
- [x] Frontend `columnToRole(col)` maps `'PLAN REVIEWED'` to `'planner'`.
- [x] Backend `KanbanProvider._columnToRole()` already maps `'PLAN REVIEWED'` to `'planner'`.

### Fixes Applied
- No additional code fix was required in this pass. The planned implementation was already correct.

### Files Changed in This Reviewer Pass
- `C:\Users\patvu\Documents\GitHub\switchboard\.switchboard\plans\feature_plan_20260311_135800_fix_planner_name_in_kanban_view.md` (updated with review execution results).

### Validation Results
- `npx tsc -p . --noEmit`: PASS (exit code `0`).

### Remaining Risks
- Manual webview verification is still needed to confirm the "Plan Reviewed" sub-label tracks the current Planner selection at runtime.
- The working tree includes unrelated modifications in `src/webview/kanban.html`; those were intentionally not altered in this reviewer pass.
