# Starting a team happens in one place and seats the whole team

**Complexity:** 4

## Goal

Starting a team has two entry points and neither shows the result. The terminals panel's START TEAM button seats one head into whichever pane is focused, because the ptyStartTeam response never carries the team's group id and the client never switches to it. The board's TEAMS tab has a second start button in a panel with no grid at all, so a team started there appears nowhere. Return the group id and use the existing three-branch seating on the START TEAM path, and remove the start action from the TEAMS tab so it adopts and configures teams only.

## How the Subtasks Achieve This

- **START TEAM Seats One Head Into Whatever Grid Is Open Instead of Opening the Team's Own Grid**: Fixes the backend (returns `teamGroupId` from `instantiateAgentGroupCore`) and the webview (`startTeam` uses the existing three-branch seating block from the create path instead of `assignToFocusedPane`). This makes the terminals panel's START TEAM button seat the whole team in its own grid.
- **The TEAMS Tab Adopts Teams; It Does Not Start Them**: Removes the start action from the board's TEAMS tab (a panel with no terminal grid), keeping only the `USE` adopt button and a static hint pointing to the terminals panel. Eliminates the second entry point that could never show the result.

## Dependencies & sequencing

- Subtask 1 (START TEAM seating) should land first — it makes the terminals panel's START TEAM button actually seat the whole team. Without it, the TEAMS tab's hint "Start it from the terminals panel" points at a button that still only seats one head.
- Subtask 2 (TEAMS tab adopt-only) removes the broken second entry point. It depends on subtask 1 being correct so the remaining single entry point works as advertised.
- Both subtasks touch different files (subtask 1: `agentGroupInstantiation.ts` + `terminals.js`; subtask 2: `kanban.html`) — no file-level conflict, but the logical sequencing above matters for the operator experience.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [START TEAM Seats One Head Into Whatever Grid Is Open Instead of Opening the Team's Own Grid](../plans/feature_plan_20260817174451_start-team-seats-one-head-into-the-open-grid-instead-of-its-own.md) — **CODE REVIEWED** — ID: 2cb5cf9f-193f-4603-b4ce-9d8e6b88a5f4
- [ ] [The TEAMS Tab Adopts Teams; It Does Not Start Them](../plans/feature_plan_20260817174452_teams-tab-adopts-teams-it-does-not-start-them.md) — **CODE REVIEWED** — ID: dd048d30-3124-4d4e-a654-f78bab4aa4a5
<!-- END SUBTASKS -->

