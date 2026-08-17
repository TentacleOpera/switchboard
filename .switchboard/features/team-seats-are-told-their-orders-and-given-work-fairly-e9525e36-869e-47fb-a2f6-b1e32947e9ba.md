# Team seats are told their orders and given work fairly

**Complexity:** 5

## Goal

Two defects in how a team treats its seats, both reached through teamWiring.ts and the prompt-delivery chokepoints. Standing orders are installed as config rows and only ever rendered onto an outbound prompt, so a seat that is started and left alone is told nothing. And the head prompt tells the lead to hand the next subtask back to the coder that just reported, naming no other seat and carrying no idle signal, so one coder is run to its context limit while its siblings sit at an idle prompt.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Relay Standing Orders to a Seat the Moment It Starts, Not Only When Someone Dispatches to It](../plans/feature_plan_20260817101500_relay-standing-orders-on-terminal-startup.md) — **CREATED**
- [ ] [A Team Lead Must Spread Subtasks Across Idle Seats, Not Burn One Coder to Its Context Limit](../plans/feature_plan_20260817101700_lead-spreads-subtasks-across-idle-seats.md) — **CREATED**
<!-- END SUBTASKS -->
