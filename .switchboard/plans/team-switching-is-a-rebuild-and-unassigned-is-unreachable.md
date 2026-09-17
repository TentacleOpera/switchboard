# Unassigned Is Reachable From The Rail, And Entering It Seats Only Unassigned Terminals

## Goal

Give the unassigned fleet a button on the shell rail beside the team icons, and
make entering it — from the rail or from a team's back button — produce a grid
of exactly the unassigned terminals at exactly the right size. Today there is no
gesture that reaches it from a team, and the one gesture that exists seats the
wrong terminals into the wrong number of panes.

### The problem, and the root cause

**Unassigned is unreachable from the rail.** `renderTerminalSection`
(`src/webview/shell.js:556`) rebuilds the rail's fleet region from `teams` alone
— `for (const team of teamsArr)` and nothing else. There is no unassigned
button. Inside the panel, the unassigned group tab is hidden in team scope by
`body.is-team-scoped .group-tab-strip > .group-tab-row { display: none }`, so
from a team view the only way out is the team header's back button.

**That back button seats unassigned wrongly — blank panes, and teams bleed in.**

`clearGroupLock` (`terminals.js:4030`) is the *correct* seating: it filters to
`getUnassignedTerminalNames()` (`terminals.js:4495`), drops pins whose occupant
is no longer unassigned, and sizes with
`smallestLayoutFitting(unassignedNames.length)`.

`exitTeamScope` (`terminals.js:11760`) does not call it. It reimplements the
seating and gets both halves wrong:

- It restores `paneAssignments` from the fleet's persisted layout keys via
  `loadLayoutSettings()`. Those keys were last written by the fleet view holding
  grouped and team terminals. **That is the bleed.**
- It sizes with `setLayoutMode(layoutForFleetCount(fleetList.length))` — the
  *whole* fleet, every team's seats included — over a `paneAssignments` that
  holds only the names that survived. A nine-slot grid over four names is five
  empty panes. **That is the blank panels.**

`clearGroupLock` also opens with `if (teamScopeId) { return; }`, so even a
programmatic call cannot reach the correct path from inside a team.

The prior art names this and defers it. *Rename group tab "All" to "Unassigned"*
(COMPLETED) carries a section headed **"Known Limitation — Snapshot, Not Enforced
Invariant"**: *"Broader invariant enforcement (filtering sidebar clicks, fixing
the load path) is deferred."* This subtask is the entry half of that deferral.

## Metadata

- **Complexity:** 5
- **Tags:** frontend, ui, ux, bugfix
- **Project:** Browser Switchboard

## Scope: standalone only

`src/webview/shell.js`, `src/webview/terminals.js`, `src/webview/terminals.html`
— the browser cockpit, served by the standalone host. Per CLAUDE.md the VS Code
extension host is out of scope and is not to be wired for any of it; "the
extension does not have it" is the intended state, not a divergence. No
`extension.ts` composition-root seam is added or changed.

## The model decision — read this before touching the group code

There are two live designs for "what is unassigned", and they cannot both land.

- **Shipped (this subtask builds on it):** unassigned is `activeGroupId === null`
  plus a computed complement. `getUnassignedTerminalNames()` derives it as
  `fleetList.filter(live && !parentInstanceId).filter(t => !findGroupForTerminalName(t))`.
  There is no id for it.
- **Proposed (`feature_plan_20260812212102_ungrouped-terminals-get-their-own-grid.md`,
  PLAN REVIEWED):** unassigned is a first-class pseudo-group with reserved id
  `__unassigned__`, taught to `getAllGroups()`, `getGroupMembers()` and
  `findGroupForTerminalName()`.

**The shipped model wins, and the pseudo-group is not to be introduced.** The
deciding fact is a collision that plan cannot know about, because
`getUnassignedTerminalNames()` was added *after* it by the COMPLETED rename:
making `findGroupForTerminalName()` return a pseudo-group for ungrouped
terminals inverts that function's filter to always-false and
`getUnassignedTerminalNames()` returns an **empty list** — the unassigned grid
seats nothing, the tab count reads zero, and this subtask's rail button reads
zero with it.

That plan has been trimmed to the scope it uniquely owns (the click-router
conscription bug) and no longer proposes the pseudo-group. Do not reinstate it
here or there.

## Proposed changes

### 1. `shell.js` — an Unassigned button leading the fleet region

In `renderTerminalSection`, before the team loop, render one **Unassigned**
button. It renders whether or not any unassigned terminal exists, so the rail's
height does not track fleet state — the same discipline the fixed team slots
already follow. It carries the unassigned count and posts
`{ type: 'switchToUnassigned' }` to the terminals iframe.

This does **not** reinstate per-terminal rail buttons. *Shell Rail Restructure*
deleted the ungrouped-terminal loop deliberately (one button per terminal, rail
height tracking fleet size). This is one fixed button for the scope, which is
the opposite shape, and is consistent with that decision.

`postFleetStateToShell` gains the unassigned count. The shell's fallback
`requestFleetState` path (`shell.js:811`) must not render a rail with teams but
no unassigned button on a partial payload.

### 2. `terminals.js` — one seating routine, two callers

- Lift `clearGroupLock`'s filter-and-size body into `seatUnassignedFleet()`.
  `clearGroupLock` keeps its lock-clearing preamble and calls it.
- Add `enterUnassignedScope()`: clears `teamScopeId`, removes `is-team-scoped`,
  re-reads the unprefixed layout keys (still needed for pane *modes* and pins),
  then calls `seatUnassignedFleet()`.
- Add the `switchToUnassigned` message arm beside the existing `switchToTeam`
  arm (`terminals.js:1364`), with the same `event.origin` guard its neighbours
  carry.
- **Delete `exitTeamScope`'s reimplementation.** No
  `setLayoutMode(layoutForFleetCount(fleetList.length))`, no reliance on the
  fleet's persisted `paneAssignments` for seating. It becomes a call to
  `enterUnassignedScope()`.
- Relax `clearGroupLock`'s `if (teamScopeId) { return; }` into an assertion that
  the caller has already cleared the scope, so the namespaced-write hazard the
  guard exists for stays impossible but the path is reachable.

### 3. Out of scope, stated so it does not look covered

The pollution sites the COMPLETED plan listed — `handleLockedTerminalClick`,
`setLayoutMode`, `assignToFocusedPane` — corrupt an unassigned grid *during*
interaction. This subtask fixes *entry*. `handleLockedTerminalClick` is owned by
the trimmed ungrouped-terminals plan; the other two remain unowned.

## Complexity Audit

### Routine
- The rail button and its message arm (mirrors the existing `switchToTeam` arm).
- Lifting `clearGroupLock`'s body into `seatUnassignedFleet()`.
- Threading the unassigned count through `postFleetStateToShell`.

### Complex / Risky
- **`exitTeamScope`'s `loadLayoutSettings()` is load-bearing for more than
  seating.** It is what maps the setting keys back from
  `terminals.team.<id>.*` to unprefixed. Removing the *seating* that follows it
  must not remove the load — drop the wrong half and the next
  `saveLayoutSettings()` writes the team's layout over the fleet's keys, which
  is the clobber the entry path already guards against.
- **`seatActiveGroupPage` has a shipped re-seat caller in `fetchTerminalList`.**
  `terminals.js:2558` re-seats the locked group on every fleet fetch, gated on
  `lastSeatedLiveCount` changing. It keys on `activeGroupId`. Changing what
  "exit scope" seats must not leave that gate holding a count for a group the
  panel is no longer showing, or the next poll re-seats over the unassigned
  grid.

## Edge-Case & Dependency Audit

**Race conditions**
- Rapid rail clicks across scopes. `enterTeamScope` re-checks
  `teamScopeId !== groupId` after each await; `enterUnassignedScope` needs the
  same discipline, or a slow team entry lands on top of a newer unassigned one.

**Side effects**
- Zero unassigned terminals: the button renders, and clicking it produces a
  one-pane empty grid rather than an error. `smallestLayoutFitting(0)` already
  returns `'1'`.

**Security**
- None. `switchToUnassigned` is a same-origin postMessage on an existing
  channel and takes the same origin guard as its neighbours.

**Dependencies & conflicts**
- **Already shipped, despite their cards:** *Shell Rail Restructure: A Primary
  Group, A Cold Group, And No Process List* and *Three Fixed Team Slots In The
  Rail* both sit in PLAN REVIEWED but are implemented in `shell.js` (`.is-dormant`
  at `shell.html:273`, `railHidden` at `shell.js:774`, `DEFAULT_TEAM_DEFINITIONS`
  at `teamWiring.ts:560`) and both carry past-tense implementation notes. Build
  against the shipped `renderTerminalSection`, not against either plan's "before"
  description. **This is not a sequencing dependency — there is nothing to wait
  for.**
- **`feature_plan_20260812212102_ungrouped-terminals-get-their-own-grid.md`** —
  trimmed to the click-router fix. It must not reintroduce `__unassigned__`.
- **Team grid shows too few terminals on first click** — **already shipped**
  (commit `47c1deca`), despite its LEAD CODED card. Both of its fixes are in
  `terminals.js`: the roster-based sizing in `layoutForGroupSwitch` (`:4460`)
  and the `lastSeatedLiveCount`-gated re-seat in `fetchTerminalList` (`:2558`).
  Treat them as existing behaviour to preserve, not as pending work to sequence
  against.

## Adversarial Synthesis

The main risk is that `exitTeamScope` is doing something else load-bearing that
reads as seating. It is: the scope-key remap. The change is therefore specified
as "delete the seating, keep the load", not "replace the function". Second risk
is the model decision being quietly reversed by whoever implements the
ungrouped-terminals plan later; mitigated by stating the collision in both plans
with the failing mechanism named, rather than by a bare "do not do this".

## Verification

- Rail shows an Unassigned button on a fresh workspace with zero teams, and with
  three teams running.
- From a team view, click Unassigned: the grid holds exactly the unassigned
  terminals, sized `smallestLayoutFitting` to that count — no empty panes, no
  team members.
- Same via the team header's back button — both paths produce an identical grid.
- Group one of the unassigned terminals, re-enter: it is gone from the grid and
  the count drops.
- Zero unassigned terminals: one empty pane, no error.
- `npm run compile-tests` before any `test:contract:*` script.

## No migration

No setting is renamed, dropped or repurposed. `terminals.paneAssignments` and
the `terminals.team.<id>.*` family are read and written in their existing shapes.
