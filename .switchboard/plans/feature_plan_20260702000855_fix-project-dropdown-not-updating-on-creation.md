# Fix: New Project Not Showing in project.html Dropdown Until Reopen

## Goal

When a project is created from the kanban board while `project.html` is already open, the new project does not appear in the project panel's dropdown filters until `project.html` is closed and reopened. The project panel should be notified of the new project in real-time and update its dropdown filters immediately without requiring a manual reload.

### Problem Analysis & Root Cause

**Current flow when a project is created from kanban.html:**

1. `kanban.html` posts `addProject` message to `KanbanProvider.ts` (line 7236-7251 in kanban.html)
2. `KanbanProvider.ts` handles `addProject` (lines 5463-5497):
   - Calls `db.addProject(workspaceId, projectName)` (line 5476)
   - Invalidates `_allWorkspaceProjectsCache` (line 5477)
   - Calls `setProjectFilter(projectName)` (line 5485)
   - Calls `_refreshBoard(workspaceRoot)` (line 5487)
3. `_refreshBoardImpl` (lines 2210-2406):
   - Fetches updated projects via `db.getProjects()` (line 2341)
   - Fetches `allWorkspaceProjects` via `_getAllWorkspaceProjects()` (line 2342)
   - Sends `updateWorkspaceSelection` message **only to the kanban webview** (lines 2345-2360)
4. `kanban.html` receives `updateWorkspaceSelection` and updates its dropdown (lines 6132-6170)

**The bug:** The `updateWorkspaceSelection` message is sent only to `this._kanbanWebview` (the kanban board's webview). The project panel (`project.html`) is never notified. The project panel maintains its own cache of workspace projects (`_kanbanAllWorkspaceProjects` in `project.js`, line 443-449) which is only updated when it receives a `kanbanPlansReady` message — and that message is only sent when the project panel explicitly requests it via `fetchKanbanPlans` (which happens on tab switch, line 39 in `project.js`).

**Root cause:** `KanbanProvider.ts` has a reference to `_planningPanelProvider` (line 198) and can call `postMessageToProjectWebview()` on it, but the `addProject` handler never does this. There is no cross-panel notification mechanism for project creation/deletion events. The project panel's data is stale until the user happens to trigger a `fetchKanbanPlans` by switching tabs or reopening the panel.

## Metadata
- **Tags:** bug, frontend, backend, kanban, project-creation, dropdown, project-html
- **Complexity:** 3

## Complexity Audit

### Routine
- Adding a cross-panel notification call after project creation
- Handling the notification in `project.js` to update the dropdown
- Same pattern can be applied to project deletion for consistency

### Complex / Risky
- **Avoiding unnecessary full plan refetch** — Sending a full `fetchKanbanPlans` to the project panel would work but is heavyweight (it fetches all plans, workspaces, and projects). A lighter-weight message that only updates the project list would be more efficient. However, using the existing `fetchKanbanPlans` mechanism is simpler and reuses tested code.
- **Race condition** — If the project panel is mid-render when the notification arrives, the update could be lost. Need to ensure the message is queued properly by the VS Code webview message system.

## Edge-Case & Dependency Audit

- **Project panel not open:** If `project.html` is not open, `postMessageToProjectWebview()` should be a no-op (or the provider should check `hasProjectPanel()` first).
- **Project created from project.html itself:** If the project is created from within `project.html` (not kanban.html), the notification may cause a redundant refresh. Need to handle this gracefully (the refresh should be idempotent).
- **Project deletion:** The same bug applies to project deletion — the `deleteProject` handler (line 5540-5555 in `KanbanProvider.ts`) also only notifies the kanban webview. The fix should be applied to both creation and deletion for consistency.
- **Multiple workspaces:** The notification should include the workspace root so the project panel can update the correct workspace's project list.
- **Dependencies:** `KanbanProvider.ts` (`addProject` handler, `deleteProject` handler), `PlanningPanelProvider.ts` (`postMessageToProjectWebview` method), `project.js` (`kanbanPlansReady` handler, `updateKanbanProjectFilter` function).

## Proposed Changes

### 1. Notify project panel after project creation

**File:** `src/services/KanbanProvider.ts` (in `addProject` handler, after line 5487)

After `await this._refreshBoard(workspaceRoot);`, add a notification to the project panel:

```typescript
// After line 5487: await this._refreshBoard(workspaceRoot);

// Notify the project panel (if open) so its dropdown filters update immediately
if (this._planningPanelProvider) {
    this._planningPanelProvider.notifyProjectListChanged(workspaceRoot);
}
```

### 2. Add `notifyProjectListChanged` method to PlanningPanelProvider

**File:** `src/services/PlanningPanelProvider.ts`

Add a new method that sends a lightweight notification to the project webview:

```typescript
public notifyProjectListChanged(workspaceRoot?: string): void {
    if (this._projectWebview) {
        this._projectWebview.postMessage({
            type: 'projectListChanged',
            workspaceRoot: workspaceRoot
        });
    }
}
```

Alternatively, if a full refresh is simpler and more reliable, trigger the existing `fetchKanbanPlans` flow:

```typescript
public notifyProjectListChanged(workspaceRoot?: string): void {
    if (this._projectWebview) {
        // Trigger a full plans fetch which includes updated project lists
        this._projectWebview.postMessage({
            type: 'kanbanPlansReady',
            requestId: Date.now(),
            // The project panel will re-request via fetchKanbanPlans
        });
    }
}
```

**Recommended approach:** Use a dedicated `projectListChanged` message type. The project panel handles it by re-fetching the kanban plans (which includes the updated project list). This is explicit and doesn't conflate with the normal `kanbanPlansReady` response flow.

### 3. Handle `projectListChanged` message in project.js

**File:** `src/webview/project.js` (in the message handler section, ~line 800-1100)

Add a handler for the new message type:

```javascript
case 'projectListChanged':
    // Re-fetch kanban plans to update the project dropdown filters
    vscode.postMessage({ type: 'fetchKanbanPlans', requestId: Date.now() });
    break;
```

This triggers the existing `fetchKanbanPlans` → `kanbanPlansReady` flow, which updates `_kanbanAllWorkspaceProjects` (line 443-449) and calls `updateKanbanProjectFilter()` (line 1163-1196) to rebuild the dropdown.

### 4. Apply the same fix to project deletion

**File:** `src/services/KanbanProvider.ts` (in `deleteProject` handler, ~line 5540-5555)

After the existing `_refreshBoard` call, add the same notification:

```typescript
// After the existing _refreshBoard call in deleteProject handler:
if (this._planningPanelProvider) {
    this._planningPanelProvider.notifyProjectListChanged(workspaceRoot);
}
```

### 5. Guard against redundant refreshes

**File:** `src/webview/project.js` (in the `projectListChanged` handler)

If the project panel itself initiated the project creation (rare, but possible), the notification would trigger a redundant refresh. Add a simple debounce:

```javascript
let _projectListChangedDebounce: number | null = null;

case 'projectListChanged':
    if (_projectListChangedDebounce) {
        clearTimeout(_projectListChangedDebounce);
    }
    _projectListChangedDebounce = setTimeout(() => {
        vscode.postMessage({ type: 'fetchKanbanPlans', requestId: Date.now() });
        _projectListChangedDebounce = null;
    }, 200);
    break;
```

This ensures that if multiple project changes happen in rapid succession (e.g., bulk creation), only one refresh is triggered.

## Verification Plan

1. **Create project while project.html open:** Open both kanban board and project.html → create a new project from the kanban board → verify the new project appears in the project.html dropdown filter immediately (without closing/reopening).
2. **Delete project while project.html open:** Open both panels → delete a project from the kanban board → verify the project is removed from the project.html dropdown filter immediately.
3. **Project panel not open:** Close project.html → create a project from kanban → open project.html → verify the new project appears (existing behavior should still work).
4. **Rapid project creation:** Create 3 projects in quick succession from the kanban board → verify the project.html dropdown updates with all 3 projects after the debounce window (no flickering or duplicate refreshes).
5. **Multi-workspace:** Switch to a different workspace in the kanban board → create a project → verify the project appears in the correct workspace's dropdown in project.html.
6. **Tab switch still works:** After the fix, switch to the Kanban tab in project.html and back → verify the dropdown still refreshes correctly (existing behavior preserved).
7. **No console errors:** Open browser devtools for the project.html webview → create a project from kanban → verify no JavaScript errors are logged.
