# Windows `switchboard stop` is a hard kill — replace signal-based shutdown with an authenticated HTTP verb

## Goal

Make `switchboard stop` actually graceful on Windows, where it currently cannot be. Today it loses board state and orphans every running agent, while reporting a clean stop. The fix is a cross-platform shutdown primitive rather than a Windows branch, so the two implementations cannot drift.

### Problem Analysis

`src/standalone/cli.ts:779` does `process.kill(pid, 'SIGTERM')`. Windows has no POSIX signals — Node maps that call to `TerminateProcess()`, which is immediate and unconditional, and runs no handler in the target. Four consequences follow, and every one of them is silent:

1. `bootstrap.ts:2721`'s `process.once('SIGTERM', signalCleanup)` never fires.
2. The 5-second grace period at `cli.ts:788` is dead code. Its own comment says it exists to cover "the debounced `kanban.db` persist (300 ms trailing) plus the export/atomic-rename"; on Windows the loop runs once, finds the process already gone, and reports a graceful stop.
3. That persist is therefore abandoned. **A card moved within ~300 ms of `switchboard stop` is lost**, and the operator is told the server stopped cleanly.
4. `ptyFleetService.disposeAll()` never runs. Windows does not terminate a process tree with its parent, so **every dispatched agent CLI is orphaned** — 8–16 processes still running, still holding worktree file handles, still consuming API quota, and no longer visible to the board that spawned them.

The SIGKILL escalation branch is meaningless here too: `TerminateProcess` was already the first action, so a message about escalating misdescribes what happened.

Step 5 of `standalone-daemon-lifecycle.md`'s Verification Plan ("Graceful stop preserves the DB") passes on macOS and Linux and is never run on Windows, which is why this shipped.

**Additional defect discovered during review:** `disposeAll()` at `ptyFleetService.ts:725-748` calls `handle.pty.kill('SIGTERM')` (line 729) and `handle.pty.kill('SIGKILL')` (line 743). On Windows, node-pty's `WindowsTerminal.prototype.kill(signal)` throws `'Signals not supported on windows.'` when a signal argument is passed (verified in `node_modules/node-pty/lib/windowsTerminal.js:147-155`). The `catch { /* ignore */ }` blocks swallow both throws. This means `disposeAll()` **silently does nothing on Windows** — no PTY child is killed, the `terminals` map is cleared, and `updateRegistryState()` writes a clean state while every child process is still running. Even if the HTTP verb calls `instance.stop()` → `disposeAll()`, the orphans survive. This must be fixed in the same plan.

### Root Cause

The lifecycle work was designed against POSIX semantics — signals, a grace period, escalation — and then given a Windows template of the same shape. Nothing consulted what `process.kill` does on `win32`, and `disposeAll()` was written assuming `pty.kill(signal)` works cross-platform when node-pty explicitly rejects signals on Windows.

### Non-goals

- Not fixing the `--detach`-under-a-service-manager defect. That affects all three platforms and is logged on `standalone-daemon-lifecycle.md`.
- No change to Ctrl-C behaviour on any platform.

## Metadata

**Complexity:** 5
**Tags:** windows, cli, reliability, data-integrity

## User Review Required

None. The design decision — an HTTP verb rather than `taskkill` — is made below and does not need adjudicating.

## Complexity Audit

### Routine
- Correcting the escalation message so it does not claim a SIGKILL escalation on a platform where the first step was already a hard kill.
- Adding the `POST /shutdown` route to `_handleRequest`'s if-else chain in `LocalApiServer.ts`, following the same pattern as every other authenticated route (`_checkAuth` → handler → respond).

### Complex / Risky
- **Graceful shutdown without a signal.** The new path must produce the *same* teardown the SIGTERM handler produces — `disposeAll()`, ingestion dispose, provider disposes, `server.stop()`, port and PID unlink — and must respond to the caller before exiting, or `stop` cannot distinguish success from a dropped connection.
- **`disposeAll()` is broken on Windows.** `pty.kill('SIGTERM')` throws on Windows; the catch swallows it. The fix: on `win32`, call `handle.pty.kill()` **without a signal argument**. node-pty's `WindowsTerminal.kill()` without a signal calls `_agent.kill()`, which calls `getConsoleProcessList()` and `process.kill(pid)` for every PID in the console — reaping the direct child AND every process attached to the same console (grandchildren included). This is the built-in orphan reaper; it just needs to be called correctly.
- **A shutdown endpoint is a denial-of-service primitive if the gate is wrong.** It must sit behind the same loopback peer check, Host guard, and durable-token auth as every other authenticated route.
- **Response-then-exit sequencing.** `res.end()` must complete before `instance.stop()` calls `server.close()`, or the response never lands. And `server.close()` is async — it waits for in-flight connections to drain. If the client doesn't read the response, `server.close()` hangs. A hard `setTimeout(() => process.exit(0), 2000)` backstop is needed.

## Edge-Case & Dependency Audit

- `process.kill(pid, 0)` for liveness probing behaves differently on Windows than the signal-sending form. Do not assume the existing stale-PID logic generalises; the `/health` identity re-verification at `cli.ts:797` is platform-neutral and stays the primary guard against signalling a recycled PID.
- **`_checkAuth` and the durable-token dependency.** `_checkAuth` (`LocalApiServer.ts:773-805`) returns `true` when `expected` is empty (line 776: `if (!expected) { return true; }`). However, `bootstrap.ts:482-485` already guards the standalone path: `trimmedStored.length > 0` — if the stored token is blank, it falls through to a random 32-byte session token. The standalone server ALWAYS has a non-empty expected token. The `/shutdown` endpoint is protected by the random token even without the durable-token fail-closed fix. The dependency on `standalone-durable-session-token.md` is real for defence-in-depth (the extension path where `getAuthToken()` returns empty), but it is NOT a blocker for the standalone path — the standalone server already protects against blank tokens.
- The endpoint must respond and *then* exit, not exit inside the handler. Sequence: `res.end(JSON.stringify({status:'shutting down'}))` → `await instance.stop()` → `process.exit(0)`, with a `setTimeout(() => process.exit(0), 2000)` backstop in case `server.close()` hangs on an unread response.
- An older running server will not have the route. The new CLI must detect that (404 or connection refused on `POST /shutdown`) and fall back to SIGTERM rather than reporting a failure.
- **`disposeAll()` fix is platform-conditional.** On `win32`, call `handle.pty.kill()` without a signal. On POSIX, keep `handle.pty.kill('SIGTERM')` with the grace period and SIGKILL escalation — that path works correctly on macOS and Linux. The `SIGTERM_GRACE_MS` wait loop should be skipped on Windows (there is nothing to wait for — `pty.kill()` without signal is immediate).

## Dependencies

- **Soft dependency on `standalone-durable-session-token.md`** for the fail-closed `_checkAuth` fix. The standalone path already guards against blank tokens (`bootstrap.ts:482-485`), so this is defence-in-depth, not a blocker. The `/shutdown` endpoint is protected by the random session token even without the fix.
- Overlaps `standalone-daemon-lifecycle.md` only in `cli.ts`'s `stop` command body. That card's own review fixes touch `bootstrap.ts` signal registration and the autostart templates, not this function.

## Adversarial Synthesis

The tempting one-line fix is `taskkill /T /F`, because it does reap the orphans. It is the wrong fix: `/F` is still a hard kill, so the `kanban.db` persist is still abandoned. It trades "silent data loss plus orphans" for "silent data loss" and reads as fixed. Any fix that does not run the existing teardown path has not addressed the defect that matters.

The second shortcut is to wait longer on Windows. There is nothing to wait for — the process is gone before the loop starts.

The third trap — discovered during review — is assuming the HTTP verb alone fixes the orphan bug. It does not: `disposeAll()` passes signals to `pty.kill()`, which throws on Windows. The HTTP verb calls `instance.stop()` → `disposeAll()`, but `disposeAll()` silently does nothing. The orphan fix requires `disposeAll()` to call `pty.kill()` without a signal on Windows, leveraging node-pty's built-in `getConsoleProcessList()` reaper.

## Proposed Changes

1. **Add `POST /shutdown` to `LocalApiServer._handleRequest`**, following the same pattern as every other authenticated route. The handler:
   - Calls `_checkAuth(req, true)` — refuses unauthenticated callers with 401.
   - Responds with `res.end(JSON.stringify({status:'shutting down'}))` BEFORE calling teardown.
   - Calls `await instance.stop()` (the same teardown `signalCleanup` runs: `disposeAll()`, ingestion dispose, provider disposes, `server.stop()`, port/PID unlink).
   - Calls `process.exit(0)` after teardown completes.
   - Sets a `setTimeout(() => process.exit(0), 2000)` backstop in case `server.close()` hangs on an unread response connection.
   - The `instance` reference must be passed to `LocalApiServer` via the options object (currently `instance.stop()` is a closure in `bootstrap.ts`; the server needs a callback or reference).

2. **Make `switchboard stop` prefer the HTTP verb on every platform**, keeping the `/health` identity check. After confirming server identity via `/health`, attempt `POST /shutdown` with the session token (read from the same auth path the CLI uses). If the response is 200, report success. If the route is absent (404) or the connection is refused, fall back to the existing SIGTERM path. One code path on all platforms is the point.

3. **Fix `disposeAll()` in `ptyFleetService.ts`** so it works on Windows. On `win32`, call `handle.pty.kill()` **without a signal argument** — node-pty's `WindowsTerminal.kill()` without a signal calls `_agent.kill()`, which uses `getConsoleProcessList()` + `process.kill(pid)` per child, reaping the entire console process list (direct children + grandchildren). On POSIX, keep the existing `handle.pty.kill('SIGTERM')` → grace period → `handle.pty.kill('SIGKILL')` sequence. Skip the `SIGTERM_GRACE_MS` wait loop on Windows (the no-signal kill is immediate).

4. **Correct the escalation messaging** on Windows: report that the process was terminated without a graceful teardown, that agent processes may be orphaned, and name the recovery.

### Migration

None. No persisted state changes shape. The route is additive and the SIGTERM fallback keeps a new CLI working against an already-running older server.

## Verification Plan

1. **Windows graceful stop preserves the DB.** Move a card, `switchboard stop` immediately, restart, confirm the move persisted. This is the assertion that fails today.
2. **Windows stop leaves no orphans.** Dispatch three agent terminals, `stop`, confirm via Task Manager that no `claude`/`codex` process survives. This verifies the `disposeAll()` fix — without it, the orphans survive even with the HTTP verb.
3. **macOS and Linux regression fence.** Same round trip on both; confirm the HTTP path produces an identical teardown to the SIGTERM path and that step 5 of the lifecycle plan still passes.
4. **Fallback path.** Point a new CLI at a server without `/shutdown`; confirm SIGTERM fallback with the identity check intact.
5. **The verb refuses unauthenticated callers.** `POST /shutdown` with no token, a wrong token, and a blank stored secret — all must refuse. The blank-secret case is already guarded by `bootstrap.ts:482-485` (falls back to random token), so this should refuse.
6. **Response precedes exit.** Confirm `stop` reports success from the HTTP response, not from a dropped connection. Verify the `setTimeout` backstop does not fire under normal conditions (the response is read and `server.close()` drains).
7. **`disposeAll()` no-signal kill on Windows.** Verify that `handle.pty.kill()` without a signal does not throw on Windows and that `getConsoleProcessList()` reaps grandchild processes (e.g., a `git` subprocess spawned by the agent CLI).

## Outstanding Questions

None.
