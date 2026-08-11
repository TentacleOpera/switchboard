---
title: "Diagnose and fix the New Window WebSocket freeze root cause"
created: 2026-08-07T14:00:00Z
complexity: 6
tags: [frontend, backend, bugfix, reliability, test]
---

# Diagnose and fix the New Window WebSocket freeze root cause

## Goal

The "New Window" terminal sidebar freeze has a **polling safety net** (implemented in the sibling plan `feature_plan_20260806111214_new-window-sidebar-frozen.md`), but the **root cause is still unknown**. The polling mask means the operator sees a 5-second-laggy list instead of a frozen one, but the real-time WebSocket push path is still broken in the popped-out window. This plan diagnoses why and fixes it.

### Problem

When `window.open('/terminals', ...)` creates a popped-out terminal panel, the sidebar's terminal list loads correctly on first paint (the initial `fetchTerminalList()` HTTP call succeeds), but subsequent `terminalsChanged` WebSocket pushes never trigger a refresh. The shell iframe's sidebar updates in real-time — only the new window is deaf.

### Background — the full WS dispatch chain

The `terminalsChanged` push follows this path:

1. **Server:** `terminalWsGateway.initFleetListeners()` fires `this.broadcastWs('terminalsChanged', {}, 'terminals')` on every fleet event (`src/standalone/terminalWsGateway.ts:381`)
2. **Injection:** `LocalApiServer.setBroadcastWs` wrapper forwards to `this.broadcastWs(verb, payload, surface)` (`src/services/LocalApiServer.ts:425-428`)
3. **Hub:** `wsHub.broadcast('terminalsChanged', {}, 'terminals')` iterates `_connections`, skips connections whose declared surfaces don't include `'terminals'`, and sends `{type:'terminalsChanged', seq, surface:'terminals', payload:{}}` to each matching connection (`src/services/wsHub.ts:303-340`)
4. **Client transport:** `transport.js` WS `onmessage` parses the JSON envelope, unwraps it, and calls `dispatchMessage({type:'terminalsChanged', ...})` (`src/webview/transport.js:164-203`)
5. **Client dispatch:** `dispatchMessage` fires `window.dispatchEvent(new MessageEvent('message', { data }))` (`src/webview/transport.js:48-55`)
6. **Client handler:** `terminals.js` `window.addEventListener('message', ...)` checks `message.type === 'terminalsChanged'` and calls `fetchTerminalList()` (`src/webview/terminals.js:582-586`)

> **Superseded:** Step 6 cited `terminals.js:531-535`; step 4 cited `transport.js:164-207`; step 2 cited `LocalApiServer.ts:425-426`.
> **Reason:** `terminals.js` has drifted ~50 lines since this plan was written — 531-535 now lands inside the `#btn-open-all` / `#btn-save-group` button wiring, not the message listener. The other two were off by a line or two.
> **Replaced with:** message listener at `terminals.js:582-586` (inside `init()`); `ws.onmessage` at `transport.js:164-203`; the `setBroadcastWs` wrapper at `LocalApiServer.ts:425-428`.

The new window loads the same HTML (same `data-panel="terminals"` attribute stamped by `headlessPanelHtml.ts:410`), the same `transport.js` (injected by `injectTransportShim` at `headlessPanelHtml.ts:407`), and connects to the same `ws://127.0.0.1:PORT/ws?surfaces=terminals,common` URL. The CSP allows `ws://127.0.0.1:*` and `ws://localhost:*`. The WS auth (`wsUpgradeAuth.ts:79`) accepts either `?token=` query param or `sb_session` cookie — both are same-origin and should be present.

### What the code proves before any instrumentation runs

Six facts are established — Facts 1-4 by reading the source, Facts 5-6 by the web research recorded in `## Resolved Assumptions`. Together they eliminate most of the search space. Do **not** re-litigate them during implementation.

**Fact 1 — the WS upgrade request from a popout is byte-identical to the one from the shell iframe.** `wsUrl()` (`transport.js:106-128`) builds the URL from `window.location`, `window.__sbClientOriginatorId`, the live push scope, and `PANEL_SURFACES_MAP[document.body.dataset.panel]`. In both contexts `dataset.panel === 'terminals'` (the shim is injected immediately before `<script src=".../terminals.js">`, which sits at `terminals.html:1496`, i.e. at the end of `<body>` — so `document.body` exists when `connectWs()` runs at `transport.js:226`). Both send `surfaces=terminals,common`. The only differing field is the random `originatorId`, which the hub uses solely as a disconnect key. **Therefore the server cannot be treating the two connections differently, and the surface filter cannot be dropping the popout's push.**

**Fact 2 — the 5s fleet poll works in the popout, so the auth path works.** The sibling plan's `startFleetPoll()` (`terminals.js:3118-3128`) calls `fetchTerminalList()`, which POSTs `/terminals/verb/ptyListTerminals` (`terminals.js:807-846`). The operator reports this succeeds repeatedly. Under the standalone host `getAuthToken()` returns a real token, so `_checkAuth` (`LocalApiServer.ts:544-574`) requires the `sb_session` cookie on that POST — a working poll therefore *proves the cookie is present in the popout*. `authorizeWsUpgrade` accepts the same cookie (`wsUpgradeAuth.ts:79`). Under the extension host `getAuthToken()` returns `''` (`TaskViewerProvider.ts:2122-2124`; the panel is served there too when `ptyHostReady()` — `TaskViewerProvider.ts:2402`), and both `_checkAuth` and `authorizeWsUpgrade` then short-circuit to allow. **Auth cannot be the differentiator under either host.**

**Fact 3 — the client handler is registered long before any push can arrive.** `terminals.js` ends with `document.readyState === 'loading' ? addEventListener('DOMContentLoaded', init) : init()`, and the `window.addEventListener('message', ...)` arm is inside `init()`. `terminalsChanged` is only emitted by a *later* fleet event. There is no listener-registration race.

**Fact 4 — a reaped connection self-heals in ~500 ms.** `ws.onclose` (`transport.js:209-214`) nulls `ws` and calls `scheduleReconnect()`, whose first delay is `reconnectDelay = 500`. So even if the ping/pong reaper (`wsHub.ts:157-167`) terminated the popout's socket, the client reconnects half a second later and resumes. **A reap cannot produce a persistent freeze on its own.** Confirmed externally: `ws.terminate()` on a loopback socket delivers TCP RST/FIN synchronously, the client fires `close` with `code: 1006` / `wasClean: false`, and a half-open "deaf" client is not reachable over `127.0.0.1` — see `## Resolved Assumptions` #3.

**Fact 5 — the reaper cannot kill a throttled or frozen popout, because the pong is not JavaScript's job.** `wsHub`'s reaper calls `meta.ws.ping()`, an RFC 6455 protocol control frame (opcode `0x9`). Chromium answers those in the **Network Service process** (`net::WebSocketChannel`), Firefox in Necko — both entirely decoupled from the renderer's task queues. A throttled *or fully frozen* page still pongs. Only a **discarded** renderer stops, and discarding tears the socket down (producing a real close event, hence a reconnect). See `## Resolved Assumptions` #1. This is what finally kills Hypothesis A.

**Fact 6 — a fully occluded popup reads as `hidden`, which silently disables the sibling plan's poll.** Chromium's occlusion tracking marks a popup window whose pixels are fully covered by another OS window as `document.visibilityState === 'hidden'` (an *unfocused but visible* window stays `'visible'` and is not throttled). `startFleetPoll` skips its tick on exactly that condition (`terminals.js:3125`). So in the operator's actual usage pattern — pop the terminals window out, then work in the main browser window **in front of it** — the 5 s safety net stops running too, and the popout is frozen rather than laggy. See `## Resolved Assumptions` #2 and change #7.

Taken together: the failure is **not** surface filtering, **not** auth, **not** listener ordering, and **not** the reaper. What remains is a connection that the client believes is open — or is still trying to open — while the server has never placed it in `_connections`.

### Root Cause — unknown (hypotheses re-ranked against the six facts)

The freeze existed **before** the surface parameter fix (when `terminalsChanged` was broadcast to ALL connections with `surface=undefined`), so the surface filter is NOT the cause. The WS connection itself must be failing, or the client-side dispatch must be broken.

**Hypothesis E — the resync never resolves, so the connection never joins the broadcast set. Likelihood: HIGH.**

`wsHub.handleUpgrade` completes the socket upgrade, then `await`s `getFullState(meta.project)` **before** `this._connections.add(meta)` (`wsHub.ts:252-269`). The ordering is deliberate and documented (subscribe-after-snapshot, `wsHub.ts:244-251`), but it has an unguarded failure mode: there is **no timeout**. If `getFullState` never settles, the connection is open on the wire — the client's `ws.onopen` has already fired, because `_wss.handleUpgrade`'s callback receives an *already-upgraded* socket — but the server never adds it to `_connections`, so **every** subsequent `broadcast()` skips it, forever, with no close event and therefore no reconnect. That is the reported symptom exactly: HTTP fine, "connected" in the console, zero pushes, permanent.

The snapshot is expensive and DB-bound. In standalone it is `bootstrap.ts:419-439`: `getWorkspaceId()` → `buildBoardCards()` → `db.getProjects()` → `db.getWorktrees()`, four sql.js reads producing the full board (measured `GET /kanban/board` ≈ 84 ms / 124 KB). The browser cockpit already opens one connection per mounted panel iframe, so the popout is the **Nth** concurrent caller of that snapshot; sql.js is single-threaded WASM and the extension host's variant (`KanbanProvider.getFullStateMessages`, `KanbanProvider.ts:1124-1224`) adds `ensureReady()`, six more awaited reads and a `vscode.workspace.getConfiguration` call. A slow snapshot narrows the window; a stalled one closes it permanently.

**Discriminating observation:** the client logs `WebSocket connected` but **never receives a `__resync` frame** (and `sbTransportSubscribed` never fires), while `GET /ws/connections` omits the popout's `originatorId`. Nothing in the codebase logs either signal today, which is why this has stayed invisible.

**Hypothesis F — the upgrade handshake never completes, so the client sits in `CONNECTING` forever. Likelihood: HIGH.**

`wsHub.handleUpgrade` does `await authorizeWsUpgrade(req, () => this._options.getAuthToken())` **before** `this._wss.handleUpgrade(...)` writes the `101 Switching Protocols` response (`wsHub.ts:184-196`). Under the extension host `getAuthToken` is `this._context.secrets.get('switchboard.apiToken')` (`TaskViewerProvider.ts:2122-2124`) — a VS Code SecretStorage / keychain round-trip that can stall arbitrarily. Under standalone it is a closure over a constant, but `LocalApiServer`'s upgrade router awaits the whole thing either way (`LocalApiServer.ts:431-445`). If that await never settles, the TCP socket is connected, the HTTP Upgrade request has been sent, and **no 101 is ever written**.

**Chromium has no opening-handshake timeout.** It stays in `readyState === 0` (`CONNECTING`) indefinitely — no `open`, no `error`, no `close` — until the OS TCP timeout (minutes to hours) or an explicit `ws.close()` from JS (see `## Resolved Assumptions` #4; Firefox differs, timing out at 20 s via `network.websocket.timeout.open`). Nothing in `transport.js` ever calls `close()`, and `connectWs`'s `if (ws) { return; }` guard (`transport.js:142`) treats a `CONNECTING` socket as live, so **every** reconnect path — the backoff timer and the new triggers in change #3 — is blocked by the corpse. `scheduleReconnect` was never armed in the first place, because no `onclose` fired.

Result: permanent deafness with **zero console output** — no "connected", no error, no close. That is a strictly purer match for "loads on first paint then nothing, and the console says nothing" than Hypothesis E, which at least logs a connect.

**Discriminating observation:** the client logs `connecting …` and then **nothing at all**; `ws.readyState` is `0` when inspected from the console; the popout is absent from `GET /ws/connections`; and the same popout in **Firefox** self-heals after ~20 s while Chromium never does. That Chromium/Firefox asymmetry is a free, decisive test — no instrumentation required.

**Hypothesis A — WS connection drops silently and reconnect is throttled. Likelihood: REFUTED.**

> **Superseded (first pass):** "**Hypothesis A** … **Likelihood: HIGH** — this explains why the freeze is intermittent and why the shell iframe (always foreground) doesn't hit it." **Superseded (second pass):** the demotion to LOW, and its conditional fix (the original change #6, pong grace period), which was kept in the plan gated behind the decision table.
> **Reason:** Facts 4 and 5, the second now confirmed by external research. (a) The reaper pings with an RFC 6455 protocol control frame, and both Chromium and Firefox answer those from the **network stack**, not the renderer — a throttled *or fully frozen* popup still pongs, so the reaper never sees a missed pong to act on. The hypothesis' central mechanism does not exist. (b) Even granting a terminate, loopback delivers RST/FIN synchronously, the client fires `close` with `code: 1006`, and `scheduleReconnect()` restores the connection in 500 ms. The only state that does stop pongs is a **discarded** renderer, which tears the socket down and reloads the page on return — self-healing by construction.
> **Replaced with:** REFUTED, and **change #6 (pong grace period) is CUT from the plan.** It would have touched the keepalive lifecycle of every connection in both hosts to buy tolerance for a failure mode that cannot occur. Do not reintroduce it without new evidence of an actually-missed pong in the server log.

The wsHub ping/pong reaper (`wsHub.ts:157-167`) sends a ping every 30s and terminates connections that don't respond with a pong by the next tick. If the new window's browser tab is throttled (background tab), the browser may not process the pong fast enough and the server terminates the connection.

**Hypothesis B — WS connection never establishes. Likelihood: REFUTED.**

> **Superseded:** "**Likelihood: LOW** — research is clear, and the Origin check in `wsUpgradeAuth.ts` allows loopback origins."
> **Reason:** Fact 2 raises this from LOW to refuted on evidence internal to this repo, independent of the earlier RFC 6265bis research. Under standalone, the popout's *page load* and its *verb POSTs* both go through `_checkAuth`, which requires the same `sb_session` cookie that `authorizeWsUpgrade` checks — so a working poll is positive proof the cookie is delivered from the popout. Under the extension host the expected token is `''` and both guards allow unconditionally. The `Host` and `Origin` headers a popout sends are the same loopback values the iframe sends.
> **Replaced with:** REFUTED. Do not spend diagnostic effort here. The one residual: if `GET /ws/connections` shows the popout missing *and* the client never logged `WebSocket connected`, the upgrade genuinely failed and this reopens — capture the HTTP status line from the failed upgrade in that case.

The `sb_session` cookie is not sent on the WS upgrade from the `window.open`-ed page, or the Origin/Host check fails. Research refutes the SameSite=Strict cookie hypothesis (RFC 6265bis confirms same-origin WS upgrades carry the cookie).

**Hypothesis C — Client-side dispatch chain broken. Likelihood: LOW (downgraded).**

> **Superseded:** "**Likelihood: MEDIUM** — `dispatchMessage` has a try/catch that logs but continues, so errors would be visible in console."
> **Reason:** Fact 3 removes the script-load-order half of this hypothesis outright: the shim is injected at the end of `<body>` and `init()` runs on `DOMContentLoaded`, so the listener always predates any fleet-triggered push. The remaining half (a swallowed throw in `dispatchMessage`) would print `[transport] dispatchMessage failed` — a console line the operator has not reported seeing. This is worth *covering* with instrumentation, not worth *starting* from.
> **Replaced with:** LOW. The frame-received log in change #2 covers it for free: if the client logs receipt and the list still does not refresh, the break is downstream of `dispatchMessage` and Hypothesis C is live.

The WS connects and `terminalsChanged` frames arrive, but `dispatchMessage` → `window.dispatchEvent` → `terminals.js` listener fails.

**Hypothesis D — `getFullState` resync doesn't include terminal state.** On WS connect, the server sends a `__resync` with kanban board state only (`bootstrap.ts:419-439`). No `terminalsChanged` is in the resync payload. So the new window's terminal list depends entirely on the initial `fetchTerminalList()` HTTP call + subsequent WS pushes. If the WS is alive but no fleet event fires after connect, the list is correct but stale until the next event. This is not a bug — it's expected behavior — but it means the WS must be working for the list to stay fresh. **Likelihood: N/A** — this is the design, not a bug, but it explains why the freeze is only noticeable after a fleet change.

> **Superseded:** Hypothesis D cited `bootstrap.ts:355-380` and framed `getFullState` as inert with respect to the freeze ("this is the design, not a bug").
> **Reason:** Two errors. The citation points at `pushFullState` (the broadcast helper), not the resync provider — `getFullState` is at `bootstrap.ts:419-439`. More seriously, the framing treats `getFullState` as a payload question when it is also a **liveness** question: it sits on the critical path to joining `_connections` (`wsHub.ts:252-269`), so its *latency and failure behaviour* determine whether the connection ever receives anything at all. Reading D as "not a bug" is what kept Hypothesis E out of the original set.
> **Replaced with:** D's payload observation stands as written (correct, and it explains why the freeze is only visible after a fleet change). Its "inert" framing is superseded by Hypothesis E above, which is the same function examined for liveness rather than contents.

## Metadata

**Tags:** frontend, backend, bugfix, reliability, test
**Complexity:** 6
**Project:** browser-switchboard

> **Superseded:** `**Complexity:** 4`, and `tags: [frontend, bugfix, reliability, websocket]`.
> **Reason:** (a) The plan now carries a real behavioural change to a shared service — a bounded resync race with a late-snapshot ordering guard in `wsHub.handleUpgrade` — on top of instrumentation across four files, plus a runtime contract test and a new HTTP route. That is multi-file coordination around a documented ordering invariant, which is Medium, not Low. (b) `websocket` is not in the allowed tag vocabulary and would have been dropped or mis-parsed on import; `backend` and `test` are the accurate additions.
> **Replaced with:** Complexity 6 (top of Medium). Tags `frontend, backend, bugfix, reliability, test`.

## User Review Required

None. Two judgement calls are made here rather than deferred, both stated so they can be vetoed:

1. **No fix is applied on the strength of an untested hypothesis.** The original plan applied its instrumentation and its speculative fixes in one pass, which destroys the experiment: if the freeze disappears, nothing tells you which change fixed it, and the root cause stays unknown — the exact outcome this plan exists to end. Every change that survives here is justified by a *refuted-or-confirmed* fact rather than a hunch: changes #3, #4, #4b and #7 each close a code path that demonstrably produces permanent deafness or permanent staleness, independent of which one the operator is actually hitting. The one change that rested on a hunch — the pong grace period — is **cut**, because the research refuted its premise outright (Fact 5). The decision table (change #8) is what attributes the fix afterwards.
2. **All instrumentation is opt-in gated** (`SWITCHBOARD_WS_DEBUG` server-side, `?wsdebug=1` / `localStorage['sb-debug-ws']` client-side). Unconditional `console.log` on every broadcast is not shippable to ~4,000 installs, and the original plan's own Adversarial Synthesis already said so.

## Complexity Audit

### Routine
- Adding gated `console.log`/`console.warn` statements to `wsHub.ts` and `transport.js` — same-file, same-idiom additions.
- Adding a `/ws/connections` diagnostic endpoint to `LocalApiServer.ts` — mirrors the existing `/panels` manifest endpoint pattern (auth check → JSON body → `Cache-Control: no-store`).
- The reconnect-on-visibility-change fix mirrors the existing `document.visibilityState` check in the fleet poll (`terminals.js:3125`).
- The runtime contract test reuses a proven in-repo harness: `headless-feature-management-destructive.test.js:423-470` and `cross-client-scope-contract.test.js:231` already boot a real `LocalApiServer` with `getAuthToken: async () => ''` and drive real `ws` clients against it. No new test infrastructure.

### Complex / Risky
- **The bounded resync race (change #4) changes `handleUpgrade`'s ordering contract.** `wsHub.ts:244-251` carries an explicit comment explaining why the snapshot is sent before `_connections.add(meta)`: a delta sent during the await window would take `seq: 1`, then the hardcoded `seq: meta.seq` (0) on the resync would clobber the increment and the client would apply the older snapshot last. A timeout that lets the connection join early re-opens precisely that hazard for the late-arriving snapshot, so the late send **must** be guarded on `meta.seq === 0`. Get this wrong and you trade a permanent freeze for a silent staleness that is harder to see. `ws-surface-scoping-contract.test.js:64-76` pins the surrounding ordering and must stay green.
- **Bounding the pre-101 auth await (change #4b) sits on the auth gate.** Everything before `_wss.handleUpgrade` writes the 101 runs with the client's socket connected and no response sent, so the failure mode must be chosen deliberately: this refuses with 503 rather than failing open, because `wsHub`'s own doc comment (`wsHub.ts:16-20`) calls an unauthenticated upgrade path local RCE once terminal streams ride the hub. A well-meaning "fail open on timeout" here would be a security regression, not a resilience win.
- **The client handshake deadline (change #3a) is a timer that can `close()` a socket.** It must be cleared in `onclose` as well as `onopen`, or a timer left over from one attempt fires against its successor. It also sets a global 10 s ceiling on handshake latency for every panel in both hosts — comfortably above a loopback 101, but it is a new failure mode for a pathologically slow host.
- The keepalive lifecycle is **no longer touched** (change #6 cut), so `design-view-state-seats-contract.test.js:274` — which asserts a healthy client is never terminated — should pass unchanged. Treat any movement there as a regression from the `handleUpgrade` edits, not as an expected consequence.
- **Exposing hub internals must not widen the surface.** `LocalApiServer` deliberately has no public `wsHub` accessor. `DesignPanelProvider.setApiServer` (`DesignPanelProvider.ts:214-230`) does `if (server?.wsHub) { server.wsHub.onDisconnect(...) }` against an `_apiServer?: any`, so that whole branch is dead today and Design seats are never evicted on WS disconnect. Adding a public `wsHub` getter would silently **revive** it — a behaviour change to a shipped provider, against PRD contract #2 (byte-compatibility on ~4,000 installs). The diagnostic must go through a narrow, purpose-built method instead. Reviving the Design seat eviction may well be right, but it is a separate, deliberate plan — not a side effect of a diagnostic endpoint.

## Edge-Case & Dependency Audit

- **Race Conditions:** The diagnostic logging is write-only (no state changes), so no races. The reconnect triggers cannot double-connect: `reconnectIfDown` returns early on an armed `reconnectTimer` and on `readyState` OPEN or CLOSING, and on CONNECTING it calls `close()` and returns *without* opening a socket — the resulting `onclose` arms the single backoff path. Three listeners firing in the same tick (`pageshow` + `focus` + `visibilitychange` all fire on some restores) therefore collapse to one action. The handshake deadline is cleared in **both** `onopen` and `onclose`, so a stale timer can never `close()` a successor socket. The one substantive race is the resync: a `getFullState` that resolves *after* the timeout must not send a seq-0 `__resync` behind an already-delivered seq-1 delta; the `meta.seq === 0` guard is the fix and is the single most important line in change #4.
- **Security:** The `/ws/connections` diagnostic endpoint must be auth-gated (`_checkAuth`) like all other endpoints. It must not expose auth tokens or sensitive data — only connection count, originator IDs, surfaces, and ping/resync status. Note `originatorId` is client-supplied, so it must be treated as untrusted text on the way out (it is emitted inside a JSON string, which is safe; do not interpolate it into HTML). The declared `project` scope is a project name the caller already has access to. No cookie, header or token value may appear in the response or in any log line — `wsUrl()`'s `scope=` and any `token=` param must be redacted before logging the URL.
- **Side Effects:** The resync timeout trades one failure for a smaller one: on timeout the client joins the broadcast set but may receive **no** snapshot, so a panel whose mount-time state arrives only via resync (Setup — see the `sbTransportSubscribed` comment at `transport.js:180-186`) comes up empty rather than stale. The `meta.seq === 0` late-send keeps that to the genuinely-hung case, and `resyncFailed` in `/ws/connections` makes it visible rather than silent. The pre-101 timeout converts a silent hang into a visible `503` — a new close event clients did not previously see, which is the point. Change #7 adds one extra `ptyListTerminals` request per occlusion-to-visible transition in the terminals panel; the poll's hidden-tick skip already saves far more than that. Nothing here changes the keepalive lifecycle.
- **Dependencies & Conflicts:** `wsHub.ts` is shared by every panel and by the terminal gateway's broadcast wiring (`LocalApiServer.ts:425-428`); `transport.js` is shared by all nine panels. Both hosts route `/ws` through the same `LocalApiServer` upgrade router (`LocalApiServer.ts:431-445`), so a change here lands in the extension cockpit and standalone simultaneously. `ConnectionMeta` (`wsHub.ts:110-121`) gains optional fields only — no existing reader changes. No new npm dependencies.

## Dependencies

- None. `feature_plan_20260806111214_new-window-sidebar-frozen.md` — the polling safety net — is already implemented and is **context, not a dependency**: its poll is what keeps the popout usable while this diagnosis runs, and its Review Findings explicitly hand this plan the open question ("the root cause of the WS freeze remains undiagnosed").

## Adversarial Synthesis

Key risks: (1) the plan can go all-green without diagnosing anything — every log line can appear exactly as predicted and still leave the operator without a conclusion, which is why the decision table in change #8 is load-bearing and not documentation; (2) two independent code paths (a stalled resync and a stalled pre-101 auth await) each produce permanent deafness, and they are only distinguishable by whether the client ever logged `open` — conflate them and the wrong fix ships; (3) the bounded resync race trades a permanent freeze for a possible late-snapshot ordering clobber unless the late send is guarded on `meta.seq === 0`; (4) `isAlive` is the reaper's ping bookkeeping and is `false` for *every healthy connection* during part of each 30s window, so surfacing it under that name invites a false confirmation of the already-refuted Hypothesis A.

Mitigations: rename the field to `pingAcked` in the diagnostic response and document the window; gate all logging behind `SWITCHBOARD_WS_DEBUG` / `?wsdebug=1`; make the runtime contract test (change #1) the first thing run, so the server half is exonerated or convicted deterministically before anyone opens a browser; make the `connecting`-with-no-`open` line the explicit discriminator between the two stall paths, and cross-check it against Firefox (which self-heals a stalled handshake at ~20 s where Chromium never does); guard the late resync on `meta.seq === 0`; expose hub state through a narrow `getWsConnectionInfo()` rather than a public `wsHub` getter that would revive `DesignPanelProvider`'s dead disconnect wiring; cut the keepalive change entirely rather than ship a global change for a refuted mechanism.

## Proposed Changes

Execute in order. Changes #1–#5 are the diagnosis and the one fix the code already justifies; #6 is gated on an observation; #7 is the rule that turns observations into a conclusion.

### 1. `src/test/ws-popout-broadcast-contract.test.js` — runtime two-connection discriminator (new file, run first)

Before instrumenting a browser, settle the server half deterministically. Two independent WS clients, both declaring `surfaces=terminals,common`, must each receive a `terminalsChanged` broadcast tagged `'terminals'`. If they do, the hub and the surface filter are exonerated and the search collapses to the browser. If they don't, you have a server bug reproducible without a browser at all.

Reuse the existing harness shape (`headless-feature-management-destructive.test.js:423-470`): construct a real `LocalApiServer` with `port: 0`, `getAuthToken: async () => ''` (the proven in-repo loopback-trust pattern, not a hand-rolled bypass), `await server.start()`, then connect real `ws` clients to `ws://127.0.0.1:${port}/ws?surfaces=terminals,common&originatorId=...`.

Assert four things:

1. **Both clients receive the broadcast.** Connect A and B, wait for both `__resync` frames, then `server.broadcastWs('terminalsChanged', {}, 'terminals')` and assert both clients see a frame with `type === 'terminalsChanged'` and `surface === 'terminals'`.
2. **A connection joins the broadcast set even when its snapshot is slow.** Supply `getFullState: async () => { await sleep(1500); return [{ type: 'seed', surface: 'kanban' }]; }` and assert that a `terminalsChanged` broadcast issued **2 s after** `onopen` still reaches the client. This is the direct regression guard for change #4.
3. **A connection whose snapshot never settles still joins the broadcast set.** Supply `getFullState: () => new Promise(() => {})` (never resolves) and assert the client still receives a `terminalsChanged` broadcast issued after the timeout elapses. **At HEAD this test FAILS** — that failure *is* the reproduction of Hypothesis E in-process, and its transition to green is what change #4 buys. Author it as an explicit expected-failure-at-HEAD case so the pre/post signal is unambiguous.
4. **A late snapshot never clobbers a delivered delta.** With a slow `getFullState`, issue a broadcast during the await window, then let the snapshot resolve, and assert the client never receives a `__resync` with `seq: 0` after a frame with `seq: 1`.

Keep the file's shape consistent with the sibling contract tests: `let passed = 0; let failed = 0;`, a local `test(name, fn)` helper, and a non-zero exit on failure. Add an `npm` script alongside the other `test:contract:*` entries and register it in `.github/workflows/integration-tests.yml` next to the existing WS contract tests.

### 2. `src/webview/transport.js` — gated client-side WS lifecycle logging

Add a debug gate and logging to `connectWs`, `onopen`, `onmessage`, `onerror`, `onclose`, and `scheduleReconnect`, so the WS lifecycle is readable from the new window's devtools console.

At the top of the IIFE, beside the other module-level state:

```javascript
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
```

`wsUrl()` carries the declared project scope and could one day carry a token, so log a redacted form rather than the URL:

```javascript
    function wsUrlForLog() {
        try {
            const u = new URL(wsUrl(), window.location.href);
            if (u.searchParams.has('token')) { u.searchParams.set('token', '<redacted>'); }
            if (u.searchParams.has('scope')) { u.searchParams.set('scope', '<scope>'); }
            return u.toString();
        } catch { return '<unparseable>'; }
    }
```

In `connectWs` (before `new WebSocket(...)` at line 144):
```javascript
        wsLog('connecting', wsUrlForLog());
```

In `ws.onopen` (line 151) — this is an **edit**, not an addition: the line already logs `'[transport] WebSocket connected'` with no URL and no gate. Replace it so the one always-on line becomes the gated, informative one, and keep a single ungated line for the reconnect case only:

> **Superseded:** "In `ws.onopen` (line 151): `console.log('[transport] WebSocket connected to', wsUrl());` // ... existing code ..."
> **Reason:** `transport.js:152` already contains `console.log('[transport] WebSocket connected')`. Written as an addition this produces two near-identical connect lines per panel per connect — nine panels in the cockpit, on every reconnect.
> **Replaced with:** an edit of the existing line, plus the redacted URL, plus the debug gate.

```javascript
        ws.onopen = function () {
            wsLog('open', wsUrlForLog());
            if (isReconnecting) { /* ... existing sbTransportReconnected dispatch ... */ }
            isReconnecting = true;
            reconnectDelay = 500;
        };
```

In `ws.onmessage`, log the envelope header for every frame **and** call out the resync explicitly. The resync line is the single highest-value signal in this whole plan: it is the only client-observable proof that the server reached `_connections.add(meta)`. Its absence, with `open` logged, is Hypothesis E confirmed.

```javascript
            wsLog('frame', msg.type, 'seq=' + msg.seq, 'surface=' + (msg.surface || '<untagged>'));
```
and inside the `msg.type === '__resync'` branch, before dispatching:
```javascript
            wsLog('RESYNC received — this connection is in the hub broadcast set',
                Array.isArray(msg.payload) ? msg.payload.length + ' messages' : typeof msg.payload);
```

In `ws.onerror` (line 205) — keep it ungated (an error is worth hearing about) but add the redacted URL:
```javascript
        ws.onerror = function (err) {
            console.error('[transport] WebSocket error:', err, 'url=', wsUrlForLog());
        };
```

In `ws.onclose` (line 209) — the close **code** and `wasClean` are what distinguish a server `terminate()` (abnormal, code 1006) from a graceful close, which is the difference between Hypothesis A and everything else:
```javascript
        ws.onclose = function (ev) {
            console.warn('[transport] WebSocket closed:',
                'code=' + (ev && ev.code), 'reason=' + ((ev && ev.reason) || ''),
                'wasClean=' + (ev && ev.wasClean));
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
        wsLog('reconnect scheduled in', reconnectDelay, 'ms');
        reconnectTimer = setTimeout(function () {
            reconnectTimer = null;
            reconnectDelay = Math.min(reconnectDelay * 2, maxReconnectDelay);
            connectWs();
        }, reconnectDelay);
    }
```

**Clarification (not a new requirement):** `intentionallyClosed` is declared at line 62 and read at line 211 but never assigned `true` anywhere in the file. The `if (!intentionallyClosed)` guard is therefore always taken. Leave it alone — it is a harmless placeholder and touching it is out of scope — but do not read it as evidence of an intentional-close path that could suppress a reconnect.

### 3. `src/webview/transport.js` — handshake deadline, and reconnect on visibility change / pageshow / focus

Two parts, and part (a) is the fix for Hypothesis F. Both are **unconditional** — each is correct independently of the diagnosis.

**(a) Client-side handshake deadline.** Chromium never times out an opening handshake (Resolved Assumption #4), so a socket whose 101 never arrives sits in `CONNECTING` forever and, because `connectWs`'s `if (ws) { return; }` guard treats it as live, blocks every reconnect path permanently. The server cannot fix this — only the client can give up. In `connectWs`, after the `new WebSocket(...)` succeeds:

```javascript
        // Chromium has NO opening-handshake timeout: a server that accepts the TCP
        // connection and then never writes `101 Switching Protocols` leaves this
        // socket in CONNECTING with no open/error/close event until the OS TCP
        // timeout (minutes to hours). `connectWs`'s `if (ws) return` guard then reads
        // that corpse as a live connection and blocks every reconnect trigger below.
        // Firefox self-heals here at ~20s (network.websocket.timeout.open); Chromium
        // needs this. close() on a CONNECTING socket fires onclose, which arms the
        // normal backoff — so this is the whole recovery path, not just a tidy-up.
        const handshakeDeadline = setTimeout(function () {
            if (ws && ws.readyState === 0 /* CONNECTING */) {
                console.warn('[transport] WebSocket handshake did not complete in '
                    + HANDSHAKE_TIMEOUT_MS + 'ms — abandoning and retrying');
                try { ws.close(); } catch { /* fall through to onclose */ }
            }
        }, HANDSHAKE_TIMEOUT_MS);
```
Clear it in **both** `onopen` and `onclose` (not only `onopen` — a socket that closes for an unrelated reason must not leave a live timer that later calls `close()` on its successor):
```javascript
        ws.onopen = function () { clearTimeout(handshakeDeadline); /* ... */ };
        ws.onclose = function (ev) { clearTimeout(handshakeDeadline); /* ... */ };
```
with `const HANDSHAKE_TIMEOUT_MS = 10000;` beside `maxReconnectDelay`. 10 s is comfortably above a loopback 101 (sub-millisecond) and below Firefox's 20 s, so behaviour converges across browsers.

**(b) Reconnect triggers.** A socket that closed while the window was hidden currently waits out an exponential backoff that may already have grown to 30 s (`maxReconnectDelay`), so the operator's first half-minute back is stale even when everything else works.

`visibilitychange` alone is not enough, though not for the reason first assumed: this popout keeps a live `window.opener` (read at `terminals.js:342-344`), which makes it **bfcache-ineligible**, so `pageshow`/`persisted` never fires for it. The listener stays because it costs nothing and does cover the direct-navigation `/terminals` case, but the load-bearing trigger is `visibilitychange` for **occlusion** transitions (Fact 6) plus `focus` for a window raised without a visibility change.

After the `connectWs()` call at line 226:

```javascript
    // Guard rationale: `reconnectTimer` covers an already-armed retry. `ws` is
    // checked by READYSTATE, not truthiness — a socket stuck in CONNECTING (see the
    // handshake deadline above) must be treated as dead and replaced, which a bare
    // `if (ws) return` would refuse to do. OPEN (1) and CLOSING (2) are left alone:
    // OPEN needs nothing, and CLOSING will fire onclose and arm the backoff itself.
    function reconnectIfDown(why) {
        if (reconnectTimer) { return; }
        if (ws && (ws.readyState === 1 || ws.readyState === 2)) { return; }
        if (ws && ws.readyState === 0) {
            wsLog('abandoning a stuck CONNECTING socket —', why);
            try { ws.close(); } catch { /* ignore */ }
            return; // onclose arms the backoff; do not open a second socket here
        }
        wsLog('reconnect now —', why);
        reconnectDelay = 500; // reset backoff: the environment just changed
        connectWs();
    }
    document.addEventListener('visibilitychange', function () {
        if (document.visibilityState === 'visible') { reconnectIfDown('became visible'); }
    });
    window.addEventListener('pageshow', function (ev) {
        reconnectIfDown(ev && ev.persisted ? 'pageshow (from bfcache)' : 'pageshow');
    });
    window.addEventListener('focus', function () { reconnectIfDown('window focus'); });
```

> **Superseded (first pass):** a single `visibilitychange` listener with the inline guard `if (document.visibilityState === 'visible' && !ws && !reconnectTimer)`. **Superseded (second pass):** the `reconnectIfDown` helper guarded as `if (ws || reconnectTimer) { return; }`, and the claim that `pageshow`/bfcache is a real trigger for this window.
> **Reason:** the second-pass guard was still wrong in the way that matters most. `ws` is non-null while a socket is stuck in `CONNECTING`, which is precisely Hypothesis F's state — so the helper written to heal a dead connection would have refused to touch the one dead connection that cannot heal itself. Truthiness is the wrong test; `readyState` is the right one. Separately, a popup holding a live `window.opener` is bfcache-ineligible, so the `persisted:true` path never runs here and must not be presented as the justification for the listener.
> **Replaced with:** part (a) (handshake deadline) plus the `readyState`-based `reconnectIfDown` above, with `pageshow` retained on honest grounds.

### 4. `src/services/wsHub.ts` — bound the resync so a stalled snapshot can never orphan a connection

This is the plan's one non-speculative server fix, and it closes the only code path that reproduces the reported symptom exactly (open socket, `onopen` fired, zero pushes, forever, no close event). Today `handleUpgrade` awaits `getFullState` with no timeout before `this._connections.add(meta)` (`wsHub.ts:252-269`); a snapshot that never settles means the connection never joins the broadcast set.

First extract the resync filter so the two send sites cannot drift:

```typescript
    private _filterResync(state: any, meta: ConnectionMeta): any {
        if (Array.isArray(state) && meta.surfaces) {
            return state.filter((item: any) => !item.surface || meta.surfaces!.has(item.surface));
        }
        return state;
    }
```

Then replace the resync block (`wsHub.ts:252-266`), keeping the subscribe-after-snapshot ordering for the healthy path and degrading to join-anyway on timeout:

```typescript
            // Subscribe-AFTER-snapshot stays the happy path (see the comment above:
            // a delta sent during the await window takes seq 1, and the resync's
            // hardcoded seq 0 would then clobber it). But the await was UNBOUNDED: a
            // getFullState that never settles left the socket open, `onopen` already
            // fired client-side, and the connection permanently outside
            // `_connections` — every broadcast skipped, no close event, so no
            // reconnect either. That is the New Window freeze signature.
            if (this._options.getFullState) {
                const snapshot = Promise.resolve()
                    .then(() => this._options.getFullState!(meta.project));
                let timer: NodeJS.Timeout | undefined;
                const timeout = new Promise<never>((_resolve, reject) => {
                    timer = setTimeout(
                        () => reject(new Error(`resync exceeded ${RESYNC_TIMEOUT_MS}ms`)),
                        RESYNC_TIMEOUT_MS
                    );
                });
                try {
                    const state = await Promise.race([snapshot, timeout]);
                    this._safeSend(ws, {
                        type: '__resync',
                        seq: meta.seq, // 0 — the baseline; broadcasts increment from here
                        payload: this._filterResync(state, meta),
                    });
                } catch (err) {
                    console.error('[wsHub] resync did not complete — joining the broadcast set anyway:', err);
                    meta.resyncFailed = true;
                    // A LATE snapshot may still be useful, but only while nothing has
                    // been sent on this connection: a seq-0 __resync arriving behind a
                    // seq-1 delta is exactly the clobber the ordering comment warns
                    // about, and the client would apply the older state last.
                    snapshot.then((state) => {
                        if (meta.seq !== 0) { return; }
                        meta.resyncFailed = false;
                        this._safeSend(ws, {
                            type: '__resync',
                            seq: 0,
                            payload: this._filterResync(state, meta),
                        });
                    }).catch(() => { /* the race already logged it */ });
                } finally {
                    // Mirrors LocalApiServer.start()'s race — an un-cleared timer keeps a
                    // 5s handle alive per connection and fires a no-op reject later.
                    if (timer) { clearTimeout(timer); }
                }
            }

            // Join the broadcast set — now unconditional.
            this._connections.add(meta);
```

Add the constant near the top of the module and the two optional fields to `ConnectionMeta` (`wsHub.ts:110-121`):

```typescript
/** Upper bound on the connect-time snapshot. Generous on purpose: the standalone
 *  snapshot is four sql.js reads producing the whole board (~84ms measured, and the
 *  cockpit opens one connection per mounted panel, so the Nth caller queues behind
 *  the others). This is a stall backstop, not a latency budget. */
const RESYNC_TIMEOUT_MS = 5000;
```
```typescript
    /** True when the connect-time snapshot timed out and no late snapshot was
     *  eligible. Surfaced by getConnectionInfo() — a client in this state is
     *  subscribed but never received a baseline. */
    resyncFailed?: boolean;
```

Also add gated connection-lifecycle logging. Gate on an env var, not unconditionally — the hub broadcasts on every board mutation, and the standalone console is the operator's only console:

```typescript
const WS_DEBUG = process.env.SWITCHBOARD_WS_DEBUG === '1';
function wsDebugLog(msg: string): void { if (WS_DEBUG) { console.log(`[wsHub] ${msg}`); } }
```

After `this._connections.add(meta)`:
```typescript
            wsDebugLog(`connection established: originatorId=${originatorId || 'unknown'}, `
                + `surfaces=${surfaces ? [...surfaces].join(',') : 'all'}, `
                + `scope=${initialScope === undefined ? 'undeclared' : initialScope === null ? 'null' : initialScope}, `
                + `resyncFailed=${meta.resyncFailed === true}, total=${this._connections.size}`);
```

Inside `handleDisconnect` (`wsHub.ts:271-280`), inside the `if (this._connections.has(meta))` branch so it logs once rather than on both `close` and `error`:
```typescript
                    console.warn(`[wsHub] connection closed: originatorId=${meta.originatorId || 'unknown'}, `
                        + `surfaces=${meta.surfaces ? [...meta.surfaces].join(',') : 'all'}, `
                        + `remaining=${this._connections.size}`);
```
Keep this one ungated: a disconnect is rare and is the event Hypothesis A turns on.

In the ping/pong reaper (`wsHub.ts:157-167`), when terminating:
```typescript
                    if (meta.isAlive === false) {
                        console.warn(`[wsHub] reaping connection with no pong: originatorId=${meta.originatorId || 'unknown'}, `
                            + `surfaces=${meta.surfaces ? [...meta.surfaces].join(',') : 'all'}`);
                        try { meta.ws.terminate(); } catch { /* ignore */ }
                    }
```

In `broadcast`, log only the verb under investigation, and only when gated:
```typescript
            if (WS_DEBUG && verb === 'terminalsChanged') {
                wsDebugLog(`-> terminalsChanged to originatorId=${meta.originatorId || 'unknown'}, seq=${meta.seq + 1}`);
            }
```
Place it immediately before `meta.seq += 1;` and log `meta.seq + 1` so the logged value matches the frame actually sent.

> **Superseded:** the original change #1 also proposed re-writing the surface-filter skip as `if (surface && meta.surfaces && !meta.surfaces.has(surface)) { /* comment */ continue; }` under the heading "add a debug log when a connection is skipped by surface filter".
> **Reason:** that block is byte-identical to the code already at `wsHub.ts:316-318` and adds no log — it is a no-op edit that reads as a change. The skip path is also the wrong place to instrument: the popout declares `terminals`, so it can never be filtered out, and logging every skip means a line per non-terminals connection per push.
> **Replaced with:** nothing — the block is dropped. The delivery-side log above carries the whole signal, and its absence for a given `originatorId` is what "skipped or absent" looks like.

### 4b. `src/services/wsHub.ts` — bound the pre-101 auth await (Hypothesis F, server side)

Change #3a stops the *client* hanging forever. This stops the *server* creating the condition. Everything before `this._wss.handleUpgrade(...)` runs while the client has an open TCP socket and no response, and the one await there is `authorizeWsUpgrade`, whose `getAuthToken` is a VS Code SecretStorage round-trip under the extension host (`TaskViewerProvider.ts:2122-2124`). An unbounded await there is an unbounded `CONNECTING` state for the browser.

In `handleUpgrade`, replace the bare await (`wsHub.ts:184`):

```typescript
        // A stalled token read must become a 503 the client can see, never silence.
        // Below this line the socket is connected with no HTTP response written, and
        // Chromium will wait in CONNECTING indefinitely for one (Resolved Assumption
        // #4) — so failing loudly and fast is strictly better than failing open or
        // failing slow. Mirrors LocalApiServer.start()'s listen race.
        let auth: { authorized: boolean; statusCode?: number; reason?: string };
        try {
            auth = await withTimeout(
                authorizeWsUpgrade(req, () => this._options.getAuthToken()),
                UPGRADE_AUTH_TIMEOUT_MS,
                'ws upgrade auth'
            );
        } catch (err) {
            console.error('[wsHub] upgrade auth did not settle — refusing the upgrade:', err);
            auth = { authorized: false, statusCode: 503, reason: 'Auth Unavailable' };
        }
```
with `const UPGRADE_AUTH_TIMEOUT_MS = 3000;` beside `RESYNC_TIMEOUT_MS`, and a small module-local helper (or the inline `Promise.race` + `finally { clearTimeout }` shape used in change #4 and at `LocalApiServer.ts:457-468`) — do **not** hand-roll a third variant of the race in this file.

Refusing rather than failing open is deliberate: this is the auth gate, and `wsHub`'s doc comment (`wsHub.ts:16-20`) states that an unauthenticated upgrade path is local RCE once terminal streams ride the hub. A 503 also gives the client a real close event, which arms the backoff — the opposite of the current silence.

### 5. `src/services/LocalApiServer.ts` + `src/services/wsHub.ts` — `GET /ws/connections`

A read-only endpoint returning the hub's connection roster, so the operator can answer "is the popout actually in the broadcast set?" without server logs. Paired with change #2's resync log, this is the discriminator for Hypothesis E: **socket open in the browser + `originatorId` absent from this list = the connection never joined.**

On `WsHub`, a narrow accessor. Note the field rename:

```typescript
    /**
     * Diagnostic roster. `pingAcked` is the reaper's bookkeeping, NOT "the socket is
     * open": it is set false on every ping and true on the pong, so it reads false
     * for a perfectly healthy connection for part of each interval. Do not diagnose
     * a dead connection from one false reading. Presence in this array is the
     * load-bearing fact — it means the connection is in the broadcast set.
     */
    public getConnectionInfo(): Array<{
        originatorId?: string; surfaces?: string[]; pingAcked?: boolean;
        project?: string | null; seq: number; resyncFailed?: boolean;
    }> {
        return Array.from(this._connections).map(m => ({
            originatorId: m.originatorId,
            surfaces: m.surfaces ? [...m.surfaces] : undefined,
            pingAcked: m.isAlive,
            project: m.project,
            seq: m.seq,
            resyncFailed: m.resyncFailed === true,
        }));
    }
```

> **Superseded:** the endpoint sketch read `Array.from(this._wsHub['_connections'] as Set<any>)` and reported the raw field as `isAlive`.
> **Reason:** two problems. (a) Bracket-indexing a private field is the kind of access the follow-up note in the original change #5 already flagged; the accessor form below is the one to write. (b) `isAlive` is the reaper's ping bookkeeping and is `false` for every healthy connection for part of each 30s window — an operator reading `isAlive: false` will "confirm" Hypothesis A from a value that means nothing of the kind. That is a metric that fakes a diagnosis.
> **Replaced with:** `WsHub.getConnectionInfo()` + `LocalApiServer.getWsConnectionInfo()`, with the field renamed `pingAcked` and documented, plus `resyncFailed`.

On `LocalApiServer`, a purpose-built forwarder beside `broadcastWs` (`LocalApiServer.ts:485-487`) — **not** a public `wsHub` getter:

```typescript
    /**
     * WS connection roster for diagnostics. Deliberately narrow rather than a public
     * `wsHub` getter: DesignPanelProvider.setApiServer does `if (server?.wsHub)
     * { server.wsHub.onDisconnect(...) }` against an `any`-typed field, so that branch
     * is dead today. Exposing `wsHub` would silently revive it and start evicting
     * Design seats on WS disconnect — a behaviour change to a shipped provider that
     * belongs in its own plan, not in a diagnostic endpoint.
     */
    public getWsConnectionInfo(): any[] {
        return this._wsHub ? this._wsHub.getConnectionInfo() : [];
    }
```

The route, added in `_handleRequest` beside the other GET diagnostics (`/panels`):

```typescript
        else if (pathname === '/ws/connections' && req.method === 'GET') {
            if (!await this._checkAuth(req, true)) {
                this._sendUnauthorized(res);
                return;
            }
            const connections = this.getWsConnectionInfo();
            res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
            res.end(JSON.stringify({ count: connections.length, connections }, null, 2));
            return;
        }
```

Route it *before* any catch-all panel/static branch, and confirm the path cannot be shadowed by the `/ws` upgrade router — it cannot: the upgrade router is a separate `'upgrade'` listener (`LocalApiServer.ts:431-445`) and matches `pathname === '/ws'` exactly, so a plain `GET /ws/connections` never reaches it.

### 6. ~~`src/services/wsHub.ts` — pong grace period~~ — **CUT**

> **Superseded:** the pong grace period, in both its original form (increment `missedPings`, terminate on the second miss) and the corrected form this pass first proposed (same, but re-pinging inside the grace window so the mercy is not cosmetic).
> **Reason:** the mechanism it tolerates does not exist. `wsHub`'s reaper pings with an RFC 6455 protocol control frame, and both Chromium and Firefox answer those from the network stack — a throttled *or fully frozen* popup still pongs, so there is no missed pong to grant grace for (Fact 5 / Resolved Assumption #1). The change would have altered the keepalive lifecycle of every WS connection in both hosts, doubling worst-case dead-socket detection from ~30 s to ~60 s, to buy tolerance for a failure mode that cannot occur. Applying it would also have been the one risky edit in this plan.
> **Replaced with:** nothing. Do not reintroduce without a server log showing an actually-missed pong (`[wsHub] reaping connection with no pong`, added in change #4) for a popout that was demonstrably alive. `ConnectionMeta.missedPings` is consequently **not** added; only `resyncFailed` is.

### 7. `src/webview/terminals.js` — refetch the fleet list when the popout stops being occluded

The sibling plan's 5 s poll is the safety net keeping the popout usable, and it skips its tick on `document.visibilityState === 'hidden'` (`terminals.js:3125`). Fact 6 shows that condition is **true for a popout fully covered by another OS window** — which is the operator's normal working posture. So today the net has a hole exactly where it is needed, and the plan's own Goal ("the operator sees a 5-second-laggy list instead of a frozen one") is optimistic in the common case.

Do not remove the skip — polling a covered window is genuinely wasted work, and the reason given in that comment stands. Add the missing edge instead: fetch once on the transition back to visible.

In `init()`, beside the existing `window.addEventListener('focus', () => fetchKanbanColumnStructure(true))` (`terminals.js:632`):

```javascript
        // The poll skips hidden ticks, and Chromium reports a FULLY OCCLUDED popup
        // window as hidden — not just a background tab. So a popped-out panel sitting
        // behind the main browser window stops polling entirely, and its list is
        // frozen rather than 5s-stale. Catch up on the way back rather than removing
        // the skip: polling a covered window is still wasted work.
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible') { fetchTerminalList(); }
        });
```

This is a mask improvement, not the root-cause fix, and it is deliberately independent of it: if changes #3/#4/#4b resolve the WS path, this listener becomes redundant belt-and-braces; if they do not, it is what makes the popout usable. `fetchTerminalList` is idempotent (`renderSidebarList` diffs, last writer wins — established in the sibling plan's Edge-Case audit), so the extra call cannot conflict with an in-flight poll or push.

### 8. Decision table — observation → conclusion → action

The plan is not complete when the logs appear; it is complete when this table has been walked and one row selected. Record the selected row and the evidence in the Completion Report.

| Observation (client console + `GET /ws/connections`) | Conclusion | Action |
| :--- | :--- | :--- |
| Change #1's never-resolving-snapshot case **fails at HEAD** and passes after change #4 | Hypothesis E confirmed in-process | Change #4 is the fix. Ship #1–#5 and #7. Done. |
| `connecting` logged and then **nothing** — no `open`, no `error`, no `closed` — and `ws.readyState` reads `0` from the console | **Hypothesis F confirmed.** The 101 was never written | Changes #3a + #4b are the fix. Then find what stalled before the 101: the only await there is `authorizeWsUpgrade` → `getAuthToken`, i.e. VS Code SecretStorage under the extension host. File a follow-up if the keychain read is the stall. |
| Same popout self-heals in **Firefox** after ~20 s but never in Chromium | Hypothesis F, confirmed by the browser asymmetry alone | As above. Firefox's `network.websocket.timeout.open` (20 s) is doing what change #3a adds to Chromium — no further instrumentation needed to establish this. |
| `open` logged, **no `RESYNC received`**, popout's `originatorId` **absent** from `/ws/connections` | Hypothesis E confirmed in the real host | Change #4 is the fix. Capture which `getFullState` call stalled (add a temporary log at `bootstrap.ts:419` / `KanbanProvider.ts:1124`) and file a follow-up if the stall is a DB-layer bug rather than mere latency. |
| `open` + `RESYNC received` logged, `originatorId` **present**, server logs `-> terminalsChanged` for it, client logs no `frame terminalsChanged` | Frame lost in transport | Not a Switchboard bug at the hub layer. Capture `readyState` at send time and check for backpressure (`ws.bufferedAmount`); file a follow-up. |
| Client logs `frame terminalsChanged` but the sidebar does not refresh | Hypothesis C confirmed | Break is downstream of `dispatchMessage`. Instrument `terminals.js:582-586` and `fetchTerminalList` directly; file a follow-up. |
| Everything above is clean, but the list only goes stale while the popout sits **behind** the main browser window, and catches up when raised | Not a WS bug at all — occlusion (Fact 6) | Change #7 is the fix. The WS path was never broken in this scenario; the poll was silently skipping every tick. |
| `closed` / `connecting` / `open` cycling repeatedly | Reconnect loop, not a freeze | Read the close `code` and `reason`; new hypothesis, file a follow-up. Check the handshake deadline is not firing against a merely-slow server. |
| `originatorId` present, `resyncFailed: true` | Snapshot timed out but the connection is subscribed | Change #4 working as designed. Real-time pushes work; the connect-time baseline was lost. Investigate snapshot latency separately. |
| Server log shows `reaping connection with no pong` for a popout that was demonstrably alive | Contradicts Fact 5 / Resolved Assumption #1 | Do NOT reach for the cut grace period. A protocol pong that never arrives from a live renderer is a browser-level anomaly — capture the browser and version and file it as a new hypothesis. |
| No `connecting` line at all | `transport.js` never ran | Check the shim injection — `injectTransportShim` logs `transport shim NOT injected` when both anchors are missing (`headlessPanelHtml.ts:81`). |

## Resolved Assumptions

All five external uncertainties this plan opened were investigated by web research and are **resolved**. Treat as authoritative — do not re-open. Three of them changed the plan: #1 refuted Hypothesis A and cut a change, #2 produced Fact 6 and added change #7, #4 produced Hypothesis F and added changes #3a and #4b.

1. **Protocol ping/pong survives throttling and freezing — RESOLVED (refutes Hypothesis A).** A server-sent RFC 6455 `Ping` (opcode `0x9`) is answered automatically by the browser's network layer, not by JavaScript: Chromium handles control frames in the **Network Service process** (`net::WebSocketChannel` — `net/websockets/websocket_channel.cc`, `services/network/websocket.cc`), Firefox in the Necko stack (`netwerk/protocol/websocket/`). Both are decoupled from the renderer's task queues. So a **throttled** page pongs, and a **frozen** page (W3C Page Lifecycle, JS and DOM task queues fully suspended) still pongs — the socket and the network service remain live. Only a **discarded** renderer stops, and discarding destroys the Mojo channels and tears the socket down, which produces a real close event and a page reload on return. **Consequence:** `wsHub`'s reaper uses `meta.ws.ping()`, a protocol ping, so it can never see a missed pong from a live-but-hidden popout. Hypothesis A's mechanism does not exist; the pong grace period (former change #6) is cut. This applies *only* to protocol pings — an application-level JSON heartbeat requiring a JS reply **would** stall under throttling, so do not migrate the reaper to one.
2. **Unfocused-but-visible popups are not throttled; fully occluded ones are — RESOLVED (produces Fact 6).** A popup opened as `window.open(url, name, 'width=1200,height=800')` that is visible on screen but lacks OS focus reports `document.visibilityState === 'visible'` and `document.hasFocus() === false`. Chromium's budget-based throttling, M88+ chained-timer throttling and Page Lifecycle freezing all key on **visibility, not focus**, so such a window is treated as foreground and is *not* throttled. **But** Chromium's occlusion tracking (Windows and macOS) marks a popup whose pixels are **fully covered** by another OS window as `hidden`, and applies intensive throttling (1 s / 60 s clamping) after ~10 s. Firefox reports `'visible'` / `hasFocus() === false` likewise and clamps background timers on `visibilityState`, but does not implement equivalent OS occlusion tracking on all desktop platforms. **Consequence:** the original plan's HIGH ranking for Hypothesis A assumed the popout was a background tab; it is not. The real bite is that `startFleetPoll`'s `visibilityState === 'hidden'` skip (`terminals.js:3125`) fires for an occluded popout, so the safety net dies exactly when the operator works in front of it — change #7.
3. **`terminate()` on loopback reliably closes the client — RESOLVED (confirms Fact 4).** `ws.terminate()` calls `net.Socket.destroy()`, tearing down TCP with an RST/FIN and no RFC 6455 close handshake. The browser fires `close` (often preceded by `error`) with `code: 1006` (`ABNORMAL_CLOSURE`), `wasClean: false`, `reason: ''` (1006 is generated locally and never travels the wire). On `127.0.0.1` the RST/FIN is delivered synchronously by the OS stack in milliseconds, so the socket loop sees `ECONNRESET` immediately — a half-open "deaf" client is **not** reachable over loopback (that failure mode needs a physical network with middleboxes silently dropping packets). **Consequence:** a reap always arms `scheduleReconnect()`; Fact 4 holds.
4. **Chromium has no opening-handshake timeout — RESOLVED (produces Hypothesis F).** If the TCP connection is established and the HTTP Upgrade request sent, but the server never writes `101 Switching Protocols` and never closes: **Firefox** cancels the channel after `network.websocket.timeout.open` (default **20 s**), firing `error` then `close` with `code: 1006`. **Chromium has no such limit** — the WHATWG WebSockets standard defers the connection attempt to Fetch and leaves the timeout explicitly implementation-defined, and Chromium stays in `readyState === 0` (`CONNECTING`) indefinitely until the OS TCP read/keepalive timeout (minutes to hours) or an explicit JS `ws.close()`. **Consequence:** an unbounded await before `_wss.handleUpgrade` writes the 101 — which `wsHub.handleUpgrade` has, around `authorizeWsUpgrade` → `getAuthToken` — produces silent, permanent, event-free deafness in Chromium. `transport.js` never calls `close()` and its `if (ws) return` guard treats the stuck socket as live. Hence change #3a (client handshake deadline) and change #4b (bound the server-side await).
5. **bfcache does not apply to this popout; `visibilitychange` alone is insufficient — RESOLVED (validates change #3b's trigger set, on different grounds).** A popup that retains an active `window.opener` reference is **ineligible** for bfcache in both Chromium (`NotRestoredReason: RelatedActiveContentsExist` / `has_opener`) and Firefox; eligibility returns only if the relationship is severed (`rel="noopener"`, COOP, or `window.opener = null`). This popout reads `window.opener.document.body` (`terminals.js:342-344`), so it keeps the reference and **never** enters bfcache — the `pageshow` / `persisted:true` path does not fire for it. Separately, where bfcache *does* apply, browsers force-close open WebSockets on entry (client sees `1006` or `1001`) and JS cannot run until restore; on restore the order is `resume` → `pageshow` (`persisted:true`) → `visibilitychange` *only if* the visibility state actually transitioned. **Consequence:** `visibilitychange` alone is confirmed insufficient, so keeping all three listeners is right — but for this window the load-bearing triggers are `visibilitychange` (occlusion, per #2) and `focus`, **not** `pageshow`. The plan's earlier bfcache justification was wrong and is corrected in change #3.

## Verification Plan

### Automated Tests

Not run in this session — per the session directives, no compilation step and no automated test execution are part of this verification plan. The following are the gates a normal run would use, and change #1 authors a new one:

- `npm run compile` — TypeScript for `ConnectionMeta.resyncFailed`, `_filterResync`, `getConnectionInfo`, `getWsConnectionInfo`, the timeout helper and the new route. **Skipped this session.**
- `npm run test:contract:ws-popout-broadcast` (new, change #1) — the two-connection discriminator. **Authored, not executed this session.** Its never-resolving-snapshot case is expected to fail at HEAD and pass after change #4; that transition is the plan's primary evidence.
- `npm run test:contract:ws-surface-scoping` — the surface/ordering contract this change sits on top of (`ws-surface-scoping-contract.test.js:64-76` pins "the surface set is parsed BEFORE the resync is sent"). **Skipped this session.**
- `npm run test:contract:shell-terminal-strip` and `npm run test:contract:terminal-rename-rekey` — the existing terminal contracts. **Skipped this session.**
- `design-view-state-seats-contract.test.js` — exercises the reaper loop via `pingIntervalMs` and asserts a healthy client is never terminated. The reaper is **no longer touched** (change #6 cut), so this is a pure regression guard on the `handleUpgrade` edits rather than a gate on a keepalive change. **Skipped this session.**
- `npm run verb-returns:check`, `npm run parity:check`, `npm run push-routing:check` — no verb arms, allowlists or `postMessage` sites change here, so all three should be untouched. **Skipped this session.**

### Manual Tests

Run 1 before touching a browser. Enable instrumentation first: start the server with `SWITCHBOARD_WS_DEBUG=1`, and open the popout with `?wsdebug=1` (or set `localStorage['sb-debug-ws'] = '1'` and reload).

1. **Server half, no browser (change #1).** Run the new contract test. If cases 1, 2 and 4 pass and case 3 fails at HEAD, Hypothesis E is reproduced in-process and the diagnosis is essentially done — apply change #4 and confirm case 3 goes green. Only continue to the browser tests if case 3 already passes at HEAD (meaning the stall is real-host-specific) or if any other case fails.
2. **Connection registered, server side.** Start the standalone server. Open the terminals panel in the shell. Click "New Window". `[wsHub] connection established` should appear with `surfaces=terminals,common` and an incremented `total`. If it does not appear at all, note the client's console state and go to row 8 of the decision table.
3. **Connection registered, client side.** In the new window's devtools: `[transport:ws] connecting …` → `[transport:ws] open …` → `[transport:ws] RESYNC received …`. **The resync line is the test.** `open` without `RESYNC received` is Hypothesis E.
4. **Roster cross-check.** `GET http://127.0.0.1:PORT/ws/connections` (same browser session, so the cookie rides along). The popout's `originatorId` must be present. Present + no resync line = the resync send failed; absent + socket open in devtools = the connection never joined. Ignore `pingAcked` here — it is false for healthy connections for part of every 30 s window.
5. **Broadcast tracing.** From the shell, create a terminal. Server: `[wsHub] -> terminalsChanged to originatorId=…` should log for **both** the shell iframe's connection and the popout's. Client: `[transport:ws] frame terminalsChanged seq=N surface=terminals`. Then the sidebar should update **without waiting for the 5 s poll** — the poll is what makes a broken push path look merely laggy, so time the update: sub-second means the push worked, ~5 s means it did not.
6. **Reaper behaviour (expect nothing to happen).** Leave the popout **visible but unfocused** for 90 s, then **fully covered by the main browser window** for 90 s. Per Resolved Assumption #1 no `reaping` line should appear in either case — the pong comes from the network stack, not the renderer. A `reaping` line here contradicts the research and is a new finding, not a confirmation of Hypothesis A.
6b. **Occlusion kills the poll (change #7, Fact 6).** With the popout **fully covered** by the main browser window, create a terminal from the shell and wait 20 s. Before change #7 the popout's list does not update at all (the poll skips every hidden tick) and no `ptyListTerminals` request appears in its network tab. Raise the popout: with change #7 it must refetch immediately. This is the test that reproduces "frozen, not laggy" without any WS involvement — run it before concluding the WS is at fault.
7. **Handshake deadline (change #3a, Hypothesis F).** Temporarily stall the upgrade: in `wsHub.handleUpgrade`, `await new Promise(() => {})` before `authorizeWsUpgrade`. In **Chromium**, the popout must log `connecting`, then — with change #3a — `handshake did not complete in 10000ms`, then `closed`, then a retry; without it, `ws.readyState` sits at `0` forever with no further console output. In **Firefox** the same stall self-heals at ~20 s either way (`network.websocket.timeout.open`). Then verify change #4b turns the stall into a `503 Auth Unavailable` and a prompt client close. Revert the temporary edit.
7b. **Reconnect triggers (change #3b).** Kill the socket server-side (restart the server, or call `terminate()` on that connection). Confirm `closed code=1006`, then a `connecting`/`open`/`RESYNC received` sequence. Then occlude and raise the popout and confirm `reconnect now — became visible`; then focus another window and refocus and confirm `reconnect now — window focus` fires at most once per restore (the three listeners must collapse to one action, not three sockets — check `/ws/connections` count does not grow).
8. **Resync-timeout degradation (change #4).** Temporarily make `getFullState` hang (`return new Promise(() => {})` in `bootstrap.ts:419`). The popout must still show `open`, must log **no** `RESYNC received`, must appear in `/ws/connections` with `resyncFailed: true` after ~5 s, and must then receive `terminalsChanged` pushes normally. Revert the temporary edit.
9. **No regression in the shell iframe.** The shell's terminals panel sidebar must still update sub-second on a fleet change, the board must still populate from its resync, and the Setup panel — whose mount-time state arrives only via the resync path (`transport.js:180-186`) — must still come up populated.
10. **Logging is genuinely off by default.** Restart the server without `SWITCHBOARD_WS_DEBUG`, open the cockpit with no `?wsdebug=1` and no `localStorage` key, create and close terminals. The only WS lines in any console should be `error`, `closed`, `reaping` and `connection closed`. No per-frame and no per-broadcast lines.

## Recommendation

**Send to Coder** (Complexity 6).

## Completion Report

*(to be filled in after implementation — must record which decision-table row was selected and the evidence that selected it)*

## Review Findings

Changes #2, #3a, #3b, #4, #4b, #5 and #7 are all present and correct — notably `reconnectIfDown` keys on `readyState` rather than truthiness (the trap the second-pass callout flagged), the handshake deadline is cleared in both `onopen` and `onclose`, the late resync is guarded on `meta.seq === 0`, and `getWsConnectionInfo()` is a narrow forwarder rather than a public `wsHub` getter that would have revived `DesignPanelProvider`'s dead disconnect wiring. Change #1 was never authored: this review wrote `src/test/ws-popout-broadcast-contract.test.js` (5 runtime cases against a real `WsHub` and real `ws` clients) and wired `test:contract:ws-popout-broadcast` into `package.json` and `.github/workflows/integration-tests.yml` — a MAJOR gate hole, since it was the only regression guard on change #4. Verified it discriminates rather than merely describes: against HEAD's unbounded `wsHub.ts` cases 3 and 4 fail, and pass with the timeout applied, exactly the transition this plan predicted — so **decision-table row 1 is selected** (Hypothesis E reproduced in-process; change #4 is the fix). Files changed by this review: `src/test/ws-popout-broadcast-contract.test.js` (new), `package.json`, `.github/workflows/integration-tests.yml`, plus `protocol-catalog.json` regenerated for the new `/ws/connections` endpoint (74→75), which had left `catalog:check` red. Remaining risk: Hypothesis F is closed by construction (#3a/#4b) but never observed, and all browser-side manual steps (2–10) are unrun, so the `SWITCHBOARD_WS_DEBUG` / `?wsdebug=1` instrumentation has not been exercised against a live popout.
