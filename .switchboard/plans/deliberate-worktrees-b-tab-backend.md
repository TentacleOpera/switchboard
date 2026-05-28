# Worktrees B: Tab UI + Management Backend

## Goal

Add the Worktrees tab to the kanban board UI and wire it to backend message handlers for creating, listing, deleting, and assigning agents to worktrees. Depends on Plan A (schema + CRUD methods must exist).

## Metadata

- **Tags:** [workflow, git, ui]
- **Complexity:** 3

## User Review Required

- Confirm UI placement of worktrees tab (new tab vs subsection of existing tab)

## Complexity Audit

### Routine
- Adding worktrees tab to kanban.html (follows existing tab pattern)
- Adding message handlers in KanbanProvider (follows existing pattern)
- Using `vscode.window.showInputBox` for path/branch input

### Complex / Risky
- None

## Edge-Case & Dependency Audit

- **Race Conditions**: None — single-user UI interactions.
- **Security**: Worktree paths outside workspace could expose structure. Mitigation: validate paths are within workspace parent directory.
- **Side Effects**: Git worktree creation fails — must rollback DB entry.
- **Dependencies & Conflicts**: Depends on Plan A being complete (DB methods must exist).

## Dependencies

- `deliberate-worktrees-a-cleanup-schema.md` — Must be complete before starting this plan.

## Adversarial Synthesis

Key risks: (1) Git worktree creation could fail after DB entry is created — must delete DB entry on failure. (2) Agent list from `_getVisibleAgents()` could be empty — must handle gracefully with a warning message. Mitigations: Rollback DB on git failure, show warning when no agents configured.

## Proposed Changes

### File: `src/webview/kanban.html`

1. **Add worktrees tab to tab navigation** (after agents tab):
   ```html
   <button class="tab-btn" data-tab="worktrees">Worktrees</button>
   ```

2. **Add worktrees tab content**:
   ```html
   <div id="tab-worktrees" class="tab-content" style="display:none;">
     <div class="worktrees-header">
       <h3>Git Worktrees</h3>
       <button id="create-worktree-btn" class="btn-primary">Create Worktree</button>
     </div>
     <div id="worktrees-list" class="worktrees-list"></div>
   </div>
   ```

3. **Add worktree item template**:
   ```html
   <template id="worktree-item-template">
     <div class="worktree-item" data-worktree-id="">
       <div class="worktree-info">
         <div class="worktree-path"></div>
         <div class="worktree-branch"></div>
         <div class="worktree-agent"></div>
       </div>
       <div class="worktree-actions">
         <button class="btn-secondary assign-agent-btn">Assign Agent</button>
         <button class="btn-danger delete-worktree-btn">Delete</button>
       </div>
     </div>
   </template>
   ```

4. **Add CSS for worktrees tab**:
   ```css
   .worktrees-header {
       display: flex;
       justify-content: space-between;
       align-items: center;
       margin-bottom: 16px;
   }
   .worktrees-list {
       display: flex;
       flex-direction: column;
       gap: 8px;
   }
   .worktree-item {
       display: flex;
       justify-content: space-between;
       align-items: center;
       padding: 12px;
       background: var(--bg-secondary);
       border-radius: 6px;
   }
   .worktree-info {
       display: flex;
       flex-direction: column;
       gap: 4px;
   }
   .worktree-path {
       font-weight: 600;
   }
   .worktree-branch {
       color: var(--text-muted);
       font-size: 12px;
   }
   .worktree-agent {
       color: var(--accent-teal);
       font-size: 12px;
   }
   .worktree-actions {
       display: flex;
       gap: 8px;
   }
   ```

5. **Add JavaScript handlers**:
   ```javascript
   // Load worktrees on tab show
   document.querySelector('[data-tab="worktrees"]')?.addEventListener('click', () => {
       loadWorktrees();
   });

   // Create worktree button
   document.getElementById('create-worktree-btn')?.addEventListener('click', () => {
       postKanbanMessage({ type: 'createWorktree', workspaceRoot: currentWorkspaceRoot });
   });

   // Assign agent button (delegated)
   document.getElementById('worktrees-list')?.addEventListener('click', (e) => {
       if (e.target.classList.contains('assign-agent-btn')) {
           const worktreeId = e.target.closest('.worktree-item').dataset.worktreeId;
           postKanbanMessage({ type: 'assignAgentToWorktree', worktreeId, workspaceRoot: currentWorkspaceRoot });
       }
       if (e.target.classList.contains('delete-worktree-btn')) {
           const worktreeId = e.target.closest('.worktree-item').dataset.worktreeId;
           postKanbanMessage({ type: 'deleteWorktree', worktreeId, workspaceRoot: currentWorkspaceRoot });
       }
   });

   function loadWorktrees() {
       postKanbanMessage({ type: 'getWorktrees', workspaceRoot: currentWorkspaceRoot });
   }

   // Handle worktrees message (add to existing message handler switch)
   if (msg.type === 'worktrees') {
       renderWorktrees(msg.worktrees);
   }

   function renderWorktrees(worktrees) {
       const list = document.getElementById('worktrees-list');
       const template = document.getElementById('worktree-item-template');
       list.innerHTML = '';
       worktrees.forEach(wt => {
           const clone = template.content.cloneNode(true);
           clone.querySelector('.worktree-item').dataset.worktreeId = wt.id;
           clone.querySelector('.worktree-path').textContent = wt.path;
           clone.querySelector('.worktree-branch').textContent = `Branch: ${wt.branch}`;
           clone.querySelector('.worktree-agent').textContent = wt.coderAgentId ? `Agent: ${wt.coderAgentId}` : 'No agent assigned';
           list.appendChild(clone);
       });
   }
   ```

### File: `src/services/KanbanProvider.ts`

1. **Add worktree message handlers** (in the message switch block, after existing handlers):
   ```typescript
   case 'getWorktrees': {
       const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
       if (!workspaceRoot) break;
       const db = this._getKanbanDb(workspaceRoot);
       if (db && await db.ensureReady()) {
           const worktrees = await db.getWorktrees();
           this._panel?.webview.postMessage({ type: 'worktrees', worktrees });
       }
       break;
   }

   case 'createWorktree': {
       const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
       if (!workspaceRoot) break;
       const wtRelativePath = await vscode.window.showInputBox({ prompt: 'Worktree path (relative to workspace parent)' });
       if (!wtRelativePath) break;
       const branch = await vscode.window.showInputBox({ prompt: 'Branch name' });
       if (!branch) break;
       const db = this._getKanbanDb(workspaceRoot);
       if (db && await db.ensureReady()) {
           const id = await db.createWorktree(wtRelativePath, branch, null);
           const execAsync = promisify(cp.exec);
           const parentDir = path.dirname(workspaceRoot);
           const fullPath = path.join(parentDir, wtRelativePath);
           try {
               await execAsync(`git worktree add -b "${branch}" "${fullPath}"`, { cwd: workspaceRoot });
               vscode.window.showInformationMessage(`Worktree created at ${fullPath}`);
           } catch (e: any) {
               vscode.window.showErrorMessage(`Failed to create worktree: ${e.message}`);
               await db.deleteWorktree(id);
           }
       }
       break;
   }

   case 'deleteWorktree': {
       const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
       if (!workspaceRoot) break;
       const db = this._getKanbanDb(workspaceRoot);
       if (db && await db.ensureReady()) {
           const wt = await db.getWorktreeById(Number(msg.worktreeId));
           if (wt) {
               const workspaceId = await db.getWorkspaceId();
               const allCards = workspaceId ? await db.getBoard(workspaceId) : [];
               const assignedCards = allCards.filter(c => c.worktreeId === wt.id);
               if (assignedCards.length > 0) {
                   const confirm = await vscode.window.showWarningMessage(
                       `${assignedCards.length} plan(s) are assigned to this worktree. Delete anyway?`,
                       'Delete', 'Cancel'
                   );
                   if (confirm !== 'Delete') break;
               }
               const execAsync = promisify(cp.exec);
               try {
                   await execAsync(`git worktree remove --force "${wt.path}"`, { cwd: workspaceRoot });
                   await execAsync(`git branch -D "${wt.branch}"`, { cwd: workspaceRoot });
               } catch (e: any) {
                   console.warn(`Failed to remove worktree: ${e.message}`);
               }
               await db.deleteWorktree(Number(msg.worktreeId));
           }
       }
       break;
   }

   case 'assignAgentToWorktree': {
       const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
       if (!workspaceRoot) break;
       const visibleAgents = await this._getVisibleAgents(workspaceRoot);
       const agentNames = Object.entries(visibleAgents)
           .filter(([_, enabled]) => enabled)
           .map(([name]) => name);
       if (agentNames.length === 0) {
           vscode.window.showWarningMessage('No agents configured. Set up agents in Setup first.');
           break;
       }
       const selected = await vscode.window.showQuickPick(agentNames, { placeHolder: 'Select coder agent' });
       if (!selected) break;
       const db = this._getKanbanDb(workspaceRoot);
       if (db && await db.ensureReady()) {
           await db.assignAgentToWorktree(Number(msg.worktreeId), selected);
       }
       break;
   }
   ```

   Uses top-level `import { promisify } from 'util'` and `import * as cp from 'child_process'` (already imported in KanbanProvider.ts). Agent list comes from `_getVisibleAgents()` instead of hardcoded values.

## Verification Plan

### Automated Tests
- TypeScript compilation must pass
- Existing unit tests must pass

### Manual Verification
- Open kanban board, click Worktrees tab — tab renders with "Create Worktree" button
- Click "Create Worktree" — input dialogs appear for path and branch
- Create a worktree — verify it appears in the list with path and branch
- Click "Assign Agent" — quick pick shows configured agents
- Click "Delete" — worktree removed from list and git worktree removed from disk
- Delete a worktree with assigned cards — warning prompt appears

## Recommendation

**Complexity: 3 → Send to Coder**

Straightforward UI + message handler addition following existing patterns. The only non-trivial part is the git worktree creation with rollback on failure, which is a simple try/catch pattern.

---

## Review Pass Results (2026-05-28)

### Stage 1: Grumpy Principal Engineer Findings

| ID | Severity | Finding |
|----|----------|---------|
| CRITICAL-1 | CRITICAL | Shell injection via `cp.exec` with string interpolation in all worktree git commands. Branch names and paths interpolated into shell strings — `$(malicious)` would execute. Codebase already has F-03 SECURITY pattern using `cp.execFile` with args arrays (see TaskViewerProvider.ts:16273, ArchiveManager.ts:175). |
| MAJOR-1 | MAJOR | Missing path validation — plan's Edge-Case audit explicitly requires "validate paths are within workspace parent directory" but no validation existed. `../../etc/shadow` would be accepted. |
| MAJOR-2 | MAJOR | No branch name validation — any string accepted from `showInputBox`, including invalid git branch names with shell metacharacters. DB entry created before git validation. |
| NIT-1 | NIT | No empty state message in `renderWorktrees` — blank list when no worktrees exist. |
| NIT-2 | NIT | `execAsync = promisify(cp.exec)` declared redundantly in three locations (resolved by CRITICAL-1 fix). |

### Stage 2: Balanced Synthesis

All findings fixed — no deferrals.

| Finding | Action |
|---------|--------|
| CRITICAL-1 | **Fixed**: Replaced all `cp.exec` with `cp.execFile('git', argsArray)` following F-03 pattern |
| MAJOR-1 | **Fixed**: Added path validation — rejects absolute paths and paths containing `..` |
| MAJOR-2 | **Fixed**: Added branch name regex validation before DB insertion |
| NIT-1 | **Fixed**: Added empty state message in `renderWorktrees` |
| NIT-2 | **Fixed**: Resolved by CRITICAL-1 fix (no more `promisify(cp.exec)`) |

### Files Changed

| File | Change |
|------|--------|
| `src/services/KanbanProvider.ts` | Lines 6126-6161 (createWorktree): Added path validation, branch name validation, replaced `cp.exec` with `cp.execFile`. Lines 6162-6195 (deleteWorktree): Replaced `cp.exec` with `cp.execFile`. Lines 6531-6546 (_cleanupWorktreeAfterReview): Replaced `cp.exec` with `cp.execFile`. |
| `src/webview/kanban.html` | Lines 7090-7107 (renderWorktrees): Added empty state message when worktrees list is empty. |

### Validation

- **TypeScript compilation**: Skipped per session instructions (SKIP COMPILATION).
- **Automated tests**: Skipped per session instructions (SKIP TESTS).
- **Security regression check**: Verified zero remaining `promisify(cp.exec)` usages in KanbanProvider.ts.
- **Pattern consistency**: All worktree git commands now use `cp.execFile` with args arrays, matching the established F-03 SECURITY pattern in TaskViewerProvider.ts and ArchiveManager.ts.

### Remaining Risks

- **Branch name regex is permissive**: The regex `/^[A-Za-z0-9][A-Za-z0-9._\/-]*$/` allows some technically invalid git branch names (e.g., sequences with `//`). Git itself will reject these at execution time with a clear error message, and the DB entry will be rolled back. A stricter validation matching git's exact rules could be added later if confusing errors are reported.
- **`deleteWorktree` deletes DB entry even if git removal fails**: This is by design (best-effort cleanup), but could leave orphaned worktree directories on disk if git removal fails. The `--force` flag handles most cases.
