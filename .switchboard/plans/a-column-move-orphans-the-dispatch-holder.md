# A column move orphans the dispatch holder, and the seat can never release it

<!-- board-collapse-04 -->
> **RESCOPED 2026-09-04 (Board Collapse 04, decision 8).** This plan keeps its **server-side fix** and loses its prompt edits.
> > 
> > **Keep:** `_runQueueDone` releases on `dispatched_terminal === from` alone. Today it also requires `dispatchedAt`, which a column move nulls while leaving `dispatched_terminal` set, so a seat can never let the card go — 571 stranded rows measured. This is the whole defect and it repairs live state, so it lands **early** in the seat-release feature.
> > 
> > **Delete** the edits adding `"planId"` to the four completion directives in `agentPromptBuilder.ts` and to the standing-order fragment. The sibling *Completion Directive Becomes a Standing Order* owns that text and now carries the planId instruction itself; the plan id already reaches the seat as a header line in its dispatch prompt, so nothing needs to be added to a per-terminal standing order to make it available. Two plans must not edit those four copies.


## Goal

Make `POST /kanban/queue/done` able to release the card its seat actually holds, regardless of
which column that card has since moved to. Today the first column advance after dispatch nulls
`dispatched_at` while leaving `dispatched_terminal` stamped, which puts the card permanently
outside the release path's `WHERE` clause and permanently inside the in-flight predicate. The
seat's completion post becomes a no-op, and the team is blocked forever by a card nobody is
working on.

Secondary, and only meaningful once the above lands: the completion directives must carry the
`planId`, so a seat holding more than one orphaned row releases the right card instead of an
arbitrary one.

### Problem Analysis

**Symptom.** A reviewer finishes a card, POSTs `/kanban/queue/done` exactly as its dispatch
prompt instructs, and receives a 409 naming a *different* card as in flight:

```
Team already in flight: card 'cb9b253a-…' is in 'CODE REVIEWED' held by 'reviewer-1'
with no completion post. Post /kanban/task/complete before asking for the next card.
```

The named card is one the same seat reviewed days earlier. It never released. Neither did the
one before it.

**Measured scale** (`.switchboard/kanban.db`, 2026-08-31):

```
plans rows                                           2949
holder set, no completion (blocks its team)           571
  ├─ dispatched_at NULL  → invisible to queue/done    569
  └─ dispatched_at set   → releasable by queue/done      2
by column:  CODE REVIEWED 354 · PLAN REVIEWED 213 · CODER CODED 3
by seat:    24 distinct seats; reviewer-1 alone holds 142
```

Every stuck card sits in a **post-dispatch** column. That is the tell.

**Root cause — two `WHERE` clauses that disagree about what "held" means.**

The in-flight predicate, `heldByTeam` (`LocalApiServer.ts:76`), reads two fields:

```ts
!p.completedAt && typeof p.dispatchedTerminal === 'string' && p.dispatchedTerminal.length > 0
```

The release path inside `_runQueueDone` (`LocalApiServer.ts:3256`) reads a *third*:

```ts
board.find(p => p.dispatchedTerminal === from && !!p.dispatchedAt)
```

`dispatched_at` is in one and not the other. And `dispatched_at` is nulled — with
`dispatched_terminal` deliberately left in place — by every column move:

| Writer | Line | Nulls `dispatched_at` | Nulls `dispatched_terminal` |
| :--- | :--- | :--- | :--- |
| `updateColumnByPlanFileWithReason` | `KanbanDatabase.ts:2664` | yes | **no** |
| `cascadeFeatureByPlanId` | `KanbanDatabase.ts:6810, 6818` | yes | **no** |
| `clearWorkingState` | `KanbanDatabase.ts:10288` | yes | **no** |
| `clearStaleWorkingState` | `KanbanDatabase.ts:10765, 10777` | yes | **no** |
| `releaseDispatchHolder` | `KanbanDatabase.ts:10311` | yes | yes |

Cards advance columns when work *starts*, not when it finishes, so the very first advance after
a dispatch orphans the holder: the stamp that makes the card count as in flight survives, and
the timestamp that makes it findable by its own seat does not. From that moment the only field
that can clear it is `completed_at`, and the only writer of `completed_at` is
`POST /kanban/task/complete`.

**Confirmed on a specific card**, not inferred. `6f6a7cad-…` ("Mapped Workspaces Open
Independently"), `dispatched_terminal = reviewer-1`, `dispatched_at` empty, `completed_at`
empty, sitting in `CODE REVIEWED`. Its `plan_events` trail:

```
2026-08-28T00:08  move-to-coder-coded
2026-08-29T21:49  reset-to-plan-reviewed
2026-08-29T21:50  move-to-coder-coded
2026-08-29T22:34  move-to-code-reviewed     ← dispatched_at nulled here, holder kept
```

**Context (not this plan's work): the prompts name an endpoint that cannot write the release fact.**
Every completion directive in `agentPromptBuilder.ts` tells the agent the same thing —
`CODING_COMPLETION_REPORT_DIRECTIVE` (`:1087`), `COMPLETION_STEP_FULL` (`:1154`),
`COMPLETION_STEP_COMPACT` (`:1156`), and by reference `STAGGERED_IMPLEMENTATION_DIRECTIVE`
(`:1075`) and the standing-order fragment (`standingOrderFragments.ts:57`):

> `POST /kanban/queue/done with {"from":"<your terminal name>"} … This signals task completion
> to the kanban board`

`LocalApiServer.ts:2619` says the opposite, and it is the authority:

> `queue/done` is untouched — it means "give me the next item", not "done".

This is drift, not a design disagreement. `update-completion-directives-to-reference-api-post.md`
pointed the directives at `queue/done` when mtime-based completion was retired;
`completion-is-asserted-never-inferred.md` later made `completed_at` the release fact. The
directives were never revisited. **This is secondary** — repointing the prompts alone fixes
nothing, because a seat that posts perfectly still cannot reach a card whose column has moved.

**Why this is not the deleted release valve.** `LocalApiServer.ts:2040-2056` deliberately
removed one release signal: *a card leaving a coding column releases the team*. That valve let a
lead pull its next subtask while a reviewer was still editing the same worktree. Nothing here
restores it. Column position stays out of the in-flight predicate; the seat's own explicit post
remains the only thing that releases a hold, exactly as designed. What changes is that the post
can find its card.

### Root Cause

`dispatched_at` serves two unrelated jobs: it is the activity-light source ("an agent is working
on this now"), and it is the join key the release path uses to find a seat's card. Column moves
legitimately clear the first meaning and unintentionally destroy the second. The in-flight
predicate never depended on it, so nothing broke visibly — the card simply stopped being
releasable while continuing to block.

## Metadata

**Complexity:** 5
**Tags:** backend, bugfix, kanban, queue, prompts

## User Review Required

None. The two decisions this plan could have deferred are made below.

**Decided — release keys on the seat, not on the timestamp.** `_runQueueDone` matches on
`dispatched_terminal === from` and stops requiring `dispatched_at`. The alternatives were
rejected: keeping `dispatched_at` set through column moves breaks the activity light (a moved
card would read as actively worked); nulling `dispatched_terminal` on column move is the deleted
column-release valve under a new name and is explicitly out of bounds.

**Decided — no migration.** The asserted-completion mechanism (`completed_at`,
`/kanban/task/complete`, the team in-flight refusal) has never shipped in a released version, so
this takes a clean break: no compat shim, no migration code, no backfill. The 571 orphaned rows
on existing dev boards are not touched by this plan; they are cleared by the operator control in
`the-team-panel-releases-what-the-lead-did-not-post.md`, or one at a time by a `task/complete`
post. Ship order between the two plans does not matter.

## Approach

1. **Make the release path column-independent.** In `_runQueueDone`, select the seat's card by
   `dispatched_terminal === from` alone. Order candidates so a live card (`dispatched_at` set)
   wins over an orphaned one, so behaviour is unchanged for a seat holding exactly one live card.

2. **Disambiguate with `planId`.** When the post carries `planId`, match that card exactly (the
   existing mismatch guard at `LocalApiServer.ts:3272` already refuses another seat's card and is
   kept). When it does not, fall back to the ordering from step 1.

3. ~~**Teach the directives to send it.**~~ **REMOVED 2026-09-04 (Board Collapse 04, decision 8).**
   This step edited the four completion directives in `agentPromptBuilder.ts` and the
   standing-order fragment. That text is owned by *Completion Directive Becomes a Standing Order*,
   which now carries the `planId` instruction itself along with the rest of the completion
   protocol. Two plans must not edit those five copies. **This plan makes no prompt change.**

   The release fix in step 2 does not depend on it: `planId` only disambiguates when a seat holds
   more than one card, and the release already keys on `dispatched_terminal === from`. If the
   directive work lands later, the disambiguation improves; if it never lands, the release is
   still correct.

4. **Pin the agreement in a test.** The two `WHERE` clauses drifting apart is the whole bug and
   nothing detected it. Assert that the fields the release path matches on are a superset of the
   fields the in-flight predicate blocks on.

## Complexity Audit

### Routine

- The `board.find` → ordered select in `_runQueueDone`: a few lines in one function.
- Adding `planId` to five directive strings.
- Extending four existing, already-CI-wired test files.

### Complex / Risky

- **Multi-card ambiguity during the transition.** Until the directives ship, a post with no
  `planId` from a seat holding 142 orphaned rows must not release an arbitrary one. The ordering
  rule (live card first) covers the normal case; a seat with *only* orphaned rows and no `planId`
  releases its most recently dispatched one. This is a deliberate, stated choice, not an
  accident — document it at the call site.
- **`queue/done` releases without asserting completion.** After this change a seat's post nulls
  `dispatched_terminal`, so `heldByTeam` stops counting the card while `completed_at` stays NULL.
  That is correct — `completed_at` is the *lead's* assertion that a plan is finished, a different
  fact from *this seat is no longer working on it* — but a reader will want to ask. Say so in the
  code, next to the predicate.
- **Both hosts, one code path — verify, do not assume.** `LocalApiServer` is constructed in the
  extension host at `TaskViewerProvider.ts:3778` and in the standalone host at
  `bootstrap.ts:3441`; `KanbanProvider` and `KanbanDatabase` are shared. The four
  `PlanIngestionEngine` queue seams (`setQueueHeadResolver`, `setQueuePacingResolver`,
  `setQueueTeamMembersResolver`, `setQueueEscalationRecorder`) are confirmed wired in **both**
  roots today. No new seam is introduced. Re-check by hand at implementation time regardless —
  the verb path is not the audit, the composition root is.

## Edge-Case & Dependency Audit

**Race conditions.** `_runQueueDone` already runs inside the `_queueNextChain` critical section,
which serialises select → in-flight check → dispatch per process. Widening the select does not
widen the window. Two seats posting at once still serialise, and a seat cannot match another
seat's card because `dispatched_terminal === from` is unchanged.

**Duplicate detection survives.** A seat that already released finds no card (its
`dispatched_terminal` is NULL) and falls into the existing `duplicate` arm, which replays the
prior pop from `_lastSeatPop` rather than reporting "queue empty". Unchanged.

**Escalation ladder.** The queue stall watch re-stages dead cards via `releaseDispatchHolder`,
which nulls both fields. Unaffected — it was already using the full release.

**Activity light.** Untouched. `dispatched_at` keeps its single remaining meaning ("an agent is
working now") and column moves keep clearing it.

**Feature cascades.** `cascadeFeatureByPlanId` moves a feature and its subtasks together, nulling
`dispatched_at` across the set. After this change each subtask's seat can still release its own
row by name. No cascade change needed.

**Security / auth.** None. Both endpoints already sit behind `_checkAuth`.

**Side effects.** One: seats that have been silently failing to release will start releasing on
their next post, so a team blocked for days becomes unblocked and the queue starts popping again.
That is the fix, but it will look like a burst of dispatch activity the first time it runs.

## Dependencies

- Independent of `the-team-panel-releases-what-the-lead-did-not-post.md`. That plan gives the
  operator a button to clear the existing backlog; this one stops the backlog being created.
  Either can ship first.
- No new package dependencies.

## Adversarial Synthesis

Key risks: (1) widening the release select releases the *wrong* card for a seat holding many
orphans — mitigated by the live-card-first ordering plus `planId` in the directives, and bounded
because the orphan population stops growing the moment this ships; (2) a reader mistakes the
change for a restoration of the deleted column-release valve and reverts it — mitigated by
stating the distinction in the code comment and by a test asserting `kanban_column` stays out of
the in-flight predicate; (3) the directive edits drift again the next time the endpoint contract
moves — mitigated by the superset test in step 4, which fails on the *code*, not on prose.

The residual risk is behavioural, not structural: a seat that posts `queue/done` without ever
posting `task/complete` leaves `completed_at` NULL forever, so a lead reading "which plans are
finished" from `completed_at` sees nothing for solo-dispatched cards. That is the existing
contract and this plan does not change it, but it is the next question someone will ask.

## Proposed Changes

### `src/services/LocalApiServer.ts` — `_runQueueDone` held-card select (`~:3250`)

**Context.** `board.find(p => p.dispatchedTerminal === from && !!p.dispatchedAt)` cannot see a
card whose column has advanced.

**Logic.** Replace the `find` with an explicit, ordered selection:

```ts
// Find the active card this seat holds. Keyed on the HOLDER (dispatched_terminal),
// not on dispatched_at: every column move nulls dispatched_at and deliberately keeps
// the holder stamp (KanbanDatabase.ts:2664, :6810), so requiring the timestamp here
// made a card unreleasable by its own seat the moment the board advanced it — while
// heldByTeam (:76), which reads only dispatched_terminal + completed_at, went on
// counting it as in flight. 569 of 571 blocked cards were in that state.
//
// This is NOT the deleted column-release valve (:2040-2056). Board position still
// releases nothing; the seat's explicit post is still the only release. The post can
// now find its card, which is all that changes.
//
// Ordering: a live card (dispatched_at set) wins over an orphaned one, so a seat
// holding exactly one live card behaves exactly as before. With only orphans and no
// planId, the most recently dispatched wins — deliberate, and the directives below
// send planId so it is a transitional case only.
const candidates = board
    .filter((p: any) => p && p.dispatchedTerminal === from)
    .sort((a: any, b: any) => (b.dispatchedAt || '').localeCompare(a.dispatchedAt || ''));
const held = planId
    ? candidates.find((p: any) => p.planId === planId)
    : candidates[0];
```

Keep the existing `planId` mismatch guard below it — with `planId` now used for selection, the
guard's job becomes "the seat does not hold that card at all", so its message is adjusted, not
removed.

### `src/services/LocalApiServer.ts` — `heldByTeam` comment (`:74`)

**Logic.** Add one paragraph recording that `dispatched_at` is intentionally absent from this
predicate, that the release path is keyed on the same field this predicate is (`dispatched_terminal`),
and that `queue/done` releasing a hold without writing `completed_at` is correct — the two facts
answer different questions.

### `src/services/agentPromptBuilder.ts` — the completion directives

**Logic.** In `CODING_COMPLETION_REPORT_DIRECTIVE` (`:1087`), `COMPLETION_STEP_FULL` (`:1154`)
and `COMPLETION_STEP_COMPACT` (`:1156`):

- POST body becomes `{"from":"<your terminal name>","planId":"<the PLAN_ID from your dispatch>"}`.
  `agentPromptBuilder.ts:543` already emits a `PLAN_ID=` line per plan, so the value is in the
  prompt the agent is reading.
- Replace "This signals task completion to the kanban board" with a true description: the post
  releases the seat's hold on that card and asks for the next item.

Same two edits to the `queue/done` references in `STAGGERED_IMPLEMENTATION_DIRECTIVE` (`:1075`)
and the completion fragment in `standingOrderFragments.ts:57-64`.

**Edge case.** Batch dispatch is M plans : 1 prompt : 1 terminal, so a prompt can carry several
`PLAN_ID=` lines. The directive must say: one POST per plan, using that plan's id. Do not invent
a multi-id body — the endpoint takes one.

### No change to `POST /kanban/task/complete`

It stays the lead's assertion that a plan is finished, and the only writer of `completed_at`. It
is not in this plan's path.

## Verification Plan

### Automated

All four gates below already exist and are already invoked by CI — extend them, do not add new
scripts or workflow steps.

1. **`test:contract:queue-pipeline`** (`src/test/queue-pipeline-contract.test.js`, CI line 1054) —
   the load-bearing new case. Seed a card with `dispatched_terminal = 'seat-1'`,
   `dispatched_at = NULL`, `completed_at = NULL`, in `CODE REVIEWED`. Assert `heldByTeam` reports
   it in flight AND `_runQueueDone` from `seat-1` releases it. At HEAD the second half fails —
   confirm that before writing the fix, or the test proves nothing.
2. **`test:contract:queue-pipeline`** — predicate-agreement guard: every field the release select
   matches on must be a subset of the fields `heldByTeam` blocks on. This is the drift that caused
   the bug; it must fail on code, not on a comment.
3. **`test:contract:queue-pipeline`** — ordering: a seat holding one live card and three orphans,
   posting with no `planId`, releases the live one. With `planId` naming an orphan, releases that
   orphan. With a `planId` the seat does not hold, refuses.
4. **`test:contract:queue-pipeline`** — negative, pins the deleted valve as still deleted: moving a
   card between columns must NOT change `heldByTeam`'s answer.
5. **`test:contract:reviewer-prompt-behaviour`** (`agentPromptBuilder.test.ts`, CI line 616) —
   each of the three directive constants contains `planId` in its POST body and no longer contains
   the string "signals task completion".
6. **`test:contract:completion-asserted-never-inferred`** (CI line 1283) — unchanged and still
   green: `completed_at` still has exactly one writer, and nothing infers completion from column,
   mtime or silence.
7. **`test:contract:queue-stall-watch`** (CI line 1298) — unchanged and still green: the escalation
   ladder still re-stages via `releaseDispatchHolder`.
8. `npm run compile` and `tsc --noEmit` clean for the two changed files.

### Manual

9. **Both hosts.** Dispatch a card to a seat in the VS Code extension host, let the board advance
   its column, then have the seat POST `queue/done` with its `planId`. Confirm it releases and the
   next card pops. Repeat in `npx switchboard`. The code path is shared, but the two composition
   roots construct `LocalApiServer` separately (`TaskViewerProvider.ts:3778` /
   `bootstrap.ts:3441`) and this plan is not proven until both have been driven.
10. **The reported symptom.** On a board with orphaned rows, confirm a seat's `queue/done` no
    longer 409s naming a card from a previous day.

### Goal Invariants

- **Positive:** a card with `dispatched_terminal = seat`, `dispatched_at` NULL, `completed_at`
  NULL, in any column, is released by `POST /kanban/queue/done {from: seat, planId}`.
- **Positive:** after that post, `heldByTeam` reports the card not in flight.
- **Negative (paired):** a seat cannot release a card held by another seat — a `planId` naming
  another seat's card is refused, not silently ignored. Paired positive: the same post with the
  seat's own `planId` succeeds.
- **Negative (paired):** moving a card between columns still releases nothing —
  `heldByTeam` returns the same answer before and after a column move. Paired positive: the seat's
  explicit post does release it. A change that made column position release the team fails this
  pair even though it "fixes" the symptom.
- **Negative:** `dispatched_at` is not written by any new code path; the activity light keeps its
  current behaviour.
