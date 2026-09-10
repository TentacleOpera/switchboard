# A Seat's pty Inherits `TERM`, So the Fleet Depends on Who Launched the Board

## Goal

Set a valid `TERM` on every pty the host creates, instead of passing along whatever the process that
started the board happened to have. A seat's ability to run should not depend on how the board was
launched.

### Problem analysis

**Reproduced verbatim.** A tmux client attaching with `TERM` unset fails with exactly the error an
operator sees when starting a team:

```
TERM=<unset>          -> open terminal failed: terminal does not support clear
TERM=dumb             -> open terminal failed: terminal does not support clear
TERM=nonexistent-term -> missing or unsuitable terminal: nonexistent-term
TERM=xterm-256color   -> attaches fine
```

The failing call is the tail of the seating command — `exec tmux attach -t ${view}`
(`goPtyFleetProjection.ts`) — which attaches a *client*, and a client needs a terminfo entry.
`tmux new-session -d` does not, which is why the fault is invisible until a seat actually starts.

**The pty inherits the host's environment wholesale.** `ptyFleetService.ts:545`:

```ts
env: { ...claudeEnvDefaults, ...process.env, ...switchboardEnv }
```

`switchboardEnv` sets `SWITCHBOARD_TERMINAL` and friends (`:497`); the Go host does the same
(`cmd/switchboard-pty-host/main.go:151`). Neither sets `TERM`. So `TERM` arrives from `process.env`
— that is, from whoever started the board.

**Which means the fleet works or fails by launcher:**

| launched from | `TERM` | tmux seats |
|---|---|---|
| an interactive terminal | real value | work |
| inside tmux | `tmux-256color` | work |
| a systemd unit | **unset** | fail |
| cron, or an agent's tool shell | **unset** | fail |

Observed live on 2026-09-10: a host started from a non-interactive shell had `TERM` empty in
`/proc/<pid>/environ`, and every team start failed with the message above. The same board had been
starting teams for agents without error all day, because it had been launched from a terminal — who
*initiates* a start is irrelevant, only who launched the **host** matters.

**And this blocks the obvious next step.** A systemd unit for the board — the fix for "nothing brings
LABCOM back after a reboot" — has no `TERM` either, so it would break every tmux seat on the first
boot after being installed.

## Metadata

**Complexity:** 2
**Tags:** bugfix, reliability, terminals, both-hosts
**Dependencies:** none.

## User Review Required

None.

## Proposed Changes

### 1. Set `TERM` when creating a pty, in both hosts

- **Logic:** default `TERM` to a known-good value in the pty's environment rather than inheriting it.
  `xterm-256color` is present on a stock Pi OS and is the safe choice; keep an inherited value only if
  it resolves in terminfo.
- **Where:** `ptyFleetService.ts:545` (the `env` spread) and `cmd/switchboard-pty-host/main.go:151`,
  which already assembles `SWITCHBOARD_TERMINAL` and can set `TERM` in the same place.
- **Do not simply pass `process.env` through** — that is the defect. An explicit default that a real
  inherited value can override is the shape.

### 2. Validate rather than assume

- **Logic:** if an inherited `TERM` does not resolve in terminfo, replace it and say so once at
  startup. `TERM=dumb` and `TERM=nonexistent-term` both fail, differently, and neither message names
  `TERM`.

### 3. Report the real cause when a seat cannot attach

- **Logic:** `open terminal failed: terminal does not support clear` names neither `TERM` nor the
  board. If a seat's attach fails, the host should surface the seat's `TERM` alongside it. This cost
  an hour of misdiagnosis; the message is the whole reason.

## Verification Plan

- A host started with `TERM` unset still spawns working tmux seats.
- A host started with `TERM=dumb` likewise, and logs that it substituted a default.
- A host started from an interactive terminal keeps that terminal's `TERM`, unchanged.
- A seat that cannot attach reports its `TERM` in the failure.
- Regression guard: assert the pty env contains a `TERM` that resolves in terminfo, in both hosts.

## Outstanding Questions

- `xterm-256color` or `screen-256color` as the default? Seats run inside tmux, so `screen-256color` is
  arguably more honest, but `xterm-256color` is the more widely present entry. Both exist on this box.
