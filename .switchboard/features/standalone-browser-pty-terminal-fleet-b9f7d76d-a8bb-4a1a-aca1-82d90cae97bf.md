# Standalone Browser PTY Terminal Fleet

**Complexity:** 7

## Goal

Give the standalone host (npx switchboard) server-side PTY terminals so CLI agents run and dispatch from the browser cockpit with VS Code closed: a node-pty fleet backend integrated with the terminal registry, an authenticated WebSocket terminal I/O channel, an xterm.js Terminals panel in the browser shell, and board dispatch routed onto the fleet.
**Current directive (user, 2026-07-31, later the same day — supersedes the standalone-only constraint below): PTY terminals are available in BOTH hosts.** The extension bundle MAY carry node-pty, loaded only behind the `isPtyAvailable()` probe, and the extension-hosted browser gets the Terminals panel. VS Code's own sidebar board continues to dispatch to VS Code terminals; the browser cockpit uses PTYs. Delivery is planned in `../plans/extension-host-pty-fleet-and-packaging.md`; this feature's four subtasks shipped the standalone half and remain valid.

Two reasons drove the reversal, neither weighed in the original directive:
1. **The marketplace is the only distribution channel that exists.** Nothing is published to npm, and `switchboard` there belongs to a third party (an event-listener library by `bryn.bellomy`), so `npx switchboard` cannot work and standalone reaches no users. Discoverability lives entirely in the VS Code marketplace.
2. **An owned terminal surface is a better experience, not parity.** Layouts, per-worktree tab switching and agent completion messages are possible only when Switchboard owns the terminal stream; VS Code's terminal panel structurally cannot provide them, and no stable API exposes its output for mirroring.

**The trade, stated honestly:** this swaps a hard, mechanically-verifiable invariant ("node-pty never appears in the extension bundle") for a soft one ("node-pty is only reached behind the gate"). A grep can verify the former and cannot verify the latter. The compensating control is that `isPtyAvailable()` is the single derivation point for `terminalDispatch`, `terminalFleet` and `availability.terminals`, and `src/standalone/ptyBackend.ts` is the only module that loads the native binding — so a reviewer has exactly one function and one file to audit. Both facts are enforced by `npm run test:contract:pty-host-gating`.

> **Superseded (original directive, 2026-07-31):** "Hard constraint (user directive 2026-07-31): standalone-only — VS Code mode continues to use VS Code terminals, the extension bundle must never import node-pty, and the extension-hosted browser gets no Terminals panel."
> **Reason:** Reversed by the user the same day, for the two reasons above. Retained because the shipped code still carries comments and design choices that only make sense against it.
The related plan standalone-secrets-bridge-global-encrypted-store.md is deliberately not part of this feature; it is the standalone secrets prerequisite and ships independently first.

## How the Subtasks Achieve This

- **Standalone PTY Fleet Backend: node-pty TerminalBackend and Registry Integration**: the process layer — adds node-pty (prebuilt-binary fork, webpack-external in the standalone bundle only), implements the existing `TerminalBackend`/`TerminalHandle` seam in `hostSeams.ts` with real `write`/`onData`/`resize`, and registers fleet terminals in `state.terminals` with `purpose:'pty'` / `ideName:'standalone-pty'` so `/health`, worktree routing, and the dispatch pre-flight all see them. Enforces the standalone-only constraint with an import-location + bundle-purity contract test.
- **PTY Terminal I/O over WebSocket: Attach Protocol, Scrollback Replay, and Backpressure**: the transport — a `/ws/terminal` upgrade path (standalone-wired only) reusing wsHub's upgrade auth as a shared helper but stricter (rejects when no auth token is configured), with a JSON+base64 frame protocol, per-terminal 256KB scrollback replayed on attach, multi-viewer fan-out, and pty pause/resume backpressure so a slow browser tab can never kill an agent.
- **Browser Terminals Panel: xterm.js Rail Tab in the Standalone Shell**: the surface — a browser-only `terminals.html`/`terminals.js` panel (memo-panel precedent) rendering fleet terminals with vendored xterm.js + fit addon, gated by a fail-closed `availability.terminals` flag that only standalone sets, with theme fan-out integration and seq-deduped reconnect/replay.
- **Standalone Agent Dispatch onto the PTY Fleet**: the payoff — bracketed-paste prompt delivery straight to the pty (replacing the VS Code clipboard dance), plan→terminal resolution reusing `worktreeResolver` semantics with lazy spawn, standalone verb arms for `triggerAction`/dispatch-moves/`sendToTerminal`/memo-send, the `terminalDispatch:true` capability flip that un-hides board dispatch buttons, and verification that mtime-based completion detection (activity light) runs in standalone.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Standalone PTY Fleet Backend: node-pty TerminalBackend and Registry Integration](../plans/pty-fleet-backend-standalone-terminal-registry.md) — **CODE REVIEWED** — ID: 4839686f-ca79-46af-af16-fad054de6c40
- [ ] [PTY Terminal I/O over WebSocket: Attach Protocol, Scrollback Replay, and Backpressure](../plans/pty-websocket-terminal-io-channel.md) — **CODE REVIEWED** — ID: 9ee08717-14ed-4485-bc3a-cdaa057516ac
- [ ] [Browser Terminals Panel: xterm.js Rail Tab in the Standalone Shell](../plans/browser-terminals-panel-xterm.md) — **CODE REVIEWED** — ID: 52075bfc-34ab-4775-a02e-495b85f4d547
- [ ] [Standalone Agent Dispatch onto the PTY Fleet](../plans/standalone-dispatch-via-pty-fleet.md) — **CODE REVIEWED** — ID: 40e10e14-c5db-48eb-9bb1-1d7a06dcc345
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

## Review Findings (reviewer pass 2026-07-31)

Reviewed all four subtasks against the code; roughly 65% of the planned surface was authored but only ~40% was functional, and nothing had been verified — `npm run compile` failed outright and two CI ratchets (`catalog:check`, `verb-returns:check`) were red. Per user direction this pass fixed the CRITICAL tier only (8 findings across `hostSeams.ts`, `hostServices.ts`, `ptyFleetService.ts`, `terminalWsGateway.ts`, `bootstrap.ts`, `terminals.html`, plus regenerating the hand-edited `protocol-catalog.json`/`verbAllowlist.ts` and installing the three declared-but-missing dependencies); the ~18 MAJOR findings are recorded per-subtask and returned to the coder. The structural work was sound — the seam extension, single upgrade router, fail-closed panel gate, creation-time scrollback feed and the `terminalFleet`/`availability.terminals` ownership split all landed as reconciled — while the failures clustered entirely in the last mile: four calls to DB methods that do not exist, one payload contract matching neither caller, a `resume()` that could never fire, and a `seq` scheme that inverted its own purpose, three of them silently swallowed by `catch`. Validation now: `tsc` clean of all PTY errors (5 pre-existing TS2835 in untouched files remain), webpack 0 errors, lint 0 errors, 5/5 ratchets and 13 contract tests green, `dist/extension.js` confirmed free of any node-pty module reference, and a live darwin-arm64 node-pty smoke proving the `spawn-helper` mode-`644` defect and its chmod repair are both real. The dependency question is now closed: neither published node-pty version covers all three platforms (1.1.0 has no Linux; 1.2.0-beta.14 has Linux but no win32 `pty.node`, and that line is on its fourteenth beta), so `node-pty` is pinned to exact `1.1.0` and moved to `optionalDependencies` — install can no longer hard-fail the whole cockpit on a Linux box without build tools. That creates one new MAJOR for the coder, recorded in the backend subtask: `terminalFleet`, `terminalDispatch` and `availability.terminals` must all derive from a single bootstrap probe of whether node-pty actually loaded, or standalone ships a Terminals tab and dispatch buttons that throw when it didn't. Highest-value follow-ups: that capability probe, the missing bundle-purity/import-location CI gate (whose proposed grep form would false-fail on a comment), UTF-8-safe browser terminal I/O, and the absent worktree-aware dispatch routing.

### Reviewer pass 2 (2026-07-31, after coder round 2)

Round 2 genuinely fixed seven MAJORs — wsHub now delegates to the shared auth helper (verified behavior-identical), `getRegisteredTerminals` filters exited terminals, the `kill()` double-emit is guarded, browser I/O is UTF-8-safe via `TextEncoder`/`TextDecoder`, reconnect has close-before-reconnect + a single timer + 500 ms×1.5 backoff capped at 30 s, memo send has a real copy fallback, and SIGTERM→3 s grace→SIGKILL is both implemented and now reachable because `instance.stop()` awaits `disposeAll()`. It also reintroduced the round-1 failure mode: two more non-existent `KanbanDatabase` methods (`getConfigValueSync` ×6, `getWorktrees(workspaceId)`) broke the build, and three unrelated working verb arms (`createFeature`/`promoteToFeature`/`addSubtaskToFeature`) were deleted, failing a contract test that had passed in pass 1. All four fixed in this pass, plus the clear-before-prompt reads repointed from the kanban.db `config` table to `StandaloneHostPathConfigProvider` (the db key is never written in standalone, so the toggle would have stayed inert) and the missing path-only worktree fallback added. Validation: `tsc` clean of all PTY errors, webpack 0 errors, lint 0 errors, 5/5 ratchets and 9/9 contract tests green including both feature-management suites.

Three completion claims in the subtask plans are **not supported by the code** and are corrected in their respective Review Findings: `moveSelected`/`moveAll` dispatch was not implemented (that arm is byte-identical to its move-only original); exit-code propagation still hardcodes `code: 0` on the live exit path because the `closed` event carries no code; and "unified vendor asset serving" is a hand-mirrored second copy under `src/`, which is the pattern step 1 explicitly forbade. Also note the round-2 pass deleted the `## Review Findings` section from all four subtask plans — including the authoritative node-pty dependency decision, which has been restored to the backend plan and must not be re-litigated or reverted to a hard `dependencies` entry.
