# Per-Team Worktree Provisioning for Explicit Starts

## Goal

When multiple teams run in the same workspace, they share one working tree — parallel teams editing the same files produce dirty commits and conflict. A `startWorktree` field already exists on team definitions, but it is only exposed in the TEAMS tab under the START ON LOAD toggle and only read on the autostart path. Explicit starts (START TEAM from the terminals panel) never use it.

This plan makes per-team worktree provisioning a first-class option for **explicitly started** teams, so an operator can run multiple teams in parallel without dirty trees — each team gets its own git worktree, on a new branch based off the workspace's default branch.

## Background & Root Cause

- **`startWorktree` exists but is gated.** The field is on the team definition object (`group.startWorktree`), set via a text input in the TEAMS tab that only appears when `startOnLoad` is checked (kanban.html:5288–5298). It's a manual path string — no auto-provisioning. The autostart loop reads it (TaskViewerProvider.ts:13365, 13373) and passes it as `spawnCwd`/`payloadCwd`. The explicit `ptyStartTeam` verb path does NOT read `startWorktree` from the definition — it only accepts `cwd`/`parentRoot`/`worktreePath` from the wire payload (bootstrap.ts:1494).

- **The worktree creation infrastructure already exists.** `_createSafetyWorktree` (KanbanProvider.ts:14511) creates a git worktree beside the repo, handles branch-name collisions, and returns `{ branch, path }`. It requires a `baseBranch` parameter to branch from the correct base — all existing callers (KanbanProvider.ts:13636, 13677, 13715, 14354) call `_resolveDefaultBranch(workspaceRoot)` first and pass the result. The `worktrees` DB table (KanbanDatabase.ts:313) tracks worktrees with `branch`, `path`, `feature_id`, `project`, `status`, `base_branch`, `tier`. Cleanup is handled by `cleanupWorktree` / `abandonWorktree` verbs.

- **The `startTeamForWorkspace` flow passes `workspaceRoot` to the instantiator.** `startTeamForWorkspace` (TaskViewerProvider.ts:13234) resolves `spawnCwd` from `payloadCwd || parentRoot || pinnedRoot`, resolves the team definition via `resolveTeamByIdInRoots` (line 13253), then calls `startTeamById({ workspaceRoot: spawnCwd, ... })` (line 13259), which calls `instantiator(team, workspaceRoot)`. The instantiator (`instantiateAgentGroup`, TaskViewerProvider.ts:13398) passes `workspaceRoot` as `cwd` to `ptyCreateTerminal`. So the spawn directory is determined entirely by `spawnCwd` — if we provision a worktree and pass its path as `spawnCwd`, the team spawns there.

- **The standalone host uses a different path.** The `ptyStartTeam` verb handler (bootstrap.ts:1479) calls `kanbanProvider.startAgentGroupById(root, teamId, liveTerminals, spawnCwd)` (KanbanProvider.ts:4997), which calls `startTeamById` with `workspaceRoot: spawnCwd || workspaceRoot`. The verb handler does NOT resolve the team definition itself — `startTeamById` (teamWiring.ts:1328) resolves it internally via `resolveTeamById`.

- **The head-role double-start guard is role-based and global** (teamWiring.ts:1335–1349). It refuses if the head role is already live as an unparented terminal, regardless of workspace or worktree. This means two teams with the same head role still can't run simultaneously even in separate worktrees — the second start is refused. This is a backend limitation that this plan does NOT fix; it only addresses the dirty-tree problem for teams with **different** head roles (or the same head role when the first team is stopped).

## Metadata

**Complexity:** 5
**Tags:** backend, feature, ui, refactor
**Project:** Browser Switchboard

## User Review Required

This plan introduces a new `worktreeMode` field to team definitions and a new public method on KanbanProvider. The approach is sound and backward-compatible, but the operator should review:
- Whether the `worktreeMode: 'auto'` flag is the right abstraction vs. reusing `startWorktree`.
- Whether the head-role guard limitation (same head role can't run in parallel even with worktrees) is acceptable for the intended use case.
- Whether manual cleanup via the Worktrees tab is sufficient, or automatic cleanup on team stop should be prioritized as a follow-up.

## Complexity Audit

### Routine
- Adding a checkbox to the TEAMS tab team form (kanban.html) — follows the existing `startOnLoad` checkbox pattern.
- Adding a "WORKTREE" badge to the team gallery card — follows the existing "START ON LOAD" badge pattern.
- Adding `worktreeMode` to the save-agent-group carry-forward (kanban.html:6117) — same pattern as `startWorktree` carry-forward.
- The `worktrees` table already has a `tier` column (KanbanDatabase.ts:458, V42 migration) — no schema migration needed.
- `addWorktree` already accepts a `tier` parameter (KanbanDatabase.ts:4207) — no signature change needed.
- `_cleanupWorktree` (KanbanProvider.ts:14500) handles all worktrees uniformly — no cleanup code change needed.

### Complex / Risky
- **Cross-class access to `_createSafetyWorktree`.** It's a private method on KanbanProvider; the provisioning logic must be called from `startTeamForWorkspace` (TaskViewerProvider) and `startAgentGroupById` (KanbanProvider). Requires a new public wrapper method.
- **Standalone host team resolution.** The `ptyStartTeam` verb handler doesn't resolve the team definition — it delegates to `startAgentGroupById` → `startTeamById`. Adding the worktree check requires either resolving the team def in `startAgentGroupById` (before calling `startTeamById`) or in the verb handler itself.
- **Worktree proliferation.** Each explicit start with `worktreeMode: 'auto'` creates a new worktree. No automatic cleanup on team stop — worktrees accumulate until manually cleaned via the Worktrees tab.
- **`_resolveDefaultBranch` dependency.** Worktree creation must call `_resolveDefaultBranch` first to branch from the correct base; omitting it branches from HEAD (which may be a feature branch, not the default).

## Edge-Case & Dependency Audit

### Race Conditions
- **Concurrent team starts.** Two teams with `worktreeMode: 'auto'` started simultaneously could race on `_createSafetyWorktree`'s branch-name collision loop. The existing suffix-increment loop (KanbanProvider.ts:14664–14681) handles this — the second call sees the first's branch as "already exists" and increments. Safe.
- **Autostart + explicit start.** If a team with `startOnLoad` and `worktreeMode: 'auto'` is autostarted, then explicitly started again, the head-role guard refuses the second start. No double worktree. Safe.

### Security
- **Team name in branch slug.** `_createSafetyWorktree` slugifies the `featureTopic` (team name) via `s.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40)` (KanbanProvider.ts:14561). No path traversal possible — the slug is sanitized and the worktree path is constructed via `path.join(worktreesParent, branch)`. Safe.
- **`git worktree add` execution.** Uses `execFileAsync` (not shell), so the branch name and path are passed as args, not interpolated. Safe.

### Side Effects
- **Filesystem: new worktree directory.** Each provisioning creates a directory beside the repo under `worktrees/<repo-basename>/`. Cleaned up via `git worktree remove` in the Worktrees tab.
- **DB: new worktrees row.** Each provisioning inserts a row with `tier: 'team'`, `status: 'active'`. Cleaned up by marking `'merged'`.
- **Git: new branch.** Each provisioning creates a new branch. The branch persists after worktree removal (git keeps it); the operator can delete it manually if desired.

### Dependencies & Conflicts
- **`tier` column reuse.** The `tier` column (V42 migration, KanbanDatabase.ts:458) is described in code comments as "reserved for Part 3's high/low complexity split" (KanbanDatabase.ts:452). Reusing it with value `'team'` does not conflict with future `'high'`/`'low'` values — the column accepts arbitrary strings and the values are disjoint. However, any future code that filters by `tier IS NULL` to find "untyped" worktrees would need to account for `'team'` rows. Low risk.
- **`startWorktree` + `worktreeMode: 'auto'` both set.** `startWorktree` (explicit path) wins. The host checks `startWorktree` first; if set, it uses that path and skips auto-provisioning. This preserves backward compatibility with existing autostart configurations.
- **Published extension, ~4,000 installs.** The `worktreeMode` field is new and optional — absent means current behavior. No migration needed for the field itself (see Changes §1). The `tier: 'team'` value uses an existing column. No DB schema migration. Users on older versions who update see no change unless they explicitly opt in via the TEAMS tab.

## Dependencies

None — this plan is self-contained. It reuses existing infrastructure (`_createSafetyWorktree`, `_resolveDefaultBranch`, `addWorktree`, `_cleanupWorktree`, the `worktrees` table) without depending on other plans or sessions.

## Adversarial Synthesis

Key risks: (1) `addWorktree` call must include the 7th `tier` arg or the tier distinction is silently defeated; (2) `_resolveDefaultBranch` must be called before `_createSafetyWorktree` or the worktree branches from HEAD instead of the default branch; (3) the migration pass proposed in the original plan would cause a write-on-every-read — removed in favor of a simple `=== 'auto'` check; (4) "START ALL TEAMS" referenced in the original plan does not exist in the codebase — all references removed. Mitigations: corrected call signatures, public wrapper method on KanbanProvider, no migration pass, phantom feature references struck.

## Proposed Changes

### 1. Add `worktreeMode` field to team definitions (`kanban.html` + backend)

Add a new optional field `worktreeMode` to team definitions with two values:
- **`'none'`** (default, absent): Team spawns in the workspace root (current behavior).
- **`'auto'`**: On start, the host provisions a git worktree for the team and spawns all terminals there.

**Why not reuse `startWorktree`?** `startWorktree` is a manual path string tied to the autostart-only UI. `worktreeMode: 'auto'` is a declarative flag — "give me a worktree when this team starts" — that works for both autostart and explicit start. The two fields are independent: `startWorktree` can still point an autostart team at a pre-existing path, while `worktreeMode: 'auto'` tells the host to provision one. If both are set, `startWorktree` wins (explicit path beats auto-provisioned).

**TEAMS tab UI** — Add a checkbox in the team form (not gated behind START ON LOAD): "Spawn in own worktree". When checked, sets `worktreeMode: 'auto'` on the definition. When unchecked, deletes the key (absence = `'none'`, same pattern as `startOnLoad`).

**Save carry-forward** — Add `worktreeMode` to the save-agent-group carry-forward at kanban.html:6117, same pattern as the existing `startWorktree` carry-forward: `...(prevGroup?.worktreeMode ? { worktreeMode: prevGroup.worktreeMode } : {})`.

> **Superseded:** Add a migration pass in `migrateAgentGroups` that defaults `worktreeMode` to `'none'` when absent.
> **Reason:** `migrateAgentGroups` (teamWiring.ts:818) flags `changed = true` when setting a previously-absent field, causing the function to return a non-null array. Every caller that receives a non-null result persists it — this turns every read of every team without `worktreeMode` (all ~4,000 installs) into a write. The "no-op" claim was wrong.
> **Replaced with:** No migration pass. The start path checks `worktreeMode === 'auto'` — absence fails this check naturally and defaults to current behavior. No field normalization needed.

### 2. Add `provisionTeamWorktree` public method on KanbanProvider (`KanbanProvider.ts`)

> **Superseded:** Call `_createSafetyWorktree(workspaceRoot, team.name)` directly from `startTeamForWorkspace` (TaskViewerProvider.ts).
> **Reason:** `_createSafetyWorktree` is a `private` method on KanbanProvider (line 14511). `startTeamForWorkspace` is on TaskViewerProvider. While the codebase does cross this boundary for read paths (`_getScopedSetting`, `_projectTier`), calling a side-effectful filesystem operation through a private accessor is fragile. Additionally, the original call omitted `_resolveDefaultBranch` — without it, the worktree branches from HEAD (whatever branch is checked out), not from the default branch as the Goal requires.
> **Replaced with:** A new public method `provisionTeamWorktree(workspaceRoot: string, teamName: string): Promise<{ branch: string; path: string } | null>` on KanbanProvider that:
> 1. Calls `_resolveDefaultBranch(workspaceRoot)` to get the base branch.
> 2. Calls `_createSafetyWorktree(workspaceRoot, teamName, undefined, defaultBranch)` — team name is used as `featureTopic` for branch slugification (same as feature worktrees use the feature topic).
> 3. Calls `db.addWorktree(branch, wtPath, undefined, undefined, undefined, defaultBranch, 'team')` — the 7th argument `'team'` is the `tier` value. **Critical:** the `addWorktree` signature (KanbanDatabase.ts:4207) is `(branch, wtPath, featureId?, project?, subtaskPlanId?, baseBranch?, tier?)` — omitting the 7th arg inserts `tier: NULL`, defeating the tier distinction.
> 4. Returns `{ branch, path }` on success, `null` on failure (logs a warning, does not throw).
> 5. Gets the DB via `this._getKanbanDb(workspaceRoot)`.

**Context:** Both the extension host and standalone host call this method. It encapsulates the three-step provisioning (resolve default branch → create worktree → register in DB) behind one public interface, so neither host needs to reach into KanbanProvider's privates.

### 3. Provision worktree on explicit team start — extension host (`TaskViewerProvider.ts`)

In `startTeamForWorkspace` (TaskViewerProvider.ts:13234), after resolving the team definition at line 13253 but before calling `startTeamById` at line 13259:

1. Check if `match.team.worktreeMode === 'auto'` AND `match.team.startWorktree` is not set (explicit path wins).
2. If so, call `this._kanbanProvider?.provisionTeamWorktree(match.root, match.team.name)` to provision a worktree.
3. If the result is non-null, set `spawnCwd` to the worktree path (overriding the resolved `spawnCwd`).
4. If the result is null (provisioning failed), fall back to the existing `spawnCwd` (don't block the team start) — the warning is already logged inside `provisionTeamWorktree`.
5. Pass the final `spawnCwd` to `startTeamById` as `workspaceRoot`.

**Context:** `startTeamForWorkspace` already has `this._kanbanProvider` (TaskViewerProvider.ts:1558) and already resolves the team definition (line 13253). The worktree check slots in between these two existing steps. No new imports or references needed.

### 4. Provision worktree on explicit team start — standalone host (`KanbanProvider.ts` + `bootstrap.ts`)

> **Superseded:** Mirror the same logic in bootstrap.ts's `ptyStartTeam` verb handler (line 1446), which currently passes `spawnCwd` from `payload.cwd || payload.parentRoot`. Add the same `worktreeMode === 'auto'` check after resolving the team definition, before calling `startAgentGroupById`.
> **Reason:** The `ptyStartTeam` verb handler (bootstrap.ts:1479) does NOT resolve the team definition — it delegates to `kanbanProvider.startAgentGroupById(root, teamId, liveTerminals, spawnCwd)`, which calls `startTeamById` internally. Adding the worktree check in the verb handler would require duplicating team resolution. The verb handler also doesn't have direct access to `_createSafetyWorktree` or the DB.
> **Replaced with:** Add the worktree check inside `startAgentGroupById` (KanbanProvider.ts:4997). This method already has DB access (`this._getKanbanDb`) and calls `startTeamById`. Before calling `startTeamById`:
> 1. Resolve the team definition via `resolveTeamById(db, teamId)` (same function `startTeamById` uses internally — teamWiring.ts:1132).
> 2. If the team has `worktreeMode === 'auto'` and no `startWorktree`, call `this.provisionTeamWorktree(workspaceRoot, team.name)`.
> 3. If the result is non-null, pass the worktree path as `workspaceRoot` to `startTeamById` instead of `spawnCwd || workspaceRoot`.
> 4. If null, proceed with the existing `spawnCwd || workspaceRoot` (fallback).
>
> This means the team definition is resolved twice (once in `startAgentGroupById` for the worktree check, once in `startTeamById` for the actual start). This is a minor inefficiency — `resolveTeamById` is a DB read + in-memory migration, not expensive. The alternative (passing the resolved team into `startTeamById`) would require widening `startTeamById`'s contract, which is shared and has multiple callers.

**START ALL TEAMS** — removed. This feature does not exist in the codebase. The `startTeam` function in terminals.js (line 8365) sends `{ teamId, parentRoot }` for a single team start from the terminals panel form. There is no "START ALL TEAMS" control. The autostart path (`startTeamsOnLoad`) already reads `startWorktree` and is not affected by this plan.

> **Superseded:** START ALL TEAMS — The terminals.js `startTeam` function (line 8168) sends `{ teamId, parentRoot }` to the verb. The backend resolves the team definition and checks `worktreeMode` — so START ALL TEAMS automatically gets worktree provisioning per team without any frontend change.
> **Reason:** "START ALL TEAMS" does not exist in the codebase. No such button exists in `kanban.html` or `terminals.js`. The `startTeam` function at terminals.js:8365 is for a single team start from the START TEAM form. The autostart path (`startTeamsOnLoad`) is a separate mechanism that already reads `startWorktree`. The phantom feature reference was a factual error.
> **Replaced with:** No change. The explicit start path (START TEAM from the terminals panel) is the only explicit start surface. The autostart path already handles `startWorktree`. Both paths are covered by Changes §3 and §4.

### 5. Add `tier: 'team'` to the worktrees table (`KanbanDatabase.ts`)

The `worktrees` table already has a `tier` column (V42 migration, KanbanDatabase.ts:458). The column is described in code comments as "reserved for Part 3's high/low complexity split" (KanbanDatabase.ts:452) — it is **reserved**, not retired. Reusing it with value `'team'` is safe: the column accepts arbitrary strings, and `'team'` is disjoint from any future `'high'`/`'low'` values. The existing `getWorktrees()` SELECT (KanbanDatabase.ts:4182) already includes `tier` in its column list. The `addWorktree` method (KanbanDatabase.ts:4207) already accepts `tier` as its 7th parameter. No schema migration needed.

**`addWorktree` call** — Pass `tier: 'team'` as the 7th argument when registering a team worktree (inside `provisionTeamWorktree`, Changes §2). The full call: `db.addWorktree(branch, wtPath, undefined, undefined, undefined, defaultBranch, 'team')`.

### 6. Team worktree cleanup (`KanbanProvider.ts`)

When a team is stopped (all members closed), its worktree should be cleanable. Two paths:

**Manual cleanup via Worktrees tab** — Team worktrees appear in the Worktrees tab (they're in the `worktrees` table with `status: 'active'`, `tier: 'team'`). The existing `cleanupWorktree` verb calls `_cleanupWorktree` (KanbanProvider.ts:14500), which handles all worktrees uniformly — it calls `_removeWorktreeRow` (marks `'merged'`) and `_pruneWorktrees` (runs `git worktree prune`). There is no branch on `feature_id` or `tier` — all worktrees go through the same path. Team worktrees (no `feature_id`, `tier: 'team'`) are cleanable with no code change.

**Automatic cleanup on team stop (future consideration)** — Not in this plan. Closing all team terminals doesn't currently trigger any backend cleanup (the terminals just exit). Adding auto-cleanup would require tracking which worktree belongs to which team group and cleaning up when the last member exits. This is a separate concern — the manual path via the Worktrees tab is sufficient for now, and matches how feature worktrees work (manual cleanup via the Worktrees tab or feature completion).

### 7. Surface worktree status in the TEAMS tab (`kanban.html`)

In the team gallery card, show a small badge when `worktreeMode: 'auto'` is set: "WORKTREE" — same visual style as the existing "START ON LOAD" badge (kanban.html:5267–5316). This makes it visible at a glance which teams will provision their own worktree.

No change to the terminals sidebar — the sidebar shows running terminals, not team definitions. The worktree path is visible in each terminal's tooltip/subline (terminals spawned in a worktree already show the worktree path in their `parentRoot`).

## Verification Plan

### Automated Tests
- **Worktree provisioning on explicit start:** Define a team with `worktreeMode: 'auto'`. Click START TEAM. Verify a new git worktree is created (`git worktree list` and the Worktrees tab). Verify terminals spawn with `cwd` pointing to the worktree path. Verify the worktree branch is named after the team (slugified). Verify the worktrees DB row has `tier: 'team'` and `base_branch` set to the default branch.
- **START ALL TEAMS with mixed worktree modes:** N/A — this feature does not exist. Replaced with: define two teams, one with `worktreeMode: 'auto'`, one without. Start each via START TEAM. Verify the first gets a worktree, the second spawns in the workspace root.
- **Worktree cleanup:** Start a team with `worktreeMode: 'auto'`. Stop all its terminals. Open the Worktrees tab. Verify the team worktree appears with `tier: 'team'`. Click cleanup. Verify `git worktree remove` runs and the row is marked `'merged'`.
- **Fallback on worktree creation failure:** In a non-git workspace, define a team with `worktreeMode: 'auto'`. Click START TEAM. Verify the team starts in the workspace root (fallback) and a warning is logged.
- **Backward compatibility:** Existing teams without `worktreeMode` start normally in the workspace root — no behavior change. Existing teams with `startWorktree` set (autostart path) still use the explicit path — `worktreeMode: 'auto'` is not consulted when `startWorktree` is set.
- **TEAMS tab UI:** Verify the "Spawn in own worktree" checkbox appears in the team form (not gated behind START ON LOAD). Check it, save the team, reopen the form — verify the checkbox reflects the saved state. Verify the "WORKTREE" badge appears on the gallery card.
- **No confirm dialogs:** Verify no `confirm()`, `showWarningMessage`, or two-click patterns were introduced (CLAUDE.md rule).
- **No migration write-on-read:** Verify `migrateAgentGroups` does NOT set `worktreeMode` on existing teams — the field stays absent and the start path checks `=== 'auto'`.

### Goal Invariants
- Assert `provisionTeamWorktree` method exists on `KanbanProvider` at `src/services/KanbanProvider.ts` and is `public`.
- Assert `provisionTeamWorktree` calls `_resolveDefaultBranch` before `_createSafetyWorktree` (grep for the call sequence in the method body).
- Assert `addWorktree` call inside `provisionTeamWorktree` passes 7 arguments, with the 7th being `'team'` (string literal).
- Assert `startTeamForWorkspace` (TaskViewerProvider.ts) checks `match.team.worktreeMode === 'auto'` after team resolution and before `startTeamById` call.
- Assert `startAgentGroupById` (KanbanProvider.ts) checks `worktreeMode === 'auto'` before calling `startTeamById`.
- Assert `migrateAgentGroups` (teamWiring.ts) does NOT reference `worktreeMode` — the field is never normalized in the migration pass.
- Assert no reference to "START ALL TEAMS" exists in the plan's code changes (the feature does not exist).
- Assert the "Spawn in own worktree" checkbox in kanban.html is NOT gated behind the `startOnLoad` toggle (i.e., it appears regardless of whether START ON LOAD is checked).

## Implementation Summary

Added the `provisionTeamWorktree` public method to `KanbanProvider` which resolves the default branch, invokes `_createSafetyWorktree`, and registers the worktree in the database with `tier: 'team'`.
Updated `startTeamForWorkspace` in `TaskViewerProvider` and `startAgentGroupById` in `KanbanProvider` to check `worktreeMode === 'auto'` and route the team's spawn directory to the newly provisioned worktree when no explicit `startWorktree` path is configured.
Enhanced `kanban.html` with a 'Spawn in own worktree' checkbox in the team configuration form, added `worktreeMode` carry-forward handling during saves, and rendered a 'WORKTREE' badge on gallery cards for teams configured with automatic worktree provisioning.

## Review Findings

Reviewed commit `c5590f06`. File changed by this review: `src/services/KanbanProvider.ts` — `provisionTeamWorktree` was the only `addWorktree` caller that never re-broadcast the worktree config (the other three at :13819, :13851, :13882 all follow with `_refreshBoard`), so a provisioned team worktree stayed invisible in the WORKTREES tab, which renders from the cached `worktreeConfig`; a best-effort `_sendWorktreeConfig` now runs after the insert and cannot fail the team start. Everything else matches the plan: the method is public, calls `_resolveDefaultBranch` before `_createSafetyWorktree`, passes `'team'` as `addWorktree`'s 7th argument, and both hosts are wired (`startTeamForWorkspace` for the extension, `startAgentGroupById` for standalone) with no double-provisioning, since the two arms are mutually exclusive by host split. `migrateAgentGroups` does not reference `worktreeMode`, so the write-on-read the plan struck is genuinely absent, and the TEAMS tab checkbox sits outside the START ON LOAD gate as required. Validation: `tsc -p tsconfig.test.json --noEmit` clean, eslint 0 errors, feature-worktree-guardrail, worktree-strategy-control, team-autostart-scope (21/21) and atomic-team-lifecycle all green. Remaining risk: the worktree-proliferation behaviour on the autostart path, below.

## Deferred Findings

- MAJOR — The `worktreeMode === 'auto'` check also fires on the autostart path (`startTeamsOnLoad` reaches both arms), so an autostart team with the checkbox set cuts a fresh branch and worktree directory on every window open, with no reuse and no auto-cleanup. Plan §1 deliberately made the flag apply to both paths and the Side Effects section accepted proliferation, so narrowing it to explicit starts is the author's decision, not the reviewer's. `src/services/TaskViewerProvider.ts:12884`
- MAJOR — None of this plan's Goal Invariants were written as automated assertions; nothing pins the 7-argument `addWorktree` call, the `_resolveDefaultBranch`-before-`_createSafetyWorktree` ordering, or the `worktreeMode === 'auto'` check on either host, so a later refactor can silently drop the `'team'` tier or branch from HEAD. `src/services/KanbanProvider.ts:14732`
- NIT — `provisionTeamWorktree` slugifies the team name to at most 40 characters, so two teams whose names share a 40-character prefix produce `<slug>` and `<slug>-2` and are indistinguishable in the WORKTREES tab, which has no team column. `src/services/KanbanProvider.ts:14740`
- NIT — `addWorktree` inserts `agents_open_with_grid = 1` unconditionally, so a team worktree arrives with the per-row Agent-terminals checkbox already on; harmless here because the team spawns its own terminals there, but it means the main-repo suppress setting has a second consumer nobody chose. `src/services/KanbanDatabase.ts:4224`
