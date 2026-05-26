(function() {
    const vscode = acquireVsCodeApi();

    // Restore persisted state
    const persistedState = vscode.getState() || {};

    // State object (must be declared before use)
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
        filterRequestIds: {},
        researchMode: persistedState.researchMode || 'web',
        localFolderPaths: [],
        analystAvailable: false,
        docsListCollapsed: persistedState.docsListCollapsed || false
    };

    function toggleSidebarCollapsed() {
        state.docsListCollapsed = !state.docsListCollapsed;
        
        // Persist state
        const currentPersisted = vscode.getState() || {};
        vscode.setState({ ...currentPersisted, docsListCollapsed: state.docsListCollapsed });
        
        // Apply class to all content rows
        const contentRows = document.querySelectorAll('.content-row');
        const toggleBtns = document.querySelectorAll('.sidebar-toggle-btn');
        
        contentRows.forEach(row => {
            row.classList.toggle('collapsed', state.docsListCollapsed);
        });
        
        toggleBtns.forEach(btn => {
            btn.textContent = state.docsListCollapsed ? '»' : '«';
        });
    }

    // Initialize sidebar state
    if (state.docsListCollapsed) {
        const contentRows = document.querySelectorAll('.content-row');
        const toggleBtns = document.querySelectorAll('.sidebar-toggle-btn');
        contentRows.forEach(row => row.classList.add('collapsed'));
        toggleBtns.forEach(btn => btn.textContent = '»');
    }

    // Bind sidebar toggle listeners
    document.querySelectorAll('.sidebar-toggle-btn').forEach(btn => {
        btn.addEventListener('click', toggleSidebarCollapsed);
    });

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

            if (tabName === 'kanban') {
                vscode.postMessage({ type: 'fetchKanbanPlans', requestId: Date.now() });
            }
        });
    });



    // Clipboard Import logic
    const copyAgentPromptBtn = document.getElementById('btn-copy-agent-prompt');
    const importPlansBtn = document.getElementById('btn-import-plans');

    if (copyAgentPromptBtn) {
        copyAgentPromptBtn.addEventListener('click', () => {
            const prompt = `Please output all features/plans as a single markdown block with each plan separated by this exact format:

--- PLAN ---
[plan 1 content here]

--- PLAN ---
[plan 2 content here]

--- PLAN ---
[plan 3 content here]

Each plan should have its own H1 title (# Plan Title) and full content. I will copy the entire block and import it into my planning system which will automatically split it into separate plan files.`;
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

    const importResearchDocBtn = document.getElementById('btn-import-research-doc');
    const importResearchDocClipboardBtn = document.getElementById('btn-import-research-doc-clipboard');

    const handleResearchImportClick = () => {
        const docTitleInput = document.getElementById('research-doc-title');
        const docTitle = docTitleInput ? docTitleInput.value.trim() : '';
        
        if (importResearchDocBtn) {
            importResearchDocBtn.disabled = true;
            importResearchDocBtn.innerText = 'IMPORTING...';
        }
        if (importResearchDocClipboardBtn) {
            importResearchDocClipboardBtn.disabled = true;
            importResearchDocClipboardBtn.innerText = 'IMPORTING...';
        }
        
        const statusEl = document.getElementById('research-import-status');
        if (statusEl) {
            statusEl.style.color = '';
            statusEl.textContent = 'Import in progress...';
        }

        vscode.postMessage({
            type: 'importResearchDoc',
            docTitle: docTitle || undefined
        });
    };

    if (importResearchDocBtn) {
        importResearchDocBtn.addEventListener('click', handleResearchImportClick);
    }
    if (importResearchDocClipboardBtn) {
        importResearchDocClipboardBtn.addEventListener('click', handleResearchImportClick);
    }

    // Research Tab: Unified Copy Button
    const copyResearchPromptBtn = document.getElementById('btn-copy-research-prompt');
    if (copyResearchPromptBtn) {
        copyResearchPromptBtn.addEventListener('click', async () => {
            if (copyResearchPromptBtn.innerText === 'COPIED') return;

            const prompt = generateResearchPrompt();
            const originalText = copyResearchPromptBtn.innerText;
            try {
                await navigator.clipboard.writeText(prompt);
                copyResearchPromptBtn.innerText = 'COPIED';
                setTimeout(() => {
                    if (copyResearchPromptBtn) copyResearchPromptBtn.innerText = originalText;
                }, 2000);
            } catch (err) {
                console.error('[Research] Failed to copy to clipboard:', err);
                copyResearchPromptBtn.innerText = 'FAILED';
                setTimeout(() => {
                    if (copyResearchPromptBtn) copyResearchPromptBtn.innerText = originalText;
                }, 2000);
            }
        });
    }

    // Research Tab: Send to Analyst Button
    const sendToAnalystBtn = document.getElementById('btn-send-to-analyst');
    if (sendToAnalystBtn) {
        sendToAnalystBtn.addEventListener('click', () => {
            const prompt = generateResearchPrompt();
            vscode.postMessage({
                type: 'sendToAnalyst',
                prompt: prompt
            });
            sendToAnalystBtn.innerText = 'SENT';
            setTimeout(() => {
                if (sendToAnalystBtn) sendToAnalystBtn.innerText = 'SEND ANALYST REQUEST';
            }, 2000);
        });
    }

    // Check analyst availability on load
    function checkAnalystAvailability() {
        vscode.postMessage({ type: 'checkAnalystAvailability' });
    }

    // Call after DOM ready
    checkAnalystAvailability();

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

    const openAIStudioBtn = document.getElementById('btn-open-ai-studio');
    if (openAIStudioBtn) {
        openAIStudioBtn.addEventListener('click', () => {
            vscode.postMessage({ type: 'airlock_openAIStudio' });
        });
    }

    if (copySprintPromptBtn) {
        copySprintPromptBtn.addEventListener('click', () => {
            const prompt = `Please analyze the uploaded codebase and generate sprint plans. Output each plan separated by this exact format:

--- PLAN ---
[plan 1 content here]

--- PLAN ---
[plan 2 content here]

--- PLAN ---
[plan 3 content here]

Each plan should have its own H1 title (# Plan Title) and full content. I will copy the entire block and import it into my planning system which will automatically split it into separate plan files.`;
            navigator.clipboard.writeText(prompt).then(() => {
                copySprintPromptBtn.innerText = 'COPIED';
                setTimeout(() => { copySprintPromptBtn.innerText = 'COPY SPRINT PROMPT'; }, 2000);
            });
        });
    }

    const SOURCE_DISPLAY_NAMES = {
        'clickup': 'ClickUp',
        'linear': 'Linear',
        'notion': 'Notion',
        'local-folder': 'Cowork/local'
    };

    // Saved browse filter containers from config (restored after containers load)
    let _savedBrowseFilterContainers = {};

    const treePane = document.getElementById('tree-pane');
    const treePaneOnline = document.getElementById('tree-pane-online');
    const markdownPreview = document.getElementById('markdown-preview');
    const markdownPreviewOnline = document.getElementById('markdown-preview-online');
    const btnAppendToPrompts = document.getElementById('btn-set-active-context-local');
    const btnAppendToPromptsOnline = document.getElementById('btn-append-to-prompts-online');
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
            .replace(/\\([\\`*_{}[\]()#+\-.!|])/g, '$1');

        // Protect <pre> blocks from newline-to-space conversion.
        // Code blocks must preserve literal newlines for correct rendering;
        // only non-code content should get soft-wrap (space) behavior.
        const parts = html.split(/(<pre><code>[\s\S]*?<\/code><\/pre>)/);
        html = parts.map((part, i) => {
            if (i % 2 === 1) return part; // pre block — preserve newlines
            return part.replace(/\n\n+/g, '</p><p>').replace(/\n/g, ' ');
        }).join('');

        html = `<p>${html}</p>`;
        html = html.replace(/<p>\s*<\/p>/g, '');
        return html;
    }

    function renderNode(node, sourceId, depth = 0) {
        let deleteBtnRef = null;
        const wrapper = document.createElement('div');
        wrapper.className = 'tree-node';
        wrapper.dataset.sourceId = sourceId;
        wrapper.dataset.nodeId = node.id;
        wrapper.dataset.kind = node.kind || '';
        wrapper.dataset.name = node.name;
        if (node.metadata) {
            if (node.metadata.root) {
                wrapper.dataset.root = node.metadata.root;
            }
            if (node.metadata.sourceFolder) {
                wrapper.dataset.sourceFolder = node.metadata.sourceFolder;
            }
        }
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

            // Add delete button only for local-folder documents
            if (sourceId === 'local-folder') {
                const deleteBtn = document.createElement('button');
                deleteBtn.className = 'doc-delete-btn';
                deleteBtn.innerHTML = '×';
                deleteBtn.title = 'Move to trash';
                deleteBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    deleteBtn.disabled = true;
                    deleteBtn.textContent = '…';
                    vscode.postMessage({
                        type: 'deleteLocalDoc',
                        docId: node.id,
                        docName: node.name,
                        workspaceRoot: node.metadata ? node.metadata.root : undefined,
                        sourceFolder: node.metadata ? node.metadata.sourceFolder : undefined
                    });
                });
                deleteBtnRef = deleteBtn;
            }
        }

        wrapper.appendChild(icon);
        wrapper.appendChild(label);
        if (deleteBtnRef) {
            wrapper.appendChild(deleteBtnRef);
        }
        wrapper.appendChild(childContainer);

        return { wrapper, childContainer };
    }

    function loadDocumentPreview(sourceId, docId, docName) {
        if (state.selectedEl) {
            state.selectedEl.classList.remove('selected');
        }

        // 100% safe DOM traversal fallback - no querySelector escaping issues
        const wrapper = findTreeNode(sourceId, docId);
        // Extract sourceFolder from the DOM node's dataset (required for local-folder docs)
        const sourceFolder = wrapper ? wrapper.dataset.sourceFolder : undefined;
        
        if (wrapper) {
            wrapper.classList.add('selected');
            state.selectedEl = wrapper;
        }

        state.activeSource = sourceId;
        state.activeDocId = docId;
        state.activeDocName = docName;
        state.previewRequestId++;

        if (btnAppendToPrompts) btnAppendToPrompts.disabled = false;
        if (btnAppendToPromptsOnline) btnAppendToPromptsOnline.disabled = false;
        const btnLinkToOnline = document.getElementById('btn-link-to-doc-online');
        if (btnLinkToOnline) btnLinkToOnline.disabled = false;
        
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
                console.log('[PlanningPanel Webview] Sending fetchPreview:', { sourceId, docId, requestId: state.previewRequestId });
                vscode.postMessage({
                    type: 'fetchPreview',
                    sourceId,
                    docId: docId,
                    requestId: state.previewRequestId,
                    sourceFolder: sourceFolder
                });
            }
        } else {
            console.log('[PlanningPanel Webview] Sending fetchPreview (no page):', { sourceId, docId, requestId: state.previewRequestId });
            vscode.postMessage({
                type: 'fetchPreview',
                sourceId,
                docId: docId,
                requestId: state.previewRequestId,
                sourceFolder: sourceFolder
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

    function renderFolderList(paths) {
        const folderList = document.getElementById('local-folders-list');
        if (!folderList) return;
        folderList.innerHTML = '';

        if (!paths || paths.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'folder-list-empty';
            empty.textContent = 'No folders configured. Click Add Folder to get started.';
            folderList.appendChild(empty);
            return;
        }

        paths.forEach(path => {
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
            folderList.appendChild(row);
        });
    }

    function renderLocalDocs(rootEntry) {
        const { sourceId, nodes, folderPaths } = rootEntry;
        
        // Clear only local pane
        treePane.innerHTML = '';
        
        // Re-add sidebar toggle
        const toggleRow = document.createElement('div');
        toggleRow.className = 'sidebar-toggle-row';
        const toggleBtn = document.createElement('button');
        toggleBtn.className = 'sidebar-toggle-btn';
        toggleBtn.title = 'Toggle sidebar';
        toggleBtn.textContent = state.docsListCollapsed ? '»' : '«';
        toggleBtn.addEventListener('click', toggleSidebarCollapsed);
        toggleRow.appendChild(toggleBtn);
        treePane.appendChild(toggleRow);
        
        if (sourceId === 'local-folder') {
            const configRow = document.createElement('div');
            configRow.className = 'folder-config-container';
            configRow.style.display = 'flex';
            configRow.style.flexDirection = 'column';
            configRow.style.gap = '8px';
            configRow.style.padding = '8px';
            configRow.style.borderBottom = '1px solid var(--border-color)';

            const controlsRow = document.createElement('div');
            controlsRow.style.display = 'flex';
            controlsRow.style.alignItems = 'center';
            controlsRow.style.justifyContent = 'space-between';
            controlsRow.style.gap = '8px';

            const sectionTitle = document.createElement('span');
            sectionTitle.textContent = 'Local Docs Folders';
            sectionTitle.style.fontWeight = 'bold';
            sectionTitle.style.fontSize = '11px';
            sectionTitle.style.textTransform = 'uppercase';
            sectionTitle.style.color = 'var(--text-secondary)';

            const buttonsContainer = document.createElement('div');
            buttonsContainer.style.display = 'flex';
            buttonsContainer.style.gap = '6px';

            const refreshLocalBtn = document.createElement('button');
            refreshLocalBtn.textContent = '↻';
            refreshLocalBtn.title = 'Refresh Local Folders';
            refreshLocalBtn.style.padding = '2px 6px';
            refreshLocalBtn.addEventListener('click', () => {
                vscode.postMessage({ type: 'refreshSource', sourceId: 'local-folder' });
            });

            const addFolderBtn = document.createElement('button');
            addFolderBtn.textContent = 'Add Folder';
            addFolderBtn.style.padding = '2px 8px';
            addFolderBtn.addEventListener('click', () => {
                vscode.postMessage({ type: 'addLocalFolder' });
            });

            buttonsContainer.appendChild(refreshLocalBtn);
            buttonsContainer.appendChild(addFolderBtn);
            controlsRow.appendChild(sectionTitle);
            controlsRow.appendChild(buttonsContainer);
            configRow.appendChild(controlsRow);

            const folderList = document.createElement('div');
            folderList.id = 'local-folders-list';
            folderList.className = 'folder-list';
            configRow.appendChild(folderList);

            treePane.appendChild(configRow);

            // ALWAYS create docList container so handleLocalFolderPathUpdated can find it later
            const docList = document.createElement('div');
            docList.className = 'source-doc-list';
            docList.dataset.sourceId = sourceId;
            treePane.appendChild(docList);

            // Render list
            renderFolderList(folderPaths || []);

            if (!nodes || nodes.length === 0) {
                // Check if there are imported docs from other sources (clickup, linear, notion)
                const hasOtherImportedDocs = state.importedDocs.size > 0;
                if (hasOtherImportedDocs) {
                    // Don't show empty message - imported docs are displayed below
                    docList.innerHTML = '';
                } else {
                    docList.innerHTML = '<div class="empty-state" style="padding: 12px; font-size: 12px; color: var(--text-secondary);">No folders configured or all folders are empty. Click Add Folder to get started.</div>';
                }
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

        // Add separate imported docs section (only if it doesn't exist)
        let importedSection = document.getElementById('imported-docs-list');
        if (!importedSection) {
            importedSection = document.createElement('div');
            importedSection.className = 'imported-docs-section';
            importedSection.id = 'imported-docs-list';
            treePane.appendChild(importedSection);
        }

        // Fetch imported docs on initial load
        vscode.postMessage({ type: 'fetchImportedDocs' });
    }

    function renderAntigravitySessions(sessions, enabled) {
        if (!treePane) { return; }

        // Remove existing section
        const existing = document.getElementById('antigravity-section');
        if (existing) { existing.remove(); }

        if (!enabled) { return; }

        const section = document.createElement('div');
        section.id = 'antigravity-section';

        const header = document.createElement('div');
        header.className = 'source-header';
        header.textContent = 'ANTIGRAVITY SESSIONS';
        section.appendChild(header);

        if (sessions.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'tree-placeholder';
            empty.textContent = 'No sessions found in brain directory';
            section.appendChild(empty);
        } else {
            for (const session of sessions) {
                // Session row (collapsed header) — use textContent to prevent XSS from filesystem filenames
                const sessionRow = document.createElement('div');
                sessionRow.className = 'tree-node folder-subheader';

                const sessionIcon = document.createElement('span');
                sessionIcon.className = 'icon';
                sessionIcon.textContent = '🧠';

                const sessionLabel = document.createElement('span');
                sessionLabel.className = 'label';
                sessionLabel.textContent = session.name + '…';

                const sessionTs = document.createElement('span');
                sessionTs.className = 'antigravity-session-ts';
                sessionTs.textContent = new Date(session.timestamp).toLocaleDateString();

                sessionRow.appendChild(sessionIcon);
                sessionRow.appendChild(sessionLabel);
                sessionRow.appendChild(sessionTs);
                section.appendChild(sessionRow);

                // Artifact rows under each session
                for (const artifact of session.artifacts) {
                    const artifactRow = document.createElement('div');
                    artifactRow.className = 'tree-node antigravity-artifact-node';
                    artifactRow.dataset.artifactPath = artifact.id;

                    const artifactIcon = document.createElement('span');
                    artifactIcon.className = 'icon';
                    artifactIcon.textContent = '📄';

                    const artifactLabel = document.createElement('span');
                    artifactLabel.className = 'label';
                    artifactLabel.textContent = artifact.name;

                    artifactRow.appendChild(artifactIcon);
                    artifactRow.appendChild(artifactLabel);
                    artifactRow.addEventListener('click', () => {
                        document.querySelectorAll('.tree-node.selected').forEach(n => n.classList.remove('selected'));
                        artifactRow.classList.add('selected');
                        // Track active state so buttons (Set as Active Context, etc.) work
                        state.activeSource = 'antigravity';
                        state.activeDocId = artifact.id;
                        state.activeDocName = artifact.name;
                        vscode.postMessage({
                            type: 'fetchAntigravityArtifact',
                            artifactPath: artifact.id,
                            requestId: ++state.previewRequestId
                        });
                    });
                    section.appendChild(artifactRow);
                }
            }
        }

        treePane.appendChild(section);
    }

    function renderOnlineDocs(roots, enabledSources) {
        if (!treePaneOnline) return;
        
        // Clear only online pane
        treePaneOnline.innerHTML = '';

        // Re-add sidebar toggle
        const toggleRow = document.createElement('div');
        toggleRow.className = 'sidebar-toggle-row';
        const toggleBtn = document.createElement('button');
        toggleBtn.className = 'sidebar-toggle-btn';
        toggleBtn.title = 'Toggle sidebar';
        toggleBtn.textContent = state.docsListCollapsed ? '»' : '«';
        toggleBtn.addEventListener('click', toggleSidebarCollapsed);
        toggleRow.appendChild(toggleBtn);
        treePaneOnline.appendChild(toggleRow);

        if (!roots || roots.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'empty-state';
            empty.textContent = 'No online sources available';
            treePaneOnline.appendChild(empty);
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
        console.log('[PlanningPanel Webview] handleLocalDocsReady called:', msg);
        state.localFolderPaths = msg.folderPaths || [];
        renderLocalDocs({
            sourceId: msg.sourceId || 'local-folder',
            nodes: msg.nodes || [],
            folderPaths: msg.folderPaths || [],
            error: msg.error
        });

        // Handle antigravity sessions section
        renderAntigravitySessions(msg.antigravitySessions || [], msg.antigravityEnabled || false);

        // Sync toggle state
        const agToggle = document.getElementById('antigravity-toggle');
        if (agToggle) { agToggle.checked = msg.antigravityEnabled || false; }
    }

    function handleOnlineDocsReady(msg) {
        // Stash saved filter containers for re-application after containers load
        _savedBrowseFilterContainers = msg.browseFilterContainers || {};
        renderOnlineDocs(msg.roots || [], msg.enabledSources || {
            clickup: true,
            linear: true,
            notion: true
        });
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
        const { sourceId, requestId, content, docName, pages, isAutoRefreshed } = msg;

        // Auto-refresh notification
        if (isAutoRefreshed) {
            const statusEl = sourceId === 'local-folder' ? document.getElementById('status') : document.getElementById('status-online');
            if (statusEl) {
                const originalText = statusEl.textContent;
                statusEl.textContent = 'Document auto-refreshed';
                statusEl.style.color = 'var(--accent-teal)';
                setTimeout(() => {
                    statusEl.textContent = originalText;
                    statusEl.style.color = '';
                }, 2000);
            }
        }

        if (requestId !== undefined && requestId !== -1 && requestId !== state.previewRequestId) return;

        const isOnline = ONLINE_SOURCES.includes(sourceId);
        const targetPreview = isOnline ? markdownPreviewOnline : markdownPreview;
        const targetStatus = isOnline ? statusElOnline : statusEl;
        const targetBtnAppend = isOnline ? btnAppendToPromptsOnline : btnAppendToPrompts;
        const btnImportFullId = isOnline ? 'btn-import-full-doc-online' : 'btn-import-full-doc';

        const btnImportFullDoc = document.getElementById(btnImportFullId);
        const btnSetActiveLocal = document.getElementById('btn-set-active-context-local');
        const btnLinkToLocal = document.getElementById('btn-link-to-doc-local');

        if (sourceId === 'local-folder' || sourceId === 'antigravity') {
            if (btnImportFullDoc) {
                btnImportFullDoc.style.display = 'none';
                btnImportFullDoc.disabled = true;
            }
            if (btnSetActiveLocal) {
                btnSetActiveLocal.style.display = '';
                btnSetActiveLocal.disabled = false;
            }
            if (btnLinkToLocal) {
                btnLinkToLocal.style.display = '';
                btnLinkToLocal.disabled = false;
            }
        } else {
            if (btnImportFullDoc) {
                btnImportFullDoc.style.display = '';
                btnImportFullDoc.disabled = false;
                btnImportFullDoc.dataset.docId = state.activeDocId || '';
            }
            if (btnSetActiveLocal) {
                btnSetActiveLocal.style.display = 'none';
                btnSetActiveLocal.disabled = true;
            }
            if (btnLinkToLocal) {
                btnLinkToLocal.style.display = 'none';
                btnLinkToLocal.disabled = true;
            }
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
                if (btnImportFullDoc) btnImportFullDoc.disabled = false;
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
                if (btnImportFullDoc) btnImportFullDoc.disabled = true;
            }
            if (msg.isAutoRefreshed) {
                targetStatus.textContent = 'Externally updated — refreshed';
                setTimeout(() => { if (targetStatus.textContent === 'Externally updated — refreshed') targetStatus.textContent = ''; }, 2000);
            } else {
                targetStatus.textContent = '';
            }
            return;
        }

        state.activeDocContent = content;

        targetPreview.innerHTML = renderMarkdown(content);

        targetBtnAppend.disabled = false;
        if (btnImportFullDoc) btnImportFullDoc.disabled = false;
        
        if (msg.isAutoRefreshed) {
            targetStatus.textContent = 'Externally updated — refreshed';
            setTimeout(() => { if (targetStatus.textContent === 'Externally updated — refreshed') targetStatus.textContent = ''; }, 2000);
        } else {
            targetStatus.textContent = '';
        }
    }

    function handlePreviewError(msg) {
        const { sourceId, requestId, error } = msg;

        if (requestId !== state.previewRequestId) return;

        const isOnline = ONLINE_SOURCES.includes(sourceId);
        const targetPreview = isOnline ? markdownPreviewOnline : markdownPreview;
        const targetStatus = isOnline ? statusElOnline : statusEl;
        const targetBtnAppend = isOnline ? btnAppendToPromptsOnline : btnAppendToPrompts;
        const btnImportFullId = isOnline ? 'btn-import-full-doc-online' : 'btn-import-full-doc';

        const errorDiv = document.createElement('div');
        errorDiv.className = 'error-state';
        errorDiv.textContent = 'Error: ' + error;
        targetPreview.innerHTML = '';
        targetPreview.appendChild(errorDiv);
        targetStatus.textContent = 'Error loading preview';
        
        targetBtnAppend.disabled = true;

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
            btnAppendToPromptsOnline.disabled = false;
        } else if (msg.error) {
            statusEl.textContent = `Error: ${msg.error}`;
            statusElOnline.textContent = `Error: ${msg.error}`;
            btnAppendToPrompts.disabled = false;
            btnAppendToPromptsOnline.disabled = false;
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

            // Persist the selection
            vscode.postMessage({
                type: 'savePlanningContainerSelection',
                sourceId,
                containerId: select.value
            });

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

        // AFTER the select is fully populated, re-apply saved filter
        const savedContainerId = _savedBrowseFilterContainers[sourceId];
        if (savedContainerId && select.querySelector(`option[value="${savedContainerId}"]`)) {
            select.value = savedContainerId;
            state.activeContainers.set(sourceId, {
                id: savedContainerId,
                name: containerMap.get(savedContainerId) || 'Unknown'
            });
            // Trigger filtered doc load for the saved container
            const filterKey = `filter:${sourceId}`;
            state.filterRequestIds[filterKey] = (state.filterRequestIds[filterKey] || 0) + 1;
            vscode.postMessage({
                type: 'fetchFilteredDocs',
                sourceId,
                containerId: savedContainerId,
                requestId: state.filterRequestIds[filterKey]
            });
        }

        // Clear saved filter after applying (one-shot)
        delete _savedBrowseFilterContainers[sourceId];
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
        const { folderPath, folderPaths, nodes } = msg;
        if (folderPaths) {
            state.localFolderPaths = folderPaths;
        } else if (folderPath) {
            state.localFolderPaths = [folderPath];
        }
        renderFolderList(state.localFolderPaths);

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

        // Group docs: sourceId → parentDocName → docs[]
        const docsBySourceAndParent = new Map();
        sortedDocs.forEach(doc => {
            const sourceKey = doc.sourceId || 'unknown';
            const parentKey = doc.parentDocName || doc.docName; // Backward compat fallback
            if (!docsBySourceAndParent.has(sourceKey)) {
                docsBySourceAndParent.set(sourceKey, new Map());
            }
            if (!docsBySourceAndParent.get(sourceKey).has(parentKey)) {
                docsBySourceAndParent.get(sourceKey).set(parentKey, []);
            }
            docsBySourceAndParent.get(sourceKey).get(parentKey).push(doc);
        });

        // Render docs grouped by source then by parentDocName
        docsBySourceAndParent.forEach((parentGroups, sourceId) => {
            // Skip local-folder source - those docs appear in the main local docs tree
            if (sourceId === 'local-folder') {
                return;
            }

            // Create teal source header: "IMPORTED FROM {source}"
            const sourceHeader = document.createElement('div');
            sourceHeader.className = 'imported-docs-header';
            sourceHeader.textContent = `IMPORTED FROM ${SOURCE_DISPLAY_NAMES[sourceId] || sourceId}`;
            importedDocsContainer.appendChild(sourceHeader);

            parentGroups.forEach((groupDocs, parentDocName) => {
                // Only show doc subheader if there are multiple pages in this group
                if (groupDocs.length > 1) {
                    const docSubheader = document.createElement('div');
                    docSubheader.className = 'imported-docs-doc-subheader';
                    docSubheader.textContent = parentDocName;
                    importedDocsContainer.appendChild(docSubheader);
                }

                groupDocs.forEach(doc => {
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
                    wrapper.dataset.sourceId = doc.sourceId || 'local-folder';
                    wrapper.dataset.docId = doc.slugPrefix;
                    wrapper.dataset.slugPrefix = doc.slugPrefix;
                    wrapper.style.cssText = 'padding: 4px 8px; cursor: pointer; display: flex; align-items: center; gap: 8px;';

                    const icon = document.createElement('span');
                    icon.textContent = '📄';
                    icon.style.cssText = 'font-size: 14px;';

                    const label = document.createElement('span');
                    let displayLabel = doc.docName;
                    
                    // Deduplicate parent title if it prefixes the subpage title or if they are exactly identical
                    if (parentDocName && parentDocName !== 'unknown' && groupDocs.length > 1) {
                        if (displayLabel === parentDocName) {
                            displayLabel = 'Overview'; // If identical, call it overview instead of repeating the parent title
                        } else if (displayLabel.startsWith(parentDocName)) {
                            let stripped = displayLabel.substring(parentDocName.length).trim();
                            if (stripped.startsWith('-') || stripped.startsWith(':')) {
                                stripped = stripped.substring(1).trim();
                            }
                            if (stripped) {
                                displayLabel = stripped;
                            }
                        }
                    }
                    
                    label.textContent = displayLabel;
                    label.title = doc.docName; // Hover shows the full original title
                    label.style.cssText = 'font-size: 12px; color: var(--text-primary);';

                    // Add delete button for imported docs
                    const deleteBtn = document.createElement('button');
                    deleteBtn.className = 'doc-delete-btn';
                    deleteBtn.innerHTML = '×';
                    deleteBtn.title = 'Delete imported document';
                    deleteBtn.addEventListener('click', (e) => {
                        e.stopPropagation();
                        deleteBtn.disabled = true;
                        deleteBtn.textContent = '…';
                        vscode.postMessage({
                            type: 'deleteImportedDoc',
                            slugPrefix: doc.slugPrefix,
                            docName: doc.docName
                        });
                    });

                    wrapper.appendChild(icon);
                    wrapper.appendChild(label);
                    wrapper.appendChild(deleteBtn);

                    // Add click handler to load preview from docs directory
                    wrapper.addEventListener('click', (e) => {
                        e.stopPropagation();

                        // Apply selection highlighting
                        if (state.selectedEl) {
                            state.selectedEl.classList.remove('selected');
                        }
                        wrapper.classList.add('selected');
                        state.selectedEl = wrapper;

                        state.activeSource = doc.sourceId || 'local-folder';
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
    function showDuplicateModal(duplicateInfo) {
        const existingModal = document.querySelector('.duplicate-modal');
        if (existingModal) existingModal.remove();
        const sourceDisplayName = { clickup: 'ClickUp', notion: 'Notion', linear: 'Linear Docs', 'local-folder': 'Local Folder' }[duplicateInfo.existingDoc?.sourceId] || duplicateInfo.existingDoc?.sourceId || 'another source';
        const modal = document.createElement('div');
        modal.className = 'duplicate-modal';
        modal.innerHTML = `<div class="modal-content"><h3>Duplicate Document Detected</h3><p>"${duplicateInfo.docName}" already exists from ${sourceDisplayName}.</p><p style="font-size: 12px; color: var(--text-secondary);">Match type: ${duplicateInfo.matchType?.replace(/_/g, ' ') || 'unknown'}</p><div class="modal-actions"><button class="modal-btn-skip" data-action="skip">Skip</button><button class="modal-btn-replace" data-action="replace">Replace</button><button class="modal-btn-rename" data-action="rename">Import as Copy</button></div></div>`;
        modal.querySelectorAll('button').forEach(btn => {
            btn.addEventListener('click', () => {
                vscode.postMessage({ type: 'resolveDuplicate', docName: duplicateInfo.docName, sourceId: duplicateInfo.sourceId, docId: duplicateInfo.docId, action: btn.dataset.action });
                modal.remove();
            });
        });
        document.body.appendChild(modal);
    }

    window.addEventListener('message', (event) => {
        const msg = event.data;
        console.log('[PlanningPanel Webview] Received message:', msg.type, msg);

        switch (msg.type) {
            case 'error':
                console.error('[PlanningPanel Webview] Backend error:', msg.message);
                alert('Planning Panel Error: ' + msg.message);
                break;
            case 'kanbanPlansReady':
                handleKanbanPlansReady(msg);
                break;
            case 'kanbanPlanPreviewReady':
                handleKanbanPlanPreviewReady(msg);
                break;
            case 'kanbanContextSet':
                handleKanbanContextSet(msg);
                break;
            case 'kanbanPlanOpenResult':
                handleKanbanPlanOpenResult(msg);
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
                    
                    // Quiet refresh — refreshSource:local-folder triggers renderLocalDocs
                    // which dispatches fetchImportedDocs internally, so no standalone call needed
                    vscode.postMessage({ type: 'refreshSource', sourceId: 'local-folder' });
                    
                } else if (msg.error) {
                    statusEl.textContent = `Error: ${msg.error}`;
                    statusElOnline.textContent = `Error: ${msg.error}`;
                }
                btnAppendToPrompts.disabled = false;
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
            case 'importResearchDocResult':
                const docTitleInput = document.getElementById('research-doc-title');
                const researchStatusEl = document.getElementById('research-import-status');
                
                const btnResearch = document.getElementById('btn-import-research-doc');
                const btnResearchClipboard = document.getElementById('btn-import-research-doc-clipboard');
                
                if (btnResearch) {
                    btnResearch.disabled = false;
                    btnResearch.innerText = 'IMPORT RESEARCH DOC';
                }
                if (btnResearchClipboard) {
                    btnResearchClipboard.disabled = false;
                    btnResearchClipboard.innerText = 'IMPORT RESEARCH DOC';
                }
                
                if (msg.success) {
                    if (researchStatusEl) {
                        researchStatusEl.style.color = 'var(--accent-teal)';
                        researchStatusEl.textContent = `Imported: ${msg.docTitle || 'Research Doc'}`;
                    }
                    if (docTitleInput) {
                        docTitleInput.value = '';
                    }
                } else {
                    if (researchStatusEl) {
                        researchStatusEl.style.color = '#f14c4c';
                        researchStatusEl.textContent = `Error: ${msg.error || 'Failed to import'}`;
                    }
                }
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
            case 'localFoldersListed':
                state.localFolderPaths = msg.paths || [];
                renderFolderList(state.localFolderPaths);
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
            case 'duplicateDetected':
                showDuplicateModal(msg);
                break;
            case 'duplicateResolved':
                if (msg.success) {
                    statusElOnline.textContent = msg.message || 'Duplicate resolved';
                    vscode.postMessage({ type: 'fetchImportedDocs' });
                } else {
                    statusElOnline.textContent = `Error: ${msg.error}`;
                }
                break;
            case 'activeContextSet':
                if (msg.success) {
                    statusEl.textContent = msg.message || 'Set as active planning context';
                } else {
                    statusEl.textContent = `Error: ${msg.error || 'Failed to set active context'}`;
                }
                const btnSAL = document.getElementById('btn-set-active-context-local');
                if (btnSAL) btnSAL.disabled = false;
                break;
            case 'localDocDeleted':
                if (msg.success) {
                    statusEl.textContent = `Moved to trash: ${msg.docId}`;
                    // If the deleted doc was the active selection, clear preview
                    if (state.activeDocId === msg.docId) {
                        state.activeDocId = null;
                        state.activeDocName = null;
                        state.activeSource = null;
                        if (state.selectedEl) {
                            state.selectedEl.classList.remove('selected');
                            state.selectedEl = null;
                        }
                        const previewContent = document.getElementById('preview-content');
                        if (previewContent) {
                            previewContent.innerHTML = '<div class="empty-state">Select a document to preview</div>';
                        }
                        const activeDocName = document.getElementById('active-doc-name-local');
                        if (activeDocName) { activeDocName.textContent = 'None'; }
                    }
                } else {
                    statusEl.textContent = `Failed to delete: ${msg.error || 'Unknown error'}`;
                }
                break;
            case 'importedDocDeleted':
                if (msg.success) {
                    statusEl.textContent = `Deleted: ${msg.docName || msg.slugPrefix}`;
                    // If the deleted doc was the active selection, clear preview
                    if (state.activeDocId === msg.slugPrefix) {
                        state.activeDocId = null;
                        state.activeDocName = null;
                        state.activeSource = null;
                        if (state.selectedEl) {
                            state.selectedEl.classList.remove('selected');
                            state.selectedEl = null;
                        }
                        markdownPreview.innerHTML = '<div class="empty-state">Select a document to preview</div>';
                    }
                } else {
                    statusEl.textContent = `Failed to delete: ${msg.error || 'Unknown error'}`;
                }
                break;
            case 'analystAvailabilityResult':
                const analystBtn = document.getElementById('btn-send-to-analyst');
                if (analystBtn) {
                    analystBtn.disabled = !msg.available;
                    if (!msg.available) {
                        analystBtn.title = 'Analyst terminal not available. Configure an analyst agent to enable this feature.';
                    } else {
                        analystBtn.removeAttribute('title');
                    }
                }
                break;
            case 'sendToAnalystResult': {
                const sendToAnalystBtn = document.getElementById('btn-send-to-analyst');
                if (sendToAnalystBtn) {
                    if (msg.success) {
                        sendToAnalystBtn.innerText = 'SENT';
                        setTimeout(() => {
                            if (sendToAnalystBtn) sendToAnalystBtn.innerText = 'SEND ANALYST REQUEST';
                        }, 2000);
                    } else {
                        sendToAnalystBtn.innerText = 'FAILED';
                        console.error('[Research] Failed to send to analyst:', msg.error);
                        setTimeout(() => {
                            if (sendToAnalystBtn) sendToAnalystBtn.innerText = 'SEND ANALYST REQUEST';
                        }, 2000);
                    }
                }
                break;
            }
        }
    });

    // Active Design Doc Banner handlers
    const btnDisableDocLocal = document.getElementById('btn-disable-doc-local');
    const btnDisableDocOnline = document.getElementById('btn-disable-doc-online');
    const btnDisableDocKanban = document.getElementById('btn-disable-doc-kanban');

    function updateActiveDocBanner(msg) {
        const bannerLocal = document.getElementById('active-doc-banner-local');
        const bannerOnline = document.getElementById('active-doc-banner-online');
        const bannerKanban = document.getElementById('active-doc-banner-kanban');
        const nameLocal = document.getElementById('active-doc-name-local');
        const nameOnline = document.getElementById('active-doc-name-online');
        const nameKanban = document.getElementById('active-doc-name-kanban');

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
        if (bannerKanban) {
            bannerKanban.classList.toggle('inactive', !isActive);
            if (nameKanban) nameKanban.textContent = docName;
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
    if (btnDisableDocKanban) {
        btnDisableDocKanban.addEventListener('click', handleDisableDesignDoc);
    }

    // Button handlers
    if (btnAppendToPrompts) {
        btnAppendToPrompts.addEventListener('click', () => {
            if (!state.activeSource || !state.activeDocId) return;

            btnAppendToPrompts.disabled = true;
            statusEl.textContent = 'Appending to planning prompts...';

        const wrapper = findTreeNode(state.activeSource, state.activeDocId);
        const sourceFolder = wrapper ? wrapper.dataset.sourceFolder : undefined;
        const payload = {
            type: 'appendToPlannerPrompt',
            sourceId: state.activeSource,
            docId: state.activeDocId,
            docName: state.activeDocName || state.activeDocId,
            sourceFolder
        };
        if (state.activeDocContent) {
            payload.content = state.activeDocContent;
        }
        vscode.postMessage(payload);
        });
    }

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

    const btnLinkToOnline = document.getElementById('btn-link-to-doc-online');
    if (btnLinkToOnline) {
        btnLinkToOnline.addEventListener('click', () => {
            if (!state.activeSource || !state.activeDocId) return;
            vscode.postMessage({
                type: 'linkToDocument',
                sourceId: state.activeSource,
                docId: state.activeDocId,
                docName: state.activeDocName || state.activeDocId
            });
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

    const btnSetActiveLocal = document.getElementById('btn-set-active-context-local');
    if (btnSetActiveLocal) {
        btnSetActiveLocal.addEventListener('click', () => {
            if (!state.activeSource || !state.activeDocId) return;
            btnSetActiveLocal.disabled = true;
            statusEl.textContent = 'Setting as active planning context...';
            const wrapper = findTreeNode(state.activeSource, state.activeDocId);
            const sourceFolder = wrapper ? wrapper.dataset.sourceFolder : undefined;
            vscode.postMessage({
                type: 'setActivePlanningContext',
                sourceId: state.activeSource,
                docId: state.activeDocId,
                docName: state.activeDocName || state.activeDocId,
                sourceFolder
            });
        });
    }

    const btnLinkToLocal = document.getElementById('btn-link-to-doc-local');
    if (btnLinkToLocal) {
        btnLinkToLocal.addEventListener('click', () => {
            if (!state.activeSource || !state.activeDocId) return;
            const wrapper = findTreeNode(state.activeSource, state.activeDocId);
            const sourceFolder = wrapper ? wrapper.dataset.sourceFolder : undefined;
            vscode.postMessage({
                type: 'linkToDocument',
                sourceId: state.activeSource,
                docId: state.activeDocId,
                docName: state.activeDocName || state.activeDocId,
                sourceFolder
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

    // Research Tab: Prompt Generation Functions
    function generateResearchPrompt() {
        const complexityInput = document.querySelector('input[name="complexity"]:checked');
        const importToggle = document.getElementById('import-toggle');
        const promptInput = document.getElementById('research-prompt-input');

        const complexity = complexityInput ? complexityInput.value : 'quick';
        const importEnabled = importToggle ? importToggle.checked : false;
        const customPrompt = promptInput ? promptInput.value.trim() : '';

        const complexityLabels = {
            quick: 'Quick (5-10 sources)',
            standard: 'Standard (15-30 sources)',
            deep: 'Deep (50-100+ sources)',
            academic: 'Academic (100-200+ sources)'
        };

        const skillName = 'web_research';
        const taskType = 'conduct comprehensive research on the following topic';
        const depthLabel = 'Research depth';

        // Use configured local docs folder path with fallback
        const configuredPaths = state.localFolderPaths || [];
        const configuredPath = configuredPaths.length > 0 ? configuredPaths[0] : '';
        const saveLocation = configuredPath || '[CONFIGURE LOCAL DOCS FOLDER]';
        const saveAction = 'save the results';
        const protocolAction = 'proposing a research plan';

        let prompt = `Use the ${skillName} skill to ${taskType}`;
        if (customPrompt) {
            prompt += `:\n\n${customPrompt}\n\n`;
        } else {
            prompt += `.\n\n`;
        }

        prompt += `${depthLabel}: ${complexityLabels[complexity] || complexity}\n\n`;

        if (importEnabled) {
            if (!configuredPath) {
                prompt += `NOTE: Local docs folder not configured. Please configure it in the Local Docs tab before saving.\n\n`;
            } else {
                prompt += `IMPORTANT: After completing the research, ${saveAction} to ${saveLocation} using the write_to_file tool so I can review them later.\n\n`;
            }
        }

        prompt += `Please begin by ${protocolAction} for my approval, following the ${skillName} skill protocol.`;

        return prompt;
    }

    // =========================================================================
    // KANBAN PLANS UI LOGIC
    // =========================================================================
    let _kanbanPlansCache = [];
    let _kanbanSelectedPlan = null;
    let _kanbanPreviewRequestId = 0;
    
    const kanbanFilters = {
        column: '',
        workspaceRoot: '',
        project: '',
        repoScope: '',
        search: ''
    };

    const kanbanColumnFilter = document.getElementById('kanban-column-filter');
    const kanbanWorkspaceFilter = document.getElementById('kanban-workspace-filter');
    const kanbanProjectFilter = document.getElementById('kanban-project-filter');
    const kanbanRepoFilter = document.getElementById('kanban-repo-filter');
    const kanbanSearch = document.getElementById('kanban-search');
    const kanbanRefreshBtn = document.getElementById('kanban-refresh-btn');
    const kanbanListPane = document.getElementById('kanban-list-pane');
    const kanbanPreviewPane = document.getElementById('kanban-preview-pane');

    // Initial message in preview pane
    if (kanbanPreviewPane) {
        kanbanPreviewPane.innerHTML = '<div class="kanban-empty-state">Select a plan to preview</div>';
    }

    function renderKanbanPlans(plans, filters) {
        if (!kanbanListPane) return;
        
        let filtered = plans.filter(plan => {
            // Column filter
            if (filters.column && plan.column !== filters.column) return false;
            // Workspace filter (uses full workspaceRoot path internally)
            if (filters.workspaceRoot && plan.workspaceRoot !== filters.workspaceRoot) return false;
            // Project filter
            if (filters.project) {
                if (filters.project === '__none__') {
                    if (plan.project !== '') return false;
                } else if (plan.project !== filters.project) {
                    return false;
                }
            }
            // Repo scope filter
            if (filters.repoScope) {
                if (filters.repoScope === '__none__') {
                    if (plan.repoScope !== '') return false;
                } else if (plan.repoScope !== filters.repoScope) {
                    return false;
                }
            }
            // Search filter
            if (filters.search) {
                const searchLower = filters.search.toLowerCase();
                if (!plan.topic.toLowerCase().includes(searchLower)) return false;
            }
            return true;
        });

        // Already sorted by mtime descending from backend, but can double check
        filtered.sort((a, b) => b.mtime - a.mtime);

        if (filtered.length === 0) {
            kanbanListPane.innerHTML = '<div class="kanban-empty-state">No matching kanban plans</div>';
            return;
        }

        kanbanListPane.innerHTML = '';
        filtered.forEach(plan => {
            const itemDiv = document.createElement('div');
            itemDiv.className = 'kanban-plan-item';
            if (_kanbanSelectedPlan && _kanbanSelectedPlan.planId === plan.planId) {
                itemDiv.classList.add('selected');
            }

            const badgeClass = {
                'CREATED': 'kanban-col-created',
                'CODED': 'kanban-col-coded',
                'PLAN REVIEWED': 'kanban-col-reviewed',
                'COMPLETED': 'kanban-col-completed'
            }[plan.column] || 'kanban-col-created';

            const metaParts = [plan.workspaceLabel];
            if (plan.project) metaParts.push(plan.project);
            if (plan.repoScope) metaParts.push(plan.repoScope);

            const displayTime = plan.mtime > 0 ? formatRelativeTime(plan.mtime) : 'unknown';

            itemDiv.innerHTML = `
                <div style="width: 100%;">
                    <div style="display: flex; align-items: flex-start; justify-content: space-between; gap: 8px;">
                        <span class="kanban-plan-topic">${escapeHtml(plan.topic)}</span>
                        <span class="kanban-column-badge ${badgeClass}">${escapeHtml(plan.column)}</span>
                    </div>
                    <div class="kanban-plan-meta" style="margin-top: 4px;">
                        ${escapeHtml(metaParts.join(' · '))} · ${escapeHtml(displayTime)}
                    </div>
                    <div class="kanban-plan-actions">
                        <button class="kanban-action-open" data-path="${escapeHtml(plan.planFile)}">Open File</button>
                        <button class="kanban-action-context" data-path="${escapeHtml(plan.planFile)}">Set Context</button>
                    </div>
                </div>
            `;

            // Row selection
            itemDiv.addEventListener('click', (e) => {
                // If they clicked on buttons, don't trigger row click preview
                if (e.target.tagName === 'BUTTON') return;

                document.querySelectorAll('.kanban-plan-item').forEach(el => el.classList.remove('selected'));
                itemDiv.classList.add('selected');
                _kanbanSelectedPlan = plan;

                if (plan.planFile) {
                    if (kanbanPreviewPane) {
                        kanbanPreviewPane.innerHTML = '<div class="kanban-empty-state">Loading preview...</div>';
                    }
                    _kanbanPreviewRequestId++;
                    vscode.postMessage({
                        type: 'fetchKanbanPlanPreview',
                        filePath: plan.planFile,
                        requestId: _kanbanPreviewRequestId
                    });
                } else {
                    if (kanbanPreviewPane) {
                        kanbanPreviewPane.innerHTML = '<div class="kanban-empty-state">No plan file linked</div>';
                    }
                }
            });

            // Action buttons
            const btnOpen = itemDiv.querySelector('.kanban-action-open');
            const btnContext = itemDiv.querySelector('.kanban-action-context');

            if (btnOpen) {
                btnOpen.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const path = btnOpen.dataset.path;
                    if (path) {
                        vscode.postMessage({ type: 'openKanbanPlan', filePath: path });
                    }
                });
            }

            if (btnContext) {
                btnContext.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const path = btnContext.dataset.path;
                    if (path) {
                        btnContext.disabled = true;
                        btnContext.innerText = 'Setting...';
                        vscode.postMessage({ type: 'setKanbanPlanContext', filePath: path });
                    }
                });
            }

            kanbanListPane.appendChild(itemDiv);
        });
    }

    function populateKanbanFilters(plans) {
        if (!kanbanWorkspaceFilter || !kanbanProjectFilter || !kanbanRepoFilter) return;

        // Workspace filter
        const uniqueWorkspaces = [];
        const seenWorkspaces = new Set();
        plans.forEach(p => {
            if (p.workspaceRoot && !seenWorkspaces.has(p.workspaceRoot)) {
                seenWorkspaces.add(p.workspaceRoot);
                uniqueWorkspaces.push({ root: p.workspaceRoot, label: p.workspaceLabel });
            }
        });
        const currentWS = kanbanFilters.workspaceRoot;
        kanbanWorkspaceFilter.innerHTML = '<option value="">All Workspaces</option>';
        uniqueWorkspaces.forEach(ws => {
            const opt = document.createElement('option');
            opt.value = ws.root;
            opt.textContent = ws.label;
            if (ws.root === currentWS) opt.selected = true;
            kanbanWorkspaceFilter.appendChild(opt);
        });

        // Project filter
        const uniqueProjects = new Set();
        let hasEmptyProject = false;
        plans.forEach(p => {
            if (p.project) {
                uniqueProjects.add(p.project);
            } else {
                hasEmptyProject = true;
            }
        });
        const currentProj = kanbanFilters.project;
        kanbanProjectFilter.innerHTML = '<option value="">All Projects</option>';
        if (hasEmptyProject) {
            const optNone = document.createElement('option');
            optNone.value = '__none__';
            optNone.textContent = '(No Project)';
            if (currentProj === '__none__') optNone.selected = true;
            kanbanProjectFilter.appendChild(optNone);
        }
        Array.from(uniqueProjects).sort().forEach(proj => {
            const opt = document.createElement('option');
            opt.value = proj;
            opt.textContent = proj;
            if (proj === currentProj) opt.selected = true;
            kanbanProjectFilter.appendChild(opt);
        });

        // Repo filter
        const uniqueRepos = new Set();
        let hasEmptyRepo = false;
        plans.forEach(p => {
            if (p.repoScope) {
                uniqueRepos.add(p.repoScope);
            } else {
                hasEmptyRepo = true;
            }
        });
        const currentRepo = kanbanFilters.repoScope;
        kanbanRepoFilter.innerHTML = '<option value="">All Repos</option>';
        if (hasEmptyRepo) {
            const optNone = document.createElement('option');
            optNone.value = '__none__';
            optNone.textContent = '(No Repo Scope)';
            if (currentRepo === '__none__') optNone.selected = true;
            kanbanRepoFilter.appendChild(optNone);
        }
        Array.from(uniqueRepos).sort().forEach(repo => {
            const opt = document.createElement('option');
            opt.value = repo;
            opt.textContent = repo;
            if (repo === currentRepo) opt.selected = true;
            kanbanRepoFilter.appendChild(opt);
        });
    }

    function handleKanbanPlansReady(msg) {
        if (msg.error) {
            if (kanbanListPane) {
                kanbanListPane.innerHTML = `<div class="kanban-empty-state" style="color: var(--vscode-errorForeground, #ff6b6b);">Error loading plans: ${escapeHtml(msg.error)}</div>`;
            }
            return;
        }

        _kanbanPlansCache = msg.plans || [];
        populateKanbanFilters(_kanbanPlansCache);
        renderKanbanPlans(_kanbanPlansCache, kanbanFilters);
    }

    function handleKanbanPlanPreviewReady(msg) {
        if (msg.requestId !== _kanbanPreviewRequestId) return;
        if (!kanbanPreviewPane) return;

        if (msg.error) {
            kanbanPreviewPane.innerHTML = `<div class="kanban-empty-state" style="color: var(--vscode-errorForeground, #ff6b6b);">Error reading file: ${escapeHtml(msg.error)}</div>`;
            return;
        }

        if (msg.content) {
            kanbanPreviewPane.innerHTML = renderMarkdown(msg.content);
        } else {
            kanbanPreviewPane.innerHTML = '<div class="kanban-empty-state">Plan file is empty</div>';
        }
    }

    function handleKanbanContextSet(msg) {
        // Re-enable "Set Context" button
        if (kanbanListPane) {
            kanbanListPane.querySelectorAll('.kanban-action-context').forEach(btn => {
                btn.disabled = false;
                btn.innerText = 'Set Context';
            });
        }
        
        if (!msg.success) {
            alert('Failed to set active context: ' + (msg.error || 'Unknown error'));
        }
    }

    function handleKanbanPlanOpenResult(msg) {
        if (!msg.success) {
            alert('Failed to open plan file: ' + (msg.error || 'Unknown error'));
        }
    }

    // Helper functions
    function escapeHtml(str) {
        if (!str) return '';
        return str
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    function formatRelativeTime(mtime) {
        const diff = Date.now() - mtime;
        const secs = Math.floor(diff / 1000);
        if (secs < 60) return 'just now';
        const mins = Math.floor(secs / 60);
        if (mins < 60) return `${mins}m ago`;
        const hours = Math.floor(mins / 60);
        if (hours < 24) return `${hours}h ago`;
        const days = Math.floor(hours / 24);
        return `${days}d ago`;
    }

    // Event listeners
    if (kanbanColumnFilter) {
        kanbanColumnFilter.addEventListener('change', () => {
            kanbanFilters.column = kanbanColumnFilter.value;
            renderKanbanPlans(_kanbanPlansCache, kanbanFilters);
        });
    }

    if (kanbanWorkspaceFilter) {
        kanbanWorkspaceFilter.addEventListener('change', () => {
            kanbanFilters.workspaceRoot = kanbanWorkspaceFilter.value;
            renderKanbanPlans(_kanbanPlansCache, kanbanFilters);
        });
    }

    if (kanbanProjectFilter) {
        kanbanProjectFilter.addEventListener('change', () => {
            kanbanFilters.project = kanbanProjectFilter.value;
            renderKanbanPlans(_kanbanPlansCache, kanbanFilters);
        });
    }

    if (kanbanRepoFilter) {
        kanbanRepoFilter.addEventListener('change', () => {
            kanbanFilters.repoScope = kanbanRepoFilter.value;
            renderKanbanPlans(_kanbanPlansCache, kanbanFilters);
        });
    }

    let searchDebounceTimeout;
    if (kanbanSearch) {
        kanbanSearch.addEventListener('input', () => {
            clearTimeout(searchDebounceTimeout);
            searchDebounceTimeout = setTimeout(() => {
                kanbanFilters.search = kanbanSearch.value;
                renderKanbanPlans(_kanbanPlansCache, kanbanFilters);
            }, 200);
        });
    }

    if (kanbanRefreshBtn) {
        kanbanRefreshBtn.addEventListener('click', () => {
            vscode.postMessage({ type: 'fetchKanbanPlans', requestId: Date.now() });
        });
    }

    // Initialize
    console.log('[PlanningPanel Webview] Initializing, sending fetchRoots');
    const agToggle = document.getElementById('antigravity-toggle');
    if (agToggle) {
        agToggle.addEventListener('change', () => {
            vscode.postMessage({ type: 'toggleAntigravityBrain', enabled: agToggle.checked });
        });
    }
    vscode.postMessage({ type: 'fetchRoots' });
})();