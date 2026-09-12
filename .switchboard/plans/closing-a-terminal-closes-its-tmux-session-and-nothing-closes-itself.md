# Closing a Terminal Closes Its tmux Session, and Nothing Ever Closes Itself

## Goal

Every tmux session Switchboard created is visible in the Terminals panel — the sidebar and
the tmux tab — including sessions with no seat behind them. Closing a terminal closes its tmux
session; closing a team closes the team's sessions. **Nothing is ever closed automatically, on
any signal, ever.** The operator sees all of it and decides.

### Problem analysis

Sessions accumulate without bound and nothing shows the operator that they have. Measured on
this host 2026-09-12: **18 tmux sessions against 5 live seats**, and `lc-coding-team` alone held
**15 windows for 4 seats** — three full generations plus three stray `bash` windows. 35 `devin`
processes were resident. The operator had no surface that showed any of this; the board's
Terminals panel lists seats, and a session with no seat is invisible there.

Two concrete defects produce it.

**1. Closing a terminal does not close its tmux session.** `ptyCloseTerminal` reaches
`fleet.close()` (`cmd/switchboard-pty-host/main.go:573`), which deletes the terminal from the
fleet maps, calls `killProcessTree(t)` and closes the pty. It never issues `kill-session`.
Verified: closing all four Coding seats through the verb left `lc-coding-team` running with its
15 windows and its `devin` processes alive. So "close" means "stop rendering it" — the session
keeps running and drops out of every surface at the same moment, which is the worst of both.

**2. The tmux tab does not list sessions.** The tab exists (`src/webview/terminals.html:3029`,
content at `:3163`), and `listTmuxSessions` exists on the backend (`src/standalone/tmuxBackend.ts:328`,
`src/services/TaskViewerProvider.ts:1823`) — but `listTmuxSessions` is referenced by **no webview
file at all**. The backend can enumerate what is running and nothing asks it to.

Together: sessions are created freely, closing a seat does not remove one, and no surface shows
how many exist. The only way to discover the sprawl is `tmux ls` in a shell.

### Root cause

tmux sessions deliberately outlive the board — that is the durability property the seating design
is built on, and it is correct. But "outlives the board" was allowed to mean "outlives everything,
answerable to nothing". No surface owns the list and no operator action ends one.

### Non-goals

- **Automatic closing. Of anything. On any signal.** See the invariant below — this is the
  load-bearing constraint of this plan, not a preference.
- **Changing the durability property.** A board restart must still leave every session untouched.
  The only thing that closes a session is an operator closing it.
- **Changing seat creation, the control-mode chain, or the grouped base/view topology.** A seat
  legitimately costs a base session plus a grouped view; that is what keeps each seat's pane
  pinned to its own window and is out of scope here.

## Metadata

- **Complexity:** 4
- **Tags:** terminals, tmux, ux, standalone

## User Review Required

None.

## The invariant that outranks every other line in this plan

**No code path may close a tmux session except an operator action in the Terminals panel.**

Not a sweep, not a timer, not a startup reconciliation, not a "no seat references this" check, not
an idle-CPU threshold, not an age threshold. There is no heuristic anywhere in this plan and none
may be added to it.

This is written this strongly because the alternative was tried by hand on 2026-09-12 and
destroyed a session an operator was actively working in. The reasoning was *"the board's fleet
does not list this seat, so nobody is using it."* Every input to that judgement was wrong in a way
that looked right:

- The fleet registry had been emptied by a pty-host crash earlier that day — a **known** failure,
  diagnosed the same morning. Registry absence meant "the registry lost its state", never
  "the seat is gone".
- `#{session_attached}` was **1** on the session. A client was connected. It was printed and read
  past.
- The agent was idle at ~0.75% CPU, which is indistinguishable from a human thinking.

Every cheap signal available — seat absence, silence, low CPU, age — reads identically for
"finished" and "someone is mid-sentence". That is why the answer is an operator action and not a
better heuristic.

## Proposed Changes

### 1. `fleet.close()` closes the tmux session (`cmd/switchboard-pty-host/main.go:573`)

When the terminal being closed is tmux-backed, issue `kill-session` for its **view** session after
tearing down the pty, and `kill-session` for the **base** session when no other view remains
grouped to it. A non-tmux terminal is unaffected.

The base/view distinction matters: killing the base takes every grouped view with it, so a
per-seat close must target the view and only collapse the base once it is the last one. The seat's
view session name is already derived deterministically (`deriveTmuxSessionName`), so no new state
is needed to find it.

### 2. A team close closes the team's sessions

Closing a team from the Terminals panel closes each member's view session and then the team's base
session. This is the case `seat-a-team-into-a-switchboard-owned-tmux-session.md` already names —
"a team stop must `kill-session` to clean up" — which was specified and never implemented.

### 3. The tmux tab lists every session (`src/webview/terminals.html:3163`)

Wire the existing `listTmuxSessions` backend to the existing tmux tab. List **all** Switchboard
sessions, explicitly including ones with no seat behind them — a session invisible to the panel is
the state this plan exists to end. Each row shows the session name, its window count, and whether a
client is attached, with a close control.

`#{session_attached}` is shown because it is the one fact that tells an operator a human is inside
a session before they close it.

### 4. The sidebar shows seatless sessions too

A session with no seat currently appears nowhere in the sidebar. It must appear, visibly marked as
having no seat, with the same close control. The count in the panel header reflects sessions, not
just seats, so sprawl is visible without opening the tab.

### 5. Both composition roots

`listTmuxSessions` and the close path are reached through `TaskViewerProvider` (`:1823`) and
`tmuxBackend.ts`, which both hosts share, and the close verb is the Go host's. The wiring must be
present in **both** `src/extension.ts` and `src/standalone/bootstrap.ts`; a panel that lists
sessions on one host and not the other reproduces the invisibility on the other host. The
standalone host is the primary target, but the seam is registered in both.

## Verification Plan

### Automated Tests

1. **New** `src/test/tmux-session-close-contract.test.js`, wired as
   `test:contract:tmux-session-close` **and invoked from `.github/workflows/integration-tests.yml`**
   (defining it in `package.json` alone is not a gate). Asserts: `fleet.close()` issues
   `kill-session` for a tmux-backed terminal; it targets the view and collapses the base only when
   last; a non-tmux terminal triggers no `kill-session`.
2. **The invariant, as a test:** assert that `kill-session` appears in the close path and **nowhere
   else** — no timer, sweep, interval, or startup reconciliation may reference it. This is the gate
   that stops an automatic reaper being added later by someone who thinks it is an improvement.
3. Source-text assertion that the tmux tab's render path references `listTmuxSessions`, and that
   the row template carries a session-attached indicator.
4. Regression: `test:contract:tmux-view-chrome`, `test:contract:tmux-backend`,
   `test:contract:pty-host-blackbox` stay green (rebuild the host binaries first — the blackbox
   suite spawns from `dist/`).
5. `npm run compile-tests` before any `test:contract:*` run.

### Goal Invariants

- Closing a terminal in the panel leaves **zero** tmux sessions behind for that seat, verified with
  `tmux ls` before and after.
- Closing a team leaves zero sessions for that team, base included.
- A board restart closes **nothing** — session count and agent pids are identical across it.
- Every session `tmux ls` reports is present in the panel, including seatless ones.
- No automatic close exists: grep proves `kill-session` is reachable only from the operator close
  path.
