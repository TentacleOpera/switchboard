# Fix Kanban Workspace/Project Switch Bug

## Goal
When switching workspaces via the kanban dropdown and selecting a specific project (e.g., "autism360app > v5 funnel"), preserve the selected project filter instead of resetting to "All Projects".

## Metadata
- **Tags:** [frontend, backend, bugfix, UX]
- **Complexity:** 3

## User Review Required
- Verify that switching workspaces with a project selected now correctly filters to that project
- Verify that switching workspaces to "All Projects" still shows all plans (no regression)
- Verify that same-workspace project switching still works (no regression)

## Problem
In kanban.html, when switching from one workspace to another and selecting a specific project (e.g., from "switchboard" to "autism360app > v5 funnel"), the selection incorrectly bounces to "autism360app > All Projects" instead of the specific project that was selected.

## Root Cause
The frontend `selectWorkspace` message handler does not include the selected project when switching workspaces. The backend `selectWorkspace` handler in `KanbanProvider.ts` always resets the project filter to null (line 4105), regardless of whether the user selected a specific project in the dropdown.

**Frontend (kanban.html, lines 5724-5756)**:
- When workspace changes, sends `selectWorkspace` with only `workspaceRoot` and `controlPlaneAction`
- Project filter is only sent via `setProjectFilter` when the workspace is the same
- This means the selected project is lost during workspace switches

**Backend (KanbanProvider.ts, lines 4101-4141)**:
- `selectWorkspace` handler always calls `this.setProjectFilter(null)` (line 4105)
- This resets the project filter to "All Projects" regardless of user selection

## Complexity Audit

### Routine
- Adding `project` field to existing `selectWorkspace` message (frontend)
- Adding conditional around existing `setProjectFilter(null)` call (backend)
- Both changes follow existing message-passing patterns exactly
- The `data-project` attribute already exists on dropdown options (lines 3420, 3432)

### Complex / Risky
- None

## Edge-Case & Dependency Audit

- **Race Conditions:** Rapid clicking could fire `change` events on a partially rebuilt dropdown, but this is a pre-existing issue unrelated to this fix. The fix does not make it worse.
- **Security:** No security implications — project filter is a UI-only concept with no privilege escalation risk.
- **Side Effects:** `setProjectFilter()` also calls `this._globalPlanWatcher?.setCurrentProject()`, which correctly updates the plan watcher to the new project. No side effect concern.
- **Dependencies & Conflicts:** The `_refreshBoard` method reads `this._projectFilter` and sends it back as `projectFilter` in the `updateWorkspaceSelection` message (line 1019). Since `setProjectFilter` is called before `_refreshBoard` in the `selectWorkspace` handler, the round-trip is correct. No conflict.

## Dependencies
- None

## Adversarial Synthesis
Key risks: (1) The original plan had incorrect line numbers (5724 not 5696 for frontend, 4101 not 4114 for backend), which would cause confusion during implementation. (2) Empty-string project values from "All Projects" options need explicit `!msg.project` guard on the backend instead of strict `=== undefined || === null` checks. Mitigations: corrected line numbers in this improved plan; backend conditional uses `!msg.project` to safely handle `undefined`, `null`, and `''`.

## Solution
Modify the frontend to include the selected project in the `selectWorkspace` message when switching workspaces, and update the backend to accept and apply the project filter if provided.

### Changes Required

#### 1. Frontend: kanban.html (line 5740)

**Surgical edit:** Add `project` field to the `selectWorkspace` message payload.

Current code (lines 5734-5741):
```javascript
            if (isDifferentWorkspace) {
                // Switch workspace context (triggers full board refresh)
                lastBoardSignature = '';
                postKanbanMessage({
                    type: 'selectWorkspace',
                    workspaceRoot: selectedWorkspaceRoot,
                    controlPlaneAction: controlPlaneAction
                });
```

Change to:
```javascript
            if (isDifferentWorkspace) {
                // Switch workspace context (triggers full board refresh)
                lastBoardSignature = '';
                postKanbanMessage({
                    type: 'selectWorkspace',
                    workspaceRoot: selectedWorkspaceRoot,
                    controlPlaneAction: controlPlaneAction,
                    project: selectedProject || null // Include selected project
                });
```

**Context:** `selectedProject` is already read from `selectedOption.dataset.project` at line 5729. The `data-project` attribute is already populated on all dropdown options — empty string `''` for "All Projects" (line 3420) and the project name for specific projects (line 3432). Using `selectedProject || null` correctly maps `''` (All Projects) to `null`.

#### 2. Backend: KanbanProvider.ts (line 4105)

**Surgical edit:** Replace the unconditional `this.setProjectFilter(null)` with a conditional that preserves the project if provided.

Current code (line 4105):
```typescript
                    this.setProjectFilter(null); // Reset project filter on workspace switch
```

Change to:
```typescript
                    // Only reset project filter if not explicitly provided
                    if (!msg.project) {
                        this.setProjectFilter(null); // Reset project filter on workspace switch
                    } else {
                        this.setProjectFilter(msg.project); // Preserve selected project
                    }
```

**Logic:** Using `!msg.project` handles all falsy cases (`undefined`, `null`, `''`) uniformly. When the frontend sends `project: null` (All Projects) or omits the field, the filter resets as before. When it sends a project name string, the filter is preserved.

**No other lines in the `selectWorkspace` case (4101-4141) need modification.** The control-plane action handling, `resolveEffectiveWorkspaceRoot` logic, session watcher, plan watcher reinitialization, terminal dispatch cleanup, and `_refreshBoard` call all remain unchanged.

## Verification Plan

### Automated Tests
- SKIP: No automated tests to run per session directive.

### Manual Verification
1. Open kanban.html in switchboard workspace
2. Select "autism360app > v5 funnel" from the workspace-project dropdown
3. Verify the board shows only plans in the "v5 funnel" project (not "All Projects")
4. Switch back to "switchboard > All Projects"
5. Verify the board shows all plans in the switchboard workspace
6. Switch again to "autism360app > v5 funnel"
7. Verify the board shows only plans in the "v5 funnel" project (not "All Projects")
8. Switch to "autism360app > All Projects"
9. Verify the board shows all plans in the autism360app workspace (regression check)

## Testing
1. Open kanban.html in switchboard workspace
2. Select "autism360app > v5 funnel" from the workspace-project dropdown
3. Verify the board shows only plans in the "v5 funnel" project
4. Switch back to "switchboard > All Projects"
5. Switch again to "autism360app > v5 funnel"
6. Verify the board shows only plans in the "v5 funnel" project (not "All Projects")

## Files Changed
- `/Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/kanban.html` (line 5740 — add `project` field)
- `/Users/patrickvuleta/Documents/GitHub/switchboard/src/services/KanbanProvider.ts` (line 4105 — conditional `setProjectFilter`)

## Recommendation
Complexity 3 → **Send to Intern**
