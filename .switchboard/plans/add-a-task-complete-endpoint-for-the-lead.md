# Add a task-complete endpoint the lead posts to

## Goal

Give a team lead an explicit endpoint to declare a feature or plan finished — `POST /kanban/task/complete` — so completion is an asserted signal rather than a file write the orchestrator may or may not read, or a board state inferred from column position.

### Problem Analysis

There is no way for a lead to say "this is done" that is not coupled to something else. The three paths that exist today:

1. **`POST /kanban/queue/done`** and **`POST /terminals/teams/<id>/queue/done`** — both *queue* signals. They mean "dispatch me the next item", and completion is a side effect. A lead finishing the last item in a queue, or working outside a queue entirely, has no call to make.
2. **A file in `.switchboard/orchestrator/reports/`** — what the head standing order instructs when the team has no reviewer seat (`teamWiring.ts:769`, `:819`): *"Post a finished report to `.switchboard/orchestrator/reports/` naming the feature and its planId, and stop. The card stays where it is."* Written by `ScheduledJobsService` (`:227`), read only by the orchestrator persona (`switchboard-orchestrator/SKILL.md:368`).
3. **Board position** — the seat standing order's clause (`teamWiring.ts:322-325`) tells any seat to infer completion from "all subtasks are in `LEAD CODED`" and move the feature to `CODE REVIEWED`.

**Each is wrong in a different way, and the file path is wrong in three:**

- **It is unconditional.** The order posts a report whether or not an orchestrator exists. A report nobody reads is a completion signal that goes nowhere.
- **It depends on a persona that is explicitly not the pipeline driver.** `switchboard-orchestrator/SKILL.md:245` states the queue watch "does **not** dispatch on the lead's behalf … The lead self-paces; the watch is a backstop against it forgetting, not a replacement for it", and `:39` forbids the orchestrator calling `POST /kanban/dispatch` at all. So the design deliberately makes the orchestrator a progress-tracker and stall-fixer — and then routes the lead's completion signal exclusively through it.
- **File signals are unreliable.** The report is a filesystem write with no acknowledgement, no delivery guarantee and no error if nothing consumes it. Compare the endpoints, which return a response the caller can act on.

**The consequence is a gap with no signal at all.** For a team with **no reviewer seat**, the head is correctly told not to move the card (moving it hands work to an off-team reviewer that then edits files the team is still working — the concurrency hazard the rule exists to prevent). So the card stays in a coding column. But the in-flight predicate is board-derived: `LocalApiServer.ts:1696-1700` — "a team is in flight when any active card belonging to that team is sitting in a coding column … The flag releases exactly when the head hands the feature to review." With no hand-off, nothing releases it, and the release depends on an orchestrator that may not be running.

### Root Cause

Completion was never modelled as its own event. Every mechanism that needed to know about it inferred it from something already at hand — the queue's need for a next item, the orchestrator's report inbox, the board's column layout. Three proxies, no signal.

## Metadata

**Complexity:** 4
**Tags:** backend, api, reliability

## User Review Required

- **The endpoint's effect on the card is the design decision.** Options: (a) record completion and release in-flight, leaving the card where it is; (b) additionally move the card when a reviewer seat exists. (a) is the narrower change and keeps the reviewer-seat rule where it already lives — in the head's order. Recommending (a).
- Confirm the endpoint should serve plans as well as features. A lead finishing a standalone plan has the same gap.

## Complexity Audit

### Routine

- A `POST /kanban/task/complete` route alongside the existing `/kanban/queue/done` (`LocalApiServer.ts:6062`), taking `{ from, planId, workspaceRoot?, outcome?, note? }`.
- Recording the completion — `plan_events` already exists for per-plan history.
- Returning a response the lead can act on, rather than a silent write.

### Complex / Risky

- **In-flight is derived from board position, so an endpoint alone does not release it.** The predicate scans for active cards in coding columns (`:1696-1700`). Completion must either mark the card so the scan skips it, or move it. Marking is the smaller change and keeps the reviewer-seat rule intact, but it means the scan gains a condition — and that scan is the one-in-one-out contract for ~4,000 installs. It is the highest-risk edit in this plan and needs its own test rather than being folded into the endpoint's.
- **It must not become a second dispatch verb.** The orchestrator is forbidden `/kanban/dispatch` (`SKILL.md:39`) precisely to keep dispatch in one place. An endpoint that completes *and* dispatches recreates that. Complete means complete.
- **Idempotency.** A lead may post twice, or post after a queue/done already advanced. Same discipline as the queue endpoints: a repeat call returns the existing state rather than double-recording or double-releasing.
- **Standing orders must be updated in the same change**, or the endpoint exists and nothing calls it. That is the coupling to `compose-standing-orders-from-a-library.md`: the order text naming this endpoint is that plan's output. Shipping the endpoint without the order text is a dead route; shipping the order text first points agents at a 404.
- **The report file cannot simply be dropped.** Where an orchestrator *is* running it is a working channel. The endpoint should be the signal and the report an additional courtesy when an orchestrator is present — which is the conditional the current order lacks.

## Edge-Case & Dependency Audit

**Migration.** Additive route; nothing removed. Existing queue/done callers are untouched. The order-text change that starts using it is gated behind the library plan, so no shipped agent behaviour changes on this plan alone.

**Security.** Same auth as the other `/kanban/*` routes (`_checkAuth`). `planId`, `from` and `workspaceRoot` are caller-supplied: validate `workspaceRoot` through the same resolver the other routes use and never interpolate `planId` into a path. No token in a response.

**Side effects.** Recording completion makes it queryable for the first time — useful for the Orders/progress surfaces, and worth exposing rather than keeping internal.

**Ordering.** Ship before the library plan, since the library's order text names the endpoint.

## Dependencies

- **Blocks** `compose-standing-orders-from-a-library.md` (the order text calls this route).
- **Related to** `remove-the-seat-orders-code-reviewed-clause.md` — that plan deletes the board-inference shortcut; this one supplies the signal that replaces it. Neither strictly requires the other, but shipping the deletion first leaves a team with no completion path at all, so ship this first.
- Independent of the orchestrator rename.

## Adversarial Synthesis

**"`queue/done` already exists — just use it."** It means "give me the next item". A lead finishing the last card, or working outside a queue, either lies about wanting more work or has nothing to call. Overloading it is why completion is currently inferred in three places.

**"The report file works when an orchestrator runs."** It does, and it stays as a courtesy. But a completion channel that requires a separate persona to be running is not a completion channel; it is a notification.

**"Add it to the existing queue/done handler with a flag."** That keeps completion coupled to queue advancement — the same conflation, with a parameter. The handler already does release → clear → pop as one chain (`:1715-1718`); adding a "but don't pop" branch to a critical section maintained for ~4,000 installs is riskier than a new route.

## Proposed Changes

1. **`POST /kanban/task/complete`** taking `{ from, planId, workspaceRoot?, outcome?, note? }`, returning the recorded state.
2. **Record to `plan_events`**, so completion is queryable rather than only actioned.
3. **Release in-flight** by marking the card completed-by-team, with the board scan honouring that mark. Its own test.
4. **No dispatch, no column move** in v1 — per the recommended option (a).
5. **Idempotent**: a repeat call returns existing state.
6. **Leave `queue/done` untouched.**
7. **Leave the report file in place** as an additional channel; the *conditional* on posting it belongs to the library plan.

### Migration

Additive. No shipped agent behaviour changes until the order text changes.

## Verification Plan

### Goal Invariants

- A lead can declare a feature or plan complete with one call and get a response.
- Completion releases in-flight for a team with no reviewer seat.
- The endpoint never dispatches and never moves a card.
- Calling twice changes nothing the second time.

### Automated Tests

- **No-reviewer-seat release:** a team with no reviewer seat completes a feature; assert in-flight releases and the next `queue/next` is not refused. This is the gap that motivated the plan — without this assertion the endpoint could ship and change nothing.
- **The board scan honours the mark:** directly test the in-flight predicate with a completed-by-team card in a coding column. The riskiest edit gets its own test rather than being implied by the one above.
- **No dispatch side effect:** assert no terminal receives a prompt and no card changes column as a result of the call.
- **Idempotent:** two identical calls; assert one recording and one release.
- **`queue/done` unchanged:** its existing tests pass untouched, confirming the critical section was not altered.
- **Auth and validation:** unauthenticated call refused; a `workspaceRoot` outside the registered roots refused; a `planId` containing path separators refused.

## Outstanding Questions

- **[user]** Option (a) record-and-release, or (b) also move the card when a reviewer seat exists?
- **[user]** Plans as well as features?
- Should completion also clear the finishing terminal, as `queue/done` does? Leaning no — clearing is a queue-rotation concern, and conflating them is how this got tangled — but a lead that completes and keeps its context may then act on stale state.
