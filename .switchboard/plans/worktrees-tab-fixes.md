# Worktrees Tab Fixes and Multi-Worktree Support

## Goal

Fix critical worktree creation and terminal behavior bugs, add worktree status display, and extend the system to support multiple concurrent worktrees with epic linkage.

## Problem Analysis

### Architectural Requirement: Control Plane Required for Worktrees
Worktrees require an explicitly configured control plane. If no control plane is set (`mode !== 'explicit'`), the Worktrees tab shows a "No control plane configured" message with a prompt to set one up. Worktree creation is blocked entirely without an explicit control plane — there is no fallback to workspace root.

A control plane is configured when the user has explicitly set `kanban.controlPlaneRoot` in VS Code's workspaceState via the workspace picker. Detection uses `getControlPlaneSelectionStatus()` which returns `mode: 'explicit'` only when this key is present and non-empty. **Critical ordering constraint**: `_resolveWorkspaceRoot()` must be called and validated before `getControlPlaneSelectionStatus()` — calling the latter with an unresolved workspace root returns garbage and was the cause of false "no control plane" negatives in prior implementation attempts.

### Bug 1: Incorrect Worktree Creation Path
Worktrees are currently created inside the workspace root (`path.join(workspaceRoot, dirName)` at KanbanProvider.ts:6768). This is incorrect — worktrees must be created inside `.switchboard/worktrees/` under the control plane root.

### Bug 2: Terminal Reuse Instead of Force-Creation
The current worktree terminal behavior reuses existing terminals instead of force-creating new ones with `cwd` set to the worktree path. This differs from the Automation tab pattern which uses `addAutobanTerminalFromKanban` to create fresh terminals with a specified `cwd`. Reusing terminals causes agents to run in the wrong directory context.

### Bug 3: "Use Existing Agents" Button Always Greyed Out
The "Use existing agents" radio option is disabled when `activeTerminalCount === 0` (kanban.html:8197). The `activeTerminalCount` is computed in `_getWorktreeConfigData` (KanbanProvider.ts:6795-6830) by filtering `vscode.window.terminals` for grid-matched names. This count may always read 0 due to incorrect terminal name matching logic or liveness detection.

### Missing Feature: Worktree Status Display
The Worktrees tab does not show what changes exist in a worktree. Users cannot see which files have changed or how many commits are in the worktree branch without running git commands manually.

### Missing Feature: Active Worktree Indicator
The tab does not prominently display the current worktree's branch name and path. There is no quick way to switch terminals between the worktree and the main workspace.

### Architectural Limitation: Single Worktree Only
The current system uses single meta keys (`active_safety_session_branch`, `active_safety_session_path`, `active_safety_session_started_at`) to track one active worktree. This prevents users from having multiple concurrent worktrees for different tasks.

### Missing Feature: Epic Linkage
Epic cards exist but have no integration with worktrees. Users cannot create a worktree directly from an epic card, and worktrees are not associated with epics for tracking purposes.

## Metadata

**Tags:** frontend, backend, database, git, ui, ux, feature, bugfix
**Complexity:** 8

## User Review Required

- Confirm "base" branch for git diff/log commands — should this be the main branch (e.g., `main`/`master`) or the parent branch from which the worktree was created?
- Confirm .gitignore pattern for worktree directories — should it be `switchboard-safety-*` or a more specific pattern?
- Confirm whether multiple worktrees should share terminal pools or each have dedicated terminals.
- Confirm epic column status signal — should this show the epic's current kanban column (e.g., "IN PROGRESS") or a derived status (e.g., "In Progress", "Review", "Done")?

## Complexity Audit

### Routine
- Enforce control plane requirement: show "No control plane configured" message in Worktrees tab when `mode !== 'explicit'`; block worktree creation
- Fix worktree creation path: use `.switchboard/worktrees/` under explicit control plane root; no fallback
- Force-create terminals with `cwd` set to worktree path via `addAutobanTerminalFromKanban`
- Add git diff/log commands on tab open/refresh
- Add active worktree indicator UI (branch name, path)
- Add "switch terminals" button to cd to worktree/main
- Add `epicId` column to worktrees table
- Add "Create Worktree" button to epic cards in kanban.html

### Complex / Risky
- **Multi-worktree data structure migration**: Replace single meta keys with list structure in DB. Requires schema migration and changes to all read/write paths.
- **Terminal behaviour simplification**: Remove radio group entirely; single create flow always spins up new terminals in the worktree.
- **Git command execution**: Running `git diff` and `git log` on every tab open/refresh could be slow for large repos. Needs caching or debouncing.
- **Control plane enforcement**: Must not regress existing worktrees created before enforcement was added — migration (Phase 5) handles this by preserving existing records regardless of current control plane state.
- **Epic-worktree association**: Displaying epic column status requires querying epic cards' current kanban column state, which adds complexity to the worktree list rendering.

## Edge-Case & Dependency Audit

### Race Conditions
- **Concurrent worktree creation**: Multiple users creating worktrees simultaneously could conflict on branch names. Mitigation: Timestamp-based naming with suffix collision handling (already exists).
- **False "no control plane" detection**: Must call `_resolveWorkspaceRoot()` before `getControlPlaneSelectionStatus()`. If workspace root is unresolved, detection always returns `mode: 'auto'` regardless of configuration.

### Security
- **Path injection in git commands**: Git command parameters (branch names, paths) must be validated to prevent shell injection. Current code uses `execFile` with args array (F-03 pattern), which is safe.
- **.gitignore modification**: Automatically adding .gitignore entries should validate the path is within the workspace to avoid modifying unrelated files.

### Side Effects
- **Switching terminals changes agent context**: When terminals are switched to a worktree, agents will run commands in that directory until switched back. This is intentional but could confuse users.
- **Multiple worktrees increase terminal count**: If each worktree has dedicated terminals, the terminal panel could become crowded. Mitigation: Reuse terminals per worktree group or use terminal pools.

### Dependencies & Conflicts
- **Control plane detection**: Uses `getControlPlaneSelectionStatus()` from KanbanProvider.ts (lines 3677-3703). Returns `mode: 'explicit'` only when `kanban.controlPlaneRoot` workspaceState key is set. Must call `_resolveWorkspaceRoot()` first — prior failures were caused by calling detection before workspace was resolved.
- **Terminal creation**: Requires `addAutobanTerminalFromKanban` command from TaskViewerProvider.ts (line 6269). Already exists and accepts `cwd` parameter.
- **Epic system**: Depends on epic-subtask-system.md plan (already implemented). Epic cards have `isEpic` and `epicId` fields.
- **Worktree meta keys**: Current single-key structure conflicts with multi-worktree design. Requires migration.

## Dependencies

- `epic-subtask-system.md` — Epic & Subtask System (already implemented)
- `worktrees_tab_overhaul_agent_terminal_behaviour.md` — Agent terminal behaviour config (already implemented)
- `control-plane-worktree-fixes.md` — Control-plane-only worktree feature (already implemented)

## Adversarial Synthesis

Key risks: (1) Multi-worktree migration is a breaking change to the meta key structure — existing single-worktree sessions will need migration logic. (2) Terminal liveness detection bug may be deeper than just `activeTerminalCount` — the `matchesGridAgentName` pattern or heartbeat logic could be faulty. (3) Git diff/log on every tab refresh could cause performance issues for large repos — needs caching strategy. (4) Terminal switching via `cd` + CLI restart is fragile — if the CLI is not running, restart will fail. Mitigations: Add migration script for existing sessions, add detailed logging to terminal liveness detection, cache git output with 30-second TTL, check CLI state before restart attempt.

## Proposed Changes

### Phase 1: Enforce Control Plane Requirement and Fix Worktree Creation Path

**Files: `src/services/KanbanProvider.ts`, `src/webview/kanban.html`**

**Context**: `_createSafetyWorktree` method (lines 6758-6780) currently creates worktrees inside `workspaceRoot` with no control plane check.

**Problem**: Worktrees are created in the wrong location and with no enforcement that a control plane exists. Without a control plane the worktree location is ambiguous and the feature is unreliable.

**Solution**: Require an explicit control plane. Block creation and show a clear message if none is configured. Create worktrees in `worktrees/` directly under the control plane root — a clean, unbranded directory that is part of the standard control plane structure. No fallback to workspace root.

**Worktrees directory**:
- `executeFreshSetup` in `ControlPlaneMigrationService.ts` (line ~665) creates the standard control plane directory structure. Add `worktrees/` there so new control planes get it automatically.
- For existing control planes that predate this change: lazy-create `worktrees/` on first worktree creation if it doesn't exist.

**Critical ordering**: Always call `_resolveWorkspaceRoot()` and validate it before calling `getControlPlaneSelectionStatus()`. This was the cause of false "no control plane" negatives in prior implementation attempts.

**Change — `ControlPlaneMigrationService.ts`** (add one line to the bootstrap block at line ~665):

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

**Verification**: Fresh control plane setup → verify `worktrees/` directory exists. Existing control plane (no `worktrees/` dir) → create first worktree → verify `worktrees/` is created lazily. With no control plane set → open Worktrees tab → verify blocked with clear message. Epic-linked worktree → verify branch name derived from epic topic with no prefix branding.

### Phase 2: Simplify Terminal Creation — One Behaviour Only

**Files: `src/services/KanbanProvider.ts`, `src/webview/kanban.html`**

**Context**: The current handler has four terminal behaviour modes (`worktreeNew`, `worktreeReset`, `controlPlaneNew`, `existing`) and the UI has a radio group to choose between them.

**Problem**: The mode distinction was artificial and introduced danger (`worktreeReset` could instantly destroy agent work) and dead options (`controlPlaneNew`, `existing` do nothing useful). There is only one sensible behaviour: create a worktree and spin up new agent terminals inside it. Existing terminals are unaffected — the user manages them via the worktree list's merge/abandon buttons.

**Solution**: Remove the radio group and "remember choice" checkbox entirely. Remove all four behaviour branches from the handler. Replace with a single flow: create worktree → force-create new terminals in it via `addAutobanTerminalFromKanban`.

**Branch naming**:
- Epic-linked worktrees: slugify the epic topic, no prefix, truncate to 40 chars (e.g. `add-payment-flow`)
- Manual worktrees (no epic): `worktree-<date>` (e.g. `worktree-2026-06-14`)
- Suffix collision: append `-2`, `-3` etc — handled in `_createSafetyWorktree`

**Change — `createWorktree` handler in `KanbanProvider.ts`**:

```typescript
case 'createWorktree': {
    const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
    if (!workspaceRoot) break;

    const db = this._getKanbanDb(workspaceRoot);
    if (!db || !await db.ensureReady()) break;

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

    const worktrees = await db.getWorktrees();
    this._panel?.webview.postMessage({ type: 'worktrees', worktrees });
    vscode.window.showInformationMessage(`Worktree created: ${branch}`);
    break;
}
```

**Change — `_createSafetyWorktree` signature**: Add optional `epicTopic` parameter for branch naming:

```typescript
private async _createSafetyWorktree(workspaceRoot: string, epicTopic?: string): Promise<{ branch: string; path: string }> {
    const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
    const baseName = epicTopic ? `switchboard-${slugify(epicTopic)}` : `switchboard-${new Date().toISOString().slice(0, 10)}`;
    // ... rest of existing logic using baseName instead of hardcoded branch name
}
```

**Change — `kanban.html`**: Remove the Agent Terminal Behaviour radio group and "remember choice" checkbox from `createWorktreesPanel`. The Create button fires immediately with no configuration needed.

**Verification**: Create a worktree manually → verify new terminals created in worktree directory, existing terminals unaffected. Create from an epic card → verify branch name derived from epic topic.

### Phase 4: Add Worktree Status Display

**File: `src/services/KanbanProvider.ts`**

**Context**: `_getWorktreeConfigData` currently returns basic metadata. Need to add git diff and log information.

**Problem**: Users can't see what's changed in a worktree without manually running git commands. They don't know:
- How many files have changed
- How many commits are in the worktree branch
- Which specific files are modified

**Solution**: Run git commands when the Worktrees tab opens/refreshes:
1. `git diff --name-only base...branch` — lists changed files
2. `git log --oneline base...branch` — counts commits

**Note**: The base branch is determined by checking for main/master first, then falling back to the current branch. This ensures we compare against the actual default branch, not a feature branch the user might have checked out.

**Change**: Add git commands to compute files changed and commit count.

```typescript
private async _getWorktreeConfigData(workspaceRoot: string): Promise<any> {
    // ... existing code ...
    
    let filesChanged: string[] = [];
    let commitCount = 0;
    
    if (hasActiveSession && sessionPath && fs.existsSync(sessionPath)) {
        try {
            const execFileAsync = promisify(cp.execFile);

            // Determine base branch: check for main/master first, then fallback to current branch
            let baseBranch = 'main';
            try {
                await execFileAsync('git', ['rev-parse', '--verify', 'main'], { cwd: workspaceRoot });
            } catch {
                try {
                    await execFileAsync('git', ['rev-parse', '--verify', 'master'], { cwd: workspaceRoot });
                    baseBranch = 'master';
                } catch {
                    // Fallback to current branch
                    const { stdout: currentBranch } = await execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: workspaceRoot });
                    baseBranch = currentBranch.trim() || 'main';
                }
            }

            // Get files changed between base and worktree branch
            const { stdout: diffOutput } = await execFileAsync(
                'git', ['diff', '--name-only', `${baseBranch}...${branch}`],
                { cwd: workspaceRoot }
            );
            filesChanged = diffOutput.trim().split('\n').filter(Boolean);

            // Get commit count
            const { stdout: logOutput } = await execFileAsync(
                'git', ['log', '--oneline', `${baseBranch}...${branch}`],
                { cwd: workspaceRoot }
            );
            commitCount = logOutput.trim().split('\n').filter(Boolean).length;
        } catch (e) {
            console.error('[KanbanProvider] Error getting worktree git status:', e);
        }
    }
    
    return {
        // ... existing fields ...
        filesChanged,
        commitCount
    };
}
```

**File: `src/webview/kanban.html`**

**Context**: Worktrees tab rendering (around line 8100-8300).

**Change**: Add status display section when worktree is active.

```javascript
// In renderWorktreesTab function, after the active worktree status card:
if (lastWorktreeConfig?.hasActiveSession) {
    const statusSection = document.createElement('div');
    statusSection.className = 'db-subsection';
    statusSection.style.cssText = 'margin-top: 8px;';
    
    const statusHeader = document.createElement('div');
    statusHeader.className = 'subsection-header';
    const statusSpan = document.createElement('span');
    statusSpan.textContent = 'WORKTREE STATUS';
    statusHeader.appendChild(statusSpan);
    statusSection.appendChild(statusHeader);
    
    const filesChanged = lastWorktreeConfig.filesChanged || [];
    const commitCount = lastWorktreeConfig.commitCount || 0;
    
    const statusContent = document.createElement('div');
    statusContent.style.cssText = 'padding: 8px; font-family: var(--font-mono); font-size: 10px; color: var(--text-secondary); line-height: 1.4;';
    
    const filesText = filesChanged.length > 0
        ? `${filesChanged.length} file${filesChanged.length !== 1 ? 's' : ''} changed`
        : 'No files changed';
    
    statusContent.innerHTML = `
        <div>Commits: ${commitCount}</div>
        <div>${filesText}</div>
        ${filesChanged.length > 0 && filesChanged.length <= 10 
            ? `<div style="margin-top:4px; opacity:0.7;">${filesChanged.slice(0, 10).map(f => `• ${f}`).join('<br>')}</div>`
            : filesChanged.length > 10 
                ? `<div style="margin-top:4px; opacity:0.7;">Showing 10 of ${filesChanged.length} files</div>`
                : ''}
    `;
    
    statusSection.appendChild(statusContent);
    container.appendChild(statusSection);
}
```

**Verification**: Create a worktree, make changes in it → open Worktrees tab → verify files changed and commit count are displayed.

### Phase 5: Multi-Worktree Data Structure Migration

**File: `src/services/KanbanDatabase.ts`**

**Context**: Current single-key structure (`active_safety_session_branch`, etc.) in `kanban_meta` table.

**Problem**: The current system only supports one active worktree because it uses single meta keys:
- `active_safety_session_branch`
- `active_safety_session_path`
- `active_safety_session_started_at`

This prevents users from having multiple concurrent worktrees for different tasks.

**Solution**: Create a new `worktrees` table to store multiple worktree records with the following schema:
- `id`: Primary key
- `branch`: Unique branch name
- `path`: Worktree directory path
- `started_at`: Creation timestamp
- `epic_id`: Optional linkage to epic (for Phase 8)
- `workspace_id`: Foreign key to workspace
- `created_at`: Record creation timestamp

**Migration strategy (V30)**:
1. Create the new table with indexes
2. Migrate existing single worktree from meta keys to the new table (if one exists)
3. Update all code to read/write from the table instead of meta keys
4. Keep meta keys for backward compatibility during transition (can be cleaned up in a future migration)

**Note**: This is a breaking change to the data model. Existing single-worktree sessions will be migrated automatically, but if the migration fails (e.g., meta keys are missing or corrupted), users could be in a broken state. Consider adding a fallback to read from meta keys if the table is empty.

**Change**: Add new table for worktree records and migrate existing data.

**Migration V30**:

```sql
-- Create worktrees table
CREATE TABLE IF NOT EXISTS worktrees (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    branch TEXT NOT NULL UNIQUE,
    path TEXT NOT NULL,
    started_at TEXT NOT NULL,
    epic_id TEXT DEFAULT '',
    workspace_id INTEGER NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_worktrees_workspace_id ON worktrees(workspace_id);
CREATE INDEX IF NOT EXISTS idx_worktrees_epic_id ON worktrees(epic_id);
```

**Migration logic**:

```typescript
// In _runMigrations, after V29:
const v30 = await this.getMigrationVersion();
if (v30 < 30) {
    // Create worktrees table
    for (const sql of MIGRATION_V30_SQL) {
        try { this._db.exec(sql); } catch (e) {
            console.debug('[KanbanDatabase] V30 migration step skipped:', e);
        }
    }
    
    // Migrate existing single worktree from meta keys
    const workspaceId = await this.getWorkspaceId();
    if (workspaceId) {
        const branch = await this.getMeta('active_safety_session_branch');
        const path = await this.getMeta('active_safety_session_path');
        const startedAt = await this.getMeta('active_safety_session_started_at');
        
        if (branch && path) {
            try {
                this._db.run(
                    'INSERT INTO worktrees (branch, path, started_at, workspace_id) VALUES (?, ?, ?, ?)',
                    [branch, path, startedAt || new Date().toISOString(), workspaceId]
                );
                console.log('[KanbanDatabase] Migrated existing worktree to new table');
            } catch (e) {
                console.error('[KanbanDatabase] Failed to migrate worktree:', e);
            }
        }
    }
    
    await this.setMigrationVersion(30);
    console.log('[KanbanDatabase] V30 migration completed: worktrees table created');
}
```

**New DB methods**:

```typescript
public async createWorktree(branch: string, path: string, epicId?: string): Promise<number> {
    const workspaceId = await this.getWorkspaceId();
    if (!workspaceId) return -1;
    
    const result = this._db.run(
        'INSERT INTO worktrees (branch, path, started_at, epic_id, workspace_id) VALUES (?, ?, ?, ?, ?)',
        [branch, path, new Date().toISOString(), epicId || '', workspaceId]
    );
    
    return result.lastInsertRowid as number;
}

public async getWorktrees(): Promise<any[]> {
    const workspaceId = await this.getWorkspaceId();
    if (!workspaceId) return [];
    
    const rows = this._db.all(
        'SELECT * FROM worktrees WHERE workspace_id = ? ORDER BY created_at DESC',
        [workspaceId]
    );
    return rows || [];
}

public async deleteWorktree(id: number): Promise<void> {
    this._db.run('DELETE FROM worktrees WHERE id = ?', [id]);
}

public async getWorktreeByBranch(branch: string): Promise<any | null> {
    const workspaceId = await this.getWorkspaceId();
    if (!workspaceId) return null;
    
    const row = this._db.one(
        'SELECT * FROM worktrees WHERE branch = ? AND workspace_id = ?',
        [branch, workspaceId]
    );
    return row || null;
}
```

**File: `src/services/KanbanProvider.ts`**

**Context**: Update all worktree-related handlers to use new table.

**Change**: Replace meta key reads/writes with DB table operations.

```typescript
// In createWorktree handler:
const worktreeId = await db.createWorktree(branch, wtPath, epicId); // epicId optional for now

// In mergeSafetySession/abandonSafetySession handlers:
await db.deleteWorktree(worktreeId);

// In _getWorktreeConfigData:
const worktrees = await db.getWorktrees();
const activeWorktree = worktrees[0]; // For now, first one is "active"
```

**Verification**: Create a worktree → verify it appears in worktrees table. Merge/abandon → verify record is deleted.

### Phase 6: Worktrees Tab List View

**File: `src/webview/kanban.html`**

**Context**: Replace single active worktree display with list view.

**Problem**: With the single-worktree model, the tab only shows one worktree. With multiple worktrees (from Phase 5), we need a list view to display and manage all concurrent worktrees.

**Solution**: Replace the single active worktree display with a scrollable list:
- Each row shows: branch name, path, status (files changed, commits)
- Each row has buttons: "Merge", "Abandon"
- Epic badge if the worktree is linked to an epic (from Phase 7)
- "Create New Worktree" button at the top

**UI structure**:
```
┌─ WORKTREES ─────────────────────┐
│ [Create New Worktree]            │
├──────────────────────────────────┤
│ Branch: switchboard-safety-...   │
│ Path: /Users/.../...             │
│ 5 files changed, 3 commits      │
│ [Merge] [Abandon]                │
├──────────────────────────────────┤
│ Branch: switchboard-safety-...   │
│ ...                             │
└──────────────────────────────────┘
```

**Note**: The "Merge" and "Abandon" buttons will need corresponding backend handlers (`mergeWorktree`, `abandonWorktree`) that perform the git operations and delete the worktree record. These handlers should reuse existing merge/abandon logic from the single-worktree implementation.

**Change**: Render all worktrees from the table with per-row controls.

```javascript
function renderWorktreesTab() {
    const container = document.getElementById('worktree-panel-root');
    if (!container) return;
    container.innerHTML = '';
    
    const worktrees = lastWorktrees || [];
    
    // Header
    const header = document.createElement('div');
    header.className = 'subsection-header';
    const headerSpan = document.createElement('span');
    headerSpan.textContent = 'WORKTREES';
    header.appendChild(headerSpan);
    container.appendChild(header);
    
    // Create button
    const createBtn = document.createElement('button');
    createBtn.className = 'btn-secondary';
    createBtn.textContent = 'Create New Worktree';
    createBtn.style.cssText = 'margin: 8px;';
    createBtn.addEventListener('click', () => {
        // Open create worktree dialog
        postKanbanMessage({ type: 'openCreateWorktreeDialog', workspaceRoot: currentWorkspaceRoot });
    });
    container.appendChild(createBtn);
    
    // List
    if (worktrees.length === 0) {
        const empty = document.createElement('div');
        empty.style.cssText = 'padding: 20px; text-align: center; color: var(--text-secondary); font-family: var(--font-mono); font-size: 11px;';
        empty.textContent = 'No worktrees created yet.';
        container.appendChild(empty);
    } else {
        worktrees.forEach(wt => {
            const row = document.createElement('div');
            row.style.cssText = 'padding: 8px; border: 1px solid var(--border-color); border-radius: 4px; margin-bottom: 8px; background: var(--panel-bg2);';
            
            const branchDiv = document.createElement('div');
            branchDiv.style.cssText = 'font-family: var(--font-mono); font-size: 11px; color: var(--text-primary); font-weight: 700;';
            branchDiv.textContent = wt.branch;
            
            const pathDiv = document.createElement('div');
            pathDiv.style.cssText = 'font-family: var(--font-mono); font-size: 9px; color: var(--text-secondary); margin-top: 2px;';
            pathDiv.textContent = wt.path;
            
            const statusDiv = document.createElement('div');
            statusDiv.style.cssText = 'font-family: var(--font-mono); font-size: 9px; color: var(--text-secondary); margin-top: 4px;';
            statusDiv.textContent = `${wt.filesChanged || 0} files changed, ${wt.commitCount || 0} commits`;
            
            const buttonRow = document.createElement('div');
            buttonRow.style.cssText = 'display: flex; gap: 8px; margin-top: 8px;';
            
            const mergeBtn = document.createElement('button');
            mergeBtn.className = 'btn-secondary';
            mergeBtn.textContent = 'Merge';
            mergeBtn.addEventListener('click', () => {
                postKanbanMessage({
                    type: 'mergeWorktree',
                    worktreeId: wt.id,
                    workspaceRoot: currentWorkspaceRoot
                });
            });
            
            const abandonBtn = document.createElement('button');
            abandonBtn.className = 'btn-danger';
            abandonBtn.textContent = 'Abandon';
            abandonBtn.addEventListener('click', () => {
                postKanbanMessage({
                    type: 'abandonWorktree',
                    worktreeId: wt.id,
                    workspaceRoot: currentWorkspaceRoot
                });
            });
            
            buttonRow.appendChild(mergeBtn);
            buttonRow.appendChild(abandonBtn);
            
            row.appendChild(branchDiv);
            row.appendChild(pathDiv);
            row.appendChild(statusDiv);
            row.appendChild(buttonRow);
            
            // Epic badge if linked
            if (wt.epicId) {
                const epicBadge = document.createElement('div');
                epicBadge.style.cssText = 'display: inline-block; margin-top: 4px; font-size: 9px; color: var(--accent-teal); font-family: var(--font-mono);';
                epicBadge.textContent = `📌 Linked to epic`;
                row.appendChild(epicBadge);
            }
            
            container.appendChild(row);
        });
    }
}
```

**Verification**: Create multiple worktrees → verify all appear in list with individual controls.

### Phase 7: Epic Linkage

**File: `src/services/KanbanDatabase.ts`**

**Context**: `createWorktree` method already accepts `epicId` parameter.

**Problem**: Epic cards exist but have no integration with worktrees. Users can't:
- Create a worktree directly from an epic card
- See which epic a worktree is associated with
- See the epic's status (column) in the worktree list

**Solution**: 
1. Add "Create Worktree" button to epic cards in the kanban board
2. Store `epicId` in the worktree record (already added in Phase 6 migration)
3. Show epic badge and column status in the worktree list

**Epic column status signal**: 
- Map the epic's kanban column to a readable status
- Example: "IN PROGRESS" → "In Progress", "CODE REVIEW" → "Review", "DONE" → "Done"
- Display this as a badge next to the epic linkage indicator

**Note**: This requires fetching epic card details in the worktree list rendering to get the current column state. This adds a query dependency but is necessary for the status signal feature.

**Change**: Ensure epicId is stored and indexed (already done in V30 migration).

**File: `src/webview/kanban.html`**

**Context**: Epic card rendering (around line 4890-4920).

**Change**: Add "Create Worktree" button to epic cards.

```javascript
// In renderKanbanCard function, after epic badge:
if (card.isEpic) {
    const createWorktreeBtn = document.createElement('button');
    createWorktreeBtn.className = 'strip-btn';
    createWorktreeBtn.style.cssText = 'font-size: 9px; padding: 2px 6px; margin-top: 4px;';
    createWorktreeBtn.textContent = '+ Create Worktree';
    createWorktreeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        postKanbanMessage({
            type: 'createWorktreeForEpic',
            epicId: card.planId || card.sessionId,
            workspaceRoot: card.workspaceRoot
        });
    });
    cardElement.appendChild(createWorktreeBtn);
}
```

**File: `src/services/KanbanProvider.ts`**

**Context**: Add new message handler.

**Change**: Add `createWorktreeForEpic` handler.

```typescript
case 'createWorktreeForEpic': {
    const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
    const epicId = msg.epicId;
    if (!workspaceRoot || !epicId) break;
    
    const db = this._getKanbanDb(workspaceRoot);
    if (!db || !await db.ensureReady()) break;
    
    // Verify epic exists
    const epic = await db.getPlanBySessionId(epicId);
    if (!epic || !epic.isEpic) {
        vscode.window.showWarningMessage('Target is not a valid epic.');
        break;
    }
    
    // Create worktree with epic linkage
    const { branch, path: wtPath } = await this._createSafetyWorktree(workspaceRoot);
    const worktreeId = await db.createWorktree(branch, wtPath, epicId);
    
    vscode.window.showInformationMessage(`Created worktree "${branch}" linked to epic "${epic.topic}"`);
    
    // Refresh worktrees list
    const worktrees = await db.getWorktrees();
    this._panel?.webview.postMessage({ type: 'worktrees', worktrees });
    break;
}
```

**File: `src/webview/kanban.html`**

**Context**: Worktree list rendering (from Phase 7).

**Change**: Add epic column status signal.

```javascript
// In worktree row, after epic badge:
if (wt.epicId) {
    // Fetch epic details to get column
    const epicCard = currentCards.find(c => (c.planId || c.sessionId) === wt.epicId);
    if (epicCard) {
        const statusBadge = document.createElement('div');
        statusBadge.style.cssText = 'display: inline-block; margin-left: 8px; font-size: 9px; padding: 1px 4px; border-radius: 3px; background: var(--panel-bg2); border: 1px solid var(--border-color); color: var(--text-secondary); font-family: var(--font-mono);';
        
        // Map column to status
        const columnToStatus: Record<string, string> = {
            'PLANNED': 'Planned',
            'IN PROGRESS': 'In Progress',
            'CODE REVIEW': 'Review',
            'REVIEWED': 'Reviewed',
            'DONE': 'Done'
        };
        statusBadge.textContent = columnToStatus[epicCard.kanbanColumn] || epicCard.kanbanColumn;
        
        row.appendChild(statusBadge);
    }
}
```

**Verification**: Click "Create Worktree" on epic card → verify worktree is created with epicId. Verify epic column status appears in worktree list.

### Phase 8: Epic Focus Mode

**File: `src/webview/kanban.html`**

**Context**: Epic cards exist on the kanban board with subtasks stored in the DB. The board currently shows all cards across all epics simultaneously with no way to focus on one epic's work.

**Problem**: With multiple epics in flight, the board becomes noisy. Users cannot easily see just the plans belonging to one epic, and there is no visual connection between an epic and its linked worktree while working on the board.

**Solution**: Add a focus icon (target/crosshair) to each epic card. Clicking it enters epic focus mode:
- Board filters to show only the focused epic card and its subtasks
- Sub-bar worktree indicator switches to show only that epic's linked worktree (if one exists)
- A "clear focus" chip appears in the sub-bar so the user can exit focus mode
- Clicking the focus icon again on the same epic exits focus mode

Focus mode is client-side only — no backend changes, no db writes. It is a view filter on the already-loaded card set.

**Change — epic card rendering**: Add focus icon button to each epic card:

```javascript
if (card.isEpic) {
    const focusBtn = document.createElement('button');
    focusBtn.className = 'strip-icon-btn';
    focusBtn.style.cssText = 'padding:2px; opacity:0.6;';
    focusBtn.setAttribute('data-tooltip', 'Focus board on this epic');
    focusBtn.innerHTML = '⊙'; // or a proper SVG crosshair
    focusBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const currentFocus = window.focusedEpicId;
        window.focusedEpicId = (currentFocus === card.planId) ? null : card.planId;
        rerenderBoard();
        updateWorktreeIndicator(lastWorktrees);
    });
}
```

**Change — board render filter**: When `window.focusedEpicId` is set, filter rendered cards to the epic and its subtasks:

```javascript
function getVisibleCards(allCards) {
    if (!window.focusedEpicId) return allCards;
    return allCards.filter(c =>
        c.planId === window.focusedEpicId ||   // the epic itself
        c.epicId === window.focusedEpicId       // its subtasks
    );
}
```

**Change — sub-bar indicator update**: When in focus mode, `updateWorktreeIndicator` filters to show only the worktree linked to `window.focusedEpicId`. Also renders a "FOCUS: <epicTopic>" chip with an ✕ to clear focus:

```javascript
function updateWorktreeIndicator(worktrees) {
    // ... existing chip rendering ...
    if (window.focusedEpicId) {
        const clearChip = document.createElement('span');
        clearChip.style.cssText = '... same chip style, amber colour ...';
        clearChip.textContent = `FOCUS: ${getFocusedEpicTopic()} ✕`;
        clearChip.addEventListener('click', () => {
            window.focusedEpicId = null;
            rerenderBoard();
            updateWorktreeIndicator(lastWorktrees);
        });
        container.appendChild(clearChip);
    }
}
```

**Verification**: Click focus icon on epic → board shows only that epic and its subtasks. Sub-bar shows only that epic's linked worktree chip plus "FOCUS: topic ✕". Click ✕ → board returns to full view. Click same epic's focus icon again → exits focus mode. Epic with no linked worktree → focus mode still works, worktree chip absent.

---

### Phase 9: Epic-to-Worktree Dispatch Routing

**Files: `src/services/KanbanProvider.ts`, `src/services/TaskViewerProvider.ts`**

**Context**: When building `BatchPromptPlan` for dispatch, the code at `KanbanProvider.ts:2154` sets `worktreePath: safetySessionPath` from the old single safety session meta key. `_computeDispatchReadiness` in `TaskViewerProvider.ts` maps roles to terminals purely by role name with no worktree awareness. `findTerminalNameByWorktreePath` already exists (line 6306) but is never called during dispatch.

**Problem**: Dispatching an epic's plans sends them to whichever terminal happens to be registered for that role — regardless of which worktree the epic is linked to. Agents end up working in the wrong directory.

**Solution**:
1. When building plans for an epic card, look up whether that epic has a linked worktree in the `worktrees` table. If found, set `worktreePath` to that worktree's path on the plan and all its subtasks.
2. Make `_computeDispatchReadiness` worktree-aware: when the active plan batch has a `worktreePath`, call `findTerminalNameByWorktreePath` to find the terminal registered to that worktree and prefer it over the default role terminal.

**Change — `KanbanProvider.ts` plan building** (around line 2154):

```typescript
// Look up linked worktree for this epic
let epicWorktreePath: string | undefined;
if (card.isEpic && card.planId && hasDb) {
    const worktrees = await db.getWorktrees();
    const linked = worktrees.find(w => w.epic_id === card.planId);
    if (linked && fs.existsSync(linked.path)) {
        epicWorktreePath = linked.path;
    }
}

promptPlans.push({
    topic: card.topic,
    absolutePath: this._resolvePlanFilePath(workspaceRoot, card.planFile),
    complexity: card.complexity,
    workingDir,
    sessionId: cardKey,
    worktreePath: epicWorktreePath ?? safetySessionPath  // epic worktree takes priority
});
// subtasks inherit the same epicWorktreePath
```

**Change — `BatchPromptPlan` interface** (`agentPromptBuilder.ts`): Add `epicId` field so the dispatch readiness layer can look up the worktree without re-querying:

```typescript
export interface BatchPromptPlan {
    topic: string;
    absolutePath: string;
    complexity?: string;
    workingDir?: string;
    sessionId?: string;
    worktreePath?: string;
    epicId?: string;       // ← add
    isSubtask?: boolean;
    epicTopic?: string;
}
```

**Change — `_computeDispatchReadiness` in `TaskViewerProvider.ts`**: Accept an optional `worktreePath` parameter. When provided, call `findTerminalNameByWorktreePath` and if a match is found, return it as the preferred terminal for all roles in this dispatch batch.

**Verification**: Create worktree linked to epic → dispatch epic plans → verify prompt contains worktree path directive AND terminals with matching `worktreePath` are selected for dispatch. Verify non-epic plans still route to default role terminals.

---

### Phase 10: Sub-bar Active Worktree Indicator

**File: `src/webview/kanban.html`**

**Context**: The `kanban-sub-bar` div (line 2250) contains autoban timers, pause/reset buttons, and a status message. The board currently has no indication of which worktrees are active.

**Problem**: Users have no visibility into active worktrees while working on the kanban board. They cannot tell at a glance whether their plans will be dispatched to a worktree or the main repo.

**Solution**: Add a worktree chip/badge to the right side of `kanban-sub-bar`. When no worktrees exist it is hidden. When one or more exist it shows the branch names as compact chips. Clicking any chip switches to the Worktrees tab.

**Data source**: The `worktrees` list is already sent from the backend (Phase 6 adds `type: 'worktrees'` messages). Listen for this in the kanban message handler and update the indicator.

**Change**: Add indicator element to `kanban-sub-bar`:

```html
<div id="active-worktree-indicator" style="display:none; margin-left:auto; display:flex; gap:4px; align-items:center;"></div>
```

```javascript
function updateWorktreeIndicator(worktrees) {
    const container = document.getElementById('active-worktree-indicator');
    if (!container) return;
    container.innerHTML = '';
    const active = (worktrees || []).filter(w => w.path && fs.existsSync(w.path));
    if (active.length === 0) { container.style.display = 'none'; return; }
    container.style.display = 'flex';
    active.forEach(wt => {
        const chip = document.createElement('span');
        chip.style.cssText = 'font-family:var(--font-mono); font-size:9px; padding:2px 6px; border-radius:3px; background:rgba(0,173,159,0.12); border:1px solid var(--accent-teal); color:var(--accent-teal); cursor:pointer; white-space:nowrap;';
        chip.textContent = wt.branch;
        chip.title = wt.path;
        chip.addEventListener('click', () => switchToTab('worktrees'));
        container.appendChild(chip);
    });
}
```

**Verification**: No active worktrees → indicator hidden. Create worktree → chip appears in sub-bar with branch name. Click chip → Worktrees tab activates. Multiple worktrees → multiple chips shown.

---

## Files Changed

- `src/services/ControlPlaneMigrationService.ts` — Add `worktrees/` to fresh setup bootstrap
- `src/services/KanbanDatabase.ts` — Add V30 migration, worktrees table, CRUD methods
- `src/services/KanbanProvider.ts` — Fix worktree creation path, terminal creation, add git status, multi-worktree handlers, epic linkage, epic-to-worktree dispatch lookup
- `src/services/TaskViewerProvider.ts` — Make `_computeDispatchReadiness` worktree-aware
- `src/services/agentPromptBuilder.ts` — Add `epicId` field to `BatchPromptPlan`
- `src/webview/kanban.html` — Worktree status display, list view, epic button, epic status signal, epic focus mode, sub-bar indicator
- `src/extension.ts` — No changes (uses existing `addAutobanTerminalFromKanban` command)

## Verification Plan

### Automated Tests

- Migration V30 applies cleanly to empty and populated DBs
- `createWorktree` stores epicId correctly
- `getWorktrees` returns all worktrees for workspace
- `deleteWorktree` removes record from table

### Manual Verification

1. **Control plane enforcement**: No control plane set → Worktrees tab shows blocked message, Create button absent
2. **Fresh setup**: New control plane via setup wizard → verify `worktrees/` directory created
3. **Worktree creation path**: Create worktree → verify created in `<control-plane>/worktrees/`, not workspace root
4. **Branch naming**: Manual worktree → `worktree-<date>`. Epic worktree → slugified epic topic.
5. **Terminal force-creation**: Create worktree → verify new terminals created with worktree `cwd`, existing terminals unaffected
6. **Worktree status display**: Make changes in worktree → open tab → verify files changed and commit count shown
7. **Multi-worktree list**: Create multiple worktrees → verify all appear in list with individual merge/abandon controls
8. **Epic linkage**: Click "Create Worktree" on epic card → verify worktree linked to epic, epic column status shown
9. **Dispatch routing**: Epic linked to worktree → dispatch plans → verify worktree terminals selected, prompt contains worktree path
10. **Epic focus mode**: Click focus icon on epic → board filters to epic + subtasks only. Sub-bar shows "FOCUS: topic ✕" chip and that epic's worktree only. Click ✕ → full board restored.
11. **Sub-bar indicator**: Active worktree → chip visible in kanban sub-bar. Click chip → Worktrees tab opens.
12. **Implementation.html**: Dispatch readiness panel shows worktree terminal when epic has linked worktree.

## Risks

- **Migration failure**: Existing single-worktree sessions may not migrate correctly. Mitigation: fallback to meta keys if worktrees table is empty.
- **Git command performance**: Running git diff/log on tab refresh could be slow. Mitigation: in-memory cache with 30-second TTL.
- **Dispatch routing conflict**: If a role has terminals in both main repo and a worktree, the worktree terminal takes priority when `worktreePath` is set. Mitigation: this is intentional — epic worktree routing overrides default role routing.
- **`findTerminalNameByWorktreePath` returns undefined**: If worktree terminals were created but not registered with `worktreePath` (e.g. from an older version), routing falls back to default role terminal gracefully.

## Implementation Order Recommendation

1. **Phases 1-2** (creation path + terminal creation): foundation — everything else depends on worktrees being created correctly
2. **Phase 3** (terminal behaviour simplification): remove dead options, simplify handler
3. **Phase 4** (status display): adds visibility, low risk
4. **Phase 5** (DB migration): breaking change, do after phases 1-3 are stable
5. **Phases 6-7** (list view + epic linkage): depends on Phase 5
6. **Phase 8** (epic focus mode): depends on Phase 7 (epicId on worktree records for worktree chip filtering); board filter itself is client-side only
7. **Phase 9** (dispatch routing): depends on Phase 7 (epicId on worktree records)
8. **Phase 10** (sub-bar indicator): depends on Phase 6 (worktrees list messages); epic focus mode integration depends on Phase 8

## Key Technical Decisions

**Base branch for git diff**: Check for `main` then `master`, fall back to current branch. No hardcoding.

**Git command caching**: In-memory cache with 30-second TTL — implement during Phase 4.

**Migration rollback**: If worktrees table is empty after V30, fall back to reading old meta keys as backup.

**Dispatch priority**: Epic-linked worktree terminal takes priority over default role terminal. Non-epic plans are unaffected.

## Recommendation

**Complexity: 9 → Send to Lead Coder**

Cross-cutting changes across DB schema, backend logic, git integration, terminal management, dispatch routing, and UI. Implement incrementally in the order above — phases 1-3 deliver immediate value and unblock everything else.
