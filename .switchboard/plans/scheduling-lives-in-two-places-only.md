# Scheduling Lives In Two Places Only: Team Automations And Mission Control

## Goal

Establish and enforce one rule — **the only two places scheduling exists are the Terminals
tab's team automations (simple, per-team, recurring prompt delivery) and the Mission Control
Schedules tab** — and delete every other recurring work-dispatcher that has accumulated
outside those two surfaces.

### The problem, and the root cause

Scheduling arrived four separate times and nothing ever consolidated it. A recurring
dispatcher lives in each of these places today, none of which is one of the two sanctioned
surfaces:

| Where | What | Verdict |
| :--- | :--- | :--- |
| `TaskViewerProvider` autoban run sheet (`:12564`, `:12573`, `:12581`, `:12586`, plus `:14102`/`:14113`) | Interval/cron clock popping the board queue with `batchSize` | **Delete** — owned by `retire-autoban-and-batch-size.md` |
| `_autobanEmptyColumnSweepTimer` (`:12607`, `:14175`) | Stops the engine when no valid tickets remain | **Delete** with it |
| `PipelineOrchestrator` (`:47`, instantiated at `TaskViewerProvider.ts:1698`) | 1-second tick counting down to an interval, then `_advance()` — dispatches a next stage per run sheet, by role | **Delete** — see below |
| `_survivorJobsTimer` (`:28158`) → `runSchedulerJob` | The 60s poll over `ScheduledJob[]` | **Keep** — this is the engine *behind* both sanctioned surfaces |

**`PipelineOrchestrator` is a fully-built dispatcher that nothing drives.** It ticks every
second, decrements `_secondsRemaining`, and on reaching zero calls `_advance()`, which reads
run sheets, computes each one's next stage via `getNextStage`, and dispatches by
role/instruction. It has five verbs (`pipelineStart`, `pipelineStop`, `pipelinePause`,
`pipelineUnpause`, `pipelineSetInterval`), entries in `verbSchemas.ts` (`:1750-1758`), and a
min/max/default interval normaliser. And:

- **No webview posts any of its verbs.** `pipelineStart` / `pipelineStop` / `pipelinePause` /
  `pipelineUnpause` / `pipelineSetInterval` appear in `verbSchemas.ts` and `TaskViewerProvider.ts`
  (`:15823-15843`) and in **no** file under `src/webview/`.
- **Its data source is unwired.** `setRunSheetsCallback` has no caller outside the class, so
  `_getRunSheetsCallback` is `undefined`, `_advance()` reads `[]`, and it takes the
  "keep running idle when there are no active plans" branch forever.
- **`pipelineState` — the state broadcast — has no webview consumer.** `_postPipelineState`
  (`TaskViewerProvider.ts:11623`) posts `pipelineState` messages, but no file under `src/webview/`
  handles it. The broadcast is dead on arrival.

So it is a second work-dispatching state machine, instantiated on every activation, that
cannot be started and would do nothing if it were. That is the clearest case in the tree of
schedule logic in an unexpected place.

The root cause of the whole picture: each new automation idea built its own timer rather than
extending the one runner, because the runner was buried in a provider alongside the previous
idea's timer. Four dispatchers, one of them dead, none of them named as the sanctioned one.

## Metadata
- **Complexity:** 6
- **Tags:** backend, refactor, reliability

## User Review Required

No — the deletion targets are dead code (no webview consumer, no data source wired) and the
rule is a documentation comment. No product decision is pending.

## The rule this plan installs

0. **The test is "does it dispatch work", not "does it have an interval".** A timer that
   ingests data, polls an external system for changes, refreshes a view, evicts a cache or
   keeps a socket alive is infrastructure, however configurable its period. Only a timer that
   *starts work* — dispatches a card, prompts an agent, launches a mission — is scheduling and
   falls under this rule. Getting this test wrong pulls in half the timers in the tree.
1. **Recurring work is dispatched by exactly one runner** — the `ScheduledJob` poll
   (`_survivorJobsTimer` → `runSchedulerJob`).
2. **It has exactly two front ends** — team automations (Terminals tab) and the Mission
   Control Schedules tab. Both are editors over one `getSchedulerConfig` /
   `setSchedulerConfig` store, which is already how team automations works.
3. **Anything else that wants to happen on a timer either becomes a `ScheduledJob` or does
   not exist.** New timers need a reason recorded in code why they are not a scheduled job.

Write the rule as a comment on the runner, not only in this plan — the next dispatcher gets
added because nothing in the code says where dispatchers go.

## No migration

Clean break. No compat shims, no preserved settings for deleted surfaces. CLAUDE.md's
migration rule is waived for this release.

## Not in scope: infrastructure timers

These are recurring but dispatch no work, and this plan must not touch them. Listing them so
the sweep does not over-reach: `wsHub` ping (`:177`), `KanbanDatabase` cache eviction
(`:1878`), `ContinuousSyncService` idle check (`:101`), `AutoArchiveService` sweep (`:140`),
`DesignPanelProvider` external file poll (`:4428`), `PlanIngestionEngine` periodic rescan
(`:507`), the **Plan Scanner** sweep (`:18568` → `_planScannerSweep`, which calls
`_syncFilesAndRefreshRunSheets` — an external-plan rescan and board refresh; it imports plan
files and dispatches nothing, so its Setup interval control stays exactly as it is),
`TicketsPanelProvider` poll (`:984`), the API server watchdog (`:4295`), the Jules
status poll (`:1821` — its second install at `:24350` is correctly guarded on
`!this._julesStatusPollTimer` and is not a duplicate), `RemoteControlService` tracker poll
(`:425`), and the standalone gateway's flush/drain/ping intervals.

`RemoteControlService` is the judgement call in that list: it polls a tracker and can trigger
dispatch from a status change. It stays, because it is event-driven remote control — the poll
is how it learns about an external event, not a schedule the operator sets. If that reading is
wrong it becomes a third surface and the rule above needs amending, not quietly bending.

**Re-verify this list at implementation time** — the tree changes, and a timer added between
this plan and implementation that dispatches work would be a third dispatcher this plan must
catch.

## Complexity Audit

### Routine
- Deleting `PipelineOrchestrator.ts` — a self-contained class with no external consumers of its exported types (`PipelineState`, `GetRunSheetsCallback`, `DispatchCallback`, `IsAcceptanceTesterActiveCallback` are all module-level, used only within the file).
- Removing the five verb arms from `TaskViewerProvider.ts` (`:15823-15843`).
- Removing the `verbSchemas.ts` entries (`:1750-1758`) and regenerating the allowlist.
- Adding the rule as a comment on `_tickSurvivorSchedulerJobs` and `runSchedulerJob`.
- Asserting the autoban clock is gone (owned by `retire-autoban-and-batch-size.md`).

### Complex / Risky
- **Deleting a dead class can delete a live type.** `PipelineOrchestrator` imports run-sheet helpers and exports `PipelineState`. Follow each import and export before removing — `_advance` may be their only caller, or may not. (Verified: `getNextStage` is module-level, non-exported, only called at `:197` within the file. `PipelineState` is exported but has no external import. All safe to delete with the class.)
- **The regression test.** `src/test/pipeline-orchestrator-regression.test.js` (7 tests) reads `PipelineOrchestrator.ts` and `TaskViewerProvider.ts` source by file path and asserts wiring patterns. Deleting the class without deleting this test leaves a test that crashes on `fs.readFileSync` of a missing file. This test must be deleted with the class.
- **The `_pipeline` field lifecycle.** `TaskViewerProvider` declares `private _pipeline: PipelineOrchestrator` (`:1517`), instantiates it (`:1698`), calls `restore()` (`:14369`), `dispose()` (`:24988`), and posts state via `_postPipelineState` (`:11623`). All of these must be removed — leaving any one is a compile error or a dead call.
- **A deleted verb still in the allowlist** is a hole; a live verb removed from it breaks a caller. Regenerate the allowlist with its generator and diff the result.
- **Standalone.** `bootstrap.ts:2582` and `ptyHost.ts:64` run their own periodic tasks — classify each before assuming it is infrastructure.

## Edge-Case & Dependency Audit

**Race Conditions:**
- None — the deleted dispatcher never runs (no webview starts it, no data source feeds it). There is no live state to race.

**Security:**
- None — deleting a dead dispatcher removes no guard. The survivor tick's in-flight guard (`_schedulerInFlight`) is untouched.

**Side Effects:**
- `_survivorJobsTimer`'s name lies. "Survivor" describes the three sources that survived a previous cull (`fetch-plans`, `reconcile`, `team-automation`), and the tick filters on that hardcoded set (`:28179`). When the Schedules tab adds actions, an unlisted source is silently skipped — a schedule that saves, displays as enabled, and never runs. Either widen the filter with the action set or invert it to an explicit exclusion list; do not leave a hardcoded allowlist behind a UI that offers thirteen choices. (This is owned by `mission-control-schedules-backend.md`.)
- `PipelineOrchestrator` persists state to `globalState` (`pipeline.running`, `pipeline.paused`, `pipeline.intervalSeconds`, `pipeline.secondsRemaining`). After deletion, these keys are orphaned in `globalState` — they are never read again. No migration needed (clean break), but an install that had `pipeline.running: true` will have a stale key. Harmless: no code reads it.

**Dependencies & Conflicts:**
- `retire-autoban-and-batch-size.md` — owns the autoban run-sheet clock deletion. This plan only asserts it is gone and that no timer replaced it. The two plans must not both delete the same code — this plan deletes `PipelineOrchestrator` only.
- `mission-control-schedules-backend.md` — owns the survivor filter widening and the Schedules tab wiring. This plan names the runner as the sole dispatcher; that plan widens it.
- `getNextStage` and the run-sheet types (`GetRunSheetsCallback`, `DispatchCallback`, `IsAcceptanceTesterActiveCallback`, `PipelineState`) are all contained in `PipelineOrchestrator.ts` with no external consumers. Safe to delete with the class — but follow each import before removing, as the plan's own edge case says.

## Dependencies
- `retire-autoban-and-batch-size.md` — owns the autoban clock deletion; this plan asserts it is gone.
- `mission-control-schedules-backend.md` — owns the survivor filter widening; this plan names the runner as the sole dispatcher.

## Adversarial Synthesis

Key risks: the `pipeline-orchestrator-regression.test.js` test file (7 tests) will crash on a missing file if not deleted with the class — the plan's original text missed it entirely. The `_pipeline` field has five touchpoints in `TaskViewerProvider.ts` (declaration, instantiation, restore, dispose, state broadcast) that must all be removed or the file will not compile. The "not in scope" infrastructure timer list is the load-bearing document — a timer added between planning and implementation that dispatches work would be a third dispatcher. Mitigations: delete the test with the class; enumerate all five `_pipeline` touchpoints in the deletion checklist; re-verify the timer list at implementation time.

## Proposed Changes

### `src/services/PipelineOrchestrator.ts`
- **Context:** A fully-built dispatcher (`:47`) with a 1-second tick, five verbs, run-sheet stage computation, and persisted state. No webview posts its verbs; its data source callback is never set; its state broadcast has no consumer. It is dead code instantiated on every activation.
- **Logic:** Delete the entire file. The class, `getNextStage` (module-level, non-exported), and all type aliases (`PipelineState`, `GetRunSheetsCallback`, `DispatchCallback`, `IsAcceptanceTesterActiveCallback`) are contained here with no external consumers.
- **Implementation:** `rm src/services/PipelineOrchestrator.ts`.
- **Edge Cases:** `getNextStage` is only called at `:197` within this file — no external consumer. `PipelineState` is exported but imported nowhere. All safe.

### `src/services/TaskViewerProvider.ts`
- **Context:** `TaskViewerProvider` declares, instantiates, calls, and disposes `PipelineOrchestrator` in five places, and has a state-broadcast method for it. All must be removed.
- **Logic:** Remove all five touchpoints:
  1. **Import** (`:63`): `import { PipelineOrchestrator } from './PipelineOrchestrator';` — delete.
  2. **Field declaration** (`:1517`): `private _pipeline: PipelineOrchestrator;` — delete.
  3. **Instantiation** (`:1698-1719`): `this._pipeline = new PipelineOrchestrator(...)` — delete the entire constructor call and its four callbacks (`_postPipelineState`, `_handleTriggerAgentActionInternal`, `_isAcceptanceTesterActive`, `getRunSheets`).
  4. **Restore call** (`:14369`): `await this._pipeline.restore();` and the following `this._postPipelineState();` (`:14370`) — delete both lines.
  5. **Dispose call** (`:24988`): `this._pipeline.dispose();` — delete.
  6. **State broadcast** (`:11623-11628`): `private _postPipelineState(): void { ... }` — delete the entire method.
  7. **Verb arms** (`:15823-15843`): `case 'pipelineStart'`, `case 'pipelineStop'`, `case 'pipelinePause'`, `case 'pipelineUnpause'`, `case 'pipelineSetInterval'` — delete all five arms.

  > **Superseded:** "the three verb arms (`:15768`-`:15788`)"
  > **Reason:** The plan undercounted — there are five verbs (`pipelineStart`, `pipelineStop`, `pipelinePause`, `pipelineUnpause`, `pipelineSetInterval`), not three, and the arms are at `:15823-15843`, not `:15768-15888`. `pipelineStop` and `pipelineUnpause` were missed.
  > **Replaced with:** "the five verb arms (`:15823-15843`)" — all five must be deleted.

- **Implementation:** Remove the seven items above. After removal, grep `_pipeline` and `_postPipelineState` in `TaskViewerProvider.ts` — zero matches.
- **Edge Cases:** The instantiation block (`:1698-1719`) passes four callbacks. Deleting the block removes the only callers of `_postPipelineState` and the only wiring of `getRunSheets` to the pipeline. Confirm no other code references these callbacks in the pipeline context (they are general-purpose methods with other callers — `_handleTriggerAgentActionInternal` is used by dispatch, `_isAcceptanceTesterActive` by the review path).

### `src/services/verbSchemas.ts`
- **Context:** Five schema entries for the pipeline verbs (`:1750-1758`).
- **Logic:** Delete `pipelineStart`, `pipelineStop`, `pipelinePause`, `pipelineUnpause`, `pipelineSetInterval` schema entries.
- **Implementation:** Remove the five entries. Grep `pipeline` in `verbSchemas.ts` — zero matches.
- **Edge Cases:** None — the schemas are only consumed by the verb handlers being deleted.

### `src/generated/verbAllowlist.ts`
- **Context:** Five entries in `TASKVIEWER_VERBS` (`:15`): `pipelinePause`, `pipelineSetInterval`, `pipelineStart`, `pipelineStop`, `pipelineUnpause`.
- **Logic:** Regenerate with the allowlist generator — do not hand-edit. Diff the result to confirm only the five pipeline verbs are removed.
- **Implementation:** Run the generator, diff, confirm five fewer entries in `TASKVIEWER_VERBS`.
- **Edge Cases:** A live verb removed from the allowlist breaks a caller — but these verbs have no caller (no webview posts them). A deleted verb still in the allowlist is a hole — regeneration closes it.

### `src/test/pipeline-orchestrator-regression.test.js`
- **Context:** A 7-test regression file (`:1-122`) that reads `PipelineOrchestrator.ts` and `TaskViewerProvider.ts` source by file path and asserts wiring patterns (stage detection, idle behaviour, restore, dispatch callback, etc.).
- **Logic:** Delete the entire file. It reads `PipelineOrchestrator.ts` via `fs.readFileSync` — once the class file is deleted, this test crashes on a missing file.
- **Implementation:** `rm src/test/pipeline-orchestrator-regression.test.js`.
- **Edge Cases:** None — every assertion in this test is about the deleted class. No assertion carries over to the survivor tick or any other surviving code.

### `src/services/TaskViewerProvider.ts` (runner comment)
- **Context:** `_tickSurvivorSchedulerJobs` (`:28177`) and `runSchedulerJob` (`:28197`) are the sole recurring dispatcher. Nothing in the code says where dispatchers go — the next one gets added because there is no signpost.
- **Logic:** Add the rule (from "The rule this plan installs" above) as a header comment on both methods: this is the one recurring dispatcher; new recurring work is a `ScheduledJob`; the two front ends are team automations and the Mission Control Schedules tab.
- **Implementation:** Insert the comment block above `_tickSurvivorSchedulerJobs` and above `runSchedulerJob`.
- **Edge Cases:** None — this is a documentation comment, not a code change.

## Verification Plan

### Automated Tests
1. `npm run compile` clean; `npm test` green after the test triage.
2. Grep for `PipelineOrchestrator`, `pipelineStart`, `pipelineStop`, `pipelinePause`, `pipelineUnpause`, `pipelineSetInterval`, `setRunSheetsCallback`, `_postPipelineState`, `_pipeline`: zero live references in `src/` (excluding historical plan files).

### Goal Invariants
- Assert `src/services/PipelineOrchestrator.ts` is absent (file does not exist).
- Assert `src/test/pipeline-orchestrator-regression.test.js` is absent (file does not exist).
- Assert `import.*PipelineOrchestrator` is absent from `src/services/TaskViewerProvider.ts` (grep returns zero).
- Assert `_pipeline` is absent from `src/services/TaskViewerProvider.ts` (grep returns zero — covers field, instantiation, restore, dispose, and state broadcast in one check).
- Assert `pipelineStart`, `pipelineStop`, `pipelinePause`, `pipelineUnpause`, `pipelineSetInterval` are absent from `src/services/verbSchemas.ts` (grep returns zero).
- Assert the same five verbs are absent from `src/generated/verbAllowlist.ts` (grep returns zero).
- Assert `_tickSurvivorSchedulerJobs` exists in `src/services/TaskViewerProvider.ts` (grep returns one match — the runner survives).
- Assert `runSchedulerJob` exists in `src/services/TaskViewerProvider.ts` (grep returns at least one match — the runner survives).

### Manual Verification
3. Count recurring dispatchers by inspection: exactly one (`_survivorJobsTimer`). Every other `setInterval` in the tree matches the not-in-scope list above or has a recorded reason. **Re-verify the not-in-scope list at implementation time — the tree changes.**
4. Team automations still create, edit, enable, `RUN NOW` and fire on interval.
5. A schedule saved from the Mission Control tab with each action fires — specifically test an action whose id is not in the old survivor set, which is the silent-skip case.
6. Plan Scanner is untouched — same interval control in Setup, same presets, destinations and custom sources, same cadence.
7. Both hosts.

## Completion Summary
Consolidated all scheduling down to the two sanctioned surfaces (Terminals tab team automations and Mission Control Schedules tab) powered by the single `ScheduledJob` runner (`_survivorJobsTimer` -> `runSchedulerJob`). Deleted the dead `PipelineOrchestrator` dispatcher class, its regression test, and its associated verbs/schemas across the codebase. Documented the scheduling rule on the runner methods in `TaskViewerProvider.ts` and verified clean compilation across both extension and standalone targets.

