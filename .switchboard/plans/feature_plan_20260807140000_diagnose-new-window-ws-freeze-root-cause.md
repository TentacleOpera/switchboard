---
title: "Diagnose and fix the New Window WebSocket freeze root cause"
created: 2026-08-07T14:00:00Z
complexity: 4
tags: [frontend, bugfix, reliability, websocket]
---

# Diagnose and fix the New Window WebSocket freeze root cause

## Goal

The "New Window" terminal sidebar freeze has a **polling safety net** (implemented in the sibling plan `feature_plan_20260806111214_new-window-sidebar-frozen.md`), but the **root cause is still unknown**. The polling mask means the operator sees a 5-second-laggy list instead of a frozen one, but the real-time WebSocket push path is still broken in the popped-out window. This plan diagnoses why and fixes it.

### Problem

When `window.open('/terminals', ...)` creates a popped-out terminal panel, the sidebar's terminal list loads correctly on first paint (the initial `fetchTerminalList()` HTTP call succeeds), but subsequent `terminalsChanged` WebSocket pushes never trigger a refresh. The shell iframe's sidebar updates in real-time — only the new window is deaf.

### Background — the full WS dispatch chain

The `terminalsChanged` push follows this path:

1. **Server:** `terminalWsGateway.initFleetListeners()` fires `this.broadcastWs('terminalsChanged', {}, 'terminals')` on every fleet event (`src/standalone/terminalWsGateway.ts:381`)
2. **Injection:** `LocalApiServer.setBroadcastWs` wrapper forwards to `this.broadcastWs(verb, payload, surface)` (`src/services/LocalApiServer.ts:425-426`)
3. **Hub:** `wsHub.broadcast('terminalsChanged', {}, 'terminals')` iterates `_connections`, skips connections whose declared surfaces don't include `'terminals'`, and sends `{type:'terminalsChanged', seq, surface:'terminals', payload:{}}` to each matching connection (`src/services/wsHub.ts:303-340`)
4. **Client transport:** `transport.js` WS `onmessage` parses the JSON envelope, unwraps it, and calls `dispatchMessage({type:'terminalsChanged', ...})` (`src/webview/transport.js:164-207`)
5. **Client dispatch:** `dispatchMessage` fires `window.dispatchEvent(new MessageEvent('message', { data }))` (`src/webview/transport.js:48-55`)
6. **Client handler:** `terminals.js` `window.addEventListener('message', ...)` checks `message.type === 'terminalsChanged'` and calls `fetchTerminalList()` (`src/webview/terminals.js:531-535`)

The new window loads the same HTML (same `data-panel="terminals"` attribute stamped by `headlessPanelHtml.ts:410`), the same `transport.js` (injected by `injectTransportShim` at `headlessPanelHtml.ts:407`), and connects to the same `ws://127.0.0.1:PORT/ws?surfaces=terminals,common` URL. The CSP allows `ws://127.0.0.1:*` and `ws://localhost:*`. The WS auth (`wsUpgradeAuth.ts:79`) accepts either `?token=` query param or `sb_session` cookie — both are same-origin and should be present.

### Root Cause — unknown (hypotheses ranked by likelihood)

The freeze existed **before** the surface parameter fix (when `terminalsChanged` was broadcast to ALL connections with `surface=undefined`), so the surface filter is NOT the cause. The WS connection itself must be failing, or the client-side dispatch must be broken.

**Hypothesis A — WS connection drops silently and reconnect is throttled.** The wsHub ping/pong reaper (`wsHub.ts:157-167`) sends a ping every 30s and terminates connections that don't respond with a pong by the next tick. If the new window's browser tab is throttled (background tab), the browser may not process the pong fast enough, the server terminates the connection, and `transport.js`'s `scheduleReconnect()` fires — but the reconnect is also throttled by the browser. The list freezes until the tab regains focus and a reconnect succeeds. **Likelihood: HIGH** — this explains why the freeze is intermittent and why the shell iframe (always foreground) doesn't hit it.

**Hypothesis B — WS connection never establishes.** The `sb_session` cookie is not sent on the WS upgrade from the `window.open`-ed page, or the Origin/Host check fails. Research refutes the SameSite=Strict cookie hypothesis (RFC 6265bis confirms same-origin WS upgrades carry the cookie), but the Origin header from a `window.open` page could differ in edge cases (e.g., `null` origin in some sandboxed contexts). **Likelihood: LOW** — research is clear, and the Origin check in `wsUpgradeAuth.ts` allows loopback origins.

**Hypothesis C — Client-side dispatch chain broken.** The WS connects and `terminalsChanged` frames arrive, but `dispatchMessage` → `window.dispatchEvent` → `terminals.js` listener fails. Possible if `terminals.js`'s listener is registered after `transport.js` dispatches (script load order issue), or if a try/catch in `dispatchMessage` swallows an error. **Likelihood: MEDIUM** — `dispatchMessage` has a try/catch that logs but continues, so errors would be visible in console.

**Hypothesis D — `getFullState` resync doesn't include terminal state.** On WS connect, the server sends a `__resync` with kanban board state only (`bootstrap.ts:355-380`). No `terminalsChanged` is in the resync payload. So the new window's terminal list depends entirely on the initial `fetchTerminalList()` HTTP call + subsequent WS pushes. If the WS is alive but no fleet event fires after connect, the list is correct but stale until the next event. This is not a bug — it's expected behavior — but it means the WS must be working for the list to stay fresh. **Likelihood: N/A** — this is the design, not a bug, but it explains why the freeze is only noticeable after a fleet change.

## Metadata

**Tags:** frontend, bugfix, reliability, websocket
**Complexity:** 4
**Project:** browser-switchboard

## User Review Required

No — the diagnostic instrumentation is safe, additive, and behind a console.log gate. The fix phase is conditional on the diagnosis.

## Complexity Audit

### Routine
- Adding `console.log`/`console.warn` statements to `wsHub.ts` and `transport.js` — same-file, same-idiom additions.
- Adding a `/ws/connections` diagnostic endpoint to `LocalApiServer.ts` — mirrors the existing `/panels` manifest endpoint pattern.
- The reconnect-on-visibility-change fix mirrors the existing `document.visibilityState` check in the fleet poll.

### Complex / Risky
- The ping/pong reaper adjustment touches the keepalive lifecycle — changing the ping cadence or adding a grace period could affect all WS connections, not just the new window. Must be validated against the existing contract tests.

## Edge-Case & Dependency Audit

- **Race Conditions:** The diagnostic logging is write-only (no state changes), so no races. The visibility-change reconnect fires `connectWs()` which has a `if (ws) return` guard — no double-connect.
- **Security:** The `/ws/connections` diagnostic endpoint must be auth-gated (`_checkAuth`) like all other endpoints. It must not expose auth tokens or sensitive data — only connection count, originator IDs, surfaces, and alive/dead status.
- **Side Effects:** The ping/pong grace period change affects all WS connections. A longer grace period means half-open connections linger longer before reaping. This is a trade-off: longer grace = more tolerance for throttled background tabs, but slower detection of truly dead connections.
- **Dependencies & Conflicts:** None — the changes are additive logging + one reconnect trigger + one optional reaper adjustment.

## Dependencies

- None

## Adversarial Synthesis

Key risks: (1) the diagnostic instrumentation could be noisy in production — must be gated behind a debug flag or `console.log` level that can be silenced; (2) the ping/pong reaper adjustment is a global change that affects all connections, not just the new window — must be validated carefully; (3) the visibility-change reconnect could cause a reconnect storm if the user rapidly switches tabs — the `scheduleReconnect` guard (`if (reconnectTimer) return`) prevents this, but the immediate `connectWs()` on visibility change bypasses the guard and could double-connect if the WS is mid-reconnect.

Mitigations: (1) use `console.log` with a `[wsHub]`/`[transport]` prefix that can be filtered in devtools; (2) the reaper adjustment is a separate change that can be skipped if the diagnosis points elsewhere; (3) the visibility-change handler checks `document.visibilityState === 'visible'` AND `!ws` before calling `connectWs()`.

## Proposed Changes

### 1. `src/services/wsHub.ts` — Add connection lifecycle logging

Add `console.log`/`console.warn` statements to `handleUpgrade`, `broadcast`, the ping/pong reaper, and the disconnect handler. Each log includes the connection's `originatorId` (or `'unknown'`) and relevant state. This makes it possible to trace whether the new window's WS connection establishes, stays alive, receives broadcasts, and when/how it disconnects.

In `handleUpgrade` (after line 269, after `this._connections.add(meta)`):
```typescript
console.log(`[wsHub] connection established: originatorId=${originatorId || 'unknown'}, surfaces=${surfaces ? [...surfaces].join(',') : 'all'}, scope=${initialScope === undefined ? 'undeclared' : initialScope === null ? 'null' : initialScope}, total=${this._connections.size}`);
```

In the ping/pong reaper loop (line 158-167), when terminating:
```typescript
if (meta.isAlive === false) {
    console.warn(`[wsHub] reaping dead connection: originatorId=${meta.originatorId || 'unknown'}, surfaces=${meta.surfaces ? [...meta.surfaces].join(',') : 'all'}`);
    try { meta.ws.terminate(); } catch { /* ignore */ }
}
```

In `broadcast` (line 303-340), add a debug log when a connection is skipped by surface filter:
```typescript
if (surface && meta.surfaces && !meta.surfaces.has(surface)) {
    // Already filtered — no log needed (this is the normal case for non-terminals panels)
    continue;
}
```
But add a log when a broadcast is sent:
```typescript
// Only log terminalsChanged to avoid noise from kanban polls
if (verb === 'terminalsChanged') {
    console.log(`[wsHub] broadcasting terminalsChanged to originatorId=${meta.originatorId || 'unknown'}, seq=${meta.seq}`);
}
```

In the disconnect handler (line 271-278):
```typescript
console.warn(`[wsHub] connection closed: originatorId=${meta.originatorId || 'unknown'}, surfaces=${meta.surfaces ? [...meta.surfaces].join(',') : 'all'}, remaining=${this._connections.size}`);
```

### 2. `src/webview/transport.js` — Add client-side WS state logging

Add logging to `connectWs`, `onopen`, `onmessage`, `onerror`, `onclose`, and `scheduleReconnect`. This makes it possible to see the WS lifecycle from the client side in the new window's devtools console.

In `ws.onopen` (line 151):
```javascript
ws.onopen = function () {
    console.log('[transport] WebSocket connected to', wsUrl());
    // ... existing code ...
};
```

In `ws.onmessage` (line 164), add a log for `terminalsChanged` specifically:
```javascript
if (msg.type === 'terminalsChanged') {
    console.log('[transport] received terminalsChanged, dispatching');
}
```

In `ws.onerror` (line 204):
```javascript
ws.onerror = function (err) {
    console.error('[transport] WebSocket error:', err, 'url=', wsUrl());
};
```

In `ws.onclose` (line 209):
```javascript
ws.onclose = function () {
    console.warn('[transport] WebSocket closed, scheduling reconnect');
    ws = null;
    if (!intentionallyClosed) {
        scheduleReconnect();
    }
};
```

In `scheduleReconnect` (line 217):
```javascript
function scheduleReconnect() {
    if (reconnectTimer) { return; }
    console.log('[transport] scheduling reconnect in', reconnectDelay, 'ms');
    reconnectTimer = setTimeout(function () {
        reconnectTimer = null;
        reconnectDelay = Math.min(reconnectDelay * 2, maxReconnectDelay);
        connectWs();
    }, reconnectDelay);
}
```

### 3. `src/webview/transport.js` — Reconnect on visibility change

Add a `visibilitychange` listener that triggers an immediate reconnect when the tab becomes visible and the WS is down. This directly addresses Hypothesis A — if the ping/pong reaper killed the connection while the tab was throttled, the reconnect fires the moment the user returns to the tab.

After the `connectWs()` call at line 226:
```javascript
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && !ws && !reconnectTimer) {
        console.log('[transport] tab visible, WS down — immediate reconnect');
        reconnectDelay = 500; // reset backoff
        connectWs();
    }
});
```

The guard `!ws && !reconnectTimer` prevents double-connect: if the WS is already up or a reconnect is already scheduled, the listener no-ops.

### 4. `src/services/wsHub.ts` — Add pong grace period (conditional on Hypothesis A)

If the diagnosis confirms Hypothesis A (ping/pong reaper kills throttled background connections), add a grace period before reaping. Instead of terminating on the first missed pong, send a second ping and only terminate if that one is also missed.

Replace the ping/pong reaper (lines 157-167):
```typescript
if (!this._pingInterval) {
    this._pingInterval = setInterval(() => {
        for (const meta of this._connections) {
            if (meta.isAlive === false) {
                if (meta.missedPings === undefined) { meta.missedPings = 0; }
                meta.missedPings++;
                if (meta.missedPings >= 2) {
                    console.warn(`[wsHub] reaping dead connection after 2 missed pings: originatorId=${meta.originatorId || 'unknown'}`);
                    try { meta.ws.terminate(); } catch { /* ignore */ }
                } else {
                    console.warn(`[wsHub] missed ping ${meta.missedPings}, giving grace: originatorId=${meta.originatorId || 'unknown'}`);
                    // Don't terminate — try again next cycle
                }
            } else {
                meta.isAlive = false;
                meta.missedPings = 0;
                try { meta.ws.ping(); } catch { /* ignore */ }
            }
        }
    }, this._options.pingIntervalMs ?? 30000);
}
```

Add `missedPings?: number` to the `ConnectionMeta` interface (line 110-121).

This gives background tabs a 60s grace period (2 ping cycles at 30s each) before reaping, which is enough for most browser throttling scenarios. The trade-off is that truly dead connections linger for 60s instead of 30s — acceptable for a localhost-only server.

**This change is conditional** — only apply it if the diagnostic logging confirms that the reaper is killing the new window's connection. If the diagnosis points elsewhere, skip this change.

### 5. `src/services/LocalApiServer.ts` — Add `/ws/connections` diagnostic endpoint

Add a read-only endpoint that returns the current WS connection metadata (count, originatorIds, surfaces, alive status). This lets the operator check whether the new window's WS connection is registered server-side without reading server logs.

In `_handleRequest`, add a route before the panel routes:
```typescript
else if (pathname === '/ws/connections' && req.method === 'GET') {
    if (!await this._checkAuth(req, true)) {
        this._sendUnauthorized(res);
        return;
    }
    const connections = this._wsHub ? Array.from(this._wsHub['_connections'] as Set<any>).map((m: any) => ({
        originatorId: m.originatorId || 'unknown',
        surfaces: m.surfaces ? [...m.surfaces] : 'all',
        isAlive: m.isAlive,
        project: m.project === undefined ? 'undeclared' : m.project === null ? 'null' : m.project,
        seq: m.seq
    })) : [];
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ count: connections.length, connections }, null, 2));
    return;
}
```

Note: accessing `this._wsHub['_connections']` is a private field access — add a public getter on `WsHub` instead:
```typescript
// In wsHub.ts, add:
public getConnectionInfo(): Array<{ originatorId?: string; surfaces?: string[]; isAlive?: boolean; project?: string | null; seq: number }> {
    return Array.from(this._connections).map(m => ({
        originatorId: m.originatorId,
        surfaces: m.surfaces ? [...m.surfaces] : undefined,
        isAlive: m.isAlive,
        project: m.project,
        seq: m.seq
    }));
}
```

Then in `LocalApiServer.ts`:
```typescript
const connections = this._wsHub ? this._wsHub.getConnectionInfo() : [];
```

## Verification Plan

### Automated Tests

- `npm run compile` — verify TypeScript compiles (the `ConnectionMeta` interface change and the `getConnectionInfo` getter).
- `npm run test:contract:shell-terminal-strip` — verify the existing terminal contract tests still pass.
- `npm run test:contract:terminal-rename-rekey` — verify the rename/rekey contract still passes.

### Manual Tests

1. **Diagnostic logging — server side:** Start the standalone server. Open the terminals panel in the shell. Click "New Window". Check the server console for `[wsHub] connection established` — verify a second connection appears with `surfaces=terminals,common`. If it does NOT appear, Hypothesis B (WS never connects) is confirmed.

2. **Diagnostic logging — client side:** In the new window, open devtools console. Verify `[transport] WebSocket connected to ws://...` appears. If it does NOT, the WS connection failed to establish. If it appears but `[transport] WebSocket closed` follows immediately, the connection is dropping.

3. **Broadcast tracing:** From the shell, create a new terminal. Check the server console for `[wsHub] broadcasting terminalsChanged to originatorId=...` — verify it logs for BOTH the shell iframe's connection AND the new window's connection. Check the new window's devtools console for `[transport] received terminalsChanged, dispatching`. If the server logs the broadcast but the client doesn't log receipt, the message is lost in transport. If the client logs receipt but the list doesn't update, the dispatch chain is broken.

4. **Reaper tracing:** Open the new window, switch to another browser tab. Wait 60+ seconds. Check the server console for `[wsHub] reaping dead connection` or `[wsHub] missed ping`. If the reaper kills the connection, Hypothesis A is confirmed. Switch back to the new window tab — verify `[transport] tab visible, WS down — immediate reconnect` appears in the client console, followed by `[transport] WebSocket connected`.

5. **`/ws/connections` endpoint:** Open `http://127.0.0.1:PORT/ws/connections` in a browser. Verify the JSON response shows both the shell iframe's and the new window's WS connections. Check `isAlive`, `surfaces`, and `seq` for each.

6. **Visibility reconnect:** Open the new window, switch away for 60+ seconds (enough for the reaper to kill the connection), switch back. Within 1 second, the sidebar should update (either via WS reconnect + push, or via the fleet poll). Verify the devtools console shows the reconnect sequence.

7. **Pong grace period (if change #4 applied):** Open the new window, switch away for 35 seconds (enough for one missed ping with the old 30s reaper, but not enough for the new 60s grace). Switch back. Verify the connection is still alive (no reconnect needed). Check server console for `[wsHub] missed ping 1, giving grace` — the connection should survive.

## Completion Report

*(to be filled in after implementation)*
