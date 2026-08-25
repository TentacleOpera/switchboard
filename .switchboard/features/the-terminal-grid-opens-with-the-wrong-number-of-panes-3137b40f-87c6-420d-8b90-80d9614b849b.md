# The Terminal Grid Opens With the Wrong Number of Panes

**Complexity:** 4

## Goal

Fix all three ways the terminal grid mis-sizes itself on open. Fill Grid mirrors the current layout instead of defaulting to a sane two-by-two, so a dense active layout pre-selects six agents and a window too small to hold them. Start Grid creates one fewer planner than asked whenever one already exists, in both grid-building paths. And team-scoped mode sizes off a stale fleet, showing a partial grid on the first click.

## How the Subtasks Achieve This

- **Fill Grid mode dropdown should default to 2x2 instead of mirroring current layout** — stops a dense active layout pre-selecting six agents and a window too small to hold them.
- **Start Grid undercounts planner agents when one already exists** — fixes the off-by-existing bug in both code paths that build the agent grid.
- **Team grid shows too few terminals on first click** — stops a stale fleet under-sizing the layout when the operator enters team-scoped mode.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Start Grid undercounts planner agents when one already exists](../plans/feature_plan_20260820074416_start-grid-undercounts-planners-when-one-already-exists.md) — **PLAN REVIEWED**
- [ ] [Fill Grid mode dropdown should default to 2x2 instead of mirroring current layout](../plans/feature_plan_20260820082002_fill-grid-default-2x2.md) — **PLAN REVIEWED**
- [ ] [Team grid shows too few terminals on first click — stale fleet under-sizes the layout](../plans/feature_plan_20260820221235_team-grid-stale-fleet-under-sized-on-enter.md) — **PLAN REVIEWED**
<!-- END SUBTASKS -->

## Dependencies & sequencing

No ordering constraints; three independent count and default corrections on the same surface. Landing them in one pass avoids three separate rounds of grid-sizing verification.

