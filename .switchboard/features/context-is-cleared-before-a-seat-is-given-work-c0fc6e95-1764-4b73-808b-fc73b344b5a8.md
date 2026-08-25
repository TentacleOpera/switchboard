# Context Is Cleared Before a Seat Is Given Work

**Complexity:** 5

## Goal

Stop a seat starting new work carrying the last task's context. Clearing must happen for every terminal on a team when a card lands on any of its seats, and it must be enforced by the host rather than left to a lead that forgets. The two plans approach the same guarantee from opposite ends - one widens the scope of the clear, the other moves the trigger into the server.

## How the Subtasks Achieve This

- **Clear all team terminals when a card moves into a team** — sends the clear to every terminal on the team, not only the destination seat, so no seat carries the previous task's context.
- **Host-enforced auto-clear on plan change** — moves the trigger into the server: a prompt whose dispatch names a different plan clears automatically, rather than relying on a lead that remembers.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Host-Enforced Auto-Clear on Plan Change](../plans/plan_20260820140000_host-auto-clear-on-plan-change.md) — **CODE REVIEWED**
- [ ] [Clear All Team Terminals When a Card Moves Into a Team](../plans/clear-all-team-terminals-on-card-move.md) — **CODE REVIEWED**
<!-- END SUBTASKS -->

## Dependencies & sequencing

The host-enforced subtask is the general mechanism and the team-wide clear is a scoping question. Land the host-enforced trigger first — doing so may reduce the team-wide subtask to configuration rather than new code, so implementing them in the other order risks writing something that is then deleted.

## Completion Summary

Both subtasks implemented and reviewed. Host-enforced auto-clear adds an in-memory Map (terminal name → last planId) on both extension host and standalone; when a dispatch references a different planId, the host overrides clearBeforePrompt to true so /clear fires before the prompt. Same-planId resends preserve false (context kept for fix prompts). Map maintenance covers ptyClearTerminal, ptyClearAllTerminals, ptyCloseTerminal, ptyRenameTerminal, and ptyWrite with /clear. Team-wide clear adds a fire-and-forget block in _handleTriggerAgentActionInternal that calls clearTerminalContext on all team members except the destination seat when a card lands on a team. Skill documentation inlined into KanbanProvider.ts _buildDrivePrefix (skill files were deleted); contract phrases "mandatory for correctness" and "Clear at rest, always" preserved. New test file host-auto-clear-on-plan-change.test.js has 11 source-level assertions covering both hosts.


## Review Findings

Both subtasks' original mechanisms were deliberately deleted by the later "Atomic Team Context" feature (`c4984af9`), which replaced the per-plan map and the fire-and-forget `_handleTriggerAgentActionInternal` roster clear with a once-per-work-context (`featureId ?? planId`) barrier inside `_ptyHostVerb` — that supersession is correct and was left intact. The critical gap was that the replacement sits behind `if (hasDispatch)` and **no internal caller sets `dispatch`**: every board gesture routes through `_attemptDirectTerminalPush`, which sends only `name`/`data`/`clearBeforePrompt`, so the card-move and batch triggers got no team barrier at all — the exact guarantee this feature exists for. Fixed on both hosts by feeding the lifecycle from the parse-based identity as well as the `dispatch` field (`src/services/TaskViewerProvider.ts`, `src/standalone/bootstrap.ts`), plus three smaller fixes: the destination override now honours `terminal.clearBeforePrompt` (siblings already did), the write-only `_lastDispatchedPlanByTerminal` map was deleted from both hosts, and the barrier's abort message now names the failed seat instead of interpolating its error text. **Validation:** `compile-tests`, `compile` and `eslint` (0 errors) clean; all seven CI-wired gates named by the two plans pass, and `host-auto-clear-on-plan-change.test.js` was rewritten from 15 assertions (11 of which pinned the dead map) to 21 covering the live maps, the parse-path reachability and the config gate; 18 unrelated suites in the dispatch/terminal sweep are red identically at committed HEAD, so no new red. **Remaining risks:** the board's card-move now waits on a multi-second roster barrier whose destination pane gets no curtain in the extension host (`isClearing` is computed in `handlePtyVerb` before `_ptyHostVerb` decides — pre-existing, curtain feature's territory), and the "same feature keeps context" policy is in tension with the standing "one subtask per clean seat" preference — an operator decision, not a wiring defect.
