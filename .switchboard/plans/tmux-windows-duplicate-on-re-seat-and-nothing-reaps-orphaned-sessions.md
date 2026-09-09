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

#### A solo seat gets a base session nobody attaches to

Measured on a live host: 14 sessions for 9 panes. Four of the fourteen are inert.

```
lc-planner-1          windows: planner-1   clients: (none)      <- no purpose
lc-planner-1-planner  windows: planner-1   clients: /dev/pts/8  <- the board pane
```

Every standalone terminal gets the base+view split that exists only for teams. The split gives
several panes independent current-window pointers over a *shared* window list; a solo seat has one
window, so there is nothing to isolate, and its base is attached to by nothing.

The cause is the suffix fallback at `goPtyFleetProjection.ts:255`:

```js
const teamSlug = session.replace(/^lc-/, '').replace(/-team$/, '');
const suffix = winSlug.replace(new RegExp(`^${teamSlug}-?`), '') || role.toLowerCase();
```

For `planner-1`: session `lc-planner-1`, teamSlug `planner-1`, winSlug `planner-1` — strips to empty,
falls back to the role, view `lc-planner-1-planner`. The comment above it explains the fallback as
being for *"the head, whose window IS the team name"*, but a solo seat's window is **always** its own
session name, so the head rule fires for every standalone terminal. Four planner seats cost eight
sessions and four two-member groups.

#### Correction: `tmuxTeamSeating.ts` no longer exists

Written before a sweep confirmed it. That module was **deleted** (see
`tmux-belongs-in-the-go-host-not-a-second-fleet-in-typescript`), and the Go host has no tmux code at
all — `grep -rln tmux cmd internal` returns nothing. So there is exactly **one** place team windows
are created today, the per-seat startup command at `goPtyFleetProjection.ts:259`, and no correct
implementation to defer to. Every reference to `tmuxTeamSeating` below is historical.

#### Reproduced live, 2026-09-09 20:49

The same team doubled again, in the running session — not as orphans this time:

```
lc-coding-team: 8 windows, every name twice
  Coding          167049  13:59:22      Coding          254197  20:49:22
  Coding-coder-1  167345  13:59:23      Coding-coder-1  254477  20:49:24
  Coding-coder-2  167992  13:59:26      Coding-coder-2  254983  20:49:26
  Coding-intern   168150  13:59:27      Coding-intern   255174  20:49:27
```

Every process traced to a live pane (0 orphans), so the reaper would not have helped — only window
reuse would. The four duplicates held ~900 MB, which accounts for most of the 423 MB that had gone to
swap. The four `planner-*` seats, each a single-window session, did **not** double: this is the team
path only.

#### Why the view session is idempotent and the window is not

```sh
tmux new-session -A -d -t ${session} -s ${view}   # -A = attach-or-create  -> idempotent
tmux new-window  -d -t ${session} -n ${win}       # no equivalent flag     -> always creates
```

`-A` is why re-seating never doubles the *view* sessions. `new-window` has no such flag and tmux
permits duplicate window names, so nothing rejects the second `Coding-coder-1`.

#### Why nothing kills a window on close

`(was tmuxTeamSeating.ts:99 — that module is DELETED)` already has the teardown (`kill-session`), so the capability
exists. What is missing is the distinction between **the PTY dying** (survive — the point of the
comment above) and **the operator closing a terminal** (tear down). Both currently look identical to
the seating layer, and it resolves them the safe way, which means never.

#### Scope of the duplicate bug (resolved from code)

The duplication is **exclusive to the projection seam** (`goPtyFleetProjection.ts:258`). The group-
seating path (`tmuxTeamSeating.ts`, `createTmuxHeadWithDelegates`) is guarded by `checkReconnect`
(`tmuxTeamSeating.ts:142-193`): it lists panes by `pane_title`, and either reattaches (roster
matches) or **refuses** ("exists with different panes — refusing to adopt"). It never issues an
unconditional `new-window`. So change 1 targets the projection seam only; the group-seating path
needs no duplicate-prevention work.

## Metadata

**Complexity:** 5
**Tags:** bugfix, reliability, terminals
**Dependencies:** the-terminals-panel-gets-tabs-and-tmux-gets-one-of-its-own (supplies the tmux tab
and its live session list; change 4 below adds controls to it)

## User Review Required

None. Operator intent is settled: *"the design was meant to be: you close a terminal in the terminals
browser in LABCOM, it closes the tmux session."* Change 2 implements that for a single seat, not only
for a team release.

## Complexity Audit

### Routine
- Adding a `list-windows` name-test before `new-window` in a single seam (`goPtyFleetProjection.ts:258`).
- Threading a `reason` string through an existing close path that already has a `kill()`/`dispose()` seam.
- Issuing `tmux kill-window` / `kill-session` via the existing `run()` helper — the capability already exists (`tmuxTeamSeating.ts:99` uses `kill-session`).
- A startup sweep that lists `lc-*` sessions and kills unclaimed ones — straightforward `tmux ls` + comparison.

### Complex / Risky
- **Reaper ownership signal at boot.** At host startup the Go PTY fleet cache is empty (no PTYs live, no team re-seated — teams start on demand, not auto-respawned). An ownership set drawn from the in-memory projection is the null set at boot, which would reap *every* surviving session — the opposite of crash survival. The signal must come from the **persisted `runtime.terminals` registry** (`sessionName` + `ideName: 'switchboard-tmux'`), which survives restarts. See change 3.
- **Reason origin inversion.** The close path has two entry points (UI close → `kill()`; natural PTY exit → WebSocket `closed` event at `goPtyFleetProjection.ts:705`). If `operator-close` is threaded from the wrong arm, every natural exit tears down its surviving agent and crash survival is silently inverted. See change 2.
- **`kill-window` by name when duplicates still exist.** Before change 1 lands everywhere, a pre-existing orphan can share a window name with the live seat; `kill-window -t session:Name` kills the first match and may leave the orphan. Changes 1 and 2 must land together, or change 2 must target by window index.

## Edge-Case & Dependency Audit

- **Race Conditions:** `list-windows | grep` then `new-window` is a TOCTOU. Within one team, seating is single-threaded (`spawnDelegates` `await`s each `create()`), so the window is benign. Cross-team or re-seat-vs-start races can still produce a transient duplicate, but the *running agent is never killed* and the next re-seat collapses it. Not worth a mutex; the name-test with `-F` (below) is sufficient.
- **Security:** `${win}` is derived from a friendly name and interpolated into a `grep -qx` pattern and a `kill-window -t` target. Use `grep -Fxq -- "${win}"` (fixed-string, no regex metachar interpretation) and keep the existing argv-based `run()` (no shell interpolation — `tmuxBackend.ts` uses `execFile`, enforced by the contract test). The `inner` command is already `JSON.stringify`-quoted.
- **Side Effects:** `kill-window` on the last window of a session kills the session (tmux behaviour) — desired, and matches the existing `kill-session` fallback for team release. The reaper must not kill a session the host is mid-reattach on; ordering after `tmuxFleetService.reconcile()` (which refreshes the registry from live panes) is the guard.
- **Dependencies & Conflicts:** Change 4 depends on `the-terminals-panel-gets-tabs-and-tmux-gets-one-of-its-own`. Changes 1 and 2 must ship together (or change 2 targets by window index) to avoid `kill-window` ambiguity against pre-existing duplicates. The reaper (change 3) is independent and safe to ship alone.

## Dependencies

- `the-terminals-panel-gets-tabs-and-tmux-gets-one-of-its-own` — supplies the tmux tab and its live session list; change 4 adds controls to it.

## Adversarial Synthesis

Key risks: (1) the reaper's ownership anchor was specified against the in-memory seat projection, which is empty at boot — re-grounding it against the persisted `runtime.terminals` registry; (2) the `reason` on the close path must originate ONLY at the UI close verb or crash survival inverts; (3) `kill-window` by name is ambiguous while pre-change-1 duplicates exist — ship changes 1+2 together or target by index. Mitigations: registry-backed ownership set, single specified reason origin, joint landing of the window-reuse and close-teardown changes.

## Proposed Changes

### 1. Reuse a window that already carries the name (`src/services/goPtyFleetProjection.ts:258`)

- **Logic:** before creating, ask whether the window exists. Create only when it does not; otherwise
  select the existing one and let the PTY attach to the agent already running in it.
- **Implementation:** replace the two-branch chain with a three-branch one — no session, session but
  no window, session and window. The name test is
  `tmux list-windows -t ${session} -F '#{window_name}' | grep -Fxq -- "${win}"` (fixed-string `-F`,
  `--` end-of-options, `-x` exact-line match — `${win}` is derived from a friendly name and must not
  be interpreted as a regex). Keep the existing `select-window -t ${view}:${win}` line; it becomes the
  shared tail of all three branches.
- **Why here:** this is the only seam that composes the seating command, so it is the only place a
  duplicate can be prevented at source.
- **On the reuse path the startup command must NOT run again.** The agent is already alive in that
  window; the `tmux attach` at the tail connects to it. Re-running `${inner}` would launch a second
  agent inside the existing window. This is the behaviour the comment at `:227` already claims and
  does not deliver.
- **Use `if`/`elif`/`else`, not `&&`/`||` chaining.** The current chain is
  `has-session && new-window || new-session`, and in shell `A && B || C` runs **C when B fails**. So
  a `new-window` failure today falls through to creating a session that already exists, that fails
  too, and the seat is left attaching to a window nothing created. Keeping the chain shape while
  adding a third branch preserves that trap.
- **Correction to the previous residual note:** a race-created duplicate does **not** collapse on the
  next re-seat. The existence test is satisfied by *either* copy, so the next seat skips creation and
  the duplicate persists indefinitely — observed live on 2026-09-09, 8 windows standing for ~7 hours
  (see the repro above). Worse, both copies hold a live agent, and `deriveFriendlyName`
  (`tmuxBackend.ts:239`) resolves a name to whichever pane the list yields first, so dispatches can
  land on the wrong copy. The race therefore needs preventing, not tolerating: `flock` on a
  per-session lockfile around the test-and-create, or — preferred — the host awaiting each seat's
  window before spawning the next, since it already controls spawn order.
- **Scope of the race, precisely:** each seat tests only its *own* window name, so sibling seats of
  one team do not collide. The collision is two concurrent starts of the *same* team (a double press,
  or a re-seat while a start is in flight), plus the session-creation branch, where two seats can both
  find no session and both attempt `new-session`.

### 2. An operator close tears the window down (`(was tmuxTeamSeating.ts:99 — that module is DELETED)`, `src/services/goPtyFleetProjection.ts` close path, Terminals panel close verb)

- **Logic:** thread an explicit `reason` through the close path — `operator-close` kills the window
  (and the session when it was the last one), `pty-exit` leaves it, preserving crash survival.
- **Implementation:** `kill-window -t ${session}:${win}` for a seat; the existing `kill-session` when
  the team is released or the last window goes.
- **Reason origin (load-bearing):** `operator-close` is set **only** by the UI close verb (the
  Terminals panel close button → `kill()`). The natural-exit arm (WebSocket `closed` event,
  `goPtyFleetProjection.ts:705`) and `dispose()` MUST leave the reason unset — unset defaults to
  `pty-exit` = survive. If the reason is threaded from the wrong arm, every natural exit tears down
  its surviving agent and crash survival is silently inverted. This sentence is the contract.
- **Targeting:** once change 1 has landed, window names are unique within a session and
  `kill-window -t ${session}:${win}` is unambiguous. Ship changes 1 and 2 together. If they cannot
  ship together, change 2 must target by window index (from `list-windows -F '#{window_index}'`)
  rather than by name, because a pre-existing orphan can share the name with the live seat and
  `kill-window` kills the first match.

### 3. Reap orphaned `lc-*` sessions at host startup

- **Logic:** on boot, list `lc-*` sessions and windows, compare against sessions the host owns, and
  kill what nothing claims. Report what was reaped rather than doing it silently.

> **Superseded:** runs after seat projection so a legitimate reattach is never mistaken for an orphan. That ordering is the whole safety argument — a session the host is about to adopt is not an orphan, so no further guard is needed.
> **Reason:** At host startup the Go PTY fleet cache is empty — the host just booted, no PTYs are live, and no team is re-seated (teams start on demand, not auto-respawned). An ownership set drawn from the in-memory seat projection is the null set at boot, so a reaper comparing `tmux ls` against it would reap *every* surviving `lc-*` session — the opposite of crash survival. The eight orphans in the evidence only survived because nothing reaped; shipping the reaper as specified would make a restart more destructive than the bug.
> **Replaced with:** The ownership signal is the **persisted `runtime.terminals` registry** (`db.getConfigJson('runtime.terminals')`), which survives restarts. A `lc-*` session is "owned" iff its name appears as a `sessionName` on a row with `ideName === 'switchboard-tmux'` (and `status !== 'exited'`) in that registry. The reaper runs after `tmuxFleetService.reconcile()` (`bootstrap.ts:4145`) has refreshed the registry from live panes — that reconcile marks dead panes `exited` but does not delete their rows, so a session the host still claims is not mistaken for an orphan. Sessions in `tmux ls` but absent from the registry (or present only on `exited` rows) are orphans and are killed.

- **Implementation:** in `bootstrap.ts`, after the `tmuxFleetService.reconcile()` block (around line
  4145-4156), list sessions with `tmux list-sessions -F '#{session_name}' | grep '^lc-'`, read
  `runtime.terminals` from the DB, build the owned set from non-`exited` `switchboard-tmux` rows'
  `sessionName`, and `kill-session` every `lc-*` session not in that set. Use the existing `run()`
  helper with the resolved `tmuxSocket` (a non-default socket must be parameterised or the reaper
  inspects the wrong server — same reason `startTmuxReconcilePoll` is handed the socket).
- **Reporting:** log the reaped session names via the existing `log(opts, ...)` channel. This is a
  log line on a headless host, not operator-visible UI; it becomes visible in the tmux tab once
  change 4 lands. Do not claim operator-facing visibility the host does not deliver.

### 4. Show and kill sessions from the tmux tab (depends on the tabs plan)

- **Logic:** the session list that plan already adds gains a window count per session and a kill
  control per session and per window, plus a "reap orphans" action running change 3 on demand.
- **Implementation:** duplicate window names must be rendered distinctly (index, not name) or the UI
  reproduces the ambiguity that caused this.

### 5. Team start is idempotent

- **Logic:** starting a team that already has a session seats into it. With change 1 in place this
  falls out for free, but it needs asserting so it cannot regress.
- **Test home:** `test:contract:tmux-team-start-idempotent` (new) — start a four-role team twice
  against a real tmux socket and assert `tmux list-windows -t lc-<team> | wc -l` equals 4, not 8.
  Added to the Verification Plan below.

### 6. A solo seat is one session, not two (`src/services/goPtyFleetProjection.ts:255`)

- **Logic:** create a view session only when the seat shares a window list with siblings. If the
  seat's window is the session's only window, let the pane attach to the session directly.
- **Implementation:** the empty-suffix case is exactly "this window IS the session", which today
  falls back to the role. Branch there: empty suffix plus a single-window session means
  `view = session` and no `new-session -A`. Keep the role fallback for a genuine team head, whose
  session also holds its siblings' windows.
- **`status off` must move with it:** a solo seat's pane would attach to the session itself, so the
  option set on the view path today has to be applied to that session or the strip returns to that
  pane (see `test:contract:tmux-view-chrome`, which asserts the base keeps its strip — that assertion
  needs revisiting for the solo case, where base and view are the same session).
- **Test home:** `test:contract:tmux-solo-seat-single-session` (new) — compose the command for a
  standalone seat and assert it contains no `new-session -A`; for a team member, assert it does.
- **Why it matters beyond tidiness:** each inert base carries a group membership and a `tmux ls` row.
  That noise is what made the duplicate windows above hard to see in the first place.

## Verification Plan

### Automated Tests

- `test:contract:tmux-seat-reuse` (new) — compose the seating command for a seat whose window already
  exists and assert it contains no `new-window`; for one whose window does not, assert it does.
  Assert the name-test uses `grep -Fxq` (fixed-string, `--`), not bare `grep -qx`.
- Re-seat the same four-role team twice against a real tmux socket; assert `tmux list-windows -t lc-<team> | wc -l`
  returns exactly **4**, not 8. This is the test that would have failed today.
- `test:contract:tmux-team-start-idempotent` (new) — change 5's regression guard; same shape as above,
  asserts idempotent team start by window count.
- Close with `reason: 'operator-close'` kills the window; `reason: 'pty-exit'` (and unset reason) does
  not. Assert the natural-exit/WebSocket arm leaves the reason unset.
- Startup sweep with one claimed (registry-present, non-`exited`) and one unclaimed `lc-*` session
  kills exactly the unclaimed one. Assert the owned set is read from `runtime.terminals`, not from
  the in-memory fleet cache (which is empty at boot).
- Extend `src/test/tmux-backend-contract.test.js`.

### Goal Invariants

- For any team session, `tmux list-windows -t lc-<team> | wc -l` equals the team's roster size. No team ever holds two windows of one name. (Executable: assert the count, not prose.)
- After a host start, `tmux list-sessions -F '#{session_name}' | grep '^lc-'` returns no session absent from the non-`exited` rows of `runtime.terminals`. (Negative + positive: orphans gone here, owned sessions still resolvable there.)
- A solo seat has exactly ONE session. `tmux list-sessions` shows no `lc-*` session that has no
  clients and shares every window with another session. (Executable: for each `lc-*` session, assert
  `#{session_group_size}` is 1, or that the session has a client.)
- A PTY exit still leaves its window alive — `tmux list-windows -t lc-<team>` count is unchanged after a natural PTY exit (the crash-survival property must not regress).

### Manual

1. Start the Coding team, `tmux list-windows -t lc-coding-team` → 4.
2. Start it again → still 4, and the agents are the same processes (PIDs unchanged).
3. Restart the host → still 4.
4. Close one seat in the Terminals panel → 3, and its agent process is gone.
5. Create an orphan by hand (`tmux new-session -d -s lc-fake-team`), restart the host → reaped (and the reaped name appears in the host log).
6. Start four standalone planner seats → `tmux ls` shows four sessions, not eight, and none is
   clientless. Before this change the same fleet showed 14 sessions for 9 panes.

## Outstanding Questions

- **[user] What are re-seat semantics?** This is the real question under the bug. Pressing START TEAM
  on a team that is already up should give either **reattach** (the running agents, with their
  existing context — what the comment claims, and what the fix above implements) or **replace** (old
  windows killed, fresh agents with clean context — `kill-window` then create). Appending is the only
  answer that is definitely wrong, and it is the current behaviour. The fix differs depending on which
  is wanted.

- **[user]** Should the tmux tab show sessions the host does **not** own at all (a hand-rolled `tmux new-session`
  by the operator), or only `lc-*`? Showing everything makes the tab the honest answer to "what is
  running"; showing only `lc-*` keeps it scoped to what the board created. — proceeding on the
  assumption that the tab shows `lc-*` only, matching the reaper's scope, until the user decides
  otherwise.
