# Plan: Make ClickUp/Linear Sidebar State Sticky

## Goal
Persist ClickUp space/folder/list and Linear project-picker selections across sidebar reopenings and IDE restarts, so users don't have to re-navigate the hierarchy every time.

## Metadata
**Tags:** frontend, UX, reliability
**Complexity:** 6
**Repo:** 

## User Review Required
- After deployment, users should verify their saved ClickUp hierarchy selections survive a sidebar close/reopen and a full window reload.
- Linear project-picker value will now persist; users who previously relied on it resetting may notice their last filter is retained.

## Complexity Audit

### Routine
- Add `clickupHierarchyState` handling to `initialState` message handler in `implementation.html` (reading 4 fields from message payload into existing JS variables)
- Add `vscode.postMessage` calls for `clickupSaveSpaceSelection` and `clickupSaveFolderSelection` inside `attachHierarchyListeners()` (2 one-line additions)
- Add `selectedProjectName` field to `LinearConfig` interface, `_createEmptyConfig()`, and `_normalizeConfig()` in `LinearSyncService.ts`
- Add `case 'linearSaveProjectSelection'` handler in `TaskViewerProvider.ts` (mirrors existing `clickupSaveSpaceSelection` pattern)
- Add `linearProjectPickerValue` to `_sendInitialState()` payload (read from Linear config, same pattern as ClickUp)
- Restore `linearProjectPickerValue` from `initialState` handler in `implementation.html`
- Add `activeContainers` persistence to `planning-sync-config.json` via `PlanningPanelProvider` message handlers
- Restore container `<select>` values in `planning.js` after `containersReady` fires

### Complex / Risky
- **ClickUp hierarchy cascade restore**: After restoring `clickUpSelectedSpaceId`/`FolderId`/`ListId` from config, the webview must trigger the correct sequence of API calls (`clickupLoadSpaces` → `clickupLoadFolders` → `clickupLoadLists`) to repopulate the dropdown data *before* rendering the hierarchy nav. If the sequence is wrong or a response arrives out of order, the UI may show stale/empty dropdowns or render the "Change" button for an ID that has no matching name in the available lists.
- **Linear project-picker restore timing**: The `linearProjectPickerValue` is a client-side filter, not a config-level setting. Persisting it means the restored value must survive the async `linearProjectsLoaded` response that populates `linearAvailableProjects`. If the picker value is set before the project list arrives, the `<select>` element has no matching `<option>` and the value silently resets to empty.
- **Planning Panel container restore timing**: The `state.activeContainers` Map stores selected container per source (ClickUp space, Linear team, Notion database). The `<select>` dropdown is dynamically created in `handleContainersReady()`. Restoring the selection requires the containers list to be loaded first, then the select element must be found and its value set — similar race condition as the Linear picker.

## Edge-Case & Dependency Audit

**Race Conditions:**
- **ClickUp restore cascade**: The `initialState` message arrives once, but the hierarchy data (spaces, folders, lists) requires 1-3 sequential API round-trips. If the user switches tabs or the sidebar is hidden mid-restore, the later `clickupSpacesLoaded`/`clickupFoldersLoaded`/`clickupListsLoaded` messages may arrive when the panel is not visible, causing the render to be skipped (the `renderSidebarClickUpProjectPanel()` guard checks `lastIntegrationProvider`). Mitigation: ensure the restore sequence fires *after* `lastIntegrationProvider` is set to `'clickup'`, and that each step checks the current provider before proceeding.
- **Linear picker race**: The `linearProjectPickerValue` is set from `initialState`, but `linearAvailableProjects` is populated later via `linearProjectsLoaded`. The `<select>` element won't have the matching option until the projects list arrives. Mitigation: defer setting `projectPicker.value` until after `linearProjectsLoaded` is processed, or re-apply the value in the `linearProjectsLoaded` handler.
- **Planning Panel container race**: The container `<select>` is dynamically created in `handleContainersReady()`. If the saved container ID is applied before the `<select>` element exists, it's silently lost. Mitigation: re-apply the saved container value inside `handleContainersReady()`, after the `<select>` is created and populated with options.

**Security:**
- No new attack surface. All persisted values are string IDs written to the local `.switchboard/` config files (already gated by `setupComplete` checks). No user-supplied free-text is persisted beyond existing `selectedListName`.
- Planning Panel container IDs are stored in `planning-sync-config.json` which already exists and is used by the sync feature. The browse-panel filter state reuses the same file — no new file created.

**Side Effects:**
- Saving `selectedSpaceId`/`selectedFolderId` on every change means the config file is written more frequently. Each save is a full `loadConfig()` → mutate → `saveConfig()` cycle. This is the same pattern used by `clickupSaveListSelection` and is acceptable for the low write frequency of user-driven hierarchy changes.
- The `clickupSaveSpaceSelection` handler currently does *not* clear `selectedFolderId`/`selectedListId` when saving a new space. The webview already clears these variables locally on space change, but the config file may still contain stale folder/list IDs from the previous space. **Clarification**: The `clickupSaveSpaceSelection` handler should also clear `selectedFolderId` and `selectedListId` in the same config write to keep config and webview state consistent. Same for `clickupSaveFolderSelection` clearing `selectedListId`.
- Planning Panel container filter state will now persist across panel reopenings. Users who previously relied on the filter resetting to "All" on each open may notice their last container selection is retained.

**Dependencies & Conflicts:**
- No active Kanban plans found (all columns empty as of 2026-04-27). No cross-plan conflicts.

## Dependencies
None

## Adversarial Synthesis
Key risks: (1) ClickUp hierarchy cascade restore must fire API calls in the correct order and handle late/missing responses gracefully; (2) Linear picker and Planning Panel container values must be re-applied after their respective option lists load, not just on initial state; (3) Space/folder save handlers should clear downstream selections to prevent stale config state. Mitigations: `_hierarchyRestorePending` flag gates cascade branches so they only fire during restore (not normal navigation); root-folder comparison uses empty-string check (`!clickUpSelectedFolderId`) not `'_root_'`; Linear picker value deferred until `linearProjectsLoaded`; Planning Panel container value deferred until `containersReady`; downstream-clearing logic added to save handlers.

## Proposed Changes

### `/Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/implementation.html`

#### [MODIFY] `implementation.html`

**Context:** This is the webview HTML that runs the sidebar UI. It receives `initialState` from the extension host and manages all ClickUp/Linear hierarchy state in JavaScript variables. Currently it does NOT restore hierarchy state from the `clickupHierarchyState` payload, and does NOT send save messages for space/folder changes.

**Logic:**

**Step 1 — Restore ClickUp hierarchy state from `initialState` (lines ~2456-2466)**

Inside the `case 'initialState':` block, after `currentWorkspaceRoot` is set, add:

```javascript
// Restore ClickUp hierarchy state from persisted config
if (message.clickupHierarchyState) {
    const hs = message.clickupHierarchyState;
    if (hs.selectedSpaceId) {
        clickUpSelectedSpaceId = hs.selectedSpaceId;
    }
    if (hs.selectedFolderId) {
        clickUpSelectedFolderId = hs.selectedFolderId;
    }
    if (hs.selectedListId) {
        clickUpSelectedListId = hs.selectedListId;
    }
    // Flag to distinguish restore cascade from normal user navigation
    _hierarchyRestorePending = !!(clickUpSelectedSpaceId);
}
```

**Step 2 — Trigger ClickUp hierarchy cascade restore after `initialState`**

After setting the variables, if `clickUpSelectedSpaceId` is set, trigger the cascade:

```javascript
// If hierarchy state was restored, trigger data loading cascade
if (clickUpSelectedSpaceId && lastIntegrationProvider === 'clickup') {
    // Load spaces first, then the cascade will continue in clickupSpacesLoaded handler
    loadClickUpSpaces();
}
```

**Step 3 — Handle `clickupSpacesLoaded` to continue cascade restore**

In the existing `case 'clickupSpacesLoaded':` handler, after `clickUpAvailableSpaces` is populated, add:

```javascript
// Continue hierarchy restore if a restore cascade is in progress
if (_hierarchyRestorePending) {
    if (!clickUpSelectedFolderId && !clickUpSelectedListId) {
        // Only space was saved — just re-render, no further loading needed
        _hierarchyRestorePending = false;
        renderSidebarClickUpProjectPanel();
    } else {
        // Space + folder/list were saved — load folders for this space
        vscode.postMessage({
            type: 'clickupLoadFolders',
            spaceId: clickUpSelectedSpaceId,
            workspaceRoot: currentWorkspaceRoot || undefined
        });
    }
}
```

**Step 4 — Handle `clickupFoldersLoaded` to continue cascade restore**

In the existing `case 'clickupFoldersLoaded':` handler, after folders and direct lists are populated, add:

```javascript
// Continue hierarchy restore if we have a saved folder selected
// NOTE: Root/folder-less lists have selectedFolderId = '' (empty string), NOT '_root_'.
// The webview converts '_root_' to '' at attachHierarchyListeners line ~3779.
if (_hierarchyRestorePending && clickUpSelectedSpaceId) {
    if (!clickUpSelectedFolderId) {
        // Root lists — directLists already loaded in this response
        if (clickUpSelectedListId) {
            const list = clickUpAvailableDirectLists.find(l => l.id === clickUpSelectedListId);
            if (list) {
                _hierarchyRestorePending = false;
                vscode.postMessage({
                    type: 'clickupSaveListSelection',
                    spaceId: clickUpSelectedSpaceId,
                    folderId: '',
                    listId: clickUpSelectedListId,
                    workspaceRoot: currentWorkspaceRoot || undefined
                });
                loadClickUpProject(false, clickUpSelectedListId);
            } else {
                // Stale list ID — give up restore
                _hierarchyRestorePending = false;
                clickUpSelectedListId = '';
                renderSidebarClickUpProjectPanel();
            }
        } else {
            _hierarchyRestorePending = false;
            renderSidebarClickUpProjectPanel();
        }
    } else {
        // Load lists for the selected folder
        vscode.postMessage({
            type: 'clickupLoadLists',
            spaceId: clickUpSelectedSpaceId,
            folderId: clickUpSelectedFolderId,
            workspaceRoot: currentWorkspaceRoot || undefined
        });
    }
}
```

**Step 5 — Handle `clickupListsLoaded` to complete cascade restore**

In the existing `case 'clickupListsLoaded':` handler, after lists are populated, add:

```javascript
// Complete hierarchy restore if a restore cascade is in progress
if (_hierarchyRestorePending && clickUpSelectedListId && clickUpSelectedSpaceId) {
    const list = clickUpAvailableListsInFolder.find(l => l.id === clickUpSelectedListId);
    if (list) {
        _hierarchyRestorePending = false;
        vscode.postMessage({
            type: 'clickupSaveListSelection',
            spaceId: clickUpSelectedSpaceId,
            folderId: clickUpSelectedFolderId,
            listId: clickUpSelectedListId,
            workspaceRoot: currentWorkspaceRoot || undefined
        });
        loadClickUpProject(false, clickUpSelectedListId);
    } else {
        // Stale list ID — give up restore, clear the bad ID
        _hierarchyRestorePending = false;
        clickUpSelectedListId = '';
        renderSidebarClickUpProjectPanel();
    }
}
```

**Step 6 — Add save messages in `attachHierarchyListeners()` (lines ~3754-3835)**

In the space select `change` handler (line ~3759), after `clickUpSelectedSpaceId = spaceId`, add:

```javascript
vscode.postMessage({
    type: 'clickupSaveSpaceSelection',
    spaceId,
    workspaceRoot: currentWorkspaceRoot || undefined
});
```

In the folder select `change` handler (line ~3779), after `clickUpSelectedFolderId` is set, add:

```javascript
vscode.postMessage({
    type: 'clickupSaveFolderSelection',
    folderId: clickUpSelectedFolderId,
    workspaceRoot: currentWorkspaceRoot || undefined
});
```

**Step 7 — Restore Linear project-picker value from `initialState`**

Inside the `case 'initialState':` block, add:

```javascript
// Restore Linear project picker value
if (message.linearProjectPickerValue) {
    linearProjectPickerValue = message.linearProjectPickerValue;
}
```

**Step 8 — Re-apply Linear picker value after projects load**

In the `case 'linearProjectsLoaded':` handler (line ~2568), after `linearAvailableProjects` is set, add:

```javascript
// Re-apply persisted picker value now that options are available
if (linearProjectPickerValue) {
    const picker = document.querySelector('#linear-project-picker') as HTMLSelectElement | null;
    if (picker && linearAvailableProjects.some(p => p.id === linearProjectPickerValue)) {
        picker.value = linearProjectPickerValue;
    }
}
```

**Edge Cases Handled:**
- Folder-less lists (`_root_` folder path) are handled in Step 4
- Stale config IDs (space/folder/list that no longer exists) are handled by the `find()` checks — if the ID isn't found in the loaded data, the restore silently skips that level
- Provider switch mid-restore is guarded by `lastIntegrationProvider` checks

---

### `/Users/patrickvuleta/Documents/GitHub/switchboard/src/services/TaskViewerProvider.ts`

#### [MODIFY] `TaskViewerProvider.ts`

**Context:** The extension-side message handler. Phase 2 already added `clickupSaveSpaceSelection` and `clickupSaveFolderSelection` handlers, and `_sendInitialState()` already sends `clickupHierarchyState`. Two fixes are needed: (1) save handlers should clear downstream selections, (2) Linear project picker value needs to be added to initial state.

**Logic:**

**Step 1 — Clear downstream selections in `clickupSaveSpaceSelection` handler (line ~6511)**

Replace the handler body to also clear `selectedFolderId` and `selectedListId`/`selectedListName`:

```typescript
case 'clickupSaveSpaceSelection': {
    const workspaceRoot = this._resolveWorkspaceRoot(data.workspaceRoot);
    if (!workspaceRoot) {
        break;
    }
    const clickUp = this._getClickUpService(workspaceRoot);

    try {
        const config = await clickUp.loadConfig();
        if (config) {
            config.selectedSpaceId = String(data.spaceId || '').trim();
            // Clear downstream selections — new space means old folder/list are invalid
            config.selectedFolderId = '';
            config.selectedListId = '';
            config.selectedListName = '';
            await clickUp.saveConfig(config);
        }
    } catch (error) {
        console.error('Failed to save ClickUp space selection:', error);
    }
    break;
}
```

**Step 2 — Clear downstream selections in `clickupSaveFolderSelection` handler (line ~6529)**

Replace the handler body to also clear `selectedListId`/`selectedListName`:

```typescript
case 'clickupSaveFolderSelection': {
    const workspaceRoot = this._resolveWorkspaceRoot(data.workspaceRoot);
    if (!workspaceRoot) {
        break;
    }
    const clickUp = this._getClickUpService(workspaceRoot);

    try {
        const config = await clickUp.loadConfig();
        if (config) {
            config.selectedFolderId = String(data.folderId || '').trim();
            // Clear downstream selections — new folder means old list is invalid
            config.selectedListId = '';
            config.selectedListName = '';
            await clickUp.saveConfig(config);
        }
    } catch (error) {
        console.error('Failed to save ClickUp folder selection:', error);
    }
    break;
}
```

**Step 3 — Add Linear project picker value to `_sendInitialState()` (line ~3852)**

After the `clickupHierarchyState` block, add Linear state:

```typescript
// Load Linear project picker state if available
let linearProjectPickerValue: string | undefined;
if (workspaceRoot) {
    try {
        const linear = this._getLinearService(workspaceRoot);
        const linearConfig = await linear.loadConfig();
        if (linearConfig?.setupComplete && linearConfig.selectedProjectName) {
            linearProjectPickerValue = linearConfig.selectedProjectName;
        }
    } catch {
        // Ignore errors loading Linear config
    }
}
```

Then add `linearProjectPickerValue` to the `postMessage` payload:

```typescript
this._view?.webview.postMessage({
    type: 'initialState',
    // ... existing fields ...
    clickupHierarchyState,
    linearProjectPickerValue
});
```

**Step 4 — Add `linearSaveProjectSelection` handler**

After the existing `clickupSaveFolderSelection` case, add:

```typescript
case 'linearSaveProjectSelection': {
    const workspaceRoot = this._resolveWorkspaceRoot(data.workspaceRoot);
    if (!workspaceRoot) {
        break;
    }
    const linear = this._getLinearService(workspaceRoot);

    try {
        const config = await linear.loadConfig();
        if (config) {
            config.selectedProjectName = String(data.projectName || '').trim();
            await linear.saveConfig(config);
        }
    } catch (error) {
        console.error('Failed to save Linear project selection:', error);
    }
    break;
}
```

**Edge Cases Handled:**
- Downstream clearing prevents stale IDs in config when parent level changes
- Linear save handler follows same error-handling pattern as ClickUp handlers

---

### `/Users/patrickvuleta/Documents/GitHub/switchboard/src/services/LinearSyncService.ts`

#### [MODIFY] `LinearSyncService.ts`

**Context:** Linear config persistence layer. Needs a `selectedProjectName` field to persist the project picker value.

**Logic:**

**Step 1 — Add `selectedProjectName` to `LinearConfig` interface (line ~14)**

```typescript
export interface LinearConfig {
  teamId: string;
  teamName: string;
  includeProjectNames?: string[];
  excludeProjectNames?: string[];
  setupComplete: boolean;
  lastSync: string | null;
  realTimeSyncEnabled: boolean;
  autoPullEnabled: boolean;
  pullIntervalMinutes: AutoPullIntervalMinutes;
  automationRules: LinearAutomationRule[];
  selectedProjectName: string;  // ADD THIS
}
```

**Step 2 — Add default in `_createEmptyConfig()` (line ~154)**

```typescript
selectedProjectName: '',  // ADD THIS
```

**Step 3 — Add normalization in `_normalizeConfig()` (line ~173)**

```typescript
selectedProjectName: raw.selectedProjectName || '',  // ADD THIS
```

**Edge Cases Handled:**
- Empty string default means no project is pre-selected on fresh install
- Normalization with `|| ''` handles missing/undefined field in existing config files

### `/Users/patrickvuleta/Documents/GitHub/switchboard/src/services/PlanningPanelProvider.ts`

#### [MODIFY] `PlanningPanelProvider.ts`

**Context:** The planning panel's browse tab has a container filter `<select>` per source (ClickUp spaces, Linear teams, Notion databases). The selected container is stored in `state.activeContainers` (a JS Map) in `planning.js` and is lost on webview reload. The `planning-sync-config.json` file already has a `selectedContainers` array used by the auto-sync feature — we can reuse this for the browse-panel filter state.

**Logic:**

**Step 1 — Add `savePlanningContainerSelection` message handler**

After the existing `fetchContainers` case, add:

```typescript
case 'savePlanningContainerSelection': {
    const sourceId = String(msg.sourceId || '').trim();
    const containerId = String(msg.containerId || '').trim();
    if (!sourceId || !workspaceRoot) { break; }

    try {
        const configPath = path.join(workspaceRoot, '.switchboard', 'planning-sync-config.json');
        let config: any = {};
        try {
            const content = await fs.promises.readFile(configPath, 'utf8');
            config = JSON.parse(content);
        } catch { /* no existing config */ }

        // Store as browseFilterContainers: { [sourceId]: containerId }
        if (!config.browseFilterContainers) {
            config.browseFilterContainers = {};
        }
        if (containerId && containerId !== '__all__') {
            config.browseFilterContainers[sourceId] = containerId;
        } else {
            delete config.browseFilterContainers[sourceId];
        }

        await fs.promises.mkdir(path.dirname(configPath), { recursive: true });
        await fs.promises.writeFile(configPath, JSON.stringify(config, null, 2), 'utf8');
    } catch (error) {
        console.error('[PlanningPanel] Failed to save container selection:', error);
    }
    break;
}
```

**Step 2 — Send saved container selections in initial state**

In the `_sendOnlineDocsReady()` method (or wherever the panel sends its initial state), add `browseFilterContainers` to the `onlineDocsReady` message:

```typescript
private async _sendOnlineDocsReady(): Promise<void> {
    const roots = this._researchImportService
        .getAvailableSources()
        .filter(sourceId => sourceId !== 'local-folder')
        .map(sourceId => ({ sourceId, nodes: [] as TreeNode[] }));

    // Load saved browse filter containers
    let browseFilterContainers: Record<string, string> = {};
    const workspaceRoot = this._resolveWorkspaceRoot();
    if (workspaceRoot) {
        try {
            const configPath = path.join(workspaceRoot, '.switchboard', 'planning-sync-config.json');
            const content = await fs.promises.readFile(configPath, 'utf8');
            const config = JSON.parse(content);
            browseFilterContainers = config.browseFilterContainers || {};
        } catch { /* no config yet */ }
    }

    if (!this._panel) { throw new Error('[PlanningPanel] _panel is undefined'); }
    this._panel.webview.postMessage({
        type: 'onlineDocsReady',
        roots,
        enabledSources: { clickup: true, linear: true, notion: true },
        browseFilterContainers
    });
}
```

**Edge Cases Handled:**
- Uses `browseFilterContainers` (separate key) to avoid colliding with the existing `selectedContainers` array used by auto-sync
- Deleting the key when `__all__` is selected keeps the config clean
- Missing config file is handled gracefully (empty object default)

---

### `/Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/planning.js`

#### [MODIFY] `planning.js`

**Context:** The planning panel webview. `state.activeContainers` is a Map that stores the selected container per source. It's set in `handleContainersReady()` when the user changes the `<select>` dropdown. It's lost on reload.

**Logic:**

**Step 1 — Store saved filter containers from `onlineDocsReady` message**

In `handleOnlineDocsReady()` (line ~567), save the filter containers before rendering:

```javascript
function handleOnlineDocsReady(msg) {
    // Stash saved filter containers for re-application after containers load
    _savedBrowseFilterContainers = msg.browseFilterContainers || {};
    renderOnlineDocs(msg.roots || [], msg.enabledSources || {
        clickup: true,
        linear: true,
        notion: true
    });
}
```

Add the variable declaration near the top of the IIFE:

```javascript
let _savedBrowseFilterContainers = {};
```

**Step 2 — Re-apply saved container selection in `handleContainersReady()`**

In `handleContainersReady()` (line ~734), after the `<select>` is created and populated with options, re-apply the saved value:

```javascript
function handleContainersReady(msg) {
    const { sourceId, containers } = msg;
    // ... existing code that creates the <select> and appends options ...

    // AFTER the select is fully populated, re-apply saved filter
    const savedContainerId = _savedBrowseFilterContainers[sourceId];
    if (savedContainerId && select.querySelector(`option[value="${savedContainerId}"]`)) {
        select.value = savedContainerId;
        state.activeContainers.set(sourceId, {
            id: savedContainerId,
            name: containerMap.get(savedContainerId) || 'Unknown'
        });
        // Trigger filtered doc load for the saved container
        vscode.postMessage({
            type: 'fetchFilteredDocs',
            sourceId,
            containerId: savedContainerId,
            requestId: ++state.filterRequestIds[`filter:${sourceId}`] || 1
        });
    }

    // Clear saved filter after applying (one-shot)
    delete _savedBrowseFilterContainers[sourceId];
}
```

**Step 3 — Send save message when container selection changes**

In the `select.addEventListener('change', ...)` callback inside `handleContainersReady()` (line ~773), add a save message after updating `state.activeContainers`:

```javascript
select.addEventListener('change', () => {
    // ... existing code that updates state.activeContainers ...

    // Persist the selection
    vscode.postMessage({
        type: 'savePlanningContainerSelection',
        sourceId,
        containerId: select.value
    });

    // ... existing code that sends fetchFilteredDocs ...
});
```

**Edge Cases Handled:**
- Saved container ID is only applied if a matching `<option>` exists in the populated select (handles stale IDs from deleted spaces/teams)
- `_savedBrowseFilterContainers` is cleared per-source after application to prevent re-application on manual container refresh
- The `fetchFilteredDocs` trigger after restore ensures the doc list loads for the saved container, not just "All"

## Verification Plan

### Automated Tests
- No existing unit tests cover the sidebar webview state. Manual verification is required for the webview changes.
- After implementation, run `npm run compile` to verify TypeScript compilation succeeds with the new `LinearConfig` field, `TaskViewerProvider` changes, and `PlanningPanelProvider` changes.

### Manual Test Scenarios
1. **ClickUp full cycle**: Select Space → Folder → List → Close sidebar → Reopen → Verify all three levels restored with correct names
2. **ClickUp window reload**: Select Space → Folder → List → Reload Window (`Cmd+Shift+P` → "Reload Window") → Verify hierarchy restored and tasks load
3. **ClickUp change propagation**: Select Space A → Folder X → List 1 → Change to Space B → Close/reopen → Verify Space B is selected, Folder and List are empty (downstream cleared)
4. **ClickUp folder-less lists**: Select Space → "(Root)" folder → List → Close/reopen → Verify root list restored
5. **ClickUp stale ID**: Manually edit `clickup-config.json` to set a `selectedSpaceId` that doesn't exist → Reopen sidebar → Verify graceful fallback (space not found, hierarchy shows "Select Space...")
6. **Linear project picker**: Select a project in the Linear picker → Close sidebar → Reopen → Verify picker value restored
7. **Linear window reload**: Select Linear project → Reload Window → Verify project picker value restored
8. **Planning Panel ClickUp container**: Open Planning Panel → Select a ClickUp space in the filter dropdown → Close panel → Reopen → Verify the space filter is still selected and docs load for that space
9. **Planning Panel Linear container**: Open Planning Panel → Select a Linear team in the filter dropdown → Close panel → Reopen → Verify the team filter is still selected
10. **Planning Panel Notion container**: Open Planning Panel → Select a Notion database in the filter dropdown → Close panel → Reopen → Verify the database filter is still selected
11. **Planning Panel stale container**: Edit `planning-sync-config.json` to set a `browseFilterContainers.clickup` value that doesn't exist → Reopen panel → Verify graceful fallback (filter shows "All")

## Current Status
- **Phase 1**: ✅ Complete — `ClickUpConfig` extended with `selectedSpaceId`/`selectedFolderId`
- **Phase 2**: ✅ Complete — Extension-side handlers added; file corruption was fixed (verified `case 'ready':` present at line 6035)
- **Phase 3**: ✅ Complete — Webview-side state restore and save messages
- **Phase 4**: ✅ Complete — Linear project picker persistence
- **Phase 5**: ✅ Complete — Planning Panel container filter persistence
- **Phase 6**: ⏳ Pending — Manual testing

## Recommendation
**Send to Coder** (Complexity 6 — medium, multi-file changes across 5 files but all follow existing patterns)

---

## Reviewer Pass — 2026-04-28

### Stage 1: Grumpy Adversarial Findings

| # | Severity | Finding |
|---|----------|---------|
| 1 | **MAJOR** | `linearProjectsLoaded` handler compared `linearProjectPickerValue` against `p.id` (UUID) but the picker uses project NAMES as option values. The `.some(p => p.id === linearProjectPickerValue)` check would never match, so the picker value was never restored after projects loaded. |
| 2 | **MAJOR** | `linearProjectsLoaded` handler used `document.querySelector('#linear-project-picker')` but the actual element ID is `sidebar-linear-project-picker`. The querySelector returned `null` and the re-apply silently failed. |
| 3 | **MAJOR** | `renderSidebarLinearProjectPickerOptions` resets `linearProjectPickerValue` to `''` when the project isn't in the current issue list. This clobbers the persisted value before `linearProjectsLoaded` can re-apply it. The restore chain breaks: `initialState` sets value → render resets it → `linearProjectsLoaded` finds empty value and can't restore. |
| 4 | **NIT** | ClickUp hierarchy cascade restore correctly guards on `lastIntegrationProvider === 'clickup'`, preventing unnecessary API calls when the user isn't viewing ClickUp. No fix needed. |
| 5 | **NIT** | Planning Panel container restore triggers a default `__all__` fetch before the saved filter is applied, causing a wasted API call. The `requestId` guard prevents stale data. |
| 6 | **NIT** | No issue with `_savedBrowseFilterContainers` lifecycle — correctly re-initialized from `onlineDocsReady` message. |

### Stage 2: Balanced Synthesis

| Finding | Verdict | Action |
|---------|---------|--------|
| 1 — Name vs ID comparison | **Fix now** | Compare `p.name` instead of `p.id` in `linearProjectsLoaded` |
| 2 — Wrong element ID | **Fix now** | Use `getProjectTabElements()` instead of hardcoded `#linear-project-picker` |
| 3 — Value clobbered by render | **Fix now** | Add `_restoredLinearProjectPickerValue` variable set from `initialState`, used by `linearProjectsLoaded` for re-apply, then cleared (one-shot) |
| 4 — Provider guard | No fix | Correct behavior |
| 5 — Double fetch | Defer | Wasted call but requestId guard prevents stale data |
| 6 — No issue | No fix | — |

### Code Fixes Applied

**Fix 1+2 (MAJOR):** Replaced the `linearProjectsLoaded` re-apply block to use `getProjectTabElements()` (correct element ID `sidebar-linear-project-picker`) and compare `p.name` instead of `p.id` (picker uses project names as values).

**File:** `src/webview/implementation.html` — `case 'linearProjectsLoaded':` handler

**Fix 3 (MAJOR):** Added `_restoredLinearProjectPickerValue` variable that is set from `initialState` and not clobbered by `renderSidebarLinearProjectPickerOptions`. The `linearProjectsLoaded` handler reads from `_restoredLinearProjectPickerValue || linearProjectPickerValue`, applies the value if a matching project name is found, then clears the restore variable (one-shot). This ensures the persisted value survives the render cycle between `initialState` and `linearProjectsLoaded`.

**File:** `src/webview/implementation.html` — variable declaration (~line 1868), `initialState` handler (~line 2457), `linearProjectsLoaded` handler (~line 2578)

### Validation Results

- **TypeScript compilation:** `npx tsc --noEmit` — PASS (only pre-existing errors unrelated to this plan: import path extensions in ClickUpSyncService.ts and KanbanProvider.ts)
- **No new type errors introduced by fixes**

### Files Changed

- `src/webview/implementation.html` — 4 edits (add `_restoredLinearProjectPickerValue` variable, set it in `initialState`, fix `linearProjectsLoaded` re-apply with correct element ID and name comparison, use restore variable)

### Remaining Risks

1. **ClickUp hierarchy cascade restore untested** — The cascade (`loadClickUpSpaces` → `clickupSpacesLoaded` → `clickupLoadFolders` → `clickupFoldersLoaded` → `clickupLoadLists` → `clickupListsLoaded`) has not been manually tested. If any API call fails or returns empty data, the `_hierarchyRestorePending` flag will remain `true` indefinitely, preventing normal hierarchy navigation until the user switches providers or the flag is cleared by a stale-ID fallback.
2. **No automated tests** — The plan notes no existing unit tests cover the sidebar webview state. Manual verification is required.
3. **Planning Panel double fetch** — On container restore, both `__all__` and the saved container fetch are dispatched. The `requestId` guard prevents stale data, but the wasted API call could be avoided by skipping the default fetch when a saved filter exists.
4. **`linearProjectPickerValue` filter inconsistency** — When the saved project name isn't in the current issue list, `renderSidebarLinearProjectPickerOptions` resets `linearProjectPickerValue` to `''` (showing all issues), but the config still has the old name saved. On next sidebar open, the restore will try again. This is acceptable behavior but could confuse users who see "All projects" in the picker while the config remembers a different selection.
