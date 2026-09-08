# tmux Seating Is Team-Only, So a Panel Group Never Gets a Session

## Goal

Make tmux seating apply to **any** collection of terminals, not just teams. A group assembled in the
Terminals panel — the SAVE AS GROUP arrangement, or a handful of seats opened with `+` — should get a
tmux session named for that group, with its terminals named as panes, on the same terms a team does.

### Problem analysis

**Operator statement of intent, verbatim:** *"a group is an impromptu collection of terminals you set
up in the terminals panel. I don't want tmux limited to teams."*

The tmux bridge is built and, as of the change below, reachable. But it is wired at exactly one seam,
and that seam only exists on the team path.

#### What exists

`createTmuxHeadWithDelegates` (`src/standalone/tmuxTeamSeating.ts:203`) creates a session named for
the team (`new-session -d -s <team> -n <headName>`), splits a pane per delegate, sets pane titles, and
on a restart takes the reattach branch (`hasSession` → `checkReconnect`) which **reuses the existing
panes and names** rather than creating new ones. It is wired into both hosts as the
`createHeadWithDelegates` seam — `bootstrap.ts:4006` and `TaskViewerProvider.ts:14073`.

That covers the operator's requirements 2 and 3 **for teams**, and it covers them already.

#### What does not exist

`createHeadWithDelegates` is called from `agentGroupInstantiation.ts:139` — the host-agnostic core of
*instantiate an agent group*, where "group" means a head-plus-delegates **definition authored in the
Agents tab**. That is a team.

A Terminals-panel group is a different thing entirely: a saved pane arrangement in the
`terminals.groups` setting, whose terminals were each spawned individually through
`ptyFleetService.create()` → `GoPtyFleetProjection` → the Go PTY host. That path has no tmux branch at
all. There is no setting, and no code path, that puts an individually-spawned terminal into a tmux
session.

So the shape of the defect is: **tmux ownership is decided by which instantiation path ran, not by the
operator's setting.** Start a team → tmux. Open four terminals and save them as a group → never tmux,
regardless of the toggle.

#### Why this is a design change and not a wiring fix

Two fleet services implement the same surface and a terminal belongs to exactly one:

| | owns | created by |
| :--- | :--- | :--- |
| `GoPtyFleetProjection` | PTYs in the Go host | `ptyFleetService.create()` |
| `TmuxFleetService` | adopted/owned tmux panes | `createTmuxHeadWithDelegates`, `adopt` |

Routing single-terminal creation through tmux means choosing the backend **at create time**, and then
every consumer that resolves a terminal by name — dispatch, delivery, the liveness sweep, the panel's
pane assignments — has to keep working across both. That is the part to design, not to improvise.

### What has already been done (not part of this plan's work)

Landed while diagnosing, because the feature was unreachable at all:

- `switchboard.terminal.tmux.enabled` now defaults to **true** in all three deciding places:
  `package.json`, `bootstrap.ts:4100`, `cli.ts:4526`.
- An **Enable tmux** checkbox at the top of the Terminals panel (`terminals.html`), wired in
  `terminals.js` to read on load and persist on change.
- **The prefix lock is gone.** `getSetting`/`saveSetting` hardcoded a `switchboard.prompts.` prefix in
  both hosts (`kanbanService.ts`, and two fallback sites in `KanbanProvider.ts`), which made every
  contributed setting outside that namespace unreadable and unwritable from any UI. That is why no
  checkbox could have existed before: the key was not addressable. Keys already carrying the
  `switchboard.` namespace are now treated as absolute; relative keys are unchanged.

---

> **Superseded (2026-09-08, by shipped code — commit `e60e3982`):** "no setting can put a group in
> tmux… with one create path the group case stops being a design problem."
> **Reason:** The design change was not needed. `ptyCreateTerminal` (`bootstrap.ts:2159`) simply had no
> tmux branch, while the team path has had one at the `createHeadWithDelegates` seam since Part 4.
> Adding that branch was contained: dispatch (`triggerAction`, 6 tmux lookups) and delivery
> (`sendToTerminal`, 3) already resolve a tmux-backed seat by name, `createTmuxHeadWithDelegates`
> already reattaches by name on restart, and its delegate work is a loop over `delegateSpecs` — so a
> lone agent is a team of one. Verified live: `POST /terminals/verb/ptyCreateTerminal {"role":"coder"}`
> returned `{success:true, paneId:"%13", sessionName:"sb-team"}` and `tmux ls` went 1 → 2.
> **What remains of this plan:** ONE thing — the session is named `sb-team`, not for the group. The
> branch passes `payload.groupName || payload.teamName`, and a bare `+` create sends neither, so every
> ungrouped seat piles into one default session. The panel must send the group name on create. That is
> requirement 2 of the operator's spec and is all that is left here; changes 1, 3, 4 and 5 below are
> done or moot.

## Metadata

**Complexity:** 6
**Tags:** tmux, terminals, fleet, standalone-parity
**Dependencies:** none

## User Review Required

None.

## Proposed Changes

### 1. Decide backend ownership at create time, not by call path (`src/standalone/ptyFleetService.ts` seam, both hosts)

- **Logic:** When `terminal.tmux.enabled` is on, a terminal create resolves to a tmux-backed seat; when
  off, to a Go-host PTY. The decision belongs at the single create seam both hosts already share, not
  duplicated at each caller.
- **Edge cases:** tmux absent on the machine (`isTmuxAvailable` false) must fall back to a PTY silently
  rather than failing the create — the toggle is an intent, not a guarantee. Native Windows has no
  tmux; `wslDetect.ts` already covers that and must gate the same way.

### 2. A group is a session; its terminals are its panes

- **Logic:** Session name derives from the group's name for a panel group, the team's name for a team.
  A terminal that belongs to no group goes to a default session rather than one session per terminal.
- **Implementation:** Reuse `deriveTmuxSessionName` so team and group naming cannot drift.
- **Edge cases:** Renaming a group must not orphan its session. Two groups with names that normalise to
  the same session name must not collide silently.

### 3. Moving a terminal between groups moves its pane

- **Logic:** The panel lets a seat be reassigned. The pane should follow (`move-pane -t`), not be
  recreated — recreating loses the running agent.

### 4. Name reuse must hold for groups as it does for teams

- **Logic:** Mirror the team reattach branch: on restart, `hasSession` → reconnect → reuse existing
  panes and names. This is requirement 3 of the operator's spec and is already correct for teams; it
  must not be reimplemented differently for groups.

### 5. One resolver, both backends

- **Logic:** Every consumer that resolves a seat by friendly name — dispatch pre-flight, prompt
  delivery, the liveness sweep, pane assignments — must work whichever backend owns it. Audit these
  rather than assuming: a name that resolves for dispatch but not for the liveness sweep produces a
  seat that works and is reported dead.

## Verification Plan

### Automated Tests
- With the setting on: opening a terminal into a saved panel group creates/joins a tmux session named
  for the group, and the pane carries the terminal's name.
- With the setting off: no tmux probe, no session, seats are plain PTYs.
- tmux unavailable + setting on: create succeeds as a PTY, with a log line saying why.
- Restart with a group running: panes and names are reused, nothing new is created.
- A seat in each backend resolves identically for dispatch, delivery and liveness.

### Goal Invariants
- Whether a seat is tmux-backed depends on the setting, never on which instantiation path ran.
- A team and a panel group get sessions by the same rule and the same naming function.
- Turning the setting off is always safe: no tmux calls, no behaviour change.

### Manual
- Open four terminals, SAVE AS GROUP, confirm `tmux ls` shows a session named for the group with four
  named panes; attach from an SSH client and confirm it is the same terminal the board drives.
- Restart the board; confirm the group reattaches with its names intact.

## Outstanding Questions

- None.
