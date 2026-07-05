---
name: Query Archive
description: Query the DuckDB archive directly using duckdb CLI.
---

# Query Archive

Query archived plans using the DuckDB CLI directly.

## Basic Query

```bash
duckdb .switchboard/archive.duckdb "SELECT * FROM plans LIMIT 10"
```

**Note:** Run from the workspace root directory, or provide the full path to `archive.duckdb`.

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

## Schema Reference

The DuckDB archive `plans` table mirrors the schema of the live `kanban.db` `plans` table, containing columns such as `plan_id`, `topic`, `complexity`, `kanban_column`, etc.

> [!NOTE]
> The archive table may not yet contain the new `workspace_name` or `project_id` columns if they have not been propagated to the archive database. When querying the archive, verify their existence before filtering on them.

## Cross-Reference
For ready-made SQL query templates on workspace names, projects, and features, see the [query_kanban_plans.md](file:///Users/patrickvuleta/Documents/GitHub/switchboard/.agents/skills/query_kanban_plans.md) skill.
