# Phone-a-Friend Is Unreachable and Unbranded

**Complexity:** 5

## Goal

The Phone-a-Friend role is broken at both ends. Its batch-end signal never reaches a PTY fleet seat: the dispatcher can only see vscode.Terminal objects, the standalone host wires no onPhoneAFriend callback, and getLocalApiServerPort() returns 0 there so the directive is never emitted. Separately, the role has no entry in the agentNames map (built from kanban column roles, and Phone-a-Friend has no column), so its seat shows the generic >_ placeholder and 'Starting...' instead of its CLI brand and name across the startup curtain, sidebar row, pane header and shell rail.

## How the Subtasks Achieve This

- **Phone-a-Friend Never Reaches a PTY Fleet Seat**: Fixes the three-hop signal path so the batch-end POST reaches a live terminal in any host. Adds fleet-first target resolution in `_dispatchPhoneAFriend` (PTY fleet seats are reachable via `ptyListTerminals`/`ptySendPrompt`, same pattern as `notifyTurnEnd`), wires the `onPhoneAFriend` callback in the standalone bootstrap options object, and fixes `getLocalApiServerPort()` to fall back to the broadcast server so the directive is emitted under standalone. Hoists the second-pass prompt text to a shared `PHONE_A_FRIEND_SECOND_PASS_PROMPT` export so both hosts send byte-identical text.
- **A Phone-a-Friend Terminal Has No Brand Identity**: Widens `_getAgentNames` in `KanbanProvider` to union with the authoritative `getPtyVisibleRoles` roster, so `phone_a_friend` (and other column-less terminal-owning roles like `claude_designer`, `jules`, `project_manager`) get a CLI brand name in the `agentNames` map. All five rendering surfaces (startup curtain, sidebar row, pane header, shell rail) already consume the map and render the brand automatically once the key exists — no webview code change needed.

## Dependencies & sequencing

- Subtasks are independent and can land in any order. No file overlap: subtask 1 touches `TaskViewerProvider.ts`, `bootstrap.ts`, `agentPromptBuilder.ts`; subtask 2 touches `KanbanProvider.ts` and `terminals.js` (comment only).
- Within subtask 1, `PHONE_A_FRIEND_SECOND_PASS_PROMPT` (Proposed Change #4) must land before or in the same change as the dispatch changes (#1 and #3) that reference it.
- No prerequisites or guards beyond the changes themselves.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Phone-a-Friend Never Reaches a PTY Fleet Seat — Three Breaks in One Signal Path](../plans/feature_plan_20260817180100_phone-a-friend-never-reaches-a-pty-fleet-seat.md) — **PLAN REVIEWED**
- [ ] [A Phone-a-Friend Terminal Has No Brand Identity — Generic Curtain, Generic Icon, No CLI Name](../plans/feature_plan_20260817180200_phone-a-friend-seat-has-no-brand-identity.md) — **PLAN REVIEWED**
<!-- END SUBTASKS -->

