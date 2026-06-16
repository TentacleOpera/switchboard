# Remove Control Plane Gate from Worktrees Tab

## Goal

Allow the Worktrees tab to function in `'auto'` control-plane mode by (1) removing the frontend and backend gates that block it whenever `controlPlaneMode !== 'explicit'`, and (2) ensuring worktrees are created as **siblings** of the repo in auto mode — never nested inside it.

**Core problem:** The Worktrees tab in `kanban.html` unconditionally blocks access with "Worktrees requires Switchboard to be running on Control Plane mode" whenever `controlPlaneMode !== 'explicit'`. The backend handler `_createSafetyWorktree` in `KanbanProvider.ts` throws the same error. Any user running Switchboard in `'auto'` mode (no explicit control plane root set in `workspaceState`) is permanently blocked from the worktrees tab even though worktrees would work correctly.

**Why worktrees must be siblings, not children (the load-bearing requirement):** The entire reason worktrees live beside the repo — not inside it — is to avoid polluting the repo's working tree and `git status`. This feature competes with native CLI tooling that creates worktrees in hidden/sibling locations precisely so the source repo stays clean. A worktree checked out at `<workspaceRoot>/worktrees/<branch>` (nested inside the repo) would appear as an untracked directory in `git status`, invite accidental `git add`, and defeat the feature's reason for existing. Therefore sibling placement is a functional requirement, not a style preference.

**The latent location bug this plan must also fix:** Today the worktree parent is computed as `path.join(cpStatus.controlPlaneRoot, 'worktrees')`. In `'explicit'` mode `controlPlaneRoot` is the org folder that *contains* the repo, so this resolves to a sibling location (correct):
```
controlPlaneRoot/
  myrepo/        <- workspaceRoot
  worktrees/     <- sibling, outside the repo  ✅
    branch/
```
But in `'auto'` mode `cpStatus.controlPlaneRoot` collapses to `workspaceRoot` (verified — see Edge-Case audit), so the same expression nests worktrees *inside* the repo (wrong):
```
myrepo/          <- workspaceRoot
  worktrees/     <- INSIDE the repo, pollutes git status  ❌
    branch/
```
Simply removing the gate would expose this bug. This plan removes the gate **and** corrects the auto-mode parent to a sibling path so both modes keep the repo clean.

---

## Metadata

**Tags:** frontend, backend, bugfix, feature
**Complexity:** 3

---

## User Review Required

- **Confirm sibling layout for auto mode.** Auto-mode worktrees will be created at `<dirname(workspaceRoot)>/worktrees/<branch>` — i.e. a `worktrees/` folder beside the repo, mirroring the explicit-mode shape. Confirm this is the desired location (vs. a repo-namespaced sibling like `<parent>/<repo>-worktrees/` — see Edge-Case audit on cross-repo collisions).
- **Confirm write access expectation.** Sibling placement requires write permission to the parent directory of the workspace. This is normally fine, but on locked-down setups the repo's parent may be read-only; in that case worktree creation will fail with a clear error rather than silently nesting.

---

## Complexity Audit

### Routine
- Frontend change is a single localized deletion (the early-return gate block).
- Backend gate removal is a small deletion.
- No schema changes, no new dependencies, branch-collision loop / terminal creation / DB writes all unchanged.

### Complex / Risky
- The backend now needs **mode-aware path logic** for `worktreesParent` (sibling in auto, org-folder in explicit) rather than a single expression. This is the one piece of real logic, not just deletion.
- The removed backend guard had a second clause (`!cpStatus.controlPlaneRoot`); retain a minimal non-empty guard so the empty-root case is not silently lost.
- Sibling directory may be shared across multiple repos under the same parent → potential cross-repo branch-name collision (see Edge-Case audit).

---

## Edge-Case & Dependency Audit

**Race Conditions**
- None new. Branch-name collisions within a single worktrees parent are handled by the `while (true)` retry loop in `_createSafetyWorktree` (catches `already exists` / `already used`). The frontend `createBtn` already disables itself for 5s to prevent double-submit.

**Security**
- No new trusted input. `epicTopic` is slugified (`/[^a-z0-9]+/g` → `-`, capped 40 chars) before use in a path, so no traversal via topic. `git worktree add` uses `execFile` (no shell) → no command injection. `path.dirname(workspaceRoot)` derives the sibling parent from an already-resolved, allowed root — not from user input.

**Side Effects**
- With the fix, **no** untracked directory appears inside the repo in either mode — `git status` stays clean. This is the explicit goal.
- A `worktrees/` directory is lazily created beside the repo (auto) or under the org folder (explicit). Pre-existing behavior for explicit mode is unchanged.
- `_sendWorktreeConfig` still posts `controlPlaneMode` to the webview; after the frontend gate is removed this value is informational only.

**Dependencies & Conflicts**
- **Crux verification (auto mode → `controlPlaneRoot === workspaceRoot`):** `getControlPlaneSelectionStatus` (line 3723) in auto mode returns `{ mode: 'auto', controlPlaneRoot: resolvedRoot, workspaceRoot: resolvedRoot }`. Both call sites — `createWorktree` (line 6244) and `createWorktreeForEpic` (line 6279) — compute `workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot)` and `break` if falsy, so the `workspaceRoot` passed into `_createSafetyWorktree` is always non-empty and already-allowed. The inner re-resolution is idempotent. Hence in auto mode `cpStatus.controlPlaneRoot === workspaceRoot`, confirming the nesting bug and validating the sibling fix.
- **Cross-repo collision:** if two repos share the same parent directory, both auto-mode worktrees land in `<parent>/worktrees/`. Distinct branch names coexist fine; identical branch names across repos would collide there. The retry loop renames on git's `already exists` error, so this degrades to an auto-suffixed name rather than a hard failure. If strict isolation is wanted, namespace the sibling per repo (deferred — see User Review Required).

---

## Dependencies

- None. Self-contained change with no upstream session prerequisites.

---

## Adversarial Synthesis

**Risk Summary:** Key risk: simply removing the gate (the original plan) would ship worktrees nested *inside* the repo in auto mode, polluting `git status` — the exact failure the sibling design exists to prevent and the feature's competitive reason for being. Mitigation: this plan additionally corrects `worktreesParent` to a sibling path in auto mode (mirroring explicit mode), retains a minimal non-empty `controlPlaneRoot` guard, and notes cross-repo collision + parent write-access as accepted, clearly-erroring edge cases. The crux (auto mode collapses `controlPlaneRoot` to `workspaceRoot`) is verified against the call path.

---

## Proposed Changes

### `src/webview/kanban.html` — remove frontend gate

**Function:** `createWorktreesPanel(config)` (line 8288)

**Context:** Lines 8292–8299 unconditionally return an error panel whenever `cpMode !== 'explicit'`.

**Logic:** Remove the early-return block so the function proceeds directly to rendering the worktrees UI.

**Implementation:** Delete:
```javascript
const cpMode = (config && config.controlPlaneMode) || currentControlPlaneMode || 'none';
if (cpMode !== 'explicit') {
    const msg = document.createElement('div');
    msg.style.cssText = 'padding:16px; font-size:11px; color:var(--text-secondary); line-height:1.5;';
    msg.innerHTML = 'Worktrees requires Switchboard to be running on Control Plane mode. Please visit the setup menu to enable worktrees.';
    container.appendChild(msg);
    return container;
}
```
The function continues from the `// Description / Overview Header` section (line 8301).

**Edge Cases:** `currentControlPlaneMode` (line 5628) and `config.controlPlaneMode` (forwarded by `_sendWorktreeConfig`) remain defined elsewhere; they are only *read* here as a gate, so removing this block leaves no dangling reference.

---

### `src/services/KanbanProvider.ts` — remove backend gate AND fix sibling path

**Function:** `_createSafetyWorktree(workspaceRoot, epicTopic?)` (definition at line 6775)

**Context:**
- Lines 6783–6785 throw on `cpStatus.mode !== 'explicit' || !cpStatus.controlPlaneRoot`.
- Line 6789 computes `const worktreesParent = path.join(cpStatus.controlPlaneRoot, 'worktrees');` — correct in explicit mode, but nests inside the repo in auto mode.

**Logic:**
1. Remove the `mode !== 'explicit'` gate (the reported bug), but **retain a minimal non-empty guard** so the second responsibility of the original guard is not silently lost.
2. Make `worktreesParent` **mode-aware**: explicit → org folder (unchanged); auto → sibling of the repo.

**Implementation:**

Replace the guard at lines 6783–6785:
```typescript
if (!cpStatus.controlPlaneRoot) {
    throw new Error('Could not resolve a workspace root for worktree creation.');
}
```
Keep the existing structural guard above it (`if (!workspaceRoot) throw new Error('No workspace root resolved.');`, line 6780).

Replace the parent computation at line 6789:
```typescript
// Worktrees must live BESIDE the repo, never inside it, to keep `git status` clean.
// Explicit mode: under the control-plane org folder (already a sibling of the repo).
// Auto mode: cpStatus.controlPlaneRoot collapses to workspaceRoot, so derive an
// explicit sibling from the repo's parent directory instead of nesting inside it.
const worktreesParent = cpStatus.mode === 'explicit'
    ? path.join(cpStatus.controlPlaneRoot, 'worktrees')
    : path.join(path.dirname(workspaceRoot), 'worktrees');
```
The lazy `fs.existsSync` / `fs.mkdirSync(worktreesParent, { recursive: true })` block (lines 6790–6792) is unchanged and now creates the sibling dir on demand. The `git worktree add -b <branch> <fullPath>` call (line 6802) still runs with `cwd: workspaceRoot`; because `fullPath` is absolute and outside the repo, the checkout lives beside the repo while git registers it normally in `.git/worktrees/` metadata — leaving the main repo's working tree clean.

**Edge Cases:**
- `path.dirname(workspaceRoot)` on a filesystem root returns the root itself; worktrees would then share that root. Practically irrelevant for real project paths.
- Requires write permission to the repo's parent directory; if denied, `mkdirSync`/`git worktree add` fails with a surfaced error (caught by the handler's `catch` → `showErrorMessage`) rather than silently nesting.
- The retained `if (!cpStatus.controlPlaneRoot)` guard prevents a relative `worktrees` path if any future caller passes an unresolvable root (existing call sites already pre-resolve, so it cannot fire today).

---

## What does NOT change

- `_sendWorktreeConfig` (definition line 6815) still reads `cpStatus.mode` and forwards it as `controlPlaneMode` to the webview (line 6829) — informational only after the gate removal.
- Explicit-mode worktree location is unchanged (`<controlPlaneRoot>/worktrees/`).
- No changes to the setup panel, `getControlPlaneSelectionStatus`, or other control-plane logic.
- The branch-collision retry loop, terminal creation loop, and `db.addWorktree` writes are untouched.

---

## Verification Plan

> Session directive: compilation and automated tests are run separately by the user. The steps below describe what to validate.

### Automated Tests
- If added later, a unit test should assert that in auto mode (`workspaceState` has no `kanban.controlPlaneRoot`) `_createSafetyWorktree` resolves the worktree to `<dirname(workspaceRoot)>/worktrees/<branch>` (a sibling), and in explicit mode to `<controlPlaneRoot>/worktrees/<branch>`.

### Manual Verification
1. Open the Kanban panel from a non-control-plane workspace (auto mode).
2. Click the WORKTREES tab — it should render the worktrees UI instead of the "requires Control Plane mode" error.
3. Create a worktree — it should succeed and create `<dirname(workspaceRoot)>/worktrees/<branch>/` **beside** the repo, not inside it. Confirm a new terminal is created scoped to the worktree path.
4. Run `git status` inside the repo — confirm it is **clean** (no untracked `worktrees/` directory). This is the key regression check for the sibling requirement.
5. Open the Kanban panel from an explicit control-plane workspace — the worktrees tab should still create worktrees under `<controlPlaneRoot>/worktrees/`, identical to before.

---

## Recommendation

**Complexity: 3 → Send to Intern.** Two deletions plus one small mode-aware path expression; the sibling requirement is the load-bearing constraint and is directly enforced by the corrected `worktreesParent` computation. Crux behavior verified against the actual call path.
