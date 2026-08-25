# Per-Team Worktree Provisioning for Explicit Starts

## Goal

When multiple teams run in the same workspace, they share one working tree — parallel teams editing the same files produce dirty commits and conflict. A `startWorktree` field already exists on team definitions, but it is only exposed in the TEAMS tab under the START ON LOAD toggle and only read on the autostart path. Explicit starts (START TEAM, START ALL TEAMS) never use it.

This plan makes per-team worktree provisioning a first-class option for **explicitly started** teams, so an operator can run multiple teams in parallel without dirty trees — each team gets its own git worktree, spawned from the workspace's default branch.

## Background & Root Cause

- **`startWorktree` exists but is gated.** The field is on the team definition object (`group.startWorktree`), set via a text input in the TEAMS tab that only appears when `startOnLoad` is checked (kanban.html:5278–5292). It's a manual path string — no auto-provisioning. The autostart loop reads it (TaskViewerProvider.ts:13250, 13258) and passes it as `spawnCwd`/`payloadCwd`. The explicit `ptyStartTeam` verb path does NOT read `startWorktree` from the definition — it only accepts `cwd`/`parentRoot`/`worktreePath` from the wire payload.

- **The worktree creation infrastructure already exists.** `_createSafetyWorktree` (KanbanProvider.ts:14188) creates a git worktree beside the repo, handles branch-name collisions, and returns `{ branch, path }`. The `worktrees` DB table (KanbanDatabase.ts:4120) tracks worktrees with `branch`, `path`, `feature_id`, `project`, `status`, `base_branch`. Cleanup is handled by `cleanupWorktree` / `abandonWorktree` verbs.

- **The `startTeamById` flow passes `workspaceRoot` to the instantiator.** `startTeamForWorkspace` (TaskViewerProvider.ts:13149) resolves `spawnCwd` from `payloadCwd || parentRoot || pinnedRoot`, then calls `startTeamById({ workspaceRoot: spawnCwd, ... })`, which calls `instantiator(team, workspaceRoot)`. The instantiator (`instantiateAgentGroup`, TaskViewerProvider.ts:13313) passes `workspaceRoot` as `cwd` to `instantiateAgentGroupCore`, which passes it to `ptyCreateTerminal` as the terminal's `cwd`. So the spawn directory is determined entirely by `spawnCwd` — if we provision a worktree and pass its path as `spawnCwd`, the team spawns there.

- **The head-role double-start guard is role-based and global** (teamWiring.ts:1927–1934). It refuses if the head role is already live as an unparented terminal, regardless of workspace or worktree. This means two teams with the same head role still can't run simultaneously even in separate worktrees — the second start is refused. This is a backend limitation that this plan does NOT fix; it only addresses the dirty-tree problem for teams with **different** head roles (or the same head role when the first team is stopped).

## Changes

### 1. Add `worktreeMode` field to team definitions (`kanban.html` + backend)

Add a new optional field `worktreeMode` to team definitions with two values:
- **`'none'`** (default, absent): Team spawns in the workspace root (current behavior).
- **`'auto'`**: On start, the host provisions a git worktree for the team and spawns all terminals there.

**Why not reuse `startWorktree`?** `startWorktree` is a manual path string tied to the autostart-only UI. `worktreeMode: 'auto'` is a declarative flag — "give me a worktree when this team starts" — that works for both autostart and explicit start. The two fields are independent: `startWorktree` can still point a autostart team at a pre-existing path, while `worktreeMode: 'auto'` tells the host to provision one. If both are set, `startWorktree` wins (explicit path beats auto-provisioned).

**TEAMS tab UI** — Add a checkbox in the team form (not gated behind START ON LOAD): "Spawn in own worktree". When checked, sets `worktreeMode: 'auto'` on the definition. When unchecked, deletes the key (absence = `'none'`, same pattern as `startOnLoad`).

**Migration** — `migrateAgentGroups` (teamWiring.ts) already runs on every read. Add a pass that defaults `worktreeMode` to `'none'` when absent (no-op — absence is already the default). No DB schema change needed; the field lives in the `terminals.agentGroups` config JSON, same as `startOnLoad`, `startWorktree`, `pacing`, `icon`.

### 2. Provision worktree on explicit team start (`TaskViewerProvider.ts` + `bootstrap.ts`)

In `startTeamForWorkspace` (TaskViewerProvider.ts:13149), after resolving the team definition but before calling `startTeamById`:

1. Check if `match.team.worktreeMode === 'auto'` AND `match.team.startWorktree` is not set (explicit path wins).
2. If so, call `_createSafetyWorktree(workspaceRoot, team.name)` to provision a worktree. The team name is used as the `featureTopic` for branch slugification (same as feature worktrees use the feature topic).
3. Register the worktree in the DB via `db.addWorktree(branch, wtPath, undefined, undefined, undefined, defaultBranch)` — no `feature_id` or `project`, but a new `tier` value `'team'` to distinguish team worktrees from feature/project worktrees.
4. Pass `wtPath` as `spawnCwd` to `startTeamById` instead of the resolved `spawnCwd`.
5. If worktree creation fails, fall back to spawning in the workspace root (don't block the team start) and log a warning.

**Standalone host** — Mirror the same logic in `bootstrap.ts`'s `ptyStartTeam` verb handler (line 1446), which currently passes `spawnCwd` from `payload.cwd || payload.parentRoot`. Add the same `worktreeMode === 'auto'` check after resolving the team definition, before calling `startAgentGroupById`.

**START ALL TEAMS** — The terminals.js `startTeam` function (line 8168) sends `{ teamId, parentRoot }` to the verb. The backend resolves the team definition and checks `worktreeMode` — so START ALL TEAMS automatically gets worktree provisioning per team without any frontend change. Each team with `worktreeMode: 'auto'` gets its own worktree; teams without it spawn in the workspace root.

### 3. Add `tier: 'team'` to the worktrees table (`KanbanDatabase.ts`)

The `worktrees` table already has a `tier` column (used historically for subtask tiers, now retired). Reusing it with value `'team'` distinguishes team worktrees from feature/project worktrees in cleanup and display logic. No schema migration needed — the column exists and accepts arbitrary strings.

**`addWorktree` call** — Pass `tier: 'team'` when registering a team worktree. The existing `getWorktrees()` SELECT already includes `tier` in its column list.

### 4. Team worktree cleanup (`KanbanProvider.ts`)

When a team is stopped (all members closed), its worktree should be cleanable. Two paths:

**Manual cleanup via Worktrees tab** — Team worktrees appear in the Worktrees tab (they're in the `worktrees` table with `status: 'active'`). The existing `cleanupWorktree` verb already handles plain/project worktrees (KanbanProvider.ts:14182–14185) — the "plain/project worktree" branch runs `git worktree remove` and marks the row `'merged'`. Team worktrees (no `feature_id`, `tier: 'team'`) fall through to this same branch, so they're cleanable with no code change.

**Automatic cleanup on team stop (future consideration)** — Not in this plan. Closing all team terminals doesn't currently trigger any backend cleanup (the terminals just exit). Adding auto-cleanup would require tracking which worktree belongs to which team group and cleaning up when the last member exits. This is a separate concern — the manual path via the Worktrees tab is sufficient for now, and matches how feature worktrees work (manual cleanup via the Worktrees tab or feature completion).

### 5. Surface worktree status in the TEAMS tab (`kanban.html`)

In the team gallery card, show a small badge when `worktreeMode: 'auto'` is set: "WORKTREE" — same visual style as the existing "START ON LOAD" badge. This makes it visible at a glance which teams will provision their own worktree.

No change to the terminals sidebar — the sidebar shows running terminals, not team definitions. The worktree path is visible in each terminal's tooltip/subline (terminals spawned in a worktree already show the worktree path in their `parentRoot`).

## Edge Cases & Risks

- **Head-role collision across worktrees.** Two teams with the same head role and `worktreeMode: 'auto'` still can't run simultaneously — the backend's head-role guard is global. The second start is refused regardless of worktree. This plan does not fix that; it only solves the dirty-tree problem for teams with different head roles.
- **Worktree creation failure.** If `git worktree add` fails (e.g., not a git repo, disk full, branch conflict), the team falls back to spawning in the workspace root. A warning is logged. The operator sees the team running without a worktree — same as today.
- **Non-git workspace.** `_createSafetyWorktree` checks for `.git` and throws if absent. The fallback to workspace root handles this — the team starts normally without a worktree.
- **Worktree proliferation.** Each team start with `worktreeMode: 'auto'` creates a new worktree. If the operator starts and stops teams repeatedly without cleanup, worktrees accumulate. The Worktrees tab provides manual cleanup. A future enhancement could detect stale team worktrees (no active terminals, `tier: 'team'`) and offer cleanup.
- **`startWorktree` + `worktreeMode: 'auto'` both set.** `startWorktree` (explicit path) wins. The host checks `startWorktree` first; if set, it uses that path and skips auto-provisioning. This preserves backward compatibility with existing autostart configurations.
- **Published extension, ~4,000 installs.** The `worktreeMode` field is new and optional — absent means `'none'` (current behavior). No migration needed for the field itself. The `tier: 'team'` value in the worktrees table uses an existing column. No DB schema migration. Users on older versions who update see no change unless they explicitly opt in via the TEAMS tab.
- **Standalone host parity.** Both `startTeamForWorkspace` (extension host) and the `ptyStartTeam` verb handler (bootstrap.ts) must implement the same `worktreeMode` check. The standalone host has access to `_createSafetyWorktree` via `kanbanProvider` and to `db.addWorktree` via the same DB handle.

## Verification Plan

1. **Worktree provisioning on explicit start:**
   - Define a team with `worktreeMode: 'auto'` in the TEAMS tab.
   - Click START TEAM. Verify a new git worktree is created (check `git worktree list` and the Worktrees tab).
   - Verify the team's terminals spawn with `cwd` pointing to the worktree path, not the workspace root.
   - Verify the worktree branch is named after the team (slugified).

2. **START ALL TEAMS with mixed worktree modes:**
   - Define two teams: one with `worktreeMode: 'auto'`, one without.
   - Click START ALL TEAMS. Verify the first team gets a worktree, the second spawns in the workspace root.

3. **Worktree cleanup:**
   - Start a team with `worktreeMode: 'auto'`. Stop all its terminals.
   - Open the Worktrees tab. Verify the team worktree appears with `tier: 'team'`.
   - Click cleanup. Verify `git worktree remove` runs and the row is marked `'merged'`.

4. **Fallback on worktree creation failure:**
   - In a non-git workspace, define a team with `worktreeMode: 'auto'`.
   - Click START TEAM. Verify the team starts in the workspace root (fallback) and a warning is logged.

5. **Backward compatibility:**
   - Existing teams without `worktreeMode` start normally in the workspace root — no behavior change.
   - Existing teams with `startWorktree` set (autostart path) still use the explicit path — `worktreeMode: 'auto'` is not consulted when `startWorktree` is set.

6. **TEAMS tab UI:**
   - Verify the "Spawn in own worktree" checkbox appears in the team form (not gated behind START ON LOAD).
   - Check it, save the team, reopen the form — verify the checkbox reflects the saved state.
   - Verify the "WORKTREE" badge appears on the gallery card.

7. **No confirm dialogs:** Verify no `confirm()`, `showWarningMessage`, or two-click patterns were introduced (CLAUDE.md rule).

## Metadata

**Complexity:** 5
**Tags:** backend, feature, ui, ux, refactor
**Project:** Browser Switchboard
