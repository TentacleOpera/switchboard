# Worktrees A: Remove Old Code + Update Schema

## Goal

Remove all existing ephemeral worktree code from the codebase and update the database schema to support the new deliberate worktrees system. This is the prerequisite plan — Plans B and C depend on it.

## Metadata

- **Tags:** [workflow, git]
- **Complexity:** 4

## User Review Required

- None

## Complexity Audit

### Routine
- Removing `hasWorktree` field from interfaces and record initializations across ~8 files
- Removing V24 migration constant and execution block (dead code)
- Adding `worktrees` table and `worktree_id` column to SCHEMA_SQL
- Adding worktree CRUD methods to KanbanDatabase

### Complex / Risky
- Complete removal of existing worktree code across 10+ files (must be thorough — missing a reference breaks the build)
- `gitProhibitionEnabled` on `ConfiguredKanbanDispatchOptions` is shared between worktree and role-config addons — must remove only worktree override, not the field itself
- `openWorktreeForCoderAgents` state.json setting and its UI in setup.html must be fully cleaned up

## Edge-Case & Dependency Audit

- **Race Conditions**: None for this plan (removal-only + schema edit).
- **Security**: None.
- **Side Effects**: Removing `hasWorktree` from `KanbanPlanRecord` affects every file that constructs plan records — must update all of them or TypeScript will error.
- **Dependencies & Conflicts**: Depends on the `has_worktree` column already being dropped from live databases (done — both switchboard and gitlab DBs patched).

## Dependencies

- None

## Adversarial Synthesis

Key risks: (1) Incomplete removal of old worktree code across 10+ files will leave dead code and cause TypeScript build errors — every `hasWorktree` reference must be found and removed. (2) `gitProhibitionEnabled` field is shared with role-config addons — removing the field itself would break non-worktree functionality. Only the worktree-specific override logic in `_dispatchExecuteMessage()` should be removed. Mitigations: Use grep to verify zero remaining references after changes; preserve shared fields.

## Proposed Changes

### File: `src/services/KanbanDatabase.ts`

1. **Edit SCHEMA_SQL** (~line 90-137):
   - Remove `has_worktree INTEGER DEFAULT 0` from plans table definition (~line 115)
   - Add `worktree_id INTEGER` after `linear_issue_id` (~line 114)
   - Add `worktrees` table after `projects` table (~line 136):
     ```sql
     CREATE TABLE IF NOT EXISTS worktrees (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         path TEXT NOT NULL,
         branch TEXT NOT NULL,
         coder_agent_id TEXT,
         workspace_id TEXT NOT NULL,
         created_at TEXT DEFAULT (datetime('now')),
         UNIQUE(path, workspace_id)
     );
     CREATE INDEX IF NOT EXISTS idx_worktrees_workspace ON worktrees(workspace_id);
     ```
   - Add index: `CREATE INDEX IF NOT EXISTS idx_plans_worktree ON plans(worktree_id);`

2. **Remove `MIGRATION_V24_SQL`** constant (~lines 389-391) and its execution block in `_runMigrations()` (~lines 3734-3756). Dead code — column dropped from all live DBs, SCHEMA_SQL no longer includes it.

3. **Remove worktree metadata methods**:
   - `updateHasWorktree()` (~line 1348-1355)
   - `_worktreeMetaKey()` (~line 1362-1365)
   - `setWorktreeMeta()` (~line 1367-1375)
   - `getWorktreeMeta()` (~line 1377-1391)
   - `clearWorktreeMeta()` (~line 1393-1401)

4. **Update `KanbanPlanRecord` interface** (~line 20-45):
   - Remove `hasWorktree: number` (~line 44)
   - Add `worktreeId?: number`

5. **Update `PLAN_COLUMNS`** (~line 435-438):
   - Remove `, has_worktree`
   - Add `, worktree_id`

6. **Update `UPSERT_PLAN_SQL`** (~line 399-430):
   - Remove `has_worktree` from INSERT column list, VALUES placeholder, and ON CONFLICT UPDATE
   - Add `worktree_id` to INSERT columns, VALUES, and ON CONFLICT UPDATE

7. **Update `_readRows()`** (~line 4466-4507):
   - Remove `hasWorktree: Number(row.has_worktree || 0)` (~line 4500)
   - Add `worktreeId: row.worktree_id as number | undefined`

8. **Update `upsertPlans()`** (~line 1070-1111):
   - Remove `record.hasWorktree ?? 0` from parameter binding (~line 1101)
   - Add `record.worktreeId ?? null` to parameter binding

9. **Update `_restoreFromBackup()`** (~line 3980-4024):
   - Remove `hasWorktree: p.has_worktree ?? p.hasWorktree ?? 0` (~line 3995)
   - Remove `record.hasWorktree ?? 0` from parameter binding (~line 4007)
   - Add `worktreeId` mapping and binding

10. **Add `_ensureSchemaColumns()` entry** for `worktree_id` column (so existing DBs that predate this column get it added automatically on next load).

11. **Add worktree CRUD methods** (after the spot where `clearWorktreeMeta` was removed):
    ```typescript
    async createWorktree(wtPath: string, branch: string, coderAgentId: string | null): Promise<number> {
        if (!this._db) return -1;
        const stmt = this._db.prepare(
            'INSERT INTO worktrees (path, branch, coder_agent_id, workspace_id) VALUES (?, ?, ?, ?)'
        );
        try {
            stmt.bind([wtPath, branch, coderAgentId, await this.getWorkspaceId()]);
            stmt.step();
            return this._db.lastInsertRowid as number;
        } finally {
            stmt.free();
        }
    }

    async getWorktrees(): Promise<Array<{ id: number; path: string; branch: string; coderAgentId: string | null }>> {
        if (!this._db) return [];
        const stmt = this._db.prepare(
            'SELECT id, path, branch, coder_agent_id FROM worktrees WHERE workspace_id = ?'
        );
        try {
            stmt.bind([await this.getWorkspaceId()]);
            const results: Array<{ id: number; path: string; branch: string; coderAgentId: string | null }> = [];
            while (stmt.step()) {
                const row = stmt.getAsObject();
                results.push({
                    id: row.id as number,
                    path: row.path as string,
                    branch: row.branch as string,
                    coderAgentId: row.coder_agent_id as string | null
                });
            }
            return results;
        } finally {
            stmt.free();
        }
    }

    async deleteWorktree(id: number): Promise<void> {
        if (!this._db) return;
        // Clear worktree_id on any plans referencing this worktree
        this._db.run('UPDATE plans SET worktree_id = NULL WHERE worktree_id = ?', [id]);
        this._db.run('DELETE FROM worktrees WHERE id = ?', [id]);
        await this._persist();
    }

    async assignAgentToWorktree(worktreeId: number, coderAgentId: string): Promise<void> {
        if (!this._db) return;
        this._db.run(
            'UPDATE worktrees SET coder_agent_id = ? WHERE id = ?',
            [coderAgentId, worktreeId]
        );
        await this._persist();
    }

    async updatePlanWorktree(sessionId: string, worktreeId: number | null): Promise<void> {
        if (!this._db) return;
        this._db.run(
            'UPDATE plans SET worktree_id = ? WHERE session_id = ?',
            [worktreeId, sessionId]
        );
        await this._persist();
    }

    async getWorktreeById(id: number): Promise<{ id: number; path: string; branch: string; coderAgentId: string | null } | null> {
        if (!this._db) return null;
        const stmt = this._db.prepare(
            'SELECT id, path, branch, coder_agent_id FROM worktrees WHERE id = ?'
        );
        try {
            stmt.bind([id]);
            if (stmt.step()) {
                const row = stmt.getAsObject();
                return {
                    id: row.id as number,
                    path: row.path as string,
                    branch: row.branch as string,
                    coderAgentId: row.coder_agent_id as string | null
                };
            }
            return null;
        } finally {
            stmt.free();
        }
    }
    ```

    **Clarification**: `createWorktree` parameter renamed from `path` to `wtPath` to avoid shadowing the imported `path` module.

### File: `src/services/TaskViewerProvider.ts`

1. **Remove worktree methods**:
   - `_createWorktree()` (~line 16994-17037)
   - `_cleanupWorktree()` (~line 17039-17067)
   - `createWorktreeForSession()` (~line 17069-17109)
   - `_autoCommitDirtyMain()` (~line 16931-16961) — confirmed only called from `createWorktreeForSession` at line 17095

2. **Remove worktree logic from `_dispatchExecuteMessage()`** (~lines 14684-14705):
   - Remove the worktree metadata lookup block that sets `workingDirectory` and `gitProhibitionEnabled` overrides
   - Remove the stale metadata cleanup (`clearWorktreeMeta`, `updateHasWorktree`)

3. **Remove worktree cleanup from result handling** (~line 13484-13496):
   - Remove `_cleanupWorktree()` call on reviewer-pass completion

4. **Do NOT remove `workingDirectory` and `gitProhibitionEnabled` from `ConfiguredKanbanDispatchOptions`** (~lines 157, 159). These fields are also used by role-config addons for non-worktree purposes (`gitProhibitionEnabled` is set from `roleConfig?.addons?.gitProhibition` at ~line 6030 and ~14727). Only remove the worktree-specific override logic in `_dispatchExecuteMessage()`.

5. **Remove `openWorktreeForCoderAgents` handling**:
   - Remove from `handleGetStartupCommands()` return type (~line 3032)
   - Remove `openWorktreeForCoderAgents` variable and reading (~lines 3041-3047)
   - Remove `handleGetOpenWorktreeForCoderAgentsSetting()` method (~lines 3053-3063)
   - Remove `openWorktreeForCoderAgents` from save condition (~line 6302)
   - Remove `openWorktreeForCoderAgents` save logic (~lines 6353-6355)

### File: `src/services/KanbanProvider.ts`

1. **Remove worktree-related methods**:
   - `_handleWorktreeForColumnTransition()` (~lines 6294-6315)
   - `_isWorktreeAddonEnabled()` (~lines 6317-6336)
   - `_getWorktreeCounts()` (~lines 6394-6408)

2. **Remove worktree logic from**:
   - `moveCardToColumn()` — remove `_handleWorktreeForColumnTransition` call (~line 3776)
   - `moveCardToColumnByPlanFile()` — remove `_handleWorktreeForColumnTransition` call (~line 3808)
   - `mergeWorktrees` message handler (~lines 5713-5756)
   - Plan export / chat — remove worktree path inclusion (~lines 5022-5030)
   - `KanbanCard` interface — remove `hasWorktree: boolean` (~line 91)
   - Card construction — remove `hasWorktree` assignments (~lines 1009, 1025, 1752, 1772, 1889, 1905, 3402)
   - `openWorktreeForCoderAgents` reading from state (~lines 2262-2265)

3. **Remove worktree count tracking**:
   - `worktreeCounts` message sending (~lines 1094-1095)
   - `ICON_MERGE_WORKTREES` icon mapping (~line 6473)

### File: `src/webview/kanban.html`

1. **Remove merge button UI**:
   - Merge button from CODE REVIEWED column header (~lines 3737-3741)
   - `ICON_MERGE_WORKTREES` constant (~line 3120)
   - Worktree count CSS (~line 455)
   - `mergeWorktrees` from action handler (~lines 3895, 3898-3899)

2. **Remove worktree count state**:
   - `window.worktreeCounts` initialization (~line 3036)
   - `worktreeCounts` message handler (~lines 5445-5446)

### File: `src/services/agentPromptBuilder.ts`

1. Remove `MERGE_WORKTREES_DIRECTIVE` constant (~lines 231-245).
2. Remove `if (baseInstruction === 'merge-worktrees')` block (~lines 445-446) — adjust else branch to be unconditional.

### File: `src/services/PlanFileImporter.ts`

1. Remove `hasWorktree: 0` from plan record initialization (~line 127).

### File: `src/services/GlobalPlanWatcherService.ts`

1. Remove `hasWorktree: 0` from plan record initialization (~line 452).

### File: `src/services/NotionBackupService.ts`

1. Remove `hasWorktree: getNumber(p['Has Worktree'])` from plan record mapping (~line 324).

### File: `src/services/KanbanMigration.ts`

1. Remove `hasWorktree: 0` from plan record initialization (~line 49).

### File: `src/services/__tests__/KanbanProvider.test.ts`

1. Remove `hasWorktree: false` from test data (~line 28).

### File: `src/services/SetupPanelProvider.ts`

1. Remove `getOpenWorktreeForCoderAgentsSetting` message handler (~lines 513-519).

### File: `src/webview/setup.html`

1. Remove worktree toggle UI:
   - Worktree checkbox and label (~lines 504-507)
   - `getOpenWorktreeForCoderAgentsSetting` request on load (~line 1351)
   - Worktree toggle change handler (~lines 3211-3212)
   - Worktree toggle state restoration (~lines 3326-3327)
   - `openWorktreeForCoderAgentsSetting` message handler (~lines 3550-3552)

## Verification Plan

### Automated Tests
- TypeScript compilation must pass with zero errors (all `hasWorktree` references removed)
- Existing unit tests must pass

### Manual Verification
- Grep for zero remaining references: `hasWorktree`, `has_worktree`, `mergeWorktrees`, `MERGE_WORKTREES`, `worktreeCounts`, `openWorktreeForCoderAgents`, `createWorktreeForSession`, `_cleanupWorktree`, `_createWorktree`, `_autoCommitDirtyMain`, `_handleWorktreeForColumnTransition`, `_isWorktreeAddonEnabled`, `_getWorktreeCounts`, `setWorktreeMeta`, `getWorktreeMeta`, `clearWorktreeMeta`, `updateHasWorktree`, `_worktreeMetaKey`
- Delete local .db files and reload — verify fresh DB creation produces correct schema (no `has_worktree`, has `worktrees` table, has `worktree_id` column)

## Recommendation

**Complexity: 4 → Send to Coder**

This is a systematic removal + schema edit task. The main risk is missing a reference, which TypeScript will catch at compile time. Follow the checklist, compile, grep for zero references, and you're done.
