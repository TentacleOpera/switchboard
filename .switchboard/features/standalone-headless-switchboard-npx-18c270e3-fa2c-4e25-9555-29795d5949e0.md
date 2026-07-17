# Standalone Headless Switchboard (npx)

**Complexity:** 8

## Goal

Make Switchboard **editor-independent**: `npx switchboard` boots the whole board and its planning/management workflow in a plain browser with no VS Code involved. The end-state is that **VS Code becomes one optional host, not a requirement** — specifically an optional *terminal holder* for users who want hands-off, in-editor CLI-agent execution. Everyone else — notably users driving a GUI agent like Claude Desktop — gets a headless browser cockpit that works entirely through **Copy Prompt** (generate prompt → paste into your agent → agent edits files → the board updates as files change). This is the payoff of the Host-Agnostic Verb Engine (A2a/A2b): the same `src/webview/*` UI runs over plain HTTP + WebSocket instead of the VS Code bridge.

**Product principle — host-adaptive UI.** The browser board must detect what the active host can actually deliver and **surface only those pathways**. A headless host with no terminal fleet must not offer terminal/CLI-dispatch, autoban, or orchestrator buttons that would silently no-op; it presents the Copy-Prompt + board-management workflow only. When VS Code (or a node-pty fleet) is the host, the full CLI/automation surface appears. Capability is derived from whether the host's `TerminalBackend` seam is live — not guessed.

**Two coexisting run modes (same `.switchboard/` + `kanban.db`):**
- **Extension-as-engine (VS Code running):** full surface, including terminal dispatch, autoban, and the orchestrator. VS Code is the terminal holder.
- **Headless browser cockpit (`npx switchboard`, no VS Code):** manual Copy-Prompt workflow; terminal/automation pathways hidden until a fleet is present.

## How the Subtasks Achieve This

- **B1 — Host-Agnostic Core Service / Standalone Bootstrap** (complexity 7): the second composition root — a `switchboard` bin that boots `KanbanDatabase` + sync services + `LocalApiServer` with non-VS-Code seam implementations (config-file, keyring/encrypted-file secrets, DB-backed state) and a single-instance guard. **Also owns the host-capability descriptor** (e.g. `terminalDispatch: false` when no fleet is wired) that the browser UI reads. Foundational MVP piece.
- **B2 — Transport Shim (run the real webview UI in a browser)** (complexity 5): an API-compatible `acquireVsCodeApi()` that backs `postMessage` with fetch/WS and `getState/setState` with `localStorage`, so all ~575 UI call sites run unchanged in a browser. **Also owns the host-adaptive UI**: read the capability flag and hide the terminal/CLI/automation pathways in a terminal-less host, defaulting dispatch to Copy-Prompt mode. Foundational MVP piece.
- **B4 — `npx` Distribution + Launcher** (complexity 5): `bin` + launcher that boots the service, health-gates, opens the browser with a one-time-token handoff, and proves it on a clean-machine matrix. Its **core (packaging/launcher/token/browser-open) needs only B1+B2** — it is MVP; only its in-browser-terminal smoke legs need B3.
- **B3 — `node-pty` Terminal Fleet + xterm Browser Grid** (complexity 8): replaces VS Code terminals with a service-owned node-pty pool rendered as an xterm.js grid in the browser — live, bidirectional agent execution with no editor. **This is the OPTIONAL automation/execution layer**, not a blocker for the MVP: it flips the host capability to `terminalDispatch: true` and lights up the CLI/automation pathways B2 otherwise hides.

## Dependencies & sequencing

**Release phasing.** All of Feature B is post-release/headless — none of it is needed while the extension is the engine (~4,000 installs must not regress; shared code stays behavior-preserving and `.switchboard/`/`kanban.db` stay format-compatible across run modes). Feature B depends on the completed Verb Engine: **A2a** (seam interfaces + wsHub + auth + broadcast) and **A2b** (per-verb host-agnostic handler extraction).

**The no-terminal-fleet MVP.** The terminal-free browser cockpit ships as **B1 → B2 → B4-core**, with **B3 explicitly optional**. This milestone delivers the full manual workflow (view live board, Copy Prompt, board/plan/feature/project management, ticket sync) for Claude Desktop / GUI-agent users, with the terminal-fleet engineering (B3, the complexity-8 native-module work) deferred and non-blocking. What the MVP omits without B3 is *unattended automation* (autoban auto-firing agents, the orchestrator, in-browser terminal execution) — which a Copy-Prompt user does not use anyway.

**Execution order.**
1. **B1** first — the standalone bootstrap + seams + host-capability descriptor; nothing serves without it.
2. **B2** next — the transport shim + host-adaptive UI; depends on B1 for a served origin and the capability flag, and on A2a/A2b for the endpoints/wsHub.
3. **B4-core** — packaging + launcher + token handoff; depends only on B1+B2 for a shippable terminal-free MVP.
4. **B3** — optional, layered on afterward; when present it wires a live `TerminalBackend`, flips the capability flag, and B4 adds its terminal smoke legs. B3 coordinates the WS envelope with A2a and depends on B1.

Cross-feature: the *Board Anywhere · Browser Board* subtask is the first place the board is served over HTTP from the extension; it introduces the serve-time host-capabilities attribute + the transport shim pattern that B2 generalizes and consumes.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Feature B · B3 — `node-pty` Terminal Fleet + xterm Browser Grid](../plans/extract-standalone-npx-02-terminal-fleet.md) — **BACKLOG**
- [ ] [Feature B · B4 — `npx` Distribution + Launcher](../plans/extract-standalone-npx-04-npx-distribution.md) — **BACKLOG**
- [ ] [Feature B · B1 — Host-Agnostic Core Service / Standalone Bootstrap](../plans/standalone-headless-core-service-bootstrap.md) — **BACKLOG**
- [ ] [Feature B · B2 — Transport Shim (run the real webview UI in a browser)](../plans/standalone-headless-transport-shim.md) — **BACKLOG**
<!-- END SUBTASKS -->

