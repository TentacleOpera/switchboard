# A Lead's Completion Post Must Clear the Seat — `completed_at` Is a Latch That Is Never Reset

kanbanColumn: CREATED

## Goal

When a team lead posts completion for a subtask, the seat that did the work is cleared. There is no case in which that post is ignored.

### Problem analysis

**Observed 2026-09-04.** A lead posted `/kanban/task/complete` for all three of its subtasks. One cleared. Two were silently ignored.

```
ed40b1f1  {"success":true,"completed_at":"2026-09-04T07:05:…","idempotent":true}
cc0e2653  {"success":true,"completed_at":"2026-09-04T07:15:…","cleared":true,
           "acceptedCodingSeat":"Coding-coder-1","dispatchedTerminal":"Coding-coder-1"}
e780ad93  {"success":true,"completed_at":"2026-09-04T05:57:…","idempotent":true}
```

All three returned `success: true`. Two cleared nothing, released nothing, and said so only by the absence of fields.

**The cause: `completed_at` is write-once and never reset.**

`KanbanDatabase.ts:2914` holds the only writer — `UPDATE plans SET completed_at = ?`. A repo-wide search finds no code that ever sets it back to NULL: not on dispatch, not on re-dispatch, not on a column move, not on reopen. Once a card has been completed, it is permanently marked complete for the rest of its life.

`LocalApiServer.ts:3320` then treats the presence of that field as proof the request is a duplicate:

```js
if (existing.completedAt) {
    return { success: true, planId, completed_at: existing.completedAt,
             outcome, note, idempotent: true };
}
```

The early return sits **above** seat resolution (`:3332`), the clear (`:3375`) and the release hook (`:3486`, additionally gated on `!result.idempotent`). So it does not skip a duplicate write — it skips every consequence of completion.

**This is not idempotency, it is a latch.** Idempotency means "this exact request already succeeded, so do not repeat its effects." What the field actually says is "this card was completed at some point in its history." The two are identical in the data and mean entirely different things:

- `e780ad93` was completed at **05:57** by a previous run, then re-dispatched, then worked again by the current team. Its `completed_at` was two hours stale and described a different piece of work by a different seat.
- The lead's 07:15 post was the first and only completion of *that* run, and was discarded as a duplicate.

Per the repository rule on fallbacks: a value whose "already handled" reading is indistinguishable from its "stale from a previous life" reading turns a loud failure into a quiet wrong answer. That is exactly this field.

**What it costs.** The seat is never stood down, so it carries the previous subtask's context into whatever it is handed next. `onTeamReleased` never fires, so the in-flight check never runs and advance-when-ready never triggers. And the lead is given `success: true`, so nothing anywhere reports that its instruction did not happen.

The lead's own standing order (`standingOrderFragments.ts:79-84`) tells it the opposite: *"Until you post, that seat is not cleared and you cannot be handed the next subtask. Your POST is the only fact the system acts on."* The system did not act on it.

## Metadata

- **Complexity:** 4
- **Tags:** teams, completion, dispatch, bugfix

## User Review Required

None. A lead's completion post clears the seat. There is no exception to design.

## Proposed Changes

### 1. Reset `completed_at` when a card is re-dispatched

A card that is dispatched to a seat is not complete, whatever it was in a previous life. Clear the field on dispatch so the row describes the run in progress rather than the last one that finished.

This is the root fix. With it, the 2026-09-04 sequence produces three fresh completions and three clears.

### 2. The clear and the release do not belong behind the duplicate check

Move seat resolution, `clearTerminalContext` and `onTeamReleased` above the early return, or make the early return fall through to them. A seat is cleared because its subtask is finished, not because a particular POST happened to be the one that wrote the timestamp.

Guard the clear on the seat's **current** dispatched card, not on the planId being posted — a seat that has already moved on to different work must not be cleared out from under it. Remove the `!result.idempotent` gate at `:3486`; the existing `inFlight` check at `:3495` already prevents a double release.

### 3. A post that changes nothing must not report `success: true` alone

If a completion genuinely is a duplicate — same run, same seat, already cleared — say so in terms the caller can act on: what was cleared, what was not, and why. `success: true` with three fields missing is indistinguishable from success, which is how this went unnoticed through an entire feature run.

## Edge-Case & Dependency Audit

1. **True duplicates still must not double-fire.** Two posts for the same subtask in the same run should clear once. Guard on the seat's current dispatched card, which is the fact that actually matters.
2. **Do not clear a seat that has moved on.** If the seat named by `dispatched_terminal` is now working a different card, the completion is stale and the clear must be skipped — loudly, not silently.
3. **The lead is never the cleared seat.** `:3353` already drops `acceptedCodingSeat === from`. Keep it.
4. **Change 1 alone leaves a hole.** Re-dispatch resetting the field fixes the reported case, but a card completed and re-dispatched through any path that does not reset it lands back here. Change 2 is what makes the outcome correct regardless.
5. **`16bdde5d` overlaps and should be folded in.** It proposes firing the clear and the release on the idempotent branch, which is change 2. It does not identify the never-reset latch. Merge rather than run both.
6. **Both hosts** must reset the field on their own dispatch paths.

## Verification Plan

1. A lead posting completion for three subtasks clears three seats.
2. A card completed, re-dispatched and re-worked accepts a fresh completion, with a clear.
3. A genuine same-run duplicate clears once, not twice.
4. A seat that has moved to a different card is not cleared by a stale completion, and the response says so.
5. `onTeamReleased` fires for a team whose last subtask completed on a re-dispatched card.
6. No completion response reports plain `success: true` while having cleared nothing.

## Implementation Summary

Reset `completed_at` to NULL on plan dispatch across both hosts (`updateDispatchInfoByPlanFile` and `attributePastedPrompt` in `KanbanDatabase` and `KanbanProvider`). Added `clearCompletedAt` and `clearCompletedAtByPlanFile` to `KanbanDatabase`, and invoked `clearCompletedAt` in `LocalApiServer.performKanbanDispatch`. Updated `completeCardInternal` in `LocalApiServer` to treat stale `completed_at` timestamps as fresh runs and guarded seat clears with `_isSeatCurrentDispatchedCard` against moved or already-cleared seats. Completion responses now explicitly return `cleared: false` with detailed `clearReason` and `clearError` on skipped clears rather than silent partial success envelopes. Unblocked `onTeamReleased` by removing the `!result.idempotent` gate so team releases trigger reliably on card completion.

## Review Findings

Reviewed 2026-09-04. Change 1 is the strongest part of the delivery and holds: `completed_at = NULL` is now written by `updateDispatchInfoByPlanFile`'s own UPDATE (placeholder count verified correct), by new `clearCompletedAt`/`clearCompletedAtByPlanFile` methods, and is called from `LocalApiServer.performKanbanDispatch`, `KanbanProvider.attributePastedPrompt` and standalone's `triggerAction` — plus `isStaleCompletedAt` treats a `completed_at` older than `dispatched_at` as a fresh run, which is exactly the `e780ad93` case. Change 2 was only half done: the clear and the release did move out from behind the duplicate check, but an `else if (isIdempotent) { cleared = false }` arm put the write transition back in front of the clear and asserted "seat was already cleared" without checking — fixed by deleting it, leaving `_isSeatCurrentDispatchedCard` (at-rest plus moved-on) as the sole guard, which is what change 2 specified. Change 3 landed: responses now carry `clearReason` and `clearError` naming what was and was not cleared. Files changed: `src/services/LocalApiServer.ts`, `src/test/host-auto-clear-on-plan-change.test.js`. Verification: `test:contract:task-complete`, `queue-done-relay`, `queue-pipeline`, `team-release-control`, `atomic-team-lifecycle` pass; `npx tsc --noEmit` clean of every touched line — but none of those suites discriminates on the latch, so verification steps 1-6 remain provisional.

## Deferred Findings

- MAJOR `src/services/KanbanDatabase.ts:2917` — `clearCompletedAtByPlanFile` is defined and never called. Change 1's "both hosts must reset the field on their own dispatch paths" is satisfied by planId-keyed callers only; any plan-file-keyed dispatch path that does not go through `updateDispatchInfoByPlanFile` still lands back on the latch (edge case 4 of this plan).
- MAJOR `src/services/LocalApiServer.ts:3629` — `isStaleCompletedAt` requires a truthy `dispatchedAt`. A card completed in a previous life and re-dispatched through a path that writes neither `dispatched_at` nor a `clearCompletedAt` call is still read as complete, silently.
- MAJOR `src/services/LocalApiServer.ts:3630` — verification steps 1-6 have no automated discriminator: nothing posts a completion twice, nothing re-dispatches a completed card and completes it again. Passing the suites above is not evidence the latch is gone.
- NIT `src/services/LocalApiServer.ts:824` — `_seatsAtRest` is never pruned.
