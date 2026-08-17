# A Dead Pacer Must Surface, Not End the Night Silently — Queue Watch on the Idle Sweep

## Goal

When a queue has cards left and the lead has gone quiet without dispatching anything, the lead is woken once with the evidence. If it is gone, the user is told. The night never ends silently with work still staged.

### Problem & background

**Removing the clock removes the thing that currently restarts a stalled lane, and that is the one real risk in the whole redesign.**

Under lead-paced pacing (plan 1) the lead is a single point of failure. It can hit a rate limit, exit, get `/clear`ed at the wrong moment, or simply not follow the instruction — these are LLM agents, not schedulers. When that happens today's clock papers over it: the next interval tick dispatches regardless of whether any agent did its job. Delete the clock without a replacement and a stalled lead means five staged cards sit untouched until morning, with no signal that anything went wrong.

The existing per-dispatch stall watchdog does **not** cover this. `_armAutobanStallWatchdog` (`src/services/TaskViewerProvider.ts:1622`) is armed at dispatch and keyed by plan file — it watches a **coder working a card**. The failure mode here is the opposite: no card is dispatched at all, so there is nothing armed and nothing to fire.

### Root cause — the backstop is scoped to features, and the queue is not a feature

The sweep that has exactly the right shape already exists. `_runFeatureNudgeSweep` (`src/services/PlanIngestionEngine.ts:908`) wakes a head only when all four hold:

1. the feature still has an un-accepted subtask;
2. the head terminal is live and not `exited`;
3. the head's own `lastDataAt` is older than `turnEndSilenceMs` — it is not mid-turn;
4. no dispatch is outstanding for any of the feature's seats, and no turn-end notice for one fired on this tick.

It composes **evidence** rather than a poke — remaining subtasks, their seats, how long each has been silent, plan-file mtimes (`:1017-1035`) — and paces itself to at most one nudge per `turnEndSilenceMs` window. Its guards are already the hard-won ones: an empty liveness snapshot is treated as *no evidence* rather than "every head died" (`:924-931`), and a watch is never retried against a dead head.

Every one of those properties is what a queue watch needs. The sweep is not scoped wrongly by accident — it was built for feature watches (`kanban.featureWatches`) because that was the case in hand. A queue is a second watch record type over the same machinery, not a second subsystem.

### Why this must land before the clock is retired

This is an ordering constraint, not a preference. The `retire-orchestrator-machinery` plan hit the identical dependency and named it: *"Deleting the cadence removes the only thing that currently restarts a stalled orchestrator. The sibling notification card must land first."* Same rule, one layer down. Plan 4 must not merge until this is in.

---

## Metadata

- **Complexity:** 3
- **Tags:** backend, reliability, bugfix
- **Feature:** 3e8b662b-a8a8-42c5-8e43-6d67998aa201

---

## User Review Required

**None.** Four decisions made here:

* **A second watch record type on the existing sweep** — not a new timer, not a new service.
* **The nudge carries evidence, matching the feature nudge.** A head woken with "check your queue" has to re-derive everything it was just told.
* **One nudge, then escalate to the user.** A nudge stream is what a poll is, and a head that ignores two nudges is not going to answer a third.
* **A dead head ends the watch and notifies the user.** Silently dropping the watch is the failure this plan exists to prevent.

---

## Implementation

1. **`QueueWatchRecord`** beside `FeatureWatchRecord` (`PlanIngestionEngine.ts:110`), persisted in a `kanban.queueWatches` config key: `{ headTerminal, workspaceRoot, armedAt, lastNudgedAt, nudgeCount }`.

2. **Armed by the first dispatch of a session** — inside the `queue/next` path from plan 1, and by `Run queue` (plan 2, which calls the same endpoint, so one arming site).

3. **`_runQueueNudgeSweep`**, called from the same tick as `_runFeatureNudgeSweep` and sharing its `liveness`, `nowMs`, `turnEndSilenceMs` and `notifiedSeatsThisTick` arguments. Gates, in order:
   - head absent or `exited` → drop the watch, **notify the user** naming the head and the number of cards left staged;
   - queue empty → drop the watch silently (the session ended normally);
   - any card in flight for this team → keep, stay silent (the per-dispatch watchdog owns that window);
   - a seat notified this tick → keep, stay silent (avoid a double wake);
   - head `lastDataAt` within `turnEndSilenceMs` → keep, stay silent (mid-turn; never inject into a running turn);
   - otherwise nudge.

4. **Evidence body**, mirroring the feature nudge's composition: how many cards remain staged, the next card's plan file, how long the head has been silent, and the exact call to make (`POST /kanban/queue/next`). Delivered through the existing `_turnEndNotifier` with `outcome: 'stalled'` and `recipientSeat` = the head, which is the path the feature nudge already uses (`:1041`).

5. **Escalation.** On the second nudge in a session with no dispatch in between, stop nudging and surface to the user: the lead is not advancing, N cards remain. `nudgeCount` on the record carries this.

6. **Reuse `turnEndSilenceMs`** rather than adding a setting. One silence threshold across both sweeps; a second knob is a second thing to tune wrongly.

---

## Verification Plan

- **Unit:** each gate independently — mid-turn head stays silent, in-flight card stays silent, empty queue drops silently, exited head drops with a user notice.
- **Unit:** empty liveness snapshot produces no nudge and drops no watch (the `:924-931` guard, which is the one that would silently destroy every watch if reimplemented carelessly).
- **Unit:** pacing floor — two sweep ticks inside one `turnEndSilenceMs` window produce one nudge.
- **Unit:** escalation fires on the second nudge with no intervening dispatch, and `nudgeCount` resets when a dispatch happens.
- **Manual UAT:** start a queue of three, let the first card finish, then kill the lead terminal. The user must be told the lead is gone and two cards remain — not discover it in the morning.
- **Manual UAT:** same setup, but leave the lead alive and unresponsive. It should receive exactly one nudge, then the user should be told.
- **Regression:** feature watches still nudge as they do today; the two sweeps do not double-wake a head that is both a feature head and a queue head.
