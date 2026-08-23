# A priority star and manual ordering in every column

## Goal

Give users two ways to express execution order on the board — a **priority star** that overrides everything, and **drag-to-reorder in any column** so the arrangement on screen is the arrangement that runs — and make every consumer that picks "the next card" read them instead of falling back to creation age.

### Problem Analysis

**Ordering is currently expressible in exactly one column, and only as a side effect of staging.** `queue_position` (V60) is *"the STAGING session queue's explicit order… a 1-based sort key assigned by stageForQueue (append from MAX+1), rewritten by reorderQueue (one transaction), and cleared by clearQueuePosition when a card leaves STAGING."* The drag handler that writes it is gated on `effectiveTargetColumn === 'STAGING'` (`kanban.html:9408`) — described as *"Pure same-column reorder (EVERY dragged card is already in STAGING)"*. No other column persists a hand-set order, and no priority flag exists anywhere on `plans`.

**So every "pick the next card" consumer falls back to creation age**, and each does it independently:

- `_distributePlannerDispatch` *"sorts plans oldest-first"* before bucketing across planner terminals.
- The schedule rule in `the-automation-model-four-things-not-a-mode-axis.md` is illustrated as *"advance the oldest card from column A to column B"*.
- `batch-moves-to-a-team-send-the-feature-implementation-prompt.md` caps a batch at five and, outside STAGING, has nothing but age to choose them by.

A user who drags cards in CREATED or PLAN REVIEWED to put important work first is not overridden — **their intent was never recorded**. The board shows one order and the system acts on another, and nothing reports the discrepancy.

**And STAGING is not a priority mechanism.** It is where missions live. Treating "stage it" as "prioritise it" conflates a membership decision with an ordering one: a user who wants a card done first should not have to enrol it in a mission to say so, and a mission's internal sequence is not a place to park unrelated urgent work.

**Two different needs, which is why one mechanism will not do.** "Do this one first, whatever else is queued" is a *flag* — it is about one card relative to all others, it is toggled constantly, and it should be visible at a glance. "Run these in this sequence" is an *order* — it is about the whole column, it is set by arranging, and its value is that the screen shows the plan. A star cannot express a sequence, and a sequence makes a single urgent card tedious to promote.

### Root Cause

Board position was built as state, not as intent. A column records *where* work has got to, and the only ordering ever added — `queue_position` — was added for the queue that needed it rather than as a board-wide capability. Every consumer that needed an order after that had no field to read, so each invented the same fallback.

## Metadata

**Complexity:** 5
**Tags:** feature, frontend, backend, ui

## Settled Design

- **A priority star on cards.** One click on, one click off, no confirmation gate (project rule). It overrides other ordering.
- **Drag-to-reorder in every column**, persisted, so the visible arrangement is the execution arrangement.
- **STAGING keeps `queue_position`.** It is the mission queue's order and the streams work builds on it; a drag inside STAGING already writes it. The new order field covers every *other* column, so no column ever has two competing orders.
- **Precedence, in one place:** starred first → then the column's manual order (`queue_position` in STAGING, the new field elsewhere) → then oldest, as the final fallback for cards never arranged.

## Complexity Audit

### Routine

- A boolean priority column on `plans`, and a star control on the card.
- A general per-column order column, written by the existing drop handler with its STAGING gate widened.

### Complex / Risky

- **`queue_position` must not be generalised to carry this.** It is cleared when a card leaves STAGING, and the streams work makes it the tiebreak among cards at the same stream sequence — so it already carries queue semantics. Reusing it for board-wide visual order would make one integer mean both "mission queue slot" and "where the user dragged it", which is the overload the streams plan already argues against for stage encoding. A separate field, with the STAGING/non-STAGING split above, keeps each number meaning one thing.
- **A star that overrides a dependency is a correctness bug, not a preference.** In STAGING, mission streams sequence work so a card cuts from its predecessor's result. A starred card jumping ahead of an incomplete predecessor produces exactly the conflict the stage map exists to prevent. The star must yield to dependency order — or be refused there with a stated reason — and it must never silently reorder a stream.
- **Precedence has to live in one resolver, not in each consumer.** There are already at least three independent "oldest-first" implementations. Adding two more inputs to each is how they drift; the first symptom is two surfaces disagreeing about which card is next, which is very hard to diagnose from the board.
- **Order on column move.** A card dragged between columns needs a position in its new column. The STAGING handler already computes an insertion index from the drop position, and that behaviour should carry over rather than every cross-column move appending to the end — otherwise dragging a card to the top of a column silently puts it last.
- **A mixed drag is a known trap here.** The existing handler documents that a mixed selection *"previously took the reorder branch and silently discarded the unstaged cards — no message, no error, nothing staged."* Widening the gate to all columns multiplies the mixed cases, so the same losslessness requirement applies to every column pair, not just into STAGING.
- **Starring everything is the same as starring nothing**, and it will happen. Not worth gating, but worth surfacing: a count of starred cards, so the degenerate state is visible rather than felt as "ordering stopped working".
- **NULL ordering must sort predictably.** V60's precedent is explicit — *"NULL sorts last so pre-existing staged cards… keep working and drop to the end of the queue rather than vanishing or jumping the front."* Every card predating this feature has no manual order, so the same rule applies: unarranged cards fall to the end and are then ordered by age.

## Edge-Case & Dependency Audit

**Migration.** Two additive columns, both nullable/defaulted, following the V60 pattern (present in `SCHEMA_TABLES_SQL` so fresh DBs get them at creation, with an idempotent ALTER under the version gate). Every existing card is unstarred and unarranged, so behaviour is unchanged until a user acts — which is what makes this safe for ~4,000 installs.

**Security.** None. Board metadata only.

**Side effects.** Consumers that today pick the oldest card will pick a different card once a user stars or arranges anything. That is the intent, and it is why the precedence resolver must be shared — a partial rollout where one surface honours the star and another does not is worse than neither doing so.

**Ordering.** A precondition for the ordering behaviour promised by the batch plan and the schedule selector; both currently have only age to work with outside STAGING.

## Dependencies

- **Precondition for** `batch-moves-to-a-team-send-the-feature-implementation-prompt.md` (which five get sent) and for the schedule selector amendment tracked in `revise-the-in-flight-plans-for-asserted-completion.md`.
- **Must not disturb** `staging-streams-parallel-dispatch-and-worktrees.md`: `queue_position` keeps its meaning, and the star yields to stage order.
- **Fixes the fallback in** `_distributePlannerDispatch`, whose oldest-first sort is the third independent copy.

## Adversarial Synthesis

**"Staging already gives you an order — use it."** Staging is mission membership. Making it the priority mechanism forces a user to enrol a card in a mission to say "do this first", and lets unrelated urgent work into a sequence that exists to respect dependencies. Two different decisions should not share one gesture.

**"A star is enough — skip drag ordering."** A star answers "which one first" and says nothing about the other eleven. The stated need is to *visualise execution order*, and a flag cannot show a sequence.

**"Drag ordering is enough — skip the star."** Promoting one urgent card then means rearranging a column, and losing the arrangement you had. The star is cheap precisely because it does not disturb the order underneath it.

**"Just sort by complexity, or by age — users will adapt."** They already have not: they reorder columns expecting it to matter, which is the report that started this. An interface that silently discards a deliberate gesture teaches users that the board is decorative.

## Proposed Changes

1. **Add a priority flag** to `plans`, additive and defaulted, per the V60 migration pattern.
2. **Add a general per-column order field**, leaving `queue_position` to STAGING.
3. **Add the star control** to the card — one click, no confirm gate.
4. **Widen the drop handler's reorder branch** beyond STAGING, keeping the drop-position insertion index and the mixed-drag losslessness rule.
5. **Write one precedence resolver** — starred → column manual order → oldest — and route every consumer through it.
6. **Repoint `_distributePlannerDispatch`** at the resolver instead of its own oldest-first sort.
7. **Make the star yield to dependency/stage order** in STAGING, with a stated reason rather than a silent reorder.
8. **Surface the starred count** so a degenerate all-starred board is visible.

### Migration

Two additive columns; existing cards read as unstarred and unarranged, and NULL sorts last per the V60 precedent. No behaviour change until a user stars or drags.

## Verification Plan

### Goal Invariants

- A starred card is picked before any unstarred one, in every consumer.
- A manually arranged column is consumed in its visible order.
- A card never has two competing orders.
- A star never reorders a dependency-sequenced stream.

### Automated Tests

- **The arrangement on screen is the arrangement consumed:** arrange a non-STAGING column newest-first, then run each consumer; assert the visible order. This fails today for every consumer, which is the point.
- **The star wins across all three consumers:** star the last card in a column; assert the batch send, the schedule selector and the planner fan-out all pick it first. Testing one surface passes a partial rollout, which is the worst outcome.
- **One resolver, not three:** assert each consumer calls the shared resolver rather than sorting locally — a structural test, since duplicated sorts pass behavioural tests right up until one drifts.
- **STAGING keeps `queue_position`:** assert a drag inside STAGING still writes `queue_position` and that the new field is untouched there.
- **The star yields to stage order:** star a stage-2 card whose stage-1 predecessor is incomplete; assert it is not dispatched ahead of it, and that the refusal states why.
- **Mixed drags stay lossless in every column pair:** drag a mixed selection between two non-STAGING columns; assert nothing is silently dropped — the documented failure this widening could reintroduce.
- **Unarranged and unstarred is unchanged:** assert a board where nobody has starred or dragged behaves exactly as today, ordering by age with NULLs last.
- **Cross-column drop position is honoured:** drag a card to the top of another column; assert it lands first, not last.

### Manual Verification

- Arrange a column, star one card lower down, batch-send, and confirm the star goes first and the rest follow the visible order.

## Outstanding Questions

- **[user]** Should the star be a single level, or ranked (e.g. one gold card that always wins, plus ordinary stars)? A single level is simpler and recommended; ranking only earns its place if starring everything turns out to be the common failure.
