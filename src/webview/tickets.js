(function () {
    // Unique originatorId per webview/tab instance. In the browser host,
    // transport.js loads first and generates this global BEFORE its WebSocket
    // connects, so the WS URL and every stamped message share one identity —
    // reuse it. In the editor webview transport.js is absent, so generate here.
    const clientOriginatorId = window.__sbClientOriginatorId
        || ('client_' + Math.random().toString(36).substring(2, 11) + '_' + Date.now());
    window.__sbClientOriginatorId = clientOriginatorId;

    // Stamp every outbound message with this client's originatorId so the host
    // keys per-client seats (view state) by sender. The real webview API object
    // is Object.freeze'd, so wrap it — never patch its properties in place.
    const _rawVscodeApi = (typeof acquireVsCodeApi === 'function') ? acquireVsCodeApi() : null;
    const vscode = _rawVscodeApi ? {
        postMessage: (message) => {
            if (message && typeof message === 'object' && !message.originatorId) {
                message = Object.assign({}, message, { originatorId: clientOriginatorId });
            }
            return _rawVscodeApi.postMessage(message);
        },
        getState: () => _rawVscodeApi.getState(),
        setState: (s) => _rawVscodeApi.setState(s),
    } : null;

    // Revived panels boot as a NEW webview (see utils/reviveWithRetention), so
    // getState() is undefined and every setState-persisted preference would silently
    // reset on each window reload. The host inlines the pre-reload payload into a
    // <meta name="sb-initial-state"> tag (meta, not inline script: the strict panel CSPs
    // block un-nonced inline scripts). Seed it once, before the first getState() read.
    try {
        if (vscode && vscode.getState() === undefined) {
            const _sbSeedEl = document.querySelector('meta[name="sb-initial-state"]');
            if (_sbSeedEl && _sbSeedEl.content) {
                vscode.setState(JSON.parse(_sbSeedEl.content));
            }
        }
    } catch (_) {}

    // Restore persisted state (webview-local, survives reload via the seed above).
    const persistedState = (vscode ? vscode.getState() : {}) || {};

    // ┌─ Section Map (approx, ±20 lines) ──────────────────────────────────
    // │ IIFE / vscode wrapper / state seed ........ lines 1–72
    // │ Tab-state & root persistence helpers ...... lines 74–496
    // │ Ticket metadata helpers (priority/status/
    // │   assignee/badges/subtasks) ............... lines 497–654
    // │ Priority popover handlers ................. lines 655–685
    // │ Ticket card renderers (ClickUp/Linear/
    // │   groups/drill-down header) ............... lines 686–818
    // │ Filter option renderers ................... lines 819–973
    // │ Filtered ticket getters ................... lines 974–1095
    // │ Ticket list & panel renderers ............. lines 1096–1359
    // │ Local ticket files & sync statuses ........ lines 1360–1451
    // │ Tags / comment helpers .................... lines 1452–1649
    // │ Tags & assign modals ...................... lines 1650–1842
    // │ Priority/tags selection & markdown helpers  lines 1831–1978
    // │ Tags/status/assign modal open-save ........ lines 1979–2343
    // │ Comment manager (threads/replies/
    // │   optimistic merge) ....................... lines 2344–2724
    // │ Mention autocomplete ...................... lines 2725–2874
    // │ Attachments list .........................  lines 2875–2997
    // │ Ticket file refresh & parent picker ....... lines 2998–3072
    // │ Edit mode (enter/exit) .................... lines 3073–3228
    // │ Priority popover/import/link/task details . lines 3229–3577
    // │ Task detail renderers (Linear/ClickUp) .... lines 3334–3727
    // │ Integration config (ClickUp/Linear apply,
    // │   mappings, automation, save locations,
    // │   triage pipeline) ....................... lines 3728–6102
    // │ Host message listener & dispatch .......... lines 6103–7262
    // │ ClickUp list statuses / save-location
    // │   pasteback / init ....................... lines 7263–8435
    // └──────────────────────────────────────────────────────────────────────

    // ── Tab-state persistence helpers ───────────────────────────────────────
    // NOTE: `persistTab` and `getRestoredState` are NOT yet in sharedUtils.js —
    // plan 1's promotion of `persistTab` was reverted in review (the lifted copy was
    // a degraded rewrite, so the originals stayed authoritative in planning.js /
    // design.js). Until a later plan promotes them for real, this panel carries its
    // own copies matching design.js byte-for-byte, exactly as design.js does.
    // `escapeHtml`, `escapeAttr` and `initOverflowMenus` ARE sharedUtils.js globals
    // and are NOT re-declared here.
    //
    // `populateWorkspaceDropdown` / `registerWorkspaceDropdown` / `updateDropdown`
    // came over with them and are GONE: this panel has no workspace dropdown to
    // populate, and nothing else called them. See the note in tickets.html.

    let _restoredPanelState = { panel: {}, byRoot: {} };
    let _workspaceItems = [];

    const _debounceTimers = {};
    function persistTab(tabKey, tabState, workspaceRoot) {
        const timerKey = tabKey + (workspaceRoot ? '::' + workspaceRoot : '');
        if (_debounceTimers[timerKey]) {
            clearTimeout(_debounceTimers[timerKey]);
        }
        _debounceTimers[timerKey] = setTimeout(() => {
            if (!vscode) return;
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
    window.getRestoredState = function (tabKey, workspaceRoot) {
        if (workspaceRoot) {
            return (_restoredPanelState.byRoot[tabKey] || {})[workspaceRoot];
        }
        return _restoredPanelState.panel[tabKey];
    };

    // ── Tickets tab state ───────────────────────────────────────────────────
    // Verbatim from planning.js. These are the module-level ticket state vars;
    // later slices populate and consume them. The foundation only needs
    // ticketsWorkspaceRoot + lastIntegrationProvider to be live, but every
    // declaration moves now so later slices don't have to reopen this region.

    // True while the last listing ran with NO list/project scope (so it returned every
    // file, or the ClickUp "pick a list" placeholder). restoreTicketsStateForRoot reads
    // it to re-list once a scope finally arrives — an unscoped listing is not the answer
    // to a scoped question.
    //
    // The comment that used to sit here was the tail of a sentence about
    // `_integrationWorkspacesReceived`, which no longer exists; it described the
    // workspace picker, not this flag.
    let _ticketsListedUnscoped = false;
    // Last listLocalTicketFiles response's scope-coverage counts, when list/project
    // scoping hid every candidate file. Drives the distinguishing empty-state copy.
    let _ticketsScopeCoverage = null;
    // True while the last listing was the ClickUp "no list selected" placeholder. The
    // sidebar then has nothing correct to show, and "No tasks found." would read as
    // "this list is empty" for a user who has not picked a list at all.
    let _ticketsAwaitingListSelection = false;

    let ticketsInitialized = false;
    let ticketsLoadedOnce = false;
    let lastIntegrationProvider = null;

    let ticketsEditMode = false;
    let _ticketsEditBackupHtml = null;
    let ticketsWorkspaceRoot = '';

    // Linear state
    let linearProjectIssues = [];
    const TICKETS_ASSIGNEE_UNASSIGNED = '__unassigned__';
    let selectedLinearIssue = null;
    let linearProjectStatus = 'idle';
    let linearProjectMessage = '';
    let linearProjectSearchValue = '';
    let linearProjectStateFilterValue = '';
    let linearProjectAssigneeFilterValue = '';
    let linearProjectPickerValue = '';
    let _restoredLinearProjectPickerValue = '';
    let linearAvailableProjects = [];
    let linearProjectLoadedOnce = false;
    let linearProjectLoading = false;
    let linearTaskDetailsTimeoutId = null;

    // ClickUp state
    let clickUpProjectIssues = [];
    let selectedClickUpIssue = null;
    // Tickets sidebar: status-accordion + subtask drill-down state. Module-level so
    // they survive the string-compare re-renders (and tab switches) within a session.
    let _collapsedTicketStatuses = new Set();   // status names whose accordion is collapsed
    let _sidebarDrillDownParentId = null;       // null = normal list; parent id = showing its subtasks
    let _drillDownSubtasks = null;              // cached subtask array for drill-down (survives subtask-detail loads)
    let _drillDownParentTitle = '';            // parent title for the drill-down header
    let _drillDownProvider = null;             // 'clickup' | 'linear' — isolates drill-down to the active provider
    let _pendingDrillDownParentId = null;      // parent id awaiting subtask data before drill-down can activate
    let _subtaskParent = null;
    let _convertSelectedParentId = null;
    let _convertCurrentTicketId = null;

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
    let clickUpProjectAssigneeFilterValue = '';
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

    /**
     * Is this push an answer to a request THIS panel made?
     *
     * Host replies are broadcast to every Tickets surface, so a reply for another
     * panel's list arrives here looking exactly like our own. Accepting it
     * overwrites clickUpProjectIssues with a foreign list — the "sidebar flashes
     * with a lot of stuff and then disappears" bug. Reject anything that names a
     * scope other than the one we are showing.
     *
     * Accepts when: the message is our locally-synthesised placeholder; the
     * message names no scope AND we have none selected; the scopes match; or
     * the workspaceRoot matches (for Linear, which has no per-project scope id).
     */
    function _isForThisPanel(message) {
        if (message && message.unscopedPlaceholder) { return true; }
        // Most scope-bearing replies (clickupProjectLoaded, clickupListStatusesLoaded,
        // clickupError, linearProjectLoaded, linearError) carry NO `provider` field, so
        // a provider check that reads only message.provider is inert for exactly the
        // arms that need it — a clickup* reply would fall through to the Linear
        // early-accept below and be applied by a Linear-mode panel. The message type
        // prefix is the provider for every one of those types.
        const typeProvider = typeof message.type === 'string'
            ? (message.type.startsWith('clickup') ? 'clickup'
                : message.type.startsWith('linear') ? 'linear' : null)
            : null;
        const provider = message.provider || typeProvider || lastIntegrationProvider;
        if (provider && lastIntegrationProvider && provider !== lastIntegrationProvider) { return false; }
        // Workspace guard: if both sides carry a workspaceRoot, they must match.
        // This catches cross-workspace contamination where two panels show the
        // same ClickUp list ID or the same Linear team in different workspaces.
        if (message.workspaceRoot && ticketsWorkspaceRoot
                && message.workspaceRoot !== ticketsWorkspaceRoot) {
            return false;
        }
        // ClickUp: scope by listId. Linear: no server-side scope id — workspaceRoot
        // guard above is the discriminator. linearProjectPickerValue is a client-
        // side filter, not a server scope, so we do NOT compare it against the
        // reply's scopeId.
        if (lastIntegrationProvider === 'linear') {
            return true;   // workspaceRoot already checked; same-workspace = same data
        }
        const mine = clickUpSelectedListId || '';
        const theirs = String(
            message.scopeId ?? message.listId ?? message.projectId ?? ''
        );
        if (!mine) { return true; }          // nothing selected — nothing to protect
        return theirs === mine;
    }

    let currentTicketTags = [];
    let availableLinearLabels = [];
    let availableLinearStates = [];
    let availableClickUpTags = [];
    let availableClickUpStatuses = [];
    // Status-edit modal target (set by showTicketStatusModal, read by Save).
    let _statusModalProvider = null;
    let _statusModalTicketId = null;
    let _pendingStatusChangeName = '';
    let _tagsModalOpen = false;
    let _tagsCatalogLoading = false;
    let _assignModalOpen = false;
    let _assignMembersLoading = false;
    let _assignMembers = [];
    let _currentAssigneeIds = [];
    let _openPriorityPopoverFor = null; // { provider, ticketId, preValue, dotEl }
    let _pendingPriorityChange = null;  // { provider, ticketId, preValue }

    // Cached HTML strings for DOM guard comparisons
    let _lastTicketsStateFilterHtml = '';
    // ONE cache for the assignee select: unlike the state/status filters (two separate
    // elements), Linear and ClickUp share a single `tickets-assignee-filter` element, so
    // per-provider caches would report "unchanged" while the DOM held the other
    // provider's options. Both builders emit the same string shape for direct comparison.
    let _lastTicketsAssigneeFilterHtml = '';
    let _lastTicketsProjectPickerHtml = '';
    let _lastTicketsIssuesContainerHtml = '';
    let _lastTicketsDetailContentHtml = '';
    let _lastTicketsHierarchyHtml = '';
    let _lastTicketsClickUpIssuesContainerHtml = '';
    let _lastTicketsClickUpDetailContentHtml = '';
    let _lastTicketsClickUpStateFilterHtml = '';
    let _lastTicketsClickUpSubtasksNavHtml = '';
    let _lastTicketsLinearSubtasksNavHtml = '';
    let _lastTicketsTagsKey = '';
    let _lastTicketsTagsProvider = '';
    let _lastLinkTicketBtn = null;

    // Full detail caches for tickets that have been expanded
    let linearIssueDetailCache = new Map(); // issueId -> { issue, subtasks, comments, attachments, renderedDescriptionHtml }
    let clickUpTaskDetailCache = new Map(); // taskId -> { task, subtasks, comments, attachments, renderedDescriptionHtml }

    // ── Element accessor + status/loading helpers ───────────────────────────
    // Verbatim from planning.js. Every later slice depends on getTicketsTabElements.

    function getTicketsTabElements() {
        return {
            listView: document.getElementById('tree-pane-tickets'),
            previewPane: document.getElementById('preview-pane-tickets'),
            emptyPreview: document.getElementById('tickets-empty-preview'),
            searchInput: document.getElementById('tickets-search'),
            projectPicker: document.getElementById('tickets-project-picker'),
            stateFilter: document.getElementById('tickets-state-filter'),
            clickUpStatusFilter: document.getElementById('tickets-status-filter'),
            assigneeFilter: document.getElementById('tickets-assignee-filter'),
            refreshButton: document.getElementById('tickets-refresh'),
            refetchButton: document.getElementById('tickets-refetch'),
            ticketsMoreTrigger: document.querySelector('#controls-strip-tickets [data-overflow-trigger]'),
            previewMoreTrigger: document.querySelector('#tickets-preview-meta-bar [data-overflow-trigger]'),
            emptyState: document.getElementById('tickets-empty-state'),
            issuesContainer: document.getElementById('tickets-issues-container'),
            loadMoreButton: document.getElementById('tickets-load-more'),
            subtasksNav: document.getElementById('tickets-subtasks-nav'),
            detailContent: document.getElementById('tickets-detail-content'),
            hierarchyNav: document.getElementById('tickets-hierarchy-nav'),
            createButton: document.getElementById('tickets-create'),
            // ── 2f: btn-import-all-tickets stale lookup removed — the id never
            //    existed in tickets.html (nor in planning.html at 7aebaf5); the
            //    only import-all control is #tickets-import-all-kanban. ──
            importAllKanbanButton: document.getElementById('tickets-import-all-kanban'),
            linkAllButton: document.getElementById('tickets-link-all'),
            syncAllButton: document.getElementById('tickets-sync-all'),
            previewMetaBar: document.getElementById('tickets-preview-meta-bar'),
            btnEditTicket: document.getElementById('btn-edit-ticket'),
            btnPushTicket: document.getElementById('btn-push-ticket'),
            btnDeleteTicket: document.getElementById('btn-delete-ticket'),
            btnCommentTicket: document.getElementById('btn-comment-ticket'),
            btnViewAttachments: document.getElementById('btn-view-attachments'),
            btnDiagramPrompt: document.getElementById('btn-diagram-prompt'),
            attachmentsModal: document.getElementById('attachments-modal'),
            attachmentsList: document.getElementById('attachments-list'),
            ticketsStatusFooter: document.getElementById('tickets-status-footer'),
            commentInputArea: document.getElementById('tickets-comment-manager'),
            commentTextarea: document.getElementById('tickets-comment-textarea'),
            btnPostCommentCancel: document.getElementById('btn-post-comment-cancel'),
            btnPostCommentSubmit: document.getElementById('btn-post-comment-submit'),
            ticketsSourceBtn: document.getElementById('tickets-source-btn'),
            ticketsSourcePrev: document.getElementById('tickets-source-prev'),
            ticketsSourceNext: document.getElementById('tickets-source-next'),
            ticketsSourceSummary: document.getElementById('tickets-source-summary'),
            ticketsSourceModal: document.getElementById('tickets-source-modal'),
            btnCloseTicketsSourceModal: document.getElementById('btn-close-tickets-source-modal'),
            btnCloseTicketsSourceModalAction: document.getElementById('btn-close-tickets-source-modal-action'),
            ticketsAgentApiBtn: document.getElementById('tickets-agent-api'),
            ticketsAgentApiModal: document.getElementById('tickets-agent-api-modal'),
            btnCloseTicketsAgentApiModal: document.getElementById('btn-close-tickets-agent-api-modal'),
            btnCloseTicketsAgentApiModalAction: document.getElementById('btn-close-tickets-agent-api-modal-action'),
            ticketsAutoSyncToggle: document.getElementById('tickets-auto-sync-toggle')
        };
    }

    function isTicketsTabActive() {
        return document.querySelector('.shared-tab-btn.active')?.dataset.tab === 'tickets';
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

    function clearTicketsStatus() {
        const { ticketsStatusFooter } = getTicketsTabElements();
        if (window._ticketsFooterTimeout) {
            clearTimeout(window._ticketsFooterTimeout);
            window._ticketsFooterTimeout = null;
        }
        if (ticketsStatusFooter) {
            ticketsStatusFooter.textContent = '';
            ticketsStatusFooter.style.display = 'none';
        }
    }

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

    // Clears all drill-down state (back to the normal grouped list).
    function _resetSidebarDrillDown() {
        _sidebarDrillDownParentId = null;
        _drillDownSubtasks = null;
        _drillDownParentTitle = '';
        _drillDownProvider = null;
        _pendingDrillDownParentId = null;
    }

    // ── tickets.root persistence + workspace dropdown ───────────────────────
    // The workspace dropdown is the one listener this foundation slice owns.
    // `tickets.root` is persisted host-side via persistTab('tickets.root', …) and
    // read back via getRestoredState('tickets', …) once the host pushes
    // restoredTabState (a later slice wires the TicketsPanelProvider push; until
    // then the read is a no-op). Across-reload survival of the root selection is
    // also carried by the <meta name="sb-initial-state"> seed + vscode.setState()
    // above, which works in both hosts today.

    function persistTicketsRoot() {
        persistTab('tickets.root', ticketsWorkspaceRoot);
        // Mirror into webview-local state so the seed restores it on revival even
        // before restoredTabState is wired into TicketsPanelProvider.
        if (vscode) {
            const cur = vscode.getState() || {};
            if (cur.ticketsWorkspaceRoot !== ticketsWorkspaceRoot) {
                vscode.setState(Object.assign({}, cur, { ticketsWorkspaceRoot }));
            }
        }
    }

    /**
     * Default the save root once the host has answered fetchRoots.
     *
     * All this ever needed to do. It used to be `updateTicketsWorkspacePicker()` and
     * spent most of its body showing/hiding a workspace dropdown and writing a "No
     * workspaces found." label — a picker this panel is not supposed to have, and a
     * label for a state a workspace-scoped panel cannot reach. Both are deleted; the
     * root default is the real work.
     */
    function ensureTicketsRootDefault() {
        if (ticketsWorkspaceRoot || _workspaceItems.length === 0) { return; }
        ticketsWorkspaceRoot = _workspaceItems[0].workspaceRoot;
        persistTicketsRoot();
        ensureTicketsWatcherArmed();
    }

    // ── Slice 2b additions: Source modal, provider hierarchy, ticket folders ──

    // Move-mode state for the Source modal. When _moveMode is true the Source modal
    // is repurposed as a move-target picker. For ClickUp the existing hierarchy nav
    // (space→folder→list) is used for browsing — the whole point of this feature is
    // to replace the flat unsorted mega-list with the hierarchy browser. The active
    // ClickUp hierarchy state is snapshotted on enter and restored on exit so move-
    // mode browsing does not mutate or persist the user's active source. For Linear
    // no hierarchy nav exists, so a themed target <select> populated via
    // fetchMoveTargets is shown instead.
    let _moveMode = false;
    let _moveTicketId = null;
    let _moveProvider = null;
    let _moveSelectedTargetId = null;
    let _moveHierarchySnapshot = null;

    // Folder modal scope — 'tickets' when managing ticket folders.
    let folderModalScope = 'local';

    // Integration provider states (received from the host).
    //
    // `_integrationWorkspaces` / `_integrationWorkspacesReceived` are deliberately GONE.
    // They came over from planning.js as declarations only — the host push that filled
    // them was not extracted — so they read as an available "roots that have an
    // integration configured" list while being permanently empty. The workspace picker
    // was rewired onto the all-roots `_workspaceItems` to compensate, which is how the
    // Tickets tab grew a workspace dropdown it never had. Do not reintroduce them as
    // bare declarations; if the integration-scoped list is wanted, wire the push too.
    let _integrationProviderStatesReceived = false;

    // Tickets folder paths by root (from ticketsFoldersListed / localDocsReady).
    let _ticketsFolderPathsByRoot = {};

    // ── Stubs for functions that arrive in later slices (2c–2f) ──
    // These are no-ops now; they exist so the 2b response arms and hierarchy
    // listeners can call them without ReferenceError. Each is replaced by its
    // real implementation when its slice lands.

    // ── 2c: Priority helpers (leaf — no dependencies) ──

    function _linearPriorityColor(priority) {
        const colors = ['#95a2b3', '#eb5757', '#f2c94c', '#5e6ad2', '#95a2b3'];
        return colors[priority] || '#95a2b3';
    }

    function _linearPriorityName(priority) {
        const names = ['No priority', 'Urgent', 'High', 'Normal', 'Low'];
        return names[priority] || 'No priority';
    }

    function _clickUpPriorityColor(task) {
        if (task?.priority?.color) {
            return task.priority.color;
        }
        const orderIndex = Number(task?.priority?.orderindex || 0);
        const colors = {
            1: '#f30000',
            2: '#ffcc00',
            3: '#6f85ff',
            4: '#d3d3d3',
        };
        return colors[orderIndex] || '#95a2b3';
    }

    function _clickUpPriorityName(task) {
        if (task?.priority?.priority) {
            return task.priority.priority.charAt(0).toUpperCase() + task.priority.priority.slice(1);
        }
        const orderIndex = Number(task?.priority?.orderindex || 0);
        const names = {
            1: 'Urgent',
            2: 'High',
            3: 'Normal',
            4: 'Low',
        };
        return names[orderIndex] || 'No priority';
    }

    // ── 2c: Assignee identity helpers ──
    // Assignee identity for the Tickets assignee filter. Prefer the stable remote id,
    // but fall back to a name-derived key: the file-backed sidebar path
    // (`localTicketFilesListed`) is this tab's steady state and carries assignee NAMES
    // only — ticket-file frontmatter stores `assignees: Name, Name` with no ids, and the
    // webview maps them to `{ username: name }` / `{ name }`. An id-only key therefore
    // leaves the dropdown permanently empty on the path the user actually sees.
    const TICKETS_ASSIGNEE_NAME_KEY_PREFIX = 'name:';
    function _ticketsAssigneeKey(id, name) {
        const rawId = (id === null || id === undefined) ? '' : String(id).trim();
        if (rawId) return rawId;
        const rawName = String(name || '').trim();
        return rawName ? TICKETS_ASSIGNEE_NAME_KEY_PREFIX + rawName : '';
    }
    function _clickUpAssigneeIdentity(a) {
        const name = String(a?.username || a?.email || (a?.id ?? '')).trim();
        return { key: _ticketsAssigneeKey(a?.id, name), name };
    }
    function _linearAssigneeIdentity(assignee) {
        const name = String(assignee?.name || assignee?.email || (assignee?.id ?? '')).trim();
        return { key: _ticketsAssigneeKey(assignee?.id, name), name };
    }

    // ── 2c: Status helpers (leaf) ──

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

    // Logical ordering for status-group accordion headers (To Do → In Progress →
    // Blocked → Review → Done). Unrecognised custom statuses fall to 50 so they sit
    // between the known buckets and 'No Status' (99), then sort alphabetically.
    function _ticketStatusOrder(statusName) {
        const s = String(statusName || '').toLowerCase();
        if (!s) return 99;
        // Test most-specific / latest-stage buckets FIRST so phrases like
        // "Ready for Review" / "Ready for QA" classify as Review (3), not To Do (0) —
        // the broad `ready` token in the To Do bucket is checked last on purpose.
        if (/(done|complete|closed|resolved|merged|shipped|deployed|archived|live)/.test(s)) return 4;
        if (/(review|qa|testing|verify|approval)/.test(s)) return 3;
        if (/(block|hold|stuck|waiting|paused)/.test(s)) return 2;
        if (/(progress|doing|active|started|develop|dev|wip|implement|build)/.test(s)) return 1;
        if (/(backlog|todo|to do|open|created|new|triage|planned|ready)/.test(s)) return 0;
        return 50;
    }

    function _isClickUpClosedStatus(statusName) {
        if (!statusName) return false;
        const s = (availableClickUpStatuses || []).find(st => (st.status || '') === statusName);
        const ty = String(s?.type || '').toLowerCase();
        return ty === 'closed' || ty === 'done';
    }

    // ── 2c: Sync badge + external URL (leaf) ──

    // Resolves the external URL for a ticket so the "Open" action works for every
    // ticket, including local-only ones (which carry no API url). ClickUp URLs are
    // deterministic from the task id; Linear requires the API-provided url.
    function _ticketExternalUrl(provider, id, existingUrl) {
        if (existingUrl) { return existingUrl; }
        if (provider === 'clickup' && id) { return `https://app.clickup.com/t/${id}`; }
        return '';
    }

    // Builds the sync-status badge shown bottom-left on each card.
    //
    // FOUR inputs, not three. `undefined` means "status not fetched yet" — it is NOT
    // the same as 'local-only', and collapsing them made every drill-down subtask card
    // claim it was local-only when its status had simply never been requested.
    //
    // The pending label is ASCII: this panel's font stack carries no symbol glyphs, so
    // an ellipsis or arrow renders as tofu.
    function _ticketSyncBadge(syncStatus) {
        if (syncStatus === 'modified') { return `<span class="ticket-sync-badge ticket-sync-modified">modified</span>`; }
        if (syncStatus === 'synced') { return `<span class="ticket-sync-badge ticket-sync-synced">synced</span>`; }
        if (syncStatus === 'local-only') { return `<span class="ticket-sync-badge ticket-sync-local">local</span>`; }
        return `<span class="ticket-sync-badge ticket-sync-pending">checking</span>`;
    }

    // Subtask count for a sidebar card.
    //
    // Prefers the detail cache once populated: that array is what a drill-down
    // actually lists, and it counts remote subtasks the user never imported.
    // Falls back to the file-derived count from listLocalTicketFiles, which is
    // what makes the chip visible BEFORE the ticket has ever been selected —
    // the whole point of the affordance.
    //
    // Returns undefined when nothing is known — remote-list cards and drill-down
    // subtask cards carry no count, and "unknown" must not render as "0".
    function _ticketSubtaskCount(provider, id, fileCount) {
        const cached = provider === 'linear' ? linearIssueDetailCache.get(id) : clickUpTaskDetailCache.get(id);
        if (cached && cached.detailsFetched && Array.isArray(cached.subtasks)) {
            return cached.subtasks.length;
        }
        return typeof fileCount === 'number' ? fileCount : undefined;
    }

    // The chip is BOTH the count display and the only drill-down affordance.
    // Nothing renders for 0 or unknown — a "0 subtasks" chip on every leaf ticket
    // is noise, unknown is not zero, and a chip that does nothing when clicked is
    // worse than no chip.
    // ASCII + an existing sb-icon mask class only: this panel's font stack has no
    // symbol glyphs, so a decorative arrow would render as tofu.
    function _ticketSubtaskChip(provider, id, fileCount) {
        const n = _ticketSubtaskCount(provider, id, fileCount);
        if (!n) { return ''; }
        return `<span class="ticket-subtask-count" role="button" tabindex="0" data-subtask-count-provider="${escapeAttr(provider)}" data-subtask-count-ticket-id="${escapeAttr(id)}" title="Show ${n} subtask${n === 1 ? '' : 's'}"><span class="sb-icon sb-icon-sm sb-icon-chevron-right" aria-hidden="true"></span>${n}</span>`;
    }

    // ── 2c: Priority popover dismiss + outside-click/ESC handlers ──
    function outsideClickPriorityClose(e) {
        const popover = document.getElementById('ticket-priority-popover');
        if (popover && !popover.contains(e.target) && !_openPriorityPopoverFor?.dotEl.contains(e.target)) {
            closePriorityPopover();
        }
    }

    function escPriorityClose(e) {
        if (e.key === 'Escape') {
            closePriorityPopover();
        }
    }

    function closePriorityPopover() {
        const popover = document.getElementById('ticket-priority-popover');
        if (popover) {
            popover.style.display = 'none';
        }
        _openPriorityPopoverFor = null;
        document.removeEventListener('click', outsideClickPriorityClose);
        document.removeEventListener('keydown', escPriorityClose);
        const container = document.getElementById('tickets-issues-container');
        if (container) {
            container.removeEventListener('scroll', closePriorityPopover);
        }
    }

    // ── 2c: Card renderers ──

    // Renders a single ClickUp sidebar card. Shared by the grouped normal list and
    // the subtask drill-down list so the markup (and its buttons) stays identical.
    function _renderClickUpTicketCard(task) {
        const isSelected = selectedClickUpIssue && selectedClickUpIssue.task && selectedClickUpIssue.task.id === task.id;
        const syncBadge = _ticketSyncBadge(task.syncStatus);
        const priorityVal = Number(task.priority?.orderindex || 0);
        const priorityColor = _clickUpPriorityColor(task);
        const priorityName = _clickUpPriorityName(task);
        const priorityDot = `<span class="ticket-priority-dot" style="background:${escapeAttr(priorityColor)}" data-priority-value="${priorityVal}" data-priority-provider="clickup" data-ticket-id="${escapeAttr(task.id)}" title="Priority: ${escapeAttr(priorityName)}"></span>`;
        const openUrl = _ticketExternalUrl('clickup', task.id, task.url);
        // Render as an <a> so the VS Code webview's native link interception opens
        // it directly in the system browser — bypassing vscode.env.openExternal and
        // its extension-domain permission prompt. The data-open-ticket-url attribute
        // is kept only for the flash feedback; the click handler no longer postMessages.
        const openBtn = openUrl ? `<a href="${escapeAttr(openUrl)}" target="_blank" rel="noopener noreferrer" class="card-icon-btn" data-open-ticket-url="${escapeAttr(openUrl)}">Open</a>` : '';
        return `
        <div class="ticket-node${isSelected ? ' selected' : ''}" data-clickup-task-id="${escapeAttr(task.id)}">
            ${priorityDot}
            <div class="tickets-issue-title">${escapeHtml(task.title || task.name || task.identifier || task.id)}</div>
            <div class="tickets-issue-meta ticket-status-row" data-edit-status data-provider="clickup" data-ticket-id="${escapeAttr(task.id)}">${escapeHtml(task.status || 'Unknown')}${syncBadge}${_ticketSubtaskChip('clickup', task.id, task.subtaskCount)}</div>
            <div class="tickets-issue-meta ticket-edit-assignees" data-edit-assignees data-provider="clickup" data-ticket-id="${escapeAttr(task.id)}">${task.assignees && task.assignees.length ? escapeHtml(task.assignees.map(a => a.username || a.email).join(', ')) : 'Unassigned'}</div>
            <div class="card-actions">
                <button type="button" class="card-icon-btn" data-import-plan-id="${escapeAttr(task.id)}" data-provider="clickup" title="Add to kanban">To kanban</button>
                <button type="button" class="card-icon-btn" data-link-ticket-id="${escapeAttr(task.id)}" data-provider="clickup" title="Link to ticket">Link</button>
                ${openBtn}
                <button type="button" class="card-icon-btn" data-move-ticket-id="${escapeAttr(task.id)}" data-provider="clickup" title="Move to another list">Move</button>
            </div>
        </div>
        `;
    }

    // Renders a single Linear sidebar card. Shared by the grouped normal list and the
    // subtask drill-down list.
    function _renderLinearTicketCard(issue) {
        const isSelected = selectedLinearIssue && selectedLinearIssue.issue && selectedLinearIssue.issue.id === issue.id;
        const syncBadge = _ticketSyncBadge(issue.syncStatus);
        const priorityVal = Number(issue.priority ?? 0);
        const priorityColor = _linearPriorityColor(priorityVal);
        const priorityName = _linearPriorityName(priorityVal);
        const priorityDot = `<span class="ticket-priority-dot" style="background:${escapeAttr(priorityColor)}" data-priority-value="${priorityVal}" data-priority-provider="linear" data-ticket-id="${escapeAttr(issue.id)}" title="Priority: ${escapeAttr(priorityName)}"></span>`;
        const openUrl = _ticketExternalUrl('linear', issue.identifier || issue.id, issue.url);
        // <a> not <button> — see the ClickUp card comment above for why.
        const openBtn = openUrl ? `<a href="${escapeAttr(openUrl)}" target="_blank" rel="noopener noreferrer" class="card-icon-btn" data-open-ticket-url="${escapeAttr(openUrl)}">Open</a>` : '';
        return `
        <div class="ticket-node${isSelected ? ' selected' : ''}" data-linear-issue-id="${escapeAttr(issue.id)}">
            ${priorityDot}
            <div class="tickets-issue-title">${escapeHtml(issue.title || issue.identifier || issue.id)}</div>
            <div class="tickets-issue-meta ticket-status-row" data-edit-status data-provider="linear" data-ticket-id="${escapeAttr(issue.id)}">${escapeHtml(issue.state?.name || 'Unknown state')}${syncBadge}${_ticketSubtaskChip('linear', issue.id, issue.subtaskCount)}</div>
            <div class="tickets-issue-meta ticket-edit-assignees" data-edit-assignees data-provider="linear" data-ticket-id="${escapeAttr(issue.id)}">${escapeHtml(issue.assignee?.name || issue.assignee?.email || 'Unassigned')}</div>
            <div class="tickets-issue-meta">${escapeHtml((issue.description || '').trim().slice(0, 180) || 'No description provided.')}</div>
            <div class="card-actions">
                <button type="button" class="card-icon-btn" data-import-plan-id="${escapeAttr(issue.id)}" data-provider="linear" title="Add to kanban">To kanban</button>
                <button type="button" class="card-icon-btn" data-link-ticket-id="${escapeAttr(issue.id)}" data-provider="linear" title="Link to ticket">Link</button>
                ${openBtn}
                <button type="button" class="card-icon-btn" data-move-ticket-id="${escapeAttr(issue.id)}" data-provider="linear" title="Move to another project">Move</button>
            </div>
        </div>
        `;
    }

    // ── 2c: Grouping + status-group accordion ──

    // Groups an already-sorted ticket array by status name, preserving each group's
    // internal order (priority-first, then newest-first from getFiltered*), then
    // orders the groups by the logical status order. Returns [[statusName, tickets], ...].
    function _groupTicketsByStatus(tickets, statusGetter) {
        const groups = new Map();
        for (const t of tickets) {
            const status = statusGetter(t) || 'No Status';
            if (!groups.has(status)) groups.set(status, []);
            groups.get(status).push(t);
        }
        return Array.from(groups.entries()).sort((a, b) => {
            const orderDiff = _ticketStatusOrder(a[0]) - _ticketStatusOrder(b[0]);
            if (orderDiff !== 0) return orderDiff;
            return a[0].localeCompare(b[0]);
        });
    }

    // Renders one status-group accordion section (header + collapsible body).
    function _renderTicketStatusGroup(statusName, cards, count) {
        const isCollapsed = _collapsedTicketStatuses.has(statusName);
        const statusColor = _ticketStatusLightColor(statusName);
        const headerHtml = `
            <div class="ticket-status-group-header" data-status-name="${encodeURIComponent(statusName)}" style="display:flex;align-items:center;gap:6px;padding:6px 8px;cursor:pointer;user-select:none;border-bottom:1px solid var(--border-color);background:var(--panel-bg2,#1a1a2e);font-size:11px;font-weight:600;text-transform:uppercase;color:var(--text-secondary);">
                <span class="accordion-arrow sb-icon sb-icon-sm sb-icon-chevron-right" style="${isCollapsed ? '' : 'transform:rotate(90deg);'}" aria-hidden="true"></span>
                <span class="ticket-status-light" style="background:${escapeAttr(statusColor)};position:relative;top:0;right:0;"></span>
                <span>${escapeHtml(statusName)}</span>
                <span style="margin-left:auto;opacity:0.6;font-weight:400;">${count}</span>
            </div>`;
        const bodyHtml = `<div class="ticket-status-group-body"${isCollapsed ? ' style="display:none;"' : ''}>${isCollapsed ? '' : cards}</div>`;
        return `<div class="ticket-status-group">${headerHtml}${bodyHtml}</div>`;
    }

    // ── 2c: Drill-down ──

    // Header (and parent card) shown atop the sidebar when in subtask drill-down
    // mode. The parent's OWN card is rendered here — not just its title — so its
    // card actions (To kanban, Link, Open, Move) stay reachable while drilled into
    // the subtask list. Clicking it re-selects the parent; no card click arms
    // drill-down any more, so it stays in drill-down because _sidebarDrillDownParentId
    // is already set. The parent detail is guaranteed cached: _maybeEnterDrillDown only
    // activates after details (incl. subtasks) have been fetched.
    function _renderDrillDownHeader(parentTitle, provider) {
        const parentId = _sidebarDrillDownParentId;
        let parentCard = '';
        if (parentId) {
            if (provider === 'linear') {
                const detail = linearIssueDetailCache.get(parentId);
                if (detail && detail.issue) parentCard = _renderLinearTicketCard(detail.issue);
            } else if (provider === 'clickup') {
                const detail = clickUpTaskDetailCache.get(parentId);
                if (detail && detail.task) parentCard = _renderClickUpTicketCard(detail.task);
            }
        }
        const parentSection = parentCard
            ? `<div style="padding:6px 10px;font-size:10px;font-weight:600;text-transform:uppercase;color:var(--text-secondary);border-bottom:1px solid var(--border-color);">Parent ticket</div>${parentCard}`
            : '';
        // With the parent card present its title is already visible, so the subtask
        // divider is just "Subtasks"; fall back to naming the parent only when the
        // card could not be rendered (cache miss).
        const subtasksLabel = parentCard ? 'Subtasks' : `Subtasks of: ${escapeHtml(parentTitle || '')}`;
        return `
            <div class="sidebar-drilldown-header" style="display:flex;align-items:center;gap:6px;padding:8px 10px;cursor:pointer;border-bottom:1px solid var(--border-color);background:var(--panel-bg2,#1a1a2e);font-size:11px;font-weight:600;color:var(--accent-teal,#00ffcc);user-select:none;">
                <span style="font-size:14px;">←</span>
                <span>Back to all tickets</span>
            </div>
            ${parentSection}
            <div style="padding:6px 10px;font-size:10px;font-weight:600;text-transform:uppercase;color:var(--text-secondary);border-bottom:1px solid var(--border-color);">
                ${subtasksLabel}
            </div>
        `;
    }

    // True when the sidebar should render the drill-down (subtask) list for `provider`.
    function _isDrillDownActive(provider) {
        return !!(_sidebarDrillDownParentId && _drillDownSubtasks && _drillDownProvider === provider);
    }

    // ── 2c: Filter option builders ──

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

    function renderTicketsLinearAssigneeFilterOptions() {
        const { assigneeFilter } = getTicketsTabElements();
        if (!assigneeFilter) return;

        const assigneeMap = new Map();
        for (const issue of linearProjectIssues) {
            const { key, name } = _linearAssigneeIdentity(issue?.assignee);
            if (key && name && !assigneeMap.has(key)) {
                assigneeMap.set(key, name);
            }
        }

        const sortedAssignees = Array.from(assigneeMap.entries()).sort((a, b) => a[1].localeCompare(b[1]));

        const newHtml = `<option value="">All assignees</option><option value="${TICKETS_ASSIGNEE_UNASSIGNED}">Unassigned</option>${sortedAssignees.map(([id, name]) =>
            `<option value="${escapeAttr(id)}">${escapeHtml(name)}</option>`
        ).join('')}`;

        if (_lastTicketsAssigneeFilterHtml !== newHtml) {
            assigneeFilter.innerHTML = newHtml;
            _lastTicketsAssigneeFilterHtml = newHtml;
        }

        const validValues = ['', TICKETS_ASSIGNEE_UNASSIGNED, ...assigneeMap.keys()];
        assigneeFilter.value = validValues.includes(linearProjectAssigneeFilterValue) ? linearProjectAssigneeFilterValue : '';
        linearProjectAssigneeFilterValue = assigneeFilter.value;
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

    function renderTicketsClickUpStatusFilterOptions() {
        const { clickUpStatusFilter } = getTicketsTabElements();
        if (!clickUpStatusFilter) return;

        // Build the dropdown from the LIST's full status set (includes done/closed),
        // not just the statuses of currently-loaded tickets — otherwise "Closed"
        // could never be selected (no closed tickets are loaded by default).
        const fromList = (availableClickUpStatuses || []).map(s => s.status).filter(Boolean);
        const fromLoaded = clickUpProjectIssues.map(task => task.status || 'Unknown');
        const statuses = Array.from(new Set([...fromList, ...fromLoaded].filter(s => s && s !== 'Unknown'))).sort();

        const html = `
            <option value="">All statuses</option>
            ${statuses.map(status => `<option value="${escapeAttr(status)}">${escapeHtml(status)}${_isClickUpClosedStatus(status) ? ' (closed)' : ''}</option>`).join('')}
        `;

        if (_lastTicketsClickUpStateFilterHtml !== html) {
            clickUpStatusFilter.innerHTML = html;
            _lastTicketsClickUpStateFilterHtml = html;
            clickUpStatusFilter.value = clickUpProjectStatusFilterValue || '';
            clickUpStatusFilter.onchange = (e) => _onClickUpStatusFilterChanged(e.target.value);
        }
    }

    function renderTicketsClickUpAssigneeFilterOptions() {
        const { assigneeFilter } = getTicketsTabElements();
        if (!assigneeFilter) return;

        const assigneeMap = new Map();
        for (const task of clickUpProjectIssues) {
            if (Array.isArray(task?.assignees)) {
                for (const a of task.assignees) {
                    const { key, name } = _clickUpAssigneeIdentity(a);
                    if (key && name && !assigneeMap.has(key)) {
                        assigneeMap.set(key, name);
                    }
                }
            }
        }

        const sortedAssignees = Array.from(assigneeMap.entries()).sort((a, b) => a[1].localeCompare(b[1]));

        // Same single-line shape as the Linear builder: both write to the SAME select,
        // so the cached string must be directly comparable across providers.
        const html = `<option value="">All assignees</option><option value="${TICKETS_ASSIGNEE_UNASSIGNED}">Unassigned</option>${sortedAssignees.map(([id, name]) =>
            `<option value="${escapeAttr(id)}">${escapeHtml(name)}</option>`
        ).join('')}`;

        if (_lastTicketsAssigneeFilterHtml !== html) {
            assigneeFilter.innerHTML = html;
            _lastTicketsAssigneeFilterHtml = html;
        }

        const validValues = ['', TICKETS_ASSIGNEE_UNASSIGNED, ...assigneeMap.keys()];
        assigneeFilter.value = validValues.includes(clickUpProjectAssigneeFilterValue) ? clickUpProjectAssigneeFilterValue : '';
        clickUpProjectAssigneeFilterValue = assigneeFilter.value;
    }

    // ── 2c: Status-filter change handler ──
    // Status-filter change. Closed/done tickets are excluded from the default
    // import. Selecting a closed status used to auto-trigger a one-off import
    // that INCLUDED closed; that was a read action firing a destructive delta
    // sweep, so it moved off the read path. The capability itself is preserved:
    // Refresh/Refetch read this filter value and pass `includeClosed` when a
    // closed status is selected (see _clickUpIncludeClosedForRefresh below).
    // Selecting the status alone only re-filters what is already on screen.
    function _onClickUpStatusFilterChanged(value) {
        _resetSidebarDrillDown(); // filter targets the top-level list, not the subtask view
        clickUpProjectStatusFilterValue = value;
        renderTicketsClickUpList();
        saveTicketsState();
    }

    // ── 2c: getFiltered (apply search + filter values) ──

    function getFilteredLinearIssues() {
        const search = String(linearProjectSearchValue || '').trim().toLowerCase();
        const stateFilter = String(linearProjectStateFilterValue || '').trim();
        const projectFilter = String(linearProjectPickerValue || '').trim();
        const assigneeFilter = String(linearProjectAssigneeFilterValue || '').trim();
        const filtered = linearProjectIssues.filter((issue) => {
            if (issue?.parentId) return false;
            if (stateFilter && String(issue?.state?.name || '') !== stateFilter) return false;
            if (projectFilter && String(issue?.project?.name || '') !== projectFilter) return false;
            if (assigneeFilter === TICKETS_ASSIGNEE_UNASSIGNED) {
                if (issue?.assignee) return false;
            } else if (assigneeFilter) {
                if (_linearAssigneeIdentity(issue?.assignee).key !== assigneeFilter) return false;
            }
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
        // Priority first (urgent first), then newest-first by creation date, with a
        // stable title tiebreak so the order doesn't flicker across re-renders.
        // Linear priority is a number: 0=No priority, 1=Urgent … 4=Low. Map 0 → 99 so
        // unprioritised issues sink to the bottom of their status group.
        return filtered.sort((a, b) => {
            const pa = a.priority || 99;
            const pb = b.priority || 99;
            if (pa !== pb) return pa - pb;
            const aTime = a.dateCreated ? new Date(a.dateCreated).getTime() : 0;
            const bTime = b.dateCreated ? new Date(b.dateCreated).getTime() : 0;
            if (bTime !== aTime) return bTime - aTime;
            return (a.title || '').localeCompare(b.title || '');
        });
    }

    function getFilteredClickUpTasks() {
        const search = String(clickUpProjectSearchValue || '').trim().toLowerCase();
        const statusFilter = String(clickUpProjectStatusFilterValue || '').trim();
        const assigneeFilter = String(clickUpProjectAssigneeFilterValue || '').trim();
        const filtered = clickUpProjectIssues.filter(task => {
            if (task?.parentId) return false;
            if (statusFilter && task.status !== statusFilter) return false;
            if (assigneeFilter === TICKETS_ASSIGNEE_UNASSIGNED) {
                if (Array.isArray(task?.assignees) && task.assignees.length > 0) return false;
            } else if (assigneeFilter) {
                if (!Array.isArray(task?.assignees) || !task.assignees.some(a => _clickUpAssigneeIdentity(a).key === assigneeFilter)) return false;
            }
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
        // Priority first (urgent first), then newest-first by creation date, with a
        // stable title tiebreak. ClickUp priority is an OBJECT ({priority,color,
        // orderindex}) or null — extract orderindex exactly as _renderClickUpTicketCard
        // / _clickUpPriorityName do. 1=Urgent … 4=Low; missing/0 → 99 so unprioritised
        // tasks sink to the bottom of their status group.
        return filtered.sort((a, b) => {
            const pa = Number(a.priority?.orderindex) || 99;
            const pb = Number(b.priority?.orderindex) || 99;
            if (pa !== pb) return pa - pb;
            const aTime = a.dateCreated ? new Date(a.dateCreated).getTime() : 0;
            const bTime = b.dateCreated ? new Date(b.dateCreated).getTime() : 0;
            if (bTime !== aTime) return bTime - aTime;
            return (a.title || '').localeCompare(b.title || '');
        });
    }

    // ── 2c: Empty-state copy ──
    // "No tasks found." is the wrong answer twice over: when NO list is selected (the
    // sidebar has nothing correct to show, and the old behaviour was to dump every
    // list's tickets), and when list/project scoping hid every candidate file — that
    // reads as "this list is empty" and hides a real coverage problem (files imported
    // before the scope key existed in frontmatter). Shared by both provider renderers
    // so the honesty path cannot be half-wired.
    function _ticketsEmptyStateCopy(fallback) {
        if (_ticketsAwaitingListSelection) {
            return 'Select a space and list to see its tickets.';
        }
        const cov = _ticketsScopeCoverage;
        if (cov && cov.hiddenByScope > 0) {
            const n = cov.hiddenByScope;
            const files = `${n} local file${n === 1 ? '' : 's'} for this provider`;
            // Linear scopes on `projectName:`, ClickUp on `listId:` — name the key the
            // user actually has to re-key, or the instruction is unfollowable.
            return lastIntegrationProvider === 'linear'
                ? `${files} don't carry a project name — Refetch this project to re-key them.`
                : `${files} don't carry a list id — Refetch this list to re-key them.`;
        }
        // Reconciliation moved off the read path: selecting a list/project no longer
        // pulls tickets (a read must never fire the destructive delta sweep). So a
        // scoped-but-empty sidebar means "nothing imported yet", NOT "the remote is
        // empty" — name the button that fills it, or the trade reads as a dead panel.
        const hasScope = lastIntegrationProvider === 'linear'
            ? !!linearProjectPickerValue
            : !!clickUpSelectedListId;
        if (hasScope) {
            return lastIntegrationProvider === 'linear'
                ? 'No tickets imported for this project yet — click Refresh to pull them from Linear.'
                : 'No tickets imported for this list yet — click Refresh to pull them from ClickUp.';
        }
        return fallback || 'No tasks found.';
    }

    // ── 2c: List renderers ──

    // Setting issuesContainer.innerHTML resets scrollTop to 0 on the scroll
    // container (#tree-pane-tickets, its parent). Auto-refresh would otherwise
    // snap the user back to the top of the list on every external file change.
    // Save/restore scrollTop across the innerHTML swap; setting scrollTop on a
    // non-scrolling element is a no-op, so this is safe regardless of which
    // ancestor actually scrolls. The DOM-guard above this still skips the swap
    // entirely when nothing changed, so a no-op refresh leaves scroll untouched.
    function _applyTicketsListHtml(container, html) {
        const scrollParent = container.parentElement;
        const savedScroll = scrollParent ? scrollParent.scrollTop : 0;
        const savedSelf = container.scrollTop;
        container.innerHTML = html;
        if (scrollParent) { scrollParent.scrollTop = savedScroll; }
        container.scrollTop = savedSelf;
    }

    function renderTicketsLinearList() {
        closePriorityPopover();
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

        // Drill-down mode: show the selected parent's subtasks as full cards.
        if (_isDrillDownActive('linear')) {
            emptyState.style.display = 'none';
            const subtasks = _drillDownSubtasks || [];
            const drillHtml = _renderDrillDownHeader(_drillDownParentTitle, 'linear') + (subtasks.length === 0
                ? `<div class="empty-state">No subtasks found for this ticket.</div>`
                : subtasks.map(_renderLinearTicketCard).join(''));
            if (_lastTicketsIssuesContainerHtml !== drillHtml) {
                issuesContainer.innerHTML = drillHtml;
                _lastTicketsIssuesContainerHtml = drillHtml;
            }
            return;
        }

        const filteredIssues = getFilteredLinearIssues();
        if (filteredIssues.length === 0) {
            // The backend scopes Linear rows on `projectName:` and reports the same
            // scopeCoverage counts it reports for ClickUp, so the re-key copy must reach
            // Linear users too — otherwise the honesty path is wired for one provider
            // and silent for the other.
            const emptyText = linearProjectIssues.length === 0
                ? _ticketsEmptyStateCopy('No Linear issues are currently available.')
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

        // Normal mode: group by status into collapsible accordion sections. Issues are
        // already sorted by priority then newest-first from getFilteredLinearIssues,
        // so each group stays sorted.
        const groups = _groupTicketsByStatus(filteredIssues, i => i.state?.name || '');
        let newHtml = groups.map(([statusName, groupIssues]) => {
            if (groupIssues.length === 0) return '';
            const cards = groupIssues.map(_renderLinearTicketCard).join('');
            return _renderTicketStatusGroup(statusName, cards, groupIssues.length);
        }).join('');
        // Encode collapsed state into the cache string so collapse/expand always
        // invalidates the DOM-guard (defends against future card-markup that might
        // otherwise hash identically between collapsed and expanded).
        newHtml += `<!-- collapsed:${Array.from(_collapsedTicketStatuses).sort().join(',')} -->`;

        if (_lastTicketsIssuesContainerHtml !== newHtml) {
            _applyTicketsListHtml(issuesContainer, newHtml);
            _lastTicketsIssuesContainerHtml = newHtml;
        }
    }

    function renderTicketsClickUpList() {
        closePriorityPopover();
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

        let html;
        if (_isDrillDownActive('clickup')) {
            // Drill-down mode: show the selected parent's subtasks as full cards.
            const subtasks = _drillDownSubtasks || [];
            html = _renderDrillDownHeader(_drillDownParentTitle, 'clickup') + (subtasks.length === 0
                ? `<div class="empty-state">No subtasks found for this ticket.</div>`
                : subtasks.map(_renderClickUpTicketCard).join(''));
        } else {
            const tasks = getFilteredClickUpTasks();
            if (tasks.length === 0) {
                html = `<div class="empty-state">${_ticketsEmptyStateCopy()}</div>`;
            } else {
                // Normal mode: group by status into collapsible accordion sections. Tasks
                // are already sorted by priority then newest-first from getFilteredClickUpTasks.
                const groups = _groupTicketsByStatus(tasks, t => t.status || '');
                html = groups.map(([statusName, groupTasks]) => {
                    if (groupTasks.length === 0) return '';
                    const cards = groupTasks.map(_renderClickUpTicketCard).join('');
                    return _renderTicketStatusGroup(statusName, cards, groupTasks.length);
                }).join('');
                // Encode collapsed state into the cache string so collapse/expand always
                // invalidates the DOM-guard.
                html += `<!-- collapsed:${Array.from(_collapsedTicketStatuses).sort().join(',')} -->`;
            }
        }

        if (_lastTicketsClickUpIssuesContainerHtml !== html) {
            _applyTicketsListHtml(issuesContainer, html);
            _lastTicketsClickUpIssuesContainerHtml = html;
        }

        if (loadMoreButton) {
            // Pagination doesn't apply to the fixed subtask list in drill-down mode.
            loadMoreButton.style.display = (!_isDrillDownActive('clickup') && clickUpProjectHasMore) ? '' : 'none';
        }
    }

    // ── 2c: Panel renderers ──

    function renderTicketsLinearPanel() {
        if (lastIntegrationProvider !== 'linear' || !isTicketsTabActive()) return;

        const { searchInput, projectPicker, stateFilter, clickUpStatusFilter, assigneeFilter, refreshButton, emptyPreview, hierarchyNav } = getTicketsTabElements();

        // Show Linear toolbar elements
        if (searchInput) searchInput.style.display = '';
        if (projectPicker) projectPicker.style.display = '';
        if (stateFilter) stateFilter.style.display = '';
        if (clickUpStatusFilter) clickUpStatusFilter.style.display = 'none';
        if (assigneeFilter) assigneeFilter.style.display = '';
        if (refreshButton) refreshButton.style.display = '';
        if (hierarchyNav) hierarchyNav.style.display = 'none';

        renderTicketsLinearStateFilterOptions();
        renderTicketsLinearAssigneeFilterOptions();
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

    function renderTicketsClickUpPanel() {
        if (lastIntegrationProvider !== 'clickup' || !isTicketsTabActive()) return;

        const { searchInput, projectPicker, stateFilter, clickUpStatusFilter, assigneeFilter, refreshButton, emptyState, issuesContainer, hierarchyNav, emptyPreview } = getTicketsTabElements();

        // Hide Linear toolbar elements, show ClickUp hierarchy
        if (searchInput) searchInput.style.display = '';
        if (projectPicker) projectPicker.style.display = 'none';
        if (stateFilter) stateFilter.style.display = 'none';
        const showClickUpFilters = (clickUpSelectedListId || clickUpProjectIssues.length > 0) ? '' : 'none';
        if (clickUpStatusFilter) {
            clickUpStatusFilter.style.display = showClickUpFilters;
        }
        if (assigneeFilter) {
            assigneeFilter.style.display = showClickUpFilters;
        }
        if (refreshButton) refreshButton.style.display = '';
        // In move mode the hierarchy nav display is managed by showMoveTicketModal
        // (set to 'flex' for ClickUp move-target browsing). Don't reset it here —
        // resetting to '' would fall back to the inline display:none and hide the nav
        // mid-browse.
        if (hierarchyNav && !_moveMode) hierarchyNav.style.display = '';

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
            renderTicketsClickUpAssigneeFilterOptions();
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

    // ── 2c: Local file load + sync-status request ──

    function loadLocalTicketFiles() {
        // Do NOT bail when ticketsWorkspaceRoot is empty — the Tickets tab has no
        // explicit workspace assignment, so the root is resolved on the backend
        // (via _resolveWorkspaceRoot), exactly like loadClickUpProject/loadLinearProject.
        // Guarding on a falsy root here left the (now files-only) sidebar permanently
        // blank even though the import wrote every file and the DB held every row.
        if (!lastIntegrationProvider) return;

        const effectiveListId = lastIntegrationProvider === 'clickup' ? (clickUpSelectedListId || undefined) : undefined;
        const effectiveProjectId = lastIntegrationProvider === 'linear' ? (linearProjectPickerValue || undefined) : undefined;

        if (lastIntegrationProvider === 'clickup' && !effectiveListId) {
            _ticketsListedUnscoped = true;
            window.dispatchEvent(new MessageEvent('message', {
                data: {
                    type: 'localTicketFilesListed',
                    provider: 'clickup',
                    workspaceRoot: ticketsWorkspaceRoot || undefined,
                    tickets: [],
                    unscopedPlaceholder: true
                }
            }));
            return;
        }

        if (effectiveListId || effectiveProjectId) {
            _ticketsListedUnscoped = false;
        } else {
            _ticketsListedUnscoped = true;
        }

        vscode.postMessage({
            type: 'listLocalTicketFiles',
            provider: lastIntegrationProvider,
            workspaceRoot: ticketsWorkspaceRoot || undefined,
            // Scope the sidebar to the selected list (ClickUp). Linear stays unscoped
            // for now (name-based picker). Sent on every call site since they all
            // read the current selection from these globals.
            listId: effectiveListId,
            projectId: effectiveProjectId
        });
    }

    function _requestTicketSyncStatuses() {
        // Same fix as loadLocalTicketFiles: don't bail on an empty workspace root
        // (the Tickets tab has none) — let the backend resolve it.
        if (!lastIntegrationProvider) return;
        const issues = lastIntegrationProvider === 'clickup' ? clickUpProjectIssues : linearProjectIssues;
        // Drill-down subtasks are rendered as full cards with the same badge, but they
        // arrive from the detail fetch carrying no syncStatus. Fold their ids into the
        // SAME request so they inherit this request's scope stamp — a second, unscoped
        // request would be discarded by _isForThisPanel on the way back.
        const drillIds = _isDrillDownActive(lastIntegrationProvider)
            ? (_drillDownSubtasks || []).map(s => s.id).filter(Boolean)
            : [];
        const ids = Array.from(new Set([...issues.map(t => t.id), ...drillIds])).filter(Boolean);
        if (ids.length === 0) return;
        vscode.postMessage({
            type: 'getTicketSyncStatuses',
            provider: lastIntegrationProvider,
            ids,
            workspaceRoot: ticketsWorkspaceRoot || undefined,
            // Pass the scope id so the backend can stamp it on the broadcast reply
            // (cross-panel contamination fix). ClickUp scopes by listId; Linear has
            // no server-side project scope but the picker value is sent for stamping.
            listId: lastIntegrationProvider === 'clickup' ? (clickUpSelectedListId || undefined) : undefined,
            projectId: lastIntegrationProvider === 'linear' ? (linearProjectPickerValue || undefined) : undefined
        });
    }

    // One sidebar reload per burst of ticket-file changes. An agent rewriting 30
    // ticket files fires 30 watcher events; without this the sidebar reloads 30
    // times and visibly thrashes. 300ms matches the backend watcher's own per-file
    // debounce (TicketsPanelProvider._setupTicketsViewWatcher), so the two stages
    // compose to roughly one reload per burst rather than one per file. Trailing-
    // edge: a reload already in flight is not cancelled by a later event, and two
    // bursts within the window collapse to one reload.
    let _ticketFileChangedDebounce = null;
    function _scheduleSidebarRefreshFromFiles() {
        clearTimeout(_ticketFileChangedDebounce);
        _ticketFileChangedDebounce = setTimeout(() => {
            _ticketFileChangedDebounce = null;
            loadLocalTicketFiles();
        }, 300);
    }

    // ── 2d: detail renderers + meta-bar helpers + comment helpers ──
    // Moved verbatim from planning.js. escapeHtml / escapeAttr are sharedUtils.js
    // globals (NOT re-declared here — re-declaring re-opens a divergence a prior
    // plan closed). _closeAllOverflowPopovers / _recomputeAllOverflowTriggers are
    // likewise sharedUtils.js globals.

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

    function _getSelectedParentId() {
        if (lastIntegrationProvider === 'linear') {
            const issue = selectedLinearIssue?.issue;
            return issue?.parentId || issue?.parent?.id || null;
        } else {
            const task = selectedClickUpIssue?.task;
            return task?.parentId || task?.parent || null;
        }
    }

    // Meta-bar button swap: a subtask shows "To parent task" and hides the subtask-
    // creation buttons (which would otherwise create a sub-subtask / re-parent the
    // subtask — confusing). A top-level ticket shows the subtask buttons.
    function _toggleSubtaskMetaButtons() {
        const parentId = _getSelectedParentId();
        const btnAddSubtask = document.getElementById('btn-add-subtask');
        const btnConvertSubtask = document.getElementById('btn-convert-subtask');
        const btnToParent = document.getElementById('btn-to-parent-task');
        if (parentId) {
            if (btnAddSubtask) btnAddSubtask.style.display = 'none';
            if (btnConvertSubtask) btnConvertSubtask.style.display = 'none';
            if (btnToParent) btnToParent.style.display = '';
        } else {
            if (btnAddSubtask) btnAddSubtask.style.display = '';
            if (btnConvertSubtask) btnConvertSubtask.style.display = '';
            if (btnToParent) btnToParent.style.display = 'none';
        }
        // "Push + subtasks" is meaningful only on a parent that has LOCALLY-IMPORTED
        // subtasks. A subtask has no children (edge case 2), and a parent with no
        // local subtask files has nothing extra to push (edge case 1) — disable in
        // both cases rather than hide, so the control stays a stable part of the bar.
        //
        // The gate MUST agree with the push: _localSubtaskIdsFor discovers children
        // from LOCAL files carrying `parentId:` frontmatter, NOT from the remote
        // subtask list. The detail cache's `subtasks` array is the REMOTE list, so
        // gating on it would enable the button for a parent whose subtasks exist
        // remotely but were never imported — the button would then push only the
        // parent and report "1 pushed", silently degrading to the plain Push beside
        // it. Use the file-derived count the sidebar card already carries
        // (listLocalTicketFiles → subtaskCount, counted from parentId frontmatter),
        // looked up on the card list — not _ticketSubtaskCount, which prefers the
        // cache and would reintroduce the remote number.
        const btnPushSubtasks = document.getElementById('btn-push-ticket-subtasks');
        if (btnPushSubtasks) {
            const id = lastIntegrationProvider === 'linear'
                ? selectedLinearIssue?.issue?.id
                : selectedClickUpIssue?.task?.id;
            const list = lastIntegrationProvider === 'linear' ? linearProjectIssues : clickUpProjectIssues;
            const card = id ? list.find(t => t.id === id) : null;
            const localSubtaskCount = card ? (card.subtaskCount || 0) : 0;
            btnPushSubtasks.disabled = !!(parentId) || localSubtaskCount === 0;
        }
        // Recompute the meta-bar "⋯ More" trigger visibility: if every item inside
        // the popover is now hidden (e.g. minimal-capability provider), hide the
        // trigger too. Items live inside the popover DOM but keep their ids, so the
        // gating toggles above still resolve them by getElementById.
        _recomputeAllOverflowTriggers();
    }

    function _availableClickUpPriorities() {
        const prioritiesMap = new Map();
        const defaultPriorities = [
            { value: 0, name: 'No priority', color: '#95a2b3' },
            { value: 1, name: 'Urgent', color: '#f30000' },
            { value: 2, name: 'High', color: '#ffcc00' },
            { value: 3, name: 'Normal', color: '#6f85ff' },
            { value: 4, name: 'Low', color: '#d3d3d3' }
        ];
        defaultPriorities.forEach(p => prioritiesMap.set(p.value, p));

        clickUpProjectIssues.forEach(t => {
            if (t.priority && t.priority.orderindex) {
                const val = Number(t.priority.orderindex);
                if (val >= 1 && val <= 4) {
                    prioritiesMap.set(val, {
                        value: val,
                        name: t.priority.priority.charAt(0).toUpperCase() + t.priority.priority.slice(1),
                        color: t.priority.color
                    });
                }
            }
        });

        return Array.from(prioritiesMap.values()).sort((a, b) => a.value - b.value);
    }

    // ── 2d: assign/tags modal list renderers (moved from planning.js) ──

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

    function renderAssignModalList(filterText = '') {
        const availableList = document.getElementById('assign-available-list');
        if (!availableList) return;

        if (_assignMembersLoading) return;

        availableList.innerHTML = '';
        const provider = lastIntegrationProvider;

        const nobodyItem = document.createElement('div');
        nobodyItem.style.display = 'flex';
        nobodyItem.style.alignItems = 'center';
        nobodyItem.style.gap = '8px';
        nobodyItem.style.padding = '4px 0';

        const nobodyInput = document.createElement('input');
        nobodyInput.type = provider === 'linear' ? 'radio' : 'checkbox';
        nobodyInput.name = 'assignee-selection';
        nobodyInput.value = '__unassigned__';
        nobodyInput.id = 'assignee-nobody';
        nobodyInput.checked = (_currentAssigneeIds.length === 0);

        const nobodyLabel = document.createElement('label');
        nobodyLabel.htmlFor = 'assignee-nobody';
        nobodyLabel.style.fontSize = '12px';
        nobodyLabel.style.cursor = 'pointer';
        nobodyLabel.style.color = 'var(--text-secondary)';
        nobodyLabel.textContent = 'Nobody / Unassigned';

        nobodyItem.appendChild(nobodyInput);
        nobodyItem.appendChild(nobodyLabel);
        availableList.appendChild(nobodyItem);

        if (provider === 'linear') {
            nobodyInput.addEventListener('change', () => {
                if (nobodyInput.checked) {
                    const radios = availableList.querySelectorAll('input[name="assignee-selection"]');
                    radios.forEach(r => { if (r !== nobodyInput) r.checked = false; });
                }
            });
        } else {
            nobodyInput.addEventListener('change', () => {
                if (nobodyInput.checked) {
                    const checkboxes = availableList.querySelectorAll('input[name="assignee-selection"]');
                    checkboxes.forEach(cb => { if (cb !== nobodyInput) cb.checked = false; });
                }
            });
        }

        const query = filterText.toLowerCase().trim();
        const filtered = _assignMembers.filter(m => {
            const name = String(m.name || m.username || '').toLowerCase();
            const email = String(m.email || '').toLowerCase();
            return name.includes(query) || email.includes(query);
        });

        filtered.forEach(m => {
            const item = document.createElement('div');
            item.style.display = 'flex';
            item.style.alignItems = 'center';
            item.style.gap = '8px';
            item.style.padding = '4px 0';

            const input = document.createElement('input');
            input.type = provider === 'linear' ? 'radio' : 'checkbox';
            input.name = 'assignee-selection';
            input.value = m.id;
            input.id = `assignee-${m.id}`;
            input.checked = _currentAssigneeIds.includes(String(m.id)) && nobodyInput.checked === false;

            const label = document.createElement('label');
            label.htmlFor = `assignee-${m.id}`;
            label.style.fontSize = '12px';
            label.style.cursor = 'pointer';
            label.style.color = 'var(--text-primary)';
            label.textContent = m.name + (m.email ? ` (${m.email})` : '');

            item.appendChild(input);
            item.appendChild(label);
            availableList.appendChild(item);

            input.addEventListener('change', () => {
                if (input.checked) {
                    nobodyInput.checked = false;
                    if (provider === 'linear') {
                        const radios = availableList.querySelectorAll('input[name="assignee-selection"]');
                        radios.forEach(r => { if (r !== input) r.checked = false; });
                    }
                }
            });
        });

        if (filtered.length === 0 && query !== '') {
            const empty = document.createElement('div');
            empty.style.padding = '8px';
            empty.style.fontSize = '12px';
            empty.style.color = 'var(--text-secondary)';
            empty.textContent = 'No members match search.';
            availableList.appendChild(empty);
        }
    }

    function _renderCreateModalAssignees() {
        const container = document.getElementById('create-ticket-assignees');
        if (!container) return;
        const provider = lastIntegrationProvider;
        if (_assignMembersLoading) {
            container.innerHTML = '<div style="font-size: 12px; color: var(--text-secondary);">Loading members…</div>';
            return;
        }
        if (!_assignMembers || _assignMembers.length === 0) {
            container.innerHTML = '<div style="font-size: 12px; color: var(--text-secondary);">No members available.</div>';
            return;
        }
        const inputType = provider === 'linear' ? 'radio' : 'checkbox';
        container.innerHTML = _assignMembers.map(m => {
            const idStr = escapeAttr(String(m.id));
            const labelTxt = escapeHtml(m.name + (m.email ? ` (${m.email})` : ''));
            return `<div style="display:flex;align-items:center;gap:8px;padding:3px 0;">
                <input type="${inputType}" name="create-ticket-assignee" value="${idStr}" id="cta-${idStr}" />
                <label for="cta-${idStr}" style="font-size:12px;cursor:pointer;color:var(--text-primary);">${labelTxt}</label>
            </div>`;
        }).join('');
    }

    // ── 2d: detail-pane + meta-bar helper functions (moved from planning.js) ──

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
    function selectPriority(value) {
        if (!_openPriorityPopoverFor) return;
        // In-flight guard: the optimistic re-render below rebuilds the dot without the
        // `.busy` class, so the DOM-class disable cannot prevent a duplicate update.
        // Gate on the pending-change state instead — one priority write at a time.
        if (_pendingPriorityChange) { closePriorityPopover(); return; }
        const { provider, ticketId, preValue, dotEl } = _openPriorityPopoverFor;
        closePriorityPopover();

        _pendingPriorityChange = { provider, ticketId, preValue };

        if (dotEl) {
            dotEl.classList.add('busy');
        }

        if (provider === 'linear') {
            const issue = linearProjectIssues.find(i => i.id === ticketId);
            if (issue) issue.priority = value;
            if (selectedLinearIssue?.issue?.id === ticketId) {
                selectedLinearIssue.issue.priority = value;
            }
            renderTicketsLinearList();

            vscode.postMessage({
                type: 'linearUpdateIssuePriority',
                issueId: ticketId,
                priority: value,
                workspaceRoot: ticketsWorkspaceRoot
            });
        } else {
            const task = clickUpProjectIssues.find(t => t.id === ticketId);
            if (task) {
                if (value === 0) {
                    task.priority = null;
                } else {
                    const opt = _availableClickUpPriorities().find(o => o.value === value) || { name: 'Normal', color: '#6f85ff' };
                    task.priority = {
                        id: String(value),
                        priority: opt.name.toLowerCase(),
                        color: opt.color,
                        orderindex: String(value)
                    };
                }
            }
            if (selectedClickUpIssue?.task?.id === ticketId) {
                if (value === 0) {
                    selectedClickUpIssue.task.priority = null;
                } else {
                    const opt = _availableClickUpPriorities().find(o => o.value === value) || { name: 'Normal', color: '#6f85ff' };
                    selectedClickUpIssue.task.priority = {
                        id: String(value),
                        priority: opt.name.toLowerCase(),
                        color: opt.color,
                        orderindex: String(value)
                    };
                }
            }
            renderTicketsClickUpList();

            vscode.postMessage({
                type: 'clickupUpdateTaskPriority',
                taskId: ticketId,
                priority: value,
                workspaceRoot: ticketsWorkspaceRoot
            });
        }
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
            case 'ul': case 'ol': {
                const ordered = tag === 'ol';
                const items = Array.from(node.children).filter(c => c.tagName === 'LI');
                return items.map((li, i) => {
                    const prefix = ordered ? `${i + 1}. ` : '- ';
                    // A loose item carries its gap back out as a blank line, so a
                    // render → serialise round trip is spacing-preserving. htmlToMarkdown's
                    // /\n{3,}/ -> '\n\n' collapse is why this emits exactly one blank line.
                    const gap = (i > 0 && li.classList.contains('md-li-loose')) ? '\n' : '';
                    return `${gap}${prefix}${nodeToMarkdown(li).trim()}\n`;
                }).join('') + '\n';
            }
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
    function showTicketStatusModal(provider, ticketId) {
        const modal = document.getElementById('ticket-status-modal');
        const select = document.getElementById('ticket-status-select');
        const loading = document.getElementById('ticket-status-modal-loading');
        const saveBtn = document.getElementById('btn-save-ticket-status');
        if (!modal || !select) return;

        // Resolve the clicked ticket to find its current status id/name.
        let currentStatusId = '';
        let currentStatusName = '';
        if (provider === 'linear') {
            const issue = linearProjectIssues.find(i => i.id === ticketId)
                || (_drillDownSubtasks && _drillDownSubtasks.find(s => s.id === ticketId))
                || selectedLinearIssue?.issue;
            const iss = issue && issue.id ? issue : selectedLinearIssue?.issue;
            currentStatusId = iss?.state?.id || '';
            currentStatusName = iss?.state?.name || '';
        } else {
            const task = clickUpProjectIssues.find(t => t.id === ticketId)
                || (_drillDownSubtasks && _drillDownSubtasks.find(s => s.id === ticketId))
                || selectedClickUpIssue?.task;
            const tsk = task && task.id ? task : selectedClickUpIssue?.task;
            currentStatusName = tsk?.status || '';
        }

        // Build options. Linear: availableLinearStates (id+name), fallback to deriving
        // a name→id map from linearProjectIssues. ClickUp: availableClickUpStatuses
        // (status+id), fallback to deriving a name→id map from clickUpProjectIssues.
        let options = [];
        if (provider === 'linear') {
            if (availableLinearStates && availableLinearStates.length > 0) {
                options = availableLinearStates.map(s => ({ id: s.id, name: s.name }));
            } else {
                const stateMap = new Map();
                linearProjectIssues.forEach(i => {
                    if (i.state && i.state.id && i.state.name) stateMap.set(i.state.name, i.state.id);
                });
                options = Array.from(stateMap.entries()).map(([name, id]) => ({ id, name }));
            }
        } else {
            if (availableClickUpStatuses && availableClickUpStatuses.length > 0) {
                // ClickUp: use the status NAME as the option value (changeTicketStatus
                // receives the name, and changeTicketStatusResult sets task.status from
                // option text), matching the backend's expected status format.
                options = availableClickUpStatuses.map(s => ({ id: s.status || s.name || s.id, name: s.status || s.name || s.id }));
            } else {
                const stateMap = new Map();
                clickUpProjectIssues.forEach(t => {
                    if (t.status) stateMap.set(t.status, t.status);
                });
                options = Array.from(stateMap.entries()).map(([name, id]) => ({ id, name }));
            }
        }

        if (options.length === 0) {
            select.innerHTML = '';
            if (loading) {
                loading.style.display = '';
                loading.textContent = 'Loading statuses…';
            }
            if (saveBtn) saveBtn.disabled = true;
        } else {
            if (loading) loading.style.display = 'none';
            select.innerHTML = options.map(o => {
                const selected = (o.id === currentStatusId) || (o.name === currentStatusName) ? 'selected' : '';
                return `<option value="${escapeAttr(o.id)}" ${selected}>${escapeHtml(o.name)}</option>`;
            }).join('');
            if (saveBtn) saveBtn.disabled = false;
        }

        // Stash the target so Save can post without re-reading DOM dataset.
        _statusModalProvider = provider;
        _statusModalTicketId = ticketId;

        modal.style.display = 'flex';
    }

    function closeTicketStatusModal() {
        const modal = document.getElementById('ticket-status-modal');
        if (modal) modal.style.display = 'none';
        _statusModalProvider = null;
        _statusModalTicketId = null;
    }
    function openAssignModal() {
        const modal = document.getElementById('assign-modal');
        const availableList = document.getElementById('assign-available-list');
        const searchInput = document.getElementById('assign-search');

        if (!modal || !availableList) return;

        if (searchInput) searchInput.value = '';

        _assignModalOpen = true;

        const provider = lastIntegrationProvider;
        const ticketId = provider === 'linear'
            ? selectedLinearIssue?.issue?.id
            : selectedClickUpIssue?.task?.id;
        const listId = provider === 'clickup'
            ? selectedClickUpIssue?.task?.list?.id
            : null;

        if (!ticketId) {
            showTicketsStatus('No ticket selected', true);
            return;
        }

        if (provider === 'linear') {
            const assigneeId = selectedLinearIssue?.issue?.assignee?.id;
            _currentAssigneeIds = assigneeId ? [assigneeId] : [];
        } else {
            _currentAssigneeIds = (selectedClickUpIssue?.task?.assignees || []).map(a => String(a.id));
        }

        _assignMembersLoading = true;
        availableList.innerHTML = '<div style="padding: 12px; text-align: center; color: var(--text-secondary);">Loading members...</div>';
        
        vscode.postMessage({
            type: 'loadTicketAssignees',
            provider,
            id: ticketId,
            listId,
            workspaceRoot: ticketsWorkspaceRoot
        });

        modal.style.display = 'flex';
    }

    function closeAssignModal() {
        const modal = document.getElementById('assign-modal');
        if (modal) {
            modal.style.display = 'none';
        }
        _assignModalOpen = false;
        _assignMembersLoading = false;
    }
    function saveAssign() {
        const availableList = document.getElementById('assign-available-list');
        if (!availableList) return;

        const provider = lastIntegrationProvider;
        const ticketId = provider === 'linear'
            ? selectedLinearIssue?.issue?.id
            : selectedClickUpIssue?.task?.id;

        if (!ticketId) {
            showTicketsStatus('No ticket selected', true);
            return;
        }

        const nobodyInput = document.getElementById('assignee-nobody');
        // Guard: if the member list has not rendered yet (still loading, or a load
        // error left the "Loading members..." placeholder in place), the selection
        // set is empty and Save would fall into the unassign branch and silently
        // clear the assignee. Block Save until a real list (incl. the Nobody row) exists.
        if (_assignMembersLoading || !nobodyInput) {
            showTicketsStatus('Members are still loading — please try again in a moment', true);
            return;
        }
        const checkboxes = availableList.querySelectorAll('input[name="assignee-selection"]:checked');
        const selectedIds = Array.from(checkboxes).map(cb => cb.value).filter(val => val !== '__unassigned__');

        if (nobodyInput?.checked || selectedIds.length === 0) {
            if (provider === 'linear') {
                vscode.postMessage({
                    type: 'linearUpdateIssueAssignee',
                    issueId: ticketId,
                    assigneeId: null,
                    workspaceRoot: ticketsWorkspaceRoot
                });
            } else {
                vscode.postMessage({
                    type: 'clickupUpdateTaskAssignees',
                    taskId: ticketId,
                    currentAssigneeIds: _currentAssigneeIds,
                    desiredAssigneeIds: [],
                    workspaceRoot: ticketsWorkspaceRoot
                });
            }
        } else {
            if (provider === 'linear') {
                if (selectedIds.length > 1) {
                    showTicketsStatus('Linear only supports a single assignee', true);
                    return;
                }
                vscode.postMessage({
                    type: 'linearUpdateIssueAssignee',
                    issueId: ticketId,
                    assigneeId: selectedIds[0],
                    workspaceRoot: ticketsWorkspaceRoot
                });
            } else {
                vscode.postMessage({
                    type: 'clickupUpdateTaskAssignees',
                    taskId: ticketId,
                    currentAssigneeIds: _currentAssigneeIds,
                    desiredAssigneeIds: selectedIds,
                    workspaceRoot: ticketsWorkspaceRoot
                });
            }
        }

        closeAssignModal();
    }

    function _populateCreateModalStatus() {
        const select = document.getElementById('create-ticket-status');
        if (!select) return;
        const provider = lastIntegrationProvider;
        let options = [];
        if (provider === 'linear') {
            if (availableLinearStates && availableLinearStates.length > 0) {
                options = availableLinearStates.map(s => ({ id: s.id, name: s.name }));
            } else {
                const stateMap = new Map();
                linearProjectIssues.forEach(i => {
                    if (i.state && i.state.id && i.state.name) stateMap.set(i.state.name, i.state.id);
                });
                options = Array.from(stateMap.entries()).map(([name, id]) => ({ id, name }));
            }
        } else {
            if (availableClickUpStatuses && availableClickUpStatuses.length > 0) {
                options = availableClickUpStatuses.map(s => ({ id: s.status || s.name || s.id, name: s.status || s.name || s.id }));
            } else {
                const stateMap = new Map();
                clickUpProjectIssues.forEach(t => {
                    if (t.status) stateMap.set(t.status, t.status);
                });
                options = Array.from(stateMap.entries()).map(([name, id]) => ({ id, name }));
            }
        }
        select.innerHTML = '<option value="">Default</option>' +
            options.map(o => `<option value="${escapeAttr(o.id)}">${escapeHtml(o.name)}</option>`).join('');
    }

    function _populateCreateModalPriority() {
        const select = document.getElementById('create-ticket-priority');
        if (!select) return;
        const provider = lastIntegrationProvider;
        const opts = provider === 'linear'
            ? [
                { value: 0, name: 'No priority' },
                { value: 1, name: 'Urgent' },
                { value: 2, name: 'High' },
                { value: 3, name: 'Normal' },
                { value: 4, name: 'Low' }
              ]
            : _availableClickUpPriorities();
        select.innerHTML = '<option value="">Default</option>' +
            opts.map(o => `<option value="${o.value}">${escapeHtml(o.name)}</option>`).join('');
    }

    function _renderCreateModalAssignees() {
        const container = document.getElementById('create-ticket-assignees');
        if (!container) return;
        const provider = lastIntegrationProvider;
        if (_assignMembersLoading) {
            container.innerHTML = '<div style="font-size: 12px; color: var(--text-secondary);">Loading members…</div>';
            return;
        }
        if (!_assignMembers || _assignMembers.length === 0) {
            container.innerHTML = '<div style="font-size: 12px; color: var(--text-secondary);">No members available.</div>';
            return;
        }
        const inputType = provider === 'linear' ? 'radio' : 'checkbox';
        container.innerHTML = _assignMembers.map(m => {
            const idStr = escapeAttr(String(m.id));
            const labelTxt = escapeHtml(m.name + (m.email ? ` (${m.email})` : ''));
            return `<div style="display:flex;align-items:center;gap:8px;padding:3px 0;">
                <input type="${inputType}" name="create-ticket-assignee" value="${idStr}" id="cta-${idStr}" />
                <label for="cta-${idStr}" style="font-size:12px;cursor:pointer;color:var(--text-primary);">${labelTxt}</label>
            </div>`;
        }).join('');
    }

    function _loadCreateModalMembers() {
        const provider = lastIntegrationProvider;
        const container = document.getElementById('create-ticket-assignees');
        if (container) container.innerHTML = '<div style="font-size: 12px; color: var(--text-secondary);">Loading members…</div>';
        _assignMembersLoading = true;
        _assignMembers = [];
        // Brand-new ticket has no id; use the dedicated members-by-list/project load.
        vscode.postMessage({
            type: 'loadTicketMembers',
            provider,
            listId: clickUpSelectedListId || selectedClickUpIssue?.task?.list?.id || undefined,
            projectName: linearProjectPickerValue || undefined,
            workspaceRoot: ticketsWorkspaceRoot
        });
    }

    function _resetCreateModalMetadata() {
        const s = document.getElementById('create-ticket-status'); if (s) s.value = '';
        const p = document.getElementById('create-ticket-priority'); if (p) p.value = '';
        const a = document.getElementById('create-ticket-assignees');
        if (a) a.querySelectorAll('input').forEach(i => i.checked = false);
    }

    function _collectCreateModalAssignees() {
        const provider = lastIntegrationProvider;
        const container = document.getElementById('create-ticket-assignees');
        if (!container) return undefined;
        const checked = Array.from(container.querySelectorAll('input[name="create-ticket-assignee"]:checked')).map(i => i.value);
        if (checked.length === 0) return undefined;
        return provider === 'linear' ? checked[0] : checked; // Linear: single id string; ClickUp: string[]
    }
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

    function renderCommentBodyHtml(thread) {
        // If bodyParts is available, render structured content (text + emoji + images).
        // Otherwise, fall back to escaped body string (Linear, optimistic inserts, old data).
        if (Array.isArray(thread.bodyParts) && thread.bodyParts.length > 0) {
            let html = '';
            for (const part of thread.bodyParts) {
                if (part.type === 'text') {
                    html += escapeHtml(part.text || '');
                } else if (part.type === 'emoji') {
                    // Emoji characters are Unicode — safe to render directly.
                    // escapeHtml won't mangle them (they're not <, >, or &), but
                    // we escape anyway for consistency in case of unexpected content.
                    html += escapeHtml(part.text || '');
                } else if (part.type === 'image') {
                    // Only allow https: and data: schemes (matches CSP img-src).
                    const url = part.url || '';
                    if (url.startsWith('https://') || url.startsWith('data:')) {
                        html += '<img src="' + escapeAttr(url) + '" alt="' + escapeAttr(part.alt || 'attachment') + '" class="cm-comment-image" />';
                    } else {
                        html += escapeHtml('[' + (part.alt || 'attachment') + ']');
                    }
                }
            }
            return html;
        }
        return escapeHtml(thread.body || '');
    }

    function renderThreadHtml(thread) {
        const optimisticClass = thread._optimistic ? ' cm-optimistic' : '';
        const authorName = escapeHtml(thread.author?.name || thread.author?.email || 'Unknown');
        const dateStr = escapeHtml(formatCommentDate(thread.date));
        const bodyHtml = renderCommentBodyHtml(thread);
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
        const bodyHtml = renderCommentBodyHtml(reply);
        let html = '<div class="cm-reply' + optimisticClass + '" data-reply-id="' + escapeHtml(reply.id) + '">';
        html += '<div class="cm-reply-header">';
        html += '<span class="cm-reply-author">' + authorName + '</span>';
        html += '<span class="cm-reply-date">' + dateStr + '</span>';
        html += '</div>';
        html += '<div class="cm-reply-body">' + bodyHtml + '</div>';
        html += '</div>';
        return html;
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

    /**
     * Merge optimistic replies from oldThreads into newThreads.
     * - For each optimistic reply in oldThreads that has a matching real reply
     *   in newThreads (matched by body content), the optimistic entry is replaced
     *   by the real one (which has a proper ID and author info).
     * - For each optimistic reply with NO match in newThreads, it is preserved
     *   (appended to the corresponding thread's replies).
     *
     * Note: The _optimistic flag is set by the callers of optimisticInsertComment
     * (lines 827, 7993), not by optimisticInsertComment itself. Backend data
     * never includes _optimistic.
     */
    function mergeOptimisticReplies(oldThreads, newThreads) {
        if (!oldThreads || !oldThreads.length) return newThreads;
        const oldOptimistic = [];
        // Collect all optimistic entries with their parent thread IDs
        for (const thread of oldThreads) {
            if (thread._optimistic) {
                oldOptimistic.push({ entry: thread, parentId: null });
            }
            if (thread.replies) {
                for (const reply of thread.replies) {
                    if (reply._optimistic) {
                        oldOptimistic.push({ entry: reply, parentId: thread.id });
                    }
                }
            }
        }
        if (!oldOptimistic.length) return newThreads;

        // For each optimistic entry, check if a matching real entry exists in newThreads
        for (const { entry, parentId } of oldOptimistic) {
            const matched = findMatchingRealEntry(newThreads, entry, parentId);
            if (!matched) {
                // No match — preserve the optimistic entry
                if (parentId) {
                    const thread = newThreads.find(t => t.id === parentId);
                    if (thread) {
                        thread.replies = thread.replies || [];
                        if (!thread.replies.some(r => r._optimistic && r.body === entry.body)) {
                            thread.replies.push(entry);
                        }
                    }
                } else {
                    // Top-level optimistic thread
                    if (!newThreads.some(t => t._optimistic && t.body === entry.body)) {
                        newThreads.push(entry);
                    }
                }
            }
            // If matched, the real entry is already in newThreads — do nothing (optimistic is dropped)
        }
        return newThreads;
    }

    /**
     * Check if a real (non-optimistic) entry matching the optimistic entry exists.
     * Match by body content (trimmed, case-insensitive) within the same thread.
     * Known limitation: may fail if the API normalizes content differently from
     * user input (e.g. mention syntax, markdown rendering).
     */
    function findMatchingRealEntry(threads, optimisticEntry, parentId) {
        if (parentId) {
            const thread = threads.find(t => t.id === parentId);
            if (thread && thread.replies) {
                return thread.replies.find(r =>
                    !r._optimistic &&
                    (r.body || '').trim().toLowerCase() === (optimisticEntry.body || '').trim().toLowerCase()
                );
            }
        } else {
            return threads.find(t =>
                !t._optimistic &&
                (t.body || '').trim().toLowerCase() === (optimisticEntry.body || '').trim().toLowerCase()
            );
        }
        return null;
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

    // ── Attachments list modal renderer (moved from planning.js, slice 2e) ──
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
                            <a href="${escapeAttr(url)}" target="_blank" rel="noopener noreferrer" class="strip-btn" style="font-size: 11px; padding: 2px 6px;">Open remote</a>
                            <button class="strip-btn download-attachment-modal-btn" data-url="${escapeAttr(url)}" data-filename="${escapeAttr(filename)}" data-attachment-id="${escapeAttr(att.id || '')}" style="font-size: 11px; padding: 2px 6px; background: var(--accent-teal, #00ffcc); color: black;">Download</button>
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
                // NEW: inline image preview for image files
                if (att.webviewUri) {
                    const ext = (filename || '').split('.').pop().toLowerCase();
                    const imageExts = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp'];
                    if (imageExts.includes(ext)) {
                        html += `
                            <div style="margin-top: 6px; border: 1px solid var(--border-color); border-radius: 4px; overflow: hidden; background: var(--panel-bg);">
                                <img src="${escapeAttr(att.webviewUri)}"
                                     style="display: block; max-width: 100%; max-height: 300px; object-fit: contain; cursor: pointer;"
                                     data-local-path="${escapeAttr(localPath)}"
                                     class="inline-attachment-img" />
                            </div>
                        `;
                    }
                }
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
                const attachmentId = btn.dataset.attachmentId;
                const provider = lastIntegrationProvider;
                const ticketId = provider === 'linear' ? selectedLinearIssue?.issue?.id : selectedClickUpIssue?.task?.id;
                const ticketTitle = provider === 'linear' ? selectedLinearIssue?.issue?.title : selectedClickUpIssue?.task?.title;
                vscode.postMessage({
                    type: 'downloadAttachment',
                    workspaceRoot: ticketsWorkspaceRoot,
                    provider,
                    url,
                    filename,
                    attachmentId,
                    ticketId,
                    ticketTitle
                });
            });
        });

        // Click handler for inline images
        attachmentsList.querySelectorAll('.inline-attachment-img').forEach(img => {
            img.addEventListener('click', () => {
                const localPath = img.dataset.localPath;
                vscode.postMessage({
                    type: 'openAttachment',
                    workspaceRoot: ticketsWorkspaceRoot,
                    localPath
                });
            });
        });
    }

    function _refreshSelectedTicketFromFile() {
        if (ticketsEditMode) return; // never clobber an active edit
        if (lastIntegrationProvider === 'linear' && selectedLinearIssue?.issue?.id) {
            vscode.postMessage({ type: 'readLocalTicketFile', provider: 'linear', id: selectedLinearIssue.issue.id, workspaceRoot: ticketsWorkspaceRoot });
        } else if (lastIntegrationProvider === 'clickup' && selectedClickUpIssue?.task?.id) {
            vscode.postMessage({ type: 'readLocalTicketFile', provider: 'clickup', id: selectedClickUpIssue.task.id, workspaceRoot: ticketsWorkspaceRoot });
        }
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
        document.getElementById('btn-push-ticket-subtasks').style.display = 'none';
        document.getElementById('btn-delete-ticket').style.display = 'none';
        document.getElementById('btn-save-ticket-edit').style.display = '';
        document.getElementById('btn-cancel-ticket-edit').style.display = '';

        const detailContent = document.getElementById('tickets-detail-content');
        if (!detailContent) return;

        const comments = issue.comments || [];
        const attachments = issue.attachments || [];
        let html = `<h1 id="ticket-edit-title" contenteditable="true" spellcheck="true" style="border:1px solid var(--border-color);outline:none;border-radius:4px;padding:4px 8px;">${escapeHtml(task.title || task.identifier || task.id)}</h1>`;
        html += `<textarea id="ticket-edit-description" class="markdown-editor" spellcheck="true" style="min-height:480px;height:auto;resize:vertical;white-space:pre-wrap;line-height:1.6;">${escapeHtml(descMarkdown)}</textarea>`;

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
            html += attachments.map(a => `<button type="button" class="tickets-attachment-item" data-attachment-id="${escapeAttr(a.id || '')}" data-clickup-attachment-url="${escapeAttr(a.url || '')}">${escapeHtml(a.title || a.filename || a.url || 'Attachment')}</button>`).join('');
        }

        _lastTicketsClickUpDetailContentHtml = '';
        _lastTicketsDetailContentHtml = '';
        detailContent.innerHTML = html;
        detailContent.classList.add('edit-mode');

        const descTextarea = document.getElementById('ticket-edit-description');
        if (descTextarea && window.SwitchboardMarkdownEditor) {
            window.SwitchboardMarkdownEditor.attach(descTextarea, {
                renderPreview: (markdown) => new Promise((resolve) => {
                    const requestId = Date.now() + Math.random();
                    const handler = (event) => {
                        const msg = event.data;
                        if (msg.type === 'markdownLiveRendered' && msg.requestId === requestId) {
                            window.removeEventListener('message', handler);
                            // Keep the removeEventListener above exactly where it is: the
                            // browser host mirrors one WS push to every panel surface, and
                            // that line is what makes the duplicate arrivals harmless.
                            //
                            // The round trip's only remaining job is rewriting relative
                            // image paths to webview URIs — the RENDER happens here, with
                            // the same engine view mode uses (sharedUtils' renderMarkdown),
                            // so the preview predicts the saved result instead of offering
                            // CommonMark's all-or-nothing list spacing. Falling back to the
                            // local source covers an older host that does not send the
                            // field, and the standalone host, where markdown.api.render is
                            // absent: images do not resolve, the preview still renders.
                            // There is no reachable failure mode left, so there is no
                            // rejection path.
                            resolve(renderMarkdown(typeof msg.markdown === 'string' ? msg.markdown : markdown));
                        }
                    };
                    window.addEventListener('message', handler);
                    vscode.postMessage({
                        type: 'renderMarkdownLive',
                        requestId,
                        content: markdown,
                        provider,
                        id: task.id,
                        workspaceRoot: ticketsWorkspaceRoot
                    });
                }),
                onAttachImage: () => new Promise((resolve) => {
                    const requestId = Date.now() + Math.random();
                    const handler = (event) => {
                        const msg = event.data;
                        if (msg.type === 'ticketImageAttached' && msg.requestId === requestId) {
                            window.removeEventListener('message', handler);
                            resolve(msg.success ? { path: msg.relativePath } : null);
                        }
                    };
                    window.addEventListener('message', handler);
                    vscode.postMessage({
                        type: 'ticketAttachImage',
                        requestId,
                        provider,
                        id: task.id,
                        workspaceRoot: ticketsWorkspaceRoot
                    });
                })
            });
        }
        // Focus AFTER attach() — the shell insertion moves the textarea in the DOM,
        // which drops any focus applied before the move.
        descTextarea?.focus();
    }

    function exitTicketsEditMode() {
        ticketsEditMode = false;
        _ticketsEditBackupHtml = null;
        document.getElementById('btn-edit-ticket').style.display = '';
        document.getElementById('btn-push-ticket').style.display = '';
        document.getElementById('btn-push-ticket-subtasks').style.display = '';
        document.getElementById('btn-delete-ticket').style.display = '';
        document.getElementById('btn-save-ticket-edit').style.display = 'none';
        document.getElementById('btn-cancel-ticket-edit').style.display = 'none';
        _lastTicketsClickUpDetailContentHtml = '';
        _lastTicketsDetailContentHtml = '';
        const detailContent = document.getElementById('tickets-detail-content');
        if (detailContent) {
            detailContent.classList.remove('edit-mode');
        }
        renderTicketsTab();
        _refreshSelectedTicketFromFile();
    }
    function _selectTicketFromCard(provider, id) {
        if (!id) return;
        if (provider === 'linear') {
            const cachedLinear = linearIssueDetailCache.get(id);
            if (cachedLinear) {
                selectedLinearIssue = cachedLinear;
                renderTicketsLinearPanel();
            } else {
                // No detail cache yet — set a lightweight selected object from the
                // sidebar list (or drill-down subtasks) so selection-coupled modals
                // (openAssignModal, showTicketStatusModal) work immediately. The full
                // cache entry replaces this once linearLoadTaskDetails arrives.
                const issue = linearProjectIssues.find(i => i.id === id)
                    || (_drillDownSubtasks && _drillDownSubtasks.find(s => s.id === id));
                if (issue) {
                    selectedLinearIssue = { issue, detailsFetched: false };
                    renderTicketsLinearPanel();
                }
            }
            vscode.postMessage({ type: 'readLocalTicketFile', provider: 'linear', id, workspaceRoot: ticketsWorkspaceRoot });
            if (!cachedLinear || !cachedLinear.detailsFetched) {
                vscode.postMessage({ type: 'linearLoadTaskDetails', issueId: id, workspaceRoot: ticketsWorkspaceRoot || undefined });
            }
        } else {
            const cachedClickUp = clickUpTaskDetailCache.get(id);
            if (cachedClickUp) {
                selectedClickUpIssue = cachedClickUp;
                renderTicketsClickUpPanel();
            } else {
                const task = clickUpProjectIssues.find(t => t.id === id)
                    || (_drillDownSubtasks && _drillDownSubtasks.find(s => s.id === id));
                if (task) {
                    selectedClickUpIssue = { task, detailsFetched: false };
                    renderTicketsClickUpPanel();
                }
            }
            vscode.postMessage({ type: 'readLocalTicketFile', provider: 'clickup', id, workspaceRoot: ticketsWorkspaceRoot });
            if (!cachedClickUp || !cachedClickUp.detailsFetched) {
                vscode.postMessage({ type: 'clickupLoadTaskDetails', taskId: id, workspaceRoot: ticketsWorkspaceRoot || undefined });
            }
        }
    }
    function openPriorityPopover(dotEl, provider, ticketId, currentValue) {
        const popover = document.getElementById('ticket-priority-popover');
        if (!popover) return;

        popover.innerHTML = '';
        _openPriorityPopoverFor = { provider, ticketId, preValue: currentValue, dotEl };

        const options = provider === 'linear'
            ? [
                { value: 0, name: 'No priority', color: '#95a2b3' },
                { value: 1, name: 'Urgent', color: '#eb5757' },
                { value: 2, name: 'High', color: '#f2c94c' },
                { value: 3, name: 'Normal', color: '#5e6ad2' },
                { value: 4, name: 'Low', color: '#95a2b3' }
              ]
            : _availableClickUpPriorities();

        options.forEach(opt => {
            const row = document.createElement('div');
            row.className = 'ticket-priority-option' + (opt.value === currentValue ? ' selected' : '');
            
            const swatch = document.createElement('span');
            swatch.className = 'priority-option-swatch' + (opt.value === 0 ? ' hollow' : '');
            if (opt.value !== 0) {
                swatch.style.backgroundColor = opt.color;
            }
            
            const label = document.createElement('span');
            label.textContent = opt.name;

            row.appendChild(swatch);
            row.appendChild(label);
            popover.appendChild(row);

            row.addEventListener('click', (e) => {
                e.stopPropagation();
                selectPriority(opt.value);
            });
        });

        popover.style.display = 'block';
        
        const rect = dotEl.getBoundingClientRect();
        const popoverWidth = 140;
        const popoverHeight = popover.offsetHeight || 140;
        
        let left = window.scrollX + rect.right - popoverWidth;
        let top = window.scrollY + rect.bottom + 4;
        
        if (rect.bottom + 4 + popoverHeight > window.innerHeight) {
            top = window.scrollY + rect.top - popoverHeight - 4;
        }
        if (left < 0) left = 4;

        popover.style.left = left + 'px';
        popover.style.top = top + 'px';

        document.addEventListener('click', outsideClickPriorityClose);
        document.addEventListener('keydown', escPriorityClose);
        const container = document.getElementById('tickets-issues-container');
        if (container) {
            container.addEventListener('scroll', closePriorityPopover);
        }
    }
    function handleTicketsImport(provider, id, includeSubtasks, mode) {
        vscode.postMessage({
            type: provider === 'clickup' ? 'clickupImportTask' : 'linearImportTask',
            workspaceRoot: ticketsWorkspaceRoot,
            [provider === 'clickup' ? 'taskId' : 'issueId']: id,
            includeSubtasks,
            mode
        });
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

    function loadLinearTaskDetails(issueId) {
        if (!issueId) return;
        selectedLinearIssue = null;
        renderTicketsLinearPanel();
        vscode.postMessage({ type: 'linearLoadTaskDetails', issueId, workspaceRoot: ticketsWorkspaceRoot || undefined });
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
            if (previewMetaBar) previewMetaBar.style.display = 'none';
            if (commentInputArea) commentInputArea.style.display = 'none';
            _closeAllOverflowPopovers(null);
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
            _toggleSubtaskMetaButtons();
            const { btnViewAttachments, btnDiagramPrompt } = getTicketsTabElements();
            if (btnViewAttachments) {
                const hasAttachments = selectedLinearIssue.attachments && selectedLinearIssue.attachments.length > 0;
                btnViewAttachments.style.display = hasAttachments ? '' : 'none';
            }
            if (btnDiagramPrompt) {
                btnDiagramPrompt.style.display = '';
            }
            // Recompute "⋯ More" trigger visibility after Attachments/Diagram gating.
            _recomputeAllOverflowTriggers();
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
            contentHtml += externalizeAnchors(selectedLinearIssue.renderedDescriptionHtml);
        } else {
            const descSrc = (selectedLinearIssue.descriptionMarkdown || issue.description || '').trim();
            if (descSrc) {
                contentHtml += renderMarkdown(descSrc);
            } else {
                contentHtml += '<p>No description provided.</p>';
            }
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
                <button type="button" class="tickets-attachment-item" data-attachment-id="${escapeAttr(attachment.id || '')}" data-linear-attachment-url="${escapeAttr(attachment.url || '')}">
                    ${escapeHtml(attachment.title || attachment.filename || attachment.url || 'Attachment')}
                </button>
            `).join('');
        }

        if (_lastTicketsDetailContentHtml !== contentHtml) {
            detailContent.innerHTML = contentHtml;
            _lastTicketsDetailContentHtml = contentHtml;
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
            if (previewMetaBar) previewMetaBar.style.display = 'none';
            if (commentInputArea) commentInputArea.style.display = 'none';
            _closeAllOverflowPopovers(null);
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
            _toggleSubtaskMetaButtons();
            const { btnViewAttachments, btnDiagramPrompt } = getTicketsTabElements();
            if (btnViewAttachments) {
                const hasAttachments = selectedClickUpIssue.attachments && selectedClickUpIssue.attachments.length > 0;
                btnViewAttachments.style.display = hasAttachments ? '' : 'none';
            }
            if (btnDiagramPrompt) {
                btnDiagramPrompt.style.display = '';
            }
            // Recompute "⋯ More" trigger visibility after Attachments/Diagram gating.
            _recomputeAllOverflowTriggers();
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
            contentHtml += externalizeAnchors(selectedClickUpIssue.renderedDescriptionHtml);
        } else {
            const descSrc = (selectedClickUpIssue.descriptionMarkdown || task.markdownDescription || task.description || '').trim();
            if (descSrc) {
                contentHtml += renderMarkdown(descSrc);
            } else {
                contentHtml += '<p>No description provided.</p>';
            }
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
                <button type="button" class="tickets-attachment-item" data-attachment-id="${escapeAttr(attachment.id || '')}" data-clickup-attachment-url="${escapeAttr(attachment.url || '')}">
                    ${escapeHtml(attachment.title || attachment.filename || attachment.url || 'Attachment')}
                </button>
            `).join('');
        }

        if (_lastTicketsClickUpDetailContentHtml !== contentHtml) {
            detailContent.innerHTML = contentHtml;
            _lastTicketsClickUpDetailContentHtml = contentHtml;
        }
    }

    // ── Drill-down entry + load-more (ported from planning.js) ──
    // The dead 4-second file poll (_startTicketsFilePoll / _stopTicketsFilePoll)
    // was removed: it had zero callers, refreshed only the selected ticket, and
    // the backend file watcher (armed via ensureTicketsWatcherArmed) is now the
    // single refresh mechanism — keeping both would mean two refresh paths racing
    // on the same state.
    function _maybeEnterDrillDown(provider, id) {
        if (!id || _pendingDrillDownParentId !== id) return;
        const detail = provider === 'linear' ? linearIssueDetailCache.get(id) : clickUpTaskDetailCache.get(id);
        if (!detail || !detail.detailsFetched) return; // not loaded yet — decide when details arrive
        _pendingDrillDownParentId = null;
        const subs = detail.subtasks;
        if (subs && subs.length > 0) {
            _sidebarDrillDownParentId = id;
            _drillDownSubtasks = subs;
            _drillDownProvider = provider;
            _drillDownParentTitle = provider === 'linear'
                ? ((detail.issue && (detail.issue.title || detail.issue.identifier)) || '')
                : ((detail.task && (detail.task.title || detail.task.name)) || '');
            // AFTER _drillDownProvider — _isDrillDownActive gates on it, so a request
            // fired earlier in this block would omit every subtask id.
            _requestTicketSyncStatuses();
        }
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

    // ── Path helpers (copied from planning.js — shared with DOCS tab, do not ──
    // delete Planning's copies). Used by the ticket-folder list modal.

    function normalizeFsPath(p) {
        return String(p || '').replace(/[\\/]+$/, '');
    }

    function getCurrentFolderPaths(map, filter) {
        if (filter) {
            const normFilter = normalizeFsPath(filter);
            const matched = Object.entries(map || {})
                .filter(([root]) => normalizeFsPath(root) === normFilter)
                .flatMap(([, paths]) => paths || []);
            return [...new Set(matched)];
        }
        return [...new Set(Object.values(map || {}).flat())];
    }

    function getFolderModalEntries(map, filter) {
        const normFilter = normalizeFsPath(filter);
        const byPath = new Map();
        for (const [root, paths] of Object.entries(map || {})) {
            if (normFilter && normalizeFsPath(root) !== normFilter) continue;
            for (const p of (paths || [])) {
                const key = normalizeFsPath(p);
                if (!key) continue;
                if (!byPath.has(key)) byPath.set(key, { path: p, roots: new Set() });
                byPath.get(key).roots.add(root);
            }
        }
        return [...byPath.values()].map(e => ({ path: e.path, roots: [...e.roots] }));
    }

    function labelForWorkspaceRoot(root) {
        const item = (_workspaceItems || []).find(w => normalizeFsPath(w.workspaceRoot) === normalizeFsPath(root));
        if (item) return item.label;
        const base = normalizeFsPath(root).split(/[\\/]/).filter(Boolean).pop();
        return base ? base + ' (not open)' : root;
    }

    // ── Folder list modal (ticket-scoped copy of planning.js's renderFolderListModal) ──
    // The DOCS tab still uses the planning.js original; this is a self-contained
    // copy for the Tickets panel's own #folder-modal markup (added to tickets.html
    // by this slice).

    function renderFolderListModal() {
        const folderListModal = document.getElementById('folder-list-modal');
        if (!folderListModal) return;
        folderListModal.innerHTML = '';

        const isTickets = folderModalScope === 'tickets';
        const map = isTickets ? (_ticketsFolderPathsByRoot || {}) : {};
        const filter = ticketsWorkspaceRoot;
        const removeType = isTickets ? 'removeTicketsFolder' : 'removeLocalFolder';
        const entries = getFolderModalEntries(map, filter);
        const isAggregate = !filter;
        const showWorkspaceLabel = isAggregate;

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

        if (entries.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'folder-list-empty';
            empty.textContent = isAggregate
                ? 'No folders configured in any workspace.'
                : 'No folders configured. Click Add Folder to get started.';
            folderListModal.appendChild(empty);
            return;
        }

        entries.forEach(entry => {
            const row = document.createElement('div');
            row.className = 'folder-list-item';

            const pathSpan = document.createElement('span');
            pathSpan.className = 'folder-path';
            pathSpan.textContent = entry.path;
            if (showWorkspaceLabel) {
                const wsLabel = entry.roots.map(labelForWorkspaceRoot).join(', ');
                pathSpan.title = `${entry.path}\nWorkspace: ${wsLabel}`;
                const badge = document.createElement('span');
                badge.className = 'folder-workspace-badge';
                badge.style.cssText = 'margin-left: 8px; font-size: 11px; color: var(--text-secondary); opacity: 0.8;';
                badge.textContent = wsLabel;
                pathSpan.appendChild(badge);
            } else {
                pathSpan.title = entry.path;
            }

            const removeBtn = document.createElement('button');
            removeBtn.className = 'folder-list-remove-btn';
            removeBtn.textContent = 'Remove';
            if (isAggregate) {
                removeBtn.disabled = true;
                removeBtn.title = 'Select a specific workspace to remove its folders';
                removeBtn.style.opacity = '0.5';
            } else {
                removeBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    entry.roots.forEach(workspaceRoot => {
                        vscode.postMessage({ type: removeType, folderPath: entry.path, workspaceRoot });
                    });
                });
            }

            row.appendChild(pathSpan);
            row.appendChild(removeBtn);
            folderListModal.appendChild(row);
        });
    }

    function openFoldersModal(scope = 'local') {
        folderModalScope = scope;
        const modal = document.getElementById('folder-modal');
        const modalTitle = document.getElementById('folder-modal-title');
        if (modalTitle) {
            if (scope === 'tickets') {
                modalTitle.textContent = 'Manage Tickets Folders';
            } else {
                modalTitle.textContent = 'Manage Local Docs Folders';
            }
        }
        if (modal) modal.style.display = 'flex';
        renderFolderListModal();
        vscode.postMessage({ type: 'listTicketsFolders', workspaceRoot: ticketsWorkspaceRoot || undefined });
    }

    // Shared by the hierarchy <select> change handler and the source nav arrows.
    // Both paths MUST run the same resets — a divergence here is how the arrow
    // path would leave a stale status/assignee filter over a different list.
    function selectClickUpList(listId) {
        _restoringClickUpHierarchy = false;
        clickUpSelectedListId = listId;
        clickUpProjectLoading = false;
        clickUpProjectIssues = [];
        selectedClickUpIssue = null;
        _resetSidebarDrillDown();
        clickUpProjectStatusFilterValue = '';
        clickUpProjectAssigneeFilterValue = '';
        availableClickUpStatuses = [];
        _lastTicketsClickUpStateFilterHtml = '';
        _lastTicketsAssigneeFilterHtml = '';
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
    }

    // Shared by the project-picker change handler and the source nav arrows.
    // `syncPicker` is true only for the arrow path: the change handler runs AFTER
    // the browser has already committed <select>.value, so re-writing it there is
    // redundant; the arrow path mutates only the JS variable and must push the
    // value back into the DOM or the visible dropdown will lie about the filter.
    function selectLinearProject(projectName, syncPicker = false) {
        linearProjectPickerValue = projectName;
        if (syncPicker) {
            const { projectPicker } = getTicketsTabElements();
            if (projectPicker) { projectPicker.value = projectName; }
        }
        // Context switch: the previously-selected ticket belongs to the old project.
        selectedLinearIssue = null;
        _resetSidebarDrillDown();
        renderTicketsLinearList();
        renderTicketsLinearTaskDetail();
        updateTicketsSourceSummary();   // re-derive arrow enabled/disabled state
        saveTicketsState();
    }

    // Single source of truth for the Linear navigation order: the rendered picker
    // options, minus the "All projects" sentinel. Both navigateTicketsSource and
    // updateTicketsSourceSummary read it so they can never disagree about bounds.
    function ticketsLinearProjectOptions() {
        const { projectPicker } = getTicketsTabElements();
        if (!projectPicker) { return []; }
        return Array.from(projectPicker.options).filter(o => o.value).map(o => o.value);
    }

    // Computes the adjacent sibling and routes through the SAME selection helper
    // the dropdown uses. Guards are duplicated with updateTicketsSourceSummary's
    // disabled-state logic on purpose: the render can be missed, the guard cannot.
    function navigateTicketsSource(direction) {
        if (_moveMode) { return; }
        if (lastIntegrationProvider === 'clickup') {
            if (!clickUpSelectedListId || clickUpHierarchyLoading) { return; }
            const lists = clickUpSelectedFolderId
                ? clickUpAvailableListsInFolder
                : clickUpAvailableDirectLists;
            const idx = lists.findIndex(l => l.id === clickUpSelectedListId);
            if (idx < 0) { return; }
            const nextIdx = direction === 'next' ? idx + 1 : idx - 1;
            if (nextIdx < 0 || nextIdx >= lists.length) { return; }
            selectClickUpList(lists[nextIdx].id);
        } else if (lastIntegrationProvider === 'linear') {
            if (linearProjectLoading) { return; }
            const options = ticketsLinearProjectOptions();
            if (options.length === 0) { return; }
            const idx = options.indexOf(linearProjectPickerValue);
            // "All projects" (empty value) is index -1: `next` selects the first
            // project, `prev` has nowhere to go.
            const nextIdx = direction === 'next' ? idx + 1 : idx - 1;
            if (nextIdx < 0 || nextIdx >= options.length) { return; }
            selectLinearProject(options[nextIdx], true);
        }
    }

    // ── Source summary ──
    // Verbatim from planning.js. Reads the ClickUp hierarchy state to build the
    // "ClickUp ▸ Space ▸ Folder ▸ List" breadcrumb in the controls strip.

    function updateTicketsSourceSummary() {
        const { ticketsSourceSummary } = getTicketsTabElements();
        if (!ticketsSourceSummary) return;

        const provider = lastIntegrationProvider;
        if (!provider) {
            ticketsSourceSummary.textContent = '';
            _applyTicketsSourceArrowState();   // hides the arrows; previously unreachable
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

        _applyTicketsSourceArrowState();
    }

    // Sole writer of source-arrow visibility and enabled state. Every path that can
    // change provider, list, project, move-mode, or loading state must funnel here
    // (directly or via updateTicketsSourceSummary) — an unrefreshed arrow is either a
    // dead button or a lie about what the next click will do.
    function _applyTicketsSourceArrowState() {
        const { ticketsSourcePrev, ticketsSourceNext } = getTicketsTabElements();
        if (!ticketsSourcePrev && !ticketsSourceNext) { return; }

        const provider = lastIntegrationProvider;
        const showArrows = !_moveMode && !!provider;
        let prevDisabled = true;
        let nextDisabled = true;

        if (showArrows && provider === 'clickup' && clickUpSelectedListId && !clickUpHierarchyLoading) {
            const lists = clickUpSelectedFolderId ? clickUpAvailableListsInFolder : clickUpAvailableDirectLists;
            const idx = lists.findIndex(l => l.id === clickUpSelectedListId);
            if (idx >= 0) {
                prevDisabled = idx === 0;
                nextDisabled = idx === lists.length - 1;
            }
        } else if (showArrows && provider === 'linear' && !linearProjectLoading) {
            const options = ticketsLinearProjectOptions();
            const idx = options.indexOf(linearProjectPickerValue);   // -1 = "All projects"
            prevDisabled = idx <= 0;
            nextDisabled = options.length === 0 || idx === options.length - 1;
        }

        // The arrows walk LISTS under ClickUp but PROJECTS under Linear, so the label
        // is provider-derived, not static markup. In the VS Code webview `title=` never
        // renders as a tooltip, but this panel's other host is a plain browser tab
        // where it does — a "Next list" tooltip that moves you to the next project is
        // the same lie as an enabled arrow that does nothing.
        const unit = provider === 'linear' ? 'project' : 'list';
        if (ticketsSourcePrev) {
            ticketsSourcePrev.style.display = showArrows ? '' : 'none';
            ticketsSourcePrev.disabled = prevDisabled;
            ticketsSourcePrev.title = `Previous ${unit}`;
            ticketsSourcePrev.setAttribute('aria-label', `Previous ${unit}`);
        }
        if (ticketsSourceNext) {
            ticketsSourceNext.style.display = showArrows ? '' : 'none';
            ticketsSourceNext.disabled = nextDisabled;
            ticketsSourceNext.title = `Next ${unit}`;
            ticketsSourceNext.setAttribute('aria-label', `Next ${unit}`);
        }
    }

    // ── ClickUp hierarchy nav ──
    // Verbatim from planning.js. Renders the space/folder/list <select> triple
    // and wires their change handlers. The _moveMode branches are preserved
    // verbatim — move-mode is part of the Source modal surface and its state
    // lives here, even though showMoveTicketModal is called from later slices'
    // card click handlers.

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
            selectedClickUpIssue = null;
            _resetSidebarDrillDown();
            clickUpProjectStatusFilterValue = '';
            clickUpProjectAssigneeFilterValue = '';
            availableClickUpStatuses = [];
            _lastTicketsClickUpStateFilterHtml = '';
            _lastTicketsAssigneeFilterHtml = '';
            if (_moveMode) {
                if (spaceId) {
                    clickUpHierarchyLoading = true;
                    renderTicketsClickUpPanel();
                    vscode.postMessage({
                        type: 'clickupLoadFolders',
                        spaceId,
                        workspaceRoot: ticketsWorkspaceRoot || undefined
                    });
                } else {
                    clickUpHierarchyLoading = false;
                    renderTicketsClickUpPanel();
                }
                return;
            }
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
            selectedClickUpIssue = null;
            _resetSidebarDrillDown();
            clickUpProjectStatusFilterValue = '';
            clickUpProjectAssigneeFilterValue = '';
            availableClickUpStatuses = [];
            _lastTicketsClickUpStateFilterHtml = '';
            _lastTicketsAssigneeFilterHtml = '';
            if (_moveMode) {
                if (folderId) {
                    clickUpSelectedFolderId = folderId === '_root_' ? '' : folderId;
                    clickUpHierarchyLoading = true;
                    renderTicketsClickUpPanel();
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
                }
                return;
            }
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
            if (_moveMode) {
                // Move-mode branch — records a target, does not load. Must NOT
                // route through selectClickUpList.
                clickUpSelectedListId = listId;
                _moveSelectedTargetId = listId || null;
                const btn = document.getElementById('btn-apply-move-ticket');
                if (btn) btn.disabled = !_moveSelectedTargetId;
                return;
            }
            selectClickUpList(listId);
        });
    }

    // ── Load functions ──
    // Verbatim from planning.js. These trigger the backend verbs that fetch
    // spaces/projects. The response arms below populate the state and re-render.

    function loadLinearProject(force = false) {
        if (linearProjectLoading && !force) return;
        linearProjectLoading = true;
        linearProjectStatus = 'loading';
        linearProjectMessage = 'Loading Linear project...';
        renderTicketsLinearPanel();
        vscode.postMessage({ type: 'linearLoadProject', workspaceRoot: ticketsWorkspaceRoot || undefined });
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

    function loadClickUpSpaces() {
        clickUpHierarchyLoading = true;
        renderTicketsClickUpPanel();
        vscode.postMessage({
            type: 'clickupLoadSpaces',
            workspaceRoot: ticketsWorkspaceRoot || undefined
        });
    }

    // ── Move-mode (Source modal repurposed as move-target picker) ──
    // Verbatim from planning.js. showMoveTicketModal is called from card-click
    // handlers that arrive in later slices (2d/2e); the state and the modal
    // wiring live here because the close-button handlers in initTicketsTab
    // call exitMoveMode.

    function showMoveTicketModal(provider, ticketId) {
        _moveMode = true;
        _moveTicketId = ticketId;
        _moveProvider = provider;
        _moveSelectedTargetId = null;
        _moveHierarchySnapshot = null;

        const modal = document.getElementById('tickets-source-modal');
        if (!modal) return;
        modal.style.display = 'block';

        const controls = document.getElementById('tickets-source-move-controls');
        if (controls) controls.style.display = 'flex';
        const applyBtn = document.getElementById('btn-apply-move-ticket');
        if (applyBtn) { applyBtn.style.display = ''; applyBtn.disabled = true; applyBtn.textContent = 'Move'; }
        const unassignWrap = document.getElementById('tickets-source-move-linear-unassign-wrap');
        if (unassignWrap) unassignWrap.style.display = (provider === 'linear') ? 'block' : 'none';
        const unassign = document.getElementById('tickets-source-move-unassign');
        if (unassign) unassign.checked = false;

        if (provider === 'clickup') {
            _moveHierarchySnapshot = {
                clickUpSelectedSpaceId,
                clickUpSelectedFolderId,
                clickUpSelectedListId,
                clickUpAvailableSpaces: clickUpAvailableSpaces.slice(),
                clickUpAvailableFolders: clickUpAvailableFolders.slice(),
                clickUpAvailableListsInFolder: clickUpAvailableListsInFolder.slice(),
                clickUpAvailableDirectLists: clickUpAvailableDirectLists.slice(),
                clickUpProjectIssues: clickUpProjectIssues.slice(),
                selectedClickUpIssue,
                clickUpProjectStatusFilterValue,
                clickUpProjectAssigneeFilterValue,
                availableClickUpStatuses: availableClickUpStatuses.slice(),
                clickUpHierarchyLoading,
                clickUpProjectLoading,
                clickUpProjectMessage,
                clickUpCurrentPage,
                clickUpProjectHasMore,
                _lastTicketsClickUpStateFilterHtml,
                _lastTicketsHierarchyHtml
            };

            clickUpSelectedSpaceId = '';
            clickUpSelectedFolderId = '';
            clickUpSelectedListId = '';
            clickUpAvailableFolders = [];
            clickUpAvailableListsInFolder = [];
            clickUpAvailableDirectLists = [];
            clickUpProjectIssues = [];
            selectedClickUpIssue = null;
            clickUpProjectStatusFilterValue = '';
            clickUpProjectAssigneeFilterValue = '';
            availableClickUpStatuses = [];
            clickUpHierarchyLoading = false;
            _lastTicketsClickUpStateFilterHtml = '';
            _lastTicketsHierarchyHtml = '';

            const hierarchyNav = document.getElementById('tickets-hierarchy-nav');
            if (hierarchyNav) hierarchyNav.style.display = 'flex';
            const hierarchyLabel = hierarchyNav?.parentElement?.querySelector('label');
            if (hierarchyLabel) hierarchyLabel.style.display = '';

            const flatSelect = document.getElementById('tickets-source-move-target-select');
            if (flatSelect) flatSelect.style.display = 'none';
            const flatSearch = document.getElementById('tickets-source-move-search');
            if (flatSearch) flatSearch.style.display = 'none';
            const flatRefresh = document.getElementById('tickets-source-move-refresh');
            if (flatRefresh) flatRefresh.style.display = 'none';

            renderTicketsClickUpHierarchyNav();
        } else {
            const hierarchyNav = document.getElementById('tickets-hierarchy-nav');
            if (hierarchyNav) hierarchyNav.style.display = 'none';
            const hierarchyLabel = hierarchyNav?.parentElement?.querySelector('label');
            if (hierarchyLabel) hierarchyLabel.style.display = 'none';

            const select = document.getElementById('tickets-source-move-target-select');
            const searchInput = document.getElementById('tickets-source-move-search');
            const refreshBtn = document.getElementById('tickets-source-move-refresh');
            if (select) {
                select.style.display = '';
                select.innerHTML = '<option value="" disabled selected>Loading targets...</option>';
                select.disabled = false;
                select.onchange = () => {
                    _moveSelectedTargetId = select.value || null;
                    const btn = document.getElementById('btn-apply-move-ticket');
                    if (btn) btn.disabled = !_moveSelectedTargetId;
                };
            }
            if (searchInput) {
                searchInput.style.display = '';
                searchInput.value = '';
                searchInput.disabled = false;
                searchInput.oninput = () => {
                    if (!select) return;
                    const query = searchInput.value.toLowerCase();
                    select.innerHTML = '';
                    const filtered = (window._allMoveTargets || []).filter(t =>
                        (t.path || '').toLowerCase().includes(query) || (t.name || '').toLowerCase().includes(query)
                    );
                    if (filtered.length === 0) {
                        const opt = document.createElement('option');
                        opt.disabled = true;
                        opt.textContent = 'No matches found';
                        select.appendChild(opt);
                        _moveSelectedTargetId = null;
                        const btn = document.getElementById('btn-apply-move-ticket');
                        if (btn) btn.disabled = true;
                    } else {
                        filtered.forEach(t => {
                            const opt = document.createElement('option');
                            opt.value = t.id;
                            opt.textContent = t.path || t.name;
                            select.appendChild(opt);
                        });
                        _moveSelectedTargetId = select.value || null;
                        const btn = document.getElementById('btn-apply-move-ticket');
                        if (btn) btn.disabled = !_moveSelectedTargetId;
                    }
                };
            }
            if (refreshBtn) {
                refreshBtn.style.display = '';
                refreshBtn.onclick = () => _fetchMoveTargets(true);
            }
            if (unassign) {
                unassign.onchange = () => {
                    const checked = unassign.checked;
                    if (select) select.disabled = checked;
                    if (searchInput) searchInput.disabled = checked;
                    const btn = document.getElementById('btn-apply-move-ticket');
                    if (btn) btn.disabled = !checked && !_moveSelectedTargetId;
                };
            }

            _fetchMoveTargets(false);
        }

        _applyTicketsSourceArrowState();
    }

    function _fetchMoveTargets(refresh) {
        const select = document.getElementById('tickets-source-move-target-select');
        if (select) select.innerHTML = '<option value="" disabled selected>Loading targets...</option>';
        const applyBtn = document.getElementById('btn-apply-move-ticket');
        if (applyBtn) applyBtn.disabled = true;
        setTicketsLoadingState(true);
        vscode.postMessage({
            type: 'fetchMoveTargets',
            provider: _moveProvider,
            ticketId: _moveTicketId,
            refresh,
            workspaceRoot: ticketsWorkspaceRoot
        });
    }

    function exitMoveMode() {
        const wasClickUp = _moveProvider === 'clickup';
        _moveMode = false;
        _moveTicketId = null;
        _moveProvider = null;
        _moveSelectedTargetId = null;
        const controls = document.getElementById('tickets-source-move-controls');
        if (controls) controls.style.display = 'none';
        const applyBtn = document.getElementById('btn-apply-move-ticket');
        if (applyBtn) { applyBtn.style.display = 'none'; applyBtn.disabled = true; }
        const unassignWrap = document.getElementById('tickets-source-move-linear-unassign-wrap');
        if (unassignWrap) unassignWrap.style.display = 'none';
        const unassign = document.getElementById('tickets-source-move-unassign');
        if (unassign) unassign.checked = false;

        const flatSelect = document.getElementById('tickets-source-move-target-select');
        if (flatSelect) flatSelect.style.display = '';
        const flatSearch = document.getElementById('tickets-source-move-search');
        if (flatSearch) flatSearch.style.display = '';
        const flatRefresh = document.getElementById('tickets-source-move-refresh');
        if (flatRefresh) flatRefresh.style.display = '';

        const hierarchyNav = document.getElementById('tickets-hierarchy-nav');
        if (hierarchyNav) hierarchyNav.style.display = '';
        const hierarchyLabel = hierarchyNav?.parentElement?.querySelector('label');
        if (hierarchyLabel) hierarchyLabel.style.display = '';

        if (wasClickUp && _moveHierarchySnapshot) {
            const s = _moveHierarchySnapshot;
            clickUpSelectedSpaceId = s.clickUpSelectedSpaceId;
            clickUpSelectedFolderId = s.clickUpSelectedFolderId;
            clickUpSelectedListId = s.clickUpSelectedListId;
            clickUpAvailableSpaces = s.clickUpAvailableSpaces;
            clickUpAvailableFolders = s.clickUpAvailableFolders;
            clickUpAvailableListsInFolder = s.clickUpAvailableListsInFolder;
            clickUpAvailableDirectLists = s.clickUpAvailableDirectLists;
            clickUpProjectIssues = s.clickUpProjectIssues;
            selectedClickUpIssue = s.selectedClickUpIssue;
            clickUpProjectStatusFilterValue = s.clickUpProjectStatusFilterValue;
            clickUpProjectAssigneeFilterValue = s.clickUpProjectAssigneeFilterValue;
            availableClickUpStatuses = s.availableClickUpStatuses;
            clickUpHierarchyLoading = s.clickUpHierarchyLoading;
            clickUpProjectLoading = s.clickUpProjectLoading;
            clickUpProjectMessage = s.clickUpProjectMessage;
            clickUpCurrentPage = s.clickUpCurrentPage;
            clickUpProjectHasMore = s.clickUpProjectHasMore;
            _lastTicketsClickUpStateFilterHtml = s._lastTicketsClickUpStateFilterHtml;
            _lastTicketsHierarchyHtml = s._lastTicketsHierarchyHtml;
            _moveHierarchySnapshot = null;
            renderTicketsClickUpPanel();
            saveTicketsState();
        }

        _applyTicketsSourceArrowState();
    }

    // ── Ticket state save / reset / restore ──
    // Verbatim from planning.js. These were stubs in 2a; 2b makes them real
    // because the provider selector and hierarchy nav call saveTicketsState
    // and resetTicketsInMemoryState.

    function resetTicketsInMemoryState() {
        ticketsEditMode = false;
        _ticketsEditBackupHtml = null;
        linearIssueDetailCache.clear();
        clickUpTaskDetailCache.clear();
        _resetSidebarDrillDown();
        _collapsedTicketStatuses.clear();
        linearProjectIssues = [];
        selectedLinearIssue = null;
        linearProjectStatus = 'idle';
        linearProjectMessage = '';
        linearProjectSearchValue = '';
        linearProjectStateFilterValue = '';
        linearProjectAssigneeFilterValue = '';
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
        clickUpProjectAssigneeFilterValue = '';
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
        _lastTicketsAssigneeFilterHtml = '';
        _lastTicketsProjectPickerHtml = '';
        _lastTicketsIssuesContainerHtml = '';
        _lastTicketsDetailContentHtml = '';
        _lastTicketsHierarchyHtml = '';
        _lastTicketsClickUpIssuesContainerHtml = '';
        _lastTicketsClickUpDetailContentHtml = '';
        _lastTicketsClickUpStateFilterHtml = '';
        _lastTicketsClickUpSubtasksNavHtml = '';
        _lastTicketsLinearSubtasksNavHtml = '';
        _lastTicketsTagsKey = '';
        _lastTicketsTagsProvider = '';

        const elements = getTicketsTabElements();
        if (elements.issuesContainer) elements.issuesContainer.innerHTML = '';
        if (elements.detailContent) { elements.detailContent.innerHTML = ''; elements.detailContent.classList.remove('edit-mode'); }
        if (elements.subtasksNav) { elements.subtasksNav.innerHTML = ''; elements.subtasksNav.style.display = 'none'; }
        if (elements.previewMetaBar) elements.previewMetaBar.style.display = 'none';
        if (elements.commentInputArea) elements.commentInputArea.style.display = 'none';
    }

    function saveTicketsState() {
        if (!ticketsWorkspaceRoot) return;
        const state = {
            lastIntegrationProvider,
            linearProjectSearchValue,
            linearProjectStateFilterValue,
            linearProjectAssigneeFilterValue,
            linearProjectPickerValue,
            clickUpSelectedSpaceId,
            clickUpSelectedFolderId,
            clickUpSelectedListId,
            clickUpProjectSearchValue,
            clickUpProjectStatusFilterValue,
            clickUpProjectAssigneeFilterValue
        };
        persistTab('tickets', state, ticketsWorkspaceRoot);
        persistTab('tickets.root', ticketsWorkspaceRoot);
    }

    // ── Real restoreTicketsStateForRoot (replaces the 2a no-op stub) ──
    // Verbatim from planning.js. Restores the saved nav state (provider, filters,
    // ClickUp hierarchy selections) and triggers the hierarchy load.

    function restoreTicketsStateForRoot(state) {
        if (!state) return;
        lastIntegrationProvider = state.lastIntegrationProvider || null;
        linearProjectSearchValue = state.linearProjectSearchValue || '';
        linearProjectStateFilterValue = state.linearProjectStateFilterValue || '';
        linearProjectAssigneeFilterValue = state.linearProjectAssigneeFilterValue || '';
        linearProjectPickerValue = state.linearProjectPickerValue || '';
        clickUpSelectedSpaceId = state.clickUpSelectedSpaceId || '';
        clickUpSelectedFolderId = state.clickUpSelectedFolderId || '';
        clickUpSelectedListId = state.clickUpSelectedListId || '';
        clickUpProjectSearchValue = state.clickUpProjectSearchValue || '';
        clickUpProjectStatusFilterValue = state.clickUpProjectStatusFilterValue || '';
        clickUpProjectAssigneeFilterValue = state.clickUpProjectAssigneeFilterValue || '';

        if (clickUpSelectedSpaceId) {
            _restoringClickUpHierarchy = true;
        } else {
            _restoringClickUpHierarchy = false;
        }
        if (state.linearProjectPickerValue) {
            _restoredLinearProjectPickerValue = state.linearProjectPickerValue;
        }

        const currentScopeId = lastIntegrationProvider === 'clickup' ? clickUpSelectedListId : linearProjectPickerValue;
        if (_ticketsListedUnscoped && currentScopeId) {
            _ticketsListedUnscoped = false;
            loadLocalTicketFiles();
        }

        // This function writes three of the four source-arrow inputs
        // (lastIntegrationProvider, clickUpSelectedListId, linearProjectPickerValue)
        // and its callers do not all render afterwards — `restoredTabState` does not.
        // Without this, a root switch leaves the PREVIOUS root's arrows on screen: if
        // the restored provider is Linear while the picker DOM still holds the old
        // root's options, `next` shows enabled and navigateTicketsSource early-returns
        // — a dead click. Arrow state only, not the summary text: the hierarchy arrays
        // have not been refetched yet, so rewriting the breadcrumb here would show a
        // stale list name mid-restore.
        _applyTicketsSourceArrowState();
    }

    /**
     * Two independent facts to establish, so two independent asks — NOT an either/or.
     *
     * The root only needs a file watcher. The PROVIDER is what every source load is
     * gated on (`lastIntegrationProvider === 'clickup' ? loadClickUpSpaces() : …`, and
     * renderTicketsTab's whole dispatch), and `ticketsDefaultRoot` is the only message
     * that answers it on a cold start.
     *
     * This used to be `if (root) watcher else defaultRoot`, which was survivable while
     * the root arrived from the integration-scoped workspace list. It stopped being
     * survivable when the picker was rewired onto the all-roots list: that path
     * synthesises `ticketsWorkspaceRoot = _workspaceItems[0]` the moment rootsFetched
     * lands — before this runs, and with no provider attached — so the root was always
     * truthy, the else branch became dead code, `lastIntegrationProvider` stayed null
     * forever, and the panel connected to the host and then loaded no source at all. A
     * configured API key made no difference, because nothing ever asked which provider
     * to use.
     */
    /**
     * Load whatever source the resolved provider names. ONE definition and ONE gate.
     *
     * The `ticketsDefaultRoot` arm had this same four-line block copied per branch with
     * subtly different guards, and the branch added for the provider fix would have made
     * a third copy. `loadClickUpSpaces()` has no internal guard, so drifting copies is
     * how a panel ends up double-fetching its own hierarchy.
     *
     * `!ticketsLoadedOnce` covers every caller: the one branch that intends a reload
     * clears the flag immediately before calling.
     */
    function loadActiveTicketSource() {
        if (!isTicketsTabActive() || !lastIntegrationProvider || ticketsLoadedOnce) { return; }
        if (lastIntegrationProvider === 'clickup') { loadClickUpSpaces(); }
        else if (lastIntegrationProvider === 'linear') { loadLinearProject(); }
        loadLocalTicketFiles();
    }

    /**
     * Catch-up load for the source picker: has the hierarchy never arrived?
     *
     * Callers that recover a missed load (returning to the TICKETS tab, opening the
     * Source modal) must NOT re-fetch a hierarchy they already hold.
     * `loadClickUpSpaces` sets `clickUpHierarchyLoading`, which renders all three
     * dropdowns `disabled` until the reply lands — so a reflexive re-fetch would gray
     * the picker out on every open, and would leave it permanently unusable if the
     * reply never came. `ticketsLoadedOnce` does not cover this: it only flips once a
     * project/list has loaded, so it is still false in exactly the state where the
     * spaces are present but no list has been chosen yet.
     */
    function ticketsSourceHierarchyMissing() {
        if (!lastIntegrationProvider) { return false; }
        if (lastIntegrationProvider === 'clickup') { return clickUpAvailableSpaces.length === 0; }
        return linearProjectIssues.length === 0 && linearProjectStatus !== 'loading';
    }

    // The backend file watcher is armed per-root. restoreTicketsState alone runs
    // before the root exists (it reads webview-local persisted state, which is
    // empty on a first open), which left the watcher unarmed for the whole session.
    // Every path that resolves or changes ticketsWorkspaceRoot must (re-)arm it;
    // the _armedTicketsWatcherRoot guard makes calling from many sites safe —
    // _setupTicketsViewWatcher disposes and rebuilds unconditionally, so without
    // the guard a single startup would tear down and rebuild the watcher repeatedly.
    let _armedTicketsWatcherRoot = '';
    function ensureTicketsWatcherArmed() {
        if (!ticketsWorkspaceRoot) { return; }
        if (_armedTicketsWatcherRoot === ticketsWorkspaceRoot) { return; }
        _armedTicketsWatcherRoot = ticketsWorkspaceRoot;
        vscode.postMessage({ type: 'setupTicketsWatcher', workspaceRoot: ticketsWorkspaceRoot });
    }

    function restoreTicketsState() {
        ensureTicketsWatcherArmed();
        // Gated on the PROVIDER, not the root. Cheap and idempotent — the arm below
        // keeps whichever root is already chosen.
        if (!lastIntegrationProvider) {
            vscode.postMessage({ type: 'ticketsDefaultRoot' });
        }
    }

    // ── renderTicketsTab ──
    // Verbatim from planning.js. Dispatches to the provider-specific panel render.
    // In 2b the panel renders are stubs (hierarchy-nav-only for ClickUp, no-op
    // for Linear); 2c replaces them with the full implementations.

    function renderTicketsTab() {
        if (!isTicketsTabActive()) return;
        if (lastIntegrationProvider === 'linear') {
            renderTicketsLinearPanel();
        } else if (lastIntegrationProvider === 'clickup') {
            renderTicketsClickUpPanel();
        }
    }

    // ── Init + message handling ─────────────────────────────────────────────

    // ── 2f: Agent API modal + ask-agent helpers moved from planning.js. ──
    const AGENT_API_CAPABILITIES = {
        clickup: [
            { name: 'List / filter cached tickets',
              desc: 'Read the local cached ticket metadata — no MCP round-trip (GET /metadata/clickup, get-tickets protocol).',
              prompt: 'Read and follow .agents/protocols/get-tickets/SKILL.md to read my cached ClickUp tickets from the Switchboard local API (GET /metadata/clickup) and list them grouped by status. Do not use the MCP.' },
            { name: 'Read a ticket in full',
              desc: 'Fetch a task with description, subtasks, comments and attachments (GET /task/clickup/{id}).',
              prompt: 'Read and follow .agents/protocols/get-tickets/SKILL.md to fetch ClickUp task {ticketId} in full from the Switchboard local API (GET /task/clickup/{ticketId}) — description, subtasks, comments and attachments — and summarise it. Do not use the MCP.' },
            { name: 'Create a task (with subtasks)',
              desc: 'Create a new ClickUp task and optional subtasks (POST /task/clickup, clickup-create-task protocol).',
              prompt: 'Read and follow .agents/protocols/clickup-create-task/SKILL.md to create a ClickUp task via the Switchboard local API (POST /task/clickup). Ask me for the list, then the task name, description and any subtasks. Do not use the MCP.' },
            { name: 'Update a task',
              desc: 'Change name, description, status, assignees, due date, priority or tags (PUT /task/clickup/{id}, clickup-modify-task protocol).',
              prompt: 'Read and follow .agents/protocols/clickup-modify-task/SKILL.md to update ClickUp task {ticketId} via the Switchboard local API (PUT /task/clickup/{ticketId}). Ask me which fields to change (status, assignees, priority, tags, due date) and apply them. Do not use the MCP.' },
            { name: 'Attach a file',
              desc: 'Upload a screenshot/doc (≤10MB) to a task (POST /task/clickup/{id}/attach, clickup-attach protocol).',
              prompt: 'Read and follow .agents/protocols/clickup-attach/SKILL.md to attach a file to ClickUp task {ticketId} via the Switchboard local API (POST /task/clickup/{ticketId}/attach). Ask me which local file to upload. Do not use the MCP.' },
            { name: 'Create a doc page',
              desc: 'Add a Markdown page to a ClickUp doc (POST /doc/clickup, clickup-create-subpage protocol).',
              prompt: 'Read and follow .agents/protocols/clickup-create-subpage/SKILL.md to create a ClickUp doc page via the Switchboard local API (POST /doc/clickup). Ask me for the docId, page title and content. Do not use the MCP.' },
            { name: 'Resolve a name to an ID',
              desc: 'Turn a task/list name into its ID (GET /resolve/clickup/name/{name}, clickup-fetch protocol).',
              prompt: 'Read and follow .agents/protocols/clickup-fetch/SKILL.md to resolve a ClickUp name to an ID via the Switchboard local API (GET /resolve/clickup/name/...). Ask me the name to resolve. Do not use the MCP.' },
            { name: 'Generate an architecture diagram',
              desc: 'Build a Mermaid diagram and optionally attach it to a task (POST /diagram/generate, generate-diagram protocol).',
              prompt: 'Read and follow .agents/protocols/generate-diagram/SKILL.md to generate an architecture diagram via the Switchboard local API (POST /diagram/generate) and attach it to ClickUp task {ticketId}. Do not use the MCP.' },
            { name: 'Raw ClickUp API call',
              desc: 'Any ClickUp v2 REST endpoint not covered above (POST /api/clickup, clickup-api protocol).',
              prompt: 'Read and follow .agents/protocols/clickup-api/SKILL.md to make a raw ClickUp REST call via the Switchboard local API proxy (POST /api/clickup). Tell me which endpoint/method you need and I will confirm. Do not use the MCP.' }
        ],
        linear: [
            { name: 'List / filter cached issues',
              desc: 'Read the local cached issue metadata — no MCP round-trip (GET /metadata/linear, get-tickets protocol).',
              prompt: 'Read and follow .agents/protocols/get-tickets/SKILL.md to read my cached Linear issues from the Switchboard local API (GET /metadata/linear) and list them grouped by state. Do not use the MCP.' },
            { name: 'Read an issue in full',
              desc: 'Fetch an issue with description, sub-issues, comments and attachments (GET /task/linear/{id}).',
              prompt: 'Read and follow .agents/protocols/get-tickets/SKILL.md to fetch Linear issue {ticketId} in full from the Switchboard local API (GET /task/linear/{ticketId}) — description, sub-issues, comments and attachments — and summarise it. Do not use the MCP.' },
            { name: 'Resolve a name to an ID',
              desc: 'Turn an issue/project name into its ID (GET /resolve/linear/name/{name}).',
              prompt: 'Resolve a Linear name to an ID via the Switchboard local API (GET /resolve/linear/name/...). Ask me the name to resolve. Do not use the MCP.' },
            { name: 'Create / update / comment via GraphQL',
              desc: 'Linear writes (create issue, change state, add comment) go through the GraphQL proxy (POST /api/linear, linear-api protocol).',
              prompt: 'Read and follow .agents/protocols/linear-api/SKILL.md to run a Linear GraphQL mutation via the Switchboard local API proxy (POST /api/linear) — e.g. create an issue, change its state, or add a comment to {ticketId}. Tell me the operation and I will confirm the fields. Do not use the MCP.' },
            { name: 'Run any GraphQL query',
              desc: 'Arbitrary Linear GraphQL read query (POST /api/linear, linear-api protocol).',
              prompt: 'Read and follow .agents/protocols/linear-api/SKILL.md to run a Linear GraphQL query via the Switchboard local API proxy (POST /api/linear). Tell me what to fetch and I will confirm the query. Do not use the MCP.' },
            { name: 'Generate an architecture diagram',
              desc: 'Build a Mermaid diagram and optionally attach it to an issue (POST /diagram/generate, generate-diagram protocol).',
              prompt: 'Read and follow .agents/protocols/generate-diagram/SKILL.md to generate an architecture diagram via the Switchboard local API (POST /diagram/generate) and attach it to Linear issue {ticketId} (platform "linear"). Do not use the MCP.' }
        ]
    };

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
                    await window.sbCopyToClipboard(filledPrompt);
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

    // Ask-agent posts the ticket to a coding agent via the host. Currently not
    // bound to a button (the Agent API modal copies prompts instead), but the
    // verb handler now lives on TicketsPanelProvider so this helper is preserved
    // for future wiring. Verbatim from planning.js.
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

    function initTicketsTab() {
        ticketsInitialized = true;

        // Wire the reusable overflow-menu component (multi-instance: top-strip + meta-bar).
        // initOverflowMenus is a sharedUtils.js global — do NOT redeclare it here.
        if (typeof initOverflowMenus === 'function') {
            initOverflowMenus();
        }

        // Card "Move" is now a direct card button rather than an overflow-popover item,
        // so it no longer NEEDS document-level delegation to escape the reparented
        // popover. It stays here as the single owner of the action, independent of
        // where a card is rendered (both card renderers and _renderDrillDownHeader's
        // parent card currently paint into #tickets-issues-container). What stops the
        // click also selecting the card is the early return for [data-move-ticket-id]
        // in that container's handler — the container bubbles first, so the
        // stopPropagation below cannot do it.
        document.addEventListener('click', (e) => {
            const moveTicketBtn = e.target.closest('[data-move-ticket-id]');
            if (!moveTicketBtn) return;
            e.stopPropagation();
            const popover = moveTicketBtn.closest('[data-overflow-popover]');
            if (popover && typeof _closeOneOverflowPopover === 'function') {
                _closeOneOverflowPopover(popover);
            }
            showMoveTicketModal(moveTicketBtn.dataset.provider, moveTicketBtn.dataset.moveTicketId);
        });

        ensureTicketsRootDefault();

        // Ask the host for the workspace roots. TicketsPanelProvider answers
        // `fetchRoots` with a `rootsFetched` push; the arm there sets the save root.
        // There is no dropdown to register or repopulate, and no root-selection
        // listener — the user does not choose a root in this panel.
        if (vscode) {
            vscode.postMessage({ type: 'fetchRoots' });
        }

        // ── 2b listeners: Source modal, provider selector, folder modal ──

        const {
            ticketsSourceBtn, ticketsSourceModal, btnCloseTicketsSourceModal, btnCloseTicketsSourceModalAction,
            ticketsAutoSyncToggle
        } = getTicketsTabElements();

        // Auto-sync toggle: a mode switch, not an action. Posts the user's
        // choice to the restored writer (setTicketsAutoSync); the backend
        // writes BOTH the global and per-folder config (so a downgrade to an
        // older build still sees the choice), arms/tears-down the engine, and
        // broadcasts ticketsAutoSyncChanged back so every tickets surface
        // (editor panel + browser tabs) stays in agreement.
        ticketsAutoSyncToggle?.addEventListener('change', (e) => {
            vscode.postMessage({
                type: 'setTicketsAutoSync',
                enabled: e.target.checked,
                workspaceRoot: ticketsWorkspaceRoot || undefined
            });
        });

        ticketsSourceBtn?.addEventListener('click', () => {
            if (ticketsSourceModal) {
                ticketsSourceModal.style.display = 'block';
            }
            // The hierarchy dropdowns are only built when a host reply arrives, and
            // that build is gated on the TICKETS tab being active — so state can be
            // ahead of the DOM by the time the user asks for the picker. Opening the
            // modal is the moment the dropdowns have to be right: repaint from current
            // state (memoised — a no-op when the markup already matches), and re-issue
            // the source load only if it never ran.
            if (ticketsSourceHierarchyMissing()) { loadActiveTicketSource(); }
            renderTicketsTab();
        });

        btnCloseTicketsSourceModal?.addEventListener('click', () => {
            if (ticketsSourceModal) {
                ticketsSourceModal.style.display = 'none';
            }
            if (_moveMode) exitMoveMode();
        });

        btnCloseTicketsSourceModalAction?.addEventListener('click', () => {
            if (ticketsSourceModal) {
                ticketsSourceModal.style.display = 'none';
            }
            if (_moveMode) exitMoveMode();
        });

        ticketsSourceModal?.addEventListener('click', (e) => {
            if (e.target === e.currentTarget) {
                e.currentTarget.style.display = 'none';
                if (_moveMode) exitMoveMode();
            }
        });

        // Apply/Move button — commits the move in move mode.
        document.getElementById('btn-apply-move-ticket')?.addEventListener('click', () => {
            if (!_moveMode) return;
            const unassign = document.getElementById('tickets-source-move-unassign');
            const isUnassign = _moveProvider === 'linear' && unassign && unassign.checked;
            const targetId = isUnassign ? null : _moveSelectedTargetId;
            if (!isUnassign && !targetId) return;
            setTicketsLoadingState(true);
            vscode.postMessage({
                type: 'moveTicket',
                provider: _moveProvider,
                ticketId: _moveTicketId,
                targetId,
                workspaceRoot: ticketsWorkspaceRoot
            });
        });

        // Provider selector — switches between ClickUp and Linear.
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

        // Folder modal — close (X button)
        document.getElementById('btn-close-folder-modal')?.addEventListener('click', () => {
            const modal = document.getElementById('folder-modal');
            if (modal) modal.style.display = 'none';
        });

        // Folder modal — close (backdrop click)
        document.getElementById('folder-modal')?.addEventListener('click', (e) => {
            if (e.target.id === 'folder-modal') {
                e.target.style.display = 'none';
            }
        });

        // Attachments modal — close (X button) [moved from planning.js, slice 2e]
        document.getElementById('btn-close-attachments-modal')?.addEventListener('click', () => {
            const modal = document.getElementById('attachments-modal');
            if (modal) modal.style.display = 'none';
        });

        // Attachments modal — close (backdrop click)
        document.getElementById('attachments-modal')?.addEventListener('click', (e) => {
            if (e.target.id === 'attachments-modal') {
                e.target.style.display = 'none';
            }
        });

        // Folder modal — refresh
        document.getElementById('btn-refresh-folders-modal')?.addEventListener('click', () => {
            vscode.postMessage({ type: 'listTicketsFolders', workspaceRoot: ticketsWorkspaceRoot || undefined });
        });

        // Folder modal — add folder
        document.getElementById('btn-add-folder-modal')?.addEventListener('click', () => {
            if (folderModalScope === 'tickets') {
                const workspaceRoot = ticketsWorkspaceRoot || _workspaceItems[0]?.workspaceRoot || '';
                vscode.postMessage({ type: 'addTicketsFolder', workspaceRoot });
            }
        });

        // Render the empty state. tickets.html already ships the empty-state copy
        // ("No tickets loaded." / "Select a ticket to preview"); the foundation slice
        // owns no ticket-feature rendering, so just ensure those defaults are visible.
        const { emptyState, emptyPreview } = getTicketsTabElements();
        if (emptyState) emptyState.style.display = '';
        if (emptyPreview) emptyPreview.style.display = '';

        // ── 2c listeners: search, filters, refresh, refetch, load more, import all ──

        const {
            searchInput, projectPicker, stateFilter, clickUpStatusFilter,
            refreshButton, refetchButton, loadMoreButton
        } = getTicketsTabElements();

        // Sidebar search (debounced). Updates the provider-specific search global
        // and re-renders the active list. Linear and ClickUp share the same input.
        if (searchInput) {
            let searchDebounce;
            searchInput.addEventListener('input', () => {
                clearTimeout(searchDebounce);
                searchDebounce = setTimeout(() => {
                    _resetSidebarDrillDown();
                    if (lastIntegrationProvider === 'linear') {
                        linearProjectSearchValue = searchInput.value;
                        renderTicketsLinearList();
                    } else if (lastIntegrationProvider === 'clickup') {
                        clickUpProjectSearchValue = searchInput.value;
                        renderTicketsClickUpList();
                    }
                    saveTicketsState();
                }, 200);
            });
        }

        // Project picker (Linear)
        projectPicker?.addEventListener('change', (e) => {
            selectLinearProject(e.target.value);
            // Reconciliation moved off the read path — selecting a project is a
            // read/selection action and must not trigger a destructive delta
            // sweep. Use Refresh/Refetch to pull remote deltas.
        });

        // State filter (Linear)
        stateFilter?.addEventListener('change', (e) => {
            _resetSidebarDrillDown(); // filter targets the top-level list, not the subtask view
            linearProjectStateFilterValue = e.target.value;
            renderTicketsLinearList();
            saveTicketsState();
        });

        // Assignee filter (shared control)
        const assigneeFilterEl = document.getElementById('tickets-assignee-filter');
        assigneeFilterEl?.addEventListener('change', (e) => {
            _resetSidebarDrillDown();
            if (lastIntegrationProvider === 'linear') {
                linearProjectAssigneeFilterValue = e.target.value;
                renderTicketsLinearList();
            } else if (lastIntegrationProvider === 'clickup') {
                clickUpProjectAssigneeFilterValue = e.target.value;
                renderTicketsClickUpList();
            }
            saveTicketsState();
        });

        // Status filter (ClickUp)
        clickUpStatusFilter?.addEventListener('change', (e) => {
            _onClickUpStatusFilterChanged(e.target.value);
        });

        // Closed/done tickets are excluded from the default import. The status filter
        // used to fire its own one-off `includeClosed` import, but that made a read
        // action perform a destructive delta sweep. The capability now rides the
        // explicit Refresh/Refetch actions instead: if the user has a closed status
        // selected, the pull they asked for includes closed tickets. Without this the
        // filter would offer a "(closed)" option that can never be populated.
        // Note: the backend treats includeClosed as implying forceFull
        // (TicketsPanelProvider `refreshTicketsDelta`), matching the old one-off.
        function _clickUpIncludeClosedForRefresh() {
            return _isClickUpClosedStatus(clickUpProjectStatusFilterValue) ? true : undefined;
        }

        // Source nav arrows — prev/next list (ClickUp) or project (Linear).
        // Static markup in tickets.html, so listeners attach once here.
        const { ticketsSourcePrev, ticketsSourceNext } = getTicketsTabElements();
        ticketsSourcePrev?.addEventListener('click', () => navigateTicketsSource('prev'));
        ticketsSourceNext?.addEventListener('click', () => navigateTicketsSource('next'));

        // Refresh button — delta pull (only changed tasks since last sync).
        // Falls back to full import if the per-list delta cursor is unset
        // (first refresh after initial load). The backend handler reads the
        // cursor, does delta or full, updates the cursor, and posts
        // importAllTicketsComplete — which triggers loadLocalTicketFiles().
        refreshButton?.addEventListener('click', () => {
            linearIssueDetailCache.clear();
            clickUpTaskDetailCache.clear();
            if (lastIntegrationProvider === 'linear') {
                if (linearProjectPickerValue) {
                    vscode.postMessage({
                        type: 'refreshTicketsDelta',
                        provider: 'linear',
                        projectId: linearProjectPickerValue,
                        workspaceRoot: ticketsWorkspaceRoot
                    });
                } else {
                    loadLinearProject(true);
                }
            } else if (lastIntegrationProvider === 'clickup') {
                if (clickUpSelectedListId) {
                    vscode.postMessage({
                        type: 'refreshTicketsDelta',
                        provider: 'clickup',
                        listId: clickUpSelectedListId,
                        workspaceRoot: ticketsWorkspaceRoot,
                        includeClosed: _clickUpIncludeClosedForRefresh()
                    });
                } else {
                    loadClickUpSpaces();
                }
            }
        });

        // Refetch button — full pull (ignore/bypass the delta cursor).
        refetchButton?.addEventListener('click', () => {
            linearIssueDetailCache.clear();
            clickUpTaskDetailCache.clear();
            if (lastIntegrationProvider === 'linear') {
                if (linearProjectPickerValue) {
                    vscode.postMessage({
                        type: 'refreshTicketsDelta',
                        provider: 'linear',
                        projectId: linearProjectPickerValue,
                        workspaceRoot: ticketsWorkspaceRoot,
                        forceFull: true
                    });
                } else {
                    loadLinearProject(true);
                }
            } else if (lastIntegrationProvider === 'clickup') {
                if (clickUpSelectedListId) {
                    vscode.postMessage({
                        type: 'refreshTicketsDelta',
                        provider: 'clickup',
                        listId: clickUpSelectedListId,
                        workspaceRoot: ticketsWorkspaceRoot,
                        forceFull: true,
                        includeClosed: _clickUpIncludeClosedForRefresh()
                    });
                } else {
                    loadClickUpSpaces();
                }
            }
        });

        // Load more button (ClickUp pagination)
        loadMoreButton?.addEventListener('click', loadMoreClickUpTasks);

        // ── 2f: dead "btn-import-all-tickets" click handler removed — the id
        //    never existed in tickets.html (nor in planning.html at 7aebaf5).
        //    The only import-all control is #tickets-import-all-kanban, wired
        //    just below. ──

        // Import All as Plans button — bulk import every loaded ticket as a plan.
        document.getElementById('tickets-import-all-kanban')?.addEventListener('click', () => {
            if (isImportingAll) return;
            const issues = lastIntegrationProvider === 'clickup' ? clickUpProjectIssues : linearProjectIssues;
            if (!issues.length) return;
            isImportingAll = true;
            setTicketsLoadingState(true);
            const btn = document.getElementById('tickets-import-all-kanban');
            if (btn) btn.disabled = true;
            vscode.postMessage({
                type: 'importAllTickets',
                provider: lastIntegrationProvider,
                workspaceRoot: ticketsWorkspaceRoot,
                tickets: issues.map(t => ({ id: t.id })),
                asPlans: true
            });
        });

        // ── 2f: Link-all + Sync-all + Agent API modal wiring (moved from planning.js). ──
        const { linkAllButton, syncAllButton, ticketsAgentApiBtn, ticketsAgentApiModal,
            btnCloseTicketsAgentApiModal, btnCloseTicketsAgentApiModalAction } = getTicketsTabElements();

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
                provider,
                workspaceRoot: ticketsWorkspaceRoot,
                ticketIds: ids
            });
            _lastLinkTicketBtn = linkAllButton;
        });

        syncAllButton?.addEventListener('click', () => {
            // Do NOT call setTicketsLoadingState(true) — that dims the whole previewer
            // and disables all meta-bar buttons for the entire sync. The sync is a
            // background push that does not change the displayed ticket, so only the
            // sync button itself needs to be disabled.
            if (syncAllButton) syncAllButton.disabled = true;
            showTicketsStatus('Syncing changes…', false);
            // showTicketsStatus auto-hides after 4s — clear that timeout so the
            // status persists until syncAllTicketsResult or a progress message
            // arrives and resets it.
            if (window._ticketsFooterTimeout) {
                clearTimeout(window._ticketsFooterTimeout);
                window._ticketsFooterTimeout = undefined;
            }
            vscode.postMessage({
                type: 'syncAllTickets',
                provider: lastIntegrationProvider,
                workspaceRoot: ticketsWorkspaceRoot
            });
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

        // Trigger the initial state restore (sets up file watcher or requests
        // default root from the host).
        // ── 2d: detail-pane + meta-bar listeners (moved from planning.js initTicketsTab) ──

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

        // Action bar: Push + subtasks — push the parent AND every locally-imported
        // subtask, one remote record each. Disabled by _toggleSubtaskMetaButtons
        // when the selected ticket is itself a subtask or has no subtasks.
        document.getElementById('btn-push-ticket-subtasks')?.addEventListener('click', () => {
            const provider = lastIntegrationProvider;
            const id = provider === 'linear'
                ? selectedLinearIssue?.issue.id
                : selectedClickUpIssue?.task.id;
            if (!id) return;
            setTicketsLoadingState(true);
            vscode.postMessage({ type: 'pushTicketWithSubtasks', provider, id, workspaceRoot: ticketsWorkspaceRoot });
        });

        // Action bar: Delete — immediate, no confirm gate (repo rule: delete buttons delete)
        document.getElementById('btn-delete-ticket')?.addEventListener('click', () => {
            const provider = lastIntegrationProvider;
            const id = provider === 'linear'
                ? selectedLinearIssue?.issue.id
                : selectedClickUpIssue?.task.id;
            if (!id) return;
            setTicketsLoadingState(true);
            vscode.postMessage({ type: 'deleteTicketConfirmed', provider, id, workspaceRoot: ticketsWorkspaceRoot });
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

        // Action bar: Diagram Prompt — copies a prompt to clipboard for agent handoff
        document.getElementById('btn-diagram-prompt')?.addEventListener('click', () => {
            const provider = lastIntegrationProvider;
            if (!provider) return;
            const isLinear = provider === 'linear';
            const issue = isLinear ? selectedLinearIssue : selectedClickUpIssue;
            if (!issue) return;
            const id = isLinear ? issue.issue.id : issue.task.id;
            const title = isLinear ? (issue.issue.title || issue.issue.identifier || id) : (issue.task.name || issue.task.title || id);
            const workspaceRoot = ticketsWorkspaceRoot;
            const providerName = isLinear ? 'Linear' : 'ClickUp';
            const prompt = `Generate an architectural diagram for this ticket and attach it inline.

Ticket: ${title}
Provider: ${provider}
Workspace: ${workspaceRoot}

Instructions:
0. Work entirely on local files. Do not call the ClickUp or Linear API — the ticket id below is for locating the local markdown file only.
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
        // Detail action buttons (delegated)
        document.getElementById('preview-pane-tickets')?.addEventListener('click', (e) => {
            const attachmentBtn = e.target.closest('.tickets-attachment-item');

            if (attachmentBtn) {
                const provider = lastIntegrationProvider;
                const url = attachmentBtn.dataset.linearAttachmentUrl || attachmentBtn.dataset.clickupAttachmentUrl;
                const filename = attachmentBtn.textContent.trim();
                const attachmentId = attachmentBtn.dataset.attachmentId;
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
                    attachmentId,
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
            // Enter sidebar drill-down on the parent so the sidebar reflects the
            // subtask list we just opened a member of. The parent is the ticket
            // currently shown in the detail pane (the inline nav only renders for
            // it). Read it BEFORE swapping selected*Issue to the subtask below.
            if (provider === 'linear') {
                const parent = selectedLinearIssue;
                const parentId = parent?.issue?.id;
                if (parentId && (!_isDrillDownActive('linear') || _sidebarDrillDownParentId !== parentId)) {
                    _resetSidebarDrillDown();
                    _pendingDrillDownParentId = parentId;
                    _maybeEnterDrillDown('linear', parentId);
                }
                if (linearIssueDetailCache.has(subtaskId)) {
                    selectedLinearIssue = linearIssueDetailCache.get(subtaskId);
                    renderTicketsLinearPanel();
                } else {
                    loadLinearTaskDetails(subtaskId);
                }
            } else if (provider === 'clickup') {
                const parent = selectedClickUpIssue;
                const parentId = parent?.task?.id;
                if (parentId && (!_isDrillDownActive('clickup') || _sidebarDrillDownParentId !== parentId)) {
                    _resetSidebarDrillDown();
                    _pendingDrillDownParentId = parentId;
                    _maybeEnterDrillDown('clickup', parentId);
                }
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
            const priorityDot = e.target.closest('.ticket-priority-dot');
            if (priorityDot) {
                e.stopPropagation();
                closePriorityPopover();
                openPriorityPopover(
                    priorityDot,
                    priorityDot.dataset.priorityProvider,
                    priorityDot.dataset.ticketId,
                    Number(priorityDot.dataset.priorityValue)
                );
                return;
            }

            // Explicit drill-down request: the subtask-count chip on a card. This is
            // the ONLY card-level path into the subtask list.
            //
            // Registered above the [data-edit-status] branch because the chip lives
            // inside that row and that branch returns; and it does the selection
            // itself rather than falling through, so the status-edit modal never
            // opens. _selectTicketFromCard already posts the provider's detail-load
            // message when the cache is cold, which is what the pending entry waits on.
            const subtaskChip = e.target.closest('[data-subtask-count-ticket-id]');
            if (subtaskChip) {
                e.stopPropagation();
                const chipId = subtaskChip.dataset.subtaskCountTicketId;
                const chipProvider = subtaskChip.dataset.subtaskCountProvider;
                if (chipId) {
                    _resetSidebarDrillDown();
                    _pendingDrillDownParentId = chipId;
                    _selectTicketFromCard(chipProvider, chipId);
                    // Enters synchronously if details are already cached; otherwise the
                    // detail-loaded arm completes the entry when the response lands.
                    _maybeEnterDrillDown(chipProvider, chipId);
                }
                return;
            }

            // Editable status row on a sidebar card — select the clicked ticket then
            // open the status modal. Intercepted before the card-selection fallback so
            // the click does not also trigger bare-card selection / drill-down.
            const statusRow = e.target.closest('[data-edit-status]');
            if (statusRow) {
                e.stopPropagation();
                const provider = statusRow.dataset.provider;
                const id = statusRow.dataset.ticketId;
                _selectTicketFromCard(provider, id);
                showTicketStatusModal(provider, id);
                return;
            }
            // Editable assignees row on a sidebar card — select the clicked ticket then
            // open the existing assignee modal (which keys off selectedLinearIssue /
            // selectedClickUpIssue).
            const assigneeRow = e.target.closest('[data-edit-assignees]');
            if (assigneeRow) {
                e.stopPropagation();
                const provider = assigneeRow.dataset.provider;
                const id = assigneeRow.dataset.ticketId;
                _selectTicketFromCard(provider, id);
                openAssignModal();
                return;
            }

            // Accordion status-group header toggle — checked first, so clicking a header
            // never selects a ticket. Re-renders only the list (cheap); selection intact.
            const statusHeader = e.target.closest('.ticket-status-group-header');
            if (statusHeader) {
                e.stopPropagation();
                // decodeURIComponent so the key matches the raw status name stored in
                // _collapsedTicketStatuses (encodeURIComponent round-trips losslessly,
                // unlike escapeAttr which leaves `&`-entity names to be HTML-decoded).
                const statusName = decodeURIComponent(statusHeader.dataset.statusName || '');
                if (_collapsedTicketStatuses.has(statusName)) _collapsedTicketStatuses.delete(statusName);
                else _collapsedTicketStatuses.add(statusName);
                if (lastIntegrationProvider === 'linear') renderTicketsLinearList();
                else renderTicketsClickUpList();
                return;
            }
            // Drill-down "back to all tickets" header — exit drill-down and restore the
            // parent as the selected ticket so the detail pane + meta-bar agree with the
            // now-top-level sidebar (otherwise they keep showing the buried subtask).
            // Full *Panel render (not the bare *List) so the detail/meta-bar re-render too.
            const backHeader = e.target.closest('.sidebar-drilldown-header');
            if (backHeader) {
                e.stopPropagation();
                const parentId = _sidebarDrillDownParentId;
                _resetSidebarDrillDown();
                if (lastIntegrationProvider === 'linear') {
                    const cached = parentId && linearIssueDetailCache.get(parentId);
                    if (cached && cached.detailsFetched) selectedLinearIssue = cached;
                    renderTicketsLinearPanel();
                } else {
                    const cached = parentId && clickUpTaskDetailCache.get(parentId);
                    if (cached && cached.detailsFetched) selectedClickUpIssue = cached;
                    renderTicketsClickUpPanel();
                }
                return;
            }
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
            // Move is now a direct card button, so it bubbles through this container
            // handler on its way to the document-level listener that owns it. Return
            // here or the catch-all card branch below would also select the ticket and
            // enter drill-down on every Move click. (Container bubbles before document,
            // so the document listener's stopPropagation cannot prevent that.)
            if (e.target.closest('[data-move-ticket-id]')) {
                return;
            }

            const openTicketBtn = e.target.closest('[data-open-ticket-url]');
            if (openTicketBtn) {
                // The Open control is now an <a href>, so the VS Code webview's
                // native link interception opens the URL directly — no postMessage
                // to openExternalUrl (which would trigger the permission modal).
                // Just flash for visual feedback; the native default action proceeds.
                flashIconBtn(openTicketBtn);
                return;
            }
            // A click on a card's "⋯" overflow trigger opens its menu (handled by the
            // global overflow-menu listener) — it must NOT also select/drill-down the
            // card. The Move item itself is caught above via [data-move-ticket-id].
            if (e.target.closest('[data-overflow-trigger]')) {
                return;
            }
            const card = e.target.closest('[data-linear-issue-id], [data-clickup-task-id]');
            if (card) {
                const linearId = card.dataset.linearIssueId;
                const clickUpId = card.dataset.clickupTaskId;
                // Selecting a ticket loads it into the detail pane and NOTHING else.
                // Drill-down is entered only by an explicit act — the subtask-count
                // chip handled above, the inline subtask nav, or creating a subtask.
                // Arming it here made every click on a parent silently replace the list
                // the user was working down, a beat after the click, once details landed.
                if (linearId) {
                    const cachedLinear = linearIssueDetailCache.get(linearId);
                    // Always read the local file fresh on selection — the local .md is the source of
                    // truth for the description. Render the cached snapshot instantly (if any) for
                    // responsiveness, then the localTicketFileRead response updates it.
                    if (cachedLinear) {
                        selectedLinearIssue = cachedLinear;
                        renderTicketsLinearPanel();
                    }
                    vscode.postMessage({ type: 'readLocalTicketFile', provider: 'linear', id: linearId, workspaceRoot: ticketsWorkspaceRoot });
                    // Only fetch comments/attachments from the API once per session (detailsFetched).
                    if (!cachedLinear || !cachedLinear.detailsFetched) {
                        vscode.postMessage({ type: 'linearLoadTaskDetails', issueId: linearId, workspaceRoot: ticketsWorkspaceRoot || undefined });
                    }
                } else if (clickUpId) {
                    const cachedClickUp = clickUpTaskDetailCache.get(clickUpId);
                    if (cachedClickUp) {
                        selectedClickUpIssue = cachedClickUp;
                        renderTicketsClickUpPanel();
                    }
                    vscode.postMessage({ type: 'readLocalTicketFile', provider: 'clickup', id: clickUpId, workspaceRoot: ticketsWorkspaceRoot });
                    if (!cachedClickUp || !cachedClickUp.detailsFetched) {
                        vscode.postMessage({ type: 'clickupLoadTaskDetails', taskId: clickUpId, workspaceRoot: ticketsWorkspaceRoot || undefined });
                    }
                }

            }
        });

        // Subtask-count chip keyboard support: role="button" must respond to Enter/Space.
        document.getElementById('tickets-issues-container')?.addEventListener('keydown', (e) => {
            if (e.key !== 'Enter' && e.key !== ' ') { return; }
            const chip = e.target.closest('[data-subtask-count-ticket-id]');
            if (!chip) { return; }
            e.preventDefault();
            const chipId = chip.dataset.subtaskCountTicketId;
            const chipProvider = chip.dataset.subtaskCountProvider;
            if (chipId) {
                _resetSidebarDrillDown();
                _pendingDrillDownParentId = chipId;
                _selectTicketFromCard(chipProvider, chipId);
                _maybeEnterDrillDown(chipProvider, chipId);
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
                _resetCreateModalMetadata();
                _populateCreateModalStatus();
                _populateCreateModalPriority();
                _loadCreateModalMembers();
            }
        });

        // Close modal
        document.getElementById('btn-close-create-ticket-modal')?.addEventListener('click', () => {
            const modal = document.getElementById('create-ticket-modal');
            if (modal) modal.style.display = 'none';
            _subtaskParent = null;
            _resetCreateModalMetadata();
            const modalTitle = document.getElementById('create-ticket-modal-title');
            if (modalTitle) modalTitle.textContent = 'Create New Ticket';
        });
        document.getElementById('btn-cancel-create-ticket')?.addEventListener('click', () => {
            const modal = document.getElementById('create-ticket-modal');
            if (modal) modal.style.display = 'none';
            _subtaskParent = null;
            _resetCreateModalMetadata();
            const modalTitle = document.getElementById('create-ticket-modal-title');
            if (modalTitle) modalTitle.textContent = 'Create New Ticket';
        });
        document.getElementById('create-ticket-modal')?.addEventListener('click', (e) => {
            if (e.target === e.currentTarget) {
                e.currentTarget.style.display = 'none';
                _subtaskParent = null;
                _resetCreateModalMetadata();
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

        // Assign button
        document.getElementById('btn-assign-ticket')?.addEventListener('click', openAssignModal);

        // Status-edit modal events (opened from sidebar card status rows)
        document.getElementById('btn-close-ticket-status-modal')?.addEventListener('click', closeTicketStatusModal);
        document.getElementById('btn-cancel-ticket-status')?.addEventListener('click', closeTicketStatusModal);
        document.getElementById('ticket-status-modal')?.addEventListener('click', (e) => {
            if (e.target === e.currentTarget) closeTicketStatusModal();
        });
        document.getElementById('btn-save-ticket-status')?.addEventListener('click', () => {
            const select = document.getElementById('ticket-status-select');
            if (!select || !select.value) return;
            const provider = _statusModalProvider;
            const id = _statusModalTicketId;
            if (!provider || !id) return;
            const statusId = select.value;
            _pendingStatusChangeName = select.options[select.selectedIndex]?.text || '';
            setTicketsLoadingState(true);
            vscode.postMessage({ type: 'changeTicketStatus', provider, id, statusId, workspaceRoot: ticketsWorkspaceRoot });
            closeTicketStatusModal();
        });

        // Assign modal events
        document.getElementById('btn-close-assign-modal')?.addEventListener('click', closeAssignModal);
        document.getElementById('btn-cancel-assign')?.addEventListener('click', closeAssignModal);
        document.getElementById('btn-save-assign')?.addEventListener('click', saveAssign);
        document.getElementById('assign-modal')?.addEventListener('click', (e) => {
            if (e.target === e.currentTarget) {
                closeAssignModal();
            }
        });
        document.getElementById('assign-search')?.addEventListener('input', (e) => {
            renderAssignModalList(e.target.value);
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

            const statusSelect = document.getElementById('create-ticket-status');
            const prioritySelect = document.getElementById('create-ticket-priority');
            const status = statusSelect ? statusSelect.value.trim() : '';
            const priorityVal = prioritySelect ? prioritySelect.value.trim() : '';
            const assignees = _collectCreateModalAssignees();

            vscode.postMessage({
                type: lastIntegrationProvider === 'clickup' ? 'clickupCreateTask' : 'linearCreateIssue',
                workspaceRoot: ticketsWorkspaceRoot || undefined,
                title,
                description: description || undefined,
                listId: clickUpSelectedListId || undefined,
                projectName: linearProjectPickerValue || undefined,
                ...(status ? { status } : {}),
                ...(priorityVal !== '' ? { priority: Number(priorityVal) } : {}),
                ...(assignees ? (lastIntegrationProvider === 'clickup' ? { assignees } : { assigneeId: assignees }) : {}),
                ...(_subtaskParent ? { parentId: _subtaskParent.id } : {})
            });
        });

        function openCreateSubtaskModal(provider, ticketId, ticketTitle) {
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
                _resetCreateModalMetadata();
                _populateCreateModalStatus();
                _populateCreateModalPriority();
                _loadCreateModalMembers();
            }
        }

        // Add Subtask button
        document.getElementById('btn-add-subtask')?.addEventListener('click', () => {
            const provider = lastIntegrationProvider;
            const issue = provider === 'linear' ? selectedLinearIssue : selectedClickUpIssue;
            if (!issue) return;
            const task = provider === 'linear' ? issue.issue : issue.task;
            const ticketId = task?.id;
            const ticketTitle = task?.title || task?.name || '';
            openCreateSubtaskModal(provider, ticketId, ticketTitle);
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

        // Navigate from a subtask back to its parent ticket. Uses the same cache-or-fetch
        // pattern as a sidebar card click. Drill-down (if active) is left untouched so the
        // sidebar keeps showing the sibling list while the parent loads in the detail pane.
        document.getElementById('btn-to-parent-task')?.addEventListener('click', () => {
            const parentId = _getSelectedParentId();
            if (!parentId) return;
            if (lastIntegrationProvider === 'linear') {
                const cached = linearIssueDetailCache.get(parentId);
                if (cached && cached.detailsFetched) {
                    selectedLinearIssue = cached;
                    renderTicketsLinearPanel();
                } else {
                    loadLinearTaskDetails(parentId);
                }
            } else {
                const cached = clickUpTaskDetailCache.get(parentId);
                if (cached && cached.detailsFetched) {
                    selectedClickUpIssue = cached;
                    renderTicketsClickUpPanel();
                } else {
                    loadClickUpTaskDetails(parentId);
                }
            }
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

        // ── Plan 4: ClickUp/Linear config tab event listeners ──
        // Tab switching for CLICKUP/LINEAR tabs
        document.querySelectorAll('#tickets-tab-bar .shared-tab-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const tabId = btn.dataset.tab;
                document.querySelectorAll('#tickets-tab-bar .shared-tab-btn').forEach(b => {
                    const isActive = b.dataset.tab === tabId;
                    b.classList.toggle('active', isActive);
                    b.setAttribute('aria-selected', isActive ? 'true' : 'false');
                });
                document.querySelectorAll('.shared-tab-content').forEach(content => {
                    content.classList.toggle('active', content.dataset.tabContent === tabId);
                });
                // Request state when switching to config tabs
                if (tabId === 'clickup' || tabId === 'linear') {
                    requestIntegrationSetupStates();
                    vscode.postMessage({ type: 'getPlanningSources' });
                } else if (tabId === 'tickets') {
                    // Every Tickets paint path is gated on this tab being active
                    // (renderTicketsTab and renderTicketsClickUpPanel both early-return
                    // on !isTicketsTabActive), and so is loadActiveTicketSource. So any
                    // host reply that lands while CLICKUP/LINEAR is showing updates
                    // state and never repaints — clickUpAvailableSpaces fills, the
                    // hierarchy nav keeps its empty HTML, and the Source modal opens
                    // with a Space dropdown holding nothing but "Select Space...".
                    // Nothing else re-renders on tab return, so the source stays
                    // unselectable until the panel is reloaded. Catch up here: re-issue
                    // the load only when the hierarchy genuinely never arrived, then
                    // repaint so a hierarchy we already hold reaches the DOM.
                    if (ticketsSourceHierarchyMissing()) { loadActiveTicketSource(); }
                    renderTicketsTab();
                }
            });
        });

        // Disclosure toggles
        document.getElementById('clickup-disclosure-kanban')?.addEventListener('change', (e) => {
            document.getElementById('clickup-kanban-body')?.classList.toggle('hidden', !e.target.checked);
        });
        document.getElementById('clickup-disclosure-automation')?.addEventListener('change', (e) => {
            document.getElementById('clickup-automation-body')?.classList.toggle('hidden', !e.target.checked);
        });
        document.getElementById('linear-disclosure-kanban')?.addEventListener('change', (e) => {
            document.getElementById('linear-kanban-body')?.classList.toggle('hidden', !e.target.checked);
        });
        document.getElementById('linear-disclosure-automation')?.addEventListener('change', (e) => {
            document.getElementById('linear-automation-body')?.classList.toggle('hidden', !e.target.checked);
        });

        // Apply config buttons
        document.getElementById('btn-apply-clickup-config')?.addEventListener('click', () => {
            let token = document.getElementById('clickup-token-input')?.value.trim() || '';
            if (token === '**********') { token = ''; }
            setIntegrationStatus('clickup', 'working');
            setApplyButtonBusy('clickup', true);
            vscode.postMessage({ type: 'applyClickUpConfig', token, options: collectClickupApplyOptions() });
        });
        document.getElementById('btn-apply-linear-config')?.addEventListener('click', () => {
            let token = document.getElementById('linear-token-input')?.value.trim() || '';
            if (token === '**********') { token = ''; }
            setIntegrationStatus('linear', 'working');
            setApplyButtonBusy('linear', true);
            vscode.postMessage({ type: 'applyLinearConfig', token, options: collectLinearApplyOptions() });
        });

        // Triage pipeline buttons
        document.getElementById('btn-enable-triage-clickup')?.addEventListener('click', () => {
            let token = document.getElementById('clickup-token-input')?.value.trim() || '';
            if (token === '**********') { token = ''; }
            const btn = document.getElementById('btn-enable-triage-clickup');
            const resultEl = document.getElementById('clickup-triage-result');
            if (btn) { setButtonBusy(btn, true, 'ENABLING…'); }
            if (resultEl) { resultEl.style.color = 'var(--text-secondary)'; resultEl.textContent = ''; }
            vscode.postMessage({ type: 'enableTriagePipeline', provider: 'clickup', token });
        });
        document.getElementById('btn-enable-triage-linear')?.addEventListener('click', () => {
            let token = document.getElementById('linear-token-input')?.value.trim() || '';
            if (token === '**********') { token = ''; }
            const btn = document.getElementById('btn-enable-triage-linear');
            const resultEl = document.getElementById('linear-triage-result');
            if (btn) { setButtonBusy(btn, true, 'ENABLING…'); }
            if (resultEl) { resultEl.style.color = 'var(--text-secondary)'; resultEl.textContent = ''; }
            vscode.postMessage({ type: 'enableTriagePipeline', provider: 'linear', token });
        });

        // ClickUp mappings/automation
        document.getElementById('btn-clickup-save-mappings')?.addEventListener('click', () => {
            const btn = document.getElementById('btn-clickup-save-mappings');
            if (btn) { setButtonBusy(btn, true, 'SAVING…'); }
            vscode.postMessage({ type: 'saveClickUpMappings', mappings: collectClickupMappings() });
        });
        document.getElementById('btn-clickup-create-unmapped')?.addEventListener('click', () => {
            markClickupUnmappedForCreation();
        });
        document.getElementById('btn-clickup-add-rule')?.addEventListener('click', () => {
            addClickupRuleCard();
        });
        document.getElementById('btn-clickup-save-automation')?.addEventListener('click', () => {
            const btn = document.getElementById('btn-clickup-save-automation');
            if (btn) { setButtonBusy(btn, true, 'SAVING…'); }
            const payload = collectClickupAutomationPayload();
            vscode.postMessage({ type: 'saveClickUpAutomation', automationRules: payload.automationRules });
        });

        // Linear automation
        document.getElementById('btn-linear-add-rule')?.addEventListener('click', () => {
            addLinearRuleCard();
        });
        document.getElementById('btn-linear-save-automation')?.addEventListener('click', () => {
            const btn = document.getElementById('btn-linear-save-automation');
            if (btn) { setButtonBusy(btn, true, 'SAVING…'); }
            const payload = collectLinearAutomationPayload();
            vscode.postMessage({ type: 'saveLinearAutomation', automationRules: payload.automationRules });
        });
        document.getElementById('linear-browse-include-projects')?.addEventListener('click', () => {
            vscode.postMessage({ type: 'linearBrowseProjects', target: 'include' });
        });
        document.getElementById('linear-browse-exclude-projects')?.addEventListener('click', () => {
            vscode.postMessage({ type: 'linearBrowseProjects', target: 'exclude' });
        });

        // Token input gating
        document.getElementById('clickup-token-input')?.addEventListener('input', updateApplyButtonsState);
        document.getElementById('linear-token-input')?.addEventListener('input', updateApplyButtonsState);
        document.getElementById('clickup-ticket-import-folder')?.addEventListener('input', updateApplyButtonsState);
        document.getElementById('linear-ticket-import-folder')?.addEventListener('input', updateApplyButtonsState);

        // Ticket folder browse/save
        document.getElementById('btn-browse-clickup-ticket-folder')?.addEventListener('click', () => {
            vscode.postMessage({ type: 'browseIntegrationTicketSaveLocation', provider: 'clickup' });
        });
        document.getElementById('btn-browse-linear-ticket-folder')?.addEventListener('click', () => {
            vscode.postMessage({ type: 'browseIntegrationTicketSaveLocation', provider: 'linear' });
        });
        document.getElementById('clickup-ticket-import-folder')?.addEventListener('blur', (e) => {
            const val = e.target.value.trim();
            vscode.postMessage({ type: 'saveIntegrationTicketSaveLocation', provider: 'clickup', folderPath: val });
            updateApplyButtonsState();
        });
        document.getElementById('linear-ticket-import-folder')?.addEventListener('blur', (e) => {
            const val = e.target.value.trim();
            vscode.postMessage({ type: 'saveIntegrationTicketSaveLocation', provider: 'linear', folderPath: val });
            updateApplyButtonsState();
        });

        // Planning source checkboxes (Artifacts Panel Visibility)
        document.getElementById('planning-source-clickup')?.addEventListener('change', (e) => {
            vscode.postMessage({
                type: 'savePlanningSources',
                clickup: e.target.checked,
                linear: document.getElementById('planning-source-linear')?.checked === true,
                notion: true,
                localFolder: true
            });
        });
        document.getElementById('planning-source-linear')?.addEventListener('change', (e) => {
            vscode.postMessage({
                type: 'savePlanningSources',
                clickup: document.getElementById('planning-source-clickup')?.checked === true,
                linear: e.target.checked,
                notion: true,
                localFolder: true
            });
        });

        // Request initial state for config tabs
        requestIntegrationSetupStates();
        vscode.postMessage({ type: 'getPlanningSources' });

        restoreTicketsState();
    }

    // ── Plan 4: ClickUp/Linear config state (moved from setup.html) ──
    let lastClickupSetupState = null;
    let lastLinearSetupState = null;
    let lastPlanningSources = { clickup: true, linear: true, notion: true, 'local-folder': true };

    function requestIntegrationSetupStates() {
        vscode.postMessage({ type: 'getIntegrationSetupStates' });
        vscode.postMessage({ type: 'getIntegrationTicketSaveLocations' });
    }

    function setIntegrationStatus(kind, state, errorText = '') {
        const statusEl = document.getElementById(`${kind}-setup-status`);
        const errorEl = document.getElementById(`${kind}-setup-error`);
        const tokenInput = document.getElementById(`${kind}-token-input`);
        if (statusEl) {
            if (state === 'configured') {
                statusEl.textContent = 'Configured';
                statusEl.style.color = 'var(--accent-green)';
            } else if (state === 'working') {
                statusEl.textContent = 'Working...';
                statusEl.style.color = 'var(--accent-orange)';
            } else if (state === 'failed') {
                statusEl.textContent = 'Setup failed';
                statusEl.style.color = 'var(--accent-red)';
            } else {
                statusEl.textContent = 'Not configured';
            }
        }
        if (errorEl) {
            errorEl.textContent = errorText;
        }
        if (tokenInput && state === 'working') {
            tokenInput.disabled = true;
        } else if (tokenInput) {
            tokenInput.disabled = false;
        }
    }

    function cloneClickupSetupState(state) {
        return state ? JSON.parse(JSON.stringify(state)) : null;
    }

    function cloneLinearSetupState(state) {
        return state ? JSON.parse(JSON.stringify(state)) : null;
    }

    function setClickupSetupMessage(message, isError = false) {
        const errorEl = document.getElementById('clickup-setup-error');
        if (!errorEl) return;
        errorEl.style.color = isError ? 'var(--accent-red)' : 'var(--text-secondary)';
        errorEl.textContent = message || '';
    }

    function setLinearSetupMessage(message, isError = false) {
        const errorEl = document.getElementById('linear-setup-error');
        if (!errorEl) return;
        errorEl.style.color = isError ? 'var(--accent-red)' : 'var(--text-secondary)';
        errorEl.textContent = message || '';
    }

    function setButtonBusy(buttonEl, busy, busyLabel) {
        if (!buttonEl) return;
        if (busy) {
            if (!buttonEl.querySelector('.sb-btn-spinner')) {
                const spinner = document.createElement('span');
                spinner.className = 'sb-btn-spinner';
                buttonEl.prepend(spinner);
            }
            buttonEl.classList.add('is-busy');
            buttonEl.disabled = true;
            if (busyLabel) {
                buttonEl.dataset.origLabel = buttonEl.textContent;
                buttonEl.textContent = busyLabel;
            }
        } else {
            buttonEl.classList.remove('is-busy');
            const spinner = buttonEl.querySelector('.sb-btn-spinner');
            if (spinner) spinner.remove();
            if (buttonEl.dataset.origLabel) {
                buttonEl.textContent = buttonEl.dataset.origLabel;
                delete buttonEl.dataset.origLabel;
            }
            if (buttonEl.id !== 'btn-apply-clickup-config' && buttonEl.id !== 'btn-apply-linear-config') {
                buttonEl.disabled = false;
            }
        }
    }

    function setApplyButtonBusy(kind, busy) {
        const buttonId = kind === 'clickup'
            ? 'btn-apply-clickup-config'
            : kind === 'linear'
                ? 'btn-apply-linear-config'
                : 'btn-apply-notion-config';
        const btn = document.getElementById(buttonId);
        setButtonBusy(btn, busy, busy ? 'APPLYING…' : '');
        if (!busy) {
            updateApplyButtonsState();
        }
    }

    function setCheckboxState(id, checked) {
        const checkbox = document.getElementById(id);
        if (checkbox) {
            checkbox.checked = !!checked;
        }
    }

    function collectClickupApplyOptions() {
        return {
            createFolder: document.getElementById('clickup-option-create-folder')?.checked === true,
            createLists: document.getElementById('clickup-option-create-lists')?.checked === true,
            createCustomFields: document.getElementById('clickup-option-create-custom-fields')?.checked === true,
            enableRealtimeSync: document.getElementById('clickup-option-enable-realtime-sync')?.checked === true,
            enableAutoPull: document.getElementById('clickup-option-enable-auto-pull')?.checked === true,
            deleteSyncEnabled: document.getElementById('clickup-option-delete-sync')?.checked === true,
            inboundDeleteEnabled: document.getElementById('clickup-option-inbound-delete')?.checked === true,
            completeSyncEnabled: document.getElementById('clickup-option-complete-sync')?.checked === true,
            excludeBacklog: document.getElementById('clickup-option-exclude-backlog')?.checked === true
        };
    }

    function collectLinearApplyOptions() {
        const parseProjectNames = (value) => {
            if (!value) return undefined;
            const names = value.split(',').map(s => s.trim()).filter(s => s.length > 0);
            return names.length > 0 ? names : undefined;
        };

        return {
            mapColumns: document.getElementById('linear-option-map-columns')?.checked === true,
            createLabel: document.getElementById('linear-option-create-label')?.checked === true,
            includeProjectNames: parseProjectNames(document.getElementById('linear-option-include-projects')?.value),
            excludeProjectNames: parseProjectNames(document.getElementById('linear-option-exclude-projects')?.value),
            enableRealtimeSync: document.getElementById('linear-option-enable-realtime-sync')?.checked === true,
            enableAutoPull: document.getElementById('linear-option-enable-auto-pull')?.checked === true,
            deleteSyncEnabled: document.getElementById('linear-option-delete-sync')?.checked === true,
            inboundDeleteEnabled: document.getElementById('linear-option-inbound-delete')?.checked === true,
            enableCompleteSync: document.getElementById('linear-option-enable-complete-sync')?.checked === true,
            excludeBacklog: document.getElementById('linear-option-exclude-backlog')?.checked === true
        };
    }

    function renderClickupOptionSummary(state) {
        const summaryEl = document.getElementById('clickup-option-summary');
        if (!summaryEl) return;

        if (!state) {
            summaryEl.style.display = 'none';
            summaryEl.textContent = '';
            return;
        }

        setCheckboxState('clickup-option-create-folder', state.folderReady);
        setCheckboxState('clickup-option-create-lists', state.listsReady);
        setCheckboxState('clickup-option-create-custom-fields', state.customFieldsReady);
        setCheckboxState('clickup-option-enable-realtime-sync', state.realTimeSyncEnabled);
        setCheckboxState('clickup-option-enable-auto-pull', state.autoPullEnabled);
        setCheckboxState('clickup-option-delete-sync', state.deleteSyncEnabled === true);
        setCheckboxState('clickup-option-inbound-delete', state.inboundDeleteEnabled === true);
        setCheckboxState('clickup-option-complete-sync', state.completeSyncEnabled === true);
        setCheckboxState('clickup-option-exclude-backlog', state.excludeBacklog === true);

        const parts = [
            `Folder: ${state.folderReady ? 'ready' : 'not ready'}`,
            `Lists: ${state.mappedCount || 0} mapped`,
            `Custom fields: ${state.customFieldsReady ? 'ready' : 'not ready'}`,
            `Realtime sync: ${state.realTimeSyncEnabled ? 'enabled' : 'disabled'}`,
            `Auto-pull: ${state.autoPullEnabled ? 'enabled' : 'disabled'}`
        ];
        if (state.deleteSyncEnabled) parts.push('Delete sync: ON');
        if (state.inboundDeleteEnabled) parts.push('Inbound delete: ON');
        if (state.completeSyncEnabled) parts.push('Complete sync: ON');
        if (state.excludeBacklog) parts.push('Backlog filter: ON');

        summaryEl.style.display = 'block';
        summaryEl.textContent = parts.join(' · ');
    }

    function renderLinearOptionSummary(state) {
        const summaryEl = document.getElementById('linear-option-summary');
        if (!summaryEl) return;

        if (!state) {
            summaryEl.style.display = 'none';
            summaryEl.textContent = '';
            return;
        }

        setCheckboxState('linear-option-map-columns', state.mappingsReady);
        setCheckboxState('linear-option-create-label', state.labelReady);
        const includeInput = document.getElementById('linear-option-include-projects');
        if (includeInput) {
            includeInput.value = Array.isArray(state.includeProjectNames) ? state.includeProjectNames.join(', ') : '';
        }
        const excludeInput = document.getElementById('linear-option-exclude-projects');
        if (excludeInput) {
            excludeInput.value = Array.isArray(state.excludeProjectNames) ? state.excludeProjectNames.join(', ') : '';
        }
        setCheckboxState('linear-option-enable-realtime-sync', state.realTimeSyncEnabled);
        setCheckboxState('linear-option-enable-auto-pull', state.autoPullEnabled);
        setCheckboxState('linear-option-enable-complete-sync', state.completeSyncEnabled !== false);
        setCheckboxState('linear-option-delete-sync', state.deleteSyncEnabled === true);
        setCheckboxState('linear-option-inbound-delete', state.inboundDeleteEnabled === true);
        setCheckboxState('linear-option-exclude-backlog', state.excludeBacklog !== false);

        const includeCount = Array.isArray(state.includeProjectNames) ? state.includeProjectNames.length : 0;
        const excludeCount = Array.isArray(state.excludeProjectNames) ? state.excludeProjectNames.length : 0;
        const parts = [
            `Mappings: ${state.mappingsReady ? 'ready' : 'not ready'}`,
            `Label: ${state.labelReady ? 'ready' : 'not ready'}`,
            `Include projects: ${includeCount > 0 ? includeCount : 'all'}`,
            `Exclude projects: ${excludeCount > 0 ? excludeCount : 'none'}`,
            `Realtime sync: ${state.realTimeSyncEnabled ? 'enabled' : 'disabled'}`,
            `Auto-pull: ${state.autoPullEnabled ? 'enabled' : 'disabled'}`,
            `Complete sync: ${state.completeSyncEnabled !== false ? 'enabled' : 'disabled'}`,
            `Delete sync: ${state.deleteSyncEnabled === true ? 'enabled' : 'disabled'}`,
            `Inbound delete: ${state.inboundDeleteEnabled === true ? 'enabled' : 'disabled'}`
        ];
        summaryEl.style.display = 'block';
        summaryEl.textContent = parts.join(' · ');
    }

    function appendSelectOption(select, value, label) {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = label;
        select.appendChild(option);
    }

    function appendClickupColumnOptions(select, columns, currentValue, placeholder) {
        const seen = new Set();
        appendSelectOption(select, '', placeholder);
        (Array.isArray(columns) ? columns : []).forEach(column => {
            const columnId = String(column?.columnId || '').trim();
            if (!columnId || seen.has(columnId)) return;
            seen.add(columnId);
            appendSelectOption(select, columnId, String(column?.label || columnId));
        });
        if (currentValue && !seen.has(currentValue)) {
            appendSelectOption(select, currentValue, currentValue);
        }
        select.value = currentValue || '';
    }

    function appendLinearLabelOptions(select, labels, currentValue) {
        const seen = new Set();
        appendSelectOption(select, '', 'Select label');
        (Array.isArray(labels) ? labels : []).forEach(label => {
            const labelName = String(label?.name || '').trim();
            if (!labelName || seen.has(labelName)) return;
            seen.add(labelName);
            appendSelectOption(select, labelName, labelName);
        });
        if (currentValue && !seen.has(currentValue)) {
            appendSelectOption(select, currentValue, currentValue);
        }
        select.value = currentValue || '';
    }

    function appendLinearStateOptions(select, states, currentValues) {
        const selectedValues = Array.isArray(currentValues)
            ? currentValues.map(value => String(value || '').trim()).filter(Boolean)
            : [];
        const seen = new Set();
        (Array.isArray(states) ? states : []).forEach(state => {
            const stateId = String(state?.id || '').trim();
            if (!stateId || seen.has(stateId)) return;
            seen.add(stateId);
            const option = document.createElement('option');
            option.value = stateId;
            option.textContent = state?.type ? `${state.name} (${state.type})` : String(state?.name || stateId);
            option.selected = selectedValues.includes(stateId);
            select.appendChild(option);
        });
        selectedValues.forEach((stateId) => {
            if (seen.has(stateId)) return;
            const option = document.createElement('option');
            option.value = stateId;
            option.textContent = stateId;
            option.selected = true;
            select.appendChild(option);
        });
    }

    function createCompactField(labelText, control) {
        const wrapper = document.createElement('div');
        wrapper.style.cssText = 'display:flex; flex-direction:column; gap:4px;';
        const label = document.createElement('div');
        label.style.cssText = 'font-size:9px; letter-spacing:1px; color:var(--text-secondary);';
        label.textContent = labelText;
        wrapper.appendChild(label);
        wrapper.appendChild(control);
        return wrapper;
    }

    function renderClickupMappings(state) {
        const summaryEl = document.getElementById('clickup-mapping-summary');
        const sectionEl = document.getElementById('clickup-mappings-section');
        const listEl = document.getElementById('clickup-mappings-list');
        if (!summaryEl || !sectionEl || !listEl) return;

        const visible = !!state && state.setupComplete === true;
        summaryEl.style.display = visible ? 'block' : 'none';
        summaryEl.textContent = visible
            ? `${state.mappedCount} mapped · ${state.excludedCount} excluded · ${state.unmappedCount} unmapped`
            : '';
        sectionEl.classList.toggle('hidden', !visible);
        if (!visible) {
            listEl.innerHTML = '';
            return;
        }

        listEl.innerHTML = '';
        const availableLists = Array.isArray(state.availableLists) ? state.availableLists : [];
        state.columns.forEach((column) => {
            const row = document.createElement('div');
            row.style.cssText = 'border:1px solid var(--border); border-radius:6px; padding:8px; display:flex; flex-direction:column; gap:6px;';

            const labelRow = document.createElement('div');
            labelRow.style.cssText = 'display:flex; align-items:center; gap:8px;';

            const label = document.createElement('div');
            label.style.cssText = 'font-size:10px; letter-spacing:1px; color:var(--text-primary); flex:1;';
            label.textContent = column.label || column.columnId;

            const status = document.createElement('div');
            status.style.cssText = 'font-size:9px; color:var(--text-secondary);';
            status.textContent = column.status === 'mapped'
                ? `Mapped to ${column.listName || column.listId}`
                : column.status === 'excluded'
                    ? 'Excluded from sync'
                    : 'Unmapped';

            const select = document.createElement('select');
            select.dataset.clickupMappingSelect = 'true';
            select.dataset.columnId = column.columnId;
            select.dataset.mappingStatus = column.status;
            select.className = 'modal-input';
            select.style.width = '100%';

            const createOption = document.createElement('option');
            createOption.value = '__create__';
            createOption.textContent = `Create new list (${column.label || column.columnId})`;
            select.appendChild(createOption);

            const excludeOption = document.createElement('option');
            excludeOption.value = '__exclude__';
            excludeOption.textContent = 'Exclude from sync';
            select.appendChild(excludeOption);

            availableLists.forEach((list) => {
                const option = document.createElement('option');
                option.value = list.id;
                option.textContent = list.name;
                select.appendChild(option);
            });

            if (column.status === 'mapped' && column.listId) {
                if (!availableLists.some((list) => list.id === column.listId)) {
                    const missingOption = document.createElement('option');
                    missingOption.value = column.listId;
                    missingOption.textContent = `${column.listName || column.listId} (current mapping)`;
                    select.appendChild(missingOption);
                }
                select.value = column.listId;
            } else if (column.status === 'excluded') {
                select.value = '__exclude__';
            } else {
                select.value = '__create__';
            }

            labelRow.appendChild(label);
            labelRow.appendChild(status);
            row.appendChild(labelRow);
            row.appendChild(select);
            listEl.appendChild(row);
        });
    }

    function renderClickupAutomation(state) {
        const sectionEl = document.getElementById('clickup-automation-section');
        const rulesEl = document.getElementById('clickup-automation-rules-list');
        if (!sectionEl || !rulesEl) return;

        const configured = !!state && state.setupComplete === true;
        sectionEl.dataset.configured = configured ? 'true' : 'false';
        const visible = configured;
        sectionEl.classList.toggle('hidden', !visible);
        if (!configured) {
            rulesEl.innerHTML = '';
            return;
        }

        const availableLists = Array.isArray(state.availableLists) ? state.availableLists : [];
        const availableColumns = Array.isArray(state.columns) ? state.columns : [];

        rulesEl.innerHTML = '';
        (Array.isArray(state.automationRules) ? state.automationRules : []).forEach((rule) => {
            const card = document.createElement('div');
            card.dataset.clickupRuleCard = 'true';
            card.style.cssText = 'border:1px solid var(--border); border-radius:6px; padding:8px; display:flex; flex-direction:column; gap:6px;';

            const nameInput = document.createElement('input');
            nameInput.dataset.clickupRuleName = 'true';
            nameInput.className = 'modal-input';
            nameInput.placeholder = 'Rule name';
            nameInput.value = rule.name || '';

            const tagInput = document.createElement('input');
            tagInput.dataset.clickupRuleTag = 'true';
            tagInput.className = 'modal-input';
            tagInput.placeholder = 'Trigger tag (e.g. bug)';
            tagInput.value = rule.triggerTag || '';

            const listSelect = document.createElement('select');
            listSelect.dataset.clickupRuleLists = 'true';
            listSelect.className = 'modal-input';
            listSelect.multiple = true;
            listSelect.size = Math.min(4, Math.max(2, availableLists.length || 2));
            availableLists.forEach((list) => {
                const option = document.createElement('option');
                option.value = list.id;
                option.textContent = list.name;
                option.selected = Array.isArray(rule.triggerLists) && rule.triggerLists.includes(list.id);
                listSelect.appendChild(option);
            });

            const targetSelect = document.createElement('select');
            targetSelect.dataset.clickupRuleTargetColumn = 'true';
            targetSelect.className = 'modal-input';
            appendClickupColumnOptions(targetSelect, availableColumns, rule.targetColumn || '', 'Select start column');

            const finalSelect = document.createElement('select');
            finalSelect.dataset.clickupRuleFinalColumn = 'true';
            finalSelect.className = 'modal-input';
            appendClickupColumnOptions(finalSelect, availableColumns, rule.finalColumn || '', 'Select final column');

            const columnsRow = document.createElement('div');
            columnsRow.style.cssText = 'display:flex; gap:8px;';

            const targetField = createCompactField('Start column', targetSelect);
            targetField.style.flex = '1';
            const finalField = createCompactField('Final column', finalSelect);
            finalField.style.flex = '1';
            columnsRow.appendChild(targetField);
            columnsRow.appendChild(finalField);

            const writeBackLabel = document.createElement('label');
            writeBackLabel.className = 'startup-row';
            writeBackLabel.style.cssText = 'display:flex; align-items:center; gap:8px;';
            const writeBackToggle = document.createElement('input');
            writeBackToggle.type = 'checkbox';
            writeBackToggle.dataset.clickupRuleWritebackEnabled = 'true';
            writeBackToggle.checked = rule.writeBackOnComplete === true;
            const writeBackText = document.createElement('span');
            writeBackText.textContent = 'Write back when this plan reaches the final column';
            writeBackLabel.appendChild(writeBackToggle);
            writeBackLabel.appendChild(writeBackText);

            const removeBtn = document.createElement('button');
            removeBtn.className = 'secondary-btn';
            removeBtn.textContent = 'REMOVE RULE';
            removeBtn.addEventListener('click', () => {
                card.remove();
            });

            card.appendChild(createCompactField('Rule name', nameInput));
            card.appendChild(createCompactField('Trigger tag', tagInput));
            card.appendChild(createCompactField('Optional ClickUp lists', listSelect));
            card.appendChild(columnsRow);
            card.appendChild(writeBackLabel);
            card.appendChild(removeBtn);
            rulesEl.appendChild(card);
        });
    }

    function syncSectionDisclosure(provider) {
        if (provider === 'clickup') {
            const kMaster = document.getElementById('clickup-disclosure-kanban');
            const kBody = document.getElementById('clickup-kanban-body');
            const aMaster = document.getElementById('clickup-disclosure-automation');
            const aBody = document.getElementById('clickup-automation-body');
            if (!kMaster || !kBody || !aMaster || !aBody) return;

            const createFolder = document.getElementById('clickup-option-create-folder')?.checked;
            const createLists = document.getElementById('clickup-option-create-lists')?.checked;
            const createFields = document.getElementById('clickup-option-create-custom-fields')?.checked;
            const kOpen = !!(createFolder || createLists || createFields);

            kMaster.checked = kOpen;
            kBody.classList.toggle('hidden', !kOpen);

            const realtimeSync = document.getElementById('clickup-option-enable-realtime-sync')?.checked;
            const deleteSync = document.getElementById('clickup-option-delete-sync')?.checked;
            const autoPull = document.getElementById('clickup-option-enable-auto-pull')?.checked;
            const hasAutomationRules = document.querySelectorAll('[data-clickup-rule-card="true"]').length > 0;
            const aOpen = !!(realtimeSync || deleteSync || autoPull || hasAutomationRules);

            aMaster.checked = aOpen;
            aBody.classList.toggle('hidden', !aOpen);
        } else if (provider === 'linear') {
            const kMaster = document.getElementById('linear-disclosure-kanban');
            const kBody = document.getElementById('linear-kanban-body');
            const aMaster = document.getElementById('linear-disclosure-automation');
            const aBody = document.getElementById('linear-automation-body');
            if (!kMaster || !kBody || !aMaster || !aBody) return;

            const mapColumns = document.getElementById('linear-option-map-columns')?.checked;
            const createLabel = document.getElementById('linear-option-create-label')?.checked;
            const includeProj = document.getElementById('linear-option-include-projects')?.value?.trim();
            const excludeProj = document.getElementById('linear-option-exclude-projects')?.value?.trim();
            const kOpen = !!(mapColumns || createLabel || includeProj || excludeProj);

            kMaster.checked = kOpen;
            kBody.classList.toggle('hidden', !kOpen);

            const realtimeSync = document.getElementById('linear-option-enable-realtime-sync')?.checked;
            const deleteSync = document.getElementById('linear-option-delete-sync')?.checked;
            const autoPull = document.getElementById('linear-option-enable-auto-pull')?.checked;
            const hasAutomationRules = document.querySelectorAll('[data-linear-rule-card="true"]').length > 0;
            const aOpen = !!(realtimeSync || deleteSync || autoPull || hasAutomationRules);

            aMaster.checked = aOpen;
            aBody.classList.toggle('hidden', !aOpen);
        }
    }

    function renderClickupSetupState() {
        renderClickupOptionSummary(lastClickupSetupState);
        renderClickupMappings(lastClickupSetupState);
        renderClickupAutomation(lastClickupSetupState);
        setApplyButtonBusy('clickup', false);
        if (lastClickupSetupState?.error) {
            setClickupSetupMessage(lastClickupSetupState.error, true);
        } else if (!lastClickupSetupState) {
            setClickupSetupMessage('');
        }
        syncSectionDisclosure('clickup');
    }

    function renderLinearAutomation(state) {
        const sectionEl = document.getElementById('linear-automation-section');
        const rulesEl = document.getElementById('linear-automation-rules-list');
        if (!sectionEl || !rulesEl) return;

        const configured = !!state && state.setupComplete === true;
        sectionEl.dataset.configured = configured ? 'true' : 'false';
        const visible = configured;
        sectionEl.classList.toggle('hidden', !visible);
        if (!configured) {
            rulesEl.innerHTML = '';
            return;
        }

        const availableColumns = Array.isArray(state.columns) ? state.columns : [];
        const availableLabels = Array.isArray(state.availableLabels) ? state.availableLabels : [];
        const availableStates = Array.isArray(state.availableStates) ? state.availableStates : [];

        rulesEl.innerHTML = '';
        (Array.isArray(state.automationRules) ? state.automationRules : []).forEach((rule) => {
            const card = document.createElement('div');
            card.dataset.linearRuleCard = 'true';
            card.style.cssText = 'border:1px solid var(--border); border-radius:6px; padding:8px; display:flex; flex-direction:column; gap:6px;';

            const nameInput = document.createElement('input');
            nameInput.dataset.linearRuleName = 'true';
            nameInput.className = 'modal-input';
            nameInput.placeholder = 'Rule name';
            nameInput.value = rule.name || '';

            const enabledLabel = document.createElement('label');
            enabledLabel.className = 'startup-row';
            enabledLabel.style.cssText = 'display:flex; align-items:center; gap:8px;';
            const enabledToggle = document.createElement('input');
            enabledToggle.type = 'checkbox';
            enabledToggle.dataset.linearRuleEnabled = 'true';
            enabledToggle.checked = rule.enabled !== false;
            const enabledText = document.createElement('span');
            enabledText.textContent = 'Rule enabled';
            enabledLabel.appendChild(enabledToggle);
            enabledLabel.appendChild(enabledText);

            const labelSelect = document.createElement('select');
            labelSelect.dataset.linearRuleTriggerLabel = 'true';
            labelSelect.className = 'modal-input';
            appendLinearLabelOptions(labelSelect, availableLabels, rule.triggerLabel || '');

            const stateSelect = document.createElement('select');
            stateSelect.dataset.linearRuleTriggerStates = 'true';
            stateSelect.className = 'modal-input';
            stateSelect.multiple = true;
            stateSelect.size = Math.min(5, Math.max(2, availableStates.length || 2));
            appendLinearStateOptions(stateSelect, availableStates, rule.triggerStates);

            const isTeam = rule.destination?.kind === 'team' || (!!rule.targetTeam && !rule.targetColumn);
            const destKindSelect = document.createElement('select');
            destKindSelect.dataset.linearRuleDestKind = 'true';
            destKindSelect.className = 'modal-input';
            const optCol = document.createElement('option');
            optCol.value = 'column';
            optCol.textContent = 'Kanban Column';
            const optTeam = document.createElement('option');
            optTeam.value = 'team';
            optTeam.textContent = 'Agent Team';
            destKindSelect.appendChild(optCol);
            destKindSelect.appendChild(optTeam);
            destKindSelect.value = isTeam ? 'team' : 'column';

            const targetSelect = document.createElement('select');
            targetSelect.dataset.linearRuleTargetColumn = 'true';
            targetSelect.className = 'modal-input';
            appendClickupColumnOptions(targetSelect, availableColumns, rule.targetColumn || '', 'Select start column');

            const teamInput = document.createElement('input');
            teamInput.dataset.linearRuleTargetTeam = 'true';
            teamInput.className = 'modal-input';
            teamInput.placeholder = 'Team name (e.g. backend, frontend)';
            teamInput.value = rule.destination?.kind === 'team' ? rule.destination.team : (rule.targetTeam || '');

            const finalSelect = document.createElement('select');
            finalSelect.dataset.linearRuleFinalColumn = 'true';
            finalSelect.className = 'modal-input';
            appendClickupColumnOptions(finalSelect, availableColumns, rule.finalColumn || '', 'Select final column');

            const targetField = createCompactField('Start column', targetSelect);
            targetField.style.flex = '1';
            const teamField = createCompactField('Target team', teamInput);
            teamField.style.flex = '1';
            const finalField = createCompactField('Final column', finalSelect);
            finalField.style.flex = '1';

            const destRow = document.createElement('div');
            destRow.style.cssText = 'display:flex; gap:8px;';

            const updateDestVisibility = () => {
                if (destKindSelect.value === 'team') {
                    targetField.style.display = 'none';
                    teamField.style.display = 'block';
                } else {
                    targetField.style.display = 'block';
                    teamField.style.display = 'none';
                }
            };
            destKindSelect.addEventListener('change', updateDestVisibility);
            updateDestVisibility();

            const destKindField = createCompactField('Destination type', destKindSelect);
            destKindField.style.flex = '1';

            destRow.appendChild(destKindField);
            destRow.appendChild(targetField);
            destRow.appendChild(teamField);
            destRow.appendChild(finalField);

            const writeBackLabel = document.createElement('label');
            writeBackLabel.className = 'startup-row';
            writeBackLabel.style.cssText = 'display:flex; align-items:center; gap:8px;';
            const writeBackToggle = document.createElement('input');
            writeBackToggle.type = 'checkbox';
            writeBackToggle.dataset.linearRuleWritebackEnabled = 'true';
            writeBackToggle.checked = rule.writeBackOnComplete === true;
            const writeBackText = document.createElement('span');
            writeBackText.textContent = 'Write back when this plan reaches the final column';
            writeBackLabel.appendChild(writeBackToggle);
            writeBackLabel.appendChild(writeBackText);

            const removeBtn = document.createElement('button');
            removeBtn.className = 'secondary-btn';
            removeBtn.textContent = 'REMOVE RULE';
            removeBtn.addEventListener('click', () => {
                card.remove();
            });

            card.appendChild(createCompactField('Rule name', nameInput));
            card.appendChild(enabledLabel);
            card.appendChild(createCompactField('Trigger label', labelSelect));
            card.appendChild(createCompactField('Trigger states', stateSelect));
            card.appendChild(destRow);
            card.appendChild(writeBackLabel);
            card.appendChild(removeBtn);
            rulesEl.appendChild(card);
        });
    }

    function renderLinearSetupState() {
        renderLinearOptionSummary(lastLinearSetupState);
        renderLinearAutomation(lastLinearSetupState);
        setApplyButtonBusy('linear', false);
        if (lastLinearSetupState?.error) {
            setLinearSetupMessage(lastLinearSetupState.error, true);
        } else if (!lastLinearSetupState) {
            setLinearSetupMessage('');
        }
        syncSectionDisclosure('linear');
    }

    function collectClickupMappings() {
        return Array.from(document.querySelectorAll('[data-clickup-mapping-select="true"]')).map(select => {
            const value = select.value || '__create__';
            if (value === '__exclude__') {
                return {
                    columnId: select.dataset.columnId || '',
                    strategy: 'exclude'
                };
            }
            if (value === '__create__') {
                return {
                    columnId: select.dataset.columnId || '',
                    strategy: 'create'
                };
            }
            return {
                columnId: select.dataset.columnId || '',
                strategy: 'existing',
                listId: value
            };
        });
    }

    function collectClickupAutomationPayload() {
        const automationRules = [];
        document.querySelectorAll('[data-clickup-rule-card="true"]').forEach(card => {
            const name = card.querySelector('[data-clickup-rule-name="true"]')?.value.trim() || '';
            const triggerTag = card.querySelector('[data-clickup-rule-tag="true"]')?.value.trim() || '';
            const triggerLists = Array.from(card.querySelector('[data-clickup-rule-lists="true"]')?.selectedOptions || []).map(option => option.value);
            const targetColumn = card.querySelector('[data-clickup-rule-target-column="true"]')?.value.trim() || '';
            const finalColumn = card.querySelector('[data-clickup-rule-final-column="true"]')?.value.trim() || '';
            const writeBackOnComplete = card.querySelector('[data-clickup-rule-writeback-enabled="true"]')?.checked === true;
            if (!name || !triggerTag || !targetColumn || !finalColumn) {
                return;
            }
            automationRules.push({
                name,
                triggerTag,
                triggerLists,
                targetColumn,
                finalColumn,
                writeBackOnComplete,
                enabled: true
            });
        });

        return { automationRules };
    }

    function addClickupRuleCard() {
        if (!lastClickupSetupState) return;
        const columns = Array.isArray(lastClickupSetupState.columns) ? lastClickupSetupState.columns : [];
        const defaultTargetColumn = columns[0]?.columnId || '';
        const defaultFinalColumn = columns.find(column => String(column?.columnId || '').trim().toUpperCase() === 'COMPLETED')?.columnId
            || columns[columns.length - 1]?.columnId
            || defaultTargetColumn;
        lastClickupSetupState.automationRules = Array.isArray(lastClickupSetupState.automationRules)
            ? lastClickupSetupState.automationRules
            : [];
        lastClickupSetupState.automationRules.push({
            name: `Rule ${lastClickupSetupState.automationRules.length + 1}`,
            triggerTag: '',
            triggerLists: [],
            targetColumn: defaultTargetColumn,
            finalColumn: defaultFinalColumn,
            writeBackOnComplete: true,
            enabled: true
        });
        renderClickupAutomation(lastClickupSetupState);
    }

    function collectLinearAutomationPayload() {
        const automationRules = [];
        document.querySelectorAll('[data-linear-rule-card="true"]').forEach(card => {
            const name = card.querySelector('[data-linear-rule-name="true"]')?.value.trim() || '';
            const enabled = card.querySelector('[data-linear-rule-enabled="true"]')?.checked !== false;
            const triggerLabel = card.querySelector('[data-linear-rule-trigger-label="true"]')?.value.trim() || '';
            const triggerStates = Array.from(card.querySelector('[data-linear-rule-trigger-states="true"]')?.selectedOptions || [])
                .map(option => option.value.trim())
                .filter(Boolean);
            const destKind = card.querySelector('[data-linear-rule-dest-kind="true"]')?.value || 'column';
            const targetColumn = card.querySelector('[data-linear-rule-target-column="true"]')?.value.trim() || '';
            const targetTeam = card.querySelector('[data-linear-rule-target-team="true"]')?.value.trim() || '';
            const finalColumn = card.querySelector('[data-linear-rule-final-column="true"]')?.value.trim() || '';
            const writeBackOnComplete = card.querySelector('[data-linear-rule-writeback-enabled="true"]')?.checked === true;

            if (!name || !triggerLabel || triggerStates.length === 0) {
                return;
            }

            if (destKind === 'team') {
                if (!targetTeam) return;
                automationRules.push({
                    name,
                    enabled,
                    triggerLabel,
                    triggerStates,
                    destination: { kind: 'team', team: targetTeam },
                    targetTeam,
                    finalColumn: finalColumn || undefined,
                    writeBackOnComplete
                });
            } else {
                if (!targetColumn || !finalColumn) return;
                automationRules.push({
                    name,
                    enabled,
                    triggerLabel,
                    triggerStates,
                    destination: { kind: 'column', column: targetColumn },
                    targetColumn,
                    finalColumn,
                    writeBackOnComplete
                });
            }
        });

        return { automationRules };
    }

    function addLinearRuleCard() {
        if (!lastLinearSetupState) return;
        const columns = Array.isArray(lastLinearSetupState.columns) ? lastLinearSetupState.columns : [];
        const defaultTargetColumn = columns[0]?.columnId || '';
        const defaultFinalColumn = columns.find(column => String(column?.columnId || '').trim().toUpperCase() === 'COMPLETED')?.columnId
            || columns[columns.length - 1]?.columnId
            || defaultTargetColumn;
        lastLinearSetupState.automationRules = Array.isArray(lastLinearSetupState.automationRules)
            ? lastLinearSetupState.automationRules
            : [];
        lastLinearSetupState.automationRules.push({
            name: `Rule ${lastLinearSetupState.automationRules.length + 1}`,
            enabled: true,
            triggerLabel: '',
            triggerStates: [],
            destination: { kind: 'column', column: defaultTargetColumn },
            targetColumn: defaultTargetColumn,
            finalColumn: defaultFinalColumn,
            writeBackOnComplete: true
        });
        renderLinearAutomation(lastLinearSetupState);
    }

    function markClickupUnmappedForCreation() {
        document.querySelectorAll('[data-clickup-mapping-select="true"]').forEach(select => {
            if ((select.dataset.mappingStatus || '') === 'unmapped') {
                select.value = '__create__';
            }
        });
    }

    function updateApplyButtonsState() {
        // Apply gates only on the API token. The ticket-import folder is an
        // optional custom override (defaults to .switchboard/tickets/<provider>),
        // lives in a separate section, and is saved by its own saveTicketsFolder
        // message — it is NOT part of the applyConfig payload, so it must never
        // block Apply.
        // ClickUp
        const clickupToken = document.getElementById('clickup-token-input')?.value.trim() || '';
        const clickupApplyBtn = document.getElementById('btn-apply-clickup-config');
        if (clickupApplyBtn) {
            clickupApplyBtn.disabled = !clickupToken;
        }

        // Linear
        const linearToken = document.getElementById('linear-token-input')?.value.trim() || '';
        const linearApplyBtn = document.getElementById('btn-apply-linear-config');
        if (linearApplyBtn) {
            linearApplyBtn.disabled = !linearToken;
        }
    }

    // True when the payload's ticket IS the currently selected one — i.e. the applier
    // below has an object to patch. False means a first selection: the card-click handler
    // only assigns selectedClickUpIssue/selectedLinearIssue when a detail-cache entry
    // already exists, so on a ticket's first selection in a session the selection still
    // points at the PREVIOUS ticket (or null). That case needs a from-scratch build, not
    // a patch — see the localTicketFileRead arm.
    function _isSelectedTicketPayload(message) {
        return (message.provider === 'clickup' && selectedClickUpIssue?.task?.id === message.id)
            || (message.provider === 'linear' && selectedLinearIssue?.issue?.id === message.id);
    }

    // Both 'ticketFileChanged' and 'localTicketFileRead' deliver the same payload shape
    // ({ provider, id, title, content, rawContent }) — the provider builds them from one
    // helper. Applying them through one function is what stops the two arms from drifting:
    // the title bug fixed in one used to survive in the other.
    // PATCHES ONLY — it never creates a selection. Returns true when something the detail
    // pane actually renders changed.
    function _applyTicketFilePayloadToSelected(message) {
        if (ticketsEditMode) return false;
        const isClickUp = message.provider === 'clickup' && selectedClickUpIssue?.task?.id === message.id;
        const isLinear = message.provider === 'linear' && selectedLinearIssue?.issue?.id === message.id;
        if (!isClickUp && !isLinear) return false;

        const previewMarkdown = (message.content || '').replace(/^#[^\n]*\n?/, '').trim();
        const editMarkdown = (message.rawContent || message.content || '').replace(/^#[^\n]*\n?/, '').trim();
        const rendered = renderMarkdown(previewMarkdown);
        const prev = isClickUp ? selectedClickUpIssue : selectedLinearIssue;
        const prevTitle = isClickUp ? prev?.task?.title : prev?.issue?.title;
        const nextTitle = message.title || prevTitle;

        // Compare exactly what the renderers put in contentHtml: the <h1> and the body.
        // An image swap shows up here because the &v= token is inside `rendered`.
        if (rendered === prev?.renderedDescriptionHtml && nextTitle === prevTitle) return false;

        if (isClickUp) {
            selectedClickUpIssue = {
                ...prev,
                task: { ...prev.task, title: nextTitle, name: nextTitle },
                renderedDescriptionHtml: rendered,
                descriptionMarkdown: editMarkdown,
                localDescription: true
            };
            clickUpTaskDetailCache.set(message.id, selectedClickUpIssue);
        } else {
            selectedLinearIssue = {
                ...prev,
                issue: { ...prev.issue, title: nextTitle },
                renderedDescriptionHtml: rendered,
                descriptionMarkdown: editMarkdown,
                localDescription: true
            };
            linearIssueDetailCache.set(message.id, selectedLinearIssue);
        }
        return true;
    }

    window.addEventListener('message', (event) => {
        const message = event.data;
        if (!message) return;
        switch (message.type) {
            // ── Theme ────────────────────────────────────────────────────────
            // applyThemeBodyClass stamps the correct class at HTML-generation time,
            // so first paint is already right; these keep the panel in step when the
            // theme changes at RUNTIME. Without them the panel held its served theme
            // while every other panel switched, until a reload.
            case 'switchboardThemeChanged': {
                // Remove only the theme classes that should NOT be present, and add
                // only missing ones — never reset className. The body also carries
                // kanban-icons-colour / cyber-animation-disabled / cyber-scanlines-disabled
                // / ultracode-animation-enabled, injected server-side by the same
                // helper, and a wholesale rewrite would drop them.
                const desired = message.theme === 'claudify' ? 'theme-claudify' : 'cyber-theme-enabled';
                for (const cls of ['theme-claudify', 'cyber-theme-enabled']) {
                    if (cls !== desired) { document.body.classList.remove(cls); }
                }
                document.body.classList.add(desired);
                break;
            }
            case 'cyberAnimationSetting': {
                document.body.classList.toggle('cyber-animation-disabled', message.disabled);
                break;
            }
            case 'cyberScanlinesSetting': {
                document.body.classList.toggle('cyber-scanlines-disabled', message.disabled);
                break;
            }
            case 'ultracodeAnimationSetting': {
                document.body.classList.toggle('ultracode-animation-enabled', message.enabled === true);
                break;
            }
            case 'rootsFetched': {
                _workspaceItems = message.items || [];
                // If a root was already restored from the seed / persisted state, keep it
                // provided it is still present in the fresh list; otherwise take the first.
                if (ticketsWorkspaceRoot && !_workspaceItems.some(item => item.workspaceRoot === ticketsWorkspaceRoot)) {
                    ticketsWorkspaceRoot = '';
                }
                ensureTicketsRootDefault();
                if (ticketsWorkspaceRoot) {
                    persistTicketsRoot();
                }
                break;
            }
            case 'restoredTabState': {
                _restoredPanelState.panel = message.panel || {};
                _restoredPanelState.byRoot = message.byRoot || {};
                if (!ticketsWorkspaceRoot) {
                    const restoredRoot = _restoredPanelState.panel['tickets.root'];
                    if (restoredRoot && _workspaceItems.some(item => item.workspaceRoot === restoredRoot)) {
                        ticketsWorkspaceRoot = restoredRoot;
                        ensureTicketsWatcherArmed();
                        const restoredState = getRestoredState('tickets', restoredRoot);
                        if (restoredState) {
                            restoreTicketsStateForRoot(restoredState);
                        }
                    }
                } else {
                    if (_pendingTicketsRestore) {
                        _pendingTicketsRestore = false;
                        const restoredState = getRestoredState('tickets', ticketsWorkspaceRoot);
                        if (restoredState) {
                            restoreTicketsStateForRoot(restoredState);
                        }
                    }
                }
                break;
            }
            case 'workspaceRootChanged': {
                // Host-driven root change (e.g. standalone nav). Accept and persist.
                const newRoot = message.workspaceRoot || '';
                if (newRoot && newRoot !== ticketsWorkspaceRoot) {
                    ticketsWorkspaceRoot = newRoot;
                    persistTicketsRoot();
                    ensureTicketsWatcherArmed();
                }
                break;
            }

            // ── 2b response arms: provider hierarchy, folders, default root ──

            case 'ticketsAutoSyncChanged': {
                // Load-bearing carrier for the toggle on open (fed by
                // setupTicketsWatcher) and the post-toggle broadcast. Every push
                // from the provider is broadcast to all tickets surfaces (editor
                // + browser tabs), so a root guard is required — but the guard is
                // the workspaceRoot match ALONE, not _isForThisPanel().
                //
                // Auto-sync is a ROOT-scoped setting, not a list-scoped data
                // reply, so this push carries no scopeId/listId. _isForThisPanel
                // ends in `theirs === mine` against clickUpSelectedListId, which
                // means it REJECTS every scope-less reply once a ClickUp list is
                // selected — i.e. on every reopen with restored state. That left
                // the checkbox unticked over a running engine: the exact defect
                // this migration exists to correct.
                if (message.workspaceRoot && ticketsWorkspaceRoot
                        && message.workspaceRoot !== ticketsWorkspaceRoot) { break; }
                const toggle = document.getElementById('tickets-auto-sync-toggle');
                if (toggle) { toggle.checked = message.ticketsAutoSync === true; }
                break;
            }

            case 'ticketsDefaultRoot': {
                // The provider is adopted BEFORE the root guard, not after it. The guard
                // protects an already-chosen ROOT from being overwritten — it has nothing
                // to say about the provider, and bailing out with it still unset was the
                // other half of "the panel connects to no source": the root is now always
                // set by the time this reply lands (see restoreTicketsState), so the
                // early return below discarded the one message that names the provider.
                if (!lastIntegrationProvider) {
                    lastIntegrationProvider = message.provider || null;
                }
                // Secondary carrier: set the toggle from the reply when present.
                if (message.ticketsAutoSync !== undefined) {
                    const toggle = document.getElementById('tickets-auto-sync-toggle');
                    if (toggle) { toggle.checked = message.ticketsAutoSync === true; }
                }
                if (ticketsWorkspaceRoot && _workspaceItems.some(item => item.workspaceRoot === ticketsWorkspaceRoot)) {
                    // Keep the chosen root, but the provider just arrived — so the source
                    // load this reply exists to unblock still has to happen.
                    loadActiveTicketSource();
                    break;
                }
                ticketsWorkspaceRoot = message.workspaceRoot || '';
                if (ticketsWorkspaceRoot) {
                    ensureTicketsWatcherArmed();
                    const restoredState = getRestoredState('tickets', ticketsWorkspaceRoot);
                    if (restoredState) {
                        restoreTicketsStateForRoot(restoredState);
                        loadActiveTicketSource();
                    } else if (Object.keys(_restoredPanelState.byRoot).length > 0) {
                        ticketsLoadedOnce = false;
                        loadActiveTicketSource();
                    } else {
                        _pendingTicketsRestore = true;
                    }
                }
                break;
            }

            case 'integrationProviderStates': {
                _integrationProviderStatesReceived = true;
                const clickupSetup = message.clickupSetupComplete === true;
                const linearSetup = message.linearSetupComplete === true;
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

                if (!lastIntegrationProvider) {
                    lastIntegrationProvider = message.provider || null;
                }
                // Secondary carrier for the provider-switch path: set the
                // checkbox when the field is present. Guard on presence, not
                // truthiness — a push that omits the field must not silently
                // untick a live setting. Root-guarded for the same reason as
                // the ticketsAutoSyncChanged arm: this push is broadcast to
                // every tickets surface, so another root's provider switch must
                // not rewrite this panel's toggle.
                if (message.ticketsAutoSync !== undefined
                        && !(message.workspaceRoot && ticketsWorkspaceRoot
                             && message.workspaceRoot !== ticketsWorkspaceRoot)) {
                    const toggle = document.getElementById('tickets-auto-sync-toggle');
                    if (toggle) { toggle.checked = message.ticketsAutoSync === true; }
                }
                if (providerSelector && lastIntegrationProvider) {
                    providerSelector.value = lastIntegrationProvider;
                }
                if (isTicketsTabActive() && lastIntegrationProvider && !ticketsLoadedOnce) {
                    if (lastIntegrationProvider === 'clickup') {
                        loadClickUpSpaces();
                    } else if (lastIntegrationProvider === 'linear') {
                        loadLinearProject();
                    }
                    loadLocalTicketFiles();
                }
                break;
            }

            case 'clickupSpacesLoaded':
                clickUpAvailableSpaces = message.spaces || [];
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
                updateTicketsSourceSummary();
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
                if (message.spaceId && message.spaceId !== clickUpSelectedSpaceId) {
                    break;
                }
                clickUpAvailableFolders = message.folders || [];
                clickUpAvailableListsInFolder = [];
                clickUpAvailableDirectLists = message.directLists || [];
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
                updateTicketsSourceSummary();
                break;

            case 'clickupListsLoaded':
                if ((message.spaceId && message.spaceId !== clickUpSelectedSpaceId) ||
                    (message.folderId !== undefined && message.folderId !== clickUpSelectedFolderId)) {
                    break;
                }
                if (clickUpSelectedFolderId) {
                    clickUpAvailableListsInFolder = message.lists || [];
                } else {
                    clickUpAvailableDirectLists = message.lists || [];
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
                updateTicketsSourceSummary();
                break;

            case 'clickupProjectLoaded':
                if (!_isForThisPanel(message)) { break; }
                clickUpProjectIssues = message.tasks || [];
                clickUpProjectStatus = 'loaded';
                clickUpProjectMessage = '';
                clickUpProjectLoading = false;
                clickUpCurrentPage = message.page || 0;
                clickUpProjectHasMore = message.hasMore || false;
                ticketsLoadedOnce = true;
                if (clickUpSelectedListId) {
                    availableClickUpStatuses = [];
                    vscode.postMessage({ type: 'clickupLoadListStatuses', listId: clickUpSelectedListId, workspaceRoot: ticketsWorkspaceRoot });
                }
                renderTicketsTab();
                // Reconciliation (delta sweep) moved off the read path — a list
                // load is a read and must not trigger a destructive write. Sync
                // badges still refresh (read); the sidebar still repaints from
                // local files (read). Use Refresh/Refetch to pull remote deltas.
                _requestTicketSyncStatuses();
                loadLocalTicketFiles();
                break;

            case 'linearProjectsLoaded':
                linearAvailableProjects = message.projects || [];
                break;

            case 'linearProjectLoaded':
                if (!_isForThisPanel(message)) { break; }
                linearProjectIssues = message.issues || [];
                linearProjectStatus = 'loaded';
                linearProjectMessage = '';
                linearProjectLoading = false;
                ticketsLoadedOnce = true;
                renderTicketsTab();
                _requestTicketSyncStatuses();
                loadLocalTicketFiles();
                break;

            case 'clickupSpaceTagsLoaded':
                availableClickUpTags = message.tags || [];
                break;

            case 'clickupListStatusesLoaded':
                if (!_isForThisPanel(message)) { break; }
                availableClickUpStatuses = message.statuses || [];
                if (lastIntegrationProvider === 'clickup') renderTicketsTab();
                break;

            case 'clickupError': {
                // A foreign panel's project-scope error must not clear this panel's
                // spinner or stamp an error status over a healthy sidebar. Task /
                // hierarchy scope errors are not project-scoped and pass through.
                if (message.scope === 'project' && !_isForThisPanel(message)) { break; }
                switch (message.scope) {
                    case 'hierarchy':
                        clickUpHierarchyLoading = false;
                        break;
                    case 'project':
                        clickUpProjectLoading = false;
                        clickUpProjectStatus = 'error';
                        clickUpProjectMessage = message.error || 'Failed to load tasks';
                        break;
                }
                setTicketsLoadingState(false);
                // When the ticket was deleted on ClickUp (404), the provider already
                // unlinked the local file + DB entry. Remove it from the sidebar list
                // and clear the selection so the user doesn't see a ghost.
                if (message.kind === 'deleted' && message.taskId) {
                    clickUpProjectIssues = clickUpProjectIssues.filter(t => t.id !== message.taskId);
                    if (selectedClickUpIssue && selectedClickUpIssue.task && selectedClickUpIssue.task.id === message.taskId) {
                        selectedClickUpIssue = null;
                    }
                    loadLocalTicketFiles();
                }
                showTicketsError(message.error || 'ClickUp request failed');
                renderTicketsTab();
                break;
            }

            case 'linearError': {
                if (message.scope === 'project' && !_isForThisPanel(message)) { break; }
                switch (message.scope) {
                    case 'project':
                        linearProjectLoading = false;
                        linearProjectStatus = 'error';
                        linearProjectMessage = message.error || 'Failed to load issues';
                        break;
                }
                setTicketsLoadingState(false);
                if (message.kind === 'deleted' && message.issueId) {
                    linearProjectIssues = linearProjectIssues.filter(i => i.id !== message.issueId);
                    if (selectedLinearIssue && selectedLinearIssue.issue && selectedLinearIssue.issue.id === message.issueId) {
                        selectedLinearIssue = null;
                    }
                    loadLocalTicketFiles();
                }
                showTicketsError(message.error || 'Linear request failed');
                renderTicketsTab();
                break;
            }

            case 'ticketsFoldersListed':
                if (!_ticketsFolderPathsByRoot) { _ticketsFolderPathsByRoot = {}; }
                _ticketsFolderPathsByRoot[message.workspaceRoot || ''] = message.paths || [];
                renderFolderListModal();
                break;

            case 'browseTicketsFolderResult':
                if (message.path) {
                    vscode.postMessage({
                        type: 'saveTicketsFolder',
                        folderPath: message.path,
                        workspaceRoot: message.workspaceRoot || ticketsWorkspaceRoot
                    });
                }
                break;

            case 'moveTargetsResult': {
                setTicketsLoadingState(false);
                const select = document.getElementById('tickets-source-move-target-select');
                const applyBtn = document.getElementById('btn-apply-move-ticket');
                if (select) {
                    select.innerHTML = '';
                    window._allMoveTargets = message.targets || [];
                    if (window._allMoveTargets.length === 0) {
                        const opt = document.createElement('option');
                        opt.disabled = true;
                        opt.textContent = 'No available move targets found.';
                        select.appendChild(opt);
                        if (applyBtn) applyBtn.disabled = true;
                    } else {
                        window._allMoveTargets.forEach(t => {
                            const opt = document.createElement('option');
                            opt.value = t.id;
                            opt.textContent = t.path || t.name;
                            select.appendChild(opt);
                        });
                        // Do not enable until something is selected, or if unassigned is checked
                        const unassignCheck = document.getElementById('tickets-source-move-unassign');
                        _moveSelectedTargetId = select.value || null;
                        if (applyBtn) applyBtn.disabled = !(unassignCheck && unassignCheck.checked) && !_moveSelectedTargetId;
                    }
                }
                break;
            }

            case 'moveTicketResult': {
                setTicketsLoadingState(false);
                // Capture the moved ticket id before exitMoveMode() clears _moveTicketId.
                const _movedTicketId = message.ticketId || _moveTicketId;
                if (_moveMode) {
                    const srcModal = document.getElementById('tickets-source-modal');
                    if (srcModal) srcModal.style.display = 'none';
                    exitMoveMode();
                }
                if (message.success) {
                    let successText = `Moved ✓`;
                    if (message.warning) {
                        successText += ` Warning: ${message.warning}`;
                    }
                    if (message.remainsInLists > 0) {
                        successText += ` (Task remains in ${message.remainsInLists} other list(s))`;
                    }
                    showTicketsStatus(successText, false);
                    // Keep the current list on screen — the moved ticket simply leaves it.
                    // Previously this fired refreshTicketsDelta / loadLocalTicketFiles, which
                    // reloaded and re-scoped the sidebar to local files and could collapse the
                    // whole list down to a single ticket (or empty it). The backend already
                    // performed the source-system move and rewrote the local file, so no
                    // client re-fetch is needed: drop the moved ticket from the in-memory list
                    // and re-render in place. (Refresh still reconciles on demand.)
                    if (message.provider === 'clickup') {
                        if (_movedTicketId) {
                            clickUpProjectIssues = clickUpProjectIssues.filter(t => t.id !== _movedTicketId);
                            if (selectedClickUpIssue && selectedClickUpIssue.task && selectedClickUpIssue.task.id === _movedTicketId) {
                                selectedClickUpIssue = null;
                            }
                        }
                        renderTicketsClickUpPanel();
                    } else {
                        if (_movedTicketId) {
                            linearProjectIssues = linearProjectIssues.filter(t => t.id !== _movedTicketId);
                            if (selectedLinearIssue && selectedLinearIssue.issue && selectedLinearIssue.issue.id === _movedTicketId) {
                                selectedLinearIssue = null;
                            }
                        }
                        renderTicketsLinearPanel();
                    }
                } else {
                    showTicketsStatus(message.error || 'Failed to move ticket', true);
                }
                break;
            }

            // ── 2d: ticket detail + mutation response arms (moved from planning.js) ──

            case 'editTicketResult':
                setTicketsLoadingState(false);
                if (!message.success) {
                    showTicketsStatus(message.error || 'Failed to import ticket', true);
                } else {
                    showTicketsStatus('Imported ✓', false);
                }
                break;
            case 'pushTicketResult': {
                setTicketsLoadingState(false);
                // A batch ("Push + subtasks") reply carries pushed/skippedStale/failed
                // counts; a plain Push reply does not. A batch reports success ONLY when
                // failed === 0, so partial success arrives on the failure branch — and
                // that is exactly the case the counts exist for. Showing the bare error
                // there would render a 1-of-9 push identically to a 0-of-9 one, which is
                // the reporting defect this action was added to remove.
                const isBatchReply = typeof message.pushed === 'number';
                if (!message.success) {
                    if (isBatchReply) {
                        const summary = message.message || `Push + subtasks: ${message.pushed} pushed, ${message.failed || 0} failed.`;
                        showTicketsStatus(message.error ? `${summary} ${message.error}` : summary, true);
                        // Some children DID push — their badges are stale until refreshed.
                        if (message.pushed > 0) { _requestTicketSyncStatuses(); }
                    } else {
                        showTicketsStatus(message.error || 'Failed to push edits', true);
                    }
                } else {
                    if (isBatchReply) {
                        showTicketsStatus(message.message || `Push + subtasks: ${message.pushed} pushed.`, false);
                    } else {
                        showTicketsStatus('Pushed to source ✓', false);
                    }
                    // Local now matches remote — refresh badges so it flips to synced.
                    _requestTicketSyncStatuses();
                }
                break;
            }
            case 'ticketDeleted':
                setTicketsLoadingState(false);
                if (message.success) {
                    showTicketsStatus('Archived/Deleted ✓', false);
                    selectedLinearIssue = null;
                    selectedClickUpIssue = null;
                    if (lastIntegrationProvider === 'linear') {
                        linearProjectIssues = linearProjectIssues.filter(i => i.id !== message.id);
                        renderTicketsLinearList();
                        renderTicketsLinearTaskDetail();
                    } else {
                        clickUpProjectIssues = clickUpProjectIssues.filter(t => t.id !== message.id);
                        renderTicketsClickUpList();
                        renderTicketsClickUpTaskDetail();
                    }
                    // Refresh the local files sidebar so the deleted ticket's .md file
                    // disappears from the list (the DB entry was removed by deleteTicket).
                    loadLocalTicketFiles();
                } else {
                    showTicketsStatus(message.error || 'Failed to delete ticket', true);
                }
                break;
            case 'changeTicketStatusResult':
                setTicketsLoadingState(false);
                if (message.success) {
                    showTicketsStatus('Status updated ✓', false);
                    if (lastIntegrationProvider === 'linear') {
                        const issue = linearProjectIssues.find(i => i.id === message.id);
                        if (issue && issue.state && _pendingStatusChangeName) issue.state.name = _pendingStatusChangeName;
                        loadLinearTaskDetails(message.id);
                        renderTicketsLinearList();
                    } else {
                        const task = clickUpProjectIssues.find(t => t.id === message.id);
                        if (task && _pendingStatusChangeName) task.status = _pendingStatusChangeName;
                        loadClickUpTaskDetails(message.id);
                        renderTicketsClickUpList();
                    }
                    _pendingStatusChangeName = '';
                } else {
                    showTicketsStatus(message.error || 'Failed to update status', true);
                }
                break;
            case 'linearLabelsUpdated':
                if (selectedLinearIssue && selectedLinearIssue.issue?.id === message.issueId) {
                    loadLinearTaskDetails(message.issueId);
                }
                showTicketsStatus('Labels updated successfully');
                break;
            case 'clickupTagsUpdated':
                if (selectedClickUpIssue && selectedClickUpIssue.task?.id === message.taskId) {
                    selectedClickUpIssue.task.tags = message.tags || [];
                    renderTicketTags(selectedClickUpIssue.task.tags, 'clickup');
                }
                showTicketsStatus('Tags updated successfully');
                break;
            case 'linearAutomationCatalogLoaded':
                availableLinearLabels = message.labels || [];
                availableLinearStates = message.states || [];
                if (_tagsModalOpen && lastIntegrationProvider === 'linear') {
                    _tagsCatalogLoading = false;
                    renderTagsModalList();
                }
                if (lastIntegrationProvider === 'linear') renderTicketsTab();
                break;
            case 'ticketAssigneesLoaded':
                _assignMembers = message.members || [];
                _assignMembersLoading = false;
                renderAssignModalList();
                break;
            case 'ticketAssigneesError':
                _assignMembersLoading = false;
                showTicketsStatus(message.error || 'Failed to load assignees', true);
                break;
            case 'ticketMembersLoaded':
                _assignMembers = message.members || [];
                _assignMembersLoading = false;
                _renderCreateModalAssignees();
                break;
            case 'ticketMembersError':
                _assignMembersLoading = false;
                {
                    const c = document.getElementById('create-ticket-assignees');
                    if (c) c.innerHTML = '<div style="font-size: 12px; color: var(--text-secondary);">No members available.</div>';
                    if (message.error) showTicketsStatus(message.error, true);
                }
                break;
            case 'linearAssigneeUpdated': {
                const assigneeId = message.assigneeId;
                const member = _assignMembers.find(m => String(m.id) === String(assigneeId));
                if (selectedLinearIssue && selectedLinearIssue.issue?.id === message.issueId) {
                    selectedLinearIssue.issue.assignee = member ? { id: member.id, name: member.name, email: member.email } : null;
                }
                const issue = linearProjectIssues.find(i => i.id === message.issueId);
                if (issue) {
                    issue.assignee = member ? { id: member.id, name: member.name, email: member.email } : null;
                }
                showTicketsStatus('Assignee updated successfully');
                renderTicketsLinearList();
                if (selectedLinearIssue && selectedLinearIssue.issue?.id === message.issueId) {
                    loadLinearTaskDetails(message.issueId);
                }
                break;
            }
            case 'clickupAssigneesUpdated': {
                const assigneeIds = message.assigneeIds || [];
                const members = _assignMembers.filter(m => assigneeIds.includes(String(m.id)));
                if (selectedClickUpIssue && selectedClickUpIssue.task?.id === message.taskId) {
                    selectedClickUpIssue.task.assignees = members.map(m => ({ id: Number(m.id), username: m.username, email: m.email }));
                }
                const task = clickUpProjectIssues.find(t => t.id === message.taskId);
                if (task) {
                    task.assignees = members.map(m => ({ id: Number(m.id), username: m.username, email: m.email }));
                }
                showTicketsStatus('Assignees updated successfully');
                renderTicketsClickUpList();
                if (selectedClickUpIssue && selectedClickUpIssue.task?.id === message.taskId) {
                    loadClickUpTaskDetails(message.taskId);
                }
                break;
            }
            case 'linearPriorityUpdated': {
                const issue = linearProjectIssues.find(i => i.id === message.issueId);
                if (issue) {
                    issue.priority = message.priority;
                }
                if (selectedLinearIssue && selectedLinearIssue.issue?.id === message.issueId) {
                    selectedLinearIssue.issue.priority = message.priority;
                }
                _pendingPriorityChange = null;
                document.querySelectorAll(`.ticket-priority-dot[data-ticket-id="${message.issueId}"]`).forEach(el => el.classList.remove('busy'));
                showTicketsStatus('Priority updated successfully');
                renderTicketsLinearList();
                if (selectedLinearIssue && selectedLinearIssue.issue?.id === message.issueId) {
                    loadLinearTaskDetails(message.issueId);
                }
                break;
            }
            case 'clickupPriorityUpdated': {
                const task = clickUpProjectIssues.find(t => t.id === message.taskId);
                if (task) {
                    if (message.priority === 0) {
                        task.priority = null;
                    } else {
                        const opt = _availableClickUpPriorities().find(o => o.value === message.priority) || { name: 'Normal', color: '#6f85ff' };
                        task.priority = {
                            id: String(message.priority),
                            priority: opt.name.toLowerCase(),
                            color: opt.color,
                            orderindex: String(message.priority)
                        };
                    }
                }
                if (selectedClickUpIssue && selectedClickUpIssue.task?.id === message.taskId) {
                    if (message.priority === 0) {
                        selectedClickUpIssue.task.priority = null;
                    } else {
                        const opt = _availableClickUpPriorities().find(o => o.value === message.priority) || { name: 'Normal', color: '#6f85ff' };
                        selectedClickUpIssue.task.priority = {
                            id: String(message.priority),
                            priority: opt.name.toLowerCase(),
                            color: opt.color,
                            orderindex: String(message.priority)
                        };
                    }
                }
                _pendingPriorityChange = null;
                document.querySelectorAll(`.ticket-priority-dot[data-ticket-id="${message.taskId}"]`).forEach(el => el.classList.remove('busy'));
                showTicketsStatus('Priority updated successfully');
                renderTicketsClickUpList();
                if (selectedClickUpIssue && selectedClickUpIssue.task?.id === message.taskId) {
                    loadClickUpTaskDetails(message.taskId);
                }
                break;
            }
            case 'linearTaskDetailsLoaded': {
                const _prevLinear = linearIssueDetailCache.get(message.issue.id);
                const _keepLinearDesc = _prevLinear?.localDescription;
                // Trimmed before rendering: renderMarkdown('\n') returns '<p><br></p>', which is
                // truthy and would make the renderer take the host-HTML branch and paint an empty
                // paragraph instead of the 'No description provided.' empty state. The renderers
                // trim before their emptiness test; this must match.
                const _linearSrc = (message.issue.description || '').trim();
                selectedLinearIssue = {
                    issue: message.issue,
                    subtasks: message.subtasks || [],
                    comments: message.comments || [],
                    attachments: message.attachments || [],
                    // The host's markdown renderer (markdown.api.render) is a VS Code built-in and
                    // is unreachable in the standalone host, where it yields ''. Render locally
                    // rather than letting the view fall back to escaped source text.
                    renderedDescriptionHtml: _keepLinearDesc ? _prevLinear.renderedDescriptionHtml : (message.renderedDescriptionHtml || renderMarkdown(_linearSrc)),
                    descriptionMarkdown: _keepLinearDesc ? _prevLinear.descriptionMarkdown : (message.issue.description || ''),
                    localDescription: _keepLinearDesc || false,
                    // Marks that comments/attachments came from the API. The cache-hit
                    // shortcut on card click only skips the API fetch when this is true,
                    // so file-change stubs (comments: []) never suppress real comments.
                    detailsFetched: true
                };
                linearIssueDetailCache.set(message.issue.id, selectedLinearIssue);
                // Subtask data has now arrived — activate drill-down if the user clicked
                // this parent and it has subtasks.
                _maybeEnterDrillDown('linear', message.issue.id);
                if (!ticketsEditMode) {
                    clearTicketsStatus();
                    renderTicketsTab();
                }
                break;
            }
            case 'clickupTaskDetailsLoaded': {
                const _prevClickUp = clickUpTaskDetailCache.get(message.task.id);
                const _keepClickUpDesc = _prevClickUp?.localDescription;
                // Trimmed for the same reason as the Linear arm above: a whitespace-only
                // description must reach the renderers' empty-state branch, not render as
                // a truthy '<p><br></p>'.
                const _clickUpSrc = (message.task.markdownDescription || message.task.description || '').trim();
                selectedClickUpIssue = {
                    task: message.task,
                    subtasks: message.subtasks || [],
                    comments: message.comments || [],
                    attachments: message.attachments || [],
                    // The host's markdown renderer (markdown.api.render) is a VS Code built-in and
                    // is unreachable in the standalone host, where it yields ''. Render locally
                    // rather than letting the view fall back to escaped source text.
                    renderedDescriptionHtml: _keepClickUpDesc ? _prevClickUp.renderedDescriptionHtml : (message.renderedDescriptionHtml || renderMarkdown(_clickUpSrc)),
                    descriptionMarkdown: _keepClickUpDesc ? _prevClickUp.descriptionMarkdown : (message.task.markdownDescription || message.task.description || ''),
                    localDescription: _keepClickUpDesc || false,
                    // Marks that comments/attachments came from the API. The cache-hit
                    // shortcut on card click only skips the API fetch when this is true,
                    // so file-change stubs (comments: []) never suppress real comments.
                    detailsFetched: true
                };
                clickUpTaskDetailCache.set(message.task.id, selectedClickUpIssue);
                // Subtask data has now arrived — activate drill-down if the user clicked
                // this parent and it has subtasks.
                _maybeEnterDrillDown('clickup', message.task.id);
                if (!ticketsEditMode) {
                    clearTicketsStatus();
                    renderTicketsTab();
                }
                break;
            }
            case 'subtaskConverted': {
                const modal = document.getElementById('convert-subtask-modal');
                if (modal) modal.style.display = 'none';
                if (message.success) {
                    // Three outcomes, not two: the stamp can fail (read-only FS) as well as
                    // be skipped (ticket never imported locally). Only the failure leaves the
                    // sidebar genuinely stale, so it gets its own wording.
                    showTicketsStatus(
                        message.localFileStampFailed
                            ? 'Converted remotely; local view may be stale'
                            : message.localFileUpdated === false
                                ? 'Converted remotely; no local file to update'
                                : 'Converted to subtask ✓',
                        false
                    );
                    const cache = message.provider === 'clickup' ? clickUpTaskDetailCache : linearIssueDetailCache;
                    // Both ends of the relationship are now stale: the parent's cached
                    // `subtasks` array predates the new child, and the child's entry still
                    // has no parent (so "To parent task" would stay hidden).
                    cache.delete(message.taskId);
                    cache.delete(message.parentId);
                    if (message.provider === 'clickup') {
                        if (selectedClickUpIssue?.task?.id === message.taskId) { selectedClickUpIssue = null; }
                    } else {
                        if (selectedLinearIssue?.issue?.id === message.taskId) { selectedLinearIssue = null; }
                    }
                    // Drill-down renders from its own array, which the cache delete above
                    // does not touch. Re-fetch the parent so the sibling list gains the
                    // new child instead of silently omitting it.
                    if (_sidebarDrillDownParentId === message.parentId) {
                        _pendingDrillDownParentId = message.parentId;
                        // Do NOT null _drillDownSubtasks here. _isDrillDownActive gates on it,
                        // so clearing it makes the synchronous renderTicketsTab() below repaint
                        // the full list and the arriving details flip it back — a visible flash;
                        // and if that fetch fails the user is stranded with a drill-down parent
                        // set but no subtask list and no "← Back" header to escape it.
                        // _maybeEnterDrillDown replaces the array wholesale when details land.
                        if (message.provider === 'clickup') { loadClickUpTaskDetails(message.parentId); }
                        else { loadLinearTaskDetails(message.parentId); }
                    }
                    // The sidebar is file-backed — list the files, do NOT re-pull the
                    // remote project (that path repaints from the same local files anyway).
                    loadLocalTicketFiles();
                    renderTicketsTab();
                } else {
                    console.error('Failed to convert to subtask:', message.error);
                    showTicketsStatus(message.error || 'Failed to convert ticket', true);
                }
                break;
            }

            // ── 2c response arms: local file load, sync-status badges, file watcher ──

            case 'ticketSyncStatusesLoaded': {
                if (!_isForThisPanel(message)) { break; }
                const provider = message.provider;
                const statuses = message.statuses || {};
                if (message.success === false) {
                    // Ids stay unresolved and their badges stay `checking`. That is the
                    // honest report of a broken fetch — log it so it's diagnosable, but
                    // do NOT substitute a made-up status.
                    console.warn('[tickets] sync-status fetch failed:', message.error);
                }
                if (provider === 'clickup') {
                    clickUpProjectIssues = clickUpProjectIssues.map(t => ({
                        ...t, syncStatus: statuses[t.id] ?? t.syncStatus
                    }));
                } else {
                    linearProjectIssues = linearProjectIssues.map(t => ({
                        ...t, syncStatus: statuses[t.id] ?? t.syncStatus
                    }));
                }
                // Patch the drill-down set in place too — it is a separate array that the
                // sidebar renders from directly, and it survives subtask-detail loads, so a
                // render-local copy would lose the status on the next re-render.
                if (_drillDownSubtasks && _drillDownProvider === provider) {
                    _drillDownSubtasks = _drillDownSubtasks.map(s => ({ ...s, syncStatus: statuses[s.id] ?? s.syncStatus }));
                }
                renderTicketsTab();
                break;
            }
            case 'localTicketFilesListed': {
                if (!_isForThisPanel(message)) { break; }
                const localProvider = message.provider || lastIntegrationProvider;
                const tickets = message.tickets || [];
                if (!message.unscopedPlaceholder) {
                    ticketsLoadedOnce = true;
                }
                // Scoping can hide every candidate file (legacy files lacking the
                // `listId:`/`projectName:` frontmatter key). That renders identically to
                // "this list has no tickets", so it would never be reported as a
                // regression — say what actually happened instead.
                _ticketsScopeCoverage = message.scopeCoverage || null;
                _ticketsAwaitingListSelection = !!message.unscopedPlaceholder;
                // The local-file lister does not emit syncStatus, so a bare
                // `syncStatus: t.syncStatus` wipes every status already resolved by
                // ticketSyncStatusesLoaded — and both call sites fire the status request
                // BEFORE this load, so a fast reply loses that race. Carry the known
                // value forward; the re-request below fills anything still unknown.
                const prevSync = new Map(
                    (localProvider === 'clickup' ? clickUpProjectIssues : linearProjectIssues)
                        .map(t => [t.id, t.syncStatus])
                );
                if (localProvider === 'clickup') {
                    clickUpProjectIssues = tickets.map(t => ({
                        id: t.id, title: t.title, identifier: t.id,
                        status: t.status || '',
                        assignees: Array.isArray(t.assignees) ? t.assignees.map(n => ({ username: n })) : [],
                        filePath: t.filePath,
                        syncStatus: t.syncStatus ?? prevSync.get(t.id), url: t.url,
                        dateCreated: t.dateCreated,
                        // Priority persisted in the ticket file frontmatter (backend reads it
                        // into { priority, color, orderindex }); pass it through so the
                        // file-backed sidebar renders the priority dot instead of "No priority".
                        priority: t.priority || null,
                        subtaskCount: t.subtaskCount
                    }));
                    clickUpProjectStatus = 'loaded';
                    clickUpProjectMessage = '';
                    clickUpProjectLoading = false;
                } else {
                    linearProjectIssues = tickets.map(t => ({
                        id: t.id, title: t.title, identifier: t.id,
                        state: { name: t.status || '' },
                        assignee: Array.isArray(t.assignees) && t.assignees.length ? { name: t.assignees[0] } : null,
                        description: '', filePath: t.filePath,
                        syncStatus: t.syncStatus ?? prevSync.get(t.id), url: t.url,
                        dateCreated: t.dateCreated,
                        subtaskCount: t.subtaskCount
                    }));
                    linearProjectStatus = 'loaded';
                    linearProjectMessage = '';
                    linearProjectLoading = false;
                }
                renderTicketsTab();
                _requestTicketSyncStatuses();
                break;
            }
            case 'localTicketFileRead': {
                if (!message.success) {
                    // No local file. With subtasks now downloaded at fetch time this is a
                    // rare fallback (offline, revoked token, or a cross-list subtask that
                    // never arrived in any pull), not the common case. For a typed
                    // `not-imported` miss, keep whatever the pane is already showing — the
                    // card-click handler rendered the cached snapshot and dispatched a
                    // parallel linearLoadTaskDetails / clickupLoadTaskDetails request whose
                    // result is the live view. Do NOT blank the pane and do NOT fire a
                    // redundant second fetch.
                    if (message.reason === 'not-imported') {
                        break;
                    }
                    // An untyped failure (genuine caller error) still breaks — transport.js
                    // surfaces it as a toast; there is no payload to render here.
                    break;
                }
                if (_isSelectedTicketPayload(message)) {
                    _applyTicketFilePayloadToSelected(message);
                } else if (!ticketsEditMode) {
                    // FIRST selection of this ticket — nothing to patch, so BUILD the
                    // selected object. The applier deliberately only patches; without this
                    // branch the pane keeps the previously selected ticket until the
                    // parallel API fetch lands, and then shows the REMOTE description,
                    // silently discarding unpushed local edits and the rewritten local
                    // image URLs. localDescription: true is what stops the API response
                    // from overwriting the file's content when it arrives.
                    const editMarkdown = (message.rawContent || message.content || '').replace(/^#[^\n]*\n?/, '').trim();
                    const previewMarkdown = (message.content || '').replace(/^#[^\n]*\n?/, '').trim();
                    const rendered = renderMarkdown(previewMarkdown);
                    // The file's H1 wins over any cached title. HEAD wrote
                    // `existing?.task || {…title: message.title…}`, so whenever a cache
                    // entry existed the `||` short-circuited and message.title was
                    // discarded — the stale-heading half of the reported bug.
                    const nextTitle = message.title;
                    if (message.provider === 'clickup') {
                        const existing = clickUpTaskDetailCache.get(message.id);
                        selectedClickUpIssue = {
                            task: existing?.task
                                ? { ...existing.task, title: nextTitle || existing.task.title, name: nextTitle || existing.task.name }
                                : { id: message.id, title: nextTitle, name: nextTitle, status: '', assignees: [] },
                            subtasks: existing?.subtasks || [],
                            comments: existing?.comments || [],
                            attachments: existing?.attachments || [],
                            renderedDescriptionHtml: rendered,
                            descriptionMarkdown: editMarkdown,
                            localDescription: true,
                            detailsFetched: existing?.detailsFetched || false
                        };
                        clickUpTaskDetailCache.set(message.id, selectedClickUpIssue);
                    } else {
                        const existing = linearIssueDetailCache.get(message.id);
                        selectedLinearIssue = {
                            issue: existing?.issue
                                ? { ...existing.issue, title: nextTitle || existing.issue.title }
                                : { id: message.id, title: nextTitle, state: { name: '' }, assignee: null },
                            subtasks: existing?.subtasks || [],
                            comments: existing?.comments || [],
                            attachments: existing?.attachments || [],
                            renderedDescriptionHtml: rendered,
                            descriptionMarkdown: editMarkdown,
                            localDescription: true,
                            detailsFetched: existing?.detailsFetched || false
                        };
                        linearIssueDetailCache.set(message.id, selectedLinearIssue);
                    }
                }
                // Clear any stale error — the local description is already displayed,
                // so a supplementary API failure is not a total failure.
                clearTicketsStatus();
                renderTicketsTab();
                break;
            }
            case 'ticketFileChanged': {
                const changedId = message.id;
                const changedProvider = message.provider;
                const isCurrentClickUp = changedProvider === 'clickup' && selectedClickUpIssue?.task?.id === changedId;
                const isCurrentLinear = changedProvider === 'linear' && selectedLinearIssue?.issue?.id === changedId;
                // content = rewritten webview URIs (preview); rawContent = original local paths (edit/push).
                const changedBodyMarkdown = (message.content || '').replace(/^#[^\n]*\n?/, '').trim();
                const editBodyMarkdown = (message.rawContent || message.content || '').replace(/^#[^\n]*\n?/, '').trim();
                if (_applyTicketFilePayloadToSelected(message)) {
                    renderTicketsTab();
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
                            ...(existing || { task: { id: changedId, title: message.title, name: message.title, status: '', assignees: [] }, subtasks: [], comments: [], attachments: [] }),
                            renderedDescriptionHtml: changedRendered,
                            descriptionMarkdown: editBodyMarkdown
                        });
                    } else {
                        const existing = linearIssueDetailCache.get(changedId);
                        linearIssueDetailCache.set(changedId, {
                            ...(existing || { issue: { id: changedId, title: message.title, state: { name: '' }, assignee: null }, subtasks: [], comments: [], attachments: [] }),
                            renderedDescriptionHtml: changedRendered,
                            descriptionMarkdown: editBodyMarkdown
                        });
                    }
                }
                // Re-render the sidebar list so a non-selected ticket's card title
                // updates without a manual Refresh. Debounced: a burst of N file
                // changes collapses to one list reload. Also covers the selected
                // ticket — its sidebar card title can change too.
                _scheduleSidebarRefreshFromFiles();
                break;
            }
            case 'ticketFileDeleted': {
                const deletedId = message.id;
                const deletedProvider = message.provider;
                clickUpTaskDetailCache.delete(deletedId);
                linearIssueDetailCache.delete(deletedId);
                // Clear the detail pane rather than leave it showing a file that no
                // longer exists.
                if (deletedProvider === 'clickup' && selectedClickUpIssue?.task?.id === deletedId) {
                    selectedClickUpIssue = null;
                    renderTicketsTab();
                } else if (deletedProvider === 'linear' && selectedLinearIssue?.issue?.id === deletedId) {
                    selectedLinearIssue = null;
                    renderTicketsTab();
                }
                _scheduleSidebarRefreshFromFiles();
                break;
            }

            // ── 2e: comment manager + attachment response arms (moved from planning.js) ──
            case 'postTicketCommentResult':
                setTicketsLoadingState(false);
                if (message.success) {
                    showTicketsStatus('Comment posted ✓', false);
                    // Refetch threads to reconcile optimistic insert.
                    // loadCommentThreads sets the in-flight marker itself.
                    if (_cmActiveTicketId === message.id) {
                        loadCommentThreads(lastIntegrationProvider, message.id);
                    }
                } else {
                    // Rollback optimistic insert, restore draft
                    rollbackOptimisticComment(null);
                    showTicketsStatus(message.error || 'Failed to post comment', true);
                    showCommentManagerError(message.error || 'Failed to post comment');
                }
                break;
            case 'postTicketReplyResult':
                setTicketsLoadingState(false);
                if (message.success) {
                    showTicketsStatus('Reply posted ✓', false);
                    if (_cmActiveTicketId === message.id) {
                        loadCommentThreads(lastIntegrationProvider, message.id);
                    }
                } else {
                    // Rollback optimistic reply, restore draft
                    rollbackOptimisticComment(message.commentId);
                    showTicketsStatus(message.error || 'Failed to post reply', true);
                    showCommentManagerError(message.error || 'Failed to post reply');
                }
                break;
            case 'ticketCommentsLoaded':
                setTicketsLoadingState(false);
                if (message.success) {
                    const newThreads = message.threads || [];
                    // Preserve optimistic replies that haven't been confirmed by the API yet.
                    // Match by body+author+timestamp proximity to replace optimistic with real.
                    _cmThreads = mergeOptimisticReplies(_cmThreads, newThreads);
                    _cmMembers = message.members || [];
                    _cmThreadingSupported = message.threadingSupported !== false;
                    // Refetch stale guard: if a new optimistic insert arrived
                    // while this refetch was pending, discard and re-fetch.
                    if (_pendingRefetchTicketId === message.id) {
                        _pendingRefetchTicketId = null;
                        if (_refetchStale) {
                            _refetchStale = false;
                            loadCommentThreads(message.provider, message.id);
                            break;
                        }
                    }
                    renderCommentManager(_cmThreads, _cmMembers);
                } else {
                    showTicketsStatus(message.error || 'Failed to load comments', true);
                    const threadsDiv = document.getElementById('tickets-comment-threads');
                    if (threadsDiv) {
                        threadsDiv.innerHTML = '<div class="cm-error">' + escapeHtml(message.error || 'Failed to load comments') + '</div>';
                    }
                }
                break;
            case 'attachmentDownloaded':
                if (message.success) {
                    showTicketsStatus('Attachment downloaded ✓', false);
                    if (message.filePath) {
                        const { ticketsStatusFooter } = getTicketsTabElements();
                        if (ticketsStatusFooter) {
                            ticketsStatusFooter.textContent = `Downloaded to: ${message.filePath}`;
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
                    showTicketsStatus(message.error || 'Failed to download attachment', true);
                }
                break;

            case 'attachmentsListResult':
                if (message.success) {
                    renderAttachmentsList(message.attachments);
                } else {
                    showTicketsStatus(message.error || 'Failed to load attachments list', true);
                }
                break;

            case 'attachmentOpened':
                if (message.success) {
                    showTicketsStatus('Attachment opened ✓', false);
                } else {
                    showTicketsStatus(message.error || 'Failed to open attachment', true);
                }
                break;

            case 'attachmentRevealed':
                if (message.success) {
                    showTicketsStatus('Attachment revealed ✓', false);
                } else {
                    showTicketsStatus(message.error || 'Failed to reveal attachment', true);
                }
                break;

            // ── 2f response arms: sync / import / create / ask-agent / link ──
            // Moved from planning.js. The import verb handlers (importAllTickets,
            // refreshTicketsDelta) post importAllTicketsComplete; the sync handler
            // posts syncAllTicketsResult + syncAllTicketsProgress; create handlers
            // post clickupTaskCreated / linearIssueCreated; import-single posts
            // clickupTaskImported / linearTaskImported; ask-agent posts
            // ticketsAskAgentResult; copyToClipboard posts ticketLinkCopied /
            // ticketLinkFailed. Bodies verbatim; only the message var name differs
            // (planning.js used `msg`, tickets.js uses `message`).

            case 'importAllTicketsComplete':
                if (!_isForThisPanel(message)) { break; }
                setTicketsLoadingState(false);
                isImportingAll = false;
                {
                    // ── 2f: btn-import-all-tickets never existed in tickets.html;
                    //    only #tickets-import-all-kanban needs re-enabling. ──
                    const importAllPlansBtn = document.getElementById('tickets-import-all-kanban');
                    if (importAllPlansBtn) importAllPlansBtn.disabled = false;
                    // Suppress status toast for auto-sync delta pulls — the user
                    // didn't initiate the action, and showing "Imported N tickets"
                    // every 45s would be toast spam. Just refresh the sidebar.
                    if (!message.autoSync) {
                        if (message.success) {
                            let statusText = `Imported ${message.successCount} tickets, ${message.failCount} failed.`;
                            if (message.errors && message.errors.length > 0) {
                                statusText += ' Failed: ' + message.errors.map(e => e.id).join(', ');
                            }
                            showTicketsStatus(statusText, message.failCount > 0);
                        } else {
                            showTicketsStatus(message.error || 'Bulk import failed', true);
                        }
                    }
                }
                // Re-render sidebar from local files so newly imported tickets appear.
                loadLocalTicketFiles();
                _requestTicketSyncStatuses();
                break;
            case 'syncAllTicketsResult': {
                const syncAllBtn = document.getElementById('tickets-sync-all');
                if (syncAllBtn) syncAllBtn.disabled = false;
                // `skipped` = files already in sync with the remote, which Sync All now
                // filters out instead of pushing. Report it: without it, the common case
                // (nothing modified) rendered as "No local ticket files to sync." — a lie
                // when there are hundreds of files, all of them simply current.
                const skipped = message.skipped || 0;
                const inSync = skipped > 0 ? ` ${skipped} already in sync.` : '';
                if (message.success) {
                    if (message.succeeded === 0) {
                        showTicketsStatus(
                            skipped > 0
                                ? `Nothing to push —${inSync.replace(/\.$/, '')}.`
                                : 'No local ticket files to sync.',
                            false
                        );
                    } else {
                        showTicketsStatus(`Pushed ${message.succeeded} ticket${message.succeeded === 1 ? '' : 's'}.${inSync}`, false);
                    }
                } else {
                    showTicketsStatus(`Pushed ${message.succeeded} succeeded, ${message.failed} failed.${inSync}`, true);
                }
                break;
            }
            case 'syncAllTicketsProgress':
                showTicketsStatus(`Syncing… ${message.done}/${message.total}`, false);
                break;
            case 'ticketLinkCopied':
                if (_lastLinkTicketBtn) {
                    flashIconBtn(_lastLinkTicketBtn);
                    _lastLinkTicketBtn = null;
                }
                break;
            case 'ticketLinkFailed':
                showTicketsStatus(message.error || 'Could not locate or create a local file for this ticket.', true);
                if (_lastLinkTicketBtn) {
                    _lastLinkTicketBtn.disabled = false;
                    _lastLinkTicketBtn = null;
                }
                break;
            case 'clickupTaskCreated': {
                const submitBtn = document.getElementById('btn-submit-create-ticket');
                if (submitBtn) {
                    submitBtn.disabled = false;
                    submitBtn.textContent = 'Create';
                }
                if (message.success) {
                    const modal = document.getElementById('create-ticket-modal');
                    if (modal) modal.style.display = 'none';
                    const titleInput = document.getElementById('create-ticket-title');
                    const descInput = document.getElementById('create-ticket-description');
                    if (titleInput) titleInput.value = '';
                    if (descInput) descInput.value = '';
                    _resetCreateModalMetadata();
                    if (_subtaskParent) {
                        const parentId = _subtaskParent.id;
                        _subtaskParent = null;
                        const modalTitle = document.getElementById('create-ticket-modal-title');
                        if (modalTitle) modalTitle.textContent = 'Create New Ticket';
                        _pendingDrillDownParentId = parentId;   // drill in when details arrive
                        loadClickUpTaskDetails(parentId);
                    } else {
                        loadClickUpProject(true);
                    }
                } else {
                    console.error('Failed to create ClickUp ticket:', message.error);
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
                if (message.success) {
                    const modal = document.getElementById('create-ticket-modal');
                    if (modal) modal.style.display = 'none';
                    const titleInput = document.getElementById('create-ticket-title');
                    const descInput = document.getElementById('create-ticket-description');
                    if (titleInput) titleInput.value = '';
                    if (descInput) descInput.value = '';
                    _resetCreateModalMetadata();
                    if (_subtaskParent) {
                        const parentId = _subtaskParent.id;
                        _subtaskParent = null;
                        const modalTitle = document.getElementById('create-ticket-modal-title');
                        if (modalTitle) modalTitle.textContent = 'Create New Ticket';
                        _pendingDrillDownParentId = parentId;   // drill in when details arrive
                        loadLinearTaskDetails(parentId);
                    } else {
                        loadLinearProject(true);
                    }
                } else {
                    console.error('Failed to create Linear ticket:', message.error);
                    showTicketsStatus('Failed to create ticket', true);
                }
                break;
            }
            case 'linearTaskImported':
            case 'clickupTaskImported':
                if (message.success) {
                    showTicketsStatus('Imported ✓', false);
                } else {
                    console.error('Import failed:', message.error);
                    showTicketsStatus('Import failed', true);
                }
                break;
            case 'ticketsAskAgentResult':
                if (message.success) {
                    showTicketsStatus('Sent to agent ✓', false);
                } else {
                    console.error('Ask Agent failed:', message.error);
                    showTicketsStatus(message.error || 'Ask Agent failed', true);
                }
                break;
            // ── Plan 4: ClickUp/Linear config message handlers ──
            case 'integrationSetupStates': {
                setIntegrationStatus('clickup', message.clickupSetupComplete ? 'configured' : 'idle');
                setIntegrationStatus('linear', message.linearSetupComplete ? 'configured' : 'idle');
                // Populate masked tokens
                const tokenFieldMap = [
                    { flag: message.clickupHasToken, id: 'clickup-token-input' },
                    { flag: message.linearHasToken, id: 'linear-token-input' }
                ];
                tokenFieldMap.forEach(({ flag, id }) => {
                    const input = document.getElementById(id);
                    if (flag && input) {
                        input.value = '**********';
                        input.dataset.hasToken = 'true';
                        input.dataset.originalHasToken = 'true';
                        input.style.borderLeft = '3px solid var(--accent-green)';
                    } else if (input) {
                        input.dataset.hasToken = 'false';
                        input.dataset.originalHasToken = 'false';
                        input.style.borderLeft = '';
                    }
                });
                lastClickupSetupState = message.clickupState ? JSON.parse(JSON.stringify(message.clickupState)) : null;
                lastLinearSetupState = message.linearState ? JSON.parse(JSON.stringify(message.linearState)) : null;
                renderClickupSetupState();
                renderLinearSetupState();
                updateApplyButtonsState();
                break;
            }
            case 'clickupApplyResult':
                setApplyButtonBusy('clickup', false);
                setIntegrationStatus('clickup', message.success ? 'configured' : 'failed', message.error || '');
                if (message.success) {
                    setClickupSetupMessage('ClickUp settings applied. Review mappings and automation below.');
                }
                break;
            case 'clickupMappingsSaved':
                setButtonBusy(document.getElementById('btn-clickup-save-mappings'), false);
                setClickupSetupMessage(message.success === false ? (message.error || 'Failed to save ClickUp mappings.') : 'ClickUp mappings saved.', message.success === false);
                break;
            case 'clickupAutomationSaved':
                setButtonBusy(document.getElementById('btn-clickup-save-automation'), false);
                setClickupSetupMessage(message.success === false ? (message.error || 'Failed to save ClickUp automation.') : 'ClickUp automation saved.', message.success === false);
                break;
            case 'linearApplyResult':
                setApplyButtonBusy('linear', false);
                setIntegrationStatus('linear', message.success ? 'configured' : 'failed', message.error || '');
                if (message.success) {
                    setLinearSetupMessage('Linear settings applied. Review automation rules below.');
                }
                break;
            case 'triagePipelineResult': {
                const resultEl = document.getElementById(message.provider === 'linear' ? 'linear-triage-result' : 'clickup-triage-result');
                const btn = document.getElementById(message.provider === 'linear' ? 'btn-enable-triage-linear' : 'btn-enable-triage-clickup');
                if (btn) { setButtonBusy(btn, false); }
                if (resultEl) {
                    if (message.success) {
                        const projName = message.projectName || 'Bug Triage';
                        resultEl.style.color = 'var(--accent-green, var(--text-secondary))';
                        resultEl.innerHTML = `✓ Triage pipeline enabled — project <strong>"${projName}"</strong> created. Tagged tickets will auto-import to the <strong>Ticket Updater</strong> column and dispatch the ticket_updater agent. Verdicts are written back on completion.`;
                    } else {
                        resultEl.style.color = 'var(--accent-red)';
                        resultEl.textContent = message.error || 'Failed to enable triage pipeline.';
                    }
                }
                break;
            }
            case 'linearBrowseProjectsResult':
                if (message.success && Array.isArray(message.projects)) {
                    const targetInput = message.target === 'include'
                        ? document.getElementById('linear-option-include-projects')
                        : document.getElementById('linear-option-exclude-projects');
                    if (targetInput) {
                        targetInput.value = message.projects.join(', ');
                    }
                }
                break;
            case 'linearAutomationSaved':
                setButtonBusy(document.getElementById('btn-linear-save-automation'), false);
                setLinearSetupMessage(message.success === false ? (message.error || 'Failed to save Linear automation.') : 'Linear automation saved.', message.success === false);
                break;
            // The `ticketsFoldersListed` alias this arm carried in setup.html was
            // dropped when the integration-setup markup merged into this panel:
            // tickets.js already owns a `ticketsFoldersListed` arm (the folder-list
            // modal) earlier in this same switch, so the alias was unreachable —
            // and had it ever won the match it would have clobbered the integration
            // setup fields on a plain folder-list load. (The auto-sync toggle this
            // note originally named is gone: it drove a no-op stub, so it was removed
            // along with the stub rather than left as a control over nothing.)
            // The integration-setup path is driven by `getIntegrationTicketSaveLocations`.
            case 'integrationTicketSaveLocations': {
                if (message.provider === 'clickup') {
                    const input = document.getElementById('clickup-ticket-import-folder');
                    if (input) input.value = message.path || '';
                } else if (message.provider === 'linear') {
                    const input = document.getElementById('linear-ticket-import-folder');
                    if (input) input.value = message.path || '';
                }
                updateApplyButtonsState();
                break;
            }
            case 'ticketsFolderPathResult': {
                if (message.provider === 'clickup') {
                    const input = document.getElementById('clickup-ticket-import-folder');
                    if (input) input.value = message.path || '';
                } else if (message.provider === 'linear') {
                    const input = document.getElementById('linear-ticket-import-folder');
                    if (input) input.value = message.path || '';
                }
                updateApplyButtonsState();
                break;
            }
            // Same as above: the `browseTicketsFolderResult` alias is dropped. That
            // message type is already claimed earlier in this switch by the
            // tickets-folder arm (which posts `saveTicketsFolder`), so the alias was
            // unreachable here. The integration-setup Browse button posts
            // `browseIntegrationTicketSaveLocation` and is answered by the label below.
            case 'integrationTicketSaveLocationBrowsed': {
                if (message.provider === 'clickup') {
                    const input = document.getElementById('clickup-ticket-import-folder');
                    if (input) input.value = message.path || '';
                    vscode.postMessage({ type: 'saveIntegrationTicketSaveLocation', provider: 'clickup', folderPath: message.path || '' });
                } else if (message.provider === 'linear') {
                    const input = document.getElementById('linear-ticket-import-folder');
                    if (input) input.value = message.path || '';
                    vscode.postMessage({ type: 'saveIntegrationTicketSaveLocation', provider: 'linear', folderPath: message.path || '' });
                }
                updateApplyButtonsState();
                break;
            }
            case 'planningSources':
                if (message.sources) {
                    lastPlanningSources = {
                        clickup: message.sources.clickup !== false,
                        linear: message.sources.linear !== false,
                        notion: message.sources.notion !== false,
                        'local-folder': message.sources['local-folder'] !== false
                    };
                    const clickupCheckbox = document.getElementById('planning-source-clickup');
                    const linearCheckbox = document.getElementById('planning-source-linear');
                    if (clickupCheckbox) clickupCheckbox.checked = lastPlanningSources.clickup;
                    if (linearCheckbox) linearCheckbox.checked = lastPlanningSources.linear;
                }
                break;
            case 'planningSourcesSaved':
                // No-op: the host pushes planningSources after save, which updates the checkboxes
                break;
        }
    });

    // Restore a root carried in webview-local state (set by persistTicketsRoot).
    // This is the across-reload path that works today, before restoredTabState is
    // pushed by TicketsPanelProvider.
    if (persistedState && persistedState.ticketsWorkspaceRoot) {
        ticketsWorkspaceRoot = persistedState.ticketsWorkspaceRoot;
    }

    // Clean up the debounced sidebar-refresh timer on page hide / unload so a
    // pending reload does not fire after the panel is gone.
    window.addEventListener('pagehide', () => clearTimeout(_ticketFileChangedDebounce));
    window.addEventListener('beforeunload', () => clearTimeout(_ticketFileChangedDebounce));

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initTicketsTab);
    } else {
        initTicketsTab();
    }
})();
