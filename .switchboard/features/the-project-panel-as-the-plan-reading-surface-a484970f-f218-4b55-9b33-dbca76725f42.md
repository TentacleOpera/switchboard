# The Project Panel as the Plan Reading Surface

**Complexity:** 4

## Goal

The Project panel is where you go to read a plan in full, and today it is both hard to reach and wrong when you get there. The kanban-mode pane in the terminals cockpit has no route into it, and the panel own plan cache only refreshes on tab switch, panel reveal, or a plan-file write - so every board-originated card move leaves it showing a stale column indefinitely. These two compose directly: adding the route without fixing the staleness lands the operator on out-of-date data.

## How the Subtasks Achieve This

- **Project panel goes out of sync with the kanban board after card moves**: makes `refreshUI` notify the project panel, so `_kanbanPlansCache` refreshes on every card move the way the board and sidebar already do.
- **Add View Button to Kanban-Mode Pane Cards in Terminals**: wires each plan row in the terminals kanban pane to the existing `reviewPlan` verb and panel switch — the same path the board's review button already uses.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Project panel goes out of sync with the kanban board after card moves](../plans/project-panel-kanban-sync-on-card-move.md) — **PLAN REVIEWED**
- [ ] [Add View Button to Kanban-Mode Pane Cards in Terminals](../plans/feature_plan_20260807182931_kanban-pane-view-button.md) — **PLAN REVIEWED**
<!-- END SUBTASKS -->

## Dependencies & sequencing

**Ordered.** Land the sync fix first. The View button's entire value is arriving at a correct panel; shipping the route onto a stale panel makes the staleness far more visible than it is today, and turns a quiet cache bug into a reported one.

Both subtasks reuse existing infrastructure rather than adding any: `reviewPlan` is already allowlisted in `KANBAN_VERBS` with a working `__viaHttp` push path, and the project panel already re-fetches on its own column-change path — it simply is not told about board-originated moves.
