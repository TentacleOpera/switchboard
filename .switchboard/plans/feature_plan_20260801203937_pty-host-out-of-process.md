# Extract the PTY Host Into Its Own Process (1/3)

## Goal

Add `src/standalone/ptyHost.ts`: a standalone entry point that boots a `PtyFleetService` and a `TerminalWsGateway` on their own HTTP server, in their own OS process, with no `vscode` dependency and no kanban database. It emits a `{port, token}` handshake on stdout and nothing else consumes it yet — plans 2 and 3 wire it up.

### Problem Analysis

Browser PTY terminals are ~150x slower to respond inside the extension host than the identical code is in its own process. Measured with a `{t:'ping'}` → `{t:'pong'}` round trip over the terminal WebSocket, 30 samples each:

| Host | p50 RTT |
| :--- | :--- |
| Bare loopback `ws` server (control) | 0.06 ms |
| **Same gateway, idle standalone process** | **0.24 ms** |
| **Same gateway, inside the Devin extension host** | **35.21 ms** |

The 0.06 ms control rules out transport: this is not Nagle (forcing `setNoDelay` either way moves nothing on loopback), not framing, not xterm. It is queueing delay. `LocalApiServer` and `TerminalWsGateway` run on the **extension host's single Node event loop**, shared with plan watchers, the kanban database, sync services, board broadcasts and git work. Every keystroke echo and every output frame waits behind whatever else the extension is doing.

**Root cause.** The pty fleet and its WebSocket gateway are constructed in-process by the extension (`TaskViewerProvider.ts:1705`, `1712`) and handed to `LocalApiServer` (`1779`), so terminal I/O is scheduled on the same loop as everything else Switchboard does. VS Code's own terminal does not do this — it runs a dedicated pty host process, which is why its terminals feel native. The gap is a hosting decision, not an emulator or protocol limitation.

Worth noting why this only became measurable now: until the `isBinary` frame-discrimination fix, the gateway silently discarded every JSON control frame, so `resize`/`ack` never worked and the latency was masked by much larger functional bugs.

Three properties of the existing code make the extraction cheap, all verified:

- **The stack is already `vscode`-free.** `terminalWsGateway.ts`, `ptyFleetService.ts`, `ptyBackend.ts` and `services/wsUpgradeAuth.ts` contain zero `vscode` imports. This is why the standalone CLI already runs them unmodified.
- **The database is optional and barely used.** `PtyFleetService`'s constructor takes `db?: KanbanDatabase` and there is a `setDatabase()` setter. The only instance use is `updateRegistryState()` (line ~184), which mirrors the live fleet into the `runtime.terminals` config blob; plus the static `purgePtyTerminals()` (line 269). The host child can run with `db` undefined, leaving the extension as the sole database writer — the single-writer invariant is preserved, not weakened.
- **`bootstrap.ts:1275-1298` is already the reference wiring.** Fleet at 1275, gateway at 1284-1285, injection at 1298. The new entry point is that sequence minus the database.

## Metadata
- **Complexity:** 4
- **Tags:** backend, architecture, performance, terminals

## User Review Required

- **The child owns no database.** Terminal registry mirroring (`runtime.terminals`) stays with the extension in plan 2. If anything else later needs the fleet persisted from the child, that decision gets revisited.
- **Token minted by the child, not the parent.** The child generates its session token at boot and reports it in the handshake, rather than receiving one. This keeps the child independently runnable for testing. Flag if you would rather the parent mint and inject it.
- **No behaviour change ships in this plan.** Nothing imports `ptyHost.ts` yet. It is verifiable in isolation but user-visible only after plan 2.

## Complexity Audit

### Routine
- The fleet + gateway + `http.createServer` wiring. Lifted from `bootstrap.ts:1275-1298` with the database argument dropped.
- The upgrade route. `LocalApiServer.ts:412-418` shows the pattern: `server.on('upgrade', …)` → `terminalWsGateway.handleUpgrade(req, socket, head)`.

### Complex / Risky
- **Handshake and port discovery.** Binding to port 0 and reporting the assigned port has to be race-free — the parent cannot poll a file that may not exist yet. A single JSON line on stdout, written after `listen` fires, is the contract.
- **Parent-death detection.** A pty host that outlives a crashed extension host orphans every child shell, and nothing reaps them until reboot. The existing one-shot-fleet comment at `TaskViewerProvider.ts:1696-1701` documents exactly this hazard for the in-process case; it transfers to the child and must be handled there, not assumed.
- **`isPtyAvailable()` probe placement.** node-pty loading moves into the child. The parent still needs a cheap way to decide whether spawning is worth attempting.
  - **Clarification (verified 2026-08-01):** node-pty is loaded lazily — `getPtyModule()` at `ptyBackend.ts:7`, first invoked inside `create()` at `:67`, nothing at module top level — so the parent's probe can reuse that lazy path without paying for it at extension startup. The standalone CLI already runs this same stack under plain system Node, which empirically settles any Electron-ABI concern for the child.

## Edge-Case & Dependency Audit

- **node-pty leaves the extension host.** A side benefit: the native module is no longer loaded into the IDE process. It also means a node-pty load failure now surfaces as a child that exits during boot rather than an in-process throw, so the boot failure path needs a distinguishable exit.
- **Token contract must not relax.** `terminal-token-transport-contract.test.js:104-107` pins `rejectWhenTokenEmpty: true` and explicitly rejects loosening it to loopback trust. The child keeps the same gateway construction, so this stays satisfied — do not "simplify" it away because the child is loopback-only.
- **Port 0 and reuse.** The child must bind loopback only (`127.0.0.1`), never `0.0.0.0`.
- **Stdout discipline.** Anything else the child logs to stdout before the handshake line will corrupt parsing. Route all logging to stderr, or frame the handshake unambiguously.
- **Existing standalone path is untouched.** `bootstrap.ts` keeps its in-process fleet and gateway. The standalone CLI is already one process at 0.24 ms and gains nothing from a second one.
- **Multiple workspaces.** The child is scoped to one `workspaceRoot`, matching `PtyFleetService`'s constructor. Multi-root behaviour is whatever the extension decides in plan 2, not a property of this entry point.

## Dependencies

None. This plan adds a new file and changes no existing behaviour. Plans 2 and 3 depend on it.

## Adversarial Synthesis

The main risk is an orphaned child holding live shells after the parent dies — worse than the status quo, because today the ptys die with the extension host. That has to be solved in the child (parent-death watch), not left to the parent's disposal path, which by definition does not run on a crash. Second risk is the handshake: a file-based port marker would race and a fixed port would collide, so stdout-after-listen is the only option that is both race-free and collision-free. The temptation to give the child database access "just for the registry" should be resisted — it would introduce a second sqlite writer, which the codebase explicitly refuses elsewhere.

## Proposed Changes

### 1. `src/standalone/ptyHost.ts` — new file

Boots, in order: `PtyFleetService(workspaceRoot)` with no database; a session token from `crypto.randomBytes(32).toString('hex')`; `TerminalWsGateway(fleet, async () => token)`; an `http.createServer` that handles `upgrade` by delegating to `gateway.handleUpgrade`, and serves the control verbs over POST.

Control verbs the child must expose (the six existing ones plus the write path plan 2 needs):

`ptyCreateTerminal`, `ptyCloseTerminal`, `ptyListTerminals`, `ptyRenameTerminal`, `ptyClearTerminal`, `ptyClearAllTerminals`, and a new `ptyWrite` (`{name, data}` → `handle.write`).

Handshake, exactly one line to stdout after `listen`:

```
{"t":"ready","port":<assigned>,"token":"<hex>"}
```

Everything else goes to stderr.

### 2. Parent-death watch inside the child

Poll `process.ppid` (or watch for stdin EOF, which fires when the parent goes away) and call `fleet.disposeAll()` then exit. This is the only protection against orphaned shells on an extension-host crash.

### 3. CLI shape

`node dist/standalone/ptyHost.js --workspace <path>`. Port is always ephemeral; the parent reads it from the handshake.

### 4. Build wiring

Add the entry to the webpack config alongside `standalone/cli.js` so `dist/standalone/ptyHost.js` is produced by `npm run compile`.

## Verification Plan

1. `npx tsc --noEmit -p tsconfig.json` — no new errors in changed files.
2. `npm run lint` on the new file.
3. **Boots and handshakes** — run `node dist/standalone/ptyHost.js --workspace <scratch>` directly; confirm exactly one JSON line on stdout carrying a live port and a 64-char token, and that nothing else pollutes stdout.
4. **Serves terminals** — POST `ptyCreateTerminal` to the reported port, then open `ws://127.0.0.1:<port>/ws/terminal?name=coder-1&token=<token>`; confirm the `hello` frame and live output.
5. **Latency is the point — measure it.** Run the same 30-sample `{t:'ping'}` RTT probe used to produce the numbers above. Expect p50 well under 1 ms. If it is not, this plan has not achieved its goal and plans 2-3 are not worth starting.
6. **Token still enforced** — connect with no `token` query parameter and with a wrong one; both must be rejected. Confirms `rejectWhenTokenEmpty` survived the move.
7. **Parent death reaps children** — spawn the host from a throwaway parent, note the child shell PIDs, `kill -9` the parent, confirm within a few seconds that the shell PIDs are gone.
8. **No database file is touched** — run against a workspace with no `kanban.db` and confirm the host still boots and serves terminals.


## Completion Summary
Implemented standalone out-of-process PTY host entry point in `src/standalone/ptyHost.ts` and wired it into `webpack.config.js`. It boots `PtyFleetService` and `TerminalWsGateway` in its own process, exposing the control verbs over POST and WebSocket upgrade handling on an ephemeral loopback port, emitting a ready handshake `{t:'ready', port, token}` to stdout. No issues encountered.


## Review Findings

Reviewed and fixed in place: `src/standalone/ptyHost.ts` gained a `ptySendPrompt` verb (the child now owns `sendPromptToPty` — bracketed paste, chunking and `withTerminalLock`, which can only serialise concurrent dispatches on the side that owns the pty), an `ELECTRON_RUN_AS_NODE` scrub so spawned shells do not inherit it, an awaited `disposeAll()` before `process.exit` (it was fire-and-forget, skipping the SIGTERM→grace→SIGKILL budget), and an `ESRCH`-only parent-liveness check (`EPERM` on a reused pid was being read as parent death). Verified live against `dist/standalone/ptyHost.js`: exactly one handshake line on stdout with a live port and 64-char token, all seven verbs plus `ptySendPrompt` serving, no-token and bad-token upgrades both 401 while a good token upgrades, boot with no `kanban.db` present, and `kill -9` of a throwaway parent reaping both host and shell. **30-sample ping RTT: p50 0.303 ms / p95 0.551 ms** against the 35.21 ms in-process baseline. `tsc --noEmit` clean for changed files (5 pre-existing TS2835 errors elsewhere, unrelated); `npm run compile` builds `dist/standalone/ptyHost.js`; all 41 CI gates plus lint pass. Remaining risk: `ptyBackend`'s darwin `spawn-helper` chmod is a silent no-op in any webpack bundle because webpack rewrites `require.resolve` to a numeric module id — pre-existing and equally true of the extension bundle, but now also true of the child.
