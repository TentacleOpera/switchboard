# Fix New Plans Not Getting project_id Set by File Watcher

## Goal

New plan files detected by `GlobalPlanWatcherService` are inserted into the DB with `project_id = NULL` even when a project filter is active. The kanban board's project filter JOINs on `project_id`, not the `project` text column, so these plans silently disappear from the project board and only appear on the unassigned/base view.

### Root Cause

`insertFileDerivedPlan` tries to resolve `project_id` via a name lookup inside the INSERT:

```sql
SELECT id FROM projects WHERE name = ? AND workspace_id = ?
```

This only runs if `record.project` is a non-empty string. `record.project` is populated in `_handlePlanFile` from a three-way resolution chain:

1. `metadata.project` — frontmatter `**Project:**` (absent on most new plans)
2. `liveProject` — from `getDisplayedProjectForRoot(watchedRoot)`, which returns `null` if the watcher's `workspaceRoot` effective root doesn't match the provider's `_currentWorkspaceRoot` effective root (the `resolveEffectiveWorkspaceRoot` comparison at KanbanProvider.ts:4688)
3. `this._currentProjects.get(effectiveRoot)` — in-memory mirror, keyed by `resolveEffectiveWorkspaceRootFromMappings(path.resolve(_currentWorkspaceRoot))` but looked up with `resolveEffectiveWorkspaceRootFromMappings(workspaceRoot)` — any path resolution difference silently breaks the key match

When all three paths fail to produce a name, `record.project = ''`, the lookup condition is falsy, and `project_id` is inserted as `null`. Plans are stuck with `project_id = null` forever — subsequent file-change events also produce `null` via the same path, and the UPSERT's `COALESCE(excluded.project_id, plans.project_id)` preserves null when both are null.

### Why the Assign Button Works

`KanbanDatabase.setProjectForPlans` runs the same lookup SQL but receives the project name directly from the UI dropdown (populated from the `projects` table), bypassing the fragile resolution chain entirely. It is the proven, correct path.

### Fix Strategy

Rather than debugging the resolution chain (which has known races and multiple root-resolution functions that can diverge), use `setProjectForPlans` directly in `_handlePlanFile` after the insert/upsert — mirroring exactly what the assign button does. This is a 4-line addition per branch.

## Implementation

### File: `src/services/GlobalPlanWatcherService.ts`

**New plan path** (around line 591, after `await db.insertFileDerivedPlan(newRecord)`):

```typescript
await db.insertFileDerivedPlan(newRecord);
// Assign project_id via the same path the assign button uses.
// insertFileDerivedPlan's internal lookup is unreliable (resolution chain
// can produce empty string when roots don't align). setProjectForPlans
// takes the name directly and does the same lookup without the chain.
if (project) {
    await db.setProjectForPlans(workspaceId, [newRecord.planId], project);
}
```

**Existing plan path** (around line 630, after `await db.insertFileDerivedPlan(updatedRecord)`):

```typescript
await db.insertFileDerivedPlan(updatedRecord);
// Re-assert project_id for plans stuck at null (initial insert timing gap).
// Only runs if we resolved a project name and the plan currently has no project_id.
if (resolvedProject && !plan.projectId) {
    await db.setProjectForPlans(workspaceId, [updatedRecord.planId], resolvedProject);
}
```

No changes to `insertFileDerivedPlan`, `getDisplayedProjectForRoot`, `setCurrentProject`, or any other method. The resolution chain is left intact — if it happens to work, `record.project` is set and `setProjectForPlans` gets a valid name. If the chain produces empty string, `setProjectForPlans` is skipped (same behaviour as today, no regression).

### No other files need changes.

## What Does Not Change

- The `insertFileDerivedPlan` UPSERT SQL — not touched
- The resolution chain (`metadata.project || liveProject || _currentProjects`) — not touched
- `getDisplayedProjectForRoot` root-comparison logic — not touched
- Epic handling, ClickUp sync, event emission — all unchanged

## Edge Cases

- **Project name empty**: `if (project)` guard means `setProjectForPlans` is skipped — identical to current behaviour, no regression
- **Project deleted after filter set**: `setProjectForPlans` runs the lookup, finds no row, sets `project_id = null` — same result as today
- **Epic files**: `newRecord.planId` is the stable UUID derived from the filename, so the UPDATE targets the correct row even for epics
- **Race with `_handlePlanDelete`**: `setProjectForPlans` is an UPDATE — if the row was deleted between INSERT and UPDATE it's a no-op, no error

## Metadata

**Complexity:** 2
**Tags:** backend, bugfix
