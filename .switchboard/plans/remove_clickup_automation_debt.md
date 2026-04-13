# Remove ClickUp Automation Technical Debt

## Goal
Strip out dead schema columns (`pipeline_id`, `is_internal`) and the unnecessary poll-time legacy purge path that were left behind after the ClickUp automation simplification. The simplified ClickUp automation works without these; they are pure technical debt from an abandoned implementation path.

## Metadata
**Tags:** backend, database
**Complexity:** 6
**Session ID:** sess_1744502400000
**Plan ID:** remove_clickup_automation_debt

## User Review Required
> [!NOTE]
> - No product behavior should change; this is a backend/schema cleanup plus regression-test update.
> - **Clarification:** The verified poll-time cleanup path in the current code is `_purgeLegacyAutomationExperiment()` plus `_purgeLegacyAutomationFiles()`. There is no `_purgeLegacyHiddenPipelinePlans()` symbol in the repository.
> - **Clarification:** `src/services/KanbanDatabase.ts` already uses the V10 label for completed-row repair, so the column-removal step must be added as the next schema cleanup block (V11 comment/step), not by reusing V10.
> - **Clarification:** `src/services/KanbanMigration.ts` should stay untouched. Its `SCHEMA_VERSION = 2` is a separate legacy coded-column migration mechanism and is not the place to wire this SQL schema cleanup.

## Complexity Audit
### Routine
- Remove `pipelineId` and `isInternal` from the `KanbanPlanRecord` interfaces in `src/services/KanbanDatabase.ts` and `src/services/ClickUpSyncService.ts`.
- Stop parsing `Pipeline ID` / `Internal Plan` metadata in `src/services/PlanFileImporter.ts`.
- Remove the stale `isInternal` / `pipelineId` properties from `src/services/KanbanProvider.ts::_queueClickUpSync()`.
- Update the ClickUp automation integration test so it asserts those properties are absent from imported records instead of checking for `false`/empty defaults.

### Complex / Risky
- Physically remove `pipeline_id` and `is_internal` from persisted `plans` tables in `src/services/KanbanDatabase.ts` without dropping real plan rows or the still-live `clickup_task_id` column.
- Remove the poll-time purge helpers from `src/services/ClickUpAutomationService.ts` without regressing plan creation, dedupe, or completion write-back.
- Update `src/test/completed-column-status-regression.test.js`, which currently hard-codes the legacy schema and `COALESCE(is_internal, 0) = 0` query shape.

## Edge-Case & Dependency Audit
- **Race Conditions:** `ClickUpAutomationService.poll()` runs after `KanbanDatabase.ensureReady()`. The schema cleanup must therefore stay inside `KanbanDatabase._runMigrations()` and complete before board or poll queries execute, so no caller ever observes a half-migrated `plans` table.
- **Security:** No new external surface is required. Keep ClickUp token handling, plan-file writes, and write-back behavior unchanged. The only destructive behavior removed is the dead legacy purge path that deletes files/rows for a never-shipped experiment.
- **Side Effects:** Existing workspaces may already have `pipeline_id`, `is_internal`, and `idx_plans_clickup_pipeline` on disk. The migration must preserve `clickup_task_id`, lifecycle fields, timestamps, and all active/completed plans while removing only the dead columns. `KanbanDatabase.reconcileDatabases()` already merges on the intersection of columns, so mixed old/new DB copies remain tolerable after this cleanup.
- **Dependencies & Conflicts:** `switchboard-get_kanban_state` succeeded. Active **New** plans: none. Active **Planned** plans:
  - `Enable Cross-Column Multi-Select Drag and Drop` touches `src/webview/kanban.html` only, so it is not a direct conflict.
  - `Add Kanban Column Management to Setup Panel` also edits `src/services/KanbanProvider.ts`, which this plan must touch for `_queueClickUpSync()`. Treat that as an active merge-conflict hotspot, but not as a blocking dependency.

## Adversarial Synthesis
### Grumpy Critique
This draft was trying to do surgery with the wrong anatomy chart. The named cleanup method does not even exist, the schema change was hand-waved as “drop two columns somehow,” and the blast radius was understated by several files. If someone follows the original draft literally, they will delete a couple of TypeScript properties, miss `KanbanProvider`, leave `completed-column-status-regression.test.js` hard-coded to `is_internal`, and proudly ship a codebase where the dead columns still squat inside every existing `kanban.db`. Marvelous — dead code above ground, undead schema below it.

And the migration story was especially flimsy. V10 is already occupied, `KanbanMigration.ts` is a different migration system entirely, and `ALTER TABLE ... DROP COLUMN` is the kind of lazy shortcut that turns persistent storage into folklore. If we are actually removing debt, remove it from the real table shape, preserve `clickup_task_id`, and delete the poll-time cleanup theatrics that were compensating for an experiment the product never shipped.

### Balanced Response
The corrected plan hardens all of that. It expands the verified change surface to every actual source and test file, corrects the cleanup method names, and explicitly keeps `KanbanMigration.ts` out of scope. The database change is defined as a guarded `plans` table rebuild inside `KanbanDatabase._runMigrations()` so fresh databases start clean and existing databases lose only the dead columns while preserving plan rows, lifecycle state, and `clickup_task_id`.

The runtime cleanup is equally narrow: remove the dead purge helpers, stop parsing/forwarding the two legacy fields, and update only the tests that genuinely encode the old schema. That keeps the work small enough for a standard coder pass while still being explicit enough to compile, migrate existing workspaces safely, and preserve current ClickUp automation behavior.

## Agent Recommendation

Send to Coder

## Proposed Changes
> [!IMPORTANT]
> **MAXIMUM DETAIL REQUIRED:** Keep this as a true debt-removal pass. Do not add new ClickUp behavior, new product settings, or new backward-compatibility features beyond the minimum migration needed to remove the dead columns from existing databases safely.

### High Complexity
- Step 1 (`src/services/KanbanDatabase.ts`) and Step 3 (`src/services/ClickUpAutomationService.ts`) are the risky portions. They change the persisted `plans` table contract and remove the poll-time purge path that currently executes before normal automation processing.

### Low Complexity
- Steps 2, 4, 5, and 6 are bounded importer/type/test updates that must land with the high-complexity work but do not carry their own migration risk.

### Clarification - verified scope and non-scope
- **Clarification:** Verified source/test references for `pipeline_id` / `is_internal` / the legacy purge path currently exist in:
  - `src/services/KanbanDatabase.ts`
  - `src/services/PlanFileImporter.ts`
  - `src/services/ClickUpAutomationService.ts`
  - `src/services/KanbanProvider.ts`
  - `src/services/ClickUpSyncService.ts`
  - `src/test/integrations/clickup/clickup-automation-service.test.js`
  - `src/test/completed-column-status-regression.test.js`
- **Clarification:** `src/test/integration-auto-pull-regression.test.js` does not reference the removed fields directly, so it stays a verification target only.
- **Clarification:** No change is needed in `ClickUpAutomationService._buildPlanContent()` because the generated plan files already omit `**Pipeline ID:**` and `**Internal Plan:** true` metadata.

### 1. Remove the legacy fields from the DB surface and migrate persisted tables
#### [MODIFY] `src/services/KanbanDatabase.ts`
- **Context:** This file owns the canonical `KanbanPlanRecord` type, the on-disk `plans` schema, the active/completed board queries, the ClickUp task lookup index, and the migration path that runs before the automation poller touches the DB.
- **Logic:**
  1. Remove `pipelineId` and `isInternal` from the exported `KanbanPlanRecord` interface.
  2. Remove `pipeline_id` and `is_internal` from `SCHEMA_SQL`, `UPSERT_PLAN_SQL`, `PLAN_COLUMNS`, the `upsertPlans()` binding list, and `_readRows()`.
  3. Replace the old three-column ClickUp index with a two-column index that matches the still-live query path: `(workspace_id, clickup_task_id)`.
  4. Narrow `MIGRATION_V9_SQL` so it only backfills `clickup_task_id` plus the new two-column index for older DBs.
  5. Add a V11 cleanup helper in `_runMigrations()` that checks `PRAGMA table_info(plans)` and, only when `pipeline_id` or `is_internal` still exists, rebuilds `plans` into a new table without those columns, copies data across, renames the table back to `plans`, and recreates the retained indexes.
  6. Remove `COALESCE(is_internal, 0) = 0` from board/completed queries because the column no longer exists after migration.
- **Implementation:**

```diff
--- a/src/services/KanbanDatabase.ts
+++ b/src/services/KanbanDatabase.ts
@@
 export interface KanbanPlanRecord {
     planId: string;
     sessionId: string;
@@
     brainSourcePath: string;
     mirrorPath: string;
     routedTo: string;        // agent role dispatched to: 'lead' | 'coder' | 'intern' | ''
     dispatchedAgent: string; // terminal/tool name: 'claude cli', 'copilot cli', etc.
     dispatchedIde: string;   // IDE name: 'Visual Studio Code', 'Cursor', 'Windsurf', etc.
-    pipelineId?: string;
-    isInternal?: boolean;
     clickupTaskId?: string;
 }
@@
     brain_source_path TEXT DEFAULT '',
     mirror_path       TEXT DEFAULT '',
     routed_to         TEXT DEFAULT '',
     dispatched_agent  TEXT DEFAULT '',
     dispatched_ide    TEXT DEFAULT '',
-    pipeline_id       TEXT DEFAULT '',
-    is_internal       INTEGER DEFAULT 0,
     clickup_task_id   TEXT DEFAULT ''
 );
 CREATE INDEX IF NOT EXISTS idx_plans_column ON plans(kanban_column);
 CREATE INDEX IF NOT EXISTS idx_plans_workspace ON plans(workspace_id);
 CREATE INDEX IF NOT EXISTS idx_plans_status ON plans(status);
-CREATE INDEX IF NOT EXISTS idx_plans_clickup_pipeline ON plans(workspace_id, clickup_task_id, pipeline_id);
+CREATE INDEX IF NOT EXISTS idx_plans_clickup_task ON plans(workspace_id, clickup_task_id);
@@
 const MIGRATION_V9_SQL = [
-    `ALTER TABLE plans ADD COLUMN pipeline_id TEXT DEFAULT ''`,
-    `ALTER TABLE plans ADD COLUMN is_internal INTEGER DEFAULT 0`,
     `ALTER TABLE plans ADD COLUMN clickup_task_id TEXT DEFAULT ''`,
-    `CREATE INDEX IF NOT EXISTS idx_plans_clickup_pipeline ON plans(workspace_id, clickup_task_id, pipeline_id)`,
+    `CREATE INDEX IF NOT EXISTS idx_plans_clickup_task ON plans(workspace_id, clickup_task_id)`,
 ];
@@
 const UPSERT_PLAN_SQL = `
 INSERT INTO plans (
     plan_id, session_id, topic, plan_file, kanban_column, status, complexity, tags, dependencies,
     workspace_id, created_at, updated_at, last_action, source_type,
     brain_source_path, mirror_path, routed_to, dispatched_agent, dispatched_ide,
-    pipeline_id, is_internal, clickup_task_id
-) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
+    clickup_task_id
+) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
 ON CONFLICT(plan_id) DO UPDATE SET
     session_id = excluded.session_id,
     topic = excluded.topic,
@@
     source_type = excluded.source_type,
     brain_source_path = excluded.brain_source_path,
     mirror_path = excluded.mirror_path,
     routed_to = excluded.routed_to,
     dispatched_agent = excluded.dispatched_agent,
     dispatched_ide = excluded.dispatched_ide,
-    pipeline_id = excluded.pipeline_id,
-    is_internal = excluded.is_internal,
     clickup_task_id = excluded.clickup_task_id
 `;
@@
 const PLAN_COLUMNS = `plan_id, session_id, topic, plan_file, kanban_column, status, complexity, tags, dependencies,
                       workspace_id, created_at, updated_at, last_action, source_type,
                       brain_source_path, mirror_path, routed_to, dispatched_agent, dispatched_ide,
-                      pipeline_id, is_internal, clickup_task_id`;
+                      clickup_task_id`;
@@
                 this._db.run(UPSERT_PLAN_SQL, [
                     record.planId,        // 1
                     record.sessionId,     // 2
@@
                     this._normalizePath(record.mirrorPath), // 16
                     record.routedTo || '',       // 17
                     record.dispatchedAgent || '', // 18
-                    record.dispatchedIde || '',   // 19
-                    record.pipelineId || '',      // 20
-                    record.isInternal === true ? 1 : 0, // 21
-                    record.clickupTaskId || ''    // 22
+                    record.dispatchedIde || '',   // 19
+                    record.clickupTaskId || ''    // 20
                 ]);
@@
         const stmt = this._db.prepare(
             `SELECT ${PLAN_COLUMNS} FROM plans
-             WHERE workspace_id = ? AND status = 'active' AND COALESCE(is_internal, 0) = 0
+             WHERE workspace_id = ? AND status = 'active'
              ORDER BY updated_at DESC`,
             [workspaceId]
         );
@@
         const stmt = this._db.prepare(
             `SELECT ${PLAN_COLUMNS} FROM plans
-             WHERE workspace_id = ? AND status = 'active' AND kanban_column = ? AND COALESCE(is_internal, 0) = 0
+             WHERE workspace_id = ? AND status = 'active' AND kanban_column = ?
              ORDER BY updated_at ASC`,
             [workspaceId, column]
         );
@@
         const stmt = this._db.prepare(
             `SELECT ${PLAN_COLUMNS} FROM plans
-             WHERE workspace_id = ? AND status = 'completed' AND COALESCE(is_internal, 0) = 0
+             WHERE workspace_id = ? AND status = 'completed'
              ORDER BY updated_at DESC
              LIMIT ?`,
             [workspaceId, limit]
         );
@@
     private _warnConflictCopies(): void {
         try {
@@
         }
     }
+
+    private _planTableHasColumn(columnName: string): boolean {
+        if (!this._db) return false;
+        const stmt = this._db.prepare("PRAGMA table_info(plans)");
+        try {
+            while (stmt.step()) {
+                if (String(stmt.getAsObject().name || '') === columnName) {
+                    return true;
+                }
+            }
+            return false;
+        } finally {
+            stmt.free();
+        }
+    }
+
+    private _dropLegacyClickUpAutomationColumns(): void {
+        if (!this._db) return;
+
+        const hasPipelineId = this._planTableHasColumn('pipeline_id');
+        const hasIsInternal = this._planTableHasColumn('is_internal');
+        if (!hasPipelineId && !hasIsInternal) {
+            try { this._db.exec('DROP INDEX IF EXISTS idx_plans_clickup_pipeline'); } catch { /* best effort */ }
+            try { this._db.exec('CREATE INDEX IF NOT EXISTS idx_plans_clickup_task ON plans(workspace_id, clickup_task_id)'); } catch { /* best effort */ }
+            return;
+        }
+
+        this._db.exec('BEGIN TRANSACTION');
+        try {
+            this._db.exec('DROP INDEX IF EXISTS idx_plans_clickup_pipeline');
+            this._db.exec(`
+CREATE TABLE plans_v11 (
+    plan_id TEXT PRIMARY KEY,
+    session_id TEXT UNIQUE NOT NULL,
+    topic TEXT NOT NULL,
+    plan_file TEXT,
+    kanban_column TEXT NOT NULL DEFAULT 'CREATED',
+    status TEXT NOT NULL DEFAULT 'active',
+    complexity TEXT DEFAULT 'Unknown',
+    tags TEXT DEFAULT '',
+    dependencies TEXT DEFAULT '',
+    workspace_id TEXT NOT NULL,
+    created_at TEXT NOT NULL,
+    updated_at TEXT NOT NULL,
+    last_action TEXT,
+    source_type TEXT DEFAULT 'local',
+    brain_source_path TEXT DEFAULT '',
+    mirror_path TEXT DEFAULT '',
+    routed_to TEXT DEFAULT '',
+    dispatched_agent TEXT DEFAULT '',
+    dispatched_ide TEXT DEFAULT '',
+    clickup_task_id TEXT DEFAULT ''
+);
+`);
+            this._db.exec(`
+INSERT INTO plans_v11 (
+    plan_id, session_id, topic, plan_file, kanban_column, status, complexity, tags, dependencies,
+    workspace_id, created_at, updated_at, last_action, source_type,
+    brain_source_path, mirror_path, routed_to, dispatched_agent, dispatched_ide, clickup_task_id
+)
+SELECT
+    plan_id, session_id, topic, plan_file, kanban_column, status, complexity, tags, dependencies,
+    workspace_id, created_at, updated_at, last_action, source_type,
+    brain_source_path, mirror_path, routed_to, dispatched_agent, dispatched_ide, clickup_task_id
+FROM plans
+`);
+            this._db.exec('DROP TABLE plans');
+            this._db.exec('ALTER TABLE plans_v11 RENAME TO plans');
+            this._db.exec('CREATE INDEX IF NOT EXISTS idx_plans_column ON plans(kanban_column)');
+            this._db.exec('CREATE INDEX IF NOT EXISTS idx_plans_workspace ON plans(workspace_id)');
+            this._db.exec('CREATE INDEX IF NOT EXISTS idx_plans_status ON plans(status)');
+            this._db.exec('CREATE INDEX IF NOT EXISTS idx_plans_clickup_task ON plans(workspace_id, clickup_task_id)');
+            this._db.exec('COMMIT');
+            console.log('[KanbanDatabase] V11 migration: removed legacy ClickUp automation columns pipeline_id and is_internal');
+        } catch (error) {
+            try { this._db.exec('ROLLBACK'); } catch { /* ignore rollback failure */ }
+            throw error;
+        }
+    }
 
     private _runMigrations(): void {
         if (!this._db) return;
@@
-        // V9: add internal ClickUp pipeline tracking fields
+        // V9: add ClickUp task tracking field and lookup index.
         for (const sql of MIGRATION_V9_SQL) {
             try { this._db.exec(sql); } catch { /* column/index already exists */ }
         }
@@
         } catch (e) {
             console.error('[KanbanDatabase] V10 completed-status repair failed:', e);
         }
+
+        // V11: remove abandoned internal ClickUp automation fields.
+        try {
+            this._dropLegacyClickUpAutomationColumns();
+        } catch (e) {
+            console.error('[KanbanDatabase] V11 ClickUp automation cleanup failed:', e);
+        }
     }
@@
                 rows.push({
                     planId: String(row.plan_id || ""),
@@
                     brainSourcePath: this._normalizePath(String(row.brain_source_path || "")),
                     mirrorPath: this._normalizePath(String(row.mirror_path || "")),
                     routedTo: String(row.routed_to || ""),
                     dispatchedAgent: String(row.dispatched_agent || ""),
                     dispatchedIde: String(row.dispatched_ide || ""),
-                    pipelineId: String(row.pipeline_id || ""),
-                    isInternal: Number(row.is_internal || 0) === 1,
                     clickupTaskId: String(row.clickup_task_id || "")
                 });
             }
```
- **Edge Cases Handled:** The migration runs only when the legacy columns still exist, so fresh DBs do not pay the rebuild cost. Older DBs keep all real plan data and `clickup_task_id`, while stale `idx_plans_clickup_pipeline` indexes are dropped and replaced cleanly.

### 2. Stop importing dead metadata into plan records
#### [MODIFY] `src/services/PlanFileImporter.ts`
- **Context:** The importer is the only place still parsing `Pipeline ID` and `Internal Plan` markers out of plan markdown before inserting/updating `KanbanPlanRecord`s.
- **Logic:**
  1. Keep extracting `Automation Rule` and `ClickUp Task ID` because those still drive `sourceType` and write-back behavior.
  2. Remove the dead metadata parsing for `Pipeline ID` and `Internal Plan`.
  3. Stop passing those fields into the imported `KanbanPlanRecord` payload.
- **Implementation:**

```diff
--- a/src/services/PlanFileImporter.ts
+++ b/src/services/PlanFileImporter.ts
@@
         const defaultSessionId = 'import_' + crypto.createHash('sha256')
             .update(filePath)
             .digest('hex')
             .slice(0, 16);
         const planId = extractEmbeddedMetadata(content, 'Plan ID') || defaultSessionId;
         const sessionId = extractEmbeddedMetadata(content, 'Session ID') || planId;
         const automationRuleName = extractEmbeddedMetadata(content, 'Automation Rule');
-        const pipelineId = extractEmbeddedMetadata(content, 'Pipeline ID');
         const clickupTaskId = extractClickUpTaskId(content);
-        const isInternal = /^(\\*\\*Internal Plan:\\*\\*|>\\s+\\*\\*Internal Plan:\\*\\*)\\s*true$/im.test(content);
         const sourceType = automationRuleName ? 'clickup-automation' : 'local';
@@
             brainSourcePath: '',
             mirrorPath: '',
             routedTo: '',
             dispatchedAgent: '',
             dispatchedIde: '',
-            pipelineId,
-            isInternal,
             clickupTaskId
         });
     }
```
- **Edge Cases Handled:** ClickUp automation plan imports still work because they rely on `Automation Rule` and `ClickUp Task ID`, which remain intact. Local plan imports are unaffected because they never used the removed metadata in the first place.

### 3. Delete the dead poll-time purge path
#### [MODIFY] `src/services/ClickUpAutomationService.ts`
- **Context:** The current automation poller still runs a legacy cleanup routine before polling ClickUp lists, even though generated automation plans already omit the hidden/internal metadata that routine was looking for.
- **Logic:**
  1. Delete `_purgeLegacyAutomationFiles()` and `_purgeLegacyAutomationExperiment()` entirely.
  2. Remove the `poll()` call that appends their errors into the poll result.
  3. Leave `_buildPlanContent()`, task matching, dedupe via `findPlanByClickUpTaskId()`, plan creation, and write-back logic unchanged.
- **Implementation:**

```diff
--- a/src/services/ClickUpAutomationService.ts
+++ b/src/services/ClickUpAutomationService.ts
@@
-    private async _purgeLegacyAutomationFiles(plansDir: string): Promise<void> {
-        if (!(await this._fileExists(plansDir))) {
-            return;
-        }
-
-        const entries = await fs.promises.readdir(plansDir, { withFileTypes: true });
-        for (const entry of entries) {
-            if (!entry.isFile() || !entry.name.endsWith('.md')) {
-                continue;
-            }
-
-            const filePath = path.join(plansDir, entry.name);
-            let content = '';
-            try {
-                content = await fs.promises.readFile(filePath, 'utf8');
-            } catch {
-                continue;
-            }
-
-            const isLegacyInternalPlan = /\\*\\*Internal Plan:\\*\\*\\s*true/i.test(content)
-                || /\\*\\*Pipeline ID:\\*\\*/i.test(content);
-            const isClickUpAutomationPlan = /\\*\\*ClickUp Task ID:\\*\\*/i.test(content)
-                && /\\*\\*Automation Rule:\\*\\*/i.test(content);
-            if (!isLegacyInternalPlan || !isClickUpAutomationPlan) {
-                continue;
-            }
-
-            try {
-                await fs.promises.unlink(filePath);
-            } catch (error) {
-                if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
-                    throw error;
-                }
-            }
-        }
-    }
-
-    private async _purgeLegacyAutomationExperiment(
-        db: KanbanDatabase,
-        workspaceId: string,
-        plansDir: string
-    ): Promise<string[]> {
-        const errors: string[] = [];
-        const allPlans = await db.getAllPlans(workspaceId);
-        const legacyPlans = allPlans.filter((plan) =>
-            plan.sourceType === 'clickup-automation'
-            && (plan.isInternal === true || String(plan.pipelineId || '').trim().length > 0)
-        );
-
-        for (const plan of legacyPlans) {
-            if (plan.planFile) {
-                try {
-                    const resolvedPlanFile = path.isAbsolute(plan.planFile)
-                        ? plan.planFile
-                        : path.join(this._workspaceRoot, plan.planFile);
-                    await fs.promises.unlink(resolvedPlanFile).catch((error: NodeJS.ErrnoException) => {
-                        if (error?.code !== 'ENOENT') {
-                            throw error;
-                        }
-                    });
-                } catch (error) {
-                    errors.push(`Failed to delete legacy ClickUp automation file ${plan.planFile}: ${error instanceof Error ? error.message : String(error)}`);
-                }
-            }
-
-            const deleted = await db.deletePlan(plan.sessionId);
-            if (!deleted) {
-                errors.push(`Failed to purge legacy ClickUp automation record ${plan.sessionId}.`);
-            }
-        }
-
-        try {
-            await this._purgeLegacyAutomationFiles(plansDir);
-        } catch (error) {
-            errors.push(`Failed to purge legacy ClickUp automation files: ${error instanceof Error ? error.message : String(error)}`);
-        }
-
-        return errors;
-    }
-
     public async poll(): Promise<ClickUpAutomationPollResult> {
         const result: ClickUpAutomationPollResult = {
             created: 0,
@@
         const workspaceId = await this._resolveWorkspaceId(db);
         const plansDir = await this._resolvePlansDir();
         await fs.promises.mkdir(plansDir, { recursive: true });
-        result.errors.push(...await this._purgeLegacyAutomationExperiment(db, workspaceId, plansDir));
 
         const availableLists = await this._clickUpService.listFolderLists(config.folderId).catch((error) => {
             result.errors.push(`Failed to fetch ClickUp lists: ${error instanceof Error ? error.message : String(error)}`);
             return [];
         });
```
- **Edge Cases Handled:** `plansDir` is still created and used for new automation plan files, so plan creation flow stays intact. Removing the dead purge path also removes unnecessary file deletion, which is safer for normal workspaces.

### 4. Remove the dead sync payload fields from the ClickUp sync path
#### [MODIFY] `src/services/ClickUpSyncService.ts`
- **Context:** This service’s local `KanbanPlanRecord` shape still advertises `isInternal` and `pipelineId`, even though `syncPlan()` never uses them.
- **Logic:** Remove the dead optional fields so the type matches the cleaned `KanbanDatabase`/`KanbanProvider` payload.
- **Implementation:**

```diff
--- a/src/services/ClickUpSyncService.ts
+++ b/src/services/ClickUpSyncService.ts
@@
 export interface KanbanPlanRecord {
   planId: string;
   sessionId: string;
   topic: string;
   planFile: string;
   kanbanColumn: string;
   status: string;
   complexity: string;
   tags: string;
   dependencies: string;
   createdAt: string;
   updatedAt: string;
   lastAction: string;
-  isInternal?: boolean;
-  pipelineId?: string;
   clickupTaskId?: string;
 }
```
- **Edge Cases Handled:** This is purely a type cleanup; runtime sync behavior stays unchanged because `syncPlan()` already keys off `clickupTaskId` and the mapped target column.

#### [MODIFY] `src/services/KanbanProvider.ts`
- **Context:** `_queueClickUpSync()` still forwards `plan.isInternal` and `plan.pipelineId`, so TypeScript will fail once those fields are removed from `KanbanDatabase.KanbanPlanRecord`.
- **Logic:** Remove the dead properties from the debounced sync payload and leave the rest of the sync shape untouched.
- **Implementation:**

```diff
--- a/src/services/KanbanProvider.ts
+++ b/src/services/KanbanProvider.ts
@@
         clickUp.debouncedSync(plan.sessionId, {
             planId: plan.planId,
             sessionId: plan.sessionId,
             topic: plan.topic,
             planFile: plan.planFile,
             kanbanColumn: targetColumn,
             status: plan.status,
             complexity: plan.complexity,
             tags: plan.tags,
             dependencies: plan.dependencies,
             createdAt: plan.createdAt,
             updatedAt: plan.updatedAt,
             lastAction: plan.lastAction,
-            isInternal: plan.isInternal,
-            pipelineId: plan.pipelineId,
             clickupTaskId: plan.clickupTaskId
         }, (result) => this._handleClickUpSyncResult(workspaceRoot, result));
     }
```
- **Edge Cases Handled:** The existing file-watcher-triggered sync payload earlier in `KanbanProvider.ts` already omits these fields, so this change simply makes the queue helper consistent with the already-working path.

### 5. Update the ClickUp automation integration test to validate the cleaned record shape
#### [MODIFY] `src/test/integrations/clickup/clickup-automation-service.test.js`
- **Context:** This integration test is the most direct guardrail for plan creation, import, dedupe, and write-back. It currently asserts `createdPlan.isInternal === false`, which will no longer be true because the property should disappear completely.
- **Logic:**
  1. Keep all existing assertions about `sourceType`, `clickupTaskId`, generated markdown, dedupe, and write-back.
  2. Replace the old `isInternal` assertion with absence checks for both legacy fields.
- **Implementation:**

```diff
--- a/src/test/integrations/clickup/clickup-automation-service.test.js
+++ b/src/test/integrations/clickup/clickup-automation-service.test.js
@@
             const createdPlan = await db.findPlanByClickUpTaskId(workspaceId, 'task-bug');
             assert.ok(createdPlan, 'Expected the visible automation-created plan to be persisted.');
             assert.strictEqual(createdPlan.sourceType, 'clickup-automation');
-            assert.strictEqual(createdPlan.isInternal, false);
+            assert.ok(!Object.prototype.hasOwnProperty.call(createdPlan, 'isInternal'));
+            assert.ok(!Object.prototype.hasOwnProperty.call(createdPlan, 'pipelineId'));
             assert.strictEqual(createdPlan.clickupTaskId, 'task-bug');
             assert.strictEqual(createdPlan.kanbanColumn, 'CREATED');
```
- **Edge Cases Handled:** This asserts the stronger post-cleanup contract: the dead fields are not defaulted, hidden, or silently reintroduced by the row-mapping layer.

### 6. Update the schema-sensitive completed-column regression to the post-cleanup schema
#### [MODIFY] `src/test/completed-column-status-regression.test.js`
- **Context:** This regression test extracts `UPSERT_PLAN_SQL` from `KanbanDatabase.ts`, seeds a raw `plans` table, and verifies completed-status behavior. It will fail immediately if the legacy columns remain in its seed schema or parameter lists.
- **Logic:**
  1. Remove `pipeline_id` / `is_internal` from the in-test `CREATE TABLE plans` SQL.
  2. Remove `pipelineId` / `isInternal` from all seeded record objects and from `upsertRecord()`’s parameter list.
  3. Update the completed-query regex assertion so it still enforces `status = 'completed'` without referencing the removed column.
  4. Keep the existing V10 completed-status repair assertion intact.
- **Implementation:**

```diff
--- a/src/test/completed-column-status-regression.test.js
+++ b/src/test/completed-column-status-regression.test.js
@@
 const COMPLETED_QUERY_SQL = `
     SELECT session_id, topic, kanban_column, status, updated_at
     FROM plans
-    WHERE workspace_id = ? AND status = 'completed' AND COALESCE(is_internal, 0) = 0
+    WHERE workspace_id = ? AND status = 'completed'
     ORDER BY updated_at DESC
     LIMIT ?
 `;
@@
                 brain_source_path TEXT DEFAULT '',
                 mirror_path TEXT DEFAULT '',
                 routed_to TEXT DEFAULT '',
                 dispatched_agent TEXT DEFAULT '',
                 dispatched_ide TEXT DEFAULT '',
-                pipeline_id TEXT DEFAULT '',
-                is_internal INTEGER DEFAULT 0,
                 clickup_task_id TEXT DEFAULT ''
             );
         `);
@@
             brainSourcePath: '',
             mirrorPath: '',
             routedTo: '',
             dispatchedAgent: '',
             dispatchedIde: '',
-            pipelineId: '',
-            isInternal: 0,
             clickupTaskId: ''
         });
@@
             brainSourcePath: '',
             mirrorPath: '',
             routedTo: '',
             dispatchedAgent: '',
             dispatchedIde: '',
-            pipelineId: '',
-            isInternal: 0,
             clickupTaskId: ''
         });
@@
             brainSourcePath: '',
             mirrorPath: '',
             routedTo: '',
             dispatchedAgent: '',
             dispatchedIde: '',
-            pipelineId: '',
-            isInternal: 0,
             clickupTaskId: ''
         });
@@
         record.brainSourcePath,
         record.mirrorPath,
         record.routedTo,
         record.dispatchedAgent,
         record.dispatchedIde,
-        record.pipelineId,
-        record.isInternal,
         record.clickupTaskId
     ]);
 }
@@
     await test('completed query stays strict and migration repair exists', async () => {
         assert.match(
             dbSource,
-            /WHERE workspace_id = \\? AND status = 'completed' AND COALESCE\\(is_internal, 0\\) = 0/,
+            /WHERE workspace_id = \\? AND status = 'completed'/,
             'Expected getCompletedPlans to remain strict to status=completed.'
         );
+        assert.doesNotMatch(
+            dbSource,
+            /WHERE workspace_id = \\? AND status = 'completed' AND COALESCE\\(is_internal, 0\\) = 0/,
+            'Expected completed queries to stop filtering on the removed is_internal field.'
+        );
         assert.match(
             dbSource,
             /UPDATE plans SET status = 'completed' WHERE status = 'archived' AND kanban_column = 'COMPLETED'/,
             'Expected V10 migration to repair archived completed rows.'
         );
```
- **Edge Cases Handled:** The test continues protecting its real concern — completed lifecycle correctness — while no longer encoding a schema column that this cleanup intentionally removes.

## Verification Plan
### Automated Tests
- `npm run compile`
- `npm run compile-tests`
- `node src/test/integrations/clickup/clickup-automation-service.test.js`
- `node src/test/completed-column-status-regression.test.js`
- `node src/test/integration-auto-pull-regression.test.js`
- **Clarification:** `npm run lint` currently fails at repo baseline because ESLint 9 cannot find an `eslint.config.*` file. Do not treat that baseline issue as part of this cleanup.

### Manual Verification Steps
1. Open or initialize a workspace that already has `.switchboard/kanban.db` data from before this cleanup and let the extension/database initialize normally.
2. Open the Kanban board and confirm existing active and completed plans still render after the DB migration.
3. Trigger a ClickUp automation poll against a matching task and confirm exactly one automation plan is created/imported with a `clickupTaskId` and no `pipelineId` / `isInternal` fields.
4. Move that plan to `COMPLETED`, poll again, and confirm the originating ClickUp task receives one write-back and no legacy-purge error messages appear.

## Preserved Original Draft
```markdown
# Remove ClickUp Automation Technical Debt

Remove the dormant schema fields and unnecessary poll-time cleanup that were left behind after the ClickUp automation simplification. This is cleanup for code that never shipped—there is no legacy to preserve.

## Goal

Strip out dead schema columns (`pipeline_id`, `is_internal`) and the unnecessary `_purgeLegacyHiddenPipelinePlans()` method. The simplified ClickUp automation works without these; they are pure technical debt from an abandoned implementation path.

## Proposed Changes

### 1. Database Schema Cleanup

**File:** `src/services/KanbanDatabase.ts`

- Remove `pipeline_id` and `is_internal` from:
  - `KanbanPlanRecord` interface
  - `SCHEMA_SQL` (CREATE TABLE)
  - `MIGRATION_V9_SQL` (ALTER TABLE adds)
  - `UPSERT_PLAN_SQL` (insert/update statements)
  - `PLAN_COLUMNS` constant
  - `_rowToRecord()` mapping

- Add `MIGRATION_V10_SQL` to drop the columns if they exist (SQLite `ALTER TABLE DROP COLUMN` is version-dependent; handle gracefully).

### 2. Importer Cleanup

**File:** `src/services/PlanFileImporter.ts`

- Remove `isInternal` from `KanbanPlanRecord` construction in `importPlanFiles()`.
- Remove any `pipelineId` handling if present.

### 3. Automation Service Cleanup

**File:** `src/services/ClickUpAutomationService.ts`

- Remove `_purgeLegacyHiddenPipelinePlans()` method entirely.
- Remove call to this method from `poll()`.

### 4. Regression Test Update

**File:** `src/test/integrations/clickup/clickup-automation-service.test.js`

- Assert that automation-created plans do NOT have `isInternal` or `pipelineId` fields in the returned record.

## Verification

1. `npm run compile` — passes
2. `npm run compile-tests` — passes
3. `node src/test/integrations/clickup/clickup-automation-service.test.js` — passes, no `pipeline_id`/`is_internal` references
4. `node src/test/integration-auto-pull-regression.test.js` — passes
5. Manual: Open Kanban, verify automation-created plans still display correctly (no visible change expected).

## Success Criteria

- `pipeline_id` and `is_internal` are fully absent from schema, migrations, and runtime code.
- `ClickUpAutomationService.poll()` no longer calls any cleanup method.
- All tests pass with no references to the removed fields.
- No behavioral change for users—this is pure code hygiene.

## References

- Original simplification plan: `simplify_clickup_automation.md`
- Related debt identified in: `simplify_clickup_automation.md` (Post-Implementation Review section)

## Switchboard State

**Kanban Column:** BACKLOG
**Status:** active
```

## Switchboard State

**Kanban Column:** PLAN REVIEWED
**Status:** active

## Direct Reviewer Pass (2026-04-13, In-Place Review)

### Stage 1 - Grumpy Principal Engineer
- [MAJOR] The cleanup claimed verification while `src/test/completed-column-status-regression.test.js` was still booting a pre-`linear_issue_id` schema and exploding before the actual assertions could run. A regression test that cannot survive the current UPSERT shape is not a guardrail; it is decorative plywood. Fixed.
- [NIT] The V11 table-rebuild path is still validated indirectly. Fresh-path coverage is good, but there is no dedicated legacy-schema fixture that starts with `pipeline_id` / `is_internal` present and proves the rebuild preserves rows.

### Stage 2 - Balanced Synthesis
- **Keep:** The runtime cleanup is correct. The live record/query surface no longer exposes `pipelineId` / `isInternal`, `PlanFileImporter.ts` stopped importing dead metadata, and `ClickUpAutomationService.ts` no longer performs the legacy poll-time purge dance.
- **Fix now:** Align the schema-sensitive completed-column regression with the current `KanbanDatabase` shape so the ClickUp cleanup can actually be verified. Done.
- **Defer:** Add one explicit legacy-DB migration fixture for the V11 rebuild path.

### Fixed Items
- `src/test/completed-column-status-regression.test.js` - aligned the scratch-schema fixture and UPSERT payload with the current `KanbanDatabase` shape by including `linear_issue_id`.

### Files Changed
- `src/test/completed-column-status-regression.test.js`

### Validation Results
- `npm run compile` - **PASSED**
- `npm run compile-tests` - **PASSED**
- `node src/test/completed-column-status-regression.test.js` - **PASSED**
- `node src/test/integrations/clickup/clickup-automation-service.test.js` - **PASSED**
- `node src/test/integration-auto-pull-regression.test.js` - **PASSED**

### Remaining Risks
- The V11 ClickUp legacy-column removal still lacks a dedicated migration fixture starting from an old on-disk schema.
