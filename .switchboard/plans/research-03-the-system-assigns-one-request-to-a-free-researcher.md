# Research 03 — The System Assigns One Request to a Free Researcher

Subtask of the feature **A Research Request Is Queued Inside the Team, and Answered Back to the Planner That Asked** (`cf5537c5`). The feature file carries the full argument and the constraints binding every subtask. This plan is self-sufficient on its own scope and, where the two disagree, **this plan wins** — it is the source of truth for the seat implementing it.

## Goal

One researcher works one request at a time, chosen by the system, with a visible
queue behind it.

This subtask owns the pump — `_pumpResearchQueue(workspaceRoot, teamId)`, a
LocalApiServer method — and exactly one of its trigger call sites (on enqueue,
inside Research-02's `_handleResearchRequest`). Research-06 adds the other two
triggers (on researcher release, on seat exit) against this same pump; nothing
else defines assignment logic.

## Why pacing matters

The planner fan-out caps a batch at the number of planner seats, so four planners
finishing together is the **designed** case — and all four would hand work to one
researcher at once. Whichever prompt landed last would win the seat's attention;
the others would be interleaved into a running turn.

## Metadata

- **Tags:** backend, api, feature, reliability
- **Complexity:** 5
- **Project:** Orchestration

## User Review Required

- None.

## Complexity Audit

### Routine
- One private method plus a one-line call site; delivery goes through the
  already-wired `terminalVerb('ptySendPrompt', …)` seam (the same seam
  `_handleTeamQueueDone` uses at `LocalApiServer.ts:9702,9737`), so no new
  composition-root wiring is required in either host.

### Complex / Risky
- "Free researcher" resolution has three failure modes that must stay
  distinct: team has no researcher on its roster, researcher(s) exist but are
  dead, researcher(s) live but busy. Each must surface a different reason
  string (constraint: tag every resolved value).
- Live-seat enumeration: `role` IS present on the payload — verified this
  pass: `FleetTerminalInfo.role` (`ptyFleetService.ts:75`) and
  `FleetLivenessEntry.role` (`ptyFleetService.ts:252`), with a contract test
  asserting it (`standalone-agent-team-isolation-contract.test.js:286`). Keep
  the roster-name `*-researcher*` fallback for non-fleet terminal lists AND
  record which signal answered in the log line.
- Claim must be the conditional UPDATE from Research-01
  (`claimOldestQueuedResearchRequest`) — read-then-write double-assigns.

## Edge-Case & Dependency Audit

- **Race Conditions:** Two triggers can fire together (enqueue racing a
  release). Serialize the pump per team — a `_researchPumpChains` Map
  patterned on `_teamQueueDoneChains` (`LocalApiServer.ts:9654`). Even so, the
  conditional UPDATE is the last line of defence: a pump that loses the claim
  simply exits.
- **Security:** The prompt interpolates seat-supplied `question` — treat as
  untrusted text, no shell evaluation anywhere in the path.
- **Side Effects:** Sends a dispatch prompt (a new turn for the researcher) —
  never into a running turn, which is why assignment is one-at-a-time and the
  seat must be free *by the queue's own record*, not by guessing at its
  output stream.
- **Dependencies & Conflicts:** Research-01 (`claimOldestQueuedResearchRequest`,
  `listResearchRequests`, `abandonResearchRequest`); Research-02 (the handler
  this adds a line to); Research-04 (the `research-complete` verb the dispatch
  prompt names — land order matters, see Dependencies).

## Dependencies

- Research-01, Research-02. The dispatch prompt instructs the researcher to
  run `switchboard research-complete` — that verb is Research-04, so this
  subtask lands after it in the ship order (the code compiles either way; the
  ordering is about a live researcher never being handed a dead verb).

## Adversarial Synthesis

Key risks: assigning into a busy seat (the exact failure the feature exists to
kill — mitigated by queue-record-based freeness plus serialized pump), and a
request silently rotting when no researcher exists (mitigated by
`abandoned`-with-reason surfacing, never an empty read).

## Proposed Changes

### src/services/LocalApiServer.ts

- **Context:** New private method `_pumpResearchQueue(workspaceRoot, teamId)`,
  a module-level `_researchPumpChains` map mirroring `_teamQueueDoneChains`
  (9654), and one new line at the end of `_handleResearchRequest` (the seam
  comment Research-02 leaves).
- **Logic, in order:**
  1. Serialize per `teamId` on `_researchPumpChains`.
  2. Resolve the registered group: `_resolveRegisteredTeamGroup(workspaceRoot,
     teamId)` (9400). Roster = `group.order` else `group.members`.
  3. Live seats: `terminalVerb('ptyListTerminals', {}, workspaceRoot)`; a
     researcher seat = roster member whose live entry has `role ===
     'researcher'` (or, if the payload carries no role, the roster name
     matching `*-researcher*` — record which signal answered in the log line).
  4. Free = live AND not the `assigned_to` of any `assigned` row for this team.
  5. No researcher on roster → mark every `queued` request for the team
     `abandoned` with reason surfaced in a `plan_events` row + warn log:
     "team '<id>' has no researcher seat". **Not** silently held.
  6. Researcher exists, none free → return; the requests stay `queued` and
     `GET`-readable — a visible backlog, not silence.
  7. Free researcher → `claimOldestQueuedResearchRequest(teamId, seatName)`;
     on null, exit (a racing pump claimed it). On a row, compose the dispatch
     prompt and `ptySendPrompt` with `kind: 'dispatch'`.
  8. If the send fails, `requeueResearchForSeat` is NOT the right tool (seat
     is alive, send failed) — write the row back to `queued` via a direct
     state update and warn; the next trigger retries.
- **The dispatch prompt carries:** the question verbatim, the `planId`, the
  plan file path (resolve `plans.plan_file` by `plan_id` via
  `getKanbanDatabase`), the `requestId`, the findings path the researcher must
  write (`.switchboard/docs/<slug>.md` — the host ensures the directory
  exists before dispatch, per Research-04's mkdir), and the completion
  instruction: `switchboard research-complete --request <requestId> --doc
  <path>`. Enough to work standalone — the researcher cannot see the planner's
  conversation. It does NOT name `write_to_file` or any other tool.
- **Edge Cases:** Multiple researcher seats on one team → any free one may be
  claimed; still one request per seat. A `queued` request whose team group was
  deleted → `abandoned` with reason, surfaced.

## Verification Plan

### Automated Tests
- Four requests filed simultaneously: exactly one `assigned`, three `queued`,
  in `created_at` order. Assert the single `ptySendPrompt` call (spy on
  `terminalVerb`) — no prompt is delivered into a running turn.
- "No researcher free" and "no researcher on the team" produce distinguishable
  outcomes: the former leaves rows `queued`; the latter marks them `abandoned`
  and emits a named reason. Each with a source string in the log.
- The dispatched prompt contains the question, planId, plan path and
  requestId; grep it contains no `write_to_file`.
- A second pump invocation while one is in flight serializes (no interleaved
  claims) — two queued rows, two sequential pump calls, two assignments, never
  one row assigned to two seats.

### Goal Invariants
- Assert at most one `research_requests` row per researcher seat is `assigned`
  at any moment.
- Assert a `queued` row on a researcher-less team transitions to `abandoned`
  with a reason, never remains `queued` silently.

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

**Complexity:** 5
**Routing:** Send to Coder
