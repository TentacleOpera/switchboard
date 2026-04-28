# Archive Operations Skill

## Purpose
Query and manage the DuckDB archive of historical plans and conversations.

## When to Use
- User asks to "search archives", "query archives", "find old plans", "export conversation"
- User wants historical research across past plans
- User wants to export a conversation for later reference

## Available Methods

### 1. DuckDB CLI (replaces `query_plan_archive`)
**Use when**: User wants to search/query archived plans with specific criteria

**Usage** (see `.agent/skills/query_archive/SKILL.md` for full reference):
```bash
duckdb .switchboard/archive.duckdb "<SQL_QUERY>"
```

**Example queries**:
```bash
duckdb .switchboard/archive.duckdb "SELECT * FROM plans WHERE complexity = 'High'"
duckdb .switchboard/archive.duckdb "SELECT topic, kanban_column, created_at FROM plans ORDER BY archived_at DESC LIMIT 10"
duckdb .switchboard/archive.duckdb -json "SELECT * FROM plans WHERE topic ILIKE '%database%'"
```

**Security**: Only SELECT queries allowed. Blocked keywords: COPY, ATTACH, CREATE, DROP, INSERT, UPDATE, DELETE, etc.

### 2. DuckDB CLI keyword search (replaces `search_archive`)
**Use when**: User wants simple keyword search (easier than writing SQL)

**Usage**:
```bash
duckdb .switchboard/archive.duckdb "SELECT * FROM plans WHERE topic ILIKE '%<keyword>%' LIMIT 10"
```

**Example**:
```bash
duckdb .switchboard/archive.duckdb "SELECT * FROM plans WHERE topic ILIKE '%database optimization%' LIMIT 10"
duckdb .switchboard/archive.duckdb "SELECT * FROM plans WHERE topic ILIKE '%authentication%' LIMIT 10"
```

### 3. `export_conversation`
**Use when**: User wants to save current conversation to archive

**Parameters**:
- `file_path` (required): Absolute path to temp markdown file containing conversation
- `metadata` (optional): 
  - `conversation_date`: YYYY-MM-DD
  - `topic`: Short summary
  - `project`: Project name
  - `tags`: Array of tags

**Note**: File must be in system temp directory. File is deleted after successful export.

## Archive Configuration

**Archive Path**: `.switchboard/archive.duckdb` (local) or cloud-synced path

**Tables**:
- `plans` - Archived plan metadata (plan_id, topic, complexity, kanban_column, created_at, etc.)
- `conversations` - Exported conversations (id, title, content, tags, project, etc.)
- `archive_metadata` - Schema version tracking

## Common User Phrases → Method Mapping

| User says | Use method |
|-----------|------------|
| "search the archives for X" | `duckdb .switchboard/archive.duckdb "SELECT * FROM plans WHERE topic ILIKE '%X%' LIMIT 10"` |
| "query the archive" | `duckdb .switchboard/archive.duckdb "<SQL>"` |
| "find old plans about X" | `duckdb .switchboard/archive.duckdb "SELECT * FROM plans WHERE topic ILIKE '%X%'"` |
| "export this conversation" | `export_conversation` (write conversation to temp file first) |
| "show me completed plans" | `duckdb .switchboard/archive.duckdb "SELECT * FROM plans WHERE kanban_column = 'COMPLETED'"` |
| "what high complexity plans exist" | `duckdb .switchboard/archive.duckdb "SELECT * FROM plans WHERE complexity = 'High'"` |

## Error Handling

- **"Archive not configured"**: Archive path not set in `.vscode/settings.json` under `switchboard.archive.dbPath`
- **"No archive database found"**: Database file doesn't exist yet (no plans archived)
- **"Only SELECT queries allowed"**: User tried non-SELECT query (blocked for security)
- **"Blocked keyword detected"**: Query contains dangerous keywords (COPY, ATTACH, etc.)

## Example Workflow

**User**: "Find all high complexity plans from last month"

**You**:
1. Run:
   ```bash
   duckdb .switchboard/archive.duckdb "SELECT topic, complexity, created_at, kanban_column FROM plans WHERE complexity = 'High' ORDER BY created_at DESC LIMIT 20"
   ```
2. Present results to user

**User**: "Export this conversation"

**You**:
1. Write conversation content to temp file (e.g., `/tmp/conversation_20260330.md`)
2. Call `export_conversation` with:
   - `file_path`: "/tmp/conversation_20260330.md"
   - `metadata`: { topic: "Archive setup", project: "switchboard", tags: ["setup", "duckdb"] }
3. Confirm export success to user

## Skills Registry

| Skill Name | Description |
|------------|-------------|
| `architectural_diagrams` | Generate Mermaid architectural diagrams, render to images, and upload to ClickUp/Linear tickets for team review |
| `archive` | Query and manage the DuckDB archive of historical plans and conversations |

## Related Files
- Schema: `src/services/archiveSchema.sql`
- Service: `src/services/ArchiveManager.ts`
- Tools: `src/mcp-server/register-tools.js` (archive MCP tools removed; use `.agent/skills/query_archive/` instead)
- Config: `.vscode/settings.json` → `switchboard.archive.dbPath`
