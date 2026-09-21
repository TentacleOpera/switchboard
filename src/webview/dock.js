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
            if (agentModelConfigured) {
                setAgentStatus('Model configured (' + (cfg.modelName || '') + '). Mechanical actions always available.', 'model');
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
            setAgentConfigStatus('Saved.', false);
            await loadAgentControlConfig();
        } catch (err) {
            setAgentConfigStatus('Save failed: ' + (err?.message || err), true);
        }
    }

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
                card.style.cssText = 'border:1px solid var(--accent-primary); border-radius:4px; '
                    + 'padding:11px 13px; background:var(--panel-bg2);';
                if (rows.length === 0) {
                    // An empty tab is a claim about the team, and it needs a source.
                    const e = document.createElement('div');
                    e.style.cssText = 'font-size:12px; color:var(--text-dim);';
                    e.textContent = 'No reports from ' + teamId + ' yet.';
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
                        row.style.cssText = 'padding:6px 0; border-top:1px solid var(--border-color);';
                        const h = document.createElement('div');
                        h.style.cssText = 'font-size:9px; letter-spacing:0.06em; text-transform:uppercase; '
                            + 'color:var(--accent-primary); margin-bottom:3px;';
                        let when = meta.created || '';
                        try { when = new Date(meta.created).toLocaleString(); } catch { /* keep raw */ }
                        h.textContent = (meta.from || 'unknown seat') + ' \u00b7 ' + (meta.kind || 'report')
                            + (when ? ' \u00b7 ' + when : '');
                        const t = document.createElement('div');
                        t.style.cssText = 'font-size:12px; line-height:1.45; color:var(--text-color); '
                            + 'word-break:break-word;';
                        t.textContent = text || '(empty report)';
                        row.appendChild(h);
                        row.appendChild(t);
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
                const STENCIL = 'font-size:9px; letter-spacing:0.14em; text-transform:uppercase; '
                    + 'color:var(--text-secondary);';
                const card = mk('div', 'border:1px solid var(--border-color); border-radius:3px; '
                    + 'background:linear-gradient(180deg, var(--panel-bg2), var(--panel-bg)); '
                    + 'overflow:hidden;');

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
                    const t = mSummary ? mSummary.cardsTotal : 0;
                    const dn = mSummary ? mSummary.cardsDone : 0;
                    caption = missions.length + (missions.length === 1 ? ' mission' : ' missions')
                        + (t ? ' \u00b7 ' + dn + ' of ' + t + ' cards done' : '');
                } else if (loose && (loose.inFlightFeatures || loose.parkedFeatures)) {
                    // No mission. Work being HELD and work merely left part-done are
                    // different claims and are said separately — reporting parked
                    // work as in flight said 39 features were running on a board
                    // where nothing was.
                    word = 'STANDBY';
                    const parts = ['No mission set up.'];
                    if (loose.inFlightFeatures) {
                        parts.push(loose.inFlightFeatures
                            + (loose.inFlightFeatures === 1 ? ' feature' : ' features')
                            + ' in flight (' + loose.inFlightCards + ' cards held).');
                    } else {
                        parts.push('Nothing in flight.');
                    }
                    if (loose.parkedFeatures) {
                        parts.push(loose.parkedFeatures
                            + (loose.parkedFeatures === 1 ? ' feature' : ' features')
                            + ' part-done and parked, ' + loose.parkedCardsDone
                            + ' of ' + loose.parkedCards + ' cards finished.');
                    }
                    caption = parts.join(' ');
                } else {
                    caption = 'No mission running. Nothing needs you.';
                }

                const ann = mk('div', 'padding:16px 15px 14px; border-bottom:1px solid var(--border-color);');
                const wordRow = mk('div', 'display:flex; align-items:center; gap:9px;');
                const bulb = mk('span', 'width:9px; height:9px; border-radius:50%; flex-shrink:0; '
                    + 'background:' + lamp + '; box-shadow:0 0 9px ' + lamp + ';');
                const wordEl = mk('span', 'font-size:21px; line-height:1; letter-spacing:0.05em; '
                    + 'font-weight:600; color:' + lamp + ';', word);
                wordRow.appendChild(bulb);
                wordRow.appendChild(wordEl);
                ann.appendChild(wordRow);
                ann.appendChild(mk('div', 'font-size:12.5px; line-height:1.45; margin-top:7px; '
                    + 'color:var(--text-primary);', caption));
                const checkedBits = ['Seats and board checked ' + (age || 'just now')];
                if (f.seatsAliveCount !== undefined) {
                    checkedBits.push(f.seatsAliveCount + (f.seatsAliveCount === 1 ? ' seat up' : ' seats up'));
                }
                ann.appendChild(mk('div', STENCIL + ' margin-top:8px;', checkedBits.join('  ·  ')));
                card.appendChild(ann);

                // ── MISSION STRIPS ───────────────────────────────────────────
                if (missions.length) {
                    const strips = mk('div', 'padding:4px 0;');
                    for (const m of missions) {
                        const s = mk('div', 'padding:9px 15px; border-bottom:1px solid '
                            + 'color-mix(in srgb, var(--border-color) 55%, transparent);');
                        s.appendChild(mk('div', 'font-size:12.5px; line-height:1.35; color:var(--text-primary);',
                            String(m.name || m.id || '')));

                        // A progress bar only where there is progress to show. A
                        // bar drawn from a zero denominator is a picture of a
                        // fact nobody has.
                        if (m.cardsTotal > 0) {
                            const pct = Math.round((m.cardsDone / m.cardsTotal) * 100);
                            const track = mk('div', 'height:3px; border-radius:2px; margin-top:7px; '
                                + 'background:color-mix(in srgb, var(--border-color) 80%, transparent); '
                                + 'overflow:hidden;');
                            track.appendChild(mk('div', 'height:100%; width:' + pct + '%; '
                                + 'background:var(--accent-primary);'));
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
                        s.appendChild(mk('div', STENCIL + ' margin-top:6px;', meta.join('  ·  ')));
                        strips.appendChild(s);
                    }
                    card.appendChild(strips);
                }

                // ── NEXT UP ──────────────────────────────────────────────────
                const offer = f.nextHighestPriority || null;
                const foot = mk('div', 'padding:11px 15px 13px;');
                if (offer && offer.id) {
                    foot.appendChild(mk('div', STENCIL, 'Next up'));
                    foot.appendChild(mk('div', 'font-size:12.5px; line-height:1.4; margin-top:4px; '
                        + 'color:var(--text-primary);', String(offer.topic || offer.id)));
                    const act = document.createElement('button');
                    act.type = 'button';
                    act.className = 'agent-poll-btn secondary-action-btn';
                    act.style.cssText = 'margin-top:9px;';
                    act.textContent = 'Start ' + (offer.kind === 'feature' ? 'mission' : 'plan');
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
                    foot.appendChild(mk('div', STENCIL, 'Next up'));
                    foot.appendChild(mk('div', 'font-size:12px; margin-top:4px; color:var(--text-secondary);',
                        'Nothing ready to start.'));
                }
                card.appendChild(foot);

                if (latest.errors.length) {
                    const errs = mk('div', 'padding:9px 15px; border-top:1px solid var(--border-color);');
                    errs.appendChild(mk('div', STENCIL, 'Faults'));
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

        async function refreshState() {
            try {
                const res = await fetch('/controller/poll/state');
                const d = await res.json();
                if (!d || d.running !== true) { setState('stopped'); return; }
                const mins = Math.round((d.intervalMs || 0) / 60000);
                const last = d.lastRunAt ? ' — last run ' + new Date(d.lastRunAt).toLocaleTimeString() : '';
                setState('polling every ' + mins + ' min' + last + (d.lastError ? ' (last error: ' + d.lastError + ')' : ''));
            } catch { setState('state unavailable'); }
        }

        if (startBtn) {
            startBtn.addEventListener('click', async () => {
                setState('starting…');
                const r = await post('/controller/poll/start');
                if (!r.ok || !r.data || r.data.success === false) {
                    setState('start failed: ' + ((r.data && (r.data.reason || r.data.error)) || r.status));
                    return;
                }
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
                void refreshState();
            });
        }

        // ── Who is flying ─────────────────────────────────────────────────
        // Pilot is the controller's own judgement model. Navigator is the
        // supervisor it escalates to. An unconfigured Navigator says so: a
        // supervisor that is absent must never read like one that is present.
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
            let navigator = null;
            let navMissing = 'not configured';
            try {
                const r = await fetch('/controller/judgement');
                const d = await r.json();
                const j = (d && d.judgement) || {};
                const tiers = j.tiers || [];
                // Pilot is the classifier tier, Navigator the escalation tier.
                // `supervisorSeat` is a SEAT NAME, not a model, so it is not what
                // names the Navigator — reading it here would have labelled the
                // chain's cloud model with a terminal's name.
                const tier = tiers.filter(function (t) { return t && t.role === 'classifier'; })[0] || tiers[0];
                const esc = tiers.filter(function (t) { return t && t.role === 'escalation'; })[0];
                if (tier && tier.model) {
                    // Locality comes from the tier, never guessed from the URL.
                    // Omitted rather than assumed when the tier does not say.
                    pilot = {
                        name: prettyModel(tier.model),
                        where: placeOf(tier),
                        raw: tier.model,
                        note: tier.costClass === 'metered' ? 'metered' : '',
                    };
                }
                if (esc && esc.model) {
                    navigator = {
                        name: prettyModel(esc.model),
                        where: placeOf(esc),
                        raw: esc.model,
                        note: esc.costClass === 'metered' ? 'metered' : '',
                    };
                }
                // Say WHY it is absent. "not configured" alone sent the operator
                // looking for a missing API key when the real state is that no
                // escalation tier is declared at all — a key would not help.
                if (!navigator) { navMissing = 'no escalation tier declared'; }
            } catch { /* both stay null, and both say so below */ }

            // Is the Pilot actually flying? A station that names a model but not
            // whether it is running is a settings row, which is what made this
            // read as a tool rather than a panel.
            let flying = false;
            try {
                const pr = await fetch('/controller/poll/state');
                const pd = await pr.json();
                flying = !!(pd && pd.running);
            } catch { /* unknown stays dark rather than claiming WATCHING */ }

            host.textContent = '';
            // A crew station: who it is, whether the lamp is lit, and what it is
            // doing. The model id, its locality and whether it is metered are
            // setup facts — they live on the tooltip and in config, not here.
            const row = function (role, m, state, lit) {
                const el = document.createElement('div');
                el.className = 'agent-model-row';
                el.style.cssText = 'display:flex; gap:9px; align-items:center; padding:5px 0;';

                const bulb = document.createElement('span');
                const colour = lit ? 'var(--accent-primary)' : 'var(--border-bright)';
                bulb.style.cssText = 'width:6px; height:6px; border-radius:50%; flex-shrink:0; '
                    + 'background:' + colour + (lit ? '; box-shadow:0 0 7px ' + colour : '') + ';';

                const r = document.createElement('span');
                r.className = 'agent-model-role';
                r.style.cssText = 'font-size:9px; letter-spacing:0.14em; text-transform:uppercase; '
                    + 'color:var(--text-primary); min-width:70px;';
                r.textContent = role;

                const v = document.createElement('span');
                v.style.cssText = 'font-size:9px; letter-spacing:0.14em; text-transform:uppercase; '
                    + 'color:' + (lit ? 'var(--accent-primary)' : 'var(--text-secondary)') + ';';
                v.textContent = state;
                // The infrastructure is still ONE HOVER away, never gone: it is
                // how the cloud model running the 5-minute loop was caught.
                if (m) {
                    const bits = [m.name];
                    if (m.where) { bits.push(m.where); }
                    if (m.note) { bits.push(m.note); }
                    v.title = bits.join(' · ') + ' — ' + String(m.raw || '');
                } else {
                    v.title = (role === 'NAVIGATOR') ? navMissing : 'not configured';
                }

                el.appendChild(bulb);
                el.appendChild(r);
                el.appendChild(v);
                return el;
            };
            // A station with no model is OFFLINE, not blank — and an unconfigured
            // Navigator is STANDBY, a different state from a Pilot that is
            // configured and simply not running.
            host.appendChild(row('PILOT', pilot,
                pilot ? (flying ? 'WATCHING' : 'STOPPED') : 'OFFLINE', !!(pilot && flying)));
            host.appendChild(row('NAVIGATOR', navigator,
                navigator ? (flying ? 'READY' : 'STANDBY') : 'STANDBY', false));
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
                // Both class names: each surface styles the one it owns.
                b.className = 'agent-poll-btn secondary-action-btn';
                b.textContent = t.label;
                // The real team id in the tooltip. "Missions" is this product's
                // word for the Feature team, and hiding that mapping entirely
                // would make an empty tab impossible to explain.
                b.title = t.id || 'The controller\'s report on the whole board';
                if (selectedTeam === t.id) {
                    b.style.cssText = 'border-color:var(--accent-primary); color:var(--accent-primary);';
                }
                b.addEventListener('click', () => {
                    selectedTeam = t.id;
                    paintTeamTabs();
                    void refreshReport();
                });
                host.appendChild(b);
            }
        }

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
        // staleness marker never trips.
        setInterval(() => { void refreshState(); void refreshReport(); }, 30000);
    })();

})();
