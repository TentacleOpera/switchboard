# Starting a team happens in one place and seats the whole team

**Complexity:** 4

## Goal

Starting a team has two entry points and neither shows the result. The terminals panel's START TEAM button seats one head into whichever pane is focused, because the ptyStartTeam response never carries the team's group id and the client never switches to it. The board's TEAMS tab has a second start button in a panel with no grid at all, so a team started there appears nowhere. Return the group id and use the existing three-branch seating on the START TEAM path, and remove the start action from the TEAMS tab so it adopts and configures teams only.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [START TEAM Seats One Head Into Whatever Grid Is Open Instead of Opening the Team's Own Grid](../plans/feature_plan_20260817174451_start-team-seats-one-head-into-the-open-grid-instead-of-its-own.md) — **CREATED**
- [ ] [The TEAMS Tab Adopts Teams; It Does Not Start Them](../plans/feature_plan_20260817174452_teams-tab-adopts-teams-it-does-not-start-them.md) — **CREATED**
<!-- END SUBTASKS -->
