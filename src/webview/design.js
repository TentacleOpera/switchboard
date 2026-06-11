(function() {
    const vscode = acquireVsCodeApi();

    // Restore persisted state
    const persistedState = vscode.getState() || {};

    const state = {
        activeSource: null,
        activeDocId: null,
        activeDocName: null,
        activeDocContent: null,
        activeDocFilePath: null,
        activeFileType: null,
        selectedEl: null,
        previewRequestId: 0,
        htmlFolderPathsByRoot: persistedState.htmlFolderPathsByRoot || {},
        designFolderPathsByRoot: persistedState.designFolderPathsByRoot || {},
        htmlPreviewCollapsed: persistedState.htmlPreviewCollapsed || false,
        designPreviewCollapsed: persistedState.designPreviewCollapsed || false,
        htmlWorkspaceRootFilter: '',
        designWorkspaceRootFilter: '',
        htmlDocsSearch: '',
        designDocsSearch: '',
        _lastHtmlDocsMsg: null,
        _lastDesignDocsMsg: null,
        stitchProjects: [],
        selectedStitchProjectId: '',
        stitchScreens: [],
        stitchApiKeyConfigured: false
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
            vscode.postMessage({ type: 'stitchListProjects' });
        }
    }

    tabBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            switchTab(btn.dataset.tab);
        });
    });

    // ── Zoom/Pan Engine ──
    const zoomState = {
        html:     { scale: 1, panX: 0, panY: 0, isPanning: false, startX: 0, startY: 0 },
        design:   { scale: 1, panX: 0, panY: 0, isPanning: false, startX: 0, startY: 0 },
    };

    const ZOOM_MIN = 0.1;
    const ZOOM_MAX = 10.0;
    const ZOOM_STEP = 0.1;

    function resetZoom(tab) {
        zoomState[tab] = { scale: 1, panX: 0, panY: 0, isPanning: false, startX: 0, startY: 0 };
    }

    function applyZoom(tab, viewportEl) {
        if (!viewportEl) return;
        viewportEl.style.transform = `translate(${zoomState[tab].panX}px, ${zoomState[tab].panY}px) scale(${zoomState[tab].scale})`;
    }

    function clampPan(tab, containerRect, contentWidth, contentHeight) {
        const s = zoomState[tab].scale;
        const minX = Math.min(0, containerRect.width - contentWidth * s);
        const minY = Math.min(0, containerRect.height - contentHeight * s);
        const maxX = Math.max(0, containerRect.width - contentWidth * s);
        const maxY = Math.max(0, containerRect.height - contentHeight * s);
        zoomState[tab].panX = Math.max(minX, Math.min(maxX, zoomState[tab].panX));
        zoomState[tab].panY = Math.max(minY, Math.min(maxY, zoomState[tab].panY));
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
        const containerRect = container.getBoundingClientRect();
        const contentEl = viewportEl ? viewportEl.firstElementChild : null;
        if (contentEl) {
            const w = contentEl.tagName === 'IMG' ? (contentEl.naturalWidth || contentEl.offsetWidth) : contentEl.offsetWidth;
            const h = contentEl.tagName === 'IMG' ? (contentEl.naturalHeight || contentEl.offsetHeight) : contentEl.offsetHeight;
            if (w && h) clampPan(tab, containerRect, w, h);
        }
        applyZoom(tab, viewportEl);
    }

    function initZoomListeners(containerId, viewportSelector, tab) {
        const container = document.getElementById(containerId);
        if (!container) return;

        container.addEventListener('wheel', (e) => {
            if (!e.metaKey && !e.ctrlKey) return;
            e.preventDefault();

            const delta = e.deltaY > 0 ? -ZOOM_STEP : ZOOM_STEP;
            const rect = container.getBoundingClientRect();
            zoomAt(tab, container, container.querySelector(viewportSelector),
                zoomState[tab].scale + delta,
                e.clientX - rect.left, e.clientY - rect.top);
        }, { passive: false });

        container.addEventListener('mousedown', (e) => {
            if (e.button !== 0 || e.target.closest('.zoom-toolbar')) return;
            zoomState[tab].isPanning = true;
            zoomState[tab].startX = e.clientX - zoomState[tab].panX;
            zoomState[tab].startY = e.clientY - zoomState[tab].panY;
            container.classList.add('panning');
        });

        window.addEventListener('mousemove', (e) => {
            if (!zoomState[tab].isPanning) return;
            zoomState[tab].panX = e.clientX - zoomState[tab].startX;
            zoomState[tab].panY = e.clientY - zoomState[tab].startY;

            const containerRect = container.getBoundingClientRect();
            const viewportEl = container.querySelector(viewportSelector);
            const contentEl = viewportEl ? viewportEl.firstElementChild : null;
            if (contentEl) {
                const cw = contentEl.tagName === 'IMG' ? (contentEl.naturalWidth || contentEl.offsetWidth) : contentEl.offsetWidth;
                const ch = contentEl.tagName === 'IMG' ? (contentEl.naturalHeight || contentEl.offsetHeight) : contentEl.offsetHeight;
                clampPan(tab, containerRect, cw, ch);
            }
            applyZoom(tab, viewportEl);
        });

        window.addEventListener('mouseup', () => {
            if (!zoomState[tab].isPanning) return;
            zoomState[tab].isPanning = false;
            container.classList.remove('panning');
        });

        container.addEventListener('click', (e) => {
            const btn = e.target.closest('.zoom-btn');
            if (!btn) return;
            const action = btn.dataset.action;
            const viewportEl = container.querySelector(viewportSelector);
            const rect = container.getBoundingClientRect();
            if (action === 'zoom-in') {
                zoomAt(tab, container, viewportEl, zoomState[tab].scale + ZOOM_STEP * 2, rect.width / 2, rect.height / 2);
            } else if (action === 'zoom-out') {
                zoomAt(tab, container, viewportEl, zoomState[tab].scale - ZOOM_STEP * 2, rect.width / 2, rect.height / 2);
            } else if (action === 'reset') {
                resetZoom(tab);
                applyZoom(tab, viewportEl);
            } else if (action === 'fit') {
                fitToContainer(tab, container, viewportEl);
            }
        });
    }

    // Initialize Zoom for Previews
    initZoomListeners('html-preview-wrapper', '.zoomable-viewport', 'html');
    initZoomListeners('image-preview-container', '.zoomable-viewport', 'html');
    initZoomListeners('image-preview-container-design', '.zoomable-viewport', 'design');

    // Sidebar Collapsing
    function toggleSidebarCollapsed(e) {
        const btn = e.target;
        const pane = btn.closest('#tree-pane-design') || btn.closest('#tree-pane-html');
        if (!pane) return;
        const row = pane.closest('.content-row');
        if (!row) return;

        const isCollapsed = row.classList.toggle('collapsed');
        btn.textContent = isCollapsed ? '»' : '«';

        if (pane.id === 'tree-pane-design') {
            state.designPreviewCollapsed = isCollapsed;
        } else {
            state.htmlPreviewCollapsed = isCollapsed;
        }
        vscode.setState({
            ...vscode.getState(),
            designPreviewCollapsed: state.designPreviewCollapsed,
            htmlPreviewCollapsed: state.htmlPreviewCollapsed
        });
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

    function renderJsonTree(data, depth = 0, maxDepth = 2, seen = new WeakSet()) {
        if (data === null) {
            const span = document.createElement('span');
            span.className = 'json-null';
            span.textContent = 'null';
            return span;
        }
        if (typeof data !== 'object') {
            const span = document.createElement('span');
            span.className = 'json-' + typeof data;
            span.textContent = typeof data === 'string' ? '"' + data + '"' : String(data);
            return span;
        }
        if (seen.has(data)) {
            const span = document.createElement('span');
            span.className = 'json-null';
            span.textContent = '[Circular]';
            return span;
        }
        seen.add(data);

        const isArray = Array.isArray(data);
        const isOpen = depth < maxDepth;

        const details = document.createElement('details');
        details.className = 'json-node';
        if (isOpen) details.open = true;

        const summary = document.createElement('summary');
        summary.summary = 'json-bracket';
        const countLabel = isArray ? `${data.length} items` : `${Object.keys(data).length} keys`;
        summary.textContent = isArray ? `[ ${countLabel} ]` : `{ ${countLabel} }`;
        details.appendChild(summary);

        const children = document.createElement('div');
        children.className = 'json-children';

        if (isArray) {
            data.forEach((item, i) => {
                const row = document.createElement('div');
                row.className = 'json-row';
                const idx = document.createElement('span');
                idx.className = 'json-number';
                idx.textContent = String(i) + ':';
                row.appendChild(idx);
                row.appendChild(renderJsonTree(item, depth + 1, maxDepth, seen));
                children.appendChild(row);
            });
        } else {
            for (const [key, val] of Object.entries(data)) {
                const row = document.createElement('div');
                row.className = 'json-row';
                const keySpan = document.createElement('span');
                keySpan.className = 'json-key';
                keySpan.textContent = '"' + key + '"';
                row.appendChild(keySpan);
                row.appendChild(document.createTextNode(': '));
                row.appendChild(renderJsonTree(val, depth + 1, maxDepth, seen));
                children.appendChild(row);
            }
        }
        details.appendChild(children);
        return details;
    }

    function populateWorkspaceDropdown(selectElementId, workspaceItems, selectedValue) {
        const select = document.getElementById(selectElementId);
        if (!select) return;
        const current = selectedValue || '';
        select.innerHTML = '<option value="">All Workspaces</option>';
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
        const search = String(state.htmlDocsSearch || '').trim().toLowerCase();
        if (search) {
            docNodes = docNodes.filter(d => (d.title || d.name || '').toLowerCase().includes(search));
        }

        const groups = groupDocsByType(docNodes);
        TYPE_ORDER.forEach(type => {
            const typeDocs = groups[type] || [];
            if (typeDocs.length === 0) return;

            const typeSubheader = document.createElement('div');
            typeSubheader.className = 'type-subheader';
            typeSubheader.textContent = TYPE_LABELS[type];
            docList.appendChild(typeSubheader);

            typeDocs.forEach(doc => {
                const isHtmlFile = type === 'html';
                const actions = isHtmlFile ? ['Serve & Open', 'Link Doc'] : ['Link Doc'];
                const card = renderDocCard({
                    title: doc.name || doc.id,
                    subtitle: TYPE_LABELS[type],
                    sourceId,
                    nodeId: doc.id,
                    nodeMetadata: doc.metadata,
                    actions,
                    isSelected: state.activeSource === sourceId && state.activeDocId === doc.id,
                    clickHandler: () => {
                        loadDocumentPreview(sourceId, doc.id, doc.name);
                    }
                });
                docList.appendChild(card);
            });
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
                        vscode.postMessage({
                            type: 'appendToPlannerPrompt',
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
        } else if (sourceId === 'design-folder') {
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
                    iframe.srcdoc = htmlContent;
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
        } else if (sourceId === 'design-folder') {
            if (requestId !== undefined && requestId !== -1 && requestId !== state.previewRequestId) return;
            resetZoom('design');

            state.activeDocFilePath = filePath || null;
            state.activeFileType = msg.fileType || null;

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
                    mdPrev.innerHTML = content || '';
                }
                if (designWrapper) designWrapper.classList.remove('scanlines-suppressed');
            }

            if (statusDesign) {
                statusDesign.textContent = isAutoRefreshed ? 'Auto-refreshed' : 'Loaded';
                statusDesign.style.color = 'var(--accent-teal)';
            }
        }
    }

    // ── Stitch UI Controls ──
    const stitchProjectSelect = document.getElementById('stitch-project-select');
    const btnSyncStitchProject = document.getElementById('btn-sync-stitch-project');
    const stitchPromptInput = document.getElementById('stitch-prompt-input');
    const stitchDeviceSelect = document.getElementById('stitch-device-select');
    const btnGenerateStitch = document.getElementById('btn-generate-stitch');
    const stitchGallery = document.getElementById('stitch-gallery');
    const stitchGalleryEmpty = document.getElementById('stitch-gallery-empty');
    const stitchApiBanner = document.getElementById('stitch-api-banner');
    const stitchApiKeyInput = document.getElementById('stitch-api-key-input');
    const btnSaveStitchApiKey = document.getElementById('btn-save-stitch-api-key');
    const statusStitch = document.getElementById('status-stitch');

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
            if (!prompt) return;

            statusStitch.textContent = 'Generating screen...';
            btnGenerateStitch.disabled = true;

            vscode.postMessage({
                type: 'stitchGenerate',
                prompt,
                deviceType,
                projectId: projectId || undefined
            });
        });
    }

    if (btnSyncStitchProject) {
        btnSyncStitchProject.addEventListener('click', () => {
            const projectId = stitchProjectSelect.value;
            if (!projectId) return;
            statusStitch.textContent = 'Syncing project to workspace...';
            btnSyncStitchProject.disabled = true;
            vscode.postMessage({
                type: 'stitchSyncProject',
                projectId
            });
        });
    }

    if (stitchProjectSelect) {
        stitchProjectSelect.addEventListener('change', () => {
            const projectId = stitchProjectSelect.value;
            btnSyncStitchProject.disabled = !projectId;
            if (projectId) {
                statusStitch.textContent = 'Loading project screens...';
                vscode.postMessage({ type: 'stitchGetProjectScreens', projectId });
            } else {
                renderStitchScreens([]);
            }
        });
    }

    function populateStitchProjects(projects) {
        if (!stitchProjectSelect) return;
        const current = stitchProjectSelect.value;
        stitchProjectSelect.innerHTML = '<option value="">Select Project...</option>';
        projects.forEach(p => {
            const opt = document.createElement('option');
            opt.value = p.id;
            opt.textContent = p.name || p.id;
            if (p.id === current) opt.selected = true;
            stitchProjectSelect.appendChild(opt);
        });
    }

    function renderStitchScreens(screens) {
        state.stitchScreens = screens;
        if (!stitchGallery || !stitchGalleryEmpty) return;

        if (screens.length === 0) {
            stitchGallery.style.display = 'none';
            stitchGalleryEmpty.style.display = 'flex';
            return;
        }

        stitchGalleryEmpty.style.display = 'none';
        stitchGallery.style.display = 'grid';
        stitchGallery.innerHTML = '';

        screens.forEach(screen => {
            const card = document.createElement('div');
            card.className = 'stitch-screen-card';
            card.dataset.screenId = screen.id;

            const img = document.createElement('img');
            img.className = 'stitch-screen-thumbnail';
            img.src = screen.imageUrl || '';
            img.alt = screen.name || screen.id;
            card.appendChild(img);

            const info = document.createElement('div');
            info.className = 'stitch-screen-info';

            const title = document.createElement('div');
            title.className = 'stitch-screen-title';
            title.textContent = screen.name || 'Untitled Screen';
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
                    filename: `${screen.id}.html`
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
                    filename: `${screen.id}.png`
                });
            });
            actions.appendChild(btnPng);

            card.appendChild(actions);

            // Refinement panel
            const refinePanel = document.createElement('div');
            refinePanel.className = 'stitch-refine-panel';

            const input = document.createElement('input');
            input.type = 'text';
            input.className = 'stitch-input';
            input.placeholder = 'Refinement prompt...';
            refinePanel.appendChild(input);

            const refineActions = document.createElement('div');
            refineActions.style.display = 'flex';
            refineActions.style.gap = '6px';

            const btnEdit = document.createElement('button');
            btnEdit.className = 'strip-btn stitch-btn-primary';
            btnEdit.style.flex = '1';
            btnEdit.textContent = 'Edit';
            btnEdit.addEventListener('click', () => {
                const prompt = input.value.trim();
                if (!prompt) return;
                statusStitch.textContent = 'Editing screen...';
                vscode.postMessage({
                    type: 'stitchEdit',
                    screenId: screen.id,
                    prompt
                });
            });
            refineActions.appendChild(btnEdit);

            const btnVariants = document.createElement('button');
            btnVariants.className = 'strip-btn';
            btnVariants.style.flex = '1';
            btnVariants.textContent = 'Variants';
            btnVariants.addEventListener('click', () => {
                const prompt = input.value.trim();
                statusStitch.textContent = 'Generating variants...';
                vscode.postMessage({
                    type: 'stitchVariants',
                    screenId: screen.id,
                    prompt: prompt || undefined,
                    count: 3
                });
            });
            refineActions.appendChild(btnVariants);

            refinePanel.appendChild(refineActions);
            card.appendChild(refinePanel);

            stitchGallery.appendChild(card);
        });
    }

    // Workspace change listeners
    document.getElementById('html-workspace-filter')?.addEventListener('change', (e) => {
        state.htmlWorkspaceRootFilter = e.target.value;
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

    document.getElementById('design-workspace-filter')?.addEventListener('change', (e) => {
        state.designWorkspaceRootFilter = e.target.value;
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

    // Message event listener
    window.addEventListener('message', (event) => {
        const msg = event.data;
        console.log('[DesignPanel Webview] Received message:', msg.type, msg);

        switch (msg.type) {
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

            case 'previewReady':
                handlePreviewReady(msg);
                break;

            case 'previewError':
                console.error('[DesignPanel Webview] Preview error:', msg.error);
                const activeStatus = msg.sourceId === 'design-folder' ? 'status-design' : 'status-html';
                const statusEl = document.getElementById(activeStatus);
                if (statusEl) {
                    statusEl.textContent = 'Preview error: ' + msg.error;
                    statusEl.style.color = '#ff6b6b';
                }
                break;

            case 'stitchApiKeyStatus':
                state.stitchApiKeyConfigured = msg.configured;
                if (stitchApiBanner) {
                    stitchApiBanner.style.display = msg.configured ? 'none' : 'flex';
                }
                break;

            case 'stitchProjectsReady':
                state.stitchProjects = msg.projects || [];
                populateStitchProjects(state.stitchProjects);
                if (statusStitch) statusStitch.textContent = '';
                break;

            case 'stitchScreensReady':
                if (btnGenerateStitch) btnGenerateStitch.disabled = false;
                if (btnSyncStitchProject) btnSyncStitchProject.disabled = !stitchProjectSelect.value;
                renderStitchScreens(msg.screens || []);
                if (statusStitch) statusStitch.textContent = 'Screens loaded';
                break;

            case 'stitchScreenReady':
                if (btnGenerateStitch) btnGenerateStitch.disabled = false;
                if (btnSyncStitchProject) btnSyncStitchProject.disabled = !stitchProjectSelect.value;
                if (statusStitch) statusStitch.textContent = 'Screen ready';
                const updatedScreens = [...state.stitchScreens];
                const existingIdx = updatedScreens.findIndex(s => s.id === msg.screen.id);
                if (existingIdx >= 0) {
                    updatedScreens[existingIdx] = msg.screen;
                } else {
                    updatedScreens.unshift(msg.screen);
                }
                renderStitchScreens(updatedScreens);
                break;

            case 'stitchSyncComplete':
                if (btnSyncStitchProject) btnSyncStitchProject.disabled = false;
                if (statusStitch) {
                    statusStitch.textContent = 'Sync complete!';
                    statusStitch.style.color = 'var(--accent-teal)';
                    setTimeout(() => {
                        statusStitch.textContent = '';
                        statusStitch.style.color = '';
                    }, 3000);
                }
                break;

            case 'stitchError':
                if (btnGenerateStitch) btnGenerateStitch.disabled = false;
                if (btnSyncStitchProject) btnSyncStitchProject.disabled = !stitchProjectSelect.value;
                if (statusStitch) {
                    statusStitch.textContent = 'Error: ' + msg.error;
                    statusStitch.style.color = '#ff6b6b';
                }
                break;

            case 'themeChanged':
            case 'switchboardThemeChanged':
                if (msg.theme) {
                    document.body.className = msg.theme.includes('claudify') ? 'theme-claudify' : 'cyber-theme-enabled';
                }
                break;

            case 'cyberAnimationSetting':
                document.body.classList.toggle('cyber-animation-disabled', msg.disabled);
                break;
        }
    });

    // Notify backend ready
    vscode.postMessage({ type: 'ready' });

    applySidebarState();
})();
