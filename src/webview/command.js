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
    let selectedMoveCardId = null;
    let selectedMoveSourceColumn = '';
    let selectedMoveTargetColumn = '';
    let dispatchStarredOnly = false;
    let moveStarredOnly = false;

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
    const dispatchCardsList = document.getElementById('dispatch-cards-list');
    const dispatchStarToggle = document.getElementById('dispatch-star-toggle');
    const dispatchSelectedTitle = document.getElementById('dispatch-selected-title');
    const dispatchStatusChip = document.getElementById('dispatch-status-chip');
    const btnDispatch = document.getElementById('btn-dispatch');

    // Move Elements
    const moveSourceColSelect = document.getElementById('move-source-column-select');
    const moveTargetColSelect = document.getElementById('move-target-column-select');
    const moveCardsList = document.getElementById('move-cards-list');
    const moveStarToggle = document.getElementById('move-star-toggle');
    const moveSelectedTitle = document.getElementById('move-selected-title');
    const moveStatusChip = document.getElementById('move-status-chip');
    const btnMove = document.getElementById('btn-move');

    // Mission Elements
    const btnNewMission = document.getElementById('btn-new-mission');
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
        refreshAllData();

        // Periodic background poll
        setInterval(() => {
            if (!document.hidden && !activeTerminalWs) {
                pollBackgroundState();
            }
        }, 5000);
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

            if (viewName === 'teams') {
                renderTeamsView();
            } else if (viewName === 'mission') {
                renderMissionView();
            }
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

        btnMove?.addEventListener('click', executeMove);

        // Mission events
        btnNewMission?.addEventListener('click', createNewMission);
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
            fetchBoardCards(),
            fetchMissionsState(),
            fetchTeamsState()
        ]);
        renderAllViews();
    }

    async function pollBackgroundState() {
        await Promise.all([
            fetchBoardCards(),
            fetchMissionsState(),
            fetchTeamsState()
        ]);
        renderAllViews();
    }

    // ── Data Fetching ──────────────────────────────────────────────────

    async function fetchColumns() {
        try {
            const res = await fetch(`/kanban/columns${currentWorkspaceRoot ? `?workspaceRoot=${encodeURIComponent(currentWorkspaceRoot)}` : ''}`);
            if (res.ok) {
                const payload = await res.json();
                // Every read endpoint answers { success, data } (_handleReadEndpoint),
                // and /kanban/columns' data is { builtIn, custom, displayOnly } — not an
                // array. Reading the body as an array left both column dropdowns empty.
                // `displayOnly` names no writable column, so it is deliberately excluded.
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
        const currentSource = moveSourceColSelect.value;
        const currentTarget = moveTargetColSelect.value;

        moveSourceColSelect.innerHTML = '';
        moveTargetColSelect.innerHTML = '';

        allColumns.forEach(col => {
            const opt1 = document.createElement('option');
            opt1.value = col.id;
            opt1.textContent = col.label || col.id;
            moveSourceColSelect.appendChild(opt1);

            const opt2 = document.createElement('option');
            opt2.value = col.id;
            opt2.textContent = col.label || col.id;
            moveTargetColSelect.appendChild(opt2);
        });

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

    async function fetchBoardCards() {
        try {
            const queryRoot = currentWorkspaceRoot ? `?workspaceRoot=${encodeURIComponent(currentWorkspaceRoot)}` : '';
            const res = await fetch(`/kanban/plans${queryRoot}`);
            if (res.ok) {
                const payload = await res.json();
                // { success, data: [...] } — the same envelope the CLI's board
                // commands had to be fixed for. Read as a bare array the board
                // was empty on every view.
                const data = (payload && payload.data !== undefined) ? payload.data : payload;
                if (Array.isArray(data)) {
                    allCards = data;
                    extractWorkspaceProjects(data);
                }
            }
        } catch (err) {
            console.warn('[Command] Failed to fetch cards:', err);
        }
    }

    function extractWorkspaceProjects(cards) {
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

            // Team definitions. `GET /terminals/standing-orders` answers
            // { success, available, orders, definitions } and has NO `groups` key —
            // reading one left the roster permanently empty. `ptyListAgentGroups` is
            // the verb the Terminals panel itself uses for this list, and it is one of
            // the two verbs reachable before the pty host is ready.
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

    function renderAllViews() {
        updateMissionLock();
        renderDispatchView();
        renderMoveView();
        renderMissionView();
        renderTeamsView();
    }

    function isMissionInFlight() {
        if (!activeMission) return false;
        // `runState` is derived server-side from member state and is the only
        // in-flight signal a mission record carries.
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
        const num = Number(score);
        if (!num || isNaN(num)) return 'comp-medium';
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
        return {
            ...rawCard,
            id: cardId,
            kanbanColumn: optColumn !== undefined ? optColumn : rawCard.kanbanColumn,
            priorityStarred: optStar !== undefined ? (optStar ? 1 : 0) : rawCard.priorityStarred,
        };
    }

    // ── 1. Dispatch View Rendering ─────────────────────────────────────

    function renderDispatchView() {
        if (!dispatchCardsList) return;
        dispatchCardsList.innerHTML = '';

        let cards = allCards.map(getEffectiveCard);

        // Project filter
        if (currentProject && currentProject !== '__unassigned__') {
            cards = cards.filter(c => c.project === currentProject);
        }

        // Exclude done/completed
        cards = cards.filter(c => c.kanbanColumn !== 'done' && c.kanbanColumn !== 'completed' && c.kanbanColumn !== 'archived');

        if (dispatchStarredOnly) {
            cards = cards.filter(c => Boolean(c.priorityStarred));
        }

        // Sort starred first, then complexity
        cards.sort((a, b) => {
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
            empty.textContent = 'No cards ready for dispatch.';
            dispatchCardsList.appendChild(empty);
            updateDispatchActionState();
            return;
        }

        cards.forEach(card => {
            const item = createCardItemElement(card, selectedDispatchCardId === card.id, (selectedCard) => {
                selectedDispatchCardId = selectedCard.id;
                renderDispatchView();
            });
            dispatchCardsList.appendChild(item);
        });

        updateDispatchActionState();
    }

    function updateDispatchActionState() {
        const locked = isMissionInFlight();
        const selectedCard = allCards.find(c => (c.planId || c.sessionId || c.id) === selectedDispatchCardId);

        if (selectedCard) {
            dispatchSelectedTitle.textContent = selectedCard.title || selectedCard.topic || selectedCard.planFile || 'Selected Card';
            if (locked) {
                dispatchStatusChip.textContent = 'Locked: Mission in flight';
                dispatchStatusChip.className = 'status-chip unknown';
                btnDispatch.disabled = true;
            } else {
                dispatchStatusChip.textContent = `Ready (${selectedCard.kanbanColumn || 'staging'})`;
                dispatchStatusChip.className = 'status-chip success';
                btnDispatch.disabled = false;
            }
        } else {
            dispatchSelectedTitle.textContent = 'None selected';
            dispatchStatusChip.textContent = 'Select a card';
            dispatchStatusChip.className = 'status-chip';
            btnDispatch.disabled = true;
        }
    }

    // ── 2. Move View Rendering ─────────────────────────────────────────

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
            cards = cards.filter(c => c.kanbanColumn === sourceCol || c.id === selectedMoveCardId);
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
                selectedMoveCardId = selectedCard.id;
                renderMoveView();
            });
            moveCardsList.appendChild(item);
        });

        updateMoveActionState();
    }

    function updateMoveActionState() {
        const locked = isMissionInFlight();
        const selectedCard = allCards.find(c => (c.planId || c.sessionId || c.id) === selectedMoveCardId);

        if (selectedCard) {
            const effective = getEffectiveCard(selectedCard);
            moveSelectedTitle.textContent = `${effective.title || effective.topic || 'Card'} (${effective.kanbanColumn})`;
            if (locked) {
                moveStatusChip.textContent = 'Locked: Mission in flight';
                moveStatusChip.className = 'status-chip unknown';
                btnMove.disabled = true;
            } else {
                moveStatusChip.textContent = `Ready to move -> ${selectedMoveTargetColumn || 'target'}`;
                moveStatusChip.className = 'status-chip success';
                btnMove.disabled = false;
            }
        } else {
            moveSelectedTitle.textContent = 'None selected';
            moveStatusChip.textContent = 'Select card and target column';
            moveStatusChip.className = 'status-chip';
            btnMove.disabled = true;
        }
    }

    // ── Card Item Builder ──────────────────────────────────────────────

    function createCardItemElement(card, isSelected, onSelect) {
        const item = document.createElement('div');
        item.className = `cmd-card-item${isSelected ? ' selected' : ''}`;

        const header = document.createElement('div');
        header.className = 'cmd-card-header';

        const title = document.createElement('span');
        title.className = 'cmd-card-title';
        title.textContent = card.title || card.topic || card.planFile || 'Untitled';
        header.appendChild(title);

        const badges = document.createElement('div');
        badges.className = 'cmd-card-badges';

        if (card.complexity) {
            const dot = document.createElement('span');
            dot.className = `complexity-dot ${getComplexityClass(card.complexity)}`;
            dot.textContent = String(card.complexity);
            badges.appendChild(dot);
        }

        // Plan rows carry no `subtaskCount`; the link is the subtask's own
        // `featureId`, so count the siblings rather than print a hardcoded 0.
        const subtaskCount = card.isFeature
            ? allCards.filter(c => c.featureId && c.featureId === card.planId).length
            : 0;
        if (card.isFeature) {
            const st = document.createElement('span');
            st.className = 'subtask-badge';
            st.textContent = `${subtaskCount} subtask${subtaskCount === 1 ? '' : 's'}`;
            badges.appendChild(st);
        }

        if (card.kanbanColumn) {
            const colBadge = document.createElement('span');
            colBadge.className = 'column-badge';
            colBadge.textContent = card.kanbanColumn;
            badges.appendChild(colBadge);
        }

        header.appendChild(badges);
        item.appendChild(header);

        const actions = document.createElement('div');
        actions.className = 'cmd-card-actions';

        const isStarred = Boolean(card.priorityStarred);
        const starBtn = document.createElement('button');
        starBtn.className = `btn-card-action${isStarred ? ' starred' : ''}`;
        starBtn.textContent = isStarred ? '★ Starred' : '☆ Star';
        starBtn.addEventListener('click', (ev) => {
            ev.stopPropagation();
            toggleCardStar(card.id, isStarred);
        });
        actions.appendChild(starBtn);

        const viewBtn = document.createElement('button');
        viewBtn.className = 'btn-card-action';
        viewBtn.textContent = 'View Plan';
        viewBtn.addEventListener('click', (ev) => {
            ev.stopPropagation();
            openDocumentPreview(card.id, card.planFile);
        });
        actions.appendChild(viewBtn);

        item.appendChild(actions);

        item.addEventListener('click', () => onSelect(card));
        return item;
    }

    // ── 3. Mission View Rendering ──────────────────────────────────────

    /**
     * A mission record carries `plans: string[]` and `features: string[]` (planIds)
     * and no `members` array, so every read of a mission `members` array resolved to
     * undefined and the view always reported "No members staged" — including
     * straight after a successful member add. Resolve each id against the board so
     * a member row can show its real title, its seat and its completion.
     */
    function missionMembers() {
        if (!activeMission) { return []; }
        const ids = [
            ...(Array.isArray(activeMission.plans) ? activeMission.plans.map(id => ({ id, kind: 'plan' })) : []),
            ...(Array.isArray(activeMission.features) ? activeMission.features.map(id => ({ id, kind: 'feature' })) : []),
        ];
        return ids.map(({ id, kind }) => {
            const card = allCards.find(c => (c.planId || c.sessionId) === id) || null;
            return {
                id,
                kind,
                title: card ? (card.topic || card.planFile || id) : id,
                // Both persisted on the plan row; the mission stores neither.
                seat: card ? (card.dispatchedTerminal || '') : '',
                dispatchedAt: card ? (card.dispatchedAt || null) : null,
                completed: Boolean(card && card.completedAt),
            };
        });
    }

    /** The mission's server-assigned codename lands in `name` (_uniqueCodename);
     *  there is no `codename` or `title` field on a mission record. */
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
            // A mission has no dispatch timestamp of its own; the run started when
            // its earliest member was dispatched.
            const stamps = members.map(m => m.dispatchedAt).filter(Boolean).map(v => new Date(v).getTime())
                .filter(n => Number.isFinite(n));
            const startedAt = stamps.length ? Math.min(...stamps) : 0;
            const elapsedSec = startedAt ? Math.max(0, Math.floor((Date.now() - startedAt) / 1000)) : 0;
            missionProgressElapsed.textContent = startedAt ? `Running for ${elapsedSec}s` : 'Running';

            missionProgressMembersList.innerHTML = '';
            if (members.length === 0) {
                missionProgressMembersList.innerHTML = '<div style="color:var(--text-secondary); font-size:12px;">No members listed.</div>';
            } else {
                members.forEach(m => {
                    const row = document.createElement('div');
                    row.className = 'team-roster-card';
                    row.style.minHeight = '40px';

                    const name = document.createElement('span');
                    name.style.fontSize = '12px';
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
                missionMembersList.innerHTML = '<div style="color:var(--text-secondary); font-size:12px; padding:8px 0;">No members staged. Add candidates below.</div>';
            } else {
                members.forEach(m => {
                    const row = document.createElement('div');
                    row.style.display = 'flex';
                    row.style.alignItems = 'center';
                    row.style.justifyContent = 'space-between';
                    row.style.padding = '6px 10px';
                    row.style.background = 'var(--panel-bg2)';
                    row.style.borderRadius = '4px';

                    const title = document.createElement('span');
                    title.style.fontSize = '12px';
                    title.textContent = m.title;
                    row.appendChild(title);

                    const removeBtn = document.createElement('button');
                    removeBtn.className = 'btn-card-action';
                    removeBtn.textContent = 'Remove';
                    removeBtn.addEventListener('click', () => removeMissionMember(m.id));
                    row.appendChild(removeBtn);

                    missionMembersList.appendChild(row);
                });
            }

            // Populate member candidate picker
            if (missionAddMemberSelect) {
                missionAddMemberSelect.innerHTML = '';
                const memberIds = new Set(members.map(m => m.id));
                const candidates = allCards.filter(c => !memberIds.has(c.planId || c.sessionId || c.id));
                candidates.forEach(c => {
                    const opt = document.createElement('option');
                    opt.value = c.planId || c.sessionId || c.id;
                    opt.textContent = `${c.title || c.topic || 'Card'} (${c.kanbanColumn || 'new'})`;
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
            // Never invent teams. A placeholder roster is indistinguishable from
            // real board state on a phone, and two of them shipped here.
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

    /** Mirror of terminals.js resolveArtForShell — art:/pack:/data: only. */
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

    /**
     * The live head of a declared team. A team definition names a `headRole`, not
     * a seat name — the seat is whichever live terminal holds that role, which is
     * the same predicate the Terminals panel's rail uses for its fixed slots. The
     * fleet projection emits `friendlyName` and `status`; it has no `name` and no
     * `working`, so both were read as undefined here and every team read DORMANT.
     */
    function resolveTeamHeadSeat(team) {
        const role = team.headRole || '';
        return liveFleet.find(t => t && t.status !== 'exited'
            && ((role && t.role === role) || (team.head && t.friendlyName === team.head))) || null;
    }

    /** Seats a declared team asks for: its head plus every member's count. */
    function declaredSeatCount(team) {
        const members = Array.isArray(team.members) ? team.members : [];
        return 1 + members.reduce((n, m) => n + (Number(m && m.count) || 0), 0);
    }

    /** Start a dormant team. Same verb and payload the desktop rail's dormant
     *  slot posts; a dormant row means "seat this team", never "open a terminal". */
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
                // The pty host is a real precondition on this route (a host without
                // node-pty answers here, it does not 503 the page) — state it.
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
        // A mission holds a team through the mission's own `team` field — mission
        // records carry `plans`/`features`/`team`, never a `members` array.
        const heldTeam = String(activeMission?.team || '');
        const isHeld = isMissionInFlight() && heldTeam !== ''
            && (heldTeam === team.id || heldTeam === team.name);
        // A dispatched plan is attributed to its seat, so a head holding a planId
        // is working. There is no `working` flag on the fleet projection.
        const isWorking = Boolean(liveSeat && liveSeat.planId);

        let stateLabel = 'IDLE';
        let stateClass = 'team-state-idle';
        if (isDormant) {
            stateLabel = 'DORMANT';
            stateClass = 'team-state-dormant';
        } else if (isHeld) {
            stateLabel = 'HELD BY MISSION';
            stateClass = 'team-state-held';
        } else if (isWorking) {
            stateLabel = 'WORKING';
            stateClass = 'team-state-working';
        }

        // Phone Roster Card
        if (teamsRosterList) {
            const card = document.createElement('div');
            card.className = `team-roster-card${isDormant ? ' is-dormant' : ''}`;

            const left = document.createElement('div');
            left.className = 'team-roster-left';

            const iconBox = document.createElement('div');
            iconBox.className = 'team-icon-box';
            const teamIconUri = resolveTeamIconUri(team.icon);
            if (teamIconUri) {
                const img = document.createElement('img');
                img.className = 'team-icon-img';
                img.src = teamIconUri;
                img.alt = '';
                iconBox.appendChild(img);
            } else {
                iconBox.textContent = (team.name || 'T').charAt(0).toUpperCase();
            }
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
            seats.textContent = `${seatCount} seat${seatCount > 1 ? 's' : ''} · Head: ${headName}`;
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

        // Tablet Rail Icon
        if (tabletTeamsRail) {
            const railBtn = document.createElement('button');
            railBtn.className = `nav-btn${isDormant ? ' is-dormant' : ''}`;
            railBtn.title = `${team.name} (${stateLabel})`;
            railBtn.style.width = '48px';
            railBtn.style.minHeight = '48px';
            railBtn.style.padding = '4px';

            const railIconUri = resolveTeamIconUri(team.icon);
            if (railIconUri) {
                const img = document.createElement('img');
                img.src = railIconUri;
                img.style.width = '20px';
                img.style.height = '20px';
                img.alt = '';
                railBtn.appendChild(img);
            } else {
                const glyph = document.createElement('span');
                glyph.textContent = (team.name || 'T').charAt(0).toUpperCase();
                glyph.style.fontFamily = 'GeistPixel, monospace';
                glyph.style.fontSize = '14px';
                glyph.style.color = 'var(--accent-primary)';
                railBtn.appendChild(glyph);
            }

            railBtn.addEventListener('click', () => {
                if (isDormant) {
                    seatTeam(team, railBtn);
                } else {
                    openTerminalViewer(team, headName);
                }
            });

            tabletTeamsRail.appendChild(railBtn);
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
                await fetchBoardCards();
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
                pendingMoves.delete(cardId);
                await fetchBoardCards();
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
        renderDispatchView();
        renderMoveView();

        try {
            const res = await fetch('/kanban/plans/priority', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    planId: cardId,
                    starred: nextStarred
                })
            });
            if (res.ok) {
                pendingStars.delete(cardId);
                await fetchBoardCards();
                renderDispatchView();
                renderMoveView();
            } else {
                pendingStars.delete(cardId);
            }
        } catch (err) {
            console.warn('[Command] Star toggle offline:', err);
        }
    }

    async function createNewMission() {
        try {
            btnNewMission.disabled = true;
            const res = await fetch('/kanban/mission/create', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    workspaceRoot: currentWorkspaceRoot
                })
            });
            if (res.ok) {
                await fetchMissionsState();
                renderMissionView();
            }
        } catch (err) {
            console.warn('[Command] Create mission failed:', err);
        } finally {
            btnNewMission.disabled = false;
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
                renderAllViews();
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
