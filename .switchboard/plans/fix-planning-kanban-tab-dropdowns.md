# Fix Planning Kanban Tab Dropdowns

## Problem
In planning.html's kanban tab, the workspace dropdown displays individual repo folders instead of parent workspaces defined in setup.html's workspace-to-database mapping. Additionally, the project dropdown displays an "All Projects" option which should not exist.

## Root Cause
1. **Workspace dropdown**: `PlanningPanelProvider.ts` builds `workspaceItems` by simply mapping all open workspace roots to folder names (lines 1058-1068), ignoring the workspace-to-database mapping configuration.
2. **Project dropdown**: `planning.js` initializes the project dropdown with an "All Projects" option (line 2520) that the kanban board does not have.

## Solution

### 1. Fix Workspace Dropdown
Update `PlanningPanelProvider.ts` to use the same workspace item logic as `KanbanProvider._getWorkspaceItems()`:

**File**: `src/services/PlanningPanelProvider.ts`
- Replace the simple `allRoots.map()` approach (lines 1058-1068) with logic that:
  - Checks if workspace-to-database mapping is enabled via `WorkspaceIdentityService.getMappingsFromIndex()`
  - If enabled and any open folder is mapped, display the custom configured parent mapping names
  - Otherwise, display standard open workspace folders
- This matches the behavior in `KanbanProvider.ts` lines 651-729

### 2. Remove "All Projects" Option
**File**: `src/webview/planning.js`
- Remove the "All Projects" option from the project dropdown initialization (line 2520)
- The project dropdown should only show specific projects, not an aggregate option

## Files to Change
1. `src/services/PlanningPanelProvider.ts` - Update workspace item generation logic
2. `src/webview/planning.js` - Remove "All Projects" option from project dropdown

## Verification
- Open planning.html kanban tab
- Verify workspace dropdown shows parent workspaces (matching setup.html mapping) instead of individual repo folders
- Verify project dropdown does not show "All Projects" option
- Compare behavior with kanban board dropdowns to ensure consistency
