# Plan Select Dropdown Does Not Filter Out Project Plans in Base Workspace

**Plan ID:** b2c3d4e5-6f7a-4b8c-9d0e-1f2a3b4c5d6e

## Goal

### Problem

The plan select dropdown in `implementation.html` shows project-scoped plans when the user is viewing the base workspace (no project filter active). When looking at the base workspace, only plans that are NOT assigned to a specific project should appear. Plans that belong to a project should only appear when that project's filter is selected.

### Background Context

The plan select dropdown (`#run-sheet-select`) is populated by the `runSheets` message from the backend. The backend's `_refreshRunSheetsImpl` method (line 15320 of `TaskViewerProvider.ts`) queries the kanban database and sends `activeSheets` / `completedSheets` to the frontend.

The filtering logic (lines 15379-15427) works as follows:

```ts
const repoScope = this._kanbanProvider?.getRepoScopeFilter() ?? null;
const projectFilter = this._kanbanProvider?.getProjectFilter() ?? null;

const activeRows = (projectFilter !== null || repoScope)
    ? await db.getBoardFilteredByProject(workspaceId, projectFilter, repoScope)
    : await db.getBoard(workspaceId);
```

When `projectFilter === null && repoScope === null` (base workspace, no filter), it calls `getBoard(workspaceId)` which returns **ALL** plans for the workspace — including project-scoped plans.

The post-filter (lines 15422-15427) only filters by `repoScope`:

```ts
const visibleActiveRows = repoScope
    ? filterGhostPlans(activeRows).filter(filterByColumn).filter((row) => !row.repoScope || row.repoScope === repoScope)
    : filterGhostPlans(activeRows).filter(filterByColumn);
```

When `repoScope` is null, no `repoScope` filtering happens. And `projectFilter` is never used in the post-filter — it's only used in the DB query via `getBoardFilteredByProject`. So when `projectFilter === null`, the DB query returns all plans and the post-filter doesn't remove project-scoped ones.

### Root Cause Analysis

The root cause is in the post-filter logic of `_refreshRunSheetsImpl` (lines 15422-15427 of `TaskViewerProvider.ts`). When no project filter is active (`projectFilter === null`), the code:

1. Calls `getBoard(workspaceId)` — returns ALL plans (no project filtering at the DB level).
2. Applies `filterGhostPlans` — removes plans whose files don't exist.
3. Applies `filterByColumn` — removes plans in reviewed/backlog columns (if setting enabled).
4. Does NOT filter out plans with a `project` or `projectId` set.

The `KanbanPlanRecord` has two project-related fields:
- `project: string` — denormalized project name (text column, may be empty string).
- `projectId: number | null` — foreign key to `projects` table (may be NULL).

A plan is "project-scoped" when either `project` is non-empty OR `projectId` is non-null. When the base workspace is viewed (no project filter), these plans should be excluded from the dropdown.

The kanban board itself already handles this correctly via `getBoardFilteredByProject` — when `projectFilter === null`, it doesn't filter by project, but the kanban board UI has its own project filter UI. The sidebar dropdown, however, does not have a project filter UI and relies on the backend to send the correct filtered set.

## Metadata

- **Tags:** bugfix, ui, plans, projects, filtering
- **Complexity:** 3

## Complexity Audit

### Routine
- Adding a project-scope filter to the post-filter logic in `_refreshRunSheetsImpl` (lines 15422-15427 of `TaskViewerProvider.ts`).
- The `KanbanPlanRecord` already has `project` and `projectId` fields — no schema changes needed.

### Complex / Risky
- The `UNASSIGNED_PROJECT_FILTER` constant (`'__unassigned__'`) is used when the user explicitly selects "Unassigned" in the kanban board's project filter. When `projectFilter === null`, it means "no filter selected" (show base workspace). The fix must only apply when `projectFilter === null` — not when `projectFilter === UNASSIGNED_PROJECT_FILTER` (which should show only unassigned plans, already handled by `getBoardFilteredByProject`).
- The `repoScope` filter and the project filter can both be active simultaneously. The fix must compose correctly with the existing `repoScope` filter.

## Edge-Case & Dependency Audit

1. **`projectFilter === null` (base workspace)**: This is the bug scenario. The fix adds a filter to exclude plans where `project` is non-empty OR `projectId` is non-null. Only plans with no project assignment appear.

2. **`projectFilter === UNASSIGNED_PROJECT_FILTER`**: The user explicitly selected "Unassigned" in the kanban board. `getBoardFilteredByProject` already filters to `project_id IS NULL` at the DB level. The fix's project-scope filter is NOT applied (it only applies when `projectFilter === null`). Correct — no change needed.

3. **`projectFilter === 'SomeProject'`**: The user selected a specific project. `getBoardFilteredByProject` already filters to that project at the DB level. The fix's project-scope filter is NOT applied. Correct — no change needed.

4. **`repoScope` active, `projectFilter === null`**: Both filters compose. The `repoScope` filter keeps plans where `!row.repoScope || row.repoScope === repoScope`. The project-scope filter additionally removes plans with a project assignment. A plan with `repoScope === 'my-repo'` AND `project === 'my-project'` is excluded (it belongs to a project). A plan with `repoScope === 'my-repo'` AND `project === ''` AND `projectId === null` is included (base workspace plan in this repo scope). Correct.

5. **Plans with `project` set but `projectId` NULL**: The V35 migration backfills `project_id` from `project` names (line 575-578 of `KanbanDatabase.ts`), but there may be edge cases where `project` is set and `projectId` is still NULL (e.g. the project name doesn't match any row in the `projects` table). The filter must check BOTH fields: exclude if `project` is non-empty OR `projectId` is non-null.

6. **Completed plans**: The same filter must apply to both `visibleActiveRows` and `visibleCompletedRows` (lines 15422-15427). A completed project-scoped plan should not appear in the base workspace dropdown either.

7. **Kanban board vs sidebar dropdown**: The kanban board has its own project filter UI and uses `getBoardFilteredByProject` directly. The sidebar dropdown uses the same DB snapshot but applies its own post-filters. The fix only affects the sidebar dropdown's post-filter, not the kanban board. The kanban board already handles project filtering correctly via its UI.

## Proposed Changes

### File: `src/services/TaskViewerProvider.ts`

#### Change 1: Add project-scope filter to the post-filter logic

In `_refreshRunSheetsImpl` (lines 15422-15427), add a filter that excludes project-scoped plans when `projectFilter === null`:

```ts
// Before (lines 15422-15427):
const visibleActiveRows = repoScope
    ? filterGhostPlans(activeRows).filter(filterByColumn).filter((row) => !row.repoScope || row.repoScope === repoScope)
    : filterGhostPlans(activeRows).filter(filterByColumn);
const visibleCompletedRows = repoScope
    ? filterGhostPlans(completedRows).filter(filterByColumn).filter((row) => !row.repoScope || row.repoScope === repoScope)
    : filterGhostPlans(completedRows).filter(filterByColumn);

// After:
// When no project filter is active (base workspace), exclude plans assigned to a project.
// Project-scoped plans should only appear when their project filter is explicitly selected.
const excludeProjectPlans = projectFilter === null;
const filterByProjectScope = (row: import('./KanbanDatabase').KanbanPlanRecord) => {
    if (!excludeProjectPlans) return true;
    return !row.project && (row.projectId === null || row.projectId === undefined);
};

const visibleActiveRows = repoScope
    ? filterGhostPlans(activeRows).filter(filterByColumn).filter(filterByProjectScope).filter((row) => !row.repoScope || row.repoScope === repoScope)
    : filterGhostPlans(activeRows).filter(filterByColumn).filter(filterByProjectScope);
const visibleCompletedRows = repoScope
    ? filterGhostPlans(completedRows).filter(filterByColumn).filter(filterByProjectScope).filter((row) => !row.repoScope || row.repoScope === repoScope)
    : filterGhostPlans(completedRows).filter(filterByColumn).filter(filterByProjectScope);
```

The `filterByProjectScope` function is a no-op when `projectFilter !== null` (returns `true` for all rows), so it has zero effect when a project filter is active. It only activates when `projectFilter === null` (base workspace view).

## Verification Plan

1. **Setup**: Create a workspace with multiple plans — some assigned to a project, some unassigned (base workspace plans).
2. **Test — base workspace (no project filter)**: Verify the plan select dropdown shows ONLY unassigned plans. Project-scoped plans should not appear.
3. **Test — project filter selected**: Select a specific project in the kanban board. Verify the dropdown shows only that project's plans.
4. **Test — "Unassigned" filter selected**: Select "Unassigned" in the kanban board's project filter. Verify the dropdown shows only unassigned plans (same set as base workspace, but now explicitly filtered).
5. **Test — completed plans**: Complete some plans (both project-scoped and unassigned). Switch to "Completed" mode in the dropdown. Verify only unassigned completed plans appear in the base workspace view.
6. **Test — repoScope + base workspace**: Set a repoScope filter but no project filter. Verify the dropdown shows plans matching the repoScope AND having no project assignment.
7. **Test — no plans**: Verify the dropdown shows "NO ACTIVE PLANS" when all plans are project-scoped and the base workspace is viewed.
