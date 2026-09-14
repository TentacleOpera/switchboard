# Re-seat a Running Terminal Into tmux

> **Superseded: do not build — pending the seating decision. 2026-09-14.**
> **Context:** tmux *seating* (the board wrapping its own seats in `new-session` / `new-window` / `exec tmux -u attach`) is being removed. The tmux *bridge* — dispatching into panes a human created — is unaffected and stays. See `tmux-seating-and-the-tmux-bridge-are-separate-switches` for why those were ever one switch, and `attach-a-seat-from-any-terminal-client-without-tmux` for the replacement.
> **Decision basis:** persistence was tmux seating's only remaining justification, and Switchboard clears agent context at regular checkpoints — so a preserved session is one the next checkpoint deletes. `re-seat-a-running-terminal-into-tmux` already states this in its own Non-goals: *"Team members are cleared regularly, so this costs nothing that is not already routinely spent."* What survives a crash is the CLI **boot** (8s Claude / 20s Devin readiness ceilings), not the work.
> **Why this one specifically:** its entire purpose is moving a running seat *into* tmux. It is also the plan whose Non-goals supply the argument for removing seating.


## Goal

A seat that is already running outside tmux can be moved into a tmux session Switchboard
owns, from the terminals panel, without closing the seat or losing its place on the board.
The agent CLI cold-boots — that is the accepted cost, not a problem to solve here.

### Problem analysis

A process's controlling terminal is fixed at fork/exec. tmux can only put a process in a
pane if tmux owned the pty when that process started; there is no adopt-this-pty operation
in tmux's protocol. The only tool that reparents a running process onto a new tty is
`reptyr`, which is ptrace-based, blocked by `kernel.yama.ptrace_scope=1` on this host, and
wrong regardless: it *moves* the process, so the Go host loses it, `/ws/terminal` goes dead
and `ptySendPrompt` can no longer address the seat. Board control would be traded for SSH
visibility.

**The seat, however, can be re-seated even though the process cannot be moved.**
`respawnAndReinject` (`main.go:1109`) already does nearly all of it: it kills the child tree,
opens a fresh pty on a login shell, and replays `t.startupCommand`. `respawnTerminal`
(`main.go:1042`) updates the terminal struct **in place** — name, listeners, ring buffer,
connected clients and the registry row all survive — and deliberately clears
`tmuxWindowId`, `paneID`, `controlActive` and `parseState` so *"the respawn re-runs the
seating chain (the startup command IS the chain)"*.

So a tmux seat that is cleared today already comes back inside tmux. The gap is only for a
seat whose stored `startupCommand` is not a tmux chain.

**What is missing, measured against the current source:**

1. **No verb rewrites `startupCommand`.** The Go host exposes 13 pty verbs
   (`ptyCreateTerminal`, `ptyClearTerminal`, `ptyCloseTerminal`, `ptyWrite`,
   `ptySendPrompt`, `ptyRenameTerminal`, …). `startupCommand` is read from the payload once,
   in `create` (`main.go:336`), and thereafter only read (`:1043`, `:1130`).
   A seat created while tmux seating was off stores the bare composed CLI, and respawn
   faithfully re-runs it outside tmux forever.

2. **The tmux identity fields are write-once at create.** `tmuxViewSession`, `tmuxSession`
   and `tmuxWindow` are set under `f.mu` in `create` (`main.go:321,327,328`) and never
   reassigned — the comment at `main.go:949` says so explicitly. Both close-time kills gate
   on them (`:963` view kill, `:999` window kill), so a re-seat that does not write them
   produces a seat inside tmux whose session nothing will ever close.

3. **The chain builder is inline and not callable.** The tmux command chain is constructed
   inside the `create` method (`goPtyFleetProjection.ts:289-494`), interleaved with the
   create payload. Nothing else can build one.

### Root cause

Seating was designed as a property of terminal *creation* — decided once, from the config
flag, at the moment the pty is opened. Everything downstream (the Go host's write-once
fields, the inline chain builder, the absent update verb) follows from that single
assumption. Respawn already proves the assumption is unnecessary: it re-runs the seating
chain on an existing terminal without disturbing its identity.

### Non-goals

- **Preserving the agent's conversation.** Re-seat is a cold boot of the CLI. Team members
  are cleared regularly, so this costs nothing that is not already routinely spent. No
  `--resume` threading, no transcript replay, no context handoff.
- **`reptyr` or any ptrace-based process migration.** Ruled out above.
- **Moving a seat out of tmux.** One direction only. A seat that should not be in tmux is
  closed and recreated.
- **Changing when new seats are seated.** `switchboard.terminal.tmux.enabled` (default
  `true`) keeps deciding that. This plan adds a manual action for seats that missed it.

## Metadata

- **Complexity:** 5
- **Tags:** feature, backend, ui, refactor

## User Review Required

None.

## Complexity Audit

### Routine
- Extracting the inline tmux chain builder out of `create` into a pure function — pure refactor, byte-identical create payload asserted by test.
- Adding a single Go host verb that writes four existing struct fields and calls an existing function (`respawnAndReinject`).
- Emitting the existing `change` event so the panel re-renders — one line, an existing pattern.
- The per-seat UI action: a button shown under a condition, firing an existing verb path.

### Complex / Risky
- **Composition-root wiring across both hosts.** `reseatIntoTmux` is a TS projection method, not a Go verb. Both `handlePtyVerb` roots need an explicit `case` calling it — standalone's `default:` arm errors (`bootstrap.ts:3878`), and the extension's `default:` delegates to the Go host (`TaskViewerProvider.ts:4505`), bypassing the projection. This is the AGENTS.md composition-root trap; the seam wiring is the audit, not the verb reachability.
- **Lock ordering around the field swap + respawn.** `f.mu` (fleet) must not be held across `respawnAndReinject`'s `waitReadiness` (up to 20s for Devin — freezes the whole fleet). The swap and the respawn are two lock regions, with a re-existence check between them against a racing `close()`.
- **Write-once field reassignment.** Amending the write-once invariant at `main.go:949` is a documented contract change; the verb is the sole sanctioned second writer and holds `f.mu` for the swap.

## Edge-Case & Dependency Audit

- **Race Conditions:** A `close()` that takes `f.mu` can delete the terminal between the field-swap (under `f.mu`) and the respawn (under `t.mu`). Mitigation: after dropping `f.mu`, re-fetch the terminal under `f.mu` (or re-check `f.terminals[name]`) before taking `t.mu`; treat a missing terminal as a clean refusal, not a panic. A concurrent `ptySendPrompt` on the same seat is serialized by `t.mu` against the respawn — same as the existing clear path.
- **Security:** The verb writes `startupCommand` from a payload. The payload is auth-gated (`LocalApiServer._checkAuth` on standalone; `TaskViewerProvider.handlePtyVerb` on extension) like every other pty verb. No new surface; no shell interpolation in the Go host (the chain is built in TS and typed into the pty, never `exec.Command`'d by the host).
- **Side Effects:** Re-seat cold-boots the CLI (accepted, stated non-goal). The old process tree is killed by `killProcessTree` inside `respawnTerminal` — no orphan. The old *unseated* shell had no tmux state to clean up.
- **Dependencies & Conflicts:** Depends on `respawnAndReinject` (`main.go:1109`) and `respawnTerminal` (`main.go:1042`) unchanged. Depends on the extracted chain builder (change 1) producing a byte-identical chain to the inline one — the extraction test is the gate. Conflicts with the write-once comment at `main.go:949` — amended, not removed.

## Dependencies

- `respawnAndReinject` (`main.go:1109`) — the existing kill-pty + fresh-shell + re-inject sequence this plan reuses.
- `respawnTerminal` (`main.go:1042`) — the in-place struct update that preserves name/registry/listeners.
- The tmux chain construction block in `create` (`goPtyFleetProjection.ts:289-494`) — lifted out by change 1.
- `setTmuxSeatingResolver` wired at `bootstrap.ts:4044` (standalone only) — the seating-enabled signal the projection refuses without.

## Adversarial Synthesis

Key risks: (1) the reseat verb is a TS projection method that both `handlePtyVerb` roots must wire explicitly — standalone's `default:` errors and the extension's `default:` bypasses the projection, so without both `case` arms the feature 404s on the Pi and silently skips its own logic on the extension; (2) the cached handle carries `tmuxSession` but not `tmuxViewSession`, so the projection's "already seated" refusal must key on `tmuxSession` or it never fires; (3) `f.mu` must not be held across the respawn's readiness wait. Mitigations: explicit `case` arms in both roots calling `ptyFleetService.reseatIntoTmux(name)`; refusal keyed on `handle.tmuxSession`; two lock regions with a re-existence check between them.

## Proposed Changes

### 1. Extract the tmux chain builder

Lift the chain construction out of the `create` method
(`goPtyFleetProjection.ts:289-494`) into a function returning
`{ chain, view, session, window }`.

**Inputs (clarification — the inline block reads all of these):** the seat's `name`, `role`,
the composed command (`composedCli`), and `opts?.tmuxSession` (the solo-seat detection at
`:330` keys on it — without it every re-seat is treated as solo and gets no grouped view
session). `create` calls it and is otherwise unchanged.

Pure extraction: a test asserts the create path's payload is byte-identical before and
after, so the re-seat feature cannot quietly alter how new seats are seated.

### 2. `ptyReseatTerminal` — the one new Go host verb

Payload `{ name, startupCommand, tmuxViewSession, tmuxSession, tmuxWindow }`.

**Lock sequence (correction — do not hold `f.mu` across the respawn):**
1. Under `f.mu`: look up `t := f.terminals[name]`. If absent → refuse "No such terminal".
   If `t.tmuxViewSession != ""` → refuse "already seated". If `startupCommand == ""` →
   refuse "respawn requires a startup command". Overwrite the four fields on `t`.
   Drop `f.mu`.
2. Re-fetch the terminal under `f.mu` (a racing `close()` may have deleted it). If gone →
   return a clean refusal, not a panic. Drop `f.mu`.
3. Under `t.mu`: call `respawnAndReinject(t, t.cliFamily, "")` — the existing sequence with
   an empty prompt, exactly what the clear button does (`main.go:1320-1322`). Drop `t.mu`.

Refusals, each a distinct error rather than a silent no-op:
- unknown terminal name;
- `t.tmuxViewSession != ""` — already seated, nothing to do;
- empty `startupCommand` — `respawnTerminal` already refuses this at `main.go:1043` and the
  verb refuses earlier with a clearer message.

The write-once comment at `main.go:949` is amended: written at create, reassigned **only**
by this verb, which holds `f.mu` for the swap. The close-on-close kills at `:963` and
`:999` then find the fields they need, so a re-seated terminal's view session is closed by
the same path as one seated at create.

### 3. `reseatIntoTmux(name)` on the projection

> **Superseded:** Refuses when `_tmuxSeatingEnabled()` is false and when the cached handle already carries a `tmuxViewSession`.
> **Reason:** `ExtendedTerminalHandle` (`ptyFleetService.ts:118-154`) and `ProjectedTerminal` (`goPtyFleetProjection.ts:32-56`) carry `tmuxSession` but **not** `tmuxViewSession` or `tmuxWindow`. The cached handle has no `tmuxViewSession` field, so the refusal as written reads `undefined` for every seat and never fires — an already-seated seat would be re-seated, defeating the no-op gate the plan claims.
> **Replaced with:** Refuses when `_tmuxSeatingEnabled()` is false and when the cached handle already carries a non-empty `tmuxSession` (the BASE session name, which is set for every seated seat and is already the boot-reaper's ownership signal at `ptyFleetService.ts:154`). `tmuxSession` is the sufficient proxy: a seated seat always has one, an unseated seat never does.

Refuses when `_tmuxSeatingEnabled()` is false and when the cached handle already carries a
non-empty `tmuxSession`. Otherwise builds the chain via change 1, calls the verb
(`this.supervisor.request('ptyReseatTerminal', …)`), and updates the cached handle's
`startupCommand` and `tmuxSession` so the projection does not disagree with the host. The
handle does not carry `tmuxViewSession` or `tmuxWindow` (only `tmuxSession`), and that is
sufficient — nothing on the read path keys off the other two from the handle; the Go host's
`close()` reads them from its own struct, not the cache. Emits the existing `change` event
so the panel re-renders.

### 4. The action in the terminals panel

A per-seat action on the terminals panel and the tmux tab, shown only for a seat that is
not already seated **and only when tmux seating is enabled** (the panel needs the
seating-enabled signal — without it the extension host, where `_tmuxSeatingEnabled()`
returns false, would show a button whose only effect is an error). It fires immediately —
no confirm gate, no dialog, per the repo rule. A team-level action re-seats every unseated
member of that team.

The seat's pane goes blank and the CLI restarts; that is the visible feedback and needs no
extra UI.

### 5. Host scope — both composition roots

> **Superseded:** `src/standalone/bootstrap.ts` is the target. The verb reaches the extension host through its existing `default:` delegation, so nothing 404s there — but `setTmuxSeatingResolver` is wired only at `bootstrap.ts:4043` and the resolver defaults to `false` when unwired, so tmux seating is already off on the extension host regardless of the setting.
> **Reason:** Two errors. (1) The standalone `handlePtyVerb` `default:` arm (`bootstrap.ts:3878`) returns `PTY verb '${verb}' not implemented in standalone mode` — it **errors**, it does not delegate. Every existing pty verb has an explicit `case` arm (`ptyClearTerminal:2647`, `ptyWrite:2660`, `ptySendModel:2692`); a reseat verb with no case 404s on the Pi, the primary host. (2) The extension `handlePtyVerb` `default:` (`TaskViewerProvider.ts:4505`) delegates to `this._ptyHostVerb` — straight to the Go host — which **bypasses** the projection's `reseatIntoTmux` (chain building, cached-handle update, refusal checks). This is the AGENTS.md composition-root trap: the seams each host *wires* are the audit, not the verbs each host answers.
> **Replaced with:** Both `handlePtyVerb` roots get an explicit `case` for the reseat verb that calls `ptyFleetService.reseatIntoTmux(payload.name)` and returns its result. The standalone case lives in `bootstrap.ts`'s switch (alongside `ptyClearTerminal`); the extension case lives in `TaskViewerProvider.handlePtyVerb` (alongside its pty verb arms). Neither relies on the `default:` arm. The pre-existing `setTmuxSeatingResolver` gap (unwired in the extension, so `_tmuxSeatingEnabled()` returns false there) is **not** fixed by this plan and is not introduced by it — on the extension the re-seat action is hidden (change 4 gates on seating-enabled), so the unwired resolver produces no button rather than an erroring one.

## Verification Plan

### Automated Tests

1. **New** `src/test/tmux-reseat-contract.test.js`, wired as `test:contract:tmux-reseat`
   **and invoked from `.github/workflows/integration-tests.yml`** — defined-but-not-invoked
   is not a gate. Asserts: re-seat writes all four fields; an already-seated seat is
   refused; a seat with no startup command is refused; the terminal keeps its name, role,
   `parentInstanceId` and registry row across the respawn; the projection's cached handle
   gains a `tmuxSession` and an updated `startupCommand` after re-seat.
2. Extraction test for change 1: the create payload is byte-identical before and after the
   builder is lifted out, for a seated seat and an unseated one.
3. **Go test** over the verb: the four fields are reassigned under `f.mu`, and
   `tmuxWindowId` / `paneID` / `controlActive` / `parseState` are reset exactly as
   `respawnTerminal` already resets them; `f.mu` is not held across `waitReadiness`
   (assert the fleet lock is releasable during a re-seat on a second seat).
4. **Composition-root wiring test:** both `handlePtyVerb` roots resolve the reseat verb to
   `ptyFleetService.reseatIntoTmux` (not to the Go host directly, not to the `default:`
   error arm). The standalone-fleet-seam contract is the existing pattern to extend.
5. Regression: `test:contract:tmux-view-chrome`, `test:contract:pty-host-blackbox`,
   `test:contract:pty-clear-policy`, `test:contract:standalone-fleet-seam`, `go test ./cmd/...`, `gofmt -l ./cmd`.

### Goal Invariants

- A seat running outside tmux, re-seated, appears in `tmux ls` and is attachable from an
  SSH client — verified by attaching, not by reading the session list.
- The board still addresses that seat by its original name: `ptySendPrompt` reaches it
  after the re-seat with no rename and no re-registration.
- Closing the re-seated terminal ends its tmux view session, exactly as for a seat seated
  at create. Verified by `tmux ls` before and after.
- A seat that is already seated is refused, and the refusal names the reason.
- New-seat creation is unchanged: the create payload is identical to what it was before
  change 1.
- The re-seat action is absent from the terminals panel when tmux seating is disabled
  (extension host) — no button whose only effect is an error.

## Outstanding Questions

- **[user]** The standalone `handlePtyVerb` `default:` arm errors rather than delegates, and the extension `default:` delegates to the Go host (bypassing the projection). This plan assumes both roots get an explicit `case` for the reseat verb (change 5). Proceeding on the assumption that explicit wiring in both roots is required and acceptable — it is the AGENTS.md "no divergence" contract.
