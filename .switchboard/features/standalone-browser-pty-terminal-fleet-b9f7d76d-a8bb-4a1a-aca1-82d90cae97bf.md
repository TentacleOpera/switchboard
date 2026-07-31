# Standalone Browser PTY Terminal Fleet

**Complexity:** 7

## Goal

Give the standalone host (npx switchboard) server-side PTY terminals so CLI agents run and dispatch from the browser cockpit with VS Code closed: a node-pty fleet backend integrated with the terminal registry, an authenticated WebSocket terminal I/O channel, an xterm.js Terminals panel in the browser shell, and board dispatch routed onto the fleet.
Hard constraint (user directive 2026-07-31): standalone-only — VS Code mode continues to use VS Code terminals, the extension bundle must never import node-pty, and the extension-hosted browser gets no Terminals panel.
The related plan standalone-secrets-bridge-global-encrypted-store.md is deliberately not part of this feature; it is the standalone secrets prerequisite and ships independently first.

## How the Subtasks Achieve This

- **Standalone PTY Fleet Backend: node-pty TerminalBackend and Registry Integration**: the process layer — adds node-pty (prebuilt-binary fork, webpack-external in the standalone bundle only), implements the existing `TerminalBackend`/`TerminalHandle` seam in `hostSeams.ts` with real `write`/`onData`/`resize`, and registers fleet terminals in `state.terminals` with `purpose:'pty'` / `ideName:'standalone-pty'` so `/health`, worktree routing, and the dispatch pre-flight all see them. Enforces the standalone-only constraint with an import-location + bundle-purity contract test.
- **PTY Terminal I/O over WebSocket: Attach Protocol, Scrollback Replay, and Backpressure**: the transport — a `/ws/terminal` upgrade path (standalone-wired only) reusing wsHub's upgrade auth as a shared helper but stricter (rejects when no auth token is configured), with a JSON+base64 frame protocol, per-terminal 256KB scrollback replayed on attach, multi-viewer fan-out, and pty pause/resume backpressure so a slow browser tab can never kill an agent.
- **Browser Terminals Panel: xterm.js Rail Tab in the Standalone Shell**: the surface — a browser-only `terminals.html`/`terminals.js` panel (memo-panel precedent) rendering fleet terminals with vendored xterm.js + fit addon, gated by a fail-closed `availability.terminals` flag that only standalone sets, with theme fan-out integration and seq-deduped reconnect/replay.
- **Standalone Agent Dispatch onto the PTY Fleet**: the payoff — bracketed-paste prompt delivery straight to the pty (replacing the VS Code clipboard dance), plan→terminal resolution reusing `worktreeResolver` semantics with lazy spawn, standalone verb arms for `triggerAction`/dispatch-moves/`sendToTerminal`/memo-send, the `terminalDispatch:true` capability flip that un-hides board dispatch buttons, and verification that mtime-based completion detection (activity light) runs in standalone.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Standalone PTY Fleet Backend: node-pty TerminalBackend and Registry Integration](../plans/pty-fleet-backend-standalone-terminal-registry.md) — **LEAD CODED**
- [ ] [PTY Terminal I/O over WebSocket: Attach Protocol, Scrollback Replay, and Backpressure](../plans/pty-websocket-terminal-io-channel.md) — **LEAD CODED**
- [ ] [Browser Terminals Panel: xterm.js Rail Tab in the Standalone Shell](../plans/browser-terminals-panel-xterm.md) — **LEAD CODED**
- [ ] [Standalone Agent Dispatch onto the PTY Fleet](../plans/standalone-dispatch-via-pty-fleet.md) — **LEAD CODED**
<!-- END SUBTASKS -->

## Dependencies & sequencing

Recommended order: **fleet backend → WS channel → xterm panel → dispatch.**

- The fleet backend is the hard prerequisite for everything else (it owns the PTY handles, registry entries, and the extended `TerminalHandle` seam).
- The WS channel depends on the fleet backend; the xterm panel depends on the WS channel.
- Dispatch depends only on the fleet backend and can proceed in parallel with the WS channel + panel pair — but UAT of dispatch is far easier once the panel exists to watch prompts land.
- External prerequisite (not a subtask): the standalone secrets bridge plan (`standalone-secrets-bridge-global-encrypted-store.md`) should ship first so agents launched in fleet terminals have working integrations; nothing here technically blocks on it.

## Reconciliation Notes (improve-feature 2026-07-31)

Cross-subtask audit outcome — reconciled end-state the coder should implement to:

- **`terminalFleet` capability:** owned solely by the fleet backend subtask (`bootstrap.ts:388`). The panel subtask sets `availability.terminals` only.
- **Fleet-change events:** PtyFleetService is the single owner, via an `onDidChange` hook; the WS gateway subscribes to it to emit the `terminalsChanged` hub broadcast (no polling, no duplicate emitters).
- **Scrollback ring buffer:** fed from terminal creation (fleet-change subscription), not first attach — first-attach replay must never be empty.
- **Dispatch ordering:** prompt delivery after a lazy spawn awaits the fleet `create()` startup injection completing (the 750ms shell-readiness delay) before bracketed-paste writes begin.
- **Upgrade routing:** exactly one `'upgrade'` router, owned by `LocalApiServer` (wsHub's self-attached private listener is extracted) — `/ws` → hub, `/ws/terminal` → gateway, else destroy.
- **Backpressure:** two-tier — `pty.pause()` at high-water, laggard client eviction (disconnect + lossless re-attach via replay) as the backstop; pause-the-world alone is insufficient.
- All four subtask plans were improved in place (no merges/deletes/splits); all remain in PLAN REVIEWED.

## Research Findings (2026-07-31, folded into subtask plans)

- **Dependency decision REVERSED:** use upstream `node-pty` v1.1.x/v1.2.x (N-API, prebuilds bundled in the npm tarball), NOT `@homebridge/node-pty-prebuilt-multiarch` (install-time `prebuild-install` download fails under `--ignore-scripts`/offline/proxy). Caveats coded into the backend plan: darwin `spawn-helper` needs a runtime `chmod 0o755` repair (v1.1.0 tarball defect), Linux prebuilds live in the v1.2.x line, and all `IPty` instances must be killed/disposed before process exit (SIGABRT teardown race).
- **`IPty.pause()`/`resume()` confirmed:** output buffers in the OS kernel PTY buffer, never drops — the WS backpressure design is sound; don't pause before the first data cycle.
- **xterm vendoring confirmed:** `@xterm/xterm` `lib/xterm.js` + `css/xterm.css`, `@xterm/addon-fit` `lib/addon-fit.js` — plain script-tag UMD, nonce-CSP compatible.
- All previous `## Uncertain Assumptions` sections are now `## Resolved Assumptions` in the subtask plans. No open external uncertainties remain; the feature is ready to execute.
