# Move Local Docs Folders to Modal

## Goal
Move the "Local Docs Folders" inline configuration section and the antigravity toggle from the local docs tab sidebar/controls strip into a dedicated modal dialog, decluttering the UI while preserving all existing functionality.

## Metadata
- **Tags:** [frontend, UI, UX]
- **Complexity:** 4

## User Review Required
- Confirm that removing the antigravity toggle from the controls strip and placing it inside the "Folders" modal is the desired UX. Users who frequently toggle antigravity may find the extra click inconvenient.
- Confirm the "Folders" button label and placement (right side of controls strip, where antigravity toggle currently sits).

## Complexity Audit

### Routine
- Removing the antigravity toggle + label from the controls strip HTML (lines 1514-1518)
- Adding a "Folders" button in its place
- Adding modal HTML structure before `</body>`
- Adding modal CSS before `</style>`
- Adding modal open/close/backdrop-click event handlers
- Adding Escape key handler for modal close
- Adding `renderFolderListModal()` function (mirrors existing `renderFolderList` pattern)
- Adding `e.stopPropagation()` on modal remove buttons (matching existing pattern)
- Updating `handleLocalFolderPathUpdated` to also refresh the modal list
- Updating `localFoldersListed` handler to also refresh the modal list

### Complex / Risky
- Antigravity toggle state sync: the original toggle element (`id="antigravity-toggle"`) is removed from the DOM, so the modal toggle must send `toggleAntigravityBrain` messages directly rather than proxying through the removed element. State must be read from the JS `state` object on modal open, not from a DOM element that no longer exists.
- `renderFolderList` orphaning: after removing the inline folder config, `renderFolderList()` targets `local-folders-list` which no longer exists. Both call sites (`handleLocalFolderPathUpdated` line 1362, `localFoldersListed` line 1797) must be updated to also call `renderFolderListModal()`, and the original function should be updated or deprecated.

## Edge-Case & Dependency Audit

- **Race Conditions:** If a folder is removed while the modal is open, `handleLocalFolderPathUpdated` re-renders the tree and calls `renderFolderListModal()`, which correctly updates the modal list. No race condition — the modal list is always refreshed from `state.localFolderPaths`.
- **Security:** No new user input is accepted. Folder paths come from the extension host via `vscode.postMessage`. No XSS risk.
- **Side Effects:** Removing the inline folder config from the tree pane changes the visual structure of the sidebar. The `docList` container (line 686-689) must still be created even after removing the config row, or document rendering will break.
- **Dependencies & Conflicts:** The `renderFolderList` function is called from two locations (line 692 inside `renderLocalDocs`, and lines 1362/1797 in message handlers). The call at line 692 is inside the `local-folder` branch that builds the inline config — this entire branch will be simplified. The calls at 1362 and 1797 must both be patched.

## Dependencies
- None — this is a self-contained UI refactor within the planning webview.

## Adversarial Synthesis
Key risks: (1) Antigravity toggle sync breaks if the modal proxies through the removed DOM element instead of sending messages directly — must use `vscode.postMessage` and read state from the JS state object. (2) `renderFolderList` is orphaned after removing inline config; both call sites must be patched to also update the modal list. Mitigations: Send `toggleAntigravityBrain` message directly from modal toggle; add `renderFolderListModal()` calls at all `renderFolderList` call sites; add Escape key handler and `stopPropagation` for consistency.

## Proposed Changes

### src/webview/planning.html — Controls Strip (lines 1505-1519)
- **Context:** The controls strip for the local docs tab contains an antigravity toggle switch and label at lines 1514-1518.
- **Logic:** Remove the `<label class="toggle-switch">` (lines 1514-1517) and the `<span class="toggle-label">` (line 1518). Replace with a "Folders" button.
- **Implementation:**
  - Delete lines 1514-1518 (antigravity toggle + label)
  - Insert in their place:
    ```html
    <button id="btn-manage-folders" class="strip-btn" style="margin-left: auto;">Folders</button>
    ```
  - The `margin-left: auto` pushes the button to the right, matching the current antigravity toggle positioning.

### src/webview/planning.html — Modal HTML (before `</body>`, before line 1769)
- **Context:** The `</body>` tag is at line 1770. The duplicate-modal CSS pattern (lines 1137-1165) establishes the project's modal style conventions.
- **Logic:** Add a persistent folder management modal with antigravity toggle and folder list.
- **Implementation:** Insert before `<script nonce=...>` (line 1769):
  ```html
  <div class="folder-modal" id="folder-modal" style="display: none;" role="dialog" aria-modal="true" aria-labelledby="folder-modal-title">
      <div class="modal-content">
          <div class="modal-header">
              <h3 id="folder-modal-title">Manage Local Docs Folders</h3>
              <button class="modal-close-btn" id="btn-close-folder-modal" aria-label="Close">&times;</button>
          </div>
          <div class="modal-body">
              <!-- Antigravity toggle section -->
              <div class="modal-section">
                  <div class="toggle-container" style="display: flex; align-items: center; gap: 10px;">
                      <label class="toggle-switch">
                          <input type="checkbox" id="antigravity-toggle-modal">
                          <span class="toggle-slider"></span>
                      </label>
                      <span class="toggle-label" style="font-size:11px; letter-spacing:0.5px; text-transform:uppercase; color:var(--text-secondary);">Show Antigravity Brain</span>
                  </div>
              </div>
              
              <!-- Folder list section -->
              <div class="modal-section">
                  <div class="section-header">
                      <span class="section-title">Configured Folders</span>
                      <div class="section-actions">
                          <button id="btn-refresh-folders-modal" class="strip-btn" title="Refresh folders">&#8635;</button>
                          <button id="btn-add-folder-modal" class="strip-btn">Add Folder</button>
                      </div>
                  </div>
                  <div id="folder-list-modal" class="folder-list">
                      <!-- Folder items rendered by JS -->
                  </div>
              </div>
          </div>
      </div>
  </div>
  ```

### src/webview/planning.html — Modal CSS (before `</style>`, before line 1484)
- **Context:** The `<style>` block ends at line 1484. The duplicate-modal CSS (lines 1137-1165) establishes conventions: `position: fixed`, `z-index: 1000`, `var(--panel-bg)`, `var(--border-color)`, `border-radius: 8px`.
- **Logic:** Add folder modal CSS following the established pattern.
- **Implementation:** Insert before line 1484 (`</style>`):
  ```css
  /* Folder Modal */
  .folder-modal {
      position: fixed;
      top: 0; left: 0; right: 0; bottom: 0;
      background: rgba(0, 0, 0, 0.6);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 1000;
  }
  .folder-modal .modal-content {
      background: var(--panel-bg);
      border: 1px solid var(--border-color);
      border-radius: 8px;
      max-width: 500px;
      width: 90%;
      max-height: 80vh;
      display: flex;
      flex-direction: column;
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
  }
  .folder-modal .modal-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 16px 20px;
      border-bottom: 1px solid var(--border-color);
  }
  .folder-modal .modal-header h3 {
      margin: 0;
      font-size: 14px;
      font-weight: 600;
      color: var(--text-primary);
      text-transform: uppercase;
      letter-spacing: 0.5px;
  }
  .folder-modal .modal-close-btn {
      background: transparent;
      border: none;
      color: var(--text-secondary);
      font-size: 24px;
      cursor: pointer;
      padding: 0;
      width: 32px;
      height: 32px;
      display: flex;
      align-items: center;
      justify-content: center;
      border-radius: 4px;
      transition: all 0.15s;
  }
  .folder-modal .modal-close-btn:hover {
      background: var(--card-bg-hover);
      color: var(--text-primary);
  }
  .folder-modal .modal-body {
      padding: 20px;
      overflow-y: auto;
      flex: 1;
  }
  .folder-modal .modal-section {
      margin-bottom: 20px;
  }
  .folder-modal .modal-section:last-child {
      margin-bottom: 0;
  }
  .folder-modal .section-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 12px;
  }
  .folder-modal .section-title {
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--text-secondary);
  }
  .folder-modal .section-actions {
      display: flex;
      gap: 8px;
  }
  ```

### src/webview/planning.js — Remove Inline Folder Config (lines 631-692)
- **Context:** The `renderLocalDocs` function builds the inline folder config section (lines 631-683) when `sourceId === 'local-folder'`. This includes the "Local Docs Folders" title, refresh/add buttons, and the `local-folders-list` container.
- **Logic:** Remove the inline folder config UI from the tree pane. The `docList` container must still be created for document rendering.
- **Implementation:**
  - Remove lines 631-683 (the entire `if (sourceId === 'local-folder')` config block)
  - Keep the `docList` creation (lines 685-689) but move it outside the `if` block so it always runs for `local-folder`
  - Remove the `renderFolderList(folderPaths || [])` call at line 692 (the modal handles its own rendering)
  - The restructured code should be:
    ```javascript
    // Create docList container for document rendering
    const docList = document.createElement('div');
    docList.className = 'source-doc-list';
    docList.dataset.sourceId = sourceId;
    treePane.appendChild(docList);
    ```

### src/webview/planning.js — Remove Antigravity Toggle Init (lines 2794-2799)
- **Context:** The initialization section at the bottom of the IIFE sets up the antigravity toggle event listener referencing `id="antigravity-toggle"`.
- **Logic:** Since the HTML toggle is removed, this init code will fail silently (`agToggle` will be `null`). It should be removed to avoid confusion.
- **Implementation:**
  - Remove lines 2794-2799:
    ```javascript
    const agToggle = document.getElementById('antigravity-toggle');
    if (agToggle) {
        agToggle.addEventListener('change', () => {
            vscode.postMessage({ type: 'toggleAntigravityBrain', enabled: agToggle.checked });
        });
    }
    ```
  - The antigravity toggle logic moves entirely to the modal toggle handler (see below).

### src/webview/planning.js — Add Modal Event Handlers (near initialization section, after line 2799)
- **Context:** Event listeners are set up in the initialization section at the bottom of the IIFE.
- **Logic:** Wire up the Folders button, modal close, backdrop click, Escape key, antigravity modal toggle, and folder management buttons.
- **Implementation:**
  ```javascript
  // Folder modal open
  document.getElementById('btn-manage-folders').addEventListener('click', () => {
      const modal = document.getElementById('folder-modal');
      modal.style.display = 'flex';
      // Sync antigravity toggle state from JS state (not from removed DOM element)
      const modalToggle = document.getElementById('antigravity-toggle-modal');
      // Read state from the same source that handleLocalDocsReady uses (line 990-991)
      // state.antigravityEnabled is set by handleLocalDocsReady
      modalToggle.checked = !!state.antigravityEnabled;
      // Render folder list in modal
      renderFolderListModal();
  });

  // Folder modal close (X button)
  document.getElementById('btn-close-folder-modal').addEventListener('click', () => {
      document.getElementById('folder-modal').style.display = 'none';
  });

  // Folder modal close (backdrop click)
  document.getElementById('folder-modal').addEventListener('click', (e) => {
      if (e.target.id === 'folder-modal') {
          e.target.style.display = 'none';
      }
  });

  // Folder modal close (Escape key)
  document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
          const modal = document.getElementById('folder-modal');
          if (modal && modal.style.display !== 'none') {
              modal.style.display = 'none';
          }
      }
  });

  // Antigravity toggle in modal — send message directly (do NOT proxy through removed DOM element)
  document.getElementById('antigravity-toggle-modal').addEventListener('change', (e) => {
      vscode.postMessage({ type: 'toggleAntigravityBrain', enabled: e.target.checked });
  });

  // Modal folder management buttons
  document.getElementById('btn-refresh-folders-modal').addEventListener('click', () => {
      vscode.postMessage({ type: 'refreshSource', sourceId: 'local-folder' });
  });

  document.getElementById('btn-add-folder-modal').addEventListener('click', () => {
      vscode.postMessage({ type: 'addLocalFolder' });
  });
  ```

### src/webview/planning.js — Add renderFolderListModal Function (near existing renderFolderList, after line 612)
- **Context:** `renderFolderList` (lines 578-612) renders into `local-folders-list`. A parallel function is needed for the modal's `folder-list-modal` container.
- **Logic:** Mirror `renderFolderList` but target the modal container. Include `e.stopPropagation()` on remove buttons (matching existing pattern at line 604).
- **Implementation:**
  ```javascript
  function renderFolderListModal() {
      const folderListModal = document.getElementById('folder-list-modal');
      if (!folderListModal) return;
      folderListModal.innerHTML = '';

      const folderPaths = state.localFolderPaths || [];

      if (folderPaths.length === 0) {
          const empty = document.createElement('div');
          empty.className = 'folder-list-empty';
          empty.textContent = 'No folders configured. Click Add Folder to get started.';
          folderListModal.appendChild(empty);
          return;
      }

      folderPaths.forEach(path => {
          const row = document.createElement('div');
          row.className = 'folder-list-item';

          const pathSpan = document.createElement('span');
          pathSpan.className = 'folder-path';
          pathSpan.textContent = path;
          pathSpan.title = path;

          const removeBtn = document.createElement('button');
          removeBtn.className = 'folder-list-remove-btn';
          removeBtn.textContent = 'Remove';
          removeBtn.addEventListener('click', (e) => {
              e.stopPropagation();
              vscode.postMessage({ type: 'removeLocalFolder', folderPath: path });
          });

          row.appendChild(pathSpan);
          row.appendChild(removeBtn);
          folderListModal.appendChild(row);
      });
  }
  ```

### src/webview/planning.js — Update handleLocalFolderPathUpdated (line 1362)
- **Context:** `handleLocalFolderPathUpdated` (lines 1355-1370) calls `renderFolderList(state.localFolderPaths)` at line 1362. After removing the inline folder config, this call silently does nothing (target element gone).
- **Logic:** Add `renderFolderListModal()` call so the modal list stays in sync when folders are added/removed.
- **Implementation:** After line 1362, add:
  ```javascript
  renderFolderListModal();
  ```

### src/webview/planning.js — Update localFoldersListed Handler (line 1797)
- **Context:** The `localFoldersListed` message handler (lines 1795-1798) calls `renderFolderList(state.localFolderPaths)` at line 1797. Same orphaning issue as above.
- **Logic:** Add `renderFolderListModal()` call.
- **Implementation:** After line 1797, add:
  ```javascript
  renderFolderListModal();
  ```

### src/webview/planning.js — Update Antigravity State Sync (line 990-991)
- **Context:** `handleLocalDocsReady` syncs the antigravity toggle state at lines 990-991 by setting `agToggle.checked`. After removing the HTML toggle, this code references a non-existent element.
- **Logic:** Store the antigravity enabled state in the `state` object so the modal can read it on open. Also update the modal toggle if the modal is currently visible.
- **Implementation:** Replace lines 990-991 with:
  ```javascript
  state.antigravityEnabled = msg.antigravityEnabled || false;
  const agToggleModal = document.getElementById('antigravity-toggle-modal');
  if (agToggleModal) { agToggleModal.checked = state.antigravityEnabled; }
  ```
  - **Clarification:** This is not a new requirement — it's the necessary adaptation of the existing sync logic to the new modal-based toggle. The `state.antigravityEnabled` property is used by the modal open handler to set the initial toggle state.

### src/webview/planning.js — Deprecate renderFolderList (lines 578-612)
- **Context:** After removing the inline folder config, `renderFolderList` targets `local-folders-list` which no longer exists. It's called from `renderLocalDocs` (line 692, which is being removed) and from the two patched message handlers.
- **Logic:** The function body can remain (it safely returns early when the element is not found), but all active call sites now also call `renderFolderListModal()`. The function is effectively dead code.
- **Implementation:** Add a deprecation comment at line 578:
  ```javascript
  // DEPRECATED: Inline folder list removed; use renderFolderListModal() instead.
  // Kept for safety — returns early if target element not found.
  function renderFolderList(paths) {
  ```
  - **Clarification:** The function is not deleted to minimize risk. It safely no-ops when `local-folders-list` doesn't exist. It can be removed in a follow-up cleanup.

## Verification Plan

### Automated Tests
- No automated tests applicable — this is a webview UI change with no test infrastructure for the planning panel webview.

### Manual Verification Steps
1. Open the planning panel and navigate to the Local Docs tab
2. Verify the "Folders" button appears in the controls strip (right side, where antigravity toggle was)
3. Verify the antigravity toggle and "Antigravity" label no longer appear in the controls strip
4. Click the "Folders" button and verify the modal opens centered over the panel
5. Verify the modal contains:
   - "Show Antigravity Brain" toggle (synced with current antigravity state)
   - "Configured Folders" section with refresh/add buttons
   - List of configured folders with "Remove" buttons
6. Toggle the antigravity switch in the modal — verify antigravity sessions appear/disappear in the tree
7. Close and reopen the modal — verify the toggle state persists correctly
8. Click "Add Folder" in the modal — verify the folder picker appears and the folder is added to the modal list
9. Click "Remove" on a folder in the modal — verify it's removed from the list
10. Verify the tree pane no longer shows the "Local Docs Folders" section
11. Verify the modal closes when clicking the X button
12. Verify the modal closes when clicking the backdrop (outside the modal content)
13. Verify the modal closes when pressing Escape
14. Verify documents still render correctly in the tree pane (the `docList` container is intact)

## Files Changed

- `src/webview/planning.html` — Remove antigravity toggle from controls strip, add "Folders" button, add modal HTML and CSS
- `src/webview/planning.js` — Remove inline folder UI, remove old antigravity toggle init, add modal event handlers, add modal rendering function, update folder list sync at both call sites, update antigravity state sync

## Recommendation
Complexity 4 → **Send to Coder**

---

## Review Results (Post-Implementation Audit)

### Reviewer: Grumpy Principal Engineer pass
### Date: 2026-05-28

### Findings

| # | Severity | Description | Status |
|---|----------|-------------|--------|
| 1 | MAJOR | Escape key handler fires on all keydowns, including when focus is in textarea/input/select — causes unexpected modal closes while editing | **Fixed** |
| 2 | MAJOR | `.folder-list` CSS has `max-height: 120px` (designed for inline sidebar), creating nested scroll in the modal's spacious 80vh body | **Fixed** |
| 3 | NIT | `renderFolderList()` is dead code (target element removed, always returns early) | Deferred — plan explicitly chose to keep for safety |
| 4 | NIT | `toggle-container` uses inline style instead of CSS class | Deferred — functional, cosmetic |
| 5 | NIT | `toggle-label` inline style overrides in modal differ from CSS class defaults | Deferred — functional, cosmetic |
| 6 | — | Antigravity toggle state sync (initially suspected) | Withdrawn — verified correct |
| 7 | MAJOR | `handleLocalDocsReady` missing `renderFolderListModal()` call — modal folder list goes stale when refresh triggers `localDocsReady` instead of `localFoldersListed` | **Fixed** |

### Code Fixes Applied

1. **`src/webview/planning.js` line ~2831** — Added input element guard to Escape key handler:
   ```javascript
   const tag = e.target.tagName.toLowerCase();
   if (tag === 'textarea' || tag === 'input' || tag === 'select') return;
   ```

2. **`src/webview/planning.html` line ~1588** — Added CSS override for modal folder list:
   ```css
   .folder-modal .folder-list {
       max-height: none;
   }
   ```

3. **`src/webview/planning.js` line ~979** — Added `renderFolderListModal()` call to `handleLocalDocsReady`:
   ```javascript
   // Keep modal folder list in sync when docs are refreshed
   renderFolderListModal();
   ```

### Validation Results

- **JS syntax check**: `node -c planning.js` → PASS (exit code 0)
- **HTML structure**: div opens/closes balanced (94/94), style tags balanced (2/2)
- **Feature presence**: Folders button ✓, Modal HTML ✓, Modal antigravity toggle ✓, Old antigravity toggle removed ✓, Old agToggle init removed ✓, `state.antigravityEnabled` used ✓
- **`renderFolderListModal()` call sites**: 4 active calls confirmed (modal open, handleLocalDocsReady, handleLocalFolderPathUpdated, localFoldersListed)
- **Compilation**: Skipped per review instructions
- **Automated tests**: Skipped per review instructions

### Remaining Risks

1. **Dead code accumulation**: `renderFolderList()` (lines 580-614) is a no-op that should be removed in a follow-up cleanup. It safely returns early but adds cognitive noise.
2. **Inline styles in modal HTML**: The `toggle-container` and `toggle-label` inline styles work but should be extracted to CSS classes in a future polish pass for maintainability.
3. **No automated test coverage**: This is a webview UI change with no test infrastructure. All verification is manual. The manual verification steps in the plan remain the authoritative checklist.
