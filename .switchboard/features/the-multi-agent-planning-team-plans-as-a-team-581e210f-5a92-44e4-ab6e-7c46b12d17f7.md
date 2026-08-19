# The multi-agent planning team plans as a team

**Complexity:** 5

## Goal

The Multi-agent planning team currently spawns a planner head plus two researchers and an analyst, and then the head writes the whole plan by itself. Three changes make it a real team: give the head a fan-out head prompt so it dispatches an angle to each member before writing anything; replace the research pool with three peer planner seats so the topology differs from Batch planners and from an ordinary planner terminal; and expose the per-member startupCommand in the TEAMS tab so those seats can run a cheaper agent CLI than the operator's general planners.

## How the Subtasks Achieve This

- **Multi-Agent Planning Team — Fan-Out Head Prompt and Peer-Planner Roster**: Adds a fan-out `headPrompt` to the shipped Multi-agent planning team type so the head dispatches one investigation angle per member before writing anything, AND replaces the researcher+analyst roster with three peer planner seats (`relationship: 'reports-to-head'`) so the topology is "several planners draft in parallel, head reconciles." Both changes ship in one migration step (step 1d in `migrateAgentGroups`) to eliminate the ordering dependency that two separate steps would create. Also includes a read-site order migration (`migrateMultiAgentPlanningOrders`) to rewrite stale `team`-scoped standing orders carrying the old researcher prompt, which `wireSpawnedTeam` would otherwise leave in place after a restart.
- **Team Member Seats Can Run Their Own Agent CLI Instead of Inheriting the Role's**: Exposes the per-member `startupCommand` field in the TEAMS tab's member editor (two text inputs: label and command), so a team seat can run a different agent CLI than the role's global configuration. Removes the lossy `existing.find(m => m.role === role)` preservation shim that collapsed same-role members to the first row's values on save. The field already exists on the stored `DelegateDefinition` shape and is already honoured end to end by the spawn path — this plan closes the authoring-surface gap.

## Dependencies & sequencing

- Subtasks are independent and can land in either order. The merged plan touches `SHIPPED_TEAM_TYPES`, `migrateAgentGroups`, and standing-order migration logic in `teamWiring.ts` / `kanban.html` / `terminals.js`. The member-seats plan touches only the TEAMS-tab member editor UI in `kanban.html` (`teamsTabAgentGroupMemberRow` and `teamsTabSaveAgentGroup`). No shared files between them — the member editor functions are in a different section of `kanban.html` than `SHIPPED_TEAM_TYPES`, and no `migrateAgentGroups` or standing-order code is touched by the member-seats plan.
- The merged plan's three planner seats run the `planner` role's configured CLI until the member-seats plan lands. This is a known limitation stated in the merged plan, not a blocking dependency — the team functions correctly with the role's CLI; the member-seats plan adds the ability to override it per seat.
- No prerequisites or guards beyond the standard migration discipline (exact-value recognisers, idempotent transforms, three-copy byte-identity contract test).

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Team Member Seats Can Run Their Own Agent CLI Instead of Inheriting the Role's](../plans/feature_plan_20260817174454_team-member-seats-can-run-their-own-agent-cli.md) — **PLAN REVIEWED**
- [ ] [Multi-Agent Planning Team — Fan-Out Head Prompt and Peer-Planner Roster](../plans/feature_plan_20260819_multi-agent-planning-team-fan-out-head-and-peer-planner-roster.md) — **PLAN REVIEWED**
<!-- END SUBTASKS -->

