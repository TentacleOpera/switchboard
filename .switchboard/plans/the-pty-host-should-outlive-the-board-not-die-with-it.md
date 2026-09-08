# The PTY Host Should Outlive the Board, Not Die With It

## Goal

The Go PTY host runs on its own lifecycle. A board restart — an upgrade, a crash, `switchboard stop`, a nightly cycle — leaves every seat running with its CLI context intact, and the board **adopts** the live host on start instead of spawning a new one.

### Problem analysis

**Today the fleet is a child process, so it dies with its parent.** `ptyHostSupervisor.ts:135` does `cp.spawn(executable, ['--workspace', root], { stdio: ['pipe','pipe',...] })` and `:169`/`:189` `SIGTERM` it on stop. Observed live: both pty hosts run with `ppid` equal to the Node board's pid. Restart the board and every terminal is destroyed.

**And there is no way to adopt one.** The supervisor has no reattach, reuse or discovery path — only `probePtyHostAvailability`, which is pure filesystem work answering "is there an executable I could spawn". Nothing asks "is one already running".

**The blocker is how identity is communicated.** The child prints its ready handshake to **stdout** (`main.go:586`), and the supervisor parses it off the spawn pipe (`ptyHostSupervisor.ts:146-160`):

```
{ "t":"ready", "port":<n>, "token":"<hex>", "version":<n> }
```

Port and token exist only in that pipe and in the two processes' memory — `main.go:502` mints the token per process with `randomToken()`. A board that did not spawn the child therefore **cannot** talk to it: it knows neither where it listens nor how to authenticate. Adoption is impossible by construction, not by omission.

**This is the point of having moved the fleet out of process.** `e26ac375` made the PTYs a separate program with its own HTTP API, its own port and its own credential. Everything needed for lifecycle independence is there except the ability to find it again. Keeping it as a stdio child spends the cost of the split — a second binary, a wire protocol, four framing bugs found on 2026-09-07 — and takes none of the benefit.

**The operational case is immediate.** Twice on 2026-09-07 a restart destroyed a running four-seat team mid-work, once during an active pipeline. On an always-on box that is the normal case, not an accident: `apt upgrade` restarts the service, a crash restarts it, and the board host's resident memory grows measurably — ~340 MB idle to **605 MB after 4½ hours** — so a periodic restart is a reasonable backstop that is currently unavailable at any price.

**Scope note.** A restart is a mitigation for that drift, not a fix, and this plan does not schedule one. It makes a restart survivable; whether to schedule it is a separate decision that should not be taken until the growth is explained.

### The cheaper alternative, which may be sufficient — evaluate it first

**Restart between sends, and accept the re-seat.** A restart destroys seats; it only destroys *work* if it lands mid-turn. Wait for quiescence and the loss shrinks to CLI conversation context — which **the pipeline design already discards between cards**. `clearBeforePrompt` defaults to true and each seat is cleared before its next plan, so a restart taken while every seat is idle throws away nothing the system was not about to throw away.

Every signal this needs already exists:

- **`isSeatAtRest` / `markSeatAtRest`** (`LocalApiServer.ts:1040-1052`) — per-seat quiescence, already maintained on the completion path.
- **The in-flight predicate** (`:104`) — *"true when card is held by a team member with no completion"*, already the guard the dispatch critical section uses.
- **Boot-time team autostart** (`bootstrap.ts:4363`, `TaskViewerProvider.ts:1744`) — the team re-seats itself on the next start, unattended.

So the whole mechanism is: refuse to restart unless every seat is at rest and no card is in flight; restart; let autostart bring the team back. No state file, no adoption, no detached child, no version negotiation — none of changes 1 to 3.

**Where it is not sufficient, and this is the real decision.** A coder's context is disposable by design; **a lead's is not**. The head accumulates feature-level state across its coders' subtasks — what it accepted, what it rejected, what it is still waiting on — and that is exactly what a re-seat destroys. Between features the loss is nil; mid-feature it is the thing that makes a team a team.

So:

- **If restarts are only ever taken between features**, the cheap path is enough and this card should be closed unbuilt.
- **If the board must survive an `apt upgrade`, a crash, or a reboot at an arbitrary moment** — which is what "always-on appliance" means — quiescence cannot be waited for, and adoption is the only answer.

Decide that before building either. Building adoption when a scheduled quiet-window restart would have done is a large amount of work for a case that never arises; building the cheap path and discovering it cannot survive an unplanned restart is the same lesson learned twice.

## Metadata

- **Complexity:** 6
- **Tags:** terminals, standalone, reliability, go, both-hosts, raspberry-pi

## User Review Required

None.

## Proposed Changes

### 1. The host publishes its identity where a successor can find it

On listen, write a state file — `port`, `token`, `protocolVersion`, `workspaceRoot`, `pid`, `startedAt` — mode **0600**, and remove it on clean exit. Keep the stdout handshake unchanged so a spawning parent still works; the file is the *additional* path, not a replacement.

**The token is now a credential on disk.** It already grants terminal I/O over the WebSocket, so it gets the same treatment as the board's own secrets: 0600, never in a repo, never in a log, never in a diagnostic dump.

**Per workspace, not global.** One box can run boards for several workspaces, each with its own fleet. Key the file by workspace root, or two boards adopt each other's terminals.

### 2. Adopt before spawn

On start the supervisor reads the state file, and only spawns when adoption fails:

1. **No file** → spawn.
2. **File present** → probe the endpoint with the token. No answer, wrong answer, or a timeout → treat as stale, remove the file, spawn.
3. **Answers, and `protocolVersion` matches what this board expects** → adopt. Do not spawn.
4. **Answers, and the version does not match** → do **not** adopt and do **not** silently use it. Stop that host, then spawn. A board driving a child that speaks an older frame format is how 2026-09-07 happened.
5. **Answers, but reports a different `workspaceRoot`** → never adopt. Log it and spawn nothing; something is misconfigured and guessing makes it worse.

**Probe, never trust the file.** A state file is a claim about a process that may be long dead, and its pid may since belong to something else. Verify by talking to the endpoint.

### 3. The child survives its parent, and is still stoppable

Detach the child so a board exit does not take it down, and remove the `SIGTERM`-on-stop from the ordinary shutdown path.

**It must not become immortal.** An orphan nothing can kill is worse than one that dies too eagerly. Give it an explicit lifecycle:

- `switchboard stop --fleet` (or equivalent) stops the host and its seats deliberately.
- Plain `switchboard stop` stops the **board** and leaves the fleet running — that is the whole point.
- `switchboard status` reports the fleet host separately: adopted or spawned, its pid, its uptime, its seat count.

An operator must always be able to answer "what is still running, and how do I stop it" without `pgrep`.

### 4. A systemd unit is the natural home on the Pi

Once the host is lifecycle-independent it is a service, and the apt/systemd installer work already in flight is where it belongs — start on boot, restart on failure, stop on command. That makes seats survive a reboot, not just a board restart.

Out of scope for this card, but design the state file and the stop verbs so a unit can drive them without a second mechanism.

## Edge-Case & Dependency Audit

1. **Version skew is the sharp edge.** An adopted host built before a board upgrade will speak the old wire format, and every one of the four framing faults found on 2026-09-07 was invisible until a human looked at a blank pane. `protocolVersion` must gate adoption, and a mismatch must be loud.
2. **Both hosts.** The extension host also spawns this child. If only standalone adopts, opening the extension against a running fleet spawns a second host on a second port, and two boards drive overlapping seats.
3. **A stale file with a reused pid.** Never signal a pid read from a file without first confirming the endpoint identifies itself as the pty host for this workspace.
4. **Seats outliving their board is a behaviour change.** A user who stops the board and expects the machine quiet will find CLIs still running and still billing tokens. `switchboard status` and the stop output must say so plainly.
5. **The adoption path must be exercised, not just written.** It runs only on the second start, which is exactly the path nobody tests. It needs a contract test that starts a host, discards the board, starts another, and asserts the same pid still owns the seats.
6. **Do not schedule a restart in this card.** Making restarts survivable and deciding to perform them are separate; the second needs the memory growth understood first.

## Verification Plan

1. Start a board, create three seats, kill the board process, start a new board: the **same** pty host pid still owns the **same** three seats, with scrollback intact and input working.
2. That second board reports the host as **adopted**, not spawned.
3. With no host running, a board start spawns one and reports it as spawned.
4. A state file pointing at a dead process is treated as stale, removed, and a fresh host spawned — no signal is ever sent to the recorded pid.
5. A host reporting a mismatched `protocolVersion` is not adopted; it is stopped and replaced, and the mismatch appears in the log.
6. A host reporting a different `workspaceRoot` is never adopted.
7. `switchboard stop` leaves the fleet running; the fleet-stop verb stops it; `switchboard status` distinguishes the two and names the pid.
8. The state file is mode 0600 and absent after a clean fleet stop.
9. Both hosts adopt. Opening the extension against a running standalone fleet does not spawn a second host.
