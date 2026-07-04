# Kanban Board UI Bug Fixes

**Complexity:** 7

## Goal

Fix two kanban.html UI behavior bugs. The optimistic column-move bounce-back after window reload, and the ASSIGN button not clearing the plan selection when the same workspace is re-assigned.

## How the Subtasks Achieve This

- **Fix: Optimistic Move Bounce-Back After Reload**: Fixes the kanban card visually bouncing back to its pre-move column after a window reload, by ensuring the optimistic move state is not persisted over the server-confirmed state.
- **Assign to Same Workspace Should Clear Selection**: Fixes the ASSIGN button showing a toast message instead of clearing the plan selection when the user assigns a plan to the same workspace it is already in.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Assign To Same Workspace Should Clear The Plan Selection (Not Toast)](../plans/feature_plan_20260702140002_assign-same-workspace-clears-selection.md) — **CODE REVIEWED**
- [ ] [Fix: Optimistic Move Bounce-Back After Reload (CODE REVIEWED → LEAD CODED)](../plans/fix-optimistic-move-bounce-back-after-reload.md) — **CODE REVIEWED**
<!-- END SUBTASKS -->
