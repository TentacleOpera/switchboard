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
            }

            if (activeTab === 'kanban') {
                vscode.postMessage({ type: 'fetchKanbanPlans', requestId: Date.now() });
            } else if (activeTab === 'epics') {
                vscode.postMessage({ type: 'fetchKanbanPlans', requestId: Date.now() });
                updateActiveEpicBanner();
            } else if (activeTab === 'constitution') {
                vscode.postMessage({ type: 'loadConstitutionFiles' });
            }
        });
    });

    // Global state
    const state = {
        editMode: { kanban: false, constitution: false },
        editOriginalContent: { kanban: null, constitution: null },
        dirtyFlags: { kanban: false, constitution: false },
        externalChangePending: { kanban: false, constitution: false },
        reviewMode: { kanban: false },
        kanbanListCollapsed: false,
        epicsListCollapsed: false,
        constitutionListCollapsed: false
    };

    // Initialize from persisted state
    const persistedState = vscode.getState() || {};
    state.kanbanListCollapsed = persistedState.kanbanListCollapsed || false;
    state.epicsListCollapsed = persistedState.epicsListCollapsed || false;
    state.constitutionListCollapsed = persistedState.constitutionListCollapsed || false;

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
        }

        // Persist state
        const currentPersisted = vscode.getState() || {};
        vscode.setState({
            ...currentPersisted,
            kanbanListCollapsed: state.kanbanListCollapsed,
            epicsListCollapsed: state.epicsListCollapsed,
            constitutionListCollapsed: state.constitutionListCollapsed
        });
    }

    let _kanbanPlansCache = [];
    let _kanbanAllWorkspaceProjects = {};
    let _kanbanWorkspaceItems = [];
    let _kanbanAvailableColumns = [];
    let _kanbanSelectedPlan = null;
    let _kanbanPreviewRequestId = 0;

    let _epicSelectedPlan = null;
    let _pendingKanbanSelection = null;
    let _activeEpicName = 'None';
    let _activeEpicFilePath = '';

    let _constitutionWorkspaces = [];
    let _constitutionSelectedWorkspace = null;
    let _constitutionSelectedFile = null;

    // Elements
    const kanbanWorkspaceFilter = document.getElementById('kanban-workspace-filter');
    const kanbanProjectFilter = document.getElementById('kanban-project-filter');
    const kanbanColumnFilter = document.getElementById('kanban-column-filter');
    const kanbanSearch = document.getElementById('kanban-search');
    const btnImportKanbanPlans = document.getElementById('btn-import-kanban-plans');
    const btnEditKanban = document.getElementById('btn-edit-kanban');
    const btnSaveKanban = document.getElementById('btn-save-kanban');
    const btnCancelKanban = document.getElementById('btn-cancel-kanban');
    const kanbanListPane = document.getElementById('kanban-list-pane');
    const kanbanPreviewPane = document.getElementById('kanban-preview-pane');
    const kanbanPreviewContent = document.getElementById('kanban-preview-content');
    const kanbanEditor = document.getElementById('kanban-editor');

    const epicsWorkspaceFilter = document.getElementById('epics-workspace-filter');
    const btnSetActiveEpic = document.getElementById('btn-set-active-epic');
    const epicsListPane = document.getElementById('epics-list-pane');
    const epicsPreviewPane = document.getElementById('epics-preview-pane');
    const epicsPreviewContent = document.getElementById('epics-preview-content');
    const activeEpicBanner = document.getElementById('active-epic-banner');
    const activeEpicNameSpan = document.getElementById('active-epic-name');
    const btnDisableEpic = document.getElementById('btn-disable-epic');

    const btnBuildConstitution = document.getElementById('btn-build-constitution');
    const btnEditConstitution = document.getElementById('btn-edit-constitution');
    const btnSaveConstitution = document.getElementById('btn-save-constitution');
    const btnCancelConstitution = document.getElementById('btn-cancel-constitution');
    const constitutionListPane = document.getElementById('constitution-list-pane');
    const constitutionPreviewPane = document.getElementById('constitution-preview-pane');
    const constitutionPreviewContent = document.getElementById('constitution-preview-content');
    const constitutionEditor = document.getElementById('constitution-editor');

    const kanbanFilters = { column: '', workspaceRoot: '', project: '', search: '' };
    const epicsFilters = { workspaceRoot: '' };

    // Initialize Webview Content
    vscode.postMessage({ type: 'fetchKanbanPlans', requestId: Date.now() });

    // Webview message handler
    window.addEventListener('message', async event => {
        const msg = event.data;
        switch (msg.type) {
            case 'kanbanPlansReady':
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
            case 'kanbanPlanPreviewReady':
                if (kanbanPreviewContent && _kanbanSelectedPlan && _kanbanSelectedPlan.planFile === msg.filePath) {
                    if (state.editMode.kanban) {
                        state.externalChangePending.kanban = true;
                    } else {
                        kanbanPreviewContent.innerHTML = msg.content || '';
                        state.editOriginalContent.kanban = msg.rawContent || '';
                        if (btnEditKanban) btnEditKanban.disabled = false;
                    }
                }
                if (epicsPreviewContent && _epicSelectedPlan && _epicSelectedPlan.planFile === msg.filePath) {
                    epicsPreviewContent.innerHTML = msg.content || '';
                }
                break;
            case 'constitutionStatus':
                const el = document.getElementById('kanban-meta-constitution');
                if (el) el.textContent = msg.status;
                break;
            case 'activateKanbanTabAndSelectPlan': {
                _pendingKanbanSelection = {
                    planId: msg.planId || '',
                    sessionId: msg.sessionId || '',
                    planFile: msg.planFile || '',
                    workspaceRoot: msg.workspaceRoot || ''
                };
                // Point the filters at the target plan's workspace and clear the column/
                // project filters so the plan is guaranteed to be in the rendered list.
                kanbanFilters.workspaceRoot = msg.workspaceRoot || '';
                if (kanbanWorkspaceFilter) kanbanWorkspaceFilter.value = msg.workspaceRoot || '';
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
            case 'epicError':
                alert(msg.message || 'Error occurred');
                break;
            case 'activeDesignDocUpdated': {
                const planningEpic = msg.planningEpic || { enabled: msg.enabled, docName: msg.docName, sourceId: msg.sourceId, docId: msg.docId };
                _activeEpicName = planningEpic.enabled ? (planningEpic.docName || 'None') : 'None';
                updateActiveEpicBanner();
                break;
            }
            case 'kanbanContextSet':
                if (!msg.success) {
                    alert('Failed to set active planning context: ' + (msg.error || 'Unknown error'));
                }
                break;
            case 'kanbanPlanColumnChanged':
                if (msg.success) {
                    vscode.postMessage({ type: 'fetchKanbanPlans', requestId: Date.now() });
                } else {
                    alert('Failed to move column: ' + (msg.error || 'Unknown error'));
                }
                break;
            case 'kanbanPlanDeleted':
                if (msg.success) {
                    _kanbanSelectedPlan = null;
                    if (kanbanPreviewContent) kanbanPreviewContent.innerHTML = '<div class="kanban-empty-state">Select a plan to preview</div>';
                    if (btnEditKanban) btnEditKanban.disabled = true;
                    vscode.postMessage({ type: 'fetchKanbanPlans', requestId: Date.now() });
                } else {
                    alert('Delete failed: ' + (msg.error || 'Unknown error'));
                }
                break;
            case 'kanbanPlanLogReady':
                showKanbanLogOverlay(msg.entries || []);
                break;
            case 'constitutionFilesLoaded':
                _constitutionWorkspaces = msg.workspaces || [];
                renderConstitutionWorkspaceList();
                break;
            case 'constitutionFileRead':
                if (constitutionPreviewContent && _constitutionSelectedWorkspace && _constitutionSelectedWorkspace.workspaceRoot === msg.workspaceRoot) {
                    if (state.editMode.constitution) {
                        state.externalChangePending.constitution = true;
                    } else {
                        if (msg.exists) {
                            constitutionPreviewContent.innerHTML = msg.renderedHtml || '';
                            state.editOriginalContent.constitution = msg.content || '';
                            _constitutionSelectedFile = msg.filePath;
                            if (btnEditConstitution) btnEditConstitution.disabled = false;
                        } else {
                            constitutionPreviewContent.innerHTML = `
                                <div class="empty-state">
                                    <p>No CONSTITUTION.md found in this workspace.</p>
                                    <p style="margin-top: 10px;">Create one to define coding standards and rule invariants for the AI planner.</p>
                                </div>
                            `;
                            state.editOriginalContent.constitution = '';
                            _constitutionSelectedFile = null;
                            if (btnEditConstitution) btnEditConstitution.disabled = true;
                        }
                    }
                }
                break;
            case 'fileSaved':
            case 'saveFileContentResult':
                if (msg.success) {
                    if (msg.tab === 'kanban') {
                        exitEditMode('kanban');
                        if (_kanbanSelectedPlan) loadKanbanPlanPreview(_kanbanSelectedPlan);
                    } else if (msg.tab === 'constitution') {
                        exitEditMode('constitution');
                        if (_constitutionSelectedWorkspace) selectConstitutionWorkspace(_constitutionSelectedWorkspace);
                    }
                } else {
                    alert('Save failed: ' + (msg.error || 'Unknown error'));
                }
                break;
        }
    });

    // Shared Tab/Workspace Population
    function populateWorkspaceDropdowns() {
        if (!kanbanWorkspaceFilter || !epicsWorkspaceFilter) return;

        const currentWS = kanbanFilters.workspaceRoot;
        kanbanWorkspaceFilter.innerHTML = '<option value="">All Workspaces</option>';
        epicsWorkspaceFilter.innerHTML = '<option value="">All Workspaces</option>';

        _kanbanWorkspaceItems.forEach(ws => {
            const opt = document.createElement('option');
            opt.value = ws.workspaceRoot;
            opt.textContent = ws.label;
            kanbanWorkspaceFilter.appendChild(opt.cloneNode(true));
            epicsWorkspaceFilter.appendChild(opt);
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
                    navigator.clipboard.writeText(path).then(() => {
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
            <div class="kanban-meta-group">
                <span class="kanban-meta-label">Constitution:</span>
                <span class="kanban-meta-value" id="kanban-meta-constitution">Loading...</span>
            </div>
            <div class="kanban-meta-group" style="margin-left: auto;">
                <button class="strip-btn" id="kanban-meta-log-btn">Log</button>
                <button class="strip-btn" id="kanban-meta-delete-btn">Delete</button>
            </div>
        `;

        vscode.postMessage({
            type: 'getConstitutionStatus',
            workspaceRoot: plan.workspaceRoot,
            planFile: plan.planFile
        });

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
    }

    if (btnImportKanbanPlans) {
        btnImportKanbanPlans.addEventListener('click', () => {
            vscode.postMessage({ type: 'importPlans' });
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

        let filtered = _kanbanPlansCache.filter(plan => plan.isEpic);
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
            emptyState.textContent = 'No epics found. Create a plan and toggle its Epic status on the board.';
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
                document.querySelectorAll('.epic-plan-item').forEach(el => el.classList.remove('selected'));
                itemDiv.classList.add('selected');
                selectEpic(plan);
            });

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
            <div class="kanban-meta-group">
                <span class="kanban-meta-label">Epic:</span>
                <span class="kanban-meta-value">${escapeHtml(plan.topic)}</span>
            </div>
            <div class="kanban-meta-group" style="margin-left: auto;">
                <button class="strip-btn" id="btn-epic-open-file">Open File</button>
            </div>
        `;
        document.getElementById('btn-epic-open-file').addEventListener('click', () => {
            vscode.postMessage({ type: 'openKanbanPlan', filePath: plan.planFile });
        });
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
                alert('This epic has no plan file on disk to set as planning context.');
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
    function renderConstitutionWorkspaceList() {
        if (!constitutionListPane) return;
        constitutionListPane.innerHTML = '';

        // NEW: Create toggle button (present even when empty)
        const toggleRow = document.createElement('div');
        toggleRow.className = 'sidebar-toggle-row';
        const toggleBtn = document.createElement('button');
        toggleBtn.className = 'sidebar-toggle-btn';
        toggleBtn.title = 'Toggle sidebar';
        toggleBtn.textContent = state.constitutionListCollapsed ? '»' : '«';
        toggleBtn.addEventListener('click', toggleSidebarCollapsed);
        toggleRow.appendChild(toggleBtn);
        constitutionListPane.appendChild(toggleRow);

        if (_constitutionWorkspaces.length === 0) {
            const emptyState = document.createElement('div');
            emptyState.className = 'empty-state';
            emptyState.textContent = 'No workspaces open';
            constitutionListPane.appendChild(emptyState);
            return;
        }

        _constitutionWorkspaces.forEach(ws => {
            const itemDiv = document.createElement('div');
            itemDiv.className = 'constitution-file-item';
            if (_constitutionSelectedWorkspace && _constitutionSelectedWorkspace.workspaceRoot === ws.workspaceRoot) {
                itemDiv.classList.add('selected');
            }

            const status = ws.hasConstitution ? '✓ Has Constitution' : '• No Constitution';
            itemDiv.innerHTML = `
                <div style="font-weight: 500;">${escapeHtml(ws.label)}</div>
                <div style="font-size: 11px; color: var(--text-secondary); margin-top: 4px;">${escapeHtml(status)}</div>
            `;

            itemDiv.addEventListener('click', () => {
                if (state.dirtyFlags.constitution) exitEditMode('constitution');
                document.querySelectorAll('.constitution-file-item').forEach(el => el.classList.remove('selected'));
                itemDiv.classList.add('selected');
                selectConstitutionWorkspace(ws);
            });

            constitutionListPane.appendChild(itemDiv);
        });
    }

    function selectConstitutionWorkspace(ws) {
        _constitutionSelectedWorkspace = ws;
        if (constitutionPreviewContent) constitutionPreviewContent.innerHTML = '<div class="empty-state">Loading...</div>';
        vscode.postMessage({ type: 'readConstitutionFile', workspaceRoot: ws.workspaceRoot });
    }

    if (btnBuildConstitution) {
        btnBuildConstitution.addEventListener('click', () => {
            if (!_constitutionSelectedWorkspace) {
                alert('Please select a workspace first.');
                return;
            }
            vscode.postMessage({ type: 'invokeConstitutionBuilder', workspaceRoot: _constitutionSelectedWorkspace.workspaceRoot });
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

    if (btnEditKanban) btnEditKanban.addEventListener('click', () => enterEditMode('kanban'));
    if (btnCancelKanban) btnCancelKanban.addEventListener('click', () => exitEditMode('kanban'));
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
                originalContent
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

    // Bind global event listeners for any static toggle buttons
    // (Dynamic buttons created by render functions get their own listeners)
    document.querySelectorAll('.sidebar-toggle-btn').forEach(btn => {
        btn.addEventListener('click', toggleSidebarCollapsed);
    });
})();
