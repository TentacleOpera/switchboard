(function() {
    const vscode = acquireVsCodeApi();

    // Tab management
    const tabs = document.querySelectorAll('.shared-tab-btn');
    const tabContents = document.querySelectorAll('.shared-tab-content');
    let activeTab = 'kanban';

    tabs.forEach(tab => {
        tab.addEventListener('click', () => {
            const targetTab = tab.dataset.tab;
            tabs.forEach(t => t.classList.remove('active'));
            tabContents.forEach(c => c.classList.remove('active'));

            tab.classList.add('active');
            const targetContent = document.getElementById(`${targetTab}-content`);
            if (targetContent) targetContent.classList.add('active');
            activeTab = targetTab;

            // Apply sidebar state for the active tab
            if (targetTab === 'kanban') {
                applySidebarState('kanban', state.kanbanListCollapsed);
            } else if (targetTab === 'epics') {
                applySidebarState('epics', state.epicsListCollapsed);
            } else if (targetTab === 'constitution') {
                applySidebarState('constitution', state.constitutionListCollapsed);
            } else if (targetTab === 'system') {
                applySidebarState('system', state.systemListCollapsed);
            } else if (targetTab === 'tuning') {
                applySidebarState('tuning', state.tuningListCollapsed);
            } else if (targetTab === 'projects') {
                applySidebarState('projects', state.projectsListCollapsed);
            } else if (targetTab === 'devdocs') {
                applySidebarState('devdocs', state.devdocsListCollapsed);
            }

            if (activeTab === 'kanban') {
                vscode.postMessage({ type: 'fetchKanbanPlans', requestId: Date.now() });
            } else if (activeTab === 'projects') {
                // Ensure the workspace/project caches are fresh, then hydrate the PRD editor.
                vscode.postMessage({ type: 'fetchKanbanPlans', requestId: Date.now() });
                hydrateProjectsTab();
            } else if (activeTab === 'epics') {
                vscode.postMessage({ type: 'fetchKanbanPlans', requestId: Date.now() });
                updateActiveEpicBanner();
            } else if (activeTab === 'constitution') {
                vscode.postMessage({ type: 'loadConstitutionFiles' });
            } else if (activeTab === 'system') {
                vscode.postMessage({ type: 'loadConstitutionFiles' });
            } else if (activeTab === 'tuning') {
                vscode.postMessage({ type: 'loadInsights', workspaceRoot: tuningWorkspaceFilter ? tuningWorkspaceFilter.value : '' });
            } else if (activeTab === 'devdocs') {
                vscode.postMessage({ type: 'loadDevDocs' });
            } else if (activeTab === 'remote') {
                const wsSel = document.getElementById('remote-workspace');
                const remoteWs = (wsSel && wsSel.value) || undefined;
                vscode.postMessage({ type: 'getRemoteConfig', workspaceRoot: remoteWs });
                vscode.postMessage({ type: 'getProjectContextSyncStatus', workspaceRoot: remoteWs });
            } else if (activeTab === 'notebook') {
                hydrateNotebookTab();
            }
        });
    });

    // Global state
    const state = {
        editMode: { kanban: false, constitution: false, epics: false, system: false, projects: false, devdocs: false },
        editOriginalContent: { kanban: null, constitution: null, epics: null, system: null, projects: null, devdocs: null },
        dirtyFlags: { kanban: false, constitution: false, epics: false, system: false, projects: false, devdocs: false },
        externalChangePending: { kanban: false, constitution: false, epics: false, system: false, projects: false, devdocs: false },
        reviewMode: { kanban: false },
        kanbanListCollapsed: false,
        epicsListCollapsed: false,
        constitutionListCollapsed: false,
        systemListCollapsed: false,
        tuningListCollapsed: false,
        projectsListCollapsed: false,
        devdocsListCollapsed: false,
        switchboardTheme: 'afterburner'
    };

    // Initialize from persisted state
    const persistedState = vscode.getState() || {};
    state.kanbanListCollapsed = persistedState.kanbanListCollapsed || false;
    state.epicsListCollapsed = persistedState.epicsListCollapsed || false;
    state.constitutionListCollapsed = persistedState.constitutionListCollapsed || false;
    state.systemListCollapsed = persistedState.systemListCollapsed || false;
    state.tuningListCollapsed = persistedState.tuningListCollapsed || false;
    state.projectsListCollapsed = persistedState.projectsListCollapsed || false;
    state.devdocsListCollapsed = persistedState.devdocsListCollapsed || false;

    // Toast notification — replaces alert() which is a silent no-op in VS Code webviews.
    // type: 'error' | 'success' | 'info'
    function showToast(message, type = 'info') {
        const toast = document.createElement('div');
        toast.className = `toast-notification toast-${type}`;
        toast.textContent = message;
        document.body.appendChild(toast);
        setTimeout(() => {
            toast.style.opacity = '0';
            toast.style.transition = 'opacity 0.3s ease-out';
            setTimeout(() => toast.remove(), 300);
        }, 4000);
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
    }

    function toggleSidebarCollapsed() {
        if (activeTab === 'kanban') {
            state.kanbanListCollapsed = !state.kanbanListCollapsed;
            applySidebarState('kanban', state.kanbanListCollapsed);
        } else if (activeTab === 'epics') {
            state.epicsListCollapsed = !state.epicsListCollapsed;
            applySidebarState('epics', state.epicsListCollapsed);
        } else if (activeTab === 'constitution') {
            state.constitutionListCollapsed = !state.constitutionListCollapsed;
            applySidebarState('constitution', state.constitutionListCollapsed);
        } else if (activeTab === 'system') {
            state.systemListCollapsed = !state.systemListCollapsed;
            applySidebarState('system', state.systemListCollapsed);
        } else if (activeTab === 'tuning') {
            state.tuningListCollapsed = !state.tuningListCollapsed;
            applySidebarState('tuning', state.tuningListCollapsed);
        } else if (activeTab === 'projects') {
            state.projectsListCollapsed = !state.projectsListCollapsed;
            applySidebarState('projects', state.projectsListCollapsed);
        } else if (activeTab === 'devdocs') {
            state.devdocsListCollapsed = !state.devdocsListCollapsed;
            applySidebarState('devdocs', state.devdocsListCollapsed);
        }

        // Persist state
        const currentPersisted = vscode.getState() || {};
        vscode.setState({
            ...currentPersisted,
            kanbanListCollapsed: state.kanbanListCollapsed,
            epicsListCollapsed: state.epicsListCollapsed,
            constitutionListCollapsed: state.constitutionListCollapsed,
            systemListCollapsed: state.systemListCollapsed,
            tuningListCollapsed: state.tuningListCollapsed,
            projectsListCollapsed: state.projectsListCollapsed,
            devdocsListCollapsed: state.devdocsListCollapsed
        });
    }

    function handleThemeChanged(theme) {
        if (theme) { state.switchboardTheme = theme; }
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
    }

    let _kanbanPlansCache = [];
    let _kanbanAllWorkspaceProjects = {};
    let _kanbanProjectsError = false;
    let _kanbanWorkspaceItems = [];
    let _kanbanAvailableColumns = [];
    let _kanbanSelectedPlan = null;
    let _kanbanPreviewRequestId = 0;
    let uploadingPlanAttachment = false;

    let _epicSelectedPlan = null;
    let _epicSubtaskPreview = null; // holds the subtask plan object when a subtask is previewed in the epics pane
    let _epicPreviewFilePath = null;
    let _pendingKanbanSelection = null;
    let _pendingEpicSelection = null;
    let _pendingAutoEdit = false;
    let _pendingKanbanFilterIntent = null;   // { workspaceRoot, project, column } — applied after dropdowns populate
    let _pendingKanbanSelectionRetries = 0;  // incremented on failed resolution; fallback to widest at 3

    let _activeEpicFilePath = '';

    let _constitutionWorkspaces = [];
    let _constitutionSelectedWorkspace = null;
    let _constitutionSelectedFile = null;
    let _constitutionSelectedGovKey = 'constitution';

    let _systemSelectedWorkspace = null;
    let _systemSelectedFile = null;
    let _systemSelectedGovKey = 'claude';

    // Workspace filter selections for the governance tabs ('' = All Workspaces).
    // The sidebar lists docs; these dropdowns only narrow which workspaces' docs show.
    let _constitutionWsFilter = '';
    let _systemWsFilter = '';

    function govExists(ws, key) {
        if (ws.governance && Array.isArray(ws.governance)) {
            const entry = ws.governance.find(g => g.key === key);
            if (entry) return !!entry.exists;
        }
        if (key === 'constitution') return !!ws.hasConstitution;
        return false;
    }

    // Elements
    const kanbanWorkspaceFilter = document.getElementById('kanban-workspace-filter');
    const kanbanProjectFilter = document.getElementById('kanban-project-filter');
    const kanbanColumnFilter = document.getElementById('kanban-column-filter');
    const kanbanComplexityFilter = document.getElementById('kanban-complexity-filter');
    const kanbanSearch = document.getElementById('kanban-search');
    const btnImportKanbanPlans = document.getElementById('btn-import-kanban-plans');
    const btnCreateKanbanPlan = document.getElementById('btn-create-kanban-plan');
    const btnChatCopyPrompt = document.getElementById('btn-chat-copy-prompt');
    const btnEditKanban = null;
    const btnSaveKanban = null;
    const btnCancelKanban = null;
    const kanbanListPane = document.getElementById('kanban-list-pane');
    const kanbanPreviewPane = document.getElementById('kanban-preview-pane');
    const kanbanPreviewContent = document.getElementById('kanban-preview-content');
    const kanbanEditor = document.getElementById('kanban-editor');
 
    const epicsWorkspaceFilter = document.getElementById('epics-workspace-filter');
    const epicsColumnFilter = document.getElementById('epics-column-filter');

    const btnNewEpic = document.getElementById('btn-new-epic');
    const newEpicModal = document.getElementById('new-epic-modal');
    const newEpicName = document.getElementById('new-epic-name');
    const newEpicDescription = document.getElementById('new-epic-description');
    const btnNewEpicCancel = document.getElementById('btn-new-epic-cancel');
    const btnNewEpicSubmit = document.getElementById('btn-new-epic-submit');
    const epicsListPane = document.getElementById('epics-list-pane');
    const epicsPreviewPane = document.getElementById('epics-preview-pane');
    const epicsPreviewContent = document.getElementById('epics-preview-content');
    const epicsEditor = document.getElementById('epics-editor');


    // Intercept clicks on <a> tags inside the rendered epic markdown preview.
    // Subtask links in the auto-generated "## Subtasks" section are rendered as
    // <a href="../plans/basename.md" data-href="../plans/basename.md"> by VS Code's
    // markdown renderer (markdown.api.render). In the sandboxed webview these do
    // nothing — we resolve them and load the subtask into the preview pane,
    // mirroring the sidebar subtask-link behavior.
    //
    // NOTE: This listener is attached once (delegation). It is NOT re-attached on
    // each render — innerHTML replacement preserves the container's event listeners.
    // NOTE: Path resolution assumes forward-slash paths, which is guaranteed by the
    // DB planFile format (.switchboard/epics/<file>).
    // NOTE: Read getAttribute('data-href') first (pre-normalization value), then
    // fall back to getAttribute('href'). Never use the .href DOM property — it
    // resolves to an absolute CDN URL and loses the relative form (VS Code PR #228633).
    // NOTE: decodeURIComponent is needed because markdown-it's normalizeLink
    // percent-encodes special characters (e.g., spaces → %20).
    if (epicsPreviewContent) {
        epicsPreviewContent.addEventListener('click', (e) => {
            const anchor = e.target.closest('a');
            if (!anchor) return;
            // Prefer data-href (pre-normalization) over href; both are byte-identical
            // for bare relative paths, but data-href is more defensively correct.
            const rawHref = anchor.getAttribute('data-href') || anchor.getAttribute('href') || '';
            if (!rawHref) return;

            // Decode percent-encoded characters (e.g., %20 → space) before processing.
            let href;
            try {
                href = decodeURIComponent(rawHref);
            } catch {
                href = rawHref; // malformed URI sequence — use raw value as fallback
            }

            // Only intercept links to local .md files (plan files).
            // External URLs (http://, https://, mailto:, #anchors) are left alone.
            if (!href.endsWith('.md')) return;
            if (/^(https?:|mailto:|tel:|#)/i.test(href)) return;

            e.preventDefault();
            e.stopPropagation();

            // Resolve the relative href against the directory of the currently-
            // displayed file. The epic lives at .switchboard/epics/<file>, so
            // ../plans/foo.md resolves to .switchboard/plans/foo.md.
            const basePath = _epicPreviewFilePath || (_epicSelectedPlan && _epicSelectedPlan.planFile) || '';
            if (!basePath) {
                showToast('Cannot resolve subtask link — no file context.', 'error');
                return;
            }

            const baseDir = basePath.includes('/') ? basePath.substring(0, basePath.lastIndexOf('/')) : '';
            // Normalize the joined path: split on /, process .. and . segments.
            const segments = (baseDir + '/' + href).split('/');
            const resolved = [];
            for (const seg of segments) {
                if (seg === '..') resolved.pop();
                else if (seg !== '.' && seg !== '') resolved.push(seg);
            }
            const resolvedPath = resolved.join('/');

            if (state.editMode.epics) exitEditMode('epics');
            _epicPreviewFilePath = resolvedPath;
            epicsPreviewContent.innerHTML = '<div class="kanban-empty-state">Loading preview...</div>';
            vscode.postMessage({
                type: 'fetchKanbanPlanPreview',
                filePath: resolvedPath,
                requestId: ++_kanbanPreviewRequestId
            });
            // Hide the Edit button while a subtask is previewed (not the epic itself).
            const btnEdit = document.getElementById('btn-edit-epics');
            if (btnEdit) btnEdit.style.display = 'none';
        });
    }

    const btnBuildViaPlanner = document.getElementById('btn-build-via-planner');
    const btnCopyBuildPrompt = document.getElementById('btn-copy-build-prompt');
    const btnUpdateViaPlanner = document.getElementById('btn-update-via-planner');
    const btnCopyUpdatePrompt = document.getElementById('btn-copy-update-prompt');
    const btnEnableConstitution = document.getElementById('btn-enable-constitution');
    const btnDeleteConstitution = document.getElementById('btn-delete-constitution');
    const btnManageConstitutionPaths = document.getElementById('btn-manage-constitution-paths');
    const activeConstitutionPathBtn = document.getElementById('active-constitution-path-btn');
    const constitutionPathsModal = document.getElementById('constitution-paths-modal');
    const activeConstitutionBanner = document.getElementById('active-constitution-banner');
    const btnDisableConstitution = document.getElementById('btn-disable-constitution');
    const btnEditConstitution = document.getElementById('btn-edit-constitution');
    const btnSaveConstitution = document.getElementById('btn-save-constitution');
    const btnCancelConstitution = document.getElementById('btn-cancel-constitution');
    const constitutionListPane = document.getElementById('constitution-list-pane');
    const constitutionWorkspaceFilter = document.getElementById('constitution-workspace-filter');
    const constitutionPreviewPane = document.getElementById('constitution-preview-pane');
    const constitutionPreviewContent = document.getElementById('constitution-preview-content');
    const constitutionEditor = document.getElementById('constitution-editor');

    // System tab elements
    const btnBuildSystem = document.getElementById('btn-build-system');
    const btnCopySystemPrompt = document.getElementById('btn-copy-system-prompt');
    const btnEditSystem = document.getElementById('btn-edit-system');
    const btnSaveSystem = document.getElementById('btn-save-system');
    const btnCancelSystem = document.getElementById('btn-cancel-system');
    const btnDeleteSystem = document.getElementById('btn-delete-system');
    const systemListPane = document.getElementById('system-list-pane');
    const systemWorkspaceFilter = document.getElementById('system-workspace-filter');
    const systemPreviewPane = document.getElementById('system-preview-pane');
    const systemPreviewContent = document.getElementById('system-preview-content');
    const systemEditor = document.getElementById('system-editor');

    // Tuning tab elements
    const tuningWorkspaceFilter = document.getElementById('tuning-workspace-filter');
    const tuningInsightFilter = document.getElementById('tuning-insight-filter');
    const btnRunTuningExtract = document.getElementById('btn-run-tuning-extract');
    const btnRunTuningGovernance = document.getElementById('btn-run-tuning-governance');
    const btnRefreshInsights = document.getElementById('btn-refresh-insights');
    const tuningListPane = document.getElementById('tuning-list-pane');
    const tuningPreviewPane = document.getElementById('tuning-preview-pane');
    const tuningPreviewContent = document.getElementById('tuning-preview-content');
    const tuningEditor = document.getElementById('tuning-editor');

    // Projects tab elements (per-project PRDs)
    const projectsWorkspaceFilter = document.getElementById('projects-workspace-filter');
    const btnBuildPrd = document.getElementById('btn-build-prd-via-planner');
    const btnCopyPrdPrompt = document.getElementById('btn-copy-prd-prompt');
    const btnEditProjects = document.getElementById('btn-edit-projects');
    const btnSaveProjects = document.getElementById('btn-save-projects');
    const btnCancelProjects = document.getElementById('btn-cancel-projects');
    const btnProjectContext = document.getElementById('btn-project-context');
    const projectsPrdStatus = document.getElementById('projects-prd-status');
    const projectsPreviewContent = document.getElementById('projects-preview-content');
    const projectsEditor = document.getElementById('projects-editor');
    let projectContextEnabled = false;
    let _prdLoadedProject = null;   // project name whose PRD is currently in the editor
    let _prdDirty = false;          // user has typed since the last load → don't clobber

    // Dev Docs tab elements
    const devdocsWorkspaceFilter = document.getElementById('devdocs-workspace-filter');
    const devdocsListPane = document.getElementById('devdocs-list-pane');
    const devdocsPreviewContent = document.getElementById('devdocs-preview-content');
    const devdocsEditor = document.getElementById('devdocs-editor');
    const btnCreateDevdoc = document.getElementById('btn-create-devdoc');
    const btnEditDevdocs = document.getElementById('btn-edit-devdocs');
    const btnSaveDevdocs = document.getElementById('btn-save-devdocs');
    const btnCancelDevdocs = document.getElementById('btn-cancel-devdocs');
    const btnDeleteDevdocs = document.getElementById('btn-delete-devdocs');
    const devdocsStatus = document.getElementById('devdocs-status');
    let _devDocs = [];
    let _devDocSelected = null;
    let _devDocsWsFilter = '';
    let _pendingDevDocSelection = null;

    // NotebookLM tab state (workspace choice persisted host-side under 'notebook.root')
    let _notebookWorkspaceRoot = '';
    let _notebookHydrated = false;

    // Remote tab state (§10)
    let remoteControlActive = false;

    const kanbanFilters = { column: '', workspaceRoot: '', project: '', search: '', complexity: '' };
    const epicsFilters = { workspaceRoot: '', column: '' };
    const projectsFilters = { workspaceRoot: '' };

    // Initialize Webview Content
    vscode.postMessage({ type: 'fetchKanbanPlans', requestId: Date.now() });

    let _projectListChangedDebounce = null;

    // Webview message handler
    window.addEventListener('message', async event => {
        const msg = event.data;
        switch (msg.type) {
            case 'projectListChanged':
                if (_projectListChangedDebounce) {
                    clearTimeout(_projectListChangedDebounce);
                }
                _projectListChangedDebounce = setTimeout(() => {
                    vscode.postMessage({ type: 'fetchKanbanPlans', requestId: Date.now() });
                    _projectListChangedDebounce = null;
                }, 200);
                break;
            case 'switchboardThemeNameSetting':
            case 'switchboardThemeChanged':
                handleThemeChanged(msg.theme);
                break;
            case 'cyberAnimationSetting':
                document.body.classList.toggle('cyber-animation-disabled', msg.disabled);
                break;
            case 'planAutoFetchState': {
                const autoFetchEnabledCb = document.getElementById('kanban-auto-fetch-enabled');
                const autoFetchBranchLabel = document.getElementById('kanban-auto-fetch-branch');
                const autoFetchStatusText = document.getElementById('kanban-auto-fetch-status');
                
                if (autoFetchEnabledCb) {
                    autoFetchEnabledCb.checked = !!msg.enabled;
                }
                if (autoFetchBranchLabel) {
                    autoFetchBranchLabel.textContent = msg.resolvedBranch || 'default branch';
                }
                if (autoFetchStatusText) {
                    let text = msg.lastReason || '';
                    if (msg.lastTimestamp) {
                        const time = new Date(msg.lastTimestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
                        text += ` (at ${time})`;
                    }
                    autoFetchStatusText.textContent = text;
                    autoFetchStatusText.title = text;
                }
                const btnPlanAutoFetchNow = document.getElementById('btn-plan-auto-fetch-now');
                if (btnPlanAutoFetchNow && msg.lastReason !== 'Fetching now...') {
                    btnPlanAutoFetchNow.disabled = false;
                    btnPlanAutoFetchNow.textContent = 'Fetch now';
                }
                break;
            }
            case 'cyberScanlinesSetting':
                document.body.classList.toggle('cyber-scanlines-disabled', msg.disabled);
                break;
            case 'kanbanPlansReady':
                if (btnCreateKanbanPlan) {
                    btnCreateKanbanPlan.disabled = false;
                    btnCreateKanbanPlan.textContent = 'Create';
                }
                if (msg.error) {
                    console.error('Kanban fetch error:', msg.error);
                    _kanbanProjectsError = true;
                    if (activeTab === 'projects') {
                        renderProjectsList();
                    }
                    return;
                }
                _kanbanProjectsError = false;
                if (msg.workspaceRoot) {
                    _kanbanPlansCache = [
                        ..._kanbanPlansCache.filter(p => p.workspaceRoot !== msg.workspaceRoot),
                        ...(msg.plans || [])
                    ];
                } else {
                    _kanbanPlansCache = msg.plans || [];
                }
                // Proactive "plans changed" pushes (e.g. after a complexity edit / move) carry
                // only `plans` — they must NOT wipe the workspace/project/column lists, which a
                // bare `|| {}` would. Overwrite these only when the full payload includes them.
                if (msg.allWorkspaceProjects) {
                    const normalized = {};
                    for (const [k, v] of Object.entries(msg.allWorkspaceProjects)) {
                        normalized[normalizeRoot(k)] = v;
                    }
                    _kanbanAllWorkspaceProjects = normalized;
                }
                if (msg.workspaceItems) _kanbanWorkspaceItems = msg.workspaceItems;
                if (msg.columns) _kanbanAvailableColumns = msg.columns;
                if (msg.kanbanWorkspaceRoot && _kanbanWorkspaceItems.some(ws => ws.workspaceRoot === msg.kanbanWorkspaceRoot)) {
                    if (!kanbanFilters.workspaceRoot) {
                        kanbanFilters.workspaceRoot = msg.kanbanWorkspaceRoot;
                    }
                    if (!epicsFilters.workspaceRoot) {
                        epicsFilters.workspaceRoot = msg.kanbanWorkspaceRoot;
                    }
                }
                populateWorkspaceDropdowns();
                // Apply workspace filter intent from a Review Plan navigation.
                // MUST run before populateKanbanFilters() so the project dropdown is
                // built from the correct workspace.
                if (_pendingKanbanFilterIntent) {
                    const intent = _pendingKanbanFilterIntent;
                    if (intent.workspaceRoot && kanbanWorkspaceFilter) {
                        const opts = Array.from(kanbanWorkspaceFilter.options).map(o => o.value);
                        const intentNorm = normalizeRoot(intent.workspaceRoot);
                        if (opts.some(o => normalizeRoot(o) === intentNorm)) {
                            kanbanFilters.workspaceRoot = intent.workspaceRoot;
                            kanbanWorkspaceFilter.value = intent.workspaceRoot;
                        }
                    }
                    // Apply epics workspace filter intent (from epic Review Plan navigation).
                    if (intent.epicWorkspaceRoot && epicsWorkspaceFilter) {
                        const epicWs = intent.epicWorkspaceRoot;
                        const opts = Array.from(epicsWorkspaceFilter.options).map(o => o.value);
                        if (opts.includes(epicWs)) {
                            epicsFilters.workspaceRoot = epicWs;
                            epicsWorkspaceFilter.value = epicWs;
                        }
                        intent.epicWorkspaceRoot = null;  // consume
                    }
                }
                populateKanbanFilters();
                // Apply project/column filter intent from a Review Plan navigation.
                // Runs after populateKanbanFilters() so the project dropdown options are
                // built from the (possibly just-changed) workspace filter.
                if (_pendingKanbanFilterIntent) {
                    const intent = _pendingKanbanFilterIntent;
                    if (intent.project && kanbanProjectFilter) {
                        const opts = Array.from(kanbanProjectFilter.options).map(o => o.value);
                        if (opts.includes(intent.project)) {
                            kanbanFilters.project = intent.project;
                            kanbanProjectFilter.value = intent.project;
                        }
                    }
                    if (intent.column && kanbanColumnFilter) {
                        const opts = Array.from(kanbanColumnFilter.options).map(o => o.value);
                        if (opts.includes(intent.column)) {
                            kanbanFilters.column = intent.column;
                            kanbanColumnFilter.value = intent.column;
                        }
                    }
                    _pendingKanbanFilterIntent = null;  // consume the intent
                }
                renderKanbanPlans();
                renderEpicsList();
                // Keep the Projects-tab editor in sync when fresh project data arrives.
                if (activeTab === 'projects') {
                    renderProjectsList();
                    requestProjectContextEnabled();
                }
                tryResolvePendingKanbanSelection();
                tryResolvePendingEpicSelection();
                if (_epicSelectedPlan) renderEpicMetaBar(_epicSelectedPlan);
                break;
            case 'projectContextEnabled':
                // Host echo of the PROJECT CONTEXT toggle for the workspace this tab edits.
                projectContextEnabled = !!msg.enabled;
                updateProjectContextButton();
                break;
            case 'projectPrdContent': {
                // Ignore stale responses for a project the user has since switched away from.
                if (_selectedProjectName === msg.projectName) {
                    if (projectsPreviewContent) {
                        projectsPreviewContent.innerHTML = msg.content || '';  // HTML from markdown.api.render
                    }
                    if (projectsEditor) projectsEditor.value = msg.rawContent || '';  // raw markdown for editing
                    state.editOriginalContent.projects = msg.rawContent || '';
                    setProjectsPrdEditorEnabled(true);
                    if (projectsPrdStatus) projectsPrdStatus.textContent = msg.exists ? '' : 'New PRD — not yet saved';
                    _prdLoadedProject = msg.projectName;
                    _prdDirty = false;
                    state.dirtyFlags.projects = false;
                    // Show "not written yet" onboarding when no PRD exists.
                    if (!msg.exists && projectsPreviewContent) {
                        projectsPreviewContent.innerHTML = `
                            <div class="constitution-onboarding">
                                <p class="constitution-onboarding-title">No PRD found for this project.</p>
                                <p>A PRD (Product Requirements Document) is a loose set of product requirements respected across all plans in a project — independent of epics. When <strong>PROJECT CONTEXT</strong> is on, this PRD is injected into <em>every</em> dispatched prompt.</p>
                                <p>Use <strong>Build via Planner</strong> above to generate one, or <strong>Edit</strong> to write it yourself.</p>
                            </div>
                        `;
                    }
                    // Enable Edit button only when a project is selected.
                    if (btnEditProjects) btnEditProjects.disabled = false;
                }
                break;
            }
            case 'projectPrdSaved':
                if (projectsPrdStatus) projectsPrdStatus.textContent = msg.ok ? 'Saved ✓' : 'Save failed';
                if (msg.ok) {
                    _prdDirty = false;
                    exitEditMode('projects');
                    // Re-fetch the PRD so the preview pane updates with rendered HTML.
                    requestProjectPrd();
                }
                break;
            case 'planCreated':
                if (btnCreateKanbanPlan) {
                    btnCreateKanbanPlan.disabled = false;
                    btnCreateKanbanPlan.textContent = 'Create';
                }
                break;
            case 'kanbanPlanPreviewReady':
                if (kanbanPreviewContent && _kanbanSelectedPlan && _kanbanSelectedPlan.planFile === msg.filePath) {
                    if (state.editMode.kanban) {
                        state.externalChangePending.kanban = true;
                    } else {
                        kanbanPreviewContent.innerHTML = msg.content || '';
                        state.editOriginalContent.kanban = msg.rawContent || '';
                        const dynamicEditBtn = document.getElementById('btn-edit-kanban');
                        if (dynamicEditBtn) dynamicEditBtn.disabled = false;
                        if (_pendingAutoEdit) {
                            _pendingAutoEdit = false;
                            enterEditMode('kanban');
                        }
                    }
                }
                if (epicsPreviewContent && _epicPreviewFilePath && _epicPreviewFilePath === msg.filePath) {
                    if (state.editMode.epics) {
                        state.externalChangePending.epics = true;
                    } else if (!msg.error) {
                        epicsPreviewContent.innerHTML = msg.content || '';
                        state.editOriginalContent.epics = msg.rawContent || '';
                        const dynamicEditEpicsBtn = document.getElementById('btn-edit-epics');
                        if (dynamicEditEpicsBtn) dynamicEditEpicsBtn.disabled = false;
                    }
                }
                break;
            case 'activateKanbanTabAndSelectPlan': {
                if (msg.isEpic === true) {
                    _pendingEpicSelection = {
                        planId: msg.planId || '',
                        sessionId: msg.sessionId || '',
                        planFile: msg.planFile || '',
                        workspaceRoot: msg.workspaceRoot || ''
                    };
                    // Clear epics filters to widest now; the epicsPlansReady / kanbanPlansReady
                    // handler will narrow them if the intent workspace is in the dropdown.
                    epicsFilters.workspaceRoot = '';
                    epicsFilters.column = '';
                    if (epicsWorkspaceFilter) epicsWorkspaceFilter.value = '';
                    if (epicsColumnFilter) epicsColumnFilter.value = '';
                    // Stash intent for epics (reuse the same mechanism)
                    _pendingKanbanFilterIntent = _pendingKanbanFilterIntent || {};
                    _pendingKanbanFilterIntent.epicWorkspaceRoot = msg.workspaceRoot || '';
                    const epicsTabBtn = document.querySelector('.shared-tab-btn[data-tab="epics"]');
                    if (epicsTabBtn) epicsTabBtn.click();
                    tryResolvePendingEpicSelection();
                    break;
                }
                _pendingKanbanSelection = {
                    planId: msg.planId || '',
                    sessionId: msg.sessionId || '',
                    planFile: msg.planFile || '',
                    workspaceRoot: msg.workspaceRoot || ''
                };
                _pendingAutoEdit = msg.autoEdit === true;
                _pendingKanbanSelectionRetries = 0;  // reset retry counter for this selection

                // Stash the desired narrow filters.
                _pendingKanbanFilterIntent = {
                    workspaceRoot: msg.workspaceRoot || '',
                    project: msg.project || '',
                    column: msg.column || ''
                };

                // Clear filters to widest NOW.
                kanbanFilters.workspaceRoot = '';
                if (kanbanWorkspaceFilter) kanbanWorkspaceFilter.value = '';
                kanbanFilters.project = '';
                if (kanbanProjectFilter) kanbanProjectFilter.value = '';
                kanbanFilters.column = '';
                if (kanbanColumnFilter) kanbanColumnFilter.value = '';
                kanbanFilters.complexity = '';
                if (kanbanComplexityFilter) kanbanComplexityFilter.value = '';

                // Activate the Kanban tab — its click handler fires fetchKanbanPlans.
                const kanbanTabBtn = document.querySelector('.shared-tab-btn[data-tab="kanban"]');
                if (kanbanTabBtn) kanbanTabBtn.click();
                // Resolve immediately if the plan is already in the cache.
                tryResolvePendingKanbanSelection();
                break;
            }
            case 'epicDetails':
                renderEpicSubtasks(msg.epic, msg.subtasks);
                break;
            case 'epicError':
                showToast(msg.message || 'Error occurred', 'error');
                break;
            case 'kanbanPlanColumnChanged':
                if (msg.success) {
                    vscode.postMessage({ type: 'fetchKanbanPlans', requestId: Date.now() });
                } else {
                    showToast('Failed to move column: ' + (msg.error || 'Unknown error'), 'error');
                }
                break;
            case 'kanbanPlanDeleted':
                if (msg.success) {
                    _kanbanSelectedPlan = null;
                    if (kanbanPreviewContent) kanbanPreviewContent.innerHTML = '<div class="kanban-empty-state">Select a plan to preview</div>';
                    const dynamicEditBtn = document.getElementById('btn-edit-kanban');
                    if (dynamicEditBtn) dynamicEditBtn.disabled = true;
                    vscode.postMessage({ type: 'fetchKanbanPlans', requestId: Date.now() });
                } else {
                    showToast('Delete failed: ' + (msg.error || 'Unknown error'), 'error');
                }
                break;
            case 'kanbanPlanLogReady':
                showKanbanLogOverlay(msg.entries || []);
                break;
            case 'governanceFileChanged':
                if (_constitutionSelectedWorkspace && _constitutionSelectedWorkspace.workspaceRoot === msg.workspaceRoot && msg.governanceFile === _constitutionSelectedGovKey && !state.editMode.constitution) {
                    vscode.postMessage({
                        type: 'readConstitutionFile',
                        workspaceRoot: _constitutionSelectedWorkspace.workspaceRoot,
                        governanceFile: _constitutionSelectedGovKey
                    });
                }
                if (_systemSelectedWorkspace && _systemSelectedWorkspace.workspaceRoot === msg.workspaceRoot && msg.governanceFile === _systemSelectedGovKey && !state.editMode.system) {
                    vscode.postMessage({
                        type: 'readConstitutionFile',
                        workspaceRoot: _systemSelectedWorkspace.workspaceRoot,
                        governanceFile: _systemSelectedGovKey
                    });
                }
                break;
            case 'constitutionFilesLoaded':
                _constitutionWorkspaces = msg.workspaces || [];
                if (msg.kanbanWorkspaceRoot && _constitutionWorkspaces.some(ws => ws.workspaceRoot === msg.kanbanWorkspaceRoot)) {
                    if (!_constitutionWsFilter) {
                        _constitutionWsFilter = msg.kanbanWorkspaceRoot;
                    }
                    if (!_systemWsFilter) {
                        _systemWsFilter = msg.kanbanWorkspaceRoot;
                    }
                }
                // The dropdowns are pure workspace filters (default "All Workspaces"); the
                // sidebar lists the actual docs. Populate the filters, then render the lists,
                // which auto-select the first doc when nothing is selected yet.
                populateGovernanceFilters();
                renderConstitutionDocList();
                renderSystemDocList();
                break;
            case 'constitutionPaths':
                renderConstitutionPathsModal(msg);
                break;
            case 'constitutionStatus':
                if (_constitutionSelectedWorkspace && _constitutionSelectedWorkspace.workspaceRoot === msg.workspaceRoot) {
                    const isEnabled = !!msg.enabled;
                    // File existence must be derived from the per-workspace read (set just
                    // before this response is requested), NOT from `status`: when the addon
                    // is globally OFF the backend reports 'Disabled' regardless of whether a
                    // file exists, which would otherwise disable the Enable button exactly
                    // when the user needs to click it.
                    const hasFile = _constitutionSelectedFile !== null;
                    if (btnEnableConstitution) {
                        btnEnableConstitution.disabled = !hasFile;
                        btnEnableConstitution.textContent = isEnabled ? 'Disable Reference' : 'Enable as Planning Reference';
                        btnEnableConstitution.dataset.enabled = isEnabled ? 'true' : 'false';
                    }
                    if (activeConstitutionBanner) {
                        if (isEnabled) {
                            activeConstitutionBanner.classList.remove('inactive');
                        } else {
                            activeConstitutionBanner.classList.add('inactive');
                        }
                    }
                }
                break;
            case 'constitutionAddonState': {
                const isEnabled = !!msg.enabled;
                if (btnEnableConstitution) {
                    btnEnableConstitution.textContent = isEnabled ? 'Disable Reference' : 'Enable as Planning Reference';
                    btnEnableConstitution.dataset.enabled = isEnabled ? 'true' : 'false';
                }
                if (activeConstitutionBanner) {
                    if (isEnabled) {
                        activeConstitutionBanner.classList.remove('inactive');
                    } else {
                        activeConstitutionBanner.classList.add('inactive');
                    }
                }
                break;
            }
            case 'chatPromptCopied': {
                if (btnChatCopyPrompt) {
                    const oldText = btnChatCopyPrompt.textContent;
                    btnChatCopyPrompt.textContent = 'Copied!';
                    btnChatCopyPrompt.disabled = true;
                    setTimeout(() => {
                        btnChatCopyPrompt.textContent = oldText;
                        btnChatCopyPrompt.disabled = false;
                    }, 2000);
                }
                break;
            }
            case 'kanbanPlanPromptCopied': {
                const btn = msg.sessionId
                    ? document.querySelector(`.kanban-plan-copy-prompt[data-session-id="${msg.sessionId}"]`)
                    : null;
                if (btn) {
                    const oldText = btn.textContent;
                    btn.textContent = msg.success ? 'Copied!' : 'Failed';
                    btn.disabled = true;
                    setTimeout(() => {
                        btn.textContent = oldText;
                        btn.disabled = false;
                    }, 2000);
                }
                // Refresh the kanban plans list so the card reflects any column advance
                // the backend performed after copying the prompt. Without this, the card
                // stays in its old column/status in the UI. Fire on both success AND
                // failure — on failure the DB state is unchanged, but the UI must still
                // be consistent with the DB (no stale "advanced" state from a prior
                // action). The fetchKanbanPlans handler in PlanningPanelProvider has a
                // request-ID dedup guard so duplicate requests are safe.
                if (activeTab === 'kanban') {
                    vscode.postMessage({ type: 'fetchKanbanPlans', requestId: Date.now() });
                }
                break;
            }
            case 'constitutionPromptCopied': {
                const isUpdate = _constitutionSelectedFile !== null;
                const copyBtn = isUpdate ? btnCopyUpdatePrompt : btnCopyBuildPrompt;
                if (copyBtn) {
                    const oldText = copyBtn.textContent;
                    copyBtn.textContent = 'Copied!';
                    copyBtn.disabled = true;
                    setTimeout(() => {
                        copyBtn.textContent = oldText;
                        copyBtn.disabled = false;
                    }, 2000);
                }
                break;
            }
            case 'systemPromptCopied': {
                if (btnCopySystemPrompt) {
                    const oldText = btnCopySystemPrompt.textContent;
                    btnCopySystemPrompt.textContent = 'Copied!';
                    btnCopySystemPrompt.disabled = true;
                    setTimeout(() => {
                        btnCopySystemPrompt.textContent = oldText;
                        btnCopySystemPrompt.disabled = false;
                    }, 2000);
                }
                break;
            }
            case 'prdPromptCopied': {
                if (btnCopyPrdPrompt) {
                    const oldText = btnCopyPrdPrompt.textContent;
                    btnCopyPrdPrompt.textContent = 'Copied!';
                    btnCopyPrdPrompt.disabled = true;
                    setTimeout(() => {
                        btnCopyPrdPrompt.textContent = oldText;
                        btnCopyPrdPrompt.disabled = false;
                    }, 2000);
                }
                break;
            }
            case 'constitutionFileDeleted': {
                const govFile = msg.governanceFile || 'constitution';
                if (govFile === 'constitution') {
                    if (constitutionPreviewContent && _constitutionSelectedWorkspace && _constitutionSelectedWorkspace.workspaceRoot === msg.workspaceRoot) {
                        constitutionPreviewContent.innerHTML = `
                            <div class="constitution-onboarding">
                                <p class="constitution-onboarding-title">No constitution found for this workspace.</p>
                                <p>A project constitution is a concise document that defines the soul of your project: its goals, the people it serves, its key features, guiding principles, and how the team communicates. It is not a technical spec — it is the context that tells an AI planning assistant <em>why</em> the project exists and <em>who</em> it is for.</p>
                                <p>Once created, you can enable it as a Planning Reference so it is automatically included in every planning prompt alongside your task descriptions.</p>
                                <p>Use <strong>Build via Planner</strong> above to generate one for this workspace.</p>
                            </div>
                        `;
                        state.editOriginalContent.constitution = '';
                        _constitutionSelectedFile = null;
                        if (btnEditConstitution) btnEditConstitution.disabled = true;
                        if (btnBuildViaPlanner) {
                            btnBuildViaPlanner.style.display = '';
                            btnBuildViaPlanner.disabled = false;
                        }
                        if (btnCopyBuildPrompt) {
                            btnCopyBuildPrompt.style.display = '';
                            btnCopyBuildPrompt.disabled = false;
                        }
                        if (btnUpdateViaPlanner) btnUpdateViaPlanner.style.display = 'none';
                        if (btnCopyUpdatePrompt) btnCopyUpdatePrompt.style.display = 'none';
                        if (btnDeleteConstitution) btnDeleteConstitution.style.display = 'none';
                        if (btnEnableConstitution) {
                            btnEnableConstitution.disabled = true;
                            btnEnableConstitution.textContent = 'Enable as Planning Reference';
                            btnEnableConstitution.dataset.enabled = 'false';
                        }
                        if (activeConstitutionBanner) {
                            activeConstitutionBanner.classList.add('inactive');
                        }
                    }
                } else {
                    if (systemPreviewContent && _systemSelectedWorkspace && _systemSelectedWorkspace.workspaceRoot === msg.workspaceRoot) {
                        const filename = govFile === 'claude' ? 'CLAUDE.md' : 'AGENTS.md';
                        systemPreviewContent.innerHTML = `
                            <div class="constitution-onboarding">
                                <p class="constitution-onboarding-title">No ${filename} found for this workspace.</p>
                                <p>Use <strong>Build via Planner</strong> above to generate one for this workspace, or <strong>Copy Build Prompt</strong> to run it yourself.</p>
                            </div>
                        `;
                        state.editOriginalContent.system = '';
                        _systemSelectedFile = null;
                        if (btnEditSystem) btnEditSystem.disabled = false;
                        if (btnDeleteSystem) btnDeleteSystem.style.display = 'none';
                        if (btnBuildSystem) { btnBuildSystem.style.display = ''; btnBuildSystem.disabled = false; }
                        if (btnCopySystemPrompt) { btnCopySystemPrompt.style.display = ''; btnCopySystemPrompt.disabled = false; }
                    }
                }
                break;
            }
            case 'constitutionFileRead': {
                const govFile = msg.governanceFile ?? 'constitution';
                if (govFile === 'constitution') {
                    if (constitutionPreviewContent && _constitutionSelectedWorkspace && _constitutionSelectedWorkspace.workspaceRoot === msg.workspaceRoot) {
                        if (_constitutionSelectedGovKey !== 'constitution') {
                            break;
                        }
                        if (state.editMode.constitution) {
                            state.externalChangePending.constitution = true;
                        } else {
                            vscode.postMessage({ type: 'getConstitutionStatus', workspaceRoot: _constitutionSelectedWorkspace.workspaceRoot });
                            if (msg.exists) {
                                constitutionPreviewContent.innerHTML = msg.renderedHtml || '';
                                state.editOriginalContent.constitution = msg.content || '';
                                _constitutionSelectedFile = msg.filePath;
                                if (btnEditConstitution) btnEditConstitution.disabled = false;
                                if (btnBuildViaPlanner) btnBuildViaPlanner.style.display = 'none';
                                if (btnCopyBuildPrompt) btnCopyBuildPrompt.style.display = 'none';
                                if (btnUpdateViaPlanner) {
                                    btnUpdateViaPlanner.style.display = '';
                                    btnUpdateViaPlanner.disabled = false;
                                }
                                if (btnCopyUpdatePrompt) {
                                    btnCopyUpdatePrompt.style.display = '';
                                    btnCopyUpdatePrompt.disabled = false;
                                }
                                if (btnDeleteConstitution) btnDeleteConstitution.style.display = '';
                                if (btnManageConstitutionPaths) btnManageConstitutionPaths.disabled = false;
                            } else {
                                constitutionPreviewContent.innerHTML = `
                                    <div class="constitution-onboarding">
                                        <p class="constitution-onboarding-title">No constitution found for this workspace.</p>
                                        <p>A project constitution is a concise document that defines the soul of your project: its goals, the people it serves, its key features, guiding principles, and how the team communicates. It is not a technical spec — it is the context that tells an AI planning assistant <em>why</em> the project exists and <em>who</em> it is for.</p>
                                        <p>Once created, you can enable it as a Planning Reference so it is automatically included in every planning prompt alongside your task descriptions.</p>
                                        <p>Use <strong>Build via Planner</strong> above to generate one for this workspace.</p>
                                    </div>
                                `;
                                state.editOriginalContent.constitution = '';
                                _constitutionSelectedFile = null;
                                if (btnEditConstitution) btnEditConstitution.disabled = true;
                                if (btnBuildViaPlanner) {
                                    btnBuildViaPlanner.style.display = '';
                                    btnBuildViaPlanner.disabled = false;
                                }
                                if (btnCopyBuildPrompt) {
                                    btnCopyBuildPrompt.style.display = '';
                                    btnCopyBuildPrompt.disabled = false;
                                }
                                if (btnUpdateViaPlanner) btnUpdateViaPlanner.style.display = 'none';
                                if (btnCopyUpdatePrompt) btnCopyUpdatePrompt.style.display = 'none';
                                if (btnDeleteConstitution) btnDeleteConstitution.style.display = 'none';
                                if (btnManageConstitutionPaths) btnManageConstitutionPaths.disabled = true;
                            }
                        }
                    }
                } else {
                    if (systemPreviewContent && _systemSelectedWorkspace && _systemSelectedWorkspace.workspaceRoot === msg.workspaceRoot) {
                        if (govFile !== _systemSelectedGovKey) {
                            break;
                        }
                        if (state.editMode.system) {
                            state.externalChangePending.system = true;
                        } else {
                            if (msg.exists) {
                                systemPreviewContent.innerHTML = msg.renderedHtml || '';
                                state.editOriginalContent.system = msg.content || '';
                                _systemSelectedFile = msg.filePath;
                                if (btnEditSystem) btnEditSystem.disabled = false;
                                if (btnDeleteSystem) btnDeleteSystem.style.display = '';
                                if (btnBuildSystem) btnBuildSystem.style.display = 'none';
                                if (btnCopySystemPrompt) btnCopySystemPrompt.style.display = 'none';
                            } else {
                                const filename = _systemSelectedGovKey === 'claude' ? 'CLAUDE.md' : 'AGENTS.md';
                                systemPreviewContent.innerHTML = `
                                    <div class="constitution-onboarding">
                                        <p class="constitution-onboarding-title">No ${filename} found for this workspace.</p>
                                        <p>Use <strong>Build via Planner</strong> above to generate one for this workspace, or <strong>Copy Build Prompt</strong> to run it yourself.</p>
                                    </div>
                                `;
                                state.editOriginalContent.system = '';
                                _systemSelectedFile = null;
                                if (btnEditSystem) btnEditSystem.disabled = false;
                                if (btnDeleteSystem) btnDeleteSystem.style.display = 'none';
                                if (btnBuildSystem) { btnBuildSystem.style.display = ''; btnBuildSystem.disabled = false; }
                                if (btnCopySystemPrompt) { btnCopySystemPrompt.style.display = ''; btnCopySystemPrompt.disabled = false; }
                            }
                        }
                    }
                }
            }
            break;
            case 'uploadPlanAttachmentResult': {
                uploadingPlanAttachment = false;
                if (_kanbanSelectedPlan && _kanbanSelectedPlan.planFile === msg.planFile) {
                    renderKanbanMetaBar(_kanbanSelectedPlan);
                }
                if (msg.success) {
                    showToast(`Plan uploaded to ${msg.provider} ticket.\n${msg.url || ''}`, 'success');
                } else {
                    showToast(`Upload failed: ${msg.error}`, 'error');
                }
                break;
            }
            case 'fileSaved':
            case 'saveFileContentResult':
                if (msg.success) {
                    if (msg.tab === 'kanban') {
                        exitEditMode('kanban');
                        if (msg.renamedFilePath && _kanbanSelectedPlan) {
                            _kanbanSelectedPlan.planFile = msg.renamedFilePath;
                        }
                        if (_kanbanSelectedPlan) loadKanbanPlanPreview(_kanbanSelectedPlan);
                        vscode.postMessage({ type: 'fetchKanbanPlans', requestId: Date.now() });
                    } else if (msg.tab === 'constitution') {
                        if (msg.governanceFile === 'claude' || msg.governanceFile === 'agents') {
                            exitEditMode('system');
                            if (_systemSelectedWorkspace) selectSystemDoc(_systemSelectedWorkspace, _systemSelectedGovKey);
                        } else {
                            exitEditMode('constitution');
                            if (_constitutionSelectedWorkspace) selectConstitutionDoc(_constitutionSelectedWorkspace);
                        }
                    } else if (msg.tab === 'epics') {
                        exitEditMode('epics');
                        if (msg.renamedFilePath && _epicSelectedPlan) {
                            _epicSelectedPlan.planFile = msg.renamedFilePath;
                        }
                        if (_epicSubtaskPreview) {
                            if (msg.renamedFilePath) {
                                _epicPreviewFilePath = msg.renamedFilePath;
                                _epicSubtaskPreview.planFile = msg.renamedFilePath;
                            }
                            if (epicsPreviewContent) epicsPreviewContent.innerHTML = '<div class="kanban-empty-state">Loading preview...</div>';
                            vscode.postMessage({
                                type: 'fetchKanbanPlanPreview',
                                filePath: _epicPreviewFilePath,
                                requestId: ++_kanbanPreviewRequestId
                            });
                            renderEpicSubtaskMetaBar(_epicSubtaskPreview);
                        } else {
                            if (_epicSelectedPlan) selectEpic(_epicSelectedPlan);
                        }
                        vscode.postMessage({ type: 'fetchKanbanPlans', requestId: Date.now() });
                        vscode.postMessage({ type: 'fetchEpicDocuments' });
                    }
                } else {
                    showToast('Save failed: ' + (msg.error || 'Unknown error'), 'error');
                }
                break;
            case 'insightsLoaded': {
                _tuningInsights = msg.insights || [];
                renderInsightList(_tuningInsights);
                break;
            }
            case 'insightContent': {
                if (!tuningPreviewContent) break;
                if (!msg.content) {
                    tuningPreviewContent.innerHTML = '<div class="empty-state">Select an insight to preview</div>';
                    _tuningSelectedInsight = null;
                    _tuningSelectedWorkspaceRoot = '';
                    break;
                }
                tuningPreviewContent.innerHTML = msg.renderedHtml || escapeHtml(msg.content);
                _tuningSelectedInsight = msg.filename;
                _tuningSelectedWorkspaceRoot = msg.workspaceRoot || '';
                const actionsDiv = document.createElement('div');
                actionsDiv.style.cssText = 'padding: 12px 0; display: flex; gap: 8px; border-top: 1px solid var(--border-color); margin-top: 16px;';
                actionsDiv.innerHTML = `
                    <button class="strip-btn" id="btn-insight-copy-link">Copy Link</button>
                    <button class="strip-btn" id="btn-insight-mark-applied">Mark Applied</button>
                    <button class="strip-btn" id="btn-insight-dismiss">Dismiss</button>
                    <button class="strip-btn" id="btn-insight-delete" style="color: #ff6b6b;">Delete</button>
                `;
                tuningPreviewContent.appendChild(actionsDiv);
                const btnCopyLink = document.getElementById('btn-insight-copy-link');
                const btnMarkApplied = document.getElementById('btn-insight-mark-applied');
                const btnDismiss = document.getElementById('btn-insight-dismiss');
                const btnDeleteInsight = document.getElementById('btn-insight-delete');
                if (btnCopyLink) btnCopyLink.addEventListener('click', () => {
                    const link = `${_tuningSelectedWorkspaceRoot}/.switchboard/insights/${_tuningSelectedInsight}`;
                    vscode.postMessage({ type: 'copyInsightLink', link });
                });
                if (btnMarkApplied) btnMarkApplied.addEventListener('click', () => {
                    vscode.postMessage({ type: 'updateInsightStatus', filename: _tuningSelectedInsight, status: 'applied', workspaceRoot: _tuningSelectedWorkspaceRoot });
                });
                if (btnDismiss) btnDismiss.addEventListener('click', () => {
                    vscode.postMessage({ type: 'updateInsightStatus', filename: _tuningSelectedInsight, status: 'dismissed', workspaceRoot: _tuningSelectedWorkspaceRoot });
                });
                if (btnDeleteInsight) btnDeleteInsight.addEventListener('click', () => {
                    vscode.postMessage({ type: 'deleteInsight', filename: _tuningSelectedInsight, workspaceRoot: _tuningSelectedWorkspaceRoot });
                });
                break;
            }
            case 'tuningExtractComplete': {
                if (tuningPreviewContent) {
                    tuningPreviewContent.innerHTML = `<div class="empty-state">Extract prompt copied to clipboard. Paste it into your agent chat to run the tuning skill.\n\nPlans scanned: ${msg.planCount || 0}</div>`;
                }
                vscode.postMessage({ type: 'loadInsights', workspaceRoot: tuningWorkspaceFilter ? tuningWorkspaceFilter.value : '' });
                break;
            }
            case 'tuningGovernanceComplete': {
                if (tuningPreviewContent) {
                    tuningPreviewContent.innerHTML = `<div class="empty-state">Governance prompt copied to clipboard. Paste it into your agent chat to propose governance updates.</div>`;
                }
                break;
            }
            case 'insightLinkCopied': {
                const copyLinkBtn = document.getElementById('btn-insight-copy-link');
                if (copyLinkBtn) {
                    const oldText = copyLinkBtn.textContent;
                    copyLinkBtn.textContent = 'Copied!';
                    setTimeout(() => { copyLinkBtn.textContent = oldText; }, 2000);
                }
                break;
            }
            // ── Dev Docs tab ──────────────────────────────────────────────
            case 'devDocsList':
                _devDocs = msg.docs || [];
                renderDevDocsList();
                if (_pendingDevDocSelection) {
                    const target = _devDocs.find(d => d.path === _pendingDevDocSelection);
                    _pendingDevDocSelection = null;
                    if (target) selectDevDoc(target);
                }
                break;
            case 'devDocContent':
                if (_devDocSelected && _devDocSelected.path === msg.path) {
                    if (state.editMode.devdocs) {
                        state.externalChangePending.devdocs = true;
                    } else {
                        if (devdocsPreviewContent) devdocsPreviewContent.innerHTML = msg.renderedHtml || '';
                        state.editOriginalContent.devdocs = msg.content || '';
                        if (btnEditDevdocs) btnEditDevdocs.disabled = false;
                        if (btnDeleteDevdocs) btnDeleteDevdocs.style.display = '';
                    }
                }
                break;
            case 'devDocSaved':
                if (devdocsStatus) devdocsStatus.textContent = msg.ok ? 'Saved ✓' : ('Save failed' + (msg.error ? ': ' + msg.error : ''));
                if (msg.ok) {
                    exitEditMode('devdocs');
                    if (_devDocSelected) selectDevDoc(_devDocSelected);
                    setTimeout(() => { if (devdocsStatus && devdocsStatus.textContent === 'Saved ✓') devdocsStatus.textContent = ''; }, 2000);
                }
                break;
            case 'devDocCreated':
                if (msg.ok) {
                    _pendingDevDocSelection = msg.path || null;
                    vscode.postMessage({ type: 'loadDevDocs' });
                } else {
                    showToast('Create failed: ' + (msg.error || 'unknown error'), 'error');
                }
                break;
            case 'devDocDeleted':
                if (msg.ok) {
                    if (_devDocSelected && _devDocSelected.path === msg.path) {
                        _devDocSelected = null;
                        if (devdocsPreviewContent) devdocsPreviewContent.innerHTML = '<div class="empty-state">Select a dev doc to view it</div>';
                        if (btnEditDevdocs) btnEditDevdocs.disabled = true;
                        if (btnDeleteDevdocs) btnDeleteDevdocs.style.display = 'none';
                    }
                    vscode.postMessage({ type: 'loadDevDocs' });
                } else {
                    showToast('Delete failed: ' + (msg.error || 'unknown error'), 'error');
                }
                break;
            // ── Remote tab (§10, relocated from kanban.html) ──────────────
            case 'remoteConfig':
                if (typeof msg.active === 'boolean') { remoteControlActive = msg.active; applyRemoteControlButtonState(); }
                renderRemoteConfig(msg.config, msg);
                break;
            case 'remoteControlState':
                remoteControlActive = !!msg.active;
                applyRemoteControlButtonState();
                break;
            case 'notionRemoteSetupResult': {
                const statusEl = document.getElementById('remote-notion-setup-status');
                if (statusEl) {
                    statusEl.textContent = msg.success
                        ? `Setup complete — ${msg.backedUp || 0} card(s) backed up. Connect Notion to claude.ai and drive it from there.`
                        : `Setup failed: ${msg.error || 'unknown error'}`;
                }
                break;
            }
            case 'linearAgentSkillText':
                if (msg.text) {
                    navigator.clipboard.writeText(msg.text).then(() => {
                        const btn = document.getElementById('btn-copy-linear-agent-skill');
                        const status = document.getElementById('copy-linear-agent-skill-status');
                        if (btn) { btn.textContent = 'Copied!'; }
                        if (status) { status.textContent = ''; }
                        setTimeout(() => { if (btn) { btn.textContent = 'Copy Linear Agent Skill'; } }, 2000);
                    }).catch(err => {
                        console.error('Failed to copy Linear agent skill:', err);
                        const status = document.getElementById('copy-linear-agent-skill-status');
                        if (status) { status.textContent = 'Copy failed — check console'; }
                    });
                } else if (msg.error) {
                    const status = document.getElementById('copy-linear-agent-skill-status');
                    if (status) { status.textContent = msg.error; }
                }
                break;
            case 'projectContextSyncRunning': {
                const statusEl = document.getElementById('remote-context-status');
                if (statusEl) statusEl.textContent = 'Syncing…';
                break;
            }
            case 'projectContextSyncStatus': {
                const auto = document.getElementById('remote-context-auto');
                const statusEl = document.getElementById('remote-context-status');
                const lastEl = document.getElementById('remote-context-last-result');
                if (!msg.state) {
                    if (statusEl) statusEl.textContent = msg.error || '';
                    break;
                }
                if (auto) auto.checked = msg.state.enabled === true;
                if (statusEl) {
                    statusEl.textContent = msg.state.lastSyncAt
                        ? `Last sync: ${new Date(msg.state.lastSyncAt).toLocaleString()}`
                        : 'Never synced';
                }
                if (lastEl) lastEl.textContent = msg.state.lastResult || '';
                break;
            }
            // ── NotebookLM tab (relocated from planning.html) ─────────────
            case 'airlock_exportComplete': {
                const statusEl = document.getElementById('webai-status');
                if (statusEl) statusEl.textContent = msg.message || (msg.success ? 'Bundle complete.' : 'Bundle failed.');
                const bundleBtn = document.getElementById('btn-bundle-code');
                if (bundleBtn) { bundleBtn.disabled = false; bundleBtn.textContent = 'BUNDLE CODE'; }
                break;
            }
            case 'importNotebookLMPlansResult': {
                // Payload: { overwritten, created, errors } — all counts.
                const statusEl = document.getElementById('webai-status');
                if (statusEl) {
                    statusEl.textContent = `Imported: ${msg.overwritten || 0} overwritten, ${msg.created || 0} created` +
                        (msg.errors ? `, ${msg.errors} error(s)` : '');
                }
                const importBtn = document.getElementById('btn-import-notebooklm-plans');
                if (importBtn) { importBtn.disabled = false; importBtn.textContent = 'IMPORT PLANS'; }
                break;
            }
            case 'notebookDefaultRoot': {
                const sel = document.getElementById('notebook-workspace-filter');
                if (msg.root) {
                    _notebookWorkspaceRoot = msg.root;
                    if (sel && Array.from(sel.options).some(o => o.value === msg.root)) {
                        sel.value = msg.root;
                    }
                }
                break;
            }
        }
    });

    // Ready-handshake: signal the extension host that the message listener is
    // registered. The host queues outbound messages until this arrives so that
    // cold-open messages (e.g. activateKanbanTabAndSelectPlan from a kanban
    // Review click) are not dropped by the browser before the listener exists.
    vscode.postMessage({ type: 'webviewReady' });

    // Shared Tab/Workspace Population
    function populateWorkspaceDropdowns() {
        if (!kanbanWorkspaceFilter || !epicsWorkspaceFilter) return;

        const currentWS = kanbanFilters.workspaceRoot;
        kanbanWorkspaceFilter.innerHTML = '<option value="">All Workspaces</option>';
        epicsWorkspaceFilter.innerHTML = '<option value="">All Workspaces</option>';
        if (tuningWorkspaceFilter) tuningWorkspaceFilter.innerHTML = '<option value="">All Workspaces</option>';
        // The Projects tab is workspace-specific (a PRD/toggle belongs to one workspace),
        // so its filter lists concrete workspaces only — no "All Workspaces" option.
        if (projectsWorkspaceFilter) projectsWorkspaceFilter.innerHTML = '';
        // NotebookLM bundles one workspace at a time — concrete workspaces only.
        const notebookWorkspaceFilter = document.getElementById('notebook-workspace-filter');
        const notebookPrev = notebookWorkspaceFilter ? notebookWorkspaceFilter.value : '';
        if (notebookWorkspaceFilter) notebookWorkspaceFilter.innerHTML = '';
        const newDevdocWorkspace = document.getElementById('new-devdoc-workspace');
        const newDevdocPrev = newDevdocWorkspace ? newDevdocWorkspace.value : '';
        if (newDevdocWorkspace) newDevdocWorkspace.innerHTML = '';

        _kanbanWorkspaceItems.forEach(ws => {
            const opt = document.createElement('option');
            opt.value = ws.workspaceRoot;
            opt.textContent = ws.label;
            kanbanWorkspaceFilter.appendChild(opt.cloneNode(true));
            epicsWorkspaceFilter.appendChild(opt.cloneNode(true));
            if (tuningWorkspaceFilter) tuningWorkspaceFilter.appendChild(opt.cloneNode(true));
            if (projectsWorkspaceFilter) projectsWorkspaceFilter.appendChild(opt.cloneNode(true));
            if (notebookWorkspaceFilter) notebookWorkspaceFilter.appendChild(opt.cloneNode(true));
            if (newDevdocWorkspace) newDevdocWorkspace.appendChild(opt.cloneNode(true));
        });
        if (notebookWorkspaceFilter) {
            const desired = _notebookWorkspaceRoot || notebookPrev
                || currentWS || (_kanbanWorkspaceItems[0] && _kanbanWorkspaceItems[0].workspaceRoot) || '';
            notebookWorkspaceFilter.value = desired;
            if (notebookWorkspaceFilter.value) _notebookWorkspaceRoot = notebookWorkspaceFilter.value;
        }
        if (newDevdocWorkspace && newDevdocPrev) newDevdocWorkspace.value = newDevdocPrev;
        kanbanWorkspaceFilter.value = currentWS;
        epicsWorkspaceFilter.value = epicsFilters.workspaceRoot;
        if (tuningWorkspaceFilter && currentWS) {
            tuningWorkspaceFilter.value = currentWS;
        }
        if (projectsWorkspaceFilter) {
            // Default the Projects tab to its prior selection, else the active kanban workspace,
            // else the first workspace. Persist back into projectsFilters so reads stay consistent.
            const desired = projectsFilters.workspaceRoot || currentWS || (_kanbanWorkspaceItems[0] && _kanbanWorkspaceItems[0].workspaceRoot) || '';
            projectsWorkspaceFilter.value = desired;
            projectsFilters.workspaceRoot = projectsWorkspaceFilter.value;
        }
    }

    function populateKanbanFilters() {
        if (!kanbanProjectFilter) return;
        updateKanbanProjectFilter();
        if (kanbanColumnFilter) {
            const currentCol = kanbanFilters.column;
            kanbanColumnFilter.innerHTML = '<option value="">All Columns</option>';
            _kanbanAvailableColumns.forEach(c => {
                const opt = document.createElement('option');
                opt.value = c.id;
                opt.textContent = c.label;
                if (c.id === currentCol) opt.selected = true;
                kanbanColumnFilter.appendChild(opt);
            });
        }
        if (epicsColumnFilter) {
            const currentCol = epicsFilters.column;
            epicsColumnFilter.innerHTML = '<option value="">All Columns</option>';
            _kanbanAvailableColumns.forEach(c => {
                const opt = document.createElement('option');
                opt.value = c.id;
                opt.textContent = c.label;
                if (c.id === currentCol) opt.selected = true;
                epicsColumnFilter.appendChild(opt);
            });
        }
    }

    function updateKanbanProjectFilter() {
        if (!kanbanProjectFilter) return;
        const selectedRoot = kanbanFilters.workspaceRoot;
        let projectSet = new Set();

        if (selectedRoot) {
            const projects = _kanbanAllWorkspaceProjects[selectedRoot] || [];
            projects.forEach(p => projectSet.add(p));
        } else {
            Object.values(_kanbanAllWorkspaceProjects).forEach(projs => {
                projs.forEach(p => projectSet.add(p));
            });
        }

        const hasNoProject = _kanbanPlansCache.some(p =>
            (!selectedRoot || p.workspaceRoot === selectedRoot) && !p.project
        );

        kanbanProjectFilter.innerHTML = '<option value="">All Projects</option>';
        if (hasNoProject) {
            const optNone = document.createElement('option');
            optNone.value = '__none__';
            optNone.textContent = '(No Project)';
            kanbanProjectFilter.appendChild(optNone);
        }

        projectSet.forEach(proj => {
            const opt = document.createElement('option');
            opt.value = proj;
            opt.textContent = proj;
            kanbanProjectFilter.appendChild(opt);
        });
        kanbanProjectFilter.value = kanbanFilters.project;
    }

    // =========================================================================
    // PROJECTS TAB (per-project PRDs)
    // =========================================================================
    // The PRD authoring UI lives here, next to the constitution editor — doc
    // creation belongs in the Project panel, not the kanban board. A PRD is a
    // per-project requirements doc; the PROJECT CONTEXT toggle (per-workspace)
    // governs whether the active project's PRD is injected into dispatched prompts.
    function normalizeRoot(root) {
        if (!root) return '';
        let r = root.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/$/, '');
        return r;
    }

    function getProjectsTabWorkspaceRoot() {
        return (projectsWorkspaceFilter && projectsWorkspaceFilter.value)
            || projectsFilters.workspaceRoot
            || kanbanFilters.workspaceRoot
            || (_kanbanWorkspaceItems[0] && _kanbanWorkspaceItems[0].workspaceRoot)
            || '';
    }

    function setProjectsPrdEditorEnabled(enabled) {
        if (btnEditProjects) btnEditProjects.disabled = !enabled;
    }

    function updateProjectContextButton() {
        if (!btnProjectContext) return;
        btnProjectContext.textContent = projectContextEnabled ? 'PROJECT CONTEXT: ON' : 'PROJECT CONTEXT: OFF';
        // project.html has no is-teal/is-off classes — toggle the "on" look inline.
        btnProjectContext.style.background = projectContextEnabled ? 'var(--accent-teal)' : '';
        btnProjectContext.style.color = projectContextEnabled ? '#001014' : '';
        btnProjectContext.style.borderColor = projectContextEnabled ? 'var(--accent-teal)' : '';
        btnProjectContext.setAttribute('data-tooltip', projectContextEnabled
            ? "Project Context ON — the selected project's PRD is injected into every dispatched prompt. Click to disable."
            : "Project Context OFF — click to inject the selected project's PRD into every dispatched prompt.");
    }

    let _selectedProjectName = null;

    function renderProjectsList() {
        const container = document.getElementById('projects-items-container');
        const emptyState = document.getElementById('projects-empty-state');
        if (!container) return;
        const wsRoot = getProjectsTabWorkspaceRoot();
        const projects = (_kanbanAllWorkspaceProjects && _kanbanAllWorkspaceProjects[normalizeRoot(wsRoot)]) || [];
        container.innerHTML = '';

        // State 1: Error — backend fetch failed. Show retry affordance.
        if (_kanbanProjectsError) {
            if (emptyState) {
                emptyState.style.display = '';
                emptyState.textContent = 'Error loading projects — click to retry';
                emptyState.style.cursor = 'pointer';
                emptyState.onclick = () => {
                    _kanbanProjectsError = false;
                    emptyState.textContent = 'Loading projects…';
                    emptyState.style.cursor = '';
                    emptyState.onclick = null;
                    vscode.postMessage({ type: 'fetchKanbanPlans', requestId: Date.now() });
                };
            }
            container.style.display = 'none';
            setProjectsPrdEditorEnabled(false);
            if (btnBuildPrd) btnBuildPrd.disabled = true;
            if (btnCopyPrdPrompt) btnCopyPrdPrompt.disabled = true;
            return;
        }

        // State 2: Cache not loaded yet — show loading, not "No projects".
        if (!Object.keys(_kanbanAllWorkspaceProjects || {}).length) {
            if (emptyState) {
                emptyState.style.display = '';
                emptyState.textContent = 'Loading projects…';
                emptyState.style.cursor = '';
                emptyState.onclick = null;
            }
            container.style.display = 'none';
            setProjectsPrdEditorEnabled(false);
            if (btnBuildPrd) btnBuildPrd.disabled = true;
            if (btnCopyPrdPrompt) btnCopyPrdPrompt.disabled = true;
            return;
        }

        // State 3: Loaded but empty — genuine "no projects" case.
        if (!projects.length) {
            if (emptyState) {
                emptyState.style.display = '';
                emptyState.textContent = 'No projects — add one on the Kanban board (+).';
                emptyState.style.cursor = '';
                emptyState.onclick = null;
            }
            container.style.display = 'none';
            setProjectsPrdEditorEnabled(false);
            if (projectsPrdStatus) projectsPrdStatus.textContent = '';
            _prdLoadedProject = null;
            _prdDirty = false;
            _selectedProjectName = null;
            if (btnBuildPrd) btnBuildPrd.disabled = true;
            if (btnCopyPrdPrompt) btnCopyPrdPrompt.disabled = true;
            return;
        }

        // State 4: Loaded with projects — normal populate.
        if (emptyState) {
            emptyState.style.display = 'none';
            emptyState.style.cursor = '';
            emptyState.onclick = null;
        }
        container.style.display = '';
        projects.forEach(proj => {
            const item = document.createElement('div');
            item.className = 'kanban-plan-item'; // reuse shared item styling
            item.dataset.project = proj;
            item.textContent = proj;
            item.addEventListener('click', () => {
                _selectedProjectName = proj;
                document.querySelectorAll('#projects-items-container .kanban-plan-item')
                    .forEach(el => el.classList.remove('selected'));
                item.classList.add('selected');
                requestProjectPrd();
            });
            container.appendChild(item);
        });
        // Preserve prior selection, else the board's active project filter, else the first.
        let toSelect = null;
        if (_selectedProjectName && projects.includes(_selectedProjectName)) {
            toSelect = _selectedProjectName;
        } else if (kanbanFilters.project && kanbanFilters.project !== '__none__' && projects.includes(kanbanFilters.project)) {
            toSelect = kanbanFilters.project;
        } else {
            toSelect = projects[0];
        }
        _selectedProjectName = toSelect;
        const items = container.querySelectorAll('.kanban-plan-item');
        for (const el of items) {
            if (el.dataset.project === toSelect) {
                el.classList.add('selected');
                break;
            }
        }
        if (btnBuildPrd) btnBuildPrd.disabled = !_selectedProjectName;
        if (btnCopyPrdPrompt) btnCopyPrdPrompt.disabled = !_selectedProjectName;
        // Don't clobber an in-progress edit: reload only when the selection differs from
        // what's loaded, or the current selection has no unsaved changes.
        if (_selectedProjectName !== _prdLoadedProject || !_prdDirty) {
            requestProjectPrd();
        } else {
            setProjectsPrdEditorEnabled(true);
        }
    }

    function requestProjectPrd() {
        const projectName = _selectedProjectName;
        const wsRoot = getProjectsTabWorkspaceRoot();
        if (!projectName || !wsRoot) { setProjectsPrdEditorEnabled(false); return; }
        if (projectsPreviewContent) projectsPreviewContent.innerHTML = '<div class="kanban-empty-state">Loading preview...</div>';
        if (projectsEditor) projectsEditor.value = '';
        _prdDirty = false;  // a fresh load supersedes any prior unsaved state
        if (projectsPrdStatus) projectsPrdStatus.textContent = 'Loading…';
        vscode.postMessage({ type: 'getProjectPrd', projectName, workspaceRoot: wsRoot });
    }

    function requestProjectContextEnabled() {
        const wsRoot = getProjectsTabWorkspaceRoot();
        if (!wsRoot) { projectContextEnabled = false; updateProjectContextButton(); return; }
        vscode.postMessage({ type: 'getProjectContextEnabled', workspaceRoot: wsRoot });
    }

    function hydrateProjectsTab() {
        populateWorkspaceDropdowns();
        renderProjectsList(); // shows "Loading…" if cache empty, populates if cached
        requestProjectContextEnabled();
    }

    if (projectsWorkspaceFilter) {
        projectsWorkspaceFilter.addEventListener('change', () => {
            projectsFilters.workspaceRoot = projectsWorkspaceFilter.value;
            renderProjectsList();
            requestProjectContextEnabled();
        });
    }
    if (btnProjectContext) {
        btnProjectContext.addEventListener('click', () => {
            projectContextEnabled = !projectContextEnabled;
            updateProjectContextButton();
            vscode.postMessage({ type: 'setProjectContextEnabled', enabled: projectContextEnabled, workspaceRoot: getProjectsTabWorkspaceRoot() });
        });
    }

    // =========================================================================
    // KANBAN TAB
    // =========================================================================
    function getFilteredKanbanPlans() {
        return _kanbanPlansCache.filter(plan => {
            if (plan.isEpic) return false;
            if (kanbanFilters.column && plan.column !== kanbanFilters.column) return false;
            if (kanbanFilters.workspaceRoot && normalizeRoot(plan.workspaceRoot) !== normalizeRoot(kanbanFilters.workspaceRoot)) return false;
            if (kanbanFilters.project) {
                if (kanbanFilters.project === '__none__') {
                    if (plan.project !== '') return false;
                } else if (plan.project !== kanbanFilters.project) {
                    return false;
                }
            }
            if (kanbanFilters.search) {
                const searchLower = kanbanFilters.search.toLowerCase();
                if (!plan.topic.toLowerCase().includes(searchLower)) return false;
            }
            if (kanbanFilters.complexity) {
                const c = String(plan.complexity || '').toLowerCase();
                if (kanbanFilters.complexity === 'unknown') {
                    if (c !== 'unknown' && c !== '') return false;
                } else {
                    const [lo, hi] = kanbanFilters.complexity.split('-').map(Number);
                    const score = parseInt(plan.complexity, 10);
                    if (isNaN(score) || score < lo || score > hi) return false;
                }
            }
            return true;
        });
    }

    function renderKanbanPlans() {
        if (!kanbanListPane) return;

        let filtered = getFilteredKanbanPlans();

        kanbanListPane.innerHTML = '';
        const toggleRow = document.createElement('div');
        toggleRow.className = 'sidebar-toggle-row';
        const linkAllBtn = document.createElement('button');
        linkAllBtn.id = 'kanban-link-all';
        linkAllBtn.className = 'strip-btn';
        linkAllBtn.title = 'Copy all filtered plan links to clipboard';
        linkAllBtn.textContent = 'Link all';
        linkAllBtn.addEventListener('click', () => {
            const visiblePlans = getFilteredKanbanPlans();
            const links = visiblePlans
                .filter(p => p.planFile)
                .map(p => toAgentRef(p.planFile))
                .join('\n');
            if (!links) {
                showToast('No plans to link in the current filter.', 'info');
                return;
            }
            navigator.clipboard.writeText(links).then(() => {
                const oldText = linkAllBtn.textContent;
                linkAllBtn.textContent = 'Copied!';
                setTimeout(() => { linkAllBtn.textContent = oldText; }, 2000);
            });
        });
        toggleRow.appendChild(linkAllBtn);
        const toggleBtn = document.createElement('button');
        toggleBtn.className = 'sidebar-toggle-btn';
        toggleBtn.title = 'Toggle sidebar';
        toggleBtn.textContent = state.kanbanListCollapsed ? '»' : '«';
        toggleBtn.addEventListener('click', toggleSidebarCollapsed);
        toggleRow.appendChild(toggleBtn);
        kanbanListPane.appendChild(toggleRow);

        if (filtered.length === 0) {
            const emptyState = document.createElement('div');
            emptyState.className = 'kanban-empty-state';
            emptyState.textContent = 'No matching kanban plans';
            kanbanListPane.appendChild(emptyState);
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
            const complexityClass = _complexityToCssClass(plan.complexity);

            itemDiv.innerHTML = `
                <div style="width: 100%;">
                    <div class="kanban-plan-topic">${escapeHtml(plan.topic)}</div>
                    <div class="kanban-plan-meta" style="margin-top: 4px;">
                        ${escapeHtml(metaParts.join(' · '))} · ${escapeHtml(displayTime)}
                    </div>
                    <div class="kanban-plan-actions">
                        <span class="kanban-column-badge clickable" data-column="${escapeHtml(plan.column)}">${escapeHtml(columnDef ? columnDef.label : plan.column)}</span>
                        <select class="kanban-column-dropdown" style="display:none;" data-plan-file="${escapeHtml(plan.planFile || '')}" data-workspace-root="${escapeHtml(plan.workspaceRoot)}">
                            ${_kanbanAvailableColumns.map(col => `<option value="${escapeHtml(col.id)}" ${col.id === plan.column ? 'selected' : ''}>${escapeHtml(col.label)}</option>`).join('')}
                        </select>
                        ${plan.planFile ? `<button class="kanban-plan-copy-link" data-plan-file="${escapeHtml(plan.planFile)}">Copy Link</button>` : ''}
                        ${plan.sessionId ? `<button class="kanban-plan-copy-prompt" data-session-id="${escapeHtml(plan.sessionId)}" data-column="${escapeHtml(plan.column)}" data-workspace-root="${escapeHtml(plan.workspaceRoot)}">Copy Prompt</button>` : ''}
                        <span class="complexity-dot ${complexityClass}" title="Complexity: ${escapeHtml(plan.complexity)}" style="margin-left: auto;"></span>
                    </div>
                </div>
            `;

            itemDiv.addEventListener('click', () => {
                _pendingAutoEdit = false;
                if (state.dirtyFlags.kanban) exitEditMode('kanban');
                document.querySelectorAll('.kanban-plan-item').forEach(el => el.classList.remove('selected'));
                itemDiv.classList.add('selected');
                loadKanbanPlanPreview(plan);
            });

            // Action wiring (Copy link, dropdown column change, etc.)
            const copyLinkBtn = itemDiv.querySelector('.kanban-plan-copy-link');
            if (copyLinkBtn) {
                copyLinkBtn.addEventListener('click', e => {
                    e.stopPropagation();
                    const path = copyLinkBtn.dataset.planFile;
                    navigator.clipboard.writeText(toAgentRef(path)).then(() => {
                        copyLinkBtn.textContent = 'Copied';
                        setTimeout(() => copyLinkBtn.textContent = 'Copy Link', 2000);
                    });
                });
            }

            const copyPromptBtn = itemDiv.querySelector('.kanban-plan-copy-prompt');
            if (copyPromptBtn) {
                copyPromptBtn.addEventListener('click', e => {
                    e.stopPropagation();
                    vscode.postMessage({
                        type: 'copyKanbanPlanPrompt',
                        sessionId: copyPromptBtn.dataset.sessionId,
                        column: copyPromptBtn.dataset.column,
                        workspaceRoot: copyPromptBtn.dataset.workspaceRoot
                    });
                });
            }

            const badge = itemDiv.querySelector('.kanban-column-badge.clickable');
            const select = itemDiv.querySelector('.kanban-column-dropdown');
            if (badge && select) {
                badge.addEventListener('click', e => {
                    e.stopPropagation();
                    kanbanListPane.querySelectorAll('.kanban-column-dropdown').forEach(s => s.style.display = 'none');
                    select.style.display = 'block';
                    select.focus();
                });
                select.addEventListener('change', e => {
                    e.stopPropagation();
                    vscode.postMessage({
                        type: 'moveKanbanPlanColumn',
                        planFile: select.dataset.planFile,
                        newColumn: select.value,
                        workspaceRoot: select.dataset.workspaceRoot
                    });
                    select.style.display = 'none';
                });
                select.addEventListener('blur', () => {
                    setTimeout(() => select.style.display = 'none', 200);
                });
            }

            kanbanListPane.appendChild(itemDiv);
        });
    }

    function tryResolvePendingKanbanSelection() {
        if (!_pendingKanbanSelection) return;
        const sel = _pendingKanbanSelection;
        const match = _kanbanPlansCache.find(p =>
            (sel.planFile && p.planFile === sel.planFile) ||
            (sel.planId && p.planId === sel.planId) ||
            (sel.sessionId && p.sessionId === sel.sessionId)
        );
        if (!match) {
            // Plan not in the (filtered) cache. After 3 failed attempts, fall back
            // to widest filters — the narrow filter may be hiding the plan due to
            // a workspace mapping mismatch or stale cache.
            if (++_pendingKanbanSelectionRetries >= 3) {
                kanbanFilters.workspaceRoot = '';
                if (kanbanWorkspaceFilter) kanbanWorkspaceFilter.value = '';
                kanbanFilters.project = '';
                if (kanbanProjectFilter) kanbanProjectFilter.value = '';
                kanbanFilters.column = '';
                if (kanbanColumnFilter) kanbanColumnFilter.value = '';
                _pendingKanbanSelection = null;  // stop retrying
                _pendingKanbanFilterIntent = null;  // don't re-narrow
                vscode.postMessage({ type: 'fetchKanbanPlans', requestId: Date.now() });
            }
            return;
        }
        const itemDiv = kanbanListPane && kanbanListPane.querySelector(`.kanban-plan-item[data-plan-id="${match.planId}"]`);
        if (!itemDiv) {
            // The plan is confirmed in the cache but is hidden by the current
            // filters. The filter intent is a nicety and must never prevent the
            // selection the user explicitly requested. Force-clear all kanban
            // filters, re-render, and re-query. This also breaks the infinite
            // re-narrow loop (kanbanPlansReady re-applies the intent every time)
            // by clearing the intent so the next render stays wide.
            kanbanFilters.workspaceRoot = '';
            if (kanbanWorkspaceFilter) kanbanWorkspaceFilter.value = '';
            kanbanFilters.project = '';
            if (kanbanProjectFilter) kanbanProjectFilter.value = '';
            kanbanFilters.column = '';
            if (kanbanColumnFilter) kanbanColumnFilter.value = '';
            kanbanFilters.complexity = '';
            if (kanbanComplexityFilter) kanbanComplexityFilter.value = '';
            _pendingKanbanFilterIntent = null;
            renderKanbanPlans();
            const revealed = kanbanListPane && kanbanListPane.querySelector(`.kanban-plan-item[data-plan-id="${match.planId}"]`);
            if (revealed) {
                revealed.scrollIntoView({ behavior: 'smooth', block: 'center' });
                document.querySelectorAll('.kanban-plan-item').forEach(el => el.classList.remove('selected'));
                revealed.classList.add('selected');
                loadKanbanPlanPreview(match);
                _pendingKanbanSelection = null;
                return;
            }
            // Still hidden even after clearing filters — the cache likely does
            // not actually contain the rendered plan yet. Increment the retry
            // counter and fall through to the normal retry/fallback flow so the
            // 3-retry widest-filter re-fetch can kick in.
            if (++_pendingKanbanSelectionRetries >= 3) {
                _pendingKanbanSelection = null;
                vscode.postMessage({ type: 'fetchKanbanPlans', requestId: Date.now() });
            }
            return;
        }
        itemDiv.scrollIntoView({ behavior: 'smooth', block: 'center' });
        document.querySelectorAll('.kanban-plan-item').forEach(el => el.classList.remove('selected'));
        itemDiv.classList.add('selected');
        loadKanbanPlanPreview(match);
        _pendingKanbanSelection = null;
    }

    function tryResolvePendingEpicSelection() {
        if (!_pendingEpicSelection) return;
        const sel = _pendingEpicSelection;
        const pool = _kanbanPlansCache.filter(p => p.isEpic);
        const match = pool.find(p =>
            (sel.planFile && p.planFile === sel.planFile) ||
            (sel.planId && p.planId === sel.planId) ||
            (sel.sessionId && p.sessionId === sel.sessionId)
        );
        if (!match) return;
        const itemDiv = epicsListPane &&
            epicsListPane.querySelector(`.epic-plan-item[data-plan-id="${match.planId}"]`);
        if (!itemDiv) return;
        itemDiv.scrollIntoView({ behavior: 'smooth', block: 'center' });
        document.querySelectorAll('.epic-plan-item').forEach(el => el.classList.remove('selected'));
        itemDiv.classList.add('selected');
        selectEpic(match);
        _pendingEpicSelection = null;
    }

    function loadKanbanPlanPreview(plan) {
        _kanbanSelectedPlan = plan;
        renderKanbanMetaBar(plan);
        if (plan.sessionId) {
            vscode.postMessage({ type: 'planShown', sessionId: plan.sessionId });
        }
        if (plan.planFile) {
            if (kanbanPreviewContent) kanbanPreviewContent.innerHTML = '<div class="kanban-empty-state">Loading preview...</div>';
            _kanbanPreviewRequestId++;
            vscode.postMessage({
                type: 'fetchKanbanPlanPreview',
                filePath: plan.planFile,
                requestId: _kanbanPreviewRequestId
            });
        } else {
            if (kanbanPreviewContent) kanbanPreviewContent.innerHTML = '<div class="kanban-empty-state">No plan file linked</div>';
        }
    }

    function renderKanbanMetaBar(plan) {
        const metaBar = document.getElementById('kanban-preview-meta-bar');
        if (!metaBar) return;
        metaBar.style.display = 'flex';

        const columnDef = _kanbanAvailableColumns.find(c => c.id === plan.column);
        const columnLabel = escapeHtml(columnDef ? columnDef.label : plan.column);
        const complexityClass = _complexityToCssClass(plan.complexity);
        const complexityLabel = escapeHtml(plan.complexity || 'Unknown');

        metaBar.innerHTML = `
            <div class="kanban-meta-group">
                <span class="kanban-meta-label">Column:</span>
                <span class="kanban-meta-value" id="kanban-meta-column">${columnLabel}</span>
                <select class="kanban-meta-dropdown" id="kanban-meta-column-select" style="display:none;" data-plan-file="${escapeHtml(plan.planFile || '')}" data-workspace-root="${escapeHtml(plan.workspaceRoot)}" data-plan-id="${escapeHtml(plan.planId)}">
                    ${_kanbanAvailableColumns.map(col => `<option value="${escapeHtml(col.id)}">${escapeHtml(col.label)}</option>`).join('')}
                    <option value="COMPLETED">COMPLETED</option>
                    <option value="__delete__">— Delete Plan —</option>
                </select>
            </div>
            <div class="kanban-meta-group">
                <span class="kanban-meta-label">Complexity:</span>
                <span class="complexity-dot ${complexityClass}"></span>
                <span class="kanban-meta-value" id="kanban-meta-complexity">${complexityLabel}</span>
                <select class="kanban-meta-dropdown" id="kanban-meta-complexity-select" style="display:none;" data-plan-id="${escapeHtml(plan.planId)}" data-workspace-root="${escapeHtml(plan.workspaceRoot)}">
                    ${['Unknown', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10'].map(v => `<option value="${v}" ${v === plan.complexity ? 'selected' : ''}>${v}</option>`).join('')}
                </select>
            </div>
            <div class="kanban-meta-group" style="margin-left: auto;">
                <button class="strip-btn" id="btn-edit-kanban" style="${state.editMode.kanban ? 'display:none;' : ''}">Edit</button>
                <button class="strip-btn" id="btn-save-kanban" style="${state.editMode.kanban ? '' : 'display:none;'}">Save</button>
                <button class="strip-btn" id="btn-cancel-kanban" style="${state.editMode.kanban ? '' : 'display:none;'}">Cancel</button>
                ${plan.clickupTaskId || plan.linearIssueId ? `
                    <button class="strip-btn" id="kanban-meta-upload-btn" ${uploadingPlanAttachment ? 'disabled' : ''}>
                        ${uploadingPlanAttachment ? 'Uploading...' : 'Upload'}
                    </button>
                ` : ''}
                <button class="strip-btn" id="kanban-meta-log-btn">Log</button>
                <button class="strip-btn" id="kanban-meta-delete-btn">Delete</button>
            </div>
        `;

        // Dynamic buttons listeners
        const dynamicEditBtn = document.getElementById('btn-edit-kanban');
        const dynamicCancelBtn = document.getElementById('btn-cancel-kanban');
        const dynamicSaveBtn = document.getElementById('btn-save-kanban');

        if (dynamicEditBtn) dynamicEditBtn.addEventListener('click', () => enterEditMode('kanban'));
        if (dynamicCancelBtn) dynamicCancelBtn.addEventListener('click', () => exitEditMode('kanban'));
        if (dynamicSaveBtn) {
            dynamicSaveBtn.addEventListener('click', () => {
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

        // Column select toggles
        const columnToggle = document.getElementById('kanban-meta-column');
        const columnSelect = document.getElementById('kanban-meta-column-select');
        if (columnToggle && columnSelect) {
            columnToggle.addEventListener('click', e => {
                e.stopPropagation();
                columnSelect.style.display = 'block';
                columnSelect.focus();
            });
            columnSelect.addEventListener('change', () => {
                columnSelect.style.display = 'none';
                if (columnSelect.value === '__delete__') {
                    vscode.postMessage({ type: 'deleteKanbanPlan', planId: columnSelect.dataset.planId, planFile: columnSelect.dataset.planFile, workspaceRoot: columnSelect.dataset.workspaceRoot });
                } else {
                    vscode.postMessage({ type: 'moveKanbanPlanColumn', planFile: columnSelect.dataset.planFile, newColumn: columnSelect.value, workspaceRoot: columnSelect.dataset.workspaceRoot });
                }
            });
            columnSelect.addEventListener('blur', () => setTimeout(() => columnSelect.style.display = 'none', 200));
        }

        // Complexity select toggles
        const compToggle = document.getElementById('kanban-meta-complexity');
        const compSelect = document.getElementById('kanban-meta-complexity-select');
        if (compToggle && compSelect) {
            compToggle.addEventListener('click', e => {
                e.stopPropagation();
                compSelect.style.display = 'block';
                compSelect.focus();
            });
            compSelect.addEventListener('change', () => {
                compSelect.style.display = 'none';
                vscode.postMessage({ type: 'setKanbanPlanComplexity', planId: compSelect.dataset.planId, complexity: compSelect.value, workspaceRoot: compSelect.dataset.workspaceRoot });
            });
            compSelect.addEventListener('blur', () => setTimeout(() => compSelect.style.display = 'none', 200));
        }

        document.getElementById('kanban-meta-log-btn').addEventListener('click', () => {
            vscode.postMessage({ type: 'fetchKanbanPlanLog', sessionId: plan.sessionId, workspaceRoot: plan.workspaceRoot });
        });
        document.getElementById('kanban-meta-delete-btn').addEventListener('click', () => {
            vscode.postMessage({ type: 'deleteKanbanPlan', planId: plan.planId, planFile: plan.planFile, workspaceRoot: plan.workspaceRoot });
        });
        const uploadBtn = document.getElementById('kanban-meta-upload-btn');
        if (uploadBtn) {
            uploadBtn.addEventListener('click', () => {
                if (!_kanbanSelectedPlan) return;
                if (uploadingPlanAttachment) return;
                uploadingPlanAttachment = true;
                uploadBtn.disabled = true;
                uploadBtn.textContent = 'Uploading...';
                vscode.postMessage({
                    type: 'uploadPlanAttachment',
                    workspaceRoot: _kanbanSelectedPlan.workspaceRoot,
                    planFile: _kanbanSelectedPlan.planFile,
                    topic: _kanbanSelectedPlan.topic || '(untitled)'
                });
            });
        }
    }

    if (btnImportKanbanPlans) {
        btnImportKanbanPlans.addEventListener('click', () => {
            vscode.postMessage({ type: 'importPlans' });
        });
    }
    if (btnCreateKanbanPlan) {
        btnCreateKanbanPlan.addEventListener('click', () => {
            btnCreateKanbanPlan.disabled = true;
            btnCreateKanbanPlan.textContent = 'Creating...';
            vscode.postMessage({ type: 'createPlan' });
            // Add safety timeout (3s) to restore the button in case creation/refresh fails
            setTimeout(() => {
                if (btnCreateKanbanPlan.disabled) {
                    btnCreateKanbanPlan.disabled = false;
                    btnCreateKanbanPlan.textContent = 'Create';
                }
            }, 3000);
        });
    }
    if (btnChatCopyPrompt) {
        btnChatCopyPrompt.addEventListener('click', () => {
            vscode.postMessage({
                type: 'copyChatPrompt',
                workspaceRoot: kanbanWorkspaceFilter ? kanbanWorkspaceFilter.value : ''
            });
        });
    }
    const btnKanbanAutofetch = document.getElementById('btn-kanban-autofetch');
    const autofetchModal = document.getElementById('autofetch-modal');
    const btnCloseAutofetchModal = document.getElementById('btn-close-autofetch-modal');

    function openAutofetchModal() {
        if (autofetchModal) autofetchModal.style.display = 'flex';
    }
    function closeAutofetchModal() {
        if (autofetchModal) autofetchModal.style.display = 'none';
    }

    if (btnKanbanAutofetch) {
        btnKanbanAutofetch.addEventListener('click', openAutofetchModal);
    }
    if (btnCloseAutofetchModal) {
        btnCloseAutofetchModal.addEventListener('click', closeAutofetchModal);
    }

    const btnPlanAutoFetchNow = document.getElementById('btn-plan-auto-fetch-now');
    if (btnPlanAutoFetchNow) {
        btnPlanAutoFetchNow.addEventListener('click', () => {
            btnPlanAutoFetchNow.disabled = true;
            btnPlanAutoFetchNow.textContent = 'Fetching…';
            vscode.postMessage({ type: 'planAutoFetchRunNow' });
        });
    }
    const kanbanAutoFetchEnabled = document.getElementById('kanban-auto-fetch-enabled');
    if (kanbanAutoFetchEnabled) {
        kanbanAutoFetchEnabled.addEventListener('change', () => {
            vscode.postMessage({
                type: 'setPlanAutoFetchEnabled',
                enabled: kanbanAutoFetchEnabled.checked
            });
        });
    }
    if (kanbanColumnFilter) {
        kanbanColumnFilter.addEventListener('change', () => {
            kanbanFilters.column = kanbanColumnFilter.value;
            renderKanbanPlans();
        });
    }
    if (kanbanWorkspaceFilter) {
        kanbanWorkspaceFilter.addEventListener('change', () => {
            kanbanFilters.workspaceRoot = kanbanWorkspaceFilter.value;
            kanbanFilters.project = '';
            updateKanbanProjectFilter();
            renderKanbanPlans();
        });
    }
    if (kanbanProjectFilter) {
        kanbanProjectFilter.addEventListener('change', () => {
            kanbanFilters.project = kanbanProjectFilter.value;
            renderKanbanPlans();
        });
    }
    if (kanbanComplexityFilter) {
        kanbanComplexityFilter.addEventListener('change', () => {
            kanbanFilters.complexity = kanbanComplexityFilter.value;
            renderKanbanPlans();
        });
    }
    let kanbanSearchTimeout;
    if (kanbanSearch) {
        kanbanSearch.addEventListener('input', () => {
            clearTimeout(kanbanSearchTimeout);
            kanbanSearchTimeout = setTimeout(() => {
                kanbanFilters.search = kanbanSearch.value;
                renderKanbanPlans();
            }, 200);
        });
    }

    // =========================================================================
    // EPICS TAB
    // =========================================================================
    function renderEpicsList() {
        if (!epicsListPane) return;

        // Epics list is DB-only — identical source to the Plans list. Epic files in
        // .switchboard/epics/ are imported into the kanban DB by GlobalPlanWatcherService
        // and appear here as normal DB-backed epics.
        let filtered = _kanbanPlansCache.filter(plan => plan.isEpic);
        if (epicsFilters.workspaceRoot) {
            filtered = filtered.filter(plan => plan.workspaceRoot === epicsFilters.workspaceRoot);
        }
        if (epicsFilters.column) {
            filtered = filtered.filter(plan => plan.column === epicsFilters.column);
        }

        epicsListPane.innerHTML = '';

        // NEW: Create toggle button (present even when empty)
        const toggleRow = document.createElement('div');
        toggleRow.className = 'sidebar-toggle-row';
        const toggleBtn = document.createElement('button');
        toggleBtn.className = 'sidebar-toggle-btn';
        toggleBtn.title = 'Toggle sidebar';
        toggleBtn.textContent = state.epicsListCollapsed ? '»' : '«';
        toggleBtn.addEventListener('click', toggleSidebarCollapsed);
        toggleRow.appendChild(toggleBtn);
        epicsListPane.appendChild(toggleRow);

        if (filtered.length === 0) {
            const emptyState = document.createElement('div');
            emptyState.className = 'empty-state';
            emptyState.textContent = 'No epics found. Use "+ New Epic" to create one.';
            epicsListPane.appendChild(emptyState);
            return;
        }

        filtered.forEach(plan => {
            const itemDiv = document.createElement('div');
            itemDiv.className = 'epic-plan-item';
            itemDiv.dataset.planId = plan.planId || '';
            if (_epicSelectedPlan && _epicSelectedPlan.planId === plan.planId) {
                itemDiv.classList.add('selected');
            }

            const columnDef = plan.column ? _kanbanAvailableColumns.find(c => c.id === plan.column) : null;
            const columnBadge = plan.column
                ? `<span class="kanban-column-badge clickable" data-column="${escapeHtml(plan.column)}">${escapeHtml(columnDef ? columnDef.label : plan.column)}</span>
                   <select class="kanban-column-dropdown" style="display:none;" data-plan-file="${escapeHtml(plan.planFile || '')}" data-workspace-root="${escapeHtml(plan.workspaceRoot || '')}">
                       ${_kanbanAvailableColumns.map(col => `<option value="${escapeHtml(col.id)}" ${col.id === plan.column ? 'selected' : ''}>${escapeHtml(col.label)}</option>`).join('')}
                   </select>`
                : '';

            // Every epic is DB-backed/manageable now — standalone epic documents are gone.
            const actionButtons = `
                <div class="kanban-plan-actions" style="margin-top: 6px;">
                    ${columnBadge}
                    ${plan.planFile ? `<button class="kanban-plan-copy-link epic-card-action" data-plan-file="${escapeHtml(plan.planFile)}">Copy Link</button>` : ''}
                    ${plan.sessionId || plan.planId ? `<button class="kanban-plan-copy-prompt epic-card-action" data-session-id="${escapeHtml(plan.sessionId || plan.planId)}" data-workspace-root="${escapeHtml(plan.workspaceRoot || '')}">Copy Planning Prompt</button>` : ''}
                    ${plan.sessionId || plan.planId ? `<button class="epic-send-to-planner epic-card-action" data-plan-file="${escapeHtml(plan.planFile || '')}" data-workspace-root="${escapeHtml(plan.workspaceRoot || '')}">Send to Planner</button>` : ''}
                </div>
            `;

            const displayTime = plan.mtime > 0 ? formatRelativeTime(plan.mtime) : 'unknown';
            itemDiv.innerHTML = `
                <div style="font-weight: 500;">${escapeHtml(plan.topic)}</div>
                <div class="kanban-plan-meta" style="margin-top:4px;">${escapeHtml(plan.workspaceLabel)} · ${displayTime}</div>
                <details class="epic-accordion" data-plan-id="${escapeHtml(plan.planId)}" data-workspace-root="${escapeHtml(plan.workspaceRoot || '')}" style="margin-top: 6px; font-size: 11px;">
                    <summary style="cursor: pointer; color: var(--text-secondary);">Subtasks (${plan.subtaskCount || 0})</summary>
                    <div class="epic-subtasks-list" id="subtasks-${escapeHtml(plan.planId)}">Loading subtasks...</div>
                </details>
                ${actionButtons}
            `;

            itemDiv.addEventListener('click', e => {
                if (e.target.tagName === 'SUMMARY' || e.target.closest('.epic-accordion') || e.target.closest('.epic-card-action') || e.target.closest('.kanban-column-badge') || e.target.closest('.kanban-column-dropdown')) return;
                if (state.dirtyFlags.epics) exitEditMode('epics');
                document.querySelectorAll('.epic-plan-item').forEach(el => el.classList.remove('selected'));
                itemDiv.classList.add('selected');
                selectEpic(plan);
            });

            // Column Badge & Dropdown Wiring
            const badge = itemDiv.querySelector('.kanban-column-badge.clickable');
            const select = itemDiv.querySelector('.kanban-column-dropdown');
            if (badge && select) {
                badge.addEventListener('click', e => {
                    e.stopPropagation();
                    epicsListPane.querySelectorAll('.kanban-column-dropdown').forEach(s => s.style.display = 'none');
                    select.style.display = 'block';
                    select.focus();
                });
                select.addEventListener('change', e => {
                    e.stopPropagation();
                    vscode.postMessage({
                        type: 'moveKanbanPlanColumn',
                        planFile: select.dataset.planFile,
                        newColumn: select.value,
                        workspaceRoot: select.dataset.workspaceRoot
                    });
                    select.style.display = 'none';
                });
                select.addEventListener('blur', () => {
                    setTimeout(() => select.style.display = 'none', 200);
                });
            }

            // Copy Link
            const epicCopyLinkBtn = itemDiv.querySelector('.epic-card-action.kanban-plan-copy-link');
            if (epicCopyLinkBtn) {
                epicCopyLinkBtn.addEventListener('click', e => {
                    e.stopPropagation();
                    const filePath = epicCopyLinkBtn.dataset.planFile;
                    navigator.clipboard.writeText(toAgentRef(filePath)).then(() => {
                        epicCopyLinkBtn.textContent = 'Copied';
                        setTimeout(() => epicCopyLinkBtn.textContent = 'Copy Link', 2000);
                    });
                });
            }

            // Copy Planning Prompt
            const epicCopyPromptBtn = itemDiv.querySelector('.epic-card-action.kanban-plan-copy-prompt');
            if (epicCopyPromptBtn) {
                epicCopyPromptBtn.addEventListener('click', e => {
                    e.stopPropagation();
                    // No optimistic "Copied" text: the backend kanbanPlanPromptCopied
                    // response handler (project.js ~565) finds this button via
                    // .kanban-plan-copy-prompt[data-session-id] and sets "Copied!"/"Failed"
                    // with a reset timer. An optimistic update would race with that handler
                    // (it captures oldText at response time) and leave the button stuck on
                    // "Copied". Matches the regular kanban Copy Prompt pattern (no optimistic
                    // update — see project.js ~1174).
                    vscode.postMessage({
                        type: 'copyEpicPlannerPrompt',
                        sessionId: epicCopyPromptBtn.dataset.sessionId,
                        workspaceRoot: epicCopyPromptBtn.dataset.workspaceRoot
                    });
                });
            }

            // Send to Planner
            const epicSendPlannerBtn = itemDiv.querySelector('.epic-send-to-planner');
            if (epicSendPlannerBtn) {
                epicSendPlannerBtn.addEventListener('click', e => {
                    e.stopPropagation();
                    const planFile = epicSendPlannerBtn.dataset.planFile;
                    const wsRoot = epicSendPlannerBtn.dataset.workspaceRoot;
                    const plannerCol = typeof _kanbanAvailableColumns !== 'undefined'
                        ? _kanbanAvailableColumns.find(c => c.id === 'CREATED' || c.kind === 'created')
                        : null;
                    if (!plannerCol) {
                        showToast('No Planner column found on the kanban board.', 'error');
                        return;
                    }
                    vscode.postMessage({
                        type: 'moveKanbanPlanColumn',
                        planFile,
                        newColumn: plannerCol.id,
                        workspaceRoot: wsRoot
                    });
                    epicSendPlannerBtn.textContent = 'Sent';
                    setTimeout(() => epicSendPlannerBtn.textContent = 'Send to Planner', 2000);
                });
            }

            const accordion = itemDiv.querySelector('.epic-accordion');
            accordion.addEventListener('toggle', () => {
                if (accordion.open) {
                    vscode.postMessage({ type: 'getEpicDetails', sessionId: plan.sessionId || plan.planId, workspaceRoot: plan.workspaceRoot });
                }
            });

            epicsListPane.appendChild(itemDiv);
        });
    }

    function selectEpic(plan) {
        if (state.editMode.epics) exitEditMode('epics');
        _epicSelectedPlan = plan;
        _epicPreviewFilePath = plan.planFile || null;
        _epicSubtaskPreview = null;

        renderEpicMetaBar(plan);

        if (plan.planFile) {
            if (epicsPreviewContent) epicsPreviewContent.innerHTML = '<div class="kanban-empty-state">Loading preview...</div>';
            vscode.postMessage({
                type: 'fetchKanbanPlanPreview',
                filePath: plan.planFile,
                requestId: ++_kanbanPreviewRequestId
            });
        } else {
            if (epicsPreviewContent) epicsPreviewContent.innerHTML = '<div class="kanban-empty-state">No file linked</div>';
        }
    }

    function renderEpicMetaBar(plan) {
        const metaBar = document.getElementById('epic-preview-meta-bar');
        if (!metaBar) return;
        metaBar.style.display = 'flex';
        // Every epic is DB-backed/manageable now — standalone epic documents are gone.
        const isManageable = !!plan;
        const manageGroup = `
            <div class="kanban-meta-group" style="display:flex; gap:6px;">
                <button class="strip-btn" id="btn-epic-refine" title="Refine this epic's description and propose a subtask breakdown — copies a prompt to the clipboard">Refine</button>
                <button class="strip-btn" id="btn-epic-add-subtask" title="Add an existing plan to this epic as a subtask">+ Subtask</button>
                <button class="strip-btn" id="btn-epic-delete" style="color:#ff6b6b;" title="Delete this epic (subtasks are detached)">Delete Epic</button>
            </div>
        `;
        metaBar.innerHTML = `
            ${manageGroup}
            <div class="kanban-meta-group" style="margin-left: auto;">
                <button class="strip-btn" id="btn-edit-epics" style="${state.editMode.epics ? 'display:none;' : ''}">Edit</button>
                <button class="strip-btn" id="btn-save-epics" style="${state.editMode.epics ? '' : 'display:none;'}">Save</button>
                <button class="strip-btn" id="btn-cancel-epics" style="${state.editMode.epics ? '' : 'display:none;'}">Cancel</button>
            </div>
        `;

        if (isManageable) {
            const btnAddSub = document.getElementById('btn-epic-add-subtask');
            const btnDelEpic = document.getElementById('btn-epic-delete');
            const btnRefine = document.getElementById('btn-epic-refine');
            if (btnRefine) btnRefine.addEventListener('click', () => {
                if (!_epicSelectedPlan) return;
                const original = btnRefine.textContent;
                btnRefine.textContent = 'Copied ✓';
                setTimeout(() => { btnRefine.textContent = original; }, 1200);
                vscode.postMessage({
                    type: 'refineEpic',
                    planId: _epicSelectedPlan.planId || '',
                    planFile: _epicSelectedPlan.planFile || '',
                    title: _epicSelectedPlan.topic || _epicSelectedPlan.name || '',
                    subtaskCount: _epicSelectedPlan.subtaskCount || 0,
                    workspaceRoot: _epicSelectedPlan.workspaceRoot
                });
            });
            if (btnAddSub) btnAddSub.addEventListener('click', openEpicAddSubtaskOverlay);
            if (btnDelEpic) btnDelEpic.addEventListener('click', () => {
                if (!_epicSelectedPlan) return;
                // No confirm dialog (project rule): delete executes immediately. Subtasks are
                // detached (deleteSubtasks:false), matching the board's epic-as-unit model.
                vscode.postMessage({
                    type: 'deleteEpic',
                    sessionId: _epicSelectedPlan.sessionId || _epicSelectedPlan.planId,
                    workspaceRoot: _epicSelectedPlan.workspaceRoot,
                    deleteSubtasks: false
                });
                _epicSelectedPlan = null;
                if (epicsPreviewContent) epicsPreviewContent.innerHTML = '<div class="kanban-empty-state">Select an epic to preview</div>';
                metaBar.style.display = 'none';
            });
        }

        const btnEditEpics = document.getElementById('btn-edit-epics');
        const btnCancelEpics = document.getElementById('btn-cancel-epics');
        const btnSaveEpics = document.getElementById('btn-save-epics');

        if (btnEditEpics) btnEditEpics.addEventListener('click', () => enterEditMode('epics'));
        if (btnCancelEpics) btnCancelEpics.addEventListener('click', () => exitEditMode('epics'));
        if (btnSaveEpics) {
            btnSaveEpics.addEventListener('click', () => {
                const filePath = _epicSelectedPlan ? _epicSelectedPlan.planFile : null;
                const content = epicsEditor ? epicsEditor.value : '';
                const originalContent = state.editOriginalContent.epics;
                if (filePath) {
                    vscode.postMessage({
                        type: 'saveFileContent',
                        filePath,
                        content,
                        originalContent,
                        tab: 'epics'
                    });
                }
            });
        }
    }

    function renderEpicSubtaskMetaBar(plan) {
        const metaBar = document.getElementById('epic-preview-meta-bar');
        if (!metaBar) return;
        metaBar.style.display = 'flex';

        const complexityClass = _complexityToCssClass(plan ? plan.complexity : null);
        const complexityLabel = escapeHtml((plan && plan.complexity) || 'Unknown');
        const hasPlanId = plan && plan.planId;

        const complexityGroup = hasPlanId ? `
            <div class="kanban-meta-group">
                <span class="kanban-meta-label">Complexity:</span>
                <span class="complexity-dot ${complexityClass}"></span>
                <span class="kanban-meta-value" id="epic-subtask-meta-complexity">${complexityLabel}</span>
                <select class="kanban-meta-dropdown" id="epic-subtask-meta-complexity-select" style="display:none;" data-plan-id="${escapeHtml(plan.planId)}" data-workspace-root="${escapeHtml(plan.workspaceRoot || '')}">
                    ${['Unknown', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10'].map(v => `<option value="${v}" ${v === (plan.complexity || 'Unknown') ? 'selected' : ''}>${v}</option>`).join('')}
                </select>
            </div>
        ` : '';

        const deleteBtn = hasPlanId ? `<button class="strip-btn" id="epic-subtask-meta-delete-btn" style="color:#ff6b6b;">Delete</button>` : '';

        metaBar.innerHTML = `
            <div class="kanban-meta-group">
                <span class="kanban-meta-label" style="color: var(--text-secondary); font-style: italic;">Subtask</span>
            </div>
            ${complexityGroup}
            <div class="kanban-meta-group" style="margin-left: auto;">
                <button class="strip-btn" id="btn-edit-epics" style="${state.editMode.epics ? 'display:none;' : ''}">Edit</button>
                <button class="strip-btn" id="btn-save-epics" style="${state.editMode.epics ? '' : 'display:none;'}">Save</button>
                <button class="strip-btn" id="btn-cancel-epics" style="${state.editMode.epics ? '' : 'display:none;'}">Cancel</button>
                ${deleteBtn}
            </div>
        `;

        // Edit / Save / Cancel — target _epicPreviewFilePath (the subtask file), not the epic
        const btnEdit = document.getElementById('btn-edit-epics');
        const btnCancel = document.getElementById('btn-cancel-epics');
        const btnSave = document.getElementById('btn-save-epics');
        if (btnEdit) btnEdit.addEventListener('click', () => enterEditMode('epics'));
        if (btnCancel) btnCancel.addEventListener('click', () => exitEditMode('epics'));
        if (btnSave) {
            btnSave.addEventListener('click', () => {
                const filePath = _epicPreviewFilePath;
                const content = epicsEditor ? epicsEditor.value : '';
                const originalContent = state.editOriginalContent.epics;
                if (filePath) {
                    vscode.postMessage({
                        type: 'saveFileContent',
                        filePath,
                        content,
                        originalContent,
                        tab: 'epics'
                    });
                }
            });
        }

        // Complexity dropdown toggle (mirror kanban pattern, project.js:1485-1498)
        if (hasPlanId) {
            const compToggle = document.getElementById('epic-subtask-meta-complexity');
            const compSelect = document.getElementById('epic-subtask-meta-complexity-select');
            if (compToggle && compSelect) {
                compToggle.addEventListener('click', e => {
                    e.stopPropagation();
                    compSelect.style.display = 'block';
                    compSelect.focus();
                });
                compSelect.addEventListener('change', () => {
                    compSelect.style.display = 'none';
                    vscode.postMessage({ type: 'setKanbanPlanComplexity', planId: compSelect.dataset.planId, complexity: compSelect.value, workspaceRoot: compSelect.dataset.workspaceRoot });
                });
                compSelect.addEventListener('blur', () => setTimeout(() => compSelect.style.display = 'none', 200));
            }

            // Delete (mirror kanban pattern, project.js:1504-1506)
            const delBtn = document.getElementById('epic-subtask-meta-delete-btn');
            if (delBtn) {
                delBtn.addEventListener('click', () => {
                    vscode.postMessage({ type: 'deleteKanbanPlan', planId: plan.planId, planFile: plan.planFile, workspaceRoot: plan.workspaceRoot });
                    _epicSubtaskPreview = null;
                    _epicPreviewFilePath = _epicSelectedPlan ? _epicSelectedPlan.planFile : null;
                    if (epicsPreviewContent) epicsPreviewContent.innerHTML = '<div class="kanban-empty-state">Select an epic to preview</div>';
                    if (_epicSelectedPlan) renderEpicMetaBar(_epicSelectedPlan);
                    else metaBar.style.display = 'none';
                });
            }
        }
    }

    function renderEpicSubtasks(epic, subtasks) {
        const subtasksDiv = document.getElementById(`subtasks-${epic.planId}`);
        if (!subtasksDiv) return;
        if (subtasks.length === 0) {
            subtasksDiv.innerHTML = '<div style="color:var(--text-secondary); font-style:italic;">No subtasks added yet.</div>';
            return;
        }
        subtasksDiv.innerHTML = subtasks.map(st => `
            <div class="epic-subtask-item">
                <span class="epic-subtask-link" data-plan-file="${escapeHtml(st.planFile || '')}" style="cursor: pointer; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">• ${escapeHtml(st.topic)} (${escapeHtml(st.kanbanColumn)})</span>
                <button class="epic-remove-subtask-btn" data-subtask-session="${escapeHtml(st.sessionId || st.planId)}" data-workspace-root="${escapeHtml(epic.workspaceRoot)}">Remove</button>
            </div>
        `).join('');

        // Wire subtask click → preview
        subtasksDiv.querySelectorAll('.epic-subtask-link').forEach(link => {
            link.addEventListener('click', e => {
                e.stopPropagation();
                const planFile = link.dataset.planFile;
                if (!planFile) {
                    showToast('This subtask has no plan file to preview.', 'error');
                    return;
                }
                if (state.editMode.epics) exitEditMode('epics');
                _epicPreviewFilePath = planFile;
                _epicSubtaskPreview = _kanbanPlansCache.find(p => p.planFile === planFile) || { planFile, planId: '', workspaceRoot: '', complexity: 'Unknown' };
                renderEpicSubtaskMetaBar(_epicSubtaskPreview);
                if (epicsPreviewContent) epicsPreviewContent.innerHTML = '<div class="kanban-empty-state">Loading preview...</div>';
                vscode.postMessage({
                    type: 'fetchKanbanPlanPreview',
                    filePath: planFile,
                    requestId: ++_kanbanPreviewRequestId
                });
            });
        });

        subtasksDiv.querySelectorAll('.epic-remove-subtask-btn').forEach(btn => {
            btn.addEventListener('click', e => {
                e.stopPropagation();
                vscode.postMessage({
                    type: 'removeSubtaskFromEpic',
                    subtaskSessionId: btn.dataset.subtaskSession,
                    workspaceRoot: btn.dataset.workspaceRoot
                });
            });
        });
    }

    // ---- Add subtask to epic (Epics-tab) ----
    function openEpicAddSubtaskOverlay() {
        if (!_epicSelectedPlan) return;
        const ov = document.getElementById('epic-add-subtask-overlay');
        const select = document.getElementById('epic-add-subtask-select');
        if (!ov || !select) return;
        // Candidates: plans in the same workspace that are not epics and not already a subtask.
        const epicWs = _epicSelectedPlan.workspaceRoot;
        const candidates = _kanbanPlansCache.filter(p =>
            !p.isEpic && !p.epicId && p.workspaceRoot === epicWs &&
            (p.planId !== _epicSelectedPlan.planId));
        select.innerHTML = '<option value="">Select a plan…</option>' + candidates.map(p =>
            `<option value="${escapeHtml(p.sessionId || p.planId)}">${escapeHtml(p.topic)}</option>`).join('');
        if (candidates.length === 0) {
            select.innerHTML = '<option value="">No eligible plans in this workspace</option>';
        }
        ov.style.display = 'flex';
    }

    function closeEpicAddSubtaskOverlay() {
        const ov = document.getElementById('epic-add-subtask-overlay');
        if (ov) ov.style.display = 'none';
    }

    document.getElementById('btn-epic-add-subtask-cancel')?.addEventListener('click', closeEpicAddSubtaskOverlay);
    document.getElementById('btn-epic-add-subtask-submit')?.addEventListener('click', () => {
        const select = document.getElementById('epic-add-subtask-select');
        const subtaskSessionId = select ? select.value : '';
        if (!subtaskSessionId || !_epicSelectedPlan) { closeEpicAddSubtaskOverlay(); return; }
        vscode.postMessage({
            type: 'addSubtaskToEpic',
            epicSessionId: _epicSelectedPlan.sessionId || _epicSelectedPlan.planId,
            subtaskSessionId,
            workspaceRoot: _epicSelectedPlan.workspaceRoot
        });
        closeEpicAddSubtaskOverlay();
    });

    if (epicsWorkspaceFilter) {
        epicsWorkspaceFilter.addEventListener('change', () => {
            epicsFilters.workspaceRoot = epicsWorkspaceFilter.value;
            renderEpicsList();
        });
    }

    if (epicsColumnFilter) {
        epicsColumnFilter.addEventListener('change', () => {
            epicsFilters.column = epicsColumnFilter.value;
            renderEpicsList();
        });
    }



    // =========================================================================
    // CONSTITUTION TAB
    // =========================================================================
    // The governance tabs (Constitution, System) follow the Kanban/Epics pattern:
    // the workspace dropdown is a pure filter, and the sidebar lists the DOCS. Each
    // sidebar row is one governance file — Constitution lists its single file per
    // workspace; System lists CLAUDE.md and AGENTS.md per workspace.

    function buildSidebarToggleRow(collapsed) {
        const toggleRow = document.createElement('div');
        toggleRow.className = 'sidebar-toggle-row';
        const toggleBtn = document.createElement('button');
        toggleBtn.className = 'sidebar-toggle-btn';
        toggleBtn.title = 'Toggle sidebar';
        toggleBtn.textContent = collapsed ? '»' : '«';
        toggleBtn.addEventListener('click', toggleSidebarCollapsed);
        toggleRow.appendChild(toggleBtn);
        return toggleRow;
    }

    // One doc row: doc name on top, workspace label + existence marker below.
    function buildGovDocRow(className, title, ws, exists, selected, onClick) {
        const itemDiv = document.createElement('div');
        itemDiv.className = className;
        itemDiv.dataset.ws = ws.workspaceRoot;
        if (selected) itemDiv.classList.add('selected');
        const marker = exists
            ? '<span style="color: var(--accent-teal); font-weight: bold;">✓</span>'
            : '<span style="color: var(--text-secondary); opacity: 0.5;">•</span>';
        itemDiv.innerHTML = `
            <div style="font-weight: 500;">${escapeHtml(title)}</div>
            <div style="font-size: 11px; color: var(--text-secondary); margin-top: 4px;">${escapeHtml(ws.label)} &nbsp;${marker}</div>
        `;
        itemDiv.addEventListener('click', onClick);
        return itemDiv;
    }

    function filteredGovWorkspaces(filter) {
        return filter
            ? _constitutionWorkspaces.filter(w => w.workspaceRoot === filter)
            : _constitutionWorkspaces;
    }

    function populateGovernanceFilters() {
        const fill = (sel, current) => {
            if (!sel) return;
            sel.innerHTML = '';
            const allOpt = document.createElement('option');
            allOpt.value = '';
            allOpt.textContent = 'All Workspaces';
            sel.appendChild(allOpt);
            _constitutionWorkspaces.forEach(ws => {
                const opt = document.createElement('option');
                opt.value = ws.workspaceRoot;
                opt.textContent = ws.label;
                sel.appendChild(opt);
            });
            sel.value = current || '';
        };
        fill(constitutionWorkspaceFilter, _constitutionWsFilter);
        fill(systemWorkspaceFilter, _systemWsFilter);
    }

    // =========================================================================
    // CONSTITUTION TAB
    // =========================================================================
    function renderConstitutionDocList() {
        if (!constitutionListPane) return;
        constitutionListPane.innerHTML = '';
        constitutionListPane.appendChild(buildSidebarToggleRow(state.constitutionListCollapsed));

        if (_constitutionWorkspaces.length === 0) {
            const emptyState = document.createElement('div');
            emptyState.className = 'empty-state';
            emptyState.textContent = 'No workspaces open';
            constitutionListPane.appendChild(emptyState);
            return;
        }

        const wss = filteredGovWorkspaces(_constitutionWsFilter);
        wss.forEach(ws => {
            const selected = _constitutionSelectedWorkspace
                && _constitutionSelectedWorkspace.workspaceRoot === ws.workspaceRoot;
            const row = buildGovDocRow('constitution-file-item', 'Constitution', ws,
                govExists(ws, 'constitution'), selected, () => {
                    if (state.dirtyFlags.constitution) exitEditMode('constitution');
                    constitutionListPane.querySelectorAll('.constitution-file-item')
                        .forEach(el => el.classList.remove('selected'));
                    row.classList.add('selected');
                    selectConstitutionDoc(ws);
                });
            constitutionListPane.appendChild(row);
        });

        // Auto-select the first visible doc when the current selection isn't shown.
        const rows = constitutionListPane.querySelectorAll('.constitution-file-item');
        const stillVisible = _constitutionSelectedWorkspace
            && [...rows].some(r => r.dataset.ws === _constitutionSelectedWorkspace.workspaceRoot);
        if (!stillVisible && rows.length > 0) {
            rows[0].classList.add('selected');
            selectConstitutionDoc(wss[0]);
        }
    }

    if (constitutionWorkspaceFilter) {
        constitutionWorkspaceFilter.addEventListener('change', () => {
            if (state.dirtyFlags.constitution) exitEditMode('constitution');
            _constitutionWsFilter = constitutionWorkspaceFilter.value;
            renderConstitutionDocList();
        });
    }

    function selectConstitutionDoc(ws) {
        _constitutionSelectedWorkspace = ws;
        if (constitutionPreviewContent) constitutionPreviewContent.innerHTML = '<div class="empty-state">Loading...</div>';
        vscode.postMessage({
            type: 'readConstitutionFile',
            workspaceRoot: ws.workspaceRoot,
            governanceFile: _constitutionSelectedGovKey
        });
        vscode.postMessage({
            type: 'getConstitutionPaths',
            workspaceRoot: ws.workspaceRoot
        });
    }

    // =========================================================================
    // SYSTEM TAB
    // =========================================================================
    const SYSTEM_DOCS = [
        { key: 'claude', title: 'CLAUDE.md' },
        { key: 'agents', title: 'AGENTS.md' }
    ];

    function renderSystemDocList() {
        if (!systemListPane) return;
        systemListPane.innerHTML = '';
        systemListPane.appendChild(buildSidebarToggleRow(state.systemListCollapsed));

        if (_constitutionWorkspaces.length === 0) {
            const emptyState = document.createElement('div');
            emptyState.className = 'empty-state';
            emptyState.textContent = 'No workspaces open';
            systemListPane.appendChild(emptyState);
            return;
        }

        const wss = filteredGovWorkspaces(_systemWsFilter);
        wss.forEach(ws => {
            SYSTEM_DOCS.forEach(doc => {
                const selected = _systemSelectedWorkspace
                    && _systemSelectedWorkspace.workspaceRoot === ws.workspaceRoot
                    && _systemSelectedGovKey === doc.key;
                const row = buildGovDocRow('system-file-item', doc.title, ws,
                    govExists(ws, doc.key), selected, () => {
                        if (state.dirtyFlags.system) exitEditMode('system');
                        systemListPane.querySelectorAll('.system-file-item')
                            .forEach(el => el.classList.remove('selected'));
                        row.classList.add('selected');
                        selectSystemDoc(ws, doc.key);
                    });
                row.dataset.gov = doc.key;
                systemListPane.appendChild(row);
            });
        });

        // Auto-select the first visible doc when the current selection isn't shown.
        const rows = systemListPane.querySelectorAll('.system-file-item');
        const stillVisible = _systemSelectedWorkspace && [...rows].some(r =>
            r.dataset.ws === _systemSelectedWorkspace.workspaceRoot && r.dataset.gov === _systemSelectedGovKey);
        if (!stillVisible && rows.length > 0) {
            const first = rows[0];
            first.classList.add('selected');
            const firstWs = _constitutionWorkspaces.find(w => w.workspaceRoot === first.dataset.ws);
            if (firstWs) selectSystemDoc(firstWs, first.dataset.gov);
        }
    }

    if (systemWorkspaceFilter) {
        systemWorkspaceFilter.addEventListener('change', () => {
            if (state.dirtyFlags.system) exitEditMode('system');
            _systemWsFilter = systemWorkspaceFilter.value;
            renderSystemDocList();
        });
    }

    function selectSystemDoc(ws, govKey) {
        _systemSelectedWorkspace = ws;
        _systemSelectedGovKey = govKey;
        if (systemPreviewContent) systemPreviewContent.innerHTML = '<div class="empty-state">Loading...</div>';
        vscode.postMessage({
            type: 'readConstitutionFile',
            workspaceRoot: ws.workspaceRoot,
            governanceFile: govKey
        });
    }

    if (btnBuildViaPlanner) {
        btnBuildViaPlanner.addEventListener('click', () => {
            vscode.postMessage({ type: 'invokeConstitutionBuilder', workspaceRoot: _constitutionSelectedWorkspace.workspaceRoot });
        });
    }

    if (btnCopyBuildPrompt) {
        btnCopyBuildPrompt.addEventListener('click', () => {
            vscode.postMessage({ type: 'copyConstitutionPrompt', workspaceRoot: _constitutionSelectedWorkspace.workspaceRoot });
        });
    }

    if (btnUpdateViaPlanner) {
        btnUpdateViaPlanner.addEventListener('click', () => {
            vscode.postMessage({ type: 'invokeConstitutionUpdater', workspaceRoot: _constitutionSelectedWorkspace.workspaceRoot });
        });
    }

    if (btnCopyUpdatePrompt) {
        btnCopyUpdatePrompt.addEventListener('click', () => {
            vscode.postMessage({ type: 'copyConstitutionUpdatePrompt', workspaceRoot: _constitutionSelectedWorkspace.workspaceRoot });
        });
    }

    if (btnEnableConstitution) {
        btnEnableConstitution.addEventListener('click', () => {
            const isCurrentlyEnabled = btnEnableConstitution.dataset.enabled === 'true';
            vscode.postMessage({ type: 'toggleConstitutionAddon', enabled: !isCurrentlyEnabled });
        });
    }

    if (btnDisableConstitution) {
        btnDisableConstitution.addEventListener('click', () => {
            vscode.postMessage({ type: 'toggleConstitutionAddon', enabled: false });
        });
    }

    if (btnDeleteConstitution) {
        btnDeleteConstitution.addEventListener('click', () => {
            vscode.postMessage({
                type: 'deleteConstitutionFile',
                workspaceRoot: _constitutionSelectedWorkspace.workspaceRoot,
                governanceFile: _constitutionSelectedGovKey
            });
        });
    }

    function openConstitutionPathsModal() {
        if (!_constitutionSelectedWorkspace) return;
        constitutionPathsModal.style.display = 'flex';
        vscode.postMessage({ type: 'getConstitutionPaths', workspaceRoot: _constitutionSelectedWorkspace.workspaceRoot });
    }
    if (btnManageConstitutionPaths) btnManageConstitutionPaths.addEventListener('click', openConstitutionPathsModal);
    if (activeConstitutionPathBtn) activeConstitutionPathBtn.addEventListener('click', openConstitutionPathsModal);
    document.getElementById('btn-close-constitution-paths-modal')?.addEventListener('click', () => {
        constitutionPathsModal.style.display = 'none';
    });
    document.getElementById('btn-add-constitution-path-modal')?.addEventListener('click', () => {
        if (!_constitutionSelectedWorkspace) return;
        vscode.postMessage({ type: 'addConstitutionPath', workspaceRoot: _constitutionSelectedWorkspace.workspaceRoot });
    });

    function renderConstitutionPathsModal(payload) {
        const list = document.getElementById('constitution-paths-list-modal');
        const paths = (payload && payload.paths) || [];
        const active = payload && payload.active;
        // Sidebar active-path button
        if (activeConstitutionPathBtn) {
            if (active) {
                activeConstitutionPathBtn.textContent = '📄 ' + active;
                activeConstitutionPathBtn.style.display = 'block';
            } else {
                activeConstitutionPathBtn.style.display = 'none';
            }
        }
        if (!list) return;
        list.innerHTML = '';
        if (paths.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'folder-list-empty';
            empty.textContent = 'No paths configured.';
            list.appendChild(empty);
            return;
        }
        paths.forEach(rel => {
            const row = document.createElement('div');
            row.className = 'folder-list-item';
            const label = document.createElement('span');
            label.className = 'folder-path';
            label.textContent = rel + (rel === active ? '  (active)' : '');
            const actions = document.createElement('div');
            actions.className = 'section-actions';
            if (rel !== active) {
                const activateBtn = document.createElement('button');
                activateBtn.className = 'strip-btn';
                activateBtn.textContent = 'Activate';
                activateBtn.addEventListener('click', () => {
                    vscode.postMessage({ type: 'setConstitutionPath', workspaceRoot: _constitutionSelectedWorkspace.workspaceRoot, relativePath: rel });
                });
                actions.appendChild(activateBtn);
            }
            const removeBtn = document.createElement('button');
            removeBtn.className = 'folder-list-remove-btn';
            removeBtn.textContent = 'Remove';
            removeBtn.addEventListener('click', () => {
                vscode.postMessage({ type: 'removeConstitutionPath', workspaceRoot: _constitutionSelectedWorkspace.workspaceRoot, relativePath: rel });
            });
            actions.appendChild(removeBtn);
            row.appendChild(label);
            row.appendChild(actions);
            list.appendChild(row);
        });
    }

    // =========================================================================
    // EDIT & SAVE LOGIC
    // =========================================================================
    function enterEditMode(tab) {
        const previewPane = document.getElementById(`${tab}-preview-pane`);
        const textarea = document.getElementById(`${tab}-editor`);
        const btnEdit = document.getElementById(`btn-edit-${tab}`);
        const btnSave = document.getElementById(`btn-save-${tab}`);
        const btnCancel = document.getElementById(`btn-cancel-${tab}`);

        if (!previewPane || !textarea) return;

        textarea.value = state.editOriginalContent[tab] || '';
        previewPane.classList.add('edit-mode');

        if (window.SwitchboardMarkdownEditor) {
            window.SwitchboardMarkdownEditor.attach(textarea, {
                renderPreview: (markdown) => {
                    return new Promise((resolve, reject) => {
                        const requestId = Date.now() + Math.random();
                        const handler = (event) => {
                            const msg = event.data;
                            if (msg.type === 'markdownLiveRendered' && msg.requestId === requestId) {
                                window.removeEventListener('message', handler);
                                if (msg.error) {
                                    reject(msg.error);
                                } else {
                                    resolve(msg.html || msg.htmlContent || '');
                                }
                            }
                        };
                        window.addEventListener('message', handler);
                        vscode.postMessage({
                            type: 'renderMarkdownLive',
                            requestId,
                            content: markdown
                        });
                    });
                }
            });
        }

        if (btnEdit) btnEdit.style.display = 'none';
        if (btnSave) btnSave.style.display = '';
        if (btnCancel) btnCancel.style.display = '';

        state.editMode[tab] = true;
        state.dirtyFlags[tab] = false;
    }

    function exitEditMode(tab) {
        const previewPane = document.getElementById(`${tab}-preview-pane`);
        const btnEdit = document.getElementById(`btn-edit-${tab}`);
        const btnSave = document.getElementById(`btn-save-${tab}`);
        const btnCancel = document.getElementById(`btn-cancel-${tab}`);

        if (previewPane) previewPane.classList.remove('edit-mode');

        if (btnEdit) btnEdit.style.display = '';
        if (btnSave) btnSave.style.display = 'none';
        if (btnCancel) btnCancel.style.display = 'none';

        state.editMode[tab] = false;
        state.dirtyFlags[tab] = false;
    }

    // Wire up "+ New Epic" and Modal
    if (btnNewEpic && newEpicModal) {
        btnNewEpic.addEventListener('click', () => {
            if (newEpicName) newEpicName.value = '';
            if (newEpicDescription) newEpicDescription.value = '';
            newEpicModal.style.display = 'flex';
            if (newEpicName) newEpicName.focus();
        });
    }

    if (btnNewEpicCancel && newEpicModal) {
        btnNewEpicCancel.addEventListener('click', () => {
            newEpicModal.style.display = 'none';
        });
    }

    if (btnNewEpicSubmit && newEpicModal) {
        btnNewEpicSubmit.addEventListener('click', () => {
            const name = newEpicName ? newEpicName.value.trim() : '';
            const description = newEpicDescription ? newEpicDescription.value.trim() : '';
            if (!name) {
                showToast('Epic name is required.', 'error');
                return;
            }
            vscode.postMessage({
                type: 'createEpic',
                name,
                description,
                workspaceRoot: epicsFilters.workspaceRoot,
                subtaskPlanIds: [],
                addToKanbanBoard: true
            });
            newEpicModal.style.display = 'none';
        });
    }

    // Editor dirty state input listeners
    if (kanbanEditor) {
        kanbanEditor.addEventListener('input', () => {
            state.dirtyFlags.kanban = true;
        });
    }
    if (epicsEditor) {
        epicsEditor.addEventListener('input', () => {
            state.dirtyFlags.epics = true;
        });
    }
    if (constitutionEditor) {
        constitutionEditor.addEventListener('input', () => {
            state.dirtyFlags.constitution = true;
        });
    }
    if (systemEditor) {
        systemEditor.addEventListener('input', () => {
            state.dirtyFlags.system = true;
        });
    }

    if (btnEditConstitution) btnEditConstitution.addEventListener('click', () => enterEditMode('constitution'));
    if (btnCancelConstitution) btnCancelConstitution.addEventListener('click', () => exitEditMode('constitution'));
    if (btnSaveConstitution) {
        btnSaveConstitution.addEventListener('click', () => {
            if (!_constitutionSelectedWorkspace) return;
            const content = constitutionEditor ? constitutionEditor.value : '';
            const originalContent = state.editOriginalContent.constitution;
            vscode.postMessage({
                type: 'saveConstitutionFile',
                workspaceRoot: _constitutionSelectedWorkspace.workspaceRoot,
                content,
                originalContent,
                governanceFile: _constitutionSelectedGovKey
            });
        });
    }

    if (btnEditSystem) btnEditSystem.addEventListener('click', () => enterEditMode('system'));
    if (btnCancelSystem) btnCancelSystem.addEventListener('click', () => exitEditMode('system'));
    if (btnSaveSystem) {
        btnSaveSystem.addEventListener('click', () => {
            if (!_systemSelectedWorkspace) return;
            const content = systemEditor ? systemEditor.value : '';
            const originalContent = state.editOriginalContent.system;
            vscode.postMessage({
                type: 'saveConstitutionFile',
                workspaceRoot: _systemSelectedWorkspace.workspaceRoot,
                content,
                originalContent,
                governanceFile: _systemSelectedGovKey
            });
        });
    }
    if (btnDeleteSystem) {
        btnDeleteSystem.addEventListener('click', () => {
            vscode.postMessage({
                type: 'deleteConstitutionFile',
                workspaceRoot: _systemSelectedWorkspace.workspaceRoot,
                governanceFile: _systemSelectedGovKey
            });
        });
    }
    if (btnBuildSystem) {
        btnBuildSystem.addEventListener('click', () => {
            if (!_systemSelectedWorkspace) return;
            vscode.postMessage({
                type: 'invokeSystemBuilder',
                workspaceRoot: _systemSelectedWorkspace.workspaceRoot,
                governanceFile: _systemSelectedGovKey,
            });
        });
    }
    if (btnCopySystemPrompt) {
        btnCopySystemPrompt.addEventListener('click', () => {
            if (!_systemSelectedWorkspace) return;
            vscode.postMessage({
                type: 'copySystemBuildPrompt',
                workspaceRoot: _systemSelectedWorkspace.workspaceRoot,
                governanceFile: _systemSelectedGovKey,
            });
        });
    }

    // Projects tab listeners
    if (btnEditProjects) btnEditProjects.addEventListener('click', () => enterEditMode('projects'));
    if (btnCancelProjects) btnCancelProjects.addEventListener('click', () => exitEditMode('projects'));
    if (btnSaveProjects) {
        btnSaveProjects.addEventListener('click', () => {
            if (!_selectedProjectName) return;
            const wsRoot = getProjectsTabWorkspaceRoot();
            if (!wsRoot) return;
            if (projectsPrdStatus) projectsPrdStatus.textContent = 'Saving…';
            vscode.postMessage({
                type: 'saveProjectPrd',
                projectName: _selectedProjectName,
                content: projectsEditor ? projectsEditor.value : '',
                workspaceRoot: wsRoot
            });
        });
    }
    if (projectsEditor) {
        projectsEditor.addEventListener('input', () => {
            state.dirtyFlags.projects = true;
            _prdDirty = true;
        });
    }
    if (btnBuildPrd) {
        btnBuildPrd.addEventListener('click', () => {
            if (!_selectedProjectName) return;
            vscode.postMessage({
                type: 'invokePrdBuilder',
                projectName: _selectedProjectName,
                workspaceRoot: getProjectsTabWorkspaceRoot()
            });
        });
    }
    if (btnCopyPrdPrompt) {
        btnCopyPrdPrompt.addEventListener('click', () => {
            if (!_selectedProjectName) return;
            vscode.postMessage({
                type: 'copyPrdBuildPrompt',
                projectName: _selectedProjectName,
                workspaceRoot: getProjectsTabWorkspaceRoot()
            });
        });
    }

    // Log Overlay helpers
    function showKanbanLogOverlay(entries) {
        let overlay = document.querySelector('.kanban-log-overlay');
        if (overlay) overlay.remove();

        overlay = document.createElement('div');
        overlay.className = 'kanban-log-overlay';
        const modal = document.createElement('div');
        modal.className = 'kanban-log-modal';
        const title = document.createElement('div');
        title.style.padding = '12px 16px';
        title.style.fontWeight = 'bold';
        title.style.borderBottom = '1px solid var(--border-color)';
        title.textContent = 'Plan Action Log';

        const entriesDiv = document.createElement('div');
        entriesDiv.className = 'kanban-log-entries';

        if (entries.length === 0) {
            entriesDiv.innerHTML = '<div style="color:var(--text-secondary); font-style:italic;">No log entries found.</div>';
        } else {
            entriesDiv.innerHTML = entries.map(e => `
                <div class="kanban-log-entry">
                    <span class="kanban-log-timestamp">[${escapeHtml(e.timestamp)}]</span>
                    <span class="kanban-log-workflow">${escapeHtml(e.workflow)}</span><br>
                    <span>${escapeHtml(e.details)}</span>
                </div>
            `).join('');
        }

        const closeRow = document.createElement('div');
        closeRow.className = 'kanban-log-close';
        const closeBtn = document.createElement('button');
        closeBtn.className = 'strip-btn';
        closeBtn.textContent = 'Close';
        closeBtn.addEventListener('click', () => overlay.remove());
        closeRow.appendChild(closeBtn);

        modal.appendChild(title);
        modal.appendChild(entriesDiv);
        modal.appendChild(closeRow);
        overlay.appendChild(modal);
        document.body.appendChild(overlay);
    }

    // Helpers
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

    // =========================================================================
    // TUNING TAB
    // =========================================================================
    let _tuningInsights = [];
    let _tuningSelectedInsight = null;
    let _tuningSelectedWorkspaceRoot = '';

    function renderInsightList(insights) {
        if (!tuningListPane) return;
        tuningListPane.innerHTML = '';

        const toggleRow = document.createElement('div');
        toggleRow.className = 'sidebar-toggle-row';
        const toggleBtn = document.createElement('button');
        toggleBtn.className = 'sidebar-toggle-btn';
        toggleBtn.title = 'Toggle sidebar';
        toggleBtn.textContent = state.tuningListCollapsed ? '»' : '«';
        toggleBtn.addEventListener('click', toggleSidebarCollapsed);
        toggleRow.appendChild(toggleBtn);
        tuningListPane.appendChild(toggleRow);

        const filterValue = tuningInsightFilter ? tuningInsightFilter.value : '';
        const filtered = filterValue ? insights.filter(i => i.status === filterValue) : insights;

        if (filtered.length === 0) {
            const emptyState = document.createElement('div');
            emptyState.className = 'empty-state';
            emptyState.textContent = 'No insights yet. Run "Extract Insights" to scan reviewed plans.';
            tuningListPane.appendChild(emptyState);
            return;
        }

        const isAllWorkspaces = !tuningWorkspaceFilter || !tuningWorkspaceFilter.value;

        filtered.forEach(insight => {
            const itemDiv = document.createElement('div');
            itemDiv.className = 'insight-item';
            if (_tuningSelectedInsight === insight.filename && _tuningSelectedWorkspaceRoot === insight.workspaceRoot) {
                itemDiv.classList.add('selected');
            }

            const severityColor = insight.severity === 'critical' ? '#ff6b6b' : insight.severity === 'recurring' ? 'var(--accent-orange)' : 'var(--text-secondary)';
            const statusColor = insight.status === 'open' ? 'var(--accent-teal)' : insight.status === 'applied' ? '#4ec9b0' : 'var(--text-secondary)';
            const workspaceLabel = isAllWorkspaces && insight.workspaceRoot ? `<div style="font-size: 10px; color: var(--text-secondary); margin-top: 2px;">${escapeHtml(insight.workspaceRoot.split('/').pop())}</div>` : '';

            itemDiv.innerHTML = `
                <div style="font-weight: 500;">${escapeHtml(insight.title)}</div>
                <div style="font-size: 11px; margin-top: 4px; display: flex; gap: 8px; align-items: center;">
                    <span style="color: ${severityColor};">● ${escapeHtml(insight.severity)}</span>
                    <span style="color: ${statusColor};">● ${escapeHtml(insight.status)}</span>
                    <span style="color: var(--text-secondary);">${insight.sourcePlans.length} source${insight.sourcePlans.length !== 1 ? 's' : ''}</span>
                </div>
                ${workspaceLabel}
            `;

            itemDiv.dataset.workspaceRoot = insight.workspaceRoot || '';
            itemDiv.addEventListener('click', () => {
                document.querySelectorAll('.insight-item').forEach(el => el.classList.remove('selected'));
                itemDiv.classList.add('selected');
                selectInsight(insight.filename, insight.workspaceRoot);
            });

            tuningListPane.appendChild(itemDiv);
        });
    }

    function selectInsight(filename, workspaceRoot) {
        vscode.postMessage({ type: 'readInsight', filename, workspaceRoot: workspaceRoot || '' });
    }

    if (tuningWorkspaceFilter) {
        tuningWorkspaceFilter.addEventListener('change', () => {
            vscode.postMessage({ type: 'loadInsights', workspaceRoot: tuningWorkspaceFilter.value });
        });
    }

    if (tuningInsightFilter) {
        tuningInsightFilter.addEventListener('change', () => {
            renderInsightList(_tuningInsights);
        });
    }

    if (btnRunTuningExtract) {
        btnRunTuningExtract.addEventListener('click', () => {
            vscode.postMessage({ type: 'runTuningExtract', workspaceRoot: tuningWorkspaceFilter ? tuningWorkspaceFilter.value : '' });
        });
    }

    if (btnRunTuningGovernance) {
        btnRunTuningGovernance.addEventListener('click', () => {
            vscode.postMessage({ type: 'runTuningGovernance', workspaceRoot: tuningWorkspaceFilter ? tuningWorkspaceFilter.value : '' });
        });
    }

    if (btnRefreshInsights) {
        btnRefreshInsights.addEventListener('click', () => {
            vscode.postMessage({ type: 'loadInsights', workspaceRoot: tuningWorkspaceFilter ? tuningWorkspaceFilter.value : '' });
        });
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

    // =========================================================================
    // DEV DOCS TAB — developer documentation authored here; synced (with PRDs +
    // constitution) to Notion/Linear as the remote agent's planning context.
    // Stored per-workspace at .switchboard/devdocs/<slug>.md.
    // =========================================================================
    function renderDevDocsList() {
        if (!devdocsListPane) return;
        devdocsListPane.innerHTML = '';
        devdocsListPane.appendChild(buildSidebarToggleRow(state.devdocsListCollapsed));

        const docs = _devDocsWsFilter
            ? _devDocs.filter(d => d.workspaceRoot === _devDocsWsFilter)
            : _devDocs;

        if (docs.length === 0) {
            const emptyState = document.createElement('div');
            emptyState.className = 'empty-state';
            emptyState.textContent = 'No dev docs yet. Use "+ New Doc" to create one.';
            devdocsListPane.appendChild(emptyState);
            return;
        }

        docs.forEach(doc => {
            const row = document.createElement('div');
            row.className = 'system-file-item';
            if (_devDocSelected && _devDocSelected.path === doc.path) row.classList.add('selected');
            row.dataset.path = doc.path;
            const wsLabel = !_devDocsWsFilter && doc.workspaceLabel
                ? `<div style="font-size:10px; color:var(--text-secondary); margin-top:2px;">${escapeHtml(doc.workspaceLabel)}</div>`
                : '';
            row.innerHTML = `<div style="font-weight:500;">${escapeHtml(doc.title || doc.fileName)}</div>${wsLabel}`;
            row.addEventListener('click', () => {
                if (state.dirtyFlags.devdocs) exitEditMode('devdocs');
                devdocsListPane.querySelectorAll('.system-file-item').forEach(el => el.classList.remove('selected'));
                row.classList.add('selected');
                selectDevDoc(doc);
            });
            devdocsListPane.appendChild(row);
        });

        // Auto-select the first visible doc when the current selection isn't shown.
        const stillVisible = _devDocSelected && docs.some(d => d.path === _devDocSelected.path);
        if (!stillVisible && docs.length > 0) {
            const first = devdocsListPane.querySelector('.system-file-item');
            if (first) first.classList.add('selected');
            selectDevDoc(docs[0]);
        }
    }

    function selectDevDoc(doc) {
        _devDocSelected = doc;
        if (devdocsPreviewContent) devdocsPreviewContent.innerHTML = '<div class="empty-state">Loading...</div>';
        vscode.postMessage({ type: 'readDevDoc', path: doc.path, workspaceRoot: doc.workspaceRoot });
    }

    if (devdocsWorkspaceFilter) {
        devdocsWorkspaceFilter.addEventListener('change', () => {
            if (state.dirtyFlags.devdocs) exitEditMode('devdocs');
            _devDocsWsFilter = devdocsWorkspaceFilter.value;
            renderDevDocsList();
        });
    }
    if (devdocsEditor) {
        devdocsEditor.addEventListener('input', () => { state.dirtyFlags.devdocs = true; });
    }
    if (btnEditDevdocs) btnEditDevdocs.addEventListener('click', () => enterEditMode('devdocs'));
    if (btnCancelDevdocs) btnCancelDevdocs.addEventListener('click', () => exitEditMode('devdocs'));
    if (btnSaveDevdocs) {
        btnSaveDevdocs.addEventListener('click', () => {
            if (!_devDocSelected) return;
            if (devdocsStatus) devdocsStatus.textContent = 'Saving…';
            vscode.postMessage({
                type: 'saveDevDoc',
                path: _devDocSelected.path,
                workspaceRoot: _devDocSelected.workspaceRoot,
                content: devdocsEditor ? devdocsEditor.value : ''
            });
        });
    }
    if (btnDeleteDevdocs) {
        btnDeleteDevdocs.addEventListener('click', () => {
            if (!_devDocSelected) return;
            vscode.postMessage({ type: 'deleteDevDoc', path: _devDocSelected.path, workspaceRoot: _devDocSelected.workspaceRoot });
        });
    }

    const newDevdocModal = document.getElementById('new-devdoc-modal');
    if (btnCreateDevdoc && newDevdocModal) {
        btnCreateDevdoc.addEventListener('click', () => {
            const nameInput = document.getElementById('new-devdoc-name');
            if (nameInput) nameInput.value = '';
            const wsSelect = document.getElementById('new-devdoc-workspace');
            if (wsSelect) {
                const desired = _devDocsWsFilter
                    || (devdocsWorkspaceFilter && devdocsWorkspaceFilter.value)
                    || (_kanbanWorkspaceItems[0] && _kanbanWorkspaceItems[0].workspaceRoot) || '';
                if (desired) wsSelect.value = desired;
            }
            newDevdocModal.style.display = 'flex';
            if (nameInput) nameInput.focus();
        });
    }
    document.getElementById('btn-new-devdoc-cancel')?.addEventListener('click', () => {
        if (newDevdocModal) newDevdocModal.style.display = 'none';
    });
    document.getElementById('btn-new-devdoc-submit')?.addEventListener('click', () => {
        const nameInput = document.getElementById('new-devdoc-name');
        const wsSelect = document.getElementById('new-devdoc-workspace');
        const name = nameInput ? nameInput.value.trim() : '';
        const wsRoot = wsSelect ? wsSelect.value : '';
        if (!name) { showToast('Doc name is required.', 'error'); return; }
        if (!wsRoot) { showToast('Select a workspace.', 'error'); return; }
        vscode.postMessage({ type: 'createDevDoc', name, workspaceRoot: wsRoot });
        if (newDevdocModal) newDevdocModal.style.display = 'none';
    });

    // =========================================================================
    // REMOTE TAB (§10) — relocated from kanban.html. Config UI only; the kanban
    // toolbar keeps its own start/stop toggle. Backend calls are delegated by
    // PlanningPanelProvider to KanbanProvider so both webviews drive the same
    // per-workspace RemoteControlService instances.
    // =========================================================================
    function applyRemoteControlButtonState() {
        const btn = document.getElementById('btn-remote-control-toggle');
        if (btn) btn.textContent = remoteControlActive ? 'Stop Remote Control' : 'Start Remote Control';
        const stateEl = document.getElementById('remote-control-state');
        if (stateEl) stateEl.textContent = remoteControlActive ? 'Pinging…' : '';
    }

    function renderRemoteConfig(config, payload) {
        payload = payload || {};
        // Workspace dropdown
        const wsSel = document.getElementById('remote-workspace');
        if (wsSel && Array.isArray(payload.workspaces)) {
            wsSel.innerHTML = '';
            payload.workspaces.forEach(w => {
                const opt = document.createElement('option');
                opt.value = w.workspaceRoot;
                opt.textContent = w.label;
                if (w.active) opt.selected = true;
                wsSel.appendChild(opt);
            });
        }

        // Board checkboxes (base board '' rendered as "No Project")
        const list = document.getElementById('remote-boards-list');
        const boardKeys = Array.isArray(payload.boardKeys)
            ? payload.boardKeys
            : ['', ...((payload.projects) || [])];   // legacy fallback
        if (list) {
            const chosen = new Set((config && config.boards) || []);
            list.innerHTML = '';
            boardKeys.forEach(key => {
                const row = document.createElement('label');
                row.className = 'remote-checkbox-row';
                const cb = document.createElement('input');
                cb.type = 'checkbox';
                cb.value = key;                       // '' for the base board
                cb.checked = chosen.has(key);
                cb.dataset.role = 'remote-board';
                const span = document.createElement('span');
                span.textContent = key === '' ? 'No Project (base workspace board)' : key;
                row.appendChild(cb);
                row.appendChild(span);
                list.appendChild(row);
            });
        }

        if (config) {
            const providerEl = document.getElementById('remote-provider');
            if (providerEl) providerEl.value = config.provider === 'notion' ? 'notion' : 'linear';
            const silent = document.getElementById('remote-silent-sync');
            if (silent) silent.checked = config.silentSync === true;
            const freq = document.getElementById('remote-ping-frequency');
            if (freq) freq.value = config.pingFrequencySeconds || 60;
        }
        applyRemoteProviderUi();
    }

    function remoteCollectConfig() {
        const boards = Array.from(
            document.querySelectorAll('#remote-boards-list input[data-role="remote-board"]:checked')
        ).map(cb => cb.value);   // keeps '' — do NOT filter by truthiness
        const providerEl = document.getElementById('remote-provider');
        return {
            provider: providerEl && providerEl.value === 'notion' ? 'notion' : 'linear',
            boards,
            silentSync: document.getElementById('remote-silent-sync')?.checked === true,
            pingFrequencySeconds: Math.min(120, Math.max(30,
                parseInt(document.getElementById('remote-ping-frequency')?.value, 10) || 60)),
        };
    }

    // Show/hide the Notion-only setup block and keep the header in sync with the provider.
    function applyRemoteProviderUi() {
        const providerEl = document.getElementById('remote-provider');
        const provider = providerEl ? providerEl.value : 'linear';
        const setup = document.getElementById('remote-notion-setup');
        if (setup) setup.style.display = provider === 'notion' ? 'block' : 'none';
        const title = document.getElementById('remote-subsection-title');
        if (title) title.textContent = provider === 'notion' ? 'Remote Control (Notion)' : 'Remote Control (Linear)';
        // Linear-only: agent-skill copy button. Visible whenever the provider is
        // Linear — the backend answers with an error when mappings are missing,
        // which avoids a config-fetch round-trip just for visibility.
        const skillBlock = document.getElementById('remote-linear-agent-skill');
        if (skillBlock) skillBlock.style.display = provider === 'linear' ? 'block' : 'none';
    }

    function remoteAutosave() {
        const wsSel = document.getElementById('remote-workspace');
        const workspaceRoot = wsSel ? wsSel.value : undefined;
        const config = remoteCollectConfig();
        const statusEl = document.getElementById('remote-config-status');
        if (statusEl) statusEl.textContent = 'Saved.';
        vscode.postMessage({ type: 'setRemoteConfig', config, workspaceRoot });
    }

    // Autosave on any control change (delegated, so it covers dynamically-added checkboxes)
    document.getElementById('remote-content')?.addEventListener('change', (e) => {
        if (e.target.id === 'remote-workspace') {
            // Switching workspace: load THAT workspace's own config (no save).
            vscode.postMessage({ type: 'getRemoteConfig', workspaceRoot: e.target.value });
            vscode.postMessage({ type: 'getProjectContextSyncStatus', workspaceRoot: e.target.value });
            return;
        }
        if (e.target.id === 'remote-context-auto') {
            // Context-sync toggle is its own state blob, not part of RemoteConfig.
            const wsSel = document.getElementById('remote-workspace');
            vscode.postMessage({
                type: 'setProjectContextSyncEnabled',
                enabled: e.target.checked === true,
                workspaceRoot: (wsSel && wsSel.value) || undefined
            });
            return;
        }
        if (e.target.id === 'remote-provider') {
            applyRemoteProviderUi();
        }
        remoteAutosave();
    });
    document.getElementById('btn-context-sync-now')?.addEventListener('click', () => {
        const wsSel = document.getElementById('remote-workspace');
        const statusEl = document.getElementById('remote-context-status');
        if (statusEl) statusEl.textContent = 'Syncing…';
        vscode.postMessage({ type: 'projectContextSyncNow', workspaceRoot: (wsSel && wsSel.value) || undefined });
    });
    document.getElementById('btn-copy-linear-agent-skill')?.addEventListener('click', () => {
        const wsSel = document.getElementById('remote-workspace');
        vscode.postMessage({ type: 'copyLinearAgentSkill', workspaceRoot: (wsSel && wsSel.value) || undefined });
    });
    // Notion one-time setup sync (creates the plans + comments DBs, backs up boards).
    document.getElementById('btn-notion-remote-setup')?.addEventListener('click', () => {
        const wsSel = document.getElementById('remote-workspace');
        const statusEl = document.getElementById('remote-notion-setup-status');
        if (statusEl) statusEl.textContent = 'Running setup sync…';
        vscode.postMessage({ type: 'runNotionRemoteSetup', workspaceRoot: wsSel ? wsSel.value : undefined });
    });
    // Debounce the frequency text input so rapid keystrokes don't spam setRemoteConfig
    // (each call writes the DB config row and may reschedule the ping timer).
    let _remoteFreqTimer;
    document.getElementById('remote-ping-frequency')?.addEventListener('input', () => {
        clearTimeout(_remoteFreqTimer);
        _remoteFreqTimer = setTimeout(remoteAutosave, 400);
    });
    document.getElementById('btn-remote-control-toggle')?.addEventListener('click', () => {
        const wsSel = document.getElementById('remote-workspace');
        vscode.postMessage({
            type: remoteControlActive ? 'stopRemoteControl' : 'startRemoteControl',
            workspaceRoot: (wsSel && wsSel.value) || undefined
        });
    });

    // =========================================================================
    // NOTEBOOKLM TAB — relocated from planning.html. The backend cases
    // (airlock_*, importNotebookLMPlans) already live in PlanningPanelProvider,
    // shared by both panels; the workspace choice persists under 'notebook.root'.
    // =========================================================================
    function getNotebookWorkspaceRoot() {
        const sel = document.getElementById('notebook-workspace-filter');
        return (sel && sel.value)
            || _notebookWorkspaceRoot
            || (_kanbanWorkspaceItems[0] && _kanbanWorkspaceItems[0].workspaceRoot)
            || '';
    }

    function hydrateNotebookTab() {
        // Ensure workspace items are fresh, then restore the persisted selection once.
        vscode.postMessage({ type: 'fetchKanbanPlans', requestId: Date.now() });
        if (!_notebookHydrated) {
            _notebookHydrated = true;
            vscode.postMessage({ type: 'notebookDefaultRoot' });
        }
    }

    document.getElementById('notebook-workspace-filter')?.addEventListener('change', (e) => {
        _notebookWorkspaceRoot = e.target.value;
        vscode.postMessage({ type: 'persistTabState', tabKey: 'notebook.root', state: _notebookWorkspaceRoot });
    });

    document.getElementById('btn-bundle-code')?.addEventListener('click', () => {
        const btn = document.getElementById('btn-bundle-code');
        if (btn) { btn.disabled = true; btn.textContent = 'BUNDLING...'; }
        const statusEl = document.getElementById('webai-status');
        if (statusEl) statusEl.textContent = 'Bundling workspace code…';
        vscode.postMessage({ type: 'airlock_export', workspaceRoot: getNotebookWorkspaceRoot() });
    });

    document.getElementById('btn-open-notebooklm')?.addEventListener('click', () => {
        vscode.postMessage({ type: 'airlock_openNotebookLM', workspaceRoot: getNotebookWorkspaceRoot() });
    });

    document.getElementById('btn-open-airlock-folder')?.addEventListener('click', () => {
        vscode.postMessage({ type: 'airlock_openFolder', workspaceRoot: getNotebookWorkspaceRoot() });
    });

    document.getElementById('btn-copy-sprint-prompt')?.addEventListener('click', () => {
        const btn = document.getElementById('btn-copy-sprint-prompt');
        // Verbatim from the tab's previous planning.html home — behavior unchanged.
        const prompt = `Please analyze the uploaded codebase and generate sprint plans. Output each plan separated by this exact format:

--- PLAN ---
[plan 1 content here]

--- PLAN ---
[plan 2 content here]

--- PLAN ---
[plan 3 content here]

Each plan should have its own H1 title (# Plan Title) and full content. I will copy the entire block and import it into my planning system which will automatically split it into separate plan files.`;
        navigator.clipboard.writeText(prompt).then(() => {
            if (btn) {
                btn.textContent = 'COPIED';
                setTimeout(() => { btn.textContent = 'COPY SPRINT PROMPT'; }, 2000);
            }
        }).catch(() => {
            showToast('Copy failed — check console.', 'error');
        });
    });

    document.getElementById('btn-import-notebooklm-plans')?.addEventListener('click', () => {
        const btn = document.getElementById('btn-import-notebooklm-plans');
        if (btn) { btn.disabled = true; btn.textContent = 'IMPORTING...'; }
        const statusEl = document.getElementById('webai-status');
        if (statusEl) statusEl.textContent = 'Importing plans from clipboard…';
        vscode.postMessage({ type: 'importNotebookLMPlans', workspaceRoot: getNotebookWorkspaceRoot() });
    });

    // Initialize sidebar state on load
    applySidebarState('kanban', state.kanbanListCollapsed);
    applySidebarState('epics', state.epicsListCollapsed);
    applySidebarState('constitution', state.constitutionListCollapsed);
    applySidebarState('tuning', state.tuningListCollapsed);
    applySidebarState('devdocs', state.devdocsListCollapsed);

    // Bind global event listeners for any static toggle buttons
    // (Dynamic buttons created by render functions get their own listeners)
    document.querySelectorAll('.sidebar-toggle-btn').forEach(btn => {
        btn.addEventListener('click', toggleSidebarCollapsed);
    });
})();
