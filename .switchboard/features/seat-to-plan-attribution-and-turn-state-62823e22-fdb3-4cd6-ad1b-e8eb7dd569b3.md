# Seat to Plan Attribution and Turn State

**Complexity:** 6

## Goal

An operator watching a grid of agents can see which agent is in each pane but not what it is working on, nor whether it finished, nor whether it is blocked waiting on them. The plan title exists only in an eight-second toast fired after the work is over; turn-end is inferred from a plan-file mtime with a blind ten-minute backstop; and the blocked_at column that V59 added for exactly this has no writer at all. Both plans depend on the same terminal-to-plan join, and one of them fixes the fact that the cockpit primary dispatch gesture records no dispatch identity whatsoever.

## How the Subtasks Achieve This

- **Show the Live Plan Title in Each Terminals Pane Header**: renders the attributed plan title in every pane frame for the whole run, and closes the missing `dispatched_at` / `dispatched_terminal` write on the drag-a-card-onto-a-pane flow.
- **Turn-End From PTY Output Silence**: derives turn-end from output silence on the pty stream Switchboard already reads, filling the empty third branch of the liveness classifier, and gives `blocked_at` its first writer — with no per-CLI dependency.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Turn-End From PTY Output Silence: One Completion Signal That Works For Every Agent CLI](../plans/feature_plan_20260808083000_pty-turn-end-from-output-silence.md) — **PLAN REVIEWED**
- [ ] [Show the Live Plan Title in Each Terminals Pane Header](../plans/feature_plan_20260808135826_terminals-pane-header-live-plan-title.md) — **PLAN REVIEWED**
<!-- END SUBTASKS -->

## Dependencies & sequencing

**Ordered, and the dependency is load-bearing.** The turn-end derive keys on `basis = MAX(dispatched_at, last_liveness_at)`. The pane-header subtask is what makes the cockpit's drag-drop dispatch write `dispatched_at` at all — today that gesture records no dispatch identity on either host, which is also why the board's activity light does not come on for it.

**Land the pane-header subtask first**, or turn-end and the blocked state ship inert for the panel's most common dispatch gesture.

Do not build on `getActiveDispatchedByTerminal` / `getActiveDispatchedByCwd` — both have zero callers repo-wide and the latter keys on `plans.worktree_id`, which no live code path writes. Use the completion toast's actual mechanism: `record.dispatchedTerminal` plus `matchWorktreePath` from `src/services/worktreeResolver.ts`.

⚠ **File contention:** shares `terminals.js` with four other features in this batch.
