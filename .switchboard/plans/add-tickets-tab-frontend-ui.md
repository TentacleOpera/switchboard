# Add Tickets Tab — Phase 2: Frontend UI + Write Operations

## Metadata
- **Tags:** frontend, ui, feature
- **Complexity:** 5
- **Supersedes:** Part of `add-tickets-tab-to-planning-panel.md`
- **Depends On:** `add-tickets-tab-backend-wiring.md` (Phase 1)

## Goal
Add the "Tickets" tab to `planning.html` with full Linear/ClickUp rendering, event handling, state persistence, and write-operation delegation (import/refine). This phase provides the user-visible UI and depends on Phase 1's backend handlers being in place.

## Background & Problem Analysis
The ClickUp/Linear ticket UI in `implementation.html` is ~800 lines of inline JavaScript (state variables, rendering functions, event listeners, IPC calls). This must be ported to `planning.js` with adapted DOM IDs (`tickets-` prefix), CSS classes (planning-panel design system), and state variable names. Write operations (import, refine) cannot be duplicated — they are delegated to `TaskViewerProvider` via VS Code commands registered in Phase 1.

## User Review Required
- **Import result routing:** When a ticket is imported from the Planning panel, should the kanban board auto-refresh? Should the newly created plan be auto-selected in the Kanban Plans tab?
- **Ask Agent behavior:** ClickUp "Ask Agent" currently shows "not yet implemented" warning. Should the Planning panel version implement it (using `sendToAnalyst`), or mirror the same stub?
- **Provider toggle:** If both ClickUp and Linear are configured, should there be a visible toggle, or should the tab auto-select based on `integrationProviderPreference`?

## Complexity Audit

### Routine
- Tab button and content container HTML (follows existing pattern)
- CSS styling using existing variables
- Tab-switching logic (hook into existing `tabButtons.forEach`)
- State variable declarations
- IPC `postMessage` call wrappers

### Complex / Risky
- **~800 lines of rendering logic port** — must adapt DOM IDs, CSS classes, and state names while preserving all behavior. Risk of subtle differences in card layout, filter logic, or detail view structure.
- **State persistence** — must define exact keys and restoration flow for `vscode.getState()`/`vscode.setState()`. The `implementation.html` uses `initialState` message on load; `planning.js` must do the same.
- **Import/refine delegation** — must handle async command execution results (success/failure) and update UI accordingly (disable import button, show success/error toast).
- **ClickUp hierarchy navigation** — the Space→Folder→List cascade with "Change" buttons and auto-loading is the most complex UI component.

## Edge-Case & Dependency Audit
- **Both panels open:** DOM IDs are namespaced (`tickets-` prefix vs `sidebar-` prefix in `implementation.html`). No conflict.
- **Tab switch while loading:** If user switches away from Tickets tab while a load is in progress, the response message will arrive but the tab is hidden. Use a guard: only render if Tickets tab is active.
- **State restoration on reload:** `vscode.getState()` may contain stale data (e.g., issue list from a previous session). Must validate against current config before rendering.
- **Import duplicate detection:** Delegated to `TaskViewerProvider.importLinearTask()` which already checks for existing plans. The Planning panel must handle the `{ success: false, error }` response gracefully.

## Dependencies
- `add-tickets-tab-backend-wiring.md` — All read IPC handlers must be implemented and returning correct response shapes
- `switchboard.importLinearTask`, `switchboard.importClickUpTask`, `switchboard.refineTask` commands must be registered in `extension.ts`

## Adversarial Synthesis
The main risk is a subtle behavioral divergence between the ported UI and the original. Mitigation: port rendering functions as close to verbatim as possible, only changing DOM IDs and CSS class names. Do NOT attempt to "improve" or refactor the rendering logic during porting — that can happen in a follow-up. The second risk is import/refine command results not being surfaced to the user — must wire the `then()` / `catch()` paths to update the import button state and show success/error messages.

## Proposed Changes

### 1. Add Tickets tab button to `planning.html`
**File:** `src/webview/planning.html` (tab bar section, ~line 2290)

Add after the last existing tab button:
```html
<button class="research-tab-btn" data-tab="tickets">TICKETS</button>
```

### 2. Add `#tickets-content` container to `planning.html`
**File:** `src/webview/planning.html` (after last `research-tab-content` div, ~line 2540)

Full DOM shell:
```html
<div id="tickets-content" class="research-tab-content">
  <div class="tickets-panel">
    <div class="tickets-toolbar">
      <input id="tickets-search" type="text" placeholder="Search tickets..." />
      <select id="tickets-project-picker" style="display:none"></select>
      <select id="tickets-state-filter" style="display:none"></select>
      <select id="tickets-status-filter" style="display:none"></select>
      <button id="tickets-refresh" class="planning-button">Refresh</button>
      <div id="tickets-hierarchy-nav" style="display:none"></div>
    </div>
    <div class="tickets-list-view">
      <div id="tickets-empty-state">No tickets loaded.</div>
      <div id="tickets-issues-container"></div>
      <button id="tickets-load-more" class="planning-button" style="display:none">Load More</button>
    </div>
    <div class="tickets-task-view" style="display:none">
      <div class="tickets-back-btn-group">
        <button id="tickets-back-to-list" class="planning-button">BACK TO LIST</button>
        <button id="tickets-back-to-parent" class="planning-button" style="display:none">BACK TO PARENT</button>
      </div>
      <div class="tickets-task-header">
        <h3 id="tickets-detail-title"></h3>
        <span id="tickets-detail-status"></span>
        <span id="tickets-detail-assignee"></span>
      </div>
      <div class="tickets-detail-actions">
        <button id="tickets-detail-import" class="planning-button">Import</button>
        <button id="tickets-detail-refine" class="planning-button">Refine</button>
        <button id="tickets-detail-ask-agent" class="planning-button">Ask Agent</button>
      </div>
      <div id="tickets-detail-description"></div>
      <div id="tickets-detail-subtasks"></div>
      <div id="tickets-detail-comments"></div>
      <div id="tickets-detail-attachments"></div>
    </div>
  </div>
</div>
```

### 3. Add scoped CSS in `planning.html`
**File:** `src/webview/planning.html` (inside existing `<style>` block)

Styles for ticket cards, hierarchy nav, detail view, loading spinners — using existing planning-panel CSS variables (`--planning-bg`, `--planning-text`, `--planning-accent`, etc.). Adapt from `implementation.html` styles but use planning-panel class conventions (`planning-card`, `planning-button`, `planning-select`).

### 4. Add tab-switching logic in `planning.js`
**File:** `src/webview/planning.js` (inside existing tab button event listener, ~line 120)

The existing loop `document.querySelectorAll('.research-tab-btn').forEach(btn => { btn.addEventListener('click', ...) })` will automatically pick up the new `data-tab="tickets"` button. Add a guard in the tab-switch handler:

```javascript
if (tabName === 'tickets') {
    if (!ticketsInitialized) {
        initTicketsTab();
        ticketsInitialized = true;
    }
    // Trigger initial load if not yet loaded
    if (lastIntegrationProvider && !ticketsLoadedOnce) {
        if (lastIntegrationProvider === 'clickup') loadClickUpSpaces();
        else loadLinearProject();
    }
}
```

### 5. Declare state variables in `planning.js`
**File:** `src/webview/planning.js` (top of IIFE, with other state vars)

```javascript
// Tickets tab state
let ticketsInitialized = false;
let ticketsLoadedOnce = false;
let lastIntegrationProvider = null;

// Linear state
let linearProjectIssues = [];
let selectedLinearIssue = null;
let linearProjectStatus = 'idle';
let linearProjectMessage = '';
let linearProjectSearchValue = '';
let linearProjectStateFilterValue = '';
let linearProjectPickerValue = '';
let _restoredLinearProjectPickerValue = '';
let linearAvailableProjects = [];
let linearProjectLoadedOnce = false;
let linearProjectLoading = false;
let linearTaskDetailsTimeoutId = null;

// ClickUp state
let clickUpProjectIssues = [];
let selectedClickUpIssue = null;
let clickUpProjectStatus = 'idle';
let clickUpProjectMessage = '';
let clickUpAvailableSpaces = [];
let clickUpAvailableFolders = [];
let clickUpAvailableListsInFolder = [];
let clickUpAvailableDirectLists = [];
let clickUpSelectedSpaceId = '';
let clickUpSelectedFolderId = '';
let clickUpSelectedListId = '';
let clickUpProjectSearchValue = '';
let clickUpProjectStatusFilterValue = '';
let clickUpCurrentPage = 0;
let clickUpProjectHasMore = false;
let clickUpSpacesLoadedOnce = false;
let clickUpHierarchyLoading = false;
let clickUpImportPending = false;
let pendingClickUpDetailIssueId = '';
```

### 6. Implement rendering functions in `planning.js`
**File:** `src/webview/planning.js` (new section after existing rendering code)

Port from `implementation.html` with these adaptations:
- Replace `sidebar-*` DOM IDs with `tickets-*` IDs
- Replace `agent-list-project` container with `tickets-issues-container`
- Replace `implementation.html` CSS classes with planning-panel equivalents
- Use `planning-card` class for ticket cards instead of `sidebar-card`
- Guard renders: only update DOM if Tickets tab is active

Key functions to port:
- `renderTicketsTab()` — master dispatcher (calls Linear or ClickUp render based on `lastIntegrationProvider`)
- `renderLinearList()` — issue card grid with search/filter
- `renderLinearTaskDetail()` — detail view with subtasks, comments, attachments
- `renderClickUpList()` — task card grid with status filter and load-more
- `renderClickUpTaskDetail()` — detail view mirroring Linear
- `renderClickUpHierarchyNav()` — Space/Folder/List breadcrumb selects
- `renderLinearStateFilterOptions()` / `renderClickUpStatusFilterOptions()`
- `renderLinearProjectPickerOptions()`
- `updateIntegrationTabLabel(provider)` — update tab button text to show active provider

### 7. Implement load functions in `planning.js`
**File:** `src/webview/planning.js`

Port from `implementation.html`:
- `loadLinearProject(forceRefresh?)` — posts `linearLoadProject`
- `loadLinearTaskDetails(issueId)` — posts `linearLoadTaskDetails`
- `loadClickUpSpaces(forceRefresh?)` — posts `clickupLoadSpaces`
- `loadClickUpFolders(spaceId)` — posts `clickupLoadFolders`
- `loadClickUpLists(spaceId, folderId?)` — posts `clickupLoadLists`
- `loadClickUpProject(forceRefresh?)` — posts `clickupLoadProject`
- `loadMoreClickUpTasks()` — posts `clickupLoadProject` with page+1
- `loadClickUpTaskDetails(taskId)` — posts `clickupLoadTaskDetails`

### 8. Wire up event listeners in `initTicketsTab()`
**File:** `src/webview/planning.js`

```javascript
function initTicketsTab() {
    // Search input
    document.getElementById('tickets-search')?.addEventListener('input', debounce(...));
    // Project picker (Linear)
    document.getElementById('tickets-project-picker')?.addEventListener('change', ...);
    // State filter (Linear)
    document.getElementById('tickets-state-filter')?.addEventListener('change', ...);
    // Status filter (ClickUp)
    document.getElementById('tickets-status-filter')?.addEventListener('change', ...);
    // Refresh
    document.getElementById('tickets-refresh')?.addEventListener('click', ...);
    // Load more (ClickUp pagination)
    document.getElementById('tickets-load-more')?.addEventListener('click', loadMoreClickUpTasks);
    // Back buttons
    document.getElementById('tickets-back-to-list')?.addEventListener('click', ...);
    document.getElementById('tickets-back-to-parent')?.addEventListener('click', ...);
    // Detail action buttons (delegated event handling on container)
    document.querySelector('.tickets-task-view')?.addEventListener('click', handleTicketsDetailClick);
    // Issue card clicks (delegated on issues container)
    document.getElementById('tickets-issues-container')?.addEventListener('click', handleTicketsIssueClick);
}
```

### 9. Handle IPC response messages in `planning.js`
**File:** `src/webview/planning.js` (inside existing `window.addEventListener('message', ...)` handler)

Add cases for all response message types from Phase 1:
- `linearProjectLoaded` → update `linearProjectIssues`, call `renderLinearList()`
- `linearProjectsLoaded` → update `linearAvailableProjects`, call `renderLinearProjectPickerOptions()`
- `linearTaskDetailsLoaded` → update `selectedLinearIssue`, call `renderLinearTaskDetail()`
- `clickupSpacesLoaded` → update `clickUpAvailableSpaces`, call `renderClickUpHierarchyNav()`
- `clickupFoldersLoaded` → update folders/directLists, call `renderClickUpHierarchyNav()`
- `clickupListsLoaded` → update lists, call `renderClickUpHierarchyNav()`
- `clickupProjectLoaded` → update `clickUpProjectIssues`, `clickUpProjectHasMore`, call `renderClickUpList()`
- `clickupTaskDetailsLoaded` → update `selectedClickUpIssue`, call `renderClickUpTaskDetail()`
- `integrationProviderPreference` → update `lastIntegrationProvider`, trigger initial load
- `linearTaskImported` / `clickupTaskImported` → re-enable import button, show success/error

### 10. Implement import/refine delegation
**File:** `src/webview/planning.js`

Import and refine operations are delegated to `TaskViewerProvider` via VS Code commands registered in Phase 1:

```javascript
// Import handler
function handleTicketsImport(provider, id, includeSubtasks) {
    const workspaceRoot = currentWorkspaceRoot; // from existing state
    vscode.postMessage({
        type: provider === 'clickup' ? 'clickupImportTask' : 'linearImportTask',
        workspaceRoot,
        [provider === 'clickup' ? 'taskId' : 'issueId']: id,
        includeSubtasks
    });
}

// Refine handler
function handleTicketsRefine(provider, id, title, description) {
    const workspaceRoot = currentWorkspaceRoot;
    vscode.postMessage({
        type: provider === 'clickup' ? 'clickupRefineTask' : 'linearRefineTask',
        workspaceRoot,
        [provider === 'clickup' ? 'taskId' : 'issueId']: id,
        title,
        description
    });
}
```

**Backend side** (in `PlanningPanelProvider.ts`, added in Phase 1):
```typescript
case 'linearImportTask': {
    const result = await vscode.commands.executeCommand(
        'switchboard.importLinearTask', workspaceRoot, data.issueId, data.includeSubtasks !== false
    );
    this._panel?.webview.postMessage({ type: 'linearTaskImported', ...result });
    break;
}
case 'clickupImportTask': {
    const result = await vscode.commands.executeCommand(
        'switchboard.importClickUpTask', workspaceRoot, data.taskId, data.includeSubtasks !== false
    );
    this._panel?.webview.postMessage({ type: 'clickupTaskImported', ...result });
    break;
}
case 'linearRefineTask':
case 'clickupRefineTask': {
    await vscode.commands.executeCommand('switchboard.refineTask', workspaceRoot, {
        id: data.issueId || data.taskId,
        title: data.title,
        description: data.description,
        provider: msg.type === 'clickupRefineTask' ? 'clickup' : 'linear'
    });
    break;
}
```

**Command registration** (in `extension.ts`):
```typescript
const importLinearTaskCmd = vscode.commands.registerCommand(
    'switchboard.importLinearTask',
    async (workspaceRoot: string, issueId: string, includeSubtasks: boolean) => {
        return await taskViewerProvider.importLinearTask(workspaceRoot, issueId, includeSubtasks);
    }
);
const importClickUpTaskCmd = vscode.commands.registerCommand(
    'switchboard.importClickUpTask',
    async (workspaceRoot: string, taskId: string, includeSubtasks: boolean) => {
        return await taskViewerProvider.importClickUpTask(workspaceRoot, taskId, includeSubtasks);
    }
);
const refineTaskCmd = vscode.commands.registerCommand(
    'switchboard.refineTask',
    async (workspaceRoot: string, data: { id: string; title: string; description: string; provider: 'linear' | 'clickup' }) => {
        return await taskViewerProvider.refineTask(workspaceRoot, data);
    }
);
context.subscriptions.push(importLinearTaskCmd, importClickUpTaskCmd, refineTaskCmd);
```

### 11. Implement state persistence
**File:** `src/webview/planning.js`

**Persist keys** (on tab switch away or before reload):
```javascript
function saveTicketsState() {
    vscode.setState({
        ...vscode.getState(),
        tickets: {
            lastIntegrationProvider,
            linearProjectSearchValue,
            linearProjectStateFilterValue,
            linearProjectPickerValue,
            clickUpSelectedSpaceId,
            clickUpSelectedFolderId,
            clickUpSelectedListId,
            clickUpProjectSearchValue,
            clickUpProjectStatusFilterValue
        }
    });
}
```

**Restore** (on tab activation or panel reload):
```javascript
function restoreTicketsState() {
    const state = vscode.getState()?.tickets;
    if (!state) return;
    lastIntegrationProvider = state.lastIntegrationProvider || null;
    linearProjectSearchValue = state.linearProjectSearchValue || '';
    // ... etc
}
```

**On initial load** (inside `window.addEventListener('message', ...)` for `integrationProviderPreference`):
- Restore persisted state
- If provider is known, trigger initial data load cascade

### 12. Verify webpack build
**File:** `webpack.config.js`

No changes needed — `planning.js` is already an entry point. The added code will be included automatically as long as it's in the existing source file.

## Files to Change

| File | Change Type | Lines (approx) | Description |
|------|-------------|----------------|-------------|
| `src/webview/planning.html` | Add | +150 | Tab button, content container, scoped CSS |
| `src/webview/planning.js` | Add | +900 | State vars, rendering, events, IPC, persistence |
| `src/services/PlanningPanelProvider.ts` | Add | +30 | Import/refine command delegation handlers |
| `src/extension.ts` | Add | +15 | Command registrations for import/refine |

## Files to Leave Unchanged

| File | Reason |
|------|--------|
| `src/webview/implementation.html` | Old Projects tab must remain functional |
| `src/services/TaskViewerProvider.ts` | Existing handler logic must not be touched |
| `src/services/LinearSyncService.ts` | Underlying service unchanged |
| `src/services/ClickUpSyncService.ts` | Underlying service unchanged |

## Acceptance Criteria
- [ ] A "Tickets" tab is visible in `planning.html` and switches correctly
- [ ] When Linear is configured, the tab loads issues, shows cards, supports search/state filter/project picker, and shows detail view with subtasks/comments/attachments
- [ ] When ClickUp is configured, the tab shows Space/Folder/List hierarchy, loads tasks, supports search/status filter, and shows detail view with pagination
- [ ] Import button works for both providers — delegates to `TaskViewerProvider` via command, creates plan files, shows success/error feedback
- [ ] Refine button works for both providers — delegates to `TaskViewerProvider` via command
- [ ] Ask Agent button works (or shows appropriate stub message)
- [ ] Back navigation (Back to List, Back to Parent) works correctly
- [ ] Refresh button reloads the current project/list
- [ ] Load More pagination works for ClickUp
- [ ] State (search, filters, selected task, hierarchy) persists across tab switches and panel reloads
- [ ] The old Projects sub-tab in `implementation.html` continues to work without any change in behavior
- [ ] Extension builds successfully

## Verification Plan
- Build: `npm run compile` (or `npm run build`)
- Manual testing in VS Code:
  - Test Linear: load project, filter, search, view details, import, refine
  - Test ClickUp: navigate hierarchy, load list, filter, search, view details, import, refine, load more
  - Test state persistence: switch tabs, reload panel, verify filters/search/hierarchy restored
  - Test regression: open Implementation panel, verify Projects sub-tab still works
- Edge cases: both panels open simultaneously, tab switch during load, import duplicate detection

## Follow-Up Work (Out of Scope)
- Remove the Projects sub-tab from `implementation.html`
- Extract shared ClickUp/Linear handler logic into a single `TicketIntegrationService`
- Add a provider selector toggle UI if both ClickUp and Linear are configured
- Implement ClickUp "Ask Agent" (currently stubbed)
