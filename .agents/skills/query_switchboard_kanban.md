---
name: Query Switchboard Kanban
description: Query kanban state using direct SQL access to kanban.db
---

# Query Switchboard Kanban

Query kanban board state using direct SQL access to the kanban database. This skill is READ-ONLY — execution agents must never use SQL UPDATE/DELETE/INSERT on the kanban database.

## Prerequisites

1. **Workspace ID and Database Path**: Read from `.switchboard/workspace-id` (two lines: line 1 = workspace ID, line 2 = database path)
2. **SQL CLI**: Use `sqlite3` CLI (pre-installed on macOS)

## Fast Path: Read Board State (No SQL)

The kanban board auto-exports its current state to a markdown file on every change. For simple reads, use this instead of SQL:

```bash
read_file <workspace_root>/.switchboard/kanban-board.md
```

Use SQL queries only when you need filtering, aggregation, or specific plan lookups that the markdown file doesn't support.

## Get Workspace ID and Database Path

```bash
# Resolve the Switchboard control plane from the nearest ANCESTOR directory that
# contains it — never trust the current working directory. This matters because
# sqlite3 SILENTLY CREATES an empty database when handed a path that doesn't
# exist; a wrong cwd would otherwise leave a stray 0-byte kanban.db behind.
SB_ROOT="$PWD"
while [ "$SB_ROOT" != "/" ] && [ ! -f "$SB_ROOT/.switchboard/workspace-id" ]; do
  SB_ROOT=$(dirname "$SB_ROOT")
done
WSID_FILE="$SB_ROOT/.switchboard/workspace-id"

WORKSPACE_ID=$(sed -n '1p' "$WSID_FILE" 2>/dev/null)
DB_PATH=$(sed -n '2p' "$WSID_FILE" 2>/dev/null)

# Fallback if line 2 (DB path) is empty — old-format workspace-id file.
[ -z "$DB_PATH" ] && DB_PATH="$SB_ROOT/.switchboard/kanban.db"

# Guard: refuse to continue if the DB is missing, rather than querying (and thus
# creating) a phantom empty database somewhere it should never exist.
if [ ! -f "$DB_PATH" ]; then
  echo "ERROR: kanban DB not found at '$DB_PATH'" >&2
  echo "Run this from the workspace root, or fix line 2 of .switchboard/workspace-id." >&2
  exit 1
fi
```

- **Line 1**: Workspace ID (hex string like `038bffef-9842-4574-96a1-69a43a280b3c`)
- **Line 2**: Database path (absolute path to kanban.db; empty if using default location)

> **Always query with `sqlite3 -readonly "$DB_PATH" "<sql>"`.** This skill only
> reads. `-readonly` prevents accidental writes and is a second guard against
> sqlite3 fabricating an empty database if the path is ever wrong.

## Common SQL Queries

### Get All Active Plans in a Column

```sql
SELECT plan_id, session_id, topic, kanban_column, status, complexity
FROM plans
WHERE workspace_id = '<workspace_id>' 
  AND status = 'active' 
  AND kanban_column = '<column_name>'
ORDER BY updated_at DESC;
```

**Valid columns:** CREATED, BACKLOG, PLAN REVIEWED, CONTEXT GATHERER, LEAD CODED, CODER CODED, CODE REVIEWED, CODED, COMPLETED

### Get Plans for Dependency Check (CREATED, BACKLOG, PLAN REVIEWED)

```sql
SELECT plan_id, session_id, topic, kanban_column, dependencies
FROM plans
WHERE workspace_id = '<workspace_id>' 
  AND status = 'active' 
  AND kanban_column IN ('CREATED', 'BACKLOG', 'PLAN REVIEWED')
ORDER BY updated_at DESC;
```

### Get Plan by Session ID

```sql
SELECT *
FROM plans
WHERE session_id = '<session_id>'
LIMIT 1;
```


### Get Full Board State (All Active Plans)

```sql
SELECT *
FROM plans
WHERE workspace_id = '<workspace_id>' 
  AND status = 'active'
ORDER BY kanban_column, updated_at DESC;
```

## Usage Examples

### Using sqlite3 CLI

```bash
# Resolve the control-plane root from the nearest ancestor (see note above) so a
# wrong cwd can't make sqlite3 fabricate an empty DB.
SB_ROOT="$PWD"
while [ "$SB_ROOT" != "/" ] && [ ! -f "$SB_ROOT/.switchboard/workspace-id" ]; do
  SB_ROOT=$(dirname "$SB_ROOT")
done
WORKSPACE_ID=$(sed -n '1p' "$SB_ROOT/.switchboard/workspace-id" 2>/dev/null)
DB_PATH=$(sed -n '2p' "$SB_ROOT/.switchboard/workspace-id" 2>/dev/null)
[ -z "$DB_PATH" ] && DB_PATH="$SB_ROOT/.switchboard/kanban.db"
[ -f "$DB_PATH" ] || { echo "ERROR: kanban DB not found at '$DB_PATH'" >&2; exit 1; }

# Get plans in BACKLOG column — READ-ONLY (this skill never writes).
sqlite3 -readonly "$DB_PATH" "SELECT plan_id, session_id, topic, kanban_column FROM plans WHERE workspace_id = '$WORKSPACE_ID' AND status = 'active' AND kanban_column = 'BACKLOG' ORDER BY updated_at DESC;"


```

## Schema Reference

### plans Table

| Column | Type | Description |
|--------|------|-------------|
| plan_id | TEXT | Primary key |
| session_id | TEXT UNIQUE | Session identifier |
| topic | TEXT | Plan title |
| plan_file | TEXT | Path to plan markdown file |
| kanban_column | TEXT | Current column |
| status | TEXT | 'active', 'archived', 'completed', 'deleted' |
| complexity | TEXT | Complexity score (1-10 or 'Unknown') |
| tags | TEXT | Comma-separated tags |
| dependencies | TEXT | Dependency description |
| repo_scope | TEXT | Repository scope |
| workspace_id | TEXT | Workspace identifier |
| created_at | TEXT | ISO timestamp |
| updated_at | TEXT | ISO timestamp |
| last_action | TEXT | Last action description |
| source_type | TEXT | 'local', 'brain', etc. |
| brain_source_path | TEXT | Original brain file path |
| mirror_path | TEXT | Mirrored file path |
| routed_to | TEXT | Target agent |
| dispatched_agent | TEXT | Agent that executed |
| dispatched_ide | TEXT | IDE used |
| clickup_task_id | TEXT | ClickUp task ID |
| linear_issue_id | TEXT | Linear issue ID |
| worktree_id | INTEGER | Associated worktree ID |
| worktree_status | TEXT | Worktree status ('none', 'active', 'merged', 'deleted') |
| is_epic | INTEGER | 1 if this plan is an epic, 0 otherwise |
| epic_id | TEXT | Parent epic plan_id if this is a subtask |
| workspace_name | TEXT | Human-readable name of the workspace |
| project_id | INTEGER | Foreign key matching projects.id |

### projects Table

| Column | Type | Description |
|--------|------|-------------|
| id | INTEGER | Primary key (autoincrement) |
| name | TEXT | Project name |
| workspace_id | TEXT | Workspace identifier |
| created_at | TEXT | ISO timestamp |

### config Table

| Column | Type | Description |
|--------|------|-------------|
| key | TEXT PRIMARY KEY | Configuration key |
| value | TEXT | Configuration value |

**Key:** `workspace_id` stores the workspace identifier.

## Cross-Reference
For ready-made query templates on workspace names, projects, and epics, see the [query_kanban_plans.md](file:///Users/patrickvuleta/Documents/GitHub/switchboard/.agents/skills/query_kanban_plans.md) skill.
