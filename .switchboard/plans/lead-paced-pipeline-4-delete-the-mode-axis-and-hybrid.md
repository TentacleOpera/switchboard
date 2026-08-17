# Delete the Mode Axis and the Completion Hybrid — Keep a Plain Scheduler

## Goal

Delete the three-mode exclusivity, the per-column trigger modes, and completion-driven dispatch. **Keep scheduling.** A schedule becomes one more caller of `POST /kanban/queue/next` (subtask 1) alongside the lead and the `Run queue` button — so "fire at 2am", "one at a time as work completes", and "start now" are three callers of one dispatch path rather than three competing subsystems.

### Problem & background

**The mess is the hybrid and the mode axis, not the clock.**

An earlier draft of this plan argued that every timer here exists to answer "is it time to dispatch the next card?" and should therefore go. That was wrong, and it is worth stating why plainly, because the wrong framing would have deleted a genuinely good feature.

A **pure** scheduler needs no completion signal at all. "Fire on this cron line and dispatch N" is one timer, one call, no state. It needs no agent, cannot misjudge, costs no context, and keeps running when a lead dies. It is the simplest way to code plans, and nothing below is a criticism of it.

What actually produces the UAT failures is four things, none of which is scheduling:

1. **The completion hybrid.** `completion` is a *trigger mode inside the clock engine* (`src/services/autobanState.ts:13`): no interval, one card in flight, next dispatch driven by turn-end. Wiring completion-pacing into a run sheet requires `_autobanLaneInFlight` (`TaskViewerProvider.ts:1665`), which exists solely because one turn-end walks **every** run-sheet step and would otherwise fan one completion into a dispatch per lane, growing the in-flight count each generation.
2. **Mutual suppression between the hybrid and the cron.** `handleAutobanTurnEnd` must suppress itself when `whenSchedule` is set (`:1576`) or a completion bypasses the schedule. Two mechanisms deciding one question, each having to know about the other.
3. **The three-mode axis.** `_startAutobanEngine` must refuse to install an interval in `agent-managed` mode (`:12573`), and the comment records the near-miss: gating on `!== 'external'` was correct with two modes and became a bug the moment a third arrived. Exclusivity between modes is what makes every mode's start path a case analysis of the others.
4. **Completion inferred from plan-file `mtime`** (`switchboard-contracts` #2). This is why plan files must be write-once-at-the-end and why a mid-work edit breaks pacing for a whole lane. Not scheduling — a filesystem side effect load-bearing for board progression.

Per-column `AutobanTriggerMode` multiplies all four across columns.

### Root cause — two different questions were answered by one interlocked mechanism

"Start at 2am" and "start the next card when the last one finishes" are different questions with different right answers. Both were implemented inside one engine, as modes of each other, so each had to disable the other. Everything hard here is the coupling, not either mechanism.

**Subtask 1 already removed the need for the coupling, and this plan only has to notice.** `POST /kanban/queue/next` refuses with `409` when the requesting team already has a card in flight — server-side, at one serialization point. So a schedule that fires into a busy team is simply refused. No suppression logic. No lane maps. No mode exclusivity. A schedule and a self-pacing lead can both be live because neither decides anything the endpoint does not arbitrate.

### What survives, and why keeping it is less work than deleting it

* **The cron path.** `whenSchedule` already accepts a 5-field cron and already fires (`_startWhenScheduleTimer`). Keeping it costs nothing; deleting it costs work *and* removes the feature.
* **The interval path**, as the plain "every N minutes, try to dispatch" option.
* **`fetch-plans` and `reconcile`** — see the scope note below.
* **The per-dispatch stall watchdog.** It watches a coder working a card, a different failure from a stalled pacer.
* **Turn-end detection.** It drives the activity light and feeds subtask 3's queue watch. Only its role as a *dispatch trigger* is deleted.

### Scope note — the trap inside the run-sheet tick

**The scheduler surface is already retired and is not this plan's business.** Custom scheduler jobs are dropped on read with a one-time notice — *"the scheduler surface has been retired"* (`TaskViewerProvider.ts:1248`) — records preserved in `integration-config.json`. Nothing here changes that.

**But two presets survived it, and they ride the tick.** `schedulerPresets.ts:8`: *"The scheduler SURFACE is retired; the two prompts it used to emit are not."*

* `fetch-plans` — pulls plan files authored on remote branches (typically a cloud VM) into local `.switchboard/plans/`.
* `reconcile` — pulls recent remote branches, scans for new `## Completion Report` / `## Review Findings` sections, advances cards forward-only via `kanban_operations`.

They have **no interval of their own**: the run-sheet tick calls `_tickSurvivorSchedulerJobs()` at `:12367`, under a comment stating *"the run sheet is the one clock."* Because this plan now keeps a scheduler, they have a home to stay in — but the tick they hang off is being restructured, so they must be explicitly re-attached and tested, not assumed. Their survival was nearly lost to the earlier framing of this plan, which is itself the argument for keeping scheduling: the codebase kept these two precisely because scheduled work is useful.

---

## Metadata

- **Complexity:** 4
- **Tags:** backend, refactor, reliability
- **Feature:** 3e8b662b-a8a8-42c5-8e43-6d67998aa201

---

## User Review Required

**None.** Six decisions made here:

* **Scheduling is kept as a first-class option, not deleted.** It is the simplest mechanical way to code plans, it needs no agent, and it survives a dead lead. Deleting it was an error in an earlier draft of this plan.
* **The schedule calls `queue/next` rather than dispatching directly.** One dispatch path, three callers (lead, button, schedule). A second dispatch path is how the two mechanisms would start needing to know about each other again.
* **`queue/next`'s 409 replaces every suppression guard.** No lane maps, no mutual disabling, no mode exclusivity — one serialization point arbitrates.
* **`completion` trigger mode goes.** Its behaviour — next card when the last finishes — is what subtask 1 does natively and better, without inferring completion from a filesystem side effect.
* **The mode axis goes; the modes stop being exclusive.** A schedule and a self-pacing lead may both be live.
* **Legacy `enabled: true` lands disabled**, with a one-time notice. Clean break on persisted values per the operator's call, but an upgrade must never start dispatching from a queue the user never staged.

---

## Implementation

**Blocked on subtask 1** — `queue/next` and its `409` in-flight refusal must exist before the schedule can call it, and that refusal is what makes every suppression guard here deletable. Subtask 2 is wanted in practice (a schedule with nothing staged has nothing to dispatch) but is not a correctness prerequisite. Subtask 3 is no longer a prerequisite of this plan: scheduling survives, so this plan removes no recovery path — 3 covers the schedule-off case and belongs beside subtask 1.

1. **Re-attach the survivor jobs first.** Give `_tickSurvivorSchedulerJobs` an explicit home with its own START/STOP tied to workspace activation, not to a queue session — a cloud VM pushes plans whether or not a queue is running. First commit, verified before anything is deleted. Keep `_schedulerInFlight` (it guards a survivor job against re-entry, not a pacing decision).

2. **Point the schedule at `queue/next`.** The interval and cron timers stop calling `_autobanTickColumn` / the run sheet and instead call the queue endpoint `batchSize` times, accepting each `409` as a normal outcome that needs no logging beyond debug. This is the change that makes everything below deletable.

3. **Delete `AutobanTriggerMode`** and its normaliser, `_isCompletionTriggered` (`:12321`), `isWatchColumn`, and the per-column `rules` map that exists only to carry per-column intervals and trigger modes.

4. **Delete completion-driven dispatch:** `handleAutobanTurnEnd`'s dispatch arm, `_autobanDispatchedPlanFiles`, `_autobanLaneInFlight`, `_autobanPlanFileKey`, and the `whenSchedule` suppression branch at `:1576`. Keep the turn-end notifier.

5. **Delete the run sheet as a decision structure.** `DEFAULT_AUTOBAN_RUN_SHEET`, `_enqueueRunSheetTick`'s step walk, `_autobanTickColumn`'s routing, the empty-column sweep and the column-change subscription with its debounce timers. What replaces the step walk is `queue/next` deciding, once, what to dispatch.

6. **Collapse the mode axis.** `AutobanAutomationMode` goes. Scheduling becomes an independent on/off with an interval or cron; the orchestrator's `agent-managed` wake interval and `orchestrationConfig.intervalMinutes` go (subtask 6 replaces that path with handoff).

7. **`normalizeAutobanConfigState`** returns the new shape and forces `enabled: false` for any state carrying a retired `automationMode`, with a one-time notice (the `migratedBoardBatchNotice` pattern).

8. **Automation panel.** The three-mode selector and trigger-mode controls are replaced by: queue state (staged count, pacing lead, in flight), and a schedule control (off / every N minutes / cron). `external` becomes a `Copy cron prompt` button rather than an exclusive mode.

9. **Sweep the agent-facing docs.** `switchboard-contracts` #2's "load-bearing for progression" claim narrows to the activity light. The `switchboard-orchestration` route table, `GET /catalog` and the orchestrator persona all describe the deleted modes.

---

## Verification Plan

- **Unit — the point of the whole plan:** a schedule firing into a team with a card in flight gets `409` and dispatches nothing, with **no suppression code involved**. Assert no lane-tracking state exists.
- **Unit:** a schedule firing into an idle team with a staged queue dispatches exactly one card per `batchSize` unit.
- **Unit:** a schedule and a self-pacing lead both live do not double-dispatch — the endpoint's serialization is the only guard.
- **Unit:** cron parsing and firing still work, and an invalid cron degrades to the interval with an honest log rather than a clockless void.
- **Unit:** turn-end still clears the activity light and feeds subtask 3's watch, and no longer dispatches.
- **Unit:** `normalizeAutobanConfigState` forces `enabled: false` for every retired `automationMode` value (`scheduled`, `agent-managed`, `external`, `run-sheet`, `scheduler`, `single-column`, `internal`, `orchestration`) and sets the notice.
- **Unit — the silent-loss guard:** `fetch-plans` and `reconcile` still fire with no queue session and no schedule enabled. This is the test that would have caught the defect an earlier draft of this plan shipped with.
- **Manual UAT — schedule only:** stage five, set a 2-minute interval, no lead pull instruction. Five cards run one at a time, paced by the clock, refusals invisible.
- **Manual UAT — pull only:** stage five, no schedule. Five cards run one at a time, paced by the lead.
- **Manual UAT — both:** stage five with both live. Still five runs, no doubles.
- **Manual UAT — cloud-VM round trip:** `fetch-plans` pulls a remote-authored plan; a `## Completion Report` added to a pulled plan is advanced forward-only by `reconcile`.
