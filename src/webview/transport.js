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

    function wsUrl() {
        const loc = window.location;
        const protocol = loc.protocol === 'https:' ? 'wss:' : 'ws:';
        return `${protocol}//${loc.host}/ws`;
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
    const vscodeShim = {
        postMessage: function (message) {
            if (!message || typeof message.type !== 'string') {
                console.warn('[transport] postMessage without type ignored:', message);
                return;
            }
            const verb = message.type;
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

    // ─── Host-adaptive UI ────────────────────────────────────────────────────
    function applyCapabilityGating() {
        try {
            const raw = document.body.dataset.hostCapabilities;
            if (!raw) { return; }
            const caps = JSON.parse(raw.replace(/&quot;/g, '"'));
            if (caps.terminalDispatch !== false) { return; }

            document.body.classList.add('host-terminal-dispatch-false');

            const style = document.createElement('style');
            style.textContent = `
.host-terminal-dispatch-false #btn-autoban,
.host-terminal-dispatch-false #btn-manager-pass,
.host-terminal-dispatch-false #btn-cli-triggers,
.host-terminal-dispatch-false #btn-create-worktree,
.host-terminal-dispatch-false #btn-remote-control,
.host-terminal-dispatch-false .autoban-timers-inline,
.host-terminal-dispatch-false #btn-pause-autoban-timer,
.host-terminal-dispatch-false #btn-reset-autoban-timer,
.host-terminal-dispatch-false #clear-terminal-before-prompt-label,
.host-terminal-dispatch-false .shared-tab-btn[data-tab="agents"],
.host-terminal-dispatch-false .shared-tab-btn[data-tab="automation"],
.host-terminal-dispatch-false .shared-tab-btn[data-tab="worktrees"],
.host-terminal-dispatch-false #agents-tab-content,
.host-terminal-dispatch-false #automation-tab-content,
.host-terminal-dispatch-false #worktrees-tab-content,
.host-terminal-dispatch-false button[data-action="julesSelected"],
.host-terminal-dispatch-false button[data-action="moveSelected"],
.host-terminal-dispatch-false button[data-action="moveAll"] {
    display: none !important;
}
`;
            document.head.appendChild(style);
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
