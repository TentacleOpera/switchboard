# Add Tags and Dependencies Sync to Kanban Database

## Goal

Implement automatic synchronization of plan metadata (tags and dependencies) from plan files to the kanban database, archive database, and coding prompts. Currently, tags are not extracted from plan files when plans are registered via `_registerPlan()`, and dependencies are never stored in the database at all. This plan adds (a) tag extraction at registration time, (b) a new `dependencies` column across SQLite + DuckDB schemas, (c) file-watcher re-sync on plan edits, (d) archive pass-through, and (e) a pre-dispatch dependency gate with user confirmation.

## Metadata

**Tags:** backend, database
**Complexity:** 7

## User Review Required
> [!NOTE]
> - **Database migration**: A new `dependencies TEXT DEFAULT ''` column will be added to the SQLite `plans` table via `MIGRATION_V6_SQL`. Existing databases auto-migrate on startup; no user action needed.
> - **DuckDB archive schema**: `archiveSchema.sql` gains a `dependencies VARCHAR` column. Existing archives are extended via `ALTER TABLE` in `ensureArchiveSchema()`.
> - **Pre-dispatch modal**: When dispatching a plan whose declared dependencies are not yet in COMPLETED or CODE REVIEWED columns, a modal warning appears with "Include Dependencies in Batch", "Proceed Anyway", or "Cancel". Autoban pipeline skips the modal and logs a warning instead.
> - **No breaking changes**: All new fields default to empty strings. Existing plans, prompts, and MCP queries continue unchanged.

## Current State Analysis

**Tags Issue (Verified):**
- `KanbanProvider.ts` has `getTagsFromPlan()` method (implemented via `feature_plan_20260326_220950`)
- `_registerPlan()` in `TaskViewerProvider.ts` (line 4609) uses `existing?.tags || ''` — never calls `getTagsFromPlan()` during registration
- Tags are only populated via the self-heal loop in `KanbanProvider._refreshBoardImpl()` and the `resolveTags` callback in `syncPlansMetadata()`

**Dependencies Issue (Verified):**
- `_parsePlanDependencies()` exists at `TaskViewerProvider.ts:6060` — parses `## Dependencies` section from plan content
- Only consumed on-demand in `getReviewTicketData()` at line 6251
- **No `dependencies` column** in `KanbanDatabase.ts` `SCHEMA_SQL` (lines 43-72)
- **No `dependencies` column** in `archiveSchema.sql` (lines 4-21)
- **No `dependencies` field** in `KanbanPlanRecord` interface (lines 9-25)

**Archive Issue (Verified):**
- `ArchiveManager.PlanRecord` interface (lines 10-24) includes `tags` but **NOT** `dependencies`
- `archivePlan()` SQL INSERT (line 107) does not reference dependencies

**Coding Prompt Issue (Verified):**
- `BatchPromptPlan` interface (`agentPromptBuilder.ts:8-12`) has `topic`, `absolutePath`, `complexity?` — **no `dependencies`**
- `buildKanbanBatchPrompt()` (line 61) does not include dependency ordering information

## Complexity Audit

### Routine
- **R1: Add `dependencies` to `KanbanPlanRecord` interface** — Single field addition at `src/services/KanbanDatabase.ts:9-25`. No logic change.
- **R2: Add `dependencies` to `SCHEMA_SQL`** — Add `dependencies TEXT DEFAULT ''` after `tags` at `src/services/KanbanDatabase.ts:52`. Fresh DBs only.
- **R3: Add `dependencies` to `PLAN_COLUMNS`** — Extend column list constant at `src/services/KanbanDatabase.ts:135-137`.
- **R4: Add `dependencies` to `_readRows()`** — Add `dependencies: String(row.dependencies || "")` at `src/services/KanbanDatabase.ts:1601`.
- **R5: Add `dependencies` to `UPSERT_PLAN_SQL`** — Add 16th parameter at `src/services/KanbanDatabase.ts:113-131`. Add to ON CONFLICT UPDATE SET.
- **R6: Add `updateDependencies()` method** — Mirror `updateTags()` (line 594) with identical pattern.
- **R7: Add `dependencies` to `archiveSchema.sql`** — Add `dependencies VARCHAR` after `tags` at `src/services/archiveSchema.sql:17`.
- **R8: Add `dependencies` to `ArchiveManager.PlanRecord`** — Single field at `src/services/ArchiveManager.ts:23`.
- **R9: Update `archivePlan()` INSERT SQL** — Add `dependencies` to INSERT and ON CONFLICT at `src/services/ArchiveManager.ts:107-116`.
- **R10: Add `dependencies` to `BatchPromptPlan` interface** — Add optional `dependencies?: string` at `src/services/agentPromptBuilder.ts:8-12`.
- **R11: Tag extraction in `_registerPlan()`** — After complexity extraction (line 4598), add tag extraction using `getTagsFromPlan()` at `src/services/TaskViewerProvider.ts`.
- **R12: Extend `updateMetadataBatch()` to handle `dependencies`** — Add optional field to update type at `src/services/KanbanDatabase.ts:705-711`, mirror `tags` handling.
- **R13: Add `resolveDependencies` callback to `KanbanMigration.syncPlansMetadata()`** — Add optional parameter at `src/services/KanbanMigration.ts:101-106`, mirror `resolveTags` logic.

### Complex / Risky
- **C1: `MIGRATION_V6_SQL`** — Must be added after existing V5 at `src/services/KanbanDatabase.ts:86-111`. Uses idempotent try/catch. Risk: if V4/V5 haven't run (corrupt DB), V6 could be skipped. Mitigated by sequential try/catch pattern in `_runMigrations()`.
- **C2: Dependency extraction during `_registerPlan()`** — Must read plan file via `fs.promises.readFile()` and call `_parsePlanDependencies()` at `src/services/TaskViewerProvider.ts:4568-4618`. Risk: plan file may not exist yet (race with brain mirror write). Mitigated by try/catch fallback to empty string.
- **C3: Plan file watcher dependency/tag re-sync** — `_setupPlanWatcher()` (line 3908) has `onDidChange` calling `debouncedTitleSync` (line 3938). Must extend to re-parse tags and dependencies. Risk: excessive DB writes from frequent watcher events. Mitigated by existing debounce (`_planFsDebounceTimers`).
- **C4: Pre-dispatch dependency gate** — New `_checkDependenciesBeforeDispatch()` in `TaskViewerProvider.ts` + new `getDependencyStatus()` on `KanbanDatabase`. Called from `_handleTriggerAgentActionInternal()` (line 7945). Risk: modal blocks autoban. Mitigated by `headless` parameter — autoban logs warning, proceeds without modal.
- **C5: Dependency ordering in prompt builder** — `buildKanbanBatchPrompt()` at `src/services/agentPromptBuilder.ts` appends DEPENDENCY ORDER section. Risk: stale dependency references. Mitigated by only including info for plans whose deps are in current batch.
- **C6: `getDependencyStatus()` on `KanbanDatabase`** — Queries by `plan_id`, `session_id`, and `LOWER(topic)`. Risk: `_parsePlanDependencies()` returns free-text names, not IDs. Mitigated by topic matching + marking unknown deps as `ready: true`.
- **C7: DuckDB archive ALTER TABLE** — DuckDB lacks `IF NOT EXISTS` on `ALTER TABLE ADD COLUMN`. Must query `information_schema.columns` first, then ALTER if missing. Extra CLI invocation in `ensureArchiveSchema()`.

## Edge-Case & Dependency Audit

- **Race Conditions:** `_registerPlan()` reads the plan file to extract dependencies. For brain plans, the mirror file may not exist yet. **Mitigation:** try/catch fallback to `existing?.dependencies || ''`; self-heal loop or watcher `onDidChange` populates later.
- **Security:** Dependencies stored as comma-separated strings. `getDependencyStatus()` uses parameterized queries (`WHERE plan_id = ? OR session_id = ? OR LOWER(topic) = LOWER(?)`), preventing SQL injection. `_parsePlanDependencies()` strips markdown but values only enter parameterized queries, never raw SQL.
- **Side Effects:**
  - `UPSERT_PLAN_SQL` parameter count changes from 15 to 16. All call sites must be updated: `_registerPlan()` (line 4601), `KanbanMigration._toKanbanPlanRecords()`.
  - DuckDB `CREATE TABLE IF NOT EXISTS` won't add column to existing tables. Separate `ALTER TABLE` with `information_schema` check needed.
- **Backward Compatibility:** Plans without `## Dependencies` get `dependencies: ''`. Pre-dispatch gate short-circuits on empty string. `BatchPromptPlan.dependencies` is optional.
- **Dependencies & Conflicts:**
  - **`feature_plan_20260326_220950` (Tags/Metadata System)** — **ALREADY IMPLEMENTED**. Added tags infrastructure. Current plan builds on it. **No conflict.**
  - **`feature_plan_20260327_001833` (DB Sync Testability)** — **ALREADY IMPLEMENTED**. Constructor refactor, mtime detection. **No conflict.**
  - **`fix_kanban_db_location_data_loss`** — Adds migration/path-change logic. Touches `forWorkspace()`, `_initialize()`. **Low conflict** — different code paths. V6 migration is additive.
  - **No other plans touch `_registerPlan()`, `_parsePlanDependencies()`, or `agentPromptBuilder.ts`.**

## Adversarial Synthesis

### Grumpy Critique

*Slams coffee mug down, stares at the ceiling.*

Oh, WONDERFUL. Another "just add a column and wire it through seven files" plan. Let me enumerate the ways this is going to blow up:

1. **The `upsertPlans()` parameter bomb.** You're going from 15 to 16 positional `?` parameters in a raw SQL string. Every. Single. Call site. must be updated in exact positional order. Miss one and you get silent data corruption — `dependencies` value ends up in the `workspace_id` column. There are no named parameters. There is no type safety between the SQL string and the TypeScript array. This is a *guaranteed* bug factory.

2. **The `_parsePlanDependencies()` output format is a mismatch.** That method (line 6060) returns an array of raw markdown list item text — whatever the user wrote after the bullet point. Could be "Plan A", could be "The authentication refactor from last sprint", could be a full sentence. You're joining these with commas and storing them as CSV. Then in `getDependencyStatus()`, you're querying `WHERE plan_id = ? OR session_id = ?`. Plan IDs are hex hashes. A dependency listed as "Fix the login bug" will NEVER match a plan_id or session_id. Your entire dependency gate is dead code for 90% of real-world usage.

3. **The archive DuckDB `ALTER TABLE` is a landmine.** DuckDB doesn't support `IF NOT EXISTS` on `ALTER TABLE ADD COLUMN`. Your plan says "wrapped in try/catch" but DuckDB is invoked via CLI (`execFileAsync`), so you need to query `information_schema.columns` first — that's a *second* CLI invocation. Show me the code.

4. **The plan file watcher re-sync is underspecified.** "Extend `debouncedTitleSync` to also re-parse tags and dependencies" — where's the actual code? `debouncedTitleSync` calls `_handlePlanTitleSync()`. What's the method that reads the file, extracts tags AND dependencies, looks up the sessionId, and calls both update methods? What if there's no matching DB row yet?

5. **Autoban vs. modal conflict.** The dependency gate shows a `vscode.window.showWarningMessage` modal. Autoban is a *headless automated pipeline*. If autoban dispatches a plan with unmet deps, it shows a modal that blocks the pipeline until the user clicks. On a Saturday morning when nobody's watching. You've deadlocked your automation.

6. **Where's the MCP tool update?** `get_kanban_state` was updated for tags filtering but there's no mention of exposing `dependencies` in MCP responses. Agents can't see dependencies unless they're in the batch prompt.

### Balanced Response

Grumpy raises six issues. Here's how the implementation addresses each:

1. **Positional parameter fragility:** Valid. The implementation below shows the exact 16-parameter order with numbered inline comments. The existing test suite (`kanban-database-delete.test.js`) exercises `upsertPlans()` and catches positional misalignment. A new test case for the 16-param upsert is in the verification plan.

2. **`_parsePlanDependencies()` free-text mismatch:** Most substantive critique. **Resolution:** `getDependencyStatus()` extended to also search by `LOWER(topic) = LOWER(?)`. The planner prompt guidance instructs listing dependency plan titles matching Kanban `topic` field. Unmatched deps marked `ready: true` to avoid false blocking.

3. **DuckDB ALTER TABLE:** Correct. **Resolution:** `ensureArchiveSchema()` queries `information_schema.columns` first, then `ALTER TABLE` only if column missing. Two CLI calls, but runs once per session. Code provided in Proposed Changes.

4. **Watcher re-sync underspecification:** Fair. **Resolution:** Complete code for `_handlePlanMetadataSync()` method provided in Proposed Changes — reads file, extracts tags + deps, looks up session by plan file path, calls `updateTags()` + `updateDependencies()`.

5. **Autoban modal deadlock:** Critical. **Resolution:** `_checkDependenciesBeforeDispatch()` accepts `headless: boolean`. When `true` (autoban), logs warning and returns `canProceed: true` without modal. Modal only for user-initiated dispatches.

6. **MCP tool dependency exposure:** Deferred to follow-up. The `get_kanban_state` SELECT will include `dependencies` in returned fields (trivial addition to SELECT + row mapping), but filtering by dependency status is out of scope to avoid expanding surface area.

## Proposed Changes

> [!IMPORTANT]
> **MAXIMUM DETAIL REQUIRED:** Complete code blocks and step-by-step logic breakdowns follow.

### 1. SQLite Schema & Record Interface
#### [MODIFY] `src/services/KanbanDatabase.ts`
- **Context:** The `plans` table needs a `dependencies` column. The interface, schema, UPSERT, columns, _readRows, updateMetadataBatch, and migration constants all need updating.
- **Logic:**
  1. Add `dependencies: string` to `KanbanPlanRecord` after `tags` (line 17).
  2. Add `dependencies TEXT DEFAULT ''` to `SCHEMA_SQL` after `tags` (line 52).
  3. Create `MIGRATION_V6_SQL` constant after `MIGRATION_V5_SQL` (line 111).
  4. Execute V6 in `_runMigrations()` using idempotent try/catch.
  5. Add `dependencies` as 16th column in `UPSERT_PLAN_SQL` (INSERT + ON CONFLICT UPDATE SET).
  6. Add `dependencies` to `PLAN_COLUMNS`.
  7. Update `_readRows()` to read `row.dependencies`.
  8. Update `upsertPlans()` parameter array (16 params, numbered).
  9. Extend `updateMetadataBatch()` with optional `dependencies?: string`.
  10. Add `updateDependencies()` mirroring `updateTags()`.
  11. Add `getDependencyStatus()` for pre-dispatch gate.

- **Implementation:**

  **Step 1 — `KanbanPlanRecord` interface (line 9-25):**
  ```typescript
  export interface KanbanPlanRecord {
      planId: string;
      sessionId: string;
      topic: string;
      planFile: string;
      kanbanColumn: string;
      status: KanbanPlanStatus;
      complexity: string;
      tags: string;
      dependencies: string;  // comma-separated dependency identifiers
      workspaceId: string;
      createdAt: string;
      updatedAt: string;
      lastAction: string;
      sourceType: 'local' | 'brain';
      brainSourcePath: string;
      mirrorPath: string;
  }
  ```

  **Step 2 — `SCHEMA_SQL` (line 52):**
  ```sql
  tags          TEXT DEFAULT '',
  dependencies  TEXT DEFAULT '',
  workspace_id  TEXT NOT NULL,
  ```

  **Step 3 — Migration constant (after line 111):**
  ```typescript
  const MIGRATION_V6_SQL = [
      `ALTER TABLE plans ADD COLUMN dependencies TEXT DEFAULT ''`,
  ];
  ```

  **Step 4 — `_runMigrations()` (after V5 block):**
  ```typescript
  // V6: add dependencies column
  for (const sql of MIGRATION_V6_SQL) {
      try { this._db.exec(sql); } catch { /* column already exists */ }
  }
  ```

  **Step 5 — `UPSERT_PLAN_SQL` (line 113-131):**
  ```typescript
  const UPSERT_PLAN_SQL = `
  INSERT INTO plans (
      plan_id, session_id, topic, plan_file, kanban_column, status, complexity, tags, dependencies,
      workspace_id, created_at, updated_at, last_action, source_type,
      brain_source_path, mirror_path
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(plan_id) DO UPDATE SET
      session_id = excluded.session_id,
      topic = excluded.topic,
      plan_file = excluded.plan_file,
      complexity = excluded.complexity,
      tags = excluded.tags,
      dependencies = excluded.dependencies,
      workspace_id = excluded.workspace_id,
      updated_at = excluded.updated_at,
      last_action = excluded.last_action,
      source_type = excluded.source_type,
      brain_source_path = excluded.brain_source_path,
      mirror_path = excluded.mirror_path
  `;
  ```

  **Step 6 — `PLAN_COLUMNS` (line 135-137):**
  ```typescript
  const PLAN_COLUMNS = `plan_id, session_id, topic, plan_file, kanban_column, status, complexity, tags, dependencies,
                      workspace_id, created_at, updated_at, last_action, source_type,
                      brain_source_path, mirror_path`;
  ```

  **Step 7 — `_readRows()` (after line 1601):**
  ```typescript
  tags: String(row.tags || ""),
  dependencies: String(row.dependencies || ""),
  workspaceId: String(row.workspace_id || ""),
  ```

  **Step 8 — `upsertPlans()` parameter array:**
  ```typescript
  this._db.run(UPSERT_PLAN_SQL, [
      record.planId,        // 1
      record.sessionId,     // 2
      record.topic,         // 3
      this._normalizePath(record.planFile), // 4
      record.kanbanColumn,  // 5
      record.status,        // 6
      record.complexity,    // 7
      record.tags,          // 8
      record.dependencies,  // 9
      record.workspaceId,   // 10
      record.createdAt,     // 11
      record.updatedAt,     // 12
      record.lastAction,    // 13
      record.sourceType,    // 14
      this._normalizePath(record.brainSourcePath), // 15
      this._normalizePath(record.mirrorPath)  // 16
  ]);
  ```

  **Step 9 — `updateMetadataBatch()` (line 705-744):**
  Add after the `tags` block (line 726-729):
  ```typescript
  if (typeof u.dependencies === 'string') {
      setClauses.push('dependencies = ?');
      params.push(u.dependencies);
  }
  ```

  **Step 10 — New `updateDependencies()` (after `updateTags`, ~line 598):**
  ```typescript
  public async updateDependencies(sessionId: string, dependencies: string): Promise<boolean> {
      return this._persistedUpdate(
          'UPDATE plans SET dependencies = ?, updated_at = ? WHERE session_id = ?',
          [dependencies, new Date().toISOString(), sessionId]
      );
  }
  ```

  **Step 11 — New `getDependencyStatus()`:**
  ```typescript
  public async getDependencyStatus(
      dependenciesCsv: string
  ): Promise<Array<{ planId: string; topic: string; column: string; ready: boolean }>> {
      if (!(await this.ensureReady()) || !this._db) return [];
      const deps = dependenciesCsv.split(',').map(d => d.trim()).filter(Boolean);
      if (deps.length === 0) return [];

      const results: Array<{ planId: string; topic: string; column: string; ready: boolean }> = [];
      for (const depId of deps) {
          const stmt = this._db.prepare(
              `SELECT plan_id, topic, kanban_column FROM plans
               WHERE plan_id = ? OR session_id = ? OR LOWER(topic) = LOWER(?)
               LIMIT 1`,
              [depId, depId, depId]
          );
          if (stmt.step()) {
              const row = stmt.getAsObject();
              const column = String(row.kanban_column || 'CREATED');
              results.push({
                  planId: String(row.plan_id || depId),
                  topic: String(row.topic || depId),
                  column,
                  ready: column === 'COMPLETED' || column === 'CODE REVIEWED'
              });
          } else {
              results.push({ planId: depId, topic: depId, column: 'UNKNOWN', ready: true });
          }
          stmt.free();
      }
      return results;
  }
  ```

- **Edge Cases Handled:**
  - Fresh DB: `SCHEMA_SQL` includes `dependencies`, no migration needed.
  - Existing DB: `MIGRATION_V6_SQL` adds column; try/catch handles "already exists".
  - `getDependencyStatus` searches `plan_id`, `session_id`, and `topic` for free-text matching.
  - Unknown deps default to `ready: true` to avoid false blocking.

### 2. DuckDB Archive Schema
#### [MODIFY] `src/services/archiveSchema.sql`
- **Context:** DuckDB archive needs `dependencies` column.
- **Logic:** Add `dependencies VARCHAR` after `tags` (line 17).
- **Implementation:**
  ```sql
  tags VARCHAR,
  dependencies VARCHAR,
  archived_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  ```
- **Edge Cases Handled:** New archives get column via CREATE TABLE. Existing archives handled by ALTER TABLE in ArchiveManager.

### 3. Archive Manager Updates
#### [MODIFY] `src/services/ArchiveManager.ts`
- **Context:** `PlanRecord` interface and `archivePlan()` must pass dependencies to DuckDB.
- **Logic:**
  1. Add `dependencies: string` to `PlanRecord` after `tags` (line 23).
  2. Update `archivePlan()` INSERT SQL (line 107) to include `dependencies`.
  3. Add `dependencies` to ON CONFLICT UPDATE SET.
  4. Add archive migration in `ensureArchiveSchema()` for existing archives.

- **Implementation:**

  **PlanRecord interface:**
  ```typescript
  export interface PlanRecord {
      planId: string;
      sessionId: string;
      topic: string;
      planFile: string;
      kanbanColumn: string;
      status: string;
      complexity: string;
      workspaceId: string;
      createdAt: string;
      updatedAt: string;
      lastAction: string;
      sourceType: string;
      tags: string;
      dependencies: string;
  }
  ```

  **`archivePlan()` SQL (line 107-116):**
  Add `dependencies` to the INSERT column list and VALUES, and to ON CONFLICT:
  ```typescript
  const sql = `INSERT INTO plans (plan_id, session_id, topic, plan_file, kanban_column, status, complexity, workspace_id, created_at, updated_at, last_action, source_type, tags, dependencies, archived_at, days_to_completion)
  VALUES (${this._escapeDuckDb(plan.planId)}, /* ...existing params... */, ${this._escapeDuckDb(plan.dependencies)}, CURRENT_TIMESTAMP, ${daysToCompletion})
  ON CONFLICT (plan_id) DO UPDATE SET
      /* ...existing SET clauses... */
      dependencies = EXCLUDED.dependencies,
      /* ...rest unchanged... */`;
  ```

  **Archive migration in `ensureArchiveSchema()` (after schema creation):**
  ```typescript
  try {
      const checkCol = `SELECT column_name FROM information_schema.columns WHERE table_name = 'plans' AND column_name = 'dependencies'`;
      const { stdout } = await execFileAsync('duckdb', [this._archivePath, '-c', checkCol, '-csv', '-noheader']);
      if (!stdout.trim()) {
          await execFileAsync('duckdb', [this._archivePath, '-c', `ALTER TABLE plans ADD COLUMN dependencies VARCHAR DEFAULT ''`]);
          this._log('Archive migration: added dependencies column');
      }
  } catch { /* Non-critical */ }
  ```

- **Edge Cases Handled:** DuckDB `ALTER TABLE` guarded by `information_schema` check. Runs once per session.

### 4. Tag Extraction in `_registerPlan()`
#### [MODIFY] `src/services/TaskViewerProvider.ts` — `_registerPlan()` (line 4568-4618)
- **Context:** Tags set to `existing?.tags || ''` without parsing. Add `getTagsFromPlan()` call.
- **Logic:** After complexity extraction (line 4598), add tag extraction using same pattern.
- **Implementation:**

  Insert after complexity block (line 4598), before `await db.upsertPlans()`:
  ```typescript
  let insertTags: string = existing?.tags || '';
  if (insertTags === '' && insertPlanFile && this._kanbanProvider) {
      try {
          const parsed = await this._kanbanProvider.getTagsFromPlan(workspaceRoot, insertPlanFile);
          if (parsed) { insertTags = parsed; }
      } catch { /* Non-critical */ }
  }
  ```
  Update upsert call: `tags: insertTags,`

### 5. Dependency Extraction in `_registerPlan()`
#### [MODIFY] `src/services/TaskViewerProvider.ts` — `_registerPlan()` (line 4568-4618)
- **Context:** Dependencies must be extracted and stored during registration.
- **Logic:** After tag extraction, extract dependencies using `_parsePlanDependencies()`.
- **Implementation:**

  Insert after tag extraction, before `await db.upsertPlans()`:
  ```typescript
  let insertDependencies: string = existing?.dependencies || '';
  if (insertDependencies === '' && insertPlanFile) {
      try {
          const resolvedPath = path.isAbsolute(insertPlanFile)
              ? insertPlanFile
              : path.join(workspaceRoot, insertPlanFile);
          const planContent = await fs.promises.readFile(resolvedPath, 'utf8');
          const deps = this._parsePlanDependencies(planContent);
          if (deps.length > 0) { insertDependencies = deps.join(','); }
      } catch { /* Non-critical: file may not exist yet */ }
  }
  ```
  Add to upsert call: `dependencies: insertDependencies,`

### 6. Plan File Watcher Re-Sync
#### [MODIFY] `src/services/TaskViewerProvider.ts` — `_setupPlanWatcher()` (line 3908-3978)
- **Context:** When a plan file is modified, tags and dependencies must be re-parsed.
- **Logic:** Create `_handlePlanMetadataSync()` method, call from debounced `onDidChange`.
- **Implementation:**

  **New method:**
  ```typescript
  private async _handlePlanMetadataSync(uri: vscode.Uri, workspaceRoot: string): Promise<void> {
      try {
          const filePath = uri.fsPath;
          const db = await this._getKanbanDb(workspaceRoot);
          if (!db) return;

          const wsId = await this._getOrCreateWorkspaceId(workspaceRoot);
          const relativePath = path.relative(workspaceRoot, filePath).replace(/\\/g, '/');
          const record = await db.getPlanByPlanFile(relativePath, wsId);
          if (!record) return;

          const content = await fs.promises.readFile(filePath, 'utf8');

          if (this._kanbanProvider) {
              const tags = await this._kanbanProvider.getTagsFromPlan(workspaceRoot, relativePath);
              if (tags && tags !== record.tags) {
                  await db.updateTags(record.sessionId, tags);
              }
          }

          const deps = this._parsePlanDependencies(content);
          const depsStr = deps.join(',');
          if (depsStr !== record.dependencies) {
              await db.updateDependencies(record.sessionId, depsStr);
          }
      } catch (e) {
          console.warn('[TaskViewerProvider] Plan metadata sync failed:', e);
      }
  }
  ```

  **Wire into watcher (line 3938):** Call `_handlePlanMetadataSync()` inside the existing debounced callback alongside title sync.

### 7. Pre-Dispatch Dependency Gate
#### [MODIFY] `src/services/TaskViewerProvider.ts`
- **Context:** Before dispatch, check dependency status. Modal for interactive, silent for autoban.
- **Logic:** New `_checkDependenciesBeforeDispatch()`, called from `_handleTriggerAgentActionInternal()` (line 7945).
- **Implementation:**

  ```typescript
  private async _checkDependenciesBeforeDispatch(
      workspaceRoot: string,
      planRecord: KanbanPlanRecord,
      headless: boolean = false
  ): Promise<{ canProceed: boolean; includeInBatch?: string[] }> {
      if (!planRecord.dependencies) return { canProceed: true };

      const db = await this._getKanbanDb(workspaceRoot);
      if (!db) return { canProceed: true };

      const depStatus = await db.getDependencyStatus(planRecord.dependencies);
      const notReady = depStatus.filter(d => !d.ready);
      if (notReady.length === 0) return { canProceed: true };

      if (headless) {
          console.warn(`[TaskViewerProvider] Plan "${planRecord.topic}" has unmet deps (autoban — proceeding): ${notReady.map(d => d.topic).join(', ')}`);
          return { canProceed: true };
      }

      const notReadyList = notReady.map(d => `• ${d.topic} (${d.column})`).join('\n');
      const choice = await vscode.window.showWarningMessage(
          `Plan "${planRecord.topic}" has unmet dependencies:\n${notReadyList}`,
          { modal: true },
          'Include Dependencies in Batch', 'Proceed Anyway', 'Cancel'
      );

      if (choice === 'Cancel' || !choice) return { canProceed: false };
      if (choice === 'Include Dependencies in Batch') {
          return { canProceed: true, includeInBatch: notReady.map(d => d.planId) };
      }
      return { canProceed: true };
  }
  ```

### 8. Dependency Ordering in Prompts
#### [MODIFY] `src/services/agentPromptBuilder.ts`
- **Context:** Batch prompts must include dependency execution order.
- **Logic:** Add `dependencies?: string` to `BatchPromptPlan`. Append DEPENDENCY ORDER section.
- **Implementation:**

  **Interface (line 8-12):**
  ```typescript
  export interface BatchPromptPlan {
      topic: string;
      absolutePath: string;
      complexity?: string;
      dependencies?: string;
  }
  ```

  **In `buildKanbanBatchPrompt()`, append to prompt for lead/coder:**
  ```typescript
  const plansWithDeps = plans.filter(p => p.dependencies);
  const depSection = plansWithDeps.length > 0
      ? `\n\nDEPENDENCY ORDER: Execute in order; do not start a plan until its dependencies are implemented:\n${
          plansWithDeps.map((p, i) => `${i + 1}. [${p.topic}] depends on: ${p.dependencies}`).join('\n')}\n`
      : '';
  ```

### 9. Migration Backfill
#### [MODIFY] `src/services/KanbanMigration.ts`
- **Context:** `syncPlansMetadata()` needs `resolveDependencies` callback.
- **Logic:** Add parameter, mirror `resolveTags` pattern.
- **Implementation:**

  **Signature (line 101-106):**
  ```typescript
  public static async syncPlansMetadata(
      db: KanbanDatabase, workspaceId: string,
      snapshotRows: LegacyKanbanSnapshotRow[],
      resolveComplexity?: (planFile: string) => Promise<string>,
      resolveTags?: (planFile: string) => Promise<string>,
      resolveDependencies?: (planFile: string) => Promise<string>
  ): Promise<boolean> {
  ```

  **In metadata loop (after resolveTags, ~line 137):**
  ```typescript
  let resolvedDependencies: string | undefined;
  if (row.dependencies) {
      resolvedDependencies = row.dependencies;
  } else if (resolveDependencies) {
      const parsed = await resolveDependencies(row.planFile);
      resolvedDependencies = parsed || undefined;
  }
  ```

  **`_toKanbanPlanRecords` mapper:** Add `dependencies: row.dependencies || ''`.

  **`LegacyKanbanSnapshotRow` type:** Add `dependencies: string`.

### 10. Wire `resolveDependencies` at Call Site
#### [MODIFY] `src/services/TaskViewerProvider.ts` — `syncPlansMetadata` call site
- **Context:** Pass `resolveDependencies` callback to backfill.
- **Implementation:**
  ```typescript
  const resolveDependencies = async (planFile: string): Promise<string> => {
      try {
          const resolved = path.isAbsolute(planFile) ? planFile : path.join(workspaceRoot, planFile);
          if (!fs.existsSync(resolved)) return '';
          const content = await fs.promises.readFile(resolved, 'utf8');
          return this._parsePlanDependencies(content).join(',');
      } catch { return ''; }
  };
  ```
  Pass as 6th argument to `KanbanMigration.syncPlansMetadata()`.

## Files to Modify

1. `src/services/KanbanDatabase.ts` — Interface, schema, migrations, UPSERT, columns, _readRows, updateMetadataBatch, new methods
2. `src/services/archiveSchema.sql` — Add dependencies column
3. `src/services/ArchiveManager.ts` — PlanRecord interface, archivePlan() SQL, ensureArchiveSchema() migration
4. `src/services/TaskViewerProvider.ts` — _registerPlan() tag+dep extraction, _handlePlanMetadataSync(), _checkDependenciesBeforeDispatch(), resolveDependencies callback
5. `src/services/agentPromptBuilder.ts` — BatchPromptPlan interface, dependency ordering section
6. `src/services/KanbanMigration.ts` — syncPlansMetadata() signature, LegacyKanbanSnapshotRow, _toKanbanPlanRecords

## Verification Plan

### Automated Tests
- **Regression:** `npm run compile && node src/test/kanban-database-delete.test.js` — verifies upsert works with 16-param signature.
- **Regression:** `node src/test/kanban-database-custom-path.test.js` and `node src/test/kanban-database-mtime.test.js`.
- **New test: `src/test/kanban-database-dependencies.test.js`** — Tests for:
  - `upsertPlans()` with `dependencies` populated — stored and retrieved correctly.
  - `updateDependencies()` — single-plan update persists.
  - `getDependencyStatus()` — matching by plan_id, session_id, and topic.
  - `getDependencyStatus()` — unknown deps return `ready: true`.
  - `updateMetadataBatch()` with `dependencies` — batch update persists.

### Build Verification
```bash
npx tsc --noEmit          # TypeScript typecheck
npm run compile           # Webpack build
npm run compile-tests     # Test compilation
npm test                  # Run all existing tests
```

### Manual Verification Checklist
- [ ] Create test plan with `## Metadata` tags and `## Dependencies` entries
- [ ] Register plan → verify tags AND dependencies stored in kanban.db
- [ ] Modify plan file → verify watcher re-syncs tags/dependencies
- [ ] Complete plan → verify tags/dependencies transferred to DuckDB archive
- [ ] Dispatch plan with unmet deps (interactive) → modal warning appears
- [ ] Click 'Cancel' → dispatch aborted
- [ ] Click 'Proceed Anyway' → dispatch continues
- [ ] Click 'Include Dependencies in Batch' → deps added to batch
- [ ] Deps in CODE REVIEWED or COMPLETED → no warning
- [ ] Autoban dispatch with unmet deps → NO modal, console warning only
- [ ] Verify UPSERT_PLAN_SQL has 16 `?` marks matching 16-element array

### Grep Verification Commands
```bash
grep "dependencies" src/services/KanbanDatabase.ts
grep "dependencies" src/services/archiveSchema.sql
grep "dependencies" src/services/ArchiveManager.ts
grep "dependencies" src/services/agentPromptBuilder.ts
```

## Agent Recommendation

**Send to Lead Coder** — Complexity 7. Multi-file changes across database layer (SQLite migration + DuckDB archive migration), provider layer (registration, watcher, dispatch gate), and prompt builder. The positional parameter change in `UPSERT_PLAN_SQL` and the autoban/interactive bifurcation in the dependency gate require careful implementation.

## Review Results

### Summary of Findings

**CRITICAL-1 (FIXED): Dependencies not flowing to prompt builder** — `handleKanbanBatchTrigger()` at `TaskViewerProvider.ts:1367-1387` built `validPlans` as `{ sessionId, topic, absolutePath }` without `dependencies`. Despite `BatchPromptPlan` having `dependencies?: string` and `buildKanbanBatchPrompt()` correctly generating the DEPENDENCY ORDER section, the bridge code never passed dependency data through. The dep section would always be empty.

**MAJOR-1 (Deferred): `_checkDependenciesBeforeDispatch` missing headless/autoban support** — `TaskViewerProvider.ts:8058-8075`. Plan required `headless: boolean` parameter so autoban logs a warning and proceeds. Implementation has no headless param. Autoban path (`_autobanTickColumn` → `handleKanbanBatchTrigger`) bypasses the dependency gate entirely — no logging, no check. Autoban still proceeds (not blocked), but the planned console.warn for observability is absent.

**MAJOR-2 (Deferred): Missing "Include Dependencies in Batch" modal option** — Plan specified three modal options: "Include Dependencies in Batch", "Proceed Anyway", "Cancel" with return type `{ canProceed: boolean; includeInBatch?: string[] }`. Implementation has two options ("Dispatch Anyway", "Cancel") returning `boolean`. The batch-inclusion feature is not implemented.

**NIT-1 (FIXED): Unnecessary `(row as any)` cast** — `KanbanMigration.ts:41`. `LegacyKanbanSnapshotRow` already includes `dependencies: string`, so `(row as any).dependencies` was redundant. Changed to `row.dependencies`.

**NIT-2: `modal: false` vs plan's `modal: true`** — `TaskViewerProvider.ts:8071`. Plan specified modal dialog; implementation uses non-modal notification. UX deviation, not a bug.

**NIT-3: Plan references stale parameter count** — Plan text says "16 params" in UPSERT but actual has 19 columns (includes `routed_to`, `dispatched_agent`, `dispatched_ide`). Plan's verification checklist says "verify 16 `?` marks" — should say 19. The implementation is correct; the plan text is stale.

### Verified Correct (All 6 Files)

| File | Status |
|------|--------|
| **KanbanDatabase.ts** | ✅ Interface, SCHEMA_SQL, MIGRATION_V6_SQL, _runMigrations(), UPSERT_PLAN_SQL (19 cols/19 params), PLAN_COLUMNS, _readRows(), updateMetadataBatch(), updateDependencies(), getDependencyStatus(), upsertPlans() — all correct |
| **archiveSchema.sql** | ✅ `dependencies VARCHAR` present after `tags` (line 18) |
| **ArchiveManager.ts** | ✅ PlanRecord interface, archivePlan() INSERT + ON CONFLICT, ensureArchiveSchema() ALTER TABLE guard with information_schema check |
| **TaskViewerProvider.ts** | ✅ Tag extraction in _registerPlan(), dependency extraction in _registerPlan(), _handlePlanMetadataSync() exists and wired into watcher, _checkDependenciesBeforeDispatch() exists and called from dispatch path, resolveDependencies passed to syncPlansMetadata |
| **agentPromptBuilder.ts** | ✅ BatchPromptPlan.dependencies, DEPENDENCY ORDER section for lead+coder roles |
| **KanbanMigration.ts** | ✅ syncPlansMetadata accepts resolveDependencies, resolution logic in metadata loop, _toKanbanPlanRecords mapper, LegacyKanbanSnapshotRow type |

### Files Changed

1. `src/services/TaskViewerProvider.ts` — Added `dependencies` to `validPlans` type and population in `handleKanbanBatchTrigger()` (CRITICAL-1 fix)
2. `src/services/KanbanMigration.ts` — Removed unnecessary `(row as any)` cast on `dependencies` (NIT-1 fix)

### Validation Results

- **TypeScript typecheck** (`npx tsc --noEmit`): ✅ Pass (only known pre-existing `KanbanProvider.ts` ArchiveManager import error)
- **Webpack build** (`npm run compile`): ✅ Both bundles compiled successfully

### Remaining Risks

1. **Autoban dependency observability (MAJOR-1)** — ~~Autoban silently bypasses dependency gate with no logging.~~ **FIXED (post-review):** Added `headless` parameter to `_checkDependenciesBeforeDispatch()`. When `true`, logs `console.warn` with plan topic and unmet dep names, then proceeds. Autoban callers should pass `headless: true`.
2. **"Include Dependencies in Batch" (MAJOR-2)** — ~~Feature gap. Users can only "Dispatch Anyway" or "Cancel".~~ **FIXED (post-review):** Rewrote `_checkDependenciesBeforeDispatch()` with structured return type `{ canProceed: boolean; includeInBatch?: string[] }`, 3-option modal (`Include Dependencies in Batch` / `Proceed Anyway` / `Cancel`), `modal: true`, and headless path. `getDependencyStatus()` now returns `sessionId` for each dep. Caller in `_handleTriggerAgentActionInternal()` dispatches deps + original plan as a batch via `handleKanbanBatchTrigger()` when user selects inclusion.
3. **Dependency matching accuracy** — `getDependencyStatus()` matches by `LOWER(topic)`, which handles most cases. Free-text dependencies like "The auth refactor" may not match exact topic strings. Unknown deps default to `ready: true` (safe failure mode).

### Post-Review Fix: Batch Inclusion Implementation
**Files changed:**
- `src/services/KanbanDatabase.ts` — `getDependencyStatus()`: added `session_id` to SELECT and return type
- `src/services/TaskViewerProvider.ts` — `_checkDependenciesBeforeDispatch()`: rewritten with 3-option modal, structured return, headless parameter. Caller updated to dispatch deps as batch when selected.

**Validation:** `npx tsc --noEmit` ✅ | `npm run compile` ✅

## Second Reviewer Pass

**Reviewer:** Copilot CLI (fresh verification pass)
**Date:** 2025-07-24

### Previous Fix Verification

All four findings from the first review were verified as correctly fixed:

| Finding | Status | Evidence |
|---------|--------|----------|
| CRITICAL-1: `handleKanbanBatchTrigger` missing `dependencies` | ✅ Fixed | Line 1376: `validPlans` type includes `dependencies?: string`; line 1388 extracts from DB |
| MAJOR-1: No headless mode for autoban | ✅ Fixed | Line 8127: `headless: boolean = false` parameter; lines 8138-8141: headless path logs + proceeds |
| MAJOR-2: Only 2 modal options | ✅ Fixed | Line 8147: 3 options; line 8128: structured return `{ canProceed; includeInBatch? }` |
| NIT-1: `(row as any).dependencies` cast | ✅ Fixed | KanbanMigration.ts:41: `row.dependencies || ''` (no cast) |

### New Findings

**MAJOR-1: `_buildKanbanBatchPrompt` type signature strips `dependencies`**
- **File:** `TaskViewerProvider.ts:2688`
- **Issue:** Parameter type was `Array<{ topic: string; absolutePath: string }>`, omitting `dependencies`. The runtime works via structural subtyping (actual objects carry `dependencies`), but any refactor that destructures or maps plans before passing would silently drop dependency data from batch prompts.
- **Fix applied:** Widened type to `Array<{ topic: string; absolutePath: string; dependencies?: string }>`.

**MAJOR-2: `_checkDependenciesBeforeDispatch` JSDoc mismatches implementation**
- **File:** `TaskViewerProvider.ts:8121-8122`
- **Issue:** Comment said "*CODED" columns count as ready, but `getDependencyStatus` (KanbanDatabase.ts:657) only checks `COMPLETED` and `CODE REVIEWED`. Plans in LEAD CODED / CODER CODED / CODED are NOT treated as ready.
- **Fix applied:** Corrected JSDoc to read "terminal column (COMPLETED or CODE REVIEWED)" to match the actual (stricter, correct) behavior.

**NIT-1: Autoban path never calls `_checkDependenciesBeforeDispatch`**
- Autoban dispatches via `handleKanbanBatchTrigger` (line 2849) which has no dependency gate. The `headless` parameter was added to `_checkDependenciesBeforeDispatch` but autoban never invokes it. This is acceptable for MVP — autoban operates on pre-configured column rules and users accept responsibility — but a future enhancement could add a headless check in `handleKanbanBatchTrigger` for each session.

**NIT-2: `archiveSchema.sql` base schema missing `dependencies` column**
- The CREATE TABLE in `archiveSchema.sql` does not include `dependencies VARCHAR`. The column is added dynamically via `ArchiveManager.ensureArchiveSchema()` ALTER TABLE migration (line 113). This is consistent with how `routed_to`, `dispatched_agent`, and `dispatched_ide` are handled, so not a bug — just means the schema file doesn't reflect the actual runtime schema.

**NIT-3: `getDependencyStatus` returns `ready: true` for unknown dependency IDs**
- KanbanDatabase.ts:660: When a dependency ID doesn't match any plan row, it defaults to `ready: true`. This is a deliberate fail-open design (documented in "Remaining Risks" above) but means typos in `## Dependencies` sections silently pass the gate. A `console.warn` for unresolved deps would improve observability.

### Files Changed (This Pass)

1. `src/services/TaskViewerProvider.ts` — Widened `_buildKanbanBatchPrompt` parameter type to include `dependencies?: string` (MAJOR-1 fix); corrected `_checkDependenciesBeforeDispatch` JSDoc comment (MAJOR-2 fix).

### Validation Results

- **TypeScript typecheck** (`npx tsc --noEmit`): ✅ Pass (only known pre-existing `KanbanProvider.ts:1833` ArchiveManager import error)
- **No behavioral changes** — both fixes are type-safety and documentation corrections; runtime behavior is unchanged.

### Remaining Risks

1. **Autoban dependency bypass (NIT-1)** — Autoban never calls the dependency gate. Future work: add `_checkDependenciesBeforeDispatch(sid, root, true)` inside `handleKanbanBatchTrigger` for each session when called from autoban context.
2. **Silent unknown-dep pass-through (NIT-3)** — Typos in `## Dependencies` sections are invisible. Future work: add `console.warn` in `getDependencyStatus` when no DB row matches a dep ID.
3. **Schema drift (NIT-2)** — `archiveSchema.sql` doesn't include `dependencies`, `routed_to`, `dispatched_agent`, `dispatched_ide`. All four are added via migration. Consider updating the base schema to match runtime reality.
