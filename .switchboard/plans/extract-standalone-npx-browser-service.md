---
description: Extract Switchboard's host-agnostic core into a standalone Node service with a browser-hosted board and a node-pty terminal fleet, distributed via npx — an editor-independent Switchboard that runs next to any editor (including Zed) without the VS Code extension host
---

# Plan: Standalone `npx` Switchboard — Editor-Independent Service + Browser Board

## Goal

Ship a version of Switchboard that runs **outside any editor** as a local Node service with a **browser-hosted board**, launched with `npx switchboard`. The service owns its own **`node-pty` terminal fleet** (replacing the VS Code integrated-terminal fleet Switchboard drives today), and the existing webview UI is re-hosted in the browser by migrating its transport from VS Code's `postMessage` bridge to **HTTP + WebSocket**. The VS Code extension continues to ship unchanged; this is an additional distribution, not a replacement.

### Problem / Background — why this, and why not the alternatives

The trigger was "how hard is a Zed-compatible Switchboard?" A codebase survey settled the design space to exactly three paths, two of which we rejected on their merits:

- **Zed-native extension — infeasible.** Switchboard's execution model is a *message router over the editor's terminal fleet*: it enumerates `vscode.window.terminals`, finds the terminal named for a given agent, and injects text with `sendText`/`sendRobustText` (name-based routing at `src/services/TaskViewerProvider.ts:7768`; fleet create/find/route in `src/extension.ts:381`, `src/extension.ts:2269–2795` — the "Jules Monitor"/"MCP Monitor"/per-agent-grid terminals; 41 `window.terminals` sites and 41 `sendText`/`sendRobustText` sites across `src/`). **Zed's extension API exposes no terminal control at all** — no create, no enumerate, no send-text. The single primitive Switchboard is built on has zero equivalent in Zed. This is not a "rewrite the glue" gap; the host withholds the capability. Dead end. *(Confirmed by web research 2026-07-07: `zed_extension_api` v0.7.x is WASI-sandboxed and exposes only LSP/DAP/slash-commands/MCP/themes — no terminal create/enumerate/input APIs; the draft Visual Extension API RFC #53403 explicitly excludes terminal handles. If Zed integration is ever wanted, the route is exposing the standalone service as an MCP server — which this architecture gets for free.)*
- **Fork VS Code (à la Cursor/Windsurf) — rejected on cost.** A fork keeps the entire extension/terminal/webview API, so Switchboard runs unchanged with *zero* porting — but it trades a one-time port for a permanent editor-maintenance treadmill (monthly upstream merges, marketplace/licensing loss, sign/build/ship an entire IDE). Justified only if the goal is to become an editor company, which it is not. Note: Cursor and Windsurf are *already* VS Code forks; publishing to **Open VSX** puts Switchboard on both today for near-zero cost — that is the cheap answer to "reach beyond stock VS Code," and is captured as a separate no-op-sized follow-up, not part of this plan.
- **Standalone service + browser board via `npx` — chosen (this plan).** The terminal fleet has to live *outside* the editor sandbox regardless of target editor, so build it once as an editor-independent app. This sidesteps every host-API constraint, runs next to Zed / any editor / nothing, and — because `node-pty` is bidirectional where VS Code's `sendText` is write-only — is actually a *more capable* execution engine (it can read agent output, detect prompts/completion, react) rather than a lossy port.

### Root-cause insight that makes this tractable

The codebase already has a **clean host-agnostic core** and was partly built anticipating non-editor hosts:

- **`src/services/LocalApiServer.ts` (69 KB, 0 `vscode` refs)** is a plain Node `http.createServer` bound to `127.0.0.1` on an ephemeral port, wired entirely through **injected callbacks** (`moveCard`, `createFeature`, `assignToFeature`, `removeSubtaskFromFeature`, `deleteFeature`, `getClickUpService`, `getLinearService`, `getNotionService`, `getAuthToken`, `workspaceRoot`, `allRoots`, …). Its own docstrings note these are "absent in headless/test harnesses." This is the seam the standalone service is built on. It already serves `/health` (`src/services/LocalApiServer.ts:1320`) and enforces auth via `_checkAuth(req, requireAuth)` (`src/services/LocalApiServer.ts:219`) against an API token fetched through the `getAuthToken` callback (the "Switchboard: Api Token" setting, stored in VS Code secret storage).
- **`agentPromptBuilder.ts` (108 KB, 0 refs)**, the ClickUp/Linear/Notion sync services, `KanbanMigration.ts`, `complexityScale.ts`, `planStateUtils.ts`, `agentConfig.ts`, `SessionActionLog.ts` — all vscode-free.
- **`KanbanDatabase.ts` (356 KB)** runs on `sql.js` (WASM SQLite — host-agnostic) with **6 lazy `require('vscode')` sites** (no top-level import), all behind guards for path/config resolution — a thin seam to abstract.
- The `.switchboard/` state (plans as `.md`, `kanban.db`, `api-server-port.txt`) is a plain filesystem + SQLite store with no editor dependency, and the entire `.agents/skills/` layer talks to the extension **only over the local HTTP API** — so those skills keep working against the standalone service untouched.

So the coupling is **localized**, not pervasive: it lives in `extension.ts` (176 KB) and the five webview Provider files (`TaskViewerProvider` 992 KB, `KanbanProvider` 584 KB, `PlanningPanelProvider` 480 KB, `DesignPanelProvider` 160 KB, `SetupPanelProvider` 88 KB). The work is (1) lift the message-handler bodies out of those providers into host-agnostic services, (2) swap the transport, and (3) swap the terminal backend. The *business logic* mostly moves as-is.

## Metadata
- **Plan ID:** 81299C8F-E2FA-4F93-881D-83231E1798A1
- **Tags:** refactor, backend, frontend, cli, infrastructure, devops
- **Complexity:** 9

> Note: the previous `**Project:** switchboard` pin was removed during review — "switchboard" is the workspace name, not a board project (the `projects` table is empty and `kanban.activeProjectFilter` is unset). Pinning the workspace name creates phantom projects on import. The plan lands unassigned and can be assigned on the board.

## User Review Required

- **UI reuse vs. rebuild.** Plan assumes the existing webview HTML/JS is **reused** (only its transport changes). Confirm you don't want a UI rewrite bundled into this effort.
- **Terminal semantics.** Confirm the standalone fleet's terminals being *Switchboard-owned browser terminals* (not the editor's `` Ctrl+` `` terminals) is acceptable — this is the deliberate product change, not an accident.

## Scope

### ✅ IN SCOPE
- A standalone Node process (`switchboard` bin) that starts `LocalApiServer`, serves the browser board, and manages a `node-pty` terminal fleet.
- Extracting message-handler logic out of the five Provider files into host-agnostic service modules callable by both the extension and the standalone service.
- Migrating the browser↔host transport from `postMessage` to HTTP (request/response) + WebSocket (host→UI push).
- A `node-pty` fleet + `xterm.js` browser grid replacing `vscode.window.terminals` create/find/`sendText`, with name-based routing preserved.
- Replacements for VS Code host services the core relies on: `SecretStorage` (6 distinct keys: `switchboard.apiToken`, `switchboard.clickup.apiToken`, `switchboard.linear.apiToken`, `switchboard.notion.apiToken`, `switchboard.stitch.apiKey`, `switchboard.stitch.accessToken` — ~10 call sites), the **80** `switchboard.*` settings declared in `package.json`, workspace-root/path resolution, `Memento` (global/workspace state: 10 distinct keys across 6 files).
- Browser-appropriate auth + CORS for the local origin, extending the existing `_checkAuth` API-token model in `LocalApiServer` (token-gated HTTP **and** WebSocket handshake — see Edge-Case audit; CORS alone does not govern WebSockets).
- **Single-instance guard**: the standalone service and the extension must not hold `kanban.db` open concurrently (sql.js is full-file write-back — concurrent writers clobber each other). Detect a live peer via `api-server-port.txt` + `/health` and refuse to start (or start read-only) instead of corrupting state.
- `npx` distribution: `bin`, a launcher that boots the service and opens the browser, and a **prebuild verification matrix** for `node-pty`'s upstream in-tarball prebuilds (macOS/Linux/Windows × x64/arm64, npm + pnpm — see Phase 2 regression guards).

### ⚙️ OUT OF SCOPE (this plan)
- **Electron desktop packaging** — explicitly not doing it; `npx` is the distribution. Electron remains a *possible later* upgrade, decided with real usage data.
- **Extension-as-launcher** (having the VS Code extension boot the standalone browser board) — attractive to preserve marketplace discovery, but a separate follow-up.
- **Open VSX publish** (Cursor/Windsurf reach) — unrelated near-zero-cost follow-up.
- Any change to the shipped VS Code extension's behavior (see constraint below).

### 🚫 HARD CONSTRAINT — do not regress the shipped extension
The extension has **~4,000 installs**, many on old versions. The extraction refactor (lifting handlers out of Providers into shared services) touches code the shipped extension runs. This work must be **behavior-preserving for the extension**: the extension keeps using `postMessage` + `vscode.Terminal` by having its thin provider layer call the *same* extracted service methods the standalone service calls over HTTP. `.switchboard/` on-disk state and `kanban.db` schema are shared between both run modes and must stay format-compatible — no migration that only the standalone path understands.

## Resolved Decisions
- **Transport:** HTTP for request/response verbs; a single WebSocket for host→UI push (the ~988 `webview.postMessage` broadcast sites). Not SSE (need bidirectional for terminal streams). **WS reconnect performs a full board resync** — pushes missed while disconnected must not leave a stale board (Clarification: implied by push-fidelity requirement).
- **Terminal backend:** `node-pty` pinned `^1.2.0` (upstream now ships `prebuildify`-packaged prebuilds inside the npm tarball — no install-time compile, no third-party fork) + `@xterm/xterm` **v6** with `@xterm/addon-fit`, `@xterm/addon-attach`, `@xterm/addon-webgl`. Bidirectional; name-keyed fleet registry mirrors today's name-based `terminals.find(...)` routing. **Renderer strategy for the multi-pane grid:** browsers cap live WebGL contexts at ~8–16 per page, and the canvas addon was removed in xterm v6 — so all panes default to the built-in DOM renderer, and the WebGL addon is attached dynamically to the focused/high-throughput pane and disposed on blur (releases the context back to the pool).
- **State/config:** settings move to a JSON/YAML config file + env overrides; secrets to OS keychain via **`@napi-rs/keyring`** (`keytar` is archived/dead; `@napi-rs/keyring` ships prebuilt binaries as `optionalDependencies` with zero postinstall scripts, and talks D-Bus directly on Linux — no `libsecret-1-dev` headers needed). Headless fallback: an AES-256-GCM-encrypted local file (key from env/master passphrase), `0600`, under `.switchboard/`. `Memento` state migrates to the **`kanban.db` `config` table**, which is already the blessed home for cross-surface state in this codebase — do **not** introduce a new parallel JSON state store under `.switchboard/` (a second store re-creates the state-drift problem the config table exists to solve). (Clarification: storage location tightened during review; the substitution itself was already in scope.)
- **Node version floor:** `"engines": { "node": ">=22.0.0" }` — Node 20 hit EOL 2026-04-30; Node 22 is Maintenance LTS (EOL 2027-04), **Node 24 (Active LTS) is the dev/CI baseline**. Both `node-pty@^1.2.0` and `@napi-rs/keyring` clear this floor comfortably.
- **UI:** reuse existing `src/webview/*` HTML/JS; introduce a transport shim so the same code runs in both the VS Code webview (postMessage) and the browser (HTTP/WS) with a build-time or runtime switch. In the browser, the shim provides the `acquireVsCodeApi()` surface (`postMessage`, `getState`/`setState`) backed by fetch/WS + web storage.

## Implementation Steps

**Phase 0 — Protocol inventory (prerequisite, ~1 wk).**
Enumerate the full message contract so later phases are mechanical, not archaeological. Measured surface today (re-verified 2026-07-07): **432 distinct message `type:` values** sent from `src/webview/*`, **706 handler `case` arms** across the five Providers (TaskViewer 191, Kanban 168, Planning 168, Setup 117, Design 62), **988 host→webview push sites**, **575 `postMessage` call sites** in the UI. Produce a machine-readable catalog (verb → direction → payload shape → owning provider → target service method). This catalog is the migration checklist **and** the parity-test fixture (see Verification Plan).

**Phase 1 — Extract host-agnostic core service (~2–4 wks).**
- Stand up the `switchboard` bin + a service bootstrap that constructs `LocalApiServer` with real callback implementations (not VS Code shims).
- Implement the **single-instance guard** (peer detection via `api-server-port.txt` + `/health`) before the DB is opened.
- Abstract the 6 lazy `require('vscode')` seams in `KanbanDatabase.ts` behind an injected path/config provider.
- Implement config (80 settings), secret storage (6 keys), and state (`Memento` → `config` table, 10 keys) replacements.
- Reuse `agentPromptBuilder`, sync services, `KanbanMigration`, `SessionActionLog` as-is.

**Phase 2 — Terminal fleet (~3–5 wks, includes prebuild verification).**
- `node-pty` pool with a name-keyed registry; port the create/find/route logic from `TaskViewerProvider.ts:7768` / `extension.ts:381,2269–2795` to spawn+route against owned PTYs.
- `@xterm/xterm` v6 grid in the browser, one pane per fleet member, streamed over WebSocket via `@xterm/addon-attach`; input routed back to the PTY. DOM renderer by default; `@xterm/addon-webgl` attached dynamically to the focused pane only (browser WebGL-context cap, see Resolved Decisions).
- Resize: `@xterm/addon-fit` per pane computes cols/rows; ship as a JSON control packet over the WS (`{"type":"resize","cols":…,"rows":…}`) → `ptyProcess.resize(cols, rows)`.
- Lifecycle: exit status, close events (replacing the 3 `onDidCloseTerminal` sites), resize, focus semantics.
- Prebuild verification (upstream `node-pty@^1.2.0` ships prebuilds in-tarball — no custom pipeline needed, but two known 2026 packaging regressions must be guarded): (a) **macOS `spawn-helper` executable-bit bug** (Issue #850 — tarball ships mode 644, breaks under pnpm): CLI startup defensively `chmod 0o755`s the darwin `spawn-helper` if needed; (b) **linux-arm64 mispackaged prebuilt** (Issue #860, fixed Jan 2026 PR #857): CI smoke matrix must include a genuine Linux-arm64 target (e.g. Docker on Apple Silicon), not just x64.

**Phase 3 — Handler extraction + transport migration, all panels (~10–18 wks).**
Full parity — every panel migrates: kanban, planning, **design/Stitch, project**, and setup. For **each** of the 706 handler arms across all five Providers:
- Lift the `case` arm's body out of the Provider into a shared service method (Phase 1 target), leaving the Provider as a thin `postMessage`→service adapter (this is the extension-preserving move).
- Add the corresponding HTTP endpoint / WS push for the verb from the Phase 0 catalog.
- Wire the browser UI's transport shim (below) to it.
Sequence the work provider-by-provider (kanban → planning → project → design/Stitch → setup) so parity lands incrementally and the Phase 0 catalog is burned down to zero, but **all five ship before this effort is "done"** — there is no deferred panel.
- Add a UI transport shim so `src/webview` calls resolve to postMessage (in-extension) or fetch/WS (in-browser).
- Auth + CORS for the browser origin; the session token gates the WS upgrade handshake, not just HTTP routes.

**Phase 4 — `npx` distribution (~1–2 wks, overlaps Phase 2 prebuilds).**
- `bin` + launcher (boot service, open browser to the served board), health-gated on the existing `/health` endpoint + `api-server-port.txt`.
- Browser token bootstrap: launcher opens the board with a one-time token that is immediately exchanged and persisted client-side (not left in the URL/history).
- Package, smoke-test `npx switchboard` clean-machine (Node-present) install on all three OSes with the full board (all panels) rendering.

## Complexity Audit

### Routine
- Phase 4 `npx` launcher/bin wiring.
- Reusing already-vscode-free modules (`agentPromptBuilder`, sync services) in the new bootstrap.
- Serving static UI assets from `LocalApiServer` (it's already an HTTP server).
- Abstracting the 6 lazy `require('vscode')` seams in `KanbanDatabase.ts` (mechanical injection).

### Complex / Risky
- **Phase 3 transport migration** is the long pole and the bulk of the effort: the full 432-verb / 706-handler contract across all five panels, each verb needing handler extraction + endpoint + UI-shim + test. The risk is the extraction silently changing extension behavior. Full parity means none of this surface is deferrable.
- **Concurrent `kanban.db` access** between the extension and the standalone service — sql.js persists by full-file write-back with no locking; two live writers silently clobber each other. The single-instance guard is mandatory, not optional hardening.
- **Terminal fleet over WebSocket is a command-execution surface** — an unauthenticated or CSRF-reachable WS that writes to PTYs is local RCE. Auth must gate the WS handshake; CORS alone is insufficient (WebSockets are not subject to CORS).
- **`node-pty` native-module distribution** — risk materially reduced (upstream `^1.2.0` ships in-tarball prebuilds for macOS x64/arm64, Windows x64/ia32, Linux glibc+musl x64/arm64), but the v1.2.x line has shipped real packaging regressions in 2026 (arm64 mispackage, spawn-helper permission bit) — the CI smoke matrix across OS × arch × package manager (npm **and** pnpm) is still mandatory, not paranoia.
- **WebGL context exhaustion in the terminal grid** — naively attaching the WebGL renderer to every pane crashes the canvas layer past the browser's ~8–16 context cap; the DOM-default + focused-pane-WebGL strategy is load-bearing, not an optimization.
- **Secret/config/state substitution** touching the shipped extension's shared code without regressing it, and keeping the two run modes' config from drifting.
- **WebSocket push fidelity** — 988 broadcast sites; missing or mis-ordered pushes manifest as a subtly stale board. Reconnect must trigger a full resync.

## Edge-Case & Dependency Audit

### Race Conditions
- **Two-writer DB clobber:** extension and standalone service both open `kanban.db` (sql.js = in-memory image + full-file flush). Concurrent writes are last-flush-wins data loss. Mitigation: single-instance guard at startup (probe `api-server-port.txt` + `/health`; if a live peer answers, refuse to start or open read-only with a clear message). The Manual verification deliberately tests *sequential* dual-mode use only.
- **Port-file collision:** both processes write `.switchboard/api-server-port.txt`. The guard above also prevents this; the launcher must treat a stale port file (no `/health` answer) as dead and overwrite it.
- **Watcher double-processing:** both run modes watch `.switchboard/plans/` and import plan files. Without the single-instance guard, a new plan file would be imported twice (duplicate rows / duplicate ClickUp-Linear sync fan-out). Guard makes this unreachable; do not add extra dedupe UI for it.
- **WS reconnect gap:** pushes emitted while the browser is disconnected are lost (unlike postMessage, which is only lost when the webview is disposed). Full-state resync on every WS (re)connect.

### Security
- **PTY input over WS = arbitrary command execution.** The WS handshake must require the session token (query-param or `Sec-WebSocket-Protocol` carrier, validated server-side before upgrade completes). Never rely on origin checks alone.
- **DNS-rebinding / cross-site requests to localhost:** validate the `Host` and `Origin` headers against the expected local origin on every request; keep the bind on `127.0.0.1` (never `0.0.0.0`).
- **Token bootstrap:** the launcher passes a one-time token to the opened browser; the page exchanges it for a session credential and strips it from the URL (history/log hygiene).
- **Plaintext secret fallback** (headless, no keychain): file must be `0600`, live under `.switchboard/`, and be covered by the existing gitignore expectations; document that keychain is the default and fallback is opt-in.

### Side Effects
- **Extraction touches shipped code:** every handler-body lift changes files the extension runs. The provider layer must remain a call-through adapter with identical message semantics (ack timing, error shapes) — provider tests plus catalog-driven parity checks are the tripwire.
- **Config drift between run modes:** the extension reads `switchboard.*` from VS Code settings; the standalone reads a config file. Shared behaviors (e.g. agent definitions, sync toggles) that live in the DB `config` table stay consistent automatically; anything sourced from VS Code settings will diverge between modes by design. Document per-setting which store is authoritative; do not attempt live two-way sync in this plan.
- **`kanban.db` schema is shared and shipped:** no standalone-only migrations (hard constraint above). New standalone-only state goes in the `config` table under namespaced keys (`standalone.*`), which old extension versions ignore safely.

### Dependencies & Conflicts
- `node-pty@^1.2.0` (upstream in-tarball prebuilds; guard the two known 2026 packaging regressions per Phase 2), `@xterm/xterm` v6 + `@xterm/addon-{fit,attach,webgl}` (unscoped `xterm`/`xterm-addon-*` packages are frozen since 2024; canvas addon removed in v6 — do not reference either), `ws` (WS server), `@napi-rs/keyring` (keychain; `keytar` is archived and its `prebuild-install` chain is deprecated — do not use).
- `sql.js`, `@modelcontextprotocol/sdk`, sync-service deps — carry over unchanged.
- The `.agents/skills/_lib/sb_api_call.sh` layer and `kanban_operations` scripts depend only on `/health` + HTTP routes — they must work against the standalone service unmodified (verification item).
- No dependency on other open Switchboard plans; the Open VSX publish and extension-as-launcher follow-ups are downstream of this plan, not prerequisites.

## Dependencies
- **Session dependencies:** None.
- New runtime deps: `node-pty@^1.2.0`, `@xterm/xterm@^6` + `@xterm/addon-fit` / `@xterm/addon-attach` / `@xterm/addon-webgl`, `ws`, `@napi-rs/keyring`.
- Existing: `sql.js` (unchanged), `@modelcontextprotocol/sdk`, sync-service deps — all carry over.
- Runtime floor: Node ≥ 22 (`engines` enforced); Node 24 as dev/CI baseline.
- CI: multi-OS/arch **smoke** runners (macOS x64/arm64, Windows x64, Linux x64/arm64; npm + pnpm) to verify upstream prebuilds load — no custom build pipeline needed.

## Adversarial Synthesis

Key risks: (1) the 706-handler extraction silently changing shipped-extension behavior, (2) concurrent `kanban.db` access between run modes clobbering state, and (3) the PTY-over-WebSocket surface becoming local RCE if auth doesn't gate the WS handshake. Mitigations: catalog-driven parity tests + unchanged provider tests as the extraction tripwire; a mandatory single-instance guard probing `api-server-port.txt`/`/health` before DB open; token-validated WS upgrade with Host/Origin checks and a one-time-token browser bootstrap. The `node-pty` distribution risk is reduced (upstream `^1.2.0` ships in-tarball prebuilds) but its 2026 packaging regressions make the OS × arch × package-manager smoke matrix mandatory.

## Proposed Changes

### `src/standalone/` (new directory: `cli.ts`, `bootstrap.ts`, `hostServices.ts`, `TerminalFleet.ts`, `wsHub.ts`)
- **Context:** No standalone entry point exists today; `extension.ts` is the only composition root.
- **Logic:** `cli.ts` is the `bin` target — parse flags, run the single-instance guard, apply the darwin `spawn-helper` executable-bit fix (Phase 2), boot the service, open the browser with the one-time token. `bootstrap.ts` composes `LocalApiServer` with real callback implementations. `hostServices.ts` implements the config-file loader (80 settings' standalone equivalents), `@napi-rs/keyring`-backed secret store (6 keys), and `config`-table-backed Memento replacement (10 keys). `TerminalFleet.ts` is the name-keyed `node-pty` pool with spawn/find/route/kill/resize and close-event fan-out. `wsHub.ts` owns the WS server: token-gated upgrade, per-connection ordered push queue, full-resync-on-connect.
- **Implementation:** Mirror the callback contracts in `LocalApiServerOptions` (`src/services/LocalApiServer.ts:9–80`) exactly; the standalone implementations are peers of the extension's, not forks.
- **Edge Cases:** stale `api-server-port.txt` (dead peer) → overwrite; keychain unavailable (headless Linux, no Secret Service on D-Bus) → AES-256-GCM-encrypted `0600` file fallback; PTY spawn failure surfaces as a board-visible pane error, not a silent missing terminal.

### `src/services/LocalApiServer.ts`
- **Context:** Already vscode-free; serves `/health` and token-authed routes via `_checkAuth` (`:219`, `:1320`).
- **Logic:** Add static asset serving for the browser board, the WS upgrade hook (delegating to `wsHub`), and the per-verb HTTP endpoints added incrementally through Phase 3.
- **Implementation:** Extend `LocalApiServerOptions` with optional standalone-only callbacks (following the existing "absent in headless harnesses" pattern) rather than branching on run mode inside handlers.
- **Edge Cases:** Host/Origin validation on every route; unauthenticated WS upgrade attempts rejected before protocol switch; port file written only after listen succeeds.

### `src/services/KanbanDatabase.ts`
- **Context:** 6 lazy `require('vscode')` sites for path/config resolution; otherwise host-agnostic (sql.js).
- **Logic:** Introduce an injected `HostPathConfigProvider` (workspace root, config reads) consumed at those 6 sites; extension passes a vscode-backed impl, standalone passes the config-file impl.
- **Implementation:** Constructor/init-time injection with the current lazy-require behavior as the default when no provider is passed, so existing extension call sites need no change (behavior-preserving).
- **Edge Cases:** provider absent + vscode absent (bare test harness) → same fallback behavior as today's guarded requires.

### `src/services/{TaskViewer,Kanban,PlanningPanel,DesignPanel,SetupPanel}Provider.ts`
- **Context:** 706 `case` arms embed the business logic today; providers also own terminal create/find/route (`TaskViewerProvider.ts:7768`, plus `extension.ts:381,2269–2795`).
- **Logic:** Per Phase 3, each arm's body moves to a shared service module; the arm becomes `case 'verb': return svc.verb(payload)`. Terminal calls go through a `TerminalBackend` interface (`vscode.Terminal` impl in-extension; `TerminalFleet` impl standalone).
- **Implementation:** Provider-by-provider burn-down against the Phase 0 catalog; each moved verb lands with its HTTP endpoint + shim wiring + parity-test row in the same change.
- **Edge Cases:** verbs with reply-message coupling (request/response pairs over postMessage) must keep identical reply `type:` names and payload shapes in both transports; fire-and-forget verbs must not gain new acks.

### `src/webview/*` (transport shim: new `transport.js`, included by all five panels)
- **Context:** 575 `postMessage` call sites; panels acquire the host bridge via `acquireVsCodeApi()`.
- **Logic:** `transport.js` detects the host: in a VS Code webview it wraps the real `acquireVsCodeApi()`; in a browser it provides the same surface backed by fetch (request verbs), the WS (push + terminal streams), and `localStorage` (`getState`/`setState`).
- **Implementation:** No per-call-site rewrites — the shim is API-compatible, so the 575 sites are untouched; only the bootstrap of each panel changes to load the shim first.
- **Edge Cases:** WS drop mid-session → reconnect with backoff + full resync; `setState` size limits differ between webview state and `localStorage` — cap and warn rather than throw.

### `package.json`
- **Context:** Currently extension-only packaging (80 `switchboard.*` configuration properties, `vscode-test` test script).
- **Logic:** Add `bin: { "switchboard": "dist/standalone/cli.js" }`, `"engines": { "node": ">=22.0.0" }`, new deps (`node-pty@^1.2.0`, `@xterm/xterm@^6` + fit/attach/webgl addons, `ws`, `@napi-rs/keyring`), and a standalone build target alongside the webpack extension build.
- **Implementation:** Keep the extension's packaging path untouched; the standalone bundle is a second webpack target (the VSIX must still bundle everything — no runtime `node_modules` assumptions).
- **Edge Cases:** `node-pty` must NOT be bundled into the extension VSIX (extension doesn't use it); mark it external to the extension target so VSIX size and load behavior are unchanged.

## Verification Plan

> Session note: per review-session directives, no compilation and no automated tests were run during this planning review. The items below are the implementer's verification contract.

### Automated Tests
- A **protocol-parity test** driven by the Phase 0 catalog: assert every catalogued verb has a live HTTP/WS endpoint and a matching UI call site. The catalog is the fixture; a verb missing an endpoint fails CI. (Existing provider tests cover far less than the 706-arm surface — the catalog test is the real parity tripwire, not the legacy suite.)
- **Extension-regression tests**: the existing Provider-level tests (`src/services/__tests__/`, `src/test/`) must still pass unchanged (proves the handler extraction is behavior-preserving for the covered paths).
- Fleet unit tests: spawn/route/kill/resize against `node-pty` with a fake agent CLI.
- Single-instance guard test: live-peer probe refuses second start; stale port file is overwritten.
- WS auth test: upgrade without a valid token is rejected; HTTP routes reject bad Host/Origin.

### Manual
- `npx switchboard` on a clean macOS + Windows + Linux box (Node ≥22 present): board loads, a plan moves across columns, an agent CLI launches in a fleet pane, text routes to the right pane, output streams back.
- Linux **arm64** smoke (Docker on Apple Silicon suffices) — guards the node-pty arm64-mispackage regression class; and a **pnpm**-installed run on macOS — guards the `spawn-helper` permission-bit regression class.
- Open 9+ fleet panes at once — grid stays alive (DOM-default rendering; no WebGL-context exhaustion), focused pane still gets the WebGL renderer.
- Same `.switchboard/` workspace opened by **both** the VS Code extension and the standalone service **in turn, never concurrently** — board state and `kanban.db` stay consistent (proves the shared-state constraint); then attempt a concurrent second start and confirm the guard blocks it with a clear message.
- `.agents/skills/kanban_operations/move-card.js` works against the standalone service's `/health` + `/kanban/move` unchanged.
- Kill the WS (dev tools) mid-session, reconnect → board resyncs to current state with no stale cards.

## Uncertain Assumptions — RESOLVED (web research completed 2026-07-07)

All five uncertainties flagged during review were confirmed or resolved by the commissioned dependency-risk research brief; the resolutions are folded into Resolved Decisions, Phase 2, Dependencies, and the audits above. For the record:

1. **Zed terminal API — CONFIRMED absent.** `zed_extension_api` v0.7.x (WASI-sandboxed) exposes no terminal create/enumerate/input; the Visual Extension API draft RFC #53403 explicitly excludes terminal handles. The Zed-native rejection stands. Optional future Zed integration path: expose the standalone service as an MCP server.
2. **`node-pty` prebuilds — RESOLVED: upstream ships them.** `node-pty@^1.2.0` packages `prebuildify` prebuilds in the npm tarball (macOS x64/arm64, Windows x64/ia32, Linux glibc+musl x64/arm64). No custom pipeline, no `@homebridge` fork (its `prebuild-install` chain is deprecated and fails behind firewalls). Two known 2026 packaging regressions to guard: darwin `spawn-helper` mode-644 bug (Issue #850; defensive `chmod 0o755` at CLI startup) and the linux-arm64 mispackage (Issue #860, fixed by PR #857; CI must smoke genuine arm64).
3. **Keychain — RESOLVED: `@napi-rs/keyring`.** `keytar` is archived (Dec 2022) and its distribution chain deprecated. `@napi-rs/keyring` (Rust `keyring-rs` via NAPI-RS) covers macOS Keychain / Windows Credential Manager / Linux Secret Service over D-Bus, ships prebuilds as `optionalDependencies` with zero postinstall scripts.
4. **xterm packaging — RESOLVED: `@xterm/*` scope, v6.** Unscoped packages frozen since 2024. Canvas addon **removed** in v6. Addon set: `addon-fit` (per-pane sizing → resize control packet → `pty.resize`), `addon-attach` (WS stream), `addon-webgl` (focused pane only — browsers cap live WebGL contexts at ~8–16/page, so the grid defaults to the DOM renderer).
5. **Node floor — RESOLVED: `engines >=22`, baseline Node 24.** Node 20 hit EOL 2026-04-30; Node 22 is Maintenance LTS (EOL 2027-04); Node 24 is Active LTS (through 2028). Dep floors (Node ≥18) are not the binding constraint — the EOL calendar is.

Stack choice independently validated by prior art: VS Code Server / code-server, wetty, and remobi all run `@xterm` + `node-pty` (or a close variant) over WebSockets; the research also independently converged on the same localhost-WS security posture this plan already mandates (high-entropy boot token validated at the upgrade handshake).

## Effort Estimate (one experienced engineer familiar with the codebase)
- **Full parity — the required target** (all five panels, fleet, `npx`): **~4–7 months**, with the Phase 3 transport migration ≈ half of it. There is no partial-ship milestone; the deliverable is a browser board at feature parity with the extension.
- **Incremental internal milestones** (not shippable scope reductions, just burn-down order): first panel migrated ≈ end of month 2–3; all panels + distribution ≈ month 4–7.
- **Compression lever:** the 432-verb / 706-handler migration is highly repetitive/patterned — disciplined AI-agent-driven porting (ironically, Switchboard's own job) can roughly halve Phase 3 and is the main way to pull the parity date in.
- **Slip risk:** `node-pty` packaging regressions in the v1.2.x line (upstream prebuilds shrank this risk from "build a pipeline" to "smoke-test the matrix", but 2026 shipped two real regressions — keep the OS × arch × package-manager smoke matrix budgeted, not an afterthought).

## Recommendation

Complexity 9 → **Send to Lead Coder**.

**Stage Complete:** PLAN REVIEWED
