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

**The port file outlives it, and that is load-bearing elsewhere.** Both hosts unlink the port file on clean shutdown, which makes its presence a reasonable proxy for "a board is running" — and `/switchboard` relies on exactly that, refusing to launch when a port file exists but liveness cannot be confirmed. A wedged process never reaches its shutdown path, so the file persists and the launcher refuses to start a board **forever**, with recovery that is manual and undiscoverable. This is the same failure `sandbox-surviving-board-liveness-via-unix-socket.md` describes, arriving by a different route: there the port file lies because the process died uncleanly, here because it is alive but useless.

**One thing already works and should not be rebuilt.** The `--detach` path polls `findRunningInstance` — port file **plus** a `/health` probe — before reporting success, and its comment names the failure it prevents: *"a detached launch returning 0 and a URL for a dead process."* That is the correct check. It simply runs **once, at startup**, and never again. The gap is not the health check's design; it is that nothing re-runs it.

**The root cause is that liveness is asserted at boot and never re-established.** A detached process is exempted from the one signal an operator naturally relies on — the terminal closing — and nothing replaces it. There is no watchdog, no self-check, no way for the process to notice it has stopped serving, and no way for the operator to find out except by discovering the symptom somewhere else entirely.

### Not in scope

- **Detaching itself.** `--detach` is opt-in (`cli.ts:1268`, `if (args.detach)`), documented as *"run in background (detached). Implies `--no-open` unless `--open` is given"*, and behaves correctly. Surviving the terminal is the point of it. Do not change the default.
- **Whatever caused the spin.** The specific infinite loop is unknown and may not recur. This plan makes any wedge survivable; diagnosing that one is separate work and should not gate this.

## Metadata

- **Complexity:** 4
- **Tags:** cli, reliability, devops, bugfix

## User Review Required

None. Three decisions made and recorded:

1. **`stop` escalates.** `SIGTERM`, wait a bounded interval, then `SIGKILL`. A process that cannot handle a signal must not be able to refuse being stopped.
2. **`status` distinguishes three states, not two** — running (port file + `/health` answers), **wedged** (port bound, `/health` does not answer), and stopped. Today the middle case is invisible, and it is the one that costs hours.
3. **The watchdog reports; it does not self-terminate.** A board that exits on its own during a long GC pause or a heavy import would be worse than the disease. It logs and lets `status` and the operator act.

## Complexity Audit

### Routine

- The `SIGKILL` escalation in `stop`.
- The third state in `status`, reusing the existing `findRunningInstance` probe.

### Complex / Risky

- **The watchdog must not share the blocked loop.** A `setInterval` self-check is worthless here: the same starved loop that cannot answer `/health` cannot run the timer either. It has to observe from outside the event loop — a `worker_thread` with its own loop, or a heartbeat file the parent writes and `status` reads with an age check. Choosing the wrong one produces a watchdog that is guaranteed silent in the one case it exists for. **This is the whole risk in the plan.**
- **Distinguishing wedged from busy.** A board legitimately blocks for seconds during a large `sql.js` persist or a bulk import. The threshold must be well above those, and the state must be reported rather than acted on.

## Edge-Case & Dependency Audit

- **`stop` on an already-dead process** — the port file may linger; `stop` should clear it and report cleanly rather than erroring.
- **`SIGKILL` during a persist.** `sql.js` rewrites the whole DB file, so a hard kill mid-write is the "stale image restored from a `.tmp`" state the schema layer carries a permanent shim for. Escalate only after `SIGTERM` has had time, and say in the output that the graceful path was tried first.
- **A wedged process cannot clean up after itself.** Removal of a stale port file must be done by whoever detects the wedge — `status` or `stop` — never deferred to the wedged process.
- **Both hosts.** The extension host runs the same `LocalApiServer` inside VS Code, where the editor's own lifecycle masks this. The port file and health semantics must stay identical; do not fix this only in the standalone CLI.
- **A second board on another workspace.** `findRunningInstance` is workspace-scoped, so the three-state check must not report another workspace's healthy board as this one's.

## Dependencies

- **Related, not blocking: `sandbox-surviving-board-liveness-via-unix-socket.md`.** It replaces the port file with a socket whose existence dies with the process — which would fix the *stale file* half of this automatically. It does not address the wedged-but-alive case, where a kernel-backed object would still exist. The two are complementary: that plan makes "dead" detectable, this one makes "alive but not serving" detectable. Land in either order; if that one lands first, this plan's port-file cleanup follows its new mechanism.

## Adversarial Synthesis

Key risks. (1) Implementing the watchdog as a `setInterval` on the main loop, guaranteeing it is silent in exactly the case it exists for — mitigation: it must observe from outside the loop, and the verification includes an artificially blocked loop. (2) `SIGKILL` landing mid-persist and corrupting the board — mitigation: escalate only after a bounded `SIGTERM` wait, and document that a wedged loop is not persisting anyway. (3) A wedge threshold tight enough to fire during a legitimate bulk import, training the operator to ignore it — mitigation: threshold well above observed persist times, and report-only. (4) Fixing `status` while leaving the socket held, so `ssh -L` still cannot bind — mitigation: the acceptance test is that a wedged board is *stoppable*, not merely *reportable*.

## Proposed Changes

### `src/standalone/cli.ts` — `stop`

- After `SIGTERM`, poll for exit up to a bounded timeout, then `SIGKILL`. Report which was needed.
- Clear a stale port file when the process is already gone.

### `src/standalone/cli.ts` — `status`

- Report three states. When the port is bound but `/health` does not answer within a short timeout, say so explicitly and name the PID and the remedy, rather than falling through to "not running".

### The server — a liveness heartbeat

- Write a heartbeat (timestamp) from outside the main event loop, so a blocked loop stops refreshing it. `status` reads its age to distinguish wedged from healthy without depending on the loop it is testing.

## Files Changed

- `src/standalone/cli.ts` — `stop` escalation, three-state `status`
- The server bootstrap — heartbeat writer off the main loop
- `src/test/wedged-board-contract.test.js` — new

## Verification Plan

### Automated

1. **`stop` kills a process that ignores `SIGTERM`.** Spawn a child that traps and ignores it; assert `stop` escalates and the process ends.
2. **`status` reports wedged.** Bind the port, do not answer `/health`, assert the third state — not "running", not "stopped".
3. **The heartbeat goes stale when the loop blocks.** Block the main loop artificially; assert the heartbeat stops advancing and `status` notices. **This is the test that proves the watchdog is not itself on the blocked loop** — a `setInterval` implementation fails it.
4. **`stop` on an already-dead process** clears the port file and exits zero.

### Manual

5. Reproduce a wedge (`while(true){}` in the server), then confirm: `status` says wedged, `stop` ends it, the port frees, and `ssh -L` binds afterwards.
