# The multi-agent planning team plans as a team

**Complexity:** 5

## Goal

The Multi-agent planning team currently spawns a planner head plus two researchers and an analyst, and then the head writes the whole plan by itself. Three changes make it a real team: give the head a fan-out head prompt so it dispatches an angle to each member before writing anything; replace the research pool with three peer planner seats so the topology differs from Batch planners and from an ordinary planner terminal; and expose the per-member startupCommand in the TEAMS tab so those seats can run a cheaper agent CLI than the operator's general planners.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Multi-Agent Planning Head Plans Alone — Give the Team a Fan-Out Head Prompt](../plans/feature_plan_20260817174450_multi-agent-planning-head-plans-alone-instead-of-fanning-out.md) — **PLAN REVIEWED**
- [ ] [The Multi-Agent Planning Team's Roster Is Parallel Planner Seats, Not Two Researchers](../plans/feature_plan_20260817174453_multi-agent-planning-roster-is-parallel-planners-not-researchers.md) — **PLAN REVIEWED**
- [ ] [Team Member Seats Can Run Their Own Agent CLI Instead of Inheriting the Role's](../plans/feature_plan_20260817174454_team-member-seats-can-run-their-own-agent-cli.md) — **PLAN REVIEWED**
<!-- END SUBTASKS -->

