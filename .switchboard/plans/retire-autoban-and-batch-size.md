# Retire Autoban And Batch Size: Missions Are The Dispatch Primitive Now

## Goal

Delete the queue-schedule engine — the run-sheet clock, batch size, complexity filtering,
column rules, the cron WHEN control, and pause/resume — and the state, verbs and UI that
serve it. Missions replaced it: work is dispatched by launching a curated mission, not by a
clock popping a column on an interval.

### The problem, and the root cause

Two dispatch mechanisms are live at once, and only one is the intended path.

The queue schedule is a single run-sheet clock keyed `AUTOBAN_RUN_SHEET_TICK_KEY`, either a
cron line (`whenSchedule`) or a fixed interval (`intervalMinutes`), firing
`_scheduleQueuePop()` with `batchSize` cards at a time, filtered by `complexityFilter` and
routed by per-column `rules`. Missions are a curated member set dispatched explicitly
(`launchMission`, `KanbanProvider.ts:14577`). The operator now works the second way; the
first is still armed, still persisted, and still able to dispatch work nobody asked for on
a timer.

**The root cause of the mess is that `AutobanConfigState` is one blob holding three
unrelated concerns** (`autobanState.ts:164-196`):

| Concern | Keys |
| :--- | :--- |
| Queue schedule (**delete**) | `enabled`, `batchSize`, `complexityFilter`, `routingMode`, `rules`, `lastTickAt`, `paused`, `pausedRemainingMs`, `singleColumnConfig`, `stopReason`, `automationMode`, and four one-time notice strings |
| Mission Control (**keep**) | `missionControlArmed`, `missionControlSeat`, `missionControlConfig` |
| Pair programming (**keep**) | `pairProgrammingMode`, `aggressivePairProgramming` |

So "delete autoban" is not a file deletion. It is an extraction: two live features have been
sharing the doomed feature's state container, and its own comments say so —
*"the schedule and Mission Control are now independent switches"* (`autobanState.ts:430`),
*"`enabled` = queue schedule, `missionControlArmed` = Mission Control wake"* (`:201`). The
mode axis that used to couple them is already retired; only the container is left.

The reach is wide: **24 source files** and **21 test files** reference autoban, plus the
persisted `autoban.state` and thirteen verbs.

## Metadata
- **Complexity:** 8
- **Tags:** backend, refactor, api, reliability

## User Review Required

**All three design decisions confirmed by the user:**
1. **No migration** — confirmed. The queue-schedule clock is retired, not reshaped; its
   state is dead by design. Let them eat cake.
2. **Delete `autobanEnabled`** — confirmed. The field is removed from
   `KanbanColumnDefinition`, all column definitions, all mirrors, and all test fixtures.
3. **Delete `setAutomationModeFromKanban` entirely** — confirmed. It is dead code (no
   webview posts the `setAutomationMode` verb; the panel that sent it is already deleted).
   Mission Control arming is fully covered by `startMissionControlFromKanban` /
   `confirmMissionControlSession` / `stopMissionControlFromKanban`.

## No migration

Clean break. Do not migrate `autoban.state`, do not archive it as `*.migrated.bak`, do not
write a compat reader for the deleted keys. CLAUDE.md's migration rule is waived for this
release.

**One precise distinction, or a live feature breaks:** the surviving keys
(`missionControlArmed`, `missionControlSeat`, `missionControlConfig`, `pairProgrammingMode`,
`aggressivePairProgramming`) must still be **read** out of wherever they end up living. That
is not a migration — it is the new home reading its own state. An implementer who reads "no
migration" as "ignore the old state file entirely" will silently disarm Mission Control and
reset pair programming on every existing install, including the author's.

## Scope: both composition roots

The engine lives in `TaskViewerProvider.ts` (extension) but autoban state, verbs and reads
appear in `bootstrap.ts`, `ptyFleetService.ts` and `ptyHost.ts` too. Removal must land in
both roots in one diff. A half-removal leaves the standalone host reading a state shape the
extension no longer writes — which fails open, as a clock that still ticks.

## Complexity Audit

### Routine
- Deleting the seven autoban verbs and their `case` handlers from `KanbanProvider.ts` (6 cases) and `TaskViewerProvider.ts` (1 case), then regenerating `verbAllowlist.ts` via `npm run catalog:generate`.
- Removing the batch-size and complexity-filter inputs from the webview HTML/JS files.
- Deleting the schedule-only constants and types from `autobanState.ts` (`AUTOBAN_RUN_SHEET_TICK_KEY`, `SingleColumnAutobanConfig`, `AutobanRuleState`, `AutobanComplexityFilter`, `AutobanRoutingMode`, `AutobanAutomationMode`, `RETIRED_AUTOMATION_MODES`, `DEFAULT_AUTOBAN_RULES`, `ScheduleRule`/`ScheduleSelector`/`normalizeScheduleRule`, the four notice strings, `AUTOBAN_BATCH_SIZE_OPTIONS`, `DEFAULT_AUTOBAN_BATCH_SIZE`, `normalizeAutobanBatchSize`).
- Deleting the schedule-only helper functions (`isSharedReviewerAutobanColumn`, `getEnabledSharedReviewerAutobanColumns`, `shouldSkipSharedReviewerAutobanDispatch`) — production consumers are schedule-only; only the regression test imports them.
- Updating stale comments in `LocalApiServer.ts`, `bootstrap.ts`, `extension.ts`, `ptyFleetService.ts`, `ptyHost.ts` that reference "autoban clock" / "autoban engine" / "autobanState.enabled" in Mission Control descriptions.
- Deleting test files that only exercise the engine (`autoban-no-valid-tickets-regression.test.js`, `autoban-controls-regression.test.js`, `autoban-reviewer-prompt-regression.test.js`).

### Complex / Risky
- **Splitting `AutobanConfigState` without breaking Mission Control or pair programming.** The surviving keys must be extracted to their own normalised shape with their own persistence, and every reader repointed, before the schedule keys are removed. `normalizeAutobanConfigState` is the load-bearing normaliser that currently coalesces legacy orchestrator keys and derives both switches — it must be rewritten to handle only the survivors, preserving the `orchestratorArmed`→`missionControlArmed` coalescing that keeps existing installs armed.
- **The boot-time restore path.** `_tryRestoreAutoban` (TaskViewerProvider.ts:11643) calls `_startAutobanEngine()` on startup if `enabled && !paused`. It is called from `restoreAutobanOnStartup` (bootstrap.ts:3180) and from the sidebar `ready` path (TaskViewerProvider.ts:14367). Gutting it incorrectly leaves the clock armed on every restart.
- **`setAutomationModeFromKanban` (TaskViewerProvider.ts:12248) is dead code being deleted entirely.** It handles BOTH switches (schedule + Mission Control), but no webview posts the `setAutomationMode` verb — the UI panel that sent it is already deleted (kanban.html:12278). Mission Control arming is fully covered by `startMissionControlFromKanban` / `confirmMissionControlSession` / `stopMissionControlFromKanban`, none of which go through this method. Delete the method, the `case 'setAutomationMode'` verb handler (KanbanProvider.ts:9931), and the verb's allowlist entry. The regression test assertions that pin `setAutomationMode` (autoban-state-regression.test.js:600-608, 965) must be deleted.
- **`autobanEnabled` field on `KanbanColumnDefinition`** (agentConfig.ts:128) — **confirmed deleted.** Present on all 11 default columns, custom columns, and mirrored in `kanban.html` (6238-6245), `PlanningPanelProvider.ts` (7584), `KanbanProvider._columnsSignature` (4449), and 14 test assertions. Remove from the interface, all column definitions, all mirrors, the `_columnsSignature` read, the `kanban.html` filter (6300, 10956), and update the test fixtures.
- **`MAX_AUTOBAN_TERMINALS_PER_ROLE` and `getNextAutobanTerminalName`** are named "autoban" but serve general terminal management (TaskViewerProvider.ts:11437, 11450, 12504) — not the schedule. They must survive the deletion, ideally renamed and relocated out of `autobanState.ts` so the file can be renamed/removed.
- **`cleanWorkspace.ts` (74-76) preserves `state.autoban`** during workspace cleanup; `stateConfigBridge.ts` (36) maps `autoban: 'runtime.autoban'`. Both must be repointed to the new survivor-state shape.
- **21 test files reference autoban.** The regression test (`autoban-state-regression.test.js`) pins Mission Control normalisation, `normalizeMissionRunConfig` (:1018), and the survivor-tick contract (:717). Those assertions must survive under whatever the state is called next; the schedule-only assertions must be deleted.

## Edge-Case & Dependency Audit

**Race Conditions**
- The boot restore (`_tryRestoreAutoban`) is fire-and-forget from `bootstrap.ts:3180`. If the engine deletion lands before the restore is gutted, the restore calls a deleted method and throws on every boot — silently, because it is `.catch(err => log(...))`-guarded.
- `setAutomationModeFromKanban` calls `_stopAutobanEngine()` before rewriting state (12264). The method is being deleted entirely (confirmed), so the stop call goes with it — but verify no other code path expects the method to exist.

**Security**
- No new attack surface. The deleted verbs (`toggleAutoban`, `setWhenSchedule`, etc.) are removed from the allowlist, shrinking the verb surface.

**Side Effects**
- An install with a live schedule stops advancing overnight. The plan calls for a one-time UI notice (not a migration) that the schedule is retired.
- `cleanWorkspace.ts` preserving `state.autoban` under the old key would resurrect dead state on the next workspace clean if not repointed.
- Stale prompt text in `agentPromptBuilder.ts` (lines 1056, 1496, 1695, 2593) and log strings in `SessionActionLog.ts` (183) that name a retired mechanism would ship false documentation to agents.

**Dependencies & Conflicts**
- `missions-advance-when-ready.md` — referenced in the original plan as claiming `MissionRunConfig`/`normalizeMissionRunConfig`. **That plan file does not exist in the repo.** The real reason to keep them is the regression test (autoban-state-regression.test.js:1018) imports and pins them. See Superseded callout in Proposed Changes.
- The survivor scheduler jobs (`_tickSurvivorSchedulerJobs`, TaskViewerProvider.ts:28177) are a different clock and stay. They are started from `_tryRestoreAutoban` (11656) — the gutted restore must keep this call.

## Dependencies
- None — this plan is self-contained. No other plan file in `.switchboard/plans/` claims the symbols being deleted.

## Adversarial Synthesis

Key risks: (1) the boot restore path re-arming a deleted clock on every restart if gutted incompletely; (2) deleting `setAutomationModeFromKanban` entirely without confirming no other path expects it (it is dead code, but the regression test pins its verb arm); (3) `normalizeAutobanConfigState`'s legacy-key coalescing being lost in the rewrite, silently disarming Mission Control on every existing install. Mitigations: split state first and repoint readers before deleting schedule keys; keep the survivor-timer and survivor-key coalescing in the gutted restore and normaliser; delete the `setAutomationMode` regression test assertions that pin the dead verb arm; pin Mission Control survival with an arm-restart-assert test in both hosts (arming via the legacy `orchestratorArmed` key to catch a coalescing regression).

## Proposed Changes

### `src/services/autobanState.ts` — rewrite the state container

**Context:** This file defines `AutobanConfigState` (164-196), the one blob holding three
concerns. It also defines schedule-only types, constants, helpers, and the survivors
(Mission Control, pair programming, terminal naming).

**Logic — delete (schedule-only, no surviving production consumers):**
- `AutobanRuleState`, `DEFAULT_AUTOBAN_RULES`, `AutobanComplexityFilter`,
  `AutobanRoutingMode`, `SingleColumnAutobanConfig`, `DEFAULT_SINGLE_COLUMN_CONFIG`,
  `normalizeSingleColumnConfig`, `AUTOBAN_RUN_SHEET_TICK_KEY`, `RETIRED_AUTOMATION_MODES`,
  `AutobanAutomationMode`, `normalizeAutomationMode`, the four notice strings
  (`migratedBoardBatchNotice`, `droppedCustomJobsNotice`, `retiredAutomationModeNotice`,
  `recurringJobsResumedNotice`), `AUTOBAN_BATCH_SIZE_OPTIONS`, `DEFAULT_AUTOBAN_BATCH_SIZE`,
  `normalizeAutobanBatchSize`, `AUTOBAN_SHARED_REVIEWER_COLUMNS`, `AUTOBAN_SOURCE_COLUMN`,
  `ScheduleRule`, `ScheduleSelector`, `normalizeScheduleRule`,
  `isSharedReviewerAutobanColumn`, `getEnabledSharedReviewerAutobanColumns`,
  `shouldSkipSharedReviewerAutobanDispatch`.
- `normalizeAutobanConfigState` (341) — rewrite to handle **only** the surviving keys:
  `missionControlArmed`, `missionControlSeat`, `missionControlConfig`,
  `pairProgrammingMode`, `aggressivePairProgramming`. **Preserve the
  `orchestratorArmed`→`missionControlArmed` / `orchestratorSeat`→`missionControlSeat` /
  `orchestrationConfig`→`missionControlConfig` coalescing** (396-401) — that is the compat
  read that keeps existing installs armed, and it is the "new home reading its own state"
  the No Migration section describes. Drop the `enabled`/`paused`/`rules`/`batchSize`/
  `complexityFilter`/`routingMode`/`singleColumnConfig`/`automationMode`/`stopReason`/
  notice-string handling.

**Logic — keep (survivors):**
- `MISSION_CONTROL_TERMINAL_NAME`, `MissionControlSeat`, `MissionControlConfig`,
  `DEFAULT_MISSION_CONTROL_CONFIG`, `normalizeMissionControlConfig`.
- `MissionRunConfig`, `normalizeMissionRunConfig` — consumer-free in production, but pinned
  by `autoban-state-regression.test.js:1018`.

> **Superseded:** Keep `MissionRunConfig` and `normalizeMissionRunConfig` because
> `missions-advance-when-ready.md` claims them.
> **Reason:** `missions-advance-when-ready.md` does not exist anywhere in the repo (verified
> by recursive file search). The cross-plan rationale is stale.
> **Replaced with:** Keep `MissionRunConfig` and `normalizeMissionRunConfig` because
> `autoban-state-regression.test.js:1018` imports and pins them — deleting them breaks the
> test. They are equally consumer-free in production, but the test gate is the real
> constraint. If the test is rewritten to drop the import, they can be deleted in a
> follow-up.

**Logic — keep but rename/relocate (terminal management, not schedule):**
- `MAX_AUTOBAN_TERMINALS_PER_ROLE` (18) — used at TaskViewerProvider.ts:11437, 12504 for
  terminal caps that apply to manual and worktree terminal creation, not just schedule
  dispatch. Rename to `MAX_TERMINALS_PER_ROLE` and move to a non-autoban module (e.g.
  `agentConfig.ts` or a new `terminalLimits.ts`) so `autobanState.ts` can be renamed to
  `missionControlState.ts` or similar.
- `getNextAutobanTerminalName` (283) — used at TaskViewerProvider.ts:11450 for terminal
  naming. Rename to `getNextTerminalName` and relocate with the constant above.
- `normalizeFiniteCount` (231) — used by `normalizeAutobanBatchSize` (being deleted) and
  potentially by survivor normalisers. Check for surviving callers before deleting.

**Edge cases:**
- The `normalizeFiniteCount` helper is shared. Verify no survivor normaliser calls it before
  deleting; if `normalizeMissionControlConfig` or the rewritten `normalizeAutobanConfigState`
  needs it, keep it.

### `src/services/TaskViewerProvider.ts` — delete the engine and gut the toggles

**Context:** The extension's composition root. 175 autoban references. The engine, the
toggles, the boot restore, the broadcast, and the turn-end stub all live here.

**Delete (schedule engine — the original plan's step 2):**
- Fields: `_autobanTimers` (1523), `_autobanLastTickAt`, `_autobanTickQueue`,
  `_whenScheduleTimer` (1526), `_autobanEmptyColumnSweepTimer`.
- Methods: `_scheduleQueuePop` (13910), `_startAutobanEngine` (14128),
  `_stopAutobanEngine` (14194), `_startWhenScheduleTimer` / `_clearWhenScheduleTimer`
  (14097-14123), `_stopAutobanIfNoValidTicketsRemain`.
- Kanban toggle methods: `resetAutobanTimersFromKanban` (12546),
  `setAutobanPausedFromKanban` (12593).

**Delete (missed by the original plan):**
- `setAutobanEnabledFromKanban` (11660) — the schedule on/off toggle. Entire method goes;
  the UI control that calls it is removed in the webview step.
- `handleAutobanTurnEnd` (2083) — already a no-op stub ("completion-driven dispatch is
  deleted", :2084). Delete the stub. Also delete the call at :3784 and the stale
  "completion-driven autoban dispatch" comment at `extension.ts:1107`.
- `getAutomationMode` (1832) — derives the synthetic `automationMode` from the two switches.
  The plan says "anything reading `automationMode` goes"; this is the producer. Delete it
  and every caller.
- `setAutomationModeFromKanban` (12248) — **deleted entirely (user-confirmed).** Dead code:
  no webview posts the `setAutomationMode` verb (the panel that sent it is already deleted,
  kanban.html:12278). Mission Control arming is fully covered by
  `startMissionControlFromKanban` / `confirmMissionControlSession` /
  `stopMissionControlFromKanban`, none of which go through this method. Delete the method,
  the `case 'setAutomationMode'` verb handler (KanbanProvider.ts:9931), and the verb's
  allowlist entry. The `_singleColumnAutobanState` persistence at 12281 goes with it.
- `updateAutobanConfigFromKanban` (12306) — another state-write entry point for the schedule
  config. Delete entirely (same rationale: the UI that called it via the
  `updateAutobanConfig` verb is being deleted).

**Gut (keep the survivor half, delete the schedule half):**
- `_tryRestoreAutoban` (11643) — currently calls `_startAutobanEngine()` if
  `enabled && !paused` (11649-11651). Gut the `enabled`/`paused` check and the
  `_startAutobanEngine()` call. **Keep** `_pruneStaleBackupRegistry` (11646),
  `_kanbanProvider.updateAutobanConfig` broadcast (11648), and
  `_startSurvivorJobsTimer()` (11656). The survivor timer is a different clock and must
  re-arm on restart.
- `restoreAutobanOnStartup` (11639) — thin wrapper around `_tryRestoreAutoban`. Keep the
  wrapper (bootstrap.ts:3180 calls it) but it now only restores survivor state + survivor
  timer. Rename to `restoreMissionControlOnStartup` for clarity.
- `_getAutobanBroadcastState` (11556) — the broadcast shape. Rewrite to emit only survivor
  keys. Remove `automationMode`, `batchSize`, `complexityFilter`, `routingMode`, `rules`,
  `paused`, `singleColumnConfig`, `stopReason`, notice strings.
- `_singleColumnAutobanState` field and its `workspaceState['singleColumn.autoban.state']`
  persistence — delete entirely. This is the separate persisted single-column schedule
  config; with the schedule gone it is dead state.

**Edge cases:**
- Line 14367: a second `_tryRestoreAutoban()` call (sidebar `ready` path). The gutted method
  handles both call sites — no separate change needed, but verify the `ready` path does not
  pass schedule-specific arguments.
- Every `_startAutobanEngine` / `_stopAutobanEngine` call site (11650, 11668, 11672, 12264,
  12299, 15810, 15812, 15815, 21737, 24975) must be removed when the methods are deleted.
  Grep for call sites after deletion to confirm zero remain.

### `src/services/KanbanProvider.ts` — delete the verb handlers

**Context:** 37 autoban references. Hosts the verb `case` handlers and `launchMission`.

**Delete verb handlers** (8 cases): `getAutobanConfig` (9972), `updateAutobanConfig` (9975),
`toggleAutoban` (9981), `resetAutobanTimers` (9998), `toggleAutobanPause` (10002),
`setWhenSchedule` (10006), `setAutomationMode` (9931 — dead verb, user-confirmed deletion),
`startOrchestrator` (9937) and `stopOrchestrator` (9945) — these two are Mission Control
verbs, **keep them** (they route to `startMissionControlFromKanban` /
`stopMissionControlFromKanban`, which survive). Remove the deleted verbs' schemas and
allowlist entries.

**Delete from `TaskViewerProvider.ts`** (1 case at 15802): `updateAutobanState`.

**Regenerate `src/generated/verbAllowlist.ts`** via `npm run catalog:generate` (the file
header says "AUTO-GENERATED — do not edit"). Do not hand-edit.

**Audit the batch verbs individually — do not sweep them:**
- `batchDispatchLow` (KanbanProvider.ts:11234, extension.ts:1839),
  `batchLowComplexity` (11242), `batchPlannerPrompt` (11214). These are named for batching
  but may be operator actions independent of the clock. Determine per verb whether it is the
  schedule's or the operator's before deleting anything. `batchDispatchLow` is registered as
  a VS Code command (`switchboard.batchDispatchLow`, extension.ts:1839) — follow the command
  registration to see if it routes through `_scheduleQueuePop` or is a standalone operator
  dispatch.

**Keep:** `runQueue` (12572), `stageForQueue` (8521), `reorderQueue` (8616),
`dispatchNextFromQueue` (LocalApiServer.ts:1814). Staging is how a mission's members get
queued; `dispatchNextFromQueue` is what `launchMission` calls (KanbanProvider.ts:14624).
The queue is not being deleted — only the clock that popped it unattended.

**Edge cases:**
- `launchMission` is at line 14577 (the original plan cited 14487 — line drift).
- `_columnsSignature` (4449) reads `col.autobanEnabled`. The field is confirmed deleted —
  remove the read from the signature function.

### `src/services/agentConfig.ts` — delete the `autobanEnabled` field

**Context:** `KanbanColumnDefinition.autobanEnabled` (128) is a per-column flag on all 11
default columns (151-161), custom columns (505), and mirrored in `PlanningPanelProvider.ts`
(7584), `kanban.html` (6238-6245, 6300, 10956), and 14 test assertions
(`KanbanProvider.test.ts`, `split-coded-columns-regression.test.js`).

**Implementation (user-confirmed deletion):** With the schedule deleted, `autobanEnabled` is
dead metadata — `kanban.html` (6300) filters columns by it to determine which the schedule
processes, and that filter has no consumer left. Remove the field from:
- `KanbanColumnDefinition` interface (agentConfig.ts:128)
- All 11 default column definitions (agentConfig.ts:151-161)
- Custom column creation (agentConfig.ts:505)
- `PlanningPanelProvider.ts:7584`
- `kanban.html` column definitions (6238-6245) and the `columnDefinitions.filter(col =>
  col.autobanEnabled)` filter (6300, 10956)
- `KanbanProvider._columnsSignature` (4449) — remove the `autobanEnabled` read
- `KanbanProvider.test.ts` fixtures (144-154, 254) — remove the field from all column
  definitions
- `split-coded-columns-regression.test.js` (19, 34) — remove the field from the regex
  assertions

### `src/lifecycle/cleanWorkspace.ts` — repoint the state preserve

**Context:** Lines 74-76 preserve `state.autoban` during workspace cleanup.

**Implementation:** Repoint to preserve the survivor state under its new key/shape. If the
state is split into `missionControl.state` and `pairProgramming.state`, preserve those. If
it stays under `autoban.state` (renamed later), preserve the survivor keys only. An
implementer who leaves the old key will resurrect dead schedule state on the next clean.

### `src/services/stateConfigBridge.ts` — repoint the state mapping

**Context:** Line 36 maps `autoban: 'runtime.autoban'`.

**Implementation:** Update the mapping to the new state key(s). If the state is renamed,
update the bridge. If split into multiple keys, add the new mappings.

### `src/standalone/bootstrap.ts` — gut the restore, clean stale comments

**Context:** 14 autoban references. The standalone host's composition root.

**Implementation:**
- Line 3180: `restoreAutobanOnStartup()` call — keep, but the method is gutted (see
  TaskViewerProvider changes). Update the log message ("autoban restore failed" → "Mission
  Control restore failed").
- Lines 1215-1228: delete the `switchboard.setAutobanEnabledFromKanban`,
  `switchboard.resetAutobanTimersFromKanban`, and `switchboard.setAutobanPausedFromKanban`
  command registrations — the methods they call are being deleted. Also delete the stale
  comment block (1215-1222) describing the run-sheet controls.
- Lines 3176-3178: stale comment "Resume a board that was left with autoban armed... the
  run-sheet clock, whose first pass dispatches immediately" — rewrite to describe survivor
  restore only.
- Lines 2566-2569: stale "completion-driven autoban dispatch" comment — delete (the stub is
  being deleted).
- Line 2773: stale "autoban dispatch" comment — update.
- Line 3183: stale "autoban restore" comment — update.
- Lines 38, 2425-2436, 2529, 2910, 2931, 2940: these read `_autobanState.missionControlSeat`
  and `MISSION_CONTROL_TERMINAL_NAME` — **KEEP** (survivors). If `autobanState.ts` is
  renamed, update the import path.

### `src/standalone/ptyFleetService.ts` and `src/standalone/ptyHost.ts` — clean stale comments

**Context:** One comment each referencing "autoban" in the context of the Mission Control
seat resolver.

**Implementation:**
- `ptyFleetService.ts:209`: "the autoban `missionControlSeat` record" — update to
  "the Mission Control seat record" (or the new state module name).
- `ptyHost.ts:70`: "the extension host's in-process autoban state" — update to "Mission
  Control state".

### `src/services/LocalApiServer.ts` — clean stale comments

**Context:** 5 comment references to "autoban clock" / "autoban engine" / "autobanState.enabled"
in Mission Control endpoint descriptions (562, 570, 579, 5817, 5897).

**Implementation:** These are **stale comments** — the actual code arms
`missionControlArmed` (TaskViewerProvider.ts:12044), not `enabled`. Rewrite:
- 562: "terminal + kickoff + autoban clock" → "terminal + kickoff + Mission Control wake".
- 570: "Does NOT stop the autoban engine" → "Does NOT stop the Mission Control wake timer".
- 579/5817: "arms the single ON/OFF flag (`autobanState.enabled`)" → "arms the Mission
  Control switch (`missionControlArmed`)".
- 5897: "Does NOT stop the autoban engine" → "Does NOT stop the Mission Control wake timer".

### `src/extension.ts` — clean stale comments, delete the turn-end call and schedule commands

**Context:** 3 autoban references. Line 1107: stale "completion-driven autoban dispatch"
comment. Line 3784: `handleAutobanTurnEnd` call (the stub being deleted). Lines 3483-3487:
"autoban registry" / "autoban 5-per-role cap" comments referencing
`MAX_AUTOBAN_TERMINALS_PER_ROLE`. Line 1890: `switchboard.setAutobanEnabledFromKanban`
command registration (the method is being deleted). Line 1839:
`switchboard.batchDispatchLow` command registration (audit per batch-verb rule).

**Implementation:**
- Delete the `handleAutobanTurnEnd` call at 3784 (the stub is being deleted).
- Delete the `switchboard.setAutobanEnabledFromKanban` command registration (1890-1891) —
  the method is being deleted.
- Rewrite line 1107 comment — turn-end notification stays for the activity light, but
  "completion-driven autoban dispatch" is gone.
- Lines 3483-3487: update "autoban registry" / "autoban 5-per-role cap" to the renamed
  constant (`MAX_TERMINALS_PER_ROLE`) if relocated.

### `src/services/agentPromptBuilder.ts` and `src/services/SessionActionLog.ts` — update stale text

**Context:** `agentPromptBuilder.ts` (1056, 1496, 1695, 2593) and `SessionActionLog.ts` (183)
contain prompt text and log strings that name a retired mechanism.

**Implementation:** Update the strings to describe Mission Control / missions, not the
autoban clock. Stale prompt text shipped to agents is false documentation that can cause an
agent to wait for a clock-driven dispatch that will never come.

### Webview files — remove the UI

**Context:** `kanban.html` (76 matches), `setup.html`, `implementation.html` (9 matches),
`mission-control.js` (3 matches), `terminals.js` (4 matches), `shell.js` (4 matches),
`transport.js` (4 matches).

**Implementation:** Remove the autoban controls: batch-size inputs, complexity-filter
inputs, the WHEN cron control, pause/resume controls, the schedule on/off toggle, and
anything reading `automationMode`. Also remove the `autobanEnabled` field from the column
definitions in `kanban.html` (6238-6245) and the
`columnDefinitions.filter(col => col.autobanEnabled)` filter (6300, 10956) — the field is
confirmed deleted.

### Tests — triage 21 files

**Context:** 21 test files reference autoban.

**Implementation:**
- **Delete** files that only exercise the engine: `autoban-no-valid-tickets-regression.test.js`,
  `autoban-controls-regression.test.js`, `autoban-reviewer-prompt-regression.test.js`.
- **Read line by line** `autoban-state-regression.test.js` (35 matches). It pins:
  - Mission Control normalisation — **keep**.
  - `normalizeMissionRunConfig` (:1018) — **keep** (the reason `MissionRunConfig` survives).
  - The survivor-tick contract "scheduled team-automation shares the in-flight guard" (:717)
    — **keep** (`_tickSurvivorSchedulerJobs` is not in scope).
  - Schedule-only assertions (rules, batchSize, complexityFilter, `normalizeSingleColumnConfig`,
    `isSharedReviewerAutobanColumn`, `shouldSkipSharedReviewerAutobanDispatch`,
    `getNextAutobanTerminalName`) — **delete** the assertions for deleted symbols. If
    `getNextAutobanTerminalName` is renamed, update the import and assertions.
  - `setAutomationMode` verb arm assertions (600-608, 965) — **delete** (the verb is being
    deleted entirely, user-confirmed).
  - `switchboard.setAutobanEnabledFromKanban` command assertion (338) — **delete** (the
    command registration is being deleted).
  - `switchboard.startOrchestrator` command assertion (980-987) — **keep** (the command
    survives; it routes to `startMissionControlFromKanban`).
- **Update** `KanbanProvider.test.ts` (14 matches) — remove the `autobanEnabled` field from
  all column definition fixtures (144-154, 254) (user-confirmed deletion).
- **Update** `split-coded-columns-regression.test.js` (2 matches) — remove `autobanEnabled`
  from the regex assertions (19, 34) (user-confirmed deletion).
- **Audit** the remaining test files individually for whether they test the schedule or
  survivor behaviour. Files like `mission-control-tick-and-reports-contract.test.js` (9
  matches) likely test survivors — keep with updated imports.

## Verification Plan

### Automated Tests
1. `npm run compile` clean; `npm test` green after the test triage.
2. **Mission Control survives**: arm it via the **legacy `orchestratorArmed` key** (not
   `missionControlArmed`) to test the coalescing in the rewritten normaliser, restart the
   host, confirm still armed. Repeat in both hosts.
3. **Pair programming survives**: set a non-default mode, restart, confirm preserved.
4. Grep the tree for `autoban`, `batchSize`, `whenSchedule`, `complexityFilter`,
   `automationMode`, `AUTOBAN_RUN_SHEET_TICK_KEY` — the only survivors should be
   intentional (renamed state, historical plan files).
5. Start the host with an install whose `autoban.state` has `enabled: true` and a
   `singleColumnConfig`: confirm no timer is installed, nothing dispatches unbidden, and no
   crash reading the stale keys.
6. Stage plans and launch a mission: confirm dispatch still works end to end — the queue and
   `dispatchNextFromQueue` are untouched.
7. Confirm the survivor scheduler jobs (`fetch-plans`, `reconcile`, `team-automation`) still
   tick on their 60s poll.
8. Confirm no UI surface still offers batch size, complexity filter, a WHEN cron, or a
   pause/resume control for a clock that no longer exists.

### Goal Invariants
- **Negative:** `grep -c '_startAutobanEngine' src/services/TaskViewerProvider.ts` returns 0
  (the clock installer is gone).
- **Positive:** `grep -c 'launchMission' src/services/KanbanProvider.ts` returns ≥1 (the
  mission dispatch primitive survives).
- **Negative:** `grep -c 'AUTOBAN_RUN_SHEET_TICK_KEY' src/services/autobanState.ts` returns 0
  (the tick key is gone).
- **Positive:** `grep -c 'missionControlArmed' src/services/TaskViewerProvider.ts` returns
  ≥1 (the survivor switch is still set).
- **Negative:** `grep -c 'setWhenSchedule' src/generated/verbAllowlist.ts` returns 0 (the
  schedule verb is gone from the allowlist).
- **Positive:** `grep -c 'mcLaunchMission' src/generated/verbAllowlist.ts` returns 1 (the
  mission verb survives).
- **Negative:** `grep -c 'batchSize' src/services/autobanState.ts` returns 0 (batch size is
  gone from the state module).
- **Positive:** `grep -c 'dispatchNextFromQueue' src/services/LocalApiServer.ts` returns ≥1
  (the queue pop survives — only the clock is deleted, not the queue).
- **Negative:** `grep -c '_singleColumnAutobanState' src/services/TaskViewerProvider.ts`
  returns 0 (the separate persisted schedule config is gone).
- **Positive:** `grep -c '_startSurvivorJobsTimer' src/services/TaskViewerProvider.ts`
  returns ≥1 (the survivor scheduler survives).
- **Negative:** `grep -c 'setAutomationModeFromKanban' src/services/TaskViewerProvider.ts`
  returns 0 (the dead dual-switch method is gone).
- **Negative:** `grep -c 'autobanEnabled' src/services/agentConfig.ts` returns 0 (the dead
  column field is gone).
- **Negative:** `grep -c 'setAutobanEnabledFromKanban' src/extension.ts` returns 0 (the
  schedule toggle command registration is gone).
- **Negative:** `grep -c 'setAutomationMode' src/generated/verbAllowlist.ts` returns 0 (the
  dead verb is gone from the allowlist).

## Review Findings

All 14 Goal Invariants pass at HEAD: the clock installer, tick key, `batchSize`,
`_singleColumnAutobanState`, `setAutomationModeFromKanban`, `autobanEnabled` and the schedule
verbs are gone, while `launchMission`, `missionControlArmed`, `dispatchNextFromQueue` and
`_startSurvivorJobsTimer` survive. The state split was done correctly — the rewritten
`normalizeAutobanConfigState` preserves the `orchestratorArmed`→`missionControlArmed`
coalescing that keeps existing installs armed, `cleanWorkspace.ts` now normalises through it
(stripping schedule keys rather than resurrecting them), and the terminal-management symbols
moved to `agentConfig.ts` with compat aliases. Two defects were fixed: the commit deleted
`autoban-reviewer-prompt-regression.test.js` on its filename prefix alone — it never tested the
clock, it tests the reviewer prompt — leaving the CI-wired `test:contract:reviewer-prompt` gate
RED on a missing module (restored as `reviewer-prompt-anti-artifact-contract.test.js`, mutation-
tested); and the plan's comment-cleanup step was skipped wholesale, leaving twelve comments and
one user-facing warning describing deleted subsystems as live, including three citing the
removed `autobanState.enabled` field. Files changed: `package.json`,
`.github/workflows/integration-tests.yml`, `src/test/reviewer-prompt-anti-artifact-contract.test.js`
(new), `src/services/LocalApiServer.ts`, `src/services/TaskViewerProvider.ts`,
`src/standalone/{bootstrap,ptyHost,ptyFleetService}.ts`, `src/extension.ts`; `compile-tests`
exit 0 and 10 affected contract suites pass.

## Deferred Findings

- NIT — `restoreAutobanOnStartup` was not renamed to `restoreMissionControlOnStartup` as the plan suggested; it now only restores survivor state and the survivor timer. `src/services/TaskViewerProvider.ts:11515`
- NIT — `autobanState.ts` was not renamed to `missionControlState.ts`; it still exports the `MAX_AUTOBAN_TERMINALS_PER_ROLE` / `getNextAutobanTerminalName` compat aliases, which `autoban-state-regression.test.js` pins. `src/services/autobanState.ts:4`
- NIT — `stateConfigBridge.ts` still maps `autoban: 'runtime.autoban'`; correct, because the state key was never renamed, but the name now outlives the mechanism. `src/services/stateConfigBridge.ts:36`
- NIT — `getDroppedCustomJobLabels()` has no remaining consumer now that the notice strings are deleted; it is dead but harmless raw-config read. `src/services/GlobalIntegrationConfigService.ts:637`
