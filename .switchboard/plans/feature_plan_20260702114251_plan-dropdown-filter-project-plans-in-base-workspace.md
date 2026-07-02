# Plan Select Dropdown Does Not Filter Out Project Plans in Base Workspace

**Plan ID:** b2c3d4e5-6f7a-4b8c-9d0e-1f2a3b4c5d6e

## Goal

The plan select dropdown in `implementation.html` must not show project-scoped plans when the user is viewing the base workspace (unassigned filter active). When looking at the base workspace, only plans that are NOT assigned to a specific project should appear. Plans that belong to a project should only appear when that project's filter is selected.

### Problem

The plan select dropdown in `implementation.html` shows project-scoped plans when the user is viewing the base workspace (no project filter active). When looking at the base workspace, only plans that are NOT assigned to a specific project should appear. Plans that belong to a project should only appear when that project's filter is selected.

### Background Context

The plan select dropdown (`#run-sheet-select`) is populated by the `runSheets` message from the backend. The backend's `_refreshRunSheetsImpl` method (line 15320 of `TaskViewerProvider.ts`) queries the kanban database and sends `activeSheets` / `completedSheets` to the frontend.

The filtering logic (lines 15408-15416) works as follows:

```ts
const repoScope = this._kanbanProvider?.getRepoScopeFilter() ?? null;
const projectFilter = this._kanbanProvider?.getProjectFilter() ?? null;

const activeRows = (projectFilter !== null || repoScope)
    ? await db.getBoardFilteredByProject(workspaceId, projectFilter, repoScope)
    : await db.getBoard(workspaceId);
```

### Root Cause Analysis

**CRITICAL CORRECTION:** The original plan claimed the bug occurs when `projectFilter === null` (base workspace, no filter). This is **WRONG** — `projectFilter` is **NEVER null** in practice. It is initialized to `KanbanDatabase.UNASSIGNED_PROJECT_FILTER` (`'__unassigned__'`) at `KanbanProvider.ts:182`, and the `setProjectFilter` handler at line 5634 coerces null to `UNASSIGNED_PROJECT_FILTER` via `??`. The `getBoard(workspaceId)` branch (unfiltered, returns ALL plans) is **DEAD CODE** — it only fires when `_kanbanProvider` is undefined (degraded state with no kanban system).

**The real bug:** When `projectFilter === '__unassigned__'` (the actual base-workspace state), `getBoardFilteredByProject` adds `AND plans.project_id IS NULL` (KanbanDatabase.ts:2767) — filtering by `project_id` ONLY, not the denormalized `project` text field. Plans with `project` text set but `project_id` NULL (orphaned project names that don't match any row in the `projects` table — the V35 migration backfill at lines 567-578 only matches when `projects.name = plans.project`) **slip right through**. The DB says "no project_id" but the plan clearly has a project name. The post-filter (lines 15451-15456) doesn't check `project` or `projectId` at all — it only filters by `repoScope`.

The `KanbanPlanRecord` has two project-related fields:
- `project?: string` — denormalized project name (text column, may be empty string). Note: optional in the interface (line 45 of `KanbanDatabase.ts`).
- `projectId?: number | null` — foreign key to `projects` table (may be NULL).

A plan is "project-scoped" when either `project` is non-empty OR `projectId` is non-null. When the base workspace is viewed (`projectFilter === '__unassigned__'`), these plans should be excluded from the dropdown. The DB-level filter only checks `project_id`, so plans with a `project` name but no `project_id` slip through.

The fix: add a post-filter that excludes plans with a non-empty `project` OR a non-null `projectId` when the base workspace filter is active (`projectFilter === '__unassigned__'` or `projectFilter === null` for the degraded state).

## Metadata

- **Complexity:** 3
- **Tags:** bugfix, ui, backend

## User Review Required

None. Pure post-filter addition; no state migration, no schema change.

## Complexity Audit

### Routine
- Adding a project-scope filter to the post-filter logic in `_refreshRunSheetsImpl` (lines 15451-15456 of `TaskViewerProvider.ts`).
- The `KanbanPlanRecord` already has `project` and `projectId` fields — no schema changes needed.

### Complex / Risky
- None. The filter is a no-op when a specific project filter is active (only fires on `'__unassigned__'` or `null`).

## Edge-Case & Dependency Audit

- **Race Conditions:** None. The post-filter runs synchronously on the already-read `activeRows`/`completedRows` arrays.
- **Security:** No untrusted input; `project` and `projectId` come from the DB.
- **Side Effects:** Plans with orphaned `project` names (text set but no matching `projects` table row) will now be excluded from the base-workspace dropdown. This is the correct behavior — the user assigned them to a project, so they shouldn't appear in the base workspace.
- **Dependencies & Conflicts:** This plan touches the post-filter in `_refreshRunSheetsImpl`, which is also modified by Plan 4 (adding `isEpic`/`epicId` to `toSheet`). The changes are to different parts of the pipeline (post-filter vs. sheet mapping). They compose without conflict.
- **`projectFilter === '__unassigned__'` (base workspace)**: This is the actual bug scenario. `getBoardFilteredByProject` filters `project_id IS NULL` at the DB level, but plans with `project` text set and `project_id` NULL slip through. The fix's post-filter excludes plans where `project` is non-empty OR `projectId` is non-null.
- **`projectFilter === null` (degraded state, no kanban provider)**: The `getBoard(workspaceId)` branch returns ALL plans. The fix's post-filter also applies here (same condition), excluding project-scoped plans. This is correct — even in the degraded state, the base workspace shouldn't show project plans.
- **`projectFilter === 'SomeProject'`**: The user selected a specific project. `getBoardFilteredByProject` filters to that project at the DB level. The fix's post-filter is NOT applied (condition is false). Correct — no change needed.
- **`repoScope` active, `projectFilter === '__unassigned__'`**: Both filters compose. The `repoScope` filter keeps plans where `!row.repoScope || row.repoScope === repoScope`. The project-scope filter additionally removes plans with a project assignment. A plan with `repoScope === 'my-repo'` AND `project === 'my-project'` is excluded. A plan with `repoScope === 'my-repo'` AND `project === ''` AND `projectId === null` is included. Correct.
- **Plans with `project` set but `projectId` NULL**: The V35 migration backfills `project_id` from `project` names (lines 567-578 of `KanbanDatabase.ts`), but only when `projects.name = plans.project`. If the project name doesn't match any row in the `projects` table (orphaned name), `project_id` remains NULL. The filter must check BOTH fields: exclude if `project` is non-empty OR `projectId` is non-null.
- **Completed plans**: The same filter applies to both `visibleActiveRows` and `visibleCompletedRows` (lines 15451-15456). A completed project-scoped plan should not appear in the base workspace dropdown either.
- **Kanban board vs sidebar dropdown**: The kanban board has its own project filter UI and uses `getBoardFilteredByProject` directly. The sidebar dropdown uses the same DB snapshot but applies its own post-filters. The fix only affects the sidebar dropdown's post-filter, not the kanban board. The kanban board already handles project filtering correctly via its UI (though it shares the same `project_id`-only DB filter — a separate issue if the kanban board also shows orphaned-project plans in the base workspace).

## Dependencies

None. This plan is self-contained and does not depend on any other plan in the epic. It composes with Plan 4 (which adds `isEpic`/`epicId` to `toSheet` in the same method) without conflict.

## Adversarial Synthesis

**CRITICAL:** The original plan's premise was wrong — it targeted `projectFilter === null`, which is dead code (never fires in practice). `projectFilter` is always `'__unassigned__'` or a project name. The real bug is that `getBoardFilteredByProject` with `'__unassigned__'` filters `project_id IS NULL` only, not the denormalized `project` text field — so plans with orphaned project names (text set, no matching `projects` table row) slip through. The fix's insight (check both `project` and `projectId` in a post-filter) is correct; only the targeting condition was wrong. Retargeted from `projectFilter === null` to `projectFilter === null || projectFilter === KanbanDatabase.UNASSIGNED_PROJECT_FILTER`. Line numbers refreshed.

## Proposed Changes

> **Implementer note:** Line numbers verified against current source. If shifted, grep for `_refreshRunSheetsImpl`, `visibleActiveRows`, and `UNASSIGNED_PROJECT_FILTER` to locate insertion points.

### File: `src/services/TaskViewerProvider.ts`

#### Change 1: Add project-scope filter to the post-filter logic

In `_refreshRunSheetsImpl` (lines 15451-15456), add a filter that excludes project-scoped plans when the base workspace filter is active (`projectFilter === '__unassigned__'` or `null`):

```ts
// Before (lines 15451-15456):
const visibleActiveRows = repoScope
    ? filterGhostPlans(activeRows).filter(filterByColumn).filter((row) => !row.repoScope || row.repoScope === repoScope)
    : filterGhostPlans(activeRows).filter(filterByColumn);
const visibleCompletedRows = repoScope
    ? filterGhostPlans(completedRows).filter(filterByColumn).filter((row) => !row.repoScope || row.repoScope === repoScope)
    : filterGhostPlans(completedRows).filter(filterByColumn);

// After:
// When the base workspace filter is active (unassigned or null/degraded), exclude plans
// assigned to a project. The DB-level filter only checks project_id IS NULL, so plans
// with an orphaned project name (project text set but no matching projects table row)
// slip through. This post-filter catches them by checking both fields.
// Project-scoped plans should only appear when their project filter is explicitly selected.
const excludeProjectPlans = projectFilter === null || projectFilter === KanbanDatabase.UNASSIGNED_PROJECT_FILTER;
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

The `filterByProjectScope` function is a no-op when a specific project filter is active (returns `true` for all rows), so it has zero effect when `projectFilter` is a project name. It only activates when `projectFilter` is `'__unassigned__'` (base workspace) or `null` (degraded state).

**Note:** `KanbanDatabase.UNASSIGNED_PROJECT_FILTER` must be imported or referenced. It's a static constant on `KanbanDatabase` (`KanbanDatabase.ts:701`). If not already imported in `TaskViewerProvider.ts`, use the string literal `'__unassigned__'` or add the import.

## Verification Plan

> **Session directives:** SKIP compilation (no `npm run compile` / `tsc`) and SKIP automated tests in this session — the project is pre-compiled and tests run separately. The steps below are for the implementer/user to run after the session.

### Automated Tests
- (Run separately by user) Test that seeds plans with `project` text but `project_id = NULL` (orphaned project names), sets `projectFilter` to `'__unassigned__'`, runs `_refreshRunSheetsImpl`, and asserts the orphaned plans are excluded from `visibleActiveRows`.

### Manual Verification
1. **Setup**: Create a workspace with multiple plans — some assigned to a project, some unassigned (base workspace plans). Ensure at least one plan has `project` text set but `project_id` NULL (orphaned project name).
2. **Test — base workspace (unassigned filter)**: Verify the plan select dropdown shows ONLY unassigned plans. Project-scoped plans (including orphaned ones with `project` text but no `project_id`) should not appear.
3. **Test — project filter selected**: Select a specific project in the kanban board. Verify the dropdown shows only that project's plans.
4. **Test — "Unassigned" filter selected**: Select "Unassigned" in the kanban board's project filter. Verify the dropdown shows only unassigned plans (same set as base workspace, but now explicitly filtered).
5. **Test — completed plans**: Complete some plans (both project-scoped and unassigned). Switch to "Completed" mode in the dropdown. Verify only unassigned completed plans appear in the base workspace view.
6. **Test — repoScope + base workspace**: Set a repoScope filter but no project filter. Verify the dropdown shows plans matching the repoScope AND having no project assignment.
7. **Test — no plans**: Verify the dropdown shows "NO ACTIVE PLANS" when all plans are project-scoped and the base workspace is viewed.

## Recommendation

Complexity 3 → **Send to Intern** (single post-filter addition following established patterns; the critical insight — targeting `'__unassigned__'` not `null` — is captured in this plan so the implementer won't target dead code).
