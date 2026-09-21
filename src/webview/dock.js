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


        async function refreshReport() {
            if (!reportEl) { return; }
            try {
                const res = await fetch('/controller/report');
                const d = await res.json();
                const md = d && d.report && typeof d.report.content === 'string' ? d.report.content : '';
                const wakes = md.split('## Wake ').slice(1);
                const lines = [];
                for (const w of wakes) {
                    const stamp = (w.match(/^(\S+)/) || [])[1] || '';
                    let time = stamp;
                    try { time = new Date(stamp).toLocaleTimeString(); } catch { /* keep raw */ }

                    // An action renders as a `### <subject> — <cause>` block whose
                    // verdict is the `- outcome:` line. Read those, not the block
                    // headings: stopping at the first `###` after `### Actions`
                    // read an EMPTY body and hid every action.
                    const at = w.indexOf('### Actions');
                    if (at >= 0) {
                        for (const raw of w.slice(at).split('\n')) {
                            const l = raw.trim();
                            const m = l.match(/^-\s*outcome:\s*\*\*([a-z-]+)\*\*\s*(?:—|--)?\s*(.*)$/i);
                            if (m) {
                                const verdict = (m[2] || '').trim();
                                lines.push({ time: time, text: verdict || m[1] });
                            }
                        }
                    }
                    // Errors are plain bullets under their own heading.
                    const ei = w.indexOf('### Errors');
                    if (ei >= 0) {
                        let body = w.slice(ei + '### Errors'.length);
                        const nx = body.search(/\n#{2,3} /);
                        if (nx >= 0) { body = body.slice(0, nx); }
                        for (const raw of body.split('\n')) {
                            const l = raw.trim();
                            if (l.startsWith('- ')) { lines.push({ time: time, text: l.slice(2).trim() }); }
                        }
                    }
                }
                // Newest last, and only the recent tail — the report is an append
                // only history and old entries are not what the operator is watching.
                const tail = lines.slice(-25);
                reportEl.textContent = '';
                if (tail.length === 0) {
                    const empty = document.createElement('div');
                    empty.className = 'agent-poll-empty';
                    empty.style.cssText = 'font-size:11px; color:var(--text-dim); padding:8px 2px;';
                    empty.textContent = 'No report yet — the agent speaks every 5 minutes.';
                    reportEl.appendChild(empty);
                } else {
                    for (const entry of tail) {
                        const problem = !/^nothing wrong/i.test(entry.text);
                        const msg = document.createElement('div');
                        msg.className = 'agent-poll-msg' + (problem ? ' is-problem' : '');
                        msg.style.cssText = 'display:flex; flex-direction:column; align-items:flex-start; max-width:92%;';

                        const meta = document.createElement('div');
                        meta.className = 'agent-poll-meta';
                        meta.style.cssText = 'font-size:9px; letter-spacing:0.04em; text-transform:uppercase; '
                            + 'color:var(--text-dim); margin:0 0 3px 10px;';
                        meta.textContent = 'agent · ' + entry.time;

                        const bubble = document.createElement('div');
                        bubble.className = 'agent-poll-bubble';
                        bubble.style.cssText = 'background:var(--panel-bg2); border:1px solid '
                            + (problem ? 'var(--accent-primary)' : 'var(--border-color)')
                            + '; border-radius:12px 12px 12px 3px; padding:7px 11px; font-size:12px; '
                            + 'line-height:1.45; word-break:break-word;'
                            + (problem ? ' color:var(--accent-primary);' : '');
                        bubble.textContent = entry.text;

                        msg.appendChild(meta);
                        msg.appendChild(bubble);
                        reportEl.appendChild(msg);
                    }
                }
                reportEl.scrollTop = reportEl.scrollHeight;
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

        // ── Project scope + dispatch highest priority ─────────────────────
        const projectSel = document.getElementById('agent-poll-project');
        const dispatchBtn = document.getElementById('agent-poll-dispatch');

        // `ready` order IS priority order — the board already sorts it. The
        // highest priority card for a scope is the first one in that scope, so
        // nothing here re-implements a ranking the board owns.
        async function readyCards() {
            const res = await fetch('/kanban/plans');
            const d = await res.json();
            const rows = (d && (d.data || d.plans || d.result)) || [];
            return Array.isArray(rows) ? rows : [];
        }

        async function loadProjects() {
            if (!projectSel) { return; }
            try {
                const rows = await readyCards();
                const names = [];
                for (const r of rows) {
                    const n = String((r && (r.project || r.projectName)) || '').trim();
                    if (n && names.indexOf(n) < 0) { names.push(n); }
                }
                names.sort();
                const keep = projectSel.value;
                projectSel.textContent = '';
                const all = document.createElement('option');
                all.value = '__all__';
                all.textContent = 'All projects';
                projectSel.appendChild(all);
                for (const n of names) {
                    const o = document.createElement('option');
                    o.value = n; o.textContent = n;
                    projectSel.appendChild(o);
                }
                if (keep) { projectSel.value = keep; }
            } catch { /* leave whatever is there */ }
        }

        if (dispatchBtn) {
            dispatchBtn.addEventListener('click', async () => {
                const scope = projectSel ? projectSel.value : '__all__';
                setState('finding highest priority…');
                try {
                    const rows = await readyCards();
                    const inScope = rows.filter(function (r) {
                        if (!r) { return false; }
                        const col = String(r.kanbanColumn || r.column || '');
                        if (col !== 'PLAN REVIEWED') { return false; }
                        if (scope === '__all__') { return true; }
                        return String(r.project || r.projectName || '') === scope;
                    });
                    if (inScope.length === 0) {
                        setState('nothing ready' + (scope === '__all__' ? '' : ' in ' + scope));
                        return;
                    }
                    const top = inScope[0];
                    const planId = String(top.planId || top.plan_id || top.sessionId || '');
                    const res = await fetch('/kanban/dispatch', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ planId: planId })
                    });
                    const d = await res.json().catch(() => null);
                    if (res.ok && d && d.success !== false) {
                        setState('dispatched ' + planId.slice(0, 8) + ' — ' + String(top.topic || '').slice(0, 40));
                    } else {
                        setState('dispatch failed: ' + ((d && (d.reason || d.error)) || res.status));
                    }
                } catch (err) {
                    setState('dispatch failed: ' + String(err));
                }
                void refreshReport();
            });
        }
        void loadProjects();
        void refreshState();
        void refreshReport();
        setInterval(() => { void refreshState(); void refreshReport(); }, 30000);
    })();

})();
