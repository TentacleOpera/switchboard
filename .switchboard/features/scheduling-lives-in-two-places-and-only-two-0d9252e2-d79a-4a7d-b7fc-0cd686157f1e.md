# Scheduling Lives In Two Places, And Only Two

**Complexity:** 8

## Goal

Consolidate every recurring work-dispatcher down to the two sanctioned surfaces - the Terminals tab team automations and the Mission Control Schedules tab - and give both a backend that actually runs.

Scheduling arrived four separate times and nothing ever consolidated it. Four independent timers exist today: the autoban run-sheet clock, its empty-column sweep, PipelineOrchestrator (a fully-built second dispatcher no webview can start and whose data source is unwired), and the survivor-jobs poll. Only the last is sanctioned. Meanwhile the Mission Control Schedules tab renders thirteen actions and posts seven verbs that nothing handles, so its list is permanently empty and every edit is discarded.

Scheduling must also become safe to leave running overnight. Today a checkbox grants a scheduled agent board authority by appending prose telling it to use move-card.js - which grants nothing, restricts nothing, bypasses every dispatch guard, and leaves a card advanced with no holder. Board actions become host-executed; agent actions carry no board authority. Work then advances at the pace agents actually finish rather than on a clock.


## How the Subtasks Achieve This

- **Retire Autoban And Batch Size**: extracts Mission Control and pair-programming out of the shared `AutobanConfigState` blob, then deletes the queue-schedule clock, `batchSize`, complexity filtering, column rules and pause/resume. This is the deletion the other subtasks assert has happened.
- **Scheduling Lives In Two Places Only**: deletes `PipelineOrchestrator` — a fully-built second dispatcher whose five verbs no webview posts, whose run-sheet callback is never wired, and whose state broadcast has no consumer — and asserts the survivor-jobs timer is the sole remaining dispatcher.
- **Wire The Mission Control Schedules Tab To The Runner That Already Exists**: gives the thirteen-action Schedules UI a backend on the existing `ScheduledJob` store, carrying its new fields in the documented untyped `sourceConfig` bag. No new data model is needed; the wrong premise that one was is why this stayed unwired.
- **A Scheduled Agent Never Moves A Card**: replaces the inverted `canMoveCards` checkbox — which grants nothing, restricts nothing, and makes a raw-SQL move more likely — with host-executed board actions, so card movement has an owner instead of being a permission granted by prose.
- **Advance When Ready**: makes a job fire when the lead posts completion and the team is released, rather than when the clock says so, using the release fact the dispatch path already computes and throws away.
- **Custom Scheduler Jobs Exist Again**: restores the `custom` source that is legal on write and filtered out on read, and stops silently destroying the jobs users still have. Its former step 5 is retired in-plan — it rewrote the run-sheet tick that this feature deletes.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Custom Scheduler Jobs Exist Again, and a Job Never Fires Into a Busy Target](../plans/scheduler-custom-jobs-and-the-busy-target-rule.md) — **PLAN REVIEWED** — ID: 4d307fa9-8bd6-4472-82b1-c83799af56a1
- [ ] [Advance When Ready: A Schedule That Fires On Completion, Not On The Clock](../plans/advance-when-ready-on-a-scheduled-job.md) — **PLAN REVIEWED** — ID: 813b3745-162f-4ce1-87fb-d4b171c48958
- [ ] [Retire Autoban And Batch Size: Missions Are The Dispatch Primitive Now](../plans/retire-autoban-and-batch-size.md) — **PLAN REVIEWED** — ID: 52b810eb-6209-45fa-9255-2cac8075c04c
- [ ] [A Scheduled Agent Never Moves A Card](../plans/scheduled-agents-must-not-move-cards.md) — **PLAN REVIEWED** — ID: a1bc7483-3d20-4302-bbd2-1db4f401abbc
- [ ] [Scheduling Lives In Two Places Only: Team Automations And Mission Control](../plans/scheduling-lives-in-two-places-only.md) — **PLAN REVIEWED** — ID: 5f06c80f-8632-422d-930e-cd41bc1085c0
- [ ] [Wire The Mission Control Schedules Tab To The Runner That Already Exists](../plans/mission-control-schedules-backend.md) — **PLAN REVIEWED** — ID: 05e81453-1e87-4c48-891c-880cba58a153
<!-- END SUBTASKS -->

## Dependencies & sequencing

`retire-autoban-and-batch-size` lands **first**. Both `scheduling-lives-in-two-places-only` and `mission-control-schedules-backend` declare a dependency on its deletion, and the cron parser is shared and must be extracted before it goes. The two must not both delete the same code: `retire-autoban` owns the clock, `scheduling-lives-in-two-places-only` owns `PipelineOrchestrator` only.

`mission-control-schedules-backend` then widens the survivor filter; `advance-when-ready` needs that backend, or can carry its flag on team automations first — the mechanism is identical either way. `advance-when-ready` also reuses a `resolveTeamInFlight` helper proposed by `team-dispatched-state-reaches-the-rail.md` (outside this feature); if that has not landed, extracting it is step 1 of that subtask.

`scheduled-agents-must-not-move-cards` is independent and can run in parallel, with one caveat recorded in the plan: its test assertion must exclude `reconcile` until `reconcile-becomes-host-code.md` lands, since that is the one scheduled job still moving cards by prose.

`scheduler-custom-jobs` is independent of the deletion order once its step 5 is dropped. Delete `pipeline-orchestrator-regression.test.js` with the class, and remove all five `_pipeline` touchpoints in `TaskViewerProvider.ts` or the file will not compile.
