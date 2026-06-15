# Fix Kanban Plans Tab Initial Load Bug

## Goal
Fix the bug where the kanban plans tab shows "no plans available" on first load even though the workspace dropdown shows a workspace and plans exist. Plans only appear after interacting with the dropdown.

### Root Cause
The workspace dropdown shows a workspace value but the filter state (`kanbanFilters.workspaceRoot`) is not synchronized with it on initial load. This causes the render logic to filter out all plans.

**Sequence of events:**
1. `restoredTabState` handler (line 2517-2525) sets `kanbanFilters.workspaceRoot` from persisted state and sets `kanbanWorkspaceFilter.value` to match
2. `switchToTab('kanban')` sends `fetchKanbanPlans` message
3. `handleKanbanPlansReady` receives plans and workspace items, then:
   - Populates `_kanbanWorkspaceItems` from `msg.workspaceItems` (line 4456)
   - Calls `populateKanbanFilters()` which rebuilds the dropdown (line 4464)
   - Calls `renderKanbanPlans(_kanbanPlansCache, kanbanFilters)` (line 4466)

**The bug:** `populateKanbanFilters()` rebuilds the dropdown HTML but does not explicitly set `kanbanWorkspaceFilter.value` after rebuilding. The dropdown may show a selected option visually, but the actual `.value` property may not match `kanbanFilters.workspaceRoot`. When the user interacts with the dropdown, the change event fires and synchronizes the values, causing plans to appear.

## Metadata
**Complexity:** 2
**Tags:** bugfix, ui, frontend

## User Review Required
- Confirm that project filter and column filter synchronization should be included in this fix (they share the same root cause).

## Complexity Audit

### Routine
- Single-line value synchronization fix in three filter population functions.
- Reuses existing DOM manipulation patterns.
- No new architectural patterns or state management changes.

### Complex / Risky
- None

## Edge-Case & Dependency Audit
- **Race Conditions**: `handleKanbanPlansReady` sets `_kanbanWorkspaceItems` before calling `populateKanbanFilters`, so the dropdown rebuilds against fresh data. No race.
- **Security**: No security implications; this is purely client-side DOM state synchronization.
- **Side Effects**: Setting `.value` on a `<select>` to a non-existent option is spec-compliant and results in an empty string, which matches "All Workspaces" behavior.
- **Dependencies & Conflicts**: None. Self-contained change within `planning.js`.

## Dependencies
None — this is a standalone bug fix.

## Adversarial Synthesis
Key risks: `updateKanbanProjectFilter` and `updateKanbanColumnFilter` share the same `innerHTML` rebuild pattern and likely exhibit identical desynchronization. Mitigations: apply the same explicit `.value` assignment to both, and verify manual testing covers all three filters.

## Proposed Changes

### `src/webview/planning.js`

**Context**: The `populateKanbanFilters`, `updateKanbanProjectFilter`, and `updateKanbanColumnFilter` functions rebuild `<select>` dropdowns using `innerHTML` and `appendChild`. In some browsers, setting `opt.selected = true` on newly created options does not automatically synchronize the parent `<select>` element's `.value` property. This leaves the filter state (`kanbanFilters.*`) out of sync with the DOM, causing `renderKanbanPlans` to apply a filter that does not match the visible dropdown selection.

**Logic**: After rebuilding each dropdown's option list, explicitly assign the filter state's value to the dropdown element. This guarantees DOM `.value` matches the in-memory filter state before rendering.

**Implementation**:

#### Step 1: Synchronize Workspace Dropdown
**Location**: `populateKanbanFilters` (line 4357-4373)

Insert after the workspace option loop (before `updateKanbanProjectFilter()` call):
```javascript
    // CRITICAL FIX: Explicitly set dropdown value to match filter state
    kanbanWorkspaceFilter.value = currentWS;
```

Full function context:
```javascript
function populateKanbanFilters() {
    if (!kanbanWorkspaceFilter || !kanbanProjectFilter) return;

    // --- Workspace dropdown ---
    const currentWS = kanbanFilters.workspaceRoot;
    kanbanWorkspaceFilter.innerHTML = '<option value="">All Workspaces</option>';
    _kanbanWorkspaceItems.forEach(ws => {
        const opt = document.createElement('option');
        opt.value = ws.workspaceRoot;
        opt.textContent = ws.label;
        if (ws.workspaceRoot === currentWS) opt.selected = true;
        kanbanWorkspaceFilter.appendChild(opt);
    });

    // CRITICAL FIX: Explicitly set dropdown value to match filter state
    // This ensures the .value property is synchronized after rebuilding the HTML
    kanbanWorkspaceFilter.value = currentWS;

    // --- Project dropdown ---
    updateKanbanProjectFilter();
}
```

#### Step 2: Synchronize Project Dropdown
**Location**: `updateKanbanProjectFilter` (line 4375-4411)

Insert at end of function, after the project option loop:
```javascript
    kanbanProjectFilter.value = currentProj;
```

#### Step 3: Synchronize Column Dropdown
**Location**: `updateKanbanColumnFilter` (line 4413-4426)

Insert at end of function, after the column option loop:
```javascript
    kanbanColumnFilter.value = currentColumn;
```

**Edge Cases**:
- If `currentWS` (or `currentProj`, `currentColumn`) does not exist in the rebuilt options, the `.value` assignment becomes `""`, which correctly selects the "All ..." sentinel option.
- If the filter variables are empty strings, the sentinel option remains selected.
- Null/undefined filter elements are guarded by early returns.

## Verification Plan

### Manual Testing
1. Open planning.html in a fresh session
2. Click on the Kanban Plans tab
3. Verify that plans load immediately without needing to interact with the workspace dropdown
4. Verify that the workspace dropdown shows the correct workspace
5. Verify that switching between workspaces works correctly
6. Verify that the filter state persists across tab switches
7. Verify that project and column dropdowns also reflect persisted state on initial load

### Automated Tests
Skipped per session directive. The user will run the test suite separately.

## Risks
- **Low**: The change is a single line addition per filter to ensure value synchronization
- **Low**: Does not affect filtering logic, only dropdown UI state
- **Low**: If the value doesn't exist in the dropdown options, it will simply be empty (same as current behavior)

## Files Changed
- `src/webview/planning.js`
  - line ~4369: add `kanbanWorkspaceFilter.value = currentWS;`
  - line ~4411: add `kanbanProjectFilter.value = currentProj;`
  - line ~4426: add `kanbanColumnFilter.value = currentColumn;`
