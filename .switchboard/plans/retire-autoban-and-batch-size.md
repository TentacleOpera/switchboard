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
(`launchMission`, `KanbanProvider.ts:14487`). The operator now works the second way; the
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

## Implementation

1. **Split the state first, delete second.** Move the surviving keys to their own
   normalised shape (Mission Control state, pair-programming state) with their own
   persistence, and repoint every reader. Only then remove the queue-schedule keys. Doing it
   in the other order means every intermediate commit has Mission Control reading a
   container that is being dismantled underneath it.
2. **Delete the engine in `TaskViewerProvider.ts`**: `_autobanTimers`,
   `_autobanLastTickAt`, `_autobanTickQueue`, `_whenScheduleTimer`,
   `_autobanEmptyColumnSweepTimer`, `_scheduleQueuePop`, `_startAutobanEngine`,
   `_stopAutobanEngine`, `resetAutobanTimersFromKanban`, `setAutobanPausedFromKanban`,
   `_startWhenScheduleTimer` / `_clearWhenScheduleTimer`,
   `_stopAutobanIfNoValidTicketsRemain`. This removes all **three** timer-install paths the
   code comments warn about (`:12565`) — the warning goes with them.
3. **Delete from `autobanState.ts`**: `SingleColumnAutobanConfig`,
   `DEFAULT_SINGLE_COLUMN_CONFIG`, `normalizeSingleColumnConfig`, `DEFAULT_AUTOBAN_RULES`,
   `AutobanRuleState`, `AutobanComplexityFilter`, `AutobanRoutingMode`,
   `AUTOBAN_RUN_SHEET_TICK_KEY`, `RETIRED_AUTOMATION_MODES`, `AutobanAutomationMode`,
   the four notice strings, and the dead `ScheduleRule` / `ScheduleSelector` /
   `normalizeScheduleRule` (no production consumers).
   - **Keep `MissionRunConfig` and `normalizeMissionRunConfig`.** They are equally
     consumer-free today, but `missions-advance-when-ready.md` claims them. Deleting them
     here and re-adding them there is churn across two plans.
   - Keep `MISSION_CONTROL_TERMINAL_NAME`, `MissionControlSeat`,
     `MissionControlConfig` and their normalisers.
4. **Remove the verbs** and their handlers, schemas and allowlist entries: `toggleAutoban`,
   `toggleAutobanPause`, `updateAutobanConfig`, `updateAutobanState`, `getAutobanConfig`,
   `resetAutobanTimers`, `setWhenSchedule`. Regenerate `src/generated/verbAllowlist.ts`
   with its generator rather than hand-editing it.
   - **Audit the batch verbs individually, do not sweep them.** `batchDispatchLow`,
     `batchLowComplexity`, `batchPlannerPrompt` are named for batching but may be operator
     actions independent of the clock. Determine per verb whether it is the schedule's or the
     operator's before deleting anything.
   - **`runQueue`, `stageForQueue`, `reorderQueue` stay.** Staging is how a mission's members
     get queued, and `dispatchNextFromQueue` is what `launchMission` calls. The queue is not
     being deleted — only the clock that popped it unattended.
5. **Remove the UI**: the autoban controls in `kanban.html`, `setup.html`,
   `implementation.html`, `mission-control.js`, `terminals.js`, `shell.js` and
   `transport.js`. Batch-size and complexity-filter inputs go with them. Anything reading
   `automationMode` goes — it is a synthetic derived value with no writer left.
6. **Tests**: 21 files reference autoban. Delete the ones that only exercise the engine.
   `autoban-state-regression.test.js` needs reading line by line — it also pins Mission
   Control normalisation, `normalizeMissionRunConfig` (`:1018`) and the survivor-tick
   contract that *"scheduled team-automation shares the in-flight guard"* (`:717`). Those
   assertions must survive under whatever the state is called next.

## Edge cases

- **An install with a live schedule.** After the upgrade the clock is gone and nothing pops
  the queue. That is the intent, but it is silent: work that used to advance overnight stops
  advancing. Say so once in the UI — not as a migration, as a notice that the schedule is
  retired and missions replace it.
- **Mission Control armed via the old container.** The single highest-risk regression. Cover
  it with a test that arms Mission Control, restarts, and asserts it is still armed under the
  new state shape.
- **`paused` survived a mode switch.** The existing resume path carries a comment that
  `paused` survives a switch into external or agent-managed and would install a live timer in
  a mode meant to run none (`:12558`). With the engine deleted this hazard disappears — but
  confirm no code path still reads `paused` and branches on it.
- **The survivor scheduler jobs are a different clock and stay.**
  `_tickSurvivorSchedulerJobs` (`TaskViewerProvider.ts:28122`) polls `ScheduledJob[]` every
  60s and runs `fetch-plans`, `reconcile` and `team-automation`. It is not the run sheet and
  is not in scope. Do not delete it while deleting the thing next to it.
- **`stopReason`.** Every self-stop path writes it and something may render it. Follow the
  readers before deleting.
- **`SessionActionLog` and `agentPromptBuilder` reference autoban.** Log strings and prompt
  text that name a retired mechanism are stale documentation shipped to agents; update rather
  than leave prompts describing a clock that no longer exists.

## Verification plan

1. `npm run compile` clean; `npm test` green after the test triage.
2. **Mission Control survives**: arm it, restart the host, confirm still armed. Repeat in both
   hosts.
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
