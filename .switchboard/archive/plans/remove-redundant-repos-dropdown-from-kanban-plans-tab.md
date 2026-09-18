# Remove Redundant Repos Dropdown from Kanban Plans Tab

## Goal

Remove the repos dropdown (`#kanban-repo-filter`) from the kanban plans tab in `planning.html` and its associated JavaScript logic in `planning.js`, as it provides no functional value for most users and adds UI clutter.

## Metadata

- **Tags:** [frontend, UI, UX]
- **Complexity:** 2
- **Created:** 2026-05-26
- **Priority:** Medium
- **Type:** UI Cleanup
- **Status:** Implemented ✓

## User Review Required

- Confirm that removing the repos dropdown is acceptable even for multi-repo workspaces where `repoScope` metadata may occasionally be populated.
- Confirm that removing `repoScope` from the plan item metadata display (the `be · fe · ai` label under each plan) is desired, since `repoScope` will still be used internally by the backend for working directory resolution.

## Complexity Audit

### Routine
- Remove a `<select>` element from HTML (3 lines)
- Remove a `const` declaration in JS (1 line)
- Remove a property from a plain object (1 line)
- Remove a filtering `if` block from `renderKanbanPlans` (7 lines)
- Remove a population block from `populateKanbanFilters` (26 lines)
- Remove an event listener block (5 lines)
- Remove one line from metadata display assembly
- Update a guard clause to remove one condition

### Complex / Risky
- None

## Edge-Case & Dependency Audit

- **Race Conditions:** None. All changes are synchronous DOM operations that execute on page load or user interaction. No async coordination involved.
- **Security:** No impact. Removing a filter dropdown does not introduce or remove any security boundary.
- **Side Effects:** The `repoScope` field remains in the backend data model (KanbanProvider.ts, TaskViewerProvider.ts) and is used for working directory resolution during plan execution. The UI removal does not affect backend behavior. The `plan.repoScope` value is still sent in the `fetchKanbanPlans` message payload but will simply be ignored by the JS after this change.
- **Dependencies & Conflicts:** No CSS rules target `#kanban-repo-filter` (verified via grep), so no CSS cleanup is needed. No other JS files reference `kanbanRepoFilter` or `kanban-repo-filter`. The backend `repoScope` usage in KanbanProvider.ts (63 references) and TaskViewerProvider.ts (28 references) is entirely independent of the webview UI and must NOT be modified.

## Dependencies

None.

## Adversarial Synthesis

Key risks: (1) Users in multi-repo workspaces lose the ability to filter plans by repo sub-path, though this is mitigated by the fact that `repoScope` is rarely populated in practice. (2) Removing `repoScope` from the plan metadata display reduces visibility into a property the backend still uses. Mitigations: The workspace dropdown already provides sufficient scoping for typical workflows; the `repoScope` data model remains intact and can be re-exposed in the UI if demand emerges.

## Description

The repos dropdown in the kanban plans tab (`planning.html`) is redundant and provides no functional value for most users. The workspace dropdown already provides sufficient scoping for plan management, and the repo scope filtering is rarely used because:

1. **Most plans don't have repo scope metadata** - The `repoScope` field is extracted from plan metadata (`**Repo:**` field), but most plans don't include this, so the dropdown only shows "All Repos" and "(No Repo Scope)"
2. **Redundant filtering** - The workspace dropdown filters by `workspaceRoot` (full workspace path), which already scopes plans to a specific workspace. Repo-level filtering (relative paths like "be", "fe", "ai") is unnecessary for typical workflows
3. **User confusion** - The dropdown appears to do nothing because there are no actual repo options to filter by in most cases

## Proposed Changes

### `src/webview/planning.html`

- **Context:** The kanban controls strip contains filter dropdowns for column, workspace, project, repo, and a search input. The repo dropdown is between the project dropdown and the search input.
- **Logic:** Remove the `<select id="kanban-repo-filter">` element entirely.
- **Implementation:**
  - **Lines 1621-1623:** Remove the entire `<select id="kanban-repo-filter">` block:
    ```html
    <select id="kanban-repo-filter">
        <option value="">All Repos</option>
    </select>
    ```
- **Edge Cases:** None. No CSS rules target this element. Adjacent elements (project dropdown, search input) will reflow naturally.

### `src/webview/planning.js`

- **Context:** The kanban filter system uses a `kanbanFilters` object, element references, a `renderKanbanPlans` filter function, a `populateKanbanFilters` population function, and event listeners. The repo scope touches all of these.
- **Logic:** Remove all repo-scope-related code from the JS while preserving the rest of the filter system intact.
- **Implementation:**

  **2a. Remove `repoScope` from `kanbanFilters` object (line 2066):**
  ```javascript
  // BEFORE (lines 2062-2068):
  const kanbanFilters = {
      column: '',
      workspaceRoot: '',
      project: '',
      repoScope: '',    // REMOVE THIS LINE
      search: ''
  };

  // AFTER:
  const kanbanFilters = {
      column: '',
      workspaceRoot: '',
      project: '',
      search: ''
  };
  ```

  **2b. Remove `kanbanRepoFilter` element reference (line 2073):**
  ```javascript
  // REMOVE:
  const kanbanRepoFilter = document.getElementById('kanban-repo-filter');
  ```

  **2c. Remove repo scope filtering logic from `renderKanbanPlans` (lines 2100-2107):**
  ```javascript
  // REMOVE these lines:
  // Repo scope filter
  if (filters.repoScope) {
      if (filters.repoScope === '__none__') {
          if (plan.repoScope !== '') return false;
      } else if (plan.repoScope !== filters.repoScope) {
          return false;
      }
  }
  ```

  **2d. Remove `repoScope` from plan metadata display (line 2141):**
  ```javascript
  // REMOVE:
  if (plan.repoScope) metaParts.push(plan.repoScope);

  // Note: repoScope is still used by the backend (KanbanProvider, TaskViewerProvider)
  // for working directory resolution. It is intentionally removed from display only.
  ```

  **2e. Update guard clause in `populateKanbanFilters` (line 2218):**
  ```javascript
  // BEFORE:
  if (!kanbanWorkspaceFilter || !kanbanProjectFilter || !kanbanRepoFilter) return;

  // AFTER:
  if (!kanbanWorkspaceFilter || !kanbanProjectFilter) return;
  ```

  **2f. Remove repo scope population logic from `populateKanbanFilters` (lines 2266-2291):**
  ```javascript
  // REMOVE the entire "Repo filter" block:
  // Repo filter
  const uniqueRepos = new Set();
  let hasEmptyRepo = false;
  plans.forEach(p => {
      if (p.repoScope) {
          uniqueRepos.add(p.repoScope);
      } else {
          hasEmptyRepo = true;
      }
  });
  const currentRepo = kanbanFilters.repoScope;
  kanbanRepoFilter.innerHTML = '<option value="">All Repos</option>';
  if (hasEmptyRepo) {
      const optNone = document.createElement('option');
      optNone.value = '__none__';
      optNone.textContent = '(No Repo Scope)';
      if (currentRepo === '__none__') optNone.selected = true;
      kanbanRepoFilter.appendChild(optNone);
  }
  Array.from(uniqueRepos).sort().forEach(repo => {
      const opt = document.createElement('option');
      opt.value = repo;
      opt.textContent = repo;
      if (repo === currentRepo) opt.selected = true;
      kanbanRepoFilter.appendChild(opt);
  });
  ```

  **2g. Remove repo scope change event listener (lines 2388-2393):**
  ```javascript
  // REMOVE:
  if (kanbanRepoFilter) {
      kanbanRepoFilter.addEventListener('change', () => {
          kanbanFilters.repoScope = kanbanRepoFilter.value;
          renderKanbanPlans(_kanbanPlansCache, kanbanFilters);
      });
  }
  ```

- **Edge Cases:**
  - The `plan.repoScope` field is still present in the data objects received from the backend. After this change, it is simply ignored by the JS. No error will occur from receiving unused data.
  - Both `planning.html` and `planning.js` must be changed together as they are deployed as part of the same extension package. There is no risk of partial state.

## Verification Plan

### Automated Tests

- No automated tests are needed for this change. The modification is purely UI removal with no logic changes that affect testable behavior.

### Manual Verification

1. Open the kanban plans tab in the webview
2. Verify the repos dropdown is no longer visible in the controls strip
3. Verify workspace and project filters still work correctly (select a workspace, select a project, confirm plans are filtered)
4. Verify plan list rendering still works (plans appear, can be selected, preview loads)
5. Verify plan preview still works (click a plan, confirm markdown renders in the preview pane)
6. Verify the search input still works (type a search term, confirm plans are filtered)
7. Verify the column filter still works (select a column, confirm plans are filtered)

### Impact Assessment

- **Breaking changes:** None - this removes unused functionality
- **User impact:** Positive - reduces UI clutter and confusion
- **Code complexity:** Reduced - removes ~30 lines of unnecessary code
- **Performance:** Negligible - minor reduction in DOM operations

### Notes

- The `repoScope` field in the database and TypeScript interfaces should remain intact as it's used internally for control plane workflows and working directory resolution
- Only the UI filtering mechanism is being removed, not the underlying data model
- No CSS cleanup is required (verified: no CSS rules target `#kanban-repo-filter`)

## Recommendation

**Send to Intern** — Complexity 2. Single-purpose UI removal across two files with no architectural implications, no backend changes, and no edge cases beyond straightforward line deletion.

## Review Results (2026-05-26)

### Stage 1 — Grumpy Principal Engineer Findings

| # | Severity | Finding |
|---|----------|---------|
| 1 | NIT | Double blank line in `populateKanbanFilters` (lines 2255-2256) — leftover artifact from block removal |

No CRITICAL or MAJOR findings. All 7 plan requirements (2a–2g) plus the HTML removal were implemented correctly.

### Stage 2 — Balanced Synthesis

| Finding | Verdict | Action |
|---------|---------|--------|
| NIT: Double blank line | Valid — trivial style artifact | Fix now |

### Stage 3 — Code Fixes Applied

- **`src/webview/planning.js` line 2255:** Removed extra blank line in `populateKanbanFilters` closing section.

### Stage 4 — Verification Results

- **Grep check:** Zero remaining references to `repoScope`, `kanbanRepoFilter`, or `kanban-repo-filter` in `src/webview/planning.js` and `src/webview/planning.html`. PASS.
- **CSS check:** No CSS rules target `#kanban-repo-filter`. PASS.
- **Backend integrity:** `repoScope` still present in `PlanningPanelProvider.ts` (interface + payload), `KanbanProvider.ts` (63 refs), `TaskViewerProvider.ts` (28 refs). Untouched. PASS.
- **Compilation:** Skipped per session instructions.
- **Tests:** Skipped per session instructions.

### Files Changed (Review)

- `src/webview/planning.html` — Removed `<select id="kanban-repo-filter">` block (3 lines)
- `src/webview/planning.js` — Removed `repoScope` from `kanbanFilters`, removed `kanbanRepoFilter` element ref, removed repo scope filter logic from `renderKanbanPlans`, removed `repoScope` from metadata display, updated guard clause, removed repo filter population block, removed repo filter event listener, fixed double blank line (1 line)

### Remaining Risks

- None. The change is purely subtractive with no logic modifications. The backend `repoScope` data model is intact and can be re-exposed in the UI if future demand emerges.
