(function() {
    const vscode = acquireVsCodeApi();

    // Restore persisted state
    const persistedState = vscode.getState() || {};

    // State object (must be declared before use)
    const state = {
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
        localFolderPathsByRoot: persistedState.localFolderPathsByRoot || {},
        ticketsPreviewCollapsed: persistedState.ticketsPreviewCollapsed || false,
        analystAvailable: false,
        docsListCollapsed: persistedState.docsListCollapsed || false,
        kanbanListCollapsed: persistedState.kanbanListCollapsed || false,
        editMode: { docs: false, local: false, kanban: false, online: false },
        editOriginalContent: { docs: null, local: null, kanban: null, online: null },
        dirtyFlags: { docs: false, local: false, kanban: false, online: false },
        externalChangePending: { docs: false, local: false, kanban: false, online: false },
        reviewMode: { kanban: false },
        kanbanReviewSelectedText: '',
        docsWorkspaceRootFilter: '',
        docsSectionCollapsed: persistedState.docsSectionCollapsed || {},
        docsSourceFilter: persistedState.docsSourceFilter || ['local', 'clickup', 'linear', 'notion', 'antigravity'],
        localDocsSearch: '',
        onlineDocsSearch: '',
        activeDesignDocEnabled: false,
        activeDesignDocSourceId: null,
        activeDesignDocId: null,
        designSystemDocEnabled: false,
        designSystemDocSourceId: null,
        designSystemDocId: null,
        _lastLocalDocsMsg: null,
        _lastOnlineDocsMsg: null
    };

    let _restoredPanelState = { panel: {}, byRoot: {} };
    let _registeredDropdowns = []; // Array of { selectElOrId, tabKey, includeAllOption }
    let _workspaceItems = [];
    let _integrationWorkspaces = [];

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
        let currentVal = select.value;
        if (tabKey === 'tickets' && ticketsWorkspaceRoot) {
            currentVal = ticketsWorkspaceRoot;
        } else if (tabKey === 'research' && researchWorkspaceRoot) {
            currentVal = researchWorkspaceRoot;
        } else if (tabKey === 'notebook' && notebookWorkspaceRoot) {
            currentVal = notebookWorkspaceRoot;
        } else if (tabKey === 'docs') {
            currentVal = resolveDocsWorkspaceFilter(_workspaceItems);
        }
        populateWorkspaceDropdown(select, _workspaceItems, currentVal, includeAllOption);
    }

    // NEW helper — single source of truth for the Docs tab workspace filter.
    // Restored/persisted specific roots win only if still present; otherwise "All Workspaces" ('').
    function resolveDocsWorkspaceFilter(workspaceItems) {
        const restored = _restoredPanelState.panel['docs.root'] || '';
        const valid = restored === '' || (workspaceItems || []).some(item => item.workspaceRoot === restored);
        state.docsWorkspaceRootFilter = valid ? restored : '';
        const dropdown = document.getElementById('docs-workspace-filter');
        if (dropdown) dropdown.value = state.docsWorkspaceRootFilter;
        return state.docsWorkspaceRootFilter;
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



    let researchStatusTimeout = null;

    // Kanban tab state (declared early to avoid TDZ when switchToTab is called during init)
    let _pendingKanbanSelection = null;

    // Tickets tab state
    let ticketsInitialized = false;
    let ticketsLoadedOnce = false;
    let lastIntegrationProvider = null;

    // Source-aware list of what agents can do via the LocalApiServer bridge (no MCP).
    // Mirrors the real endpoints in src/services/LocalApiServer.ts:737-775 and the
    // .agents/skills/*.md docs. ClickUp has dedicated write endpoints; Linear writes
    // go through the GraphQL proxy.
    const AGENT_API_CAPABILITIES = {
        clickup: [
            { name: 'List / filter cached tickets',
              desc: 'Read the local cached ticket metadata — no MCP round-trip (GET /metadata/clickup, get_tickets skill).',
              prompt: 'Use the get_tickets skill to read my cached ClickUp tickets from the Switchboard local API (GET /metadata/clickup) and list them grouped by status. Do not use the MCP.' },
            { name: 'Read a ticket in full',
              desc: 'Fetch a task with description, subtasks, comments and attachments (GET /task/clickup/{id}).',
              prompt: 'Use the get_tickets skill to fetch ClickUp task {ticketId} in full from the Switchboard local API (GET /task/clickup/{ticketId}) — description, subtasks, comments and attachments — and summarise it. Do not use the MCP.' },
            { name: 'Create a task (with subtasks)',
              desc: 'Create a new ClickUp task and optional subtasks (POST /task/clickup, clickup_create_task skill).',
              prompt: 'Use the clickup_create_task skill to create a ClickUp task via the Switchboard local API (POST /task/clickup). Ask me for the list, then the task name, description and any subtasks. Do not use the MCP.' },
            { name: 'Update a task',
              desc: 'Change name, description, status, assignees, due date, priority or tags (PUT /task/clickup/{id}, clickup_modify_task skill).',
              prompt: 'Use the clickup_modify_task skill to update ClickUp task {ticketId} via the Switchboard local API (PUT /task/clickup/{ticketId}). Ask me which fields to change (status, assignees, priority, tags, due date) and apply them. Do not use the MCP.' },
            { name: 'Attach a file',
              desc: 'Upload a screenshot/doc (≤10MB) to a task (POST /task/clickup/{id}/attach, clickup_attach skill).',
              prompt: 'Use the clickup_attach skill to attach a file to ClickUp task {ticketId} via the Switchboard local API (POST /task/clickup/{ticketId}/attach). Ask me which local file to upload. Do not use the MCP.' },
            { name: 'Create a doc page',
              desc: 'Add a Markdown page to a ClickUp doc (POST /doc/clickup, clickup_create_subpage skill).',
              prompt: 'Use the clickup_create_subpage skill to create a ClickUp doc page via the Switchboard local API (POST /doc/clickup). Ask me for the docId, page title and content. Do not use the MCP.' },
            { name: 'Resolve a name to an ID',
              desc: 'Turn a task/list name into its ID (GET /resolve/clickup/name/{name}, clickup_fetch skill).',
              prompt: 'Use the clickup_fetch skill to resolve a ClickUp name to an ID via the Switchboard local API (GET /resolve/clickup/name/...). Ask me the name to resolve. Do not use the MCP.' },
            { name: 'Generate an architecture diagram',
              desc: 'Build a Mermaid diagram and optionally attach it to a task (POST /diagram/generate, generate_diagram skill).',
              prompt: 'Use the generate_diagram skill to generate an architecture diagram via the Switchboard local API (POST /diagram/generate) and attach it to ClickUp task {ticketId}. Do not use the MCP.' },
            { name: 'Raw ClickUp API call',
              desc: 'Any ClickUp v2 REST endpoint not covered above (POST /api/clickup, clickup_api skill).',
              prompt: 'Use the clickup_api skill to make a raw ClickUp REST call via the Switchboard local API proxy (POST /api/clickup). Tell me which endpoint/method you need and I will confirm. Do not use the MCP.' }
        ],
        linear: [
            { name: 'List / filter cached issues',
              desc: 'Read the local cached issue metadata — no MCP round-trip (GET /metadata/linear, get_tickets skill).',
              prompt: 'Use the get_tickets skill to read my cached Linear issues from the Switchboard local API (GET /metadata/linear) and list them grouped by state. Do not use the MCP.' },
            { name: 'Read an issue in full',
              desc: 'Fetch an issue with description, sub-issues, comments and attachments (GET /task/linear/{id}).',
              prompt: 'Use the get_tickets skill to fetch Linear issue {ticketId} in full from the Switchboard local API (GET /task/linear/{ticketId}) — description, sub-issues, comments and attachments — and summarise it. Do not use the MCP.' },
            { name: 'Resolve a name to an ID',
              desc: 'Turn an issue/project name into its ID (GET /resolve/linear/name/{name}).',
              prompt: 'Resolve a Linear name to an ID via the Switchboard local API (GET /resolve/linear/name/...). Ask me the name to resolve. Do not use the MCP.' },
            { name: 'Create / update / comment via GraphQL',
              desc: 'Linear writes (create issue, change state, add comment) go through the GraphQL proxy (POST /api/linear, linear_api skill).',
              prompt: 'Use the linear_api skill to run a Linear GraphQL mutation via the Switchboard local API proxy (POST /api/linear) — e.g. create an issue, change its state, or add a comment to {ticketId}. Tell me the operation and I will confirm the fields. Do not use the MCP.' },
            { name: 'Run any GraphQL query',
              desc: 'Arbitrary Linear GraphQL read query (POST /api/linear, linear_api skill).',
              prompt: 'Use the linear_api skill to run a Linear GraphQL query via the Switchboard local API proxy (POST /api/linear). Tell me what to fetch and I will confirm the query. Do not use the MCP.' },
            { name: 'Generate an architecture diagram',
              desc: 'Build a Mermaid diagram and optionally attach it to an issue (POST /diagram/generate, generate_diagram skill).',
              prompt: 'Use the generate_diagram skill to generate an architecture diagram via the Switchboard local API (POST /diagram/generate) and attach it to Linear issue {ticketId} (platform "linear"). Do not use the MCP.' }
        ]
    };

    let ticketsEditMode = false;
    let _ticketsEditBackupHtml = null;
    let ticketsWorkspaceRoot = '';
    let ticketsAutoSync = false;
    let _pendingRefreshImport = false;
    let researchWorkspaceRoot = '';
    let folderModalScope = 'local';
    let notebookWorkspaceRoot = '';
    let lastResearchFolderByRoot = {};

    function persistResearchState() {
        if (!researchWorkspaceRoot) return;
        const rState = {
            lastResearchFolder: lastResearchFolderByRoot[researchWorkspaceRoot] || null
        };
        persistTab('research', rState, researchWorkspaceRoot);
        persistTab('research.root', researchWorkspaceRoot);
    }

    function restoreResearchStateForRoot() {
        if (!researchWorkspaceRoot) return;
        const restoredState = getRestoredState('research', researchWorkspaceRoot) || {};
        const folder = restoredState.lastResearchFolder || null;
        lastResearchFolderByRoot[researchWorkspaceRoot] = folder;
        
        const currentPaths = getCurrentFolderPaths(state.localFolderPathsByRoot, researchWorkspaceRoot);
        populateResearchFolderSelect(currentPaths);
        
        if (!state.localFolderPathsByRoot[researchWorkspaceRoot] || state.localFolderPathsByRoot[researchWorkspaceRoot].length === 0) {
            vscode.postMessage({ type: 'listLocalFolders', workspaceRoot: researchWorkspaceRoot });
        }
    }

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
    let _subtaskParent = null;
    let _convertSelectedParentId = null;
    let _convertCurrentTicketId = null;
    let _pendingDeleteTicket = null;

    // ── Comment Manager state ──
    let _cmThreads = [];
    let _cmMembers = [];
    let _cmThreadingSupported = true;
    let _cmActiveTicketId = null;
    let _cmActiveProvider = null;
    let _pendingRefetchTicketId = null;
    let _refetchStale = false;
    let _cmDraftBackup = '';
    let _cmMentionContext = null; // { textarea, mode, commentId, startPos, query, activeIndex }
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
    let isImportingAll = false;
    let _restoringClickUpHierarchy = false;
    let _pendingTicketsRestore = false;
    let pendingClickUpDetailIssueId = '';

    let currentTicketTags = [];
    let availableLinearLabels = [];
    let availableLinearStates = [];
    let availableClickUpTags = [];
    let availableClickUpStatuses = [];
    let _tagsModalOpen = false;
    let _tagsCatalogLoading = false;

    // Cached HTML strings for DOM guard comparisons
    let _lastTicketsStateFilterHtml = '';
    let _lastTicketsProjectPickerHtml = '';
    let _lastTicketsIssuesContainerHtml = '';
    let _lastTicketsDetailContentHtml = '';
    let _lastTicketsHierarchyHtml = '';
    let _lastTicketsClickUpIssuesContainerHtml = '';
    let _lastTicketsClickUpDetailContentHtml = '';
    let _lastTicketsClickUpStateFilterHtml = '';
    let _lastTicketsClickUpStatusSelectHtml = '';
    let _lastTicketsClickUpSubtasksNavHtml = '';
    let _lastTicketsLinearStatusSelectHtml = '';
    let _lastTicketsLinearSubtasksNavHtml = '';
    let _lastTicketsTagsKey = '';
    let _lastTicketsTagsProvider = '';
    let _lastLinkTicketBtn = null;

    // Full detail caches for tickets that have been expanded
    let linearIssueDetailCache = new Map(); // issueId -> { issue, subtasks, comments, attachments, renderedDescriptionHtml }
    let clickUpTaskDetailCache = new Map(); // taskId -> { task, subtasks, comments, attachments, renderedDescriptionHtml }

    // Helper functions for tickets tab
    function escapeHtml(value) {
        return String(value || '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function getContrastColor(bgColor) {
        if (!bgColor) return null;
        const color = bgColor.trim();
        let r, g, b;
        if (color.startsWith('#')) {
            const hex = color.slice(1);
            if (hex.length === 3) {
                r = parseInt(hex[0] + hex[0], 16);
                g = parseInt(hex[1] + hex[1], 16);
                b = parseInt(hex[2] + hex[2], 16);
            } else if (hex.length === 6) {
                r = parseInt(hex.slice(0, 2), 16);
                g = parseInt(hex.slice(2, 4), 16);
                b = parseInt(hex.slice(4, 6), 16);
            } else {
                return null;
            }
        } else if (color.startsWith('rgb')) {
            const matches = color.match(/\d+/g);
            if (matches && matches.length >= 3) {
                r = parseInt(matches[0], 10);
                g = parseInt(matches[1], 10);
                b = parseInt(matches[2], 10);
            } else {
                return null;
            }
        } else {
            return null;
        }

        if (isNaN(r) || isNaN(g) || isNaN(b)) {
            return null;
        }

        const yiq = (r * 299 + g * 587 + b * 114) / 1000;
        return yiq >= 128 ? '#111111' : '#e0e0e0';
    }

    function renderTicketTags(tags, provider) {
        const container = document.getElementById('tickets-tags-display');
        if (!container) return;
        
        const tagsKey = (tags || []).map(tag => {
            if (typeof tag === 'object' && tag !== null) {
                return `${tag.id || ''}:${tag.name || ''}:${tag.tagBg || ''}:${tag.color || ''}`;
            }
            return String(tag);
        }).join('|');

        if (_lastTicketsTagsKey === tagsKey && _lastTicketsTagsProvider === provider) {
            return;
        }

        _lastTicketsTagsKey = tagsKey;
        _lastTicketsTagsProvider = provider;

        container.innerHTML = '';

        if (!tags || tags.length === 0) {
            container.style.display = 'none';
            return;
        }

        container.style.display = 'flex';
        
        tags.forEach(tag => {
            const pill = document.createElement('span');
            pill.className = `ticket-tag-pill ${provider}`;
            
            if (provider === 'clickup' && tag.tagBg) {
                pill.style.setProperty('--tag-bg', tag.tagBg);
                const fg = getContrastColor(tag.tagBg);
                if (fg) {
                    pill.style.setProperty('--tag-fg', fg);
                }
            }
            
            pill.textContent = tag.name || tag;
            container.appendChild(pill);
        });
    }

    function requestTagsCatalog() {
        const provider = lastIntegrationProvider;
        if (provider === 'linear') {
            vscode.postMessage({
                type: 'linearLoadAutomationCatalog',
                workspaceRoot: ticketsWorkspaceRoot
            });
        } else {
            const spaceId = clickUpSelectedSpaceId || (clickUpAvailableSpaces[0]?.id);
            if (spaceId) {
                vscode.postMessage({
                    type: 'clickupLoadSpaceTags',
                    spaceId,
                    workspaceRoot: ticketsWorkspaceRoot
                });
            }
        }
    }

    function renderTagsModalList() {
        const availableList = document.getElementById('tags-available-list');
        if (!availableList) return;

        const provider = lastIntegrationProvider;
        const availableTags = provider === 'linear' ? availableLinearLabels : availableClickUpTags;

        availableList.innerHTML = '';

        if (!availableTags || availableTags.length === 0) {
            availableList.innerHTML = _tagsCatalogLoading
                ? '<div style="color: var(--text-secondary); font-size: 12px; padding: 8px;">Loading tags...</div>'
                : '<div style="color: var(--text-secondary); font-size: 12px; padding: 8px;">No tags available</div>';
            return;
        }

        const currentTagNames = currentTicketTags.map(t => t.name || t);
        availableTags.forEach(tag => {
            const item = document.createElement('label');
            item.className = 'tag-checkbox-item';

            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.value = provider === 'linear' ? tag.id : tag.name;
            checkbox.checked = currentTagNames.includes(tag.name);

            const label = document.createElement('span');
            label.className = 'tag-checkbox-label';
            label.textContent = tag.name;

            item.appendChild(checkbox);
            item.appendChild(label);
            availableList.appendChild(item);
        });
    }

    function openTagsModal() {
        const modal = document.getElementById('tags-modal');
        const availableList = document.getElementById('tags-available-list');

        if (!modal || !availableList) return;

        _tagsModalOpen = true;

        const provider = lastIntegrationProvider;
        const availableTags = provider === 'linear' ? availableLinearLabels : availableClickUpTags;

        // Lazy-load the tag catalog if it wasn't fetched yet (e.g. restored-state path)
        if (!availableTags || availableTags.length === 0) {
            _tagsCatalogLoading = true;
            requestTagsCatalog();
        }

        renderTagsModalList();
        modal.style.display = 'flex';
    }

    function saveTags() {
        const modal = document.getElementById('tags-modal');
        const availableList = document.getElementById('tags-available-list');

        if (!modal || !availableList) return;

        const checkboxes = availableList.querySelectorAll('input[type="checkbox"]:checked');
        const selectedIds = Array.from(checkboxes).map(cb => cb.value);

        const provider = lastIntegrationProvider;
        const ticketId = provider === 'linear'
            ? selectedLinearIssue?.issue?.id
            : selectedClickUpIssue?.task?.id;

        if (!ticketId) {
            showTicketsStatus('No ticket selected', true);
            return;
        }

        if (provider === 'linear') {
            vscode.postMessage({
                type: 'linearUpdateIssueLabels',
                issueId: ticketId,
                labelIds: selectedIds,
                workspaceRoot: ticketsWorkspaceRoot
            });
        } else {
            vscode.postMessage({
                type: 'clickupUpdateTaskTags',
                taskId: ticketId,
                tags: selectedIds,
                workspaceRoot: ticketsWorkspaceRoot
            });
        }

        modal.style.display = 'none';
        _tagsModalOpen = false;
    }

    function escapeAttr(value) {
        return String(value || '').replace(/"/g, '&quot;');
    }

    function showTicketsStatus(text, isError) {
        const { ticketsStatusFooter } = getTicketsTabElements();
        if (!ticketsStatusFooter) return;
        ticketsStatusFooter.textContent = text;
        ticketsStatusFooter.style.color = isError ? 'var(--vscode-errorForeground, #f48771)' : 'var(--text-secondary)';
        ticketsStatusFooter.style.display = '';
        if (window._ticketsFooterTimeout) clearTimeout(window._ticketsFooterTimeout);
        window._ticketsFooterTimeout = setTimeout(() => {
            ticketsStatusFooter.style.display = 'none';
        }, 4000);
    }

    // Surface a transient error in the tickets footer — kept for navigation failures.
    function showTicketsError(text) {
        showTicketsStatus(text, true);
    }

    // ── Comment Manager functions ──────────────────────────────────

    function openCommentManager(provider, id) {
        _cmActiveProvider = provider;
        _cmActiveTicketId = id;
        _cmThreads = [];
        _cmMembers = [];
        _cmDraftBackup = '';
        const manager = document.getElementById('tickets-comment-manager');
        if (manager) {
            manager.style.display = 'flex';
        }
        const threadsDiv = document.getElementById('tickets-comment-threads');
        if (threadsDiv) {
            threadsDiv.innerHTML = '<div class="cm-loading">Loading comments...</div>';
        }
        loadCommentThreads(provider, id);
    }

    function closeCommentManager() {
        const manager = document.getElementById('tickets-comment-manager');
        if (manager) manager.style.display = 'none';
        _cmActiveTicketId = null;
        _cmActiveProvider = null;
        _cmThreads = [];
        _cmMembers = [];
        _cmDraftBackup = '';
        closeMentionDropdown();
    }

    function loadCommentThreads(provider, id) {
        // Refetch stale guard: if a refetch is already pending for this ticket,
        // mark it as stale so the response is discarded and a fresh fetch is triggered.
        if (_pendingRefetchTicketId === id) {
            _refetchStale = true;
            return; // the in-flight refetch will trigger a fresh one when it arrives
        }
        // Mark this fetch as in-flight so a concurrent optimistic insert can flag it
        // stale and a duplicate load() short-circuits above. Cleared in ticketCommentsLoaded.
        _pendingRefetchTicketId = id;
        vscode.postMessage({
            type: 'loadTicketComments',
            provider,
            id,
            workspaceRoot: ticketsWorkspaceRoot
        });
    }

    function renderCommentManager(threads, members) {
        const threadsDiv = document.getElementById('tickets-comment-threads');
        if (!threadsDiv) return;

        if (!threads || threads.length === 0) {
            threadsDiv.innerHTML = '<div class="cm-empty">No comments yet. Use the box below to add the first comment.</div>';
            return;
        }

        let html = '';
        for (const thread of threads) {
            html += renderThreadHtml(thread);
        }
        threadsDiv.innerHTML = html;

        // Wire up reply buttons
        threadsDiv.querySelectorAll('.cm-reply-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const commentId = btn.dataset.commentId;
                openReplyBox(commentId);
            });
        });

        // Wire up reply submit/cancel
        threadsDiv.querySelectorAll('.cm-reply-submit').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                const commentId = btn.dataset.commentId;
                submitReply(commentId);
            });
        });
        threadsDiv.querySelectorAll('.cm-reply-cancel').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                const commentId = btn.dataset.commentId;
                closeReplyBox(commentId);
            });
        });

        // Wire up mention autocomplete on reply textareas
        threadsDiv.querySelectorAll('.cm-reply-textarea').forEach(ta => {
            ta.addEventListener('input', (e) => handleMentionAutocomplete(e, ta, 'reply', ta.dataset.commentId));
            ta.addEventListener('keydown', (e) => handleMentionKeydown(e, ta, 'reply', ta.dataset.commentId));
        });
    }

    function renderThreadHtml(thread) {
        const optimisticClass = thread._optimistic ? ' cm-optimistic' : '';
        const authorName = escapeHtml(thread.author?.name || thread.author?.email || 'Unknown');
        const dateStr = escapeHtml(formatCommentDate(thread.date));
        const bodyHtml = escapeHtml(thread.body || '');
        let html = '<div class="cm-thread' + optimisticClass + '" data-thread-id="' + escapeHtml(thread.id) + '">';
        html += '<div class="cm-thread-header">';
        html += '<span class="cm-thread-author">' + authorName + '</span>';
        html += '<span class="cm-thread-date">' + dateStr + '</span>';
        html += '</div>';
        html += '<div class="cm-thread-body">' + bodyHtml + '</div>';
        // Reply button (only if threading is supported)
        if (_cmThreadingSupported) {
            html += '<div class="cm-thread-actions">';
            html += '<button class="cm-reply-btn" data-comment-id="' + escapeHtml(thread.id) + '">Reply</button>';
            html += '</div>';
        }
        // Replies
        if (thread.replies && thread.replies.length > 0) {
            html += '<div class="cm-replies">';
            for (const reply of thread.replies) {
                html += renderReplyHtml(reply);
            }
            html += '</div>';
        }
        html += '</div>';
        return html;
    }

    function renderReplyHtml(reply) {
        const optimisticClass = reply._optimistic ? ' cm-optimistic' : '';
        const authorName = escapeHtml(reply.author?.name || reply.author?.email || 'Unknown');
        const dateStr = escapeHtml(formatCommentDate(reply.date));
        const bodyHtml = escapeHtml(reply.body || '');
        let html = '<div class="cm-reply' + optimisticClass + '" data-reply-id="' + escapeHtml(reply.id) + '">';
        html += '<div class="cm-reply-header">';
        html += '<span class="cm-reply-author">' + authorName + '</span>';
        html += '<span class="cm-reply-date">' + dateStr + '</span>';
        html += '</div>';
        html += '<div class="cm-reply-body">' + bodyHtml + '</div>';
        html += '</div>';
        return html;
    }

    function formatCommentDate(dateStr) {
        if (dateStr === null || dateStr === undefined || dateStr === '') return '';
        try {
            const s = String(dateStr).trim();
            // ClickUp dates are epoch-millisecond strings; Linear dates are ISO strings.
            // Mirrors backend logic at TaskViewerProvider.ts:5038-5039.
            const d = /^\d+$/.test(s) ? new Date(Number(s)) : new Date(s);
            if (isNaN(d.getTime())) return s;
            return d.toLocaleString();
        } catch {
            return String(dateStr);
        }
    }

    // Read a comment's display fields regardless of provider shape.
    // Linear: { body, user:{name,email}, createdAt }
    // ClickUp: { comment_text, user:{username,email}, date }
    function commentAuthorName(comment) {
        const u = comment && comment.user ? comment.user : {};
        return u.name || u.username || u.email || 'Unknown';
    }
    function commentBodyText(comment) {
        return (comment && (comment.body || comment.comment_text)) || '';
    }
    function commentDateRaw(comment) {
        return (comment && (comment.createdAt || comment.date)) || '';
    }

    function openReplyBox(commentId) {
        // Close any existing reply boxes
        document.querySelectorAll('.cm-reply-box').forEach(el => el.remove());

        const threadDiv = document.querySelector('[data-thread-id="' + CSS.escape(commentId) + '"]');
        if (!threadDiv) return;

        const replyBox = document.createElement('div');
        replyBox.className = 'cm-reply-box';
        replyBox.dataset.commentId = commentId;
        replyBox.innerHTML = '<textarea class="cm-reply-textarea" data-comment-id="' + escapeHtml(commentId) + '" placeholder="Type a reply... Use @ to mention."></textarea>' +
            '<div class="cm-reply-box-actions">' +
            '<button class="strip-btn cm-reply-cancel" data-comment-id="' + escapeHtml(commentId) + '">Cancel</button>' +
            '<button class="strip-btn cm-reply-submit" data-comment-id="' + escapeHtml(commentId) + '" style="background: var(--accent-teal); color: black;">Post Reply</button>' +
            '</div>';
        threadDiv.appendChild(replyBox);

        const ta = replyBox.querySelector('.cm-reply-textarea');
        if (ta) {
            ta.addEventListener('input', (e) => handleMentionAutocomplete(e, ta, 'reply', commentId));
            ta.addEventListener('keydown', (e) => handleMentionKeydown(e, ta, 'reply', commentId));
            ta.focus();
        }
        // Wire up buttons for this reply box
        replyBox.querySelector('.cm-reply-submit')?.addEventListener('click', (e) => {
            e.preventDefault();
            submitReply(commentId);
        });
        replyBox.querySelector('.cm-reply-cancel')?.addEventListener('click', (e) => {
            e.preventDefault();
            closeReplyBox(commentId);
        });
    }

    function closeReplyBox(commentId) {
        const box = document.querySelector('.cm-reply-box[data-comment-id="' + (commentId ? CSS.escape(commentId) : '') + '"]');
        if (box) box.remove();
        closeMentionDropdown();
    }

    function submitReply(commentId) {
        const provider = lastIntegrationProvider;
        const id = _cmActiveTicketId || (provider === 'linear' ? selectedLinearIssue?.issue.id : selectedClickUpIssue?.task.id);
        if (!id) return;
        const ta = document.querySelector('.cm-reply-textarea[data-comment-id="' + CSS.escape(commentId) + '"]');
        const commentText = ta?.value?.trim();
        if (!commentText) return;
        const mentions = extractMentionsFromText(commentText, _cmMembers);
        // Backup draft for rollback
        _cmDraftBackup = commentText;
        // Optimistic insert as a reply
        optimisticInsertComment({
            id: 'optimistic_reply_' + Date.now(),
            author: { id: '', name: 'You', email: '' },
            body: commentText,
            date: new Date().toISOString(),
            mentions,
            _optimistic: true
        }, commentId);
        // Clear reply textarea
        if (ta) ta.value = '';
        vscode.postMessage({
            type: 'postTicketReply',
            provider,
            id,
            commentId,
            commentText,
            mentions,
            workspaceRoot: ticketsWorkspaceRoot
        });
    }

    function optimisticInsertComment(comment, parentId) {
        if (parentId) {
            // Insert as reply to the thread with parentId
            const thread = _cmThreads.find(t => t.id === parentId);
            if (thread) {
                thread.replies = thread.replies || [];
                thread.replies.push(comment);
            } else {
                // Parent not found — insert as top-level
                _cmThreads.push(comment);
            }
        } else {
            // Insert as top-level thread
            _cmThreads.push(comment);
        }
        // If a refetch is pending, mark it stale so the optimistic insert isn't overwritten
        if (_pendingRefetchTicketId) {
            _refetchStale = true;
        }
        renderCommentManager(_cmThreads, _cmMembers);
    }

    function rollbackOptimisticComment(parentId) {
        // Remove optimistic entries from threads
        if (parentId) {
            const thread = _cmThreads.find(t => t.id === parentId);
            if (thread && thread.replies) {
                thread.replies = thread.replies.filter(r => !r._optimistic);
            }
        } else {
            _cmThreads = _cmThreads.filter(t => !t._optimistic);
        }
        renderCommentManager(_cmThreads, _cmMembers);

        // Restore draft
        if (_cmDraftBackup) {
            if (parentId) {
                // Restore reply draft — reopen reply box with text
                openReplyBox(parentId);
                const ta = document.querySelector('.cm-reply-textarea[data-comment-id="' + CSS.escape(parentId) + '"]');
                if (ta) { ta.value = _cmDraftBackup; ta.focus(); }
            } else {
                // Restore compose draft
                const textarea = document.getElementById('tickets-comment-textarea');
                if (textarea) { textarea.value = _cmDraftBackup; textarea.focus(); }
            }
            _cmDraftBackup = '';
        }
    }

    function showCommentManagerError(errorMsg) {
        const threadsDiv = document.getElementById('tickets-comment-threads');
        if (threadsDiv) {
            const errorDiv = document.createElement('div');
            errorDiv.className = 'cm-error';
            errorDiv.textContent = errorMsg;
            threadsDiv.insertBefore(errorDiv, threadsDiv.firstChild);
            // Auto-remove after 5 seconds
            setTimeout(() => errorDiv.remove(), 5000);
        }
    }

    // ── Mention autocomplete ──

    function extractMentionsFromText(text, members) {
        if (!members || members.length === 0) return [];
        const mentions = [];
        const mentionRegex = /@\{([^}]+)\}/g;
        let match;
        const seen = new Set();
        while ((match = mentionRegex.exec(text)) !== null) {
            const memberId = match[1];
            if (!seen.has(memberId)) {
                seen.add(memberId);
                const member = members.find(m => m.id === memberId);
                mentions.push({
                    id: memberId,
                    name: member?.name || member?.username || memberId
                });
            }
        }
        return mentions;
    }

    function handleMentionAutocomplete(e, textarea, mode, commentId) {
        const text = textarea.value;
        const cursorPos = textarea.selectionStart;
        // Find the last @ before cursor that isn't followed by a space or closing brace
        const beforeCursor = text.substring(0, cursorPos);
        const atMatch = beforeCursor.match(/@([^\s@{]*)$/);
        if (!atMatch) {
            closeMentionDropdown();
            return;
        }
        const query = atMatch[1].toLowerCase();
        const startPos = cursorPos - atMatch[0].length;

        // Filter members
        const filtered = (_cmMembers || []).filter(m => {
            const name = (m.name || m.username || '').toLowerCase();
            const email = (m.email || '').toLowerCase();
            return name.includes(query) || email.includes(query);
        });

        if (filtered.length === 0) {
            closeMentionDropdown();
            return;
        }

        _cmMentionContext = {
            textarea,
            mode,
            commentId,
            startPos,
            query,
            activeIndex: 0,
            filtered
        };
        renderMentionDropdown(filtered);
    }

    function renderMentionDropdown(members) {
        const dropdown = document.getElementById('tickets-mention-dropdown');
        if (!dropdown) return;
        let html = '';
        members.forEach((m, i) => {
            const name = escapeHtml(m.name || m.username || 'Unknown');
            const email = escapeHtml(m.email || '');
            html += '<div class="cm-mention-item' + (i === 0 ? ' cm-mention-active' : '') + '" data-index="' + i + '" data-member-id="' + escapeHtml(m.id) + '">';
            html += '<span class="cm-mention-item-name">' + name + '</span>';
            if (email) html += '<span class="cm-mention-item-email">' + email + '</span>';
            html += '</div>';
        });
        dropdown.innerHTML = html;
        dropdown.style.display = 'block';

        // Wire up click handlers
        dropdown.querySelectorAll('.cm-mention-item').forEach(item => {
            item.addEventListener('click', () => {
                const memberId = item.dataset.memberId;
                insertMention(memberId);
            });
            item.addEventListener('mouseenter', () => {
                dropdown.querySelectorAll('.cm-mention-item').forEach(el => el.classList.remove('cm-mention-active'));
                item.classList.add('cm-mention-active');
                if (_cmMentionContext) _cmMentionContext.activeIndex = parseInt(item.dataset.index, 10);
            });
        });
    }

    function handleMentionKeydown(e, textarea, mode, commentId) {
        if (!_cmMentionContext) return;
        const dropdown = document.getElementById('tickets-mention-dropdown');
        if (!dropdown || dropdown.style.display === 'none') return;

        if (e.key === 'ArrowDown') {
            e.preventDefault();
            _cmMentionContext.activeIndex = Math.min(_cmMentionContext.activeIndex + 1, _cmMentionContext.filtered.length - 1);
            updateMentionActive();
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            _cmMentionContext.activeIndex = Math.max(_cmMentionContext.activeIndex - 1, 0);
            updateMentionActive();
        } else if (e.key === 'Enter' || e.key === 'Tab') {
            e.preventDefault();
            const member = _cmMentionContext.filtered[_cmMentionContext.activeIndex];
            if (member) {
                insertMention(member.id);
            }
        } else if (e.key === 'Escape') {
            e.preventDefault();
            closeMentionDropdown();
        }
    }

    function updateMentionActive() {
        const dropdown = document.getElementById('tickets-mention-dropdown');
        if (!dropdown || !_cmMentionContext) return;
        dropdown.querySelectorAll('.cm-mention-item').forEach((el, i) => {
            el.classList.toggle('cm-mention-active', i === _cmMentionContext.activeIndex);
        });
    }

    function insertMention(memberId) {
        if (!_cmMentionContext) return;
        const { textarea, startPos } = _cmMentionContext;
        const member = _cmMembers.find(m => m.id === memberId);
        const memberName = member?.name || member?.username || memberId;
        const before = textarea.value.substring(0, startPos);
        const after = textarea.value.substring(textarea.selectionStart);
        // Insert @{id} token — backend maps this to provider-specific mention format
        const insertion = '@{' + memberId + '}';
        textarea.value = before + insertion + ' ' + after;
        // Position cursor after the insertion + space
        const newPos = startPos + insertion.length + 1;
        textarea.setSelectionRange(newPos, newPos);
        textarea.focus();
        closeMentionDropdown();
    }

    function closeMentionDropdown() {
        const dropdown = document.getElementById('tickets-mention-dropdown');
        if (dropdown) dropdown.style.display = 'none';
        _cmMentionContext = null;
    }

    // Close mention dropdown when clicking outside
    document.addEventListener('click', (e) => {
        if (_cmMentionContext && !e.target.closest('#tickets-mention-dropdown') && !e.target.closest('textarea')) {
            closeMentionDropdown();
        }
    });

    function setTicketsLoadingState(isLoading) {
        const loadingState = document.getElementById('tickets-loading-state');
        const previewContent = document.getElementById('markdown-preview-tickets');
        if (loadingState && previewContent) {
            loadingState.style.display = isLoading ? 'flex' : 'none';
            previewContent.style.opacity = isLoading ? '0.4' : '1';
        }
        for (const barId of ['tickets-preview-meta-bar', 'tickets-local-meta-bar']) {
            const metaBar = document.getElementById(barId);
            if (metaBar) {
                metaBar.querySelectorAll('button, select').forEach(el => {
                    el.disabled = isLoading;
                });
            }
        }
    }

    function getTicketsTabElements() {
        return {
            listView: document.getElementById('tree-pane-tickets'),
            previewPane: document.getElementById('preview-pane-tickets'),
            emptyPreview: document.getElementById('tickets-empty-preview'),
            searchInput: document.getElementById('tickets-search'),
            projectPicker: document.getElementById('tickets-project-picker'),
            stateFilter: document.getElementById('tickets-state-filter'),
            clickUpStatusFilter: document.getElementById('tickets-status-filter'),
            refreshButton: document.getElementById('tickets-refresh'),
            emptyState: document.getElementById('tickets-empty-state'),
            issuesContainer: document.getElementById('tickets-issues-container'),
            loadMoreButton: document.getElementById('tickets-load-more'),
            subtasksNav: document.getElementById('tickets-subtasks-nav'),
            detailContent: document.getElementById('tickets-detail-content'),
            hierarchyNav: document.getElementById('tickets-hierarchy-nav'),
            createButton: document.getElementById('tickets-create'),
            btnImportAllTickets: document.getElementById('btn-import-all-tickets'),
            importAllKanbanButton: document.getElementById('tickets-import-all-kanban'),
            linkAllButton: document.getElementById('tickets-link-all'),
            syncAllButton: document.getElementById('tickets-sync-all'),
            previewMetaBar: document.getElementById('tickets-preview-meta-bar'),
            btnEditTicket: document.getElementById('btn-edit-ticket'),
            btnPushTicket: document.getElementById('btn-push-ticket'),
            btnDeleteTicket: document.getElementById('btn-delete-ticket'),
            selectStatusTicket: document.getElementById('select-status-ticket'),
            btnCommentTicket: document.getElementById('btn-comment-ticket'),
            btnViewAttachments: document.getElementById('btn-view-attachments'),
            btnOpenTicket: document.getElementById('btn-open-ticket'),
            btnDiagramPrompt: document.getElementById('btn-diagram-prompt'),
            attachmentsModal: document.getElementById('attachments-modal'),
            attachmentsList: document.getElementById('attachments-list'),
            ticketsStatusFooter: document.getElementById('tickets-status-footer'),
            commentInputArea: document.getElementById('tickets-comment-manager'),
            commentTextarea: document.getElementById('tickets-comment-textarea'),
            btnPostCommentCancel: document.getElementById('btn-post-comment-cancel'),
            btnPostCommentSubmit: document.getElementById('btn-post-comment-submit'),
            ticketsSourceBtn: document.getElementById('tickets-source-btn'),
            ticketsSourceSummary: document.getElementById('tickets-source-summary'),
            ticketsSourceModal: document.getElementById('tickets-source-modal'),
            btnCloseTicketsSourceModal: document.getElementById('btn-close-tickets-source-modal'),
            btnCloseTicketsSourceModalAction: document.getElementById('btn-close-tickets-source-modal-action'),
            ticketsAgentApiBtn: document.getElementById('tickets-agent-api'),
            ticketsAgentApiModal: document.getElementById('tickets-agent-api-modal'),
            btnCloseTicketsAgentApiModal: document.getElementById('btn-close-tickets-agent-api-modal'),
            btnCloseTicketsAgentApiModalAction: document.getElementById('btn-close-tickets-agent-api-modal-action')
        };
    }

    function isTicketsTabActive() {
        return document.querySelector('.shared-tab-btn.active')?.dataset.tab === 'tickets';
    }

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

    document.getElementById('docs-workspace-filter')?.addEventListener('change', (e) => {
        state.docsWorkspaceRootFilter = e.target.value;
        _restoredPanelState.panel['docs.root'] = e.target.value;
        persistTab('docs.root', state.docsWorkspaceRootFilter);
        rerenderUnifiedDocs();
    });

    document.getElementById('docs-cache-mode')?.addEventListener('change', (e) => {
        const mode = e.target.value;
        vscode.postMessage({
            type: 'setPlanningPanelSyncMode',
            mode
        });
        const picker = document.getElementById('docs-sync-container-picker');
        if (picker) {
            picker.style.display = mode === 'sync-selected' ? 'flex' : 'none';
        }
        if (mode === 'sync-selected') {
            vscode.postMessage({ type: 'fetchAvailableSyncContainers' });
        }
    });

    const allSources = ['local', 'clickup', 'linear', 'notion', 'antigravity'];
    const sourceFilterSelect = document.getElementById('docs-source-filter');
    if (sourceFilterSelect) {
        // Set initial dropdown value based on persisted state.
        // Clarification: if the persisted filter is not exactly one valid source
        // (e.g. a legacy multi-select like ['local','notion']), normalize it to
        // "All Sources" AND reset the underlying filter + persist, so the dropdown
        // label never contradicts what the sidebar actually shows.
        const currentFilter = state.docsSourceFilter || allSources;
        if (currentFilter.length === 1 && allSources.includes(currentFilter[0])) {
            sourceFilterSelect.value = currentFilter[0];
        } else {
            sourceFilterSelect.value = 'all';
            if (currentFilter.length !== allSources.length) {
                state.docsSourceFilter = allSources;
                const persisted = vscode.getState() || {};
                vscode.setState({ ...persisted, docsSourceFilter: state.docsSourceFilter });
            }
        }

        sourceFilterSelect.addEventListener('change', (e) => {
            const value = e.target.value;
            state.docsSourceFilter = value === 'all' ? allSources : [value];
            const currentPersisted = vscode.getState() || {};
            vscode.setState({
                ...currentPersisted,
                docsSourceFilter: state.docsSourceFilter
            });
            rerenderUnifiedDocs();
        });
    }

    function wireSidebarSearch(inputId, onSearch) {
        const input = document.getElementById(inputId);
        if (!input) return;
        let debounceTimer;
        input.addEventListener('input', () => {
            clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => {
                onSearch(input.value);
            }, 200);
        });
    }

    wireSidebarSearch('docs-search', (value) => {
        state.localDocsSearch = value;
        state.onlineDocsSearch = value;
        rerenderUnifiedDocs();
    });


    wireSidebarSearch('tickets-search', (value) => {
        if (lastIntegrationProvider === 'linear') {
            linearProjectSearchValue = value;
            renderTicketsLinearList();
            saveTicketsState();
        } else if (lastIntegrationProvider === 'clickup') {
            clickUpProjectSearchValue = value;
            renderTicketsClickUpList();
            saveTicketsState();
        }
    });

    function getActiveTabName() {
        const activeBtn = document.querySelector('.shared-tab-btn.active');
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
        if (activeTab === 'tickets') {
            state.ticketsPreviewCollapsed = !state.ticketsPreviewCollapsed;
            applySidebarState('tickets', state.ticketsPreviewCollapsed);
        } else if (activeTab === 'kanban') {
            state.kanbanListCollapsed = !state.kanbanListCollapsed;
            applySidebarState('kanban', state.kanbanListCollapsed);
        } else {
            state.docsListCollapsed = !state.docsListCollapsed;
            applySidebarState('docs', state.docsListCollapsed);
            applySidebarState('research', state.docsListCollapsed);
        }

        // Persist state
        const currentPersisted = vscode.getState() || {};
        vscode.setState({
            ...currentPersisted,
            docsListCollapsed: state.docsListCollapsed,
            ticketsPreviewCollapsed: state.ticketsPreviewCollapsed,
            kanbanListCollapsed: state.kanbanListCollapsed
        });
    }

    // Initialize sidebar state
    applySidebarState('docs', state.docsListCollapsed);
    applySidebarState('research', state.docsListCollapsed);
    applySidebarState('tickets', state.ticketsPreviewCollapsed);
    applySidebarState('kanban', state.kanbanListCollapsed);

    // Bind sidebar toggle listeners
    document.querySelectorAll('.sidebar-toggle-btn').forEach(btn => {
        btn.addEventListener('click', toggleSidebarCollapsed);
    });

    // Tab management
    const tabButtons = document.querySelectorAll('.shared-tab-btn');
    const tabContents = document.querySelectorAll('.shared-tab-content');

    function switchToTab(tabName) {
        // 1. Clean up dirty flags and edit/review modes (same logic as click handler)
        if (state.dirtyFlags.docs && tabName !== 'docs') { exitEditMode('docs', true); }
        if (state.dirtyFlags.kanban && tabName !== 'kanban') { exitEditMode('kanban', true); }
        if (state.editMode.docs && tabName !== 'docs') { exitEditMode('docs', true); }
        if (state.editMode.kanban && tabName !== 'kanban') { exitEditMode('kanban', true); }
        if (state.reviewMode.kanban && tabName !== 'kanban') { exitReviewMode('kanban', true); }

        // 2. Clear stale pending selection when navigating away from kanban
        if (tabName !== 'kanban' && _pendingKanbanSelection) {
            _pendingKanbanSelection = null;
        }

        // 3. Update active classes
        tabButtons.forEach(b => b.classList.remove('active'));
        tabContents.forEach(c => c.classList.remove('active'));
        const targetBtn = document.querySelector(`.shared-tab-btn[data-tab="${tabName}"]`);
        if (targetBtn) targetBtn.classList.add('active');
        const targetContent = document.getElementById(tabName === 'docs' ? 'docs-content' : `${tabName}-content`);
        if (targetContent) targetContent.classList.add('active');

        // 4. Apply sidebar state
        if (tabName === 'tickets') { applySidebarState('tickets', state.ticketsPreviewCollapsed); }
        else if (tabName === 'kanban') { applySidebarState('kanban', state.kanbanListCollapsed); }
        else if (tabName === 'docs' || tabName === 'local' || tabName === 'research' || tabName === 'online') {
            applySidebarState(tabName === 'docs' ? 'docs' : tabName, state.docsListCollapsed);
        }

        // 5. Tab-specific initialization
        if (tabName === 'kanban') {
            vscode.postMessage({ type: 'fetchKanbanPlans', requestId: Date.now() });
        }
        if (tabName === 'docs') {
            vscode.postMessage({ type: 'getPlanningPanelSyncMode' });
        }
        if (tabName === 'tickets') {
            // Restore persisted state only once — re-running it on every tab entry
            // re-kicked the ClickUp restore chain and refetched everything each visit.
            // After the initial load, fetching is manual via the Refresh button.
            if (!ticketsInitialized) {
                initTicketsTab();
                restoreTicketsState();
                ticketsInitialized = true;
            }
            if (lastIntegrationProvider && !ticketsLoadedOnce) {
                // Always load hierarchy for navigation; ticketsAutoSync only
                // controls task content source (API vs local files).
                if (lastIntegrationProvider === 'clickup') loadClickUpSpaces();
                else if (lastIntegrationProvider === 'linear') loadLinearProject();
                if (!ticketsAutoSync) {
                    loadLocalTicketFiles();
                }
            } else {
                renderTicketsTab();
            }
        } else {
            if (ticketsInitialized) { saveTicketsState(); }
        }
    }

    tabButtons.forEach(btn => {
        btn.addEventListener('click', () => {
            switchToTab(btn.dataset.tab);
        });
    });

    // Initialize the initially active tab
    const initialTab = document.querySelector('.shared-tab-btn.active')?.dataset.tab || 'local';
    switchToTab(initialTab);

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
            folderPath: folderPath || undefined,
            workspaceRoot: researchWorkspaceRoot || undefined
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

            const originalText = copyResearchPromptBtn.innerText;
            const prompt = generateResearchPrompt();
            if (!prompt) {
                copyResearchPromptBtn.innerText = 'NO TOPIC';
                setTimeout(() => {
                    if (copyResearchPromptBtn) copyResearchPromptBtn.innerText = originalText;
                }, 2000);
                return;
            }
            try {
                await navigator.clipboard.writeText(prompt);
                copyResearchPromptBtn.innerText = 'COPIED';
                setTimeout(() => {
                    if (copyResearchPromptBtn) copyResearchPromptBtn.innerText = originalText;
                    const researchInput = document.getElementById('research-prompt-input');
                    if (researchInput) researchInput.value = '';
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
        draftWithAnalystBtn.addEventListener('click', async () => {
            if (draftWithAnalystBtn.innerText === 'COPIED') return;

            const originalText = draftWithAnalystBtn.innerText;
            const prompt = generateResearchPrompt();
            if (!prompt) {
                draftWithAnalystBtn.innerText = 'NO TOPIC';
                setTimeout(() => {
                    if (draftWithAnalystBtn) draftWithAnalystBtn.innerText = originalText;
                }, 2000);
                return;
            }
            try {
                await navigator.clipboard.writeText(prompt);
                draftWithAnalystBtn.innerText = 'COPIED';
                setTimeout(() => {
                    if (draftWithAnalystBtn) draftWithAnalystBtn.innerText = originalText;
                }, 2000);
            } catch (err) {
                console.error('[Research] Failed to copy to clipboard:', err);
                draftWithAnalystBtn.innerText = 'FAILED';
                setTimeout(() => {
                    if (draftWithAnalystBtn) draftWithAnalystBtn.innerText = originalText;
                }, 2000);
            }
        });
    }

    registerWorkspaceDropdown('research-workspace-filter', 'research', false);
    registerWorkspaceDropdown('notebook-workspace-filter', 'notebook', false);
    registerWorkspaceDropdown('docs-workspace-filter', 'docs');

    document.getElementById('research-workspace-filter')?.addEventListener('change', (e) => {
        const newRoot = e.target.value;
        if (!newRoot) return;
        researchWorkspaceRoot = newRoot;
        persistResearchState();
        restoreResearchStateForRoot();
    });

    document.getElementById('notebook-workspace-filter')?.addEventListener('change', (e) => {
        const newRoot = e.target.value;
        if (!newRoot) return;
        notebookWorkspaceRoot = newRoot;
        persistTab('notebook.root', notebookWorkspaceRoot);
    });

    const manageResearchFoldersBtn = document.getElementById('btn-manage-research-folders');
    if (manageResearchFoldersBtn) {
        manageResearchFoldersBtn.addEventListener('click', () => openFoldersModal('research'));
    }

    const researchFolderSelect = document.getElementById('research-destination-folder');
    if (researchFolderSelect) {
        researchFolderSelect.addEventListener('change', () => {
            if (researchWorkspaceRoot) {
                lastResearchFolderByRoot[researchWorkspaceRoot] = researchFolderSelect.value || null;
                persistResearchState();
            }
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
            vscode.postMessage({
                type: 'airlock_export',
                workspaceRoot: notebookWorkspaceRoot || undefined
            });
        });
    }

    if (openNotebookLMBtn) {
        openNotebookLMBtn.addEventListener('click', () => {
            vscode.postMessage({
                type: 'airlock_openNotebookLM',
                workspaceRoot: notebookWorkspaceRoot || undefined
            });
        });
    }

    if (openAirlockFolderBtn) {
        openAirlockFolderBtn.addEventListener('click', () => {
            vscode.postMessage({
                type: 'airlock_openFolder',
                workspaceRoot: notebookWorkspaceRoot || undefined
            });
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

    const importNotebookLMBtn = document.getElementById('btn-import-notebooklm-plans');
    if (importNotebookLMBtn) {
        importNotebookLMBtn.addEventListener('click', () => {
            importNotebookLMBtn.disabled = true;
            importNotebookLMBtn.textContent = 'IMPORTING...';
            vscode.postMessage({
                type: 'importNotebookLMPlans',
                workspaceRoot: notebookWorkspaceRoot || undefined
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
    const treePaneOnline = document.getElementById('tree-pane');
    const markdownPreview = document.getElementById('markdown-preview');
    const markdownPreviewOnline = document.getElementById('markdown-preview');
    const statusEl = document.getElementById('status');
    const statusElOnline = document.getElementById('status');

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
                    btn.className = 'card-icon-btn' + (action === 'Link Doc' ? ' html-link-btn' : ' card-delete-btn');
                    if (action === 'Link Doc') {
                        btn.innerHTML = '<span class="btn-label">Link</span>';
                    } else {
                        btn.textContent = '×';
                    }
                    btn.title = action === 'Link Doc' ? 'Copy validated document path' : 'Delete';
                    btn.setAttribute('data-tooltip', action === 'Link Doc' ? 'Copy validated document path' : 'Delete');
                    btn.setAttribute('aria-label', action === 'Link Doc' ? 'Copy link to document' : 'Delete document');
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
                        if (!nodeMetadata?.sourceFolder) {
                            console.error('[PlanningPanel] Link Doc clicked but sourceFolder is missing');
                            return;
                        }
                        vscode.postMessage({
                            type: 'linkToDocument',
                            sourceId: sourceId,
                            docId: nodeId,
                            docName: title,
                            sourceFolder: nodeMetadata.sourceFolder
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
                            docName: title,
                            sourceFolder: nodeMetadata ? nodeMetadata.sourceFolder : undefined
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
                actions = ['Link Doc', 'Delete'];
            } else {
                actions = ['Import', 'Link Doc'];
            }

            let title = node.title || node.name;
            let subtitle = (node.title && node.title !== node.name) ? node.name : undefined;

            const cardWrapper = renderDocCard({
                title,
                subtitle,
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
        if (state.dirtyFlags.docs) {
            exitEditMode('docs', true);
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

    // state.activeDocId for an online tree selection is the remote docId. The backend
    // resolves the local .md file by slugPrefix, so translate via the imported-docs map
    // (keyed by docId/slugPrefix/docName); fall back to activeDocId if not found.
    function resolveActiveOnlineSlugPrefix() {
        const entry = state.importedDocs.get(state.activeDocId);
        return entry && entry.slugPrefix ? entry.slugPrefix : state.activeDocId;
    }

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
                vscode.postMessage({ type: 'removeLocalFolder', folderPath: path, workspaceRoot: state.docsWorkspaceRootFilter || _workspaceItems[0]?.workspaceRoot || '' });
            });

            row.appendChild(pathSpan);
            row.appendChild(removeBtn);
            folderList.appendChild(row);
        });
    }

    function getCurrentFolderPaths(map, filter) {
        // De-dupe: the same folder can be registered under multiple workspace roots
        if (filter && map[filter]) {
            return [...new Set(map[filter])];
        }
        if (filter) {
            return [];
        }
        return [...new Set(Object.values(map || {}).flat())];
    }

    function renderFolderListModal() {
        const folderListModal = document.getElementById('folder-list-modal');
        if (!folderListModal) return;
        folderListModal.innerHTML = '';

        let folderPaths = [];
        if (folderModalScope === 'tickets') {
            folderPaths = getCurrentFolderPaths(state.ticketsFolderPathsByRoot || {}, state.docsWorkspaceRootFilter);
        } else if (folderModalScope === 'research') {
            folderPaths = getCurrentFolderPaths(state.localFolderPathsByRoot, researchWorkspaceRoot);
        } else {
            folderPaths = getCurrentFolderPaths(state.localFolderPathsByRoot, state.docsWorkspaceRootFilter);
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

            const pathSpan = document.createElement('span');
            pathSpan.className = 'folder-path';
            pathSpan.textContent = path;
            pathSpan.title = path;

            const removeBtn = document.createElement('button');
            removeBtn.className = 'folder-list-remove-btn';
            removeBtn.textContent = 'Remove';
            removeBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                let workspaceRoot;
                if (folderModalScope === 'tickets') {
                    workspaceRoot = state.docsWorkspaceRootFilter || _workspaceItems[0]?.workspaceRoot || '';
                    vscode.postMessage({ type: 'removeTicketsFolder', folderPath: path, workspaceRoot });
                } else if (folderModalScope === 'research') {
                    workspaceRoot = researchWorkspaceRoot || _workspaceItems[0]?.workspaceRoot || '';
                    vscode.postMessage({ type: 'removeLocalFolder', folderPath: path, workspaceRoot });
                } else {
                    workspaceRoot = state.docsWorkspaceRootFilter || _workspaceItems[0]?.workspaceRoot || '';
                    vscode.postMessage({ type: 'removeLocalFolder', folderPath: path, workspaceRoot });
                }
            });

            row.appendChild(pathSpan);
            row.appendChild(removeBtn);
            folderListModal.appendChild(row);
        });
    }



    function updateSyncButtonVisibility() {
        const btnSync = document.getElementById('btn-sync-to-online');
        if (!btnSync) return;
        
        let canSync = false;
        if (state.activeSource && ONLINE_SOURCES.includes(state.activeSource)) {
            const entry = state.importedDocs.get(state.activeDocId);
            if (entry && entry.canSync) {
                canSync = true;
            }
        } else if (state.activeSource === 'local-folder') {
            const entry = state.importedDocs.get(state.activeDocName) || state.importedDocs.get(state.activeDocId);
            if (entry && entry.canSync) {
                canSync = true;
            }
        }
        
        if (canSync) {
            btnSync.style.display = '';
            btnSync.disabled = false;
        } else {
            btnSync.style.display = 'none';
            btnSync.disabled = true;
        }
    }

    function renderUnifiedDocs(localRoots, onlineRoots, enabledSources) {
        if (!treePane) return;
        
        treePane.innerHTML = '';
        
        const toggleRow = document.createElement('div');
        toggleRow.className = 'sidebar-toggle-row';
        
        const foldersBtn = document.createElement('button');
        foldersBtn.className = 'sidebar-folders-btn';
        foldersBtn.title = 'Manage Folders';
        foldersBtn.id = 'btn-manage-folders';
        foldersBtn.textContent = 'Manage Folders';
        foldersBtn.addEventListener('click', () => openFoldersModal('local'));
        
        const toggleBtn = document.createElement('button');
        toggleBtn.className = 'sidebar-toggle-btn';
        toggleBtn.title = 'Toggle sidebar';
        toggleBtn.textContent = state.docsListCollapsed ? '»' : '«';
        toggleBtn.addEventListener('click', toggleSidebarCollapsed);
        
        toggleRow.appendChild(foldersBtn);
        toggleRow.appendChild(toggleBtn);
        treePane.appendChild(toggleRow);
        
        const filterSet = new Set(state.docsSourceFilter || ['local', 'clickup', 'linear', 'notion', 'antigravity']);
        
        if (filterSet.has('local') && localRoots) {
            const { sourceId, nodes, folderPaths, error } = localRoots;
            
            const docList = document.createElement('div');
            docList.className = 'source-doc-list';
            docList.dataset.sourceId = 'local-folder';
            treePane.appendChild(docList);
            
            if (error) {
                docList.innerHTML = `<div class="error-state">Error: ${error}</div>`;
            } else if (!nodes || nodes.length === 0) {
                docList.innerHTML = '<div class="empty-state" style="padding: 12px; font-size: 12px; color: var(--text-secondary);">No folders configured or all folders are empty. Click Manage Folders to get started.</div>';
            } else {
                const folderNodes = (nodes || []).filter(n => n.kind === 'folder' || n.isDirectory);
                let docNodes = (nodes || []).filter(n => n.kind === 'document' && !n.isDirectory && n.name !== 'implementation_plan.md');
                
                const search = String(state.localDocsSearch || '').trim().toLowerCase();
                if (search) {
                    docNodes = docNodes.filter(d => (d.title || d.name || '').toLowerCase().includes(search));
                }
                
                const docsBySourceFolder = new Map();
                const foldersBySourceFolder = new Map();
                
                docNodes.forEach(d => {
                    const sourceFolder = d.metadata?.sourceFolder;
                    if (!sourceFolder) return;
                    if (!docsBySourceFolder.has(sourceFolder)) docsBySourceFolder.set(sourceFolder, []);
                    docsBySourceFolder.get(sourceFolder).push(d);
                });
                
                folderNodes.forEach(f => {
                    const sourceFolder = f.metadata?.sourceFolder;
                    if (!sourceFolder) return;
                    if (!foldersBySourceFolder.has(sourceFolder)) foldersBySourceFolder.set(sourceFolder, []);
                    foldersBySourceFolder.get(sourceFolder).push(f);
                });
                
                const sourceFolders = [...new Set([...(folderPaths || []), ...docsBySourceFolder.keys()])];
                const totalSourceFolders = sourceFolders.length;
                
                sourceFolders.forEach(sourceFolder => {
                    const folderDocs = docsBySourceFolder.get(sourceFolder) || [];
                    const sourceFolderNodes = foldersBySourceFolder.get(sourceFolder) || [];
                    
                    if (folderDocs.length === 0) return;
                    
                    const folderName = sourceFolder.split(/[\\/]/).filter(Boolean).pop() || sourceFolder;
                    
                    const headerContainer = document.createElement('div');
                    headerContainer.className = 'folder-section-container';
                    
                    const sourceHeader = document.createElement('div');
                    sourceHeader.className = 'folder-subheader source-folder-header';
                    sourceHeader.title = sourceFolder;
                    sourceHeader.style.cursor = 'pointer';
                    
                    const labelWrapper = document.createElement('div');
                    labelWrapper.style.cssText = 'display: flex; flex-direction: column; gap: 2px; flex: 1;';
                    
                    const labelSpan = document.createElement('span');
                    labelSpan.style.fontWeight = 'bold';
                    
                    const chevronSpan = document.createElement('span');
                    chevronSpan.className = 'section-chevron';
                    chevronSpan.style.marginRight = '6px';
                    
                    const docCount = folderDocs.length;
                    labelSpan.textContent = `${folderName} (${docCount})`;
                    labelSpan.prepend(chevronSpan);
                    labelWrapper.appendChild(labelSpan);

                    sourceHeader.appendChild(labelWrapper);
                    
                    const actionsDiv = document.createElement('div');
                    actionsDiv.style.cssText = 'display: flex; gap: 4px;';
                    
                    const linkBtn = document.createElement('button');
                    linkBtn.className = 'folder-link-btn';
                    linkBtn.textContent = 'Link';
                    linkBtn.addEventListener('click', (e) => {
                        e.stopPropagation();
                        vscode.postMessage({ type: 'linkToFolder', folderPath: sourceFolder });
                    });
                    actionsDiv.appendChild(linkBtn);
                    
                    const createBtn = document.createElement('button');
                    createBtn.className = 'folder-create-btn';
                    createBtn.textContent = '+';
                    createBtn.addEventListener('click', (e) => {
                        e.stopPropagation();
                        vscode.postMessage({ type: 'createLocalDoc', folderPath: sourceFolder });
                    });
                    actionsDiv.appendChild(createBtn);
                    
                    const importBtn = document.createElement('button');
                    importBtn.className = 'folder-import-btn';
                    importBtn.textContent = 'Import';
                    importBtn.addEventListener('click', (e) => {
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
                        vscode.postMessage({ type: 'importResearchDoc', folderPath: sourceFolder });
                    });
                    actionsDiv.appendChild(importBtn);
                    
                    sourceHeader.appendChild(actionsDiv);
                    headerContainer.appendChild(sourceHeader);
                    
                    const contentDiv = document.createElement('div');
                    contentDiv.className = 'folder-section-content';
                    headerContainer.appendChild(contentDiv);
                    
                    if (state.docsSectionCollapsed === undefined) {
                        state.docsSectionCollapsed = {};
                    }
                    
                    let isCollapsed = state.docsSectionCollapsed[sourceFolder];
                    if (isCollapsed === undefined) {
                        isCollapsed = totalSourceFolders > 4;
                    }
                    
                    const hasSelectedDoc = folderDocs.some(d => state.activeSource === 'local-folder' && state.activeDocId === d.id);
                    if (hasSelectedDoc || search) {
                        isCollapsed = false;
                    }
                    
                    state.docsSectionCollapsed[sourceFolder] = isCollapsed;
                    
                    const updateCollapsedUI = () => {
                        chevronSpan.textContent = isCollapsed ? '▸ ' : '▾ ';
                        contentDiv.style.display = isCollapsed ? 'none' : 'block';
                    };
                    
                    sourceHeader.addEventListener('click', (e) => {
                        if (e.target.closest('button')) return;
                        isCollapsed = !isCollapsed;
                        state.docsSectionCollapsed[sourceFolder] = isCollapsed;
                        updateCollapsedUI();
                        const currentPersisted = vscode.getState() || {};
                        vscode.setState({
                            ...currentPersisted,
                            docsSectionCollapsed: state.docsSectionCollapsed
                        });
                    });
                    
                    updateCollapsedUI();
                    
                    const folderNameMap = new Map();
                    sourceFolderNodes.forEach(f => folderNameMap.set(f.id, f.name));
                    
                    const docsByFolder = new Map();
                    const rootDocs = [];
                    folderDocs.forEach(d => {
                        const docPath = d.id || d.relativePath || '';
                        const lastSlashIdx = docPath.lastIndexOf('/');
                        const parentFolderId = lastSlashIdx > 0 ? docPath.substring(0, lastSlashIdx) : null;
                        
                        if (parentFolderId && folderNameMap.has(parentFolderId)) {
                            if (!docsByFolder.has(parentFolderId)) docsByFolder.set(parentFolderId, []);
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
                        const subLabel = document.createElement('span');
                        subLabel.textContent = folder.name;
                        subheader.appendChild(subLabel);
                        
                        const subLinkBtn = document.createElement('button');
                        subLinkBtn.className = 'folder-link-btn';
                        subLinkBtn.textContent = 'Link';
                        subLinkBtn.addEventListener('click', (e) => {
                            e.stopPropagation();
                            vscode.postMessage({ type: 'linkToFolder', folderPath: folder.id });
                        });
                        subheader.appendChild(subLinkBtn);
                        
                        const subCreateBtn = document.createElement('button');
                        subCreateBtn.className = 'folder-create-btn';
                        subCreateBtn.textContent = '+';
                        subCreateBtn.addEventListener('click', (e) => {
                            e.stopPropagation();
                            vscode.postMessage({ type: 'createLocalDoc', folderPath: folder.id });
                        });
                        subheader.appendChild(subCreateBtn);
                        
                        const subImportBtn = document.createElement('button');
                        subImportBtn.className = 'folder-import-btn';
                        subImportBtn.textContent = 'Import';
                        subImportBtn.addEventListener('click', (e) => {
                            e.stopPropagation();
                            document.querySelectorAll('.folder-import-btn').forEach(btn => {
                                btn.disabled = true;
                                btn.textContent = '...';
                            });
                            vscode.postMessage({ type: 'importResearchDoc', folderPath: folder.id });
                        });
                        subheader.appendChild(subImportBtn);
                        
                        contentDiv.appendChild(subheader);
                        
                        folderDocsInSource.forEach(doc => {
                            if (doc.name && state.importedDocs.has(doc.name)) {
                                return;
                            }
                            const { wrapper } = renderNode(doc, 'local-folder');
                            contentDiv.appendChild(wrapper);
                        });
                    });
                    
                    rootDocs.forEach(doc => {
                        if (doc.name && state.importedDocs.has(doc.name)) {
                            return;
                        }
                        const { wrapper } = renderNode(doc, 'local-folder');
                        contentDiv.appendChild(wrapper);
                    });
                    
                    docList.appendChild(headerContainer);
                });
            }
        }
        
        if (onlineRoots && onlineRoots.length > 0) {
            const effectiveEnabledSources = enabledSources || { clickup: true, linear: true, notion: true };
            const filteredRoots = onlineRoots.filter(({ sourceId }) => {
                return filterSet.has(sourceId) && effectiveEnabledSources[sourceId] !== false;
            });
            
            filteredRoots.forEach(({ sourceId, nodes }) => {
                const headerContainer = document.createElement('div');
                headerContainer.className = 'folder-section-container';
                
                const headerRow = document.createElement('div');
                headerRow.className = 'source-header-row folder-subheader';
                headerRow.style.cursor = 'pointer';
                
                const header = document.createElement('div');
                header.className = 'source-header';
                header.dataset.sourceId = sourceId;
                
                const chevronSpan = document.createElement('span');
                chevronSpan.className = 'section-chevron';
                chevronSpan.style.marginRight = '6px';
                
                header.textContent = SOURCE_DISPLAY_NAMES[sourceId] || sourceId;
                header.prepend(chevronSpan);
                headerRow.appendChild(header);
                
                const controlsContainer = document.createElement('div');
                controlsContainer.className = 'source-controls';
                controlsContainer.dataset.sourceId = sourceId;
                
                const refreshBtn = document.createElement('button');
                refreshBtn.className = 'source-refresh-btn';
                refreshBtn.textContent = '↻';
                refreshBtn.title = 'Refresh';
                refreshBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    refreshBtn.disabled = true;
                    vscode.postMessage({ type: 'refreshSource', sourceId });
                });
                controlsContainer.appendChild(refreshBtn);
                
                const newBtn = document.createElement('button');
                newBtn.className = 'source-new-btn';
                newBtn.textContent = '+ New';
                newBtn.title = 'Create new document';
                newBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const activeContainer = state.activeContainers.get(sourceId);
                    vscode.postMessage({ type: 'createOnlineDocument', sourceId, parentId: activeContainer?.id });
                });
                controlsContainer.appendChild(newBtn);
                
                const locationBtn = document.createElement('button');
                locationBtn.className = 'source-location-btn';
                locationBtn.innerHTML = '&#9881;';
                locationBtn.title = 'Set upload location';
                locationBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    vscode.postMessage({ type: 'setUploadLocation', sourceId });
                });
                controlsContainer.appendChild(locationBtn);
                
                headerRow.appendChild(controlsContainer);
                headerContainer.appendChild(headerRow);
                
                const contentDiv = document.createElement('div');
                contentDiv.className = 'folder-section-content source-doc-list';
                contentDiv.dataset.sourceId = sourceId;
                headerContainer.appendChild(contentDiv);
                
                if (!nodes || nodes.length === 0) {
                    contentDiv.innerHTML = '<div class="tree-placeholder">Loading...</div>';
                    vscode.postMessage({ type: 'fetchContainers', sourceId });
                } else {
                    const search = String(state.onlineDocsSearch || state.localDocsSearch || '').trim().toLowerCase();
                    const filteredNodes = search
                        ? (nodes || []).filter(n => (n.title || n.name || '').toLowerCase().includes(search))
                        : (nodes || []);
                    
                    filteredNodes.forEach(node => {
                        const { wrapper } = renderNode(node, sourceId);
                        contentDiv.appendChild(wrapper);
                    });
                }
                
                if (state.docsSectionCollapsed === undefined) {
                    state.docsSectionCollapsed = {};
                }
                
                let isCollapsed = state.docsSectionCollapsed[sourceId];
                if (isCollapsed === undefined) {
                    isCollapsed = false;
                }
                
                const hasSelectedDoc = nodes && nodes.some(d => state.activeSource === sourceId && state.activeDocId === d.id);
                const search = String(state.onlineDocsSearch || state.localDocsSearch || '').trim().toLowerCase();
                if (hasSelectedDoc || search) {
                    isCollapsed = false;
                }
                
                state.docsSectionCollapsed[sourceId] = isCollapsed;
                
                const updateCollapsedUI = () => {
                    chevronSpan.textContent = isCollapsed ? '▸ ' : '▾ ';
                    contentDiv.style.display = isCollapsed ? 'none' : 'block';
                };
                
                headerRow.addEventListener('click', (e) => {
                    if (e.target.closest('button') || e.target.closest('select')) return;
                    isCollapsed = !isCollapsed;
                    state.docsSectionCollapsed[sourceId] = isCollapsed;
                    updateCollapsedUI();
                    const currentPersisted = vscode.getState() || {};
                    vscode.setState({
                        ...currentPersisted,
                        docsSectionCollapsed: state.docsSectionCollapsed
                    });
                });
                
                updateCollapsedUI();
                treePane.appendChild(headerContainer);
            });
        }
        
        if (filterSet.has('antigravity') && state._lastLocalDocsMsg) {
            renderAntigravitySessions(state._lastLocalDocsMsg.antigravitySessions || [], state._lastLocalDocsMsg.antigravityEnabled || false);
        }
        
        if (state.activeDocId) {
            const activeNode = findTreeNode(state.activeSource, state.activeDocId);
            if (activeNode) {
                activeNode.classList.add('selected');
                state.selectedEl = activeNode;
            }
        }
        
        updateSyncButtonVisibility();
    }

    function rerenderUnifiedDocs() {
        const localRoots = state._lastLocalDocsMsg ? {
            sourceId: state._lastLocalDocsMsg.sourceId || 'local-folder',
            nodes: state.docsWorkspaceRootFilter
                ? (state._lastLocalDocsMsg.nodes || []).filter(n => {
                    if (n.metadata?.root === state.docsWorkspaceRootFilter) return true;
                    // Fallback: file may be tagged to a different root by cross-root dedup,
                    // but its sourceFolder is configured under the selected root.
                    const rootFolders = new Set(state.localFolderPathsByRoot?.[state.docsWorkspaceRootFilter] || []);
                    return rootFolders.has(n.metadata?.sourceFolder);
                  })
                : (state._lastLocalDocsMsg.nodes || []),
            folderPaths: getCurrentFolderPaths(state.localFolderPathsByRoot, state.docsWorkspaceRootFilter),
            error: state._lastLocalDocsMsg.error
        } : null;
        
        const onlineRoots = state._lastOnlineDocsMsg
            ? (state._lastOnlineDocsMsg.roots || [])
            : null;
        
        renderUnifiedDocs(localRoots, onlineRoots, state.enabledSources);
    }

    function applyUnifiedDocsSearchFilter() {
        const search = String(state.localDocsSearch || '').trim().toLowerCase();
        if (!treePane) return;
        const nodes = treePane.querySelectorAll('.tree-node');
        nodes.forEach(node => {
            if (node.classList.contains('source-folder-header') || node.classList.contains('source-header')) {
                return;
            }
            const name = (node.dataset.name || '').toLowerCase();
            const label = node.querySelector('.label');
            const text = (label ? label.textContent : '').toLowerCase();
            const match = !search || name.includes(search) || text.includes(search);
            if (match) {
                node.style.display = '';
                let parent = node.parentElement;
                while (parent && parent !== treePane) {
                    if (parent.classList && parent.classList.contains('tree-node')) {
                        parent.style.display = '';
                    }
                    parent = parent.parentElement;
                }
            } else {
                node.style.display = 'none';
            }
        });
    }

    function renderAntigravitySessions(sessions, enabled) {
        if (!treePane) { return; }

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
            const sortedSessions = [...sessions].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

            const groups = new Map();
            for (const session of sortedSessions) {
                const dateKey = new Date(session.timestamp).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
                if (!groups.has(dateKey)) groups.set(dateKey, []);
                groups.get(dateKey).push(session);
            }

            for (const [dateKey, dateSessions] of groups) {
                const dateHeader = document.createElement('div');
                dateHeader.className = 'antigravity-date-subheader';
                dateHeader.textContent = dateKey;
                section.appendChild(dateHeader);

                for (const session of dateSessions) {
                    const sessionTime = new Date(session.timestamp).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

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

    function handleLocalDocsReady(msg) {
        console.log('[PlanningPanel Webview] handleLocalDocsReady called:', msg);
        state._lastLocalDocsMsg = msg;
        state.localFolderPathsByRoot = msg.folderPathsByRoot || {};
        state.ticketsFolderPathsByRoot = msg.ticketsFolderPathsByRoot || {};
        resolveDocsWorkspaceFilter(msg.workspaceItems || []);
        populateWorkspaceDropdown('docs-workspace-filter', msg.workspaceItems || [], state.docsWorkspaceRootFilter);
        
        rerenderUnifiedDocs();

        state.antigravityEnabled = msg.antigravityEnabled || false;
        const agToggleModal = document.getElementById('antigravity-toggle-modal');
        if (agToggleModal) { agToggleModal.checked = state.antigravityEnabled; }

        renderFolderListModal();
        populateResearchFolderSelect(getCurrentFolderPaths(state.localFolderPathsByRoot, researchWorkspaceRoot));

        if (state._pendingImportDocName) {
            const pendingPath = state._pendingImportDocName;
            const nodes = document.querySelectorAll('.tree-node');
            let found = null;
            for (let i = 0; i < nodes.length; i++) {
                if (nodes[i].dataset.sourceId === 'local-folder' && nodes[i].dataset.absolutePath === pendingPath) {
                    found = nodes[i];
                    break;
                }
            }
            if (found) {
                state._pendingImportDocName = null;
                loadDocumentPreview('local-folder', found.dataset.nodeId, found.dataset.name);
            }
        }
    }

    function handleOnlineDocsReady(msg) {
        state._lastOnlineDocsMsg = msg;
        _savedBrowseFilterContainers = msg.browseFilterContainers || {};
        state.enabledSources = msg.enabledSources || {};

        resolveDocsWorkspaceFilter(msg.workspaceItems || _workspaceItems);
        populateWorkspaceDropdown('docs-workspace-filter', msg.workspaceItems || _workspaceItems, state.docsWorkspaceRootFilter);
        
        rerenderUnifiedDocs();
        updateSyncToOnlineButtonState();
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
        applyOnlineDocsSearchFilter();
    }



    function handlePreviewReady(msg) {
        const { sourceId, requestId, content, docName, pages, isAutoRefreshed, filePath, htmlContent, webviewUri, isImage } = msg;

        // Auto-refresh notification
        if (isAutoRefreshed) {
            if (state.editMode.docs) {
                state.externalChangePending.docs = true;
                const statusLocal = document.getElementById('status');
                if (statusLocal) {
                    statusLocal.textContent = 'File changed externally — save to overwrite or cancel to reload';
                    statusLocal.style.color = 'var(--vscode-errorForeground, #ff6b6b)';
                }
                return;
            }
            const statusEl = document.getElementById('status');
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
        const targetPreview = markdownPreview;
        const targetStatus = statusEl;
        const btnImportFullDoc = document.getElementById('btn-import-full-doc');
        const btnEdit = document.getElementById('btn-edit');

        if (sourceId === 'local-folder' || sourceId === 'antigravity') {
            state.activeDocFilePath = filePath || null;
            if (btnEdit) btnEdit.disabled = false;
            if (btnImportFullDoc) {
                btnImportFullDoc.style.display = 'none';
                btnImportFullDoc.disabled = true;
            }
        } else {
            state.activeDocFilePath = filePath || null;
            const isImported = state.importedDocs.has(state.activeDocId);
            if (btnEdit) {
                btnEdit.disabled = !isImported;
                if (!isImported) {
                    btnEdit.title = 'Import this document first to edit';
                } else {
                    btnEdit.title = 'Edit document content';
                }
            }
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

        if (state.editMode.docs) {
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

        const isOnline = ONLINE_SOURCES.includes(sourceId);
        const targetPreview = isOnline ? markdownPreviewOnline : markdownPreview;
        const targetStatus = isOnline ? statusElOnline : statusEl;
        const btnImportFullId = isOnline ? 'btn-import-full-doc-online' : 'btn-import-full-doc';

        const errorDiv = document.createElement('div');
        errorDiv.className = 'error-state';
        errorDiv.textContent = 'Error: ' + error;
        targetPreview.innerHTML = '';
        targetPreview.appendChild(errorDiv);
        targetStatus.textContent = 'Error loading preview';

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
        } else if (msg.error) {
            statusEl.textContent = `Error: ${msg.error}`;
            statusElOnline.textContent = `Error: ${msg.error}`;
        }
    }

    function handleThemeChanged(theme) {
        // Track the active Switchboard visual theme
        if (theme) { state.switchboardTheme = theme; }
        // Remove Switchboard visual theme classes
        document.body.classList.remove('theme-claudify', 'theme-afterburner-pro');
        // Cyberpunk CRT effects (scanlines, grid, glow, sweep) are part of the Afterburner aesthetic.
        // Toggle cyber-theme-enabled: on for afterburner ONLY.
        if (state.switchboardTheme === 'afterburner') {
            document.body.classList.add('cyber-theme-enabled');
        } else {
            document.body.classList.remove('cyber-theme-enabled');
        }
        // Apply palette override when claudify is active
        if (state.switchboardTheme === 'claudify') {
            document.body.classList.add('theme-claudify');
        } else if (state.switchboardTheme === 'afterburner-professional') {
            document.body.classList.add('theme-claudify', 'theme-afterburner-pro');
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
        if (isOnline) applyOnlineDocsSearchFilter();
    }

    function handleLocalFolderPathUpdated(msg) {
        const { folderPath, folderPaths, nodes } = msg;
        const targetRoot = msg.workspaceRoot || '';
        if (folderPaths) {
            state.localFolderPathsByRoot[targetRoot] = folderPaths;
        } else if (folderPath) {
            state.localFolderPathsByRoot[targetRoot] = [folderPath];
        }
        const currentPaths = getCurrentFolderPaths(state.localFolderPathsByRoot, state.docsWorkspaceRootFilter);
        renderFolderList(currentPaths);
        renderFolderListModal();
        populateResearchFolderSelect(getCurrentFolderPaths(state.localFolderPathsByRoot, researchWorkspaceRoot));

        if (state._lastLocalDocsMsg) {
            state._lastLocalDocsMsg.nodes = nodes || [];
        }
        rerenderUnifiedDocs();
    }

    function populateResearchFolderSelect(paths) {
        const folderSelect = document.getElementById('research-destination-folder');
        const warningEl = document.getElementById('research-no-folders-warning');
        const importBtn = document.getElementById('btn-import-research-doc-clipboard');

        const hasFolders = paths && paths.length > 0;

        if (warningEl) {
            warningEl.style.display = hasFolders ? 'none' : 'block';
        }
        if (importBtn) {
            importBtn.disabled = !hasFolders;
            importBtn.style.opacity = hasFolders ? '1' : '0.4';
        }

        if (folderSelect) {
            // Skip the rebuild when nothing changed — local docs refresh often, and
            // recreating the options closes an open dropdown / fights user selection.
            const existingValues = Array.from(folderSelect.options).map(o => o.value);
            if (existingValues.length === (paths || []).length &&
                existingValues.every((v, i) => v === paths[i])) {
                return;
            }
            const previousValue = folderSelect.value;
            folderSelect.innerHTML = '';
            (paths || []).forEach(p => {
                const opt = document.createElement('option');
                opt.value = p;
                opt.textContent = p.split('/').pop() || p;
                folderSelect.appendChild(opt);
            });
            if (previousValue && (paths || []).includes(previousValue)) {
                folderSelect.value = previousValue;
            }

            if (hasFolders) {
                const lastFolder = researchWorkspaceRoot ? lastResearchFolderByRoot[researchWorkspaceRoot] : null;
                if (lastFolder && paths.includes(lastFolder)) {
                    folderSelect.value = lastFolder;
                } else {
                    const defaultFolder = paths[0];
                    if (researchWorkspaceRoot) {
                        lastResearchFolderByRoot[researchWorkspaceRoot] = defaultFolder;
                        persistResearchState();
                    }
                    folderSelect.value = defaultFolder;
                }
            } else {
                if (researchWorkspaceRoot) {
                    lastResearchFolderByRoot[researchWorkspaceRoot] = null;
                    persistResearchState();
                }
            }
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

    function handleImportNotebookLMPlansResult(msg) {
        const webaiStatus = document.getElementById('webai-status');
        const importBtn = document.getElementById('btn-import-notebooklm-plans');
        if (webaiStatus) {
            const parts = [];
            if (msg.overwritten > 0) parts.push(`${msg.overwritten} overwritten`);
            if (msg.created > 0) parts.push(`${msg.created} created`);
            if (msg.errors > 0) parts.push(`${msg.errors} failed`);
            webaiStatus.textContent = parts.length > 0 ? `Import: ${parts.join(', ')}` : 'No plans found in clipboard.';
        }
        if (importBtn) {
            importBtn.disabled = false;
            importBtn.textContent = 'IMPORT PLANS';
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

        // Helper functions for recency sorting
        const recencyOf = doc => Date.parse(doc && doc.importedAt) || 0;
        const groupRecency = arr => arr.reduce((m, d) => Math.max(m, recencyOf(d)), 0);
        const sourceRecency = parentGroups => {
            let maxVal = 0;
            parentGroups.forEach(groupDocs => {
                maxVal = Math.max(maxVal, groupRecency(groupDocs));
            });
            return maxVal;
        };

        // Group docs first: sourceId → parentDocName → docs[]
        const docsBySourceAndParent = new Map();
        docs.forEach(doc => {
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

        // Sort within each group by order field to preserve subpage order
        docsBySourceAndParent.forEach((parentGroups) => {
            parentGroups.forEach((groupDocs) => {
                groupDocs.sort((a, b) => (a.order || 0) - (b.order || 0));
            });
        });

        // Sort sources by max recency
        const sortedSources = [...docsBySourceAndParent.entries()].sort((a, b) => sourceRecency(b[1]) - sourceRecency(a[1]));

        // Render docs grouped by source then by parentDocName
        sortedSources.forEach(([sourceId, parentGroups]) => {
            // Skip local-folder source - those docs appear in the main local docs tree
            if (sourceId === 'local-folder') {
                return;
            }

            // Create teal source header: "IMPORTED FROM {source}"
            const sourceHeader = document.createElement('div');
            sourceHeader.className = 'imported-docs-header';
            sourceHeader.textContent = `IMPORTED FROM ${SOURCE_DISPLAY_NAMES[sourceId] || sourceId}`;
            importedDocsContainer.appendChild(sourceHeader);

            // Sort groups within each source by recency
            const sortedGroups = [...parentGroups.entries()].sort((a, b) => groupRecency(b[1]) - groupRecency(a[1]));
            sortedGroups.forEach(([parentDocName, groupDocs]) => {
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
                    // Online docs are selected from the online tree by their remote
                    // docId (state.activeDocId === remote id), so key by docId too —
                    // otherwise the inline Edit gate and slugPrefix resolution miss.
                    if (doc.docId) {
                        state.importedDocs.set(doc.docId, {
                            sourceId: doc.sourceId,
                            docId: doc.docId,
                            docName: doc.docName,
                            slugPrefix: doc.slugPrefix,
                            canSync: doc.canSync
                        });
                    }

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

        // If the currently-previewed online doc just became imported, enable inline Edit
        // (covers the first-time import race where importedDocsReady lands after previewReady).
        const btnEditOnlineRefresh = document.getElementById('btn-edit');
        if (btnEditOnlineRefresh && getActiveTabName() === 'docs' && state.activeDocId && state.importedDocs.has(state.activeDocId)) {
            btnEditOnlineRefresh.disabled = false;
            btnEditOnlineRefresh.title = 'Edit document content';
        }
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

        // Race protection for tickets messages
        const ticketsMsgTypes = [
            'localTicketFilesListed',
            'ticketSyncStatusesLoaded'
        ];
        if (ticketsMsgTypes.includes(msg.type)) {
            if (msg.workspaceRoot && msg.workspaceRoot !== ticketsWorkspaceRoot) {
                console.log(`[PlanningPanel Webview] Dropping tickets message ${msg.type} for non-matching root: ${msg.workspaceRoot} (current: ${ticketsWorkspaceRoot})`);
                return;
            }
        }

        console.log('[PlanningPanel Webview] Received message:', msg.type, msg);

        switch (msg.type) {
            case 'error':
                console.error('[PlanningPanel Webview] Backend error:', msg.message);
                break;
            case 'planningPanelSyncModeReady': {
                const validModes = ['no-sync', 'auto-sync-all', 'sync-selected'];
                const mode = validModes.includes(msg.mode) ? msg.mode : 'no-sync';
                const select = document.getElementById('docs-cache-mode');
                if (select) {
                    select.value = mode;
                }
                const picker = document.getElementById('docs-sync-container-picker');
                if (picker) {
                    picker.style.display = mode === 'sync-selected' ? 'flex' : 'none';
                }
                if (mode === 'sync-selected') {
                    vscode.postMessage({ type: 'fetchAvailableSyncContainers' });
                }
                break;
            }
            case 'availableSyncContainersReady': {
                const list = document.getElementById('docs-containers-list');
                if (!list) break;
                list.innerHTML = '';
                
                // Group by source
                const bySource = {};
                (msg.containers || []).forEach(c => {
                    if (!bySource[c.sourceId]) bySource[c.sourceId] = [];
                    bySource[c.sourceId].push(c);
                });
                
                Object.entries(bySource).forEach(([sourceId, containers]) => {
                    const sourceDiv = document.createElement('div');
                    sourceDiv.style.marginRight = '16px';
                    sourceDiv.style.marginBottom = '8px';
                    
                    const title = document.createElement('div');
                    title.style.fontWeight = 'bold';
                    title.style.color = 'var(--accent-teal)';
                    title.style.marginBottom = '4px';
                    title.textContent = sourceId.toUpperCase();
                    sourceDiv.appendChild(title);
                    
                    containers.forEach(container => {
                        const label = document.createElement('label');
                        label.style.display = 'flex';
                        label.style.alignItems = 'center';
                        label.style.gap = '6px';
                        label.style.cursor = 'pointer';
                        label.style.margin = '2px 0';
                        
                        const checkbox = document.createElement('input');
                        checkbox.type = 'checkbox';
                        checkbox.value = `${sourceId}:${container.id}`;
                        checkbox.checked = (msg.selectedContainers || []).includes(`${sourceId}:${container.id}`);
                        
                        checkbox.addEventListener('change', () => {
                            const checked = Array.from(list.querySelectorAll('input[type="checkbox"]:checked')).map(el => el.value);
                            vscode.postMessage({
                                type: 'setPlanningPanelSelectedContainers',
                                containers: checked
                            });
                        });
                        
                        const span = document.createElement('span');
                        span.textContent = container.name;
                        
                        label.appendChild(checkbox);
                        label.appendChild(span);
                        sourceDiv.appendChild(label);
                    });
                    
                    list.appendChild(sourceDiv);
                });
                break;
            }
            case 'workspaceItemsUpdated': {
                _workspaceItems = msg.items || [];
                _registeredDropdowns.forEach(d => {
                    updateDropdown(d.selectElOrId, d.tabKey, d.includeAllOption);
                });
                break;
            }
            case 'integrationWorkspaces': {
                _integrationWorkspaces = msg.workspaces || [];
                updateTicketsWorkspacePicker();
                break;
            }
            case 'restoredTabState': {
                _restoredPanelState.panel = msg.panel || {};
                _restoredPanelState.byRoot = msg.byRoot || {};
                if (!ticketsWorkspaceRoot) {
                    const restoredRoot = _restoredPanelState.panel['tickets.root'];
                    if (restoredRoot && _workspaceItems.some(item => item.workspaceRoot === restoredRoot)) {
                        ticketsWorkspaceRoot = restoredRoot;
                        const dropdown = document.getElementById('tickets-workspace-filter');
                        if (dropdown) dropdown.value = ticketsWorkspaceRoot;
                        const restoredState = getRestoredState('tickets', restoredRoot);
                        if (restoredState) {
                            restoreTicketsStateForRoot(restoredState);
                        }
                        vscode.postMessage({ type: 'ticketsRootChanged', workspaceRoot: ticketsWorkspaceRoot });
                    } else {
                        vscode.postMessage({ type: 'ticketsDefaultRoot' });
                    }
                } else {
                    if (_pendingTicketsRestore) {
                        _pendingTicketsRestore = false;
                        const restoredState = getRestoredState('tickets', ticketsWorkspaceRoot);
                        if (restoredState) {
                            restoreTicketsStateForRoot(restoredState);
                        }
                    }
                    vscode.postMessage({ type: 'ticketsRootChanged', workspaceRoot: ticketsWorkspaceRoot });
                }
                if (!researchWorkspaceRoot) {
                    const restoredRoot = _restoredPanelState.panel['research.root'];
                    if (restoredRoot && _workspaceItems.some(item => item.workspaceRoot === restoredRoot)) {
                        researchWorkspaceRoot = restoredRoot;
                    } else if (_workspaceItems.length > 0) {
                        researchWorkspaceRoot = _workspaceItems[0].workspaceRoot;
                    }
                    const dropdown = document.getElementById('research-workspace-filter');
                    if (dropdown) dropdown.value = researchWorkspaceRoot;
                    restoreResearchStateForRoot();
                }
                _restoredPanelState.panel['research.root'] = researchWorkspaceRoot;
                if (!notebookWorkspaceRoot) {
                    const restoredRoot = _restoredPanelState.panel['notebook.root'];
                    if (restoredRoot && _workspaceItems.some(item => item.workspaceRoot === restoredRoot)) {
                        notebookWorkspaceRoot = restoredRoot;
                    } else if (_workspaceItems.length > 0) {
                        notebookWorkspaceRoot = _workspaceItems[0].workspaceRoot;
                    }
                    const dropdown = document.getElementById('notebook-workspace-filter');
                    if (dropdown) dropdown.value = notebookWorkspaceRoot;
                }
                _restoredPanelState.panel['notebook.root'] = notebookWorkspaceRoot;

                // Restore Docs workspace filter (single source of truth; "All Workspaces" by default)
                resolveDocsWorkspaceFilter(_workspaceItems);

                // Restore Kanban filters
                const restoredKanbanRoot = _restoredPanelState.panel['kanban.root'] || '';
                if (_workspaceItems.length === 0 || restoredKanbanRoot === '' || _workspaceItems.some(item => item.workspaceRoot === restoredKanbanRoot)) {
                    kanbanFilters.workspaceRoot = restoredKanbanRoot;
                } else {
                    kanbanFilters.workspaceRoot = '';
                }
                kanbanFilters.project = _restoredPanelState.panel['kanban.project'] || '';
                if (kanbanWorkspaceFilter) kanbanWorkspaceFilter.value = kanbanFilters.workspaceRoot;
                if (kanbanProjectFilter) kanbanProjectFilter.value = kanbanFilters.project;
                break;
            }
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
                        btn.textContent = btn.dataset.copyLabel || 'Copy Prompt';
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
            case 'kanbanPlanLogReady': {
                // Remove any existing overlay
                const existingOverlay = document.querySelector('.kanban-log-overlay');
                if (existingOverlay) existingOverlay.remove();

                const overlay = document.createElement('div');
                overlay.className = 'kanban-log-overlay';

                const modal = document.createElement('div');
                modal.className = 'kanban-log-modal';

                const heading = document.createElement('h3');
                heading.textContent = 'Action Log';
                modal.appendChild(heading);

                const entriesDiv = document.createElement('div');
                entriesDiv.className = 'kanban-log-entries';

                if (msg.entries && msg.entries.length) {
                    msg.entries.forEach(e => {
                        const entry = document.createElement('div');
                        entry.className = 'kanban-log-entry';
                        entry.innerHTML = `<span class="kanban-log-timestamp">${escapeHtml(e.timestamp)}</span> <span class="kanban-log-workflow">${escapeHtml(e.workflow)}</span><br/><span class="kanban-log-details">${escapeHtml(e.details)}</span>`;
                        entriesDiv.appendChild(entry);
                    });
                } else {
                    const empty = document.createElement('div');
                    empty.className = 'kanban-log-entry';
                    empty.textContent = 'No entries found.';
                    entriesDiv.appendChild(empty);
                }
                modal.appendChild(entriesDiv);

                const closeBtn = document.createElement('button');
                closeBtn.className = 'kanban-log-close';
                closeBtn.textContent = 'Close';
                closeBtn.addEventListener('click', () => overlay.remove());
                modal.appendChild(closeBtn);

                overlay.appendChild(modal);
                overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
                document.body.appendChild(overlay);
                break;
            }
            case 'kanbanPlanDeleted': {
                if (msg.success) {
                    _kanbanSelectedPlan = null;
                    const metaBar = document.getElementById('kanban-preview-meta-bar');
                    if (metaBar) metaBar.style.display = 'none';
                    if (kanbanPreviewContent) {
                        kanbanPreviewContent.innerHTML = '<div class="kanban-empty-state">Select a plan to preview</div>';
                    }
                    vscode.postMessage({ type: 'fetchKanbanPlans', requestId: Date.now() });
                } else {
                    console.error('[Kanban Sidebar] Failed to delete plan:', msg.error);
                }
                break;
            }
            case 'activateKanbanTabAndSelectPlan': {
                _pendingKanbanSelection = { planId: msg.planId || '', sessionId: msg.sessionId || '', planFile: msg.planFile || '', workspaceRoot: msg.workspaceRoot || '' };
                
                // Set workspace filter to target plan's workspace so the plan is visible
                if (kanbanWorkspaceFilter) {
                    kanbanFilters.workspaceRoot = msg.workspaceRoot || '';
                    kanbanWorkspaceFilter.value = msg.workspaceRoot || '';
                    persistTab('kanban.root', kanbanFilters.workspaceRoot);
                    // Reset project filter when workspace changes
                    kanbanFilters.project = '';
                    if (kanbanProjectFilter) kanbanProjectFilter.value = '';
                    updateKanbanProjectFilter();
                }

                // Clear column filter so the target plan is guaranteed to be in the DOM
                kanbanFilters.column = '';
                if (kanbanColumnFilter) kanbanColumnFilter.value = '';
                persistTab('kanban.column', '');

                switchToTab('kanban');
                // Check already-loaded cache for immediate selection
                const immediateMatch = findPendingKanbanMatch(_kanbanPlansCache);
                if (immediateMatch) {
                    const itemDiv = kanbanListPane && kanbanListPane.querySelector(`.kanban-plan-item[data-plan-id="${immediateMatch.planId}"]`);
                    if (itemDiv) {
                        itemDiv.scrollIntoView({ behavior: 'smooth', block: 'center' });
                        // Update selected class
                        document.querySelectorAll('.kanban-plan-item').forEach(el => el.classList.remove('selected'));
                        itemDiv.classList.add('selected');
                        // Load preview directly
                        loadKanbanPlanPreview(immediateMatch);
                        _pendingKanbanSelection = null;
                    }
                }
                // No redundant fetch — switchToTab('kanban') already fired fetchKanbanPlans.
                // Pending selection will be resolved in handleKanbanPlansReady if not matched immediately.
                break;
            }
            case 'epicDetails': {
                const epicId = msg.epic ? msg.epic.planId : '';
                const accordion = kanbanListPane && kanbanListPane.querySelector(`.epic-accordion[data-plan-id="${epicId}"]`);
                const container = accordion && accordion.querySelector('.epic-subtasks');
                const epicWorkspaceRoot = accordion ? (accordion.dataset.workspaceRoot || '') : '';
                if (container) {
                    if (!msg.epic) {
                        container.innerHTML = '<span style="color: var(--vscode-errorForeground, #ff6b6b);">Epic not found</span>';
                    } else if (!msg.subtasks || msg.subtasks.length === 0) {
                        container.innerHTML = '<span style="color: var(--text-secondary);">No subtasks</span>';
                    } else {
                        container.innerHTML = msg.subtasks.map(st => `
                            <div style="display: flex; justify-content: space-between; align-items: center; padding: 2px 0;">
                                <span>${escapeHtml(st.topic)}</span>
                                <button class="epic-remove-subtask-btn strip-btn" data-subtask-session="${escapeHtml(st.sessionId || st.planId)}" data-workspace-root="${escapeHtml(epicWorkspaceRoot)}" style="margin: 0; padding: 1px 4px; font-size: 10px;">Remove</button>
                            </div>
                        `).join('');
                    }
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
                        feedback.style.cssText = 'color: var(--accent-teal); font-size: 11px; margin-left: 8px;';
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
            case 'selectLocalDoc': {
                const { docId, docName } = msg;
                loadDocumentPreview('local-folder', docId, docName || docId);
                break;
            }

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
            case 'saveOnlineDocFileResult': {
                const { success, error } = msg;
                const textarea = document.getElementById('markdown-editor');
                if (success) {
                    state.activeDocContent = textarea ? textarea.value : '';
                    exitEditMode('docs', true);
                    if (markdownPreview) {
                        markdownPreview.innerHTML = renderMarkdown(state.activeDocContent);
                    }
                    const statusOnline = document.getElementById('status') || document.getElementById('status-online');
                    if (statusOnline) {
                        statusOnline.textContent = 'Saved successfully';
                        statusOnline.style.color = 'var(--accent-teal)';
                        setTimeout(() => { statusOnline.textContent = ''; statusOnline.style.color = ''; }, 2000);
                    }
                } else {
                    const statusOnline = document.getElementById('status') || document.getElementById('status-online');
                    if (statusOnline) {
                        statusOnline.textContent = `Save failed: ${error || 'Unknown error'}`;
                        statusOnline.style.color = 'var(--vscode-errorForeground, #ff6b6b)';
                    }
                }
                break;
            }
            case 'onlineDocCreated':
                if (msg.success && msg.docId) {
                    // Refresh and select the new doc
                    vscode.postMessage({ type: 'refreshSource', sourceId: msg.sourceId });
                    setTimeout(() => {
                        loadDocumentPreview(msg.sourceId, msg.docId, msg.docName || 'New Document');
                    }, 800);
                } else if (msg.error) {
                    if (statusEl) statusEl.textContent = `Create failed: ${msg.error}`;
                }
                break;
            case 'syncConfigReady':
                _syncModalState.uploadLocations = msg.uploadLocations || {};
                _syncModalState.enabledSources = state.enabledSources || {};
                // Fast path: check if current local doc has a mapping
                if (_syncModalState.localDocPath && msg.docMappings && msg.docMappings[_syncModalState.localDocPath]) {
                    _syncModalState.mapping = msg.docMappings[_syncModalState.localDocPath];
                    const map = _syncModalState.mapping;
                    const fastSourceName = _sourceDisplayNames[map.sourceId] || map.sourceId;
                    if (syncFastText) syncFastText.innerHTML = `This document is already synced to <strong>${escapeHtml(fastSourceName)}</strong>. Update the existing remote document?`;
                    if (syncStepFast) syncStepFast.style.display = '';
                    if (syncStepSource) syncStepSource.style.display = 'none';
                    if (syncStepLocation) syncStepLocation.style.display = 'none';
                    if (syncStepConfirm) syncStepConfirm.style.display = 'none';
                } else {
                    // No mapping — skip to source step (or confirm if exactly one upload location is saved)
                    const saved = _syncModalState.uploadLocations;
                    const sources = ['clickup', 'linear', 'notion'].filter(s => state.enabledSources[s] !== false);
                    const savedSources = sources.filter(s => saved[s]);
                    if (savedSources.length === 1) {
                        _syncModalState.sourceId = savedSources[0];
                        _syncModalState.parentId = saved[_syncModalState.sourceId];
                        _showSyncStep('confirm');
                    } else if (savedSources.length > 1) {
                        // Multiple saved locations — let user pick source first
                        _renderSyncSourceStep();
                        _showSyncStep('source');
                    } else {
                        _renderSyncSourceStep();
                        _showSyncStep('source');
                    }
                }
                break;
            case 'syncToOnlineResult':
                if (btnSyncConfirmSync) btnSyncConfirmSync.disabled = false;
                if (msg.success) {
                    if (syncProgress) syncProgress.textContent = 'Sync complete!';
                    if (syncResult && syncResultLink) {
                        syncResult.style.display = '';
                        if (msg.url) {
                            syncResultLink.href = msg.url;
                            syncResultLink.textContent = 'Open remote document';
                        } else {
                            syncResultLink.href = '#';
                            syncResultLink.textContent = 'Sync succeeded (no URL returned)';
                        }
                    }
                } else {
                    if (syncProgress) syncProgress.textContent = `Sync failed: ${msg.error || 'Unknown error'}`;
                }
                break;
            case 'uploadLocationSet':
                _syncModalState.uploadLocations[msg.sourceId] = msg.containerId;
                break;
            case 'containersReady': {
                const crSourceId = msg.sourceId;
                handleContainersReady(msg);
                // If the sync modal is open and waiting for containers for the selected source, populate location select
                if (syncOnlineModal && syncOnlineModal.style.display !== 'none' && _syncModalState.sourceId === crSourceId) {
                    _populateSyncLocationSelect(msg.containers || []);
                }
                break;
            }
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
                break;
            case 'importFullDocResult':
                if (msg.success) {
                    statusEl.textContent = msg.message || 'Full document imported';
                    statusElOnline.textContent = msg.message || 'Full document imported';

                    // Update the imported docs list
                    vscode.postMessage({ type: 'fetchImportedDocs' });

                    if (msg.savedPath && getActiveTabName() !== 'online') {
                        switchToTab('local');
                        let found = null;
                        const nodes = document.querySelectorAll('.tree-node');
                        for (let i = 0; i < nodes.length; i++) {
                            if (nodes[i].dataset.sourceId === 'local-folder' && nodes[i].dataset.absolutePath === msg.savedPath) {
                                found = nodes[i];
                                break;
                            }
                        }
                        if (found) {
                            loadDocumentPreview('local-folder', found.dataset.nodeId, found.dataset.name);
                        } else {
                            state._pendingImportDocName = msg.savedPath;
                        }
                    } else if (state.activeSource && state.activeDocId) {
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

                const flashImportBtn = (cls) => {
                    if (!btnResearchClipboard) return;
                    btnResearchClipboard.classList.remove('import-success', 'import-error');
                    void btnResearchClipboard.offsetWidth; // reflow → restart animation
                    btnResearchClipboard.classList.add(cls);
                    btnResearchClipboard.addEventListener('animationend',
                        () => btnResearchClipboard.classList.remove(cls), { once: true });
                };

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
                    flashImportBtn('import-success');
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
                    // Auto-clear success status after 4 seconds
                    if (researchStatusTimeout) clearTimeout(researchStatusTimeout);
                    researchStatusTimeout = setTimeout(() => {
                        if (researchStatusEl) researchStatusEl.textContent = '';
                        if (statusEl) statusEl.textContent = '';
                        researchStatusTimeout = null;
                    }, 4000);

                    if (msg.savedPath) {
                        let found = null;
                        const nodes = document.querySelectorAll('.tree-node');
                        for (let i = 0; i < nodes.length; i++) {
                            if (nodes[i].dataset.sourceId === 'local-folder' && nodes[i].dataset.absolutePath === msg.savedPath) {
                                found = nodes[i];
                                break;
                            }
                        }
                        if (found) {
                            loadDocumentPreview('local-folder', found.dataset.nodeId, found.dataset.name);
                        } else {
                            state._pendingImportDocName = msg.savedPath;
                        }
                    }
                } else {
                    flashImportBtn('import-error');
                    // Cancel any pending success auto-clear so it doesn't wipe this error
                    if (researchStatusTimeout) { clearTimeout(researchStatusTimeout); researchStatusTimeout = null; }
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
            case 'filteredDocsReady':
                handleFilteredDocsReady(msg);
                break;
            case 'docPagesReady':
                handleDocPagesReady(msg);
                break;
            case 'localFolderPathUpdated':
                handleLocalFolderPathUpdated(msg);
                break;
            case 'localFoldersListed': {
                const targetRoot = msg.workspaceRoot || '';
                state.localFolderPathsByRoot[targetRoot] = msg.paths || [];
                renderFolderList(msg.paths || []);
                renderFolderListModal();
                if (targetRoot === researchWorkspaceRoot) {
                    populateResearchFolderSelect(msg.paths || []);
                }
                break;
            }

            case 'ticketsFoldersListed':
                if (!state.ticketsFolderPathsByRoot) { state.ticketsFolderPathsByRoot = {}; }
                state.ticketsFolderPathsByRoot[msg.workspaceRoot || ''] = msg.paths || [];
                renderFolderListModal();
                break;
            case 'ticketSyncStatusesLoaded': {
                const provider = msg.provider;
                const statuses = msg.statuses || {};
                if (provider === 'clickup') {
                    clickUpProjectIssues = clickUpProjectIssues.map(t => ({
                        ...t, syncStatus: statuses[t.id] ?? t.syncStatus
                    }));
                } else {
                    linearProjectIssues = linearProjectIssues.map(t => ({
                        ...t, syncStatus: statuses[t.id] ?? t.syncStatus
                    }));
                }
                renderTicketsTab();
                break;
            }
            case 'importAllTicketsComplete':
                setTicketsLoadingState(false);
                isImportingAll = false;
                const importAllBtn = document.getElementById('btn-import-all-tickets');
                const importAllPlansBtn = document.getElementById('tickets-import-all-kanban');
                if (importAllBtn) importAllBtn.disabled = false;
                if (importAllPlansBtn) importAllPlansBtn.disabled = false;
                if (msg.success) {
                    let statusText = `Imported ${msg.successCount} tickets, ${msg.failCount} failed.`;
                    if (msg.errors && msg.errors.length > 0) {
                        statusText += ' Failed: ' + msg.errors.map(e => e.id).join(', ');
                    }
                    showTicketsStatus(statusText, msg.failCount > 0);
                }  else {
                    showTicketsStatus(msg.error || 'Bulk import failed', true);
                }
                _requestTicketSyncStatuses();
                break;
            case 'syncAllTicketsResult':
                setTicketsLoadingState(false);
                const syncAllBtn = document.getElementById('tickets-sync-all');
                if (syncAllBtn) syncAllBtn.disabled = false;
                if (msg.success) {
                    showTicketsStatus(`Synced ${msg.succeeded} tickets successfully.`, false);
                } else {
                    showTicketsStatus(`Synced ${msg.succeeded} succeeded, ${msg.failed} failed.`, true);
                }
                break;
            case 'ticketLinkCopied':
                showTicketsStatus(`Copied ${msg.count} ticket link${msg.count > 1 ? 's' : ''} ✓`, false);
                if (_lastLinkTicketBtn) {
                    flashCopyBtn(_lastLinkTicketBtn);
                    _lastLinkTicketBtn = null;
                }
                break;
            case 'ticketLinkFailed':
                showTicketsStatus(msg.error || 'Could not locate or create a local file for this ticket.', true);
                if (_lastLinkTicketBtn) {
                    _lastLinkTicketBtn.disabled = false;
                    _lastLinkTicketBtn = null;
                }
                break;
            case 'localTicketFilesListed': {
                const localProvider = msg.provider || lastIntegrationProvider;
                const tickets = msg.tickets || [];
                ticketsLoadedOnce = true;
                if (localProvider === 'clickup') {
                    clickUpProjectIssues = tickets.map(t => ({
                        id: t.id, title: t.title, identifier: t.id,
                        status: t.status || '', assignees: [], filePath: t.filePath,
                        syncStatus: t.syncStatus
                    }));
                    clickUpProjectStatus = 'loaded';
                    clickUpProjectMessage = '';
                    clickUpProjectLoading = false;
                } else {
                    linearProjectIssues = tickets.map(t => ({
                        id: t.id, title: t.title, identifier: t.id,
                        state: { name: t.status || '' }, assignee: null, description: '', filePath: t.filePath,
                        syncStatus: t.syncStatus
                    }));
                    linearProjectStatus = 'loaded';
                    linearProjectMessage = '';
                    linearProjectLoading = false;
                }
                renderTicketsTab();
                break;
            }
            case 'localTicketFileRead': {
                if (!msg.success) {
                    // No local file — fall back to live API fetch
                    if (msg.provider === 'clickup') loadClickUpTaskDetails(msg.id);
                    else loadLinearTaskDetails(msg.id);
                    break;
                }
                // Strip leading H1 — the render function always prepends <h1>title</h1> itself
                const localBodyMarkdown = (msg.content || '').replace(/^#[^\n]*\n?/, '').trim();
                const rendered = renderMarkdown(localBodyMarkdown);
                // Local file is the source of truth for description. localDescription: true
                // prevents the API response from overwriting it when it arrives.
                if (msg.provider === 'clickup') {
                    const existing = clickUpTaskDetailCache.get(msg.id);
                    selectedClickUpIssue = {
                        task: existing?.task || { id: msg.id, title: msg.title, name: msg.title, status: '', assignees: [] },
                        subtasks: existing?.subtasks || [],
                        comments: existing?.comments || [],
                        attachments: existing?.attachments || [],
                        renderedDescriptionHtml: rendered,
                        descriptionMarkdown: localBodyMarkdown,
                        localDescription: true,
                        detailsFetched: existing?.detailsFetched || false
                    };
                    clickUpTaskDetailCache.set(msg.id, selectedClickUpIssue);
                } else {
                    const existing = linearIssueDetailCache.get(msg.id);
                    selectedLinearIssue = {
                        issue: existing?.issue || { id: msg.id, title: msg.title, state: { name: '' }, assignee: null },
                        subtasks: existing?.subtasks || [],
                        comments: existing?.comments || [],
                        attachments: existing?.attachments || [],
                        renderedDescriptionHtml: rendered,
                        descriptionMarkdown: localBodyMarkdown,
                        localDescription: true,
                        detailsFetched: existing?.detailsFetched || false
                    };
                    linearIssueDetailCache.set(msg.id, selectedLinearIssue);
                }
                renderTicketsTab();
                break;
            }
            case 'ticketFileChanged': {
                const changedId = msg.id;
                const changedProvider = msg.provider;
                const isCurrentClickUp = changedProvider === 'clickup' && selectedClickUpIssue?.task?.id === changedId;
                const isCurrentLinear = changedProvider === 'linear' && selectedLinearIssue?.issue?.id === changedId;
                const changedBodyMarkdown = (msg.content || '').replace(/^#[^\n]*\n?/, '').trim();
                if (isCurrentClickUp || isCurrentLinear) {
                    const rendered = renderMarkdown(changedBodyMarkdown);
                    let hasChanged = false;
                    if (isCurrentClickUp) {
                        if (selectedClickUpIssue?.renderedDescriptionHtml !== rendered) {
                            selectedClickUpIssue = { ...selectedClickUpIssue, renderedDescriptionHtml: rendered, descriptionMarkdown: changedBodyMarkdown };
                            clickUpTaskDetailCache.set(changedId, selectedClickUpIssue);
                            hasChanged = true;
                        }
                    } else {
                        if (selectedLinearIssue?.renderedDescriptionHtml !== rendered) {
                            selectedLinearIssue = { ...selectedLinearIssue, renderedDescriptionHtml: rendered, descriptionMarkdown: changedBodyMarkdown };
                            linearIssueDetailCache.set(changedId, selectedLinearIssue);
                            hasChanged = true;
                        }
                    }
                    if (hasChanged) {
                        renderTicketsTab();
                    }
                }
                // Always update cache so next click shows fresh content.
                // Skip when the changed ticket is the current selected one — the cache
                // was already updated above (if hasChanged) or doesn't need updating
                // (content identical), and re-setting breaks object identity with
                // selectedClickUpIssue / selectedLinearIssue.
                if (!isCurrentClickUp && !isCurrentLinear) {
                    const changedRendered = renderMarkdown(changedBodyMarkdown);
                    if (changedProvider === 'clickup') {
                        const existing = clickUpTaskDetailCache.get(changedId);
                        clickUpTaskDetailCache.set(changedId, {
                            ...(existing || { task: { id: changedId, title: msg.title, name: msg.title, status: '', assignees: [] }, subtasks: [], comments: [], attachments: [] }),
                            renderedDescriptionHtml: changedRendered,
                            descriptionMarkdown: changedBodyMarkdown
                        });
                    } else {
                        const existing = linearIssueDetailCache.get(changedId);
                        linearIssueDetailCache.set(changedId, {
                            ...(existing || { issue: { id: changedId, title: msg.title, state: { name: '' }, assignee: null }, subtasks: [], comments: [], attachments: [] }),
                            renderedDescriptionHtml: changedRendered,
                            descriptionMarkdown: changedBodyMarkdown
                        });
                    }
                }
                break;
            }
            case 'editTicketResult':
                setTicketsLoadingState(false);
                if (!msg.success) {
                    showTicketsStatus(msg.error || 'Failed to import ticket', true);
                } else {
                    showTicketsStatus('Imported ✓', false);
                }
                break;
            case 'pushTicketResult':
                setTicketsLoadingState(false);
                if (!msg.success) {
                    showTicketsStatus(msg.error || 'Failed to push edits', true);
                } else {
                    showTicketsStatus('Pushed to source ✓', false);
                    // Local now matches remote — refresh badges so it flips to synced.
                    _requestTicketSyncStatuses();
                }
                break;
            case 'ticketDeleted':
                setTicketsLoadingState(false);
                if (msg.success) {
                    showTicketsStatus('Archived/Deleted ✓', false);
                    const modal = document.getElementById('tickets-delete-modal');
                    if (modal) modal.style.display = 'none';
                    _pendingDeleteTicket = null;
                    selectedLinearIssue = null;
                    selectedClickUpIssue = null;
                    if (lastIntegrationProvider === 'linear') {
                        linearProjectIssues = linearProjectIssues.filter(i => i.id !== msg.id);
                        renderTicketsLinearList();
                        renderTicketsLinearTaskDetail();
                    } else {
                        clickUpProjectIssues = clickUpProjectIssues.filter(t => t.id !== msg.id);
                        renderTicketsClickUpList();
                        renderTicketsClickUpTaskDetail();
                    }
                } else {
                    showTicketsStatus(msg.error || 'Failed to delete ticket', true);
                    const confirmBtn = document.getElementById('btn-confirm-tickets-delete');
                    if (confirmBtn) confirmBtn.disabled = false;
                }
                break;
            case 'changeTicketStatusResult':
                setTicketsLoadingState(false);
                if (msg.success) {
                    showTicketsStatus('Status updated ✓', false);
                    if (lastIntegrationProvider === 'linear') {
                        const issue = linearProjectIssues.find(i => i.id === msg.id);
                        if (issue) {
                            const stateSelect = document.getElementById('select-status-ticket');
                            const selectedOption = stateSelect?.querySelector(`option[value="${msg.statusId}"]`);
                            if (selectedOption && issue.state) {
                                issue.state.name = selectedOption.textContent;
                            }
                        }
                        loadLinearTaskDetails(msg.id);
                        renderTicketsLinearList();
                    } else {
                        const task = clickUpProjectIssues.find(t => t.id === msg.id);
                        if (task) {
                            const stateSelect = document.getElementById('select-status-ticket');
                            const selectedOption = stateSelect?.querySelector(`option[value="${msg.statusId}"]`);
                            if (selectedOption) {
                                task.status = selectedOption.textContent;
                            }
                        }
                        loadClickUpTaskDetails(msg.id);
                        renderTicketsClickUpList();
                    }
                } else {
                    showTicketsStatus(msg.error || 'Failed to update status', true);
                }
                break;
            case 'postTicketCommentResult':
                setTicketsLoadingState(false);
                if (msg.success) {
                    showTicketsStatus('Comment posted ✓', false);
                    // Refetch threads to reconcile optimistic insert.
                    // loadCommentThreads sets the in-flight marker itself.
                    if (_cmActiveTicketId === msg.id) {
                        loadCommentThreads(lastIntegrationProvider, msg.id);
                    }
                } else {
                    // Rollback optimistic insert, restore draft
                    rollbackOptimisticComment(null);
                    showTicketsStatus(msg.error || 'Failed to post comment', true);
                    showCommentManagerError(msg.error || 'Failed to post comment');
                }
                break;
            case 'postTicketReplyResult':
                setTicketsLoadingState(false);
                if (msg.success) {
                    showTicketsStatus('Reply posted ✓', false);
                    if (_cmActiveTicketId === msg.id) {
                        loadCommentThreads(lastIntegrationProvider, msg.id);
                    }
                } else {
                    // Rollback optimistic reply, restore draft
                    rollbackOptimisticComment(msg.commentId);
                    showTicketsStatus(msg.error || 'Failed to post reply', true);
                    showCommentManagerError(msg.error || 'Failed to post reply');
                }
                break;
            case 'ticketCommentsLoaded':
                setTicketsLoadingState(false);
                if (msg.success) {
                    _cmThreads = msg.threads || [];
                    _cmMembers = msg.members || [];
                    _cmThreadingSupported = msg.threadingSupported !== false;
                    // Refetch stale guard: if a new optimistic insert arrived
                    // while this refetch was pending, discard and re-fetch.
                    if (_pendingRefetchTicketId === msg.id) {
                        _pendingRefetchTicketId = null;
                        if (_refetchStale) {
                            _refetchStale = false;
                            loadCommentThreads(msg.provider, msg.id);
                            break;
                        }
                    }
                    renderCommentManager(_cmThreads, _cmMembers);
                } else {
                    showTicketsStatus(msg.error || 'Failed to load comments', true);
                    const threadsDiv = document.getElementById('tickets-comment-threads');
                    if (threadsDiv) {
                        threadsDiv.innerHTML = '<div class="cm-error">' + escapeHtml(msg.error || 'Failed to load comments') + '</div>';
                    }
                }
                break;
            case 'attachmentDownloaded':
                if (msg.success) {
                    showTicketsStatus('Attachment downloaded ✓', false);
                    if (msg.filePath) {
                        const { ticketsStatusFooter } = getTicketsTabElements();
                        if (ticketsStatusFooter) {
                            ticketsStatusFooter.textContent = `Downloaded to: ${msg.filePath}`;
                            ticketsStatusFooter.style.display = '';
                            if (window._ticketsFooterTimeout) {
                                clearTimeout(window._ticketsFooterTimeout);
                            }
                            window._ticketsFooterTimeout = setTimeout(() => {
                                ticketsStatusFooter.style.display = 'none';
                            }, 5000);
                        }
                    }
                    const provider = lastIntegrationProvider;
                    const ticketId = provider === 'linear' ? selectedLinearIssue?.issue?.id : selectedClickUpIssue?.task?.id;
                    const attachments = provider === 'linear' ? selectedLinearIssue?.attachments : selectedClickUpIssue?.attachments;
                    if (ticketId && attachments) {
                        vscode.postMessage({
                            type: 'viewAttachments',
                            workspaceRoot: ticketsWorkspaceRoot,
                            provider,
                            ticketId,
                            attachments
                        });
                    }
                } else {
                    showTicketsStatus(msg.error || 'Failed to download attachment', true);
                }
                break;

            case 'attachmentsListResult':
                if (msg.success) {
                    renderAttachmentsList(msg.attachments);
                } else {
                    showTicketsStatus(msg.error || 'Failed to load attachments list', true);
                }
                break;

            case 'attachmentOpened':
                if (msg.success) {
                    showTicketsStatus('Attachment opened ✓', false);
                } else {
                    showTicketsStatus(msg.error || 'Failed to open attachment', true);
                }
                break;

            case 'attachmentRevealed':
                if (msg.success) {
                    showTicketsStatus('Attachment revealed ✓', false);
                } else {
                    showTicketsStatus(msg.error || 'Failed to reveal attachment', true);
                }
                break;

            case 'airlock_exportComplete':
                handleAirlockExportComplete(msg);
                break;
            case 'importNotebookLMPlansResult':
                handleImportNotebookLMPlansResult(msg);
                break;
            case 'importedDocsReady':
                handleImportedDocsReady(msg);
                break;
            case 'syncResult':
                handleSyncResult(msg);
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
                // Strip button state is updated via activeDesignDocUpdated message path
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
            case 'saveFileContentResult': {
                const { success, conflict, diskContent, error, tab } = msg;
                const textarea = document.getElementById(tab === 'docs' ? 'markdown-editor' : (tab === 'design' ? 'markdown-editor-design' : 'kanban-editor'));
                
                if (success) {
                    if (tab === 'docs') {
                        state.activeDocContent = textarea.value;
                        exitEditMode(tab, true);
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
                    const filePath = (tab === 'local' || tab === 'design') ? state.activeDocFilePath : (_kanbanSelectedPlan ? _kanbanSelectedPlan.planFile : null);
                    vscode.postMessage({
                        type: 'saveFileContent',
                        filePath,
                        content: textarea.value,
                        originalContent: diskContent,
                        tab
                    });
                    if (tab === 'kanban') {
                        const kanbanStrip = document.querySelector('.kanban-controls-strip');
                        if (kanbanStrip) {
                            let statusKanban = kanbanStrip.querySelector('.kanban-save-status');
                            if (!statusKanban) {
                                statusKanban = document.createElement('span');
                                statusKanban.className = 'kanban-save-status';
                                statusKanban.style.cssText = 'font-size:11px; margin-left:8px;';
                                kanbanStrip.appendChild(statusKanban);
                            }
                            statusKanban.textContent = 'Conflict detected, overwriting...';
                            statusKanban.style.color = 'var(--vscode-editorWarning-foreground, #cca700)';
                        }
                    } else {
                        const statusEl = document.getElementById(tab === 'local' ? 'status' : 'status-design');
                        if (statusEl) {
                            statusEl.textContent = 'Conflict detected, overwriting...';
                            statusEl.style.color = 'var(--vscode-editorWarning-foreground, #cca700)';
                        }
                    }
                } else {
                    console.error('Error saving file:', error || 'Unknown error');
                    if (tab === 'kanban') {
                        const kanbanStrip = document.querySelector('.kanban-controls-strip');
                        if (kanbanStrip) {
                            let statusKanban = kanbanStrip.querySelector('.kanban-save-status');
                            if (!statusKanban) {
                                statusKanban = document.createElement('span');
                                statusKanban.className = 'kanban-save-status';
                                statusKanban.style.cssText = 'font-size:11px; margin-left:8px;';
                                kanbanStrip.appendChild(statusKanban);
                            }
                            statusKanban.textContent = 'Error saving: ' + (error || 'Unknown');
                            statusKanban.style.color = 'var(--vscode-errorForeground, #ff6b6b)';
                        }
                    } else {
                        const statusEl = document.getElementById(tab === 'local' ? 'status' : 'status-design');
                        if (statusEl) {
                            statusEl.textContent = 'Error saving: ' + (error || 'Unknown');
                            statusEl.style.color = 'var(--vscode-errorForeground, #ff6b6b)';
                        }
                    }
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
                if (_restoredLinearProjectPickerValue) {
                    const projects = Array.from(new Set(
                        linearProjectIssues
                            .map((issue) => String(issue?.project?.name || '').trim())
                            .filter(Boolean)
                    ));
                    if (projects.includes(_restoredLinearProjectPickerValue)) {
                        linearProjectPickerValue = _restoredLinearProjectPickerValue;
                    }
                    _restoredLinearProjectPickerValue = '';
                }
                renderTicketsTab();
                if (ticketsAutoSync && linearProjectPickerValue) {
                    _pendingRefreshImport = false;
                    vscode.postMessage({
                        type: 'importAllTickets',
                        workspaceRoot: ticketsWorkspaceRoot,
                        provider: 'linear',
                        importMode: 'document',
                        projectId: linearProjectPickerValue
                    });
                } else {
                    _pendingRefreshImport = false;
                    _requestTicketSyncStatuses();
                }
                vscode.postMessage({
                    type: 'linearLoadAutomationCatalog',
                    workspaceRoot: ticketsWorkspaceRoot
                });
                break;
            case 'linearLabelsUpdated':
                if (selectedLinearIssue && selectedLinearIssue.issue?.id === msg.issueId) {
                    loadLinearTaskDetails(msg.issueId);
                }
                showTicketsStatus('Labels updated successfully');
                break;
            case 'clickupTagsUpdated':
                if (selectedClickUpIssue && selectedClickUpIssue.task?.id === msg.taskId) {
                    selectedClickUpIssue.task.tags = msg.tags || [];
                    renderTicketTags(selectedClickUpIssue.task.tags, 'clickup');
                }
                showTicketsStatus('Tags updated successfully');
                break;
            case 'linearAutomationCatalogLoaded':
                availableLinearLabels = msg.labels || [];
                availableLinearStates = msg.states || [];
                if (_tagsModalOpen && lastIntegrationProvider === 'linear') {
                    _tagsCatalogLoading = false;
                    renderTagsModalList();
                }
                if (lastIntegrationProvider === 'linear') renderTicketsTab();
                break;
            case 'clickupSpaceTagsLoaded':
                availableClickUpTags = msg.tags || [];
                if (_tagsModalOpen && lastIntegrationProvider !== 'linear') {
                    _tagsCatalogLoading = false;
                    renderTagsModalList();
                }
                break;
            case 'clickupListStatusesLoaded':
                availableClickUpStatuses = msg.statuses || [];
                if (lastIntegrationProvider === 'clickup') renderTicketsTab();
                break;
            case 'linearProjectsLoaded':
                linearAvailableProjects = msg.projects || [];
                break;
            case 'linearTaskDetailsLoaded': {
                const _prevLinear = linearIssueDetailCache.get(msg.issue.id);
                const _keepLinearDesc = _prevLinear?.localDescription;
                selectedLinearIssue = {
                    issue: msg.issue,
                    subtasks: msg.subtasks || [],
                    comments: msg.comments || [],
                    attachments: msg.attachments || [],
                    renderedDescriptionHtml: _keepLinearDesc ? _prevLinear.renderedDescriptionHtml : msg.renderedDescriptionHtml,
                    descriptionMarkdown: _keepLinearDesc ? _prevLinear.descriptionMarkdown : (msg.issue.description || ''),
                    localDescription: _keepLinearDesc || false,
                    // Marks that comments/attachments came from the API. The cache-hit
                    // shortcut on card click only skips the API fetch when this is true,
                    // so file-change stubs (comments: []) never suppress real comments.
                    detailsFetched: true
                };
                linearIssueDetailCache.set(msg.issue.id, selectedLinearIssue);
                if (!ticketsEditMode) renderTicketsTab();
                break;
            }
            case 'clickupSpacesLoaded':
                clickUpAvailableSpaces = msg.spaces || [];
                clickUpAvailableFolders = [];
                clickUpAvailableListsInFolder = [];
                clickUpAvailableDirectLists = [];
                clickUpHierarchyLoading = false;
                if (_restoringClickUpHierarchy && clickUpSelectedSpaceId) {
                    const spaceExists = clickUpAvailableSpaces.some(s => s.id === clickUpSelectedSpaceId);
                    if (spaceExists) {
                        clickUpHierarchyLoading = true;
                        vscode.postMessage({
                            type: 'clickupLoadFolders',
                            spaceId: clickUpSelectedSpaceId,
                            workspaceRoot: ticketsWorkspaceRoot || undefined
                        });
                    } else {
                        clickUpSelectedSpaceId = '';
                        clickUpSelectedFolderId = '';
                        clickUpSelectedListId = '';
                        _restoringClickUpHierarchy = false;
                    }
                }
                renderTicketsTab();
                const targetSpaceId = clickUpSelectedSpaceId || (clickUpAvailableSpaces[0]?.id);
                if (targetSpaceId) {
                    vscode.postMessage({
                        type: 'clickupLoadSpaceTags',
                        spaceId: targetSpaceId,
                        workspaceRoot: ticketsWorkspaceRoot
                    });
                }
                break;
            case 'clickupFoldersLoaded':
                clickUpAvailableFolders = msg.folders || [];
                clickUpAvailableListsInFolder = [];
                clickUpAvailableDirectLists = msg.directLists || [];
                clickUpHierarchyLoading = false;
                if (_restoringClickUpHierarchy && clickUpSelectedSpaceId) {
                    if (clickUpSelectedFolderId) {
                        const folderExists = clickUpAvailableFolders.some(f => f.id === clickUpSelectedFolderId);
                        if (folderExists) {
                            clickUpHierarchyLoading = true;
                            vscode.postMessage({
                                type: 'clickupLoadLists',
                                spaceId: clickUpSelectedSpaceId,
                                folderId: clickUpSelectedFolderId,
                                workspaceRoot: ticketsWorkspaceRoot || undefined
                            });
                        } else {
                            clickUpSelectedFolderId = '';
                            clickUpSelectedListId = '';
                            _restoringClickUpHierarchy = false;
                        }
                    } else {
                        if (clickUpSelectedListId && clickUpAvailableDirectLists.some(l => l.id === clickUpSelectedListId)) {
                            _restoringClickUpHierarchy = false;
                            loadClickUpProject(false, clickUpSelectedListId);
                        } else if (clickUpSelectedListId) {
                            clickUpSelectedListId = '';
                            _restoringClickUpHierarchy = false;
                        } else {
                            _restoringClickUpHierarchy = false;
                        }
                    }
                }
                renderTicketsTab();
                break;
            case 'clickupListsLoaded':
                if (clickUpSelectedFolderId) {
                    clickUpAvailableListsInFolder = msg.lists || [];
                } else {
                    clickUpAvailableDirectLists = msg.lists || [];
                }
                clickUpHierarchyLoading = false;
                if (_restoringClickUpHierarchy && clickUpSelectedListId) {
                    const availableLists = clickUpSelectedFolderId
                        ? clickUpAvailableListsInFolder
                        : clickUpAvailableDirectLists;
                    const listExists = availableLists.some(l => l.id === clickUpSelectedListId);
                    if (listExists) {
                        _restoringClickUpHierarchy = false;
                        loadClickUpProject(false, clickUpSelectedListId);
                    } else {
                        clickUpSelectedListId = '';
                        _restoringClickUpHierarchy = false;
                    }
                }
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
                if (clickUpSelectedListId) {
                    availableClickUpStatuses = [];
                    vscode.postMessage({ type: 'clickupLoadListStatuses', listId: clickUpSelectedListId, workspaceRoot: ticketsWorkspaceRoot });
                }
                renderTicketsTab();
                if ((ticketsAutoSync || _pendingRefreshImport) && clickUpSelectedListId) {
                    _pendingRefreshImport = false;
                    vscode.postMessage({
                        type: 'importAllTickets',
                        workspaceRoot: ticketsWorkspaceRoot,
                        provider: 'clickup',
                        importMode: 'document',
                        listId: clickUpSelectedListId,
                        workspaceId: clickUpSelectedSpaceId
                    });
                } else {
                    _pendingRefreshImport = false;
                    _requestTicketSyncStatuses();
                }
                break;
            case 'clickupTaskDetailsLoaded': {
                const _prevClickUp = clickUpTaskDetailCache.get(msg.task.id);
                const _keepClickUpDesc = _prevClickUp?.localDescription;
                selectedClickUpIssue = {
                    task: msg.task,
                    subtasks: msg.subtasks || [],
                    comments: msg.comments || [],
                    attachments: msg.attachments || [],
                    renderedDescriptionHtml: _keepClickUpDesc ? _prevClickUp.renderedDescriptionHtml : msg.renderedDescriptionHtml,
                    descriptionMarkdown: _keepClickUpDesc ? _prevClickUp.descriptionMarkdown : (msg.task.markdownDescription || msg.task.description || ''),
                    localDescription: _keepClickUpDesc || false,
                    // Marks that comments/attachments came from the API. The cache-hit
                    // shortcut on card click only skips the API fetch when this is true,
                    // so file-change stubs (comments: []) never suppress real comments.
                    detailsFetched: true
                };
                clickUpTaskDetailCache.set(msg.task.id, selectedClickUpIssue);
                if (!ticketsEditMode) renderTicketsTab();
                break;
            }
            case 'clickupError': {
                // Clear the loading flag for whichever operation failed, otherwise
                // the affected control stays stuck/disabled. The hierarchy
                // dropdowns disable themselves while clickUpHierarchyLoading is
                // true, so a swallowed error here is exactly what makes the
                // Space/Folder/List selects un-selectable.
                switch (msg.scope) {
                    case 'hierarchy':
                        clickUpHierarchyLoading = false;
                        break;
                    case 'project':
                        clickUpProjectLoading = false;
                        clickUpProjectStatus = 'error';
                        clickUpProjectMessage = msg.error || 'Failed to load tasks';
                        break;
                    case 'task':
                        pendingClickUpDetailIssueId = '';
                        break;
                }
                setTicketsLoadingState(false);
                showTicketsError(msg.error || 'ClickUp request failed');
                renderTicketsTab();
                break;
            }
            case 'linearError': {
                switch (msg.scope) {
                    case 'project':
                        linearProjectLoading = false;
                        linearProjectStatus = 'error';
                        linearProjectMessage = msg.error || 'Failed to load issues';
                        break;
                }
                setTicketsLoadingState(false);
                showTicketsError(msg.error || 'Linear request failed');
                renderTicketsTab();
                break;
            }
            case 'ticketsDefaultRoot': {
                // Don't overwrite a value already restored from persisted state
                if (ticketsWorkspaceRoot && _workspaceItems.some(item => item.workspaceRoot === ticketsWorkspaceRoot)) {
                    break;
                }
                ticketsWorkspaceRoot = msg.workspaceRoot || '';
                // Don't overwrite a provider preference already restored from saved state
                if (!lastIntegrationProvider) {
                    lastIntegrationProvider = msg.provider || null;
                }
                const select = document.getElementById('tickets-workspace-filter');
                if (select) {
                    select.value = ticketsWorkspaceRoot;
                }
                if (ticketsWorkspaceRoot) {
                    const restoredState = getRestoredState('tickets', ticketsWorkspaceRoot);
                    if (restoredState) {
                        restoreTicketsStateForRoot(restoredState);
                        // Always load hierarchy for navigation; ticketsAutoSync only
                        // controls task content source (API vs local files).
                        if (isTicketsTabActive() && lastIntegrationProvider && !ticketsLoadedOnce) {
                            if (lastIntegrationProvider === 'clickup') loadClickUpSpaces();
                            else if (lastIntegrationProvider === 'linear') loadLinearProject();
                            if (!ticketsAutoSync) loadLocalTicketFiles();
                        }
                    } else if (Object.keys(_restoredPanelState.byRoot).length > 0) {
                        // restoredTabState already arrived but no persisted state for this
                        // root — load directly (first-time user / no saved hierarchy).
                        ticketsLoadedOnce = false;
                        if (isTicketsTabActive() && lastIntegrationProvider) {
                            if (lastIntegrationProvider === 'clickup') loadClickUpSpaces();
                            else if (lastIntegrationProvider === 'linear') loadLinearProject();
                            if (!ticketsAutoSync) loadLocalTicketFiles();
                        }
                    } else {
                        // restoredTabState hasn't arrived yet — defer until it does
                        _pendingTicketsRestore = true;
                    }
                }
                break;
            }
            case 'integrationProviderStates':
                {
                    const clickupSetup = msg.clickupSetupComplete === true;
                    const linearSetup = msg.linearSetupComplete === true;
                    const tabBtn = document.getElementById('tickets-tab-btn');
                    const providerSelector = document.getElementById('tickets-provider-selector');
                    
                    if (clickupSetup && linearSetup) {
                        if (providerSelector) providerSelector.style.display = '';
                        if (tabBtn) tabBtn.textContent = 'TICKETS';
                    } else if (clickupSetup) {
                        if (providerSelector) providerSelector.style.display = 'none';
                        if (tabBtn) tabBtn.textContent = 'CLICKUP';
                    } else if (linearSetup) {
                        if (providerSelector) providerSelector.style.display = 'none';
                        if (tabBtn) tabBtn.textContent = 'LINEAR';
                    } else {
                        if (providerSelector) providerSelector.style.display = 'none';
                        if (tabBtn) tabBtn.textContent = 'TICKETS';
                    }

                    // Only set lastIntegrationProvider if not already restored from
                    // saved state — the backend's default ('clickup' when both are
                    // configured) should not overwrite the user's persisted preference.
                    if (!lastIntegrationProvider) {
                        lastIntegrationProvider = msg.provider || null;
                    }
                    if (providerSelector && lastIntegrationProvider) {
                        providerSelector.value = lastIntegrationProvider;
                    }
                    ticketsAutoSync = msg.ticketsAutoSync === true;
                    if (isTicketsTabActive() && lastIntegrationProvider && !ticketsLoadedOnce) {
                        // Always load the hierarchy (spaces/folders/lists for ClickUp,
                        // projects for Linear) — these are navigation, not task content.
                        // ticketsAutoSync only controls whether task content comes from
                        // the API (true) or local files (false).
                        if (lastIntegrationProvider === 'clickup') {
                            loadClickUpSpaces();
                        } else if (lastIntegrationProvider === 'linear') {
                            loadLinearProject();
                        }
                        // If not auto-syncing, also load local ticket files
                        if (!ticketsAutoSync) {
                            loadLocalTicketFiles();
                        }
                    }
                }
                break;
            case 'clickupTaskCreated': {
                const submitBtn = document.getElementById('btn-submit-create-ticket');
                if (submitBtn) {
                    submitBtn.disabled = false;
                    submitBtn.textContent = 'Create';
                }
                if (msg.success) {
                    const modal = document.getElementById('create-ticket-modal');
                    if (modal) modal.style.display = 'none';
                    const titleInput = document.getElementById('create-ticket-title');
                    const descInput = document.getElementById('create-ticket-description');
                    if (titleInput) titleInput.value = '';
                    if (descInput) descInput.value = '';
                    if (_subtaskParent) {
                        const parentId = _subtaskParent.id;
                        _subtaskParent = null;
                        const modalTitle = document.getElementById('create-ticket-modal-title');
                        if (modalTitle) modalTitle.textContent = 'Create New Ticket';
                        loadClickUpTaskDetails(parentId);
                    } else {
                        loadClickUpProject(true);
                    }
                } else {
                    console.error('Failed to create ClickUp ticket:', msg.error);
                    showTicketsStatus('Failed to create ticket', true);
                }
                break;
            }
            case 'linearIssueCreated': {
                const submitBtn = document.getElementById('btn-submit-create-ticket');
                if (submitBtn) {
                    submitBtn.disabled = false;
                    submitBtn.textContent = 'Create';
                }
                if (msg.success) {
                    const modal = document.getElementById('create-ticket-modal');
                    if (modal) modal.style.display = 'none';
                    const titleInput = document.getElementById('create-ticket-title');
                    const descInput = document.getElementById('create-ticket-description');
                    if (titleInput) titleInput.value = '';
                    if (descInput) descInput.value = '';
                    if (_subtaskParent) {
                        const parentId = _subtaskParent.id;
                        _subtaskParent = null;
                        const modalTitle = document.getElementById('create-ticket-modal-title');
                        if (modalTitle) modalTitle.textContent = 'Create New Ticket';
                        loadLinearTaskDetails(parentId);
                    } else {
                        loadLinearProject(true);
                    }
                } else {
                    console.error('Failed to create Linear ticket:', msg.error);
                    showTicketsStatus('Failed to create ticket', true);
                }
                break;
            }
            case 'subtaskConverted': {
                const modal = document.getElementById('convert-subtask-modal');
                if (modal) modal.style.display = 'none';
                if (msg.success) {
                    showTicketsStatus('Converted to subtask ✓', false);
                    if (msg.provider === 'clickup') {
                        loadClickUpProject(true);
                    } else {
                        loadLinearProject(true);
                    }
                } else {
                    console.error('Failed to convert to subtask:', msg.error);
                    showTicketsStatus(msg.error || 'Failed to convert ticket', true);
                }
                break;
            }
            case 'linearTaskImported':
            case 'clickupTaskImported':
                if (msg.success) {
                    showTicketsStatus('Imported ✓', false);
                } else {
                    console.error('Import failed:', msg.error);
                    showTicketsStatus('Import failed', true);
                }
                break;
            case 'linearTaskRefined':
            case 'clickupTaskRefined':
                if (msg.success) {
                    showTicketsStatus('Refined ✓', false);
                } else {
                    console.error('Refine failed:', msg.error);
                    showTicketsStatus('Refine failed', true);
                }
                break;
            case 'ticketsAskAgentResult':
                if (msg.success) {
                    showTicketsStatus('Sent to agent ✓', false);
                } else {
                    console.error('Ask Agent failed:', msg.error);
                    showTicketsStatus(msg.error || 'Ask Agent failed', true);
                }
                break;
        }
    });

    // Active Design Doc Banner handlers
    const btnDisableDocLocal = document.getElementById('btn-disable-doc-local');
    const btnDisableDocOnline = document.getElementById('btn-disable-doc-online');

    function updateLocalActiveContextButtonState() {
        // Planning-context setting moved to the Project panel's Epics tab; the
        // set-context button no longer exists here. Keep the Sync-to-Online button
        // state in sync, which this function is still relied upon to refresh.
        updateSyncToOnlineButtonState();
    }

    function updateActiveDocBanner(msg) {
        // Support both old flat format and new nested format
        const planningEpic = msg.planningEpic || { enabled: msg.enabled, docName: msg.docName, sourceId: msg.sourceId, docId: msg.docId };

        const bannerLocal = document.getElementById('active-doc-banner-local');
        const bannerOnline = document.getElementById('active-doc-banner-online');
        const nameLocal = document.getElementById('active-doc-name-local');
        const nameOnline = document.getElementById('active-doc-name-online');

        const isEpicActive = planningEpic.enabled && planningEpic.docName;
        const epicName = planningEpic.docName || 'None';

        if (bannerLocal) {
            bannerLocal.classList.toggle('inactive', !isEpicActive);
            if (nameLocal) nameLocal.textContent = epicName;
        }
        if (bannerOnline) {
            bannerOnline.classList.toggle('inactive', !isEpicActive);
            if (nameOnline) nameOnline.textContent = epicName;
        }

        state.activeDesignDocEnabled = planningEpic.enabled || false;
        state.activeDesignDocSourceId = planningEpic.sourceId || null;
        state.activeDesignDocId = planningEpic.docId || null;
        updateLocalActiveContextButtonState();
    }

    function handleDisablePlanningEpic() {
        vscode.postMessage({ type: 'disableDesignDoc', docType: 'planning-epic' });
    }

    if (btnDisableDocLocal) {
        btnDisableDocLocal.addEventListener('click', handleDisablePlanningEpic);
    }
    if (btnDisableDocOnline) {
        btnDisableDocOnline.addEventListener('click', handleDisablePlanningEpic);
    }

    // Button handlers
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

        let prompt = `You are helping me draft a research prompt for Google AI Studio with search grounding enabled.

TOPIC: ${customPrompt}

Please draft a comprehensive research prompt optimized for Google AI Studio. The drafted prompt should include:
- ROLE definition for the research analyst
- CONTEXT describing the domain and audience
- CENTRAL QUESTION
- 4-6 targeted SUB-QUESTIONS
- SOURCE GUIDANCE (authoritative sources, date-checking, separate required/recommended/opinion)
- SCOPE boundaries
- OUTPUT format:
  - A short H1 document title (fewer than 10 words, no colons or extra statements) — this is the title of the research document, not "Executive Summary"
  - "Executive Summary" as an H2 section heading beneath the title
  - Tiered findings, trade-off evaluation, glossary, and source list as subsequent sections
- DEPTH level with a source count target of at least 50 authoritative sources

Do NOT perform the research yourself. Only draft the prompt text that I will paste into Google AI Studio.

Return ONLY the drafted prompt with no additional commentary.`;

        return prompt;
    }

    // =========================================================================
    // KANBAN PLANS UI LOGIC
    // =========================================================================
    let _kanbanPlansCache = [];
    let _kanbanAllWorkspaceProjects = {};  // { [resolvedRoot]: string[] }
    let _kanbanWorkspaceItems = [];         // { workspaceRoot, label }[]
    let _kanbanViewMode = 'all'; // 'all' | 'epics'
    let _kanbanSelectedPlan = null;
    let _kanbanPreviewRequestId = 0;
    let _kanbanAvailableColumns = [];  // { id, label, kind }[] — merged across workspaces

    function findPendingKanbanMatch(cache) {
        if (!_pendingKanbanSelection || !cache || !cache.length) return null;
        const { planId, sessionId, planFile, workspaceRoot } = _pendingKanbanSelection;

        // Primary: planId (current canonical identifier)
        if (planId) {
            const byPlanId = cache.find(p => p.planId === planId);
            if (byPlanId) return byPlanId;
        }

        // Legacy fallback: sessionId (deprecated but still present on older plans)
        if (sessionId) {
            const bySession = cache.find(p => p.sessionId === sessionId);
            if (bySession) return bySession;
        }

        // Fallback: planFile
        if (planFile) {
            const byFile = cache.find(p => p.planFile === planFile);
            if (byFile) return byFile;
        }

        // Last resort: workspaceRoot + sessionId compound
        if (workspaceRoot && sessionId) {
            const byCompound = cache.find(p => p.workspaceRoot === workspaceRoot && p.sessionId === sessionId);
            if (byCompound) return byCompound;
        }

        return null;
    }

    function loadKanbanPlanPreview(plan) {
        // Update selection state
        _kanbanSelectedPlan = plan;
        renderKanbanMetaBar(plan);
        if (plan.sessionId) {
            vscode.postMessage({ type: 'planShown', sessionId: plan.sessionId });
        }

        // Fetch preview content
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
    }

    function _complexityToCssClass(complexity) {
        const score = parseInt(complexity, 10);
        if (isNaN(score) || score <= 0) return 'unknown';
        if (score <= 2) return 'very-low';
        if (score <= 4) return 'low';
        if (score <= 6) return 'medium';
        if (score <= 8) return 'high';
        return 'very-high';
    }

    function _getCopyLabel(sourceColumn) {
        let copyLabel = 'Copy Prompt';
        const cols = _kanbanAvailableColumns.map(c => c.id);
        const idx = cols.indexOf(sourceColumn);
        if (idx < 0 || idx >= cols.length - 1) return copyLabel;

        const nextDef = _kanbanAvailableColumns[idx + 1];
        if (nextDef) {
            const isCustom = nextDef.kind === 'custom-user' || nextDef.kind === 'custom-agent';
            if (isCustom) {
                copyLabel = 'Copy advance prompt';
            } else if (nextDef.role === 'planner' || nextDef.id === 'PLAN REVIEWED') {
                copyLabel = 'Copy planning prompt';
            } else if (['lead', 'coder', 'intern'].includes(nextDef.role) || nextDef.kind === 'coded') {
                copyLabel = 'Copy coder prompt';
            } else if (nextDef.role === 'reviewer' || nextDef.id === 'CODE REVIEWED') {
                copyLabel = 'Copy review prompt';
            } else {
                copyLabel = 'Copy advance prompt';
            }
        }
        return copyLabel;
    }

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
        if (btnEdit) btnEdit.style.display = 'none';
        if (_kanbanSelectedPlan) {
            renderKanbanMetaBar(_kanbanSelectedPlan);
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
        if (btnEdit) btnEdit.style.display = '';
        if (_kanbanSelectedPlan) {
            renderKanbanMetaBar(_kanbanSelectedPlan);
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


    function buildKanbanToggleRow() {
        const toggleRow = document.createElement('div');
        toggleRow.className = 'sidebar-toggle-row';

        const foldersBtn = document.createElement('button');
        foldersBtn.className = 'sidebar-folders-btn';
        foldersBtn.id = 'kanban-view-epics-toggle';
        foldersBtn.textContent = _kanbanViewMode === 'epics' ? 'Epics' : 'Plans';
        foldersBtn.addEventListener('click', () => {
            _kanbanViewMode = _kanbanViewMode === 'all' ? 'epics' : 'all';
            renderKanbanPlans(_kanbanPlansCache, kanbanFilters);
        });

        const toggleBtn = document.createElement('button');
        toggleBtn.className = 'sidebar-toggle-btn';
        toggleBtn.title = 'Toggle sidebar';
        toggleBtn.textContent = state.kanbanListCollapsed ? '»' : '«';
        toggleBtn.addEventListener('click', toggleSidebarCollapsed);

        toggleRow.appendChild(foldersBtn);
        toggleRow.appendChild(toggleBtn);
        return toggleRow;
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

        if (_kanbanViewMode === 'epics') {
            filtered = filtered.filter(plan => plan.isEpic);
        }

        kanbanListPane.innerHTML = '';

        // Re-add sidebar toggle row
        kanbanListPane.appendChild(buildKanbanToggleRow());

        if (filtered.length === 0) {
            const emptyMsg = _kanbanViewMode === 'epics' ? 'No epics found' : 'No matching kanban plans';
            const emptyStateDiv = document.createElement('div');
            emptyStateDiv.className = 'kanban-empty-state';
            emptyStateDiv.textContent = emptyMsg;
            kanbanListPane.appendChild(emptyStateDiv);
            return;
        }

        filtered.forEach(plan => {
            const itemDiv = document.createElement('div');
            itemDiv.className = 'kanban-plan-item';
            itemDiv.dataset.planId = plan.planId;
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

            const complexityClass = _complexityToCssClass(plan.complexity);
            const epicAccordion = (_kanbanViewMode === 'epics' && plan.isEpic)
                ? `
                    <details class="epic-accordion" data-plan-id="${escapeHtml(plan.planId)}" data-workspace-root="${escapeHtml(plan.workspaceRoot || '')}" style="margin-top: 6px; font-size: 11px;">
                        <summary style="cursor: pointer; color: var(--text-secondary);">Subtasks (${plan.subtaskCount || 0}) — click to expand</summary>
                        <div class="epic-subtasks" style="margin-top: 4px; padding-left: 8px;">Loading...</div>
                        <div style="margin-top: 6px; display: flex; gap: 4px; align-items: center;">
                            <select class="epic-add-subtask-select" style="flex: 1; font-size: 11px;"><option value="">Add subtask...</option>${_kanbanPlansCache.filter(p => !p.isEpic && !p.epicId && (p.workspaceRoot || '') === (plan.workspaceRoot || '')).map(p => `<option value="${escapeHtml(p.sessionId || p.planId)}">${escapeHtml(p.topic)}</option>`).join('')}</select>
                            <button class="epic-add-subtask-btn strip-btn" style="margin: 0; padding: 2px 6px; font-size: 10px;">Add</button>
                            <button class="epic-delete-btn strip-btn" style="margin: 0; padding: 2px 6px; font-size: 10px; color: #ff6b6b;">Delete Epic</button>
                        </div>
                    </details>
                `
                : '';
            itemDiv.innerHTML = `
                <div style="width: 100%;">
                    <div style="display: flex; align-items: flex-start; gap: 8px;">
                        <span class="kanban-plan-topic">${escapeHtml(plan.topic)}</span>
                        <span class="complexity-dot ${complexityClass}" title="Complexity: ${escapeHtml(plan.complexity)}"></span>
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
                        ${plan.sessionId ? (() => {
                            const copyLabel = _getCopyLabel(plan.column);
                            return `<button class="kanban-plan-copy-prompt" data-session-id="${escapeHtml(plan.sessionId)}" data-column="${escapeHtml(plan.column)}" data-workspace-root="${escapeHtml(plan.workspaceRoot)}" data-copy-label="${escapeHtml(copyLabel)}" title="${escapeHtml(copyLabel)}">${escapeHtml(copyLabel)}</button>`;
                        })() : ''}
                    </div>
                    ${epicAccordion}
                </div>
            `;

            // Row selection
            itemDiv.addEventListener('click', (e) => {
                if (state.dirtyFlags.kanban) {
                    exitEditMode('kanban', true);
                }
                if (state.reviewMode.kanban) {
                    exitReviewMode('kanban', true);
                }

                // Update selected class
                document.querySelectorAll('.kanban-plan-item').forEach(el => el.classList.remove('selected'));
                itemDiv.classList.add('selected');

                // Load preview
                loadKanbanPlanPreview(plan);
            });

            const copyLinkBtn = itemDiv.querySelector('.kanban-plan-copy-link');
            if (copyLinkBtn) {
                copyLinkBtn.addEventListener('click', (e) => {
                    e.stopPropagation(); // Prevent triggering plan selection
                    const planFile = copyLinkBtn.dataset.planFile;
                    if (planFile) {
                        navigator.clipboard.writeText(toAgentRef(planFile)).then(() => {
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

        // Epic accordion interactions
        if (_kanbanViewMode === 'epics') {
            kanbanListPane.querySelectorAll('.epic-accordion').forEach(details => {
                details.addEventListener('toggle', () => {
                    if (details.open) {
                        const planId = details.dataset.planId;
                        vscode.postMessage({ type: 'getEpicDetails', sessionId: planId, workspaceRoot: details.dataset.workspaceRoot || '' });
                    }
                });
            });
            kanbanListPane.querySelectorAll('.epic-add-subtask-btn').forEach(btn => {
                btn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const details = btn.closest('.epic-accordion');
                    const epicSessionId = details ? details.dataset.planId : '';
                    const select = btn.parentElement.querySelector('.epic-add-subtask-select');
                    const subtaskSessionId = select ? select.value : '';
                    if (epicSessionId && subtaskSessionId) {
                        vscode.postMessage({ type: 'addSubtaskToEpic', epicSessionId, subtaskSessionId, workspaceRoot: details.dataset.workspaceRoot || '' });
                    }
                });
            });
            kanbanListPane.querySelectorAll('.epic-delete-btn').forEach(btn => {
                btn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const details = btn.closest('.epic-accordion');
                    const sessionId = details ? details.dataset.planId : '';
                    vscode.postMessage({ type: 'deleteEpic', sessionId, workspaceRoot: details.dataset.workspaceRoot || '', deleteSubtasks: true });
                });
            });
        }
    }

    if (kanbanListPane) {
        kanbanListPane.addEventListener('click', (e) => {
            const removeBtn = e.target.closest('.epic-remove-subtask-btn');
            if (removeBtn) {
                e.stopPropagation();
                const subtaskSessionId = removeBtn.dataset.subtaskSession;
                const epicWorkspaceRoot = removeBtn.dataset.workspaceRoot || '';
                if (subtaskSessionId) {
                    vscode.postMessage({ type: 'removeSubtaskFromEpic', subtaskSessionId, workspaceRoot: epicWorkspaceRoot });
                }
            }
        });
    }

    function renderKanbanMetaBar(plan) {
        const metaBar = document.getElementById('kanban-preview-meta-bar');
        if (!metaBar) return;
        metaBar.style.display = 'flex';

        const columnDef = _kanbanAvailableColumns.find(c => c.id === plan.column);
        const columnLabel = escapeHtml(columnDef ? columnDef.label : plan.column);
        const complexityClass = _complexityToCssClass(plan.complexity);
        const complexityLabel = escapeHtml(plan.complexity || 'Unknown');

        const allColumnOptions = _kanbanAvailableColumns.map(col =>
            `<option value="${escapeHtml(col.id)}">${escapeHtml(col.label)}</option>`
        ).join('');

        const complexityOptions = ['Unknown', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10']
            .map(v => `<option value="${v}" ${v === plan.complexity ? 'selected' : ''}>${v}</option>`)
            .join('');

        metaBar.innerHTML = `
            <div class="kanban-meta-group">
                <span class="kanban-meta-label">Column:</span>
                <span class="kanban-meta-value kanban-meta-dropdown-toggle" id="kanban-meta-column">${columnLabel}</span>
                <select class="kanban-meta-dropdown" id="kanban-meta-column-select" style="display:none;" data-plan-file="${escapeHtml(plan.planFile || '')}" data-workspace-root="${escapeHtml(plan.workspaceRoot)}" data-plan-id="${escapeHtml(plan.planId)}">
                    ${allColumnOptions}
                    <option value="COMPLETED">COMPLETED</option>
                    <option value="__delete__">— Delete Plan —</option>
                </select>
            </div>
            <div class="kanban-meta-group">
                <span class="kanban-meta-label">Complexity:</span>
                <span class="complexity-dot ${complexityClass}"></span>
                <span class="kanban-meta-value kanban-meta-dropdown-toggle" id="kanban-meta-complexity">${complexityLabel}</span>
                <select class="kanban-meta-dropdown" id="kanban-meta-complexity-select" style="display:none;" data-plan-id="${escapeHtml(plan.planId)}" data-workspace-root="${escapeHtml(plan.workspaceRoot)}">
                    ${complexityOptions}
                </select>
            </div>
            <div class="kanban-meta-group">
                <button class="strip-btn" id="kanban-meta-review-btn">${state.reviewMode.kanban ? 'EXIT REVIEW' : 'REVIEW'}</button>
                <button class="strip-btn" id="kanban-meta-log-btn">Log</button>
                <button class="strip-btn" id="kanban-meta-delete-btn">Delete</button>
            </div>
        `;

        // Column dropdown toggle
        const columnToggle = document.getElementById('kanban-meta-column');
        const columnSelect = document.getElementById('kanban-meta-column-select');
        if (columnToggle && columnSelect) {
            columnToggle.addEventListener('click', (e) => {
                e.stopPropagation();
                const isHidden = columnSelect.style.display === 'none';
                document.querySelectorAll('.kanban-meta-dropdown').forEach(el => { el.style.display = 'none'; });
                columnSelect.style.display = isHidden ? 'block' : 'none';
                if (isHidden) columnSelect.focus();
            });
            columnSelect.addEventListener('change', (e) => {
                e.stopPropagation();
                const newColumn = columnSelect.value;
                const planFile = columnSelect.dataset.planFile;
                const workspaceRoot = columnSelect.dataset.workspaceRoot;
                const planId = columnSelect.dataset.planId;
                columnSelect.style.display = 'none';
                if (newColumn === '__delete__') {
                    vscode.postMessage({ type: 'deleteKanbanPlan', planId, planFile, workspaceRoot });
                } else if (planFile && newColumn) {
                    vscode.postMessage({ type: 'moveKanbanPlanColumn', planFile, newColumn, workspaceRoot });
                }
            });
            columnSelect.addEventListener('blur', () => {
                setTimeout(() => { columnSelect.style.display = 'none'; }, 200);
            });
        }

        // Complexity dropdown toggle
        const complexityToggle = document.getElementById('kanban-meta-complexity');
        const complexitySelect = document.getElementById('kanban-meta-complexity-select');
        if (complexityToggle && complexitySelect) {
            complexityToggle.addEventListener('click', (e) => {
                e.stopPropagation();
                const isHidden = complexitySelect.style.display === 'none';
                document.querySelectorAll('.kanban-meta-dropdown').forEach(el => { el.style.display = 'none'; });
                complexitySelect.style.display = isHidden ? 'block' : 'none';
                if (isHidden) complexitySelect.focus();
            });
            complexitySelect.addEventListener('change', (e) => {
                e.stopPropagation();
                const newComplexity = complexitySelect.value;
                const planId = complexitySelect.dataset.planId;
                const workspaceRoot = complexitySelect.dataset.workspaceRoot;
                complexitySelect.style.display = 'none';
                if (planId) {
                    vscode.postMessage({ type: 'setKanbanPlanComplexity', planId, complexity: newComplexity, workspaceRoot });
                }
            });
            complexitySelect.addEventListener('blur', () => {
                setTimeout(() => { complexitySelect.style.display = 'none'; }, 200);
            });
        }

        // Review button
        const reviewBtn = document.getElementById('kanban-meta-review-btn');
        if (reviewBtn) {
            reviewBtn.addEventListener('click', () => {
                if (state.reviewMode.kanban) {
                    exitReviewMode('kanban', true);
                } else {
                    enterReviewMode('kanban');
                }
            });
        }

        // Log button
        const logBtn = document.getElementById('kanban-meta-log-btn');
        if (logBtn) {
            logBtn.addEventListener('click', () => {
                if (plan.sessionId && plan.workspaceRoot) {
                    vscode.postMessage({ type: 'fetchKanbanPlanLog', sessionId: plan.sessionId, workspaceRoot: plan.workspaceRoot });
                }
            });
        }

        // Delete button
        const deleteBtn = document.getElementById('kanban-meta-delete-btn');
        if (deleteBtn) {
            deleteBtn.addEventListener('click', () => {
                vscode.postMessage({ type: 'deleteKanbanPlan', planId: plan.planId, planFile: plan.planFile, workspaceRoot: plan.workspaceRoot });
            });
        }
    }

    // Doc-scoped design controls live in the main controls strip (#controls-strip-design).
    // This derives their enabled state / labels from current selection state.


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
        kanbanWorkspaceFilter.value = currentWS;

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
        kanbanProjectFilter.value = currentProj;
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
        kanbanColumnFilter.value = currentColumn;
    }

    function handleKanbanPlansReady(msg) {
        if (msg.error) {
            if (kanbanListPane) {
                kanbanListPane.innerHTML = '';
                kanbanListPane.appendChild(buildKanbanToggleRow());
                const errorDiv = document.createElement('div');
                errorDiv.className = 'kanban-empty-state';
                errorDiv.style.color = 'var(--vscode-errorForeground, #ff6b6b)';
                errorDiv.textContent = `Error loading plans: ${escapeHtml(msg.error)}`;
                kanbanListPane.appendChild(errorDiv);
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

        if (kanbanFilters.workspaceRoot && !_kanbanWorkspaceItems.some(ws => ws.workspaceRoot === kanbanFilters.workspaceRoot)) {
            kanbanFilters.workspaceRoot = '';
        }

        // Validate that the selected workspace actually has plans
        if (kanbanFilters.workspaceRoot) {
            const hasPlansInWorkspace = _kanbanPlansCache.some(p => p.workspaceRoot === kanbanFilters.workspaceRoot);
            if (!hasPlansInWorkspace) {
                kanbanFilters.workspaceRoot = '';
                persistTab('kanban.root', '');
                if (kanbanWorkspaceFilter) kanbanWorkspaceFilter.value = '';
            }
        }

        populateKanbanFilters();
        updateKanbanColumnFilter();  // NEW: populate column dropdown
        renderKanbanPlans(_kanbanPlansCache, kanbanFilters);

        // Resolve pending selection (e.g. from kanban board Review button)
        if (_pendingKanbanSelection) {
            const match = findPendingKanbanMatch(_kanbanPlansCache);
            if (match) {
                const itemDiv = kanbanListPane && kanbanListPane.querySelector(`.kanban-plan-item[data-plan-id="${match.planId}"]`);
                if (itemDiv) {
                    itemDiv.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    // Update selected class
                    document.querySelectorAll('.kanban-plan-item').forEach(el => el.classList.remove('selected'));
                    itemDiv.classList.add('selected');
                    // Load preview directly (no click simulation, no race condition)
                    loadKanbanPlanPreview(match);
                }
                _pendingKanbanSelection = null;  // Option B: only clear on successful match
            }
            // If no match, _pendingKanbanSelection persists for next fetch cycle
        }

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
            // Hide YAML frontmatter from the rendered preview (edit mode still sees the raw file)
            const displayContent = msg.content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
            // Skip the re-render when the visible content is unchanged (e.g. a
            // frontmatter-only rewrite by sync) — replacing innerHTML reflows the
            // whole preview and makes the doc visibly shift.
            if (displayContent !== kanbanPreviewContent._lastRenderedContent) {
                kanbanPreviewContent._lastRenderedContent = displayContent;
                kanbanPreviewContent.innerHTML = renderMarkdown(displayContent);
            }
        } else {
            kanbanPreviewContent._lastRenderedContent = null;
            kanbanPreviewContent.innerHTML = '<div class="kanban-empty-state">Plan file is empty</div>';
        }

        const btnEditKanban = document.getElementById('btn-edit-kanban');
        if (btnEditKanban) {
            btnEditKanban.disabled = !_kanbanSelectedPlan || !_kanbanSelectedPlan.planFile;
        }
    }

    function handleKanbanContextSet(msg) {
        if (!msg.success) {
            console.error('Failed to set active context:', msg.error || 'Unknown error');
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
            persistTab('kanban.root', kanbanFilters.workspaceRoot);
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
            persistTab('kanban.project', kanbanFilters.project);
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

    const EDIT_BUTTON_IDS = {
        docs: { edit: 'btn-edit', save: 'btn-save', cancel: 'btn-cancel' },
        kanban: { edit: 'btn-edit-kanban', save: 'btn-save-kanban', cancel: 'btn-cancel-kanban' }
    };

    function enterEditMode(tab) {
        if (tab === 'kanban' && state.reviewMode.kanban) {
            exitReviewMode('kanban', true);
        }
        const previewPaneId = tab === 'docs' ? 'preview-pane'
            : tab === 'design' ? 'preview-pane-design'
            : tab === 'kanban' ? 'kanban-preview-pane'
            : null;
        const textareaId = tab === 'docs' ? 'markdown-editor'
            : tab === 'design' ? 'markdown-editor-design'
            : tab === 'kanban' ? 'kanban-editor'
            : null;
        const previewPane = previewPaneId ? document.getElementById(previewPaneId) : null;
        const textarea = textareaId ? document.getElementById(textareaId) : null;

        if (!previewPane || !textarea) return;

        let content = '';
        if (tab === 'docs') {
            content = state.activeDocContent || '';
            state.editOriginalContent.docs = content;
        } else {
            content = state.editOriginalContent.kanban || '';
        }

        textarea.value = content;
        previewPane.classList.add('edit-mode');

        const editBtnIds = EDIT_BUTTON_IDS[tab];
        const btnEdit = editBtnIds ? document.getElementById(editBtnIds.edit) : null;
        const btnSave = editBtnIds ? document.getElementById(editBtnIds.save) : null;
        const btnCancel = editBtnIds ? document.getElementById(editBtnIds.cancel) : null;

        if (btnEdit) btnEdit.style.display = 'none';
        if (btnSave) btnSave.style.display = '';
        if (btnCancel) btnCancel.style.display = '';

        state.editMode[tab] = true;
        state.dirtyFlags[tab] = false;
    }

    function exitEditMode(tab, discard) {
        // No confirmation needed; proceed with exit

        const previewPaneId = tab === 'docs' ? 'preview-pane'
            : tab === 'design' ? 'preview-pane-design'
            : tab === 'kanban' ? 'kanban-preview-pane'
            : null;
        const previewPane = previewPaneId ? document.getElementById(previewPaneId) : null;
        if (previewPane) {
            previewPane.classList.remove('edit-mode');
        }

        const editBtnIds = EDIT_BUTTON_IDS[tab];
        const btnEdit = editBtnIds ? document.getElementById(editBtnIds.edit) : null;
        const btnSave = editBtnIds ? document.getElementById(editBtnIds.save) : null;
        const btnCancel = editBtnIds ? document.getElementById(editBtnIds.cancel) : null;

        if (btnEdit) btnEdit.style.display = '';
        if (btnSave) btnSave.style.display = 'none';
        if (btnCancel) btnCancel.style.display = 'none';

        state.editMode[tab] = false;
        state.dirtyFlags[tab] = false;

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
            } else if (tab === 'docs') {
                if (state.activeSource === 'local-folder') {
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
                        slugPrefix: resolveActiveOnlineSlugPrefix(),
                        requestId: ++state.previewRequestId
                    });
                }
            }
        }

        return true;
    }

    // Wire up edit buttons
    const btnEditDocs = document.getElementById('btn-edit');
    const btnSaveDocs = document.getElementById('btn-save');
    const btnCancelDocs = document.getElementById('btn-cancel');
    const markdownEditorDocs = document.getElementById('markdown-editor');

    if (btnEditDocs) {
        btnEditDocs.addEventListener('click', () => enterEditMode('docs'));
    }
    if (btnSaveDocs) {
        btnSaveDocs.addEventListener('click', () => {
            const isLocalOnly = !ONLINE_SOURCES.includes(state.activeSource);
            const content = markdownEditorDocs ? markdownEditorDocs.value : '';
            if (isLocalOnly) {
                const filePath = state.activeDocFilePath;
                const originalContent = state.editOriginalContent.docs;
                if (filePath) {
                    vscode.postMessage({
                        type: 'saveFileContent',
                        filePath,
                        content,
                        originalContent,
                        tab: 'docs'
                    });
                }
            } else {
                vscode.postMessage({
                    type: 'saveOnlineDocFile',
                    slugPrefix: resolveActiveOnlineSlugPrefix(),
                    content
                });
            }
        });
    }
    if (btnCancelDocs) {
        btnCancelDocs.addEventListener('click', () => exitEditMode('docs', false));
    }
    if (markdownEditorDocs) {
        markdownEditorDocs.addEventListener('input', () => {
            state.dirtyFlags.docs = true;
        });
        setupTextareaTabInterceptor(markdownEditorDocs);
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

    const markdownEditorDesign = document.getElementById('markdown-editor-design');
    if (markdownEditorDesign) {
        markdownEditorDesign.addEventListener('input', () => {
            state.dirtyFlags.design = true;
        });
        setupTextareaTabInterceptor(markdownEditorDesign);
    }

    // Planning-context setting has moved to the Project panel's Epics tab.
    // (The former "Set as Active Planning Context" button has been removed from this panel.)

    // Folder modal open logic
    function openFoldersModal(scope = 'local') {
        folderModalScope = scope;
        const modal = document.getElementById('folder-modal');
        const modalTitle = document.getElementById('folder-modal-title');
        if (modalTitle) {
            if (scope === 'tickets') {
                modalTitle.textContent = 'Manage Tickets Folders';
            } else if (scope === 'research') {
                modalTitle.textContent = 'Manage Research Folders';
            } else {
                modalTitle.textContent = 'Manage Local Docs Folders';
            }
        }
        modal.style.display = 'flex';
        // Sync antigravity toggle state from JS state
        const modalToggle = document.getElementById('antigravity-toggle-modal');
        if (modalToggle) {
            modalToggle.checked = !!state.antigravityEnabled;
        }
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

    // Attachments modal close (X button)
    document.getElementById('btn-close-attachments-modal')?.addEventListener('click', () => {
        document.getElementById('attachments-modal').style.display = 'none';
    });

    // Attachments modal close (backdrop click)
    document.getElementById('attachments-modal')?.addEventListener('click', (e) => {
        if (e.target.id === 'attachments-modal') {
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
            const modalAttachments = document.getElementById('attachments-modal');
            if (modalAttachments && modalAttachments.style.display !== 'none') {
                modalAttachments.style.display = 'none';
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
        let workspaceRoot;
        if (folderModalScope === 'tickets') {
            workspaceRoot = state.docsWorkspaceRootFilter || _workspaceItems[0]?.workspaceRoot || '';
            vscode.postMessage({ type: 'addTicketsFolder', workspaceRoot });
        } else if (folderModalScope === 'research') {
            workspaceRoot = researchWorkspaceRoot || _workspaceItems[0]?.workspaceRoot || '';
            vscode.postMessage({ type: 'addLocalFolder', workspaceRoot });
        } else {
            workspaceRoot = state.docsWorkspaceRootFilter || _workspaceItems[0]?.workspaceRoot || '';
            vscode.postMessage({ type: 'addLocalFolder', workspaceRoot });
        }
    });

    // ===== TICKETS TAB IMPLEMENTATION =====

    function updateTicketsWorkspacePicker() {
        const select = document.getElementById('tickets-workspace-filter');
        const staticLabel = document.getElementById('tickets-workspace-label');
        if (!select || !staticLabel) return;

        const count = _integrationWorkspaces.length;

        if (count === 0) {
            // No integrations — show static "Configure Integration" prompt
            select.style.display = 'none';
            staticLabel.style.display = '';
            staticLabel.textContent = 'Configure ClickUp or Linear in workspace settings to browse tickets.';
            return;
        }

        // Tickets are global — hide the workspace picker entirely.
        // ticketsWorkspaceRoot is only used internally for file-save context.
        select.style.display = 'none';
        staticLabel.style.display = 'none';

        // Ensure ticketsWorkspaceRoot is set for internal file-save context
        if (!ticketsWorkspaceRoot && _integrationWorkspaces.length > 0) {
            ticketsWorkspaceRoot = _integrationWorkspaces[0].workspaceRoot;
            persistTab('tickets.root', ticketsWorkspaceRoot);
        }
    }

    function currentSelectedTicketId() {
        return lastIntegrationProvider === 'linear'
            ? (selectedLinearIssue?.issue?.id || null)
            : (selectedClickUpIssue?.task?.id || null);
    }

    function renderAgentApiModal() {
        const list = document.getElementById('tickets-agent-api-list');
        const label = document.getElementById('tickets-agent-api-provider-label');
        if (!list) return;
        const provider = lastIntegrationProvider;
        list.innerHTML = '';

        if (!provider || !AGENT_API_CAPABILITIES[provider]) {
            if (label) label.textContent = '';
            const li = document.createElement('li');
            li.style.justifyContent = 'flex-start';
            li.innerHTML = '<span class="agent-api-desc">Configure a ClickUp or Linear integration in Setup to enable the agent API.</span>';
            list.appendChild(li);
            return;
        }

        if (label) label.textContent = (provider === 'clickup' ? 'ClickUp' : 'Linear') + ' — no MCP required';
        const ticketId = currentSelectedTicketId();

        AGENT_API_CAPABILITIES[provider].forEach(cap => {
            const filledPrompt = cap.prompt.replace(/\{ticketId\}/g, ticketId || 'the ticket id');
            const li = document.createElement('li');
            const text = document.createElement('div');
            text.className = 'agent-api-text';
            const name = document.createElement('div');
            name.className = 'agent-api-name';
            name.textContent = cap.name;
            const desc = document.createElement('div');
            desc.className = 'agent-api-desc';
            desc.textContent = cap.desc;
            text.appendChild(name);
            text.appendChild(desc);
            const btn = document.createElement('button');
            btn.className = 'strip-btn agent-api-copy';
            btn.textContent = 'Copy prompt';
            btn.addEventListener('click', async () => {
                if (btn.textContent === 'COPIED') return;
                try {
                    await navigator.clipboard.writeText(filledPrompt);
                    btn.textContent = 'COPIED';
                } catch (err) {
                    console.error('[AgentAPI] clipboard failed:', err);
                    btn.textContent = 'FAILED';
                }
                setTimeout(() => { btn.textContent = 'Copy prompt'; }, 2000);
            });
            li.appendChild(text);
            li.appendChild(btn);
            list.appendChild(li);
        });
    }

    function updateTicketsSourceSummary() {
        const { ticketsSourceSummary } = getTicketsTabElements();
        if (!ticketsSourceSummary) return;

        const provider = lastIntegrationProvider;
        if (!provider) {
            ticketsSourceSummary.textContent = '';
            return;
        }

        if (provider === 'clickup') {
            let summary = 'ClickUp';
            if (clickUpSelectedSpaceId) {
                const space = clickUpAvailableSpaces.find(s => s.id === clickUpSelectedSpaceId);
                if (space) {
                    summary += ' ▸ ' + space.name;
                }
            }
            if (clickUpSelectedFolderId && clickUpSelectedFolderId !== '_root_') {
                const folder = clickUpAvailableFolders.find(f => f.id === clickUpSelectedFolderId);
                if (folder) {
                    summary += ' ▸ ' + folder.name;
                }
            }
            if (clickUpSelectedListId) {
                let list = clickUpAvailableListsInFolder.find(l => l.id === clickUpSelectedListId);
                if (!list) {
                    list = clickUpAvailableDirectLists.find(l => l.id === clickUpSelectedListId);
                }
                if (list) {
                    summary += ' ▸ ' + list.name;
                }
            }
            ticketsSourceSummary.textContent = summary;
        } else if (provider === 'linear') {
            ticketsSourceSummary.textContent = 'Linear';
        } else {
            ticketsSourceSummary.textContent = '';
        }
    }

    function initTicketsTab() {
        const {
            searchInput, projectPicker, stateFilter, clickUpStatusFilter, refreshButton, loadMoreButton,
            btnImportAllTickets, importAllKanbanButton, linkAllButton, syncAllButton,
            ticketsSourceBtn, ticketsSourceModal, btnCloseTicketsSourceModal, btnCloseTicketsSourceModalAction,
            ticketsAgentApiBtn, ticketsAgentApiModal, btnCloseTicketsAgentApiModal, btnCloseTicketsAgentApiModalAction
        } = getTicketsTabElements();

        // Custom update call to populate dropdown if integrations already fetched
        updateTicketsWorkspacePicker();

        ticketsSourceBtn?.addEventListener('click', () => {
            if (ticketsSourceModal) {
                ticketsSourceModal.style.display = 'block';
            }
        });

        btnCloseTicketsSourceModal?.addEventListener('click', () => {
            if (ticketsSourceModal) {
                ticketsSourceModal.style.display = 'none';
            }
        });

        btnCloseTicketsSourceModalAction?.addEventListener('click', () => {
            if (ticketsSourceModal) {
                ticketsSourceModal.style.display = 'none';
            }
        });

        ticketsSourceModal?.addEventListener('click', (e) => {
            if (e.target === e.currentTarget) {
                e.currentTarget.style.display = 'none';
            }
        });

        ticketsAgentApiBtn?.addEventListener('click', () => {
            renderAgentApiModal();              // rebuild every open → source-aware
            if (ticketsAgentApiModal) {
                ticketsAgentApiModal.style.display = 'block';
            }
        });

        btnCloseTicketsAgentApiModal?.addEventListener('click', () => {
            if (ticketsAgentApiModal) {
                ticketsAgentApiModal.style.display = 'none';
            }
        });

        btnCloseTicketsAgentApiModalAction?.addEventListener('click', () => {
            if (ticketsAgentApiModal) {
                ticketsAgentApiModal.style.display = 'none';
            }
        });

        ticketsAgentApiModal?.addEventListener('click', (e) => {
            if (e.target === e.currentTarget) {
                e.currentTarget.style.display = 'none';
            }
        });

        document.getElementById('tickets-provider-selector')?.addEventListener('change', (e) => {
            const newProvider = e.target.value;
            if (!newProvider || !ticketsWorkspaceRoot) return;
            saveTicketsState();
            resetTicketsInMemoryState();
            lastIntegrationProvider = newProvider;
            ticketsLoadedOnce = false;
            updateTicketsSourceSummary();
            // The backend responds to switchTicketsProvider with an
            // integrationProviderStates message, whose handler drives the
            // (autoSync-aware) ticket load exactly once. Loading here too would
            // double-fetch (autoSync on) or flash remote-then-local (autoSync off).
            vscode.postMessage({
                type: 'switchTicketsProvider',
                provider: newProvider,
                workspaceRoot: ticketsWorkspaceRoot
            });
        });

        document.getElementById('tickets-workspace-filter')?.addEventListener('change', (e) => {
            const newRoot = e.target.value;
            if (!newRoot) return;

            // 1. Save outgoing root's nav state
            saveTicketsState();

            // 2. Set ticketsWorkspaceRoot
            ticketsWorkspaceRoot = newRoot;
            persistTab('tickets.root', ticketsWorkspaceRoot);
            vscode.postMessage({ type: 'ticketsRootChanged', workspaceRoot: ticketsWorkspaceRoot });

            // 3. Load the new root's persisted nav
            const rootState = (_restoredPanelState.byRoot['tickets'] || {})[newRoot];
            if (rootState) {
                restoreTicketsStateForRoot(rootState);
            }

            // 4. Refresh local files if not auto-syncing
            if (!ticketsAutoSync) {
                loadLocalTicketFiles();
            }
        });

        // Import All button (imports as local documents for editing)
        btnImportAllTickets?.addEventListener('click', () => {
            if (isImportingAll) return;
            const provider = lastIntegrationProvider;
            let ids = [];
            if (provider === 'linear') {
                ids = getFilteredLinearIssues().map(issue => issue.id);
            } else if (provider === 'clickup') {
                ids = getFilteredClickUpTasks().map(task => task.id);
            }
            if (ids.length === 0) {
                showTicketsStatus('No tickets to import', true);
                return;
            }
            isImportingAll = true;
            btnImportAllTickets.disabled = true;
            if (importAllKanbanButton) importAllKanbanButton.disabled = true;
            setTicketsLoadingState(true);
            vscode.postMessage({
                type: 'importAllTickets',
                workspaceRoot: ticketsWorkspaceRoot,
                provider,
                ids,
                importMode: 'document'
            });
        });

        // Import All as Plans button (imports as kanban plans)
        importAllKanbanButton?.addEventListener('click', () => {
            if (isImportingAll) return;
            const provider = lastIntegrationProvider;
            let ids = [];
            if (provider === 'linear') {
                ids = getFilteredLinearIssues().map(issue => issue.id);
            } else if (provider === 'clickup') {
                ids = getFilteredClickUpTasks().map(task => task.id);
            }
            if (ids.length === 0) {
                showTicketsStatus('No tickets to import', true);
                return;
            }
            isImportingAll = true;
            btnImportAllTickets.disabled = true;
            if (importAllKanbanButton) importAllKanbanButton.disabled = true;
            setTicketsLoadingState(true);
            vscode.postMessage({
                type: 'importAllTickets',
                workspaceRoot: ticketsWorkspaceRoot,
                provider,
                ids,
                importMode: 'plan'
            });
        });

        linkAllButton?.addEventListener('click', () => {
            const provider = lastIntegrationProvider;
            let ids = [];
            if (provider === 'linear') {
                ids = getFilteredLinearIssues().map(issue => issue.id);
            } else if (provider === 'clickup') {
                ids = getFilteredClickUpTasks().map(task => task.id);
            }
            vscode.postMessage({
                type: 'copyToClipboard',
                provider: lastIntegrationProvider,
                workspaceRoot: ticketsWorkspaceRoot,
                ticketIds: ids
            });
            _lastLinkTicketBtn = linkAllButton;
        });

        syncAllButton?.addEventListener('click', () => {
            setTicketsLoadingState(true);
            if (syncAllButton) syncAllButton.disabled = true;
            vscode.postMessage({
                type: 'syncAllTickets',
                provider: lastIntegrationProvider,
                workspaceRoot: ticketsWorkspaceRoot
            });
        });

        document.getElementById('btn-edit-ticket')?.addEventListener('click', () => {
            enterTicketsEditMode();
        });

        document.getElementById('btn-save-ticket-edit')?.addEventListener('click', () => {
            const editDiv = document.getElementById('ticket-edit-description');
            if (!editDiv) return;
            const provider = lastIntegrationProvider;
            const issue = provider === 'linear' ? selectedLinearIssue : selectedClickUpIssue;
            const id = provider === 'linear' ? issue?.issue?.id : issue?.task?.id;
            if (!id) return;
            const task = provider === 'linear' ? issue.issue : issue.task;
            const titleEl = document.getElementById('ticket-edit-title');
            const fallbackTitle = task.title || task.identifier || task.id;
            // textContent strips any stray formatting the contenteditable may inject.
            const title = ((titleEl ? titleEl.textContent : fallbackTitle) || '').trim() || fallbackTitle;
            // The editor now holds raw markdown — use it verbatim, no lossy HTML round-trip.
            const markdownBody = (editDiv.value || '').trim();
            const fullMarkdown = `# ${title}\n\n${markdownBody}`;
            // Update in-memory immediately so display is consistent (title included)
            const rendered = renderMarkdown(markdownBody);
            if (provider === 'clickup') {
                selectedClickUpIssue = { ...selectedClickUpIssue, task: { ...selectedClickUpIssue.task, title }, renderedDescriptionHtml: rendered, descriptionMarkdown: markdownBody, localDescription: true };
                clickUpTaskDetailCache.set(id, selectedClickUpIssue);
                const listItem = clickUpProjectIssues.find(t => t.id === id);
                if (listItem) { listItem.title = title; }
            } else {
                selectedLinearIssue = { ...selectedLinearIssue, issue: { ...selectedLinearIssue.issue, title }, renderedDescriptionHtml: rendered, descriptionMarkdown: markdownBody, localDescription: true };
                linearIssueDetailCache.set(id, selectedLinearIssue);
                const listItem = linearProjectIssues.find(i => i.id === id);
                if (listItem) { listItem.title = title; }
            }
            vscode.postMessage({ type: 'saveLocalTicketFile', provider, id, content: fullMarkdown, workspaceRoot: ticketsWorkspaceRoot });
            exitTicketsEditMode();
        });

        document.getElementById('btn-cancel-ticket-edit')?.addEventListener('click', () => {
            exitTicketsEditMode();
        });

        // Action bar: Push
        document.getElementById('btn-push-ticket')?.addEventListener('click', () => {
            const provider = lastIntegrationProvider;
            const id = provider === 'linear'
                ? selectedLinearIssue?.issue.id
                : selectedClickUpIssue?.task.id;
            if (!id) return;
            setTicketsLoadingState(true);
            vscode.postMessage({ type: 'pushTicket', provider, id, workspaceRoot: ticketsWorkspaceRoot });
        });

        // Action bar: Delete — modal confirm gate
        document.getElementById('btn-delete-ticket')?.addEventListener('click', () => {
            const provider = lastIntegrationProvider;
            const id = provider === 'linear'
                ? selectedLinearIssue?.issue.id
                : selectedClickUpIssue?.task.id;
            if (!id) return;
            const title = provider === 'linear'
                ? selectedLinearIssue?.issue.title
                : selectedClickUpIssue?.task.title || selectedClickUpIssue?.task.name || '';
            _pendingDeleteTicket = { provider, id, title };
            const info = document.getElementById('tickets-delete-modal-info');
            if (info) info.innerHTML = 'Delete <strong>' + escapeHtml(title || id) + '</strong>? This cannot be undone.';
            const confirmBtn = document.getElementById('btn-confirm-tickets-delete');
            if (confirmBtn) confirmBtn.disabled = false;
            const modal = document.getElementById('tickets-delete-modal');
            if (modal) modal.style.display = 'block';
        });

        document.getElementById('btn-confirm-tickets-delete')?.addEventListener('click', () => {
            if (!_pendingDeleteTicket) return;
            const { provider, id } = _pendingDeleteTicket;
            const confirmBtn = document.getElementById('btn-confirm-tickets-delete');
            if (confirmBtn) confirmBtn.disabled = true; // double-click guard
            setTicketsLoadingState(true);
            vscode.postMessage({ type: 'deleteTicketConfirmed', provider, id, workspaceRoot: ticketsWorkspaceRoot });
        });

        document.getElementById('btn-close-tickets-delete-modal')?.addEventListener('click', () => {
            const modal = document.getElementById('tickets-delete-modal');
            if (modal) modal.style.display = 'none';
            _pendingDeleteTicket = null;
        });

        document.getElementById('btn-cancel-tickets-delete')?.addEventListener('click', () => {
            const modal = document.getElementById('tickets-delete-modal');
            if (modal) modal.style.display = 'none';
            _pendingDeleteTicket = null;
        });

        document.getElementById('tickets-delete-modal')?.addEventListener('click', (e) => {
            if (e.target === e.currentTarget) {
                e.currentTarget.style.display = 'none';
                _pendingDeleteTicket = null;
            }
        });

        // Action bar: Change Status
        document.getElementById('select-status-ticket')?.addEventListener('change', (e) => {
            const provider = lastIntegrationProvider;
            const id = provider === 'linear'
                ? selectedLinearIssue?.issue.id
                : selectedClickUpIssue?.task.id;
            if (!id) return;
            const statusId = e.target.value;
            setTicketsLoadingState(true);
            vscode.postMessage({ type: 'changeTicketStatus', provider, id, statusId, workspaceRoot: ticketsWorkspaceRoot });
        });

        // Action bar: Comment button → open comment manager panel
        document.getElementById('btn-comment-ticket')?.addEventListener('click', () => {
            const provider = lastIntegrationProvider;
            const id = provider === 'linear'
                ? selectedLinearIssue?.issue.id
                : selectedClickUpIssue?.task.id;
            if (!id) return;
            openCommentManager(provider, id);
        });

        // Action bar: Open ticket in browser
        document.getElementById('btn-open-ticket')?.addEventListener('click', (e) => {
            const url = e.currentTarget.dataset.url;
            if (url) vscode.postMessage({ type: 'openExternalUrl', url });
        });

        // Action bar: Diagram Prompt — copies a prompt to clipboard for agent handoff
        document.getElementById('btn-diagram-prompt')?.addEventListener('click', () => {
            const provider = lastIntegrationProvider;
            if (!provider) return;
            const isLinear = provider === 'linear';
            const issue = isLinear ? selectedLinearIssue : selectedClickUpIssue;
            if (!issue) return;
            const id = isLinear ? issue.issue.id : issue.task.id;
            const title = isLinear ? (issue.issue.title || issue.issue.identifier || id) : (issue.task.name || issue.task.title || id);
            const ticketUrl = _ticketExternalUrl(provider, isLinear ? (issue.issue.identifier || id) : id, isLinear ? issue.issue.url : issue.task.url);
            const workspaceRoot = ticketsWorkspaceRoot;
            const providerName = isLinear ? 'Linear' : 'ClickUp';
            const prompt = `Generate an architectural diagram for this ticket and attach it inline.

Ticket: ${title}
URL: ${ticketUrl}
ID: ${id}
Provider: ${provider}
Workspace: ${workspaceRoot}

Instructions:
1. Ask me what kind of diagram I want (flowchart, sequence, component, etc.) and what it should represent.
2. Generate Mermaid syntax for the diagram.
3. Render the Mermaid to a PNG file. You can use mermaid-cli (\`npx @mermaid-js/mermaid-cli -i input.mmd -o output.png\`) or any other method.
4. Find the ticket's local markdown file — it's located under the \`.switchboard/tickets/${provider}/\` directory in the workspace root (or a custom tickets folder if configured), and the filename starts with \`${provider}_${id}_\`.
5. Save the PNG file in the same directory as the ticket markdown file.
6. Edit the ticket markdown file directly and insert the diagram as an inline image: \`![{diagram-name}](./{filename}.png)\` — place it where it makes sense in the description.
7. Tell me when done. I will click "Push" in the Switchboard tickets tab, which will automatically upload the image to ${providerName} and rewrite the URL.`;
            vscode.postMessage({ type: 'copyDiagramPrompt', prompt });
        });

        // Action bar: View Attachments button toggle
        document.getElementById('btn-view-attachments')?.addEventListener('click', () => {
            const modal = document.getElementById('attachments-modal');
            if (!modal) return;
            const isVisible = modal.style.display !== 'none';
            if (isVisible) {
                modal.style.display = 'none';
            } else {
                modal.style.display = 'flex';
                const { attachmentsList } = getTicketsTabElements();
                if (attachmentsList) {
                    attachmentsList.innerHTML = '<div style="font-size: 11px; color: var(--text-secondary);">Loading status...</div>';
                }
                const provider = lastIntegrationProvider;
                const ticketId = provider === 'linear' ? selectedLinearIssue?.issue?.id : selectedClickUpIssue?.task?.id;
                const attachments = provider === 'linear' ? selectedLinearIssue?.attachments : selectedClickUpIssue?.attachments;
                if (ticketId && attachments) {
                    vscode.postMessage({
                        type: 'viewAttachments',
                        workspaceRoot: ticketsWorkspaceRoot,
                        provider,
                        ticketId,
                        attachments
                    });
                }
            }
        });

        // Comment post cancel — close manager
        document.getElementById('btn-post-comment-cancel')?.addEventListener('click', () => {
            closeCommentManager();
        });

        // Comment post submit — extract mentions, post with optimistic insert
        document.getElementById('btn-post-comment-submit')?.addEventListener('click', () => {
            const provider = lastIntegrationProvider;
            const id = provider === 'linear'
                ? selectedLinearIssue?.issue.id
                : selectedClickUpIssue?.task.id;
            const textarea = document.getElementById('tickets-comment-textarea');
            const comment = textarea?.value?.trim();
            if (!id || !comment) return;
            const mentions = extractMentionsFromText(comment, _cmMembers);
            // Backup draft for rollback
            _cmDraftBackup = comment;
            // Optimistic insert
            optimisticInsertComment({
                id: 'optimistic_' + Date.now(),
                author: { id: '', name: 'You', email: '' },
                body: comment,
                date: new Date().toISOString(),
                mentions,
                replies: [],
                _optimistic: true
            }, null);
            // Clear textarea
            if (textarea) textarea.value = '';
            vscode.postMessage({ type: 'postTicketComment', provider, id, comment, mentions, workspaceRoot: ticketsWorkspaceRoot });
        });

        // Comment manager: refresh button
        document.getElementById('btn-comments-refresh')?.addEventListener('click', () => {
            const provider = lastIntegrationProvider;
            const id = provider === 'linear'
                ? selectedLinearIssue?.issue.id
                : selectedClickUpIssue?.task.id;
            if (!id) return;
            loadCommentThreads(provider, id);
        });

        // Comment manager: close button
        document.getElementById('btn-comments-close')?.addEventListener('click', () => {
            closeCommentManager();
        });

        // Mention autocomplete on textarea
        const cmTextarea = document.getElementById('tickets-comment-textarea');
        if (cmTextarea) {
            cmTextarea.addEventListener('input', (e) => handleMentionAutocomplete(e, cmTextarea, 'compose'));
            cmTextarea.addEventListener('keydown', (e) => handleMentionKeydown(e, cmTextarea, 'compose'));
        }

        // Project picker (Linear)
        projectPicker?.addEventListener('change', (e) => {
            linearProjectPickerValue = e.target.value;
            renderTicketsLinearList();
            saveTicketsState();
        });

        // State filter (Linear)
        stateFilter?.addEventListener('change', (e) => {
            linearProjectStateFilterValue = e.target.value;
            renderTicketsLinearList();
            saveTicketsState();
        });

        // Status filter (ClickUp)
        clickUpStatusFilter?.addEventListener('change', (e) => {
            clickUpProjectStatusFilterValue = e.target.value;
            renderTicketsClickUpList();
            saveTicketsState();
        });

        // Refresh button — re-fetches online view
        refreshButton?.addEventListener('click', () => {
            linearIssueDetailCache.clear();
            clickUpTaskDetailCache.clear();
            _pendingRefreshImport = true;
            if (lastIntegrationProvider === 'linear') {
                loadLinearProject(true);
            } else if (lastIntegrationProvider === 'clickup') {
                if (clickUpSelectedListId) {
                    vscode.postMessage({ type: 'invalidateClickUpCache', workspaceRoot: ticketsWorkspaceRoot });
                    loadClickUpProject(true);
                } else {
                    loadClickUpSpaces();
                }
            }
        });

        // Load more button (ClickUp pagination)
        loadMoreButton?.addEventListener('click', loadMoreClickUpTasks);

        // Detail action buttons (delegated)
        document.getElementById('preview-pane-tickets')?.addEventListener('click', (e) => {
            const attachmentBtn = e.target.closest('.tickets-attachment-item');

            if (attachmentBtn) {
                const provider = lastIntegrationProvider;
                const url = attachmentBtn.dataset.linearAttachmentUrl || attachmentBtn.dataset.clickupAttachmentUrl;
                const filename = attachmentBtn.textContent.trim();
                const ticketId = provider === 'linear'
                    ? selectedLinearIssue?.issue.id
                    : selectedClickUpIssue?.task.id;
                const ticketTitle = provider === 'linear'
                    ? selectedLinearIssue?.issue.title
                    : selectedClickUpIssue?.task.name;
                vscode.postMessage({
                    type: 'downloadAttachment',
                    workspaceRoot: ticketsWorkspaceRoot,
                    provider,
                    url,
                    filename,
                    ticketId,
                    ticketTitle
                });
            }
        });

        // Subtask navigation clicks
        document.getElementById('tickets-subtasks-nav')?.addEventListener('click', (e) => {
            const item = e.target.closest('.subtask-nav-item');
            if (!item) return;
            const subtaskId = item.dataset.subtaskId;
            const provider = item.dataset.provider;
            const nav = document.getElementById('tickets-subtasks-nav');
            nav?.querySelectorAll('.subtask-nav-item').forEach(i => i.classList.remove('selected'));
            item.classList.add('selected');
            if (provider === 'linear') {
                if (linearIssueDetailCache.has(subtaskId)) {
                    selectedLinearIssue = linearIssueDetailCache.get(subtaskId);
                    renderTicketsLinearPanel();
                } else {
                    loadLinearTaskDetails(subtaskId);
                }
            } else if (provider === 'clickup') {
                if (clickUpTaskDetailCache.has(subtaskId)) {
                    selectedClickUpIssue = clickUpTaskDetailCache.get(subtaskId);
                    renderTicketsClickUpPanel();
                } else {
                    loadClickUpTaskDetails(subtaskId);
                }
            }
        });

        // Issue card clicks (delegated)
        document.getElementById('tickets-issues-container')?.addEventListener('click', (e) => {
            const importPlanBtn = e.target.closest('[data-import-plan-id]');
            const linkTicketBtn = e.target.closest('[data-link-ticket-id]');
            if (importPlanBtn) {
                const id = importPlanBtn.dataset.importPlanId;
                flashIconBtn(importPlanBtn);
                handleTicketsImport(lastIntegrationProvider, id, true, 'plan');
                return;
            }
            if (linkTicketBtn) {
                const id = linkTicketBtn.dataset.linkTicketId;
                const provider = linkTicketBtn.dataset.provider;
                handleLinkToTicket(provider, id, linkTicketBtn);
                return;
            }
            const refineBtn = e.target.closest('[data-refine-ticket-id]');
            if (refineBtn) {
                const id = refineBtn.dataset.refineTicketId;
                const provider = refineBtn.dataset.provider;
                let title = '';
                let description = '';
                if (provider === 'linear') {
                    const issue = linearProjectIssues.find(i => i.id === id);
                    title = issue?.title || issue?.identifier || '';
                    description = issue?.description || '';
                } else {
                    const task = clickUpProjectIssues.find(t => t.id === id);
                    title = task?.title || task?.identifier || '';
                    description = task?.markdownDescription || task?.description || '';
                }
                vscode.postMessage({
                    type: 'copyRefinePrompt',
                    provider,
                    id,
                    title,
                    description,
                    workspaceRoot: ticketsWorkspaceRoot
                });
                flashCopyBtn(refineBtn);
                return;
            }
            const card = e.target.closest('[data-linear-issue-id], [data-clickup-task-id]');
            if (card) {
                const linearId = card.dataset.linearIssueId;
                const clickUpId = card.dataset.clickupTaskId;
                if (linearId) {
                    const cachedLinear = linearIssueDetailCache.get(linearId);
                    // Only skip the API fetch when full details were actually fetched.
                    // A file-change stub (detailsFetched falsy, comments: []) must NOT
                    // short-circuit, or comments/attachments would never load.
                    if (cachedLinear && cachedLinear.detailsFetched) {
                        selectedLinearIssue = cachedLinear;
                        renderTicketsLinearPanel();
                    } else {
                        // Render the cached description instantly (if any) while we fetch.
                        if (cachedLinear) {
                            selectedLinearIssue = cachedLinear;
                            renderTicketsLinearPanel();
                        }
                        // Local file for fast description, API for comments/attachments
                        vscode.postMessage({ type: 'readLocalTicketFile', provider: 'linear', id: linearId, workspaceRoot: ticketsWorkspaceRoot });
                        vscode.postMessage({ type: 'linearLoadTaskDetails', issueId: linearId, workspaceRoot: ticketsWorkspaceRoot || undefined });
                    }
                } else if (clickUpId) {
                    const cachedClickUp = clickUpTaskDetailCache.get(clickUpId);
                    if (cachedClickUp && cachedClickUp.detailsFetched) {
                        selectedClickUpIssue = cachedClickUp;
                        renderTicketsClickUpPanel();
                    } else {
                        // Render the cached description instantly (if any) while we fetch.
                        if (cachedClickUp) {
                            selectedClickUpIssue = cachedClickUp;
                            renderTicketsClickUpPanel();
                        }
                        // Local file for fast description, API for comments/attachments
                        vscode.postMessage({ type: 'readLocalTicketFile', provider: 'clickup', id: clickUpId, workspaceRoot: ticketsWorkspaceRoot });
                        vscode.postMessage({ type: 'clickupLoadTaskDetails', taskId: clickUpId, workspaceRoot: ticketsWorkspaceRoot || undefined });
                    }
                }
            }
        });

        // Create ticket button click
        document.getElementById('tickets-create')?.addEventListener('click', () => {
            _subtaskParent = null;
            const modalTitle = document.getElementById('create-ticket-modal-title');
            if (modalTitle) modalTitle.textContent = 'Create New Ticket';
            const modal = document.getElementById('create-ticket-modal');
            if (modal) {
                modal.style.display = 'block';
                // Reset form fields
                const titleInput = document.getElementById('create-ticket-title');
                const descInput = document.getElementById('create-ticket-description');
                if (titleInput) {
                    titleInput.value = '';
                    titleInput.focus();
                }
                if (descInput) descInput.value = '';
            }
        });

        // Close modal
        document.getElementById('btn-close-create-ticket-modal')?.addEventListener('click', () => {
            const modal = document.getElementById('create-ticket-modal');
            if (modal) modal.style.display = 'none';
            _subtaskParent = null;
            const modalTitle = document.getElementById('create-ticket-modal-title');
            if (modalTitle) modalTitle.textContent = 'Create New Ticket';
        });
        document.getElementById('btn-cancel-create-ticket')?.addEventListener('click', () => {
            const modal = document.getElementById('create-ticket-modal');
            if (modal) modal.style.display = 'none';
            _subtaskParent = null;
            const modalTitle = document.getElementById('create-ticket-modal-title');
            if (modalTitle) modalTitle.textContent = 'Create New Ticket';
        });
        document.getElementById('create-ticket-modal')?.addEventListener('click', (e) => {
            if (e.target === e.currentTarget) {
                e.currentTarget.style.display = 'none';
                _subtaskParent = null;
                const modalTitle = document.getElementById('create-ticket-modal-title');
                if (modalTitle) modalTitle.textContent = 'Create New Ticket';
            }
        });

        // Tags button
        document.getElementById('tickets-tags')?.addEventListener('click', openTagsModal);

        // Modal close buttons
        document.getElementById('btn-close-tags-modal')?.addEventListener('click', () => {
            const modal = document.getElementById('tags-modal');
            if (modal) modal.style.display = 'none';
            _tagsModalOpen = false;
        });
        document.getElementById('btn-cancel-tags')?.addEventListener('click', () => {
            const modal = document.getElementById('tags-modal');
            if (modal) modal.style.display = 'none';
            _tagsModalOpen = false;
        });
        document.getElementById('btn-save-tags')?.addEventListener('click', saveTags);
        document.getElementById('tags-modal')?.addEventListener('click', (e) => {
            if (e.target === e.currentTarget) {
                e.currentTarget.style.display = 'none';
                _tagsModalOpen = false;
            }
        });

        // Submit form
        document.getElementById('btn-submit-create-ticket')?.addEventListener('click', () => {
            const titleInput = document.getElementById('create-ticket-title');
            const descInput = document.getElementById('create-ticket-description');
            const title = titleInput ? titleInput.value.trim() : '';
            const description = descInput ? descInput.value.trim() : '';

            if (!title) {
                if (titleInput) {
                    titleInput.style.borderColor = 'var(--vscode-errorForeground, #ff6b6b)';
                    titleInput.placeholder = 'Title is required';
                    setTimeout(() => {
                        titleInput.style.borderColor = '';
                        titleInput.placeholder = 'Enter ticket title';
                    }, 2000);
                }
                return;
            }

            const submitBtn = document.getElementById('btn-submit-create-ticket');
            if (submitBtn) {
                submitBtn.disabled = true;
                submitBtn.textContent = 'Creating...';
            }

            vscode.postMessage({
                type: lastIntegrationProvider === 'clickup' ? 'clickupCreateTask' : 'linearCreateIssue',
                workspaceRoot: ticketsWorkspaceRoot || undefined,
                title,
                description: description || undefined,
                listId: clickUpSelectedListId || undefined,
                projectName: linearProjectPickerValue || undefined,
                ...(_subtaskParent ? { parentId: _subtaskParent.id } : {})
            });
        });

        // Add Subtask button
        document.getElementById('btn-add-subtask')?.addEventListener('click', () => {
            const provider = lastIntegrationProvider;
            const issue = provider === 'linear' ? selectedLinearIssue : selectedClickUpIssue;
            if (!issue) return;
            const task = provider === 'linear' ? issue.issue : issue.task;
            const ticketId = task?.id;
            const ticketTitle = task?.title || task?.name || '';
            if (!ticketId) return;
            _subtaskParent = { id: ticketId, title: ticketTitle, provider };
            const modal = document.getElementById('create-ticket-modal');
            if (modal) {
                modal.style.display = 'block';
                const modalTitle = document.getElementById('create-ticket-modal-title');
                if (modalTitle) modalTitle.textContent = 'Create Subtask under ' + ticketTitle;
                const titleInput = document.getElementById('create-ticket-title');
                const descInput = document.getElementById('create-ticket-description');
                if (titleInput) { titleInput.value = ''; titleInput.focus(); }
                if (descInput) descInput.value = '';
            }
        });

        // Convert to Subtask button
        document.getElementById('btn-convert-subtask')?.addEventListener('click', () => {
            const provider = lastIntegrationProvider;
            const issue = provider === 'linear' ? selectedLinearIssue : selectedClickUpIssue;
            if (!issue) return;
            const task = provider === 'linear' ? issue.issue : issue.task;
            const ticketId = task?.id;
            const ticketTitle = task?.title || task?.name || '';
            if (!ticketId) return;
            _convertCurrentTicketId = ticketId;
            _convertSelectedParentId = null;
            const modal = document.getElementById('convert-subtask-modal');
            if (modal) modal.style.display = 'block';
            const info = document.getElementById('convert-subtask-info');
            if (info) info.innerHTML = 'Select a parent ticket for <strong>' + escapeHtml(ticketTitle) + '</strong>';
            const searchInput = document.getElementById('convert-subtask-search');
            if (searchInput) searchInput.value = '';
            const confirmBtn = document.getElementById('btn-confirm-convert-subtask');
            if (confirmBtn) confirmBtn.disabled = true;
            _populateParentPicker(ticketId);
        });

        // Convert subtask modal close/cancel
        document.getElementById('btn-close-convert-subtask-modal')?.addEventListener('click', () => {
            const modal = document.getElementById('convert-subtask-modal');
            if (modal) modal.style.display = 'none';
        });
        document.getElementById('btn-cancel-convert-subtask')?.addEventListener('click', () => {
            const modal = document.getElementById('convert-subtask-modal');
            if (modal) modal.style.display = 'none';
        });
        document.getElementById('convert-subtask-modal')?.addEventListener('click', (e) => {
            if (e.target === e.currentTarget) {
                e.currentTarget.style.display = 'none';
            }
        });

        // Search input for parent picker
        document.getElementById('convert-subtask-search')?.addEventListener('input', () => {
            if (_convertCurrentTicketId) _populateParentPicker(_convertCurrentTicketId);
        });

        // Confirm conversion
        document.getElementById('btn-confirm-convert-subtask')?.addEventListener('click', () => {
            if (!_convertSelectedParentId || !_convertCurrentTicketId) return;
            vscode.postMessage({
                type: 'convertToSubtask',
                provider: lastIntegrationProvider,
                taskId: _convertCurrentTicketId,
                parentId: _convertSelectedParentId,
                workspaceRoot: ticketsWorkspaceRoot || undefined
            });
        });
    }

    function _isDescendantOf(candidateId, ancestorId, parentIdMap) {
        let current = parentIdMap.get(candidateId);
        while (current) {
            if (current === ancestorId) return true;
            current = parentIdMap.get(current);
        }
        return false;
    }

    function _populateParentPicker(currentTicketId) {
        const provider = lastIntegrationProvider;
        const issues = provider === 'linear' ? linearProjectIssues : clickUpProjectIssues;
        const listContainer = document.getElementById('convert-subtask-list');
        if (!listContainer) return;

        const searchInput = document.getElementById('convert-subtask-search');
        const searchTerm = String(searchInput?.value || '').trim().toLowerCase();

        if (!issues || issues.length === 0) {
            listContainer.innerHTML = '<div style="color: var(--text-secondary); padding: 8px;">No tickets available. Load a project first.</div>';
            return;
        }

        const parentIdMap = new Map();
        for (const item of issues) {
            if (item?.parentId) {
                parentIdMap.set(item.id, item.parentId);
            }
        }

        const candidates = issues.filter(item => {
            if (!item?.id || item.id === currentTicketId) return false;
            if (_isDescendantOf(item.id, currentTicketId, parentIdMap)) return false;
            if (searchTerm) {
                const haystack = [item.id, item.identifier, item.title].filter(Boolean).join(' ').toLowerCase();
                if (!haystack.includes(searchTerm)) return false;
            }
            return true;
        });

        if (candidates.length === 0) {
            listContainer.innerHTML = '<div style="color: var(--text-secondary); padding: 8px;">No matching tickets found.</div>';
            return;
        }

        listContainer.innerHTML = '';
        for (const candidate of candidates) {
            const row = document.createElement('div');
            row.style.cssText = 'padding: 6px 8px; cursor: pointer; border-radius: 3px; display: flex; align-items: center; gap: 6px;';
            row.dataset.parentId = candidate.id;
            const idLabel = candidate.identifier ? escapeHtml(candidate.identifier) : '';
            const titleText = escapeHtml(candidate.title || candidate.name || candidate.id);
            row.innerHTML = (idLabel ? '<span style="color: var(--text-secondary); font-size: 11px;">' + idLabel + '</span> ' : '') + '<span>' + titleText + '</span>';
            row.addEventListener('mouseenter', () => { if (row.dataset.selected !== 'true') row.style.background = 'var(--panel-bg2, #1a1a2e)'; });
            row.addEventListener('mouseleave', () => { if (row.dataset.selected !== 'true') row.style.background = ''; });
            row.addEventListener('click', () => {
                const prevSelected = listContainer.querySelector('[data-selected="true"]');
                if (prevSelected) { prevSelected.dataset.selected = 'false'; prevSelected.style.background = ''; }
                row.dataset.selected = 'true';
                row.style.background = 'var(--accent-teal, #2dd4bf)';
                _convertSelectedParentId = candidate.id;
                const confirmBtn = document.getElementById('btn-confirm-convert-subtask');
                if (confirmBtn) confirmBtn.disabled = false;
            });
            listContainer.appendChild(row);
        }
    }

    // ===== RENDERING FUNCTIONS =====

    function enterTicketsEditMode() {
        const provider = lastIntegrationProvider;
        const issue = provider === 'linear' ? selectedLinearIssue : selectedClickUpIssue;
        if (!issue) return;
        ticketsEditMode = true;
        const task = provider === 'linear' ? issue.issue : issue.task;
        const descHtml = issue.renderedDescriptionHtml || '';
        // Edit RAW markdown so headings/lists can actually be restructured.
        // Fall back to converting the rendered HTML only if we have no source markdown.
        const descMarkdown = (issue.descriptionMarkdown !== undefined && issue.descriptionMarkdown !== null)
            ? issue.descriptionMarkdown
            : htmlToMarkdown(descHtml);
        _ticketsEditBackupHtml = descHtml;

        document.getElementById('btn-edit-ticket').style.display = 'none';
        document.getElementById('btn-push-ticket').style.display = 'none';
        document.getElementById('btn-delete-ticket').style.display = 'none';
        document.getElementById('btn-save-ticket-edit').style.display = '';
        document.getElementById('btn-cancel-ticket-edit').style.display = '';

        const detailContent = document.getElementById('tickets-detail-content');
        if (!detailContent) return;

        const comments = issue.comments || [];
        const attachments = issue.attachments || [];
        let html = `<h1 id="ticket-edit-title" contenteditable="true" spellcheck="true" style="border:1px solid var(--border-color);outline:none;border-radius:4px;padding:4px 8px;">${escapeHtml(task.title || task.identifier || task.id)}</h1>`;
        html += `<textarea id="ticket-edit-description" spellcheck="true" style="width:100%;box-sizing:border-box;outline:none;border:none;padding:16px;min-height:480px;line-height:1.6;font-family:var(--vscode-editor-font-family,monospace);font-size:13px;resize:vertical;background:var(--panel-bg);color:var(--text-primary,#ddd);">${escapeHtml(descMarkdown)}</textarea>`;

        if (comments.length > 0) {
            html += '<h3 style="user-select:none;">Comments</h3>';
            html += comments.map(comment => `
                <div class="tickets-comment-item">
                    <span class="tickets-comment-author">${escapeHtml(commentAuthorName(comment))}</span>
                    <span class="tickets-comment-date">${escapeHtml(formatCommentDate(commentDateRaw(comment)))}</span>
                    <div class="tickets-comment-body">${escapeHtml(commentBodyText(comment)).replace(/\n/g, '<br>')}</div>
                </div>
            `).join('');
        }
        if (attachments.length > 0) {
            html += '<h3 style="user-select:none;">Attachments</h3>';
            html += attachments.map(a => `<button type="button" class="tickets-attachment-item" data-clickup-attachment-url="${escapeAttr(a.url || '')}">${escapeHtml(a.title || a.filename || a.url || 'Attachment')}</button>`).join('');
        }

        _lastTicketsClickUpDetailContentHtml = '';
        _lastTicketsDetailContentHtml = '';
        detailContent.innerHTML = html;
        document.getElementById('ticket-edit-description')?.focus();
    }

    function exitTicketsEditMode() {
        ticketsEditMode = false;
        _ticketsEditBackupHtml = null;
        document.getElementById('btn-edit-ticket').style.display = '';
        document.getElementById('btn-push-ticket').style.display = '';
        document.getElementById('btn-delete-ticket').style.display = '';
        document.getElementById('btn-save-ticket-edit').style.display = 'none';
        document.getElementById('btn-cancel-ticket-edit').style.display = 'none';
        _lastTicketsClickUpDetailContentHtml = '';
        _lastTicketsDetailContentHtml = '';
        renderTicketsTab();
    }

    function renderTicketsTab() {
        if (!isTicketsTabActive()) return;

        if (lastIntegrationProvider === 'linear') {
            renderTicketsLinearPanel();
        } else if (lastIntegrationProvider === 'clickup') {
            renderTicketsClickUpPanel();
        } else {
            // No integration configured — disable create button
            const { createButton } = getTicketsTabElements();
            if (createButton) {
                createButton.disabled = true;
                createButton.title = 'Configure an integration in Setup first';
            }
        }
    }

    function renderTicketsLinearPanel() {
        if (lastIntegrationProvider !== 'linear' || !isTicketsTabActive()) return;

        const { searchInput, projectPicker, stateFilter, clickUpStatusFilter, refreshButton, emptyPreview, createButton, hierarchyNav } = getTicketsTabElements();

        // Show Linear toolbar elements
        if (searchInput) searchInput.style.display = '';
        if (projectPicker) projectPicker.style.display = '';
        if (stateFilter) stateFilter.style.display = '';
        if (clickUpStatusFilter) clickUpStatusFilter.style.display = 'none';
        if (refreshButton) refreshButton.style.display = '';
        if (hierarchyNav) hierarchyNav.style.display = 'none';

        if (createButton) {
            createButton.disabled = false;
            createButton.title = 'Create New Ticket';
        }

        renderTicketsLinearStateFilterOptions();
        renderTicketsLinearProjectPickerOptions();

        const loadingState = document.getElementById('tickets-loading-state');
        const markdownPreview = document.getElementById('markdown-preview-tickets');
        if (linearProjectStatus === 'loading') {
            if (loadingState) loadingState.style.display = 'flex';
            if (markdownPreview) markdownPreview.style.display = 'none';
        } else {
            if (loadingState) loadingState.style.display = 'none';
            if (markdownPreview) markdownPreview.style.display = '';
            const hasSelected = !!selectedLinearIssue;
            if (emptyPreview) emptyPreview.style.display = hasSelected ? 'none' : '';
        }

        renderTicketsLinearList();
        renderTicketsLinearTaskDetail();
        updateTicketsSourceSummary();
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

    function renderAttachmentsList(attachments) {
        const { attachmentsList } = getTicketsTabElements();
        if (!attachmentsList) return;

        if (!attachments || attachments.length === 0) {
            attachmentsList.innerHTML = '<div class="empty-state">No attachments found.</div>';
            return;
        }

        let html = '';
        attachments.forEach(att => {
            const { filename, url, localPath, isDownloaded } = att;
            html += `
                <div class="attachment-row" style="display: flex; flex-direction: column; gap: 4px; padding: 8px; border-bottom: 1px solid var(--border-color); background: var(--panel-bg2, #1e1e1e); border-radius: 4px; margin-bottom: 6px;">
                    <div style="display: flex; align-items: center; justify-content: space-between; gap: 8px;">
                        <span style="font-weight: 500; font-size: 12px; word-break: break-all; color: var(--text-primary);">${escapeHtml(filename)}</span>
                        <div style="display: flex; gap: 6px; flex-shrink: 0;">
            `;

            if (isDownloaded) {
                html += `
                            <button class="strip-btn open-attachment-btn" data-local-path="${escapeAttr(localPath)}" style="font-size: 11px; padding: 2px 6px;">Open</button>
                            <button class="strip-btn reveal-attachment-btn" data-local-path="${escapeAttr(localPath)}" style="font-size: 11px; padding: 2px 6px;">Reveal</button>
                `;
            } else {
                html += `
                            <button class="strip-btn download-attachment-modal-btn" data-url="${escapeAttr(url)}" data-filename="${escapeAttr(filename)}" style="font-size: 11px; padding: 2px 6px; background: var(--accent-teal, #00ffcc); color: black;">Download</button>
                `;
            }

            html += `
                        </div>
                    </div>
            `;

            if (isDownloaded) {
                html += `
                    <div style="font-size: 10px; color: var(--text-secondary); word-break: break-all; margin-top: 2px;">
                        Path: ${escapeHtml(localPath)}
                    </div>
                `;
            }

            html += `
                </div>
            `;
        });

        attachmentsList.innerHTML = html;

        // Add event listeners to the newly rendered buttons
        attachmentsList.querySelectorAll('.open-attachment-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const localPath = btn.dataset.localPath;
                vscode.postMessage({
                    type: 'openAttachment',
                    workspaceRoot: ticketsWorkspaceRoot,
                    localPath
                });
            });
        });

        attachmentsList.querySelectorAll('.reveal-attachment-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const localPath = btn.dataset.localPath;
                vscode.postMessage({
                    type: 'revealAttachment',
                    workspaceRoot: ticketsWorkspaceRoot,
                    localPath
                });
            });
        });

        attachmentsList.querySelectorAll('.download-attachment-modal-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const url = btn.dataset.url;
                const filename = btn.dataset.filename;
                const provider = lastIntegrationProvider;
                const ticketId = provider === 'linear' ? selectedLinearIssue?.issue?.id : selectedClickUpIssue?.task?.id;
                const ticketTitle = provider === 'linear' ? selectedLinearIssue?.issue?.title : selectedClickUpIssue?.task?.title;
                vscode.postMessage({
                    type: 'downloadAttachment',
                    workspaceRoot: ticketsWorkspaceRoot,
                    provider,
                    url,
                    filename,
                    ticketId,
                    ticketTitle
                });
            });
        });
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

    // Maps a ticket status/state name to a status-light colour. Used for the
    // top-right indicator on every sidebar ticket card. Always returns a colour
    // so the light shows for all tickets (live or local-only).
    function _ticketStatusLightColor(status) {
        const s = String(status || '').toLowerCase();
        if (!s) { return '#8a8a8a'; }
        if (/(done|complete|closed|resolved|merged|shipped|deployed|archived|live)/.test(s)) { return '#3fb950'; }
        if (/(review|qa|testing|verify|approval)/.test(s)) { return '#a371f7'; }
        if (/(progress|doing|active|started|develop|dev|wip|implement|build)/.test(s)) { return '#4ea7fc'; }
        if (/(block|hold|stuck|waiting|paused|cancel)/.test(s)) { return '#f85149'; }
        if (/(backlog|todo|to do|open|created|new|triage|planned|ready)/.test(s)) { return '#d29922'; }
        return '#8a8a8a';
    }

    // Resolves the external URL for a ticket so the "Open" action works for every
    // ticket, including local-only ones (which carry no API url). ClickUp URLs are
    // deterministic from the task id; Linear requires the API-provided url.
    function _ticketExternalUrl(provider, id, existingUrl) {
        if (existingUrl) { return existingUrl; }
        if (provider === 'clickup' && id) { return `https://app.clickup.com/t/${id}`; }
        return '';
    }

    // Builds the sync-status badge shown bottom-left on each card. Renders for all
    // states (synced / modified / local-only) so it's present on every card.
    function _ticketSyncBadge(syncStatus) {
        if (syncStatus === 'modified') { return `<span class="ticket-sync-badge ticket-sync-modified">modified</span>`; }
        if (syncStatus === 'synced') { return `<span class="ticket-sync-badge ticket-sync-synced">synced</span>`; }
        return `<span class="ticket-sync-badge ticket-sync-local">local</span>`;
    }

    function renderTicketsLinearList() {
        if (!isTicketsTabActive()) return;

        const { emptyState, issuesContainer, searchInput } = getTicketsTabElements();
        if (!emptyState || !issuesContainer) return;

        const importAllKanbanButton = document.getElementById('tickets-import-all-kanban');
        if (importAllKanbanButton) importAllKanbanButton.style.display = linearProjectStatus === 'loaded' ? '' : 'none';

        if (searchInput && searchInput.value !== linearProjectSearchValue) {
            searchInput.value = linearProjectSearchValue;
        }

        if (linearProjectStatus === 'loading') {
            emptyState.style.display = 'none';
            const skeletonHtml = '<div class="sidebar-skeleton"></div><div class="sidebar-skeleton"></div><div class="sidebar-skeleton"></div><div class="sidebar-skeleton" style="width: 60%;"></div>';
            if (_lastTicketsIssuesContainerHtml !== skeletonHtml) {
                issuesContainer.innerHTML = skeletonHtml;
                _lastTicketsIssuesContainerHtml = skeletonHtml;
            }
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
            const isSelected = selectedLinearIssue && selectedLinearIssue.issue.id === issue.id;
            const syncBadge = _ticketSyncBadge(issue.syncStatus);
            const statusName = issue.state?.name || '';
            const statusColor = issue.state?.color || _ticketStatusLightColor(statusName);
            const statusLight = `<span class="ticket-status-light" style="background:${escapeAttr(statusColor)}" title="${escapeAttr(statusName || 'No status')}"></span>`;
            return `
            <div class="ticket-node${isSelected ? ' selected' : ''}" data-linear-issue-id="${escapeAttr(issue.id)}">
                ${statusLight}
                <div class="tickets-issue-title">${escapeHtml(issue.title || issue.identifier || issue.id)}</div>
                <div class="tickets-issue-meta">${escapeHtml(issue.state?.name || 'Unknown state')}</div>
                <div class="tickets-issue-meta">${escapeHtml(issue.assignee?.name || issue.assignee?.email || 'Unassigned')}</div>
                <div class="tickets-issue-meta">${escapeHtml((issue.description || '').trim().slice(0, 180) || 'No description provided.')}</div>
                <div class="card-actions">
                    ${syncBadge}
                    <button type="button" class="card-icon-btn" data-import-plan-id="${escapeAttr(issue.id)}" data-provider="linear">Add to kanban</button>
                    <button type="button" class="card-icon-btn" data-link-ticket-id="${escapeAttr(issue.id)}" data-provider="linear">Link to ticket</button>
                    <button type="button" class="card-icon-btn" data-refine-ticket-id="${escapeAttr(issue.id)}" data-provider="linear">Refine</button>
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
        if (!isTicketsTabActive() || ticketsEditMode) return;

        const { subtasksNav, detailContent, previewMetaBar, commentInputArea } = getTicketsTabElements();
        if (!detailContent) return;

        if (!selectedLinearIssue) {
            if (subtasksNav) {
                if (_lastTicketsLinearSubtasksNavHtml !== '') {
                    subtasksNav.innerHTML = '';
                    _lastTicketsLinearSubtasksNavHtml = '';
                }
                subtasksNav.style.display = 'none';
            }
            if (_lastTicketsDetailContentHtml !== '') { detailContent.innerHTML = ''; _lastTicketsDetailContentHtml = ''; }
            if (_lastTicketsLinearStatusSelectHtml !== '') {
                const statusSelect = document.getElementById('select-status-ticket');
                if (statusSelect) statusSelect.innerHTML = '';
                _lastTicketsLinearStatusSelectHtml = '';
            }
            if (previewMetaBar) previewMetaBar.style.display = 'none';
            const _delModal = document.getElementById('tickets-delete-modal');
            if (_delModal) _delModal.style.display = 'none';
            _pendingDeleteTicket = null;
            if (commentInputArea) commentInputArea.style.display = 'none';
            const tagsButton = document.getElementById('tickets-tags');
            if (tagsButton) tagsButton.disabled = true;
            renderTicketTags([], 'linear');
            return;
        }

        const issue = selectedLinearIssue.issue;
        const tagsButton = document.getElementById('tickets-tags');
        if (tagsButton) tagsButton.disabled = false;
        currentTicketTags = issue.labels || [];
        renderTicketTags(currentTicketTags, 'linear');

        if (previewMetaBar) {
            previewMetaBar.style.display = 'flex';
            const { btnViewAttachments, btnOpenTicket, btnDiagramPrompt } = getTicketsTabElements();
            if (btnViewAttachments) {
                const hasAttachments = selectedLinearIssue.attachments && selectedLinearIssue.attachments.length > 0;
                btnViewAttachments.style.display = hasAttachments ? '' : 'none';
            }
            if (btnOpenTicket) {
                const openUrl = _ticketExternalUrl('linear', issue.identifier || issue.id, issue.url);
                btnOpenTicket.style.display = openUrl ? '' : 'none';
                btnOpenTicket.dataset.url = openUrl;
            }
            if (btnDiagramPrompt) {
                btnDiagramPrompt.style.display = '';
            }
            const statusSelect = document.getElementById('select-status-ticket');
            if (statusSelect) {
                let newHtml = '';
                if (availableLinearStates.length > 0) {
                    newHtml = availableLinearStates
                        .map(s => `<option value="${escapeAttr(s.id)}">${escapeHtml(s.name)}</option>`)
                        .join('');
                } else {
                    const stateMap = new Map();
                    linearProjectIssues.forEach(i => {
                        if (i.state && i.state.id && i.state.name) {
                            stateMap.set(i.state.name, i.state.id);
                        }
                    });
                    newHtml = Array.from(stateMap.entries())
                        .map(([name, id]) => `<option value="${escapeAttr(id)}">${escapeHtml(name)}</option>`)
                        .join('');
                }

                if (_lastTicketsLinearStatusSelectHtml !== newHtml) {
                    statusSelect.innerHTML = newHtml;
                    _lastTicketsLinearStatusSelectHtml = newHtml;
                }

                if (availableLinearStates.length > 0) {
                    if (issue.state && issue.state.id) {
                        statusSelect.value = issue.state.id;
                    } else if (issue.state && issue.state.name) {
                        const matched = availableLinearStates.find(s => s.name === issue.state.name);
                        if (matched) statusSelect.value = matched.id;
                    }
                } else {
                    const stateMap = new Map();
                    linearProjectIssues.forEach(i => {
                        if (i.state && i.state.id && i.state.name) {
                            stateMap.set(i.state.name, i.state.id);
                        }
                    });
                    if (issue.state && issue.state.id) {
                        statusSelect.value = issue.state.id;
                    } else if (issue.state && issue.state.name) {
                        const matchedId = stateMap.get(issue.state.name);
                        if (matchedId) statusSelect.value = matchedId;
                    }
                }
            }
        }

        if (subtasksNav) {
            const subtasks = selectedLinearIssue.subtasks;
            if (subtasks && subtasks.length > 0) {
                let navHtml = '<div class="subtasks-header">Subtasks</div>';
                navHtml += '<div style="display: flex; flex-direction: column; gap: 4px;">';
                subtasks.forEach(subtask => {
                    navHtml += `<div class="subtask-nav-item" data-subtask-id="${escapeAttr(subtask.id)}" data-provider="linear">
                        <span>${escapeHtml(subtask.title || subtask.identifier || subtask.id)}</span>
                        <span class="subtask-nav-status">${escapeHtml(subtask.state?.name || 'Unknown')}</span>
                    </div>`;
                });
                navHtml += '</div>';
                if (_lastTicketsLinearSubtasksNavHtml !== navHtml) {
                    subtasksNav.innerHTML = navHtml;
                    _lastTicketsLinearSubtasksNavHtml = navHtml;
                }
                subtasksNav.style.display = '';
            } else {
                if (_lastTicketsLinearSubtasksNavHtml !== '') {
                    subtasksNav.innerHTML = '';
                    _lastTicketsLinearSubtasksNavHtml = '';
                }
                subtasksNav.style.display = 'none';
            }
        }

        let contentHtml = `<h1>${escapeHtml(issue.title || issue.identifier || issue.id)}</h1>`;

        if (selectedLinearIssue.renderedDescriptionHtml) {
            contentHtml += selectedLinearIssue.renderedDescriptionHtml;
        } else {
            contentHtml += `<p>${escapeHtml((issue.description || '').trim() || 'No description provided.').replace(/\n/g, '<br>')}</p>`;
        }

        if (selectedLinearIssue.comments && selectedLinearIssue.comments.length > 0) {
            contentHtml += '<h3>Comments</h3>';
            contentHtml += selectedLinearIssue.comments.map(comment => `
                <div class="tickets-comment-item">
                    <span class="tickets-comment-author">${escapeHtml(commentAuthorName(comment))}</span>
                    <span class="tickets-comment-date">${escapeHtml(formatCommentDate(commentDateRaw(comment)))}</span>
                    <div class="tickets-comment-body">${escapeHtml(commentBodyText(comment)).replace(/\n/g, '<br>')}</div>
                </div>
            `).join('');
        }

        if (selectedLinearIssue.attachments && selectedLinearIssue.attachments.length > 0) {
            contentHtml += '<h3>Attachments</h3>';
            contentHtml += selectedLinearIssue.attachments.map(attachment => `
                <button type="button" class="tickets-attachment-item" data-linear-attachment-url="${escapeAttr(attachment.url || '')}">
                    ${escapeHtml(attachment.title || attachment.filename || attachment.url || 'Attachment')}
                </button>
            `).join('');
        }

        if (_lastTicketsDetailContentHtml !== contentHtml) {
            detailContent.innerHTML = contentHtml;
            _lastTicketsDetailContentHtml = contentHtml;
        }
    }

    // ===== CLICKUP RENDERING FUNCTIONS =====

    function renderTicketsClickUpPanel() {
        if (lastIntegrationProvider !== 'clickup' || !isTicketsTabActive()) return;

        const { searchInput, projectPicker, stateFilter, clickUpStatusFilter, refreshButton, emptyState, issuesContainer, hierarchyNav, emptyPreview, createButton } = getTicketsTabElements();

        // Hide Linear toolbar elements, show ClickUp hierarchy
        if (searchInput) searchInput.style.display = '';
        if (projectPicker) projectPicker.style.display = 'none';
        if (stateFilter) stateFilter.style.display = 'none';
        if (clickUpStatusFilter) {
            clickUpStatusFilter.style.display = (clickUpSelectedListId || clickUpProjectIssues.length > 0) ? '' : 'none';
        }
        if (refreshButton) refreshButton.style.display = '';
        if (hierarchyNav) hierarchyNav.style.display = '';

        if (createButton) {
            if (clickUpSelectedListId) {
                createButton.disabled = false;
                createButton.title = 'Create New Ticket';
            } else {
                createButton.disabled = true;
                createButton.title = 'Select a list first';
            }
        }

        const importAsPlansBtn = document.getElementById('tickets-import-all-kanban');
        if (importAsPlansBtn) importAsPlansBtn.style.display = clickUpSelectedListId ? '' : 'none';

        if (emptyState) {
            if (!clickUpSelectedListId && clickUpProjectIssues.length === 0) {
                emptyState.textContent = 'No list selected. Please select a Space, Folder, and List to view tasks.';
                emptyState.style.display = '';
            } else if (clickUpProjectStatus !== 'loaded' && clickUpProjectIssues.length === 0) {
                emptyState.textContent = clickUpProjectMessage || 'Loading tasks...';
                emptyState.style.display = '';
            } else {
                emptyState.style.display = 'none';
            }
        }

        if (lastIntegrationProvider === 'clickup') {
            renderTicketsClickUpHierarchyNav();
        }

        if (clickUpSelectedListId || clickUpProjectIssues.length > 0) {
            renderTicketsClickUpStatusFilterOptions();
            renderTicketsClickUpList();
        } else {
            if (issuesContainer) {
                issuesContainer.innerHTML = '';
            }
        }

        renderTicketsClickUpTaskDetail();

        const loadingState = document.getElementById('tickets-loading-state');
        const markdownPreview = document.getElementById('markdown-preview-tickets');
        if (clickUpProjectStatus === 'loading') {
            if (loadingState) loadingState.style.display = 'flex';
            if (markdownPreview) markdownPreview.style.display = 'none';
        } else {
            if (loadingState) loadingState.style.display = 'none';
            if (markdownPreview) markdownPreview.style.display = '';
            const hasSelected = !!selectedClickUpIssue;
            if (emptyPreview) emptyPreview.style.display = hasSelected ? 'none' : '';
        }
        updateTicketsSourceSummary();
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
        const spaceOptions = clickUpAvailableSpaces.map(s => 
            `<option value="${escapeAttr(s.id)}" ${s.id === clickUpSelectedSpaceId ? 'selected' : ''}>${escapeHtml(s.name)}</option>`
        ).join('');

        const folderOptions = clickUpAvailableFolders.map(f => 
            `<option value="${escapeAttr(f.id)}" ${f.id === clickUpSelectedFolderId ? 'selected' : ''}>${escapeHtml(f.name)}</option>`
        ).join('');

        const availableLists = clickUpSelectedFolderId
            ? clickUpAvailableListsInFolder
            : clickUpAvailableDirectLists;

        const listOptions = availableLists.map(l => 
            `<option value="${escapeAttr(l.id)}" ${l.id === clickUpSelectedListId ? 'selected' : ''}>${escapeHtml(l.name)} ${l.taskCount ? `(${l.taskCount})` : ''}</option>`
        ).join('');

        const spaceDisabled = clickUpHierarchyLoading ? 'disabled' : '';
        const folderDisabled = (!clickUpSelectedSpaceId || clickUpHierarchyLoading) ? 'disabled' : '';
        const listDisabled = (!clickUpSelectedSpaceId || clickUpHierarchyLoading) ? 'disabled' : '';

        return `
            <div class="tickets-hierarchy-nav" style="display:flex; gap:8px; align-items:center; width:100%;">
                <select id="tickets-space-select" class="planning-select" ${spaceDisabled} style="flex: 1; max-width: 200px;">
                    <option value="">Select Space...</option>
                    ${spaceOptions}
                </select>
                <select id="tickets-folder-select" class="planning-select" ${folderDisabled} style="flex: 1; max-width: 200px;">
                    <option value="">Select Folder...</option>
                    <option value="_root_" ${clickUpSelectedFolderId === '' && clickUpSelectedSpaceId ? 'selected' : ''}>(Root - Lists not in any Folder)</option>
                    ${folderOptions}
                </select>
                <select id="tickets-list-select" class="planning-select" ${listDisabled} style="flex: 1; max-width: 200px;">
                    <option value="">Select List...</option>
                    ${listOptions}
                </select>
            </div>
        `;
    }

    function attachTicketsHierarchyListeners() {
        const spaceSelect = document.getElementById('tickets-space-select');
        spaceSelect?.addEventListener('change', (e) => {
            _restoringClickUpHierarchy = false;
            const spaceId = e.target.value;
            clickUpSelectedSpaceId = spaceId;
            clickUpSelectedFolderId = '';
            clickUpSelectedListId = '';
            clickUpAvailableFolders = [];
            clickUpAvailableListsInFolder = [];
            clickUpAvailableDirectLists = [];
            clickUpProjectIssues = [];
            if (spaceId) {
                clickUpHierarchyLoading = true;
                renderTicketsClickUpPanel();
                saveTicketsState();
                const spaceName = clickUpAvailableSpaces.find(s => s.id === spaceId)?.name || '';
                vscode.postMessage({
                    type: 'clickupSaveSpaceSelection',
                    spaceId,
                    spaceName,
                    workspaceRoot: ticketsWorkspaceRoot || undefined
                });
                vscode.postMessage({
                    type: 'clickupLoadFolders',
                    spaceId,
                    workspaceRoot: ticketsWorkspaceRoot || undefined
                });
                vscode.postMessage({
                    type: 'clickupLoadSpaceTags',
                    spaceId,
                    workspaceRoot: ticketsWorkspaceRoot || undefined
                });
            } else {
                clickUpHierarchyLoading = false;
                renderTicketsClickUpPanel();
                saveTicketsState();
                vscode.postMessage({
                    type: 'clickupSaveSpaceSelection',
                    spaceId: '',
                    spaceName: '',
                    workspaceRoot: ticketsWorkspaceRoot || undefined
                });
            }
        });

        const folderSelect = document.getElementById('tickets-folder-select');
        folderSelect?.addEventListener('change', (e) => {
            _restoringClickUpHierarchy = false;
            const folderId = e.target.value;
            clickUpSelectedListId = '';
            clickUpAvailableListsInFolder = [];
            clickUpProjectIssues = [];
            if (folderId) {
                clickUpSelectedFolderId = folderId === '_root_' ? '' : folderId;
                clickUpHierarchyLoading = true;
                renderTicketsClickUpPanel();
                saveTicketsState();
                const folderName = folderId === '_root_' ? '' : (clickUpAvailableFolders.find(f => f.id === folderId)?.name || '');
                vscode.postMessage({
                    type: 'clickupSaveFolderSelection',
                    folderId: clickUpSelectedFolderId,
                    folderName,
                    workspaceRoot: ticketsWorkspaceRoot || undefined
                });
                if (folderId === '_root_') {
                    vscode.postMessage({
                        type: 'clickupLoadLists',
                        spaceId: clickUpSelectedSpaceId,
                        folderId: '',
                        workspaceRoot: ticketsWorkspaceRoot || undefined
                    });
                } else {
                    vscode.postMessage({
                        type: 'clickupLoadLists',
                        spaceId: clickUpSelectedSpaceId,
                        folderId: clickUpSelectedFolderId,
                        workspaceRoot: ticketsWorkspaceRoot || undefined
                    });
                }
            } else {
                clickUpSelectedFolderId = '';
                clickUpHierarchyLoading = false;
                renderTicketsClickUpPanel();
                saveTicketsState();
                vscode.postMessage({
                    type: 'clickupSaveFolderSelection',
                    folderId: '',
                    folderName: '',
                    workspaceRoot: ticketsWorkspaceRoot || undefined
                });
            }
        });

        const listSelect = document.getElementById('tickets-list-select');
        listSelect?.addEventListener('change', (e) => {
            _restoringClickUpHierarchy = false;
            const listId = e.target.value;
            clickUpSelectedListId = listId;
            clickUpProjectLoading = false;
            clickUpProjectIssues = [];
            saveTicketsState();
            if (listId) {
                const spaceName = clickUpAvailableSpaces.find(s => s.id === clickUpSelectedSpaceId)?.name || '';
                const folderName = clickUpAvailableFolders.find(f => f.id === clickUpSelectedFolderId)?.name || '';
                const availableLists = clickUpSelectedFolderId ? clickUpAvailableListsInFolder : clickUpAvailableDirectLists;
                const listName = availableLists.find(l => l.id === listId)?.name || '';
                vscode.postMessage({
                    type: 'clickupSaveListSelection',
                    spaceId: clickUpSelectedSpaceId,
                    spaceName,
                    folderId: clickUpSelectedFolderId,
                    folderName,
                    listId,
                    listName,
                    workspaceRoot: ticketsWorkspaceRoot || undefined
                });
                loadClickUpProject(false, listId);
            } else {
                renderTicketsClickUpPanel();
            }
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
                saveTicketsState();
            };
        }
    }

    function getFilteredClickUpTasks() {
        const search = String(clickUpProjectSearchValue || '').trim().toLowerCase();
        const statusFilter = String(clickUpProjectStatusFilterValue || '').trim();
        return clickUpProjectIssues.filter(task => {
            if (task?.parentId) return false;
            if (statusFilter && task.status !== statusFilter) return false;
            if (!search) return true;
            const haystack = [
                task.id,
                task.identifier,
                task.title,
                task.description,
                task.assignees?.map(a => a.username || a.email).join(' ')
            ].join('\n').toLowerCase();
            return haystack.includes(search);
        });
    }

    function renderTicketsClickUpList() {
        if (!isTicketsTabActive()) return;

        const { issuesContainer, emptyState, loadMoreButton, searchInput } = getTicketsTabElements();
        if (!issuesContainer) return;

        if (searchInput && searchInput.value !== clickUpProjectSearchValue) {
            searchInput.value = clickUpProjectSearchValue;
        }

        if (clickUpProjectStatus === 'loading') {
            if (emptyState) emptyState.style.display = 'none';
            const skeletonHtml = '<div class="sidebar-skeleton"></div><div class="sidebar-skeleton"></div><div class="sidebar-skeleton"></div><div class="sidebar-skeleton" style="width: 60%;"></div>';
            if (_lastTicketsClickUpIssuesContainerHtml !== skeletonHtml) {
                issuesContainer.innerHTML = skeletonHtml;
                _lastTicketsClickUpIssuesContainerHtml = skeletonHtml;
            }
            return;
        }

        if (emptyState) emptyState.style.display = 'none';

        const tasks = getFilteredClickUpTasks();
        const html = tasks.length === 0
            ? `<div class="empty-state">No tasks found.</div>`
            : tasks.map(task => {
                const isSelected = selectedClickUpIssue && selectedClickUpIssue.task.id === task.id;
                const syncBadge = _ticketSyncBadge(task.syncStatus);
                const statusName = task.status || '';
                const statusColor = task.statusColor || _ticketStatusLightColor(statusName);
                const statusLight = `<span class="ticket-status-light" style="background:${escapeAttr(statusColor)}" title="${escapeAttr(statusName || 'No status')}"></span>`;
                return `
                <div class="ticket-node${isSelected ? ' selected' : ''}" data-clickup-task-id="${escapeAttr(task.id)}">
                    ${statusLight}
                    <div class="tickets-issue-title">${escapeHtml(task.title || task.identifier)}</div>
                    <div class="tickets-issue-meta">${escapeHtml(task.status || 'Unknown')}</div>
                    <div class="tickets-issue-meta">${task.assignees?.length ? escapeHtml(task.assignees.map(a => a.username || a.email).join(', ')) : 'Unassigned'}</div>
                    <div class="card-actions">
                        ${syncBadge}
                        <button type="button" class="card-icon-btn" data-import-plan-id="${escapeAttr(task.id)}" data-provider="clickup">Add to kanban</button>
                        <button type="button" class="card-icon-btn" data-link-ticket-id="${escapeAttr(task.id)}" data-provider="clickup">Link to ticket</button>
                        <button type="button" class="card-icon-btn" data-refine-ticket-id="${escapeAttr(task.id)}" data-provider="clickup">Refine</button>
                    </div>
                </div>
                `;
            }).join('');

        if (_lastTicketsClickUpIssuesContainerHtml !== html) {
            issuesContainer.innerHTML = html;
            _lastTicketsClickUpIssuesContainerHtml = html;
        }

        if (loadMoreButton) {
            loadMoreButton.style.display = clickUpProjectHasMore ? '' : 'none';
        }
    }

    function renderTicketsClickUpTaskDetail() {
        if (!isTicketsTabActive() || ticketsEditMode) return;

        const { subtasksNav, detailContent, previewMetaBar, commentInputArea } = getTicketsTabElements();
        if (!detailContent) return;

        if (!selectedClickUpIssue) {
            if (subtasksNav) {
                if (_lastTicketsClickUpSubtasksNavHtml !== '') {
                    subtasksNav.innerHTML = '';
                    _lastTicketsClickUpSubtasksNavHtml = '';
                }
                subtasksNav.style.display = 'none';
            }
            if (_lastTicketsClickUpDetailContentHtml !== '') { detailContent.innerHTML = ''; _lastTicketsClickUpDetailContentHtml = ''; }
            if (_lastTicketsClickUpStatusSelectHtml !== '') {
                const statusSelect = document.getElementById('select-status-ticket');
                if (statusSelect) statusSelect.innerHTML = '';
                _lastTicketsClickUpStatusSelectHtml = '';
            }
            if (previewMetaBar) previewMetaBar.style.display = 'none';
            const _delModal = document.getElementById('tickets-delete-modal');
            if (_delModal) _delModal.style.display = 'none';
            _pendingDeleteTicket = null;
            if (commentInputArea) commentInputArea.style.display = 'none';
            const tagsButton = document.getElementById('tickets-tags');
            if (tagsButton) tagsButton.disabled = true;
            renderTicketTags([], 'clickup');
            return;
        }

        const task = selectedClickUpIssue.task;
        const tagsButton = document.getElementById('tickets-tags');
        if (tagsButton) tagsButton.disabled = false;
        currentTicketTags = task.tags || [];
        renderTicketTags(currentTicketTags, 'clickup');

        if (previewMetaBar) {
            previewMetaBar.style.display = 'flex';
            const { btnViewAttachments, btnOpenTicket, btnDiagramPrompt } = getTicketsTabElements();
            if (btnViewAttachments) {
                const hasAttachments = selectedClickUpIssue.attachments && selectedClickUpIssue.attachments.length > 0;
                btnViewAttachments.style.display = hasAttachments ? '' : 'none';
            }
            if (btnOpenTicket) {
                const openUrl = _ticketExternalUrl('clickup', task.id, task.url);
                btnOpenTicket.style.display = openUrl ? '' : 'none';
                btnOpenTicket.dataset.url = openUrl;
            }
            if (btnDiagramPrompt) {
                btnDiagramPrompt.style.display = '';
            }
            const statusSelect = document.getElementById('select-status-ticket');
            if (statusSelect) {
                const statuses = availableClickUpStatuses.length > 0
                    ? availableClickUpStatuses.map(s => s.status)
                    : Array.from(new Set(clickUpProjectIssues.map(t => t.status || 'Unknown'))).sort();
                const newStatusHtml = statuses
                    .map(status => `<option value="${escapeAttr(status)}">${escapeHtml(status)}</option>`)
                    .join('');
                if (_lastTicketsClickUpStatusSelectHtml !== newStatusHtml) {
                    statusSelect.innerHTML = newStatusHtml;
                    _lastTicketsClickUpStatusSelectHtml = newStatusHtml;
                }
                if (task.status) {
                    statusSelect.value = task.status;
                }
            }
        }

        if (subtasksNav) {
            const subtasks = selectedClickUpIssue.subtasks;
            if (subtasks && subtasks.length > 0) {
                let navHtml = '<div class="subtasks-header">Subtasks</div>';
                navHtml += '<div style="display: flex; flex-direction: column; gap: 4px;">';
                subtasks.forEach(subtask => {
                    navHtml += `<div class="subtask-nav-item" data-subtask-id="${escapeAttr(subtask.id)}" data-provider="clickup">
                        <span>${escapeHtml(subtask.title || subtask.name || subtask.id)}</span>
                        <span class="subtask-nav-status">${escapeHtml(subtask.status || 'Unknown')}</span>
                    </div>`;
                });
                navHtml += '</div>';
                if (_lastTicketsClickUpSubtasksNavHtml !== navHtml) {
                    subtasksNav.innerHTML = navHtml;
                    _lastTicketsClickUpSubtasksNavHtml = navHtml;
                }
                subtasksNav.style.display = '';
            } else {
                if (_lastTicketsClickUpSubtasksNavHtml !== '') {
                    subtasksNav.innerHTML = '';
                    _lastTicketsClickUpSubtasksNavHtml = '';
                }
                subtasksNav.style.display = 'none';
            }
        }

        let contentHtml = `<h1>${escapeHtml(task.title || task.identifier || task.id)}</h1>`;

        if (selectedClickUpIssue.renderedDescriptionHtml) {
            contentHtml += selectedClickUpIssue.renderedDescriptionHtml;
        } else {
            contentHtml += `<p>${escapeHtml((task.markdownDescription || task.description || '').trim() || 'No description provided.').replace(/\n/g, '<br>')}</p>`;
        }

        if (selectedClickUpIssue.comments && selectedClickUpIssue.comments.length > 0) {
            contentHtml += '<h3>Comments</h3>';
            contentHtml += selectedClickUpIssue.comments.map(comment => `
                <div class="tickets-comment-item">
                    <span class="tickets-comment-author">${escapeHtml(commentAuthorName(comment))}</span>
                    <span class="tickets-comment-date">${escapeHtml(formatCommentDate(commentDateRaw(comment)))}</span>
                    <div class="tickets-comment-body">${escapeHtml(commentBodyText(comment)).replace(/\n/g, '<br>')}</div>
                </div>
            `).join('');
        }

        if (selectedClickUpIssue.attachments && selectedClickUpIssue.attachments.length > 0) {
            contentHtml += '<h3>Attachments</h3>';
            contentHtml += selectedClickUpIssue.attachments.map(attachment => `
                <button type="button" class="tickets-attachment-item" data-clickup-attachment-url="${escapeAttr(attachment.url || '')}">
                    ${escapeHtml(attachment.title || attachment.filename || attachment.url || 'Attachment')}
                </button>
            `).join('');
        }

        if (_lastTicketsClickUpDetailContentHtml !== contentHtml) {
            detailContent.innerHTML = contentHtml;
            _lastTicketsClickUpDetailContentHtml = contentHtml;
        }
    }

    // ===== LOAD FUNCTIONS =====

    function loadLinearProject(force = false) {
        if (linearProjectLoading && !force) return;
        linearProjectLoading = true;
        linearProjectStatus = 'loading';
        linearProjectMessage = 'Loading Linear project...';
        renderTicketsLinearPanel();
        vscode.postMessage({ type: 'linearLoadProject', workspaceRoot: ticketsWorkspaceRoot || undefined });
    }

    function loadLinearTaskDetails(issueId) {
        if (!issueId) return;
        selectedLinearIssue = null;
        renderTicketsLinearPanel();
        vscode.postMessage({ type: 'linearLoadTaskDetails', issueId, workspaceRoot: ticketsWorkspaceRoot || undefined });
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
            workspaceRoot: ticketsWorkspaceRoot || undefined,
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
            workspaceRoot: ticketsWorkspaceRoot || undefined,
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
            workspaceRoot: ticketsWorkspaceRoot || undefined
        });
    }

    function loadClickUpSpaces() {
        clickUpHierarchyLoading = true;
        renderTicketsClickUpPanel();
        vscode.postMessage({
            type: 'clickupLoadSpaces',
            workspaceRoot: ticketsWorkspaceRoot || undefined
        });
    }

    // ===== IMPORT/REFINE DELEGATION =====

    function handleTicketsImport(provider, id, includeSubtasks, mode) {
        vscode.postMessage({
            type: provider === 'clickup' ? 'clickupImportTask' : 'linearImportTask',
            workspaceRoot: ticketsWorkspaceRoot,
            [provider === 'clickup' ? 'taskId' : 'issueId']: id,
            includeSubtasks,
            mode
        });
    }

    function nodeToMarkdown(node) {
        if (node.nodeType === 3) return node.textContent; // TEXT_NODE
        if (node.nodeType !== 1) return ''; // not ELEMENT_NODE
        const tag = node.tagName.toLowerCase();
        const inner = () => Array.from(node.childNodes).map(nodeToMarkdown).join('');
        switch (tag) {
            case 'h1': return `# ${inner().trim()}\n\n`;
            case 'h2': return `## ${inner().trim()}\n\n`;
            case 'h3': return `### ${inner().trim()}\n\n`;
            case 'h4': return `#### ${inner().trim()}\n\n`;
            case 'h5': return `##### ${inner().trim()}\n\n`;
            case 'h6': return `###### ${inner().trim()}\n\n`;
            case 'p': return `${inner().trim()}\n\n`;
            case 'div': { const t = inner(); return t ? t + '\n' : ''; }
            case 'br': return '\n';
            case 'strong': case 'b': return `**${inner()}**`;
            case 'em': case 'i': return `*${inner()}*`;
            case 'del': case 's': return `~~${inner()}~~`;
            case 'code': {
                if (node.parentElement && node.parentElement.tagName.toLowerCase() === 'pre') return inner();
                return `\`${inner()}\``;
            }
            case 'pre': {
                const codeEl = node.querySelector('code');
                const lang = (codeEl && codeEl.className.replace('language-', '')) || '';
                const body = codeEl ? codeEl.textContent : inner();
                return `\`\`\`${lang}\n${body}\n\`\`\`\n\n`;
            }
            case 'a': return `[${inner()}](${node.getAttribute('href') || ''})`;
            case 'img': return `![${node.getAttribute('alt') || ''}](${node.getAttribute('src') || ''})`;
            case 'ul': return Array.from(node.children).filter(c => c.tagName === 'LI').map(li => `- ${nodeToMarkdown(li).trim()}\n`).join('') + '\n';
            case 'ol': return Array.from(node.children).filter(c => c.tagName === 'LI').map((li, i) => `${i + 1}. ${nodeToMarkdown(li).trim()}\n`).join('') + '\n';
            case 'li': return inner();
            case 'blockquote': return inner().split('\n').map(l => `> ${l}`).join('\n') + '\n\n';
            case 'hr': return '---\n\n';
            case 'table': {
                const rows = Array.from(node.querySelectorAll('tr'));
                if (!rows.length) return '';
                const cells = r => Array.from(r.querySelectorAll('th,td')).map(c => nodeToMarkdown(c).trim());
                const header = cells(rows[0]);
                let md = `| ${header.join(' | ')} |\n| ${header.map(() => '---').join(' | ')} |\n`;
                for (let i = 1; i < rows.length; i++) md += `| ${cells(rows[i]).join(' | ')} |\n`;
                return md + '\n';
            }
            default: return inner();
        }
    }

    function htmlToMarkdown(html) {
        const div = document.createElement('div');
        div.innerHTML = html;
        return nodeToMarkdown(div).replace(/\n{3,}/g, '\n\n').trim();
    }

    function flashCopyBtn(btn) {
        const originalText = btn.textContent;
        btn.textContent = 'Copied!';
        btn.classList.add('copied');
        btn.disabled = true;
        let fallbackTimer = null;
        const reset = () => {
            btn.textContent = originalText;
            btn.classList.remove('copied');
            btn.disabled = false;
            btn.removeEventListener('animationend', onEnd);
            if (fallbackTimer) { clearTimeout(fallbackTimer); fallbackTimer = null; }
        };
        const onEnd = () => { fallbackTimer = null; reset(); };
        btn.addEventListener('animationend', onEnd);
        fallbackTimer = setTimeout(reset, 2000);
    }

    function flashIconBtn(btn) {
        btn.classList.remove('flash');
        void btn.offsetWidth;
        btn.classList.add('flash');
        btn.addEventListener('animationend', () => btn.classList.remove('flash'), { once: true });
    }

    function handleLinkToTicket(provider, id, btn) {
        // Use the exact same message/handler as the "Link all" button, just scoped
        // to a single ticket id, so both buttons share one proven code path.
        vscode.postMessage({ type: 'copyToClipboard', provider, workspaceRoot: ticketsWorkspaceRoot, ticketIds: [id] });
        if (btn) { _lastLinkTicketBtn = btn; }
    }

    function handleTicketsAskAgent(provider, id) {
        if (!provider || !id) return;
        let title = '';
        let description = '';
        if (provider === 'linear') {
            const issue = linearProjectIssues.find(i => i.id === id);
            if (issue) {
                title = issue.title || issue.identifier || '';
                description = issue.description || '';
            }
        } else if (provider === 'clickup') {
            const task = clickUpProjectIssues.find(t => t.id === id);
            if (task) {
                title = task.title || task.identifier || '';
                description = task.markdownDescription || task.description || '';
            }
        }
        vscode.postMessage({
            type: 'ticketsAskAgent',
            provider,
            workspaceRoot: ticketsWorkspaceRoot,
            id,
            title,
            description
        });
        showTicketsStatus('Sending ticket to agent...');
    }

    function loadLocalTicketFiles() {
        if (!lastIntegrationProvider || !ticketsWorkspaceRoot) return;
        vscode.postMessage({ type: 'listLocalTicketFiles', provider: lastIntegrationProvider, workspaceRoot: ticketsWorkspaceRoot });
    }

    function _requestTicketSyncStatuses() {
        if (!lastIntegrationProvider || !ticketsWorkspaceRoot) return;
        const issues = lastIntegrationProvider === 'clickup' ? clickUpProjectIssues : linearProjectIssues;
        if (!issues.length) return;
        vscode.postMessage({
            type: 'getTicketSyncStatuses',
            provider: lastIntegrationProvider,
            ids: issues.map(t => t.id),
            workspaceRoot: ticketsWorkspaceRoot
        });
    }

    // ===== STATE PERSISTENCE =====

    function resetTicketsInMemoryState() {
        ticketsEditMode = false;
        _ticketsEditBackupHtml = null;
        linearIssueDetailCache.clear();
        clickUpTaskDetailCache.clear();
        linearProjectIssues = [];
        selectedLinearIssue = null;
        linearProjectStatus = 'idle';
        linearProjectMessage = '';
        linearProjectSearchValue = '';
        linearProjectStateFilterValue = '';
        linearProjectPickerValue = '';
        _restoredLinearProjectPickerValue = '';
        linearAvailableProjects = [];
        linearProjectLoadedOnce = false;
        linearProjectLoading = false;
        if (linearTaskDetailsTimeoutId) {
            clearTimeout(linearTaskDetailsTimeoutId);
            linearTaskDetailsTimeoutId = null;
        }

        clickUpProjectIssues = [];
        availableClickUpStatuses = [];
        selectedClickUpIssue = null;
        clickUpProjectStatus = 'idle';
        clickUpProjectMessage = '';
        clickUpAvailableSpaces = [];
        clickUpAvailableFolders = [];
        clickUpAvailableListsInFolder = [];
        clickUpAvailableDirectLists = [];
        clickUpSelectedSpaceId = '';
        clickUpSelectedFolderId = '';
        clickUpSelectedListId = '';
        clickUpProjectSearchValue = '';
        clickUpProjectStatusFilterValue = '';
        clickUpCurrentPage = 0;
        clickUpProjectHasMore = false;
        clickUpSpacesLoadedOnce = false;
        clickUpProjectLoading = false;
        clickUpHierarchyLoading = false;
        clickUpImportPending = false;
        isImportingAll = false;
        _restoringClickUpHierarchy = false;
        _pendingTicketsRestore = false;
        pendingClickUpDetailIssueId = '';

        _lastTicketsStateFilterHtml = '';
        _lastTicketsProjectPickerHtml = '';
        _lastTicketsIssuesContainerHtml = '';
        _lastTicketsDetailContentHtml = '';
        _lastTicketsHierarchyHtml = '';
        _lastTicketsClickUpIssuesContainerHtml = '';
        _lastTicketsClickUpDetailContentHtml = '';
        _lastTicketsClickUpStateFilterHtml = '';
        _lastTicketsClickUpStatusSelectHtml = '';
        _lastTicketsClickUpSubtasksNavHtml = '';
        _lastTicketsLinearStatusSelectHtml = '';
        _lastTicketsLinearSubtasksNavHtml = '';
        _lastTicketsTagsKey = '';
        _lastTicketsTagsProvider = '';

        const elements = getTicketsTabElements();
        if (elements.issuesContainer) elements.issuesContainer.innerHTML = '';
        if (elements.detailContent) elements.detailContent.innerHTML = '';
        if (elements.subtasksNav) { elements.subtasksNav.innerHTML = ''; elements.subtasksNav.style.display = 'none'; }
        if (elements.previewMetaBar) elements.previewMetaBar.style.display = 'none';
        const _delModal = document.getElementById('tickets-delete-modal');
        if (_delModal) _delModal.style.display = 'none';
        _pendingDeleteTicket = null;
        if (elements.commentInputArea) elements.commentInputArea.style.display = 'none';
        
    }

    function saveTicketsState() {
        if (!ticketsWorkspaceRoot) return;
        const state = {
            lastIntegrationProvider,
            linearProjectSearchValue,
            linearProjectStateFilterValue,
            linearProjectPickerValue,
            clickUpSelectedSpaceId,
            clickUpSelectedFolderId,
            clickUpSelectedListId,
            clickUpProjectSearchValue,
            clickUpProjectStatusFilterValue
        };
        persistTab('tickets', state, ticketsWorkspaceRoot);
        persistTab('tickets.root', ticketsWorkspaceRoot);
    }

    function restoreTicketsStateForRoot(state) {
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

        if (clickUpSelectedSpaceId) {
            _restoringClickUpHierarchy = true;
            // Don't set ticketsLoadedOnce or call loadClickUpSpaces() here —
            // the integrationProviderStates handler will trigger the correct
            // load based on ticketsAutoSync (remote if true, local files if false).
            // _restoringClickUpHierarchy tells the clickupSpacesLoaded handler
            // to auto-select the saved space/folder/list.
        } else {
            _restoringClickUpHierarchy = false;
        }
        if (state.linearProjectPickerValue) {
            _restoredLinearProjectPickerValue = state.linearProjectPickerValue;
        }
    }

    function restoreTicketsState() {
        if (ticketsWorkspaceRoot) {
            // Only set up the file watcher — do NOT send ticketsRootChanged which triggers
            // integrationProviderStates → loadClickUpSpaces → importAllTickets
            vscode.postMessage({ type: 'setupTicketsWatcher', workspaceRoot: ticketsWorkspaceRoot });
        } else {
            vscode.postMessage({ type: 'ticketsDefaultRoot' });
        }
    }

    // ── Sync to Online UI ───────────────────────────────────────
    const btnSyncToOnline = document.getElementById('btn-sync-to-online');
    const syncOnlineModal = document.getElementById('sync-online-modal');
    const btnCloseSyncOnlineModal = document.getElementById('btn-close-sync-online-modal');
    const syncStepFast = document.getElementById('sync-step-fast');
    const syncStepSource = document.getElementById('sync-step-source');
    const syncStepLocation = document.getElementById('sync-step-location');
    const syncStepConfirm = document.getElementById('sync-step-confirm');
    const syncFastText = document.getElementById('sync-fast-text');
    const btnSyncFastConfirm = document.getElementById('btn-sync-fast-confirm');
    const btnSyncFastElsewhere = document.getElementById('btn-sync-fast-elsewhere');
    const syncSourceList = document.getElementById('sync-source-list');
    const btnSyncSourceNext = document.getElementById('btn-sync-source-next');
    const syncLocationSelect = document.getElementById('sync-location-select');
    const syncRememberLocation = document.getElementById('sync-remember-location');
    const btnSyncLocationNext = document.getElementById('btn-sync-location-next');
    const btnSyncLocationBack = document.getElementById('btn-sync-location-back');
    const syncDocName = document.getElementById('sync-doc-name');
    const btnSyncConfirmSync = document.getElementById('btn-sync-confirm-sync');
    const btnSyncConfirmBack = document.getElementById('btn-sync-confirm-back');
    const syncProgress = document.getElementById('sync-progress');
    const syncResult = document.getElementById('sync-result');
    const syncResultLink = document.getElementById('sync-result-link');
    const syncConfirmInfo = document.getElementById('sync-confirm-info');

    let _syncModalState = {
        step: 'fast',
        localDocPath: '',
        docName: '',
        sourceId: '',
        parentId: '',
        mapping: null,
        uploadLocations: {},
        enabledSources: {}
    };

    function updateSyncToOnlineButtonState() {
        if (!btnSyncToOnline) return;
        const hasLocalSelection = state.activeSource === 'local-folder' && state.activeDocId;
        const hasOnlineSource = Object.keys(state.enabledSources || {}).some(k => state.enabledSources[k] !== false);
        btnSyncToOnline.disabled = !(hasLocalSelection && hasOnlineSource);
        // Unified Docs tab: canSync-based visibility is the single source of truth for the
        // shared Sync button. Delegate so per-doc canSync gating is not overridden on selection.
        updateSyncButtonVisibility();
    }

    // Sync-to-online button state is updated inside updateLocalActiveContextButtonState and handleOnlineDocsReady

    function openSyncOnlineModal() {
        if (!syncOnlineModal) return;
        _syncModalState.step = 'fast';
        _syncModalState.localDocPath = state.activeDocFilePath || '';
        _syncModalState.docName = state.activeDocName || '';
        _syncModalState.sourceId = '';
        _syncModalState.parentId = '';
        _syncModalState.mapping = null;
        syncProgress.style.display = 'none';
        syncResult.style.display = 'none';
        syncDocName.value = _syncModalState.docName || '';

        // Request current sync config to check mappings
        vscode.postMessage({ type: 'getSyncConfig' });

        syncOnlineModal.style.display = 'flex';
        _showSyncStep('fast');
    }

    const _sourceDisplayNames = { clickup: 'ClickUp', linear: 'Linear', notion: 'Notion' };

    function _renderSyncConfirmInfo() {
        if (!syncConfirmInfo) return;
        const sid = _syncModalState.sourceId;
        const pid = _syncModalState.parentId;
        const sourceName = _sourceDisplayNames[sid] || sid || 'Unknown';
        let info = `Source: <strong>${escapeHtml(sourceName)}</strong>`;
        if (pid && pid !== '__all__') {
            const containerName = state.activeContainers.get(sid)?.name || pid;
            info += ` &middot; Location: <strong>${escapeHtml(containerName)}</strong>`;
        }
        syncConfirmInfo.innerHTML = info;
    }

    function _showSyncStep(step) {
        [syncStepFast, syncStepSource, syncStepLocation, syncStepConfirm].forEach(el => {
            if (el) el.style.display = 'none';
        });
        const map = { fast: syncStepFast, source: syncStepSource, location: syncStepLocation, confirm: syncStepConfirm };
        if (map[step]) map[step].style.display = '';
        _syncModalState.step = step;
        if (step === 'confirm') {
            _renderSyncConfirmInfo();
        }
    }

    function _renderSyncSourceStep() {
        if (!syncSourceList) return;
        syncSourceList.innerHTML = '';
        const sources = ['clickup', 'linear', 'notion'];
        sources.forEach(sid => {
            if (state.enabledSources[sid] === false) return;
            const label = document.createElement('label');
            label.style.cssText = 'display:flex;align-items:center;gap:8px;cursor:pointer;font-size:13px;';
            const radio = document.createElement('input');
            radio.type = 'radio';
            radio.name = 'sync-source';
            radio.value = sid;
            if (!_syncModalState.sourceId) {
                _syncModalState.sourceId = sid;
                radio.checked = true;
            } else if (_syncModalState.sourceId === sid) {
                radio.checked = true;
            }
            radio.addEventListener('change', () => { _syncModalState.sourceId = sid; });
            label.appendChild(radio);
            label.appendChild(document.createTextNode(_sourceDisplayNames[sid] || sid));
            syncSourceList.appendChild(label);
        });
    }

    async function _renderSyncLocationStep() {
        if (!syncLocationSelect) return;
        syncLocationSelect.innerHTML = '<option value="">Loading…</option>';
        const sid = _syncModalState.sourceId;
        const saved = _syncModalState.uploadLocations[sid];
        if (saved) {
            // Pre-fill with saved location; still fetch containers to show name
            vscode.postMessage({ type: 'fetchContainers', sourceId: sid });
            // Wait for containersReady via a one-time handler? Instead, we already have activeContainers
            const containerName = state.activeContainers.get(sid)?.name || saved;
            syncLocationSelect.innerHTML = `<option value="${escapeHtml(saved)}">${escapeHtml(containerName)}</option>`;
            _syncModalState.parentId = saved;
            return;
        }
        vscode.postMessage({ type: 'fetchContainers', sourceId: sid });
    }

    function _populateSyncLocationSelect(containers) {
        if (!syncLocationSelect) return;
        syncLocationSelect.innerHTML = '';
        const allOpt = document.createElement('option');
        allOpt.value = '__all__';
        allOpt.textContent = 'Root / No specific container';
        syncLocationSelect.appendChild(allOpt);
        containers.forEach(c => {
            const opt = document.createElement('option');
            opt.value = c.id;
            opt.textContent = c.name;
            syncLocationSelect.appendChild(opt);
        });
        // If a saved upload location exists and matches an option, select it
        const saved = _syncModalState.uploadLocations[_syncModalState.sourceId];
        if (saved && syncLocationSelect.querySelector(`option[value="${saved}"]`)) {
            syncLocationSelect.value = saved;
        }
    }

    if (btnSyncToOnline) {
        btnSyncToOnline.addEventListener('click', openSyncOnlineModal);
    }

    if (btnCloseSyncOnlineModal) {
        btnCloseSyncOnlineModal.addEventListener('click', () => {
            if (syncOnlineModal) syncOnlineModal.style.display = 'none';
        });
    }

    if (syncOnlineModal) {
        syncOnlineModal.addEventListener('click', (e) => {
            if (e.target.id === 'sync-online-modal') {
                syncOnlineModal.style.display = 'none';
            }
        });
    }

    if (btnSyncFastConfirm) {
        btnSyncFastConfirm.addEventListener('click', () => {
            if (_syncModalState.mapping) {
                _syncModalState.sourceId = _syncModalState.mapping.sourceId;
                _showSyncStep('confirm');
                _triggerSync('update');
            }
        });
    }

    if (btnSyncFastElsewhere) {
        btnSyncFastElsewhere.addEventListener('click', () => {
            _renderSyncSourceStep();
            _showSyncStep('source');
        });
    }

    if (btnSyncSourceNext) {
        btnSyncSourceNext.addEventListener('click', () => {
            const selected = syncSourceList?.querySelector('input[name="sync-source"]:checked');
            _syncModalState.sourceId = selected ? selected.value : '';
            _renderSyncLocationStep();
            _showSyncStep('location');
        });
    }

    if (btnSyncLocationNext) {
        btnSyncLocationNext.addEventListener('click', () => {
            _syncModalState.parentId = syncLocationSelect?.value || undefined;
            _showSyncStep('confirm');
        });
    }

    if (btnSyncLocationBack) {
        btnSyncLocationBack.addEventListener('click', () => {
            _renderSyncSourceStep();
            _showSyncStep('source');
        });
    }

    if (btnSyncConfirmBack) {
        btnSyncConfirmBack.addEventListener('click', () => {
            _showSyncStep('location');
        });
    }

    if (btnSyncConfirmSync) {
        btnSyncConfirmSync.addEventListener('click', () => {
            _triggerSync('create');
        });
    }

    function _triggerSync(mode) {
        if (!btnSyncConfirmSync) return;
        btnSyncConfirmSync.disabled = true;
        syncProgress.style.display = '';
        syncProgress.textContent = mode === 'update' ? 'Updating…' : 'Syncing…';
        syncResult.style.display = 'none';
        vscode.postMessage({
            type: 'syncDocToOnline',
            localDocPath: _syncModalState.localDocPath,
            sourceId: _syncModalState.sourceId,
            parentId: _syncModalState.parentId,
            mode,
            rememberLocation: syncRememberLocation ? syncRememberLocation.checked : false,
            docName: syncDocName ? syncDocName.value : _syncModalState.docName
        });
    }

    // Wire message handlers for sync-related responses
    const _origMessageHandler = window.addEventListener ? null : null; // placeholder — actual dispatch is inline switch below
    // We will add cases to the main switch in the message handler block above

    vscode.postMessage({ type: 'fetchRoots' });
    vscode.postMessage({ type: 'refreshSource', sourceId: 'local-folder' });
    vscode.postMessage({ type: 'getPlanningPanelSyncMode' });
})();