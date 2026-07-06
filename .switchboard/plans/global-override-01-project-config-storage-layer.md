# Global Override 01: project_config Storage Layer

## Goal

Add a `project_config` table to `kanban.db` with CRUD methods on `KanbanDatabase`, giving the settings system a project dimension for the first time. This is the storage foundation the scope-aware layer (plan 02), snapshot mechanism (plan 04), and role-config scoping (plan 05) all build on.

### Problem

The kanban settings system has no project dimension. The `config` table in `kanban.db` is `(key TEXT PRIMARY KEY, value TEXT NOT NULL)` — flat, workspace-wide. There is no way to store a setting that applies to one project but not another.

### Background

Settings today are stored in two tiers: VS Code `globalState` (cross-workspace) and the workspace's `kanban.db` `config` table. `KanbanDatabase` exposes `getConfigJsonSync` / `setConfigJson` for the config table. The `config` table is created in the schema initialization and has a V2 migration (`MIGRATION_V2_CONFIG_TABLE`).

**Verified against code (2026-07-07):**
- `config` table created in `SCHEMA_TABLES_SQL` (`src/services/KanbanDatabase.ts:154-157`) AND idempotently in `MIGRATION_V2_CONFIG_TABLE` (`KanbanDatabase.ts:208`, applied at `:4884`). Both identical schema.
- The DB layer is **sql.js (WASM)**, not better-sqlite3. Reads use `prepare(sql, params)` / `step()` / `getAsObject()` / `free()`; writes use `this._db.run(sql, params)` followed by `this._persist()` (whole-image write to disk). Async methods guard with `await this.ensureReady()`; sync methods require `this._db` already open and return the default otherwise.
- Existing config accessors (`KanbanDatabase.ts:3500-3551`): `getConfig`, `setConfig`, `getConfigJson<T>`, `setConfigJson`, `getConfigSync`, `getConfigJsonSync<T>`. JSON getters wrap `JSON.parse` in try/catch and return `defaultValue` on null/parse-error.
- `KanbanDatabase.UNASSIGNED_PROJECT_FILTER = '__unassigned__'` exists at `KanbanDatabase.ts:738`. "All projects" is represented by a falsy/empty active filter — there is no separate sentinel.
- Instances via static `KanbanDatabase.forWorkspace(workspaceRoot, customDbPath?)` (`KanbanDatabase.ts:844`), cached per resolved root.
- Migration system: `const MIGRATION_Vnn_SQL` constants + gated `if (version < N)` blocks; version tracked in `migration_meta` under `kanban_db_migration_version`. **Highest existing migration is V51** (`MIGRATION_V51_SQL` at `:317`, applied `:6060-6080`). Config writes participate in **no** audit/event log (`plan_events` is plan-lifecycle only) — no audit hook needed here.

### Root Cause

The storage layer has no project key. Before any scope-aware read/write logic can be built, the database must support storing and retrieving settings keyed by `(project, key)`.

### Desired Outcome

A new `project_config` table in `kanban.db` with CRUD methods on `KanbanDatabase`, ready for the scope-aware settings layer (plan 02) to use. No existing data is migrated — the existing `config` table remains the workspace tier untouched.

## Metadata

**Complexity:** 4
**Tags:** backend, database, refactor, feature
**Project:** switchboard

## User Review Required

None.

## Complexity Audit

### Routine
- New table + CRUD methods that mirror the existing `config` accessors verbatim (same sql.js prepare/step/free and run/_persist idiom, same JSON try/catch pattern).
- `CREATE TABLE IF NOT EXISTS` migration is idempotent — safe on fresh and existing DBs, no data migration required.
- `__unassigned__` sentinel handling is a simple guard clause.

### Complex / Risky
- Migration numbering discipline: the new migration MUST be **V52** (not V3 as originally drafted — V51 is the current highest). Never edit shipped `MIGRATION_Vnn_SQL` bodies; add a new gated block only.
- Per-write `_persist()` cost: sql.js persists the whole DB image on every write. Callers doing bulk writes (plan 04's snapshot) need the batched method below, or they trigger a persist storm.

## Edge-Case & Dependency Audit

- **Race Conditions:** sql.js runs in-process and single-threaded; two VS Code windows on the same workspace do last-persist-wins on the DB image — identical exposure to the existing `config` table, accepted status quo. No new locking introduced.
- **Security:** `project` is user-provided text — all queries use positional `?` parameter binding (matching the existing idiom); no string interpolation into SQL.
- **Side Effects:** Each write calls `_persist()` (full DB image). The batched `setProjectConfigJsonMany` exists specifically so plan 04's snapshot performs one persist, not N.
- **Dependencies & Conflicts:** Plans 02, 04, 05 consume these methods. No conflict with existing tables; `project_config` is net-new (verified: no `project_config` / `projectConfig` symbol exists anywhere in the file today).

## Dependencies

- None external. First subtask in the feature — plans 02/04/05 depend on this landing first.

## Adversarial Synthesis

Key risks: wrong migration number colliding with a future shipped migration (must be V52, gated block appended after V51's at ~`:6080`); persist-storm from per-key writes during snapshot (mitigated by `setProjectConfigJsonMany`); sync reader returning defaults when the DB isn't open yet (mirrors existing `getConfigSync` contract — callers in plan 02 already tolerate this). Mitigations: follow the verbatim existing idiom, add the batch method, keep the table additive-only.

## Proposed Changes

### src/services/KanbanDatabase.ts

**Context:** All changes in one file, mirroring the existing config-table code at `:154-157` (schema), `:208` (V2 migration), `:3500-3551` (accessors), `:6060-6080` (V51 migration block — the append point).

**1. Schema** — add to `SCHEMA_TABLES_SQL` (alongside `config` at `:154`):

```sql
CREATE TABLE IF NOT EXISTS project_config (
    project TEXT NOT NULL,
    key     TEXT NOT NULL,
    value   TEXT NOT NULL,
    PRIMARY KEY (project, key)
);
```

**2. Migration V52** — define `MIGRATION_V52_SQL` next to the other constants:

```ts
const MIGRATION_V52_SQL = [
    `CREATE TABLE IF NOT EXISTS project_config (
        project TEXT NOT NULL,
        key     TEXT NOT NULL,
        value   TEXT NOT NULL,
        PRIMARY KEY (project, key)
    )`
];
```

Apply after the V51 block (~`:6080`) with the standard gate:

```ts
const v52 = await this.getMigrationVersion();
if (v52 < 52) {
    for (const sql of MIGRATION_V52_SQL) {
        try { this._db.exec(sql); } catch { /* already exists */ }
    }
    await this.setMigrationVersion(52);
}
```

`IF NOT EXISTS` makes it safe for both fresh DBs (which already got the table from `SCHEMA_TABLES_SQL`) and existing DBs.

**3. CRUD methods** — mirror the existing config accessors' bodies exactly (ensureReady guard, prepare/step/getAsObject/free for reads, run + `_persist()` for writes, JSON try/catch):

- `getProjectConfigJsonSync<T>(project: string, key: string, defaultValue: T): T` — sync read (requires `this._db` open, like `getConfigJsonSync`); `SELECT value FROM project_config WHERE project = ? AND key = ? LIMIT 1`.
- `setProjectConfigJson(project: string, key: string, value: unknown): Promise<boolean>` — `INSERT INTO project_config (project, key, value) VALUES (?, ?, ?) ON CONFLICT(project, key) DO UPDATE SET value = excluded.value`, then `_persist()`.
- `setProjectConfigJsonMany(project: string, entries: Record<string, unknown>): Promise<boolean>` — *(Clarification: batch variant so plan 04's snapshot persists once)* run the upsert for every entry, then a single `_persist()`.
- `deleteProjectConfigJson(project: string, key: string): Promise<boolean>` — `DELETE FROM project_config WHERE project = ? AND key = ?`, then `_persist()` (for "reset to inherited").
- `getAllProjectConfigJson(project: string): Promise<Record<string, unknown>>` — `SELECT key, value FROM project_config WHERE project = ?`, iterate `stmt.step()` rows, JSON-parse each value in try/catch (skip unparseable rows), for snapshot/export.
- `clearAllProjectConfig(project: string): Promise<boolean>` — `DELETE FROM project_config WHERE project = ?`, then `_persist()` (for full reset).

Each method:
- Uses positional `?` parameter binding (project is user-provided text).
- Handles the sentinel: if `project === KanbanDatabase.UNASSIGNED_PROJECT_FILTER` or is falsy/empty, return the default (reads) / no-op returning `false` (writes). A falsy filter means "all projects" — there is no project tier to address.

**4. Override switch state storage**

The two override switch states (`kanban.workspaceOverrideEnabled`, `kanban.projectOverrideEnabled`) are stored in the **existing** `config` table (workspace tier) using the existing `setConfigJson` / `getConfigJsonSync` methods. No new methods needed — just document that these two keys live in the workspace config table and are NOT subject to scope resolution themselves.

**Edge Cases:** empty/`__unassigned__` project (guarded no-op); unparseable JSON rows in `getAllProjectConfigJson` (skipped, not thrown); DB not open for the sync getter (returns default — same contract as `getConfigJsonSync`).

## Files to Modify

| File | Changes |
|------|---------|
| `src/services/KanbanDatabase.ts` | New `project_config` table in `SCHEMA_TABLES_SQL` + `MIGRATION_V52_SQL` gated block, 6 new project-scoped CRUD methods (incl. batched write) |

## Verification Plan

### Automated Tests

Session directive: no compilation or automated test runs in this pass. The checks below are the acceptance checklist for manual/UAT verification after coding.

- [ ] Fresh workspace: `project_config` table created on DB init (via `SCHEMA_TABLES_SQL`)
- [ ] Existing workspace: V52 migration creates `project_config` without touching `config`; `migration_meta` version advances to 52
- [ ] `setProjectConfigJson` then `getProjectConfigJsonSync` returns the same value
- [ ] `setProjectConfigJsonMany` writes all entries with a single persist
- [ ] `deleteProjectConfigJson` removes a key; subsequent read returns default
- [ ] `getAllProjectConfigJson` returns all keys for a project as a map
- [ ] `clearAllProjectConfig` removes all rows for a project only (other projects untouched)
- [ ] `__unassigned__` / empty project sentinel is handled (no-op / default)
- [ ] Existing `config` table reads/writes are unaffected

---

**Recommendation: Send to Coder**
