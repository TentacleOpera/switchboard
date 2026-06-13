# Worktrees Part 1: Foundation

## Goal

Fix the broken worktree creation path, enforce the control plane requirement, simplify terminal creation to a single reliable behaviour, and add `worktrees/` to the control plane setup flow.

## Dependencies

None — this is the foundation all other worktree plans build on.

## Problem Analysis

### Architectural Requirement: Control Plane Required for Worktrees
Worktrees require an explicitly configured control plane. If no control plane is set (`mode !== 'explicit'`), the Worktrees tab shows a "No control plane configured" message with a prompt to set one up. Worktree creation is blocked entirely — there is no fallback to workspace root.

A control plane is configured when the user has explicitly set `kanban.controlPlaneRoot` in VS Code's workspaceState via the workspace picker. Detection uses `getControlPlaneSelectionStatus()` which returns `mode: 'explicit'` only when this key is present and non-empty. **Critical ordering constraint**: `_resolveWorkspaceRoot()` must be called and validated before `getControlPlaneSelectionStatus()` — calling the latter with an unresolved workspace root returns garbage and was the cause of false "no control plane" negatives in prior implementation attempts.

### Bug 1: Incorrect Worktree Creation Path
Worktrees are currently created inside the workspace root (`path.join(workspaceRoot, dirName)` at KanbanProvider.ts:6768). They must be created inside `worktrees/` under the control plane root.

### Bug 2: Terminal Reuse Instead of Force-Creation
The current handler reuses existing terminals instead of force-creating new ones with `cwd` set to the worktree path. `createAgentGrid` skips creation if terminals with matching names already exist. The fix uses `addAutobanTerminalFromKanban` (TaskViewerProvider.ts:6269) which force-creates a terminal with a specified `cwd`.

### Bug 3: Dead Terminal Behaviour Options
The four-option radio group (`worktreeNew`, `worktreeReset`, `controlPlaneNew`, `existing`) is confusing and broken. `worktreeReset` could destroy agent work instantly. `controlPlaneNew` and `existing` do nothing useful. There is only one sensible behaviour: create a worktree and spin up new terminals inside it. Existing terminals are unaffected.

## Metadata

**Tags:** backend, frontend, git, bugfix
**Complexity:** 5

## User Review Required

None.

## Complexity Audit

### Routine
- Add `worktrees/` to `executeFreshSetup` bootstrap
- Enforce control plane requirement in Worktrees tab UI
- Fix `_createSafetyWorktree` to use control plane root with lazy-create fallback
- Remove radio group and remember choice checkbox from Worktrees tab
- Simplify `createWorktree` handler to single behaviour

### Complex / Risky
- **Control plane enforcement ordering**: Must call `_resolveWorkspaceRoot()` before `getControlPlaneSelectionStatus()` — prior failures were caused by this ordering being wrong.

## Edge-Case & Dependency Audit

### Race Conditions
- **Concurrent worktree creation**: Branch name collisions handled by existing suffix logic (`-2`, `-3`).

### Security
- **Path injection**: Git command uses `execFile` with args array — safe.

### Dependencies & Conflicts
- **Control plane detection**: `getControlPlaneSelectionStatus()` at KanbanProvider.ts:3677. Returns `mode: 'explicit'` only when `kanban.controlPlaneRoot` workspaceState key is set.
- **Terminal creation**: `addAutobanTerminalFromKanban` at TaskViewerProvider.ts:6269. Already exists and accepts `cwd` parameter.
- **`executeFreshSetup` bootstrap**: `ControlPlaneMigrationService.ts` line ~665. Add one `mkdir` call.

## Proposed Changes

### Phase 1: Enforce Control Plane Requirement and Fix Worktree Creation Path

**Files: `src/services/KanbanProvider.ts`, `src/services/ControlPlaneMigrationService.ts`, `src/webview/kanban.html`**

**Context**: `_createSafetyWorktree` method (lines 6758-6780) currently creates worktrees inside `workspaceRoot` with no control plane check. `executeFreshSetup` in `ControlPlaneMigrationService.ts` (line ~665) creates the standard control plane directory structure.

**Solution**: Require an explicit control plane. Block creation with a clear message if none is configured. Create worktrees in `worktrees/` directly under the control plane root. Add `worktrees/` to `executeFreshSetup` so new control planes get it automatically. Lazy-create for existing control planes.

**Change — `ControlPlaneMigrationService.ts`** (add one line to bootstrap block at line ~665):

```typescript
await Promise.all([
    fs.promises.mkdir(path.join(parentDir, '.agent'), { recursive: true }),
    fs.promises.mkdir(path.join(parentDir, '.switchboard', 'plans'), { recursive: true }),
    fs.promises.mkdir(path.join(parentDir, '.switchboard', 'inbox'), { recursive: true }),
    fs.promises.mkdir(path.join(parentDir, '.switchboard', 'archive'), { recursive: true }),
    fs.promises.mkdir(path.join(parentDir, 'worktrees'), { recursive: true }),  // ← add this
]);
```

**Change — `_createSafetyWorktree` in `KanbanProvider.ts`**:

```typescript
private async _createSafetyWorktree(workspaceRoot: string, epicTopic?: string): Promise<{ branch: string; path: string }> {
    const execFileAsync = promisify(cp.execFile);

    // Resolve workspace root first — getControlPlaneSelectionStatus returns garbage if this is empty.
    // Prior implementation failures were caused by skipping this ordering constraint.
    if (!workspaceRoot) throw new Error('No workspace root resolved.');

    const cpStatus = this.getControlPlaneSelectionStatus(workspaceRoot);
    if (cpStatus.mode !== 'explicit' || !cpStatus.controlPlaneRoot) {
        throw new Error('No control plane configured. Set a control plane in the workspace picker before creating worktrees.');
    }

    // worktrees/ is created by executeFreshSetup for new control planes.
    // Lazy-create here for existing control planes that predate this change.
    const worktreesParent = path.join(cpStatus.controlPlaneRoot, 'worktrees');
    if (!fs.existsSync(worktreesParent)) {
        fs.mkdirSync(worktreesParent, { recursive: true });
    }

    const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
    const baseName = epicTopic ? slugify(epicTopic) : `worktree-${new Date().toISOString().slice(0, 10)}`;
    let branch = baseName;
    let suffix = 2;
    while (true) {
        try {
            const fullPath = path.join(worktreesParent, branch);
            // CRITICAL: git worktree add MUST run from workspaceRoot (the git repo), not the control plane root
            await execFileAsync('git', ['worktree', 'add', '-b', branch, fullPath], { cwd: workspaceRoot });
            return { branch, path: fullPath };
        } catch (e: any) {
            if (e.message?.includes('already exists') || e.message?.includes('already used')) {
                branch = `${baseName}-${suffix}`;
                suffix++;
            } else {
                throw e;
            }
        }
    }
}
```

**Change — `kanban.html`**: When `currentControlPlaneMode` is not `'explicit'`, replace the Worktrees tab content with a blocked message:

```javascript
if (cpMode !== 'explicit') {
    const msg = document.createElement('div');
    msg.style.cssText = 'padding:16px; font-size:11px; color:var(--text-secondary); line-height:1.5;';
    msg.innerHTML = 'A <strong>Control Plane</strong> is required to use worktrees.<br>Set one up in the workspace picker first.';
    container.appendChild(msg);
    return container;
}
```

**Verification**: Fresh control plane setup → verify `worktrees/` directory created. Existing control plane (no `worktrees/` dir) → create first worktree → verify `worktrees/` created lazily. No control plane set → Worktrees tab shows blocked message, no Create button. With control plane → worktree created in `<control-plane>/worktrees/`.

---

### Phase 2: Simplify Terminal Creation — One Behaviour Only

**Files: `src/services/KanbanProvider.ts`, `src/webview/kanban.html`**

**Context**: The `createWorktree` handler has four terminal behaviour branches. The UI has a radio group and "remember choice" checkbox.

**Solution**: Remove the radio group and checkbox entirely. One behaviour: create worktree → force-create new agent terminals in it via `addAutobanTerminalFromKanban`. Existing terminals are unaffected.

**Change — `createWorktree` handler in `KanbanProvider.ts`**:

```typescript
case 'createWorktree': {
    const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
    if (!workspaceRoot) break;

    const db = this._getKanbanDb(workspaceRoot);
    if (!db || !await db.ensureReady()) break;

    try {
        const { branch, path: wtPath } = await this._createSafetyWorktree(workspaceRoot, msg.epicTopic);

        // Force-create new terminals in worktree — existing terminals are unaffected
        const visibleAgents = await this._getVisibleAgents(workspaceRoot);
        const roleToName: Record<string, string> = {
            'planner': 'Planner', 'lead': 'Lead Coder', 'coder': 'Coder',
            'intern': 'Intern', 'reviewer': 'Reviewer', 'analyst': 'Analyst'
        };
        for (const [role, enabled] of Object.entries(visibleAgents)) {
            if (!enabled) continue;
            const agentName = roleToName[role] || role.charAt(0).toUpperCase() + role.slice(1);
            await vscode.commands.executeCommand('switchboard.addAutobanTerminalFromKanban', role, agentName, wtPath);
        }

        vscode.window.showInformationMessage(`Worktree created: ${branch}`);

        // Refresh tab — Part 2 replaces this with db.getWorktrees(); for now re-send existing config
        const config = await this._getWorktreeConfigData(workspaceRoot);
        this._panel?.webview.postMessage({ type: 'worktreeConfig', ...config });
    } catch (e: any) {
        vscode.window.showErrorMessage(`Failed to create worktree: ${e.message}`);
    }
    break;
}
```

**Change — `kanban.html`**: Remove the Agent Terminal Behaviour radio group, all four `<label>`/`<input>` radio elements, and the "remember choice" checkbox from `createWorktreesPanel`. The Create button fires immediately.

Also remove all `activeTerminalCount` reads and the `disabled` check on any radio option — none of this logic is needed anymore.

**Verification**: Create worktree → new terminals created with `cwd` set to worktree path. Existing terminals unaffected. No radio group visible in UI. Branch naming: manual → `worktree-<date>`, epic-linked → slugified topic.

---

## Files Changed

- `src/services/ControlPlaneMigrationService.ts` — Add `worktrees/` to fresh setup bootstrap
- `src/services/KanbanProvider.ts` — Fix `_createSafetyWorktree`, simplify `createWorktree` handler
- `src/webview/kanban.html` — Add control plane blocked state, remove radio group and checkbox

## Verification Plan

1. **Fresh control plane**: Run setup wizard → verify `worktrees/` created in control plane root
2. **Existing control plane**: No `worktrees/` dir → create first worktree → dir created lazily
3. **No control plane**: Open Worktrees tab → blocked message shown, no Create button
4. **Worktree location**: Create worktree → verify at `<control-plane>/worktrees/<branch>`
5. **Branch naming**: Manual → `worktree-<date>`. No `switchboard-` prefix.
6. **Terminal creation**: Create worktree → new terminals opened with worktree `cwd`. Existing terminals unchanged.
7. **No radio group**: Verify UI shows only Create button, no behaviour options.

## Risks

- **Control plane false negative**: If `_resolveWorkspaceRoot()` is not called before detection, the control plane check always fails. Mitigation: the ordering constraint is documented in the code comment and this plan's problem analysis.
- **Existing worktree meta keys**: The old `active_safety_session_*` meta keys still exist — the multi-worktree DB migration is Part 2. This plan leaves those keys in place; the handler still writes to them temporarily until Part 2 removes them.

## Recommendation

**Complexity: 5 → Send to Coder**

Targeted fixes with clear before/after. The critical ordering constraint is the main risk — the code comment documents it explicitly.

## Review Findings

**Findings**: Two MAJOR issues found. (1) `createWorktreeForEpic` duplicate check at `KanbanProvider.ts:6262` used strict equality `===` between `w.epic_id` (number from SQLite) and `msg.epicId` (string from webview), so duplicate epic worktrees were never blocked. (2) Worktree list render at `kanban.html:8289-8290` passed `w.branch` and `w.path` into `onclick` handlers without escaping single quotes, breaking JavaScript for branch names or paths containing apostrophes.

**Fixes applied**: Converted duplicate check to `String(w.epic_id) === msg.epicId`. Added `String(...).replace(/'/g, "\\'")` escaping for branch and path in both `mergeWorktree` and `abandonWorktree` onclick handlers.

**Validation**: Old radio group options fully removed from kanban.html (no orphaned references). `_createSafetyWorktree` uses correct `git worktree add -b` from workspaceRoot. Terminal creation via `addAutobanTerminalFromKanban` correctly passes `cwd`. No compilation or test regressions detected.

**Remaining risks**: `_getWorktreeConfigData` and `_getSafetySessionData` are dead code until Part 2 removes them. The `createWorktreeForEpic` handler was outside the original plan scope but was updated consistently as part of the same commit.
