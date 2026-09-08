# A Dispatched Card Stops Being Outstanding Forever

kanbanColumn: CREATED

## Goal

A dispatched card that never reports reaches a bounded, named end state. The board stops claiming
work is in flight when nobody is doing it. **No retry** — that is deliberate and argued below.

### Problem analysis

**The defect is a conflation, not an absence.** `dispatched_at` serves two unrelated jobs: it is
the activity-light source ("an agent is working on this now") and the dispatch-identity stamp every
downstream mechanism keys on. The activity-light timeout, `clearStaleWorkingState`
(`KanbanDatabase.ts:12182`, invoked every sweep tick at `PlanIngestionEngine.ts:637`), nulls
`dispatched_at` after `switchboard.activityLight.timeoutMs` (default 10 min,
`KanbanProvider.ts:174`) of no liveness. It does **not** null `dispatched_terminal`, record any
state, or release the seat. So after 10 min of silence a card is:

- activity light OFF — the read-time derive `isWorkingState` (`KanbanProvider.ts:180`) and the
  sweep agree it is idle;
- `heldByTeam` TRUE — `LocalApiServer.ts:107` keys on `dispatched_terminal` + `!completedAt`, so
  the card still blocks its team;
- invisible to the dispatch-stall nudge — `0417d620`'s predicate requires `dispatchedAt` set
  (`PlanIngestionEngine.ts:2311`), so the stamp the 10-min sweep just nulled drops the card out of
  the 30-min nudge;
- recorded as nothing — no `timed out`, no `failed`, no reason.

The board does not "lie forever" by claiming in-flight work nobody is doing; it lies *worse* — idle
to the eye, blocking to the team, invisible to the backstop, with no record of why. The first draft
of this plan framed the defect as "no timeout exists anywhere on the dispatch path." That framing is
corrected below.

> **Superseded:** "There is no timeout anywhere on the dispatch path. A grep of `KanbanProvider` and
> `PlanIngestionEngine` for retry, backoff, attempt or timeout returns feature-link resolution and
> queue pacing — nothing that bounds a dispatched card. The only `timeoutMs` values in `src/services`
> belong to ClickUp and Notion HTTP calls."
> **Reason:** The grep missed the activity-light timeout. `clearStaleWorkingState`
> (`KanbanDatabase.ts:12182`) is a dispatch-path timeout: it nulls `dispatched_at` for silent seats
> every tick (`PlanIngestionEngine.ts:637`), default 10 min (`DEFAULT_WORKING_STATE_TIMEOUT_MS`,
> `KanbanProvider.ts:174`). It is the mechanism that silently ends half the attempt (clears the
> stamp) without ending the other half (releasing the seat) or recording a state — which is the
> actual defect this card must fix.
> **Replaced with:** The defect is a conflation of the activity-light source and the
> dispatch-identity stamp in one field (`dispatched_at`). The activity-light timeout already ends
> the stamp half; this card ends the seat half, records the named state, and stops the activity-
> light timeout from destroying the stamp the nudge and this timeout both need.

The cost is not a stalled agent — it is a **board that lies**, and a backstop (`0417d620`) that
cannot see the card it was built for because the 10-min sweep hid it.

### Why this card does not retry, having originally proposed it

The first draft imported "retries with backoff" from a comparable unattended orchestrator. That
premise does not transfer, and the individual cases do not survive being taken apart:

- **A coder reporting failure.** The agent tried and concluded it could not. Re-running an identical
  prompt produces an identical result and spends the quota twice.
- **A seat exiting non-zero.** Occasionally transient, usually not — and there is a human watching
  this board, which is the difference from a tool designed to run with nobody looking.
- **A dispatch that never landed.** Real, transient, and **not yet solved**:

> **Superseded:** "A dispatch that never landed. Real, transient, and **already solved**: *A
> Half-Delivered Dispatch Has No Safe Recovery* (`ba068390`, CODE REVIEWED) delivers exactly this —
> see that the prompt did not land, and re-deliver it *without clearing the seat*, with a redeliver
> path at `bootstrap.ts:3750`. Adding a second retry mechanism beside it would fight it."
> **Reason:** `ba068390` is unimplemented. Its own Review Findings (in this tree) state: *"Nothing
> was implemented for this plan and there is nothing to review."* `bootstrap.ts:3750` is
> `writeMissionControlReport` — a fire-and-forget file mirror of a turn-end notice, not a
> redeliver action. The repo's `POST /kanban/round/redeliver` (`LocalApiServer.ts:4748`) is a
> Coding-Rounds subtask re-send, not half-delivered-dispatch recovery. The "already solved" premise
> is false.
> **Replaced with:** A dispatch that never landed is a real, transient failure with **no shipped
> recovery**. It is still not a reason to add retry to *this* card: a re-dispatch clears the seat
> and re-runs the prompt, which is the destructive action `ba068390` exists to replace — and until
> `ba068390` lands, retry remains the only lever and remains destructive. The no-retry conclusion
> stands on its own merits (a failed coder re-run burns quota twice; a human watches this board);
> it does **not** stand on a shipped redeliver path. Do not add retry to this card; do not claim
> `ba068390` covers it.

So the one genuinely transient failure has no shipped answer, and the rest are decisions a person
should make. **Do not add retry to this card later without a new argument.**

**And this is not the nudge card.** `A Card Dispatched Long Enough With No Report Nudges the Lead`
(`0417d620`, Planned) tells a human that a card has been quiet — deliberately one predicate and two
fields. Notification is not the same as ending an attempt: the nudge asks someone to look, this
records that nobody did. The two consume the same fields and must not be folded together
(`0417d620` change 6 forbids acquiring extra gates).

## Metadata

- **Complexity:** 6
- **Tags:** backend, reliability, bugfix

## User Review Required

One decision deserves a human eyeball before coding: **stopping `clearStaleWorkingState` from
nulling `dispatched_at`** changes the activity-light contract. Today the sweep "resets" the stamp at
10 min; after this change the stamp survives silence and the read-time derive (`isWorkingState`,
`KanbanProvider.ts:180`) alone turns the light off. The light's *visible* behaviour is unchanged
(the derive already handles it), but the persisted field stays non-NULL longer, which any external
reader of `dispatched_at` as "is the agent active right now" will notice. Proceeding on the
assumption that `dispatched_at` is a dispatch-identity stamp, not a live-activity flag, and that
the activity light is the read-time derive's job.

## Complexity Audit

### Routine

- The new dispatch-timeout sweep is a predicate over card fields + a clock, evaluated each tick —
  same shape as the existing `_runDispatchStallSweep` (`PlanIngestionEngine.ts:2268`).
- Writing the `timed out` state is one column/field write alongside the existing
  `clearWorkingState` / `releaseDispatchHolder` writers.
- Releasing the seat reuses the existing `releaseDispatchHolder` (`KanbanDatabase.ts:10311`),
  which already nulls both `dispatched_at` and `dispatched_terminal`.

### Complex / Risky

- **Stopping `clearStaleWorkingState` from nulling `dispatched_at`** is a contract change to the
  activity-light timeout. The read-time derive keeps the light correct, but every external reader
  of `dispatched_at` sees a longer-lived non-NULL value. Must be verified against the in-flight
  predicate (`heldByTeam`, `LocalApiServer.ts:107` — already does not read `dispatched_at`, so
  safe) and the nudge (`0417d620` — gains, does not lose).
- **Ordering against the nudge.** The dispatch timeout (hours) must fire *after* the nudge (30 min)
  and the nudge must fire *before* the stamp is cleared. With the conflation fixed, the stamp
  survives past 10 min, so the nudge can finally see silent seats — but the two thresholds must be
  kept far apart by default, not by luck.
- **Both composition roots.** The sweep runs in the shared `PlanIngestionEngine`; the state write
  and seat release touch shared `KanbanDatabase`. Both-hosts is *probably* free, but the verb path
  is not the audit — verify the two roots (`extension.ts` / `bootstrap.ts`) construct the engine
  and DB identically.

## Edge-Case & Dependency Audit

**Race Conditions.** The timeout sweep runs on the same tick loop as `clearStaleWorkingState` and
the dispatch-stall nudge, all per-folder, all reading one `getBoard` snapshot. The timeout's
state write + seat release must run inside the same critical-section discipline as the existing
sweeps (no inter-sweep mutation that a later sweep reads as stale). Two seats timing out on the
same tick each release their own row by `dispatched_terminal === seat` — no cross-match.

**Security.** The timeout write is internal (sweep-driven), not an API endpoint. No new auth
surface. The existing `_checkAuth` boundary is untouched.

**Side Effects.** One, and it is the point: seats silent past the timeout release, so a team
blocked by a dead coder unblocks. This will look like a burst of seat releases the first time it
runs on a board with stale holds — same observable as the `bf23c37f` fix, and equally correct.

**Dependencies & Conflicts.**
1. **`clearStaleWorkingState` (`KanbanDatabase.ts:12182`).** This card changes what it nulls: stop
   nulling `dispatched_at` (and `last_liveness_at`), keep nulling `blocked_at`. The read-time
   derive owns the light. `recordLiveness` (`KanbanDatabase.ts:12232`) gates on
   `dispatched_at IS NOT NULL` — with the stamp surviving, liveness keeps stamping for live seats,
   which is correct.
2. **`0417d620` (dispatch-stall nudge).** Gains: with `dispatched_at` surviving past 10 min, the
   nudge's 30-min predicate can finally see silent seats (today it only sees seats still producing
   output). No code change to the nudge; confirm its deferred finding about empty-liveness early-
   return does not swallow the now-visible silent cards.
3. **`bf23c37f` (column-move orphans the holder).** Shares the root: `dispatched_at` cleared while
   `dispatched_terminal` stays. This card's timeout release uses `releaseDispatchHolder` (nulls
   both), so it does not add orphans. Column-move orphans remain `bf23c37f`'s to fix; this card
   must not regress them.
4. **`ba068390` (half-delivered dispatch).** Unimplemented (see Superseded callout). This card does
   not depend on it and does not duplicate it — no retry, no re-deliver.
5. **Both hosts.** Verify by reading both composition roots, not by observing one.

## Dependencies

- Independent of `ba068390` (unimplemented; this card adds no retry/redeliver).
- Cooperates with `0417d620` (nudge) — this card's conflation fix is what lets the nudge see silent
  seats; ship order does not matter, but both must key on a `dispatched_at` that survives the
  10-min sweep.
- No new package dependencies.

## Adversarial Synthesis

Key risks: (1) the plan's original predicate (`dispatched_at` set + elapsed > hours) cannot fire
for silent seats because the 10-min activity-light timeout nulls the stamp first — mitigated by
stopping that null and making the dispatch timeout the sole stamp-clearer; (2) stopping the null
changes the activity-light contract for external `dispatched_at` readers — mitigated because
`heldByTeam` already ignores `dispatched_at` and the read-time derive owns the visible light, but
flagged for user review; (3) the timeout and the nudge share a field and must stay ordered —
mitigated by keeping the defaults hours vs 30 min and asserting the invariant in a test.

## Proposed Changes

### `src/services/KanbanDatabase.ts` — `clearStaleWorkingState` (`:12182`)

**Context.** This sweep nulls `dispatched_at` (and `last_liveness_at`, `blocked_at`) for silent
seats every tick. Nulling `dispatched_at` serves the activity light, but the read-time derive
`isWorkingState` (`KanbanProvider.ts:180`) already turns the light off at 10 min from
`MAX(dispatched_at, last_liveness_at)` *without* nulling the stamp. The null is therefore redundant
for the light and destructive for dispatch identity: it drops the card out of the nudge predicate
(`0417d620`) and out of this card's timeout predicate, and orphans the seat (`bf23c37f`).

**Logic.** Stop nulling `dispatched_at` and `last_liveness_at` in the age-based UPDATE. Keep
nulling `blocked_at` (it is a transient flag, not a dispatch-identity stamp). Keep the exited-
terminal force-clear arm *as a seat release only* — an exited terminal is positive evidence the
seat is gone, so route it through `releaseDispatchHolder` (nulls both `dispatched_at` and
`dispatched_terminal`) rather than the half-clear that produced the orphan. The dispatch timeout
(below) becomes the sole abandonment path that nulls `dispatched_at` for a *live-but-silent* seat.

**Edge Cases.** A re-dispatch after a long silence already re-stamps `dispatched_at`
(`updateDispatchInfoByPlanFile`, `KanbanDatabase.ts:11580`, overwrites the field), so a surviving
stamp does not strand a re-dispatch. `recordLiveness` (`:12232`) keeps stamping
`last_liveness_at` for live seats (its `dispatched_at IS NOT NULL` gate now matches more rows,
which is correct).

### `src/services/PlanIngestionEngine.ts` — new dispatch-timeout sweep

**Context.** No sweep today ends a dispatched attempt in a named state. The dispatch-stall nudge
(`_runDispatchStallSweep`, `:2268`) notifies; it does not end.

**Logic.** Add a `_runDispatchTimeoutSweep` invoked on the same tick as the other sweeps (after
`clearStaleWorkingState`, alongside the nudge). Predicate:

```
dispatched_at set  AND  completed_at NULL  AND  now - dispatched_at > dispatchTimeoutMs
```

where `dispatchTimeoutMs` is a new `switchboard.activityLight.dispatchTimeoutMs` config (default
**4 hours**, well past the 30-min nudge). On match, for each card:

1. Write a `timed out` end state — record the seat and the elapsed time. `timed out` is not
   `failed`, not `complete`, and not silence; it means *the attempt was abandoned because nothing
   was heard*. The state must survive into everything that reads the card.
2. Release the seat via `releaseDispatchHolder` (nulls `dispatched_at` **and**
   `dispatched_terminal` together — the operation `bf23c37f` is about, done atomically so the card
   does not pass through the orphan state).
3. Do **not** write `completed_at`. A timed-out card is neither done nor proven undone — the coder
   may have finished and failed to report (`0417d620`'s incident). Completion remains the explicit
   POST.

**Edge Cases.** A legitimately long task hits the threshold — that is what the configurable
`dispatchTimeoutMs` is for, and why the end state is `timed out` not `failed`. A timed-out coder
inside a running feature affects its lead: record the state only, do not act into the team
mid-round. One record per card, no repetition — the nudge already owns telling people.

### `src/services/LocalApiServer.ts` — `heldByTeam` comment (`:107`)

**Context.** `heldByTeam` keys on `!completedAt && dispatchedTerminal`. After this card, a
timed-out card has `dispatched_terminal = NULL` (released), so it correctly leaves the in-flight
predicate.

**Logic.** Add a one-paragraph comment recording that a `timed out` card is released
(`dispatched_terminal` NULL) and therefore not in flight, that `completed_at` stays NULL (a
timeout is an abandonment, not a completion — consistent with the existing note at
`bootstrap.ts:1113`), and that the dispatch timeout is the sole writer that nulls `dispatched_at`
for a live-but-silent seat now that the activity-light sweep no longer does.

## Verification Plan

### Automated Tests

1. A card dispatched past `dispatchTimeoutMs` with no report reaches `timed out`, recorded with
   seat and elapsed time, and is **not** re-dispatched.
2. No path writes `completed_at`; a timed-out card is never treated as done.
3. The seat is released (`dispatched_terminal = NULL`) and `dispatched_at` is cleared **together**
   (atomic, via `releaseDispatchHolder`) — assert the card never passes through the orphan state
   (`dispatched_terminal` set + `dispatched_at` NULL).
4. `heldByTeam` reports the timed-out card **not** in flight after release.
5. The nudge (`dispatchStallMs`, 30 min) fires **before** the timeout (`dispatchTimeoutMs`, 4 h),
   with defaults far enough apart for a human to act in between — assert the invariant
   `dispatchStallMs < dispatchTimeoutMs`.
6. A card that reports normally before the timeout is unaffected, and no timeout state is recorded.
7. `grep -rn "retry\|backoff"` over the changed files returns nothing — this card adds neither.
8. **The conflation fix:** after `clearStaleWorkingState` runs on a silent seat, `dispatched_at`
   is **still set** (no longer nulled), and the dispatch-stall nudge predicate
   (`dispatchedAt && !completedAt`) still matches it. At HEAD this fails — confirm before writing
   the fix.
9. The timeout is armed on **both** hosts, verified by reading both composition roots
   (`extension.ts` / `bootstrap.ts`) rather than by observing one.

### Goal Invariants

- **Positive:** a card with `dispatched_at` set, `completed_at` NULL, silent past
  `dispatchTimeoutMs`, reaches state `timed out` with `dispatched_terminal = NULL`.
- **Positive:** after that transition, `heldByTeam` reports the card not in flight.
- **Negative:** no writer on the timeout path sets `completed_at` (a timeout is an abandonment,
  not a completion).
- **Negative:** `clearStaleWorkingState` no longer nulls `dispatched_at` for a live-but-silent seat
  (the dispatch timeout is the sole abandonment nuller).

## Outstanding Questions

- **[user]** Stopping `clearStaleWorkingState` from nulling `dispatched_at` changes the persisted
  field's lifetime for external readers — proceeding on the assumption that `dispatched_at` is a
  dispatch-identity stamp and the activity light is the read-time derive's job, not the stamp's.
