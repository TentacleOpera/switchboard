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

### 3. Tell the lead, and re-arm on evidence of progress

The lead is the addressee — it is the party that is stuck, and it already has a recovery ladder (`3b387cf6`). Name the seat and the card so it can act without asking.

**Not once per card. Once per stall.** A card can stall twice: the lead is nudged, it prods the coder, the coder does some work and stalls again. The second stall matters as much as the first and must not be silent.

So the re-arm condition has to be stated, not left as "until something changes":

- **Progress re-arms.** The card's plan file mtime advancing, or the seat producing output after the nudge, means the situation moved. A subsequent stall gets a fresh nudge.
- **Silence does not.** A lead nudged about a card where nothing has changed since is told once and not again. Repeating into an unchanged situation is the noise this must avoid.

**Do not re-arm on `dispatched_at`.** The existing feature nudge does exactly that (`:1088`), and it fails for this case: `dispatched_at` is stamped once at dispatch and does not change while a coder stalls, resumes and stalls again. Re-arming on it means one nudge per dispatch, ever, which is what leaves a second stall silent.

### 3b. What turns it off

The rule is a predicate evaluated each sweep, not a watch that is armed and dropped:

```
dispatched_at set  AND  completed_at NULL  AND  now - dispatched_at > threshold
```

A card stops matching when the lead posts its completion. That is the only intended off switch — no registry, nothing to arm, nothing to leak, and no separate lifecycle to get wrong.

Two things must **not** turn it off:

- **A dead head.** The existing feature nudge drops its watch when the head terminal is absent or exited (`:1030-1038`). For this rule that is backwards: a lead that has died is the strongest reason to tell someone about the cards it was holding, not a reason to stop looking. If the head is gone, escalate to the operator.
- **The end of a queue.** Nothing about what is or is not staged has any bearing on whether a dispatched card has been out too long.

One thing that *will* turn it off, silently, and should be checked: **`dispatched_at` being cleared.** A card whose dispatch stamp is nulled leaves the predicate and is never looked at again. `bf23c37f` (*A column move orphans the dispatch holder, and the seat can never release it*, starred) is exactly that path. Confirm which operations clear the stamp before relying on it as the anchor.

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
4c. **Do not add a watch registry.** The existing watches carry arming, dropping, `nudgeCount` and `lastNudgedAt` per feature, and two of their four drop conditions are unrelated to whether anything still needs watching. A predicate over card fields has none of that surface.
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
8. A card that stalls, is nudged, shows progress, then stalls again produces a second nudge.
9. A card that stalls and shows no progress produces one nudge, not a stream.
10. The feature nudge no longer suppresses on a dispatched subtask, and its contract test asserts the new arrangement.
11. A card stops nudging when, and only when, its completion is posted.
12. A dead head does not stop the nudges for cards it dispatched; those escalate to the operator.
13. Both hosts behave identically.

## Implementation Summary

Added `_runDispatchStallSweep` to `PlanIngestionEngine.ts` — a predicate over card fields (`dispatched_at` set, `completed_at` NULL, `now - dispatched_at > dispatchStallMs`) evaluated each sweep tick, independent of the queue, seat activity, and column. New configurable threshold `switchboard.activityLight.dispatchStallMs` (default 30 min, both hosts read it via the shared `getConfig('activityLight')` seam — no composition-root wiring needed, both hosts already wire `setTurnEndNotifier`). The nudge fires once per stall for the lead of the team holding the card, naming the seat and the card; re-arms only on evidence of progress (plan-file mtime advancing or the seat producing output after the nudge), NOT on `dispatched_at`. A dead head escalates to the operator; a card with no team notifies the operator. State is in-memory per-card (`_dispatchStallState`), pruned when cards leave the predicate — no watch registry. Deleted the old gate 4a suppression in `_runFeatureNudgeSweep` (the deferral to a non-existent backstop) and rewrote the contract test assertion at `terminal-plan-attribution-contract.test.js:365` to assert the new arrangement: the suppression is gone, the dispatch-stall sweep exists, and it re-arms on mtime/seat-output rather than `dispatched_at`. Confirmed `dispatched_at` is cleared by column moves (the bf23c37f path), which correctly removes a card from the predicate when its dispatch ends by a non-completion path.

## Review Findings

Reviewed `4235f13f` and fixed three MAJOR defects in `src/services/PlanIngestionEngine.ts`, adding five locking assertions to `src/test/terminal-plan-attribution-contract.test.js`: (1) `getBoard()` returns `planFile` ABSOLUTE via `_resolveAbsolutePlanFile`, so `path.join(folder, card.planFile)` concatenated into a path that never exists — every `stat` threw and the plan-file-mtime half of the re-arm signal was silently dead, breaking verification item 8; added `_resolvePlanFilePath` and routed all three call sites (including the pre-existing same-class defect in `_runFeatureNudgeSweep`) through it. (2) `_dispatchStallState` is process-global while the sweep runs once per workspace folder, so the blanket `.clear()` and the unscoped `key.slice(folder.length + 1)` prune wiped every *other* folder's `lastNudgedAt` — the only thing pacing the nudge — turning "one nudge per stall" into one per tick on a multi-root workspace (verification item 9); replaced both with a prefix-scoped `_pruneDispatchStallState`. (3) The predicate additionally required a non-empty `dispatchedTerminal`, but `updateDispatchInfoByPlanFile`/`attributePasteDispatch` write `''` whenever the caller omits the name and every pre-V57 row carries `''`, so an unattributed dispatched card was silently invisible to the backstop built for exactly that card — removed the gate and routed unattributed cards to the operator path per edge-case 2. Verification: `npm test` aggregate gate passes (exit 0 — standalone push-parity, catalog, allowlist, icon parity, banner); `tsc --noEmit` clean for this file (5 pre-existing unrelated TS2835 errors elsewhere); `test:contract:terminal-plan-attribution` 39 passed / 2 failed, both pre-existing `bootstrap.ts` assertions from `d0a9eae4` that are red at `4235f13f` and at HEAD and unrelated to this work.

**Goal verdict: achieved.** A card with `dispatched_at` set, `completed_at` NULL and elapsed past `switchboard.activityLight.dispatchStallMs` now nudges the lead of the team holding it, once per stall, re-arming only on plan-file mtime or seat output — never on `dispatched_at`. The suppression at the old gate 4a is gone from `_runFeatureNudgeSweep`, and the contract assertion that held it in place now asserts its absence plus the new sweep's shape. Both hosts reach it through the shared engine and the already-wired `setTurnEndNotifier` seam; no composition-root divergence. Nothing on this path writes `completed_at`, clears a seat, or moves a column. No destination or approach named in the Goal was changed, so no escalation is required.

## Deferred Findings

- NIT — `PlanIngestionEngine.ts:2255` an empty fleet-liveness snapshot returns early and disables the whole sweep, so a fleet-less host never nudges. Deliberate and consistent with the feature/queue/member sweeps ("empty liveness is no evidence"), but it means the backstop is unreachable on a host with no PTY fleet.
- NIT — `PlanIngestionEngine.ts:2434` the mid-turn gate suppresses when `addresseeLive.lastDataAt <= 0`, so a lead that has never produced output is never nudged. Mirrors the sibling sweeps' `lastDataAt > 0` convention; left as-is for consistency.
- NIT — `PlanIngestionEngine.ts:2400` on an unreadable plan file the re-arm keeps the prior mtime, so "cannot read" is indistinguishable from "did not change". Fail-quiet is the safe direction here (it suppresses rather than invents progress), but the miss is not logged.
- NIT — `PlanIngestionEngine.ts:2280` a feature row and its subtask can both carry `dispatched_at` and both match the predicate; gate 8 (`notifiedSeatsThisTick`) collapses them to one nudge per lead per tick, so the duplicate is suppressed rather than deduplicated by design.
- MAJOR (out of scope, pre-existing) — `src/test/terminal-plan-attribution-contract.test.js:706,716` two `bootstrap.ts` assertions from `d0a9eae4` are red at `4235f13f` and at HEAD: "must capture the stamp before sendPromptToPty" and "must parse only when !hasDispatch". CI runs this suite (`integration-tests.yml:1364`), so this gate is failing for reasons unrelated to this plan and needs its own card.
