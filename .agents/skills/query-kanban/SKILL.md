# Query Kanban

Read kanban board state. The **primary method is the LocalApiServer's read
endpoints** — they return records with resolved column labels, so the caller
never has to know the storage-id mapping. **Direct SQL is a fallback** for the
case where the API server is unreachable but a local `kanban.db` exists. This
skill is READ-ONLY — never run SQL `UPDATE`/`DELETE`/`INSERT` on the kanban
database.

## Preconditions

| Need | How to check | What to do when absent |
| :--- | :--- | :--- |
| **LocalApiServer** (preferred) | `.switchboard/api-server-port.txt` exists **and** `GET http://127.0.0.1:<port>/health` responds `ok` | Fall back to SQL (below) **only if** a local `kanban.db` is present. If neither is reachable, **stop**: report that the board database is not reachable from this session — this is expected in a cloud, standalone-without-board, or tracker-only session, not a fault — and do **not** hand-write SQL, invent a database path, or declare the system broken. |

A configured channel is not a reachable one: a port file that is stale, or a
health check that fails, means the server is down — treat it the same as
absent. Probe at point of use, not at session start (a probe made once goes
stale the moment the extension restarts).

## Primary method — read endpoints

When the LocalApiServer is reachable, use these. They return records with
resolved column labels, so the label↔storage-id trap below does not apply on
this path. The **full endpoint contract** (verbs, payload fields, response
envelopes) lives in the `switchboard-orchestration` protocol at
`.agents/protocols/switchboard-orchestration/SKILL.md` — consult it for any
call this table does not cover, and hit `GET /catalog` for the generated
inventory of every endpoint the server serves.

```bash
PORT=$(cat .switchboard/api-server-port.txt); BASE="http://127.0.0.1:$PORT"
curl -s "$BASE/health"                      # liveness — confirm before any call
```

| Need | Endpoint | Returns |
| :--- | :--- | :--- |
| Whole board | `GET /kanban/board` | Every active plan record for the workspace |
| Plans in one column | `GET /kanban/plans?column=<col>` | Plans filtered to one column (`column` takes the storage id; see mapping below, or `GET /kanban/columns` for the live `{id,label}` list) |
| One plan + its file content | `GET /kanban/plan?planId=<id>` | One plan record plus the full `.md` body (`.data.content`) |
| All features | `GET /kanban/features` | Every `isFeature` row |
| Subtasks of a feature | `GET /kanban/plans?featureId=<id>` | The feature's subtask records |
| Column vocabulary (built-in + custom) | `GET /kanban/columns` | `{ builtIn, custom, displayOnly }` — `{id,label}` for every column, so you never guess a label |

```bash
curl -s "$BASE/kanban/board" | jq '.data'
curl -s "$BASE/kanban/plans?column=PLAN%20REVIEWED" | jq '.data'
curl -s "$BASE/kanban/plan?planId=a1b2c3d4" | jq '.data.content'
curl -s "$BASE/kanban/features" | jq '.data'
curl -s "$BASE/kanban/plans?featureId=$FEATURE_ID" | jq '.data'
curl -s "$BASE/kanban/columns" | jq '.data'
```

Plan records include `planId`, `sessionId`, `topic`, `planFile`, `kanbanColumn`,
`status`, `complexity`, `tags`, `project`, `isFeature`, `featureId`,
`worktreeId`, `worktreeStatus`, `dispatchedAt`, `recommendedRole`. Filter and
aggregate client-side with `jq` — the endpoints return the records; you do not
need SQL for any of the common queries below.

> **Fast path, no server either:** the board auto-exports its current state to
> `.switchboard/kanban-board.md` on every change. For a simple glance, `read_file
> <workspace_root>/.switchboard/kanban-board.md` is enough and needs no server.

## Fallback — direct SQL (only when the API server is unreachable)

Use this path **only** when the LocalApiServer is not reachable and a local
`kanban.db` exists. It is the no-API escape hatch, not the default. SQL returns
storage ids, not labels, so the column mapping below is load-bearing on this
path — the endpoints spare you it.

### Get Workspace ID and Database Path

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

### Common SQL Queries

#### Get All Active Plans in a Column

```sql
SELECT plan_id, session_id, topic, kanban_column, status, complexity
FROM plans
WHERE workspace_id = '<workspace_id>' 
  AND status = 'active' 
  AND kanban_column = '<column_name>'
ORDER BY updated_at DESC;
```

**Valid columns:** CREATED, BACKLOG, PLAN REVIEWED, CONTEXT GATHERER, LEAD CODED, CODER CODED, CODE REVIEWED, CODED, COMPLETED

#### Get Plans for Dependency Check (CREATED, BACKLOG, PLAN REVIEWED)

```sql
SELECT plan_id, session_id, topic, kanban_column, dependencies
FROM plans
WHERE workspace_id = '<workspace_id>' 
  AND status = 'active' 
  AND kanban_column IN ('CREATED', 'BACKLOG', 'PLAN REVIEWED')
ORDER BY updated_at DESC;
```

#### Get Plan by Session ID

```sql
SELECT *
FROM plans
WHERE session_id = '<session_id>'
LIMIT 1;
```

#### Get Full Board State (All Active Plans)

```sql
SELECT *
FROM plans
WHERE workspace_id = '<workspace_id>' 
  AND status = 'active'
ORDER BY kanban_column, updated_at DESC;
```

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

## Column labels vs storage ids (SQL fallback only)

### ⚠️ Users say the BOARD LABEL, not the stored column id — translate silently

The `kanban_column` values above are **storage ids**. They are NOT what the user sees on the
board, and they are NOT what the user will say to you. When a user names a column, they mean the
label. Map it and move on — **never** reply that a column "doesn't exist" or list the storage ids
back at them. That is a bug in your response, not a correction.

> **On the endpoint path this trap does not apply:** `GET /kanban/columns`
> returns `{id,label}` for every column, and `GET /kanban/plans` returns records
> you filter by `id`. You resolve the label once via the columns endpoint rather
> than memorizing the table below. The mapping is kept here for the SQL fallback.

| Board label (what the user says) | `kanban_column` (what you query) |
| :--- | :--- |
| **New** | `CREATED` |
| **Backlog** | `BACKLOG` *(display mode of `CREATED`)* |
| **Planned** | `PLAN REVIEWED` |
| **Dispatch** | `DISPATCH` *(display mode of `PLAN REVIEWED`)* |
| **Researcher** | `RESEARCHER` |
| **Lead Coder** | `LEAD CODED` |
| **Coder** | `CODER CODED` |
| **Intern** | `INTERN CODED` |
| **Reviewed** | `CODE REVIEWED` |
| **Acceptance Tested** | `ACCEPTANCE TESTED` |
| **Ticket Updater** | `TICKET UPDATER` |
| **Completed** | `COMPLETED` |

**Three traps — guessing gets these wrong:**
- **"Planned" is `PLAN REVIEWED`.** There is no column stored as `PLANNED`.
- **"Reviewed" is `CODE REVIEWED`, not `PLAN REVIEWED`.** The label that *looks* like `PLAN REVIEWED`
  belongs to a different column. Resolving "Reviewed" to `PLAN REVIEWED` reads the wrong column, and
  on a write path moves cards backwards through the workflow.
- **"New" is `CREATED`.** Nothing is stored as `NEW`.

**Custom columns:** users can add their own, with labels this table cannot cover. The authoritative
live mapping is `GET /kanban/columns`, which returns `{id, label}` for built-in and custom columns
alike. Source of truth in code is `DEFAULT_KANBAN_COLUMNS` / `DISPLAY_MODE_COLUMNS` in
`src/services/agentConfig.ts` — if this table ever disagrees with that file, the file wins and this
table is stale.

**If a label is genuinely ambiguous**, query the closest match and say which column you read
(*"Planned (`PLAN REVIEWED`) has 3 plans"*) — one clause, then the answer. Do not open with a
correction, and do not ask the user to restate the column in storage terms.

## Schema Reference (SQL fallback only)

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
| is_feature | INTEGER | 1 if this plan is a feature, 0 otherwise |
| feature_id | TEXT | Parent feature plan_id if this is a subtask |
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

## Ready-Made Query Templates (SQL fallback only)

Ready-made SQL templates for querying the Switchboard Kanban `plans` table by workspace name, project, and feature/subtask relationships. On the endpoint path, the equivalents are `GET /kanban/board` (filter with `jq`), `GET /kanban/plans?featureId=<id>`, and `GET /kanban/features`.

### Discovering Workspace Names

Run this query first to identify the human-readable workspace names present in the database:

```sql
SELECT DISTINCT workspace_name FROM plans WHERE workspace_name != '';
```

---

### Workspace Name Queries

#### Find all active plans in a workspace by name

```sql
SELECT plan_id, topic, kanban_column, complexity, project
FROM plans
WHERE workspace_name = 'Autism360App' AND status = 'active';
```

---

### Project Queries

#### Find all plans assigned to a specific project in a workspace

```sql
SELECT plans.plan_id, plans.topic, plans.kanban_column
FROM plans
JOIN projects ON plans.project_id = projects.id
WHERE projects.name = 'MyProject' AND plans.workspace_name = 'Autism360App' AND plans.status = 'active';
```

#### Find all unassigned plans in a workspace

```sql
SELECT plan_id, topic, kanban_column
FROM plans
WHERE project_id IS NULL AND workspace_name = 'Autism360App' AND status = 'active';
```

---

### Feature and Subtask Queries

#### List all features in a workspace

```sql
SELECT plan_id, topic, kanban_column
FROM plans
WHERE is_feature = 1 AND workspace_name = 'Autism360App' AND status = 'active';
```

#### Find all subtasks for a specific feature

```sql
SELECT plan_id, topic, kanban_column, status
FROM plans
WHERE feature_id = '<feature_plan_id>' AND workspace_name = 'Autism360App' AND status = 'active';
```

#### Get all features with their active subtask counts

```sql
SELECT feature.plan_id AS feature_id, feature.topic AS feature_topic, COUNT(sub.plan_id) AS subtask_count
FROM plans feature
LEFT JOIN plans sub ON sub.feature_id = feature.plan_id AND sub.status = 'active'
WHERE feature.is_feature = 1 AND feature.workspace_name = 'Autism360App' AND feature.status = 'active'
GROUP BY feature.plan_id, feature.topic;
```

---

### Plan Type & Classification Queries

#### Count plans by column type for a workspace

```sql
SELECT kanban_column, COUNT(*) AS count
FROM plans
WHERE workspace_name = 'Autism360App' AND status = 'active'
GROUP BY kanban_column;
```
