# Wire The Mission Control Schedules Tab To The Runner That Already Exists

## Goal

Give the Mission Control Schedules tab a backend. It renders thirteen actions, a time selector,
and per-action fields, and posts seven verbs that **nothing handles** — so the list is
permanently empty and every edit is discarded. Wire it to the `ScheduledJob` store and runner
that already serve the Terminals tab's team automations, and implement the thirteen actions
under one rule: board actions are host-executed, agent actions carry no board authority.

### The problem, and the root cause

`mission-control.js` defines the full spec: `SCHEDULE_ACTIONS` (`:18`) with thirteen entries,
each declaring `needsColumns` / `needsComplexity` / `needsArtifactsFolder` / `needsTerminal` /
`isBoard` / `planner`; a Time selector of `every 5 min` … `custom (cron)` (`_timeOptions`,
`:313`); internal/external type; and conditional fields driven by that class data. It is a
complete UI.

All seven verbs it posts are unhandled outside the webview:

```
mcNewSchedule  mcUpdateSchedule  mcStartSchedule  mcStopSchedule
mcDeleteSchedule  mcScheduleLoadLog  mcScheduleExternalCopy
```

Each appears only in `src/webview/mission-control.js` and
`src/test/browser-panel-verb-routing.test.js` — no handler in `KanbanProvider`,
`TaskViewerProvider`, `LocalApiServer` or `bootstrap.ts`, and none in the generated verb
allowlist (which *does* carry `mcInit`, `mcNewMission`, `mcLaunchMission` and the rest of the
mission verbs). `mcSchedules` — the reply that would populate the list — has no sender anywhere.
So `schedules` is `[]` forever.

This is not an oversight. `mission-control-panel-ui-specification.md` was scoped as "the UI
half" and its completion note records the gap: *"missions and schedules have no host wiring
(blocked on `staging-streams-parallel-dispatch-and-worktrees.md`)"*. Missions were wired later;
schedules were not.

**The root cause of it still being unwired is a wrong premise about the data model.** The plan
deferred on the model landing, but no new model is needed: `ScheduledJob`
(`GlobalIntegrationConfigService.ts:38`) already carries `id`, `label`, `enabled`, `source`,
`target`, `intervalMinutes`, `promptOverride`, `startupCommand`, `teamTarget`, `lastRunAt`,
`lastOutcome`, `lastTarget` — and **`sourceConfig: Record<string, unknown>`**, documented as
"an untyped bag whose shape is owned by the source". Every field the new tab adds
(`fromColumn`, `toColumn`, `complexityFilter`, `artifactsFolder`, `targetTerminal`, `prompt`)
fits there with no schema change. The store (`getSchedulerConfig` / `setSchedulerConfig`), the
runner (`_tickSurvivorSchedulerJobs` → `runSchedulerJob`) and a working editor over the same
records (team automations, `terminals.js:12062`) all already exist.

## Metadata
- **Complexity:** 7
- **Tags:** backend, api, frontend, feature

## No migration

Clean break. Existing `ScheduledJob` records keep working; new fields are additive inside
`sourceConfig`. No compat shim for the unhandled verbs — they have never persisted anything.
CLAUDE.md's migration rule is waived.

## Scope: both composition roots

`runSchedulerJob` and the survivor tick live in `TaskViewerProvider`; the panel reaches the host
through the verb bridge in `KanbanProvider` and, in standalone, through `bootstrap.ts`'s
provider delegation. Verbs must resolve in **both** hosts. `bootstrap.ts`'s `default:` arm
delegates unmatched verbs to the provider, so a verb-reachability audit will come back green
either way — per CLAUDE.md, that audit is not the test. Diff what each root *wires*.

## The organising rule: host actions and agent actions

Derived from `scheduled-agents-must-not-move-cards.md`, which this plan depends on.

**Host-executed** (`isBoard: true` in the UI's own class data) — deterministic code, through the
dispatch path, with a recorded holder and the in-flight 409. No prompt, no judgement:
`advance-plan`, `advance-feature`, `batch-advance-planning`, `start-ready-mission`,
`phone-a-friend`.

**Agent-executed** (`needsTerminal: true`) — prompt delivery to a terminal or role, no board
reach: `review-code-vs-intent`, `process-memo`, `improve-docs`, `update-readme`,
`send-plans-to-jules`, `research`, `git-pull-push`, `custom`.

The UI already carries this split as data on every action. Read it from there rather than
re-deriving a second list in the host — two lists will disagree.

## Implementation

1. **Map the UI's schedule record onto `ScheduledJob`.** `action` → `source` (widening it to the
   thirteen ids); `schedule` → `intervalMinutes` for the fixed options, with `custom (cron)`
   carried in `sourceConfig.cron`; everything else into `sourceConfig`. Reuse autoban's cron
   parsing for the custom case rather than adding a second cron dependency — that parser is
   being deleted with the run sheet, so lift it out first.
2. **Handle the seven verbs** against `getSchedulerConfig` / `setSchedulerConfig`, and reply
   `mcSchedules`. Follow how team automations writes (`saveSchedulerConfigDirect`,
   `terminals.js`) — including its **upsert-not-map** lesson, recorded in its own comment: a
   map-only update persists nothing when no record exists yet, and the control snaps back on the
   next broadcast.
3. **`mcStartSchedule` / `mcStopSchedule` set `enabled`.** They are not a separate lifecycle —
   the runner's only gate is `job.enabled`. The panel's own `_setEnabled` logic already treats
   start/stop as mutually exclusive on `s.active`; make `active` mean `enabled`.
4. **Widen the survivor filter.** `_tickSurvivorSchedulerJobs` filters on a hardcoded
   `survivorSources` set of three. Any action outside it saves, displays as enabled, and never
   runs. Widen or invert it — this is the single most likely way this ships looking correct and
   doing nothing.
5. **Implement the host actions** through `dispatchNextFromQueue` (or the existing verb for the
   batch/phone-a-friend cases), inheriting `_queueNextChain` serialisation and the in-flight
   check. `start-ready-mission` calls the mission launch path — and must honour the readiness
   flag: the UI spec states *"a scheduler or Mission Control must not take an unready mission"*.
6. **Implement the agent actions** as prompt delivery via the existing preset mechanism, keeping
   the unattended standing order the panel already composes (`UNATTENDED_ORDER`,
   `mission-control.js:37`) for planner-class actions. No board authority in any of them.
7. **`mcScheduleExternalCopy` has no host side to build** beyond acknowledging: external type is
   copy-a-prompt with, per the spec, "no local side effects". Assert the no-write property
   rather than implementing a write.
8. **`mcScheduleLoadLog`** — read the job's log/outcome. `lastOutcome` exists on the record; if a
   richer per-run log is wanted, that is a decision to record, not to infer.

## Edge cases

- **Two editors, one store.** Team automations and this tab both write the whole `jobs` array. A
  save from one can clobber a concurrent edit from the other. Team automations already reads
  fresh before writing; do the same, and prefer per-job merge over whole-array replace.
- **Team automations must keep working unchanged.** It filters on
  `source === 'team-automation' && teamTarget.groupId === teamId`. Widening `source` must not
  make its filter match new records, and the new tab should not hide team-automation jobs it did
  not create — decide whether the Schedules tab shows them, and say so.
- **`intervalMinutes` floor.** The runner clamps to `>= 1`; `every 5 min` is fine. A cron
  expression that fires more often than the 60s poll cannot fire more often than the poll —
  document the resolution limit rather than implying finer granularity.
- **`external` type must not schedule anything.** The UI hides board actions for external; the
  host must also refuse to run an external record, in case a stored one carries a board action.
- **An action's required field is empty** (no target terminal, no from/to column). Refuse at save
  with a message, rather than storing a job that fails every 10 minutes.
- **`lastRunAt` is the tick's only gate** (`now - lastRunAt < intervalMs`). A job saved with
  `lastRunAt` unset fires on the next poll — which is right for advance-when-ready and surprising
  for a `daily` job created at 23:55. Decide and comment.

## Verification plan

1. `npm run compile` clean.
2. Create a schedule in the panel; confirm it persists across a reload **and** appears in
   `getSchedulerConfig`'s output.
3. Edit every field type — action, time, columns, complexity, artifacts folder, target terminal,
   prompt — and confirm each round-trips.
4. Enable a schedule of each of the thirteen actions and confirm each one actually fires. The
   survivor-filter widening means an un-widened source is the silent failure — test every action
   id, not a sample.
5. A host action fires: confirm a card moves with `dispatched_terminal` set, and that a second
   fire against an in-flight team returns the 409 rather than moving anything.
6. `start-ready-mission` against an unready mission: confirm it is not taken.
7. An agent action fires: confirm the prompt arrives at the right terminal/role and contains no
   board-driving instruction.
8. External type: select it, copy the prompt, assert no config write and nothing scheduled.
9. Team automations modal still lists, creates, enables and `RUN NOW`s its own jobs, and does not
   show or clobber schedules created in the new tab.
10. Both hosts, with both composition roots read side by side.
