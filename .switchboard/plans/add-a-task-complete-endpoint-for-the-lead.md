# Add a task-complete endpoint the lead posts to

## Goal

Give a team lead an explicit endpoint to declare a feature or plan finished — `POST /kanban/task/complete` — so completion is an asserted signal rather than a file write the orchestrator may or may not read, or a board state inferred from column position.

### Problem Analysis

There is no way for a lead to say "this is done" that is not coupled to something else. The three paths that exist today:

1. **`POST /kanban/queue/done`** and **`POST /terminals/teams/<id>/queue/done`** — both *queue* signals. They mean "dispatch me the next item", and completion is a side effect. A lead finishing the last item in a queue, or working outside a queue entirely, has no call to make.
2. **A file in `.switchboard/mission-control/reports/`** — what the head standing order instructs when the team has no reviewer seat (`teamWiring.ts:798`, `:851`): *"Post a finished report to `.switchboard/mission-control/reports/` naming the feature and its planId, and stop. The card stays where it is."* Written by `ScheduledJobsService` (`:299`), read only by the Mission Control persona. (The persona was renamed from "orchestrator" to "Mission Control" — see `rename-the-orchestrator-to-mission-control.md`. The former `switchboard-orchestrator/SKILL.md` no longer exists; behavior contracts now live in `.agents/protocols/switchboard-contracts/SKILL.md`, which confirms at contract #2 that the completion-driven dispatch arm was deleted and the queue watch is "no longer load-bearing for board progression.")
3. **Board position** — the seat standing order's clause (`teamWiring.ts:338-354`) tells any seat to infer completion from "all subtasks are in `LEAD CODED`" and move the feature to `CODE REVIEWED`.

**Each is wrong in a different way, and the file path is wrong in three:**

- **It is unconditional.** The order posts a report whether or not a Mission Control exists. A report nobody reads is a completion signal that goes nowhere.
- **It depends on a persona that is explicitly not the pipeline driver.** The behavior contracts (`.agents/protocols/switchboard-contracts/SKILL.md` contract #2) confirm the completion-driven dispatch arm was deleted — the queue watch is "no longer load-bearing for board progression" and "the next card is pulled by the lead, the `Run queue` button, or the schedule calling the queue pop." The Mission Control persona (formerly "orchestrator") is a progress-tracker and stall-fixer, not a dispatch agent — and the lead's completion signal is routed exclusively through it.
- **File signals are unreliable.** The report is a filesystem write with no acknowledgement, no delivery guarantee and no error if nothing consumes it. Compare the endpoints, which return a response the caller can act on.

**The consequence is a gap with no signal at all.** For a team with **no reviewer seat**, the head is correctly told not to move the card (moving it hands work to an off-team reviewer that then edits files the team is still working — the concurrency hazard the rule exists to prevent). So the card stays in a coding column. But the in-flight predicate is board-derived: `LocalApiServer.ts:1717-1720` — "a team is in flight when any active card belonging to that team is sitting in a coding column … The flag releases exactly when the head hands the feature to review." With no hand-off, nothing releases it, and the release depends on a Mission Control that may not be running.

### Root Cause

Completion was never modelled as its own event. Every mechanism that needed to know about it inferred it from something already at hand — the queue's need for a next item, the Mission Control's report inbox, the board's column layout. Three proxies, no signal.

## Metadata

**Complexity:** 4
**Tags:** backend, api, reliability

## User Review Required

- **The endpoint's effect on the card is the design decision.** Options: (a) record completion and release in-flight, leaving the card where it is; (b) additionally move the card when a reviewer seat exists. (a) is the narrower change and keeps the reviewer-seat rule where it already lives — in the head's order. Recommending (a).
- Confirm the endpoint should serve plans as well as features. A lead finishing a standalone plan has the same gap.

## Complexity Audit

### Routine

- A `POST /kanban/task/complete` route alongside the existing `/kanban/queue/done` (`LocalApiServer.ts:6315`), taking `{ from, planId, workspaceRoot?, outcome?, note? }`.
- Recording the completion — `plan_events` already exists for per-plan history.
- Returning a response the lead can act on, rather than a silent write.

### Complex / Risky

- **In-flight is derived from board position, so an endpoint alone does not release it.** The predicate scans for active cards in coding columns (`LocalApiServer.ts:1868-1882` — the `CODING_COLUMNS.has()` check). Completion must either mark the card so the scan skips it, or move it. **The mark is a `completed_at` timestamp column on the plans table** (additive — absent reads as NULL, meaning "not completed"). The scan adds `&& !p.completedAt` to its `find` predicate. This is the smaller change and keeps the reviewer-seat rule intact, but it means the scan gains a condition — and that scan is the one-in-one-out contract for ~4,000 installs. It is the highest-risk edit in this plan and needs its own test rather than being folded into the endpoint's.
- **It must not become a second dispatch verb.** The Mission Control persona (formerly "orchestrator") is not a dispatch agent — the behavior contracts (`.agents/protocols/switchboard-contracts/SKILL.md` contract #2) confirm the completion-driven dispatch arm was deleted. An endpoint that completes *and* dispatches recreates the dispatch-from-completion pattern that was deliberately removed. Complete means complete.
- **Idempotency.** A lead may post twice, or post after a queue/done already advanced. Key on `planId` — one completion per plan. A repeat call (same `planId`) returns the existing `plan_events` completion record and does not re-write `completed_at` or re-release in-flight. The queue endpoints use a per-seat `_lastSeatPop` record for duplicate detection; this endpoint's duplicate check is simpler — a `SELECT completed_at FROM plans WHERE plan_id = ?` before writing.
- **Standing orders must be updated in the same change**, or the endpoint exists and nothing calls it. That is the coupling to `compose-standing-orders-from-a-library.md`: the order text naming this endpoint is that plan's output. Shipping the endpoint without the order text is a dead route; shipping the order text first points agents at a 404.
- **The report file instruction is retired by the anchor plan, not this one.** The anchor plan (`completion-is-asserted-never-inferred.md` Proposed Change #7) retires the report-file instruction in the head order. This plan must not contradict that — it supplies the replacement signal, and the anchor removes the old one. The two land together.

## Edge-Case & Dependency Audit

**Migration.** Additive route; nothing removed. Existing queue/done callers are untouched. The order-text change that starts using it is gated behind the library plan, so no shipped agent behaviour changes on this plan alone.

**Security.** Same auth as the other `/kanban/*` routes (`_checkAuth`). `planId`, `from` and `workspaceRoot` are caller-supplied: validate `workspaceRoot` through the same resolver the other routes use and never interpolate `planId` into a path. No token in a response.

**Side effects.** Recording completion makes it queryable for the first time — useful for the Orders/progress surfaces, and worth exposing rather than keeping internal.

**Ordering.** Ship before the library plan, since the library's order text names the endpoint.

## Dependencies

- **Blocks** `compose-standing-orders-from-a-library.md` (the order text calls this route).
- **Related to** `remove-the-seat-orders-code-reviewed-clause.md` — that plan deletes the board-inference shortcut; this one supplies the signal that replaces it. Neither strictly requires the other, but shipping the deletion first leaves a team with no completion path at all, so ship this first.
- Independent of the Mission Control rename (the persona was already renamed; this plan does not touch it).

## Adversarial Synthesis

**Risk Summary:** Key risks: (1) the `completed_at` mark adds a condition to the in-flight scan serving ~4,000 installs — mitigated by its own dedicated test and additive-only schema change; (2) the endpoint is a dead route without the order-text change from `compose-standing-orders-from-a-library.md` — mitigated by the ordering constraint (ship endpoint first, order text second); (3) idempotency must be concrete, not aspirational — mitigated by keying on `planId` with a pre-write `completed_at` check.

**"`queue/done` already exists — just use it."** It means "give me the next item". A lead finishing the last card, or working outside a queue, either lies about wanting more work or has nothing to call. Overloading it is why completion is currently inferred in three places.

**"The report file works when a Mission Control runs."** It does — but the anchor plan retires the instruction, not this plan. A completion channel that requires a separate persona to be running is not a completion channel; it is a notification. The endpoint replaces it; the anchor removes the old instruction.

**"Add it to the existing queue/done handler with a flag."** That keeps completion coupled to queue advancement — the same conflation, with a parameter. The handler already does release → clear → pop as one chain (`LocalApiServer.ts:2101-2107`); adding a "but don't pop" branch to a critical section maintained for ~4,000 installs is riskier than a new route.

## Proposed Changes

1. **`POST /kanban/task/complete`** taking `{ from, planId, workspaceRoot?, outcome?, note? }`, returning the recorded state.
2. **Record to `plan_events`** via `appendPlanEventByPlanId` (the current method — `plan_events` was migrated in V20 to key by `plan_id`), so completion is queryable rather than only actioned.
3. **Release in-flight** by writing a `completed_at` timestamp on the plans table row (`UPDATE plans SET completed_at = ? WHERE plan_id = ?`). The in-flight scan at `LocalApiServer.ts:1868-1882` adds `&& !p.completedAt` to its `find` predicate, so a completed card in a coding column no longer pins the team. Additive column — absent reads as NULL ("not completed"). Its own test.
4. **No dispatch, no column move** in v1 — per the recommended option (a).
5. **Idempotent**: key on `planId` — check `completed_at` before writing; a repeat call returns the existing `plan_events` completion record without re-writing.
6. **Leave `queue/done` untouched.**
7. **The report-file instruction is retired by the anchor plan** (`completion-is-asserted-never-inferred.md` Proposed Change #7). This plan supplies the replacement signal; the anchor removes the old instruction. The two land together — this plan does not touch the head order text.

### Migration

Additive. The `completed_at` column is additive (NULL = not completed); no existing data changes shape. No shipped agent behaviour changes until the order text changes.

## Verification Plan

### Goal Invariants

- A lead can declare a feature or plan complete with one call and get a response.
- Completion releases in-flight for a team with no reviewer seat.
- The endpoint never dispatches and never moves a card.
- Calling twice changes nothing the second time.

### Automated Tests

- **No-reviewer-seat release:** a team with no reviewer seat completes a feature; assert in-flight releases and the next `queue/next` is not refused. This is the gap that motivated the plan — without this assertion the endpoint could ship and change nothing.
- **The board scan honours the mark:** directly test the in-flight predicate with a `completed_at`-set card in a coding column. The riskiest edit gets its own test rather than being implied by the one above.
- **No dispatch side effect:** assert no terminal receives a prompt and no card changes column as a result of the call.
- **Idempotent:** two identical calls; assert one recording and one release.
- **`queue/done` unchanged:** its existing tests pass untouched, confirming the critical section was not altered.
- **Auth and validation:** unauthenticated call refused; a `workspaceRoot` outside the registered roots refused; a `planId` containing path separators refused.

## Outstanding Questions

- **[user]** Option (a) record-and-release, or (b) also move the card when a reviewer seat exists?
- **[user]** Plans as well as features?
- Should completion also clear the finishing terminal, as `queue/done` does? Leaning no — clearing is a queue-rotation concern, and conflating them is how this got tangled — but a lead that completes and keeps its context may then act on stale state.

**Routing: Complexity 4 → Send to Coder.**

## Review Findings

Second independent reviewer pass. The endpoint is sound: `setCompletedAt` has exactly one production caller (`completeCardInternal`, `LocalApiServer.ts:2700`), the V62 column is additive and present in `SCHEMA_TABLES_SQL` so fresh DBs get it at creation, idempotency short-circuits before both the write and the `plan_events` append, and the in-flight predicate is now a single shared `heldByTeam`/`resolveTeamInFlight` pair rather than a copied condition. No dispatch and no column move remain true — the one `onTeamReleased` hook fires the scheduler on its own tick, never inline. Every option seam this plan added (`terminalVerb`, `clearTerminalContext`, `onTerminalContextCleared`, `getKanbanDatabase`, `onTeamReleased`) is wired in the extension root (`TaskViewerProvider.ts:3751`) *and* `standalone/bootstrap.ts:3368`, so the composition-root divergence CLAUDE.md warns about does not apply here. Files changed by this pass: `src/test/completion-asserted-never-inferred.test.js` only — the plan's named "`queue/done` is not completion" test had never been written, and is now a mutation-tested single-writer pin. Validation: `compile-tests` exit 0; `task-complete` 14/14, `team-release-control`, `atomic-team-lifecycle` and `queue-pipeline` all green.

## Deferred Findings

- MAJOR — `workspaceRoot` is not validated against a registered-root set; `_getKanbanDb` opens or creates a kanban DB at any absolute path an authenticated caller supplies, so the "invalid `workspaceRoot` refused" criterion is unmet. No such registry exists for any `/kanban/*` route, so this route cannot be hardened alone without diverging from the rest. `src/services/LocalApiServer.ts:2805`
- NIT — Idempotency is read-then-write and not serialized: two concurrent identical posts both pass the `existing.completedAt` check and each append a `completed` row to `plan_events`. `src/services/LocalApiServer.ts:2662`
- NIT — A `clearTerminalContext` failure is unrecoverable: `completed_at` is already written, so the retry returns `idempotent: true` and the accepted coder seat keeps stale context permanently. `src/services/LocalApiServer.ts:2716`
- NIT — `setCompletedAt` bumps `updated_at`, silently reordering the `updated_at DESC` board with no refresh broadcast. `src/services/KanbanDatabase.ts:3062`
- NIT — The idempotent early-return omits `dispatchedTerminal` and `acceptedCodingSeat`, so a repeat call's response shape differs from the first call's. `src/services/LocalApiServer.ts:2662`
- NIT — A `plan_events` completion row is lost permanently if `appendPlanEventByPlanId` throws after `completed_at` is written. `src/services/LocalApiServer.ts:2707`
