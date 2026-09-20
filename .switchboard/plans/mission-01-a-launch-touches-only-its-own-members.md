# Mission 01 — A Launch Touches Only Its Own Members

Subtask of the feature **Every Batch Move Becomes One Declared Thing — a Mission or a Fan-Out Pipeline** (`8ecfdaee`). The feature file carries the full argument and the constraints binding every subtask. This plan is self-sufficient on its own scope and, where the two disagree, **this plan wins** — it is the source of truth for the seat implementing it.

## Goal

`launchMission` dispatches only the members of the mission being launched.

## Why this is first

`memo-missions-cannot-be-opened-scoped-or-tested` finding 2: `launchMission`
calls `apiServer.dispatchNextFromQueue({ workspaceRoot, from: head })` and *"the
mission's member list is used only to count streams; it never scopes the pop."*
The pop is workspace-wide, so launching one mission can start work belonging to
another.

Today missions are rare enough that a workspace-wide pop usually picks the right
card by accident. **This feature makes concurrent missions the normal case** —
one per team, several queued at once — so the accident stops holding. Every
later subtask is easier to verify once a launch cannot reach another mission's
cards.

### Verified against HEAD (2026-09-20)

- `launchMission` (`src/services/KanbanProvider.ts:16705`) reads
  `mission.plans`/`mission.features` only to derive `streams` (`:16715-16739`),
  then loops `apiServer.dispatchNextFromQueue({ workspaceRoot, from: head })`
  once per candidate head (`:16777-16784`). No mission id reaches the pop.
- `_runQueuePop` (`src/services/LocalApiServer.ts:4012`) selects candidates as
  `board.filter(p => p && p.kanbanColumn === 'STAGING' && isQueueable(p))`
  (`:4187-4189`) — **workspace-wide across every mission's members**, sorted by
  `compareByPrecedence` (`:4184`). Whichever mission staged earliest wins.
- Mission members are deliberately queueable (`KanbanDatabase.isMissionMember`
  comment at `:16768-16778`: excluding them "would dispatch nothing at all"), so
  the pop sees every mission's cards.
- `appendQueuePositions` (`KanbanDatabase.ts:15137`) already documents this exact
  hazard in its own comment (`:15144-15153`): *"the queue pop orders by
  column_order across the whole STAGING column, not per mission — so a
  mission-scoped max alone would restart a new mission's numbering at 1 and make
  its cards sort ahead of an older mission's, i.e. launching mission A would pop
  mission B's card."* The ordering was made globally monotonic; **the selection
  was never scoped**. This plan closes that half.

## Metadata

- **Tags:** backend, bugfix, api
- **Complexity:** 4
- **Feature:** 8ecfdaee-8187-4e16-aa6a-e6975c864aba

## User Review Required

No. The change is confined to the pop's candidate filter plus one new argument
at two call sites, and its verification is a two-mission test that fails today.

## Complexity Audit

### Routine

- Threading a `missionId` through `dispatchNextFromQueue` → `_runQueuePop`
  (`LocalApiServer.ts:3972`, `:4012`) and the one in-process caller
  (`KanbanProvider.launchMission`).
- Filtering candidates by mission membership using the existing
  `db.getMissionMembers(missionId)` (`KanbanDatabase.ts:16780`) — the same read
  the board already makes per refresh.
- Naming the mission in the empty result, mirroring the existing
  `dependencyBlocked` / `reason` shape at `LocalApiServer.ts:4207-4214`.

### Complex / Risky

- **The `queue/done` seat-paced release path** (`_runQueueDone`,
  `LocalApiServer.ts:4436`/`4495`) enqueues release → clear → pop on the same
  `_queueNextChain` and calls `_runQueuePop` **directly** (`:29686` in
  TaskViewerProvider, `:4424-4425` in the doc comment). A mission-scoped pop
  must decide what a seat's completion pops *for*: the mission that dispatched
  that seat's card (derivable from `mission_members`), or the workspace queue.
  Getting this wrong re-introduces the cross-mission leak on the one path that
  fires unattended.
- **Two pops that must not interleave**: `launchMission` fires one pop per
  candidate head (`:16777`) inside the serialised chain. With mission scoping,
  the second pop for the same mission must not re-dispatch a member the first
  pop just delivered (the wave/cadence rule is Mission 04's, but the *scope*
  must not hand the same member twice in one launch).
- **Backward compatibility of the unscoped pop**: `queue/next` (Run queue
  button, schedule timer, the queue watch) calls the same method with no
  mission. That path must keep workspace-wide selection — the non-mission
  queue is a real, shipped behaviour (the standalone coder case, the
  `queue-pipeline-contract.test.js` suite).

## Edge-Case & Dependency Audit

**Race Conditions**

- The pop is already serialised on the process-wide `_queueNextChain`
  (`LocalApiServer.ts:77-87`). The mission filter must be computed **inside**
  `_runQueuePop`, not by the caller, or two concurrent launches read the same
  member set and both pop it.
- A card that leaves its mission between the read and the dispatch (an operator
  drag, a claim by another mission — Mission 08) must fail the pop loudly
  rather than dispatch: the existing `performKanbanDispatch` non-2xx passthrough
  (`:4343-4345`) already does this — do not swallow it.

**Security**

- No new trust boundary. `missionId` arrives on an in-process call
  (`launchMission`) and, if exposed on the HTTP `queue/next` body, must be
  validated against the workspace the same way `workspaceRoot` is
  (`_requireKnownRoot`) — a mission id from another workspace must not scope a
  pop in this one.

**Side Effects**

- The empty-result shape changes for the mission-scoped case only. `queue empty`
  remains the unscoped answer; the mission-scoped answer names the mission, so
  "this mission has nothing eligible" and "the board's queue is drained" never
  render the same string (the feature's own invariant, and the AGENTS.md
  fallback rule applied to a collection read).

**Dependencies & Conflicts**

- **Mission 03** sets `missions.team` and calls `launchMission` immediately after
  creating the mission. M01 makes that launch safe; M03 makes it *targeted*
  (the head must be the mission's team's head — see Mission 03, which owns
  `launchMission`'s head resolution).
- **Mission 04** extends the same pop to release a *wave* rather than one
  member. M01 must land first: a wave of five popped workspace-wide is five
  times the leak.
- **Mission 07** gates the pop on pause. Same function, later in the chain.
- **Mission 06** supplies the release column so a mission member is not
  complexity-routed as it is released. Same function, later in the chain.

## Dependencies

- `memo-missions-cannot-be-opened-scoped-or-tested` — finding 2 is this plan's
  whole scope. Its other four findings (card open, unbounded `getMissions`,
  the drop rule, the dead reports path) are **not** in scope here and remain on
  the board.
- `the-staging-ack-promises-a-pickup-that-missions-will-not-do` — read together;
  this plan does not change the STAGING ack.

## Adversarial Synthesis

Key risks: the seat-paced `queue/done` release path calls `_runQueuePop`
directly and would otherwise re-introduce the cross-mission leak on the one
unattended path; the unscoped `queue/next` behaviour is shipped and must not
regress. Mitigations: compute the member filter inside the serialised pop, key
the seat-paced release off the completing card's own mission, and gate the new
behaviour on an explicit `missionId` so the unscoped path is byte-for-byte
unchanged.

## Proposed Changes

### 1. `dispatchNextFromQueue` accepts the mission whose queue is being popped (`src/services/LocalApiServer.ts:3972`)

- **Context:** the pop's contract is `{ workspaceRoot, from, pacing? }`. Add
  `missionId?: string` — absent means the existing workspace-wide queue (Run
  queue, schedule, `queue/next`); present means "select only this mission's
  members".
- **Logic:** pass `missionId` through to `_runQueuePop`. Inside the candidate
  filter (`:4187`), when `missionId` is set, additionally require the card to be
  a member of that mission — one `db.getMissionMembers(missionId)` read hoisted
  above the filter (it is one indexed query on `idx_mission_members_mission`),
  not a per-card lookup.
- **Implementation:** the membership set is computed once, beside the existing
  `dependencyBlockers` map (`:4125`), and added to `isQueueable`'s inputs the
  same way (`:4170-4174`). `isQueueable` stays a filter; precedence stays a
  sort — the plan's existing rule at `:4216-4232`.
- **Edge cases:** a mission whose members are all non-STAGING (all delivered)
  is an empty queue for that mission, not a fallthrough to another mission's
  cards. A card whose `mission_members` row was removed (Mission 08's claim
  transfer) is simply not in the set.

### 2. A pop that finds no eligible member of **its own** mission says so, naming the mission (`src/services/LocalApiServer.ts:4191-4214`)

- **Logic:** when `missionId` is set and the candidate list is empty, return
  `{ status: 200, payload: { success: true, dispatched: null, reason:
  'queue empty for mission <id>', missionId } }`. Do not fall back to the
  workspace-wide list, and do not reuse the bare `queue empty` string.
- **Edge cases:** the dependency-blocked branch (`:4197-4212`) keeps priority —
  a mission whose members are all dependency-blocked reports the blocker, and
  names the mission too.

### 3. `launchMission` passes the mission it is launching (`src/services/KanbanProvider.ts:16777-16784`)

- **Logic:** `apiServer.dispatchNextFromQueue({ workspaceRoot, from: head,
  missionId: mission.id })`.
- **Edge cases:** the `streams`/candidate-head loop stays as it is; head
  selection for a team-bound mission is Mission 03's change, and this plan must
  not alter it. One launch, one mission: no call site may pass a mission id
  other than the one being launched.

## Verification Plan

### Automated Tests

- **Two missions queued; launching A dispatches only A's members.** Assert with
  B's card first in workspace order (lower `column_order`), so a workspace-wide
  pop fails the test — this is the regression the whole plan exists for.
- **A mission with no eligible member returns an empty result naming the
  mission** — assert `payload.dispatched === null` and `payload.missionId`
  matches, and that the reason is not the bare `queue empty` string.
- **Existing single-mission launch behaviour is unchanged.** The two-mission
  fixture with one mission must dispatch the same card as HEAD.
- **The unscoped path is unchanged**: `queue-pipeline-contract.test.js` (which
  drives `dispatchNextFromQueue` with no `missionId`) passes without edits to
  its expectations.

### Goal Invariants

- **Negative:** with two missions queued and the foreign mission's card sorting
  first, a mission-scoped pop dispatches **no** card outside the launching
  mission's member set (`mission_members` rows for that mission).
- **Positive:** a mission-scoped pop with no eligible member returns
  `dispatched: null` **and** names the mission id, so "this mission is drained"
  and "the board queue is drained" are distinguishable strings.
- **Positive:** a pop called without `missionId` selects from the same candidate
  set as HEAD (workspace-wide STAGING, `isQueueable` + dependency gate).
- **Negative:** no member of the launching mission is dispatched twice by a
  single `launchMission` call.

## Constraints

**No hand-dispatch on the Coding team.** `ptySendPrompt`-to-a-seat was
deliberately removed from its head prompt; nothing here may put it back.

**Derive the pipeline order and the head-role set** — never hand-keep either.
`_PIPELINE_POSITION` shipped wrong once when it was hand-kept.

**Nothing may be silently dropped.** Every plan is delivered or visibly queued.

**Teams are unreleased dev work** — clean break, no migration shims.
