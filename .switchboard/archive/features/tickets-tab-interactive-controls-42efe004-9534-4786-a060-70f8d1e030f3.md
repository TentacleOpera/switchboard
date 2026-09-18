# Tickets Tab Interactive Controls

**Complexity:** 5

## Goal

Make the Tickets sidebar a first-class ticket-management surface by adding two missing inline controls — a clickable priority dot on each card and an assignee modal launched from the meta bar. Today the tab exposes Status and Tags but priority is invisible and assignee is read-only; both plans wire new ClickUp + Linear update paths into the existing card/meta-bar rendering and the PlanningPanelProvider message switch, using the same service-method + optimistic-update patterns already established by the Status and Tags flows.

## How the Subtasks Achieve This

- **Replace Sidebar Card Status Dot with a Changeable Priority Dot**: Swaps the decorative status-colored dot on each ticket card for a priority-colored dot that opens an inline priority picker. Adds `updateIssuePriority` (Linear) and a ClickUp priority update path, plus two message-switch cases — surfacing priority at a glance and making it changeable without leaving the tab.
- **Add Assignee Control to Tickets Tab**: Adds an "Assign" button to the ticket meta bar that opens a Tags-style searchable member modal (radio for Linear, checkboxes for ClickUp, shared "Nobody" sentinel). Adds `updateIssueAssignee` (Linear) and `updateTaskAssignees` delta-based method (ClickUp), plus three message-switch cases — closing the last core ticket-management gap next to Status and Tags.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Add Assignee Control to Tickets Tab](../plans/add-assignee-control-to-tickets-tab.md) — **CODE REVIEWED** — ID: a990ce4a-581a-420f-84e0-1ff750dc9fbd
- [ ] [Replace Sidebar Card Status Dot with a Changeable Priority Dot](../plans/replace-ticket-card-status-dot-with-changeable-priority-dot.md) — **CODE REVIEWED** — ID: 9a753e3a-895b-49df-9064-6701bd3f5871
<!-- END SUBTASKS -->

## Dependencies & sequencing

No hard ordering constraints; subtasks can be executed in parallel. **POSSIBLE OVERLAP:** both subtasks modify the same files — `planning.js` (card renderers / meta bar), `PlanningPanelProvider.ts` (message switch), and `LinearSyncService.ts` / `ClickUpSyncService.ts` (new service methods). If coded in parallel worktrees, expect merge conflicts in the message-switch region and the card-renderer region. Recommend landing one before the other, or coordinating the message-switch case insertion point.
