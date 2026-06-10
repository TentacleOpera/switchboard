# Fix: Plan Creation Not Inheriting Active Kanban Project

## Metadata

**Complexity:** 3
**Tags:** bugfix, kanban, backend, plan-creation

## Goal

When a user creates a plan from the kanban board while a project filter is active, the newly created plan must be automatically assigned to that project.

## Root Cause

Two independent assignment paths both fail:

1. **Direct assignment path is skipped.** `TaskViewerProvider.createDraftPlanTicket()` calls `_createInitiatedPlan(title, idea, false, { createdAt })` **without passing `projectName`**. `_createInitiatedPlan` has logic to call `db.assignPlansToProject()` when `options.projectName` is provided (`TaskViewerProvider.ts:15618-15632`), but since the option is absent, this block is skipped entirely.

2. **Watcher fallback path is bypassed.** `GlobalPlanWatcherService._handlePlanFile()` uses `this._currentProjects.get(workspaceRoot)` to assign discovered plans to the active project (`GlobalPlanWatcherService.ts:448`). However, `_createInitiatedPlan` calls `GlobalPlanWatcherService.registerPendingCreation(planFileAbsolute)` (`TaskViewerProvider.ts:15586`) to prevent duplicate DB inserts. This causes `_handlePlanFile` to skip the file entirely (`GlobalPlanWatcherService.ts:397-400`), so the watcher fallback never executes.

## Implementation

### Step 1: Modify `createDraftPlanTicket()` to pass the active project

**File:** `src/services/TaskViewerProvider.ts`

Before calling `_createInitiatedPlan`, read the active project filter from the kanban provider. Only pass a non-empty, non-sentinel value:

```typescript
public async createDraftPlanTicket(): Promise<void> {
    const title = 'Untitled Plan';
    const createdAt = new Date().toISOString();
    const idea = this._buildDraftPlanContent(title);

    // Inherit the active kanban project filter, if any
    let projectName: string | undefined;
    const activeProject = this._kanbanProvider?.getProjectFilter();
    if (activeProject && activeProject !== KanbanDatabase.UNASSIGNED_PROJECT_FILTER) {
        projectName = activeProject;
    }

    try {
        const { planFileAbsolute } = await this._createInitiatedPlan(title, idea, false, { createdAt, projectName });
        await this._openPlanInReviewPanel(planFileAbsolute, title);
    } catch (err: any) {
        const msg = err?.message || String(err);
        vscode.window.showErrorMessage(`Plan creation failed: ${msg}`);
    }
}
```

### Step 2: Update regression test

**File:** `src/test/clipboard-import-brain-promotion-regression.test.js`

The existing regex asserts the exact call signature without `projectName`. Update the assertion to match the new options object:

```javascript
/public async createDraftPlanTicketackslash(ackslash): Promise<void> ackslash{[ackslash sackslash S]*await thisackslash._createInitiatedPlanackslash(title, idea, false, ackslash{ createdAt, projectName ackslash}ackslash);/
```

### Step 3: Verification

1. Open the kanban board and select a workspace with at least one project.
2. Select a project from the project filter dropdown.
3. Click "Create Plan" in the kanban board.
4. Verify the new plan appears in the kanban board under the selected project (not in "All Projects" or "Unassigned").
5. Repeat with "Unassigned" selected — the plan should have no project assignment.
6. Repeat with no project filter selected — the plan should have no project assignment.

## Risks

- **Workspace mismatch edge case:** `_resolveWorkspaceRoot()` and `_kanbanProvider.getCurrentWorkspaceRoot()` may theoretically diverge in multi-workspace setups. The fix only passes `projectName` when `getProjectFilter()` returns a value; even if the workspace roots mismatch, `assignPlansToProject` is scoped to the resolved workspace, so the worst case is a harmless no-op or assignment to the wrong workspace's DB (same behavior as no project assignment today).
- **Test breakage:** The regression test regex must be updated or it will fail on CI.
