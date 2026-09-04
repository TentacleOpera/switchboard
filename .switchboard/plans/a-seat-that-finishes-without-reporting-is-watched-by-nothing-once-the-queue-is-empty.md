# A Card Dispatched Long Enough With No Report Nudges the Lead

kanbanColumn: CREATED

## Goal

One rule: **if a card has been dispatched for longer than the threshold and no completion has been posted, nudge the lead.** Once. That is the whole feature.

### Problem analysis

**Observed 2026-09-04.** A coder finished its work and did not post its completion report. Its lead waited hours. Nothing told either of them, and the operator noticed by hand.

The lead could not have known. A report is the only event that reaches it, and none arrived. From the lead's side, "finished and forgot to report" and "still working" are the same silence.

**Nothing watches for this, and a comment claims something does.**

The feature nudge tracks exactly the right thing — subtasks with no completion post (`PlanIngestionEngine.ts:1067`) — and then suppresses itself at `:1080`:

```js
const outstanding = remaining.some(s => !!s.dispatchedAt);
if (outstanding) {
    // A dispatch is in progress — the head is working, not stalled.
    // ... the per-dispatch backstop covers it, so the nudge stays silent.
    kept.push(watch); continue;
}
```

**The per-dispatch backstop does not exist.** The phrase occurs twice in the repository: in the comment above that defers to it, and in a contract test that asserts the suppression —

```js
assert.ok(sweep.includes('!!s.dispatchedAt'),
  'an outstanding dispatch must suppress the nudge — the per-dispatch backstop owns that window');
```

So a green gate holds the suppression in place on the strength of a mechanism nobody built. Nothing anywhere is keyed on elapsed-since-`dispatchedAt`.

**The queue nudge cannot cover it either.** Its scope (`:1319-1322`) is:

```js
p.kanbanColumn === 'STAGING'  &&  !p.dispatchedAt  &&  (!p.featureId || p.featureId === '')
```

A dispatched feature subtask fails all three conditions. And with nothing staged, `:1324` drops the watch entirely.

**So the card falls between them by construction.** The feature watch hands it to something imaginary; the queue watch has excluded it by definition. The two existing thresholds — `nudgeSilenceMs` 600000 (10 minutes, `:511`) and `livenessWindowMs` 90000 (90 seconds, `:505`) — belong to watches that never look at it.

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

### 5. Delete the suppression and its test assertion

Gate 4a at `:1080` suppresses the feature nudge for any dispatched subtask, deferring to a backstop that does not exist. Once this rule is built, that deferral is finally true — but the assertion in `terminal-plan-attribution-contract.test.js:365` must be rewritten to assert the *new* arrangement rather than the old suppression, or it locks the gap back in.

An assertion whose justification is a mechanism nobody wrote is worse than no test. Do not leave it green over a rule that has changed underneath it.

### 6. Do not build this on the queue watch

Stated as a change because it is the mistake to avoid. The queue nudge stays as it is — it has its own job. This rule reads two card fields and a clock; it must not acquire a queue gate, a pacer concept, or a liveness probe on the way in.

## Edge-Case & Dependency Audit

1. **A legitimately long task will trip it.** That is acceptable and is what the threshold is for — one notification on a long-running card costs nothing; a missed one costs hours.
2. **A card with no lead** (a solo seat, a direct dispatch) has nobody to notify. Notify the operator instead, or skip — decide, and do not silently drop it.
3. **Depends on `711fa15e`.** `completed_at` is currently never reset, so a re-dispatched card carries a stale completion and would never trip this rule. That card resets it on dispatch.
4. **The contract test at `terminal-plan-attribution-contract.test.js:365` will pass while the bug exists** and must be updated with the fix, not around it.
4b. **`dispatched_at` must be trustworthy.** A card whose `dispatched_at` is cleared by a column move (see the dispatch-holder cards) would silently leave this watch. Confirm the field survives the paths that touch it.
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
8. The feature nudge no longer suppresses on a dispatched subtask, and its contract test asserts the new arrangement.
9. Both hosts behave identically.
