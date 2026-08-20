# Standing Orders on Terminal Establish and Clear

**Complexity:** 5

## Goal

Today standing orders are delivered as a suffix appended to every prompt sent to a terminal — they ride on dispatch, not on terminal lifecycle. This means a terminal that is cleared (context reset) loses its standing orders until the next dispatch carries them back in. It also means role-specific instructions (like the planner workflow prompt) must be manually pasted into terminals, because there is no role-scoped standing order that applies to every terminal of a given role.

This feature adds a `role` scope to the standing orders system and delivers standing orders at two terminal lifecycle moments: when a terminal is established (spawned or role-assigned) and after a terminal is cleared. A role-scoped order applies to every terminal with that role — planners get the planner workflow, coders get the coding directives, reviewers get the review protocol — automatically, without manual paste and without waiting for the next dispatch to carry them.

## How the Subtasks Achieve This

- **Role Scope in Standing Orders**: Adds a `role` scope to `StandingOrderScope` and teaches `selectOrders` to resolve it from the terminal registry (`_terminalAgentInfo`). A role-scoped order applies to every terminal whose role matches, regardless of team membership. This is the foundation — without it, there is no way to say "all planners get this instruction."
- **Deliver Standing Orders on Terminal Establish**: When a terminal is spawned or has its role assigned, the system sends the terminal its applicable standing orders as a one-shot prompt (not appended to a dispatch — a standalone delivery). The terminal sees its orders immediately on establishment, not after the first dispatch.
- **Deliver Standing Orders After Clear**: When a terminal is cleared (via `clearTerminalContext` or the `/clear` clipboard paste), the system re-sends the terminal's applicable standing orders as a one-shot prompt after the clear completes. A cleared terminal re-establishes its orders without waiting for the next dispatch.

## Dependencies & sequencing

- **Role scope lands first.** The establish/clear delivery subtasks need to know which orders apply to the terminal being established or cleared — the role scope is how they resolve.
- **Establish delivery and clear delivery can proceed in parallel** once the role scope is in place. They share the same resolution path (`selectOrders` + role) but plug into different lifecycle hooks.

Rough order: role scope → (establish delivery ‖ clear delivery).

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Standing Orders: Add a `role` Scope](../plans/standing-orders-role-scope.md) — **PLAN REVIEWED**
- [ ] [Deliver Standing Orders on Terminal Establish](../plans/standing-orders-deliver-on-establish.md) — **PLAN REVIEWED**
- [ ] [Deliver Standing Orders After Terminal Clear](../plans/standing-orders-deliver-after-clear.md) — **PLAN REVIEWED**
<!-- END SUBTASKS -->

