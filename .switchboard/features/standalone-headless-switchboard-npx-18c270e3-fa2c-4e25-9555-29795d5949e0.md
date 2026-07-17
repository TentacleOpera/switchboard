# Standalone Headless Switchboard (npx)

**Complexity:** 7

## Goal

Make Switchboard **editor-independent**: `npx switchboard` boots the whole board and its planning/management workflow in a plain browser with no VS Code involved. The end-state is that **VS Code becomes one optional host, not a requirement** — specifically an optional *terminal holder* for users who want hands-off, in-editor CLI-agent execution. Everyone else — notably users driving a GUI agent like Claude Desktop — gets a headless browser cockpit that works entirely through **Copy Prompt** (generate prompt → paste into your agent → agent edits files → the board updates as files change). This is the payoff of the Host-Agnostic Verb Engine (A2a/A2b): the same `src/webview/*` UI runs over plain HTTP + WebSocket instead of the VS Code bridge.

**Product principle — host-adaptive UI.** The browser board must detect what the active host can actually deliver and **surface only those pathways**. A headless host with no terminal fleet must not offer terminal/CLI-dispatch, autoban, or orchestrator buttons that would silently no-op; it presents the Copy-Prompt + board-management workflow only. When VS Code (or a node-pty fleet) is the host, the full CLI/automation surface appears. Capability is derived from whether the host's `TerminalBackend` seam is live — not guessed.

**Two coexisting run modes (same `.switchboard/` + `kanban.db`):**
- **Extension-as-engine (VS Code running):** full surface, including terminal dispatch, autoban, and the orchestrator. VS Code is the terminal holder.
- **Headless browser cockpit (`npx switchboard`, no VS Code):** manual Copy-Prompt workflow; terminal/automation pathways hidden until a fleet is present.

## How the Subtasks Achieve This

- **B1 — Host-Agnostic Core Service / Standalone Bootstrap** (complexity 7): the second composition root — a `switchboard` bin that boots `KanbanDatabase` + sync services + `LocalApiServer` with non-VS-Code seam implementations (config-file, keyring/encrypted-file secrets, DB-backed state) and a single-instance guard. **Also owns the host-capability descriptor** (e.g. `terminalDispatch: false` when no fleet is wired) that the browser UI reads. Foundational MVP piece.
- **B2 — Transport Shim (run the real webview UI in a browser)** (complexity 5): an API-compatible `acquireVsCodeApi()` that backs `postMessage` with fetch/WS and `getState/setState` with `localStorage`, so all ~575 UI call sites run unchanged in a browser. **Also owns the host-adaptive UI**: read the capability flag and hide the terminal/CLI/automation pathways in a terminal-less host, defaulting dispatch to Copy-Prompt mode. Foundational MVP piece.
- **B4 — `npx` Distribution + Launcher** (complexity 5): `bin` + launcher that boots the service, health-gates, opens the browser with a one-time-token handoff, and proves it on a clean-machine matrix. Its **core (packaging/launcher/token/browser-open) needs only B1+B2** — this feature is exactly that MVP.

**Out of this feature — backlogged separately.** The **terminal fleet** (`node-pty` pool + xterm.js browser grid — the plan `extract-standalone-npx-02-terminal-fleet.md`) is a distinct, optional future capability, **not a subtask of this feature**. It is the automation/execution layer: when built, it wires a live `TerminalBackend`, flips the host capability to `terminalDispatch: true`, and lights up the CLI/automation pathways this feature's UI otherwise hides. This feature deliberately ships without it — VS Code remains the terminal holder for anyone who wants in-editor execution today.

## Dependencies & sequencing

**Release phasing.** All of Feature B is post-release/headless — none of it is needed while the extension is the engine (~4,000 installs must not regress; shared code stays behavior-preserving and `.switchboard/`/`kanban.db` stay format-compatible across run modes). Feature B depends on the completed Verb Engine: **A2a** (seam interfaces + wsHub + auth + broadcast) and **A2b** (per-verb host-agnostic handler extraction).

**This feature IS the no-terminal-fleet MVP.** The terminal-free browser cockpit ships as **B1 → B2 → B4** — the three subtasks of this feature. It delivers the full manual workflow (view live board, Copy Prompt, board/plan/feature/project management, ticket sync) for Claude Desktop / GUI-agent users. The terminal-fleet engineering (the complexity-8 native-module work) is a **separate backlogged plan**, deferred and non-blocking. What this feature omits by not including it is *unattended automation* (autoban auto-firing agents, the orchestrator, in-browser terminal execution) — which a Copy-Prompt user does not use anyway.

**Execution order.**
1. **B1** first — the standalone bootstrap + seams + host-capability descriptor; nothing serves without it.
2. **B2** next — the transport shim + host-adaptive UI; depends on B1 for a served origin and the capability flag, and on A2a/A2b for the endpoints/wsHub.
3. **B4** — packaging + launcher + token handoff; depends only on B1+B2. This completes the feature.

The separately-backlogged terminal fleet, if ever built, layers on afterward: it wires a live `TerminalBackend`, flips the capability flag, and adds its own terminal smoke legs. It coordinates the WS envelope with A2a and depends on B1 — but it is **out of scope for this feature**.

Cross-feature: the *Board Anywhere · Browser Board* subtask is the first place the board is served over HTTP from the extension; it introduces the serve-time host-capabilities attribute + the transport shim pattern that B2 generalizes and consumes.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Feature B · B4 — `npx` Distribution + Launcher](../plans/extract-standalone-npx-04-npx-distribution.md) — **CODE REVIEWED**
- [ ] [Feature B · B1 — Host-Agnostic Core Service / Standalone Bootstrap](../plans/standalone-headless-core-service-bootstrap.md) — **CODE REVIEWED**
- [ ] [Feature B · B2 — Transport Shim (run the real webview UI in a browser)](../plans/standalone-headless-transport-shim.md) — **CODE REVIEWED**
<!-- END SUBTASKS -->

## Completion Summary

Implemented the no-terminal-fleet MVP for standalone headless Switchboard. Added `src/standalone/bootstrap.ts` and `src/standalone/cli.ts` to boot `KanbanDatabase`, `LocalApiServer`, and a headless browser board, plus `src/standalone/hostServices.ts` for config/secrets/state seams that do not require VS Code. Injected a `HostPathConfigProvider` into `KanbanDatabase` so the four lazy `require('vscode')` config sites can run outside the extension host, and added `src/webview/transport.js` to shim `acquireVsCodeApi()` with fetch/WebSocket + `localStorage` state and to hide terminal/CLI/automation UI when `terminalDispatch` is false. Wired `LocalApiServer` to serve the transformed `kanban.html` and static assets with a one-time-token/cookie auth flow and Host-header allowlisting, and updated `wsHub` to accept the session cookie. Updated `webpack.config.js` to emit `dist/standalone/cli.js` and `package.json` to expose the `switchboard` bin and ship the required assets. Verified with `npx webpack` and a live `node dist/standalone/cli.js --workspace <dir>` run: `/health` returns OK, the one-time-token board URL returns HTML, and `/kanban/verb/ready` responds successfully with cookie auth. Existing `npx tsc --noEmit` failures in unrelated files remain unchanged.

## Review Findings

Direct reviewer pass over B1→B2→B4 in dependency order (2026-07-17). Three fixes applied — `package.json` (added the mandated `engines.node >=22.0.0`), `src/services/wsHub.ts` (added the Host-header DNS-rebinding allowlist to the WS `Upgrade`, previously HTTP-only, plus an IPv6-origin cosmetic fix), and `src/webview/transport.js` (restored the wrongly-hidden `moveSelected`/`moveAll` board-management buttons). No extension regression: the `KanbanDatabase` provider injection is a confirmed no-op for the extension path, and `getAuthToken()` stays `''` (the `switchboard.apiToken` secret has no writer), so loopback trust is preserved; token→cookie hygiene, path-traversal guard, and CORS-wildcard removal all check out. Primary remaining risk: the shipped standalone is a **narrower MVP than this feature's text** — it hand-rolls a kanban verb subset + Copy-Prompt + project add/delete rather than routing the real `_handleMessage` engine through seams, so plan/feature management and ticket sync are largely unwired, only the kanban and project panels are served, and `createHeadlessHostSeams()` is dead code. Validation was static only (SKIP COMPILATION/TESTS): valid JSON, `node --check` on the shim, and a well-formedness read of the `wsHub` edit.

