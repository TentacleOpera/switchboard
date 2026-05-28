---
description: Fix ClickUp/Linear import to respect project filter
---

# Fix: ClickUp/Linear Import Respects Project Filter

## Problem
When importing a task from ClickUp or Linear using the import button in `implementation.html`, the imported plan is created on the base board even when a project is selected in the kanban filter. The plan should be assigned to the currently selected project.

## Root Cause
The `_createInitiatedPlan()` method in `TaskViewerProvider.ts` does not accept or set a project ID. When `importClickUpTask()` and `importLinearTask()` call this method, they pass no project information, so the plan is created with an empty `project` field in the database. This causes the plan to appear on the base board regardless of the current project filter.

## Proposed Changes

### 1. Update `_createInitiatedPlan()` signature
Add an optional `projectName` parameter to the `_createInitiatedPlan()` method in `TaskViewerProvider.ts`:

```typescript
private async _createInitiatedPlan(
    title: string,
    idea: string,
    isAirlock: boolean,
    options: {
        skipBrainPromotion?: boolean;
        suppressIntegrationSync?: boolean;
        createdAt?: string;
        projectName?: string;  // NEW: optional project assignment
    } = {}
): Promise<{ planFileAbsolute: string; }>
```

### 2. Update plan creation to set project in database
After creating the plan file, if `projectName` is provided, update the database record to assign the plan to that project:

```typescript
// After line 15306 (after log.createRunSheet)
if (options.projectName) {
    const db = await this._getKanbanDb(workspaceRoot);
    if (db) {
        const workspaceId = await this._getOrCreateWorkspaceId(workspaceRoot);
        if (workspaceId) {
            await db.assignPlansToProject([planFileRelative], options.projectName, workspaceId);
        }
    }
}
```

### 3. Get current project filter in import handlers
Update `importClickUpTask()` and `importLinearTask()` to retrieve the current project filter from `KanbanProvider` and pass it to `_createInitiatedPlan()`:

```typescript
// In importClickUpTask() and importLinearTask()
const projectFilter = this._kanbanProvider?.getProjectFilter() || null;

const { planFileAbsolute: rootPlanFile } = await this._createInitiatedPlan(
    task.name || `ClickUp Task ${task.id}`,
    planContent,
    false,
    {
        skipBrainPromotion: true,
        suppressIntegrationSync: true,
        createdAt,
        projectName: projectFilter || undefined  // Pass current project filter
    }
);
```

Do the same for subtask creation in both import methods.

### 4. Update webview to send project filter (optional)
If the project filter is not accessible from the backend, update the webview message in `implementation.html` to include the current project filter:

```typescript
// In the import button click handlers (lines 4537 and 4628)
vscode.postMessage({
    type: 'clickupImportTask',
    taskId: importBtn.dataset.importIssueId,
    includeSubtasks: true,
    workspaceRoot: currentWorkspaceRoot || undefined,
    projectFilter: currentProjectFilter || undefined  // NEW: send current project
});
```

Then update the message handlers in `TaskViewerProvider.ts` to use `data.projectFilter` instead of querying `KanbanProvider`.

## Verification Plan
1. Select a project in the kanban board filter
2. Import a ClickUp task from the implementation.html sidebar
3. Verify the imported plan appears in the selected project board (not base board)
4. Repeat for Linear task import
5. Verify that when no project is selected, imports still work (go to base board)
6. Verify that subtasks are also assigned to the same project as the parent task

## Files Changed
- `src/services/TaskViewerProvider.ts`:
  - Update `_createInitiatedPlan()` signature and implementation
  - Update `importClickUpTask()` to pass project filter
  - Update `importLinearTask()` to pass project filter
- `src/webview/implementation.html` (optional, if backend can't access filter):
  - Update import button click handlers to send project filter

## Open Questions
- Should the project filter be sent from the webview or queried from `KanbanProvider` in the backend? (Prefer querying from backend to avoid webview changes)
- What should happen if the selected project doesn't exist in the database? (Should auto-create or fail gracefully?)
