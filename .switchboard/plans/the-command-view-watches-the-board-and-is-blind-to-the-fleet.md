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

> **Superseded:** "`resolveTeamSeats` → `resolveTeamMembersForHead`
> (`teamWiring.ts:3230`)" as the authority for the live-seat join.
> **Reason:** Two problems. (1) The line ref drifted — the function now lives at
> `teamWiring.ts:3551`. (2) More importantly, it is the wrong tool:
> `resolveTeamMembersForHead` resolves a team's **registered roster** — terminal
> *names* from the group row's `order`/`members` fields. It knows nothing about
> live seats, `parentInstanceId`, `cliFamily`, `status` or `planId` — everything
> the roster card renders. The host owns the *inputs* to the join
> (`resolveLiveGroupHeads`, `teamWiring.ts:3781`, for head attribution;
> `ptyFleetService.list()` for the live fleet) but the join itself
> (`head` by live seat name + members by `parentInstanceId`, exclusive claim,
> exited seats filtered) **exists only in `command.js`** and must be built on
> the host. This is a new pure function in `teamWiring.ts`, not a reuse.
> **Replaced with:** a new host-side resolver — see Proposed Changes 1. The
> existing client-side semantics become its contract; the thirteen
> `resolveTeamSeats` tests in `team-wiring-roster-seats-contract.test.js`
> migrate with it.

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

> **Superseded:** "invoked from two places in the client".
> **Reason:** Three call sites, not two — `renderTeamsView` (command.js:1308),
> `buildFleetRoster` (command.js:2372), **and** `resolveLaunchOriginSeat`
> (command.js:2023). The third is load-bearing and easy to miss: LAUNCH MISSION
> resolves the mission team's live head to supply the required `from` field of
> `POST /kanban/queue/next`, which 400s without it. A deletion that supplies
> resolved teams but forgets this site silently re-breaks launch — the bug the
> comment at command.js:2004-2015 commemorates.
> **Replaced with:** three call sites; the resolved-teams payload must let all
> three read their answer without re-joining (see Proposed Changes 1, 2).

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

> **Superseded:** "Its entire message handler is two arms … No fleet event
> reaches it."
> **Reason:** Landed after this plan was written. `734f862b` ("the TEAMS view
> hears that a team started, without a reload") added a third arm at
> `command.js:332` — `terminalsChanged`/`terminalsGroupsChanged` →
> `fetchTeamsState()` then `renderActiveView()` — and subscribed the `command`
> panel to the `terminals` surface in both `PANEL_SURFACES` maps
> (`wsHub.ts:94`, `transport.js:141`). The push path this plan proposed
> building already exists and already reaches the panel.
> **Replaced with:** Proposed Changes 0 — the subscription and re-render arm
> are DONE; this plan now only deletes the local join underneath them.

There are eleven WS surfaces — `common, connections, design, kanban, memo,
planning, project, setup, terminals, tickets` — and **there is no `command`
surface**. The cockpit has no channel to receive fleet changes on.

> **Superseded:** "there is no `command` surface … no channel to receive fleet
> changes on" as a blocker.
> **Reason:** Still literally true — `SURFACES` (wsHub.ts:41-52) has no
> `command` entry — but no longer relevant: `734f862b` resolved the open
> question in favor of the alternative. The command panel declares the
> `terminals` surface and receives the three low-rate control messages that
> ride it (`terminalsChanged`, `terminalsGroupsChanged`, `focusTerminal`), of
> which `terminalsChanged` is already trailing-edge debounced host-side. A
> dedicated `command` surface would be plumbing for its own sake.
> **Replaced with:** the cockpit joins `SURFACES.terminals` — done, no further
> surface work. See Outstanding Questions for the resolved entries.

### What that makes the teams roster

Live-vs-dormant is derived entirely from `ptyListTerminals`, fetched in
`refreshAllData()` — on init and on workspace change — and, since `bfae8a18`,
after a start attempt. Between those moments the roster is a **photograph**.

Start a team from the terminals panel, from `lc`, or by dispatching a card, and
the command view never hears. It keeps drawing DORMANT with a START button for a
team that is running.

> **Superseded:** "the command view never hears" a team started elsewhere.
> **Reason:** `734f862b` made the fleet push reach the panel and re-render the
> roster. The roster is no longer a photograph for the *started-elsewhere*
> case; what remains broken is only that the re-render still runs the
> client-side join this plan deletes.
> **Replaced with:** the refresh-on-event path exists; the work is replacing
> what it re-renders *with*.

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

> **Superseded:** `bfae8a18`'s refetch-on-refusal as the operative fix path.
> **Reason:** Two later commits changed the ground under it: `51539d17`
> deleted `seatTeam` outright — a card tap now *opens* the team and never
> starts one, so there is no client-side start attempt left to refuse ("a
> surface that cannot start a team cannot show a start refusal",
> command.js:1454-1460) — and `734f862b` covered the started-elsewhere,
> seat-exited, stopped-elsewhere and head-died cases via the push. The host's
> `startTeamById` guard stays, untouched, as the last line; this plan's job is
> that it stays unreachable in normal use.
> **Replaced with:** no client start path exists to harden; the guard lives
> host-side only.

## Metadata

**Complexity:** 6
**Tags:** ui, backend, refactor, bugfix, api
**Scope:** `src/webview/command.js`, a new host verb in
`src/standalone/bootstrap.ts` (`handlePtyVerb`), a new pure resolver in
`src/services/teamWiring.ts`, and the two contract suites that pin the deleted
exports (`src/test/team-wiring-roster-seats-contract.test.js`,
`src/test/mobile-command-route-contract.test.js`).
**Standalone only** — the command view is a standalone-host surface. Per the
cutover rule the new verb is not wired into the extension host: `ptyListAgentGroups`
parity comments in `TaskViewerProvider.ts:3993-4004` cover the `head` field only,
and `/command` is not served there.

## User Review Required

- **A new verb, not a bigger `ptyListAgentGroups`.** The plan's "one read that
  answers the whole question" is implemented as `ptyListResolvedTeams`, a
  dedicated arm — extending the existing verb would charge every consumer
  (terminals.js role picker, shell rail) for a fleet reconcile they never
  render. Flagging because it is a different mechanism than "the host returns
  teams already resolved" implies at a skim.
- **`filterByProjectFor` is kept**, reclassified as presentation filtering, not
  deleted — see Proposed Changes 4 and Outstanding Questions. Deleting it via
  WS push-scope would starve the project picker, which is built from the pushed
  cards themselves.
- **Team icon resolution moves to the host** (`iconUri` on the resolved
  payload), which also settles a live cross-surface art divergence — see
  Proposed Changes 3.

## Complexity Audit

### Routine
- Deleting `resolveTeamSeats`, `SEED_TEAM_IDS`, `TEAM_ROLE_ART`,
  `resolveTeamArt`, `declaredSeatCount` and their call sites once the resolved
  payload lands — mechanical removal.
- `fetchTeamsState` collapsing two fetches into one verb call.
- The file-header rule comment and the grep gate.
- The freshness stamp — a timestamp rendered next to the roster state.
- `removeMissionMember` failure-arm refresh (command.js:1983-1994).

### Complex / Risky
- The host-side join is **new code**, not a reuse: `resolveLiveGroupHeads` +
  `ptyFleetService.list()` + `parentInstanceId` membership + exclusive claim +
  exited/hidden filtering. It must reproduce today's semantics exactly — the
  migrated contract tests are the spec.
- `resolveLaunchOriginSeat` (command.js:2023) must still find the mission
  team's live head after the join leaves the client — a missed call site, not
  a hard one.
- Host-computed `iconUri` must pick one `art:` convention where two surfaces
  currently disagree (`.svg` in command.js vs `.png` in agent-control.js).
- The verb's fleet-read failure must surface as *unreadable*, never as
  *empty* — the empty-list-is-a-claim rule.
- Both stale contract tests must be repaired in the same change or the suite
  goes red on landing.

## Edge-Case & Dependency Audit

### Race Conditions
- A `terminalsChanged` push can arrive while `fetchTeamsState` is in flight —
  last-write-wins on `teamRoster`/`liveFleet` is the current behaviour and stays
  correct because every render reads the freshest completed fetch, and the event
  only ever triggers a refetch (never patches state from the payload).
- A team mid-spawn can have a `head` stamped on its group row before member
  seats exist: the resolved payload reports `head` live with zero live members —
  that is the truth, and renders correctly.
- `ptyFleetService.reconcile()` inside the new verb is single-flighted (same as
  `ptyListTerminals`, bootstrap.ts:2715); two cockpit tabs racing produce one
  reconcile, not two.

### Security
- The `art:`/`pack:`/`data:` icon chain is a traversal surface if a raw role or
  filename is interpolated into a path. Today `TEAM_ROLE_ART` is the client-side
  allow-list; after this change the host computes `iconUri` and
  `validateTeamIcon` (`iconPalette.ts:162`) is already the write-side gate — the
  render path never interpolates operator data into a URL. Net security posture
  improves: one resolver, server-side.
- The new verb is read-only; it must stay in the pre-`ptyReady` allowlist only
  if it genuinely needs no pty host — it DOES need the fleet projection, so it
  belongs behind the same guard as `ptyListTerminals` (bootstrap.ts:5210 area).

### Side Effects
- `reconcile()` has host-visible side effects (discovers seats created outside
  the cache). This is deliberate and identical to `ptyListTerminals`; the
  comment at bootstrap.ts:2699-2714 explains why it is affordable — the route is
  event-driven, not polled.
- `ManualGroupStore.reconcileAgainstLiveFleet` fires inside `ptyListTerminals`
  (bootstrap.ts:2721); the new verb should NOT re-trigger it — it reads
  `team_` groups, not manual groups, and a second reconciler per fetch is a
  write on a read path for no benefit.

### Dependencies & Conflicts
- `team-wiring-roster-seats-contract.test.js:28` `require()`s `resolveTeamSeats`
  and `filterByProjectFor` from `command.js` — thirteen tests break on deletion.
  The `resolveTeamSeats` cases migrate to the new `teamWiring.ts` helper (same
  semantics, new home); the `filterByProjectFor` cases stay if the function is
  kept (see Outstanding Questions).
- `mobile-command-route-contract.test.js:289-293` asserts `ptyStartTeam` is
  present in `command.js` — already stale since `51539d17` deleted `seatTeam`.
  Repairing this assertion is part of this change, not optional.
- `ptyListAgentGroups` consumers (terminals.js:10286 role picker, shell rail
  definition cache, agent-control.js `agentGroups` push) are untouched — the
  verb is additive alongside, not a payload change.
- `ws-surface-scoping-contract.test.js` pins `PANEL_SURFACES` ≡
  `PANEL_SURFACES_MAP` — no edit needed; `734f862b` already updated both.
- `kanbanProvider.peekAgentGroups` (bootstrap.ts:2429) is the read the new verb
  should share — never `listAgentGroups`, which can write.

## Dependencies

- `734f862b` — surface subscription + `terminalsChanged` arm (landed; this plan builds under it)
- `51539d17` — `seatTeam` deleted; card tap opens, never starts (landed)
- `5952be84` — `defaultTeamIds` from host; brand icons from `data-brand-icon-*` (landed)
- `39ea2ac5` — failed fleet read renders UNKNOWN, not DORMANT (landed; must be preserved)
- `bfae8a18`, `259ba427`, `bc45408d` — earlier staleness/claim-order fixes (landed)
- `team-wiring-roster-seats-contract.test.js` — the migrate-with-the-code test suite
- `mobile-command-route-contract.test.js` — home of the grep gate; carries a stale assertion to repair
- `goPtyFleetProjection.ts` `onDidChange` → `bootstrap.ts:4335` `broadcastWs('terminalsChanged', …, SURFACES.terminals)` — the existing emit point; nothing new to build there

## Adversarial Synthesis

Key risks: the host-side join is new code that must reproduce the client's
claim semantics exactly (mitigation: the thirteen existing `resolveTeamSeats`
tests move with it and become its contract); `resolveLaunchOriginSeat` is a
third, easily-missed consumer of the deleted join (mitigation: enumerated as a
call site and a goal invariant); a fleet-read failure on the new verb must never
render as an empty roster (mitigation: explicit error field, UNKNOWN state
preserved). The WS plumbing risk the original plan carried is already retired
by `734f862b`.

## Proposed Changes

### 0. Already landed — do not redo

Verify-and-keep only; an implementer who rebuilds these is regressing:

- **`734f862b`** — `command` panel subscribes `[kanban, terminals, common]` in
  `wsHub.ts:94` and `transport.js:141`; `command.js:332` refetches and
  re-renders on `terminalsChanged`/`terminalsGroupsChanged`. This IS original
  proposed-changes 3 and 4, already done exactly as specified (event is a hint,
  view refetches).
- **`39ea2ac5`** — `fleetReadError` → UNKNOWN, not DORMANT (command.js:1482).
- **`5952be84`** — `SEED_TEAM_IDS` populated from `defaultTeamIds` on the wire
  (command.js:768); seat brand art from host-stamped `data-brand-icon-*`
  (command.js:1358, headlessPanelHtml.ts:675).
- **`51539d17`** — `seatTeam` deleted; the double-start guard now lives only in
  host `startTeamById`, where it stays.

### 1. The host resolves the roster — a dedicated verb

**New pure helper in `src/services/teamWiring.ts`**, exported for tests —
working name `resolveTeamSeatsForGroups(groups, fleet)`:

- Input: enabled group rows (each possibly carrying `head` from
  `resolveLiveGroupHeads`) + the live fleet projection.
- Per group: head = the live seat whose `friendlyName` equals the group's
  `head` (name match only — NO role fallback; that rule is load-bearing, see
  command.js:40-49); members = live seats whose `parentInstanceId` equals the
  head's `agentInstanceId`. Exclusive claim via pool removal; `status ===
  'exited'` and `hidden === true` seats excluded up front. Semantics are
  byte-for-byte today's `resolveTeamSeats` — the migrated tests pin it.
- Output per team: `{ head: seatRow|null, seats: seatRow[] }`.

**New verb arm `ptyListResolvedTeams` in `bootstrap.ts` `handlePtyVerb`**
(near `ptyListAgentGroups`, :2423), returning one payload:

```js
{
  success: true,
  teams: [{
    ...group,            // id, name, headRole, members (definitions), icon, jet, head
    isDefault: bool,     // isDefaultTeamId(id) — kills SEED_TEAM_IDS
    declaredCount: n,    // 1 + sum(member.count) — kills declaredSeatCount
    iconUri,             // host-resolved — kills TEAM_ROLE_ART + resolveTeamArt
    running: bool,
    liveHead: seatRow|null,
    liveSeats: seatRow[], // head + members, in order
  }],
  ungroupedSeats: seatRow[], // live seats claimed by no team — for the seat switcher
  fleet: seatRow[],          // full live projection — resolveLaunchOriginSeat reads it
  fleetError: string|null,   // null on success; the message when the fleet was unreadable
}
```

- Reuse the `projectTerminals` field set from `ptyListTerminals`
  (bootstrap.ts:2724-2751): `friendlyName`, `agentInstanceId`,
  `parentInstanceId`, `role`, `status`, `cliFamily`, `planId`, `planTitle` —
  the seat rows render brand art and plan tags, so all of those must ride.
- `fleetError` is the contract's spine: reconcile/list failure → `teams` may
  still carry definitions but `liveHead`/`liveSeats` empty AND `fleetError`
  set. **An unreadable fleet is never an empty fleet** — the client renders
  UNKNOWN off this field and never infers emptiness from absence.
- Group source: `kanbanProvider.peekAgentGroups(root)` + `isTeamEnabled`
  filter, same as `ptyListAgentGroups` — read-only, never `listAgentGroups`.
- Wire-shape note for the implementer: `ptyListAgentGroups` already diverges
  between roots (standalone serves `defaultTeamIds`/`recommendedRoles`, the
  extension arm at TaskViewerProvider.ts:3973 does not). This new verb is
  standalone-only by design — `/command` is not served by the legacy host.

### 2. `command.js` renders, and stops deciding

- `fetchTeamsState` → one `POST /terminals/verb/ptyListResolvedTeams`.
  `fleetReadError` is set from the payload's `fleetError`, not from HTTP status
  alone (a 200 with `fleetError` set is a degraded read, not a clean one). The
  existing unscoped-retry on `UNKNOWN_WORKSPACE_ROOT` stays — it is a
  workaround for scoped-read refusal, and cheap.
- `renderTeamsView` (command.js:1280+): delete the `claimOrder` sort, the
  `resolveTeamSeats` call, and the `SEED_TEAM_IDS` visible-teams filter. A team
  is hidden iff `isDefault && members.length === 0 && !liveHead` — the same
  rule, reading resolved fields. `isDormant` = `!liveHead`. `UNKNOWN` branch
  keys on `fleetError && fleet.length === 0`.
- `buildFleetRoster` (command.js:2363): `byTeam` comes straight from
  `teams[].liveSeats`; `ungrouped` = `ungroupedSeats`. No claiming, no sort.
- `resolveLaunchOriginSeat` (command.js:2016): mission team's head =
  `teams.find(t => t.id === missionTeam || t.name === missionTeam)?.liveHead
  ?.friendlyName`; the lead/coder fallback reads the payload's `fleet`.
- Delete `resolveTeamSeats`, `SEED_TEAM_IDS`, `TEAM_ROLE_ART`, `resolveTeamArt`,
  `declaredSeatCount`, and the Node export guard's `resolveTeamSeats` entry.
- **Keep `resolveSeatBrandArt`** — it reads host-stamped `data-brand-icon-*`
  body attributes; that IS the shared mechanism, not a copy.

### 3. `iconUri` — one resolver for team art, on the host

`command.js`'s `resolveTeamArt` and `agent-control.js`'s `resolveArt` currently
disagree: `art:<name>` → `.svg` in command.js (:1382) but `.png` in
agent-control.js (:1158). The palette contract (`iconPalette.ts`,
`validateTeamIcon`) is the authority: stored `icon` values resolve per the
picker convention; the `team.jet` shorthand (`art:team-${jet}`) resolves to
`team-<jet>.svg` because the jet art on disk is SVG (`icons/team-*.svg`).

Host-side resolution order for `iconUri`:

1. `group.icon` → `data:` passthrough / `art:` → `/static/icons/<name>.png` /
   `pack:` → `/static/icons/<encoded file>` (picker convention).
2. `group.jet` → `/static/icons/team-<jet>.svg`.
3. `headRole` → `/static/icons/team-<role>.svg` — the role table moves to the
   host with the same five-entry allow-list command.js carries today
   (lead/coder/reviewer/planner/intern), never an interpolated role string.
4. `/static/icons/nav-jet.svg`.

### 4. `filterByProjectFor` — kept, reclassified

> **Superseded:** "`filterByProjectFor` → the board projection" as a deletion
> target.
> **Reason:** The board projection can scope pushes (`__switchboardSetPushScope`,
> transport.js:106, and the server understands `__unassigned__`), but the
> command view's project picker is built FROM the pushed cards
> (`extractWorkspaceProjects`, command.js:600) — a scoped push would erase the
> other projects from the picker. Sourcing the picker elsewhere is a second
> feature wearing this one's coat. And `filterByProjectFor` is *presentation*
> filtering of a collection the view legitimately owns — the fallback rule's
> own carve-out — not a derivation of membership, identity, or config.
> kanban.html does the identical client-side filter (kanban.html:3365).
> **Replaced with:** keep `filterByProjectFor` and its tests; the file-header
> rule (change 6) names what may not be re-derived — team membership, liveness,
> seeds, icons — and display filtering is not on that list.

### 5. Action handlers — one survivor

`seatTeam` is gone, so the `bfae8a18`-shaped defect (refresh only on success)
has one remaining instance worth fixing: `removeMissionMember`
(command.js:1983-1994) re-reads mission state only when `res.ok`. A failed
remove is exactly when the view may be wrong — refresh on completion, not on
success. Dispatch, move, and star handlers already handle both arms correctly
(command.js:1863-1879, 1921-1954, 1971-1977).

### 6. The roster says how fresh it is

Stamp the TEAMS view with when it last heard: render `lastTeamsFetchAt` (set on
every completed `fetchTeamsState`) as a small "as of HH:MM:SS" line beside the
state badge, and mark it stale when the transport disconnects (the
`sbTransportReconnected`/`sbTransportSubscribed` CustomEvents in transport.js
are the hooks). A wrong card then reads as a stale card — the one-line bug
report — instead of a broken product.

### 7. The rule that stops the seventh + the gate

- File header of `command.js`, above the IIFE: this surface renders host
  answers. It must not derive team membership, seat liveness, shipped-default
  identity, or icon resolution — those are answered on the host
  (`ptyListResolvedTeams`, `data-brand-icon-*`). Display filtering and ordering
  of host-supplied collections (e.g. `filterByProjectFor`) is presentation and
  is permitted.
- Grep gate in `mobile-command-route-contract.test.js` (it already reads
  `command.js` wholesale): assert absence of `resolveTeamSeats`, `SEED_TEAM_IDS`,
  `TEAM_ROLE_ART`, `resolveTeamArt`, `declaredSeatCount`, `parentInstanceId`
  used as a join key, and `splice` on a fleet pool. Repair the stale
  `ptyStartTeam` assertion (:291) in the same edit — `seatTeam` was deleted in
  `51539d17`.
- Migrate the `resolveTeamSeats` block of `team-wiring-roster-seats-contract
  .test.js` (tests at :282-370) onto the new `teamWiring.ts` helper via
  `out/services/teamWiring`; keep `filterByProjectFor` tests as-is (the
  function stays, the import survives).

## Verification Plan

### Automated Tests

- **Resolved join correctness** — the migrated contract tests run against
  `resolveTeamSeatsForGroups` in `out/services/teamWiring`: head by name only,
  no role fallback, exclusive claim, `parentInstanceId` membership, exited
  seats excluded.
- **Verb arm contract** — `ptyListResolvedTeams` present in bootstrap's
  `handlePtyVerb`; returns `teams[].isDefault`, `iconUri`, `liveHead`,
  `liveSeats`, `ungroupedSeats`, `fleet`, `fleetError`; uses `peekAgentGroups`,
  never `listAgentGroups`; sits behind the `ptyReady` guard.
- **A team started elsewhere updates the cockpit** — already the shipped
  behaviour via `734f862b`; regression-check that the `terminalsChanged` arm
  still refetches through the new verb.
- **The double-start guard stays unreachable in the normal path** and stays
  present in `startTeamById` — asserted host-side; there is no client start
  path to drive.
- **A failed fleet read renders UNKNOWN, not DORMANT** — drive a
  `fleetError`-carrying response; the badge reads UNKNOWN and the notice shows
  the error. Negative paired check: a genuinely empty fleet (`fleetError:
  null`, `fleet: []`) renders DORMANT — the two states never share a render.
- **Grep gate** — `command.js` contains none of the deleted symbols (above).
- **A custom team renders** with no seed/id list anywhere — `isDefault: false`,
  no special-casing.
- **Mission launch origin** — `resolveLaunchOriginSeat` still yields the
  mission team's head name for `queue/next`'s required `from`, from the
  resolved payload.
- **No timer** polls `ptyListTerminals` or `ptyListResolvedTeams` for roster
  freshness.

### Goal Invariants

- `src/webview/command.js` does not contain `resolveTeamSeats`, `SEED_TEAM_IDS`,
  `TEAM_ROLE_ART`, `resolveTeamArt`, `declaredSeatCount`, or a `parentInstanceId`
  join (negative).
- `src/standalone/bootstrap.ts` contains a `ptyListResolvedTeams` arm that
  composes `peekAgentGroups` + the fleet projection + the teamWiring resolver
  (positive pair for the negative above — the join is gone from the client
  AND resolvable on the host).
- `out/services/teamWiring` (compiled) exports the resolver the contract tests
  import — the semantics moved, they were not deleted.
- `command.js`'s `handleIncomingMessage` still has the
  `terminalsChanged`/`terminalsGroupsChanged` arm and `PANEL_SURFACES` still
  lists `command: [kanban, terminals, common]` in both wsHub.ts and
  transport.js — the push path is a precondition, not a deliverable.
- For a running team, the rendered roster's live-seat count equals the host
  payload's `liveSeats.length` — the view adds and removes nothing.

### Manual

Open the cockpit on a phone. Start a team from the terminals panel on the
desktop. The phone shows it live without a reload, with correct seat rows,
brand icons and team art. Stop it; the phone follows. Kill the board's pty
host briefly: the roster reads UNKNOWN with a timestamp, not DORMANT.

## Outstanding Questions

- **[user]** `filterByProjectFor` is retained as presentation filtering rather
  than deleted in favour of WS push-scope — proceeding on the assumption that
  starving the project picker (built from pushed cards) is the worse trade and
  that the "no derivation" rule targets membership/liveness/identity, not
  display filtering. If the reviewer wants it gone, the picker needs a
  project-list source independent of the scoped push first.
- **[user]** Role-fallback `iconUri` resolves to `team-<role>.svg` (the art that
  exists on disk and that command.js draws today) — proceeding on that
  assumption. agent-control.js instead falls back to the jet portrait; if the
  product wants one fallback art across surfaces, that is a display decision
  for the operator, and the host resolver is where it now lands once.
