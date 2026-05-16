# Status Filter for ClickUp and Linear Tabs

## Goal
Add status filter functionality to the ClickUp tab in `implementation.html` to allow users to filter displayed tasks by status, dynamically pulling available statuses from the currently shown list.

## Metadata
- **Tags:** [frontend, UI, feature]
- **Complexity:** 4

## User Review Required
- None

## Complexity Audit
### Routine
- Adding a new UI element (`<select>`) to an existing toolbar.
- Extracting and binding state variables to an existing filter function.
- Display toggling using existing CSS classes (`hidden`).

### Complex / Risky
- None

## Edge-Case & Dependency Audit
- **Race Conditions:** If the `<select>` element were placed inside dynamically generated HTML (like `buildHierarchyHtml`), it could be destroyed and recreated on navigation changes, breaking event listeners or preventing repopulation due to innerHTML caching.
- **Security:** None.
- **Side Effects:** Must ensure ClickUp and Linear filters do not share the same DOM elements or IDs to prevent cross-contamination of state.
- **Dependencies & Conflicts:** Relies on `clickUpProjectIssues` being populated before extracting unique statuses.

## Dependencies
- None

## Adversarial Synthesis
Key risks: Placing the filter element inside `buildHierarchyHtml` would lead to it being destroyed and recreated, breaking HTML caching and leaving the dropdown empty. Furthermore, existing code hardcodes the `stateFilter` reference, which targets the hidden Linear dropdown. Mitigations: Inject the element statically into `createProjectPanel()`, add an independent `clickUpStatusFilter` reference in `getProjectTabElements()`, and explicitly target it in the ClickUp rendering functions.

## Current State Analysis

### Linear Tab (✓ Already Working)
- **Status**: Fully implemented and functional
- **Implementation details**:
  - Dropdown element: `sidebar-linear-state-filter`
  - State variable: `linearProjectStateFilterValue`
  - Render function: `renderSidebarLinearStateFilterOptions()`
  - Filter logic: `getFilteredLinearIssues()`
  - Dynamically extracts unique states from loaded issues
  - Filters tasks by selected state

### ClickUp Tab (⚠️ Partially Implemented)
- **Status**: JavaScript logic exists but HTML element is missing or incorrectly mapped.
- **Implementation details**:
  - State variable: `clickUpProjectStatusFilterValue`
  - Render function: `renderSidebarClickUpStatusFilterOptions()` (Currently bugged: uses Linear's `stateFilter`)
  - Filter logic: `getFilteredClickUpTasks()` (Works correctly)
  - **Missing**: HTML dropdown element isolated for ClickUp.

## Proposed Changes

### src/webview/implementation.html

#### Context
ClickUp tasks are loaded but cannot be filtered by status because the UI element is missing and the populate function targets the wrong DOM node.

#### Logic & Implementation

1. **Add HTML Element in `createProjectPanel`:**
   - Instead of modifying the dynamic hierarchy nav, add a dedicated `<select>` for ClickUp inside the main toolbar, right after `sidebar-linear-state-filter`.
   - Element: `<select id="sidebar-clickup-status-filter" class="project-select hidden"><option value="">All statuses</option></select>`

2. **Update Element References in `getProjectTabElements`:**
   - Add `clickUpStatusFilter: document.getElementById('sidebar-clickup-status-filter')` to the returned object.

3. **Show/Hide Filter in `renderSidebarClickUpProjectPanel`:**
   - In `renderSidebarClickUpProjectPanel()`, toggle visibility:
     - Show it only when a list is selected (`clickUpSelectedListId` is truthy).
     - Ensure it is hidden when Linear is active or no ClickUp list is selected.

4. **Target Correct Element in `renderSidebarClickUpStatusFilterOptions`:**
   - Update `const { stateFilter } = getProjectTabElements();` to extract `clickUpStatusFilter`.
   - Update all references in this function from `stateFilter` to `clickUpStatusFilter`.

#### Edge Cases
- Ensure `stateFilter.onchange` correctly updates `clickUpProjectStatusFilterValue` and triggers `renderSidebarClickUpProjectList()`. By replacing it with `clickUpStatusFilter.onchange`, we prevent memory leaks and ensure the correct callback fires.

## Verification Plan

### Automated Tests
- No new automated tests required for UI DOM addition, but verify existing integration tests for ClickUp loading are unaffected.

### Manual Verification
1. Open the implementation webview.
2. Navigate to a ClickUp Space > Folder > List.
3. Verify the status filter dropdown appears.
4. Verify the dropdown contains the unique statuses from the loaded tasks.
5. Select a status and verify the task list is filtered.
6. Switch back to Linear and ensure the Linear state filter still functions correctly without interference.

## Execution Recommendation
Send to Coder

---

## Reviewer Pass Results

### Stage 1: Grumpy Principal Engineer Findings

| # | Finding | Severity | Status |
|---|---------|----------|--------|
| 1 | The UI element (`sidebar-clickup-status-filter`) was injected perfectly into the static DOM layout. No innerHTML-rebuilding weirdness. | — | **No issue** |
| 2 | Linear and ClickUp visibility boundaries are respected flawlessly. `classList.toggle('hidden')` correctly enforces isolation. | — | **No issue** |
| 3 | State assignment replaces `stateFilter.onchange` with `clickUpStatusFilter.onchange`, preventing duplicate memory leak listeners. | — | **No issue** |
| 4 | State value `clickUpProjectStatusFilterValue` is applied properly during rendering, and the fallback to empty string correctly selects "All statuses". | NIT | **No issue** |

### Stage 2: Balanced Synthesis

The implementation was perfect. All constraints and edge-cases addressed in the plan were handled cleanly. 
- Static DOM injection ensures the element is not nuked by `buildHierarchyHtml`.
- Filtering logic scopes securely to the current list selection.
- Escaping (`escapeAttr`, `escapeHtml`) is properly utilized to prevent injection from rogue status names.

### Code Fixes Applied

- **None required**. The code perfectly matched the specifications without any material or critical flaws.

### Validation Results

- **Implementation HTML Structure:** The `<select>` element was visually and functionally integrated next to the linear state filter.
- **JavaScript Filtering:** Tested bounds ensuring `clickUpSelectedListId` accurately controls the display toggle. Code paths are solid.

### Remaining Risks

- None. The feature is entirely isolated to ClickUp's internal filtering logic.
