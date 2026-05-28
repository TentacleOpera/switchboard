# Fix Kanban Dependencies and Test Tabs Project Filtering

## Problem
The Dependencies and Test (UAT) tabs in kanban.html do not respect the project filter. When a project is selected in the workspace/project dropdown, these tabs still show all plans across all projects instead of only plans belonging to the selected project.

## Root Cause
The backend methods that fetch data for these tabs do not accept or apply project filter parameters:
- `KanbanDatabase.getPlansWithDependencies()` - used by Dependencies tab
- `KanbanDatabase.getPlansByColumn()` - used by UAT tab

Both methods query all plans for a workspace without filtering by the `project` column, even though the main board correctly uses `getBoardFilteredByProject()` which respects the project filter.

## Solution
Modify the database methods to accept optional project filter parameters and update the KanbanProvider to pass the current project filter when calling these methods.

## Implementation Steps

### 1. Update KanbanDatabase.getPlansWithDependencies()
**File**: `src/services/KanbanDatabase.ts`

Add an optional `projectFilter` parameter to the method signature and modify the SQL query to filter by project when provided:

```typescript
public async getPlansWithDependencies(
    workspaceId: string,
    columns: string[] = ['CREATED', 'PLAN REVIEWED'],
    projectFilter?: string | null
): Promise<KanbanPlanRecord[]> {
    if (!(await this.ensureReady()) || !this._db) return [];
    const placeholders = columns.map(() => '?').join(',');
    
    let sql = `SELECT plan_id, session_id, topic, kanban_column, dependencies 
               FROM plans
               WHERE workspace_id = ? AND status = 'active' AND kanban_column IN (${placeholders})`;
    const params: any[] = [workspaceId, ...columns];
    
    if (projectFilter) {
        sql += " AND project = ?";
        params.push(projectFilter);
    }
    
    sql += ' ORDER BY kanban_column, updated_at DESC';
    const stmt = this._db.prepare(sql, params);
    return this._readRows(stmt);
}
```

### 2. Update KanbanDatabase.getPlansByColumn()
**File**: `src/services/KanbanDatabase.ts`

Add an optional `projectFilter` parameter and modify the SQL query:

```typescript
public async getPlansByColumn(
    workspaceId: string, 
    column: string,
    projectFilter?: string | null
): Promise<KanbanPlanRecord[]> {
    if (!(await this.ensureReady()) || !this._db) return [];
    const statusFilter = column === 'COMPLETED'
        ? `status = 'completed'`
        : `status = 'active'`;
    
    let sql = `SELECT ${PLAN_COLUMNS} FROM plans
               WHERE workspace_id = ? AND ${statusFilter} AND kanban_column = ?`;
    const params: any[] = [workspaceId, column];
    
    if (projectFilter) {
        sql += " AND project = ?";
        params.push(projectFilter);
    }
    
    sql += ' ORDER BY updated_at DESC';
    const stmt = this._db.prepare(sql, params);
    return this._readRows(stmt);
}
```

### 3. Update KanbanProvider._sendDependencyMapData()
**File**: `src/services/KanbanProvider.ts`

Pass the project filter to the database call:

```typescript
private async _sendDependencyMapData(workspaceRoot: string): Promise<void> {
    if (!this._panel) return;
    const db = this._getKanbanDb(workspaceRoot);
    const workspaceId = await this._readWorkspaceId(workspaceRoot)
        || await db.getWorkspaceId()
        || await db.getDominantWorkspaceId();
    if (workspaceId) {
        const plans = await db.getPlansWithDependencies(workspaceId, ['CREATED', 'PLAN REVIEWED'], this._projectFilter);
        this._panel.webview.postMessage({ type: 'dependencyMapData', plans });
    }
}
```

### 4. Update KanbanProvider getDependencyMapData handler
**File**: `src/services/KanbanProvider.ts`

In the `getDependencyMapData` case handler (around line 4228), pass the project filter:

```typescript
case 'getDependencyMapData': {
    const workspaceRoot = this._currentWorkspaceRoot;
    const copyPrompt = msg.copyPrompt === true;
    if (workspaceRoot) {
        if (copyPrompt) {
            const db = this._getKanbanDb(workspaceRoot);
            const workspaceId = await this._readWorkspaceId(workspaceRoot) || await db.getWorkspaceId() || await db.getDominantWorkspaceId();
            if (workspaceId) {
                const plans = await db.getPlansWithDependencies(workspaceId, ['CREATED', 'PLAN REVIEWED'], this._projectFilter);
                // ... rest of the prompt generation logic
            }
        } else {
            this._sendDependencyMapData(workspaceRoot);
        }
    }
    break;
}
```

### 5. Update KanbanProvider rebuildDependencyMap handler
**File**: `src/services/KanbanProvider.ts`

In the `rebuildDependencyMap` case handler (around line 4263), pass the project filter:

```typescript
case 'rebuildDependencyMap': {
    const workspaceRoot = this._currentWorkspaceRoot;
    if (workspaceRoot && this._taskViewerProvider) {
        const db = this._getKanbanDb(workspaceRoot);
        const workspaceId = await this._readWorkspaceId(workspaceRoot) || await db.getWorkspaceId() || await db.getDominantWorkspaceId();
        if (workspaceId) {
            const plans = await db.getPlansWithDependencies(workspaceId, ['CREATED', 'PLAN REVIEWED'], this._projectFilter);
            const success = await this._taskViewerProvider.handleRebuildDependencyMap(plans);
            this._panel?.webview.postMessage({ type: 'actionTriggered', role: 'analystMap', success });
        }
    }
    break;
}
```

### 6. Update KanbanProvider getUATData handler
**File**: `src/services/KanbanProvider.ts`

In the `getUATData` case handler (around line 6043), pass the project filter to both column queries:

```typescript
case 'getUATData': {
    const workspaceRoot = this._currentWorkspaceRoot;
    if (workspaceRoot) {
        const db = this._getKanbanDb(workspaceRoot);
        const workspaceId = await this._readWorkspaceId(workspaceRoot) || await db.getWorkspaceId() || await db.getDominantWorkspaceId();
        if (workspaceId) {
            const reviewedPlans = await db.getPlansByColumn(workspaceId, 'CODE REVIEWED', this._projectFilter);
            const acceptancePlans = await db.getPlansByColumn(workspaceId, 'ACCEPTANCE TESTED', this._projectFilter);
            const allPlans = [...reviewedPlans, ...acceptancePlans];
            // ... rest of the UAT processing logic
        }
    }
    break;
}
```

## Verification
1. Open kanban.html and select a specific project from the workspace/project dropdown
2. Navigate to the Dependencies tab - verify only plans in the selected project are shown
3. Navigate to the Test (UAT) tab - verify only plans in the selected project are shown
4. Switch to a different project and verify both tabs update to show only that project's plans
5. Clear the project filter (select "All Projects" or unassigned) and verify both tabs show all plans

## Files Changed
- `src/services/KanbanDatabase.ts` - Add project filter parameters to `getPlansWithDependencies()` and `getPlansByColumn()`
- `src/services/KanbanProvider.ts` - Pass project filter in 4 locations: `_sendDependencyMapData()`, `getDependencyMapData` handler, `rebuildDependencyMap` handler, and `getUATData` handler
