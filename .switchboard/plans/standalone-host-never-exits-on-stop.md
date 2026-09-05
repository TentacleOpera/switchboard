# `switchboard stop` releases the port but the host process never exits

## Goal

Make `switchboard stop` actually terminate the standalone host, so that stopping the board
frees its resident memory and a subsequent start cannot race a still-live predecessor. On a
4 GB device this is the difference between a clean restart and an out-of-memory kill.

### The problem

`switchboard stop` reports success and is believed. Measured twice on 2026-09-05:

```
[switchboard] Stopping server (PID 3985718, port 7777)…
[switchboard] Server stopped.
$ ss -ltnp | grep 7777    → port free
$ ps -p 3985718           → STILL RUNNING, RSS 4,736 MB
```

The listener closes, the pty children are reaped, `[switchboard] Shutting down...` is written
to `server.log` — and then the process sits in `ep_poll` with 12 threads, holding its entire
resident set, indefinitely. It was still alive 30 s later at an unchanged RSS. A subsequent
`SIGTERM` was also ignored; only `SIGKILL` ended it.

This reproduced on **both** engines — the old `sql.js` build and the current `better-sqlite3`
build — so it is not storage-engine specific.

### Why it matters more than an untidy exit

1. **The memory is not returned.** On the old build the hung process had *grown* from 3,446 MB
   to 4,736 MB between the stop request and the stall, so the shutdown path allocates before
   it hangs. On a 4 GB host that alone is fatal.
2. **A stop-then-start silently races.** `switchboard stop` returning success is the signal
   operators and scripts use before starting again. During this incident the restart sequence
   found a leftover host still alive after the reported stop; had it still held the port, the
   new host would have taken a different port or failed, and had it not, two hosts would have
   been writing the same board. This is a data-integrity exposure, not just a leak.
3. **It is invisible.** No error, no log line, no non-zero exit. Nothing in the product ever
   reports that the process it just claimed to stop is still running.

### Root cause — unidentified handles keep the loop alive

`ep_poll` with the listener closed and no children means one or more libuv handles are still
referenced. The candidates present in this host at shutdown, in order of likelihood:

- **The recursive `fs.watch` set.** The process held 17,196 active inotify watch descriptors.
  `vscodeShim.createFileSystemWatcher` passes `{ persistent: false }` (which should not hold
  the loop) but `planIngestionHost`'s `attachRecursive` / `attachNonRecursive`
  (`src/standalone/planIngestionHost.ts:91,116`) do **not**, and nothing in the shutdown path
  visibly walks `subWatchers` to close them.
- **`fs.watchFile` pollers.** `planIngestionHost.ts:221` arms `fs.watchFile(..., {interval:2000})`
  for `.git/HEAD`; its `dispose` calls `fs.unwatchFile`, but only if disposed.
- **Interval timers** (queue watch, pacing, WS heartbeat) never cleared.
- **The WS hub's own server/heartbeat** — 55 live `WebSocket` objects at snapshot time.

The investigation is: enumerate what is still referenced, not guess. `process._getActiveHandles()`
/ `getActiveResourcesInfo()` logged at the end of the shutdown path names them directly.

### Code-path confirmation

The shutdown flow is `signalCleanup` (`src/standalone/bootstrap.ts:4085-4088`):

```ts
const signalCleanup = async () => {
    try { await instance.stop(); } catch { /* ignore */ }
    process.exit(0);
};
```

`instance.stop()` (`bootstrap.ts:4061-4078`) runs a sequential disposal chain: `terminalWsGateway`,
`terminalLogWriter`, `ptyFleetService.disposeAll()`, `ingestionEngine`, providers,
`backupService.shutdown()`, `server.stop()`, file unlinks. The port frees when `server.stop()`
closes the HTTP listener — but `server.close()` only stops *listening*; it waits for all
existing connections (including 55 live WebSockets) to drain before its callback fires. If
those connections never close, `await server.stop()` never resolves, `process.exit(0)` is
never reached, and the process hangs in `ep_poll` with the port already free. This matches
the observed behaviour exactly: port free, process alive, RSS held.

The CLI stop command (`src/standalone/cli.ts:3152-3216`) sends SIGTERM, polls for the port
to be free via `probeHealth`, and prints "Server stopped" when the port is gone — not when
the process is dead. It escalates to SIGKILL only if the port is *still* bound after the
grace period, which never happens because the port frees immediately.

## Proposed changes

1. Log the surviving handles at the end of shutdown (`getActiveResourcesInfo()`), behind the
   existing log channel, so this failure is never again silent.
2. Close what is found. At minimum: walk `subWatchers` and `.close()` every `FSWatcher`,
   `unwatchFile` every polled path, clear every interval, close the WS server
   (`terminalWsGateway.dispose()` is already first in the chain — verify it actually closes
   the underlying `ws.Server`, not just the gateway wrapper).
3. **Close the WS server explicitly before `server.stop()`.** The disposal chain in
   `instance.stop()` calls `terminalWsGateway?.dispose()` first, but `server.stop()` (which
   calls `httpServer.close()`) is what hangs on undrained WebSocket connections. Ensure the
   WS server is closed (`wsServer.close()`) before `server.stop()` so the HTTP server's
   drain completes immediately.

   > **Superseded:** Add a bounded exit: after the graceful path completes, a short timer
   > (e.g. 3 s) that calls `process.exit(0)` if the loop has not drained. `unref()` it so a
   > clean shutdown is unaffected.
   > **Reason:** "After the graceful path completes" is the case where the timer is not
   > needed — `process.exit(0)` is the next line in `signalCleanup`. The timer exists for
   > the case where the graceful path *hangs* (e.g. `await server.stop()` never resolves
   > because WebSocket connections don't drain), and in that case the timer is never armed
   > because control never reaches the line after the hanging `await`.
   > **Replaced with:** Arm the bounded exit timer at the **start** of `signalCleanup`,
   > **before** `await instance.stop()`, racing the graceful disposal. `unref()` it so a
   > clean shutdown (where `instance.stop()` resolves and `process.exit(0)` fires) wins the
   > race and the timer never fires. If `instance.stop()` hangs, the timer fires after 3 s
   > and calls `process.exit(0)`, guaranteeing the process exits regardless of which handle
   > is stuck.

4. Make the CLI honest — `switchboard stop` must poll for actual process death
   (`process.kill(pid, 0)` — liveness check, not port probe) and report whether it happened,
   rather than printing "Server stopped" on the strength of the port being free. The current
   CLI (`cli.ts:3172-3215`) treats "port free" as "process dead," which is false: the port
   frees when the listener closes, before the process exits.

**Both hosts.** The standalone CLI is where `stop` lives, but the extension's `deactivate()`
disposes the same services through the same seams; whatever handle set is found unclosed here
is leaked in the extension host too, where it accumulates across window reloads instead of
across restarts. The fix lands in the shared service disposal, and both composition roots
(`src/extension.ts`, `src/standalone/bootstrap.ts`) are checked by hand for seams the other
does not wire.

## Metadata

**Complexity:** 4
**Tags:** backend, reliability, standalone, memory
**Project:** Browser Switchboard

## User Review Required

None — the approach is fully specified.

## Complexity Audit

### Routine
- Adding `getActiveResourcesInfo()` logging at the end of the shutdown path.
- Walking `subWatchers` to close each `FSWatcher` in the disposal chain.
- Clearing interval timers and `unwatchFile` for polled paths.
- CLI liveness poll (`process.kill(pid, 0)`) replacing the port-free check.

### Complex / Risky
- The bounded exit timer placement: must be armed before `await instance.stop()`, not after.
  Getting this wrong reproduces the original hang — the timer never fires because the `await`
  never resolves.
- Ensuring `terminalWsGateway.dispose()` actually closes the underlying `ws.Server` and
  terminates connections, not just the gateway wrapper. If the WS connections survive the
  gateway dispose, `server.stop()` still hangs.
- Extension host `deactivate()` parity: the same handles leak across window reloads, and the
  timer pattern must not interfere with VS Code's own extension-host lifecycle.

## Edge-Case & Dependency Audit

- **Race Conditions:** A `switchboard stop` followed immediately by `switchboard local` (start)
  is the data-integrity exposure. The CLI honesty fix (poll for process death) closes this:
  the start command must not proceed until the old process is confirmed dead, not just until
  the port is free.
- **Security:** No security surface — this is a lifecycle fix.
- **Side Effects:** `process.exit(0)` from the bounded timer may abandon a pending `kanban.db`
  write if the 3 s budget is too short. The existing `SIGTERM_GRACE_MS = 3000` in
  `ptyFleetService.ts` is the precedent — the timer should be at least as long as the longest
  disposal step (pty fleet grace + DB persist debounce of 300 ms).
- **Dependencies & Conflicts:** The watcher subtasks (Antigravity preset, `.switchboard` dir)
  reduce the inotify descriptor count, which reduces the number of handles to close at
  shutdown. This plan's disposal fix works regardless of how many watchers are armed, but
  the watcher fixes make the disposal cheaper and more reliable.

## Dependencies

- No hard dependencies on other subtasks. The shutdown fix is independent of the watcher and
  memory-budget subtasks. However, the watcher subtasks reduce the handle count at shutdown,
  making the bounded exit timer less likely to fire.

## Adversarial Synthesis

Key risks: (1) the bounded exit timer armed after the hanging `await` never fires — must be
armed before; (2) `server.stop()` hangs on undrained WebSocket connections — must close the
WS server first; (3) the CLI declares "Server stopped" when the port is free, not when the
process is dead — must poll `process.kill(pid, 0)`. Mitigations: race the timer against
disposal, close WS before HTTP, replace port probe with liveness probe.

## Verification Plan

1. Start the standalone host, then `switchboard stop`. Assert the process is gone within 5 s:
   `pgrep -f "dist/standalone/cli.js"` returns nothing, exit code 1.
2. Assert `switchboard stop` exits non-zero and says so if the process is still alive after
   its poll window.
3. Run the same check with the plan watcher armed over a directory tree of >3,000 files, which
   is the state that produced the hang.
4. Extension host: reload the window twice and confirm the inotify descriptor count for the
   extension-host process returns to its pre-reload value rather than doubling.
5. Confirm the shutdown log names zero surviving handles on a clean stop.
6. Assert the bounded exit timer does NOT fire on a clean stop (the `unref()`'d timer is
   cancelled by `process.exit(0)` winning the race) — verify by checking the log does not
   contain the timer-fired message on a normal shutdown.

### Goal Invariants

- Assert `process.kill(pid, 0)` throws `ESRCH` (process not found) within 5 s of
  `switchboard stop` completing — the process is dead, not just the port.
- Assert `switchboard stop` exits non-zero when the process is still alive after the poll
  window — the CLI reports the truth, not a port-free proxy.
- Assert the shutdown log contains `getActiveResourcesInfo()` output — surviving handles are
  named, never silent.
- Assert the bounded exit timer is armed BEFORE `await instance.stop()` in `signalCleanup`
  (`src/standalone/bootstrap.ts:4085`) — the timer races disposal, it does not follow it.

## Recommendation

Complexity 4 → **Send to Coder**.

## Implementation Summary

Implemented fix for standalone host hang on stop. Added `{ persistent: false }` to `fs.watch` calls in `src/standalone/planIngestionHost.ts` and ensured explicit close and client termination of `wss` in `src/standalone/terminalWsGateway.ts` and `src/services/wsHub.ts`. Armed bounded 5s exit timer before `await instance.stop()` in `src/standalone/bootstrap.ts` with `getActiveResourcesInfo()` surviving handle logging. Updated `switchboard stop` in `src/standalone/cli.ts` to poll for process termination using `process.kill(pid, 0)` instead of port-free status and exit non-zero if the process remains alive.

