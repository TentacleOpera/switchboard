# Fix: Parent Board Shows Blank After Creating New Project

## Goal

After creating a new project, the parent kanban board shows blank even though the dropdown filter has not changed. The dropdown filter display needs to change to the newly created project board upon creation, and the board should immediately display the new project's (empty) plan list rather than going blank.

### Problem Analysis & Root Cause

**Current flow:** When a user creates a new project from the kanban board:
1. `kanban.html` posts an `addProject` message to `KanbanProvider.ts`
2. `KanbanProvider.ts` (line 5476) calls `db.addProject()` to insert the project into the database
3. `KanbanProvider.ts` (line 5485) calls `setProjectFilter(projectName)` to set `this._projectFilter = projectName`
4. `KanbanProvider.ts` (line 5487) calls `_refreshBoard(workspaceRoot)` which fetches updated projects and sends `updateWorkspaceSelection` to the kanban webview
5. `kanban.html` (line 6146) receives the message and calls `updateWorkspaceProjectDropdown()` to rebuild the dropdown

**The bug:** The dropdown rebuild logic in `updateWorkspaceProjectDropdown()` (lines 4187-4226 in `kanban.html`) tries to restore the selection using `activeProjectFilter`. However, there is a timing mismatch:
- `setProjectFilter()` sets the backend filter to the new project name
- The `updateWorkspaceSelection` message sent to the webview includes the updated `allWorkspaceProjects` data
- But the webview's `activeProjectFilter` variable (line 6137) is updated from the message's `projectFilter` field
- The dropdown rebuild logic at lines 4187-4226 tries to match `activeProjectFilter` against the new options, but if the new project name doesn't exactly match (or the filter value falls through to the `__unassigned__` fallback at line 4194 or 4223), the board displays plans for "unassigned" — which is empty for a newly created project, resulting in a blank board

**Root cause:** The `updateWorkspaceProjectDropdown()` function's selection restoration logic doesn't reliably select the newly created project. The filter is set correctly on the backend, but the frontend dropdown falls back to `__unassigned__` because the restoration logic doesn't account for the "just created" case where the project exists in the new data but the `activeProjectFilter` variable hasn't been synced yet from the message.

## Metadata
- **Tags:** bug, frontend, kanban, project-creation, dropdown
- **Complexity:** 4

## Complexity Audit

### Routine
- Reading and understanding the dropdown rebuild logic in `kanban.html`
- Adding explicit selection of the new project after creation
- Testing that the board shows the correct (empty) state for the new project

### Complex / Risky
- **Timing between backend filter set and frontend dropdown rebuild** — The `updateWorkspaceSelection` message includes a `projectFilter` field that should be used to set the dropdown selection. Need to verify this field is being sent and consumed correctly.
- **Dropdown restoration edge cases** — The restoration logic has multiple fallback paths (explicit root, active filter, unassigned). Need to ensure the fix doesn't break existing workspace-switching behavior.

## Edge-Case & Dependency Audit

- **Project created from kanban.html vs project.html:** The creation flow differs. This fix targets the kanban.html path (the `addProject` handler in `KanbanProvider.ts`).
- **Multiple workspaces:** The dropdown has per-workspace project options. The fix must select the new project within the correct workspace.
- **Project name with special characters:** The project name is used as the filter value. Need to ensure exact string matching.
- **Dependencies:** `KanbanProvider.ts` (`addProject` handler, `setProjectFilter`, `_refreshBoard`), `kanban.html` (`updateWorkspaceProjectDropdown`, `updateWorkspaceSelection` handler).

## Proposed Changes

### 1. Ensure `updateWorkspaceSelection` message includes the active project filter

**File:** `src/services/KanbanProvider.ts` (in `_refreshBoardImpl`, ~lines 2345-2360)

Verify that the `updateWorkspaceSelection` message includes the current `this._projectFilter` value:

```typescript
this._kanbanWebview?.postMessage({
    type: 'updateWorkspaceSelection',
    workspaces: /* ... */,
    allWorkspaceProjects: /* ... */,
    activeWorkspace: /* ... */,
    projectFilter: this._projectFilter || '__unassigned__'  // Ensure this is sent
});
```

### 2. Sync `activeProjectFilter` from the message before rebuilding dropdown

**File:** `src/webview/kanban.html` (in `updateWorkspaceSelection` handler, ~lines 6132-6170)

Ensure the `activeProjectFilter` is updated from the message's `projectFilter` field BEFORE calling `updateWorkspaceProjectDropdown()`:

```javascript
case 'updateWorkspaceSelection':
    // Update allWorkspaceProjects cache
    allWorkspaceProjects = msg.allWorkspaceProjects || {};
    
    // Sync the active project filter from the backend
    if (msg.projectFilter && msg.projectFilter !== '__unassigned__') {
        activeProjectFilter = msg.projectFilter;
    }
    
    // Now rebuild the dropdown — it will use the synced activeProjectFilter
    updateWorkspaceProjectDropdown(msg.explicitRoot);
    break;
```

### 3. Fix dropdown selection restoration to handle new project case

**File:** `src/webview/kanban.html` (in `updateWorkspaceProjectDropdown()`, ~lines 4187-4226)

The current logic falls back to `__unassigned__` when it can't find the `activeProjectFilter` in the options. The fix should ensure that if `activeProjectFilter` is set and the project exists in the current workspace's project list, it is selected:

```javascript
// After building all <option> elements for the dropdown:

// Restore selection
let targetValue = '__unassigned__';

if (activeProjectFilter && activeProjectFilter !== '__unassigned__') {
    // Check if the active project filter exists in the current workspace's projects
    const wsProjects = allWorkspaceProjects[activeWorkspaceId] || [];
    const exists = wsProjects.some(p => p.name === activeProjectFilter);
    if (exists) {
        targetValue = activeProjectFilter;
    } else {
        // Project doesn't exist in this workspace — fall back to unassigned
        targetValue = '__unassigned__';
        activeProjectFilter = '__unassigned__'; // Reset to avoid stale state
    }
}

select.value = targetValue;

// Trigger filter change to update the board display
if (targetValue !== previousValue) {
    // Send filter update to backend to ensure board shows correct plans
    postKanbanMessage({ 
        type: 'setProjectFilter', 
        project: targetValue, 
        workspaceRoot: currentWorkspaceRoot 
    });
}
```

### 4. Ensure board displays correctly for empty new project

**File:** `src/webview/kanban.html` (in the board rendering logic)

When the project filter is set to the new project and there are no plans, the board should show an empty state message (e.g., "No plans in this project yet") rather than a completely blank board. Verify the empty-state rendering handles this case.

## Verification Plan

1. **Create project from kanban:** Open kanban board → click "Create Project" → enter name → submit → verify the dropdown filter changes to the new project name and the board shows an empty state (not blank).
2. **Create project with existing plans visible:** Have plans in the unassigned/previous project → create a new project → verify the board switches to showing the new project's empty state, not the previous project's plans.
3. **Dropdown shows correct selection:** After project creation, verify the dropdown visually shows the new project name as selected.
4. **Create project in multi-workspace setup:** Switch to a different workspace → create a project → verify the dropdown selects the new project in the correct workspace.
5. **Project name with spaces:** Create a project named "My New Project" → verify the filter and dropdown handle the name correctly.
6. **Board still works after:** After creating the project, create a plan → verify it appears in the new project's board.
