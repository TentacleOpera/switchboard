# The Dispatch-Stall Nudge Times Cards Nobody Is Working

## Goal

Make the dispatch-stall backstop measure the thing it claims to measure: how long a seat has been
holding work without reporting back. Today it measures how long ago a card's row was last touched by
a dispatch *call* — which, for a feature, is the instant the feature was handed to the lead. Cards
that have never been started therefore accumulate elapsed time and nudge on it, and the nudge that
results is both wrong and self-sustaining.

### Problem Analysis

**Observed 2026-09-15**, feature *Agent Control becomes its own panel* (`2b621be1`), dispatched to
the `Coding` lead at 03:01:28. Over the following hour the operator received a dispatch-stall nudge
roughly every 2–3 minutes while the feature was progressing normally — two subtasks completed inside
that window. Three defects compound to produce it.

#### 1. One dispatch call stamps every card in its list

The dispatch verb takes a *list* of cards and one target seat, delivers **one** prompt to that seat,
then loops the list and stamps `dispatched_at = now, dispatched_terminal = <seat>` on every row
(`src/standalone/bootstrap.ts:3614`, and the tmux twin at `:3524`, both via
`updateDispatchInfoByPlanFile`, `KanbanDatabase.ts:13988`).

Dispatching the feature sent the feature card *and* three subtask rows as one call. All four were
stamped 7 ms apart:

```
2b621be1  Agent Control becomes its own panel  (feature)  → Coding          03:01:28.473Z
02aa2bd1  Retire the agent tabs from kanban.html          → Coding          03:01:28.478Z
c4475ad5  Surface a Build Target in Agent Control         → Coding          03:01:28.479Z
00e0d1f0  The Agent Control Surface Cannot Be Configured  → Coding          03:01:28.480Z
```

One prompt was delivered. The lead was told "here is a feature, work through its subtasks." It was
not given three subtasks to work. Those three rows nonetheless claim a seat is working them, and the
sweep's predicate (`PlanIngestionEngine.ts:2518`) accepts them, so `now - dispatched_at`
(`:2585`) becomes *feature age* rather than time-on-task.

Contrast the real hand-offs on the same feature, which carry honest, distinct stamps:

```
1e9a9b79  Extract Agent Control into its own panel  → Coding-coder-1   completed 03:49:51Z (worked 45m)
6b9d97ce  Add an Orders tab to Agent Control        → Coding-coder-2   dispatched 03:50:01Z, completed 04:13:26Z (worked 18m)
02aa2bd1  Retire the agent tabs from kanban.html    → Coding-intern    dispatched 04:13:33Z
```

`plan_events` records the false nudge directly. Event `12087`, at 03:40:43:

> Dispatch stall — card `6b9d97ce` held by seat 'Coding' has been dispatched for 39 min with no
> completion posted (seat is live).

`6b9d97ce` was not handed to `Coding-coder-2` until **03:50:01**, ten minutes *after* that nudge. The
work had not started. The 39 minutes is the age of the feature dispatch.

#### 2. Elapsed time is treated as evidence of a stall; silence is not consulted

The predicate is elapsed-time only. A seat streaming output is not a stalled seat, but the holder's
liveness is never checked as a gate — `lastDataAt` is read only for the re-arm comparison
(`:2618-2630`), and the mid-turn guard at `:2655` deliberately gates on the *lead's* silence, not the
holder's.

Consequence, from the same run: `Coding-coder-1` legitimately worked subtask 1 for 45 minutes
(`turn_end` event `12091`: *"worked 45m"*). It was nudged twice during that work — events `12083` at
31 min and `12089` at 43 min — while actively producing output. With `dispatchStallMs` defaulting to
30 min (`:605`) and real subtasks routinely exceeding it, elapsed-time-alone is a false-positive
generator even when the stamp is correct.

#### 3. Pacing is keyed per card, so N cards defeat the floor — and the nudge re-arms itself

Pacing state is keyed `${folder}:${planId}` (`:2583`), so the 10-minute `nudgeSilenceMs` floor
(`:598`) is per card. Four stale-stamped cards means four independent timers. Gate 8
(`notifiedSeatsThisTick`, `:2666`) permits only one delivery per tick, so instead of a burst they
spread across successive ticks — one nudge every ~2.5 minutes. The more cards a lead holds, the
faster the operator is paged.

The re-arm check makes it permanent. It re-arms when `livenessByName.get(seatName)` shows new output,
where `seatName` is the card's `dispatched_terminal` — here `Coding`. The head of `team_Coding` is
**also** `Coding`, so the sweep re-arms on the output of the very seat it nudges. Every reply the
lead makes advances `lastDataAt`, the card re-arms, the floor elapses, it fires again. The answer to
the nudge is what keeps the nudge alive.

#### 3b. The same phantom stamps drive a *second* nudge source (found during review)

`_runMemberCompletionReminderSweep` (`PlanIngestionEngine.ts:2108`) reads the same rows:
`dispatchedAt && !completedAt && dispatchedTerminal !== ''`, and its roster includes team heads. Its
dedupe state `_memberReminderState` is already keyed **per seat** (`${folder}:${seatName}`,
`:2260`) with a bounded budget — but the budget is invalidated by a *different* `dispatchedAt`
string (`:2263`, `state.dispatchedAt !== cardDispatchedAt` → drop the state). Four stamps 7 ms apart
are four different strings, so each tick's card rotation discards the previous card's budget and the
seat is reminded again. Change A removes this as a side effect; Changes B–D do **not**. It is named
here so "the drumbeat is still there" is not reported as a regression of this work.

### Root Cause

> **Superseded:** `dispatched_at` answers *"was this row in the list of a dispatch call"*. The sweep
> reads it as *"a seat is working this card"*.
> **Reason:** True but incomplete, and the incompleteness is what makes Change A look free. The
> column is not merely mis-written — it is **overloaded**, and the audit below shows that every other
> reader wants the meaning the sweep does *not* want. `updateDispatchInfoByPlanFile`'s own docblock
> (`KanbanDatabase.ts:14005`) states the split explicitly: *"For feature cards, the working flag is
> derived from subtasks' `dispatched_at` values, but we still write/clear the feature row's own
> `dispatched_at` for dispatch-identity."* Narrowing the write therefore does not just make the sweep
> honest; it also changes what other readers see, so each one must be walked. (Audited this pass:
> none of them regresses behaviourally — the only affected reader is the feature card's CSS class.)
> **Replaced with:** the statement below.

`dispatched_at` carries **two meanings at once**:

1. **Custody** — "this row is in some seat's hands" (the activity light, the in-flight pin, the
   `!dispatchedAt` queueable filter, `attributePlansToTerminals`, the dispatch-timeout release);
2. **Time-on-task** — "a seat was asked to work *this* card at this instant" (the dispatch-stall
   sweep, `_runMemberCompletionReminderSweep` gate 5b).

The dispatch verb writes meaning 1 for every row in its list. The stall sweep reads meaning 2. For a
single-card dispatch the two coincide, which is why this was never noticed; for a feature dispatch
they diverge by hours.

The layering the code intends is already correct and documented: `_runFeatureNudgeSweep`
(`:1178-1205`) owns the lead-level case — it fires when the head has gone idle *with no coder active*
— and `_runDispatchStallSweep` is the per-hand-off backstop for "a coder finished and never posted
its report". The dispatch-stall docblock asserts the two "do not double-wake". They do, because the
feature card and its un-handed subtasks are sitting in the dispatch-stall predicate.

## Metadata

**Complexity:** 5
**Tags:** bugfix, reliability, backend

> **Superseded:** **Tags:** bugfix, reliability, agents, backstop
> **Reason:** `agents` and `backstop` are not in the allowed tag vocabulary; invented tags are
> dropped or mis-filed by the importer.
> **Replaced with:** `bugfix, reliability, backend`.

**Complexity stays 5.** An improve pass raised it to 6 on the strength of the feature working-light
finding; that was withdrawn on review. The light is a **presentation** path — every consumer of
`card.working` is a CSS class (`kanban.html:7573`, `terminals.js:8587`) or a dirty-check hash, and
nothing branches behaviour on it. A cosmetic regression does not move the score. The reader audit
below is retained because it is useful, not because it found a behavioural break; it found none.

## Host Scope

The sweep is in `PlanIngestionEngine`, shared code wired by both composition roots
(`extension.ts:1151`, `bootstrap.ts:4330` — both call `setTurnEndNotifier`, verified), so Changes
B–D land in both hosts by construction and need no per-root wiring. Change A is in the standalone
dispatch verb (`bootstrap.ts`). **The extension host is out
of scope** per the cutover rule — its dispatch path (`KanbanProvider._recordDispatchIdentity`,
`:3937`, called per-`sessionId` in loops at `:12055` and `:12081`) has the same over-stamping shape
and is deliberately left alone rather than carrying a second, doomed implementation.

## User Review Required

- **`dispatchStallMs` stays at 30 minutes — settled 2026-09-15.** A nudge about work that is merely
  long is cheap; the defect is nudges about work nobody is doing, which Changes A–D remove. Do not
  tune the threshold as part of this work. It becomes largely irrelevant under the forward path
  below, where the verdict comes from terminal content rather than from a clock.
- **Whether the feature card itself should ever carry a dispatch stamp.** Change A keeps it, and that
  is load-bearing in a way the original plan did not record: the feature card's own stamp is what
  keeps a lead that takes a feature and hands out *nothing* inside the stall predicate. See
  Edge-Case 5.
- **Accepted consequence: a lead stalled on its own card is nudged once, not repeatedly.** Change D
  removes the only re-arm signal available when the addressee *is* the holder. The bounded end state
  is `_runDispatchTimeoutSweep` at `dispatchTimeoutMs` (default 4 h). This matches the precedent
  already set twice in this file (`_memberReminderState`, `_runQueueNudgeSweep`'s *"One nudge, then
  stop"*). If the operator wants a repeating page for that case, it is a separate card.

## Settled Design

**The clock belongs to the hand-off, not to the batch.** A card's `dispatched_at` is set only when
that card is what a seat was actually asked to work. A feature handed to a lead stamps the feature
card and nothing else; each subtask is stamped when the lead hands it out.

**A stall requires silence, not just elapsed time.** A seat producing output is working, by
definition. Elapsed time alone is the wrong predicate and always was.

**One clock per seat.** Pacing and delivery key on the seat being written to, so holding more cards
cannot page the operator faster.

**Custody is recorded, never erased.** Narrowing the stamp must not turn "held by the lead" into
"held by nobody". Change A writes the custody row and clears only the *clock* — see Change A.

## Complexity Audit

### Routine

- Narrowing the stamping loop to the delivered record (`bootstrap.ts:3614`, `:3524`).
- Adding a holder-silence condition to the predicate.
- Re-keying `_dispatchStallState` from `planId` to seat.

### Complex / Risky

- **`dispatched_at` has other readers, and one of them breaks.** Audited during this pass; the real
  list is below. This is the bulk of the work and the reason the complexity is 6.

  > **Superseded:** "The activity light, `attributePlansToTerminals`, the fleet projection
  > (`goPtyFleetProjection.ts:945`) and `_runDispatchTimeoutSweep` (`:2813`) all read it."
  > **Reason:** `goPtyFleetProjection.ts:945` is a **comment** about the activity-light basis, not a
  > reader — that file contains no `dispatchedAt` reference at all. Auditing it wastes the
  > implementer's time and, worse, the list omitted the one reader that actually regresses.
  > **Replaced with:** the enumerated list below.

  | Reader | Location | Effect of Change A |
  | :-- | :-- | :-- |
  | Feature working rollup (`getFeatureWorkingStates`) | `KanbanDatabase.ts:9086-9134`, applied at `KanbanProvider.ts:2332` | **Cosmetic only.** `WHERE ... is_feature = 0`: a feature card's light is `MAX(anyWorking)` over its **subtasks only** — a feature row's own `dispatchedAt` is never consulted. So between the feature dispatch and the first hand-off the feature card renders dark (45 min in the incident) while the lead drives it. Nothing branches on the flag; it is a CSS class. Optional polish, not a gate — see Change A's edge cases. |
  | Card activity light (`isWorkingState`) | `KanbanProvider.ts:180-190` | Per-card derive from that card's own stamp. Feature card unaffected (still stamped). Subtask cards go dark until handed out — **intended**: nobody is working them. |
  | `getLiveDispatchAttribution` → `attributePlansToTerminals` | `KanbanDatabase.ts:14804-14814`, `terminalPlanAttribution.ts:40` | Query filters `dispatched_at IS NOT NULL`, so a custody row with a NULL clock is invisible here. The lead's fleet-list title becomes the **feature**, not an arbitrary subtask — an improvement, but assert it. |
  | `_readBoardWithDispatchStamps` | `PlanIngestionEngine.ts:2448` | Hydrates from the same attribution query, so un-handed subtasks carry no stamp in any sweep. This is the mechanism of the fix. |
  | `_runDispatchTimeoutSweep` | `:2813` | See the next bullet. |
  | `_runMemberCompletionReminderSweep` | `:2108` | Loses the phantom rows. Fixes defect 3b as a side effect. |
  | In-progress / queueable filters (`!p.dispatchedAt`) | `LocalApiServer.ts:1262`, `:3979`, `:7420`; contract in `kanbanOrdering.ts:49` | `isQueueable` also requires `(!p.featureId \|\| p.featureId === '')`, so feature subtasks were **already** excluded from the STAGING queue pop. No double-grab is introduced. Assert this rather than assume it. |
  | In-flight pin SQL (`hasInFlight`) | `KanbanDatabase.ts:4737`, `:6176` | An un-handed subtask stops counting as in-flight. Correct, but it changes retention/pinning behaviour for feature subtasks — cover it in verification. |
  | `isStaleCompletedAt` | `LocalApiServer.ts:4508` | Compares `completedAt < dispatchedAt`. With no subtask stamp there is nothing to compare, so a stale completion is no longer detected on an un-handed subtask. An un-handed subtask has no completion to be stale. No action. |
  | Seat-moved check (`shouldClear`) | `LocalApiServer.ts:3972-3990` | `dispatchedTerminal === seat && (dispatchedAt \|\| !completedAt)`. With a custody row still carrying `dispatched_terminal`, behaviour is unchanged for the `!completedAt` arm. No action. |

- **`_runDispatchTimeoutSweep` shares the stamp and the ordering invariant**
  (`dispatchStallMs < dispatchTimeoutMs`, `:617`). It releases seats on cards stamped longer than
  `dispatchTimeoutMs` ago. Today it is releasing *phantom* holds created by batch stamping; after
  Change A it will not see them. That is the correct outcome but it changes that sweep's behaviour,
  so it is in scope for verification even though no line of it changes. **New:** after Change A the
  feature card is the *only* row carrying the lead's hold, so that sweep's 4-hour release of the
  feature card now drops the lead's attribution entirely instead of leaving three subtask rows
  behind. A feature legitimately longer than 4 h loses its holder. Unchanged by this work in
  mechanism, materially louder in effect — record it, do not fix it here.

- **Three pinned source-text assertions constrain how Changes B–D may be written.**
  `src/test/terminal-plan-attribution-contract.test.js:376-400` slices
  `PlanIngestionEngine.ts` between `private async _runDispatchStallSweep(` and
  `private async _retryPendingFeatureLinks(` and greps that slice:
  - `assert.ok(!/p\.dispatchedTerminal/.test(dispatchStallSweep))` — Change B must **not** introduce
    the holder-silence gate inside a `board.filter(p => ...)`. Keep the predicate as-is and put the
    gate in the per-card loop, which uses `card.dispatchedTerminal`.
  - `includes('lastObservedMtime') && includes('lastObservedSeatOutputAt')` — Change C may re-key
    `_dispatchStallState` but must keep those two field names.
  - `includes('dispatchStallMs')`, `includes('nowMs - dispatchedAtMs')`, `includes('p.dispatchedAt')
    && includes('!p.completedAt')` — the extracted stall-verdict resolver (the Addition) must be
    declared **between** `_runDispatchStallSweep` and `_retryPendingFeatureLinks` (next to
    `_pruneDispatchStallState` and `_runDispatchTimeoutSweep`, which already live in that slice), or
    the elapsed-comparison assertions fail. Alternatively update the test — but the assertion is the
    only thing pinning the predicate's shape, so moving it is a decision, not a chore.

## Edge-Case & Dependency Audit

### Race Conditions

- **Stamp-then-deliver ordering is unchanged.** Both stamping loops run *after* the delivery receipt
  is checked (`bootstrap.ts:3585-3612`), so a failed delivery still stamps nothing. Change A must not
  move the loop above that check.
- **Tick re-entrancy.** `_dispatchStallState` is process-global and the sweep runs once per workspace
  folder per tick. Re-keying to seat (Change C) keeps the `${folder}:` prefix, so two folders sweeping
  in the same tick still cannot collide (see item 4 below).
- **Liveness is a cached snapshot.** `getFleetLiveness()` is refreshed opportunistically off whatever
  forwards `ptyListTerminals` (`PlanIngestionEngine.ts:2234-2240` records the measurement). Change B
  therefore inherits the same staleness the member sweep's gate 5b was written to survive: a holder
  that has produced nothing at all since its own `dispatched_at` must be treated as **not yet
  evidenced**, not as silent — see Change B's rule 3.

### Security

- Nothing on this path reads terminal content or accepts agent-supplied input. The forward path does;
  its design note is preserved below.

### Side Effects

1. **The feature's working light.** The original resolution here was wrong and is superseded.

   > **Superseded:** "If the feature card's stamp is what lights the feature as in-flight, Change A
   > darkens it. Resolve by reading the light from the feature's subtasks (any subtask dispatched ⇒
   > feature active), not by restoring the stamp."
   > **Reason:** Reading the light from the subtasks is **already what the code does** —
   > `getFeatureWorkingStates` (`KanbanDatabase.ts:9086`) selects `WHERE ... is_feature = 0` and
   > rolls up `MAX(dispatched_at IS NOT NULL AND ...)`. So the proposed resolution is the status quo,
   > and the status quo is exactly what Change A breaks: with no subtask stamped between the feature
   > dispatch and the first hand-off, the rollup returns `working = false`. In the incident that
   > window was 45 minutes, during which the operator sees the feature dark while the lead is
   > actively driving it.
   > **Replaced with:** nothing is required. The flag is **presentation** — its only consumers are
   > `applyWorkingClass` (`kanban.html:7573`) and an `is-working` row class (`terminals.js:8587`);
   > no code path branches on it. Per this repo's rule, a wrong value here does not silently change
   > behaviour, so this is a cosmetic regression, not a blocker. **Optional polish, if the dark card
   > annoys the operator:** drop `AND is_feature = 0` from both arms of `getFeatureWorkingStates`
   > and group on `CASE WHEN is_feature = 1 THEN plan_id ELSE feature_id END`, so a feature's own
   > live stamp counts toward its own rollup. Apply it to both the pre-V74 and post-V74 arms or not
   > at all.

2. **A lead that codes a card itself.** `dispatched_terminal` equals the team head legitimately.
   Change D must suppress re-arm only when the addressee *is* the holder **and** the card is not the
   one the holder was asked to work — otherwise a lead genuinely stuck on its own card goes unnudged.
   Simpler and safer: never count the addressee's output as progress, and rely on the holder-silence
   gate (Change B) to keep a working lead quiet. The cost is stated and accepted under *User Review
   Required*: one nudge, then the 4-hour timeout.

3. **Seat renamed or destroyed mid-flight.** Keying pacing on seat name means a rename orphans the
   entry. Orphans are pruned by the existing folder-scoped prune (`_pruneDispatchStallState`,
   `:2762`), which must be re-keyed alongside the state map — its `stillStalled` set currently holds
   **planIds** and would delete every live seat entry on the first tick after Change C if left alone.

4. **A seat holding cards in two workspace folders.** The sweep runs once per folder and the state
   map is process-global. Seat keys must stay `${folder}:${seat}` — an unscoped seat key collides
   across folders and silently halves the nudge rate.

5. **Un-handed subtasks must arm nothing.** After Change A, `c4475ad5` and `00e0d1f0` carry no clock
   and are invisible to this sweep. That is intended: a subtask queued behind strict ordering is not
   stalled.

   > **Superseded:** "...and the feature sweep covers the case where the lead stops handing work out."
   > **Reason:** `_runFeatureNudgeSweep` only fires for **armed** watches (`kanban.featureWatches`),
   > and the sibling plan *Nothing Arms a Stall Watch* (`8473d350`) exists because that list is armed
   > by nothing on a feature dispatch today. Leaning on it would have made this plan's coverage
   > depend on unlanded work — and made the gap invisible, because the sweep reads an empty list
   > without erroring.
   > **Replaced with:** the coverage comes from the **feature card's own stamp**, which Change A
   > deliberately keeps. A lead that takes a feature and hands out nothing still has `2b621be1`
   > stamped to it; that row stays in the dispatch-stall predicate, the holder is the lead, and when
   > the lead goes quiet past `nudgeSilenceMs` the nudge fires with the addressee resolved to the
   > head of `Coding`'s team — which is `Coding` itself (the roster build at `:2540-2555` includes
   > heads deliberately: *"a head holding a dispatched card is a valid addressee for its own
   > nudge"*). No dependency on `8473d350`. This is why "should the feature card carry a stamp" is
   > listed under *User Review Required* and why the answer is yes.

6. **An unattributed card has no holder to gate on.** `dispatched_terminal` is `''` for every pre-V57
   row and for any dispatch path that passed no name. Change B cannot ask a nonexistent seat whether
   it is silent. The gate is **skipped**, the existing operator path is preserved, and the verdict
   records `source: 'elapsed-no-holder'` so an operator-path nudge is never mistaken for a
   holder-silence verdict. Change C must likewise not collapse every unattributed card into one
   `${folder}:` key — see Change C's keying rule.

7. **A holder that is absent from liveness entirely** (exited, destroyed, never registered) reads as
   infinitely silent under a naive `nowMs - lastDataAt` test. That verdict is correct — a dead holder
   is definitely not working — but it must be **stated**, not arrived at by `undefined` arithmetic.
   Change B branches on it explicitly and tags `source: 'holder-absent'`.

### Dependencies & Conflicts

- **No blocking dependency on `8473d350`** (*Nothing Arms a Stall Watch*) — see Edge-Case 5. The two
  plans touch the same file and will conflict textually in `_runFeatureNudgeSweep`'s neighbourhood;
  whichever lands second rebases. `8473d350` also records (`:127`) that *"the dispatch-stall sweep
  was over-firing, not absent"*, which is this card.
- **`f877e48a`** (*A working agent's card goes dark after ten minutes*) touches the activity-light
  age basis, the same expression the optional feature-light polish under Edge-Case 1 would edit.
  Coordinate, do not serialise.
- **`a2eb60fa`** (*Terminal Buffer Snapshot API*, under feature `902c8bd3`) is the consumer of the
  resolver seam added here. Not a dependency — this plan ships without it.

## Dependencies

- None. No prior session's output is required; the two board cards named above are adjacent, not
  blocking.

## Adversarial Synthesis

**Key risks.** (1) "Stamp only the delivered record" is not a rule until it says *which* record;
mitigated by deriving it from `partitionPlansByFeature`, the same function that decided the prompt's
shape, so the stamp and the prompt cannot disagree. (2) Three pinned source-text assertions in
`terminal-plan-attribution-contract.test.js` constrain where the new gate and the extracted resolver
may physically be written; mitigated by naming the exact placement. (3) The reader audit of
`dispatched_at` found **no** behavioural regression — the one candidate, the feature working light,
is a CSS class. Rejected alternatives and the reasoning behind them are below.

**"Just group the nudges per lead."** Rejected. It was the first idea and it is wrong: under a
correct hand-off stamp at most one card per coder is in flight, so each nudge already names a
distinct stuck seat, and collapsing them destroys the attribution that makes the nudge actionable —
one coder stuck behind another coder working reads as a single vague "the team is holding 2 cards".

**"Detect batch stamps at read time."** Rejected. Distinguishing a batch stamp from a hand-off after
the fact means matching on same-seat-and-timestamps-milliseconds-apart, which is a guess dressed as a
rule. The write is simply wrong; fix the write and there is nothing to detect.

**"Raise the threshold and leave the rest."** Rejected as a complete fix, accepted as a companion.
A longer threshold delays the false nudge about `c4475ad5` without making it true, and does nothing
about the self-re-arming loop.

**"Ship Changes B and D only; leave the write alone."** *(Added this pass.)* Rejected as the end
state, but worth recording because it is genuinely tempting: in the observed incident every phantom
row is held by `Coding`, a live lead, so the holder-silence gate alone suppresses **every** nudge in
the transcript, with zero reader risk and no migration. It is rejected because it only holds while
the lead is talking. The moment a lead legitimately goes quiet waiting on its coders, all four rows
report "stalled for 90 minutes" with feature age, and the operator is paged four times about one
idle lead. B+D treats the symptom; A treats the lie. It remains the correct **first commit** if this
work is split (see the note under *Proposed Changes*).

**"Add a second column instead of narrowing the first."** *(Added this pass.)* Rejected, recorded as
the fallback. Keep `dispatched_at` as custody (stamp every row, unchanged) and add
`plan_runtime_state.handed_off_at`, stamped only on the record the seat was asked to execute; the
stall sweep reads the new column. This is strictly lower-risk — no reader changes behaviour, the
feature light is untouched, the queue and in-flight filters are untouched — at the cost of one
migration and a second timestamp that every future writer must remember to set. It is rejected
because a second timestamp nobody remembers to write is the same class of silent-wrong-answer this
plan exists to remove, and because the audit found **no** reader whose behaviour regresses — only the
feature card's CSS class. **If implementation turns up a reader that changes behaviour rather than
appearance, stop and take this path instead** — that is the trigger, stated in advance.

## Proposed Changes

*If this work is split, the commit boundary is: **(1) B + D** — stop the false nudges, no schema or
reader risk; **(2) A + C + the resolver seam** — fix the stamp's meaning and re-key. Each half
is independently shippable and independently verifiable.*

### Change A — stamp the clock only on the card that was dispatched

`src/standalone/bootstrap.ts`, both stamping loops (`:3524` tmux, `:3614` pty).

**Context.** `records` is a flat list of `KanbanPlanRecord`s built at `:3290-3299` from
`sessionIds`/`planFile`. `generateUnifiedPrompt` (`KanbanProvider.ts:6810`) partitions that same list
with `partitionPlansByFeature` and, when there is at least one feature group, builds a **FEATURE
MODE** prompt in which the lead is told to allocate the subtasks, not to work them. `bootstrap.ts`
already calls `partitionPlansByFeature(records)` on raw records at `:3447`, so the pattern of running
it over `KanbanPlanRecord`s (rather than `BatchPromptPlan`s) is established and compiles.

**Logic.** A subtask that belongs to a feature group *in this same dispatch* is held, not worked. Its
custody is recorded on its own row; its **clock** lives on the feature row. Every other record —
including the loose plans of a batch-to-a-team-head — keeps today's behaviour, because for a loose
batch there is no parent row for custody to live on, and Change B is what suppresses the false nudge
there.

**Implementation.**

```ts
// The seat was asked to EXECUTE some of these records and merely HOLDS the rest.
// Derived from the same partition generateUnifiedPrompt uses to shape the prompt,
// so the stamp and the prompt cannot disagree about what was asked for.
const { featureGroups } = partitionPlansByFeature(records as any);
const heldNotWorked = new Set<string>();
for (const g of featureGroups) {
    for (const s of g.subtasks) {
        const id = (s as any).planId || (s as any).sessionId;
        if (id) { heldNotWorked.add(String(id)); }
    }
}

for (const rec of records) {
    if (!rec.planFile) { continue; }
    const held = !!rec.planId && heldNotWorked.has(String(rec.planId));
    try {
        await db.updateDispatchInfoByPlanFile(rec.planFile, rec.workspaceId || workspaceId, {
            routedTo: targetColumn || rec.kanbanColumn || '',
            dispatchedAgent: targetRole,
            dispatchedIde: PTY_IDE_NAME,          // TMUX_IDE_NAME in the tmux loop
            dispatchedTerminal: terminal.friendlyName,
            // Custody is recorded for every record; the CLOCK is stamped only on the
            // record the prompt asked the seat to work. `null` here is explicit, not
            // a default — a held subtask is distinguishable from a worked one at the
            // write, and any stale clock from a previous dispatch is cleared.
            dispatchedAt: held ? null : undefined,   // undefined = now (today's behaviour)
        });
        if (rec.planId) { await db.clearCompletedAt?.(rec.planId); }
    } catch (err) {
        console.warn('[bootstrap] Failed to update dispatch info:', err);
    }
}
```

`updateDispatchInfoByPlanFile` (`KanbanDatabase.ts:13988`) gains an optional
`dispatchedAt?: string | null` on its `info` argument: `undefined` ⇒ `now` (today's behaviour,
unchanged for every existing caller), `null` ⇒ write SQL `NULL`. Both the shared-tier `UPDATE`
(`:14012`) and the `plan_runtime_state` upsert (`:14036`) take the value. `completed_at = NULL`
continues to be written in both branches, so a re-dispatched feature's subtasks still lose a stale
completion — and the explicit `clearCompletedAt(rec.planId)` in the loop is retained as the belt to
that braces.

**Edge cases.** The feature card renders dark on the board between the dispatch and the first
hand-off, because a feature row's light is rolled up from its subtasks and ignores its own stamp
(`KanbanProvider.ts:2332`). This is presentation only — no behaviour reads the flag — and is left
as-is; the optional one-query polish is written out under Edge-Case 1 if it proves irritating in use.
`getLiveDispatchAttribution` filters `dispatched_at IS NOT NULL` (`:14807`,
`:14813`), so a custody row is invisible to `attributePlansToTerminals` and to
`_readBoardWithDispatchStamps`. The custody record survives durably in
`plan_runtime_state.dispatched_terminal` for forensics — no current reader surfaces it, and that is
stated here rather than discovered later. Records with no `planId` are never in `heldNotWorked` and
keep today's behaviour. A dispatch containing subtasks whose feature card is **not** in the same
selection produces no feature group (they land in `loosePlans`), so those subtasks are stamped
normally — correct, because with no feature card present the seat really was handed those cards.

### Change B — a stall requires the holder to be quiet

`src/services/PlanIngestionEngine.ts`, inside `_runDispatchStallSweep`'s per-card loop, **after** the
`elapsed < dispatchStallMs` early-continue at `:2586` and **before** the re-arm check at `:2615`.
Written against `card.dispatchedTerminal`, never `p.dispatchedTerminal` — see the pinned assertion
noted in the Complexity Audit.

**Logic.** Three branches, each producing a tagged verdict rather than a bare boolean:

1. **No holder** (`seatName === ''`) — nothing to ask. Do not gate; fall through to the existing
   operator path. `source: 'elapsed-no-holder'`.
2. **Holder absent from liveness, or `status === 'exited'`** — a dead holder is not working. Stall
   confirmed. `source: 'holder-absent'`.
3. **Holder live** — require `holderLive.lastDataAt > 0` and
   `nowMs - holderLive.lastDataAt >= nudgeSilenceMs`. A `lastDataAt` of `0` or less is **no
   evidence** and suppresses, matching every other gate in this file (`:2657`). Additionally require
   `holderLive.lastDataAt > dispatchedAtMs` — a holder that has produced nothing since its own
   dispatch is booting or wedged before first output, and the cached-snapshot measurement recorded at
   `:2234-2240` shows that stamp can be arbitrarily stale. `source: 'holder-silent'`.

This is the change that would have suppressed both false nudges at coder-1 (events `12083`, `12089`)
even with the old stamp.

**Edge cases.** `nudgeSilenceMs` is reused deliberately rather than introducing a fourth threshold —
it is already the "this seat has genuinely gone quiet" window everywhere else in the file. A holder
whose team head is a *different* seat is unaffected by gate 7 (the mid-turn guard, which gates on the
**addressee**); the two gates now ask about two different seats on purpose, and the docblock must say
so or the next reader will "simplify" one into the other.

### Change C — one clock per seat

**Keying.** `_dispatchStallState` moves from `${folder}:${planId}` to `${folder}:seat:${seat}` for
attributed cards, and stays per-card as `${folder}:card:${planId}` for unattributed ones (edge-case
6) — an empty seat is not a seat, and collapsing every unattributed card onto `${folder}:seat:` would
silently merge unrelated stalls into one operator notice. The explicit `seat:`/`card:` discriminator
also makes the two key spaces non-colliding, which a bare `${folder}:${x}` does not guarantee.

**State shape.** Keep the field names `lastNudgedAt`, `lastObservedMtime`, `lastObservedSeatOutputAt`
(pinned by the contract test). Under a seat key, `lastObservedMtime` becomes the **maximum** mtime
across that seat's currently-stalled cards — stated explicitly in the docblock, because "whose file?"
is otherwise unanswerable and a silently-picked first card is exactly the quiet-wrong-answer shape
this repo bans. Any card's file advancing is progress by that seat; that is the intended meaning.

**Loop shape.** Group `stalledCards` by resolved key first, then run gates 5–9 once per group.
`_pruneDispatchStallState` (`:2762`) must be re-keyed in the same commit: its `stillStalled` set
currently holds planIds and would delete every live seat entry on the first tick otherwise.

**Delivery.** `TurnEndInfo.planFile` is singular (`:87`). When a group has several stalled cards,
send the **oldest** card's `planFile` as the anchor and name all of them in `body`
(`card '<a>', '<b>' (2 cards)`), so the host's parent resolution still has a real file to work with.
Do not invent a synthetic path.

### Change D — never re-arm on the addressee's own output

The re-arm comparison (`:2624-2630`) must exclude output produced by the seat being notified: when
`seatName === addressee`, `seatProduced` is forced `false` and only `mtimeAdvanced` can re-arm. A
nudge whose own reply re-arms it is a metronome, not a backstop. This is the same conclusion
`_memberReminderState` reached (`:435-455`: *"an 'advanced since last reminder' test re-arms on the
reminder's own consequence and nags every `nudgeSilenceMs` forever"*) and that `_runQueueNudgeSweep`
reached more bluntly (*"One nudge, then stop"*). Cite both in the docblock so the next reader does
not re-derive it a fourth time.

**Belt and braces.** Also carry a `nudgeCount` in the per-key state and stop at
`MAX_DISPATCH_STALL_NUDGES_PER_DISPATCH = 2`, re-armed only by a **new** `dispatched_at` on the
anchor card — the one signal a nudge cannot manufacture for itself. The pinned assertion
`!/nudgeCount\s*[><=]/.test(slice) || slice.includes('_dispatchStallState')` permits this, because
the count lives in `_dispatchStallState` and not in a watch registry.

### Addition — make the verdict a seam, not an inlined predicate

The stall decision is currently a boolean computed inline in the sweep. Extract it to a resolver
taking `(seat, card, evidence)` and returning `{ stalled, source }`, with the timestamp heuristic as
the first implementation. Two reasons this must land now rather than later:

1. Without the seam, the judge gets added by editing the predicate in place, and the heuristic and
   the model become one tangled condition.
2. `source` is required by the fallback rule — a nudge must say whether a clock or a model decided
   it. A model verdict and a 30-minute timeout must never be indistinguishable in the log or in the
   nudge text, or "the judge is misfiring" and "the threshold is too short" become the same bug
   report.

**Placement.** Declare the resolver as a private method **between** `_runDispatchStallSweep` and
`_retryPendingFeatureLinks` (alongside `_pruneDispatchStallState` and `_runDispatchTimeoutSweep`).
The contract test slices exactly that range and asserts the elapsed comparison lives inside it;
declaring the resolver above the sweep moves `nowMs - dispatchedAtMs` out of the slice and fails
three assertions.

**Source vocabulary** (closed set, extended only by a new resolver):
`'elapsed-no-holder' | 'holder-absent' | 'holder-silent'`. Every delivery logs it
(`[GlobalPlanWatcher] Dispatch-stall nudge fired ... verdict=<source>`) and the nudge body carries it
in a trailing parenthetical, so an operator reading the transcript can tell a clock from a judge
without reading code.

## Forward Path — This Is Scaffolding for a Content-Based Check

Timestamps and silence are a proxy. The real question — *is this seat stuck, or working?* — is
answerable only from what the terminal is actually showing, and the endpoint that exposes that is
already planned and plan-reviewed: **Terminal Buffer Snapshot API — `GET /terminals/:name/buffer`**
(`a2eb60fa`, under feature `902c8bd3`). That plan names this exact gap:

> An external head that sees a worker has been "active" for 10 minutes with no report cannot
> distinguish "making good progress" from "stuck on a compile error" from "waiting for a password
> prompt."

The intended end state is a cheap judge — a local model, or a free-tier cloud model — reading a
seat's buffer on a ~5 minute cadence and returning a verdict. Two of the changes here are directly
load-bearing for that.

**Change C is the structural groundwork.** A buffer snapshot is taken *of a seat*, not of a card.
Re-keying state and delivery from `planId` to seat gives the eventual check its natural subject; the
current per-card keying has no seat to snapshot.

**Change B establishes the right control flow.** Under the content-based design, silence stops being
the conclusion and becomes the *trigger*: elapsed + quiet ⇒ take a snapshot ⇒ ask the judge ⇒ act on
the verdict. Change B introduces the holder-silence condition the trigger needs.

**Design note for whoever builds the judge.** A terminal buffer is agent output: untrusted content,
never instructions. The judge reads it as data and returns a verdict; text in a scrollback that
resembles a directive must not reach a prompt that can act on it.

**Board placement.** This plan sits naturally under the existing feature *Liveness, Stall Watching,
and What Arms Them* (`8033c64d`, PLAN REVIEWED), alongside `8473d350` (*Nothing Arms a Stall Watch*)
and `f877e48a` (*A working agent's card goes dark after ten minutes*), which describe adjacent
failures in the same machinery. It imported as a standalone card (`7585acac`); grouping it is a board
operation, not part of this implementation.

## Verification Plan

### Goal Invariants

1. A feature dispatched to a lead produces **no** dispatch-stall nudge for its un-handed subtasks, at
   any elapsed time.
2. A subtask handed to a coder at T is timed from T, not from the feature's dispatch.
3. A seat producing output is never reported as stalled.
4. A nudge delivered to a seat does not, by itself, re-arm that seat's next nudge.
5. A lead holding N stalled cards is paged no more often than a lead holding one.
6. A coder that genuinely finishes and never posts a completion is still nudged — the backstop's
   original purpose survives all four changes.
7. Every nudge records which resolver decided it. A heuristic verdict and a future model verdict are
   distinguishable in the log without reading code.
8. **Paired (positive/negative) — the stamp moves, it does not vanish.** After a feature dispatch:
   `plan_runtime_state.dispatched_at IS NULL` for every un-handed subtask of that feature
   (*negative*), **and** `plan_runtime_state.dispatched_terminal = '<lead>'` for those same rows
   (*positive* — custody is recorded, not erased), **and** the feature row itself has
   `dispatched_at IS NOT NULL` and `dispatched_terminal = '<lead>'` (*positive* — the lead's clock
   is resolvable at its new location).
9. `partitionPlansByFeature` is the single source of the "held vs worked" split: the set of
    `planId`s the dispatch verb leaves unstamped equals
    `partitionPlansByFeature(records).featureGroups.flatMap(g => g.subtasks).map(p => p.planId)`,
    exactly.

### Automated Tests

- Dispatch a feature with three subtasks to a lead; advance the clock past `dispatchStallMs`; assert
  zero nudges **about the subtasks**, and exactly one nudge about the **feature card** once the lead
  has been silent for `nudgeSilenceMs` (invariant 8 plus edge-case 5's corrected coverage). Hand one
  subtask to a coder; advance past the threshold with the coder silent; assert exactly one nudge,
  naming that subtask and that coder.
- Holder-silence gate: card stamped past threshold, holder emitting output every tick ⇒ no nudge;
  holder goes quiet ⇒ one nudge. Plus the three tagged branches: no holder ⇒
  `source: 'elapsed-no-holder'`; holder exited ⇒ `'holder-absent'`; holder live and quiet ⇒
  `'holder-silent'`.
- Holder with `lastDataAt <= 0`, and holder whose `lastDataAt <= dispatchedAt`: assert **no** nudge
  (no evidence is not silence).
- Self-re-arm: deliver a nudge, then advance only the addressee's `lastDataAt`; assert no second
  nudge after `nudgeSilenceMs`. Then advance the plan-file mtime and assert one further nudge, then
  assert the `MAX_DISPATCH_STALL_NUDGES_PER_DISPATCH` ceiling holds until a new `dispatched_at`.
- Multi-folder pacing: same seat name holding stalled cards in two workspace folders; assert each
  folder nudges independently and neither prunes the other's state. Add the unattributed twin: two
  unattributed stalled cards in one folder produce two operator notices, not one merged notice
  (edge-case 6).
- `_runDispatchTimeoutSweep` regression: assert it still releases a genuinely timed-out hand-off, and
  no longer releases feature-batch phantoms.
- `_runMemberCompletionReminderSweep` regression (defect 3b): a feature dispatch to a lead produces
  at most the bounded member-reminder budget for that seat, not one budget per subtask row.
- Queueability: after a feature dispatch, assert the un-handed subtasks are still excluded from the
  STAGING queue pop — they are excluded by `featureId`, not by `dispatchedAt`, and that must be
  asserted rather than assumed (`LocalApiServer` `isQueueable`).
- Contract-test reconciliation: `src/test/terminal-plan-attribution-contract.test.js` must still pass
  unmodified, or its three affected assertions must be updated **in the same commit** with the
  reasoning recorded in the test, per the file's own convention.
- **Composition-root diff.** Change A touches only the standalone dispatch verb; Changes B–D are in
  shared services already wired by both roots via `setTurnEndNotifier`. Verification asserts the
  seams each host *wires*, not the verbs each answers: confirm `extension.ts:1151` and
  `bootstrap.ts:4330` both still reach `_runDispatchStallSweep`, and that no new engine seam
  (`engine.setX(...)`) was introduced by this work.

> **Superseded:** "Replay the 2026-09-15 timeline from `plan_events` (`12078` → `12101`) as fixture
> data and assert the three nudges that fired (`12083`, `12087`, `12089`) do not."
> **Reason:** `plan_events` rows are *output* of the sweep, not input to it. The sweep's inputs are a
> board read (`_readBoardWithDispatchStamps`) and a fleet-liveness snapshot; there is no path that
> replays an event log into it, so this test as written cannot be built.
> **Replaced with:** reconstruct the incident as a **board fixture** — four rows stamped to `Coding`
> 7 ms apart at 03:01:28Z, plus a liveness snapshot in which `Coding` is live and `Coding-coder-1`
> is live and producing output — and assert that ticking the sweep at 03:31, 03:41 and 03:44 (the
> wall-clock moments of `12083`, `12087` and `12089`) delivers nothing. Keep the event ids in the
> fixture's comment as the provenance of the timings.

### Manual Verification

Run a real feature through a team seat with two coders and watch the operator transcript for the full
duration. The pass condition is the absence of the 2–3 minute drumbeat, with a nudge still arriving
if a coder is deliberately left finished-but-silent. Watch the board at the same time: the feature
card must read *working* from the moment it is dispatched, not from the first hand-off.

## Outstanding Questions

- **[user]** Should this land as one commit or two (B+D first, then A+C+seam)? — proceeding on the
  assumption that **one plan, two commits in that order** is acceptable, since each half is
  independently verifiable and the first half alone removes every nudge in the observed transcript.

## Recommendation

**Send to Coder.** Complexity 5. Change A alters what a column *means* to nine call sites, so the
reader table above must be walked rather than skimmed — but the audit is already done and found no
behavioural break. The two things that will bite an inattentive implementer are named explicitly: the
`partitionPlansByFeature`-derived stamp rule, and the three pinned source-text assertions that
constrain where the holder gate and the extracted resolver may be written.
