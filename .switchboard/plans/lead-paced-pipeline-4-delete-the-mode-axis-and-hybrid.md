# Delete the Mode Axis and the Completion Hybrid — Keep a Plain Scheduler

## Goal

Delete the three-mode exclusivity, the per-column trigger modes, and completion-driven dispatch. **Keep scheduling.** A schedule becomes one more caller of subtask 1's queue pop alongside the lead and the `Run queue` button — so "fire at 2am", "one at a time as work completes", and "start now" are three callers of one dispatch path rather than three competing subsystems.

### Problem & background

**The mess is the hybrid and the mode axis, not the clock.**

An earlier draft of this plan argued that every timer here exists to answer "is it time to dispatch the next card?" and should therefore go. That was wrong, and it is worth stating why plainly, because the wrong framing would have deleted a genuinely good feature.

A **pure** scheduler needs no completion signal at all. "Fire on this cron line and dispatch N" is one timer, one call, no state. It needs no agent, cannot misjudge, costs no context, and keeps running when a lead dies. It is the simplest way to code plans, and nothing below is a criticism of it.

What actually produces the UAT failures is four things, none of which is scheduling:

1. **The completion hybrid.** `completion` is a *trigger mode inside the clock engine* (`AutobanTriggerMode`, `src/services/autobanState.ts:13`): no interval, one card in flight, next dispatch driven by turn-end. Wiring completion-pacing into a run sheet requires `_autobanLaneInFlight` (`TaskViewerProvider.ts` ≈`:1739`), which exists solely because one turn-end walks **every** run-sheet step and would otherwise fan one completion into a dispatch per lane, growing the in-flight count each generation.
2. **Mutual suppression between the hybrid and the cron.** `handleAutobanTurnEnd` (≈`:1615`) must suppress itself when `whenSchedule` is set (≈`:1650`) or a completion bypasses the schedule. Two mechanisms deciding one question, each having to know about the other.
3. **The three-mode axis.** `_startAutobanEngine` (≈`:12637`) must refuse to install an interval in `agent-managed` mode, and the comment records the near-miss: gating on `!== 'external'` was correct with two modes and became a bug the moment a third arrived. Exclusivity between modes is what makes every mode's start path a case analysis of the others.
4. **Completion inferred from plan-file `mtime`** (`switchboard-contracts` #2). This is why plan files must be write-once-at-the-end and why a mid-work edit breaks pacing for a whole lane. Not scheduling — a filesystem side effect load-bearing for board progression.

Per-column `AutobanTriggerMode` multiplies all four across columns.

### Root cause — two different questions were answered by one interlocked mechanism

"Start at 2am" and "start the next card when the last one finishes" are different questions with different right answers. Both were implemented inside one engine, as modes of each other, so each had to disable the other. Everything hard here is the coupling, not either mechanism.

**Subtask 1 already removed the need for the coupling, and this plan only has to notice.** The queue pop refuses with `409` when the requesting team already has a card in flight — server-side, at one serialization point. So a schedule that fires into a busy team is simply refused. No suppression logic. No lane maps. No mode exclusivity. A schedule and a self-pacing lead can both be live because neither decides anything the pop does not arbitrate.

### What survives, and why keeping it is less work than deleting it

* **The cron path.** `whenSchedule` already accepts a 5-field cron and already fires (`_startWhenScheduleTimer`, ≈`:12589-12632`). Keeping it costs nothing; deleting it costs work *and* removes the feature.
* **The interval path**, as the plain "every N minutes, try to dispatch" option.
* **`fetch-plans` and `reconcile`** — see the scope note below.
* **The per-dispatch stall watchdog** (`_armAutobanStallWatchdog`, ≈`:1696`). It watches a coder working a card, a different failure from a stalled pacer.
* **Turn-end detection.** It drives the activity light and feeds subtask 3's queue watch. Only its role as a *dispatch trigger* is deleted.
* **The orchestrator wake.** See the correction under *Collapse the mode axis* — the exclusive mode dies, the wake does not.

### Scope note — the trap inside the run-sheet tick

**The scheduler surface is already retired and is not this plan's business.** Custom scheduler jobs are dropped on read with a one-time notice — *"the scheduler surface has been retired"* (`TaskViewerProvider.ts` ≈`:1322`) — records preserved in `integration-config.json`. Nothing here changes that.

**But two presets survived it, and they ride the tick.** `schedulerPresets.ts:1-10`: *"The scheduler SURFACE is retired; the two prompts it used to emit are not."*

* `fetch-plans` — pulls plan files authored on remote branches (typically a cloud VM) into local `.switchboard/plans/`.
* `reconcile` — pulls recent remote branches, scans for new `## Completion Report` / `## Review Findings` sections, advances cards forward-only via `kanban_operations`.

They have **no interval of their own**: the run-sheet tick calls `_tickSurvivorSchedulerJobs()` (≈`:12441`), under a comment stating *"the run sheet is the one clock."* Because this plan now keeps a scheduler, they have a home to stay in — but the tick they hang off is being restructured, so they must be explicitly re-attached and tested, not assumed. Their survival was nearly lost to the earlier framing of this plan, which is itself the argument for keeping scheduling: the codebase kept these two precisely because scheduled work is useful.

---

## Metadata

- **Complexity:** 7
- **Tags:** backend, refactor, reliability
- **Feature:** 3e8b662b-a8a8-42c5-8e43-6d67998aa201

> **Superseded:** Complexity 4.
> **Reason:** A 4 does not survive contact with the surface area. This plan deletes a type and its normaliser, a per-column rules map, a run sheet, a completion hybrid and a mode axis across `TaskViewerProvider.ts`, `autobanState.ts`, the automation panel, four agent-facing docs and a sibling subtask's arming write — while **seven** separate sites install a timer under the same `AUTOBAN_RUN_SHEET_TICK_KEY` across at least three entry paths (`_startAutobanEngine`, the set-from-kanban path, and a resume path the code explicitly labels "a THIRD timer-install path"). It also inverts a legacy-state normaliser deliberately written to keep ~4,000 shipped installs ticking. Multi-file coordination plus a breaking change to persisted state on shipped installs is the definition of the 7–10 band.
> **Replaced with:** Complexity 7.

---

## User Review Required

**None.** Six decisions made here:

* **Scheduling is kept as a first-class option, not deleted.** It is the simplest mechanical way to code plans, it needs no agent, and it survives a dead lead. Deleting it was an error in an earlier draft of this plan.
* **The schedule calls the queue pop rather than dispatching directly.** One dispatch path, three callers (lead, button, schedule). A second dispatch path is how the two mechanisms would start needing to know about each other again.
* **The pop's `409` replaces every suppression guard.** No lane maps, no mutual disabling, no mode exclusivity — one serialization point arbitrates.
* **`completion` trigger mode goes.** Its behaviour — next card when the last finishes — is what subtask 1 does natively and better, without inferring completion from a filesystem side effect.
* **The mode axis goes; the modes stop being exclusive.** A schedule and a self-pacing lead may both be live.
* **Legacy `enabled: true` lands disabled**, with a one-time notice. Clean break on persisted values per the operator's call, but an upgrade must never start dispatching from a queue the user never staged.

---

## Complexity Audit

### Routine

- Deleting a type alias and its normaliser once every call site is gone.
- Replacing the automation panel's three-mode selector with two independent controls.
- Doc sweeps across `switchboard-contracts`, the `switchboard-orchestration` route table, `GET /catalog` and the orchestrator persona.

### Complex / Risky

- **Seven timer-install sites, one key.** `_autobanTimers.set(AUTOBAN_RUN_SHEET_TICK_KEY, …)` appears seven times across three entry paths, one of which the code labels "a THIRD timer-install path alongside `_startAutobanEngine`". Deleting the run sheet from one path leaves the others installing timers into a tick that no longer exists — silently, with no compile error.
- **The survivor jobs fail silently when orphaned.** Deleting the tick under `_tickSurvivorSchedulerJobs` produces **no compile error and no failing test**: cloud-VM plans quietly stop arriving and completion reports quietly stop advancing cards. This is the highest-consequence, lowest-visibility failure in the feature.
- **The legacy-state guard is a deliberate inversion of shipped behaviour.** `normalizeAutomationMode` (`autobanState.ts:286-292`) maps *everything* unrecognised onto `scheduled` — a **running** mode — with the comment "a whitelist that fell through would silently disarm a shipped install's clock". Inverting it is correct here and is a behaviour change on ~4,000 installs; it needs the one-time notice, not a silent flip.
- **`_isCompletionTriggered` has seven call sites** and `isWatchColumn` has two plus an import. Each is a branch whose removal changes a start path.
- **A sibling subtask writes the field being deleted.** Subtask 6's `/confirm` arming block sets `automationMode: 'agent-managed'`; that write must be swept in this plan, not left dangling.

---

## Edge-Case & Dependency Audit

### Race Conditions

- **Schedule firing into a busy team** — this is the point of the plan: the pop's `409` arbitrates, and the schedule treats it as a normal outcome needing no logging beyond debug.
- **Schedule and lead firing at the same instant** — both enter the same serialized critical section; the second sees the first's dispatch and is refused. No lane map, no suppression flag.
- **Timer teardown racing an in-flight tick.** Removing the run sheet while a tick is mid-await must not leave a partially-walked step set. The replacement (a schedule that makes N pop calls) is stateless between calls, which removes the class.

### Security

- None. No new surface; this deletes surfaces.

### Side Effects

- **`switchboard-contracts` #2 changes meaning.** "Completion signal = first plan-file `mtime` advance after dispatch" stops being load-bearing for board *progression* and narrows to the activity light and subtask 3's silence input. Agents read that file as behaviour of record — leaving it unedited leaves a documented contract that no longer holds.
- **The activity light must keep working.** Turn-end detection survives; only its dispatch arm is removed. A change that removes the notifier entirely breaks subtask 3's mid-turn gate.
- **`_schedulerInFlight` is kept** — it guards a survivor job against re-entry, not a pacing decision.
- **The automation panel changes shape**, and a user upgrading into the disabled state must be able to see why (the one-time notice) and re-enable in one click.

### Dependencies & Conflicts

- **Hard prerequisite: subtask 1.** The pop and its `409` must exist before the schedule can call it, and that refusal is what makes every suppression guard here deletable. The schedule calls `dispatchNextFromQueue` **in-process**, not over localhost HTTP.
- **Subtask 2 is wanted in practice** (a schedule with nothing staged has nothing to dispatch) but is not a correctness prerequisite.
- **Subtask 3 is not a prerequisite of this plan.** Scheduling survives, so this plan removes no recovery path — subtask 3 covers the schedule-off case and belongs beside subtask 1.
- **Subtask 6 must land before this plan** so its `/confirm` write is a known, single site to sweep rather than a merge conflict.
- **Persona edits serialise** with subtasks 5, 6 and 7 — this plan's doc sweep goes last.

---

## Dependencies

- `e060b8c4-27bd-48ac-a5d1-c72f557ea27a` — The Coding Lead Paces Its Own Pipeline *(hard: supplies the pop and its `409`)*
- `7e0983cc-c3a6-44d4-be7f-5b03917153d6` — The Dispatch Column Becomes the Session Queue *(soft: supplies something for the schedule to dispatch)*
- `c4b903af-effd-4f30-b81d-9edc2b8bc3ab` — The Orchestrator Hands Off and Exits *(ordering: land it first; this plan sweeps its `/confirm` mode write)*

---

## Adversarial Synthesis

**Risk summary.** The failure that would cost real work is silent: orphaning `fetch-plans` / `reconcile` when the run-sheet tick is restructured produces no compile error and no red test, and the symptom is cloud-VM plans that stop arriving. Mitigation is to re-attach both to an explicit workspace-activation-scoped timer as the **first** commit, with a test that asserts they fire with no queue session and no schedule enabled. The second risk is partial deletion: seven timer-install sites share one key across three entry paths, so removing the run sheet from one leaves the others installing into a void. Third is the legacy normaliser inversion on ~4,000 shipped installs, mitigated by forcing `enabled: false` plus a one-time notice rather than a silent flip.

---

## Proposed Changes

### 1. `src/services/TaskViewerProvider.ts` — re-attach the survivor jobs **first**

**Context.** `_tickSurvivorSchedulerJobs` (≈`:12441`) has no timer of its own; it rides the run-sheet tick under the comment "the run sheet is the one clock."

**Implementation.** Give it an explicit home with its own START/STOP tied to **workspace activation**, not to a queue session — a cloud VM pushes plans whether or not a queue is running. This is the first commit, verified before anything is deleted. Keep `_schedulerInFlight`.

**Edge Cases.** Activation/deactivation cycles must not stack timers. The job must be a no-op (not an error) when no remote branches exist.

### 2. `src/services/TaskViewerProvider.ts` — point the schedule at the queue pop

**Implementation.** The interval and cron timers stop calling `_autobanTickColumn` / the run sheet and instead call subtask 1's `dispatchNextFromQueue` `batchSize` times, accepting each `409` as a normal outcome. This is the change that makes everything below deletable.

**Edge Cases.** An invalid cron degrades to the interval with an honest log (today's behaviour, ≈`:12666-12670`), never to a clockless void.

### 3. Delete the trigger-mode axis

`AutobanTriggerMode` and its normaliser (`autobanState.ts:13`, `:149`), `_isCompletionTriggered` (≈`:12402`, **seven** call sites), `isWatchColumn` (imported at ≈`:140`, used ≈`:10170` and ≈`:12762`), and the per-column `rules` map that exists only to carry per-column intervals and trigger modes.

### 4. Delete completion-driven dispatch

`handleAutobanTurnEnd`'s dispatch arm, `_autobanDispatchedPlanFiles`, `_autobanLaneInFlight`, `_autobanPlanFileKey`, and the `whenSchedule` suppression branch (≈`:1650`). **Keep the turn-end notifier** — it drives the activity light and feeds subtask 3.

### 5. Delete the run sheet as a decision structure

`DEFAULT_AUTOBAN_RUN_SHEET`, `_enqueueRunSheetTick`'s step walk, `_autobanTickColumn`'s routing, the empty-column sweep, and the column-change subscription with its debounce timers. What replaces the step walk is one pop deciding, once, what to dispatch.

**Implementation note — the seven-site sweep.** Every `_autobanTimers.set(AUTOBAN_RUN_SHEET_TICK_KEY, …)` must be accounted for, across all three entry paths including the one the code labels "a THIRD timer-install path alongside `_startAutobanEngine`". Grep the key, not the function: a path missed here installs a timer into a tick that no longer exists, with no compile error.

### 6. Collapse the mode axis — into **two independent switches**, not zero

> **Superseded:** "`AutobanAutomationMode` goes. Scheduling becomes an independent on/off with an interval or cron; the orchestrator's `agent-managed` wake interval and `orchestrationConfig.intervalMinutes` go (subtask 6 replaces that path with handoff)."
> **Reason:** It contradicts subtask 6, which keeps `armed` as the terminal state for genuine multi-team coordination and defines it as "wake interval installed". Subtask 6 makes handoff the *default* and arming the *exception* — it does not delete arming. Deleting the wake interval here would leave an armed multi-team session with no mechanism, i.e. an exception path that does nothing.
> **Replaced with:** the **exclusive three-mode axis** is what dies. `AutobanAutomationMode` goes and the modes stop being mutually suppressing; what replaces it is two independent switches that may both be on:
> - **Queue schedule** — on/off, with an interval or a cron. Calls the pop.
> - **Orchestrator armed** — on/off, with its wake interval, on `orchestrationConfig` (which already carries `intervalMinutes`, `autobanState.ts:102-106`). Set only by `/orchestration/confirm`, cleared by `/orchestration/stop`, untouched by handoff.
>
> `external` becomes a `Copy cron prompt` button rather than an exclusive mode.

**Implementation.** Sweep subtask 6's `confirmOrchestrationSession` write (`TaskViewerProvider.ts` ≈`:10695-10721`) so arming sets the orchestrator switch instead of `automationMode: 'agent-managed'`, and drop the `_stopAutobanEngine()` call that existed only to stop a `scheduled` run sheet surviving the transition — with no exclusivity, there is nothing to tear down. Update the armed predicate (≈`:1391`, currently `automationMode === 'agent-managed' && enabled`) to read the new switch.

### 7. `src/services/autobanState.ts` — the legacy-state guard

**Context.** `normalizeAutomationMode` (`:286-292`) deliberately maps every unrecognised value onto `scheduled`, a **running** mode, "so a whitelist that fell through would [not] silently disarm a shipped install's clock". Retired values (`run-sheet`, `scheduler`, `single-column`, `orchestration`, `internal` + `orchestrationConfig.enabled`) map rather than fall through.

**Implementation.** `normalizeAutobanConfigState` returns the new shape and **forces `enabled: false`** for any state carrying a retired `automationMode`, with a one-time notice (the `migratedBoardBatchNotice` pattern). This inverts the guard on purpose: under the old shape an unrecognised value meant "keep ticking the board"; under the new shape there is no run sheet to tick, and starting to dispatch from a queue the user never staged is the worse failure.

**Edge Cases.** Preserve unknown/legacy keys rather than dropping them. The notice must be shown once, not per board load.

### 8. Automation panel

Replace the three-mode selector and trigger-mode controls with: **queue state** (staged count, pacing lead, in flight) and a **schedule control** (off / every N minutes / cron). The orchestrator switch is shown where arming already lives. `external` becomes a `Copy cron prompt` button.

### 9. Sweep the agent-facing docs

`switchboard-contracts` #2's "load-bearing for progression" claim narrows to the activity light and the silence signal. The `switchboard-orchestration` route table, `GET /catalog` and the orchestrator persona all describe the deleted modes.

---

## Verification Plan

### Automated Tests

- **The point of the whole plan:** a schedule firing into a team with a card in flight gets `409` and dispatches nothing, with **no suppression code involved**. Assert no lane-tracking state exists.
- **The silent-loss guard:** `fetch-plans` and `reconcile` still fire with no queue session and no schedule enabled. This is the test that would have caught the defect an earlier draft of this plan shipped with.
- **Timer-site sweep:** after the change, no timer is installed under `AUTOBAN_RUN_SHEET_TICK_KEY` by any path, from a cold start, from the set-from-kanban path, and from resume.
- A schedule firing into an idle team with a staged queue dispatches exactly one card per `batchSize` unit.
- A schedule and a self-pacing lead both live do not double-dispatch — the pop's serialization is the only guard.
- Cron parsing and firing still work; an invalid cron degrades to the interval with an honest log.
- Turn-end still clears the activity light and feeds subtask 3's watch, and no longer dispatches.
- `normalizeAutobanConfigState` forces `enabled: false` for every retired `automationMode` value (`scheduled`, `agent-managed`, `external`, `run-sheet`, `scheduler`, `single-column`, `internal`, `orchestration`) and sets the notice exactly once.
- Arming via `/orchestration/confirm` still installs the orchestrator wake and no queue timer; handoff installs neither.

### Manual UAT

- **Schedule only:** stage five, set a 2-minute interval, no lead pull instruction. Five cards run one at a time, paced by the clock, refusals invisible.
- **Pull only:** stage five, no schedule. Five cards run one at a time, paced by the lead.
- **Both:** stage five with both live. Still five runs, no doubles.
- **Cloud-VM round trip:** `fetch-plans` pulls a remote-authored plan; a `## Completion Report` added to a pulled plan is advanced forward-only by `reconcile`.
- **Upgrade path:** load a board persisted with `automationMode: 'scheduled', enabled: true`. It must come up disabled, with the notice, and dispatch nothing.

---

**Recommendation:** Complexity 7 → **Send to Lead Coder.** Land it last, after 1, 2, 3 and 6.
