# Fix: Plan Watcher Ignores Active Project When Assigning New Plans

## Problem

When a project is selected in the kanban board's workspace/project dropdown, new plans detected by the plan watcher are placed in the base workspace kanban instead of the active project kanban.

## Root Cause

`setCurrentProject()` stores the active project keyed by the **resolved** effective workspace root (via `resolveEffectiveWorkspaceRootFromMappings()`). But `_handlePlanFile()` performs its `_currentProjects` lookup using the **raw** workspace root passed to it. When workspace mappings cause these two paths to differ, the lookup returns `undefined` and the project falls back to `''` (base workspace).

All five watcher entry points (VS Code create/change events, native fs watcher, periodic scan, manual trigger scan, startup scan) converge on `_handlePlanFile()` — so the fix is in exactly one place.

## Fix

**File:** `src/services/GlobalPlanWatcherService.ts`  
**Location:** `_handlePlanFile()` — the line that resolves the active project (~L495)

Resolve the workspace root before the map lookup, consistent with how `setCurrentProject()` stores it:

```typescript
// Before (broken):
const project = metadata.project || this._currentProjects.get(workspaceRoot) || '';

// After (fixed):
const effectiveRoot = resolveEffectiveWorkspaceRootFromMappings(workspaceRoot);
const project = metadata.project || this._currentProjects.get(effectiveRoot) || '';
```

`resolveEffectiveWorkspaceRootFromMappings` is already imported and used elsewhere in the same file.

## Scope

- **1 file changed:** `src/services/GlobalPlanWatcherService.ts`
- **2 lines changed:** replace the single `_currentProjects.get(workspaceRoot)` call with an effectiveRoot-resolved equivalent
- No schema changes, no UI changes, no new dependencies

## Test

1. Open a workspace with at least one project defined.
2. Select a project in the kanban dropdown.
3. Create a new plan file (via the plan creation UI or by dropping a `.md` file into the plans directory).
4. Confirm the new plan card appears in the selected project's kanban, not the base workspace kanban.
5. Switch to a different project and repeat — confirm plans land in whichever project is active at creation time.
6. Confirm plans created with no project selected still land in the base workspace kanban.

## Metadata

**Complexity:** 2  
**Tags:** frontend, bugfix, reliability
