# Local Docs Tab UX Fixes

## Goal
Fix specific UX issues in the Local Docs tab to improve clarity and consistency.

## Problem Analysis
The Local Docs tab has several UX issues that confuse users and create inconsistent behavior:
1. Import button appears on local-folder doc cards when it shouldn't - local docs are already in the filesystem
2. "Sync to Online" and "Export to Source" buttons are confusing - they do the same thing (push to external) but with different UX flows
3. Folder names in sidebar are ambiguous when multiple "docs" folders exist - no indication of which folder is which
4. Status message constantly shows "loading..." in top right, providing no helpful information
5. Buttons at folder subheader levels are not right-justified (link, + should be next to import)
6. Subfolder header buttons are teal instead of grey, inconsistent with subfolder header styling
7. No import button exists for subfolders, only for top-level source folders

## Metadata
**Tags:** ui, ux, frontend
**Complexity:** 4

## User Review Required
- Should the relative path display show the full path or workspace-relative path?
- Confirm: remove "Export to Source" entirely, or keep it hidden for future use? (Plan recommends full removal.)

## Complexity Audit

### Routine
- Remove Import button from local doc card actions array (`planning.js:926-927`)
- Remove hidden "Export to Source" button from HTML (`planning.html:2922`)
- Hide `#status` span and remove static `"Loading..."` assignment (`planning.html:2928`, `planning.js:1006`)
- Add import button to subfolder headers (copy existing top-level pattern at `planning.js:1278-1303`)
- Scope subfolder button colors to grey via descendant CSS selectors

### Complex / Risky
- Restructure source-folder header layout to add a second-line relative path without breaking `justify-content: space-between` alignment of right-side buttons (`planning.js:1241-1250`)
- Consolidate sync logic so Sync-to-Online fast-path (via `syncConfigReady` at `planning.js:2720-2751`) becomes the only sync path, and all `btnExportToSource` JS references are fully removed to avoid dead code

## Edge-Case & Dependency Audit
- **Race Conditions**: `statusEl` is used for transient error/success messages across import, save, sync, and external-change flows. Removing the element or the `"Loading..."` assignment must not break these transients.
- **Security**: None.
- **Side Effects**: `btnExportToSource` listeners and state references (`dataset.slugPrefix` at `planning.js:2376`, visibility logic at `planning.js:989-1004`, click listener at `planning.js:3636-3642`) must be fully removed to avoid orphaned code referencing a removed DOM node.
- **Dependencies & Conflicts**: None.

## Dependencies
- None

## Adversarial Synthesis
Key risks: source-header flex layout may break when adding a block-level path element; removing `btnExportToSource` without cleaning its JS references leaves dead code; transient `statusEl` usage elsewhere may break if the element is deleted rather than hidden. Mitigations: add the path element inside a wrapped column-flex container inside the header row, grep and remove all `btnExportToSource` references, hide rather than delete `#status` to preserve transient message paths, and perform visual regression checks after CSS changes.

## Proposed Changes

### `/Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/planning.js`

#### Remove Import from local doc cards
- **Context**: `renderNode` constructs action arrays for document cards.
- **Logic**: For `sourceId === 'local-folder'`, the actions array currently includes `'Import'`. Local docs are already on disk; importing is nonsensical.
- **Implementation**: At line 927, change `actions = ['Import', 'Link Doc', 'Delete'];` to `actions = ['Link Doc', 'Delete'];`.
- **Edge Cases**: `renderDocCard` supports variable action counts, so layout remains safe.

#### Add relative path display to source-folder headers
- **Context**: Source-folder headers show only the basename (e.g., `docs`), which is ambiguous when multiple folders share the same name.
- **Logic**: The header (`sourceHeader`) is a flex row (`display: flex; justify-content: space-between; align-items: center;`). To add a second line below the folder name without pushing buttons to a new row, wrap the label and path in an inner flex-column container.
- **Implementation** (around line 1248-1250):
  - Replace `labelSpan.textContent = folderName; sourceHeader.appendChild(labelSpan);` with:
    ```js
    const labelWrapper = document.createElement('div');
    labelWrapper.style.cssText = 'display: flex; flex-direction: column; gap: 2px;';
    labelSpan.textContent = folderName;
    labelWrapper.appendChild(labelSpan);
    const pathSpan = document.createElement('span');
    pathSpan.className = 'source-folder-path';
    pathSpan.style.cssText = 'font-size: 10px; color: var(--text-secondary); font-weight: 400; text-transform: none; letter-spacing: 0;';
    pathSpan.textContent = sourceFolder; // or a workspace-relative derivation if available
    labelWrapper.appendChild(pathSpan);
    sourceHeader.appendChild(labelWrapper);
    ```
- **Edge Cases**: Long paths must truncate with `overflow: hidden; text-overflow: ellipsis; white-space: nowrap;` on `pathSpan`.

#### Right-justify subheader buttons
- **Context**: `.folder-subheader` elements (subfolder headers) do not set `display: flex`, so appended buttons sit inline next to the label.
- **Logic**: Apply flex layout so buttons push to the right.
- **Implementation**: Add CSS in `planning.html` (see below) or set `subheader.style.display = 'flex'; subheader.style.justifyContent = 'space-between'; subheader.style.alignItems = 'center';` at the subheader creation site (around line 1331).
- **Edge Cases**: Ensure the existing `.tree-node.folder-subheader` reset rules do not override display.

#### Add import button to subfolders
- **Context**: Top-level source headers have an import button (`folder-import-btn`). Subfolder headers (`folder-subheader`) do not.
- **Logic**: Mirror the top-level import block for each subfolder.
- **Implementation** (after `subCreateBtn` append, around line 1361):
  ```js
  const subImportBtn = document.createElement('button');
  subImportBtn.className = 'folder-import-btn';
  subImportBtn.textContent = 'Import';
  subImportBtn.title = `Import document from clipboard into ${folder.name}`;
  subImportBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      document.querySelectorAll('.folder-import-btn').forEach(btn => {
          btn.disabled = true;
          btn.textContent = '...';
      });
      const statusEl = document.getElementById('status');
      if (statusEl) {
          statusEl.style.color = '';
          statusEl.textContent = 'Importing from clipboard...';
      }
      vscode.postMessage({
          type: 'importResearchDoc',
          folderPath: folder.id
      });
  });
  subheader.appendChild(subImportBtn);
  ```
- **Edge Cases**: `folder.id` is the relative folder path derived from doc grouping; the backend `importResearchDoc` handler already resolves folder paths.

#### Remove Export to Source logic
- **Context**: The hidden `btn-export-to-source` at `planning.html:2922` and its JS logic duplicate the Sync-to-Online flow.
- **Logic**: Delete the button from HTML, then strip all JS references.
- **Implementation**:
  1. Remove `<button id="btn-export-to-source" ...>` from `planning.html:2922`.
  2. Remove `const btnExportToSource = document.getElementById('btn-export-to-source');` declaration (around `planning.js:716`).
  3. Remove visibility logic block `planning.js:989-1004`.
  4. Remove `btnExportToSource.dataset.slugPrefix === slugPrefix` check at `planning.js:2376`.
  5. Remove the `btnExportToSource.addEventListener('click', ...)` block at `planning.js:3636-3642`.
- **Edge Cases**: Confirm no other file references `btn-export-to-source` or `btnExportToSource`.

#### Remove static Loading... status assignment
- **Context**: `#status` is used for transient messages, but `loadDocumentPreview` unconditionally sets `"Loading..."`, which lingers and provides no value.
- **Logic**: Hide the span in HTML and delete the static assignment; leave transient error/success writes intact.
- **Implementation**:
  1. In `planning.html:2928`, add `style="display: none;"` to `<span id="status" ...>`.
  2. In `planning.js:1006`, remove `statusEl.textContent = 'Loading...';`.
- **Edge Cases**: Other status consumers (import, save, external-change warnings) continue to write to a hidden span harmlessly. If future work wants visible status, unhide the span.

### `/Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/planning.html`

#### Remove Export to Source button
- **Implementation**: Delete line 2922:
  ```html
  <button id="btn-export-to-source" class="strip-btn" disabled style="display: none;">Export to Source</button>
  ```

#### Hide status span
- **Implementation**: At line 2928, change to:
  ```html
  <span id="status" style="margin-left: 0; display: none;"></span>
  ```

#### Subfolder button colors and flex layout
- **Context**: `.folder-link-btn`, `.folder-create-btn`, and `.folder-import-btn` are globally teal. Subfolder headers need grey buttons.
- **Logic**: Add scoped descendant rules and flex layout for `.folder-subheader`.
- **Implementation** (append near existing `.folder-subheader` rules, around line 631):
  ```css
  .folder-subheader {
      display: flex;
      justify-content: space-between;
      align-items: center;
  }
  .folder-subheader .folder-link-btn,
  .folder-subheader .folder-create-btn,
  .folder-subheader .folder-import-btn {
      color: var(--text-secondary);
      border-color: var(--border-color);
  }
  .folder-subheader .folder-link-btn:hover,
  .folder-subheader .folder-create-btn:hover,
  .folder-subheader .folder-import-btn:hover {
      background: color-mix(in srgb, var(--text-secondary) 10%, transparent);
      border-color: var(--text-secondary);
  }
  ```
- **Edge Cases**: Verify `.tree-node.folder-subheader` background/border resets do not fight the new flex display.

#### Source header path truncation
- **Implementation**: Add a helper CSS class:
  ```css
  .source-folder-path {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      max-width: 200px;
  }
  ```

## Files Changed
- `/Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/planning.html`
- `/Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/planning.js`

## Verification Plan

### Automated Tests
- None required for this session. The user will run the test suite separately.

### Manual Verification
1. Open the Local Docs tab.
2. Select a local doc — confirm the card shows only **Link Doc** and **Delete** (no Import).
3. Select a doc that was previously imported from ClickUp/Linear/Notion — confirm **Sync to Online** is enabled and clicking it shows the fast-path "Update existing?" step.
4. Select a purely local doc — confirm **Sync to Online** opens the source-selection modal.
5. Inspect source-folder headers — confirm each shows the folder basename with a smaller grey path line beneath it.
6. Inspect subfolder headers — confirm buttons are right-justified and colored grey (not teal).
7. Click **Import** on a subfolder header — confirm the import flow triggers with the correct subfolder path.
8. Verify no "Loading..." text appears in the top-right status area.
9. Regression: link, delete, edit, save, and create-new-document flows continue to work.

## Risks
- **Sync logic complexity**: Consolidating sync buttons requires careful handling of the context-aware logic.
- **CSS specificity**: Changing button colors may affect other elements if not scoped correctly.
- **Folder path display**: Adding relative paths may clutter the UI if not styled carefully.

## Recommendation
Send to Coder
