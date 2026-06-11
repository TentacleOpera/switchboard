# Plan: Separate Images Tab in Design Panel

## Goal
Move all image showing/previewing functionality from the "HTML PREVIEWS" tab into a new "IMAGES" tab in `design.html`. The "HTML PREVIEWS" tab should only detect and show HTML files.

## Background
Currently, the "HTML PREVIEWS" tab scans configured folders for both HTML files and image files, rendering them together in the sidebar and showing them in either an iframe or a zoomable image viewport. To improve organization and focus, we need to separate HTML page previews from static image previews by introducing a dedicated "IMAGES" tab.

## Root Cause Analysis
- **Combined listing:** The webview currently renders all detected HTML and image files in the single HTML Previews tab under the same `html-folder` source tree.
- **Unified viewports:** The HTML Previews tab contains both the HTML iframe element and the image preview viewport element.

## Metadata
- **Tags:** frontend, ui, ux, refactor
- **Complexity:** 4

## User Review Required
No

## Complexity Audit

### Routine
- Add an "IMAGES" tab button in the top tab bar in `src/webview/design.html`.
- Add a new `#images-content` tab container in `src/webview/design.html` with its own controls, sidebar list, search box, and zoomable image preview container.
- Replicate CSS selectors for `#images-content`, `#tree-pane-images`, `#preview-pane-images`, and `#image-preview-container-images .zoomable-viewport` alongside existing HTML and Design tab rules.
- Add zoom/pan configuration for `images` in `src/webview/design.js` and initialize zoom listeners for `#image-preview-container-images`.
- Separate document filtering inside `design.js`: the HTML Previews tab will only render `.html`/`.htm` files, and the new IMAGES tab will only render image files.
- Handle `images-folder` messages for tree rendering and previewing in `design.js`.
- Bind workspace filter, search input, and sidebar toggle event listeners for the Images tab.

### Complex / Risky
- `toggleSidebarCollapsed` currently hardcodes only `#tree-pane-design` and `#tree-pane-html`; extending it to `#tree-pane-images` requires a third branch and a new state key (`imagesPreviewCollapsed`) with corresponding `saveState` persistence.
- `previewError` handler maps unknown `sourceId` values to `status-html` by default; adding an explicit `images-folder` branch prevents error messages from leaking into the HTML tab.

## Edge-Case & Dependency Audit
- **Workspace Filtering / Searching:** Since the two tabs are separate, each needs its own active filters and search states. Add separate state variables: `imagesWorkspaceRootFilter`, `imagesDocsSearch`, and `_lastImagesDocsMsg` in `design.js`. The shared `htmlDocsReady` message is reused; each tab filters the same node list independently by root and search string.
- **Watcher updates:** The backend watches configured folders and broadcasts `htmlDocsReady`. The webview must update both the HTML tree pane and the Images tree pane on every `htmlDocsReady` event.
- **State Persistence:** `imagesPreviewCollapsed` must be added to the `state` object, initialized from `persistedState`, and saved via `saveState()` so the Images sidebar remembers its collapse state across reloads.
- **Error Routing:** The `previewError` message handler uses a ternary `msg.sourceId === 'design-folder' ? 'status-design' : 'status-html'`. Sending `sourceId: 'images-folder'` in `fetchPreview` will cause errors to update `status-html` unless an explicit `images-folder` branch is added.
- **SVG Categorization:** `.svg` files are images; they should appear in the IMAGES tab. The HTML tab filter strictly limits to `.html`/`.htm`, so SVGs will naturally migrate. This is consistent with the goal but should be verified during manual testing.
- **CSS Coverage:** The new `#images-content`, `#tree-pane-images`, `#preview-pane-images`, and `#image-preview-container-images .zoomable-viewport` selectors must be added to every existing CSS group that already lists HTML/Design equivalents (active display, cyber glass, collapse padding, zoom viewport sizing).

## Dependencies
- None external. This change is fully contained within the webview front-end (`design.html`, `design.js`). The backend `DesignPanelProvider` already echoes any `sourceId` in `fetchPreview`/`previewError` and uses `sourceFolder` + `docId` for file resolution, so no backend changes are required.

## Adversarial Synthesis
Key risks: (1) `toggleSidebarCollapsed` and `saveState` omitting the new `imagesPreviewCollapsed` key will cause state corruption and inconsistent sidebar behavior; (2) incomplete CSS replication for `#images-content`, `#tree-pane-images`, and `#preview-pane-images` will produce visual regressions under the cyber theme; (3) `previewError` leaking into `status-html` will confuse users when image previews fail. Mitigations: explicitly extend the toggle/state helpers, enumerate every CSS selector group that references HTML/Design equivalents, and add a dedicated `images-folder` branch in the error handler.

## Proposed Changes

### `src/webview/design.html`

#### 1. Add Tab Button (~line 3337)
Add the `IMAGES` tab button to the tab bar:
```html
    <div id="research-tab-bar" class="research-tab-bar">
        <button class="research-tab-btn active" data-tab="stitch">STITCH</button>
        <button class="research-tab-btn" data-tab="html-preview">HTML PREVIEWS</button>
        <button class="research-tab-btn" data-tab="images">IMAGES</button>
        <button class="research-tab-btn" data-tab="design">DESIGN SYSTEM</button>
```

#### 2. Add CSS Selector Rules
Replicate the following selectors in every CSS rule group that already lists HTML or Design equivalents:

- **Active tab display (~line 178):** Add `#images-content` and `#images-content.active` next to `#html-preview-content` / `#html-preview-content.active`.
- **Collapsed sidebar padding (~line 284-288):** Add `#tree-pane-images` next to `#tree-pane-html`.
- **Collapsed sidebar children (~line 293-297):** Add `#tree-pane-images > *:not(.sidebar-toggle-row)` next to `#tree-pane-html`.
- **Tree pane base styles (~line 659-662):** Add `#tree-pane-images` next to `#tree-pane-html`.
- **Zoom viewport sizing (~line 2008-2009):** Add `#image-preview-container-images .zoomable-viewport` next to `#image-preview-container`.
- **Cyber theme content backgrounds (~line 2253-2258):** Add `.cyber-theme-enabled #images-content` next to `#html-preview-content`.
- **Cyber theme preview pane (~line 2214-2220):** Add `.cyber-theme-enabled #preview-pane-images` next to `#preview-pane-html`.
- **Cyber theme tree pane (~line 2188-2192):** Add `.cyber-theme-enabled #tree-pane-images` next to `#tree-pane-html`.

#### 3. Add Images Tab Content (~line 3453, before Stitch tab)
Insert the new `#images-content` tab pane:
```html
        <!-- Images Tab -->
        <div id="images-content" class="research-tab-content">
            <div class="controls-strip" id="controls-strip-images">
                <select id="images-workspace-filter" class="workspace-filter-select">
                    <option value="">All Workspaces</option>
                </select>
                <button id="btn-copy-link-images" class="strip-btn" disabled>Copy Link</button>
                <input type="text" id="images-docs-search" class="sidebar-search-input" placeholder="Search images..." />
                <span id="status-images" style="margin-left: 0; font-size: 12px; color: var(--text-secondary);">No folder configured</span>
            </div>
            <div class="content-row">
                <div id="tree-pane-images">
                    <div class="sidebar-toggle-row">
                        <button class="sidebar-toggle-btn" title="Toggle sidebar">«</button>
                    </div>
                    <div class="empty-state">Configure a folder to browse image files</div>
                </div>
                <div class="preview-panel-wrapper">
                    <div id="preview-pane-images" style="flex: 1; width: 100%; box-sizing: border-box; height: 100%; display: flex; flex-direction: column; overflow: hidden;">
                        <div id="images-initial-state" style="flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 16px; padding: 32px; color: var(--text-secondary);">
                            <span style="font-size: 48px; opacity: 0.5;">🖼️</span>
                            <div style="text-align: center;">
                                <div style="font-size: 14px; font-weight: 600; color: var(--text-primary); margin-bottom: 8px;">Image Previewer</div>
                                <div style="font-size: 12px; max-width: 320px; line-height: 1.5;">Select a file from the sidebar to preview image files. Configure folders using the Manage Folders button.</div>
                            </div>
                        </div>
                        <div id="images-loading-state" style="flex: 1; display: none; flex-direction: column; align-items: center; justify-content: center; gap: 12px; padding: 32px; color: var(--text-secondary);">
                            <div style="width: 32px; height: 32px; border: 3px solid var(--border-color); border-top-color: var(--accent-teal); border-radius: 50%; animation: spin 0.8s linear infinite;"></div>
                            <div style="font-size: 12px;">Loading preview...</div>
                        </div>
                        <div id="image-preview-container-images" class="zoomable-container" style="display: none; padding: 0;">
                            <div class="zoomable-viewport">
                                <img id="image-preview-img-images" alt="Image preview" style="display: block;" />
                            </div>
                            <div class="zoom-toolbar">
                                <button class="zoom-btn" data-action="zoom-in" title="Zoom In (Scroll)">+</button>
                                <button class="zoom-btn" data-action="zoom-out" title="Zoom Out (Scroll)">−</button>
                                <button class="zoom-btn" data-action="reset" title="Reset Zoom (100%)">⟲</button>
                                <button class="zoom-btn" data-action="fit" title="Fit to View (Double-click)">⤢</button>
                            </div>
                        </div>
                    </div>
                    <div class="cyber-scanlines"></div>
                </div>
            </div>
        </div>
```

#### 4. Remove Image Previewer from HTML tab (~line 3437)
Remove the old `#image-preview-container` block from `#html-preview-content`.

---

### `src/webview/design.js`

#### 1. State Updates (~line 25-47)
Add state variables:
```javascript
        imagesPreviewCollapsed: persistedState.imagesPreviewCollapsed || false,
        imagesWorkspaceRootFilter: '',
        imagesDocsSearch: '',
        _lastImagesDocsMsg: null,
```
Add `images` to `zoomState` (~line 85):
```javascript
    const zoomState = {
        html:     { scale: 1, panX: 0, panY: 0, isPanning: false, startX: 0, startY: 0, panSource: null },
        images:   { scale: 1, panX: 0, panY: 0, isPanning: false, startX: 0, startY: 0, panSource: null },
        design:   { scale: 1, panX: 0, panY: 0, isPanning: false, startX: 0, startY: 0, panSource: null },
    };
```

#### 2. Initialize Zoom Listeners (~line 250)
```javascript
    initZoomListeners('image-preview-container-images', '.zoomable-viewport', 'images');
```

#### 3. Update Sidebar Toggle Collapse (~line 273)
Extend `toggleSidebarCollapsed` to recognize `#tree-pane-images` and persist `imagesPreviewCollapsed`:
```javascript
    function toggleSidebarCollapsed(e) {
        const btn = e.target;
        const pane = btn.closest('#tree-pane-design') || btn.closest('#tree-pane-html') || btn.closest('#tree-pane-images');
        if (!pane) return;
        const row = pane.closest('.content-row');
        if (!row) return;

        const isCollapsed = row.classList.toggle('collapsed');
        btn.textContent = isCollapsed ? '»' : '«';

        if (pane.id === 'tree-pane-design') {
            state.designPreviewCollapsed = isCollapsed;
        } else if (pane.id === 'tree-pane-html') {
            state.htmlPreviewCollapsed = isCollapsed;
        } else if (pane.id === 'tree-pane-images') {
            state.imagesPreviewCollapsed = isCollapsed;
        }
        saveState();
    }
```

#### 4. Update State Persistence (~line 990)
Add `imagesPreviewCollapsed` to `saveState`:
```javascript
    function saveState() {
        vscode.setState({
            ...vscode.getState(),
            stitchModelId: state.stitchModelId,
            stitchCreativeRange: state.stitchCreativeRange,
            stitchAspects: state.stitchAspects,
            designPreviewCollapsed: state.designPreviewCollapsed,
            htmlPreviewCollapsed: state.htmlPreviewCollapsed,
            imagesPreviewCollapsed: state.imagesPreviewCollapsed
        });
    }
```

#### 5. Update File Filtering in rendering
In `renderHtmlDocs` (~line 470):
Restrict nodes rendered in HTML tab to `.html` and `.htm` files only.
```javascript
        let docNodes = (nodes || []).filter(n => n.kind === 'document');
        docNodes = docNodes.filter(d => {
            const ext = d.name.substring(d.name.lastIndexOf('.')).toLowerCase();
            return ['.html', '.htm'].includes(ext);
        });
```

Create a new `renderImagesDocs` function to filter and render image files in the Images tab sidebar:
```javascript
    function renderImagesDocs(rootEntry) {
        const { sourceId, nodes, folderPaths } = rootEntry;
        const treePaneImages = document.getElementById('tree-pane-images');
        if (!treePaneImages) return;

        treePaneImages.innerHTML = '';

        const toggleRow = document.createElement('div');
        toggleRow.className = 'sidebar-toggle-row';

        const toggleBtn = document.createElement('button');
        toggleBtn.className = 'sidebar-toggle-btn';
        toggleBtn.title = 'Toggle sidebar';
        toggleBtn.textContent = state.imagesPreviewCollapsed ? '»' : '«';
        toggleBtn.addEventListener('click', toggleSidebarCollapsed);
        toggleRow.appendChild(toggleBtn);
        treePaneImages.appendChild(toggleRow);

        const docList = document.createElement('div');
        docList.className = 'source-doc-list';
        docList.dataset.sourceId = 'images-folder';
        treePaneImages.appendChild(docList);

        if (!nodes || nodes.length === 0) {
            docList.innerHTML = '<div class="empty-state" style="padding: 12px; font-size: 12px; color: var(--text-secondary);">No image files found.</div>';
            return;
        }

        let docNodes = (nodes || []).filter(n => n.kind === 'document');
        docNodes = docNodes.filter(d => {
            const ext = d.name.substring(d.name.lastIndexOf('.')).toLowerCase();
            return ['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.bmp'].includes(ext);
        });

        const search = String(state.imagesDocsSearch || '').trim().toLowerCase();
        if (search) {
            docNodes = docNodes.filter(d => (d.name || '').toLowerCase().includes(search));
        }

        if (docNodes.length === 0) {
            docList.innerHTML = '<div class="empty-state" style="padding: 12px; font-size: 12px; color: var(--text-secondary);">No matching image files found.</div>';
            return;
        }

        const typeSubheader = document.createElement('div');
        typeSubheader.className = 'type-subheader';
        typeSubheader.textContent = 'Images';
        docList.appendChild(typeSubheader);

        docNodes.forEach(doc => {
            const card = renderDocCard({
                title: doc.name || doc.id,
                subtitle: 'Image',
                sourceId: 'images-folder',
                nodeId: doc.id,
                nodeMetadata: doc.metadata,
                actions: ['Link Doc'],
                isSelected: state.activeSource === 'images-folder' && state.activeDocId === doc.id,
                clickHandler: () => {
                    loadDocumentPreview('images-folder', doc.id, doc.name);
                }
            });
            docList.appendChild(card);
        });
    }
```

#### 6. Load Document Preview updates (~line 613)
Update `loadDocumentPreview` to support `sourceId === 'images-folder'`:
- Bind the Workspace filter & search inputs for both tabs.
- Handle UI transitions (resetting loading/initial states) for the new images tab selectors:
```javascript
        } else if (sourceId === 'images-folder') {
            const copyBtn = document.getElementById('btn-copy-link-images');
            if (copyBtn) {
                copyBtn.disabled = false;
                copyBtn.onclick = () => {
                    vscode.postMessage({
                        type: 'linkToDocument',
                        sourceId: 'html-folder', // Clarification: backend uses sourceFolder + docId; sourceId is arbitrary here
                        docId,
                        docName,
                        sourceFolder
                    });
                };
            }

            const statusImages = document.getElementById('status-images');
            if (statusImages) statusImages.textContent = 'Loading...';

            const initialState = document.getElementById('images-initial-state');
            const loadingState = document.getElementById('images-loading-state');
            const imageContainer = document.getElementById('image-preview-container-images');
            if (initialState) initialState.style.display = 'none';
            if (loadingState) loadingState.style.display = 'flex';
            if (imageContainer) imageContainer.style.display = 'none';

            vscode.postMessage({
                type: 'fetchPreview',
                sourceId: 'images-folder',
                docId,
                requestId: state.previewRequestId,
                sourceFolder
            });
        }
```

#### 7. Handle Preview Ready (`handlePreviewReady`)
Update `handlePreviewReady` to handle `sourceId === 'images-folder'`:
```javascript
        } else if (sourceId === 'images-folder') {
            if (requestId !== undefined && requestId !== -1 && requestId !== state.previewRequestId) return;
            resetZoom('images');

            const initialState = document.getElementById('images-initial-state');
            const loadingState = document.getElementById('images-loading-state');
            if (initialState) initialState.style.display = 'none';
            if (loadingState) loadingState.style.display = 'none';

            const imageContainer = document.getElementById('image-preview-container-images');
            const imageImg = document.getElementById('image-preview-img-images');
            const wrapper = document.querySelector('#images-content .preview-panel-wrapper');

            if (isImage && webviewUri) {
                if (imageContainer) { imageContainer.style.display = 'flex'; }
                if (wrapper) wrapper.classList.add('scanlines-suppressed');
                const imgViewport = imageContainer ? imageContainer.querySelector('.zoomable-viewport') : null;
                if (imgViewport) applyZoom('images', imgViewport);
                if (imageImg) {
                    imageImg.src = webviewUri + '?t=' + Date.now();
                    imageImg.onload = () => {
                        const container = document.getElementById('image-preview-container-images');
                        const viewport = container ? container.querySelector('.zoomable-viewport') : null;
                        if (container && viewport) fitToContainer('images', container, viewport);
                    };
                }
            }
            const statusImages = document.getElementById('status-images');
            if (statusImages) {
                statusImages.textContent = docName || 'Loaded';
                statusImages.style.color = 'var(--accent-teal)';
            }
        }
```

#### 8. Bind Search & Filter Selectors (~line 1694)
Add `change` and `input` event listeners for the Images tab controls:
```javascript
    document.getElementById('images-workspace-filter')?.addEventListener('change', (e) => {
        state.imagesWorkspaceRootFilter = e.target.value;
        const msg = state._lastImagesDocsMsg || state._lastHtmlDocsMsg || {};
        const filteredNodes = state.imagesWorkspaceRootFilter
            ? (msg.nodes || []).filter(n => n.metadata?.root === state.imagesWorkspaceRootFilter)
            : (msg.nodes || []);
        renderImagesDocs({
            sourceId: 'images-folder',
            nodes: filteredNodes,
            folderPaths: getCurrentFolderPaths(state.htmlFolderPathsByRoot, state.imagesWorkspaceRootFilter),
            error: msg.error
        });
    });

    document.getElementById('images-docs-search')?.addEventListener('input', (e) => {
        state.imagesDocsSearch = e.target.value;
        const msg = state._lastImagesDocsMsg || state._lastHtmlDocsMsg || {};
        const filteredNodes = state.imagesWorkspaceRootFilter
            ? (msg.nodes || []).filter(n => n.metadata?.root === state.imagesWorkspaceRootFilter)
            : (msg.nodes || []);
        renderImagesDocs({
            sourceId: 'images-folder',
            nodes: filteredNodes,
            folderPaths: getCurrentFolderPaths(state.htmlFolderPathsByRoot, state.imagesWorkspaceRootFilter),
            error: msg.error
        });
    });
```

#### 9. Update Webview message listeners for `htmlDocsReady`
```javascript
            case 'htmlDocsReady':
                state._lastHtmlDocsMsg = msg;
                state.htmlFolderPathsByRoot = msg.folderPathsByRoot || {};
                
                // Populate both HTML and Images workspace selectors
                populateWorkspaceDropdown('html-workspace-filter', msg.workspaceItems || [], state.htmlWorkspaceRootFilter);
                populateWorkspaceDropdown('images-workspace-filter', msg.workspaceItems || [], state.imagesWorkspaceRootFilter);
                
                const filteredHtmlNodes = state.htmlWorkspaceRootFilter
                    ? (msg.nodes || []).filter(n => n.metadata?.root === state.htmlWorkspaceRootFilter)
                    : (msg.nodes || []);
                renderHtmlDocs({
                    sourceId: msg.sourceId || 'html-folder',
                    nodes: filteredHtmlNodes,
                    folderPaths: getCurrentFolderPaths(state.htmlFolderPathsByRoot, state.htmlWorkspaceRootFilter),
                    error: msg.error
                });

                const filteredImagesNodes = state.imagesWorkspaceRootFilter
                    ? (msg.nodes || []).filter(n => n.metadata?.root === state.imagesWorkspaceRootFilter)
                    : (msg.nodes || []);
                renderImagesDocs({
                    sourceId: 'images-folder',
                    nodes: filteredImagesNodes,
                    folderPaths: getCurrentFolderPaths(state.htmlFolderPathsByRoot, state.imagesWorkspaceRootFilter),
                    error: msg.error
                });
                break;
```

#### 10. Handle Preview Errors (~line 1789)
Update the `previewError` branch so `images-folder` errors target `status-images`:
```javascript
            case 'previewError':
                console.error('[DesignPanel Webview] Preview error:', msg.error);
                let activeStatus;
                if (msg.sourceId === 'design-folder') {
                    activeStatus = 'status-design';
                } else if (msg.sourceId === 'images-folder') {
                    activeStatus = 'status-images';
                } else {
                    activeStatus = 'status-html';
                }
                const statusEl = document.getElementById(activeStatus);
                if (statusEl) {
                    statusEl.textContent = 'Preview error: ' + msg.error;
                    statusEl.style.color = '#ff6b6b';
                }
                break;
```

---

## Verification Plan

### Automated Tests
- None applicable.

### Manual Verification
1. Open the Design Panel in VS Code.
2. Confirm that a new **IMAGES** tab is present in the tab bar.
3. Switch to **HTML PREVIEWS** and verify that no image files are listed in its sidebar (only HTML files are shown).
4. Switch to **IMAGES** and verify that only image files (e.g. `.png`, `.svg`) are listed in its sidebar.
5. Click on an image in the IMAGES sidebar and verify that it loads cleanly with zoom/pan functionality.
6. Verify workspace dropdown filters and searches function independently on both tabs.
7. Collapse the Images sidebar, reload the webview, and confirm the collapse state is restored.
8. Trigger a preview error (e.g. delete the selected image file and refresh) and confirm the error message appears in the Images tab status bar, not the HTML tab.

## Risk Assessment
- **Low Risk:** Changes are self-contained within the webview UI (`design.html` and `design.js`). No backend schema, server port settings, or write routines are changed.

---

**Recommendation:** Send to Coder
