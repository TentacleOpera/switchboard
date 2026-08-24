# A Dispatch Lands on a Real PTY-Backed Seat, or Says Why Not

**Complexity:** 6

## Goal

Make seat resolution honest. Teams are PTY-only, so no team automation may fall back to a non-PTY path; complexity routing should prefer its tier but degrade across the live terminal pool rather than stall, sending everything to the one coding agent if that is all there is; and a team that could not give a seat a CLI must report it instead of silently spawning a bare shell.

## How the Subtasks Achieve This

- **Enforce PTY-only for team automations** — closes every non-PTY fallback across team creation, dispatch, schedule queue pop, terminal selection, team-scoped role resolution and worktree terminal creation.
- **Complexity routing degrades to the live terminal pool** — prefers the tier when it is available and otherwise degrades across what is actually alive; with one coding agent, everything goes to it.
- **Team start silently spawns bare shells for roles with no startup command** — reports the seats it could not give a CLI to, instead of spawning a bare shell and saying nothing.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Team start silently spawns bare shells for roles with no startup command](../plans/feature_plan_20260819092741_team-start-reports-commandless-seats.md) — **PLAN REVIEWED**
- [ ] [Enforce PTY-Only for Team Automations](../plans/enforce-pty-only-for-team-automations.md) — **PLAN REVIEWED**
- [ ] [Complexity Routing Degrades to the Live Terminal Pool](../plans/complexity-routing-degrade-to-live-pool.md) — **PLAN REVIEWED**
<!-- END SUBTASKS -->
## Dependencies & sequencing

PTY-only lands first: it narrows the pool that complexity routing then degrades across, so routing built against the wider pool would need reworking. The commandless-seats report is independent of both.

