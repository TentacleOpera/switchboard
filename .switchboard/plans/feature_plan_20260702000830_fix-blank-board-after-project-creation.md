# Fix: Parent Board Shows Blank After Creating New Project

**Plan ID:** 1bcb4fb2-7dd9-4c84-9efe-789622130c9f

## Goal

After creating a new project, the parent kanban board shows blank even though the dropdown filter has not changed. The dropdown filter display needs to change to the newly created project board upon creation, and the board should immediately display the new project's (empty) plan list rather than going blank.

### Problem Analysis & Root Cause

**Current flow:** When a user creates a new project from the kanban board:
1. `kanban.html` posts an `addProject` message to `KanbanProvider.ts`
2. `KanbanProvider.ts` (line 5476) calls `db.addProject()` to insert the project into the database
3. `KanbanProvider.ts` (line 5477) invalidates `_allWorkspaceProjectsCache`
4. `KanbanProvider.ts` (line 5485) calls `setProjectFilter(projectName)` to set `this._projectFilter = projectName`
5. `KanbanProvider.ts` (line 5487) calls `_refreshBoard(workspaceRoot)` which fetches updated projects and sends `updateWorkspaceSelection` to the kanban webview (`this._panel.webview.postMessage`)
6. `kanban.html` (line 6132) receives the `updateWorkspaceSelection` message

**The sync IS happening correctly:** Line 6137 syncs `activeProjectFilter = msg.projectFilter ?? null;` BEFORE calling `updateWorkspaceProjectDropdown()` at line 6146. So `activeProjectFilter` IS set to the new project name when the dropdown rebuilds. The original plan's claim that "activeProjectFilter hasn't been synced yet" was **incorrect** — verified against source.

**The REAL bug:** In `updateWorkspaceProjectDropdown()` (starts at line 4152, restoration logic at lines 4186-4226), when `explicitRoot` is `null` (which it is when the workspace root hasn't changed — and project creation doesn't change the workspace root), the function follows this priority:
1. **Line 4187:** If `explicitRoot` is set → use `activeProjectFilter` (SKIPPED because explicitRoot is null)
2. **Line 4207:** If `savedValue` matches an existing option → restore `savedValue` (the OLD selection)
3. **Line 4218:** Fallback → use `activeProjectFilter`

Since the workspace root didn't change, `explicitRoot` is null (line 6145-6146: `explicitChange = previousRoot !== '' && previousRoot !== currentWorkspaceRoot` → false when same workspace). The function jumps to step 2: `savedValue` is the previous dropdown value (e.g., `root|__unassigned__` or `root|OldProject`), and that option still exists after rebuild. So it restores the OLD selection and **never reaches step 3** where `activeProjectFilter` (the new project name) would be used.

**Result:** The dropdown stays on the old project (or unassigned), the backend filter is set to the new project, and the board shows the new project's empty plan list — which renders as "No plans" empty state (lines 5197-5198, 5222-5223). The board isn't truly "blank" — it's showing the correct empty state for the new project, but the dropdown display is out of sync with the backend filter, making it appear broken.

**Root cause:** The restoration logic at line 4207 prioritizes `savedValue` (old selection) over `activeProjectFilter` (new backend filter) when `explicitRoot` is null. Project creation changes the project filter without changing the workspace root, so the explicit-root branch is skipped and the old selection is restored.

## Metadata
- **Tags:** bugfix, frontend, kanban, project-creation, dropdown
- **Complexity:** 5

## Complexity Audit

### Routine
- Reading and understanding the dropdown rebuild logic in `kanban.html` (function at line 4152, restoration at 4186-4226)
- Testing that the board shows the correct (empty) state for the new project

### Complex / Risky
- **Dropdown restoration priority logic** — The fix changes the priority order in `updateWorkspaceProjectDropdown()` so that `activeProjectFilter` (backend filter) is checked before `savedValue` (old selection) when `explicitRoot` is null. Must not break workspace-switching behavior (which uses `explicitRoot`).
- **Value format matching** — Dropdown option values are composite `root|projectName`. The `activeProjectFilter` is just the project name. The fix must construct the composite value and match it against options, using `currentWorkspaceRoot` (line 3824) as the root component.

## Edge-Case & Dependency Audit

- **Project created from kanban.html vs project.html:** The creation flow differs. This fix targets the kanban.html path (the `addProject` handler in `KanbanProvider.ts`).
- **Multiple workspaces:** The dropdown has per-workspace project options. The fix uses `currentWorkspaceRoot` (line 3824) to construct the composite value — this is the active workspace root, set from `msg.workspaceRoot` at line 6135.
- **Project name with special characters:** The project name is used as the filter value. The composite value is `root + '|' + projectName`, so pipe characters in project names would break matching. This is a pre-existing limitation, not introduced by this fix.
- **Workspace switching:** Workspace switching passes `explicitRoot` to `updateWorkspaceProjectDropdown`, which takes the branch at line 4187. The fix only modifies the non-explicit branch (line 4206+), so workspace switching is unaffected.
- **Empty state already exists:** The board rendering at lines 5197-5198 and 5222-5223 already shows "No plans" for empty projects. No empty-state fix needed — the board is NOT blank, it's showing the correct empty state for the new project. The visible bug is the dropdown not matching the backend filter.
- **Dependencies:** `KanbanProvider.ts` (`addProject` handler lines 5463-5497, `setProjectFilter` line 4876, `_refreshBoardImpl` lines 2210-2406), `kanban.html` (`updateWorkspaceProjectDropdown` line 4152, `updateWorkspaceSelection` handler lines 6132-6170, `currentWorkspaceRoot` line 3824, `activeProjectFilter` line 3830).

## Proposed Changes

### 1. Fix dropdown restoration to prioritize `activeProjectFilter` over `savedValue`

**File:** `src/webview/kanban.html` (in `updateWorkspaceProjectDropdown()`, lines 4206-4226)

The current logic at line 4207 restores `savedValue` (old selection) before checking `activeProjectFilter`. The fix inserts a check for `activeProjectFilter` BEFORE the `savedValue` restore, so that when the backend filter has been updated (e.g., after project creation), the dropdown follows the backend:

```javascript
// REPLACE lines 4206-4226 with:

// Priority 1: If activeProjectFilter is set and matches an option, use it.
// This ensures the dropdown follows the backend filter (e.g., after project creation
// where setProjectFilter was called but the workspace root didn't change).
if (activeProjectFilter && activeProjectFilter !== '__unassigned__') {
    const filterRoot = currentWorkspaceRoot;
    const filterValue = filterRoot + '|' + activeProjectFilter;
    if ([...select.options].some(o => o.value === filterValue)) {
        select.value = filterValue;
        // Sync delete button state
        const delBtn = document.getElementById('btn-delete-project');
        if (delBtn) {
            const currentOption = select.selectedOptions?.[0];
            const hasProject = !!(currentOption?.dataset?.project) && currentOption.dataset.project !== '__unassigned__';
            delBtn.disabled = !hasProject;
            delBtn.setAttribute('data-tooltip', hasProject ? 'Delete selected project' : 'Select a project to delete');
        }
        return;
    }
}

// Priority 2: Try to restore saved selection (existing behavior)
if (savedValue && [...select.options].some(o => o.value === savedValue)) {
    select.value = savedValue;
} else {
    // Priority 3: Fall back to current workspace + active project filter (existing behavior)
    let fallbackRoot = activeWorkspaceFilter
        ? ((workspaceItems.find(item => getWorkspaceItemRepoScope(item) === activeWorkspaceFilter) || {}).workspaceRoot || currentWorkspaceRoot)
        : currentWorkspaceRoot;
    if (fallbackRoot && !workspaceItems.some(item => item.workspaceRoot === fallbackRoot)) {
        fallbackRoot = workspaceItems[0]?.workspaceRoot || '';
    }
    if (fallbackRoot) {
        const fallbackProject = activeProjectFilter ?? '';
        const fallbackValue = fallbackRoot + '|' + fallbackProject;
        if ([...select.options].some(o => o.value === fallbackValue)) {
            select.value = fallbackValue;
        } else {
            select.value = fallbackRoot + '|__unassigned__';
        }
    }
}

// Sync delete button state after dropdown rebuild (existing, unchanged)
const delBtn = document.getElementById('btn-delete-project');
if (delBtn) {
    const currentOption = select.selectedOptions?.[0];
    const hasProject = !!(currentOption?.dataset?.project) && currentOption.dataset.project !== '__unassigned__';
    delBtn.disabled = !hasProject;
    delBtn.setAttribute('data-tooltip', hasProject ? 'Delete selected project' : 'Select a project to delete');
}
```

**Why this works:** When a project is created, `setProjectFilter(projectName)` sets the backend filter, and the `updateWorkspaceSelection` message carries `projectFilter: projectName`. The handler syncs `activeProjectFilter = projectName` at line 6137. Now, when `updateWorkspaceProjectDropdown(null)` runs (explicitRoot is null because workspace didn't change), the new Priority 1 check finds the option `currentWorkspaceRoot + '|' + projectName` (which exists because the project was just added to `allWorkspaceProjects`) and selects it. The old `savedValue` restore (Priority 2) is skipped.

**Why workspace switching is unaffected:** Workspace switching passes `explicitRoot` (non-null), which takes the branch at line 4187 — the new Priority 1 code is below that branch and only runs when `explicitRoot` is null.

### 2. No backend changes needed

**File:** `src/services/KanbanProvider.ts` — NO CHANGES

The `updateWorkspaceSelection` message at lines 2345-2360 already includes `projectFilter: this._projectFilter ?? null` (line 2350). The `addProject` handler already calls `setProjectFilter(projectName)` at line 5485. The backend is correct; the fix is entirely in the frontend dropdown restoration logic.

### 3. No empty-state changes needed

The board rendering already shows "No plans" for empty projects (lines 5197-5198, 5222-5223). The board is not blank — it shows the correct empty state. The visible bug is the dropdown display not matching the backend filter, which fix #1 addresses.

## Verification Plan

1. **Create project from kanban:** Open kanban board → click "Create Project" → enter name → submit → verify the dropdown filter changes to the new project name and the board shows an empty state (not blank).
2. **Create project with existing plans visible:** Have plans in the unassigned/previous project → create a new project → verify the board switches to showing the new project's empty state, not the previous project's plans.
3. **Dropdown shows correct selection:** After project creation, verify the dropdown visually shows the new project name as selected.
4. **Create project in multi-workspace setup:** Switch to a different workspace → create a project → verify the dropdown selects the new project in the correct workspace.
5. **Project name with spaces:** Create a project named "My New Project" → verify the filter and dropdown handle the name correctly.
6. **Board still works after:** After creating the project, create a plan → verify it appears in the new project's board.
7. **Workspace switch regression:** Switch workspaces → verify the dropdown still selects the correct workspace's project (the explicitRoot branch at line 4187 is unaffected by the fix).
8. **Project deletion:** Delete a project → verify the dropdown updates correctly (the `deleteProject` handler also calls `_refreshBoard`, which sends `updateWorkspaceSelection` with the updated filter).

## Dependencies

- None — this plan is self-contained within `kanban.html`. No backend changes needed.

## Adversarial Synthesis

Key risks: original root cause was misdiagnosed (sync already works at line 6137); the real bug is the restoration logic prioritizing `savedValue` over `activeProjectFilter` at line 4207. The fix inserts a new priority check before `savedValue` restore, but must not break workspace switching (which uses the `explicitRoot` branch above). Mitigations: fix only modifies the non-explicit branch; `currentWorkspaceRoot` is the correct variable (not the non-existent `activeWorkspaceId`); empty state already exists so no board rendering changes needed.

## Recommendation

Complexity 5/10 → **Send to Coder**.
