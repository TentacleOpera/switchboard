# `switchboard stop` Tears the Host Down and Leaves the Process Running

## Goal

`switchboard stop` should not return until the host process is actually gone. Today the `/shutdown`
route runs teardown and then lets the process sit there holding open handles, while the CLI prints
`Server stopped` off an HTTP status code. Every operator ends up finishing the job with `pkill -9`.

### Problem analysis

There are **two teardown paths and only one of them exits.**

**The signal path exits.** `SIGINT`/`SIGTERM` land on `signalCleanup` (`src/standalone/bootstrap.ts:5012`):

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

**The `/shutdown` route does not.** `src/services/LocalApiServer.ts:11958`:

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

**Complexity:** 4
**Tags:** cli, reliability, bugfix, backend
**Dependencies:** none

## User Review Required

None.

## Complexity Audit

### Routine
- Extracting the existing `signalCleanup` body (`bootstrap.ts:5012-5044`) into a shared `teardownAndExit(opts, instance, reason)` routine and calling it from both the signal handler and the `/shutdown` callback. The logic already exists and is proven on the signal path; this is a move, not an invention.
- Replacing the fixed 500ms sleep in the CLI `/shutdown` branch (`cli.ts:3816`) with a bounded liveness poll that reuses the `isProcessAlive(pid)` helper already present in the legacy fallback (`cli.ts:3872`). The helper exists; the `/shutdown` branch just doesn't use it.
- Re-arming the bounded force-exit timer inside the shared routine so the `/shutdown` path inherits the same 5000ms backstop + `getActiveResourcesInfo()` survivor log the signal path already has.

### Complex / Risky
- **Response-then-exit ordering across the route boundary.** The `/shutdown` route returns 200 *before* teardown (`LocalApiServer.ts:11947`) and waits 50ms for the kernel to drain the response (`LocalApiServer.ts:11959`) before invoking the shutdown callback. The unified `teardownAndExit` runs *inside* that callback, so `process.exit(0)` fires after the flush — but the bounded force-exit timer is armed at the *start* of the routine, racing the flush. If the timer fires during the 50ms flush window it would close the listener mid-response. The timer must be armed *after* the 50ms flush completes (i.e. inside the callback, after the `await new Promise(r => setTimeout(r, 50))`), not at the moment the 200 is written. This is the one ordering constraint the unification must not violate.
- **`instance.stop()` is not idempotent and is shared with non-exiting callers.** `instance.stop()` (`bootstrap.ts:4986`) is a sequential disposal chain that swallows every error. The unified routine must call it exactly once per teardown; the re-entrancy guard `_shutdownInProgress` (`LocalApiServer.ts:11946`) already prevents a second `/shutdown`, but a `SIGTERM` arriving during the `/shutdown` teardown would run `signalCleanup` → `teardownAndExit` → `instance.stop()` a second time. The shared routine needs its own one-shot latch (or the signal handler must be removed once `/shutdown` teardown begins) to prevent the double-close.
- **Investigative handle release (Proposed Change #3) cannot be specified upfront.** The surviving-handle set is unknown until the unified routine logs `getActiveResourcesInfo()` on a real stop. The plan commits to the *investigation*, not to a specific handle list.

## Edge-Case & Dependency Audit

- **Race Conditions**
  - `SIGTERM`/`SIGINT` during `/shutdown` teardown → double `instance.stop()`. Mitigation: a module-level `teardownStarted` latch in `bootstrap.ts`; the second caller sees teardown already in progress and either no-ops or just waits for the exit. The signal handler should be detached (`process.removeListener`) once `/shutdown` teardown begins, or the shared routine checks the latch before re-entering `instance.stop()`.
  - A second `POST /shutdown` during teardown → already guarded by `_shutdownInProgress` returning 409 (`LocalApiServer.ts:11900`). No change needed.
- **Security**
  - The `/shutdown` route keeps its existing loopback peer check, Host guard, capability gate, and auth (`LocalApiServer.ts:11911-11937`). The fix adds an exit *inside* the already-authenticated callback; it does not widen the route's reach. No new security surface.
- **Side Effects**
  - `process.exit(0)` inside the `/shutdown` callback terminates the host the moment teardown completes (or the bounded timer fires). This is the intended new behaviour — the whole point — but it means any in-flight request on a *different* route that arrives in the 50ms flush window is dropped. Acceptable: the operator asked to stop the server; in-flight work is not preserved by a stop verb.
  - The discovery files (`api-server-port.txt`, `api-server.pid`) are unlinked inside `instance.stop()` (`bootstrap.ts:4997-4998`) *before* `process.exit(0)`. The CLI's liveness poll must therefore key off the **process pid** (from the `/health` response captured at `cli.ts:3772`), not the pid *file*, because the file vanishes before the process does.
- **Dependencies & Conflicts**
  - Sibling plan `standalone-host-never-exits-on-stop.md` diagnosed the same hang from the signal path and established the "arm the bounded timer at the start, before `instance.stop()`" pattern (its own `Superseded` callout corrected an earlier "arm after" mistake). That pattern is now the signal path's `signalCleanup` and is what this plan extends to the `/shutdown` path. The two plans converge on one routine; this plan is the convergence.
  - Sibling plan `windows-graceful-stop-http-verb.md` introduced the `/shutdown` route and the `shutdown` callback seam (`bootstrap.ts:4834`) that this plan fixes. Its `disposeAll()` Windows fix is orthogonal and unaffected — the unified routine calls the same `instance.stop()` either way.
  - No persisted-state migration. The route is additive in behaviour (it now exits), not in shape.

## Dependencies

- `standalone-host-never-exits-on-stop.md` — established the bounded-exit-timer-at-start pattern this plan unifies into the `/shutdown` path. Soft dependency: the pattern is already merged into `signalCleanup`; this plan extends it.
- `windows-graceful-stop-http-verb.md` — introduced the `/shutdown` route and the `shutdown` callback whose missing exit is the defect. Soft dependency: the route and callback seam already exist; this plan completes them.

## Adversarial Synthesis

Key risks: (1) the bounded force-exit timer firing during the 50ms response-flush window and closing the listener mid-response; (2) a signal arriving during `/shutdown` teardown double-calling `instance.stop()`; (3) the CLI polling the pid *file* or *port* instead of process *liveness*, re-creating the exact "appears stopped, still running" failure this plan exists to kill. Mitigations: arm the timer inside the callback after the flush, latch the shared routine against re-entry, and poll `process.kill(pid, 0)` reusing the legacy `isProcessAlive` helper.

## Proposed Changes

### 1. The `/shutdown` teardown exits, via one shared routine (`src/standalone/bootstrap.ts:4834` and `:5012`)

- **Logic:** Extract the body of `signalCleanup` (`bootstrap.ts:5012-5044`) into a shared `teardownAndExit(opts, instance, reason)` routine: arm a bounded force-exit timer (5000ms, `.unref()`), `await instance.stop()`, log `getActiveResourcesInfo()` survivors, `clearTimeout`, `process.exit(0)`. Both `signalCleanup` and the `/shutdown` callback call it. The bug is the copy, not the code in it — one routine means the bounded exit cannot again be wired into only one of the two paths.
- **Implementation:**
  - `signalCleanup` becomes `() => teardownAndExit(opts, instance, 'signal')`.
  - The `shutdown` callback (`bootstrap.ts:4834`) becomes: `await new Promise(r => setTimeout(r, 50)); await teardownAndExit(opts, instance, '/shutdown')` — the 50ms flush stays *outside* the shared routine so the timer is armed only after the response has drained. (See Edge-Case audit: arming the timer before the flush would race the response.)
  - Add a module-level `teardownStarted` latch in `bootstrap.ts`. `teardownAndExit` checks it on entry: if already set, return immediately (the first caller owns the exit). This prevents a `SIGTERM` during `/shutdown` teardown from double-calling `instance.stop()`.
- **Edge cases:** The 200 must still flush before the listener closes — that ordering is preserved by keeping the 50ms `setTimeout` *before* `teardownAndExit` is invoked, not inside it. A callback that throws still exits: `teardownAndExit` wraps `instance.stop()` in try/catch (as `signalCleanup` already does) and proceeds to `process.exit(0)` regardless — the process is already committed.

### 2. `switchboard stop` reports the outcome, not the acknowledgement (`src/standalone/cli.ts:3811`)

- **Logic:** Replace the fixed 500ms sleep with a bounded liveness poll using the **process pid** captured from the `/health` response (`cli.ts:3772`, `health.pid`), reusing the `isProcessAlive(pid)` helper already defined in the legacy fallback (`cli.ts:3872`). Print `Server stopped` only when `isProcessAlive(pid)` returns false (or the pid's starttime changed, indicating recycle — reuse `processStartTime` from `cli.ts:3851`). Up to a bounded deadline (5000ms, matching the host's force-exit window).

  > **Superseded:** Replace the fixed 500ms sleep with a poll — the pid from the discovery file is gone, or the port is closed — up to a bounded deadline.
  > **Reason:** Polling the pid *file* or the *port* recreates the exact failure this plan exists to fix. The pid file is unlinked inside `instance.stop()` (`bootstrap.ts:4997`) *before* `process.exit(0)`, and the port closes when `server.stop()` runs — both happen while the process may still be alive in the bounded force-exit window. A CLI that treats "file gone / port free" as "process dead" would print `Server stopped` for a host that is still running, which is the bug verbatim. The honest signal is process liveness via `process.kill(pid, 0)`, which the legacy fallback already uses correctly.
  > **Replaced with:** Poll `isProcessAlive(health.pid)` (reused from `cli.ts:3872`) up to a 5000ms deadline. On success print `Server stopped` and exit 0. On timeout print the pid still alive, the port still bound, and the exact `kill -9 <pid>` to run; exit non-zero. Never print `Server stopped` for a host that is still up.

- **Edge cases:** On timeout, say so plainly and non-zero: name the pid still alive and the port still bound, and say what to run. Never print `Server stopped` for a host that is still up. If `health.pid` is absent (should not happen for a standalone host with `shutdown.enabled`, but defensively), fall back to a port-closed probe and note the weaker signal in the output.
- **Rationale:** A stop command whose success message does not depend on the process being stopped is the reason nobody trusts this verb.

### 3. Identify what actually survives `instance.stop()`

- **Logic:** With the force-exit log in place on both paths (now unified), run a stop and read the surviving-handle list from the `getActiveResourcesInfo()` log line. If it is a fixed set — the pty-host child, a retention timer, the plan watcher's inotify descriptors, an uncleared interval — release those in `instance.stop()` so the force-exit path stops being the one that does the work.
- **Rationale:** Requirements 1 and 2 make the verb honest and bounded. This is the one that makes it clean, and it cannot be specified before the log exists. This is a code-investigation step (read `instance.stop()` at `bootstrap.ts:4986-4999`, the disposal chain, and the candidate handles named in `standalone-host-never-exits-on-stop.md`'s root-cause analysis), not external research.

## Verification Plan

### Automated Tests
- `POST /shutdown` against a real standalone host: the process exits, and exits within the bounded deadline. Assert via a spawned child process that exits with code 0 within ~6s.
- A host with a deliberately leaked handle (e.g. an `unref`'d-but-not-cleared interval) still exits via the force-exit path, and the survivor log names the handle. Assert the log line contains the handle type.
- `switchboard stop` against a host that will not die (mock `isProcessAlive` to return true past the deadline) prints a failure naming the pid and port, and exits non-zero — it never prints `Server stopped`.
- `switchboard stop` on a healthy host prints `Server stopped` only after `isProcessAlive(health.pid)` returns false, not after a fixed sleep. Assert the success message does not appear while the pid is still alive (use a fake timer + a controllable liveness stub).
- The extension host still refuses `/shutdown` with `enabled: false` and no callback wired — assert 403 with the existing reason body, unchanged.
- A `SIGTERM` arriving during `/shutdown` teardown does not double-call `instance.stop()` — assert the `teardownStarted` latch short-circuits the second entry (sinon spy on `instance.stop` called once).

### Goal Invariants
- Assert `signalCleanup` and the `/shutdown` callback both resolve to the same `teardownAndExit` symbol in `bootstrap.ts` (one routine, not two) — `grep -c "teardownAndExit" src/standalone/bootstrap.ts` equals at least 3 (definition + 2 call sites).
- Assert no `console.log('Server stopped')` in `cli.ts` is reachable while `isProcessAlive(health.pid)` returns true — the success branch is gated on liveness, not on `res.status === 200` alone.
- Assert `process.exit(0)` is present inside the `/shutdown` callback's call path in `bootstrap.ts` (negative: today it is absent; positive: after the fix it is reachable via `teardownAndExit`).
- Assert the bounded force-exit timer is armed *after* the 50ms flush `setTimeout`, not before it, in the `/shutdown` path (the timer-arming line is textually inside `teardownAndExit`, which is called after the flush `await`).

### Manual
- Start the board, run `switchboard stop`, and confirm `pgrep -f cli.js` is empty **without** a follow-up `kill -9` — including the `switchboard-pty-host` children.
- Send `Ctrl-C` (SIGINT) to a running host and confirm the same exit behaviour — the unified routine serves both paths identically.

## Outstanding Questions

- None.

## Implementation Summary
Unified signal cleanup and `/shutdown` API teardown in `src/standalone/bootstrap.ts` under a shared `teardownAndExit` routine with a re-entrancy latch (`teardownStarted`) and bounded 5000ms force-exit timer. Added active resource logging (`getActiveResourcesInfo`) to inspect surviving handles on both graceful and forced exit. In `src/standalone/cli.ts`, replaced fixed sleep after `/shutdown` with a bounded liveness poll against the server PID and Linux starttime recycling guard. The CLI now confirms the process has truly terminated before logging `Server stopped`, and fails loudly with PID/port diagnostics if the process remains alive.
