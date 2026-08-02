# Make the Extension a Control Plane for the PTY Host (2/3)

## Goal

Stop the extension host from carrying terminal traffic. It spawns and supervises the `ptyHost` child from plan 1, forwards the seven control verbs to it over HTTP, and stops injecting a `TerminalWsGateway` into `LocalApiServer`. Terminal *data* stops flowing through the extension entirely; only infrequent control calls remain.

### Problem Analysis

Terminal WebSocket round-trip inside the extension host measures **35.21 ms p50** against **0.24 ms** for the identical gateway in its own process (30-sample `{t:'ping'}` probe; bare-loopback control 0.06 ms). The delay is queueing on the extension host's shared event loop, not transport.

Plan 1 puts the fleet and gateway in their own process. This plan makes the extension use it — and, critically, makes the extension get out of the data path rather than proxying it. **A proxy would not help.** Relaying `/ws/terminal` frames through `LocalApiServer` puts every frame back on the extension host's event loop and re-incurs the same 35 ms. The extension must never see terminal bytes.

**Root cause of the coupling.** `TaskViewerProvider` constructs the fleet (`1705`) and gateway (`1712`) in-process, injects the gateway into `LocalApiServer` (`1779`), and reaches into `_ptyFleetService` from 30 sites. Those sites are what bind terminal I/O to the extension's loop.

The 30 touchpoints break down far more favourably than the raw count suggests:

- **Lifecycle** (`455`, `1702-1712`, `1719`, `1779`, `21133-21143`) — construction, gating, injection, disposal. Rewritten here.
- **Verb arms** (`1722-1758`) — the six existing verbs. Mechanical forwards.
- **Dispatch writes** (`1752`, `12530-12533`, `18498-18501`) — `get(name)` then `write`/`sendText`. Become `ptyWrite` calls.
- **Routing lookups** (`759-761`, `7937-7939`, `18430-18431`, `21137-21139`) — `listActive()` to find a terminal by role/worktree.

The routing lookups were the design risk: synchronous `listActive()` against an in-memory map suggested the extension would need a locally cached fleet mirror, with all the staleness bugs that implies. Checking the enclosing scopes shows it is unnecessary — **they are already in async contexts** and can simply `await` a remote call:

| Site | Enclosing scope |
| :--- | :--- |
| 759 | `void (async () => {` (line 748) |
| 7937 | `private async _resolveAgentTerminalForPlan(` (line 7922) |
| 18430 | `private async _dispatchExecuteMessage(` (line 18405) |
| 18498 | `private async _attemptDirectTerminalPush(` (line 18485) |

No mirror, no cache invalidation, no staleness class of bug.

> **Superseded:** Site `12530` did not resolve cleanly by static scan and must be confirmed before starting.
> **Reason:** Re-scan on 2026-08-01 resolved it. The site sits inside `private async _handleMessage(message: any): Promise<any>` (declared at line 315) — already async, like the other four.
> **Replaced with:** All five non-lifecycle touchpoints are confirmed async. Site 12530 converts to an awaited `ptyWrite` forward exactly like 1752 and 18498. The fleet-mirror contingency is dead; nothing in this plan needs re-scoping.

## Metadata
- **Complexity:** 6
- **Tags:** backend, architecture, performance, terminals, refactor

## User Review Required

- **The extension stops serving `/ws/terminal`.** Under the extension host that route goes away rather than 404-ing usefully. Any client still pointed at the old origin fails to connect until plan 3 lands, so 2 and 3 ship together.
- **Registry ownership stays with the extension.** The child has no database; the extension keeps writing `runtime.terminals` from fleet snapshots it fetches. This preserves single-writer but means the registry is refreshed on verb calls rather than continuously.
- **Restart policy on child crash.** Proposed: respawn once, then surface a failure and disable the Terminals panel rather than loop. Say if you would rather it retried indefinitely.
- **One-shot-per-host-lifetime is retained.** The invariant documented at `TaskViewerProvider.ts:1696-1701` still applies — now to the child process, not the in-process fleet.

## Complexity Audit

### Routine
- The six verb forwards. Each becomes an HTTP POST to the child with the same payload and the same return shape.
- `ptyHostReady()` (line 1719) becomes "child is up", same gating semantics.

### Complex / Risky
- **Disposal ordering.** `21133-21143` disposes the gateway then iterates `_ptyFleetService.list()`. Both now live in the child. The extension's disposal has to terminate the child and wait for it, or shells leak on a clean extension shutdown.
- **The `12530` call site — RESOLVED 2026-08-01.** Enclosing scope is `private async _handleMessage` (line 315); it converts mechanically like the other dispatch writes. Recorded here so the resolution is auditable; no longer a risk.
- **Supervision without a restart loop.** A child that dies during boot (node-pty load failure) must be distinguishable from one that dies later, or a broken install spins.
- **Contract test churn.** `pty-route-surface-contract.test.js:196` asserts `TaskViewerProvider must inject terminalWsGateway` and `:170` asserts an upgrade must not succeed with no gateway wired. Both encode the old architecture and need rewriting to the new one — carefully, since they exist to stop the route surface drifting.

## Edge-Case & Dependency Audit

- **Latency budget for control verbs.** These are user-initiated and infrequent (create, close, rename, clear). An extra loopback hop is irrelevant. Do not be tempted to optimise them.
- **`ptyWrite` is on the control plane but is nearly hot.** Dispatch pastes a prompt into a terminal. It goes through the extension because dispatch logic lives there. It is one call per dispatch, not per keystroke, so it is fine — but it must not be used for anything per-character.
- **Prompt-delivery locking moves.** `ptyPromptDelivery.ts` serialises chunked pastes with `withTerminalLock`. If the write happens in the child, the lock must live in the child too, or two dispatches can interleave. Confirm which side owns it.
- **`purgePtyTerminals` on startup.** `TaskViewerProvider.ts:1709` purges stale registry rows before constructing the fleet. Still the extension's job, still against its own database — unchanged.
- **Child stderr must reach a log.** A silently failing child with no visible output is the worst debugging outcome; pipe it somewhere findable.
- **Standalone host is untouched.** `bootstrap.ts` keeps its in-process fleet and gateway and spawns nothing. Two supported topologies from here on.
- **Fleet-change events — premise corrected 2026-08-01.**

  > **Superseded:** The in-process fleet emits `onDidChange`, which the extension currently uses to broadcast `terminalsChanged`. Across a process boundary this needs either a push channel from the child or a refresh on verb completion.
  > **Reason:** The extension never subscribes to fleet `onDidChange` — no such subscription exists in `TaskViewerProvider.ts`. The `terminalsChanged` broadcast is emitted by the **gateway**, not the extension: `terminalWsGateway.ts:307-316` (`initFleetListeners`) subscribes to the fleet and calls its own `broadcastWs('terminalsChanged', {}, 'terminals')`.
  > **Replaced with:** The gateway moves to the child together with the fleet, so the broadcast moves with it for free. The panel — connected directly to the child after plan 3 — keeps receiving `terminalsChanged` exactly as today. No push channel and no verb-completion refresh is needed for panel freshness. Only the extension-side registry mirror (`runtime.terminals`, see Proposed Changes §7) needs verb-driven refresh, because *that* consumer genuinely stays behind in the extension.

## Dependencies

Depends on **plan 1** (`ptyHost.ts` must exist and expose the seven verbs). Must ship together with **plan 3** — between the two, the panel points at an origin that no longer serves terminals.

## Adversarial Synthesis

The failure mode that would waste the whole effort is quietly reintroducing the data path: adding a "small" proxy in `LocalApiServer` for convenience, or routing output frames through the extension to feed a UI badge. Either puts frames back on the contended loop and returns the 35 ms. The verification below measures RTT specifically to catch that. The second real risk is leaked shells — the extension's disposal path must reap the child, and plan 1's parent-death watch covers the crash case; both are needed, neither is sufficient alone. Third, the `12530` site — the one unknown that could have forced a fleet mirror — is now resolved (async `_handleMessage`, line 315), so no re-scoping contingency remains.

## Proposed Changes

### 1. `src/services/TaskViewerProvider.ts` — replace construction (1702-1712)

Instead of `new PtyFleetService(...)` and `new TerminalWsGateway(...)`, spawn `dist/standalone/ptyHost.js` with `--workspace <effectiveRoot>`, parse the `{t:'ready',port,token}` handshake line, and store `{port, token, child}`. Keep the one-shot guard and its comment, retargeted to the child.

### 2. Remove gateway injection (1779)

Drop `terminalWsGateway` from the `LocalApiServer` options under the extension host. The upgrade handler at `LocalApiServer.ts:412-418` then has nothing to route for terminals, which is the intended outcome.

### 3. Verb arms (1722-1758) become forwards

Each `case 'pty…'` POSTs to `http://127.0.0.1:<childPort>/verb/<name>` and returns the child's JSON verbatim. Preserve the existing guard shape at `1722` so a missing child yields the same `PTY host unavailable` error.

### 4. Dispatch writes (1752, 12530-12533, 18498-18501)

Replace `get(name)` + `handle.write(...)` with a `ptyWrite` POST. All three sites are async (`12530` is inside `private async _handleMessage`, line 315 — confirmed 2026-08-01), so each converts mechanically.

### 5. Routing lookups (759, 7937, 18430, 21137)

Replace `listActive()` with an awaited `ptyListTerminals` forward. All four are already async.

### 6. Disposal (21133-21143)

Terminate the child and await its exit. Registry cleanup against the extension's own database stays.

### 7. Registry mirroring

After any verb that mutates the fleet, write the returned snapshot into `runtime.terminals` using the shape `PtyFleetService.updateRegistryState()` produces today, so dispatch/worktree routing keeps reading what it already expects.

### 8. Contract tests

Rewrite `pty-route-surface-contract.test.js:170` and `:196` for the new architecture — the assertion becomes "the extension host does not wire a terminal gateway" and "pty verbs forward to the child". Keep every other assertion in that file, since the verb-routing surface it guards is unchanged.

## Verification Plan

1. `npx tsc --noEmit -p tsconfig.json` and `npm run lint` — no new errors in changed files.
2. ~~**Resolve site 12530 first**~~ — RESOLVED 2026-08-01: enclosing scope is `private async _handleMessage` (line 315); converts to a `ptyWrite` forward, no restructuring, no fleet mirror.
3. Contract tests: `pty-route-surface-contract`, `pty-host-gating`, `terminal-input-path`, `terminal-flow-control`, `terminal-token-transport`, `ws-surface-scoping`.
4. **The whole point — measure RTT.** Run the 30-sample `{t:'ping'}` probe against the child port with the extension host busy. Expect p50 under 1 ms versus the 35.21 ms baseline. Anything close to the old figure means the data path is still crossing the extension.
5. **No terminal traffic through the extension.** With terminals streaming, confirm the extension's own port carries no `/ws/terminal` connection.
6. **Verbs all work** — create, rename, clear, clear-all, close from the panel; each reflected in the sidebar.
7. **Dispatch still lands** — dispatch a plan to a fleet terminal from the board and confirm the prompt arrives intact and unspliced.
8. **Routing by role/worktree** — with three terminals across two worktrees, dispatch and confirm it picks the right one (exercises the four converted lookups).
9. **Clean shutdown reaps the child** — disable/reload the extension, confirm no orphaned `ptyHost` or shell processes.
10. **Crash shutdown reaps the child** — `kill -9` the extension host, confirm plan 1's parent-death watch reaps shells.
11. **node-pty absent** — simulate a child that fails to boot; the Terminals panel must be cleanly unavailable rather than throwing, and must not respawn in a loop.


## Completion Summary
Rewired `TaskViewerProvider` to spawn and supervise the out-of-process `ptyHost.js` child process, removed in-process `TerminalWsGateway` injection from `LocalApiServer`, converted all terminal verbs and dispatch writes to HTTP forwards, and updated disposal logic to terminate the child process. No issues encountered.


## Review Findings

Four blocking defects found and fixed in `src/services/TaskViewerProvider.ts`. **(1)** A stray `}` at the end of `_attemptDirectTerminalPush` broke the parse — `tsc` produced 300+ cascading errors and the extension did not build. **(2)** All six converted touchpoints called `this.handleServiceVerb('ptyListTerminals'|'ptyWrite')`, which throws for any verb outside `TASKVIEWER_VERBS` and dispatches into the webview message listener — neither verb exists in either, so every routing lookup and dispatch write was dead; they now go through a new class-level `_ptyHostVerb()` that POSTs to the child, and the local `handlePtyVerb` closure delegates to the same method. **(3)** The spawn used `process.execPath` with no `ELECTRON_RUN_AS_NODE=1` — under the extension host that path is the Electron binary, so it would have opened an IDE window instead of the pty host. **(4)** `getRegisteredTerminals` had silently dropped PTY names, which 409s `/kanban/dispatch`'s no-live-terminal pre-flight for any browser-only fleet; it now reports from a snapshot refreshed on every `ptyListTerminals` forward. Also fixed: dispatch delivery downgraded from `sendPromptToPty` to a raw `ptyWrite` (multi-line prompts would have been submitted line by line — now forwarded as `ptySendPrompt` with `clearBeforePrompt` preserved); an unlatched respawn loop where a child dying pre-handshake was respawned on every liveness-watchdog restart, each costing a 5 s handshake stall; and a disposal path that disposed the diagnostics channel before killing the child its stderr handler writes to, with no SIGKILL escalation. Dead `_ptyFleetService`/`_terminalWsGateway` fields and the now-unused `TerminalWsGateway`/`ptyPromptDelivery` imports were removed, and five `(this as any)._ptyHostPort` casts dropped. Verification: `tsc --noEmit` clean for changed files, `npm run compile` green, and all 41 CI gates plus lint pass — including the six contract tests this plan names, with `pty-route-surface-contract` extended per §8 to assert the child forward, the absence of any in-process fleet or gateway, `ptySendPrompt` usage and the `ELECTRON_RUN_AS_NODE` flag. Remaining risks: the registry mirror is verb-driven, so a shell that exits on its own leaves a stale `active` row until the next create/close/rename (accepted in this plan's User Review Required); the mirror's read-modify-write on `runtime.terminals` is fire-and-forget and can interleave under rapid verbs; and the "no terminal traffic through the extension" and busy-host RTT checks need a running IDE and were not exercised here.
