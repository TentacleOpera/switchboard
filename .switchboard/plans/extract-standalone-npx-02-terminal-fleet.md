---
description: "Standalone npx Switchboard, subtask 2 of 4: node-pty terminal fleet with name-keyed registry replacing the VS Code integrated-terminal fleet, plus the @xterm/xterm v6 browser grid streamed over WebSocket with DOM-default/focused-pane-WebGL rendering (Phase 2)"
---

# Feature B · B3 — `node-pty` Terminal Fleet + xterm Browser Grid

## Goal

Replace the VS Code integrated-terminal fleet with a service-owned **`node-pty` pool** (name-keyed registry preserving today's name-based routing) and render it as an **`@xterm/xterm` v6 multi-pane grid in the browser**, streamed over WebSocket — upgrading the execution engine from write-only `sendText` to fully bidirectional PTYs.

**Context (parent architecture):** Subtask 2 of the feature decomposing `.switchboard/plans/extract-standalone-npx-browser-service.md` (Plan ID `81299C8F-E2FA-4F93-881D-83231E1798A1`). Switchboard's execution model is a message router over a terminal fleet: it enumerates `vscode.window.terminals`, finds the terminal named for an agent, and injects text (name-based find at `src/services/TaskViewerProvider.ts:7768`; fleet create/find/route in `src/extension.ts:381`, `src/extension.ts:2269–2795` — "Jules Monitor"/"MCP Monitor"/per-agent-grid terminals; 41 `window.terminals` sites, 41 `sendText`/`sendRobustText` sites, 9 `createTerminal` sites, 3 `onDidCloseTerminal` sites). This subtask builds the standalone equivalent. Parent hard constraint applies: the extension keeps its `vscode.Terminal` path untouched — shared routing logic goes behind a `TerminalBackend` interface, it is not rewritten in place. This subtask covers the parent's Phase 2.

> **Renumbering (2026-07-08):** the original 4-subtask feature was split into Feature A + Feature B. Old numbers used below map as: **subtask 1 → A1** (protocol catalog); **subtask 2 → B3** (this plan); **subtask 3 → A2a** (wsHub/auth/seams) + **A2b** (endpoints/extraction); **subtask 4 → B4**.

## Metadata
- **Plan ID:** 341ac949-57bf-4223-847d-0ba8876771dc
- **Tags:** backend, frontend, infrastructure
- **Complexity:** 8
- **Release phase:** **Post-release / headless.** The node-pty fleet + xterm browser grid is the standalone execution engine and live in-browser terminals — a post-release capability, **NOT** foundational. Extension-as-engine mode keeps VS Code's integrated terminals; browser terminal streaming lands only with this plan.

> **Detached from the Standalone Headless Switchboard feature (2026-07-17).** This is now a **standalone backlog plan**, not a subtask of that feature. The feature ships the *terminal-free* browser cockpit (B1 + B2 + B4) — VS Code stays the terminal holder for in-editor execution. This plan is the optional future automation/execution layer: when built, it wires a live `TerminalBackend`, flips the host capability to `terminalDispatch: true`, and lights up the CLI/automation pathways the feature's browser UI otherwise hides. It still depends on A2a (seam + wsHub) and B1 (standalone bootstrap) if/when it is picked up.

## User Review Required
- None — the deliberate product change (Switchboard-owned browser terminals instead of editor `` Ctrl+` `` terminals) was accepted in the parent plan's review.

## Scope

### ✅ IN SCOPE
- **`TerminalFleet` (`src/standalone/TerminalFleet.ts`, new):** `node-pty@^1.2.0` pool with a name-keyed registry — spawn / find-by-name / route-input / kill / resize / close-event fan-out, mirroring the `terminals.find(...)` semantics of the extension fleet.
- **`TerminalBackend` interface:** extracted seam over the create/find/route/close operations; `vscode.Terminal`-backed impl for the extension (behavior-preserving), `TerminalFleet` impl for standalone.
- **Browser grid:** `@xterm/xterm` **v6** panes, one per fleet member; PTY output streamed over WebSocket via `@xterm/addon-attach`; keyboard input routed back to the PTY.
- **Renderer strategy (load-bearing, not an optimization):** browsers cap live WebGL contexts at ~8–16/page and the canvas addon was **removed** in xterm v6 — all panes default to the built-in DOM renderer; `@xterm/addon-webgl` is attached dynamically to the focused/high-throughput pane and disposed on blur.
- **Resize:** `@xterm/addon-fit` per pane computes cols/rows → JSON control packet over WS (`{"type":"resize","cols":…,"rows":…}`) → `ptyProcess.resize(cols, rows)`.
- **Lifecycle:** exit status, close events (replacing the 3 `onDidCloseTerminal` sites), resize, focus semantics.
- **Prebuild regression guards** for upstream `node-pty` in-tarball prebuilds (macOS x64/arm64, Windows x64/ia32, Linux glibc+musl x64/arm64): (a) darwin `spawn-helper` mode-644 bug (Issue #850) — defensive `chmod 0o755` at startup; (b) linux-arm64 mispackage class (Issue #860 / PR #857) — CI smoke on genuine arm64.

### ⚙️ OUT OF SCOPE
- The WS server/auth itself (`wsHub` token-gated upgrade lands with subtask 3's transport work; this subtask consumes it — coordinate the WS message envelope with the subtask-3 owner early).
- Migrating the 706 provider handler arms (subtask 3); npx packaging (subtask 4).

## Implementation Steps

1. **`TerminalBackend` interface** — define over create/find-by-name/send-input/kill/resize/on-close; wrap the existing vscode fleet behind it without changing extension behavior (adapter delegates to current code paths at `TaskViewerProvider.ts:7768`, `extension.ts:381,2269–2795`).
2. **`TerminalFleet.ts`** — `node-pty` pool implementing the interface; name registry with the same suffix-matching rules as `_suffixedName`/`matchesGridAgentName`.
3. **WS streaming envelope** — frame PTY output chunks and input/resize/control packets; per-pane channel IDs keyed by terminal name.
4. **Browser grid** — pane manager creating one `@xterm/xterm` v6 instance per fleet member; `addon-attach` per pane; `addon-fit` + resize packets; DOM-default rendering with focused-pane WebGL attach/dispose.
5. **Lifecycle parity** — exit-status surfacing, close fan-out, focus semantics matching the grid UX the extension provides today.
6. **Prebuild guards** — startup chmod fix; CI smoke matrix (macOS x64/arm64, Windows x64, Linux x64/arm64; npm + pnpm).

## Complexity Audit

### Routine
- `addon-fit` sizing + resize packet plumbing.
- Startup chmod guard.

### Complex / Risky
- **Native-module distribution** — upstream prebuilds shrank this from "build a pipeline" to "smoke-test the matrix", but the v1.2.x line shipped two real 2026 packaging regressions; the OS × arch × package-manager matrix is mandatory.
- **Name-routing parity** — the suffix/match rules (`_suffixedName`, `matchesGridAgentName`) are subtle; a mismatch strands agent messages in the wrong pane exactly like the historical name-collision bugs.
- **WebGL context exhaustion** — naively attaching WebGL to every pane crashes the canvas layer past the browser cap; the DOM-default strategy must be enforced structurally (pane manager owns the single WebGL attachment).
- **Backpressure** — a fast agent (build logs) can outpace the WS; unbounded buffering balloons memory. Chunk coalescing + bounded scrollback required.

## Edge-Case & Dependency Audit

### Race Conditions
- PTY exits while input in flight → route to close handler, not a dead stream write.
- Two spawn requests for the same agent name → registry must serialize; second request attaches to the existing PTY (matching extension find-or-create semantics).
- WS reconnect mid-stream → pane replays bounded scrollback, then live-tails (full-fidelity replay is out of scope; bounded is the contract).

### Security
- PTY input = command execution; this subtask trusts the WS layer's token-gated handshake (subtask 3) and must not add any unauthenticated input path of its own.
- Spawned PTYs inherit the service's env — scrub secrets (keyring passphrases, api tokens) from child env.

### Side Effects
- The `TerminalBackend` adapter wraps extension code paths — 41 `window.terminals` sites keep working verbatim; adapter tests prove delegation.
- `node-pty` must NOT enter the extension VSIX bundle (webpack external for the extension target; VSIX bundles everything and has no node_modules escape hatch).

### Dependencies & Conflicts
- New deps: `node-pty@^1.2.0`, `@xterm/xterm@^6`, `@xterm/addon-fit`, `@xterm/addon-attach`, `@xterm/addon-webgl`, `ws` (shared with subtask 3). Unscoped `xterm`/`xterm-addon-*` are frozen; canvas addon removed in v6 — do not reference either.
- **Depends on subtask 1** (`extract-standalone-npx-01-protocol-core.md`, Plan ID `eb75281d-d8f3-4e50-b396-f7626abed020`): bootstrap + config/secret plumbing.
- **Coordinates with subtask 3** (`extract-standalone-npx-03-transport-migration.md`): shares the WS server; agree the message envelope early.

## Dependencies
- **Session dependencies:** **A2a** (`aaeafbeb-f4f0-40b4-a335-53e69febc8f7` — `TerminalBackend` seam interface + wsHub) and **B1** (`cffd3a43-964b-4e7f-b530-469f8c3f0a76` — standalone bootstrap) must land first; WS envelope coordinated with A2a. A1 (`eb75281d-d8f3-4e50-b396-f7626abed020`) provides the catalog.
- Parent architecture reference: `.switchboard/plans/extract-standalone-npx-browser-service.md`.

## Adversarial Synthesis

Key risks: name-routing parity drift stranding agent input in wrong panes, native-prebuild packaging regressions breaking installs, and WebGL context exhaustion crashing multi-pane grids. Mitigations: reuse the exact suffix-match functions behind the `TerminalBackend` seam with parity tests against a fake agent CLI; CI smoke matrix across OS × arch × package manager; structurally-enforced DOM-default rendering with a single dynamically-attached WebGL context.

## Proposed Changes

### `src/standalone/TerminalFleet.ts` (new)
- **Context:** No PTY management exists; all terminal control is `vscode.window.*`.
- **Logic:** Pool + name registry + lifecycle per Implementation Steps 2–3.
- **Implementation:** Implements `TerminalBackend`; bounded scrollback buffer per PTY.
- **Edge Cases:** spawn failure → board-visible pane error, not a silent missing terminal; env scrubbing.

### `src/services/terminalBackend.ts` (new interface) + adapter touching `src/services/TaskViewerProvider.ts`, `src/extension.ts`
- **Context:** create/find/route logic at `TaskViewerProvider.ts:7768`, `extension.ts:381,2269–2795`.
- **Logic:** Interface extraction; vscode adapter delegates to existing code verbatim.
- **Implementation:** Mechanical wrap — no behavior change; extension tests must stay green.
- **Edge Cases:** `exitStatus === undefined` liveness checks preserved exactly (they filter dead terminals today).

### `src/webview/terminalGrid.js` (new) + grid pane in the board UI
- **Context:** No browser terminal UI exists.
- **Logic:** Pane manager per Implementation Step 4; renderer strategy per Scope.
- **Implementation:** One WebGL attachment owned by the pane manager; DOM default everywhere else.
- **Edge Cases:** 9+ panes alive simultaneously; focus churn must attach/dispose WebGL without leaking contexts.

## Verification Plan

### Automated Tests
- Fleet unit tests: spawn/route/kill/resize against `node-pty` with a fake agent CLI; name-suffix parity cases mirrored from `matchesGridAgentName` fixtures.
- Adapter tests: extension terminal paths delegate unchanged (existing tests green).
- Backpressure test: flood PTY output; memory stays bounded; no dropped close events.

### Manual
- Launch an agent CLI in a fleet pane; text routes to the correct pane by name; output streams back; kill → pane shows exit status.
- Open 9+ panes — grid stays alive (no WebGL-context exhaustion); focused pane visibly gets the WebGL renderer.
- Linux arm64 (Docker on Apple Silicon) + pnpm-on-macOS installs load prebuilds without a compiler.

**Stage Complete:** PLAN REVIEWED
