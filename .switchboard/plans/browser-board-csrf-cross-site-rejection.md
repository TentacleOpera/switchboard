# The browser board is served unauthenticated by the extension host — reject cross-site state-changing requests in both hosts

<!-- header-absence-withdrawn-01 -->
> **DESIGN CORRECTION 2026-09-10.** The rule *"absence of both headers is allowed — that is the
> local-script/`curl` case"* is **withdrawn.** curl is not a supported client, so it must not be the
> reason a hole stays open. The exemption is replaced by a positive client marker; see
> **Header absence no longer allows (2026-09-10)** at the end of this file, which supersedes the
> corresponding text in Proposed Changes step 1, Non-goals, the Edge-Case audit and the Verification
> Plan. Line numbers throughout this plan predate substantial growth in `LocalApiServer.ts`; the
> current sites are listed in that section.

<!-- board-collapse-01b -->
> **PATH CORRECTION 2026-09-04 (Board Collapse 01).** This file names `.agents/skills/_lib/sb_api_call.sh`, which was **deleted** in commit `96fb16df`. All eight `kanban_operations/*.js` scripts now share `.agents/skills/_lib/cli-call.js`, and `switchboard api` is the shell-side escape hatch. Read every `sb_api_call` reference below as `cli-call.js` / `switchboard api`, and do not restore the shell helper.


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

## User Review Required

None. The 2026-09-10 design correction (header absence no longer allows; positive client marker replaces it) is a breaking change for in-tree local clients, but the direction is correct — failing closed is the safe failure mode, and the client updates are enumerable from the code. The scope decision (metadata guard, not CSRF token; detect-and-advise, not auto-configure) is made and justified in the plan.

## Complexity Audit

### Routine
- Adding the `Sec-Fetch-Site` / `Origin` check to `_handleRequest` — a single function, after the Host guard, before CORS mirroring. Both hosts share `_handleRequest`, so no per-root wiring.
- Exempting `/health` from the guard — one route, already identified.
- Fixing the empty-cookie emission — skip `Set-Cookie` when `expected` is empty, at three sites.
- Correcting the trust-model comments — documentation only.

### Complex / Risky
- **The 2026-09-10 positive client marker (`X-Switchboard-Client`).** Every in-tree local client must send the marker or it starts getting 403. The blast radius is wide: `.agents/skills/_lib/cli-call.js`, eight `kanban_operations/*.js` scripts, `switchboard api`, `probeHealth`/`waitForHealth` in `cli.ts`, the Go client, and the standing-order prompt text. The Go client is a separate build; the prompt text is a deployment coordination item, not a code change. Anything missed fails closed (correct direction, still a break).
- **The trusted-origin set reads the bind policy.** The CSRF guard's allow-set is `isAllowedOriginFor(this._bindPolicy, origin)` — the same predicate the Host guard and the WS upgrade auth use. This means the guard is correct under tailnet mode only if the bind policy's `magicDnsNames` is populated (Subtask 0 + Subtask 1). If the array is empty, the guard rejects every tailnet-board request invisibly (a verb POST has no timeout and a rejection is indistinguishable from a hang). This is the ordering dependency: Subtask 0 and Subtask 1 land first.
- **The property-based contract test.** The test walks the router's own route table, so a route added tomorrow is covered. But the test must also cover the verb rails (`/kanban/verb/`, `/terminals/verb/`, etc.) — each is a family, not a route. Asserting one route from each verb family is the minimum.
- **The WebSocket upgrade path.** `authorizeWsUpgrade` in `wsUpgradeAuth.ts:95` already applies `isAllowedOriginFor(policy, origin)` — the same check the CSRF guard proposes for HTTP. A cross-site WS handshake sends `Origin` (always, per the WebSocket spec), and `isAllowedOriginFor` rejects it if the origin is not in the bind policy. **The WS path is already covered; no new code is needed.** The `origin &&` guard at line 95 means a non-browser client with no `Origin` is allowed — correct, because the WS path has its own token auth for non-tailnet upgrades.

## Proposed Changes

1. **Add a cross-site rejection guard to `_handleRequest`** (`src/services/LocalApiServer.ts`), immediately after the `Host` guard at `:7291` and before the CORS mirroring at `:7295`. Reject with 403 when either signal indicates a cross-site request:
   - `Sec-Fetch-Site` is present and its value is `cross-site` or `same-site`.
   - `Origin` is present and its host is **not in the trusted-origin set** (see step 1a).

**1a. The trusted-origin set is loopback plus the tailnet bind policy's hosts — not loopback alone.**
This is a correction of record, made 2026-09-04 (Board Collapse 05, decision 7), and it is
load-bearing: as originally written this guard rejects every request from the tailnet board.

A page served at the machine's MagicDNS name sends that name as its `Origin` on every `fetch`. It is
not loopback, so an `_isLocalhostOrigin`-only rule returns 403 for every verb the operator triggers
from the one remote surface that works — and it fails *invisibly*, because a verb `POST` currently
has no timeout and a rejected request is indistinguishable from a hung one
(`a-verb-post-can-hang-forever-with-no-timeout-and-no-feedback.md`).

The server already maintains the set of names it may legitimately be reached by: the tailnet bind
policy's `magicDnsNames` and tailnet addresses, which the existing Host-header guard consults
(`isAllowedHostFor`). Read the same set here. One list, two guards, no second copy to drift.

- Accept when the `Origin` host is loopback (`_isLocalhostOrigin`) **or** is in the bind policy's
  allowed hosts.
- Reject otherwise. A hostile page's origin is in neither set, so the protection is unchanged.
- **Bracket IPv6 literals** when comparing: an `Origin` header carries `http://[fd7a:...]:7777`
  while the policy stores the bare address. Normalise both sides before matching.
- When no tailnet policy is configured, the set is loopback only and behaviour is exactly as this
  plan originally described.

**Sequencing.** `tailnet-accepts-the-nodes-own-magicdns-names.md` is what populates that policy with
the node's own names, so it lands **first**. Both plans are subtasks of the **Tailnet** feature.

   Both conditions are evaluated; either one rejects. Absence of both headers is *allowed* — that is the local-script/`curl` case, and it is the reason this change breaks nothing.

2. **Allow `Sec-Fetch-Site: none` and `same-origin`.** `none` is a user-initiated navigation (the `openExternal` call and a boot URL clicked out of a terminal both produce it); `same-origin` is the board's own fetches. Both must pass or the board becomes unopenable.

3. **Apply the guard to `GET` as well as the mutating methods.** A side-effecting `GET` reached via `<img src>` or a navigation carries no preflight, so restricting the guard to POST/PUT/DELETE would leave that vector open. `Sec-Fetch-Site: cross-site` is present on those requests, so the guard catches them. This requires the audit in step 4 to confirm no legitimate cross-site `GET` exists — none should, since nothing outside the board is supposed to embed board resources.

4. **Audit the route table for side-effecting `GET` endpoints** and record the result in the plan's completion report. If any mutating `GET` exists it is a separate bug; note it, do not fix it here.

5. **Exempt `/health` from the guard.** It is the port-discovery probe used by `_lib/cli-call.js`, the `kanban_operations` scripts and `cli.ts`'s `probeHealth`/`waitForHealth`. Those callers send no `Origin`, so they pass the guard anyway — but exempting it explicitly keeps discovery working even from a browser context and documents the intent.

6. **Verify the WebSocket upgrade path is unaffected.** `wsHub.ts:305` calls `authorizeWsUpgrade` on the upgrade event, which does not pass through `_handleRequest`. **Confirmed by code reading:** `authorizeWsUpgrade` in `wsUpgradeAuth.ts:95` already applies `isAllowedOriginFor(policy, origin)` — the same predicate the CSRF guard uses for HTTP. A cross-site WS handshake sends `Origin` (always, per the WebSocket spec), and `isAllowedOriginFor` rejects it if the origin is not in the bind policy. The `origin &&` guard at line 95 means a non-browser client with no `Origin` is allowed — correct, because the WS path has its own token auth for non-tailnet upgrades. **No new code is needed for the WS path.** The contract test should assert this by confirming `wsUpgradeAuth.ts` imports and calls `isAllowedOriginFor` with the bind policy.

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

None. This plan is independent of the agent-credential work and can ship first. Within the Tailnet feature, it lands LAST — its allow-set reads `bindPolicy.magicDnsNames`, which is populated by the Host header fix (Subtask 0) and the MagicDNS names plan (Subtask 1). Reversing the order makes the guard reject every tailnet request invisibly.

## Adversarial Synthesis

Key risks: (1) the 2026-09-10 positive client marker is a breaking change for every in-tree local client — anything missed fails closed (correct direction, still a break); (2) the guard's allow-set reads the bind policy, so an empty `magicDnsNames` (from a failed probe) rejects every tailnet-board request invisibly — a verb POST has no timeout and a rejection is indistinguishable from a hang; (3) the property-based test must cover the verb rails, not just enumerated routes, or route 43 ships unprotected. Mitigations: enumerate client updates as a checklist (not prose), land Subtask 0 first to populate the name list, and assert one route from each verb family in the contract test.

## Verification Plan

**Property, not enumeration.** The central test asserts that *no* state-changing route accepts a cross-site request — driven by walking the router's own route table, so a route added tomorrow is covered without editing the test. A test listing today's 42 paths passes forever while the surface grows.

Additional cases the measured surface requires:
- **A `text/plain` POST is rejected** — the no-preflight path, which is how the hole is actually reached.
- **The verb rails are covered** — assert one route from each of `/kanban/verb/`, `/terminals/verb/`, `/planning/verb/`, `/tickets/verb/`, `/project/verb/`, `/mission-control/verb/`.
- **`PUT`/`DELETE` stay working** for same-origin callers — they are protected by preflight today, and the new guard must not double-reject them.
- **In-tree local clients are unaffected** — `sb_api_call.sh` and the `kanban_operations/*.js` scripts send neither `Origin` nor `Sec-Fetch-Site`, and must continue to succeed. This is the non-breaking gate.

### Goal Invariants

- Assert `Sec-Fetch-Site` appears in `src/services/LocalApiServer.ts` source (it does not today — its absence is the bug).
- Assert the cross-site rejection guard in `_handleRequest` runs BEFORE any route handler — after the Host guard, before CORS mirroring. No state-changing route is reachable without passing it.
- Assert the guard reads `isAllowedOriginFor(this._bindPolicy, origin)` for the Origin check — the same predicate the Host guard and WS upgrade auth use. No second copy of the allowlist.
- Assert the guard is UNCONDITIONAL (not gated on `serveStatic`) — the extension host is the one that needs it.
- Assert `/health` is exempt from the guard — port discovery works before a client knows anything about the server.
- Assert `wsUpgradeAuth.ts` imports and calls `isAllowedOriginFor` with the bind policy — the WS path is covered by the existing check, not by new code.
- Assert the `X-Switchboard-Client` marker is checked when neither `Origin` nor `Sec-Fetch-Site` is present (the 2026-09-10 correction) — a request with none of the three is rejected, not allowed.
- Assert the empty-cookie emission is fixed — `Set-Cookie: sb_session=` is absent from the three token-exchange sites when `expected` is empty.

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

## Header absence no longer allows (2026-09-10)

Supersedes the "absence of both headers is *allowed*" rule in Proposed Changes step 1, the `curl`
justification in Non-goals, the corresponding bullet in the Edge-Case audit, and the
"no headers at all → allowed" contract-test case.

**Why it changed.** That rule was the plan's non-breaking gate, justified by in-tree callers that
send no `Origin`. The justification named `curl` alongside them. curl is **not a supported client**,
and an allow-rule keyed on header *absence* cannot tell a supported caller from any other process on
the box — so it left the guard's single largest hole open to protect something that was never
supported.

**Replacement: a positive client marker.** Supported non-browser callers send an explicit header
(`X-Switchboard-Client: <name>`); a request with neither a trusted `Origin`/`Sec-Fetch-Site` nor
that header is rejected.

This is safe against exactly the attacker the plan is about, and the reason is structural rather
than incidental: a browser cannot add a custom header to a cross-site request without a CORS
preflight, and the preflight mirrors `Access-Control-Allow-Origin` **only** for an origin the bind
policy already allows (`LocalApiServer.ts:11830`). Verified against the running host — an `OPTIONS`
from `https://evil.example` requesting `content-type` came back `204` carrying
`Access-Control-Allow-Methods` and `Access-Control-Allow-Headers` but **no**
`Access-Control-Allow-Origin`, so the real request never fires. A non-browser client sets the header
trivially; a hostile page cannot set it at all.

**What must be updated to send it:** `.agents/skills/_lib/cli-call.js`, the eight
`kanban_operations/*.js` scripts, `switchboard api`, `probeHealth` / `waitForHealth` in `cli.ts`, the
Go client, and the standing-order prompt text that instructs agents to POST to
`/terminals/verb/ptySendPrompt`. Enumerate them from the code, not from this list — anything missed
starts failing closed, which is the correct direction but still a break.

`/health` stays exempt (Proposed Changes step 5), so port discovery works before a client knows
anything about the server.

**Contract-test changes.** Replace "no headers at all → allowed" with:

- no `Origin`, no `Sec-Fetch-Site`, no marker → **403**
- no `Origin`, no `Sec-Fetch-Site`, valid marker → **allowed**
- `Sec-Fetch-Site: cross-site` **plus** a valid marker → **403** (a browser signal always wins; the
  marker is not an override)
- `/health` with none of the three → **200**

**Current line numbers.** This plan cites positions from 2026-08-27 and the file has grown a long
way since. As of 2026-09-10:

| Plan cites | Now |
| :--- | :--- |
| `_checkAuth` empty-token return at `:883` | `:1560` (function), `:1588` (`if (!expected) return true`) |
| socket peer / `Host` guard at `:7278-7291` | `:11820` (`Host` guard, still `serveStatic`-gated) |
| CORS mirroring at `:7295-7298` | `:11828-11833` |
| `Set-Cookie` sites at `:994`, `:1046`, `:1101` | `:1706`, `:1758`, `:1812` |
| trust-model comment at `:915-921` | `:1574-1587` and the `_sendUnauthorized` note at `:1631` |

**Also confirmed on the live host, 2026-09-10** — the hole is still open and still reachable exactly
as described:

```
POST /kanban/verb/refresh   Origin: https://evil.example   Content-Type: text/plain   ->  200
GET  /health                Host: evil.example                                        ->  403
```

The `Host` rebinding guard works; nothing rejects a foreign `Origin`. Note also that this box has
**no durable token configured** (nothing in `~/.switchboard/`, no token row in the board DB), so the
standalone host is currently in the same unauthenticated state the plan attributes to the extension
host — the `SameSite=Strict` cookie defence it relies on never engages, because `_checkAuth` returns
`true` on the empty-token branch first. Standalone is not the safe half today.


## Implementation Summary

Implemented 2026-09-13. Added an unconditional `_isAllowedCrossSiteRequest` predicate to `LocalApiServer._handleRequest`, placed after the Host guard and before CORS mirroring, so no state-changing route is reachable without passing it. The predicate reuses `isAllowedOriginFor(this._bindPolicy, ...)` — the same list the Host guard and the WS upgrade auth use — and decides via `Sec-Fetch-Site` (reject `cross-site`/`same-site`, allow `none`/`same-origin`), trusted `Origin`, or a positive `X-Switchboard-Client` marker when no browser signal is present; `/health` is exempt so port discovery still works. Fixed the three token-exchange sites to skip `Set-Cookie: sb_session=` when the expected token is empty, corrected the trust-model comments in `_sendUnauthorized` and `bootstrap.ts`, and added the marker to every in-tree HTTP client (`cli.ts` `apiRequest` and `/auth/mint`, the Go `client.Transport`, `TaskViewerProvider`'s pre-check, and the two contract tests that POST to `LocalApiServer`). Added `src/test/board-csrf-guard-contract.test.js` (source invariants + behavioural assertions against a live `LocalApiServer`) and a `test:contract:board-csrf-guard` script. Compilation and automated tests were not run per the active instructions.

## Review Findings

Reviewed 2026-09-13; two MAJOR findings fixed. **The `test:contract:board-csrf-guard` suite was defined in `package.json:920` and invoked by no CI gate** — the only automated check on the feature's security-critical subtask ran nowhere, and it was RED at HEAD (2 of 23 assertions failing) with nothing reporting it; it is now wired into `.github/workflows/integration-tests.yml`. **The `Sec-Fetch-Site: same-site` arm allowed any method when no `Origin` was present**, so a state-changing POST walked through the guard whose purpose is state-changing POSTs; it now splits on method exactly as the no-signal branch does — GET/HEAD allowed (preserving the 2026-09-13 operator-lockout fix, since navigations and PWA launches are GETs), anything else requires the `X-Switchboard-Client` marker. Also de-brittled the marker assertion, which sliced a fixed 1600 characters from the function start and had stopped covering the code it asserts on as the guard grew. Files changed: `src/services/LocalApiServer.ts`, `src/test/board-csrf-guard-contract.test.js`, `.github/workflows/integration-tests.yml`; validation is `compile-tests` clean and the suite now 24/24 including a new same-site-navigation regression fence, with `tailscale-bind` 23/23, `loopback-hostname` 16/16, `loopback-invariance` and `tailnet-localapi-host-header` 8/8 unregressed.

## Deferred Findings

- MAJOR: the guard's trusted-origin predicate is `isAllowedOriginFor`, which accepts **any** loopback origin regardless of port, so a page on another local dev server (`http://localhost:8080`) sends an `Origin` the guard trusts and can still drive the board. This is not a slip — the plan's step 1a mandates that exact shared predicate, while its Edge-Case bullet ("allowing `same-site` would leave every other local dev server able to drive the board") demands the opposite. The plan contradicts itself; closing it needs a port-aware origin check, which is a design decision beyond this review. `src/services/LocalApiServer.ts:12274`
- MAJOR: the plan's stated acceptance ("the guard rejects `Sec-Fetch-Site: cross-site` **and** `same-site`") no longer matches the code, and did not before this review. `same-site` is not blanket-rejected because `ts.net` is on the Public Suffix List, making every tailnet node same-site with the board — the blanket reject was an observed total operator lockout on 2026-09-13. `cross-site`, the threat the plan is actually about, is still rejected unconditionally and a marker cannot override it. Recorded rather than reverted; the plan text is the stale half. `src/services/LocalApiServer.ts:12337`
- MAJOR: `_parseJsonBody` still ignores `Content-Type`, so the `enctype="text/plain"` no-preflight form vector the plan measured remains reachable by anything that passes the metadata guard. The plan lists this as an explicit non-goal and defers it to a follow-up; it is defence-in-depth behind the guard, not a hole the guard leaves open. `src/services/LocalApiServer.ts`
- NIT: `src/webview/sharedUtils.js:37` sets the marker on panel fetches, which are `same-origin` and would pass regardless. Harmless belt-and-braces; noted so it is not mistaken for a load-bearing requirement. `src/webview/sharedUtils.js:37`
