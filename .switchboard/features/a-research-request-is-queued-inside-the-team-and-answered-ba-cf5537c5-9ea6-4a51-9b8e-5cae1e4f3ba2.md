# A Research Request Is Queued Inside the Team, and Answered Back to the Planner That Asked

**Complexity:** 4

## Goal

A planner files a research request against its own plan and keeps working. One researcher works one request at a time from a team-owned queue; the answer is written to a doc, linked into the plan, and delivered BY NAME to the seat that asked. A round ends only when no planner is waiting on research.

*This feature file is self-contained: the full argument, the constraints that
bind every subtask, and the invariants the whole feature is judged against are
below. Each subtask plan is also self-sufficient on its own scope, and where a
subtask's plan and this summary disagree, **the subtask plan wins** — it is the
source of truth for the seat implementing it.*

## Problem analysis

### Today the findings reach nobody, and the only reader is unaddressable

Measured on the live board, 2026-09-19/20, Planning team:

`Planning-planner-1` filed a `finished` report reading *"flagged Linear
parent-updatedAt uncertainty for research."* `Planning-researcher` answered it —
24KB, sourced, written to `.switchboard/docs/linear-updatedat-hierarchy-semantics.md`.
**Planner-1 was never told.** It found the file only because an unrelated
member-completion nudge woke it and it re-oriented. That is luck, not a path.

The researcher's prompt already names the right reader — `bootstrap.ts:5320`
says *"so the plan author can review them later"* — and **nothing in the system
resolves "the plan author" to a seat.** Every completion route addresses the
team head and only the team head.

### "Report" already means three different things

The researcher separated them itself, correctly:

| obligation | destination | who reads it |
| :--- | :--- | :--- |
| research output | `.switchboard/docs/` | nobody is notified |
| state declaration | `.switchboard/teams/<id>/reports/` | the status pane |
| completion relay | the 3-route ladder | the head |

The only route that reaches an agent is the ladder, and it is the one that
cannot carry content.

### The ladder is broken in a way that punishes capability

`buildMemberCompletionFragment` (`standingOrderFragments.ts:94`) gives three
EXCLUSIVE routes. A researcher never has a PLAN_ID, so it always lands on
Route 2: `POST /terminals/teams/<teamId>/queue/done`.

1. **Route 2 403s when followed literally.** It is a raw HTTP POST with no
   `X-Switchboard-Client` marker, and `_isAllowedCrossSiteRequest` rejects it.
   The live researcher got `403 Access denied: cross-site request rejected`,
   guessed a workaround (`Origin: http://127.0.0.1:7777`) and retried. The
   2026-09-10 correction at `LocalApiServer.ts:1161` already forbids raw-HTTP
   forms "here, in the feature-complete sibling, **or in the team prompts**" —
   it was applied to the lead's fragment and never to the member's.
2. **Route 2 carries no content.** `_handleTeamQueueDone` reads exactly `from`
   and `planId`. The relay it composes is
   `[queue/done] <seat> reports its dispatched task complete` — a notification.
   The orders promise *"the system will relay your report"*. There is no report
   in the payload.
3. **Exclusivity then suppresses Route 3**, the only route carrying
   `"data":"<your report>"`. The live researcher declined it deliberately and
   said so: *"Route 2 succeeded, so sending this too would have been the
   duplicate-prompt failure the orders warn about."*

These invert on capability: the 403 would have pushed a weaker seat to Route 3
and its findings would have arrived. **Repairing the 403 without first fixing
content delivery makes the system strictly worse.**

### Nothing paces the researcher

There is one researcher seat and no queue in front of it. The planner fan-out
(`_distributePlannerDispatch`) already caps a batch at the number of planner
seats, so four planners finishing together is the *designed* case — and all
four would hand work to one researcher at once. Whichever prompt lands last
wins the seat's attention; the others are interleaved into a running turn.

### A round has no end

Nothing marks a planning batch complete, so terminals are never cleared and the
team never reads as free. `coding_rounds` is the precedent for the coding side;
planning has no equivalent.

## Constraints

**Every seat-facing call is a CLI verb, never raw HTTP.** This is the
2026-09-10 correction and it is non-negotiable: a documented raw POST 403s, and
the agents that "work around it" hide the defect. If a seat must reach the
board, it runs `switchboard <verb>`; `cli.ts` sets the client marker.

**Do not name `write_to_file`.** It does not exist in a Claude Code seat. It is
named in `agentPromptBuilder.ts:2862`, `TaskViewerProvider.ts:7488` and
`bootstrap.ts:5320`, and the live researcher had to substitute a Bash heredoc.
Name the deliverable and its path; let the seat choose its tool.

**No sessionId.** Every identifier here is a `planId`, a `requestId` or a seat
name.

**The requester's identity is the point.** A research request that does not
record which seat asked cannot be answered, and is the defect this plan exists
to fix. It is carried end to end, never re-derived from "the head".

**Tag every resolved value.** "No researcher is free" and "this team has no
researcher" are different answers and must not render the same. A queued
request that nothing will ever serve is surfaced, not silently held.

**No confirmation dialogs.**

## Goal invariants for the whole feature

- A research answer always reaches the seat that asked the question.
- One researcher works one request at a time; a backlog queues visibly.
- A plan file carries its own open questions and its own answers.
- A round has an end, and the team reports itself free at it.
- No seat is ever told to make a call that 403s.

## Resolved decisions

Both questions this feature carried are answered. Nothing is outstanding.

- **More than one request per plan — yes, and the waiting predicate is a count.**
  A planner may file several requests against one plan, queued independently; a
  round closes only when every plan's outstanding count is zero. Research-01's
  accessor is `countOutstandingResearchForSeat`, Research-07 gates the
  member-completion reminder sweep on `> 0` and derives the round close from the
  same count, and Research-05's notify is what wakes a waiting planner to
  re-report. The predicate must therefore be evaluated on every research
  completion, not only on `done`.

- **Operator visibility of the queue — no surface is built.** The operator asks
  the controller agent instead, and the controller unsticks a stuck queue if one
  appears. Neither is required for the normal path: the drain self-heals —
  Research-03's pump re-assigns, and Research-06 requeues a dead researcher's
  `assigned` rows and re-pumps the affected teams.

  **Named dependency, not a solved path.** None of the eight subtasks gives the
  controller a way to *read* queue state or to *force* an unstick, and no verb
  exists for either — `grep -iE 'controller|mission control|unstick'` over the
  research plans returns nothing. The case that needs one is Research-06's own
  accepted outcome: on a **registered** team a dead researcher leaves its
  requests `queued` with no live seat to serve them (deliberately not
  `abandoned`, because the roster still names a researcher). That backlog is
  visible today only by reading the queue rows directly. If the controller is to
  unstick it, that is follow-up work: a queue-state read and a requeue action,
  both as CLI verbs (never raw HTTP — the feature's own constraint).

## Sequencing note

**This plan must land before the Planning member-completion nudge is removed.**
Commit `408101ac` suppresses that nudge for headless teams. On the live board
that nudge is currently the only thing that causes a planner to re-orient and
discover a report — accidentally, but it is what worked on 2026-09-19.
Removing it first would replace a wasteful path with no path at all, and the
failure would be silent.

## Recovered notes from an interrupted pass

A planner seat was improving this feature on 2026-09-20 and was killed mid-write
by a board restart. Its partial draft was salvaged from the terminal log and
saved to **`.switchboard/docs/recovered-planning-seat-draft-20260920.md`**.

It is fragmentary and reconstructed from a rendered pty log — notes, not a plan —
but it carries specific findings worth not re-deriving: the seat-exit signal is a
composition-root seam (`handle.onExit` → `emitter.emit('change', { type: 'closed' })`,
`ptyFleetService.ts:723-757`), `_pumpResearchQueue` belongs at the
`_handleResearchComplete` seam, and a killed seat's request must not be claimed
twice on requeue — Research-01's conditional-UPDATE claim is the guard.

Read it before re-deriving that ground. Where it disagrees with a subtask plan,
the subtask plan wins.

## How the Subtasks Achieve This

- **Research 01 — A Research Queue the Team Owns**: the `research_requests`
  table (V84) and its accessors — the durable store carrying `requested_by`,
  which is the identity the whole feature exists to deliver to.
- **Research 02 — A Planner Files a Request and Keeps Working**: the
  `research-request` CLI verb and `POST /research/request` enqueue endpoint,
  plus the directive rewrite that makes the verb the only documented path.
- **Research 03 — The System Assigns One Request to a Free Researcher**: the
  `_pumpResearchQueue` pump — one researcher, one request, visible backlog,
  `abandoned`-with-reason when no researcher exists.
- **Research 04 — The Researcher Answers and the Plan Gains a Link**: the
  `research-complete` verb and `_handleResearchComplete` — marks answered,
  appends the findings link to the plan file, and cleans `write_to_file` out of
  seat-facing prompts.
- **Research 05 — The Planner That Asked Is Notified by Name**: the notify block
  inside `_handleResearchComplete` that delivers the answer to `requested_by`
  specifically — never the head — the change the feature exists for.
- **Research 06 — The Queue Drains, and a Dead Researcher Does Not Swallow a
  Request**: the drain trigger on completion and the `reportSeatExited` seam
  that requeues a dead researcher's `assigned` row and re-pumps.
- **Research 07 — A Planner Waits on Research, and a Round Ends Cleanly**: the
  `waiting-on-research` gate in `_runQueueDone` and the derived planning-round
  close that clears the round's seats and fires `onTeamReleased` once.
- **Research 08 — The Member Fragment Stops Sending Seats to a Raw POST**: the
  `report` field on team `queue/done`, the `queue-done` CLI verb, and the
  fragment rewrite — the ladder defect fix the feature's problem analysis
  diagnosed.

## Dependencies & sequencing

Shipping order within the feature:

1. **Research-01** first — every sibling consumes the store.
2. **Research-02** — needs `insertResearchRequest`; leaves the pump seam comment.
3. **Research-04** — needs Research-01; MUST land before Research-03 so no live
   researcher is ever dispatched a prompt naming a `research-complete` verb that
   does not exist.
4. **Research-03** — needs Research-01 and the Research-02 seam.
5. **Research-05** — extends Research-04's handler at its seam.
6. **Research-06** — extends Research-03's pump and Research-04's handler.
7. **Research-07** — needs Research-01's count accessor and Research-05's notify
   (the notify is what wakes a waiting planner to re-report).
8. **Research-08** — independent of the research table; can land in any slot.
   Its internal ordering is the constraint: the `report` field + relay land
   before or with the `queue-done` verb, never after.

Notes:

- Subtasks 02–07 all touch `LocalApiServer.ts`, and 02/04/08 all touch `cli.ts`
  registration — parallel seats editing these files will collide; land them in
  the order above or expect merge conflicts on the route table and subcommand
  sets.
- The feature's open question "more than one request per plan?" is resolved by
  the set: **yes** — requests queue independently and the waiting predicate is
  a count (`countOutstandingResearchForSeat`), so a round waits on all of them.
- The sequencing note above stands: this feature lands before the Planning
  member-completion nudge is removed.

## Team Dispatch Instructions

### Research 01 — A Research Queue the Team Owns
- **Seat:** coder
- **Acceptance:**
  - `research_requests` table in `SCHEMA_TABLES_SQL` + additive V84 migration
  - conditional-UPDATE claim accessor; `assigned → queued` requeue edge exists
  - `requested_by` survives a DB close/reopen; teams cannot see each other's rows
- **Must not touch:** the verbs, dispatch pump, and notification paths (sibling
  subtasks); `sweepOrphanedRuntimeState` must not gain a clause for this table.

### Research 02 — A Planner Files a Request and Keeps Working
- **Seat:** coder
- **Acceptance:**
  - `research-request` in both CLI subcommand sets; resolves `from` from
    `SWITCHBOARD_TERMINAL` with the loud named-variable failure
  - `POST /research/request` 400s a non-roster or teamless seat, 200s a valid
    filing with `requestId` + `position`
  - `ADVISE_RESEARCH_DIRECTIVE_HANDOFF` names the verb; zero `research/dispatch`
    instructions remain in seat-facing text
- **Must not touch:** assignment/dispatch logic (Research-03); the handler's
  tail carries only the seam comment — no pump call yet.

### Research 03 — The System Assigns One Request to a Free Researcher
- **Seat:** coder
- **Acceptance:**
  - `_pumpResearchQueue` serialized per team on `_researchPumpChains`
  - three researcher-resolution failure modes surface three distinct reasons
  - at most one `assigned` row per researcher seat; no prompt into a busy seat
- **Must not touch:** the request lifecycle accessors (Research-01); the
  dispatch prompt must not name `write_to_file`.

### Research 04 — The Researcher Answers and the Plan Gains a Link
- **Seat:** coder
- **Acceptance:**
  - `research-complete` verb registered; 403 when `from` ≠ `assigned_to`, 409
    on double-complete
  - plan file gains `- **Q:** … → [findings](…)` under `## Research Findings`,
    append-only, idempotent heading
  - zero `write_to_file` in seat-facing strings; the stale test assertion and
    the agent-control tooltip are updated, not kept
- **Must not touch:** the notify-to-requester step (Research-05) and the drain
  call (Research-06) — seam comments only.

### Research 05 — The Planner That Asked Is Notified by Name
- **Seat:** intern
- **Acceptance:**
  - `ptySendPrompt` `name` equals the row's `requested_by` — never the head
  - `success:false` send → `plan_events` row + `notified:false` + reason; the
    request still reads `answered`
- **Must not touch:** anything outside the notify block in
  `_handleResearchComplete`; no head-substitution fallback.

### Research 06 — The Queue Drains, and a Dead Researcher Does Not Swallow a Request
- **Seat:** coder
- **Acceptance:**
  - `research-complete` drains one queued request post-response
  - `reportSeatExited` requeues a dead seat's `assigned` rows and re-pumps;
    never double-claims
  - `bootstrap.ts` `onDidChange` `closed` branch calls it (one hook covers
    `kill()` and natural exit)
- **Must not touch:** assignment logic in the pump; the extension host's exit
  seam (standalone-only wiring, cutover).

### Research 07 — A Planner Waits on Research, and a Round Ends Cleanly
- **Seat:** coder
- **Acceptance:**
  - `done` with outstanding research → `waiting:'research'`, stamp kept, no pop
  - last release closes the round: planner + researcher seats cleared (never
    mid-turn), `onTeamReleased` exactly once
  - member-reminder sweep skips seats with outstanding research
- **Must not touch:** `coding_rounds` machinery (different feature);
  `clearSeatAtRest`'s own contract.

### Research 08 — The Member Fragment Stops Sending Seats to a Raw POST
- **Seat:** coder
- **Acceptance:**
  - `queue/done` accepts `report` and relays it verbatim; `{from}`-only posts
    still work
  - `queue-done` verb registered; member fragment + head-next fragment name it;
    zero `POST /terminals/` in seat-facing text
- **Must not touch:** `/kanban/queue/done` semantics (`cmdDone` Route 1 stays
  as-is).

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Research 01 — A Research Queue the Team Owns](../plans/research-01-a-research-queue-the-team-owns.md) — **PLAN REVIEWED** — ID: f5085e40-1df5-4a25-9c13-7b779ce971a2
- [ ] [Research 02 — A Planner Files a Request and Keeps Working](../plans/research-02-a-planner-files-a-request-and-keeps-working.md) — **PLAN REVIEWED** — ID: 13d6c54d-bf1a-4ade-a6b2-e9a3402c4091
- [ ] [Research 03 — The System Assigns One Request to a Free Researcher](../plans/research-03-the-system-assigns-one-request-to-a-free-researcher.md) — **PLAN REVIEWED** — ID: e55efa4c-e127-4533-930f-65b954246b27
- [ ] [Research 04 — The Researcher Answers and the Plan Gains a Link](../plans/research-04-the-researcher-answers-and-the-plan-gains-a-link.md) — **PLAN REVIEWED** — ID: 8cddcc13-cc35-42f4-ad1c-c9d205a46de4
- [ ] [Research 05 — The Planner That Asked Is Notified by Name](../plans/research-05-the-planner-that-asked-is-notified-by-name.md) — **PLAN REVIEWED** — ID: 9c1861a2-45b0-4ee9-88de-fee51918b26a
- [ ] [Research 06 — The Queue Drains, and a Dead Researcher Does Not Swallow a Request](../plans/research-06-the-queue-drains-and-a-dead-researcher-does-not-swallow-a-request.md) — **PLAN REVIEWED** — ID: 402fcf4a-2e26-4cdf-b249-002a876b5748
- [ ] [Research 07 — A Planner Waits on Research, and a Round Ends Cleanly](../plans/research-07-a-planner-waits-on-research-and-a-round-ends-cleanly.md) — **PLAN REVIEWED** — ID: 91bd8e7d-7044-42e3-9e13-570681b06ffb
- [ ] [Research 08 — The Member Fragment Stops Sending Seats to a Raw POST](../plans/research-08-the-member-fragment-stops-sending-seats-to-a-raw-post.md) — **PLAN REVIEWED** — ID: 70edde89-907f-4c6c-9ff4-d54beee59435
<!-- END SUBTASKS -->


## Improve pass — 2026-09-20

All eight subtasks reviewed against the live code. Research-01..05 were already full-schema and verified accurate (line refs, accessor contracts, handler seams); small factual corrections applied — `sweepOrphanedRuntimeState` ref, the "curl" wording in 02 (the constant instructs a raw POST, verified no copy in `bundledProtocols.ts`), confirmed `role` present on `FleetTerminalInfo`/`FleetLivenessEntry` for 03, added the stale test assertion and tooltip to 04's `write_to_file` cleanup, named `appendPlanEventByPlanId` in 05. Research-06/07/08 were stubs and were rewritten to the full schema: 06 owns the drain trigger + a new `reportSeatExited` composition-root seam wired at `bootstrap.ts:4369`; 07 owns the `waiting-on-research` gate in `_runQueueDone` (keeps the stamp, gates the member-reminder sweep on the research count) and a derived planning-round close firing `onTeamReleased` once; 08 owns the `report` field on team `queue/done`, a `queue-done` CLI verb, and both fragment rewrites — content fix ordered before the verb. Reconciliation found no contradictions; ship order is 01 → 02 → 04 → 03 → 05 → 06 → 07 with 08 independent. The "multiple requests per plan" open question resolves to yes — the waiting predicate is a count.
