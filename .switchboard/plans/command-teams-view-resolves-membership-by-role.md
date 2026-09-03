# The command surface's team roster matches seats by role alone, so one live lead heads every lead team — and only the head is ever viewable

## Goal

Make `/command`'s TEAM ROSTER resolve seats by actual team membership rather than by role, stop empty seed teams presenting as real ones, and let the operator open any seat's terminal instead of only the head's.

### Problem Analysis

Two defects in one view, both rooted in the same missing membership test.

**A. A team appears twice, and both rows claim the same seat.** This workspace persists four teams under `terminals.agentGroups`:

| id | name | headRole | members |
| :--- | :--- | :--- | :--- |
| `group-coding-mswk2w8r` | Coding | lead | coder×2, intern×1 |
| `planning-team` | Planning team | planner | — |
| `feature-implementation` | Lead team | lead | — |
| `review-team` | Review team | reviewer | — |

The last three are `DEFAULT_TEAM_DEFINITIONS` (`teamWiring.ts:529-548`), seeded with no members. Two rows carry `headRole: 'lead'` — the operator's real Coding team and the empty `feature-implementation` seed.

`resolveTeamHeadSeat` (`command.js:948-953`) then does:

```js
const role = team.headRole || '';
return liveFleet.find(t => t && t.status !== 'exited'
    && ((role && t.role === role) || (team.head && t.friendlyName === team.head))) || null;
```

`liveFleet` is the whole workspace fleet from `ptyListTerminals` (`:447-455`). The predicate matches the **first live seat whose role matches**, with no check that the seat belongs to this team. So one live lead seat resolves as the head of *both* lead-headed teams: both rows show the same head name, both leave DORMANT, and both light up WORKING when that seat picks up a card. The operator reads this as their coding team listed twice — once as "Coding", once as "Lead team".

**B. Only the head's terminal can be opened.** `openTerminalViewer(team, resolvedHead)` (`:1299`) takes a single name, titles the pane with it, fetches `/terminals/<name>/log`, and opens `ws/terminal?name=<headName>&solo=1`. The team card's click handler passes the head (`:1055`). There is no member picker anywhere in the view, so a team's coders and intern are unreachable — which is precisely where the work is happening.

The data is already present: `liveFleet` carries every seat with its role, `friendlyName`, `status` and `planId`. Nothing needs fetching; the view simply never offers them.

### Root Cause

**Role is being used as a membership test, and role is not a membership test.** Switchboard's own team-head standing order says so in as many words (`KanbanProvider` head prompt, persisted verbatim in `terminals.agentGroups`):

> Your team's seats are the `ptyListTerminals` rows whose `parentInstanceId` matches your `SWITCHBOARD_AGENT_INSTANCE_ID` — role alone is not a membership test, and a standalone seat of the same role is not yours to drive.

The agents are held to this rule; the roster that displays them is not. `parentInstanceId` is the field that answers membership, and `resolveTeamHeadSeat` never reads it.

The empty seed teams are a second, independent contributor: they make a role collision *likely* rather than merely possible, because two of the four shipped defaults are lead- and reviewer-headed and will collide with any real team the operator builds around those roles.

### Non-goals

- **Do not delete the seed teams from storage.** They ship in released versions and an operator may have built on them; a migration that removes rows is not warranted for a display bug. Hide unstarted, member-less seeds from the roster; leave the data alone.
- No change to how teams are started or seated. `seatTeam` (`:955-977`) is correct.
- The terminal viewer stays read-only. No input, no send.

## Metadata

**Topic:** Command surface team roster resolves membership by parentInstanceId and exposes every seat
**Complexity:** 5
**Tags:** webview, ui, mobile, command-surface, teams, bug

## User Review Required

None. `parentInstanceId` is the membership field the rest of the system already uses.

## Complexity Audit

### Routine
- The member list markup in the roster card and the terminal viewer header.
- Re-pointing `openTerminalViewer` at an arbitrary seat name.

### Complex / Risky
- **Resolving the head when nothing is live.** `parentInstanceId` chains from a *running* head. A dormant team has no live seat and therefore no instance id, so the fallback for the dormant case must still be a name/role match — but scoped so it cannot claim a seat another team already owns. Resolve in one pass across all teams, claiming seats exclusively, rather than per-team independently.
- **Which teams are "real".** Hiding member-less seeds must not hide a real team the operator deliberately created with no members. Distinguish on identity — the three ids in `DEFAULT_TEAM_DEFINITIONS` with members still empty and no live seat — not on member count alone.
- **`solo=1` semantics.** The viewer opens `ws/terminal?name=…&solo=1`. Switching seats must close the previous socket before opening the next (`closeActiveWs` exists at the top of `openTerminalViewer`, but the seat-switch path is new and must route through it), or the phone accumulates sockets and the 6× fanout on the cockpit push path gets worse.

## Edge-Case & Dependency Audit

**Race conditions:**
- `fetchTeamsState` fetches fleet and groups as two sequential requests (`:445-466`). A seat that exits between them appears in one and not the other. The resolver must tolerate a `parentInstanceId` pointing at a seat that is no longer in `liveFleet`.
- A seat picked up mid-view changes its `planId`, flipping the row to WORKING on the next render. Membership must be recomputed on each render, not cached at first paint.

**Security:** None new. The viewer already reads `/terminals/<name>/log` for the head; extending it to other seats of a team the operator can already see exposes nothing further.

**Side effects:** `renderTeamRow` also populates `tabletTeamsRail`. Both paths consume the resolver and both must be updated, or the tablet rail keeps the role-matched behaviour.

**Dependencies & conflicts:** None with the other plans in this feature — this one is confined to the Teams view and the terminal viewer.

## Dependencies

None.

## Adversarial Synthesis

Key risks: (1) resolving each team's head independently, which lets two teams claim the same seat again just via a different field — mitigation: one exclusive-claim pass over the fleet, asserted by a test with two lead-headed teams and one live lead; (2) hiding a real operator-created empty team along with the seeds — mitigation: match on the three default ids plus "still empty and never started", never on member count alone; (3) leaking WebSockets when switching seats — mitigation: route every seat switch through `closeActiveWs`, and assert one open socket after ten switches; (4) treating this as a de-duplication fix and merely collapsing the visible duplicate rows, which would leave the wrong seat attributed to the surviving row — mitigation: verification asserts the *seat name* on each row, not the row count.

## Proposed Changes

**1. Membership by `parentInstanceId` (`command.js`).**

Replace `resolveTeamHeadSeat` with a single `resolveTeamSeats(teamRoster, liveFleet)` pass returning, per team, its head seat and its member seats. Resolution order per team: a live seat whose `friendlyName` equals `team.head`; else a live seat of `team.headRole` **not already claimed** by an earlier team. Members are the live seats whose `parentInstanceId` matches the resolved head's instance id. Claimed seats are removed from the pool as the pass proceeds, so no seat is ever attributed to two teams.

**Ordering note:** The seed-team filtering in step 2 below MUST happen BEFORE this resolution pass. Unstarted seeds are removed from `teamRoster` before `resolveTeamSeats` sees them, so they never enter the claim pool and cannot steal a seat from a real team.

**2. Hide unstarted seed teams (`renderTeamsView`).**

Filter out teams whose id is one of `planning-team` / `feature-implementation` / `review-team` **and** which have no members and no resolved live seat. A seed the operator has started, or added members to, renders normally. Nothing is written to storage. This filtering runs before the `resolveTeamSeats` pass in step 1.

**3. Seats on the roster card (`renderTeamRow`).**

Under the head line, render each resolved member seat as a tappable row: role, friendly name, and its `planId` when it holds one. Apply to `teamsRosterList` and `tabletTeamsRail` alike. The existing seat *count* subtitle keeps reading from `declaredSeatCount` (the declared roster), while the rows show what is actually live — label them so the difference between declared and live is legible rather than confusing.

**4. Any seat in the viewer (`openTerminalViewer`).**

Take a seat name rather than a head. Add a seat switcher to the viewer header listing the team's live seats; selecting one routes through `openTerminalViewer` itself (which already calls `closeActiveWs` at its top, `:1320`), not a separate socket-opening path — this ensures the previous socket is closed BEFORE the new one opens, with no brief window of two simultaneous sockets. The switcher retitles the pane, refetches `/terminals/<name>/log` and reopens the stream. Back still returns to Teams.

## Verification Plan

1. With the Coding team seated and the three default seeds untouched, open `/command` → Teams. Exactly one row appears for Coding. "Lead team", "Planning team" and "Review team" are absent.
2. Start the `feature-implementation` seed team explicitly. It now appears as its own row, with its own head seat — distinct from Coding's.
3. With both lead-headed teams live, confirm each row names a *different* seat. This is the regression gate for the role-collision bug.
4. Dispatch a card to Coding's lead. Only Coding flips to WORKING.
5. Tap Coding. Its coder and intern seats are listed with their live names and any held plan.
6. Tap a coder seat. The viewer titles to that seat, loads its scrollback, and streams its live output — not the lead's.
7. Switch between seats ten times. `chrome://inspect` (or the server's socket count) shows one open terminal socket, not ten.
8. Kill the lead seat mid-view. The team falls back to DORMANT and its member rows clear, without a stuck viewer.
9. Both hosts: run 1, 3 and 6 against the VS Code extension and the standalone host — `ptyListTerminals` is answered by different fleet services on each and `parentInstanceId` must be populated on both.

### Goal Invariants

- Assert `resolveTeamHeadSeat` is absent from `command.js` (the role-matching function is replaced, not wrapped).
- Assert `resolveTeamSeats` exists as a named function in `command.js` and reads `parentInstanceId` from fleet entries (membership is by instance chain, not by role).
- Assert that with two lead-headed teams and one live lead seat, `resolveTeamSeats` attributes the seat to exactly one team — the other team's head is `null` (exclusive claim, no double attribution).
- Assert the three default seed ids (`planning-team`, `feature-implementation`, `review-team`) are absent from the rendered roster when they have no members and no live seat.
- Assert `openTerminalViewer` accepts a seat name parameter (not a team + head pair) and that the seat switcher routes through `closeActiveWs` before opening a new socket.

## Implementation Summary

Replaced `resolveTeamHeadSeat` with `resolveTeamSeats(teams, fleet)` — a single exclusive-claim pass that resolves head + members per team. Head resolution: explicit `team.head` name match first, then first unclaimed live seat of `team.headRole`. Claimed seats are spliced from the pool so no seat is ever attributed to two teams. Members are resolved by `parentInstanceId` matching the head's `agentInstanceId` (the instance chain the rest of the system uses), not by role. Added `SEED_TEAM_IDS` constant and a pre-resolution filter in `renderTeamsView` that hides the three default seeds when they have no declared members and no live seat of their headRole — nothing is written to storage. `renderTeamRow` now accepts the `resolvedSeats` map, renders tappable member seat rows (role, friendlyName, planId) on both phone roster and tablet rail, and labels declared vs live counts. `openTerminalViewer` takes `(team, seatName, seatList)` instead of `(team, resolvedHead)`, with a seat switcher bar in the viewer header that routes every switch back through `openTerminalViewer` itself — `closeActiveWs` runs at the top before the new socket opens, so no socket accumulation. `closeTerminalViewer` clears the switcher and `viewerLiveSeats`.


## Review Findings

Files changed in this review pass: `src/webview/command.js`, `src/webview/command.html`. Two fixes. (1) CRITICAL: the seed-visibility filter in `renderTeamsView` re-implemented `t.role === role` — the exact role match this plan exists to delete — so any live `lead` seat made the member-less `feature-implementation` seed pass and render as a second "Lead team" row beside Coding, which is the duplicate the operator reported; and because `resolveTeamSeats` claims in array order while `KanbanProvider.ts:4961` *pushes* missing seeds into the stored array, on a fresh install the seed is first and would claim the live lead, leaving the operator's real team DORMANT (risk 4 of this plan's own Adversarial Synthesis). Replaced with one resolution pass over the whole roster ordered non-seeds-first (stable sort), then a filter that hides a seed only when it has no declared members and no *resolved* head. (2) MAJOR: seat rows were appended as extra children of `.team-roster-card`, a `display:flex; justify-content:space-between` row, so they laid out beside the icon and state badge instead of under the head line — added a `.team-roster-headline` wrapper and made the card stack, on both the phone roster and the tablet rail. Verified `agentInstanceId`/`parentInstanceId`/`planId` are all present in the persisted `ptyListTerminals` projection on both hosts (`bootstrap.ts:1904-1956`, `ptyHost.ts:162-176` + `TaskViewerProvider.ts:3866-3874`). Verification: `tsc` clean, `eslint` 0 errors, `npm test` and `test:contract:agents-seed-deletion-guard`, `test:contract:team-scoped-routing`, `test:contract:standalone-fleet-seam` all pass; no automated check discriminates on roster attribution, so Verification Plan steps 1-9 remain unexecuted and this verdict is provisional.

## Deferred Findings

- MAJOR — head attribution is still role-based (with exclusive claim), not membership-based. `resolveTeamSeats`'s documented arm 1 reads `team.head`, but `ptyListAgentGroups` serves `terminals.agentGroups` (`KanbanProvider.peekAgentGroups:5033`) and that key's only writer — the TEAMS-tab save literal at `src/webview/kanban.html:6047-6055` — emits no `head`. `head` is stamped by `wireSpawnedTeam` into `switchboard.prompts.terminals.groups` (`teamWiring.ts:1594`), which no webview verb exposes. Making head attribution genuinely membership-based needs the live-groups key (or a `definitionId`→head map) on the wire, on both hosts. The docblock has been corrected to state this rather than claim otherwise (`src/webview/command.js:1200-1224`).
- MAJOR — Verification Plan step 3 ("with both lead-headed teams live") is not reachable through the UI: `startTeamById` refuses to start a team whose `headRole` is already live as an unparented terminal (`src/services/teamWiring.ts:1233-1240`), so a second lead-headed team cannot be seated while the first head is up. The regression gate needs a different setup or a unit-level assertion on `resolveTeamSeats`.
- MAJOR — `wireSpawnedTeam` early-returns when a team has no children (`src/services/teamWiring.ts:1388`), so starting a member-less seed registers no group row at all; nothing persisted ever records that a seed was started. Seed visibility therefore depends entirely on a live seat falling to it in the claim pass.
- NIT — a card-level click on a non-dormant team opens the viewer for the head; the seat rows stop propagation, but the region between them does not, so a tap on card padding opens the head rather than doing nothing (`src/webview/command.js:1420`).
