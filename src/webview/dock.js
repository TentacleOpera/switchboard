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
    const DOCK_TABS = ['agent', 'cli', 'fleet'];
    const DOCK_DEFAULT_WIDTH = 648;

    function readDockState() {
        try {
            const raw = localStorage.getItem(DOCK_STATE_KEY);
            const s = raw ? JSON.parse(raw) : {};
            return {
                open: s.open === true,
                width: Number(s.width) || DOCK_DEFAULT_WIDTH,
                seat: typeof s.seat === 'string' ? s.seat : null,
                activeTab: (s.activeTab === 'fleet' || s.activeTab === 'cli') ? s.activeTab : 'agent',
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
    const DOCK_TAB_BTNS = { agent: dockTabAgentBtn, cli: dockTabCliBtn, fleet: dockTabFleetBtn };
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
    // The controller holds its own conversation history between turns (an
    // API seat has no terminal to carry it). Sent with each request so the
    // model has context. Capped at 20 turns by the server.
    let agentHistory = [];
    let agentModelConfigured = false;
    let agentSending = false;

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
    const agentInputEl = document.getElementById('agent-control-input');
    const agentSendBtn = document.getElementById('agent-control-send');
    const agentStatusEl = document.getElementById('agent-control-status');
    const agentQuickActionsEl = document.getElementById('agent-control-quickactions');

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

        if (activeTab === 'fleet') {
            if (dockFleetEl) {
                dockFleetEl.classList.add('is-visible');
                dockFleetEl.hidden = false;
            }
            updateDockTitle();
            startFleetPoll();
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
    // The Agent tab is an API-backed control surface, not a pty seat. It
    // shows the pane, loads the model config + quick actions, and listens
    // for input. No terminal emulator is mounted. See plan:
    // the-dock-agent-tab-is-a-control-surface-not-a-terminal.

    /** Show the agent control surface and load its config. */
    async function syncAgentControl() {
        agentPane.classList.add('is-visible');
        emptyEl.hidden = true;
        emptyEl.classList.remove('is-visible');
        if (dockCliWrap) { dockCliWrap.classList.remove('is-visible', 'collapsed'); }
        if (dockRestartBtn) { dockRestartBtn.style.display = 'none'; }
        updateDockTitle();
        await loadAgentControlConfig();
        if (agentInputEl) { agentInputEl.focus(); }
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
            if (agentModelConfigured) {
                setAgentStatus('Model configured. Mechanical actions always available.', 'model');
            } else {
                setAgentStatus('No model configured. Mechanical actions available; fuzzy resolution disabled.', '');
            }
            // Render quick action buttons
            if (agentQuickActionsEl) {
                agentQuickActionsEl.innerHTML = '';
                const actions = Array.isArray(cfg.quickActions) ? cfg.quickActions : [];
                for (const action of actions) {
                    const btn = document.createElement('button');
                    btn.type = 'button';
                    btn.className = 'agent-control-quickbtn';
                    btn.textContent = action.label;
                    btn.addEventListener('click', () => {
                        if (agentInputEl) {
                            agentInputEl.value = action.label;
                            void sendAgentControl();
                        }
                    });
                    agentQuickActionsEl.appendChild(btn);
                }
            }
        } catch (err) {
            setAgentStatus('Failed to load control config: ' + (err?.message || err), 'error');
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

    /** Send the current input to POST /agent/control and render the reply. */
    async function sendAgentControl() {
        if (agentSending) { return; }
        const text = agentInputEl ? agentInputEl.value.trim() : '';
        if (!text) { return; }
        agentSending = true;
        if (agentSendBtn) { agentSendBtn.disabled = true; }
        agentInputEl.value = '';
        // Render the user's input immediately
        renderControlEntry('user', text, null, null);
        try {
            const res = await fetch('/agent/control', {
                method: 'POST', credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text, history: agentHistory }),
            });
            if (!res.ok) {
                const errBody = await res.json().catch(() => ({}));
                renderControlEntry('assistant', 'Error: ' + (errBody.error || res.status), null, null);
                setAgentStatus('Request failed: ' + (errBody.error || res.status), 'error');
                return;
            }
            const data = await res.json();
            const reply = data.reply || '(no reply)';
            const resolved = Array.isArray(data.resolved) ? data.resolved : [];
            const actions = Array.isArray(data.actions) ? data.actions : [];
            renderControlEntry('assistant', reply, resolved, actions);
            // Update history (the server returns the full updated history)
            if (Array.isArray(data.history)) { agentHistory = data.history; }
            // Update status
            if (data.usedModel) {
                setAgentStatus('Resolved via model. ' + resolved.length + ' card(s) matched.', 'model');
            } else if (resolved.length > 0) {
                setAgentStatus('Resolved ' + resolved.length + ' card(s) via keyword match.', '');
            } else {
                setAgentStatus('No cards resolved. Try a plan id, column name, or "starred".', '');
            }
        } catch (err) {
            renderControlEntry('assistant', 'Network error: ' + (err?.message || err), null, null);
            setAgentStatus('Network error: ' + (err?.message || err), 'error');
        } finally {
            agentSending = false;
            if (agentSendBtn) { agentSendBtn.disabled = false; }
            if (agentInputEl) { agentInputEl.focus(); }
        }
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

    if (dockCloseBtn) {
        dockCloseBtn.addEventListener('click', () => {
            // Tell the shell to close the dock. The shell owns open/closed.
            try { window.parent.postMessage({ type: 'dockCloseRequested' }, location.origin); } catch { /* ignore */ }
        });
    }

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

    // Agent control surface input + send.
    if (agentSendBtn) {
        agentSendBtn.addEventListener('click', () => void sendAgentControl());
    }
    if (agentInputEl) {
        agentInputEl.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                void sendAgentControl();
            }
        });
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
})();
