# Redesign Worktrees Tab to Match Automation Pattern

## Goal

Redesign the worktrees tab to follow the automation tab's terminal pool pattern. Users select a role (coder/lead/intern) and number of agents, and the system auto-generates worktree names/branches based on agent names and creates them as sibling directories of the workspace root. Remove the current manual path/branch input and single agent assignment approach.

## Metadata

- **Tags:** [workflow, git, ui]
- **Complexity:** 4

## User Review Required

- Confirm worktree naming convention (agent name + index pattern)
- Confirm whether worktrees should be auto-cleaned after successful review or persist
- Confirm worktree location: sibling of workspace root (e.g., `../switchboard-coder-worktree-0`) vs. a user-configurable parent directory

## Complexity Audit

### Routine
- Replacing manual input form with role selector and number input
- Auto-generating branch names based on agent names
- Creating multiple git worktrees for a single logical worktree group
- Updating `renderWorktrees()` JS to show role and agent name
- Removing assign-agent button and handler
- Filtering `_assignWorktreeToCard` by role (using existing `coder_agent_id` value)

### Complex / Risky
- Git worktree creation loop with rollback on partial failure — must handle mid-loop failures where some worktrees are created and others are not
- UI pattern matching automation tab's dynamic DOM construction (createElement-based, not static HTML templates)

## Edge-Case & Dependency Audit

- **Race Conditions**: Multiple simultaneous worktree creation requests could conflict on branch names. Mitigation: `Date.now()` + index suffix ensures uniqueness; `UNIQUE(branch, workspace_id)` constraint catches any collision at DB level.
- **Security**: Worktree paths are auto-generated as siblings of workspace root — no user input to validate. Branch names are auto-generated from agent names + timestamp — no shell injection risk since `cp.execFile` with args array is used (F-03 pattern already followed at line 6161).
- **Side Effects**: Git worktree creation failure mid-loop must rollback all created worktrees and DB entries.
- **Dependencies & Conflicts**: Depends on Plans A/B/C being complete (DB schema exists, CRUD methods exist). This plan replaces Plan B's UI approach. No schema change required — `coder_agent_id` already stores agent/role names and serves as a de facto role field.

## Dependencies

- `deliberate-worktrees-a-cleanup-schema.md` — DB schema and CRUD methods (complete)
- `deliberate-worktrees-b-tab-backend.md` — Worktree management backend (complete, but will be replaced)
- `deliberate-worktrees-c-routing-review.md` — Card routing (may need updates based on new schema)

## Adversarial Synthesis

Key risks: (1) Original plan proposed creating worktrees inside `.switchboard/` within the workspace root — git forbids worktrees inside the main working tree, so worktrees must be siblings of the workspace root (matching current behavior at KanbanProvider.ts line 6155-6156). (2) Original plan proposed a schema migration (V27) with junction table — but `coder_agent_id` is already a `TEXT` column storing agent/role names (e.g., "coder", "lead", "intern"), so it already serves as a de facto role field. No migration needed. Mitigations: Use sibling directory pattern for worktree paths, repurpose `coder_agent_id` as the role identifier at read time, derive role from the stored agent name.

## Proposed Changes

### File: `src/services/KanbanDatabase.ts`

**No changes required.** The existing schema already supports this feature:

- `coder_agent_id TEXT` — Despite the misleading column name, this stores agent/role identifiers like "coder", "lead", "intern" (see `_getVisibleAgents()` at line 3250 which returns these as keys). It functions as the role field already.
- `createWorktree(branch, coderAgentId)` — The `coderAgentId` parameter will receive the role name (e.g., "coder", "lead", "intern") instead of being left `null`.
- `getWorktrees()` — Returns `coderAgentId` which IS the role. The webview can use this value directly as the role identifier.
- `assignAgentToWorktree(worktreeId, coderAgentId)` — Already exists, already works for any agent name.
- Paths are derived from git at read time via `_resolveWorktreePaths()` — no `path` column needed (V24 removed it for this reason).

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
     - Each worktree entry shows: branch name, path (git-derived), agent name badge
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
           // coder_agent_id stores the role name, so filter by it
           const roleWorktrees = (lastWorktrees || []).filter(wt => wt.coderAgentId === role);
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

                   left.appendChild(branchSpan);
                   left.appendChild(pathBadge);

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

1. **Update `createWorktree` handler** (lines 6136-6173):
   - **Context**: Current handler uses `vscode.window.showInputBox` for path and branch. New handler receives `role` and `agentCount` from webview message and auto-generates paths/branches.
   - **CRITICAL**: Worktrees must be created as SIBLING directories of the workspace root (e.g., `../switchboard-coder-XXXX-0`), NOT inside `.switchboard/`. Git forbids worktrees inside the main working tree. The current code already uses `path.dirname(workspaceRoot)` (line 6155).
   - **Logic**: For each agent in the requested count, auto-generate a branch name and worktree path, create the git worktree, and store the role name in `coder_agent_id`.
   - **Implementation**:
   ```typescript
   case 'createWorktree': {
       const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
       if (!workspaceRoot) break;
       const role = msg.role;  // 'coder', 'lead', 'intern'
       const agentCount = Math.max(1, Math.min(10, parseInt(msg.agentCount, 10) || 1));

       const db = this._getKanbanDb(workspaceRoot);
       if (!db || !await db.ensureReady()) break;

       // Verify the role has a visible agent
       const visibleAgents = await this._getVisibleAgents(workspaceRoot);
       if (!visibleAgents[role]) {
           vscode.window.showWarningMessage(`No ${role} agent configured. Enable it in Setup first.`);
           break;
       }

       // Auto-generate worktree paths as siblings of workspace root
       const parentDir = path.dirname(workspaceRoot);
       const timestamp = Date.now();
       const createdWorktrees: Array<{ id: number; path: string; branch: string }> = [];

       try {
           for (let i = 0; i < agentCount; i++) {
               const worktreeDirName = `switchboard-${role}-${timestamp}-${i}`;
               const fullPath = path.join(parentDir, worktreeDirName);
               const branchName = `${role}-${timestamp}-${i}`;

               // Create DB entry — store role name in coder_agent_id
               const id = await db.createWorktree(branchName, role);

               // Create git worktree (SECURITY: execFile with args array, F-03)
               const execFileAsync = promisify(cp.execFile);
               try {
                   await execFileAsync('git', ['worktree', 'add', '-b', branchName, fullPath], { cwd: workspaceRoot });
               } catch (gitError: any) {
                   // Rollback DB entry if git fails
                   await db.deleteWorktree(id);
                   throw gitError;
               }

               createdWorktrees.push({ id, path: fullPath, branch: branchName });
           }

           vscode.window.showInformationMessage(`Created ${agentCount} ${role} worktree(s)`);

           // Refresh worktrees list with enriched data
           const worktrees = await db.getWorktrees();
           const branchToPath = await this._resolveWorktreePaths(workspaceRoot);
           const enriched = worktrees.map(wt => ({ ...wt, path: branchToPath.get(wt.branch) || '' }));
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

2. **Remove `assignAgentToWorktree` handler** (lines 6215-6238) — agents are now assigned during creation (role name stored in `coder_agent_id`), not manually afterward.

3. **Update `_assignWorktreeToCard`** (lines 6505-6544) to filter by role:
   - **Context**: Currently filters by `coderAgentId !== null` (line 6513). Must now filter by `coderAgentId` matching the target column's role. The `coder_agent_id` column stores the role name (e.g., "coder", "lead", "intern"), so filtering is straightforward.
   - **Logic**: When a card moves to a coder column, find worktrees where `coderAgentId === 'coder'`. Use `KanbanColumnDefinition.role` from `agentConfig.ts` to determine the column's role.
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

       // Filter worktrees by role (coder_agent_id stores the role name)
       const availableWorktrees = targetRole
           ? worktrees.filter(wt => wt.coderAgentId === targetRole)
           : worktrees.filter(wt => wt.coderAgentId !== null);

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

4. **Update `_assignWorktreeToCard` call sites** (lines 3732, 3775) to pass `targetColumn`:
   ```typescript
   // Line 3732:
   await this._assignWorktreeToCard(workspaceRoot, sessionId, targetColumn);
   // Line 3775:
   await this._assignWorktreeToCard(workspaceRoot, sessionId, targetColumn);
   ```

## Verification Plan

### Automated Tests
- TypeScript compilation must pass (SKIPPED for this session per instructions)
- Existing unit tests must pass (SKIPPED for this session per instructions)

### Manual Verification
- Open kanban board, click Worktrees tab — tab renders with role selector and agent count input matching automation tab styling
- Select "coder" role, enter "3" agents, click Create — 3 worktrees created as siblings of workspace root (e.g., `../switchboard-coder-XXXX-0`, `../switchboard-coder-XXXX-1`, `../switchboard-coder-XXXX-2`)
- Worktrees list shows role-grouped pool blocks with branch and path badges
- Delete worktree — git worktree removed, branch deleted, DB entry cleaned up
- Move card to CODER CODED column — card assigned to a worktree where `coder_agent_id = 'coder'` (not lead/intern)
- Move card to LEAD CODED column — card assigned to a worktree where `coder_agent_id = 'lead'` (not coder/intern)
- Move card to INTERN CODED column — card assigned to a worktree where `coder_agent_id = 'intern'`
- Attempt to create worktrees for a role with no enabled agent — warning message shown
- Verify existing DB with `coder_agent_id = null` worktrees still works — they appear in an "Unassigned" section or are filtered out of role pools

## Recommendation

**Complexity: 4 → Send to Coder**

No schema changes, no migrations. This is a UI replacement (static HTML → dynamic panel matching automation tab) and a backend logic update (manual input → auto-generation based on role + count). The only moderate risk is the git worktree creation loop with rollback on partial failure, which is well-scoped within a single handler function.
