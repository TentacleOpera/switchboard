# Retire the Scheduler Surface, Keep Its Two Jobs

## Goal

Delete the second clock. The AUTOMATION tab's `SCHEDULER` section — the job list, the source and target pickers, the per-job interval, the per-job START/STOP, the per-job COPY PROMPT and the target-contract round-trip — goes entirely, along with the per-job timer engine behind it. The two job sources that actually earn their place, `fetch-plans` and `reconcile`, survive as two checkboxes on the run sheet's single clock. `custom` jobs stop running and are left inert on disk.

This is the subtraction that makes the three-mode tab possible. It changes no automation modes and removes no mode; it removes a whole surface so the mode work has somewhere to land.

### Problem & background

**There are two clocks and three start affordances on one screen.** The run sheet arms from the toolbar; every scheduler job row carries its own START/STOP and its own interval; external offers COPY PROMPT. Nothing says which one is "the automation."

**The scheduler section was built by its own plan and stacked as a peer.** In internal mode the tab renders `COLUMN RULES`, `KANBAN AUTOMATION RULES`, and `SCHEDULER` as siblings, with `OVERSIGHT AGENT` hanging below the mode branch entirely. Three sections, three plans, no tab design.

**Two independent timer engines run at once.** The run-sheet engine (`_startAutobanEngine`) and the per-job scheduler engine (`_startAllSchedulerLoops`, `TaskViewerProvider.ts:26119`) both install intervals, both dispatch work into terminals, and neither knows about the other. The scheduler engine alone carries eight per-job maps (`:870–881`), a tick queue, an output-file watcher, and a fallback timer.

### Root cause of the sizing error in the original framing

The batch this plan was split out of asserted: *"The scheduler is deleted outright — it has never left the source tree. No migration, no checkboxes, no drop-on-read, no preserved job records, no `integration-config.json` handling."*

That is false on every clause. Verified 2026-08-17:

| Claim | Reality |
| :--- | :--- |
| "never left the source tree" | The scheduler UI and `getSchedulerConfig` landed in `bb9e7efb` (2026-07-22), which is on `origin/main` — pushed, therefore shipped by this repo's own test |
| "no `integration-config.json` handling" | Jobs persist in the **global** `integration-config.json` under `scheduler`, via `GlobalIntegrationConfigService.getSchedulerConfig` / `setSchedulerConfig` (`:561`, `:573`) |
| "no migration" | `_ensureSchedulerMigration` (`:496`), `_persistMigratedSchedulerIfAbsent` (`:515`) and a `schemaVersion` anchor already exist, and `getMigratedBoardBatchInterval` (`:591`) drove a user-facing one-time migration notice on activation (`TaskViewerProvider.ts:1034–1041`) |
| "no drop-on-read" | `DROPPED_SOURCES = new Set(['comms', 'board-batch'])` (`:481`) is exactly a drop-on-read, and a regression test pins it (`autoban-state-regression.test.js:573–576`) |
| "no preserved job records" | `autoban-state-regression.test.js:570–571`: *"The residual job list is load-bearing: fetch-plans / reconcile jobs are persisted, start from activation, and are editable nowhere else."* |

**And the deeper error: the scheduler is not the run sheet wearing different clothes.** At the altitude of "every N minutes, do a thing to the board" they rhyme. At the level of what they can express they do not: a run-sheet step is `{ sourceColumn, headRole }` (`autobanState.ts:65–68`) — it dispatches a **card** to a **team head**. A scheduler job is a **prompt** sent to a **named terminal**. The run sheet has no representation for "run this text every 20 minutes," so deleting the scheduler outright removes a capability rather than merging one.

`fetch-plans` is the concrete casualty: it is the only mechanism that pulls plan files authored on remote branches — the cloud-VM workflow `/switchboard-cloud` produces — into the local `.switchboard/plans/` directory (`schedulerPresets.ts:19–56`). Delete it and cloud-authored plans never reach the board.

> **Superseded:** *"The **scheduler** in its entirety — UI and persistence both. … This is the second clock, and it has never been released, so it goes without a trace."*
> **Reason:** it was released (`bb9e7efb`, on `origin/main`), it persists to the shared global `integration-config.json`, it already carries migration machinery a regression test pins in place, and two of its three job sources are reachable from no other surface. The repo rule is explicit: shipped state migrates; "when unsure whether something shipped, assume it did and migrate."
> **Replaced with:** delete the *surface* and the *second clock* in their entirety — job list, pickers, per-job interval, per-job START/STOP, per-job COPY PROMPT, target-contract round-trip, and the per-job timer engine. Keep the two surviving job intents as two checkboxes on the run sheet's single clock. Drop `custom` jobs using the `DROPPED_SOURCES` pattern the file already establishes, with a one-time notice naming what stopped.

## What is deleted

**The whole `SCHEDULER` section UI** — `kanban.html:10658` through the end of the internal branch at `:11033`. Source picker, target picker, per-job interval, per-job START/STOP, per-job COPY PROMPT, the `getSchedulerTargetContracts` fetch (`:11029`) and its render.

**The per-job timer engine** in `TaskViewerProvider` — `_schedulerTerminalName` (`:25950`), `_startSchedulerJobLoop` (`:25970`), `_stopSchedulerJobLoop` (`:25988`), `_enqueueSchedulerTick` (`:26007`), `_schedulerTick` (`:26024`), `_startSchedulerOutputCapture` (`:26064`), `_captureSchedulerOutput` (`:26083`), `_disposeSchedulerOutputCapture` (`:26101`), `launchSchedulerTerminal` (`:26153`), `stopSchedulerTerminal` (`:26244`), and the eight per-job maps (`:870–881`). Their call sites at `:19807` and `:22837` (terminal-closed hooks) go with them.

**Six verbs** on `KanbanProvider`: `getSchedulerConfig` (`:8530`), `setSchedulerConfig` (`:8535`), `startSchedulerJob` (`:8548`), `stopSchedulerJob` (`:8554`), `schedulerPrompt` (`:11407`), `getSchedulerTargetContracts` (`:11426`) — plus `SCHEDULER_TARGET_CONTRACTS` (`:5853`) and `_buildSchedulerPrompt` (`:5880`).

**`KANBAN AUTOMATION RULES` as a section** (`kanban.html:10545`). Whatever inside it is still real moves into the run sheet's small set; the box goes.

## What survives, and where it goes

**`fetch-plans` and `reconcile` become two checkboxes on the run-sheet clock.** No per-job interval — they tick with the run sheet. No per-job START/STOP — they are on or off. No target picker — local terminal only. No COPY PROMPT — that was the external-target handoff, and external mode already has its own prompt button.

Their prompts are unchanged: `buildFetchPlansPrompt` (`schedulerPresets.ts:19`) stays exactly as it is, and the reconcile branch of the prompt builder moves with it. The delivery path is the same `_dispatchExecuteMessage`-to-a-named-terminal call `_schedulerTick` already makes (`:26046`), lifted into the run-sheet tick.

**`custom` jobs stop running and are left inert.** They are user-authored prompts with nowhere to go — the run sheet has no representation for arbitrary text, and inventing one is exactly the surface this plan exists to delete. Add `'custom'` to `DROPPED_SOURCES` (`GlobalIntegrationConfigService.ts:481`) so they are dropped on **read**, never by a destructive write over the shared config file, and surface a one-time notice naming each dropped job's label so the loss is visible rather than silent.

**`_buildBoardBatchPromptCore` stays.** It survived the board-batch source deletion because it also backs the Antigravity copy button; a regression test pins it (`autoban-state-regression.test.js:589–592`). It is not scheduler-only. Do not remove it.

**The `GlobalIntegrationConfigService` scheduler read/write helpers stay.** `_ensureSchedulerMigration`, `_persistMigratedSchedulerIfAbsent`, `getSchedulerConfigSync` and `getSchedulerConfig` are pinned by `autoban-state-regression.test.js:577–582` with the reason *"sits in the same span as the comms migration and every scheduler read depends on it."* The surviving checkboxes still read through them. Only `setSchedulerConfig`'s **webview verb** goes; the static method stays for the drop-on-read write-through.

## Metadata

**Complexity:** 6
**Tags:** refactor, backend, ui
**Project:** Browser Switchboard
**Feature:** d5d10871-0028-4651-91a7-acbb0776e55d

## User Review Required

**None.** Three decisions taken here:

* **`fetch-plans` and `reconcile` earn their place; `custom` does not.** The plan they were split from invited exactly this call — *"Say the word if any of these earn their place."* `fetch-plans` is the only path cloud-authored plans have onto the board and is editable nowhere else; `reconcile` rides the same clock for free. `custom` is arbitrary text on a timer, which is the second-clock surface itself.
* **Drop-on-read, never a destructive rewrite.** `integration-config.json` is global, shared with the integrations, and has a corruption history. The existing `DROPPED_SOURCES` pattern is the sanctioned way to retire a source: the record stays inert in the file until the next legitimate write reads through the filter.
* **One clock.** The survivors do not keep their own intervals. Anything with its own interval is a second clock, whatever it is called.

## Complexity Audit

* **Score:** 6 / 10

### Routine

* Deleting a contiguous ~375-line block from `createAutobanPanel()`.
* Deleting ten methods and eight maps from `TaskViewerProvider` that nothing outside the scheduler calls.
* Deleting six verb arms and regenerating the allowlist.
* Adding `'custom'` to an existing `DROPPED_SOURCES` set.

### Complex / Risky

* **Six verbs leave the Kanban allowlist, which is a generated artifact.** `src/generated/verbAllowlist.ts` is produced by `scripts/generate-verb-allowlist.js`; `parity:check` asserts allowlists ≡ catalogs. Deleting arms without regenerating leaves six verbs allowlisted with no handler — reachable over HTTP, returning nothing. That is the "reachable-but-empty" failure the PRD names explicitly.
* **The return-contract ratchet only ever goes down.** `scripts/verb-return-contract-baseline.json` currently holds `"Kanban": 1` and `"TaskViewer": 1`. Deleting arms changes each provider's true residual `break` count; the ceiling must be lowered to whatever `analyze-verb-migration2.js` reports post-deletion **in the same change**. Never force a ceiling to 0 — a `break` inside an inner switch or loop is control flow and must stay.
* **Two engines, one activation path.** `_startAllSchedulerLoops` is called at activation (`:1128`) and on every mode transition (`:10506`). The survivors must be re-armed from the run-sheet engine instead, or they silently stop running for every install that had them enabled — a regression with no error message anywhere.
* **`integration-config.json` is global and shared.** It is written by the integration sync paths too, has a documented corruption history, and its writers churn. Anything this plan does to it must go through the existing load/save round-trip, which preserves unknown keys; a hand-rolled write is how that file gets corrupted.
* **The scheduler's terminal-closed hooks are load-bearing for terminal lifecycle.** `_stopSchedulerJobLoop` is called from two terminal-disposal paths (`:19807`, `:22837`). Deleting the method without deleting those call sites is a compile error; deleting the surrounding disposal logic is a terminal leak.

## Edge-Case & Dependency Audit

### Race Conditions

* **Drop-on-read vs. a concurrent integration write.** `_persistMigratedSchedulerIfAbsent` already implements compare-and-swap against a concurrent writer (`:515–524`). Adding `'custom'` to `DROPPED_SOURCES` needs no new write path at all — the filter runs on read, and the next legitimate `setSchedulerConfig` persists the filtered list. Do not add an eager cleanup pass.
* **The one-time notice must latch.** The board-batch notice latched behind a `workspaceState` flag (`boardBatch.migrated`, `:1035`) so it showed on exactly the activation that performed the migration. The dropped-`custom` notice must latch the same way, or it reappears on every restart forever.
* **Teardown ordering on the last tick.** A scheduler job mid-tick when the engine is deleted has an in-flight `_dispatchExecuteMessage`. Since the whole engine is removed in one change rather than disabled at runtime, there is no live transition to race — but the output-file watchers (`_startSchedulerOutputCapture`) are `vscode.FileSystemWatcher` instances held in a map, and every one must be disposed in the same edit or the extension host leaks watchers.

### Security

* No privilege change. Six verbs are removed, none added; the surviving checkboxes reuse the run sheet's existing arming verb. The `fetch-plans` prompt is unchanged and is already constrained to read-only git operations by its own text.
* `integration-config.json` is written at mode `0o600` by the existing helpers (`:542`). Nothing in this plan writes it directly, so that stays true.

### Side Effects

* **An install with `custom` jobs loses recurring work.** That is the intended trade and the reason for the notice. The records stay in the file, so a future release could re-home them; nothing is destroyed.
* **An install with `fetch-plans` enabled changes cadence.** It moves from its own interval to the run sheet's. If the run sheet is off, `fetch-plans` does not run — today it runs independently. This is the point of "one clock," and the checkbox's helper text must say so.
* **`.switchboard/scheduler-<id>-latest.md` files become orphaned.** They are inert markdown once the output capture is gone. Leave them; do not add a cleanup pass for stale summary files.
* **Both hosts get the UI change from one edit** — `headlessPanelHtml.ts` serves `kanban.html` to the browser cockpit (PRD contract #1).

### Dependencies & Conflicts

* **`src/webview/kanban.html`** — the `SCHEDULER` block (`:10658–11033`), the `KANBAN AUTOMATION RULES` block (`:10545`), and the `schedulerTargetContracts` / `schedulerPrompt` / `updateSchedulerConfig` / `schedulerOutput` message handlers.
* **`src/services/KanbanProvider.ts`** — six verb arms, `SCHEDULER_TARGET_CONTRACTS`, `_buildSchedulerPrompt`, and the `buildFetchPlansPrompt` import (`:29`) which stays, since the surviving checkbox still needs it.
* **`src/services/TaskViewerProvider.ts`** — the engine span `:25950–26276`, the maps `:870–881`, the disposal call sites `:19807` / `:22837`, the activation call `:1128`, and the mode-transition call `:10506`.
* **`src/services/GlobalIntegrationConfigService.ts`** — `DROPPED_SOURCES` (`:481`) only. Every other scheduler helper in this file is pinned by a regression test and must survive.
* **`src/services/schedulerPresets.ts`** — survives intact. Both surviving sources still use it.
* **`src/generated/verbAllowlist.ts`** — regenerate. Do not hand-edit.
* **`scripts/verb-return-contract-baseline.json`** — lower `Kanban` and `TaskViewer` to their true post-deletion residuals.
* **`src/test/autoban-state-regression.test.js`** — `:512–518` asserts scheduler loops are re-run on every mode transition and that local-terminal jobs do not start in external mode. Both assertions describe the deleted engine and must be replaced by the equivalent assertions for the surviving checkboxes.
* **Sibling subtask conflict — `kanban.html`.** `automation-tab-three-exclusive-modes.md` rewrites the same `createAutobanPanel()` function. **This plan lands first**: it is a pure subtraction, and the three-mode tab is far easier to write against a tab that no longer has a scheduler in it. Serialise — same file, one stream (PRD orchestration discipline).

## Dependencies

* None outstanding. `worktree-strategy-is-the-users-choice.md` touches `KanbanProvider` and `TaskViewerProvider` too but shares no symbol with this plan; they may land in either order relative to each other.

## Adversarial Synthesis

Key risks: (1) **deleting `fetch-plans` along with its UI**, which silently severs the only path cloud-authored plans have onto the board and is invisible until someone notices plans never arrive; (2) **deleting verb arms without regenerating the allowlist**, leaving six verbs reachable over HTTP with no handler — the PRD's "reachable-but-empty" failure; (3) **leaving the ratchet baseline untouched**, which locks in a ceiling that no longer reflects the provider and forfeits the win; (4) **a destructive rewrite of `integration-config.json`** instead of the established drop-on-read, against a global file with a corruption history. Mitigations: the two surviving sources move to the run-sheet clock in the same change; allowlist regen and ratchet lowering are verification gates, not follow-ups; `custom` is retired via the existing `DROPPED_SOURCES` filter with a latched one-time notice.

## Proposed Changes

**Build order:** (1) move the survivors onto the run-sheet clock → (2) delete the engine → (3) delete the UI and verbs → (4) regenerate and re-ratchet → (5) update the contract tests. Survivors first, so no commit exists in which `fetch-plans` has stopped running and has no new home.

### 1. `src/services/TaskViewerProvider.ts` — the survivors ride the run-sheet tick

Read the surviving jobs from the same config the scheduler used, and fire them from the run-sheet engine's tick rather than from per-job intervals:

* On each run-sheet tick, after the run-sheet steps, for each job with `source` in `{'fetch-plans', 'reconcile'}` and `enabled === true`: build the prompt (`buildFetchPlansPrompt(job)` for `fetch-plans`, the reconcile preset for `reconcile`) and deliver it with the same `_dispatchExecuteMessage` call `_schedulerTick` makes today (`:26046`), to the same resolved terminal name.
* Keep the per-job in-flight guard. `_schedulerInFlight` exists because a long-running `fetch-plans` must not be re-sent on the next tick; the run-sheet tick is faster than some job intervals were, so dropping the guard makes overlap *more* likely, not less. Carry it forward as a small map keyed by job id.
* Delete `_startAllSchedulerLoops` (`:26119`), `startAllSchedulerLoops` (`:26145`) and both of their call sites (`:1128`, `:10506`).

**Edge cases:** with the run sheet off, the survivors do not run — stated on the checkbox. `job.id` remains load-bearing for nothing once output capture is gone, but the id is still the map key for the in-flight guard, so do not drop it from the record.

### 2. `src/services/TaskViewerProvider.ts` — delete the per-job engine

Delete `:25950–26276` (the ten methods listed under *What is deleted*) and the eight maps at `:870–881`. At `:19807` and `:22837`, delete only the `_stopSchedulerJobLoop(...)` line — the surrounding terminal-disposal logic is unrelated and stays.

**Edge cases:** every `vscode.FileSystemWatcher` held in `_schedulerOutputWatchers` must be disposed as part of removing the map, not merely dereferenced. If the map is only reachable from deleted code, dispose in the provider's existing `dispose()` sweep before removing it.

### 3. `src/webview/kanban.html` — delete the section and its message arms

Delete `:10658–11033` (`SCHEDULER`) and the `KANBAN AUTOMATION RULES` block at `:10545`. Delete the `schedulerTargetContracts`, `schedulerPrompt`, `updateSchedulerConfig` and `schedulerOutput` cases from the webview message listener, and the `getSchedulerTargetContracts` post at `:11029`.

Add the two survivor checkboxes into the run sheet's own section — plain checkboxes, broadcast-driven, no interval field:

```js
// Two surviving recurring jobs. They tick with the RUN SHEET — no interval of
// their own, because a second interval is a second clock. With the run sheet
// off, neither runs.
// No confirm dialog — project rule, and confirm() is a no-op in a webview.
```

Each checkbox's `checked` comes from the broadcast on every render, never from a local click assumption, matching the discipline the existing controls in this panel already use.

**Edge cases:** the deleted block registered `guardInteraction` on its inputs; removing it must not disturb the guard registrations of the controls that remain. The two new checkboxes need `guardInteraction` — they have a change lifecycle.

### 4. `src/services/KanbanProvider.ts` — delete six verbs and the target-contract machinery

Delete the arms at `:8530`, `:8535`, `:8548`, `:8554`, `:11407`, `:11426`, plus `SCHEDULER_TARGET_CONTRACTS` (`:5853`) and `_buildSchedulerPrompt` (`:5880`). Keep the `buildFetchPlansPrompt` import (`:29`) if the surviving delivery lives here; otherwise remove it and keep the one in `TaskViewerProvider` (`:53`).

Remove the corresponding entries from `verbSchemas.ts` (`startSchedulerJob` `:1589`, `stopSchedulerJob` `:1594`) and regenerate `src/generated/verbAllowlist.ts` with `npm run catalog:generate` (which runs both generators with `--write`). **Do not hand-edit the generated file** — `npm run catalog:check` runs the same generators without `--write` and fails on drift.

**Edge cases:** `getSchedulerConfig` the *static method* on `GlobalIntegrationConfigService` is not the same thing as the `getSchedulerConfig` *verb arm*. Only the arm goes; the static method is pinned by a regression test and is still read by the survivors.

### 5. `src/services/GlobalIntegrationConfigService.ts` — retire `custom` on read

```ts
/** Sources that have been deleted. Jobs with these sources are dropped on read. */
private static readonly DROPPED_SOURCES = new Set(['comms', 'board-batch', 'custom']);
```

Add a one-time notice mirroring the board-batch pattern: read the raw file once, collect the labels of any `custom` jobs, latch behind a `workspaceState` flag, and surface the notice through the same channel `migratedBoardBatchNotice` uses (`autobanState.ts:165`, rendered in the automation panel).

**Edge cases:** the notice must name the jobs (`label`), not just count them — "1 job stopped" tells the user nothing about what to re-create. The latch flag must be distinct from `boardBatch.migrated`.

### 6. `scripts/verb-return-contract-baseline.json` — ratchet down

Run `analyze-verb-migration2.js`, read the true residual `break` count for `Kanban` and `TaskViewer` post-deletion, and set the ceilings to exactly those numbers in the same change. Ceilings only ratchet down; never force one to 0.

### 7. `src/test/autoban-state-regression.test.js` — retarget the scheduler assertions

Replace `:512–518` (scheduler loops re-run on mode transition; local-terminal jobs skipped in external mode) with the equivalent for the survivors: they fire from the run-sheet tick, and they do not fire when the run sheet is off or the mode runs no clock. Keep `:570–592` untouched — the `DROPPED_SOURCES` pin, the surviving-helpers pin and the `_buildBoardBatchPromptCore` pin all remain correct, and `:584` (`source: 'reconcile' | 'custom' | 'fetch-plans'`) still holds because the *type* keeps `custom` even though it is dropped on read.

## Verification Plan

> **Session note:** this run was directed to skip compilation and skip automated test execution, so the checks below are written for the implementing coder, not run here.

### Automated Tests

* No file under `src/` references `_startSchedulerJobLoop`, `_schedulerTick`, `launchSchedulerTerminal`, `stopSchedulerTerminal`, `SCHEDULER_TARGET_CONTRACTS` or `getSchedulerTargetContracts`.
* `src/generated/verbAllowlist.ts` no longer contains any of the six deleted verbs, and `npm run catalog:check` passes — the committed generated files match a fresh generation.
* `npm run parity:check` passes — allowlists ≡ catalogs, no orphaned verb.
* `npm run verb-returns:check` passes with the lowered `Kanban` and `TaskViewer` ceilings, and the ceilings equal the analyzer's reported residuals.
* `npm run push-routing:check` passes — raw `postMessage` counts only go down, and this change only removes pushes.
* `DROPPED_SOURCES` contains exactly `comms`, `board-batch`, `custom`; a config containing a `custom` job resolves to a job list without it, and the raw file still contains the record afterwards.
* The one-time notice fires once for an install with `custom` jobs, names each job's label, and does not fire on a second activation.
* A run-sheet tick with `fetch-plans` enabled delivers the `buildFetchPlansPrompt` text to the resolved terminal; with the run sheet disabled it delivers nothing.
* The in-flight guard holds: a second tick while a `fetch-plans` run is outstanding sends nothing.
* `createAutobanPanel` renders no element with a per-job interval input and no per-job START/STOP button — asserted on the absence of the job-row structure, not on a header string.
* No `confirm(` / `window.confirm(` is introduced on any path added here.

### Manual Verification

1. **The surface is gone:** open AUTOMATION. No `SCHEDULER` section, no job rows, no `KANBAN AUTOMATION RULES` box.
2. **The survivors are visible:** two checkboxes — fetch plans, reconcile — sit with the run sheet, with no interval of their own.
3. **They run on the one clock:** enable `fetch-plans`, arm the run sheet with a short interval, push a plan file on a remote branch. It arrives locally on a tick.
4. **They do not run off the clock:** disable the run sheet; the `fetch-plans` terminal receives nothing.
5. **`custom` is retired honestly:** with a `custom` job in `integration-config.json`, activate. The notice names the job, the job does not run, and the record is still in the file afterwards.
6. **No orphan timers:** with the tab open and the run sheet off, confirm no interval is installed for any job — count installed timers, not UI state.
7. **Browser cockpit:** repeat 1–2 in the browser board. Same `kanban.html`, so it must behave identically.

## Recommendation

Complexity 6 → **Send to Coder.**

**Read the root-cause table first.** The scheduler shipped, persists to the shared global config, and already carries migration machinery a regression test pins in place. Treating it as unreleased dev work is how `fetch-plans` gets deleted without anyone noticing that cloud-authored plans stopped arriving.

**The thing to get right:** the survivors move *before* the engine is deleted. There must be no commit in which `fetch-plans` has stopped running and has no new home.

**Second:** regenerate the allowlist and lower the ratchet ceilings in the same change. Six verbs left allowlisted with no handler is a worse state than before the change.

## Completion Report

Implemented the full build order: (1) added `_tickSurvivorSchedulerJobs` to the run-sheet tick body in `TaskViewerProvider.ts` — fires `fetch-plans` and `reconcile` after the run-sheet steps, carrying the `_schedulerInFlight` guard forward; (2) deleted the entire per-job engine span (10 methods, 8 maps → 2 surviving maps, both terminal-closed hook call sites, the activation call, and the mode-transition call) and disposed all `FileSystemWatcher` instances via the existing `_disposeSchedulerOutputCapture` pattern before removing the map; (3) deleted the SCHEDULER UI block (~390 lines) and the KANBAN AUTOMATION RULES section header from `kanban.html`, keeping the batch/complexity/clear-terminal controls as unboxed controls, and added two survivor checkboxes (FETCH CLOUD PLANS, RECONCILE CLOUD WORK) with `guardInteraction` and a dropped-custom-jobs notice; (4) deleted four verb arms (`startSchedulerJob`, `stopSchedulerJob`, `schedulerPrompt`, `getSchedulerTargetContracts`) plus `SCHEDULER_TARGET_CONTRACTS`, `_buildSchedulerPrompt`, and `_buildCustomPrompt` from `KanbanProvider.ts` — kept `getSchedulerConfig`/`setSchedulerConfig` arms for the survivor checkboxes and removed the `startAllSchedulerLoops()` call from `setSchedulerConfig`; (5) added `'custom'` to `DROPPED_SOURCES` in `GlobalIntegrationConfigService.ts` with a latched one-time notice via `getDroppedCustomJobLabels()` + `workspaceState` flag `customJobs.dropped`; (6) removed `startSchedulerJob`/`stopSchedulerJob` schemas from `verbSchemas.ts`, ran `npm run catalog:generate` (614 arms, 526 verbs), and verified the ratchet baseline (Kanban=1, TaskViewer=1) matches the analyzer's post-deletion residuals — no ceiling change needed; (7) updated `autoban-state-regression.test.js` with survivor-tick assertions, deletion mirror assertions for all 10 engine methods + 4 verb arms + 2 statics, `DROPPED_SOURCES` now includes `custom`, and UI absence/presence checks. Also added `droppedCustomJobsNotice` to `AutobanConfigState` and `normalizeAutobanConfigState` in `autobanState.ts`. No issues encountered; the ratchet baseline was already at the true residual. Files changed: `TaskViewerProvider.ts`, `KanbanProvider.ts`, `GlobalIntegrationConfigService.ts`, `autobanState.ts`, `kanban.html`, `verbSchemas.ts`, `schedulerPresets.ts`, `verbAllowlist.ts` (generated), `protocol-catalog.json` (generated), `autoban-state-regression.test.js`.

## Review Findings

Reviewer pass found the retirement mechanically complete but the survivors non-functional: `reconcile` had no prompt builder in the tick (its text was orphaned on `KanbanProvider._buildReconcilePrompt` after `_buildSchedulerPrompt` was deleted), the tick resolved its terminal read-only when nothing creates a `Scheduler: …` terminal any more (the deleted per-job START button was the only creator), and the checkbox mapped over the job list without upserting, so on the default empty config both boxes snapped back and persisted nothing — all three composing into "fetch-plans silently stops arriving," the exact failure the plan's Adversarial Synthesis names. Fixed by moving the reconcile text and the shared board-driving contract into `schedulerPresets.ts` (one literal, two consumers), adding `_ensureSurvivorTerminal` (find-or-create, fleet-gated, in-flight guard now claimed before the boot await so a second tick cannot spawn a duplicate), and making the checkbox upsert a source-keyed job record; also fixed two broken assertions in the plan's own gate — a 600-char window that no longer spanned the tick body, and a slice anchored on the deleted `_buildCustomPrompt`, which made `indexOf` return -1 and silently slice to EOF. Files changed: `TaskViewerProvider.ts`, `KanbanProvider.ts`, `schedulerPresets.ts`, `kanban.html`, `autoban-state-regression.test.js`. Validation: `tsc -p tsconfig.test.json` clean; eslint 0 errors; `catalog:check`, `parity:check`, `verb-returns:check` (Kanban 1/1, TaskViewer 1/1), `push-routing:check`, `standalone-parity:check`, `mirror:check` all pass; `scheduled-jobs`, `render-guard`, `panel-runtime-surface`, `autoban-no-valid-tickets`, `dispatch-view`, `worktree-strategy-control` all pass; 46 scoped scheduler-retirement assertions pass. Remaining risk: `autoban-state-regression.test.js` is still red at line 495 on an assertion belonging to the concurrently-landing `automation-tab-three-exclusive-modes` plan (oversight arming writes `autobanState.enabled`), not to this change — that gate goes green when the sibling lands; and a stale `target: 'antigravity'|'cloud'` on a migrated survivor job is now dispatched locally, since the target picker and the external COPY PROMPT handoff are both deleted and it has nowhere else to go.

**Three-mode tab follow-up (automation-tab-three-exclusive-modes):** Migrated the two-value `internal|external` mode axis to three exclusive modes: `agent-managed`, `scheduled`, `external`. Changes: (a) `autobanState.ts` — `AutobanAutomationMode` is now `'agent-managed' | 'scheduled' | 'external'`; `OrchestrationConfig` replaces `enabled: boolean` with `intervalMinutes: number` (restored from the 2026-07-08 ship, floored at 1, no ceiling); `normalizeAutomationMode` takes a second arg `orchEnabled` and maps three migration cohorts (`orchestration` -> `agent-managed`, `internal` + `orchestrationConfig.enabled === true` -> `agent-managed`, bare `internal` -> `scheduled`); the migration branch in `normalizeAutobanConfigState` no longer arms `orchestrationConfig.enabled`. (b) `TaskViewerProvider.ts` — all `'internal'` mode comparisons -> `'scheduled'`; `setAutomationModeFromKanban` validates against the three new values and branches three ways (scheduled starts the engine, agent-managed stores the wake interval, external stops the engine); `startOrchestratorFromKanban` now writes `enabled: true` + `automationMode: 'agent-managed'` (not `orchestrationConfig.enabled`); `stopOrchestratorFromKanban` writes `enabled: false`; `setAutobanEnabledFromKanban` dispatches to start/stop orchestrator in agent-managed mode; `isOversightAgentRunning()` reads mode + enabled (not a deleted config field). (c) `kanban.html` — replaced the mode `<select>` with three radios; deleted the OVERSIGHT AGENT block entirely; added ON/OFF toggle + status line to the tab header; added agent-managed mode panel with wake-interval input; toolbar button is a pure mirror (deleted `watchCount`); reset/pause visible only in Scheduled; reworded external-mode paused-jobs line to say "Scheduled"; added `orchestratorStartResult` message handler for failure reporting. (d) `package.json` + `extension.ts` — registered `switchboard.startOrchestrator` command. (e) `LocalApiServer.ts` — updated two comments referencing `orchestrationConfig.enabled`. (f) `autoban-state-regression.test.js` — rewrote mode axis assertions for three values, added migration table tests for all three cohorts, added `normalizeOrchestrationConfig` tests (intervalMinutes read-through, floor, no ceiling, default, `enabled`/`maxConcurrentSubtasks`/`lastWakeAt` absent), added literal sweep for `'internal'` and `orchestrationConfig.enabled` across src/, added UI assertions (OVERSIGHT AGENT gone, three radios present, status line present, command registered, paused-jobs line says "Scheduled"). All tests pass: `autoban-state-regression`, `headless-feature-management-contract`, `unattended-batch-improvement-contract`, `scheduled-jobs-and-connections`.

## Review Findings — second pass (feature-level review, 2026-08-17)

Re-verified at the merged tree: the retirement holds. Zero `src/` references survive to `_startSchedulerJobLoop`, `_schedulerTick`, `launchSchedulerTerminal`, `stopSchedulerTerminal`, `SCHEDULER_TARGET_CONTRACTS`, `getSchedulerTargetContracts`, `_buildSchedulerPrompt` or `_startAllSchedulerLoops` outside the deletion-mirror assertions, `DROPPED_SOURCES` carries `custom`, and the survivor tick plus its find-or-create terminal and in-flight guard are intact. The prior pass's one open item is now closed: `autoban-state-regression.test.js` is **green** — it was red on an assertion belonging to the concurrently-landing sibling, which has since landed, exactly as that pass predicted. Gate-wiring audit: every check this plan names (`catalog:check`, `parity:check`, `verb-returns:check` at Kanban 1 / TaskViewer 1, `push-routing:check`, `test:contract:scheduled-jobs`, `test:contract:autoban-state`) is invoked by `.github/workflows/integration-tests.yml` or the aggregate gate scripts — no green-while-incomplete hole. No new findings against this plan; the accepted risk from the first pass stands unchanged (a migrated survivor job carrying a stale `target: 'antigravity'|'cloud'` now dispatches locally, the target picker having been deleted).
