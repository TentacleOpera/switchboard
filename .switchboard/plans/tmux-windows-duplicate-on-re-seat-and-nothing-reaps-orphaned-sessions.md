# tmux Windows Duplicate on Re-Seat, and Nothing Reaps Orphaned Sessions

## Goal

Make what the operator sees the whole truth about what is running. Closing a terminal must close
it; starting the same team again must land in the windows that already exist rather than appending a
second set; and a host that starts up must reap `lc-*` sessions no live seat owns.

The failure this exists to prevent is not a resource leak — it is **an operator who believes they
have shut idle terminals down and has not.** Seats that outlive the board they were closed from are
invisible, unreachable through the UI that created them, and can only be found with `tmux ls`.

### Problem analysis

The design intent is already written into the code. `src/services/goPtyFleetProjection.ts:227`:

> *"if the PTY dies, the tmux session and the agent inside it survive, and the next spawn of the same
> name reattaches to the still-running agent."*

It does not reattach. It appends.

#### Observed: one team, three sets of seats, 1.5 GB

A single four-seat Coding team, one session, **twelve windows** — the same four names three times:

```
win 0-3    Coding, Coding-coder-1, Coding-coder-2, Coding-intern   created 12:30:46
win 4-7    Coding, Coding-coder-1, Coding-coder-2, Coding-intern   created 12:36:17
win 8-11   Coding, Coding-coder-1, Coding-coder-2, Coding-intern   created 13:29:25
```

Three `devin` leads and nine `agy` seats, holding **2,329 MB RSS** (695 MB PSS for the four live
ones; the eight orphans were ~1.5 GB of the total). Only the 13:29 set belonged to the running host,
which started at 12:52 — the other eight had outlived two host restarts.

#### Root cause: the session is checked, the window is not

`src/services/goPtyFleetProjection.ts:258`:

```sh
tmux has-session -t ${session} 2>/dev/null
  && tmux new-window -d -t ${session} -n ${win} ${inner}
  || tmux new-session -d -s ${session} -n ${win} ${inner};
```

`has-session` guards session *creation*. Window creation is unconditional, and **tmux permits
duplicate window names**, so nothing rejects the second `Coding-coder-1`. No code on this path reads
`list-windows` or `#{window_name}` (`grep -rn "list-windows\|window_name" src --include=*.ts` returns
hits only in `tmuxBackend.ts` formats and `select-window` calls). The seam that decides reuse simply
has no notion of a window already being there.

#### Why a host restart cannot fix it

Seats are children of the **tmux server**, not of the host process. Restarting the host leaves every
seat running and re-dispatches fresh ones — so a restart *adds* a generation rather than clearing one.
This is deliberate for crash survival, and it is exactly what makes an explicit reaper necessary:
nothing else can ever collect them.

#### Why nothing kills a window on close

`src/standalone/tmuxTeamSeating.ts:99` already has the teardown (`kill-session`), so the capability
exists. What is missing is the distinction between **the PTY dying** (survive — the point of the
comment above) and **the operator closing a terminal** (tear down). Both currently look identical to
the seating layer, and it resolves them the safe way, which means never.

## Metadata

**Complexity:** 4
**Tags:** tmux, terminals, lifecycle
**Dependencies:** the-terminals-panel-gets-tabs-and-tmux-gets-one-of-its-own (supplies the tmux tab
and its live session list; change 4 below adds controls to it)

## User Review Required

None. Operator intent is settled: *"the design was meant to be: you close a terminal in the terminals
browser in LABCOM, it closes the tmux session."* Change 2 implements that for a single seat, not only
for a team release.

## Proposed Changes

### 1. Reuse a window that already carries the name (`src/services/goPtyFleetProjection.ts:258`)

- **Logic:** before creating, ask whether the window exists. Create only when it does not; otherwise
  select the existing one and let the PTY attach to the agent already running in it.
- **Implementation:** replace the two-branch chain with a three-branch one — no session, session but
  no window, session and window. The name test is
  `tmux list-windows -t ${session} -F '#{window_name}' | grep -qx ${win}`. Keep the existing
  `select-window -t ${view}:${win}` line; it becomes the shared tail of all three branches.
- **Why here:** this is the only seam that composes the seating command, so it is the only place a
  duplicate can be prevented at source.

### 2. An operator close tears the window down (`src/standalone/tmuxTeamSeating.ts:99`, Terminals panel close path)

- **Logic:** thread an explicit `reason` through the close path — `operator-close` kills the window
  (and the session when it was the last one), `pty-exit` leaves it, preserving crash survival.
- **Implementation:** `kill-window -t ${session}:${win}` for a seat; the existing `kill-session` when
  the team is released or the last window goes.

### 3. Reap orphaned `lc-*` sessions at host startup

- **Logic:** on boot, list `lc-*` sessions and windows, compare against seats the host intends to own,
  and kill what nothing claims. Report what was reaped rather than doing it silently.
- **Implementation:** runs after seat projection so a legitimate reattach is never mistaken for an
  orphan. That ordering is the whole safety argument — a session the host is about to adopt is not an
  orphan, so no further guard is needed. Report what was reaped so the operator sees the cleanup
  rather than inferring it.

### 4. Show and kill sessions from the tmux tab (depends on the tabs plan)

- **Logic:** the session list that plan already adds gains a window count per session and a kill
  control per session and per window, plus a "reap orphans" action running change 3 on demand.
- **Implementation:** duplicate window names must be rendered distinctly (index, not name) or the UI
  reproduces the ambiguity that caused this.

### 5. Team start is idempotent

- **Logic:** starting a team that already has a session seats into it. With change 1 in place this
  falls out for free, but it needs asserting so it cannot regress.

## Verification Plan

### Automated Tests

- `test:contract:tmux-seat-reuse` (new) — compose the seating command for a seat whose window already
  exists and assert it contains no `new-window`; for one whose window does not, assert it does.
- Re-seat the same four-role team twice against a real tmux socket; assert `list-windows` returns
  exactly **4**, not 8. This is the test that would have failed today.
- Close with `reason: 'operator-close'` kills the window; `reason: 'pty-exit'` does not.
- Startup sweep with one claimed and one unclaimed `lc-*` session kills exactly the unclaimed one.
- Extend `src/test/tmux-backend-contract.test.js`.

### Goal Invariants

- For any team session, `window count == seat count`. No team ever holds two windows of one name.
- After a host start, no `lc-*` session exists that the host does not own.
- A PTY exit still leaves its window alive (the crash-survival property must not regress).

### Manual

1. Start the Coding team, `tmux list-windows -t lc-coding-team` → 4.
2. Start it again → still 4, and the agents are the same processes (PIDs unchanged).
3. Restart the host → still 4.
4. Close one seat in the Terminals panel → 3, and its agent process is gone.
5. Create an orphan by hand (`tmux new-session -d -s lc-fake-team`), restart the host → reaped.

## Outstanding Questions

- Does the same duplication affect group seating (`tmuxTeamSeating.ts:274`), which has its own
  `new-session` path, or only the projection seam?
- Should the tmux tab show sessions the host does **not** own at all (a hand-rolled `tmux new-session`
  by the operator), or only `lc-*`? Showing everything makes the tab the honest answer to "what is
  running"; showing only `lc-*` keeps it scoped to what the board created.
