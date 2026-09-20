# Research 06 — The Queue Drains, and a Dead Researcher Does Not Swallow a Request

Subtask of the feature **A Research Request Is Queued Inside the Team, and Answered Back to the Planner That Asked** (`cf5537c5`). The feature file carries the full argument and the constraints binding every subtask. This plan is self-sufficient on its own scope and, where the two disagree, **this plan wins** — it is the source of truth for the seat implementing it.

## Goal

Releasing a researcher immediately pulls the next queued request, and a
researcher that dies returns its request to the queue.

This subtask owns the two remaining pump triggers: the drain call at the tail of
Research-04's `_handleResearchComplete`, and a new public `reportSeatExited`
method on `LocalApiServer` that the composition root calls when a seat's pty
closes. It owns no assignment logic — `_pumpResearchQueue` (Research-03) is the
only assigner.

## Metadata

- **Tags:** backend, api, feature, reliability
- **Complexity:** 5
- **Project:** Orchestration

## User Review Required

- None.

## Complexity Audit

### Routine
- One fire-and-forget pump call appended to `_handleResearchComplete` (the seam
  comment Research-04 leaves), and one line in the standalone fleet-change
  handler at `bootstrap.ts:4369-4378` — beside the existing
  `ManualGroupStore.onTerminalExit` call, which already fires on the same
  `{type:'closed'}` event.

### Complex / Risky
- The seat-exit signal is a **composition-root seam**. `ptyFleetService` emits
  `{type:'closed'}` on BOTH death paths — `handle.onExit` self-exit
  (`ptyFleetService.ts:723-757`) and `kill()` (`ptyFleetService.ts:1234`) — so
  the single `onDidChange` subscription at `bootstrap.ts:4369` covers natural
  exit and operator kill. Wiring is standalone-only: the extension host is the
  legacy root being removed (its counterpart seam is `TaskViewerProvider.ts:4519`
  — named here for the record, not wired).
- Requeue must not resurrect a request the dead seat already answered. The
  conditional-UPDATE accessors from Research-01 are the guard: `requeue` touches
  only `assigned` rows for that seat, `claim` only `queued` rows.
- A requeued request on a **registered** team stays `queued` when its researcher
  is dead: registered rosters keep dead members (only `ManualGroupStore` drops
  them via `onTerminalExit`), so the pump's "researcher exists but none live"
  branch applies — visible backlog, NOT `abandoned`. On a **manual-group** team
  the exit drops the member first, so the same pump marks it `abandoned` with a
  named reason. Both outcomes are loud; neither holds the request silently.

## Edge-Case & Dependency Audit

- **Race Conditions:** Exit-event requeue racing a late `research-complete` from
  the dying seat resolves on whichever conditional UPDATE commits first —
  `complete` requires `state='assigned'` (409 otherwise), `requeue` requires it
  too. Two exit events or an exit racing a drain serialize on
  `_researchPumpChains` (Research-03).
- **Security:** None new — no seat-supplied input; the seat name comes from the
  fleet event.
- **Side Effects:** On exit: `assigned → queued` rows for the dead seat, then a
  pump per affected team. On complete: one pump for the request's team.
- **Dependencies & Conflicts:** Research-01 (`requeueResearchForSeat` returns
  affected `team_id`s so the caller can re-pump), Research-03 (the pump),
  Research-04 (the handler extended at its tail seam). `server` in the
  bootstrap closure is declared `let` at `bootstrap.ts:843` and assigned ~4691 —
  optional chaining, same as the adjacent `broadcastWs` call.

## Dependencies

- Research-01, Research-03, Research-04. Lands after all three: it adds call
  sites to their machinery and defines none of it.

## Adversarial Synthesis

Key risks: a request claimed twice after requeue (conditional UPDATE is the last
line of defence), and a dead registered-team researcher leaving the request
`queued` forever with no live seat to serve it (accepted — `queued` is the
visible-backlog answer for "researcher exists but dead"; abandonment is reserved
for "no researcher on roster"). Mitigations: the pump's three-way researcher
resolution keeps the states distinct, and every transition is a conditional
UPDATE so the loser of any race is a no-op, not a double-claim.

## Proposed Changes

### src/services/LocalApiServer.ts

- **Context:** `_handleResearchComplete` tail seam comment (Research-04 step 7);
  `reportQueueDone` (`LocalApiServer.ts:6736`) is the precedent for a public
  composition-root entry point — the host calls it, it runs the critical
  section, it never throws.
- **Logic:**
  1. In `_handleResearchComplete`, after the `200` response is written:
     `void this._pumpResearchQueue(workspaceRoot, teamId).catch(err =>
     console.warn(...))`. Fire-and-forget AFTER the response — the answer is
     already recorded; a pump failure must not 500 a completed request, and the
     seat needs its response without waiting on the next dispatch.
  2. New public method `reportSeatExited(seatName: string, workspaceRoot?:
     string): Promise<void>` — never throws (the fleet event path must not be
     crashed by a queue concern):
     - `const teamIds = await db.requeueResearchForSeat(seatName)` — flips that
       seat's `assigned` rows to `queued`, clears `assigned_to`/`assigned_at`,
       returns the affected `team_id`s (empty for a non-researcher exit — the
       whole call is then a no-op).
     - For each returned `teamId`: `void this._pumpResearchQueue(wsRoot, teamId)`
       — the next queued request goes to the next free researcher, or stays
       visibly `queued` if none is live.
     - Warn-log the seat name, the affected teams, and the requeued count.
- **Edge Cases:** A `queued` (never-assigned) request's seat dying → nothing to
  requeue; pump runs anyway and may assign it to a surviving researcher. Exit
  event for a seat with zero requests → one cheap UPDATE, done.

### src/standalone/bootstrap.ts

- **Context:** the `ptyFleetService.onDidChange` handler at
  `bootstrap.ts:4369-4378` already calls `ManualGroupStore.onTerminalExit` on
  `{type:'closed'}` — the same event covers `kill()` and natural exit.
- **Logic:** in the same `if (e && e.type === 'closed' && e.name)` block, add
  `void server?.reportSeatExited?.(e.name).catch(() => {})` beside the existing
  `onTerminalExit` call. Optional chaining on both `server` (assigned later in
  the closure) and the method (absent in test harnesses).
- **Edge Cases:** `ptyCloseTerminal` (`bootstrap.ts:2704-2709`) does NOT need a
  second call — `kill()` emits `closed` too; one hook covers both.

## Verification Plan

### Automated Tests
- Backlog of three `queued` requests, one researcher: each `research-complete`
  drains exactly one more request — no operator action, no poll. Assert the
  pump ran after the response (spy) and the response did not wait on it.
- Kill a researcher mid-request (invoke `reportSeatExited`): its `assigned` row
  returns to `queued` and is claimed by the next free researcher; with none
  free on a registered team it stays `queued`; on a manual group whose roster
  dropped the seat it lands `abandoned` with a reason.
- A request is never assigned to two seats: requeue + racing claim leaves
  exactly one `assigned_to` winner.
- `reportSeatExited` on a seat with no requests resolves clean, touches nothing.
- Contract assert: `bootstrap.ts` `onDidChange` handler calls
  `server?.reportSeatExited` inside the `type === 'closed'` branch.

### Goal Invariants
- Assert a dead seat's `assigned` row transitions `assigned → queued` (negative:
  no path leaves an `assigned` row owned by a dead seat after the exit hook).
- Assert `_handleResearchComplete` triggers the pump (positive: drain exists),
  paired with: the HTTP response is written before the pump runs (negative:
  the response cannot be delayed or failed by the pump).

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
