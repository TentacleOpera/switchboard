# Archive Query Workflow

## Trigger
- `/archive` - Query or search the plan archive

## Purpose
Enable historical research across archived plans using the DuckDB archive database.

## Steps

### For `/archive` (Query Mode)

1. **Clarify the query intent** (if not already specified)
   - What is the user looking for? (topic, complexity, date range, status)
   - Example: "What specific plans are you looking for?"

2. **Choose the right approach**
   - Simple keyword search → use `duckdb` CLI with `ILIKE` (see `.agent/skills/query_archive/SKILL.md`)
   - Specific filtering/sorting → use `duckdb` CLI with SQL query (see `.agent/skills/query_archive/SKILL.md`)

3. **Execute the query**
   - Run the appropriate `duckdb` CLI command against `.switchboard/archive.duckdb`
   - Present results in a readable format

4. **Offer follow-up actions**
   - "Would you like to refine this search?"
   - "Should I look for related plans?"

## Example Queries

**User**: "/archive find high complexity plans"
**You**: 
```
duckdb .switchboard/archive.duckdb "SELECT topic, complexity, created_at FROM plans WHERE complexity = 'High' ORDER BY created_at DESC LIMIT 20"
```

**User**: "/archive search for database"
**You**:
```
duckdb .switchboard/archive.duckdb "SELECT * FROM plans WHERE topic ILIKE '%database%' LIMIT 10"
```

**User**: "/export this conversation"
**You**:
1. Ask: "What topic should I use for this export?"
2. Write to `/tmp/conversation_YYYYMMDD.md`
3. Call `export_conversation` with metadata

## Archive Schema Reference

**plans table**:
- `plan_id`, `session_id`, `topic`, `plan_file`
- `kanban_column`, `status`, `complexity`
- `workspace_id`, `created_at`, `updated_at`
- `last_action`, `source_type`, `tags`
- `archived_at`, `days_to_completion`, `revision_count`

**conversations table**:
- `id`, `exported_at`, `conversation_date`
- `topic`, `title`, `content`
- `tags` (array), `project`, `metadata` (JSON)
- `file_path_original`

## Configuration

Archive path: `.switchboard/archive.duckdb` (or configured in `switchboard.archive.dbPath`)

## Related Skills
- `skill: "archive"` - Detailed archive operations documentation
