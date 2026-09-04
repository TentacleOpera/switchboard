# Mission Control Schedules Persists Four Fields Nothing Reads, Offers Four Actions That Do One Thing, and Loses Its Own Config

## Goal

The Schedules surface must do what it appears to do: its persisted fields must reach an execution path, its four actions must differ, its release trigger must be reachable, and two editors must not overwrite each other's jobs.

### Problem analysis

Four reviewer findings from `.switchboard/memo.md`, triaged 2026-09-04 and verified against HEAD. They are one surface and were filed as one card because three of them are only visible once you have the fourth: the config that carries them is being clobbered between editors.

The most load-bearing is last.

## Metadata

- **Complexity:** 5
- **Tags:** mission-control, scheduler, ux, bugfix

## User Review Required

None. Each finding has one honest resolution: make it work, or remove the affordance.

## Proposed Changes

### 1. Four persisted schedule fields have no reader

`fromColumn`, `toColumn`, `complexityFilter` and `artifactsFolder` are written by `mcUpdateSchedule` and read back only by the display projection at `:15234`. `grep sourceConfig.<field>` across `src/` returns the four writer lines and nothing else.

The operator configures a column range and a complexity filter, sees them persist, and no execution path consumes any of them.

Either thread them into the dispatch decision or remove the controls. A control that stores a value nobody reads is worse than an absent one, because it implies the value matters.

### 2. Four board actions share one behaviour

`TaskViewerProvider.ts:28384-28428` — `advance-plan`, `advance-feature`, `batch-advance-planning` and `phone-a-friend` fall into one `else if` with identical arguments. Only `start-ready-mission` branches away.

Four choices in the UI, one outcome. Either differentiate them or collapse the choice.

### 3. Advance-when-ready cannot fire from the Schedules tab

`clearAdvanceWhenReadyJobs` skips every job where `!job.enabled || !job.advanceWhenReady || job.source !== 'team-automation'`, and the match then requires `job.teamTarget?.groupId`, which Schedules-tab jobs do not set.

So the release trigger is unreachable from the surface that offers it. Widen the gate to the Schedules source, or say in the UI that the option applies to team automation only.

### 4. Two editors whole-array-replace the scheduler config

`setSchedulerConfig` writes `msg.config` verbatim with no per-job merge. `mission-control.js` posts `window.__schedulerConfig` and `terminals.js` posts `cachedSchedulerConfig` — both long-lived client caches.

The clobber window is therefore **a session, not a tick**: open both surfaces, edit one, and the other's next save silently reverts it. This is the most load-bearing of the four, and it is why the other three are hard to observe — a change you make can disappear before you have finished testing it.

Merge per job on write, keyed on job id.

## Verification Plan

1. A schedule configured with a column range and complexity filter either changes what is dispatched, or those controls no longer exist.
2. The four actions produce four distinguishable outcomes, or the UI offers fewer.
3. An advance-when-ready job created in the Schedules tab fires on release, or the tab states the restriction.
4. Open Mission Control and the Terminals scheduler side by side. Edit a job in one and save the other. The first edit survives.
5. `setSchedulerConfig` never writes an array it did not merge; a contract test covers two-editor interleaving.
