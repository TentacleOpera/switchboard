# Research 07 — A Planner Waits on Research, and a Round Ends Cleanly

Subtask of the feature **A Research Request Is Queued Inside the Team, and Answered Back to the Planner That Asked** (`cf5537c5`). The feature file carries the full argument and the constraints binding every subtask. This plan is self-sufficient on its own scope and, where the two disagree, **this plan wins** — it is the source of truth for the seat implementing it.

## Goal

A planner with an outstanding request is not complete, and when every planner in
a round is complete the system clears the round's terminals and frees the team.

This subtask owns two things: the `waiting-on-research` gate inside
`_runQueueDone`, and the planning-round close that runs when the last planner
releases. Round membership is derived, not registered — planning has no
`coding_rounds` registration step; the planner fan-out
(`KanbanProvider._distributePlannerDispatch`, `KanbanProvider.ts:8434`) is the
round's creation, and its seats are the roster's planner seats.

## Metadata

- **Tags:** backend, api, feature, reliability
- **Complexity:** 6
- **Project:** Orchestration

## User Review Required

- None.

## Complexity Audit

### Routine
- One early-return branch inside `_runQueueDone` (after the `held` card is
  resolved, before `clearOwnerStamp` at `LocalApiServer.ts:6842`), one
  in-memory waiting set beside `_seatsAtRest` (`LocalApiServer.ts:1319`), and
  one post-release round-close check on the same serialized `_queueNextChain`.

### Complex / Risky
- **Keep the stamp, do not release.** A waiting planner keeps `owner_seat` —
  releasing would let the pop hand it a new card while it is waiting, and
  `teamHasLiveWork` (`LocalApiServer.ts:117`, reads `ownerSince`/`ownerSeat`)
  staying true is exactly what keeps the round open and the team busy for free.
- **The stall backstop must tell waiting from stuck.** The member-completion
  reminder sweep (`PlanIngestionEngine._runMemberCompletionReminderSweep`,
  `PlanIngestionEngine.ts:2178`) nudges quiet seats holding uncompleted cards —
  a waiting planner matches that shape. New gate: skip when
  `db.countOutstandingResearchForSeat(seat) > 0` — the seat is waiting on
  someone else, not idle. The engine already receives `db`; no new
  composition-root seam. (The sweep's pre-existing gap — it cannot see
  `_seatsAtRest`, noted at `PlanIngestionEngine.ts:2143` — is unchanged by this
  plan; the research-count gate is what disambiguates this feature's case.)
- **Round close derives membership.** A planning round is "open" while any
  roster planner seat holds a card OR has outstanding research
  (`queued`/`assigned`). When the last release leaves neither, close: clear the
  team's planner and researcher seats and fire `onTeamReleased` (wired in both
  roots — `bootstrap.ts:5645`, `TaskViewerProvider.ts:4827`) exactly once.
- **Never clear a seat mid-turn.** A seat is clearable only when it is at rest
  (`isSeatAtRest`) or its liveness entry shows `status==='exited'` or
  `lastDataAt` older than `DEFAULT_LIVENESS_WINDOW_MS` (1317) — the same
  live/exited/silent partition the liveness sweep uses. A seat with fresh
  output is skipped and logged; a researcher is additionally never cleared
  while it owns an `assigned` row (at close time none should exist — an
  assigned row means a waiting planner, which holds the round open — so this
  is a belt check, not a design load-bearer).

## Edge-Case & Dependency Audit

- **Race Conditions:** Two planners finishing together serialize on
  `_queueNextChain` — the second's close check sees the first's release. A
  `done` racing a `research-complete`: whichever lands first decides — if the
  answer lands first, count is 0 and the release proceeds; if `done` lands
  first, the seat waits and the Research-05 notify wakes it to re-report.
- **Security:** None new.
- **Side Effects:** Waiting marks a seat at rest and returns a distinct
  response. Close clears terminals and fires `onTeamReleased` once.
- **Dependencies & Conflicts:** Research-01 (`countOutstandingResearchForSeat`),
  Research-05 (the notify is what wakes the waiter). Dead planner holding a
  card → its stamp persists → round stays open → the existing stall machinery
  surfaces it; that is the correct answer, not a gap.
- **Restart edge:** `_seatsWaitingOnResearch` is in-memory like `_seatsAtRest`;
  a restart loses the marker but the held stamp + outstanding request rows are
  durable — the seat re-marks on its next `done`, and the reminder-sweep gate
  reads the durable count regardless.

## Dependencies

- Research-01, Research-05. Lands after both: it consumes the count accessor
  and its waiting state only ends when the notify path exists to wake the seat.

## Adversarial Synthesis

Key risks: a waiting planner misread as stalled (mitigated by the research-count
gate in the reminder sweep), and a double `onTeamReleased` (mitigated by running
the close check inside the serialized `_queueNextChain`, where the second
release finds the first's state already settled and `done` on a seat with no
held card already short-circuits as `duplicate`). The keep-the-stamp choice is
the load-bearing one: releasing early would dispatch fresh work to a seat that
is contractually waiting.

## Proposed Changes

### src/services/LocalApiServer.ts

- **Context:** `_runQueueDone` (`LocalApiServer.ts:6759`); the `held` card is
  resolved by ~6822, released by `clearOwnerStamp` at 6842. `_seatsAtRest` and
  `markSeatAtRest`/`isSeatAtRest` at 1319-1345. `onTeamReleased` option at 589;
  `teamHasLiveWork` at 117. `_resolveTeamGroupForSeat` at 9418.
- **Logic:**
  1. **Waiting gate.** After `held` resolves and before `clearOwnerStamp`:
     `const outstanding = await db.countOutstandingResearchForSeat(from)`. When
     `outstanding > 0`: add `from` to `_seatsWaitingOnResearch` (a
     `Map<ws\0seat, { count, at }>` beside `_seatsAtRest`), call
     `markSeatAtRest(workspaceRoot, from, held.planId)`, and resolve
     `200 { success:true, waiting:'research', outstanding, released:null }` —
     NO release, NO pop, NO completion relay. Append a `plan_events` row
     (`appendPlanEventByPlanId`, action `research.waiting`) so the wait is
     durable-visible. On a later `done` with `outstanding === 0`, delete the
     marker and fall through to the normal path.
  2. **Round close.** After a successful `finished` release (post-pop is fine —
     the response is already settled), call `_maybeClosePlanningRound
     (workspaceRoot, from)`:
     - Resolve `{ group }` via `_resolveTeamGroupForSeat`; no group → return
       (standalone agent, no round).
     - Planner seats = roster members whose live `ptyListTerminals` entry has
       `role === 'planner'` (fallback: roster name `*-planner*`, same
       signal-tagging rule as Research-03); researcher seats likewise by
       `role === 'researcher'`.
     - Round open iff any planner seat holds a card (`owner_seat` + no
       `completedAt`, the `teamHasLiveWork` predicate applied to planner seats)
       OR `countOutstandingResearchForSeat(seat) > 0` for any planner seat.
       Open → return.
     - Closed → for each planner + researcher seat on the roster,
       `clearSeatAtRest(workspaceRoot, name, undefined, 'planning-round-complete')`
       for seats that are at rest or silent/exited per liveness; skip + log a
       seat with fresh output. Then `onTeamReleased(workspaceRoot, roster)` —
       once; the serialized chain plus the duplicate-short-circuit make a
       second fire unreachable.
- **Edge Cases:** The head seat is never in the cleared set (same exclusion the
  round-complete handler applies at 5366/5478 — filter out `from`'s head /
  `teamHeadName(group)`). A team with no researchers still closes — researcher
  seats are simply an empty list.

### src/services/PlanIngestionEngine.ts

- **Context:** `_runMemberCompletionReminderSweep` gates at 2124-2162; `db` is
  already a sweep arg.
- **Logic:** add a gate — a member seat with
  `await db.countOutstandingResearchForSeat?.(seat) > 0` is waiting on
  research, not idle: skip it (counted as waiting, logged once per tick, never
  reminded). Optional-chain the accessor so older DBs degrade to today's
  behaviour.
- **Edge Cases:** A working seat with outstanding research is already excluded
  by the quiet gates (recent `lastDataAt`); this gate only bites for a quiet
  held-card seat, which is exactly the waiting shape.

## Verification Plan

### Automated Tests
- Planner with one `queued` request reports `done` → 200 with
  `waiting:'research'`, card still stamped to the seat, no pop, no clear.
- After `research-complete` + notify, the re-reported `done` releases normally.
- Two planners, one waiting: round stays open; when the second finishes and no
  planner holds a card or outstanding request, planner + researcher seats are
  cleared (`clearSeatAtRest` with reason `planning-round-complete`) and
  `onTeamReleased` fires exactly once.
- A seat with fresh `lastDataAt` output is skipped by the close with a logged
  reason — never cleared mid-turn.
- The reminder sweep skips a quiet seat with outstanding research and still
  reminds a quiet seat with none.
- Dead planner holding a card: round stays open (documented surfaced-stall, not
  silence).

### Goal Invariants
- Assert a `done` with outstanding research leaves `owner_seat` stamped
  (negative: no release while waiting), paired with: the response carries
  `waiting:'research'` (positive: the seat can tell waiting from done).
- Assert `onTeamReleased` fires exactly once at round end (negative: no second
  fire on the sibling release).
- Assert the reminder sweep contains a `countOutstandingResearchForSeat` gate
  (negative: a waiting seat is never nagged as stuck).

## Constraints

**Every seat-facing call is a CLI verb, never raw HTTP.** A documented raw POST
403s — `_isAllowedCrossSiteRequest` refuses a request with no
`X-Switchboard-Client` marker, and `cli.ts` is what sets it. The 2026-09-10
correction at `LocalApiServer.ts:1161` forbids raw-HTTP forms "in the team
prompts".

**Do not name `write_to_file`.** It does not exist in a Claude Code seat. Name
the deliverable and its path; let the seat choose its tool.

**No sessionId.** Identifiers are `planId`, `requestId` or a seat name.

**Tag every resolved value.** "No researcher is free" and "this team has no
researcher" are different answers and must not render the same.

**Complexity:** 6
**Routing:** Send to Coder
