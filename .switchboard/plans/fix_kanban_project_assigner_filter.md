# Fix Kanban Project Assigner Filter

## Problem
The project assigner in kanban.html is difficult to use because:
- After assigning tasks to a project, switching back to "All Projects" still shows all tasks including the ones just assigned
- There's no way to distinguish which tasks have already been assigned
- The "All Projects" designation shows everything, making it impossible to find unassigned tasks

## Root Cause
The dropdown currently has an "All Projects" option for each workspace that returns ALL plans in that workspace regardless of project assignment. This doesn't help users find unassigned tasks.

## Solution
Remove the "All Projects" designation and instead use the existing database `project` column (which defaults to empty string '') to represent "no project assigned". When selecting the base workspace in the dropdown, only show plans with `project = ''`.

## Implementation

### 1. Frontend: kanban.html
**File**: `/Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/kanban.html`

**Change 1**: Remove "All Projects" option generation (around line 3415-3423)
```javascript
// REMOVE this code block:
// "All Projects" option for this workspace
const allOpt = document.createElement('option');
allOpt.value = wsRoot + '|';
allOpt.textContent = wsLabel + ' > All Projects';
allOpt.dataset.workspaceRoot = wsRoot;
allOpt.dataset.project = '';
if (item.controlPlaneAction || item.selectionMode) {
    allOpt.dataset.controlPlaneAction = item.controlPlaneAction || item.selectionMode;
}
```

**Change 2**: Add base workspace option (no project) before project options
```javascript
// Add base workspace option (shows only unassigned plans)
const baseOpt = document.createElement('option');
baseOpt.value = wsRoot + '|';
baseOpt.textContent = wsLabel; // Just workspace name, no "All Projects" suffix
baseOpt.dataset.workspaceRoot = wsRoot;
baseOpt.dataset.project = ''; // Empty string = no project assigned
if (item.controlPlaneAction || item.selectionMode) {
    baseOpt.dataset.controlPlaneAction = item.controlPlaneAction || item.selectionMode;
}
select.appendChild(baseOpt);
```

**Change 3**: Ensure project filtering logic handles empty project correctly
The backend `getBoardFilteredByProject` already handles this correctly (lines 2136-2138 in KanbanDatabase.ts):
- When `project` is null/empty, it returns all plans
- We need to change this to: when `project` is empty string '', return only plans with `project = ''`

### 2. Backend: KanbanDatabase.ts
**File**: `/Users/patrickvuleta/Documents/GitHub/switchboard/src/services/KanbanDatabase.ts`

**Change**: Modify `getBoardFilteredByProject` to treat empty string as "no project" filter (around line 2136-2152)

Current logic:
```typescript
if (!project && !repoScope) {
    return this.getBoard(workspaceId);
}
```

New logic:
```typescript
// If project is explicitly empty string, filter for unassigned plans
// If project is null/undefined and no repoScope, return all plans
if (project === '' && !repoScope) {
    const sql = `SELECT ${PLAN_COLUMNS} FROM plans 
                 WHERE workspace_id = ? AND status = 'active' AND project = '' 
                 ORDER BY updated_at DESC`;
    const stmt = this._db.prepare(sql, [workspaceId]);
    return this._readRows(stmt);
}
if (!project && !repoScope) {
    return this.getBoard(workspaceId);
}
```

Apply the same logic to `getCompletedPlansFilteredByProject` (around line 2229-2245):
```typescript
if (project === '' && !repoScope) {
    const sql = `SELECT ${PLAN_COLUMNS} FROM plans 
                 WHERE workspace_id = ? AND status = 'completed' AND project = '' 
                 ORDER BY updated_at DESC LIMIT ?`;
    const stmt = this._db.prepare(sql, [workspaceId, limit]);
    return this._readRows(stmt);
}
if (!project && !repoScope) {
    return this.getCompletedPlans(workspaceId, limit);
}
```

### 3. Testing
- Test assigning tasks to a project
- Switch back to base workspace option
- Verify only unassigned tasks are shown
- Verify assigned tasks no longer appear in the base workspace view
- Test that project-specific views still work correctly
- Test cross-workspace assignment still works

## Files Changed
- `/Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/kanban.html`
- `/Users/patrickvuleta/Documents/GitHub/switchboard/src/services/KanbanDatabase.ts`

## Validation
Manual testing in kanban.html:
1. Select a workspace
2. Assign some tasks to a project
3. Switch back to the base workspace option (no project suffix)
4. Confirm only unassigned tasks are visible
5. Select the project you assigned to
6. Confirm the assigned tasks appear there
