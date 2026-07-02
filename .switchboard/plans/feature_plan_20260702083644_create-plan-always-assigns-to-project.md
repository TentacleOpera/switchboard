# Create plan always assigns to a project even with base workspace board selected

## Goal

### Problem
When the user clicks any "Create Plan" button while the base workspace board (no project / `__unassigned__`) is selected on the kanban board, the newly created plan is always assigned to a project instead of being left unassigned. The user expects: if the base workspace board is selected, the new plan should have NO project.

### Background
All create-plan paths converge on `TaskViewerProvider.createDraftPlanTicket()` (TaskViewerProvider.ts:16718-16760). This method:
1. Gets the active project filter: `const activeProject = this._kanbanProvider?.getProjectFilter()` (line 16734)
2. Checks if it's a real project: `if (activeProject && activeProject !== KanbanDatabase.UNASSIGNED_PROJECT_FILTER)` (line 16735)
3. If so, passes `projectName` to `_createInitiatedPlan` (line 16740)
4. `_createInitiatedPlan` calls `db.assignPlansToProject(...)` if `options.projectName` is set (TaskViewerProvider.ts:17332-17346)

### Root Cause
The logic at lines 16734-16737 appears correct — it only assigns a project when the filter is NOT `UNASSIGNED_PROJECT_FILTER`. So when the base workspace board is selected, `activeProject` should be `'__unassigned__'`, the condition should be false, and `projectName` should be `undefined`.

However, there's a second assignment path: the **GlobalPlanWatcherService**. When `_createInitiatedPlan` writes the plan file (TaskViewerProvider.ts:17303), the file watcher detects the new file. The watcher's `_handlePlanFile` method (GlobalPlanWatcherService.ts:444) checks `GlobalPlanWatcherService._pendingCreations` — if the file is in the pending set, it skips the import (line 446-448). The pending entry is set by `GlobalPlanWatcherService.registerPendingCreation(planFileAbsolute)` at TaskViewerProvider.ts:17300.

The pending creation window is **3000ms** (GlobalPlanWatcherService.ts:46-47). If the watcher fires after 3000ms (e.g., due to debounce, slow filesystem, or the watcher's 300ms debounce timer at line 440), the watcher will import the plan as a NEW plan. At that point, it reads `kanban.activeProjectFilter` from the DB config (GlobalPlanWatcherService.ts:524):

```ts
const activeProject = (await db.getConfig('kanban.activeProjectFilter')) || '';
const project = metadata.project || activeProject;
```

The `kanban.activeProjectFilter` config key is written by `setProjectFilter` (KanbanProvider.ts:4899-4902):
```ts
const activeProjectName = (filter && filter !== KanbanDatabase.UNASSIGNED_PROJECT_FILTER) ? filter : '';
void this._getKanbanDb(this._currentWorkspaceRoot)
    .setConfig('kanban.activeProjectFilter', activeProjectName);
```

When the filter is `UNASSIGNED_PROJECT_FILTER`, `activeProjectName` is `''` (empty string). So `db.getConfig('kanban.activeProjectFilter')` returns `''`, and `(await db.getConfig('kanban.activeProjectFilter')) || ''` is `''`. The watcher then sets `project = metadata.project || ''` — which is `''` (no project). This seems correct.

**The actual root cause**: The `kanban.activeProjectFilter` config key is **stale**. It's written asynchronously by `setProjectFilter` via `void this._getKanbanDb(...).setConfig(...)` (KanbanProvider.ts:4900). The `void` means the write is fire-and-forget. If the user switches from a project (e.g., "Foo") to the base workspace (`__unassigned__`), `setProjectFilter` fires the config write to set it to `''`, but the write may not complete before the plan is created. The watcher then reads the OLD value (`"Foo"`) and assigns the plan to Foo.

Additionally, `_createInitiatedPlan` itself calls `db.assignPlansToProject` at line 17335 when `options.projectName` is set. But when the base workspace is selected, `projectName` is `undefined`, so this path is skipped. The plan is inserted via `db.insertFileDerivedPlan` (line 11649) with `project: ''` — correct. But then the watcher fires (if past the 3000ms window) and does a **second insert** or **update** with the stale `kanban.activeProjectFilter` value, overwriting the correct empty project.

## Metadata
- **Tags**: `create-plan`, `project-assignment`, `GlobalPlanWatcherService`, `kanban.activeProjectFilter`, `stale-config`, `race-condition`, `bug`
- **Complexity**: 6/10

## Complexity Audit
**Complex/Risky.** This is a race condition between the config write in `setProjectFilter` (fire-and-forget) and the config read in `GlobalPlanWatcherService._handlePlanFile`. The fix must ensure the config is written synchronously (or awaited) before any plan creation can read it. Alternatively, the watcher should not override the project for plans that were explicitly created with no project. The fix touches the config write path and potentially the watcher's project resolution logic.

## Edge-Case & Dependency Audit
- **Fire-and-forget config write**: `setProjectFilter` (KanbanProvider.ts:4900) uses `void` to fire-and-forget the DB config write. This is the root cause. The write must be awaited or guaranteed before plan creation reads it.
- **Pending creation window (3000ms)**: `registerPendingCreation` sets a 3000ms timeout after which the watcher will process the file. If the watcher's debounce (300ms) fires within 3000ms, it's skipped. But if the watcher event arrives after 3000ms (e.g., network filesystem, slow disk), the watcher processes it as a new plan and reads the stale config.
- **`insertFileDerivedPlan` project field**: When `_createInitiatedPlan` calls `_registerPlan` → `db.insertFileDerivedPlan` with `project: ''` (line 11659), the plan is correctly inserted with no project. The watcher's subsequent `insertFileDerivedPlan` call (if it fires) may UPDATE the project to the stale value. Need to check if `insertFileDerivedPlan` is an upsert that overwrites the project field.
- **`metadata.project`**: The watcher checks `metadata.project || activeProject` (GlobalPlanWatcherService.ts:525). If the plan file has no project metadata, it falls back to `activeProject`. For newly created plans, the plan content template (`_buildDraftPlanContent`) does not include project metadata, so `metadata.project` is empty, and the fallback to `activeProject` is used.
- **Multiple rapid project switches**: If the user rapidly switches between projects and the base workspace, multiple fire-and-forget config writes may race. The last write should win, but without awaiting, the order is not guaranteed.
- **`assignPlansToProject` in `_createInitiatedPlan`**: When `projectName` IS set (a real project is selected), this path correctly assigns the plan. The bug is only about the base-workspace case where `projectName` is NOT set but the watcher overrides it.

## Proposed Changes

### 1. `src/services/KanbanProvider.ts` — await the config write in `setProjectFilter`

Change the fire-and-forget `void` to an awaited write. Since `setProjectFilter` is currently synchronous (`public setProjectFilter(filter: string | null): void`), it needs to become async or use a different approach.

**Option A (preferred): Make `setProjectFilter` async and await the config write.**

```ts
// BEFORE (KanbanProvider.ts:4888-4911)
public setProjectFilter(filter: string | null): void {
    this._projectFilter = filter;
    if (this._currentWorkspaceRoot) {
        const resolvedRoot = path.resolve(this._currentWorkspaceRoot);
        const activeProjectName = (filter && filter !== KanbanDatabase.UNASSIGNED_PROJECT_FILTER) ? filter : '';
        void this._getKanbanDb(this._currentWorkspaceRoot)
            .setConfig('kanban.activeProjectFilter', activeProjectName)
            .catch(e => console.warn('[KanbanProvider] setProjectFilter: failed to persist active project to DB config:', e));

        if (this._projectFilterSaveTimeout) {
            clearTimeout(this._projectFilterSaveTimeout);
        }
        this._projectFilterSaveTimeout = setTimeout(async () => {
            await this._context.workspaceState.update(`kanban.projectFilter.${resolvedRoot}`, filter);
        }, 100);
    }
}

// AFTER
public async setProjectFilter(filter: string | null): Promise<void> {
    this._projectFilter = filter;
    if (this._currentWorkspaceRoot) {
        const resolvedRoot = path.resolve(this._currentWorkspaceRoot);
        const activeProjectName = (filter && filter !== KanbanDatabase.UNASSIGNED_PROJECT_FILTER) ? filter : '';
        try {
            await this._getKanbanDb(this._currentWorkspaceRoot)
                .setConfig('kanban.activeProjectFilter', activeProjectName);
        } catch (e) {
            console.warn('[KanbanProvider] setProjectFilter: failed to persist active project to DB config:', e);
        }

        if (this._projectFilterSaveTimeout) {
            clearTimeout(this._projectFilterSaveTimeout);
        }
        this._projectFilterSaveTimeout = setTimeout(async () => {
            await this._context.workspaceState.update(`kanban.projectFilter.${resolvedRoot}`, filter);
        }, 100);
    }
}
```

**Update all callers** to await the now-async `setProjectFilter`:
- KanbanProvider.ts:5443 — `await this.setProjectFilter(...)` (already in async context)
- KanbanProvider.ts:5445 — `await this.setProjectFilter(msg.project)`
- KanbanProvider.ts:5497 — `await this.setProjectFilter(projectName)`
- KanbanProvider.ts:5563 — `await this.setProjectFilter(...)`
- KanbanProvider.ts:5584 — `await this.setProjectFilter(msg.project ?? ...)`
- KanbanProvider.ts:9204 — check context and await if needed

### 2. `src/services/GlobalPlanWatcherService.ts` — don't override project for recently created plans

As a defense-in-depth measure, extend the pending-creation check to also cover the project override. Even if the config is stale, the watcher should not assign a project to a plan that was explicitly created without one.

```ts
// BEFORE (GlobalPlanWatcherService.ts:524-525)
const activeProject = (await db.getConfig('kanban.activeProjectFilter')) || '';
const project = metadata.project || activeProject;

// AFTER
const activeProject = (await db.getConfig('kanban.activeProjectFilter')) || '';
// Only inherit the active project filter if the plan doesn't already have a
// project assignment in the DB. This prevents stale config values from
// overriding the explicit no-project intent of base-workspace plan creation.
let project = metadata.project || '';
if (!project) {
    // Check if the plan already exists in the DB with a project assignment.
    // If it does, respect the existing assignment. If not, fall back to the
    // active filter (for genuinely new external plans discovered by the watcher).
    const existingPlan = await db.getPlanByPlanFile(relativePath, workspaceId);
    if (existingPlan && existingPlan.project) {
        project = existingPlan.project;
    } else if (!existingPlan) {
        // Only apply the active filter to genuinely new plans, not re-imports
        // of plans that were just created with no project.
        project = activeProject;
    }
}
```

### 3. `src/services/TaskViewerProvider.ts` — explicitly set project to empty string for base-workspace creation

In `createDraftPlanTicket`, when no project filter is active, explicitly pass `projectName: ''` (empty string) instead of `undefined` to make the intent explicit:

```ts
// BEFORE (TaskViewerProvider.ts:16733-16737)
let projectName: string | undefined;
const activeProject = this._kanbanProvider?.getProjectFilter();
if (activeProject && activeProject !== KanbanDatabase.UNASSIGNED_PROJECT_FILTER) {
    projectName = activeProject;
}

// AFTER
let projectName: string | undefined;
const activeProject = this._kanbanProvider?.getProjectFilter();
if (activeProject && activeProject !== KanbanDatabase.UNASSIGNED_PROJECT_FILTER) {
    projectName = activeProject;
} else if (activeProject === KanbanDatabase.UNASSIGNED_PROJECT_FILTER) {
    // Explicitly no project — base workspace board is selected.
    // Pass undefined so _createInitiatedPlan skips assignPlansToProject,
    // and insertFileDerivedPlan records project: ''.
    projectName = undefined;
}
```

This is actually a no-op change (the current code already produces `undefined` in this case), but it makes the intent explicit and documents the expected behavior.

## Verification Plan
1. **Base workspace selected, create plan**: Select the base workspace (no project) on the kanban board. Click "Create Plan". Verify the new plan has NO project assigned (check the kanban card — no project label, and query the DB: `SELECT project FROM plans WHERE plan_file = '...'`).
2. **Project selected, create plan**: Select project "Foo" on the kanban board. Create a plan. Verify the plan is assigned to "Foo".
3. **Rapid switch from project to base, then create**: Select "Foo", then immediately switch to base workspace, then quickly create a plan. Verify the plan has NO project (the config write should be awaited and complete before creation).
4. **Watcher delay scenario**: Create a plan, then wait >3 seconds. Verify the watcher does not re-import the plan with a stale project (check DB — project should remain empty).
5. **External plan creation (drag file into plans folder)**: While base workspace is selected, manually create a `.md` file in `.switchboard/plans/`. Verify the watcher imports it with no project (not the stale filter).
6. **External plan creation while project selected**: While "Foo" is selected, manually create a `.md` file. Verify the watcher imports it with project "Foo".
7. **Existing tests**: Run `npm test` and verify no regressions in `KanbanProvider.test.ts` (which tests `setProjectFilter`).
