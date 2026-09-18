# Fix Tickets Tab Connection Details Not Persisting After Webview Reload

## Goal

Restore ClickUp (Space → Folder → List) and Linear (Project) selections after webview reload so users do not have to re-enter them.

### Core Problem & Root Cause Analysis

#### ClickUp: Cascade Breaks on Restore

The `saveTicketsState()` function stores `clickUpSelectedSpaceId`, `clickUpSelectedFolderId`, and `clickUpSelectedListId` via `vscode.setState()`.

`restoreTicketsState()` brings these IDs back. However:

1. The **available spaces/folders/lists arrays** are NOT persisted. They are empty after reload.
2. On tab activation, `loadClickUpSpaces()` fires and fetches spaces. When the response arrives, the handler sets `clickUpAvailableSpaces` but **clears** `clickUpAvailableFolders` and `clickUpAvailableListsInFolder` (line 3668-3670).
3. Because `clickUpSelectedSpaceId` is already restored, the UI renders the space name as plain text (with a "Change" button) instead of a `<select>` dropdown.
4. **No `change` event fires** — there is nothing to trigger loading folders for the restored space, or lists for the restored folder. The cascade stops. The UI shows `Unknown` for missing list/folder data because the arrays are empty.

#### Linear: Restored Value Overwritten Before Load Completes

`saveTicketsState()` stores `linearProjectPickerValue`. On restore:

1. `restoreTicketsState()` brings back the saved project name.
2. `loadLinearProject()` starts immediately, calling `renderTicketsLinearPanel()`.
3. `renderTicketsLinearProjectPickerOptions()` rebuilds the picker from `linearProjectIssues`, which is **empty** on fresh load. The picker has zero `<option>`s.
4. The restored value is then overwritten:
   ```js
   // @/Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/planning.js:5441
   projectPicker.value = projects.includes(linearProjectPickerValue) ? linearProjectPickerValue : '';
   linearProjectPickerValue = projectPicker.value;  // WIPED to ''
   ```
5. When `linearProjectLoaded` finally arrives, the picker repopulates, but `linearProjectPickerValue` is already `''`. The filter is lost.

## Metadata
- **Tags:** frontend, bugfix, ui
- **Complexity:** 4

## User Review Required

- Confirm that the restore chain should auto-load the full ClickUp hierarchy (space → folder → list → project) on tab activation, rather than requiring user interaction to "nudge" the cascade.
- Confirm that if a restored ID no longer exists in the remote data, the UI should fall back to the selector dropdown (not silently drop the selection).

## Complexity Audit

### Routine
- Wire up existing dead variable `_restoredLinearProjectPickerValue` (declared line 63, never used)
- Add flag `_restoringClickUpHierarchy` to gate restore chain
- Add restore-chain logic to `clickupSpacesLoaded`, `clickupFoldersLoaded`, `clickupListsLoaded` handlers
- Assign `_restoredLinearProjectPickerValue` in `restoreTicketsState()`
- Clear `_restoringClickUpHierarchy` in user-driven change handlers ("Change" buttons, dropdown selects)

### Complex / Risky
- **Double-load guard**: Tab activation (line 323) fires `loadClickUpSpaces()` when `!ticketsLoadedOnce`. The restore chain also fires it. Must prevent duplicate `clickupLoadSpaces` messages that would clear arrays mid-restore.
- **Ordering in `linearProjectLoaded` handler**: Must assign `_restoredLinearProjectPickerValue` to `linearProjectPickerValue` BEFORE `renderTicketsTab()` call at line 3651, or picker flashes empty for one frame.
- **`_root_` folder branch**: When `clickUpSelectedFolderId` is empty (user selected root-level lists), the restore chain must load direct lists, not folder lists. The `clickupListsLoaded` handler (line 3682) branches on `clickUpSelectedFolderId`; the restore chain must match this logic.

## Edge-Case & Dependency Audit

- **Race Conditions**: User clicks "Change Space" mid-restore chain → must clear `_restoringClickUpHierarchy` flag and respect user's new choice. The "Change" button handler (line 5838-5857) already resets all state; adding a flag clear is trivial.
- **Security**: No security implications — all data is local webview state.
- **Side Effects**: `clickUpHierarchyLoading` flag is set/unset per load step. Between handler and next message send, no render cycle is affected. No visible flicker.
- **Dependencies & Conflicts**: `ticketsLoadedOnce` (line 51) is not persisted. After restore it is `false`, causing the tab activation guard (line 323) to fire a duplicate load. Must set `ticketsLoadedOnce = true` at start of restore chain, or skip the activation guard when restoring.

## Dependencies

- None (single-file fix, no external session dependencies)

## Adversarial Synthesis

Key risks: double-load on tab activation when `ticketsLoadedOnce` is false, Linear picker value assignment ordering, and `_root_` folder branch in ClickUp restore chain. Mitigations: set `ticketsLoadedOnce = true` before restore chain loads, assign restored Linear value before render call, branch on `clickUpSelectedFolderId` emptiness for direct-list vs folder-list loading.

## Proposed Changes

### `src/webview/planning.js`

#### 1. Add `_restoringClickUpHierarchy` flag declaration (near line 88)

**Context**: Need a flag to distinguish restore-driven loads from user-driven loads.
**Logic**: Declare alongside other ClickUp state variables.
**Implementation**:
```js
// After line 88 (clickUpImportPending)
let _restoringClickUpHierarchy = false;
```

#### 2. Modify `restoreTicketsState()` (line 6156-6168)

**Context**: Currently restores IDs but does not set up the restore chain or guard against double-loads.
**Logic**: After restoring IDs, if ClickUp IDs exist, set `_restoringClickUpHierarchy = true` and `ticketsLoadedOnce = true` (prevent double-load from tab activation guard at line 323). If Linear picker value exists, store it in `_restoredLinearProjectPickerValue` (variable already declared at line 63 but never used).
**Implementation**:
```js
function restoreTicketsState() {
    const state = vscode.getState()?.tickets;
    if (!state) return;
    lastIntegrationProvider = state.lastIntegrationProvider || null;
    linearProjectSearchValue = state.linearProjectSearchValue || '';
    linearProjectStateFilterValue = state.linearProjectStateFilterValue || '';
    linearProjectPickerValue = state.linearProjectPickerValue || '';
    clickUpSelectedSpaceId = state.clickUpSelectedSpaceId || '';
    clickUpSelectedFolderId = state.clickUpSelectedFolderId || '';
    clickUpSelectedListId = state.clickUpSelectedListId || '';
    clickUpProjectSearchValue = state.clickUpProjectSearchValue || '';
    clickUpProjectStatusFilterValue = state.clickUpProjectStatusFilterValue || '';

    // --- NEW: Restore chain setup ---
    if (clickUpSelectedSpaceId) {
        _restoringClickUpHierarchy = true;
        ticketsLoadedOnce = true; // Prevent double-load from tab activation guard (line 323)
    }
    if (state.linearProjectPickerValue) {
        _restoredLinearProjectPickerValue = state.linearProjectPickerValue;
    }
}
```
**Edge Cases**: If no ClickUp IDs are restored, `_restoringClickUpHierarchy` stays `false` — normal flow. If no Linear picker value, `_restoredLinearProjectPickerValue` stays `''` — no effect.

#### 3. Modify `clickupSpacesLoaded` handler (line 3666-3672)

**Context**: Handler clears folder/list arrays every time. During restore, must trigger folder load if a space ID was previously selected.
**Logic**: After arrays are updated, if `_restoringClickUpHierarchy` is true and `clickUpSelectedSpaceId` exists in the fetched spaces, send `clickupLoadFolders` message. If the restored space ID is NOT in fetched spaces, clear the selection and fall back to space selector.
**Implementation**:
```js
case 'clickupSpacesLoaded':
    clickUpAvailableSpaces = msg.spaces || [];
    clickUpAvailableFolders = [];
    clickUpAvailableListsInFolder = [];
    clickUpAvailableDirectLists = [];
    clickUpHierarchyLoading = false;
    // --- NEW: Restore chain — load folders for restored space ---
    if (_restoringClickUpHierarchy && clickUpSelectedSpaceId) {
        const spaceExists = clickUpAvailableSpaces.some(s => s.id === clickUpSelectedSpaceId);
        if (spaceExists) {
            clickUpHierarchyLoading = true;
            vscode.postMessage({
                type: 'clickupLoadFolders',
                spaceId: clickUpSelectedSpaceId,
                workspaceRoot: currentWorkspaceRoot || undefined
            });
        } else {
            // Space no longer exists — clear all downstream selections
            clickUpSelectedSpaceId = '';
            clickUpSelectedFolderId = '';
            clickUpSelectedListId = '';
            _restoringClickUpHierarchy = false;
        }
    }
    renderTicketsTab();
    break;
```
**Edge Cases**: Space deleted remotely → falls back to selector. `clickUpHierarchyLoading = true` prevents stale render between folder request and response.

#### 4. Modify `clickupFoldersLoaded` handler (line 3674-3679)

**Context**: Handler receives folders and direct lists. During restore, must trigger list load if a folder ID was previously selected, or handle the `_root_` case (no folder, direct lists).
**Logic**: If `_restoringClickUpHierarchy` is true:
- If `clickUpSelectedFolderId` exists and is in fetched folders → send `clickupLoadLists` for that folder.
- If `clickUpSelectedFolderId` is empty (was `_root_`) and direct lists are now available → check if `clickUpSelectedListId` is in `clickUpAvailableDirectLists`. If so, load the project. If not, clear list selection.
- If restored folder ID not in fetched folders → clear folder+list selections, fall back.
**Implementation**:
```js
case 'clickupFoldersLoaded':
    clickUpAvailableFolders = msg.folders || [];
    clickUpAvailableListsInFolder = [];
    clickUpAvailableDirectLists = msg.directLists || [];
    clickUpHierarchyLoading = false;
    // --- NEW: Restore chain — load lists for restored folder ---
    if (_restoringClickUpHierarchy && clickUpSelectedSpaceId) {
        if (clickUpSelectedFolderId) {
            const folderExists = clickUpAvailableFolders.some(f => f.id === clickUpSelectedFolderId);
            if (folderExists) {
                clickUpHierarchyLoading = true;
                vscode.postMessage({
                    type: 'clickupLoadLists',
                    spaceId: clickUpSelectedSpaceId,
                    folderId: clickUpSelectedFolderId,
                    workspaceRoot: currentWorkspaceRoot || undefined
                });
            } else {
                // Folder no longer exists — clear downstream selections
                clickUpSelectedFolderId = '';
                clickUpSelectedListId = '';
                _restoringClickUpHierarchy = false;
            }
        } else {
            // _root_ case: no folder selected, direct lists already populated
            if (clickUpSelectedListId && clickUpAvailableDirectLists.some(l => l.id === clickUpSelectedListId)) {
                // List found in direct lists — load project
                _restoringClickUpHierarchy = false;
                loadClickUpProject(false, clickUpSelectedListId);
            } else if (clickUpSelectedListId) {
                // List ID no longer valid in direct lists
                clickUpSelectedListId = '';
                _restoringClickUpHierarchy = false;
            } else {
                // No list was selected — show list selector
                _restoringClickUpHierarchy = false;
            }
        }
    }
    renderTicketsTab();
    break;
```
**Edge Cases**: `_root_` folder (empty `clickUpSelectedFolderId`) — direct lists are already in `clickUpAvailableDirectLists` from the message, so no extra load needed. Folder deleted remotely → falls back.

#### 5. Modify `clickupListsLoaded` handler (line 3681-3688)

**Context**: Handler receives lists. During restore, must trigger project load if a list ID was previously selected.
**Logic**: If `_restoringClickUpHierarchy` is true and `clickUpSelectedListId` exists in the fetched lists, call `loadClickUpProject()`. If not, clear list selection.
**Implementation**:
```js
case 'clickupListsLoaded':
    if (clickUpSelectedFolderId) {
        clickUpAvailableListsInFolder = msg.lists || [];
    } else {
        clickUpAvailableDirectLists = msg.lists || [];
    }
    clickUpHierarchyLoading = false;
    // --- NEW: Restore chain — load project for restored list ---
    if (_restoringClickUpHierarchy && clickUpSelectedListId) {
        const availableLists = clickUpSelectedFolderId
            ? clickUpAvailableListsInFolder
            : clickUpAvailableDirectLists;
        const listExists = availableLists.some(l => l.id === clickUpSelectedListId);
        if (listExists) {
            _restoringClickUpHierarchy = false;
            loadClickUpProject(false, clickUpSelectedListId);
        } else {
            // List no longer exists — clear selection
            clickUpSelectedListId = '';
            _restoringClickUpHierarchy = false;
        }
    }
    renderTicketsTab();
    break;
```
**Edge Cases**: List deleted remotely → falls back to list selector. Branch on `clickUpSelectedFolderId` to check correct array.

#### 6. Modify `linearProjectLoaded` handler (line 3645-3651)

**Context**: Handler sets `linearProjectIssues` and calls `renderTicketsTab()`. Must apply restored picker value BEFORE the render.
**Logic**: After setting `linearProjectIssues` and `linearProjectStatus`, check if `_restoredLinearProjectPickerValue` has a value. If so, assign it to `linearProjectPickerValue` and clear the temp variable. This must happen BEFORE `renderTicketsTab()`.
**Implementation**:
```js
case 'linearProjectLoaded':
    linearProjectIssues = Array.isArray(msg.issues) ? msg.issues : [];
    linearProjectStatus = 'loaded';
    linearProjectMessage = '';
    linearProjectLoading = false;
    ticketsLoadedOnce = true;
    // --- NEW: Apply restored project picker value before render ---
    if (_restoredLinearProjectPickerValue) {
        const projects = Array.from(new Set(
            linearProjectIssues
                .map((issue) => String(issue?.project?.name || '').trim())
                .filter(Boolean)
        ));
        if (projects.includes(_restoredLinearProjectPickerValue)) {
            linearProjectPickerValue = _restoredLinearProjectPickerValue;
        }
        // Clear temp regardless — if project no longer exists, fall back to "All projects"
        _restoredLinearProjectPickerValue = '';
    }
    renderTicketsTab();
    break;
```
**Edge Cases**: Project no longer in issues → `linearProjectPickerValue` stays as-is (will be `''` from the overwrite in `renderTicketsLinearProjectPickerOptions`). No crash.

#### 7. Clear `_restoringClickUpHierarchy` in user-driven handlers

**Context**: If user clicks "Change" button or selects a new dropdown value during restore, the chain must stop.
**Logic**: In `attachTicketsHierarchyListeners()` (line 5766), add `_restoringClickUpHierarchy = false` to:
- Space select `change` handler (line 5768)
- Folder select `change` handler (line 5793)
- List select `change` handler (line 5821)
- "Change" button click handler (line 5838)
**Implementation**: Add `_restoringClickUpHierarchy = false;` as the first line in each of these four event handlers.

#### 8. No changes to `saveTicketsState()` (line 6138-6153)

State shape is already correct. No schema migration needed.

#### 9. No changes to `renderTicketsLinearProjectPickerOptions()` (line 5422-5443)

The existing code at line 5441-5442 already handles the case where `linearProjectPickerValue` is set — it will find the value in the projects list and select it. The fix is in the handler (step 6 above) ensuring `linearProjectPickerValue` is set correctly BEFORE this render runs.

## Verification Plan

### Automated Tests

(Skipped per session directive — test suite will be run separately by the user.)

### Manual Verification

1. Open Switchboard planning panel → Tickets tab
2. Select ClickUp Space → Folder → List, load tasks
3. Switch to another VS Code tab (causes webview unload)
4. Return to Tickets tab
5. **Verify**: Space/Folder/List selections are restored, tasks load automatically
6. Repeat with Linear: select a project filter, switch away, return
7. **Verify**: Project filter is restored, filtered issues display correctly
8. **Edge case test**: Select a ClickUp space/folder/list, then have an admin delete the folder remotely. Reload webview. Verify folder selector appears (no "Unknown" label).
9. **Edge case test**: Select `_root_` folder (lists not in any folder) in ClickUp. Reload webview. Verify direct lists are restored.
10. **Edge case test**: During ClickUp restore chain (while loading spinner is visible), click "Change Space". Verify chain stops, user's new selection takes effect.

## Complexity Justification

Score: **4/10**. The fix is bounded to one file (`planning.js`), requires no schema changes, and the patterns (flags, deferred assignment) are idiomatic in the existing codebase. The `_restoredLinearProjectPickerValue` variable is already declared (just unused). Risk is moderate because the restore chain must not interfere with normal user interaction, and the double-load guard must be handled correctly. No new architectural patterns introduced.

**Recommendation: Send to Coder** (complexity 4-6)

## Review Findings

One CRITICAL bug found and fixed: `restoreTicketsState()` set `ticketsLoadedOnce = true` to prevent the tab activation guard from double-loading, but never called `loadClickUpSpaces()` itself — so the ClickUp restore chain never started (spaces never loaded, `clickupSpacesLoaded` never fired, hierarchy never restored). Fixed by adding `loadClickUpSpaces()` call in `restoreTicketsState()` at line 6506. All other plan steps (flag declaration, handler modifications, user-driven handler flag clears, Linear picker restore) were implemented correctly. File changed: `src/webview/planning.js`. Syntax check passes. Remaining risk: if `loadClickUpSpaces()` is called before DOM init completes on first-ever tab visit, but `initTicketsTab()` runs first (line 424), so this is safe.
