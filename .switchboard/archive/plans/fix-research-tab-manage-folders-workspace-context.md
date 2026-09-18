# Fix Research Tab Manage Folders Workspace Context

## Goal

Fix the "Manage Folders" button in the research tab of planning.html to use the correct workspace filter (`researchWorkspaceRoot`) instead of incorrectly using the Local Docs workspace filter (`state.localWorkspaceRootFilter`).

## Metadata

**Complexity:** 3

**Tags:** ui, bugfix

## User Review Required

- Verify modal title "Manage Research Folders" matches UX copy guidelines.
- Confirm fallback to `_workspaceItems[0]?.workspaceRoot` when `researchWorkspaceRoot` is empty aligns with expected product behavior for other tabs.

## Complexity Audit

### Routine
- Single-file change in `src/webview/planning.js`
- Reuses existing scope-passing pattern already present in design.html
- Low risk, localized to research tab folder management

### Complex / Risky
- None

## Edge-Case & Dependency Audit

- **Race Conditions**: The `openFoldersModal` function calls `renderFolderListModal` immediately and then posts `refreshSource`. This existing race is unchanged; the research scope uses the same pre-warmed state path.
- **Security**: No new security surface. Messages posted to VS Code use existing message types (`removeLocalFolder`, `addLocalFolder`). `researchWorkspaceRoot` is derived from user-selected dropdown, not external input.
- **Side Effects**: Changing `folderModalScope` to `'research'` affects only the modal title and workspace root resolution within the modal lifecycle. No persistent state mutations outside existing folder management.
- **Dependencies & Conflicts**: Depends on `researchWorkspaceRoot` variable initialized at line 131. No conflicts with other tabs; 'local' and 'tickets' scopes untouched.

## Dependencies

None

## Adversarial Synthesis

Key risks: incorrect workspace root fallback if `researchWorkspaceRoot` is empty or stale; potential inconsistency if `_workspaceItems` is empty. Mitigations: fallback chain to `_workspaceItems[0]?.workspaceRoot || ''` mirrors existing patterns; no new state introduced.

## Proposed Changes

### `src/webview/planning.js`

- **Context**: The research tab's "Manage Folders" button opens the folder modal but defaults to `'local'` scope, pulling folders from the Local Docs workspace filter instead of the research workspace filter.
- **Logic**: Update `openFoldersModal` to accept `'research'` scope, update `renderFolderListModal` to resolve `researchWorkspaceRoot` when `folderModalScope === 'research'`, and update add/remove handlers to post the correct workspace root.
- **Implementation**: See steps in the Implementation Plan below.
- **Edge Cases**: Empty `researchWorkspaceRoot` falls back to first workspace item; no folders configured shows existing empty state.

## Verification Plan

### Automated Tests

- No new automated tests required per session directive (SKIP TESTS). Manual testing checklist covers regression for local and tickets tabs.

## Problem Analysis

The research tab has its own workspace filter dropdown (`research-workspace-filter`) that sets the `researchWorkspaceRoot` variable. However, when the user clicks "Manage Folders" in the research tab, the folder modal opens and displays folders from the wrong workspace context.

**Root Cause:**

In `planning.js`:
- Line 618-621: The `btn-manage-research-folders` button calls `openFoldersModal()` without any parameters
- Line 4903: The `openFoldersModal` function defaults to `scope = 'local'` when no parameter is passed
- Line 1099: The `renderFolderListModal` function uses `state.localWorkspaceRootFilter` to retrieve folder paths when the scope is 'local'
- This causes the modal to show folders from the Local Docs tab's workspace instead of the Research tab's workspace

**Why this matters:**

Users can have different folder configurations per workspace. When managing research folders, they expect to see and modify folders for the workspace they've selected in the research tab, not the workspace selected in the Local Docs tab.

## Audit Results

### planning.html/js

| Button ID | Current Behavior | Expected Behavior | Status |
|-----------|------------------|-------------------|--------|
| `btn-manage-research-folders` | Calls `openFoldersModal()` (defaults to 'local' scope, uses `state.localWorkspaceRootFilter`) | Should call `openFoldersModal('research')` and use `researchWorkspaceRoot` | **BROKEN** |
| `btn-manage-folders` (Local Docs sidebar) | Calls `openFoldersModal()` (defaults to 'local' scope, uses `state.localWorkspaceRootFilter`) | Correctly uses Local Docs workspace | **WORKING** |

### design.html/js

| Button ID | Current Behavior | Expected Behavior | Status |
|-----------|------------------|-------------------|--------|
| `btn-manage-folders-design` | Calls `openFoldersModal('design')`, uses `state.designWorkspaceRootFilter \| state.stitchWorkspaceRoot` | Correctly uses Design workspace | **WORKING** |
| `btn-manage-folders-html` | Calls `openFoldersModal('html')`, uses `state.htmlWorkspaceRootFilter \| state.stitchWorkspaceRoot` | Correctly uses HTML workspace | **WORKING** |
| `btn-manage-folders-images` | Calls `openFoldersModal('images')`, uses `state.imagesWorkspaceRootFilter \| state.stitchWorkspaceRoot` | Correctly uses Images workspace | **WORKING** |
| `btn-manage-folders-briefs` | Calls `openFoldersModal('briefs')`, uses `state.briefsWorkspaceRootFilter \| state.stitchWorkspaceRoot` | Correctly uses Briefs workspace | **WORKING** |

**Conclusion:** Only the research tab button in planning.js is broken. All design.html buttons work correctly because they pass scope parameters and the `renderFolderListModal` function in design.js correctly maps each scope to its corresponding workspace filter.

## Implementation Plan

### Step 1: Update `openFoldersModal` function in planning.js

**File:** `src/webview/planning.js`

**Location:** Line 4903

**Change:** Add support for 'research' scope parameter

```javascript
// Before:
function openFoldersModal(scope = 'local') {
    folderModalScope = scope;
    const modal = document.getElementById('folder-modal');
    const modalTitle = document.getElementById('folder-modal-title');
    if (modalTitle) {
        modalTitle.textContent = scope === 'tickets' ? 'Manage Tickets Folders' : 'Manage Local Docs Folders';
    }
    // ... rest of function
}

// After:
function openFoldersModal(scope = 'local') {
    folderModalScope = scope;
    const modal = document.getElementById('folder-modal');
    const modalTitle = document.getElementById('folder-modal-title');
    if (modalTitle) {
        if (scope === 'tickets') {
            modalTitle.textContent = 'Manage Tickets Folders';
        } else if (scope === 'research') {
            modalTitle.textContent = 'Manage Research Folders';
        } else {
            modalTitle.textContent = 'Manage Local Docs Folders';
        }
    }
    // ... rest of function
}
```

### Step 2: Update `renderFolderListModal` function in planning.js

**File:** `src/webview/planning.js`

**Location:** Line 1090

**Change:** Add logic to handle 'research' scope with correct workspace filter

```javascript
// Before:
function renderFolderListModal() {
    const folderListModal = document.getElementById('folder-list-modal');
    if (!folderListModal) return;
    folderListModal.innerHTML = '';

    let folderPaths = [];
    if (folderModalScope === 'tickets') {
        folderPaths = getCurrentFolderPaths(state.ticketsFolderPathsByRoot || {}, state.localWorkspaceRootFilter);
    } else {
        folderPaths = getCurrentFolderPaths(state.localFolderPathsByRoot, state.localWorkspaceRootFilter);
    }
    // ... rest of function
}

// After:
function renderFolderListModal() {
    const folderListModal = document.getElementById('folder-list-modal');
    if (!folderListModal) return;
    folderListModal.innerHTML = '';

    let folderPaths = [];
    if (folderModalScope === 'tickets') {
        folderPaths = getCurrentFolderPaths(state.ticketsFolderPathsByRoot || {}, state.localWorkspaceRootFilter);
    } else if (folderModalScope === 'research') {
        folderPaths = getCurrentFolderPaths(state.localFolderPathsByRoot, researchWorkspaceRoot);
    } else {
        folderPaths = getCurrentFolderPaths(state.localFolderPathsByRoot, state.localWorkspaceRootFilter);
    }
    // ... rest of function
}
```

### Step 3: Update the remove button handler in `renderFolderListModal`

**File:** `src/webview/planning.js`

**Location:** Line 1122-1128

**Change:** Use correct workspace root for 'research' scope when removing folders

```javascript
// Before:
removeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (folderModalScope === 'tickets') {
        vscode.postMessage({ type: 'removeTicketsFolder', folderPath: path, workspaceRoot: state.localWorkspaceRootFilter || _workspaceItems[0]?.workspaceRoot || '' });
    } else {
        vscode.postMessage({ type: 'removeLocalFolder', folderPath: path, workspaceRoot: state.localWorkspaceRootFilter || _workspaceItems[0]?.workspaceRoot || '' });
    }
});

// After:
removeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    let workspaceRoot;
    if (folderModalScope === 'tickets') {
        workspaceRoot = state.localWorkspaceRootFilter || _workspaceItems[0]?.workspaceRoot || '';
        vscode.postMessage({ type: 'removeTicketsFolder', folderPath: path, workspaceRoot });
    } else if (folderModalScope === 'research') {
        workspaceRoot = researchWorkspaceRoot || _workspaceItems[0]?.workspaceRoot || '';
        vscode.postMessage({ type: 'removeLocalFolder', folderPath: path, workspaceRoot });
    } else {
        workspaceRoot = state.localWorkspaceRootFilter || _workspaceItems[0]?.workspaceRoot || '';
        vscode.postMessage({ type: 'removeLocalFolder', folderPath: path, workspaceRoot });
    }
});
```

### Step 4: Update the add folder button handler

**File:** `src/webview/planning.js`

**Location:** Line 4965-4971

**Change:** Use correct workspace root for 'research' scope when adding folders

```javascript
// Before:
document.getElementById('btn-add-folder-modal').addEventListener('click', () => {
    if (folderModalScope === 'tickets') {
        vscode.postMessage({ type: 'addTicketsFolder', workspaceRoot: state.localWorkspaceRootFilter || _workspaceItems[0]?.workspaceRoot || '' });
    } else {
        vscode.postMessage({ type: 'addLocalFolder', workspaceRoot: state.localWorkspaceRootFilter || _workspaceItems[0]?.workspaceRoot || '' });
    }
});

// After:
document.getElementById('btn-add-folder-modal').addEventListener('click', () => {
    let workspaceRoot;
    if (folderModalScope === 'tickets') {
        workspaceRoot = state.localWorkspaceRootFilter || _workspaceItems[0]?.workspaceRoot || '';
        vscode.postMessage({ type: 'addTicketsFolder', workspaceRoot });
    } else if (folderModalScope === 'research') {
        workspaceRoot = researchWorkspaceRoot || _workspaceItems[0]?.workspaceRoot || '';
        vscode.postMessage({ type: 'addLocalFolder', workspaceRoot });
    } else {
        workspaceRoot = state.localWorkspaceRootFilter || _workspaceItems[0]?.workspaceRoot || '';
        vscode.postMessage({ type: 'addLocalFolder', workspaceRoot });
    }
});
```

### Step 5: Update the research tab button click handler

**File:** `src/webview/planning.js`

**Location:** Line 618-621

**Change:** Pass 'research' scope parameter

```javascript
// Before:
const manageResearchFoldersBtn = document.getElementById('btn-manage-research-folders');
if (manageResearchFoldersBtn) {
    manageResearchFoldersBtn.addEventListener('click', openFoldersModal);
}

// After:
const manageResearchFoldersBtn = document.getElementById('btn-manage-research-folders');
if (manageResearchFoldersBtn) {
    manageResearchFoldersBtn.addEventListener('click', () => openFoldersModal('research'));
}
```

## Testing Checklist

- [ ] Open planning.html and switch to the Research tab
- [ ] Select a workspace in the research workspace filter
- [ ] Click "Manage Folders" button
- [ ] Verify the modal title says "Manage Research Folders"
- [ ] Verify the folder list shows folders for the selected research workspace (not the Local Docs workspace)
- [ ] Add a new folder and verify it's added to the correct workspace
- [ ] Remove a folder and verify it's removed from the correct workspace
- [ ] Switch to a different workspace in the research filter
- [ ] Verify the modal shows folders for the new workspace
- [ ] Verify the Local Docs tab still works correctly (regression test)
- [ ] Verify the Tickets tab still works correctly (regression test)

## Edge Cases

- **Empty researchWorkspaceRoot:** The code falls back to `_workspaceItems[0]?.workspaceRoot || ''` when the research workspace root is empty, matching the existing pattern for other scopes.
- **No folders configured:** The existing empty state message ("No folders configured. Click Add Folder to get started.") will display correctly.
- **Workspace not in list:** If the saved `researchWorkspaceRoot` is no longer in the workspace list, the fallback to the first workspace ensures the modal still opens.

## Risks

- **Low risk:** The changes are localized to the research tab's folder management logic and don't affect other tabs.
- **Regression risk:** Minimal - the existing 'local' and 'tickets' scopes are unchanged, only a new 'research' scope is added.
- **Fallback behavior:** The fallback to `_workspaceItems[0]?.workspaceRoot` ensures the modal doesn't break if the workspace state is inconsistent.

## Files Changed

- `src/webview/planning.js` (5 function updates)

## Recommendation

Send to Intern

## Review Findings

**Reviewer-executor pass completed.** All 5 planned changes verified in `src/webview/planning.js`: button handler passes `'research'` scope, modal title resolves correctly, `renderFolderListModal` uses `researchWorkspaceRoot`, and add/remove handlers post the correct workspace root. One additional fix applied: `folderModalScope` was an implicit global (assigned without declaration); added `let folderModalScope = 'local';` at line 132. No regressions in local docs or tickets tab paths. Validation: not applicable (SKIP TESTS / SKIP COMPILATION per session directive). Remaining risk: `folderModalScope` close-over in dynamically created remove-button listeners is correct but worth noting for future refactors.
