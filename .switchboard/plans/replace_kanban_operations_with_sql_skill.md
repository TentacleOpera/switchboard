---
description: Replace complex kanban_operations skill with simple SQL-based query_switchboard_kanban skill
---

# Replace Kanban Operations Skill with SQL-Based Skill

## Goal
Replace the complex `kanban_operations` skill (Node scripts with workspace auto-discovery) with a simple `query_switchboard_kanban` skill that documents workspace ID file location, kanban.db location, and SQL queries for common operations.

## Metadata
**Tags:** infrastructure, documentation, workflow
**Complexity:** 5

## User Review Required
- [ ] Confirm whether move-card functionality should be preserved as a separate SQL query or removed entirely
- [x] SQL CLI: sqlite3 is the correct tool for SQLite databases (duckdb cannot read SQLite files without extensions)

## Complexity Audit

### Routine
- **Create new skill file:** Write `.agent/skills/query_switchboard_kanban.md` with clear documentation
- **Document workspace ID location:** Specify `.switchboard/workspace-id` file format (line 1: workspace ID, line 2: DB path)
- **Document kanban.db location:** Specify `.switchboard/kanban.db` as the default database path (with note about custom paths via VS Code settings)
- **Document SQL queries:** Provide ready-to-use SQL for common operations (get state, move card, get dependencies)
- **Preserve kanban-board.md fast path:** Document `.switchboard/kanban-board.md` as the fastest read path (no SQL needed)
- **Update workflow references:** Replace `kanban_operations` skill references in all 5 files:
  - `.agent/workflows/improve-plan.md` (line 20)
  - `.agent/workflows/accuracy.md` (line 62)
  - `.agent/rules/how_to_plan.md` (lines 16, 66)
  - `AGENTS.md` (lines 29, 65, 75)
  - `docs/TECHNICAL_DOC.md` (lines 434, 571-588, 685)
- **Deprecate old skill:** Move `.agent/skills/kanban_operations/` to `.agent/skills/deprecated/kanban_operations/`

### Complex / Risky
- **WorkspaceIdentityService file format change:** The `workspace-id` file currently contains a single line. Adding a second line for DB path requires fixing the comparison logic in `tryWriteCommittedWorkspaceIdIfDifferent()` — currently it reads the *entire trimmed file* and compares against `workspaceId`, which would break with multi-line content. Must change to read only line 1 for comparison. See `@/Users/patrickvuleta/Documents/GitHub/switchboard/src/services/WorkspaceIdentityService.ts:126-150`.
- **Move-card functionality:** The current skill has `move-card.js` for mutating kanban state. If this is still needed, must provide SQL UPDATE query pattern. If not needed, deprecation is simpler.
- **Stale DB path cache:** If user changes `switchboard.kanban.dbPath` in VS Code settings, the `workspace-id` file will have a stale path. Must also update the file when `invalidateWorkspace()` is called. See `@/Users/patrickvuleta/Documents/GitHub/switchboard/src/services/KanbanDatabase.ts:385-398`.
- **Backward compatibility:** Existing `workspace-id` files have only 1 line. Reading logic must handle both old (1-line) and new (2-line) formats gracefully.

## Edge-Case & Dependency Audit

**Race Conditions:**
- None expected for read-only SQL queries
- For move-card operations, concurrent UPDATE queries could race — but this is an existing issue with the current script approach
- `tryWriteCommittedWorkspaceIdIfDifferent()` could race with itself if called concurrently from multiple extension host callbacks — but this is pre-existing and mitigated by the comparison check

**Security:**
- SQL queries run against local database only — no remote access
- Workspace ID is a hex string, no injection risk if used as literal in queries
- **Clarification:** sqlite3 CLI does not support parameterized queries — values must be shell-escaped or validated. The skill must document safe usage patterns (e.g., using sqlite3's `.parameter` feature or validating inputs against regex)

**Side Effects:**
- Old skill deprecation removes the auto-discovery complexity entirely
- New skill requires agents to have sqlite3 CLI access (pre-installed on macOS, may need install on Linux)
- Move-card operations become direct SQL mutations instead of script-mediated (loses `VALID_KANBAN_COLUMNS` validation that `move-card.js` provides at `@/Users/patrickvuleta/Documents/GitHub/switchboard/.agent/skills/kanban_operations/move-card.js:15-19`)
- `workspace-id` file format change could confuse agents that read only line 1 — must document clearly

**Dependencies & Conflicts:**
- Active Kanban board query returned no cards in CREATED or BACKLOG columns that conflict with this plan.
- No related plans currently target the kanban_operations skill.
- This plan is a refactoring — no functional changes to kanban board behavior.
- The `kanban-board.md` fast path (auto-exported by `KanbanDatabase.exportStateToFile()`) must remain documented as the preferred read method for agents that don't need SQL filtering.

## Dependencies
- None

## Adversarial Synthesis
Key risks: (1) `workspace-id` file format change breaks the comparison logic in `tryWriteCommittedWorkspaceIdIfDifferent()` — must read only line 1 for comparison, not entire file; (2) 3 additional files reference `kanban_operations` beyond the 2 listed originally (accuracy.md, how_to_plan.md, TECHNICAL_DOC.md); (3) move-card SQL loses column validation that `move-card.js` currently provides. Mitigations: Fix comparison logic to split on newlines and compare only line 1; audit all 5 reference files; document valid column list in skill and recommend validation before UPDATE.

## Problem

The current `kanban_operations` skill is over-engineered:
- Complex Node.js scripts (`get-state.js`, `move-card.js`) requiring TypeScript compilation
- Workspace auto-discovery logic (`lib/workspaceDiscovery.js`) with 3-tier fallback strategy
- Environment variable parsing and VS Code settings.json reading
- All this complexity for what should be simple database queries

A simpler approach: document the SQL queries directly. The workspace ID is already stored in a simple text file, and kanban.db is a standard SQLite database. Agents can use sqlite3 CLI directly (pre-installed on macOS).

## Proposed Changes

### Execution Breakdown by Complexity

#### Low Complexity Steps

1. **Modify WorkspaceIdentityService to write database path**
   - **File:** `src/services/WorkspaceIdentityService.ts`
   - **Implementation:** Modify `tryWriteCommittedWorkspaceIdIfDifferent()` (lines 126-150) to:
     - Read only line 1 of the file for comparison (not entire trimmed content) — this is the critical fix
     - Write format: `workspaceId\n` on line 1, `dbPath\n` on line 2
     - Get DB path from `KanbanDatabase.forWorkspace(workspaceRoot).dbPath` (public getter at line 691-693)
     - Only write if workspace ID (line 1) differs from current value
     - Handle case where DB is not yet initialized (skip DB path line, write only workspace ID)
   - **Backward compatibility:** If file has only 1 line, treat as old format. Reading logic splits on `\n` and takes `lines[0]` for workspace ID, `lines[1]` for DB path (if present).

2. **Create new skill file**
   - **File:** `.agent/skills/query_switchboard_kanban.md` (new file)
   - **Implementation:** Document:
     - Workspace ID and database path location: `.switchboard/workspace-id` (two lines: ID on line 1, DB path on line 2)
     - SQL CLI: sqlite3 only (pre-installed on macOS; not duckdb — duckdb cannot read SQLite files without extensions)
     - kanban-board.md fast path for simple reads (no SQL needed)
     - Common SQL query patterns

3. **Document SQL query patterns**
   - **File:** `.agent/skills/query_switchboard_kanban.md`
   - **Implementation:** Provide ready-to-use SQL queries:
     - **Get workspace ID and DB path:** `head -n 2 .switchboard/workspace-id`
     - **Get all active plans by column:** `SELECT * FROM plans WHERE workspace_id = '<workspace_id>' AND status = 'active' AND kanban_column = '<column>'`
     - **Get plans for dependency check:** `SELECT plan_id, session_id, topic, kanban_column, dependencies FROM plans WHERE workspace_id = '<workspace_id>' AND status = 'active' AND kanban_column IN ('CREATED', 'BACKLOG', 'PLAN REVIEWED')`
     - **Move card (UPDATE):** `UPDATE plans SET kanban_column = '<target_column>', updated_at = datetime('now') WHERE session_id = '<session_id>' AND workspace_id = '<workspace_id>'`
     - **Get plan by session ID:** `SELECT * FROM plans WHERE session_id = '<session_id>' LIMIT 1`

4. **Update all workflow and documentation references**
   - **Files to update (5 total):**
     - `.agent/workflows/improve-plan.md` (line 20): Replace `node .agent/skills/kanban_operations/get-state.js` fallback with SQL query via new skill
     - `.agent/workflows/accuracy.md` (line 62): Replace `node .agent/skills/kanban_operations/move-card.js` with SQL UPDATE reference
     - `.agent/rules/how_to_plan.md` (lines 16, 66): Replace `kanban_operations` skill references with `query_switchboard_kanban` skill
     - `AGENTS.md` (lines 29, 65, 75): Replace all 3 `kanban_operations` references with new skill
     - `docs/TECHNICAL_DOC.md` (lines 434, 571-588, 685): Update skill documentation section

5. **Deprecate old skill**
   - **Action:** Move `.agent/skills/kanban_operations/` to `.agent/skills/deprecated/kanban_operations/`
   - **Rationale:** Keep for reference during migration, remove entirely after confirmation

#### High Complexity Steps

1. **Fix WorkspaceIdentityService comparison logic**
   - **File:** `src/services/WorkspaceIdentityService.ts`
   - **Function:** `tryWriteCommittedWorkspaceIdIfDifferent()` (lines 126-150)
   - **Current bug:** Line 135 reads `currentValue = (await fs.promises.readFile(committedPath, 'utf8')).trim()` then line 141 compares `currentValue !== workspaceId`. With multi-line file, `currentValue` includes the DB path line, so it will never match `workspaceId` alone.
   - **Fix:** Change line 135 to read only line 1: `currentValue = (await fs.promises.readFile(committedPath, 'utf8')).split('\n')[0]?.trim() ?? ''`
   - **Also:** Update `ensureWorkspaceIdentity()` (line 178) — same issue when reading from file for PRIORITY 2 check. Change to split on `\n` and take `lines[0]`.
   - **Also:** After writing workspace ID, also write DB path as line 2. Get path from `KanbanDatabase.forWorkspace(resolvedRoot).dbPath`.

2. **Update kanban-board.md export on DB path change**
   - **File:** `src/services/KanbanDatabase.ts`
   - **Function:** `invalidateWorkspace()` (lines 385-398)
   - **Change:** After invalidating the cached instance, also rewrite the `workspace-id` file with the new DB path. Call `ensureWorkspaceIdentity()` which will now write both lines.

3. **Preserve move-card functionality if needed**
   - **Decision:** If move-card is still used, document SQL UPDATE query pattern in new skill
   - **Fallback:** If move-card is rarely used, remove it and document as deprecated
   - **Note:** Move-card SQL loses `VALID_KANBAN_COLUMNS` validation. The skill must list valid columns and recommend checking before UPDATE.

### Proposed Code Changes

#### New File: `.agent/skills/query_switchboard_kanban.md`

```markdown
---
name: Query Switchboard Kanban
description: Query kanban state using direct SQL access to kanban.db
---

# Query Switchboard Kanban

Query kanban board state and move cards using direct SQL access to the kanban database.

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
# Read both values
WORKSPACE_ID=$(head -n 1 .switchboard/workspace-id)
DB_PATH=$(head -n 2 .switchboard/workspace-id | tail -n 1)

# Fallback if DB_PATH is empty (old format file)
if [ -z "$DB_PATH" ]; then
  DB_PATH=".switchboard/kanban.db"
fi
```

- **Line 1**: Workspace ID (hex string like `038bffef-9842-4574-96a1-69a43a280b3c`)
- **Line 2**: Database path (absolute path to kanban.db; empty if using default location)

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

### Move Card to Different Column

⚠️ **Validate column name before updating.** Valid columns: CREATED, BACKLOG, PLAN REVIEWED, CONTEXT GATHERER, LEAD CODED, CODER CODED, CODE REVIEWED, CODED, COMPLETED

```sql
UPDATE plans
SET kanban_column = '<target_column>',
    updated_at = datetime('now')
WHERE session_id = '<session_id>' 
  AND workspace_id = '<workspace_id>';
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
# Read workspace ID and database path
WORKSPACE_ID=$(head -n 1 .switchboard/workspace-id)
DB_PATH=$(head -n 2 .switchboard/workspace-id | tail -n 1)

# Fallback to default path
[ -z "$DB_PATH" ] && DB_PATH=".switchboard/kanban.db"

# Get plans in BACKLOG column
sqlite3 "$DB_PATH" "SELECT plan_id, session_id, topic, kanban_column FROM plans WHERE workspace_id = '$WORKSPACE_ID' AND status = 'active' AND kanban_column = 'BACKLOG' ORDER BY updated_at DESC;"

# Move a card
sqlite3 "$DB_PATH" "UPDATE plans SET kanban_column = 'CODER CODED', updated_at = datetime('now') WHERE session_id = 'sess_1234567890' AND workspace_id = '$WORKSPACE_ID';"
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

### config Table

| Column | Type | Description |
|--------|------|-------------|
| key | TEXT PRIMARY KEY | Configuration key |
| value | TEXT | Configuration value |

**Key:** `workspace_id` stores the workspace identifier.
```

#### Modified File: `.agent/workflows/improve-plan.md`

Replace line 20:
```markdown
- Query active Kanban plans for dependencies using query_switchboard_kanban skill: read workspace ID from `.switchboard/workspace-id` (line 1), DB path from line 2 (fallback: `.switchboard/kanban.db`), then run SQL query against the database. Inspect CREATED and BACKLOG columns for conflicts; exclude COMPLETED, LEAD CODED, CODER CODED, and CODE REVIEWED columns. Use SQL: `SELECT plan_id, session_id, topic, kanban_column, dependencies FROM plans WHERE workspace_id = '<workspace_id>' AND status = 'active' AND kanban_column IN ('CREATED', 'BACKLOG', 'PLAN REVIEWED') ORDER BY updated_at DESC;`. If query fails, note uncertainty in Edge-Case & Dependency Audit.
```

#### Modified File: `.agent/workflows/accuracy.md`

Replace line 62:
```markdown
- If phase 5 succeeded but workflow state still appears active, use the Kanban UI to manually move the card to the appropriate column, or run: `sqlite3 <db_path> "UPDATE plans SET kanban_column = 'COMPLETED', updated_at = datetime('now') WHERE session_id = '<session_id>' AND workspace_id = '<workspace_id>';"`
```

#### Modified File: `.agent/rules/how_to_plan.md`

Replace lines 16 and 66 — change all `kanban_operations` skill references to `query_switchboard_kanban` skill with SQL query instructions.

#### Modified File: `AGENTS.md`

Replace line 29:
```markdown
4. **Fast Kanban Resolution**: If the user asks about plans in specific Kanban columns (e.g. "update all created plans"), you MUST use the `query_switchboard_kanban` skill (read `.switchboard/workspace-id` for ID and DB path, then query with sqlite3) to instantly identify the target plans.
```

Replace line 65:
```markdown
Conversational routing: when the intent is to advance a kanban card or send a plan to the next agent/stage, prefer the `query_switchboard_kanban` skill (use SQL: `UPDATE plans SET kanban_column = '<target>' WHERE session_id = '<session_id>'`) over raw `send_message`. The `target` may be a kanban column label, a built-in role, or a kanban-enabled custom agent name; generic conversational `coded` / `team` targets are smart-routed by plan complexity.
```

Replace line 75 (skills table):
```markdown
| `query_switchboard_kanban` | Query kanban state or move cards via direct SQL access to kanban.db |
```

#### Modified File: `docs/TECHNICAL_DOC.md`

Update lines 434, 571-588, 685 — replace `kanban_operations` skill section with `query_switchboard_kanban` skill documentation referencing sqlite3 CLI and SQL queries.

## Verification Plan

### Automated Tests
- [ ] Verify new skill file exists and is readable
- [ ] Test SQL queries against actual kanban.db: `sqlite3 .switchboard/kanban.db "SELECT COUNT(*) FROM plans WHERE status = 'active';"`
- [ ] Verify workspace-id file read logic handles both 1-line and 2-line formats
- [ ] Verify `tryWriteCommittedWorkspaceIdIfDifferent()` only compares line 1 (not entire file)
- [ ] Grep for any remaining `kanban_operations` references after all updates (should find zero outside deprecated/)

### Manual Verification
- [ ] Run dependency check using new skill in improve-plan workflow
- [ ] Verify move-card SQL query works (if preserved): `sqlite3 <db_path> "UPDATE plans SET kanban_column = 'BACKLOG', updated_at = datetime('now') WHERE session_id = 'test_session';"`
- [ ] Confirm old skill directory moved to deprecated/
- [ ] Test AGENTS.md reference in actual agent conversation
- [ ] Verify workspace-id file contains both ID and DB path after WorkspaceIdentityService modification
- [ ] Test with custom database path configured in VS Code settings to ensure DB path is written correctly
- [ ] Verify `kanban-board.md` fast path still works (auto-export should continue unchanged)
- [ ] Verify `invalidateWorkspace()` rewrites workspace-id file with new DB path

## Recommendation

**Send to Coder** — Complexity 5. This is primarily a documentation and refactoring task with one targeted code fix in `WorkspaceIdentityService.ts`. The core change (split-on-newline comparison) is a 2-line fix. The rest is creating a new skill file and updating references across 5 documentation files.
