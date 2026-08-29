/*
 * Switchboard browser transport shim — Feature B · B2
 *
 * Provides an API-compatible `acquireVsCodeApi()` surface for the existing
 * webview UIs so they run unchanged in a plain browser:
 *   - postMessage -> fetch to the per-verb HTTP rail
 *   - incoming pushes -> WebSocket fan-out, dispatched as MessageEvents
 *   - getState/setState -> localStorage
 *   - host capability gating -> hides terminal/CLI/automation pathways in a
 *     terminal-less headless host.
 *
 * This file is loaded by the standalone board server; it is NOT loaded inside
 * the VS Code webview (the real bridge is used there).
 */

(function () {
    'use strict';

    // Idempotent: the inline script may call acquireVsCodeApi more than once.
    if (window.__switchboardVscodeShim) {
        window.acquireVsCodeApi = function () { return window.__switchboardVscodeShim; };
        return;
    }

    const panel = (document.body && document.body.dataset.panel) || 'kanban';
    const routePrefix = panel === 'kanban' ? '/kanban/verb' : `/${panel}/verb`;
    const localStorageKey = `sb-state-${panel}`;

    function loadState() {
        try {
            const raw = localStorage.getItem(localStorageKey);
            return raw ? JSON.parse(raw) : {};
        } catch {
            return {};
        }
    }

    let state = loadState();

    function saveState() {
        try {
            localStorage.setItem(localStorageKey, JSON.stringify(state));
        } catch (err) {
            console.warn('[transport] localStorage setState failed:', err);
        }
    }

    function dispatchMessage(data) {
        if (data == null) { return; }
        try {
            window.dispatchEvent(new MessageEvent('message', { data }));
        } catch (err) {
            console.error('[transport] dispatchMessage failed:', err);
        }
    }

    // ─── WebSocket (server -> UI push) ───────────────────────────────────────
    let ws;
    let reconnectDelay = 500;
    const maxReconnectDelay = 30000;
    const HANDSHAKE_TIMEOUT_MS = 10000;
    let reconnectTimer;
    let intentionallyClosed = false;
    let handshakeDeadline = null;

    // Opt-in, not always-on: this file ships to every panel in both hosts, and an
    // unconditional log per inbound frame is unreadable in the cockpit (all panels
    // are mounted at once) and unshippable to the installed base. Either switch
    // turns it on; the localStorage one survives the reload a popout needs.
    const wsDebug = (function () {
        try {
            if (new URLSearchParams(window.location.search).get('wsdebug') === '1') { return true; }
            return localStorage.getItem('sb-debug-ws') === '1';
        } catch { return false; }
    })();
    function wsLog() {
        if (!wsDebug) { return; }
        console.log.apply(console, ['[transport:ws]'].concat(Array.prototype.slice.call(arguments)));
    }

    let isReconnecting = false;
    let pushScope = null;
    // Distinguishes "never declared" (no ?scope= on reconnect → server falls back
    // to the singleton) from "explicitly declared null" (?scope= empty → server
    // stores null, i.e. no project filter). Without this flag an all-projects
    // client silently reverts to the singleton scope on every reconnect.
    let pushScopeDeclared = false;

    window.__switchboardSetPushScope = function (p) {
        pushScope = p;
        pushScopeDeclared = true;
        if (ws && ws.readyState === 1) {
            try {
                ws.send(JSON.stringify({ type: '__scope', project: p === undefined ? null : p }));
            } catch (e) { /* silent catch */ }
        }
    };

    /**
     * Mirror of PANEL_SURFACES in services/wsHub.ts — a webview cannot import from
     * a .ts module, so the two are kept in step by hand. Keys are the panel ids
     * headlessPanelHtml.ts stamps into `data-panel`.
     *
     * `project` is deliberately absent so the Project panel stays fail-open; see
     * the comment on PANEL_SURFACES for why declaring a set for it breaks saving.
     * A panel with no entry sends no `surfaces` parameter at all and receives the
     * full stream, which is also what an older server does with the parameter.
     *
     * Debugging note: with this in effect, the WS frames visible in one panel's
     * devtools are that panel's traffic only, not the whole system's.
     */
    const PANEL_SURFACES_MAP = {
        kanban: ['kanban', 'common'],
        terminals: ['terminals', 'common'],
        planning: ['planning', 'common'],
        design: ['design', 'common'],
        setup: ['setup', 'common'],
        memo: ['memo', 'common'],
        tickets: ['tickets', 'common'],
        connections: ['connections', 'common'],
    };

    function wsUrl() {
        const loc = window.location;
        const protocol = loc.protocol === 'https:' ? 'wss:' : 'ws:';
        let url = `${protocol}//${loc.host}/ws`;
        const params = [];
        const originatorId = window.__sbClientOriginatorId;
        if (originatorId) {
            params.push(`originatorId=${encodeURIComponent(originatorId)}`);
        }
        if (pushScopeDeclared) {
            // Empty value = declared-null ("no project filter"); the server maps it
            // back to null. wsUrl() reads the LIVE scope so reconnects re-declare.
            params.push(`scope=${encodeURIComponent(pushScope ?? '')}`);
        }
        const panel = document.body && document.body.dataset ? document.body.dataset.panel : null;
        if (panel && PANEL_SURFACES_MAP[panel]) {
            params.push(`surfaces=${encodeURIComponent(PANEL_SURFACES_MAP[panel].join(','))}`);
        }
        if (params.length > 0) {
            url += `?${params.join('&')}`;
        }
        return url;
    }

    function wsUrlForLog() {
        try {
            const u = new URL(wsUrl(), window.location.href);
            if (u.searchParams.has('token')) { u.searchParams.set('token', '<redacted>'); }
            if (u.searchParams.has('scope')) { u.searchParams.set('scope', '<scope>'); }
            return u.toString();
        } catch { return '<unparseable>'; }
    }

    // Generate the per-client originatorId BEFORE the first WS connect if no
    // panel script has set it yet. This script is injected ahead of the panel's
    // own JS and connects immediately, so waiting for the panel to generate the
    // ID would leave the initial (usually only) connection anonymous — and an
    // anonymous connection can never fire onDisconnect for its seat on the host.
    // Panel scripts (design.js) reuse this global instead of overwriting it.
    if (!window.__sbClientOriginatorId) {
        window.__sbClientOriginatorId =
            'client_' + Math.random().toString(36).substring(2, 11) + '_' + Date.now();
    }

    function connectWs() {
        if (ws) { return; }
        wsLog('connecting', wsUrlForLog());
        try {
            ws = new WebSocket(wsUrl());
        } catch (err) {
            console.error('[transport] WebSocket constructor failed:', err);
            scheduleReconnect();
            return;
        }

        // Chromium has NO opening-handshake timeout: a server that accepts the TCP
        // connection and then never writes `101 Switching Protocols` leaves this
        // socket in CONNECTING with no open/error/close event until the OS TCP
        // timeout (minutes to hours). `connectWs`'s `if (ws) return` guard then reads
        // that corpse as a live connection and blocks every reconnect trigger below.
        // Firefox self-heals here at ~20s (network.websocket.timeout.open); Chromium
        // needs this. close() on a CONNECTING socket fires onclose, which arms the
        // normal backoff — so this is the whole recovery path, not just a tidy-up.
        if (handshakeDeadline) { clearTimeout(handshakeDeadline); handshakeDeadline = null; }
        handshakeDeadline = setTimeout(function () {
            if (ws && ws.readyState === 0 /* CONNECTING */) {
                console.warn('[transport] WebSocket handshake did not complete in '
                    + HANDSHAKE_TIMEOUT_MS + 'ms — abandoning and retrying');
                try { ws.close(); } catch { /* fall through to onclose */ }
            }
        }, HANDSHAKE_TIMEOUT_MS);

        ws.onopen = function () {
            if (handshakeDeadline) { clearTimeout(handshakeDeadline); handshakeDeadline = null; }
            wsLog('open', wsUrlForLog());
            if (isReconnecting) {
                try {
                    window.dispatchEvent(new CustomEvent('sbTransportReconnected'));
                } catch (e) {
                    console.error('[transport] dispatch sbTransportReconnected failed:', e);
                }
            }
            isReconnecting = true;
            reconnectDelay = 500;
        };

        ws.onmessage = function (event) {
            let msg;
            try {
                msg = JSON.parse(event.data);
            } catch {
                console.warn('[transport] Non-JSON WS message:', event.data);
                return;
            }

            if (msg.type === '__resync') {
                wsLog('RESYNC received — this connection is in the hub broadcast set',
                    Array.isArray(msg.payload) ? msg.payload.length + ' messages' : typeof msg.payload);
                const payload = msg.payload;
                if (Array.isArray(payload)) {
                    payload.forEach(dispatchMessage);
                } else {
                    dispatchMessage(payload);
                }
                // The hub adds this connection to its broadcast set IMMEDIATELY after
                // sending this frame — `_safeSend(__resync)` then `_connections.add(meta)`
                // with no await between (wsHub.ts:257-267). So this is the first moment a
                // host push is guaranteed to reach us. Panels whose mount-time state
                // arrives ONLY as a push (Setup) must (re)request it here: a `ready`
                // posted during the handshake is broadcast to zero subscribers and lost.
                // If that ordering ever changes, this signal weakens back to a race.
                try {
                    window.dispatchEvent(new CustomEvent('sbTransportSubscribed'));
                } catch (e) {
                    console.error('[transport] dispatch sbTransportSubscribed failed:', e);
                }
                return;
            }

            wsLog('frame', msg.type, 'seq=' + msg.seq, 'surface=' + (msg.surface || '<untagged>'));

            // Unwrap the wsHub envelope (type/seq/payload/surface) into the legacy
            // postMessage shape the UI handlers expect.
            const payload = msg.payload;
            if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
                dispatchMessage(Object.assign({}, payload, { type: msg.type }));
            } else {
                dispatchMessage({ type: msg.type, payload });
            }
        };

        ws.onerror = function (err) {
            console.error('[transport] WebSocket error:', err, 'url=', wsUrlForLog());
        };

        ws.onclose = function (ev) {
            if (handshakeDeadline) { clearTimeout(handshakeDeadline); handshakeDeadline = null; }
            console.warn('[transport] WebSocket closed:',
                'code=' + (ev && ev.code), 'reason=' + ((ev && ev.reason) || ''),
                'wasClean=' + (ev && ev.wasClean));
            ws = null;
            if (!intentionallyClosed) {
                scheduleReconnect();
            }
        };
    }

    function scheduleReconnect() {
        if (reconnectTimer) { return; }
        wsLog('reconnect scheduled in', reconnectDelay, 'ms');
        reconnectTimer = setTimeout(function () {
            reconnectTimer = null;
            reconnectDelay = Math.min(reconnectDelay * 2, maxReconnectDelay);
            connectWs();
        }, reconnectDelay);
    }

    // A socket that closed while the window was hidden waits out a backoff that may
    // already have grown to 30 s, so the operator's first half-minute back is stale.
    // `reconnectTimer` covers an already-armed retry. `ws` is checked by READYSTATE,
    // not truthiness — a socket stuck in CONNECTING (see the handshake deadline
    // above) must be treated as dead and replaced. OPEN (1) and CLOSING (2) are left
    // alone: OPEN needs nothing, and CLOSING will fire onclose and arm the backoff.
    function reconnectIfDown(why) {
        if (reconnectTimer) { return; }
        if (ws && (ws.readyState === 1 || ws.readyState === 2)) { return; }
        if (ws && ws.readyState === 0) {
            wsLog('abandoning a stuck CONNECTING socket —', why);
            try { ws.close(); } catch { /* ignore */ }
            return;
        }
        wsLog('reconnect now —', why);
        reconnectDelay = 500;
        connectWs();
    }
    document.addEventListener('visibilitychange', function () {
        if (document.visibilityState === 'visible') { reconnectIfDown('became visible'); }
    });
    window.addEventListener('pageshow', function (ev) {
        reconnectIfDown(ev && ev.persisted ? 'pageshow (from bfcache)' : 'pageshow');
    });
    window.addEventListener('focus', function () { reconnectIfDown('window focus'); });

    connectWs();

    // ─── acquireVsCodeApi shim ────────────────────────────────────────────────
    // VS Code command verbs that open another panel — in the headless shell
    // these become cross-panel switches instead of HTTP posts. The shell's
    // postMessage listener handles {type:'switchPanel', panel}.
    const PANEL_SWITCH_VERBS = {
        openKanban: 'board',
        openPlanningPanel: 'project',
        openProjectPanel: 'project',
        openSetupPanel: 'setup',
        openDesignPanel: 'design',
        openTicketsPanel: 'tickets',
        openConnectionsPanel: 'connections',
    };

    const STATUS_MESSAGE_PANELS = { kanban: true };

    function showTransportError(text) {
        let host = document.getElementById('sb-transport-error');
        if (!host) {
            host = document.createElement('div');
            host.id = 'sb-transport-error';
            host.style.cssText =
                'position:fixed;bottom:16px;left:50%;transform:translateX(-50%);' +
                'z-index:2147483647;max-width:80vw;padding:10px 16px;border-radius:4px;' +
                'background:#2b1416;color:#ff6b6b;border:1px solid #ff6b6b;' +
                'font-size:12px;line-height:1.4;' +
                'font-family:var(--font-family, var(--font, system-ui, sans-serif));' +
                'white-space:pre-wrap;pointer-events:none;';
            (document.body || document.documentElement).appendChild(host);
        }
        host.textContent = text;
        host.style.display = 'block';
        if (host._hideTimer) { clearTimeout(host._hideTimer); }
        host._hideTimer = setTimeout(function () { host.style.display = 'none'; }, 8000);
    }

    const vscodeShim = {
        postMessage: function (message) {
            if (!message || typeof message.type !== 'string') {
                console.warn('[transport] postMessage without type ignored:', message);
                return;
            }
            const verb = message.type;

            // Cross-panel switch: in the shell, opening another panel is a
            // client-side switch (no HTTP round-trip). Outside the shell
            // (standalone full-page route), fall through to the HTTP post —
            // the server returns a no-op ack.
            if (PANEL_SWITCH_VERBS[verb] && window.parent && window.parent !== window) {
                window.parent.postMessage({ type: 'switchPanel', panel: PANEL_SWITCH_VERBS[verb] }, '*');
                return;
            }

            const body = Object.assign({}, message);
            const url = `${routePrefix}/${encodeURIComponent(verb)}`;

            fetch(url, {
                method: 'POST',
                credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            })
                .then(function (res) { return res.json(); })
                .then(function (result) {
                    if (result && result.prompt && window.sbCopyToClipboard) {
                        window.sbCopyToClipboard(result.prompt).catch(function (err) {
                            console.warn('[transport] Clipboard write failed:', err);
                        });
                    }
                    if (result && typeof result === 'object' && result.success === false) {
                        // A typed, EXPECTED miss (e.g. readLocalTicketFile for a subtask
                        // whose file has not been downloaded yet) is not a transport
                        // failure — the panel's own handler owns the recovery UI (it
                        // falls back to the live view). Suppress the generic toast for
                        // quiet-listed reasons, but still fall through to dispatchMessage
                        // below so the typed body reaches its handler.
                        const EXPECTED_QUIET = new Set(['not-imported']);
                        if (!EXPECTED_QUIET.has(result.reason)) {
                            const text = result.error || ('Action failed: ' + verb);
                            console.warn('[transport] verb failed:', verb, text);
                            if (STATUS_MESSAGE_PANELS[panel]) {
                                dispatchMessage({ type: 'showStatusMessage', message: text, isError: true });
                            } else {
                                showTransportError(text);
                            }
                        }
                        // A TYPED failure body is an ADDRESSED reply, not just a status
                        // line: the panel's own handler owns the recovery UI (e.g.
                        // `previewError` hides the preview loading state and restores the
                        // initial state — design.js). Returning here would leave that
                        // spinner running forever behind a transient toast, so a typed
                        // body still falls through to dispatchMessage below (which is also
                        // the pre-existing behaviour for every failure body). Only an
                        // UNTYPED failure — which no handler could route — stops here.
                        if (typeof result.type !== 'string') {
                            return;
                        }
                    }
                    // Re-dispatch the in-body response as a MessageEvent so request/response
                    // verbs (fetchKanbanPlans -> kanbanPlansReady, updateWorkspaceSelection, etc.)
                    // reach the UI's message handlers. In the editor the provider pushes these
                    // back via the webview; in the browser the HTTP response body IS that push.
                    if (result && typeof result === 'object') {
                        dispatchMessage(result);
                    }
                })
                .catch(function (err) {
                    console.error('[transport] postMessage fetch failed:', err);
                });
        },

        getState: function () {
            return state;
        },

        setState: function (newState) {
            state = newState;
            saveState();
        },
    };

    window.__switchboardVscodeShim = vscodeShim;
    window.acquireVsCodeApi = function () { return vscodeShim; };

    // ─── Cross-panel switch bridge (headless app-shell) ──────────────────────
    // Panels run inside same-origin iframes hosted by the shell. A panel can
    // request the shell switch to another panel by calling this helper, which
    // posts {type:'switchPanel', panel} to the parent window. No-op when not
    // iframed (extension webview or standalone full-page route) — the parent
    // listener only exists in the shell.
    window.__switchboardSwitchPanel = function (panelId) {
        try {
            if (window.parent && window.parent !== window) {
                window.parent.postMessage({ type: 'switchPanel', panel: String(panelId) }, '*');
            }
        } catch (err) {
            console.warn('[transport] switchPanel postMessage failed:', err);
        }
    };

    // ─── Host-adaptive UI ────────────────────────────────────────────────────
    function applyCapabilityGating() {
        try {
            const raw = document.body.dataset.hostCapabilities;
            if (!raw) { return; }
            const caps = JSON.parse(raw.replace(/&quot;/g, '"'));

            if (caps.terminalDispatch === false) {
                document.body.classList.add('host-terminal-dispatch-false');
                const style = document.createElement('style');
                style.textContent = `
.host-terminal-dispatch-false #clear-terminal-before-prompt-label,
.host-terminal-dispatch-false button[data-action="moveSelected"],
.host-terminal-dispatch-false button[data-action="moveAll"],
.host-terminal-dispatch-false #memo-send-btn {
    display: none !important;
}
`;
                document.head.appendChild(style);
            }

            // automation: the toolbar cluster only. The three kanban selectors that
            // used to be here — [data-tab="automation"], #automation-tab-content,
            // #automation-panel-root — named markup that no longer exists: the tab
            // moved to the Mission Control PANEL. A panel is gated by the manifest
            // (`getPanelsManifest` → PanelAvailability.missionControl), not by a CSS
            // rule in a sibling document, so re-pointing these at panel internals
            // would be a hand-listed selector set over a surface this file cannot see.
            if (caps.automation === false) {
                document.body.classList.add('host-automation-false');
                const style = document.createElement('style');
                style.textContent = `
.host-automation-false #btn-cli-triggers,
.host-automation-false #btn-remote-control,
.host-automation-false button[data-action="julesSelected"],
.host-automation-false #btn-build-via-planner,
.host-automation-false #btn-update-via-planner,
.host-automation-false #btn-build-system,
.host-automation-false #btn-build-prd-via-planner {
    display: none !important;
}
`;
                document.head.appendChild(style);
            }

            // mission-control / mcpTerminals: the body class is the contract; the selector
            // lists below are FORWARD-COMPATIBILITY ONLY and currently match nothing
            // (verified: 0 occurrences of #btn-mission-control, .mission-control-only,
            // .mcp-monitor-only, #btn-launch-mcp-monitor).
            //
            // NOTE: `mission-control` here is a HOST capability flag that predates the
            // Mission Control panel, and standalone hardcodes it false. Do NOT reuse it
            // to gate anything in mission-control.html — the panel's controller strip
            // did exactly that and became permanently invisible in the browser cockpit.
            // The panel is gated by `automation` (above) and its terminal strip by
            // `terminalFleet`. Do NOT "fix" these by adding matching selectors to real
            // controls: the EXTENSION host also declares mcpTerminals:false (see
            // TaskViewerProvider baseHostCapabilities) while its MCP monitor works, so a
            // matching selector would hide a working editor surface. Gate those on a new,
            // honestly-derived flag instead.
            if (caps['mission-control'] === false) {
                document.body.classList.add('host-mission-control-false');
                const style = document.createElement('style');
                style.textContent = `
.host-mission-control-false #btn-mission-control,
.host-mission-control-false .mission-control-only {
    display: none !important;
}
`;
                document.head.appendChild(style);
            }

            if (caps.mcpTerminals === false) {
                document.body.classList.add('host-mcp-terminals-false');
                const style = document.createElement('style');
                style.textContent = `
.host-mcp-terminals-false .mcp-monitor-only,
.host-mcp-terminals-false #btn-launch-mcp-monitor {
    display: none !important;
}
`;
                document.head.appendChild(style);
            }

            if (caps.worktrees === false) {
                document.body.classList.add('host-worktrees-false');
                const style = document.createElement('style');
                style.textContent = `
.host-worktrees-false [data-tab="worktrees"],
.host-worktrees-false #worktrees-tab-content {
    display: none !important;
}
`;
                document.head.appendChild(style);
            }

            if (caps.uat === false) {
                document.body.classList.add('host-uat-false');
                const style = document.createElement('style');
                style.textContent = `
.host-uat-false [data-tab="uat"],
.host-uat-false #uat-tab-content {
    display: none !important;
}
`;
                document.head.appendChild(style);
            }

            if (caps.boardStructure === false) {
                document.body.classList.add('host-board-structure-false');
                const style = document.createElement('style');
                // The Kanban Structure block lives in the SETUP tab (kanban.html:2888-2896).
                // These are its real ids — an earlier revision gated `#btn-add-column` and
                // `.col-header-actions`, neither of which exists in kanban.html, so the
                // whole branch was decorative and the controls stayed clickable.
                // They genuinely cannot work headlessly: standalone's pushFullState
                // publishes `updateColumns` from the CONSTANT DEFAULT_KANBAN_COLUMNS
                // (bootstrap.ts:334, :363), so a saved custom column is written to the DB
                // and never rendered.
                style.textContent = `
.host-board-structure-false #btn-add-kanban-column,
.host-board-structure-false #btn-restore-kanban-defaults,
.host-board-structure-false #kanban-structure-list {
    display: none !important;
}
`;
                document.head.appendChild(style);
            }

            if (caps.featureAdvanced === false) {
                document.body.classList.add('host-feature-advanced-false');
                const style = document.createElement('style');
                style.textContent = `
.host-feature-advanced-false #btn-suggest-features {
    display: none !important;
}
`;
                document.head.appendChild(style);
            }

            if (caps.secretsEntry === false) {
                document.body.classList.add('host-secrets-entry-false');
                const style = document.createElement('style');
                style.textContent = `
.host-secrets-entry-false #btn-apply-clickup-config,
.host-secrets-entry-false #btn-apply-linear-config,
.host-secrets-entry-false #btn-apply-notion-config,
.host-secrets-entry-false #btn-save-stitch-auth,
.host-secrets-entry-false #btn-clear-stitch-auth {
    display: none !important;
}
.host-secrets-entry-false #clickup-token-input,
.host-secrets-entry-false #linear-token-input,
.host-secrets-entry-false #notion-token-input,
.host-secrets-entry-false #multi-repo-pat,
.host-secrets-entry-false #stitch-api-key-input {
    opacity: 0.6;
    cursor: not-allowed;
}
`;
                document.head.appendChild(style);

                const disableInputsAndHint = () => {
                    const selectors = [
                        '#clickup-token-input',
                        '#linear-token-input',
                        '#notion-token-input',
                        '#multi-repo-pat',
                        '#stitch-api-key-input'
                    ];
                    selectors.forEach(sel => {
                        const el = document.querySelector(sel);
                        if (el) {
                            el.disabled = true;
                            el.placeholder = 'Set in VS Code, or via the switchboard CLI...';
                            if (el.parentNode && !el.parentNode.querySelector('.host-secrets-hint')) {
                                const hint = document.createElement('div');
                                hint.className = 'host-secrets-hint';
                                hint.style.cssText = 'font-size: 11px; color: var(--text-secondary, #888); margin-top: 4px; font-style: italic;';
                                // Two real paths, not one dead end. This host (the VS Code extension) does
                                // not accept secret writes over HTTP by design — its auth token is empty,
                                // so every loopback caller would be trusted. Entering the key in the editor
                                // or writing it to the machine-global encrypted store both work; the store
                                // is imported into the keychain when the extension next activates.
                                hint.textContent = 'Read-only here. Set this key in the VS Code Setup panel, '
                                    + 'or run: npx switchboard secrets set <clickup|linear|notion|stitch> <token> '
                                    + '— then reload the VS Code window to pick it up.';
                                el.parentNode.appendChild(hint);
                            }
                        }
                    });
                };
                if (document.readyState === 'loading') {
                    document.addEventListener('DOMContentLoaded', disableInputsAndHint);
                } else {
                    disableInputsAndHint();
                }
                setTimeout(disableInputsAndHint, 500);
            }

            if (caps.featureManagement === false) {
                document.body.classList.add('host-feature-management-false');
                const disableFeatureControls = () => {
                    const btn = document.getElementById('btn-feature-action');
                    if (btn) {
                        btn.disabled = true;
                        btn.setAttribute('data-tooltip',
                            'Feature management is not available in this host — open this workspace in VS Code.');
                    }
                };
                if (document.readyState === 'loading') {
                    document.addEventListener('DOMContentLoaded', disableFeatureControls);
                } else {
                    disableFeatureControls();
                }
                setTimeout(disableFeatureControls, 500);
            }

            // Per-provider integration configured gating & hints
            if (caps.integrationsConfigured) {
                const iconfig = caps.integrationsConfigured;
                const style = document.createElement('style');
                let css = '';
                if (iconfig.clickup === false) {
                    css += `.provider-gated-clickup { position: relative; opacity: 0.6; pointer-events: none; }\n`;
                }
                if (iconfig.linear === false) {
                    css += `.provider-gated-linear { position: relative; opacity: 0.6; pointer-events: none; }\n`;
                }
                if (iconfig.notion === false) {
                    css += `.provider-gated-notion { position: relative; opacity: 0.6; pointer-events: none; }\n`;
                }
                if (iconfig.stitch === false) {
                    css += `.provider-gated-stitch { position: relative; opacity: 0.6; pointer-events: none; }\n`;
                }
                if (css) {
                    style.textContent = css;
                    document.head.appendChild(style);
                }
            }
        } catch (err) {
            console.warn('[transport] Capability gating failed:', err);
        }
    }


    /*
     * Token fields carry `type="text"` + `.masked-token-input` so Chrome's credential
     * classifier — which reads DOM attributes, never CSS — never treats them as password
     * inputs and never offers to save an API key to the browser's password manager.
     * The masking comes entirely from `-webkit-text-security: disc`, which Firefox has
     * never implemented (and CSS UI 4 offers no replacement: `input-security` only
     * *removes* obscuring). Without this fallback, a Firefox cockpit renders the token
     * the user types in the clear.
     *
     * So: where the property is unsupported, put `type="password"` back. Chromium and
     * WebKit support it and keep `type="text"`, which is where the reported save-password
     * prompt came from. Detect direction is fail-safe — an unknown engine masks.
     */
    function restoreTokenMaskingFallback() {
        try {
            const supportsTextSecurity = typeof CSS !== 'undefined'
                && typeof CSS.supports === 'function'
                && CSS.supports('-webkit-text-security', 'disc');
            if (supportsTextSecurity) { return; }
            document.querySelectorAll('input.masked-token-input').forEach(el => {
                if (el.type !== 'password') { el.type = 'password'; }
            });
        } catch (err) {
            console.warn('[transport] Token masking fallback failed:', err);
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', applyCapabilityGating);
        document.addEventListener('DOMContentLoaded', restoreTokenMaskingFallback);
    } else {
        applyCapabilityGating();
        restoreTokenMaskingFallback();
    }
})();
