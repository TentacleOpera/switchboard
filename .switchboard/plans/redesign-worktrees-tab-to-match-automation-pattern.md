# Redesign Worktrees Tab to Match Automation Pattern

## Goal

Redesign the worktrees tab to follow the automation tab's terminal pool pattern. Users select a role (coder/lead/intern) and number of agents, and the system auto-generates worktree names/branches based on agent names and creates them as sibling directories of the workspace root. Remove the current manual path/branch input and single agent assignment approach.

## Metadata

- **Tags:** [workflow, git, ui]
- **Complexity:** 6

## User Review Required

- Confirm worktree naming convention (agent name + index pattern)
- Confirm whether worktrees should be auto-cleaned after successful review or persist
- Confirm worktree location: sibling of workspace root (e.g., `../switchboard-coder-worktree-0`) vs. a user-configurable parent directory

## Complexity Audit

### Routine
- Replacing manual input form with role selector and number input
- Auto-generating branch names based on agent names
- Creating multiple git worktrees for a single logical worktree group
- Updating DB schema to support multiple worktrees per role assignment
- Adding `getWorktreeAgents` and `assignAgentsToWorktree` CRUD methods
- Updating `renderWorktrees()` JS to show role and agent count
- Removing assign-agent button and handler

### Complex / Risky
- DB schema change: current `worktrees` table has single `coder_agent_id` field — needs table recreation (not ALTER TABLE DROP COLUMN, which sql.js may not support) to replace with `role` column and junction table
- Git worktree creation loop with rollback on partial failure — must handle mid-loop failures where some worktrees are created and others are not
- UI pattern matching automation tab's dynamic DOM construction (createElement-based, not static HTML templates)
- `_assignWorktreeToCard` must now filter worktrees by role matching the target column's role (requires mapping column ID → role via `KanbanColumnDefinition`)

## Edge-Case & Dependency Audit

- **Race Conditions**: Multiple simultaneous worktree creation requests could conflict on branch names. Mitigation: `Date.now()` + index suffix ensures uniqueness; `UNIQUE(branch, workspace_id)` constraint catches any collision at DB level.
- **Security**: Worktree paths are auto-generated as siblings of workspace root — no user input to validate. Branch names are auto-generated from agent names + timestamp — no shell injection risk since `cp.execFile` with args array is used (F-03 pattern already followed at line 6161).
- **Side Effects**: Git worktree creation failure mid-loop must rollback all created worktrees and DB entries. Rollback must also clean up any `worktree_agents` entries for partially-created worktrees (FK CASCADE handles this if worktree row is deleted).
- **Dependencies & Conflicts**: Depends on Plans A/B/C being complete (DB schema exists, CRUD methods exist). This plan replaces Plan B's UI approach. The `isAllowedSwitchboardLocation` guard (src/utils/switchboardLocationGuard.ts) is NOT relevant here since worktrees are created as siblings, not inside `.switchboard/`.

## Dependencies

- `deliberate-worktrees-a-cleanup-schema.md` — DB schema and CRUD methods (complete)
- `deliberate-worktrees-b-tab-backend.md` — Worktree management backend (complete, but will be replaced)
- `deliberate-worktrees-c-routing-review.md` — Card routing (may need updates based on new schema)

## Adversarial Synthesis

Key risks: (1) Original plan proposed creating worktrees inside `.switchboard/` within the workspace root — git forbids worktrees inside the main working tree, so worktrees must be siblings of the workspace root (matching current behavior at KanbanProvider.ts line 6155-6156). (2) Original plan re-added a `path` column to the worktrees table, but V24 explicitly removed it because paths are derived from git at read time via `_resolveWorktreePaths()`. (3) `_getAgentRole()` method referenced in plan does not exist — must use `KanbanColumnDefinition.role` from agentConfig.ts to map columns to roles. Mitigations: Use sibling directory pattern for worktree paths, keep paths git-derived (no `path` column), add `_resolveAgentRole()` helper that reads column-role mappings from the kanban column definitions.

## Proposed Changes

### File: `src/services/KanbanDatabase.ts`

1. **Add V27 migration** to update the worktrees schema (table recreation pattern, matching V20/V24 approach since sql.js may not support `ALTER TABLE DROP COLUMN`):
   - **Context**: Current schema at line 135-143 has `coder_agent_id TEXT` column. V24 (line 396-409) already demonstrated the drop-and-recreate pattern for this table.
   - **Logic**: Drop and recreate `worktrees` table with `role` column instead of `coder_agent_id`. Create `worktree_agents` junction table. Migrate existing `coder_agent_id` values.
   - **Implementation**:
   ```typescript
   // Add after MIGRATION_V26_SQL (line 429)
   const MIGRATION_V27_SQL = [
       // Step 1: Create new worktrees table with role column (no path, no coder_agent_id)
       `CREATE TABLE worktrees_v27 (
           id INTEGER PRIMARY KEY AUTOINCREMENT,
           branch TEXT NOT NULL,
           role TEXT NOT NULL DEFAULT 'coder',
           workspace_id TEXT NOT NULL,
           created_at TEXT DEFAULT (datetime('now')),
           UNIQUE(branch, workspace_id)
       )`,
       // Step 2: Migrate existing rows — infer role from coder_agent_id presence
       `INSERT INTO worktrees_v27 (id, branch, role, workspace_id, created_at)
        SELECT id, branch,
               CASE WHEN coder_agent_id IS NOT NULL AND coder_agent_id != '' THEN 'coder' ELSE 'coder' END,
               workspace_id, created_at
        FROM worktrees`,
       // Step 3: Drop old table
       `DROP TABLE worktrees`,
       // Step 4: Rename
       `ALTER TABLE worktrees_v27 RENAME TO worktrees`,
       // Step 5: Recreate index
       `CREATE INDEX IF NOT EXISTS idx_worktrees_workspace ON worktrees(workspace_id)`,
       // Step 6: Create junction table for agent-worktree relationships
       `CREATE TABLE IF NOT EXISTS worktree_agents (
           worktree_id INTEGER NOT NULL,
           agent_name TEXT NOT NULL,
           PRIMARY KEY (worktree_id, agent_name),
           FOREIGN KEY (worktree_id) REFERENCES worktrees(id) ON DELETE CASCADE
       )`,
       `CREATE INDEX IF NOT EXISTS idx_worktree_agents_worktree ON worktree_agents(worktree_id)`,
       `CREATE INDEX IF NOT EXISTS idx_worktree_agents_agent ON worktree_agents(agent_name)`,
       // Step 7: Migrate existing coder_agent_id values to worktree_agents
       `INSERT INTO worktree_agents (worktree_id, agent_name)
        SELECT id, coder_agent_id FROM worktrees_v27_backup WHERE coder_agent_id IS NOT NULL AND coder_agent_id != ''`,
   ];
   ```
   - **Edge Cases**: The backup table reference in Step 7 needs adjustment — since we DROP the old table in Step 3, we must capture `coder_agent_id` values BEFORE dropping. Either: (a) create a temporary backup table before Step 1, or (b) combine Steps 2 and 7 into a single INSERT-SELECT before the DROP. Approach (b) is cleaner:
   ```typescript
   const MIGRATION_V27_SQL = [
       // Step 1: Create new worktrees table
       `CREATE TABLE worktrees_v27 (
           id INTEGER PRIMARY KEY AUTOINCREMENT,
           branch TEXT NOT NULL,
           role TEXT NOT NULL DEFAULT 'coder',
           workspace_id TEXT NOT NULL,
           created_at TEXT DEFAULT (datetime('now')),
           UNIQUE(branch, workspace_id)
       )`,
       // Step 2: Migrate rows
       `INSERT INTO worktrees_v27 (id, branch, role, workspace_id, created_at)
        SELECT id, branch, 'coder', workspace_id, created_at FROM worktrees`,
       // Step 3: Create junction table BEFORE dropping old table
       `CREATE TABLE IF NOT EXISTS worktree_agents (
           worktree_id INTEGER NOT NULL,
           agent_name TEXT NOT NULL,
           PRIMARY KEY (worktree_id, agent_name),
           FOREIGN KEY (worktree_id) REFERENCES worktrees_v27(id) ON DELETE CASCADE
       )`,
       // Step 4: Migrate coder_agent_id → worktree_agents (while old table still exists)
       `INSERT INTO worktree_agents (worktree_id, agent_name)
        SELECT id, coder_agent_id FROM worktrees WHERE coder_agent_id IS NOT NULL AND coder_agent_id != ''`,
       // Step 5: Drop old table
       `DROP TABLE worktrees`,
       // Step 6: Rename
       `ALTER TABLE worktrees_v27 RENAME TO worktrees`,
       // Step 7: Recreate indexes
       `CREATE INDEX IF NOT EXISTS idx_worktrees_workspace ON worktrees(workspace_id)`,
       `CREATE INDEX IF NOT EXISTS idx_worktree_agents_worktree ON worktree_agents(worktree_id)`,
       `CREATE INDEX IF NOT EXISTS idx_worktree_agents_agent ON worktree_agents(agent_name)`,
   ];
   ```

2. **Update SCHEMA_SQL** (line 89-144) to reflect new schema for fresh DBs:
   ```sql
   CREATE TABLE IF NOT EXISTS worktrees (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       branch TEXT NOT NULL,
       role TEXT NOT NULL DEFAULT 'coder',
       workspace_id TEXT NOT NULL,
       created_at TEXT DEFAULT (datetime('now')),
       UNIQUE(branch, workspace_id)
   );
   CREATE INDEX IF NOT EXISTS idx_worktrees_workspace ON worktrees(workspace_id);
   CREATE TABLE IF NOT EXISTS worktree_agents (
       worktree_id INTEGER NOT NULL,
       agent_name TEXT NOT NULL,
       PRIMARY KEY (worktree_id, agent_name),
       FOREIGN KEY (worktree_id) REFERENCES worktrees(id) ON DELETE CASCADE
   );
   CREATE INDEX IF NOT EXISTS idx_worktree_agents_worktree ON worktree_agents(worktree_id);
   CREATE INDEX IF NOT EXISTS idx_worktree_agents_agent ON worktree_agents(agent_name);
   ```

3. **Update `createWorktree` method** (line 1392-1412):
   - Remove `coderAgentId` parameter, add `role` parameter
   - Signature: `createWorktree(branch: string, role: string): Promise<number>`
   - SQL: `INSERT INTO worktrees (branch, role, workspace_id) VALUES (?, ?, ?)`

4. **Update `getWorktrees` method** (line 1414-1434):
   - Return `role` instead of `coderAgentId`
   - Signature: `getWorktrees(): Promise<Array<{ id: number; branch: string; role: string }>>`
   - SQL: `SELECT id, branch, role FROM worktrees WHERE workspace_id = ?`

5. **Add `assignAgentToWorktree` (junction)** method:
   ```typescript
   public async assignAgentToWorktree(worktreeId: number, agentName: string): Promise<void> {
       if (!this._db) return;
       this._db.run(
           'INSERT OR IGNORE INTO worktree_agents (worktree_id, agent_name) VALUES (?, ?)',
           [worktreeId, agentName]
       );
       await this._persist();
   }
   ```

6. **Add `getWorktreeAgents` method**:
   ```typescript
   public async getWorktreeAgents(worktreeId: number): Promise<string[]> {
       if (!this._db) return [];
       const stmt = this._db.prepare(
           'SELECT agent_name FROM worktree_agents WHERE worktree_id = ?'
       );
       try {
           stmt.bind([worktreeId]);
           const results: string[] = [];
           while (stmt.step()) {
               results.push(stmt.getAsObject().agent_name as string);
           }
           return results;
       } finally {
           stmt.free();
       }
   }
   ```

7. **Update `getWorktreeById` method** (line 1462-1469):
   - Return `role` instead of `coderAgentId`
   - SQL: `SELECT id, branch, role FROM worktrees WHERE id = ?`

8. **Remove old `assignAgentToWorktree(coderAgentId)` method** (line 1444-1451) — replaced by junction table version above.

9. **Add V27 migration execution** in `_runMigrations()` method (after V26 block, around line 3865):
   ```typescript
   if (currentVersion < 27) {
       for (const sql of MIGRATION_V27_SQL) {
           try { this._db.exec(sql); } catch (e) {
               const msg = e instanceof Error ? e.message : String(e);
               if (!msg.includes('duplicate column') && !msg.includes('already exists')) {
                   console.warn('[KanbanDatabase] V27 migration step failed:', msg);
               }
           }
       }
       await this.setMigrationVersion(27);
       console.log('[KanbanDatabase] V27 migration completed: worktrees role column + worktree_agents junction table');
   }
   ```

### File: `src/webview/kanban.html`

1. **Replace worktrees tab content** (lines 2639-2662) with automation-style dynamic panel root:
   - **Context**: Current tab uses static HTML with `<template>` elements. The automation tab (line 2087-2089) uses a single `<div id="automation-panel-root">` and builds DOM dynamically via `createAutobanPanel()`. The worktrees tab should follow this exact pattern.
   - **Implementation**:
   ```html
   <div id="worktrees-tab-content" class="kanban-tab-content">
       <div id="worktree-panel-root" class="automation-panel"></div>
   </div>
   ```
   Remove the `<template id="worktree-item-template">` block (lines 2650-2662) entirely — items will be built dynamically.

2. **Add `createWorktreePanel()` function** in the `<script>` section (near `createAutobanPanel()` around line 6038):
   - **Context**: Must match the automation tab's visual pattern: `db-subsection` containers, `subsection-header` styling, role-based pool blocks with capacity chips, inline status badges.
   - **Logic**: Build a panel with:
     - Header section: "GIT WORKTREES" with role selector and agent count input
     - Role-based pool display: for each role that has worktrees, show a pool block with worktree entries
     - Each worktree entry shows: branch name, path (git-derived), agent names, status badges
     - "Create Worktree" button that sends `createWorktree` message with role + agentCount
     - "Delete" button per worktree
   - **Implementation**:
   ```javascript
   function createWorktreePanel() {
       const container = document.createElement('div');
       container.style.cssText = 'padding: 8px; display: flex; flex-direction: column; gap: 12px;';

       // ── Create Section ──
       const createSection = document.createElement('div');
       createSection.className = 'db-subsection';

       const createHeader = document.createElement('div');
       createHeader.className = 'subsection-header';
       const createSpan = document.createElement('span');
       createSpan.textContent = 'CREATE WORKTREES';
       createHeader.appendChild(createSpan);
       createSection.appendChild(createHeader);

       const createRow = document.createElement('div');
       createRow.style.cssText = 'display:flex; align-items:center; gap:8px; padding:0 8px; font-family:var(--font-mono); font-size:10px; color:var(--text-secondary);';

       const roleLabel = document.createElement('span');
       roleLabel.textContent = 'ROLE:';

       const roleSelect = document.createElement('select');
       roleSelect.style.cssText = 'background:var(--panel-bg2); border:1px solid var(--border-color); color:var(--text-primary); font-family:var(--font-mono); font-size:10px; padding:2px 4px; border-radius:3px;';
       ['coder', 'lead', 'intern'].forEach(r => {
           const opt = document.createElement('option');
           opt.value = r;
           opt.textContent = r.charAt(0).toUpperCase() + r.slice(1);
           roleSelect.appendChild(opt);
       });

       const countLabel = document.createElement('span');
       countLabel.textContent = 'AGENTS:';

       const countInput = document.createElement('input');
       countInput.type = 'number';
       countInput.min = '1';
       countInput.max = '10';
       countInput.value = '1';
       countInput.style.cssText = 'width:56px; background:var(--panel-bg2); border:1px solid var(--border-color); color:var(--text-primary); font-family:var(--font-mono); font-size:10px; padding:2px 4px; border-radius:3px; text-align:center;';

       const createBtn = document.createElement('button');
       createBtn.className = 'strip-btn';
       createBtn.textContent = 'CREATE';
       createBtn.addEventListener('click', () => {
           postKanbanMessage({
               type: 'createWorktree',
               role: roleSelect.value,
               agentCount: parseInt(countInput.value, 10) || 1,
               workspaceRoot: currentWorkspaceRoot
           });
       });

       createRow.appendChild(roleLabel);
       createRow.appendChild(roleSelect);
       createRow.appendChild(countLabel);
       createRow.appendChild(countInput);
       createRow.appendChild(createBtn);
       createSection.appendChild(createRow);
       container.appendChild(createSection);

       // ── Pools Section ──
       const poolsSection = document.createElement('div');
       poolsSection.className = 'db-subsection';

       const poolsHeader = document.createElement('div');
       poolsHeader.className = 'subsection-header';
       const poolsSpan = document.createElement('span');
       poolsSpan.textContent = 'WORKTREE POOLS';
       poolsHeader.appendChild(poolsSpan);
       poolsSection.appendChild(poolsHeader);

       const chipStyle = 'display:inline-flex; align-items:center; gap:4px; border:1px solid var(--border-color); border-radius:999px; padding:1px 6px; font-size:9px; color:var(--text-secondary);';

       const roles = ['coder', 'lead', 'intern'];
       roles.forEach(role => {
           const roleWorktrees = (lastWorktrees || []).filter(wt => wt.role === role);
           const roleBlock = document.createElement('div');
           roleBlock.style.cssText = 'display:flex; flex-direction:column; gap:6px; padding:6px 8px; border:1px solid var(--border-color); border-radius:6px; background:var(--panel-bg2); margin-bottom:8px;';

           const roleHeader = document.createElement('div');
           roleHeader.style.cssText = 'display:flex; align-items:center; justify-content:space-between; gap:8px;';

           const roleTitle = document.createElement('span');
           roleTitle.style.cssText = 'font-family:var(--font-mono); font-size:10px; color:var(--text-primary);';
           roleTitle.textContent = role.charAt(0).toUpperCase() + role.slice(1);

           const roleCapacity = document.createElement('span');
           roleCapacity.style.cssText = chipStyle;
           roleCapacity.textContent = roleWorktrees.length + ' WORKTREE' + (roleWorktrees.length !== 1 ? 'S' : '');

           roleHeader.appendChild(roleTitle);
           roleHeader.appendChild(roleCapacity);
           roleBlock.appendChild(roleHeader);

           if (roleWorktrees.length === 0) {
               const emptyState = document.createElement('div');
               emptyState.style.cssText = 'font-family:var(--font-mono); font-size:9px; color:var(--text-secondary);';
               emptyState.textContent = 'No worktrees for this role.';
               roleBlock.appendChild(emptyState);
           } else {
               roleWorktrees.forEach(wt => {
                   const wtRow = document.createElement('div');
                   wtRow.style.cssText = 'display:flex; align-items:center; gap:6px; justify-content:space-between; flex-wrap:wrap;';

                   const left = document.createElement('div');
                   left.style.cssText = 'display:flex; align-items:center; gap:6px; min-width:0; flex-wrap:wrap;';

                   const branchSpan = document.createElement('span');
                   branchSpan.style.cssText = 'font-family:var(--font-mono); font-size:10px; color:var(--text-primary);';
                   branchSpan.textContent = wt.branch;

                   const pathBadge = document.createElement('span');
                   pathBadge.style.cssText = chipStyle;
                   pathBadge.textContent = wt.path || 'Unknown path';

                   const agentBadge = document.createElement('span');
                   agentBadge.style.cssText = chipStyle;
                   agentBadge.textContent = (wt.agentCount || 0) + ' agent' + ((wt.agentCount || 0) !== 1 ? 's' : '');

                   left.appendChild(branchSpan);
                   left.appendChild(pathBadge);
                   left.appendChild(agentBadge);

                   const right = document.createElement('div');
                   right.style.cssText = 'display:flex; align-items:center; gap:6px;';

                   const deleteBtn = document.createElement('button');
                   deleteBtn.style.cssText = 'background:var(--panel-bg2); border:1px solid var(--border-color); color:var(--accent-red, #e55); font-family:var(--font-mono); font-size:9px; padding:3px 6px; border-radius:4px; cursor:pointer;';
                   deleteBtn.textContent = 'DELETE';
                   deleteBtn.addEventListener('click', () => {
                       postKanbanMessage({ type: 'deleteWorktree', worktreeId: wt.id, workspaceRoot: currentWorkspaceRoot });
                   });
                   right.appendChild(deleteBtn);

                   wtRow.appendChild(left);
                   wtRow.appendChild(right);
                   roleBlock.appendChild(wtRow);
               });
           }

           poolsSection.appendChild(roleBlock);
       });

       container.appendChild(poolsSection);
       return container;
   }

   let lastWorktrees = [];

   function renderWorktreePanel() {
       const root = document.getElementById('worktree-panel-root');
       if (!root) return;
       root.innerHTML = '';
       root.appendChild(createWorktreePanel());
   }
   ```

3. **Update message listener** (around line 5193) to store worktrees and re-render:
   ```javascript
   // Replace existing worktrees message handler
   if (msg.type === 'worktrees') {
       lastWorktrees = msg.worktrees || [];
       renderWorktreePanel();
   }
   ```

4. **Update tab click handler** to render worktree panel when tab is opened (near line 6622):
   ```javascript
   if (btn.dataset.tab === 'worktrees') {
       postKanbanMessage({ type: 'getWorktrees', workspaceRoot: currentWorkspaceRoot });
       renderWorktreePanel();
   }
   ```

5. **Remove old `renderWorktrees` function** (line 7081-7098) — replaced by `createWorktreePanel` + `renderWorktreePanel`.

6. **Remove old worktree tab listeners** (lines 7152-7171) — replaced by inline event handlers in `createWorktreePanel`.

7. **Update CSS** — remove `.worktree-item`, `.worktree-path`, `.worktree-branch`, `.worktree-agent`, `.worktree-actions` styles (lines 1950-1977) since they're no longer used. The dynamic panel uses the same `db-subsection` and chip styles as the automation tab.

### File: `src/services/KanbanProvider.ts`

1. **Add `_resolveAgentRole` helper method** (new, near line 3250):
   - **Context**: The plan's original code referenced a non-existent `_getAgentRole()` method. The automation tab determines roles from terminal metadata (`lastTerminals[name].role`), but for worktree creation we need to know which agents belong to which role. The `_getVisibleAgents()` method (line 3250) returns `Record<string, boolean>` with no role info. We need a new method.
   - **Logic**: Read `state.json` → parse `customAgents` → build a map of agent name → role. For built-in agents, the role IS the key name (e.g., "coder" → "coder", "lead" → "lead").
   - **Implementation**:
   ```typescript
   private async _resolveAgentRole(workspaceRoot: string, agentName: string): Promise<string | null> {
       // Built-in agents: the agent name IS the role
       const builtInRoles = ['lead', 'coder', 'intern', 'reviewer', 'tester', 'planner', 'analyst', 'jules', 'gatherer', 'ticket_updater', 'researcher', 'splitter', 'code_researcher'];
       if (builtInRoles.includes(agentName)) {
           return agentName;
       }
       // Custom agents: read from state.json
       const statePath = path.join(workspaceRoot, '.switchboard', 'state.json');
       try {
           if (fs.existsSync(statePath)) {
               const content = await fs.promises.readFile(statePath, 'utf8');
               const state = JSON.parse(content);
               const customAgents = parseCustomAgents(state.customAgents);
               const match = customAgents.find(a => a.role === agentName || a.name === agentName);
               return match?.role || null;
           }
       } catch (e) {
           console.error('[KanbanProvider] Failed to resolve agent role:', e);
       }
       return null;
   }

   private async _getAgentsForRole(workspaceRoot: string, role: string): Promise<string[]> {
       const visibleAgents = await this._getVisibleAgents(workspaceRoot);
       const agents: string[] = [];
       for (const [name, enabled] of Object.entries(visibleAgents)) {
           if (!enabled) continue;
           const agentRole = await this._resolveAgentRole(workspaceRoot, name);
           if (agentRole === role) {
               agents.push(name);
           }
       }
       return agents;
   }
   ```

2. **Update `createWorktree` handler** (lines 6136-6173):
   - **Context**: Current handler uses `vscode.window.showInputBox` for path and branch. New handler receives `role` and `agentCount` from webview message and auto-generates paths/branches.
   - **CRITICAL**: Worktrees must be created as SIBLING directories of the workspace root (e.g., `../switchboard-coder-XXXX-0`), NOT inside `.switchboard/`. Git forbids worktrees inside the main working tree. The current code already uses `path.dirname(workspaceRoot)` (line 6155).
   - **Implementation**:
   ```typescript
   case 'createWorktree': {
       const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
       if (!workspaceRoot) break;
       const role = msg.role;  // 'coder', 'lead', 'intern'
       const agentCount = Math.max(1, Math.min(10, parseInt(msg.agentCount, 10) || 1));

       const db = this._getKanbanDb(workspaceRoot);
       if (!db || !await db.ensureReady()) break;

       // Get agents for the selected role
       const roleAgents = await this._getAgentsForRole(workspaceRoot, role);

       if (roleAgents.length === 0) {
           vscode.window.showWarningMessage(`No ${role} agents configured. Set up agents in Setup first.`);
           break;
       }

       // Auto-generate worktree paths as siblings of workspace root
       const parentDir = path.dirname(workspaceRoot);
       const timestamp = Date.now();
       const createdWorktrees: Array<{ id: number; path: string; branch: string }> = [];

       try {
           for (let i = 0; i < agentCount; i++) {
               const agentName = roleAgents[i % roleAgents.length];
               const worktreeDirName = `switchboard-${role}-${timestamp}-${i}`;
               const fullPath = path.join(parentDir, worktreeDirName);
               const branchName = `${agentName.replace(/[^A-Za-z0-9._\/-]/g, '-').toLowerCase()}-${role}-${timestamp}-${i}`;

               // Validate auto-generated branch name (matches existing validation at line 6149)
               if (!/^[A-Za-z0-9][A-Za-z0-9._\/-]*$/.test(branchName) || branchName.includes('..') || branchName.endsWith('.lock') || branchName.endsWith('/') || branchName.startsWith('-')) {
                   throw new Error(`Auto-generated branch name '${branchName}' is invalid`);
               }

               // Create DB entry
               const wtId = await db.createWorktree(branchName, role);

               // Create git worktree (SECURITY: execFile with args array, F-03)
               const execFileAsync = promisify(cp.execFile);
               try {
                   await execFileAsync('git', ['worktree', 'add', '-b', branchName, fullPath], { cwd: workspaceRoot });
               } catch (gitError: any) {
                   // Rollback DB entry if git fails
                   await db.deleteWorktree(wtId);
                   throw gitError;
               }

               // Assign agent to worktree
               await db.assignAgentToWorktree(wtId, agentName);

               createdWorktrees.push({ id: wtId, path: fullPath, branch: branchName });
           }

           vscode.window.showInformationMessage(`Created ${agentCount} ${role} worktree(s)`);

           // Refresh worktrees list with enriched data
           const worktrees = await db.getWorktrees();
           const branchToPath = await this._resolveWorktreePaths(workspaceRoot);
           const enriched = await Promise.all(worktrees.map(async (wt) => {
               const agents = await db.getWorktreeAgents(wt.id);
               return { ...wt, path: branchToPath.get(wt.branch) || '', agentCount: agents.length, agents };
           }));
           this._panel?.webview.postMessage({ type: 'worktrees', worktrees: enriched });

       } catch (e: any) {
           // Rollback: delete all created worktrees and DB entries
           vscode.window.showErrorMessage(`Failed to create worktrees: ${e.message}`);

           const execFileAsync = promisify(cp.execFile);
           for (const wt of createdWorktrees) {
               try {
                   await execFileAsync('git', ['worktree', 'remove', '--force', wt.path], { cwd: workspaceRoot });
                   await execFileAsync('git', ['branch', '-D', wt.branch], { cwd: workspaceRoot });
               } catch { /* ignore cleanup errors */ }
               await db.deleteWorktree(wt.id);
           }
       }
       break;
   }
   ```

3. **Remove `assignAgentToWorktree` handler** (lines 6215-6238) — agents are now assigned during creation, not manually afterward.

4. **Update `getWorktrees` handler** (lines 6124-6135) to enrich with agent data:
   ```typescript
   case 'getWorktrees': {
       const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
       if (!workspaceRoot) break;
       const db = this._getKanbanDb(workspaceRoot);
       if (db && await db.ensureReady()) {
           const worktrees = await db.getWorktrees();
           const branchToPath = await this._resolveWorktreePaths(workspaceRoot);

           // Enrich with agent counts and names
           const enriched = await Promise.all(worktrees.map(async (wt) => {
               const agents = await db.getWorktreeAgents(wt.id);
               return {
                   ...wt,
                   path: branchToPath.get(wt.branch) || '',
                   agentCount: agents.length,
                   agents
               };
           }));

           this._panel?.webview.postMessage({ type: 'worktrees', worktrees: enriched });
       }
       break;
   }
   ```

5. **Update `_assignWorktreeToCard`** (lines 6505-6544) to filter by role:
   - **Context**: Currently filters by `coderAgentId !== null` (line 6513). Must now filter by role matching the target column.
   - **Logic**: When a card moves to a coder column, find worktrees with `role = 'coder'`. Use `KanbanColumnDefinition.role` from `agentConfig.ts` to determine the column's role.
   - **Implementation**:
   ```typescript
   private async _assignWorktreeToCard(workspaceRoot: string, sessionId: string, targetColumn?: string): Promise<void> {
       const db = this._getKanbanDb(workspaceRoot);
       if (!db || !await db.ensureReady()) return;

       const plan = await db.getPlanBySessionId(sessionId);
       if (plan && plan.worktreeId) return;

       const worktrees = await db.getWorktrees();

       // Determine role from target column
       let targetRole: string | null = null;
       if (targetColumn) {
           const columnDefs = this._buildKanbanColumns(
               await this._getCustomAgents(workspaceRoot),
               await this._getCustomKanbanColumns(workspaceRoot)
           );
           const colDef = columnDefs.find(c => c.id === targetColumn);
           targetRole = colDef?.role || null;
       }

       // Filter worktrees by role (if determined), otherwise use all
       const availableWorktrees = targetRole
           ? worktrees.filter(wt => wt.role === targetRole)
           : worktrees;

       if (availableWorktrees.length === 0) {
           return; // No worktrees available for this role
       }

       const workspaceId = await db.getWorkspaceId();
       if (!workspaceId) return;
       const cards = await db.getBoard(workspaceId);
       const assignmentCounts = new Map<number, number>();
       availableWorktrees.forEach(wt => assignmentCounts.set(wt.id, 0));

       cards.forEach(card => {
           if (card.worktreeId && assignmentCounts.has(card.worktreeId)) {
               assignmentCounts.set(card.worktreeId, (assignmentCounts.get(card.worktreeId) || 0) + 1);
           }
       });

       // Find worktree with minimum assignments
       let minCount = Infinity;
       let selectedWorktreeId: number | null = null;
       for (const [wtId, count] of assignmentCounts) {
           if (count < minCount) {
               minCount = count;
               selectedWorktreeId = wtId;
           }
       }

       if (selectedWorktreeId !== null) {
           await db.updatePlanWorktree(sessionId, selectedWorktreeId);
       }
   }
   ```

6. **Update `_assignWorktreeToCard` call sites** (lines 3732, 3775) to pass `targetColumn`:
   ```typescript
   // Line 3732:
   await this._assignWorktreeToCard(workspaceRoot, sessionId, targetColumn);
   // Line 3775:
   await this._assignWorktreeToCard(workspaceRoot, sessionId, targetColumn);
   ```

7. **Update `deleteWorktree` handler** (lines 6175-6213): No structural changes needed — `db.deleteWorktree()` already clears `worktree_id` on plans (line 1439), and FK CASCADE on `worktree_agents` will auto-delete junction rows.

## Verification Plan

### Automated Tests
- TypeScript compilation must pass (SKIPPED for this session per instructions)
- Existing unit tests must pass (SKIPPED for this session per instructions)

### Manual Verification
- Open kanban board, click Worktrees tab — tab renders with role selector and agent count input matching automation tab styling
- Select "coder" role, enter "3" agents, click Create — 3 worktrees created as siblings of workspace root (e.g., `../switchboard-coder-XXXX-0`, `../switchboard-coder-XXXX-1`, `../switchboard-coder-XXXX-2`)
- Worktrees list shows role-grouped pool blocks with branch, path, and agent count badges
- Delete worktree — git worktree removed, branch deleted, DB entries cleaned up (including worktree_agents via CASCADE)
- Move card to CODER CODED column — card assigned to a worktree with `role = 'coder'` (not lead/intern)
- Move card to LEAD CODED column — card assigned to a worktree with `role = 'lead'` (not coder/intern)
- Move card to INTERN CODED column — card assigned to a worktree with `role = 'intern'`
- Attempt to create worktrees for a role with no configured agents — warning message shown
- Verify existing DB with `coder_agent_id` values migrates correctly: V27 preserves existing worktrees, migrates agent assignments to junction table

## Recommendation

**Complexity: 6 → Send to Coder**

The core changes are routine (CRUD method updates, UI replacement), but there are two well-scoped moderate risks: (1) the V27 migration must correctly recreate the worktrees table while preserving data and migrating `coder_agent_id` to the junction table, and (2) the `_assignWorktreeToCard` role-filtering logic must correctly map column IDs to roles via `KanbanColumnDefinition`. Both risks are well-contained within single functions and have clear test criteria.
