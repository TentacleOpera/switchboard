# Mission 05 — Planning and Review Fan Out in Rounds, and Nothing Is Dropped

Subtask of the feature **Every Batch Move Becomes One Declared Thing — a Mission or a Fan-Out Pipeline** (`8ecfdaee`). The feature file carries the full argument and the constraints binding every subtask. This plan is self-sufficient on its own scope and, where the two disagree, **this plan wins** — it is the source of truth for the seat implementing it.

## Goal

A batch to the Planning or Review team becomes `ceil(total plans / live seats)`
rounds, and every plan is dispatched.

## Problem — the remainder is silently dropped today

`_distributePlannerDispatch` ends at:

```ts
const plans = ordered.slice(0, terminals.length);
```

Move ten cards to Planned with three planner seats and **three are dispatched
and seven are not**. They sit in the column looking dispatched, with nothing
recording that most of the batch went nowhere. The operator's only clue is that
the work never happens.

### Verified against HEAD (2026-09-20) — what exactly happens to the remainder

- `_distributePlannerDispatch` (`KanbanProvider.ts:8434-8575`) sorts the batch
  (`:8475`), slices to `terminals.length` (`:8491`), **moves only the sliced
  subset** (`_advanceCards(dispatchedIds)`, `:8502`) and fans that subset out
  one-per-terminal (`:8517-8540`).
- The remainder is therefore **left in the source column** (`CREATED` /
  `PLAN REVIEWED`), not marked in-flight — better than the original wording
  ("sit in the column looking dispatched") suggested, and worse in one respect:
  there is **no record of the batch at all**. The only trace is a status line,
  `"… (7 plan(s) held for the next round — one plan per planner seat)"`
  (`:8559-8561`). Nothing registers a round, nothing advances one, and nothing
  will ever release those seven.
- The round machinery this needs already exists for features:
  `coding_rounds` (`KanbanDatabase.ts:695-708`: `round_id`, `feature_id`,
  `team_id`, `ordinal`, `state`, `subtask_seats`, `registered_at`,
  `dispatched_at`, `closed_at`) with readers/writers at `:8442-8746`, and
  `_dispatchRoundCore` (`LocalApiServer.ts:5951-6060`) which assigns seats
  round-robin and dispatches each plan with an explicit `keepColumn` —
  **deliberately bypassing complexity routing** (`:6016-6031`: *"Keep the card
  where it is. A team decides who works what; complexity routing is the
  NON-team path."*). That comment is the precedent Mission 06 reuses.
- Round advance already rides asserted completion: `completeCardInternal` and
  the round handlers call `_dispatchRoundCore` for the next round
  (`LocalApiServer.ts:5156`, `:5493`, `:5784`, `:5920`).

**One blocker on reuse:** `coding_rounds.feature_id` is `NOT NULL` and the key
is `UNIQUE(feature_id, ordinal)` (`:697`, `:707`). A planning batch has no
feature. `coding_rounds` is itself unreleased — its own comment says so at
`:8714` (*"`coding_rounds` is unreleased (clean break), so this method is
additive"*) — so generalising it is allowed with no migration shims.

## Metadata

- **Tags:** backend, feature, bugfix
- **Complexity:** 6
- **Feature:** 8ecfdaee-8187-4e16-aa6a-e6975c864aba

## User Review Required

No. The rounds model is stated in the Goal; this plan adopts the existing
feature-round machinery rather than inventing a second one.

## Complexity Audit

### Routine

- Round registration and the ordinal arithmetic
  (`ceil(total / seats)`, ordinal 1..N).
- Reusing `_dispatchRoundCore`'s seat assignment and explicit-column dispatch
  (`LocalApiServer.ts:6006-6050`).
- Review takes the same shape with `getRoleTerminalSet('reviewer', …)`.

### Complex / Risky

- **`coding_rounds` needs generalising.** `feature_id NOT NULL` +
  `UNIQUE(feature_id, ordinal)` cannot key a featureless planning round. Two
  options: (a) make `feature_id` nullable and key on `(team_id, ordinal)`, or
  (b) add a sibling rounds table. **Choose (a)** — one round concept, one table,
  and the table is unreleased so the change is a clean break. Record the choice
  in the diff; do not leave both.
- **Which planner-headed team this branch belongs to.** `planning-team`
  (`pool`) and `multi-agent-planning` (`head-only-when-sole`, shipped
  `enabled: false`) share `headRole: 'planner'` and the `PLAN REVIEWED` column
  (`teamWiring.ts:1018`/`:1167`, `:1051`/`:1210`). **This plan owns the `pool`
  branch; Mission 03 owns the mission branch.** Both call Mission 03's
  `resolveBatchTeam` resolver — do not re-derive the branch here.
- **The advance rule must be uniform with Mission 04.** A round advances when
  **every card dispatched in that round has asserted completion**; the team's
  `completionAuthority` (`teamWiring.ts:1286-1304`) decides *who* asserts —
  Planning's seats assert their own card and pull the next
  (`accept --plan` then `next`, the shipped planning prompt at
  `teamWiring.ts:1030-1036`), Review's head accepts each reviewed plan. The
  mechanism is identical; do not write a second advance semantic.
- **Review's seats read, they do not write.** The round shape is unchanged, but
  the per-round prompt for a reviewer is the review prompt, not the planner's
  improve-plan instruction (`KanbanProvider.ts:8502-8540` passes
  `'improve-plan'` for planners; the review path passes its own instruction).
  Getting this wrong hands reviewers a "write the plan" prompt.
- **Both composition roots.** `_distributePlannerDispatch` is shared, but the
  standalone host's batch arm (`bootstrap.ts:3623-3845`) has its own dispatch
  path and must reach the same round registration.

## Edge-Case & Dependency Audit

**Race Conditions**

- Round N+1 must not be released while any round-N card is incomplete — compute
  the advance inside the serialised chain (`_queueNextChain`), exactly as the
  feature rounds do.
- A round whose seats are all gone (terminals closed mid-round): the existing
  `seats.length === 0` guard in `_dispatchRoundCore` (`:5979-5996`) already
  reports every subtask `delivered: false` with a reason instead of dispatching
  blind. Reuse it; do not re-implement.
- Two batches to the same planner team: two round sets, independent ordinals
  under `(team_id, ordinal)` — verify the key does not collide across batches.

**Security**

- No new trust boundary. Round rows are written from the existing move path.

**Side Effects**

- Rounds make a batch resumable and inspectable, which changes the board's
  payload: the existing `codingRounds` field on `updateBoard`
  (`KanbanProvider.ts:1735`, `:4680`) is already rendered — a planning round
  must render through that same field rather than a new one.
- The status message must report the round count and the total, not just the
  first round's fan-out: `"4 rounds; 10 of 10 dispatched"`.

**Dependencies & Conflicts**

- **Mission 02 (blocker).** The planner/reviewer head gates.
- **Mission 03.** Supplies `resolveBatchTeam`; this plan is its `fanout` branch.
- **Mission 04.** Shares the completion-driven advance rule and the
  `_queueNextChain` discipline.
- **Mission 08.** A released card's column is the stage column; the rounds path
  already dispatches with an explicit `keepColumn` and must keep doing so.

## Dependencies

- `round-registration-drops-the-leads-seat-choice` — the existing round
  registration path; read together so this plan does not reintroduce a seat
  choice the round already made.
- `feature_plan_20260812150700_kanban-created-send-plans-to-planner-team` —
  the originating planner fan-out work this plan completes.
- `coding-rounds` feature (the `coding_rounds` table) — the machinery being
  generalised.

## Adversarial Synthesis

Key risks: the remainder is currently not even recorded, so a fix that only
dispatches more cards without registering rounds will still lose the batch on
any restart; `coding_rounds` cannot key a featureless round as it stands; and a
second advance semantic for rounds would diverge from the wave rule. Mitigations:
generalise `coding_rounds` to a team-scoped round (feature_id nullable, key on
`(team_id, ordinal)`, clean break as the table is unreleased); reuse
`_dispatchRoundCore` and its explicit-`keepColumn` dispatch; make both rounds and
waves advance on the same asserted-completion rule.

## Proposed Changes

### 1. A batch becomes `ceil(total plans / live seats)` rounds (`src/services/KanbanProvider.ts:8434`)

- **Logic:** in `_distributePlannerDispatch`, before slicing: compute
  `rounds = Math.ceil(ordered.length / terminals.length)`, register round rows
  (ordinal 1..rounds, the ordered plan-id list partitioned by round), dispatch
  round 1 exactly as today, and report the round count.
- **Implementation:** reuse `_dispatchRoundCore`'s seat assignment
  (`LocalApiServer.ts:6006-6050`) rather than the local round-robin at
  `:8517-8540` — one fan-out implementation.
- **Edge cases:** a batch that fits in one round registers one round and
  behaves byte-for-byte as today (the regression gate). `terminals.length === 0`
  keeps the existing single-trigger fallback (`:8455-8468`).

### 2. `ordered.slice(0, terminals.length)` becomes the end of the first round

- **Logic:** the slice stays, but as "round 1's set", not "the batch". Round N's
  cards move to the next column **when round N is dispatched**, not at
  registration — so undelivered cards never look dispatched.

### 3. The next round releases when the round's seats report

- **Logic:** on the asserted completion of the last incomplete card of round N,
  dispatch round N+1 through the same `_dispatchRoundCore` path (the existing
  call sites at `:5156`/`:5493`/`:5784`/`:5920` are the model). Enqueue on
  `_queueNextChain`.
- **Edge cases:** a round with no live seats holds and reports
  (`_dispatchRoundCore:5979`). A paused mission (Mission 07) does not apply here
  — rounds are not missions — but a stopped team must not silently drop the
  round: it stays registered and reports.

### 4. Review takes the identical treatment

- **Logic:** same registration and advance, with the reviewer role terminal set
  and the review prompt instruction; Review's head accepts each reviewed plan
  (its `completionAuthority` is `'head'`), which is the same completion fact the
  advance reads.

### 5. `coding_rounds` generalised to a team-scoped round (`src/services/KanbanDatabase.ts:695`)

- **Logic:** `feature_id` nullable; key on `(team_id, ordinal)`. Existing
  feature-round writers pass `feature_id` as they do today, so their rows and
  reads are unchanged. Clean break — the table is unreleased, no migration
  shims.

## Verification Plan

### Automated Tests

- **Ten plans, three seats → four rounds, all ten dispatched.** Asserted on the
  count, because the current failure is silent: the test must assert
  `dispatched === 10`, not "the first round dispatched 3".
- **Review behaves identically to Planning on the same input.**
- **A batch that fits in one round behaves exactly as today** — the existing
  `batch-move-team-prompt-contract.test.js` planner fixtures are the gate.
- **The remainder is registered, not lost**: after a restart mid-batch, the
  registered rounds still exist and round N+1 still releases on completion.
- **Round N+1 has no dispatch evidence until round N is complete.**
- **Both roots**: the standalone batch arm registers rounds too.

### Goal Invariants

- **Positive:** for a batch of `n` plans and `s` live seats, the number of
  registered rounds equals `ceil(n / s)` and the union of their plan-id lists is
  exactly the batch.
- **Negative:** no plan of the batch is left undispatched after the last round
  completes — the count of dispatched cards equals the batch size.
- **Negative:** no card of round N+1 carries dispatch evidence while any card of
  round N has `completed_at IS NULL`.
- **Positive:** a batch of `n ≤ s` registers exactly one round and its dispatch
  sequence matches HEAD.
- **Negative:** `coding_rounds.feature_id` is nullable in the schema and no
  second rounds table exists (one round concept).

## Constraints

**No hand-dispatch on the Coding team.** `ptySendPrompt`-to-a-seat was
deliberately removed from its head prompt; nothing here may put it back.

**Derive the pipeline order and the head-role set** — never hand-keep either.
`_PIPELINE_POSITION` shipped wrong once when it was hand-kept.

**Nothing may be silently dropped.** Every plan is delivered or visibly queued.

**Teams are unreleased dev work** — clean break, no migration shims.
