---
description: "Feature A (Remote Control), subtask A2: lift all 706 provider handler arms into host-agnostic services behind seam interfaces, expose each catalogued verb over HTTP (request/response) + WebSocket (host→UI push) via a new wsHub, secure the browser origin, and gate parity in CI — all running inside the running extension. The transport shim is NOT here (see B2)."
---

# Feature A · A2 — Handler Extraction + HTTP/WS Endpoint Exposure (All Panels)

## Goal

Migrate the full webview↔host contract off VS Code's `postMessage` bridge so external clients can drive Switchboard completely: lift each of the **706 handler `case` arms** out of the five Provider files into shared **host-agnostic service methods behind seam interfaces**, expose every catalogued verb over HTTP (request/response) + WebSocket (host→UI push), and gate parity in CI. Runs **inside the running extension** — the extension's providers become thin `postMessage`→service adapters calling the same extracted methods the API serves; VS Code stays the engine, minimised.

**Context:** Split 2026-07-08 from the original `extract-standalone-npx-03-transport-migration.md`. The **transport shim** (running Switchboard's own `src/webview/*` UI in a browser) was removed from here to **B2** (`standalone-headless-transport-shim.md`, Feature B, post-release) — a conversational agent or a custom board never needs the shim, only the endpoints. This subtask is the near-term remote-control payload. Parent hard constraint applies with maximum force: every handler-body lift changes code the shipped extension (~4,000 installs) runs. The contract surface (2026-07-07): 432 verbs, 706 arms, 988 push sites, 575 UI call sites.

## Metadata
- **Plan ID:** aaeafbeb-f4f0-40b4-a335-53e69febc8f7
- **Tags:** refactor, backend, api, security
- **Complexity:** 9
- **Release phase:** Near-term / extension-as-engine (Feature A). The long pole. Depends only on A1's catalog + the seam interfaces below — NOT on B1's standalone bootstrap.

## User Review Required
- None — panel sequencing and full-parity requirement fixed in the parent plan's review.

## Scope

### ✅ IN SCOPE
- **Handler extraction, all 706 arms:** each `case` arm's body moves to a shared host-agnostic service module; the arm becomes `case 'verb': return svc.verb(payload)`. Burn-down order: **kanban → planning → project → design/Stitch → setup → TaskViewer/sidebar**, driven by A1's `protocol-catalog.json`.
- **Seam interfaces (define here; vscode impls kept behavior-preserving):** the extracted services must not hard-call `vscode`. Introduce seam interfaces for the vscode-coupled dependencies and inject the **vscode-backed implementations** in the extension:
  - `HostPathConfigProvider` (workspace root, config reads) — abstract the lazy `require('vscode')` sites in `KanbanDatabase.ts`.
  - `TerminalBackend` **interface** + the **vscode.Terminal-backed adapter** (create/find-by-name/send-input/kill/resize/on-close, delegating to today's code at `TaskViewerProvider.ts:7768`, `extension.ts:381,2269–2795`). The `node-pty` *implementation* of this interface is **B3**, not here — so terminal **control** verbs migrate now; terminal **output streaming** in a browser is a B3 concern.
  - Secret/state seams stubbed to the existing vscode-backed sources (the standalone *implementations* land in B1).
- **Endpoint per verb:** HTTP route (request/response verbs) or WS push (broadcast verbs) added to `LocalApiServer` for every catalogued verb, via its injected-callback pattern (`LocalApiServer.ts:9–80`) — no run-mode branches inside handlers.
- **`wsHub` (`src/services/wsHub.ts`, new — hostable by the extension):** WS server owning token-gated upgrade, per-connection ordered push queue, and **full-state resync on every (re)connect**. Broadcast abstraction fans the 988 push sites out to webview `postMessage` (extension) and wsHub (external clients), preserving per-connection ordering.
- **Browser-origin security:** session token gates the WS upgrade handshake itself (validated before upgrade completes — CORS does not govern WebSockets); `Host`/`Origin` validation on every HTTP route; bind stays `127.0.0.1`. Payloads from the network are untrusted — every endpoint validates shape (webview-trusted `postMessage` input becomes untrusted network input).
- **Catalog-driven parity gate in CI:** every catalogued verb must have a live endpoint; a missing verb fails the build.

### ⚙️ OUT OF SCOPE
- **Transport shim** (running the real webview UI in a browser) → **B2**.
- `node-pty` `TerminalBackend` implementation + xterm browser grid → **B3**.
- Standalone composition root / keyring / config-file / Memento→config → **B1**. npx packaging → **B4**.

## Implementation Steps
1. **`wsHub` + auth first** — token-gated upgrade, ordered push queue, resync-on-connect, Host/Origin middleware.
2. **Kanban panel burn-down** (168 arms) — extract → seam-inject → endpoint → parity-test row, per verb. Establish the mechanical per-verb recipe.
3. **Planning → project → design/Stitch (62) → setup (117) → TaskViewer/sidebar (191)** — repeat; catalog burned to zero.
4. **Push-site audit** — the 988 sites route through the broadcast abstraction (webview + wsHub); ordering preserved per connection.
5. **Parity gate** — CI: catalogued verbs ⊆ live endpoints.

## Complexity Audit
### Routine
- The per-verb recipe once proven: mechanical, catalog-driven, patterned.
### Complex / Risky
- **Silent extension behavior change** — 706 lifts, each touching shipped code; reply timing, error shapes, ack semantics must be byte-compatible. The catalog gate + per-verb parity rows are the tripwire; provider tests must pass unchanged per-provider.
- **Push fidelity at 988 sites** — missing/mis-ordered pushes = a subtly stale board (worst historical bug class); resync-on-reconnect is the backstop, per-connection ordering the contract.
- **WS auth** — an unauthenticated upgrade path becomes local RCE once B3's terminal streams ride the hub; DNS-rebinding walks past origin assumptions. Token validation at upgrade is non-negotiable.
- **Terminal-seam boundary** — migrating terminal-control verbs against the vscode adapter is fine; do NOT let any verb assume readable terminal output (that arrives only with B3's node-pty backend).

## Edge-Case & Dependency Audit
- **Race:** push during WS reconnect → covered by full resync on connect. Two browser tabs → both get full fan-out; last-writer-wins (same as two webview panels today).
- **Side effects:** provider files shrink to thin adapters — keep message names/casing byte-identical (tests/tooling grep for them).
- **Dependencies:** **A1** (`eb75281d-...`) — catalog is the fixture + gate. Dep: `ws`. Does **NOT** depend on B1's standalone bootstrap. Coordinates the WS envelope with **B3** (terminal streams ride wsHub).

## Dependencies
- **A1** (`eb75281d-d8f3-4e50-b396-f7626abed020`) — protocol catalog is the fixture + parity gate. A2 cannot start burn-down until A1's `protocol-catalog.json` exists.
- **New npm dependency:** `ws` — NOT currently in `package.json` dependencies or devDependencies. Must be added before wsHub work begins. Net-new to the published extension (~4,000 installs).
- Does **NOT** depend on B1's standalone bootstrap. Coordinates the WS envelope with **B3** (terminal streams ride wsHub).

## Adversarial Synthesis

Key risks: (1) **Auth is a no-op** — `_checkAuth` (`LocalApiServer.ts:255-258`) returns `true` unconditionally; the plan assumes token-gated WS upgrade but the token validation must be built from scratch as step 0, not assumed. An unauthenticated WS upgrade on localhost is local RCE once B3's terminal streams ride the hub. DNS-rebinding bypasses the `127.0.0.1` remoteAddress check (attacker's domain resolves to 127.0.0.1). (2) **Missing seam surfaces** — the plan lists `HostPathConfigProvider` + `TerminalBackend` but scout found 4 additional vscode-coupling surfaces inside arm bodies: `vscode.commands.executeCommand`, `vscode.window.showWarningMessage`, `vscode.workspace.openTextDocument`, `vscode.window.showTextDocument`. Each needs a seam or the extracted "host-agnostic" service still calls vscode. (3) **Push ordering** — `_pendingWebviewMessages` handles initial-load ordering only; runtime push ordering relies on VS Code's implicit postMessage ordering which WS does not guarantee. Per-connection sequence numbers are required. Mitigations: build real auth (`getAuthToken()` + `Origin` validation at WS upgrade) as step 0; seam set grows as burn-down encounters new coupling surfaces; wsHub assigns monotonic sequence numbers per connection with full-state resync on reconnect.

## Proposed Changes

### `src/services/wsHub.ts` (new file)
- **Context:** No WS infrastructure exists in the codebase. `ws` is not in `package.json`. The existing push mechanism is direct `webview.postMessage()` calls (100+ sites in KanbanProvider alone) with a `_pendingWebviewMessages` queue for initial-load ordering only (`KanbanProvider.ts:1773-1780`).
- **Logic:** WS server sharing the existing LocalApiServer HTTP port (via `ws`'s `WebSocketServer({ server: httpServer })` pattern, hooking the `'upgrade'` event). Token-gated upgrade: validate `Origin` header + bearer token (from query param `?token=` — browsers cannot set custom headers on WS upgrade) before calling `ws.handleUpgrade()`. Per-connection ordered push queue with monotonic sequence numbers. Full-state resync on every (re)connect: on connection open, send the complete current board/feature/plan state so the client converges regardless of what it missed.
- **Implementation:** Class `WsHub` with: `constructor(httpServer, authToken)`, `broadcast(verb, payload)` (fans out to all connections with per-connection sequence numbers), `resync(connection)` (sends full state), `onConnection(callback)`. Token validation at the `'upgrade'` event: check `req.headers.origin` against allowed origins (`http://localhost:*`, `http://127.0.0.1:*`) AND validate `token` query param against `getAuthToken()`. Reject by calling `socket.destroy()` before upgrade completes.
- **Edge cases:** Two browser tabs → both get full fan-out; last-writer-wins (same as two webview panels today). Push during WS reconnect → covered by full resync on connect. DNS-rebinding → `Origin` header validation catches it (attacker's domain ≠ localhost). Sequence number gap on reconnect → resync fills it. `ws` version: pin a version published >7 days ago per project rules; do not use `latest` or floating ranges.

### `src/services/LocalApiServer.ts`
- **Context:** Injected-callback options pattern at lines 11-136. Route dispatch is a sequential `if/else if` chain in `_handleRequest` (lines 1889-1980). Auth is a no-op (`_checkAuth` returns `true` at lines 255-258). 127.0.0.1 bind at line 178. CORS headers set to `*` at lines 1864-1866 (acceptable for localhost HTTP; WS upgrade bypasses CORS — Origin validation is the WS mitigation).
- **Logic:** (1) Add `wsHub?: WsHub` to options. (2) Add real token validation to `_checkAuth` — compare `Authorization: Bearer <token>` header against `getAuthToken()` for HTTP routes. (3) For each catalogued verb: add HTTP route arm (request/response verbs) or WS broadcast registration (broadcast verbs) via the injected-callback pattern, mirroring `orchestrationDispatch` (lines 791-839, route at 1925-1926). (4) Every endpoint validates payload shape — webview-trusted `postMessage` input becomes untrusted network input.
- **Implementation:** Per-verb recipe: extract arm body → service method → HTTP route arm (`_handle<Verb>`) → parity-test row. The route arm parses body, validates shape, calls the injected callback, returns `{ success, data }` or `{ error }`. For broadcast verbs: the service method calls `wsHub.broadcast(verb, payload)` AND `webview.postMessage(payload)` (dual fan-out preserving the extension's webview while adding WS clients).
- **Edge cases:** Untrusted payloads from network — every endpoint must validate shape (typeof checks, required fields) before calling the service method. Reply timing/error shapes must be byte-compatible with the webview's expectations (the webview still calls through `postMessage` → provider adapter → same service method). A missing verb in the route chain → CI parity gate fails the build.

### `src/services/{Kanban,Planning,Setup,Design,TaskViewer}Provider.ts`
- **Context:** 706 handler `case` arms across 5 providers. Each arm body contains vscode-coupled calls. Representative examples: `KanbanProvider.ts:6393` (`selectPlan` — internal service call), `:6400` (`openPlanByPath` — `vscode.window.showWarningMessage`, `vscode.workspace.openTextDocument`, `vscode.window.showTextDocument`, `fs`), `:6424` (`refresh` — `vscode.commands.executeCommand`), `:6613` (`addProject` — `this._panel?.webview.postMessage`).
- **Logic:** Each arm body moves to a shared host-agnostic service module; the arm becomes `case 'verb': return svc.verb(payload)`. Burn-down order: kanban (168) → planning (168) → project → design/Stitch (62) → setup (117) → TaskViewer/sidebar (191), driven by A1's `protocol-catalog.json`.
- **Implementation:** Per-verb: (1) extract arm body into a service method, (2) identify vscode-coupled calls in the body, (3) if a new coupling surface is found, add a seam interface + vscode-backed implementation (injected in the extension), (4) the arm becomes a thin `postMessage`→service adapter, (5) add the HTTP/WS endpoint, (6) add a parity-test row. The seam set STARTS with `HostPathConfigProvider` + `TerminalBackend` and GROWS as burn-down encounters new surfaces (`HostCommands` for `executeCommand`, `HostUI` for `showWarningMessage`/`showInformationMessage`, `HostEditor` for `openTextDocument`/`showTextDocument`). Follow the existing `RemoteProvider` interface pattern (`src/services/remote/RemoteProvider.ts:107-182`) and `PlanningPanelAdapterFactories` pattern (`PlanningPanelProvider.ts:41-49`).
- **Edge cases:** Silent extension behavior change — 706 lifts, each touching shipped code. Reply timing, error shapes, ack semantics must be byte-compatible. The catalog gate + per-verb parity rows are the tripwire; provider tests must pass unchanged per-provider. Push-site audit: the 988 `webview.postMessage` push sites route through the broadcast abstraction (webview + wsHub) — ordering preserved per connection via wsHub sequence numbers. Provider files shrink to thin adapters — keep message names/casing byte-identical (tests/tooling grep for them).

### `src/services/KanbanDatabase.ts`
- **Context:** 7 lazy `require('vscode')` sites: config reads (`:914-918`, `:6897-6901`, `:6911-6921`), EventEmitter (`:1271-1277`), UI messages (`:4946-4952`, `:5038-5043`, `:5059-5063`).
- **Logic:** Abstract config reads behind `HostPathConfigProvider` (workspace root, `switchboard.kanban.dbPath`, `switchboard.boardStateExport`). The EventEmitter and UI-message sites are notification-only (not on the service-method path) — they can stay as lazy `require('vscode')` with try/catch fallbacks (already present) since they're UI concerns that don't block the service methods.
- **Implementation:** `HostPathConfigProvider` interface: `getWorkspaceRoot(): string`, `getConfig(section: string, key: string): string | undefined`. Vscode-backed implementation reads `vscode.workspace.getConfiguration()`. Injected into `KanbanDatabase` constructor. The 3 config-read sites delegate to the seam; the 4 notification sites stay as-is.
- **Edge cases:** Unit tests already run outside the extension host (the try/catch fallbacks at each site prove this). The seam must preserve this — the test implementation of `HostPathConfigProvider` returns defaults.

### `src/services/TaskViewerProvider.ts` (terminal seam)
- **Context:** Terminal methods: `vscode.window.createTerminal` (`:2994-3010`), `terminal.sendText` (`:3007`, `:3132`, `:7384`, `:7680`), `terminal.show` (`:3010`), `findTerminalNameByWorktreePath` (`:8043-8058`), `revealWorktreeTerminal` (`:8188-8197`). `extension.ts:354-387` `resolveTerminalByName`. Terminal OUTPUT is NOT readable today (no `onDidWriteTerminalData` listener — confirmed).
- **Logic:** `TerminalBackend` interface: `create(name, cwd, startupCmd)`, `findByName(name)`, `sendInput(name, text, shouldEnter)`, `kill(name)`, `resize(name, cols, rows)`, `onClose(callback)`. Vscode-backed adapter wraps the existing code. Terminal **control** verbs migrate now; terminal **output streaming** is B3 (requires `node-pty` backend).
- **Implementation:** Interface in `src/services/TerminalBackend.ts`. Vscode adapter in `src/services/VscodeTerminalBackend.ts` delegating to `TaskViewerProvider`'s existing terminal methods + `extension.ts`'s `resolveTerminalByName`. Injected into the extracted services that need terminal control.
- **Edge cases:** Do NOT let any verb assume readable terminal output (that arrives only with B3's node-pty backend). Terminal lifecycle (dispose, exit status) is tightly coupled to VS Code terminal events — the adapter must track `exitStatus` as the existing code does.

### `.github/workflows/integration-tests.yml`
- **Context:** CI runs `npm ci` → `npm run compile-tests` → `npm run compile` → `npm run test:integration:all`. No parity test exists.
- **Logic:** Add a "Protocol parity gate" step after compile: load `protocol-catalog.json`, enumerate live HTTP/WS endpoints from the running server (or from a static analysis of `LocalApiServer._handleRequest`), assert every catalogued verb has a live endpoint. Missing verb → build fails with the verb name.
- **Implementation:** New step in the `integration-tests` job. The parity gate script (`scripts/check-protocol-parity.js`) reads the catalog and checks endpoint coverage. Builds on A1's drift check.
- **Edge cases:** Broadcast verbs (host→UI push) don't have HTTP routes — they're WS-only. The parity gate must distinguish request/response verbs (HTTP route required) from broadcast verbs (WS registration required).

### `package.json`
- **Context:** `ws` is not in dependencies. ~4,000 published installs — adding a dependency is safe (additive, no migration).
- **Logic:** Add `ws` to `dependencies` with a pinned version published >7 days ago. Add `@types/ws` to devDependencies.
- **Implementation:** `npm add ws@<version>` and `npm add -D @types/ws`. Do not use `latest` or floating ranges.
- **Edge cases:** `ws` is a pure-JS library (no native deps) — safe across all platforms.

## Verification Plan
### Automated Tests
- Skipped per session directive — no automated test run required. The CI parity gate (catalogued verbs ⊆ live endpoints) serves as the automated gate when implemented.
### Manual Verification
- **Catalog parity gate (CI):** every catalogued verb has a live endpoint; failures name the missing verb.
- Existing provider tests pass unchanged after each provider's burn-down (run per-provider, not batched).
- **WS auth:** upgrade without valid token → rejected (`socket.destroy()` before upgrade completes). Bad `Origin` header → rejected. DNS-rebinding simulation (curl with `Host: evil.com` + `Origin: http://evil.com`) → rejected.
- **Push fidelity:** kill WS mid-session → reconnect → resync delivers full state, no stale cards. Two browser tabs → both get full fan-out. Sequence numbers monotonic per connection.
- Manual: full board driven from a localhost HTTP/WS client (plan moves, feature ops, planning/design/setup verbs) with VS Code minimised; verify reply timing, error shapes, ack semantics are byte-compatible with the webview's expectations.

**Stage Complete:** PLAN REVIEWED
