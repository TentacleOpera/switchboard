# Investigate Kanban Projects Empty Workspace ID Error

## Goal
Fix the database initialization failure that prevents the Kanban board from loading on pre-V23 databases, and fix the dropdown workspace selection bug that blocks multi-repo workspace switching.

## Metadata
- **Tags:** [bugfix, database, reliability, workflow]
- **Complexity:** 5

## User Review Required
No — both fixes are targeted corrections with clear before/after states.

## Complexity Audit

### Routine
- Removing `idx_plans_project` index from SCHEMA_SQL (it's already in MIGRATION_V23_SQL)
- Adding `dropdownWorkspaces` iteration to `_getAllowedRoots()` matching existing pattern
- Adding inline guardrail to `db.getProjects(workspaceId)` at TaskViewerProvider.ts:13334

### Complex / Risky
- SCHEMA_SQL change affects the initialization path for ALL databases (new and existing). The index must still be created for new databases — this is handled because V23 migration runs after SCHEMA_SQL and the index is in MIGRATION_V23_SQL. But we need to verify that a brand-new database still gets the index.

## Edge-Case & Dependency Audit

### Race Conditions
- None. All fixes are in synchronous or sequential initialization code.

### Security
- No security implications. All changes are internal database schema and validation logic.

### Side Effects
- Positive: Pre-V23 databases will now initialize successfully instead of crashing
- Positive: Dropdown workspaces will be selectable in multi-repo setups
- No negative side effects — removing the index from SCHEMA_SQL doesn't remove it from existing databases (CREATE INDEX IF NOT EXISTS is a no-op if the index already exists)

### Dependencies & Conflicts
- No dependencies on other plans or in-progress work.

## Dependencies
None — this is a self-contained bug fix.

## Adversarial Synthesis
Key risks: (1) The SCHEMA_SQL index removal must not break new-database creation — verified because MIGRATION_V23_SQL already contains the same index creation statement, and `_runMigrations()` runs after `_safeExec('SCHEMA_SQL', SCHEMA_SQL)`. (2) The `_getAllowedRoots` fix is a direct consistency correction. (3) The original plan misidentified the root cause twice — first as a missing guardrail, then as a dropdown validation issue — while the actual blocking bug was the SCHEMA_SQL index referencing a column that doesn't exist yet on pre-V23 databases. Mitigations: The index is redundant in SCHEMA_SQL since V23 migration creates it; removing it eliminates the ordering dependency.

## Problem
On startup, the Kanban board fails to initialize with error: `no such column: project. DB-backed views may appear empty until the database is repaired or reset.` This makes the entire Kanban board non-functional for any workspace whose database was created before V23.

Additionally, in multi-repo workspaces with `workspaceDatabaseMappings` configured, dropdown workspaces cannot be selected from the workspace dropdown.

## Root Cause Analysis

### PRIMARY BUG: SCHEMA_SQL Index References Column Before Migration Adds It

**File:** `src/services/KanbanDatabase.ts`

The initialization flow in `_initialize()` (lines 3088-3169) runs these steps in order:

1. **Line 3093:** `_safeExec('SCHEMA_SQL', SCHEMA_SQL)` — executes the full schema
2. **Line 3112:** `await this._runMigrations()` — runs versioned migrations (including V23)
3. **Line 3113:** `this._ensureSchemaColumns()` — adds any still-missing columns

**The problem:** SCHEMA_SQL (line 120) contains:
```sql
CREATE INDEX IF NOT EXISTS idx_plans_project ON plans(workspace_id, project);
```

When the database already exists with a pre-V23 `plans` table (no `project` column):
- `CREATE TABLE IF NOT EXISTS plans (...)` silently skips — the table already exists, even though it's missing the `project` column
- `CREATE INDEX IF NOT EXISTS idx_plans_project ON plans(workspace_id, project)` **throws** `no such column: project`
- This error is NOT caught by the `UNIQUE constraint failed` handler (line 3096), so it propagates up
- `_runMigrations()` and `_ensureSchemaColumns()` **never execute**
- The entire initialization fails, setting `_lastInitError = "no such column: project"`
- The Kanban board is completely non-functional

**The fix:** Remove `idx_plans_project` from SCHEMA_SQL. It's already defined in `MIGRATION_V23_SQL` (line 387):
```typescript
const MIGRATION_V23_SQL = [
    // ...
    `ALTER TABLE plans ADD COLUMN project TEXT DEFAULT ''`,
    `CREATE INDEX IF NOT EXISTS idx_plans_project ON plans(workspace_id, project)`,
];
```

V23 migration runs AFTER SCHEMA_SQL, so by the time the index creation runs, the `project` column already exists. For brand-new databases, V23 migration also runs (since `getMigrationVersion()` returns 0 < 23), so the index still gets created.

### SECONDARY BUG: `_getAllowedRoots()` Omits Dropdown Workspaces

**File:** `src/services/KanbanProvider.ts`

The workspace dropdown is populated by `_getWorkspaceItems()` (lines 625-726), which correctly iterates over `dropdownWorkspaces` (lines 699-711) and adds them to the dropdown.

However, when the user selects a workspace, `setCurrentWorkspaceRoot()` (lines 566-592) validates the selection against `_getAllowedRoots()` (lines 443-470). This method only adds `parentFolder` and `workspaceFolders` from the mapping config — it **never** iterates `dropdownWorkspaces`.

**Result:** The dropdown workspace path is not in the allowed set, so `setCurrentWorkspaceRoot()` rejects it:
```typescript
// Line 569-571
if (!allowed.has(resolved)) {
    console.error(`[KanbanProvider] Rejected invalid workspace: ${workspaceRoot}`);
    return false;
}
```

The selection silently fails. The user sees the option in the dropdown but nothing happens when they click it.

### TERTIARY ISSUE: Missing `getProjects` Guardrail in TaskViewerProvider.ts

**File:** `src/services/TaskViewerProvider.ts`

**Line 13334** calls `db.getProjects(workspaceId)` without an inline guardrail:
```typescript
const projects = await db.getProjects(workspaceId);
```

The three call sites in `KanbanProvider.ts` (lines 930, 1742, 1868) all use the guardrail pattern:
```typescript
const projects = workspaceId ? await db.getProjects(workspaceId) : [];
```

This is a consistency/defense-in-depth fix. The `_refreshRunSheets` method has an early-return guard at line 13306, but the inline guardrail is still valuable for self-documentation and protection against future refactoring.

## Proposed Changes

### src/services/KanbanDatabase.ts — PRIMARY FIX

**Context:** SCHEMA_SQL (line 120) contains an index that references the `project` column, which doesn't exist on pre-V23 databases. This causes `_initialize()` to throw before migrations can run.

**Logic:** Remove the `idx_plans_project` index from SCHEMA_SQL. It's already in MIGRATION_V23_SQL (line 387), which runs after SCHEMA_SQL and after the `ALTER TABLE` adds the column.

**Implementation:**

Current SCHEMA_SQL (lines 117-121):
```sql
CREATE INDEX IF NOT EXISTS idx_plans_column ON plans(kanban_column);
CREATE INDEX IF NOT EXISTS idx_plans_workspace ON plans(workspace_id);
CREATE INDEX IF NOT EXISTS idx_plans_status ON plans(status);
CREATE INDEX IF NOT EXISTS idx_plans_project ON plans(workspace_id, project);
CREATE UNIQUE INDEX IF NOT EXISTS idx_plans_plan_file_workspace ON plans(plan_file, workspace_id);
```

Fixed — remove line 120:
```sql
CREATE INDEX IF NOT EXISTS idx_plans_column ON plans(kanban_column);
CREATE INDEX IF NOT EXISTS idx_plans_workspace ON plans(workspace_id);
CREATE INDEX IF NOT EXISTS idx_plans_status ON plans(status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_plans_plan_file_workspace ON plans(plan_file, workspace_id);
```

**Also remove `project` column definition from SCHEMA_SQL's plans table** (line 102):
```sql
    repo_scope    TEXT DEFAULT '',
    project       TEXT DEFAULT '',
    workspace_id  TEXT NOT NULL,
```

Fixed — remove line 102:
```sql
    repo_scope    TEXT DEFAULT '',
    workspace_id  TEXT NOT NULL,
```

This is necessary because `CREATE TABLE IF NOT EXISTS plans` with the `project` column in the definition doesn't actually add the column to existing tables — it silently skips. But having it in the definition is misleading. The column is properly added by V23 migration (`ALTER TABLE plans ADD COLUMN project TEXT DEFAULT ''`), and `_ensureSchemaColumns()` will also add it as a safety net. Keeping it in SCHEMA_SQL creates a false sense that it will be present.

**Wait — removing `project` from SCHEMA_SQL's CREATE TABLE will break `_ensureSchemaColumns()`** because `SCHEMA_PLAN_COLUMN_DEFS` is parsed from SCHEMA_SQL. If `project` is removed from the CREATE TABLE definition, `_ensureSchemaColumns()` won't know to add it.

**Revised approach:** Keep `project` in the CREATE TABLE definition (for `_ensureSchemaColumns` parsing), but remove only the INDEX that references it. The CREATE TABLE itself is harmless (IF NOT EXISTS skips it), but the INDEX throws.

Final change — remove ONLY line 120 from SCHEMA_SQL:
```diff
 CREATE INDEX IF NOT EXISTS idx_plans_column ON plans(kanban_column);
 CREATE INDEX IF NOT EXISTS idx_plans_workspace ON plans(workspace_id);
 CREATE INDEX IF NOT EXISTS idx_plans_status ON plans(status);
-CREATE INDEX IF NOT EXISTS idx_plans_project ON plans(workspace_id, project);
 CREATE UNIQUE INDEX IF NOT EXISTS idx_plans_plan_file_workspace ON plans(plan_file, workspace_id);
```

**Edge Cases:**
- **New databases:** V23 migration runs (version 0 < 23), which adds the `project` column AND creates the index. No change in behavior.
- **Pre-V23 databases:** SCHEMA_SQL no longer throws on the missing column. V23 migration then adds the column and creates the index. `_ensureSchemaColumns()` adds the column if V23 migration somehow failed. All paths now work.
- **Post-V23 databases:** `CREATE INDEX IF NOT EXISTS` is a no-op (index already exists). No change in behavior.

### src/services/KanbanProvider.ts — SECONDARY FIX

**Context:** `_getAllowedRoots()` (lines 443-470) is missing `dropdownWorkspaces`, causing `setCurrentWorkspaceRoot()` to reject dropdown workspace selections.

**Logic:** Add `dropdownWorkspaces` iteration matching the pattern already used in `_getWorkspaceItems()` (lines 699-711).

**Implementation:**

Current code (lines 460-466):
```typescript
                    for (const wf of m.workspaceFolders ?? []) {
                        const expanded = wf.startsWith('~')
                            ? path.join(os.homedir(), wf.slice(1))
                            : wf;
                        allowedRoots.add(path.resolve(expanded));
                    }
```

Fixed code — add after line 465:
```typescript
                    for (const wf of m.workspaceFolders ?? []) {
                        const expanded = wf.startsWith('~')
                            ? path.join(os.homedir(), wf.slice(1))
                            : wf;
                        allowedRoots.add(path.resolve(expanded));
                    }
                    for (const dw of m.dropdownWorkspaces ?? []) {
                        const expanded = dw.startsWith('~')
                            ? path.join(os.homedir(), dw.slice(1))
                            : dw;
                        allowedRoots.add(path.resolve(expanded));
                    }
```

**Edge Cases:**
- If `dropdownWorkspaces` is undefined or empty: the `?? []` fallback produces an empty array, no items added — safe.
- If a dropdown workspace path overlaps with a `workspaceFolders` entry: `Set.add()` is idempotent, no duplicates — safe.
- Tilde expansion (`~`): matches the existing pattern in `_getWorkspaceItems()`.

### src/services/TaskViewerProvider.ts — TERTIARY FIX

**Context:** Line 13334 in `_refreshRunSheets` is the only `getProjects` call site without an inline guardrail.

**Implementation:**

Current code (line 13334):
```typescript
const projects = await db.getProjects(workspaceId);
```

Fixed code:
```typescript
const projects = workspaceId ? await db.getProjects(workspaceId) : [];
```

## Verification Plan

### Automated Tests
1. **Primary fix test** — Simulate pre-V23 database initialization:
   - Create a database with the pre-V23 schema (no `project` column, no `projects` table)
   - Set migration version to 22
   - Call `ensureReady()` / `_initialize()`
   - Assert that initialization succeeds (no `no such column` error)
   - Assert that `project` column exists in the plans table
   - Assert that `idx_plans_project` index exists

2. **Secondary fix test** — Add to `kanban-dropdown-workspaces.test.ts`:
   - Configure a mapping with `dropdownWorkspaces` entries
   - Call `_getAllowedRoots()`
   - Assert that dropdown workspace paths are in the allowed set
   - Call `setCurrentWorkspaceRoot()` with a dropdown workspace path
   - Assert that it returns `true` (accepts the selection)

3. **Tertiary fix test** — Add to `src/services/__tests__/TaskViewerProvider.test.ts`:
   - Mock `db.getWorkspaceId()` to return null or empty string
   - Mock `db.getProjects()` to track if it's called
   - Call `_refreshRunSheets()`
   - Assert that `db.getProjects()` is NOT called when workspaceId is empty

### Manual Verification
1. Open a workspace that has a pre-V23 kanban.db (no `project` column)
2. Verify the Kanban board loads without the "initialization failed" error
3. Verify the project dropdown populates correctly
4. In a multi-repo workspace with mappings, select a dropdown workspace
5. Verify the selection sticks and the board refreshes

### Regression Testing
- Test on a brand-new workspace (database created from scratch) — index should still be created via V23 migration
- Test on a post-V23 workspace (already has `project` column) — no change in behavior
- Test on a pre-V23 workspace (missing `project` column) — should now initialize successfully
- Test on a multi-repo workspace with dropdown workspaces — should now allow selection
- Test on a single-repo workspace (no mappings) — no change in behavior

## Risks

- **Low risk (primary fix):** Removing the index from SCHEMA_SQL doesn't remove it from existing databases. V23 migration creates it for all databases (new and upgraded). The only scenario where the index would be missing is if V23 migration fails AND `_ensureSchemaColumns()` also fails — but that's already the current broken state.
- **Low risk (secondary fix):** Adding entries to a `Set<string>` cannot remove or modify existing behavior.
- **Low risk (tertiary fix):** The guardrail only changes behavior when workspaceId is empty, which already causes an early return.

## Follow-up Items

1. Audit SCHEMA_SQL for any other indexes that reference columns added by migrations — the same pattern could exist for `has_worktree` (V24) or other future columns
2. Audit all methods that iterate `workspaceDatabaseMappings` for similar omissions of `dropdownWorkspaces`
3. Review `ensureWorkspaceIdentity` PRIORITY 5 for dropdown workspaces — the generated hash is never persisted
4. Review V22 migration to ensure it doesn't stamp version when workspace_id is missing
5. Consider splitting SCHEMA_SQL into "base schema" (tables only) and "post-migration indexes" to prevent this class of bug

## Recommendation
Complexity 5 → **Send to Coder**
