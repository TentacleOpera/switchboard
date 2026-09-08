# Coding Rounds 05 — The Lead Is Told Its New Contract, and the Board Shows the Rounds

kanbanColumn: CREATED

## Goal

The lead's standing orders describe registering rounds and marking them done — and nothing about dispatching seats. The board shows which round a team is on.

### Problem analysis

A lead knows `/kanban/task/complete` exists for exactly one reason: `buildHeadCompletionFragment()` (`standingOrderFragments.ts:90-108`) spells out the verb, path and payload, delivered as fragment `headCompletion` (`:176`). An endpoint the standing orders never name will never be called.

> **Superseded:** So the endpoints in subtasks 02 and 04 are dead code until this lands, and the dispatch instructions the lead currently follows will race the system path from subtask 03.
> **Reason:** This was written before `/kanban/round/complete` and `/kanban/feature/complete` shipped. Both endpoints now exist (`LocalApiServer.ts:4190` and `:4311`) and are ALREADY referenced in `buildHeadCompletionFragment()` at `:99` (ROUND BOUNDARY) and `:103` (FEATURE COMPLETE). Subtask 04's endpoint is not dead code — it is live and the standing orders already name it. Only subtask 02's `/kanban/round/register` is dead until this subtask names it.
> **Replaced with:** The standing orders already name `round/complete` and `feature/complete`. What is NOT done: (a) the orders still instruct the lead to dispatch subtasks to seats (`CODING_HEAD_WORK` at `:120-138`: "dispatch based on it", "dispatch the next subtask to an idle seat") — these race the system dispatch from subtask 03 and must be removed; (b) the orders do not name `/kanban/round/register`, so subtask 02's endpoint is dead until this lands; (c) `buildHeadNextFragment` (`:110`) tells the lead to "take the next item" via `done --from` — once rounds own the advance, this races the round-complete verb and must be gated or rewritten.

Separately, a registered round is state nobody can see. The operator watching a team has no way to know it is on round 2 of 3, or that a round was dispatched with one prompt missing.

## Metadata

- **Complexity:** 4
- **Feature:** Coding Rounds
- **Tags:** teams, prompts, ui, api

## User Review Required

None.

## Complexity Audit

### Routine
- The standing-orders fragment already exists and already references round/complete + feature/complete — the work is editing `CODING_HEAD_WORK` and `buildHeadCompletionFragment`, not creating new fragments.
- The board UI reads from the existing board-poll data path; adding a round-state field is an additive render.

### Complex / Risky
- Removing the dispatch instructions from `CODING_HEAD_WORK` without breaking teams that have NOT registered rounds — a team with no rounds still needs the lead to dispatch. The removal must be conditional on registered-rounds presence, or the stateless path breaks.
- `buildHeadNextFragment` (`:110`) races the round-complete advance verb — must be gated on "no registered rounds" or rewritten, not left untouched.
- The board UI must READ the `coding_rounds` table, not infer the round from dispatched-card counts — inference fabricates a round for teams that never registered one.

## Proposed Changes

### 1. Rewrite the head's standing orders around rounds

The lead's loop becomes: read the feature, decide the rounds, register them (`POST /kanban/round/register`), then mark each one done (`POST /kanban/round/complete`) as its seats report in.

> **Superseded:** Remove the instructions telling it to dispatch subtasks to seats and to post per-subtask completions — leaving those live means two paths racing to seat the same work.
> **Reason:** The dispatch instructions in `CODING_HEAD_WORK` (`:120-138`) are still present and still race the system dispatch from subtask 03. But "remove" unconditionally breaks teams that have NOT registered rounds — those teams still need the lead to dispatch by hand. The removal must be conditional.
> **Replaced with:** Remove the dispatch instructions from `CODING_HEAD_WORK` ONLY for teams that have registered rounds. The fragment body is composed per-team from `StandingOrderCompositionContext` — add a `hasRegisteredRounds` flag to the context and gate the dispatch instructions on `!hasRegisteredRounds`. A team with no rounds keeps the old instructions; a team with rounds gets the register/mark-done loop and no dispatch instructions.

Keep the contract sentence. *"Your POST is the only fact the system acts on"* is what stops a lead inferring completion from board position, and it is more load-bearing now, not less.

**Leave the gate exactly as it is.** `ctx.inTeam && ctx.isHead && ctx.headRole === 'lead'` (`:176`) is correct: rounds are a coding-team construct. A planning head (`'planner'`) and a review head (`'reviewer'`) do not get them and must not — do not widen the gate, and do not add a round path for either.

### 2. Add the register instruction to the standing orders

`buildHeadCompletionFragment()` already names `round/complete` (`:99`) and `feature/complete` (`:103`). It does NOT name `round/register`. Add a paragraph instructing the lead to register its rounds before marking any complete — naming `POST /kanban/round/register` with its payload shape. Without this, subtask 02's endpoint is dead code.

### 3. Reconcile `buildHeadNextFragment`

`buildHeadNextFragment` (`:110-118`) tells the lead to "take the next item" via `done --from` or the queue/done POST. Once rounds own the advance (subtask 04 auto-dispatches the next round on close), this instruction races the round-complete verb: the lead both "marks the round done" AND "pops the next item," and the two paths collide.

Gate `headNext` on `!hasRegisteredRounds`: a team with registered rounds advances by posting `round/complete` (the system dispatches the next round); a team without rounds keeps the `done --from` pop. Do not leave both advance instructions live for the same team.

### 4. Per-subtask completion stays available

A lead accepting one subtask mid-round still needs `POST /kanban/task/complete`. What changes is that it is no longer how a round is closed — `round/complete` is. The existing `buildHeadCompletionFragment` already describes both; keep the per-subtask path and the round-boundary path.

### 5. Show the round on the board

A team working a feature displays which round it is on and how many there are. A round dispatched with a prompt that did not land shows that (subtask 03's `partial` state), rather than looking identical to one that is working.

**The board must READ the `coding_rounds` table** — not infer the round from dispatched-card counts. A team with three dispatched cards and no registered rounds must NOT show "round 1 of 1" — that is a fabrication. A team with no rows in `coding_rounds` shows nothing new and behaves exactly as it does today.

This is the visibility that would have made the 2026-09-04 incident obvious in seconds instead of hours.

### 6. Both hosts render the board

The board HTML is shared (`src/webview/`) and served by the shared `LocalApiServer`. Both hosts render the same UI. The round-state read must go through the shared board-poll data path, not a host-specific endpoint.

## Edge-Case & Dependency Audit

1. **Depends on 02, 03 and 04** — this names endpoints they create/extend and reads the round state they write.
2. **Half the deliverable is the prompt.** Routes without the fragment ship endpoints no agent calls; the fragment without the routes tells the lead to call something that 404s. The register instruction (change 2) must land with subtask 02's route.
3. **A team with no registered rounds** shows nothing new and behaves exactly as it does today — the `hasRegisteredRounds` gate ensures the old dispatch + pop instructions survive for them.
4. **Both hosts** render the board.
5. **`buildHeadNextFragment` races `round/complete`** if both are live for a team with registered rounds — mitigated by gating `headNext` on `!hasRegisteredRounds` (change 3).

## Dependencies

- **Hard prerequisite:** subtask 02 (`coding-rounds-02-the-lead-registers-its-rounds.md`) — the register endpoint this subtask names in the standing orders must exist.
- **Hard prerequisite:** subtask 03 (`coding-rounds-03-the-system-dispatches-the-round.md`) — the system dispatch path that replaces the lead's hand-dispatch instructions.
- **Hard prerequisite:** subtask 04 (`coding-rounds-04-the-lead-marks-the-round-end.md`) — the round-complete extension that owns the advance, replacing `headNext`'s pop for teams with rounds.
- **Hard prerequisite:** subtask 01 (`coding-rounds-01-the-round-record.md`) — the `coding_rounds` table the board UI reads.

## Adversarial Synthesis

Key risks: (1) removing dispatch instructions unconditionally breaks teams with no registered rounds — mitigated by a `hasRegisteredRounds` context flag gating the removal. (2) `buildHeadNextFragment` racing `round/complete` — mitigated by gating `headNext` on `!hasRegisteredRounds`. (3) board UI inferring rounds from card counts and fabricating state — mitigated by requiring a direct `coding_rounds` read. (4) the register instruction landing without subtask 02's route — mitigated by declaring the co-delivery dependency.

## Verification Plan

1. A lead's standing orders name `round/register` and `round/complete`, and — for a team with registered rounds — contain no instruction to dispatch subtasks to seats.
2. A lead's standing orders for a team with NO registered rounds still contain the dispatch and `done --from` instructions (stateless path preserved).
3. A real lead handed a feature registers rounds without being prompted to.
4. The board shows the current round and the total for a team mid-feature, reading from `coding_rounds`.
5. A round with an undelivered prompt (`partial` state) is visibly distinct from a healthy one.
6. A team with no registered rounds shows no round indicator (no fabrication).
7. A planning head and a review head receive no round instructions, and the gate is unchanged.
8. `buildHeadNextFragment` is absent or gated for a team with registered rounds; present for a team without.
9. Both hosts show the same round state.

### Goal Invariants
- `buildHeadCompletionFragment()` names `POST /kanban/round/register` (singular) in its body text.
- `CODING_HEAD_WORK` dispatch instructions ("dispatch based on it", "dispatch the next subtask to an idle seat") are absent when `hasRegisteredRounds` is true and present when it is false.
- `buildHeadNextFragment` is gated on `!hasRegisteredRounds` — a team with rounds does not receive the `done --from` pop instruction.
- The board round indicator reads from `coding_rounds` (not inferred from card counts); a team with zero rows shows no indicator.
- The gate `ctx.inTeam && ctx.isHead && ctx.headRole === 'lead'` is unchanged (no widening for planner/reviewer).

## Review Findings

Reviewed `a8da4102`; one edit applied to `src/services/standingOrderFragments.ts` and one to the standalone half of subtask 03's `skipClear` path (`bootstrap.ts`). Every Goal Invariant holds: `buildHeadCompletionFragment()` names `POST /kanban/round/register`, `CODING_HEAD_WORK_WITH_ROUNDS` drops the hand-dispatch instructions only when `hasRegisteredRounds` is true, `headNext` is gated with `!(headRole === 'lead' && hasRegisteredRounds)` so reviewer heads and round-less leads keep the pop, the gate `ctx.inTeam && ctx.isHead && ctx.headRole === 'lead'` is unchanged, and the board indicator reads `getCodingRoundsByWorkspace` directly in both board builders (`KanbanProvider.ts:1420` and `:4194`) with zero rows rendering nothing. The fragment edit states that registering STARTS round 1, which is now true (see subtask 02's fix) and closes the contradiction where the orders promised "the system dispatches each round" while nothing dispatched the first. The `standingOrdersDelivery` seam is registered in both composition roots and `host-seam-parity:check` passes. Verification: `tsc -p tsconfig.test.json` clean, `npm run compile` clean, all ten static gates pass, `coding-head-prompt` and `member-completion-reminder` fully green, and `seat-safeguards` improved from 6 red at the pre-feature baseline to 4 (no new failures).

## Deferred Findings

- MAJOR — this commit carries changes no coding-rounds plan asked for: `applySO` widened from `standingOrders !== false && !machineOrigin && !isMessage` to `!== false`, `bareDelivery` remapped to suppress only the seat block, `sendRobustText` applying orders by default when the option is omitted, and an unrelated icon-picker rewrite. Defensible individually and two red gates went green, but unreviewed against any plan. `src/services/TaskViewerProvider.ts:1137`
- MAJOR — `resolveHasRegisteredRoundsForSeat` keys on `resolveTeamStanding`'s `teamId` (the terminal-group id) while `coding_rounds.team_id` is derived independently in `LocalApiServer`; they agree only because both spell `'team_' + encodeURIComponent(head)`. A lead rename breaks the match and silently reverts the lead to the hand-dispatch orders. `src/services/standingOrders.ts:373`
- NIT — the board indicator's total is `rounds.length` rather than the persisted `total_registered`; more honest, but the column is now written and never read. `src/webview/kanban.html:10013`
- NIT — no automated check asserts the fragment switch (rounds vs no rounds) or the board indicator; verification for both is manual only and was not executed in this pass. `src/services/standingOrderFragments.ts:236`
