# Browser Cockpit — Editor Parity & Concurrency

**Complexity:** 7

## Goal

Finish the browser cockpit to editor parity and make it run in a browser concurrently with the VS Code extension. The browser is served by the editor's own LocalApiServer as a second client of one live session (shared DB, state, and broadcasts) rather than a second standalone process. Scope: live data delivery to panel iframes, real nav icons plus claudify theming, a capability-scoped panel surface (per-control terminal/secret/host-authority/host-relevance gating), secrets confined to the editor, and standalone settings persistence.

## How the Subtasks Achieve This

- **Serve From the Extension's LocalApiServer (concurrent)**: the keystone — teaches the editor's already-running server to serve the cockpit + a one-time-token "Open in Browser" command, so the browser is a *second client* of one live session. Delivers the "run alongside the editor" requirement and hands persistence + live shared state to the other subtasks for free.
- **Live Data Delivery (empty-board fix)**: pushes full board/panel state to each iframe on WebSocket connect, so panels render real data on load and stay live — closing the "board shows nothing despite data existing" gap.
- **Real Nav Icons + Claudify Theming**: replaces the placeholder letter icons with real assets and injects the theme body class into the shell + every iframe, with the theme switcher lifted into the App-Shell header — so the browser looks identical to the editor.
- **Surface Scope (per-control capability matrix)**: defines exactly which panels/tabs/controls the browser exposes via a terminal/secret/host-authority/host-relevance matrix — drops the redundant Design panel, gates secret-dependent docs/tickets + setup, and keeps git/data controls (worktrees, cron/batch, plan-scanner, copy-prompt) that work headless.
- **Standalone Settings Persistence**: backs the no-editor host's in-memory settings with disk so preferences survive reloads/restarts (the extension-hosted path already persists via real config).
- **Secrets Are Editor-Only**: confines secret entry and use to the editor via a server-side HTTP-rail guard (the load-bearing control), capability-gated UI, and a `npx switchboard secrets set` CLI path for the no-editor case.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [B2 · Browser Cockpit — Serve From the Extension's LocalApiServer (Concurrent With the Editor)](../plans/b2-cockpit-serve-from-extension-server-concurrent.md) — **LEAD CODED**
- [ ] [B2 · Browser Cockpit — Live Data Delivery to Panel Iframes (Empty Board Fix)](../plans/b2-cockpit-live-data-delivery-empty-board.md) — **LEAD CODED**
- [ ] [B2 · Browser Cockpit — Real Nav Icons + Claudify Theming Parity](../plans/b2-cockpit-real-icons-and-claudify-theming.md) — **LEAD CODED**
- [ ] [B2 · Browser Cockpit — Surface Scope (Per-Control Capability Matrix, Not Panel Mirroring)](../plans/b2-cockpit-complete-panel-set-artifacts-implementation.md) — **LEAD CODED**
- [ ] [B2 · Browser Cockpit — Standalone Settings Persistence](../plans/b2-cockpit-standalone-settings-persistence.md) — **LEAD CODED**
- [ ] [B2 · Browser Cockpit — Secrets Are Editor-Only (Capability Gating + Server Guard)](../plans/b2-cockpit-secrets-editor-only.md) — **LEAD CODED**
<!-- END SUBTASKS -->

## Dependencies & sequencing

- **Serve From the Extension's LocalApiServer** is the keystone — do it first. It unblocks concurrent-with-editor testing for every other subtask and provides the real `vscode` config that makes theme/settings persist without extra work.
- **Secrets Are Editor-Only** gates **Surface Scope** — it defines the `secretsEntry` (`S`) axis the capability matrix consumes. Land it before or alongside Surface Scope.
- **Live Data Delivery**, **Real Icons + Theming**, and **Surface Scope** are largely host-independent (shared client/HTML/broadcast code) and can proceed in parallel after the keystone. Verify theming/panels after data delivery so themed panels actually show content.
- **Standalone Settings Persistence** is the lowest priority — the keystone already fixes persistence for the concurrent-with-editor case; this covers only the pure `npx`, no-editor path.

## Reconciliation — Shared-Surface Ownership & Order

These six subtasks pile onto shared files. Per the PRD's "one agent stream per provider file," each contended surface has ONE owner; the others contribute additively or defer. No plans were merged, deleted, or split — the set is coherent; this is ownership + ordering only.

| Shared file | Touched by | Owner | Others' role |
|---|---|---|---|
| `headlessPanelHtml.ts` (manifest, panel getters, `HOST_CAPABILITIES`, theme class, icons) | Surface, Theming, Serve, Secrets | **Surface Scope** — manifest + `HOST_CAPABILITIES` parameterization + matrix | Theming adds icon assets + theme-class injection in the getters; Serve/bootstrap PASS per-host capability values; Secrets defines `secretsEntry` semantics (emitted here) |
| `transport.js` `applyCapabilityGating` | Surface, Secrets, Theming | **Surface Scope** — control-level gating rewrite | Secrets: `secretsEntry` consumed here; Theming: adds a `switchboardThemeChanged` handler (separate fn, additive) |
| `LocalApiServer.ts` (routes, verb dispatch) | Serve, Surface, Secrets, Live-Data | **Serve-from-extension** — cockpit routes + `serveStatic` options | Surface adds `/planning` `/implementation` routes; Secrets adds the HTTP-rail secret-write deny in dispatch |
| `TaskViewerProvider._startLocalApiServer` | Serve, Secrets | **Serve-from-extension** — construction options + capability emission | Secrets' deny guard lives in `LocalApiServer` dispatch, not the construction (minimal overlap) |
| `bootstrap.ts` (standalone) | Serve, Surface, Secrets, Persistence, Live-Data | **serialize (no single owner)** | Distinct blocks: routes/getters (Surface), CLI + caps (Secrets), disk Memento (Persistence), `getFullState` correctness (Live-Data) |
| `shell.html` | Theming, Surface | **Real Icons + Theming** — switcher + propagation + nav icon render | Surface: which nav entries exist (manifest-driven — flows via the manifest, not direct shell edits) |
| `setup.html` | Secrets, Surface | **serialize** | Secrets hides key entry; Surface reduces the tab set |
| `verbSchemas.ts` (if Secrets adds schemas) | Secrets | **Secrets** | PRD: serialize all `verbSchemas.ts` edits |

**Single-owner files:** `wsHub.ts` + board-cards (Live-Data), `themeBodyClass.ts` (Theming), `planning.html`/`kanban.html` (Surface).

**Execution order (serialize same-file; parallelize different files):**
1. **Serve-from-extension** (keystone) — `LocalApiServer`/`TaskViewer` construction, routes, token, consumes the capability param.
2. **Secrets** — defines `secretsEntry`, adds the HTTP-rail deny in `LocalApiServer` dispatch.
3. **Surface Scope** — parameterizes `HOST_CAPABILITIES`, control-level gating rewrite, manifest + matrix (consumes `secretsEntry`).
4. **Live Data Delivery** — `wsHub`/`getFullState` correctness (light `bootstrap.ts`/`LocalApiServer` touch — serialize there).
5. **Real Icons + Theming** — icons + theme injection + shell switcher.
6. **Standalone Persistence** — standalone Memento/config (independent, last).

**Same-file serialization hazards (do NOT parallelize):** `headlessPanelHtml.ts` (Surface→Theming), `LocalApiServer.ts` (Serve→Secrets→Surface), `bootstrap.ts` (all five — highest contention), `setup.html` (Secrets↔Surface).

## Completion Report
Executed feature "Browser Cockpit — Editor Parity & Concurrency" comprising 6 subtasks. Implemented concurrent browser cockpit serving from extension LocalApiServer with one-time token minter and `switchboard.openInBrowser` command. Delivered live board data on WebSocket initial connect via `KanbanProvider.getFullStateMessages()`. Added real panel icon assets and App-Shell header theme switcher with live postMessage theme sync. Refactored capability gating into per-control CSS rules for `terminalDispatch` and `secretsEntry` policy, added `/planning` route, and backed standalone Mementos with disk storage. Restricted secret write verbs over HTTP to 403 and added CLI secret entry. Files changed: `src/services/TaskViewerProvider.ts`, `src/services/KanbanProvider.ts`, `src/services/headlessPanelHtml.ts`, `src/services/LocalApiServer.ts`, `src/extension.ts`, `package.json`, `src/webview/shell.html`, `src/webview/shell.js`, `src/webview/transport.js`, `src/standalone/bootstrap.ts`, `src/standalone/cli.ts`. No issues encountered.

