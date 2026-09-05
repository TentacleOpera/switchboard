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

## Proposed changes

1. Log the surviving handles at the end of shutdown (`getActiveResourcesInfo()`), behind the
   existing log channel, so this failure is never again silent.
2. Close what is found. At minimum: walk `subWatchers` and `.close()` every `FSWatcher`,
   `unwatchFile` every polled path, clear every interval, close the WS server.
3. Add a bounded exit: after the graceful path completes, a short timer (e.g. 3 s) that calls
   `process.exit(0)` if the loop has not drained. `unref()` it so a clean shutdown is unaffected.
4. Make the CLI honest — `switchboard stop` must poll for actual process death and report
   whether it happened, rather than printing "Server stopped" on the strength of the request.

**Both hosts.** The standalone CLI is where `stop` lives, but the extension's `deactivate()`
disposes the same services through the same seams; whatever handle set is found unclosed here
is leaked in the extension host too, where it accumulates across window reloads instead of
across restarts. The fix lands in the shared service disposal, and both composition roots
(`src/extension.ts`, `src/standalone/bootstrap.ts`) are checked by hand for seams the other
does not wire.

## Metadata

**Complexity:** 4
**Tags:** backend, reliability, standalone, memory

## User Review Required

None — the approach is fully specified.

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
