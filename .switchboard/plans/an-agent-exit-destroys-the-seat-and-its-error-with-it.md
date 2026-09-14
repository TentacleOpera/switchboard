# An Agent Exit Destroys the Seat and Its Error With It

## Goal

When an agent process dies, the seat must survive long enough to show why. Today the agent's
exit takes the tmux window, the window's death takes the session, the session's death takes
every grouped view, and the pty exits — so the operator is left with `[exited]` and the reason
scrolls into a destroyed pane.

### Problem analysis

**Observed 2026-09-11, planner-4.** The operator pressed Clear on a live Devin seat. The seat
vanished. What the panel showed was its own startup command and the word `[exited]` — no error,
no agent output, nothing to act on.

The reason was recoverable only from the terminal log, which is written independently of the
pane:

```
/clear                  Clear conversation history
Resume this session with `devin -r tame-lavender`…
⡆ Creating new session... · 0s (esc twice to interrupt)
Error: failed to start the ACP agent child
>[exited]
```

What is ESTABLISHED is the sequence above: `/clear` was accepted, Devin ended the session, it
began creating a new one, the creation failed, and the process exited.

What is INFERRED — and flagged as such rather than asserted — is the mechanism: Devin appears to
run its agent in a child process spoken to over ACP, which `/clear` tears down and respawns.
The support is that the error names an "ACP agent child" and that `devin --help` exposes
`acp  Run as an ACP (Agent Client Protocol) server over stdio` as a subcommand. This is a
reading of a third-party CLI's internals, not something this project verified, and **nothing in
Switchboard's configuration or its startup command (`devin --permission-mode bypass`) enables
it** — it is how Devin is built. Do not design around the inference without confirming it.

**The cascade is the product's, not the agent's.** A seat's startup command ends in
`exec tmux attach -t <view>`, and the seat is one window in a one-window session:

1. the agent exits, so the window's command is gone and tmux closes the window
2. that was the session's only window, so tmux destroys `lc-planner-4`
3. the view is a GROUPED session (`new-session -t <base>`), so it dies with its base
4. `exec tmux attach` has nothing to attach to and returns, so the pty exits

Each step is correct tmux behaviour. Composed, they mean **one agent crash erases the surface
that would have explained it.** `tmux ls` afterwards showed every other seat healthy —
planner-1/2/3, analyst-1, reviewer-1, each with one window — and `lc-planner-4` simply absent.

**This is not resource pressure.** Measured at the time: 10 GB available, 347 processes, 1,365
threads against a 111,919 limit, fd limit 1,048,576. Nothing was exhausted.

**Why it matters more than one lost pane.** The seat is where an operator looks. A failure that
destroys its own evidence trains the operator to treat agent deaths as unexplainable, and the
log is not an equivalent surface — nothing in the UI points at it, and finding the right file
among 293 MB of logs required knowing the seat name and the session timestamp.

**This cascade is standalone-only.** The extension host (`src/extension.ts`) does not
instantiate `GoPtyFleetProjection` and does not wire `setTmuxSeatingResolver`; it creates
terminals via `_ptyHostSupervisor.request('ptyCreateTerminal', ...)` which spawns a bare login
shell (`shell -l`, `main.go:144`) and sends the startup command as text via `ptyWrite`. The
agent runs as a child of the shell, not as `exec`, so when the agent exits the shell survives
and the pane persists. The tmux wrapping — and the cascade it enables — exists only in
`goPtyFleetProjection.ts:257-308`, exercised exclusively by the standalone host's
`GoPtyFleetProjection.create()`.

### Root cause

Seat lifetime is coupled to agent lifetime by construction. `exec` replaces the shell so there
is no process left to report an exit status; a one-window session means the window's death is
the session's death; and a grouped view inherits that death. Nothing in the chain was designed
to outlive the agent, because the agent exiting was treated as the seat ending rather than as
an event the seat should report.

### Non-goals

- Fixing Devin's ACP spawn failure. That is the agent's defect and is out of scope here;
  `/clear` on Devin has its own card.
- Changing what Clear sends. `clearPty` writes Ctrl+U, `/clear`, CR and behaved correctly.
- Reaping orphaned tmux sessions. Covered by
  `tmux-windows-duplicate-on-re-seat-and-nothing-reaps-orphaned-sessions.md`; this board had no
  orphans — every session held exactly one window.

## Metadata

**Feature:** 44798142-bd27-4408-9f95-9873c781dcef
**Complexity:** 5
**Tags:** reliability, ux, infrastructure, backend, bugfix

## User Review Required

None.

## Complexity Audit

### Routine

- Adding `remain-on-exit on` to the tmux session creation in the startup command builder (`goPtyFleetProjection.ts:257-308`). One `set-option` line in an existing command string, set at the session level before window creation.
- The tmux session structure (base + grouped view) already survives when the window survives — no structural change needed once the window stops dying on agent exit.
- Neighbour seats are unaffected: each seat is its own window in a shared base session, and `remain-on-exit` is a session-level default that applies to new windows without touching siblings' existing panes.

### Complex / Risky

- **Liveness regression — the load-bearing risk.** `remain-on-exit` keeps the pty alive (tmux attach does not exit), so the Go pty host (`main.go:186-216`, `readOutput`) never sees EOF and the fleet reports the seat as `active` indefinitely. The board would show a dead agent as healthy — worse than today's `[exited]`, which at least signals death. Detecting the agent's death independently of the pty's death requires a new mechanism: a periodic `tmux list-panes -F '#{pane_dead} #{pane_dead_status}'` check in the fleet's refresh/reconcile path. This is a stopgap until control-mode (`switch-seats-to-control-mode...`) makes pane-death an event.
- **Exit code capture.** The Go pty host hardcodes `code: 0` on every exit (`main.go:209`, `main.go:271`). The real exit code of the shell/tmux process is available via `cmd.ProcessState.ExitCode()` but never read. Reporting a meaningful exit status requires changing the Go host, and the agent's exit code (inside tmux) is only reachable via `#{pane_dead_status}` in the pane-death check — not from the pty's own process state.
- **Restart path.** A `remain-on-exit` pane is dead — keystrokes do not reach the agent. Restarting requires `tmux respawn-pane -k -t <target> <command>` or a kill-and-recreate flow. The fleet's `create()` currently cannot respawn an existing dead pane; it creates new windows. The restart path must reuse the existing window name so seat identity is preserved.

## Edge-Case & Dependency Audit

**Race Conditions:**
- `remain-on-exit` must be set on the session BEFORE the agent's window is created, or a fast-exiting agent (the Devin ACP spawn failure exits in <1s) could close the window before the option is applied. The startup command builder creates the window with `new-session -d -s ${session} -n ${win} ${inner}` (the agent starts immediately) and then runs subsequent `set-window-option` commands. If the agent exits between window creation and a per-window `remain-on-exit` being set, the window is already gone. Fix: set `remain-on-exit` as a session-level option (`set-option -t ${session} remain-on-exit on`) before the `has-session` / `new-window` / `new-session` branch, so it inherits to all new windows at creation time.

**Security:**
- No new attack surface. `remain-on-exit` is a tmux display option; it does not accept user input or change process ownership. The `respawn-pane` restart path reuses the existing `${inner}` (already `JSON.stringify`-escaped at `goPtyFleetProjection.ts:233`), so no new interpolation surface.

**Side Effects:**
- A dead pane persists in the tmux session until explicitly respawned or killed. The base session's window count no longer drops to zero on agent death, so `tmux ls` shows the session as alive — which is the goal, but means orphan-reaping logic (`tmux-windows-duplicate-on-re-seat...`) must not treat a dead-pane window as a live seat.
- The pane-death poll adds a tmux invocation per seated terminal per refresh cycle. With the existing 2s TTL on `isTmuxAvailable` (`tmuxBackend.ts:138`), the poll should ride the same cadence, not a tighter one.

**Dependencies & Conflicts:**
- `switch-seats-to-control-mode-and-repoint-the-three-consumers.md` — control mode would emit `pane_dead` events natively, solving the liveness detection problem without polling. If control mode lands first, this plan's liveness-detection work is subsumed. If this plan lands first, the liveness detection is a stopgap that control mode replaces.
- `tmux-windows-duplicate-on-re-seat-and-nothing-reaps-orphaned-sessions.md` — reaping logic must distinguish "dead pane (remain-on-exit, session alive)" from "no window (session destroyed)".

## Dependencies

- `switch-seats-to-control-mode-and-repoint-the-three-consumers.md` — the control-mode cutover would make pane-death detection native; this plan's liveness stopgap is interim until that lands.
- `tmux-windows-duplicate-on-re-seat-and-nothing-reaps-orphaned-sessions.md` — reaping logic must be updated to handle dead-but-present panes (session alive, window dead).

## Adversarial Synthesis

Key risks: (1) `remain-on-exit` keeps the pty alive so the fleet reports a dead agent as `active` — a liveness regression worse than today's `[exited]`; (2) the plan's "supervising shell in place of `exec`" option does not preserve the error because the error is inside the destroyed tmux pane, not the pty shell; (3) the "Both hosts" verification was wrong — the cascade is standalone-only because the extension does not use tmux seating. Mitigations: set `remain-on-exit` as a session option before window creation; pair it with a pane-death detection poll; supersede the pty-level supervising shell; correct the verification scope to standalone-only.

## Proposed Changes

### `src/services/goPtyFleetProjection.ts` — the startup command builder (lines 230-308)

**Context:** The startup command builder constructs a tmux command string that creates a base session with the agent as the window's command (`new-session -d -s ${session} -n ${win} ${inner}`), creates a grouped view session, configures the view (status off, prefix None, aggressive-resize), and ends with `exec tmux attach -t ${view}`. When the agent exits, the window dies (no `remain-on-exit`), the session dies, the view dies, and the pty exits.

**Implementation:**

1. **Set `remain-on-exit` as a session option before window creation.** Insert `tmux set-option -t ${session} remain-on-exit on;` before the `tmux has-session` / `new-window` / `new-session` branch (before line 258). Setting it at the session level (not per-window) ensures it inherits to every new window at creation time, closing the race where a fast-exiting agent closes the window before a per-window option is applied. This is the primary fix: the pane freezes at the agent's last output, the session survives, the view survives, and `tmux attach` stays connected — so the pty stays alive and the operator sees the error in the pane.

2. **Supersede the pty-level supervising shell option.** The plan's original proposal #1 mentioned "a supervising shell in place of `exec`" as a co-equal alternative. This does not preserve the error:

   > **Superseded:** A supervising shell in place of `exec` (running `tmux attach` without `exec` so the pty's shell survives).
   > **Reason:** The error is inside the tmux pane, not the pty shell. When the agent exits and the tmux window dies, the tmux session is destroyed and the pane content is gone. A surviving pty shell shows a bare prompt — the error is lost. Only `remain-on-exit` (which keeps the tmux pane itself alive) preserves the error.
   > **Replaced with:** `remain-on-exit` at the session level. The tmux pane freezes at the agent's last output, the session survives, the view survives, and `tmux attach` stays connected — so the pty stays alive and the operator sees the error in the pane.

3. **Add pane-death detection (liveness stopgap).** The Go pty host never sees EOF when `remain-on-exit` keeps the pty alive, so the fleet reports the seat as `active`. Add a periodic check in the fleet's `refresh()` / `reconcile()` path that runs `tmux list-panes -t ${session} -F '#{pane_dead} #{pane_dead_status} #{pane_id}'` and marks the terminal's status as `exited` (with the dead status code from `#{pane_dead_status}`) when `pane_dead` is `1`. This is a stopgap until control-mode (`switch-seats-to-control-mode...`) makes pane-death an event instead of a poll.

4. **Add a restart verb.** Add a `ptyRespawnPane` verb (or extend `ptyClearTerminal` with a respawn mode) that runs `tmux respawn-pane -k -t ${view}:${win} ${inner}` to restart the agent in the dead pane. The fleet's `create()` currently cannot respawn an existing dead pane — it creates new windows. The restart path must reuse the existing window name so the seat identity is preserved. The `${inner}` command is already available in the terminal handle's `startupCommand` field (set at `goPtyFleetProjection.ts:336`).

### `cmd/switchboard-pty-host/main.go` — exit code capture (lines 186-216, 261-280)

**Context:** `readOutput` (line 186) sets `status = "exited"` and broadcasts `{t: "exit", code: 0}` on EOF — the exit code is hardcoded. `close` (line 261) does the same. The real exit code of the shell/tmux process is available via `cmd.ProcessState.ExitCode()` but never read.

**Implementation:**

5. **Capture the real exit code.** In `readOutput`, after the read loop exits (line 200-214), call `cmd.Wait()` (if not already called) and read `cmd.ProcessState.ExitCode()`. Include it in the exit broadcast instead of the hardcoded `0`. Note: with `remain-on-exit`, the pty does not exit on agent death, so this only fires when the pty itself dies (operator kill, board shutdown). The agent's exit code is captured by the pane-death detection (change #3) via `#{pane_dead_status}`, not from the pty's own process state.

### `src/webview/terminals.js` — render the dead state (lines 420, 1587, 2559, 3461)

**Context:** The webview renders `status === 'exited'` as `(exited)` and shows "Terminal has exited" toast. With `remain-on-exit`, the fleet status stays `active` (the pty is alive) until the pane-death detection (change #3) marks it otherwise. Once marked, the webview must distinguish "dead agent, live pane" from "dead terminal."

**Implementation:**

6. **Render a "dead agent" state distinct from "exited terminal".** When the pane-death detection (change #3) marks the terminal as `exited` (or a new `agent_dead` status), the webview should show the seat as dead with the last output still visible in the pane, not as `(exited)` (which implies the terminal is gone). The distinction matters: the pane is still rendered (the error is visible), the terminal is still connected, and a restart is possible via the restart verb (change #4). The `(exited)` suffix at line 3466 and the "Terminal has exited" toast at line 2560 should be replaced with a "Agent exited — restart" affordance for this state.

### `src/standalone/bootstrap.ts` — wire the liveness detection (composition root)

**Context:** The standalone host's `handlePtyVerb` and the fleet's `refresh()` / `reconcile()` path are where the pane-death check would run. This is a composition-root wiring — the extension does not need it because it does not use tmux seating.

**Implementation:**

7. **Wire the pane-death poll into the fleet refresh.** The `GoPtyFleetProjection.refresh()` method (or a new timer riding the `isTmuxAvailable` 2s TTL) should periodically check `#{pane_dead}` for tmux-seated terminals and update their status. This is the standalone-only composition-root seam. The extension host does not wire this because it does not use `GoPtyFleetProjection` or tmux seating — its seats are bare shells where the agent's exit does not destroy the pane.

## Verification Plan

- **Agent crash, seat survives:** kill an agent inside a seat. Assert the pane still renders,
  shows the final output, and states the exit — never a bare `[exited]`.
- **Error is readable in the UI:** reproduce a failed agent start and assert its stderr reaches
  the panel without opening a log file.
- **Neighbours unaffected:** assert one seat's agent dying leaves every other seat attached, as
  observed here.
- **Restart path:** assert a dead seat can be restarted from the panel via the respawn verb
  without recreating the team.
- **Dead agent not reported as active:** assert the fleet status reflects the agent's death
  within a bounded interval (≤ 2 refresh cycles) after `remain-on-exit` preserves the pane.
  Without this, `remain-on-exit` makes the liveness lie worse, not better.
- **Standalone host:** the seating chain is built in `goPtyFleetProjection.ts:257-308`; assert
  the standalone host preserves the pane and detects the death. The extension host does not use
  tmux seating (no `GoPtyFleetProjection` instantiation, no `setTmuxSeatingResolver` wiring),
  so the cascade does not occur there and this fix does not apply.

> **Superseded:** the original verification item "Both hosts: the seating chain is built in `goPtyFleetProjection`; assert the extension and standalone hosts behave identically."
> **Reason:** The extension does not use `GoPtyFleetProjection` — it creates terminals via `_ptyHostSupervisor.request('ptyCreateTerminal', ...)` which spawns a bare shell without tmux wrapping. The cascade is standalone-only. Asserting identical behaviour would fail: the extension already preserves the pane (the shell survives the agent's exit), while the standalone host does not.
> **Replaced with:** the standalone-only verification above. The fix touches shared code (`goPtyFleetProjection.ts`) that only the standalone host exercises; the extension is unaffected by construction.

### Goal Invariants

- **No silent seat death:** assert no path exits a seat's pty without a stated reason reaching
  the UI.
- **The evidence outlives the process:** assert the agent's final output is retrievable from the
  panel after the agent exits.
- **One seat's death is local:** assert a destroyed session cannot take a healthy sibling seat
  with it.
- **A dead agent is not reported as active:** assert the fleet status reflects the agent's death
  within a bounded interval after `remain-on-exit` preserves the pane. (Without this,
  `remain-on-exit` makes the liveness lie worse, not better.)
