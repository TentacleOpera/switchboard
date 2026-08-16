# Teams Start Themselves on Load

## Goal

Mark a team **start on load** and it comes up on its own when Switchboard opens — head and members spawned and seated in the terminal grid. More than one team can be marked. A marked team can optionally name a worktree to come up in; by default it does not, and comes up in the workspace root.

### Why

Every session begins the same way: open the app, open terminals, start a team, wait for it to seat, then begin. The configuration for all of that already exists and is already persisted — it just does not act until a human clicks. Nothing about "which teams do I run" changes day to day, so the click is pure ceremony.

An explicit start path already exists (`ptyStartTeam` → `startTeamById`), and it already reconciles a double-start. Boot-time start is that same call, made by the host instead of by a click.

## What changes

**On a team, two new fields.** Added to the team definition in `terminals.agentGroups`:

- `startOnLoad: boolean` — default `false`.
- `startWorktree?: string` — absent by default. When set, the team spawns there instead of the workspace root.

This is shipped state on ~4,000 installs, so both are additive and absence means off. Teams saved before this change read as `startOnLoad: false` with no migration pass, and every unknown key in the stored definition is preserved on write.

**On the TEAMS tab**, on each team: a `START ON LOAD` toggle, and when it is on, an optional worktree field that is empty unless the operator fills it. Empty is the normal case and should read that way — no placeholder implying a worktree is expected.

**On boot**, after the API server is up and the terminals surface is ready, the host reads the teams for the workspace, takes those with `startOnLoad === true`, and calls the existing `startTeamById` for each — the same entry point the START button uses, with `workspaceRoot` set to `startWorktree` when present and the workspace root otherwise. Teams start in the order they appear in the definitions list.

If a team's head is already live — a reload, a second window — `startTeamById` already reconciles that. No new liveness check.

If one team fails to start, the others still start, and the failure surfaces the same way a failed manual START does. Boot never blocks on it.

## Prerequisite

`ptyStartTeam` currently resolves team definitions from a single root (`TaskViewerProvider.ts:2602`, `root || effectiveRoot`) while the TEAMS tab writes to the board's selected root. In a multi-root window those differ, and start finds the wrong team or none. Autostart calls the same path and inherits it exactly.

Fix that first — it is already planned and evidenced in `feature_plan_20260816212416_team-verbs-read-the-wrong-workspace-db.md`. This plan does not re-solve it and does not work around it.

## Metadata

**Complexity:** 3
**Tags:** feature, backend, ui

## Verification Plan

1. Mark Coding as start-on-load, close, reopen — a lead, three coders and a reviewer come up seated, with no clicks.
2. Mark a second team as well, reopen — both come up.
3. Leave the worktree field empty: the team spawns in the workspace root.
4. Set a worktree on one team, reopen: that team spawns there, the other still in the root.
5. Open a second window on the same workspace — no duplicate team, no second set of terminals.
6. Give one marked team a deliberately bad worktree path: it fails, the other team still comes up, and the failure is visible.
7. Load a workspace whose teams were saved before this change — everything behaves as it did, nothing autostarts.
