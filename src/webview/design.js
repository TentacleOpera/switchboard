(function() {
    const vscode = acquireVsCodeApi();

    // Restore persisted state
    const persistedState = vscode.getState() || {};

    const state = {
        switchboardTheme: null,
        stitchBusy: false,
        activeSource: null,
        activeDocId: null,
        activeDocName: null,
        activeDocContent: null,
        activeDocFilePath: null,
        activeDocSourceFolder: null,
        activeFileType: null,
        activeClaudeDocId: null,
        designEditMode: false,
        designEditOriginalContent: '',
        designSystemDocEnabled: false,
        designSystemDocSourceId: null,
        designSystemDocId: null,
        selectedEl: null,
        previewRequestId: 0,
        htmlFolderPathsByRoot: persistedState.htmlFolderPathsByRoot || {},
        claudeFolderPathsByRoot: persistedState.claudeFolderPathsByRoot || {},
        designFolderPathsByRoot: persistedState.designFolderPathsByRoot || {},
        briefsFolderPathsByRoot: persistedState.briefsFolderPathsByRoot || {},
        htmlPreviewCollapsed: persistedState.htmlPreviewCollapsed || false,
        claudePreviewCollapsed: persistedState.claudePreviewCollapsed || false,
        designPreviewCollapsed: persistedState.designPreviewCollapsed || false,
        imagesPreviewCollapsed: persistedState.imagesPreviewCollapsed || false,
        briefsPreviewCollapsed: persistedState.briefsPreviewCollapsed || false,
        htmlWorkspaceRootFilter: '',
        claudeWorkspaceRootFilter: '',
        designWorkspaceRootFilter: '',
        imagesWorkspaceRootFilter: '',
        briefsWorkspaceRootFilter: '',
        stitchWorkspaceRoot: '',
        htmlDocsSearch: '',
        claudeDocsSearch: '',
        claudeTargetFolder: '',
        designDocsSearch: '',
        imagesDocsSearch: '',
        briefsDocsSearch: '',
        _lastHtmlDocsMsg: null,
        _lastClaudeDocsMsg: null,
        _lastDesignDocsMsg: null,
        _lastImagesDocsMsg: null,
        _lastBriefsDocsMsg: null,
        activeBriefSourceId: null,
        activeBriefDocId: null,
        briefEditMode: false,
        briefEditOriginalContent: '',
        stitchProjects: [],
        selectedStitchProjectId: '',
        stitchScreens: [],
        stitchApiKeyConfigured: false,
        activePreviewScreenId: null,
        stitchModelId: ['GEMINI_3_FLASH','GEMINI_3_1_PRO'].includes(persistedState.stitchModelId) ? persistedState.stitchModelId : 'GEMINI_3_FLASH',
        stitchCreativeRange: ['EXPLORE','REFINE','REIMAGINE'].includes(persistedState.stitchCreativeRange) ? persistedState.stitchCreativeRange : 'EXPLORE',
        stitchAspects: Array.isArray(persistedState.stitchAspects) && persistedState.stitchAspects.every(a => typeof a === 'string') ? persistedState.stitchAspects : ['LAYOUT','COLOR_SCHEME','IMAGES','TEXT_FONT','TEXT_CONTENT'],
        stitchThumbnailStripCollapsed: persistedState.stitchThumbnailStripCollapsed || false,
        stitchAttachedFiles: [],
        stitchScreenPolls: new Map(),
        stitchProjectRefreshAttempted: false,
        docsSectionCollapsed: persistedState.docsSectionCollapsed || {},
    };

    function populateWorkspaceDropdown(selectElOrId, workspaceItems, selectedValue, includeAllOption = true) {
        const select = typeof selectElOrId === 'string' ? document.getElementById(selectElOrId) : selectElOrId;
        if (!select) return;
        const current = selectedValue || '';
        select.innerHTML = '';
        if (includeAllOption) {
            select.innerHTML = '<option value="">All Workspaces</option>';
        }
        for (const item of workspaceItems) {
            const option = document.createElement('option');
            option.value = item.workspaceRoot;
            option.textContent = item.label;
            if (item.workspaceRoot === current) {
                option.selected = true;
            }
            select.appendChild(option);
        }
    }

    let _restoredPanelState = { panel: {}, byRoot: {} };
    let _registeredDropdowns = []; // Array of { selectElOrId, tabKey, includeAllOption }
    let _workspaceItems = [];

    // Helper to register a dropdown for updates
    function registerWorkspaceDropdown(selectElOrId, tabKey, includeAllOption = true) {
        _registeredDropdowns.push({ selectElOrId, tabKey, includeAllOption });
        if (_workspaceItems.length > 0) {
            updateDropdown(selectElOrId, tabKey, includeAllOption);
        }
    }

    function updateDropdown(selectElOrId, tabKey, includeAllOption) {
        const select = typeof selectElOrId === 'string' ? document.getElementById(selectElOrId) : selectElOrId;
        if (!select) return;
        const currentVal = select.value;
        populateWorkspaceDropdown(select, _workspaceItems, currentVal, includeAllOption);
    }

    const _debounceTimers = {};
    function persistTab(tabKey, tabState, workspaceRoot) {
        const timerKey = tabKey + (workspaceRoot ? '::' + workspaceRoot : '');
        if (_debounceTimers[timerKey]) {
            clearTimeout(_debounceTimers[timerKey]);
        }
        _debounceTimers[timerKey] = setTimeout(() => {
            vscode.postMessage({
                type: 'persistTabState',
                tabKey,
                workspaceRoot,
                state: tabState
            });
            delete _debounceTimers[timerKey];
        }, 300);
    }

    window.persistTab = persistTab;
    window.registerWorkspaceDropdown = registerWorkspaceDropdown;
    window.getRestoredState = function(tabKey, workspaceRoot) {
        if (workspaceRoot) {
            return (_restoredPanelState.byRoot[tabKey] || {})[workspaceRoot];
        }
        return _restoredPanelState.panel[tabKey];
    };

    // Tab switcher
    const tabBtns = document.querySelectorAll('.shared-tab-btn');
    const tabContents = document.querySelectorAll('.shared-tab-content');

    function switchTab(tabName) {
        tabBtns.forEach(btn => {
            if (btn.dataset.tab === tabName) {
                btn.classList.add('active');
            } else {
                btn.classList.remove('active');
            }
        });

        tabContents.forEach(content => {
            const contentId = tabName + '-content';
            if (content.id === contentId) {
                content.classList.add('active');
            } else {
                content.classList.remove('active');
            }
        });

        // Trigger updates if needed
        if (tabName === 'stitch') {
            // Defensive: ensure clean UI when no project is selected
            if (!state.selectedStitchProjectId) {
                const pane = document.getElementById('stitch-preview-pane');
                const strip = document.getElementById('stitch-thumbnail-strip');
                const gallery = document.getElementById('stitch-gallery');
                const empty = document.getElementById('stitch-gallery-empty');
                if (pane) pane.style.display = 'none';
                if (strip) strip.style.display = 'none';
                if (gallery) gallery.style.display = 'none';
                if (empty) empty.style.display = 'flex';
            }
            vscode.postMessage({
                type: 'stitchListProjects',
                workspaceRoot: state.stitchWorkspaceRoot
            });
        }

        // Re-scan source folders on tab entry. VS Code's file watcher misses
        // externally-created files, so the list can be stale; this forces a fresh
        // server-side readdir every time the tab is activated (mirrors planning.js).
        if (tabName === 'html-preview' || tabName === 'claude' || tabName === 'images' || tabName === 'briefs') {
            vscode.postMessage({ type: 'refreshDocsForTab', tab: tabName });
        }

        vscode.postMessage({ type: 'activeTabChanged', tab: tabName });

        persistTab('activeTab', tabName);
    }

    tabBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            switchTab(btn.dataset.tab);
        });
    });

    // Initialize the initially active tab
    const initialTab = document.querySelector('.shared-tab-btn.active')?.dataset.tab || 'stitch';
    switchTab(initialTab);

    // ── Zoom/Pan Engine ──
    const zoomState = {
        html:     { scale: 1, panX: 0, panY: 0, isPanning: false, startX: 0, startY: 0, panSource: null },
        claude:   { scale: 1, panX: 0, panY: 0, isPanning: false, startX: 0, startY: 0, panSource: null },
        images:   { scale: 1, panX: 0, panY: 0, isPanning: false, startX: 0, startY: 0, panSource: null },
        design:   { scale: 1, panX: 0, panY: 0, isPanning: false, startX: 0, startY: 0, panSource: null },
    };

    const ZOOM_MIN = 0.1;
    const ZOOM_MAX = 40.0;

    function resetZoom(tab) {
        zoomState[tab] = { scale: 1, panX: 0, panY: 0, isPanning: false, startX: 0, startY: 0, panSource: null };
    }

    function applyZoom(tab, viewportEl) {
        if (!viewportEl) return;
        viewportEl.style.transform = `translate(${zoomState[tab].panX}px, ${zoomState[tab].panY}px) scale(${zoomState[tab].scale})`;
    }

    function getContentDims(viewportEl) {
        const el = viewportEl ? viewportEl.firstElementChild : null;
        if (!el) return null;
        const w = el.tagName === 'IMG' ? (el.naturalWidth || el.offsetWidth) : el.offsetWidth;
        const h = el.tagName === 'IMG' ? (el.naturalHeight || el.offsetHeight) : el.offsetHeight;
        return (w && h) ? { w, h } : null;
    }

    // Content that fits on an axis is locked centered; content larger than the
    // container clamps so it always covers the canvas — it can never be zoomed
    // or panned out of view.
    function clampPan(tab, containerRect, contentWidth, contentHeight) {
        const s = zoomState[tab].scale;
        const scaledW = contentWidth * s;
        const scaledH = contentHeight * s;
        if (scaledW <= containerRect.width) {
            zoomState[tab].panX = (containerRect.width - scaledW) / 2;
        } else {
            zoomState[tab].panX = Math.max(containerRect.width - scaledW, Math.min(0, zoomState[tab].panX));
        }
        if (scaledH <= containerRect.height) {
            zoomState[tab].panY = (containerRect.height - scaledH) / 2;
        } else {
            zoomState[tab].panY = Math.max(containerRect.height - scaledH, Math.min(0, zoomState[tab].panY));
        }
    }

    function fitToContainer(tab, containerEl, viewportEl, retriesLeft = 5) {
        if (!containerEl || !viewportEl) return;
        const containerRect = containerEl.getBoundingClientRect();
        if (!containerRect.width || !containerRect.height) {
            if (retriesLeft > 0) {
                requestAnimationFrame(() => fitToContainer(tab, containerEl, viewportEl, retriesLeft - 1));
            }
            return;
        }
        const contentEl = viewportEl.firstElementChild;
        if (!contentEl) return;
        let contentW, contentH;
        if (contentEl.tagName === 'IMG') {
            contentW = contentEl.naturalWidth || contentEl.offsetWidth;
            contentH = contentEl.naturalHeight || contentEl.offsetHeight;
        } else {
            contentW = contentEl.offsetWidth;
            contentH = contentEl.offsetHeight;
        }
        if (!contentW || !contentH) return;
        const fitScale = Math.min(containerRect.width / contentW, containerRect.height / contentH, 1);
        zoomState[tab].scale = fitScale;
        zoomState[tab].panX = (containerRect.width - contentW * fitScale) / 2;
        zoomState[tab].panY = (containerRect.height - contentH * fitScale) / 2;
        applyZoom(tab, viewportEl);
    }

    function zoomAt(tab, container, viewportEl, newScale, cx, cy) {
        const oldScale = zoomState[tab].scale;
        const clamped = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, newScale));
        if (!oldScale || clamped === oldScale) {
            zoomState[tab].scale = clamped || 1;
            applyZoom(tab, viewportEl);
            return;
        }
        const k = clamped / oldScale;
        zoomState[tab].panX = cx - (cx - zoomState[tab].panX) * k;
        zoomState[tab].panY = cy - (cy - zoomState[tab].panY) * k;
        zoomState[tab].scale = clamped;
        const dims = getContentDims(viewportEl);
        if (dims) clampPan(tab, container.getBoundingClientRect(), dims.w, dims.h);
        applyZoom(tab, viewportEl);
    }

    function initZoomListeners(containerId, viewportSelector, tab) {
        const container = document.getElementById(containerId);
        if (!container) return;

        // Plain scroll zooms at the cursor; trackpad pinch arrives as ctrl+wheel
        // with small deltas, so it gets a stronger multiplier.
        container.addEventListener('wheel', (e) => {
            e.preventDefault();
            const factor = Math.exp(-e.deltaY * ((e.ctrlKey || e.metaKey) ? 0.01 : 0.002));
            const rect = container.getBoundingClientRect();
            zoomAt(tab, container, container.querySelector(viewportSelector),
                zoomState[tab].scale * factor,
                e.clientX - rect.left, e.clientY - rect.top);
        }, { passive: false });

        container.addEventListener('mousedown', (e) => {
            if (e.button !== 0 || e.target.closest('.zoom-toolbar')) return;
            // Without this, grabbing an <img> starts a native drag and the pan dies.
            e.preventDefault();
            zoomState[tab].isPanning = true;
            zoomState[tab].panSource = containerId;
            zoomState[tab].startX = e.clientX - zoomState[tab].panX;
            zoomState[tab].startY = e.clientY - zoomState[tab].panY;
            container.classList.add('panning');
        });

        window.addEventListener('mousemove', (e) => {
            // panSource guard: two containers share each tab's state; without it the
            // hidden container's handler clamps against a 0×0 rect and wrecks the pan.
            if (!zoomState[tab].isPanning || zoomState[tab].panSource !== containerId) return;
            zoomState[tab].panX = e.clientX - zoomState[tab].startX;
            zoomState[tab].panY = e.clientY - zoomState[tab].startY;

            const viewportEl = container.querySelector(viewportSelector);
            const dims = getContentDims(viewportEl);
            if (dims) clampPan(tab, container.getBoundingClientRect(), dims.w, dims.h);
            applyZoom(tab, viewportEl);
        });

        window.addEventListener('mouseup', () => {
            if (!zoomState[tab].isPanning || zoomState[tab].panSource !== containerId) return;
            zoomState[tab].isPanning = false;
            zoomState[tab].panSource = null;
            container.classList.remove('panning');
        });

        container.addEventListener('dblclick', (e) => {
            if (e.target.closest('.zoom-toolbar')) return;
            fitToContainer(tab, container, container.querySelector(viewportSelector));
        });

        container.addEventListener('click', (e) => {
            const btn = e.target.closest('.zoom-btn');
            if (!btn) return;
            const action = btn.dataset.action;
            const viewportEl = container.querySelector(viewportSelector);
            const rect = container.getBoundingClientRect();
            if (action === 'zoom-in') {
                zoomAt(tab, container, viewportEl, zoomState[tab].scale * 1.25, rect.width / 2, rect.height / 2);
            } else if (action === 'zoom-out') {
                zoomAt(tab, container, viewportEl, zoomState[tab].scale / 1.25, rect.width / 2, rect.height / 2);
            } else if (action === 'reset') {
                zoomState[tab].scale = 1;
                const dims = getContentDims(viewportEl);
                if (dims) {
                    clampPan(tab, rect, dims.w, dims.h);
                } else {
                    zoomState[tab].panX = 0;
                    zoomState[tab].panY = 0;
                }
                applyZoom(tab, viewportEl);
            } else if (action === 'fit') {
                fitToContainer(tab, container, viewportEl);
            }
        });
    }

    // Initialize Zoom for Previews
    initZoomListeners('html-preview-wrapper', '.zoomable-viewport', 'html');
    initZoomListeners('claude-preview-wrapper', '.zoomable-viewport', 'claude');
    initZoomListeners('image-preview-container-claude', '.zoomable-viewport', 'claude');
    initZoomListeners('image-preview-container', '.zoomable-viewport', 'html');
    initZoomListeners('image-preview-container-images', '.zoomable-viewport', 'images');
    initZoomListeners('image-preview-container-design', '.zoomable-viewport', 'design');

    function setupPreviewResizeObservers() {
        const targets = [
            { wrapperId: 'html-preview-wrapper', frameId: 'html-preview-frame' },
            { wrapperId: 'claude-preview-wrapper', frameId: 'claude-preview-frame' }
        ];
        for (const { wrapperId, frameId } of targets) {
            const wrapper = document.getElementById(wrapperId);
            const frame = document.getElementById(frameId);
            if (!wrapper || !frame) continue;
            const observer = new MutationObserver(() => {
                notifyIframeResize(frame, wrapper);
            });
            observer.observe(wrapper, {
                attributes: true,
                attributeFilter: ['style', 'class']
            });
        }
    }
    setupPreviewResizeObservers();

    window.addEventListener('resize', () => {
        notifyIframeResize(
            document.getElementById('html-preview-frame'),
            document.getElementById('html-preview-wrapper')
        );
        notifyIframeResize(
            document.getElementById('claude-preview-frame'),
            document.getElementById('claude-preview-wrapper')
        );
    });

    // Hold Space to pan/zoom over HTML previews. The iframe swallows mouse events,
    // so a capture layer is shown only while Space is held — the rest of the time
    // the previewed page stays fully interactive.
    window.addEventListener('keydown', (e) => {
        if (e.code !== 'Space' || e.repeat) return;
        const t = e.target;
        if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
        document.body.classList.add('space-pan-active');
        e.preventDefault(); // stop the page from scrolling on Space
    });
    window.addEventListener('keyup', (e) => {
        if (e.code !== 'Space') return;
        document.body.classList.remove('space-pan-active');
    });
    window.addEventListener('blur', () => {
        document.body.classList.remove('space-pan-active');
    });

    // Sidebar Collapsing
    function toggleSidebarCollapsed(e) {
        const btn = e.target;
        const pane = btn.closest('#tree-pane-design') || btn.closest('#tree-pane-html') || btn.closest('#tree-pane-claude') || btn.closest('#tree-pane-images') || btn.closest('#tree-pane-briefs');
        if (!pane) return;
        const row = pane.closest('.content-row');
        if (!row) return;

        const isCollapsed = row.classList.toggle('collapsed');
        btn.textContent = isCollapsed ? '»' : '«';

        if (pane.id === 'tree-pane-design') {
            state.designPreviewCollapsed = isCollapsed;
        } else if (pane.id === 'tree-pane-html') {
            state.htmlPreviewCollapsed = isCollapsed;
        } else if (pane.id === 'tree-pane-claude') {
            state.claudePreviewCollapsed = isCollapsed;
        } else if (pane.id === 'tree-pane-images') {
            state.imagesPreviewCollapsed = isCollapsed;
        } else if (pane.id === 'tree-pane-briefs') {
            state.briefsPreviewCollapsed = isCollapsed;
        }
        saveState();
    }

    // Helpers
    function escapeHtml(value) {
        return String(value || '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    // srcdoc previews lose their file origin — a <base> tag pointed at the
    // file's webview URI lets relative asset paths resolve.
    function injectBaseTag(html, baseUri) {
        if (!html || !baseUri) return html;
        if (html.includes('<base ')) return html;
        const baseTag = `<base href="${escapeHtml(baseUri)}">`;
        const headMatch = html.match(/<head\b[^>]*>/i);
        if (headMatch) {
            const index = headMatch.index + headMatch[0].length;
            return html.slice(0, index) + baseTag + html.slice(index);
        }
        const htmlMatch = html.match(/<html\b[^>]*>/i);
        if (htmlMatch) {
            const index = htmlMatch.index + htmlMatch[0].length;
            return html.slice(0, index) + baseTag + html.slice(index);
        }
        return baseTag + html;
    }

    const _resizeRafTokens = new WeakMap();
    function notifyIframeResize(iframe, wrapperEl) {
        if (!iframe) return;
        const prev = _resizeRafTokens.get(iframe);
        if (prev) cancelAnimationFrame(prev);
        const token = requestAnimationFrame(() => {
            _resizeRafTokens.delete(iframe);
            if (wrapperEl && wrapperEl.style.display === 'none') return;
            if (!iframe.contentWindow) return;
            requestAnimationFrame(() => {
                if (wrapperEl && wrapperEl.style.display === 'none') return;
                if (!iframe.contentWindow) return;
                try {
                    iframe.contentWindow.dispatchEvent(new Event('resize'));
                } catch (e) {
                    // cross-origin dispatch guard
                }
            });
        });
        _resizeRafTokens.set(iframe, token);
    }

    function getCurrentFolderPaths(folderPathsByRoot, filterRoot) {
        if (filterRoot) {
            return folderPathsByRoot[filterRoot] || [];
        }
        const paths = [];
        for (const list of Object.values(folderPathsByRoot)) {
            paths.push(...list);
        }
        return [...new Set(paths)];
    }

    function findTreeNode(sourceId, nodeId) {
        const list = document.querySelector(`.source-doc-list[data-source-id="${sourceId}"]`);
        if (!list) return null;
        return list.querySelector(`.tree-node[data-node-id="${nodeId}"]`);
    }

    // tabKey: namespaces the persisted collapse map
    function buildAccordionFolderHeader({ folderPath, folderName, docCount, tabKey, actions, subheader, forceOpen, defaultCollapsed }) {
        const headerContainer = document.createElement('div');
        headerContainer.className = 'folder-section-container';

        const header = document.createElement('div');
        header.className = subheader
            ? 'folder-subheader folder-subheader-collapsible'
            : 'folder-subheader source-folder-header';
        header.title = folderPath;
        header.style.cursor = 'pointer';

        const labelWrapper = document.createElement('div');
        labelWrapper.style.cssText = 'display: flex; flex-direction: column; gap: 2px; flex: 1;';

        const labelSpan = document.createElement('span');
        if (!subheader) {
            labelSpan.style.fontWeight = 'bold';
        }
        const chevronSpan = document.createElement('span');
        chevronSpan.className = 'section-chevron';
        chevronSpan.style.marginRight = '6px';
        labelSpan.textContent = `${folderName}${docCount != null ? ` (${docCount})` : ''}`;
        labelSpan.prepend(chevronSpan);
        labelWrapper.appendChild(labelSpan);
        header.appendChild(labelWrapper);

        const actionsDiv = document.createElement('div');
        actionsDiv.style.cssText = 'display: flex; gap: 4px;';
        (actions || []).forEach(({ label, title, className, onClick }) => {
            const btn = document.createElement('button');
            btn.className = className || 'folder-link-btn';
            btn.textContent = label;
            btn.title = title || label;
            btn.addEventListener('click', (e) => { e.stopPropagation(); onClick(btn, e); });
            actionsDiv.appendChild(btn);
        });
        header.appendChild(actionsDiv);

        const contentDiv = document.createElement('div');
        contentDiv.className = 'folder-section-content';

        // Persisted collapse state, namespaced per tab
        if (!state.docsSectionCollapsed) state.docsSectionCollapsed = {};
        const collapseKey = `${tabKey}::${folderPath}`;
        let isCollapsed = state.docsSectionCollapsed[collapseKey];
        if (isCollapsed === undefined) {
            isCollapsed = defaultCollapsed !== undefined ? defaultCollapsed : false;
        }

        if (forceOpen) {
            isCollapsed = false;
        }

        // Save initial state if forced or resolved
        state.docsSectionCollapsed[collapseKey] = isCollapsed;

        const updateCollapsedUI = () => {
            chevronSpan.textContent = isCollapsed ? '▸ ' : '▾ ';
            contentDiv.style.display = isCollapsed ? 'none' : 'block';
        };
        header.addEventListener('click', (e) => {
            if (e.target.closest('button') || e.target.closest('select')) return;
            isCollapsed = !isCollapsed;
            state.docsSectionCollapsed[collapseKey] = isCollapsed;
            updateCollapsedUI();
            const cur = vscode.getState() || {};
            vscode.setState({ ...cur, docsSectionCollapsed: state.docsSectionCollapsed });
        });
        updateCollapsedUI();

        headerContainer.appendChild(header);
        headerContainer.appendChild(contentDiv);
        return { headerContainer, contentDiv };
    }

    function renderSubfolderGroups(docList, docs, subfolderNodes, createCardFn, showAll, tabKey) {
        const folderIdMap = new Map();
        subfolderNodes.forEach(f => folderIdMap.set(f.id, f));

        const docsByParentFolder = new Map();
        const rootDocs = [];
        docs.forEach(d => {
            const docId = d.id || '';
            const lastSlashIdx = docId.lastIndexOf('/');
            const parentFolderId = lastSlashIdx > 0 ? docId.substring(0, lastSlashIdx) : null;

            if (parentFolderId && folderIdMap.has(parentFolderId)) {
                if (!docsByParentFolder.has(parentFolderId)) docsByParentFolder.set(parentFolderId, []);
                docsByParentFolder.get(parentFolderId).push(d);
            } else {
                rootDocs.push(d);
            }
        });

        subfolderNodes.forEach(folder => {
            const folderDocs = docsByParentFolder.get(folder.id) || [];
            if (folderDocs.length === 0 && !showAll) return;

            const hasSelectedDoc = folderDocs.some(d => state.activeSource === 'local-folder' && state.activeDocId === d.id);
            const { headerContainer, contentDiv } = buildAccordionFolderHeader({
                folderPath: folder.id,
                folderName: folder.name,
                docCount: folderDocs.length,
                tabKey,
                actions: [
                    {
                        label: 'Link',
                        title: 'Copy subfolder path to clipboard',
                        onClick: () => vscode.postMessage({ type: 'linkToFolder', folderPath: folder.id })
                    }
                ],
                subheader: true,
                forceOpen: hasSelectedDoc
            });

            docList.appendChild(headerContainer);
            folderDocs.forEach(doc => {
                contentDiv.appendChild(createCardFn(doc));
            });
        });

        rootDocs.forEach(doc => {
            docList.appendChild(createCardFn(doc));
        });
    }

    function renderFolderGroupedDocs(docList, docNodes, folderNodes, folderPaths, search, createCardFn, tabKey = 'folder-grouped') {
        const folderPathsList = folderPaths || [];

        const foldersBySourceFolder = new Map();
        (folderNodes || []).forEach(f => {
            const sf = f.metadata?.sourceFolder;
            if (!sf) return;
            if (!foldersBySourceFolder.has(sf)) foldersBySourceFolder.set(sf, []);
            foldersBySourceFolder.get(sf).push(f);
        });

        if (search) {
            const byFolder = new Map();
            docNodes.forEach(d => {
                const sf = d.metadata?.sourceFolder;
                if (!sf) return;
                if (!byFolder.has(sf)) byFolder.set(sf, []);
                byFolder.get(sf).push(d);
            });
            [...byFolder.entries()].forEach(([sf, docs]) => {
                const { headerContainer, contentDiv } = buildAccordionFolderHeader({
                    folderPath: sf,
                    folderName: sf.split(/[\\/]/).filter(Boolean).pop() || sf,
                    docCount: docs.length,
                    tabKey,
                    actions: [
                        {
                            label: 'Link',
                            title: 'Copy folder path to clipboard',
                            onClick: () => vscode.postMessage({ type: 'linkToFolder', folderPath: sf })
                        }
                    ],
                    forceOpen: true
                });
                docList.appendChild(headerContainer);
                renderSubfolderGroups(contentDiv, docs, foldersBySourceFolder.get(sf) || [], createCardFn, false, tabKey);
            });
        } else {
            const docsByFolder = new Map();
            docNodes.forEach(d => {
                const sf = d.metadata?.sourceFolder;
                if (sf) {
                    if (!docsByFolder.has(sf)) docsByFolder.set(sf, []);
                    docsByFolder.get(sf).push(d);
                }
            });
            folderPathsList.forEach(fp => {
                const docs = docsByFolder.get(fp) || [];
                const hasSelectedDoc = docs.some(d => state.activeSource === 'local-folder' && state.activeDocId === d.id);
                const { headerContainer, contentDiv } = buildAccordionFolderHeader({
                    folderPath: fp,
                    folderName: fp.split(/[\\/]/).filter(Boolean).pop() || fp,
                    docCount: docs.length,
                    tabKey,
                    actions: [
                        {
                            label: 'Link',
                            title: 'Copy folder path to clipboard',
                            onClick: () => vscode.postMessage({ type: 'linkToFolder', folderPath: fp })
                        }
                    ],
                    forceOpen: hasSelectedDoc
                });
                docList.appendChild(headerContainer);
                renderSubfolderGroups(contentDiv, docs, foldersBySourceFolder.get(fp) || [], createCardFn, true, tabKey);
            });
            const configuredSet = new Set(folderPathsList);
            docsByFolder.forEach((docs, sf) => {
                if (!configuredSet.has(sf)) {
                    const hasSelectedDoc = docs.some(d => state.activeSource === 'local-folder' && state.activeDocId === d.id);
                    const { headerContainer, contentDiv } = buildAccordionFolderHeader({
                        folderPath: sf,
                        folderName: sf.split(/[\\/]/).filter(Boolean).pop() || sf,
                        docCount: docs.length,
                        tabKey,
                        actions: [
                            {
                                label: 'Link',
                                title: 'Copy folder path to clipboard',
                                onClick: () => vscode.postMessage({ type: 'linkToFolder', folderPath: sf })
                            }
                        ],
                        forceOpen: hasSelectedDoc
                    });
                    docList.appendChild(headerContainer);
                    renderSubfolderGroups(contentDiv, docs, foldersBySourceFolder.get(sf) || [], createCardFn, true, tabKey);
                }
            });
        }
    }

    // ── Tree Rendering: Design Docs ──
    function renderDesignDocs(rootEntry) {
        const { sourceId, nodes, folderPaths } = rootEntry;
        const treePaneDesign = document.getElementById('tree-pane-design');
        if (!treePaneDesign) return;

        treePaneDesign.innerHTML = '';

        const toggleRow = document.createElement('div');
        toggleRow.className = 'sidebar-toggle-row';

        const foldersBtn = document.createElement('button');
        foldersBtn.className = 'sidebar-folders-btn';
        foldersBtn.title = 'Manage Folders';
        foldersBtn.textContent = 'Manage Folders';
        foldersBtn.addEventListener('click', () => openFoldersModal('design'));
        toggleRow.appendChild(foldersBtn);

        const toggleBtn = document.createElement('button');
        toggleBtn.className = 'sidebar-toggle-btn';
        toggleBtn.title = 'Toggle sidebar';
        toggleBtn.textContent = state.designPreviewCollapsed ? '»' : '«';
        toggleBtn.addEventListener('click', toggleSidebarCollapsed);
        toggleRow.appendChild(toggleBtn);
        treePaneDesign.appendChild(toggleRow);

        const docList = document.createElement('div');
        docList.className = 'source-doc-list';
        docList.dataset.sourceId = sourceId;
        treePaneDesign.appendChild(docList);

        if ((!nodes || nodes.length === 0) && (!folderPaths || folderPaths.length === 0)) {
            docList.innerHTML = '<div class="empty-state" style="padding: 12px; font-size: 12px; color: var(--text-secondary);">No design system documents found.</div>';
            return;
        }

        let docNodes = (nodes || []).filter(n => n.kind === 'document');
        const folderNodes = (nodes || []).filter(n => n.kind === 'folder');
        const search = String(state.designDocsSearch || '').trim().toLowerCase();
        if (search) {
            docNodes = docNodes.filter(d => (d.title || d.name || '').toLowerCase().includes(search));
        }

        renderFolderGroupedDocs(docList, docNodes, folderNodes, folderPaths, search, (doc) => createDesignDocCard(doc, sourceId), 'design-system');
    }

    function createDesignDocCard(node, sourceId) {
        const actions = ['Set Context', 'Link Doc'];
        const fullName = node.name || node.id || '';
        const lastDot = fullName.lastIndexOf('.');
        const title = lastDot > 0 ? fullName.substring(0, lastDot) : fullName;
        const ext = lastDot > 0 ? fullName.substring(lastDot).toLowerCase() : '';
        let subtitle = 'File';
        if (['.md', '.markdown'].includes(ext)) subtitle = 'Markdown';
        else if (['.yaml', '.yml'].includes(ext)) subtitle = 'YAML';
        else if (ext === '.json') subtitle = 'JSON';
        else if (['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.bmp'].includes(ext)) subtitle = ext.substring(1).toUpperCase();

        return renderDocCard({
            title,
            subtitle,
            sourceId,
            nodeId: node.id,
            nodeMetadata: node.metadata,
            actions,
            isSelected: state.activeSource === sourceId && state.activeDocId === node.id,
            clickHandler: () => {
                loadDocumentPreview(sourceId, node.id, node.name);
            }
        });
    }

    // ── Tree Rendering: Briefs ──
    function renderBriefsDocs(rootEntry) {
        const { sourceId, nodes, folderPaths } = rootEntry;
        const treePaneBriefs = document.getElementById('tree-pane-briefs');
        if (!treePaneBriefs) return;

        treePaneBriefs.innerHTML = '';

        const toggleRow = document.createElement('div');
        toggleRow.className = 'sidebar-toggle-row';

        const foldersBtn = document.createElement('button');
        foldersBtn.className = 'sidebar-folders-btn';
        foldersBtn.title = 'Manage Folders';
        foldersBtn.textContent = 'Manage Folders';
        foldersBtn.addEventListener('click', () => openFoldersModal('briefs'));
        toggleRow.appendChild(foldersBtn);

        const toggleBtn = document.createElement('button');
        toggleBtn.className = 'sidebar-toggle-btn';
        toggleBtn.title = 'Toggle sidebar';
        toggleBtn.textContent = state.briefsPreviewCollapsed ? '»' : '«';
        toggleBtn.addEventListener('click', toggleSidebarCollapsed);
        toggleRow.appendChild(toggleBtn);
        treePaneBriefs.appendChild(toggleRow);

        const docList = document.createElement('div');
        docList.className = 'source-doc-list';
        docList.dataset.sourceId = sourceId;
        treePaneBriefs.appendChild(docList);

        if ((!nodes || nodes.length === 0) && (!folderPaths || folderPaths.length === 0)) {
            docList.innerHTML = '<div class="empty-state" style="padding: 12px; font-size: 12px; color: var(--text-secondary);">No design briefs found.</div>';
            return;
        }

        let docNodes = (nodes || []).filter(n => n.kind === 'document');
        const folderNodes = (nodes || []).filter(n => n.kind === 'folder');
        const search = String(state.briefsDocsSearch || '').trim().toLowerCase();
        if (search) {
            docNodes = docNodes.filter(d => (d.title || d.name || '').toLowerCase().includes(search));
        }

        renderFolderGroupedDocs(docList, docNodes, folderNodes, folderPaths, search, (doc) => createBriefDocCard(doc, sourceId), 'briefs');
    }

    function createBriefDocCard(node, sourceId) {
        const fullName = node.name || node.id || '';
        const lastDot = fullName.lastIndexOf('.');
        const title = lastDot > 0 ? fullName.substring(0, lastDot) : fullName;
        return renderDocCard({
            title: node.title || title,
            subtitle: 'Markdown',
            sourceId,
            nodeId: node.id,
            nodeMetadata: node.metadata,
            isSelected: state.activeBriefSourceId === sourceId && state.activeBriefDocId === node.id,
            clickHandler: () => {
                loadDocumentPreview(sourceId, node.id, node.name);
            }
        });
    }

    // ── Tree Rendering: HTML Previews ──
    const TYPE_ORDER = ['html', 'markdown', 'yaml', 'json', 'image'];
    const TYPE_LABELS = {
        html: 'HTML',
        markdown: 'Markdown',
        yaml: 'YAML',
        json: 'JSON',
        image: 'Images'
    };

    function getDocType(doc) {
        const name = doc.name || doc.id || '';
        const ext = name.substring(name.lastIndexOf('.')).toLowerCase();
        if (['.html', '.htm'].includes(ext)) return 'html';
        if (['.md', '.markdown'].includes(ext)) return 'markdown';
        if (['.yaml', '.yml'].includes(ext)) return 'yaml';
        if (ext === '.json') return 'json';
        if (['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.bmp'].includes(ext)) return 'image';
        return 'other';
    }

    function groupDocsByType(docs) {
        const groups = { html: [], markdown: [], yaml: [], json: [], image: [], other: [] };
        docs.forEach(doc => {
            const type = getDocType(doc);
            if (groups[type]) groups[type].push(doc);
            else groups.other.push(doc);
        });
        return groups;
    }

    function renderHtmlDocs(rootEntry) {
        const { sourceId, nodes, folderPaths } = rootEntry;
        const treePaneHtml = document.getElementById('tree-pane-html');
        if (!treePaneHtml) return;

        treePaneHtml.innerHTML = '';

        const toggleRow = document.createElement('div');
        toggleRow.className = 'sidebar-toggle-row';

        const foldersBtn = document.createElement('button');
        foldersBtn.className = 'sidebar-folders-btn';
        foldersBtn.title = 'Manage Folders';
        foldersBtn.textContent = 'Manage Folders';
        foldersBtn.addEventListener('click', () => openFoldersModal('html'));
        toggleRow.appendChild(foldersBtn);

        const toggleBtn = document.createElement('button');
        toggleBtn.className = 'sidebar-toggle-btn';
        toggleBtn.title = 'Toggle sidebar';
        toggleBtn.textContent = state.htmlPreviewCollapsed ? '»' : '«';
        toggleBtn.addEventListener('click', toggleSidebarCollapsed);
        toggleRow.appendChild(toggleBtn);
        treePaneHtml.appendChild(toggleRow);

        const docList = document.createElement('div');
        docList.className = 'source-doc-list';
        docList.dataset.sourceId = sourceId;
        treePaneHtml.appendChild(docList);

        if ((!nodes || nodes.length === 0) && (!folderPaths || folderPaths.length === 0)) {
            docList.innerHTML = '<div class="empty-state" style="padding: 12px; font-size: 12px; color: var(--text-secondary);">No HTML preview files found.</div>';
            return;
        }

        let docNodes = (nodes || []).filter(n => n.kind === 'document');
        const folderNodes = (nodes || []).filter(n => n.kind === 'folder');
        docNodes = docNodes.filter(d => {
            const ext = d.name.substring(d.name.lastIndexOf('.')).toLowerCase();
            return ['.html', '.htm'].includes(ext);
        });

        const search = String(state.htmlDocsSearch || '').trim().toLowerCase();
        if (search) {
            docNodes = docNodes.filter(d => (d.title || d.name || '').toLowerCase().includes(search));
        }

        if (docNodes.length === 0 && (search || !folderPaths || folderPaths.length === 0)) {
            docList.innerHTML = '<div class="empty-state" style="padding: 12px; font-size: 12px; color: var(--text-secondary);">No matching HTML preview files found.</div>';
            return;
        }

        renderFolderGroupedDocs(docList, docNodes, folderNodes, folderPaths, search, (doc) => createHtmlDocCard(doc, sourceId), 'html-previews');
    }

    function createHtmlDocCard(doc, sourceId) {
        return renderDocCard({
            title: doc.name || doc.id,
            subtitle: 'HTML',
            sourceId,
            nodeId: doc.id,
            nodeMetadata: doc.metadata,
            actions: ['Serve & Open', 'Link Doc'],
            isSelected: state.activeSource === sourceId && state.activeDocId === doc.id,
            clickHandler: () => {
                loadDocumentPreview(sourceId, doc.id, doc.name);
            }
        });
    }

    function renderImagesDocs(rootEntry) {
        const { sourceId, nodes, folderPaths } = rootEntry;
        const treePaneImages = document.getElementById('tree-pane-images');
        if (!treePaneImages) return;

        treePaneImages.innerHTML = '';

        const toggleRow = document.createElement('div');
        toggleRow.className = 'sidebar-toggle-row';

        const foldersBtn = document.createElement('button');
        foldersBtn.className = 'sidebar-folders-btn';
        foldersBtn.title = 'Manage Folders';
        foldersBtn.textContent = 'Manage Folders';
        foldersBtn.addEventListener('click', () => openFoldersModal('images'));
        toggleRow.appendChild(foldersBtn);

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

        if ((!nodes || nodes.length === 0) && (!folderPaths || folderPaths.length === 0)) {
            docList.innerHTML = '<div class="empty-state" style="padding: 12px; font-size: 12px; color: var(--text-secondary);">No image files found.</div>';
            return;
        }

        let docNodes = (nodes || []).filter(n => n.kind === 'document');
        const folderNodes = (nodes || []).filter(n => n.kind === 'folder');
        docNodes = docNodes.filter(d => {
            const ext = d.name.substring(d.name.lastIndexOf('.')).toLowerCase();
            return ['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.bmp'].includes(ext);
        });

        const search = String(state.imagesDocsSearch || '').trim().toLowerCase();
        if (search) {
            docNodes = docNodes.filter(d => (d.title || d.name || '').toLowerCase().includes(search));
        }

        if (docNodes.length === 0 && (search || !folderPaths || folderPaths.length === 0)) {
            docList.innerHTML = '<div class="empty-state" style="padding: 12px; font-size: 12px; color: var(--text-secondary);">No matching image files found.</div>';
            return;
        }

        renderFolderGroupedDocs(docList, docNodes, folderNodes, folderPaths, search, (doc) => createImageDocCard(doc), 'images');
    }

    function createImageDocCard(doc) {
        return renderDocCard({
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
    }

    function renderDocCard({ title, subtitle, sourceId, nodeId, nodeMetadata, actions, isSelected, clickHandler }) {
        const wrapper = document.createElement('div');
        wrapper.className = 'tree-node';
        if (isSelected) {
            wrapper.classList.add('selected');
        }
        wrapper.dataset.sourceId = sourceId || '';
        wrapper.dataset.nodeId = nodeId || '';
        wrapper.dataset.docId = nodeId || '';
        wrapper.dataset.kind = 'document';
        wrapper.dataset.name = title;
        if (nodeMetadata) {
            if (nodeMetadata.root) wrapper.dataset.root = nodeMetadata.root;
            if (nodeMetadata.sourceFolder) wrapper.dataset.sourceFolder = nodeMetadata.sourceFolder;
            if (nodeMetadata.absolutePath) wrapper.dataset.absolutePath = nodeMetadata.absolutePath;
        }

        const cardText = document.createElement('div');
        cardText.className = 'card-text';

        const cardTitle = document.createElement('div');
        cardTitle.className = 'card-title';
        cardTitle.textContent = title;
        cardText.appendChild(cardTitle);

        if (subtitle && subtitle !== title) {
            const cardSubtitle = document.createElement('div');
            cardSubtitle.className = 'card-subtitle';
            cardSubtitle.textContent = subtitle;
            cardText.appendChild(cardSubtitle);
        }

        wrapper.appendChild(cardText);

        if (actions && actions.length > 0) {
            const cardActions = document.createElement('div');
            cardActions.className = 'card-actions';

            actions.forEach(action => {
                const btn = document.createElement('button');
                if (action === 'Link Doc') {
                    btn.className = 'card-icon-btn html-link-btn';
                    btn.innerHTML = '<span class="btn-label">Link</span>';
                    btn.title = 'Copy validated document path';
                } else if (action === 'Serve & Open') {
                    btn.className = 'card-icon-btn html-serve-btn';
                    btn.innerHTML = '<span class="btn-label">Open</span>';
                    btn.title = 'Start local server and open in browser';
                } else {
                    btn.className = 'planning-card-btn';
                    btn.textContent = action;
                }

                btn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    if (action === 'Set Context') {
                        // Activates the kanban "Design Doc Reference" add-on with this doc
                        const statusDesign = document.getElementById('status-design');
                        if (statusDesign) {
                            statusDesign.textContent = 'Setting as active design doc...';
                            statusDesign.style.color = '';
                        }
                        vscode.postMessage({
                            type: 'setActivePlanningContext',
                            sourceId,
                            docId: nodeId,
                            docName: title,
                            sourceFolder: nodeMetadata ? nodeMetadata.sourceFolder : undefined
                        });
                    } else if (action === 'Link Doc') {
                        vscode.postMessage({
                            type: 'linkToDocument',
                            sourceId,
                            docId: nodeId,
                            docName: title,
                            sourceFolder: nodeMetadata?.sourceFolder
                        });
                    } else if (action === 'Serve & Open') {
                        vscode.postMessage({
                            type: 'serveAndOpenHtml',
                            docId: nodeId,
                            docName: title,
                            absolutePath: nodeMetadata?.absolutePath,
                            sourceFolder: nodeMetadata?.sourceFolder
                        });
                    }
                });

                cardActions.appendChild(btn);
            });
            wrapper.appendChild(cardActions);
        }

        if (clickHandler) {
            wrapper.addEventListener('click', (e) => {
                clickHandler(wrapper, e);
            });
        }
        return wrapper;
    }

    // ── Load Previews ──
    function loadDocumentPreview(sourceId, docId, docName) {
        if (state.selectedEl) {
            state.selectedEl.classList.remove('selected');
        }
        const wrapper = findTreeNode(sourceId, docId);
        const sourceFolder = wrapper ? wrapper.dataset.sourceFolder : undefined;
        if (wrapper) {
            wrapper.classList.add('selected');
            state.selectedEl = wrapper;
        }
        state.activeSource = sourceId;
        state.activeDocId = docId;
        state.activeDocName = docName;
        state.previewRequestId++;

        if (sourceId === 'html-folder') {
            // Copy Link / Open in Browser live on each file's sidebar card (Link / Open),
            // not in the top bar — no top-bar buttons to wire here.
            const statusHtml = document.getElementById('status-html');
            if (statusHtml) statusHtml.textContent = 'Loading...';

            const initialState = document.getElementById('html-initial-state');
            const loadingState = document.getElementById('html-loading-state');
            const previewFrame = document.getElementById('html-preview-frame');
            const imageContainer = document.getElementById('image-preview-container');
            const iframeWrapper = document.getElementById('html-preview-wrapper');
            if (initialState) initialState.style.display = 'none';
            if (loadingState) loadingState.style.display = 'flex';
            if (iframeWrapper) iframeWrapper.style.display = 'none';
            if (imageContainer) imageContainer.style.display = 'none';

            vscode.postMessage({
                type: 'fetchPreview',
                sourceId,
                docId,
                requestId: state.previewRequestId,
                sourceFolder
            });
        } else if (sourceId === 'images-folder') {
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
        } else if (sourceId === 'design-folder') {
            if (state.designEditMode) exitDesignEditMode();
            state.activeDocSourceFolder = sourceFolder || null;
            updateDesignDocControls();

            const statusDesign = document.getElementById('status-design');
            if (statusDesign) statusDesign.textContent = 'Loading...';

            const previewDesign = document.getElementById('markdown-preview-design');
            if (previewDesign) {
                previewDesign.innerHTML = '<div class="empty-state">Loading preview...</div>';
                previewDesign.style.display = 'block';
            }
            const imageContainerDesign = document.getElementById('image-preview-container-design');
            if (imageContainerDesign) imageContainerDesign.style.display = 'none';

            vscode.postMessage({
                type: 'fetchPreview',
                sourceId,
                docId,
                requestId: state.previewRequestId,
                sourceFolder
            });
        } else if (sourceId === 'briefs-folder') {
            if (state.briefEditMode) exitBriefEditMode();
            state.activeBriefSourceId = sourceId;
            state.activeBriefDocId = docId;
            state.activeDocSourceFolder = sourceFolder || null;
            updateBriefDocControls();

            const statusBriefs = document.getElementById('status-briefs');
            if (statusBriefs) statusBriefs.textContent = 'Loading...';

            const previewBriefs = document.getElementById('markdown-preview-briefs');
            if (previewBriefs) {
                previewBriefs.innerHTML = '<div class="empty-state">Loading preview...</div>';
                previewBriefs.style.display = 'block';
            }

            vscode.postMessage({
                type: 'fetchPreview',
                sourceId,
                docId,
                requestId: state.previewRequestId,
                sourceFolder
            });
        }
    }

    function handlePreviewReady(msg) {
        const { sourceId, requestId, content, docName, isAutoRefreshed, filePath, htmlContent, webviewUri, isImage } = msg;

        if (msg.target === 'claude') {
            if (requestId !== undefined && requestId !== -1 && requestId !== state.previewRequestId) return;
            resetZoom('claude');

            const initialState = document.getElementById('claude-initial-state');
            const loadingState = document.getElementById('claude-loading-state');
            if (initialState) initialState.style.display = 'none';
            if (loadingState) loadingState.style.display = 'none';

            const iframe = document.getElementById('claude-preview-frame');
            const iframeWrapper = document.getElementById('claude-preview-wrapper');
            const imageContainer = document.getElementById('image-preview-container-claude');
            const imageImg = document.getElementById('image-preview-img-claude');

            if (isImage && webviewUri) {
                if (iframeWrapper) iframeWrapper.style.display = 'none';
                if (iframe) { iframe.removeAttribute('src'); iframe.removeAttribute('srcdoc'); }
                if (imageContainer) { imageContainer.style.display = 'flex'; }
                const imgViewport = imageContainer ? imageContainer.querySelector('.zoomable-viewport') : null;
                if (imgViewport) applyZoom('claude', imgViewport);
                if (imageImg) {
                    imageImg.src = webviewUri + '?t=' + Date.now();
                    imageImg.onload = () => {
                        const container = document.getElementById('image-preview-container-claude');
                        const viewport = container ? container.querySelector('.zoomable-viewport') : null;
                        if (container && viewport) fitToContainer('claude', container, viewport);
                    };
                }
            } else if (msg.iframeSrc) {
                if (imageContainer) imageContainer.style.display = 'none';
                if (imageImg) imageImg.removeAttribute('src');
                if (iframeWrapper) iframeWrapper.style.display = 'flex';
                if (iframe) {
                    iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin');
                    iframe.removeAttribute('srcdoc');
                    iframe.src = isAutoRefreshed ? msg.iframeSrc + '?t=' + Date.now() : msg.iframeSrc;
                }
                const iframeViewport = iframeWrapper ? iframeWrapper.querySelector('.zoomable-viewport') : null;
                if (iframeViewport) applyZoom('claude', iframeViewport);
                notifyIframeResize(iframe, iframeWrapper);
                if (iframe) iframe.addEventListener('load', () => notifyIframeResize(iframe, iframeWrapper), { once: true });
            } else if (htmlContent) {
                if (imageContainer) imageContainer.style.display = 'none';
                if (imageImg) imageImg.removeAttribute('src');
                if (iframeWrapper) iframeWrapper.style.display = 'flex';
                if (iframe) {
                    iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin');
                    iframe.removeAttribute('src');
                    iframe.removeAttribute('srcdoc');
                    iframe.srcdoc = injectBaseTag(htmlContent, webviewUri);
                    const iframeViewport = iframeWrapper ? iframeWrapper.querySelector('.zoomable-viewport') : null;
                    if (iframeViewport) applyZoom('claude', iframeViewport);
                }
                notifyIframeResize(iframe, iframeWrapper);
                if (iframe) iframe.addEventListener('load', () => notifyIframeResize(iframe, iframeWrapper), { once: true });
            }
            return;
        }

        if (sourceId === 'html-folder') {
            if (requestId !== undefined && requestId !== -1 && requestId !== state.previewRequestId) return;
            resetZoom('html');

            const initialState = document.getElementById('html-initial-state');
            const loadingState = document.getElementById('html-loading-state');
            if (initialState) initialState.style.display = 'none';
            if (loadingState) loadingState.style.display = 'none';

            const iframe = document.getElementById('html-preview-frame');
            const imageContainer = document.getElementById('image-preview-container');
            const imageImg = document.getElementById('image-preview-img');
            const iframeWrapper = document.getElementById('html-preview-wrapper');

            if (isImage && webviewUri) {
                if (iframeWrapper) iframeWrapper.style.display = 'none';
                if (iframe) { iframe.removeAttribute('src'); iframe.removeAttribute('srcdoc'); }
                if (imageContainer) { imageContainer.style.display = 'flex'; }
                const imgViewport = imageContainer ? imageContainer.querySelector('.zoomable-viewport') : null;
                if (imgViewport) applyZoom('html', imgViewport);
                if (imageImg) {
                    imageImg.src = webviewUri + '?t=' + Date.now();
                    imageImg.onload = () => {
                        const container = document.getElementById('image-preview-container');
                        const viewport = container ? container.querySelector('.zoomable-viewport') : null;
                        if (container && viewport) fitToContainer('html', container, viewport);
                    };
                }
            } else if (msg.iframeSrc) {
                if (iframeWrapper) iframeWrapper.style.display = 'flex';
                if (iframe) {
                    iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin');
                    iframe.removeAttribute('srcdoc');
                    iframe.src = isAutoRefreshed ? msg.iframeSrc + '?t=' + Date.now() : msg.iframeSrc;
                }
                if (imageContainer) imageContainer.style.display = 'none';
                if (imageImg) imageImg.removeAttribute('src');
                const iframeViewport = iframeWrapper ? iframeWrapper.querySelector('.zoomable-viewport') : null;
                if (iframeViewport) applyZoom('html', iframeViewport);
                notifyIframeResize(iframe, iframeWrapper);
                if (iframe) iframe.addEventListener('load', () => notifyIframeResize(iframe, iframeWrapper), { once: true });
            } else if (htmlContent) {
                if (iframeWrapper) iframeWrapper.style.display = 'flex';
                if (iframe) {
                    iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin');
                    iframe.removeAttribute('src');
                    iframe.removeAttribute('srcdoc');
                    iframe.srcdoc = injectBaseTag(htmlContent, webviewUri);
                    const iframeViewport = iframeWrapper ? iframeWrapper.querySelector('.zoomable-viewport') : null;
                    if (iframeViewport) applyZoom('html', iframeViewport);
                }
                if (imageContainer) imageContainer.style.display = 'none';
                if (imageImg) imageImg.removeAttribute('src');
                notifyIframeResize(iframe, iframeWrapper);
                if (iframe) iframe.addEventListener('load', () => notifyIframeResize(iframe, iframeWrapper), { once: true });
            }
            const statusHtml = document.getElementById('status-html');
            if (statusHtml) {
                // Filename is shown on the selected sidebar card — don't echo it here.
                statusHtml.textContent = isAutoRefreshed ? 'Auto-refreshed' : '';
                statusHtml.style.color = 'var(--accent-teal)';
            }
        } else if (sourceId === 'images-folder') {
            if (requestId !== undefined && requestId !== -1 && requestId !== state.previewRequestId) return;
            resetZoom('images');

            const initialState = document.getElementById('images-initial-state');
            const loadingState = document.getElementById('images-loading-state');
            if (initialState) initialState.style.display = 'none';
            if (loadingState) loadingState.style.display = 'none';

            const imageContainer = document.getElementById('image-preview-container-images');
            const imageImg = document.getElementById('image-preview-img-images');

            if (isImage && webviewUri) {
                if (imageContainer) { imageContainer.style.display = 'flex'; }
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
                // Filename is shown on the selected sidebar card — don't echo it here.
                statusImages.textContent = '';
                statusImages.style.color = 'var(--accent-teal)';
            }
        } else if (sourceId === 'design-folder') {
            if (requestId !== undefined && requestId !== -1 && requestId !== state.previewRequestId) return;
            resetZoom('design');

            state.activeDocFilePath = filePath || null;
            state.activeFileType = msg.fileType || null;
            state.activeDocContent = isImage ? null : (content || '');
            updateDesignDocControls();

            const mdPrev = document.getElementById('markdown-preview-design');
            const imgCont = document.getElementById('image-preview-container-design');
            const imgImg = document.getElementById('image-preview-img-design');
            const jsonCont = document.getElementById('json-preview-container-design');
            const statusDesign = document.getElementById('status-design');

            if (isImage && webviewUri) {
                if (mdPrev) mdPrev.style.display = 'none';
                if (jsonCont) jsonCont.style.display = 'none';
                if (imgCont) imgCont.style.display = 'flex';
                if (imgImg) imgImg.src = webviewUri + '?t=' + Date.now();
                const designImgViewport = imgCont ? imgCont.querySelector('.zoomable-viewport') : null;
                if (designImgViewport) applyZoom('design', designImgViewport);
                if (imgImg) {
                    imgImg.onload = () => {
                        const container = document.getElementById('image-preview-container-design');
                        const viewport = container ? container.querySelector('.zoomable-viewport') : null;
                        if (container && viewport) fitToContainer('design', container, viewport);
                    };
                }
            } else if (msg.fileType === 'json') {
                if (imgCont) imgCont.style.display = 'none';
                if (mdPrev) mdPrev.style.display = 'none';
                if (jsonCont) {
                    jsonCont.style.display = 'block';
                    jsonCont.innerHTML = '';
                    try {
                        jsonCont.appendChild(renderJsonTree(JSON.parse(content)));
                    } catch (e) {
                        jsonCont.innerHTML = `<div class="json-error">Failed to parse JSON: ${e.message}</div>`;
                    }
                }
            } else if (msg.fileType === 'yaml') {
                if (imgCont) imgCont.style.display = 'none';
                if (mdPrev) mdPrev.style.display = 'none';
                if (jsonCont) {
                    jsonCont.style.display = 'block';
                    jsonCont.innerHTML = '';
                    if (msg.parsedJson !== undefined) {
                        try {
                            jsonCont.appendChild(renderJsonTree(msg.parsedJson));
                        } catch (e) {
                            jsonCont.innerHTML = `<div class="json-error">Failed to render YAML tree: ${e.message}</div>`;
                        }
                    } else {
                        jsonCont.innerHTML = `<div class="json-error">Invalid YAML on disk — cannot render tree.</div>`;
                    }
                }
            } else {
                // Markdown/Text
                if (imgCont) imgCont.style.display = 'none';
                if (jsonCont) jsonCont.style.display = 'none';
                if (mdPrev) {
                    mdPrev.style.display = 'block';
                    mdPrev.innerHTML = renderMarkdown(content) || '';
                }
            }

            if (statusDesign) {
                statusDesign.textContent = isAutoRefreshed ? 'Auto-refreshed' : 'Loaded';
                statusDesign.style.color = 'var(--accent-teal)';
            }
        } else if (sourceId === 'briefs-folder') {
            if (requestId !== undefined && requestId !== -1 && requestId !== state.previewRequestId) return;

            state.activeDocFilePath = filePath || null;
            state.activeFileType = msg.fileType || null;
            state.activeDocContent = content || '';
            updateBriefDocControls();

            const mdPrev = document.getElementById('markdown-preview-briefs');
            const statusBriefs = document.getElementById('status-briefs');

            if (mdPrev) {
                mdPrev.style.display = 'block';
                mdPrev.innerHTML = renderMarkdown(content) || '';
            }

            if (statusBriefs) {
                statusBriefs.textContent = isAutoRefreshed ? 'Auto-refreshed' : 'Loaded';
                statusBriefs.style.color = 'var(--accent-teal)';
            }
        }
    }

    // ── Design Doc Controls (controls strip: Set Active / Link / Edit / Save / Cancel) ──
    function updateDesignDocControls() {
        const hasDoc = state.activeSource === 'design-folder' && !!state.activeDocId;

        const docExt = (state.activeDocId || '').substring((state.activeDocId || '').lastIndexOf('.')).toLowerCase();
        const isImage = ['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.bmp'].includes(docExt) || state.activeFileType === 'image';

        const isActiveDoc = hasDoc && state.designSystemDocEnabled &&
            state.designSystemDocSourceId === state.activeSource &&
            state.designSystemDocId === state.activeDocId;

        const btnSet = document.getElementById('btn-set-active-context-design');
        const btnLink = document.getElementById('btn-link-to-doc-design');
        const btnEdit = document.getElementById('btn-edit-design');

        if (btnSet) {
            btnSet.disabled = !hasDoc;
            btnSet.textContent = isActiveDoc ? 'Turn off' : 'Set as Active Design Doc';
            btnSet.dataset.active = isActiveDoc ? 'true' : 'false';
        }
        if (btnLink) btnLink.disabled = !hasDoc;
        if (btnEdit) btnEdit.disabled = !hasDoc || isImage || state.designEditMode;
    }

    function enterDesignEditMode() {
        const previewPane = document.getElementById('preview-pane-design');
        const textarea = document.getElementById('markdown-editor-design');
        if (!previewPane || !textarea) return;

        state.designEditOriginalContent = state.activeDocContent || '';
        textarea.value = state.designEditOriginalContent;
        previewPane.classList.add('edit-mode');

        const btnEdit = document.getElementById('btn-edit-design');
        const btnSave = document.getElementById('btn-save-design');
        const btnCancel = document.getElementById('btn-cancel-design');
        if (btnEdit) btnEdit.style.display = 'none';
        if (btnSave) btnSave.style.display = '';
        if (btnCancel) btnCancel.style.display = '';

        state.designEditMode = true;
        updateDesignDocControls();
    }

    function exitDesignEditMode() {
        const previewPane = document.getElementById('preview-pane-design');
        if (previewPane) previewPane.classList.remove('edit-mode');

        const btnEdit = document.getElementById('btn-edit-design');
        const btnSave = document.getElementById('btn-save-design');
        const btnCancel = document.getElementById('btn-cancel-design');
        if (btnEdit) btnEdit.style.display = '';
        if (btnSave) btnSave.style.display = 'none';
        if (btnCancel) btnCancel.style.display = 'none';

        state.designEditMode = false;
        updateDesignDocControls();
    }

    (function initDesignDocControls() {
        const btnSet = document.getElementById('btn-set-active-context-design');
        const btnLink = document.getElementById('btn-link-to-doc-design');
        const btnEdit = document.getElementById('btn-edit-design');
        const btnSave = document.getElementById('btn-save-design');
        const btnCancel = document.getElementById('btn-cancel-design');

        if (btnSet) {
            btnSet.addEventListener('click', () => {
                if (!state.activeSource || !state.activeDocId) return;
                if (btnSet.dataset.active === 'true') {
                    vscode.postMessage({ type: 'disableDesignDoc', docType: 'design-system' });
                    return;
                }
                btnSet.disabled = true;
                const statusDesign = document.getElementById('status-design');
                if (statusDesign) {
                    statusDesign.textContent = 'Setting as active design doc...';
                    statusDesign.style.color = '';
                }
                const wrapper = findTreeNode(state.activeSource, state.activeDocId);
                const sourceFolder = wrapper ? wrapper.dataset.sourceFolder : state.activeDocSourceFolder;
                vscode.postMessage({
                    type: 'setActivePlanningContext',
                    sourceId: state.activeSource,
                    docId: state.activeDocId,
                    docName: state.activeDocName || state.activeDocId,
                    sourceFolder
                });
            });
        }
        if (btnLink) {
            btnLink.addEventListener('click', () => {
                if (!state.activeSource || !state.activeDocId) return;
                const wrapper = findTreeNode(state.activeSource, state.activeDocId);
                const sourceFolder = wrapper ? wrapper.dataset.sourceFolder : state.activeDocSourceFolder;
                vscode.postMessage({
                    type: 'linkToDocument',
                    sourceId: state.activeSource,
                    docId: state.activeDocId,
                    docName: state.activeDocName || state.activeDocId,
                    sourceFolder
                });
            });
        }
        if (btnEdit) {
            btnEdit.addEventListener('click', () => enterDesignEditMode());
        }
        if (btnSave) {
            btnSave.addEventListener('click', () => {
                const filePath = state.activeDocFilePath;
                const editor = document.getElementById('markdown-editor-design');
                if (!filePath || !editor) return;
                vscode.postMessage({
                    type: 'saveFileContent',
                    filePath,
                    content: editor.value,
                    originalContent: state.designEditOriginalContent,
                    tab: 'design'
                });
            });
        }
        if (btnCancel) {
            btnCancel.addEventListener('click', () => exitDesignEditMode());
        }
    })();

    function updateBriefDocControls() {
        const hasDoc = state.activeBriefSourceId === 'briefs-folder' && !!state.activeBriefDocId;
        const btnEdit = document.getElementById('btn-edit-brief');
        const btnDelete = document.getElementById('btn-delete-brief');
        
        if (btnEdit) btnEdit.disabled = !hasDoc || state.briefEditMode;
        if (btnDelete) btnDelete.disabled = !hasDoc;
        const btnSendToStitch = document.getElementById('btn-send-brief-to-stitch');
        if (btnSendToStitch) btnSendToStitch.disabled = !hasDoc || state.briefEditMode;
    }

    function enterBriefEditMode() {
        const previewPane = document.getElementById('preview-pane-briefs');
        const textarea = document.getElementById('markdown-editor-briefs');
        if (!previewPane || !textarea) return;

        state.briefEditOriginalContent = state.activeDocContent || '';
        textarea.value = state.briefEditOriginalContent;
        previewPane.classList.add('edit-mode');

        const btnEdit = document.getElementById('btn-edit-brief');
        const btnSave = document.getElementById('btn-save-brief');
        const btnCancel = document.getElementById('btn-cancel-brief');
        if (btnEdit) btnEdit.style.display = 'none';
        if (btnSave) btnSave.style.display = '';
        if (btnCancel) btnCancel.style.display = '';

        state.briefEditMode = true;
        updateBriefDocControls();
    }

    function exitBriefEditMode() {
        const previewPane = document.getElementById('preview-pane-briefs');
        if (previewPane) previewPane.classList.remove('edit-mode');

        const btnEdit = document.getElementById('btn-edit-brief');
        const btnSave = document.getElementById('btn-save-brief');
        const btnCancel = document.getElementById('btn-cancel-brief');
        if (btnEdit) btnEdit.style.display = '';
        if (btnSave) btnSave.style.display = 'none';
        if (btnCancel) btnCancel.style.display = 'none';

        state.briefEditMode = false;
        updateBriefDocControls();
    }

    (function initBriefDocControls() {
        const btnEdit = document.getElementById('btn-edit-brief');
        const btnSave = document.getElementById('btn-save-brief');
        const btnCancel = document.getElementById('btn-cancel-brief');
        const btnNew = document.getElementById('btn-new-brief');
        const btnDelete = document.getElementById('btn-delete-brief');

        if (btnEdit) {
            btnEdit.addEventListener('click', () => enterBriefEditMode());
        }
        if (btnSave) {
            btnSave.addEventListener('click', () => {
                const filePath = state.activeDocFilePath;
                const editor = document.getElementById('markdown-editor-briefs');
                if (!filePath || !editor) return;
                vscode.postMessage({
                    type: 'saveFileContent',
                    filePath,
                    content: editor.value,
                    originalContent: state.briefEditOriginalContent,
                    tab: 'briefs'
                });
            });
        }
        if (btnCancel) {
            btnCancel.addEventListener('click', () => exitBriefEditMode());
        }
        if (btnNew) {
            btnNew.addEventListener('click', () => {
                const title = 'untitled-brief';
                const root = state.briefsWorkspaceRootFilter || Object.keys(state.briefsFolderPathsByRoot)[0];
                if (!root) {
                    const statusBriefs = document.getElementById('status-briefs');
                    if (statusBriefs) {
                        statusBriefs.textContent = 'Please configure at least one briefs folder first.';
                        statusBriefs.style.color = '#ff6b6b';
                        setTimeout(() => { statusBriefs.textContent = ''; }, 3000);
                    }
                    return;
                }
                const folders = state.briefsFolderPathsByRoot[root] || [];
                if (folders.length === 0) {
                    const statusBriefs = document.getElementById('status-briefs');
                    if (statusBriefs) {
                        statusBriefs.textContent = 'Please configure at least one briefs folder first.';
                        statusBriefs.style.color = '#ff6b6b';
                        setTimeout(() => { statusBriefs.textContent = ''; }, 3000);
                    }
                    return;
                }
                const sourceFolder = folders[0];
                vscode.postMessage({
                    type: 'createBrief',
                    workspaceRoot: root,
                    sourceFolder,
                    title
                });
            });
        }
        if (btnDelete) {
            btnDelete.addEventListener('click', () => {
                if (!state.activeBriefSourceId || !state.activeBriefDocId) return;
                const wrapper = findTreeNode(state.activeBriefSourceId, state.activeBriefDocId);
                const sourceFolder = wrapper ? wrapper.dataset.sourceFolder : state.activeDocSourceFolder;
                vscode.postMessage({
                    type: 'deleteBrief',
                    docId: state.activeBriefDocId,
                    sourceFolder
                });
            });
        }
    })();

    // ── Stitch UI Controls ──
    const stitchProjectSelect = document.getElementById('stitch-project-select');
    const designSystemProjectSelect = document.getElementById('design-system-project-select');
    const btnDownloadPalette = document.getElementById('btn-download-palette');
    const stitchPromptInput = document.getElementById('stitch-prompt-input');
    const stitchDeviceSelect = document.getElementById('stitch-device-select');
    const stitchModelSelect = document.getElementById('stitch-model-select');
    const stitchCreativeRangeSelect = document.getElementById('stitch-creative-range-select');
    const stitchAspectsCheckboxesContainer = document.getElementById('stitch-aspects-checkboxes');
    const btnGenerateStitch = document.getElementById('btn-generate-stitch');
    const stitchGallery = document.getElementById('stitch-gallery');
    const stitchGalleryEmpty = document.getElementById('stitch-gallery-empty');
    const stitchApiBanner = document.getElementById('stitch-api-banner');
    const stitchApiKeyInput = document.getElementById('stitch-api-key-input');
    const btnSaveStitchApiKey = document.getElementById('btn-save-stitch-api-key');
    const statusStitch = document.getElementById('status-stitch');
    const btnNewStitchProject = document.getElementById('btn-new-stitch-project');
    const btnRefreshStitchProjects = document.getElementById('btn-refresh-stitch-projects');
    const btnRebuildStitchCache = document.getElementById('btn-rebuild-stitch-cache');
    const btnForceReloadScreens = document.getElementById('btn-force-reload-screens');
    const btnOpenDesignMd = document.getElementById('btn-open-design-md');

    function saveState() {
        vscode.setState({
            ...vscode.getState(),
            designPreviewCollapsed: state.designPreviewCollapsed,
            htmlPreviewCollapsed: state.htmlPreviewCollapsed,
            claudePreviewCollapsed: state.claudePreviewCollapsed,
            imagesPreviewCollapsed: state.imagesPreviewCollapsed,
            briefsPreviewCollapsed: state.briefsPreviewCollapsed,
            stitchThumbnailStripCollapsed: state.stitchThumbnailStripCollapsed
        });
    }

    const stitchPreviewPane = document.getElementById('stitch-preview-pane');
    const previewImage = document.getElementById('preview-image');
    const previewImagePlaceholder = document.getElementById('preview-image-placeholder');
    const previewScreenTitle = document.getElementById('preview-screen-title');
    const previewScreenMeta = document.getElementById('preview-screen-meta');
    const btnClosePreview = document.getElementById('btn-close-preview');
    let previewBtnHtml = document.getElementById('preview-btn-html');
    let previewBtnPng = document.getElementById('preview-btn-png');
    let previewBtnOpenWeb = document.getElementById('preview-btn-open-web');
    const previewRefineInput = document.getElementById('preview-refine-input');
    let previewBtnEdit = document.getElementById('preview-btn-edit');
    let previewBtnVariants = document.getElementById('preview-btn-variants');
    let previewBtnReload = document.getElementById('preview-btn-reload');
    const stitchThumbnailStrip = document.getElementById('stitch-thumbnail-strip');

    if (stitchThumbnailStrip) {
        const stripCollapseBtn = stitchThumbnailStrip.querySelector('.strip-collapse-btn');
        if (stripCollapseBtn) {
            stripCollapseBtn.addEventListener('click', () => {
                const isCollapsed = stitchThumbnailStrip.classList.toggle('collapsed');
                state.stitchThumbnailStripCollapsed = isCollapsed;
                saveState();
                const arrow = stripCollapseBtn.querySelector('.strip-arrow');
                if (arrow) arrow.textContent = isCollapsed ? '▼' : '▲';
            });
        }
    }

    const btnStitchAttach = document.getElementById('btn-stitch-attach');

    // Single place that controls status colour — errors red, success teal,
    // everything else neutral. Direct .textContent writes left the colour
    // sticky-red after any error.
    function setStitchStatus(text, kind) {
        if (!statusStitch) return;
        statusStitch.textContent = text;
        statusStitch.style.color = kind === 'error' ? '#ff6b6b'
            : kind === 'success' ? 'var(--accent-teal)'
            : 'var(--text-secondary)';
    }

    // One Stitch operation at a time — double-clicking Variants used to queue
    // two SDK calls and silently generate twice as many screens. Generate and
    // Sync additionally require a selected project (the SDK cannot generate
    // outside a project — it does NOT auto-create one).
    function setStitchBusy(busy) {
        state.stitchBusy = busy;
        const hasProject = !!stitchProjectSelect.value;
        if (btnGenerateStitch) {
            btnGenerateStitch.disabled = busy || !hasProject;
            btnGenerateStitch.title = hasProject
                ? 'Generate a new screen in the selected project from the prompt'
                : 'Select a project (or click + New Project) first';
        }
        if (btnDownloadPalette) btnDownloadPalette.disabled = busy || !hasProject;
        if (btnOpenDesignMd) {
            btnOpenDesignMd.disabled = busy || !hasProject;
            btnOpenDesignMd.title = hasProject
                ? 'Open the DESIGN.md handoff file'
                : 'Select a project first';
        }
        if (btnNewStitchProject) btnNewStitchProject.disabled = busy;
        if (btnRefreshStitchProjects) btnRefreshStitchProjects.disabled = busy;
        if (btnRebuildStitchCache) btnRebuildStitchCache.disabled = busy || !hasProject;
        if (btnForceReloadScreens) btnForceReloadScreens.disabled = busy || !hasProject;
        if (stitchGallery) {
            stitchGallery.querySelectorAll('button').forEach(b => { b.disabled = busy; });
        }
        if (previewBtnHtml) previewBtnHtml.disabled = busy;
        if (previewBtnPng) previewBtnPng.disabled = busy;
        if (previewBtnEdit) previewBtnEdit.disabled = busy;
        if (previewBtnVariants) previewBtnVariants.disabled = busy;
        const previewBtnVariantsDropdownToggle = document.getElementById('preview-btn-variants-dropdown-toggle');
        if (previewBtnVariantsDropdownToggle) previewBtnVariantsDropdownToggle.disabled = busy;
        if (previewBtnReload) previewBtnReload.disabled = busy;

        if (btnStitchAttach) btnStitchAttach.disabled = busy;
    }

    function renderAttachedFileChips() {
        const container = document.getElementById('stitch-attached-files');
        if (!container) return;
        container.innerHTML = '';
        if (!state.stitchAttachedFiles || state.stitchAttachedFiles.length === 0) {
            container.style.display = 'none';
            return;
        }
        container.style.display = 'flex';
        state.stitchAttachedFiles.forEach((file, index) => {
            const chip = document.createElement('span');
            chip.className = 'stitch-attach-chip';
            const icon = document.createElement('span');
            icon.className = 'chip-icon';
            icon.textContent = file.type === 'image' ? '\u{1F5BC}' : file.type === 'html' ? '\u{1F310}' : '\u{1F4DD}';
            const name = document.createElement('span');
            name.textContent = file.name;
            const removeBtn = document.createElement('button');
            removeBtn.className = 'chip-remove';
            removeBtn.innerHTML = '&times;';
            removeBtn.title = 'Remove';
            removeBtn.addEventListener('click', () => {
                state.stitchAttachedFiles.splice(index, 1);
                renderAttachedFileChips();
            });
            chip.appendChild(icon);
            chip.appendChild(name);
            chip.appendChild(removeBtn);
            container.appendChild(chip);
        });
    }

    // Copy an on-disk asset path to the clipboard via the same linkToDocument handler the
    // "Copy Link" buttons in the other tabs use (sourceFolder + filename → resolved + copied).
    function copyStitchAssetLink(absPath) {
        if (!absPath) return;
        const idx = Math.max(absPath.lastIndexOf('/'), absPath.lastIndexOf('\\'));
        vscode.postMessage({
            type: 'linkToDocument',
            sourceFolder: idx >= 0 ? absPath.slice(0, idx) : '',
            docId: idx >= 0 ? absPath.slice(idx + 1) : absPath
        });
    }

    function makeFifeHighResUrl(imageUrl) {
        if (!imageUrl) return '';
        if (imageUrl.includes('/fife/') || imageUrl.includes('lh3.googleusercontent.com')) {
            if (imageUrl.includes('?')) return imageUrl;
            const cleanUrl = imageUrl.replace(/=[wsh]\d+(?:-[wsh]\d+)?$/, '');
            return cleanUrl + '=w1200';
        }
        return imageUrl;
    }

    function getStitchScreenPollKey(projectId, screenId, workspaceRoot) {
        return `${workspaceRoot || ''}::${projectId || ''}::${screenId || ''}`;
    }

    function clearStitchScreenPoll(projectId, screenId, workspaceRoot) {
        const key = getStitchScreenPollKey(projectId, screenId, workspaceRoot);
        if (state.stitchScreenPolls && state.stitchScreenPolls.has(key)) {
            const pollInfo = state.stitchScreenPolls.get(key);
            if (pollInfo.timerId) {
                clearTimeout(pollInfo.timerId);
            }
            state.stitchScreenPolls.delete(key);
        }
    }

    function clearAllStitchScreenPolls() {
        if (state.stitchScreenPolls) {
            for (const [key, pollInfo] of state.stitchScreenPolls.entries()) {
                if (pollInfo.timerId) {
                    clearTimeout(pollInfo.timerId);
                }
            }
            state.stitchScreenPolls.clear();
        }
    }

    function hasUsableStitchImage(screen) {
        return !!screen.imageUrl && screen.status !== 'FAILED';
    }

    function isScreenPollable(screen) {
        return !!screen.id &&
               (screen.projectId === state.selectedStitchProjectId || !screen.projectId) &&
               !screen.imageUrl &&
               screen.status !== 'FAILED';
    }

    function hasScreenStateChanged(newScreen, existingScreen) {
        if (!existingScreen) return true;
        return newScreen.imageUrl !== existingScreen.imageUrl ||
               newScreen.status !== existingScreen.status ||
               newScreen.statusMessage !== existingScreen.statusMessage;
    }

    function startMissingStitchScreenPolling(screens, reason) {
        const missing = screens.filter(isScreenPollable);
        missing.forEach(screen => {
            scheduleStitchScreenPoll(screen, { reason });
        });
    }

    function scheduleStitchScreenPoll(screen, options) {
        if (!screen || !screen.id || screen.status === 'FAILED') return;
        const projectId = screen.projectId || (stitchProjectSelect ? stitchProjectSelect.value : '');
        const workspaceRoot = state.stitchWorkspaceRoot;
        const key = getStitchScreenPollKey(projectId, screen.id, workspaceRoot);

        let pollInfo = state.stitchScreenPolls.get(key);
        if (pollInfo) {
            if (options && options.manual) {
                if (pollInfo.timerId) {
                    clearTimeout(pollInfo.timerId);
                }
                pollInfo.attempts = 0;
            } else if (options && options.hiddenRetry) {
                if (pollInfo.timerId) {
                    clearTimeout(pollInfo.timerId);
                }
            } else if (pollInfo.timerId) {
                // Active timer already scheduled; don't duplicate
                return;
            }
        } else {
            pollInfo = { attempts: 0, timerId: null };
            state.stitchScreenPolls.set(key, pollInfo);
        }

        if (pollInfo.attempts >= 6) {
            clearStitchScreenPoll(projectId, screen.id, workspaceRoot);
            if (!state.stitchProjectRefreshAttempted && state.selectedStitchProjectId === projectId && workspaceRoot) {
                state.stitchProjectRefreshAttempted = true;
                vscode.postMessage({
                    type: 'stitchGetProjectScreens',
                    projectId: state.selectedStitchProjectId,
                    workspaceRoot: workspaceRoot
                });
            }
            return;
        }

        const delay = Math.min(4 * Math.pow(2, pollInfo.attempts), 32);
        const delayMs = (options && options.immediate) ? 50 : delay * 1000;

        pollInfo.attempts += 1;

        pollInfo.timerId = setTimeout(() => {
            pollInfo.timerId = null;

            if (document.hidden) {
                // Defer until tab is visible without consuming an attempt
                pollInfo.attempts = Math.max(0, pollInfo.attempts - 1);
                pollInfo.timerId = setTimeout(() => {
                    pollInfo.timerId = null;
                    scheduleStitchScreenPoll(screen, options);
                }, 3000);
                return;
            }

            if (state.selectedStitchProjectId !== projectId || state.stitchWorkspaceRoot !== workspaceRoot) {
                clearStitchScreenPoll(projectId, screen.id, workspaceRoot);
                return;
            }

            vscode.postMessage({
                type: 'stitchRefreshScreen',
                projectId: projectId,
                screenId: screen.id,
                workspaceRoot: workspaceRoot
            });
        }, delayMs);
    }

    function openStitchPreview(screen) {
        if (!screen) return;
        state.activePreviewScreenId = screen.id;

        const generationStrip = document.getElementById('stitch-prompt-input')?.closest('.controls-strip');
        if (generationStrip) {
            generationStrip.style.display = 'none';
        }
        if (previewRefineInput) {
            previewRefineInput.placeholder = "Describe a change to edit this screen (Active Input)...";
        }
        updateDestinationDropdowns();

        if (stitchGallery) stitchGallery.style.display = 'none';
        if (stitchGalleryEmpty) stitchGalleryEmpty.style.display = 'none';
        if (stitchPreviewPane) {
            stitchPreviewPane.style.display = 'flex';
            if (screen.imageUrl) stitchPreviewPane.classList.remove('loading');
            else stitchPreviewPane.classList.add('loading');
        }
        if (stitchThumbnailStrip) {
            stitchThumbnailStrip.style.display = 'flex';
            if (state.stitchThumbnailStripCollapsed) stitchThumbnailStrip.classList.add('collapsed');
            else stitchThumbnailStrip.classList.remove('collapsed');
        }

        if (previewScreenTitle) previewScreenTitle.textContent = screen.name || 'Untitled Screen';
        if (previewScreenMeta) previewScreenMeta.textContent = `Device: ${screen.deviceType || 'AGNOSTIC'}`;

        if (screen.imageUrl) {
            if (previewImage) {
                previewImage.style.display = 'block';
                previewImage.src = makeFifeHighResUrl(screen.imageUrl);
                previewImage.onerror = () => {
                    previewImage.style.display = 'none';
                    previewImage.src = '';
                    if (previewImagePlaceholder) {
                        previewImagePlaceholder.style.display = 'flex';
                        // Update placeholder text to indicate the image failed
                        const label = previewImagePlaceholder.querySelector('span');
                        if (label) label.textContent = 'Preview failed to load';
                    }
                    // Trigger an automatic reload attempt
                    scheduleStitchScreenPoll(screen, { reason: 'image-error', immediate: true });
                };
            }
            if (previewImagePlaceholder) previewImagePlaceholder.style.display = 'none';
        } else {
            if (previewImage) {
                previewImage.style.display = 'none';
                previewImage.src = '';
            }
            if (previewImagePlaceholder) {
                previewImagePlaceholder.style.display = 'flex';
                const label = previewImagePlaceholder.querySelector('span');
                if (label) {
                    if (screen.status === 'FAILED') {
                        label.textContent = 'Rendering failed';
                    } else if (screen.status === 'IN_PROGRESS' || !screen.status) {
                        label.textContent = 'Preview not ready yet — still rendering';
                    }
                }
                const reloadBtn = previewImagePlaceholder.querySelector('button');
                if (reloadBtn) {
                    const newReloadBtn = reloadBtn.cloneNode(true);
                    reloadBtn.parentNode.replaceChild(newReloadBtn, reloadBtn);
                    previewBtnReload = newReloadBtn;
                    newReloadBtn.addEventListener('click', () => {
                        if (state.stitchBusy) return;
                        clearStitchScreenPoll(screen.projectId || (stitchProjectSelect ? stitchProjectSelect.value : ''), screen.id, state.stitchWorkspaceRoot);
                        scheduleStitchScreenPoll(screen, { immediate: true, manual: true });
                    });
                }
            }
        }

        if (previewBtnHtml) {
            const newHtmlBtn = previewBtnHtml.cloneNode(true);
            previewBtnHtml.parentNode.replaceChild(newHtmlBtn, previewBtnHtml);
            previewBtnHtml = newHtmlBtn;
            previewBtnHtml.addEventListener('click', () => {
                const destSelect = document.getElementById('preview-destination-select');
                const destination = destSelect ? destSelect.value : '';
                vscode.postMessage({
                    type: 'stitchDownloadAsset',
                    url: screen.htmlUrl,
                    filename: `${screen.id}.html`,
                    screenId: screen.id,
                    destination,
                    workspaceRoot: state.stitchWorkspaceRoot
                });
            });
        }
        // The PNG is already saved on disk (one-and-done). Copy its path to the clipboard,
        // same as the "Copy Link" buttons in the HTML Previews / Images tabs.
        if (previewBtnPng) {
            const newPngBtn = previewBtnPng.cloneNode(true);
            previewBtnPng.parentNode.replaceChild(newPngBtn, previewBtnPng);
            previewBtnPng = newPngBtn;
            previewBtnPng.disabled = !screen.imagePath;
            previewBtnPng.addEventListener('click', () => copyStitchAssetLink(screen.imagePath));
        }
        // "Open on Web" appears once the HTML has been downloaded (this session or a prior one).
        if (previewBtnOpenWeb) {
            const newOpenWebBtn = previewBtnOpenWeb.cloneNode(true);
            previewBtnOpenWeb.parentNode.replaceChild(newOpenWebBtn, previewBtnOpenWeb);
            previewBtnOpenWeb = newOpenWebBtn;
            previewBtnOpenWeb.style.display = screen.htmlPath ? '' : 'none';
            previewBtnOpenWeb.addEventListener('click', () => {
                if (!screen.htmlPath) return;
                vscode.postMessage({
                    type: 'serveAndOpenHtml',
                    docName: `${screen.name || screen.id}.html`,
                    absolutePath: screen.htmlPath
                });
            });
        }

        if (previewBtnEdit) {
            const newEditBtn = previewBtnEdit.cloneNode(true);
            previewBtnEdit.parentNode.replaceChild(newEditBtn, previewBtnEdit);
            previewBtnEdit = newEditBtn;
            previewBtnEdit.addEventListener('click', () => {
                if (state.stitchBusy) return;
                const prompt = previewRefineInput ? previewRefineInput.value.trim() : '';
                if (!prompt) { setStitchStatus('Type a change in the box above, then Apply Edit.', 'error'); return; }
                clearAllStitchScreenPolls();
                setStitchStatus('Editing screen…', 'busy');
                setStitchBusy(true);
                vscode.postMessage({
                    type: 'stitchEdit',
                    screenId: screen.id,
                    prompt,
                    modelId: state.stitchModelId,
                    workspaceRoot: state.stitchWorkspaceRoot
                });
            });
        }
        if (previewBtnVariants) {
            const newVariantsBtn = previewBtnVariants.cloneNode(true);
            previewBtnVariants.parentNode.replaceChild(newVariantsBtn, previewBtnVariants);
            previewBtnVariants = newVariantsBtn;
            previewBtnVariants.addEventListener('click', () => {
                if (state.stitchBusy) return;
                const prompt = previewRefineInput ? previewRefineInput.value.trim() : '';
                clearAllStitchScreenPolls();
                setStitchStatus('Generating 3 variants of this screen…', 'busy');
                setStitchBusy(true);

                let checkedAspects = [];
                if (stitchAspectsCheckboxesContainer) {
                    const checkboxes = stitchAspectsCheckboxesContainer.querySelectorAll('input[type="checkbox"]');
                    checkboxes.forEach(cb => {
                        if (cb.checked) {
                            checkedAspects.push(cb.value);
                        }
                    });
                } else {
                    checkedAspects = state.stitchAspects;
                }

                vscode.postMessage({
                    type: 'stitchVariants',
                    screenId: screen.id,
                    prompt: prompt || undefined,
                    count: 3,
                    creativeRange: state.stitchCreativeRange,
                    aspects: checkedAspects.length ? checkedAspects : undefined,
                    modelId: state.stitchModelId,
                    workspaceRoot: state.stitchWorkspaceRoot
                });
            });
        }

        renderThumbnailStrip(state.stitchScreens, screen.id);
    }

    function closeStitchPreview() {
        clearAllStitchScreenPolls();
        state.activePreviewScreenId = null;

        const generationStrip = document.getElementById('stitch-prompt-input')?.closest('.controls-strip');
        if (generationStrip) {
            generationStrip.style.display = 'flex';
        }
        if (stitchPromptInput) {
            stitchPromptInput.placeholder = "Describe the UI screen you want to generate (Active Input)...";
        }

        if (stitchPreviewPane) stitchPreviewPane.style.display = 'none';
        if (stitchThumbnailStrip) stitchThumbnailStrip.style.display = 'none';
        if (previewImage) previewImage.src = '';
        if (previewRefineInput) previewRefineInput.value = '';

        if (state.stitchScreens && state.stitchScreens.length > 0) {
            if (stitchGallery) stitchGallery.style.display = 'grid';
            if (stitchGalleryEmpty) stitchGalleryEmpty.style.display = 'none';
        } else {
            if (stitchGallery) stitchGallery.style.display = 'none';
            if (stitchGalleryEmpty) stitchGalleryEmpty.style.display = 'flex';
        }
    }

    function renderThumbnailStrip(screens, activeId) {
        if (!stitchThumbnailStrip) return;
        const wrapper = stitchThumbnailStrip.querySelector('.strip-thumbs-wrapper');
        if (wrapper) wrapper.innerHTML = '';
        else stitchThumbnailStrip.innerHTML = '';
        const countEl = stitchThumbnailStrip.querySelector('.strip-count');
        const arrowEl = stitchThumbnailStrip.querySelector('.strip-arrow');
        const count = screens.length;
        if (countEl) countEl.textContent = count + (count === 1 ? ' screen' : ' screens');
        if (arrowEl) arrowEl.textContent = stitchThumbnailStrip.classList.contains('collapsed') ? '▼' : '▲';
        screens.forEach(screen => {
            const target = wrapper || stitchThumbnailStrip;
            if (screen.imageUrl) {
                const img = document.createElement('img');
                img.className = `stitch-strip-thumb${screen.id === activeId ? ' active' : ''}`;
                img.src = screen.imageUrl;
                img.alt = screen.name || screen.id;
                img.title = screen.name || 'Screen';
                img.addEventListener('click', () => {
                    openStitchPreview(screen);
                });
                target.appendChild(img);
            } else {
                const ph = document.createElement('div');
                ph.className = `stitch-strip-thumb-placeholder${screen.id === activeId ? ' active' : ''}`;
                ph.textContent = 'Rendering…';
                ph.addEventListener('click', () => {
                    openStitchPreview(screen);
                });
                target.appendChild(ph);
            }
        });
    }

    if (btnClosePreview) {
        btnClosePreview.addEventListener('click', closeStitchPreview);
    }

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            if (state.activePreviewScreenId) {
                closeStitchPreview();
                e.stopPropagation();
            }
        }
    });

    if (btnStitchAttach) {
        btnStitchAttach.addEventListener('click', () => {
            if (state.stitchBusy) return;
            vscode.postMessage({ type: 'stitchPickAttachFiles' });
        });
    }

    const btnSendBriefToStitch = document.getElementById('btn-send-brief-to-stitch');
    if (btnSendBriefToStitch) {
        btnSendBriefToStitch.addEventListener('click', () => {
            if (state.stitchBusy) return;
            const briefNode = (state._lastBriefsDocsMsg?.nodes || []).find(n => n.id === state.activeBriefDocId);
            const briefTitle = briefNode?.title || briefNode?.name || 'Untitled';
            const wrapper = findTreeNode(state.activeBriefSourceId, state.activeBriefDocId);
            const sourceFolder = wrapper ? wrapper.dataset.sourceFolder : state.activeDocSourceFolder;
            setStitchStatus('Creating Stitch project from brief…', 'busy');
            vscode.postMessage({
                type: 'stitchSendBrief',
                docId: state.activeBriefDocId,
                briefTitle,
                sourceFolder
            });
        });
    }

    if (btnNewStitchProject) {
        btnNewStitchProject.addEventListener('click', () => {
            if (state.stitchBusy) return;
            // Title is collected via a native VS Code input box on the host side.
            vscode.postMessage({ 
                type: 'stitchCreateProject',
                workspaceRoot: state.stitchWorkspaceRoot
            });
        });
    }

    if (btnRefreshStitchProjects) {
        btnRefreshStitchProjects.addEventListener('click', () => {
            if (state.stitchBusy) return;
            vscode.postMessage({
                type: 'stitchListProjects',
                forceRefresh: true,
                workspaceRoot: state.stitchWorkspaceRoot
            });
        });
    }

    if (btnRebuildStitchCache) {
        btnRebuildStitchCache.addEventListener('click', () => {
            const projectId = stitchProjectSelect ? stitchProjectSelect.value : '';
            if (!projectId || state.stitchBusy) return;
            vscode.postMessage({
                type: 'stitchRebuildImageCache',
                projectId,
                workspaceRoot: state.stitchWorkspaceRoot
            });
        });
    }

    if (btnForceReloadScreens) {
        btnForceReloadScreens.addEventListener('click', () => {
            const projectId = stitchProjectSelect ? stitchProjectSelect.value : '';
            if (!projectId || state.stitchBusy) return;
            setStitchBusy(true);
            vscode.postMessage({
                type: 'stitchForceReloadScreens',
                projectId,
                workspaceRoot: state.stitchWorkspaceRoot
            });
        });
    }

    if (btnOpenDesignMd) {
        btnOpenDesignMd.addEventListener('click', () => {
            vscode.postMessage({ 
                type: 'stitchOpenManifest',
                projectId: stitchProjectSelect ? stitchProjectSelect.value : undefined,
                workspaceRoot: state.stitchWorkspaceRoot
            });
        });
    }

    if (btnDownloadPalette) {
        btnDownloadPalette.addEventListener('click', () => {
            const projectId = stitchProjectSelect.value;
            if (!projectId || state.stitchBusy) return;
            const destSelect = document.getElementById('preview-destination-select');
            const destination = destSelect ? destSelect.value : '';
            vscode.postMessage({
                type: 'stitchDownloadPalette',
                projectId,
                destination,
                workspaceRoot: state.stitchWorkspaceRoot
            });
        });
    }

    if (btnSaveStitchApiKey && stitchApiKeyInput) {
        btnSaveStitchApiKey.addEventListener('click', () => {
            const apiKey = stitchApiKeyInput.value.trim();
            if (apiKey) {
                vscode.postMessage({ type: 'stitchSaveApiKey', apiKey });
                stitchApiBanner.style.display = 'none';
            }
        });
    }

    if (btnGenerateStitch) {
        btnGenerateStitch.addEventListener('click', () => {
            const prompt = stitchPromptInput.value.trim();
            const deviceType = stitchDeviceSelect.value;
            const projectId = stitchProjectSelect.value;
            if (!prompt) { setStitchStatus('Enter a prompt describing the screen first.', 'error'); return; }
            if (state.stitchBusy) return;

            clearAllStitchScreenPolls();
            setStitchStatus('Generating screen…', 'busy');
            setStitchBusy(true);

            vscode.postMessage({
                type: 'stitchGenerate',
                prompt,
                deviceType,
                projectId: projectId || undefined,
                modelId: state.stitchModelId,
                workspaceRoot: state.stitchWorkspaceRoot,
                attachedFiles: state.stitchAttachedFiles || []
            });
        });
    }

    if (stitchProjectSelect) {
        stitchProjectSelect.addEventListener('change', () => {
            const projectId = stitchProjectSelect.value;
            state.selectedStitchProjectId = projectId;
            if (designSystemProjectSelect) {
                designSystemProjectSelect.value = projectId;
            }
            if (state.stitchWorkspaceRoot) {
                persistTab('stitch.projectId', projectId, state.stitchWorkspaceRoot);
            }
            clearAllStitchScreenPolls();
            if (state.activePreviewScreenId) {
                closeStitchPreview();
            }
            if (projectId) {
                setStitchStatus('Loading project screens…', 'busy');
                setStitchBusy(true);
                vscode.postMessage({
                    type: 'stitchGetProjectScreens',
                    projectId,
                    workspaceRoot: state.stitchWorkspaceRoot
                });
            } else {
                setStitchBusy(false);
                renderStitchScreens([]);
            }
        });
    }

    if (designSystemProjectSelect) {
        designSystemProjectSelect.addEventListener('change', () => {
            const projectId = designSystemProjectSelect.value;
            state.selectedStitchProjectId = projectId;
            if (stitchProjectSelect) {
                stitchProjectSelect.value = projectId;
            }
            if (state.stitchWorkspaceRoot) {
                persistTab('stitch.projectId', projectId, state.stitchWorkspaceRoot);
            }
            refreshStitchDesignSystems();
        });
    }

    function populateStitchProjects(projects, defaultProjectId) {
        if (!stitchProjectSelect) return;

        const sortedProjects = [...projects].sort((a, b) => {
            const ta = a.updateTime ? new Date(a.updateTime).getTime() : 0;
            const tb = b.updateTime ? new Date(b.updateTime).getTime() : 0;
            return tb - ta;
        });

        // Only select if there's an explicit in-memory selection
        // Do NOT auto-select defaultProjectId or first project
        const current = state.selectedStitchProjectId || '';
        stitchProjectSelect.innerHTML = '<option value="">Select Project...</option>';
        if (designSystemProjectSelect) {
            designSystemProjectSelect.innerHTML = '<option value="">Select Project...</option>';
        }
        
        sortedProjects.forEach(p => {
            const opt = document.createElement('option');
            opt.value = p.id;
            opt.textContent = p.name || p.id;
            if (p.id === current) opt.selected = true;
            stitchProjectSelect.appendChild(opt);

            if (designSystemProjectSelect) {
                const optDS = document.createElement('option');
                optDS.value = p.id;
                optDS.textContent = p.name || p.id;
                if (p.id === current) optDS.selected = true;
                designSystemProjectSelect.appendChild(optDS);
            }
        });

        // Explicitly set value to prevent stale browser state
        stitchProjectSelect.value = current;
        if (designSystemProjectSelect) {
            designSystemProjectSelect.value = current;
        }
        
        // Update selectedStitchProjectId to whatever was selected
        state.selectedStitchProjectId = stitchProjectSelect.value;
    }

    function renderStitchScreens(screens) {
        state.stitchScreens = screens;
        if (!stitchGallery || !stitchGalleryEmpty) return;

        // If preview pane is active and screen is in the new list, update the active preview
        if (state.activePreviewScreenId) {
            const activeScreen = screens.find(s => s.id === state.activePreviewScreenId);
            if (activeScreen) {
                const isPreviewPaneVisible = stitchPreviewPane && (stitchPreviewPane.style.display === 'flex' || stitchPreviewPane.style.display === 'block');
                if (isPreviewPaneVisible) {
                    openStitchPreview(activeScreen);
                }
            } else {
                closeStitchPreview();
            }
        }

        // Hide preview pane if no project selected
        if (!state.selectedStitchProjectId) {
            if (stitchPreviewPane) stitchPreviewPane.style.display = 'none';
            if (stitchThumbnailStrip) stitchThumbnailStrip.style.display = 'none';
            stitchGallery.style.display = 'none';
            stitchGalleryEmpty.style.display = 'flex';
            return;
        }

        if (screens.length === 0) {
            stitchGallery.style.display = 'none';
            stitchGalleryEmpty.style.display = 'flex';
            return;
        }

        stitchGalleryEmpty.style.display = 'none';
        // Only show gallery if not actively previewing
        if (!state.activePreviewScreenId) {
            stitchGallery.style.display = 'grid';
        } else {
            stitchGallery.style.display = 'none';
        }
        stitchGallery.innerHTML = '';

        screens.forEach(screen => {
            const card = document.createElement('div');
            card.className = 'stitch-screen-card';
            card.dataset.screenId = screen.id;

            // Thumbnail — screens still rendering (or with expired temp URLs) have no
            // usable image; show a reload affordance instead of a broken-file icon.
            const makeThumbPlaceholder = () => {
                const ph = document.createElement('div');
                ph.className = 'stitch-thumb-placeholder';
                const label = document.createElement('span');
                label.textContent = 'Preview not ready yet';
                ph.appendChild(label);
                const btnReload = document.createElement('button');
                btnReload.className = 'strip-btn';
                btnReload.textContent = '↻ Reload Screen';
                btnReload.title = 'Re-fetch this screen from Stitch (picks up the rendered preview and fresh download links)';
                btnReload.addEventListener('click', () => {
                    if (state.stitchBusy) return;
                    clearStitchScreenPoll(screen.projectId || (stitchProjectSelect ? stitchProjectSelect.value : ''), screen.id, state.stitchWorkspaceRoot);
                    scheduleStitchScreenPoll(screen, { immediate: true, manual: true });
                });
                ph.appendChild(btnReload);
                return ph;
            };

            if (screen.imageUrl) {
                const img = document.createElement('img');
                img.className = 'stitch-screen-thumbnail';
                img.src = screen.imageUrl;
                img.alt = screen.name || screen.id;
                img.title = 'Click to view preview';
                img.addEventListener('click', () => openStitchPreview(screen));
                img.addEventListener('error', () => {
                    img.replaceWith(makeThumbPlaceholder());
                    scheduleStitchScreenPoll(screen, { reason: 'image-error', immediate: true });
                }, { once: true });
                card.appendChild(img);
            } else {
                card.appendChild(makeThumbPlaceholder());
            }

            const info = document.createElement('div');
            info.className = 'stitch-screen-info';

            const title = document.createElement('div');
            title.className = 'stitch-screen-title';
            title.textContent = screen.name || 'Untitled Screen';
            title.title = screen.name || 'Untitled Screen';
            info.appendChild(title);

            const meta = document.createElement('div');
            meta.className = 'stitch-screen-meta';
            meta.textContent = `Device: ${screen.deviceType || 'AGNOSTIC'}`;
            info.appendChild(meta);
            card.appendChild(info);

            const actions = document.createElement('div');
            actions.className = 'stitch-screen-actions';

            // The PNG is already saved on disk — copy its path to the clipboard, same as the
            // "Copy Link" buttons in the HTML Previews / Images tabs.
            const btnPng = document.createElement('button');
            btnPng.className = 'strip-btn';
            btnPng.textContent = 'Copy Link';
            btnPng.disabled = !screen.imagePath;
            btnPng.title = 'Copy the image file path to the clipboard';
            btnPng.addEventListener('click', () => copyStitchAssetLink(screen.imagePath));
            actions.appendChild(btnPng);

            const btnHtml = document.createElement('button');
            btnHtml.className = 'strip-btn';
            btnHtml.textContent = 'DL HTML';
            btnHtml.title = "Download this screen's HTML into your stitch folder";
            btnHtml.addEventListener('click', () => {
                vscode.postMessage({
                    type: 'stitchDownloadAsset',
                    url: screen.htmlUrl,
                    filename: `${screen.id}.html`,
                    screenId: screen.id,
                    workspaceRoot: state.stitchWorkspaceRoot
                });
            });
            actions.appendChild(btnHtml);

            card.appendChild(actions);

            stitchGallery.appendChild(card);
        });
    }

    // Workspace change listeners
    document.getElementById('html-workspace-filter')?.addEventListener('change', (e) => {
        state.htmlWorkspaceRootFilter = e.target.value;
        persistTab('html.root', state.htmlWorkspaceRootFilter);
        const msg = state._lastHtmlDocsMsg || {};
        const filteredNodes = state.htmlWorkspaceRootFilter
            ? (msg.nodes || []).filter(n => n.metadata?.root === state.htmlWorkspaceRootFilter)
            : (msg.nodes || []);
        renderHtmlDocs({
            sourceId: msg.sourceId || 'html-folder',
            nodes: filteredNodes,
            folderPaths: getCurrentFolderPaths(state.htmlFolderPathsByRoot, state.htmlWorkspaceRootFilter),
            error: msg.error
        });
    });

    document.getElementById('claude-workspace-filter')?.addEventListener('change', (e) => {
        state.claudeWorkspaceRootFilter = e.target.value;
        persistTab('claude.root', state.claudeWorkspaceRootFilter);
        state.activeClaudeDocId = null;
        state.claudeTargetFolder = '';
        const msg = state._lastClaudeDocsMsg || {};
        const filteredNodes = state.claudeWorkspaceRootFilter
            ? (msg.nodes || []).filter(n => n.metadata?.root === state.claudeWorkspaceRootFilter)
            : (msg.nodes || []);
        renderClaudeDocs({
            sourceId: msg.sourceId || 'claude-folder',
            nodes: filteredNodes,
            folderPaths: getCurrentFolderPaths(state.claudeFolderPathsByRoot, state.claudeWorkspaceRootFilter),
            error: msg.error
        });
    });

    document.getElementById('images-workspace-filter')?.addEventListener('change', (e) => {
        state.imagesWorkspaceRootFilter = e.target.value;
        _restoredPanelState.panel['images.root'] = e.target.value;
        persistTab('images.root', state.imagesWorkspaceRootFilter);
        const msg = state._lastImagesDocsMsg || {};
        const filteredNodes = state.imagesWorkspaceRootFilter
            ? (msg.nodes || []).filter(n => n.metadata?.root === state.imagesWorkspaceRootFilter)
            : (msg.nodes || []);
        renderImagesDocs({
            sourceId: 'images-folder',
            nodes: filteredNodes,
            folderPaths: getCurrentFolderPaths(state.imagesFolderPathsByRoot, state.imagesWorkspaceRootFilter),
            error: msg.error
        });
    });

    document.getElementById('design-workspace-filter')?.addEventListener('change', (e) => {
        state.designWorkspaceRootFilter = e.target.value;
        persistTab('design.root', state.designWorkspaceRootFilter);
        const msg = state._lastDesignDocsMsg || {};
        const filteredNodes = state.designWorkspaceRootFilter
            ? (msg.nodes || []).filter(n => n.metadata?.root === state.designWorkspaceRootFilter)
            : (msg.nodes || []);
        renderDesignDocs({
            sourceId: msg.sourceId || 'design-folder',
            nodes: filteredNodes,
            folderPaths: getCurrentFolderPaths(state.designFolderPathsByRoot, state.designWorkspaceRootFilter)
        });
    });

    document.getElementById('briefs-workspace-filter')?.addEventListener('change', (e) => {
        state.briefsWorkspaceRootFilter = e.target.value;
        persistTab('briefs.root', state.briefsWorkspaceRootFilter);
        const msg = state._lastBriefsDocsMsg || {};
        const filteredNodes = state.briefsWorkspaceRootFilter
            ? (msg.nodes || []).filter(n => n.metadata?.root === state.briefsWorkspaceRootFilter)
            : (msg.nodes || []);
        renderBriefsDocs({
            sourceId: msg.sourceId || 'briefs-folder',
            nodes: filteredNodes,
            folderPaths: getCurrentFolderPaths(state.briefsFolderPathsByRoot, state.briefsWorkspaceRootFilter)
        });
    });

    document.getElementById('briefs-docs-search')?.addEventListener('input', (e) => {
        state.briefsDocsSearch = e.target.value;
        const msg = state._lastBriefsDocsMsg || {};
        const filteredNodes = state.briefsWorkspaceRootFilter
            ? (msg.nodes || []).filter(n => n.metadata?.root === state.briefsWorkspaceRootFilter)
            : (msg.nodes || []);
        renderBriefsDocs({
            sourceId: msg.sourceId || 'briefs-folder',
            nodes: filteredNodes,
            folderPaths: getCurrentFolderPaths(state.briefsFolderPathsByRoot, state.briefsWorkspaceRootFilter)
        });
    });

    // Search listeners
    document.getElementById('design-docs-search')?.addEventListener('input', (e) => {
        state.designDocsSearch = e.target.value;
        const msg = state._lastDesignDocsMsg || {};
        const filteredNodes = state.designWorkspaceRootFilter
            ? (msg.nodes || []).filter(n => n.metadata?.root === state.designWorkspaceRootFilter)
            : (msg.nodes || []);
        renderDesignDocs({
            sourceId: msg.sourceId || 'design-folder',
            nodes: filteredNodes,
            folderPaths: getCurrentFolderPaths(state.designFolderPathsByRoot, state.designWorkspaceRootFilter)
        });
    });

    document.getElementById('html-docs-search')?.addEventListener('input', (e) => {
        state.htmlDocsSearch = e.target.value;
        const msg = state._lastHtmlDocsMsg || {};
        const filteredNodes = state.htmlWorkspaceRootFilter
            ? (msg.nodes || []).filter(n => n.metadata?.root === state.htmlWorkspaceRootFilter)
            : (msg.nodes || []);
        renderHtmlDocs({
            sourceId: msg.sourceId || 'html-folder',
            nodes: filteredNodes,
            folderPaths: getCurrentFolderPaths(state.htmlFolderPathsByRoot, state.htmlWorkspaceRootFilter),
            error: msg.error
        });
    });

    document.getElementById('claude-docs-search')?.addEventListener('input', (e) => {
        state.claudeDocsSearch = e.target.value;
        const msg = state._lastClaudeDocsMsg || {};
        const filteredNodes = state.claudeWorkspaceRootFilter
            ? (msg.nodes || []).filter(n => n.metadata?.root === state.claudeWorkspaceRootFilter)
            : (msg.nodes || []);
        renderClaudeDocs({
            sourceId: msg.sourceId || 'claude-folder',
            nodes: filteredNodes,
            folderPaths: getCurrentFolderPaths(state.claudeFolderPathsByRoot, state.claudeWorkspaceRootFilter),
            error: msg.error
        });
    });

    document.getElementById('images-docs-search')?.addEventListener('input', (e) => {
        state.imagesDocsSearch = e.target.value;
        const msg = state._lastImagesDocsMsg || {};
        const filteredNodes = state.imagesWorkspaceRootFilter
            ? (msg.nodes || []).filter(n => n.metadata?.root === state.imagesWorkspaceRootFilter)
            : (msg.nodes || []);
        renderImagesDocs({
            sourceId: 'images-folder',
            nodes: filteredNodes,
            folderPaths: getCurrentFolderPaths(state.imagesFolderPathsByRoot, state.imagesWorkspaceRootFilter),
            error: msg.error
        });
    });

    // Message event listener
    window.addEventListener('message', (event) => {
        const msg = event.data;
        console.log('[DesignPanel Webview] Received message:', msg.type, msg);

        // Cross-cutting rule 2: Drop responses whose root != stitchWorkspaceRoot
        if (msg.type && msg.type.startsWith('stitch') && msg.workspaceRoot && msg.workspaceRoot !== state.stitchWorkspaceRoot) {
            console.log('[DesignPanel Webview] Dropping message for mismatched root:', msg.type, msg.workspaceRoot, 'vs', state.stitchWorkspaceRoot);
            return;
        }

        switch (msg.type) {
            case 'workspaceItemsUpdated': {
                _workspaceItems = msg.items || [];
                _registeredDropdowns.forEach(d => {
                    updateDropdown(d.selectElOrId, d.tabKey, d.includeAllOption);
                });
                
                // Load folders for all workspace items
                _workspaceItems.forEach(item => {
                    requestAllFolders(item.workspaceRoot);
                });

                // If stitchWorkspaceRoot is empty or not in current list, pick first one or restored
                if (_workspaceItems.length > 0) {
                    const restoredVal = getRestoredState('stitch.root');
                    const isRestoredOpen = restoredVal && _workspaceItems.some(i => i.workspaceRoot === restoredVal);
                    const defaultRoot = isRestoredOpen ? restoredVal : _workspaceItems[0].workspaceRoot;
                    
                    if (state.stitchWorkspaceRoot !== defaultRoot) {
                        state.stitchWorkspaceRoot = defaultRoot;
                        const filterSelect = document.getElementById('stitch-workspace-filter');
                        if (filterSelect) {
                            filterSelect.value = state.stitchWorkspaceRoot;
                        }
                        
                        // Restore project selection for this root — DISABLED per initialization requirements
                        // const rootState = getRestoredState('stitch.projectId', state.stitchWorkspaceRoot);
                        // state.selectedStitchProjectId = rootState || '';
                        state.selectedStitchProjectId = '';
                        
                        vscode.postMessage({
                            type: 'stitchListProjects',
                            workspaceRoot: state.stitchWorkspaceRoot
                        });
                    }
                }
                break;
            }
            case 'restoredTabState': {
                _restoredPanelState.panel = msg.panel || {};
                _restoredPanelState.byRoot = msg.byRoot || {};
                
                // Restore preferences
                const mId = getRestoredState('stitchModelId');
                if (mId && ['GEMINI_3_FLASH','GEMINI_3_1_PRO'].includes(mId)) {
                    state.stitchModelId = mId;
                    if (stitchModelSelect) stitchModelSelect.value = state.stitchModelId;
                }
                const cr = getRestoredState('stitchCreativeRange');
                if (cr && ['EXPLORE','REFINE','REIMAGINE'].includes(cr)) {
                    state.stitchCreativeRange = cr;
                    if (stitchCreativeRangeSelect) stitchCreativeRangeSelect.value = state.stitchCreativeRange;
                }
                const asp = getRestoredState('stitchAspects');
                if (asp && Array.isArray(asp)) {
                    state.stitchAspects = asp;
                    if (stitchAspectsCheckboxesContainer) {
                        const checkboxes = stitchAspectsCheckboxesContainer.querySelectorAll('input[type="checkbox"]');
                        checkboxes.forEach(cb => {
                            cb.checked = state.stitchAspects.includes(cb.value);
                        });
                    }
                }

                // Restore values if not set yet
                const restoredVal = getRestoredState('stitch.root');
                if (restoredVal && _workspaceItems.length > 0) {
                    const isRestoredOpen = _workspaceItems.some(i => i.workspaceRoot === restoredVal);
                    const finalRoot = isRestoredOpen ? restoredVal : _workspaceItems[0].workspaceRoot;
                    if (state.stitchWorkspaceRoot !== finalRoot) {
                        state.stitchWorkspaceRoot = finalRoot;
                        const filterSelect = document.getElementById('stitch-workspace-filter');
                        if (filterSelect) {
                            filterSelect.value = state.stitchWorkspaceRoot;
                        }
                        // const rootState = getRestoredState('stitch.projectId', state.stitchWorkspaceRoot);
                        // state.selectedStitchProjectId = rootState || '';
                        state.selectedStitchProjectId = '';
                        
                        vscode.postMessage({
                            type: 'stitchListProjects',
                            workspaceRoot: state.stitchWorkspaceRoot
                        });
                    }
                }

                // Restore HTML and Design workspace filters
                const restoredHtmlRoot = _restoredPanelState.panel['html.root'] || '';
                if (_workspaceItems.length === 0 || restoredHtmlRoot === '' || _workspaceItems.some(i => i.workspaceRoot === restoredHtmlRoot)) {
                    state.htmlWorkspaceRootFilter = restoredHtmlRoot;
                } else {
                    state.htmlWorkspaceRootFilter = '';
                }
                const htmlSelect = document.getElementById('html-workspace-filter');
                if (htmlSelect) htmlSelect.value = state.htmlWorkspaceRootFilter;

                const restoredClaudeRoot = _restoredPanelState.panel['claude.root'] || '';
                if (_workspaceItems.length === 0 || restoredClaudeRoot === '' || _workspaceItems.some(i => i.workspaceRoot === restoredClaudeRoot)) {
                    state.claudeWorkspaceRootFilter = restoredClaudeRoot;
                } else {
                    state.claudeWorkspaceRootFilter = '';
                }
                const claudeSelect = document.getElementById('claude-workspace-filter');
                if (claudeSelect) claudeSelect.value = state.claudeWorkspaceRootFilter;

                const restoredDesignRoot = _restoredPanelState.panel['design.root'] || '';
                if (_workspaceItems.length === 0 || restoredDesignRoot === '' || _workspaceItems.some(i => i.workspaceRoot === restoredDesignRoot)) {
                    state.designWorkspaceRootFilter = restoredDesignRoot;
                } else {
                    state.designWorkspaceRootFilter = '';
                }
                const designSelect = document.getElementById('design-workspace-filter');
                if (designSelect) designSelect.value = state.designWorkspaceRootFilter;

                const restoredBriefsRoot = _restoredPanelState.panel['briefs.root'] || '';
                if (_workspaceItems.length === 0 || restoredBriefsRoot === '' || _workspaceItems.some(i => i.workspaceRoot === restoredBriefsRoot)) {
                    state.briefsWorkspaceRootFilter = restoredBriefsRoot;
                } else {
                    state.briefsWorkspaceRootFilter = '';
                }
                const briefsSelect = document.getElementById('briefs-workspace-filter');
                if (briefsSelect) briefsSelect.value = state.briefsWorkspaceRootFilter;

                const restoredImagesRoot = _restoredPanelState.panel['images.root'] || '';
                if (_workspaceItems.length === 0 || restoredImagesRoot === '' || _workspaceItems.some(i => i.workspaceRoot === restoredImagesRoot)) {
                    state.imagesWorkspaceRootFilter = restoredImagesRoot;
                } else {
                    state.imagesWorkspaceRootFilter = '';
                }
                const imagesSelect = document.getElementById('images-workspace-filter');
                if (imagesSelect) imagesSelect.value = state.imagesWorkspaceRootFilter;

                // Override active tab with persisted value if it differs from the HTML default
                const restoredTab = (msg.panel || {})['activeTab'];
                const validTabs = ['stitch', 'claude', 'briefs', 'html-preview', 'images', 'design'];
                if (restoredTab && validTabs.includes(restoredTab)) {
                    const currentTab = document.querySelector('.shared-tab-btn.active')?.dataset.tab;
                    if (currentTab !== restoredTab) {
                        switchTab(restoredTab);
                    }
                }
                break;
            }
            case 'briefsDocsReady':
                state._lastBriefsDocsMsg = msg;
                state.briefsFolderPathsByRoot = msg.folderPathsByRoot || {};
                populateWorkspaceDropdown('briefs-workspace-filter', msg.workspaceItems || [], state.briefsWorkspaceRootFilter);
                const filteredBriefsNodes = state.briefsWorkspaceRootFilter
                    ? (msg.nodes || []).filter(n => n.metadata?.root === state.briefsWorkspaceRootFilter)
                    : (msg.nodes || []);
                renderBriefsDocs({
                    sourceId: msg.sourceId || 'briefs-folder',
                    nodes: filteredBriefsNodes,
                    folderPaths: getCurrentFolderPaths(state.briefsFolderPathsByRoot, state.briefsWorkspaceRootFilter)
                });
                if (state._pendingAutoOpenBrief) {
                    const pending = state._pendingAutoOpenBrief;
                    const age = Date.now() - pending.createdAt;
                    if (age < 5000) {
                        const nodes = msg.nodes || [];
                        const found = nodes.find(n => n.id === pending.docId);
                        if (found) {
                            loadDocumentPreview('briefs-folder', found.id, found.name);
                        }
                    }
                    state._pendingAutoOpenBrief = null;
                }
                break;

            case 'stitchAttachedFilesPicked': {
                if (msg.files && Array.isArray(msg.files)) {
                    const existingPaths = new Set(state.stitchAttachedFiles.map(f => f.path));
                    const newFiles = msg.files.filter(f => !existingPaths.has(f.path));
                    state.stitchAttachedFiles = [...state.stitchAttachedFiles, ...newFiles];
                    renderAttachedFileChips();
                }
                break;
            }

            case 'stitchBriefInjected': {
                const promptInput = document.getElementById('stitch-prompt-input');
                if (promptInput && msg.content) {
                    promptInput.value = `\n\n--- Design Brief ---\n${msg.content}\n---`;
                    promptInput.dispatchEvent(new Event('input'));
                }
                document.querySelector('[data-tab="stitch"]')?.click();
                setStitchStatus('Brief loaded \u2014 review and click Generate', 'success');
                break;
            }

            case 'briefsFoldersListed': {
                if (!state.briefsFolderPathsByRoot) state.briefsFolderPathsByRoot = {};
                state.briefsFolderPathsByRoot[msg.workspaceRoot] = msg.paths || [];
                if (folderModalScope === 'briefs') {
                    renderFolderListModal();
                }
                updateBriefDocControls();
                break;
            }

            case 'briefCreated': {
                if (msg.success) {
                    const statusBriefs = document.getElementById('status-briefs');
                    if (statusBriefs) {
                        statusBriefs.textContent = 'Brief created';
                        statusBriefs.style.color = 'var(--accent-teal)';
                        setTimeout(() => { statusBriefs.textContent = ''; }, 2000);
                    }
                    if (msg.docId && msg.sourceFolder) {
                        state._pendingAutoOpenBrief = {
                            docId: msg.docId,
                            sourceFolder: msg.sourceFolder,
                            createdAt: Date.now()
                        };
                    }
                } else {
                    const statusBriefs = document.getElementById('status-briefs');
                    if (statusBriefs) {
                        statusBriefs.textContent = 'Failed to create brief: ' + (msg.error || 'unknown error');
                        statusBriefs.style.color = '#ff6b6b';
                        setTimeout(() => { statusBriefs.textContent = ''; }, 4000);
                    }
                }
                break;
            }

            case 'briefDeleted': {
                if (msg.success) {
                    state.activeBriefSourceId = null;
                    state.activeBriefDocId = null;
                    state.activeDocContent = null;
                    state.activeDocFilePath = null;
                    if (state.briefEditMode) exitBriefEditMode();
                    const previewBriefs = document.getElementById('markdown-preview-briefs');
                    if (previewBriefs) {
                        previewBriefs.innerHTML = '<div class="empty-state">Select a brief from the sidebar to preview</div>';
                    }
                    updateBriefDocControls();
                    const statusBriefs = document.getElementById('status-briefs');
                    if (statusBriefs) {
                        statusBriefs.textContent = 'Brief deleted';
                        statusBriefs.style.color = 'var(--accent-teal)';
                        setTimeout(() => { statusBriefs.textContent = ''; }, 2000);
                    }
                } else {
                    const statusBriefs = document.getElementById('status-briefs');
                    if (statusBriefs) {
                        statusBriefs.textContent = 'Failed to delete brief: ' + (msg.error || 'unknown error');
                        statusBriefs.style.color = '#ff6b6b';
                        setTimeout(() => { statusBriefs.textContent = ''; }, 4000);
                    }
                }
                break;
            }

            case 'designDocsReady':
                state._lastDesignDocsMsg = msg;
                state.designFolderPathsByRoot = msg.folderPathsByRoot || {};
                populateWorkspaceDropdown('design-workspace-filter', msg.workspaceItems || [], state.designWorkspaceRootFilter);
                const filteredDesignNodes = state.designWorkspaceRootFilter
                    ? (msg.nodes || []).filter(n => n.metadata?.root === state.designWorkspaceRootFilter)
                    : (msg.nodes || []);
                renderDesignDocs({
                    sourceId: msg.sourceId || 'design-folder',
                    nodes: filteredDesignNodes,
                    folderPaths: getCurrentFolderPaths(state.designFolderPathsByRoot, state.designWorkspaceRootFilter)
                });
                break;

            case 'htmlDocsReady':
                state._lastHtmlDocsMsg = msg;
                state.htmlFolderPathsByRoot = msg.folderPathsByRoot || {};
                populateWorkspaceDropdown('html-workspace-filter', msg.workspaceItems || [], state.htmlWorkspaceRootFilter);
                const filteredHtmlNodes = state.htmlWorkspaceRootFilter
                    ? (msg.nodes || []).filter(n => n.metadata?.root === state.htmlWorkspaceRootFilter)
                    : (msg.nodes || []);
                renderHtmlDocs({
                    sourceId: msg.sourceId || 'html-folder',
                    nodes: filteredHtmlNodes,
                    folderPaths: getCurrentFolderPaths(state.htmlFolderPathsByRoot, state.htmlWorkspaceRootFilter),
                    error: msg.error
                });
                break;

            case 'claudeDocsReady': {
                state._lastClaudeDocsMsg = msg;
                state.claudeFolderPathsByRoot = msg.folderPathsByRoot || {};
                populateWorkspaceDropdown('claude-workspace-filter', msg.workspaceItems || [], state.claudeWorkspaceRootFilter);
                const filteredClaudeNodes = state.claudeWorkspaceRootFilter
                    ? (msg.nodes || []).filter(n => n.metadata?.root === state.claudeWorkspaceRootFilter)
                    : (msg.nodes || []);
                renderClaudeDocs({
                    sourceId: msg.sourceId || 'claude-folder',
                    nodes: filteredClaudeNodes,
                    folderPaths: getCurrentFolderPaths(state.claudeFolderPathsByRoot, state.claudeWorkspaceRootFilter),
                    error: msg.error
                });
                break;
            }

            case 'imagesDocsReady':
                state._lastImagesDocsMsg = msg;
                state.imagesFolderPathsByRoot = msg.folderPathsByRoot || {};
                populateWorkspaceDropdown('images-workspace-filter', msg.workspaceItems || [], state.imagesWorkspaceRootFilter);
                const filteredImagesNodes = state.imagesWorkspaceRootFilter
                    ? (msg.nodes || []).filter(n => n.metadata?.root === state.imagesWorkspaceRootFilter)
                    : (msg.nodes || []);
                renderImagesDocs({
                    sourceId: 'images-folder',
                    nodes: filteredImagesNodes,
                    folderPaths: getCurrentFolderPaths(state.imagesFolderPathsByRoot, state.imagesWorkspaceRootFilter),
                    error: msg.error
                });
                break;

            case 'designFoldersListed': {
                if (!state.designFolderPathsByRoot) state.designFolderPathsByRoot = {};
                state.designFolderPathsByRoot[msg.workspaceRoot] = msg.paths || [];
                if (folderModalScope === 'design') {
                    renderFolderListModal();
                }
                updateDesignDocControls();
                updateDestinationDropdowns();
                break;
            }
            case 'htmlFoldersListed': {
                if (!state.htmlFolderPathsByRoot) state.htmlFolderPathsByRoot = {};
                state.htmlFolderPathsByRoot[msg.workspaceRoot] = msg.paths || [];
                if (folderModalScope === 'html') {
                    renderFolderListModal();
                }
                updateDestinationDropdowns();
                break;
            }
            case 'claudeFoldersListed': {
                if (!state.claudeFolderPathsByRoot) state.claudeFolderPathsByRoot = {};
                state.claudeFolderPathsByRoot[msg.workspaceRoot] = msg.paths || [];
                if (folderModalScope === 'claude') {
                    renderFolderListModal();
                }
                // Claude folders are NOT Stitch output targets — do not touch the destination dropdowns.
                break;
            }
            case 'imagesFoldersListed': {
                if (!state.imagesFolderPathsByRoot) state.imagesFolderPathsByRoot = {};
                state.imagesFolderPathsByRoot[msg.workspaceRoot] = msg.paths || [];
                if (folderModalScope === 'images') {
                    renderFolderListModal();
                }
                updateDestinationDropdowns();
                break;
            }
            case 'stitchFoldersListed': {
                if (!state.stitchFolderPathsByRoot) state.stitchFolderPathsByRoot = {};
                state.stitchFolderPathsByRoot[msg.workspaceRoot] = msg.paths || [];
                if (folderModalScope === 'stitch') {
                    renderFolderListModal();
                }
                updateDestinationDropdowns();
                break;
            }

            case 'previewReady':
                handlePreviewReady(msg);
                break;

            case 'previewError':
                console.error('[DesignPanel Webview] Preview error:', msg.error);
                let activeStatus;
                if (msg.sourceId === 'design-folder') {
                    activeStatus = 'status-design';
                } else if (msg.sourceId === 'images-folder') {
                    activeStatus = 'status-images';
                } else if (msg.sourceId === 'briefs-folder') {
                    activeStatus = 'status-briefs';
                } else {
                    activeStatus = 'status-html';
                }
                const statusEl = document.getElementById(activeStatus);
                if (statusEl) {
                    statusEl.textContent = 'Preview error: ' + msg.error;
                    statusEl.style.color = '#ff6b6b';
                }
                break;

            case 'previewRenderStatus': {
                // Diagnostic messages from the iframe — shows script load failures,
                // JS errors, and render status so we can see why previews are blank.
                console.log('[DesignPanel Webview] Iframe render status:', msg);
                const statusHtml = document.getElementById('status-html');
                if (statusHtml) {
                    if (msg.errors && msg.errors.length > 0) {
                        const e = msg.errors[msg.errors.length - 1];
                        statusHtml.textContent = 'JS error: ' + (e.message || e.reason || 'unknown');
                        statusHtml.style.color = '#ff6b6b';
                    } else if (msg.failedScripts && msg.failedScripts.length > 0) {
                        statusHtml.textContent = 'Script failed: ' + msg.failedScripts[msg.failedScripts.length - 1].split('/').pop();
                        statusHtml.style.color = '#ff6b6b';
                    } else if (msg.rootChildren !== undefined && msg.rootChildren > 0) {
                        statusHtml.textContent = 'Rendered (' + msg.rootChildren + ' elements)';
                        statusHtml.style.color = 'var(--accent-teal)';
                    } else if (msg.loadedScripts && msg.loadedScripts.length > 0) {
                        statusHtml.textContent = msg.loadedScripts.length + ' scripts loaded';
                        statusHtml.style.color = 'var(--accent-teal)';
                    }
                }
                break;
            }

            case 'activeDesignDocUpdated': {
                const ds = msg.designSystemDoc || {};
                state.designSystemDocEnabled = !!ds.enabled;
                state.designSystemDocSourceId = ds.sourceId || null;
                state.designSystemDocId = ds.docId || null;
                updateDesignDocControls();
                break;
            }

            case 'activeContextSet': {
                const statusDesign = document.getElementById('status-design');
                if (statusDesign) {
                    statusDesign.textContent = msg.success
                        ? 'Set as active design doc'
                        : 'Error: ' + (msg.error || 'Failed to set active context');
                    statusDesign.style.color = msg.success ? 'var(--accent-teal)' : '#ff6b6b';
                }
                updateDesignDocControls();
                break;
            }

            case 'saveFileContentResult': {
                if (msg.tab === 'briefs') {
                    const editor = document.getElementById('markdown-editor-briefs');
                    const statusBriefs = document.getElementById('status-briefs');
                    if (msg.success) {
                        state.activeDocContent = editor ? editor.value : state.activeDocContent;
                        exitBriefEditMode();
                        const mdPrevBriefs = document.getElementById('markdown-preview-briefs');
                        if (mdPrevBriefs) mdPrevBriefs.innerHTML = renderMarkdown(state.activeDocContent) || '';
                        if (statusBriefs) {
                            statusBriefs.textContent = 'Saved successfully';
                            statusBriefs.style.color = 'var(--accent-teal)';
                            setTimeout(() => { statusBriefs.textContent = ''; statusBriefs.style.color = ''; }, 2000);
                        }
                    } else if (msg.conflict) {
                        if (editor && state.activeDocFilePath) {
                            vscode.postMessage({
                                type: 'saveFileContent',
                                filePath: state.activeDocFilePath,
                                content: editor.value,
                                originalContent: msg.diskContent,
                                tab: 'briefs'
                            });
                        }
                    } else {
                        if (statusBriefs) {
                            statusBriefs.textContent = 'Save failed: ' + (msg.error || 'unknown error');
                            statusBriefs.style.color = '#ff6b6b';
                        }
                    }
                    break;
                }
                if (msg.tab !== 'design') break;
                const editor = document.getElementById('markdown-editor-design');
                const statusDesign = document.getElementById('status-design');
                if (msg.success) {
                    state.activeDocContent = editor ? editor.value : state.activeDocContent;
                    exitDesignEditMode();
                    if (state.activeFileType === 'json') {
                        const jsonCont = document.getElementById('json-preview-container-design');
                        if (jsonCont) {
                            jsonCont.style.display = 'block';
                            jsonCont.innerHTML = '';
                            try {
                                jsonCont.appendChild(renderJsonTree(JSON.parse(state.activeDocContent)));
                            } catch (e) {
                                jsonCont.innerHTML = `<div class="json-error">Parse error: ${e.message}</div>`;
                            }
                        }
                    } else if (state.activeFileType === 'yaml') {
                        // YAML tree needs parsedJson from the host — re-fetch the preview
                        if (state.activeSource && state.activeDocId) {
                            vscode.postMessage({
                                type: 'fetchPreview',
                                sourceId: state.activeSource,
                                docId: state.activeDocId,
                                requestId: ++state.previewRequestId,
                                sourceFolder: state.activeDocSourceFolder
                            });
                        }
                    } else {
                        const mdPrevDesign = document.getElementById('markdown-preview-design');
                        if (mdPrevDesign) mdPrevDesign.innerHTML = renderMarkdown(state.activeDocContent) || '';
                    }
                    if (statusDesign) {
                        statusDesign.textContent = 'Saved successfully';
                        statusDesign.style.color = 'var(--accent-teal)';
                        setTimeout(() => { statusDesign.textContent = ''; statusDesign.style.color = ''; }, 2000);
                    }
                } else if (msg.conflict) {
                    // Disk changed since the editor opened — retry against the disk
                    // content so the user's edit wins (no confirm gates, by design).
                    if (editor && state.activeDocFilePath) {
                        vscode.postMessage({
                            type: 'saveFileContent',
                            filePath: state.activeDocFilePath,
                            content: editor.value,
                            originalContent: msg.diskContent,
                            tab: 'design'
                        });
                    }
                } else {
                    if (statusDesign) {
                        statusDesign.textContent = 'Save failed: ' + (msg.error || 'unknown error');
                        statusDesign.style.color = '#ff6b6b';
                    }
                }
                break;
            }

            case 'stitchApiKeyStatus':
                state.stitchApiKeyConfigured = msg.configured;
                if (stitchApiBanner) {
                    stitchApiBanner.style.display = msg.configured ? 'none' : 'flex';
                }
                break;

            case 'stitchAuthStatus':
                state.stitchApiKeyConfigured = msg.configured;
                state.stitchAuthValid = msg.valid;
                if (stitchApiBanner) {
                    stitchApiBanner.style.display = msg.configured ? 'none' : 'flex';
                }
                updateStitchAuthUI(msg);
                break;

            case 'stitchDesignSystemsReady':
                state.stitchDesignSystems = msg.designSystems || [];
                renderStitchDesignSystems();
                break;

            case 'stitchDesignSystemCreated':
                setStitchStatus('Design system created successfully', 'success');
                vscode.postMessage({
                    type: 'stitchListDesignSystems',
                    projectId: state.selectedStitchProjectId,
                    workspaceRoot: state.stitchWorkspaceRoot
                });
                break;

            case 'stitchDesignSystemUpdated':
                setStitchStatus('Design system updated successfully', 'success');
                vscode.postMessage({
                    type: 'stitchListDesignSystems',
                    projectId: state.selectedStitchProjectId,
                    workspaceRoot: state.stitchWorkspaceRoot
                });
                break;

            case 'stitchDesignSystemApplied':
                setStitchStatus('Design system applied to selected screens', 'success');
                vscode.postMessage({
                    type: 'stitchListDesignSystems',
                    projectId: state.selectedStitchProjectId,
                    workspaceRoot: state.stitchWorkspaceRoot
                });
                break;

            case 'stitchProjectsReady':
                state.stitchProjects = msg.projects || [];
                populateStitchProjects(state.stitchProjects, msg.defaultProjectId);
                if (!persistedState.stitchModelId && msg.defaultModelId) {
                    state.stitchModelId = msg.defaultModelId;
                    if (stitchModelSelect) stitchModelSelect.value = state.stitchModelId;
                }
                if (!persistedState.stitchCreativeRange && msg.defaultCreativeRange) {
                    state.stitchCreativeRange = msg.defaultCreativeRange;
                    if (stitchCreativeRangeSelect) stitchCreativeRangeSelect.value = state.stitchCreativeRange;
                }
                setStitchBusy(false); // recompute Generate/Sync disabled state for the new selection
                if (msg.selectProjectId) {
                    state.selectedStitchProjectId = msg.selectProjectId;
                    if (stitchProjectSelect) stitchProjectSelect.value = msg.selectProjectId;
                    if (designSystemProjectSelect) designSystemProjectSelect.value = msg.selectProjectId;
                    if (state.stitchWorkspaceRoot) {
                        persistTab('stitch.projectId', msg.selectProjectId, state.stitchWorkspaceRoot);
                    }
                    setStitchStatus('Project created — describe a screen and press Generate', 'success');
                    setStitchBusy(true);
                    vscode.postMessage({
                        type: 'stitchGetProjectScreens',
                        projectId: msg.selectProjectId,
                        workspaceRoot: state.stitchWorkspaceRoot
                    });
                } else if (state.selectedStitchProjectId) {
                    // Automatically load screens for the selected project
                    setStitchStatus('Loading project screens…', 'busy');
                    setStitchBusy(true);
                    vscode.postMessage({
                        type: 'stitchGetProjectScreens',
                        projectId: state.selectedStitchProjectId,
                        workspaceRoot: state.stitchWorkspaceRoot
                    });
                } else {
                    setStitchStatus('', 'info');
                }
                break;

            case 'stitchScreensReady': {
                setStitchBusy(false);
                state.stitchProjectRefreshAttempted = false;
                const screens = msg.screens || [];
                renderStitchScreens(screens);
                
                const missing = screens.filter(isScreenPollable);
                startMissingStitchScreenPolling(screens, 'project-load');
                
                if (missing.length > 0) {
                    setStitchStatus(`${screens.length} screen${screens.length === 1 ? '' : 's'} loaded — waiting for ${missing.length} preview(s)`, 'busy');
                } else {
                    setStitchStatus(`${screens.length} screen${screens.length === 1 ? '' : 's'} loaded`, 'success');
                }
                break;
            }

            case 'stitchAssetDownloaded': {
                const sid = msg.screenId;
                if (sid) {
                    // Record the on-disk path on the screen so the toolbar can offer to open it.
                    const scr = (state.stitchScreens || []).find(s => s.id === sid);
                    if (scr) {
                        if (msg.kind === 'html') scr.htmlPath = msg.path;
                        else if (msg.kind === 'png') scr.imagePath = msg.path;
                    }
                    if (state.activePreviewScreenId === sid) {
                        if (msg.kind === 'html' && previewBtnOpenWeb) previewBtnOpenWeb.style.display = '';
                        if (msg.kind === 'png' && previewBtnPng) previewBtnPng.disabled = false;
                    }
                }
                break;
            }

            case 'stitchScreenReady': {
                // Update state without touching existing screens
                const updatedScreens = [...state.stitchScreens];
                const existingIdx = updatedScreens.findIndex(s => s.id === msg.screen.id);
                const existingScreen = existingIdx >= 0 ? updatedScreens[existingIdx] : null;
                if (existingIdx >= 0) {
                    updatedScreens[existingIdx] = msg.screen;
                } else {
                    updatedScreens.unshift(msg.screen);
                }
                state.stitchScreens = updatedScreens;

                // Surgically update only the affected card — a full renderStitchScreens
                // would rebuild every img element from state, re-using CDN URLs that may
                // have expired since the gallery first loaded, causing working images to fail.
                const existingCard = stitchGallery
                    ? stitchGallery.querySelector(`.stitch-screen-card[data-screen-id="${CSS.escape(msg.screen.id)}"]`)
                    : null;

                if (existingCard) {
                    const screen = msg.screen;
                    const makeThumbPlaceholder = () => {
                        const ph = document.createElement('div');
                        ph.className = 'stitch-thumb-placeholder';
                        const label = document.createElement('span');
                        label.textContent = 'Preview not ready yet';
                        ph.appendChild(label);
                        const btnReload = document.createElement('button');
                        btnReload.className = 'strip-btn';
                        btnReload.textContent = '↻ Reload Screen';
                        btnReload.addEventListener('click', () => {
                            if (state.stitchBusy) return;
                            clearStitchScreenPoll(screen.projectId || (stitchProjectSelect ? stitchProjectSelect.value : ''), screen.id, state.stitchWorkspaceRoot);
                            scheduleStitchScreenPoll(screen, { immediate: true, manual: true });
                        });
                        ph.appendChild(btnReload);
                        return ph;
                    };
                    const oldThumb = existingCard.querySelector('.stitch-screen-thumbnail, .stitch-thumb-placeholder');
                    if (screen.imageUrl) {
                        const img = document.createElement('img');
                        img.className = 'stitch-screen-thumbnail';
                        img.src = screen.imageUrl;
                        img.alt = screen.name || screen.id;
                        img.title = 'Click to view preview';
                        img.addEventListener('click', () => openStitchPreview(screen));
                        img.addEventListener('error', () => {
                            img.replaceWith(makeThumbPlaceholder());
                            scheduleStitchScreenPoll(screen, { reason: 'image-error', immediate: true });
                        }, { once: true });
                        if (oldThumb) oldThumb.replaceWith(img); else existingCard.prepend(img);
                    } else {
                        const ph = makeThumbPlaceholder();
                        if (oldThumb) oldThumb.replaceWith(ph); else existingCard.prepend(ph);
                    }
                    // Update preview pane if this screen is active
                    if (state.activePreviewScreenId === screen.id) {
                        const isPreviewPaneVisible = stitchPreviewPane && (stitchPreviewPane.style.display === 'flex' || stitchPreviewPane.style.display === 'block');
                        if (isPreviewPaneVisible) openStitchPreview(screen);
                    }
                } else {
                    // New screen not yet in the gallery — full render needed
                    renderStitchScreens(updatedScreens);
                }

                const hasImage = !!msg.screen.imageUrl;
                const isFailed = msg.screen.status === 'FAILED';
                const projectId = msg.screen.projectId || (stitchProjectSelect ? stitchProjectSelect.value : '');

                if (hasScreenStateChanged(msg.screen, existingScreen)) {
                    if (hasImage) {
                        clearStitchScreenPoll(projectId, msg.screen.id, state.stitchWorkspaceRoot);
                        if (state.stitchScreenPolls.size > 0) {
                            setStitchStatus(`Preview ready — ${state.stitchScreenPolls.size} still waiting`, 'busy');
                        } else {
                            setStitchStatus('Screen ready', 'success');
                        }
                    } else if (isFailed) {
                        clearStitchScreenPoll(projectId, msg.screen.id, state.stitchWorkspaceRoot);
                        setStitchStatus(msg.screen.statusMessage || 'Rendering failed', 'error');
                    } else {
                        // No image yet — start polling regardless of whether we were already polling.
                        // Previously this only polled if isPolling was already true, so genuinely new
                        // screens arriving without an image were silently dropped and never retried.
                        setStitchStatus(`Waiting for preview(s)`, 'busy');
                        scheduleStitchScreenPoll(msg.screen);
                    }
                }
                break;
            }

            case 'stitchSyncComplete':
                setStitchBusy(false);
                setStitchStatus(
                    msg.skippedCount > 0
                        ? `Sync complete — DESIGN.md opened (${msg.skippedCount} screen${msg.skippedCount === 1 ? '' : 's'} still rendering, re-sync later)`
                        : 'Sync complete — DESIGN.md opened in the editor',
                    'success'
                );
                break;

            case 'stitchError':
                clearAllStitchScreenPolls();
                setStitchBusy(false);
                setStitchStatus('Error: ' + msg.error, 'error');
                break;

            case 'themeChanged':
            case 'switchboardThemeChanged':
                // Mirrors planning.js handleThemeChanged: cyber CRT effects only for
                // afterburner; claudify additionally gets the palette override.
                if (msg.theme) { state.switchboardTheme = msg.theme; }
                // Compute the desired theme class set without touching unrelated classes
                // (e.g. kanban-icons-colour, cyber-animation-disabled) that may have been
                // injected server-side by applyThemeBodyClass().
                const allThemeClasses = ['theme-claudify', 'cyber-theme-enabled'];
                const desired = new Set();
                if (state.switchboardTheme === 'afterburner') {
                    desired.add('cyber-theme-enabled');
                } else if (state.switchboardTheme === 'claudify') {
                    desired.add('theme-claudify');
                }
                // Remove only theme classes that should NOT be present — leave the
                // correct ones in place so there is no flash if they were already
                // injected by applyThemeBodyClass at HTML generation time.
                for (const cls of allThemeClasses) {
                    if (!desired.has(cls)) {
                        document.body.classList.remove(cls);
                    }
                }
                // Add any desired classes that are not yet present.
                for (const cls of desired) {
                    document.body.classList.add(cls);
                }
                break;

            case 'cyberAnimationSetting':
                document.body.classList.toggle('cyber-animation-disabled', msg.disabled);
                break;
            case 'cyberScanlinesSetting':
                document.body.classList.toggle('cyber-scanlines-disabled', msg.disabled);
                break;
        }
    });

    function initStitchControls() {
        if (stitchModelSelect) {
            stitchModelSelect.value = state.stitchModelId;
            stitchModelSelect.addEventListener('change', () => {
                state.stitchModelId = stitchModelSelect.value;
                persistTab('stitchModelId', state.stitchModelId);
            });
        }
        if (stitchCreativeRangeSelect) {
            stitchCreativeRangeSelect.value = state.stitchCreativeRange;
            stitchCreativeRangeSelect.addEventListener('change', () => {
                state.stitchCreativeRange = stitchCreativeRangeSelect.value;
                persistTab('stitchCreativeRange', state.stitchCreativeRange);
            });
        }
        if (stitchAspectsCheckboxesContainer) {
            const checkboxes = stitchAspectsCheckboxesContainer.querySelectorAll('input[type="checkbox"]');
            checkboxes.forEach(cb => {
                const safeAspects = Array.isArray(state.stitchAspects) ? state.stitchAspects : ['LAYOUT','COLOR_SCHEME','IMAGES','TEXT_FONT','TEXT_CONTENT'];
                cb.checked = safeAspects.includes(cb.value);
                cb.addEventListener('change', () => {
                    const checked = [];
                    checkboxes.forEach(c => {
                        if (c.checked) checked.push(c.value);
                    });
                    state.stitchAspects = checked;
                    persistTab('stitchAspects', state.stitchAspects);
                });
            });
        }
    }

    // Register workspace dropdowns
    registerWorkspaceDropdown('html-workspace-filter', 'html.root');
    registerWorkspaceDropdown('claude-workspace-filter', 'claude.root');
    registerWorkspaceDropdown('design-workspace-filter', 'design.root');
    registerWorkspaceDropdown('stitch-workspace-filter', 'stitch.root', false);

    // Dropdown change listener
    document.getElementById('stitch-workspace-filter')?.addEventListener('change', (e) => {
        const newRoot = e.target.value;
        if (newRoot && newRoot !== state.stitchWorkspaceRoot) {
            state.stitchWorkspaceRoot = newRoot;
            // sync the snapshot so later workspaceItemsUpdated re-derivations
            // don't reset the live selection to the boot-time restored value
            _restoredPanelState.panel['stitch.root'] = newRoot;
            persistTab('stitch.root', state.stitchWorkspaceRoot);
            
            // reset in-memory stitch state
            state.selectedStitchProjectId = '';
            state.stitchScreens = [];
            state.activePreviewScreenId = null;
            if (stitchProjectSelect) {
                stitchProjectSelect.value = '';
            }
            if (designSystemProjectSelect) {
                designSystemProjectSelect.value = '';
            }
            closeStitchPreview();
            
            // FIX: Clear Images tab selection to prevent carry-over
            if (state.activeSource === 'images-folder') {
                state.activeSource = null;
                state.activeDocId = null;
                state.selectedEl = null;
                state.activeDocName = null;
                state.activeDocContent = null;
                state.activeDocFilePath = null;
                state.activeDocSourceFolder = null;
                state.activeFileType = null;
                state.previewRequestId++;
                // Clear the preview pane
                const initialState = document.getElementById('images-initial-state');
                const loadingState = document.getElementById('images-loading-state');
                const imageContainer = document.getElementById('image-preview-container-images');
                if (initialState) initialState.style.display = 'flex';
                if (loadingState) loadingState.style.display = 'none';
                if (imageContainer) imageContainer.style.display = 'none';
            }
            
            // re-request the project list for the new root
            vscode.postMessage({
                type: 'stitchListProjects',
                workspaceRoot: state.stitchWorkspaceRoot
            });
        }
    });

    // ===== FOLDER MANAGEMENT & PREVIEW HELPERS =====
    let folderModalScope = 'design'; // design, html, claude, images, stitch, briefs

    function requestAllFolders(root) {
        if (!root) return;
        vscode.postMessage({ type: 'listDesignFolders', workspaceRoot: root });
        vscode.postMessage({ type: 'listHtmlFolders', workspaceRoot: root });
        vscode.postMessage({ type: 'listClaudeFolders', workspaceRoot: root });
        vscode.postMessage({ type: 'listImagesFolders', workspaceRoot: root });
        vscode.postMessage({ type: 'listStitchFolders', workspaceRoot: root });
        vscode.postMessage({ type: 'listBriefsFolders', workspaceRoot: root });
    }

    function updateDestinationDropdowns() {
        const destSelect = document.getElementById('preview-destination-select');
        if (!destSelect) return;
        const currentVal = destSelect.value;
        destSelect.innerHTML = '<option value="">Default (.stitch)</option>';
        
        const root = state.stitchWorkspaceRoot;
        if (!root) return;

        const seen = new Set();
        const addPaths = (paths) => {
            if (Array.isArray(paths)) {
                paths.forEach(p => {
                    if (p && !seen.has(p)) {
                        seen.add(p);
                        const opt = document.createElement('option');
                        opt.value = p;
                        opt.textContent = p.replace(root, '').replace(/^[\\\/]/, '') || p;
                        destSelect.appendChild(opt);
                    }
                });
            }
        };

        if (state.stitchFolderPathsByRoot) addPaths(state.stitchFolderPathsByRoot[root]);
        if (state.htmlFolderPathsByRoot) addPaths(state.htmlFolderPathsByRoot[root]);
        if (state.imagesFolderPathsByRoot) addPaths(state.imagesFolderPathsByRoot[root]);
        if (state.designFolderPathsByRoot) addPaths(state.designFolderPathsByRoot[root]);

        if (seen.has(currentVal)) {
            destSelect.value = currentVal;
        }
    }

    function openFoldersModal(scope = 'design') {
        folderModalScope = scope;
        const modal = document.getElementById('folder-modal');
        const modalTitle = document.getElementById('folder-modal-title');
        if (modalTitle) {
            if (scope === 'design') modalTitle.textContent = 'Manage Design Folders';
            else if (scope === 'html') modalTitle.textContent = 'Manage HTML Previews Folders';
            else if (scope === 'claude') modalTitle.textContent = 'Manage Claude Folders';
            else if (scope === 'images') modalTitle.textContent = 'Manage Images Folders';
            else if (scope === 'stitch') modalTitle.textContent = 'Manage Stitch Folders';
            else if (scope === 'briefs') modalTitle.textContent = 'Manage Briefs Folders';
        }
        if (modal) {
            modal.style.display = 'flex';
            renderFolderListModal();
            syncStitchHtmlPreviewToggle();
        }
        vscode.setState({
            ...vscode.getState(),
            folderModalOpen: true,
            folderModalScope: scope
        });
    }

    // The Stitch assets folder (.switchboard/stitch) is "included" in HTML previews when its
    // path is present in the HTML folder list — no separate persisted flag needed.
    function getHtmlModalRoot() {
        return state.htmlWorkspaceRootFilter || '';
    }
    function isStitchHtmlPreviewEnabled(root) {
        const paths = (state.htmlFolderPathsByRoot && state.htmlFolderPathsByRoot[root]) || [];
        return paths.some(p => String(p).replace(/\\/g, '/').replace(/\/+$/, '').endsWith('/.switchboard/stitch'));
    }
    function syncStitchHtmlPreviewToggle() {
        const row = document.getElementById('stitch-html-preview-toggle-row');
        const checkbox = document.getElementById('stitch-html-preview-toggle');
        if (!row || !checkbox) return;
        if (folderModalScope === 'html' && getHtmlModalRoot()) {
            row.style.display = 'flex';
            checkbox.checked = isStitchHtmlPreviewEnabled(getHtmlModalRoot());
        } else {
            row.style.display = 'none';
        }
    }

    function renderFolderListModal() {
        const folderListModal = document.getElementById('folder-list-modal');
        if (!folderListModal) return;
        folderListModal.innerHTML = '';

        let root = '';
        let folderMap = null;
        if (folderModalScope === 'design') {
            root = state.designWorkspaceRootFilter || '';
            folderMap = state.designFolderPathsByRoot;
        } else if (folderModalScope === 'html') {
            root = state.htmlWorkspaceRootFilter || '';
            folderMap = state.htmlFolderPathsByRoot;
        } else if (folderModalScope === 'claude') {
            root = state.claudeWorkspaceRootFilter || '';
            folderMap = state.claudeFolderPathsByRoot;
        } else if (folderModalScope === 'images') {
            root = state.imagesWorkspaceRootFilter || '';
            folderMap = state.imagesFolderPathsByRoot;
        } else if (folderModalScope === 'stitch') {
            root = state.stitchWorkspaceRoot || '';
            folderMap = state.stitchFolderPathsByRoot;
        } else if (folderModalScope === 'briefs') {
            root = state.briefsWorkspaceRootFilter || '';
            folderMap = state.briefsFolderPathsByRoot;
        }
        const folderPaths = getCurrentFolderPaths(folderMap || {}, root);
        const isAggregate = !root;

        const addBtn = document.getElementById('btn-add-folder-modal');
        if (addBtn) {
            addBtn.disabled = isAggregate;
            addBtn.title = isAggregate ? 'Select a specific workspace to add a folder' : '';
            addBtn.style.opacity = isAggregate ? '0.5' : '';
        }

        if (isAggregate) {
            const hint = document.createElement('div');
            hint.className = 'folder-list-hint';
            hint.style.cssText = 'padding: 8px 4px; font-size: 11px; color: var(--text-secondary); opacity: 0.85;';
            hint.textContent = 'Viewing all workspaces. Select a specific workspace to add or remove folders.';
            folderListModal.appendChild(hint);
        }

        if (folderPaths.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'folder-list-empty';
            empty.textContent = isAggregate
                ? 'No folders configured in any workspace.'
                : 'No folders configured. Click Add Folder to get started.';
            folderListModal.appendChild(empty);
            syncStitchHtmlPreviewToggle();
            return;
        }

        folderPaths.forEach(path => {
            const row = document.createElement('div');
            row.className = 'folder-list-item';
            row.style.display = 'flex';
            row.style.justifyContent = 'space-between';
            row.style.alignItems = 'center';
            row.style.padding = '6px 8px';
            row.style.borderBottom = '1px solid var(--border-color)';

            const pathSpan = document.createElement('span');
            pathSpan.className = 'folder-path';
            pathSpan.textContent = path;
            pathSpan.title = path;
            pathSpan.style.fontFamily = 'var(--font-mono)';
            pathSpan.style.fontSize = '11px';

            const removeBtn = document.createElement('button');
            removeBtn.className = 'folder-list-remove-btn strip-btn';
            removeBtn.textContent = 'Remove';
            removeBtn.style.color = '#ff6b6b';
            if (isAggregate) {
                removeBtn.disabled = true;
                removeBtn.title = 'Select a specific workspace to remove its folders';
                removeBtn.style.opacity = '0.5';
            } else {
                removeBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    if (folderModalScope === 'design') {
                        vscode.postMessage({ type: 'removeDesignFolder', folderPath: path, workspaceRoot: root });
                    } else if (folderModalScope === 'html') {
                        vscode.postMessage({ type: 'removeHtmlFolder', folderPath: path, workspaceRoot: root });
                    } else if (folderModalScope === 'claude') {
                        vscode.postMessage({ type: 'removeClaudeFolder', folderPath: path, workspaceRoot: root });
                    } else if (folderModalScope === 'images') {
                        vscode.postMessage({ type: 'removeImagesFolder', folderPath: path, workspaceRoot: root });
                    } else if (folderModalScope === 'stitch') {
                        vscode.postMessage({ type: 'removeStitchFolder', folderPath: path, workspaceRoot: root });
                    } else if (folderModalScope === 'briefs') {
                        vscode.postMessage({ type: 'removeBriefsFolder', folderPath: path, workspaceRoot: root });
                    }
                });
            }

            row.appendChild(pathSpan);
            row.appendChild(removeBtn);
            folderListModal.appendChild(row);
        });

        syncStitchHtmlPreviewToggle();
    }

    // Event delegation on the split button container for dropdown toggle
    document.addEventListener('click', (e) => {
        const toggle = e.target.closest('#preview-btn-variants-dropdown-toggle');
        if (toggle) {
            e.stopPropagation();
            const menu = document.getElementById('stitch-variants-dropdown-menu');
            if (menu) {
                const visible = menu.style.display === 'block';
                menu.style.display = visible ? 'none' : 'block';
            }
            return;
        }

        const menu = document.getElementById('stitch-variants-dropdown-menu');
        if (menu && menu.style.display === 'block') {
            const container = e.target.closest('.split-button-container');
            if (!container) {
                menu.style.display = 'none';
            }
        }
    });

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            const tag = e.target.tagName.toLowerCase();
            if (tag === 'textarea' || tag === 'input' || tag === 'select') return;
            const modal = document.getElementById('folder-modal');
            if (modal && modal.style.display !== 'none') {
                modal.style.display = 'none';
                vscode.setState({
                    ...vscode.getState(),
                    folderModalOpen: false,
                    folderModalScope: null
                });
            }
            const menu = document.getElementById('stitch-variants-dropdown-menu');
            if (menu) {
                menu.style.display = 'none';
            }
        }
    });

    // Manage Folders buttons now live in each tab's sidebar toggle row (wired in the
    // render* functions), matching planning.html — no top-bar buttons to bind here.

    document.getElementById('btn-close-folder-modal')?.addEventListener('click', () => {
        const modal = document.getElementById('folder-modal');
        if (modal) modal.style.display = 'none';
        vscode.setState({
            ...vscode.getState(),
            folderModalOpen: false,
            folderModalScope: null
        });
    });

    document.getElementById('folder-modal')?.addEventListener('click', (e) => {
        if (e.target.id === 'folder-modal') {
            e.target.style.display = 'none';
            vscode.setState({
                ...vscode.getState(),
                folderModalOpen: false,
                folderModalScope: null
            });
        }
    });

    document.getElementById('btn-refresh-folders-modal')?.addEventListener('click', () => {
        let root = '';
        if (folderModalScope === 'design') {
            root = state.designWorkspaceRootFilter || '';
            vscode.postMessage({ type: 'listDesignFolders', workspaceRoot: root });
        } else if (folderModalScope === 'html') {
            root = state.htmlWorkspaceRootFilter || '';
            vscode.postMessage({ type: 'listHtmlFolders', workspaceRoot: root });
        } else if (folderModalScope === 'claude') {
            root = state.claudeWorkspaceRootFilter || '';
            vscode.postMessage({ type: 'listClaudeFolders', workspaceRoot: root });
        } else if (folderModalScope === 'images') {
            root = state.imagesWorkspaceRootFilter || '';
            vscode.postMessage({ type: 'listImagesFolders', workspaceRoot: root });
        } else if (folderModalScope === 'stitch') {
            root = state.stitchWorkspaceRoot || '';
            vscode.postMessage({ type: 'listStitchFolders', workspaceRoot: root });
        } else if (folderModalScope === 'briefs') {
            root = state.briefsWorkspaceRootFilter || '';
            vscode.postMessage({ type: 'listBriefsFolders', workspaceRoot: root });
        }
    });

    document.getElementById('btn-add-folder-modal')?.addEventListener('click', () => {
        let root = '';
        if (folderModalScope === 'design') {
            root = state.designWorkspaceRootFilter || '';
            vscode.postMessage({ type: 'addDesignFolder', workspaceRoot: root });
        } else if (folderModalScope === 'html') {
            root = state.htmlWorkspaceRootFilter || '';
            vscode.postMessage({ type: 'addHtmlFolder', workspaceRoot: root });
        } else if (folderModalScope === 'claude') {
            root = state.claudeWorkspaceRootFilter || '';
            vscode.postMessage({ type: 'addClaudeFolder', workspaceRoot: root });
        } else if (folderModalScope === 'images') {
            root = state.imagesWorkspaceRootFilter || '';
            vscode.postMessage({ type: 'addImagesFolder', workspaceRoot: root });
        } else if (folderModalScope === 'stitch') {
            root = state.stitchWorkspaceRoot || '';
            vscode.postMessage({ type: 'addStitchFolder', workspaceRoot: root });
        } else if (folderModalScope === 'briefs') {
            root = state.briefsWorkspaceRootFilter || '';
            vscode.postMessage({ type: 'addBriefsFolder', workspaceRoot: root });
        }
    });

    document.getElementById('stitch-html-preview-toggle')?.addEventListener('change', (e) => {
        const root = getHtmlModalRoot();
        if (!root) return;
        vscode.postMessage({ type: 'toggleStitchHtmlPreview', enabled: e.target.checked, workspaceRoot: root });
    });

    registerWorkspaceDropdown('briefs-workspace-filter', 'briefs.root');

    initStitchControls();
    initStitchDesignSystemControls();

    function initStitchDesignSystemControls() {
        // Toggle btn configure auth
        document.getElementById('btn-configure-auth')?.addEventListener('click', () => {
            const panel = document.getElementById('stitch-auth-panel');
            if (panel) {
                panel.style.display = panel.style.display === 'none' ? 'flex' : 'none';
            }
        });

        document.getElementById('btn-close-stitch-auth')?.addEventListener('click', () => {
            const panel = document.getElementById('stitch-auth-panel');
            if (panel) panel.style.display = 'none';
        });

        // Save auth config
        document.getElementById('btn-save-stitch-auth')?.addEventListener('click', () => {
            const apiKey = document.getElementById('stitch-api-key-input')?.value.trim() || '';
            
            vscode.postMessage({
                type: 'stitchSaveAuthConfig',
                apiKey
            });
        });

        // Validate auth
        document.getElementById('btn-validate-stitch-auth')?.addEventListener('click', () => {
            const indicator = document.getElementById('stitch-auth-status-indicator');
            if (indicator) {
                indicator.textContent = 'Validating...';
                indicator.style.background = '#444';
                indicator.style.color = '#fff';
            }
            const errMsg = document.getElementById('stitch-auth-error-msg');
            if (errMsg) errMsg.style.display = 'none';

            vscode.postMessage({
                type: 'stitchValidateAuth'
            });
        });

        // Sub-tabs switcher buttons
        const btnLocal = document.getElementById('btn-design-subtab-local');
        const btnStitch = document.getElementById('btn-design-subtab-stitch');
        const localPanel = document.getElementById('design-local-panel');
        const stitchPanel = document.getElementById('design-systems-panel');

        btnLocal?.addEventListener('click', () => {
            btnLocal.classList.add('active');
            btnStitch?.classList.remove('active');
            if (localPanel) localPanel.style.display = 'flex';
            if (stitchPanel) stitchPanel.style.display = 'none';
            state.designSystemSubTab = 'local';
        });

        btnStitch?.addEventListener('click', () => {
            btnStitch.classList.add('active');
            btnLocal?.classList.remove('active');
            if (localPanel) localPanel.style.display = 'none';
            if (stitchPanel) stitchPanel.style.display = 'flex';
            state.designSystemSubTab = 'stitch';
            
            // Refresh list
            refreshStitchDesignSystems();
        });

        document.getElementById('btn-goto-stitch-tab')?.addEventListener('click', () => {
            const stitchTabBtn = document.querySelector('.shared-tab-btn[data-tab="stitch"]');
            if (stitchTabBtn) {
                stitchTabBtn.click();
            }
        });

        document.getElementById('btn-refresh-design-systems')?.addEventListener('click', () => {
            refreshStitchDesignSystems();
        });

        document.getElementById('btn-create-design-system')?.addEventListener('click', () => {
            openDesignSystemModal();
        });

        // Create/Edit Design System modal closing
        document.getElementById('btn-close-design-system-modal')?.addEventListener('click', () => {
            document.getElementById('design-system-crud-modal').style.display = 'none';
        });
        document.getElementById('btn-cancel-design-system')?.addEventListener('click', () => {
            document.getElementById('design-system-crud-modal').style.display = 'none';
        });

        // Create/Edit Save
        document.getElementById('btn-save-design-system')?.addEventListener('click', () => {
            const assetId = document.getElementById('design-system-modal-asset-id').value;
            const displayName = document.getElementById('design-system-name').value.trim();
            const styleGuidelines = document.getElementById('design-system-guidelines').value.trim();
            const designTokens = document.getElementById('design-system-tokens').value.trim();

            if (!displayName) {
                alert('Please enter a display name.');
                return;
            }

            if (assetId) {
                vscode.postMessage({
                    type: 'stitchUpdateDesignSystem',
                    projectId: state.selectedStitchProjectId,
                    assetId,
                    displayName,
                    styleGuidelines,
                    designTokens,
                    workspaceRoot: state.stitchWorkspaceRoot
                });
            } else {
                vscode.postMessage({
                    type: 'stitchCreateDesignSystem',
                    projectId: state.selectedStitchProjectId,
                    displayName,
                    styleGuidelines,
                    designTokens,
                    workspaceRoot: state.stitchWorkspaceRoot
                });
            }
            document.getElementById('design-system-crud-modal').style.display = 'none';
        });

        // Apply Design System modal closing
        document.getElementById('btn-close-apply-modal')?.addEventListener('click', () => {
            document.getElementById('design-system-apply-modal').style.display = 'none';
        });
        document.getElementById('btn-cancel-apply')?.addEventListener('click', () => {
            document.getElementById('design-system-apply-modal').style.display = 'none';
        });

        // Apply Select All/None
        document.getElementById('btn-apply-select-all')?.addEventListener('click', () => {
            document.querySelectorAll('.apply-screen-checkbox').forEach(cb => cb.checked = true);
        });
        document.getElementById('btn-apply-select-none')?.addEventListener('click', () => {
            document.querySelectorAll('.apply-screen-checkbox').forEach(cb => cb.checked = false);
        });

        // Execute Apply
        document.getElementById('btn-execute-apply')?.addEventListener('click', () => {
            const assetId = document.getElementById('apply-design-system-asset-id').value;
            const selectedCbs = document.querySelectorAll('.apply-screen-checkbox:checked');
            const screenIds = Array.from(selectedCbs).map(cb => cb.value);

            if (screenIds.length === 0) {
                alert('Please select at least one screen to apply the design system to.');
                return;
            }

            vscode.postMessage({
                type: 'stitchApplyDesignSystem',
                projectId: state.selectedStitchProjectId,
                assetId,
                screenIds,
                workspaceRoot: state.stitchWorkspaceRoot
            });
            document.getElementById('design-system-apply-modal').style.display = 'none';
        });
    }

    function updateStitchAuthUI(msg) {
        const apiKey = msg.apiKey || '';
        
        // Update inputs
        const keyInput = document.getElementById('stitch-api-key-input');
        if (keyInput) keyInput.value = apiKey;

        // Update status indicator
        const indicator = document.getElementById('stitch-auth-status-indicator');
        const errMsg = document.getElementById('stitch-auth-error-msg');
        
        if (indicator) {
            if (msg.configured) {
                if (msg.valid) {
                    indicator.textContent = 'VALID';
                    indicator.style.background = '#1b4d3e';
                    indicator.style.color = '#76e4b8';
                    if (errMsg) errMsg.style.display = 'none';
                } else {
                    indicator.textContent = 'INVALID';
                    indicator.style.background = '#661c1c';
                    indicator.style.color = '#ff8f8f';
                    if (errMsg) {
                        errMsg.textContent = msg.error || 'Connection failed';
                        errMsg.style.display = 'block';
                    }
                }
            } else {
                indicator.textContent = 'NOT CONFIGURED';
                indicator.style.background = '#333';
                indicator.style.color = '#aaa';
                if (errMsg) errMsg.style.display = 'none';
            }
        }
    }

    function refreshStitchDesignSystems() {
        const noProj = document.getElementById('design-system-no-project');
        const wrapper = document.getElementById('stitch-design-systems-list-wrapper');
        const projName = document.getElementById('design-system-project-name');
        const btnCreate = document.getElementById('btn-create-design-system');
        const btnRefresh = document.getElementById('btn-refresh-design-systems');

        if (!state.selectedStitchProjectId) {
            if (noProj) noProj.style.display = 'flex';
            if (wrapper) wrapper.style.display = 'none';
            if (projName) projName.textContent = 'None Selected';
            if (btnCreate) btnCreate.style.display = 'none';
            if (btnRefresh) btnRefresh.style.display = 'none';
            return;
        }

        const option = (designSystemProjectSelect || stitchProjectSelect)?.querySelector(`option[value="${state.selectedStitchProjectId}"]`);
        if (projName) projName.textContent = option ? option.textContent : state.selectedStitchProjectId;

        if (noProj) noProj.style.display = 'none';
        if (wrapper) wrapper.style.display = 'block';
        if (btnCreate) btnCreate.style.display = 'inline-block';
        if (btnRefresh) btnRefresh.style.display = 'inline-block';

        const listContainer = document.getElementById('stitch-design-systems-list');
        if (listContainer) {
            listContainer.innerHTML = '<div style="font-size: 12px; color: var(--text-secondary); padding: 12px;">Loading design systems...</div>';
        }

        vscode.postMessage({
            type: 'stitchListDesignSystems',
            projectId: state.selectedStitchProjectId,
            workspaceRoot: state.stitchWorkspaceRoot
        });
    }

    function renderStitchDesignSystems() {
        const listContainer = document.getElementById('stitch-design-systems-list');
        if (!listContainer) return;

        if (!state.stitchDesignSystems || state.stitchDesignSystems.length === 0) {
            listContainer.innerHTML = '<div style="font-size: 12px; color: var(--text-secondary); padding: 16px; text-align: center; border: 1px dashed var(--border-color); border-radius: 4px;">No design systems found for this project.</div>';
            return;
        }

        listContainer.innerHTML = '';
        state.stitchDesignSystems.forEach(ds => {
            const card = document.createElement('div');
            card.className = 'cyber-card';
            card.style.display = 'flex';
            card.style.flexDirection = 'column';
            card.style.gap = '8px';
            card.style.padding = '12px';
            card.style.border = '1px solid var(--border-color)';
            card.style.borderRadius = '4px';
            card.style.background = 'var(--panel-bg)';

            // Header row
            const headerRow = document.createElement('div');
            headerRow.style.display = 'flex';
            headerRow.style.justifyContent = 'space-between';
            headerRow.style.alignItems = 'center';
            headerRow.style.borderBottom = '1px solid var(--border-color)';
            headerRow.style.paddingBottom = '6px';
            const title = document.createElement('strong');
            title.style.fontSize = '13px';
            title.style.color = 'var(--text-primary)';
            let displayTitle = ds.displayName;
            if (!displayTitle || displayTitle === ds.id) {
                const shortId = typeof ds.id === 'string' && ds.id.length > 8 ? ds.id.substring(0, 8) : ds.id;
                displayTitle = `Design System (${shortId})`;
            }
            title.textContent = displayTitle;

            const idLabel = document.createElement('span');
            idLabel.style.fontSize = '10px';
            idLabel.style.color = 'var(--text-secondary)';
            idLabel.style.fontFamily = 'var(--font-mono)';
            idLabel.textContent = ds.id;

            headerRow.appendChild(title);
            headerRow.appendChild(idLabel);

            // Guidelines
            const guidelines = document.createElement('div');
            guidelines.style.fontSize = '11px';
            guidelines.style.color = 'var(--text-secondary)';
            guidelines.style.margin = '4px 0';
            guidelines.textContent = ds.styleGuidelines || 'No style guidelines provided.';

            // Design Tokens summary
            const tokens = document.createElement('div');
            tokens.style.fontSize = '11px';
            tokens.style.color = 'var(--text-secondary)';
            tokens.style.margin = '4px 0';
            let tokenText = 'No design tokens';
            if (ds.designTokens) {
                try {
                    const parsed = JSON.parse(ds.designTokens);
                    const keys = Object.keys(parsed);
                    if (keys.length > 0) {
                        tokenText = `${keys.length} design token(s) configured (${keys.slice(0, 5).join(', ')}${keys.length > 5 ? '...' : ''})`;
                    }
                } catch {
                    tokenText = 'Design tokens configured';
                }
            }
            tokens.textContent = 'Tokens: ' + tokenText;

            // Actions row
            const actionsRow = document.createElement('div');
            actionsRow.style.display = 'flex';
            actionsRow.style.gap = '8px';
            actionsRow.style.marginTop = '6px';

            const btnEdit = document.createElement('button');
            btnEdit.className = 'strip-btn';
            btnEdit.style.fontSize = '11px';
            btnEdit.style.padding = '2px 8px';
            btnEdit.textContent = 'Edit';
            btnEdit.addEventListener('click', () => {
                openDesignSystemModal(ds);
            });

            const btnApply = document.createElement('button');
            btnApply.className = 'strip-btn stitch-btn-primary';
            btnApply.style.fontSize = '11px';
            btnApply.style.padding = '2px 8px';
            btnApply.textContent = 'Apply to Screens';
            btnApply.addEventListener('click', () => {
                openApplyModal(ds);
            });

            actionsRow.appendChild(btnEdit);
            actionsRow.appendChild(btnApply);

            card.appendChild(headerRow);
            card.appendChild(guidelines);
            card.appendChild(tokens);
            card.appendChild(actionsRow);

            listContainer.appendChild(card);
        });
    }

    function openDesignSystemModal(ds = null) {
        const modal = document.getElementById('design-system-crud-modal');
        const title = document.getElementById('design-system-modal-title');
        const assetIdInput = document.getElementById('design-system-modal-asset-id');
        const nameInput = document.getElementById('design-system-name');
        const guidelinesInput = document.getElementById('design-system-guidelines');
        const tokensInput = document.getElementById('design-system-tokens');

        if (!modal) return;

        if (ds) {
            title.textContent = 'Edit Design System';
            assetIdInput.value = ds.id;
            nameInput.value = ds.displayName;
            guidelinesInput.value = ds.styleGuidelines;
            tokensInput.value = ds.designTokens;
        } else {
            title.textContent = 'Create Design System';
            assetIdInput.value = '';
            nameInput.value = '';
            guidelinesInput.value = '';
            tokensInput.value = JSON.stringify({
                colors: {
                    primary: '#007acc',
                    background: '#1e1e1e',
                    text: '#ffffff'
                },
                typography: {
                    fontFamily: 'Inter, sans-serif'
                }
            }, null, 2);
        }

        modal.style.display = 'flex';
    }

    function openApplyModal(ds) {
        const modal = document.getElementById('design-system-apply-modal');
        const assetIdInput = document.getElementById('apply-design-system-asset-id');
        const nameDisplay = document.getElementById('apply-design-system-name-display');
        const screensList = document.getElementById('apply-screens-list');

        if (!modal || !screensList) return;

        assetIdInput.value = ds.id;
        nameDisplay.textContent = ds.displayName;
        screensList.innerHTML = '';

        if (!state.stitchScreens || state.stitchScreens.length === 0) {
            screensList.innerHTML = '<div style="font-size: 11px; color: var(--text-secondary); padding: 8px;">No screens found in this project. Load screens in Stitch tab first.</div>';
        } else {
            state.stitchScreens.forEach(s => {
                const label = document.createElement('label');
                label.style.display = 'flex';
                label.style.alignItems = 'center';
                label.style.gap = '8px';
                label.style.fontSize = '12px';
                label.style.cursor = 'pointer';
                label.style.padding = '4px 0';

                const cb = document.createElement('input');
                cb.type = 'checkbox';
                cb.className = 'apply-screen-checkbox';
                cb.value = s.id;
                cb.checked = true;

                const textSpan = document.createElement('span');
                textSpan.textContent = s.displayName || s.name || s.id;

                label.appendChild(cb);
                label.appendChild(textSpan);
                screensList.appendChild(label);
            });
        }

        modal.style.display = 'flex';
    }

    function applySidebarState() {
        const designRow = document.getElementById('tree-pane-design')?.closest('.content-row');
        if (designRow) designRow.classList.toggle('collapsed', !!state.designPreviewCollapsed);
        const htmlRow = document.getElementById('tree-pane-html')?.closest('.content-row');
        if (htmlRow) htmlRow.classList.toggle('collapsed', !!state.htmlPreviewCollapsed);
        const claudeRow = document.getElementById('tree-pane-claude')?.closest('.content-row');
        if (claudeRow) claudeRow.classList.toggle('collapsed', !!state.claudePreviewCollapsed);
        const briefsRow = document.getElementById('tree-pane-briefs')?.closest('.content-row');
        if (briefsRow) briefsRow.classList.toggle('collapsed', !!state.briefsPreviewCollapsed);
        const imagesRow = document.getElementById('tree-pane-images')?.closest('.content-row');
        if (imagesRow) imagesRow.classList.toggle('collapsed', !!state.imagesPreviewCollapsed);
    }

    // Claude Helpers & Handlers
    function findTreeNodeInPane(paneId, nodeId) {
        const pane = document.getElementById(paneId);
        if (!pane) return null;
        return pane.querySelector(`.tree-node[data-node-id="${nodeId}"]`);
    }

    function loadClaudePreview(sourceId, docId, docName) {
        const pane = document.getElementById('tree-pane-claude');
        if (pane) {
            pane.querySelectorAll('.tree-node.selected').forEach(el => el.classList.remove('selected'));
        }
        const wrapper = findTreeNodeInPane('tree-pane-claude', docId);
        const sourceFolder = wrapper ? wrapper.dataset.sourceFolder : undefined;
        if (wrapper) {
            wrapper.classList.add('selected');
        }
        state.activeClaudeDocId = docId;
        state.previewRequestId++;

        let relativePath = docId.includes(':') ? docId.substring(docId.indexOf(':') + 1) : docId;
        const parts = relativePath.replace(/\\/g, '/').split('/');
        parts.pop();
        state.claudeTargetFolder = parts.join('/') || '';

        const initialState = document.getElementById('claude-initial-state');
        const loadingState = document.getElementById('claude-loading-state');
        const iframeWrapper = document.getElementById('claude-preview-wrapper');
        const imageContainer = document.getElementById('image-preview-container-claude');
        const imageImg = document.getElementById('image-preview-img-claude');
        if (initialState) initialState.style.display = 'none';
        if (loadingState) loadingState.style.display = 'flex';
        if (iframeWrapper) iframeWrapper.style.display = 'none';
        if (imageContainer) imageContainer.style.display = 'none';
        if (imageImg) imageImg.removeAttribute('src');

        vscode.postMessage({
            type: 'fetchPreview',
            sourceId,
            docId,
            target: 'claude',
            requestId: state.previewRequestId,
            sourceFolder
        });
    }

    const CLAUDE_IMPORT_PROMPT = ({ folder, projectRef }) =>
      `Import a design from claude.ai/design into this repository, writing the implementation into \`${folder}\`, built with the repo's existing components and styles. ` +
      (projectRef
        ? `Use the Claude Design project: ${projectRef}. `
        : `First list my available claude.ai/design projects and ask me which one (and which screen) to import. `) +
      `If you're not logged in to Claude Design, run /design-login first.`;

    document.getElementById('btn-copy-claude-prompt')?.addEventListener('click', () => {
        const projectInput = document.getElementById('claude-design-project');
        const projectRef = projectInput ? projectInput.value.trim() : '';
        const folder = state.claudeTargetFolder || getClaudeWorkspaceRootFallback();
        const prompt = CLAUDE_IMPORT_PROMPT({ folder, projectRef });
        vscode.postMessage({
            type: 'copyClaudeImportPrompt',
            prompt
        });
    });

    function getClaudeWorkspaceRootFallback() {
        const select = document.getElementById('claude-workspace-filter');
        if (select && select.value) return select.value;
        return state.claudeWorkspaceRootFilter || '';
    }

    function renderClaudeDocs(rootEntry) {
        const { sourceId, nodes, folderPaths } = rootEntry;
        const treePaneClaude = document.getElementById('tree-pane-claude');
        if (!treePaneClaude) return;

        treePaneClaude.innerHTML = '';

        const toggleRow = document.createElement('div');
        toggleRow.className = 'sidebar-toggle-row';

        const foldersBtn = document.createElement('button');
        foldersBtn.className = 'sidebar-folders-btn';
        foldersBtn.title = 'Manage Folders';
        foldersBtn.textContent = 'Manage Folders';
        foldersBtn.addEventListener('click', () => openFoldersModal('claude'));
        toggleRow.appendChild(foldersBtn);

        const toggleBtn = document.createElement('button');
        toggleBtn.className = 'sidebar-toggle-btn';
        toggleBtn.title = 'Toggle sidebar';
        toggleBtn.textContent = state.claudePreviewCollapsed ? '»' : '«';
        toggleBtn.addEventListener('click', toggleSidebarCollapsed);
        toggleRow.appendChild(toggleBtn);
        treePaneClaude.appendChild(toggleRow);

        const docList = document.createElement('div');
        docList.className = 'source-doc-list';
        docList.dataset.sourceId = sourceId;
        treePaneClaude.appendChild(docList);

        if (!nodes || nodes.length === 0) {
            docList.innerHTML = '<div class="empty-state" style="padding: 12px; font-size: 12px; color: var(--text-secondary);">No files or folders found.</div>';
            return;
        }

        let docNodes = (nodes || []).filter(n => {
            if (n.kind === 'folder') return true;
            const ext = n.name.substring(n.name.lastIndexOf('.')).toLowerCase();
            return ['.html', '.htm', '.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.bmp'].includes(ext);
        });

        const search = String(state.claudeDocsSearch || '').trim().toLowerCase();
        if (search) {
            docNodes = docNodes.filter(d => (d.title || d.name || '').toLowerCase().includes(search));
        }

        if (docNodes.length === 0) {
            docList.innerHTML = '<div class="empty-state" style="padding: 12px; font-size: 12px; color: var(--text-secondary);">No matching files or folders found.</div>';
            return;
        }

        // Partition the nodes by type so each group renders under its own subheader
        // (Folders / HTML / Images), matching the HTML Previews and Images tabs.
        const getFileExt = (name) => {
            const i = name.lastIndexOf('.');
            return i >= 0 ? name.substring(i).toLowerCase() : '';
        };
        const folderNodes = docNodes.filter(n => n.kind === 'folder');
        const htmlNodes = docNodes.filter(n => n.kind !== 'folder' && ['.html', '.htm'].includes(getFileExt(n.name)));
        const imageNodes = docNodes.filter(n => n.kind !== 'folder' && ['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.bmp'].includes(getFileExt(n.name)));

        function renderGroup(subheaderText, groupNodes, isImageGroup) {
            if (groupNodes.length === 0) return;
            const subheader = document.createElement('div');
            subheader.className = 'type-subheader';
            subheader.textContent = subheaderText;
            docList.appendChild(subheader);

            groupNodes.forEach(doc => {
                const isFolder = doc.kind === 'folder';
                const card = renderDocCard({
                    title: doc.name || doc.id,
                    subtitle: isFolder ? 'Folder' : (isImageGroup ? 'Image' : 'HTML'),
                    sourceId,
                    nodeId: doc.id,
                    nodeMetadata: doc.metadata,
                    actions: [],
                    isSelected: isFolder ? false : (state.activeClaudeDocId === doc.id),
                    clickHandler: () => {
                        if (isFolder) {
                            let relativePath = doc.id.includes(':') ? doc.id.substring(doc.id.indexOf(':') + 1) : doc.id;
                            state.claudeTargetFolder = relativePath;

                            const pane = document.getElementById('tree-pane-claude');
                            if (pane) {
                                pane.querySelectorAll('.tree-node.selected').forEach(el => el.classList.remove('selected'));
                            }
                            const wrapper = findTreeNodeInPane('tree-pane-claude', doc.id);
                            if (wrapper) {
                                wrapper.classList.add('selected');
                            }
                        } else {
                            loadClaudePreview(sourceId, doc.id, doc.name);
                        }
                    }
                });
                docList.appendChild(card);
            });
        }

        renderGroup('Folders', folderNodes, false);
        renderGroup('HTML', htmlNodes, false);
        renderGroup('Images', imageNodes, true);
    }

    function applySidebarState() {
        const designRow = document.getElementById('tree-pane-design')?.closest('.content-row');
        if (designRow) designRow.classList.toggle('collapsed', !!state.designPreviewCollapsed);
        const htmlRow = document.getElementById('tree-pane-html')?.closest('.content-row');
        if (htmlRow) htmlRow.classList.toggle('collapsed', !!state.htmlPreviewCollapsed);
        const claudeRow = document.getElementById('tree-pane-claude')?.closest('.content-row');
        if (claudeRow) claudeRow.classList.toggle('collapsed', !!state.claudePreviewCollapsed);
        const briefsRow = document.getElementById('tree-pane-briefs')?.closest('.content-row');
        if (briefsRow) briefsRow.classList.toggle('collapsed', !!state.briefsPreviewCollapsed);
        const imagesRow = document.getElementById('tree-pane-images')?.closest('.content-row');
        if (imagesRow) imagesRow.classList.toggle('collapsed', !!state.imagesPreviewCollapsed);
    }

    // Notify backend ready
    vscode.postMessage({ type: 'ready' });

    applySidebarState();

    // Restore folder modal state if it was open before a reload
    const persistedModalState = vscode.getState();
    if (persistedModalState?.folderModalOpen && persistedModalState?.folderModalScope) {
        openFoldersModal(persistedModalState.folderModalScope);
    }

    updateDesignDocControls();
})();
