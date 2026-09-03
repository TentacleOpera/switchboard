/*
 * Switchboard Command — Mobile & Touch-First Command Surface
 * Buttons and dropdowns only. No text input.
 */

(function () {
    'use strict';

    // Host capability contract — parsed once at module init, following
    // mission-control.js:6-9. An unparseable OR missing attribute degrades to
    // {} (every view available), never to a blank surface. Matches
    // transport.js:452's early-return on a falsy raw value.
    const HOST_CAPS = (() => {
        try { return JSON.parse(document.body.dataset.hostCapabilities || '{}'); }
        catch { return {}; }
    })();

    // State
    let currentWorkspaceRoot = '';
    let currentWorkspaceId = '';
    let currentProject = '__all__';
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

    // In-flight two-phase dispatch poll state. The command surface POSTs
    // /kanban/dispatch with { ack: true } and gets an ack the moment the
    // dispatch is committed (gate pre-flighted, move+delivery fired) — well
    // under a second — then polls /kanban/dispatch/state for prompt delivery.
    // The button re-enables after the ACK, not after the paced paste. Cancelled
    // on view switch, card change, and a new dispatch so no stale poll settles a
    // chip for a card the operator is no longer looking at.
    let activeDispatchPoll = null; // { planId, since, deadline, timer, stopped }

    // Feature Subtask Counts Cache
    const featureSubtaskCounts = new Map();

    // The column pickers are the whole reason the lists are short. They are filled by
    // fetchColumns (HTTP), while the board arrives on the WS push — and the push
    // routinely wins that race on a cold load. With no picker value the column filter
    // is a no-op, so the very first render would build a row for every card on the
    // board (thousands) and throw them all away milliseconds later when the columns
    // land and refreshAllData re-renders. Hold the lists until the pickers exist.
    // Set on completion, not on success: if the columns read fails there are no columns
    // to scope by and the unscoped list is the correct fallback, not a blank screen.
    let columnsResolved = false;

    let activeMission = null;
    let missionList = [];
    let selectedMissionId = null;
    let teamRoster = [];
    let liveFleet = [];
    let activeTerminalWs = null;
    let terminalOutputDecoder = typeof TextDecoder !== 'undefined' ? new TextDecoder('utf-8') : null;
    // The live seats for the team currently open in the viewer, so the seat
    // switcher can re-open the viewer for a different seat without re-resolving.
    let viewerLiveSeats = [];

    // Optimistic Ledger
    const pendingMoves = new Map(); // cardId -> targetColumn
    const pendingStars = new Map(); // cardId -> boolean

    // Elements
    const wsSelect = document.getElementById('workspace-project-select');
    const lockBanner = document.getElementById('mission-lock-banner');
    const lockMissionCodename = document.getElementById('lock-mission-codename');

    // Nav — built from a declared view list, each carrying the host capability
    // that governs it. A view whose capability is false is dropped from
    // viewPanes AND its buttons removed from both nav sets, so switchView's
    // `if (!viewPanes[viewName]) return` guard refuses it — the gated view is
    // unreachable, not merely CSS-hidden.
    //
    // Mission is governed by `automation`, not `mission-control`: the /command
    // MISSION view drives /kanban/queue/next (the queue pop), which is
    // orchestration. transport.js:499-508 records that `mission-control`
    // predates the Mission Control panel and that the panel is gated by
    // `automation`; the same reasoning applies here. Both hosts set the two
    // flags identically today (true on the extension, false on standalone), so
    // the choice is semantic, not behavioural — but guessing `mission-control`
    // would hide the view on a future host that splits the two.
    const VIEWS = [
        { name: 'dispatch', cap: null },
        { name: 'move', cap: null },
        { name: 'mission', cap: 'automation' },
        { name: 'teams', cap: 'terminalFleet' },
    ];

    function capabilityEnabled(cap) {
        if (!cap) return true;
        return HOST_CAPS[cap] !== false;
    }

    const availableViews = VIEWS.filter(v => capabilityEnabled(v.cap));
    const availableViewNames = new Set(availableViews.map(v => v.name));

    const viewPanes = {};
    availableViews.forEach(v => {
        const pane = document.getElementById(`view-${v.name}`);
        if (pane) viewPanes[v.name] = pane;
    });

    // Remove nav buttons for gated views from both nav sets before snapshotting
    // the survivors — querySelectorAll returns a static NodeList, so removal
    // must precede the capture.
    const phoneNavBar = document.getElementById('phone-nav-bar');
    const tabletRail = document.getElementById('tablet-rail');
    VIEWS.forEach(v => {
        if (availableViewNames.has(v.name)) return;
        phoneNavBar?.querySelectorAll(`.nav-btn[data-view="${v.name}"]`).forEach(btn => btn.remove());
        tabletRail?.querySelectorAll(`.nav-btn[data-view="${v.name}"]`).forEach(btn => btn.remove());
    });
    const phoneNavBtns = Array.from(phoneNavBar?.querySelectorAll('.nav-btn') || []);
    const tabletNavBtns = Array.from(tabletRail?.querySelectorAll('.nav-btn') || []);

    // If Teams is gated off, drop the tablet rail's teams section (divider +
    // header + list) too — it only populates when the Teams view renders, and
    // an orphaned "TEAMS" header over an empty list fails verification 6's
    // "lays out correctly with two nav entries".
    if (!availableViewNames.has('teams')) {
        tabletRail?.querySelector('.tablet-rail-divider')?.remove();
        tabletRail?.querySelector('.tablet-rail-teams-header')?.remove();
        document.getElementById('tablet-teams-rail')?.remove();
    }

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
    const missionSelect = document.getElementById('mission-select');
    const missionStatusChip = document.getElementById('mission-status-chip');
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
    const terminalSeatSwitcher = document.getElementById('terminal-seat-switcher');

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

        // Assert the default view survived gating. Dispatch is ungated so this
        // holds, but a future gate or a renamed default could strand the
        // operator on a blank pane — fall back to the first available view.
        if (!viewPanes[activeView]) {
            activeView = availableViews.length > 0 ? availableViews[0].name : activeView;
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

            // Leaving the dispatch view cancels its in-flight delivery poll so a
            // stale poll never settles a chip the operator can no longer see.
            cancelDispatchPoll();

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
            currentProject = opt.dataset.project || '__all__';
            selectedDispatchCardId = null;
            selectedMoveCardId = null;
            // Workspace switch invalidates any in-flight delivery poll — its
            // planId belongs to the previous workspace's board.
            cancelDispatchPoll();
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
            clearChip(dispatchStatusChip);
            renderDispatchView();
        });

        btnDispatchView?.addEventListener('click', () => {
            if (!selectedDispatchCardId) return;
            // The pushed card projection has NO `id` — getEffectiveCard synthesises one
            // from planId/sessionId for the rendered rows, and `selectedDispatchCardId`
            // already IS that value. Reading `.id` off a raw allCards entry here sent
            // `planId=undefined` and the preview always failed to load.
            const card = allCards.find(c => (c.planId || c.sessionId || c.id) === selectedDispatchCardId);
            if (card) openDocumentPreview(selectedDispatchCardId, card.planFile);
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
            clearChip(moveStatusChip);
            renderMoveView();
        });

        moveTargetColSelect?.addEventListener('change', () => {
            selectedMoveTargetColumn = moveTargetColSelect.value;
            updateMoveActionState();
        });

        btnMoveView?.addEventListener('click', () => {
            if (!selectedMoveCardId) return;
            // See btnDispatchView: `.id` is not a field of the pushed card.
            const card = allCards.find(c => (c.planId || c.sessionId || c.id) === selectedMoveCardId);
            if (card) openDocumentPreview(selectedMoveCardId, card.planFile);
        });

        btnMove?.addEventListener('click', executeMove);

        // Mission events
        btnLaunchMission?.addEventListener('click', launchActiveMission);
        missionSelect?.addEventListener('change', () => {
            selectedMissionId = missionSelect.value || null;
            clearChip(missionStatusChip);
            // Selecting a mission sets activeMission locally so the members
            // list and launch button reflect the operator's choice. The
            // board push refresh path (updateBoard → renderActiveView) will
            // re-derive activeMission from fetchMissionsState, but the
            // operator's selection is preserved via selectedMissionId
            // round-tripping in renderMissionView.
            activeMission = missionList.find(m => m.id === selectedMissionId) || activeMission;
            renderMissionView();
        });

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
            fetchMissionList(),
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
        } finally {
            columnsResolved = true;
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
            const label = root.split('/').filter(Boolean).pop() || root;

            // All-projects row — the widest view. Pinned as the cold-start default
            // below because a surface whose first job is to show you the board
            // should not narrow on reconnect. The reconnect path that reaches
            // the default is the `else if` branch at the bottom of this function,
            // hit on every updateBoard push whose previous selection is gone.
            const allOpt = document.createElement('option');
            allOpt.value = `${root}|__all__`;
            allOpt.textContent = `${label} (all)`;
            allOpt.dataset.workspaceRoot = root;
            allOpt.dataset.project = '__all__';
            wsSelect.appendChild(allOpt);

            // Unassigned row — plans with no project. Distinct from `__all__`
            // so the workspace name alone stops being a selectable value.
            const unassignedOpt = document.createElement('option');
            unassignedOpt.value = `${root}|__unassigned__`;
            unassignedOpt.textContent = `${label} (unassigned)`;
            unassignedOpt.dataset.workspaceRoot = root;
            unassignedOpt.dataset.project = '__unassigned__';
            wsSelect.appendChild(unassignedOpt);

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
            // Cold-start default: the `__all__` row for the first root. Pinning
            // the widest view here keeps the surface from silently narrowing to
            // unassigned on every reconnect that loses the previous selection.
            const allOpt = [...wsSelect.options].find(o => o.dataset.project === '__all__');
            if (allOpt) {
                wsSelect.value = allOpt.value;
            } else {
                wsSelect.selectedIndex = 0;
            }
            const chosen = wsSelect.selectedOptions[0];
            currentWorkspaceRoot = chosen?.dataset.workspaceRoot || currentWorkspaceRoot;
            currentProject = chosen?.dataset.project || '__all__';
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

    // Fetch the full mission list for the workspace's mission select. Uses
    // the existing GET /kanban/missions route (NOT /kanban/mission/active,
    // whose single-mission return shape fetchMissionsState depends on).
    // The select is populated from this list; selecting one sets
    // activeMission locally so the members list and launch button reflect
    // the operator's choice.
    async function fetchMissionList() {
        try {
            const queryRoot = currentWorkspaceRoot ? `?workspaceRoot=${encodeURIComponent(currentWorkspaceRoot)}` : '';
            const res = await fetch(`/kanban/missions${queryRoot}`);
            if (res.ok) {
                const data = await res.json();
                missionList = Array.isArray(data?.missions) ? data.missions : [];
            }
        } catch (err) {
            console.warn('[Command] Failed to fetch mission list:', err);
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

    // Project scoping for the command surface. One helper, two call sites
    // (renderDispatchView, renderMoveView). Replaces the inline
    // `currentProject !== '__unassigned__'` guards that overloaded
    // `__unassigned__` as both "no project" and "no filter". The mission
    // candidate picker was a third call site before the mission-composer
    // plan restructured the Mission view.
    //
    // Contract:
    //   `__all__`        → no filter (widest view)
    //   `__unassigned__` → cards whose project is empty in any representation
    //                      (`''`, `null`, `undefined`, or `'__unassigned__'`),
    //                      because the WS push projection can present a
    //                      project-less plan as any of the four depending on
    //                      which writer last touched the row
    //   otherwise        → exact project match
    function filterByProject(cards) {
        if (!currentProject || currentProject === '__all__') return cards;
        if (currentProject === '__unassigned__') {
            return cards.filter(c => !c.project || c.project === '__unassigned__');
        }
        return cards.filter(c => c.project === currentProject);
    }

    // ── 1. Dispatch View Rendering ─────────────────────────────────────

    function clearChip(chip) {
        if (!chip) return;
        chip.textContent = '';
        chip.className = 'status-chip hidden';
    }

    function selectDispatchCard(cardId) {
        selectedDispatchCardId = cardId;
        // Selecting a different card cancels any in-flight delivery poll for the
        // previous card — its chip would otherwise settle the wrong row.
        cancelDispatchPoll();
        clearChip(dispatchStatusChip);
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
        if (!columnsResolved) return;
        dispatchCardsList.innerHTML = '';

        let cards = allCards.map(getEffectiveCard);

        // Project filter
        cards = filterByProject(cards);

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
        clearChip(moveStatusChip);
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
        if (!columnsResolved) return;
        moveCardsList.innerHTML = '';

        let cards = allCards.map(getEffectiveCard);

        // Project filter
        cards = filterByProject(cards);

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
        title.textContent = card.topic || card.planFile || 'Untitled';
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

        // `subtaskCount` rides the push (KanbanProvider._buildBoardCards), counted
        // workspace-wide by KanbanDatabase.getSubtaskCountsByFeature. Prefer it: the
        // pushed `cards` array is already project/repo-scope filtered, so counting
        // siblings out of it drops every subtask living in another project and renders
        // "0 subtasks" on features that have plenty — the exact bug that method's
        // docblock exists to prevent. The local tally is the fallback for a push whose
        // builder omits the field.
        const subtaskCount = card.isFeature
            ? (typeof card.subtaskCount === 'number'
                ? card.subtaskCount
                : (featureSubtaskCounts.get(card.planId || card.id) || 0))
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
                // Every field below is read off the pushed card projection, not off a
                // KanbanPlanRecord — `title` and `completedAt` are NOT in that literal,
                // so the topic and the column are what actually answer here.
                title: card ? (card.topic || card.planFile || id) : id,
                seat: card ? (card.dispatchedTerminal || '') : '',
                dispatchedAt: card ? (card.dispatchedAt || null) : null,
                completed: Boolean(card && (card.kanbanColumn || card.column) === 'COMPLETED'),
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

            // ── Mission select ───────────────────────────────────────
            // Populate from missionList, round-tripping the operator's
            // selection across board pushes (same pattern as
            // populateColumnDropdowns). When the list is empty, render an
            // honest empty state and disable Launch — no enabled dropdown
            // over nothing, no dead button.
            if (missionSelect) {
                const prevValue = selectedMissionId || missionSelect.value;
                missionSelect.innerHTML = '';

                if (missionList.length === 0) {
                    const empty = document.createElement('option');
                    empty.value = '';
                    empty.textContent = 'No missions for this workspace';
                    empty.disabled = true;
                    empty.selected = true;
                    missionSelect.appendChild(empty);
                    selectedMissionId = null;
                    activeMission = null;
                } else {
                    missionList.forEach(m => {
                        const opt = document.createElement('option');
                        opt.value = m.id;
                        opt.textContent = m.name || m.id;
                        missionSelect.appendChild(opt);
                    });
                    // Round-trip: keep the previous selection if it still
                    // exists; otherwise default to the first mission.
                    if (prevValue && [...missionSelect.options].some(o => o.value === prevValue)) {
                        missionSelect.value = prevValue;
                        selectedMissionId = prevValue;
                    } else {
                        missionSelect.selectedIndex = 0;
                        selectedMissionId = missionSelect.value || null;
                    }
                    activeMission = missionList.find(m => m.id === selectedMissionId) || null;
                }
            }

            // ── Members list (read-only) ─────────────────────────────
            missionMembersList.innerHTML = '';

            if (missionList.length === 0) {
                // No missions exist — name where they are created, not a
                // dead dropdown. The desktop board is where mission
                // creation lives (the design study struck out the name
                // field from this surface).
                missionMembersList.innerHTML = '<div style="color:var(--text-secondary); font-size:12px; padding:12px; text-align:center;">No missions exist for this workspace. Create one on the desktop board.</div>';
            } else {
                const members = missionMembers();
                if (members.length === 0) {
                    missionMembersList.innerHTML = '<div style="color:var(--text-secondary); font-size:12px; padding:12px; text-align:center;">This mission has no members.</div>';
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
            }

            // ── Launch button state ──────────────────────────────────
            if (btnLaunchMission) {
                btnLaunchMission.disabled = !activeMission || missionList.length === 0;
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

        // ORDERING, not pre-filtering, is what stops a seed stealing a real
        // team's seat. `resolveTeamSeats` claims in the order it is handed, and
        // stored order alone decides who wins a headRole: KanbanProvider PUSHES
        // any missing default into the persisted array (`:4961`), so on a
        // workspace that already had the operator's team the seeds come last,
        // but on a fresh install the seeds are seeded FIRST and the operator's
        // later team is appended behind them. Sort non-seeds ahead of seeds so
        // attribution does not depend on which existed first. The sort is
        // stable, so real teams keep their stored order among themselves.
        const claimOrder = teamRoster
            .map((team, i) => ({ team, i, seed: SEED_TEAM_IDS.has(team.id) ? 1 : 0 }))
            .sort((a, b) => (a.seed - b.seed) || (a.i - b.i))
            .map(entry => entry.team);
        const resolvedSeats = resolveTeamSeats(claimOrder, liveFleet);

        // Hide unstarted seeds: a seed id with no declared members AND no
        // RESOLVED head. Resolution runs FIRST (above) precisely so this test
        // is "did a live seat actually fall to this team" and not "does some
        // seat of this role exist anywhere in the fleet". The latter is the role
        // match this plan exists to delete — it made the `feature-implementation`
        // seed render as a second "Lead team" row on every workspace with a live
        // lead, which is the duplicate row that was reported. A seed the
        // operator started or added members to renders normally, and it claims
        // its seat above. Nothing is written to storage.
        const visibleTeams = teamRoster.filter(team => {
            if (!SEED_TEAM_IDS.has(team.id)) { return true; }
            if (Array.isArray(team.members) && team.members.length > 0) { return true; }
            return Boolean(resolvedSeats.get(team.id)?.head);
        });

        visibleTeams.forEach(team => {
            renderTeamRow(team, resolvedSeats);
        });
    }

    // Fixed role→art map. `headRole` is persisted operator-controlled data,
    // so the role arm MUST map through this allow-list and never interpolate
    // the raw role string into a path — otherwise the static serve route
    // becomes a traversal vector. An unknown role falls through to nav-jet.
    const TEAM_ROLE_ART = {
        lead: '/static/icons/team-lead.png',
        coder: '/static/icons/team-coder.png',
        reviewer: '/static/icons/team-reviewer.png',
        planner: '/static/icons/team-planner.png',
        intern: '/static/icons/team-intern.png',
    };

    /**
     * Resolve a team's icon URI through the full fallback chain:
     *   1. explicit `data:` / `art:` / `pack:` value → as today,
     *   2. else `role` through the fixed `TEAM_ROLE_ART` allow-list,
     *   3. else `/static/icons/nav-jet.svg`.
     * The role arm is what gives every non-kanban document role-distinct art
     * without needing the inline `<symbol>` portraits kanban.html owns.
     */
    function resolveTeamArt(iconValue, role) {
        const v = String(iconValue || '').trim();
        if (v) {
            if (v.startsWith('data:')) { return v; }
            if (v.startsWith('art:')) {
                const name = v.slice('art:'.length).trim();
                return name ? '/static/icons/' + encodeURIComponent(name) + '.png' : null;
            }
            if (v.startsWith('pack:')) {
                const file = v.slice('pack:'.length).trim();
                return file ? '/static/icons/' + encodeURIComponent(file) : null;
            }
        }
        const roleArt = TEAM_ROLE_ART[String(role || '').trim()];
        if (roleArt) { return roleArt; }
        return '/static/icons/nav-jet.svg';
    }

    // The three DEFAULT_TEAM_DEFINITIONS ids that ship as member-less seeds.
    // Used to hide unstarted seeds from the roster — never to delete them.
    const SEED_TEAM_IDS = new Set(['planning-team', 'feature-implementation', 'review-team']);

    /**
     * Resolve every team's head seat and member seats in a single exclusive
     * pass over the live fleet. Replaces the old per-team
     * `resolveTeamHeadSeat`, which matched by role alone and let two
     * lead-headed teams claim the same live seat.
     *
     * MEMBER membership is by `parentInstanceId` (the instance chain the rest
     * of the system already uses), NOT by role: a member seat's
     * `parentInstanceId` points at its head's `agentInstanceId`.
     *
     * HEAD attribution is still role-based, with exclusive claim. Arm 1 below
     * is a defensive path that this data source cannot currently reach:
     * `ptyListAgentGroups` serves `terminals.agentGroups`
     * (`KanbanProvider.peekAgentGroups`), and the only writer of that key —
     * the TEAMS-tab save literal in `kanban.html` — emits
     * `{id, name, headRole, members, prompt?, headPrompt?, icon?, …}` and NO
     * `head`. `head` is stamped by `wireSpawnedTeam` into a DIFFERENT key,
     * `switchboard.prompts.terminals.groups`, which no webview verb exposes.
     * So in practice every head resolves through arm 2, and WHICH team wins a
     * shared headRole is decided by the order this function is handed (see
     * `renderTeamsView`'s claimOrder). Making head attribution genuinely
     * membership-based needs the live-groups key on the wire.
     *
     * Resolution order per team:
     *   1. A live seat whose `friendlyName` equals `team.head` — defensive
     *      only; `team.head` is absent from this data source (see above).
     *   2. A live seat of `team.headRole` not already claimed by an earlier team.
     *
     * Claimed seats are removed from the pool as the pass proceeds, so no seat
     * is ever attributed to two teams. Members are the live seats whose
     * `parentInstanceId` matches the resolved head's `agentInstanceId`.
     *
     * @param teams  The team roster in claim order (non-seeds first).
     * @param fleet  The live fleet from ptyListTerminals.
     * @returns Map<teamId, { head: fleetEntry|null, members: fleetEntry[] }>
     */
    function resolveTeamSeats(teams, fleet) {
        // Work on a copy so claiming (splicing) does not mutate the caller's array.
        const pool = fleet.filter(t => t && t.status !== 'exited');
        const result = new Map();
        for (const team of teams) {
            const role = team.headRole || '';
            // 1. Explicit head name match.
            let head = null;
            if (team.head) {
                const idx = pool.findIndex(t => t.friendlyName === team.head);
                if (idx !== -1) {
                    head = pool[idx];
                    pool.splice(idx, 1);
                }
            }
            // 2. First live seat of headRole not already claimed.
            if (!head && role) {
                const idx = pool.findIndex(t => t.role === role);
                if (idx !== -1) {
                    head = pool[idx];
                    pool.splice(idx, 1);
                }
            }
            // Members: live seats whose parentInstanceId matches the head's agentInstanceId.
            let members = [];
            if (head && head.agentInstanceId) {
                members = pool.filter(t => t.parentInstanceId === head.agentInstanceId);
            }
            result.set(team.id, { head, members });
        }
        return result;
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

    function renderTeamRow(team, resolvedSeats) {
        const resolved = resolvedSeats?.get(team.id) || { head: null, members: [] };
        const liveSeat = resolved.head;
        const memberSeats = resolved.members || [];
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

        const teamIconUri = resolveTeamArt(team.icon, team.headRole);

        // All live seats for this team (head + members), for the viewer.
        const allLiveSeats = liveSeat ? [liveSeat, ...memberSeats] : [];

        // Helper: render a tappable seat row (used in both phone and tablet).
        // stopPropagation so the card-level click (seat team / open viewer) does
        // not also fire when a specific seat is tapped.
        function createSeatRow(seat, isHead) {
            const row = document.createElement('div');
            row.className = 'team-seat-row';
            row.style.cssText = 'display:flex;align-items:center;gap:6px;padding:4px 8px;cursor:pointer;'
                + 'border-top:1px solid var(--border-color);min-height:32px;';
            const roleLabel = isHead ? 'head' : (seat.role || 'member');
            // Seat art resolves through the same chain as the team icon, keyed
            // on the seat's own role — a coder row and an intern row draw
            // distinct art from their lead's. No explicit `icon` on a seat.
            const seatIcon = document.createElement('img');
            seatIcon.src = resolveTeamArt(null, seat.role);
            seatIcon.alt = '';
            seatIcon.style.cssText = 'width:18px;height:18px;flex-shrink:0;object-fit:contain;';
            row.appendChild(seatIcon);
            const seatLabel = document.createElement('span');
            seatLabel.style.cssText = 'font-size:11px;color:var(--text-primary);flex:1;';
            const planTag = seat.planId ? ` · ${seat.planId.length > 12 ? seat.planId.slice(0, 10) + '…' : seat.planId}` : '';
            seatLabel.textContent = `${roleLabel}: ${seat.friendlyName}${planTag}`;
            row.appendChild(seatLabel);
            const stateDot = document.createElement('span');
            const hasPlan = Boolean(seat.planId);
            stateDot.style.cssText = 'width:6px;height:6px;border-radius:50%;flex-shrink:0;'
                + `background:${hasPlan ? 'var(--accent-success, #4caf50)' : 'var(--text-secondary)'}`;
            row.appendChild(stateDot);
            row.addEventListener('click', (e) => {
                e.stopPropagation();
                openTerminalViewer(team, seat.friendlyName, allLiveSeats);
            });
            return row;
        }

        // Phone Roster Card
        if (teamsRosterList) {
            const card = document.createElement('div');
            card.className = `team-roster-card${isDormant ? ' is-dormant' : ''}`;
            // Head line wrapper: the card stacks (head line, then seat rows), so
            // the row-level flex layout lives here, not on the card.
            const headline = document.createElement('div');
            headline.className = 'team-roster-headline';
            card.appendChild(headline);

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
            // Declared seat count stays from the declared roster; the live rows
            // below show what is actually live. Label the difference so it is
            // legible rather than confusing.
            const liveCount = allLiveSeats.length;
            seats.textContent = `${seatCount} declared \u00b7 ${liveCount} live \u00b7 Head: ${headName}`;
            info.appendChild(seats);

            left.appendChild(info);
            headline.appendChild(left);

            const stateBadge = document.createElement('span');
            stateBadge.className = `team-state-badge ${stateClass}`;
            stateBadge.textContent = stateLabel;
            headline.appendChild(stateBadge);

            // Live seat rows (head first, then members) — only when not dormant.
            if (liveSeat) {
                card.appendChild(createSeatRow(liveSeat, true));
                memberSeats.forEach(seat => {
                    card.appendChild(createSeatRow(seat, false));
                });
            }

            card.addEventListener('click', () => {
                if (isDormant) {
                    seatTeam(team, null);
                } else {
                    openTerminalViewer(team, headName, allLiveSeats);
                }
            });

            teamsRosterList.appendChild(card);
        }

        // Tablet Rail Team Card
        if (tabletTeamsRail) {
            const railItem = document.createElement('div');
            railItem.className = `team-roster-card${isDormant ? ' is-dormant' : ''}`;
            // Same stacking as the phone card. The tighter rail metrics belong
            // to the head line, not the card — on the card they would also
            // indent every seat row.
            const railHeadline = document.createElement('div');
            railHeadline.className = 'team-roster-headline';
            railHeadline.style.minHeight = '44px';
            railHeadline.style.padding = '6px 8px';
            railItem.appendChild(railHeadline);

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
            const liveCount = allLiveSeats.length;
            seats.textContent = `${seatCount} declared \u00b7 ${liveCount} live`;
            info.appendChild(seats);

            left.appendChild(info);
            railHeadline.appendChild(left);

            const stateBadge = document.createElement('span');
            stateBadge.className = `team-state-badge ${stateClass}`;
            stateBadge.style.fontSize = '9px';
            stateBadge.style.padding = '2px 6px';
            stateBadge.textContent = stateLabel;
            railHeadline.appendChild(stateBadge);

            // Live seat rows on tablet too — head first, then members.
            if (liveSeat) {
                railItem.appendChild(createSeatRow(liveSeat, true));
                memberSeats.forEach(seat => {
                    railItem.appendChild(createSeatRow(seat, false));
                });
            }

            railItem.addEventListener('click', () => {
                if (isDormant) {
                    seatTeam(team, null);
                } else {
                    openTerminalViewer(team, headName, allLiveSeats);
                }
            });

            tabletTeamsRail.appendChild(railItem);
        }
    }

    // ── 5. Actions Execution ───────────────────────────────────────────

    // Cancel any in-flight dispatch poll. Called on view switch, card change,
    // and before starting a new dispatch, so a stale poll never settles a chip
    // for a card the operator is no longer looking at. Leaves the chip as-is —
    // the caller decides what to show next.
    function cancelDispatchPoll() {
        if (activeDispatchPoll) {
            activeDispatchPoll.stopped = true;
            if (activeDispatchPoll.timer) {
                clearTimeout(activeDispatchPoll.timer);
            }
            activeDispatchPoll = null;
        }
    }

    // Poll /kanban/dispatch/state for the second phase (prompt delivery) of an
    // acked dispatch. 1s interval, capped at the server-supplied deadline (60s).
    // Settles the chip to success (delivered) or unknown (deadline passed) and
    // stops itself. No-op if the poll was cancelled or superseded.
    function pollDispatchDelivery(planId, since, deadline) {
        cancelDispatchPoll();
        const poll = { planId, since, deadline, timer: null, stopped: false };
        activeDispatchPoll = poll;
        const DISPATCH_POLL_INTERVAL_MS = 1000;

        const tick = async () => {
            if (poll.stopped) return;
            // Deadline passed — settle to unknown and stop. The wording matches
            // the synchronous 502 vocabulary; "unknown" is a UI timeout, not a
            // delivery verdict (the prompt may still be pasting).
            if (Date.now() >= deadline) {
                if (activeDispatchPoll === poll) {
                    dispatchStatusChip.textContent = 'Delivery status uncertain — the prompt may still be pasting. Check the terminal agent.';
                    dispatchStatusChip.className = 'status-chip unknown';
                    activeDispatchPoll = null;
                }
                return;
            }
            try {
                const params = new URLSearchParams({
                    planId,
                    since: since === null ? '' : String(since),
                    deadline: String(deadline)
                });
                if (currentWorkspaceRoot) params.set('workspaceRoot', currentWorkspaceRoot);
                const res = await fetch(`/kanban/dispatch/state?${params.toString()}`);
                const result = await res.json().catch(() => null);
                if (poll.stopped || activeDispatchPoll !== poll) return;
                if (!res.ok || !result) {
                    // Transient poll error — keep the pending chip and retry.
                    poll.timer = setTimeout(tick, DISPATCH_POLL_INTERVAL_MS);
                    return;
                }
                if (result.state === 'dispatched') {
                    activeDispatchPoll = null;
                    // `seat` is the receiving terminal's name; `dispatchedAgent`
                    // can be 'unknown', an IDE-shaped string or a bare role
                    // word, so prefer the seat.
                    dispatchStatusChip.textContent = `Dispatched to ${result.seat || result.dispatchedAgent || 'agent'}`;
                    dispatchStatusChip.className = 'status-chip success';
                    renderDispatchView();
                    return;
                }
                if (result.state === 'unknown') {
                    activeDispatchPoll = null;
                    dispatchStatusChip.textContent = result.error || 'Delivery status uncertain — the prompt may still be pasting. Check the terminal agent.';
                    dispatchStatusChip.className = 'status-chip unknown';
                    return;
                }
                // 'delivering' — poll again. Upgrade the chip the first time the
                // server can name the receiving seat (the ack could not when
                // routing had no origin terminal).
                if (result.seat) {
                    dispatchStatusChip.textContent = `Dispatched — ${result.seat} is receiving the prompt`;
                    dispatchStatusChip.className = 'status-chip pending';
                }
                poll.timer = setTimeout(tick, DISPATCH_POLL_INTERVAL_MS);
            } catch {
                if (poll.stopped || activeDispatchPoll !== poll) return;
                poll.timer = setTimeout(tick, DISPATCH_POLL_INTERVAL_MS);
            }
        };
        // Kick the first poll immediately so a fast delivery settles quickly.
        poll.timer = setTimeout(tick, 0);
    }

    async function executeDispatch() {
        if (!selectedDispatchCardId || isMissionInFlight()) return;
        const cardId = selectedDispatchCardId;
        const card = allCards.find(c => (c.planId || c.sessionId || c.id) === cardId);
        if (!card) return;

        // A new dispatch supersedes any in-flight poll for a previous card.
        cancelDispatchPoll();

        // Apply immediate optimistic state (< 100ms)
        dispatchStatusChip.textContent = 'Dispatching agent...';
        dispatchStatusChip.className = 'status-chip pending';
        btnDispatch.disabled = true;

        try {
            // ack: true → the server returns as soon as the dispatch is committed
            // (gate pre-flighted, move+delivery fired), not after the paced paste.
            const res = await fetch('/kanban/dispatch', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    plan: cardId,
                    workspaceRoot: currentWorkspaceRoot,
                    ack: true
                })
            });

            const result = await res.json().catch(() => null);
            // The acked variant returns { success: true, phase: 'dispatching', ... }
            // for a committed dispatch; 4xx/5xx (gate refusal, no terminals, etc.)
            // arrive immediately with today's wording and no success chip.
            if (res.ok && result?.success !== false && result?.phase === 'dispatching') {
                // The ack carries a SEAT name only when team-scoped routing
                // resolved one (`teamOverride`); a plain dispatch from this
                // surface has no origin terminal, so the receiving terminal is
                // chosen downstream and is not known yet. Say "the <role> seat"
                // in that case — putting the role in the seat's slot would make
                // a fallback read exactly like a resolved seat name. The poll
                // upgrades the chip once the real name lands.
                const seatName = result?.seat || '';
                dispatchStatusChip.textContent = seatName
                    ? `Dispatched — ${seatName} is receiving the prompt`
                    : `Dispatched — the ${result?.role || 'agent'} seat is receiving the prompt`;
                dispatchStatusChip.className = 'status-chip pending';
                // Re-enable the button: the operator is NOT blocked for the paste.
                btnDispatch.disabled = false;
                renderDispatchView();
                // Second phase: poll for prompt delivery, settle to success/unknown.
                pollDispatchDelivery(
                    result.planId || cardId,
                    result.dispatchedAtBefore ?? null,
                    result.deadline || (Date.now() + 60000)
                );
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
                await Promise.all([fetchMissionsState(), fetchMissionList()]);
                renderMissionView();
            }
        } catch (err) {
            console.warn('[Command] Remove member failed:', err);
        }
    }

    // The `from` for POST /kanban/queue/next — the terminal whose team the pop
    // resolves membership from, and the origin its team-scoped routing and
    // one-in-one-out in-flight predicate both key on.
    //
    // The route REQUIRES it: `dispatchNextFromQueue` returns
    // 400 "Missing required field: from (the requesting head's terminal name)"
    // when it is absent. This surface has always posted `workspaceRoot` alone,
    // which is why LAUNCH MISSION has never dispatched a card — the button was
    // not merely unreported, it was refused before it reached the queue.
    //
    // Precedence mirrors the desktop Run-queue button (KanbanProvider resolves
    // the coding head, then falls back to any live coding terminal, and treats
    // "no live seat" as an error rather than an auto-start): the selected
    // mission's own team head first, then any live lead, then any live coder.
    // Returns '' when nothing is live so the caller can say so instead of
    // posting a request that cannot succeed.
    function resolveLaunchOriginSeat() {
        const live = liveFleet.filter(t => t && t.status !== 'exited' && t.friendlyName);
        if (live.length === 0) { return ''; }
        const missionTeam = String(activeMission?.team || '').trim();
        if (missionTeam) {
            const team = teamRoster.find(t => t && (t.id === missionTeam || t.name === missionTeam));
            if (team) {
                const head = resolveTeamSeats([team], live).get(team.id)?.head;
                if (head?.friendlyName) { return head.friendlyName; }
            }
        }
        return live.find(t => t.role === 'lead')?.friendlyName
            || live.find(t => t.role === 'coder')?.friendlyName
            || '';
    }

    // Launch the active mission by popping the next staged card from the
    // queue. Reads the parsed response body (not just res.ok) and writes a
    // mission status chip so the operator sees the outcome without going
    // back to the desktop board.
    //
    // Settle timing: the /kanban/queue/next response carries the dispatch
    // result (which card popped, which seat received it) but NOT the full
    // updated mission state. So the chip is written from the response body
    // immediately, and a delayed fetchMissionsState() (500ms) lets the
    // queue pop settle before re-reading mission state — not a blind
    // immediate re-fetch (the original bug), and not "from the response"
    // (which doesn't carry mission state). The board push via updateBoard
    // is the authoritative refresh path.
    async function launchActiveMission() {
        if (!activeMission) return;
        const from = resolveLaunchOriginSeat();
        if (!from) {
            setMissionChip('No agent terminal is live — open a lead or coder seat before launching.', 'unknown');
            return;
        }
        if (btnLaunchMission) { btnLaunchMission.disabled = true; }
        try {
            const res = await fetch('/kanban/queue/next', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    workspaceRoot: currentWorkspaceRoot,
                    from
                })
            });

            const body = await res.json().catch(() => null);

            if (res.ok && body?.success !== false) {
                // Dispatched → card topic + receiving seat
                if (body?.dispatched) {
                    const card = body.dispatched;
                    const topic = card.topic || card.planId || 'card';
                    const seat = card.dispatchedAgent || 'agent';
                    setMissionChip(`Dispatched: ${topic} → ${seat}`, 'success');
                } else if (body?.dispatched === null) {
                    // Nothing staged / nothing ready — the server's reason
                    // verbatim (e.g. "queue empty")
                    const reason = body?.reason || 'Nothing ready';
                    setMissionChip(reason, 'unknown');
                } else {
                    setMissionChip('Launch outcome unknown', 'unknown');
                }
            } else {
                // Refusal (team in flight, no seat on the origin team,
                // dependency blocked) — the server's human-readable error
                // text, not a machine code.
                const errMsg = body?.error || 'Launch refused';
                setMissionChip(errMsg, 'unknown');
            }

            // Delayed re-fetch: let the queue pop settle before re-reading
            // mission state. The board push (updateBoard) is the
            // authoritative refresh path.
            setTimeout(() => { fetchMissionsState().then(() => renderMissionView()); }, 500);
        } catch (err) {
            console.warn('[Command] Launch failed:', err);
            setMissionChip('Outcome unknown (connection dropped)', 'unknown');
        } finally {
            if (btnLaunchMission) { btnLaunchMission.disabled = false; }
        }
    }

    function setMissionChip(text, cls) {
        if (!missionStatusChip) return;
        missionStatusChip.textContent = text;
        missionStatusChip.className = `status-chip ${cls || 'unknown'}`;
        missionStatusChip.classList.remove('hidden');
    }

    // ── 6. Read-Only Terminal Viewer ───────────────────────────────────

    /**
     * Open the read-only terminal viewer for a specific seat. Takes a seat
     * name (not a team + head pair), titles the pane, fetches scrollback, and
     * opens a solo WebSocket. The optional `seatList` populates the seat
     * switcher in the viewer header so the operator can switch to any live
     * seat of the same team — each switch routes back through this function,
     * which calls closeActiveWs immediately before opening the new socket, so
     * the previous one is closed first and there is never a window with two
     * simultaneous sockets. Nothing between re-entry and that call opens a
     * socket (the scrollback fetch is plain HTTP), so one switch is one socket.
     */
    function openTerminalViewer(team, seatName, seatList) {
        const name = seatName || team.name;
        // Store the live seats for the switcher (head + members).
        viewerLiveSeats = Array.isArray(seatList) ? seatList : [];

        terminalViewerTitle.textContent = `Terminal: ${name}`;
        terminalStreamOutput.textContent = 'Connecting to terminal stream...\n';

        // Build the seat switcher — one button per live seat, highlighting the
        // one currently open. Hidden when there is only one seat (or none).
        if (terminalSeatSwitcher) {
            terminalSeatSwitcher.innerHTML = '';
            if (viewerLiveSeats.length > 1) {
                terminalSeatSwitcher.style.display = 'flex';
                for (const seat of viewerLiveSeats) {
                    const btn = document.createElement('button');
                    const isActive = seat.friendlyName === name;
                    btn.textContent = seat.friendlyName;
                    btn.style.cssText = 'font-size:10px;padding:2px 8px;border-radius:4px;cursor:pointer;'
                        + 'border:1px solid var(--border-color);background:'
                        + (isActive ? 'var(--accent-primary, #4a9eff)' : 'var(--panel-bg)')
                        + ';color:' + (isActive ? '#fff' : 'var(--text-primary)');
                    btn.addEventListener('click', (e) => {
                        e.stopPropagation();
                        // Route through this same function — it closes the
                        // previous socket immediately before opening the new
                        // one. No separate socket-opening path.
                        openTerminalViewer(team, seat.friendlyName, viewerLiveSeats);
                    });
                    terminalSeatSwitcher.appendChild(btn);
                }
            } else {
                terminalSeatSwitcher.style.display = 'none';
            }
        }

        // Hide other panes, show viewer
        Object.values(viewPanes).forEach(p => p.classList.remove('active'));
        paneTerminalViewer.classList.add('active');

        // Fetch initial scrollback log
        fetch(`/terminals/${encodeURIComponent(name)}/log`)
            .then(res => res.text())
            .then(logText => {
                if (logText) {
                    terminalStreamOutput.textContent = logText + '\n--- Live Stream ---\n';
                    terminalStreamOutput.scrollTop = terminalStreamOutput.scrollHeight;
                }
            })
            .catch(() => {});

        // Connect WebSocket — closeActiveWs runs FIRST so no socket leak.
        closeActiveWs();
        const wsProtocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsUrl = `${wsProtocol}//${location.host}/ws/terminal?name=${encodeURIComponent(name)}&solo=1`;

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
        viewerLiveSeats = [];
        if (terminalSeatSwitcher) {
            terminalSeatSwitcher.innerHTML = '';
            terminalSeatSwitcher.style.display = 'none';
        }
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
