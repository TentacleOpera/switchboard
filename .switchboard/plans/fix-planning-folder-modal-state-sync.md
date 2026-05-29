# Fix Planning Folder Modal State Sync Bug

## Goal

Fix a race condition in `planning.html` where the Folders modal shows "No folders configured" even when folders have been saved, caused by the modal rendering against an empty `state.localFolderPaths` before the first `localDocsReady` message arrives from the backend.

## Metadata

- **Tags:** frontend, bugfix, reliability
- **Complexity:** 3

## User Review Required

No breaking changes. Pure frontend defensive fix — adds a backend refresh call to the modal-open handler so the folder list is always authoritative when the modal is visible.

## Complexity Audit

### Routine
- Single-file change to one event listener in `planning.js`
- Reuses existing `refreshSource` message pattern (already used in the refresh button at line 2853)
- Backend already handles `refreshSource` → `_sendLocalDocsReady()` → `localDocsReady` → `renderFolderListModal()` chain correctly

### Complex / Risky
- None — the async re-render is safe even if the modal is closed before the response arrives (renderFolderListModal is a no-op if the modal DOM is not visible)

## Edge-Case & Dependency Audit

### Race Conditions
- **Startup race (primary bug)**: Panel loads → `state.localFolderPaths = []` (line 21) → user clicks "Folders" before the first `localDocsReady` message arrives → `renderFolderListModal()` sees empty array.
- **Double-render (benign)**: After the fix, the modal-open handler calls `renderFolderListModal()` synchronously (fast-path from warmed state), then the async `localDocsReady` response triggers a second `renderFolderListModal()`. Second call overwrites the first correctly. No visual glitch because DOM write is synchronous.
- **Modal-closed-before-response (benign)**: If the user closes the modal before the `localDocsReady` response arrives, `renderFolderListModal()` still runs — it writes to the `folder-list-modal` DOM element which exists regardless of visibility. Harmless.

### Security
- None — no new inputs or trust boundaries introduced.

### Side Effects
- The additional `refreshSource` call on modal open will trigger a full `_sendLocalDocsReady()` on the backend (re-scans local folder). This is the same action as the existing manual Refresh button. Acceptable for a user-initiated interaction.

### Dependencies & Conflicts
- Depends on `refreshSource` → `_sendLocalDocsReady()` chain working correctly (already confirmed in `PlanningPanelProvider.ts` lines 725–735).
- `handleLocalDocsReady()` (line 965–985) already calls `renderFolderListModal()` after updating `state.localFolderPaths`, so the async path is already wired correctly.

## Dependencies

- None from external sessions

## Adversarial Synthesis

The real root cause is a startup timing race — `state.localFolderPaths` initialises as `[]` and the modal can be opened before the first `localDocsReady` message arrives. The proposed fix (posting `refreshSource` on modal open) is correct and low-risk: the sync `renderFolderListModal()` call provides the fast-path for pre-warmed state, while the async backend re-fetch guarantees correctness even in the startup-race case. The only gap in the original plan is the missing startup-race test case in verification; this has been added below.

## Problem

In `planning.html`, the left sidebar in the "open docs" tab correctly shows local docs folders that have been selected, but the folders modal (opened via "Folders" button) displays "No folders configured. Click Add Folder to get started." even though folders are actually configured.

## Root Cause

The folder modal uses `renderFolderListModal()` which reads from `state.localFolderPaths`. However, there's a state synchronization issue:

1. `handleLocalDocsReady()` updates `state.localFolderPaths` from `msg.folderPaths` and calls `renderFolderListModal()`
2. `handleLocalFolderPathUpdated()` also updates `state.localFolderPaths` and calls `renderFolderListModal()`
3. When the modal is opened via "btn-manage-folders", it calls `renderFolderListModal()` which reads `state.localFolderPaths`

The issue is that `state.localFolderPaths` may be empty or stale when the modal opens, even though the sidebar shows folders (because `renderLocalDocs()` was called with the correct `folderPaths` from the message, not from `state.localFolderPaths`).

**Primary failure path — startup timing race:**
- `state.localFolderPaths` initialises as `[]` (line 21)
- Panel loads and sends `fetchRoots` — backend processes this asynchronously
- If the user clicks "Folders" before the first `localDocsReady` message arrives, the modal renders against the empty initial array

Looking at the code flow:
- `renderLocalDocs()` receives `folderPaths` as a parameter from the message
- `renderFolderListModal()` reads from `state.localFolderPaths`
- If `state.localFolderPaths` is not properly synced before the modal opens, the modal shows empty

## Solution

Ensure that when the folder modal is opened, it refreshes the folder list from the backend to guarantee the most up-to-date state, rather than relying solely on the potentially stale `state.localFolderPaths`.

### Changes Required

**File: `src/webview/planning.js`**

1. Modify the folder modal open handler (lines 2811–2820) to request a fresh folder list from the backend before rendering:

```javascript
// Folder modal open
document.getElementById('btn-manage-folders').addEventListener('click', () => {
    const modal = document.getElementById('folder-modal');
    modal.style.display = 'flex';
    // Sync antigravity toggle state from JS state
    const modalToggle = document.getElementById('antigravity-toggle-modal');
    modalToggle.checked = !!state.antigravityEnabled;
    // Render folder list from current state (fast-path for pre-warmed state)
    renderFolderListModal();
    // Request fresh folder list from backend to ensure sync (catches startup race)
    vscode.postMessage({ type: 'refreshSource', sourceId: 'local-folder' });
});
```

2. Ensure that when `localDocsReady` is received, it always updates both the sidebar and the modal folder list (this is already done in `handleLocalDocsReady` at line 984, but we should verify it's working correctly).

### Implementation Steps

1. Open `src/webview/planning.js`
2. Locate the `btn-manage-folders` click handler at line 2812
3. After the existing `renderFolderListModal()` call (line 2819), add:
   ```javascript
   vscode.postMessage({ type: 'refreshSource', sourceId: 'local-folder' });
   ```
4. Update the comment on line 2818 to reflect both the sync and async paths

### Verification Steps

1. **Startup race (primary case)**:
   - Close and reopen the Planning panel (or reload the VS Code window)
   - Immediately click the "Folders" button before the doc tree has finished loading
   - Verify the modal shows the configured folder(s) rather than "No folders configured"

2. **Normal case**:
   - Open planning.html in the "open docs" tab
   - Add a local docs folder
   - Verify the sidebar shows the folder
   - Click the "Folders" button to open the modal
   - Verify the modal now shows the configured folder instead of "No folders configured"

3. **Post-add consistency**:
   - With the modal open, click "Add Folder" and add a new folder
   - Verify the modal re-renders with the new folder included (this tests the async re-render path)

### Files Changed

- `src/webview/planning.js` — Modify folder modal open handler (line 2812–2819)

### Risk Assessment

Low risk — the change adds a backend refresh when opening the modal, which ensures the modal always shows the current state. This is a defensive programming approach that should eliminate the race condition. The `refreshSource` → `_sendLocalDocsReady()` → `localDocsReady` → `renderFolderListModal()` chain is already exercised by the existing Refresh button at line 2853.

---

**Send to Coder**
