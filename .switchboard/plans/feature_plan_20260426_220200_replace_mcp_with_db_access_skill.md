# Replace MCP Operations with Direct DB Access Skill

## Goal

Replace the failing MCP tools (`move_kanban_card`, `get_kanban_state`, `query_plan_archive`, `search_archive`) with direct DuckDB operations. IPC will never work reliably—stop trying to make it work and just use the database directly.

## Metadata

**Tags:** backend, database, reliability
**Complexity:** 4
**Repo:** 

## User Review Required

> [!NOTE]
> This plan DELETES MCP tools. After implementation, agents will use `KanbanDatabase` directly. Update any agent prompts that reference the deleted MCP tools.

## Complexity Audit

### Routine
- Export `VALID_KANBAN_COLUMNS` from KanbanDatabase
- Create thin wrapper functions for direct DB access
- Delete MCP tool registrations for replaced tools
- Update agent prompts to use direct DB calls

### Complex / Risky
- None

## Edge-Case & Dependency Audit

- **Race Conditions:** Not applicable—single-field updates are atomic.
- **Security:** No PII in kanban. Column validation uses existing `VALID_KANBAN_COLUMNS` set.
- **Side Effects:** These operations already had no side effects (just UPDATE kanban_column = ?).
- **Dependencies & Conflicts:** This touches `KanbanDatabase.ts` which is also modified by `sess_1777182256190` (Fix Slow Plan Registration). Coordinate to avoid merge conflicts on `_persistedUpdate`.

## Dependencies

None

## Adversarial Synthesis

### Grumpy Critique

Wait, you're just... deleting the MCP tools? And calling the database directly? That's it?

**1. "But What About Consistency?"**
What if some agents still try to use the old MCP tools? They'll get "tool not found" errors. Have you thought about migration?

**2. "But What About Testing?"**
How do you know this works? Where are the tests?

**3. "But What About Future Flexibility?"**
What if you want to add side effects later? Now everything goes directly to the DB.

### Balanced Response

**1. Migration**
The plan includes updating agent prompts. The MCP tools being deleted are broken anyway (IPC doesn't work), so "tool not found" is no worse than "IPC connection failed."

**2. Testing**
The wrapper functions are thin delegations to `KanbanDatabase` methods that are already tested. The risk surface is minimal.

**3. Future Flexibility**
The kanban column is just a varchar field. If side effects are needed later, they can be added to `KanbanDatabase.updateColumn()` itself—where they should have been all along.

## Proposed Changes

### 1. Export VALID_KANBAN_COLUMNS

#### MODIFY `src/services/KanbanDatabase.ts`

Add `export` to the existing constant:

```typescript
// Around line 207
export const VALID_KANBAN_COLUMNS = new Set([
  'CREATED', 'BACKLOG', 'PLAN REVIEWED', 'CONTEXT GATHERER', 
  'LEAD CODED', 'CODER CODED', 'CODE REVIEWED', 'CODED', 'COMPLETED'
]);
```

### 2. Delete MCP Tools

#### MODIFY `src/mcp-server/register-tools.js` (or equivalent)

Remove registrations for:
- `move_kanban_card`
- `get_kanban_state`
- `query_plan_archive`
- `search_archive`

Delete the handler functions if they exist in separate files (e.g., `src/mcp-server/tools/kanbanTools.ts`).

### 4. Create Skills (With Executable Scripts)

Skills are directories in `.agent/skills/` containing both documentation (SKILL.md) and executable scripts. The skill doc tells agents which script to run with which arguments.

#### CREATE `.agent/skills/kanban_operations/SKILL.md`

```markdown
---
name: Kanban Operations
description: Move kanban cards and query kanban state via direct database access.
---

# Kanban Operations

Move cards and query kanban state by running the provided scripts.

## Move a Card

```bash
node .agent/skills/kanban_operations/move-card.js <session_id> <target_column>
```

**Example:**
```bash
node .agent/skills/kanban_operations/move-card.js sess_1777206335666 CODER_CODED
```

**Valid columns:** CREATED, BACKLOG, PLAN REVIEWED, CONTEXT GATHERER, LEAD CODED, CODER CODED, CODE REVIEWED, CODED, COMPLETED

## Get Kanban State

```bash
node .agent/skills/kanban_operations/get-state.js <workspace_id>
```

**Example:**
```bash
node .agent/skills/kanban_operations/get-state.js my-workspace-123
```

Outputs JSON with columns as keys and arrays of plans as values.
```

#### CREATE `.agent/skills/kanban_operations/move-card.js`

```javascript
const { KanbanDatabase } = require('../../../src/services/KanbanDatabase');

const sessionId = process.argv[2];
const targetColumn = process.argv[3];

if (!sessionId || !targetColumn) {
  console.error('Usage: node move-card.js <session_id> <target_column>');
  process.exit(1);
}

const VALID_COLUMNS = new Set([
  'CREATED', 'BACKLOG', 'PLAN REVIEWED', 'CONTEXT GATHERER',
  'LEAD CODED', 'CODER CODED', 'CODE REVIEWED', 'CODED', 'COMPLETED'
]);

if (!VALID_COLUMNS.has(targetColumn)) {
  console.error(`Invalid column: ${targetColumn}`);
  console.error(`Valid columns: ${Array.from(VALID_COLUMNS).join(', ')}`);
  process.exit(1);
}

const db = new KanbanDatabase('.');
db.ensureReady().then(async () => {
  const success = await db.updateColumn(sessionId, targetColumn);
  console.log(success ? 'OK' : 'FAILED');
  process.exit(success ? 0 : 1);
}).catch(err => {
  console.error(err);
  process.exit(1);
});
```

#### CREATE `.agent/skills/kanban_operations/get-state.js`

```javascript
const { KanbanDatabase } = require('../../../src/services/KanbanDatabase');

const workspaceId = process.argv[2] || '.';

const db = new KanbanDatabase('.');
db.ensureReady().then(async () => {
  const columns = {};
  const columnNames = ['CREATED', 'BACKLOG', 'PLAN REVIEWED', 'CONTEXT GATHERER',
    'LEAD CODED', 'CODER CODED', 'CODE REVIEWED', 'CODED', 'COMPLETED'];
  
  for (const col of columnNames) {
    columns[col] = await db.getPlansByColumn(workspaceId, col);
  }
  
  console.log(JSON.stringify({
    workspaceId,
    timestamp: new Date().toISOString(),
    columns
  }, null, 2));
  
  process.exit(0);
}).catch(err => {
  console.error(err);
  process.exit(1);
});
```

#### CREATE `.agent/skills/query_archive/SKILL.md`

```markdown
---
name: Query Archive
description: Query the DuckDB archive directly using duckdb CLI.
---

# Query Archive

Query archived plans using the DuckDB CLI directly.

## Basic Query

```bash
cd /Users/patrickvuleta/Documents/GitHub/switchboard && duckdb .switchboard/archive.duckdb "SELECT * FROM plans LIMIT 10"
```

## Common Queries

**Find high complexity plans:**
```bash
duckdb .switchboard/archive.duckdb "SELECT topic, complexity, created_at FROM plans WHERE complexity = 'High' ORDER BY created_at DESC LIMIT 20"
```

**Search by topic:**
```bash
duckdb .switchboard/archive.duckdb "SELECT * FROM plans WHERE topic ILIKE '%database%'"
```

**Count by complexity:**
```bash
duckdb .switchboard/archive.duckdb "SELECT complexity, COUNT(*) FROM plans GROUP BY complexity"
```

## Output Formats

**JSON:**
```bash
duckdb .switchboard/archive.duckdb -json "SELECT * FROM plans LIMIT 5"
```

**CSV:**
```bash
duckdb .switchboard/archive.duckdb -csv "SELECT * FROM plans LIMIT 5"
```
```

### 5. Delete MCP Tool References from Agent Prompts

Remove references to these MCP tools from all agent prompts:
- `move_kanban_card`
- `get_kanban_state`
- `query_plan_archive`
- `search_archive`

Replace with references to the new skills: `kanban_operations`, `query_archive`

## Verification Plan

### Manual Verification

1. Start Switchboard extension
2. Run the skill script to move a card:
   ```bash
   node .agent/skills/kanban_operations/move-card.js sess_123 CODER_CODED
   ```
3. Verify the card moved in the Kanban panel
4. Run the skill script to query state:
   ```bash
   node .agent/skills/kanban_operations/get-state.js my-workspace
   ```

## Success Criteria

1. MCP tools `move_kanban_card`, `get_kanban_state`, `query_plan_archive`, `search_archive` are deleted
2. Skills `kanban_operations` and `query_archive` exist in `.agent/skills/`
3. Agents can move cards by running `node .agent/skills/kanban_operations/move-card.js <session_id> <column>`
4. Agents can query state by running `node .agent/skills/kanban_operations/get-state.js <workspace_id>`
5. Agents can query archive using duckdb CLI commands from the skill doc
6. Kanban panel reflects changes immediately
7. Old skill `.agent/skills/get_kanban_state/` directory is removed or updated

## Completion Status

**Status:** COMPLETED (with reviewer fixes applied)

**Files Changed:**
- `src/services/KanbanDatabase.ts` - Exported `VALID_KANBAN_COLUMNS`
- `src/mcp-server/register-tools.js` - Deleted 4 MCP tools (`move_kanban_card`, `get_kanban_state`, `query_plan_archive`, `search_archive`), updated `init_workspace` description
- `.agent/skills/kanban_operations/SKILL.md` - Created (updated by reviewer: valid columns now reference `VALID_KANBAN_COLUMNS` export)
- `.agent/skills/kanban_operations/move-card.js` - Created (fixed by reviewer: require path `src/` → `out/`, imported `VALID_KANBAN_COLUMNS` instead of hardcoding, added `db.close()`)
- `.agent/skills/kanban_operations/get-state.js` - Created (fixed by reviewer: require path `src/` → `out/`, imported `VALID_KANBAN_COLUMNS` instead of hardcoding, added `db.close()`)
- `.agent/skills/query_archive/SKILL.md` - Created (fixed by reviewer: removed hardcoded absolute path, uses workspace-relative path)
- `.agent/skills/get_kanban_state/` - Removed
- `AGENTS.md` - Fixed by reviewer: replaced `get_kanban_state` MCP tool reference with `kanban_operations` skill, replaced `move_kanban_card` reference with skill script
- `docs/TECHNICAL_DOC.md` - Fixed by reviewer: replaced Section 18 "MCP Kanban tools" with "Kanban skill scripts (replaces former MCP tools)", updated 3 additional references to deleted tools
- `.agent/workflows/challenge.md` - Fixed by reviewer: replaced `get_kanban_state` MCP tool reference with `kanban_operations` skill script
- `.agent/workflows/archive.md` - Fixed by reviewer: replaced `query_plan_archive` and `search_archive` MCP tool references with duckdb CLI commands
- `.agent/workflows/export.md` - Fixed by reviewer: replaced `search_archive` MCP tool reference with duckdb CLI reference
- `.agent/workflows/improve-plan.md` - Fixed by reviewer: replaced `get_kanban_state` MCP tool references with `kanban_operations` skill script
- `.agent/rules/how_to_plan.md` - Fixed by reviewer: replaced `get_kanban_state` MCP tool references with `kanban_operations` skill script
- `.agent/skills/archive.md` - Fixed by reviewer: replaced all `query_plan_archive` and `search_archive` MCP tool references with duckdb CLI commands

**Validation Results:**
- All 4 MCP tools successfully removed from register-tools.js ✓
- Skill scripts reference `out/services/KanbanDatabase.js` (compiled JS, not TypeScript source) ✓
- `VALID_KANBAN_COLUMNS` constant imported from compiled output in both scripts ✓
- Both scripts pass `node --check` syntax validation ✓
- `KanbanDatabase.prototype.updateColumn` and `getPlansByColumn` confirmed as functions ✓
- AGENTS.md no longer references deleted MCP tools ✓
- TECHNICAL_DOC.md Section 18 updated to reflect skill scripts ✓
- query_archive SKILL.md no longer contains hardcoded absolute paths ✓

**Reviewer Findings (Fixed):**
- CRITICAL-1: Scripts required `src/services/KanbanDatabase` (TypeScript, not compilable by Node). Fixed to `out/services/KanbanDatabase`.
- CRITICAL-2: Scripts hardcoded `VALID_COLUMNS` instead of importing the exported `VALID_KANBAN_COLUMNS`. Fixed to import from compiled output.
- MAJOR-1: `AGENTS.md` still referenced `get_kanban_state` and `move_kanban_card` MCP tools. Fixed with skill script references.
- MAJOR-2: 6 workflow/rule/skill files still referenced deleted MCP tools (`get_kanban_state`, `query_plan_archive`, `search_archive`). Fixed in `.agent/workflows/challenge.md`, `.agent/workflows/archive.md`, `.agent/workflows/export.md`, `.agent/workflows/improve-plan.md`, `.agent/rules/how_to_plan.md`, `.agent/skills/archive.md`. Also fixed 3 additional references in `docs/TECHNICAL_DOC.md`.
- MAJOR-3: `docs/TECHNICAL_DOC.md` Section 18 documented deleted MCP tools as existing. Replaced with skill script documentation.
- MAJOR-4: `AGENTS.md` Available Skills table was missing `kanban_operations`, `query_archive`, and `complexity_scoring`. Added all three.
- NIT-1: `query_archive/SKILL.md` hardcoded absolute path `/Users/patrickvuleta/...`. Fixed to workspace-relative path.

**Remaining Risks:**
- The `VALID_KANBAN_COLUMNS` set in `KanbanDatabase.ts` does not include `INTERN CODED` or `ACCEPTANCE TESTED`, which are valid built-in columns defined in `BUILTIN_KANBAN_COLUMN_DEFINITIONS` in `register-tools.js`. The scripts will reject moves to these columns. This is a pre-existing discrepancy (the export was already missing these columns before this plan), but agents using `INTERN CODED` or `ACCEPTANCE TESTED` via the skill will get "Invalid column" errors.
