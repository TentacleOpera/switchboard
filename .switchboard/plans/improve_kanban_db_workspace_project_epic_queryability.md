# Improve Workspace, Project, and Epic Queryability in Kanban DB

**Plan ID:** `feature_plan_20260618_122800_kanban_db_queryability`  
**Status:** CREATED

---

## Goal

Make it trivial for agents (and users) to query the kanban database by workspace name, project, and epic/subtask relationships without needing to parse JSON blobs or guess opaque IDs.

## Background / Problem Analysis

1. **Workspace name is invisible in the `plans` table.** The only workspace identifier is `workspace_id`, an opaque string like `64a73ddc0069`. The human-readable name (`Autism360App`) lives inside a JSON blob in `config.workspace_mappings`. Agents cannot `JOIN` or filter by workspace name without first parsing that JSON.

2. **`plans.project` is a denormalized string, not a foreign key.** The `projects` table exists (`id`, `name`, `workspace_id`) but `plans` stores the raw project name in a `TEXT` column. This breaks referential integrity: renaming a project in the `projects` table orphans existing plans, and plans can hold names that do not exist in `projects`.

3. **Epic fields are dormant.** `plans` already has `is_epic INTEGER` and `epic_id TEXT`, but in the Autism360App workspace (117 active plans) every row has `is_epic = 0` and `epic_id = ''`. There is no skill or documentation telling agents how to use these fields.

4. **No query skill exists.** The only database-related skills are `query_switchboard_kanban` (raw SQL) and `query_archive` (DuckDB). Neither explains workspace/project/epic semantics or provides safe, ready-made queries.

## Metadata

- **Tags:** database, api, ui, docs
- **Complexity:** 6

## User Review Required

Yes — the schema migration and backfill script modify the live `kanban.db` format. Review the migration approach (V35 backfill via `_runMigrations` after `_ensureSchemaColumns`) and confirm whether the `project` string column should be kept as a denormalized cache or deprecated immediately.

## Complexity Audit

### Routine
- Adding `workspace_name` and `project_id` columns to `SCHEMA_SQL` and `KanbanPlanRecord` interface
- Creating `.agent/skills/query_kanban_plans.md` with ready-made SQL snippets
- Updating `.agent/skills/query_switchboard_kanban.md` and `query_archive.md` schema documentation
- Adding helper indexes (`idx_plans_workspace_name`, `idx_plans_project_id`)

### Complex / Risky
- Backfill migration must populate `workspace_name` from JSON config and `project_id` from string names without corrupting existing data
- `UPSERT_PLAN_SQL` and `getBoardFilteredByProject` must stay backward-compatible with the webview payload that expects `project` as a string
- Cross-DB reconciliation (`reconcileDatabases`) may merge rows from older DBs missing the new columns, leaving stale empty values
- Migration must not collide with `_ensureSchemaColumns`, which also adds missing columns from `SCHEMA_SQL`

## Edge-Case & Dependency Audit

- **Race Conditions**: None — SQL.js is single-writer in-memory; migrations run sequentially during initialization before any concurrent writes
- **Security**: No new attack surface; skill files are read-only documentation
- **Side Effects**: `importPlanFiles` will now inject `workspaceName` into every imported record; if `config.workspace_mappings` is malformed, `workspace_name` falls back to `''`
- **Dependencies & Conflicts**: None — this is foundational schema work. Depends on the `projects` table (added in V23) already existing.

## Dependencies

- `sess_XXXXXXXXXXXXX — none` (foundational; no external plan dependencies)

## Adversarial Synthesis

Key risks: (1) Removing `project` from the UPSERT binding while leaving the ON CONFLICT `project = excluded.project` clause will erase the denormalized string on every re-import; (2) `reconcileDatabases` intersects columns, so merging an old DB into a new one leaves new columns empty forever because the backfill only runs once per version stamp; (3) adding both a numbered `ALTER TABLE` migration and `_ensureSchemaColumns` creates a collision where SQLite throws on duplicate column addition. Mitigations: keep `project` as a writable cache in UPSERT, perform backfill before version-stamping so it retries on failure, and let `_ensureSchemaColumns` handle column creation while the migration only handles backfill.

## Proposed Changes

### 1. Schema: Update `SCHEMA_SQL` in `KanbanDatabase.ts`

**File:** `src/services/KanbanDatabase.ts` (lines 103–168)  
Add `workspace_name TEXT DEFAULT ''` and `project_id INTEGER DEFAULT NULL` to the `plans` table definition inside `SCHEMA_SQL`.

- **`_ensureSchemaColumns`** (line ~4681) parses `SCHEMA_SQL` and auto-adds missing columns for existing databases. No separate `ALTER TABLE` migration is required for column creation.
- Backfill of data is handled separately in step 7.

### 2. Update `KanbanPlanRecord` interface

**File:** `src/services/KanbanDatabase.ts` (lines 31–58)  
Add:

```ts
workspaceName?: string;
projectId?: number | null;
```

Keep `project?: string` as a denormalized read/write cache for backward compatibility.

### 3. Update `UPSERT_PLAN_SQL` in `KanbanDatabase.ts`

**File:** `src/services/KanbanDatabase.ts` (line ~535)  
- Add `workspace_name` and `project_id` to the `INSERT INTO plans (...)` column list.
- Add corresponding `?` placeholders.
- **Keep `project` in the INSERT binding and in the `ON CONFLICT` update clause** (`project = excluded.project`). This preserves the denormalized string for webview compat and prevents data loss during re-imports.
- Add `workspace_name = excluded.workspace_name` and `project_id = excluded.project_id` to the `ON CONFLICT` updates.

### 4. Update `upsertPlans` binding

**File:** `src/services/KanbanDatabase.ts` (line ~1196)  
Append `record.workspaceName || ''` and `record.projectId || null` to the parameter array passed to `stmt.run(...)`.

### 5. Update `getBoardFilteredByProject`

**File:** `src/services/KanbanDatabase.ts` (line ~2234)  
Rewrite to LEFT JOIN `projects` and resolve the string filter internally:

```ts
public async getBoardFilteredByProject(
    workspaceId: string,
    project: string | null,
    repoScope: string | null
): Promise<KanbanPlanRecord[]> {
    // ... ensureReady check ...
    let query = `SELECT ${PLAN_COLUMNS} FROM plans WHERE workspace_id = ? AND status = 'active'`;
    const params: unknown[] = [workspaceId];

    if (repoScope) {
        query += ` AND repo_scope = ?`;
        params.push(repoScope);
    }

    if (project === KanbanDatabase.UNASSIGNED_PROJECT_FILTER) {
        query += ` AND project_id IS NULL`;
    } else if (project) {
        // Look up project_id from name, or LEFT JOIN in the query itself
        query = query.replace(`SELECT ${PLAN_COLUMNS} FROM plans`,
            `SELECT ${PLAN_COLUMNS}, pr.name AS project FROM plans LEFT JOIN projects pr ON plans.project_id = pr.id`);
        query += ` AND pr.name = ?`;
        params.push(project);
    }

    query += ` ORDER BY updated_at DESC`;
    // ... execute and map rows ...
}
```

This keeps the method signature unchanged (consumers still pass a string) while the DB layer now uses the FK.

### 6. Add `setProjectForPlans` (new method)

**File:** `src/services/KanbanDatabase.ts` (new method after `deleteProject`, line ~2115)  
This method does not currently exist. Add it to resolve `projectName` → `projects.id` and update `project_id`:

```ts
public async setProjectForPlans(
    workspaceId: string,
    planIds: string[],
    projectName: string | null
): Promise<boolean> {
    if (!(await this.ensureReady()) || !this._db) return false;
    if (planIds.length === 0) return true;

    let projectId: number | null = null;
    if (projectName && projectName !== KanbanDatabase.UNASSIGNED_PROJECT_FILTER) {
        const stmt = this._db.prepare(
            'SELECT id FROM projects WHERE name = ? AND workspace_id = ?',
            [projectName, workspaceId]
        );
        if (stmt.step()) {
            projectId = Number(stmt.getAsObject().id);
        }
        stmt.free();
    }

    const now = new Date().toISOString();
    const placeholders = planIds.map(() => '?').join(', ');
    const query = `UPDATE plans SET project_id = ?, project = ?, updated_at = ? WHERE workspace_id = ? AND plan_id IN (${placeholders})`;
    const params: unknown[] = [projectId, projectName || '', now, workspaceId, ...planIds];

    try {
        this._db.run(query, params);
        await this._persist();
        return true;
    } catch (error) {
        console.error(`[KanbanDatabase] Failed to set project for plans:`, error);
        return false;
    }
}
```

This writes both `project_id` and the denormalized `project` string in one go.

### 7. V35 Backfill Migration

**File:** `src/services/KanbanDatabase.ts` (add inside `_runMigrations`, after existing V34 block, line ~3970)  
Create a new `MIGRATION_V35_SQL` array **that does NOT contain `ALTER TABLE` statements** (columns are handled by `_ensureSchemaColumns`). Instead, it backfills data:

```ts
const MIGRATION_V35_SQL = [
    // Backfill workspace_name from config JSON
    `UPDATE plans SET workspace_name = (
        SELECT json_extract(value, '$[0].name')
        FROM config
        WHERE config.key = 'workspace_mappings'
    ) WHERE workspace_name = '' OR workspace_name IS NULL`,
    // Backfill project_id from denormalized project names
    `UPDATE plans SET project_id = (
        SELECT id FROM projects WHERE projects.name = plans.project AND projects.workspace_id = plans.workspace_id
    ) WHERE project != '' AND (project_id IS NULL OR project_id = 0)`,
];
```

In `_runMigrations`, add:

```ts
if (currentVersion < 35) {
    console.log('[KanbanDatabase] Running V35 backfill...');
    try {
        this._db.run('BEGIN TRANSACTION');
        for (const sql of MIGRATION_V35_SQL) {
            this._db.exec(sql);
        }
        this._db.run('COMMIT');
        await this.setMigrationVersion(35);
        console.log('[KanbanDatabase] V35 backfill completed.');
    } catch (e) {
        this._db.run('ROLLBACK');
        console.error('[KanbanDatabase] V35 backfill failed:', e);
        // Do NOT stamp version — retry on next init
    }
}
```

**Important:** Version is stamped only after successful COMMIT. If the backfill throws, the next DB initialization will retry.

### 8. Update `PlanFileImporter.ts`

**File:** `src/services/PlanFileImporter.ts` (line ~1–273)  
Before iterating plan files, fetch workspace mappings once and build a lookup map `workspaceId → name`:

```ts
const workspaceMappings = await kanbanDb.getWorkspaceMappings();
const workspaceNameMap = new Map(workspaceMappings.map(m => [m.id, m.name]));
```

When constructing each `KanbanPlanRecord`, inject:

```ts
workspaceName: workspaceNameMap.get(record.workspaceId) || '',
projectId: null, // leave for UI assignment or future convention inference
```

This avoids an N+1 query per file.

### 9. Update `KanbanProvider.ts`

**File:** `src/services/KanbanProvider.ts` (around `setProjectFilter`, line ~4365)  
Replace any direct `project` string writes on plan rows with a call to the new `KanbanDatabase.setProjectForPlans()` method. In `_refreshBoardImpl` (line ~1782), ensure the payload mapping reads `row.project` directly — it will remain hydrated because `KanbanDatabase` continues to write the denormalized string alongside `project_id`. No webview payload changes are required.

### 10. New skill: `query_kanban_plans.md`

**File:** `.agent/skills/query_kanban_plans.md` (new)  
Create with ready-made SQL. Include a preamble telling agents to discover workspace names via:

```sql
SELECT DISTINCT workspace_name FROM plans WHERE workspace_name != '';
```

Then provide the queries (unchanged from original plan): search by workspace name, project, unassigned, epic, plan type classification, and epic subtask counts.

### 11. Update `query_switchboard_kanban.md`

**File:** `.agent/skills/query_switchboard_kanban.md` (prepend new "Complete Schema Reference" section)  
Add the full table/column reference (as detailed in original step 9a), including new `project_id` and `workspace_name` columns. Add a cross-reference link to `query_kanban_plans.md` at the bottom.

### 12. Update `query_archive/SKILL.md`

**File:** `.agent/skills/query_archive/SKILL.md` (add schema reference section)  
Document verified DuckDB archive columns. If the archive `plans` table does not yet have `workspace_name` or `project_id`, note that explicitly. Add a cross-reference link to `query_kanban_plans.md`.

### 13. Add helper indexes

**File:** `src/services/KanbanDatabase.ts` (inside `SCHEMA_SQL`, after existing indexes, line ~136)  
Add:

```sql
CREATE INDEX IF NOT EXISTS idx_plans_workspace_name ON plans(workspace_name);
CREATE INDEX IF NOT EXISTS idx_plans_project_id ON plans(project_id);
```

(Existing `idx_plans_is_epic` and `idx_plans_epic_id` from V29 are already present.)

## Verification Plan

### Manual Verification

1. **Schema inspection:** Open a copy of `kanban.db` and run `PRAGMA table_info(plans);` — confirm `workspace_name` and `project_id` exist.
2. **Backfill audit:** After starting the extension with the new code, check that:
   - `SELECT COUNT(*) FROM plans WHERE workspace_name = '';` returns `0`.
   - `SELECT COUNT(*) FROM plans WHERE project != '' AND project_id IS NULL;` returns `0`.
3. **Board smoke test:** Open the Kanban board, switch project filters, verify correct plans appear and "Unassigned" filter shows plans with `project_id IS NULL`.
4. **Skill query test:** Run each SQL snippet from `query_kanban_plans.md` against the database and confirm non-error result sets.

### Automated Tests

- Add unit test in `src/test/agent-cli-input-background-regression.test.js` or adjacent KanbanDatabase test:
  - Insert a `KanbanPlanRecord` with `workspaceName` and `projectId`, assert both columns round-trip via `getBoardFilteredByProject`.
  - Call `setProjectForPlans` with a known project name, assert `project_id` and `project` string are both updated.
  - Simulate a DB at version 34, run initialization, assert migration version becomes 35 and backfilled columns are populated.

## Files to Change

- `src/services/KanbanDatabase.ts`
- `src/services/PlanFileImporter.ts`
- `src/services/KanbanProvider.ts`
- `.agent/skills/query_kanban_plans.md` (new)
- `.agent/skills/query_switchboard_kanban.md`
- `.agent/skills/query_archive/SKILL.md`

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| Renaming a project orphans `project_id` FKs | Build a `renameProject` helper that updates both `projects.name` and re-links any affected plans. |
| SQLite FK enforcement is off by default | Rely on application-layer consistency in `KanbanDatabase.ts` (all writes go through it). |
| Backfill script fails mid-way | Version stamped only after successful COMMIT; failure leaves version < 35 so retry on next init. |
| Cross-DB reconciliation leaves empty new columns | Accept as known limitation; consider a post-reconcile backfill trigger in future work. |
| Webview expects `project` as string | Keep writing `project` string alongside `project_id` in UPSERT and `setProjectForPlans`. |

## Recommendation

**Complexity: 6** → **Send to Coder**
