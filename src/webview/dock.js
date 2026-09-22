// dock.js — the dock document. Owns the tab strip, two terminal viewports
// (Agent + CLI) and the Fleet table. Loaded inside the shell's single /dock
// iframe. Does NOT import from terminals.js — the whole point of this
// document is that showing a terminal in the dock does not load the 13K-line
// Terminals panel.
//
// State sharing with the shell: both documents read/write the same
// `sb.agentDock` localStorage key (same origin). The shell owns `open` and
// `width`; this document owns `activeTab` and `seat`. Each field has exactly
// one writer — no split ownership, no two sources of truth.
(function () {
    'use strict';

    // ── Persisted state (shared with shell.js via localStorage) ──────────
    const DOCK_STATE_KEY = 'sb.agentDock';
    const DOCK_TABS = ['agent', 'cli', 'fleet', 'composer'];
    const DOCK_DEFAULT_WIDTH = 648;

    function readDockState() {
        try {
            const raw = localStorage.getItem(DOCK_STATE_KEY);
            const s = raw ? JSON.parse(raw) : {};
            return {
                open: s.open === true,
                width: Number(s.width) || DOCK_DEFAULT_WIDTH,
                seat: typeof s.seat === 'string' ? s.seat : null,
                activeTab: (s.activeTab === 'fleet' || s.activeTab === 'cli' || s.activeTab === 'composer') ? s.activeTab : 'agent',
            };
        } catch { return { open: false, width: DOCK_DEFAULT_WIDTH, seat: null, activeTab: 'agent' }; }
    }
    function writeDockState(patch) {
        const next = { ...readDockState(), ...patch };
        try { localStorage.setItem(DOCK_STATE_KEY, JSON.stringify(next)); } catch { /* ignore */ }
        return next;
    }
    function normaliseDockTab(tab) {
        if (DOCK_TABS.includes(tab)) { return tab; }
        return 'agent';
    }

    // ── Seat names ───────────────────────────────────────────────────────
    // The Agent tab is a control surface (no seat); only the CLI tab has one.
    function dockCliSeatName() { return 'dock-cli'; }

    // ── Element refs ─────────────────────────────────────────────────────
    const dockTabAgentBtn = document.getElementById('dock-tab-agent');
    const dockTabCliBtn = document.getElementById('dock-tab-cli');
    const dockTabFleetBtn = document.getElementById('dock-tab-fleet');
    const dockTabComposerBtn = document.getElementById('dock-tab-composer');
    const DOCK_TAB_BTNS = { agent: dockTabAgentBtn, cli: dockTabCliBtn, fleet: dockTabFleetBtn, composer: dockTabComposerBtn };
    // The shell's presentation mode ('split' | 'overlay'), posted on dockFrame
    // load and on mode switches. 'split' until told otherwise: the Escape
    // dismissal this enables is overlay-only, so a missed postMessage errs on
    // never-dismiss rather than eating an Escape in a dock that isn't
    // overlaying anything.
    let dockPresentationMode = 'split';
    const dockTitleEl = document.getElementById('dock-title');
    const dockRestartBtn = document.getElementById('dock-restart');
    const dockCloseBtn = document.getElementById('dock-close');
    const dockCliWrap = document.getElementById('dock-cli-wrap');
    const emptyEl = document.getElementById('dock-empty');
    const dockCliInput = document.getElementById('dock-cli-input');
    const startBtn = document.getElementById('dock-start');
    const dockEmptyHint = document.getElementById('dock-empty-hint');
    const agentPane = document.getElementById('dock-agent-pane');
    const cliPane = document.getElementById('dock-cli-pane');
    const dockFleetEl = document.getElementById('dock-fleet');
    const dockFleetOfflineEl = document.getElementById('dock-fleet-offline');
    const dockFleetContentEl = document.getElementById('dock-fleet-content');
    const dockFleetTbody = document.getElementById('dock-fleet-tbody');
    const dockHopPlanCb = document.getElementById('dock-hop-plan');
    const dockHopCodeCb = document.getElementById('dock-hop-code');
    const dockHopReviewCb = document.getElementById('dock-hop-review');
    const dockHopPlanReason = document.getElementById('dock-hop-plan-reason');
    const dockHopCodeReason = document.getElementById('dock-hop-code-reason');
    const dockHopReviewReason = document.getElementById('dock-hop-review-reason');
    const dockHopsBtn = document.getElementById('dock-hops-btn');
    const dockFleetFeedEl = document.getElementById('dock-fleet-feed');
    const composerPane = document.getElementById('dock-composer-pane');

    // ── PTY host origin (body data-attribute) ────────────────────────────
    // The terminal token is read by the viewport module from body.dataset.terminalToken
    // (injected by the composition root) and appended to the WS URL automatically.
    const PTY_HOST_ORIGIN = (document.body && document.body.dataset && document.body.dataset.ptyHostOrigin)
        || window.__SB_PTY_HOST_ORIGIN__
        || '';

    // ── Viewport state ───────────────────────────────────────────────────
    // The CLI tab keeps a viewport; the Agent tab is now a control surface
    // (no pty — see plan: the-dock-agent-tab-is-a-control-surface-not-a-terminal).
    const terminalsMap = new Map();
    const fitLadderGen = new Map();
    const workingSilenceShown = new Set();
    let cliViewport = null;
    let cliSeatName = null;
    let lastAutobanArmed = false;
    let fleetPollTimer = null;

    // ── Agent control surface state ──────────────────────────────────────
    // No conversation history and no free-text input — the surface is driven
    // by action buttons and dropdowns; the only model call is the explicit
    // Resolve action on a selected card.
    let agentModelConfigured = false;
    let agentSending = false;
    let agentBoardCache = [];

    // ── Viewport deps bag (CLI tab only) ─────────────────────────────────
    // The Agent tab is a control surface (no terminal); only the CLI tab
    // uses a terminalViewport. isDockFrame is TRUE: the viewport posts
    // dockTerminalExited to window.parent (the shell) when the CLI terminal
    // exits, and the shell relays it back to this dock iframe so dock.js can
    // show the restart button and empty state immediately.
    function makeViewportDeps() {
        return {
            terminalsMap,
            fitLadderGen,
            workingSilenceShown,
            getFleetList: () => [],
            getPaneAssignments: () => ({}),
            getFocusedPaneIndex: () => 0,
            // The dock has one terminal; it is always "seated" (see #1 guard).
            isTerminalSeated: () => true,
            isDockFrame: true,
            ptyHostOrigin: PTY_HOST_ORIGIN,
            resyncPaneRenderer: () => {},
            startFitLadder: () => {},
            refreshInputState: () => {},
            notifyInputDropped: () => {},
            showPaneToast: (text) => console.warn('[dock] pane toast:', text),
            clearCaretRing: () => {},
            focusPaneTerminal: () => {},
            clearWorkingSilence: () => {},
            bumpStartupCurtain: () => {},
            dismissStartupCurtain: () => {},
            showTerminalErrorToast: (name, message) => console.warn('[dock] terminal error:', name, message),
            markReplayGap: () => {},
            cancelDetachTimer: () => {},
        };
    }

    function ensureCliViewport() {
        if (cliViewport) { return cliViewport; }
        cliViewport = window.SwitchboardTerminalViewport.create(makeViewportDeps());
        return cliViewport;
    }

    // ── Agent control surface element refs ───────────────────────────────
    const agentLogEl = document.getElementById('agent-control-log');
    const agentReportsEl = document.getElementById('agent-control-reports');
    const agentStatusEl = document.getElementById('agent-control-status');
    const agentQuickActionsEl = document.getElementById('agent-control-quickactions');
    const agentEndpointEl = document.getElementById('agent-control-endpoint');
    const agentModelEl = document.getElementById('agent-control-model');
    const agentKeyEl = document.getElementById('agent-control-key');
    // Same controller, same table, as the mobile command surface — see
    // sharedUtils.js. Binding it here rather than reimplementing the rules is
    // what keeps the two copies of this row from drifting apart.
    const agentProviderRow = window.SwitchboardAgentProviderRow
        ? window.SwitchboardAgentProviderRow.create({
            provider: document.getElementById('agent-control-provider'),
            endpoint: agentEndpointEl,
            endpointLabel: document.getElementById('agent-control-endpoint-label'),
            modelSelect: document.getElementById('agent-control-model-select'),
            modelInput: agentModelEl,
            modelLabel: document.getElementById('agent-control-model-label'),
            key: agentKeyEl,
            keyLabel: document.getElementById('agent-control-key-label'),
        })
        : null;
    const agentConfigSaveBtn = document.getElementById('agent-control-config-save');
    const agentConfigStatusEl = document.getElementById('agent-control-config-status');

    // ── The Navigator's own config row ───────────────────────────────────
    // A SECOND role pointer over the SAME provider rows. It is the same shared
    // controller as the Pilot's row, bound to its own element ids, so the two
    // cannot disagree about which field applies to which provider — and a save
    // here writes /controller/navigator, never the Pilot's pointer.
    const agentNavKeyEl = document.getElementById('agent-navigator-key');
    const agentNavProviderRow = window.SwitchboardAgentProviderRow
        ? window.SwitchboardAgentProviderRow.create({
            provider: document.getElementById('agent-navigator-provider'),
            endpoint: document.getElementById('agent-navigator-endpoint'),
            endpointLabel: document.getElementById('agent-navigator-endpoint-label'),
            modelSelect: document.getElementById('agent-navigator-model-select'),
            modelInput: document.getElementById('agent-navigator-model'),
            modelLabel: document.getElementById('agent-navigator-model-label'),
            key: agentNavKeyEl,
            keyLabel: document.getElementById('agent-navigator-key-label'),
        })
        : null;
    const agentNavConfigSaveBtn = document.getElementById('agent-navigator-config-save');
    const agentNavConfigStatusEl = document.getElementById('agent-navigator-config-status');
    /** The Navigator's own pointer, from GET /controller/navigator. Null until
     *  that request answers — an unanswered request must not read as "unset". */
    let agentNavigatorState = null;

    // ── The Navigator's mission conversation ─────────────────────────────
    // Subject and goal in; a proposal of existing cards out. This is the only
    // place in the product where the operator types free text at a model, so it
    // is deliberately two fields and two buttons — not a form, and not a chat.
    const agentNavSubjectEl = document.getElementById('agent-navigator-subject');
    const agentNavGoalEl = document.getElementById('agent-navigator-goal');
    const agentNavProposeBtn = document.getElementById('agent-navigator-propose');
    const agentNavColdBtn = document.getElementById('agent-navigator-cold');
    const agentNavMissionStatusEl = document.getElementById('agent-navigator-mission-status');
    const agentNavMissionProposalEl = document.getElementById('agent-navigator-mission-proposal');
    /** The proposal on screen, so Apply posts exactly what was rendered —
     *  including which boxes the operator unchecked. */
    let agentNavProposal = null;
    let agentNavBusy = false;
    /** Repaints the mission strips from /kanban/missions/progress. Published by
     *  the panel IIFE below, where the ONE mission renderer lives: an apply must
     *  reach it or the panel keeps saying "No mission set up" over a mission the
     *  operator just created. Read back and reported when missing. */
    let repaintMissions = null;

    // ── Tab switching ────────────────────────────────────────────────────
    function setDockActiveTab(tab) {
        const activeTab = normaliseDockTab(tab);
        writeDockState({ activeTab });

        for (const id of DOCK_TABS) {
            const btn = DOCK_TAB_BTNS[id];
            if (!btn) { continue; }
            btn.classList.toggle('is-active', id === activeTab);
            btn.setAttribute('aria-selected', String(id === activeTab));
        }

        // Hide every pane first; then show exactly the active one.
        agentPane.classList.remove('is-visible');
        cliPane.classList.remove('is-visible');
        emptyEl.classList.remove('is-visible');
        emptyEl.hidden = true;
        if (dockFleetEl) {
            dockFleetEl.classList.remove('is-visible');
            dockFleetEl.hidden = true;
        }
        if (composerPane) {
            composerPane.classList.remove('is-visible');
            composerPane.hidden = true;
        }

        if (activeTab === 'fleet') {
            if (dockFleetEl) {
                dockFleetEl.classList.add('is-visible');
                dockFleetEl.hidden = false;
            }
            updateDockTitle();
            startFleetPoll();
        } else if (activeTab === 'composer') {
            if (composerPane) {
                composerPane.classList.add('is-visible');
                composerPane.hidden = false;
            }
            stopFleetPoll();
            updateDockTitle();
            if (window.SwitchboardDockComposer) { window.SwitchboardDockComposer.activate(); }
        } else if (activeTab === 'cli') {
            stopFleetPoll();
            syncCliSeat();
        } else {
            // 'agent' — the control surface. No pty to sync; just show the
            // pane and load the config (model availability + quick actions).
            stopFleetPoll();
            syncAgentControl();
        }
    }

    // ── Title ────────────────────────────────────────────────────────────
    function updateDockTitle(name) {
        const tab = normaliseDockTab(readDockState().activeTab);
        if (tab === 'fleet') {
            dockTitleEl.textContent = 'Fleet';
            return;
        }
        if (tab === 'composer') {
            dockTitleEl.textContent = 'Composer';
            return;
        }
        if (tab === 'cli') {
            dockTitleEl.textContent = name || dockCliSeatName();
            return;
        }
        // 'agent' — the control surface. No seat name; the title is static.
        dockTitleEl.textContent = 'Control Surface';
    }

    // ── Liveness checks ──────────────────────────────────────────────────
    async function ptyListAll() {
        try {
            const res = await fetch('/terminals/verb/ptyListTerminals', {
                method: 'POST', credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json' }, body: '{}'
            });
            const data = await res.json();
            const hidden = Array.isArray(data.hiddenTerminals) ? data.hiddenTerminals : [];
            const terminals = Array.isArray(data.terminals) ? data.terminals : [];
            return [...hidden, ...terminals];
        } catch { return []; }
    }

    async function checkCliLiveness() {
        const wanted = dockCliSeatName();
        const all = await ptyListAll();
        const live = all.find(t => (t.friendlyName === wanted || t.name === wanted) && t.status !== 'exited' && t.light !== 'exited');
        const exited = all.find(t => (t.friendlyName === wanted || t.name === wanted) && (t.status === 'exited' || t.light === 'exited'));
        return { wanted, live, exited };
    }

    // ── Agent control surface ────────────────────────────────────────────
    // The Agent tab is an API-backed control surface, not a pty seat and not
    // a text box — every action is a button or a dropdown, and endpoint/model/
    // key are configured in the pane itself. No terminal emulator is mounted.
    // See plans: the-dock-agent-tab-is-a-control-surface-not-a-terminal and
    // the-agent-control-surface-cannot-be-configured-and-is-driven-by-typing.

    /** Show the agent control surface and load its config. */
    async function syncAgentControl() {
        agentPane.classList.add('is-visible');
        emptyEl.hidden = true;
        emptyEl.classList.remove('is-visible');
        if (dockCliWrap) { dockCliWrap.classList.remove('is-visible', 'collapsed'); }
        if (dockRestartBtn) { dockRestartBtn.style.display = 'none'; }
        updateDockTitle();
        await loadAgentControlConfig();
        void renderAgentReports();
    }

    /** Render the modelError beside the config fields that fix it. */
    function setAgentConfigStatus(text, isError) {
        if (!agentConfigStatusEl) { return; }
        agentConfigStatusEl.textContent = text || '';
        agentConfigStatusEl.classList.toggle('is-error', isError === true);
    }

    /** Load model availability + quick actions from GET /agent/control/config. */
    async function loadAgentControlConfig() {
        try {
            const res = await fetch('/agent/control/config', { credentials: 'same-origin' });
            if (!res.ok) {
                setAgentStatus('Control surface unavailable (server returned ' + res.status + ').', 'error');
                return;
            }
            const data = await res.json();
            const cfg = data.data || data;
            agentModelConfigured = !!cfg.modelConfigured;
            // The config row renders the stored values verbatim — including a
            // value the resolver rejects — so the operator sees and fixes it.
            // The key field is write-only: it renders set/unset, never the value.
            if (agentProviderRow) { agentProviderRow.applyConfig(cfg); }
            // The key placeholder is set by the provider row controller — it is
            // PER PROVIDER (`cfg.providers[<id>].keySet`), and a surface-wide
            // `cfg.keySet` written here would claim the active provider's state
            // for whichever provider is selected next.
            if (cfg.modelError) {
                setAgentConfigStatus(cfg.modelError, true);
            } else {
                setAgentConfigStatus('', false);
            }
            // The Navigator's OWN pointer, seeded into its own row over the
            // SAME `cfg.providers` rows map. A failed read leaves the row
            // unsown and says so — an unanswered request and a genuinely unset
            // Navigator must not render the same string.
            await loadAgentNavigatorConfig(cfg);
            if (agentModelConfigured) {
                // SILENT WHEN FINE. The Pilot station names the model and its
                // state a few pixels above; restating it here spent the whole
                // footer on a non-event, and on the phone drew it as a green
                // success chip. The failure case below still speaks.
                setAgentStatus('', '');
            } else {
                setAgentStatus('No usable model. The controller runs its mechanical rows only; the mechanical actions stay available.', '');
            }
            // Render the mechanical FALLBACK buttons — each fires its endpoint
            // DIRECTLY. They are the fallback vocabulary now, not the primary
            // one: the primary controls are the controller console. Only the
            // actions that need no card target are rendered, because the card
            // picker is gone — the by-id actions remain reachable over the API
            // and the CLI, and the model-backed `resolve-card` is gone entirely.
            if (agentQuickActionsEl) {
                agentQuickActionsEl.innerHTML = '';
                const actions = Array.isArray(cfg.quickActions) ? cfg.quickActions : [];
                for (const action of actions) {
                    if (!TARGETLESS_ACTIONS.includes(action.id)) { continue; }
                    const btn = document.createElement('button');
                    btn.type = 'button';
                    btn.className = 'agent-control-quickbtn';
                    btn.textContent = action.label;
                    btn.addEventListener('click', () => void runAgentAction(action.id));
                    agentQuickActionsEl.appendChild(btn);
                }
            }
            // Load the board so `dispatch starred cards` has the cache it needs.
            await refreshAgentBoard();
        } catch (err) {
            setAgentStatus('Failed to load control config: ' + (err?.message || err), 'error');
        }
    }

    /** Mechanical actions that need no card target, and so stay on the surface
     *  after the card picker is removed. */
    const TARGETLESS_ACTIONS = ['dispatch-starred', 'refresh-board', 'list-columns'];

    /** Fetch the board into the cache the fallback actions read. */
    async function refreshAgentBoard() {
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
     * Fire one surface action at its mechanical endpoint. The quick-action
     * buttons call here directly — the old path (stuff the label into a text
     * input, POST it to /agent/control for keyword parsing) is gone.
     */
    async function runAgentAction(id) {
        if (agentSending) { return; }
        agentSending = true;
        try {
            if (id === 'dispatch-starred') {
                const starred = agentBoardCache.filter(c => c.starred === 1 || c.starred === true || c.priority === 1 || c.priority === true);
                if (!starred.length) {
                    renderControlEntry('assistant', 'No starred cards on the board.', null, null);
                    return;
                }
                // Explicit dispatch, not a board move: blocking /kanban/dispatch
                // verifies delivery (append-only dispatched event) before it
                // answers, and bypasses the board-move triggers gate by
                // contract. One request per card — each card gets its own
                // outcome line, not one averaged verdict.
                const results = [];
                for (const c of starred) {
                    const id = c.planId || c.sessionId;
                    const r = await agentFetch('/kanban/dispatch', { plan: id });
                    results.push({ id, topic: c.topic || c.planId || id, ok: r.ok, body: r.body, error: r.error });
                }
                const delivered = results.filter(r => r.ok && r.body?.delivery === 'delivered');
                const lines = results.map(r => r.ok
                    ? `${r.topic}: ${r.body?.delivery || 'dispatched'}${r.body?.dispatchedAgent ? ' → ' + r.body.dispatchedAgent : ''}`
                    : `${r.topic}: FAILED — ${r.error}`);
                const summary = delivered.length === results.length
                    ? `Dispatched ${delivered.length} starred card(s).`
                    : `Dispatched ${delivered.length}/${results.length} — ${results.length - delivered.length} not delivered or refused.`;
                renderControlEntry('assistant', summary + '\n' + lines.join('\n'), null, [{ type: 'dispatch', result: results }]);
            } else if (id === 'refresh-board') {
                await refreshAgentBoard();
                renderControlEntry('assistant', 'Board refreshed — ' + agentBoardCache.length + ' card(s).', null, null);
            } else if (id === 'list-columns') {
                const res = await fetch('/kanban/columns', { credentials: 'same-origin' });
                const data = res.ok ? await res.json() : null;
                const cols = data ? (data.data || data) : null;
                const names = cols ? [...(cols.builtIn || []), ...(cols.custom || [])].map(c => c.label || c.id) : [];
                renderControlEntry('assistant', names.length ? 'Columns: ' + names.join(', ') : 'No columns reported.', null, null);
            }
        } catch (err) {
            setAgentStatus('Action failed: ' + (err?.message || err), 'error');
        } finally {
            agentSending = false;
        }
    }

    /** POST/PUT helper for the mechanical endpoints; normalises the reply. */
    async function agentFetch(url, body, method) {
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

    /** Save the endpoint/model/key the surface's config row holds. */
    async function saveAgentControlConfig() {
        // A save with no provider chosen would POST an empty body: the server
        // writes nothing and answers success, and the row reports "Saved." for a
        // no-op. Refuse it here and name what is missing.
        if (agentProviderRow && !agentProviderRow.selectedProviderId()) {
            setAgentConfigStatus('Choose a provider before saving.', true);
            return;
        }
        const payload = agentProviderRow ? agentProviderRow.payload() : {};
        // The key field is write-only: an empty field means "leave the stored
        // key unchanged", so it is only sent when the operator typed one. A
        // provider that takes no key (local server) never sends one either.
        const wantsKey = !agentProviderRow || agentProviderRow.needsKey();
        if (wantsKey && agentKeyEl && agentKeyEl.value.trim()) { payload.apiKey = agentKeyEl.value.trim(); }
        try {
            const res = await fetch('/agent/control/config', {
                method: 'POST', credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok || data.success === false) {
                setAgentConfigStatus('Save failed: ' + (data.error || res.status), true);
                return;
            }
            if (agentKeyEl) { agentKeyEl.value = ''; }
            await loadAgentControlConfig();
            // The stations name the model, so they are what a model change is
            // FOR. Without this the panel reported the old one until reload.
            if (repaintCrew) { await repaintCrew(); }
            // LAST, not first. `loadAgentControlConfig` clears this line when the
            // config has no error, so setting it before the reload meant every
            // successful save wiped its own confirmation and read as a no-op.
            setAgentConfigStatus(repaintCrew ? 'Saved.' : 'Saved — reload to see the crew update.', false);
        } catch (err) {
            setAgentConfigStatus('Save failed: ' + (err?.message || err), true);
        }
    }

    /** Set the Navigator config row's status line. */
    function setAgentNavConfigStatus(text, isError) {
        if (!agentNavConfigStatusEl) { return; }
        agentNavConfigStatusEl.textContent = text || '';
        agentNavConfigStatusEl.classList.toggle('is-error', isError === true);
    }

    /**
     * Seed the Navigator row from its OWN pointer, over the shared rows map.
     *
     * `cfg` is the agent-control config (whose `providers` map both roles
     * share); the pointer comes from GET /controller/navigator. When that read
     * fails the row is NOT seeded and the status says the state could not be
     * read — an unanswered request must never render as "not configured".
     */
    async function loadAgentNavigatorConfig(cfg) {
        try {
            const res = await fetch('/controller/navigator', { credentials: 'same-origin' });
            if (!res.ok) {
                agentNavigatorState = null;
                setAgentNavConfigStatus('Navigator state could not be read (server returned ' + res.status + ').', true);
                return;
            }
            const data = await res.json();
            const nav = (data && data.navigator) || null;
            agentNavigatorState = nav;
            if (agentNavProviderRow && cfg) {
                agentNavProviderRow.applyConfig(cfg, nav ? { providerId: nav.providerId, source: nav.source } : null);
            }
            // The server's own reason for an unset or broken slot, verbatim.
            // A slot that names a provider with no row, or a corrupt config, says
            // which one it is rather than collapsing into "not configured".
            if (nav && nav.error) { setAgentNavConfigStatus(nav.error, true); }
            else if (nav && nav.reason) { setAgentNavConfigStatus(nav.reason, false); }
            else { setAgentNavConfigStatus('', false); }
        } catch (err) {
            agentNavigatorState = null;
            setAgentNavConfigStatus('Navigator state could not be read: ' + (err?.message || err), true);
        }
    }

    /** Save the Navigator's endpoint/model/key. Writes /controller/navigator —
     *  never the Pilot's pointer, so saving one role cannot overwrite the other. */
    async function saveAgentNavigatorConfig() {
        if (agentNavProviderRow && !agentNavProviderRow.selectedProviderId()) {
            setAgentNavConfigStatus('Choose a provider before saving.', true);
            return;
        }
        const payload = agentNavProviderRow ? agentNavProviderRow.payload() : {};
        const wantsKey = !agentNavProviderRow || agentNavProviderRow.needsKey();
        if (wantsKey && agentNavKeyEl && agentNavKeyEl.value.trim()) { payload.apiKey = agentNavKeyEl.value.trim(); }
        try {
            const res = await fetch('/controller/navigator', {
                method: 'PUT', credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok || data.success === false) {
                setAgentNavConfigStatus('Save failed: ' + (data.error || res.status), true);
                return;
            }
            if (agentNavKeyEl) { agentNavKeyEl.value = ''; }
            await loadAgentControlConfig();
            if (repaintCrew) { await repaintCrew(); }
            setAgentNavConfigStatus(repaintCrew ? 'Saved.' : 'Saved — reload to see the crew update.', false);
        } catch (err) {
            setAgentNavConfigStatus('Save failed: ' + (err?.message || err), true);
        }
    }

    /** Repaints the crew stations. Published by the panel IIFE below, which is
     *  where loadModels lives — a save has to reach it or the stations keep
     *  naming the model that was there before. `Promise<void>` callbacks where
     *  "never wired" and "working" look the same are the trap here, so this one
     *  is read back and reported when it is missing. */
    let repaintCrew = null;

    // ── The Navigator's mission conversation ─────────────────────────────

    /** Set the mission block's status line. */
    function setAgentNavMissionStatus(text, isError) {
        if (!agentNavMissionStatusEl) { return; }
        agentNavMissionStatusEl.textContent = text || '';
        agentNavMissionStatusEl.classList.toggle('is-error', isError === true);
    }

    /** One checkbox row: `topic — column`, ticked. Unchecking is how the
     *  operator edits the list, so the checkbox IS the edit surface. */
    function navCardRow(card, checked) {
        const row = document.createElement('label');
        row.className = 'agent-nav-row';
        const box = document.createElement('input');
        box.type = 'checkbox';
        box.checked = checked;
        box.dataset.planId = card.planId;
        row.appendChild(box);
        const topic = document.createElement('span');
        topic.className = 'agent-nav-topic';
        topic.textContent = card.topic || card.planId;
        row.appendChild(topic);
        const col = document.createElement('span');
        col.className = 'agent-nav-col';
        col.textContent = card.kanbanColumn || '(no column)';
        row.appendChild(col);
        return row;
    }

    /** Render one proposal block (a mission proposal, or one cold-board
     *  grouping) with its own Apply button. The cards come from the candidate
     *  set the SERVER assembled — the panel never invents a row. */
    function navProposalBlock(proposal, candidates) {
        const block = document.createElement('div');
        block.className = 'agent-nav-group';

        const head = document.createElement('div');
        head.className = 'agent-nav-head';
        head.textContent = proposal.missionName || '(the Navigator did not name the mission)';
        block.appendChild(head);

        if (proposal.goal) {
            const goal = document.createElement('div');
            goal.className = 'agent-nav-goal';
            goal.textContent = proposal.goal;
            block.appendChild(goal);
        }
        if (proposal.rationale) {
            const why = document.createElement('div');
            why.className = 'agent-nav-goal';
            why.textContent = proposal.rationale;
            block.appendChild(why);
        }
        // The truncation, ABOVE the list: dropping two cards from a proposal the
        // operator is about to approve silently is worse than saying so.
        if (proposal.truncated) {
            const note = document.createElement('div');
            note.className = 'agent-nav-note';
            note.textContent = proposal.truncated.dropped + ' more card(s) were dropped — a proposal is capped at ten.';
            note.title = (proposal.truncated.ids || []).join(', ');
            block.appendChild(note);
        }

        const byId = new Map((candidates || []).map(c => [c.planId, c]));
        const boxes = [];
        for (const id of proposal.planIds) {
            const card = byId.get(id) || { planId: id, topic: id, kanbanColumn: '' };
            const row = navCardRow(card, true);
            boxes.push(row.querySelector('input'));
            block.appendChild(row);
        }

        const applyBtn = document.createElement('button');
        applyBtn.type = 'button';
        applyBtn.className = 'agent-control-config-save';
        applyBtn.textContent = 'Apply';
        applyBtn.addEventListener('click', () => {
            const ids = boxes.filter(b => b.checked).map(b => b.dataset.planId);
            void applyNavigatorProposal(proposal, ids);
        });
        block.appendChild(applyBtn);
        return block;
    }

    /** Render a propose outcome. A non-proposal kind renders its own string and
     *  NOTHING else — never an empty list, which would read as "the Navigator
     *  found nothing". */
    function renderNavigatorOutcome(data) {
        const host = agentNavMissionProposalEl;
        if (!host) { return; }
        host.textContent = '';
        agentNavProposal = null;
        const outcome = data && data.outcome ? data.outcome : null;
        if (!outcome) {
            setAgentNavMissionStatus('The Navigator did not answer.', true);
            return;
        }
        if (outcome.kind === 'proposal') {
            agentNavProposal = outcome;
            setAgentNavMissionStatus(data.message || '', false);
            host.appendChild(navProposalBlock(outcome.proposal, outcome.candidates));
            return;
        }
        if (outcome.kind === 'cold-board') {
            setAgentNavMissionStatus(data.message || '', false);
            const note = document.createElement('div');
            note.className = 'agent-nav-note';
            note.textContent = 'Three groupings is a cap, not a count.';
            host.appendChild(note);
            for (const g of outcome.groupings) {
                host.appendChild(navProposalBlock(g, outcome.candidates));
            }
            return;
        }
        // no-candidates | invalid-reply | unconfigured | error — four distinct
        // strings, from the server, rendered verbatim.
        setAgentNavMissionStatus(data.message || 'The pass did not produce a proposal.', true);
    }

    /** POST the two questions (or the explicit cold-board ask). */
    async function proposeNavigatorMission(cold) {
        if (agentNavBusy) { return; }
        const subject = agentNavSubjectEl ? agentNavSubjectEl.value.trim() : '';
        const goal = agentNavGoalEl ? agentNavGoalEl.value.trim() : '';
        if (!cold && !subject) {
            setAgentNavMissionStatus('Type a subject, or use "Look at the whole board".', true);
            return;
        }
        agentNavBusy = true;
        if (agentNavProposeBtn) { agentNavProposeBtn.disabled = true; }
        setAgentNavMissionStatus(cold ? 'Asking the Navigator to look at the board…' : 'Asking the Navigator…', false);
        try {
            const res = await fetch('/controller/navigator/propose', {
                method: 'POST', credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(cold ? { cold: true } : { subject: subject, goal: goal }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok || data.success === false) {
                setAgentNavMissionStatus('The propose request failed: ' + (data.error || ('HTTP ' + res.status)), true);
                if (agentNavMissionProposalEl) { agentNavMissionProposalEl.textContent = ''; }
                return;
            }
            renderNavigatorOutcome(data);
        } catch (err) {
            setAgentNavMissionStatus('The Navigator did not answer: ' + (err?.message || err), true);
            if (agentNavMissionProposalEl) { agentNavMissionProposalEl.textContent = ''; }
        } finally {
            agentNavBusy = false;
            if (agentNavProposeBtn) { agentNavProposeBtn.disabled = false; }
        }
    }

    /** POST the approved ids. On success the EXISTING mission renderer repaints
     *  from /kanban/missions/progress — no second renderer, and a partially
     *  applied mission is reported as such rather than as complete. */
    async function applyNavigatorProposal(proposal, planIds) {
        if (agentNavBusy) { return; }
        if (!planIds.length) {
            setAgentNavMissionStatus('No cards are ticked — nothing to apply.', true);
            return;
        }
        agentNavBusy = true;
        setAgentNavMissionStatus('Applying…', false);
        try {
            const res = await fetch('/controller/navigator/apply', {
                method: 'POST', credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    missionName: proposal.missionName || '',
                    goal: proposal.goal || '',
                    planIds: planIds,
                    subject: agentNavSubjectEl ? agentNavSubjectEl.value.trim() : '',
                    modelId: agentNavProposal ? agentNavProposal.modelId : '',
                }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok || data.success === false) {
                setAgentNavMissionStatus('Apply failed: ' + (data.error || ('HTTP ' + res.status)), true);
                return;
            }
            const failed = data.kind !== 'applied';
            setAgentNavMissionStatus(data.message || '', failed);
            if (data.kind === 'applied' && repaintMissions) {
                await repaintMissions();
            } else if (data.kind === 'applied') {
                setAgentNavMissionStatus((data.message || '') + ' Reload the panel to see the mission strip.', false);
            }
        } catch (err) {
            setAgentNavMissionStatus('Apply failed: ' + (err?.message || err), true);
        } finally {
            agentNavBusy = false;
        }
    }

    if (agentNavProposeBtn) { agentNavProposeBtn.addEventListener('click', () => void proposeNavigatorMission(false)); }
    if (agentNavColdBtn) { agentNavColdBtn.addEventListener('click', () => void proposeNavigatorMission(true)); }

    /** Set the status line text + class. */
    function setAgentStatus(text, cls) {
        if (!agentStatusEl) { return; }
        agentStatusEl.textContent = text;
        agentStatusEl.className = 'agent-control-status';
        if (cls === 'error') { agentStatusEl.classList.add('is-error'); }
        else if (cls === 'model') { agentStatusEl.classList.add('is-model'); }
    }

    /** Render a control surface log entry (user or assistant turn). */
    function renderControlEntry(role, text, resolved, actions) {
        if (!agentLogEl) { return; }
        const entry = document.createElement('div');
        entry.className = 'agent-control-entry' + (role === 'user' ? ' is-user' : '');
        const roleEl = document.createElement('div');
        roleEl.className = 'agent-control-entry-role';
        roleEl.textContent = role === 'user' ? 'You' : 'Controller';
        const textEl = document.createElement('div');
        textEl.className = 'agent-control-entry-text';
        textEl.textContent = text;
        entry.appendChild(roleEl);
        entry.appendChild(textEl);
        // Show what it resolved to — the part that can be wrong, made visible
        if (Array.isArray(resolved) && resolved.length > 0) {
            const resEl = document.createElement('div');
            resEl.className = 'agent-control-resolved';
            resEl.textContent = 'Resolved: ';
            for (const card of resolved) {
                const chip = document.createElement('span');
                chip.className = 'agent-control-resolved-card';
                const topic = card.topic || card.planId || '?';
                const col = card.kanbanColumn || '';
                chip.textContent = topic + (col ? ' [' + col + ']' : '') + (card.starred ? ' ★' : '');
                chip.title = card.planId || '';
                resEl.appendChild(chip);
            }
            entry.appendChild(resEl);
        }
        // Show what it did
        if (Array.isArray(actions) && actions.length > 0) {
            const actEl = document.createElement('div');
            actEl.className = 'agent-control-actions';
            for (const action of actions) {
                const line = document.createElement('div');
                if (action.error) {
                    line.className = 'agent-control-action-error';
                    line.textContent = '✗ ' + action.type + ': ' + action.error;
                } else {
                    line.textContent = '✓ ' + action.type + ': ' + JSON.stringify(action.result || {});
                }
                actEl.appendChild(line);
            }
            entry.appendChild(actEl);
        }
        agentLogEl.appendChild(entry);
        agentLogEl.scrollTop = agentLogEl.scrollHeight;
    }

    /**
     * Render the board's turn-end reports as structured cards above the control
     * log. ONE renderer draws them — statusCards.js — the same module the seat
     * status pane and the mobile command surface consume; this surface must not
     * grow its own copy. A missing module is reported loudly rather than
     * rendering a silently empty feed.
     */
    async function renderAgentReports() {
        if (!agentReportsEl) { return; }
        const renderer = window.SwitchboardStatusCards;
        if (!renderer || typeof renderer.renderInto !== 'function') {
            console.error('[dock] window.SwitchboardStatusCards is undefined — statusCards.js did not load.');
            return;
        }
        try {
            const res = await fetch('/kanban/reports?limit=20', { credentials: 'same-origin' });
            if (!res.ok) { return; }
            const data = await res.json();
            const rows = (data && data.success && Array.isArray(data.data)) ? data.data : [];
            renderer.renderInto(agentReportsEl, rows.map(renderer.fromTurnEnd));
        } catch { /* the control log still renders; the feed is not essential */ }
    }


    // ── CLI seat sync ────────────────────────────────────────────────────
    async function syncCliSeat() {
        const saved = readDockState();
        if (normaliseDockTab(saved.activeTab) !== 'cli') { return; }
        const { live, exited } = await checkCliLiveness();
        if (normaliseDockTab(readDockState().activeTab) !== 'cli') { return; }
        if (live) {
            if (dockRestartBtn) { dockRestartBtn.style.display = 'none'; }
            mountCliViewport(live.friendlyName || live.name || dockCliSeatName());
        } else if (exited) {
            if (dockRestartBtn) { dockRestartBtn.style.display = 'inline-block'; }
            showCliEmptyState();
        } else {
            if (dockRestartBtn) { dockRestartBtn.style.display = 'none'; }
            showCliEmptyState();
        }
    }

    function mountCliViewport(name) {
        const vp = ensureCliViewport();
        if (cliSeatName && cliSeatName !== name) {
            try { vp.destroyTerminalView(cliSeatName); } catch { /* ignore */ }
            cliSeatName = null;
        }
        if (!cliSeatName) {
            cliSeatName = name;
            vp.createTerminalView(name, cliPane);
            vp.connectTerminalSocket(terminalsMap.get(name));
        }
        cliPane.classList.add('is-visible');
        emptyEl.hidden = true;
        emptyEl.classList.remove('is-visible');
        updateDockTitle(name);
        requestAnimationFrame(() => {
            const entry = terminalsMap.get(name);
            if (entry) { vp.fitAndReportSize(entry); }
        });
    }

    // ── Empty states ─────────────────────────────────────────────────────
    async function showCliEmptyState() {
        cliPane.classList.remove('is-visible');
        emptyEl.hidden = false;
        emptyEl.classList.add('is-visible');
        if (dockCliWrap) { dockCliWrap.classList.remove('is-visible', 'collapsed'); }
        if (dockCliInput) { dockCliInput.style.display = 'none'; }
        startBtn.style.display = '';
        startBtn.textContent = 'Start switchboard';
        startBtn.disabled = false;
        dockEmptyHint.innerHTML = '<p style="color:var(--text-dim);font-size:11px;line-height:1.5;">A live terminal running the <code>switchboard</code> CLI front door.</p>';
        dockTitleEl.textContent = '';
    }

    // ── Seat creation (CLI only — the Agent tab is a control surface) ───
    async function startCliSeat() {
        startBtn.disabled = true;
        if (dockRestartBtn) { dockRestartBtn.style.display = 'none'; }
        try {
            let existing = {};
            try {
                const getRes = await fetch('/kanban/verb/getStartupCommands', {
                    method: 'POST', credentials: 'same-origin',
                    headers: { 'Content-Type': 'application/json' }, body: '{}'
                });
                if (getRes.ok) {
                    const d = await getRes.json();
                    existing = d.commands || {};
                }
            } catch { /* ignore */ }
            await fetch('/kanban/verb/saveStartupCommands', {
                method: 'POST', credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ commands: { ...existing, dock_cli: 'switchboard' } })
            });
            const res = await fetch('/terminals/verb/ptyCreateTerminal', {
                method: 'POST', credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ role: 'dock_cli', name: dockCliSeatName(), hidden: true })
            });
            if (res.status === 503) {
                dockEmptyHint.textContent = 'Terminal backend is not available in this host.';
                return;
            }
            const data = await res.json();
            if (data && data.success !== false) {
                const name = data.friendlyName || data.name || (data.terminal && data.terminal.friendlyName) || dockCliSeatName();
                mountCliViewport(name);
            } else {
                dockEmptyHint.textContent = (data && data.error) || 'Could not start CLI terminal.';
            }
        } catch (err) {
            dockEmptyHint.textContent = 'Could not reach the server.';
        } finally {
            startBtn.disabled = false;
        }
    }

    // ── Fleet tab ────────────────────────────────────────────────────────
    // KEEP THIS POLL — it is the only source of hop state for the fleet tab.
    // `terminalsChanged` (restored by sibling card 198dba7a) covers terminal
    // *existence* via fetchTerminalList → terminalFleetState → renderTerminalSection
    // (the rail), but it carries only terminals + teams — never hop readiness.
    // refreshFleetTab additionally fetches getHopState and renders seatCards,
    // hop checkboxes, readiness reasons and the Start/Stop button. No push
    // carries hop state and no handler relays it (getHopState is a verb only,
    // never broadcastWs'd). Deleting this poll freezes the fleet tab's hop
    // display; retiring it requires first wiring a hop-state push relayed
    // through terminals.js to the shell (mirroring terminalFleetState). Do not
    // delete this on principle — the event that would replace it does not exist.
    function startFleetPoll() {
        stopFleetPoll();
        void refreshFleetTab();
        fleetPollTimer = setInterval(() => {
            if (readDockState().activeTab === 'fleet' && !document.hidden) {
                void refreshFleetTab();
            }
        }, 60000);
    }
    function stopFleetPoll() {
        if (fleetPollTimer) { clearInterval(fleetPollTimer); fleetPollTimer = null; }
    }

    document.addEventListener('visibilitychange', () => {
        if (document.hidden) {
            stopFleetPoll();
        } else if (readDockState().activeTab === 'fleet') {
            startFleetPoll();
        }
    });

    async function refreshFleetTab() {
        if (!dockFleetEl) return;
        try {
            const [termRes, hopRes] = await Promise.all([
                fetch('/terminals/verb/ptyListTerminals', {
                    method: 'POST', credentials: 'same-origin',
                    headers: { 'Content-Type': 'application/json' }, body: '{}'
                }).catch(() => null),
                fetch('/terminals/verb/getHopState', {
                    method: 'POST', credentials: 'same-origin',
                    headers: { 'Content-Type': 'application/json' }, body: '{}'
                }).catch(() => null)
            ]);
            if (!termRes || termRes.status !== 200 || !hopRes || hopRes.status !== 200) {
                renderFleetOffline(); return;
            }
            const termData = await termRes.json();
            const hopData = await hopRes.json();
            renderFleetContent(termData, hopData);
        } catch {
            renderFleetOffline();
        }
    }

    function renderFleetOffline() {
        if (dockFleetOfflineEl) dockFleetOfflineEl.hidden = false;
        if (dockFleetContentEl) dockFleetContentEl.hidden = true;
        if (dockHopPlanReason) dockHopPlanReason.textContent = 'unknown: offline';
        if (dockHopCodeReason) dockHopCodeReason.textContent = 'unknown: offline';
        if (dockHopReviewReason) dockHopReviewReason.textContent = 'unknown: offline';
    }

    function escapeHtml(str) {
        if (!str) return '';
        return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }
    function formatTime(ts) {
        if (!ts) return '';
        const d = new Date(ts);
        const hh = String(d.getHours()).padStart(2, '0');
        const mm = String(d.getMinutes()).padStart(2, '0');
        return `${hh}:${mm}`;
    }

    function renderFleetContent(termData, hopData) {
        if (dockFleetOfflineEl) dockFleetOfflineEl.hidden = true;
        if (dockFleetContentEl) dockFleetContentEl.hidden = false;
        const seatCards = (hopData && hopData.seatCards) || {};
        let terminals = [];
        if (Array.isArray(termData)) { terminals = termData; }
        else if (termData?.terminals && Array.isArray(termData.terminals)) { terminals = termData.terminals; }
        else if (termData?.result && Array.isArray(termData.result)) { terminals = termData.result; }

        if (dockFleetTbody) {
            dockFleetTbody.innerHTML = '';
            if (terminals.length === 0) {
                const tr = document.createElement('tr');
                tr.innerHTML = '<td colspan="4" style="color:var(--text-dim); text-align:center; padding:12px;">No active seats in fleet</td>';
                dockFleetTbody.appendChild(tr);
            } else {
                for (const t of terminals) {
                    const tr = document.createElement('tr');
                    const name = String(t?.friendlyName || t?.name || t?.terminalName || '?');
                    const role = String(t?.role || '-');
                    const status = String(t?.status || (t?.alive || t?.active ? 'active' : 'idle'));
                    const heldCard = seatCards[name];
                    const plan = String((heldCard && (heldCard.title || heldCard.planId)) || '-');
                    tr.innerHTML = `<td>${escapeHtml(name)}</td><td>${escapeHtml(role)}</td><td>${escapeHtml(status)}</td><td title="${escapeHtml(plan)}">${escapeHtml(plan)}</td>`;
                    dockFleetTbody.appendChild(tr);
                }
            }
        }
        if (dockHopPlanCb && hopData.hops) dockHopPlanCb.checked = !!hopData.hops.plan;
        if (dockHopCodeCb && hopData.hops) dockHopCodeCb.checked = !!hopData.hops.code;
        if (dockHopReviewCb && hopData.hops) dockHopReviewCb.checked = !!hopData.hops.review;
        const resolveReason = (hop) => {
            const readiness = hopData.readiness?.[hop];
            if (readiness) {
                if ('unknown' in readiness) return readiness.unknown;
                return readiness.reason || (readiness.free ? 'free' : 'busy');
            }
            return hopData.reasons?.[hop] || '';
        };
        if (dockHopPlanReason) dockHopPlanReason.textContent = resolveReason('plan');
        if (dockHopCodeReason) dockHopCodeReason.textContent = resolveReason('code');
        if (dockHopReviewReason) dockHopReviewReason.textContent = resolveReason('review');
        if (dockHopsBtn) {
            dockHopsBtn.textContent = hopData.started ? 'Stop' : 'Start';
            dockHopsBtn.setAttribute('data-started', String(!!hopData.started));
        }
        if (dockFleetFeedEl) {
            dockFleetFeedEl.innerHTML = '';
            const feed = hopData.feed || [];
            if (feed.length === 0) {
                const emptyLine = document.createElement('div');
                emptyLine.className = 'dock-feed-line';
                emptyLine.textContent = 'No fleet events recorded this session.';
                emptyLine.style.color = 'var(--text-dim)';
                dockFleetFeedEl.appendChild(emptyLine);
            } else {
                for (const item of feed) {
                    const line = document.createElement('div');
                    line.className = 'dock-feed-line';
                    const timeSpan = document.createElement('span');
                    timeSpan.className = 'dock-feed-time';
                    timeSpan.textContent = formatTime(item.timestamp);
                    const glyphSpan = document.createElement('span');
                    glyphSpan.className = 'dock-feed-glyph' + (item.kind === 'finish' ? ' is-finish' : '');
                    glyphSpan.textContent = item.kind === 'dispatch' ? '✓' : '·';
                    const textSpan = document.createElement('span');
                    textSpan.className = 'dock-feed-text';
                    textSpan.textContent = item.text;
                    textSpan.dataset.tooltip = item.text;
                    line.appendChild(timeSpan);
                    line.appendChild(glyphSpan);
                    line.appendChild(textSpan);
                    dockFleetFeedEl.appendChild(line);
                }
            }
        }
    }

    async function toggleHopCheckbox(hop, enabled) {
        try {
            const res = await fetch('/terminals/verb/setHopCheckbox', {
                method: 'POST', credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ hop, enabled })
            });
            if (res.ok) {
                const data = await res.json();
                if (data && data.success) { void refreshFleetTab(); }
            }
        } catch (err) {
            console.warn('[dock] Failed to toggle hop checkbox:', err);
        }
    }

    // ── Theme ────────────────────────────────────────────────────────────
    function applyTheme(themeName) {
        // Mirror the shell's theme-class logic. The shell posts
        // switchboardThemeChanged; this document applies the class to its own
        // body and re-themes each live viewport.
        try {
            document.body.classList.remove('theme-claudify', 'cyber-theme-enabled');
            if (themeName === 'claudify') {
                document.body.classList.add('theme-claudify');
            } else if (themeName === 'cyber') {
                document.body.classList.add('cyber-theme-enabled');
            }
        } catch { /* ignore */ }
        // Re-theme every live terminal. buildTerminalTheme reads CSS variables
        // off document.body, so the class change above is what makes this pick
        // up the new palette.
        for (const vp of [cliViewport]) {
            if (!vp) { continue; }
            for (const entry of terminalsMap.values()) {
                if (entry && entry.term) {
                    try { entry.term.options.theme = vp.buildTerminalTheme(); } catch { /* ignore */ }
                }
            }
        }
    }

    // ── Message listener (transport WS pushes) ───────────────────────────
    window.addEventListener('message', (event) => {
        const data = event.data;
        if (!data || typeof data.type !== 'string') { return; }
        if (data.type === 'switchboardThemeChanged') {
            applyTheme(data.theme);
        } else if (data.type === 'dockPresentationMode' && typeof data.mode === 'string'
                   && event.origin === location.origin) {
            // The shell tells the dock which presentation it is drawing, so
            // overlay-only behaviour (Escape dismissal) stays local to the
            // right mode — Escape in a split dock never closes anything.
            dockPresentationMode = data.mode;
        } else if (data.type === 'dockActivateTab' && typeof data.tab === 'string'
                   && event.origin === location.origin) {
            // Deep-link a dock tab — the shell posts this to land the operator
            // on e.g. the Composer tab when #btn-composer is clicked.
            setDockActiveTab(data.tab);
        } else if (data.type === 'missionControlArmed' && typeof data.armed === 'boolean') {
            lastAutobanArmed = data.armed;
            // The Agent tab is a control surface — no seat name to update.
            // The title is static ("Control Surface").
        } else if (data.type === 'terminalFleetState' && Array.isArray(data.terminals)) {
            // Re-sync the active seat tab on every fleet push. The Agent
            // tab is a control surface (no pty to sync); only CLI re-syncs.
            const tab = normaliseDockTab(readDockState().activeTab);
            if (tab === 'cli') { void syncCliSeat(); }
        } else if (data.type === 'dockTerminalExited' && typeof data.name === 'string') {
            // Only the CLI seat can exit now — the Agent tab is a control
            // surface with no pty to exit. Show the restart button + empty
            // state only when the CLI tab is active.
            const tab = normaliseDockTab(readDockState().activeTab);
            if (tab === 'cli') {
                if (dockRestartBtn) { dockRestartBtn.style.display = 'inline-block'; }
                void showCliEmptyState();
            }
        }
    });

    // ── Wire up controls ─────────────────────────────────────────────────
    if (dockTabAgentBtn) { dockTabAgentBtn.addEventListener('click', () => setDockActiveTab('agent')); }
    if (dockTabCliBtn) { dockTabCliBtn.addEventListener('click', () => setDockActiveTab('cli')); }
    if (dockTabFleetBtn) { dockTabFleetBtn.addEventListener('click', () => setDockActiveTab('fleet')); }
    if (dockTabComposerBtn) { dockTabComposerBtn.addEventListener('click', () => setDockActiveTab('composer')); }

    if (dockCloseBtn) {
        dockCloseBtn.addEventListener('click', () => {
            // Tell the shell to close the dock. The shell owns open/closed.
            try { window.parent.postMessage({ type: 'dockCloseRequested' }, location.origin); } catch { /* ignore */ }
        });
    }

    // In overlay mode Escape dismisses the dock — but only when focus is not
    // inside a field, so a stray Escape never destroys a half-written prompt
    // or rebinds a key mid-select. In split mode Escape does nothing here:
    // the dock is not an overlay and there is nothing to dismiss.
    document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape' || dockPresentationMode !== 'overlay') { return; }
        const el = document.activeElement;
        if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' ||
                   el.tagName === 'SELECT' || el.isContentEditable)) { return; }
        try { window.parent.postMessage({ type: 'dockCloseRequested' }, location.origin); } catch { /* ignore */ }
    });

    // Start button — CLI tab only (the Agent tab is a control surface).
    if (startBtn) {
        startBtn.addEventListener('click', () => {
            const tab = normaliseDockTab(readDockState().activeTab);
            if (tab === 'cli') { void startCliSeat(); }
        });
    }
    if (dockRestartBtn) {
        dockRestartBtn.addEventListener('click', () => {
            const tab = normaliseDockTab(readDockState().activeTab);
            if (tab === 'cli') { void startCliSeat(); }
        });
    }
    if (dockCliInput) {
        dockCliInput.addEventListener('input', () => {
            if (startBtn) { startBtn.disabled = !dockCliInput.value.trim(); }
        });
        dockCliInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                const tab = normaliseDockTab(readDockState().activeTab);
                if (tab === 'cli') { void startCliSeat(); }
            }
        });
    }

    // Agent control surface — the config row's save button. Every other action
    // is wired at render time inside loadAgentControlConfig (quick actions) or
    // handled by the pickers + runAgentAction.
    if (agentConfigSaveBtn) {
        agentConfigSaveBtn.addEventListener('click', () => void saveAgentControlConfig());
    }
    if (agentNavConfigSaveBtn) {
        agentNavConfigSaveBtn.addEventListener('click', () => void saveAgentNavigatorConfig());
    }

    if (dockHopPlanCb) { dockHopPlanCb.addEventListener('change', () => toggleHopCheckbox('plan', dockHopPlanCb.checked)); }
    if (dockHopCodeCb) { dockHopCodeCb.addEventListener('change', () => toggleHopCheckbox('code', dockHopCodeCb.checked)); }
    if (dockHopReviewCb) { dockHopReviewCb.addEventListener('change', () => toggleHopCheckbox('review', dockHopReviewCb.checked)); }
    if (dockHopsBtn) {
        dockHopsBtn.addEventListener('click', async () => {
            const started = dockHopsBtn.getAttribute('data-started') === 'true';
            try {
                const res = await fetch('/terminals/verb/toggleHops', {
                    method: 'POST', credentials: 'same-origin',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ started: !started })
                });
                if (res.ok) { void refreshFleetTab(); }
            } catch (err) {
                console.warn('[dock] Failed to toggle hops:', err);
            }
        });
    }

    // ── Resize observer: refit the CLI viewport on pane resize ───────────
    // The Agent tab is a control surface (no viewport to refit).
    const ro = new ResizeObserver(() => {
        const tab = normaliseDockTab(readDockState().activeTab);
        if (tab === 'cli' && cliViewport && cliSeatName) {
            const entry = terminalsMap.get(cliSeatName);
            if (entry) { cliViewport.fitAndReportSize(entry); }
        }
    });
    ro.observe(cliPane);

    // ── Init: apply the persisted tab ────────────────────────────────────
    const initialTab = normaliseDockTab(readDockState().activeTab);
    setDockActiveTab(initialTab);

    // ── Model polling: Start / Stop ────────────────────────────────────────
    // The TIMER LIVES IN THE BOARD, not here. These buttons only toggle it, so
    // closing this tab does not stop the polling. State is read back from the
    // board so two open surfaces cannot disagree about whether it is running.
    (function wirePollButtons() {
        const startBtn = document.getElementById('agent-poll-start');
        const stopBtn = document.getElementById('agent-poll-stop');
        const stateEl = document.getElementById('agent-poll-state');
        if (!startBtn && !stopBtn && !stateEl) { return; }

        function setState(t) { if (stateEl) { stateEl.textContent = t; } }

        const reportEl = document.getElementById('agent-poll-report');


        // A team's own reports: what its seats said they finished, blocked on,
        // or are working on. The controller writes one report for the whole
        // board, so these tabs are not a filter over it — they are a different
        // source, and the panel says which one it is showing.
        async function renderTeamReports(teamId) {
            try {
                const res = await fetch('/teams/' + encodeURIComponent(teamId) + '/reports?limit=12');
                const d = await res.json();
                const rows = (d && Array.isArray(d.data)) ? d.data.slice() : [];
                reportEl.textContent = '';
                const card = document.createElement('div');

                // Name the SOURCE at the top of the channel. These are the team's
                // own seats talking, not a filter over the controller's report,
                // and a reader who cannot tell the two apart reads one as the
                // other. It also gives the empty case somewhere to hang.
                const src = document.createElement('div');
                src.className = 'stencil';
                src.style.cssText = 'padding:10px 2px 8px;';
                src.textContent = rows.length
                    ? teamId.replace(/^team_/, '') + ' \u00b7 ' + rows.length
                        + (rows.length === 1 ? ' seat report' : ' seat reports')
                    : teamId.replace(/^team_/, '') + ' \u00b7 seat reports';
                card.appendChild(src);

                if (rows.length === 0) {
                    // An empty tab is a claim about the team, and it needs a source.
                    const e = document.createElement('div');
                    e.style.cssText = 'font-size:12px; color:var(--text-secondary); padding:2px;';
                    e.textContent = 'No seat on ' + teamId + ' has reported yet.';
                    card.appendChild(e);
                } else {
                    // Newest first: a team's latest word is what is being looked for.
                    rows.reverse();
                    for (const r of rows) {
                        const body = String((r && r.content) || '');
                        const meta = {};
                        const fm = body.match(/^---\n([\s\S]*?)\n---/);
                        if (fm) {
                            for (const line of fm[1].split('\n')) {
                                const kv = line.match(/^([a-zA-Z]+):\s*(.*)$/);
                                if (kv) { meta[kv[1]] = kv[2].trim(); }
                            }
                        }
                        const text = body.replace(/^---\n[\s\S]*?\n---\n?/, '').trim();
                        const row = document.createElement('div');
                        row.className = 'seat-report';

                        const h = document.createElement('div');
                        h.className = 'seat-head';
                        const from = document.createElement('span');
                        from.className = 'stencil seat-from';
                        from.textContent = meta.from || 'unknown seat';
                        // The kind is a STATE, so it takes a state colour \u2014 the
                        // brand accent is never one. `blocked` and `finished`
                        // reading identically is the thing worth seeing here.
                        const kind = String(meta.kind || 'report').toLowerCase();
                        const chip = document.createElement('span');
                        chip.className = 'seat-kind';
                        chip.textContent = kind;
                        chip.style.color = /block|fail|error/.test(kind) ? 'var(--error)'
                            : (/finish|done|complete/.test(kind) ? 'var(--success)'
                                : (/question|ask|wait/.test(kind) ? 'var(--warning)'
                                    : 'var(--text-secondary)'));
                        const when = document.createElement('span');
                        when.className = 'stencil seat-when';
                        // Relative, because "how long ago" is the question asked of
                        // a seat report. The absolute stamp stays on the tooltip.
                        const ts = Date.parse(meta.created);
                        if (!isNaN(ts)) {
                            const mins = Math.max(0, Math.round((Date.now() - ts) / 60000));
                            when.textContent = mins < 1 ? 'now'
                                : (mins < 60 ? mins + 'm' : (mins < 1440 ? Math.round(mins / 60) + 'h'
                                    : Math.round(mins / 1440) + 'd'));
                            try { when.title = new Date(ts).toLocaleString(); } catch { /* keep raw */ }
                        }
                        h.appendChild(from);
                        h.appendChild(chip);
                        h.appendChild(when);

                        const t = document.createElement('div');
                        t.className = 'seat-body';
                        t.textContent = text || '(empty report)';
                        row.appendChild(h);
                        row.appendChild(t);

                        // CLAMPED. A seat's report runs to 400 words; twelve of
                        // them unclamped is the 6,388px card that overflowed a
                        // 711px box. Four lines is enough to know whether this is
                        // the one you wanted, and the rest is one click away.
                        const more = document.createElement('button');
                        more.type = 'button';
                        more.className = 'seat-more';
                        more.textContent = 'Show more';
                        more.hidden = true;
                        more.addEventListener('click', () => {
                            const open = row.classList.toggle('is-open');
                            more.textContent = open ? 'Show less' : 'Show more';
                        });
                        row.appendChild(more);
                        // Only offer the control where there is something hidden.
                        requestAnimationFrame(() => {
                            if (t.scrollHeight > t.clientHeight + 2) { more.hidden = false; }
                        });
                        card.appendChild(row);
                    }
                }
                reportEl.appendChild(card);
            } catch {
                reportEl.textContent = 'Team reports unavailable.';
            }
        }

        // ONE report, replaced in place every poll. This was a scrolling
        // transcript, which meant a five-minute poll on a quiet board stacked the
        // same paragraph over and over and the current state of the board had to
        // be reconstructed by reading down the list. The panel shows the LATEST
        // report only: columns, teams, assessment, and what is next.
        /** The last parameters pass's message, rendered above the strips until
         *  the next pass replaces it. A refusal must outlive the click. */
        let lastParameterMessage = null;

        /**
         * Run the parameters pass over ONE mission, then repaint from the ONE
         * mission renderer so the strip shows what the board now holds. The pass
         * writes dependency edges, `missions.team` and `missions.max_extra_worktrees`
         * and NEVER stages a card — the operator's next gesture is the start.
         */
        async function runNavigatorParameters(missionId, btn) {
            if (!missionId) { return; }
            if (btn) { btn.disabled = true; }
            try {
                const res = await fetch('/controller/navigator/parameters', {
                    method: 'POST', credentials: 'same-origin',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ missionId: missionId }),
                });
                const data = await res.json().catch(() => ({}));
                if (!res.ok || data.success === false) {
                    lastParameterMessage = { text: 'Parameters failed: ' + (data.error || ('HTTP ' + res.status)), isError: true };
                } else {
                    lastParameterMessage = {
                        text: data.message || 'The parameters pass answered without a message.',
                        isError: data.kind !== 'applied',
                    };
                }
            } catch (err) {
                lastParameterMessage = { text: 'Parameters failed: ' + (err?.message || err), isError: true };
            } finally {
                if (btn) { btn.disabled = false; }
                await refreshReport();
            }
        }

        async function refreshReport() {
            if (!reportEl) { return; }
            if (selectedTeam) { await renderTeamReports(selectedTeam); return; }
            try {
                const res = await fetch('/controller/report');
                const d = await res.json();
                const md = d && d.report && typeof d.report.content === 'string' ? d.report.content : '';
                const wakes = md.split('## Wake ').slice(1);

                // Walk backwards to the most recent wake that actually produced a
                // board check. A wake that only logged capabilities is not a
                // report, and showing "nothing observed" because the newest wake
                // happened to be one of those would be a lie about the board.
                let latest = null;
                for (let i = wakes.length - 1; i >= 0 && !latest; i--) {
                    const w = wakes[i];
                    const at = w.indexOf('### Actions');
                    if (at < 0) { continue; }
                    const body = w.slice(at);
                    let text = '';
                    for (const raw of body.split('\n')) {
                        const m = raw.trim().match(/^-\s*outcome:\s*\*\*([a-z-]+)\*\*\s*(?:—|--)?\s*(.*)$/i);
                        if (m) { text = (m[2] || '').trim() || m[1]; break; }
                    }
                    if (!text) { continue; }
                    let facts = null;
                    const ev = body.match(/```\s*([\s\S]*?)```/);
                    if (ev) { try { facts = JSON.parse(ev[1].trim()); } catch { /* not the evidence we know */ } }
                    const errors = [];
                    const ei = w.indexOf('### Errors');
                    if (ei >= 0) {
                        let eb = w.slice(ei + '### Errors'.length);
                        const nx = eb.search(/\n#{2,3} /);
                        if (nx >= 0) { eb = eb.slice(0, nx); }
                        for (const raw of eb.split('\n')) {
                            const l = raw.trim();
                            if (l.startsWith('- ')) { errors.push(l.slice(2).trim()); }
                        }
                    }
                    const stamp = (w.match(/^(\S+)/) || [])[1] || '';
                    let time = stamp;
                    try { time = new Date(stamp).toLocaleTimeString(); } catch { /* keep raw */ }
                    latest = { time: time, stamp: stamp, text: text, facts: facts, errors: errors };
                }

                reportEl.textContent = '';
                if (!latest) {
                    const empty = document.createElement('div');
                    empty.className = 'agent-poll-empty';
                    empty.style.cssText = 'font-size:11px; color:var(--text-dim); padding:8px 2px;';
                    empty.textContent = 'No report yet — the agent speaks every 5 minutes.';
                    reportEl.appendChild(empty);
                    return;
                }

                const f = latest.facts || {};
                const mk = function (tag, css, txt) {
                    const el = document.createElement(tag);
                    if (css) { el.style.cssText = css; }
                    if (txt !== undefined) { el.textContent = txt; }
                    return el;
                };

                // ── Crew station panel, not a settings screen ─────────────────
                // The organising idea is an annunciator: dark until something
                // trips, then lit and legible from across the room. Plain crew
                // language, one state word, and the detail under it. Everything
                // an operator cannot act on (model ids, endpoints, tier wording)
                // lives in config, not here.
                // Classes, not cssText: the skin lives in dock.html beside the
                // crew stations, so the annunciator and the stations cannot drift
                // into two different instruments.
                const card = mk('div', '');

                // Missions first: they are the subject. A MISSION is the board's
                // own long-horizon entity (name, goal, team, worktree allowance,
                // members) — not a feature. One aggregate call carries every
                // mission's progress; counting it in the browser meant shipping
                // the whole board, 929KB, to a phone.
                let missions = [];
                let mSummary = null;
                let loose = null;
                let missionsReadable = true;
                try {
                    const fr = await fetch('/kanban/missions/progress');
                    const fd = await fr.json();
                    const d = (fd && fd.data) || {};
                    missions = Array.isArray(d.missions) ? d.missions : [];
                    mSummary = d.summary || null;
                    loose = d.outsideMissions || null;
                } catch { missionsReadable = false; }

                // How old this report is. Deleted once already by an edit that
                // replaced the block it sat in, which threw a ReferenceError inside
                // the render and put "Report unavailable." on screen — the catch
                // reported a dead endpoint for what was a typo-class bug.
                let age = '';
                const reportMs = Date.parse(latest.stamp);
                if (!isNaN(reportMs)) {
                    const am = Math.max(0, Math.round((Date.now() - reportMs) / 60000));
                    age = am < 1 ? 'just now' : (am < 60 ? am + ' min ago' : Math.round(am / 60) + 'h ago');
                }

                const elapsed = function (iso) {
                    const t = Date.parse(iso);
                    if (isNaN(t)) { return ''; }
                    const mins = Math.max(0, Math.round((Date.now() - t) / 60000));
                    return mins < 60 ? mins + 'm' : Math.round(mins / 60) + 'h';
                };

                // ── ANNUNCIATOR ──────────────────────────────────────────────
                // The verdict answers seats and board. It is NOT a whole-board
                // all-clear while nothing can see a mission, so the caption says
                // what was actually checked underneath.
                let verdict = latest.text;
                const shape = String(f.boardShape || '');
                if (shape && verdict.indexOf(shape) === 0) {
                    verdict = verdict.slice(shape.length).replace(/^[^—-]*[—-]\s*/, '').trim() || latest.text;
                }
                const clear = /^no problems found/i.test(verdict);
                let word = clear ? (missions.length ? 'ALL CLEAR' : 'STANDBY') : 'CHECK';
                let lamp = clear ? (missions.length ? 'var(--success)' : 'var(--text-secondary)') : 'var(--warning)';
                let caption;
                if (!clear) {
                    caption = verdict;
                } else if (!missionsReadable) {
                    word = 'CHECK';
                    lamp = 'var(--warning)';
                    caption = 'Mission state could not be read.';
                } else if (missions.length) {
                    // A mission's scale is its FEATURES and its CARDS. Reporting
                    // only cards hides what a mission is actually made of.
                    const t = mSummary ? mSummary.cardsTotal : 0;
                    const dn = mSummary ? mSummary.cardsDone : 0;
                    const fc = missions.reduce(function (a, m) { return a + (m.featureCount || 0); }, 0);
                    const bits = [missions.length + (missions.length === 1 ? ' mission' : ' missions')];
                    if (fc) { bits.push(fc + (fc === 1 ? ' feature' : ' features')); }
                    if (t) { bits.push(dn + ' of ' + t + ' cards done'); }
                    caption = bits.join(' \u00b7 ');
                } else if (loose && (loose.inFlightFeatures || loose.parkedFeatures)) {
                    // NO MISSION IS NOT NO WORK. Features outside a mission are
                    // still features being worked, and saying only "no mission"
                    // reads as "nothing is happening" on a board carrying 39 of
                    // them. Held work and part-done work stay separate claims:
                    // reporting parked work as in flight once said 39 features
                    // were running on a board where nothing was.
                    word = 'STANDBY';
                    caption = loose.inFlightFeatures
                        ? 'No mission set up. ' + loose.inFlightFeatures
                            + (loose.inFlightFeatures === 1 ? ' feature is' : ' features are')
                            + ' in flight outside one.'
                        : 'No mission set up. ' + loose.parkedFeatures
                            + (loose.parkedFeatures === 1 ? ' feature is' : ' features are')
                            + ' part-done and parked; nothing is in flight.';
                } else {
                    caption = 'No mission running, and no feature in flight.';
                }

                // The legend IS the lamp — no dot beside a word. Lit in the
                // state's own colour, on the scope field.
                const ann = mk('div', '');
                ann.className = 'ann';
                const wordEl = mk('div', 'color:' + lamp
                    + '; text-shadow:0 0 16px color-mix(in srgb, ' + lamp + ' 45%, transparent);', word);
                wordEl.className = 'ann-word';
                ann.appendChild(wordEl);
                const capEl = mk('div', '', caption);
                capEl.className = 'ann-caption';
                ann.appendChild(capEl);
                const checkedBits = ['Seats and board checked ' + (age || 'just now')];
                if (f.seatsAliveCount !== undefined) {
                    checkedBits.push(f.seatsAliveCount + (f.seatsAliveCount === 1 ? ' seat up' : ' seats up'));
                }
                const stampEl = mk('div', 'margin-top:9px;', checkedBits.join('  ·  '));
                stampEl.className = 'stencil';
                ann.appendChild(stampEl);
                card.appendChild(ann);

                // ── SYSTEMS CHECK ────────────────────────────────────────────
                // With nothing flying, the panel's job is to say whether the board
                // is READY to fly. Each row is a system, its lamp, and the one fact
                // that decides it. A row that cannot be read says so rather than
                // reporting a system as good.
                if (!missions.length) {
                    const sys = mk('div', 'padding-top:6px;');
                    const line = function (label, ok, detail) {
                        const el = mk('div', '');
                        el.className = 'sys-row';
                        // TEAMS failing drew a dead grey dot while BOARD passing
                        // drew a bright green one, so the problem was the quieter
                        // mark. An unlit item is now a hollow ring — deliberately
                        // dark, in the annunciator idiom, rather than a smudge
                        // that reads as a rendering artifact.
                        const colour = ok === null ? 'var(--warning)'
                            : (ok ? 'var(--success)' : 'var(--text-dim)');
                        const lamp = mk('span', ok === false
                            ? 'border:1px solid ' + colour + '; background:transparent;'
                            : 'background:' + colour + '; box-shadow:0 0 6px ' + colour + ';');
                        lamp.className = 'sys-lamp';
                        el.appendChild(lamp);
                        const name = mk('span', '', label);
                        name.className = 'stencil sys-name';
                        el.appendChild(name);
                        const fact = mk('div', 'color:'
                            + (ok === false ? 'var(--text-secondary)' : 'var(--text-primary)') + ';', detail);
                        fact.className = 'sys-fact';
                        el.appendChild(fact);
                        sys.appendChild(el);
                    };

                    // NO PILOT ROW. The Pilot station above is the lamp, and it
                    // carries the switch — a checklist line repeating it was the
                    // third of four places this panel said the same thing, and the
                    // only one of the four that could not act on it.

                    // Teams: seats are what actually do the work.
                    const teams = (f.seatsByTeam && typeof f.seatsByTeam === 'object')
                        ? Object.keys(f.seatsByTeam) : [];
                    const seatCount = f.seatsAliveCount || 0;
                    line('Teams', seatCount > 0,
                        seatCount > 0
                            ? seatCount + (seatCount === 1 ? ' seat up' : ' seats up')
                                + (teams.length ? ' · ' + teams.join(', ') : '')
                            : 'No seats up. Start a team before a mission can run.');

                    // ── THREE LEVELS, THREE ROWS ─────────────────────────
                    // MISSION -> FEATURES (+ loose plans) -> CARDS. The panel
                    // collapsed the middle one: features were reported under a
                    // generic "Work" label while the row named "Missions" read
                    // "None set up", so a board carrying 39 part-done features
                    // reported as a board with nothing on it.

                    // PLANS: cards waiting to be handed out. This row was called
                    // "Board", which named the surface rather than the thing being
                    // counted and left the panel with no word for a plan at all.
                    const cols = (f.cardsByColumn && typeof f.cardsByColumn === 'object') ? f.cardsByColumn : null;
                    if (cols) {
                        const ready = cols['PLAN REVIEWED'] || 0;
                        const created = cols['CREATED'] || 0;
                        line('Plans', ready > 0,
                            ready > 0
                                ? ready + ' reviewed and ready'
                                    + (created ? ' \u00b7 ' + created + ' awaiting review' : '')
                                : 'Nothing plan-reviewed. Nothing is ready to start.');
                    } else {
                        line('Plans', null, 'Column counts were not reported this pass.');
                    }

                    // FEATURES: a feature holds subtask plans. It is NOT a mission.
                    if (!missionsReadable) {
                        line('Features', null, 'Feature and mission state could not be read.');
                    } else if (loose && (loose.parkedFeatures || loose.inFlightFeatures)) {
                        const bits = [];
                        if (loose.inFlightFeatures) {
                            bits.push(loose.inFlightFeatures + ' in flight');
                        }
                        if (loose.parkedFeatures) {
                            bits.push(loose.parkedFeatures + ' part-done and parked, '
                                + loose.parkedCardsDone + ' of ' + loose.parkedCards + ' cards finished');
                        }
                        line('Features', !!loose.inFlightFeatures, bits.join(' \u00b7 '));
                    } else {
                        line('Features', false, 'None in flight.');
                    }

                    // MISSIONS: the board's own long-horizon entity — a name, a
                    // goal, a team, a worktree allowance and member features. Only
                    // the Navigator sets one up, which is why this row carries no
                    // action: nothing on this panel can start a mission.
                    line('Missions', false, missionsReadable
                        ? 'None set up. A mission groups features under one goal.'
                        : 'Mission state could not be read.');
                    card.appendChild(sys);
                }

                // ── MISSION STRIPS ───────────────────────────────────────────
                // What the last parameters pass said, if one has run. It is
                // rendered here rather than in a transient toast because a
                // refusal (a cycle, an invalid reply) is the operator's only
                // signal that the mission was left unarranged.
                if (lastParameterMessage) {
                    const pm = mk('div', 'padding-top:6px;', lastParameterMessage.text);
                    pm.className = 'stencil mission-param' + (lastParameterMessage.isError ? ' is-error' : '');
                    card.appendChild(pm);
                }
                if (missions.length) {
                    const strips = mk('div', 'padding-top:6px;');
                    for (const m of missions) {
                        const s = mk('div', '');
                        s.className = 'mission-strip';
                        const nameEl = mk('div', '', String(m.name || m.id || ''));
                        nameEl.className = 'mission-name';
                        s.appendChild(nameEl);

                        // A progress bar only where there is progress to show. A
                        // bar drawn from a zero denominator is a picture of a
                        // fact nobody has.
                        if (m.cardsTotal > 0) {
                            const pct = Math.round((m.cardsDone / m.cardsTotal) * 100);
                            const track = mk('div', '');
                            track.className = 'mission-track';
                            const fill = mk('div', 'width:' + pct + '%;');
                            fill.className = 'mission-fill';
                            track.appendChild(fill);
                            s.appendChild(track);
                        }
                        // Long horizon is the point: how much work, how far in,
                        // how long it has been going, and when it last moved.
                        const meta = [];
                        if (m.cardsTotal > 0) { meta.push(m.cardsDone + ' of ' + m.cardsTotal + ' cards'); }
                        if (m.featureCount) { meta.push(m.featureCount + (m.featureCount === 1 ? ' feature' : ' features')); }
                        if (m.cardsInFlight) { meta.push(m.cardsInFlight + ' in flight'); }
                        if (m.team) { meta.push(String(m.team)); }
                        const started = elapsed(m.startedAt);
                        if (started) { meta.push('running ' + started); }
                        const mv = elapsed(m.lastMovementAt ? new Date(m.lastMovementAt).toISOString() : null);
                        if (mv) { meta.push('moved ' + mv + ' ago'); }
                        if (m.maxExtraWorktrees) { meta.push(m.maxExtraWorktrees + ' worktrees'); }
                        if (m.paused) { meta.push('PAUSED'); }
                        const metaEl = mk('div', 'margin-top:7px;', meta.join('  ·  '));
                        metaEl.className = 'stencil';
                        s.appendChild(metaEl);

                        // ── THE MISSION'S PARAMETERS ─────────────────────────
                        // Order, team and worktree decision, each labelled with
                        // whether the NAVIGATOR or the OPERATOR set it. The
                        // order is rendered from `sequencing`, which the board
                        // derives from the dependency edges the queue itself
                        // obeys — a view, not a second store, so the strip and
                        // the pop cannot disagree.
                        //
                        // Three states that must not render alike: nobody has
                        // arranged this mission; the Navigator arranged it and
                        // found no ordering constraints; the Navigator recorded
                        // an order. `parameters === null` is the first.
                        const p = m.parameters || null;
                        const paramLines = mk('div', 'margin-top:6px;');
                        paramLines.className = 'stencil mission-params';

                        const orderLine = mk('div', '');
                        const seq = Array.isArray(m.sequencing) ? m.sequencing.filter(Boolean) : [];
                        if (!p) {
                            orderLine.className = 'mission-param is-unset';
                            orderLine.textContent = 'Insertion order — not ordered by the Navigator.';
                        } else if (p.finding === 'no-hard-ordering-constraints') {
                            orderLine.className = 'mission-param is-unset';
                            orderLine.textContent = 'No hard ordering constraints — the Navigator read the cards and found none.';
                        } else if (seq.length) {
                            orderLine.className = 'mission-param';
                            orderLine.textContent = 'Order (Navigator): ' + seq.join('  ·  ');
                        } else {
                            orderLine.className = 'mission-param is-unset';
                            orderLine.textContent = 'The Navigator recorded an order, but the board renders none.';
                        }
                        paramLines.appendChild(orderLine);

                        const teamLine = mk('div', '');
                        teamLine.className = 'mission-param';
                        if (p && p.team) {
                            teamLine.textContent = 'Team: ' + p.team + ' (' + (p.setters && p.setters.team === 'operator' ? 'operator' : 'Navigator') + ')';
                        } else if (p) {
                            teamLine.textContent = 'Team: none — ' + (p.teamReason || 'no team assigned');
                        } else if (m.team) {
                            teamLine.textContent = 'Team: ' + m.team + ' (operator)';
                        } else {
                            teamLine.textContent = 'Team: none set.';
                        }
                        paramLines.appendChild(teamLine);

                        const wtLine = mk('div', '');
                        wtLine.className = 'mission-param';
                        if (p) {
                            const who = p.setters && p.setters.worktree === 'operator' ? 'operator'
                                : (p.setters && p.setters.worktree === 'default' ? 'default' : 'Navigator');
                            wtLine.textContent = 'Worktrees: ' + (p.maxExtraWorktrees || 0)
                                + (p.maxExtraWorktrees ? ' extra' : ' (fail-safe default)')
                                + ' (' + who + ')' + (p.worktreeReason ? ' — ' + p.worktreeReason : '');
                        } else {
                            wtLine.textContent = 'Worktrees: 0 (fail-safe default)';
                        }
                        paramLines.appendChild(wtLine);
                        s.appendChild(paramLines);

                        // The operator's gesture for this pass. The plan gives the
                        // strip a display role and names no trigger; a pass with no
                        // way to run it would make every line above dead code, so
                        // the strip carries the one button that runs it.
                        if (m.planCount || m.cardsTotal) {
                            const fillBtn = document.createElement('button');
                            fillBtn.type = 'button';
                            fillBtn.className = 'mission-param-btn';
                            fillBtn.textContent = p ? 'Re-derive parameters' : 'Fill in parameters';
                            fillBtn.addEventListener('click', () => void runNavigatorParameters(m.id, fillBtn));
                            s.appendChild(fillBtn);
                        }

                        strips.appendChild(s);
                    }
                    card.appendChild(strips);
                }

                // ── NEXT UP ──────────────────────────────────────────────────
                const offer = f.nextHighestPriority || null;
                const foot = mk('div', '');
                foot.className = 'next-up';
                const footLabel = function (txt) {
                    const el = mk('div', '', txt);
                    el.className = 'stencil';
                    return el;
                };
                if (offer && offer.id) {
                    const label = footLabel('Next up');
                    const kind = offer.kind === 'feature' ? 'feature' : 'plan';
                    const kindChip = mk('span', '', kind);
                    kindChip.className = 'next-up-kind';
                    kindChip.title = kind === 'feature'
                        ? 'A feature holds subtask plans. It is not a mission.'
                        : 'A single plan card.';
                    label.appendChild(kindChip);
                    foot.appendChild(label);
                    const topic = mk('div', '', String(offer.topic || offer.id));
                    topic.className = 'next-up-topic';
                    foot.appendChild(topic);
                    const act = document.createElement('button');
                    act.type = 'button';
                    act.className = 'next-up-go';
                    // NAME THE THING. `kind` is only ever 'feature' or 'plan'
                    // (controller.ts: `isFeature ? 'feature' : 'plan'`) — there is
                    // no mission kind, nothing on this panel can start a mission,
                    // and the Navigator is what sets one up. Calling a feature a
                    // mission here made the board's middle level invisible and
                    // promised an action the button does not perform.
                    act.textContent = 'Start ' + (offer.kind === 'feature' ? 'feature' : 'plan');
                    act.title = String(offer.topic || '') + ' (' + offer.id + ')';
                    act.addEventListener('click', async () => {
                        act.disabled = true;
                        act.textContent = 'starting…';
                        try {
                            const r = await fetch('/kanban/dispatch', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ planId: offer.id })
                            });
                            const rd = await r.json().catch(() => null);
                            if (r.ok && rd && rd.success !== false) {
                                act.textContent = 'started';
                                setState('dispatched ' + offer.id);
                            } else {
                                act.textContent = 'failed';
                                setState('dispatch failed: ' + ((rd && (rd.reason || rd.error)) || r.status));
                                act.disabled = false;
                            }
                        } catch (err) {
                            act.textContent = 'failed';
                            setState('dispatch failed: ' + String(err));
                            act.disabled = false;
                        }
                    });
                    foot.appendChild(act);
                } else {
                    foot.appendChild(footLabel('Next up'));
                    const none = mk('div', '', 'Nothing ready to start.');
                    none.className = 'next-up-topic';
                    none.style.color = 'var(--text-secondary)';
                    foot.appendChild(none);
                }
                card.appendChild(foot);

                if (latest.errors.length) {
                    const errs = mk('div', 'padding:10px 2px; border-top:1px solid var(--panel-line);');
                    errs.appendChild(footLabel('Faults'));
                    for (const e of latest.errors) {
                        errs.appendChild(mk('div', 'font-size:12px; color:var(--warning); '
                            + 'line-height:1.4; margin-top:3px;', e));
                    }
                    card.appendChild(errs);
                }

                reportEl.appendChild(card);
            } catch {
                reportEl.textContent = 'Report unavailable.';
            }
        }

        async function post(path) {
            try {
                const res = await fetch(path, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: '{}'
                });
                const data = await res.json().catch(() => null);
                return { ok: res.ok, status: res.status, data };
            } catch (err) { return { ok: false, status: 0, data: { error: String(err) } }; }
        }

        // WHETHER the watch is armed is the Pilot station's job — it is the
        // lamp. This line carries only what the station has no room for: the
        // cadence, when it last ran, and the last error. It used to restate
        // "stopped" beside a row that already said STOPPED, beside a checklist
        // that said "Not watching", beside a chip naming the same model: one
        // fact, four times, and none of them where the switch was.
        async function refreshState() {
            try {
                const res = await fetch('/controller/poll/state');
                const d = await res.json();
                // SILENT WHEN NORMAL. Cadence and last-run live in the Pilot
                // tile; this line exists for the things a tile has no room for —
                // a failed pass, or a control that did not take.
                setState(d && d.lastError ? 'Last pass errored: ' + d.lastError : '');
            } catch { setState('Watch state unavailable.'); }
        }

        if (startBtn) {
            startBtn.addEventListener('click', async () => {
                setState('arming…');
                const r = await post('/controller/poll/start');
                if (!r.ok || !r.data || r.data.success === false) {
                    setState('arm failed: ' + ((r.data && (r.data.reason || r.data.error)) || r.status));
                    return;
                }
                // The STATION has to be repainted, not just the state line.
                // loadModels ran once at init and nothing ever re-called it, so
                // arming the watch left PILOT reading STOPPED with a dark lamp
                // until the surface was reloaded — the panel's most prominent
                // element was the one guaranteed to be out of date.
                void loadModels();
                void refreshState();
                void refreshReport();
            });
        }
        if (stopBtn) {
            stopBtn.addEventListener('click', async () => {
                setState('stopping…');
                const r = await post('/controller/poll/stop');
                if (!r.ok || !r.data || r.data.success === false) {
                    setState('stop failed: ' + ((r.data && (r.data.reason || r.data.error)) || r.status));
                    return;
                }
                void loadModels();
                void refreshState();
            });
        }

        // ── Who is flying ─────────────────────────────────────────────────
        // TWO MODELS, TWO JOBS. Pilot is the local model on the 5-minute loop;
        // Navigator is the larger model that organizes work. Neither is a
        // fallback for the other, and the Navigator is NOT the model the Pilot
        // escalates to — it is a separately configured slot. An unconfigured
        // Navigator says so: an absent model must never read like a present one.
        function prettyModel(id) {
            const raw = String(id || '').trim();
            if (!raw) { return null; }
            const bits = raw.split(':');
            // Training suffixes are not part of a model's name to a reader.
            // The exact id is always on the tooltip, so nothing is lost.
            const NOISE = ['it', 'qat', 'instruct', 'chat', 'latest'];
            const family = bits[0].replace(/[-_]/g, ' ').split(' ')
                .filter(function (w) { return w && NOISE.indexOf(w.toLowerCase()) < 0; })
                .join(' ')
                .replace(/([a-z])(\d)/gi, '$1 $2')
                .replace(/\b\w/g, function (c) { return c.toUpperCase(); })
                // Parameter counts read as 31B, not 31b.
                .replace(/\b(\d+)\s*([bm])\b/gi, function (_m, n, u) { return n + u.toUpperCase(); });
            const variant = bits.length > 1 ? String(bits[1]).split('-')[0].toUpperCase() : '';
            return (family + (variant ? ' ' + variant : '')).trim();
        }

        // Where the evidence GOES, from the tier's own locality. 'cloud' is said
        // for anything off the box, because "local" next to a model that is
        // actually a third-party API is the one label an operator would act on.
        function placeOf(tier) {
            const loc = String((tier && tier.locality) || '');
            if (loc === 'loopback' || loc === 'local') { return 'local'; }
            if (loc === 'lan' || loc === 'tailnet') { return loc; }
            if (loc === 'internet' || loc === 'cloud') { return 'cloud'; }
            return '';
        }

        async function loadModels() {
            const host = document.getElementById('agent-models');
            if (!host) { return; }
            let pilot = null;
            let pilotFault = null;
            let navigator = null;
            // The Navigator's own state, from its own route. `navMissing` names
            // the reason the station is dark; it is set from the server's own
            // reason, never guessed. `navReadable` distinguishes "the host did
            // not answer" from "there is genuinely no Navigator" — those must
            // never render the same string.
            let navMissing = 'no Navigator model configured';
            let navReadable = false;
            try {
                const r = await fetch('/controller/judgement');
                const d = await r.json();
                const j = (d && d.judgement) || {};
                const tiers = j.tiers || [];
                // Pilot is the classifier tier. `supervisorSeat` is a SEAT NAME,
                // not a model, so it is not what names anything here — reading it
                // would have labelled a model with a terminal's name.
                const tier = tiers.filter(function (t) { return t && t.role === 'classifier'; })[0];
                if (tier && tier.model) {
                    // Locality comes from the tier, never guessed from the URL.
                    // Omitted rather than assumed when the tier does not say.
                    pilot = {
                        name: prettyModel(tier.model),
                        where: placeOf(tier),
                        raw: tier.model,
                        note: tier.costClass === 'metered' ? 'metered' : '',
                    };
                } else if (tier && tier.endpoint) {
                    // A server is set and no model resolved against it. That is
                    // a FAULT, not an empty seat, and it says which endpoint so
                    // the operator can check the box rather than the panel.
                    pilotFault = tier.endpoint;
                }
            } catch { /* the Pilot stays null, and says so below */ }

            // The Navigator is NOT a judgement tier — it is its own model slot,
            // read from its own route (plan: the-navigator-is-its-own-model-slot).
            try {
                const nr = await fetch('/controller/navigator');
                if (nr.ok) {
                    const nd = await nr.json();
                    const nav = (nd && nd.navigator) || null;
                    navReadable = true;
                    if (nav && nav.model) {
                        navigator = {
                            name: prettyModel(nav.model),
                            where: placeOf(nav),
                            raw: nav.model,
                            note: nav.costClass === 'metered' ? 'metered' : '',
                        };
                    } else if (nav && nav.reason) {
                        // The server's own reason, verbatim — "unset" and "a
                        // pointer naming a provider with no row" are different
                        // states and must not both read as "not configured".
                        navMissing = nav.reason;
                    }
                }
            } catch { /* navReadable stays false — an unanswered read is not "unset" */ }

            // Is the Pilot actually flying? A station that names a model but not
            // whether it is running is a settings row, which is what made this
            // read as a tool rather than a panel.
            let flying = false;
            let cadence = '';
            try {
                const pr = await fetch('/controller/poll/state');
                const pd = await pr.json();
                flying = !!(pd && pd.running);
                // How often and how recently, rendered INSIDE the Pilot tile.
                // As a line under the crew bar it read as an orphaned sentence
                // belonging to nothing; it is a Pilot fact and it sits with the
                // Pilot. The state line below is transient messages only.
                if (flying) {
                    const mins = Math.round((pd.intervalMs || 0) / 60000);
                    const ranAt = Date.parse(pd.lastRunAt);
                    cadence = 'every ' + mins + ' min';
                    if (!isNaN(ranAt)) {
                        const ago = Math.max(0, Math.round((Date.now() - ranAt) / 60000));
                        cadence += ' · ran ' + (ago < 1 ? 'just now' : ago + 'm ago');
                    }
                }
            } catch { /* unknown stays dark rather than claiming WATCHING */ }

            // Today's spend against each station's daily allowance.
            let budget = null;
            try {
                const br = await fetch('/controller/budget');
                const bd = await br.json();
                if (bd && bd.success !== false) { budget = bd; }
            } catch { /* the station simply shows no allowance */ }

            // Build first, swap last: clearing the host detaches the arm switch
            // (it is a real wired button, moved in here rather than duplicated),
            // so a throw between clear and append would take the control with it.
            const stations = document.createDocumentFragment();

            // A crew station: who it is, whether its lamp is lit, what it is
            // doing, and — for the Pilot — the switch that arms it. The model id,
            // its locality and whether it is metered are setup facts; they live
            // on the tooltip and in config.
            const station = function (role, jet, m, state, lit, spend, control, detail, fault) {
                const el = document.createElement('div');
                el.className = 'crew-station ' + (lit ? 'is-lit' : 'is-dark');

                const head = document.createElement('div');
                head.className = 'crew-head';
                // The role's own aircraft — the same file the board rail draws,
                // so two surfaces cannot end up with different art for one role.
                const img = document.createElement('img');
                img.className = 'crew-jet';
                img.src = '/static/icons/team-' + jet + '.svg';
                img.alt = '';
                const r = document.createElement('span');
                r.className = 'crew-role';
                r.textContent = role;
                head.appendChild(img);
                head.appendChild(r);
                el.appendChild(head);

                // The legend IS the lamp.
                const v = document.createElement('div');
                v.className = 'crew-state';
                v.textContent = state;
                el.appendChild(v);

                const name = document.createElement('div');
                name.className = 'crew-model';
                if (m) {
                    const where = [];
                    if (m.where) { where.push(m.where); }
                    if (m.note) { where.push(m.note); }
                    name.textContent = m.name + (where.length ? ' · ' + where.join(', ') : '');
                    name.title = String(m.raw || '');
                } else if (role === 'NAVIGATOR') {
                    // The server's own reason for a dark Navigator — "no
                    // Navigator model configured", or a pointer naming a
                    // provider with no row. A read that never ANSWERED says so
                    // instead: "the host has not answered yet" and "there is
                    // genuinely no Navigator" must never render the same string.
                    name.textContent = navReadable ? navMissing : 'Navigator state could not be read';
                    name.title = navReadable ? navMissing : 'GET /controller/navigator did not answer.';
                } else if (fault) {
                    name.textContent = 'server set, no model resolved';
                    name.title = fault;
                } else {
                    name.textContent = 'not configured';
                }
                el.appendChild(name);

                // Usage against the daily allowance. Shown ONLY where an
                // allowance is actually known: "12" on its own invites the
                // operator to imagine a ceiling, and an unmetered local model has
                // none to imagine.
                if (spend && spend.configured && spend.budget) {
                    const b = spend.budget;
                    const u = document.createElement('div');
                    u.className = 'crew-readout';
                    if (b.perDay !== null) {
                        const over = spend.usedToday >= b.perDay;
                        const near = !over && spend.usedToday >= b.perDay * 0.8;
                        u.classList.add(over ? 'is-over' : (near ? 'is-near' : 'is-normal'));
                        u.textContent = spend.usedToday + ' / ' + b.perDay + ' today';
                        u.title = b.note + ' (' + b.source + ')';
                    } else if (b.source === 'unmetered') {
                        // No ceiling to count against, so none is drawn — and
                        // with nothing spent yet there is no measure either, so
                        // the row is omitted rather than printing the word
                        // "unmetered" where a number belongs.
                        u.textContent = spend.usedToday ? spend.usedToday + ' calls today' : '';
                        u.title = b.note;
                    } else {
                        // Unknown allowance: say so rather than draw a bare count
                        // that looks like it is measured against something.
                        u.textContent = spend.usedToday + ' today · no known ceiling';
                        u.title = b.note;
                    }
                    if (u.textContent) { el.appendChild(u); }
                }

                // A station's own operating detail, where it has one.
                if (detail) {
                    const dv = document.createElement('div');
                    dv.className = 'crew-readout';
                    dv.textContent = detail;
                    el.appendChild(dv);
                }
                if (control) { el.appendChild(control); }
                return el;
            };

            // The Navigator's Configure control. It opens the NAVIGATOR config
            // block — its own role pointer over the same provider rows — so it
            // can no longer overwrite the Pilot, which is the bug the station
            // used to make one click away by opening the single shared drawer.
            // A NEW button each paint, because the stations are rebuilt on every
            // repaint and a moved node would take its handler with it.
            const navControl = (function () {
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'crew-switch';
                btn.textContent = navigator ? 'Configure' : 'Configure Navigator';
                btn.addEventListener('click', () => {
                    const wrap = document.getElementById('agent-navigator-config-wrap');
                    if (!wrap) { return; }
                    wrap.open = true;
                    if (typeof wrap.scrollIntoView === 'function') {
                        wrap.scrollIntoView({ block: 'nearest' });
                    }
                });
                return btn;
            })();

            // The arm switch, moved into the station it arms. These are the
            // buttons wired at the top of this IIFE — moved, never re-created, so
            // the handlers come with them and there is one code path for arming.
            let control = null;
            if (pilot) {
                control = flying ? stopBtn : startBtn;
                if (control) {
                    control.hidden = false;
                    control.className = 'crew-switch';
                    control.textContent = flying ? 'Stop watch' : 'Arm watch';
                }
                const idle = flying ? startBtn : stopBtn;
                // Strip the surface's own button class on the way out as well as
                // hiding it. `[hidden]` is only a UA `display:none`, so the
                // command surface's `.secondary-action-btn { display: ... }` beat
                // it and the idle switch stayed on screen as a second, orphaned
                // button under the crew bar.
                if (idle) { idle.hidden = true; idle.className = 'crew-switch'; }
            } else {
                // Nothing to arm. Both switches stay hidden rather than offering
                // a control that cannot do anything.
                if (startBtn) { startBtn.hidden = true; startBtn.className = 'crew-switch'; }
                if (stopBtn) { stopBtn.hidden = true; stopBtn.className = 'crew-switch'; }
            }

            // ONE RULE FOR BOTH SEATS: no model is OFFLINE, a model that is not
            // running is STOPPED, a model standing by is STANDBY. The Navigator
            // used to say STANDBY when it had no model at all, which collided
            // with the verdict's own STANDBY ("no mission running") — the same
            // word, twice on one panel, meaning two different things.
            //
            // A Navigator whose state could not be READ is UNKNOWN, not OFFLINE:
            // OFFLINE is a claim about the board, and the board did not answer.
            stations.appendChild(station('PILOT', 'lead', pilot,
                pilot ? (flying ? 'WATCHING' : 'STOPPED') : (pilotFault ? 'NO MODEL' : 'OFFLINE'),
                !!(pilot && flying),
                budget && budget.pilot, control, cadence, pilotFault));
            // The Navigator is CONFIGURATION ONLY at this stage: nothing on the
            // board calls it yet. The station says so rather than drawing a
            // configured model as though work were happening — and the same
            // string is drawn by the command surface.
            stations.appendChild(station('NAVIGATOR', 'planner', navigator,
                navigator ? (flying ? 'STANDBY' : 'STOPPED') : (navReadable ? 'OFFLINE' : 'UNKNOWN'), false,
                budget && budget.navigator, navControl,
                navigator ? 'configured · not yet called by the board' : '', null));
            host.textContent = '';
            host.appendChild(stations);
        }

        // ── Report scope: the board, or one team ──────────────────────────
        // The controller writes ONE report, so these do not switch which
        // controller report is shown — there is only one. They switch to the
        // team's own reports, which is where that team's seats say what they
        // finished, blocked on, or are working on.
        const TEAM_TABS = [
            // The board report is a TAB, not a hidden state reached by pressing
            // the active tab again. That gesture was undiscoverable, and the
            // agent's own assessment is the main thing this panel exists to show.
            { label: 'Board', id: null },
            { label: 'Planning', id: 'team_Planning' },
            { label: 'Coding', id: 'team_Coding' },
            { label: 'Review', id: 'team_Review' },
            { label: 'Missions', id: 'team_Feature' },
        ];
        let selectedTeam = null;

        function paintTeamTabs() {
            const host = document.getElementById('agent-report-teams');
            if (!host) { return; }
            host.textContent = '';
            for (const t of TEAM_TABS) {
                const b = document.createElement('button');
                b.type = 'button';
                // ONE class. The skin is shared between the two surfaces now, so
                // carrying each surface's own button class alongside it just let
                // the bigger one win — on the phone the channels rendered as
                // full-size action buttons and wrapped to two rows.
                b.className = 'agent-channel-btn';
                b.textContent = t.label;
                // The real team id in the tooltip. "Missions" is this product's
                // word for the Feature team, and hiding that mapping entirely
                // would make an empty tab impossible to explain.
                b.title = t.id || 'The controller\'s report on the whole board';
                if (selectedTeam === t.id) { b.classList.add('is-active'); }
                b.addEventListener('click', () => {
                    selectedTeam = t.id;
                    paintTeamTabs();
                    void refreshReport();
                });
                host.appendChild(b);
            }
        }

        // Hand the crew repaint out to the config save (see `repaintCrew`).
        repaintCrew = loadModels;

        // Hand the mission repaint out to an APPLY (see `repaintMissions`). It
        // is the same `refreshReport` the panel already runs, so the new mission
        // is drawn by the ONE mission renderer — no second strip painter. A team
        // channel replaces the report with that team's feed, which does not draw
        // missions at all, so the Board channel is selected first: the operator
        // just created a mission and the surface that shows missions is where
        // they should land, rather than a panel that says nothing about it.
        repaintMissions = async () => {
            if (selectedTeam) { selectedTeam = null; paintTeamTabs(); }
            await refreshReport();
        };

        paintTeamTabs();
        void loadModels();
        void refreshState();
        void refreshReport();

        // The report must never sit stale on screen. A 30s blanket refresh was
        // both too slow to look live and too heavy to speed up — the report is
        // ~120KB and grows. So the panel polls a freshness probe every few
        // seconds and only pulls the body when it has actually changed.
        let lastReportAt = null;
        async function pollFreshness() {
            try {
                const r = await fetch('/controller/report?meta=1');
                const d = await r.json();
                if (!d || d.success === false) { return; }
                if (d.updatedAt !== lastReportAt) {
                    const first = lastReportAt === null;
                    lastReportAt = d.updatedAt;
                    if (!first) { await refreshReport(); }
                }
            } catch { /* the next tick tries again */ }
        }
        void pollFreshness();
        setInterval(() => { void pollFreshness(); }, 4000);
        // The age in the header has to keep counting up even when no new report
        // has landed, otherwise "2 min ago" stays on screen indefinitely and the
        // staleness marker never trips. loadModels rides along: the stations
        // carry the armed state and today's spend, both of which go stale on
        // their own, and nothing else repaints them.
        setInterval(() => { void loadModels(); void refreshState(); void refreshReport(); }, 30000);
    })();

})();
