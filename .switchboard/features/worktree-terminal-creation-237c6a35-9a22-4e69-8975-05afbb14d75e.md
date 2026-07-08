# Worktree terminal creation

**Complexity:** 6

## Goal

Make worktree agent-terminal creation fast and correctly scoped. Today the "Open terminals" action for worktrees suffers from two independent defects: (1) a multi-second sequential delay between each terminal appearing, making 5+ agent terminals feel broken, and (2) cross-contamination between worktree and main-repo terminals when `agentsOpenWithGrid` is on and `suppressMainTerminals` is off, producing a broken mix where some roles exist only in the worktree and never open in the main repo. This epic delivers both fixes so worktree terminal creation is parallel/event-driven and location-aware.

## How the Subtasks Achieve This

- **Fix Slow Sequential Terminal Opening in Worktrees**: Parallelizes `ensureWorktreeTerminals` with `Promise.all`, defers PID resolution to background promises, and replaces the hardcoded 1-second `setTimeout` sleep with the `onDidStartTerminalShellExecution` shell-ready event (the same pattern already used by the main-repo `createAgentGrid` path). This collapses the 9–18 second cumulative wait down to ~1–2 seconds for a full 6-role grid.
- **Fix: Worktree terminal cross-contamination with main repo terminals**: Makes `matchesGridAgentName` worktree-aware by cross-referencing the terminal registry's `worktreePath` field, so main-repo creation no longer mistakes worktree terminals for existing main-repo terminals. Also fixes the per-role pool limit in `ensureWorktreeTerminals` to count only terminals for the current worktree path (not global main-repo terminals), and narrows `clearGridBlockers` so it stops disposing worktree terminals as duplicates.

## Dependencies & sequencing

Both subtasks rewrite the same function — `ensureWorktreeTerminals` in `src/services/TaskViewerProvider.ts`. The slow-opening subtask rewrites the function body to parallelize creation; the cross-contamination subtask changes the pool-limit check inside the same function's pre-filter loop. **Recommended sequencing:** land the cross-contamination pool-limit filter first (it is a localized change inside the existing sequential loop), then land the parallelization rewrite second and merge the pool-limit filter into the new `rolesToCreate` pre-filter loop. If landed in the opposite order, the parallelization PR must carry the pool-limit filter forward manually. No other cross-subtask ordering constraints exist; the `matchesGridAgentName` / `clearGridBlockers` changes in `extension.ts` are independent of the `TaskViewerProvider.ts` changes.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Fix Slow Sequential Terminal Opening in Worktrees](../plans/feature_plan_20260703063949_fix-slow-worktree-terminal-opening.md) — **CODE REVIEWED**
- [ ] [Fix: Worktree terminal cross-contamination with main repo terminals](../plans/feature_plan_20260703071500_worktree-terminal-cross-contamination.md) — **CODE REVIEWED**
<!-- END SUBTASKS -->

