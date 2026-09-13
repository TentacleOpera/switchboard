# A Finished Seat Is Told Its Own Card Blocks It, Then Re-Derives the Call It Was Given

## Goal

A seat that has finished its subtask reports once, closes out once, and stops. It is never sent
back to read the source to work out which call to make, and it is never told its own card is what
blocks it.

### What happened (Coding-intern, 2026-09-13, from its session log)

The seat got it right, then could not get confirmation that it had:

1. **Finished the subtask correctly.** Code changes in the working tree, summary appended to the
   plan file, report delivered to the head via `ptySendPrompt`. Nothing wrong to this point.
2. **Ran `done --from Coding-intern`.** The response was **409**, carrying
   `"released": "9fe3046b-…"` — the seat's own card. So the call *did* something (the card was
   released, the team freed) and reported a conflict at the same time. The agent could not tell
   whether it had succeeded.
3. **Followed the 409's own remedy.** The body reads *"Completion is for FINISHED work — POST
   /kanban/task/complete with a non-empty outcome when the work is done"*, so it prepared exactly
   that: `/tmp/devin-so-complete.json`, 3389 bytes, `outcome: "finished"`.
4. **Then went reading the source instead of sending it** — `LocalApiServer.ts:4568-4657`,
   `:3690-3759`, and a grep of `./src/standalone` for `done|--from|task/complete|queue/done`. It
   was working out the correct call signature from the implementation, because the instructions
   it held had already been contradicted once.
5. **Repeated that.** Its own account: *"I should have stopped and asked rather than barrel into a
   third call… the right move was to surface that to you instead of improvising a
   /kanban/task/complete POST you did not explicitly authorize."*

It ended halted with the card **released but not completed**, waiting for a human.

### Root cause (traced in source this pass)

The 409 is not invented by the `done` handler — it is forwarded from the pop. The chain is:

1. `done --from <seat>` → `POST /kanban/queue/done` → `_runQueueDone`
   (`src/services/LocalApiServer.ts:6434`). It finds the held card, then calls
   `db.clearWorkingState` (`:6491`).
2. `clearWorkingState` (`src/services/KanbanDatabase.ts:13905`) nulls `dispatched_at`,
   `last_liveness_at`, `blocked_at` — but **NOT `dispatched_terminal`**, and it does **not** write
   `completed_at` (that is `task/complete`'s job).
3. `_runQueueDone` then pops the next card via `_runQueuePop` (`:6919`). The pop's in-flight
   refusal (`:3737-3748`) runs `resolveTeamInFlight` → `heldByTeam` (`:120`):
   `!completedAt && dispatchedTerminal non-empty && teamSet.has(dispatchedTerminal)`. The
   just-finished card still has `dispatched_terminal` set and `completed_at` NULL, so it is **still
   in flight** — the seat's own card is what blocks the pop. The pop returns 409.
4. `_runQueueDone` spreads `pop.payload` and forwards `pop.status` (`:6950-6966`): a response that
   both carries `released: <planId>` and answers 409.
5. The CLI `cmdDone` (`src/standalone/cli.ts:2037`) maps 409 → `dispatchExitCode(409) === 3`
   (`:712-716`), prints `data.error` (the 409 body naming `task/complete with a non-empty
   outcome`) to stderr, and exits non-zero. The agent reads non-zero exit + that error body and
   concludes its `done` failed.

So the seat's own just-finished card is the thing the pop names as blocking the team, and the
`done` call reports that refusal as its own status — even though `done` already did its job
(cleared the working-state latch, relayed to the lead).

### The three defects

**1. `done` returns 409 while also releasing the card.** The response carried `released: <planId>`
and a conflict status together. A caller cannot act on that: it has neither a success it can
record nor a clean failure it can retry. The agent's next three actions all follow from not
knowing which happened.

**2. The 409 body is a SIXTH place that instructs agents to supply an `outcome`.**
`LocalApiServer.ts:3740`:

> *"Team already in flight: card '<id>' is in '<column>' held by '<terminal>' with no completion
> post. Completion is for FINISHED work — POST /kanban/task/complete with a non-empty outcome when
> the work is done."*

Five instruction sites were corrected when the `outcome` gate was removed. This one was missed
because it is **prose in an error body**, not a payload template — and the contract test written
at the time matches on the literal `task/complete with {"from"` shape, so it cannot see it. The
error text is now actively teaching agents a payload the endpoint no longer wants.

**3. An agent reading the source to discover a call signature is an unhandled failure.** Step 4 is
the tell. The seat had an instruction, was refused, was handed a different instruction by the
error, and resolved the disagreement by reading `LocalApiServer.ts`. That is expensive, it burns
the context the seat needs for its actual work (this one ended at 139k/200k), and it only happens
when the contract an agent was given is not trustworthy.

### Non-goals

- **Making the agent retry harder.** It stopped and asked, which was right. The fix is to make the
  first call answerable, not to add retries.
- **Reinstating an `outcome` requirement.** No agent writes a summary to close work out. This plan
  removes the last place that asks for one.
- **A new completion endpoint.** `done`, `task/complete` and `card/release` are the right three
  doors; the problem is what they say when refusing.

## Metadata

- **Complexity:** 4
- **Tags:** api, bugfix, reliability

## User Review Required

None.

## Complexity Audit

### Routine

- Editing one error-body string at `src/services/LocalApiServer.ts:3740` to drop the `outcome`
  instruction (defect #2).
- Decoupling the `done` response status from the pop's status in `_runQueueDone`
  (`src/services/LocalApiServer.ts:6950-6966`) — a single resolved-status override plus a
  `success`/payload reconciliation (defect #1).
- Extending `src/test/task-complete-instruction-contract.test.js` with an error-body scan (defect
  #3).

### Complex / Risky

- The `done` response shape is read by the CLI (`src/standalone/cli.ts:2037-2054`, keyed on
  `dispatchExitCode` + `data.dispatched`/`data.reason`) and by every standing order that tells a
  seat to call `done`. Changing the status from 409→200 flips the CLI exit code 3→0, which is the
  point of the fix but is a contract change every consumer of the `done` response implicitly
  relies on. The payload must keep `dispatched` and `reason` so the CLI's "Next card popped" /
  "Queue empty" branches still render.
- The contract-test extension (#3) must scope to agent-facing instruction text only. The
  endpoint's own JSDoc (`src/services/LocalApiServer.ts:4575-4579`) legitimately documents that
  `outcome` is *accepted and stored* — a naive "no source string mentions `outcome`" assertion
  would false-positive on that doc and break the suite.

## Edge-Case & Dependency Audit

- **Race Conditions.** `_runQueueDone` runs on `_queueNextChain` (single serialization point), so
  the `clearWorkingState` → pop sequence is atomic w.r.t. other pops. The fix does not introduce a
  new race: the resolved status is decided after the pop completes, inside the same chain block.
  The `_lastSeatPop` cache (`:6925`) reads `pop.payload.dispatched`, which is preserved in the new
  payload, so retried `done` calls still get `reason: "duplicate"` with the prior pop.
- **Security.** No new surface. The 409 body already interpolates `inFlightCheck.planId` etc.; the
  fix only removes prose, it does not add new interpolation.
- **Side Effects.** The queue-watch arming at `:6942` keys on `pop.status` (the *internal* pop
  result), NOT the resolved HTTP status. Overriding the resolved status to 200 does NOT change
  watch arming — the implementer must not "fix" the watch logic to read the new status. (Audit
  item: verify `pop.status` vs resolved status are not conflated.)
- **Dependencies & Conflicts.** `done` (queue/done) and `task/complete` are the two completion
  doors. `done` clears the working-state latch and relays; `task/complete` writes `completed_at`
  and releases the team. The fix does not merge them: a team seat's `done` still does NOT write
  `completed_at`, so the team stays in flight until the lead posts `task/complete`. That is
  correct — the seat's turn is done; the team's acceptance is a separate fact. The fix only stops
  *reporting* the team-in-flight refusal as the `done` call's own failure.

## Dependencies

- `add-a-task-complete-endpoint-for-the-lead` — the lead's `POST /kanban/task/complete` endpoint;
  this plan fixes the 409 body that misinstructs agents about its payload.
- `task-complete-instruction-contract` (CI suite `test:contract:task-complete-instruction`) — the
  contract gate this plan extends to read error bodies.
- `a-dispatch-has-a-timeout-and-a-failure-can-be-retried` — established that `releaseDispatchHolder`
  (not `clearWorkingState`) is what nulls `dispatched_terminal` and takes a card out of the
  `heldByTeam` in-flight predicate; this plan relies on that distinction to explain why the seat's
  own card stays "in flight" after `done`.

## Adversarial Synthesis

Key risks: (1) the `done` payload-shape change must preserve `dispatched`/`reason` or the CLI's
render branches break silently; (2) the contract-test extension must not match the endpoint's own
JSDoc documenting `outcome` as accepted; (3) the queue-watch arming reads the internal `pop.status`,
not the resolved status — an implementer "tidying" that to the new 200 would stop arming the watch
on a team-in-flight pop. Mitigations: keep `dispatched`/`reason` at top level; scope the test regex
to instruction-shaped strings (`task/complete with ...` / `POST /kanban/task/complete`), not bare
`outcome`; leave the watch-arming predicate on `pop.status` untouched and note it in the diff.

## Proposed Changes

### `src/services/LocalApiServer.ts` — `_runQueueDone` resolved status (defect #1)

- **Context.** `_runQueueDone` (`:6434`) reaches the payload-assembly block at `:6950-6966` only
  after `clearWorkingState` transitioned (`:6491`, gated at `:6495`). Every early return before
  that point already answers 200-duplicate (`:6473`, `:6495`) or 400-mismatch (`:6481`). So by the
  time the pop runs, the `done` call has *succeeded* — the working-state latch is cleared and the
  relay has fired. The pop's 409 (team still in flight, because `completed_at` is still NULL) is a
  fact about the *next* dispatch, not about the *done* call.
- **Logic.** At `:6966`, stop forwarding `pop.status` as the `done` response status. The `done`
  call succeeded; resolve with `status: 200`. Reconcile the payload so it does not contradict
  itself: override `success: true`, keep `released: held.planId`, `cleared`, `outcome`,
  `escalated` at top level, and keep `dispatched`/`reason` from `pop.payload` so the CLI's
  "Next card popped" / "Queue empty" branches (`cli.ts:2043-2049`) still render. Nest the pop's
  refusal (its `error`/`inFlight`) under a `next` key for diagnostics instead of leaving
  `success: false` + `error` at top level (which is the "released AND refused" contradiction).
  **Clarification (strictly implied by #1):** the payload shape is
  `{ success: true, released, cleared, outcome, escalated, dispatched: pop.payload?.dispatched ?? null, reason: <'dispatched' | pop.reason | 'team in flight'>, ...(popFailed ? { next: { status: pop.status, error, inFlight } } : {}) }`,
  resolved as `{ status: 200, payload }`.
- **Edge cases.** A `failed`-outcome `done` that re-stages the card (`escalated: 'restaged'`)
  still pops and may dispatch the re-staged card; `dispatched`/`reason` reflect that pop normally.
  A `parked` outcome pops the next card; same. The status override applies uniformly because all
  three outcomes reached this point only after the working-state latch cleared.

### `src/services/LocalApiServer.ts` — strip the outcome instruction from the 409 body (defect #2)

- **Context.** The in-flight 409 string at `:3740` is reached by `_runQueuePop` on the
  `queue/next` path (a lead asking for the next card while a team member's card is still
  uncompleted). After defect #1, a *seat* no longer receives this 409 via `done` (it gets 200),
  so this body is now addressed to the **lead**, for whom the two doors (`task/complete` to
  finish, `card/release` to free without claiming) are a genuine choice.
- **Logic.** Drop the clause `with a non-empty outcome when the work is done` from `:3740`. Name
  the two doors and what each means: `task/complete` for finished work, `card/release` to free the
  team without claiming the work is done. Nothing about writing a summary or supplying an
  `outcome` field.

> **Superseded:** Defect #4 as originally written — "Every refusal an agent can receive on the
> completion path states exactly one thing to do next. The 409 today names two doors and a field
> requirement, which is what let a seat pick the wrong one and then go reading source to break the
> tie. Where a genuine choice exists, the error says to report it to the head rather than choose."
> **Reason:** The premise was that a *seat* receives this 409 and picks the wrong door. After
> defect #1, a seat's `done` returns 200 and never sees this body, so the "seat picks the wrong
> door" failure mode is already closed. The 409 is now received only by the *lead* on
> `queue/next`, and for the lead the two doors ARE a genuine choice (finish vs. free) — collapsing
> them to "report it to the head" is contradictory when the lead IS the head.
> **Replaced with:** A narrower guardrail — no refusal body *addressed to a seat* (the `done` /
> `queue/done` path) names more than one next action or an `outcome` field. The in-flight 409
> body keeps its two doors for the lead; the only edit it needs is defect #2 (drop the `outcome`
> instruction). The other seat-facing refusals on the completion path (the planId-mismatch 400 at
> `:6481`, the feature 400 at `:4655`) already name exactly one next action, so the guardrail is
> met without further edits.

### `src/services/LocalApiServer.ts` — the in-flight 409 body keeps two doors for the lead

- **Context.** See the Superseded callout above. After #1, this body is lead-facing.
- **Logic.** No change to the door count; only the `outcome` clause is removed (defect #2). Do
  not collapse to one door — the lead's choice between finishing and freeing is real.

### `src/test/task-complete-instruction-contract.test.js` — read error bodies, not just payload templates (defect #3)

- **Context.** The existing `check('no instruction asks an agent to supply an outcome', ...)` at
  `:57-76` scans the joined source of `SOURCES` for the literal `task/complete with {"from"` shape
  and then looks for `outcome` in a 400-char window. The 409 body says
  `task/complete with a non-empty outcome` — it does NOT match `task/complete with {"from"`, so the
  regex never sees it. That is why a prose instruction in an error string survived the gate.
- **Logic.** Add a check that scans the same `SOURCES` for instruction-shaped strings that mention
  `task/complete` (any form: `task/complete with ...`, `POST /kanban/task/complete ...`) and fails
  if any such string within a bounded window also instructs the caller to supply an `outcome`
  (e.g. `non-empty outcome`, `outcome:`, `"outcome"`). **Scope:** match instruction-shaped text
  (a `task/complete` call description), not bare occurrences of the word `outcome`. The endpoint's
  JSDoc at `LocalApiServer.ts:4575-4579` legitimately documents `outcome` as an *accepted, optional*
  field — a bare `outcome` match would false-positive there. The assertion is "no instruction
  *tells an agent to supply* an outcome", not "no source string contains the word outcome".
- **Load-bearing check.** Restore the 409's current wording (`with a non-empty outcome`) and
  confirm the new check fails; then re-apply the fix and confirm it passes. This is the assertion
  that would have caught the original miss.

### `src/test/task-complete-instruction-contract.test.js` — `done` never 409s a card it released (defect #1)

- **Context.** New case in the same suite. The contract is: when `done` released the seat's card,
  the response is a success (200), never a 409 carrying `released`.
- **Logic.** Assert, by reading `_runQueueDone`'s resolved-status path in
  `src/services/LocalApiServer.ts`, that the status forwarded at `:6966` is 200 (not `pop.status`)
  on the success branch, and that no resolved payload carries both `status: 409` and a `released`
  field. (This is a source-shape assertion in the same style as the suite's existing checks; a
  runtime blackbox is out of scope for this contract suite, which is a static source scan.)

## Verification Plan

### Automated Tests

1. Extend `src/test/task-complete-instruction-contract.test.js` (already wired as
   `test:contract:task-complete-instruction` in CI) with an assertion that no instruction-shaped
   source string — including error bodies — instructs an agent to supply an outcome. Verified
   load-bearing by restoring the 409's current wording and watching it fail.
2. **New** case in the same suite: `done` against a card it can release returns `200` with the
   released id, never `409` alongside `released`.
3. Assert every seat-facing refusal on the completion path names exactly one next action (the
   planId-mismatch 400 and the feature 400 already do; the in-flight 409 is no longer
   seat-facing after #1).

### Goal Invariants

- **Negative:** the substring `with a non-empty outcome` is absent from
  `src/services/LocalApiServer.ts`. **Paired positive:** the 409 body at
  `src/services/LocalApiServer.ts:3740` still names `task/complete` and `card/release` (the two
  doors are retained for the lead).
- **Negative:** `_runQueueDone` (`src/services/LocalApiServer.ts:6434`) never resolves a response
  carrying both `status: 409` and a `released` field. **Paired positive:** on the success branch
  (after `clearWorkingState` transitioned, `:6495`), `_runQueueDone` resolves `status: 200` with
  `payload.released` set to `held.planId`.
- `dispatchExitCode` in `src/standalone/cli.ts:712` returns `0` for the `done` response when the
  call released the seat's card (status 200), so the CLI prints "Done signal recorded" and exits
  zero — the seat stops.
- The `done` response payload preserves `dispatched` and `reason` (consumed by
  `src/standalone/cli.ts:2043-2049`) so the "Next card popped" / "Queue empty" render branches
  still fire on a 200.
- The queue-watch arming predicate at `src/services/LocalApiServer.ts:6942` continues to read the
  internal `pop.status`, not the resolved HTTP status, so a team-in-flight pop still arms the watch
  exactly as before.

## Review Findings

Both defects landed correctly in `src/services/LocalApiServer.ts`: the 409 in-flight body (`:3735`)
no longer instructs an `outcome`, and `_runQueueDone` resolves `status: 200` with the pop's refusal
nested under `next` instead of forwarding `pop.status` alongside `released`. Two fixes applied —
the refused-pop `reason` was a hardcoded `'team in flight'` for all three refusal kinds (in-flight,
dependency-blocked, dispatch-refused) and the pop's `dependencyBlocked` diagnostic was dropped on
the floor, so `reason` now discriminates and `next` carries both diagnostic objects; and the two
CI-wired `queue-pipeline-contract.test.js` cases that pinned the old 409 pass-through were red and
are now updated to the 200 + `next` contract. Files changed: `src/services/LocalApiServer.ts`,
`src/test/task-complete-instruction-contract.test.js`,
`src/test/queue-pipeline-contract.test.js`,
`src/test/atomic-team-feature-run-context-lifecycle.test.js` (a stale V77 assertion still demanded
the removed `outcome` gate — inverted to pin its removal), plus harness repairs to
`src/test/task-complete-endpoint.test.js` and `src/test/team-release-control-contract.test.js`.
Validation: `test:contract:task-complete-instruction` 6/6 with both new checks proven load-bearing
(restoring `with a non-empty outcome` and collapsing the reason discriminator each turn one red);
`queue-pipeline` 1 pre-existing failure remaining (unrelated `<cliPath>` token substitution);
`task-complete`, `atomic-team-lifecycle`, `queue-done-relay`, `queue-stall-watch`,
`cli-board-commands` all green; `compile-tests` and eslint clean (0 errors).

## Deferred Findings

- MAJOR — `src/standalone/cli.ts:2043` A `done` whose pop failed for a non-team-in-flight reason (502 delivery failure, dependency block) now exits 0 and prints only "Done signal recorded"; the `next` diagnostic is visible to `--json` callers only. Deliberately not surfaced in the plain CLI output: printing an error-shaped line to a seat is the confusion this plan removes, and `armQueueWatch` already arms on that branch as the backstop.
- NIT — `src/services/LocalApiServer.ts:6959` The pop's `from` field is no longer spread into the `done` payload (the new shape is explicit). No consumer reads it.
- NIT — `src/test/queue-pipeline-contract.test.js:458` Pre-existing red at HEAD, unrelated to this plan: `applyStandingOrders` leaves the `<cliPath>` token unsubstituted in the sandboxed test env, so "the rendered order must name a concrete cli.js path" fails.
