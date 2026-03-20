# Delete button in ticket view does not work

## Goal
The delete button in the ticket view is like goggles, it does nothing.

## Source Analysis
- `src/webview/review.html:458-465`
  - The ticket view header already renders a `Delete` button with `id="delete-plan"`.
- `src/webview/review.html:952-958`
  - Clicking that button already triggers a browser-side confirmation, sets the ticket status to `Deleting plan...`, and posts `{ type: 'deletePlan', sessionId }`.
- `src/services/ReviewProvider.ts:278-292`
  - The review panel backend already handles `deletePlan` by calling `switchboard.deletePlanFromReview(sessionId, workspaceRoot)`.
  - On success it shows `Plan deleted.` and disposes the panel.
- `src/extension.ts:869-872`
  - `switchboard.deletePlanFromReview` is already registered and delegates to `taskViewerProvider.handleDeletePlanFromReview(...)`.
- `src/services/TaskViewerProvider.ts:1120-1121`
  - `handleDeletePlanFromReview(...)` is already just a wrapper around `_handleDeletePlan(...)`.
- `src/services/TaskViewerProvider.ts:5520-5644`
  - `_handleDeletePlan(...)` already performs the actual delete workflow:
    - resolve workspace root,
    - load runsheet,
    - prompt with VS Code warning modal,
    - delete mirror/brain/review files,
    - delete runsheet and dispatch log,
    - remove the plan from the Kanban DB,
    - update registry status,
    - refresh run sheets.
- `src/webview/implementation.html:1847-1852` and `src/services/TaskViewerProvider.ts:2507-2510`
  - There is already another delete entry point in the main sidebar that posts `deletePlan` directly to `TaskViewerProvider`, reusing the same `_handleDeletePlan(...)` implementation.
- **Clarification:** the bug is therefore not “implement plan deletion from scratch.” The bug surface is the ticket-view delete path failing to invoke or surface the existing delete flow correctly.

## Dependencies / Cross-Plan Conflict Scan
- `feature_plan_20260317_071108_add_move_controls_to_ticket_view.md`
  - Direct overlap. That plan introduced the ticket-view header lifecycle controls, including `Delete`.
  - This bug fix should repair the existing `Delete` action instead of redesigning the ticket header again.
- `feature_plan_20260317_165350_remove_view_plan_option_from_kanban_cards.md`
  - Related intent. That plan makes the ticket view the primary management surface for plans.
  - This delete fix should strengthen that ticket-view workflow without changing the remaining `Review` / `Complete` / `Send to Agent` controls.
- `feature_plan_20260317_065103_open_plans_should_opena_new_ticket.md`
  - Shared ticket-opening surface.
  - Plans opened directly into the ticket/review view should still be deletable through this same fixed path.
- `feature_plan_20260317_160347_review_functionality_in_tickets_is_not_reliable.md`
  - Shared `review.html` / `ReviewProvider.ts` transport surface.
  - That plan is about review-comment submission reliability; this one should stay scoped to the delete action path and not conflate the two transports.

## Proposed Changes

### Band A — Routine / Low Complexity
1. Reframe the work as a narrow ticket-view delete regression
   - **Files to inspect/fix:** `src/webview/review.html`, `src/services/ReviewProvider.ts`, `src/extension.ts`, `src/services/TaskViewerProvider.ts`
   - Do **not** plan a brand-new delete implementation.
   - Trace the existing chain end-to-end and fix the broken seam:
     - ticket button click,
     - review webview message bridge,
     - review-specific command registration,
     - shared delete backend.
   - **Clarification:** the desired outcome is that the ticket-view button correctly reaches the already-existing `_handleDeletePlan(...)` behavior.
2. Align the ticket-view path with the existing working delete semantics
   - Reuse `_handleDeletePlan(...)` as the single source of truth for actual deletion behavior.
   - If the ticket-view route currently diverges in a way that prevents deletion, simplify it so it matches the known-good sidebar delete path as closely as possible.
   - Avoid duplicating file deletion, DB cleanup, registry updates, or runsheet cleanup inside `ReviewProvider.ts`.
3. Make the ticket-view failure mode explicit instead of “nothing happens”
   - Ensure the ticket-view path surfaces a clear failure result if deletion is blocked, cancelled, or errors.
   - Preserve the current successful end state:
     - plan deleted,
     - Kanban state refreshed,
     - ticket panel closed.
   - **Clarification:** the plan should preserve the existing deletion semantics unless the root cause is specifically one of the review-panel bridge steps failing to execute them.
4. Add focused regression coverage for the review-panel delete path
   - Add a targeted regression test in the existing source-inspection style used by the repo’s review-ticket tests.
   - Cover the ticket-view path specifically, not just the generic sidebar delete path.
   - Reuse existing coverage such as `src/test/kanban-database-delete.test.js` for the lower-level DB deletion guarantee rather than rewriting that concern.

### Band B — Complex / Risky
- None.

## Verification Plan
1. Open a session-backed plan in the ticket/review view and confirm the `Delete` button is enabled for an active, non-completed plan.
2. Click `Delete` from the ticket view.
   - Confirm the existing confirmation flow appears.
   - Confirm the plan is actually deleted rather than merely showing a temporary status message.
3. After confirming deletion:
   - confirm the ticket panel closes,
   - confirm the plan disappears from the active Kanban board,
   - confirm the underlying plan/runsheet state is cleaned up as expected.
4. Cancel the delete flow at the confirmation step and verify nothing is deleted.
5. Confirm the existing non-ticket delete path in the main sidebar still works and continues to use the same backend delete behavior.
6. Run targeted validation:
   - `npm run compile`
   - `npm run compile-tests`
   - `src/test/kanban-database-delete.test.js`
   - the new focused regression test for the review ticket delete path.

## Open Questions
- None.

## Complexity Audit

### Band A — Routine
- Repair the existing ticket-view delete bridge instead of implementing deletion from scratch.
- Keep `_handleDeletePlan(...)` as the single source of truth for actual delete behavior.
- Add focused regression coverage for the review-panel delete path.

### Band B — Complex / Risky
- None.
