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
(`GlobalIntegrationConfigService.ts:45`) already carries `id`, `label`, `enabled`, `source`,
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

## User Review Required

Yes — before implementation, confirm:
- The thirteen action ids in `SCHEDULE_ACTIONS` (`mission-control.js:18-32`) are the final set. Adding or removing one after wiring means updating the `source` type union, the survivor filter, and `runSchedulerJob`'s switch in lockstep.
- The decision on whether the Schedules tab shows team-automation jobs it did not create (see Edge-Case & Dependency Audit → Side Effects).
- Whether `mcScheduleLoadLog` returns only `lastOutcome` (the field on the record) or a richer per-run log is desired (see Implementation step 8).

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

## Complexity Audit

### Routine
- Mapping the UI's schedule record fields onto `ScheduledJob` — additive fields inside `sourceConfig`, no schema change.
- Handling the seven CRUD verbs against `getSchedulerConfig` / `setSchedulerConfig`, following team automations' `saveSchedulerConfigDirect` pattern (`terminals.js:12379`).
- `mcStartSchedule` / `mcStopSchedule` setting `enabled` — the runner's only gate is `job.enabled`.
- `mcScheduleExternalCopy` — acknowledge only, no host side to build.
- `mcScheduleLoadLog` — read `lastOutcome` from the job record.

### Complex / Risky
- **Widening `survivorSources`** (`TaskViewerProvider.ts:28179`) — hardcoded set of three; any action outside it saves, displays as enabled, and never runs. The single most likely way this ships looking correct and doing nothing.
- **Adding execution branches to `runSchedulerJob`** (`TaskViewerProvider.ts:28197`) — the runner's switch only handles `team-automation`, `fetch-plans`, and `reconcile`; everything else hits the `else` branch returning `unsupported source`. Widening the tick filter without adding matching arms here means jobs pass the filter, get ticked, update `lastRunAt`, and do nothing. This is the same trap as the survivor filter, one level deeper.
- **Widening the `source` type union** (`GlobalIntegrationConfigService.ts:49`) — currently `'reconcile' | 'custom' | 'fetch-plans' | 'team-automation'`. Storing `source: 'advance-plan'` is a type error without widening this. The thirteen action ids must be added to the union.
- **Extracting the cron parser** (`_nextCronTime`, `TaskViewerProvider.ts:13979`) — it is a `private static` method on `TaskViewerProvider`, used by the autoban WHEN schedule. `retire-autoban-and-batch-size.md` deletes the surrounding autoban engine. The parser must be lifted to a standalone utility before that deletion, or it goes with it.
- **Implementing host actions through `dispatchNextFromQueue`** — inheriting `_queueNextChain` serialisation and the in-flight 409, while honouring the mission readiness flag for `start-ready-mission`.
- **Two editors, one store** — team automations and this tab both write the whole `jobs` array. A save from one can clobber a concurrent edit from the other.
- **Both composition roots** — the verb handlers must resolve in extension and standalone; the seams each root wires are the audit, not the verbs.

## Edge-Case & Dependency Audit

**Race Conditions:**
- Two editors writing the whole `jobs` array concurrently. Team automations reads fresh before writing (`saveSchedulerConfigDirect`, `terminals.js:12379`); do the same, and prefer per-job merge over whole-array replace.
- `runSchedulerJob`'s `_schedulerInFlight` guard (`TaskViewerProvider.ts:28204`) prevents duplicate runs. New source branches must share this guard — do not bypass it.

**Security:**
- Agent actions carry no board authority — derived from `scheduled-agents-must-not-move-cards.md`. No scheduled prompt builder may emit `BOARD_DRIVING_CONTRACT`, `move-card.js`, or `/kanban/move`.
- External type must not schedule anything. The UI hides board actions for external; the host must also refuse to run an external record, in case a stored one carries a board action.

**Side Effects:**
- Team automations filters on `source === 'team-automation' && teamTarget.groupId === teamId`. Widening `source` must not make its filter match new records. The new tab should not hide team-automation jobs it did not create — **decide whether the Schedules tab shows them, and say so** (flagged in User Review Required).
- `lastRunAt` is the tick's only gate (`now - lastRunAt < intervalMs`, `TaskViewerProvider.ts:28184`). A job saved with `lastRunAt` unset fires on the next poll — which is right for advance-when-ready and surprising for a `daily` job created at 23:55. Decide and comment.

**Dependencies & Conflicts:**
- `scheduled-agents-must-not-move-cards.md` — this plan depends on it. The host/agent action split is derived from its rule. If `canMoveCards` has not been deleted yet, host actions must still go through dispatch (not prompt authority).
- `retire-autoban-and-batch-size.md` — the cron parser (`_nextCronTime`) lives in code this plan depends on being deleted. The parser must be extracted first (see Proposed Changes → `src/services/cronUtils.ts`).
- `intervalMinutes` floor: the runner clamps to `>= 1` (`TaskViewerProvider.ts:28183`); `every 5 min` is fine. A cron expression that fires more often than the 60s poll cannot fire more often than the poll — document the resolution limit rather than implying finer granularity.
- An action's required field is empty (no target terminal, no from/to column). Refuse at save with a message, rather than storing a job that fails every 10 minutes.

## Dependencies
- `scheduled-agents-must-not-move-cards.md` — host/agent action split; board authority removal.
- `retire-autoban-and-batch-size.md` — cron parser extraction must land before this plan's autoban deletion; the parser is shared.

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

## Adversarial Synthesis

Key risks: the survivor filter widening is the visible trap, but `runSchedulerJob`'s own switch is the deeper one — widening the filter without adding matching execution arms produces jobs that tick, update `lastRunAt`, and silently do nothing. The cron parser extraction has a sequencing hazard with the autoban retirement plan. Two editors writing one `jobs` array can clobber each other. Mitigations: widen both the filter AND the runner's switch in lockstep; extract the parser to a utility module first; read fresh before writing and prefer per-job merge.

## Proposed Changes

### `src/services/GlobalIntegrationConfigService.ts`
- **Context:** The `ScheduledJob` interface (`:45`) types `source` as `'reconcile' | 'custom' | 'fetch-plans' | 'team-automation'` (`:49`). The thirteen action ids are not in this union.
- **Logic:** Widen the `source` union to include all thirteen action ids. The `sourceConfig` bag already carries the per-action fields (`fromColumn`, `toColumn`, `complexityFilter`, `artifactsFolder`, `targetTerminal`, `prompt`, `cron`) — no other schema change.
- **Implementation:** Add the thirteen ids to the `source` type. Keep `sourceConfig: Record<string, unknown>` as-is.
- **Edge Cases:** Existing records with the old four sources must still load — the union is widened, not replaced.

### `src/services/cronUtils.ts` (new file)
- **Context:** The cron parser `_nextCronTime` (`TaskViewerProvider.ts:13979`) is a `private static` method on `TaskViewerProvider`. It is used by the autoban WHEN schedule (`_startWhenScheduleTimer`, `:14079`). `retire-autoban-and-batch-size.md` deletes the autoban engine; the parser goes with it unless extracted first.
- **Logic:** Extract `_nextCronTime` (and the `_WHEN_TIMER_CEILING_MS` constant, `:14068`) to a standalone utility module. Export a `nextCronTime(expr: string, fromNow?: Date): Date | null` function. Update `TaskViewerProvider` to import from the new module instead of calling the static method.
- **Implementation:** Move the 5-field cron parser (range/step/list parsing, OR-rule for dom/dow, 366-day search) verbatim. The custom (cron) schedule option in the Schedules tab will call this utility to compute the next fire time, stored in `sourceConfig.cron`.
- **Edge Cases:** The parser's strictly-future start (`start.setMinutes(start.getMinutes() + 1)`, `:14043`) prevents the early-fire loop documented in the existing comment. Preserve that behaviour.

### `src/services/KanbanProvider.ts`
- **Context:** The seven schedule verbs have no handler. `mcInit` (`:10029`) sends `mcMissions` and `updateSchedulerConfig` but NOT `mcSchedules` — so the schedules list is never populated on initial load.
- **Logic:** Add verb handlers for `mcNewSchedule`, `mcUpdateSchedule`, `mcStartSchedule`, `mcStopSchedule`, `mcDeleteSchedule`, `mcScheduleLoadLog`, `mcScheduleExternalCopy`. Each reads/writes via `getSchedulerConfig` / `setSchedulerConfig`. Update `mcInit` to also reply with `mcSchedules` (mapping `ScheduledJob[]` to the schedule shape the UI expects: `id`, `name`, `action`, `type`, `active` (= `enabled`), `schedule`, and the `sourceConfig` fields).
- **Implementation:**
  - `mcNewSchedule`: create a new `ScheduledJob` with a fresh id, `enabled: false`, the selected action as `source`, and the UI's fields packed into `sourceConfig`. Upsert into `jobs`, not map — follow the `wireSurvivorJobs` upsert lesson (`mission-control.js:588-611`).
  - `mcUpdateSchedule`: update a single field on a single job. Read fresh, merge per-job, write back.
  - `mcStartSchedule` / `mcStopSchedule`: set `job.enabled = true` / `false`. The panel's `_setEnabled` logic (`mission-control.js:368-369`) treats start/stop as mutually exclusive on `s.active`; make `active` mean `enabled`.
  - `mcDeleteSchedule`: remove the job from `jobs`.
  - `mcScheduleLoadLog`: read `job.lastOutcome` and reply `mcScheduleLog`. If a richer per-run log is wanted, that is a decision to record, not to infer (flagged in User Review Required).
  - `mcScheduleExternalCopy`: acknowledge only — no config write, no scheduler change. Assert the no-write property rather than implementing a write.
  - `mcInit`: after sending `mcMissions` and `updateSchedulerConfig`, also send `mcSchedules` with the mapped schedule array.
- **Edge Cases:** Required-field validation at save — refuse with a message if an action's required field is empty (no target terminal, no from/to column). External type: refuse to persist a board action.

### `src/services/TaskViewerProvider.ts`
- **Context:** The survivor tick (`_tickSurvivorSchedulerJobs`, `:28177`) filters on a hardcoded `survivorSources` set of three (`:28179`). `runSchedulerJob` (`:28197`) has branches for `team-automation`, `fetch-plans`/`reconcile`, and `else` (unsupported source). Both must be widened.
- **Logic:**
  - **Widen the survivor filter** (`:28179`): invert to an explicit exclusion list or widen to include all thirteen action ids. An unlisted source is silently skipped — a schedule that saves, displays as enabled, and never runs.
  - **Add execution branches to `runSchedulerJob`** (`:28197`): for each new source, route to the correct execution path:
    - **Host actions** (`advance-plan`, `advance-feature`, `batch-advance-planning`, `start-ready-mission`, `phone-a-friend`): through `dispatchNextFromQueue` (or the existing verb for batch/phone-a-friend), inheriting `_queueNextChain` serialisation and the in-flight 409. `start-ready-mission` calls the mission launch path and must honour the readiness flag — the UI spec states *"a scheduler or Mission Control must not take an unready mission"*.
    - **Agent actions** (`review-code-vs-intent`, `process-memo`, `improve-docs`, `update-readme`, `send-plans-to-jules`, `research`, `git-pull-push`, `custom`): prompt delivery via the existing preset mechanism, keeping the unattended standing order (`UNATTENDED_ORDER`, `mission-control.js:37`) for planner-class actions. No board authority in any of them.
  - **Extract the cron parser**: replace the `private static _nextCronTime` method with an import from `src/services/cronUtils.ts`. Update `_startWhenScheduleTimer` (`:14079`) and `setWhenSchedule` (`:12333`) to call the imported function.
  - **Add the rule as a comment** on `_tickSurvivorSchedulerJobs` and `runSchedulerJob`: this is the one recurring dispatcher; new recurring work is a `ScheduledJob`; the two front ends are team automations and the Mission Control Schedules tab.
- **Implementation:** The `runSchedulerJob` switch (`:28213-28237`) gains two new arms: one for host-action sources (dispatch path), one for agent-action sources (prompt delivery). The `else` branch (`:28236`) stays as the fallback for truly unknown sources.
- **Edge Cases:**
  - External type: the host must refuse to run an external record even if it carries a board action — check `sourceConfig.type === 'external'` before dispatching.
  - Cron resolution limit: a cron expression that fires more often than the 60s poll cannot fire more often than the poll — document this in the comment.
  - `lastRunAt` unset on a new job: fires on the next poll. Right for advance-when-ready; surprising for `daily` at 23:55. Decide and comment.

### `src/webview/mission-control.js`
- **Context:** The UI is complete — `SCHEDULE_ACTIONS` (`:18`), `_timeOptions` (`:313`), conditional fields, verb posting, and the `mcSchedules` message handler (`:504`) all exist. No changes needed to the webview itself.
- **Logic:** No changes. The webview already posts the seven verbs and handles `mcSchedules`, `mcScheduleLog`, and `updateSchedulerConfig`. The gap is entirely backend.
- **Edge Cases:** The `applySchedulerConfig` handler (`:571`) only updates the survivor job checkboxes — it does not populate the `schedules` array. That is correct: `mcSchedules` is the sole populator, and `mcInit` must send it.

### `src/services/verbSchemas.ts` / `src/generated/verbAllowlist.ts`
- **Context:** The seven schedule verbs are absent from both `verbSchemas.ts` and the generated allowlist. The mission verbs (`mcInit`, `mcNewMission`, etc.) are present in both.
- **Logic:** Add schema entries for the seven verbs to `verbSchemas.ts`. Regenerate `verbAllowlist.ts` with its generator — do not hand-edit.
- **Edge Cases:** A deleted verb still in the allowlist is a hole; a live verb removed from it breaks a caller. Regenerate and diff.

## Verification Plan

### Automated Tests
1. `npm run compile` clean.
2. `npm test` green — including the verb-routing test (`browser-panel-verb-routing.test.js:198-200`) which already lists the seven verbs.
3. A test asserting no scheduled prompt builder emits `BOARD_DRIVING_CONTRACT`, `move-card.js`, or `/kanban/move` (per `scheduled-agents-must-not-move-cards.md`).

### Goal Invariants
- Assert a handler for `mcNewSchedule` exists in `KanbanProvider.ts` (grep `case 'mcNewSchedule'` returns one match).
- Assert `mcInit` handler posts `mcSchedules` (grep `mcSchedules` in the `mcInit` case body returns a match).
- Assert `survivorSources` set in `_tickSurvivorSchedulerJobs` includes all thirteen action ids (or is inverted to an exclusion list).
- Assert `runSchedulerJob` has a branch for at least one host-action source (e.g. `advance-plan`) and at least one agent-action source (e.g. `custom`) — not just the original three.
- Assert `src/services/cronUtils.ts` exists and exports `nextCronTime`.
- Assert `TaskViewerProvider.ts` imports `nextCronTime` from `cronUtils.ts` (grep `from.*cronUtils` returns a match).

### Manual Verification
4. Create a schedule in the panel; confirm it persists across a reload **and** appears in `getSchedulerConfig`'s output.
5. Edit every field type — action, time, columns, complexity, artifacts folder, target terminal, prompt — and confirm each round-trips.
6. Enable a schedule of each of the thirteen actions and confirm each one actually fires. The survivor-filter widening means an un-widened source is the silent failure — test every action id, not a sample.
7. A host action fires: confirm a card moves with `dispatched_terminal` set, and that a second fire against an in-flight team returns the 409 rather than moving anything.
8. `start-ready-mission` against an unready mission: confirm it is not taken.
9. An agent action fires: confirm the prompt arrives at the right terminal/role and contains no board-driving instruction.
10. External type: select it, copy the prompt, assert no config write and nothing scheduled.
11. Team automations modal still lists, creates, enables and `RUN NOW`s its own jobs, and does not show or clobber schedules created in the new tab.
12. Both hosts, with both composition roots read side by side.

## Completion Report

The Mission Control Schedules backend has been implemented end-to-end. Extracted `nextCronTime` and `WHEN_TIMER_CEILING_MS` into `src/services/cronUtils.ts` and widened `ScheduledJob.source` in `GlobalIntegrationConfigService.ts` to include all 13 schedule action IDs. Implemented the seven schedule verbs (`mcNewSchedule`, `mcUpdateSchedule`, `mcStartSchedule`, `mcStopSchedule`, `mcDeleteSchedule`, `mcScheduleLoadLog`, `mcScheduleExternalCopy`) and mapped `mcSchedules` in `KanbanProvider.ts` with schema registration in `verbSchemas.ts` and allowlist generation. Updated `TaskViewerProvider.ts`'s `_tickSurvivorSchedulerJobs` and `runSchedulerJob` to handle cron and interval ticks across host actions (via dispatch/launch) and agent actions (via terminal prompt delivery with unattended orders and zero board-moving authority), with all static parity, schema, and routing ratchet tests verified green.

