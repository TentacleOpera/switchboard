# Remove view plan option from kanban cards

## Goal
The 'view plan' option in the kanban cards is useless as the ticket view is better, so the icon should be removed. 

## Source Analysis
- `src/webview/kanban.html:794-798`
  - The Kanban board binds a dedicated click handler for `.card-btn.view` that posts `{ type: 'viewPlan', sessionId, workspaceRoot }`.
- `src/webview/kanban.html:843-857`
  - `createCardHtml(card)` renders the card action cluster. The current button set is `Copy Prompt`, `View`, `Review`, and `Complete`.
- `src/services/KanbanProvider.ts:1101-1104`
  - The Kanban webview backend still handles a `viewPlan` message and forwards it to `switchboard.viewPlanFromKanban`.
- `src/extension.ts:879-882`
  - `switchboard.viewPlanFromKanban` is registered as a Kanban-specific command that delegates to `taskViewerProvider.handleKanbanViewPlan(...)`.
- `src/services/TaskViewerProvider.ts:1158-1160`
  - `handleKanbanViewPlan(...)` is just a thin wrapper around `_handleViewPlan(...)`.
- `src/services/TaskViewerProvider.ts:4977-4984`
  - `_handleViewPlan(...)` opens the plan file in the editor.
- `src/webview/implementation.html:2059-2067` and `src/services/TaskViewerProvider.ts:2492-2495`
  - There is also a non-Kanban `viewPlan` flow used when switching sessions in the main sidebar. That flow should remain intact.

## Dependencies / Cross-Plan Conflict Scan
- `feature_plan_20260313_071652_change_the_view_and_complete_kanban_card_buttons_to_icons.md`
  - Direct overlap. That plan introduced the current icon-button layout and specifically kept a `View` icon in the card action row.
  - This plan should remove only the `View` icon/button path and leave the `Review` and `Complete` actions in the current icon-button pattern.
- `feature_plan_20260317_071108_add_move_controls_to_ticket_view.md`
  - Related intent. That plan makes the ticket view the primary lifecycle surface, which is the reason removing the redundant Kanban `View` action is now safe.
  - This plan should not disturb ticket-view actions such as `Send to Agent`, `Delete Plan`, or `Complete`.
- `feature_plan_20260317_065103_open_plans_should_opena_new_ticket.md`
  - Related plan-opening surface. The main/ticket review experience is now the preferred place to work with a plan after opening it.
  - This plan must not remove generic plan-opening behavior outside the Kanban card UI.

## Proposed Changes

### Band A — Routine / Low Complexity
1. Remove the `View` button from the Kanban card action markup
   - **File:** `src/webview/kanban.html`
   - **Lines:** `843-857`
   - Delete the `<button class="card-btn icon-btn view" ...>` block from `createCardHtml(card)`.
   - Keep the rest of the action layout stable so the row still renders cleanly with `Copy Prompt`, `Review`, and `Complete`.
   - **Clarification:** this is a Kanban-card-only removal. It does not change how plans are opened from other parts of the extension.
2. Remove the dead `viewPlan` click binding from the Kanban webview
   - **File:** `src/webview/kanban.html`
   - **Lines:** `794-798`
   - Delete the `.card-btn.view` event listener registration so the webview no longer posts `viewPlan` messages from Kanban cards.
3. Remove the Kanban-only backend transport for `viewPlan`
   - **Files:** `src/services/KanbanProvider.ts`, `src/extension.ts`, `src/services/TaskViewerProvider.ts`
   - **Lines:** `src/services/KanbanProvider.ts:1101-1104`, `src/extension.ts:879-882`, `src/services/TaskViewerProvider.ts:1158-1160`
   - Remove the Kanban-specific message/command/wrapper chain:
     - `case 'viewPlan'` in `KanbanProvider`
     - `switchboard.viewPlanFromKanban` command registration in `extension.ts`
     - `handleKanbanViewPlan(...)` wrapper in `TaskViewerProvider.ts` if it becomes unused
   - Keep `_handleViewPlan(...)` in place because the generic sidebar session-selection flow still uses `viewPlan`.
4. Add a focused regression check so the Kanban path stays gone
   - **Files:** `src/test/*` (prefer a small source-level regression test consistent with the existing test style)
   - Assert that:
     - `kanban.html` no longer renders the Kanban `View` button,
     - the Kanban provider no longer handles the Kanban-only `viewPlan` message path,
     - the generic `viewPlan` flow in `implementation.html` and `TaskViewerProvider.ts` still exists.

### Band B — Complex / Risky
- None.

## Verification Plan
1. Open the Kanban board and confirm each card now shows only:
   - `Copy Prompt`
   - `Review`
   - `Complete`
2. Confirm there is no empty gap or broken spacing where the removed `View` icon used to be.
3. Confirm the ticket/review flow still opens correctly from the remaining card actions.
4. Confirm the generic non-Kanban plan-opening flow still works by changing the selected session in the main sidebar and verifying the plan opens as before.
5. Run targeted validation:
   - `npm run compile`
   - `npm run compile-tests`
   - the focused regression test covering Kanban `View` button removal.

## Open Questions
- None.

## Complexity Audit

### Band A — Routine
- Remove one button from the Kanban card markup.
- Remove the matching click listener in the Kanban webview.
- Delete the now-unused Kanban-only command path while preserving the generic plan-opening flow.
- Add a small regression check so the redundant button does not come back.

### Band B — Complex / Risky
- None.
