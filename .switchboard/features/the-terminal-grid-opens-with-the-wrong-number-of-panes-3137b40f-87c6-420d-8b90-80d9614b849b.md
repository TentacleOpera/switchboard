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
- [ ] [Start Grid undercounts planner agents when one already exists](../plans/feature_plan_20260820074416_start-grid-undercounts-planners-when-one-already-exists.md) — **CODE REVIEWED** — ID: 09f54022-6f19-4137-8be3-9a701db53b8e
- [ ] [Fill Grid mode dropdown should default to 2x2 instead of mirroring current layout](../plans/feature_plan_20260820082002_fill-grid-default-2x2.md) — **CODE REVIEWED** — ID: 224b7f97-9e79-4961-a983-1f6aaf93db50
- [ ] [Team grid shows too few terminals on first click — stale fleet under-sizes the layout](../plans/feature_plan_20260820221235_team-grid-stale-fleet-under-sized-on-enter.md) — **CODE REVIEWED** — ID: 5b806a13-f6eb-45ef-8b05-e5f605c85d3d
<!-- END SUBTASKS -->

## Dependencies & sequencing

No ordering constraints; three independent count and default corrections on the same surface. Landing them in one pass avoids three separate rounds of grid-sizing verification.

## Review Findings

Two of the three subtasks achieve their goal. Fill Grid now opens on a named `DEFAULT_FILL_GRID_MODE` ('2x2') instead of mirroring `currentLayout` (`src/webview/terminals.js:1200`, :2021), and Start Grid creates N *new* planners in both grid-building paths using a max-planner-number offset that survives numbering gaps (`src/extension.ts:3625`, :3637; `src/webview/terminals.js:10441`, :10459) — both covered by new CI-invoked contract suites. The third subtask does **not** achieve its goal: its primary fix sits in a code path unreachable for every group that has a roster, so the team grid is still sized by `group.layout` exactly as before; subtask `5b806a13` has been returned to PLAN REVIEWED with the evidence and the decision the author needs to make. One MAJOR was fixed in review — the re-seat gate is now stamped inside `seatActiveGroupPage` so it cannot go stale after `switchToGroup` or the layout picker. `npm run compile-tests` is clean, the two new suites pass 12/12, and every failure in the four related terminal suites reproduces unchanged at the parent commit.

## Deferred Findings

- CRITICAL `src/webview/terminals.js:4480` — subtask `5b806a13`'s roster-sizing fallback in `layoutForGroupSwitch` is dead code on every input; escalated to the author with the full evidence chain in that subtask's plan file.
- CRITICAL `src/webview/terminals.js:4200` — subtask `5b806a13`'s stated root cause was already fixed by `cb3da221`; the residual symptom comes from `group.layout`, not from a stale fleet. Escalated.
- MAJOR `src/webview/terminals.js:910` — `group.layout` carries both the auto-assigned team size and a deliberate operator choice with nothing distinguishing them, which is what blocks the CRITICAL above.
- NIT `src/webview/terminals.js:10444` — batch-creating 5 planners now overflows `growLayoutForFleet`'s 3x3 ceiling more often, surfacing the "could not be seated" toast.
- NIT `src/extension.ts:3628` — the planner-name regex duplicates `matchesGridAgentName`'s pattern and the two can drift.
- NIT — `terminal-sidebar-groupings` (5 failures) and `terminal-open-all-seating` (1 failure) are CI-invoked and already red at `47c1deca^`, so this feature's gates land on an already-failing job.

## Resolution — all three subtasks now land

The subtask-3 escalation was answered by the author: "respect the operator's layout" and
"size a team to its roster" were never competing goals, they were two preferences sharing
one field. An **AUTO option in the layout picker** (on by default for new teams) separates
them, which makes this plan's roster-sizing code reachable for the first time. See that
subtask's `## Resolution` for the full shape. `layoutForTeamSize`/`TEAM_LAYOUT_LADDER` are
removed; both stored-layout whitelists widened to `STORABLE_GROUP_LAYOUTS` so an auto group
cannot be silently dropped at load. Every suite's failure set is byte-identical to the
parent commit, and the new panel coverage is behavioural rather than source-text.

The CRITICAL and MAJOR entries under `## Deferred Findings` above are resolved by this
work; the NITs stand. One decision is left open for the author: existing team rows keep
their stored layout rather than being migrated to `'auto'`, because a stored value cannot
be told apart from a deliberate operator choice after the fact.
