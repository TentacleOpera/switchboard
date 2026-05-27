# Fix Kanban Plans Tab Dropdowns

## Problem

The workspace and project dropdowns in the Kanban Plans tab (planning.html) are not working correctly:
- Workspace dropdown appears to use folder names instead of workspace names
- Project dropdown is not showing the available projects correctly

## Root Cause

The Kanban Plans tab (planning.html) uses a different data structure than the main Kanban view (kanban.html):

**kanban.html (working):**
- Single combined dropdown (`workspace-project-select`)
- Populated from backend message `updateWorkspaceSelection` with:
  - `workspaceItems` array (workspace metadata with labels)
  - `allWorkspaceProjects` object (projects organized per workspace)
- Format: `workspaceRoot + '|' + project` values
- Labels: `wsLabel + ' > ' + proj` format

**planning.html (broken):**
- Two separate dropdowns (`kanban-workspace-filter`, `kanban-project-filter`)
- Populated from `kanbanPlansReady` message using plan data directly
- Workspace filter: uses `workspaceRoot` and `workspaceLabel` from plans
- Project filter: uses `project` field from plans (aggregated across ALL workspaces)
- No per-workspace project organization

The `populateKanbanFilters()` function in planning.js extracts projects from ALL plans across all workspaces, while kanban.html receives structured `allWorkspaceProjects` data from the backend that organizes projects per workspace.

## Solution

Modify the backend to send `allWorkspaceProjects` data in the `kanbanPlansReady` message, then update planning.js to use this data to populate the dropdowns correctly.

## Implementation Plan

### Phase 1: Backend Changes (PlanningPanelProvider.ts)

**File:** `src/services/PlanningPanelProvider.ts`

**Change 1:** Modify `_getKanbanPlans()` to also fetch projects per workspace
- Add a call to `db.getProjects(workspaceId)` for each workspace
- Build an `allWorkspaceProjects` object mapping workspace roots to project arrays
- Include this in the returned data structure

**Change 2:** Update the `fetchKanbanPlans` message handler
- Include `allWorkspaceProjects` in the `kanbanPlansReady` message payload
- Ensure the format matches what kanban.html expects

### Phase 2: Frontend Changes (planning.js)

**File:** `src/webview/planning.js`

**Change 1:** Update `handleKanbanPlansReady()` to receive `allWorkspaceProjects`
- Extract `allWorkspaceProjects` from the message
- Store it in state for use by the filter population function

**Change 2:** Rewrite `populateKanbanFilters()` to use `allWorkspaceProjects`
- Use the structured data instead of extracting from plan data
- For workspace filter: use `workspaceItems` (if available) or extract from `allWorkspaceProjects` keys
- For project filter: show projects for the currently selected workspace only
- When workspace selection changes, update the project dropdown to show only that workspace's projects

**Alternative approach:** Switch to a single combined dropdown like kanban.html
- Replace the two separate dropdowns with one `workspace-project-select`
- Reuse the `updateWorkspaceProjectDropdown()` logic from kanban.html
- This would be more consistent with the main Kanban view

### Phase 3: HTML Changes (planning.html)

**If using the two-dropdown approach:**
- No HTML changes needed, just JS logic updates

**If switching to single dropdown:**
- Replace `kanban-workspace-filter` and `kanban-project-filter` with a single `workspace-project-select`
- Update CSS to match kanban.html styling

## Dependencies

- `KanbanDatabase.getProjects()` method already exists and is used by kanban.html
- The data structure for `allWorkspaceProjects` is already defined and used in kanban.html

## Risks

- **Risk:** Changing the message format could break existing functionality if not tested carefully
  - **Mitigation:** Ensure backward compatibility by checking if `allWorkspaceProjects` exists before using it

- **Risk:** If using the two-dropdown approach, project filter may be empty when no workspace is selected
  - **Mitigation:** Show "All Projects" option when no workspace is selected, or disable project filter until workspace is selected

## Verification

1. Open ARTIFACTS panel, click "KANBAN PLANS" tab
2. Verify workspace dropdown shows workspace names (not folder names)
3. Select a workspace
4. Verify project dropdown shows only projects for that workspace
5. Select a project
6. Verify plans are filtered correctly
7. Switch workspaces and verify project dropdown updates accordingly

## Future Enhancements

- Consider unifying the dropdown implementation between kanban.html and planning.html to reduce code duplication
- Add workspace/project badges to show current filter state (like kanban.html has)
