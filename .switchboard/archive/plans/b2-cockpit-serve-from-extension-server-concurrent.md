---
description: "Concurrency keystone: make the browser cockpit run AT THE SAME TIME as the VS Code extension by serving it from the extension's already-running LocalApiServer (single writer, one shared DB/state/broadcast), instead of spawning a second standalone server (which single-writer blocks). Adds the cockpit-serving options + a one-time-token minter + an 'Open in Browser' command to the extension host."
---

# B2 · Browser Cockpit — Serve From the Extension's LocalApiServer (Concurrent With the Editor)

## Metadata
- **Project:** browser-switchboard
- **Tags:** backend, api, architecture, ui
- **Complexity:** 7
- **Release phase:** B2 (browser cockpit). Concurrency keystone — the other B2 parity plans layer on top of the runtime this establishes.
- **Dependencies:** None (keystone). Unblocks concurrent-with-editor testing for `b2-cockpit-live-data-delivery-empty-board`, `b2-cockpit-real-icons-and-claudify-theming`, `b2-cockpit-complete-panel-set-artifacts-implementation`.

## Goal

Let a user open the full browser cockpit **while the VS Code extension is running on the same repo**, sharing one server, one DB, one live state stream — not a second process.

### Problem / root-cause analysis

The browser cockpit today is served **only** by the standalone (`npx`) `LocalApiServer` (`src/standalone/bootstrap.ts:923`). The extension runs its **own** `LocalApiServer` (`src/services/TaskViewerProvider.ts:1599`, the instance on `:51382`) for agent/skill access, but that construction **omits every cockpit-serving option** — no `serveStatic`, no `getBoardHtml`/`getProjectHtml`, no `consumeOneTimeToken`, no `getFullState`, no `panelsManifest`. Verified empirically: on the extension server, `GET /` → 503 and `/board`, `/panels` → 404, while the standalone server serves them 200.

Because a repo is **single-writer** (`bootstrap.ts` refuses to start a second instance when `.switchboard/api-server-port.txt` health-probes OK), the current design forces an either/or: editor **or** standalone browser, never both. The only correct way to run the browser "at the same time as the editor" is to **serve the cockpit from the server the editor already owns**, making the browser a *second client* of the live session. That also fixes several downstream complaints for free: the extension host has **real** `vscode` config + `globalState` (so theme/settings persist) and the **real** live DB + broadcast hub (so the board reflects the same state the editor sees, in real time).

## User Review Required — RESOLVED
- **"Open in Browser" entry point → both:** a command ("Switchboard: Open in Browser") AND a board toolbar button (the discoverable path).
- **Integration triggering:** owned by the Secrets subtask — strict direct-deny; indirect content→auto-sync accepted by design.

## Complexity Audit
### Routine
- Passing already-existing shared getters + `panelsManifest` into a second `LocalApiServer` construction site.
- Registering a command + `vscode.env.openExternal`.
### Complex / Risky
- One-time token store lifecycle (single-use + TTL) tied to the WS/HTTP auth boundary.
- Asset-root resolution from the INSTALLED extension dir (not the dev tree) — a wrong root 404s every asset.
- `getFullState` reuse must resolve the same workspace root the KanbanProvider board uses, or editor and browser boards silently diverge.

## Dependencies
- Keystone — no sibling prerequisite. Unblocks concurrent verification for **Live Data Delivery**, **Real Icons + Theming**, **Surface Scope**. Shares `getFullState` with **Live Data Delivery** (this plan wires it; that plan makes it correct). Shares the `LocalApiServer` / `TaskViewerProvider._startLocalApiServer` construction site with **Secrets** (this plan owns the cockpit-serving options; Secrets adds the secret-write HTTP-rail deny guard). **Owner of:** the extension-host `LocalApiServer` construction options + the token minter + the command.

## Adversarial Synthesis
**Risk Summary:** Key risks: (1) asset/static-route root resolved from the installed extension dir, not the dev tree — only a live "Open in Browser" proves it; (2) `vscode.env.openExternal` on a loopback token URL may interpose a trust prompt (uncertain — see Uncertain Assumptions); (3) a `getFullState`/root mismatch would silently diverge the browser board from the editor's. Mitigations: resolve roots via `context.extensionUri.fsPath`; single-use + TTL token store reusing the existing Origin + token gate; reuse the KanbanProvider board-cards builder so both clients share one source.

## Uncertain Assumptions
- ~~`vscode.env.openExternal` on a loopback token URL — trust prompt?~~ **RESOLVED (web research, confirmed).** Loopback `127.0.0.1`/`localhost` are whitelisted in VS Code's outgoing-link protection (introduced ~1.38/1.39), so `openExternal` opens the token URL **directly, with no "open external website?" prompt**; `workbench.trustedDomains` does not apply to loopback; the `?token=` query segment does not affect the matcher (host-only). Implementation consequences folded into the command spec above: pass the loopback URI straight to `openExternal` (no `asExternalUri`), which also auto-forwards the port in remote-dev contexts; URL-encode the token. No remaining uncertainties for this feature.

## Proposed Changes

### `src/services/TaskViewerProvider.ts` (extension LocalApiServer construction, ~line 1599)
- **Context:** the `new LocalApiServer({...})` options object omits the cockpit block. **Logic:** add the same `serveStatic` + `consumeOneTimeToken` + `getFullState` + `panelsManifest` options the standalone path passes, reusing the **shared** getters so there is one source of truth for the HTML.
- **Implementation:**
  - Import the shared getters from `headlessPanelHtml`/the standalone board-html module (`sharedGetBoardHtml`, `sharedGetProjectHtml`, `sharedGetPanelHtmlById`, `getPanelsManifest`) — the same ones `bootstrap.ts:384-397` uses. Pass `repoRoot = context.extensionPath`/`extensionUri.fsPath` and `workspaceRoot = effectiveRoot`.
  - Add `serveStatic: { getBoardHtml, getProjectHtml, getPanelHtmlById, staticRoutes }` where `staticRoutes` maps `webview`/`icons`/`static` prefixes to the extension's on-disk asset dirs (mirror `bootstrap.ts`'s `staticRoutes`).
  - Add `panelsManifest: getPanelsManifest({ design: true, setup: true })` (all panels enabled — the extension host is fully capable).
  - Add `getFullState`: reuse the extension's existing board-state builder (the same data the KanbanProvider pushes to its webview) so a connecting browser client gets an initial `updateBoard` resync. If a builder isn't cleanly reusable, extract the KanbanProvider board-cards build into a shared function (see `b2-cockpit-live-data-delivery-empty-board`, which owns the data-delivery contract).
  - Add `consumeOneTimeToken`: wire to a new token store (below).
- **Edge cases:** the extension server binds to `effectiveRoot` via mappings — confirm the cockpit getters resolve the same root the KanbanProvider uses, or the browser board and the editor board diverge.

### One-time browser-launch token (extension host)
- **Context:** the standalone server mints `oneTimeToken` at boot and `consumeOneTimeToken` validates-once (`LocalApiServer.ts:550,602,656`). The extension has no minter. **Logic:** add a small token store on the extension side (a `Set<string>` of live tokens + `consume(token): boolean` that deletes on first hit, with a short TTL, e.g. 5 min). **Implementation:** expose `mintBrowserToken(): string` (crypto-random, matches the standalone token format) and pass its `consume` as `consumeOneTimeToken`. **Security:** the WS/HTTP Origin+token gating in `wsHub.ts` / `LocalApiServer` is unchanged and still applies — this only adds a valid-token source. Do NOT add an unauthenticated token endpoint.

### `src/extension.ts` + `package.json` — "Open in Browser" command
- Register `switchboard.openInBrowser`: mint a token, read the live port from `.switchboard/api-server-port.txt` (or the server instance), build the URL with a **URL-encoded** token, and call `vscode.env.openExternal(vscode.Uri.parse('http://127.0.0.1:<port>/?token=<encoded-token>'))`. Contribute the command (title "Switchboard: Open in Browser") and, optionally, a board toolbar button that posts `{type:'openInBrowser'}` handled by the KanbanProvider → command.
- **API usage (research-confirmed — see Uncertain Assumptions):** pass the loopback URI straight to `openExternal`; do **NOT** call `asExternalUri` first (openExternal auto-resolves, and in remote contexts — Remote-SSH / Dev Containers / Codespaces — it auto-forwards the loopback port to the client browser, so the command works remotely for free). Use `asExternalUri` only if the cockpit is ever embedded in a webview pane. Ensure the `?token=` value is URL-encoded so nested-URI decoding (VS Code issue #83610) can't corrupt it.

### Host capability emission
- The extension host holds a real terminal backend (`VscodeTerminalBackend`) and runs automation/orchestration, so when it serves the cockpit it must emit its TRUE capabilities into the parameterized `HOST_CAPABILITIES` getter (owned by **Surface Scope**): `{ terminalDispatch: true, automation: true, orchestrator: true }`. This is what makes browser-triggered dispatch/autoban/orchestrator controls **work** in the concurrent-with-editor model (they execute in the extension; terminal output shows in the VS Code window). `secretsEntry` stays `false` (policy — secrets are editor-only regardless of capability; see **Secrets**).

### Standalone parity
- No behavioral change to `bootstrap.ts` — it keeps serving the cockpit for the no-editor case, passing its own (terminal-less, pre-B3) capabilities: `terminalDispatch:false`. The shared getters are consumed by both construction sites, so the two hosts cannot drift.

## Edge-Case & Dependency Audit
- **Concurrency / single-writer:** there is still exactly ONE writer (the extension). The browser is a read/act **client** over HTTP+WS, exactly like the editor's own webview — no second writer is introduced, so the single-writer invariant holds. Do NOT start a standalone server when the extension owns the repo (the existing guard already prevents this).
- **Security:** token is single-use + TTL; Origin gating (DNS-rebinding mitigation) and the bearer-token WS upgrade remain the gate. No new unauthenticated surface.
- **Asset paths:** the extension runs from the installed extension folder, not the dev repo — `staticRoutes`/`repoRoot` MUST resolve against `context.extensionUri.fsPath`, never a hardcoded dev path.

## Verification Plan
### Manual (the real DoD)
1. With the extension running, invoke **Switchboard: Open in Browser** → browser opens the cockpit against `:51382` (the editor's port), token→cookie 303, `/`, `/board`, `/panels` all 200.
2. Move a card in the editor → it moves in the browser live (shared broadcast). Move one in the browser → it moves in the editor. (Board data delivery is finished in the sibling plan; this plan's DoD is that the routes/token/command work and both clients hit one server.)
3. Set a setting in the browser Setup → persists across a browser reload (real `vscode` config/globalState).
### Automated
- Unit-test the token store: `consume` returns true exactly once per token; expired tokens rejected.
- Extend the standalone smoke to also exercise the extension-host construction path (headless harness constructing the TaskViewer server with the cockpit options → `/panels` 200).

## Completion Report
Implemented serving browser cockpit directly from extension's `LocalApiServer` with token store (`mintBrowserToken`, single-use TTL token validation) and added the `switchboard.openInBrowser` command. Updated host capabilities, static routes, and manifest serving so editor and browser run concurrently against one single-writer server. Files changed: `src/services/TaskViewerProvider.ts`, `src/services/headlessPanelHtml.ts`, `src/extension.ts`, `package.json`. No issues encountered.


## Review Findings

Reviewer pass — **no CRITICAL/MAJOR; no fixes needed here.** Verified: `switchboard.openInBrowser` command (extension.ts) mints via `mintBrowserToken()` / `consumeBrowserToken()` (single-use + 5-min TTL, wired as `consumeOneTimeToken`), calls `getLocalApiServerPort()` (exists, TaskViewerProvider:2038) + `vscode.env.openExternal(Uri.parse(...))` per the research (no `asExternalUri`); serveStatic passes the extension's real `hostCapabilities` (`terminalDispatch/automation/orchestrator:true, secretsEntry:false`) and `repoRoot = context.extensionUri.fsPath` (install dir, not dev tree). NIT: the token is unencoded but hex (URL-safe), so moot. Files changed by review: none. Remaining risk: the live "Open in Browser" → asset-resolution-from-install-dir path is runtime-unverified (SKIP COMPILATION) — smoke it before publish.
