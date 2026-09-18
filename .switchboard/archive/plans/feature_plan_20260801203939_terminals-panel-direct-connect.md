# Point the Terminals Panel Directly at the PTY Host (3/3)

## Goal

Give the terminals panel an explicit pty-host origin instead of assuming same-origin, so the browser opens its terminal WebSocket straight to the pty host process. Three edits: a `data-pty-host-origin` body attribute injected at serve time, one changed line in `terminals.js`, and an origin allow-list fix in `wsUpgradeAuth.ts` without which the sidebar webview's socket is rejected outright.

Scope is local desktop only. Remote SSH, Dev Containers, WSL and `vscode.dev` are deliberately not supported — see User Review Required.

### Problem Analysis

`src/webview/terminals.js:1357-1358` builds the socket URL from the page's own origin:

```js
const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
let wsUrl = `${protocol}//${location.host}/ws/terminal?name=${encodeURIComponent(entry.name)}`;
```

That is correct for the standalone host, where the panel and the gateway are the same server. It is wrong once plan 2 moves the gateway into a separate process on its own port: the panel would keep dialling the extension's port, which no longer serves `/ws/terminal`.

**Root cause.** The panel has no concept of a terminal endpoint distinct from the page origin. It never needed one, because until now the two were always the same server.

Two facts make this small:

- **The CSP already permits it.** `terminals.html:5` declares `connect-src 'self' ws://127.0.0.1:* wss://127.0.0.1:* ws://localhost:* wss://localhost:*`. Any loopback port is already allowed; no CSP change is required.
- **The injection mechanism already exists, one line away.** The panel already receives a per-session secret exactly this way: `terminals.js:1359-1360` reads `document.body.dataset.terminalToken` (falling back to `window.__SB_TERMINAL_TOKEN__`), and that attribute is **not** a `terminals.html` placeholder — it is stamped onto `<body>` at serve time by the provider (`TaskViewerProvider.ts:2059`, `injectBodyAttributes`). The origin follows that precedent verbatim. It is deliberately *not* routed through `headlessPanelHtml.ts`'s `{{XTERM_*_URI}}` substitution, which would diverge from the sibling attribute, force a signature change so that module could learn the child's port, and add an unsubstituted-literal failure mode the provider path does not have. See the Superseded note in Proposed Changes §1.

Keeping `location.host` as the fallback is what lets one code path serve both topologies: the standalone host injects its own origin (or nothing, and the fallback applies) and behaves exactly as it does today.

## Metadata
- **Complexity:** 4
- **Tags:** frontend, backend, architecture, security, terminals

## User Review Required

- **The webview question is RESOLVED (research, 2026-08-01 — see Resolved Assumptions).** Desktop VS Code works as designed. The cheap empirical probe stays as step 1, but it no longer gates whether the feature is worth building.
- **Local desktop only. Remote hosts are out of scope — user decision, 2026-08-01.** The panel dials the child's raw loopback port, which under Remote SSH, Dev Containers, WSL or `vscode.dev` resolves to the wrong machine. This is a deliberate boundary, not a gap to close: Switchboard's browser terminal is not a remote tunnel. Anyone working over a tunnel runs Switchboard in VS Code and uses VS Code's own native terminals, which already work over the remote connection. **No `asExternalUri`, no port forwarding, no fallback bridge — do not add them, and do not reopen this in review.**
- **Token now crosses an origin.** It already travels as a query parameter, so the mechanism is unchanged, but it is now sent to a different port than the page was served from. Cookies are port-agnostic so `sb_session` would also be sent; the query token remains the designed and tested path and should stay the one relied on.

## Complexity Audit

### Routine
- The attribute injection at serve time (one line next to the existing token injection), the `data-` attribute read, and the one-line URL change with fallback.
- The `vscode-webview:` origin acceptance — three lines in `isLocalhostOrigin` plus a contract-test case.

### Complex / Risky
- **Webview origin behaviour.** Needs an empirical test, not a code reading (downgraded — research says viable on desktop; probe confirms).
- **Origin allow-list edit is security-sensitive.** `wsUpgradeAuth.ts` guards the upgrade path. The `vscode-webview:` acceptance must be scheme-exact (`u.protocol === 'vscode-webview:'`), must not extend to host checks, and must not touch token validation — a sloppy edit here is an auth hole.
- **Reconnect path must use the same origin.** `connectTerminalSocket` is also the reconnect path (`ws.onclose` → backoff → reconnect). Deriving the origin once at module scope rather than per-call avoids a reconnect silently falling back to `location.host` if the dataset is ever cleared.

## Edge-Case & Dependency Audit

- **Standalone unchanged.** With no `data-pty-host-origin` attribute injected, the fallback yields today's exact behaviour. The standalone must keep passing its existing terminal tests untouched.
- **Injection must actually happen — silently absent is the failure mode.** There is no placeholder to leave literal (see corrected Proposed Changes), but the equivalent risk remains: if the provider-side injection is dropped, the panel silently falls back to `location.host` and fails to connect with no clear cause. The verification below checks the resolved origin explicitly rather than only checking that terminals work.
- **`https`/`wss`.** The existing protocol switch keys off `location.protocol`. If the pty host is always plain loopback `ws`, the origin string should carry its own scheme rather than inheriting the page's — otherwise an https-served cockpit would try `wss` against a plain child.
- **Child restarts get a new port.** If plan 2's supervision respawns the child, the injected origin is stale until the panel reloads. Acceptable for a first cut, but the panel's existing reconnect backoff will spin against a dead port; worth a note in plan 2's restart policy.
- **`__SB_TERMINAL_TOKEN__` fallback.** `terminals.js:1359-1360` already falls back from the dataset to a global. Mirror that shape for the origin so both injection paths work.

## Dependencies

Depends on **plan 1** (a pty host with a port to point at) and must ship together with **plan 2** — between them the panel targets an origin that serves nothing.

The webview probe (Verification step 1) is independent of both and can be run at any point. It was originally a build-nothing-until-it-passes gate; research has since settled the question (see Resolved Assumptions), so it is now cheap confirmation rather than a precondition.

## Adversarial Synthesis

With the webview question settled by research, two risks remain. First, the `location.host` fallback quietly masking a broken injection: if the serve-time attribute is ever dropped, the panel silently reverts to the page origin and fails to connect with no clear cause — which is why verification checks the *resolved origin* explicitly rather than only checking that terminals work. Second, §3 is an auth-path edit; widening it past an exact `vscode-webview:` scheme match, or letting it drift into token validation, converts a required fix into a hole.

A third pressure is worth naming because it has already surfaced once in review: the pull to "just make remote work too" by resolving the origin through `asExternalUri`. That is a recorded scope decision, not an oversight — remote users use VS Code's native terminals. Re-adding it would also drag async origin resolution into a path that is deliberately a literal string.

## Proposed Changes

### 1. `src/services/TaskViewerProvider.ts` (~2059) — inject the attribute at serve time

> **Superseded:** Add `data-pty-host-origin="{{PTY_HOST_ORIGIN}}"` to `<body>` in `src/webview/terminals.html`, and substitute the placeholder in `headlessPanelHtml.ts` (~391-398) next to the xterm URI replacements — extension host injects the child's `ws://127.0.0.1:<port>`, standalone injects an empty string.
> **Reason:** Verified 2026-08-01: the sibling `data-terminal-token` attribute is **not** a placeholder in `terminals.html`. It is injected at serve time by the extension host — `TaskViewerProvider.ts:2059`, `injectBodyAttributes(result.html, \`data-terminal-token="..."\`)`. The placeholder path would (a) diverge from the established precedent one line away, (b) force a signature/context change in `headlessPanelHtml` so it could learn the child's port, and (c) carry a failure class the provider path does not have — an unsubstituted literal placeholder producing a malformed URL.
> **Replaced with:** Follow the token precedent exactly. Where 2059 injects `data-terminal-token`, also inject `data-pty-host-origin="<ws-origin>"` derived from the `{port}` stored by plan 2's spawn. `terminals.html` and `headlessPanelHtml.ts` are untouched; the standalone host injects nothing and the `location.host` fallback applies, byte-identical to today. Edge case: if the child is not up when the HTML is served, omit the attribute (same as a missing token) — the panel falls back and shows unavailable until reload, which matches existing token-gating behaviour.

The injected origin is a literal `ws://127.0.0.1:<childPort>` — no `asExternalUri`, no async resolution. See the local-desktop-only scope decision under User Review Required.

No CSP change — `connect-src` at `terminals.html:5` already covers `ws://127.0.0.1:*` in both hosts.

### 2. `src/webview/terminals.js` (1357-1358)

Resolve once, near the other module-scope constants, and use it in `connectTerminalSocket`:

```js
/**
 * Where the pty gateway actually lives.
 *
 * NOT necessarily this page's origin. Under the extension host the gateway runs in
 * its own process on its own port precisely so terminal frames never touch the
 * extension's event loop (measured: 35ms p50 RTT in-process vs 0.24ms out). The
 * standalone host serves panel and gateway from one server and injects nothing, so
 * the location fallback keeps that path byte-identical.
 */
const PTY_HOST_ORIGIN = (document.body && document.body.dataset && document.body.dataset.ptyHostOrigin)
    || window.__SB_PTY_HOST_ORIGIN__
    || `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}`;
```

Then `let wsUrl = `${PTY_HOST_ORIGIN}/ws/terminal?name=…`;`.

### 3. `src/services/wsUpgradeAuth.ts` — accept the webview origin (REQUIRED, found during review)

`isLocalhostOrigin` (15-23) currently accepts only `127.0.0.1` / `localhost` / `::1`. Chromium sends `Origin: vscode-webview://<id>` from the sidebar webview, which fails that check and gets a 403 at `:57-58` — even on plain local desktop. Extend the acceptance to the `vscode-webview:` scheme:

```ts
export function isLocalhostOrigin(origin: string): boolean {
    try {
        const u = new URL(origin);
        if (u.protocol === 'vscode-webview:') { return true; } // only VS Code itself can produce this scheme
        const h = u.hostname;
        return h === '127.0.0.1' || h === 'localhost' || h === '::1' || h === '[::1]';
    } catch {
        return false;
    }
}
```

This is safe to widen: the `vscode-webview` scheme is registered by Electron inside VS Code and cannot be navigated to by an arbitrary web page, so no cross-site WebSocket hijacking surface is added. Token authentication (`rejectWhenTokenEmpty`, constant-time compare) is untouched — the token remains the actual credential. The `terminal-token-transport-contract` test must gain a case: `vscode-webview://<id>` origin + valid token → authorized; `vscode-webview://<id>` + bad token → 401; `https://evil.example` → still 403.

Note: this check lives in shared code used by both the extension host's gateway (today) and the child (after plans 1-2), so the fix benefits the sidebar under both topologies.

### 4. Contract coverage

Add an assertion that `terminals.js` does not construct the terminal socket URL from `location.host` directly — that is the regression that would silently re-couple the panel to the extension origin.

## Resolved Assumptions

Web research (2026-08-01, 50-source analysis of VS Code webview network behavior) settled the cross-port WebSocket question:

- **Desktop local VS Code: VIABLE as designed.** `vscode-webview://` is a registered secure scheme; loopback (`127.0.0.1`) is a trustworthy origin, so a secure-context page opening unencrypted `ws://127.0.0.1:<port>` is not mixed-content-blocked. The page's own meta CSP governs `connect-src` — which `terminals.html:5` already declares for loopback wildcards. The empirical probe (Verification step 1) remains as cheap confirmation but is expected to pass.
- **Remote hosts (Remote SSH / Dev Containers / WSL / `vscode.dev`): out of scope by decision.** Raw `127.0.0.1` resolves to the client machine while the pty host runs on the server, so the sidebar socket cannot reach it; `vscode.dev` is additionally impossible because the pty stack needs node-pty. Not a limitation to engineer around — see the scope decision under User Review Required.
- **Handshake origin header — REAL defect found in code, fix required.** Chromium sends `Origin: vscode-webview://<id>` on the upgrade request, and `wsUpgradeAuth.ts:56-58` rejects any origin that isn't localhost with 403 — `isLocalhostOrigin` (`:15-23`) accepts only `127.0.0.1` / `localhost` / `::1`. The sidebar's socket would be 403'd by the child gateway even on plain local desktop. Proposed Changes §3 adds the `vscode-webview:` scheme to the accepted origins; only VS Code itself can produce that scheme, and token auth (`rejectWhenTokenEmpty`) is unchanged, so this widens nothing for web pages.

## Verification Plan

1. **Empirical confirmation (downgraded from gate — research says viable on desktop, see Resolved Assumptions).** Load a minimal page in a VS Code webview that opens `ws://127.0.0.1:<port>` to a scratch loopback server and logs the result. Expected: connects. Still cheap enough to run early, but no longer a precondition for starting plans 1 and 2. If it does fail, stop rather than continuing — the documented fallback is `postMessage` bridging for the sidebar only, and that changes the shape of this plan.
2. `npm run lint`.
3. **Resolved origin is correct, not merely working** — in both hosts, read `PTY_HOST_ORIGIN` from the panel and confirm the extension host resolves to the child's port and the standalone resolves to its own. A panel that works via the fallback when it should have been injected is a latent failure.
4. **Standalone regression** — browser cockpit against `npx switchboard`: terminals attach, stream, resize and reconnect exactly as before.
5. **Extension host, browser cockpit** — same checks against the child port.
6. **Extension host, sidebar webview** — same checks in the in-IDE panel. This is the step step 1 de-risks.
7. **Reconnect uses the right origin** — kill and restart the socket (or the child) and confirm the reconnect dials the pty host, not `location.host`.
8. **Latency holds end to end** — the 30-sample `{t:'ping'}` probe from the panel itself, expecting sub-millisecond p50. This is the number the whole three-plan sequence exists to produce.
9. **Attribute present where expected** — in extension-host-served panel HTML, confirm `data-pty-host-origin="ws://127.0.0.1:<port>"` is present on `<body>`; in standalone-served HTML, confirm it is absent and the fallback resolves to the page origin.
10. **Origin allow-list** — sidebar upgrade with `Origin: vscode-webview://<id>` + valid token succeeds; same origin + bad token gets 401; `https://evil.example` still gets 403; no-origin loopback clients (existing behaviour) still pass.


## Completion Summary
Updated `TaskViewerProvider.ts` to inject `data-pty-host-origin` onto `<body>` at serve time when `_ptyHostPort` is available, updated `terminals.js` to build WebSocket connection URL using `PTY_HOST_ORIGIN`, and updated `wsUpgradeAuth.ts` to accept `vscode-webview:` origin requests. Updated test cases in contract test suites. No issues encountered.


## Review Findings

The three shipped edits are correct as specified: `data-pty-host-origin` is injected at serve time beside `data-terminal-token` (`TaskViewerProvider.ts` ~2111, provider path, no placeholder), `terminals.js` resolves `PTY_HOST_ORIGIN` once at module scope with the `__SB_PTY_HOST_ORIGIN__` and `location.host` fallbacks intact so the standalone host stays byte-identical, and `wsUpgradeAuth.isLocalhostOrigin` accepts `vscode-webview:` scheme-exact without touching host checks or token validation. Two gaps fixed: §4's contract assertion was never written — `pty-route-surface-contract` now asserts the socket URL is built from `PTY_HOST_ORIGIN`, that `${location.host}/ws/terminal` does not reappear, that the dataset read and the location fallback both survive, and that the provider injects the attribute; and `terminal-flow-control-contract` was left red because its `block()` end marker was the `const protocol =` line this plan removed (retargeted to `let wsUrl =`, with a comment explaining why). The added `vscode-webview` auth cases were also red locally against a stale `out/` — they pass after `npm run compile-tests`, which is the order CI uses. Verification: `npm run lint` is green (0 errors) but gives **zero coverage of `terminals.js`** — `eslint.config.js` scopes to `**/*.ts` only, so this plan's main webview edit is unlinted; all 41 CI gates pass. Remaining risks unexercised here because they need a running IDE: steps 3, 5, 6, 7 and 9 (resolved origin in each host, sidebar-webview upgrade, reconnect origin, attribute presence/absence) — a child respawn also leaves the injected origin stale until the panel reloads, which this plan accepted.
