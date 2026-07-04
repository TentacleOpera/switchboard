# Epic & Dispatch Pipeline Consolidation

**Complexity:** 6

## Goal

Eliminate the duplicated, divergent code paths in the backend that cause the recurring epic-treated-as-a-plain-plan class of bugs. Two separate consolidation fixes target the same root cause pattern — copy-pasted logic around epic creation and epic dispatch that forgets epic-specific handling — by routing every entry point through a single hardened choke point. Together they make epic creation and epic prompt-dispatch each have exactly one implementation, so new entry points can never silently drop epic handling again.

## How the Subtasks Achieve This

- **Epic created as plan — no Kanban board refresh on epic creation (Epics tab path)**: Replaces the duplicated epic-creation body in `PlanningPanelProvider.createEpic` with a delegation to the already-hardened `KanbanProvider.createEpicFromPlanIds`, fixing three defects at once (no board refresh, no project inheritance, no UUID-embedded filename) by becoming the third caller of the single choke point.
- **Consolidate the Five Prompt-Dispatch Plan Builders into One**: Collapses the five separate `BatchPromptPlan[]` construction sites (board, CLI batch, single-card drag, two copy paths) into one canonical record-driven builder on `KanbanProvider`, so epic-subtask expansion, worktree resolution, plan-file fallbacks, and `project` stamping exist in exactly one place.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Consolidate the Five Prompt-Dispatch Plan Builders into One](../plans/feature_plan_20260630055827_consolidate-dispatch-plan-builders.md) — **CODER CODED**
- [ ] [Epic created as plan — no Kanban board refresh on epic creation (Epics tab path)](../plans/feature_plan_20260703152146_epic-created-as-plan-no-board-refresh.md) — **CODER CODED**
<!-- END SUBTASKS -->

## Dependencies & sequencing

No hard ordering constraint, but recommend `616d1d00` (epic creation delegation, complexity 4) **before** `21efbe63` (dispatch builder consolidation, complexity 6). They touch different methods in `PlanningPanelProvider`/`KanbanProvider` (`createEpic` vs `_cardsToPromptPlans`/`_resolveKanbanDispatchPlans`), so merge-conflict risk is low, but landing the quick epic-creation fix first stabilizes that path before the larger refactor reshapes the dispatch surface.
