# Orchestrator Visibility and Control in the Shell Rail

## Goal

The orchestrator can be active for long, unbounded periods — hours or overnight. There is no visible indicator in the shell rail that an orchestrator session is live, and no way for the user to end it from the browser UI. The user must not rely on the system guessing liveness via timeouts or heartbeats (guessing gets inaccurate over long periods). Instead, put control in the user's hands: a UFO icon in the shell rail that lights up when an orchestrator is active, and clicking it ends the session immediately.

### Problem Analysis

**Current state:**
- `POST /orchestration/adopt` records an `OrchestratorSeat` in `autoban.state` (the uncommitted work). The seat has `terminalName?` and `adoptedAt` but no heartbeat, no timeout, no stale detection.
- `POST /orchestration/stop` already exists and calls `stopOrchestratorFromKanban()` — disarms (`orchestratorArmed: false`), clears seat (`orchestratorSeat: undefined`), persists, broadcasts, and archives the session file. But it is only wired in the VS Code extension host's `TaskViewerProvider`, not in the standalone bootstrap that serves the browser shell.
- The shell (`shell.html`/`shell.js`) receives `terminalFleetState` from the terminals iframe via `postMessage`, but never receives autoban state. It has no way to know an orchestrator is active.
- The `/switchboard` skill and the orchestrator persona (`switchboard-orchestrator/SKILL.md`) do not document `POST /orchestration/stop` as the way to end a session.

**Root cause:** The adopt work added the seat record but no UI surface for it. The stop endpoint exists but is unreachable from the browser shell (503 in standalone mode) and undocumented in the skills the orchestrator follows.

**Why not timeouts/heartbeats:** The orchestrator may be active for hours or overnight. A timeout short enough to catch a crash would fire false positives during legitimate long silences; a timeout long enough to avoid false positives would leave a stale seat blocking new adoptions for ages. The user is the reliable signal — they can see whether they have an orchestrator running.

**Delivery path (verified):** In standalone/headless mode, `BroadcastHub.push` has no webview, so `autobanStateSync` is fanned out solely via `apiServer.broadcastWs` (the WebSocket hub). `transport.js` is injected into each panel iframe by `injectTransportShim` (`headlessPanelHtml.ts`); it unwraps wsHub frames and dispatches them as `MessageEvent`s on the panel `window`. `terminals.html` DOES get the transport shim injected (`getTerminalsHtml`, `headlessPanelHtml.ts:407`), so `terminals.js` receives `autobanStateSync` broadcasts — it simply has no handler today. `buildAutobanBroadcastState` (`autobanState.ts:388-395`) includes `orchestratorSeat` and `orchestratorArmed` in the broadcast payload, so the relay has the fields it needs. The shell itself (`shell.html`) does NOT include `transport.js` and has no WebSocket — it only hosts iframes and listens for `postMessage` from them.

**Cold-load is covered by WS resync-on-connect:** `wsHub` sends a `__resync` frame on every new connection (`wsHub.ts:290-336`), backed by `getFullState` → `kanbanProvider.getFullStateMessages()`, which includes `updateAutobanConfig` with the current `_autobanState` (`KanbanProvider.ts:1311-1316`). When the terminals panel's WS connects, the resync delivers the current orchestrator state — including `orchestratorSeat` and `orchestratorArmed` — as an `updateAutobanConfig` message. The relay handler below covers both `autobanStateSync` (live push-on-change) and `updateAutobanConfig` (resync + kanban-broadcast twin), so a shell opened after a seat was already adopted receives the state on connect without any extra endpoint.

## Metadata

**Complexity:** 4
**Tags:** frontend, ui, ux, backend, api, refactor
**Project:** Browser Switchboard

## User Review Required

- **Active-state tooltip content.** The plan surfaces `terminalName` and `adoptedAt` from the seat in the active tooltip (e.g. "Orchestrator: active on `coder-1` since 21:00 — click to end"). Confirm the desired phrasing and whether the timestamp should be absolute, relative, or omitted.

## Complexity Audit

### Routine
- Wiring `orchestrationStop` into the standalone bootstrap options object — the method is already public on `TaskViewerProvider` and the `LocalApiServerOptions` interface already declares the optional field.
- Adding an `autobanStateSync` / `updateAutobanConfig` handler arm in `terminals.js` and a `relayOrchestratorStateToShell` function — mirrors the existing `terminalFleetState` relay pattern (terminals.js → shell via `postMessage`).
- Adding the `orchestratorState` message arm in `shell.js` and the `renderOrchestratorIcon` / `createOrchestratorIcon` functions — follows the existing strip-icon render pattern.
- Copying the UFO SVG from the sibling `switchboard-site` repo and serving it at `/static/icons/orchestrator-ufo.svg` — the `icons` static route already maps `/static/icons/` to the repo-root `icons/` directory (`bootstrap.ts` `staticRoutes`).
- Documenting `POST /orchestration/stop` in the two skill files — prose additions.

### Complex / Risky
- **ptyReady-coupled relay.** The terminals panel is fail-closed (`enabled: availability?.terminals === true`); without node-pty the iframe is not mounted and the relay cannot fire. Acceptable because an orchestrator session requires terminals to drive coders, but it is a hard dependency that must be documented.

## Edge-Case & Dependency Audit

**Race Conditions:**
- **Resync before shell listener ready.** If the WS resync reaches terminals.js before the shell has mounted its `message` listener, the relay's `postMessage` is dropped. The next state change re-relays. No re-queue needed — the resync fires on every (re)connect, so a panel reload re-delivers the current state.

**Security:**
- The relay `postMessage` uses `location.origin` as target origin; the shell handler checks `event.origin !== location.origin` and returns on mismatch. Keep both guards.
- `POST /orchestration/stop` is loopback-only (the LocalApiServer binds 127.0.0.1); the fetch uses `credentials: 'same-origin'`. No new auth surface.

**Side Effects:**
- `stopOrchestratorFromKanban` disarms, clears the seat, persists, broadcasts, and archives the session file. Clicking the lit icon is destructive to the running session — by design, no confirmation prompt (the user is the signal). The tooltip must communicate this clearly.

**Dependencies & Conflicts:**
- **node-pty / terminals panel.** The relay source (terminals.js) is only mounted when `ptyReady`. Without node-pty: no terminals iframe → no relay → icon never lights. This is acceptable (no terminals ⇒ no orchestrator session can drive coders).
- **transport.js injection.** Verified present for `terminals.html` (`headlessPanelHtml.ts:407`). If a future refactor moves panel HTML generation off `injectTransportShim`, the relay breaks silently.
- **`showStripToast` does not exist** in `shell.js` today (`showStripTooltip` does, at line 180; `showTransportError` lives in `transport.js`). The new toast helper must be declared before the click handler that calls it (single-pass IIFE — forward references throw).

## Dependencies

- None. This plan is self-contained; it wires existing public methods and existing broadcast/transport infrastructure.

## Adversarial Synthesis

Key risks: (1) the relay is coupled to the terminals panel being mounted (fail-closed on `ptyReady`) — without node-pty the icon never lights, but an orchestrator without terminals cannot drive coders so this is acceptable; (2) `showStripToast` must be declared before the click handler that calls it or the IIFE throws on first click; (3) resync race — if the WS resync reaches terminals.js before the shell has mounted its `message` listener, the relay's `postMessage` is dropped and the icon stays dark until the next state change (arm/stop/seat-clear). Self-healing on any state change, but a session with no state changes after adopt would show a dark icon throughout. Mitigations: document the ptyReady dependency; place `showStripToast` with the other strip helpers (near `showStripTooltip`, line 180) before `createOrchestratorIcon`; document the resync race as a known limitation (a re-relay on shell mount would require the shell to know when the terminals panel has connected, which it cannot today).

## Proposed Changes

### 1. Wire `orchestrationStop` in standalone bootstrap

**File:** `src/standalone/bootstrap.ts`

The standalone bootstrap builds the `LocalApiServerOptions` object (~line 2340) but does not include `orchestrationStop`. Add it:

```ts
orchestrationStop: async () => {
    await taskViewerProvider.stopOrchestratorFromKanban(workspaceRoot);
},
```

`stopOrchestratorFromKanban` is already a public method on `TaskViewerProvider` (line 11169) that works without VS Code APIs — it only touches `autoban.state`, persists, broadcasts, and archives the session file. The standalone bootstrap already creates a `taskViewerProvider` instance (line 877) and calls `setApiServer(server)` on it (line 2485).

### 2. Relay orchestrator state from terminals panel to shell

**File:** `src/webview/terminals.js`

The terminals panel subscribes to the `common` surface via WebSocket and receives `autobanStateSync` broadcasts (pushed by `_postAutobanStateNow` in `TaskViewerProvider`) plus `updateAutobanConfig` on WS resync-on-connect. It currently has no handler for either message type.

Add a handler in the `window.addEventListener('message', ...)` block (~line 1097):

```js
} else if ((message.type === 'autobanStateSync' || message.type === 'updateAutobanConfig') && message.state) {
    relayOrchestratorStateToShell(message.state);
}
```

Add a new function `relayOrchestratorStateToShell(state)` (near the existing `terminalFleetState` postMessage ~line 1428):

```js
function relayOrchestratorStateToShell(state) {
    if (window.parent === window) { return; } // not embedded
    const seat = state.orchestratorSeat || null;
    window.parent.postMessage({
        type: 'orchestratorState',
        active: !!(state.orchestratorSeat || state.orchestratorArmed),
        armed: !!state.orchestratorArmed,
        seat: seat ? { terminalName: seat.terminalName || null, adoptedAt: seat.adoptedAt || null } : null
    }, location.origin);
}
```

Both message types are handled identically because either may arrive: `autobanStateSync` on live state changes, `updateAutobanConfig` on WS resync-on-connect (cold load). This covers the case where a shell is opened after a seat was already adopted — the resync delivers the current state on connect without any extra endpoint.

### 3. Handle `orchestratorState` in the shell

**File:** `src/webview/shell.js`

Add a new message handler arm in the `window.addEventListener('message', ...)` block (~line 718):

```js
} else if (data.type === 'orchestratorState') {
    if (event.origin !== location.origin) { return; }
    renderOrchestratorIcon(data);
}
```

Add state tracking and the render function (placed after the existing strip helpers):

```js
let orchestratorActive = false;
let orchestratorSeat = null;

function renderOrchestratorIcon(state) {
    orchestratorActive = !!state.active;
    orchestratorSeat = state.seat || null;
    let icon = document.getElementById('strip-orchestrator');
    if (!orchestratorActive) {
        if (icon) {
            icon.classList.remove('orchestrator-active');
            icon.classList.add('orchestrator-dimmed');
            icon.dataset.tooltip = 'Orchestrator: inactive — click to copy start instructions';
        }
        return;
    }
    if (!icon) {
        icon = createOrchestratorIcon();
    }
    icon.classList.remove('orchestrator-dimmed');
    icon.classList.add('orchestrator-active');
    const since = orchestratorSeat && orchestratorSeat.adoptedAt
        ? new Date(orchestratorSeat.adoptedAt).toLocaleTimeString()
        : '';
    const where = orchestratorSeat && orchestratorSeat.terminalName
        ? ' on ' + orchestratorSeat.terminalName : '';
    icon.dataset.tooltip = since
        ? 'Orchestrator: active' + where + ' since ' + since + ' — click to end session'
        : 'Orchestrator: active — click to end session';
}
```

`createOrchestratorIcon()` creates the button, inserts it as the first child of `#strip-terminals` (before the fleet terminal buttons), and wires the click handler.

### 4. Add the UFO icon to the shell rail

**Files:** `src/webview/shell.html` (CSS), `src/webview/shell.js` (DOM), `icons/orchestrator-ufo.svg` (new icon)

**Icon asset:** Copy `switchboard-ufo.svg` from the sibling repo `switchboard-site/public/assets/` to `icons/orchestrator-ufo.svg` in the switchboard repo. Verified: the source exists at `/Users/patrickvuleta/Documents/GitHub/switchboard-site/public/assets/switchboard-ufo.svg` — a 320×180 pixel-art UFO with animated cyan lights, hover bob, beam pulse, and classed sub-elements (`.ufo`, `.beam`, `.light-a`, `.light-b`, `.star-a`, `.star-b`) that match the CSS selectors below. The SVG already includes its own `@media (prefers-reduced-motion: reduce)` block freezing all animations. The animations (hover, light blinking, beam pulse) are the "lit" state; when dimmed, the rail CSS suppresses them and `opacity`/`grayscale` fades the icon.

**CSS in `shell.html`:**

```css
#strip-orchestrator {
    width: 100%;
    display: flex;
    justify-content: center;
    padding: 4px 0;
    border-bottom: 1px solid var(--border);
    margin-bottom: 4px;
    background: none;
    border-left: none;
    border-right: none;
    border-top: none;
    cursor: default;
}
#strip-orchestrator.orchestrator-dimmed {
    opacity: 0.35;
    filter: grayscale(0.8);
}
#strip-orchestrator.orchestrator-dimmed .ufo,
#strip-orchestrator.orchestrator-dimmed .beam,
#strip-orchestrator.orchestrator-dimmed .light-a,
#strip-orchestrator.orchestrator-dimmed .light-b,
#strip-orchestrator.orchestrator-dimmed .star-a,
#strip-orchestrator.orchestrator-dimmed .star-b {
    animation: none !important;
}
#strip-orchestrator.orchestrator-active {
    cursor: pointer;
}
#strip-orchestrator .strip-orch-icon {
    width: 28px;
    height: 16px;
    object-fit: contain;
    pointer-events: none;
}
@media (prefers-reduced-motion: reduce) {
    #strip-orchestrator .ufo,
    #strip-orchestrator .beam,
    #strip-orchestrator .light-a,
    #strip-orchestrator .light-b,
    #strip-orchestrator .star-a,
    #strip-orchestrator .star-b {
        animation: none !important;
    }
}
```

The icon is an `<img>` pointing at the SVG (same pattern as `.strip-term-icon`). The SVG's built-in CSS animations handle the "lit" state — the cyan lights blink, the UFO hovers, the beam pulses. When dimmed, `animation: none` freezes it and `opacity`/`grayscale` fades it.

**DOM in `shell.js`** — `showStripToast` MUST be declared before `createOrchestratorIcon` (single-pass IIFE — a forward reference throws `ReferenceError`). Place it near `showStripTooltip` (line 180):

```js
function showStripToast(text) {
    // Minimal transient message near the rail. Reuses the body-level
    // tooltip-overlay positioning pattern (shell.js:171+) but auto-dismisses.
    let toast = document.getElementById('strip-toast');
    if (!toast) {
        toast = document.createElement('div');
        toast.id = 'strip-toast';
        toast.style.cssText = 'position:fixed; right:60px; bottom:12px; z-index:9999;'
            + 'padding:6px 10px; border-radius:4px; background:var(--bg-elevated,#222);'
            + 'color:var(--text-primary,#e0e0e0); font-size:11px; pointer-events:none;'
            + 'box-shadow:0 2px 8px rgba(0,0,0,0.4); transition:opacity 0.3s;';
        document.body.appendChild(toast);
    }
    toast.textContent = text; // textContent only — never innerHTML
    toast.style.opacity = '1';
    clearTimeout(toast._dismissTimer);
    toast._dismissTimer = setTimeout(() => { toast.style.opacity = '0'; }, 3000);
}

function createOrchestratorIcon() {
    const btn = document.createElement('button');
    btn.id = 'strip-orchestrator';
    btn.type = 'button';
    btn.className = 'orchestrator-dimmed';
    btn.setAttribute('aria-label', 'Orchestrator session');
    btn.dataset.tooltip = 'Orchestrator: inactive — click to copy start instructions';

    const icon = document.createElement('img');
    icon.className = 'strip-orch-icon';
    icon.src = '/static/icons/orchestrator-ufo.svg';
    icon.alt = '';
    btn.appendChild(icon);

    btn.addEventListener('click', () => {
        if (orchestratorActive) {
            // End immediately — no confirmation. The user is in control.
            btn.dataset.tooltip = 'Orchestrator: stopping…';
            fetch('/orchestration/stop', { method: 'POST', credentials: 'same-origin' })
                .then(res => res.json())
                .then(result => {
                    if (result.success) {
                        showStripToast('Orchestrator session ended');
                    } else {
                        showStripToast('Failed to stop orchestrator: ' + (result.error || 'unknown'));
                    }
                })
                .catch(err => {
                    showStripToast('Failed to stop orchestrator: ' + err.message);
                });
        } else {
            // Dimmed click: copy the start instruction to clipboard.
            const text = 'Run /switchboard workflow to start orchestration';
            if (navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(text).then(() => {
                    showStripToast('Copied: ' + text);
                }).catch(() => {
                    showStripToast(text);
                });
            } else {
                showStripToast(text);
            }
        }
    });

    // Insert as first child of #strip-terminals (may need to be created lazily).
    let container = document.getElementById('strip-terminals');
    if (!container) {
        container = document.createElement('div');
        container.id = 'strip-terminals';
        container.role = 'group';
        container.setAttribute('aria-label', 'Fleet terminals');
        const strip = document.getElementById('strip');
        if (strip) { strip.appendChild(container); }
    }
    container.insertBefore(btn, container.firstChild);
    return btn;
}
```

**Tooltip Updates:** When active, the tooltip reads `Orchestrator: active [on <terminal>] [since <time>] — click to end session`. When dimmed, `Orchestrator: inactive — click to copy start instructions`.

**Toast:** `showStripToast(text)` — a minimal transient message near the rail, auto-dismissing after ~3s. Declared before the click handler that calls it.

### 5. Serve the UFO icon as a static asset

**File:** `src/services/headlessPanelHtml.ts` or the static routes configuration in `bootstrap.ts`

The SVG must be served at `/static/icons/orchestrator-ufo.svg`. The `icons` static route already maps `/static/icons/` to the repo-root `icons/` directory (`bootstrap.ts` `staticRoutes`, line 767: `icons: [path.join(repoRoot, 'icons')]`). Copying the SVG to `icons/orchestrator-ufo.svg` is sufficient — no route changes needed.

### 6. Document `POST /orchestration/stop` in the skills

**File:** `.claude/skills/switchboard/SKILL.md`

In Step 2 (become the orchestrator), after the adopt/confirm instructions, add a note:

> **To end the session:** call `POST /orchestration/stop`. This disarms the orchestrator, clears the seat, archives the session file, and broadcasts the state change. The shell rail's UFO icon will dim. You can also tell the user to click the lit UFO icon in the rail.

**File:** `.agents/skills/switchboard-orchestrator/SKILL.md`

In the "Session Completion" section (already added in the uncommitted work), add:

> **Ending the session early:** call `POST /orchestration/stop` to disarm and clear the seat. The user can also click the UFO icon in the shell rail to end the session from the browser UI.

## Verification Plan

### Automated Tests
1. **Standalone stop endpoint:** Start the standalone server, adopt an orchestrator seat via `POST /orchestration/adopt`, then call `POST /orchestration/stop`. Verify the response is `{ success: true }` and `autoban.state` no longer has `orchestratorSeat` or `orchestratorArmed`.
2. **State relay (live):** With an orchestrator seat active, open the shell in a browser. Verify the UFO icon appears at the top of `#strip-terminals` with animated cyan lights. Call `POST /orchestration/stop` and verify the icon dims.
3. **State relay (cold load):** Adopt a seat, THEN open a fresh shell. Verify the WS resync-on-connect delivers `updateAutobanConfig` and the icon lights up without waiting for a live broadcast.
4. **Click to stop:** Click the lit UFO icon. Verify `POST /orchestration/stop` is called and the icon dims. Verify a toast appears saying "Orchestrator session ended".
5. **Click when dimmed:** Click the dimmed UFO icon. Verify the clipboard contains "Run /switchboard workflow to start orchestration" and a toast appears.
6. **No orchestrator state on init:** Open the shell with no orchestrator active. Verify the dimmed UFO icon is present at the top of `#strip-terminals`.
7. **Reduced motion:** With `prefers-reduced-motion: reduce`, verify the UFO icon shows without animation when active (static lights, no hover).
8. **Shell test:** Add or update `src/test/shell-terminal-strip.test.js` to verify the orchestrator icon renders and the click handler calls the stop endpoint.

## Out of Scope

- **Starting an orchestrator terminal from the shell.** The dimmed-click path copies a prompt for the user to paste into their agent surface. Starting an orchestrator pty terminal from the standalone shell requires a standalone equivalent of `startOrchestratorFromKanban` (which uses `vscode.window.createTerminal`). That is a separate plan.
- **Heartbeat, timeout, or stale-seat detection.** Deliberately excluded per the user's decision — the user is the reliable signal, not a timer.
- **AUTOMATION tab Stop button changes.** The AUTOMATION tab already has a Stop button that calls `stopOrchestratorFromKanban`. No changes needed there.
