# The PTY Host Should Outlive the Board, Not Die With It

## Goal

The Go PTY host runs on its own lifecycle. A board restart — an upgrade, a crash, `switchboard stop`, a nightly cycle — leaves every seat running with its CLI context intact, and the board **adopts** the live host on start instead of spawning a new one.

### Problem analysis

**Today the fleet is a child process, so it dies with its parent.** `ptyHostSupervisor.ts:135` does `cp.spawn(executable, ['--workspace', root], { stdio: ['pipe','pipe',...] })` and `:169`/`:189` `SIGTERM` it on stop. Observed live: both pty hosts run with `ppid` equal to the Node board's pid. Restart the board and every terminal is destroyed.

> **Superseded:** "Today the fleet is a child process, so it dies with its parent" — stated as a process-tree consequence of `cp.spawn` + `SIGTERM`.
> **Reason:** The causal claim is incomplete. The fleet does not die merely because it is a child of the board; it dies because the Go binary **actively watches its parent and self-disposes**. `cmd/switchboard-pty-host/main.go:596-608` spawns a goroutine that polls `os.Getppid()` every 200ms and calls `f.dispose()` (kills every seat, closes the server) the instant the parent pid changes. On a board exit the orphaned child is reparented to init (pid 1 or a subreaper), `os.Getppid()` returns the new value within 200ms, and the watcher tears the fleet down — **before any successor board can run an adoption probe, and regardless of whether the spawn was detached or the `SIGTERM`-on-stop was removed**. This watcher is the dominant kill mechanism on the extension host, where `extension.ts:4594 deactivate()` never calls `supervisor.stop()` at all (it only disposes VS Code grid terminals), so the fleet dies there *exclusively* via the watcher, not via the `SIGTERM` the original paragraph targets. The observed fact (every terminal destroyed on restart) is correct; the *mechanism* named is only half of it.
> **Replaced with:** The fleet dies on board exit through **two independent mechanisms**: (1) the standalone host's explicit `instance.stop()` → `GoPtyFleetProjection.disposeAll()` (`goPtyFleetProjection.ts:477-483`) → `supervisor.stop()` (`ptyHostSupervisor.ts:189-193`) → `SIGTERM`; and (2) the Go binary's parent-death watcher (`main.go:596-608`) → `f.dispose()`, which fires on *any* parent-pid change including a crash, an `apt upgrade`, a reboot, or a detached spawn. Mechanism (2) is the only mechanism on the extension host and the only mechanism that fires on an ungraceful board exit. Any fix that addresses only (1) — detaching the spawn and removing `SIGTERM`-on-stop — leaves (2) intact and the fleet still dies. **The watcher must be gated or removed for the goal to be achievable at all.**

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

> **Superseded:** The citations below — `LocalApiServer.ts:1040-1052` for `isSeatAtRest`/`markSeatAtRest`, `:104` for the in-flight predicate, `bootstrap.ts:4363` and `TaskViewerProvider.ts:1744` for boot-time team autostart.
> **Reason:** The line numbers drifted. `LocalApiServer.ts:1040-1052` is a `CodingRoundRow` type definition; the seat-rest symbols are at `:1083-1099` (`markSeatAtRest`/`markSeatActive`/`isSeatAtRest`). `:104` is the comment header for `heldByTeam`, whose implementation is at `:120`. `bootstrap.ts:4363` is `resolveTeamPacing`; the boot-time autostart call is at `:4962-4977` (`taskViewerProvider.startTeamsOnLoad`). `TaskViewerProvider.ts:1744` is the `_headlessRuntime` block; the autostart path it documents is `startTeamForWorkspace` at `:13868`, whose docstring (`:13864`) names "the boot-time autostart pass" as one of its three callers. The substantive claim — every signal exists and the team re-seats itself unattended on the next start — is TRUE; only the citations were wrong.
> **Replaced with:** the corrected citations below.

- **`isSeatAtRest` / `markSeatAtRest`** (`LocalApiServer.ts:1085-1099`) — per-seat quiescence, already maintained on the completion path.
- **The in-flight predicate** `heldByTeam` (`LocalApiServer.ts:120-126`, header comment at `:103-119`) — *"true when card is held by a team member with no completion"*, already the guard the dispatch critical section uses.
- **Boot-time team autostart** (`bootstrap.ts:4969` `startTeamsOnLoad`; `TaskViewerProvider.ts:13868` `startTeamForWorkspace`, documented at `:13864` as the boot-time autostart caller) — the team re-seats itself on the next start, unattended.

So the whole mechanism is: refuse to restart unless every seat is at rest and no card is in flight; restart; let autostart bring the team back. No state file, no adoption, no detached child, no version negotiation — none of changes 1 to 3.

**Where it is not sufficient, and this is the real decision.** A coder's context is disposable by design; **a lead's is not**. The head accumulates feature-level state across its coders' subtasks — what it accepted, what it rejected, what it is still waiting on — and that is exactly what a re-seat destroys. Between features the loss is nil; mid-feature it is the thing that makes a team a team.

So:

- **If restarts are only ever taken between features**, the cheap path is enough and this card should be closed unbuilt.
- **If the board must survive an `apt upgrade`, a crash, or a reboot at an arbitrary moment** — which is what "always-on appliance" means — quiescence cannot be waited for, and adoption is the only answer.

Decide that before building either. Building adoption when a scheduled quiet-window restart would have done is a large amount of work for a case that never arises; building the cheap path and discovering it cannot survive an unplanned restart is the same lesson learned twice.

## Metadata

- **Complexity:** 7
- **Tags:** reliability, infrastructure, cli, security, backend

## User Review Required

None.

## Complexity Audit

### Routine

- Writing a 0600 JSON state file on listen and removing it on clean exit — straightforward `os.WriteFile`/`os.Remove` in the Go binary.
- Reading the state file and probing the endpoint with the bearer token in the TS supervisor — extends the existing `httpRequest` pattern already used by `request()`.
- Keeping the stdout handshake unchanged (the file is an *additional* path) — no wire-protocol change.
- The quiescence-gated restart alternative (the "cheaper path") reuses only existing symbols; if chosen, the work is a guard plus autostart, both already present.

### Complex / Risky

- **The parent-death watcher (`main.go:596-608`) is the load-bearing change and the plan's original change #3 does not touch it.** Gating it (via `--survive-parent`, only when `terminal.fleet.surviveBoard` is true) is a behaviour change to the Go binary that both hosts depend on, and it must be done in lockstep with detaching the spawn — otherwise the watcher disposes the fleet the moment the board exits, defeating adoption before the successor's probe runs.
- **Two composition roots must wire the new adoption + identity seams identically** (`src/extension.ts:1001` and `src/standalone/bootstrap.ts:1482` both instantiate `PtyHostSupervisor`). The CLAUDE.md "standalone and extension MUST NOT diverge" rule applies: the adoption probe, the state-file path resolution, the `surviveBoard` setting read, and any new `/health` identity seam must land in both roots in the same diff.
- **`/health` (`LocalApiServer.ts:11817-11846`) reports the board's `pid`, not the pty host's.** Surfacing "adopted vs spawned, host pid, uptime, seat count" on `switchboard status` and the Config tab requires a new composition seam (e.g. `getPtyHostIdentity`) wired in both roots — a classic divergence trap.
- **The token becomes a credential on disk.** It already grants terminal I/O over the WebSocket; 0600 is necessary but not sufficient — it must never appear in logs, diagnostic dumps, or the `switchboard status` output.
- **Opt-in survival is a deliberate default choice.** Defaulting `surviveBoard` to false preserves today's behaviour (fleet dies with the board) so the behaviour change only affects users who explicitly turn it on. The risk is inverted from the original plan: the danger is now a user who turns it on, forgets, and finds seats billing tokens after they stopped the board — mitigated by the Config tab's stop button and status readout.
- **Version-skew adoption gate.** An adopted host built before a board upgrade speaks the old wire format; the four framing faults of 2026-09-07 were invisible until a human looked at a blank pane. `protocolVersion` must gate adoption and a mismatch must be loud (stop-and-replace, never silent use).
- **The Config tab is a UI change to the terminals panel.** A third tab (`data-tab="config"`) alongside Agents and tmux, following the existing `shared-tab-btn`/`shared-tab-content` pattern. Low risk mechanically (the pattern is established), but it is the user-facing surface for the survival switch and the stop button — the stop button must have no confirm dialog (CLAUDE.md rule) and must report its result inline.

## Edge-Case & Dependency Audit

1. **Version skew is the sharp edge.** An adopted host built before a board upgrade will speak the old wire format, and every one of the four framing faults found on 2026-09-07 was invisible until a human looked at a blank pane. `protocolVersion` must gate adoption, and a mismatch must be loud.
2. **Both hosts.** The extension host also spawns this child (`extension.ts:1001`). If only standalone adopts, opening the extension against a running fleet spawns a second host on a second port, and two boards drive overlapping seats. The adoption path and the identity seam must be wired in `extension.ts` and `bootstrap.ts` in the same change.
3. **A stale file with a reused pid.** Never signal a pid read from a file without first confirming the endpoint identifies itself as the pty host for this workspace.
4. **Seats outliving their board is an opt-in behaviour change.** Default off, the fleet dies with the board (today). When `terminal.fleet.surviveBoard` is on, a user who stops the board and expects the machine quiet will find CLIs still running and still billing tokens. The Config tab's status readout and the `switchboard status` `surviveBoard` field must say so plainly, and the stop button / `--fleet` verb must be the obvious way to stop the fleet.
5. **The adoption path must be exercised, not just written.** It runs only on the second start, which is exactly the path nobody tests. It needs a contract test that starts a host, discards the board, starts another, and asserts the same pid still owns the seats.
6. **Do not schedule a restart in this card.** Making restarts survivable and deciding to perform them are separate; the second needs the memory growth understood first.
7. **The parent-death watcher must be gated, not just worked around.** Detaching the spawn and removing `SIGTERM`-on-stop leaves `main.go:596-608` intact; it still calls `f.dispose()` within 200ms of any board exit. The watcher is the mechanism that makes "the host outlives the board" false today, and it is the one line of Go the original plan never named.
8. **`/health` identity is a new seam, not an extension of an existing field.** `LocalApiServer.ts:11835` reports `pid: process.pid` (the board). The pty host's pid/uptime/source must come from a new callback wired at both composition roots; reusing the `pid` field would make an adopted host's pid indistinguishable from the board's.

## Dependencies

- None. This plan touches the Go PTY host binary, the shared `PtyHostSupervisor`, and both composition roots; no other plan's output is a prerequisite.

## Adversarial Synthesis

Key risks: (1) the parent-death watcher in `main.go:596-608` is the actual kill mechanism the original plan never names — detaching the spawn without gating it leaves the fleet dying on every board exit, so adoption's success check stays red while every sub-change looks green; (2) the two composition roots (`extension.ts:1001`, `bootstrap.ts:1482`) must wire the adoption probe, state-file path, `surviveBoard` setting read, and any new `/health` identity seam in lockstep, or the extension host silently re-spawns a second fleet against a running standalone one; (3) the token becomes a 0600 credential on disk that already grants terminal I/O; (4) the original plan defaulted to always-on survival — a behaviour change most users did not ask for, leaving seats billing tokens after a board stop with no obvious way to notice. Mitigations: gate the watcher behind `--survive-parent` (only when `surviveBoard` is true) as part of change #3, not as a follow-up; default `surviveBoard` to false so the default is no behaviour change; surface the switch and a stop button in a Config tab (change #6) so the operator who opts in can see the fleet state and stop it without `pgrep`; land both roots in one diff with a parity check on the seams; never log/dump the token and never surface it on `switchboard status`.

## Proposed Changes

### 1. The host publishes its identity where a successor can find it

On listen, write a state file — `port`, `token`, `protocolVersion`, `workspaceRoot`, `pid`, `startedAt` — mode **0600**, and remove it on clean exit. Keep the stdout handshake unchanged so a spawning parent still works; the file is the *additional* path, not a replacement.

**The token is now a credential on disk.** It already grants terminal I/O over the WebSocket, so it gets the same treatment as the board's own secrets: 0600, never in a repo, never in a log, never in a diagnostic dump, never in `switchboard status` output.

**Per workspace, not global.** One box can run boards for several workspaces, each with its own fleet. Key the file by workspace root (e.g. a hash of the absolute root under a per-user runtime dir), or two boards adopt each other's terminals.

**Implementation surface (Go):** `cmd/switchboard-pty-host/main.go` — write the file right after the `fmt.Printf` ready line at `:586`; remove it in the `term`/`stdin-EOF`/`server.Close` teardown paths at `:590-608`. The `ptyhost.Ready` struct already carries `Version`, `Port`, `Token` (`main.go:586`); add `workspaceRoot`, `pid`, `startedAt` to the file payload (not necessarily to the stdout handshake).

### 2. Adopt before spawn

On start the supervisor reads the state file, and only spawns when adoption fails:

1. **No file** → spawn.
2. **File present** → probe the endpoint with the token. No answer, wrong answer, or a timeout → treat as stale, remove the file, spawn.
3. **Answers, and `protocolVersion` matches what this board expects** → adopt. Do not spawn.
4. **Answers, and the version does not match** → do **not** adopt and do **not** silently use it. Stop that host, then spawn. A board driving a child that speaks an older frame format is how 2026-09-07 happened.
5. **Answers, but reports a different `workspaceRoot`** → never adopt. Log it and spawn nothing; something is misconfigured and guessing makes it worse.

**Probe, never trust the file.** A state file is a claim about a process that may be long dead, and its pid may since belong to something else. Verify by talking to the endpoint. The probe must require the endpoint to identify itself as the pty host for *this* workspace (return its `workspaceRoot` and `protocolVersion` on the probe), so a reused pid answering a different service is never mistaken for the fleet.

**Implementation surface (TS, both roots):** `src/services/ptyHostSupervisor.ts` — add an `adopt()` path before the `cp.spawn` at `:135`. The probe reuses the `httpRequest` pattern from `request()` (`:182`). Both `src/extension.ts:1001` and `src/standalone/bootstrap.ts:1482` construct `PtyHostSupervisor` with the same options shape; the state-file path must resolve identically in both (derive from `workspaceRoot`, not from a host-specific root).

### 3. Survival is opt-in; the default is today's behaviour

> **Superseded:** "Detach the child so a board exit does not take it down, and remove the `SIGTERM`-on-stop from the ordinary shutdown path" — committing to always-on survival as the default.
> **Reason:** An always-on Go process, however small, is a behaviour change most users did not ask for: seats keep running and keep billing CLI tokens after the board stops, with no obvious way to notice. Defaulting to survival inverts the user's mental model of "stop the board = the machine goes quiet." The original change #3 also under-specified the stop path (it said "a new CLI arm that hits a new endpoint or sends the stop signal to the recorded pid" — but the endpoint is dead once the board is down, so only the pid-signal path actually works post-stop) and left the extension host with no stop verb at all.
> **Replaced with:** survival is **opt-in** via a config setting surfaced in a new **Config** tab in the terminals panel (change #6). Default off = today's behaviour (fleet dies with the board via the parent-death watcher). Opt-in = the fleet survives and is adopted by the next board start.

**The config setting is the single switch.** A new `terminal.fleet.surviveBoard` boolean (default `false`), read by both composition roots at supervisor construction time. When `false`:

- The spawn stays attached (`detached: false`), the `SIGTERM`-on-stop stays in `instance.stop()` (`bootstrap.ts:4986-4999` → `goPtyFleetProjection.ts:481` → `supervisor.stop()`), and the Go parent-death watcher (`main.go:596-608`) stays active. Today's behaviour, unchanged.
- The adoption probe (change #2) still runs on start — but with the watcher active, no fleet survives to be adopted, so the probe always finds nothing and spawns. This is correct: the default is no behaviour change.

When `true`:

- **(a) Detach the spawn.** `ptyHostSupervisor.ts:135` — spawn with `detached: true`, drop the stdout pipe after the ready handshake (the state file is the post-startup rendezvous).
- **(b) Remove `SIGTERM`-on-stop from the ordinary path.** `instance.stop()` (`bootstrap.ts:4986-4999`) must **not** call `GoPtyFleetProjection.disposeAll()` (`goPtyFleetProjection.ts:477`) on the plain stop path — only the explicit fleet-stop verb does.
- **(c) Gate the parent-death watcher.** `cmd/switchboard-pty-host/main.go:596-608` — the `os.Getppid()` poll is disabled when the host is started with `--survive-parent` (passed by the supervisor when `terminal.fleet.surviveBoard` is true). Without this, (a) and (b) do nothing: the watcher disposes the fleet within 200ms of the board exiting.

**The stop path, fully specified.** The plan's original "new endpoint or sends the stop signal" was wrong — the endpoint is dead when the board is down. The real path:

- `switchboard stop --fleet` (standalone, `src/standalone/cli.ts`) reads the state file (change #1) for the pid, sends `SIGTERM` to that pid directly. Does **not** go through the board's API. This works whether the board is up or down.
- Plain `switchboard stop` stops the **board** only. When `surviveBoard` is false, the board's stop (or the watcher) takes the fleet with it — today's behaviour. When `surviveBoard` is true, the fleet survives and `--fleet` is the only way to stop it.
- `switchboard status` reports the fleet host separately: adopted or spawned, its pid, its uptime, its seat count, and **whether `surviveBoard` is on** so the operator knows whether to expect a surviving fleet.
- **Extension host stop.** The extension has no `switchboard stop` CLI. Add a **VS Code command** (`switchboard.stopFleet`) registered in `src/extension.ts`, callable from the Command Palette and surfaced as a button in the Config tab (change #6). It reads the state file and sends `SIGTERM` to the pid — same mechanism as the standalone `--fleet` verb. Without this, an extension user who turns on `surviveBoard` has no way to stop the fleet except `kill <pid>`.

**It must not become immortal.** An orphan nothing can kill is worse than one that dies too eagerly. The stop verbs above are the deliberate lifecycle; the state file (change #1) is how they find the pid without `pgrep`.

**Extension-host parity.** Both hosts read the same `terminal.fleet.surviveBoard` setting, both wire the adoption probe (change #2), both wire the identity seam (change #4), and both expose a stop-fleet path (CLI verb for standalone, VS Code command for extension). The "Both hosts" audit item (#2) is satisfied only when both roots adopt and both roots can stop.

### 4. Surface the fleet host identity on `switchboard status`

`/health` (`LocalApiServer.ts:11817-11846`) currently reports `pid: process.pid` — the **board's** pid — and has no field for the pty host. To make `switchboard status` report "adopted vs spawned, host pid, uptime, seat count", add a new composition seam (e.g. `getPtyHostIdentity`) to `LocalApiServerOptions`, wire it in **both** `src/extension.ts` and `src/standalone/bootstrap.ts`, and surface it on `/health` (or a sibling endpoint) consumed by `cmdFleet`/`cmdStatus` in `src/standalone/cli.ts`. Do **not** reuse the existing `pid` field — an adopted host's pid must be distinguishable from the board's, or `switchboard status` reports the wrong process.

### 5. A systemd unit is the natural home on the Pi

Once the host is lifecycle-independent it is a service, and the apt/systemd installer work already in flight is where it belongs — start on boot, restart on failure, stop on command. That makes seats survive a reboot, not just a board restart.

Out of scope for this card, but design the state file and the stop verbs so a unit can drive them without a second mechanism. With the parent-death watcher gated (change #3c), a systemd unit can own the host's lifecycle directly; with the watcher still active, a unit restart would race the watcher's self-dispose, so #3c is also a prerequisite for this future work.

### 6. A Config tab in the terminals panel — the survival switch and the stop button

The terminals panel today has two tabs: **Agents** and **tmux** (`terminals.html:3017-3020`, switched by `setActiveTerminalTab` in `terminals.js:827-842`). Add a third: **Config**, following the exact same `shared-tab-btn` / `shared-tab-content` pattern.

**What lives in the Config tab:**

- **"Survive board restart" toggle** — the UI for `terminal.fleet.surviveBoard` (change #3). A checkbox, default unchecked, with a one-line hint: *"When on, the PTY host keeps running after the board stops, so seats survive a restart. The host is adopted by the next board start. Turn off to stop the fleet with the board."* Persisted via the same `saveSetting`/`loadSetting` path the tmux toggle uses (`terminals.js:789-805`). Takes effect on the next board start (the supervisor reads it at construction time, not live).
- **"Stop fleet" button** — calls the fleet-stop path. On standalone, POSTs to a new endpoint or shells out to `switchboard stop --fleet`. On the extension, invokes the `switchboard.stopFleet` VS Code command (change #3). Reads the state file for the pid, sends `SIGTERM`. Reports the result inline ("fleet stopped" / "no fleet running" / "stop failed: <error>"). No confirm dialog (CLAUDE.md rule).
- **Fleet status readout** — adopted or spawned, host pid, uptime, seat count, and the `surviveBoard` state. Sourced from the `/health` identity seam (change #4). This is the operator's answer to "what is still running" without leaving the panel.

**Implementation surface:**

- `src/webview/terminals.html:3017-3020` — add `<button class="shared-tab-btn" data-tab="config">Config</button>` and a `<div class="shared-tab-content" data-tab-content="config" id="config-tab-content">` block alongside the agents and tmux content divs.
- `src/webview/terminals.js:827-842` — extend `setActiveTerminalTab`'s guard (`if (tab !== 'agents' && tab !== 'tmux')`) to accept `'config'`, and add a `refreshConfigTab()` call (mirrors `refreshTmuxTab()` at `:841`).
- `src/webview/terminals.js:852-856` — extend the persisted-tab restore to accept `'config'`.
- A new `refreshConfigTab()` function — fetches fleet status from `/health` (or the sibling endpoint from change #4), renders the toggle + stop button + status readout. Mirrors `refreshTmuxTab()`'s shape.
- The toggle's `saveSetting` call writes `terminal.fleet.surviveBoard`; the stop button calls the stop-fleet path (CLI verb or VS Code command depending on host).

**Why a tab, not a settings page entry.** The tmux seating toggle already lives in the tmux tab (`terminals.html:3158-3163`), not in the Setup panel — because it is a runtime fleet concern, not a one-time configuration. Fleet survival is the same category: the operator wants to see and change it next to the seats it affects, not buried in Setup. A third tab is the established pattern.

## Verification Plan

> NOTE: Per the dispatching directive for this run, the checks below are **written down but not executed** — no compilation and no automated tests are run in this pass. They remain the acceptance bar for the implementer.

### Automated Tests

1. **Default off = no behaviour change.** With `terminal.fleet.surviveBoard` unset/false, start a board, create three seats, kill the board, start a new board: a **fresh** pty host is spawned (the old one died with the board via the watcher). The new board reports the host as **spawned**, not adopted. This is today's behaviour, preserved.
2. **Opt-in survival.** Set `terminal.fleet.surviveBoard` to true, start a board, create three seats, kill the board process, start a new board: the **same** pty host pid still owns the **same** three seats, with scrollback intact and input working. (This fails against the current binary until change #3c — the parent-death watcher — is gated.)
3. That second board reports the host as **adopted**, not spawned.
4. With no host running, a board start spawns one and reports it as spawned (regardless of the `surviveBoard` setting — there is nothing to adopt).
5. A state file pointing at a dead process is treated as stale, removed, and a fresh host spawned — no signal is ever sent to the recorded pid.
6. A host reporting a mismatched `protocolVersion` is not adopted; it is stopped and replaced, and the mismatch appears in the log.
7. A host reporting a different `workspaceRoot` is never adopted.
8. `switchboard stop` (standalone) with `surviveBoard` false stops both board and fleet (today's behaviour). With `surviveBoard` true, `switchboard stop` stops the board only; `switchboard stop --fleet` stops the fleet by reading the state file and signalling the pid; `switchboard status` distinguishes the two, names the pid, and reports the `surviveBoard` state.
9. The state file is mode 0600 and absent after a clean fleet stop.
10. Both hosts adopt. Opening the extension against a running standalone fleet does not spawn a second host.
11. The parent-death watcher does not dispose the fleet when the board exits with `surviveBoard` true (regression guard for change #3c).
12. **Config tab.** The terminals panel renders a third "Config" tab alongside Agents and tmux. The "Survive board restart" toggle persists `terminal.fleet.surviveBoard` and takes effect on the next board start. The "Stop fleet" button stops a running fleet and reports the result; with no fleet running it reports "no fleet running." No confirm dialog appears on the stop button.
13. **Extension stop-fleet command.** `switchboard.stopFleet` (VS Code command) stops a running fleet by reading the state file and signalling the pid, the same mechanism as the standalone `--fleet` verb.

### Goal Invariants

- Assert `cmd/switchboard-pty-host/main.go` has no unconditional `f.dispose()` reachable from an `os.Getppid()` change when the host is started with `--survive-parent` (the watcher is gated when survival is on).
- Assert `src/services/ptyHostSupervisor.ts` `start()` reads a state file and probes the recorded endpoint before any `cp.spawn` call (adoption precedes spawn).
- Assert `src/extension.ts` and `src/standalone/bootstrap.ts` both read `terminal.fleet.surviveBoard` and both wire the adoption probe and the pty-host-identity seam (count of roots wiring each seam equals 2).
- Assert the state file is created with mode `0o600` and is absent after a clean fleet stop (present on listen, removed on fleet stop, absent on plain board stop when `surviveBoard` is false).
- Assert the pty host's `pid` surfaced on `/health` is distinct from the board's `process.pid` (the two fields are not aliased).
- Assert `switchboard stop` with `surviveBoard` false calls `GoPtyFleetProjection.disposeAll()` / `supervisor.stop()` (today's behaviour); assert `switchboard stop` with `surviveBoard` true does **not** call it (negative invariant — the plain stop leaves the fleet running), paired with the positive: `switchboard stop --fleet` does signal the pid and the fleet is gone afterwards.
- Assert `src/webview/terminals.html` has a `data-tab="config"` button and a `data-tab-content="config"` content div alongside the existing `agents` and `tmux` entries.
- Assert `src/webview/terminals.js` `setActiveTerminalTab` accepts `'config'` and the persisted-tab restore honours it.

## Outstanding Questions

- None. The user confirmed the cheaper, quiescence-gated restart path is **not** sufficient — the always-on-appliance case (unplanned `apt upgrade`/crash/reboot) is real, and opt-in adoption (this plan, behind `terminal.fleet.surviveBoard`) is the required path. The "cheaper alternative" section above is retained as analysis but is not the chosen approach.

## Implementation Summary

Implemented opt-in PTY host lifecycle independence and successor adoption across both standalone and extension composition roots (`terminal.fleet.surviveBoard`). Added `--survive-parent` flag and `0600` `.switchboard/pty-host-state.json` state recording to `switchboard-pty-host` with gated parent-death and stdin watchers. Updated `PtyHostSupervisor` to probe and adopt running PTY hosts on boot, surfaced host identity on `/health`, wired `switchboard.stopFleet` command and `switchboard stop --fleet`, and added the Config tab in the terminals panel with the survival toggle, stop button, and live status readout without confirmation dialogs.

