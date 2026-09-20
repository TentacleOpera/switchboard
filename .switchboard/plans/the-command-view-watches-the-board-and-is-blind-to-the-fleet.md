# The Command Panel Shares, It Does Not Reimplement

## Goal

The command panel renders answers the host gives it and derives nothing of its
own. Every local re-derivation goes — six of them — and the panel learns about a
change **when it happens**, the way the terminals panel does.

The goal is not "fix the six". It is that the surface stops being a place where
a seventh can be added.

## Problem analysis

### It was not built this way. It accreted.

`command.js` was born on 2026-08-31 (`0b91aa16`) as a thin touch surface — 1,196
lines, *"four sub-nav views… Buttons and dropdowns only — zero text inputs."* At
birth it contained **none** of the duplications below: no `resolveTeamSeats`, no
`TEAM_ROLE_ART`, no `SEED_TEAM_IDS`, no `filterByProjectFor`.

It is now **2,998 lines across 28 commits**. Every one of those rules arrived
later, because a feature needed an answer and deriving it locally was the
shortest path. Each addition was small and individually defensible. Together they
are a second implementation of the product, kept in a file that cannot be
imported into and is never compiled against the first.

**That is why the fix cannot only be "delete the six".** Nothing stopped the
first one, so nothing stops the seventh.

### What it re-derives, and who already owns the answer

| in `command.js` | the authority it ignores |
| :--- | :--- |
| `resolveTeamSeats` | `resolveTeamMembersForHead` (`teamWiring.ts:3230`) |
| `SEED_TEAM_IDS` | `defaultTeamIds`, **already on the wire** from `ptyListAgentGroups` |
| `TEAM_ROLE_ART` | the icon set — it pointed at `team-*.png` after the art became SVG |
| `resolveTeamArt` | the host's icon tables (`headlessPanelHtml`) |
| `declaredSeatCount` | member counts the host holds |
| `filterByProjectFor` | the board projection |

The `defaultTeamIds` row is the sharpest: the host **anticipated this exact
problem, shipped the fix, and documented it** —

> Derived, never typed: the shipped default ids … come from
> `DEFAULT_TEAM_DEFINITIONS`, so a roster edit changes them by construction.
> **The webviews consume these rather than keeping their own copy.**

— and the field was sitting in the response `command.js` was already parsing,
while it kept a typed list of three for a product that ships five. (Fixed in
`5952be84`, along with the two icon rows.)

**And the panel shares nothing.** `sharedDefaults.js` exists as a shared webview
module; `command.js` does not reference it once.

### Why the terminals panel needs no guards and this one is full of them

**The terminals panel renders one list.** A terminal is in the fleet or it is
not. There is nothing to reconcile, so there is nothing to guard.

**The teams roster joins two lists in the browser** — team definitions × live
fleet — and re-derives a relationship the host already knows.
`resolveTeamMembersForHead` (`teamWiring.ts:3230`) answers it on the host;
`resolveTeamSeats` (`command.js:27`) is a **second implementation of the same
question**, and it is invoked from two places in the client
(`renderTeamsView:1289`, `buildFleetRoster:2323`).

Every "guard" is a rule in that re-derivation:

| rule | what it is compensating for |
| :--- | :--- |
| exclusive claim (`pool.splice`) | two teams could match one seat |
| claim-order sort | a seed could steal a real team's seat |
| `SEED_TEAM_IDS` | hide unstarted shipped defaults — a hard-coded list, already drifted 3 vs 5 |
| "NO ROLE FALLBACK" | a dormant team adopted a stranger's seat |
| `isDormant = !liveSeat` | liveness inferred, not told |

Each is a second copy of a host rule, which is why they drift and why they
multiply. The display surface is not complicated — it was handed a join it
should never have been given.

**The host already has everything the join needs:** a live group row names its
head, members and `definitionId`, and every seat's `parentInstanceId` points at
its head's `agentInstanceId`. Nothing in the browser knows anything the host does
not know better.

### The asymmetry, stated plainly

- **The terminals panel is subscribed to the fleet.** It holds live WebSockets
  per terminal and has a `SURFACES.terminals` broadcast channel.
- **The command view is subscribed to the board.** Its entire message handler is
  two arms:

  ```js
  if (msg.type === 'updateBoard') { ... }
  else if (msg.type === 'moveCards') { ... }
  ```

  Both are card events. **No fleet event reaches it.**

There are eleven WS surfaces — `common, connections, design, kanban, memo,
planning, project, setup, terminals, tickets` — and **there is no `command`
surface**. The cockpit has no channel to receive fleet changes on.

### What that makes the teams roster

Live-vs-dormant is derived entirely from `ptyListTerminals`, fetched in
`refreshAllData()` — on init and on workspace change — and, since `bfae8a18`,
after a start attempt. Between those moments the roster is a **photograph**.

Start a team from the terminals panel, from `lc`, or by dispatching a card, and
the command view never hears. It keeps drawing DORMANT with a START button for a
team that is running.

### The guard is not the bug; it is the last line taking every hit

`startTeamById` refuses a second start: *"Team X is already running as Y. Stop it
first — a second head is not started."* That is correct and load-bearing — it is
the only thing between a stale click and two heads on one team.

But that refusal is **only ever produced when the client's picture is wrong**.
The host knows the team is up; the view is still offering to start it. A guard
that fires in normal operation is a symptom of a UI that is lying, not a bad
guard. The first line of defence — a view that knows what is running — does not
exist, so the last line absorbs every miss.

### Measured, three times

- **Coding team, 2026-09-20 morning.** Roster showed every team `0 live ·
  DORMANT` while Coding ran with its intern. Pressing START drew the refusal.
- **Planning team, same day.** Identical: Planning live with three seats, card
  stale, START refused with *"already running as Planning"*.
- Each time, `ptyListTerminals`, `ptyListAgentGroups` and `resolveTeamSeats` were
  verified correct against the running host. **They were correct.** The client
  had stopped asking.

That is the signature of this defect: every server-side check passes, because
nothing server-side is wrong.

### `bfae8a18` closed one path of several

It makes a refused start refetch. It does nothing for: a team started from
another surface, a seat exiting, a team stopped elsewhere, or a head dying. All
of those still leave the roster asserting a state that is no longer true.

## Metadata

**Complexity:** 5
**Tags:** command-view, fleet, websocket, surfaces, staleness, standalone
**Scope:** `src/webview/command.js`, the surface list and broadcast plumbing
(`SURFACES`, `mirrorToWs`), and whatever emits fleet-change events today.
**Standalone only** — the command view is a standalone-host surface.

## Constraints

**Do not poll the fleet on a timer as the fix.** A poll narrows the window and
keeps the same failure, now intermittent and harder to reproduce. The terminals
panel does not poll for this; neither should the cockpit.

**Keep the guard.** `startTeamById`'s double-start refusal stays exactly as it
is. This plan aims to make it unreachable in normal use, not to remove it. A
guard that never fires is the goal; a guard that is deleted is a second head.

**An unknown fleet is not an empty fleet.** Already true after `39ea2ac5` — a
failed read renders UNKNOWN, not DORMANT. A push-based path must preserve that:
"no event yet" and "nothing running" must not render the same.

**One resolver, on the host.** The browser must not decide which seat belongs to
which team. That decision exists on the host, is used by dispatch, and is the
thing the client kept getting subtly wrong. A client that renders cannot drift
from a client that decides, because it no longer decides.

## Proposed changes

### 1. Delete all six re-derivations, not just the team one

`resolveTeamSeats`, `SEED_TEAM_IDS`, `TEAM_ROLE_ART`, `resolveTeamArt`,
`declaredSeatCount` and `filterByProjectFor` come out. Each is replaced by a
value the host supplies or a module the panel shares — never by a corrected
local copy, because a corrected copy is still a copy.

`5952be84` already did the three cheapest: seed ids now come from
`defaultTeamIds`, and the two icon tables were repointed and the brand table
moved into the host's shared `brandIconAttrs`. The remaining three are below.

### 2. The host returns teams already resolved

One read that answers the whole question: for each team — its definition, its
resolved head, its live seats, whether it is running, and whether it is a shipped
default. Computed with `resolveTeamMembersForHead`, the resolver the host already
owns and dispatch already trusts.

The client then renders what it is given. **`resolveTeamSeats`, the claim-order
sort, `SEED_TEAM_IDS`, the role-fallback comment and `isDormant` inference are
deleted from `command.js`** — both copies. Nothing replaces them, because there
is no join left to do.

`SEED_TEAM_IDS` in particular stops being a list anyone maintains: the host tags
each team as shipped or operator-made, so a custom team needs no special case and
there is nothing to drift.

### 3. The command view gets a surface, and fleet events reach it

Add the cockpit to the surface set so it can receive pushes, and broadcast fleet
changes — seat started, seat exited, team seated, team stopped — to it. The
mechanism exists (`mirrorToWs`); today only `startupCommandsChanged` is mirrored
to the terminals surface.

### 4. The roster re-renders on a fleet event

On a fleet change the view refetches **the resolved team list** and re-renders. No card state is
inferred from the event payload itself — the event says *something changed*, and
the view asks. That keeps one source of truth and makes a missed or malformed
event harmless.

### 5. Every action handler refreshes on both outcomes

`bfae8a18` fixed `seatTeam`. Sweep the other action handlers in the view for the
same shape — a refresh in the success arm only — and correct them. The failure
arm is the one that matters, because a failure is evidence the view is wrong.

### 6. The roster says how fresh it is

A view that can be stale should say when it last heard from the host, so a wrong
card is legible as a stale card rather than as a broken product. Small, and it
is what turns the next occurrence into a one-line report instead of three rounds
of debugging.

### 7. A rule that stops the seventh

The panel gets a stated rule — in the file's own header, where the next author
will read it — that it renders host answers and derives nothing about teams,
membership, seeds, icons or projects. Paired with the grep gate below.

This is the only enforcement in the plan, and it is here because the accretion
history is the evidence for it: six rules arrived one at a time, each
justifiable, with nothing to say no.

## Verification plan

### Automated

- **A team started from another surface updates the cockpit** with no user
  action and no page reload. This is the case none of the current paths cover.
- A seat exiting, and a team being stopped elsewhere, both update it.
- **The double-start refusal becomes unreachable** in the normal path: with the
  subscription live, the roster never offers START for a running team. Asserted
  by driving a start from elsewhere and checking the button's state.
- The guard still refuses a genuine double start — asserted directly, so making
  it unreachable is never mistaken for removing it.
- A dropped socket renders **UNKNOWN**, not DORMANT, and recovers on reconnect.
- No timer polls `ptyListTerminals` for roster freshness.
- **`command.js` contains no team-membership logic** — no `resolveTeamSeats`, no
  claim-order sort, no `SEED_TEAM_IDS`, no dormant inference. A grep gate, because
  the pull is to add "just one" rule back.
- The host's resolved team list matches `resolveTeamMembersForHead` for the same
  fleet — one resolver, asserted against itself rather than two compared.
- A custom team renders correctly with no id list anywhere.

### Goal invariants

- The cockpit knows what is running, without being asked.
- A guard firing is evidence of a defect, not part of normal operation.
- "Not heard yet" and "nothing running" never render the same.
- One resolver, on the host. The browser renders and decides nothing.

### Manual

Open the cockpit on a phone. Start a team from the terminals panel on the
desktop. The phone should show it live without a reload. Stop it; the phone
should follow.

## Outstanding questions

- **Does the cockpit need its own surface, or should it join `terminals`?** A
  separate surface is cleaner to reason about; joining the existing one is less
  plumbing and gets the same events. Decide before change 1 — it is the shape of
  the whole change.
- **What emits fleet-change events today?** The pty host knows, and the terminals
  panel reacts, but whether there is a single emit point to hang a second
  subscriber on, or whether that needs building, decides the size of this plan.
