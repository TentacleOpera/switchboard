# The browser board is served unauthenticated by the extension host — reject cross-site state-changing requests in both hosts

## Goal

Close a reachable CSRF hole in the board's HTTP surface by rejecting cross-site state-changing requests at the front of `_handleRequest`, in both composition roots, using request metadata (`Sec-Fetch-Site` / `Origin`) rather than a credential. Any web page the user visits while a board is open must not be able to move cards, delete plans, or fire a dispatch.

### Problem Analysis

Both hosts serve the *same* browser board to a real browser tab:

- **Standalone:** `npx switchboard` prints `http://<host>:<port>/?token=<one-time>` and opens it.
- **Extension:** `switchboard.openInBrowser` (`src/extension.ts:1370-1387`) mints a browser token, resolves a display hostname via the shared `resolveDisplayHostname`, and opens `http://<host>:<port>/?token=<token>` with `vscode.env.openExternal`. This works because the extension wires `serveStatic` and `consumeOneTimeToken` into its `LocalApiServer` (`src/services/TaskViewerProvider.ts:4043-4044`), serving the shell and panel HTML from the shared `headlessPanelHtml.ts`.

So the board is a genuine `http://` origin in the user's ordinary browser under **both** hosts. The two hosts do not authenticate it the same way:

- The `/` handler consumes the one-time token and replies `Set-Cookie: sb_session=${expected}` (`src/services/LocalApiServer.ts:1101-1110`), where `expected` is `getAuthToken()`.
- Under the extension, `getAuthToken()` reads `switchboard.apiToken` from VS Code SecretStorage (`src/services/TaskViewerProvider.ts:3721-3724`). **No code path anywhere writes that secret** — there is no setter UI and no CLI for it on this host — so it always resolves to `''`.
- `_checkAuth` returns `true` unconditionally when the expected token is empty (`src/services/LocalApiServer.ts:883`), *before* it ever inspects the bearer header or the `sb_session` cookie.

Two consequences follow. First, the extension's entire browser-token mechanism is decorative: `mintBrowserToken`/`consumeBrowserToken` (`src/services/TaskViewerProvider.ts:4405-4418`) bound the *URL's* validity, but the cookie they cause to be set is the empty string and is never checked. Second — the actual bug — **every request to the extension's board is authorized**, including one originating from a hostile page.

The remaining defenses do not close it:

| Guard | Site | What it stops | Why it isn't enough |
| :--- | :--- | :--- | :--- |
| Socket peer check | `LocalApiServer.ts:7278-7283` | Non-loopback peers | The user's own browser *is* a loopback peer |
| `Host` rebinding guard | `LocalApiServer.ts:7285-7291` | DNS rebinding. Active in both hosts (gated on `serveStatic`, which the extension sets) | A hostile page addressing `127.0.0.1` directly sends a legitimate `Host` |
| CORS mirroring | `LocalApiServer.ts:7295-7298` | Attacker *reading* the response | CORS does not stop the request arriving and executing |

And the body parser ignores `Content-Type` entirely — it reads the stream and calls `JSON.parse(body)` (`src/services/LocalApiServer.ts:1390-1399`). A cross-origin `fetch` with `Content-Type: application/json` would trigger a preflight and die, but an HTML `<form method="POST" enctype="text/plain">` is a **simple request** with no preflight, and `text/plain` can carry a payload that parses as valid JSON. That request reaches a mutating endpoint and executes.

Under standalone the same request is rejected — it carries no bearer header, and `sb_session` is `SameSite=Strict` so the browser does not attach it cross-site. Under the extension it succeeds.

### Measured surface — 42 POST routes, and the verb rails on top

The exposure was quantified against HEAD rather than assumed. Two mechanics make it broad:

**1. `Content-Type` is never inspected.** `_parseJsonBody` collects the body and calls `JSON.parse` on whatever arrived (`LocalApiServer.ts:1396`). So a request sent as `Content-Type: text/plain` parses identically to a JSON one — and `text/plain` is a **CORS-simple** content type, so the browser issues it with **no preflight**. Requiring `application/json` on JSON routes would force a preflight and close this path on its own; it is cheap, independent of the metadata guard, and worth doing as defence in depth.

**2. The reachable set is every `POST`.** Enumerating state-changing routes at HEAD gives **42 POST**, 3 PUT, 1 DELETE. `POST` is a simple method; `PUT` and `DELETE` are not, so they trigger a preflight the server answers only for localhost origins. The result is an accident worth naming: `DELETE /kanban/plans` (with `deleteFile=true`) and the three `PUT`s are protected **by their HTTP verb, not by any check in the code** — and the destructive-sounding route is the safe one.

The 42 include `/kanban/dispatch`, `/terminals/relay`, `/kanban/move`, `/kanban/plans`, `/kanban/feature/delete`, `/kanban/feature/split`, `/mission-control/start|stop|adopt`, `/research/dispatch`, `/phone-a-friend`, `/kanban/transfer/export|import` and `/teams/create-external`.

**Rank `/api/clickup` and `/api/linear` above `relay`.** They proxy to the trackers using the operator's stored credentials, so a hostile page makes *this* server issue authenticated writes to ClickUp and Linear. The page cannot read the response; the write still lands. `relay` is narrower than it first appears — it validates both endpoints against the live pty fleet (`status === 'active'`, 404 otherwise) and delivers into an **agent's** prompt, so the realistic impact is prompt injection into a running agent rather than shell execution. That still matters where seats run with `--dangerously-skip-permissions`.

**The verb rails multiply this and are not in the 42.** `/kanban/verb/<name>`, `/terminals/verb/<name>`, `/planning/verb/<name>`, `/tickets/verb/<name>`, `/project/verb/<name>` and `/mission-control/verb/<name>` are all `POST` with a path suffix, so each one is a family, not a route. Confirm they sit behind the same front-of-request check — a per-route guard would miss them entirely.

**Consequence for this plan's design:** the guard must be a single front-of-`_handleRequest` check over *every* state-changing method, which is what is already proposed. Do not let it become a per-route allowlist — route 43 and the next verb ship unprotected by default. The contract test must assert the property ("no state-changing route accepts a cross-site request"), not enumerate today's routes.

### Root Cause

The board's protection against a hostile page was **delegated entirely to authentication**, and one of the two hosts serving that board has no authentication. The request-metadata signals that distinguish "the board's own fetch" from "some other page's fetch" — `Sec-Fetch-Site` and `Origin` — are available on every browser request and are checked nowhere: `Sec-Fetch-Site` does not appear in `LocalApiServer.ts` at all, and `Origin` is only ever used to *mirror* a CORS header, never to reject.

This is the CLAUDE.md composition-root divergence pattern again. Both hosts wire `serveStatic`; only one wires a non-empty `getAuthToken`. No gate catches it because each host is internally consistent.

### Non-goals

- **Giving the extension host a session token.** Rejected deliberately. The `LocalApiServer` HTTP surface *has* shipped and in-tree callers (`sb_api_call.sh`, the `kanban_operations/*.js` scripts) send no `Authorization` header at all; minting an extension token would 401 every one of them. The guard in this plan is non-breaking because local scripts and `curl` send neither `Origin` nor `Sec-Fetch-Site`.
- **The out-of-process agent credential.** Separate plan; this one deliberately adds no credential.
- **Rewriting the body parser to enforce `Content-Type`.** Worth doing, but it is defense-in-depth behind this guard, and enforcing JSON content-type risks breaking in-tree callers that omit the header. Noted as a follow-up, not done here.

## Metadata

**Complexity:** 4
**Tags:** security, backend, api, reliability

## Proposed Changes

1. **Add a cross-site rejection guard to `_handleRequest`** (`src/services/LocalApiServer.ts`), immediately after the `Host` guard at `:7291` and before the CORS mirroring at `:7295`. Reject with 403 when either signal indicates a cross-site request:
   - `Sec-Fetch-Site` is present and its value is `cross-site` or `same-site`.
   - `Origin` is present and `_isLocalhostOrigin(origin)` is false.

   Both conditions are evaluated; either one rejects. Absence of both headers is *allowed* — that is the local-script/`curl` case, and it is the reason this change breaks nothing.

2. **Allow `Sec-Fetch-Site: none` and `same-origin`.** `none` is a user-initiated navigation (the `openExternal` call and a boot URL clicked out of a terminal both produce it); `same-origin` is the board's own fetches. Both must pass or the board becomes unopenable.

3. **Apply the guard to `GET` as well as the mutating methods.** A side-effecting `GET` reached via `<img src>` or a navigation carries no preflight, so restricting the guard to POST/PUT/DELETE would leave that vector open. `Sec-Fetch-Site: cross-site` is present on those requests, so the guard catches them. This requires the audit in step 4 to confirm no legitimate cross-site `GET` exists — none should, since nothing outside the board is supposed to embed board resources.

4. **Audit the route table for side-effecting `GET` endpoints** and record the result in the plan's completion report. If any mutating `GET` exists it is a separate bug; note it, do not fix it here.

5. **Exempt `/health` from the guard.** It is the port-discovery probe used by `sb_api_call.sh`, the `kanban_operations` scripts and `cli.ts`'s `probeHealth`/`waitForHealth`. Those callers send no `Origin`, so they pass the guard anyway — but exempting it explicitly keeps discovery working even from a browser context and documents the intent.

6. **Verify the WebSocket upgrade path is unaffected.** `wsHub.ts:220` calls `authorizeWsUpgrade` on the upgrade event, which does not pass through `_handleRequest`. Either extend the same origin check to `wsUpgradeAuth.ts` (a cross-site page can open a WebSocket — `WebSocket` is not subject to CORS) or document why the existing check suffices. **A cross-site `WebSocket` handshake is a real vector and must not be left unexamined.**

7. **Fix the empty-cookie emission.** In `LocalApiServer.ts:1101-1110` (and the two sibling token-exchange sites at `:994-1005` and `:1046-1057`), skip the `Set-Cookie` entirely when `expected` is empty rather than emitting `sb_session=`. A cookie whose value is the empty string is meaningless and misleads anyone reading the handler into thinking the extension board is session-authenticated.

8. **Correct the comments that assert the wrong trust model.** The note at `LocalApiServer.ts:915-921` describes the extension as "localhost-trust" without recording that it also *serves a browser board* under that trust. Update it to state the post-change model explicitly: the extension board is loopback-trusted and CSRF-guarded, not authenticated; standalone is both.

9. **Add a contract test** — `src/test/board-csrf-guard-contract.test.js`, following the shape of `src/test/loopback-hostname-contract.test.js`. Cover: `Sec-Fetch-Site: cross-site` POST → 403; `same-site` POST → 403; `none` GET → 200; `same-origin` POST → allowed; non-loopback `Origin` → 403; **no headers at all → allowed** (the local-script case, which is the regression this test exists to prevent); `/health` with a cross-site origin → 200.

## Edge-Case & Dependency Audit

- **The `enctype="text/plain"` vector must be proven, not assumed.** Verification step 3 reproduces it against a real server before the fix, so the guard is known to close an actually-reachable path rather than a theorised one.
- **`Sec-Fetch-Site` is not universal.** It is absent on old browsers and on all non-browser clients. The guard therefore cannot rely on it alone — the `Origin` check is the second, independent condition, and neither is treated as mandatory. This is why "absence of both allows" is correct rather than lax: a browser that omits `Sec-Fetch-Site` still sends `Origin` on cross-origin POSTs.
- **`same-site` is rejected, not allowed.** `localhost` and `127.0.0.1` are distinct origins; a page on a *different port* of localhost is `same-site` but not same-origin, and is exactly as untrusted as any other page. Allowing `same-site` would leave every other local dev server able to drive the board.
- **The `?token=` navigation must survive.** `openExternal` produces a top-level navigation with `Sec-Fetch-Site: none` and no `Origin`. Verification step 5 exercises this end to end from the real VS Code command, not a synthetic request.
- **`serveStatic`-gating does not apply to this guard.** The `Host` guard is conditional on `serveStatic` because the extension's older scripts rely on raw `127.0.0.1:<port>` Host values (`LocalApiServer.ts:7285-7287`). The CSRF guard must be **unconditional** — the extension is precisely the host that needs it, and local scripts send no `Origin` so they are unaffected.
- **Both roots, one seam.** The guard lives inside `LocalApiServer._handleRequest`, which both hosts construct, so there is no per-root wiring to forget. Confirm this by inspection: no new option is added to `LocalApiServerOptions`, which is what makes this change divergence-proof by construction.

## Dependencies

None. This plan is independent of the agent-credential work and can ship first.

## Verification Plan

**Property, not enumeration.** The central test asserts that *no* state-changing route accepts a cross-site request — driven by walking the router's own route table, so a route added tomorrow is covered without editing the test. A test listing today's 42 paths passes forever while the surface grows.

Additional cases the measured surface requires:
- **A `text/plain` POST is rejected** — the no-preflight path, which is how the hole is actually reached.
- **The verb rails are covered** — assert one route from each of `/kanban/verb/`, `/terminals/verb/`, `/planning/verb/`, `/tickets/verb/`, `/project/verb/`, `/mission-control/verb/`.
- **`PUT`/`DELETE` stay working** for same-origin callers — they are protected by preflight today, and the new guard must not double-reject them.
- **In-tree local clients are unaffected** — `sb_api_call.sh` and the `kanban_operations/*.js` scripts send neither `Origin` nor `Sec-Fetch-Site`, and must continue to succeed. This is the non-breaking gate.

### Original verification plan


1. `npm run compile` — 0 errors.
2. `node --test src/test/board-csrf-guard-contract.test.js` — new test green.
3. **Reproduce the hole before fixing.** With the extension host running, serve a local page on a *different* port containing `<form method="POST" enctype="text/plain" action="http://127.0.0.1:<port>/kanban/move">` with a JSON-parseable payload, submit it, and confirm the card moves. This is the proof the vector is real.
4. Re-run step 3 after the change — the request must 403 and the card must not move.
5. Click **Browser Switchboard** in VS Code. The board must open and be fully functional: load state, move a card, open each panel. This is the regression that matters most.
6. `npx switchboard` in a clean workspace, open the printed boot URL, confirm the same.
7. From a plain terminal (no `Origin`, no `Sec-Fetch-Site`): `curl -s http://127.0.0.1:<port>/health` and a `curl -X POST` against a mutating endpoint must both still work under the extension host. This proves the guard did not break the local-script path.
8. Run the existing suites that touch this surface: `node --test src/test/loopback-hostname-contract.test.js` and the terminal/WS contract tests.
9. Confirm a cross-site WebSocket handshake is rejected (step 6 of Proposed Changes), or that the plan records why it is safe.

## Outstanding Questions

- Should the body parser also enforce a JSON `Content-Type`? It would independently kill the `text/plain` form vector, but may break in-tree callers that omit the header. Deferred; flag for a follow-up plan after auditing callers.
