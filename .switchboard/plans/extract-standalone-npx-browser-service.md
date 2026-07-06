---
description: Extract Switchboard's host-agnostic core into a standalone Node service with a browser-hosted board and a node-pty terminal fleet, distributed via npx — an editor-independent Switchboard that runs next to any editor (including Zed) without the VS Code extension host
---

# Plan: Standalone `npx` Switchboard — Editor-Independent Service + Browser Board

## Goal

Ship a version of Switchboard that runs **outside any editor** as a local Node service with a **browser-hosted board**, launched with `npx switchboard`. The service owns its own **`node-pty` terminal fleet** (replacing the VS Code integrated-terminal fleet Switchboard drives today), and the existing webview UI is re-hosted in the browser by migrating its transport from VS Code's `postMessage` bridge to **HTTP + WebSocket**. The VS Code extension continues to ship unchanged; this is an additional distribution, not a replacement.

### Problem / Background — why this, and why not the alternatives

The trigger was "how hard is a Zed-compatible Switchboard?" A codebase survey settled the design space to exactly three paths, two of which we rejected on their merits:

- **Zed-native extension — infeasible.** Switchboard's execution model is a *message router over the editor's terminal fleet*: it enumerates `vscode.window.terminals`, finds the terminal named for a given agent, and injects text with `sendText` (see `src/services/TaskViewerProvider.ts` ~15733–15746, `src/extension.ts` ~2799–2891, the "Jules Monitor"/"MCP Monitor"/per-agent-grid terminals). **Zed's extension API exposes no terminal control at all** — no create, no enumerate, no send-text. The single primitive Switchboard is built on has zero equivalent in Zed. This is not a "rewrite the glue" gap; the host withholds the capability. Dead end.
- **Fork VS Code (à la Cursor/Windsurf) — rejected on cost.** A fork keeps the entire extension/terminal/webview API, so Switchboard runs unchanged with *zero* porting — but it trades a one-time port for a permanent editor-maintenance treadmill (monthly upstream merges, marketplace/licensing loss, sign/build/ship an entire IDE). Justified only if the goal is to become an editor company, which it is not. Note: Cursor and Windsurf are *already* VS Code forks; publishing to **Open VSX** puts Switchboard on both today for near-zero cost — that is the cheap answer to "reach beyond stock VS Code," and is captured as a separate no-op-sized follow-up, not part of this plan.
- **Standalone service + browser board via `npx` — chosen (this plan).** The terminal fleet has to live *outside* the editor sandbox regardless of target editor, so build it once as an editor-independent app. This sidesteps every host-API constraint, runs next to Zed / any editor / nothing, and — because `node-pty` is bidirectional where VS Code's `sendText` is write-only — is actually a *more capable* execution engine (it can read agent output, detect prompts/completion, react) rather than a lossy port.

### Root-cause insight that makes this tractable

The codebase already has a **clean host-agnostic core** and was partly built anticipating non-editor hosts:

- **`src/services/LocalApiServer.ts` (65 KB, 0 `vscode` refs)** is a plain Node `http.createServer` bound to `127.0.0.1` on an ephemeral port, wired entirely through **injected callbacks** (`moveCard`, `createFeature`, `getClickUpService`, `getAuthToken`, `workspaceRoot`, …). Its own docstrings note these are "absent in headless/test harnesses." This is the seam the standalone service is built on.
- **`agentPromptBuilder.ts` (95 KB, 0 refs)**, the ClickUp/Linear/Notion sync services, `KanbanMigration.ts`, `complexityScale.ts`, `planStateUtils.ts`, `agentConfig.ts`, `SessionActionLog.ts` — all vscode-free.
- **`KanbanDatabase.ts` (320 KB)** runs on `sql.js` (WASM SQLite — host-agnostic) with only ~12 vscode refs, all lazy `require('vscode')` behind guards for path/config resolution — a thin seam to abstract.
- The `.switchboard/` state (plans as `.md`, `kanban.db`, `api-server-port.txt`) is a plain filesystem + SQLite store with no editor dependency, and the entire `.agents/skills/` layer talks to the extension **only over the local HTTP API** — so those skills keep working against the standalone service untouched.

So the coupling is **localized**, not pervasive: it lives in `extension.ts` (176 KB) and the five webview Provider files (`TaskViewerProvider` 998 KB, `KanbanProvider` 567 KB, `PlanningPanelProvider` 481 KB, `DesignPanelProvider` 163 KB, `SetupPanelProvider` 94 KB). The work is (1) lift the message-handler bodies out of those providers into host-agnostic services, (2) swap the transport, and (3) swap the terminal backend. The *business logic* mostly moves as-is.

## Metadata
- **Plan ID:** 81299C8F-E2FA-4F93-881D-83231E1798A1
- **Tags:** refactor, backend, frontend, cli, infrastructure, devops
- **Complexity:** 9
- **Project:** switchboard

## User Review Required

- **Panel scope for MVP.** Proposed MVP ships **kanban + planning + terminal fleet** and defers **design/Stitch** and **project** panels. Confirm that subset, or name a different one. This roughly halves the transport-migration surface for v1.
- **UI reuse vs. rebuild.** Plan assumes the existing webview HTML/JS is **reused** (only its transport changes). Confirm you don't want a UI rewrite bundled into this effort.
- **Terminal semantics.** Confirm the standalone fleet's terminals being *Switchboard-owned browser terminals* (not the editor's `` Ctrl+` `` terminals) is acceptable — this is the deliberate product change, not an accident.

## Scope

### ✅ IN SCOPE
- A standalone Node process (`switchboard` bin) that starts `LocalApiServer`, serves the browser board, and manages a `node-pty` terminal fleet.
- Extracting message-handler logic out of the five Provider files into host-agnostic service modules callable by both the extension and the standalone service.
- Migrating the browser↔host transport from `postMessage` to HTTP (request/response) + WebSocket (host→UI push).
- A `node-pty` fleet + `xterm.js` browser grid replacing `vscode.window.terminals` create/find/`sendText`, with name-based routing preserved.
- Replacements for VS Code host services the core relies on: `SecretStorage` (token storage, ~8 sites), the ~90 `switchboard.*` settings, workspace-root/path resolution, `Memento` (global/workspace state, ~5 sites).
- Browser-appropriate auth + CORS for the local origin, extending the existing `strictInboxAuth`/session-token model.
- `npx` distribution: `bin`, a launcher that boots the service and opens the browser, and a **`node-pty` prebuilt-binary pipeline** (macOS/Linux/Windows × x64/arm64).

### ⚙️ OUT OF SCOPE (this plan)
- **Design/Stitch panel** and **project panel** transport migration (defer to a follow-up; MVP subset above).
- **Electron desktop packaging** — explicitly not doing it; `npx` is the distribution. Electron remains a *possible later* upgrade, decided with real usage data.
- **Extension-as-launcher** (having the VS Code extension boot the standalone browser board) — attractive to preserve marketplace discovery, but a separate follow-up.
- **Open VSX publish** (Cursor/Windsurf reach) — unrelated near-zero-cost follow-up.
- Any change to the shipped VS Code extension's behavior (see constraint below).

### 🚫 HARD CONSTRAINT — do not regress the shipped extension
The extension has **~4,000 installs**, many on old versions. The extraction refactor (lifting handlers out of Providers into shared services) touches code the shipped extension runs. This work must be **behavior-preserving for the extension**: the extension keeps using `postMessage` + `vscode.Terminal` by having its thin provider layer call the *same* extracted service methods the standalone service calls over HTTP. `.switchboard/` on-disk state and `kanban.db` schema are shared between both run modes and must stay format-compatible — no migration that only the standalone path understands.

## Resolved Decisions
- **Transport:** HTTP for request/response verbs; a single WebSocket for host→UI push (the ~985 `webview.postMessage` broadcast sites). Not SSE (need bidirectional for terminal streams).
- **Terminal backend:** `node-pty` + `xterm.js`. Bidirectional; name-keyed fleet registry mirrors today's name-based `terminals.find(...)` routing.
- **State/config:** settings move to a JSON/YAML config file + env overrides; secrets to OS keychain (via `keytar` or equivalent) with a plaintext-file fallback for headless. `Memento` → a small JSON state store under `.switchboard/`.
- **UI:** reuse existing `src/webview/*` HTML/JS; introduce a transport shim so the same code runs in both the VS Code webview (postMessage) and the browser (HTTP/WS) with a build-time or runtime switch.

## Implementation Steps

**Phase 0 — Protocol inventory (prerequisite, ~1 wk).**
Enumerate the full message contract so later phases are mechanical, not archaeological. Measured surface today: **~434 distinct message `type:` values** sent from `src/webview/*`, **~680 handler `case` arms** across the five Providers, **~985 host→webview push sites**, **576 `postMessage` call sites** in the UI. Produce a machine-readable catalog (verb → direction → payload shape → owning provider → target service method). This catalog is the migration checklist.

**Phase 1 — Extract host-agnostic core service (~2–4 wks).**
- Stand up the `switchboard` bin + a service bootstrap that constructs `LocalApiServer` with real callback implementations (not VS Code shims).
- Abstract the ~12 lazy `require('vscode')` seams in `KanbanDatabase.ts` behind an injected path/config provider.
- Implement config (90 settings), secret storage (8 sites), and state (`Memento`, 5 sites) replacements.
- Reuse `agentPromptBuilder`, sync services, `KanbanMigration`, `SessionActionLog` as-is.

**Phase 2 — Terminal fleet (~3–5 wks, includes prebuild pipeline).**
- `node-pty` pool with a name-keyed registry; port the create/find/route logic from `TaskViewerProvider`/`extension.ts` to spawn+route against owned PTYs.
- `xterm.js` grid in the browser, one pane per fleet member, streamed over WebSocket; input routed back to the PTY.
- Lifecycle: exit status, close events (replacing `onDidCloseTerminal`), resize, focus semantics.
- `node-pty` prebuilt binaries across macOS/Linux/Windows × x64/arm64 (`prebuildify`/`node-gyp` or a prebuilt-multiarch package).

**Phase 3 — Handler extraction + transport migration, MVP subset (~4–8 wks).**
- For the MVP panels (kanban + planning), lift each `case` arm's body out of the Provider into a shared service method (Phase 1 target), leaving the Provider as a thin `postMessage`→service adapter (this is the extension-preserving move).
- Add the corresponding HTTP endpoint / WS push for each verb from the Phase 0 catalog.
- Add a UI transport shim so `src/webview` calls resolve to postMessage (in-extension) or fetch/WS (in-browser).
- Auth + CORS for the browser origin.

**Phase 4 — `npx` distribution (~1–2 wks, overlaps Phase 2 prebuilds).**
- `bin` + launcher (boot service, open browser to the served board), health-gated on the existing `/health` endpoint + `api-server-port.txt`.
- Package, smoke-test `npx switchboard` clean-machine (Node-present) install on all three OSes.

**Phase 5 (post-MVP) — remaining panels.** Repeat Phase 3 for design/Stitch + project panels.

## Complexity Audit

### Routine
- Phase 4 `npx` launcher/bin wiring.
- Reusing already-vscode-free modules (`agentPromptBuilder`, sync services) in the new bootstrap.
- Serving static UI assets from `LocalApiServer` (it's already an HTTP server).

### Complex / Risky
- **Phase 3 transport migration** is the long pole: ~400-verb contract, and each verb needs handler extraction + endpoint + UI-shim + test. The risk is the extraction silently changing extension behavior.
- **`node-pty` native-module distribution** — the tail that turns "works on my machine" into "shippable"; the prebuild matrix is where release readiness slips.
- **Secret/config/state substitution** touching the shipped extension's shared code without regressing it.
- **WebSocket push fidelity** — 985 broadcast sites; missing or mis-ordered pushes manifest as a subtly stale board.

## Dependencies
- New runtime deps: `node-pty`, `xterm` (browser terminal renderer), a WS lib (`ws`), a keychain lib (`keytar` or equivalent).
- Existing: `sql.js` (unchanged), `@modelcontextprotocol/sdk`, sync-service deps — all carry over.
- CI: multi-OS/arch build runners for `node-pty` prebuilds.

## Verification Plan

### Automated
- A **protocol-parity test** driven by the Phase 0 catalog: assert every catalogued verb has a live HTTP/WS endpoint and a matching UI call site.
- **Extension-regression tests**: the existing Provider-level tests must still pass unchanged (proves the handler extraction is behavior-preserving).
- Fleet unit tests: spawn/route/kill/resize against `node-pty` with a fake agent CLI.

### Manual
- `npx switchboard` on a clean macOS + Windows + Linux box (Node present): board loads, a plan moves across columns, an agent CLI launches in a fleet pane, text routes to the right pane, output streams back.
- Same `.switchboard/` workspace opened by **both** the VS Code extension and the standalone service in turn — board state and `kanban.db` stay consistent (proves the shared-state constraint).
- `.agents/skills/kanban_operations/move-card.js` works against the standalone service's `/health` + `/kanban/move` unchanged.

## Effort Estimate (one experienced engineer familiar with the codebase)
- **Thin MVP** (kanban + planning + fleet, `npx`): **~2–3 months**.
- **Feature parity** (all panels): **~4–7 months**, transport migration ≈ half of it.
- **Compression lever:** the ~400-verb migration is highly repetitive/patterned — disciplined AI-agent-driven porting (ironically, Switchboard's own job) can roughly halve Phase 3.
- **Slip risk:** the `node-pty` prebuild matrix; budget it explicitly rather than as an afterthought.
