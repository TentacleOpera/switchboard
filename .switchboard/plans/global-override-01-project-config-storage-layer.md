# Global Override 01: project_config Storage Layer

## Metadata

**Complexity:** 5
**Tags:** backend, database, refactor, feature
**Project:** switchboard

## Goal

### Problem

The kanban settings system has no project dimension. The `config` table in `kanban.db` is `(key TEXT PRIMARY KEY, value TEXT NOT NULL)` — flat, workspace-wide. There is no way to store a setting that applies to one project but not another.

### Background

Settings today are stored in two tiers: VS Code `globalState` (cross-workspace) and the workspace's `kanban.db` `config` table. `KanbanDatabase` exposes `getConfigJsonSync` / `setConfigJson` for the config table. The `config` table is created in the schema initialization and has a V2 migration (`MIGRATION_V2_CONFIG_TABLE`).

### Root Cause

The storage layer has no project key. Before any scope-aware read/write logic can be built, the database must support storing and retrieving settings keyed by `(project, key)`.

### Desired Outcome

A new `project_config` table in `kanban.db` with CRUD methods on `KanbanDatabase`, ready for the scope-aware settings layer (plan 02) to use. No existing data is migrated — the existing `config` table remains the workspace tier untouched.

## Implementation

### 1. Schema — `src/services/KanbanDatabase.ts`

Add to the base schema (alongside the existing `config` table):

```sql
CREATE TABLE IF NOT EXISTS project_config (
    project TEXT NOT NULL,
    key    TEXT NOT NULL,
    value  TEXT NOT NULL,
    PRIMARY KEY (project, key)
);
```

Add a migration step (`MIGRATION_V3_PROJECT_CONFIG_TABLE` or similar) that runs `CREATE TABLE IF NOT EXISTS project_config ...` for existing databases. The `IF NOT EXISTS` makes it safe for both fresh and existing DBs.

### 2. CRUD methods — `src/services/KanbanDatabase.ts`

Add these methods, mirroring the existing `getConfigJsonSync` / `setConfigJson` pattern:

- `getProjectConfigJsonSync<T>(project: string, key: string, defaultValue: T): T` — read one project-scoped key
- `setProjectConfigJson(project: string, key: string, value: unknown): Promise<boolean>` — upsert one project-scoped key
- `deleteProjectConfigJson(project: string, key: string): Promise<boolean>` — delete one key (for "reset to inherited")
- `getAllProjectConfigJson(project: string): Promise<Record<string, unknown>>` — return all keys for a project (for snapshot/export)
- `clearAllProjectConfig(project: string): Promise<boolean>` — clear all project-scoped settings for a project (for full reset)

Each method should:
- Use prepared statements with parameter binding (project is user-provided text)
- Follow the same JSON serialize/deserialize pattern as the existing config methods
- Handle the `__unassigned__` sentinel: if `project === KanbanDatabase.UNASSIGNED_PROJECT_FILTER`, treat as no project (return default / no-op)

### 3. Override switch state storage

The two override switch states (`kanban.workspaceOverrideEnabled`, `kanban.projectOverrideEnabled`) are stored in the **existing** `config` table (workspace tier) using the existing `setConfig` / `getConfig` methods. No new methods needed for this — just document that these two keys live in the workspace config table and are NOT subject to scope resolution themselves.

## Files to Modify

| File | Changes |
|------|---------|
| `src/services/KanbanDatabase.ts` | New `project_config` table in schema + migration, 5 new project-scoped CRUD methods |

## Test Plan

- [ ] Fresh workspace: `project_config` table created on DB init
- [ ] Existing workspace: migration creates `project_config` table without touching `config`
- [ ] `setProjectConfigJson` then `getProjectConfigJsonSync` returns the same value
- [ ] `deleteProjectConfigJson` removes a key; subsequent read returns default
- [ ] `getAllProjectConfigJson` returns all keys for a project as a map
- [ ] `clearAllProjectConfig` removes all rows for a project
- [ ] `__unassigned__` project sentinel is handled (no-op / default)
- [ ] Existing `config` table reads/writes are unaffected
