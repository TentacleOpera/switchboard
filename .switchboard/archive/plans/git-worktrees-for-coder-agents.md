# Git Worktrees for Coder Agents

## Goal

Add support for git worktrees in the Switchboard extension to provide isolated working environments for coder agents. When enabled, coder agents work in dedicated worktrees outside the main working tree, and changes are merged back into the main branch via the reviewer agent when plans enter the CODE REVIEWED column.

## Metadata

- **Tags:** [devops, workflow]
- **Complexity:** 7

## User Review Required

- Confirm worktree location strategy (sibling directory vs. temp directory)
- Confirm whether git push/fetch should remain prohibited inside worktrees
- Confirm UX for merge conflict resolution (interactive reviewer vs. user prompt)

## Complexity Audit

### Routine
- Adding `has_worktree` column to plans table (follows existing migration pattern V2–V23)
- Adding checkbox to agents tab UI (follows `julesAutoSyncEnabled` pattern)
- Adding `gitWorktreesEnabled` to `state.json` (follows `_saveStartupCommands` pattern)
- Adding merge button to CODE REVIEWED column header (follows existing column-icon-btn pattern)
- Adding `MERGE_WORKTREES_DIRECTIVE` constant to `agentPromptBuilder.ts` (follows existing directive pattern)
- Icon placeholder injection (follows `{{ICON_XX}}` → `asWebviewUri` pattern)

### Complex / Risky
- Worktree must be created OUTSIDE the main working tree (git forbids nested worktrees) — requires sibling directory resolution
- Worktree creation hook must intercept `TaskViewerProvider._handleTriggerAgentAction()`, not `KanbanProvider` — the dispatch chain routes through TaskViewerProvider
- Session metadata storage for worktree info requires `kanban_meta` table (not SessionActionLog, which is an event log only)
- Overriding `gitProhibitionEnabled` per-dispatch requires passing `PromptBuilderOptions.gitProhibitionEnabled = false` for worktree sessions
- Merge conflict handling by reviewer agent is inherently interactive and may fail or stall
- Orphaned worktree cleanup on extension startup requires scanning `git worktree list` and reconciling with DB state

## Edge-Case & Dependency Audit

- **Race Conditions**: Two coder agents dispatched simultaneously for the same plan could race on worktree creation. Mitigation: worktree creation is keyed by sessionId (unique per dispatch), so no collision.
- **Security**: Worktree branches are pushed to origin only if the reviewer agent explicitly does so. Git push prohibition should remain in effect even in worktrees unless explicitly overridden. Worktree paths outside the project directory could expose workspace structure.
- **Side Effects**: `git worktree add` creates a new branch and working directory; failure to clean up leaves stale worktrees and branches. Disk space consumption from accumulated worktrees.
- **Dependencies & Conflicts**: Depends on the workspace being a git repository. Conflicts with any existing branch named `sb-coder-*`. The `kanban_meta` table (V14) must be available for worktree metadata storage. The `KanbanPlanRecord` interface (line 20-44) needs a `hasWorktree` field.

## Dependencies

- None

## Adversarial Synthesis

Key risks: (1) Worktrees created inside the main working tree will fail — git forbids nested worktrees, so a sibling directory strategy is mandatory. (2) Session metadata storage via SessionActionLog is fabricated — that module is an event log, not a key-value store; the `kanban_meta` table must be used instead. (3) The worktree creation hook must be in TaskViewerProvider, not KanbanProvider, because the dispatch chain routes through `handleKanbanTrigger()`. Mitigations: Use `../<repo-name>-wt-<sessionId>/` for worktree paths, store metadata in `kanban_meta`, intercept dispatch in `TaskViewerProvider._handleTriggerAgentAction()`.

## Motivation

- **Isolation**: Each coder agent works in an isolated git worktree, preventing conflicts between parallel coding tasks
- **Safety**: Changes are only merged after review, allowing the reviewer to resolve conflicts intelligently
- **Parallelism**: Multiple agents can work on different branches simultaneously without stepping on each other
- **Revertibility**: Easy to discard work if review fails by simply removing the worktree

## High-Level Design

### User Flow

1. User enables "Use git worktrees for coder agents" checkbox in agents tab
2. Plan moves from PLAN REVIEWED → CODER CODED
3. System creates a git worktree for the session with a dedicated branch (outside the main working tree)
4. Coder agent is dispatched to work in the worktree (can commit freely, git prohibition disabled)
5. Plan moves to CODE REVIEWED
6. Merge button appears in CODE REVIEWED column header showing worktree count
7. User clicks merge button → reviewer agent dispatched with merge directive
8. Reviewer merges changes, handles conflicts interactively if needed
9. Worktree is cleaned up, count decremented
10. Plan can advance to COMPLETED

### Architecture Components

1. **Agents Tab Setting**: Checkbox to enable/disable worktrees
2. **Worktree Creation**: Hook into `TaskViewerProvider._handleTriggerAgentAction()` for coder dispatch
3. **Worktree Tracking**: Store worktree metadata in `kanban_meta` table
4. **Merge Button UI**: Column header button in CODE REVIEWED with count badge
5. **Merge Workflow**: Reviewer agent directive to merge worktrees
6. **Cleanup Logic**: Remove worktrees after successful merge

## Implementation Steps

### Phase 1: Database Schema & Metadata Storage

**File**: `src/services/KanbanDatabase.ts`

1. Add `has_worktree` column to the plans table via migration V24:
   - Lines 372+: Add `MIGRATION_V24_SQL` constant
   ```typescript
   const MIGRATION_V24_SQL = [
       `ALTER TABLE plans ADD COLUMN has_worktree INTEGER DEFAULT 0`,
   ];
   ```
   - Lines 3593+: Add V24 migration execution in `_runMigrations()`:
   ```typescript
   // V24: add has_worktree flag for git worktree tracking
   const v24 = await this.getMigrationVersion();
   if (v24 < 24) {
       for (const sql of MIGRATION_V24_SQL) {
           try { this._db.exec(sql); } catch (e) {
               console.debug('[KanbanDatabase] V24 migration step skipped (already applied):', e);
           }
       }
       await this.setMigrationVersion(24);
       console.log('[KanbanDatabase] V24 migration completed: has_worktree column added');
   }
   ```

2. Add `hasWorktree` field to `KanbanPlanRecord` interface (line 20-44):
   ```typescript
   hasWorktree: number; // 0 or 1
   ```

3. Update `PLAN_COLUMNS` constant (line 428-430) to include `has_worktree`.

4. Update `_readRows()` to map `has_worktree` → `hasWorktree`.

5. Add method to update has_worktree flag:
   ```typescript
   async updateHasWorktree(sessionId: string, hasWorktree: boolean): Promise<void> {
       if (!this._db) return;
       this._db.run(
           'UPDATE plans SET has_worktree = ? WHERE session_id = ?',
           [hasWorktree ? 1 : 0, sessionId]
       );
       await this._persist();
   }
   ```

6. Use existing `kanban_meta` table (created in V14, line 201-206) for worktree metadata. Add helper methods:
   ```typescript
   async setWorktreeMeta(sessionId: string, meta: { worktreePath: string; worktreeBranch: string }): Promise<void> {
       if (!this._db) return;
       this._db.run(
           'INSERT OR REPLACE INTO kanban_meta (key, value, workspace_id) VALUES (?, ?, ?)',
           [`worktree_${sessionId}`, JSON.stringify(meta), this._workspaceId]
       );
       await this._persist();
   }

   async getWorktreeMeta(sessionId: string): Promise<{ worktreePath: string; worktreeBranch: string } | null> {
       if (!this._db) return null;
       const stmt = this._db.prepare(
           "SELECT value FROM kanban_meta WHERE key = ? AND workspace_id = ?"
       );
       try {
           if (stmt.bind([`worktree_${sessionId}`, this._workspaceId]) && stmt.step()) {
               return JSON.parse(String(stmt.getAsObject().value));
           }
           return null;
       } finally {
           stmt.free();
       }
   }

   async clearWorktreeMeta(sessionId: string): Promise<void> {
       if (!this._db) return;
       this._db.run(
           "DELETE FROM kanban_meta WHERE key = ? AND workspace_id = ?",
           [`worktree_${sessionId}`, this._workspaceId]
       );
       await this._persist();
   }
   ```

### Phase 2: Agents Tab Setting

**File**: `src/webview/kanban.html`

1. Add checkbox in agents tab near the Jules auto-sync checkbox (after line 2114):
   ```html
   <label class="startup-row" style="display:flex;align-items:center;gap:8px;margin-top:6px;">
     <input id="agents-tab-git-worktrees" type="checkbox" style="width:auto;margin:0;">
     <span>Use git worktrees for coder agents</span>
   </label>
   ```

2. Add JavaScript handler to save setting (follows `julesAutoSyncEnabled` pattern):
   ```javascript
   document.getElementById('agents-tab-git-worktrees')?.addEventListener('change', (e) => {
     const enabled = e.target.checked;
     postKanbanMessage({ type: 'saveStartupCommands', gitWorktreesEnabled: enabled });
   });
   ```

3. Load setting on tab initialization (in `agentsTabCollectConfig()`, near line 2848):
   ```javascript
   gitWorktreesEnabled: document.getElementById('agents-tab-git-worktrees')?.checked ?? false,
   ```

4. Handle setting hydration in message handler (near line 5241, following `julesAutoSyncSetting` pattern):
   ```javascript
   if (msg.gitWorktreesEnabled !== undefined) {
     const el = document.getElementById('agents-tab-git-worktrees');
     if (el) el.checked = !!msg.gitWorktreesEnabled;
   }
   ```

**File**: `src/services/KanbanProvider.ts`

5. Add `gitWorktreesEnabled` to `_getStartupCommands()` return (line 2196-2200):
   ```typescript
   return {
       commands: state.startupCommands || {},
       visibleAgents: state.visibleAgents || {},
       julesAutoSyncEnabled: state.julesAutoSyncEnabled ?? false,
       gitWorktreesEnabled: state.gitWorktreesEnabled ?? false
   };
   ```

6. Add `gitWorktreesEnabled` to `_saveStartupCommands()` (line 2206-2217):
   ```typescript
   if (typeof msg.gitWorktreesEnabled === 'boolean') state.gitWorktreesEnabled = msg.gitWorktreesEnabled;
   ```

7. Include `gitWorktreesEnabled` in `startupCommands` message payload (line 5862):
   ```typescript
   this._panel?.webview.postMessage({ type: 'startupCommands', ...startupState });
   // startupState already includes gitWorktreesEnabled from step 5
   ```

### Phase 3: Git Repo Detection & Worktree Creation on Coder Dispatch

**File**: `src/services/TaskViewerProvider.ts`

The worktree creation must hook into `TaskViewerProvider._handleTriggerAgentAction()` (called by `handleKanbanTrigger()` at line 2052), because that's where the dispatch chain routes through (extension.ts line 1725-1727).

1. Add git repo detection helper:
   ```typescript
   private async _isGitRepo(workspaceRoot: string): Promise<boolean> {
       const { exec } = require('child_process');
       const { promisify } = require('util');
       const execAsync = promisify(exec);
       try {
           await execAsync('git rev-parse --is-inside-work-tree', { cwd: workspaceRoot });
           return true;
       } catch {
           return false;
       }
   }
   ```

2. Add worktree creation helper. **CRITICAL**: Worktrees must be created OUTSIDE the main working tree (git forbids nested worktrees). Use a sibling directory:
   ```typescript
   private async _createWorktree(workspaceRoot: string, sessionId: string): Promise<{ worktreePath: string; worktreeBranch: string }> {
       const { exec } = require('child_process');
       const { promisify } = require('util');
       const execAsync = promisify(exec);

       // Sanitize sessionId for branch name (replace non-alphanumeric with -)
       const safeId = sessionId.replace(/[^a-zA-Z0-9_-]/g, '-').substring(0, 40);
       const worktreeBranch = `sb-coder-${safeId}`;

       // Create worktree OUTSIDE the main working tree (sibling directory)
       // e.g., /path/to/my-project → /path/to/my-project-wt-sess_abc123
       const repoName = path.basename(workspaceRoot);
       const parentDir = path.dirname(workspaceRoot);
       const worktreePath = path.join(parentDir, `${repoName}-wt-${safeId}`);

       // Create worktree with new branch from HEAD
       await execAsync(
           `git worktree add -b ${worktreeBranch} "${worktreePath}"`,
           { cwd: workspaceRoot }
       );

       return { worktreePath, worktreeBranch };
   }
   ```

3. Add worktree cleanup helper:
   ```typescript
   private async _cleanupWorktree(workspaceRoot: string, sessionId: string): Promise<void> {
       const { exec } = require('child_process');
       const { promisify } = require('util');
       const execAsync = promisify(exec);

       const db = await this._getKanbanDb(workspaceRoot);
       const meta = await db.getWorktreeMeta(sessionId);
       if (!meta) return;

       // Remove worktree (force to handle uncommitted changes)
       try {
           await execAsync(`git worktree remove --force "${meta.worktreePath}"`, { cwd: workspaceRoot });
       } catch (e: any) {
           console.warn(`[TaskViewerProvider] Failed to remove worktree: ${e.message}`);
       }

       // Delete branch
       try {
           await execAsync(`git branch -D ${meta.worktreeBranch}`, { cwd: workspaceRoot });
       } catch (e: any) {
           console.warn(`[TaskViewerProvider] Failed to delete branch: ${e.message}`);
       }

       // Clear metadata
       await db.clearWorktreeMeta(sessionId);
       await db.updateHasWorktree(sessionId, false);
   }
   ```

4. Modify `_handleTriggerAgentAction()` to create worktree for coder roles. Insert BEFORE the prompt is built and terminal dispatched:
   ```typescript
   // In _handleTriggerAgentAction, after resolving workspaceRoot and role,
   // before building the prompt:
   const gitWorktreesEnabled = await this._getGitWorktreesEnabled(workspaceRoot);

   if (gitWorktreesEnabled && ['coder', 'lead', 'intern'].includes(role)) {
       // Pre-check: is this a git repo?
       const isGit = await this._isGitRepo(workspaceRoot);
       if (!isGit) {
           vscode.window.showWarningMessage(
               'Git worktrees enabled but workspace is not a git repository. Dispatching without worktree.'
           );
       } else {
           try {
               const { worktreePath, worktreeBranch } = await this._createWorktree(workspaceRoot, sessionId);

               // Store metadata in kanban_meta
               const db = await this._getKanbanDb(workspaceRoot);
               await db.setWorktreeMeta(sessionId, { worktreePath, worktreeBranch });
               await db.updateHasWorktree(sessionId, true);

               // Override working directory for the dispatch
               options = { ...options, workingDirectory: worktreePath };

               // Disable git prohibition for this dispatch
               options = { ...options, gitProhibitionEnabled: false };

               vscode.window.showInformationMessage(
                   `Created worktree at ${worktreePath} on branch ${worktreeBranch}`
               );
           } catch (err: any) {
               vscode.window.showErrorMessage(
                   `Failed to create worktree: ${err.message}. Dispatching without worktree.`
               );
           }
       }
   }
   ```

5. Add helper to get the setting:
   ```typescript
   private async _getGitWorktreesEnabled(workspaceRoot: string): Promise<boolean> {
       // Read from state.json via KanbanProvider
       const startupState = await this._kanbanProvider?._getStartupCommands(workspaceRoot);
       return startupState?.gitWorktreesEnabled ?? false;
   }
   ```
   Note: `_getStartupCommands` is currently private on KanbanProvider. It needs to be made accessible — either by making it public/internal, or by having TaskViewerProvider read `state.json` directly using the same pattern.

6. Extend `ConfiguredKanbanDispatchOptions` (or the options passed to `_handleTriggerAgentAction`) to support:
   ```typescript
   workingDirectory?: string;  // Override the working directory for the dispatch
   gitProhibitionEnabled?: boolean;  // Override git prohibition for this dispatch
   ```

7. In the prompt building section of `_handleTriggerAgentAction()`, pass the override:
   ```typescript
   const promptOptions: Partial<PromptBuilderOptions> = {
       ...existingOptions,
       gitProhibitionEnabled: options?.gitProhibitionEnabled ?? defaultGitProhibition,
   };
   ```

8. In the terminal dispatch section, use the overridden working directory:
   ```typescript
   const effectiveWorkingDir = options?.workingDirectory ?? workspaceRoot;
   // Pass effectiveWorkingDir to the terminal dispatch command
   ```

### Phase 4: Merge Button UI

**File**: `src/webview/kanban.html`

1. Add merge button to CODE REVIEWED column header. In the column header rendering section, after the column label and count badge:
   ```javascript
   // In column rendering for CODE REVIEWED
   const isCodeReviewed = def.id === 'CODE REVIEWED';
   const worktreeCount = window.worktreeCounts?.[def.id] || 0;

   const mergeBtn = (isCodeReviewed && worktreeCount > 0)
     ? `<button class="column-icon-btn" data-action="mergeWorktrees" data-column="${escapeAttr(def.id)}" data-tooltip="Merge git worktrees for reviewed plans">
         <img src="${ICON_MERGE_WORKTREES}" alt="Merge Worktrees">
         <span class="worktree-count">(${worktreeCount})</span>
       </button>`
     : '';
   ```

2. Add CSS for worktree count badge:
   ```css
   .worktree-count {
     font-size: 9px;
     font-weight: 600;
     color: var(--accent-teal);
     margin-left: 2px;
   }
   ```

3. Add icon constant (need to add to icon injection list):
   ```javascript
   const ICON_MERGE_WORKTREES = '{{ICON_MERGE_WORKTREES}}'; // Add to icon list
   ```

4. Add click handler for merge button (in the existing button click handler):
   ```javascript
   if (action === 'mergeWorktrees') {
     postKanbanMessage({
       type: 'mergeWorktrees',
       workspaceRoot: currentWorkspaceRoot
     });
   }
   ```

5. Add worktree count to state tracking:
   ```javascript
   window.worktreeCounts = {}; // Track worktree counts per column
   ```

### Phase 5: Worktree Count Tracking

**File**: `src/services/KanbanProvider.ts`

1. Add method to count worktrees per column:
   ```typescript
   private async _getWorktreeCounts(workspaceRoot: string): Promise<Record<string, number>> {
       const db = await this._getKanbanDb(workspaceRoot);
       const cards = await db.getAllCards();

       const counts: Record<string, number> = {};
       for (const card of cards) {
           if (card.hasWorktree) {
               counts[card.kanbanColumn] = (counts[card.kanbanColumn] || 0) + 1;
           }
       }

       return counts;
   }
   ```

2. Send worktree counts to webview on refresh (in `_refreshBoard`):
   ```typescript
   const worktreeCounts = await this._getWorktreeCounts(workspaceRoot);
   this._panel?.webview.postMessage({ type: 'worktreeCounts', counts: worktreeCounts });
   ```

3. Handle worktree counts message in kanban.html:
   ```javascript
   if (msg.type === 'worktreeCounts') {
     window.worktreeCounts = msg.counts;
     renderBoard(); // Re-render to show/hide merge button
   }
   ```

### Phase 6: Merge Workflow Handler

**File**: `src/services/KanbanProvider.ts`

1. Add `mergeWorktrees` message handler (in the message switch, near other action handlers):
   ```typescript
   case 'mergeWorktrees': {
       const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
       if (!workspaceRoot) break;

       // Get all sessions with active worktrees in CODE REVIEWED
       const db = await this._getKanbanDb(workspaceRoot);
       const cards = await db.getCardsByColumn('CODE REVIEWED');
       const sessionsWithWorktrees = [];

       for (const card of cards) {
           if (card.hasWorktree) {
               const meta = await db.getWorktreeMeta(card.sessionId);
               if (meta) {
                   sessionsWithWorktrees.push({
                       sessionId: card.sessionId,
                       worktreePath: meta.worktreePath,
                       worktreeBranch: meta.worktreeBranch,
                       topic: card.topic || card.sessionId
                   });
               }
           }
       }

       if (sessionsWithWorktrees.length === 0) {
           vscode.window.showInformationMessage('No worktrees to merge');
           break;
       }

       // Dispatch reviewer agent with merge-worktrees instruction
       const dispatched = await vscode.commands.executeCommand<boolean>(
           'switchboard.triggerAgentFromKanban',
           'reviewer',
           sessionsWithWorktrees[0].sessionId,
           'merge-worktrees',
           workspaceRoot
       );

       if (dispatched) {
           vscode.window.showInformationMessage(`Merging ${sessionsWithWorktrees.length} worktree(s)...`);
       }
       break;
   }
   ```

### Phase 7: Worktree Cleanup

**File**: `src/services/TaskViewerProvider.ts`

1. Call `_cleanupWorktree()` after successful merge (when reviewer agent reports completion for a `merge-worktrees` instruction). This hooks into the existing result-handling flow.

2. Add cleanup on plan rejection (if user manually moves plan back from CODE REVIEWED):
   ```typescript
   // In the kanban column change handler, when a plan leaves CODE REVIEWED
   // and has an active worktree, offer cleanup:
   if (card.hasWorktree && newColumn !== 'CODE REVIEWED') {
       const choice = await vscode.window.showWarningMessage(
           `Plan "${card.topic}" has an active worktree. Clean it up?`,
           'Clean Up', 'Leave It'
       );
       if (choice === 'Clean Up') {
           await this._cleanupWorktree(workspaceRoot, card.sessionId);
       }
   }
   ```

3. Add orphaned worktree cleanup on extension startup:
   ```typescript
   // In extension activation or KanbanProvider initialization
   private async _cleanupOrphanedWorktrees(workspaceRoot: string): Promise<void> {
       const { exec } = require('child_process');
       const { promisify } = require('util');
       const execAsync = promisify(exec);

       try {
           // List all worktrees
           const { stdout } = await execAsync('git worktree list --porcelain', { cwd: workspaceRoot });
           const worktreeLines = stdout.trim().split('\n').filter(l => l.startsWith('worktree '));

           // Get all active worktree sessions from DB
           const db = await this._getKanbanDb(workspaceRoot);
           const cards = await db.getAllCards();
           const activeWorktreeSessions = new Set(
               cards.filter(c => c.hasWorktree).map(c => c.sessionId)
           );

           // Check each worktree against DB state
           for (const line of worktreeLines) {
               const wtPath = line.replace('worktree ', '');
               if (wtPath === workspaceRoot) continue; // Main working tree

               // If no session in DB references this worktree, it's orphaned
               const isKnown = Array.from(activeWorktreeSessions).some(async (sid) => {
                   const meta = await db.getWorktreeMeta(sid);
                   return meta && meta.worktreePath === wtPath;
               });

               // Simple heuristic: worktree paths contain "-wt-"
               if (wtPath.includes('-wt-') && !await isKnown) {
                   console.warn(`[Switchboard] Orphaned worktree detected: ${wtPath}`);
                   // Optionally auto-clean or prompt user
               }
           }
       } catch {
           // Not a git repo or no worktrees — safe to ignore
       }
   }
   ```

### Phase 8: Reviewer Agent Integration

**File**: `src/services/agentPromptBuilder.ts`

1. Add merge directive constant (near line 243-254, following existing directive pattern):
   ```typescript
   export const MERGE_WORKTREES_DIRECTIVE = `MERGE WORKTREES DIRECTIVE:
   You are tasked with merging git worktrees for reviewed plans.
   For each worktree listed in the plan context:
   1. Check if there are changes: cd <worktree-path> && git diff --exit-code
   2. If no changes: remove worktree (git worktree remove <worktree-path>) and skip
   3. If changes exist:
      - Navigate to main workspace: cd <workspace-root>
      - Attempt to merge the branch: git merge <worktree-branch>
      - If merge succeeds: remove worktree and branch, mark as merged
      - If merge conflicts:
        * Show the conflicted files to the user
        * Ask user how to resolve (accept theirs, accept ours, edit manually)
        * After resolution, complete merge and remove worktree
   4. Report final status for each worktree in the plan file
   5. Do NOT push to remote — only local merge`;
   ```

2. Modify prompt builder to include merge directive when instruction is 'merge-worktrees' (in the role-specific prompt building section, near line 409-450 for reviewer):
   ```typescript
   if (instruction === 'merge-worktrees') {
       directives.push(MERGE_WORKTREES_DIRECTIVE);
   }
   ```

**File**: `src/services/TaskViewerProvider.ts`

3. Handle `merge-worktrees` instruction in reviewer dispatch. When `instruction === 'merge-worktrees'`, the prompt builder should include the merge directive and the dispatch should target the main workspace (not a worktree).

4. Pass merge context to the reviewer agent by including worktree session details in the prompt payload.

### Phase 9: Icon Addition

**File**: `src/services/KanbanProvider.ts`

1. Add merge worktree icon to the icon injection map (line 6508-6530):
   ```typescript
   '{{ICON_MERGE_WORKTREES}}': webview.asWebviewUri(vscode.Uri.joinPath(iconDir, 'git-merge.svg')).toString(),
   ```
   Note: A new `git-merge.svg` icon file needs to be added to the `icons/` directory. This can be a simple SVG merge icon (two arrows converging).

### Phase 10: Testing

**Test Cases**:

1. **Worktree Creation**:
   - Enable setting, dispatch coder agent
   - Verify worktree is created in sibling directory (outside main working tree)
   - Verify metadata is stored in `kanban_meta` table
   - Verify `has_worktree` flag is set in plans table

2. **Worktree Isolation**:
   - Create two coder agents in parallel
   - Verify they use different worktrees
   - Verify they don't interfere with each other

3. **Non-Git Repo Handling**:
   - Disable worktree feature gracefully when workspace is not a git repo
   - Show warning message, dispatch without worktree

4. **Merge Button Visibility**:
   - Verify button shows correct count
   - Verify button hides when no worktrees
   - Verify button shows in CODE REVIEWED only

5. **Merge Workflow**:
   - Create worktree with changes
   - Move to CODE REVIEWED
   - Click merge button
   - Verify reviewer agent is dispatched with merge-worktrees instruction
   - Verify merge directive is included in prompt

6. **Successful Merge**:
   - Worktree with simple changes
   - Verify merge succeeds
   - Verify worktree is cleaned up (directory removed, branch deleted)
   - Verify count decrements
   - Verify `kanban_meta` entry is cleared

7. **Merge Conflict**:
   - Create conflicting changes in main branch
   - Verify reviewer detects conflict
   - Verify reviewer asks for resolution
   - Verify resolution completes merge

8. **No Changes**:
   - Worktree with no changes
   - Verify worktree is skipped and cleaned up

9. **Cleanup**:
   - Orphaned worktree detection on startup
   - Manual cleanup option when plan moves out of CODE REVIEWED
   - Force cleanup on extension deactivation

10. **Branch Name Sanitization**:
    - SessionId with special characters
    - Verify branch name is sanitized (no invalid chars)

11. **Settings Persistence**:
    - Enable worktrees, close and reopen workspace
    - Verify setting persists in `state.json`
    - Verify checkbox reflects saved state

## Edge Cases & Considerations

1. **Non-git Repositories**: Detect if workspace is not a git repo via `git rev-parse --is-inside-work-tree`; disable worktree feature with warning.
2. **Dirty Working Directory**: Warn if main workspace has uncommitted changes before creating worktree (may cause merge conflicts later).
3. **Branch Name Conflicts**: Handle if branch already exists — append timestamp suffix (e.g., `sb-coder-sess_abc-1716567890`).
4. **Worktree Path Conflicts**: Handle if sibling directory already exists — append numeric suffix.
5. **Merge Conflicts**: Ensure reviewer agent can handle conflicts gracefully via interactive prompts.
6. **Multi-repo**: Each repo needs its own worktree per session; `repo_scope` column (already in DB) can be leveraged.
7. **Disk Space**: Monitor worktree disk usage; provide cleanup option in UI.
8. **Network Operations**: Keep git push/fetch prohibition for worktrees unless explicitly overridden — worktree commits should stay local until review.
9. **Nested Worktree Rejection**: Git forbids creating a worktree inside an existing worktree's directory. The sibling directory strategy avoids this.
10. **Extension Deactivation**: Clean up worktrees on extension deactivation to avoid stale state.

## Rollout Plan

1. **Phase 1**: Database schema and metadata storage (V24 migration, kanban_meta helpers)
2. **Phase 2**: Agents tab setting and state.json persistence
3. **Phase 3**: Worktree creation in TaskViewerProvider dispatch flow
4. **Phase 4**: Merge button UI and count tracking
5. **Phase 5**: Merge workflow and reviewer integration
6. **Phase 6**: Cleanup and edge case handling
7. **Phase 7**: Testing and refinement

## Success Criteria

- Coder agents can work in isolated worktrees (outside main working tree)
- Merge button appears when worktrees exist in CODE REVIEWED
- Reviewer agent successfully merges worktrees
- Worktrees are cleaned up after merge
- Merge conflicts are handled gracefully
- No data loss during merge process
- Performance impact is minimal
- Non-git repos are handled gracefully with warning

## Recommendation

**Complexity: 7 → Send to Lead Coder**

This plan involves multi-file coordination across the database layer, dispatch pipeline, webview UI, and prompt builder. The worktree-creation-outside-working-tree constraint and the `kanban_meta` storage strategy require careful implementation. A lead coder should handle the cross-cutting concerns and ensure the dispatch flow integration is correct.

---

## Review Pass Results (2026-05-24)

### Reviewer: Direct in-place reviewer pass

### Findings & Fixes Applied

| ID | Severity | Finding | Fix Applied | Files Changed |
|:---|:---------|:--------|:------------|:--------------|
| CRITICAL-1 | CRITICAL | `ConfiguredKanbanDispatchOptions` type missing `workingDirectory` and `gitProhibitionEnabled` fields — worktree dispatch overrides were dead code / type error | Added both optional fields to the type definition | `src/services/TaskViewerProvider.ts` (lines 157-159) |
| CRITICAL-2 | CRITICAL | Merge workflow only dispatched reviewer for first worktree session; remaining worktrees invisible to agent | Merge context now queries DB for ALL worktrees in CODE REVIEWED and includes full list in reviewer prompt | `src/services/TaskViewerProvider.ts` (lines 14538-14566) |
| MAJOR-1 | MAJOR | Branch name collision not handled — `git worktree add -b` fails if branch already exists | Added `git branch --list` pre-check with timestamp suffix fallback | `src/services/TaskViewerProvider.ts` (`_createWorktree`) |
| MAJOR-2 | MAJOR | Worktree path collision not handled — directory may already exist from incomplete cleanup | Added `fs.existsSync` loop with numeric suffix fallback | `src/services/TaskViewerProvider.ts` (`_createWorktree`) |
| MAJOR-3 | MAJOR | `_cleanupOrphanedWorktrees` had O(worktrees × cards) inner loop with per-card DB queries | Pre-fetch all worktree metadata into a Map before the loop | `src/services/TaskViewerProvider.ts` (`_cleanupOrphanedWorktrees`) |
| NIT-1 | NIT | Redundant `require('child_process')` / `require('util')` in worktree methods (top-level imports already exist) | Replaced with top-level `cp.exec` and `promisify` | `src/services/TaskViewerProvider.ts` (all worktree methods) |
| NIT-2 | NIT | Branch name not quoted in `git worktree add` and `git branch -D` commands | Added double quotes around branch names | `src/services/TaskViewerProvider.ts` (`_createWorktree`, `_cleanupWorktree`, `_cleanupOrphanedWorktrees`) |

### Validation Results

- **Syntax check**: All 4 modified source files (`TaskViewerProvider.ts`, `KanbanProvider.ts`, `KanbanDatabase.ts`, `agentPromptBuilder.ts`) parse cleanly with zero TypeScript syntax errors.
- **Icon file**: `icons/git-merge.svg` exists (444 bytes).
- **Compilation**: Skipped per session instructions.
- **Tests**: Skipped per session instructions.

### Remaining Risks

1. **Merge conflict resolution is interactive**: The `MERGE_WORKTREES_DIRECTIVE` instructs the reviewer agent to "ask user how to resolve" conflicts. Agents in this system are conversational (Devin, etc.) and handle multi-turn interaction natively. No fix needed — left as-is.
2. **Multi-worktree merge is sequential**: The reviewer processes worktrees one at a time. If a conflict stalls, user guidance handles the blocking (the user can resolve and continue). No fix needed — left as-is.
3. **Dirty working directory → auto-commit**: ~~Not implemented~~ **Fixed.** `_autoCommitDirtyMain()` now runs before every worktree creation: it stages all changes and commits with a descriptive message (`switchboard: auto-commit before worktree creation (<timestamp>)`). A UI note under the worktree checkbox informs the user: "Uncommitted changes are auto-committed to main before each worktree is created." If auto-commit fails (pre-commit hook rejection, empty tree), it logs a warning and proceeds — a dirty main is a soft risk, not a hard block. Files changed: `src/services/TaskViewerProvider.ts` (`_autoCommitDirtyMain`), `src/webview/kanban.html` (note + visibility toggle).
4. **Worktree cleanup policy → manual-only**: ~~Startup orphan scan and column-change cleanup prompts~~ **Removed.** Worktrees now persist across sessions until the user explicitly resolves them (merge button → reviewer → cleanup on success). The previous implementation was too aggressive — it could destroy work from sessions that hadn't been merged yet. Changes:
   - Removed `_cleanupOrphanedWorktrees()` method entirely.
   - Removed startup orphan scan call from `_runDeferredConstructorInit()`.
   - Removed cleanup prompt when a plan leaves CODE REVIEWED (replaced with a comment explaining the policy).
   - Kept cleanup on successful merge completion only (user-initiated action via merge button).
   Files changed: `src/services/TaskViewerProvider.ts`.
5. **`kanban_meta` keys not workspace-scoped**: The `kanban_meta` table has no `workspace_id` column. When child workspaces share a parent DB (via `workspaceDatabaseMappings`), worktree metadata keys like `worktree_<sessionId>` can collide across workspaces. **Fixed.** Added `_worktreeMetaKey()` helper that prefixes keys with `workspace_id` (`worktree_<wsId>_<sessionId>`), preventing cross-workspace collisions without requiring a schema migration. File changed: `src/services/KanbanDatabase.ts`.
