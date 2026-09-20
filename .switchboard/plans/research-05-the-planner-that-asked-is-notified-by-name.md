# Research 05 — The Planner That Asked Is Notified by Name

Subtask of the feature **A Research Request Is Queued Inside the Team, and Answered Back to the Planner That Asked** (`cf5537c5`). The feature file carries the full argument and the constraints binding every subtask. This plan is self-sufficient on its own scope and, where the two disagree, **this plan wins** — it is the source of truth for the seat implementing it.

## Goal

When a research request is answered, the **seat that asked** is told — by name,
with the findings path.

This subtask adds one block to Research-04's `_handleResearchComplete`, at the
seam comment that plan leaves. It owns no other surface.

## This is the change the whole feature exists for

Measured 2026-09-19/20: the researcher answered correctly, filed an accurate
report naming the findings path, and the planner that raised the question was
never told. It found the file only because an unrelated member-completion nudge
woke it and it re-oriented. That is luck, not a path.

Every completion route in the product addresses the **team head** and only the
team head. `Planning-planner-1` was not addressable at all.

## Metadata

- **Tags:** backend, api, feature
- **Complexity:** 3
- **Project:** Orchestration

## User Review Required

- None.

## Complexity Audit

### Routine
- One `ptySendPrompt` call through the existing `terminalVerb` seam — the same
  delivery mechanism `_handleTeamQueueDone` uses at `LocalApiServer.ts:9702`,
  with the same `kind: 'message'`, `machineOrigin: true`,
  `clearBeforePrompt: false`, `standingOrders: false` flags a relay uses.

### Complex / Risky
- The prompt lands inside the requester's *running turn* by design — that is
  correct here (the planner is waiting on this answer; it is a message, not a
  dispatch), but the send's resolved failure must not be swallowed:
  `ptySendPrompt` reports a dead recipient as `{ success:false }`, never a
  throw (`LocalApiServer.ts:7070-7075` comment). Check the body.
- **Not the head.** The single regression this subtask can ship is falling
  back to `teamHeadName` when `requestedBy` resolution gets awkward. Dead
  requester → surfaced event, never head-substitution.

## Edge-Case & Dependency Audit

- **Race Conditions:** The planner may have exited between filing and answer —
  send returns `success:false`; handle per below. A requester mid-turn
  receives a `kind:'message'` prompt — no `clearBeforePrompt`, context intact.
- **Security:** None new — `requestedBy` came from the host-injected identity
  at file time (Research-02), not from the researcher's input.
- **Side Effects:** One prompt to the requesting seat; one `plan_events` row
  either way (delivered or requester-gone).
- **Dependencies & Conflicts:** Research-04 owns the handler this extends; the
  notify block is inserted at its seam comment. No schema change — `doc_path`,
  `requested_by`, `question`, `plan_id` all already on the row.

## Dependencies

- Research-04 (`_handleResearchComplete` tail seam). Research-07's waiting
  predicate pairs with this: the notify is what wakes the waiting planner to
  re-report `done`.

## Adversarial Synthesis

Key risks: substituting the head when the requester is unreachable (forbidden
— surface instead), and a failed send swallowed as success (check the resolved
body, per the 7070 contract). Both are cheap to get right and expensive to get
wrong.

## Proposed Changes

### src/services/LocalApiServer.ts

- **Context:** Inside `_handleResearchComplete` (Research-04), after the
  request is marked `answered` and the plan link is appended — a notify
  failure must not un-answer the request.
- **Logic:**
  1. Compose the notice: `[research] <requestedBy>, your question on plan
     <planId> is answered — "<question>" → <docPath> (request <requestId>).
     Fold it into your plan.` Include the plan file path already resolved in
     step 5 of the parent handler.
  2. `terminalVerb('ptySendPrompt', { name: requestedBy, data, kind:'message',
     machineOrigin:true, clearBeforePrompt:false, standingOrders:false })`.
  3. On resolved `{ success:false }` or throw: write a `plan_events` row via
     `db.appendPlanEventByPlanId` (`KanbanDatabase.ts:13826` — event type e.g.
     `research.requester_gone`, carrying requestId + requestedBy + docPath)
     and warn-log — **surfaced, not silently dropped**. Do NOT relay to the
     head; the plan-file link (Research-04) is the durable record and a later
     seat can pick it up.
  4. Response gains `notified: bool` + `notifyReason` so the researcher seat
     and any debugger can see what happened.
- **Edge Cases:** `requestedBy` equals the completing researcher (a researcher
  filing for itself) → send is still correct; no special case needed. Empty
  `requested_by` on a legacy row → 500-adjacent loud error, never head
  fallback.

## Verification Plan

### Automated Tests
- The prompt goes to `requestedBy` and **not** to the team head — asserted by
  seat name on the `ptySendPrompt` spy. This is the 2026-09-19 failure as a
  fixture.
- The prompt contains the findings path, the original question and the
  planId.
- A request whose requester has since exited is surfaced: `success:false`
  send → `plan_events` row written, response carries `notified:false` +
  reason, and the request still reads `answered` with the plan link intact.

### Goal Invariants
- Assert the `ptySendPrompt` `name` argument equals the row's `requested_by`,
  and `teamHeadName(group)` never appears as its value (negative), paired
  with: the `plan_events` surfacing row exists when the send fails
  (positive).

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

**Complexity:** 3
**Routing:** Send to Intern
