# Retire the Clock — Delete the Trigger Modes, the Interval, the Cron and the Wake Tick

## Goal

Delete the pacing machinery. No interval timer, no `drain`/`watch`/`completion` trigger modes, no WHEN cron, no empty-column sweep, no orchestrator wake tick, no three-mode axis. Automation becomes one thing: a queue the lead walks (plans 1–2) with a watchdog behind it (plan 3).

### Problem & background

**Every timer in this subsystem exists to answer "is it time to dispatch the next card?" — a question the lead can now answer directly.**

What is currently installed to answer it:

* **`AutobanTriggerMode`** — three ways a column decides when to dispatch (`src/services/autobanState.ts:13`). `drain` and `watch` install per-column intervals; `completion` installs none and waits for a turn-end.
* **`AutobanAutomationMode`** — three ways the *board* is driven (`autobanState.ts:49`): `scheduled` (Switchboard runs the run sheet), `agent-managed` (wake an orchestrator every N minutes to decide), `external` (export a cron prompt, run nothing).
* **The run-sheet engine** — `_startAutobanEngine` (`src/services/TaskViewerProvider.ts:12563`) installs an interval, or a cron timer when `whenSchedule` is set, plus a 60-second empty-column sweep to auto-stop, plus a column-change subscription with its own debounce timers.
* **Completion-driven dispatch** — `handleAutobanTurnEnd` (`TaskViewerProvider.ts:1541`) plus `_autobanDispatchedPlanFiles`, `_autobanLaneInFlight`, `_autobanStallWatchdogs`, `_autobanPlanFileKey`.

The state carrying all of it: `_autobanTimers`, `_autobanLastTickAt`, `_autobanWatchDisp`, `_autobanWatchDebounceTimers`, `_autobanTickQueue`, `_autobanEmptyColumnSweepTimer`, `pausedRemainingMs`, `whenSchedule`, `intervalMinutes` in two separate config shapes.

**The interlock cost is the real cost.** These pieces cannot be reasoned about independently. `handleAutobanTurnEnd` must suppress itself when `whenSchedule` is set or the cron is bypassed (`:1576`). `_startAutobanEngine` must refuse to install an interval in `agent-managed` mode or a second clock appears (`:12573`) — a comment that explicitly records the near-miss: gating on `!== 'external'` was correct with two modes and became a bug when the third arrived. `_autobanLaneInFlight` exists because one turn-end walks every run-sheet step and would otherwise fan one completion into a dispatch per lane, growing in-flight count per generation (`:1654-1670`). Each guard is individually correct and the combination is what produces UAT failures nobody can localise.

### Root cause — pacing was modelled as scheduling

A clock is the right tool when you cannot be told that work finished. Once the worker can tell you, a clock is a second, worse source of truth about the same fact — and every guard above is the cost of reconciling the two. Plans 1–3 remove the need to reconcile: the lead says when, the queue says what, the watchdog says when nobody said anything.

### Migration

The installed automation is old and the operator has confirmed it is not worth preserving, so this is a clean break rather than a mapped migration. **One safety guard remains, and it is not about data.** `automationMode` is persisted with an `enabled` flag, and `normalizeAutomationMode` (`autobanState.ts:286`) currently maps everything unrecognised onto `scheduled` specifically so an upgrade cannot disarm a running board. Under the new model that default inverts: an install arriving with `enabled: true` under a retired mode must land **disabled**, because the new semantics would otherwise begin dispatching from a queue the user never staged. Preserving nothing is fine; auto-arming under new rules is not.

---

## Metadata

- **Complexity:** 4
- **Tags:** backend, refactor, reliability
- **Feature:** 3e8b662b-a8a8-42c5-8e43-6d67998aa201

---

## User Review Required

**None.** Five decisions made here:

* **Clean break on persisted automation state** — no value mapping, per the operator's call that the shipped automation is not worth carrying.
* **Legacy `enabled: true` lands disabled**, with a one-time notice. The only non-negotiable in this plan.
* **`external` mode survives as an export, not a mode.** Emitting a copyable prompt runs no clock and conflicts with nothing; it becomes a button rather than an exclusive axis value.
* **The per-dispatch stall watchdog survives.** It watches a coder working a card — a different failure from a stalled pacer, and still needed.
* **Turn-end detection survives.** It drives the activity light and feeds plan 3's sweep; only its role as a *dispatch trigger* is deleted.

---

## Implementation

**Blocked on plans 1, 2 and 3.** Do not merge before all three are in — the clock is currently the only thing that restarts a stalled lane.

1. **Delete `AutobanTriggerMode`** and its normaliser, `_isCompletionTriggered` (`TaskViewerProvider.ts:12321`), `isWatchColumn`, and the per-column `rules` map that only exists to carry per-column intervals and trigger modes.

2. **Delete the run-sheet engine:** `_startAutobanEngine` / `_stopAutobanEngine`, `_enqueueRunSheetTick`, `DEFAULT_AUTOBAN_RUN_SHEET`, `AUTOBAN_RUN_SHEET_TICK_KEY`, the WHEN cron path (`_startWhenScheduleTimer` / `_clearWhenScheduleTimer`), the empty-column sweep, and the column-change subscription with its debounce timers.

3. **Delete completion-driven dispatch:** `handleAutobanTurnEnd`'s dispatch arm, `_autobanDispatchedPlanFiles`, `_autobanLaneInFlight`, `_autobanPlanFileKey`. Keep the turn-end notifier itself.

4. **Collapse the mode axis.** `AutobanAutomationMode` goes. `enabled` becomes "a queue session is running", set by the first dispatch and cleared when the queue empties or the user stops. The `agent-managed` wake interval and `orchestrationConfig.intervalMinutes` go with it.

5. **`normalizeAutobanConfigState`** returns the new shape and forces `enabled: false` for any state carrying a retired `automationMode`, setting a one-time notice field the panel renders (the pattern `migratedBoardBatchNotice` already uses).

6. **Automation panel.** The three-mode selector, interval input, cron field and trigger-mode controls are replaced by queue state: how many cards are staged, which lead is pacing, what is in flight, and a Stop. `external` becomes a `Copy cron prompt` button.

7. **Sweep the agent-facing docs.** `switchboard-contracts` #2 needs its "load-bearing for progression" claim narrowed to the activity light. The `switchboard-orchestration` route table, `GET /catalog` and the orchestrator persona all describe the deleted modes. A contracts doc describing a deleted mechanism is worse than none.

---

## Verification Plan

- **Unit:** `normalizeAutobanConfigState` forces `enabled: false` for every retired `automationMode` value (`scheduled`, `agent-managed`, `external`, `run-sheet`, `scheduler`, `single-column`, `internal`, `orchestration`) and sets the notice.
- **Unit:** no timer is installed on any code path. Assert `_autobanTimers` and the cron/sweep handles no longer exist as symbols — a grep-level contract test, since the failure mode being prevented is a surviving timer.
- **Unit:** turn-end still clears the activity light and still feeds the plan-3 sweep, and no longer dispatches.
- **Manual UAT:** upgrade an install that has `scheduled` + `enabled: true` persisted. Nothing dispatches on load; the notice explains why and the queue is empty.
- **Manual UAT:** a full five-card overnight run with no timers present, then the plan-3 stall cases, to confirm the watchdog is genuinely carrying what the clock used to.
- **Regression:** the per-dispatch stall watchdog still fires for a coder that dies mid-card.
