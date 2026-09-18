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
— `for (const team of teamsArr)` (`shell.js:594`) and nothing else. There is no
unassigned button.

> **Superseded:** "the unassigned group tab is hidden in team scope by
> `body.is-team-scoped .group-tab-strip > .group-tab-row { display: none }`, so
> from a team view the only way out is the team header's back button."
> **Reason:** No such CSS rule exists — the team-scoped rules at
> `terminals.css:2464-2494` keep the tab strip *visible* precisely so it can
> carry the exit gesture, and the team-header back button was deleted (its
> `.team-header-back` rules removed with it — see the comment at
> `terminals.css:2521`). `exitTeamScope`'s own docblock
> (`terminals.js:11757-11758`) still says "the back button in
> renderTeamHeader" — stale, correct it while there.
> **Replaced with:** The exit gesture is the **"← All" tab** that
> `renderGroupTabStrip` renders at the head of the tab row in team scope
> (`terminals.js:5072-5082`), styled `.group-tab`, wired to `exitTeamScope()`.
> So a gesture that reaches unassigned from a team *does* exist — it just seats
> the wrong terminals, which is the bug below. What genuinely does not exist is
> rail reachability.

**That exit gesture seats unassigned wrongly — blank panes, and teams bleed in.**

`clearGroupLock` (`terminals.js:4025`) is the *correct* seating: it filters to
`getUnassignedTerminalNames()` (`terminals.js:4495`), drops pins whose occupant
is no longer unassigned, and sizes with
`smallestLayoutFitting(unassignedNames.length)` (`terminals.js:4065`).

`exitTeamScope` (`terminals.js:11760`) does not call it. It reimplements the
seating and gets both halves wrong:

- It restores `paneAssignments` from the fleet's persisted layout keys via
  `loadLayoutSettings()`. Those keys were last written by the fleet view holding
  grouped and team terminals. **That is the bleed.**
- It sizes with `setLayoutMode(layoutForFleetCount(fleetList.length))`
  (`terminals.js:11801`) — the *whole* fleet, every team's seats included — over
  a `paneAssignments` that holds only the names that survived. A nine-slot grid
  over four names is five empty panes. **That is the blank panels.**

`clearGroupLock` also opens with `if (teamScopeId) { return; }`
(`terminals.js:4030`), so even a programmatic call cannot reach the correct
path from inside a team.

The prior art names this and defers it. *Rename group tab "All" to "Unassigned"*
(COMPLETED) carries a section headed **"Known Limitation — Snapshot, Not Enforced
Invariant"**: *"Broader invariant enforcement (filtering sidebar clicks, fixing
the load path) is deferred."* This subtask is the entry half of that deferral.

## Metadata

- **Complexity:** 5
- **Tags:** frontend, ui, ux, bugfix
- **Project:** Browser Switchboard

## User Review Required

None. The one real fork — what "unassigned" *is* — is already decided: the
shipped `activeGroupId === null` complement model wins and the `__unassigned__`
pseudo-group is rejected, with the deciding collision recorded under "The model
decision" below. That decision is not re-opened here.

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

- Lift `clearGroupLock`'s filter-and-size body (`terminals.js:4036-4074`) into
  `seatUnassignedFleet()`. `clearGroupLock` keeps its lock-clearing preamble
  (`captureKanbanPanesFor`, `activeGroupId = null`, `activeGroupPage = 0`,
  `restoreKanbanPanesFor(null)`) and calls it. The lifted body ends in
  `saveLayoutSettings()`, which writes under whatever scope is current — so
  `seatUnassignedFleet` must only ever run with `teamScopeId` already null,
  and that ordering is part of its contract.
- Add `enterUnassignedScope()` — the single "go to unassigned" path, mirroring
  `enterTeamScope`'s shape. In order:
  1. `teamScopeId = null`, remove `is-team-scoped`, `document.title =
     'Terminals'`, clear `_queueItems`/`_queueMode` (the queue belongs to the
     team — `exitTeamScope` does this at `terminals.js:11764-11767` and the
     rail path must not skip it).
  2. The lock/kanban bookkeeping from `clearGroupLock`'s preamble
     (`captureKanbanPanesFor` / `restoreKanbanPanesFor(null)`), so entering
     unassigned restores the unlocked view's kanban panes exactly as the tab
     click does today.
  3. `await loadLayoutSettings()` — still needed for pane *modes* and pins —
     wrapped in `exitTeamScope`'s `savedGroups` snapshot-and-merge
     (`terminals.js:11784-11795`) **verbatim**: the load replaces
     `terminalGroups`, and a stale read without the merge empties the rail's
     teams array and resurrects individual terminals on the rail. This is the
     "keep the load" half of "delete the seating, keep the load" — do not drop
     it with the seating.
  4. `activeGroupId = null; activeGroupPage = 0` AFTER the load, because the
     load restores the fleet's persisted lock.
  5. The same race discipline `enterTeamScope` carries: re-check
     `teamScopeId === null` after the await; a newer `enterTeamScope` that
     landed during it owns the panel.
  6. `seatUnassignedFleet()`, then `renderSidebarList()` and
     `postFleetStateToShell()`.
  Idempotent when already unscoped — the rail button is clickable from the
  fleet view, where it is a legitimate "reset my composition" gesture, the
  same reading `clearGroupLock` already gives the Unassigned tab.
- Add the `switchToUnassigned` message arm beside the existing `switchToTeam`
  arm (`terminals.js:1364`), with the same `event.origin !== location.origin`
  guard its neighbours carry. It calls `enterUnassignedScope()`.
- **Delete `exitTeamScope`'s reimplementation.** No
  `setLayoutMode(layoutForFleetCount(fleetList.length))`, no reliance on the
  fleet's persisted `paneAssignments` for seating. Everything it does that is
  not seating is enumerated in the step list above; once `enterUnassignedScope`
  absorbs it, `exitTeamScope` becomes a call to it. Its stale docblock
  ("Called by the back button in renderTeamHeader", `terminals.js:11757`) is
  corrected in the same diff — the caller is the "← All" tab.
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

## Dependencies

None pending — this is the feature's first subtask and lands first. Every plan
it might appear to wait on is already shipped (see the Edge-Case audit above).
The feature's later subtasks depend on it, not the reverse:
`a-warm-set-keeps-a-scopes-sockets-open-so-switching-back-is-not-a-replay.md`
names unassigned as a ledger scope (`null`) and routes its entry through
`enterUnassignedScope`, so it assumes this subtask's single-entry path exists.

## Adversarial Synthesis

The main risk is that `exitTeamScope` is doing something else load-bearing that
reads as seating. It is: the scope-key remap. The change is therefore specified
as "delete the seating, keep the load", not "replace the function". Second risk
is the model decision being quietly reversed by whoever implements the
ungrouped-terminals plan later; mitigated by stating the collision in both plans
with the failing mechanism named, rather than by a bare "do not do this".

## Verification Plan

### Automated Tests

- Rail shows an Unassigned button on a fresh workspace with zero teams, and with
  three teams running.
- From a team view, click Unassigned: the grid holds exactly the unassigned
  terminals, sized `smallestLayoutFitting` to that count — no empty panes, no
  team members.
- Same via the "← All" tab in the group tab strip — both paths produce an
  identical grid.
- Group one of the unassigned terminals, re-enter: it is gone from the grid and
  the count drops.
- Zero unassigned terminals: one empty pane, no error.
- Two rapid clicks — Unassigned then a team — land on the team, and the reverse
  order lands on unassigned: the loser must not seat over the winner.
- `npm run compile-tests` before any `test:contract:*` script.

### Goal Invariants

1. `exitTeamScope` in `src/webview/terminals.js` contains no
   `setLayoutMode(layoutForFleetCount(` call and no `paneAssignments` seating
   loop of its own — its only exit behaviour is delegating to
   `enterUnassignedScope`. *(Negative — the duplicated seating is gone.)*
2. `seatUnassignedFleet` exists in `src/webview/terminals.js` and is called by
   both `clearGroupLock` and `enterUnassignedScope`. *(Paired positive — the
   seating survives, at the single shared site.)*
3. `renderTerminalSection` in `src/webview/shell.js` renders a button that
   posts `{ type: 'switchToUnassigned' }`, rendered whether or not any
   unassigned terminal exists.
4. A `switchToUnassigned` arm exists in the `terminals.js` message handler
   beside `switchToTeam`, guarded by `event.origin !== location.origin`.
5. `enterUnassignedScope` retains the `savedGroups` snapshot-and-merge around
   `loadLayoutSettings` — assert the merge loop is present in its body.

## No migration

No setting is renamed, dropped or repurposed. `terminals.paneAssignments` and
the `terminals.team.<id>.*` family are read and written in their existing shapes.
