# Remove ClickUp/Linear Projects Sub-Tab from implementation.html

## Goal

Remove the "Projects" sub-tab (ClickUp/Linear integration) from `src/webview/implementation.html` since ticket browsing has moved entirely to `planning.html`. The tab and all associated dead code are no longer needed and only consume UI space.

## Metadata

**Complexity:** 3
**Tags:** frontend, ui, refactor

## User Review Required

- None. This is isolated dead-code removal with no product-scope change.

## Complexity Audit

### Routine
- Remove isolated HTML, CSS, and JavaScript from a single webview file.
- No shared state with `planning.html`.
- No new architectural patterns introduced.

### Complex / Risky
- None

## Edge-Case & Dependency Audit

- **Race Conditions:** None. Static removal; no runtime state transitions.
- **Security:** None. Removing surface area reduces exposure.
- **Side Effects:** `TaskViewerProvider.ts` persists `activeSubTab` including `'project'`. Must prune `'project'` from provider-side `validSubTabs` or persisted state may restore a non-existent tab.
- **Dependencies & Conflicts:**
  - `src/services/TaskViewerProvider.ts` line ~8556 references `validSubTabs = ['agents', 'terminals', 'project']` and must be updated.
  - `src/test/kanban-linear-project-tab-regression.test.js` asserts the existence of the project tab and must be updated to assert absence (or removed).
  - `planning.html` and `planning.js` continue to use the same message types (`linearLoadProject`, `clickupLoadProject`, etc.); provider handlers must NOT be deleted.

## Dependencies

- None blocking. This plan is self-contained.

## Adversarial Synthesis

Key risks: stale `validSubTabs` in `TaskViewerProvider.ts` could cause persisted `'project'` subtab to activate a missing DOM container, and the existing regression test will fail because it asserts the tab's presence. Mitigations: update provider validation array and rewrite test assertions to verify removal instead of existence.

## Proposed Changes

### `src/webview/implementation.html`
- **Context:** The file contains a sub-tab bar inside the Agents panel with tabs **Agents**, **Terminals**, and **Projects**. The **Projects** tab renders ClickUp/Linear task browsing UI via a dynamically created project panel. All associated code is fully isolated — no JavaScript functions, CSS, or DOM elements are shared with `planning.html`.
- **Logic:** Remove the tab button and container, then delete all dead references (variables, functions, event listeners, CSS).
- **Implementation:**
  - **HTML (structure)** approx lines 1938, 1955:
    - Remove `<button id="integration-tab-btn" class="sub-tab-btn" data-tab="project">Projects</button>` from the sub-tab bar.
    - Remove `<div id="agent-list-project" class="agent-list hidden"></div>` tab content container.
  - **JavaScript (dead code removal)** approx lines 1993–5265:
    - Remove `agentListProject` DOM reference (approx 1993).
    - Remove `currentAgentTab` tracking for `'project'` value (approx 3424).
    - Remove `switchAgentTab` mapping for `project: agentListProject` (approx 3429).
    - Remove `'project'` from `validSubTabs` array (approx 2597).
    - Remove all ClickUp/Linear project state variables (approx 2011–2062):
      - `linearProjectIssues`, `selectedLinearIssue`, `linearProjectLoadedOnce`, `linearProjectLoading`, `linearProjectStatus`, `linearProjectMessage`, `linearProjectScopeLabel`, `pendingLinearDetailIssueId`, `loadingLinearCardId`, `linearImportPending`, `linearProjectSearchValue`, `linearProjectStateFilterValue`, `linearTaskDetailsTimeoutId`, `linearProjectPickerValue`, `_restoredLinearProjectPickerValue`, `linearAvailableProjects`
      - `clickUpProjectIssues`, `selectedClickUpIssue`, `clickUpProjectStatus`, `clickUpProjectMessage`, `clickUpProjectLoadedOnce`, `clickUpProjectLoading`, `clickUpSpacesLoadedOnce`, `clickUpLoadSeq`, `clickUpProjectScopeLabel`, `clickUpAvailableSpaces`, `clickUpAvailableFolders`, `clickUpAvailableListsInFolder`, `clickUpAvailableDirectLists`, `clickUpSelectedSpaceId`, `clickUpSelectedFolderId`, `clickUpSelectedListId`, `clickUpHierarchyLoading`, `_hierarchyRestorePending`, `pendingClickUpDetailIssueId`, `loadingClickUpCardId`, `clickUpImportPending`, `clickUpProjectSearchValue`, `clickUpProjectStatusFilterValue`, `clickUpTaskDetailsTimeoutId`, `clickUpCurrentPage`, `clickUpProjectHasMore`, `clickUpProjectIsLoadingMore`
    - Remove cached HTML string variables (approx 2073–2079):
      - `_lastClickUpHierarchyHtml`, `_lastClickUpIssuesContainerHtml`, `_lastClickUpDetailDescriptionHtml`, `_lastClickUpDetailSubtasksHtml`, `_lastClickUpDetailCommentsHtml`, `_lastClickUpDetailAttachmentsHtml`, `_lastClickUpStateFilterHtml`
    - Remove `updateIntegrationTabLabel(provider)` function (approx 3486).
    - Remove `getProjectTabElements()` function (approx 3497).
    - Remove `createProjectPanel()` function (approx 4521).
    - Remove `renderSidebarLinearProjectPanel()` function (approx 3801).
    - Remove `renderSidebarClickUpProjectPanel()` function (approx 3969).
    - Remove `renderSidebarLinearTaskDetail()` function (approx 3672).
    - Remove `renderSidebarClickUpTaskDetail()` function (approx 4316).
    - Remove `renderSidebarLinearProjectPickerOptions()` function (approx 3550).
    - Remove `renderSidebarLinearStateFilterOptions()` function (approx 3525).
    - Remove `renderSidebarLinearProjectList()` function (approx 3603).
    - Remove `renderSidebarClickUpProjectList()` function (approx 4257).
    - Remove `renderSidebarClickUpHierarchyNav()` function (approx 4035).
    - Remove `renderSidebarClickUpStatusFilterOptions()` function (approx 4232).
    - Remove `buildHierarchyHtml()` helper (if exclusively used by removed ClickUp hierarchy nav).
    - Remove `buildLinearAskAgentText()` helper (approx 4487).
    - Remove `loadLinearProject()`, `loadLinearTaskDetails()`, `loadClickUpProject()`, `loadMoreClickUpTasks()`, `loadClickUpTaskDetails()`, `loadClickUpSpaces()` functions (approx 3839–3967).
    - Remove all message handlers for:
      - `linearProjectLoaded` (approx 2737), `linearProjectsLoaded` (approx 2749), `linearTaskDetailsLoaded` (approx 2771), `linearTaskImported` (approx 2826), `linearTaskImportedToPlanner` (approx 2875), `linearError` (approx 2892)
      - `clickupProjectLoaded` (approx 2909), `clickupSpacesLoaded` (approx 2928), `clickupFoldersLoaded` (approx 2950), `clickupListsLoaded` (approx 2999), `clickupTaskDetailsLoaded` (approx 3029), `clickupError` (approx 3070), `clickupTaskImported` (approx 2843)
    - Remove `renderAgentList` logic branches that create and populate the project panel (approx 5095–5126, 5149–5155, 5251–5261).
    - Remove any `postMessage` calls exclusively related to the removed project UI (`linearLoadProject`, `linearLoadTaskDetails`, `clickupLoadProject`, `clickupLoadSpaces`, `clickupLoadTaskDetails`, `linearImportTask`, `clickupImportTask`, `copyTextToClipboard` inside project panel, `openSetupPanel` with `section: 'project-mgmt'` inside project panel, etc.).
  - **CSS (dead style removal)** approx lines 374–665+:
    - Remove `.project-panel` styles.
    - Remove `.project-detail-item`, `.project-detail-item-title`, `.project-detail-item-status` styles.
    - Remove `.project-issue-card` and `.project-card` styles.
    - Remove `.project-card-header`, `.project-card-title`, `.project-card-status`, `.project-card-meta`, `.project-card-id`, `.project-card-assignees` styles.
    - Remove `linearCardSpinner` animation and `.loading` styles.
    - Remove ClickUp-specific `.hierarchy-nav-container` styles.
    - Remove any other CSS selectors only used by the project panel (e.g., `.project-toolbar`, `.project-view-shell`).
- **Edge Cases:**
  - Ensure no dangling references to `agentListProject` remain in `renderAgentList` onboarding guard.
  - Ensure `switchAgentTab('terminals')` and `switchAgentTab('agents')` still work after removing the `project` key from the `tabs` map.
  - Ensure `validSubTabs` in `TaskViewerProvider.ts` is updated so persisted state does not select `'project'`.

### `src/services/TaskViewerProvider.ts`
- **Context:** The provider validates and persists the active sub-tab for the sidebar webview.
- **Logic:** Remove `'project'` from the `validSubTabs` array so persisted workspace state cannot restore a removed tab.
- **Implementation:** Approx line 8556, change `const validSubTabs = ['agents', 'terminals', 'project'];` to `const validSubTabs = ['agents', 'terminals'];`.

### `src/test/kanban-linear-project-tab-regression.test.js`
- **Context:** Regression test asserts the presence of the project tab in `implementation.html`.
- **Logic:** Update assertions to verify the tab and its associated DOM IDs, functions, and message types are *absent* from `implementation.html` (or remove the file if it no longer serves a purpose).
- **Implementation:** Rewrite test expectations. Example: assert no `id="integration-tab-btn"`, no `agentListProject`, no `data-tab="project"`.

## Background

- `implementation.html` contains a sub-tab bar inside the Agents panel with three tabs: **Agents**, **Terminals**, and **Projects**.
- The **Projects** tab renders ClickUp/Linear task browsing UI via a dynamically created project panel.
- `planning.html` now has its own independent tickets tab (`#tickets-content`, `#tree-pane-tickets`, `#preview-pane-tickets`, `#markdown-preview-tickets`) with self-contained CSS and no references to ClickUp or Linear.
- The ClickUp/Linear code in `implementation.html` is fully isolated — no JavaScript functions, CSS, or DOM elements are shared with `planning.html`.

## Scope of Changes

### HTML (structure)
- Remove `<button id="integration-tab-btn" class="sub-tab-btn" data-tab="project">Projects</button>` from the sub-tab bar.
- Remove `<div id="agent-list-project" class="agent-list hidden"></div>` tab content container.

### JavaScript (dead code removal)
- Remove `agentListProject` DOM reference.
- Remove `currentAgentTab` tracking for `'project'` value.
- Remove `switchAgentTab` mapping for `project: agentListProject`.
- Remove `'project'` from `validSubTabs` array.
- Remove all ClickUp/Linear project state variables (~40 variables), including:
  - `linearProjectIssues`, `selectedLinearIssue`, `linearProjectLoading`, `linearProjectStatus`, `linearProjectMessage`, `linearProjectScopeLabel`, `pendingLinearDetailIssueId`, `loadingLinearCardId`, `linearImportPending`, `linearProjectSearchValue`, `linearProjectStateFilterValue`, `linearTaskDetailsTimeoutId`, `linearProjectPickerValue`, `_restoredLinearProjectPickerValue`, `linearAvailableProjects`
  - `clickUpProjectIssues`, `selectedClickUpIssue`, `clickUpProjectStatus`, `clickUpProjectMessage`, `clickUpProjectLoadedOnce`, `clickUpProjectLoading`, `clickUpSpacesLoadedOnce`, `clickUpLoadSeq`, `clickUpProjectScopeLabel`, `clickUpAvailableSpaces`, `clickUpAvailableFolders`, `clickUpAvailableListsInFolder`, `clickUpAvailableDirectLists`, `clickUpSelectedSpaceId`, `clickUpSelectedFolderId`, `clickUpSelectedListId`, `clickUpHierarchyLoading`, `_hierarchyRestorePending`, `pendingClickUpDetailIssueId`, `loadingClickUpCardId`, `clickUpImportPending`, `clickUpProjectSearchValue`, `clickUpProjectStatusFilterValue`, `clickUpTaskDetailsTimeoutId`, `clickUpCurrentPage`, `clickUpProjectHasMore`, `clickUpProjectIsLoadingMore`
- Remove cached HTML string variables for ClickUp/Linear:
  - `_lastClickUpHierarchyHtml`, `_lastClickUpIssuesContainerHtml`, `_lastClickUpDetailDescriptionHtml`, `_lastClickUpDetailSubtasksHtml`, `_lastClickUpDetailCommentsHtml`, `_lastClickUpDetailAttachmentsHtml`, `_lastClickUpStateFilterHtml`
- Remove `updateIntegrationTabLabel()` function.
- Remove `getProjectTabElements()` function.
- Remove `createProjectPanel()` function.
- Remove `renderSidebarLinearProjectPanel()` function.
- Remove `renderSidebarClickUpProjectPanel()` function.
- Remove all Linear/ClickUp detail rendering functions (e.g., `renderSidebarLinearTaskDetail`, `renderSidebarClickUpTaskDetail`, and any helpers such as `buildLinearAskAgentText`).
- Remove all helper functions exclusive to the removed panels (e.g., `renderSidebarLinearProjectPickerOptions`, `renderSidebarLinearStateFilterOptions`, `renderSidebarLinearProjectList`, `renderSidebarClickUpProjectList`, `renderSidebarClickUpHierarchyNav`, `renderSidebarClickUpStatusFilterOptions`, `buildHierarchyHtml`).
- Remove all message handlers for:
  - `linearProjectLoaded`, `linearProjectsLoaded`, `linearTaskDetailsLoaded`, `linearTaskImported`, `linearTaskImportedToPlanner`, `linearError`
  - `clickupProjectLoaded`, `clickupSpacesLoaded`, `clickupFoldersLoaded`, `clickupListsLoaded`, `clickupTaskDetailsLoaded`, `clickupError`, `clickupTaskImported`
- Remove `renderAgentList` logic branches that create and populate the project panel.
- Remove any `postMessage` calls related to project/ClickUp/Linear loading from `implementation.html`.

### CSS (dead style removal)
- Remove `.project-panel` styles.
- Remove `.project-detail-item`, `.project-detail-item-title`, `.project-detail-item-status` styles.
- Remove `.project-issue-card` and `.project-card` styles.
- Remove `.project-card-header`, `.project-card-title`, `.project-card-status`, `.project-card-meta`, `.project-card-id`, `.project-card-assignees` styles.
- Remove `linearCardSpinner` animation and `.loading` styles.
- Remove ClickUp-specific `.hierarchy-nav-container` styles.
- Remove any other CSS selectors only used by the project panel (e.g., `.project-toolbar`, `.project-view-shell`).

## Files Changed

- `src/webview/implementation.html`
- `src/services/TaskViewerProvider.ts` (provider-side tab validation)
- `src/test/kanban-linear-project-tab-regression.test.js` (test update)

## Risks

- Minimal. The code is fully isolated; `planning.html` does not share any of these functions, variables, or CSS selectors.
- **Caveat:** `TaskViewerProvider.ts` must drop `'project'` from `validSubTabs` or persisted state may try to restore a missing tab.
- **Caveat:** The regression test `kanban-linear-project-tab-regression.test.js` will fail unless updated to assert absence of the project tab.
- Verify no other callers in `implementation.html` reference removed variables/functions before finalizing.

## Verification Plan

### Automated Tests
- **Skipped per session directive.** The test suite will be run separately by the user.

### Manual Verification
1. Open the Switchboard sidebar in VS Code.
2. Confirm the Agents panel sub-tab bar shows only **Agents** and **Terminals** (no **Projects**).
3. Click between Agents and Terminals; switching must remain smooth.
4. Open `planning.html` and verify the **Tickets** tab still loads ClickUp/Linear tasks correctly (provider handlers untouched).
5. Reload the window and confirm the sidebar does not attempt to restore the missing Projects sub-tab.

## Recommendation

Send to Intern

## Review Findings

- **Files changed:** `src/webview/implementation.html`, `src/services/TaskViewerProvider.ts`, `src/test/kanban-linear-project-tab-regression.test.js`
- **Validation:** Grepped for all ~40 removed state variables, functions, CSS selectors, and message handlers — zero references remain in `implementation.html`. Only unrelated `linear-gradient` CSS values survive. `TaskViewerProvider.ts` correctly uses `validSubTabs = ['agents', 'terminals']`. Regression test rewritten to assert absence of project tab artifacts.
- **Remaining risks:** None material. The `isAutobanPanelInteracting && currentAgentTab === 'autoban'` guard in `renderAgentList` references a tab value not in `validSubTabs`, but this is pre-existing and unrelated to this change.
