# Give VS Code a View onto the PTY Fleet — One Terminal World, Both Hosts

## Metadata

**Complexity:** 6
**Tags:** feature, frontend, ui, infrastructure, reliability
**Project:** Browser Switchboard

## Goal

Add a first-class Terminals view inside the VS Code extension that renders the PTY fleet, reusing `terminals.html` / `terminals.js` / the vendored xterm build verbatim from the shared panel module. Today the fleet is spawned **by** the extension but is visible **only** in a browser tab; VS Code can start those terminals and cannot see them.

At release there are two supported hosts — the VS Code extension and standalone (`npx switchboard`). Each currently renders a different terminal set, and neither can see the other's. That asymmetry is the reason dispatch has to ask "which surface is calling?" at all. Giving VS Code a view onto the fleet collapses the two sets into one that both hosts can display.

### Problem analysis and root cause

**Two disjoint terminal sets.** `TaskViewerProvider._isLikelyPtyDispatchTarget`'s own docstring states it plainly:

> *"PTYs live in the pty host child — not in `_registeredTerminals`, not in `vscode.window.terminals`, not in the `HostTerminal` seam"*

| Terminal set | Rendered in the browser cockpit | Rendered inside VS Code |
|---|---|---|
| PTY fleet (`ptyHost.js` child process) | ✅ Terminals panel | ❌ nothing |
| `vscode.window.terminals` | ❌ nothing | ✅ editor terminal panel |

`package.json` contributes **no** view for fleet terminals — a scan of `contributes.views` finds nothing terminal-related; only `switchboard.deregisterAllTerminals` / `switchboard.clearAllTerminals` commands, which operate on registered VS Code terminals. So the extension launches a fleet it cannot show.

**Why this matters beyond convenience.** Because each host can only render one set, every dispatch has to decide which set to target based on *who is calling*. That decision is carried by the `allowPtyFleet` / `apiOriginated` boolean threaded through ~92 sites across four provider files, defaulting to `false`, failing silently and positively — a dropped flag delivers to a terminal the caller cannot see and returns `true`. Once VS Code can render the fleet, terminal resolution becomes a question of *where the named terminal lives*, not *what kind of client asked*, and the surface concept has no remaining job.

**The mechanism already exists and is already running.** Verified live against the extension host on 2026-08-07:

- The pty host child is an **independently addressable WS server**. `TaskViewerProvider.ts:1901` spawns `dist/standalone/ptyHost.js`; it listens on its own port (observed: `127.0.0.1:62209`, confirmed via `lsof` against the child PID).
- The browser terminals panel connects **straight to it**, not through `LocalApiServer`: `terminals.js:4542` builds `${PTY_HOST_ORIGIN}/ws/terminal?name=…&token=…`, where `PTY_HOST_ORIGIN` comes from `document.body.dataset.ptyHostOrigin` (`terminals.js:80-82`). The served page carries `data-pty-host-origin="ws://127.0.0.1:62209"` and a `data-terminal-token`.
- Confirming the separation: the extension host does **not** wire `terminalWsGateway` into its `LocalApiServer` (no reference in `TaskViewerProvider.ts`), and an upgrade attempt against `/ws/terminal` on the API port is destroyed by the upgrade router's `else` branch. The gateway is constructed in `bootstrap.ts` for standalone only. The extension-served browser panel works regardless, because it never uses that route.
- Panel HTML already comes from the shared module — `headlessPanelHtml.ts:388-410` builds `terminals.html`, injects `{{TERMINALS_JS_URI}}`, the transport shim, `data-panel="terminals"`, host capabilities and the brand-icon set. `GET /terminals` returns 200 from the extension host today.

So the fleet, its transport, its auth token, its renderer and its HTML builder all exist and all run under the extension. The only missing piece is a VS Code webview that loads that HTML with webview-appropriate asset URIs and a CSP that permits the loopback WebSocket.

**Scope boundary.** This plan delivers the view. It does **not** change dispatch resolution or remove `allowPtyFleet` — that is a separate, dependent change (see Dependencies), and shipping it before the view exists would route prompts into terminals VS Code still cannot display.

## User Review Required

None.

## Complexity Audit

### Routine
- Registering a webview panel provider, a command, and a `package.json` contribution.
- Pointing `data-pty-host-origin` at the live `_ptyHostPort` and injecting the existing terminal token.

### Complex / Risky
- **Asset URIs must be rewritten for the webview, not forked.** `headlessPanelHtml.ts:399` rewrites `{{TERMINALS_JS_URI}}` to the HTTP path `/static/webview/terminals.js`. A webview cannot load that; it needs `webview.asWebviewUri(...)` values and matching `localResourceRoots` covering `src/webview/` **and** `src/webview/vendor/xterm/` (`xterm.js`, `xterm.css`, `addon-fit.js`, `addon-canvas.js`, `addon-webgl.js`). Add a **mode parameter** to the existing builder — do not copy the function. PRD contract #1 (anti-divergence): both hosts must render byte-identical panel HTML apart from the URI/CSP/bridge substitutions.
- **The transport shim must not be injected in webview mode.** `headlessPanelHtml.ts:407` injects `transport.js`, which replaces `acquireVsCodeApi` with an HTTP/WS shim. Inside a real webview the genuine VS Code bridge must be used instead. `terminals.js` consumes `acquireVsCodeApi()` either way, so this is a swap at the injection site, not a change to the panel script.
- **CSP `connect-src` is a deliberate departure from the house pattern.** Every existing webview CSP in this codebase sets `connect-src 'none'` (e.g. `KanbanProvider.ts:11645`). This view requires an outbound WebSocket. Research (2026-08-07) resolved the correct form: Chromium's CSP parser needs explicit loopback schemes with wildcard ports, and both the `ws:` and `http:` variants, i.e. `connect-src ws://127.0.0.1:* http://127.0.0.1:* ws://localhost:* http://localhost:*`. Pinning a single runtime port is **not** the recommended form. Keep it loopback-only — never `ws:` unqualified, never a non-loopback host.
- **The WS server will receive a `vscode-webview://` Origin header — and may reject it.** This is the most likely hard blocker. Webview documents run under `vscode-webview://<id>` on desktop and `https://<id>.vscode-cdn.net` on VS Code Web. `terminalWsGateway.handleUpgrade` authorizes via `authorizeWsUpgrade` with `rejectWhenTokenEmpty: true` (`terminalWsGateway.ts:780`); audit whether that path (or anything upstream) also validates `Origin` for anti-CSWSH. If it does, it must explicitly allow the webview origins or skip origin checks on loopback while keeping the token requirement. Verify before building the view — a correct panel against an origin-rejecting gateway looks identical to a broken panel.
- **The terminal token is a credential in page markup.** It already ships this way to the browser (`data-terminal-token`), and `headlessPanelHtml.ts:95-100` records a prior incident where a malformed `<body>` meant the token was never read and *"the fleet rendered terminals that accepted no input."* Reuse the same injection point and assert the token is present in a test rather than discovering it as a dead panel.
- **Capability gating — no dead view.** PRD contract #6. When `node-pty` is unavailable (`_ptyHostPort` undefined), the view must be absent or explicitly disabled with a reason, never an empty panel that looks broken. Mirror how `/panels` marks `terminals` from `ptyReady`.
- **xterm renderer selection inside a webview.** `terminals.js` selects WebGL, canvas or DOM renderers and has non-trivial resize/fit logic (`:152-260`) that depends on being able to measure a character cell. A webview that starts hidden or zero-sized is exactly the state that code guards against; confirm the guard holds on first reveal and on tab-switch, and confirm WebGL is available (falling back cleanly if not).

## Edge-Case & Dependency Audit

**Race Conditions**
- The pty host starts asynchronously and reports its port by message (`TaskViewerProvider.ts:1950`). Opening the view before the port arrives must wait or show a resolving state — not bake an `undefined` origin into the CSP.
- Pty host crash/restart yields a **new** port. The view must detect the change and reload with a fresh CSP and origin; a stale panel would silently fail to reconnect.

**Security**
- The WebSocket is authorized by `authorizeWsUpgrade` with `rejectWhenTokenEmpty: true` (`terminalWsGateway.ts:780`), so an unauthenticated connection is rejected. No new auth surface.
- Loopback only. The CSP must pin `127.0.0.1` and the specific port; do not accept a hostname that could resolve off-box.

**Side Effects**
- A terminal that was previously only reachable from a browser tab becomes interactive inside VS Code. Input, resize and clear all now have a second live client — verify the gateway's per-terminal handling with **two simultaneous clients** (browser tab + VS Code view) attached to the same terminal, including the sequence/replay logic (`lastSeq`) and the send lock.
- Nothing about `vscode.window.terminals` changes. Users who assigned roles to real VS Code terminals are unaffected by this plan.

**Dependencies & Conflicts**
- Touches `src/services/headlessPanelHtml.ts`, which is shared by both hosts. Standalone's `getTerminalsHtml` output must be **unchanged** — assert it, since a regression there breaks the browser cockpit that currently works.
- Concurrent terminals-panel work exists in the plan set (sidebar row controls, layout/labels). Coordinate on `terminals.js` / `terminals.html`; this plan should not modify panel behaviour, only how it is hosted.

## Dependencies

None (hard).

**Unblocks:** removal of the `allowPtyFleet` / `apiOriginated` surface flag and its ~92 threading sites. Once VS Code renders the fleet, dispatch can resolve a terminal by name/role across both sets and deliver where it lives, with no notion of caller surface. That follow-on must land **after** this plan, never before.

**Supersedes:** the request-context refactor in `dispatch-surface-as-request-context-not-threaded-flag.md`, which hardens the surface distinction rather than removing its cause. Prefer this route.

## Adversarial Synthesis

**Risk Summary.** The load-bearing risks are all at the webview boundary rather than in the fleet itself: a CSP that must break the codebase-wide `connect-src 'none'` convention without widening to a wildcard, asset URIs that must be rewritten without forking the shared HTML builder, and a runtime-assigned pty host port that both the CSP and the origin depend on. The second-order risk is dual-client behaviour — two attached clients on one terminal exercise replay and send-locking paths that a single browser tab never has. Mitigations: mode-parameterise the existing builder rather than copying it, assert standalone's output is byte-unchanged, build the CSP after the port is known and rebuild on change, and test two clients on one terminal explicitly.

## Proposed Changes

### `src/services/headlessPanelHtml.ts`
- **Context:** Shared panel HTML builder; the anti-divergence carrier for both hosts.
- **Logic:** Add a `host: 'browser' | 'webview'` mode to the terminals builder. In `webview` mode, resolve `{{TERMINALS_JS_URI}}` and the vendored xterm assets via a caller-supplied URI mapper (`asWebviewUri`), skip the `transport.js` injection, and emit a CSP whose `connect-src` names the pty host origin exactly. Everything else — body dataset, capabilities, brand icons — stays identical.
- **Edge Cases:** `browser`-mode output must be byte-identical to today; lock it with a snapshot test.

### `src/services/TerminalsPanelProvider.ts` (new)
- **Context:** VS Code webview panel host for the fleet view.
- **Logic:** Create the panel with `localResourceRoots` covering `src/webview/` and `src/webview/vendor/xterm/`; obtain `_ptyHostPort` and the terminal token from `TaskViewerProvider`; render via the shared builder in `webview` mode; reload on pty-host port change.
- **Edge Cases:** Absent/disabled when no pty host; wait for the port rather than rendering an undefined origin; dispose cleanly.

### `src/extension.ts` / `package.json`
- **Logic:** Register `switchboard.openTerminalsPanel` (via `registerSwitchboardCommand` so it is registry-reachable in-process, consistent with the other `switchboard.*` commands) and add the command + any view contribution to `package.json`.
- **Edge Cases:** Command must be hidden or report a clear reason when `node-pty` is unavailable — no dead entry in the palette.

### `src/services/TaskViewerProvider.ts`
- **Logic:** Expose the pty host port and terminal token through a narrow public accessor for the new provider. No change to dispatch or resolution logic in this plan.

## Verification Plan

Compilation and automated test execution are out of scope for this planning session; the checks below are specified for the implementing change.

### Automated
1. `browser`-mode terminals HTML is byte-identical to the pre-change output (snapshot) — proves standalone and the existing cockpit did not regress.
2. `webview`-mode HTML contains `vscode-webview`-resolved URIs for `terminals.js` and every vendored xterm asset, and contains **no** `transport.js` injection.
3. `webview`-mode CSP contains `connect-src` naming exactly `ws://127.0.0.1:<port>` — assert it rejects a wildcard and rejects an unset port.
4. The rendered body carries a non-empty `data-terminal-token` and a `data-pty-host-origin` matching the live port (the regression recorded at `headlessPanelHtml.ts:95-100`).
5. With `_ptyHostPort` undefined, the provider does not create a panel and the command reports a reason.

### Manual (VS Code extension host)
1. **It renders.** Open the Terminals view — the four fleet terminals (`planner-1`, `lead-1`, `reviewer-1`, `analyst-1`) appear with live scrollback.
2. **It is interactive.** Type into a fleet terminal from VS Code; output streams back.
3. **Dual client.** Open the same terminal in a browser tab *and* the VS Code view simultaneously — both render, input from either is delivered once, and neither corrupts the other's replay (`lastSeq`).
4. **Resize.** Resize the VS Code panel and toggle to another editor tab and back; the grid refits and the renderer does not blank.
5. **Restart resilience.** Kill the pty host; confirm the view reports the loss and recovers with the new port rather than silently failing to reconnect.
6. **No pty.** With `node-pty` unavailable, the view is absent or disabled with a stated reason — no dead click, no empty panel.
7. **Browser cockpit unaffected.** The standalone/browser terminals panel behaves exactly as before.
8. **Editor terminals untouched.** `vscode.window.terminals` and the existing register/clear commands are unchanged.

## Research findings — resolved 2026-08-07

Web research was run; all three uncertainties are answered and folded into the design above. Summary of what changed:

1. **Loopback WebSockets from a webview work.** Desktop VS Code treats `vscode-webview://` as a secure origin and `127.0.0.1`/`localhost` as inherently trustworthy, so no mixed-content block. Required CSP form is scheme-explicit with wildcard ports (see Complexity Audit) — not a pinned port. **New constraint discovered:** the gateway receives a `vscode-webview://` `Origin` header on the handshake and must not reject it.

2. **Remote scenarios need `asExternalUri`, and this is a real supported-configuration question.** Under Remote-SSH, Dev Containers, Codespaces and cloud-hosted forks, the extension host (and the pty host child) run remotely while the webview renders on the client — so `ws://127.0.0.1:<port>` targets the *client's* loopback and fails. The fix is `vscode.env.asExternalUri(http://127.0.0.1:<port>)` in the extension host, converting the returned `http:`/`https:` to `ws:`/`wss:` before handing the origin to the webview, and adding that resolved origin to `connect-src`. **Decision for this plan:** implement the `asExternalUri` path from the start rather than a local-only shortcut — Devin is a VS Code fork and remote configurations are in scope for a shipped extension. A local-only implementation would appear to work on this machine and fail for remote users.

3. **xterm renderers work in a webview, with a fallback chain and a fit guard.** Use WebGL → Canvas → DOM, registering `webglAddon.onContextLoss()` to dispose and drop to Canvas (context loss is expected on GPU sleep and in virtualized/remote desktops). For sizing, guard `fitAddon.fit()` on `clientWidth > 0 && clientHeight > 0`, drive it from a `ResizeObserver` on the container rather than `window.onresize`, and post a message from `panel.onDidChangeVisibility` so a panel created hidden or in a background tab fits on first reveal. `terminals.js:152-260` already reasons about the zero-cell case — extend it rather than duplicating it.

## Recommendation

Complexity 6 → **Send to Lead Coder.** The fleet, its transport, its auth and its renderer all already exist and already run under the extension — the work is a hosting layer. But it must mode-parameterise a shared builder without forking it, break the codebase-wide `connect-src 'none'` convention in a narrowly correct way, handle a runtime-assigned port in the CSP, and it opens a dual-client path the gateway has never served.
