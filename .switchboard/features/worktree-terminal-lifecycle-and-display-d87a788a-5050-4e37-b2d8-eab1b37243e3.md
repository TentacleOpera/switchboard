# Worktree Terminal Lifecycle and Display

**Complexity:** 4

## Goal

Fix and improve the full lifecycle of worktree-spawned terminals from creation through state hydration after reload to cleanup on worktree delete/merge/abandon, and correct display in the agents tab. These plans share the terminalUtils and TaskViewerProvider terminal management seam.

## How the Subtasks Achieve This

- **Worktree Delete/Merge/Abandon Must Close Its Spawned Terminals**: Ensures terminals spawned for a worktree are closed when the worktree is deleted, merged, or abandoned, preventing orphaned terminal sessions.
- **Grid Terminals Toggle — Clear, Prominent, On By Default**: Makes the Open Terminals With Grid toggle clearer and defaults it ON, improving the worktree terminal creation UX.
- **Worktree State Must Hydrate Automatically After Reload**: Fixes worktree state loss after a VS Code window reload by persisting and re-hydrating the worktree-to-terminal mapping.
- **Agents Tab Terminal List Does Not Respect Worktree Terminals**: Fixes the agents tab to show worktree-spawned terminals correctly instead of only showing main workspace terminals.
- **Planner Agent Row Shows IDE-Suffixed Terminal Name**: Fixes the terminal display name in the agents tab so worktree-suffixed names like planner - planner-devin are cleaned up to just planner.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Planner Agent Row Shows IDE-Suffixed Terminal Name ("planner - planner-devin")](../plans/feature_plan_20260702105354_planner-row-shows-ide-suffixed-name.md) — **CODE REVIEWED**
- [ ] [Agents Tab Terminal List Does Not Respect Worktree Terminals](../plans/feature_plan_20260702114209_agents-tab-worktree-terminal-preference.md) — **CODE REVIEWED**
- [ ] [Worktree Delete/Merge/Abandon Must Close Its Spawned Terminals](../plans/feature_plan_20260702140001_worktree-delete-closes-terminals.md) — **CODE REVIEWED**
- [ ] [Worktree "Open Terminals With Grid" Toggle — Make It Clear, Prominent, And On By Default](../plans/feature_plan_20260702140003_grid-terminals-toggle-clear-and-on-by-default.md) — **CODE REVIEWED**
- [ ] [Worktree State Must Hydrate Automatically After A Window Reload](../plans/feature_plan_20260702140004_worktree-state-hydrate-on-reload.md) — **CODE REVIEWED**
<!-- END SUBTASKS -->
