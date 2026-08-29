# A detached board can spin at 100% CPU holding its port, and every way of asking "is it running" says yes

## Goal

Make a wedged board detectable and stoppable. A detached server that has stopped serving must not keep its listening socket, its port file, and a `status` answer that implies health — and `stop` must actually end it rather than sending a signal a blocked event loop can never handle.

### The problem, and the root cause

**Observed, not hypothetical.** A detached standalone board ran for **1 day 14 hours at 98.7% CPU** in state `Rs`. In that state it:

- held `127.0.0.1:7777` in `LISTEN`
- answered **HTTP 000** on both `127.0.0.1` and `localhost` — the socket accepted nothing
- **ignored `SIGTERM`** entirely, surviving `kill` and requiring `SIGKILL`
- left `.switchboard/api-server-port.txt` in place the whole time

Every one of those follows from a single cause: **the event loop was blocked in a busy loop.** Node dispatches signal handlers, HTTP callbacks and health responses on that loop. A spin at 100% CPU starves all three at once. The process is alive by every operating-system measure and dead by every functional one.

**The listening socket is the most damaging part**, because it is held by the kernel, not the application. The socket stays bound while the process exists regardless of whether anything ever `accept()`s again. So:

- `ssh -L 7777:127.0.0.1:7777` **cannot bind** the local end. It fails with `bind: Address already in use`, which scrolls past in a `-N` invocation, and the operator's browser then silently talks to the wedged local process instead of the tunnel's far end. This cost an entire debugging session: the homelab's server log showed nothing because no request ever left the machine.
- Any liveness check that connects a TCP socket gets a successful connect and concludes the board is up.

**`stop` cannot stop it.** The graceful path signals the process and waits. A blocked loop never runs the handler, so `stop` hangs or reports failure, and the operator is left to find the PID by hand. There is no escalation to `SIGKILL` after a timeout.

> **Superseded:** "`stop` cannot stop it… There is no escalation to `SIGKILL` after a timeout."
> **Reason:** Verified in `src/standalone/cli.ts:1167-1195` — `stop` already sends `SIGTERM`, polls a 5s grace window, re-verifies identity, then escalates to `process.kill(pid, 'SIGKILL')` with a warning that names the abandoned write, and unlinks the stale port/pid files (lines 1202-1207). The escalation is present and correct. The real defect is that it is **unreachable for the wedged case**: `stop` is gated on `findRunningInstance` (line 1148), which calls `probeHealth` (line 355), which returns `false` when `/health` does not answer — the definition of a wedge. A wedged board is therefore refused at line 1151 ("No running Switchboard instance found") before any escalation runs. A second defect: the grace-period exit check (lines 1184-1187) uses `probeHealth`, which is false for a wedged board by definition, so the re-verify would falsely report "Server stopped during grace period" (line 1188) and skip the `SIGKILL` — an active false report, not a missing feature.
> **Replaced with:** Ungate `stop` from the `/health` requirement. Read the port file directly; when `/health` fails but the port is bound, source the PID from `api-server.pid` (written at `bootstrap.ts:3350`), guard it with `process.kill(pid, 0)`, and run the **existing** `SIGTERM`→`SIGKILL` flow — but with the exit-detection poll switched to `isPortFree(port)` / `process.kill(pid, 0)` on the wedged path, so a still-spinning board is not falsely reported dead. See `## Proposed Changes` → `stop`.

**The port file outlives it, and that is load-bearing elsewhere.** Both hosts unlink the port file on clean shutdown, which makes its presence a reasonable proxy for "a board is running" — and `/switchboard` relies on exactly that, refusing to launch when a port file exists but liveness cannot be confirmed. A wedged process never reaches its shutdown path, so the file persists and the launcher refuses to start a board **forever**, with recovery that is manual and undiscoverable. This is the same failure `sandbox-surviving-board-liveness-via-unix-socket.md` describes, arriving by a different route: there the port file lies because the process died uncleanly, here because it is alive but useless.

**One thing already works and should not be rebuilt.** The `--detach` path polls `findRunningInstance` — port file **plus** a `/health` probe — before reporting success, and its comment names the failure it prevents: *"a detached launch returning 0 and a URL for a dead process."* That is the correct check. It simply runs **once, at startup**, and never again. The gap is not the health check's design; it is that nothing re-runs it.

**The root cause is that liveness is asserted at boot and never re-established.** A detached process is exempted from the one signal an operator naturally relies on — the terminal closing — and nothing replaces it. There is no watchdog, no self-check, no way for the process to notice it has stopped serving, and no way for the operator to find out except by discovering the symptom somewhere else entirely.

### Not in scope

- **Detaching itself.** `--detach` is opt-in (`cli.ts:1268`, `if (args.detach)`), documented as *"run in background (detached). Implies `--no-open` unless `--open` is given"*, and behaves correctly. Surviving the terminal is the point of it. Do not change the default.
- **Whatever caused the spin.** The specific infinite loop is unknown and may not recur. This plan makes any wedge survivable; diagnosing that one is separate work and should not gate this.

## Metadata

- **Complexity:** 5

> **Superseded:** Complexity 4.
> **Reason:** The plan originally scored itself assuming the `SIGKILL` escalation was net-new work. It is not — the escalation already exists, which lowers the `stop` effort. However, the remaining net-new work (ungating `stop` + pid-file PID source + port-based exit check, three-state `status` gated on heartbeat age, and the heartbeat writer/reader with a false-positive-safe threshold) spans 2-3 files with one moderate, well-scoped risk (the heartbeat threshold that must not fire during legitimate busy periods). That is the "majority routine, one or two moderate risks extending existing patterns" band.
> **Replaced with:** Complexity 5 (Mixed).

- **Tags:** cli, reliability, devops, bugfix

## User Review Required

None. Three decisions made and recorded:

1. **`stop` escalates.** `SIGTERM`, wait a bounded interval, then `SIGKILL`. A process that cannot handle a signal must not be able to refuse being stopped.
2. **`status` distinguishes three states, not two** — running (port file + `/health` answers), **wedged** (port bound, `/health` does not answer), and stopped. Today the middle case is invisible, and it is the one that costs hours.
3. **The watchdog reports; it does not self-terminate.** A board that exits on its own during a long GC pause or a heavy import would be worse than the disease. It logs and lets `status` and the operator act.

## Complexity Audit

### Routine

- The third state in `status`, reusing the existing `findRunningInstance`/`probeHealth` probe and the `isPortFree` helper (`cli.ts:381`).
- Stale port/pid file cleanup — already implemented for the healthy-`stop` path (`cli.ts:1202-1207`); extended to the wedged and already-dead paths.
- The heartbeat writer is a single `setInterval` + `fs.writeFileSync`; the reader is one `stat` + age compare.

### Complex / Risky

- **`stop` must reach the wedged board.** The existing `SIGTERM`→`SIGKILL` escalation is correct but unreachable: `findRunningInstance` (`cli.ts:355`) requires `/health`, which a wedged board cannot answer, so `stop` exits at line 1151 before any signal. The fix is to read the port file directly and, when `/health` fails but the port is bound, source the PID from `api-server.pid` (`bootstrap.ts:3350`) guarded by `process.kill(pid, 0)`. Choosing to signal on the pid file reverses the codebase's stated "never signal based on this file alone" policy (`cli.ts:3345-3348`) — justified here because the port-bound check (`isPortFree` false) confirms a live process holds our port, which is the only case the pid file is consulted.
- **The wedged-path exit check must not use `probeHealth`.** The existing grace-period re-verify (`cli.ts:1184-1187`) uses `probeHealth`, which is false for a wedged board by definition and would falsely report "Server stopped during grace period." The wedged path must detect exit via `isPortFree(port)` or `process.kill(pid, 0)`.
- **The heartbeat writer must be ON the main event loop, not off it.** A `setInterval` on the main loop stops refreshing when the loop blocks — that staleness is the signal. A `worker_thread` writer would keep ticking through a block and never go stale, defeating the purpose. The OBSERVER (`status`/`stop`, separate processes) is what sits outside the loop.
- **`status` must gate the wedged verdict on heartbeat staleness, not on `/health` timeout alone.** A board mid-`sql.js`-persist or bulk import legitimately does not answer `/health` within a short timeout; calling that "wedged" trains the operator to ignore the alarm. The heartbeat age separates "blocked" (stale) from "busy" (fresh).
- **Distinguishing wedged from busy.** A board legitimately blocks for seconds during a large `sql.js` persist or a bulk import. The threshold must be well above those, and the state must be reported rather than acted on.

## Edge-Case & Dependency Audit

- **`stop` on an already-dead process** — the port file may linger; `stop` should clear it and report cleanly (exit 0) rather than erroring. Today `findRunningInstance` returns null and `stop` exits 1; the ungate fixes this by reading the port file directly and clearing it when the port is free.
- **`SIGKILL` during a persist.** `sql.js` rewrites the whole DB file, so a hard kill mid-write is the "stale image restored from a `.tmp`" state the schema layer carries a permanent shim for. Escalate only after `SIGTERM` has had time, and say in the output that the graceful path was tried first. The existing 5s grace (`cli.ts:1175`) is retained.
- **A wedged process cannot clean up after itself.** Removal of a stale port/pid/heartbeat file must be done by whoever detects the wedge — `status` or `stop` — never deferred to the wedged process.
- **Both hosts.** The extension host runs the same `LocalApiServer` inside VS Code, where the editor's own lifecycle masks this. The port file and health semantics must stay identical; do not fix this only in the standalone CLI. The heartbeat writer is added to the shared bootstrap (`bootstrap.ts`) so both hosts emit it.
- **A second board on another workspace.** `findRunningInstance` is workspace-scoped, so the three-state check must not report another workspace's healthy board as this one's. The port file is read from this workspace's `.switchboard/`, preserving the scoping.
- **Recycled PID when signalling from the pid file.** The pid file is "advisory only" because PIDs recycle (`cli.ts:3345-3348`). For the wedged case the board is alive (the whole premise), so its PID is not recycled; the additional guard is `process.kill(pid, 0)` (PID alive) **and** `isPortFree(port) === false` (something holds our port). A recycled PID that happens to hold our port is the one coincidence left — and even then we would be killing the holder of our port, which is the desired outcome.
- **Heartbeat file absent on a freshly-started board.** The first heartbeat is written immediately on `setInterval` setup; until then `status` may see no file. Treat a missing heartbeat file as "unknown" (fall back to the `/health`-timeout verdict) rather than "stale," so a race at startup does not false-wedge.

## Dependencies

- **Related, not blocking: `sandbox-surviving-board-liveness-via-unix-socket.md`.** It replaces the port file with a socket whose existence dies with the process — which would fix the *stale file* half of this automatically. It does not address the wedged-but-alive case, where a kernel-backed object would still exist. The two are complementary: that plan makes "dead" detectable, this one makes "alive but not serving" detectable. Land in either order; if that one lands first, this plan's port-file cleanup follows its new mechanism.

## Adversarial Synthesis

Key risks: (1) the existing `SIGKILL` escalation is unreachable for the wedged case because `stop` is gated on `/health` — mitigation: ungate `stop`, source the PID from the pid file when the port is bound, and switch the wedged-path exit check from `probeHealth` to `isPortFree`/`process.kill(pid,0)` so a still-spinning board is not falsely reported dead; (2) a heartbeat writer placed off the main loop would never go stale — mitigation: writer is a main-loop `setInterval`, observer is the out-of-process CLI; (3) a `status` wedged verdict based on `/health` timeout alone false-positives on legitimate busy periods — mitigation: gate the verdict on heartbeat staleness with a threshold (15s) well above observed persist/import times, report-only; (4) fixing `status` while leaving the socket held so `ssh -L` still cannot bind — mitigation: the acceptance test is that a wedged board is *stoppable*, not merely *reportable*.

## Proposed Changes

### `src/standalone/cli.ts` — `stop` (lines 1146-1211)

- **Context.** `stop` is gated on `findRunningInstance` (line 1148), which requires `/health` (line 355). A wedged board fails this and `stop` exits 1 at line 1151 — "No running Switchboard instance found" — before any signal. The `SIGTERM`→`SIGKILL` escalation at lines 1167-1195 is correct and is **kept as-is for the healthy path**.
- **Logic.** Replace the `findRunningInstance` gate with a direct port-file read:
  1. Read `.switchboard/api-server-port.txt`. If absent → "No running instance", exit 0 (clean, not 1 — see Edge-Case: already-dead).
  2. Try `getHealthJson(port)` (existing). If it answers → run the **existing** healthy `SIGTERM`→`SIGKILL` flow (lines 1164-1210) unchanged.
  3. If `/health` fails → `await isPortFree(port)` (helper at line 381). If the port is **free** → the process is gone, the port file is stale: unlink `api-server-port.txt`, `api-server.pid`, and `api-server-heartbeat.txt`; report "Server was already stopped (cleaned up stale files)"; exit 0.
  4. If the port is **bound** → wedged. Read `api-server.pid` for the PID; guard with `process.kill(pid, 0)` (PID alive). If the pid file is missing or the PID is dead, report "Port is bound but no PID could be resolved — the holder may be a non-switchboard process; remove `.switchboard/api-server-port.txt` manually or free port N"; exit 1. If the PID is alive → `SIGTERM`, poll the grace window, then `SIGKILL` (reuse the existing escalation), **but** the exit-detection poll and the grace-period re-verify must use `isPortFree(port)` / `process.kill(pid, 0)`, NOT `probeHealth` (which is false for a wedged board and would falsely report "stopped during grace period").
- **Implementation.** Add a `stopWedged(port, pid, switchboardDir)` helper that mirrors the healthy escalation but uses port/PID liveness for exit detection. The healthy path stays inline. After either path, unlink `api-server-port.txt`, `api-server.pid`, and `api-server-heartbeat.txt` (extend the existing cleanup at lines 1202-1207).
- **Edge Cases.** Already-dead (step 3, exit 0); pid file missing but port bound (step 4, refuse with a remedy); `SIGKILL` mid-persist (retained 5s grace + warning); recycled PID (guarded by `process.kill(pid,0)` + port-bound check).

### `src/standalone/cli.ts` — `status` (lines 1213-1255)

- **Context.** `status` calls `findRunningInstance` (line 1218), which returns null when `/health` fails, so a wedged board is reported as "No running Switchboard instance" (stopped). The middle state is invisible.
- **Logic.** Read the port file directly (not via `findRunningInstance`) and report four states:
  1. No port file → **stopped** (`{ running: false, state: "stopped" }`).
  2. Port file present, `isPortFree(port)` true → **stale file** (process gone): report stopped, advise "stale port file removed," optionally unlink it, exit 1.
  3. Port bound, `getHealthJson` answers → **running** (existing payload, add `state: "running"`).
  4. Port bound, `/health` times out → consult the heartbeat age (see the reader below). If the heartbeat is **stale** (age > `WEDGE_THRESHOLD_MS`) → **wedged**: emit `{ running: false, state: "wedged", pid: <from pid file>, port, remedy: "run \`switchboard stop\`" }` and, in human mode, name the PID and the remedy. If the heartbeat is **fresh** (or absent — treat as unknown, not stale) → **busy/slow**: report running with a note that `/health` is slow, do NOT call it wedged.
- **Implementation.** Add a `readHeartbeatAge(switchboardDir)` helper returning ms since last write (or `Infinity` if file missing — but see Edge-Case: a missing file on a healthy board is treated as "unknown," falling back to the `/health`-timeout verdict without alarming). Add `WEDGE_THRESHOLD_MS = 15000` as a named constant (well above the 300ms debounce + 50ms rename persist window and multi-second bulk imports). Keep the `running` boolean for backward compatibility and add the `state` field.
- **Edge Cases.** Another workspace's board (port file is workspace-scoped, unaffected); missing heartbeat at startup (unknown, not stale); legitimately slow board (fresh heartbeat ⇒ busy, not wedged).

### `src/standalone/bootstrap.ts` — heartbeat writer (after line 3350)

- **Context.** The server writes the port file (line 3342) and pid file (line 3349) at boot but emits no ongoing liveness signal. A blocked event loop leaves both files in place indefinitely.
- **Logic.** Immediately after the pid file write, start a `setInterval` on the **main event loop** that writes `Date.now()` to `.switchboard/api-server-heartbeat.txt` every `HEARTBEAT_INTERVAL_MS` (2000ms). Write once immediately so the file exists before the first tick. The interval is ON the main loop by design: when the loop blocks, the timer stops firing and the heartbeat goes stale — that staleness is the signal `status`/`stop` read.

> **Superseded:** "Write a heartbeat (timestamp) from outside the main event loop, so a blocked loop stops refreshing it."
> **Reason:** Inverted. A writer outside the loop (e.g. a `worker_thread` with its own loop) keeps ticking while the main loop is blocked, so the heartbeat never goes stale — the watchdog is silent in exactly the case it exists for, which the plan's own Complexity Audit names as "the whole risk." The writer MUST be on the main loop so it starves with everything else; the OBSERVER (`status`/`stop`, separate processes) is what sits outside the loop.
> **Replaced with:** A main-loop `setInterval` writes `Date.now()` to `.switchboard/api-server-heartbeat.txt` every 2s. It stops refreshing when the loop blocks; the out-of-process CLI reads the age.

- **Implementation.** Add the interval setup after line 3350; store the handle so the existing clean-shutdown path can `clearInterval` and unlink the heartbeat file alongside the port/pid files. Both the standalone bootstrap and the extension host's `TaskViewerProvider` port-file writer run this same bootstrap, so both hosts emit the heartbeat.
- **Edge Cases.** Clean shutdown unlinks the heartbeat file (so a stopped board is not later misread as "freshly healthy"); a wedged board cannot reach cleanup, so `stop`/`status` unlink it after killing/detecting.

### `src/test/wedged-board-contract.test.js` — new

- Contract test for the four behaviors in the Verification Plan. See `## Verification Plan`.

## Files Changed

- `src/standalone/cli.ts` — `stop` ungate + pid-file PID source + port-based exit check (wedged path); three-state `status` gated on heartbeat age; `readHeartbeatAge` and `stopWedged` helpers; `WEDGE_THRESHOLD_MS` constant.
- `src/standalone/bootstrap.ts` — heartbeat writer (`setInterval` on the main loop) after the pid file write; cleanup on shutdown.
- `src/test/wedged-board-contract.test.js` — new contract test.

## Verification Plan

### Automated Tests

1. **`stop` kills a process that ignores `SIGTERM`.** Spawn a child that traps and ignores it; assert `stop` escalates and the process ends.
2. **`stop` kills a wedged board (port bound, `/health` dead).** Bind the port, do not answer `/health`, write a pid file pointing at a live process; assert `stop` reads the pid file, signals, and the process ends — and that it does NOT falsely report "stopped during grace period" (the exit check uses port/PID liveness, not `probeHealth`).
3. **`status` reports wedged.** Bind the port, do not answer `/health`, write a stale heartbeat (age > `WEDGE_THRESHOLD_MS`); assert `state: "wedged"` — not "running", not "stopped".
4. **`status` does NOT false-wedge on a busy board.** Bind the port, do not answer `/health`, write a **fresh** heartbeat; assert the state is "busy"/running-with-note, not "wedged". This is the test that proves the wedged verdict is gated on heartbeat staleness, not `/health` timeout alone.
5. **The heartbeat goes stale when the loop blocks.** Block the main loop artificially; assert the heartbeat file stops advancing and `status` notices. **This is the test that proves the watchdog writer is on the blocked loop** — a `worker_thread` implementation fails it.
6. **`stop` on an already-dead process** (port free, stale port file) clears the port/pid/heartbeat files and exits 0.

### Manual

7. Reproduce a wedge (`while(true){}` in the server), then confirm: `status` says wedged, `stop` ends it, the port frees, and `ssh -L` binds afterwards.

### Goal Invariants

- After `stop` returns exit 0 against a port-bound/`/health`-dead board, `isPortFree(port)` is `true` (the kernel socket is released — the `ssh -L` goal).
- After `stop` returns exit 0 against a wedged board, the PID from `api-server.pid` is no longer alive (`process.kill(pid, 0)` throws `ESRCH`).
- `status --json` against a port-bound/`/health`-dead/stale-heartbeat board emits an object whose `state` field equals `"wedged"` (not `"running"`, not `"stopped"`).
- `status --json` against a port-bound/`/health`-dead/fresh-heartbeat board does NOT emit `state: "wedged"` (the false-positive guard).
- A main loop blocked for longer than `WEDGE_THRESHOLD_MS` produces a heartbeat file whose age exceeds `WEDGE_THRESHOLD_MS` (the writer is on the blocked loop).
- `status --json` against a healthy board (`/health` ok, fresh heartbeat) still emits `running: true` and `state: "running"` (no regression on the existing two-state contract).
