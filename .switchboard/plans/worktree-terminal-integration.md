# Worktree Terminal Integration

## Goal

Implement automatic worktree creation tied to plan assignment — when worktree mode is enabled, bulk-moving plans to agents automatically creates a worktree + terminal per plan, assigns the work, and routes completed plans to a merge column for cleanup. The Worktrees tab provides visibility, rules configuration, and manual cleanup.

## Metadata

- **Tags:** [workflow, UI, devops]
- **Complexity:** 6
- **Depends on:** `redesign-worktrees-tab-to-match-automation-pattern.md` (complete)

## User Decisions (Resolved)

- **Worktree granularity**: One worktree per plan, named after the plan. Worktrees are one-and-done — never reused for different plans.
- **Creation trigger**: Worktree mode must be enabled in Worktrees tab first (global toggle). When enabled, bulk move on Kanban auto-creates worktrees + terminals.
- **Merge flow**: When worktree mode is enabled, a dedicated "Merge" column appears after the Reviewer column. Plans are dragged here to trigger merge cleanup.
- **Merge strategy**: The Merge column assigns a merge rule (e.g., "squash", "merge", "rebase") — not an agent. Optional copy prompt can be sent to an agent for merge review.
- **Worktree rules**: Configured in Worktrees tab — max worktree cap, default merge strategy, whether merge is automatic or manual.

## User Review Required

- **Merge column placement**: Confirm that the Merge column should appear between "CODE REVIEWED" and "COMPLETED" (plans without worktrees skip it and go directly to COMPLETED).
- **Merge conflict handling**: Confirm preference — abort merge and leave worktree in conflicted state for manual resolution, or attempt automatic resolution with a warning?
- **Terminal startup command in worktree**: Confirm that the existing startup command (e.g., `claude`) should run in the worktree's `cwd` without modification.

## Complexity Audit

### Routine
- Adding `cwd` parameter to `_createAutobanTerminal` (line 5535) and its public wrapper `addAutobanTerminalFromKanban` (line 5801)
- Updating `extension.ts` command registration (line 1090) to pass `cwd` through
- Adding worktree mode toggle to Worktrees tab (persisted in `kanban_meta` table — `getMeta`/`setMeta` already exist at lines 1370/1384 of `KanbanDatabase.ts`)
- Adding worktree rules configuration UI (max cap, default merge strategy, auto-merge toggle)
- Adding `killTerminal` method to `TaskViewerProvider` for cleanup on merge
- The existing `_createAutobanTerminal` already handles: terminal creation, pool registration, startup command, PID capture, state persistence, refresh
- The existing `KanbanDatabase` already has: `createWorktree`, `getWorktrees`, `deleteWorktree`, `updatePlanWorktree`, `getWorktreeById`, `assignAgentToWorktree`
- The existing `KanbanProvider` already has: `_assignWorktreeToCard` (line 6510), `_cleanupWorktreeAfterReview` (line 6604), `_resolveWorktreePaths` (line 6480), `_appendWorktreeContextToPlan` (line 6566)
- The existing `kanban.html` already has: Worktrees tab with CREATE/POOLS/DELETE UI (line 7019+)

### Complex / Risky
- **Merge flow logic**: Must run `git merge --squash <branch>` from the **main** worktree (not from inside the worktree — that would fail). Requires careful cwd management.
- **Partial failure on bulk move**: If worktree creation fails for 1 of 5 plans (pool cap hit, git error), do we fail the whole bulk move or proceed with the other 4? Recommendation: proceed with others, show warning for failed ones.
- **Terminal pool cap**: Worktree terminals share the 5-per-role cap (`MAX_AUTOBAN_TERMINALS_PER_ROLE` in `autobanState.ts` line 15) with regular autoban terminals. If cap is hit, worktree terminal creation fails. Need clear error messaging and graceful degradation.
- **Merge conflicts**: Git merge may fail with conflicts. The merge rule execution needs to detect conflicts and either: (a) abort and notify user, or (b) leave worktree in conflicted state for manual resolution.
- **Terminal lifecycle on merge**: When worktree is deleted after merge, the associated terminal must be killed to avoid orphaned processes in deleted directories. The terminal name matching needs `_stripIdeSuffix` for reliable lookup.

## Edge-Case & Dependency Audit

- **Race Conditions**: Bulk move processes plans sequentially (existing pattern in `moveSelected` handler, line 4817+). No parallel terminal creation — safe. However, if two bulk moves happen simultaneously (two Kanban panels), worktree names could collide. Mitigation: timestamp-based naming already used in `createWorktree` handler (line 6154).
- **Security**: All git commands use `cp.execFile` with args arrays (existing pattern, e.g., line 6172). Merge execution must follow the same pattern — never shell-interpolate branch names.
- **Side Effects**: Adding `cwd` to `_createAutobanTerminal` changes the default behavior for all callers. The parameter must default to `undefined` so existing callers (which don't pass `cwd`) continue to use `workspaceRoot` (line 5575).
- **Dependencies & Conflicts**: The `redesign-worktrees-tab` plan is complete and already provides the Worktrees tab infrastructure. This plan builds on top of it. The `kanban_meta` table (V14 migration, line 211) is already available for storing worktree mode toggle and rules.
- **Partial failure on bulk move**: If worktree creation fails for some plans (pool cap hit, git error), the bulk move should proceed with successful plans and show warnings for failed ones. Failed plans can be manually retried or assigned without worktrees.
- **Terminal pool cap**: Worktree terminals share the 5-per-role cap. If cap is hit, worktree terminal creation fails with clear error: "Terminal pool cap (5) reached. Close existing terminals or reduce plan count." The worktree itself is still created — only the terminal fails.
- **Merge conflicts**: Git merge may fail with conflicts. The merge rule execution detects conflicts and leaves the worktree in conflicted state for manual resolution. User is notified via warning message.
- **Worktree name collisions**: If two plans have the same name, worktree names will collide. Add a unique suffix (e.g., `-1`, `-2`) to handle collisions. Existing `createWorktree` handler already uses timestamp-based naming.
- **Orphaned worktrees**: If VS Code crashes or the extension is deactivated while worktrees exist, they may become orphaned. The Worktrees tab already shows all worktrees from DB on startup, allowing manual cleanup.
- **Terminal orphaned on crash**: If a terminal is not properly killed on worktree deletion, it may end up in a deleted directory. The cleanup method should always attempt to kill the terminal before removing the worktree.
- **Dependencies**: Requires `_taskViewerProvider` reference in KanbanProvider (already exists at line 138, set at line 149-152). Requires `kanban_meta` table for persisting worktree mode toggle and worktree rules (already exists).

## Dependencies

- `redesign-worktrees-tab-to-match-automation-pattern.md` — Worktrees tab UI and backend infrastructure (COMPLETE)

## Adversarial Synthesis

Key risks: (1) Merge flow logic was architecturally wrong in the original plan — running `git merge` inside the worktree would fail; corrected to run from the main worktree. (2) Data model used `worktreePath` instead of the existing `worktreeId` FK — corrected to use the existing schema. (3) Partial terminal creation during bulk move degrades gracefully — worktrees are still created, only terminals may fail. Mitigations: merge runs from main worktree with correct cwd; data model uses existing `worktreeId` + `_resolveWorktreePaths`; individual terminal creation failures are caught and reported per-plan.

## Proposed Changes

### File: `src/services/TaskViewerProvider.ts`

1. **Add `cwd` parameter to `_createAutobanTerminal`** (line 5535):
   - **Context**: Currently hardcodes `cwd: workspaceRoot` at line 5575. Need to allow worktree path override.
   - **Logic**: Add optional `cwd?: string` parameter. Use `cwd || workspaceRoot` at line 5575.
   - **Implementation**:
     ```typescript
     private async _createAutobanTerminal(role: string, requestedName?: string, cwd?: string): Promise<void> {
         // ... existing validation unchanged ...
         const terminal = vscode.window.createTerminal({
             name: uniqueName,
             location: vscode.TerminalLocation.Panel,
             cwd: cwd || workspaceRoot  // <-- use worktree path if provided
         });
         // ... rest unchanged ...
     }
     ```
   - **Edge Cases**: `cwd` defaults to `undefined`, so existing callers that don't pass it continue to use `workspaceRoot`. No behavior change for non-worktree terminals.

2. **Add `cwd` parameter to `addAutobanTerminalFromKanban`** (line 5801):
   - **Context**: Public wrapper called by KanbanProvider. Must pass `cwd` through.
   - **Implementation**:
     ```typescript
     public async addAutobanTerminalFromKanban(role: string, requestedName?: string, cwd?: string): Promise<void> {
         await this._createAutobanTerminal(role, requestedName, cwd);
     }
     ```

3. **Add `killTerminal` method** (new, after `removeAutobanTerminalFromKanban` ~line 5808):
   - **Context**: Needed to clean up terminals when worktrees are merged/deleted. No existing method kills a terminal by name.
   - **Logic**: Find terminal by name (using `_stripIdeSuffix` for matching), dispose it, remove from `_lastTerminals` and pool state, persist.
   - **Implementation**:
     ```typescript
     public async killTerminal(terminalName: string): Promise<void> {
         // Match using _stripIdeSuffix to handle IDE-suffixed names
         const terminal = this._lastTerminals.find(t =>
             this._stripIdeSuffix(t.name) === this._stripIdeSuffix(terminalName)
         );
         if (terminal) {
             terminal.dispose();
             this._lastTerminals = this._lastTerminals.filter(t =>
                 this._stripIdeSuffix(t.name) !== this._stripIdeSuffix(terminalName)
             );
             await this._persistTerminalState();
         }
     }
     ```
   - **Edge Cases**: Terminal may already be disposed (user closed it). `find` returns `undefined` — method is a no-op. Name matching uses `_stripIdeSuffix` to handle names like "Coder #1_VS Code".

### File: `src/extension.ts`

4. **Update `addAutobanTerminalFromKanban` command registration** (line 1090):
   - **Context**: Command handler currently ignores `cwd`. Must pass it through for worktree terminals.
   - **Implementation**:
     ```typescript
     const addAutobanTerminalDisposable = vscode.commands.registerCommand('switchboard.addAutobanTerminalFromKanban', async (role: string, requestedName?: string, cwd?: string) => {
         await taskViewerProvider.addAutobanTerminalFromKanban(role, requestedName, cwd);
     });
     ```

### File: `src/services/KanbanProvider.ts`

5. **Add worktree mode check and auto-creation to `moveCardToColumn`** (line 3717):
   - **Context**: When a card is moved to a coder column (`LEAD CODED`, `CODER CODED`, `INTERN CODED`), `_assignWorktreeToCard` already assigns an **existing** worktree. The new logic creates a worktree + terminal **if worktree mode is enabled and no worktree exists**.
   - **Logic**: After the existing `_assignWorktreeToCard` call (line 3732), check if worktree mode is enabled. If so, and the plan has no `worktreeId`, create a new worktree + terminal for it.
   - **Implementation** (insert after line 3733):
     ```typescript
     // Auto-create worktree + terminal if worktree mode is enabled and plan has no worktree
     const worktreeModeEnabled = await this._isWorktreeModeEnabled(workspaceRoot);
     if (worktreeModeEnabled) {
         const updatedPlan = await db.getPlanBySessionId(sessionId);
         if (updatedPlan && !updatedPlan.worktreeId) {
             try {
                 const worktreeName = this._sanitizePlanName(updatedPlan.topic || updatedPlan.sessionId);
                 const worktreeResult = await this._createWorktreeForPlan(workspaceRoot, worktreeName, targetColumn);
                 if (worktreeResult) {
                     // Assign worktree to plan
                     await db.updatePlanWorktree(sessionId, worktreeResult.id);
                     // Spawn terminal inside worktree
                     const branchToPath = await this._resolveWorktreePaths(workspaceRoot);
                     const worktreePath = branchToPath.get(worktreeResult.branch);
                     if (worktreePath) {
                         try {
                             await this._taskViewerProvider?.addAutobanTerminalFromKanban(
                                 this._columnToRole(targetColumn) || 'coder',
                                 undefined,
                                 worktreePath
                             );
                         } catch (termErr: any) {
                             console.warn(`[KanbanProvider] Terminal creation failed for worktree ${worktreeResult.branch}: ${termErr.message}`);
                             vscode.window.showWarningMessage(`Worktree created but terminal failed: ${termErr.message}`);
                         }
                     }
                 }
             } catch (err: any) {
                 console.warn(`[KanbanProvider] Failed to auto-create worktree for plan ${sessionId}: ${err.message}`);
                 // Continue — plan moves to column without worktree
             }
         }
     }
     ```
   - **Edge Cases**: Partial failure — worktree created but terminal fails (pool cap). Plan still moves to column; warning shown. Worktree tab shows the worktree for manual terminal creation.

6. **Add `_isWorktreeModeEnabled` method** (new, near `_assignWorktreeToCard` ~line 6510):
   - **Context**: Reads worktree mode toggle from `kanban_meta` table.
   - **Implementation**:
     ```typescript
     private async _isWorktreeModeEnabled(workspaceRoot: string): Promise<boolean> {
         const db = this._getKanbanDb(workspaceRoot);
         if (!db || !await db.ensureReady()) return false;
         const value = await db.getMeta('worktree_mode_enabled');
         return value === 'true';
     }
     ```

7. **Add `_createWorktreeForPlan` method** (new, near `_assignWorktreeToCard` ~line 6510):
   - **Context**: Creates a single worktree for a plan. Reuses the pattern from the existing `createWorktree` message handler (line 6136-6201) but for a single plan.
   - **Implementation**:
     ```typescript
     private async _createWorktreeForPlan(
         workspaceRoot: string,
         planName: string,
         targetColumn?: string
     ): Promise<{ id: number; branch: string } | null> {
         const db = this._getKanbanDb(workspaceRoot);
         if (!db || !await db.ensureReady()) return null;

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

         const parentDir = path.dirname(workspaceRoot);
         const timestamp = Date.now();
         const sanitized = planName.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 40);
         const branchName = `${sanitized}-${timestamp}`;
         const worktreeDirName = `switchboard-${sanitized}-${timestamp}`;
         const fullPath = path.join(parentDir, worktreeDirName);

         // Create DB entry
         const id = await db.createWorktree(branchName, targetRole);
         if (id === -1) return null;

         // Create git worktree (SECURITY: execFile with args array)
         const execFileAsync = promisify(cp.execFile);
         try {
             await execFileAsync('git', ['worktree', 'add', '-b', branchName, fullPath], { cwd: workspaceRoot });
         } catch (gitError: any) {
             // Rollback DB entry if git fails
             await db.deleteWorktree(id);
             console.warn(`[KanbanProvider] Git worktree creation failed: ${gitError.message}`);
             return null;
         }

         return { id, branch: branchName };
     }
     ```

8. **Add `_sanitizePlanName` helper** (new):
   - **Context**: Sanitizes plan names for use as git branch/worktree names.
   - **Implementation**:
     ```typescript
     private _sanitizePlanName(name: string): string {
         return name.replace(/[^a-zA-Z0-9_-]/g, '-').replace(/-+/g, '-').slice(0, 40);
     }
     ```

9. **Add Merge column to Kanban** (conditional on worktree mode):
   - **Context**: The `_buildKanbanColumns` method defines the column layout. When worktree mode is enabled, a "MERGE" column should appear between "CODE REVIEWED" and "COMPLETED".
   - **Logic**: Modify `_buildKanbanColumns` to conditionally include a Merge column. The column has no `role` — it's a workflow step, not an agent assignment.
   - **Implementation**: Add to column definitions when `_isWorktreeModeEnabled` returns true. Include merge rule dropdown (squash/merge/rebase) in the column header.
   - **Edge Cases**: Plans without worktrees should skip the Merge column and go directly to COMPLETED. The forward-move logic should check if the plan has a `worktreeId` before routing through Merge.

10. **Implement merge rule execution** (new method `_executeMergeRule`):
    - **Context**: When a plan is moved to the MERGE column, execute the configured merge strategy. **CRITICAL**: The merge must run from the **main worktree** (workspaceRoot), merging the worktree's branch INTO the current branch. Do NOT run from inside the worktree.
    - **Implementation**:
      ```typescript
      private async _executeMergeRule(workspaceRoot: string, sessionId: string, rule: string): Promise<void> {
          const db = this._getKanbanDb(workspaceRoot);
          if (!db || !await db.ensureReady()) return;

          const plan = await db.getPlanBySessionId(sessionId);
          if (!plan || !plan.worktreeId) {
              throw new Error('Plan has no associated worktree');
          }

          const worktree = await db.getWorktreeById(plan.worktreeId);
          if (!worktree) {
              throw new Error('Worktree record not found');
          }

          // Execute git command from MAIN worktree (workspaceRoot), NOT from the worktree itself
          const execFileAsync = promisify(cp.execFile);
          const gitArgs = rule === 'squash' ? ['merge', '--squash', worktree.branch]
                        : rule === 'rebase' ? ['rebase', worktree.branch]
                        : ['merge', worktree.branch];

          try {
              await execFileAsync('git', gitArgs, { cwd: workspaceRoot });

              // If squash, need a separate commit step
              if (rule === 'squash') {
                  await execFileAsync('git', ['commit', '--no-edit'], { cwd: workspaceRoot });
              }

              // Cleanup: kill terminal, remove worktree, delete branch
              await this._cleanupWorktreeAfterMerge(workspaceRoot, plan, worktree);
          } catch (err: any) {
              if (err.message?.includes('conflict') || err.stderr?.includes('CONFLICT')) {
                  vscode.window.showWarningMessage(
                      `Merge conflict for plan "${plan.topic}". Manual resolution required in the main branch.`
                  );
                  // Abort the merge to leave main branch clean
                  try {
                      if (rule === 'rebase') {
                          await execFileAsync('git', ['rebase', '--abort'], { cwd: workspaceRoot });
                      } else {
                          await execFileAsync('git', ['merge', '--abort'], { cwd: workspaceRoot });
                      }
                  } catch { /* ignore abort failure */ }
                  // Leave worktree in place for manual resolution
              } else {
                  throw err;
              }
          }
      }
      ```
    - **Edge Cases**: Merge conflicts abort the merge on the main branch and leave the worktree intact. Squash requires a two-step process (merge --squash + commit). Rebase conflicts need `--abort`.

11. **Add `_cleanupWorktreeAfterMerge` method** (new):
    - **Context**: After successful merge, kill the terminal, remove the git worktree, delete the branch, and update DB. Reuses existing patterns from `_cleanupWorktreeAfterReview` (line 6604).
    - **Implementation**:
      ```typescript
      private async _cleanupWorktreeAfterMerge(
          workspaceRoot: string,
          plan: any,
          worktree: { id: number; branch: string; coderAgentId: string | null }
      ): Promise<void> {
          const execFileAsync = promisify(cp.execFile);

          // Kill terminal associated with this worktree
          const branchToPath = await this._resolveWorktreePaths(workspaceRoot);
          const worktreePath = branchToPath.get(worktree.branch);
          if (worktreePath) {
              // Find terminal whose cwd matches this worktree path
              const terminalName = this._findTerminalForWorktree(worktreePath);
              if (terminalName) {
                  await this._taskViewerProvider?.killTerminal(terminalName);
              }
          }

          // Remove git worktree and branch
          try {
              if (worktreePath) {
                  await execFileAsync('git', ['worktree', 'remove', '--force', worktreePath], { cwd: workspaceRoot });
              }
              await execFileAsync('git', ['branch', '-D', worktree.branch], { cwd: workspaceRoot });
          } catch (e: any) {
              console.warn(`Failed to remove worktree after merge: ${e.message}`);
          }

          // Update DB
          const db = this._getKanbanDb(workspaceRoot);
          if (db) {
              await db.deleteWorktree(worktree.id);
              await db.updatePlanWorktree(plan.sessionId, null);
          }
      }
      ```

12. **Add `_findTerminalForWorktree` helper** (new):
    - **Context**: Finds the terminal name associated with a worktree path. Needed because terminals are identified by name, not by cwd.
    - **Implementation**: Add a `worktreePath` field to the terminal state record when creating worktree terminals (in step 1), then look up by that field. Alternatively, search terminal state records for matching `cwd`.
    - **Clarification**: The terminal state record (line 5612-5624) should be extended with an optional `worktreePath` field so terminals can be matched to worktrees for cleanup.

### File: `src/webview/kanban.html`

13. **Add worktree mode toggle to Worktrees tab** (inside `createWorktreePanel`, line 7019):
    - **Context**: The Worktrees tab already has CREATE and POOLS sections. Add a toggle at the top.
    - **Implementation**: Add toggle switch: "Enable worktree mode" — sends `setWorktreeMode` message to backend. When enabled, show Merge column in Kanban.
    - **Persistence**: Uses `kanban_meta` key `worktree_mode_enabled`.

14. **Add worktree rules configuration** (below toggle in Worktrees tab):
    - **Context**: Rules control worktree creation and merge behavior.
    - **Implementation**:
      - Max worktree cap input (default: 10) — stored as `kanban_meta` key `worktree_max_cap`
      - Default merge strategy dropdown (squash/merge/rebase) — stored as `kanban_meta` key `worktree_default_merge_strategy`
      - Auto-merge on completion toggle (default: false) — stored as `kanban_meta` key `worktree_auto_merge`

15. **Show worktree status in Worktrees tab** (enhance existing POOLS section):
    - **Context**: The existing POOLS section (line 7079+) shows worktrees by role. Enhance with merge status.
    - **Implementation**:
      - Add merge status badge per worktree: "pending" / "merged" / "conflicted"
      - Add "WORKTREE" badge for terminals in the pool UI (requires passing `worktreePath` in terminal state)
      - Manual DELETE button already exists (line 7144+)

16. **Add Merge column rendering in Kanban board**:
    - **Context**: When worktree mode is enabled, the Kanban board shows a MERGE column.
    - **Implementation**: Add column between CODE REVIEWED and COMPLETED. Include merge rule dropdown (squash/merge/rebase) in column header. Cards in this column show the plan's worktree branch name and merge status.

### File: `src/services/KanbanDatabase.ts`

17. **No schema changes required** — the `worktrees` table and `plans.worktree_id` column already exist. The `kanban_meta` table already supports arbitrary key-value storage for worktree mode toggle and rules.

### File: `src/services/autobanState.ts`

18. **No changes required** — `MAX_AUTOBAN_TERMINALS_PER_ROLE` (line 15, value 5) is the existing cap. Worktree terminals share this cap. No new constant needed.

## Verification Plan

### Manual Verification
- Open kanban board, Worktrees tab
- Enable "Enable worktree mode" toggle
- Verify: Merge column appears in Kanban between CODE REVIEWED and COMPLETED
- Select 3 plans, bulk move to "Coder" agents
- Verify: 3 git worktrees created, each named after its plan (sanitized)
- Verify: 3 VS Code terminals spawned, each with `cwd` set to its worktree path
- Verify: Terminals appear in automation tab's Terminal Pools with "WORKTREE" badge
- Verify: Startup command (e.g., `claude`) runs in each terminal
- Verify: Plans have `worktreeId` set in DB (check via `query_switchboard_kanban` skill)
- Verify: Worktrees tab shows all 3 worktrees with "pending" merge status
- After plan completion, drag plan to Merge column
- Verify: Merge rule dropdown appears (squash/merge/rebase)
- Select "squash" and execute
- Verify: Git merge --squash executes from **main worktree** (not from inside the worktree)
- Verify: Squash commit is created on main branch
- Verify: Worktree is deleted after successful merge
- Verify: Associated terminal is killed
- Verify: Worktree row in tab shows "merged" status
- Verify: Pool cap — if 4 coder terminals already exist, bulk move with 3 plans should create worktrees for all 3 but only 1 terminal; others get warnings
- Verify: Merge conflict — simulate conflict, verify warning appears, merge is aborted on main branch, worktree is left intact
- Verify: Manual DELETE in Worktrees tab removes worktree and kills terminal
- Verify: Existing automation tab "ADD TERMINAL" still works (cwd defaults to workspaceRoot)
- Verify: Worktree rules (max cap, default merge strategy) persist across sessions (stored in kanban_meta)
- Verify: Plans without worktrees skip the Merge column and go directly to COMPLETED
- Verify: Existing `_cleanupWorktreeAfterReview` on COMPLETED still works as safety net

### Automated Tests
- (Skipped per session directive — test suite will be run separately by the user)

## Recommendation

**Complexity: 6 → Send to Coder**

The majority of the infrastructure (DB schema, worktree CRUD, tab UI, card-to-worktree assignment) already exists. The new work is focused on: (1) adding `cwd` parameter threading through terminal creation, (2) worktree mode toggle + auto-creation on card move, (3) Merge column + merge rule execution, and (4) terminal cleanup on merge. The merge flow is the riskiest part due to git command correctness and conflict handling, but it follows existing patterns. A Coder-level agent can handle this with the corrected merge logic.
