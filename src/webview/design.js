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
        designEditMode: false,
        designEditOriginalContent: '',
        designSystemDocEnabled: false,
        designSystemDocSourceId: null,
        designSystemDocId: null,
        selectedEl: null,
        previewRequestId: 0,
        htmlFolderPathsByRoot: persistedState.htmlFolderPathsByRoot || {},
        designFolderPathsByRoot: persistedState.designFolderPathsByRoot || {},
        htmlPreviewCollapsed: persistedState.htmlPreviewCollapsed || false,
        designPreviewCollapsed: persistedState.designPreviewCollapsed || false,
        imagesPreviewCollapsed: persistedState.imagesPreviewCollapsed || false,
        htmlWorkspaceRootFilter: '',
        designWorkspaceRootFilter: '',
        imagesWorkspaceRootFilter: '',
        stitchWorkspaceRoot: '',
        htmlDocsSearch: '',
        designDocsSearch: '',
        imagesDocsSearch: '',
        _lastHtmlDocsMsg: null,
        _lastDesignDocsMsg: null,
        _lastImagesDocsMsg: null,
        stitchProjects: [],
        selectedStitchProjectId: '',
        stitchScreens: [],
        stitchApiKeyConfigured: false,
        activePreviewScreenId: null,
        stitchModelId: ['GEMINI_3_FLASH','GEMINI_3_1_PRO'].includes(persistedState.stitchModelId) ? persistedState.stitchModelId : 'GEMINI_3_FLASH',
        stitchCreativeRange: ['EXPLORE','REFINE','REIMAGINE'].includes(persistedState.stitchCreativeRange) ? persistedState.stitchCreativeRange : 'EXPLORE',
        stitchAspects: Array.isArray(persistedState.stitchAspects) && persistedState.stitchAspects.every(a => typeof a === 'string') ? persistedState.stitchAspects : ['LAYOUT','COLOR_SCHEME','IMAGES','TEXT_FONT','TEXT_CONTENT'],
        stitchThumbnailStripCollapsed: persistedState.stitchThumbnailStripCollapsed || false,
        stitchGeneratorOpen: false,
        stitchGeneratorImages: [],
        stitchReloadPending: false,  // true while waiting for a reload response
        stitchReloadRetries: 0,    // count of retries so far
        stitchReloadTimer: null,     // holds setTimeout id
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
    const tabBtns = document.querySelectorAll('.research-tab-btn');
    const tabContents = document.querySelectorAll('.research-tab-content');

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
            vscode.postMessage({
                type: 'stitchListProjects',
                workspaceRoot: state.stitchWorkspaceRoot
            });
        }
    }

    tabBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            switchTab(btn.dataset.tab);
        });
    });

    // ── Zoom/Pan Engine ──
    const zoomState = {
        html:     { scale: 1, panX: 0, panY: 0, isPanning: false, startX: 0, startY: 0, panSource: null },
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
    initZoomListeners('image-preview-container', '.zoomable-viewport', 'html');
    initZoomListeners('image-preview-container-images', '.zoomable-viewport', 'images');
    initZoomListeners('image-preview-container-design', '.zoomable-viewport', 'design');

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

    // ── Tree Rendering: Design Docs ──
    function renderDesignDocs(rootEntry) {
        const { sourceId, nodes, folderPaths } = rootEntry;
        const treePaneDesign = document.getElementById('tree-pane-design');
        if (!treePaneDesign) return;

        treePaneDesign.innerHTML = '';

        const toggleRow = document.createElement('div');
        toggleRow.className = 'sidebar-toggle-row';

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

        if (!nodes || nodes.length === 0) {
            docList.innerHTML = '<div class="empty-state" style="padding: 12px; font-size: 12px; color: var(--text-secondary);">No design system documents found.</div>';
            return;
        }

        let docNodes = (nodes || []).filter(n => n.kind === 'document');
        const search = String(state.designDocsSearch || '').trim().toLowerCase();
        if (search) {
            docNodes = docNodes.filter(d => (d.title || d.name || '').toLowerCase().includes(search));
        }

        docNodes.forEach(node => {
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

            const card = renderDocCard({
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
            docList.appendChild(card);
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

        if (!nodes || nodes.length === 0) {
            docList.innerHTML = '<div class="empty-state" style="padding: 12px; font-size: 12px; color: var(--text-secondary);">No HTML preview files found.</div>';
            return;
        }

        let docNodes = (nodes || []).filter(n => n.kind === 'document');
        docNodes = docNodes.filter(d => {
            const ext = d.name.substring(d.name.lastIndexOf('.')).toLowerCase();
            return ['.html', '.htm'].includes(ext);
        });

        const search = String(state.htmlDocsSearch || '').trim().toLowerCase();
        if (search) {
            docNodes = docNodes.filter(d => (d.title || d.name || '').toLowerCase().includes(search));
        }

        if (docNodes.length === 0) {
            docList.innerHTML = '<div class="empty-state" style="padding: 12px; font-size: 12px; color: var(--text-secondary);">No matching HTML preview files found.</div>';
            return;
        }

        const typeSubheader = document.createElement('div');
        typeSubheader.className = 'type-subheader';
        typeSubheader.textContent = 'HTML Previews';
        docList.appendChild(typeSubheader);

        docNodes.forEach(doc => {
            const card = renderDocCard({
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
            docList.appendChild(card);
        });
    }

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
            docNodes = docNodes.filter(d => (d.title || d.name || '').toLowerCase().includes(search));
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
            const openBtn = document.getElementById('btn-open-browser-html');
            const copyBtn = document.getElementById('btn-copy-link-html');
            const isHtmlFile = /\.html?$/i.test(docName || docId || '');
            if (openBtn) {
                openBtn.disabled = !isHtmlFile;
                openBtn.onclick = !isHtmlFile ? null : () => {
                    vscode.postMessage({
                        type: 'serveAndOpenHtml',
                        docId,
                        docName,
                        absolutePath: wrapper ? wrapper.dataset.absolutePath : undefined,
                        sourceFolder
                    });
                };
            }
            if (copyBtn) {
                copyBtn.disabled = false;
                copyBtn.onclick = () => {
                    vscode.postMessage({
                        type: 'linkToDocument',
                        sourceId,
                        docId,
                        docName,
                        sourceFolder
                    });
                };
            }

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
            const copyBtn = document.getElementById('btn-copy-link-images');
            if (copyBtn) {
                copyBtn.disabled = false;
                copyBtn.onclick = () => {
                    vscode.postMessage({
                        type: 'linkToDocument',
                        sourceId: 'html-folder',
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
        }
    }

    function handlePreviewReady(msg) {
        const { sourceId, requestId, content, docName, isAutoRefreshed, filePath, htmlContent, webviewUri, isImage } = msg;

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
            const htmlWrapper = document.querySelector('#html-preview-content .preview-panel-wrapper');

            if (isImage && webviewUri) {
                if (iframeWrapper) iframeWrapper.style.display = 'none';
                if (iframe) { iframe.removeAttribute('src'); iframe.removeAttribute('srcdoc'); }
                if (imageContainer) { imageContainer.style.display = 'flex'; }
                if (htmlWrapper) htmlWrapper.classList.add('scanlines-suppressed');
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
                if (htmlWrapper) htmlWrapper.classList.add('scanlines-suppressed');
                if (iframe) {
                    iframe.setAttribute('sandbox', 'allow-scripts');
                    iframe.removeAttribute('srcdoc');
                    iframe.src = isAutoRefreshed ? msg.iframeSrc + '?t=' + Date.now() : msg.iframeSrc;
                }
                if (imageContainer) imageContainer.style.display = 'none';
                if (imageImg) imageImg.removeAttribute('src');
                const iframeViewport = iframeWrapper ? iframeWrapper.querySelector('.zoomable-viewport') : null;
                if (iframeViewport) applyZoom('html', iframeViewport);
            } else if (htmlContent) {
                if (iframeWrapper) iframeWrapper.style.display = 'flex';
                if (htmlWrapper) htmlWrapper.classList.add('scanlines-suppressed');
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
            }
            const statusHtml = document.getElementById('status-html');
            if (statusHtml) {
                statusHtml.textContent = isAutoRefreshed ? `${docName || 'Loaded'} — auto-refreshed` : (docName || 'Loaded');
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
            const designWrapper = document.querySelector('#design-content .preview-panel-wrapper');

            if (isImage && webviewUri) {
                if (mdPrev) mdPrev.style.display = 'none';
                if (jsonCont) jsonCont.style.display = 'none';
                if (imgCont) imgCont.style.display = 'flex';
                if (imgImg) imgImg.src = webviewUri + '?t=' + Date.now();
                if (designWrapper) designWrapper.classList.add('scanlines-suppressed');
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
                if (designWrapper) designWrapper.classList.add('scanlines-suppressed');
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
                if (designWrapper) designWrapper.classList.add('scanlines-suppressed');
            } else {
                // Markdown/Text
                if (imgCont) imgCont.style.display = 'none';
                if (jsonCont) jsonCont.style.display = 'none';
                if (mdPrev) {
                    mdPrev.style.display = 'block';
                    mdPrev.innerHTML = renderMarkdown(content) || '';
                }
                if (designWrapper) designWrapper.classList.remove('scanlines-suppressed');
            }

            if (statusDesign) {
                statusDesign.textContent = isAutoRefreshed ? 'Auto-refreshed' : 'Loaded';
                statusDesign.style.color = 'var(--accent-teal)';
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

    // ── Stitch UI Controls ──
    const stitchProjectSelect = document.getElementById('stitch-project-select');
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
    const btnOpenDesignMd = document.getElementById('btn-open-design-md');

    function saveState() {
        vscode.setState({
            ...vscode.getState(),
            designPreviewCollapsed: state.designPreviewCollapsed,
            htmlPreviewCollapsed: state.htmlPreviewCollapsed,
            imagesPreviewCollapsed: state.imagesPreviewCollapsed,
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
    const previewRefineInput = document.getElementById('preview-refine-input');
    let previewBtnEdit = document.getElementById('preview-btn-edit');
    let previewBtnVariants = document.getElementById('preview-btn-variants');
    const previewBtnReload = document.getElementById('preview-btn-reload');
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

    const btnStitchPromptGenerator = document.getElementById('btn-stitch-prompt-generator');
    const stitchPromptModal = document.getElementById('stitch-prompt-modal');
    const btnCloseStitchGenerator = document.getElementById('btn-close-stitch-generator');
    const stitchGeneratorInput = document.getElementById('stitch-generator-input');
    const stitchGeneratorImageInput = document.getElementById('stitch-generator-image-input');
    const stitchGeneratorThumbnails = document.getElementById('stitch-generator-thumbnails');
    const btnCopyStitchPrompt = document.getElementById('btn-copy-stitch-prompt');

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
        if (stitchGallery) {
            stitchGallery.querySelectorAll('button').forEach(b => { b.disabled = busy; });
        }
        if (previewBtnHtml) previewBtnHtml.disabled = busy;
        if (previewBtnPng) previewBtnPng.disabled = busy;
        if (previewBtnEdit) previewBtnEdit.disabled = busy;
        if (previewBtnVariants) previewBtnVariants.disabled = busy;
        if (previewBtnReload) previewBtnReload.disabled = busy;

        if (btnStitchPromptGenerator) btnStitchPromptGenerator.disabled = busy;
        updateCopyButtonState();
    }

    function updateCopyButtonState() {
        if (!btnCopyStitchPrompt) return;
        const hasText = !!(stitchGeneratorInput && stitchGeneratorInput.value.trim());
        const hasImages = state.stitchGeneratorImages && state.stitchGeneratorImages.length > 0;
        btnCopyStitchPrompt.disabled = state.stitchBusy || (!hasText && !hasImages);
    }

    function openStitchGenerator() {
        if (state.stitchBusy) return;
        state.stitchGeneratorOpen = true;
        if (stitchPromptModal) {
            stitchPromptModal.style.display = 'flex';
        }
        if (stitchGeneratorInput) {
            stitchGeneratorInput.value = '';
            stitchGeneratorInput.focus();
        }
        clearStitchGeneratorImages();
        updateCopyButtonState();
    }

    function closeStitchGenerator() {
        state.stitchGeneratorOpen = false;
        if (stitchPromptModal) {
            stitchPromptModal.style.display = 'none';
        }
        clearStitchGeneratorImages();
    }

    function clearStitchGeneratorImages() {
        if (state.stitchGeneratorImages && state.stitchGeneratorImages.length > 0) {
            state.stitchGeneratorImages.forEach(imgObj => {
                if (imgObj.objectUrl) {
                    URL.revokeObjectURL(imgObj.objectUrl);
                }
            });
        }
        state.stitchGeneratorImages = [];
        if (stitchGeneratorThumbnails) {
            stitchGeneratorThumbnails.innerHTML = '';
        }
        if (stitchGeneratorImageInput) {
            stitchGeneratorImageInput.value = '';
        }
        updateCopyButtonState();
    }

    function handleStitchGeneratorImagesChange(e) {
        const files = e.target.files;
        if (!files) return;

        for (let i = 0; i < files.length; i++) {
            const file = files[i];
            const objectUrl = URL.createObjectURL(file);
            const imgObj = {
                name: file.name,
                objectUrl: objectUrl
            };
            state.stitchGeneratorImages.push(imgObj);
            renderThumbnail(imgObj);
        }
        updateCopyButtonState();
    }

    function renderThumbnail(imgObj) {
        if (!stitchGeneratorThumbnails) return;

        const container = document.createElement('div');
        container.className = 'stitch-generator-thumb-container';

        const img = document.createElement('img');
        img.className = 'stitch-generator-thumb';
        img.src = imgObj.objectUrl;
        img.alt = imgObj.name;
        img.title = imgObj.name;

        const removeBtn = document.createElement('button');
        removeBtn.className = 'stitch-generator-thumb-remove';
        removeBtn.innerHTML = '&times;';
        removeBtn.title = 'Remove image';
        removeBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            URL.revokeObjectURL(imgObj.objectUrl);
            state.stitchGeneratorImages = state.stitchGeneratorImages.filter(item => item !== imgObj);
            container.remove();
            updateCopyButtonState();
        });

        container.appendChild(img);
        container.appendChild(removeBtn);
        stitchGeneratorThumbnails.appendChild(container);
    }

    function generateStitchMetaPrompt(userDescription, imageRefs) {
        const baseTemplate = `You are a UI/UX design prompt engineer. Your job is to transform a rough design idea and reference images into a single, detailed, high-quality text prompt suitable for an AI screen generator (Stitch by Google).

User's design intent:
---
{{USER_DESCRIPTION}}
---

Reference images (inspect these for style, layout, colour palette, typography, and mood):
{{IMAGE_REFS}}

Output a single paragraph prompt (150-400 words) that describes:
- The overall layout and visual hierarchy
- Colour palette and mood
- Typography style
- Specific UI components and their arrangement
- Any animations, interactions, or micro-copy
- Device type considerations

Do not output markdown headers, bullet lists, or explanations. Output only the final prompt text.`;

        let imagesList = 'None';
        if (imageRefs && imageRefs.length > 0) {
            imagesList = imageRefs.map(name => `- Image: ${name}`).join('\n');
        }

        return baseTemplate
            .replace('{{USER_DESCRIPTION}}', userDescription || '')
            .replace('{{IMAGE_REFS}}', imagesList);
    }

    async function copyStitchPromptToClipboard() {
        if (!btnCopyStitchPrompt) return;
        const description = stitchGeneratorInput ? stitchGeneratorInput.value.trim() : '';
        const imageRefs = state.stitchGeneratorImages.map(img => img.name);

        const promptText = generateStitchMetaPrompt(description, imageRefs);
        const originalText = btnCopyStitchPrompt.innerText || 'Copy Prompt';

        try {
            await navigator.clipboard.writeText(promptText);
            btnCopyStitchPrompt.innerText = 'COPIED';
            btnCopyStitchPrompt.disabled = true;
            setTimeout(() => {
                btnCopyStitchPrompt.innerText = originalText;
                updateCopyButtonState();
            }, 2000);
        } catch (err) {
            console.error('Failed to copy text: ', err);
            btnCopyStitchPrompt.innerText = 'FAILED';
            setTimeout(() => {
                btnCopyStitchPrompt.innerText = originalText;
                updateCopyButtonState();
            }, 2000);
        }
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

    function clearStitchReloadTimer() {
        if (state.stitchReloadTimer) {
            clearTimeout(state.stitchReloadTimer);
            state.stitchReloadTimer = null;
        }
        state.stitchReloadPending = false;
        state.stitchReloadRetries = 0;
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
                    if (!state.stitchReloadPending) {
                        state.stitchReloadPending = true;
                        state.stitchReloadRetries = 0;
                        vscode.postMessage({
                            type: 'stitchRefreshScreen',
                            projectId: screen.projectId || stitchProjectSelect.value,
                            screenId: screen.id,
                            workspaceRoot: state.stitchWorkspaceRoot
                        });
                    }
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
                    newReloadBtn.addEventListener('click', () => {
                        if (state.stitchBusy) return;
                        clearStitchReloadTimer();
                        state.stitchReloadPending = true;
                        state.stitchReloadRetries = 0;
                        setStitchStatus('Reloading screen…', 'busy');
                        setStitchBusy(true);
                        vscode.postMessage({
                            type: 'stitchRefreshScreen',
                            projectId: screen.projectId || stitchProjectSelect.value,
                            screenId: screen.id,
                            workspaceRoot: state.stitchWorkspaceRoot
                        });
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
                    destination,
                    workspaceRoot: state.stitchWorkspaceRoot
                });
            });
        }
        if (previewBtnPng) {
            const newPngBtn = previewBtnPng.cloneNode(true);
            previewBtnPng.parentNode.replaceChild(newPngBtn, previewBtnPng);
            previewBtnPng = newPngBtn;
            previewBtnPng.addEventListener('click', () => {
                const destSelect = document.getElementById('preview-destination-select');
                const destination = destSelect ? destSelect.value : '';
                vscode.postMessage({
                    type: 'stitchDownloadAsset',
                    url: screen.imageUrl,
                    filename: `${screen.id}.png`,
                    destination,
                    workspaceRoot: state.stitchWorkspaceRoot
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
                clearStitchReloadTimer();
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
                clearStitchReloadTimer();
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
        clearStitchReloadTimer();
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
            } else if (state.stitchGeneratorOpen) {
                closeStitchGenerator();
                e.stopPropagation();
            }
        }
    });

    if (btnStitchPromptGenerator) {
        btnStitchPromptGenerator.addEventListener('click', openStitchGenerator);
    }
    if (btnCloseStitchGenerator) {
        btnCloseStitchGenerator.addEventListener('click', closeStitchGenerator);
    }
    if (stitchPromptModal) {
        stitchPromptModal.addEventListener('click', (e) => {
            if (e.target === stitchPromptModal) {
                closeStitchGenerator();
            }
        });
    }
    if (stitchGeneratorInput) {
        stitchGeneratorInput.addEventListener('input', updateCopyButtonState);
    }
    if (stitchGeneratorImageInput) {
        stitchGeneratorImageInput.addEventListener('change', handleStitchGeneratorImagesChange);
    }
    if (btnCopyStitchPrompt) {
        btnCopyStitchPrompt.addEventListener('click', copyStitchPromptToClipboard);
    }
    updateCopyButtonState();

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

            clearStitchReloadTimer();
            setStitchStatus('Generating screen…', 'busy');
            setStitchBusy(true);

            vscode.postMessage({
                type: 'stitchGenerate',
                prompt,
                deviceType,
                projectId: projectId || undefined,
                modelId: state.stitchModelId,
                workspaceRoot: state.stitchWorkspaceRoot
            });
        });
    }

    if (stitchProjectSelect) {
        stitchProjectSelect.addEventListener('change', () => {
            const projectId = stitchProjectSelect.value;
            state.selectedStitchProjectId = projectId;
            if (state.stitchWorkspaceRoot) {
                persistTab('stitch.projectId', projectId, state.stitchWorkspaceRoot);
            }
            clearStitchReloadTimer();
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

    function populateStitchProjects(projects, defaultProjectId) {
        if (!stitchProjectSelect) return;
        // Prioritize in-memory selectedStitchProjectId, then dropdown value, then configured default
        const current = state.selectedStitchProjectId || stitchProjectSelect.value || defaultProjectId || '';
        stitchProjectSelect.innerHTML = '<option value="">Select Project...</option>';
        projects.forEach(p => {
            const opt = document.createElement('option');
            opt.value = p.id;
            opt.textContent = p.name || p.id;
            if (p.id === current) opt.selected = true;
            stitchProjectSelect.appendChild(opt);
        });
        
        // Update selectedStitchProjectId to whatever was selected
        state.selectedStitchProjectId = stitchProjectSelect.value;
        if (state.stitchWorkspaceRoot && state.selectedStitchProjectId) {
            persistTab('stitch.projectId', state.selectedStitchProjectId, state.stitchWorkspaceRoot);
        }
    }

    function renderStitchScreens(screens) {
        state.stitchScreens = screens;
        if (!stitchGallery || !stitchGalleryEmpty) return;

        // If preview pane is active and screen is in the new list, update the active preview
        if (state.activePreviewScreenId) {
            const activeScreen = screens.find(s => s.id === state.activePreviewScreenId);
            if (activeScreen) {
                openStitchPreview(activeScreen);
            } else {
                closeStitchPreview();
            }
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
                    clearStitchReloadTimer();
                    state.stitchReloadPending = true;
                    state.stitchReloadRetries = 0;
                    setStitchStatus('Reloading screen…', 'busy');
                    setStitchBusy(true);
                    vscode.postMessage({
                        type: 'stitchRefreshScreen',
                        projectId: screen.projectId || stitchProjectSelect.value,
                        screenId: screen.id,
                        workspaceRoot: state.stitchWorkspaceRoot
                    });
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

            const btnHtml = document.createElement('button');
            btnHtml.className = 'strip-btn';
            btnHtml.textContent = 'DL HTML';
            btnHtml.addEventListener('click', () => {
                vscode.postMessage({
                    type: 'stitchDownloadAsset',
                    url: screen.htmlUrl,
                    filename: `${screen.id}.html`,
                    workspaceRoot: state.stitchWorkspaceRoot
                });
            });
            actions.appendChild(btnHtml);

            const btnPng = document.createElement('button');
            btnPng.className = 'strip-btn';
            btnPng.textContent = 'DL PNG';
            btnPng.addEventListener('click', () => {
                vscode.postMessage({
                    type: 'stitchDownloadAsset',
                    url: screen.imageUrl,
                    filename: `${screen.id}.png`,
                    workspaceRoot: state.stitchWorkspaceRoot
                });
            });
            actions.appendChild(btnPng);

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
                        
                        // Restore project selection for this root
                        const rootState = getRestoredState('stitch.projectId', state.stitchWorkspaceRoot);
                        state.selectedStitchProjectId = rootState || '';
                        
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
                        const rootState = getRestoredState('stitch.projectId', state.stitchWorkspaceRoot);
                        state.selectedStitchProjectId = rootState || '';
                        
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

                const restoredDesignRoot = _restoredPanelState.panel['design.root'] || '';
                if (_workspaceItems.length === 0 || restoredDesignRoot === '' || _workspaceItems.some(i => i.workspaceRoot === restoredDesignRoot)) {
                    state.designWorkspaceRootFilter = restoredDesignRoot;
                } else {
                    state.designWorkspaceRootFilter = '';
                }
                const designSelect = document.getElementById('design-workspace-filter');
                if (designSelect) designSelect.value = state.designWorkspaceRootFilter;
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
                state._lastImagesDocsMsg = msg;
                state.htmlFolderPathsByRoot = msg.folderPathsByRoot || {};
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
                } else {
                    activeStatus = 'status-html';
                }
                const statusEl = document.getElementById(activeStatus);
                if (statusEl) {
                    statusEl.textContent = 'Preview error: ' + msg.error;
                    statusEl.style.color = '#ff6b6b';
                }
                break;

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
                    setStitchStatus('Project created — describe a screen and press Generate', 'success');
                    renderStitchScreens([]);
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
                const screens = msg.screens || [];
                renderStitchScreens(screens);
                setStitchStatus(`${screens.length} screen${screens.length === 1 ? '' : 's'} loaded`, 'success');
                if (screens.length > 0 && !state.activePreviewScreenId) {
                    openStitchPreview(screens[0]);
                }
                break;
            }

            case 'stitchScreenReady': {
                const updatedScreens = [...state.stitchScreens];
                const existingIdx = updatedScreens.findIndex(s => s.id === msg.screen.id);
                if (existingIdx >= 0) {
                    updatedScreens[existingIdx] = msg.screen;
                } else {
                    updatedScreens.unshift(msg.screen);
                }
                renderStitchScreens(updatedScreens);

                const hasImage = !!msg.screen.imageUrl;
                const isFailed = msg.screen.status === 'FAILED';

                if (hasImage) {
                    // Success — image loaded
                    clearStitchReloadTimer();
                    setStitchBusy(false);
                    setStitchStatus('Screen ready', 'success');
                } else if (isFailed) {
                    // Terminal failure
                    clearStitchReloadTimer();
                    setStitchBusy(false);
                    setStitchStatus(msg.screen.statusMessage || 'Rendering failed', 'error');
                } else if (state.stitchReloadPending) {
                    // Still in progress — schedule retry
                    const delay = Math.min(4 * Math.pow(2, state.stitchReloadRetries), 32); // 4, 8, 16, 32...
                    if (state.stitchReloadRetries < 6) {
                        state.stitchReloadRetries += 1;
                        setStitchStatus(`Still rendering… retry ${state.stitchReloadRetries}/6 in ${delay}s`, 'busy');
                        state.stitchReloadTimer = setTimeout(() => {
                            vscode.postMessage({
                                type: 'stitchRefreshScreen',
                                projectId: msg.screen.projectId || stitchProjectSelect.value,
                                screenId: msg.screen.id,
                                workspaceRoot: state.stitchWorkspaceRoot
                            });
                        }, delay * 1000);
                    } else {
                        // Max retries exhausted
                        clearStitchReloadTimer();
                        setStitchBusy(false);
                        setStitchStatus('Rendering is taking longer than expected. Click Reload Screen to try again.', 'error');
                    }
                } else {
                    // Not a reload context — just a normal update with no image yet
                    setStitchBusy(false);
                    setStitchStatus('Screen created — rendering in progress', 'info');
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
                clearStitchReloadTimer();
                setStitchBusy(false);
                setStitchStatus('Error: ' + msg.error, 'error');
                break;

            case 'themeChanged':
            case 'switchboardThemeChanged':
                // Mirrors planning.js handleThemeChanged: cyber CRT effects only for
                // afterburner/claudify; claudify additionally gets the palette override.
                if (msg.theme) { state.switchboardTheme = msg.theme; }
                document.body.classList.remove('theme-claudify');
                if (state.switchboardTheme === 'afterburner' || state.switchboardTheme === 'claudify') {
                    document.body.classList.add('cyber-theme-enabled');
                } else {
                    document.body.classList.remove('cyber-theme-enabled');
                }
                if (state.switchboardTheme === 'claudify') {
                    document.body.classList.add('theme-claudify');
                }
                break;

            case 'cyberAnimationSetting':
                document.body.classList.toggle('cyber-animation-disabled', msg.disabled);
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
            closeStitchPreview();
            
            // restore that root's persisted selectedStitchProjectId if it exists
            const rootState = getRestoredState('stitch.projectId', state.stitchWorkspaceRoot);
            if (rootState) {
                state.selectedStitchProjectId = rootState;
            }
            
            // re-request the project list for the new root
            vscode.postMessage({
                type: 'stitchListProjects',
                workspaceRoot: state.stitchWorkspaceRoot
            });
        }
    });

    // ===== FOLDER MANAGEMENT & PREVIEW HELPERS =====
    let folderModalScope = 'design'; // design, html, images, stitch

    function requestAllFolders(root) {
        if (!root) return;
        vscode.postMessage({ type: 'listDesignFolders', workspaceRoot: root });
        vscode.postMessage({ type: 'listHtmlFolders', workspaceRoot: root });
        vscode.postMessage({ type: 'listImagesFolders', workspaceRoot: root });
        vscode.postMessage({ type: 'listStitchFolders', workspaceRoot: root });
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
            else if (scope === 'images') modalTitle.textContent = 'Manage Images Folders';
            else if (scope === 'stitch') modalTitle.textContent = 'Manage Stitch Folders';
        }
        if (modal) {
            modal.style.display = 'flex';
            renderFolderListModal();
        }
    }

    function renderFolderListModal() {
        const folderListModal = document.getElementById('folder-list-modal');
        if (!folderListModal) return;
        folderListModal.innerHTML = '';

        let folderPaths = [];
        let root = '';
        if (folderModalScope === 'design') {
            root = state.designWorkspaceRootFilter || state.stitchWorkspaceRoot || '';
            folderPaths = state.designFolderPathsByRoot ? (state.designFolderPathsByRoot[root] || []) : [];
        } else if (folderModalScope === 'html') {
            root = state.htmlWorkspaceRootFilter || state.stitchWorkspaceRoot || '';
            folderPaths = state.htmlFolderPathsByRoot ? (state.htmlFolderPathsByRoot[root] || []) : [];
        } else if (folderModalScope === 'images') {
            root = state.imagesWorkspaceRootFilter || state.stitchWorkspaceRoot || '';
            folderPaths = state.imagesFolderPathsByRoot ? (state.imagesFolderPathsByRoot[root] || []) : [];
        } else if (folderModalScope === 'stitch') {
            root = state.stitchWorkspaceRoot || '';
            folderPaths = state.stitchFolderPathsByRoot ? (state.stitchFolderPathsByRoot[root] || []) : [];
        }

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
            removeBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                if (folderModalScope === 'design') {
                    vscode.postMessage({ type: 'removeDesignFolder', folderPath: path, workspaceRoot: root });
                } else if (folderModalScope === 'html') {
                    vscode.postMessage({ type: 'removeHtmlFolder', folderPath: path, workspaceRoot: root });
                } else if (folderModalScope === 'images') {
                    vscode.postMessage({ type: 'removeImagesFolder', folderPath: path, workspaceRoot: root });
                } else if (folderModalScope === 'stitch') {
                    vscode.postMessage({ type: 'removeStitchFolder', folderPath: path, workspaceRoot: root });
                }
            });

            row.appendChild(pathSpan);
            row.appendChild(removeBtn);
            folderListModal.appendChild(row);
        });
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
            }
            const menu = document.getElementById('stitch-variants-dropdown-menu');
            if (menu) {
                menu.style.display = 'none';
            }
        }
    });

    document.getElementById('btn-manage-folders-design')?.addEventListener('click', () => openFoldersModal('design'));
    document.getElementById('btn-manage-folders-html')?.addEventListener('click', () => openFoldersModal('html'));
    document.getElementById('btn-manage-folders-images')?.addEventListener('click', () => openFoldersModal('images'));
    document.getElementById('btn-manage-folders-stitch')?.addEventListener('click', () => openFoldersModal('stitch'));

    document.getElementById('btn-close-folder-modal')?.addEventListener('click', () => {
        const modal = document.getElementById('folder-modal');
        if (modal) modal.style.display = 'none';
    });

    document.getElementById('folder-modal')?.addEventListener('click', (e) => {
        if (e.target.id === 'folder-modal') {
            e.target.style.display = 'none';
        }
    });

    document.getElementById('btn-refresh-folders-modal')?.addEventListener('click', () => {
        let root = '';
        if (folderModalScope === 'design') {
            root = state.designWorkspaceRootFilter || state.stitchWorkspaceRoot || '';
            vscode.postMessage({ type: 'listDesignFolders', workspaceRoot: root });
        } else if (folderModalScope === 'html') {
            root = state.htmlWorkspaceRootFilter || state.stitchWorkspaceRoot || '';
            vscode.postMessage({ type: 'listHtmlFolders', workspaceRoot: root });
        } else if (folderModalScope === 'images') {
            root = state.imagesWorkspaceRootFilter || state.stitchWorkspaceRoot || '';
            vscode.postMessage({ type: 'listImagesFolders', workspaceRoot: root });
        } else if (folderModalScope === 'stitch') {
            root = state.stitchWorkspaceRoot || '';
            vscode.postMessage({ type: 'listStitchFolders', workspaceRoot: root });
        }
    });

    document.getElementById('btn-add-folder-modal')?.addEventListener('click', () => {
        let root = '';
        if (folderModalScope === 'design') {
            root = state.designWorkspaceRootFilter || state.stitchWorkspaceRoot || '';
            vscode.postMessage({ type: 'addDesignFolder', workspaceRoot: root });
        } else if (folderModalScope === 'html') {
            root = state.htmlWorkspaceRootFilter || state.stitchWorkspaceRoot || '';
            vscode.postMessage({ type: 'addHtmlFolder', workspaceRoot: root });
        } else if (folderModalScope === 'images') {
            root = state.imagesWorkspaceRootFilter || state.stitchWorkspaceRoot || '';
            vscode.postMessage({ type: 'addImagesFolder', workspaceRoot: root });
        } else if (folderModalScope === 'stitch') {
            root = state.stitchWorkspaceRoot || '';
            vscode.postMessage({ type: 'addStitchFolder', workspaceRoot: root });
        }
    });

    initStitchControls();

    function applySidebarState() {
        const designRow = document.getElementById('tree-pane-design')?.closest('.content-row');
        if (designRow) designRow.classList.toggle('collapsed', !!state.designPreviewCollapsed);
        const htmlRow = document.getElementById('tree-pane-html')?.closest('.content-row');
        if (htmlRow) htmlRow.classList.toggle('collapsed', !!state.htmlPreviewCollapsed);
    }

    // Notify backend ready
    vscode.postMessage({ type: 'ready' });

    // Stitch is the default tab, so the project list must load up front —
    // switchTab() only fires on a click, which never happens for the initial tab.
    vscode.postMessage({
        type: 'stitchListProjects',
        workspaceRoot: state.stitchWorkspaceRoot
    });

    applySidebarState();
    updateDesignDocControls();
})();
