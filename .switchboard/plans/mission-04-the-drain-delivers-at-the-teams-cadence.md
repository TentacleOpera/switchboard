# Mission 04 — The Drain Delivers at the Team's Cadence

Subtask of the feature **Every Batch Move Becomes One Declared Thing — a Mission or a Fan-Out Pipeline** (`8ecfdaee`). The feature file carries the full argument and the constraints binding every subtask. This plan is self-sufficient on its own scope and, where the two disagree, **this plan wins** — it is the source of truth for the seat implementing it.

## Goal

A mission releases members at a rate its team declares: Coding one, Feature five
with its drive prompt, Multi-agent planning one.

## Problem

`dispatchNextFromQueue` pops exactly one member, serialised through
`_runQueuePop`, with `pacing: 'head' | 'seat'` resolved from a team field. One is
right for Coding and wrong for Feature, which needs five in flight with
`_buildBatchDrivePrefix` — the lead's existing and working contract. Today the
sixth plan of a Feature batch is simply skipped.

`pacing` is the nearest existing lever and cannot express "five".

### Verified against HEAD (2026-09-20)

- The pop takes `candidates[0]` (`LocalApiServer.ts:4250`) — exactly one member,
  by construction.
- `pacing` is a tri-state team-group field (`'head' | 'seat'`, absent → `'head'`;
  `teamWiring.ts:118-126`, read at `:3525-3568`), consumed at
  `LocalApiServer.ts:4074-4080`. It decides *who* receives the pop, never *how
  many*.
- **V81 deleted the in-flight refusal outright** (`LocalApiServer.ts:4082-4088`):
  *"There is no 'team already in flight' 409 … a seat that already holds a card
  and asks for the next one simply gets the next one."* So there is **no
  in-flight accounting anywhere today** — wave accounting must be derived from
  the mission's members, not read from a gate that no longer exists.
- `TEAM_BATCH_PLAN_CAP = 5` (`agentPromptBuilder.ts:134`) and `applyBatchCap`
  (`:144`) already implement "five, remainder held" for the batch *prompt* path;
  `_buildBatchDrivePrefix` (`KanbanProvider.ts:6650`) is the Feature team's
  drive contract, prepended at `:7639` when
  `batchOptions.batchMode && role === 'lead'`.

### The mechanism the original wording left open

"The drain learns how many members to release per wave … expressed as a team
field beside `pacing`" names the *knob* but not the *release*. A wave of five is
**one dispatch to the head carrying five members** — one prompt with
`_buildBatchDrivePrefix` listing the wave — not five separate pops. Five pops
would hand the Feature lead five unrelated single-plan prompts and lose the
drive contract entirely. The plan below specifies the release; that is the part
a coder would otherwise invent wrongly.

## Metadata

- **Tags:** backend, feature
- **Complexity:** 7
- **Feature:** 8ecfdaee-8187-4e16-aa6a-e6975c864aba

## User Review Required

No. The cadence per team is stated in the Goal and fixed by the operator's
decision (5 / 1 / 1). What a coder needs is the *mechanism*, which this plan now
specifies.

## Complexity Audit

### Routine

- A new team-group field beside `pacing` (`batchSize`), read by a resolver
  modelled on `resolveTeamPacingForHead` (`teamWiring.ts:3525`).
- Coding's and Multi-agent planning's cadence is 1 — the existing pop.
- Feature's wave size is 5, the existing `TEAM_BATCH_PLAN_CAP`.

### Complex / Risky

- **The wave release is new machinery in the drain.** `_runQueuePop` dispatches
  one card through `performKanbanDispatch`. A wave dispatch must carry N member
  ids to one head and build the drive prefix for exactly those N — the shape
  `triggerBatchAgentFromKanban` + `buildKanbanBatchPrompt` already have, reused
  rather than re-implemented.
- **Wave accounting has no existing source.** In-flight = mission members whose
  `completed_at IS NULL` and which have dispatch evidence. That is the same
  asserted-completion fact the pop's dependency gate and `_deriveMissionRunState`
  already read (`KanbanDatabase.ts:16513-16530`) — no new ledger, no owner gate
  (V81 removed it).
- **The advance trigger.** Nothing today releases "the next five". The signal
  must be the asserted completion of the last member of the in-flight wave,
  observed where completion already lands: `completeCardInternal`
  (`LocalApiServer.ts:4669`, the accept path) and the `queue/done` /
  `queue/next` pull. A wave that advances on a timer or on silence is the
  failure mode the board's whole completion contract exists to prevent.
- **Ordering inside the chain.** The release must be enqueued on
  `_queueNextChain` (`LocalApiServer.ts:77-87`) like every other pop, or two
  completions racing release two overlapping waves.
- **Both composition roots.** The release trigger sites exist in shared code
  (`LocalApiServer`), but the standalone host's own dispatch arm
  (`bootstrap.ts`) and the extension's (`TaskViewerProvider.ts`) must both reach
  the same wave logic.

> **Superseded:** "The drain learns how many members to release per wave,
> resolved from the receiving team and expressed as a team field beside
> `pacing` — not a constant in the drain."
> **Reason:** correct about the knob, silent about the release. As written, a
> coder can satisfy it by calling the pop N times — which delivers N single-plan
> prompts to the Feature lead and silently discards `_buildBatchDrivePrefix`,
> the one thing that makes the Feature team's five-in-flight work. It also
> implies an in-flight gate that V81 deleted.
> **Replaced with:** a wave is **one batch dispatch to the mission's head**
> carrying that wave's member ids, built through the existing batch prompt path
> so the drive prefix applies; the next wave releases when every member of the
> in-flight wave has asserted completion; the cadence knob is a team field read
> exactly like `pacing`.

## Edge-Case & Dependency Audit

**Race Conditions**

- Two members of a wave completing simultaneously: both fire the advance check;
  the release must be idempotent under the serialised chain (compute
  "is the wave drained?" inside the chain, and release only if the mission has
  no in-flight member and has undelivered members).
- A member that is dispatched but whose completion never arrives (a crashed
  seat) pins the wave. This plan does **not** solve that — it is the same
  liveness problem `a-seat-that-finishes-without-reporting-is-watched-by-nothing-once-the-queue-is-empty`
  covers, and the queue watch (`armQueueWatch`, `LocalApiServer.ts:4351`) is the
  existing nudge. Name it; do not paper over it with a timeout that silently
  releases work.

**Security**

- No new trust boundary. The cadence is operator-authored team config.

**Side Effects**

- A Feature mission now holds up to 5 cards in `LEAD CODED` at once instead of
  one. That is the requested behaviour, and it is why Mission 06 (release
  column) and Mission 01 (scoping) must land first.
- The status/prompt count must be the number actually released, never the number
  selected — the rule the batch prompt builder already states at
  `KanbanProvider.ts:7600-7602`.

**Dependencies & Conflicts**

- **Mission 01 (blocker).** A wave released without mission scoping is five
  times the cross-mission leak.
- **Mission 03.** Owns mission creation and the launch; this plan owns the rate
  of release *after* the launch.
- **Mission 05.** The rounds model for Planning/Review is the fan-out analogue
  of this cadence. They must share the "advance when the round/wave's cards have
  asserted completion" rule so the board has one completion-driven advance
  semantic, not two.
- **Mission 07.** Pause stops the drain; a paused mission must not advance a
  wave.
- **Mission 06.** The release column for each member.

## Dependencies

- `a-batch-dispatch-clears-one-card-and-leaves-its-siblings-lit` — the batch
  dispatch surface this plan reuses; read together so the wave release clears
  the same state the batch path does.
- `a-seat-that-finishes-without-reporting-is-watched-by-nothing-once-the-queue-is-empty`
  — the stalled-wave liveness gap named above.

## Adversarial Synthesis

Key risks: a wave implemented as N pops silently destroys the Feature team's
drive contract; there is no in-flight ledger after V81, so wave accounting must
be derived from asserted completion; and a stalled seat pins a wave with no
timeout that is safe to add. Mitigations: one batch dispatch per wave through the
existing prompt path; derive in-flight from `completed_at` on the mission's
members inside the serialised chain; leave the stalled-wave case to the existing
queue watch and name it rather than inventing a silent release.

## Proposed Changes

### 1. The cadence knob — a team field beside `pacing` (`src/services/teamWiring.ts`)

- **Logic:** `resolveTeamBatchSizeForHead(opts)`, modelled line-for-line on
  `resolveTeamPacingForHead` (`:3525-3568`): read the live group's `batchSize`,
  default **1**. Return `{ value, source }` so "which store answered?" is
  answerable — a routing read, per AGENTS.md.
- **Edge cases:** absent/non-numeric/`< 1` → 1 (the safe, visible value: a
  mission delivers one at a time). Values above `TEAM_BATCH_PLAN_CAP` are
  clamped to the cap and the clamp is logged, not silent.
- **Shipped defaults:** Feature (`feature-implementation`) → 5, Coding → 1,
  Multi-agent planning → 1, Planning/Review → not used (they take the rounds
  branch, Mission 05). Written as `batchSize` + `batchSizeSource` on the
  definitions, exactly as `automatedDispatch` is (`teamWiring.ts:1051-1052`).

### 2. A wave release in the drain (`src/services/LocalApiServer.ts`, `_runQueuePop`)

- **Logic:** when the mission's cadence is N > 1, release = **one** dispatch to
  the mission's head carrying up to N members:
  1. select the mission's undelivered members in `column_order` order (Mission
     01's scoped candidate set), take up to N;
  2. move each to its stage column (Mission 06);
  3. dispatch once to the head with the batch prompt + `_buildBatchDrivePrefix`
     for exactly those members — the same builder the batch path uses
     (`KanbanProvider.ts:7623-7643`);
  4. record what was released and what remains, in the response and on the
     card.
- **Edge cases:** N > 1 with only 1 undelivered member releases 1. A wave whose
  dispatch fails leaves every member staged (the existing "a pop must never
  consume a card it did not start" rule, `:4339-4345`).
- **Implementation:** the N = 1 path is today's code, unchanged — the
  regression gate.

### 3. The advance trigger (`src/services/LocalApiServer.ts`, completion paths)

- **Logic:** after any member of a mission asserts completion
  (`completeCardInternal`, `:4669`; and the `queue/done` path, `:4436`), enqueue
  on `_queueNextChain`: if the mission has no in-flight member and has
  undelivered members, release the next wave. Idempotent under the chain.
- **Edge cases:** a completion for a member whose mission is paused (Mission 07)
  releases nothing. A completion for a card in no mission behaves exactly as
  today.
- **Trigger note:** for head-paced teams the head accepts per plan
  (`accept --plan`); for seat-paced teams the seat posts `queue/done` and pulls
  with `queue/next`. Both land on the same advance rule.

### 4. Per-team behaviour (no new constants in the drain)

- **Coding → 1:** already the default; the pair split (head Band B, intern Band
  A) applies per plan and is automatic since `7a78665b`.
- **Feature → 5:** wave release with `_buildBatchDrivePrefix`; the mission owns
  the remainder — the next five release when the in-flight five are accepted.
- **Multi-agent planning → 1:** released to its head, which fans out to its own
  seats by design.

## Verification Plan

### Automated Tests

- **Feature: twelve plans → five in flight, the next five released on
  acceptance.** Assert the count at each step (5 delivered, 7 staged; accept the
  5 → next 5 delivered), because a silent over- or under-release is the failure
  this plan exists to prevent.
- **Coding: four plans → exactly one in flight**, the intern receiving its Band A
  half automatically, the next released on `accept --plan`.
- **Multi-agent planning releases one at a time.**
- **Feature's behaviour for a batch of five or fewer is unchanged** — the
  existing cap fixture (`batch-move-team-prompt-contract.test.js:441-461`)
  is the regression gate.
- **The wave is one dispatch**: assert one prompt/one `dispatched` event for a
  wave of five, not five.
- **A stalled wave does not auto-release** — no timer releases work; the queue
  watch is what fires.

### Goal Invariants

- **Positive:** a mission whose team declares cadence 5 has at most 5 members
  with dispatch evidence and no asserted completion at any time.
- **Positive:** the next wave releases only after every member of the previous
  wave has `completed_at` set (assert the negative space: no member of wave 2
  has dispatch evidence while any wave-1 member is incomplete).
- **Negative:** a wave of N is dispatched as one prompt — the number of dispatch
  events for a wave equals 1, not N.
- **Negative:** no cadence constant is written into `_runQueuePop`; the value
  comes from the team read (source-text assertion).
- **Positive:** an absent `batchSize` reads as 1 and logs its source.

## Constraints

**No hand-dispatch on the Coding team.** `ptySendPrompt`-to-a-seat was
deliberately removed from its head prompt; nothing here may put it back.

**Derive the pipeline order and the head-role set** — never hand-keep either.
`_PIPELINE_POSITION` shipped wrong once when it was hand-kept.

**Nothing may be silently dropped.** Every plan is delivered or visibly queued.

**Teams are unreleased dev work** — clean break, no migration shims.
