# `switchboard stop` Tears the Host Down and Leaves the Process Running

## Goal

`switchboard stop` should not return until the host process is actually gone. Today the `/shutdown`
route runs teardown and then lets the process sit there holding open handles, while the CLI prints
`Server stopped` off an HTTP status code. Every operator ends up finishing the job with `pkill -9`.

### Problem analysis

There are **two teardown paths and only one of them exits.**

**The signal path exits.** `SIGINT`/`SIGTERM` land on `signalCleanup` (`src/standalone/bootstrap.ts:5015`):

```js
const forceExitTimer = setTimeout(() => {
    log(opts, `Shutdown timed out after ${BOUNDED_EXIT_MS}ms — forcing exit.`);
    // ...logs getActiveResourcesInfo() — the surviving handles
    process.exit(0);
}, BOUNDED_EXIT_MS);        // 5000ms
forceExitTimer.unref();
await instance.stop();
clearTimeout(forceExitTimer);
process.exit(0);
```

**The `/shutdown` route does not.** `src/services/LocalApiServer.ts:11945`:

```js
void (async () => {
    try { await new Promise(r => setTimeout(r, 50)); } catch { /* ignore */ }
    try { await this._options.shutdown!(); }
    catch (e) { console.error('[LocalApiServer] shutdown callback threw:', e); }
})();
```

The callback (`bootstrap.ts:4834`) calls `instanceStopRef()` → `instance.stop()` and returns. No
`process.exit()`. No bounded force-exit. Node keeps running while any handle is open, so whatever
`instance.stop()` does not fully release — a timer, a socket, an fs watcher, the pty-host child —
keeps the process alive indefinitely.

**The force-exit timer on the signal path is the proof this is known.** It exists precisely because
handles survive `instance.stop()`; it even logs `getActiveResourcesInfo()` so the survivors can be
identified. That defence was written once and wired into one of the two paths.

#### The CLI turns a silent failure into a false success

`src/standalone/cli.ts:3811`:

```js
if (res.status === 200) {
    await new Promise(r => setTimeout(r, 500));
    console.log('[switchboard] Server stopped (source: /shutdown route, host kind standalone).');
    process.exit(0);
}
```

`Server stopped` is printed from the **HTTP status and a fixed 500ms sleep**. Nothing checks that the
process died or the port freed. The message is identical whether teardown completed or the process is
still sitting there — a report of a request being *accepted* dressed as a report of an outcome that
*happened*. This is the fallback rule applied to a status message: a wrong value that reads exactly
like a right one.

Observed 2026-09-09 on the tower: `stop` logged `Server stopped (source: /shutdown route, host kind
standalone)`, and `pgrep` immediately afterwards still showed the node host and both
`switchboard-pty-host` children alive. They went away on `kill -9`.

#### Scope: standalone only

The extension composition root declares `capabilities.shutdown.enabled: false` and wires **no**
`shutdown` callback, and the route refuses on `host.kind !== 'standalone'`. So the defect is reachable
only from the standalone host — but that is the host the Pi and every npx user runs, and it is the
only host with a `stop` verb at all. No extension-side change is required, and the fix must not add
one.

## Metadata

**Complexity:** 3
**Tags:** standalone, lifecycle, cli
**Dependencies:** none

## User Review Required

None.

## Proposed Changes

### 1. The `/shutdown` teardown exits, with the same backstop the signal path has (`src/services/LocalApiServer.ts:11945`)

- **Logic:** After awaiting the shutdown callback, exit. Arm a bounded force-exit timer first, on the
  same terms as `signalCleanup` — including the `getActiveResourcesInfo()` log, so a hang names the
  handles that caused it instead of being invisible.
- **Implementation:** Both paths should run **one** teardown-and-exit routine rather than two
  hand-kept-in-sync copies. The bug is the copy, not the code in it.
- **Edge cases:** The 200 must still flush before the listener closes — that ordering is deliberate and
  commented, and the fix must not move the exit ahead of it. A callback that throws still exits: the
  process is already committed.

### 2. `switchboard stop` reports the outcome, not the acknowledgement (`src/standalone/cli.ts:3811`)

- **Logic:** Replace the fixed 500ms sleep with a poll — the pid from the discovery file is gone, or
  the port is closed — up to a bounded deadline. Print `Server stopped` only when that is true.
- **Edge cases:** On timeout, say so plainly and non-zero: name the pid still alive and the port still
  bound, and say what to run. Never print `Server stopped` for a host that is still up.
- **Rationale:** A stop command whose success message does not depend on the process being stopped is
  the reason nobody trusts this verb.

### 3. Identify what actually survives `instance.stop()`

- **Logic:** With the force-exit log in place on both paths, run a stop and read the surviving-handle
  list. If it is a fixed set — the pty-host child, a retention timer, the plan watcher — release those
  in `instance.stop()` so the force-exit path stops being the one that does the work.
- **Rationale:** Requirements 1 and 2 make the verb honest and bounded. This is the one that makes it
  clean, and it cannot be specified before the log exists.

## Verification Plan

### Automated Tests
- `POST /shutdown` against a real standalone host: the process exits, and exits within the bounded
  deadline.
- A host with a deliberately leaked handle still exits, via the force-exit path, and logs the survivors.
- `switchboard stop` against a host that will not die prints a failure and exits non-zero — it never
  prints `Server stopped`.
- `switchboard stop` on a healthy host prints `Server stopped` only after the pid is gone.
- The extension host still refuses `/shutdown` with `enabled: false` and no callback wired.

### Goal Invariants
- Both teardown paths exit; neither can be changed without the other, because there is only one.
- No success message is printed from an HTTP status alone.
- The port is free and the pid is gone when `stop` returns 0.

### Manual
- Start the board, run `switchboard stop`, and confirm `pgrep -f cli.js` is empty **without** a
  follow-up `kill -9` — including the `switchboard-pty-host` children.

## Outstanding Questions

- None.
