(function() {
    const vscode = acquireVsCodeApi();

    // Restore persisted state
    const persistedState = vscode.getState() || {};

    // State object (must be declared before use)
    const state = {
        lastResearchFolder: persistedState.lastResearchFolder || null,
        switchboardTheme: 'afterburner',  // Track active Switchboard visual theme for cyber-theme toggle
        activeSource: null,
        activeDocId: null,
        activeDocName: null,
        activeDocContent: null,
        activeDocFilePath: null,
        activeFileType: null,  // 'json' | 'yaml' | 'markdown' | 'css' | 'xml' | 'text' | 'image' | null
        activeContainers: new Map(),
        importedDocs: new Map(), // slugPrefix -> { sourceId, docId, docName }
        previewRequestId: 0,
        docPagesRequestId: 0,
        selectedEl: null,
        filterRequestIds: {},
        researchMode: persistedState.researchMode || 'web',
        localFolderPaths: [],
        htmlFolderPaths: [],
        designFolderPaths: persistedState.designFolderPaths || [],
        htmlPreviewCollapsed: persistedState.htmlPreviewCollapsed || false,
        designPreviewCollapsed: persistedState.designPreviewCollapsed || false,
        analystAvailable: false,
        docsListCollapsed: persistedState.docsListCollapsed || false,
        editMode: { local: false, kanban: false, design: false },
        editOriginalContent: { local: null, kanban: null, design: null },
        dirtyFlags: { local: false, kanban: false, design: false },
        externalChangePending: { local: false, kanban: false, design: false },
        reviewMode: { kanban: false },
        kanbanReviewSelectedText: '',
        localWorkspaceRootFilter: '',
        htmlWorkspaceRootFilter: '',
        designWorkspaceRootFilter: '',
        activeDesignDocEnabled: false,
        activeDesignDocSourceId: null,
        activeDesignDocId: null,
        _lastLocalDocsMsg: null,
        _lastHtmlDocsMsg: null,
        _lastDesignDocsMsg: null
    };

    // Tickets tab state
    let ticketsInitialized = false;
    let ticketsLoadedOnce = false;
    let lastIntegrationProvider = null;
    let currentWorkspaceRoot = '';

    // Linear state
    let linearProjectIssues = [];
    let selectedLinearIssue = null;
    let linearProjectStatus = 'idle';
    let linearProjectMessage = '';
    let linearProjectSearchValue = '';
    let linearProjectStateFilterValue = '';
    let linearProjectPickerValue = '';
    let _restoredLinearProjectPickerValue = '';
    let linearAvailableProjects = [];
    let linearProjectLoadedOnce = false;
    let linearProjectLoading = false;
    let linearTaskDetailsTimeoutId = null;

    // ClickUp state
    let clickUpProjectIssues = [];
    let selectedClickUpIssue = null;
    let clickUpProjectStatus = 'idle';
    let clickUpProjectMessage = '';
    let clickUpAvailableSpaces = [];
    let clickUpAvailableFolders = [];
    let clickUpAvailableListsInFolder = [];
    let clickUpAvailableDirectLists = [];
    let clickUpSelectedSpaceId = '';
    let clickUpSelectedFolderId = '';
    let clickUpSelectedListId = '';
    let clickUpProjectSearchValue = '';
    let clickUpProjectStatusFilterValue = '';
    let clickUpCurrentPage = 0;
    let clickUpProjectHasMore = false;
    let clickUpSpacesLoadedOnce = false;
    let clickUpProjectLoading = false;
    let clickUpHierarchyLoading = false;
    let clickUpImportPending = false;
    let pendingClickUpDetailIssueId = '';

    // Cached HTML strings for DOM guard comparisons
    let _lastTicketsStateFilterHtml = '';
    let _lastTicketsProjectPickerHtml = '';
    let _lastTicketsIssuesContainerHtml = '';
    let _lastTicketsDetailDescriptionHtml = '';
    let _lastTicketsDetailSubtasksHtml = '';
    let _lastTicketsDetailCommentsHtml = '';
    let _lastTicketsDetailAttachmentsHtml = '';
    let _lastTicketsHierarchyHtml = '';
    let _lastTicketsClickUpIssuesContainerHtml = '';
    let _lastTicketsClickUpDetailDescriptionHtml = '';
    let _lastTicketsClickUpDetailSubtasksHtml = '';
    let _lastTicketsClickUpDetailCommentsHtml = '';
    let _lastTicketsClickUpDetailAttachmentsHtml = '';
    let _lastTicketsClickUpStateFilterHtml = '';

    // Helper functions for tickets tab
    function escapeHtml(value) {
        return String(value || '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function escapeAttr(value) {
        return String(value || '').replace(/"/g, '&quot;');
    }

    function getTicketsTabElements() {
        return {
            listView: document.getElementById('tickets-issues-container')?.parentElement,
            taskView: document.querySelector('.tickets-task-view'),
            searchInput: document.getElementById('tickets-search'),
            projectPicker: document.getElementById('tickets-project-picker'),
            stateFilter: document.getElementById('tickets-state-filter'),
            clickUpStatusFilter: document.getElementById('tickets-status-filter'),
            refreshButton: document.getElementById('tickets-refresh'),
            emptyState: document.getElementById('tickets-empty-state'),
            issuesContainer: document.getElementById('tickets-issues-container'),
            loadMoreButton: document.getElementById('tickets-load-more'),
            detailTitle: document.getElementById('tickets-detail-title'),
            detailStatus: document.getElementById('tickets-detail-status'),
            detailAssignee: document.getElementById('tickets-detail-assignee'),
            detailDescription: document.getElementById('tickets-detail-description'),
            detailSubtasks: document.getElementById('tickets-detail-subtasks'),
            detailComments: document.getElementById('tickets-detail-comments'),
            detailAttachments: document.getElementById('tickets-detail-attachments'),
            detailImportButton: document.getElementById('tickets-detail-import'),
            detailRefineButton: document.getElementById('tickets-detail-refine'),
            detailAskAgentButton: document.getElementById('tickets-detail-ask-agent'),
            backToListButton: document.getElementById('tickets-back-to-list'),
            backToParentButton: document.getElementById('tickets-back-to-parent'),
            hierarchyNav: document.getElementById('tickets-hierarchy-nav')
        };
    }

    function isTicketsTabActive() {
        return document.querySelector('.research-tab-btn.active')?.dataset.tab === 'tickets';
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

    document.getElementById('local-workspace-filter')?.addEventListener('change', (e) => {
        state.localWorkspaceRootFilter = e.target.value;
        handleLocalDocsReady(state._lastLocalDocsMsg || {});
    });
    document.getElementById('html-workspace-filter')?.addEventListener('change', (e) => {
        state.htmlWorkspaceRootFilter = e.target.value;
        handleHtmlDocsReady(state._lastHtmlDocsMsg || {});
    });
    document.getElementById('design-workspace-filter')?.addEventListener('change', (e) => {
        state.designWorkspaceRootFilter = e.target.value;
        const msg = state._lastDesignDocsMsg || {};
        state.designFolderPaths = msg.folderPaths || [];
        const filteredNodes = state.designWorkspaceRootFilter
            ? (msg.nodes || []).filter(n => n.metadata?.root === state.designWorkspaceRootFilter)
            : (msg.nodes || []);
        renderDesignDocs({
            sourceId: msg.sourceId || 'design-folder',
            nodes: filteredNodes,
            folderPaths: msg.folderPaths || []
        });
    });

    function getActiveTabName() {
        const activeBtn = document.querySelector('.research-tab-btn.active');
        return activeBtn ? activeBtn.dataset.tab : 'local';
    }

    function applySidebarState(tabName, collapsed) {
        const tabContent = document.getElementById(`${tabName}-content`);
        if (!tabContent) return;
        const contentRow = tabContent.querySelector('.content-row');
        const toggleBtn = tabContent.querySelector('.sidebar-toggle-btn');
        if (contentRow) {
            contentRow.classList.toggle('collapsed', collapsed);
        }
        if (toggleBtn) {
            toggleBtn.textContent = collapsed ? '»' : '«';
        }
    }     function toggleSidebarCollapsed() {
        const activeTab = getActiveTabName();
        if (activeTab === 'html-preview') {
            state.htmlPreviewCollapsed = !state.htmlPreviewCollapsed;
            applySidebarState('html-preview', state.htmlPreviewCollapsed);
        } else if (activeTab === 'design') {
            state.designPreviewCollapsed = !state.designPreviewCollapsed;
            applySidebarState('design', state.designPreviewCollapsed);
        } else {
            state.docsListCollapsed = !state.docsListCollapsed;
            // Apply to local and research tabs (they share the same collapsed state)
            applySidebarState('local', state.docsListCollapsed);
            applySidebarState('research', state.docsListCollapsed);
            applySidebarState('online', state.docsListCollapsed);
        }

        // Persist state
        const currentPersisted = vscode.getState() || {};
        vscode.setState({
            ...currentPersisted,
            docsListCollapsed: state.docsListCollapsed,
            htmlPreviewCollapsed: state.htmlPreviewCollapsed,
            designPreviewCollapsed: state.designPreviewCollapsed
        });
    }

    // Initialize sidebar state
    applySidebarState('local', state.docsListCollapsed);
    applySidebarState('research', state.docsListCollapsed);
    applySidebarState('online', state.docsListCollapsed);
    applySidebarState('design', state.designPreviewCollapsed);
    applySidebarState('html-preview', state.htmlPreviewCollapsed);

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

            // Check dirty flags
            if (state.dirtyFlags.local && tabName !== 'local') {
                if (!confirm('You have unsaved changes in Local Docs. Discard them?')) {
                    return;
                }
                exitEditMode('local', true);
            }
            if (state.dirtyFlags.kanban && tabName !== 'kanban') {
                if (!confirm('You have unsaved changes in Kanban Plans. Discard them?')) {
                    return;
                }
                exitEditMode('kanban', true);
            }
            if (state.dirtyFlags.design && tabName !== 'design') {
                if (!confirm('You have unsaved changes in Design System. Discard them?')) {
                    return;
                }
                exitEditMode('design', true);
            }

            // If in edit mode but not dirty, auto-exit to clear editor state cleanly
            if (state.editMode.local && tabName !== 'local') {
                exitEditMode('local', true);
            }
            if (state.editMode.kanban && tabName !== 'kanban') {
                exitEditMode('kanban', true);
            }
            if (state.editMode.design && tabName !== 'design') {
                exitEditMode('design', true);
            }
            if (state.reviewMode.kanban && tabName !== 'kanban') {
                exitReviewMode('kanban', true);
            }

            tabButtons.forEach(b => b.classList.remove('active'));
            tabContents.forEach(c => c.classList.remove('active'));

            btn.classList.add('active');
            document.getElementById(`${tabName}-content`).classList.add('active');

            // Apply correct sidebar state for the newly active tab
            if (tabName === 'html-preview') {
                applySidebarState('html-preview', state.htmlPreviewCollapsed);
            } else if (tabName === 'design') {
                applySidebarState('design', state.designPreviewCollapsed);
            } else if (tabName === 'local' || tabName === 'research' || tabName === 'online') {
                applySidebarState(tabName, state.docsListCollapsed);
            }

            if (tabName === 'kanban') {
                vscode.postMessage({ type: 'fetchKanbanPlans', requestId: Date.now() });
            }

            // Tickets tab initialization
            if (tabName === 'tickets') {
                if (!ticketsInitialized) {
                    initTicketsTab();
                    ticketsInitialized = true;
                }
                restoreTicketsState();
                // Trigger initial load if not yet loaded
                if (lastIntegrationProvider && !ticketsLoadedOnce) {
                    if (lastIntegrationProvider === 'clickup') loadClickUpSpaces();
                    else loadLinearProject();
                }
            } else {
                // Save tickets state when switching away
                if (ticketsInitialized) {
                    saveTicketsState();
                }
            }
        });
    });



    // Clipboard Import logic

    const importResearchDocClipboardBtn = document.getElementById('btn-import-research-doc-clipboard');

    const handleResearchImportClick = () => {
        const docTitleInput = document.getElementById('research-doc-title');
        const docTitle = docTitleInput ? docTitleInput.value.trim() : '';

        if (importResearchDocClipboardBtn) {
            importResearchDocClipboardBtn.disabled = true;
            importResearchDocClipboardBtn.innerText = 'IMPORTING...';
        }
        
        const statusEl = document.getElementById('research-import-status');
        if (statusEl) {
            statusEl.style.color = '';
            statusEl.textContent = 'Import in progress...';
        }
        const folderSelect = document.getElementById('research-destination-folder');
        const folderPath = folderSelect ? folderSelect.value : undefined;

        vscode.postMessage({
            type: 'importResearchDoc',
            docTitle: docTitle || undefined,
            folderPath: folderPath || undefined
        });
    };

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

    // Research Tab: Draft with Analyst Agent Button
    const draftWithAnalystBtn = document.getElementById('btn-draft-with-analyst');
    if (draftWithAnalystBtn) {
        draftWithAnalystBtn.addEventListener('click', () => {
            const topic = document.getElementById('research-prompt-input')?.value.trim() || '';

            vscode.postMessage({
                type: 'draftResearchPrompt',
                topic: topic,
                context: '',
                depth: 'deep'
            });
            draftWithAnalystBtn.innerText = 'SENT';
            setTimeout(() => {
                if (draftWithAnalystBtn) draftWithAnalystBtn.innerText = 'DRAFT WITH ANALYST AGENT';
            }, 2000);
        });
    }

    const manageResearchFoldersBtn = document.getElementById('btn-manage-research-folders');
    if (manageResearchFoldersBtn) {
        manageResearchFoldersBtn.addEventListener('click', openFoldersModal);
    }

    const researchFolderSelect = document.getElementById('research-destination-folder');
    if (researchFolderSelect) {
        researchFolderSelect.addEventListener('change', () => {
            state.lastResearchFolder = researchFolderSelect.value || null;
            const currentPersisted = vscode.getState() || {};
            vscode.setState({ ...currentPersisted, lastResearchFolder: state.lastResearchFolder });
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
        'local-folder': 'Cowork/local',
        'research-clipboard': 'Research'
    };

    // Saved browse filter containers from config (restored after containers load)
    let _savedBrowseFilterContainers = {};

    const treePane = document.getElementById('tree-pane');
    const treePaneOnline = document.getElementById('tree-pane-online');
    const markdownPreview = document.getElementById('markdown-preview');
    const markdownPreviewOnline = document.getElementById('markdown-preview-online');
    const btnAppendToPromptsOnline = document.getElementById('btn-append-to-prompts-online');
    const btnSetActiveContextLocal = document.getElementById('btn-set-active-context-local');
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

    // Inject <base> tag for relative asset resolution in srcdoc iframes
    function injectBaseTag(html, baseUri) {
        if (!html || !baseUri) return html;
        if (html.includes('<base ')) return html;  // Don't duplicate
        
        const baseTag = `<base href="${escapeAttr(baseUri)}">`;
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
        return baseTag + html;  // Fallback: prepend for fragment HTML
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

        // Normalize line endings to prevent layout differences
        let processed = markdown.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

        // Escape HTML first
        processed = processed
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');

        // Temporarily protect escaped backticks to prevent them from breaking the inline code block parser
        processed = processed.replace(/\\`/g, '__ESCAPED_BACKTICK__');

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

        // Group consecutive blockquote lines
        // NOTE(escape-order coupling): This regex matches '&gt;' because HTML escaping
        // runs first (lines 388-391). If the escape order ever changes, this regex
        // must be updated accordingly or blockquote rendering will silently break.
        const groupedLines = [];
        let inBlockquote = false;
        let blockquoteLines = [];
        for (const line of resultLines) {
            const bqMatch = line.match(/^&gt;\s?(.*)$/);
            if (bqMatch) {
                if (!inBlockquote) { inBlockquote = true; blockquoteLines = []; }
                blockquoteLines.push(bqMatch[1]);
            } else {
                if (inBlockquote) {
                    groupedLines.push({ type: 'blockquote', lines: blockquoteLines });
                    inBlockquote = false;
                    blockquoteLines = [];
                }
                groupedLines.push(line);
            }
        }
        if (inBlockquote) { groupedLines.push({ type: 'blockquote', lines: blockquoteLines }); }

        const processedLines = [];
        for (const item of groupedLines) {
            if (typeof item === 'string') {
                processedLines.push(item);
            } else if (item && item.type === 'blockquote') {
                const content = item.lines.join('\n');
                const alertMatch = content.match(/^\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*([\s\S]*)$/i);
                if (alertMatch) {
                    const type = alertMatch[1].toLowerCase();
                    const title = alertMatch[1].charAt(0).toUpperCase() + alertMatch[1].slice(1).toLowerCase();
                    const body = alertMatch[2].trim();
                    processedLines.push(`HTML_ALERT_START_${type}_${title}HTML_ALERT_CONTENT${body}HTML_ALERT_END`);
                } else {
                    processedLines.push(`HTML_BLOCKQUOTE_START${content}HTML_BLOCKQUOTE_END`);
                }
            }
        }

        processed = processedLines.join('\n');

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
            .replace(/^\* (.+)$/gm, '<li>$1</li>')
            .replace(/(<li>.*<\/li>\n?)+/g, '<ul>$&</ul>')
            .replace(/^\d+\. (.+)$/gm, '<li>$1</li>')
            .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, text, url) => {
                const safeUrl = escapeAttr(sanitizeUrl(url));
                return `<a href="${safeUrl}">${text}</a>`;
            })
            .replace(/\\([\\`*_{}[\]()#+\-.!|])/g, '$1');

        // Protect <pre> blocks from newline-to-<br> conversion.
        // Code blocks must preserve literal newlines for correct rendering;
        // non-code content converts single newlines to <br> (GFM hard_wrap).
        const parts = html.split(/(<pre><code>[\s\S]*?<\/code><\/pre>)/);
        html = parts.map((part, i) => {
            if (i % 2 === 1) return part; // pre block — preserve newlines
            return part.replace(/\n\n+/g, '</p><p>').replace(/\n/g, '<br>');
        }).join('');

        // Clean up spurious <br> between list items inside <ul>/<ol>.
        // The list-wrapping regex (above) captures \n between <li> items,
        // which the <br> conversion turns into visible extra spacing.
        html = html.replace(/<\/li><br><li>/g, '</li><li>');

        html = `<p>${html}</p>`;
        html = html.replace(/<p>\s*<\/p>/g, '');

        // Replace placeholders
        html = html.replace(/HTML_ALERT_START_([a-z]+)_([A-Za-z]+)HTML_ALERT_CONTENT([\s\S]*?)HTML_ALERT_END/g, (_, type, title, body) => {
            return `</p><div class="markdown-alert alert-${type}"><div class="markdown-alert-title">${title}</div><div>${body}</div></div><p>`;
        });
        html = html.replace(/HTML_BLOCKQUOTE_START([\s\S]*?)HTML_BLOCKQUOTE_END/g, (_, body) => {
            return `</p><blockquote>${body}</blockquote><p>`;
        });
        html = html.replace(/<p>\s*<\/p>/g, '');

        // Restore escaped backticks
        // If it is inside <code> or <pre> tags, restore to \\` (preserving backslash)
        // If it is outside, restore to ` (removing backslash)
        let inCode = false;
        html = html.replace(/(<code\b[^>]*>|<\/code>|<pre\b[^>]*>|<\/pre>|__ESCAPED_BACKTICK__)/g, (match) => {
            if (match.startsWith('<code') || match.startsWith('<pre')) {
                inCode = true;
                return match;
            } else if (match.startsWith('</code') || match.startsWith('</pre')) {
                inCode = false;
                return match;
            } else if (match === '__ESCAPED_BACKTICK__') {
                return inCode ? '\\`' : '`';
            }
            return match;
        });

        return html;
    }

    function renderJsonTree(data, depth, maxDepth, seen) {
        depth = depth || 0;
        maxDepth = maxDepth || 2;
        seen = seen || new WeakSet();

        // Primitives
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

        // Circular reference guard — only track objects/arrays
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
        summary.className = 'json-bracket';
        const countLabel = isArray
            ? `${data.length} items`
            : `${Object.keys(data).length} keys`;
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

    function renderDocCard({ title, subtitle, sourceId, nodeId, nodeMetadata, actions, isSelected, clickHandler, deleteHandler, syncHandler, extraClass }) {
        const wrapper = document.createElement('div');
        wrapper.className = 'tree-node' + (extraClass ? ' ' + extraClass : '');
        if (isSelected) {
            wrapper.classList.add('selected');
        }
        wrapper.dataset.sourceId = sourceId || '';
        wrapper.dataset.nodeId = nodeId || '';
        wrapper.dataset.docId = nodeId || '';
        wrapper.dataset.kind = 'document';
        wrapper.dataset.name = title;
        if (nodeMetadata) {
            if (nodeMetadata.root) {
                wrapper.dataset.root = nodeMetadata.root;
            }
            if (nodeMetadata.sourceFolder) {
                wrapper.dataset.sourceFolder = nodeMetadata.sourceFolder;
            }
            if (nodeMetadata.absolutePath) {
                wrapper.dataset.absolutePath = nodeMetadata.absolutePath;
            }
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

                if (action === 'Link Doc' || action === 'Delete') {
                    // Icon button
                    btn.className = 'card-icon-btn' + (action === 'Delete' ? ' card-delete-btn' : '');
                    btn.textContent = action === 'Link Doc' ? '🔗' : '×';
                    btn.title = action === 'Link Doc' ? 'Copy validated document path' : 'Delete';
                    btn.setAttribute('aria-label', action === 'Link Doc' ? 'Link to document' : 'Delete document');
                } else {
                    // Text button (Set Context, Import, Sync)
                    btn.className = 'planning-card-btn';
                    btn.textContent = action;
                }

                btn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    if (action === 'Set Context') {
                        vscode.postMessage({
                            type: 'appendToPlannerPrompt',
                            sourceId: sourceId,
                            docId: nodeId,
                            docName: title,
                            sourceFolder: nodeMetadata ? nodeMetadata.sourceFolder : undefined
                        });
                    } else if (action === 'Link Doc') {
                        vscode.postMessage({
                            type: 'linkToDocument',
                            sourceId: sourceId,
                            docId: nodeId,
                            docName: title,
                            sourceFolder: nodeMetadata ? nodeMetadata.sourceFolder : undefined
                        });
                    } else if (action === 'Delete') {
                        if (deleteHandler) {
                            deleteHandler(btn);
                        }
                    } else if (action === 'Sync') {
                        if (syncHandler) {
                            syncHandler(btn);
                        }
                    } else if (action === 'Import') {
                        vscode.postMessage({
                            type: 'importFullDoc',
                            sourceId: sourceId,
                            docId: nodeId,
                            docName: title
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

    function renderNode(node, sourceId, depth = 0) {
        const container = document.createElement('div');
        container.className = 'tree-node-container';
        container.style.marginLeft = `${depth * 16}px`;

        const childContainer = document.createElement('div');
        childContainer.className = 'tree-children';
        childContainer.style.display = 'none';

        if (node.kind === 'folder' || node.isDirectory) {
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

            const icon = document.createElement('span');
            icon.className = 'icon';
            icon.textContent = '▶';

            const label = document.createElement('span');
            label.className = 'label';
            label.textContent = node.name;

            wrapper.appendChild(icon);
            wrapper.appendChild(label);

            if (node.hasChildren) {
                wrapper.addEventListener('click', () => {
                    const isExpanded = childContainer.style.display !== 'none';
                    icon.textContent = isExpanded ? '▶' : '▼';
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
            container.appendChild(wrapper);
            container.appendChild(childContainer);
        } else {
            let actions = [];
            if (sourceId === 'local-folder') {
                actions = ['Import', 'Link Doc', 'Delete'];
            } else if (sourceId === 'design-folder') {
                actions = ['Set Context', 'Link Doc'];
            } else if (sourceId === 'html-folder') {
                actions = ['Link Doc'];
            } else {
                actions = ['Import', 'Link Doc'];
            }

            const cardWrapper = renderDocCard({
                title: node.title || node.name,
                subtitle: (node.title && node.title !== node.name) ? node.name : undefined,
                sourceId,
                nodeId: node.id,
                nodeMetadata: node.metadata,
                actions,
                isSelected: state.activeSource === sourceId && state.activeDocId === node.id,
                clickHandler: (wrapper) => {
                    loadDocumentPreview(sourceId, node.id, node.name);
                },
                deleteHandler: (btn) => {
                    btn.disabled = true;
                    btn.textContent = '…';
                    vscode.postMessage({
                        type: 'deleteLocalDoc',
                        docId: node.id,
                        docName: node.name,
                        workspaceRoot: node.metadata ? node.metadata.root : undefined,
                        sourceFolder: node.metadata ? node.metadata.sourceFolder : undefined
                    });
                }
            });
            container.appendChild(cardWrapper);
        }

        return { wrapper: container, childContainer };
    }

    function loadDocumentPreview(sourceId, docId, docName) {
        if (sourceId === 'html-folder') {
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
            updateLocalActiveContextButtonState();

            const statusHtml = document.getElementById('status-html');
            if (statusHtml) {
                statusHtml.textContent = 'Loading...';
            }
            const initialState = document.getElementById('html-initial-state');
            const loadingState = document.getElementById('html-loading-state');
            const previewFrame = document.getElementById('html-preview-frame');
            const imageContainer = document.getElementById('image-preview-container');
            if (initialState) initialState.style.display = 'none';
            if (loadingState) loadingState.style.display = 'flex';
            if (previewFrame) previewFrame.style.display = 'none';
            if (imageContainer) imageContainer.style.display = 'none';

            vscode.postMessage({
                type: 'fetchPreview',
                sourceId,
                docId,
                requestId: state.previewRequestId,
                sourceFolder
            });
            return;
        }
        if (sourceId === 'design-folder') {
            if (state.dirtyFlags.design) {
                if (!confirm('You have unsaved changes in Design System. Discard them?')) {
                    return;
                }
                exitEditMode('design', true);
            }

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
            updateLocalActiveContextButtonState();

            const statusDesign = document.getElementById('status-design');
            if (statusDesign) {
                statusDesign.textContent = 'Loading...';
            }
            const previewDesign = document.getElementById('markdown-preview-design');
            if (previewDesign) {
                previewDesign.innerHTML = '<div class="empty-state">Loading preview...</div>';
                previewDesign.style.display = 'block';
            }
            const imageContainerDesign = document.getElementById('image-preview-container-design');
            if (imageContainerDesign) {
                imageContainerDesign.style.display = 'none';
            }

            const btnSetDesign = document.getElementById('btn-set-active-context-design');
            if (btnSetDesign) btnSetDesign.disabled = false;
            const btnLinkDesign = document.getElementById('btn-link-to-doc-design');
            if (btnLinkDesign) btnLinkDesign.disabled = false;
            const btnEditDesign = document.getElementById('btn-edit-design');
            if (btnEditDesign) {
                const ext = docId.substring(docId.lastIndexOf('.')).toLowerCase();
                const isImage = ['.png', '.jpg', '.jpeg', '.gif', '.svg'].includes(ext);
                btnEditDesign.disabled = isImage;
            }

            vscode.postMessage({
                type: 'fetchPreview',
                sourceId,
                docId,
                requestId: state.previewRequestId,
                sourceFolder
            });
            return;
        }
        if (state.dirtyFlags.local) {
            if (!confirm('You have unsaved changes in Local Docs. Discard them?')) {
                return;
            }
            exitEditMode('local', true);
        }

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
        updateLocalActiveContextButtonState();

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

    // DEPRECATED: Inline folder list removed; use renderFolderListModal() instead.
    // Kept for safety — returns early if target element not found.
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

    function handleHtmlDocsReady(msg) {
        console.log('[PlanningPanel Webview] handleHtmlDocsReady called:', msg);
        state._lastHtmlDocsMsg = msg;
        state.htmlFolderPaths = msg.folderPaths || [];
        populateWorkspaceDropdown('html-workspace-filter', msg.workspaceItems || [], state.htmlWorkspaceRootFilter);
        const filteredNodes = state.htmlWorkspaceRootFilter
            ? (msg.nodes || []).filter(n => n.metadata?.root === state.htmlWorkspaceRootFilter)
            : (msg.nodes || []);
        renderHtmlDocs({
            sourceId: msg.sourceId || 'html-folder',
            nodes: filteredNodes,
            folderPaths: msg.folderPaths || [],
            error: msg.error
        });
        renderHtmlFolderListModal();
    }

    function renderHtmlFolderListModal() {
        const folderListModal = document.getElementById('html-folder-list-modal');
        if (!folderListModal) return;
        folderListModal.innerHTML = '';

        const folderPaths = state.htmlFolderPaths || [];

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
                vscode.postMessage({ type: 'removeHtmlFolder', folderPath: path });
            });

            row.appendChild(pathSpan);
            row.appendChild(removeBtn);
            folderListModal.appendChild(row);
        });
    }

    function renderHtmlDocs(rootEntry) {
        const { sourceId, nodes, folderPaths } = rootEntry;
        const treePaneHtml = document.getElementById('tree-pane-html');
        if (!treePaneHtml) return;

        treePaneHtml.innerHTML = '';

        // Re-add sidebar toggle
        const toggleRow = document.createElement('div');
        toggleRow.className = 'sidebar-toggle-row';

        const foldersBtn = document.createElement('button');
        foldersBtn.className = 'sidebar-folders-btn';
        foldersBtn.title = 'Manage Folders';
        foldersBtn.textContent = 'Manage Folders';
        foldersBtn.addEventListener('click', () => {
            const modal = document.getElementById('folder-modal-html');
            if (modal) {
                modal.style.display = 'flex';
                renderHtmlFolderListModal();
                vscode.postMessage({ type: 'listHtmlFolders' });
            }
        });

        const toggleBtn = document.createElement('button');
        toggleBtn.className = 'sidebar-toggle-btn';
        toggleBtn.title = 'Toggle sidebar';
        toggleBtn.textContent = state.htmlPreviewCollapsed ? '»' : '«';
        toggleBtn.addEventListener('click', toggleSidebarCollapsed);

        toggleRow.appendChild(foldersBtn);
        toggleRow.appendChild(toggleBtn);
        treePaneHtml.appendChild(toggleRow);

        const docList = document.createElement('div');
        docList.className = 'source-doc-list';
        docList.dataset.sourceId = sourceId;
        treePaneHtml.appendChild(docList);

        if (!nodes || nodes.length === 0) {
            docList.innerHTML = '<div class="empty-state" style="padding: 12px; font-size: 12px; color: var(--text-secondary);">No HTML preview folders configured or folders are empty. Click Folders to get started.</div>';
            return;
        }

        const folderNodes = (nodes || []).filter(n => n.kind === 'folder');
        const docNodes = (nodes || []).filter(n => n.kind === 'document');

        // Group nodes by sourceFolder
        const docsBySourceFolder = new Map();
        const foldersBySourceFolder = new Map();

        docNodes.forEach(d => {
            const sourceFolder = d.metadata?.sourceFolder;
            if (!sourceFolder) return;
            if (!docsBySourceFolder.has(sourceFolder)) {
                docsBySourceFolder.set(sourceFolder, []);
            }
            docsBySourceFolder.get(sourceFolder).push(d);
        });

        folderNodes.forEach(f => {
            const sourceFolder = f.metadata?.sourceFolder;
            if (!sourceFolder) return;
            if (!foldersBySourceFolder.has(sourceFolder)) {
                foldersBySourceFolder.set(sourceFolder, []);
            }
            foldersBySourceFolder.get(sourceFolder).push(f);
        });

        const sourceFolders = [...new Set([
            ...(folderPaths || []),
            ...docsBySourceFolder.keys()
        ])];

        sourceFolders.forEach(sourceFolder => {
            const folderDocs = docsBySourceFolder.get(sourceFolder) || [];
            const sourceFolderNodes = foldersBySourceFolder.get(sourceFolder) || [];

            if (folderDocs.length === 0 && sourceFolderNodes.length === 0) return;

            const sourceHeader = document.createElement('div');
            sourceHeader.className = 'folder-subheader source-folder-header';
            const folderName = sourceFolder.split(/[\\/]/).filter(Boolean).pop() || sourceFolder;
            sourceHeader.textContent = folderName;
            sourceHeader.title = sourceFolder;
            docList.appendChild(sourceHeader);

            const folderNameMap = new Map();
            sourceFolderNodes.forEach(f => folderNameMap.set(f.id, f.name));

            const docsByFolder = new Map();
            const rootDocs = [];
            folderDocs.forEach(d => {
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

            sourceFolderNodes.forEach(folder => {
                const folderDocsInSource = docsByFolder.get(folder.id) || [];
                if (folderDocsInSource.length === 0) return;

                const subheader = document.createElement('div');
                subheader.className = 'folder-subheader';
                subheader.textContent = folder.name;
                docList.appendChild(subheader);

                folderDocsInSource.forEach(doc => {
                    const { wrapper } = renderNode(doc, sourceId);
                    docList.appendChild(wrapper);
                });
            });

            rootDocs.forEach(doc => {
                const { wrapper } = renderNode(doc, sourceId);
                docList.appendChild(wrapper);
            });
        });
    }

    function renderDesignFolderListModal() {
        const folderListModal = document.getElementById('design-folder-list-modal');
        if (!folderListModal) return;
        folderListModal.innerHTML = '';

        const folderPaths = state.designFolderPaths || [];

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
                vscode.postMessage({ type: 'removeDesignFolder', folderPath: path });
            });

            row.appendChild(pathSpan);
            row.appendChild(removeBtn);
            folderListModal.appendChild(row);
        });
    }

    function renderDesignDocs(rootEntry) {
        const { sourceId, nodes, folderPaths } = rootEntry;
        const treePaneDesign = document.getElementById('tree-pane-design');
        if (!treePaneDesign) return;

        treePaneDesign.innerHTML = '';

        // Re-add sidebar toggle
        const toggleRow = document.createElement('div');
        toggleRow.className = 'sidebar-toggle-row';

        const foldersBtn = document.createElement('button');
        foldersBtn.className = 'sidebar-folders-btn';
        foldersBtn.title = 'Manage Folders';
        foldersBtn.textContent = 'Manage Folders';
        foldersBtn.addEventListener('click', () => {
            const modal = document.getElementById('folder-modal-design');
            if (modal) {
                modal.style.display = 'flex';
                renderDesignFolderListModal();
                vscode.postMessage({ type: 'listDesignFolders' });
            }
        });

        const toggleBtn = document.createElement('button');
        toggleBtn.className = 'sidebar-toggle-btn';
        toggleBtn.title = 'Toggle sidebar';
        toggleBtn.textContent = state.designPreviewCollapsed ? '»' : '«';
        toggleBtn.addEventListener('click', toggleSidebarCollapsed);

        toggleRow.appendChild(foldersBtn);
        toggleRow.appendChild(toggleBtn);
        treePaneDesign.appendChild(toggleRow);

        const docList = document.createElement('div');
        docList.className = 'source-doc-list';
        docList.dataset.sourceId = sourceId;
        treePaneDesign.appendChild(docList);

        if (!nodes || nodes.length === 0) {
            docList.innerHTML = '<div class="empty-state" style="padding: 12px; font-size: 12px; color: var(--text-secondary);">No design system folders configured or folders are empty. Click Manage Folders to get started.</div>';
            return;
        }

        const folderNodes = (nodes || []).filter(n => n.kind === 'folder');
        const docNodes = (nodes || []).filter(n => n.kind === 'document');

        // Group nodes by sourceFolder
        const docsBySourceFolder = new Map();
        const foldersBySourceFolder = new Map();

        docNodes.forEach(d => {
            const sourceFolder = d.metadata?.sourceFolder;
            if (!sourceFolder) return;
            if (!docsBySourceFolder.has(sourceFolder)) {
                docsBySourceFolder.set(sourceFolder, []);
            }
            docsBySourceFolder.get(sourceFolder).push(d);
        });

        folderNodes.forEach(f => {
            const sourceFolder = f.metadata?.sourceFolder;
            if (!sourceFolder) return;
            if (!foldersBySourceFolder.has(sourceFolder)) {
                foldersBySourceFolder.set(sourceFolder, []);
            }
            foldersBySourceFolder.get(sourceFolder).push(f);
        });

        const sourceFolders = [...new Set([
            ...(folderPaths || []),
            ...docsBySourceFolder.keys()
        ])];

        sourceFolders.forEach(sourceFolder => {
            const folderDocs = docsBySourceFolder.get(sourceFolder) || [];
            const sourceFolderNodes = foldersBySourceFolder.get(sourceFolder) || [];

            if (folderDocs.length === 0 && sourceFolderNodes.length === 0) return;

            const sourceHeader = document.createElement('div');
            sourceHeader.className = 'folder-subheader source-folder-header';
            const folderName = sourceFolder.split(/[\\/]/).filter(Boolean).pop() || sourceFolder;
            sourceHeader.textContent = folderName;
            sourceHeader.title = sourceFolder;
            docList.appendChild(sourceHeader);

            const folderNameMap = new Map();
            sourceFolderNodes.forEach(f => folderNameMap.set(f.id, f.name));

            const docsByFolder = new Map();
            const rootDocs = [];
            folderDocs.forEach(d => {
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

            sourceFolderNodes.forEach(folder => {
                const folderDocsInSource = docsByFolder.get(folder.id) || [];
                if (folderDocsInSource.length === 0) return;

                const subheader = document.createElement('div');
                subheader.className = 'folder-subheader';
                subheader.textContent = folder.name;
                docList.appendChild(subheader);

                folderDocsInSource.forEach(doc => {
                    const { wrapper } = renderNode(doc, sourceId);
                    docList.appendChild(wrapper);
                });
            });

            rootDocs.forEach(doc => {
                const { wrapper } = renderNode(doc, sourceId);
                docList.appendChild(wrapper);
            });
        });
    }

    function renderLocalDocs(rootEntry) {
        const { sourceId, nodes, folderPaths } = rootEntry;
        
        // Clear only local pane
        treePane.innerHTML = '';
        
        // Re-add sidebar toggle
        const toggleRow = document.createElement('div');
        toggleRow.className = 'sidebar-toggle-row';
        
        const foldersBtn = document.createElement('button');
        foldersBtn.className = 'sidebar-folders-btn';
        foldersBtn.title = 'Manage Folders';
        foldersBtn.id = 'btn-manage-folders';
        foldersBtn.textContent = 'Manage Folders';
        foldersBtn.addEventListener('click', openFoldersModal);
        
        const toggleBtn = document.createElement('button');
        toggleBtn.className = 'sidebar-toggle-btn';
        toggleBtn.title = 'Toggle sidebar';
        toggleBtn.textContent = state.docsListCollapsed ? '»' : '«';
        toggleBtn.addEventListener('click', toggleSidebarCollapsed);
        
        toggleRow.appendChild(foldersBtn);
        toggleRow.appendChild(toggleBtn);
        treePane.appendChild(toggleRow);
        
        if (sourceId === 'local-folder') {
            // ALWAYS create docList container so handleLocalFolderPathUpdated can find it later
            const docList = document.createElement('div');
            docList.className = 'source-doc-list';
            docList.dataset.sourceId = sourceId;
            // Push content down to avoid overlapping with top-right absolute controls
            docList.style.paddingTop = '0px';
            treePane.appendChild(docList);

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

                // Group nodes by sourceFolder first
                const docsBySourceFolder = new Map();
                const foldersBySourceFolder = new Map();

                docNodes.forEach(d => {
                    const sourceFolder = d.metadata?.sourceFolder;
                    if (!sourceFolder) return; // skip docs without sourceFolder (shouldn't happen)
                    if (!docsBySourceFolder.has(sourceFolder)) {
                        docsBySourceFolder.set(sourceFolder, []);
                    }
                    docsBySourceFolder.get(sourceFolder).push(d);
                });

                folderNodes.forEach(f => {
                    const sourceFolder = f.metadata?.sourceFolder;
                    if (!sourceFolder) return;
                    if (!foldersBySourceFolder.has(sourceFolder)) {
                        foldersBySourceFolder.set(sourceFolder, []);
                    }
                    foldersBySourceFolder.get(sourceFolder).push(f);
                });

                // Iterate over source folders (use folderPaths for consistent ordering)
                const sourceFolders = [...new Set([
                    ...(folderPaths || []),
                    ...docsBySourceFolder.keys()
                ])];

                sourceFolders.forEach(sourceFolder => {
                    const folderDocs = docsBySourceFolder.get(sourceFolder) || [];
                    const sourceFolderNodes = foldersBySourceFolder.get(sourceFolder) || [];

                    // Skip source folders with no documents AND no subfolders
                    if (folderDocs.length === 0 && sourceFolderNodes.length === 0) return;

                    // Source-folder subheader (basename of the full path)
                    const sourceHeader = document.createElement('div');
                    sourceHeader.className = 'folder-subheader source-folder-header';
                    // Browser-safe basename extraction (no Node path module in webview)
                    const folderName = sourceFolder.split(/[\\/]/).filter(Boolean).pop() || sourceFolder;
                    sourceHeader.title = sourceFolder; // full path as tooltip for disambiguation

                    const labelSpan = document.createElement('span');
                    labelSpan.textContent = folderName;
                    sourceHeader.appendChild(labelSpan);

                    const importBtn = document.createElement('button');
                    importBtn.className = 'folder-import-btn';
                    importBtn.textContent = 'Import';
                    importBtn.title = `Import document from clipboard into ${folderName}`;
                    importBtn.addEventListener('click', (e) => {
                        e.stopPropagation();

                        // Disable all import buttons during operation
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
                            folderPath: sourceFolder
                            // No docTitle — backend extracts from H1 or generates timestamp
                        });
                    });
                    sourceHeader.appendChild(importBtn);
                    docList.appendChild(sourceHeader);

                    // Within this source folder, apply existing folder-hierarchy grouping
                    const folderNameMap = new Map();
                    sourceFolderNodes.forEach(f => folderNameMap.set(f.id, f.name));

                    const docsByFolder = new Map();
                    const rootDocs = [];
                    folderDocs.forEach(d => {
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

                    sourceFolderNodes.forEach(folder => {
                        const folderDocsInSource = docsByFolder.get(folder.id) || [];
                        if (folderDocsInSource.length === 0) return;

                        const subheader = document.createElement('div');
                        subheader.className = 'folder-subheader';
                        subheader.textContent = folder.name;
                        docList.appendChild(subheader);

                        folderDocsInSource.forEach(doc => {
                            const { wrapper } = renderNode(doc, sourceId);
                            docList.appendChild(wrapper);
                        });
                    });

                    rootDocs.forEach(doc => {
                        const { wrapper } = renderNode(doc, sourceId);
                        docList.appendChild(wrapper);
                    });
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
            // Sort sessions by timestamp descending (most recent first)
            const sortedSessions = [...sessions].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

            // Group sessions by date
            const groups = new Map();
            for (const session of sortedSessions) {
                const dateKey = new Date(session.timestamp).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
                if (!groups.has(dateKey)) groups.set(dateKey, []);
                groups.get(dateKey).push(session);
            }

            // Render groups
            for (const [dateKey, dateSessions] of groups) {
                const dateHeader = document.createElement('div');
                dateHeader.className = 'antigravity-date-subheader';
                dateHeader.textContent = dateKey;
                section.appendChild(dateHeader);

                for (const session of dateSessions) {
                    const sessionTime = new Date(session.timestamp).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

                    // Artifact rows under each session
                    for (const artifact of session.artifacts) {
                        const artifactCard = renderDocCard({
                            title: artifact.name,
                            subtitle: 'Session at ' + sessionTime,
                            sourceId: 'antigravity',
                            nodeId: artifact.id,
                            nodeMetadata: { absolutePath: artifact.id },
                            actions: ['Set Context', 'Link Doc'],
                            isSelected: state.activeSource === 'antigravity' && state.activeDocId === artifact.id,
                            clickHandler: (cardWrapper, e) => {
                                document.querySelectorAll('.tree-node.selected').forEach(n => n.classList.remove('selected'));
                                cardWrapper.classList.add('selected');
                                state.activeSource = 'antigravity';
                                state.activeDocId = artifact.id;
                                state.activeDocName = artifact.name;
                                updateLocalActiveContextButtonState();
                                vscode.postMessage({
                                    type: 'fetchAntigravityArtifact',
                                    artifactPath: artifact.id,
                                    requestId: ++state.previewRequestId
                                });
                            },
                            extraClass: 'antigravity-artifact-node'
                        });
                        section.appendChild(artifactCard);
                    }
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

            const header = document.createElement('div');
            header.className = 'source-header';
            header.dataset.sourceId = sourceId;
            header.textContent = SOURCE_DISPLAY_NAMES[sourceId] || sourceId;
            headerRow.appendChild(header);

            const controlsContainer = document.createElement('div');
            controlsContainer.className = 'source-controls';
            controlsContainer.dataset.sourceId = sourceId;
            
            const refreshBtn = document.createElement('button');
            refreshBtn.className = 'source-refresh-btn';
            refreshBtn.textContent = '↻';
            refreshBtn.title = 'Refresh';
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
        state._lastLocalDocsMsg = msg;
        state.localFolderPaths = msg.folderPaths || [];
        populateWorkspaceDropdown('local-workspace-filter', msg.workspaceItems || [], state.localWorkspaceRootFilter);
        const filteredNodes = state.localWorkspaceRootFilter
            ? (msg.nodes || []).filter(n => n.metadata?.root === state.localWorkspaceRootFilter)
            : (msg.nodes || []);
        renderLocalDocs({
            sourceId: msg.sourceId || 'local-folder',
            nodes: filteredNodes,
            folderPaths: msg.folderPaths || [],
            error: msg.error
        });

        // Handle antigravity sessions section
        renderAntigravitySessions(msg.antigravitySessions || [], msg.antigravityEnabled || false);

        // Sync toggle state
        state.antigravityEnabled = msg.antigravityEnabled || false;
        const agToggleModal = document.getElementById('antigravity-toggle-modal');
        if (agToggleModal) { agToggleModal.checked = state.antigravityEnabled; }

        // Keep modal folder list in sync when docs are refreshed
        renderFolderListModal();
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
        
        const childContainer = parentEl.closest('.tree-node-container')?.querySelector('.tree-children');
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

    function viewRawJson() {
        const jsonCont = document.getElementById('json-preview-container-design');
        const mdPrev = document.getElementById('markdown-preview-design');
        if (jsonCont) jsonCont.style.display = 'none';
        if (mdPrev && !state.editMode.design) {
            mdPrev.style.display = 'block';
            mdPrev.innerHTML = `<pre><code>${escapeHtml(state.activeDocContent || '')}</code></pre>`;
        }
    }

    function handlePreviewReady(msg) {
        const { sourceId, requestId, content, docName, pages, isAutoRefreshed, filePath, htmlContent, webviewUri, isImage } = msg;

        if (sourceId === 'html-folder') {
            if (requestId !== undefined && requestId !== -1 && requestId !== state.previewRequestId) return;

            // Hide loading/initial states, show appropriate preview
            const initialState = document.getElementById('html-initial-state');
            const loadingState = document.getElementById('html-loading-state');
            if (initialState) initialState.style.display = 'none';
            if (loadingState) loadingState.style.display = 'none';

            const iframe = document.getElementById('html-preview-frame');
            const imageContainer = document.getElementById('image-preview-container');
            const imageImg = document.getElementById('image-preview-img');

            if (isImage && webviewUri) {
                // Image preview: hide iframe, show image container
                if (iframe) { iframe.style.display = 'none'; iframe.removeAttribute('src'); iframe.removeAttribute('srcdoc'); }
                if (imageContainer) { imageContainer.style.display = 'flex'; }
                if (imageImg) { imageImg.src = webviewUri + '?t=' + Date.now(); } // cache-buster for refresh
            } else if (htmlContent) {
                // HTML preview: use srcdoc and inject base tag for relative asset resolution
                // (iframe.src with vscode-webview-resource: URIs is blocked by VS Code's sandbox)
                if (iframe) {
                    iframe.style.display = '';
                    iframe.removeAttribute('src');
                    const htmlWithBase = injectBaseTag(htmlContent, webviewUri);
                    console.log('[PlanningPanel] Setting srcdoc for HTML preview, length:', htmlWithBase.length, 'hasNonce:', /nonce="/.test(htmlWithBase));
                    iframe.srcdoc = htmlWithBase;
                    // Diagnostic: listen for load/error events on the iframe
                    iframe.onload = () => { console.log('[PlanningPanel] Preview iframe loaded successfully'); };
                    iframe.onerror = (e) => { console.error('[PlanningPanel] Preview iframe error:', e); };
                }
                if (imageContainer) { imageContainer.style.display = 'none'; }
                if (imageImg) { imageImg.removeAttribute('src'); }
            } else if (webviewUri && iframe && iframe.srcdoc) {
                // Cache hit: content hasn't changed, iframe already has srcdoc content
                // Just ensure iframe is visible — do NOT modify src or srcdoc
                iframe.style.display = '';
                if (imageContainer) { imageContainer.style.display = 'none'; }
                if (imageImg) { imageImg.removeAttribute('src'); }
            } else if (webviewUri) {
                // Fallback: iframe src if htmlContent not available and no existing srcdoc
                // (e.g., backend file read failed on first attempt)
                if (iframe) {
                    iframe.style.display = '';
                    iframe.removeAttribute('srcdoc');
                    iframe.src = webviewUri + '?t=' + Date.now(); // cache-buster for refresh
                }
                if (imageContainer) { imageContainer.style.display = 'none'; }
                if (imageImg) { imageImg.removeAttribute('src'); }
            }
            const statusHtml = document.getElementById('status-html');
            if (statusHtml) {
                if (isAutoRefreshed) {
                    statusHtml.textContent = (docName || 'Loaded') + ' — auto-refreshed';
                    statusHtml.style.color = 'var(--accent-teal)';
                } else {
                    statusHtml.textContent = docName || 'Loaded';
                    statusHtml.style.color = 'var(--accent-teal)';
                }
            }
            return;
        }

        if (sourceId === 'design-folder') {
            if (requestId !== undefined && requestId !== -1 && requestId !== state.previewRequestId) return;

            state.activeDocFilePath = filePath || null;
            state.activeFileType = msg.fileType || null;

            const mdPrev = document.getElementById('markdown-preview-design');
            const mdEd = document.getElementById('markdown-editor-design');
            const imgCont = document.getElementById('image-preview-container-design');
            const imgImg = document.getElementById('image-preview-img-design');
            const jsonCont = document.getElementById('json-preview-container-design');
            const statusDesign = document.getElementById('status-design');

            const btnSetDesign = document.getElementById('btn-set-active-context-design');
            const btnLinkDesign = document.getElementById('btn-link-to-doc-design');
            const btnEditDesign = document.getElementById('btn-edit-design');

            if (isImage && webviewUri) {
                if (mdPrev) mdPrev.style.display = 'none';
                if (mdEd) mdEd.style.display = 'none';
                if (jsonCont) jsonCont.style.display = 'none';
                if (imgCont) imgCont.style.display = 'flex';
                if (imgImg) imgImg.src = webviewUri + '?t=' + Date.now();
                if (btnEditDesign) btnEditDesign.disabled = true;
            } else if (msg.fileType === 'json') {
                // JSON preview
                if (imgCont) imgCont.style.display = 'none';
                if (mdPrev) mdPrev.style.display = 'none';
                if (mdEd && !state.editMode.design) mdEd.style.display = 'none';
                if (jsonCont && !state.editMode.design) {
                    jsonCont.style.display = 'block';
                    jsonCont.innerHTML = '';
                    try {
                        jsonCont.appendChild(renderJsonTree(JSON.parse(content)));
                    } catch (e) {
                        jsonCont.innerHTML = `<div class="json-error">Failed to parse JSON: ${e.message}<br><button onclick="viewRawJson()">View Raw</button></div>`;
                    }
                }
                state.activeDocContent = content || '';
                if (mdEd) mdEd.value = content || '';
                if (btnEditDesign) btnEditDesign.disabled = false;
            } else if (msg.fileType === 'yaml') {
                // YAML preview — use pre-parsed JSON from backend
                if (imgCont) imgCont.style.display = 'none';
                if (mdPrev) mdPrev.style.display = 'none';
                if (mdEd && !state.editMode.design) mdEd.style.display = 'none';
                if (jsonCont && !state.editMode.design) {
                    jsonCont.style.display = 'block';
                    jsonCont.innerHTML = '';
                    if (msg.parsedJson !== undefined) {
                        try {
                            jsonCont.appendChild(renderJsonTree(msg.parsedJson));
                        } catch (e) {
                            jsonCont.innerHTML = `<div class="json-error">Failed to render YAML tree: ${e.message}<br><button onclick="viewRawJson()">View Raw</button></div>`;
                        }
                    } else {
                        // Backend parse failed — show raw
                        jsonCont.innerHTML = `<div class="json-error">Invalid YAML on disk — cannot render tree.<br><button onclick="viewRawJson()">View Raw</button></div>`;
                    }
                }
                state.activeDocContent = content || '';
                if (mdEd) mdEd.value = content || '';
                if (btnEditDesign) btnEditDesign.disabled = false;
            } else if (msg.fileType === 'css' || msg.fileType === 'xml' || msg.fileType === 'text') {
                // Plain text / code preview in markdown container
                if (imgCont) imgCont.style.display = 'none';
                if (jsonCont) jsonCont.style.display = 'none';
                if (mdEd && !state.editMode.design) mdEd.style.display = 'none';
                if (mdPrev && !state.editMode.design) {
                    mdPrev.style.display = 'block';
                    const langClass = msg.fileType === 'css' ? 'language-css' : (msg.fileType === 'xml' ? 'language-xml' : '');
                    mdPrev.innerHTML = `<pre><code class="${langClass}">${escapeHtml(content)}</code></pre>`;
                }
                if (btnEditDesign) btnEditDesign.disabled = false;
            } else {
                // Markdown (default) — existing path
                if (imgCont) imgCont.style.display = 'none';
                if (jsonCont) jsonCont.style.display = 'none';
                if (mdEd && !state.editMode.design) mdEd.style.display = 'none';
                if (mdPrev && !state.editMode.design) mdPrev.style.display = 'block';

                // Skip re-render if content hasn't changed (prevents line-length flicker)
                if (state.activeDocContent === (content || '')) {
                    if (isAutoRefreshed) {
                        if (statusDesign) {
                            statusDesign.textContent = (docName || 'Loaded') + ' — auto-refreshed';
                            statusDesign.style.color = 'var(--accent-teal)';
                        }
                    }
                    return;
                }

                state.activeDocContent = content || '';
                if (mdEd) mdEd.value = content || '';
                if (mdPrev) mdPrev.innerHTML = renderMarkdown(content || '');
                if (btnEditDesign) btnEditDesign.disabled = false;
            }

            if (btnSetDesign) btnSetDesign.disabled = false;
            if (btnLinkDesign) btnLinkDesign.disabled = false;

            if (isAutoRefreshed) {
                if (state.editMode.design) {
                    state.externalChangePending.design = true;
                    if (statusDesign) {
                        statusDesign.textContent = 'File changed externally — save to overwrite or cancel to reload';
                        statusDesign.style.color = 'var(--vscode-errorForeground, #ff6b6b)';
                    }
                    return;
                }
                if (statusDesign) {
                    statusDesign.textContent = (docName || 'Loaded') + ' — auto-refreshed';
                    statusDesign.style.color = 'var(--accent-teal)';
                }
            } else {
                if (statusDesign) {
                    statusDesign.textContent = docName || 'Loaded';
                    statusDesign.style.color = '';
                }
            }
            return;
        }

        // Auto-refresh notification
        if (isAutoRefreshed) {
            if (state.editMode.local) {
                // Defer reload — don't clobber the editor
                state.externalChangePending.local = true;
                const statusLocal = document.getElementById('status');
                if (statusLocal) {
                    statusLocal.textContent = 'File changed externally — save to overwrite or cancel to reload';
                    statusLocal.style.color = 'var(--vscode-errorForeground, #ff6b6b)';
                }
                return;
            }
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
        const targetBtnAppend = isOnline ? btnAppendToPromptsOnline : null;
        const btnImportFullId = isOnline ? 'btn-import-full-doc-online' : 'btn-import-full-doc';

        const btnImportFullDoc = document.getElementById(btnImportFullId);
        const btnEditLocal = document.getElementById('btn-edit-local');

        if (sourceId === 'local-folder' || sourceId === 'antigravity') {
            state.activeDocFilePath = filePath || null;
            if (btnEditLocal) btnEditLocal.disabled = false;
            if (btnImportFullDoc) {
                btnImportFullDoc.style.display = 'none';
                btnImportFullDoc.disabled = true;
            }
        } else {
            state.activeDocFilePath = null;
            if (btnEditLocal) btnEditLocal.disabled = true;
            if (btnImportFullDoc) {
                btnImportFullDoc.style.display = '';
                btnImportFullDoc.disabled = false;
                btnImportFullDoc.dataset.docId = state.activeDocId || '';
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
                if (targetBtnAppend) targetBtnAppend.disabled = false;
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
                if (targetBtnAppend) targetBtnAppend.disabled = true;
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

        // If the user is actively editing this doc, don't clobber activeDocContent or the
        // rendered preview — the edit-mode conflict detection baseline (editOriginalContent.local)
        // was captured at edit-mode entry and must remain stable. On auto-refresh, just notify.
        if (state.editMode.local && !isOnline) {
            if (msg.isAutoRefreshed) {
                const statusEl2 = document.getElementById('status');
                if (statusEl2) {
                    statusEl2.textContent = 'File changed externally — save to overwrite or cancel to reload';
                    statusEl2.style.color = 'var(--vscode-editorWarning-foreground, #cca700)';
                    setTimeout(() => { statusEl2.textContent = ''; statusEl2.style.color = ''; }, 5000);
                }
            }
            return;
        }

        // Skip re-render if content hasn't changed (prevents line-length flicker)
        if (state.activeDocContent === (content || '')) {
            if (msg.isAutoRefreshed) {
                targetStatus.textContent = 'Externally updated — refreshed';
                setTimeout(() => { if (targetStatus.textContent === 'Externally updated — refreshed') targetStatus.textContent = ''; }, 2000);
            }
            return;
        }

        state.activeDocContent = content || '';

        targetPreview.innerHTML = renderMarkdown(content || '');

        if (targetBtnAppend) targetBtnAppend.disabled = false;
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

        if (requestId !== undefined && requestId !== -1 && requestId !== state.previewRequestId) return;

        // Route html-folder errors to the HTML preview area
        if (sourceId === 'html-folder') {
            const initialState = document.getElementById('html-initial-state');
            const loadingState = document.getElementById('html-loading-state');
            const imageContainer = document.getElementById('image-preview-container');
            if (initialState) initialState.style.display = 'none';
            if (loadingState) loadingState.style.display = 'none';
            if (imageContainer) imageContainer.style.display = 'none';

            const statusHtml = document.getElementById('status-html');
            if (statusHtml) {
                statusHtml.textContent = 'Error: ' + error;
                statusHtml.style.color = '';
            }
            const iframe = document.getElementById('html-preview-frame');
            if (iframe) {
                iframe.style.display = '';
                iframe.removeAttribute('src');  // Clear any src-based navigation
                iframe.srcdoc = `<html><body style="background:#000;color:#e0e0e0;font-family:sans-serif;padding:2em"><p>Error: ${error.replace(/</g, '&lt;')}</p></body></html>`;
            }
            return;
        }

        if (sourceId === 'design-folder') {
            const statusDesign = document.getElementById('status-design');
            if (statusDesign) {
                statusDesign.textContent = 'Error: ' + error;
                statusDesign.style.color = 'var(--vscode-errorForeground, #ff6b6b)';
            }
            const previewDesign = document.getElementById('markdown-preview-design');
            if (previewDesign) {
                previewDesign.innerHTML = `<div class="empty-state" style="color:var(--vscode-errorForeground, #ff6b6b)">Error: ${error}</div>`;
            }
            const imageContainerDesign = document.getElementById('image-preview-container-design');
            if (imageContainerDesign) {
                imageContainerDesign.style.display = 'none';
            }
            return;
        }

        const isOnline = ONLINE_SOURCES.includes(sourceId);
        const targetPreview = isOnline ? markdownPreviewOnline : markdownPreview;
        const targetStatus = isOnline ? statusElOnline : statusEl;
        const targetBtnAppend = isOnline ? btnAppendToPromptsOnline : null;
        const btnImportFullId = isOnline ? 'btn-import-full-doc-online' : 'btn-import-full-doc';

        const errorDiv = document.createElement('div');
        errorDiv.className = 'error-state';
        errorDiv.textContent = 'Error: ' + error;
        targetPreview.innerHTML = '';
        targetPreview.appendChild(errorDiv);
        targetStatus.textContent = 'Error loading preview';
        
        if (targetBtnAppend) targetBtnAppend.disabled = true;

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
            
            if (btnAppendToPromptsOnline) btnAppendToPromptsOnline.disabled = false;
        } else if (msg.error) {
            statusEl.textContent = `Error: ${msg.error}`;
            statusElOnline.textContent = `Error: ${msg.error}`;
            if (btnAppendToPromptsOnline) btnAppendToPromptsOnline.disabled = false;
        }
    }

    function handleThemeChanged(theme) {
        // Track the active Switchboard visual theme
        if (theme) { state.switchboardTheme = theme; }
        // Remove Switchboard visual theme classes
        document.body.classList.remove('theme-claude-terracotta', 'theme-slightly-darker-black');
        // Cyberpunk CRT effects (scanlines, grid, glow, sweep) are part of the Afterburner aesthetic only.
        // Toggle cyber-theme-enabled: on for afterburner, off for any other Switchboard visual theme.
        if (state.switchboardTheme === 'afterburner') {
            document.body.classList.add('cyber-theme-enabled');
        } else {
            document.body.classList.remove('cyber-theme-enabled');
            document.body.classList.add(`theme-${state.switchboardTheme}`);
        }
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
        renderFolderListModal();

        // Delegate to renderLocalDocs to ensure consistent source-folder grouping
        renderLocalDocs({
            sourceId: 'local-folder',
            nodes: nodes || [],
            folderPaths: state.localFolderPaths
        });
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

                    const actions = ['Set Context', 'Link Doc'];
                    if (doc.canSync) {
                        actions.push('Sync');
                    }
                    actions.push('Delete');

                    const wrapper = renderDocCard({
                        title: displayLabel,
                        subtitle: (doc.slugPrefix && doc.slugPrefix !== displayLabel) ? doc.slugPrefix : undefined,
                        sourceId: doc.sourceId || 'local-folder',
                        nodeId: doc.slugPrefix,
                        nodeMetadata: null,
                        actions,
                        isSelected: state.selectedEl && state.selectedEl.dataset.docId === doc.slugPrefix,
                        clickHandler: (cardWrapper, e) => {
                            e.stopPropagation();

                            // Apply selection highlighting
                            if (state.selectedEl) {
                                state.selectedEl.classList.remove('selected');
                            }
                            cardWrapper.classList.add('selected');
                            state.selectedEl = cardWrapper;

                            state.activeSource = doc.sourceId || 'local-folder';
                            state.activeDocId = doc.slugPrefix;
                            state.activeDocName = doc.docName;
                            state.previewRequestId++;
                            updateLocalActiveContextButtonState();

                            // Send message to load file from docs directory
                            vscode.postMessage({
                                type: 'fetchDocsFile',
                                slugPrefix: doc.slugPrefix,
                                requestId: state.previewRequestId
                            });
                        },
                        deleteHandler: (btn) => {
                            btn.disabled = true;
                            btn.textContent = '…';
                            vscode.postMessage({
                                type: 'deleteImportedDoc',
                                slugPrefix: doc.slugPrefix,
                                docName: doc.docName
                            });
                        },
                        syncHandler: (btn) => {
                            btn.disabled = true;
                            vscode.postMessage({
                                type: 'syncToSource',
                                slugPrefix: doc.slugPrefix
                            });
                        }
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
            case 'cyberAnimationSetting': {
                document.body.classList.toggle('cyber-animation-disabled', msg.disabled);
                break;
            }
            case 'kanbanPlansReady':
                handleKanbanPlansReady(msg);
                break;
            case 'kanbanPlanPreviewReady':
                handleKanbanPlanPreviewReady(msg);
                break;
            case 'kanbanContextSet':
                handleKanbanContextSet(msg);
                break;
            case 'kanbanPlanPromptCopied': {
                const btn = document.querySelector(`.kanban-plan-copy-prompt[data-session-id="${msg.sessionId}"]`);
                if (btn) {
                    btn.textContent = msg.success ? 'Copied!' : 'Failed';
                    setTimeout(() => {
                        btn.textContent = 'Copy Prompt';
                    }, 2000);
                }
                if (msg.success) {
                    // Refresh plan list to show new column
                    vscode.postMessage({ type: 'fetchKanbanPlans', requestId: Date.now() });
                }
                break;
            }
            case 'kanbanPlanColumnChanged': {
                if (msg.success) {
                    vscode.postMessage({ type: 'fetchKanbanPlans', requestId: Date.now() });
                } else {
                    console.error('[Kanban Sidebar] Failed to move plan column:', msg.error);
                }
                break;
            }
            case 'commentResult': {
                const { ok, message } = msg;
                if (ok) {
                    hideKanbanCommentPopup(true);
                    const kanbanStrip = document.querySelector('.kanban-controls-strip');
                    if (kanbanStrip) {
                        const feedback = document.createElement('span');
                        feedback.textContent = 'Comment sent';
                        feedback.style.cssText = 'color: var(--accent-teal, #3ddbd9); font-size: 11px; margin-left: 8px;';
                        kanbanStrip.appendChild(feedback);
                        setTimeout(() => feedback.remove(), 2000);
                    }
                } else {
                    // Flash submit button red and show error message in controls strip
                    const submitBtn = document.getElementById('kanban-submit-comment');
                    if (submitBtn) {
                        submitBtn.style.borderColor = '#ff6b6b';
                        setTimeout(() => { submitBtn.style.borderColor = ''; }, 2000);
                    }
                    const kanbanStrip = document.querySelector('.kanban-controls-strip');
                    if (kanbanStrip) {
                        const feedback = document.createElement('span');
                        feedback.textContent = message || 'Comment failed';
                        feedback.style.cssText = 'color: #ff6b6b; font-size: 11px; margin-left: 8px;';
                        kanbanStrip.appendChild(feedback);
                        setTimeout(() => feedback.remove(), 3000);
                    }
                }
                break;
            }
            case 'localDocsReady':
                handleLocalDocsReady(msg);
                break;
            case 'htmlDocsReady':
                handleHtmlDocsReady(msg);
                break;
            case 'designDocsReady':
                state._lastDesignDocsMsg = msg;
                state.designFolderPaths = msg.folderPaths || [];
                populateWorkspaceDropdown('design-workspace-filter', msg.workspaceItems || [], state.designWorkspaceRootFilter);
                const filteredNodes = state.designWorkspaceRootFilter
                    ? (msg.nodes || []).filter(n => n.metadata?.root === state.designWorkspaceRootFilter)
                    : (msg.nodes || []);
                renderDesignDocs({
                    sourceId: msg.sourceId || 'design-folder',
                    nodes: filteredNodes,
                    folderPaths: msg.folderPaths || []
                });
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
                if (btnAppendToPromptsOnline) btnAppendToPromptsOnline.disabled = false;
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
                const statusEl = document.getElementById('status');

                const btnResearchClipboard = document.getElementById('btn-import-research-doc-clipboard');

                if (btnResearchClipboard) {
                    btnResearchClipboard.disabled = false;
                    btnResearchClipboard.innerText = 'IMPORT FROM CLIPBOARD';
                }

                // Reset inline folder import buttons
                document.querySelectorAll('.folder-import-btn').forEach(btn => {
                    btn.disabled = false;
                    btn.textContent = 'Import';
                });
                
                if (msg.success) {
                    const successText = `Imported: ${msg.docTitle || 'Research Doc'}`;
                    if (researchStatusEl) {
                        researchStatusEl.style.color = 'var(--accent-teal)';
                        researchStatusEl.textContent = successText;
                    }
                    if (statusEl) {
                        statusEl.style.color = 'var(--accent-teal)';
                        statusEl.textContent = successText;
                    }
                    if (docTitleInput) {
                        docTitleInput.value = '';
                    }
                } else {
                    const errorText = `Error: ${msg.error || 'Failed to import'}`;
                    if (researchStatusEl) {
                        researchStatusEl.style.color = '#f14c4c';
                        researchStatusEl.textContent = errorText;
                    }
                    if (statusEl) {
                        statusEl.style.color = '#f14c4c';
                        statusEl.textContent = errorText;
                    }
                }
                break;
            case 'themeChanged':
                handleThemeChanged();
                break;
            case 'switchboardThemeNameSetting':
            case 'switchboardThemeChanged':
                handleThemeChanged(msg.theme);
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
                renderFolderListModal();
                const folderSelect = document.getElementById('research-destination-folder');
                const warningEl = document.getElementById('research-no-folders-warning');
                const importBtn = document.getElementById('btn-import-research-doc-clipboard');
                
                const hasFolders = msg.paths && msg.paths.length > 0;
                
                if (warningEl) {
                    warningEl.style.display = hasFolders ? 'none' : 'block';
                }
                if (importBtn) {
                    importBtn.disabled = !hasFolders;
                    importBtn.style.opacity = hasFolders ? '1' : '0.4';
                }

                if (folderSelect) {
                    folderSelect.innerHTML = '';
                    (msg.paths || []).forEach(p => {
                        const opt = document.createElement('option');
                        opt.value = p;
                        opt.textContent = p.split('/').pop() || p;
                        folderSelect.appendChild(opt);
                    });

                    if (hasFolders) {
                        if (state.lastResearchFolder && msg.paths.includes(state.lastResearchFolder)) {
                            folderSelect.value = state.lastResearchFolder;
                        } else {
                            state.lastResearchFolder = msg.paths[0];
                            const currentPersisted = vscode.getState() || {};
                            vscode.setState({ ...currentPersisted, lastResearchFolder: state.lastResearchFolder });
                            folderSelect.value = state.lastResearchFolder;
                        }
                    } else {
                        state.lastResearchFolder = null;
                        const currentPersisted = vscode.getState() || {};
                        vscode.setState({ ...currentPersisted, lastResearchFolder: null });
                    }
                }
                break;
            case 'htmlFoldersListed':
                state.htmlFolderPaths = msg.paths || [];
                renderHtmlFolderListModal();
                break;
            case 'designFoldersListed':
                state.designFolderPaths = msg.paths || [];
                renderDesignFolderListModal();
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
                // No local strip button to re-enable (card action used instead)
                break;
            case 'localDocDeleted':
                if (msg.success) {
                    statusEl.textContent = `Moved to trash: ${msg.docId}`;
                    // If the deleted doc was the active selection, clear preview
                    if (state.activeDocId === msg.docId) {
                        state.activeDocId = null;
                        state.activeDocName = null;
                        state.activeSource = null;
                        updateLocalActiveContextButtonState();
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
                        updateLocalActiveContextButtonState();
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
            case 'analystAvailabilityResult': {
                const draftAnalystBtn = document.getElementById('btn-draft-with-analyst');
                if (draftAnalystBtn) {
                    draftAnalystBtn.disabled = !msg.available;
                    if (!msg.available) {
                        draftAnalystBtn.title = 'Analyst terminal not available. Configure an analyst agent to enable this feature.';
                    } else {
                        draftAnalystBtn.removeAttribute('title');
                    }
                }
                break;
            }
            case 'draftResearchPromptResult': {
                const draftAnalystBtn = document.getElementById('btn-draft-with-analyst');
                if (draftAnalystBtn) {
                    if (msg.success) {
                        draftAnalystBtn.innerText = 'SENT';
                        setTimeout(() => {
                            if (draftAnalystBtn) draftAnalystBtn.innerText = 'DRAFT WITH ANALYST AGENT';
                        }, 2000);
                    } else {
                        draftAnalystBtn.innerText = 'FAILED';
                        console.error('[Research] Failed to draft prompt with analyst:', msg.error);
                        setTimeout(() => {
                            if (draftAnalystBtn) draftAnalystBtn.innerText = 'DRAFT WITH ANALYST AGENT';
                        }, 2000);
                    }
                }
                break;
            }
            case 'saveFileContentResult': {
                const { success, conflict, diskContent, error, tab } = msg;
                const textarea = document.getElementById(tab === 'local' ? 'markdown-editor-local' : (tab === 'design' ? 'markdown-editor-design' : 'kanban-editor'));
                
                if (success) {
                    if (tab === 'local') {
                        state.activeDocContent = textarea.value;
                        exitEditMode('local', true);
                        markdownPreview.innerHTML = renderMarkdown(state.activeDocContent);
                        const statusLocal = document.getElementById('status');
                        if (statusLocal) {
                            statusLocal.textContent = 'Saved successfully';
                            statusLocal.style.color = 'var(--accent-teal)';
                            setTimeout(() => { statusLocal.textContent = ''; statusLocal.style.color = ''; }, 2000);
                        }
                    } else if (tab === 'design') {
                        state.activeDocContent = textarea.value;
                        exitEditMode('design', true);
                        const mdPrevDesign = document.getElementById('markdown-preview-design');
                        if (state.activeFileType === 'json') {
                            // Render JSON tree immediately from saved content
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
                            // YAML needs parsedJson from backend — trigger re-fetch
                            if (state.activeSource && state.activeDocId) {
                                const lastSlash = state.activeDocFilePath ? Math.max(state.activeDocFilePath.lastIndexOf('/'), state.activeDocFilePath.lastIndexOf('\\')) : -1;
                                vscode.postMessage({
                                    type: 'fetchPreview',
                                    sourceId: state.activeSource,
                                    docId: state.activeDocId,
                                    requestId: ++state.previewRequestId,
                                    sourceFolder: state.activeDocFilePath ? state.activeDocFilePath.substring(0, lastSlash) : undefined
                                });
                            }
                        } else {
                            if (mdPrevDesign) {
                                mdPrevDesign.innerHTML = renderMarkdown(state.activeDocContent);
                            }
                        }
                        const statusDesign = document.getElementById('status-design');
                        if (statusDesign) {
                            statusDesign.textContent = 'Saved successfully';
                            statusDesign.style.color = 'var(--accent-teal)';
                            setTimeout(() => { statusDesign.textContent = ''; statusDesign.style.color = ''; }, 2000);
                        }
                    } else {
                        state.editOriginalContent.kanban = textarea.value;
                        exitEditMode('kanban', true);
                        if (kanbanPreviewContent) {
                            kanbanPreviewContent.innerHTML = renderMarkdown(state.editOriginalContent.kanban);
                        }
                        // Show save success feedback in kanban controls strip
                        const kanbanStrip = document.querySelector('.kanban-controls-strip');
                        if (kanbanStrip) {
                            let statusKanban = kanbanStrip.querySelector('.kanban-save-status');
                            if (!statusKanban) {
                                statusKanban = document.createElement('span');
                                statusKanban.className = 'kanban-save-status';
                                statusKanban.style.cssText = 'font-size:11px; color:var(--accent-teal); margin-left:8px;';
                                kanbanStrip.appendChild(statusKanban);
                            }
                            statusKanban.textContent = 'Saved successfully';
                            setTimeout(() => { statusKanban.textContent = ''; }, 2000);
                        }
                    }
                } else if (conflict) {
                    const overwrite = confirm('Save Conflict! The file has been modified on disk by another process. Overwrite disk changes with your edits? (Click Cancel to reload from disk instead)');
                    if (overwrite) {
                        const filePath = (tab === 'local' || tab === 'design') ? state.activeDocFilePath : (_kanbanSelectedPlan ? _kanbanSelectedPlan.planFile : null);
                        vscode.postMessage({
                            type: 'saveFileContent',
                            filePath,
                            content: textarea.value,
                            originalContent: diskContent,
                            tab
                        });
                    } else {
                        if (tab === 'local') {
                            state.activeDocContent = diskContent;
                            textarea.value = diskContent;
                            state.editOriginalContent.local = diskContent;
                            state.dirtyFlags.local = false;
                        } else if (tab === 'design') {
                            state.activeDocContent = diskContent;
                            textarea.value = diskContent;
                            state.editOriginalContent.design = diskContent;
                            state.dirtyFlags.design = false;
                        } else {
                            state.editOriginalContent.kanban = diskContent;
                            textarea.value = diskContent;
                            state.dirtyFlags.kanban = false;
                        }
                        alert('Reloaded from disk.');
                    }
                } else {
                    alert('Error saving file: ' + (error || 'Unknown error'));
                }
                break;
            }
            // ===== TICKETS TAB IPC HANDLERS =====
            case 'linearProjectLoaded':
                linearProjectIssues = Array.isArray(msg.issues) ? msg.issues : [];
                linearProjectStatus = 'loaded';
                linearProjectMessage = '';
                linearProjectLoading = false;
                ticketsLoadedOnce = true;
                renderTicketsTab();
                break;
            case 'linearProjectsLoaded':
                linearAvailableProjects = msg.projects || [];
                break;
            case 'linearTaskDetailsLoaded':
                selectedLinearIssue = {
                    issue: msg.issue,
                    subtasks: msg.subtasks || [],
                    comments: msg.comments || [],
                    attachments: msg.attachments || [],
                    renderedDescriptionHtml: msg.renderedDescriptionHtml
                };
                renderTicketsTab();
                break;
            case 'clickupSpacesLoaded':
                clickUpAvailableSpaces = msg.spaces || [];
                clickUpAvailableFolders = [];
                clickUpAvailableListsInFolder = [];
                clickUpAvailableDirectLists = [];
                clickUpHierarchyLoading = false;
                renderTicketsTab();
                break;
            case 'clickupFoldersLoaded':
                clickUpAvailableFolders = msg.folders || [];
                clickUpAvailableListsInFolder = [];
                clickUpAvailableDirectLists = msg.directLists || [];
                clickUpHierarchyLoading = false;
                renderTicketsTab();
                break;
            case 'clickupListsLoaded':
                if (clickUpSelectedFolderId) {
                    clickUpAvailableListsInFolder = msg.lists || [];
                } else {
                    clickUpAvailableDirectLists = msg.lists || [];
                }
                clickUpHierarchyLoading = false;
                renderTicketsTab();
                break;
            case 'clickupProjectLoaded':
                clickUpProjectIssues = msg.tasks || [];
                clickUpProjectStatus = 'loaded';
                clickUpProjectMessage = '';
                clickUpProjectLoading = false;
                clickUpCurrentPage = msg.page || 0;
                clickUpProjectHasMore = msg.hasMore || false;
                ticketsLoadedOnce = true;
                renderTicketsTab();
                break;
            case 'clickupTaskDetailsLoaded':
                selectedClickUpIssue = {
                    task: msg.task,
                    subtasks: msg.subtasks || [],
                    comments: msg.comments || [],
                    attachments: msg.attachments || [],
                    renderedDescriptionHtml: msg.renderedDescriptionHtml
                };
                renderTicketsTab();
                break;
            case 'integrationProviderPreference':
                lastIntegrationProvider = msg.provider || null;
                currentWorkspaceRoot = msg.workspaceRoot || '';
                if (isTicketsTabActive()) {
                    if (lastIntegrationProvider === 'clickup') {
                        loadClickUpSpaces();
                    } else if (lastIntegrationProvider === 'linear') {
                        loadLinearProject();
                    }
                }
                break;
            case 'linearTaskImported':
            case 'clickupTaskImported':
                const { detailImportButton } = getTicketsTabElements();
                if (detailImportButton) detailImportButton.disabled = false;
                if (msg.success) {
                    alert('Task imported successfully!');
                } else {
                    alert('Import failed: ' + (msg.error || 'Unknown error'));
                }
                break;
            case 'linearTaskRefined':
            case 'clickupTaskRefined':
                if (msg.success) {
                    alert('Task refined successfully!');
                } else {
                    alert('Refine failed: ' + (msg.error || 'Unknown error'));
                }
                break;
        }
    });

    // Active Design Doc Banner handlers
    const btnDisableDocLocal = document.getElementById('btn-disable-doc-local');
    const btnDisableDocOnline = document.getElementById('btn-disable-doc-online');

    function updateLocalActiveContextButtonState() {
        if (!btnSetActiveContextLocal) return;
        const hasSelection = state.activeSource && state.activeDocId;
        const isLocalSelection = state.activeSource === 'local-folder';
        const isThisDocActive = state.activeDesignDocEnabled &&
            state.activeDesignDocSourceId === state.activeSource &&
            state.activeDesignDocId === state.activeDocId;

        if (!hasSelection || !isLocalSelection) {
            btnSetActiveContextLocal.disabled = true;
            btnSetActiveContextLocal.textContent = 'Set as Active Planning Context';
        } else if (isThisDocActive) {
            btnSetActiveContextLocal.disabled = false;
            btnSetActiveContextLocal.textContent = 'Turn off';
        } else {
            btnSetActiveContextLocal.disabled = false;
            btnSetActiveContextLocal.textContent = 'Set as Active Planning Context';
        }
    }

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
        const bannerDesign = document.getElementById('active-doc-banner-design');
        const nameDesign = document.getElementById('active-doc-name-design');
        if (bannerDesign) {
            bannerDesign.classList.toggle('inactive', !isActive);
            if (nameDesign) nameDesign.textContent = docName;
        }
        state.activeDesignDocEnabled = msg.enabled || false;
        state.activeDesignDocSourceId = msg.sourceId || null;
        state.activeDesignDocId = msg.docId || null;
        updateLocalActiveContextButtonState();
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
    const btnDisableDocDesign = document.getElementById('btn-disable-doc-design');
    if (btnDisableDocDesign) {
        btnDisableDocDesign.addEventListener('click', handleDisableDesignDoc);
    }

    // Button handlers
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
        const promptInput = document.getElementById('research-prompt-input');

        const customPrompt = promptInput ? promptInput.value.trim() : '';

        if (!customPrompt) {
            return '';
        }

        const STRUCTURED_PROMPT_RE = /^(ROLE|CONTEXT|OBJECTIVE|TASK|INSTRUCTIONS):/m;
        const isStructured = STRUCTURED_PROMPT_RE.test(customPrompt);

        if (isStructured) {
            return customPrompt;
        }

        const contextText = "General subject matter research";

        let prompt = `ROLE: You are a research analyst. Prefer authoritative primary sources over blogs and marketing copy; where sources conflict, say so explicitly.

CONTEXT: ${contextText}. The reader is a domain practitioner — explain domain-specific concepts; do not assume specialist expertise.

CENTRAL QUESTION: ${customPrompt}
SUB-QUESTIONS (cover all, lead with the first three):
  1. Core framing of the central question and key definitions
  2. What are the current best practices and authoritative standards?
  3. What are the key trade-offs and failure modes?
  4. What is the current state of the art and recent developments?

SOURCE GUIDANCE: Prefer official documentation, standards bodies, and peer-reviewed sources; distrust vendor marketing claims. Date-check all sources — flag anything older than 2 years. Separate "required" from "recommended" from "opinion" in every finding. Where law or standards are silent or ambiguous, say so rather than assuming applicability. Do not insert sources inline among the text; place all citations and links in the "Full source list" section only.

SCOPE: Primary focus is the central question above. Related domains and alternative approaches as clearly-labelled benchmarks only. Out of scope: unrelated domains and jurisdictions.

OUTPUT:
1) Executive summary (≤ 1 page)
2) Tiered findings: required vs recommended vs optional — clearly distinguish compliance levels
3) Focused trade-off evaluation (e.g. searchability vs confidentiality, cost vs coverage)
4) Actionable recommendations checklist
5) Plain-English glossary of domain-specific terms
6) Full source list with direct links and retrieval dates

DECISION THIS FEEDS: Recommended action plan — end with a recommended default.

DEPTH: Deep (50-100+ sources)`;

        return prompt;
    }

    // =========================================================================
    // KANBAN PLANS UI LOGIC
    // =========================================================================
    let _kanbanPlansCache = [];
    let _kanbanAllWorkspaceProjects = {};  // { [resolvedRoot]: string[] }
    let _kanbanWorkspaceItems = [];         // { workspaceRoot, label }[]
    let _kanbanSelectedPlan = null;
    let _kanbanPreviewRequestId = 0;
    let _kanbanAvailableColumns = [];  // { id, label, kind }[] — merged across workspaces

    
    const kanbanFilters = {
        column: '',
        workspaceRoot: '',
        project: '',
        search: ''
    };

    const kanbanColumnFilter = document.getElementById('kanban-column-filter');
    const kanbanWorkspaceFilter = document.getElementById('kanban-workspace-filter');
    const kanbanProjectFilter = document.getElementById('kanban-project-filter');
    const kanbanSearch = document.getElementById('kanban-search');
    const kanbanRefreshBtn = document.getElementById('kanban-refresh-btn');
    const btnImportKanbanPlans = document.getElementById('btn-import-kanban-plans');
    if (btnImportKanbanPlans) {
        btnImportKanbanPlans.addEventListener('click', () => {
            vscode.postMessage({ type: 'importPlans' });
        });
    }
    const kanbanListPane = document.getElementById('kanban-list-pane');
    const kanbanPreviewPane = document.getElementById('kanban-preview-pane');
    const kanbanPreviewContent = document.getElementById('kanban-preview-content');

    // Initial message in preview pane
    if (kanbanPreviewContent) {
        kanbanPreviewContent.innerHTML = '<div class="kanban-empty-state">Select a plan to preview</div>';
    }

    function enterReviewMode(tab) {
        if (tab !== 'kanban') return;
        if (state.editMode.kanban) {
            if (!exitEditMode('kanban', true)) return;
        }
        state.reviewMode.kanban = true;
        const btnEdit = document.getElementById('btn-edit-kanban');
        const btnReview = document.getElementById('btn-review-kanban');
        if (btnEdit) btnEdit.style.display = 'none';
        if (btnReview) {
            btnReview.textContent = 'EXIT REVIEW';
            btnReview.title = 'Exit review mode';
        }
    }

    function exitReviewMode(tab, clearPopup) {
        if (tab !== 'kanban') return;
        state.reviewMode.kanban = false;
        state.kanbanReviewSelectedText = '';
        if (clearPopup) {
            hideKanbanCommentPopup(true);
        }
        const btnEdit = document.getElementById('btn-edit-kanban');
        const btnReview = document.getElementById('btn-review-kanban');
        if (btnEdit) btnEdit.style.display = '';
        if (btnReview) {
            btnReview.textContent = 'REVIEW';
            btnReview.title = 'Review plan - select text and submit comment to planner';
        }
    }

    function hideKanbanCommentPopup(clear) {
        const popup = document.getElementById('kanban-comment-popup');
        if (popup) popup.classList.remove('visible');
        if (clear) {
            const input = document.getElementById('kanban-comment-input');
            if (input) input.value = '';
            state.kanbanReviewSelectedText = '';
        }
    }

    function showKanbanCommentPopup(rect, selectedText) {
        const popup = document.getElementById('kanban-comment-popup');
        if (!popup) return;
        const maxLeft = window.innerWidth - popup.offsetWidth - 12;
        const targetLeft = Math.max(12, Math.min(rect.left, maxLeft > 12 ? maxLeft : rect.left));
        const targetTop = Math.min(window.innerHeight - 12, rect.bottom + 10);
        popup.style.left = `${targetLeft}px`;
        popup.style.top = `${targetTop}px`;
        const preview = document.getElementById('kanban-selected-preview');
        if (preview) preview.textContent = selectedText;
        popup.classList.add('visible');
        const input = document.getElementById('kanban-comment-input');
        if (input) input.focus();
    }

    const kanbanCommentPopup = document.getElementById('kanban-comment-popup');

    if (kanbanPreviewContent) {
        kanbanPreviewContent.addEventListener('mouseup', () => {
            if (!state.reviewMode.kanban) return;
            setTimeout(() => {
                const selection = window.getSelection();
                if (!selection || selection.rangeCount === 0) {
                    hideKanbanCommentPopup(false);
                    return;
                }
                const text = selection.toString().trim();
                if (!text) {
                    hideKanbanCommentPopup(false);
                    return;
                }
                const range = selection.getRangeAt(0);
                const rect = range.getBoundingClientRect();
                state.kanbanReviewSelectedText = text;
                showKanbanCommentPopup(rect, text);
            }, 0);
        });

        kanbanPreviewContent.addEventListener('mousedown', (event) => {
            if (!state.reviewMode.kanban) return;
            if (kanbanCommentPopup && !kanbanCommentPopup.contains(event.target)) {
                const selection = window.getSelection();
                const selectedText = selection ? selection.toString().trim() : '';
                if (!selectedText) {
                    hideKanbanCommentPopup(false);
                }
            }
        });
    }

    const kanbanCancelComment = document.getElementById('kanban-cancel-comment');
    if (kanbanCancelComment) {
        kanbanCancelComment.addEventListener('click', () => hideKanbanCommentPopup(true));
    }

    const kanbanSubmitComment = document.getElementById('kanban-submit-comment');
    if (kanbanSubmitComment) {
        kanbanSubmitComment.addEventListener('click', () => {
            const commentInput = document.getElementById('kanban-comment-input');
            const comment = commentInput ? commentInput.value.trim() : '';
            if (!state.kanbanReviewSelectedText) {
                const preview = document.getElementById('kanban-selected-preview');
                if (preview) preview.style.borderColor = '#ff6b6b';
                setTimeout(() => { if (preview) preview.style.borderColor = ''; }, 2000);
                return;
            }
            if (!comment) {
                const commentInputEl = document.getElementById('kanban-comment-input');
                if (commentInputEl) {
                    commentInputEl.style.borderColor = '#ff6b6b';
                    setTimeout(() => { commentInputEl.style.borderColor = ''; }, 2000);
                }
                return;
            }
            vscode.postMessage({
                type: 'submitComment',
                sessionId: _kanbanSelectedPlan ? _kanbanSelectedPlan.sessionId : '',
                topic: _kanbanSelectedPlan ? _kanbanSelectedPlan.topic : '',
                planFileAbsolute: _kanbanSelectedPlan ? _kanbanSelectedPlan.planFile : '',
                selectedText: state.kanbanReviewSelectedText,
                comment
            });
        });
    }

    const btnReviewKanban = document.getElementById('btn-review-kanban');
    if (btnReviewKanban) {
        btnReviewKanban.addEventListener('click', () => {
            if (state.reviewMode.kanban) {
                exitReviewMode('kanban', true);
            } else {
                enterReviewMode('kanban');
            }
        });
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

            const metaParts = [plan.workspaceLabel];
            if (plan.project) metaParts.push(plan.project);

            const displayTime = plan.mtime > 0 ? formatRelativeTime(plan.mtime) : 'unknown';

            const columnDef = _kanbanAvailableColumns.find(c => c.id === plan.column);

            const columnOptions = _kanbanAvailableColumns.map(col =>
                `<option value="${escapeHtml(col.id)}" ${col.id === plan.column ? 'selected' : ''}>${escapeHtml(col.label)}</option>`
            ).join('');

            itemDiv.innerHTML = `
                <div style="width: 100%;">
                    <div style="display: flex; align-items: flex-start; gap: 8px;">
                        <span class="kanban-plan-topic">${escapeHtml(plan.topic)}</span>
                    </div>
                    <div class="kanban-plan-meta" style="margin-top: 4px;">
                        ${escapeHtml(metaParts.join(' · '))} · ${escapeHtml(displayTime)}
                    </div>
                    <div class="kanban-plan-actions">
                        <span class="kanban-column-badge clickable" data-column="${escapeHtml(plan.column)}" title="Click to change column">${escapeHtml(columnDef ? columnDef.label : plan.column)}</span>
                        <select class="kanban-column-dropdown" style="display:none;" data-session-id="${escapeHtml(plan.sessionId || '')}" data-plan-file="${escapeHtml(plan.planFile || '')}" data-workspace-root="${escapeHtml(plan.workspaceRoot)}">
                            ${columnOptions}
                        </select>
                        ${plan.planFile ? `<button class="kanban-plan-copy-link" data-plan-file="${escapeHtml(plan.planFile)}" title="Copy plan file path">Copy Link</button>` : ''}
                        ${plan.sessionId ? `<button class="kanban-plan-copy-prompt" data-session-id="${escapeHtml(plan.sessionId)}" data-column="${escapeHtml(plan.column)}" data-workspace-root="${escapeHtml(plan.workspaceRoot)}" title="Copy prompt and advance">Copy Prompt</button>` : ''}
                    </div>
                </div>
            `;

            // Row selection
            itemDiv.addEventListener('click', (e) => {
                if (state.dirtyFlags.kanban) {
                    if (!confirm('You have unsaved changes in Kanban Plans. Discard them?')) {
                        return;
                    }
                    exitEditMode('kanban', true);
                }
                if (state.reviewMode.kanban) {
                    exitReviewMode('kanban', true);
                }

                document.querySelectorAll('.kanban-plan-item').forEach(el => el.classList.remove('selected'));
                itemDiv.classList.add('selected');
                _kanbanSelectedPlan = plan;

                if (plan.planFile) {
                    if (kanbanPreviewContent) {
                        kanbanPreviewContent.innerHTML = '<div class="kanban-empty-state">Loading preview...</div>';
                    }
                    _kanbanPreviewRequestId++;
                    vscode.postMessage({
                        type: 'fetchKanbanPlanPreview',
                        filePath: plan.planFile,
                        requestId: _kanbanPreviewRequestId
                    });
                } else {
                    if (kanbanPreviewContent) {
                        kanbanPreviewContent.innerHTML = '<div class="kanban-empty-state">No plan file linked</div>';
                    }
                }
            });

            const copyLinkBtn = itemDiv.querySelector('.kanban-plan-copy-link');
            if (copyLinkBtn) {
                copyLinkBtn.addEventListener('click', (e) => {
                    e.stopPropagation(); // Prevent triggering plan selection
                    const planFile = copyLinkBtn.dataset.planFile;
                    if (planFile) {
                        navigator.clipboard.writeText(planFile).then(() => {
                            const originalText = copyLinkBtn.textContent;
                            copyLinkBtn.textContent = 'Copied';
                            setTimeout(() => {
                                copyLinkBtn.textContent = originalText;
                            }, 2000);
                        }).catch(err => {
                            console.error('Failed to copy plan file path:', err);
                            copyLinkBtn.textContent = 'Failed';
                            setTimeout(() => {
                                copyLinkBtn.textContent = 'Copy Link';
                            }, 2000);
                        });
                    }
                });
            }

            const copyPromptBtn = itemDiv.querySelector('.kanban-plan-copy-prompt');
            if (copyPromptBtn) {
                copyPromptBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const sessionId = copyPromptBtn.dataset.sessionId;
                    const column = copyPromptBtn.dataset.column;
                    const workspaceRoot = copyPromptBtn.dataset.workspaceRoot;
                    if (sessionId) {
                        copyPromptBtn.textContent = 'Copying…';
                        vscode.postMessage({
                            type: 'copyKanbanPlanPrompt',
                            sessionId,
                            column,
                            workspaceRoot
                        });
                    }
                });
            }

            const columnBadge = itemDiv.querySelector('.kanban-column-badge.clickable');
            const columnDropdown = itemDiv.querySelector('.kanban-column-dropdown');
            if (columnBadge && columnDropdown) {
                columnBadge.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const isHidden = columnDropdown.style.display === 'none';
                    // Hide all other dropdowns first
                    document.querySelectorAll('.kanban-column-dropdown').forEach(el => {
                        el.style.display = 'none';
                    });
                    columnDropdown.style.display = isHidden ? 'block' : 'none';
                    if (isHidden) {
                        columnDropdown.focus();
                    }
                });

                columnDropdown.addEventListener('change', (e) => {
                    e.stopPropagation();
                    const newColumn = columnDropdown.value;
                    const planFile = columnDropdown.dataset.planFile;
                    const workspaceRoot = columnDropdown.dataset.workspaceRoot;
                    if (planFile && newColumn) {
                        vscode.postMessage({
                            type: 'moveKanbanPlanColumn',
                            planFile,
                            newColumn,
                            workspaceRoot
                        });
                    }
                    columnDropdown.style.display = 'none';
                });

                columnDropdown.addEventListener('blur', () => {
                    setTimeout(() => {
                        columnDropdown.style.display = 'none';
                    }, 200);
                });
            }

            kanbanListPane.appendChild(itemDiv);
        });
    }

    function populateKanbanFilters() {
        if (!kanbanWorkspaceFilter || !kanbanProjectFilter) return;

        // --- Workspace dropdown ---
        const currentWS = kanbanFilters.workspaceRoot;
        kanbanWorkspaceFilter.innerHTML = '<option value="">All Workspaces</option>';
        _kanbanWorkspaceItems.forEach(ws => {
            const opt = document.createElement('option');
            opt.value = ws.workspaceRoot;
            opt.textContent = ws.label;
            if (ws.workspaceRoot === currentWS) opt.selected = true;
            kanbanWorkspaceFilter.appendChild(opt);
        });

        // --- Project dropdown ---
        updateKanbanProjectFilter();
    }

    function updateKanbanProjectFilter() {
        if (!kanbanProjectFilter) return;
        const selectedRoot = kanbanFilters.workspaceRoot;
        let projectSet;
        if (selectedRoot) {
            // Show only projects for selected workspace
            projectSet = new Set(_kanbanAllWorkspaceProjects[selectedRoot] || []);
        } else {
            // Aggregate all projects across all workspaces
            projectSet = new Set();
            Object.values(_kanbanAllWorkspaceProjects).forEach(projs => {
                projs.forEach(p => projectSet.add(p));
            });
        }

        // Also include sentinel for plans with no project
        const hasNoProject = _kanbanPlansCache.some(p =>
            (!selectedRoot || p.workspaceRoot === selectedRoot) && !p.project
        );

        const currentProj = kanbanFilters.project;
        kanbanProjectFilter.innerHTML = '<option value="">All Projects</option>';
        if (hasNoProject) {
            const optNone = document.createElement('option');
            optNone.value = '__none__';
            optNone.textContent = '(No Project)';
            if (currentProj === '__none__') optNone.selected = true;
            kanbanProjectFilter.appendChild(optNone);
        }
        Array.from(projectSet).sort().forEach(proj => {
            const opt = document.createElement('option');
            opt.value = proj;
            opt.textContent = proj;
            if (proj === currentProj) opt.selected = true;
            kanbanProjectFilter.appendChild(opt);
        });
    }

    function updateKanbanColumnFilter() {
        if (!kanbanColumnFilter) return;

        const currentColumn = kanbanFilters.column;
        kanbanColumnFilter.innerHTML = '<option value="">All Columns</option>';

        _kanbanAvailableColumns.forEach(col => {
            const opt = document.createElement('option');
            opt.value = col.id;       // Use backend ID for filtering
            opt.textContent = col.label;  // Use frontend label for display
            if (col.id === currentColumn) opt.selected = true;
            kanbanColumnFilter.appendChild(opt);
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
        // Refresh selected plan reference from updated cache
        if (_kanbanSelectedPlan) {
            const updated = _kanbanPlansCache.find(p => p.planId === _kanbanSelectedPlan.planId);
            if (updated) {
                _kanbanSelectedPlan = updated;
            } else {
                // Plan was deleted externally — clear selection
                _kanbanSelectedPlan = null;
                if (kanbanPreviewContent) {
                    kanbanPreviewContent.innerHTML = '<div class="kanban-empty-state">Select a plan to preview</div>';
                }
            }
        }
        _kanbanWorkspaceItems = msg.workspaceItems || [];
        _kanbanAllWorkspaceProjects = msg.allWorkspaceProjects || {};
        _kanbanAvailableColumns = msg.columns || [];  // NEW: store available columns

        populateKanbanFilters();
        updateKanbanColumnFilter();  // NEW: populate column dropdown
        renderKanbanPlans(_kanbanPlansCache, kanbanFilters);

        // Show transient "↻ refreshed" indicator
        if (typeof document.hasFocus === 'function' && document.hasFocus()) {
            const strip = document.querySelector('.kanban-controls-strip');
            if (strip) {
                let indicator = strip.querySelector('.kanban-auto-refresh-indicator');
                if (!indicator) {
                    indicator = document.createElement('span');
                    indicator.className = 'kanban-auto-refresh-indicator';
                    indicator.style.cssText = 'font-size:11px; color:var(--vscode-descriptionForeground); margin-left:8px; opacity:0; transition:opacity 0.3s;';
                    strip.appendChild(indicator);
                }
                indicator.textContent = '↻ refreshed';
                indicator.style.opacity = '1';
                clearTimeout(indicator._fadeTimer);
                indicator._fadeTimer = setTimeout(() => { indicator.style.opacity = '0'; }, 2000);
            }
        }
    }

    function handleKanbanPlanPreviewReady(msg) {
        // Allow auto-refreshes (requestId -1 or undefined) and matching request IDs
        if (msg.requestId !== undefined && msg.requestId !== -1 && msg.requestId !== _kanbanPreviewRequestId) return;
        if (!kanbanPreviewContent) return;

        if (msg.error) {
            kanbanPreviewContent.innerHTML = `<div class="kanban-empty-state" style="color: var(--vscode-errorForeground, #ff6b6b);">Error reading file: ${escapeHtml(msg.error)}</div>`;
            return;
        }

        // If user is in edit mode, defer the reload instead of clobbering
        if (state.editMode.kanban && msg.isAutoRefreshed) {
            state.externalChangePending.kanban = true;
            // Show warning in kanban controls strip
            const kanbanStrip = document.querySelector('.kanban-controls-strip');
            if (kanbanStrip) {
                let statusEl = kanbanStrip.querySelector('.kanban-external-change-warning');
                if (!statusEl) {
                    statusEl = document.createElement('span');
                    statusEl.className = 'kanban-external-change-warning';
                    statusEl.style.cssText = 'font-size:11px; color:var(--vscode-errorForeground, #ff6b6b); margin-left:8px;';
                    kanbanStrip.appendChild(statusEl);
                }
                statusEl.textContent = 'File changed externally — save to overwrite or cancel to reload';
            }
            return;
        }

        // Show auto-refresh notification (mirrors local tab behavior at line 1265)
        if (msg.isAutoRefreshed) {
            const kanbanStrip = document.querySelector('.kanban-controls-strip');
            if (kanbanStrip) {
                let statusEl = kanbanStrip.querySelector('.kanban-auto-refresh-indicator');
                if (!statusEl) {
                    statusEl = document.createElement('span');
                    statusEl.className = 'kanban-auto-refresh-indicator';
                    statusEl.style.cssText = 'font-size:11px; color:var(--accent-teal); margin-left:8px; opacity:0; transition:opacity 0.3s;';
                    kanbanStrip.appendChild(statusEl);
                }
                statusEl.textContent = 'Plan auto-refreshed';
                statusEl.style.opacity = '1';
                clearTimeout(statusEl._fadeTimer);
                statusEl._fadeTimer = setTimeout(() => { statusEl.style.opacity = '0'; }, 2000);
            }
        }

        // Clear any stale external-change warning (may have been set during a prior edit-mode deferral)
        const kanbanStripForCleanup = document.querySelector('.kanban-controls-strip');
        if (kanbanStripForCleanup) {
            const staleWarning = kanbanStripForCleanup.querySelector('.kanban-external-change-warning');
            if (staleWarning) staleWarning.remove();
        }

        // Store original content
        state.editOriginalContent.kanban = msg.content || '';
        state.dirtyFlags.kanban = false;

        if (msg.content) {
            kanbanPreviewContent.innerHTML = renderMarkdown(msg.content);
        } else {
            kanbanPreviewContent.innerHTML = '<div class="kanban-empty-state">Plan file is empty</div>';
        }

        const btnEditKanban = document.getElementById('btn-edit-kanban');
        if (btnEditKanban) {
            btnEditKanban.disabled = !_kanbanSelectedPlan || !_kanbanSelectedPlan.planFile;
        }
        const btnReviewKanban = document.getElementById('btn-review-kanban');
        if (btnReviewKanban) {
            btnReviewKanban.disabled = !_kanbanSelectedPlan || !_kanbanSelectedPlan.planFile;
        }
    }

    function handleKanbanContextSet(msg) {
        if (!msg.success) {
            alert('Failed to set active context: ' + (msg.error || 'Unknown error'));
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
            // Reset project filter when workspace changes to avoid stale selection
            kanbanFilters.project = '';
            if (kanbanProjectFilter) kanbanProjectFilter.value = '';
            updateKanbanProjectFilter();
            renderKanbanPlans(_kanbanPlansCache, kanbanFilters);
        });
    }

    if (kanbanProjectFilter) {
        kanbanProjectFilter.addEventListener('change', () => {
            kanbanFilters.project = kanbanProjectFilter.value;
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

    function setupTextareaTabInterceptor(textarea) {
        textarea.addEventListener('keydown', (e) => {
            if (e.key === 'Tab') {
                e.preventDefault();
                const start = textarea.selectionStart;
                const end = textarea.selectionEnd;
                const value = textarea.value;
                textarea.value = value.substring(0, start) + '    ' + value.substring(end);
                textarea.selectionStart = textarea.selectionEnd = start + 4;
                textarea.dispatchEvent(new Event('input'));
            }
        });
    }

    function enterEditMode(tab) {
        if (tab === 'kanban' && state.reviewMode.kanban) {
            exitReviewMode('kanban', true);
        }
        const previewPane = tab === 'local' ? document.getElementById('preview-pane') : (tab === 'design' ? document.getElementById('preview-pane-design') : document.getElementById('kanban-preview-pane'));
        const textarea = document.getElementById(tab === 'local' ? 'markdown-editor-local' : (tab === 'design' ? 'markdown-editor-design' : 'kanban-editor'));

        if (!previewPane || !textarea) return;

        let content = '';
        if (tab === 'local' || tab === 'design') {
            content = state.activeDocContent || '';
            state.editOriginalContent[tab] = content;
        } else {
            content = state.editOriginalContent.kanban || '';
        }

        textarea.value = content;
        previewPane.classList.add('edit-mode');

        const btnEdit = document.getElementById(tab === 'local' ? 'btn-edit-local' : (tab === 'design' ? 'btn-edit-design' : 'btn-edit-kanban'));
        const btnSave = document.getElementById(tab === 'local' ? 'btn-save-local' : (tab === 'design' ? 'btn-save-design' : 'btn-save-kanban'));
        const btnCancel = document.getElementById(tab === 'local' ? 'btn-cancel-local' : (tab === 'design' ? 'btn-cancel-design' : 'btn-cancel-kanban'));

        if (btnEdit) btnEdit.style.display = 'none';
        if (btnSave) btnSave.style.display = '';
        if (btnCancel) btnCancel.style.display = '';

        // Hide JSON preview container when entering edit mode for design tab
        if (tab === 'design') {
            const jsonCont = document.getElementById('json-preview-container-design');
            if (jsonCont) jsonCont.style.display = 'none';
        }

        state.editMode[tab] = true;
        state.dirtyFlags[tab] = false;
    }

    function exitEditMode(tab, discard) {
        if (!discard && state.dirtyFlags[tab]) {
            if (!confirm('You have unsaved changes. Discard them?')) {
                return false;
            }
        }

        const previewPane = tab === 'local' ? document.getElementById('preview-pane') : (tab === 'design' ? document.getElementById('preview-pane-design') : document.getElementById('kanban-preview-pane'));
        if (previewPane) {
            previewPane.classList.remove('edit-mode');
        }

        const btnEdit = document.getElementById(tab === 'local' ? 'btn-edit-local' : (tab === 'design' ? 'btn-edit-design' : 'btn-edit-kanban'));
        const btnSave = document.getElementById(tab === 'local' ? 'btn-save-local' : (tab === 'design' ? 'btn-save-design' : 'btn-save-kanban'));
        const btnCancel = document.getElementById(tab === 'local' ? 'btn-cancel-local' : (tab === 'design' ? 'btn-cancel-design' : 'btn-cancel-kanban'));

        if (btnEdit) btnEdit.style.display = '';
        if (btnSave) btnSave.style.display = 'none';
        if (btnCancel) btnCancel.style.display = 'none';

        state.editMode[tab] = false;
        state.dirtyFlags[tab] = false;

        // Show JSON tree instead of markdown preview for JSON/YAML files
        if (tab === 'design' && !discard) {
            if (state.activeFileType === 'json' || state.activeFileType === 'yaml') {
                const mdPrev = document.getElementById('markdown-preview-design');
                const jsonCont = document.getElementById('json-preview-container-design');
                if (mdPrev) mdPrev.style.display = 'none';
                if (jsonCont) {
                    jsonCont.style.display = 'block';
                    jsonCont.innerHTML = '';
                    try {
                        if (state.activeFileType === 'json') {
                            jsonCont.appendChild(renderJsonTree(JSON.parse(state.activeDocContent)));
                        }
                        // For YAML: the tree was already rendered from parsedJson in handlePreviewReady;
                        // after save, re-fetch triggers handlePreviewReady which will re-render
                    } catch (e) {
                        jsonCont.innerHTML = `<div class="json-error">Parse error: ${e.message}</div>`;
                    }
                }
            }
        }

        // Trigger deferred reload if an external change was pending
        if (state.externalChangePending[tab]) {
            state.externalChangePending[tab] = false;
            if (tab === 'kanban' && _kanbanSelectedPlan && _kanbanSelectedPlan.planFile) {
                _kanbanPreviewRequestId++;
                vscode.postMessage({
                    type: 'fetchKanbanPlanPreview',
                    filePath: _kanbanSelectedPlan.planFile,
                    requestId: _kanbanPreviewRequestId
                });
            } else if (tab === 'local' || tab === 'design') {
                if (state.activeSource === 'local-folder' || state.activeSource === 'html-folder' || state.activeSource === 'design-folder') {
                    const lastSlash = state.activeDocFilePath ? Math.max(state.activeDocFilePath.lastIndexOf('/'), state.activeDocFilePath.lastIndexOf('\\')) : -1;
                    vscode.postMessage({
                        type: 'fetchPreview',
                        sourceId: state.activeSource,
                        docId: state.activeDocId,
                        requestId: ++state.previewRequestId,
                        sourceFolder: state.activeDocFilePath ? state.activeDocFilePath.substring(0, lastSlash) : undefined
                    });
                } else {
                    vscode.postMessage({
                        type: 'fetchDocsFile',
                        slugPrefix: state.activeDocId,
                        requestId: ++state.previewRequestId
                    });
                }
            }
        }

        return true;
    }

    // Wire up edit buttons
    const btnEditLocal = document.getElementById('btn-edit-local');
    const btnSaveLocal = document.getElementById('btn-save-local');
    const btnCancelLocal = document.getElementById('btn-cancel-local');
    const markdownEditorLocal = document.getElementById('markdown-editor-local');

    if (btnEditLocal) {
        btnEditLocal.addEventListener('click', () => enterEditMode('local'));
    }
    if (btnSaveLocal) {
        btnSaveLocal.addEventListener('click', () => {
            const filePath = state.activeDocFilePath;
            const content = markdownEditorLocal ? markdownEditorLocal.value : '';
            const originalContent = state.editOriginalContent.local;
            if (filePath) {
                vscode.postMessage({
                    type: 'saveFileContent',
                    filePath,
                    content,
                    originalContent,
                    tab: 'local'
                });
            }
        });
    }
    if (btnCancelLocal) {
        btnCancelLocal.addEventListener('click', () => exitEditMode('local', false));
    }
    if (markdownEditorLocal) {
        markdownEditorLocal.addEventListener('input', () => {
            state.dirtyFlags.local = true;
        });
        setupTextareaTabInterceptor(markdownEditorLocal);
    }

    const btnEditKanban = document.getElementById('btn-edit-kanban');
    const btnSaveKanban = document.getElementById('btn-save-kanban');
    const btnCancelKanban = document.getElementById('btn-cancel-kanban');
    const kanbanEditor = document.getElementById('kanban-editor');

    if (btnEditKanban) {
        btnEditKanban.addEventListener('click', () => enterEditMode('kanban'));
    }
    if (btnSaveKanban) {
        btnSaveKanban.addEventListener('click', () => {
            const filePath = _kanbanSelectedPlan ? _kanbanSelectedPlan.planFile : null;
            const content = kanbanEditor ? kanbanEditor.value : '';
            const originalContent = state.editOriginalContent.kanban;
            if (filePath) {
                vscode.postMessage({
                    type: 'saveFileContent',
                    filePath,
                    content,
                    originalContent,
                    tab: 'kanban'
                });
            }
        });
    }
    if (btnCancelKanban) {
        btnCancelKanban.addEventListener('click', () => exitEditMode('kanban', false));
    }
    if (kanbanEditor) {
        kanbanEditor.addEventListener('input', () => {
            state.dirtyFlags.kanban = true;
        });
        setupTextareaTabInterceptor(kanbanEditor);
    }

    const btnEditDesign = document.getElementById('btn-edit-design');
    const btnSaveDesign = document.getElementById('btn-save-design');
    const btnCancelDesign = document.getElementById('btn-cancel-design');
    const markdownEditorDesign = document.getElementById('markdown-editor-design');

    if (btnEditDesign) {
        btnEditDesign.addEventListener('click', () => enterEditMode('design'));
    }
    if (btnSaveDesign) {
        btnSaveDesign.addEventListener('click', () => {
            const filePath = state.activeDocFilePath;
            const content = markdownEditorDesign ? markdownEditorDesign.value : '';
            const originalContent = state.editOriginalContent.design;
            if (filePath) {
                vscode.postMessage({
                    type: 'saveFileContent',
                    filePath,
                    content,
                    originalContent,
                    tab: 'design'
                });
            }
        });
    }
    if (btnCancelDesign) {
        btnCancelDesign.addEventListener('click', () => exitEditMode('design', false));
    }
    if (markdownEditorDesign) {
        markdownEditorDesign.addEventListener('input', () => {
            state.dirtyFlags.design = true;
        });
        setupTextareaTabInterceptor(markdownEditorDesign);
    }

    const btnSetActiveDesign = document.getElementById('btn-set-active-context-design');
    if (btnSetActiveDesign) {
        btnSetActiveDesign.addEventListener('click', () => {
            if (!state.activeSource || !state.activeDocId) return;
            btnSetActiveDesign.disabled = true;
            const statusDesign = document.getElementById('status-design');
            if (statusDesign) {
                statusDesign.textContent = 'Setting as active planning context...';
                statusDesign.style.color = '';
            }
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

    if (btnSetActiveContextLocal) {
        btnSetActiveContextLocal.addEventListener('click', () => {
            if (!state.activeSource || !state.activeDocId) return;
            const isThisDocActive = state.activeDesignDocEnabled &&
                state.activeDesignDocSourceId === state.activeSource &&
                state.activeDesignDocId === state.activeDocId;

            if (isThisDocActive) {
                vscode.postMessage({ type: 'disableDesignDoc' });
            } else {
                const wrapper = findTreeNode(state.activeSource, state.activeDocId);
                const sourceFolder = wrapper ? wrapper.dataset.sourceFolder : undefined;
                vscode.postMessage({
                    type: 'setActivePlanningContext',
                    sourceId: state.activeSource,
                    docId: state.activeDocId,
                    docName: state.activeDocName || state.activeDocId,
                    sourceFolder
                });
            }
        });
    }

    const btnLinkToDesign = document.getElementById('btn-link-to-doc-design');
    if (btnLinkToDesign) {
        btnLinkToDesign.addEventListener('click', () => {
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

    // Folder modal open logic
    function openFoldersModal() {
        const modal = document.getElementById('folder-modal');
        modal.style.display = 'flex';
        // Sync antigravity toggle state from JS state
        const modalToggle = document.getElementById('antigravity-toggle-modal');
        modalToggle.checked = !!state.antigravityEnabled;
        // Render folder list from current state (fast-path for pre-warmed state)
        renderFolderListModal();
        // Request fresh folder list from backend to ensure sync (catches startup race)
        vscode.postMessage({ type: 'refreshSource', sourceId: 'local-folder' });
    }

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
            // Don't close modal if focus is in a text input — Escape should clear the field instead
            const tag = e.target.tagName.toLowerCase();
            if (tag === 'textarea' || tag === 'input' || tag === 'select') return;
            const modal = document.getElementById('folder-modal');
            if (modal && modal.style.display !== 'none') {
                modal.style.display = 'none';
            }
            const modalHtml = document.getElementById('folder-modal-html');
            if (modalHtml && modalHtml.style.display !== 'none') {
                modalHtml.style.display = 'none';
            }
            const modalDesign = document.getElementById('folder-modal-design');
            if (modalDesign && modalDesign.style.display !== 'none') {
                modalDesign.style.display = 'none';
            }
        }
    });

    // Antigravity toggle in modal — send message directly
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

    // HTML Folder modal close (X button)
    const btnCloseHtmlFolderModal = document.getElementById('btn-close-html-folder-modal');
    if (btnCloseHtmlFolderModal) {
        btnCloseHtmlFolderModal.addEventListener('click', () => {
            const modal = document.getElementById('folder-modal-html');
            if (modal) modal.style.display = 'none';
        });
    }

    // HTML Folder modal close (backdrop click)
    const folderModalHtml = document.getElementById('folder-modal-html');
    if (folderModalHtml) {
        folderModalHtml.addEventListener('click', (e) => {
            if (e.target.id === 'folder-modal-html') {
                e.target.style.display = 'none';
            }
        });
    }

    // Modal HTML folder management buttons
    const btnRefreshHtmlFoldersModal = document.getElementById('btn-refresh-html-folders-modal');
    if (btnRefreshHtmlFoldersModal) {
        btnRefreshHtmlFoldersModal.addEventListener('click', () => {
            vscode.postMessage({ type: 'refreshSource', sourceId: 'html-folder' });
        });
    }

    const btnAddHtmlFolderModal = document.getElementById('btn-add-html-folder-modal');
    if (btnAddHtmlFolderModal) {
        btnAddHtmlFolderModal.addEventListener('click', () => {
            vscode.postMessage({ type: 'addHtmlFolder' });
        });
    }

    // ===== TICKETS TAB IMPLEMENTATION =====

    function initTicketsTab() {
        const { searchInput, projectPicker, stateFilter, clickUpStatusFilter, refreshButton, loadMoreButton, backToListButton, backToParentButton } = getTicketsTabElements();

        // Search input with debounce
        let searchDebounceTimer = null;
        searchInput?.addEventListener('input', (e) => {
            clearTimeout(searchDebounceTimer);
            searchDebounceTimer = setTimeout(() => {
                if (lastIntegrationProvider === 'linear') {
                    linearProjectSearchValue = e.target.value;
                    renderTicketsLinearList();
                } else if (lastIntegrationProvider === 'clickup') {
                    clickUpProjectSearchValue = e.target.value;
                    renderTicketsClickUpList();
                }
            }, 300);
        });

        // Project picker (Linear)
        projectPicker?.addEventListener('change', (e) => {
            linearProjectPickerValue = e.target.value;
            renderTicketsLinearList();
        });

        // State filter (Linear)
        stateFilter?.addEventListener('change', (e) => {
            linearProjectStateFilterValue = e.target.value;
            renderTicketsLinearList();
        });

        // Status filter (ClickUp)
        clickUpStatusFilter?.addEventListener('change', (e) => {
            clickUpProjectStatusFilterValue = e.target.value;
            renderTicketsClickUpList();
        });

        // Refresh button
        refreshButton?.addEventListener('click', () => {
            if (lastIntegrationProvider === 'linear') {
                loadLinearProject(true);
            } else if (lastIntegrationProvider === 'clickup') {
                if (clickUpSelectedListId) {
                    loadClickUpProject(true);
                } else {
                    loadClickUpSpaces();
                }
            }
        });

        // Load more button (ClickUp pagination)
        loadMoreButton?.addEventListener('click', loadMoreClickUpTasks);

        // Back buttons
        backToListButton?.addEventListener('click', () => {
            selectedLinearIssue = null;
            selectedClickUpIssue = null;
            renderTicketsTab();
        });

        backToParentButton?.addEventListener('click', () => {
            const parentId = backToParentButton.dataset.parentId;
            if (parentId) {
                loadLinearTaskDetails(parentId);
            }
        });

        // Detail action buttons (delegated)
        document.querySelector('.tickets-task-view')?.addEventListener('click', (e) => {
            const importBtn = e.target.closest('[data-import-issue-id], [data-import-task-id]');
            const refineBtn = e.target.closest('[data-refine-issue-id], [data-refine-task-id]');
            const askAgentBtn = e.target.closest('#tickets-detail-ask-agent');

            if (importBtn) {
                const id = importBtn.dataset.importIssueId || importBtn.dataset.importTaskId;
                const provider = lastIntegrationProvider;
                handleTicketsImport(provider, id, true);
            }

            if (refineBtn) {
                const id = refineBtn.dataset.refineIssueId || refineBtn.dataset.refineTaskId;
                const title = refineBtn.dataset.issueTitle || '';
                const description = refineBtn.dataset.issueDescription || '';
                const provider = lastIntegrationProvider;
                handleTicketsRefine(provider, id, title, description);
            }

            if (askAgentBtn) {
                // Show "not yet implemented" stub
                alert('Ask Agent feature is not yet implemented in the Planning panel.');
            }
        });

        // Issue card clicks (delegated)
        document.getElementById('tickets-issues-container')?.addEventListener('click', (e) => {
            const card = e.target.closest('[data-linear-issue-id], [data-clickup-task-id]');
            if (card) {
                const linearId = card.dataset.linearIssueId;
                const clickUpId = card.dataset.clickupTaskId;
                if (linearId) {
                    loadLinearTaskDetails(linearId);
                } else if (clickUpId) {
                    loadClickUpTaskDetails(clickUpId);
                }
            }
        });
    }

    // ===== RENDERING FUNCTIONS =====

    function renderTicketsTab() {
        if (!isTicketsTabActive()) return;

        if (lastIntegrationProvider === 'linear') {
            renderTicketsLinearPanel();
        } else if (lastIntegrationProvider === 'clickup') {
            renderTicketsClickUpPanel();
        }
    }

    function renderTicketsLinearPanel() {
        if (lastIntegrationProvider !== 'linear' || !isTicketsTabActive()) return;

        const { listView, taskView, searchInput, projectPicker, stateFilter, clickUpStatusFilter, refreshButton, emptyState } = getTicketsTabElements();
        if (!listView || !taskView) return;

        // Show Linear toolbar elements
        if (searchInput) searchInput.style.display = '';
        if (projectPicker) projectPicker.style.display = '';
        if (stateFilter) stateFilter.style.display = '';
        if (clickUpStatusFilter) clickUpStatusFilter.style.display = 'none';
        if (refreshButton) refreshButton.style.display = '';

        renderTicketsLinearStateFilterOptions();
        renderTicketsLinearProjectPickerOptions();

        const showTaskView = !!selectedLinearIssue;
        listView.style.display = showTaskView ? 'none' : 'flex';
        taskView.style.display = showTaskView ? 'flex' : 'none';

        renderTicketsLinearList();
        renderTicketsLinearTaskDetail();
    }

    function renderTicketsLinearStateFilterOptions() {
        const { stateFilter } = getTicketsTabElements();
        if (!stateFilter) return;

        const states = Array.from(new Set(
            linearProjectIssues
                .map((issue) => String(issue?.state?.name || '').trim())
                .filter(Boolean)
        )).sort((left, right) => left.localeCompare(right));

        const newHtml = `<option value="">All states</option>${states.map((state) =>
            `<option value="${escapeAttr(state)}">${escapeHtml(state)}</option>`
        ).join('')}`;

        if (_lastTicketsStateFilterHtml !== newHtml) {
            stateFilter.innerHTML = newHtml;
            _lastTicketsStateFilterHtml = newHtml;
        }

        stateFilter.value = states.includes(linearProjectStateFilterValue) ? linearProjectStateFilterValue : '';
        linearProjectStateFilterValue = stateFilter.value;
    }

    function renderTicketsLinearProjectPickerOptions() {
        const { projectPicker } = getTicketsTabElements();
        if (!projectPicker) return;

        const projects = Array.from(new Set(
            linearProjectIssues
                .map((issue) => String(issue?.project?.name || '').trim())
                .filter(Boolean)
        )).sort();

        const newHtml = `<option value="">All projects</option>${projects.map((project) =>
            `<option value="${escapeAttr(project)}">${escapeHtml(project)}</option>`
        ).join('')}`;

        if (_lastTicketsProjectPickerHtml !== newHtml) {
            projectPicker.innerHTML = newHtml;
            _lastTicketsProjectPickerHtml = newHtml;
        }

        projectPicker.value = projects.includes(linearProjectPickerValue) ? linearProjectPickerValue : '';
        linearProjectPickerValue = projectPicker.value;
    }

    function getFilteredLinearIssues() {
        const search = String(linearProjectSearchValue || '').trim().toLowerCase();
        const stateFilter = String(linearProjectStateFilterValue || '').trim();
        const projectFilter = String(linearProjectPickerValue || '').trim();
        return linearProjectIssues.filter((issue) => {
            if (issue?.parentId) return false;
            if (stateFilter && String(issue?.state?.name || '') !== stateFilter) return false;
            if (projectFilter && String(issue?.project?.name || '') !== projectFilter) return false;
            if (!search) return true;
            const haystack = [
                issue.identifier,
                issue.title,
                issue.description,
                issue.assignee?.name,
                issue.assignee?.email
            ].join('\n').toLowerCase();
            return haystack.includes(search);
        });
    }

    function renderTicketsLinearList() {
        if (!isTicketsTabActive()) return;

        const { emptyState, issuesContainer, searchInput } = getTicketsTabElements();
        if (!emptyState || !issuesContainer) return;

        if (searchInput && searchInput.value !== linearProjectSearchValue) {
            searchInput.value = linearProjectSearchValue;
        }

        if (linearProjectStatus === 'loading') {
            emptyState.textContent = linearProjectMessage || 'Loading Linear project...';
            emptyState.style.display = '';
            issuesContainer.innerHTML = '';
            _lastTicketsIssuesContainerHtml = '';
            return;
        }

        if (linearProjectStatus !== 'loaded') {
            emptyState.textContent = linearProjectMessage || 'Set up Linear in Setup first.';
            emptyState.style.display = '';
            issuesContainer.innerHTML = '';
            _lastTicketsIssuesContainerHtml = '';
            return;
        }

        const filteredIssues = getFilteredLinearIssues();
        if (filteredIssues.length === 0) {
            const emptyText = linearProjectIssues.length === 0
                ? 'No Linear issues are currently available.'
                : 'No Linear issues matched the current search/filter.';
            if (emptyState.textContent !== emptyText) {
                emptyState.textContent = emptyText;
            }
            emptyState.style.display = '';
            if (_lastTicketsIssuesContainerHtml !== '') {
                issuesContainer.innerHTML = '';
                _lastTicketsIssuesContainerHtml = '';
            }
            return;
        }

        emptyState.style.display = 'none';

        const newHtml = filteredIssues.map((issue) => {
            return `
            <div class="tickets-issue-card" data-linear-issue-id="${escapeAttr(issue.id)}">
                <div class="tickets-issue-title">${escapeHtml(issue.title || issue.identifier || issue.id)}</div>
                <div class="tickets-issue-meta">${escapeHtml(issue.state?.name || 'Unknown state')}</div>
                <div class="tickets-issue-meta">${escapeHtml(issue.assignee?.name || issue.assignee?.email || 'Unassigned')}</div>
                <div class="tickets-issue-meta">${escapeHtml((issue.description || '').trim().slice(0, 180) || 'No description provided.')}</div>
                <div style="display:flex; justify-content:flex-end; margin-top:8px; gap:4px;">
                    <button type="button" class="tickets-issue-import-btn" data-refine-issue-id="${escapeAttr(issue.id)}" data-issue-title="${escapeAttr(issue.title || '')}" data-issue-description="${escapeAttr(issue.description || '')}">REFINE</button>
                    <button type="button" class="tickets-issue-import-btn" data-import-issue-id="${escapeAttr(issue.id)}">IMPORT</button>
                </div>
            </div>
            `;
        }).join('');

        if (_lastTicketsIssuesContainerHtml !== newHtml) {
            issuesContainer.innerHTML = newHtml;
            _lastTicketsIssuesContainerHtml = newHtml;
        }
    }

    function renderTicketsLinearTaskDetail() {
        if (!isTicketsTabActive()) return;

        const { detailTitle, detailStatus, detailAssignee, detailDescription, detailSubtasks, detailComments, detailAttachments, detailImportButton, detailRefineButton, detailAskAgentButton, backToParentButton } = getTicketsTabElements();
        if (!detailTitle || !detailStatus || !detailAssignee || !detailDescription) return;

        if (!selectedLinearIssue) {
            detailTitle.textContent = 'Select a task';
            detailStatus.textContent = '';
            detailAssignee.textContent = '';
            const noSelectionHtml = '<div class="empty-state">Choose a task from the list to inspect details.</div>';
            if (_lastTicketsDetailDescriptionHtml !== noSelectionHtml) {
                detailDescription.innerHTML = noSelectionHtml;
                _lastTicketsDetailDescriptionHtml = noSelectionHtml;
            }
            if (detailSubtasks && _lastTicketsDetailSubtasksHtml !== '') { detailSubtasks.innerHTML = ''; _lastTicketsDetailSubtasksHtml = ''; }
            if (detailComments && _lastTicketsDetailCommentsHtml !== '') { detailComments.innerHTML = ''; _lastTicketsDetailCommentsHtml = ''; }
            if (detailAttachments && _lastTicketsDetailAttachmentsHtml !== '') { detailAttachments.innerHTML = ''; _lastTicketsDetailAttachmentsHtml = ''; }
            if (detailImportButton) detailImportButton.disabled = true;
            if (detailRefineButton) detailRefineButton.disabled = true;
            if (detailAskAgentButton) detailAskAgentButton.disabled = true;
            if (backToParentButton) {
                backToParentButton.style.display = 'none';
                delete backToParentButton.dataset.parentId;
            }
            return;
        }

        const issue = selectedLinearIssue.issue;
        detailTitle.textContent = issue.title || issue.identifier || issue.id;
        detailStatus.textContent = issue.state?.name || 'Unknown status';
        detailAssignee.textContent = `Assignee: ${issue.assignee?.name || issue.assignee?.email || 'Unassigned'}`;

        if (backToParentButton) {
            const parentId = issue.parentId;
            if (parentId) {
                backToParentButton.style.display = '';
                backToParentButton.dataset.parentId = parentId;
            } else {
                backToParentButton.style.display = 'none';
                delete backToParentButton.dataset.parentId;
            }
        }

        if (selectedLinearIssue.renderedDescriptionHtml) {
            if (_lastTicketsDetailDescriptionHtml !== selectedLinearIssue.renderedDescriptionHtml) {
                detailDescription.innerHTML = selectedLinearIssue.renderedDescriptionHtml;
                _lastTicketsDetailDescriptionHtml = selectedLinearIssue.renderedDescriptionHtml;
            }
        } else {
            const plainHtml = escapeHtml((issue.description || '').trim() || 'No description provided.').replace(/\n/g, '<br>');
            if (_lastTicketsDetailDescriptionHtml !== plainHtml) {
                detailDescription.innerHTML = plainHtml;
                _lastTicketsDetailDescriptionHtml = plainHtml;
            }
        }

        if (detailSubtasks) {
            const newSubtasksHtml = selectedLinearIssue.subtasks.length > 0
                ? selectedLinearIssue.subtasks.map((subtask) => `
                    <div class="planning-card" data-linear-subtask-id="${escapeAttr(subtask.id)}">
                        <div class="planning-card-header">${escapeHtml(subtask.title || subtask.identifier || subtask.id)}</div>
                        <div class="planning-status">${escapeHtml(subtask.state?.name || 'Unknown state')}</div>
                        <div style="display:flex; justify-content:flex-end; margin-top:8px; gap:4px;">
                            <button type="button" class="planning-button" data-refine-issue-id="${escapeAttr(subtask.id)}" data-issue-title="${escapeAttr(subtask.title || '')}" data-issue-description="${escapeAttr(subtask.description || '')}">REFINE</button>
                            <button type="button" class="planning-button" data-import-issue-id="${escapeAttr(subtask.id)}">IMPORT</button>
                        </div>
                    </div>
                `).join('')
                : '<div class="empty-state">No subtasks attached to this issue.</div>';
            if (_lastTicketsDetailSubtasksHtml !== newSubtasksHtml) {
                detailSubtasks.innerHTML = newSubtasksHtml;
                _lastTicketsDetailSubtasksHtml = newSubtasksHtml;
            }
        }

        if (detailComments) {
            const newCommentsHtml = selectedLinearIssue.comments.length > 0
                ? selectedLinearIssue.comments.map((comment) => `
                    <div class="planning-card">
                        <div class="planning-card-header">${escapeHtml(comment.user?.name || comment.user?.email || 'Unknown')}</div>
                        <div class="planning-card-description">${escapeHtml(comment.createdAt ? comment.createdAt.slice(0, 10) : '')}</div>
                        <div class="planning-card-description">${escapeHtml(comment.body || '').replace(/\n/g, '<br>')}</div>
                    </div>
                `).join('')
                : '<div class="empty-state">No comments attached to this issue.</div>';
            if (_lastTicketsDetailCommentsHtml !== newCommentsHtml) {
                detailComments.innerHTML = newCommentsHtml;
                _lastTicketsDetailCommentsHtml = newCommentsHtml;
            }
        }

        if (detailAttachments) {
            const newAttachmentsHtml = selectedLinearIssue.attachments.length > 0
                ? selectedLinearIssue.attachments.map((attachment) => `
                    <button type="button" class="planning-button secondary" data-linear-attachment-url="${escapeAttr(attachment.url || '')}">
                        ${escapeHtml(attachment.title || attachment.filename || attachment.url || 'Attachment')}
                    </button>
                `).join('')
                : '<div class="empty-state">No attachments attached to this issue.</div>';
            if (_lastTicketsDetailAttachmentsHtml !== newAttachmentsHtml) {
                detailAttachments.innerHTML = newAttachmentsHtml;
                _lastTicketsDetailAttachmentsHtml = newAttachmentsHtml;
            }
        }

        if (detailAskAgentButton) detailAskAgentButton.disabled = false;
        if (detailImportButton) detailImportButton.disabled = false;
        if (detailRefineButton) detailRefineButton.disabled = false;
    }

    // ===== CLICKUP RENDERING FUNCTIONS =====

    function renderTicketsClickUpPanel() {
        if (lastIntegrationProvider !== 'clickup' || !isTicketsTabActive()) return;

        const { listView, taskView, searchInput, projectPicker, stateFilter, clickUpStatusFilter, refreshButton, emptyState, issuesContainer, hierarchyNav } = getTicketsTabElements();
        if (!listView || !taskView) return;

        // Hide Linear toolbar elements, show ClickUp hierarchy
        if (searchInput) searchInput.style.display = 'none';
        if (projectPicker) projectPicker.style.display = 'none';
        if (stateFilter) stateFilter.style.display = 'none';
        if (clickUpStatusFilter) {
            clickUpStatusFilter.style.display = clickUpSelectedListId ? '' : 'none';
        }
        if (refreshButton) refreshButton.style.display = '';
        if (hierarchyNav) hierarchyNav.style.display = '';

        if (emptyState) {
            if (!clickUpSelectedListId) {
                emptyState.textContent = 'No list selected. Please select a Space, Folder, and List to view tasks.';
                emptyState.style.display = '';
            } else if (clickUpProjectStatus !== 'loaded') {
                emptyState.textContent = clickUpProjectMessage || 'Loading tasks...';
                emptyState.style.display = '';
            } else {
                emptyState.style.display = 'none';
            }
        }

        if (lastIntegrationProvider === 'clickup') {
            renderTicketsClickUpHierarchyNav();
        }

        if (clickUpSelectedListId) {
            renderTicketsClickUpStatusFilterOptions();
            renderTicketsClickUpList();
        } else {
            if (issuesContainer) {
                issuesContainer.innerHTML = '';
            }
        }

        renderTicketsClickUpTaskDetail();

        const showTaskView = !!selectedClickUpIssue;
        listView.style.display = showTaskView ? 'none' : 'flex';
        taskView.style.display = showTaskView ? 'flex' : 'none';
    }

    function renderTicketsClickUpHierarchyNav() {
        const { hierarchyNav } = getTicketsTabElements();
        if (!hierarchyNav) return;

        const html = buildTicketsHierarchyHtml();
        if (_lastTicketsHierarchyHtml !== html) {
            hierarchyNav.innerHTML = html;
            _lastTicketsHierarchyHtml = html;
            attachTicketsHierarchyListeners();
        }
    }

    function buildTicketsHierarchyHtml() {
        const parts = [];

        if (!clickUpSelectedSpaceId) {
            parts.push(`
                <select id="tickets-space-select" class="planning-select">
                    <option value="">Select Space...</option>
                    ${clickUpAvailableSpaces.map(s => `<option value="${escapeAttr(s.id)}">${escapeHtml(s.name)}</option>`).join('')}
                </select>
            `);
        } else {
            const space = clickUpAvailableSpaces.find(s => s.id === clickUpSelectedSpaceId);
            parts.push(`
                <div style="display:flex; align-items:center; gap:4px;">
                    <span style="font-size:11px; color:var(--text-secondary);">${escapeHtml(space?.name || 'Unknown')}</span>
                    <button class="planning-button secondary" data-level="space" style="padding:2px 6px; font-size:9px;">Change</button>
                </div>
            `);

            if (clickUpAvailableFolders.length > 0 || clickUpSelectedFolderId) {
                if (!clickUpSelectedFolderId) {
                    parts.push(`
                        <select id="tickets-folder-select" class="planning-select">
                            <option value="">Select Folder...</option>
                            <option value="_root_">(Root - Lists not in any Folder)</option>
                            ${clickUpAvailableFolders.map(f => `<option value="${escapeAttr(f.id)}">${escapeHtml(f.name)}</option>`).join('')}
                        </select>
                    `);
                } else {
                    const folder = clickUpAvailableFolders.find(f => f.id === clickUpSelectedFolderId);
                    parts.push(`
                        <div style="display:flex; align-items:center; gap:4px;">
                            <span style="font-size:11px; color:var(--text-secondary);">${escapeHtml(folder?.name || 'Unknown')}</span>
                            <button class="planning-button secondary" data-level="folder" style="padding:2px 6px; font-size:9px;">Change</button>
                        </div>
                    `);
                }
            }

            const availableLists = clickUpSelectedFolderId
                ? clickUpAvailableListsInFolder
                : clickUpAvailableDirectLists;

            if (!clickUpSelectedListId) {
                parts.push(`
                    <select id="tickets-list-select" class="planning-select">
                        <option value="">Select List (Sprint)...</option>
                        ${availableLists.map(l => `<option value="${escapeAttr(l.id)}">${escapeHtml(l.name)} ${l.taskCount ? `(${l.taskCount})` : ''}</option>`).join('')}
                    </select>
                `);
            } else {
                const list = availableLists.find(l => l.id === clickUpSelectedListId);
                parts.push(`
                    <div style="display:flex; align-items:center; gap:4px;">
                        <span style="font-size:11px; color:var(--text-secondary);">${escapeHtml(list?.name || 'Unknown')}</span>
                        <button class="planning-button secondary" data-level="list" style="padding:2px 6px; font-size:9px;">Change</button>
                    </div>
                `);
            }
        }

        return `<div class="tickets-hierarchy-nav">${parts.join('')}</div>`;
    }

    function attachTicketsHierarchyListeners() {
        const spaceSelect = document.getElementById('tickets-space-select');
        spaceSelect?.addEventListener('change', (e) => {
            const spaceId = e.target.value;
            if (spaceId) {
                clickUpSelectedSpaceId = spaceId;
                clickUpSelectedFolderId = '';
                clickUpSelectedListId = '';
                clickUpAvailableFolders = [];
                clickUpAvailableListsInFolder = [];
                clickUpAvailableDirectLists = [];
                clickUpHierarchyLoading = true;
                renderTicketsClickUpPanel();
                vscode.postMessage({
                    type: 'clickupSaveSpaceSelection',
                    spaceId,
                    workspaceRoot: currentWorkspaceRoot || undefined
                });
                vscode.postMessage({
                    type: 'clickupLoadFolders',
                    spaceId,
                    workspaceRoot: currentWorkspaceRoot || undefined
                });
            }
        });

        const folderSelect = document.getElementById('tickets-folder-select');
        folderSelect?.addEventListener('change', (e) => {
            const folderId = e.target.value;
            if (folderId) {
                clickUpSelectedFolderId = folderId === '_root_' ? '' : folderId;
                clickUpSelectedListId = '';
                clickUpAvailableListsInFolder = [];
                clickUpHierarchyLoading = true;
                renderTicketsClickUpPanel();
                vscode.postMessage({
                    type: 'clickupSaveFolderSelection',
                    folderId: clickUpSelectedFolderId,
                    workspaceRoot: currentWorkspaceRoot || undefined
                });
                if (folderId === '_root_') {
                    clickUpHierarchyLoading = false;
                    renderTicketsClickUpPanel();
                } else {
                    vscode.postMessage({
                        type: 'clickupLoadLists',
                        spaceId: clickUpSelectedSpaceId,
                        folderId: clickUpSelectedFolderId,
                        workspaceRoot: currentWorkspaceRoot || undefined
                    });
                }
            }
        });

        const listSelect = document.getElementById('tickets-list-select');
        listSelect?.addEventListener('change', (e) => {
            const listId = e.target.value;
            if (listId) {
                clickUpSelectedListId = listId;
                clickUpProjectLoading = false;
                clickUpProjectIssues = [];
                vscode.postMessage({
                    type: 'clickupSaveListSelection',
                    spaceId: clickUpSelectedSpaceId,
                    folderId: clickUpSelectedFolderId,
                    listId,
                    workspaceRoot: currentWorkspaceRoot || undefined
                });
                loadClickUpProject(false, listId);
            }
        });

        document.querySelectorAll('[data-level]').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const level = e.target.dataset.level;
                if (level === 'space') {
                    clickUpSelectedSpaceId = '';
                    clickUpSelectedFolderId = '';
                    clickUpSelectedListId = '';
                    clickUpProjectIssues = [];
                    loadClickUpSpaces();
                } else if (level === 'folder') {
                    clickUpSelectedFolderId = '';
                    clickUpSelectedListId = '';
                    clickUpProjectIssues = [];
                } else if (level === 'list') {
                    clickUpSelectedListId = '';
                    clickUpProjectIssues = [];
                }
                renderTicketsClickUpPanel();
            });
        });
    }

    function renderTicketsClickUpStatusFilterOptions() {
        const { clickUpStatusFilter } = getTicketsTabElements();
        if (!clickUpStatusFilter) return;

        const statuses = Array.from(new Set(
            clickUpProjectIssues.map(task => task.status || 'Unknown')
        )).sort();

        const html = `
            <option value="">All statuses</option>
            ${statuses.map(status => `<option value="${escapeAttr(status)}">${escapeHtml(status)}</option>`).join('')}
        `;

        if (_lastTicketsClickUpStateFilterHtml !== html) {
            clickUpStatusFilter.innerHTML = html;
            _lastTicketsClickUpStateFilterHtml = html;
            clickUpStatusFilter.value = clickUpProjectStatusFilterValue || '';
            clickUpStatusFilter.onchange = (e) => {
                clickUpProjectStatusFilterValue = e.target.value;
                renderTicketsClickUpList();
            };
        }
    }

    function getFilteredClickUpTasks() {
        const search = String(clickUpProjectSearchValue || '').trim().toLowerCase();
        const statusFilter = String(clickUpProjectStatusFilterValue || '').trim();
        return clickUpProjectIssues.filter(task => {
            if (statusFilter && task.status !== statusFilter) return false;
            if (!search) return true;
            const haystack = [
                task.title,
                task.description,
                task.assignees?.map(a => a.username || a.email).join(' ')
            ].join('\n').toLowerCase();
            return haystack.includes(search);
        });
    }

    function renderTicketsClickUpList() {
        if (!isTicketsTabActive()) return;

        const { issuesContainer, emptyState, loadMoreButton } = getTicketsTabElements();
        if (!issuesContainer) return;

        if (clickUpProjectStatus === 'loading') {
            if (emptyState) {
                emptyState.textContent = clickUpProjectMessage || 'Loading tasks...';
                emptyState.style.display = '';
            }
            issuesContainer.innerHTML = '';
            _lastTicketsClickUpIssuesContainerHtml = '';
            return;
        }

        if (emptyState) emptyState.style.display = 'none';

        const tasks = getFilteredClickUpTasks();
        const html = tasks.length === 0
            ? `<div class="empty-state">No tasks found.</div>`
            : tasks.map(task => `
                <div class="tickets-issue-card" data-clickup-task-id="${escapeAttr(task.id)}">
                    <div class="tickets-issue-title">${escapeHtml(task.title || task.identifier)}</div>
                    <div class="tickets-issue-meta">${escapeHtml(task.status || 'Unknown')}</div>
                    <div class="tickets-issue-meta">${task.assignees?.length ? escapeHtml(task.assignees.map(a => a.username || a.email).join(', ')) : 'Unassigned'}</div>
                    <div style="display:flex; justify-content:flex-end; margin-top:8px; gap:4px;">
                        <button type="button" class="tickets-issue-import-btn" data-refine-task-id="${escapeAttr(task.id)}" data-issue-title="${escapeAttr(task.title || '')}" data-issue-description="${escapeAttr(task.markdownDescription || task.description || '')}">REFINE</button>
                        <button type="button" class="tickets-issue-import-btn" data-import-task-id="${escapeAttr(task.id)}">IMPORT</button>
                    </div>
                </div>
            `).join('');

        if (_lastTicketsClickUpIssuesContainerHtml !== html) {
            issuesContainer.innerHTML = html;
            _lastTicketsClickUpIssuesContainerHtml = html;
        }

        if (loadMoreButton) {
            loadMoreButton.style.display = clickUpProjectHasMore ? '' : 'none';
        }
    }

    function renderTicketsClickUpTaskDetail() {
        if (!isTicketsTabActive()) return;

        const { detailTitle, detailStatus, detailAssignee, detailDescription, detailSubtasks, detailComments, detailAttachments, detailImportButton, detailRefineButton, detailAskAgentButton } = getTicketsTabElements();
        if (!detailTitle || !detailStatus || !detailAssignee || !detailDescription) return;

        if (!selectedClickUpIssue) {
            detailTitle.textContent = 'Select a task';
            detailStatus.textContent = '';
            detailAssignee.textContent = '';
            const noSelectionHtml = '<div class="empty-state">Choose a task from the list to inspect details.</div>';
            if (_lastTicketsClickUpDetailDescriptionHtml !== noSelectionHtml) {
                detailDescription.innerHTML = noSelectionHtml;
                _lastTicketsClickUpDetailDescriptionHtml = noSelectionHtml;
            }
            if (detailSubtasks && _lastTicketsClickUpDetailSubtasksHtml !== '') { detailSubtasks.innerHTML = ''; _lastTicketsClickUpDetailSubtasksHtml = ''; }
            if (detailComments && _lastTicketsClickUpDetailCommentsHtml !== '') { detailComments.innerHTML = ''; _lastTicketsClickUpDetailCommentsHtml = ''; }
            if (detailAttachments && _lastTicketsClickUpDetailAttachmentsHtml !== '') { detailAttachments.innerHTML = ''; _lastTicketsClickUpDetailAttachmentsHtml = ''; }
            if (detailImportButton) detailImportButton.disabled = true;
            if (detailRefineButton) detailRefineButton.disabled = true;
            if (detailAskAgentButton) detailAskAgentButton.disabled = true;
            return;
        }

        const task = selectedClickUpIssue.task;
        detailTitle.textContent = task.title || task.identifier || task.id;
        detailStatus.textContent = task.status || 'Unknown status';
        detailAssignee.textContent = `Assignee: ${task.assignees?.length ? task.assignees.map(a => a.username || a.email).join(', ') : 'Unassigned'}`;

        if (selectedClickUpIssue.renderedDescriptionHtml) {
            if (_lastTicketsClickUpDetailDescriptionHtml !== selectedClickUpIssue.renderedDescriptionHtml) {
                detailDescription.innerHTML = selectedClickUpIssue.renderedDescriptionHtml;
                _lastTicketsClickUpDetailDescriptionHtml = selectedClickUpIssue.renderedDescriptionHtml;
            }
        } else {
            const plainHtml = escapeHtml((task.markdownDescription || task.description || '').trim() || 'No description provided.').replace(/\n/g, '<br>');
            if (_lastTicketsClickUpDetailDescriptionHtml !== plainHtml) {
                detailDescription.innerHTML = plainHtml;
                _lastTicketsClickUpDetailDescriptionHtml = plainHtml;
            }
        }

        if (detailSubtasks) {
            const newSubtasksHtml = selectedClickUpIssue.subtasks.length > 0
                ? selectedClickUpIssue.subtasks.map((subtask) => `
                    <div class="planning-card">
                        <div class="planning-card-header">${escapeHtml(subtask.title || subtask.name || subtask.id)}</div>
                        <div class="planning-status">${escapeHtml(subtask.status || 'Unknown')}</div>
                        <div style="display:flex; justify-content:flex-end; margin-top:8px; gap:4px;">
                            <button type="button" class="planning-button" data-refine-task-id="${escapeAttr(subtask.id)}" data-issue-title="${escapeAttr(subtask.title || '')}" data-issue-description="${escapeAttr(subtask.description || '')}">REFINE</button>
                            <button type="button" class="planning-button" data-import-task-id="${escapeAttr(subtask.id)}">IMPORT</button>
                        </div>
                    </div>
                `).join('')
                : '<div class="empty-state">No subtasks attached to this task.</div>';
            if (_lastTicketsClickUpDetailSubtasksHtml !== newSubtasksHtml) {
                detailSubtasks.innerHTML = newSubtasksHtml;
                _lastTicketsClickUpDetailSubtasksHtml = newSubtasksHtml;
            }
        }

        if (detailComments) {
            const newCommentsHtml = selectedClickUpIssue.comments.length > 0
                ? selectedClickUpIssue.comments.map((comment) => `
                    <div class="planning-card">
                        <div class="planning-card-header">${escapeHtml(comment.user?.name || comment.user?.email || 'Unknown')}</div>
                        <div class="planning-card-description">${escapeHtml(comment.createdAt ? comment.createdAt.slice(0, 10) : '')}</div>
                        <div class="planning-card-description">${escapeHtml(comment.body || '').replace(/\n/g, '<br>')}</div>
                    </div>
                `).join('')
                : '<div class="empty-state">No comments attached to this task.</div>';
            if (_lastTicketsClickUpDetailCommentsHtml !== newCommentsHtml) {
                detailComments.innerHTML = newCommentsHtml;
                _lastTicketsClickUpDetailCommentsHtml = newCommentsHtml;
            }
        }

        if (detailAttachments) {
            const newAttachmentsHtml = selectedClickUpIssue.attachments.length > 0
                ? selectedClickUpIssue.attachments.map((attachment) => `
                    <button type="button" class="planning-button secondary" data-clickup-attachment-url="${escapeAttr(attachment.url || '')}">
                        ${escapeHtml(attachment.title || attachment.filename || attachment.url || 'Attachment')}
                    </button>
                `).join('')
                : '<div class="empty-state">No attachments attached to this task.</div>';
            if (_lastTicketsClickUpDetailAttachmentsHtml !== newAttachmentsHtml) {
                detailAttachments.innerHTML = newAttachmentsHtml;
                _lastTicketsClickUpDetailAttachmentsHtml = newAttachmentsHtml;
            }
        }

        if (detailAskAgentButton) detailAskAgentButton.disabled = false;
        if (detailImportButton) detailImportButton.disabled = false;
        if (detailRefineButton) detailRefineButton.disabled = false;
    }

    // ===== LOAD FUNCTIONS =====

    function loadLinearProject(force = false) {
        if (linearProjectLoading && !force) return;
        linearProjectLoading = true;
        linearProjectStatus = 'loading';
        linearProjectMessage = 'Loading Linear project...';
        renderTicketsLinearPanel();
        vscode.postMessage({ type: 'linearLoadProject', workspaceRoot: currentWorkspaceRoot || undefined });
    }

    function loadLinearTaskDetails(issueId) {
        if (!issueId) return;
        selectedLinearIssue = null;
        renderTicketsLinearPanel();
        vscode.postMessage({ type: 'linearLoadTaskDetails', issueId, workspaceRoot: currentWorkspaceRoot || undefined });
    }

    function loadClickUpProject(force = false, listIdOverride = undefined) {
        if (clickUpProjectLoading && !force) return;
        clickUpCurrentPage = 0;
        clickUpProjectHasMore = false;
        clickUpProjectLoading = true;
        clickUpProjectStatus = 'loading';
        clickUpProjectMessage = 'Loading ClickUp project...';
        renderTicketsClickUpPanel();
        vscode.postMessage({
            type: 'clickupLoadProject',
            workspaceRoot: currentWorkspaceRoot || undefined,
            page: 0,
            statusFilter: clickUpProjectStatusFilterValue || undefined,
            searchQuery: clickUpProjectSearchValue || undefined,
            listId: listIdOverride || clickUpSelectedListId || undefined
        });
    }

    function loadMoreClickUpTasks() {
        if (!clickUpProjectHasMore) return;
        vscode.postMessage({
            type: 'clickupLoadProject',
            workspaceRoot: currentWorkspaceRoot || undefined,
            page: clickUpCurrentPage + 1,
            statusFilter: clickUpProjectStatusFilterValue || undefined,
            searchQuery: clickUpProjectSearchValue || undefined,
            isLoadMore: true,
            listId: clickUpSelectedListId || undefined
        });
    }

    function loadClickUpTaskDetails(taskId) {
        if (!taskId) return;
        selectedClickUpIssue = null;
        renderTicketsClickUpPanel();
        vscode.postMessage({
            type: 'clickupLoadTaskDetails',
            taskId,
            workspaceRoot: currentWorkspaceRoot || undefined
        });
    }

    function loadClickUpSpaces() {
        clickUpHierarchyLoading = true;
        renderTicketsClickUpPanel();
        vscode.postMessage({
            type: 'clickupLoadSpaces',
            workspaceRoot: currentWorkspaceRoot || undefined
        });
    }

    // ===== IMPORT/REFINE DELEGATION =====

    function handleTicketsImport(provider, id, includeSubtasks) {
        const { detailImportButton } = getTicketsTabElements();
        if (detailImportButton) detailImportButton.disabled = true;

        vscode.postMessage({
            type: provider === 'clickup' ? 'clickupImportTask' : 'linearImportTask',
            workspaceRoot: currentWorkspaceRoot,
            [provider === 'clickup' ? 'taskId' : 'issueId']: id,
            includeSubtasks
        });
    }

    function handleTicketsRefine(provider, id, title, description) {
        vscode.postMessage({
            type: provider === 'clickup' ? 'clickupRefineTask' : 'linearRefineTask',
            workspaceRoot: currentWorkspaceRoot,
            [provider === 'clickup' ? 'taskId' : 'issueId']: id,
            title,
            description
        });
    }

    // ===== STATE PERSISTENCE =====

    function saveTicketsState() {
        const currentPersisted = vscode.getState() || {};
        vscode.setState({
            ...currentPersisted,
            tickets: {
                lastIntegrationProvider,
                linearProjectSearchValue,
                linearProjectStateFilterValue,
                linearProjectPickerValue,
                clickUpSelectedSpaceId,
                clickUpSelectedFolderId,
                clickUpSelectedListId,
                clickUpProjectSearchValue,
                clickUpProjectStatusFilterValue
            }
        });
    }

    function restoreTicketsState() {
        const state = vscode.getState()?.tickets;
        if (!state) return;
        lastIntegrationProvider = state.lastIntegrationProvider || null;
        linearProjectSearchValue = state.linearProjectSearchValue || '';
        linearProjectStateFilterValue = state.linearProjectStateFilterValue || '';
        linearProjectPickerValue = state.linearProjectPickerValue || '';
        clickUpSelectedSpaceId = state.clickUpSelectedSpaceId || '';
        clickUpSelectedFolderId = state.clickUpSelectedFolderId || '';
        clickUpSelectedListId = state.clickUpSelectedListId || '';
        clickUpProjectSearchValue = state.clickUpProjectSearchValue || '';
        clickUpProjectStatusFilterValue = state.clickUpProjectStatusFilterValue || '';
    }

    // Design Folder modal close (X button)
    const btnCloseDesignFolderModal = document.getElementById('btn-close-design-folder-modal');
    if (btnCloseDesignFolderModal) {
        btnCloseDesignFolderModal.addEventListener('click', () => {
            const modal = document.getElementById('folder-modal-design');
            if (modal) modal.style.display = 'none';
        });
    }

    // Design Folder modal close (backdrop click)
    const folderModalDesign = document.getElementById('folder-modal-design');
    if (folderModalDesign) {
        folderModalDesign.addEventListener('click', (e) => {
            if (e.target.id === 'folder-modal-design') {
                e.target.style.display = 'none';
            }
        });
    }

    // Modal Design folder management buttons
    const btnRefreshDesignFoldersModal = document.getElementById('btn-refresh-design-folders-modal');
    if (btnRefreshDesignFoldersModal) {
        btnRefreshDesignFoldersModal.addEventListener('click', () => {
            vscode.postMessage({ type: 'refreshSource', sourceId: 'design-folder' });
        });
    }

    const btnAddDesignFolderModal = document.getElementById('btn-add-design-folder-modal');
    if (btnAddDesignFolderModal) {
        btnAddDesignFolderModal.addEventListener('click', () => {
            vscode.postMessage({ type: 'addDesignFolder' });
        });
    }

    // Manage design folders button in design content strip
    const btnManageDesignFolders = document.getElementById('btn-manage-design-folders');
    if (btnManageDesignFolders) {
        btnManageDesignFolders.addEventListener('click', () => {
            const modal = document.getElementById('folder-modal-design');
            if (modal) {
                modal.style.display = 'flex';
                renderDesignFolderListModal();
                vscode.postMessage({ type: 'listDesignFolders' });
            }
        });
    }

    vscode.postMessage({ type: 'fetchRoots' });
    vscode.postMessage({ type: 'refreshSource', sourceId: 'local-folder' });
    vscode.postMessage({ type: 'listHtmlFolders' });
    vscode.postMessage({ type: 'refreshSource', sourceId: 'html-folder' });
    vscode.postMessage({ type: 'listDesignFolders' });
    vscode.postMessage({ type: 'refreshSource', sourceId: 'design-folder' });
})();