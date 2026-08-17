# A Dead Pacer Must Surface, Not End the Night Silently — Queue Watch on the Idle Sweep

## Goal

When a queue has cards left and the lead has gone quiet without dispatching anything, the lead is woken once with the evidence. If it is gone, the user is told. The night never ends silently with work still staged.

### Problem & background

**Removing the clock removes the thing that currently restarts a stalled lane, and that is the one real risk in the whole redesign.**

Under lead-paced pacing (subtask 1) the lead is a single point of failure. It can hit a rate limit, exit, get `/clear`ed at the wrong moment, or simply not follow the instruction — these are LLM agents, not schedulers. When that happens today's clock papers over it: the next interval tick dispatches regardless of whether any agent did its job. Delete the clock without a replacement and a stalled lead means five staged cards sit untouched until morning, with no signal that anything went wrong.

The existing per-dispatch stall watchdog does **not** cover this. `_armAutobanStallWatchdog` (`src/services/TaskViewerProvider.ts:1696`) is armed at dispatch and keyed by plan file — it watches a **coder working a card**. The failure mode here is the opposite: no card is dispatched at all, so there is nothing armed and nothing to fire.

### Root cause — the backstop is scoped to features, and the queue is not a feature

The sweep that has exactly the right shape already exists. `_runFeatureNudgeSweep` (`src/services/PlanIngestionEngine.ts:908`) wakes a head only when all four hold:

1. the feature still has an un-accepted subtask;
2. the head terminal is live and not `exited`;
3. the head's own `lastDataAt` is older than `turnEndSilenceMs` — it is not mid-turn (`:996-1000`);
4. no dispatch is outstanding for any of the feature's seats, and no turn-end notice for one fired on this tick (`:990`).

It composes **evidence** rather than a poke — remaining subtasks, their seats, how long each has been silent, plan-file mtimes — and paces itself to at most one nudge per `turnEndSilenceMs` window (`:1005-1008`). Its guards are already the hard-won ones: an empty liveness snapshot is treated as *no evidence* rather than "every head died" (`:924-931`), and a watch is never retried against a dead head.

Every one of those properties is what a queue watch needs. The sweep is not scoped wrongly by accident — it was built for feature watches (`kanban.featureWatches`, `:918`) because that was the case in hand. A queue is a second watch record type over the same machinery, not a second subsystem.

### Why this belongs next to subtask 1, not subtask 4

Scheduling survives (subtask 4 keeps it), so this is not "the thing that replaces the clock" — with a schedule enabled, a stalled lead is picked up by the next tick and the schedule *is* the recovery.

What this covers is the **schedule-off** session, and that case is introduced by subtask 1, not by subtask 4. The moment a lead can pace itself with no clock running, a lead that stops pacing is an overnight session that ends silently with work staged. So this lands alongside 1, before unpaced pull is offered to users — the constraint is real but it attaches earlier in the sequence than an earlier draft of this feature claimed.

The `retire-orchestrator-machinery` plan named the same class of dependency — *"deleting the cadence removes the only thing that currently restarts a stalled orchestrator"* — and the lesson generalises: never ship the thing that removes a recovery path before the replacement exists. Here the recovery path is only removed for users who turn the schedule off.

---

## Metadata

- **Complexity:** 4
- **Tags:** backend, reliability, bugfix
- **Feature:** 3e8b662b-a8a8-42c5-8e43-6d67998aa201

> **Superseded:** Complexity 3.
> **Reason:** The arming model turned out to be wrong in a way that voided the plan's own guarantee — a queue staged but never dispatched (subtask 7's remote intake, or `Stage for queue` with no lead) was unwatched, which is precisely the silent night this plan exists to prevent. Fixing it adds a second arming trigger, a third arming site, and a "no head ever seated" gate.
> **Replaced with:** Complexity 4.

---

## User Review Required

**None.** Five decisions made here:

* **A second watch record type on the existing sweep** — not a new timer, not a new service.
* **The nudge carries evidence, matching the feature nudge.** A head woken with "check your queue" has to re-derive everything it was just told.
* **One nudge, then escalate to the user.** A nudge stream is what a poll is, and a head that ignores two nudges is not going to answer a third.
* **A dead head ends the watch and notifies the user.** Silently dropping the watch is the failure this plan exists to prevent.
* **Staging arms the watch, not only dispatching.** A queue that never got its first dispatch is the worst case, not an exempt one.

---

## Complexity Audit

### Routine

- A second record type and config key beside `FeatureWatchRecord` / `kanban.featureWatches` (`PlanIngestionEngine.ts:110`, `:918`).
- A second sweep function called from the same tick with the same arguments — the call site already exists (`:523-524`).
- Delivery through `_turnEndNotifier` with `outcome: 'stalled'` and a `recipientSeat`, exactly as the feature nudge does (`:1041`).
- Reusing `turnEndSilenceMs` (`:337`) rather than adding a setting.

### Complex / Risky

- **Arming completeness.** The watch is only a guarantee if every path that can leave cards staged arms it: `queue/next`, `Stage for queue`, the Analyze button, and subtask 7's remote intake. A missed site is a silent night — the exact bug this plan exists to remove.
- **The "no head at all" state has no analogue in the feature sweep.** A feature watch always has a head; a queue can be staged before any team is seated. Dropping the watch because the head is absent would be wrong here.
- **Double-wake.** A head that is simultaneously a feature head and a queue head can be nudged twice on one tick. The shared `notifiedSeatsThisTick` set is the mechanism, and both sweeps must both read *and* write it.
- **The empty-liveness guard is a foot-gun to reimplement.** `:924-931` treats an empty snapshot as no evidence; a naive copy that treats it as "every head died" would destroy every watch and notify the user that every lead is gone.

---

## Edge-Case & Dependency Audit

### Race Conditions

- **Nudge racing a dispatch.** The head may be dispatching at the moment the sweep fires. Gate order puts "any card in flight for this team" before the nudge, and the in-flight predicate is subtask 1's column-scoped one, so a dispatch that has landed suppresses the nudge on the same tick.
- **Mid-turn injection.** A message delivered to a busy agent starts a turn (`switchboard-contracts` #9). The `lastDataAt` gate is what prevents injecting into a running turn, and it must be evaluated against the same `nowMs` the feature sweep uses — not a fresh `Date.now()`.
- **Two sweeps, one seat, one tick.** Both sweeps share `notifiedSeatsThisTick`; the queue sweep must add to it when it nudges, or a feature nudge later in the same tick double-wakes the head.

### Security

- None. No new surface; delivery uses the existing notifier into a terminal the user already owns.

### Side Effects

- The watch record is persisted config, so it survives a host restart. It must therefore be self-healing: a record naming a terminal that no longer exists is resolved by the gates, never by an assumption that it is still valid.
- Escalation writes to the user-facing notice path. Two escalations for one stalled queue would train the user to ignore it — `nudgeCount` is what bounds that, and it must reset on a real dispatch.

### Dependencies & Conflicts

- **Subtask 1 owns the arming call inside the pop.** That is only one arming site if every caller goes through `dispatchNextFromQueue` — which subtask 1 now guarantees by making the method, not the route, the contract.
- **Subtask 2's `Stage for queue` and subtask 7's remote staging** must call the same `armQueueWatch` helper. Staging is the *earliest* moment a silent night becomes possible.
- **Subtask 4 keeps turn-end detection** explicitly so this sweep keeps its silence signal. If turn-end were deleted, this plan's mid-turn gate loses its input.

---

## Dependencies

- `e060b8c4-27bd-48ac-a5d1-c72f557ea27a` — The Coding Lead Paces Its Own Pipeline *(hard: arms inside its pop; ship together before offering schedule-off pacing)*
- `7e0983cc-c3a6-44d4-be7f-5b03917153d6` — The Dispatch Column Becomes the Session Queue *(soft: supplies the staging path that is the second arming trigger)*

---

## Adversarial Synthesis

**Risk summary.** The plan's guarantee is only as complete as its arming coverage — the original dispatch-only trigger left a staged-but-never-dispatched queue unwatched, which is the worst version of the failure it claims to prevent. Mitigations: arm on staging as well as on dispatch through one shared helper, add a "no coding head seated" gate that notifies rather than drops the watch, and reuse the feature sweep's hard-won empty-liveness and mid-turn guards verbatim rather than reimplementing them. Residual risk is a double-wake, bounded by the shared per-tick notified-seat set.

---

## Proposed Changes

### `src/services/PlanIngestionEngine.ts` — the queue watch

**Context.** `FeatureWatchRecord` (`:110`) and `_runFeatureNudgeSweep` (`:908`) already implement every property a queue watch needs, and the sweep is already called from the liveness tick with `db, folder, liveness, nowMs, turnEndSilenceMs, notifiedSeatsThisTick` (`:523-524`).

**Logic.** A second record type over the same machinery.

```
interface QueueWatchRecord {
    headTerminal: string | null;   // null = staged with no coding head yet
    workspaceRoot: string;
    armedAt: number;
    lastNudgedAt: number;
    nudgeCount: number;
    noHeadNotifiedAt?: number;
}
```

**Implementation.**

1. **`QueueWatchRecord`** beside `FeatureWatchRecord`, persisted in a `kanban.queueWatches` config key.

2. **`armQueueWatch(workspaceRoot, headTerminal | null)`** — idempotent, exported, called from every path that can leave cards staged:
   - subtask 1's `dispatchNextFromQueue` (the pop);
   - subtask 2's `Stage for queue` and the Analyze button's staging;
   - subtask 7's remote intake staging.

   > **Superseded:** "Armed by the first dispatch of a session — inside the `queue/next` path from subtask 1, and by `Run queue` (subtask 2, which calls the same endpoint, so one arming site)."
   > **Reason:** It leaves the worst case unwatched. Cards can be staged and never dispatched at all — subtask 7 stages a remote batch with no dispatch by design, and a user can `Stage for queue` before seating a team. Under dispatch-only arming, a night where the lead never made its *first* call produces no watch, no nudge and no notice: exactly the silent night this plan exists to prevent, arriving through the one door the plan did not cover.
   > **Replaced with:** arm on **staging or dispatch**, whichever happens first, through one shared `armQueueWatch` helper. Re-arming an existing watch is a no-op that does not reset `nudgeCount`.

3. **`_runQueueNudgeSweep`**, called from the same tick as `_runFeatureNudgeSweep` and sharing its `liveness`, `nowMs`, `turnEndSilenceMs` and `notifiedSeatsThisTick` arguments. Gates, in order:
   - **empty liveness snapshot → return, change nothing** (the `:924-931` guard: no evidence is not "everyone died");
   - **queue empty → drop the watch silently** (the session ended normally);
   - **no coding head seated at all** (`headTerminal` null, or no live head resolvable) → keep the watch, and notify the user **once** naming the staged count: "N cards staged, no coding head is live." Stamp `noHeadNotifiedAt` so it is not repeated;
   - **head present in the record but absent or `exited`** → drop the watch and **notify the user**, naming the head and the number of cards left staged;
   - **any card in flight for this team** → keep, stay silent (subtask 1's column-scoped predicate; the per-dispatch watchdog owns that window);
   - **a seat notified this tick** → keep, stay silent (avoid a double wake);
   - **head `lastDataAt` within `turnEndSilenceMs`** → keep, stay silent (mid-turn; never inject into a running turn);
   - **otherwise nudge**, and add the head to `notifiedSeatsThisTick`.

4. **Evidence body**, mirroring the feature nudge's composition: how many cards remain staged, the next card's plan file, how long the head has been silent, and the exact call to make (`POST /kanban/queue/next` with its `from`). Delivered through `_turnEndNotifier` with `outcome: 'stalled'` and `recipientSeat` = the head — the path the feature nudge already uses (`:1041`).

5. **Pacing and escalation.** At most one nudge per watch per `turnEndSilenceMs` window. On the **second** nudge with no dispatch in between, stop nudging and surface to the user: the lead is not advancing, N cards remain. `nudgeCount` carries this and resets when a dispatch happens.

6. **Reuse `turnEndSilenceMs`** rather than adding a setting. One silence threshold across both sweeps; a second knob is a second thing to tune wrongly.

**Edge Cases.** A head that is both a feature head and a queue head is nudged at most once per tick. A watch whose workspace folder has gone away is dropped silently. A staged queue with no head, where a head is later seated, upgrades the record's `headTerminal` on the next arm or sweep rather than needing a re-stage.

---

## Verification Plan

### Automated Tests

- **Unit — each gate independently:** mid-turn head stays silent; in-flight card stays silent; empty queue drops silently; exited head drops with a user notice; no head seated notifies once and keeps the watch.
- **Unit — the arming-coverage regression (the one that matters):** stage cards with no dispatch at all and confirm a watch exists and eventually notifies. This is the case the original dispatch-only arming missed.
- **Unit — empty liveness snapshot** produces no nudge and drops no watch (the `:924-931` guard, which is the one that would silently destroy every watch if reimplemented carelessly).
- **Unit — pacing floor:** two sweep ticks inside one `turnEndSilenceMs` window produce one nudge.
- **Unit — escalation** fires on the second nudge with no intervening dispatch, and `nudgeCount` resets when a dispatch happens.
- **Unit — no double-wake:** a head that is both a feature head and a queue head receives one notice per tick.
- **Regression** — feature watches still nudge as they do today.

### Manual UAT

- Start a queue of three, let the first card finish, then kill the lead terminal. The user must be told the lead is gone and two cards remain — not discover it in the morning.
- Same setup, but leave the lead alive and unresponsive. It should receive exactly one nudge, then the user should be told.
- Stage three cards with no coding team seated at all. The user is told once that work is staged with no lead; the watch persists and picks up when a team is seated.

---

**Recommendation:** Complexity 4 → **Send to Coder.**

---

## Completion Report

Implemented the queue-level stall watch as a second record type over the existing feature-nudge machinery. Added `QueueWatchRecord` (persisted in `kanban.queueWatches`), `armQueueWatch` (idempotent, called from `dispatchNextFromQueue` with `onDispatch: true` to reset nudge state), and `_runQueueNudgeSweep` (called from the same tick as `_runFeatureNudgeSweep`, sharing `liveness`, `nowMs`, `turnEndSilenceMs`, and `notifiedSeatsThisTick`). The sweep reuses the `:924-931` empty-liveness guard verbatim (no evidence is not "every head died"), uses the column-scoped in-flight predicate from subtask 1, and both reads AND writes the shared `notifiedSeatsThisTick` set — also added the head to the set in the feature sweep's nudge path so a head that is both a feature head and a queue head is nudged at most once per tick. Gates: empty liveness → return; queue empty → drop silently; no head → notify user once, keep watch; head absent/exited → drop, notify user; card in flight → keep, reset nudge state; seat notified this tick → keep, stay silent; mid-turn → keep, stay silent; otherwise nudge with evidence, escalate to user on second nudge. Arming from `dispatchNextFromQueue` is wired; staging arming from `KanbanProvider.stageForQueue` is pending subtask 2's follow-up.

Files changed: `src/services/PlanIngestionEngine.ts` (`QueueWatchRecord` + `armQueueWatch` + `_runQueueNudgeSweep` + tick wiring + feature-sweep `notifiedSeatsThisTick.add`), `src/services/LocalApiServer.ts` (`armQueueWatch` option + call from `dispatchNextFromQueue`), `src/services/TaskViewerProvider.ts` (`_planIngestionEngine` field + `setPlanIngestionEngine` + `armQueueWatch` callback wiring), `src/extension.ts` (`setPlanIngestionEngine` call). No issues encountered; forbidden files (`KanbanProvider.ts`, `KanbanDatabase.ts`) untouched. Red-team found and fixed a cross-workspace watch-wipe bug (write-back now merges `kept` with `otherWatches`) and a bidirectional double-wake gap (feature sweep now writes the head to `notifiedSeatsThisTick` on nudge).
