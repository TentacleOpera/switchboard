# Sandbox-Surviving Board Liveness via a Unix Domain Socket

## Goal

Give the `/switchboard` launcher a liveness signal that is accurate inside an agent sandbox, so it can tell "the board is running but I cannot reach it over TCP" apart from "the port file is stale and the board is dead" — and launch in the second case without ever hijacking in the first.

**Background.** `switchboard-launcher-sandbox-false-negative-health-check` (shipped) fixed a destructive bug: in a sandboxed agent shell, loopback `curl` returns `000` even when the board is up, so the launcher concluded "dead", ran `npx switchboard`, overwrote `.switchboard/api-server-port.txt` and hijacked the live session. That plan made the launcher fail safe — when a port file exists and `curl` cannot confirm liveness, do not spawn. It traded a destructive failure for a recoverable one and said so.

**The problem this plan solves.** The fail-safe has a false positive the shipped plan explicitly left open as its Outstanding Question 2. When the board genuinely dies without clean shutdown (VS Code force-quit, `SIGKILL`, OOM), the port file survives, and the launcher now refuses to start a board *forever*. Recovery is manual and undiscoverable unless the user reads the warning: delete `.switchboard/api-server-port.txt`, re-run. Both hosts unlink the port file on clean shutdown, so the file's presence is a decent proxy — but a crash is exactly when a user most wants `/switchboard` to just work, and it is exactly when the proxy lies.

**Root cause.** Every liveness signal the launcher can currently reach is either network-scoped or process-table-scoped, and an agent sandbox virtualizes both. The port file is neither, which is why the shipped fix leans on it — but a file's *existence* carries no information about whether the writer is still alive. What is needed is a signal that is (a) a filesystem object, so the sandbox can see it, and (b) backed by a kernel object that dies with the process, so its existence means something.

## Root Cause — why the shipped fail-safe cannot be tightened as-is

| Signal | Sandbox-visible? | Dies with the process? | Verdict |
|---|---|---|---|
| Loopback `curl` to the TCP port | ✗ (netns / Seatbelt) | ✓ | The original bug |
| `lsof`, `pgrep`, `ps` | ✗ (`process-info*`, `CLONE_NEWPID`) | ✓ | Killed by research in the parent plan |
| `api-server-port.txt` presence | ✓ | ✗ | The shipped fail-safe; source of the false positive |
| `api-server.pid` + `kill -0` | ✓ | ✓ | Blocked: signalling needs the host process table, and PIDs recycle. `cli.ts:809` already refuses to signal on a possibly-stale PID |
| **AF_UNIX socket** | **✓** | **✓** | **This plan** |

A Unix domain socket is a filesystem inode whose connectability is owned by the kernel. `connect()` on it succeeds only while a process holds the listening handle. A sandbox that can `stat` and `open` files under `.switchboard/` — which every agent shell can, since that is where it does its work — can connect to it. It is the one signal that satisfies both requirements at once.

> **Superseded:** the parent plan's recommended follow-up — both hosts acquire an exclusive `flock`/`fcntl` lock on `.switchboard/daemon.lock` while the server runs, and the launcher tries a non-blocking acquire to decide whether to launch.
> **Reason:** not implementable in this codebase. **Measured on this machine (Node v26.3.1, darwin):** `fs.flock` is `undefined` and `'O_EXLOCK' in fs.constants` is `false` — Node exposes no advisory-lock primitive on any platform, and not even the BSD-only `O_EXLOCK` flag. Closing the gap needs a native addon (`fs-ext` and friends ship a compiled `.node`), and per project constraint the VSIX bundles no `node_modules` and webpack cannot bundle a native binary. The host side of a `flock` design therefore has no implementation. Delegating the hold to a spawned `python3 -c "import fcntl"` child was also rejected: the child would not die with its parent, so it reintroduces exactly the stale-signal problem the lock was supposed to remove, and it makes `python3` a runtime dependency of the extension.
> **Replaced with:** an AF_UNIX listener at `.switchboard/daemon.sock` serving one endpoint, `GET /health`, from the same payload builder the TCP listener uses. This is strictly better than the lock it replaces: a lock yields one bit ("something holds it"), whereas the socket yields the real health JSON — `pid`, `port`, `roots` — over a transport the sandbox can use. **Measured end-to-end (see `## Resolved Assumptions`):** live board → `curl --unix-socket` returns `200`, exit `0`; `SIGKILL`ed board → stale socket inode survives on disk, `curl` returns `000`, exit `7`. Those two outcomes are the exact discrimination the launcher has never been able to make.

## Metadata
- **Complexity:** 4
- **Tags:** reliability, sandbox, api-server, cli, launcher

## User Review Required

None. Three decisions were made rather than deferred:

1. **The socket serves only `GET /health`, via its own small request handler — not `_handleRequest`.** Routing the socket through `_handleRequest` would require widening the socket-level peer guard at `LocalApiServer.ts:5965`, because `req.socket.remoteAddress` is `undefined` on an AF_UNIX connection (measured) and the guard 403s anything that is not `127.0.0.1`/`::1`. Widening a security guard to admit `undefined` is not worth it for a liveness probe, so the socket gets a dedicated handler and that guard is not touched.
2. **The port file keeps its current meaning and stays the fallback.** No migration: this adds state, changes none. A new launcher against an old host finds no socket and behaves exactly as today; an old launcher against a new host ignores a file it does not know about.
3. **POSIX only.** Node maps `listen(path)` to a named pipe on Windows, not a filesystem socket, so `[ -S "$SOCK" ]` never matches there and Windows falls through to today's port-file path. That is correct degradation, not a gap — the sandbox problem this plan addresses is a macOS/Linux problem.

## Complexity Audit

### Routine
- Factor the `/health` response body out of the `pathname === '/health'` branch (`LocalApiServer.ts:6006-6024`) into a `_healthPayload()` method so both listeners cannot drift.
- Add `.switchboard/daemon.sock` to the extension host's port-file write loop and to `_stopLocalApiServer`'s unlink loop, both already iterating `_filterPortFileEligibleRoots` / `allRoots`.
- Add socket creation next to the existing port-file and PID-file writes in `bootstrap.ts:2698-2707`, and to the post-`SIGKILL` stale-file cleanup in `cli.ts:853-856`.
- No new dependencies. `http` and `net` are already imported.
- No `.gitignore` change: `.switchboard/*` (line 52) already covers it, and the un-ignore list does not name it.

### Complex / Risky
- **Stale-inode takeover is mandatory, not defensive.** `listen()` on a socket path left behind by a `SIGKILL` fails `EADDRINUSE` (measured), and a clean `server.close()` unlinks the path itself (measured). So start-up must be: try `listen` → on `EADDRINUSE`, `connect`-probe → if the probe fails, `unlink` and retry once → if the probe succeeds, another live board owns this root and this one must not steal it. Getting this wrong in the "probe succeeds" direction turns the fix into a new hijack.
- **Launcher line budget.** `test:contract:orchestrator-tick` asserts the launcher is under 140 lines; it is at 133. The socket branch does not fit. Trim the Step 1 prose first; if still over, raise the assertion to 150 in the same commit and keep every console-content assertion intact — the file is gaining a second transport probe, not board narration.
- **Two mirrored launcher copies.** `.agents/workflows/switchboard.md` and `.claude/skills/switchboard/SKILL.md`. Edit the `.agents/` source of truth; `mirror:check` regenerates and enforces the mirror, so drift is machine-caught.
- **Socket inode permissions.** Default mode was 755 (measured) — world-connectable. `chmod 600` after `listen`. `/health` leaks `roots` (absolute paths) and `terminals`, and although it is equally reachable over TCP by any local process today, a socket is free to tighten.

## Edge-Case & Dependency Audit

- **Race conditions.** Two boards starting on one root simultaneously: both `listen`, one wins `EADDRINUSE`, and the loser's `connect`-probe succeeds against the winner, so it stands down instead of unlinking. Board dies between the launcher's probe and its decision: the launcher refuses to launch, the user re-runs, the socket is gone by then, and the port-file path takes over. Board starts between probe and decision: the launcher refuses, which is correct — the new board is the one to use.
- **Concurrent systems.** The extension watchdog (`_checkApiServerLiveness`, 30s) restarts the server when the port file vanishes; extend its existence check to the socket so a deleted socket is repaired rather than leaving a board unreachable by the new channel. The watchdog stays in-process and still does no self-HTTP round-trip. Nothing here touches the plan watcher, autoban polling, or DB write serialization.
- **Security.** One new unauthenticated endpoint on a new transport, already unauthenticated on the existing one. No change to the peer guard, the Host guard, the auth gate, or `serveStatic`. Socket mode 600 narrows rather than widens. Writing to `.switchboard/` is already full compromise of an agent session, so the socket grants no new capability to anyone who can reach it.
- **`curl --unix-socket` availability.** curl ≥ 7.40 (2015); this machine has 8.7.1. Treat only a *definitive* dead answer as dead — curl exit `7` (ECONNREFUSED) or a missing inode. Exit `0` + `200` is alive. **Anything else — including exit `2` for an unrecognized option on an ancient curl — is inconclusive and must fall through to the port-file fail-safe, never to a launch.** An inconclusive answer treated as dead would restore the original hijack.
- **Dependencies & conflicts.** `cli.ts:findRunningInstance` (`:314`) is the standalone's own duplicate-instance guard and it probes health over TCP, so it carries the identical sandbox blindness: inside a sandbox it concludes "nothing running" and starts a second server. It must prefer the socket, or the launcher's new accuracy is undone one layer down by `npx switchboard` itself.

## Dependencies
- None. `switchboard-launcher-sandbox-false-negative-health-check` is already shipped; this plan tightens its fallback and does not require changes to it beyond the launcher edit described here.

## Adversarial Synthesis

Three ways this goes wrong. (1) The stale-inode takeover misreads a *live* peer as stale, unlinks its socket and listens — a fresh hijack, worse than the one that started this, because the victim keeps running with a socket nobody can find; mitigated by making the `connect`-probe authoritative and by never unlinking on a successful probe. (2) The launcher treats an inconclusive curl result as dead and launches, restoring the original bug for anyone on old curl; mitigated by the explicit exit-code allowlist above and pinned by a test. (3) `findRunningInstance` is left on TCP, so the launcher correctly declines to launch and then the user's own `npx switchboard` spawns the second server anyway; mitigated by treating the CLI guard as in-scope, not adjacent. Residual risk after all three: Windows and pre-7.40-curl users keep exactly today's behaviour, including today's false positive.

## Proposed Changes

### 1. `src/services/LocalApiServer.ts` — optional AF_UNIX listener

- Extract `private _healthPayload(): object` from the `pathname === '/health'` branch (`:6006-6024`); the TCP branch calls it and returns its JSON unchanged.
- Add `private _unixServers: http.Server[] = []` and `public async listenOnUnixSocket(sockPath: string): Promise<void>`:
  - `http.createServer` with a handler that answers `GET /health` (and `/health?...`) from `_healthPayload()`, and `404`s everything else. It must not call `_handleRequest`.
  - Start-up sequence: `listen(sockPath)` → on `EADDRINUSE`, `net.connect(sockPath)`; if it connects, throw `EliveBoardOwnsSocket` (caller logs and skips this root); if it errors, `fs.unlink(sockPath)` and retry `listen` **once**.
  - After a successful listen: `fs.chmod(sockPath, 0o600)`.
  - No-op returning immediately when `process.platform === 'win32'`.
- `stop()` (`:756`) closes every entry in `_unixServers` alongside `_server`, then best-effort `unlink`s each path (`close()` unlinks on the clean path; the unlink covers the rest).
- `isListening()` semantics unchanged — it remains the TCP/in-process signal the watchdog reads.

### 2. `src/services/TaskViewerProvider.ts` — extension host

- In `_startLocalApiServer` (`:3958-3968`), inside the existing `_filterPortFileEligibleRoots(allRoots)` loop, call `listenOnUnixSocket(path.join(root, '.switchboard', 'daemon.sock'))` after the port file lands. Failures log to `_apiServerDiagnosticsChannel` and never abort start-up — the socket is an enhancement, and a board that starts without it must still start.
- In `_stopLocalApiServer` (`:4040-4050`), unlink `daemon.sock` in the same loop that unlinks the port file.
- In `_checkApiServerLiveness` (`:4000-4030`), include socket existence in the per-root check that today only looks for the port file, so a deleted socket triggers the same restart-and-rewrite.

### 3. `src/standalone/bootstrap.ts` and `src/standalone/cli.ts` — standalone host

- `bootstrap.ts:2698-2707`: after the port and PID files, `await server.listenOnUnixSocket(path.join(switchboardDir, 'daemon.sock'))`, logging and continuing on failure.
- `cli.ts:findRunningInstance` (`:314`): probe `daemon.sock` first — if `GET /health` over it answers `status === 'ok'`, return its `port` without any TCP attempt; if the socket exists but refuses, treat the instance as dead (that is the whole point) and fall through to unlinking it; if there is no socket, keep today's `probeHealth` TCP path verbatim.
- `cli.ts:853-856`: add `daemon.sock` to the post-`SIGKILL` stale-file cleanup beside the port and PID files.

### 4. `.agents/workflows/switchboard.md` (+ regenerated mirror) — Step 1

Insert a socket probe ahead of the existing tree; the port-file logic below it is unchanged and remains the fallback.

```bash
SOCK="$ROOT/.switchboard/daemon.sock"
BOARD=""                        # alive | dead | ""  (inconclusive)
if [ -S "$SOCK" ]; then
  SH=$(curl -s -o /dev/null -w "%{http_code}" --unix-socket "$SOCK" http://localhost/health 2>/dev/null)
  CE=$?
  if [ "$CE" = "0" ] && [ "$SH" = "200" ]; then BOARD="alive"
  elif [ "$CE" = "7" ]; then BOARD="dead"        # refused: stale inode, board is gone
  fi                                             # any other exit: inconclusive, fall through
fi
```

- `BOARD=alive` → reuse; report the port from `/health`; do not launch.
- `BOARD=dead` → launch. This is the false positive being eliminated: a stale port file no longer blocks a genuinely needed launch.
- `BOARD=""` (no socket, or an inconclusive answer) → today's port-file tree, unchanged.

Trim the Step 1 prose to stay inside the launcher's line budget; see the Complexity Audit.

### Out of scope — recorded so it is not silently absorbed

Routing the **full** API over the socket would let a sandboxed agent actually drive Switchboard (adopt, move cards, dispatch) instead of only detecting it. That is a larger, independently-shippable change touching the peer guard, the auth gate, `serveStatic`, and `.agents/skills/_lib/sb_api_call.sh`, and it belongs in its own plan. This plan deliberately stops at liveness.

## Verification Plan

### Automated
- **New:** `src/test/daemon-socket-liveness-contract.test.js`, wired as `test:contract:daemon-socket` in `package.json` **and** as its own step in `.github/workflows/integration-tests.yml` — a script without a CI step is the "green while incomplete" hole this repo has already been bitten by. It must pin:
  - a live listener answers `200` on `GET /health` over the socket and `404` on any other path, and never reaches `_handleRequest`;
  - `_healthPayload()` is the sole source for both listeners (drift guard);
  - the stale-inode dance: `EADDRINUSE` → failed probe → unlink → listen succeeds; `EADDRINUSE` → successful probe → does **not** unlink and does **not** listen;
  - `chmod 600` on the created inode;
  - `win32` is a no-op;
  - the launcher's exit-code mapping: `0`+`200` → alive, `7` → dead, `2`/anything else → inconclusive (extract the Step 1 block and drive it with a stub `curl`, as the parent plan's review harness did).
- **Must stay green:** `npm run mirror:check`, `npm run test:contract:orchestrator-tick` (line budget + launcher assertions), `npm run test:contract:loopback-hostname`, `npm run test:contract:pty-host-gating`, `npm run compile-tests`, `npm run lint`.

### Manual — the false positive is gone
1. Start the board. Confirm `curl --unix-socket .switchboard/daemon.sock http://localhost/health` returns 200.
2. `kill -9` the host. Confirm both `api-server-port.txt` and `daemon.sock` survive on disk.
3. Run `/switchboard`. **Expected:** socket probe answers refused → `BOARD=dead` → launches a new board. Before this plan: refused to launch and told the user to delete the port file by hand.

### Manual — the hijack is still impossible
1. Start the board. Block loopback TCP (or stub `curl` so any TCP health check returns `000`), leaving the socket reachable.
2. Run `/switchboard`. **Expected:** `BOARD=alive`, no second server, port file untouched.

### Manual — old-host and Windows fallback
1. Delete `daemon.sock` from a running board's `.switchboard/`. Run `/switchboard`. **Expected:** the watchdog recreates it within 30s; a run in the gap falls through to the port-file fail-safe, i.e. today's behaviour.
2. On Windows, confirm `/switchboard` behaves exactly as it does today and that no `daemon.sock` is created.

## Resolved Assumptions

All measured in this session; none assumed.

- **Node has no advisory-lock primitive — the parent plan's `flock` design has no host-side implementation.** `fs.flock` is `undefined` and `'O_EXLOCK' in fs.constants` is `false` on Node v26.3.1 / darwin. This is why the approach is superseded rather than implemented.
- **`curl --unix-socket` reaches a Node AF_UNIX HTTP listener and returns a real status.** Live board → body `{"service":"switchboard","status":"ok",...}`, `http_code=200`, exit `0`.
- **A `SIGKILL`ed board leaves a stale socket inode that probes as dead.** After `kill -9`: the inode is still on disk and still `isSocket()`, and `curl --unix-socket` returns `http_code=000`, exit `7`. This is the discrimination the port file cannot provide.
- **`listen()` on a stale inode fails `EADDRINUSE`; it succeeds after `unlink`.** Hence the takeover sequence is required, not defensive — without it, the launch this plan enables would fail on the very crash it is meant to recover from.
- **A clean `server.close()` unlinks the socket path itself.** So the clean-shutdown path needs no manual cleanup; the explicit unlinks exist for the unclean paths.
- **`req.socket.remoteAddress` is `undefined` on an AF_UNIX connection.** The peer guard at `LocalApiServer.ts:5965` would 403 every socket request — which is why the socket gets its own handler and that guard stays untouched.
- **Socket inodes are created mode 755 by default.** Hence the explicit `chmod 600`.

## Outstanding Questions

None.
