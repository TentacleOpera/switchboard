# Re-seat a Running Terminal Into tmux

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
`respawnAndReinject` (`main.go:945`) already does nearly all of it: it kills the child tree,
opens a fresh pty on a login shell, and replays `t.startupCommand`. `respawnTerminal`
(`main.go:881`) updates the terminal struct **in place** — name, listeners, ring buffer,
connected clients and the registry row all survive — and deliberately clears
`tmuxWindowId`, `paneID`, `controlActive` and `parseState` so *"the respawn re-runs the
seating chain (the startup command IS the chain)"*.

So a tmux seat that is cleared today already comes back inside tmux. The gap is only for a
seat whose stored `startupCommand` is not a tmux chain.

**What is missing, measured against the current source:**

1. **No verb rewrites `startupCommand`.** The Go host exposes 13 pty verbs
   (`ptyCreateTerminal`, `ptyClearTerminal`, `ptyCloseTerminal`, `ptyWrite`,
   `ptySendPrompt`, `ptyRenameTerminal`, …). `startupCommand` is read from the payload once,
   in `ptyCreateTerminal` (`main.go:293-300`), and thereafter only read (`:881`, `:966`).
   A seat created while tmux seating was off stores the bare composed CLI, and respawn
   faithfully re-runs it outside tmux forever.

2. **The tmux identity fields are write-once at create.** `tmuxViewSession`, `tmuxSession`
   and `tmuxWindow` are set under `f.mu` in `ptyCreateTerminal` and never reassigned —
   `main.go:787` says so explicitly. Both close-time kills gate on them (`:801`), so a
   re-seat that does not write them produces a seat inside tmux whose session nothing will
   ever close.

3. **The chain builder is inline and not callable.** The tmux command chain is constructed
   inside `createTerminal` (`goPtyFleetProjection.ts:289-471`), interleaved with the create
   payload. Nothing else can build one.

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

- **Complexity:** 4
- **Tags:** tmux, pty-host, terminals, feature

## User Review Required

None.

## Proposed Changes

### 1. Extract the tmux chain builder

Lift the chain construction out of `createTerminal` (`goPtyFleetProjection.ts:289-471`)
into a function returning `{ chain, view, session, window }`, taking the seat's name, role
and composed command. `createTerminal` calls it and is otherwise unchanged.

Pure extraction: a test asserts the create path's payload is byte-identical before and
after, so the re-seat feature cannot quietly alter how new seats are seated.

### 2. `ptyReseatTerminal` — the one new verb

Payload `{ name, startupCommand, tmuxViewSession, tmuxSession, tmuxWindow }`. Under `f.mu`:
overwrite those four fields on the terminal, then call `respawnAndReinject(t, t.cliFamily, "")`
— the existing sequence, with an empty prompt, which is exactly what the clear button does.

Refusals, each a distinct error rather than a silent no-op:
- unknown terminal name;
- `t.tmuxViewSession != ""` — already seated, nothing to do;
- empty `startupCommand` — respawn already refuses this at `main.go:881` and the verb
  refuses earlier with a clearer message.

The write-once comment at `main.go:787` is amended: written at create, reassigned **only**
by this verb, which holds `f.mu` for the whole swap. The close-on-close kills at `:801` and
`:804` then find the fields they need, so a re-seated terminal's view session is closed by
the same path as one seated at create.

### 3. `reseatIntoTmux(name)` on the projection

Refuses when `_tmuxSeatingEnabled()` is false and when the cached handle already carries a
`tmuxViewSession`. Otherwise builds the chain via change 1, calls the verb, and updates the
cached handle's `startupCommand` and `tmuxSession` so the projection does not disagree with
the host. Emits the existing `change` event so the panel re-renders.

### 4. The action in the terminals panel

A per-seat action on the terminals panel and the tmux tab, shown only for a seat that is
not already seated. It fires immediately — no confirm gate, no dialog, per the repo rule.
A team-level action re-seats every unseated member of that team.

The seat's pane goes blank and the CLI restarts; that is the visible feedback and needs no
extra UI.

### 5. Host scope

`src/standalone/bootstrap.ts` is the target. The verb reaches the extension host through
its existing `default:` delegation, so nothing 404s there — but `setTmuxSeatingResolver`
is wired **only** at `bootstrap.ts:4043` and the resolver defaults to `false` when unwired,
so tmux seating is already off on the extension host regardless of the setting. Re-seat
there therefore refuses with "tmux seating is not enabled", which is the honest answer
rather than a silent divergence. That pre-existing resolver gap is **not** fixed by this
plan and is not introduced by it.

## Verification Plan

### Automated Tests

1. **New** `src/test/tmux-reseat-contract.test.js`, wired as `test:contract:tmux-reseat`
   **and invoked from `.github/workflows/integration-tests.yml`** — defined-but-not-invoked
   is not a gate. Asserts: re-seat writes all four fields; an already-seated seat is
   refused; a seat with no startup command is refused; the terminal keeps its name, role,
   `parentInstanceId` and registry row across the respawn.
2. Extraction test for change 1: the create payload is byte-identical before and after the
   builder is lifted out, for a seated seat and an unseated one.
3. **Go test** over the verb: the four fields are reassigned under `f.mu`, and
   `tmuxWindowId` / `paneID` / `controlActive` / `parseState` are reset exactly as
   `respawnTerminal` already resets them.
4. Regression: `test:contract:tmux-view-chrome`, `test:contract:pty-host-blackbox`,
   `test:contract:pty-clear-policy`, `go test ./cmd/...`, `gofmt -l ./cmd`.

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
