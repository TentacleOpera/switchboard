(function() {
    const vscode = acquireVsCodeApi();

    // Tab management
    const tabButtons = document.querySelectorAll('.research-tab-btn');
    const tabContents = document.querySelectorAll('.research-tab-content');

    tabButtons.forEach(btn => {
        btn.addEventListener('click', () => {
            const tabName = btn.dataset.tab;

            tabButtons.forEach(b => b.classList.remove('active'));
            tabContents.forEach(c => c.classList.remove('active'));

            btn.classList.add('active');
            document.getElementById(`${tabName}-content`).classList.add('active');
        });
    });

    // Clipboard Import logic
    const separatorPreset = document.getElementById('airlock-separator-preset');
    const separatorCustomRow = document.getElementById('airlock-separator-custom-row');
    const separatorInput = document.getElementById('airlock-separator-input');
    const separatorPreview = document.getElementById('airlock-separator-preview');
    const separatorError = document.getElementById('airlock-separator-error');
    const copyAgentPromptBtn = document.getElementById('btn-copy-agent-prompt');
    const importPlansBtn = document.getElementById('btn-import-plans');

    function updateSeparatorPreview(pattern) {
        if (!pattern) {
            if (separatorPreview) separatorPreview.textContent = '';
            return;
        }
        const ex1 = pattern.replace(/\[N\]/g, '1');
        const ex2 = pattern.replace(/\[N\]/g, '2');
        const ex3 = pattern.replace(/\[N\]/g, '3');
        separatorPreview.textContent = `Example format:\n${ex1}\n[Plan 1 content]\n\n${ex2}\n[Plan 2 content]\n\n${ex3}\n[Plan 3 content]`;
    }

    if (separatorPreset) {
        separatorPreset.addEventListener('change', () => {
            const key = separatorPreset.value;
            if (separatorCustomRow) separatorCustomRow.style.display = key === 'custom' ? 'block' : 'none';
            if (separatorError) separatorError.textContent = '';
            vscode.postMessage({ type: 'setClipboardSeparatorPreset', preset: key });
            const opt = separatorPreset.options[separatorPreset.selectedIndex];
            if (key !== 'custom' && opt.dataset.pattern) {
                updateSeparatorPreview(opt.dataset.pattern);
            }
        });
    }

    if (separatorInput) {
        separatorInput.addEventListener('change', () => {
            if (separatorError) separatorError.textContent = '';
            vscode.postMessage({ type: 'setClipboardSeparatorPattern', pattern: separatorInput.value });
        });
    }

    if (copyAgentPromptBtn) {
        copyAgentPromptBtn.addEventListener('click', () => {
            const currentPattern = separatorPreset?.value === 'custom'
                ? separatorInput?.value || '### PLAN [N] START'
                : (separatorPreset?.options[separatorPreset.selectedIndex]?.dataset?.pattern || '### PLAN [N] START');
            const ex1 = currentPattern.replace(/\[N\]/g, '1');
            const ex2 = currentPattern.replace(/\[N\]/g, '2');
            const prompt = `Please output all features/plans as a single markdown block with each plan separated by this exact format:\n\n${ex1}\n[plan 1 content here]\n\n${ex2}\n[plan 2 content here]\n\n[etc...]\n\nEach plan should have its own H1 title (# Plan Title) and full content. I will copy the entire block and import it into my planning system which will automatically split it into separate plan files.`;
            navigator.clipboard.writeText(prompt).then(() => {
                copyAgentPromptBtn.innerText = 'COPIED';
                setTimeout(() => { copyAgentPromptBtn.innerText = 'COPY AGENT PROMPT'; }, 2000);
            });
        });
    }

    if (importPlansBtn) {
        importPlansBtn.addEventListener('click', () => {
            vscode.postMessage({ type: 'importPlansFromClipboard' });
        });
    }

    // NotebookLM button handlers
    const bundleCodeBtn = document.getElementById('btn-bundle-code');
    const openNotebookLMBtn = document.getElementById('btn-open-notebooklm');
    const openAirlockFolderBtn = document.getElementById('btn-open-airlock-folder');
    const copySprintPromptBtn = document.getElementById('btn-copy-sprint-prompt');

    if (bundleCodeBtn) {
        bundleCodeBtn.addEventListener('click', () => {
            bundleCodeBtn.disabled = true;
            bundleCodeBtn.textContent = 'BUNDLING...';
            vscode.postMessage({ type: 'airlock_export' });
        });
    }

    if (openNotebookLMBtn) {
        openNotebookLMBtn.addEventListener('click', () => {
            vscode.postMessage({ type: 'airlock_openNotebookLM' });
        });
    }

    if (openAirlockFolderBtn) {
        openAirlockFolderBtn.addEventListener('click', () => {
            vscode.postMessage({ type: 'airlock_openFolder' });
        });
    }

    if (copySprintPromptBtn) {
        copySprintPromptBtn.addEventListener('click', () => {
            const currentPattern = separatorPreset?.value === 'custom'
                ? separatorInput?.value || '### PLAN [N] START'
                : (separatorPreset?.options[separatorPreset.selectedIndex]?.dataset?.pattern || '### PLAN [N] START');
            const ex1 = currentPattern.replace(/\[N\]/g, '1');
            const ex2 = currentPattern.replace(/\[N\]/g, '2');
            const prompt = `Please analyze the uploaded codebase and generate sprint plans. Output each plan separated by this exact format:\n\n${ex1}\n[plan 1 content here]\n\n${ex2}\n[plan 2 content here]\n\n[etc...]\n\nEach plan should have its own H1 title (# Plan Title) and full content. I will copy the entire block and import it into my planning system which will automatically split it into separate plan files.`;
            navigator.clipboard.writeText(prompt).then(() => {
                copySprintPromptBtn.innerText = 'COPIED';
                setTimeout(() => { copySprintPromptBtn.innerText = 'COPY SPRINT PROMPT'; }, 2000);
            });
        });
    }

    // Request initial separator state
    vscode.postMessage({ type: 'getClipboardSeparatorPattern' });

    const SOURCE_DISPLAY_NAMES = {
        'clickup': 'ClickUp',
        'linear': 'Linear',
        'notion': 'Notion',
        'local-folder': 'Cowork/local'
    };

    const state = {
        activeSource: null,
        activeDocId: null,
        activeDocName: null,
        activeDocContent: null,
        activeContainers: new Map(),
        importedDocs: new Map(), // slugPrefix -> { sourceId, docId, docName }
        previewRequestId: 0,
        docPagesRequestId: 0,
        selectedEl: null,
        filterRequestIds: {}
    };

    const treePane = document.getElementById('tree-pane');
    const treePaneOnline = document.getElementById('tree-pane-online');
    const markdownPreview = document.getElementById('markdown-preview');
    const markdownPreviewOnline = document.getElementById('markdown-preview-online');
    const btnAppendToPrompts = document.getElementById('btn-append-to-prompts');
    const btnAppendToPromptsOnline = document.getElementById('btn-append-to-prompts-online');
    const btnImportAndCopyLink = document.getElementById('btn-import-and-copy-link');
    const btnImportAndCopyLinkOnline = document.getElementById('btn-import-and-copy-link-online');
    const btnExportToSource = document.getElementById('btn-export-to-source');
    const statusEl = document.getElementById('status');
    const statusElOnline = document.getElementById('status-online');

    // Bulletproof Node Finder (eliminates querySelector CSS string escaping bugs completely)
    function findTreeNode(sourceId, nodeId) {
        const nodes = document.querySelectorAll('.tree-node');
        for (let i = 0; i < nodes.length; i++) {
            if (nodes[i].dataset.sourceId === String(sourceId) && nodes[i].dataset.nodeId === String(nodeId)) {
                return nodes[i];
            }
        }
        return null;
    }

    // Attribute-escape for values that land inside href="..." attributes.
    function escapeAttr(s) {
        return String(s).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    // Allowlist safe URL schemes and block dangerous ones
    function sanitizeUrl(rawUrl) {
        const trimmed = String(rawUrl).trim();
        if (/^(#|\/|\.{1,2}\/)/.test(trimmed)) { return trimmed; }
        const schemeMatch = trimmed.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):/);
        if (schemeMatch) {
            const scheme = schemeMatch[1].toLowerCase();
            if (scheme === 'http' || scheme === 'https' || scheme === 'mailto' || scheme === 'tel') {
                return trimmed;
            }
            return '#';
        }
        return trimmed;
    }

    // Simple markdown renderer with header deduplication
    function renderMarkdown(markdown) {
        if (!markdown) return '';

        // Escape HTML first
        let processed = markdown
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');

        // Process line by line to deduplicate consecutive headers
        const lines = processed.split('\n');
        const resultLines = [];
        let lastHeaderText = null;

        for (const line of lines) {
            const headerMatch = line.match(/^(#{1,6})\s+(.+)$/);
            if (headerMatch) {
                const headerText = headerMatch[2].trim();
                // Skip if this header has the same text as the previous one
                if (headerText === lastHeaderText) {
                    continue;
                }
                lastHeaderText = headerText;
            }
            resultLines.push(line);
        }

        processed = resultLines.join('\n');

        // Now apply markdown transformations
        let html = processed
            .replace(/```(\w*)([\s\S]*?)```/g, '<pre><code>$2</code></pre>')
            .replace(/^\s*###### (.+)$/gm, '<h6>$1</h6>')
            .replace(/^\s*##### (.+)$/gm, '<h5>$1</h5>')
            .replace(/^\s*#### (.+)$/gm, '<h4>$1</h4>')
            .replace(/^\s*### (.+)$/gm, '<h3>$1</h3>')
            .replace(/^\s*## (.+)$/gm, '<h2>$1</h2>')
            .replace(/^\s*# (.+)$/gm, '<h1>$1</h1>')
            .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
            .replace(/\*(.+?)\*/g, '<em>$1</em>')
            .replace(/`([^`]+)`/g, '<code>$1</code>')
            .replace(/^> (.+)$/gm, '<blockquote>$1</blockquote>')
            .replace(/^\* (.+)$/gm, '<li>$1</li>')
            .replace(/(<li>.*<\/li>\n?)+/g, '<ul>$&</ul>')
            .replace(/^\d+\. (.+)$/gm, '<li>$1</li>')
            .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, text, url) => {
                const safeUrl = escapeAttr(sanitizeUrl(url));
                return `<a href="${safeUrl}">${text}</a>`;
            })
            .replace(/\\([\\`*_{}[\]()#+\-.!|])/g, '$1')
            .replace(/\n\n/g, '</p><p>')
            .replace(/\n/g, '<br>');

        return `<p>${html}</p>`;
    }

    function renderNode(node, sourceId, depth = 0) {
        const wrapper = document.createElement('div');
        wrapper.className = 'tree-node';
        wrapper.dataset.sourceId = sourceId;
        wrapper.dataset.nodeId = node.id;
        wrapper.dataset.kind = node.kind || '';
        wrapper.dataset.name = node.name;
        wrapper.style.marginLeft = `${depth * 16}px`;

        const icon = document.createElement('span');
        icon.className = 'icon';
        icon.textContent = (node.kind === 'folder' || node.isDirectory) ? '📁' : '📄';

        const label = document.createElement('span');
        label.className = 'label';
        label.textContent = node.name;

        const childContainer = document.createElement('div');
        childContainer.className = 'tree-children';
        childContainer.style.display = 'none';

        if (node.kind === 'folder' || node.isDirectory) {
            if (node.hasChildren) {
                wrapper.addEventListener('click', () => {
                    const isExpanded = childContainer.style.display !== 'none';
                    icon.textContent = isExpanded ? '📁' : '📂';
                    childContainer.style.display = isExpanded ? 'none' : 'block';

                    if (!isExpanded && !childContainer.dataset.loaded) {
                        childContainer.dataset.loaded = 'true';
                        childContainer.innerHTML = '<div class="tree-placeholder">Loading...</div>';
                        vscode.postMessage({
                            type: 'fetchChildren',
                            sourceId,
                            parentId: node.id
                        });
                    }
                });
            }
        } else {
            // Documents & Pages - no tree view, subpages shown in preview as flat TOC
            wrapper.addEventListener('click', () => {
                loadDocumentPreview(sourceId, node.id, node.name);
            });
        }

        wrapper.appendChild(icon);
        wrapper.appendChild(label);
        wrapper.appendChild(childContainer);

        return { wrapper, childContainer };
    }

    function loadDocumentPreview(sourceId, docId, docName) {
        if (state.selectedEl) {
            state.selectedEl.classList.remove('selected');
        }

        // 100% safe DOM traversal fallback - no querySelector escaping issues
        const wrapper = findTreeNode(sourceId, docId);
        
        if (wrapper) {
            wrapper.classList.add('selected');
            state.selectedEl = wrapper;
        }

        state.activeSource = sourceId;
        state.activeDocId = docId;
        state.activeDocName = docName;
        state.previewRequestId++;

        btnAppendToPrompts.disabled = true;
        btnImportAndCopyLink.disabled = true;
        
        if (sourceId === 'local-folder' && btnExportToSource) {
            const importedInfo = state.importedDocs.get(docName);
            if (importedInfo && importedInfo.canSync) {
                const sourceDisplay = SOURCE_DISPLAY_NAMES[importedInfo.sourceId] || importedInfo.sourceId;
                btnExportToSource.textContent = `Export to ${sourceDisplay}`;
                btnExportToSource.style.display = '';
                btnExportToSource.disabled = false;
                btnExportToSource.dataset.slugPrefix = importedInfo.slugPrefix;
            } else {
                btnExportToSource.style.display = 'none';
                btnExportToSource.disabled = true;
            }
        } else if (btnExportToSource) {
            btnExportToSource.style.display = 'none';
            btnExportToSource.disabled = true;
        }
        
        statusEl.textContent = 'Loading...';
        markdownPreview.innerHTML = '<div class="empty-state">Loading preview...</div>';

        if (String(docId).startsWith('page:')) {
            const match = String(docId).match(/^page:([^:]+):(.+)$/);
            if (match) {
                vscode.postMessage({
                    type: 'fetchPageContent',
                    sourceId,
                    docId: match[1],
                    pageId: match[2],
                    requestId: state.previewRequestId
                });
            } else {
                vscode.postMessage({
                    type: 'fetchPreview',
                    sourceId,
                    docId: docId,
                    requestId: state.previewRequestId
                });
            }
        } else {
            vscode.postMessage({
                type: 'fetchPreview',
                sourceId,
                docId: docId,
                requestId: state.previewRequestId
            });
        }
        
        // Fetch subpages for this document to display as TOC in preview
        state.docPagesRequestId++;
        vscode.postMessage({
            type: 'fetchDocPages',
            sourceId,
            docId,
            requestId: state.docPagesRequestId
        });
    }

    const LOCAL_SOURCES = ['local-folder'];
    const ONLINE_SOURCES = ['clickup', 'linear', 'notion'];

    function renderLocalDocs(rootEntry) {
        const { sourceId, nodes, folderPath } = rootEntry;
        
        // Clear only local pane
        treePane.innerHTML = '';
        
        if (sourceId === 'local-folder') {
            const configRow = document.createElement('div');
            configRow.className = 'folder-config';
            const pathInput = document.createElement('input');
            pathInput.type = 'text';
            pathInput.readOnly = true;
            pathInput.placeholder = 'No folder set';
            pathInput.id = 'local-folder-path';
            
            // Add a manual refresh button for the local folder
            const refreshLocalBtn = document.createElement('button');
            refreshLocalBtn.textContent = '↻';
            refreshLocalBtn.title = 'Refresh Local Folder';
            refreshLocalBtn.style.padding = '2px 6px';
            refreshLocalBtn.addEventListener('click', () => {
                vscode.postMessage({ type: 'refreshSource', sourceId: 'local-folder' });
            });

            const browseBtn = document.createElement('button');
            browseBtn.textContent = 'Browse';
            browseBtn.addEventListener('click', () => {
                vscode.postMessage({ type: 'browseLocalFolder' });
            });
            
            configRow.appendChild(pathInput);
            configRow.appendChild(refreshLocalBtn);
            configRow.appendChild(browseBtn);
            treePane.appendChild(configRow);

            // ALWAYS create docList container so handleLocalFolderPathUpdated can find it later
            const docList = document.createElement('div');
            docList.className = 'source-doc-list';
            docList.dataset.sourceId = sourceId;
            treePane.appendChild(docList);

            // Set path input value from folderPath attached by backend
            if (folderPath) {
                pathInput.value = folderPath;
            }

            if (!nodes || nodes.length === 0) {
                docList.innerHTML = '<div class="empty-state" style="padding: 12px; font-size: 12px; color: var(--text-secondary);">Folder not configured or empty. Click Browse to select a folder.</div>';
            } else {
                const folderNodes = (nodes || []).filter(n => n.kind === 'folder' || n.isDirectory);
                const docNodes = (nodes || []).filter(n => n.kind === 'document' && !n.isDirectory);

                const folderNameMap = new Map();
                folderNodes.forEach(f => folderNameMap.set(f.id, f.name));

                const docsByFolder = new Map();
                const rootDocs = [];
                docNodes.forEach(d => {
                    const docPath = d.id || d.relativePath || '';
                    const lastSlashIdx = docPath.lastIndexOf('/');
                    const parentFolderId = lastSlashIdx > 0 ? docPath.substring(0, lastSlashIdx) : null;

                    if (parentFolderId && folderNameMap.has(parentFolderId)) {
                        if (!docsByFolder.has(parentFolderId)) {
                            docsByFolder.set(parentFolderId, []);
                        }
                        docsByFolder.get(parentFolderId).push(d);
                    } else {
                        rootDocs.push(d);
                    }
                });

                folderNodes.forEach(folder => {
                    const folderDocs = docsByFolder.get(folder.id) || [];
                    if (folderDocs.length === 0) return;

                    const subheader = document.createElement('div');
                    subheader.className = 'folder-subheader';
                    subheader.textContent = folder.name;
                    docList.appendChild(subheader);

                    folderDocs.forEach(doc => {
                        const { wrapper } = renderNode(doc, sourceId);
                        docList.appendChild(wrapper);
                    });
                });

                rootDocs.forEach(doc => {
                    const { wrapper } = renderNode(doc, sourceId);
                    docList.appendChild(wrapper);
                });
            }
        } else {
            const docList = document.createElement('div');
            docList.className = 'source-doc-list';
            docList.dataset.sourceId = sourceId;
            treePane.appendChild(docList);
            (nodes || []).forEach(node => {
                const { wrapper } = renderNode(node, sourceId);
                docList.appendChild(wrapper);
            });
        }

        // Add separate imported docs section
        const importedSection = document.createElement('div');
        importedSection.className = 'imported-docs-section';
        importedSection.innerHTML = `
            <div class="imported-docs-header">IMPORTED DOCS</div>
            <div id="imported-docs-list">
                <div class="empty-state">No imported documents</div>
            </div>
        `;
        treePane.appendChild(importedSection);

        // Fetch imported docs on initial load
        vscode.postMessage({ type: 'fetchImportedDocs' });
    }

    function renderOnlineDocs(roots, enabledSources) {
        if (!treePaneOnline) return;
        
        // Clear only online pane
        treePaneOnline.innerHTML = '';

        if (!roots || roots.length === 0) {
            treePaneOnline.innerHTML = '<div class="empty-state">No online sources available</div>';
            return;
        }

        const effectiveEnabledSources = enabledSources || {
            clickup: true,
            linear: true,
            notion: true
        };

        const filteredRoots = roots.filter(({ sourceId }) => {
            return effectiveEnabledSources[sourceId] !== false;
        });

        filteredRoots.forEach(({ sourceId, nodes }) => {
            const headerRow = document.createElement('div');
            headerRow.className = 'source-header-row';
            headerRow.style.cssText = 'display:flex;justify-content:space-between;align-items:center;padding:6px 12px;background:var(--panel-bg2);border-bottom:1px solid var(--accent-teal-dim);';

            const header = document.createElement('div');
            header.className = 'source-header';
            header.dataset.sourceId = sourceId;
            header.style.cssText = 'color:var(--accent-teal);font-weight:600;font-size:11px;letter-spacing:0.5px;text-transform:uppercase;';
            header.textContent = SOURCE_DISPLAY_NAMES[sourceId] || sourceId;
            headerRow.appendChild(header);

            const controlsContainer = document.createElement('div');
            controlsContainer.className = 'source-controls';
            controlsContainer.style.cssText = 'display:flex;align-items:center;gap:8px;';
            controlsContainer.dataset.sourceId = sourceId;
            
            const refreshBtn = document.createElement('button');
            refreshBtn.className = 'source-refresh-btn';
            refreshBtn.textContent = '↻';
            refreshBtn.title = 'Refresh';
            refreshBtn.style.cssText = 'font-size:11px;padding:2px 6px;background:transparent;color:var(--accent-teal);border:1px solid var(--accent-teal-dim);border-radius:2px;cursor:pointer;';
            refreshBtn.addEventListener('click', () => {
                refreshBtn.disabled = true;
                vscode.postMessage({ type: 'refreshSource', sourceId });
            });
            controlsContainer.appendChild(refreshBtn);
            headerRow.appendChild(controlsContainer);

            treePaneOnline.appendChild(headerRow);
            
            const docList = document.createElement('div');
            docList.className = 'source-doc-list';
            docList.dataset.sourceId = sourceId;
            treePaneOnline.appendChild(docList);
            
            docList.innerHTML = '<div class="tree-placeholder">Loading...</div>';
            
            vscode.postMessage({ type: 'fetchContainers', sourceId });
        });
    }

    function handleLocalDocsReady(msg) {
        renderLocalDocs({
            sourceId: msg.sourceId || 'local-folder',
            nodes: msg.nodes || [],
            folderPath: msg.folderPath || '',
            error: msg.error
        });
    }

    function handleOnlineDocsReady(msg) {
        renderOnlineDocs(msg.roots || [], msg.enabledSources || {
            clickup: true,
            linear: true,
            notion: true
        });
    }

    function handleRootsReady(msg) {
        const roots = msg.roots || [];
        const localRoot = roots.find(({ sourceId }) => sourceId === 'local-folder');
        if (localRoot) {
            renderLocalDocs(localRoot);
        }
        renderOnlineDocs(
            roots.filter(({ sourceId }) => ONLINE_SOURCES.includes(sourceId)),
            msg.enabledSources
        );
    }

    function handleChildrenReady(msg) {
        const { sourceId, parentId, nodes } = msg;
        
        const parentEl = findTreeNode(sourceId, parentId);
        
        if (!parentEl) return;
        
        const childContainer = parentEl.querySelector('.tree-children');
        if (!childContainer) return;
        
        childContainer.innerHTML = '';
        
        if (!nodes || nodes.length === 0) {
            childContainer.innerHTML = '<div class="tree-placeholder">(no items)</div>';
            return;
        }
        
        nodes.forEach(node => {
            const { wrapper } = renderNode(node, sourceId);
            childContainer.appendChild(wrapper);
        });
    }

    function handlePreviewReady(msg) {
        const { sourceId, requestId, content, docName, pages } = msg;

        if (requestId !== undefined && requestId !== state.previewRequestId) return;

        const isOnline = ONLINE_SOURCES.includes(sourceId);
        const targetPreview = isOnline ? markdownPreviewOnline : markdownPreview;
        const targetStatus = isOnline ? statusElOnline : statusEl;
        const targetBtnAppend = isOnline ? btnAppendToPromptsOnline : btnAppendToPrompts;
        const targetBtnImport = isOnline ? btnImportAndCopyLinkOnline : btnImportAndCopyLink;
        const btnImportFullId = isOnline ? 'btn-import-full-doc-online' : 'btn-import-full-doc';

        const btnImportFullDoc = document.getElementById(btnImportFullId);
        if (btnImportFullDoc) {
            btnImportFullDoc.style.display = '';
            btnImportFullDoc.disabled = false;
            btnImportFullDoc.dataset.docId = state.activeDocId || '';
        }

        if (pages && pages.length > 0) {
            state.currentPages = pages;

            let pageListHtml = '<div class="page-navigation" style="margin-bottom: 16px; padding: 12px; background: var(--panel-bg2); border: 1px solid var(--accent-teal-dim); border-radius: 4px;">';
            pageListHtml += '<div style="font-size: 11px; font-weight: 600; color: var(--accent-teal); margin-bottom: 8px; text-transform: uppercase; letter-spacing: 0.5px;">Pages</div>';
            pageListHtml += '<div style="display: flex; flex-direction: column; gap: 4px;">';
            pages.forEach(page => {
                pageListHtml += `<div class="page-item" data-page-id="${page.id}" style="padding: 6px 8px; cursor: pointer; border-radius: 3px; transition: background 0.1s; font-size: 13px; color: var(--accent-teal);">${page.name}</div>`;
            });
            pageListHtml += '</div></div>';
            
            if (content) {
                pageListHtml += '<div style="border-top: 1px solid var(--accent-teal-dim); margin-top: 12px; padding-top: 12px;">';
                pageListHtml += renderMarkdown(content);
                pageListHtml += '</div>';
                targetBtnAppend.disabled = false;
                targetBtnImport.disabled = false;
            } else {
                pageListHtml += '<div class="empty-state" style="padding: 32px; text-align: center; color: var(--text-secondary);">Select a page above to view its content, or click "Import full doc" to import the entire document.</div>';
            }
            targetPreview.innerHTML = pageListHtml;

            targetPreview.querySelectorAll('.page-item').forEach(item => {
                item.addEventListener('click', () => {
                    const pageId = item.dataset.pageId;
                    if (!pageId || !state.activeDocId) return;

                    targetPreview.querySelectorAll('.page-item').forEach(i => i.style.background = '');
                    item.style.background = 'var(--accent-teal-dim)';

                    vscode.postMessage({
                        type: 'fetchPageContent',
                        sourceId: state.activeSource,
                        docId: state.activeDocId,
                        pageId: pageId,
                        requestId: ++state.previewRequestId
                    });
                });
            });

            if (!content) {
                targetBtnAppend.disabled = true;
                targetBtnImport.disabled = true;
            }
            return;
        }

        state.activeDocContent = content;

        targetPreview.innerHTML = renderMarkdown(content);

        targetBtnAppend.disabled = false;
        targetBtnImport.disabled = false;
        targetStatus.textContent = '';
    }

    function handlePreviewError(msg) {
        const { sourceId, requestId, error } = msg;

        if (requestId !== state.previewRequestId) return;

        const isOnline = ONLINE_SOURCES.includes(sourceId);
        const targetPreview = isOnline ? markdownPreviewOnline : markdownPreview;
        const targetStatus = isOnline ? statusElOnline : statusEl;
        const targetBtnAppend = isOnline ? btnAppendToPromptsOnline : btnAppendToPrompts;
        const targetBtnImport = isOnline ? btnImportAndCopyLinkOnline : btnImportAndCopyLink;
        const btnImportFullId = isOnline ? 'btn-import-full-doc-online' : 'btn-import-full-doc';

        targetPreview.innerHTML = `<div class="error-state">Error: ${error}</div>`;
        targetStatus.textContent = 'Error loading preview';
        
        targetBtnAppend.disabled = true;
        targetBtnImport.disabled = true;

        const btnImportFullDoc = document.getElementById(btnImportFullId);
        if (btnImportFullDoc) {
            btnImportFullDoc.disabled = true;
        }
    }

    function handlePlannerPromptState(msg) {
        if (msg.success) {
            statusEl.textContent = msg.message || 'Saved successfully';
            statusElOnline.textContent = msg.message || 'Saved successfully';
            
            // Just refresh imported docs list quietly
            vscode.postMessage({ type: 'fetchImportedDocs' });
            
            btnAppendToPrompts.disabled = false;
            btnImportAndCopyLink.disabled = false;
            btnAppendToPromptsOnline.disabled = false;
            btnImportAndCopyLinkOnline.disabled = false;
        } else if (msg.error) {
            statusEl.textContent = `Error: ${msg.error}`;
            statusElOnline.textContent = `Error: ${msg.error}`;
            btnAppendToPrompts.disabled = false;
            btnImportAndCopyLink.disabled = false;
            btnAppendToPromptsOnline.disabled = false;
            btnImportAndCopyLinkOnline.disabled = false;
        }
    }

    function handleThemeChanged() {
        // Handled automatically via CSS variables
    }

    function handleContainersReady(msg) {
        const { sourceId, containers } = msg;
        
        const isOnline = ONLINE_SOURCES.includes(sourceId);
        const targetPane = isOnline ? treePaneOnline : treePane;
        
        const docList = targetPane?.querySelector(`.source-doc-list[data-source-id="${sourceId}"]`);
        if (docList) {
            const filterKey = `filter:${sourceId}`;
            state.filterRequestIds[filterKey] = (state.filterRequestIds[filterKey] || 0) + 1;
            vscode.postMessage({
                type: 'fetchFilteredDocs',
                sourceId,
                containerId: '__all__',
                requestId: state.filterRequestIds[filterKey]
            });
        }

        if (!containers || containers.length === 0) return;

        const controlsContainer = targetPane?.querySelector(`.source-controls[data-source-id="${sourceId}"]`);
        const select = document.createElement('select');
        select.className = 'filter-select';
        select.style.cssText = 'background: var(--panel-bg); color: var(--text-primary); border: 1px solid var(--border-color); border-radius: 2px; font-size: 10px; padding: 2px 6px;';

        const allOption = document.createElement('option');
        allOption.value = '__all__';
        allOption.textContent = 'All';
        select.appendChild(allOption);

        const containerMap = new Map();
        containers.forEach(c => {
            const option = document.createElement('option');
            option.value = c.id;
            option.textContent = c.name;
            select.appendChild(option);
            containerMap.set(c.id, c.name);
        });

        select.addEventListener('change', () => {
            const filterKey = `filter:${sourceId}`;
            state.filterRequestIds[filterKey] = (state.filterRequestIds[filterKey] || 0) + 1;

            const containerId = select.value;
            if (containerId !== '__all__') {
                state.activeContainers.set(sourceId, {
                    id: containerId,
                    name: containerMap.get(containerId) || 'Unknown'
                });
            } else {
                state.activeContainers.delete(sourceId);
            }

            if (docList) docList.innerHTML = '<div class="tree-placeholder">Loading...</div>';
            vscode.postMessage({
                type: 'fetchFilteredDocs',
                sourceId,
                containerId: containerId,
                requestId: state.filterRequestIds[filterKey]
            });
        });

        if (controlsContainer) {
            controlsContainer.appendChild(select);
        }
    }

    function handleFilteredDocsReady(msg) {
        const { sourceId, nodes, requestId } = msg;
        const filterKey = `filter:${sourceId}`;
        
        if (requestId !== undefined && requestId !== state.filterRequestIds[filterKey]) return;
        
        state.filterRequestIds[filterKey] = requestId;

        const isOnline = ONLINE_SOURCES.includes(sourceId);
        const targetPane = isOnline ? treePaneOnline : treePane;
        const docList = targetPane?.querySelector(`.source-doc-list[data-source-id="${sourceId}"]`);
        if (!docList) return;
        
        docList.innerHTML = '';
        if (!nodes || nodes.length === 0) {
            if (isOnline) {
                const headerRow = targetPane?.querySelector(`.source-header-row:has(.source-header[data-source-id="${sourceId}"])`);
                if (headerRow) headerRow.style.display = 'none';
                docList.style.display = 'none';
            } else {
                docList.innerHTML = '<div class="tree-placeholder">(no files found)</div>';
            }
            return;
        }
        
        if (isOnline) {
            const headerRow = targetPane?.querySelector(`.source-header-row:has(.source-header[data-source-id="${sourceId}"])`);
            if (headerRow) headerRow.style.display = '';
            docList.style.display = '';
        }
        
        nodes.forEach(node => {
            const { wrapper } = renderNode(node, sourceId);
            docList.appendChild(wrapper);
        });
    }

    function handleLocalFolderPathUpdated(msg) {
        const { folderPath, nodes } = msg;
        const pathInput = document.getElementById('local-folder-path');
        if (pathInput) {
            pathInput.value = folderPath || '';
        }

        const docList = treePane?.querySelector('.source-doc-list[data-source-id="local-folder"]');
        if (docList) {
            docList.innerHTML = '';
            if (!nodes || nodes.length === 0) return;

            const folderNodes = (nodes || []).filter(n => n.kind === 'folder' || n.isDirectory);
            const docNodes = (nodes || []).filter(n => n.kind === 'document' && !n.isDirectory);

            const folderNameMap = new Map();
            folderNodes.forEach(f => folderNameMap.set(f.id, f.name));

            const docsByFolder = new Map();
            const rootDocs = [];
            docNodes.forEach(d => {
                const docPath = d.id || d.relativePath || '';
                const lastSlashIdx = docPath.lastIndexOf('/');
                const parentFolderId = lastSlashIdx > 0 ? docPath.substring(0, lastSlashIdx) : null;

                if (parentFolderId && folderNameMap.has(parentFolderId)) {
                    if (!docsByFolder.has(parentFolderId)) {
                        docsByFolder.set(parentFolderId, []);
                    }
                    docsByFolder.get(parentFolderId).push(d);
                } else {
                    rootDocs.push(d);
                }
            });

            folderNodes.forEach(folder => {
                const folderDocs = docsByFolder.get(folder.id) || [];
                if (folderDocs.length === 0) return;

                const subheader = document.createElement('div');
                subheader.className = 'folder-subheader';
                subheader.textContent = folder.name;
                docList.appendChild(subheader);

                folderDocs.forEach(doc => {
                    const { wrapper } = renderNode(doc, 'local-folder');
                    docList.appendChild(wrapper);
                });
            });

            rootDocs.forEach(doc => {
                const { wrapper } = renderNode(doc, 'local-folder');
                docList.appendChild(wrapper);
            });
        }
    }

    function handleDocPagesReady(msg) {
        const { sourceId, docId, pages, requestId } = msg;

        if (requestId !== undefined && requestId !== state.docPagesRequestId) return;

        // Display subpages as flat table of contents in preview pane
        const isOnline = ONLINE_SOURCES.includes(sourceId);
        const targetPreview = isOnline ? markdownPreviewOnline : markdownPreview;
        
        if (!pages || pages.length === 0) {
            return;
        }

        // Create table of contents at top of preview
        const toc = document.createElement('div');
        toc.className = 'table-of-contents';
        toc.style.cssText = 'padding: 12px; background: var(--panel-bg2); border-bottom: 1px solid var(--border-color); margin-bottom: 12px;';
        
        const tocTitle = document.createElement('div');
        tocTitle.textContent = 'Table of Contents';
        tocTitle.style.cssText = 'font-weight: 600; font-size: 12px; margin-bottom: 8px; color: var(--text-primary);';
        toc.appendChild(tocTitle);
        
        const tocList = document.createElement('ul');
        tocList.style.cssText = 'list-style: none; padding: 0; margin: 0;';
        
        pages.forEach(page => {
            const tocItem = document.createElement('li');
            tocItem.style.cssText = 'padding: 4px 0; margin: 0;';
            
            const tocLink = document.createElement('a');
            tocLink.href = '#';
            tocLink.textContent = page.name || 'Untitled';
            tocLink.style.cssText = 'color: var(--accent-teal); text-decoration: none; font-size: 12px;';
            tocLink.addEventListener('click', (e) => {
                e.preventDefault();
                // Load page content using page format
                const pageId = `page:${docId}:${page.id}`;
                state.previewRequestId++;
                vscode.postMessage({
                    type: 'fetchPageContent',
                    sourceId,
                    docId: docId,
                    pageId: page.id,
                    requestId: state.previewRequestId
                });
            });
            
            tocItem.appendChild(tocLink);
            tocList.appendChild(tocItem);
        });
        
        toc.appendChild(tocList);
        
        // Insert TOC at top of preview
        targetPreview.insertBefore(toc, targetPreview.firstChild);
    }

    function handleClipboardSeparatorPattern(msg) {
        const { preset, pattern } = msg;
        if (preset) {
            separatorPreset.value = preset;
            separatorCustomRow.style.display = preset === 'custom' ? 'block' : 'none';
        }
        if (pattern && preset !== 'custom') {
            separatorInput.value = pattern;
            updateSeparatorPreview(pattern);
        }
    }

    function handleClipboardSeparatorPatternUpdated(msg) {
        const { pattern } = msg;
        if (pattern) {
            updateSeparatorPreview(pattern);
        }
    }

    function handleAirlockExportComplete(msg) {
        const webaiStatus = document.getElementById('webai-status');
        const bundleBtn = document.getElementById('btn-bundle-code');
        if (webaiStatus) {
            webaiStatus.textContent = msg.message || 'Export complete';
        }
        if (bundleBtn) {
            bundleBtn.disabled = false;
            bundleBtn.innerText = 'BUNDLE CODE';
        }
    }

    function handleImportedDocsReady(msg) {
        const { docs } = msg;

        console.log('[handleImportedDocsReady] Received docs:', docs);

        state.importedDocs.clear();

        const importedDocsContainer = document.getElementById('imported-docs-list');
        if (!importedDocsContainer) return;

        importedDocsContainer.innerHTML = '';

        if (!docs || docs.length === 0) {
            importedDocsContainer.innerHTML = '<div class="empty-state">No imported documents</div>';
            return;
        }

        // Sort docs by order field to preserve subpage order
        const sortedDocs = [...docs].sort((a, b) => (a.order || 0) - (b.order || 0));

        // Group docs by sourceId to show subheaders for subpages
        const docsBySource = new Map();
        sortedDocs.forEach(doc => {
            const sourceKey = doc.sourceId || 'unknown';
            if (!docsBySource.has(sourceKey)) {
                docsBySource.set(sourceKey, []);
            }
            docsBySource.get(sourceKey).push(doc);
        });

        // Render docs grouped by source
        docsBySource.forEach((sourceDocs, sourceId) => {
            // Add source subheader if there are multiple sources or multiple docs from this source
            if (docsBySource.size > 1 || sourceDocs.length > 1) {
                const subheader = document.createElement('div');
                subheader.className = 'imported-docs-subheader';
                subheader.textContent = SOURCE_DISPLAY_NAMES[sourceId] || sourceId;
                subheader.style.cssText = 'padding: 8px 8px 4px; font-size: 10px; color: var(--text-secondary); text-transform: uppercase; letter-spacing: 0.5px; border-top: 1px solid var(--border-color); margin-top: 4px;';
                importedDocsContainer.appendChild(subheader);
            }

            sourceDocs.forEach(doc => {
            state.importedDocs.set(doc.docName, {
                sourceId: doc.sourceId,
                docId: doc.docId,
                docName: doc.docName,
                slugPrefix: doc.slugPrefix,
                canSync: doc.canSync
            });
            state.importedDocs.set(doc.slugPrefix, {
                sourceId: doc.sourceId,
                docId: doc.docId,
                docName: doc.docName,
                slugPrefix: doc.slugPrefix,
                canSync: doc.canSync
            });

            // Manually create doc item with same structure as renderNode
            const wrapper = document.createElement('div');
            wrapper.className = 'tree-node';
            wrapper.dataset.sourceId = 'local-folder';
            wrapper.dataset.docId = doc.slugPrefix;
            wrapper.dataset.slugPrefix = doc.slugPrefix;
            wrapper.style.cssText = 'padding: 4px 8px; cursor: pointer; display: flex; align-items: center; gap: 8px;';
            
            const icon = document.createElement('span');
            icon.textContent = '📄';
            icon.style.cssText = 'font-size: 14px;';
            
            const label = document.createElement('span');
            label.textContent = doc.docName;
            label.style.cssText = 'font-size: 12px; color: var(--text-primary);';
            
            wrapper.appendChild(icon);
            wrapper.appendChild(label);
            
            // Add click handler to load preview from docs directory
            wrapper.addEventListener('click', (e) => {
                e.stopPropagation();
                
                // Apply selection highlighting
                if (state.selectedEl) {
                    state.selectedEl.classList.remove('selected');
                }
                wrapper.classList.add('selected');
                state.selectedEl = wrapper;
                
                state.activeSource = 'local-folder';
                state.activeDocId = doc.slugPrefix;
                state.activeDocName = doc.docName;
                state.previewRequestId++;
                
                // Send message to load file from docs directory
                vscode.postMessage({
                    type: 'fetchDocsFile',
                    slugPrefix: doc.slugPrefix,
                    requestId: state.previewRequestId
                });
            });
            
            importedDocsContainer.appendChild(wrapper);
            });
        });
    }

    function handleSyncResult(msg) {
        const { slugPrefix, success, error } = msg;
        const docRow = document.querySelector(`.imported-doc-row[data-slug-prefix="${slugPrefix}"]`);
        if (!docRow) return;

        const syncBtn = docRow.querySelector('.sync-btn');
        const lastSynced = docRow.querySelector('.last-synced');
        
        if (syncBtn) {
            syncBtn.disabled = false;
            syncBtn.textContent = '↑ Sync';
        }

        if (btnExportToSource && btnExportToSource.dataset.slugPrefix === slugPrefix) {
            btnExportToSource.disabled = false;
        }

        if (success) {
            if (lastSynced) {
                lastSynced.textContent = `Last synced: ${new Date().toLocaleString()}`;
            }
            statusEl.textContent = 'Sync completed successfully';
        } else {
            statusEl.textContent = `Sync failed: ${error || 'Unknown error'}`;
        }
    }

    // Message handler
    window.addEventListener('message', (event) => {
        const msg = event.data;

        switch (msg.type) {
            case 'rootsReady':
                handleRootsReady(msg);
                break;
            case 'localDocsReady':
                handleLocalDocsReady(msg);
                break;
            case 'onlineDocsReady':
                handleOnlineDocsReady(msg);
                break;
            case 'childrenReady':
                handleChildrenReady(msg);
                break;
            case 'previewReady':
                handlePreviewReady(msg);
                break;
            case 'previewError':
                handlePreviewError(msg);
                break;
            case 'plannerPromptState':
                handlePlannerPromptState(msg);
                break;
            case 'importAndCopyLinkState':
                if (msg.success) {
                    statusEl.textContent = msg.message || 'Link copied to clipboard';
                    statusElOnline.textContent = msg.message || 'Link copied to clipboard';
                    
                    // Quiet refresh
                    vscode.postMessage({ type: 'fetchImportedDocs' });
                    vscode.postMessage({ type: 'refreshSource', sourceId: 'local-folder' });
                    
                } else if (msg.error) {
                    statusEl.textContent = `Error: ${msg.error}`;
                    statusElOnline.textContent = `Error: ${msg.error}`;
                }
                btnImportAndCopyLink.disabled = false;
                btnAppendToPrompts.disabled = false;
                btnImportAndCopyLinkOnline.disabled = false;
                btnAppendToPromptsOnline.disabled = false;
                break;
            case 'importFullDocResult':
                if (msg.success) {
                    statusEl.textContent = msg.message || 'Full document imported';
                    statusElOnline.textContent = msg.message || 'Full document imported';
                    
                    // Update the imported docs list
                    vscode.postMessage({ type: 'fetchImportedDocs' });
                    
                    if (state.activeSource && state.activeDocId) {
                        vscode.postMessage({
                            type: 'fetchPreview',
                            sourceId: state.activeSource,
                            docId: state.activeDocId,
                            requestId: ++state.previewRequestId
                        });
                    }
                } else if (msg.error) {
                    statusEl.textContent = `Error: ${msg.error}`;
                    statusElOnline.textContent = `Error: ${msg.error}`;
                }
                const btnImportFullDoc = document.getElementById('btn-import-full-doc');
                if (btnImportFullDoc) btnImportFullDoc.disabled = false;
                const btnImportFullDocOnline = document.getElementById('btn-import-full-doc-online');
                if (btnImportFullDocOnline) btnImportFullDocOnline.disabled = false;
                break;
            case 'themeChanged':
                handleThemeChanged();
                break;
            case 'containersReady':
                handleContainersReady(msg);
                break;
            case 'filteredDocsReady':
                handleFilteredDocsReady(msg);
                break;
            case 'docPagesReady':
                handleDocPagesReady(msg);
                break;
            case 'localFolderPathUpdated':
                handleLocalFolderPathUpdated(msg);
                break;
            case 'clipboardSeparatorPattern':
                handleClipboardSeparatorPattern(msg);
                break;
            case 'clipboardSeparatorPatternUpdated':
                handleClipboardSeparatorPatternUpdated(msg);
                break;
            case 'airlock_exportComplete':
                handleAirlockExportComplete(msg);
                break;
            case 'importedDocsReady':
                handleImportedDocsReady(msg);
                break;
            case 'syncResult':
                handleSyncResult(msg);
                break;
            case 'activeDesignDocUpdated':
                updateActiveDocBanner(msg);
                break;
        }
    });

    // Active Design Doc Banner handlers
    const btnDisableDocLocal = document.getElementById('btn-disable-doc-local');
    const btnDisableDocOnline = document.getElementById('btn-disable-doc-online');

    function updateActiveDocBanner(msg) {
        const bannerLocal = document.getElementById('active-doc-banner-local');
        const bannerOnline = document.getElementById('active-doc-banner-online');
        const nameLocal = document.getElementById('active-doc-name-local');
        const nameOnline = document.getElementById('active-doc-name-online');

        const isActive = msg.enabled && msg.docName;
        const docName = msg.docName || 'None';

        if (bannerLocal) {
            bannerLocal.classList.toggle('inactive', !isActive);
            if (nameLocal) nameLocal.textContent = docName;
        }
        if (bannerOnline) {
            bannerOnline.classList.toggle('inactive', !isActive);
            if (nameOnline) nameOnline.textContent = docName;
        }
    }

    function handleDisableDesignDoc() {
        vscode.postMessage({ type: 'disableDesignDoc' });
    }

    if (btnDisableDocLocal) {
        btnDisableDocLocal.addEventListener('click', handleDisableDesignDoc);
    }
    if (btnDisableDocOnline) {
        btnDisableDocOnline.addEventListener('click', handleDisableDesignDoc);
    }

    // Button handlers
    btnAppendToPrompts.addEventListener('click', () => {
        if (!state.activeSource || !state.activeDocId) return;

        btnAppendToPrompts.disabled = true;
        statusEl.textContent = 'Appending to planning prompts...';

        const payload = {
            type: 'appendToPlannerPrompt',
            sourceId: state.activeSource,
            docId: state.activeDocId,
            docName: state.activeDocName || state.activeDocId
        };
        if (state.activeDocContent) {
            payload.content = state.activeDocContent;
        }
        vscode.postMessage(payload);
    });

    btnImportAndCopyLink.addEventListener('click', () => {
        if (!state.activeSource || !state.activeDocId) return;

        btnImportAndCopyLink.disabled = true;
        statusEl.textContent = 'Importing and copying link...';

        const payload = {
            type: 'importAndCopyLink',
            sourceId: state.activeSource,
            docId: state.activeDocId,
            docName: state.activeDocName || state.activeDocId
        };
        if (state.activeDocContent) {
            payload.content = state.activeDocContent;
        }
        vscode.postMessage(payload);
    });

    if (btnAppendToPromptsOnline) {
        btnAppendToPromptsOnline.addEventListener('click', () => {
            if (!state.activeSource || !state.activeDocId) return;

            btnAppendToPromptsOnline.disabled = true;
            statusElOnline.textContent = 'Appending to planning prompts...';

            const payload = {
                type: 'appendToPlannerPrompt',
                sourceId: state.activeSource,
                docId: state.activeDocId,
                docName: state.activeDocName || state.activeDocId
            };
            if (state.activeDocContent) {
                payload.content = state.activeDocContent;
            }
            vscode.postMessage(payload);
        });
    }

    if (btnImportAndCopyLinkOnline) {
        btnImportAndCopyLinkOnline.addEventListener('click', () => {
            if (!state.activeSource || !state.activeDocId) return;

            btnImportAndCopyLinkOnline.disabled = true;
            statusElOnline.textContent = 'Importing and copying link...';

            const payload = {
                type: 'importAndCopyLink',
                sourceId: state.activeSource,
                docId: state.activeDocId,
                docName: state.activeDocName || state.activeDocId
            };
            if (state.activeDocContent) {
                payload.content = state.activeDocContent;
            }
            vscode.postMessage(payload);
        });
    }

    const btnImportFullDoc = document.getElementById('btn-import-full-doc');
    if (btnImportFullDoc) {
        btnImportFullDoc.addEventListener('click', () => {
            const docId = btnImportFullDoc.dataset.docId;
            if (!docId) return;

            btnImportFullDoc.disabled = true;
            statusEl.textContent = 'Importing full document...';

            vscode.postMessage({
                type: 'importFullDoc',
                sourceId: state.activeSource,
                docId: docId,
                docName: state.activeDocName || docId
            });
        });
    }

    const btnImportFullDocOnline = document.getElementById('btn-import-full-doc-online');
    if (btnImportFullDocOnline) {
        btnImportFullDocOnline.addEventListener('click', () => {
            const docId = btnImportFullDocOnline.dataset.docId;
            if (!docId) return;

            btnImportFullDocOnline.disabled = true;
            statusElOnline.textContent = 'Importing full document...';

            vscode.postMessage({
                type: 'importFullDoc',
                sourceId: state.activeSource,
                docId: docId,
                docName: state.activeDocName || docId
            });
        });
    }

    if (btnExportToSource) {
        btnExportToSource.addEventListener('click', () => {
            const slugPrefix = btnExportToSource.dataset.slugPrefix;
            if (!slugPrefix) return;

            btnExportToSource.disabled = true;
            statusEl.textContent = 'Exporting to source...';

            vscode.postMessage({
                type: 'syncToSource',
                slugPrefix: slugPrefix
            });
        });
    }

    // Initialize
    vscode.postMessage({ type: 'fetchRoots' });
    vscode.postMessage({ type: 'fetchImportedDocs' });
})();