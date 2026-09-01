/*
 * Switchboard Command — Mobile & Touch-First Command Surface
 * Buttons and dropdowns only. No text input.
 */

(function () {
    'use strict';

    // State
    let currentWorkspaceRoot = '';
    let currentWorkspaceId = '';
    let currentProject = '__unassigned__';
    let allCards = [];
    let allColumns = [];
    let workspaceList = [];
    let workspaceProjects = {};
    let activeView = 'dispatch';

    let selectedDispatchCardId = null;
    let selectedDispatchColumn = '';
    let selectedMoveCardId = null;
    let selectedMoveSourceColumn = '';
    let selectedMoveTargetColumn = '';
    let dispatchStarredOnly = false;
    let moveStarredOnly = false;

    // Feature Subtask Counts Cache
    const featureSubtaskCounts = new Map();

    let activeMission = null;
    let teamRoster = [];
    let liveFleet = [];
    let activeTerminalWs = null;
    let terminalOutputDecoder = typeof TextDecoder !== 'undefined' ? new TextDecoder('utf-8') : null;

    // Optimistic Ledger
    const pendingMoves = new Map(); // cardId -> targetColumn
    const pendingStars = new Map(); // cardId -> boolean

    // Elements
    const wsSelect = document.getElementById('workspace-project-select');
    const lockBanner = document.getElementById('mission-lock-banner');
    const lockMissionCodename = document.getElementById('lock-mission-codename');

    // Nav
    const phoneNavBtns = document.querySelectorAll('#phone-nav-bar .nav-btn');
    const tabletNavBtns = document.querySelectorAll('#tablet-rail .nav-btn');
    const viewPanes = {
        dispatch: document.getElementById('view-dispatch'),
        move: document.getElementById('view-move'),
        mission: document.getElementById('view-mission'),
        teams: document.getElementById('view-teams'),
    };

    // Dispatch Elements
    const dispatchSourceColSelect = document.getElementById('dispatch-source-column-select');
    const dispatchCardsList = document.getElementById('dispatch-cards-list');
    const dispatchStarToggle = document.getElementById('dispatch-star-toggle');
    const dispatchStatusChip = document.getElementById('dispatch-status-chip');
    const btnDispatchView = document.getElementById('btn-dispatch-view');
    const btnDispatch = document.getElementById('btn-dispatch');

    // Move Elements
    const moveSourceColSelect = document.getElementById('move-source-column-select');
    const moveTargetColSelect = document.getElementById('move-target-column-select');
    const moveCardsList = document.getElementById('move-cards-list');
    const moveStarToggle = document.getElementById('move-star-toggle');
    const moveStatusChip = document.getElementById('move-status-chip');
    const btnMoveView = document.getElementById('btn-move-view');
    const btnMove = document.getElementById('btn-move');

    // Mission Elements
    const btnLaunchMission = document.getElementById('btn-launch-mission');
    const missionStagingContainer = document.getElementById('mission-staging-container');
    const missionProgressContainer = document.getElementById('mission-progress-container');
    const missionMembersList = document.getElementById('mission-members-list');
    const missionAddMemberSelect = document.getElementById('mission-add-member-select');
    const btnAddMissionMember = document.getElementById('btn-add-mission-member');
    const missionProgressCodename = document.getElementById('mission-progress-codename');
    const missionProgressElapsed = document.getElementById('mission-progress-elapsed');
    const missionProgressMembersList = document.getElementById('mission-progress-members-list');

    // Teams Elements
    const teamsRosterList = document.getElementById('teams-roster-list');
    const teamsNotice = document.getElementById('teams-notice');
    const tabletTeamsRail = document.getElementById('tablet-teams-rail');
    const paneTerminalViewer = document.getElementById('pane-terminal-viewer');
    const btnCloseTerminal = document.getElementById('btn-close-terminal');
    const terminalViewerTitle = document.getElementById('terminal-viewer-title');
    const terminalWsStatus = document.getElementById('terminal-ws-status');
    const terminalStreamOutput = document.getElementById('terminal-stream-output');

    // Preview Overlay Elements
    const viewOverlay = document.getElementById('view-overlay');
    const btnClosePreview = document.getElementById('btn-close-preview');
    const previewFilePath = document.getElementById('preview-file-path');
    const previewContent = document.getElementById('kanban-preview-content');

    function init() {
        const initialRoot = document.body?.dataset?.initialWorkspaceRoot;
        if (initialRoot) {
            try {
                currentWorkspaceRoot = decodeURIComponent(initialRoot);
            } catch {
                currentWorkspaceRoot = initialRoot;
            }
        }

        setupNavigation();
        setupEventHandlers();
        window.addEventListener('message', handleIncomingMessage);
        refreshAllData();
    }

    function handleIncomingMessage(event) {
        let msg = event.data;
        if (typeof msg === 'string') {
            try {
                msg = JSON.parse(msg);
            } catch {
                return;
            }
        }
        if (!msg || typeof msg !== 'object') return;

        if (msg.type === 'updateBoard') {
            allCards = Array.isArray(msg.cards) ? msg.cards : [];
            recomputeSubtaskCounts();

            // Clear optimistic entries that match the incoming server state
            allCards.forEach(c => {
                const id = c.planId || c.sessionId || c.id;
                const cardCol = c.kanbanColumn || c.column;
                if (pendingMoves.has(id) && pendingMoves.get(id) === cardCol) {
                    pendingMoves.delete(id);
                }
                if (pendingStars.has(id) && Boolean(c.priorityStarred) === Boolean(pendingStars.get(id))) {
                    pendingStars.delete(id);
                }
            });

            extractWorkspaceProjects(allCards);
            renderActiveView();
        } else if (msg.type === 'moveCards') {
            const idsToMove = new Set(Array.isArray(msg.sessionIds) ? msg.sessionIds : []);
            const targetCol = msg.targetColumn;
            if (idsToMove.size && targetCol) {
                allCards = allCards.map(c => {
                    const id = c.planId || c.sessionId || c.id;
                    if (idsToMove.has(id) || (c.sessionId && idsToMove.has(c.sessionId)) || (c.planId && idsToMove.has(c.planId))) {
                        pendingMoves.delete(id);
                        return { ...c, kanbanColumn: targetCol, column: targetCol };
                    }
                    return c;
                });
                renderActiveView();
            }
        }
    }

    function recomputeSubtaskCounts() {
        featureSubtaskCounts.clear();
        allCards.forEach(c => {
            if (c.featureId) {
                featureSubtaskCounts.set(c.featureId, (featureSubtaskCounts.get(c.featureId) || 0) + 1);
            }
        });
    }

    function setupNavigation() {
        function switchView(viewName) {
            if (!viewPanes[viewName]) return;
            activeView = viewName;

            // Close terminal pane if open
            if (paneTerminalViewer.classList.contains('active')) {
                closeTerminalViewer();
            }

            // Update nav buttons active states
            phoneNavBtns.forEach(btn => {
                btn.classList.toggle('active', btn.dataset.view === viewName);
            });
            tabletNavBtns.forEach(btn => {
                btn.classList.toggle('active', btn.dataset.view === viewName);
            });

            // Update view pane visibility
            Object.keys(viewPanes).forEach(name => {
                viewPanes[name].classList.toggle('active', name === viewName);
            });

            renderActiveView();
        }

        phoneNavBtns.forEach(btn => {
            btn.addEventListener('click', () => switchView(btn.dataset.view));
        });
        tabletNavBtns.forEach(btn => {
            btn.addEventListener('click', () => switchView(btn.dataset.view));
        });
    }

    function setupEventHandlers() {
        wsSelect?.addEventListener('change', () => {
            const opt = wsSelect.selectedOptions?.[0];
            if (!opt) return;
            currentWorkspaceRoot = opt.dataset.workspaceRoot || currentWorkspaceRoot;
            currentProject = opt.dataset.project || '__unassigned__';
            selectedDispatchCardId = null;
            selectedMoveCardId = null;
            refreshAllData();
        });

        // Dispatch events
        dispatchStarToggle?.addEventListener('click', () => {
            dispatchStarredOnly = !dispatchStarredOnly;
            dispatchStarToggle.classList.toggle('active', dispatchStarredOnly);
            renderDispatchView();
        });

        dispatchSourceColSelect?.addEventListener('change', () => {
            selectedDispatchColumn = dispatchSourceColSelect.value;
            renderDispatchView();
        });

        btnDispatchView?.addEventListener('click', () => {
            if (!selectedDispatchCardId) return;
            const card = allCards.find(c => (c.planId || c.sessionId || c.id) === selectedDispatchCardId);
            if (card) openDocumentPreview(card.id, card.planFile);
        });

        btnDispatch?.addEventListener('click', executeDispatch);

        // Move events
        moveStarToggle?.addEventListener('click', () => {
            moveStarredOnly = !moveStarredOnly;
            moveStarToggle.classList.toggle('active', moveStarredOnly);
            renderMoveView();
        });

        moveSourceColSelect?.addEventListener('change', () => {
            selectedMoveSourceColumn = moveSourceColSelect.value;
            renderMoveView();
        });

        moveTargetColSelect?.addEventListener('change', () => {
            selectedMoveTargetColumn = moveTargetColSelect.value;
            updateMoveActionState();
        });

        btnMoveView?.addEventListener('click', () => {
            if (!selectedMoveCardId) return;
            const card = allCards.find(c => (c.planId || c.sessionId || c.id) === selectedMoveCardId);
            if (card) openDocumentPreview(card.id, card.planFile);
        });

        btnMove?.addEventListener('click', executeMove);

        // Mission events
        btnLaunchMission?.addEventListener('click', launchActiveMission);
        btnAddMissionMember?.addEventListener('click', addSelectedMissionMember);

        // Terminal Viewer
        btnCloseTerminal?.addEventListener('click', closeTerminalViewer);

        // Preview Overlay
        btnClosePreview?.addEventListener('click', () => {
            viewOverlay.classList.remove('active');
        });
    }

    async function refreshAllData() {
        await Promise.all([
            fetchColumns(),
            fetchMissionsState(),
            fetchTeamsState()
        ]);
        renderActiveView();
    }

    // ── Data Fetching ──────────────────────────────────────────────────

    async function fetchColumns() {
        try {
            const res = await fetch(`/kanban/columns${currentWorkspaceRoot ? `?workspaceRoot=${encodeURIComponent(currentWorkspaceRoot)}` : ''}`);
            if (res.ok) {
                const payload = await res.json();
                const data = (payload && payload.data !== undefined) ? payload.data : payload;
                const raw = Array.isArray(data)
                    ? data
                    : [...(Array.isArray(data?.builtIn) ? data.builtIn : []),
                       ...(Array.isArray(data?.custom) ? data.custom : [])];
                const seen = new Set();
                allColumns = raw.filter(c => {
                    if (!c || typeof c.id !== 'string' || seen.has(c.id)) return false;
                    seen.add(c.id);
                    return true;
                });
                populateColumnDropdowns();
            }
        } catch (err) {
            console.warn('[Command] Failed to fetch columns:', err);
        }
    }

    function populateColumnDropdowns() {
        if (!moveSourceColSelect || !moveTargetColSelect) return;
        const currentDispatch = dispatchSourceColSelect ? dispatchSourceColSelect.value : '';
        const currentSource = moveSourceColSelect.value;
        const currentTarget = moveTargetColSelect.value;

        if (dispatchSourceColSelect) dispatchSourceColSelect.innerHTML = '';
        moveSourceColSelect.innerHTML = '';
        moveTargetColSelect.innerHTML = '';

        allColumns.forEach(col => {
            if (dispatchSourceColSelect) {
                const opt0 = document.createElement('option');
                opt0.value = col.id;
                opt0.textContent = col.label || col.id;
                dispatchSourceColSelect.appendChild(opt0);
            }

            const opt1 = document.createElement('option');
            opt1.value = col.id;
            opt1.textContent = col.label || col.id;
            moveSourceColSelect.appendChild(opt1);

            const opt2 = document.createElement('option');
            opt2.value = col.id;
            opt2.textContent = col.label || col.id;
            moveTargetColSelect.appendChild(opt2);
        });

        if (dispatchSourceColSelect) {
            if (currentDispatch && [...dispatchSourceColSelect.options].some(o => o.value === currentDispatch)) {
                dispatchSourceColSelect.value = currentDispatch;
            } else if (allColumns.length > 0) {
                const createdCol = allColumns.find(c => c.id === 'CREATED' || c.id === 'BACKLOG');
                dispatchSourceColSelect.value = createdCol ? createdCol.id : allColumns[0].id;
            }
            selectedDispatchColumn = dispatchSourceColSelect.value;
        }

        if (currentSource && [...moveSourceColSelect.options].some(o => o.value === currentSource)) {
            moveSourceColSelect.value = currentSource;
        } else if (allColumns.length > 0) {
            moveSourceColSelect.value = allColumns[0].id;
        }
        selectedMoveSourceColumn = moveSourceColSelect.value;

        if (currentTarget && [...moveTargetColSelect.options].some(o => o.value === currentTarget)) {
            moveTargetColSelect.value = currentTarget;
        } else if (allColumns.length > 1) {
            moveTargetColSelect.value = allColumns[1].id;
        }
        selectedMoveTargetColumn = moveTargetColSelect.value;
    }

    function extractWorkspaceProjects(cards) {
        if (!wsSelect) return;
        const wsMap = {};
        cards.forEach(card => {
            const root = card.workspaceRoot || currentWorkspaceRoot;
            if (!root) return;
            if (!wsMap[root]) wsMap[root] = new Set();
            if (card.project && card.project !== '__unassigned__') {
                wsMap[root].add(card.project);
            }
        });

        const currentVal = wsSelect.value;
        wsSelect.innerHTML = '';

        const roots = Object.keys(wsMap);
        if (roots.length === 0 && currentWorkspaceRoot) {
            roots.push(currentWorkspaceRoot);
        }

        roots.forEach(root => {
            const baseOpt = document.createElement('option');
            baseOpt.value = `${root}|__unassigned__`;
            const label = root.split('/').filter(Boolean).pop() || root;
            baseOpt.textContent = label;
            baseOpt.dataset.workspaceRoot = root;
            baseOpt.dataset.project = '__unassigned__';
            wsSelect.appendChild(baseOpt);

            const projs = Array.from(wsMap[root] || []);
            projs.forEach(proj => {
                const opt = document.createElement('option');
                opt.value = `${root}|${proj}`;
                opt.textContent = `${label} > ${proj}`;
                opt.dataset.workspaceRoot = root;
                opt.dataset.project = proj;
                wsSelect.appendChild(opt);
            });
        });

        if (currentVal && [...wsSelect.options].some(o => o.value === currentVal)) {
            wsSelect.value = currentVal;
        } else if (wsSelect.options.length > 0) {
            wsSelect.selectedIndex = 0;
            const chosen = wsSelect.selectedOptions[0];
            currentWorkspaceRoot = chosen.dataset.workspaceRoot || currentWorkspaceRoot;
            currentProject = chosen.dataset.project || '__unassigned__';
        }
    }

    async function fetchMissionsState() {
        try {
            const queryRoot = currentWorkspaceRoot ? `?workspaceRoot=${encodeURIComponent(currentWorkspaceRoot)}` : '';
            const res = await fetch(`/kanban/mission/active${queryRoot}`);
            if (res.ok) {
                const data = await res.json();
                activeMission = data?.mission || null;
            }
        } catch (err) {
            console.warn('[Command] Failed to fetch active mission:', err);
        }
    }

    async function fetchTeamsState() {
        try {
            // Fetch live fleet
            const fleetRes = await fetch('/terminals/verb/ptyListTerminals', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ workspaceRoot: currentWorkspaceRoot })
            });
            if (fleetRes.ok) {
                const fleetData = await fleetRes.json();
                liveFleet = Array.isArray(fleetData?.terminals) ? fleetData.terminals : [];
            }

            // Team definitions
            const groupsRes = await fetch('/terminals/verb/ptyListAgentGroups', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ cwd: currentWorkspaceRoot })
            });
            if (groupsRes.ok) {
                const groupsData = await groupsRes.json();
                teamRoster = (groupsData && groupsData.success && Array.isArray(groupsData.groups))
                    ? groupsData.groups
                    : [];
            }
        } catch (err) {
            console.warn('[Command] Failed to fetch teams state:', err);
        }
    }

    // ── Rendering ─────────────────────────────────────────────────────

    function renderActiveView() {
        updateMissionLock();
        if (activeView === 'dispatch') {
            renderDispatchView();
        } else if (activeView === 'move') {
            renderMoveView();
        } else if (activeView === 'mission') {
            renderMissionView();
        } else if (activeView === 'teams') {
            renderTeamsView();
        }
    }

    function isMissionInFlight() {
        if (!activeMission) return false;
        return activeMission.runState === 'in-flight';
    }

    function updateMissionLock() {
        const locked = isMissionInFlight();
        if (locked) {
            lockBanner.classList.remove('hidden');
            lockMissionCodename.textContent = missionLabel('Active Operation');
        } else {
            lockBanner.classList.add('hidden');
        }

        btnDispatch.disabled = locked || !selectedDispatchCardId;
        btnMove.disabled = locked || !selectedMoveCardId;
    }

    function getComplexityClass(score) {
        if (score === null || score === undefined || score === '' || score === 'Unknown') return 'comp-unknown';
        const num = Number(score);
        if (isNaN(num)) return 'comp-unknown';
        if (num <= 2) return 'comp-very-low';
        if (num <= 4) return 'comp-low';
        if (num <= 6) return 'comp-medium';
        if (num <= 8) return 'comp-high';
        return 'comp-very-high';
    }

    function getEffectiveCard(rawCard) {
        const cardId = rawCard.planId || rawCard.sessionId || rawCard.id;
        const optColumn = pendingMoves.get(cardId);
        const optStar = pendingStars.get(cardId);
        const currentCol = rawCard.kanbanColumn || rawCard.column || '';
        return {
            ...rawCard,
            id: cardId,
            kanbanColumn: optColumn !== undefined ? optColumn : currentCol,
            column: optColumn !== undefined ? optColumn : currentCol,
            priorityStarred: optStar !== undefined ? (optStar ? 1 : 0) : (rawCard.priorityStarred ?? 0),
        };
    }

    // ── 1. Dispatch View Rendering ─────────────────────────────────────

    function selectDispatchCard(cardId) {
        selectedDispatchCardId = cardId;
        if (dispatchCardsList) {
            const items = dispatchCardsList.querySelectorAll('.cmd-card-row');
            items.forEach(el => {
                el.classList.toggle('selected', el.dataset.cardId === cardId);
            });
        }
        updateDispatchActionState();
    }

    function renderDispatchView() {
        if (!dispatchCardsList) return;
        dispatchCardsList.innerHTML = '';

        let cards = allCards.map(getEffectiveCard);

        // Project filter
        if (currentProject && currentProject !== '__unassigned__') {
            cards = cards.filter(c => c.project === currentProject);
        }

        // Scope to dispatch source column
        const dispatchCol = (dispatchSourceColSelect ? dispatchSourceColSelect.value : '') || selectedDispatchColumn;
        if (dispatchCol) {
            cards = cards.filter(c => (c.kanbanColumn || c.column) === dispatchCol || c.id === selectedDispatchCardId);
        }

        if (dispatchStarredOnly) {
            cards = cards.filter(c => Boolean(c.priorityStarred) || c.id === selectedDispatchCardId);
        }

        // Sort starred first, then complexity
        cards.sort((a, b) => {
            if (a.id === selectedDispatchCardId) return -1;
            if (b.id === selectedDispatchCardId) return 1;
            const starA = a.priorityStarred ? 1 : 0;
            const starB = b.priorityStarred ? 1 : 0;
            if (starA !== starB) return starB - starA;
            return (Number(b.complexity) || 0) - (Number(a.complexity) || 0);
        });

        if (cards.length === 0) {
            const empty = document.createElement('div');
            empty.style.padding = '20px';
            empty.style.color = 'var(--text-secondary)';
            empty.style.textAlign = 'center';
            empty.textContent = 'No cards ready for dispatch in this column.';
            dispatchCardsList.appendChild(empty);
            updateDispatchActionState();
            return;
        }

        cards.forEach(card => {
            const item = createCardItemElement(card, selectedDispatchCardId === card.id, (selectedCard) => {
                selectDispatchCard(selectedCard.id);
            });
            dispatchCardsList.appendChild(item);
        });

        updateDispatchActionState();
    }

    function updateDispatchActionState() {
        const locked = isMissionInFlight();
        const selectedCard = allCards.find(c => (c.planId || c.sessionId || c.id) === selectedDispatchCardId);

        if (btnDispatchView) {
            btnDispatchView.disabled = !selectedCard;
        }

        if (selectedCard) {
            if (locked) {
                if (dispatchStatusChip) {
                    dispatchStatusChip.textContent = 'Locked: Mission in flight';
                    dispatchStatusChip.className = 'status-chip unknown';
                    dispatchStatusChip.classList.remove('hidden');
                }
                btnDispatch.disabled = true;
            } else {
                btnDispatch.disabled = false;
            }
        } else {
            btnDispatch.disabled = true;
        }
    }

    // ── 2. Move View Rendering ─────────────────────────────────────────

    function selectMoveCard(cardId) {
        selectedMoveCardId = cardId;
        if (moveCardsList) {
            const items = moveCardsList.querySelectorAll('.cmd-card-row');
            items.forEach(el => {
                el.classList.toggle('selected', el.dataset.cardId === cardId);
            });
        }
        updateMoveActionState();
    }

    function renderMoveView() {
        if (!moveCardsList) return;
        moveCardsList.innerHTML = '';

        let cards = allCards.map(getEffectiveCard);

        // Project filter
        if (currentProject && currentProject !== '__unassigned__') {
            cards = cards.filter(c => c.project === currentProject);
        }

        // Scope to source column
        const sourceCol = moveSourceColSelect?.value;
        if (sourceCol) {
            cards = cards.filter(c => (c.kanbanColumn || c.column) === sourceCol || c.id === selectedMoveCardId);
        }

        if (moveStarredOnly) {
            cards = cards.filter(c => Boolean(c.priorityStarred) || c.id === selectedMoveCardId);
        }

        // Starred first, then moved card rises to top if it was acted on
        cards.sort((a, b) => {
            if (a.id === selectedMoveCardId) return -1;
            if (b.id === selectedMoveCardId) return 1;
            const starA = a.priorityStarred ? 1 : 0;
            const starB = b.priorityStarred ? 1 : 0;
            if (starA !== starB) return starB - starA;
            return 0;
        });

        if (cards.length === 0) {
            const empty = document.createElement('div');
            empty.style.padding = '20px';
            empty.style.color = 'var(--text-secondary)';
            empty.style.textAlign = 'center';
            empty.textContent = 'No cards in this column.';
            moveCardsList.appendChild(empty);
            updateMoveActionState();
            return;
        }

        cards.forEach(card => {
            const item = createCardItemElement(card, selectedMoveCardId === card.id, (selectedCard) => {
                selectMoveCard(selectedCard.id);
            });
            moveCardsList.appendChild(item);
        });

        updateMoveActionState();
    }

    function updateMoveActionState() {
        const locked = isMissionInFlight();
        const selectedCard = allCards.find(c => (c.planId || c.sessionId || c.id) === selectedMoveCardId);

        if (btnMoveView) {
            btnMoveView.disabled = !selectedCard;
        }

        if (selectedCard) {
            if (locked) {
                if (moveStatusChip) {
                    moveStatusChip.textContent = 'Locked: Mission in flight';
                    moveStatusChip.className = 'status-chip unknown';
                    moveStatusChip.classList.remove('hidden');
                }
                btnMove.disabled = true;
            } else {
                btnMove.disabled = false;
            }
        } else {
            btnMove.disabled = true;
        }
    }

    // ── Card Item Builder ──────────────────────────────────────────────

    function createCardItemElement(card, isSelected, onSelect) {
        const row = document.createElement('div');
        row.className = `cmd-card-row${isSelected ? ' selected' : ''}`;
        row.dataset.cardId = card.id;

        const isStarred = Boolean(card.priorityStarred);
        const star = document.createElement('span');
        star.className = `card-star-indicator${isStarred ? ' starred' : ''}`;
        star.setAttribute('aria-label', isStarred ? 'Starred' : 'Not starred');
        star.innerHTML = '<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M8 1.5l2 4.5 5 .4-3.8 3.3 1.2 4.9L8 12l-4.4 2.6 1.2-4.9L1 6.4l5-.4z"/></svg>';
        star.addEventListener('click', (ev) => {
            ev.stopPropagation();
            toggleCardStar(card.id, isStarred);
        });
        row.appendChild(star);

        const title = document.createElement('span');
        title.className = 'cmd-card-title';
        title.textContent = card.title || card.topic || card.planFile || 'Untitled';
        row.appendChild(title);

        const meta = document.createElement('div');
        meta.className = 'cmd-card-meta';

        if (card.complexity !== undefined && card.complexity !== null && card.complexity !== '') {
            const num = Number(card.complexity);
            const dot = document.createElement('span');
            if (isNaN(num) || String(card.complexity).toLowerCase() === 'unknown') {
                dot.className = 'complexity-dot comp-unknown';
                dot.textContent = '';
            } else {
                dot.className = `complexity-dot ${getComplexityClass(num)}`;
                dot.textContent = String(num);
            }
            meta.appendChild(dot);
        }

        const subtaskCount = card.isFeature
            ? (featureSubtaskCounts.get(card.planId || card.id) || 0)
            : 0;
        if (card.isFeature) {
            const st = document.createElement('span');
            st.className = 'subtask-badge';
            st.textContent = `${subtaskCount} subtask${subtaskCount === 1 ? '' : 's'}`;
            meta.appendChild(st);
        }

        const kindBadge = document.createElement('span');
        kindBadge.className = 'kind-badge';
        kindBadge.textContent = card.isFeature ? 'Feature' : 'Plan';
        meta.appendChild(kindBadge);

        row.appendChild(meta);

        row.addEventListener('click', () => onSelect(card));
        return row;
    }

    // ── 3. Mission View Rendering ──────────────────────────────────────

    function missionMembers() {
        if (!activeMission) { return []; }
        const ids = [
            ...(Array.isArray(activeMission.plans) ? activeMission.plans.map(id => ({ id, kind: 'plan' })) : []),
            ...(Array.isArray(activeMission.features) ? activeMission.features.map(id => ({ id, kind: 'feature' })) : []),
        ];
        return ids.map(({ id, kind }) => {
            const card = allCards.find(c => (c.planId || c.sessionId || c.id) === id) || null;
            return {
                id,
                kind,
                title: card ? (card.topic || card.title || card.planFile || id) : id,
                seat: card ? (card.dispatchedTerminal || '') : '',
                dispatchedAt: card ? (card.dispatchedAt || null) : null,
                completed: Boolean(card && (card.completedAt || (card.kanbanColumn || card.column) === 'COMPLETED')),
            };
        });
    }

    function missionLabel(fallback) {
        return (activeMission && activeMission.name) || fallback;
    }

    function renderMissionView() {
        if (!missionStagingContainer || !missionProgressContainer) return;

        const inFlight = isMissionInFlight();

        if (inFlight) {
            missionStagingContainer.classList.add('hidden');
            missionProgressContainer.classList.remove('hidden');

            missionProgressCodename.textContent = missionLabel('OPERATION IN FLIGHT');
            const members = missionMembers();
            const stamps = members.map(m => m.dispatchedAt).filter(Boolean).map(v => new Date(v).getTime())
                .filter(n => Number.isFinite(n));
            const startedAt = stamps.length ? Math.min(...stamps) : 0;
            const elapsedSec = startedAt ? Math.max(0, Math.floor((Date.now() - startedAt) / 1000)) : 0;
            missionProgressElapsed.textContent = startedAt ? `Running for ${elapsedSec}s` : 'Running';

            missionProgressMembersList.innerHTML = '';
            if (members.length === 0) {
                missionProgressMembersList.innerHTML = '<div style="color:var(--text-secondary); font-size:12px; padding:12px;">No members listed.</div>';
            } else {
                members.forEach(m => {
                    const row = document.createElement('div');
                    row.className = 'cmd-card-row';
                    row.style.minHeight = '48px';
                    row.style.height = '48px';

                    const name = document.createElement('span');
                    name.className = 'cmd-card-title';
                    name.textContent = m.title;
                    row.appendChild(name);

                    const status = document.createElement('span');
                    status.className = `team-state-badge ${m.completed ? 'team-state-working' : (m.seat ? 'team-state-held' : 'team-state-idle')}`;
                    status.textContent = m.completed ? 'COMPLETED' : (m.seat ? `SEAT: ${m.seat}` : 'STAGED');
                    row.appendChild(status);

                    missionProgressMembersList.appendChild(row);
                });
            }
        } else {
            missionStagingContainer.classList.remove('hidden');
            missionProgressContainer.classList.add('hidden');

            missionMembersList.innerHTML = '';
            const members = missionMembers();
            if (members.length === 0) {
                missionMembersList.innerHTML = '<div style="color:var(--text-secondary); font-size:12px; padding:12px; text-align:center;">No members staged. Select candidates above.</div>';
            } else {
                members.forEach(m => {
                    const row = document.createElement('div');
                    row.className = 'cmd-card-row';
                    row.style.minHeight = '48px';
                    row.style.height = '48px';

                    const title = document.createElement('span');
                    title.className = 'cmd-card-title';
                    title.textContent = m.title;
                    row.appendChild(title);

                    const removeBtn = document.createElement('button');
                    removeBtn.className = 'secondary-action-btn';
                    removeBtn.style.minHeight = '32px';
                    removeBtn.style.padding = '4px 10px';
                    removeBtn.textContent = 'Remove';
                    removeBtn.addEventListener('click', (ev) => {
                        ev.stopPropagation();
                        removeMissionMember(m.id);
                    });
                    row.appendChild(removeBtn);

                    missionMembersList.appendChild(row);
                });
            }

            // Populate member candidate picker
            if (missionAddMemberSelect) {
                missionAddMemberSelect.innerHTML = '';
                const memberIds = new Set(members.map(m => m.id));
                let candidates = allCards.filter(c => !memberIds.has(c.planId || c.sessionId || c.id));
                if (currentProject && currentProject !== '__unassigned__') {
                    candidates = candidates.filter(c => c.project === currentProject);
                }
                candidates = candidates.filter(c => {
                    const col = (c.kanbanColumn || c.column || '').toUpperCase();
                    return col !== 'COMPLETED' && col !== 'ARCHIVED';
                });
                candidates.forEach(c => {
                    const opt = document.createElement('option');
                    opt.value = c.planId || c.sessionId || c.id;
                    opt.textContent = `${c.title || c.topic || 'Card'} (${c.kanbanColumn || c.column || 'new'})`;
                    opt.dataset.kind = c.isFeature ? 'feature' : 'plan';
                    missionAddMemberSelect.appendChild(opt);
                });
            }
        }
    }

    // ── 4. Teams View Rendering ────────────────────────────────────────

    function renderTeamsView() {
        if (teamsRosterList) teamsRosterList.innerHTML = '';
        if (tabletTeamsRail) tabletTeamsRail.innerHTML = '';

        if (teamRoster.length === 0) {
            if (teamsRosterList) {
                const empty = document.createElement('div');
                empty.style.padding = '20px';
                empty.style.color = 'var(--text-secondary)';
                empty.style.textAlign = 'center';
                empty.textContent = 'No teams declared for this workspace.';
                teamsRosterList.appendChild(empty);
            }
            return;
        }

        teamRoster.forEach(team => {
            renderTeamRow(team);
        });
    }

    function resolveTeamIconUri(value) {
        const v = String(value || '').trim();
        if (!v) { return null; }
        if (v.startsWith('data:')) { return v; }
        if (v.startsWith('art:')) {
            const name = v.slice('art:'.length).trim();
            return name ? '/static/icons/' + encodeURIComponent(name) + '.png' : null;
        }
        if (v.startsWith('pack:')) {
            const file = v.slice('pack:'.length).trim();
            return file ? '/static/icons/' + encodeURIComponent(file) : null;
        }
        return null;
    }

    function resolveTeamHeadSeat(team) {
        const role = team.headRole || '';
        return liveFleet.find(t => t && t.status !== 'exited'
            && ((role && t.role === role) || (team.head && t.friendlyName === team.head))) || null;
    }

    function declaredSeatCount(team) {
        const members = Array.isArray(team.members) ? team.members : [];
        return 1 + members.reduce((n, m) => n + (Number(m && m.count) || 0), 0);
    }

    async function seatTeam(team, btn) {
        if (btn) { btn.disabled = true; }
        try {
            const res = await fetch('/terminals/verb/ptyStartTeam', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ teamId: team.id, cwd: currentWorkspaceRoot })
            });
            let data = null;
            try { data = await res.json(); } catch { /* ignore */ }
            if (!data || data.success === false) {
                setTeamNotice((data && data.error) || 'Could not seat this team');
            } else {
                setTeamNotice('');
                await fetchTeamsState();
                renderTeamsView();
            }
        } catch (err) {
            setTeamNotice('Outcome unknown (connection dropped)');
        } finally {
            if (btn) { btn.disabled = false; }
        }
    }

    function setTeamNotice(text) {
        if (!teamsNotice) { return; }
        teamsNotice.textContent = text || '';
        teamsNotice.classList.toggle('hidden', !text);
    }

    function renderTeamRow(team) {
        const liveSeat = resolveTeamHeadSeat(team);
        const headName = liveSeat ? liveSeat.friendlyName : (team.head || team.name);
        const isDormant = !liveSeat;
        const heldTeam = String(activeMission?.team || '');
        const isHeld = isMissionInFlight() && heldTeam !== ''
            && (heldTeam === team.id || heldTeam === team.name);
        const isWorking = Boolean(liveSeat && liveSeat.planId);

        let stateLabel = 'IDLE';
        let stateClass = 'team-state-idle';
        if (isDormant) {
            stateLabel = 'DORMANT';
            stateClass = 'team-state-dormant';
        } else if (isHeld) {
            stateLabel = 'HELD';
            stateClass = 'team-state-held';
        } else if (isWorking) {
            stateLabel = 'WORKING';
            stateClass = 'team-state-working';
        }

        const teamIconUri = resolveTeamIconUri(team.icon) || '/static/icons/nav-jet.svg';

        // Phone Roster Card
        if (teamsRosterList) {
            const card = document.createElement('div');
            card.className = `team-roster-card${isDormant ? ' is-dormant' : ''}`;

            const left = document.createElement('div');
            left.className = 'team-roster-left';

            const iconBox = document.createElement('div');
            iconBox.className = 'team-icon-box';
            const img = document.createElement('img');
            img.className = 'team-icon-img';
            img.src = teamIconUri;
            img.alt = '';
            iconBox.appendChild(img);
            left.appendChild(iconBox);

            const info = document.createElement('div');
            info.className = 'team-info-col';

            const name = document.createElement('span');
            name.className = 'team-name-title';
            name.textContent = team.name || headName;
            info.appendChild(name);

            const seats = document.createElement('span');
            seats.className = 'team-seats-subtitle';
            const seatCount = declaredSeatCount(team);
            seats.textContent = `${seatCount} seat${seatCount > 1 ? 's' : ''} \u00b7 Head: ${headName}`;
            info.appendChild(seats);

            left.appendChild(info);
            card.appendChild(left);

            const stateBadge = document.createElement('span');
            stateBadge.className = `team-state-badge ${stateClass}`;
            stateBadge.textContent = stateLabel;
            card.appendChild(stateBadge);

            card.addEventListener('click', () => {
                if (isDormant) {
                    seatTeam(team, null);
                } else {
                    openTerminalViewer(team, headName);
                }
            });

            teamsRosterList.appendChild(card);
        }

        // Tablet Rail Team Card
        if (tabletTeamsRail) {
            const railItem = document.createElement('div');
            railItem.className = `team-roster-card${isDormant ? ' is-dormant' : ''}`;
            railItem.style.minHeight = '44px';
            railItem.style.padding = '6px 8px';

            const left = document.createElement('div');
            left.className = 'team-roster-left';

            const iconBox = document.createElement('div');
            iconBox.className = 'team-icon-box';
            const img = document.createElement('img');
            img.className = 'team-icon-img';
            img.src = teamIconUri;
            img.alt = '';
            iconBox.appendChild(img);
            left.appendChild(iconBox);

            const info = document.createElement('div');
            info.className = 'team-info-col';

            const name = document.createElement('span');
            name.className = 'team-name-title';
            name.style.fontSize = '12px';
            name.textContent = team.name || headName;
            info.appendChild(name);

            const seats = document.createElement('span');
            seats.className = 'team-seats-subtitle';
            seats.style.fontSize = '10px';
            const seatCount = declaredSeatCount(team);
            seats.textContent = `${seatCount} seat${seatCount > 1 ? 's' : ''}`;
            info.appendChild(seats);

            left.appendChild(info);
            railItem.appendChild(left);

            const stateBadge = document.createElement('span');
            stateBadge.className = `team-state-badge ${stateClass}`;
            stateBadge.style.fontSize = '9px';
            stateBadge.style.padding = '2px 6px';
            stateBadge.textContent = stateLabel;
            railItem.appendChild(stateBadge);

            railItem.addEventListener('click', () => {
                if (isDormant) {
                    seatTeam(team, null);
                } else {
                    openTerminalViewer(team, headName);
                }
            });

            tabletTeamsRail.appendChild(railItem);
        }
    }

    // ── 5. Actions Execution ───────────────────────────────────────────

    async function executeDispatch() {
        if (!selectedDispatchCardId || isMissionInFlight()) return;
        const cardId = selectedDispatchCardId;
        const card = allCards.find(c => (c.planId || c.sessionId || c.id) === cardId);
        if (!card) return;

        // Apply immediate optimistic state (< 100ms)
        dispatchStatusChip.textContent = 'Dispatching agent...';
        dispatchStatusChip.className = 'status-chip pending';
        btnDispatch.disabled = true;

        try {
            const res = await fetch('/kanban/dispatch', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    plan: cardId,
                    workspaceRoot: currentWorkspaceRoot
                })
            });

            const result = await res.json().catch(() => null);
            if (res.ok && result?.success !== false) {
                dispatchStatusChip.textContent = `Dispatched to ${result?.dispatchedAgent || 'agent'}`;
                dispatchStatusChip.className = 'status-chip success';
                renderDispatchView();
            } else {
                const errMsg = result?.error || 'Dispatch outcome unknown';
                dispatchStatusChip.textContent = errMsg;
                dispatchStatusChip.className = 'status-chip unknown';
                btnDispatch.disabled = false;
            }
        } catch (err) {
            dispatchStatusChip.textContent = 'Outcome unknown (connection dropped)';
            dispatchStatusChip.className = 'status-chip unknown';
            btnDispatch.disabled = false;
        }
    }

    async function executeMove() {
        if (!selectedMoveCardId || isMissionInFlight()) return;
        const cardId = selectedMoveCardId;
        const targetCol = selectedMoveTargetColumn;
        if (!targetCol) return;

        // Apply immediate optimistic DOM move (< 100ms)
        pendingMoves.set(cardId, targetCol);
        moveStatusChip.textContent = `Moved to ${targetCol} (syncing...)`;
        moveStatusChip.className = 'status-chip pending';
        renderMoveView();

        try {
            const res = await fetch('/kanban/move', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    planId: cardId,
                    targetColumn: targetCol,
                    workspaceRoot: currentWorkspaceRoot
                })
            });

            if (res.ok) {
                moveStatusChip.textContent = `Moved to ${targetCol}`;
                moveStatusChip.className = 'status-chip success';
                renderMoveView();
            } else {
                pendingMoves.delete(cardId);
                moveStatusChip.textContent = 'Move failed on server';
                moveStatusChip.className = 'status-chip error';
                renderMoveView();
            }
        } catch (err) {
            moveStatusChip.textContent = 'Move pending (offline)';
            moveStatusChip.className = 'status-chip unknown';
        }
    }

    async function toggleCardStar(cardId, currentStarred) {
        const nextStarred = !currentStarred;
        pendingStars.set(cardId, nextStarred);
        renderActiveView();

        try {
            const res = await fetch('/kanban/plans/priority', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    planId: cardId,
                    starred: nextStarred
                })
            });
            if (!res.ok) {
                pendingStars.delete(cardId);
                renderActiveView();
            }
        } catch (err) {
            console.warn('[Command] Star toggle offline:', err);
        }
    }

    async function addSelectedMissionMember() {
        if (!activeMission || !missionAddMemberSelect?.value) return;
        const memberId = missionAddMemberSelect.value;
        const selectedOpt = missionAddMemberSelect.selectedOptions?.[0];
        const kind = selectedOpt?.dataset?.kind || 'plan';

        try {
            btnAddMissionMember.disabled = true;
            const res = await fetch('/kanban/mission/member/add', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    missionId: activeMission.id || activeMission.missionId,
                    memberId,
                    kind
                })
            });
            if (res.ok) {
                await fetchMissionsState();
                renderMissionView();
            }
        } catch (err) {
            console.warn('[Command] Add member failed:', err);
        } finally {
            btnAddMissionMember.disabled = false;
        }
    }

    async function removeMissionMember(memberId) {
        if (!activeMission) return;
        try {
            const res = await fetch('/kanban/mission/member/remove', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    missionId: activeMission.id || activeMission.missionId,
                    memberId
                })
            });
            if (res.ok) {
                await fetchMissionsState();
                renderMissionView();
            }
        } catch (err) {
            console.warn('[Command] Remove member failed:', err);
        }
    }

    async function launchActiveMission() {
        if (!activeMission) return;
        try {
            btnLaunchMission.disabled = true;
            const res = await fetch('/kanban/queue/next', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    workspaceRoot: currentWorkspaceRoot
                })
            });
            if (res.ok) {
                await fetchMissionsState();
                renderActiveView();
            }
        } catch (err) {
            console.warn('[Command] Launch failed:', err);
        } finally {
            btnLaunchMission.disabled = false;
        }
    }

    // ── 6. Read-Only Terminal Viewer ───────────────────────────────────

    function openTerminalViewer(team, resolvedHead) {
        const headName = resolvedHead || (resolveTeamHeadSeat(team) || {}).friendlyName || team.name;
        terminalViewerTitle.textContent = `Terminal: ${headName}`;
        terminalStreamOutput.textContent = 'Connecting to terminal stream...\n';

        // Hide other panes, show viewer
        Object.values(viewPanes).forEach(p => p.classList.remove('active'));
        paneTerminalViewer.classList.add('active');

        // Fetch initial scrollback log
        fetch(`/terminals/${encodeURIComponent(headName)}/log`)
            .then(res => res.text())
            .then(logText => {
                if (logText) {
                    terminalStreamOutput.textContent = logText + '\n--- Live Stream ---\n';
                    terminalStreamOutput.scrollTop = terminalStreamOutput.scrollHeight;
                }
            })
            .catch(() => {});

        // Connect WebSocket
        closeActiveWs();
        const wsProtocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsUrl = `${wsProtocol}//${location.host}/ws/terminal?name=${encodeURIComponent(headName)}&solo=1`;

        try {
            const ws = new WebSocket(wsUrl);
            ws.binaryType = 'arraybuffer';
            activeTerminalWs = ws;

            ws.onopen = () => {
                terminalWsStatus.textContent = 'Live';
                terminalWsStatus.className = 'status-chip success';
            };

            ws.onmessage = (event) => {
                let text = '';
                if (typeof event.data !== 'string' && event.data instanceof ArrayBuffer) {
                    const view = new DataView(event.data);
                    if (view.byteLength >= 4) {
                        text = terminalOutputDecoder ? terminalOutputDecoder.decode(new Uint8Array(event.data, 4)) : '';
                    }
                } else if (typeof event.data === 'string') {
                    try {
                        const frame = JSON.parse(event.data);
                        if (frame.t === 'out' && typeof frame.data === 'string') {
                            text = atob(frame.data);
                        }
                    } catch {
                        text = event.data;
                    }
                }

                if (text) {
                    // Strip common ANSI escape codes for cleaner mobile pre render
                    const clean = text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
                    terminalStreamOutput.textContent += clean;
                    terminalStreamOutput.scrollTop = terminalStreamOutput.scrollHeight;
                }
            };

            ws.onclose = () => {
                terminalWsStatus.textContent = 'Closed';
                terminalWsStatus.className = 'status-chip';
            };

            ws.onerror = () => {
                terminalWsStatus.textContent = 'Error';
                terminalWsStatus.className = 'status-chip error';
            };
        } catch (err) {
            terminalWsStatus.textContent = 'Offline';
            terminalWsStatus.className = 'status-chip unknown';
        }
    }

    function closeActiveWs() {
        if (activeTerminalWs) {
            try {
                activeTerminalWs.close();
            } catch {}
            activeTerminalWs = null;
        }
    }

    function closeTerminalViewer() {
        closeActiveWs();
        paneTerminalViewer.classList.remove('active');
        if (viewPanes[activeView]) {
            viewPanes[activeView].classList.add('active');
        }
    }

    // ── 7. Document Preview Overlay ────────────────────────────────────

    async function openDocumentPreview(cardId, filePath) {
        previewFilePath.textContent = filePath || cardId;
        previewContent.innerHTML = '<div style="padding:20px; color:var(--text-secondary);">Loading preview...</div>';
        viewOverlay.classList.add('active');

        try {
            const queryRoot = currentWorkspaceRoot ? `&workspaceRoot=${encodeURIComponent(currentWorkspaceRoot)}` : '';
            const res = await fetch(`/kanban/plan?planId=${encodeURIComponent(cardId)}${queryRoot}`);
            if (res.ok) {
                const payload = await res.json();
                const planData = (payload && payload.data !== undefined) ? payload.data : payload;
                const md = planData?.content || `# ${planData?.topic || 'Plan'}\n\nNo file content available.`;
                if (typeof renderMarkdown === 'function') {
                    previewContent.innerHTML = renderMarkdown(md);
                } else {
                    previewContent.textContent = md;
                }
            } else {
                previewContent.textContent = 'Failed to load plan document.';
            }
        } catch (err) {
            previewContent.textContent = 'Error loading plan document.';
        }
    }

    // Bootstrap
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
