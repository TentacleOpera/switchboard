# Kanban Board Chrome: Terminal & Worktree State Surfacing

**Complexity:** 4

## Goal

Make the kanban board's peripheral chrome (column headers and the bottom-bar worktree indicator) correctly reflect terminal and worktree state in context, and make terminal names interactive so users can jump to the right terminal directly from the board. Today the column-header agent names are inert plain text and the worktree indicator shows a worktree globally regardless of the active project/epic, both forcing users to detour through other tabs. These two plans fix the board's awareness of terminal liveness and worktree context so the board itself is the navigation hub.

## How the Subtasks Achieve This

- **Kanban Column Header Terminal Names → Locate Links**: Makes the terminal names in kanban column header sublines clickable locate links that focus the corresponding terminal, including a seniority-based dynamic route for the synthetic `CODED_AUTO` column (lead → coder → intern).
- **Kanban bottom-bar worktree indicator must reflect the active worktree (project/epic aware)**: Replaces the global "sole active worktree" indicator logic with a context-aware recompute that shows the selected epic's worktree, else the active project's worktree, else hides — matching the routing order prompts actually use.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Kanban bottom-bar worktree indicator must reflect the active worktree (project/epic aware)](../plans/feature_plan_20260703065346_kanban-worktree-indicator-context-aware.md) — **CODE REVIEWED**
- [ ] [Kanban Column Header Terminal Names → Locate Links](../plans/feature_plan_20260703130223_kanban-column-header-terminal-locate-links.md) — **CODE REVIEWED**
<!-- END SUBTASKS -->

## Dependencies & sequencing

No hard ordering constraints; subtasks can be executed in parallel. Both are confined to `src/webview/kanban.html` and touch different regions (column headers vs bottom bar). Both rely on already-available webview state (`lastTerminals`, `findTerminalByRole` pattern, `currentEpicWorktrees`, `activeProjectFilter`).
