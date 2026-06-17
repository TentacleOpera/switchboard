# Fix Worktree Creation in Control Plane Directories

## Goal

Fix the bug where creating a worktree using the "CREATE WORKTREE" button in kanban.html fails when the user is in a control plane directory with a repo scope filter active. The error is:

```
Failed to create worktree: Command failed: git worktree add -b worktree-2026-06-17 /Users/patrickvuleta/Documents/worktrees/worktree-2026-06-17 fatal: not a git repository (or any of the parent directories): .git
```

**Problem Analysis**

**Root Cause**: When a user is in a control plane directory (e.g., `/Users/patrickvuleta/Documents/Gitlab`) and has selected a child workspace (e.g., "ai", "be", "fe"), the `workspaceRoot` parameter passed to `_createSafetyWorktree` is the control plane root itself, which is not a git repository. The code attempts to run `git worktree add` from this non-git directory, causing the command to fail.

**Background**: The code in `KanbanProvider.ts` at line 6823-6824 has a comment stating "CRITICAL: git worktree add MUST run from workspaceRoot (the git repo), not the control plane root", but the implementation does not account for the case where `workspaceRoot` is the control plane root (non-git) and a repo scope filter is active.

**Current Flow**:
1. User clicks "CREATE WORKTREE" button in kanban.html
2. Message `createWorktree` is sent with `workspaceRoot: currentWorkspaceRoot`
3. `_resolveWorkspaceRoot` returns the control plane root (e.g., `/Users/patrickvuleta/Documents/Gitlab`)
4. `_createSafetyWorktree` receives this non-git directory as `workspaceRoot`
5. `git worktree add` is executed with `cwd: workspaceRoot` (the control plane root)
6. Git fails because the control plane root is not a git repository

**Expected Flow**:
1. When in a control plane directory, the Worktrees tab displays a dropdown listing all child git repositories detected under the control plane root
2. The dropdown defaults to the currently selected repo scope filter (or the only detected repo if one exists)
3. User can override the default by selecting a different repo from the dropdown
4. When user clicks "CREATE WORKTREE", the selected repo path is passed to the extension
5. `git worktree add` runs from the explicitly selected git repository path
6. Worktree is created successfully

## Metadata

**Tags:** bugfix, backend, frontend, ui

**Complexity:** 5

## User Review Required

None

## Complexity Audit

### Routine
- Backend: single method change in `src/services/KanbanProvider.ts` to accept an explicit repo path
- Frontend: standard DOM select element in existing `createWorktreesPanel` function
- Reuses existing `worktreeConfig` message channel and `_repoScopeFilter` state

### Complex / Risky
- Detecting child git repositories under a control plane root requires scanning directories, which can be slow on large workspaces. Mitigation: scan once when the worktree tab is opened, cache in `lastWorktreeConfig`, and limit to immediate children only.
- Dropdown state must sync with workspace selection changes (repo scope filter can change while the worktree tab is already open). Mitigation: re-scan and re-render dropdown on `loadWorktreeConfig` (already called when tab is activated).
- Non-control-plane mode must hide the dropdown entirely to avoid confusing users in single-repo contexts.

## Edge-Case & Dependency Audit

- **Race Conditions:** None. `_repoScopeFilter` is read synchronously from instance state; no concurrent mutation during worktree creation.
- **Security:** Child repo paths are discovered via filesystem scan under the control plane root, not user-provided. No path-traversal risk. The selected repo value from the dropdown is validated to exist within the control plane root before use.
- **Side Effects:** Worktree directory creation on disk; no database or configuration changes beyond the existing worktree registry entry.
- **Dependencies & Conflicts:** None. The change is localized to `_createSafetyWorktree` and the worktree tab renderer and does not affect control-plane resolution, board refresh, or other subsystems.

## Dependencies

None

## Adversarial Synthesis

Key risks: (1) auto-detected child repos may miss a repo if it is nested deeper than one level or if the `.git` directory is not present at scan time; (2) the dropdown default may not match the user's intent if they switched workspace selections after opening the worktree tab; (3) in non-control-plane mode, the dropdown should be hidden but a stale `lastWorktreeConfig` from a previous control-plane session could briefly show it. Mitigations: scan immediate children only (document the limitation), always re-scan on tab activation, and gate dropdown visibility on `controlPlaneMode === 'explicit'`. The explicit user selection via dropdown eliminates the silent auto-detection failure that caused the original bug.

## Proposed Changes

### `src/webview/kanban.html`

- **Context:** `createWorktreesPanel` (line 8183) renders the WORKTREES tab. Currently it shows only a "CREATE WORKTREE" button with no repo selection.
- **Logic:** Add a `<select>` dropdown above the CREATE WORKTREE button when in explicit control-plane mode. The dropdown lists all immediate child directories of the control plane root that contain a `.git` subdirectory. The selected value defaults to the currently active repo scope filter, or the first detected repo if none is active.
- **Implementation:**
  1. Extend `worktreeConfig` message payload (sent by `_sendWorktreeConfig`) to include `availableRepos: string[]` — an array of child directory names under the control plane root that are git repositories.
  2. In `createWorktreesPanel`, check `config.controlPlaneMode`. If `'explicit'` and `availableRepos.length > 0`, render a `<select>` element with options populated from `availableRepos`. Default selected option to `config.activeRepoFilter` (the current repo scope filter) or the first item.
  3. Store the selected repo value in a module-level variable `selectedWorktreeRepo`.
  4. Pass `selectedWorktreeRepo` in the `createWorktree` message payload: `postKanbanMessage({ type: 'createWorktree', workspaceRoot: currentWorkspaceRoot, repoName: selectedWorktreeRepo })`.
  5. Apply existing `.db-subsection` and label styling for consistency with the rest of the panel.
- **Edge Cases:**
  - `controlPlaneMode` is `'auto'` or `'none'` → do not render the dropdown; behavior identical to today.
  - `availableRepos` is empty → render the dropdown with a single "No git repositories detected" disabled option and disable the CREATE WORKTREE button with a tooltip explaining why.
  - User changes workspace selection while worktree tab is open → `loadWorktreeConfig` is called on tab re-activation, which refreshes `availableRepos` and re-renders the dropdown.

### `src/services/KanbanProvider.ts`

- **Context:** `_createSafetyWorktree` (line 6793) and `_sendWorktreeConfig` (line 6837). The method currently uses `workspaceRoot` as the `cwd` for `git worktree add` (line 6824). In explicit control-plane mode, `workspaceRoot` is the control plane root, which is not a git repository.
- **Logic for `_sendWorktreeConfig`:**
  1. After obtaining `cpStatus`, if `cpStatus.mode === 'explicit'`, scan `cpStatus.controlPlaneRoot` for immediate child directories containing `.git`.
  2. Include `availableRepos: string[]` and `activeRepoFilter: this._repoScopeFilter` in the `worktreeConfig` message payload.
- **Logic for `_createSafetyWorktree`:**
  1. Add an optional `repoName?: string` parameter.
  2. After obtaining `cpStatus`, compute `effectiveGitRoot`:
     - If `repoName` is provided and `cpStatus.mode === 'explicit'`, set `effectiveGitRoot = path.join(cpStatus.controlPlaneRoot, repoName)`.
     - Else if `cpStatus.isRepoScoped` and `cpStatus.repoScopeFilter`, set `effectiveGitRoot = path.join(cpStatus.controlPlaneRoot, cpStatus.repoScopeFilter)`.
     - Else, `effectiveGitRoot = workspaceRoot`.
  3. Validate `effectiveGitRoot` exists and contains `.git` (or run `git rev-parse --git-dir`). Throw clear errors for missing directory or missing `.git`.
  4. Use `effectiveGitRoot` as `cwd` for `git worktree add`.
  5. Update the comment on line 6823 to reference `effectiveGitRoot`.
- **Message handler for `createWorktree` (line 6259):**
  1. Read `msg.repoName` and pass it to `_createSafetyWorktree(workspaceRoot, undefined, msg.repoName)`.
- **Message handler for `createWorktreeForEpic` (line 6294):**
  1. Read `msg.repoName` and pass it similarly.
- **Edge Cases:**
  - `repoName` is null/undefined → fall back to existing `repoScopeFilter` logic, then `workspaceRoot`.
  - `controlPlaneRoot` is null (auto mode) → `effectiveGitRoot = workspaceRoot`, existing behavior.
  - Derived path does not exist → throw: `Repository directory does not exist: <path>`.
  - Derived path exists but is not a git repository → throw: `Not a git repository: <path>`.
  - `repoName` contains path traversal (`..`, `/`, `\`) → reject and throw: `Invalid repository name`.

## Verification Plan

### Automated Tests

Skipped per session directive. The test suite will be run separately by the user.

### Manual Verification Steps

1. Open a control plane directory (e.g., `/Users/patrickvuleta/Documents/Gitlab`) with an explicit control plane root configured and multiple child git repos (e.g., `ai`, `be`, `fe`).
2. Open the WORKTREES tab. Verify a dropdown appears listing all detected child repos.
3. Verify the dropdown defaults to the currently selected repo scope filter.
4. Select a different repo from the dropdown and click "CREATE WORKTREE". Verify the worktree is created from the selected repo.
5. Select the originally active repo and click "CREATE WORKTREE". Verify it works from that repo too.
6. Clear the repo scope filter (select the parent workspace in the main workspace selector) and re-open the WORKTREES tab. Verify the dropdown still appears and defaults to the first detected repo.
7. Open a regular git repository (non-control-plane mode) and open the WORKTREES tab. Verify the dropdown does NOT appear and existing behavior is unchanged.
8. (Negative test) Temporarily rename a child repo's `.git` directory and re-open the WORKTREES tab. Verify that repo is excluded from the dropdown.

## Files to Change

- `src/services/KanbanProvider.ts` - Modify `_createSafetyWorktree`, `_sendWorktreeConfig`, and message handlers for `createWorktree` / `createWorktreeForEpic`
- `src/webview/kanban.html` - Modify `createWorktreesPanel` to render repo dropdown, update `createWorktree` message payload

---

**Recommendation:** Send to Coder

## Review Findings

Implementation matches the plan: `_createSafetyWorktree` resolves `effectiveGitRoot` (repoName → scope filter → workspaceRoot) with traversal guard and dir+`.git` validation, `_sendWorktreeConfig` scans immediate children for `.git` and ships `availableRepos`/`activeRepoFilter`, and the `createWorktree`/`createWorktreeForEpic`/`createWorktreeForProject` handlers all forward `msg.repoName`. Fixed one MAJOR state-consistency bug in `src/webview/kanban.html` (dropdown default could diverge from the rendered `<select>` when the active scope filter no longer had a `.git`); default is now constrained to a repo present in `availableRepos`. Verified single-trigger refresh (`worktreeConfig` → `renderWorktreesTab`), no races (sync fs scan), and `stateFs` passthrough for `readdirSync`/`mkdirSync`. Compile and tests skipped per session directive. Remaining risk (NIT, out of scope): `createWorktreesForAllEpics` does not forward `repoName`, so batch-all-epics in explicit mode with no scope filter still fails — pre-existing, not a regression.
