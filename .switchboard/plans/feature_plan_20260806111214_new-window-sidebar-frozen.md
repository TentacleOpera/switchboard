---
title: "New Window terminal sidebar list frozen at creation time"
created: 2026-08-06T11:12:14Z
complexity: 3
tags: [frontend, bugfix, reliability]
---

# New Window terminal sidebar list frozen at creation time

## Goal

When the "New Window" button in `terminals.html` opens a popped-out terminal panel via `window.open('/terminals', ...)`, the sidebar terminal list in the new window loads correctly on first paint but then **freezes** — it never reflects terminals created, closed, or renamed after the window was opened. The operator sees a stale list that diverges from reality until they manually reload the page.

### Symptom

The new window's sidebar shows the correct terminal list at creation time (the initial `fetchTerminalList()` succeeds), but subsequent fleet changes never appear. Creating a terminal from the original shell, closing one, or renaming one — none of these propagate to the popped-out window's sidebar.

### Root Cause

The terminal list in `terminals.js` has **no polling fallback**. After the initial `fetchTerminalList()` call in `init()`, the list is updated exclusively by `terminalsChanged` WebSocket push messages:

```javascript
// terminals.js:523-527
window.addEventListener('message', (event) => {
    const message = event.data;
    if (!message) return;
    if (message.type === 'terminalsChanged') {
        fetchTerminalList();
    }
```

The kanban panes have a 5-second poll (`setInterval(pollKanbanPanes, 5000)` at line 2752), but the terminal fleet list itself has **no equivalent**. If the WebSocket push path fails for any reason, the list is permanently stale.

> **Superseded:** The original plan cited `terminals.js:481-485` for the message listener and `line 2523` for the kanban poll.
> **Reason:** The file has drifted ~40 lines since the plan was written; those line numbers point to unrelated code (button event listeners and kanban pane column pickers).
> **Replaced with:** Correct line numbers — message listener at `terminals.js:523-527`, kanban poll at `terminals.js:2750-2753`.

### Why WebSocket push may fail in the new window

The `terminalsChanged` broadcast originates in `TerminalWsGateway.initFleetListeners()` (`src/standalone/terminalWsGateway.ts:372-383`):

```typescript
this.fleetService.onDidChange((event) => {
    // ... track/untrack ...
    if (this.broadcastWs) {
        this.broadcastWs('terminalsChanged', {}, 'terminals');
    }
});
```

> **Superseded:** The original plan cited the file path as `src/services/terminalWsGateway.ts`.
> **Reason:** The file does not exist at that path; it lives under `src/standalone/`.
> **Replaced with:** `src/standalone/terminalWsGateway.ts`.

This calls through `setBroadcastWs`, which was wired in `LocalApiServer.ts:425`:

```typescript
(this._options.terminalWsGateway as any).setBroadcastWs?.((verb: string, payload: any) => {
    this.broadcastWs(verb, payload);  // ← surface parameter DROPPED
});
```

The wrapper accepts `(verb, payload)` but the gateway calls with `(verb, payload, surface)`. The `'terminals'` surface is silently discarded. `LocalApiServer.broadcastWs(verb, payload)` then calls `wsHub.broadcast(verb, payload, undefined)`.

In `wsHub.broadcast()` (`wsHub.ts:316`):
```typescript
if (surface && meta.surfaces && !meta.surfaces.has(surface)) {
    continue;
}
```

With `surface=undefined`, this filter is skipped and the message is delivered to **all** connections. This is wasteful (kanban, setup, design panels all receive `terminalsChanged`) but not the direct cause of the freeze — the new window's terminals panel should still receive it.

> **Superseded:** The original plan stated "The actual freeze occurs because the new window's WebSocket connection to `/ws` is unreliable" and attributed it to `SameSite=Strict` cookie interactions with WebSocket upgrades from `window.open`-ed pages.
> **Reason:** This diagnosis was **refuted by web research** (RFC 6265bis, RFC 6455, Chromium/Firefox/WebKit bug trackers). `SameSite=Strict` cookies ARE reliably sent on same-origin WebSocket upgrade requests from `window.open`-ed pages in all modern browsers. The `sb_session` cookie (`SameSite=Strict; HttpOnly; Path=/`, set at `LocalApiServer.ts:624`) is sent on the WS upgrade to `/ws` from the same-origin `/terminals` page — the cookie's `Path=/` matches `/ws`, the origin matches, and the site-for-cookies evaluation passes. The original hypothesis likely arose from a Chromium DevTools UI artifact that filters the `Cookie` header from the Network tab display for WS upgrade requests (chromium issue 40701883), creating the false perception that the cookie was withheld when it is actually delivered over the wire. See `## Resolved Assumptions` for the full research finding.
> **Replaced with:** The root cause of the freeze is **unknown**. The SameSite=Strict cookie hypothesis is refuted — the WS upgrade should authenticate successfully. The polling fix (change #1) is a pragmatic safety net that resolves the frozen-list symptom regardless of the actual cause. The root cause should be diagnosed by inspecting WS frames in the new window's devtools (Firefox recommended — it displays the `Cookie` header in WS upgrade requests, unlike Chromium which hides it). If the WS connects and `terminalsChanged` frames arrive but the list still doesn't update, the problem is in the client-side dispatch chain, not the WS transport.

The new window's WebSocket connection to `/ws` should authenticate and connect successfully (see Resolved Assumptions). If the list still freezes, the failure is elsewhere — possibly in the client-side message dispatch chain (`transport.js` → `dispatchMessage` → `window.dispatchEvent` → `terminals.js` listener), or in the wsHub's delivery logic, or in a race between the initial `fetchTerminalList()` and the first WS push. Without a polling fallback, any failure in this chain leaves the list frozen at the initial fetch.

### Why the shell iframe doesn't hit this

Inside the shell iframe, the WebSocket connection is established during the initial page load and persists. The iframe's origin matches the server's origin, and the `sb_session` cookie is set during the shell's initial `/?token=...` navigation. The WebSocket upgrade from the iframe is a same-origin request with the cookie present, and the connection is long-lived. The `window.open` path also creates a same-origin context whose WS upgrade carries the same cookie (confirmed by research — see Resolved Assumptions), so the cookie is NOT the differentiator. If the freeze only occurs in the new window and not the iframe, the cause is something specific to the `window.open` lifecycle — possibly a timing issue with WS connection establishment, a difference in how the new window's `transport.js` initializes, or a wsHub connection-scoping difference.

## Metadata

**Tags:** frontend, bugfix, reliability
**Complexity:** 3
**Project:** browser-switchboard

## User Review Required

Yes — the root cause of the freeze is **unknown**. The SameSite=Strict cookie hypothesis was refuted by web research (see Resolved Assumptions). Before implementation, the user should diagnose the actual failure: open the popped-out window in Firefox devtools (recommended over Chromium — Chromium hides the `Cookie` header in WS upgrade display, a known DevTools UI artifact), inspect Network → WS frames to confirm whether the `/ws` connection establishes and whether `terminalsChanged` frames arrive. If the WS works and frames arrive but the list still doesn't update, the problem is in the client-side dispatch chain. The polling fix (change #1) resolves the symptom either way. The surface parameter fix (change #2) is independently valid regardless.

## Complexity Audit

### Routine
- Adding a `setInterval`-based poll mirrors the existing kanban poll pattern (`startKanbanPoll`/`stopKanbanPoll` at `terminals.js:2750-2758`) — same file, same idiom.
- The surface parameter fix is a one-line signature change in `LocalApiServer.ts:425` — add `surface` to the wrapper's parameter list and forward it.
- `fetchTerminalList()` is already idempotent (calls `renderSidebarList()` which diffs the DOM), so redundant poll calls when the WS is working are harmless.
- No new dependencies, no new APIs, no schema changes.

### Complex / Risky
- None

## Edge-Case & Dependency Audit

- **Race Conditions:** The poll calls `fetchTerminalList()` which is async. If a WS `terminalsChanged` push arrives while a poll-triggered fetch is in flight, both will call `renderSidebarList()` on completion. This is safe — `renderSidebarList()` is idempotent and the last writer wins with the same data. The kanban poll has the same concurrency pattern.
- **Security:** The surface parameter fix changes which WS connections receive `terminalsChanged`. Verified safe: only `terminals.js` handles `terminalsChanged` (confirmed via grep across all `*.js` files). The terminals panel declares `surfaces=terminals,common` (`transport.js:97`), so it still receives the push after the fix. Other panels (kanban, setup, design, etc.) no longer receive `terminalsChanged`, which is correct — they never handled it. The shell page (`shell.html`) has no `data-panel` attribute and does not load `transport.js`, so it has no WS connection and is unaffected.
- **Side Effects:** The surface fix stops `terminalsChanged` from being broadcast to all WS connections. This is a behavior change for non-terminals panels — they will no longer receive `terminalsChanged` messages. Since no other panel handles this message type, the only observable effect is fewer WS frames in other panels' devtools (a improvement, not a regression).
- **Dependencies & Conflicts:** The `setBroadcastWs` wrapper at `LocalApiServer.ts:425` is the only call site that wires the terminal WS gateway's broadcast into the hub. The fix is localized to this one wrapper. No other code calls `setBroadcastWs` or depends on the surface being dropped. The `terminalWsGateway.ts:362` `setBroadcastWs` signature already accepts `(verb, payload, surface?)` — the gateway was always passing `surface`, the wrapper was always dropping it.

## Dependencies

- None

## Adversarial Synthesis

Key risks: (1) the root cause is **unknown** — the SameSite=Strict cookie hypothesis was refuted by web research, but the polling fix resolves the symptom regardless; (2) stale line numbers in the original plan would have sent the implementer to wrong code — corrected in this revision; (3) the surface fix is independent of the freeze and should not be framed as contributing to its resolution; (4) the polling fix masks the real failure — if the WS is actually working but the dispatch chain is broken, the poll hides a deeper bug. Mitigations: line numbers corrected to current file state, root cause documented as unknown with a diagnostic step in the verification plan, surface fix clearly labeled as a separate correctness improvement, and manual test #7 made mandatory to diagnose the actual failure mode.

## Proposed Changes

### 1. `src/webview/terminals.js` — Add a terminal list poll

Add a polling mechanism for the terminal fleet list, mirroring the existing kanban poll pattern. The poll is lightweight — a single `fetchTerminalList()` call — and runs at a 5-second cadence. It starts after `init()` completes and skips ticks when the page is hidden (to avoid hammering the server on background tabs).

In `init()`, after the solo/non-solo `fetchTerminalList()` block (after line 595, the closing `}` of the `if (soloTerminalName) { ... } else { ... }` block), start the poll:

```javascript
// After the existing fetchTerminalList() calls in init() (both solo and non-solo paths):
startFleetPoll();
```

Add the poll functions near the kanban poll functions (around line 2755, after `stopKanbanPoll`):

```javascript
let fleetPollTimer = null;

function startFleetPoll() {
    if (fleetPollTimer) { return; }
    fleetPollTimer = setInterval(() => {
        // Skip when the tab is hidden — the WebSocket push will catch up on
        // regain, and a background tab hammering ptyListTerminals wastes a
        // server slot per hidden panel. The poll is a fallback for when the
        // WebSocket is dead, not a replacement for it.
        if (document.visibilityState === 'hidden') { return; }
        fetchTerminalList();
    }, 5000);
}

function stopFleetPoll() {
    if (fleetPollTimer) {
        clearInterval(fleetPollTimer);
        fleetPollTimer = null;
    }
}
```

The poll is intentionally simple — it calls the same `fetchTerminalList()` that the WebSocket push handler calls. If the WebSocket is working, the poll is redundant but harmless (the server returns the same data, and `renderSidebarList()` is idempotent). If the WebSocket is dead (the new-window case), the poll keeps the list fresh.

Note: `stopFleetPoll()` is defined for API symmetry with `stopKanbanPoll()` but is not called in this change — the fleet list is always relevant for the page's lifetime, and the browser cleans up the interval on page unload. This mirrors the kanban poll's lifecycle (stopped only when kanban panes are removed, not on unload).

### 2. `src/services/LocalApiServer.ts` — Pass `surface` through `setBroadcastWs` wrapper

This is a **standalone correctness fix**, independent of the freeze. The freeze is addressed by the polling fallback in change #1. This fix stops `terminalsChanged` from being broadcast to every WS connection (kanban, setup, design, etc.) and delivers it only to connections that subscribed to the `terminals` surface.

Fix the wrapper at line 425 to pass the `surface` parameter through:

```typescript
// Before:
(this._options.terminalWsGateway as any).setBroadcastWs?.((verb: string, payload: any) => {
    this.broadcastWs(verb, payload);
});

// After:
(this._options.terminalWsGateway as any).setBroadcastWs?.((verb: string, payload: any, surface?: string) => {
    this.broadcastWs(verb, payload, surface);
});
```

This ensures `terminalsChanged` is tagged with `surface='terminals'`, so the wsHub's surface filter delivers it only to terminals panel connections (not kanban, setup, design, etc.).

With this fix, the surface filter in `wsHub.broadcast()` will work as designed:
- Terminals panel connections (`surfaces=terminals,common`) receive `terminalsChanged`
- Kanban panel connections (`surfaces=kanban,common`) do NOT receive `terminalsChanged`
- Undeclared connections (`surfaces=undefined`, e.g. older clients) still receive it (fail-open)

Verified safe: `terminalsChanged` is only handled in `terminals.js:526` — no other panel's JS handles this message type. The shell page has no WS connection (does not load `transport.js`).

## Resolved Assumptions

The following external uncertainty was investigated via web research and is now **resolved**. Treat as authoritative — do not re-open.

1. **SameSite=Strict cookie behavior on same-origin WebSocket upgrades from `window.open`-ed pages — RESOLVED (refuted).** Web research (RFC 6265bis, RFC 6455, Chromium/Firefox/WebKit bug trackers, 50+ sources) confirms that `SameSite=Strict` cookies ARE reliably sent on same-origin WebSocket upgrade requests from `window.open`-ed pages in all modern browsers (Chrome, Firefox, Safari, Edge). The `sb_session` cookie (`SameSite=Strict; HttpOnly; Path=/`) is sent on the WS upgrade to `/ws` from the same-origin `/terminals` page. The cookie's `Path=/` matches `/ws`, the origin matches, and the site-for-cookies evaluation passes. The `HttpOnly` flag does not interfere — it blocks `document.cookie` access but not the browser's network stack. The original SameSite=Strict hypothesis was likely based on a Chromium DevTools UI artifact (chromium issue 40701883) that filters the `Cookie` header from the Network tab display for WS upgrade requests, creating the false perception that the cookie was withheld. **Conclusion: the freeze is NOT caused by SameSite=Strict cookie withholding. The root cause is unknown and should be diagnosed via WS frame inspection (Firefox devtools recommended).**

## Verification Plan

### Automated Tests

No automated tests or compilation steps are run as part of this verification plan (per session directives). The existing test suite (`shell-terminal-strip.test.js`, `terminal-rename-rekey-contract.test.js`) references `terminalsChanged` handling and should be checked manually for regressions if the test infrastructure is available.

### Manual Tests

1. **New window updates:** Open the terminals panel in the shell. Click "New Window". In the new window, verify the sidebar list matches the shell. From the shell, create a new terminal (click "+ New", pick a role). Within 5 seconds, the new window's sidebar should show the new terminal — without reloading the page.
2. **Close propagates:** From the shell, close a terminal. Within 5 seconds, the new window's sidebar should remove it.
3. **Rename propagates:** From the shell, rename a terminal. Within 5 seconds, the new window's sidebar should show the new name.
4. **Background tab doesn't poll:** Open the new window, switch to another browser tab. Wait 10+ seconds. Switch back. The list should update on the next poll tick (within 5s), not during the hidden period. Verify via devtools network tab that no `ptyListTerminals` requests were made while hidden.
5. **Shell iframe still works:** Verify the shell's terminals panel sidebar still updates in real-time (WebSocket push, no 5s delay) when the WebSocket is working. The poll should be redundant but not cause double-flicker.
6. **Surface filter:** Open devtools in the kanban panel. Verify `terminalsChanged` messages do NOT appear in the kanban panel's WebSocket frames after the fix (they should be filtered out by the `surface='terminals'` tag).
7. **WS diagnosis (MANDATORY before implementation):** In the popped-out new window, open **Firefox** devtools (recommended over Chromium — Chromium hides the `Cookie` header in WS upgrade display due to a known DevTools UI artifact, chromium issue 40701883) → Network → WS. Inspect whether the `/ws` connection establishes and stays open, or fails/closes. If it connects, verify whether `terminalsChanged` frames arrive when terminals are created/closed/renamed in the shell. This determines whether the polling is a necessary fix (WS dead) or a harmless safety net (WS alive, dispatch chain broken). If the WS is alive and frames arrive but the list doesn't update, the bug is in the client-side dispatch chain and the polling fix masks a deeper issue — file a follow-up plan.

## Completion Report

Implemented the two changes in this plan. In `src/webview/terminals.js`, added a 5-second `startFleetPoll()` that calls `fetchTerminalList()` while the tab is visible, starting from `init()`; also defined `stopFleetPoll()` for symmetry. In `src/services/LocalApiServer.ts`, updated the `setBroadcastWs` wrapper to accept and forward the `surface` parameter so `terminalsChanged` is delivered only to `terminals` surface connections. No compilation or tests were run per the session directives. No issues were encountered; the edits applied cleanly and line numbers matched the plan.

## Review Findings

Independent reviewer pass completed. Both changes verified against plan requirements and full execution paths traced. **No CRITICAL or MAJOR findings.** Files changed: `src/webview/terminals.js` (fleet poll at lines 50, 2886–2903, call at 605), `src/services/LocalApiServer.ts` (surface forwarding at lines 425–426). TypeScript: 0 new errors (5 pre-existing TS2835 in unrelated files). Lint: 0 errors. Tests: 32 passed, 0 failed (`shell-terminal-strip.test.js` 24/24, `terminal-rename-rekey-contract.test.js` 8/8) — both wired in CI at `integration-tests.yml:112,399`. Regression analysis: `startFleetPoll` guard prevents double-interval on re-init; `fetchTerminalList` concurrency safe (idempotent `renderSidebarList`, last-writer-wins); surface fix traced end-to-end (`terminalWsGateway.ts:381` → `LocalApiServer.ts:426` → `wsHub.ts:316`); only `terminals.js` handles `terminalsChanged` (confirmed via grep). Remaining risk: the root cause of the WS freeze remains undiagnosed — the poll is a safety net, not a fix for the underlying transport issue; manual test #7 (Firefox devtools WS frame inspection) is still needed to determine whether the WS is dead or the dispatch chain is broken.
