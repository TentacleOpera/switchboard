# Phone-a-Friend Is Unreachable and Unbranded

**Complexity:** 5

## Goal

The Phone-a-Friend role is broken at both ends. Its batch-end signal never reaches a PTY fleet seat: the dispatcher can only see vscode.Terminal objects, the standalone host wires no onPhoneAFriend callback, and getLocalApiServerPort() returns 0 there so the directive is never emitted. Separately, the role has no entry in the agentNames map (built from kanban column roles, and Phone-a-Friend has no column), so its seat shows the generic >_ placeholder and 'Starting...' instead of its CLI brand and name across the startup curtain, sidebar row, pane header and shell rail.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Phone-a-Friend Never Reaches a PTY Fleet Seat — Three Breaks in One Signal Path](../plans/feature_plan_20260817180100_phone-a-friend-never-reaches-a-pty-fleet-seat.md) — **CREATED**
- [ ] [A Phone-a-Friend Terminal Has No Brand Identity — Generic Curtain, Generic Icon, No CLI Name](../plans/feature_plan_20260817180200_phone-a-friend-seat-has-no-brand-identity.md) — **CREATED**
<!-- END SUBTASKS -->
