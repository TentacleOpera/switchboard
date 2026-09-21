/*
 * Switchboard Command — Mobile & Touch-First Command Surface
 * Buttons and dropdowns only. No text input.
 */

(function () {
    'use strict';

    // ── Pure functions (extracted for unit testing) ───────────────────
    // These have NO closure or DOM dependencies. Defined first so a Node
    // require can export them and return BEFORE the DOM-bound initialisation
    // below throws on the missing `document` global. The browser path falls
    // through to the full init.

    // Pure: filter cards by a project selector. See `filterByProject` below
    // for the closure-bound wrapper the UI calls.
    function filterByProjectFor(cards, project) {
        if (!project || project === '__all__') return cards;
        if (project === '__unassigned__') {
            return cards.filter(c => !c.project || c.project === '__unassigned__');
        }
        return cards.filter(c => c.project === project);
    }

    // Pure: resolve live fleet seats to teams in claim order. `team.head`
    // (the live head seat name) takes precedence over `headRole` matching.
    function resolveTeamSeats(teams, fleet) {
        const pool = fleet.filter(t => t && t.status !== 'exited');
        const result = new Map();
        for (const team of teams) {
            const role = team.headRole || '';
            let head = null;
            if (team.head) {
                const idx = pool.findIndex(t => t.friendlyName === team.head);
                if (idx !== -1) {
                    head = pool[idx];
                    pool.splice(idx, 1);
                }
            }
            // NO ROLE FALLBACK. A team's head is the seat its registered group row
            // names, or the team has no head. Matching on role adopted a stranger:
            // a dormant `coder`-headed team claimed a live coder that belonged to
            // another team, and reported "1 live" for a team running nothing. A team
            // is a head and ITS seats — membership is the group row, never a role
            // coincidence, and an unassigned agent is not a team member.
            //
            // Narrowing the match to unparented terminals is not enough either: a
            // lone unassigned agent of the right role is unparented too, and would
            // still be adopted by a team that never started it.

            let members = [];
            if (head && head.agentInstanceId) {
                members = pool.filter(t => t.parentInstanceId === head.agentInstanceId);
            }
            result.set(team.id, { head, members });
        }
        return result;
    }

    // Node test harness: export the pure functions and stop here so the
    // DOM-bound initialisation below does not throw on the missing
    // `document` global. The browser ignores this guard.
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = { resolveTeamSeats, filterByProjectFor };
        return;
    }

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

    let selectedDispatchCardIds = new Set();
    let selectedDispatchColumn = '';
    let selectedMoveCardIds = new Set();
    let selectedMoveSourceColumn = '';
    let selectedMoveTargetColumn = '';
    let dispatchStarredOnly = false;
    let moveStarredOnly = false;

    // In-flight two-phase dispatch poll state — one entry per dispatched card.
    // The command surface POSTs /kanban/dispatch with { ack: true } and gets an
    // ack the moment the dispatch is committed (gate pre-flighted, move+delivery
    // fired) — well under a second — then polls /kanban/dispatch/state for
    // prompt delivery. The button re-enables after the ACK, not after the paced
    // paste. All polls cancel together on view switch, card change, and a new
    // dispatch so no stale poll settles a chip for a card the operator is no
    // longer looking at.
    const activeDispatchPolls = new Map(); // planId -> { planId, eventSince, deadline, timer, stopped }
    // Aggregate for the current dispatch round — the chip reports per-card
    // outcomes ("dispatched 3/5; 2 refused"), never a single-card verdict for
    // a multi-card gesture.
    let dispatchRound = null; // { total, pending, settled: Map<planId, {state, label}> }

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
    // Why `liveFleet` is empty, when it is. An unread fleet and a genuinely empty
    // one must not render the same — see the DORMANT bug below.
    let fleetReadError = '';
    // The interactive terminal viewer state. The viewport controller
    // (window.SwitchboardTerminalViewport) owns the xterm instance and its
    // WebSocket; command.js holds only the controller and the per-seat
    // terminalsMap it shares with it. The key bar controller synthesizes
    // control keys the phone keyboard cannot type.
    let terminalViewport = null;
    let terminalKeyBar = null;
    let terminalTerminalsMap = null;
    // The live seats for the team currently open in the viewer, so the seat
    // switcher can re-open the viewer for a different seat without re-resolving.
    let viewerLiveSeats = [];

    // Optimistic Ledger
    const pendingMoves = new Map(); // cardId -> targetColumn
    const pendingStars = new Map(); // cardId -> boolean

    // Agent control surface state (mobile) — mirrors the dock's control
    // surface. No conversation history and no free-text input: every action
    // is a button or a dropdown; the only model call is the explicit Resolve
    // action on a selected card. No pty, no terminal.
    let agentModelConfigured = false;
    let agentSending = false;
    let agentBoardCache = [];
    let agentControlInitialized = false;

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
        // Agent control surface — API-backed, no pty, phone-safe. Always
        // available (no capability gate): the controller reaches the same
        // /agent/control endpoints the desktop dock uses. See plan:
        // the-dock-agent-tab-is-a-control-surface-not-a-terminal.
        { name: 'agent', cap: null },
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
    const dispatchTriggerState = document.getElementById('dispatch-trigger-state');
    const btnDispatchView = document.getElementById('btn-dispatch-view');
    const btnDispatch = document.getElementById('btn-dispatch');

    // The composer is a standing tab in the agent dock now (dock.html /
    // dockComposer.js), not a modal in this document — the button posts
    // openDockTab to the shell. See plan the-composer-is-a-modal-you-have-
    // to-summon-make-it-a-dock-tab.
    const btnComposer = document.getElementById('btn-composer');

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
    // The interactive terminal viewer uses the shared xterm viewport
    // (terminalViewport.js), not the hand-rolled <pre> stream box. The
    // viewport module appends its own container inside the host element.
    const terminalXtermHost = document.getElementById('terminal-xterm-host');
    const terminalKeyBarEl = document.getElementById('terminal-key-bar');
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
        void refreshDispatchTriggerState();
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
        } else if (msg.type === 'terminalsChanged' || msg.type === 'terminalsGroupsChanged') {
            // A seat was created, exited, renamed, or its team roster changed.
            // The TEAMS view is drawn from the live fleet, so it is stale the
            // moment this arrives and nothing else re-reads it: refreshAllData
            // runs on load and on nothing else, which is why starting a team
            // used to need a page reload before the card stopped saying DORMANT.
            //
            // Refetch rather than patching from the message: the payload carries
            // no terminal rows, and a team's live state is the fleet joined to
            // the group roster, not a field to mutate.
            void fetchTeamsState().then(() => { renderActiveView(); });
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

            // Leaving the dispatch view cancels its in-flight delivery polls so a
            // stale poll never settles a chip the operator can no longer see.
            cancelDispatchPoll();

            // Entering the dispatch view re-reads the gate state — it can have
            // been toggled on the board surface since the last visit.
            if (viewName === 'dispatch') { void refreshDispatchTriggerState(); }

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
            selectedDispatchCardIds.clear();
            selectedMoveCardIds.clear();
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
            if (selectedDispatchCardIds.size === 0) return;
            const firstId = selectedDispatchCardIds.values().next().value;
            const card = allCards.find(c => (c.planId || c.sessionId || c.id) === firstId);
            if (card) openDocumentPreview(firstId, card.planFile);
        });

        btnDispatch?.addEventListener('click', executeDispatch);

        // The composer lives in the dock now — the button opens the dock on
        // the Composer tab via the shell. With no shell parent (standalone
        // document) the post lands on this same window and is ignored.
        btnComposer?.addEventListener('click', () => {
            try {
                window.parent.postMessage({ type: 'openDockTab', tab: 'composer' }, location.origin);
            } catch { /* no shell parent — nothing to open */ }
        });

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
            if (selectedMoveCardIds.size === 0) return;
            const firstId = selectedMoveCardIds.values().next().value;
            const card = allCards.find(c => (c.planId || c.sessionId || c.id) === firstId);
            if (card) openDocumentPreview(firstId, card.planFile);
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
                    // A column whose agent is switched off is not a destination. `enabled`
                    // absent (older host) ⇒ keep it: never hide a stage on a stale field.
                    return c.enabled !== false;
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
                fleetReadError = '';
            } else {
                // A FAILED READ IS NOT AN EMPTY FLEET. Measured 2026-09-20: with a
                // `workspaceRoot` the host does not recognise, this POST returns
                // HTTP 400 `UNKNOWN_WORKSPACE_ROOT`. `fleetRes.ok` was the only
                // thing checked, so `liveFleet` silently kept its initial `[]` and
                // EVERY team rendered `0 live · DORMANT` — including one that was
                // running with its intern. Pressing START then drew the host's
                // correct refusal, "already running", on a card that said DORMANT.
                //
                // Retry unscoped before giving up: the host resolves its own known
                // root when none is supplied, and that is the right answer far more
                // often than "no seats exist". The error is still reported either
                // way, so a degraded read never passes as a clean one.
                let detail = `fleet read failed (HTTP ${fleetRes.status})`;
                try {
                    const errBody = await fleetRes.json();
                    if (errBody && errBody.error) { detail = String(errBody.error); }
                } catch { /* non-JSON error body — keep the status line */ }
                let recovered = false;
                try {
                    const retryRes = await fetch('/terminals/verb/ptyListTerminals', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({})
                    });
                    if (retryRes.ok) {
                        const retryData = await retryRes.json();
                        if (Array.isArray(retryData?.terminals)) {
                            liveFleet = retryData.terminals;
                            recovered = true;
                        }
                    }
                } catch { /* retry failed — fall through to the error state */ }
                fleetReadError = recovered
                    ? `Showing all seats — this workspace was not recognised: ${detail}`
                    : detail;
                if (!recovered) { liveFleet = []; }
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
                // The host names its own shipped defaults; we never guess.
                if (groupsData && Array.isArray(groupsData.defaultTeamIds)) {
                    SEED_TEAM_IDS = new Set(groupsData.defaultTeamIds.filter(id => typeof id === 'string'));
                }
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
        } else if (activeView === 'agent') {
            // The agent control surface loads its config once on first render;
            // it does not need a per-render refresh (no list to repopulate).
            if (!agentControlInitialized) {
                agentControlInitialized = true;
                void loadAgentControlConfigMobile();
            }
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

        // V81: the lock is display-only — an in-flight mission shows its
        // progress view, but it must not disable dispatch. The board never
        // refuses a dispatch; a duplicate dispatch resets the card.
        btnDispatch.disabled = selectedDispatchCardIds.size === 0;
        btnMove.disabled = selectedMoveCardIds.size === 0;
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
        return filterByProjectFor(cards, currentProject);
    }

    // ── 1. Dispatch View Rendering ─────────────────────────────────────

    function clearChip(chip) {
        if (!chip) return;
        chip.textContent = '';
        chip.className = 'status-chip hidden';
    }

    function selectDispatchCard(cardId) {
        if (selectedDispatchCardIds.has(cardId)) {
            selectedDispatchCardIds.delete(cardId);
        } else {
            selectedDispatchCardIds.add(cardId);
        }
        cancelDispatchPoll();
        clearChip(dispatchStatusChip);
        renderDispatchView();
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
            cards = cards.filter(c => (c.kanbanColumn || c.column) === dispatchCol || selectedDispatchCardIds.has(c.id));
        }

        if (dispatchStarredOnly) {
            cards = cards.filter(c => Boolean(c.priorityStarred) || selectedDispatchCardIds.has(c.id));
        }

        // Sort starred first, then complexity
        cards.sort((a, b) => {
            const aSel = selectedDispatchCardIds.has(a.id);
            const bSel = selectedDispatchCardIds.has(b.id);
            if (aSel && !bSel) return -1;
            if (!aSel && bSel) return 1;
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
            const item = createCardItemElement(card, selectedDispatchCardIds.has(card.id), (selectedCard) => {
                selectDispatchCard(selectedCard.id);
            });
            dispatchCardsList.appendChild(item);
        });

        updateDispatchActionState();
    }

    function updateDispatchActionState() {
        const locked = isMissionInFlight();
        const hasSelection = selectedDispatchCardIds.size > 0;

        if (btnDispatchView) {
            btnDispatchView.disabled = !hasSelection;
        }

        if (hasSelection) {
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
        if (selectedMoveCardIds.has(cardId)) {
            selectedMoveCardIds.delete(cardId);
        } else {
            selectedMoveCardIds.add(cardId);
        }
        clearChip(moveStatusChip);
        renderMoveView();
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
            cards = cards.filter(c => (c.kanbanColumn || c.column) === sourceCol || selectedMoveCardIds.has(c.id));
        }

        if (moveStarredOnly) {
            cards = cards.filter(c => Boolean(c.priorityStarred) || selectedMoveCardIds.has(c.id));
        }

        // Starred first, then moved card rises to top if it was acted on
        cards.sort((a, b) => {
            const aSel = selectedMoveCardIds.has(a.id);
            const bSel = selectedMoveCardIds.has(b.id);
            if (aSel && !bSel) return -1;
            if (!aSel && bSel) return 1;
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
            const item = createCardItemElement(card, selectedMoveCardIds.has(card.id), (selectedCard) => {
                selectMoveCard(selectedCard.id);
            });
            moveCardsList.appendChild(item);
        });

        updateMoveActionState();
    }

    function updateMoveActionState() {
        const locked = isMissionInFlight();
        const hasSelection = selectedMoveCardIds.size > 0;

        if (btnMoveView) {
            btnMoveView.disabled = !hasSelection;
        }

        if (hasSelection) {
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
                seat: card ? (card.ownerSeat || '') : '',
                ownerSince: card ? (card.ownerSince || null) : null,
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
            const stamps = members.map(m => m.ownerSince).filter(Boolean).map(v => new Date(v).getTime())
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
        // Say so when the roster below was drawn against a fleet we could not read.
        // Without this the operator sees a confident DORMANT on a live team.
        if (fleetReadError) { setTeamNotice(fleetReadError); }

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
    // SVG, not PNG. These were `team-*.png` and every one of them 404'd: the art
    // was converted to SVG (the originals are parked in `icons/_replaced-team-pngs/`)
    // and this table was never updated, so each card rendered a broken-image glyph.
    // A local copy of an asset list is a copy that cannot be updated with the assets.
    const TEAM_ROLE_ART = {
        lead: '/static/icons/team-lead.svg',
        coder: '/static/icons/team-coder.svg',
        reviewer: '/static/icons/team-reviewer.svg',
        planner: '/static/icons/team-planner.svg',
        intern: '/static/icons/team-intern.svg',
    };

    /**
     * A seat's icon is its CLI BRAND, not its role — a Devin coder and a Claude
     * coder are different agents and the roster should say so.
     *
     * The table comes from the HOST, as `data-brand-icon-*` body attributes
     * (`headlessPanelHtml.ts`), the same table the terminals panel reads. The
     * command panel was not being given it, which is why seat rows fell back to
     * role art in the first place. Read it; do not rebuild it here.
     */
    function resolveSeatBrandArt(cliFamily) {
        const ds = (document.body && document.body.dataset) || {};
        const fam = String(cliFamily || '').trim().toLowerCase();
        // dataset camel-cases `data-brand-icon-claude` to `brandIconClaude`.
        const key = fam ? 'brandIcon' + fam.charAt(0).toUpperCase() + fam.slice(1) : '';
        // An unknown or absent family is an explicit default, never a guess at
        // which CLI this is.
        return (key && ds[key]) || ds.brandIconDefault || null;
    }

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
                return name ? '/static/icons/' + encodeURIComponent(name) + '.svg' : null;
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

    // The three DEFAULT_TEAM_DEFINITIONS ids that ship as starter seeds.
    // Used to hide unstarted seeds from the roster — never to delete them.
    // FROM THE HOST, not typed here. `ptyListAgentGroups` already returns
    // `defaultTeamIds`, derived from DEFAULT_TEAM_DEFINITIONS, and its own comment
    // says why: "the shipped default ids ... come from DEFAULT_TEAM_DEFINITIONS, so
    // a roster edit changes them by construction. The webviews consume these rather
    // than keeping their own copy."
    //
    // This was a hard-coded list of THREE while the product shipped FIVE, so
    // `coding-team` and `multi-agent-planning` were treated as operator-made: never
    // hidden when unstarted, and sorted ahead of real seeds in the claim order. A
    // custom team also had no way to be anything but a non-seed, which is the other
    // half of why a typed list is the wrong mechanism.
    let SEED_TEAM_IDS = new Set();

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
     * `switchboard.prompts.terminals.groups`, which `ptyListAgentGroups` now
     * attaches to each definition row (see `resolveLiveGroupHeads`), so arm 1
     * is reachable when a team is live. So in practice every head resolves
     * through arm 1 when live, arm 2 when dormant; and WHICH team wins a
     * shared headRole is decided by the order this function is handed (see
     * `renderTeamsView`'s claimOrder).
     *
     * Resolution order per team:
     *   1. A live seat whose `friendlyName` equals `team.head` — the live head
     *      seat name `ptyListAgentGroups` now serves.
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
    // `resolveTeamSeats` is defined at the top of this IIFE (pure, exported for
    // unit tests). The docblock above documents its contract.

    function declaredSeatCount(team) {
        const members = Array.isArray(team.members) ? team.members : [];
        return 1 + members.reduce((n, m) => n + (Number(m && m.count) || 0), 0);
    }

    // `seatTeam` is deleted. The command view does not start teams — the rail and
    // the TERMINALS panel own that gesture. It existed only because a card tap fell
    // through to it when the view believed a team was dormant, which is how a stale
    // roster turned "open this team" into "start this team", and then into the host
    // telling the operator to shut down a team that was already running.
    //
    // A surface that cannot start a team cannot show a start refusal.


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
        if (isDormant && fleetReadError && liveFleet.length === 0) {
            // "We could not read the fleet" is not "this team is not running".
            stateLabel = 'UNKNOWN';
            stateClass = 'team-state-dormant';
        } else if (isDormant) {
            stateLabel = 'DORMANT';
            stateClass = 'team-state-dormant';
        } else if (isHeld) {
            stateLabel = 'HELD';
            stateClass = 'team-state-held';
        } else if (isWorking) {
            stateLabel = 'WORKING';
            stateClass = 'team-state-working';
        }

        // `jet` is a team's own art override (Multi-agent planning ships one so it
        // is tellable apart from Planning — both are planner-headed). It rides
        // through the groups payload as a plain field; role art is the fallback.
        const teamIconUri = resolveTeamArt(
            team.icon || (team.jet ? `art:team-${team.jet}` : null),
            team.headRole
        );

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
            // Brand first — a seat IS a CLI. Role art is the fallback for a seat
            // whose family the fleet could not identify.
            seatIcon.src = resolveSeatBrandArt(seat.cliFamily) || resolveTeamArt(null, seat.role);
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
                // A CARD TAP OPENS THE TEAM. IT NEVER STARTS ONE.
                //
                // This used to call `seatTeam` whenever the view believed the team
                // was dormant, so tapping a card to LOOK at its terminals silently
                // tried to start a team. When the view was stale about a running
                // team — which it is, because it derives liveness from a fleet
                // snapshot — the host correctly refused with "Team X is already
                // running as Y. Stop it first", and the operator was told to shut
                // down a team they could see running, having never asked to start
                // anything.
                //
                // Teams are not started from the command view. The rail and the
                // TERMINALS panel own that gesture. A surface that does not offer
                // starting cannot show a start refusal.
                openTerminalViewer(team, headName, allLiveSeats);
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
                // Opens the team. Never starts one — see the card handler above.
                openTerminalViewer(team, headName, allLiveSeats);
            });

            tabletTeamsRail.appendChild(railItem);
        }
    }

    // ── 5. Actions Execution ───────────────────────────────────────────

    // Cancel every in-flight dispatch poll. Called on view switch, card change,
    // and before starting a new dispatch, so a stale poll never settles a chip
    // for a card the operator is no longer looking at. Leaves the chip as-is —
    // the caller decides what to show next.
    function cancelDispatchPoll() {
        for (const poll of activeDispatchPolls.values()) {
            poll.stopped = true;
            if (poll.timer) { clearTimeout(poll.timer); }
        }
        activeDispatchPolls.clear();
    }

    // Fold the per-card poll outcomes into the single status chip. Each entry
    // is { state, label }; the chip reports counts, never one card's verdict
    // for a multi-card dispatch.
    function updateDispatchChip() {
        if (!dispatchRound) return;
        const { total, settled } = dispatchRound;
        const pending = total - settled.size;
        const counts = { delivered: 0, 'not-delivered': 0, refused: 0, unknown: 0 };
        for (const r of settled.values()) { counts[r.state] = (counts[r.state] || 0) + 1; }
        if (pending > 0) {
            dispatchStatusChip.textContent = `Dispatching — ${settled.size}/${total} settled${counts.refused ? `, ${counts.refused} refused` : ''}`;
            dispatchStatusChip.className = 'status-chip pending';
            return;
        }
        const parts = [];
        if (counts.delivered) parts.push(`${counts.delivered} delivered`);
        if (counts['not-delivered']) parts.push(`${counts['not-delivered']} not delivered`);
        if (counts.refused) parts.push(`${counts.refused} refused`);
        if (counts.unknown) parts.push(`${counts.unknown} uncertain`);
        dispatchStatusChip.textContent = `Dispatched ${counts.delivered}/${total}` + (parts.length > 1 ? ` — ${parts.join(', ')}` : '');
        dispatchStatusChip.className = counts.delivered === total
            ? 'status-chip success'
            : (counts.delivered === 0 ? 'status-chip error' : 'status-chip unknown');
    }

    function settleDispatchPoll(planId, state, label) {
        activeDispatchPolls.delete(planId);
        if (dispatchRound) {
            dispatchRound.settled.set(planId, { state, label });
            updateDispatchChip();
        }
        if (activeDispatchPolls.size === 0) {
            selectedDispatchCardIds.clear();
            renderDispatchView();
        }
    }

    // Poll /kanban/dispatch/state for the second phase (prompt delivery) of one
    // acked dispatch. 1s interval, capped at the server-supplied deadline (60s).
    // States are the shared vocabulary: sent (in flight) / delivered /
    // not-delivered (with reason) / unknown (UI timeout — NOT a delivery
    // verdict; the prompt may still be pasting). Per-card — a multi-card
    // dispatch runs one poll per planId.
    function pollDispatchDelivery(planId, eventSince, deadline) {
        const poll = { planId, eventSince, deadline, timer: null, stopped: false };
        activeDispatchPolls.set(planId, poll);
        const DISPATCH_POLL_INTERVAL_MS = 1000;

        const tick = async () => {
            if (poll.stopped) return;
            if (Date.now() >= deadline) {
                if (activeDispatchPolls.get(planId) === poll) {
                    settleDispatchPoll(planId, 'unknown', 'Delivery status uncertain — the prompt may still be pasting. Check the terminal agent.');
                }
                return;
            }
            try {
                const params = new URLSearchParams({
                    planId,
                    deadline: String(deadline)
                });
                // eventSince is the append-only event baseline — the evidence the
                // state endpoint scopes the verdict to. `since` is the legacy
                // ownerSince contract, kept only when the server sent no baseline.
                if (typeof eventSince === 'number') {
                    params.set('eventSince', String(eventSince));
                } else {
                    params.set('since', '');
                }
                if (currentWorkspaceRoot) params.set('workspaceRoot', currentWorkspaceRoot);
                const res = await fetch(`/kanban/dispatch/state?${params.toString()}`);
                const result = await res.json().catch(() => null);
                if (poll.stopped || activeDispatchPolls.get(planId) !== poll) return;
                if (!res.ok || !result) {
                    // Transient poll error — keep the pending entry and retry.
                    poll.timer = setTimeout(tick, DISPATCH_POLL_INTERVAL_MS);
                    return;
                }
                if (result.state === 'delivered') {
                    settleDispatchPoll(planId, 'delivered', result.seat || result.dispatchedAgent || 'agent');
                    return;
                }
                if (result.state === 'not-delivered') {
                    settleDispatchPoll(planId, 'not-delivered', result.error || 'delivery failed');
                    return;
                }
                if (result.state === 'unknown') {
                    settleDispatchPoll(planId, 'unknown', result.error || 'Delivery status uncertain — the prompt may still be pasting. Check the terminal agent.');
                    return;
                }
                // 'sent' — delivery still in flight; poll again.
                poll.timer = setTimeout(tick, DISPATCH_POLL_INTERVAL_MS);
            } catch {
                if (poll.stopped || activeDispatchPolls.get(planId) !== poll) return;
                poll.timer = setTimeout(tick, DISPATCH_POLL_INTERVAL_MS);
            }
        };
        // Kick the first poll immediately so a fast delivery settles quickly.
        poll.timer = setTimeout(tick, 0);
    }

    // Read the board-move trigger setting for the indicator. This is an
    // honest read of the scoped store via the kanban verb route — the
    // getSetting verb resolves `kanban.*` keys through the provider's tiered
    // resolver (with legacy-key migration), never through the prompts prefix.
    async function refreshDispatchTriggerState() {
        if (!dispatchTriggerState) return;
        try {
            const res = await fetch('/kanban/verb/getSetting', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ key: 'kanban.boardMoveCliTriggersEnabled' })
            });
            const result = await res.json().catch(() => null);
            if (!res.ok || !result || result.success === false) {
                dispatchTriggerState.textContent = 'board-move triggers: ?';
                dispatchTriggerState.title = 'Could not read kanban.boardMoveCliTriggersEnabled — ' + (result?.error || `HTTP ${res.status}`);
                return;
            }
            const on = result.value === true;
            dispatchTriggerState.textContent = `board-move triggers: ${on ? 'on' : 'off'}`;
            dispatchTriggerState.title = `kanban.boardMoveCliTriggersEnabled = ${on}` +
                (result.source ? ` (${result.source})` : '') +
                ' — gates board drag/move gestures only; DISPATCH always fires.';
        } catch {
            dispatchTriggerState.textContent = 'board-move triggers: ?';
            dispatchTriggerState.title = 'kanban.boardMoveCliTriggersEnabled unreadable (offline)';
        }
    }

    async function executeDispatch() {
        if (selectedDispatchCardIds.size === 0) return;

        // A new dispatch supersedes every in-flight poll from a previous round.
        cancelDispatchPoll();

        const planIds = [...selectedDispatchCardIds];
        dispatchRound = { total: planIds.length, settled: new Map() };
        dispatchStatusChip.textContent = planIds.length === 1 ? 'Dispatching card...' : `Dispatching ${planIds.length} cards...`;
        dispatchStatusChip.className = 'status-chip pending';
        btnDispatch.disabled = true;

        // One gesture is N explicit dispatches — /kanban/dispatch is single-card
        // by contract, and per-card acks are what let the report say
        // "dispatched 3/5; 2 refused" instead of one hollow success. No
        // targetColumn: the endpoint complexity-routes each card itself; the
        // source-column selector in this view is a FILTER, not a target.
        for (const planId of planIds) {
            try {
                const res = await fetch('/kanban/dispatch', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        plan: planId,
                        ack: true,
                        workspaceRoot: currentWorkspaceRoot
                    })
                });
                const result = await res.json().catch(() => null);
                if (!res.ok || !result || result.success === false) {
                    const err = result?.error || `dispatch refused (HTTP ${res.status})`;
                    dispatchRound.settled.set(planId, { state: 'refused', label: err });
                    updateDispatchChip();
                    continue;
                }
                // Acked: move committed, delivery in flight. Poll for the second
                // phase; the event baseline scopes the verdict to THIS attempt.
                pollDispatchDelivery(
                    result.planId || planId,
                    typeof result.dispatchEventBaseline === 'number' ? result.dispatchEventBaseline : null,
                    result.deadline || (Date.now() + 60000)
                );
            } catch (err) {
                dispatchRound.settled.set(planId, { state: 'refused', label: 'dispatch failed (offline)' });
                updateDispatchChip();
            }
        }
        btnDispatch.disabled = false;
        updateDispatchChip();
        // Nothing acked — every card refused at the gate. Clear selection only
        // when at least one dispatch is actually in flight.
        if (activeDispatchPolls.size === 0) {
            dispatchStatusChip.className = dispatchStatusChip.textContent.startsWith('Dispatched 0/')
                ? 'status-chip error'
                : dispatchStatusChip.className;
        }
    }

    async function executeMove() {
        if (selectedMoveCardIds.size === 0) return;
        const targetCol = selectedMoveTargetColumn;
        if (!targetCol) return;

        const cardIds = [...selectedMoveCardIds];
        // Apply immediate optimistic DOM move (< 100ms)
        for (const cardId of cardIds) {
            pendingMoves.set(cardId, targetCol);
        }
        moveStatusChip.textContent = cardIds.length === 1
            ? `Moved to ${targetCol} (syncing...)`
            : `Moved ${cardIds.length} cards to ${targetCol} (syncing...)`;
        moveStatusChip.className = 'status-chip pending';
        renderMoveView();

        try {
            // One operator gesture is ONE request: the route takes `planIds[]` and
            // reports per-card results (207 on a partial batch). A client-side loop
            // would turn one tap into N unsynchronised moves.
            const res = await fetch('/kanban/move', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    planIds: cardIds,
                    targetColumn: targetCol,
                    workspaceRoot: currentWorkspaceRoot
                })
            });
            const body = await res.json().catch(() => null);
            const perCard = Array.isArray(body?.results) ? body.results : [];
            const failed = perCard.filter(r => !r.success);
            // Roll back the optimistic move for the cards that did not land, so a
            // failed row never sits in a column the board does not agree with.
            for (const r of failed) {
                pendingMoves.delete(r.id);
            }
            const allOk = res.ok && body?.success === true;
            if (!allOk && !perCard.length) {
                for (const cardId of cardIds) {
                    pendingMoves.delete(cardId);
                }
            }
            const lastBody = failed.length ? { error: failed.map(r => `${r.id}: ${r.error || 'move refused'}`).join('; ') } : body;

            if (allOk) {
                moveStatusChip.textContent = cardIds.length === 1
                    ? `Moved to ${targetCol}`
                    : `Moved ${cardIds.length} cards to ${targetCol}`;
                moveStatusChip.className = 'status-chip success';
                selectedMoveCardIds.clear();
                renderMoveView();
            } else {
                moveStatusChip.textContent = lastBody?.seam === 'moveCard'
                    ? 'Move unavailable on this host (not a card problem)'
                    : (lastBody?.error || 'Move failed on server');
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
        // Scope the pop to the mission being launched. Without it the pop is
        // workspace-wide and can start another mission's card — launching A
        // would dispatch B. The server validates the id against this workspace.
        //
        // No id means no scoped launch: say so rather than posting an unscoped
        // pop, which would look like a launch and behave like the leak.
        const missionId = activeMission.id || activeMission.missionId;
        if (!missionId) {
            setMissionChip('This mission has no id — cannot launch it without scoping the pop to it.', 'unknown');
            return;
        }
        if (btnLaunchMission) { btnLaunchMission.disabled = true; }
        try {
            const res = await fetch('/kanban/queue/next', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    workspaceRoot: currentWorkspaceRoot,
                    from,
                    missionId
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
                    // verbatim ("queue empty", or "queue empty for mission
                    // <id>" for this scoped launch)
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

    // ── 6. Interactive Terminal Viewer ─────────────────────────────────

    /**
     * Resolve the PTY host origin for the terminal WebSocket. Mirrors
     * terminals.js: the body data-attribute (injected by the host) wins,
     * then the legacy global, then the page's own origin. The standalone
     * host injects NO data-pty-host-origin (loopback would break remote
     * viewers); the extension host injects ws://127.0.0.1:<port>. Both
     * paths are covered by this fallback chain.
     */
    function resolvePtyHostOrigin() {
        return (document.body && document.body.dataset && document.body.dataset.ptyHostOrigin)
            || window.__SB_PTY_HOST_ORIGIN__
            || `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}`;
    }

    let terminalFitLadderGen = null;
    let terminalWorkingSilenceShown = null;

    /** Frames the layout takes to settle after a soft-keyboard show/hide or a
     *  rotation. Each step re-fits; a newer ladder for the same seat supersedes
     *  the older one through the shared fitLadderGen map, which the viewport's
     *  own ResizeObserver also reads to avoid running a second ladder for the
     *  same reflow (terminalViewport.js:1588). */
    const TERMINAL_FIT_LADDER_STEPS_MS = [0, 60, 200, 500];

    /**
     * Re-fit the open terminal to its container and re-report the size to the
     * pty. Generation-guarded: a resize that lands mid-ladder bumps the gen and
     * the older steps drop out rather than fighting the newer box.
     */
    function runTerminalFitLadder(name) {
        if (!terminalViewport || !terminalFitLadderGen || !terminalTerminalsMap) { return; }
        const gen = (terminalFitLadderGen.get(name) || 0) + 1;
        terminalFitLadderGen.set(name, gen);
        for (const delay of TERMINAL_FIT_LADDER_STEPS_MS) {
            setTimeout(() => {
                if (terminalFitLadderGen.get(name) !== gen) { return; }
                const entry = terminalTerminalsMap.get(name);
                if (!entry || entry.disposed) { return; }
                try { terminalViewport.fitAndReportSize(entry); } catch { /* disposed mid-fit */ }
            }, delay);
        }
    }

    /**
     * Repaint the terminal's renderer after a grid resize. Same body as the
     * terminals panel's resyncPaneRenderer — it reads only entry.container and
     * entry.term, so there is nothing panel-specific to drop. `rebuildAtlas`
     * defaults to true so callers that pass no options behave as the panel's do.
     */
    function resyncTerminalRenderer(entry, verdict, options) {
        if (!entry || !entry.term) { return; }
        try { void entry.container.getBoundingClientRect(); } catch { /* ignore */ }
        if (!options || options.rebuildAtlas !== false) {
            try { entry.term.clearTextureAtlas(); } catch { /* ignore */ }
        }
        try { entry.term.refresh(0, Math.max(0, entry.term.rows - 1)); } catch { /* ignore */ }
        if (verdict !== 'stale-canvas') { return; }
        try {
            entry.term._core._renderService.handleResize(entry.term.cols, entry.term.rows);
        } catch { /* ignore */ }
    }

    /**
     * Build the deps bag for the shared terminal viewport. The viewport
     * module (terminalViewport.js) is embedder-independent: every
     * dependency is a constructor argument. The command view provides a
     * minimal bag — the panel-only callbacks (caret ring, pane assignments,
     * fit ladder, startup curtain) are no-ops, because the command view
     * renders ONE terminal, not a grid. The load-bearing deps (terminalsMap,
     * ptyHostOrigin, fitLadderGen, getFleetList, workingSilenceShown) are
     * real so the viewport's resize/replay/answerback machinery fires.
     */
    function buildTerminalViewportDeps() {
        // One entry at a time, but the viewport module shares a single
        // terminalsMap across every view it owns, so the map persists across
        // seat switches and the destroy/create cycle cleans up properly.
        if (!terminalTerminalsMap) { terminalTerminalsMap = new Map(); }
        if (!terminalFitLadderGen) { terminalFitLadderGen = new Map(); }
        if (!terminalWorkingSilenceShown) { terminalWorkingSilenceShown = new Set(); }
        return {
            terminalsMap: terminalTerminalsMap,
            fitLadderGen: terminalFitLadderGen,
            workingSilenceShown: terminalWorkingSilenceShown,
            ptyHostOrigin: resolvePtyHostOrigin(),
            isDockFrame: false,
            // Fleet list — the viewport uses it for paste attribution role
            // lookup. The command view's liveFleet is the same source.
            getFleetList: () => liveFleet,
            // Pane-assignment surface. The command view has no pane grid, so
            // these return the single-seat shape: one slot, the open seat,
            // slot 0 focused. The viewport uses these only for caret-ring
            // focus management, which is a no-op here.
            getPaneAssignments: () => viewerLiveSeats.length
                ? [viewerLiveSeats[0].friendlyName]
                : [],
            getFocusedPaneIndex: () => 0,
            focusPaneTerminal: () => {},
            clearCaretRing: () => {},
            // Input state. The command view has no per-pane input chip; the
            // status chip in the viewer header is driven by the WebSocket
            // handlers below.
            refreshInputState: () => {},
            notifyInputDropped: () => {},
            showPaneToast: (msg) => { console.warn('[Command] terminal toast:', msg); },
            // Startup curtain / working silence — no-ops; the command view
            // has no startup curtain element.
            bumpStartupCurtain: () => {},
            dismissStartupCurtain: () => {},
            showTerminalErrorToast: (name, msg) => {
                terminalWsStatus.textContent = 'Error';
                terminalWsStatus.className = 'status-chip error';
            },
            markReplayGap: () => {},
            clearWorkingSilence: () => {},
            // Fit ladder — the viewport drives EVERY post-resize re-fit through
            // this. A no-op is not "sufficient": the viewport's ResizeObserver
            // calls ensureSizeVote first, and ensureSizeVote returns early once
            // entry.sizeVoteActive is set (terminalViewport.js:443), so after the
            // first successful vote this callback is the only thing left that
            // re-measures the box. On a phone that is the whole game — the soft
            // keyboard opening and closing, and rotation, resize the viewport
            // constantly, and a no-op would pin the terminal at its first
            // cols/rows for the life of the session and never re-report the size
            // to the pty. The panel's ladder re-inspects the painted grid across
            // a pane assignment table; the command view has one terminal and no
            // grid, so the honest minimum is a generation-guarded re-fit across
            // the frames the layout takes to settle.
            startFitLadder: (name) => runTerminalFitLadder(name),
            cancelDetachTimer: () => {},
            // Renderer resync — NOT a no-op. fitAndReportSize calls this on every
            // resize that actually changed cols/rows, because xterm's WebGL
            // GlyphRenderer sizes its vertex array by cols*rows and never
            // reallocates it on resize: every row the pty app does not go on to
            // rewrite keeps glyph quads at the OLD column stride and overprints
            // (see the comment at terminalViewport.js:386). clearTextureAtlas +
            // a full refresh is the only repair. The panel's implementation
            // touches nothing but entry.container and entry.term — there is no
            // pane-grid concept in it — so the command view runs the same body.
            resyncPaneRenderer: (entry, verdict, options) => resyncTerminalRenderer(entry, verdict, options),
            // Sticky Ctrl. The key bar owns the latch; this is where it is
            // consumed, because the character it modifies is typed on the SOFT
            // KEYBOARD and reaches the pty through the viewport's own onData —
            // the bar never sees it. Reads `terminalKeyBar` at call time, not at
            // create time: the deps bag is built before the bar exists.
            transformInput: (data) => {
                if (terminalKeyBar && typeof terminalKeyBar.applyCtrlLatch === 'function') {
                    return terminalKeyBar.applyCtrlLatch(data);
                }
                return data;
            },
            // Seating — the command view's single terminal is always
            // "seated" (it is the only thing on the pane), so the suspend
            // path's transient-0x0 guard arms the renderer-release timer
            // rather than releasing immediately. This matches the desktop
            // panel's behaviour for a pane that stays assigned.
            isTerminalSeated: () => true,
        };
    }

    /**
     * Deliver a synthesized keystroke through the active terminal's
     * WebSocket. Routes through the viewport's encodeInputFrame (the same
     * framing the desktop terminals panel uses), NEVER term.paste — a paste
     * would land as bracketed-paste text, not a keystroke, and a TUI reading
     * a single arrow would see the whole bracketed block.
     */
    function sendTerminalInput(bytes) {
        if (!terminalViewport || !terminalTerminalsMap) { return; }
        // The open seat is the first (and only) entry in the map. The
        // viewport keys entries by name; the seat switcher destroys the
        // prior view before creating the new one, so the map holds exactly
        // one entry at a time.
        for (const entry of terminalTerminalsMap.values()) {
            if (entry && entry.ws && entry.ws.readyState === WebSocket.OPEN) {
                try {
                    entry.ws.send(terminalViewport.encodeInputFrame(bytes));
                } catch { /* disposed mid-send */ }
            }
            break;
        }
    }

    /**
     * Read the xterm DECCKM (application cursor) mode at press time. The
     * mode flips during a session (vim, less, fzf), so a value captured at
     * attach goes stale; the key bar reads it on every press. Returns
     * 'application' or 'normal'.
     *
     * xterm DOES expose this publicly: `term.modes.applicationCursorKeysMode`
     * (IModes, xterm.d.ts:1869), and the vendored bundle implements it as a
     * getter over the same coreService state. The public getter is read first;
     * the private `term._core.coreService.decPrivateModes.applicationCursorKeys`
     * is kept only as a second chance for a bundle that predates IModes.
     *
     * When NEITHER answers we must not quietly return 'normal': a wrong arrow
     * form makes the bar look correct and do nothing in exactly the full-screen
     * menus it exists for, which is invisible on a desktop and unreportable
     * from a phone. So the miss is logged once with the seat name — the value
     * still has to be something, and 'normal' is the ESC [ form every non-TUI
     * shell reads, so a wrong guess there is recoverable typing rather than a
     * dead key.
     */
    let cursorModeUnreadableWarned = false;
    function getCursorMode() {
        if (!terminalTerminalsMap) { return 'normal'; }
        for (const entry of terminalTerminalsMap.values()) {
            if (entry && entry.term) {
                try {
                    const modes = entry.term.modes;
                    if (modes && typeof modes.applicationCursorKeysMode === 'boolean') {
                        return modes.applicationCursorKeysMode ? 'application' : 'normal';
                    }
                    const core = entry.term._core;
                    if (core && core.coreService && core.coreService.decPrivateModes
                        && typeof core.coreService.decPrivateModes.applicationCursorKeys === 'boolean') {
                        return core.coreService.decPrivateModes.applicationCursorKeys
                            ? 'application' : 'normal';
                    }
                } catch { /* disposed mid-read */ }
                if (!cursorModeUnreadableWarned) {
                    cursorModeUnreadableWarned = true;
                    console.error('[Command] DECCKM unreadable for seat "' + entry.name
                        + '" — neither term.modes.applicationCursorKeysMode nor '
                        + 'coreService.decPrivateModes answered. Key-bar arrows will send the '
                        + 'ESC [ form and will not move a full-screen menu.');
                }
            }
            break;
        }
        return 'normal';
    }

    /**
     * Group the live fleet by team, with ungrouped seats in their own
     * section. The seat switcher uses this so the operator can reach ANY
     * live seat — including seats not assigned to a team. The grouping
     * uses the same `resolveTeamSeats` authority as the roster cards, so
     * the switcher and the roster cannot disagree about which seat
     * belongs to which team. Seats not claimed by any team fall into an
     * "Ungrouped" section.
     */
    function buildFleetRoster() {
        const live = liveFleet.filter(t => t && t.status !== 'exited' && t.friendlyName);
        // Claim order matches renderTeamsView: non-seeds ahead of seeds,
        // stable within each group. resolveTeamSeats claims in the order it
        // is handed, so the sort determines who wins a headRole.
        const claimOrder = teamRoster
            .map((team, i) => ({ team, i, seed: SEED_TEAM_IDS.has(team.id) ? 1 : 0 }))
            .sort((a, b) => (a.seed - b.seed) || (a.i - b.i))
            .map(entry => entry.team);
        const resolved = resolveTeamSeats(claimOrder, liveFleet);
        const byTeam = new Map();
        const claimed = new Set();
        for (const team of claimOrder) {
            const entry = resolved.get(team.id);
            if (!entry) { continue; }
            const seats = [];
            if (entry.head && entry.head.friendlyName) {
                seats.push(entry.head);
                claimed.add(entry.head.friendlyName);
            }
            for (const m of entry.members) {
                if (m && m.friendlyName) {
                    seats.push(m);
                    claimed.add(m.friendlyName);
                }
            }
            // Keyed by id, not name: `resolveTeamSeats` is id-keyed and two
            // teams may carry the same display name, in which case a name key
            // would drop one team's seats and render the other's twice.
            if (seats.length > 0) { byTeam.set(team.id, seats); }
        }
        const ungrouped = live.filter(t => t.friendlyName && !claimed.has(t.friendlyName));
        return { byTeam, ungrouped };
    }

    /**
     * Open the interactive terminal viewer for a specific seat. Takes a
     * seat name (not a team + head pair), titles the pane, and opens the
     * shared xterm viewport. The seat switcher is built from the COMPLETE
     * live fleet (ptyListTerminals), grouped by team with ungrouped seats
     * in their own section — so the operator can reach any live seat,
     * including seats not assigned to a team. Each switch routes back
     * through this function, which destroys the prior viewport before
     * creating the new one, so the previous socket is closed first and
     * there is never a window with two simultaneous sockets.
     */
    function openTerminalViewer(team, seatName, seatList) {
        const name = seatName || (team && team.name);
        // Store the live seats for the switcher (head + members). Retained
        // for backwards compatibility with the original call sites; the
        // switcher itself is now built from the full fleet roster.
        viewerLiveSeats = Array.isArray(seatList) ? seatList : [];

        terminalViewerTitle.textContent = `Terminal: ${name}`;
        terminalWsStatus.textContent = 'Connecting';
        terminalWsStatus.className = 'status-chip';

        // Build the seat switcher from the COMPLETE live fleet, grouped by
        // team. Ungrouped seats get their own section so the operator can
        // reach any live seat, not just the team that opened the viewer.
        buildSeatSwitcher(name);

        // Hide other panes, show viewer
        Object.values(viewPanes).forEach(p => p.classList.remove('active'));
        paneTerminalViewer.classList.add('active');

        // Destroy the prior viewport before creating the new one. The
        // viewport's destroyTerminalView closes the WebSocket and disposes
        // the xterm instance, so there is never a window with two
        // simultaneous sockets. This mirrors the original closeActiveWs
        // behaviour but through the shared viewport's lifecycle.
        destroyTerminalViewer();

        // Lazily create the viewport controller. It is safe to create once
        // and reuse across seat switches — the controller is stateless
        // aside from the terminalsMap it shares.
        if (!terminalViewport && window.SwitchboardTerminalViewport) {
            terminalViewport = window.SwitchboardTerminalViewport.create(buildTerminalViewportDeps());
        }
        if (!terminalViewport) {
            terminalWsStatus.textContent = 'Offline';
            terminalWsStatus.className = 'status-chip unknown';
            console.error('[Command] SwitchboardTerminalViewport not loaded — cannot open terminal viewer');
            return;
        }

        // Create the xterm view for this seat. The viewport module handles
        // xterm construction, renderer attach, WebSocket connect, replay,
        // and resize voting. The container (terminalXtermHost) is the box
        // the ResizeObserver measures.
        if (terminalXtermHost) {
            terminalViewport.createTerminalView(name, terminalXtermHost);
        }

        // Create the mobile key bar. The bar synthesizes control keys the
        // phone keyboard cannot type (arrows, Esc, Tab, Ctrl-C) and
        // delivers them through sendTerminalInput, which routes through
        // the viewport's encodeInputFrame — the same framing the desktop
        // terminals panel uses.
        if (!terminalKeyBar && window.SwitchboardTerminalKeyBar && terminalKeyBarEl) {
            terminalKeyBar = window.SwitchboardTerminalKeyBar.create({
                container: terminalKeyBarEl,
                send: sendTerminalInput,
                getCursorMode: getCursorMode,
                isCoarsePointer: () => !!(typeof window !== 'undefined'
                    && window.matchMedia
                    && window.matchMedia('(pointer: coarse)').matches),
            });
        }
        if (terminalKeyBar) { terminalKeyBar.refresh(); }

        // The viewport's WebSocket handlers drive the status chip. The
        // viewport does not call refreshInputState for the command view
        // (it is a no-op in the deps bag), so we poll the entry's ws
        // readyState. This is cheaper than a per-frame callback and the
        // chip is presentation-only.
        pollTerminalWsStatus(name);
    }

    /**
     * Build the seat switcher from the complete live fleet, grouped by
     * team. Ungrouped seats get their own section. Each button re-opens
     * the viewer for that seat, which destroys the prior viewport before
     * creating the new one.
     */
    function buildSeatSwitcher(activeName) {
        if (!terminalSeatSwitcher) { return; }
        terminalSeatSwitcher.innerHTML = '';
        const { byTeam, ungrouped } = buildFleetRoster();
        const totalSeats = Array.from(byTeam.values()).reduce((n, s) => n + s.length, 0) + ungrouped.length;
        if (totalSeats <= 1) {
            terminalSeatSwitcher.style.display = 'none';
            return;
        }
        terminalSeatSwitcher.style.display = 'flex';

        const makeSeatBtn = (seat) => {
            const btn = document.createElement('button');
            const isActive = seat.friendlyName === activeName;
            btn.textContent = seat.friendlyName;
            btn.style.cssText = 'font-size:10px;padding:2px 8px;border-radius:4px;cursor:pointer;'
                + 'border:1px solid var(--border-color);background:'
                + (isActive ? 'var(--accent-primary, #4a9eff)' : 'var(--panel-bg)')
                + ';color:' + (isActive ? '#fff' : 'var(--text-primary)');
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                // Route through openTerminalViewer — it destroys the prior
                // viewport before creating the new one. No separate
                // socket-opening path.
                openTerminalViewer(null, seat.friendlyName, viewerLiveSeats);
            });
            return btn;
        };

        // Team sections first, in declared order.
        for (const team of teamRoster) {
            const seats = byTeam.get(team.id);
            if (!seats || seats.length === 0) { continue; }
            const label = document.createElement('span');
            label.style.cssText = 'font-size:9px;font-weight:600;color:var(--text-secondary);'
                + 'padding:2px 6px;align-self:center;';
            label.textContent = team.name || team.headRole || 'team';
            terminalSeatSwitcher.appendChild(label);
            for (const seat of seats) {
                terminalSeatSwitcher.appendChild(makeSeatBtn(seat));
            }
        }
        // Ungrouped section last.
        if (ungrouped.length > 0) {
            const label = document.createElement('span');
            label.style.cssText = 'font-size:9px;font-weight:600;color:var(--text-secondary);'
                + 'padding:2px 6px;align-self:center;';
            label.textContent = 'Ungrouped';
            terminalSeatSwitcher.appendChild(label);
            for (const seat of ungrouped) {
                terminalSeatSwitcher.appendChild(makeSeatBtn(seat));
            }
        }
    }

    /**
     * Poll the active terminal's WebSocket readyState and update the
     * status chip. The viewport module does not expose a per-frame status
     * callback (its refreshInputState is a no-op in the command view), so
     * a short poll is the cheapest presentation-only bridge. Stops when
     * the viewer closes.
     */
    let statusPollTimer = null;
    function pollTerminalWsStatus(name) {
        if (statusPollTimer) { clearInterval(statusPollTimer); statusPollTimer = null; }
        statusPollTimer = setInterval(() => {
            if (!paneTerminalViewer.classList.contains('active')) {
                clearInterval(statusPollTimer);
                statusPollTimer = null;
                return;
            }
            if (!terminalTerminalsMap) { return; }
            const entry = terminalTerminalsMap.get(name);
            if (!entry) {
                terminalWsStatus.textContent = 'Closed';
                terminalWsStatus.className = 'status-chip';
                return;
            }
            if (entry.exited) {
                terminalWsStatus.textContent = 'Exited';
                terminalWsStatus.className = 'status-chip';
                return;
            }
            if (!entry.ws) {
                terminalWsStatus.textContent = 'Connecting';
                terminalWsStatus.className = 'status-chip';
                return;
            }
            switch (entry.ws.readyState) {
                case WebSocket.OPEN:
                    terminalWsStatus.textContent = 'Live';
                    terminalWsStatus.className = 'status-chip success';
                    break;
                case WebSocket.CONNECTING:
                    terminalWsStatus.textContent = 'Connecting';
                    terminalWsStatus.className = 'status-chip';
                    break;
                case WebSocket.CLOSING:
                case WebSocket.CLOSED:
                    terminalWsStatus.textContent = 'Reconnecting';
                    terminalWsStatus.className = 'status-chip';
                    break;
            }
        }, 500);
    }

    /**
     * Destroy the active terminal viewer's xterm view and close its
     * WebSocket. The viewport module's destroyTerminalView closes the
     * socket, disposes the xterm instance, releases the renderer, and
     * removes the entry from the terminalsMap. Safe to call when no view
     * is open (no-op).
     */
    function destroyTerminalViewer() {
        if (terminalViewport && terminalTerminalsMap) {
            // Destroy every entry — there should be exactly one, but a
            // failed switch could leave a stale entry. destroyTerminalView
            // is idempotent (no-op if the name is absent).
            for (const name of Array.from(terminalTerminalsMap.keys())) {
                try { terminalViewport.destroyTerminalView(name); } catch { /* ignore */ }
            }
        }
        if (statusPollTimer) { clearInterval(statusPollTimer); statusPollTimer = null; }
    }

    function closeTerminalViewer() {
        destroyTerminalViewer();
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

    // ── Agent control surface (mobile) ──────────────────────────────────
    // The Agent view is an API-backed control surface — no pty, no terminal
    // emulator, and no free-text input. Every action is a button or a
    // dropdown: the quick actions fire their mechanical endpoints directly,
    // the by-id actions act on the card picker, and the one model-backed
    // action (Resolve) takes the selected card. Endpoint, model and key are
    // configured in the pane itself. See plans:
    // the-dock-agent-tab-is-a-control-surface-not-a-terminal and
    // the-agent-control-surface-cannot-be-configured-and-is-driven-by-typing.

    const agentLogElMobile = document.getElementById('agent-control-log');
    const agentReportsElMobile = document.getElementById('agent-control-reports');
    const agentStatusChipMobile = document.getElementById('agent-status-chip');
    const agentQuickActionsElMobile = document.getElementById('agent-quick-actions');
    const agentEndpointElMobile = document.getElementById('agent-control-endpoint');
    const agentModelElMobile = document.getElementById('agent-control-model');
    const agentKeyElMobile = document.getElementById('agent-control-key');
    // The provider row's field-visibility rules and its model table live in
    // sharedUtils.js — dock.js binds the SAME controller to its own copy of
    // this row, so the two surfaces cannot disagree about which field applies
    // to which provider.
    const agentProviderRowMobile = window.SwitchboardAgentProviderRow
        ? window.SwitchboardAgentProviderRow.create({
            provider: document.getElementById('agent-control-provider'),
            endpoint: agentEndpointElMobile,
            endpointLabel: document.getElementById('agent-control-endpoint-label'),
            modelSelect: document.getElementById('agent-control-model-select'),
            modelInput: agentModelElMobile,
            modelLabel: document.getElementById('agent-control-model-label'),
            key: agentKeyElMobile,
            keyLabel: document.getElementById('agent-control-key-label'),
        })
        : null;
    const agentConfigSaveBtnMobile = document.getElementById('btn-agent-config-save');
    const agentConfigStatusElMobile = document.getElementById('agent-control-config-status');

    function setAgentStatusMobile(text, kind) {
        if (!agentStatusChipMobile) { return; }
        agentStatusChipMobile.textContent = text;
        agentStatusChipMobile.classList.remove('hidden', 'unknown', 'success', 'error');
        if (kind === 'error') { agentStatusChipMobile.classList.add('error'); }
        else if (kind === 'success') { agentStatusChipMobile.classList.add('success'); }
        else if (kind === 'model') { agentStatusChipMobile.classList.add('success'); }
        else { agentStatusChipMobile.classList.add('unknown'); }
    }

    function setAgentConfigStatusMobile(text, isError) {
        if (!agentConfigStatusElMobile) { return; }
        agentConfigStatusElMobile.textContent = text || '';
        agentConfigStatusElMobile.style.color = isError ? '#f85149' : 'var(--text-dim)';
    }

    async function loadAgentControlConfigMobile() {
        try {
            const res = await fetch('/agent/control/config', { credentials: 'same-origin' });
            if (!res.ok) {
                setAgentStatusMobile('Control surface unavailable (' + res.status + ')', 'error');
                return;
            }
            const data = await res.json();
            const cfg = data.data || data;
            agentModelConfigured = !!cfg.modelConfigured;
            // The config row renders the stored values verbatim — including a
            // value the resolver rejects — so the operator sees and fixes it.
            // The key field is write-only: it renders set/unset, never the value.
            if (agentProviderRowMobile) { agentProviderRowMobile.applyConfig(cfg); }
            // The key placeholder is set by the provider row controller — it is
            // PER PROVIDER (`cfg.providers[<id>].keySet`), and a surface-wide
            // `cfg.keySet` written here would claim the active provider's state
            // for whichever provider is selected next.
            setAgentConfigStatusMobile(cfg.modelError || '', !!cfg.modelError);
            if (agentModelConfigured) {
                setAgentStatusMobile('Model configured (' + (cfg.modelName || '') + '). Mechanical actions always available.', 'model');
            } else {
                setAgentStatusMobile('No usable model. The controller runs its mechanical rows only; the mechanical actions stay available.', 'unknown');
            }
            // The mechanical FALLBACK buttons only — the primary controls are the
            // controller console. Actions that need a card target are not
            // rendered (the card picker is gone); they remain reachable over the
            // API and the CLI. The model-backed `resolve-card` is gone entirely.
            if (agentQuickActionsElMobile) {
                agentQuickActionsElMobile.innerHTML = '';
                const actions = Array.isArray(cfg.quickActions) ? cfg.quickActions : [];
                for (const action of actions) {
                    if (!TARGETLESS_ACTIONS.includes(action.id)) { continue; }
                    const btn = document.createElement('button');
                    btn.type = 'button';
                    btn.className = 'secondary-action-btn';
                    btn.style.padding = '4px 10px';
                    btn.style.fontSize = '11px';
                    btn.textContent = action.label;
                    btn.addEventListener('click', () => void runAgentActionMobile(action.id));
                    agentQuickActionsElMobile.appendChild(btn);
                }
            }
            await refreshAgentBoardMobile();
            void renderAgentReportsMobile();
        } catch (err) {
            setAgentStatusMobile('Failed to load config: ' + (err?.message || err), 'error');
        }
    }

    /** Mechanical actions that need no card target, and so stay on the surface
     *  after the card picker is removed. */
    const TARGETLESS_ACTIONS = ['dispatch-starred', 'refresh-board', 'list-columns'];

    /** Fetch the board into the cache the fallback actions read. */
    async function refreshAgentBoardMobile() {
        try {
            const res = await fetch('/kanban/board', { credentials: 'same-origin' });
            const data = res.ok ? await res.json() : null;
            agentBoardCache = data ? (data.data || data || []) : [];
            if (!Array.isArray(agentBoardCache)) { agentBoardCache = []; }
        } catch {
            agentBoardCache = [];
        }
    }

    /**
     * Mount (once) and refresh the shared controller console. ONE console, both

    /** POST/PUT helper for the mechanical endpoints; normalises the reply. */
    async function agentFetchMobile(url, body, method) {
        try {
            const res = await fetch(url, {
                method: method || 'POST', credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body || {}),
            });
            const data = await res.json().catch(() => ({}));
            return { ok: res.ok && data.success !== false, status: res.status, body: data, error: data.error || (res.ok ? '' : 'HTTP ' + res.status) };
        } catch (err) {
            return { ok: false, status: 0, body: null, error: err?.message || String(err) };
        }
    }

    /**
     * Fire one surface action at its mechanical endpoint. The quick-action
     * buttons call here directly — the old path (stuff the label into a text
     * input, POST it to /agent/control for keyword parsing) is gone.
     */
    async function runAgentActionMobile(id) {
        if (agentSending) { return; }
        agentSending = true;
        try {
            if (id === 'dispatch-starred') {
                const starred = agentBoardCache.filter(c => c.starred === 1 || c.starred === true || c.priority === 1 || c.priority === true);
                if (!starred.length) {
                    renderAgentEntryMobile('assistant', 'No starred cards on the board.', null, null);
                    return;
                }
                // Explicit dispatch, not a board move: /kanban/dispatch fires the
                // agent regardless of the board-move triggers gate, and its
                // response is the verified outcome (move observed AND a dispatch
                // event recorded), not the hollow {success:true} an advance or a
                // raw verb call returns. One request per card so each card's
                // outcome is reported, not averaged.
                const results = [];
                for (const c of starred) {
                    const id = c.planId || c.sessionId;
                    const r = await agentFetchMobile('/kanban/dispatch', { plan: id, workspaceRoot: currentWorkspaceRoot });
                    results.push({ id, topic: c.topic || c.planId || id, ok: r.ok, body: r.body, error: r.error });
                }
                const delivered = results.filter(r => r.ok && r.body?.delivery === 'delivered');
                const lines = results.map(r => r.ok
                    ? `${r.topic}: ${r.body?.delivery || 'dispatched'}${r.body?.dispatchedAgent ? ' → ' + r.body.dispatchedAgent : ''}`
                    : `${r.topic}: FAILED — ${r.error}`);
                const summary = delivered.length === results.length
                    ? `Dispatched ${delivered.length} starred card(s).`
                    : `Dispatched ${delivered.length}/${results.length} — ${results.length - delivered.length} not delivered or refused.`;
                renderAgentEntryMobile('assistant', summary + '\n' + lines.join('\n'), null, [{ type: 'dispatch', result: results }]);
            } else if (id === 'refresh-board') {
                await refreshAgentBoardMobile();
                renderAgentEntryMobile('assistant', 'Board refreshed — ' + agentBoardCache.length + ' card(s).', null, null);
            } else if (id === 'list-columns') {
                const res = await fetch('/kanban/columns', { credentials: 'same-origin' });
                const data = res.ok ? await res.json() : null;
                const cols = data ? (data.data || data) : null;
                const names = cols ? [...(cols.builtIn || []), ...(cols.custom || [])].map(c => c.label || c.id) : [];
                renderAgentEntryMobile('assistant', names.length ? 'Columns: ' + names.join(', ') : 'No columns reported.', null, null);
            }
        } catch (err) {
            setAgentStatusMobile('Action failed: ' + (err?.message || err), 'error');
        } finally {
            agentSending = false;
        }
    }

    /** Save the endpoint/model/key the surface's config row holds. */
    async function saveAgentControlConfigMobile() {
        // A save with no provider chosen would POST an empty body: the server
        // writes nothing and answers success, and the row reports "Saved." for a
        // no-op. Refuse it here and name what is missing.
        if (agentProviderRowMobile && !agentProviderRowMobile.selectedProviderId()) {
            setAgentConfigStatusMobile('Choose a provider before saving.', true);
            return;
        }
        const payload = agentProviderRowMobile ? agentProviderRowMobile.payload() : {};
        // The key field is write-only: an empty field means "leave the stored
        // key unchanged", so it is only sent when the operator typed one. A
        // provider that takes no key (local server) never sends one either —
        // it has no key field to type into.
        const wantsKey = !agentProviderRowMobile || agentProviderRowMobile.needsKey();
        if (wantsKey && agentKeyElMobile && agentKeyElMobile.value.trim()) {
            payload.apiKey = agentKeyElMobile.value.trim();
        }
        try {
            const res = await fetch('/agent/control/config', {
                method: 'POST', credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok || data.success === false) {
                setAgentConfigStatusMobile('Save failed: ' + (data.error || res.status), true);
                return;
            }
            if (agentKeyElMobile) { agentKeyElMobile.value = ''; }
            setAgentConfigStatusMobile('Saved.', false);
            await loadAgentControlConfigMobile();
        } catch (err) {
            setAgentConfigStatusMobile('Save failed: ' + (err?.message || err), true);
        }
    }

    function renderAgentEntryMobile(role, text, resolved, actions) {
        if (!agentLogElMobile) { return; }
        const entry = document.createElement('div');
        entry.style.marginBottom = '8px';
        entry.style.padding = '6px 8px';
        entry.style.background = 'var(--panel-bg2)';
        entry.style.border = '1px solid var(--border-color)';
        entry.style.borderRadius = '4px';
        if (role === 'user') { entry.style.borderColor = 'var(--accent-primary)'; }
        const roleEl = document.createElement('div');
        roleEl.style.fontSize = '10px';
        roleEl.style.color = 'var(--text-dim)';
        roleEl.style.textTransform = 'uppercase';
        roleEl.style.marginBottom = '3px';
        roleEl.textContent = role === 'user' ? 'You' : 'Controller';
        const textEl = document.createElement('div');
        textEl.style.color = 'var(--text-primary)';
        textEl.style.whiteSpace = 'pre-wrap';
        textEl.style.wordBreak = 'break-word';
        textEl.textContent = text;
        entry.appendChild(roleEl);
        entry.appendChild(textEl);
        if (Array.isArray(resolved) && resolved.length > 0) {
            const resEl = document.createElement('div');
            resEl.style.marginTop = '4px';
            resEl.style.paddingTop = '4px';
            resEl.style.borderTop = '1px solid var(--border-color)';
            resEl.style.fontSize = '11px';
            resEl.style.color = 'var(--text-dim)';
            resEl.textContent = 'Resolved: ';
            for (const card of resolved) {
                const chip = document.createElement('span');
                chip.style.display = 'inline-block';
                chip.style.margin = '2px';
                chip.style.padding = '1px 6px';
                chip.style.background = 'var(--panel-bg)';
                chip.style.border = '1px solid var(--border-color)';
                chip.style.borderRadius = '3px';
                chip.style.fontSize = '10px';
                const topic = card.topic || card.planId || '?';
                const col = card.kanbanColumn || '';
                chip.textContent = topic + (col ? ' [' + col + ']' : '') + (card.starred ? ' ★' : '');
                resEl.appendChild(chip);
            }
            entry.appendChild(resEl);
        }
        if (Array.isArray(actions) && actions.length > 0) {
            const actEl = document.createElement('div');
            actEl.style.marginTop = '4px';
            actEl.style.fontSize = '11px';
            actEl.style.color = 'var(--accent-primary)';
            for (const action of actions) {
                const line = document.createElement('div');
                if (action.error) {
                    line.style.color = '#f85149';
                    line.textContent = '✗ ' + action.type + ': ' + action.error;
                } else {
                    line.textContent = '✓ ' + action.type + ': ' + JSON.stringify(action.result || {});
                }
                actEl.appendChild(line);
            }
            entry.appendChild(actEl);
        }
        agentLogElMobile.appendChild(entry);
        agentLogElMobile.scrollTop = agentLogElMobile.scrollHeight;
    }

    /**
     * Render the board's turn-end reports as structured cards above the control
     * log. ONE renderer draws them — statusCards.js — shared with the dock Agent
     * panel and the seat status pane; this surface must not grow its own copy. A
     * missing module is reported loudly rather than rendering an empty feed.
     */
    async function renderAgentReportsMobile() {
        if (!agentReportsElMobile) { return; }
        const renderer = window.SwitchboardStatusCards;
        if (!renderer || typeof renderer.renderInto !== 'function') {
            console.error('[command] window.SwitchboardStatusCards is undefined — statusCards.js did not load.');
            return;
        }
        try {
            const res = await fetch('/kanban/reports?limit=20', { credentials: 'same-origin' });
            if (!res.ok) { return; }
            const data = await res.json();
            const rows = (data && data.success && Array.isArray(data.data)) ? data.data : [];
            renderer.renderInto(agentReportsElMobile, rows.map(renderer.fromTurnEnd));
        } catch { /* the control log still renders; the feed is not essential */ }
    }

    // Wire up the agent control surface event handlers — the config row's save
    // button. Every other action is wired at render time inside
    // loadAgentControlConfigMobile (quick actions) or handled by the pickers
    // + runAgentActionMobile.
    if (agentConfigSaveBtnMobile) {
        agentConfigSaveBtnMobile.addEventListener('click', () => void saveAgentControlConfigMobile());
    }

    // Bootstrap — guarded so a Node require (unit tests) does not throw on
    // the missing `document` global. The browser always has `document`.
    if (typeof document !== 'undefined') {
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', init);
        } else {
            init();
        }
    }

    // ── Model polling: Start / Stop ────────────────────────────────────────
    // Start runs one controller pass now and then every 5 minutes; Stop clears
    // the timer. A pass is `controller --once`, which runs the rules and calls
    // the model where a rule needs judgement.
    //
    // Deliberately NOT /controller/arm: that spawns a supervised process and
    // takes a board lease, and the lease blocks on a stale holder. There is one
    // board and one controller, so there is nothing for a lease to arbitrate.
    (function wirePollButtons() {
        const startBtn = document.getElementById('agent-poll-start');
        const stopBtn = document.getElementById('agent-poll-stop');
        const stateEl = document.getElementById('agent-poll-state');
        if (!startBtn && !stopBtn && !stateEl) { return; }

        const EVERY_MS = 5 * 60 * 1000;
        let timer = null;

        function setState(t) { if (stateEl) { stateEl.textContent = t; } }

        async function runPass() {
            try {
                const res = await fetch('/controller/run', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: '{}'
                });
                const data = await res.json().catch(() => null);
                if (res.ok && data && data.success !== false) {
                    setState('polling every 5 min — last run ' + new Date().toLocaleTimeString());
                } else {
                    setState('run failed: ' + ((data && (data.reason || data.error)) || res.status));
                }
            } catch (err) {
                setState('run failed: ' + String(err));
            }
        }

        if (startBtn) {
            startBtn.addEventListener('click', () => {
                if (timer) { return; }
                timer = setInterval(() => void runPass(), EVERY_MS);
                setState('starting…');
                void runPass();
            });
        }
        if (stopBtn) {
            stopBtn.addEventListener('click', () => {
                if (timer) { clearInterval(timer); timer = null; }
                setState('stopped');
            });
        }
        setState('stopped');
    })();

})();
