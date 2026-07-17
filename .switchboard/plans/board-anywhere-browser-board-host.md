# Browser Board: Serve the Kanban Webview from LocalApiServer

## Goal

Serve the Kanban board as a live web page from LocalApiServer, so any agentic coding app user (Claude Code CLI, Codex, Cursor CLI, a plain terminal) can open the board in a browser without VS Code.

**Problem & background.** The board is currently visible only inside the VS Code webview. Users driving Switchboard from agentic coding apps over the local HTTP API work blind — they can mutate the board through verbs but cannot see it. The Host-Agnostic Verb Engine (A2b) removed the hard blocker: all kanban verbs are now allowlist-gated, schema-validated, and dispatched through a single host-neutral code path, which means a non-VS Code host can round-trip every board **command** over plain HTTP. A browser board is the first concrete second host for the webview and the practical payoff of that migration.

**Root cause of the gap.** `kanban.html` is coupled to the VS Code host through two seams, not one:
1. **Outbound (commands):** `acquireVsCodeApi()` (`kanban.html:3402`) + a `postKanbanMessage()` wrapper (`kanban.html:4388`) that calls `vscode.postMessage({ type, ... })`. The discriminator is `type`, and there are ~110 distinct outbound types plus 11 direct `vscode.postMessage` calls.
2. **Inbound (renders):** two `window.addEventListener('message', ...)` handlers (`kanban.html:6901` main switch ~55 cases, `kanban.html:10205` secondary) that consume host-pushed messages like `{ type: 'updateBoard', cards }` and `{ type: 'moveCards', sessionIds, targetColumn }`.

Everything else (markup, CSS, rendering, verb payload shapes) is host-neutral. The work is a **two-channel transport shim** (an outbound HTTP command channel + an inbound push channel), plus first-time static-asset serving and an auth gate — not a rewrite.

> **Superseded:** "coupled to the VS Code host through exactly one seam: `acquireVsCodeApi()` + `postMessage` outbound, and extension-pushed `message` events inbound."
> **Reason:** Framing it as "one seam" understated the design. The inbound render messages do **not** ride back on the command responses — they are broadcast out-of-band (see Implementation Step 3 / Proposed Changes). Outbound and inbound are two distinct transports that must be shimmed separately. Also the outbound discriminator is `type`, not `command` (0 uses of `command:`, 166 of `type:`), and sends go through the `postKanbanMessage()` wrapper, not raw `postMessage`.
> **Replaced with:** Two seams — an outbound command channel (`postMessage.type` → HTTP verb) and an inbound render channel (host push → WebSocket) — detailed below.

## Implementation Steps

1. **Static route + first-time static serving.** Add `GET /ui/board` to `LocalApiServer.ts`. **Note:** the server serves **zero** static assets today — every route returns `application/json` except the one generated-diagram PNG (`LocalApiServer.ts:2500-2540`). There is no static-file handler, no content-type-by-extension logic. So this step builds a small static handler (map `.html`/`.js`/`.css`/font/icon extensions → content-types) and routes for the assets the page needs, added as new `else if` branches in the manual path switch in `_handleRequest` (`LocalApiServer.ts:2684-2826`).

2. **Serve the HTML without forking it — replicate `_getHtml`'s token replacement.** The on-disk `kanban.html` is **not** directly servable: it contains `{{...}}` placeholder tokens (icons `{{ICON_*}}`, fonts `{{HANKEN_FONT_URI}}`/`{{GEIST_PIXEL_FONT_URI}}`, and a `<!-- SHARED_DEFAULTS_SCRIPT -->` marker) that `KanbanProvider._getHtml` (`KanbanProvider.ts:10517-10606`) rewrites at serve time through `webview.asWebviewUri(...)`, and it has **no** CSP/nonce on disk (both are injected by `_getHtml`). The HTTP route must run its own equivalent replacement pass, pointing the tokens at HTTP asset routes (step 1) instead of `vscode-webview://` URIs, and inject its **own** CSP suited to a browser (`connect-src 'self'` so fetch + WebSocket work; the webview CSP is `connect-src 'none'`, `KanbanProvider.ts:10544`, which would block the shim entirely). Keep `kanban.html` a single source: serve from the same resolved path `_getHtml` reads (dist → webview → src fallback, `KanbanProvider.ts:10518-10522`); do not fork the file.

   > **Superseded:** "Rewrite the webview resource URIs (the `vscode-webview://` asset scheme) to plain relative paths at serve time; do not fork the HTML file."
   > **Reason:** The disk file does not contain `vscode-webview://` URIs to rewrite — it contains `{{...}}` placeholder **tokens** that only `_getHtml` resolves (into `asWebviewUri` values), plus it has no CSP/nonce until `_getHtml` adds them. Simply swapping URI schemes would serve a page with unresolved `{{ICON_*}}` tokens, no fonts, no shared-defaults script, and a webview-only CSP.
   > **Replaced with:** Replicate `_getHtml`'s placeholder-replacement pass in the HTTP path (icons/fonts/sharedDefaults → HTTP asset routes), serve those assets via step 1, and inject a browser-appropriate CSP (`connect-src 'self'`). "Do not fork the file" still holds.

3. **Host shim — two channels.** Inject a small `browser-host-shim.js` only on the browser route (never in the VS Code webview build). It provides an `acquireVsCodeApi()`-compatible object:
   - **Outbound (command channel):** `postMessage(msg)` maps to `fetch('/kanban/verb/' + msg.type, { method: 'POST', body: JSON.stringify(msg), headers })`. This is a verified 1:1 mapping — `KanbanProvider.handleServiceVerb` does `this._handleMessage({ ...payload, type: verb })` (`KanbanProvider.ts:6911`), i.e. the HTTP verb name is injected as `msg.type` into the *same* `_handleMessage` switch the webview uses, and `KANBAN_VERBS` (145 names, `src/generated/verbAllowlist.ts:7`) is exactly the set of switch cases. No per-name mapping table is needed. The verb's `{ success, ... }` reply is used only for ack/error surfacing (e.g. `moveCardsFailed` handling), **not** to drive re-render.
   - **Inbound (render channel):** subscribe to the LocalApiServer WebSocket hub (`WsHub`) and dispatch each broadcast message to the page verbatim as a synthetic `window` `message` event. The hub already broadcasts the exact inbound vocabulary the page's handler switches on — `updateBoard`, `moveCards`, `updateColumns`, `liveSyncUpdate`, etc. — because the same `BroadcastHub.push` fan-out feeds both the VS Code webview and the WS hub (`broadcastHub.ts:63-85`, `mirrorToWs → apiServer.broadcastWs`). So the existing inbound handlers (`kanban.html:6901`, `:10205`) keep working **unmodified**. On load, seed the first render with `GET /kanban/board` (or rely on the hub's resync-on-connect via `getFullState`, `LocalApiServer.ts:279-284`).

   > **Superseded:** "its `postMessage({ command, ... })` maps to `fetch('/kanban/verb/<command>')` ... and dispatches the JSON body back to the page as a synthetic `message` event so existing response handlers keep working unmodified."
   > **Reason:** (a) the discriminator is `type`, not `command`. (b) The verb HTTP body is a `{ success, ...data }` **ack** (e.g. `moveCardForward` returns `{ success, movedSessionIds, targetColumn }`, `KanbanProvider.ts:7764`), not a render message. The `{ type: 'updateBoard', cards }` / `{ type: 'moveCards', ... }` messages the page needs to re-render are emitted as a **side effect** over the broadcast hub (`KanbanProvider.ts:7763` posts `moveCards` *in addition to* returning the ack), and travel over the WebSocket channel — not in the fetch response. Dispatching the fetch body as a `message` event would feed the inbound switch shapes it does not understand and never trigger a re-render.
   > **Replaced with:** Two channels — commands over `fetch('/kanban/verb/'+type)`, renders over the WebSocket hub whose messages already match the inbound switch cases verbatim.

4. **Inbound refresh mechanism = the existing WebSocket hub (not hash polling).** Use the WS hub described in step 3 for live refresh. It is already built, already authenticated by the same token gate (`wsHub.ts:31,95`), already broadcasts every board mutation, and already speaks the page's inbound vocabulary. Polling a board-state hash is unnecessary and, as specified in the original plan, not implementable: there is **no** board-state hash HTTP endpoint, and the `BoardSnapshotPublisher` hash is in-memory only (`BoardSnapshotPublisher.ts:154`), never exposed, and only computed when the opt-in board export is enabled. If WS is ever unavailable, a fallback poll of `GET /kanban/board` on an interval is the degraded path — but WS is the primary design.

   > **Superseded:** "Replace extension push with polling of a cheap board-state hash endpoint (or SSE if trivially available) ... Reuse the snapshot hash already computed by `BoardSnapshotPublisher` if practical."
   > **Reason:** No hash endpoint exists, and the `BoardSnapshotPublisher` hash is private in-memory state gated behind an opt-in export mode — not reusable. Meanwhile a WebSocket hub already exists that broadcasts the exact render messages the page consumes, with resync-on-connect. Polling would be strictly worse (latency, wasted requests, and it still would not produce the `moveCards`/`updateBoard` shapes without a translation layer).
   > **Replaced with:** Subscribe to the existing `WsHub`; broadcast messages are dispatched to the page as-is. `GET /kanban/board` seeds the first paint; interval polling is only a degraded fallback.

5. **Read-only first, then interactive.** Phase A ships board rendering + auto-refresh (via WS) with mutations disabled (drag/buttons no-op with a tooltip). Phase B enables interactions verb-by-verb, relying on the verb allowlist + schemas (`validateVerbPayload`, `KanbanProvider.ts:6899`) as the safety gate. Phase A alone is shippable and is the low-complexity core (~5); Phase B is the higher-risk half.

6. **Auth token — additive, reconciled with the existing gate.** Once a browser is a client, loopback-without-auth is no longer acceptable: CORS is currently wide open (`Access-Control-Allow-Origin: *`, `LocalApiServer.ts:2664-2667`), and DNS rebinding lets a malicious external page issue requests that arrive from the local browser (so the per-request loopback IP guard at `LocalApiServer.ts:2657-2662` does **not** defend against it — the request's `remoteAddress` is still `127.0.0.1`). Reconcile with what already exists:
   - A bearer-token gate already exists — `_checkAuth` (`LocalApiServer.ts:426-451`) accepts `Authorization: Bearer <token>` matched (constant-time) against `getAuthToken()`, whose token comes from VS Code **SecretStorage** (`switchboard.apiToken`, `TaskViewerProvider.ts:1551-1554`). **But** `_checkAuth` returns `true` for header-less requests (trust-loopback default, `:434-438`), and there is no token-setter UI, so the token is effectively empty today and existing local agents send no header.
   - Therefore the browser gate must be **additive and must not flip `_checkAuth`'s header-less default** (existing agents rely on it). The confirmed control hierarchy (see Research Findings) is, in order:
     1. **Host-header allowlist — the primary DNS-rebinding defense.** Reject any browser-facing request whose `Host` is not an exact match for `127.0.0.1:<port>` / `localhost:<port>` (no wildcards), on both the HTTP request and the WebSocket `Upgrade`. This defeats rebinding because the attacker controls the resolved IP, not the `Host` string the browser sends.
     2. **A possession secret — the only true auth factor.** Generate a random, single-use bootstrap token and write it to `.switchboard/api-server-token.txt` alongside the port file (written atomically in `TaskViewerProvider.ts:1834-1839`; write the token the same way, into roots that already have `.switchboard/` — never `mkdir`). Deliver it once via `?token=` on the first `/ui/board` load (unavoidable for a fresh tab), then **immediately set an `HttpOnly; SameSite=Strict` cookie and invalidate the one-time token** (the Jupyter notebook-server pattern). All subsequent verb calls and the WebSocket handshake rely on the cookie, not the URL. Add `Cache-Control: no-store` to the bootstrap response and `Referrer-Policy: no-referrer` to the served page so the token can't leak via history/referrer. Existing header-less loopback agent flows are untouched.
     3. **Origin check + CORS tightening — defense-in-depth.** Validate `Origin` on state-changing verbs and the WS handshake against the same allowlist. Drop the wildcard `Access-Control-Allow-Origin: *` (`LocalApiServer.ts:2664-2667`) for the browser surfaces: since the page and API share an origin, no cross-origin CORS grant is needed at all (or use an explicit single-origin allowlist).
   - **WebSocket specifics:** the browser `WebSocket` constructor cannot set custom headers, so auth rides on the cookie (preferred, same-origin) — validate it plus `Origin` during the HTTP `Upgrade` so a bad handshake fails with 401 rather than mid-protocol. Token-in-WS-URL is acceptable only as the bootstrap value, never as a durable credential.
   - Chrome's Private Network Access / Local Network Access (PNA/LNA) adds a browser-side backstop but is phased, Chromium-only, and partial-coverage — treat it as a bonus, never load-bearing.

   > **Superseded:** "Generate a random token alongside `api-server-port.txt` (e.g. `.switchboard/api-server-token.txt`), require it on `/ui/board` ... Existing local-agent flows that read the port file read the token file the same way."
   > **Reason:** Not wrong, but incomplete: it ignored the pre-existing SecretStorage-based bearer gate (`_checkAuth`) whose header-less path trusts all loopback requests. Adding a token without accounting for that default risks either breaking existing header-less agents (if `_checkAuth` is tightened globally) or leaving a bypass (if the browser route falls through to the trust-loopback default). It also omitted the Host/Origin check, which is the standard DNS-rebinding defense; a token alone plus wide-open CORS is weaker than token + Host allowlist.
   > **Replaced with:** Keep the file-based token, but enforce it as an **additive** gate on the browser surfaces only (route + browser-origin verbs + WS handshake) without changing `_checkAuth`'s header-less default, and add a Host/Origin allowlist as the primary rebinding defense.

7. **Docs.** Add the browser board to the Agentic Coding Apps page and the Local API Server reference on switchboard-site, including the token bootstrap (`api-server-token.txt`) and the `?token=` first-load flow.

## Metadata

- **Tags:** feature, api, ui, security
- **Complexity:** 7

## User Review Required

- **Phasing decision (at dispatch):** ship Phase A (read-only) alone first, or A+B together. *(Recommendation: ship Phase A first — it is the ~5-complexity core, independently valuable, and de-risks the static-serving + WS-shim + auth plumbing before opening the mutation surface. Reserve Phase B for a follow-up once Phase A is proven.)*
- **Auth surface confirmation:** the token is enforced on browser-facing surfaces only and does not change existing header-less loopback agent behavior. *(Decision: additive gate as specified in step 6; confirm no existing agent is expected to hit `/ui/board`.)*

## Complexity Audit

### Routine
- Adding `else if` route branches to the existing manual path switch (`LocalApiServer.ts:2684-2826`).
- The outbound command shim — a verified 1:1 `postMessage.type` → `/kanban/verb/type` mapping, no translation table.
- Reusing the existing WS hub and `GET /kanban/board` (no new push infrastructure).

### Complex / Risky
- **First-time static serving** — the server has never served static assets; content-type handling, asset routes (icons/fonts/sharedDefaults), and placeholder replacement are all net-new plumbing that must mirror `_getHtml` without forking `kanban.html`.
- **CSP divergence** — the served page needs a *different* CSP from the webview (`connect-src 'self'` vs `'none'`); getting this wrong silently breaks fetch/WS.
- **Security-sensitive auth** — introducing a token + Host/Origin gate on a loopback server reached by a browser, with a pre-existing bearer gate whose header-less default must be preserved. Wrong reconciliation either breaks existing agents or opens a bypass; wide-open CORS + DNS rebinding is the threat model.
- **Two-channel shim correctness** — commands over HTTP, renders over WS; conflating them (the original plan's mistake) yields a board that accepts clicks but never repaints.
- **`src`/`dist` single-source drift** — serve from the same resolved path `_getHtml` uses to avoid a second source of truth.

## Edge-Case & Dependency Audit

- **Race Conditions:** The browser sends a command (HTTP) and the resulting render arrives asynchronously over WS — the shim must not assume the fetch response reflects post-mutation state. Optimistic-move UI already exists in the webview (see the codebase's optimistic-move guard); ensure the browser path either reuses it or tolerates the WS-render lag without double-applying. Concurrent WS reconnect + initial `GET /kanban/board` must not double-seed.
- **Security:** Primary risk area (see Complexity Audit). CORS is `*` today; DNS rebinding bypasses the loopback IP guard; the token file must never be `mkdir`'d into a non-Switchboard root and must be readable only as the port file is. Token in a URL query param leaks into browser history/referer — rotate to cookie/header immediately after first load. The WS handshake must enforce the same token (`wsHub.ts:31,95`).
- **Side Effects:** New public-ish surface on the loopback port. No change to the VS Code webview behavior (assets/CSP are injected per-host; the disk file is shared, untouched). No new persisted state beyond the token file.
- **Dependencies & Conflicts:** Depends on the completed Host-Agnostic Verb Engine (A2b) — verified present: `KANBAN_VERBS` (145) == `_handleMessage` cases (145), dispatched via `handleServiceVerb` (`KanbanProvider.ts:6894-6911`). Independent of the sibling **Cloud/Mobile snapshot** subtask (that one extends `BoardSnapshotPublisher`/`board.json`; this one does not read `board.json`). No shared code contention.

## Dependencies

- Prerequisite (already landed): Host-Agnostic Verb Engine / A2b — kanban verbs return in the HTTP body and share the `_handleMessage` dispatch path. Verified in-repo, not an open dependency.
- Sibling subtask *Cloud/Mobile Board: Self-Contained board.html* — independent; either order.

## Adversarial Synthesis

Key risks: (1) the two-channel nature — treating the verb's `{success}` ack as a render message (the original plan's error) produces a board that accepts input but never repaints; renders must come from the WS hub. (2) Security — a browser client over wide-open CORS on a loopback port is a DNS-rebinding target the existing IP guard does not stop; the fix is a token + Host/Origin allowlist enforced additively without breaking existing header-less agents. (3) Serving `kanban.html` is not "rewrite URIs" — it requires replicating `_getHtml`'s placeholder pass and a browser-specific CSP. Mitigations: WS-based inbound channel, additive auth gate, and a shared-source serve path with its own CSP; ship Phase A (read-only) first to prove the plumbing.

## Proposed Changes

### `src/services/LocalApiServer.ts`
- **Context:** Raw `http.createServer` (`:324`) with a manual `if/else if` path switch in `_handleRequest` (`:2684-2826`); loopback bind (`:328`); per-request loopback guard (`:2657-2662`); wide-open CORS (`:2664-2667`); `_checkAuth` bearer gate with header-less trust default (`:426-451`); verb dispatcher `POST /kanban/verb/<command>` (`:2741-2744` → `_handleKanbanVerb` `:1115-1151`) returning `{ success, ... }`; WS hub wired via `broadcastWs` (`:380-382`) and `getFullState` resync (`:279-284`).
- **Logic:** Add `GET /ui/board` (serves token-replaced `kanban.html` + browser CSP), asset routes (icons/fonts/`sharedDefaults.js`/shim), a static content-type helper, and the additive token + Host/Origin gate for browser surfaces. Enforce the token on the WS handshake for browser clients.
- **Edge Cases:** Do not alter `_checkAuth`'s header-less default. Inject `connect-src 'self'` CSP, not the webview's `'none'`. Reject foreign Host/Origin.

### `src/services/KanbanProvider.ts`
- **Context:** `_getHtml` (`:10517-10606`) does token replacement (`{{ICON_*}}`, fonts, `<!-- SHARED_DEFAULTS_SCRIPT -->`), nonce/CSP injection (`:10543-10546`), and workspace-root/theme injection. `handleServiceVerb` (`:6894-6911`) is the shared verb→`_handleMessage` path.
- **Logic:** Factor the placeholder-replacement logic so the HTTP route can reuse it (or replicate it) without forking `kanban.html`; the HTTP variant targets HTTP asset routes and a browser CSP. No change to verb dispatch (already host-neutral).
- **Edge Cases:** Serve from the same resolved path (`dist` → `webview` → `src`) to avoid `src`/`dist` drift.

### `src/webview/browser-host-shim.js` (new, browser-route only)
- **Context:** Provides `acquireVsCodeApi()` for the non-VS-Code host.
- **Logic:** `postMessage(msg)` → `fetch('/kanban/verb/'+msg.type, ...)` (outbound); a WebSocket subscriber → synthetic `window` `message` events (inbound); `getState`/`setState` shimmed via `sessionStorage`. Seed first paint via `GET /kanban/board`.
- **Edge Cases:** Never injected into the VS Code webview build. Carry the token on fetch + WS. Tolerate WS reconnect without double-seeding.

### `src/services/TaskViewerProvider.ts`
- **Context:** Writes `.switchboard/api-server-port.txt` atomically into eligible roots (`:1834-1839`); holds `getAuthToken` (`:1551-1554`).
- **Logic:** Generate + write `.switchboard/api-server-token.txt` the same atomic way, into the same eligible roots; surface the token to the browser bootstrap. Never `mkdir` `.switchboard/`.

### switchboard-site docs
- Add browser-board usage + token bootstrap to Agentic Coding Apps and the Local API Server reference.

## Verification Plan

*(Session directives: SKIP COMPILATION, SKIP TESTS — no automated tests are to be authored or run for this dispatch. The steps below are the manual acceptance checks to run when implementing.)*

### Automated Tests
- None to be written or run this pass per session directive. (If tests are later added: assert `/ui/board` 401s without a token and 200s with it; assert a foreign `Origin`/`Host` is rejected; assert a posted verb reaches `_handleMessage` with `type` set.)

### Manual Acceptance
- Open `http://127.0.0.1:<port>/ui/board?token=<token>` in a browser (no VS Code): the current board renders with columns, cards, features, and project-filter state.
- Mutate the board elsewhere (VS Code webview or a raw verb call); the browser reflects it within the WS push latency, no manual reload.
- Request `/ui/board` without the token → 401; a header-less existing loopback agent hitting an existing JSON endpoint is unaffected.
- Send a request with a foreign `Host`/`Origin` → rejected.
- `kanban.html`/assets remain single-source: the VS Code webview behaves identically before and after; no forked HTML.
- (Phase B) Drag a card in the browser → persists via the verb path and appears in the VS Code webview via WS.

## Research Findings (resolved)

The security surface (step 6) was flagged as an external-domain uncertainty and confirmed by web research. Resolutions, now baked into step 6:

- **The `remoteAddress === 127.0.0.1` guard is ineffective against DNS rebinding** — confirmed. The TCP connection genuinely originates from loopback, so the IP check always passes; this is the exact mechanism behind 2025–2026 VS Code extension CVEs (Live Server, Live Preview) that ran unauthenticated loopback servers. Treat the IP check as ambient context, not authentication.
- **Control hierarchy (confirmed):** (1) **Host-header allowlist** is the load-bearing rebinding defense — the attacker controls the resolved IP, not the `Host` string the browser sends; (2) a **possession secret** (token→cookie) is the only true auth factor; (3) **Origin check + dropping CORS `*`** is defense-in-depth (CORS governs response *readability*, not whether a request executes, so it is necessary hygiene but not a rebinding fix).
- **Bootstrap token hand-off (confirmed pattern — Jupyter):** single-use `?token=` on first load → set `HttpOnly; SameSite=Strict` cookie → invalidate the token. Add `Cache-Control: no-store` + `Referrer-Policy: no-referrer`. A token durably living in a URL is a documented antipattern (history/referrer/log leakage).
- **WebSocket auth (confirmed):** the browser WS API cannot set custom headers; authenticate via the same-origin cookie and validate `Origin` during the HTTP `Upgrade`. Token-in-URL is bootstrap-only.
- **PNA/LNA (confirmed):** a real but partial, Chromium-only, phased backstop — not load-bearing.

No open research items remain. The in-repo facts (verb 1:1 mapping, WS vocabulary, existing `_checkAuth` gate, CORS/loopback behavior) were already verified.

---

**Recommendation:** Complexity **7** (top of band; the security + two-channel-shim + first-time-static-serving surface pushes it toward 8) → **Send to Lead Coder**. Ship **Phase A (read-only)** first — it is the ~5-complexity core and de-risks the plumbing before the mutation surface opens. The DNS-rebinding mitigation set is now confirmed (see Research Findings) and specified in step 6; no open research items remain.
