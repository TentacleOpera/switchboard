# Send to agent button should ignore trigger setting

## Goal
In the ticket view, there is a button 'send to agent. when i press this, it should ALWAYS trigger the cli agent action, regardless of whether the cli trigger setting is on or off on the kanban board. This setting only applies to kanban board actions, not anything else. Also ensure that the trigger is not ruining any other functions, like the sideboard buttons or chat workflows. 

## Source Analysis
- `src/webview/review.html`
  - The ticket view posts `sendToAgent` directly from the review panel header button.
  - This is a ticket-view action, not a Kanban drag/drop action.
- `src/services/ReviewProvider.ts`
  - `sendToAgent` in the review panel calls the `switchboard.reviewSendToAgent` command.
  - That means the ticket-view button already has its own command path and does not need to inherit Kanban webview gating behavior.
- `src/extension.ts`
  - `switchboard.reviewSendToAgent` delegates to `taskViewerProvider.sendReviewTicketToNextAgent(sessionId)`.
- `src/services/TaskViewerProvider.ts`
  - `sendReviewTicketToNextAgent()` currently checks `this._kanbanProvider?.cliTriggersEnabled`.
  - If CLI triggers are off, it silently calls `handleKanbanForwardMove(...)` and skips dispatch, returning `Moved to ... CLI triggers are off, so no agent was dispatched.`
  - This is the direct cause of the bug: a Kanban-only board toggle is leaking into the ticket-view button behavior.
- `src/services/KanbanProvider.ts`
  - `_cliTriggersEnabled` is stored in Kanban provider state and is used to gate Kanban webview message handlers like `triggerAction` and `triggerBatchAction`.
  - The original CLI toggle plan explicitly scoped this setting to Kanban board actions, not other entry points.
- Cross-surface impact
  - Current search indicates the CLI trigger toggle is referenced in KanbanProvider and this one ticket-view send method, so the leak appears localized rather than systemic.

## Proposed Changes

### Band A — Routine / Low Complexity
1. Remove Kanban-only trigger gating from the ticket-view send path
   - **File:** `src/services/TaskViewerProvider.ts`
   - **Method:** `sendReviewTicketToNextAgent(sessionId)`
   - Delete the branch that checks `this._kanbanProvider?.cliTriggersEnabled` and falls back to `handleKanbanForwardMove(...)`.
   - The ticket-view `Send to Agent` button should always attempt the real agent dispatch path for the resolved next column.
2. Keep the existing target resolution and dispatch behavior
   - Preserve:
     - current-column lookup,
     - next-column resolution,
     - planner instruction mapping (`improve-plan`),
     - `handleKanbanTrigger(...)` dispatch behavior,
     - existing “already in final column” guard.
   - **Clarification:** this plan changes only whether the Kanban CLI-trigger toggle is consulted; it does not change what column/role the ticket button sends to.
3. Verify that Kanban-only gating remains Kanban-only
   - Confirm `_cliTriggersEnabled` still applies to:
     - Kanban drag/drop forward dispatch,
     - Kanban batch trigger actions,
     - other Kanban board trigger handlers.
   - Confirm it does **not** affect:
     - ticket-view `Send to Agent`,
     - sidebar action buttons,
     - chat/workflow dispatch paths.
4. Add focused regression coverage
   - Add a regression test proving ticket-view send ignores the Kanban CLI trigger toggle.
   - The test should assert the ticket-view send path no longer contains the `_kanbanProvider?.cliTriggersEnabled` early-exit behavior.

### Band B — Complex / Risky / High Complexity
- None.

## Verification Plan
1. Turn the Kanban `CLI Triggers` toggle OFF.
2. Open a ticket and click `Send to Agent`.
   - Confirm the plan dispatches to the next agent instead of silently moving columns without sending.
3. Repeat with `CLI Triggers` ON.
   - Confirm ticket-view `Send to Agent` still dispatches normally.
4. From the Kanban board, move a card forward with `CLI Triggers` OFF.
   - Confirm Kanban drag/drop behavior remains unchanged and still suppresses board-triggered CLI dispatch.
5. Trigger a non-Kanban dispatch path such as an existing sidebar action button.
   - Confirm it still behaves independently of the Kanban toggle.
6. Run existing validation:
   - `npm run compile`
   - `npm run compile-tests`
   - targeted regression test for the ticket-view send path.

## Open Questions
- None.

## Dependencies / Cross-Plan Conflict Scan
- `feature_plan_20260316_064358_have_cli_trigger_switch_at_top_of_kanban.md`
  - Direct overlap. That plan defined the CLI trigger toggle as a Kanban board control for drag/drop actions.
  - This fix should reinforce that original scope boundary rather than broadening the toggle.
- `feature_plan_20260317_071108_add_move_controls_to_ticket_view.md`
  - Direct overlap. That plan introduced the ticket-view `Send to Agent` button and originally suggested it should respect `_cliTriggersEnabled`.
  - This plan is effectively the corrective follow-up: the button exists, but its dispatch semantics need to be narrowed to the intended ticket-view behavior.
- `feature_plan_20260317_160347_review_functionality_in_tickets_is_not_reliable.md`
  - Shared `review.html` / ticket-view surface.
  - Changes here should avoid disturbing review-mode behavior, comment flow, or other ticket header actions.
- `feature_plan_20260317_064850_check_implementation_of_backwards_move_cards_and_cli_trigger_switch.md`
  - Related CLI-trigger integration audit.
  - That work focused on keeping Kanban drag/drop and manual board correction behavior clean; this plan should keep that behavior intact while exempting the ticket-view button.

## Complexity Audit

### Band A — Routine
- Remove the Kanban CLI-trigger toggle check from `sendReviewTicketToNextAgent()`.
- Keep the existing next-column/role resolution and normal dispatch path unchanged.
- Verify the CLI toggle remains scoped to Kanban board actions only.
- Add a focused regression test for ticket-view send behavior.

### Band B — Complex / Risky
- None.
