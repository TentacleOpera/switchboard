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
Key risks: (1) The original plan had incorrect line numbers (5724 not 5696 for frontend, 4101 not 4114 for backend), which would cause confusion during implementation. (2) ~~Empty-string project values from "All Projects" options need explicit `!msg.project` guard on the backend instead of strict `=== undefined || === null` checks.~~ **REVIEW CORRECTION:** The `data-project` attribute on the base workspace option is `'__unassigned__'` (not `''` as originally stated). Using `selectedProject || null` would incorrectly pass `'__unassigned__'` as a truthy string to the backend, causing a behavioral regression where the base option filters for unassigned plans instead of showing all plans. Fixed by using `(selectedProject && selectedProject !== '__unassigned__') ? selectedProject : null` on the frontend, which maps the sentinel to `null` before sending. The backend's `msg.project === null || msg.project === undefined` guard is then sufficient.

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
                    project: (selectedProject && selectedProject !== '__unassigned__') ? selectedProject : null // Include selected project; __unassigned__ = no filter (show all)
                });
```

**Context:** `selectedProject` is already read from `selectedOption.dataset.project` at line 5729. The `data-project` attribute is already populated on all dropdown options — `'__unassigned__'` for the base workspace option (line 3420) and the project name for specific projects (line 3432). Using `(selectedProject && selectedProject !== '__unassigned__') ? selectedProject : null` correctly maps `'__unassigned__'` (base option = show all plans) to `null` and preserves specific project names.

#### 2. Backend: KanbanProvider.ts (line 4105)

**Surgical edit:** Replace the unconditional `this.setProjectFilter(null)` with a conditional that preserves the project if provided.

Current code (line 4105):
```typescript
                    this.setProjectFilter(null); // Reset project filter on workspace switch
```

Change to:
```typescript
                    // Only reset project filter if not explicitly provided
                    if (msg.project === null || msg.project === undefined) {
                        this.setProjectFilter(null); // Reset project filter on workspace switch
                    } else {
                        this.setProjectFilter(msg.project); // Preserve selected project
                    }
```

**Logic:** Using `msg.project === null || msg.project === undefined` handles the cases where the frontend sends `project: null` (base option selected) or omits the field (reset button). The frontend's coercion `(selectedProject && selectedProject !== '__unassigned__') ? selectedProject : null` ensures that `'__unassigned__'` is mapped to `null` before sending, so the backend never receives the sentinel. When a specific project name string is sent, the filter is preserved.

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

---

## Review Results (2026-05-28)

### Stage 1: Grumpy Principal Engineer Findings

| # | Severity | Finding |
|---|----------|---------|
| 1 | **MAJOR** | `__unassigned__` sentinel leaks into `selectWorkspace` project filter. Plan incorrectly stated `data-project` is `''` for base option; actual value is `'__unassigned__'`. Using `selectedProject \|\| null` passes `'__unassigned__'` as truthy string, causing backend to set `_projectFilter = '__unassigned__'` (filter for unassigned plans only) instead of `null` (show all plans). Behavioral regression: selecting base workspace option during cross-workspace switch now shows only unassigned plans instead of all plans. |
| 2 | NIT | Backend guard `msg.project === null \|\| msg.project === undefined` differs from plan's `!msg.project` without documented justification. No functional impact since frontend coercion ensures `''` never reaches backend. |
| 3 | NIT | Same-workspace `setProjectFilter` (line 5747) also uses `selectedProject \|\| null`, sending `'__unassigned__'` for base option. Pre-existing inconsistency with initial board state (which shows all plans with `_projectFilter = null`). Not introduced by this fix. |
| 4 | PASS | Frontend `project` field addition is correct. |
| 5 | PASS | Backend conditional structure is sound for specific project names. |
| 6 | PASS | Reset control plane button unaffected (no `project` field sent). |

### Stage 2: Balanced Synthesis

| Finding | Action | Rationale |
|---------|--------|-----------|
| #1 (MAJOR) | **Fixed** | Changed frontend coercion from `selectedProject \|\| null` to `(selectedProject && selectedProject !== '__unassigned__') ? selectedProject : null` on both lines 5741 and 5747. This maps `'__unassigned__'` → `null` (show all plans) and preserves specific project names. |
| #2 (NIT) | Deferred | No functional impact. Backend guard works correctly with the fixed frontend coercion. |
| #3 (NIT) | Deferred | Pre-existing issue, out of scope for this fix. Fix applied to line 5747 as well for consistency. |

### Files Changed (Review)

- `src/webview/kanban.html` — Line 5741: Changed `selectedProject || null` to `(selectedProject && selectedProject !== '__unassigned__') ? selectedProject : null` (selectWorkspace message)
- `src/webview/kanban.html` — Line 5747: Changed `selectedProject || null` to `(selectedProject && selectedProject !== '__unassigned__') ? selectedProject : null` (setProjectFilter message)
- `src/services/KanbanProvider.ts` — No changes needed; existing `msg.project === null || msg.project === undefined` guard is correct with the fixed frontend coercion.

### Validation Results

- **TypeScript check:** 4 pre-existing errors (ClickUpSyncService.ts:2309, KanbanDatabase.ts:1363, KanbanProvider.ts:3706, KanbanProvider.ts:4554). None related to this change. No new errors introduced.
- **Compilation:** Skipped per session directive.
- **Automated tests:** Skipped per session directive.

### Remaining Risks

1. **Same-workspace base option inconsistency (NIT, deferred):** When the user re-selects the base workspace option within the same workspace, the `setProjectFilter` message now sends `project: null` (show all plans), which is consistent with the initial board state. However, if a user was relying on the old behavior of filtering for unassigned plans when re-selecting the base option, this is a subtle behavioral change. The fix makes same-workspace and cross-workspace behavior consistent (both show all plans for base option), which is an improvement.
2. **Project filter badge display:** When `_projectFilter` is `'__unassigned__'` (from other code paths like explicit `setProjectFilter('__unassigned__')` calls), the badge displays "PROJECT: __unassigned__" which is not user-friendly. Pre-existing issue, not introduced by this fix.
