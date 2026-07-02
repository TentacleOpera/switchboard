# Kanban DB Storage Consistency

**Complexity:** 3

## Goal

Fix two DB storage convention issues. Archived plans leaving ghost kanban_column values that confuse direct DB queries, and imported_docs.file_path storing absolute paths inconsistent with the DB relative-path convention. Both require migration logic in KanbanDatabase.ts.

## How the Subtasks Achieve This

- **Fix: Archived Plans Leave Ghost kanban_column**: Ensures archiving a plan sets kanban_column to COMPLETED and last_action to archived in a single operation, plus a one-time migration to repair existing ghost plans.
- **Fix: imported_docs.file_path Stores Absolute Paths**: Migrates imported_docs.file_path from absolute paths to repo-relative paths, consistent with the rest of the DB path convention, with a one-time repair migration.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Fix: Archived Plans Leave Ghost kanban_column — Invisible in UI, Visible in DB Queries](../plans/fix-archived-plans-leave-ghost-kanban-column.md) — **PLAN REVIEWED**
- [ ] [Fix: `imported_docs.file_path` stores absolute paths, inconsistent with the DB's relative-path convention](../plans/fix-imported-docs-relative-paths-convention.md) — **PLAN REVIEWED**
<!-- END SUBTASKS -->
