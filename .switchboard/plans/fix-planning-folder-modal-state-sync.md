# Fix Planning Folder Modal State Sync Bug

## Problem
In `planning.html`, the left sidebar in the "open docs" tab correctly shows local docs folders that have been selected, but the folders modal (opened via "Folders" button) displays "No folders configured. Click Add Folder to get started." even though folders are actually configured.

## Root Cause
The folder modal uses `renderFolderListModal()` which reads from `state.localFolderPaths`. However, there's a state synchronization issue:

1. `handleLocalDocsReady()` updates `state.localFolderPaths` from `msg.folderPaths` and calls `renderFolderListModal()`
2. `handleLocalFolderPathUpdated()` also updates `state.localFolderPaths` and calls `renderFolderListModal()`
3. When the modal is opened via "btn-manage-folders", it calls `renderFolderListModal()` which reads `state.localFolderPaths`

The issue is that `state.localFolderPaths` may be empty or stale when the modal opens, even though the sidebar shows folders (because `renderLocalDocs()` was called with the correct `folderPaths` from the message, not from `state.localFolderPaths`).

Looking at the code flow:
- `renderLocalDocs()` receives `folderPaths` as a parameter from the message
- `renderFolderListModal()` reads from `state.localFolderPaths`
- If `state.localFolderPaths` is not properly synced before the modal opens, the modal shows empty

## Solution
Ensure that when the folder modal is opened, it refreshes the folder list from the backend to guarantee the most up-to-date state, rather than relying solely on the potentially stale `state.localFolderPaths`.

### Changes Required

**File: `src/webview/planning.js`**

1. Modify the folder modal open handler to request a fresh folder list from the backend before rendering:

```javascript
// Folder modal open
document.getElementById('btn-manage-folders').addEventListener('click', () => {
    const modal = document.getElementById('folder-modal');
    modal.style.display = 'flex';
    // Sync antigravity toggle state from JS state
    const modalToggle = document.getElementById('antigravity-toggle-modal');
    modalToggle.checked = !!state.antigravityEnabled;
    // Request fresh folder list from backend to ensure sync
    vscode.postMessage({ type: 'refreshSource', sourceId: 'local-folder' });
});
```

2. Ensure that when `localDocsReady` is received, it always updates both the sidebar and the modal folder list (this is already done in `handleLocalDocsReady` at line 984, but we should verify it's working correctly).

### Verification Steps
1. Open planning.html in the "open docs" tab
2. Add a local docs folder
3. Verify the sidebar shows the folder
4. Click the "Folders" button to open the modal
5. Verify the modal now shows the configured folder instead of "No folders configured"

### Files Changed
- `src/webview/planning.js` - Modify folder modal open handler

### Risk Assessment
Low risk - the change adds a backend refresh when opening the modal, which ensures the modal always shows the current state. This is a defensive programming approach that should eliminate the race condition.
