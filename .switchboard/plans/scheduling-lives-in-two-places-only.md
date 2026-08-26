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
| `TaskViewerProvider` autoban run sheet (`:12520`, `:12528`, `:12578`, `:12592`, plus `:14105`/`:14113`) | Interval/cron clock popping the board queue with `batchSize` | **Delete** — owned by `retire-autoban-and-batch-size.md` |
| `_autobanEmptyColumnSweepTimer` (`:12600`, `:14120`) | Stops the engine when no valid tickets remain | **Delete** with it |
| `PipelineOrchestrator` (`:242`, instantiated at `:1516`) | 1-second tick counting down to an interval, then `_advance()` — dispatches a next stage per run sheet, by role | **Delete** — see below |
| `_survivorJobsTimer` (`:28103`) → `runSchedulerJob` | The 60s poll over `ScheduledJob[]` | **Keep** — this is the engine *behind* both sanctioned surfaces |

**`PipelineOrchestrator` is a fully-built dispatcher that nothing drives.** It ticks every
second, decrements `_secondsRemaining`, and on reaching zero calls `_advance()`, which reads
run sheets, computes each one's next stage via `getNextStage`, and dispatches by
role/instruction. It has three verbs (`pipelineStart`, `pipelinePause`, `pipelineSetInterval`),
entries in `verbSchemas.ts`, and a min/max/default interval normaliser. And:

- **No webview posts any of its verbs.** `pipelineStart` / `pipelinePause` /
  `pipelineSetInterval` appear in `verbSchemas.ts` and `TaskViewerProvider.ts` and in **no**
  file under `src/webview/`.
- **Its data source is unwired.** `setRunSheetsCallback` has no caller outside the class, so
  `_getRunSheetsCallback` is `undefined`, `_advance()` reads `[]`, and it takes the
  "keep running idle when there are no active plans" branch forever.

So it is a second work-dispatching state machine, instantiated on every activation, that
cannot be started and would do nothing if it were. That is the clearest case in the tree of
schedule logic in an unexpected place.

The root cause of the whole picture: each new automation idea built its own timer rather than
extending the one runner, because the runner was buried in a provider alongside the previous
idea's timer. Four dispatchers, one of them dead, none of them named as the sanctioned one.

## Metadata
- **Complexity:** 6
- **Tags:** backend, refactor, reliability

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

## Implementation

1. **Delete `PipelineOrchestrator`** — the class, its instantiation and field on
   `TaskViewerProvider` (`:1516`), the three verb arms (`:15768`-`:15788`), their
   `verbSchemas.ts` entries, and the allowlist entries (regenerate, do not hand-edit).
   Check `getNextStage` and the run-sheet types for other consumers before deleting them
   too — `_advance` may be their only caller, or may not.
2. **Remove the autoban clock** — owned by `retire-autoban-and-batch-size.md`; this plan only
   asserts it is gone and that no timer replaced it.
3. **Name the runner.** Add the rule as a header comment on `_tickSurvivorSchedulerJobs` and
   `runSchedulerJob`: this is the one recurring dispatcher; new recurring work is a
   `ScheduledJob`; the two front ends are team automations and the Mission Control Schedules
   tab.

## Edge cases

- **`_survivorJobsTimer`'s name lies.** "Survivor" describes the three sources that survived a
  previous cull (`fetch-plans`, `reconcile`, `team-automation`), and the tick filters on that
  hardcoded set. When the Schedules tab adds actions, an unlisted source is silently skipped —
  a schedule that saves, displays as enabled, and never runs. Either widen the filter with the
  action set or invert it to an explicit exclusion list; do not leave a hardcoded allowlist
  behind a UI that offers thirteen choices.
- **Deleting a dead class can delete a live type.** `PipelineOrchestrator` imports run-sheet
  helpers that other code may use. Follow each import before removing it.
- **A deleted verb still in the allowlist** is a hole; a live verb removed from it breaks a
  caller. Regenerate the allowlist with its generator and diff the result.
- **Standalone.** `bootstrap.ts:2582` and `ptyHost.ts:64` run their own periodic tasks —
  classify each before assuming it is infrastructure.

## Verification plan

1. `npm run compile` clean; `npm test` green.
2. Grep for `PipelineOrchestrator`, `pipelineStart`, `pipelineSetInterval`,
   `setRunSheetsCallback`: zero live references.
3. Count recurring dispatchers by inspection: exactly one (`_survivorJobsTimer`). Every other
   `setInterval` in the tree matches the not-in-scope list above or has a recorded reason.
4. Team automations still create, edit, enable, `RUN NOW` and fire on interval.
5. A schedule saved from the Mission Control tab with each action fires — specifically test an
   action whose id is not in the old survivor set, which is the silent-skip case.
6. Plan Scanner is untouched — same interval control in Setup, same presets, destinations and
   custom sources, same cadence.
7. Both hosts.
