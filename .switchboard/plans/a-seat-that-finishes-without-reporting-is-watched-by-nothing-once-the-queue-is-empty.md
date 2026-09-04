# A Card Dispatched Long Enough With No Report Nudges the Lead

kanbanColumn: CREATED

## Goal

One rule: **if a card has been dispatched for longer than the threshold and no completion has been posted, nudge the lead.** Once. That is the whole feature.

### Problem analysis

**Observed 2026-09-04.** A coder finished its work and did not post its completion report. Its lead waited hours. Nothing told either of them, and the operator noticed by hand.

The lead could not have known. A report is the only event that reaches it, and none arrived. From the lead's side, "finished and forgot to report" and "still working" are the same silence.

**Nothing watches for this, and what exists watches something else.** `PlanIngestionEngine`'s queue nudge gates every branch on `queueCards.length` (`:1324`) — cards staged in the dispatch queue. It exists to keep a *queue* advancing: no pacer with work staged, a dead pacer to re-stage, a pacer gone idle with more to hand out. The lead in this case had dispatched everything it had, so nothing was staged, and the whole watch returned before looking at anything.

**The rule does not need the queue, and should not be built on it.** Whether cards are staged behind a seat has nothing to do with whether that seat's card has been out too long. Hanging this off the queue machinery makes it inherit a gate it does not want, which is exactly how the existing behaviour came to be.

**The data required is two fields already on the card.** `dispatched_at` is a timestamp and `completed_at` is NULL until the lead posts. `now - dispatched_at > threshold && completed_at IS NULL` is the entire condition. No seat liveness, no output sampling, no pacing model, no queue.

Seat liveness is deliberately *not* the trigger. A seat can be quiet while thinking and chatty while stuck; elapsed time since dispatch is the thing the operator actually means by "this has been out too long".

## Metadata

- **Complexity:** 3
- **Tags:** teams, completion, watchdog, both-hosts

## User Review Required

None.

## Proposed Changes

### 1. The rule

A card with `dispatched_at` set, `completed_at` NULL, and `now - dispatched_at` past the threshold produces one notification to the lead of the team holding it.

Independent of the queue, of seat activity, and of what column the card is in. Do not gate it on anything else.

### 2. One threshold, configurable, with a sane default

A single setting. Not per-role, not per-column, not per-complexity — one number the operator can raise if their work runs long.

Where the default comes from matters less than that it is visible and adjustable; a threshold nobody can find is a threshold nobody trusts.

### 3. Tell the lead, once per card

The lead is the addressee — it is the party that is stuck, and it already has a recovery ladder (`3b387cf6`). Name the seat and the card so it can act without asking.

Once per card, not per tick. A repeating nudge is noise and noise gets ignored, which leaves you where you started.

### 4. Never infer completion

The nudge says a card has been out a long time. It never marks the card complete, never clears the seat, and never advances the column. `completed_at` remains NULL until the lead posts, exactly as today.

### 5. Do not build this on the queue watch

Stated as a change because it is the mistake to avoid. The queue nudge stays as it is — it has its own job. This rule reads two card fields and a clock; it must not acquire a queue gate, a pacer concept, or a liveness probe on the way in.

## Edge-Case & Dependency Audit

1. **A legitimately long task will trip it.** That is acceptable and is what the threshold is for — one notification on a long-running card costs nothing; a missed one costs hours.
2. **A card with no lead** (a solo seat, a direct dispatch) has nobody to notify. Notify the operator instead, or skip — decide, and do not silently drop it.
3. **Depends on `711fa15e`.** `completed_at` is currently never reset, so a re-dispatched card carries a stale completion and would never trip this rule. That card resets it on dispatch.
4. **`dispatched_at` must be trustworthy.** A card whose `dispatched_at` is cleared by a column move (see the dispatch-holder cards) would silently leave this watch. Confirm the field survives the paths that touch it.
5. **Both hosts.**
6. **`3b387cf6`** owns what the lead does once told. This card only makes sure it is told.

## Verification Plan

1. A card dispatched past the threshold with no completion posted nudges its lead, naming the seat and the card.
2. It fires whether or not anything is staged in a queue.
3. It fires whether or not the seat is producing output.
4. It fires once per card, not per tick.
5. A card completed before the threshold produces nothing.
6. No card is marked complete, no seat cleared, no column advanced by this path.
7. The threshold is a visible, adjustable setting.
8. Both hosts behave identically.
