---
description: "Feature A (Remote Control), subtask A2a: build the transport infrastructure — wsHub (token-gated WS upgrade + per-connection ordered push + resync-on-connect), real auth on LocalApiServer (replacing the current no-op), seam interfaces for all vscode-coupled surfaces, and the broadcast abstraction. This is the prerequisite for A2b's per-verb burn-down."
---

# Feature A · A2a — Transport Infrastructure: wsHub, Auth, Seams

## Goal

Build the transport infrastructure that A2b's per-verb burn-down rides on: a token-gated `wsHub` with per-connection ordered push and full-state resync, real auth on `LocalApiServer` (replacing the current no-op `_checkAuth`), seam interfaces for every vscode-coupled surface the handler extraction will encounter, the broadcast abstraction that dual-fans push sites to webview + WS, and the `ws` npm dependency. No handler extraction happens here — this is the rails, not the train.

**Context:** Split 2026-07-08 from A2 during improve-feature. A2 bundled infrastructure + 706-arm burn-down — two distinct units of work with a clean prerequisite line. A2a builds the infrastructure; A2b uses it mechanically. Parent hard constraint applies: the auth rewrite changes `_checkAuth` (`LocalApiServer.ts:255-258`) which every existing route passes through — the rewrite must be behavior-preserving for the existing token-less localhost flow while adding real validation for the new WS + external-client surface.

## Metadata
- **Plan ID:** aaeafbeb-f4f0-40b4-a335-53e69febc8f7
- **Feature:** 511977b8-6f6d-41ec-b1a2-00e959f03ef1
- **Tags:** refactor, backend, api, security
- **Complexity:** 7
- **Release phase:** Near-term / extension-as-engine (Feature A). Prerequisite for A2b. Depends on A1's catalog (for the seam inventory) but NOT on any handler extraction.

## User Review Required
- None — decisions inherited from the reviewed parent plan.

## Scope

### ✅ IN SCOPE
- **`wsHub` (`src/services/wsHub.ts`, new):** WS server sharing the existing LocalApiServer HTTP port. Token-gated upgrade (validated before upgrade completes — `Origin` header + bearer token from `?token=` query param). Per-connection ordered push queue with monotonic sequence numbers. Full-state resync on every (re)connect. Broadcast abstraction that dual-fans to webview `postMessage` (extension) + wsHub (external clients).
- **Real auth on `LocalApiServer`:** rewrite `_checkAuth` (lines 255-258, currently returns `true` unconditionally) to validate `Authorization: Bearer <token>` against `getAuthToken()` for HTTP routes. Add `Origin` header validation at the WS upgrade event. Bind stays `127.0.0.1`. DNS-rebinding mitigation: `Origin` check catches attacker domains that resolve to 127.0.0.1.
- **Seam interfaces (define all + vscode-backed implementations):**
  - `HostPathConfigProvider` — workspace root, config reads. Abstracts the 3 config-read `require('vscode')` sites in `KanbanDatabase.ts` (`:914-918`, `:6897-6901`, `:6911-6921`).
  - `TerminalBackend` — interface + vscode.Terminal-backed adapter (create/find-by-name/send-input/kill/resize/on-close). Wraps existing code at `TaskViewerProvider.ts:2994-3010`, `extension.ts:354-387`. The `node-pty` implementation is B3, not here.
  - `HostCommands` — `vscode.commands.executeCommand` (found in arm bodies, e.g. `KanbanProvider.ts:6424`).
  - `HostUI` — `vscode.window.showWarningMessage` / `showInformationMessage` (e.g. `KanbanProvider.ts:6400`).
  - `HostEditor` — `vscode.workspace.openTextDocument` / `vscode.window.showTextDocument` (e.g. `KanbanProvider.ts:6400`).
  - Secret/state seams stubbed to existing vscode-backed sources (standalone implementations land in B1).
- **Broadcast abstraction:** the mechanism that routes push sites to both webview `postMessage` and `wsHub.broadcast`, preserving per-connection ordering. This is the abstraction A2b's 988 push-site audit routes through.
- **`ws` npm dependency:** add `ws` + `@types/ws` to `package.json`. Net-new to the published extension (~4,000 installs).

### ⚙️ OUT OF SCOPE
- **Handler extraction (706 arms) + per-verb endpoints + push-site audit + CI parity gate** → **A2b** (`c05762a3-...`).
- **Transport shim** (running the real webview UI in a browser) → **B2**.
- `node-pty` `TerminalBackend` implementation + xterm browser grid → **B3**.
- Standalone composition root / keyring / config-file / Memento→config → **B1**. npx packaging → **B4**.

## Implementation Steps
1. **Add `ws` dependency** — `npm add ws@<version>` + `npm add -D @types/ws`. Pin a version published >7 days ago.
2. **Real auth on `LocalApiServer`** — rewrite `_checkAuth` (lines 255-258) to validate `Authorization: Bearer <token>` against `getAuthToken()`. Preserve the localhost-only check at `_handleRequest:1862`. Add `Origin` header validation for WS upgrade.
3. **`wsHub`** — `src/services/wsHub.ts`. WS server on the existing HTTP port. Token-gated upgrade (`Origin` + `?token=` validation before `ws.handleUpgrade()`). Per-connection sequence numbers. Full-state resync on connect. `broadcast(verb, payload)` method.
4. **Seam interfaces** — define `HostPathConfigProvider`, `TerminalBackend`, `HostCommands`, `HostUI`, `HostEditor` interfaces + vscode-backed implementations. Inject into `KanbanDatabase` (config reads) and make available for A2b's service extraction. Follow existing `RemoteProvider` interface pattern (`src/services/remote/RemoteProvider.ts:107-182`).
5. **Broadcast abstraction** — the dual-fan-out mechanism (webview `postMessage` + `wsHub.broadcast`) that A2b's push-site audit routes through. Preserve `_pendingWebviewMessages` queue for initial-load ordering (`KanbanProvider.ts:1773-1780`); add wsHub as a second fan-out target.

## Complexity Audit
### Routine
- Adding `ws` to `package.json` — one line.
- Defining seam interfaces — TypeScript interfaces, no logic.
- Vscode-backed implementations of seams — delegating to existing code, no new behavior.
### Complex / Risky
- **Auth rewrite** — `_checkAuth` is called by every existing route. The rewrite must preserve the existing localhost-only flow (no token required for existing webview-driven usage) while adding real validation for external clients. Getting this wrong breaks every existing endpoint.
- **WS upgrade security** — token validation + `Origin` checking at the upgrade event. An unauthenticated upgrade path is local RCE once B3's terminal streams ride the hub. DNS-rebinding bypasses `127.0.0.1` remoteAddress check — `Origin` validation is the mitigation.
- **Per-connection ordering** — WS has no built-in ordering guarantee (unlike VS Code's implicit postMessage ordering). Sequence numbers + resync-on-connect must be correct or boards go stale silently.

## Edge-Case & Dependency Audit
- **Race:** push during WS reconnect → covered by full resync on connect. Two browser tabs → both get full fan-out; last-writer-wins.
- **Security:** unauthenticated WS upgrade → `socket.destroy()` before upgrade completes. Bad `Origin` → rejected. DNS-rebinding → `Origin` check catches it. HTTP routes without token → 401 (but existing webview-driven flow doesn't use HTTP routes, so no regression).
- **Side effects:** `_checkAuth` rewrite touches every existing route's auth path. Must be behavior-preserving for the existing token-less localhost flow.
- **Dependencies:** **A1** (`eb75281d-...`) — catalog informs the seam inventory (which vscode-coupled surfaces exist in arm bodies). **New npm dep:** `ws`. Does NOT depend on B1. A2b (`c05762a3-...`) depends on this.

## Dependencies
- **A1** (`eb75281d-d8f3-4e50-b396-f7626abed020`) — protocol catalog identifies the vscode-coupled surfaces that need seams.
- **New npm dependency:** `ws` + `@types/ws` — NOT currently in `package.json`. Must be added before wsHub work begins.
- **Consumed by:** A2b (`c05762a3-8aef-4502-9b91-f72c2a2b2b81`) — A2b's per-verb burn-down rides on A2a's wsHub + auth + seams + broadcast abstraction.
- Does NOT depend on B1's standalone bootstrap. Coordinates the WS envelope with B3 (terminal streams ride wsHub).

## Adversarial Synthesis

Key risks: (1) **Auth rewrite is the highest-risk change** — `_checkAuth` is called by every existing route; the rewrite must preserve the existing token-less localhost flow while adding real validation for external clients. The mitigation is to gate the new validation on the presence of an `Authorization` header (if no header, fall through to the existing localhost-only check — preserves backward compatibility). (2) **WS upgrade security** — token + Origin validation at the upgrade event is non-negotiable; an unauthenticated upgrade is local RCE once B3's terminal streams ride the hub. (3) **Seam completeness** — the scout found 4 additional vscode-coupling surfaces beyond the original 2; defining all 6 seams upfront avoids A2b stalling when it encounters an unseamed coupling surface mid-burn-down. Mitigations: auth rewrite gated on header presence; WS upgrade validates before `handleUpgrade`; all 6 seams defined + implemented here.

## Proposed Changes

### `package.json`
- **Context:** `ws` is not in dependencies. ~4,000 published installs — adding a dependency is safe (additive, no migration).
- **Logic:** Add `ws` to `dependencies` with a pinned version published >7 days ago. Add `@types/ws` to devDependencies.
- **Implementation:** `npm add ws@<version>` and `npm add -D @types/ws`. Do not use `latest` or floating ranges.
- **Edge cases:** `ws` is a pure-JS library (no native deps) — safe across all platforms.

### `src/services/wsHub.ts` (new file)
- **Context:** No WS infrastructure exists in the codebase. `ws` is not in `package.json`. The existing push mechanism is direct `webview.postMessage()` calls (100+ sites in KanbanProvider alone) with a `_pendingWebviewMessages` queue for initial-load ordering only (`KanbanProvider.ts:1773-1780`).
- **Logic:** WS server sharing the existing LocalApiServer HTTP port (via `ws`'s `WebSocketServer({ server: httpServer })` pattern, hooking the `'upgrade'` event). Token-gated upgrade: validate `Origin` header + bearer token (from query param `?token=` — browsers cannot set custom headers on WS upgrade) before calling `ws.handleUpgrade()`. Per-connection ordered push queue with monotonic sequence numbers. Full-state resync on every (re)connect: on connection open, send the complete current board/feature/plan state so the client converges regardless of what it missed.
- **Implementation:** Class `WsHub` with: `constructor(httpServer, authToken)`, `broadcast(verb, payload)` (fans out to all connections with per-connection sequence numbers), `resync(connection)` (sends full state), `onConnection(callback)`. Token validation at the `'upgrade'` event: check `req.headers.origin` against allowed origins (`http://localhost:*`, `http://127.0.0.1:*`) AND validate `token` query param against `getAuthToken()`. Reject by calling `socket.destroy()` before upgrade completes.
- **Edge cases:** Two browser tabs → both get full fan-out; last-writer-wins (same as two webview panels today). Push during WS reconnect → covered by full resync on connect. DNS-rebinding → `Origin` header validation catches it (attacker's domain ≠ localhost). Sequence number gap on reconnect → resync fills it. `ws` version: pin a version published >7 days ago per project rules; do not use `latest` or floating ranges.

### `src/services/LocalApiServer.ts`
- **Context:** Injected-callback options pattern at lines 11-136. Route dispatch is a sequential `if/else if` chain in `_handleRequest` (lines 1889-1980). Auth is a no-op (`_checkAuth` returns `true` at lines 255-258). 127.0.0.1 bind at line 178. CORS headers set to `*` at lines 1864-1866.
- **Logic:** (1) Add `wsHub?: WsHub` to options. (2) Rewrite `_checkAuth` to validate `Authorization: Bearer <token>` against `getAuthToken()` — but gate on header presence: if no `Authorization` header, fall through to the existing localhost-only check (preserves backward compatibility for the existing webview-driven flow). (3) Wire the wsHub to the HTTP server's `'upgrade'` event.
- **Implementation:** `_checkAuth` rewrite: if `req.headers.authorization` is present, validate `Bearer <token>` against `getAuthToken()` → return true/false. If absent, return true (existing localhost-only behavior — the `remoteAddress` check at line 1862 is the gate). WS upgrade: in the `'upgrade'` handler, validate `Origin` + `?token=` before calling `ws.handleUpgrade()`.
- **Edge cases:** Existing routes that don't send an `Authorization` header → still work (backward compatible). New external-client routes that do send the header → validated. WS clients → token + Origin validated at upgrade.

### `src/services/seams/` (new directory — all seam interfaces + vscode implementations)
- **Context:** Scout found 6 vscode-coupling surfaces inside arm bodies. Existing seam patterns: `RemoteProvider` (`src/services/remote/RemoteProvider.ts:107-182`), `PlanningPanelAdapterFactories` (`PlanningPanelProvider.ts:41-49`).
- **Logic:** Define 6 interfaces + vscode-backed implementations:
  - `HostPathConfigProvider` — `getWorkspaceRoot()`, `getConfig(section, key)`. Vscode impl reads `vscode.workspace.getConfiguration()`.
  - `TerminalBackend` — `create(name, cwd, startupCmd)`, `findByName(name)`, `sendInput(name, text, shouldEnter)`, `kill(name)`, `resize(name, cols, rows)`, `onClose(callback)`. Vscode impl wraps `TaskViewerProvider` terminal methods + `extension.ts:resolveTerminalByName`.
  - `HostCommands` — `executeCommand(commandId, ...args)`. Vscode impl calls `vscode.commands.executeCommand`.
  - `HostUI` — `showWarningMessage(msg)`, `showInformationMessage(msg)`. Vscode impl calls `vscode.window.*`.
  - `HostEditor` — `openTextDocument(path)`, `showTextDocument(doc)`. Vscode impl calls `vscode.workspace.*` / `vscode.window.*`.
  - `HostSecrets` — stubbed to existing vscode-backed sources (standalone implementations land in B1).
- **Implementation:** One file per interface (`HostPathConfigProvider.ts`, `TerminalBackend.ts`, etc.) + one vscode-backed implementation per interface (`VscodeHostPathConfigProvider.ts`, `VscodeTerminalBackend.ts`, etc.). Inject into `KanbanDatabase` constructor (config reads) and make available for A2b's service extraction.
- **Edge cases:** Unit tests run outside the extension host (the try/catch fallbacks in `KanbanDatabase.ts` prove this). Test implementations of each seam return defaults. `TerminalBackend` — do NOT assume readable terminal output (that arrives only with B3's node-pty backend). Terminal lifecycle (dispose, exit status) — the vscode adapter must track `exitStatus` as existing code does.

### `src/services/KanbanDatabase.ts`
- **Context:** 7 lazy `require('vscode')` sites: config reads (`:914-918`, `:6897-6901`, `:6911-6921`), EventEmitter (`:1271-1277`), UI messages (`:4946-4952`, `:5038-5043`, `:5059-5063`).
- **Logic:** Abstract the 3 config-read sites behind `HostPathConfigProvider`. The EventEmitter and UI-message sites are notification-only (not on the service-method path) — they stay as lazy `require('vscode')` with try/catch fallbacks (already present).
- **Implementation:** Inject `HostPathConfigProvider` into `KanbanDatabase` constructor. The 3 config-read sites delegate to the seam; the 4 notification sites stay as-is.
- **Edge cases:** Unit tests already run outside the extension host (the try/catch fallbacks prove this). The seam must preserve this — the test implementation of `HostPathConfigProvider` returns defaults.

### `src/services/TaskViewerProvider.ts`
- **Context:** LocalApiServer constructed at lines 1039-1167. `orchestrationDispatch` callback at lines 1164-1166. Terminal methods: `vscode.window.createTerminal` (`:2994-3010`), `terminal.sendText` (`:3007`, `:3132`, `:7384`, `:7680`), `terminal.show` (`:3010`), `findTerminalNameByWorktreePath` (`:8043-8058`), `revealWorktreeTerminal` (`:8188-8197`). `extension.ts:354-387` `resolveTerminalByName`.
- **Logic:** (1) Pass `wsHub` to the LocalApiServer constructor. (2) The `VscodeTerminalBackend` adapter delegates to these existing terminal methods. (3) Wire the wsHub to the HTTP server's upgrade event.
- **Implementation:** Add `wsHub: new WsHub(this._apiServer._server, await getAuthToken())` to the LocalApiServer options. The `VscodeTerminalBackend` wraps the terminal methods — no changes to the terminal methods themselves.
- **Edge cases:** `wsHub` construction requires the HTTP server instance + auth token — the server must be started before wsHub is wired. Auth token is async (`getAuthToken()`) — wsHub construction may need to be deferred until the token is available.

## Verification Plan
### Automated Tests
- Skipped per session directive — no automated test run required.
### Manual Verification
- **WS auth:** upgrade without valid token → rejected (`socket.destroy()` before upgrade completes). Bad `Origin` header → rejected. DNS-rebinding simulation (curl with `Host: evil.com` + `Origin: http://evil.com`) → rejected.
- **Auth backward compat:** existing webview-driven flow (no `Authorization` header) still works — no 401 on existing routes.
- **Push fidelity:** wsHub `broadcast()` delivers to all connected WS clients with monotonic sequence numbers. Kill WS mid-session → reconnect → resync delivers full state.
- **Seam injection:** `KanbanDatabase` with a test `HostPathConfigProvider` returns defaults (no `require('vscode')` needed). `TerminalBackend` vscode adapter creates/finds/sends-input/kills terminals as existing code does.
- Existing extension behavior unchanged — auth rewrite preserves the token-less localhost flow.

**Stage Complete:** PLAN REVIEWED
