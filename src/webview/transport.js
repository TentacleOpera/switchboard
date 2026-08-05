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
    let reconnectTimer;
    let intentionallyClosed = false;

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
        try {
            ws = new WebSocket(wsUrl());
        } catch (err) {
            console.error('[transport] WebSocket constructor failed:', err);
            scheduleReconnect();
            return;
        }

        ws.onopen = function () {
            console.log('[transport] WebSocket connected');
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
            console.error('[transport] WebSocket error:', err);
        };

        ws.onclose = function () {
            ws = null;
            if (!intentionallyClosed) {
                scheduleReconnect();
            }
        };
    }

    function scheduleReconnect() {
        if (reconnectTimer) { return; }
        reconnectTimer = setTimeout(function () {
            reconnectTimer = null;
            reconnectDelay = Math.min(reconnectDelay * 2, maxReconnectDelay);
            connectWs();
        }, reconnectDelay);
    }

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
                    if (result && result.prompt && navigator.clipboard && navigator.clipboard.writeText) {
                        navigator.clipboard.writeText(result.prompt).catch(function (err) {
                            console.warn('[transport] Clipboard write failed:', err);
                        });
                    }
                    if (result && typeof result === 'object' && result.success === false) {
                        const text = result.error || ('Action failed: ' + verb);
                        console.warn('[transport] verb failed:', verb, text);
                        if (STATUS_MESSAGE_PANELS[panel]) {
                            dispatchMessage({ type: 'showStatusMessage', message: text, isError: true });
                        } else {
                            showTransportError(text);
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

            if (caps.automation === false) {
                document.body.classList.add('host-automation-false');
                const style = document.createElement('style');
                style.textContent = `
.host-automation-false #btn-autoban,
.host-automation-false #btn-manager-pass,
.host-automation-false #btn-cli-triggers,
.host-automation-false #btn-remote-control,
.host-automation-false .autoban-timers-inline,
.host-automation-false #btn-pause-autoban-timer,
.host-automation-false #btn-reset-autoban-timer,
.host-automation-false button[data-action="julesSelected"],
.host-automation-false button[data-action="rePlanSelected"],
.host-automation-false #btn-build-via-planner,
.host-automation-false #btn-update-via-planner,
.host-automation-false #btn-build-system,
.host-automation-false #btn-build-prd-via-planner,
.host-automation-false [data-tab="automation"],
.host-automation-false #automation-tab-content,
.host-automation-false #automation-panel-root {
    display: none !important;
}
`;
                document.head.appendChild(style);
            }

            // orchestrator / mcpTerminals: the body class is the contract; the selector
            // lists below are FORWARD-COMPATIBILITY ONLY and currently match nothing in
            // kanban.html (verified: 0 occurrences of #btn-orchestrator, .orchestrator-only,
            // .mcp-monitor-only, #btn-launch-mcp-monitor). Both clusters are built
            // dynamically inside the automation panel — the orchestrator as an automation
            // MODE (kanban.html:9296, :10796) and the MCP monitor as `mcpConfigPanel`
            // (:10991) — so what actually hides them today is the `automation === false`
            // tab gate above. Do NOT "fix" these by adding matching selectors to real
            // controls: the EXTENSION host also declares mcpTerminals:false (see
            // TaskViewerProvider baseHostCapabilities) while its MCP monitor works, so a
            // matching selector would hide a working editor surface. Gate those on a new,
            // honestly-derived flag instead.
            if (caps.orchestrator === false) {
                document.body.classList.add('host-orchestrator-false');
                const style = document.createElement('style');
                style.textContent = `
.host-orchestrator-false #btn-orchestrator,
.host-orchestrator-false .orchestrator-only {
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
.host-secrets-entry-false #btn-save-stitch-auth {
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


    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', applyCapabilityGating);
    } else {
        applyCapabilityGating();
    }
})();
