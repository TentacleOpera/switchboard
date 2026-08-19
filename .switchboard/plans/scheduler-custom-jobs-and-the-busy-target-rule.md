# Custom Scheduler Jobs Exist Again, and a Job Never Fires Into a Busy Target

## Goal

Restore custom scheduler jobs, stop silently destroying the ones users still have, and give a dispatching job the one precondition it needs: don't fire into a target that is already working.

### Problem analysis

The scheduler is a general job runner. A job names a **source** (what to do) and a **target** (where it runs) — `src/services/GlobalIntegrationConfigService.ts:39-56` says so outright: *"`source` picks the prompt preset; `target` picks the execution surface."* Jobs pointed at different targets have nothing to do with each other: "every night, improve plans" and a coding team can obviously run at the same time.

Three defects, all small.

**1. `custom` is a legal source that is filtered out on read.** `ScheduledJob.source` includes `'custom'` (`:49`), and then:

```ts
private static readonly DROPPED_SOURCES = new Set(['comms', 'board-batch', 'custom']);
```

`custom` was swept up with two genuinely deleted sources (`comms`, `board-batch`). The type says custom jobs exist; the filter says they do not.

**2. The drop is destructive on the next write.** `_filterDroppedSources` runs on read, and the comment at `:492` states the consequence: dropped jobs *"stay inert in the file until the next legitimate `setSchedulerConfig` write, which reads through this filter and persists the list without them."* So a user's custom jobs survive right up until they change any scheduler setting, and are then written away permanently with no notice at write time. This is a shipped feature with records in `integration-config.json` on the whole install base — per the project's migration rule this is exactly the case that must import rather than drop.

**3. A dispatching job can fire into a working target.** This is the only concurrency rule the scheduler needs, and it is per-target, not global. `_scheduleQueuePop` (`src/services/TaskViewerProvider.ts:12969`) instead loops `batchSize` times per tick and relies on the pop's `409` to stop it — arbitration standing in for a precondition. That framing is what made the schedule look like a competing pacer; it is not one. A job that would dispatch checks whether its target is busy and skips the tick if so.

There is no mode axis here and nothing to make exclusive. Two jobs on different targets run concurrently because they always could.

## Metadata

**Complexity:** 3
**Tags:** backend, bugfix, reliability

## Implementation

1. **Remove `'custom'` from `DROPPED_SOURCES`.** Leave `comms` and `board-batch` — those sources really are gone. Custom jobs then resolve on read again, and any that have been sitting inert in `integration-config.json` come back on their own.

2. **Stop the destructive write.** `setSchedulerConfig` must not persist a list with unknown-source jobs stripped. Round-trip jobs whose source it does not recognise instead of dropping them, the same way `loadGlobal`/`saveGlobal` already round-trip unknown top-level keys (`:508`). A source can be filtered from *execution* without being deleted from *storage*, and only those two are separable concerns here.

3. **Clear the one-time notice.** `customJobs.dropped` in `workspaceState` (`TaskViewerProvider.ts:1416-1422`) and the `autobanState.ts:133` notice field both announce a drop that no longer happens. Reset the flag so a user who saw the notice is not left believing their jobs are gone.

4. **Restore whatever the custom-job UI needs to be editable again** — creating, labelling, enabling and setting an interval and prompt for a `custom` job. `promptOverride` and `startupCommand` are already on the shape, so this is surfacing fields rather than designing new ones. **No confirmation dialogs**, including on delete.

5. **Add the busy-target precondition.** Before a job that dispatches fires, resolve its target and skip the tick if that target is already working. Skipping is normal and silent — it is not an error and must not disable the job. Non-dispatching jobs (`fetch-plans`, `reconcile`, plan improvement, research) have no such check: they do not fire into a team.

6. **Drop the `batchSize` loop from `_scheduleQueuePop`.** One fire, one card. The job's interval is its pacing; a loop that dispatches until refused is the arbitration shape being removed. Keep the interval and the cron.

7. **Do not add pacing-mode awareness anywhere in the scheduler.** The precondition is "is this target busy", which is true or false regardless of what is pacing the target. A special case per pacing mode would reintroduce the coupling this plan deletes.

## Verification Plan

1. **A custom job in an existing `integration-config.json` resolves after the change** — the install-base restore path, tested against a real file containing custom, `comms` and `board-batch` jobs. Custom comes back; the other two stay filtered.
2. **`setSchedulerConfig` preserves unknown-source jobs.** Write an unrelated scheduler setting and assert the `comms`/`board-batch` records are still in the file afterward. This is the data-loss gate.
3. **Round-trip a custom job** through create → save → reload → edit → save, asserting nothing is lost and unknown fields survive.
4. **The one-time notice does not reappear**, and a workspace that already latched `customJobs.dropped` is reset.
5. **Busy target skips.** A card-advancing job whose target is mid-run does not dispatch, does not error, is not disabled, and fires normally on the next tick once the target is free.
6. **Free target fires.**
7. **Concurrent jobs on different targets both fire in the same tick** — e.g. a plan-improvement job and a card-advancing job against a free target. This is the test asserting there is no global exclusivity.
8. **A non-dispatching job is never blocked by a busy team.**
9. **One card per fire.** Assert a single dispatch per tick with the `batchSize` loop gone, and that the interval and cron still schedule as before.
10. **No confirmation dialogs** anywhere in the custom-job UI.

`npm run compile` clean; the seven PRD gates green.
