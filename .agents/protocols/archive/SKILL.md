---
name: archive
description: Query the Switchboard plan archive — the SQLite cold store (kanban-archive.db) that holds plans aged out of the hot kanban board, plus the optional legacy DuckDB archive.
---

# Archive Operations

## Purpose

Query historical Switchboard plans that are no longer on the hot kanban board.

## Which archive am I looking at?

There are **two** stores, and they are not interchangeable. Pick by the path you
were given, not by habit.

| Store | Path | CLI | When it exists |
|---|---|---|---|
| **Cold store** (default, what the board uses) | `<workspaceRoot>/.switchboard/kanban-archive.db` | `sqlite3` | Whenever plans have aged out of the hot board |
| Legacy DuckDB archive (opt-in) | value of the `switchboard.archive.dbPath` setting | `duckdb` | Only if the user configured that setting |

**Default to the cold store.** The Project panel's ARCHIVES tab reads it, and the
QUERY ARCHIVES button hands you its absolute path. The DuckDB archive only exists
for users who explicitly set `switchboard.archive.dbPath`; if that setting is empty,
there is no DuckDB file and `duckdb` commands will fail (or, worse, silently create
an empty database).

## Guardrails

- **Read-only. Always.** Never `INSERT`, `UPDATE`, `DELETE`, `DROP`, `ATTACH`, or
  `COPY` against either archive. Archiving and restoration are the extension's job.
- **Never invent the path.** Use the path you were given. `sqlite3` **silently
  creates** an empty database when handed a path that does not exist, so a typo or a
  wrong working directory leaves a stray 0-byte file behind and returns zero rows
  that look like a legitimate empty result.
- Guard before querying:

```bash
ARCHIVE_DB="<path you were given>"
[ -f "$ARCHIVE_DB" ] || { echo "No archive at $ARCHIVE_DB — nothing has been archived yet."; exit 1; }
```

## Cold store: `status` is `'completed'`, not `'archived'`

This is the single most common way to get a wrong answer here. Archived rows carry
`status = 'completed'`; the V10 migration rewrites any historical
`status = 'archived'` row to `'completed'`. A query filtering on `'archived'`
returns **zero rows on a fully-populated archive** — an empty result with no error.

```sql
-- CORRECT
SELECT topic, kanban_column, updated_at FROM plans WHERE status = 'completed';

-- WRONG — always returns nothing
SELECT topic FROM plans WHERE status = 'archived';
```

## Queries (cold store)

Rows are scoped by `workspace_id`. Read it from line 1 of
`<workspaceRoot>/.switchboard/workspace-id`; omit the filter to search every
workspace that shares the store.

```bash
# Most recently archived plans
sqlite3 -readonly "$ARCHIVE_DB" \
  "SELECT topic, kanban_column, complexity, updated_at
     FROM plans
    WHERE status = 'completed'
    ORDER BY updated_at DESC
    LIMIT 20;"

# Keyword search on topic (SQLite: LIKE is case-insensitive for ASCII; there is no ILIKE)
sqlite3 -readonly "$ARCHIVE_DB" \
  "SELECT topic, plan_file, updated_at
     FROM plans
    WHERE status = 'completed' AND topic LIKE '%<keyword>%'
    ORDER BY updated_at DESC
    LIMIT 20;"

# Scoped to one workspace
sqlite3 -readonly "$ARCHIVE_DB" \
  "SELECT topic, updated_at FROM plans
    WHERE status = 'completed' AND workspace_id = '<workspaceId>'
    ORDER BY updated_at DESC LIMIT 20;"

# By complexity
sqlite3 -readonly "$ARCHIVE_DB" \
  "SELECT topic, complexity, updated_at FROM plans
    WHERE status = 'completed' AND complexity = '8'
    ORDER BY updated_at DESC;"

# Feature rows and their subtasks
sqlite3 -readonly "$ARCHIVE_DB" \
  "SELECT topic, is_feature, feature_id FROM plans
    WHERE status = 'completed' AND (is_feature = 1 OR feature_id IS NOT NULL)
    ORDER BY updated_at DESC;"
```

Output formats: `-json`, `-csv`, `-line`, or `-header -column` for a readable table.

## Reading a plan's body

The cold store holds plan **metadata only** — never the plan text. The body lives on
disk at the `plan_file` path from the row. Resolve it relative to the workspace root
when it is not absolute, and expect misses: a plan file can be deleted while its
archive row survives.

```bash
sqlite3 -readonly "$ARCHIVE_DB" \
  "SELECT plan_file FROM plans WHERE plan_id = '<planId>';"
# then read that path, e.g. with cat / the Read tool
```

## Schema reference (cold store `plans` table)

Same schema as the hot `kanban.db` `plans` table. Columns:

`plan_id`, `session_id`, `topic`, `plan_file`, `kanban_column`, `status`,
`complexity`, `tags`, `repo_scope`, `project`, `workspace_id`, `created_at`,
`updated_at`, `last_action`, `source_type`, `brain_source_path`, `mirror_path`,
`routed_to`, `dispatched_agent`, `dispatched_ide`, `dispatched_terminal`,
`dispatched_at`, `last_liveness_at`, `blocked_at`, `clickup_task_id`,
`linear_issue_id`, `notion_page_id`, `worktree_id`, `worktree_status`, `is_feature`,
`feature_id`, `workspace_name`, `project_id`, `queue_position`, `column_entered_at`.

Confirm a column exists before filtering on it — older archives predate later
additions:

```bash
sqlite3 -readonly "$ARCHIVE_DB" "PRAGMA table_info(plans);"
```

`session_id` is deprecated; `plan_id` is the canonical identifier.

## Legacy DuckDB archive (only when `switchboard.archive.dbPath` is set)

Same read-only discipline. Tables: `plans`, `conversations`, `archive_metadata`.
DuckDB supports `ILIKE`; SQLite does not.

```bash
duckdb "$DUCKDB_ARCHIVE" "SELECT * FROM plans WHERE topic ILIKE '%<keyword>%' LIMIT 10;"
```

If the setting is empty, report that no DuckDB archive is configured and query the
cold store instead — do not create one.

## Common requests → what to run

| User says | Do this |
|---|---|
| "search the archives for X" | Cold store, `topic LIKE '%X%'`, `status = 'completed'` |
| "show me completed/archived plans" | Cold store, `status = 'completed'`, order by `updated_at DESC` |
| "find old plans about X" | Cold store keyword search, then read `plan_file` for the ones that matter |
| "what high complexity work did we do" | Cold store, filter `complexity` |
| "open that archived plan" | Query `plan_file`, then read the file from disk |

## Failure modes

- **Zero rows on an archive you know has content** → you filtered `status = 'archived'`. Use `'completed'`.
- **File not found** → nothing has been archived yet for this workspace. Report that; do not create the DB.
- **A stray 0-byte `kanban-archive.db` appears** → `sqlite3` was handed a wrong path. Delete the stray file and re-resolve from the workspace root.
- **`plan_file` points at a missing file** → the row outlived the file. Report the metadata you have.
- **`duckdb: command not found`** → the legacy archive is not in play; use the cold store.

## Related code

- Cold-store reads: `KanbanDatabase.getCompletedPlansCold`, `getArchiveInstanceIfPresent`, `resolveArchiveDbPath` (`src/services/KanbanDatabase.ts`)
- Archives tab handlers: `fetchArchivedPlans`, `fetchArchivedPlanDetail`, `queryArchivesPrompt` (`src/services/PlanningPanelProvider.ts`)
- Auto-archiving: `src/services/AutoArchiveService.ts`
- Legacy DuckDB archive: `src/services/ArchiveManager.ts`, `src/services/archiveSchema.sql`
