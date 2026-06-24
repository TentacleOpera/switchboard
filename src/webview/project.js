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
            }

            if (activeTab === 'kanban') {
                vscode.postMessage({ type: 'fetchKanbanPlans', requestId: Date.now() });
            } else if (activeTab === 'epics') {
                vscode.postMessage({ type: 'fetchKanbanPlans', requestId: Date.now() });
                vscode.postMessage({ type: 'fetchEpicDocuments' });
                updateActiveEpicBanner();
            } else if (activeTab === 'constitution') {
                vscode.postMessage({ type: 'loadConstitutionFiles' });
            } else if (activeTab === 'system') {
                vscode.postMessage({ type: 'loadConstitutionFiles' });
            } else if (activeTab === 'tuning') {
                vscode.postMessage({ type: 'loadInsights', workspaceRoot: tuningWorkspaceFilter ? tuningWorkspaceFilter.value : '' });
            }
        });
    });

    // Global state
    const state = {
        editMode: { kanban: false, constitution: false, epics: false, system: false },
        editOriginalContent: { kanban: null, constitution: null, epics: null, system: null },
        dirtyFlags: { kanban: false, constitution: false, epics: false, system: false },
        externalChangePending: { kanban: false, constitution: false, epics: false, system: false },
        reviewMode: { kanban: false },
        kanbanListCollapsed: false,
        epicsListCollapsed: false,
        constitutionListCollapsed: false,
        systemListCollapsed: false,
        tuningListCollapsed: false,
        switchboardTheme: 'afterburner'
    };

    // Initialize from persisted state
    const persistedState = vscode.getState() || {};
    state.kanbanListCollapsed = persistedState.kanbanListCollapsed || false;
    state.epicsListCollapsed = persistedState.epicsListCollapsed || false;
    state.constitutionListCollapsed = persistedState.constitutionListCollapsed || false;
    state.systemListCollapsed = persistedState.systemListCollapsed || false;
    state.tuningListCollapsed = persistedState.tuningListCollapsed || false;

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
        }

        // Persist state
        const currentPersisted = vscode.getState() || {};
        vscode.setState({
            ...currentPersisted,
            kanbanListCollapsed: state.kanbanListCollapsed,
            epicsListCollapsed: state.epicsListCollapsed,
            constitutionListCollapsed: state.constitutionListCollapsed,
            systemListCollapsed: state.systemListCollapsed,
            tuningListCollapsed: state.tuningListCollapsed
        });
    }

    function handleThemeChanged(theme) {
        if (theme) { state.switchboardTheme = theme; }
        document.body.classList.remove('theme-claudify', 'theme-afterburner-pro');
        if (state.switchboardTheme === 'afterburner') {
            document.body.classList.add('cyber-theme-enabled');
        } else {
            document.body.classList.remove('cyber-theme-enabled');
        }
        if (state.switchboardTheme === 'claudify') {
            document.body.classList.add('theme-claudify');
        } else if (state.switchboardTheme === 'afterburner-professional') {
            document.body.classList.add('theme-claudify', 'theme-afterburner-pro');
        }
    }

    let _kanbanPlansCache = [];
    let _kanbanAllWorkspaceProjects = {};
    let _kanbanWorkspaceItems = [];
    let _kanbanAvailableColumns = [];
    let _kanbanSelectedPlan = null;
    let _kanbanPreviewRequestId = 0;
    let uploadingPlanAttachment = false;

    let _epicSelectedPlan = null;
    let _epicDocumentsCache = [];
    let _pendingKanbanSelection = null;
    let _pendingAutoEdit = false;
    let _activeEpicName = 'None';
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
    const btnSetActiveEpic = document.getElementById('btn-set-active-epic');
    const btnNewEpic = document.getElementById('btn-new-epic');
    const newEpicModal = document.getElementById('new-epic-modal');
    const newEpicName = document.getElementById('new-epic-name');
    const newEpicDescription = document.getElementById('new-epic-description');
    const newEpicAddToKanban = document.getElementById('new-epic-add-to-kanban');
    const btnNewEpicCancel = document.getElementById('btn-new-epic-cancel');
    const btnNewEpicSubmit = document.getElementById('btn-new-epic-submit');
    const epicsListPane = document.getElementById('epics-list-pane');
    const epicsPreviewPane = document.getElementById('epics-preview-pane');
    const epicsPreviewContent = document.getElementById('epics-preview-content');
    const epicsEditor = document.getElementById('epics-editor');
    const activeEpicBanner = document.getElementById('active-epic-banner');
    const activeEpicNameSpan = document.getElementById('active-epic-name');
    const btnDisableEpic = document.getElementById('btn-disable-epic');

    const btnBuildViaPlanner = document.getElementById('btn-build-via-planner');
    const btnCopyBuildPrompt = document.getElementById('btn-copy-build-prompt');
    const btnUpdateViaPlanner = document.getElementById('btn-update-via-planner');
    const btnCopyUpdatePrompt = document.getElementById('btn-copy-update-prompt');
    const btnEnableConstitution = document.getElementById('btn-enable-constitution');
    const btnDeleteConstitution = document.getElementById('btn-delete-constitution');
    const btnSetConstitutionPath = document.getElementById('btn-set-constitution-path');
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

    const kanbanFilters = { column: '', workspaceRoot: '', project: '', search: '' };
    const epicsFilters = { workspaceRoot: '' };

    // Initialize Webview Content
    vscode.postMessage({ type: 'fetchKanbanPlans', requestId: Date.now() });

    // Webview message handler
    window.addEventListener('message', async event => {
        const msg = event.data;
        switch (msg.type) {
            case 'switchboardThemeNameSetting':
            case 'switchboardThemeChanged':
                handleThemeChanged(msg.theme);
                break;
            case 'kanbanPlansReady':
                if (btnCreateKanbanPlan) {
                    btnCreateKanbanPlan.disabled = false;
                    btnCreateKanbanPlan.textContent = 'Create';
                }
                if (msg.error) {
                    console.error('Kanban fetch error:', msg.error);
                    return;
                }
                _kanbanPlansCache = msg.plans || [];
                _kanbanAllWorkspaceProjects = msg.allWorkspaceProjects || {};
                _kanbanWorkspaceItems = msg.workspaceItems || [];
                _kanbanAvailableColumns = msg.columns || [];
                populateWorkspaceDropdowns();
                populateKanbanFilters();
                renderKanbanPlans();
                renderEpicsList();
                tryResolvePendingKanbanSelection();
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
                if (epicsPreviewContent && _epicSelectedPlan && _epicSelectedPlan.planFile === msg.filePath) {
                    if (state.editMode.epics) {
                        state.externalChangePending.epics = true;
                    } else {
                        epicsPreviewContent.innerHTML = msg.content || '';
                        state.editOriginalContent.epics = msg.rawContent || '';
                        const dynamicEditEpicsBtn = document.getElementById('btn-edit-epics');
                        if (dynamicEditEpicsBtn) dynamicEditEpicsBtn.disabled = false;
                    }
                }
                break;
            case 'activateKanbanTabAndSelectPlan': {
                _pendingKanbanSelection = {
                    planId: msg.planId || '',
                    sessionId: msg.sessionId || '',
                    planFile: msg.planFile || '',
                    workspaceRoot: msg.workspaceRoot || ''
                };
                _pendingAutoEdit = msg.autoEdit === true;
                // Clear all filters so the target plan is guaranteed to be in the rendered
                // list regardless of workspace mapping (card.workspaceRoot is the actual
                // child folder but plan.workspaceRoot in the cache is the mapped parent).
                kanbanFilters.workspaceRoot = '';
                if (kanbanWorkspaceFilter) kanbanWorkspaceFilter.value = '';
                kanbanFilters.column = '';
                if (kanbanColumnFilter) kanbanColumnFilter.value = '';
                kanbanFilters.project = '';
                if (kanbanProjectFilter) kanbanProjectFilter.value = '';
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
            case 'epicDocumentsReady':
                _epicDocumentsCache = msg.documents || [];
                renderEpicsList();
                break;
            case 'epicError':
                showToast(msg.message || 'Error occurred', 'error');
                break;
            case 'activeDesignDocUpdated': {
                const planningEpic = msg.planningEpic || { enabled: msg.enabled, docName: msg.docName, sourceId: msg.sourceId, docId: msg.docId };
                _activeEpicName = planningEpic.enabled ? (planningEpic.docName || 'None') : 'None';
                updateActiveEpicBanner();
                break;
            }
            case 'kanbanContextSet':
                if (!msg.success) {
                    showToast('Failed to set active planning context: ' + (msg.error || 'Unknown error'), 'error');
                }
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
                // The dropdowns are pure workspace filters (default "All Workspaces"); the
                // sidebar lists the actual docs. Populate the filters, then render the lists,
                // which auto-select the first doc when nothing is selected yet.
                populateGovernanceFilters();
                renderConstitutionDocList();
                renderSystemDocList();
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
                                <p>You can create one by clicking <strong>Edit</strong> or writing it from the terminal/editor.</p>
                            </div>
                        `;
                        state.editOriginalContent.system = '';
                        _systemSelectedFile = null;
                        if (btnEditSystem) btnEditSystem.disabled = false;
                        if (btnDeleteSystem) btnDeleteSystem.style.display = 'none';
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
                                if (btnSetConstitutionPath) btnSetConstitutionPath.disabled = false;
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
                                if (btnSetConstitutionPath) btnSetConstitutionPath.disabled = true;
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
                            } else {
                                const filename = _systemSelectedGovKey === 'claude' ? 'CLAUDE.md' : 'AGENTS.md';
                                systemPreviewContent.innerHTML = `
                                    <div class="constitution-onboarding">
                                        <p class="constitution-onboarding-title">No ${filename} found for this workspace.</p>
                                        <p>You can create one by clicking <strong>Edit</strong> or writing it from the terminal/editor.</p>
                                    </div>
                                `;
                                state.editOriginalContent.system = '';
                                _systemSelectedFile = null;
                                if (btnEditSystem) btnEditSystem.disabled = false;
                                if (btnDeleteSystem) btnDeleteSystem.style.display = 'none';
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
                        if (_epicSelectedPlan) selectEpic(_epicSelectedPlan);
                        vscode.postMessage({ type: 'fetchKanbanPlans', requestId: Date.now() });
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
        }
    });

    // Shared Tab/Workspace Population
    function populateWorkspaceDropdowns() {
        if (!kanbanWorkspaceFilter || !epicsWorkspaceFilter) return;

        const currentWS = kanbanFilters.workspaceRoot;
        kanbanWorkspaceFilter.innerHTML = '<option value="">All Workspaces</option>';
        epicsWorkspaceFilter.innerHTML = '<option value="">All Workspaces</option>';
        if (tuningWorkspaceFilter) tuningWorkspaceFilter.innerHTML = '<option value="">All Workspaces</option>';

        _kanbanWorkspaceItems.forEach(ws => {
            const opt = document.createElement('option');
            opt.value = ws.workspaceRoot;
            opt.textContent = ws.label;
            kanbanWorkspaceFilter.appendChild(opt.cloneNode(true));
            epicsWorkspaceFilter.appendChild(opt.cloneNode(true));
            if (tuningWorkspaceFilter) tuningWorkspaceFilter.appendChild(opt.cloneNode(true));
        });
        kanbanWorkspaceFilter.value = currentWS;
        epicsWorkspaceFilter.value = epicsFilters.workspaceRoot;
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
    // KANBAN TAB
    // =========================================================================
    function renderKanbanPlans() {
        if (!kanbanListPane) return;

        let filtered = _kanbanPlansCache.filter(plan => {
            if (kanbanFilters.column && plan.column !== kanbanFilters.column) return false;
            if (kanbanFilters.workspaceRoot && plan.workspaceRoot !== kanbanFilters.workspaceRoot) return false;
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
            return true;
        });

        kanbanListPane.innerHTML = '';
        const toggleRow = document.createElement('div');
        toggleRow.className = 'sidebar-toggle-row';
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
                    document.querySelectorAll('.kanban-column-dropdown').forEach(s => s.style.display = 'none');
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
        if (!match) return;
        const itemDiv = kanbanListPane && kanbanListPane.querySelector(`.kanban-plan-item[data-plan-id="${match.planId}"]`);
        if (!itemDiv) return;
        itemDiv.scrollIntoView({ behavior: 'smooth', block: 'center' });
        document.querySelectorAll('.kanban-plan-item').forEach(el => el.classList.remove('selected'));
        itemDiv.classList.add('selected');
        loadKanbanPlanPreview(match);
        _pendingKanbanSelection = null;
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

        // Merge DB epics (from kanban cache) with standalone epic documents (.switchboard/epics/)
        let filtered = [
            ..._kanbanPlansCache.filter(plan => plan.isEpic),
            ..._epicDocumentsCache
        ];
        if (epicsFilters.workspaceRoot) {
            filtered = filtered.filter(plan => plan.workspaceRoot === epicsFilters.workspaceRoot);
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
            if (_epicSelectedPlan && _epicSelectedPlan.planId === plan.planId) {
                itemDiv.classList.add('selected');
            }

            const displayTime = plan.mtime > 0 ? formatRelativeTime(plan.mtime) : 'unknown';
            itemDiv.innerHTML = `
                <div style="font-weight: 500;">${escapeHtml(plan.topic)}</div>
                <div class="kanban-plan-meta" style="margin-top:4px;">${escapeHtml(plan.workspaceLabel)} · ${displayTime}</div>
                <details class="epic-accordion" data-plan-id="${escapeHtml(plan.planId)}" data-workspace-root="${escapeHtml(plan.workspaceRoot || '')}" style="margin-top: 6px; font-size: 11px;">
                    <summary style="cursor: pointer; color: var(--text-secondary);">Subtasks (${plan.subtaskCount || 0})</summary>
                    <div class="epic-subtasks-list" id="subtasks-${escapeHtml(plan.planId)}">Loading subtasks...</div>
                </details>
            `;

            itemDiv.addEventListener('click', e => {
                if (e.target.tagName === 'SUMMARY' || e.target.closest('.epic-accordion')) return;
                if (state.dirtyFlags.epics) exitEditMode('epics');
                document.querySelectorAll('.epic-plan-item').forEach(el => el.classList.remove('selected'));
                itemDiv.classList.add('selected');
                selectEpic(plan);
            });

            const accordion = itemDiv.querySelector('.epic-accordion');
            accordion.addEventListener('toggle', () => {
                if (accordion.open) {
                    if (plan.isEpicDocument) {
                        // Standalone epic documents have no subtasks in the DB
                        document.getElementById(`subtasks-${escapeHtml(plan.planId)}`).innerHTML = '<div style="padding: 4px 0; color: var(--text-secondary);">No subtasks (standalone epic document).</div>';
                    } else {
                        vscode.postMessage({ type: 'getEpicDetails', sessionId: plan.sessionId || plan.planId, workspaceRoot: plan.workspaceRoot });
                    }
                }
            });

            epicsListPane.appendChild(itemDiv);
        });
    }

    function selectEpic(plan) {
        _epicSelectedPlan = plan;
        if (btnSetActiveEpic) btnSetActiveEpic.disabled = false;
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
        metaBar.innerHTML = `
            <div class="kanban-meta-group" style="margin-left: auto;">
                <button class="strip-btn" id="btn-edit-epics" style="${state.editMode.epics ? 'display:none;' : ''}">Edit</button>
                <button class="strip-btn" id="btn-save-epics" style="${state.editMode.epics ? '' : 'display:none;'}">Save</button>
                <button class="strip-btn" id="btn-cancel-epics" style="${state.editMode.epics ? '' : 'display:none;'}">Cancel</button>
            </div>
        `;

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

    function renderEpicSubtasks(epic, subtasks) {
        const subtasksDiv = document.getElementById(`subtasks-${epic.planId}`);
        if (!subtasksDiv) return;
        if (subtasks.length === 0) {
            subtasksDiv.innerHTML = '<div style="color:var(--text-secondary); font-style:italic;">No subtasks added yet.</div>';
            return;
        }
        subtasksDiv.innerHTML = subtasks.map(st => `
            <div class="epic-subtask-item">
                <span>• ${escapeHtml(st.topic)} (${escapeHtml(st.kanbanColumn)})</span>
                <button class="epic-remove-subtask-btn" data-subtask-session="${escapeHtml(st.sessionId || st.planId)}" data-workspace-root="${escapeHtml(epic.workspaceRoot)}">Remove</button>
            </div>
        `).join('');

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

    if (epicsWorkspaceFilter) {
        epicsWorkspaceFilter.addEventListener('change', () => {
            epicsFilters.workspaceRoot = epicsWorkspaceFilter.value;
            renderEpicsList();
        });
    }

    if (btnSetActiveEpic) {
        btnSetActiveEpic.addEventListener('click', () => {
            if (_epicSelectedPlan && _epicSelectedPlan.planFile) {
                // Reuse the proven kanban-plan context handler, which sets
                // planner.designDocLink to the plan file path so the epic flows
                // into planner prompts via the design-doc resolution path.
                vscode.postMessage({
                    type: 'setKanbanPlanContext',
                    filePath: _epicSelectedPlan.planFile
                });
            } else {
                showToast('This epic has no plan file on disk to set as planning context.', 'error');
            }
        });
    }

    if (btnDisableEpic) {
        btnDisableEpic.addEventListener('click', () => {
            vscode.postMessage({ type: 'disableDesignDoc' });
        });
    }

    function updateActiveEpicBanner() {
        if (!activeEpicBanner || !activeEpicNameSpan) return;
        if (_activeEpicName && _activeEpicName !== 'None') {
            activeEpicBanner.classList.remove('inactive');
            activeEpicNameSpan.textContent = _activeEpicName;
        } else {
            activeEpicBanner.classList.add('inactive');
        }
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

    if (btnSetConstitutionPath) {
        btnSetConstitutionPath.addEventListener('click', () => {
            vscode.postMessage({ type: 'openSetConstitutionPath', workspaceRoot: _constitutionSelectedWorkspace.workspaceRoot });
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
            if (newEpicAddToKanban) newEpicAddToKanban.checked = false;
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
                addToKanbanBoard: !!(newEpicAddToKanban && newEpicAddToKanban.checked)
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

    // Initialize sidebar state on load
    applySidebarState('kanban', state.kanbanListCollapsed);
    applySidebarState('epics', state.epicsListCollapsed);
    applySidebarState('constitution', state.constitutionListCollapsed);
    applySidebarState('tuning', state.tuningListCollapsed);

    // Bind global event listeners for any static toggle buttons
    // (Dynamic buttons created by render functions get their own listeners)
    document.querySelectorAll('.sidebar-toggle-btn').forEach(btn => {
        btn.addEventListener('click', toggleSidebarCollapsed);
    });
})();
