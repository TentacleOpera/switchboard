# Fix Kanban Project Assigner Filter

## Goal
Replace the "All Projects" dropdown option with a base workspace option that shows only unassigned plans (project = ''), so users can easily find tasks that haven't been assigned to any project yet.

## Metadata
**Tags:** [frontend, backend, bugfix, UX]
**Complexity:** 5

## User Review Required
- Confirm that the base workspace option should show *only unassigned plans* (not all plans). This is a behavior change from the current "All Projects" which shows everything.
- Confirm that the ASSIGN button should remain a no-op when the base workspace option is selected (no "unassign" capability in this change).

## Problem
The project assigner in kanban.html is difficult to use because:
- After assigning tasks to a project, switching back to "All Projects" still shows all tasks including the ones just assigned
- There's no way to distinguish which tasks have already been assigned
- The "All Projects" designation shows everything, making it impossible to find unassigned tasks

## Root Cause
The dropdown currently has an "All Projects" option for each workspace that returns ALL plans in that workspace regardless of project assignment. This doesn't help users find unassigned tasks.

## Solution
Remove the "All Projects" designation and instead use the existing database `project` column (which defaults to empty string '') to represent "no project assigned". When selecting the base workspace in the dropdown, only show plans with `project = ''`.

**Critical Design Decision — Sentinel Value:**
JavaScript's falsy-string coercion destroys empty-string semantics at multiple points in the chain (`|| null`, `if (!project)`, `project || null`). Instead of fighting this at every call site, use a **dedicated sentinel constant** `UNASSIGNED_PROJECT_FILTER = '__unassigned__'` that is always truthy. The frontend sends this sentinel when the base workspace option is selected; the backend stores it in `_projectFilter`; the DB layer translates it to `project = ''` at query time.

## Complexity Audit

### Routine
- Remove "All Projects" option text from dropdown builder
- Add base workspace option with sentinel dataset value
- Add `UNASSIGNED_PROJECT_FILTER` constant to KanbanDatabase.ts
- Translate sentinel to `project = ''` in SQL query methods
- Update dropdown label from "Workspace > All Projects" to just "Workspace"

### Complex / Risky
- Ensuring the sentinel value flows correctly through 5+ call sites in KanbanProvider.ts and TaskViewerProvider.ts without being coerced to null
- The `activeProjectFilter` round-trip: backend→frontend→backend must preserve the sentinel through `updateWorkspaceSelection` messages
- Silent behavior change for existing users who had "All Projects" selected — the same dropdown value now means "unassigned only" instead of "everything"

## Edge-Case & Dependency Audit

**Race Conditions:** None. The project filter is set synchronously before the async board refresh.

**Security:** The sentinel value `__unassigned__` is a hardcoded constant, not user input. No injection risk. The SQL query still uses parameterized statements.

**Side Effects:**
- `deleteProject` handler (KanbanProvider.ts line 4170-4171): When a project is deleted while it's the active filter, the filter resets to null (show all). This is unchanged and correct.
- `assignSelectedToProject` (kanban.html line 5685-5688): When base workspace option is selected and ASSIGN is clicked, it's a no-op with info message. This is unchanged and acceptable.
- `reassignPlansWorkspace` (kanban.html line 5698-5704): Cross-workspace reassignment passes `targetProject` which could be the sentinel. The backend must handle this — see Implementation step 4.

**Dependencies & Conflicts:**
- `control-plane-repo-scope.test.js` tests `getCompletedPlansFilteredByProject` with named projects. The sentinel value must not break existing test assertions. New test cases for the unassigned filter should be added.
- The `_globalPlanWatcher?.setCurrentProject()` call in `setProjectFilter` (line 3634) receives the filter value. It must handle the sentinel correctly or be documented as unaffected.

## Dependencies
(None — this is a self-contained bugfix)

## Adversarial Synthesis
Key risks: (1) The original plan's empty-string approach is defeated by JS falsy coercion at 5+ call sites — using a truthy sentinel constant eliminates this entire class of bugs. (2) The `activeProjectFilter` round-trip from backend→frontend→backend must preserve the sentinel through message serialization. (3) Existing users with "All Projects" selected will see a silent behavior change. Mitigations: Sentinel constant is always truthy; round-trip uses strict equality checks; behavior change is low-severity and documented.

## Implementation

### 1. Backend: KanbanDatabase.ts — Add sentinel constant and update query methods
**File**: `/Users/patrickvuleta/Documents/GitHub/switchboard/src/services/KanbanDatabase.ts`

**Change 1**: Add sentinel constant at class level (near top of class, around line 30)
```typescript
/** Sentinel value used by the filter chain to represent "unassigned plans" (project = ''). 
 *  Always truthy, unlike empty string which is falsy and gets coerced to null. */
public static readonly UNASSIGNED_PROJECT_FILTER = '__unassigned__';
```

**Change 2**: Modify `getBoardFilteredByProject` (lines 2130-2152)
```typescript
public async getBoardFilteredByProject(
    workspaceId: string,
    project: string | null,
    repoScope: string | null
): Promise<KanbanPlanRecord[]> {
    if (!(await this.ensureReady()) || !this._db) return [];
    // Translate sentinel to empty-string filter for unassigned plans
    const effectiveProject = project === KanbanDatabase.UNASSIGNED_PROJECT_FILTER ? '' : project;
    if (!effectiveProject && !repoScope) {
        return this.getBoard(workspaceId);
    }
    let sql = `SELECT ${PLAN_COLUMNS} FROM plans WHERE workspace_id = ? AND status = 'active'`;
    const params: unknown[] = [workspaceId];
    if (effectiveProject !== null && effectiveProject !== undefined) {
        sql += ' AND project = ?';
        params.push(effectiveProject);
    }
    if (repoScope) {
        sql += " AND repo_scope IN (?, '')";
        params.push(repoScope);
    }
    sql += ' ORDER BY updated_at DESC';
    const stmt = this._db.prepare(sql, params);
    return this._readRows(stmt);
}
```

**Change 3**: Modify `getCompletedPlansFilteredByProject` (lines 2222-2246) — same pattern
```typescript
public async getCompletedPlansFilteredByProject(
    workspaceId: string,
    project: string | null,
    repoScope: string | null,
    limit: number = 100
): Promise<KanbanPlanRecord[]> {
    if (!(await this.ensureReady()) || !this._db) return [];
    const effectiveProject = project === KanbanDatabase.UNASSIGNED_PROJECT_FILTER ? '' : project;
    if (!effectiveProject && !repoScope) {
        return this.getCompletedPlans(workspaceId, limit);
    }
    let sql = `SELECT ${PLAN_COLUMNS} FROM plans WHERE workspace_id = ? AND status = 'completed'`;
    const params: unknown[] = [workspaceId];
    if (effectiveProject !== null && effectiveProject !== undefined) {
        sql += ' AND project = ?';
        params.push(effectiveProject);
    }
    if (repoScope) {
        sql += " AND repo_scope IN (?, '')";
        params.push(repoScope);
    }
    sql += ' ORDER BY updated_at DESC LIMIT ?';
    params.push(limit);
    const stmt = this._db.prepare(sql, params);
    return this._readRows(stmt);
}
```

### 2. Backend: KanbanProvider.ts — Preserve sentinel through the filter chain
**File**: `/Users/patrickvuleta/Documents/GitHub/switchboard/src/services/KanbanProvider.ts`

**Change 1**: Import the sentinel constant (add near top imports)
```typescript
import { KanbanDatabase } from './KanbanDatabase';
// The sentinel is accessed as KanbanDatabase.UNASSIGNED_PROJECT_FILTER
```

**Change 2**: Fix `_refreshBoardImpl` filter check (line 1672)
```typescript
// BEFORE:
const dbRows = (projectFilter || repoScope)
    ? await db.getBoardFilteredByProject(workspaceId, projectFilter, repoScope)
    : await db.getBoard(workspaceId);

// AFTER:
const dbRows = (projectFilter !== null || repoScope)
    ? await db.getBoardFilteredByProject(workspaceId, projectFilter, repoScope)
    : await db.getBoard(workspaceId);
```
Note: `projectFilter` is now either `null` (no filter), a project name string, or the sentinel. All non-null values should trigger the filtered path. The sentinel is truthy so `||` would also work, but `!== null` is more explicit and defensive.

**Change 3**: Fix `selectWorkspace` handler (line 4106-4110)
```typescript
// BEFORE:
if (!msg.project) {
    this.setProjectFilter(null);
} else {
    this.setProjectFilter(msg.project);
}

// AFTER:
if (msg.project === null || msg.project === undefined) {
    this.setProjectFilter(null);
} else {
    this.setProjectFilter(msg.project);
}
```
This preserves the sentinel value when the frontend sends it.

**Change 4**: Fix `setProjectFilter` message handler (line 4186)
```typescript
// BEFORE:
this.setProjectFilter(msg.project || null);

// AFTER:
this.setProjectFilter(msg.project ?? null);
```
`??` (nullish coalescing) only converts `null`/`undefined` to null, preserving empty string and the sentinel. (Empty string shouldn't reach here with the sentinel approach, but `??` is the correct operator regardless.)

**Change 5**: Fix `projectFilter` in board update messages (lines 1019, 1753, 1881)
These already use `this._projectFilter || null`. Since the sentinel is truthy, `|| null` won't strip it. **No change needed** — but verify this is correct during implementation.

### 3. Backend: TaskViewerProvider.ts — Same sentinel-aware filter logic
**File**: `/Users/patrickvuleta/Documents/GitHub/switchboard/src/services/TaskViewerProvider.ts`

**Change 1**: Fix `refreshRunSheets` filter check (lines 13474-13479)
```typescript
// BEFORE:
const activeRows = (repoScope || projectFilter)
    ? await db.getBoardFilteredByProject(workspaceId, projectFilter, repoScope)
    : await db.getBoard(workspaceId);
const completedRows = (repoScope || projectFilter)
    ? await db.getCompletedPlansFilteredByProject(workspaceId, projectFilter, repoScope)
    : await db.getCompletedPlans(workspaceId);

// AFTER:
const activeRows = (projectFilter !== null || repoScope)
    ? await db.getBoardFilteredByProject(workspaceId, projectFilter, repoScope)
    : await db.getBoard(workspaceId);
const completedRows = (projectFilter !== null || repoScope)
    ? await db.getCompletedPlansFilteredByProject(workspaceId, projectFilter, repoScope)
    : await db.getCompletedPlans(workspaceId);
```

### 4. Frontend: kanban.html — Replace "All Projects" with base workspace option using sentinel
**File**: `/Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/kanban.html`

**Change 1**: Replace "All Projects" option with base workspace option (lines 3415-3424)
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

// REPLACE WITH:
// Base workspace option (shows only unassigned plans)
const baseOpt = document.createElement('option');
baseOpt.value = wsRoot + '|__unassigned__';
baseOpt.textContent = wsLabel; // Just workspace name, no "All Projects" suffix
baseOpt.dataset.workspaceRoot = wsRoot;
baseOpt.dataset.project = '__unassigned__'; // Sentinel for "unassigned" filter
if (item.controlPlaneAction || item.selectionMode) {
    baseOpt.dataset.controlPlaneAction = item.controlPlaneAction || item.selectionMode;
}
select.appendChild(baseOpt);
```

**Change 2**: Fix change handler to preserve sentinel (lines 5741, 5747)
```javascript
// Line 5741 — BEFORE:
project: selectedProject || null

// Line 5741 — AFTER:
project: selectedProject || null  // No change needed — sentinel '__unassigned__' is truthy, so || null won't strip it

// Line 5747 — BEFORE:
project: selectedProject || null

// Line 5747 — AFTER:
project: selectedProject || null  // Same — sentinel is truthy, no change needed
```

**Change 3**: Fix `activeProjectFilter` round-trip (line 5117)
```javascript
// BEFORE:
activeProjectFilter = msg.projectFilter || null;

// AFTER:
activeProjectFilter = msg.projectFilter ?? null;
```
This preserves the sentinel when the backend sends it back. The sentinel is truthy so `|| null` would also work, but `??` is more correct semantically.

**Change 4**: Fix dropdown restore logic (lines 3440-3441)
```javascript
// BEFORE:
const targetProject = activeProjectFilter || '';
const targetValue = explicitRoot + '|' + targetProject;

// AFTER:
const targetProject = activeProjectFilter ?? '';
const targetValue = explicitRoot + '|' + targetProject;
```
This ensures the sentinel is preserved when restoring the dropdown selection after a board refresh.

**Change 5**: Fix fallback restore logic (line 3469)
```javascript
// BEFORE:
const fallbackProject = activeProjectFilter || '';

// AFTER:
const fallbackProject = activeProjectFilter ?? '';
```

**Change 6**: Fix same-workspace project comparison (line 5743)
```javascript
// BEFORE:
} else if (selectedProject !== (activeProjectFilter || '')) {

// AFTER:
} else if (selectedProject !== (activeProjectFilter ?? '')) {
```

**Change 7**: Handle sentinel in ASSIGN button flow (line 5673, 5685)
```javascript
// Line 5673 — BEFORE:
const targetProject = selectedOption.dataset.project || '';

// Line 5673 — AFTER:
const targetProject = selectedOption.dataset.project || '';
// When base workspace option is selected, targetProject is '__unassigned__'.
// Line 5685: if (isSameWorkspace && !targetProject) — sentinel is truthy, so this no longer triggers.
// We need to check for the sentinel explicitly:

// Line 5685 — BEFORE:
if (isSameWorkspace && !targetProject) {

// Line 5685 — AFTER:
if (isSameWorkspace && (!targetProject || targetProject === '__unassigned__')) {
```
This preserves the no-op behavior when the base workspace option is selected and ASSIGN is clicked.

**Change 8**: Handle sentinel in cross-workspace reassignment (line 5703)
```javascript
// Line 5703 — BEFORE:
targetProject: targetProject

// Line 5703 — AFTER:
targetProject: targetProject === '__unassigned__' ? '' : targetProject
```
When reassigning to the base workspace (unassigned), send empty string to the backend so it clears the project field.

**Change 9**: Handle sentinel in same-workspace assignment (line 5709)
```javascript
// Line 5709 — BEFORE:
projectName: targetProject,

// Line 5709 — AFTER:
projectName: targetProject === '__unassigned__' ? '' : targetProject,
```
Same logic — translate sentinel to empty string for the backend assignment operation.

**Change 10**: Delete button state (line 5754)
```javascript
// Line 5754 — BEFORE:
btnDeleteProject.disabled = !selectedProject;

// Line 5754 — AFTER:
btnDeleteProject.disabled = !selectedProject || selectedProject === '__unassigned__';
```
The delete button should be disabled for the base workspace option (unassigned is not a deletable project).

### 5. Testing
- Test assigning tasks to a project
- Switch back to base workspace option
- Verify only unassigned tasks are shown
- Verify assigned tasks no longer appear in the base workspace view
- Test that project-specific views still work correctly
- Test cross-workspace assignment still works
- Test that ASSIGN button is no-op when base workspace option is selected
- Test that delete button is disabled when base workspace option is selected
- Test that the sentinel value `__unassigned__` never appears in the UI or in stored plan data
- Test board refresh preserves the unassigned filter selection

## Files Changed
- `/Users/patrickvuleta/Documents/GitHub/switchboard/src/services/KanbanDatabase.ts` — Sentinel constant, query method updates
- `/Users/patrickvuleta/Documents/GitHub/switchboard/src/services/KanbanProvider.ts` — Filter chain fixes (5 changes)
- `/Users/patrickvuleta/Documents/GitHub/switchboard/src/services/TaskViewerProvider.ts` — Filter check fixes (1 change)
- `/Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/kanban.html` — Dropdown, change handler, round-trip fixes (10 changes)

## Verification Plan

### Automated Tests
- Update `src/test/control-plane-repo-scope.test.js` to add test cases for `getBoardFilteredByProject` and `getCompletedPlansFilteredByProject` with the `__unassigned__` sentinel, verifying it returns only plans with `project = ''`.
- Add assertion that the sentinel value never appears in stored plan `project` fields.
- Existing tests for named project filters must continue to pass unchanged.

### Manual Testing
1. Select a workspace in the dropdown
2. Verify the base workspace option shows just the workspace name (no "All Projects" suffix)
3. Assign some tasks to a project
4. Switch back to the base workspace option
5. Confirm only unassigned tasks are visible
6. Select the project you assigned to
7. Confirm the assigned tasks appear there
8. With base workspace option selected, click ASSIGN — confirm no-op with info message
9. With base workspace option selected, confirm delete button is disabled
10. Switch workspaces and back — confirm filter selection is preserved

## Recommendation
Complexity 5 → **Send to Coder**
