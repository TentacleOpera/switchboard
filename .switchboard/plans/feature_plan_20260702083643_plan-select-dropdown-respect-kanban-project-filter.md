# implementation.html plan select dropdown must respect active kanban board project filter

## Goal

### Problem
The plan select dropdown in implementation.html (the sidebar) shows plans from ALL projects, ignoring the active kanban board's project filter. When the user selects a project on the kanban board (e.g., "Project Foo"), the sidebar dropdown should only show plans belonging to "Project Foo" — but it currently shows every plan in the workspace.

### Background
The sidebar dropdown is populated by the `runSheets` message, which is sent from `TaskViewerProvider._refreshRunSheets()` (TaskViewerProvider.ts:15360-15433). This method reads the project filter via `this._kanbanProvider?.getProjectFilter()` (line 15369) and uses it to query the DB: `getBoardFilteredByProject(workspaceId, projectFilter, repoScope)` (line 15372).

So the backend **does** pass the project filter to the DB query. The question is why the dropdown still shows all plans.

### Root Cause
The `_projectFilter` field in `KanbanProvider` (KanbanProvider.ts:182) is initialized to `KanbanDatabase.UNASSIGNED_PROJECT_FILTER` (`'__unassigned__'`), which means "show only unassigned plans" — NOT "show all plans". The `getProjectFilter()` method (KanbanProvider.ts:4762-4764) returns this value directly.

In `_refreshRunSheets` (TaskViewerProvider.ts:15371), the condition is:
```ts
const activeRows = (projectFilter !== null || repoScope)
    ? await db.getBoardFilteredByProject(workspaceId, projectFilter, repoScope)
    : await db.getBoard(workspaceId);
```

When `_projectFilter` is `'__unassigned__'`, `projectFilter` is `'__unassigned__'` (not null), so it takes the filtered path. `getBoardFilteredByProject` with `project === '__unassigned__'` adds `AND plans.project_id IS NULL` (KanbanDatabase.ts:2766-2767) — showing only plans with no project. This is correct for the "base workspace" filter.

When the user selects a specific project (e.g., "Foo"), `setProjectFilter('Foo')` is called, `_projectFilter` becomes `'Foo'`, and the query correctly filters to Foo's plans.

**The actual bug**: The sidebar dropdown is NOT being refreshed when the project filter changes. `setProjectFilter` (KanbanProvider.ts:4888-4911) updates `_projectFilter` and persists it, but does NOT trigger a sidebar refresh. The kanban board refreshes via `_refreshBoard` (called from the `setProjectFilter` message handler at KanbanProvider.ts:5585), which calls `switchboard.refreshUI` (KanbanProvider.ts:2215), which calls `taskViewerProvider.refreshUI()` (TaskViewerProvider.ts:2759), which calls `_refreshRunSheets()` (TaskViewerProvider.ts:2786). So the sidebar SHOULD refresh.

The issue is timing/state: `setProjectFilter` is called from the kanban webview's message handler. The `_refreshBoard` call is `await`ed. But `_refreshRunSheets` reads `this._kanbanProvider?.getProjectFilter()` — if the kanban provider's `_projectFilter` was just set synchronously by `setProjectFilter` before `_refreshBoard` is called, the value should be correct.

**The real root cause**: The `setProjectFilter` message handler (KanbanProvider.ts:5581-5587) calls `this.setProjectFilter(msg.project)` THEN `await this._refreshBoard(workspaceRoot)`. The `setProjectFilter` method is synchronous and updates `_projectFilter` immediately. So `_refreshRunSheets` should see the new value. However, the `selectWorkspace` handler (KanbanProvider.ts:5437-5464) also calls `setProjectFilter` and then `_refreshBoard` — but it also changes `_currentWorkspaceRoot` and `_repoScopeFilter`. If the workspace changes, the sidebar's `_refreshRunSheets` may use a stale workspace context.

After deeper investigation, the most likely cause is that `_refreshRunSheets` is reading the project filter correctly, but the **kanban.html project dropdown selection** is not actually calling `setProjectFilter` in all cases. Looking at kanban.html (line 7010-7015): the `change` handler only calls `setProjectFilter` when `selectedProject !== (activeProjectFilter ?? '')`. If `activeProjectFilter` is `null` (initial state in the webview) and the user selects `__unassigned__`, the condition is `'__unassigned__' !== (null ?? '')` → `'__unassigned__' !== ''` → true, so it does fire. But if `activeProjectFilter` is already `'__unassigned__'` and the user re-selects it, it won't fire — which is correct (no change).

The remaining possibility: the sidebar (`TaskViewerProvider._view`) may not exist or may not be visible, causing the `if (this._view)` guard (TaskViewerProvider.ts:15392) to skip the `runSheets` post. But the user sees the dropdown, so the view exists.

**Conclusion**: The backend filtering IS correct when `setProjectFilter` is called. The bug is that the sidebar dropdown doesn't visually update because the `runSheets` message is either not sent (view not ready) or sent with stale data. The most robust fix is to ensure the sidebar explicitly refreshes its run sheets whenever the project filter changes, and to add the project filter value to the `runSheets` message so the webview can display it.

## Metadata
- **Tags**: `implementation.html`, `plan-select`, `project-filter`, `runSheets`, `sidebar`, `kanban`, `bug`
- **Complexity**: 5/10

## Complexity Audit
**Complex/Risky.** The filtering logic itself appears correct in the backend. The issue is in the refresh/delivery path — ensuring the sidebar receives updated run sheets whenever the project filter changes. The fix touches the refresh flow which is already complex (single-flight coalescing, workspace context resolution). Adding the project filter to the `runSheets` message is straightforward, but ensuring the refresh is triggered in all project-filter-change scenarios requires careful tracing of all `setProjectFilter` call sites.

## Edge-Case & Dependency Audit
- **`setProjectFilter` call sites**: KanbanProvider.ts:5443 (workspace switch reset), 5445 (workspace switch preserve), 5497 (project creation), 5563 (project deletion reset), 5584 (setProjectFilter message handler). Each is followed by `_refreshBoard` which triggers `refreshUI` → `_refreshRunSheets`. The refresh chain should propagate the filter.
- **`UNASSIGNED_PROJECT_FILTER` ('__unassigned__')**: Means "base workspace board" — show only plans with no project. This is a valid filter value, not "show all". The sidebar must respect this too.
- **`null` vs `'__unassigned__'`**: `getProjectFilter()` returns `null` when `_projectFilter` is null (shouldn't happen — initialized to `UNASSIGNED_PROJECT_FILTER`). The `_refreshRunSheets` condition `projectFilter !== null` is true for `'__unassigned__'`, so the filtered path is taken. This is correct.
- **Sidebar not visible**: If the sidebar view is disposed/hidden, `this._view` may be falsy and `runSheets` won't be posted. When the sidebar becomes visible again, it needs a refresh. This is handled by the `onDidChangeViewState` handler which calls `refreshUI`.
- **Workspace switch**: When the workspace changes, `setProjectFilter(UNASSIGNED_PROJECT_FILTER)` is called (KanbanProvider.ts:5443). The sidebar refresh follows. This is correct.
- **Multi-workspace**: The sidebar shows plans from the current workspace only. The project filter is per-workspace (persisted in `workspaceState`). This is correct.

## Proposed Changes

### 1. `src/services/TaskViewerProvider.ts` — include project filter in `runSheets` message

Add the current project filter to the `runSheets` message so the webview knows which filter was applied. This helps with debugging and enables the webview to show a filter indicator.

```ts
// BEFORE (line 15428)
this._view.webview.postMessage({ type: 'runSheets', activeSheets, completedSheets, kanbanColumns });

// AFTER
const currentProjectFilter = this._kanbanProvider?.getProjectFilter() ?? null;
this._view.webview.postMessage({
    type: 'runSheets',
    activeSheets,
    completedSheets,
    kanbanColumns,
    projectFilter: currentProjectFilter
});
```

Also update the error-path posts (lines 15432, 15481) to include `projectFilter: null`.

### 2. `src/services/TaskViewerProvider.ts` — ensure `_refreshRunSheets` is called after every `setProjectFilter`

The current flow (`setProjectFilter` → `_refreshBoard` → `refreshUI` → `_refreshRunSheets`) should work, but let's add an explicit guarantee. In the `refreshUI` method (TaskViewerProvider.ts:2759-2789), `_refreshRunSheets` is already called unconditionally. The issue may be that `_refreshBoard` (KanbanProvider.ts:2204-2220) calls `switchboard.refreshUI` via `executeCommand`, which is async — if the command execution fails or is delayed, the sidebar doesn't update.

Add a direct call to `_refreshRunSheets` in addition to the command-based path, as a safety net:

```ts
// In KanbanProvider.ts setProjectFilter message handler (line 5581-5587)
case 'setProjectFilter': {
    const workspaceRoot = this._currentWorkspaceRoot;
    if (workspaceRoot && (msg.project === null || typeof msg.project === 'string')) {
        this.setProjectFilter(msg.project ?? KanbanDatabase.UNASSIGNED_PROJECT_FILTER);
        await this._refreshBoard(workspaceRoot);
        // Explicit: ensure the sidebar picks up the new filter even if the
        // command-based refresh chain has a gap.
        this._taskViewerProvider?.refreshUI(workspaceRoot);
    }
    break;
}
```

Note: `refreshUI` is async but we don't need to await it here — the `_refreshRunSheets` inside it will fire and post the updated `runSheets` message.

### 3. `src/webview/implementation.html` — store and optionally display the active project filter

```js
// In the runSheets message handler (around line 2293-2307)
case 'runSheets':
    if (message.activeSheets !== undefined || message.completedSheets !== undefined) {
        currentActiveSheets = message.activeSheets || [];
        currentCompletedSheets = message.completedSheets || [];
        currentRunSheets = [...currentActiveSheets, ...currentCompletedSheets];
    } else {
        currentRunSheets = message.sheets || [];
        currentActiveSheets = currentRunSheets;
        currentCompletedSheets = [];
    }
    currentKanbanColumns = message.kanbanColumns || [];
    currentProjectFilter = message.projectFilter ?? null;  // NEW
    renderRunSheetDropdown();
    break;
```

Add `let currentProjectFilter = null;` to the state variables near the top of the script.

### 4. `src/webview/implementation.html` — show project filter context in the dropdown (optional enhancement)

When a project filter is active (not `null` and not `'__unassigned__'`), prepend a non-selectable indicator to the dropdown:

```js
// In renderRunSheetDropdown(), after clearing the dropdown (line 2496):
if (currentProjectFilter && currentProjectFilter !== '__unassigned__') {
    const filterOpt = document.createElement('option');
    filterOpt.disabled = true;
    filterOpt.text = `— Project: ${currentProjectFilter} —`;
    filterOpt.value = '';
    runSheetSelect.appendChild(filterOpt);
}
```

For `'__unassigned__'`, show `— Base Workspace —` as the indicator.

## Verification Plan
1. **Select a project on kanban board**: Open the kanban board, select a specific project from the workspace/project dropdown. Verify the sidebar plan-select dropdown updates to show only plans from that project. Verify the project filter indicator is shown.
2. **Select base workspace (unassigned)**: On the kanban board, select the base workspace option (no project). Verify the sidebar dropdown shows only unassigned plans (no project). Verify the "Base Workspace" indicator.
3. **No project filter / all projects**: If there's a state where no filter is applied, verify the sidebar shows all plans.
4. **Create plan while filtered**: With a project filter active, create a new plan from the sidebar. Verify the new plan appears in the dropdown (it should inherit the active project filter — see Issue 5's plan for the creation-side fix).
5. **Switch workspace**: Switch to a different workspace on the kanban board. Verify the sidebar dropdown resets to the new workspace's plans with the default (unassigned) filter.
6. **Sidebar not visible during filter change**: Close the sidebar, change the project filter on the kanban board, then reopen the sidebar. Verify the dropdown shows the correctly filtered plans.
7. **Console log verification**: Check that `[refreshRunSheets]` logs show the correct `projectFilter` value being passed to the DB query.
