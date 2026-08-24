# Context Is Cleared Before a Seat Is Given Work

**Complexity:** 5

## Goal

Stop a seat starting new work carrying the last task's context. Clearing must happen for every terminal on a team when a card lands on any of its seats, and it must be enforced by the host rather than left to a lead that forgets. The two plans approach the same guarantee from opposite ends - one widens the scope of the clear, the other moves the trigger into the server.

## How the Subtasks Achieve This

- **Clear all team terminals when a card moves into a team** — sends the clear to every terminal on the team, not only the destination seat, so no seat carries the previous task's context.
- **Host-enforced auto-clear on plan change** — moves the trigger into the server: a prompt whose dispatch names a different plan clears automatically, rather than relying on a lead that remembers.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Host-Enforced Auto-Clear on Plan Change](../plans/plan_20260820140000_host-auto-clear-on-plan-change.md) — **CODER CODED**
- [ ] [Clear All Team Terminals When a Card Moves Into a Team](../plans/clear-all-team-terminals-on-card-move.md) — **CODER CODED**
<!-- END SUBTASKS -->

## Dependencies & sequencing

The host-enforced subtask is the general mechanism and the team-wide clear is a scoping question. Land the host-enforced trigger first — doing so may reduce the team-wide subtask to configuration rather than new code, so implementing them in the other order risks writing something that is then deleted.

## Completion Summary

Both subtasks implemented and reviewed. Host-enforced auto-clear adds an in-memory Map (terminal name → last planId) on both extension host and standalone; when a dispatch references a different planId, the host overrides clearBeforePrompt to true so /clear fires before the prompt. Same-planId resends preserve false (context kept for fix prompts). Map maintenance covers ptyClearTerminal, ptyClearAllTerminals, ptyCloseTerminal, ptyRenameTerminal, and ptyWrite with /clear. Team-wide clear adds a fire-and-forget block in _handleTriggerAgentActionInternal that calls clearTerminalContext on all team members except the destination seat when a card lands on a team. Skill documentation inlined into KanbanProvider.ts _buildDrivePrefix (skill files were deleted); contract phrases "mandatory for correctness" and "Clear at rest, always" preserved. New test file host-auto-clear-on-plan-change.test.js has 11 source-level assertions covering both hosts.

