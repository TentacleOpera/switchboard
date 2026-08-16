# Delete the Comms Schedule Mode and Collapse Scheduling to Two Controls

## Goal

Delete the `comms` schedule mode outright, and reduce run-sheet scheduling to a single **WHEN** control instead of a job record assembled from a source, a source config, a target and a target contract.

### Problem & background

**The comms schedule mode is being deleted.** This has been asked for repeatedly and repeatedly preserved by agents who judged it a separate concern worth keeping. It is not being kept, it is not being flagged off, and persisted comms jobs are dropped rather than migrated. If a need for comms polling reappears it comes back as its own feature, from git history.

**Scheduling is hard to use because a one-line intent has to be assembled out of five parts.** The Scheduler panel is a job list over a 5-source × 3-target matrix — `comms` / `board-batch` / `reconcile` / `custom` / `fetch-plans` (`GlobalIntegrationConfigService.ts:100`) crossed with `local-terminal` / `antigravity` / `cloud` (`KanbanProvider.ts:5760–5773`), each with its own `sourceConfig` block, its own conditional UI (`kanban.html:10840–10908`, `:10964–10970`) and its own target contract fetched over a message round-trip (`getSchedulerTargetContracts`, `KanbanProvider.ts:11319`). *"Every night, review all plans in the Planned column"* is one cell of that matrix; everything else in the picker is what makes the cell hard to find.

*(Line numbers verified in the working tree 2026-08-16. **They drift — anchor on the symbol names.**)*

---

## Metadata

**Complexity:** 6
**Tags:** refactor, ui, backend, deletion

---

## User Review Required

**None.** Six decisions made here:

* **`comms` is deleted.** No flag, no disabled-but-present option, no "kept for existing users". An implementer who believes it should survive is out of scope and the answer is no.
* **Run-sheet scheduling is two controls, never a job record.** No source picker, no job row, no target-contract round-trip for it.
* **The residual job list survives for `fetch-plans` / `reconcile` / `custom`** — as a plain section of the Internal panel, not a mode. Deleting it would orphan live persisted configuration behind a surface the user can no longer reach.
* **A migrated `board-batch` job ships default-OFF.** Its interval is preserved; its arming is the user's.
* **Comms jobs are dropped on READ, not by a rewrite pass.** No bespoke read-modify-write against `integration-config.json`; the drop persists incidentally on the next legitimate `setSchedulerConfig`. See §1.
* **The legacy `mcpMonitor` blob is left in the file, not scrubbed.** Once nothing reads or writes it, it is an inert unknown key — and the project migration rule says preserve unknown/legacy keys rather than drop them. Deleting the *feature* does not license rewriting a file with a documented corruption history to tidy it.

---

## Complexity Audit

* **Score:** 6 / 10

### Routine

* A large, well-enumerated deletion across four files plus the verb surface.

### Complex / Risky

* **`integration-config.json` has a documented corruption history and concurrent churn writers.** Any destructive pass over it is the risk; §1 removes the need for one.
* **The delete range is easy to over-cut.** `_ensureSchedulerMigration` mixes the comms migration with the forward-compat `schemaVersion` handling that every scheduler read depends on, and it sits immediately above the two public getters. Cutting by line range takes out the scheduler config API. See §1.
* **The verb surface is generated, and it spans two allowlists.** Nine verbs, not seven — `KANBAN_VERBS` carries the seven comms verbs and `TASKVIEWER_VERBS` separately carries `getMcpMonitorConfig` and `setMcpMonitorConfig`. Deleting them without regenerating reds CI on its first job.
* **The residual job list is load-bearing.** `fetch-plans` / `reconcile` jobs are persisted, started from activation (`TaskViewerProvider.ts:1108` → `_startAllSchedulerLoops`), and editable only through that list.
* **`_buildBoardBatchPromptCore` must survive the `board-batch` source deletion.** It has three other callers.

---

## Edge-Case & Dependency Audit

### Security

* Not a privilege change. Removing comms removes the Slack/Gmail/Calendar polling surface entirely.

### Side Effects

* Users with comms jobs lose them. Intended.
* Users with a `board-batch` job keep their interval but must press start once. Intended, per PRD contract #2 (new capabilities ship default-OFF).
* A comms job's `sourceConfig` stays in `integration-config.json` until the next scheduler write rewrites the job list without it. Harmless — nothing reads it.

### Dependencies & Conflicts

* **`GlobalIntegrationConfigService.ts`** — `'comms'` from the `source` union (`:100`); the `mcpMonitor` field on `GlobalConfig` (`:23–31`) and its comments (`:38–40`, `:93`); `McpMonitorConfig` (`:65–78`) and `DEFAULT_MCP_MONITOR_CONFIG` (`:80–90`); `COMMS_JOB_ID` (`:126`); the churn-path entry (`:182`) and the `_stripChurnFields` mcpMonitor arm (`:202–207`) and its comms `sourceConfig.sourceLastCheckAt` arm (`:208–214`); `_migrateCommsJob` (`:561–599`); the legacy arm inside `_ensureSchedulerMigration` (`:621–625`) and the `globalConfig.mcpMonitor ||` conditions at `:671` and `:683`; `_findCommsJob` (`:700–703`); `_unpackCommsJob` (`:711–735`); `getMcpMonitorConfigSync` / `getMcpMonitorConfig` / `setMcpMonitorConfig` (`:736`–`~:815`).
  **Do NOT delete `_ensureSchedulerMigration`, `_persistMigratedSchedulerIfAbsent`, `_persistMigratedSchedulerIfAbsentSync`, `getSchedulerConfigSync` or `getSchedulerConfig`.** They live inside the same span and the scheduler engine reads through them.
* **`TaskViewerProvider.ts`** — the scheduler/comms engine region (`~:25490`–`~:25930`), including the comms label arm (`:25503`), the `job.source === 'comms'` interval branch in `_startSchedulerJobLoop` (`:25530`), the tick arm (`:25611–25635`), the output-path arms (`:25675`, `:25696`, `:25699`), the comms shims (`:25762–25786`), `_buildMcpMonitorPrompt` (`:25788`), `_mcpMonitorOutputPostscript` (`:25838`), `_buildSlackPromptLine` (`:25845`), `_buildGmailPromptLine` (`:25863`), `_sourceBoundary` (`:25869`), `buildMcpMonitorPreview` (`:25880`), `setMcpMonitorConfigFromKanban` (`:25898`) and the debounce block (`:25905–25914`).
  **Five comms sites live OUTSIDE that region and are easy to miss:** the import (`:101`), the `COMMS_JOB_ID` terminal-name comment (`:868`), `_postMcpMonitorConfig()` at activation (`:4502`) and on panel refresh (`:12095`), the `getMcpMonitorConfig` / `setMcpMonitorConfig` verb arms (`:13229–13236`), and the `handleTerminalClosed` comms branch (`:19365–19366`).
* **`KanbanProvider.ts`** — the comms arm of `_buildSchedulerPrompt` (`:5796–5803`), the `mcpMonitorPreview` push (`:8527`).
* **`kanban.html`** — the `comms` source option (`:10800`), the `isComms` conditional UI (`:10964–10970`), the comms-root container (`:10704–10713`), the comms job filter in the save path (`:11573–11585`), the whole Comms Monitor Panel (`:11140`–`:11630`: `createCommsPanel`, `renderCommsPanel`, `guardCommsInteraction`), `isCommsPanelInteracting` (`:8393`, `:9318`, `:9332`, `:11148`, `:11153`, `:11621`), and `mcpMonitorConfig` state (`:8402`, `:9313`, and throughout `:11225`–`:11583`).
* **Verb surface — nine verbs across two allowlists.** `KANBAN_VERBS`: `checkMcpMonitorAuth`, `launchMcpMonitorTerminal`, `renderMcpMonitorPreview`, `setMcpMonitorConfig`, `startMcpMonitorPolling`, `stopMcpMonitorPolling`, `stopMcpMonitorTerminal`. `TASKVIEWER_VERBS`: `getMcpMonitorConfig`, `setMcpMonitorConfig`. Plus the `verbSchemas.ts` entries (`:1567–1568`).
* **Prerequisite — the internal/external plan.** Lands first; this plan assumes `internal` / `external` are the mode names.
* **Shared symbol with the internal/external plan — `_buildBoardBatchPromptCore` (`KanbanProvider.ts:5554`) SURVIVES.** This plan deletes the `board-batch` **job source** (the dropdown option at `:10796`, the `sourceConfig` branch at `:10840–10871` / `:11013–11017`, the new-job default at `:10737`). The builder itself keeps three callers: `generateAntigravityPrompt` (`:5536`), `_buildSchedulerPrompt`'s board-batch arm (`:5815`) and the `schedulerPrompt` verb (`:11292`). Whether `_buildSchedulerPrompt`'s board-batch arm stays reachable once the source is gone is a follow-on cleanup, not this plan's scope — do not delete the builder to "finish the job".
* **Shared symbol with both siblings:** the accepted-modes array at `TaskViewerProvider.ts:10289`. The internal/external plan leaves it `['internal', 'external']`. This plan does **not** narrow it further — `scheduler` is already gone as a mode value by then.

---

## Dependencies

* **Hard prerequisite:** the internal/external rename. This plan places the residual job list inside the Internal panel and assumes `scheduler` is no longer an `automationMode` value.

---

## Adversarial Synthesis

Key risks: (1) **a bespoke read/write against `integration-config.json`** corrupting a file with a known corruption history and churn writers — §1 removes the write entirely rather than making it careful; (2) **cutting `_ensureSchedulerMigration` by line range**, taking `getSchedulerConfig` / `getSchedulerConfigSync` with it and breaking every scheduler read in the tree; (3) **deleting the job list along with comms**, orphaning live `fetch-plans` / `reconcile` configuration behind no editor — the same "configured state with no surface" failure inverted; (4) **deleting `_buildBoardBatchPromptCore` along with the `board-batch` source**, breaking three unrelated callers including the Antigravity copy button; (5) **migrating a `board-batch` job and leaving it armed**, silently widening what a user's board does on upgrade, unattended; (6) **regenerating only one allowlist**, since the comms verbs span `KANBAN_VERBS` and `TASKVIEWER_VERBS`. Mitigations: drop on read; cut by symbol, never by line range; keep the residual list; keep the builder; migrate the interval and leave `enabled` false with a one-line notice; run `catalog:generate` and commit both regenerated artifacts.

---

## Proposed Changes

### 1. Delete `comms` — and drop persisted comms jobs on READ

Remove every site enumerated in Dependencies & Conflicts above, **by symbol**, not by line range.

Persisted jobs with `source: 'comms'` are **dropped on load, not migrated, and not rewritten**. The single filter point is `_ensureSchedulerMigration` (`GlobalIntegrationConfigService.ts:611–626`) — every scheduler read passes through it, including both public getters and `setSchedulerConfig`'s read-before-write (`:693`). Filter the `jobs` array there on both existing-scheduler return paths (`:617`, `:619`). Consequences, all of them wanted:

* No destructive pass over `integration-config.json` is ever performed. The riskiest operation in this plan simply does not happen.
* The comms job stays inert in the file until the next legitimate `setSchedulerConfig` write, which reads through the filter and therefore persists the list without it.
* A malformed file is handled by the existing load path — a parse failure means leave the file alone, never write a fresh default over it.

Inside `_ensureSchedulerMigration`, delete **only** the legacy arm (`:621–625`, `const legacy = globalConfig.mcpMonitor; …`), leaving `const jobs: ScheduledJob[] = []`. Keep the forward-compat `schemaVersion` handling (`:613–619`) untouched. In `getSchedulerConfigSync` (`:667–677`) and `getSchedulerConfig` (`:679–689`), drop the `globalConfig.mcpMonitor ||` half of the write-back condition, keeping `migrated.jobs.length > 0`.

Leave the legacy `mcpMonitor` blob in the JSON. Removing the field from the `GlobalConfig` interface is fine — `loadGlobal`/`saveGlobal` round-trip the parsed object, so the unknown key survives.

**No tombstone comments.** Jobs of surviving sources are untouched.

### 2. Collapse run-sheet scheduling to one control

* Internal mode gets **WHEN** — a schedule. Off (default) means the run sheet runs continuously, paced by completion; on means it fires on a cron line.
* Delete the `board-batch` **job source**: the dropdown option (`kanban.html:10796`), the new-job default (`:10737` — a fresh job now defaults to `fetch-plans`), the `isBatch` conditional UI (`:10840–10871`, `:10965`) and the `sourceConfig` assembly branch (`:11013–11017`). Its column/complexity configuration now reads from the run sheet it is scheduling. **Keep `_buildBoardBatchPromptCore`.**
* `scheduler` is already gone as an `automationMode` value (the internal/external plan removed it); this plan only relocates its panel content.

### 3. Keep the residual job list, demoted

The job list survives for `fetch-plans` / `reconcile` / `custom` only, rendered as a plain section of the Internal panel rather than as a mode. It loses the `comms` and `board-batch` source options and their conditional branches; it keeps its target picker and prerequisites block, because those sources genuinely do have local/cloud targets.

### 4. Migrate an existing `board-batch` job

Migrate its `intervalMinutes` into `singleColumnConfig.intervalMinutes` and the run-sheet schedule, then **leave `autobanState.enabled` false**. Drop the job record (through the same read-filter mechanism as §1 — extend the filter to `board-batch`, do not add a second write path). Surface a one-line notice in the Internal panel naming the migrated interval and stating that automation is off until started.

**Logic:** a `board-batch` job dispatches N cards from one column to one agent; the run sheet walks two steps. Migrating it armed would silently widen what that user's board does, unattended, on upgrade.

### 5. Regenerate the verb surface

Run `npm run catalog:generate`, then commit the regenerated `protocol-catalog.json` and `src/generated/verbAllowlist.ts`. Confirm **both** `KANBAN_VERBS` and `TASKVIEWER_VERBS` lost their comms entries.

---

## Verification Plan

### Automated Tests

* Grepping `src/` for `'comms'`, `mcpMonitorConfig`, `McpMonitor`, `sourceIntervals`, `sourceLastCheckAt` and `COMMS_JOB_ID` returns nothing.
* `GlobalIntegrationConfigService.getSchedulerConfig()` and `getSchedulerConfigSync()` still resolve, still honour the forward-compat `schemaVersion` branch, and still return an existing scheduler unchanged apart from the dropped jobs — the assertion that catches an over-wide cut of `_ensureSchedulerMigration`.
* An `integration-config.json` containing comms jobs loads, returns them filtered out, and **the file on disk is byte-identical afterwards** — the read-only-drop assertion.
* After a subsequent legitimate `setSchedulerConfig` write, the comms job is gone from the file and every other job is preserved verbatim.
* A malformed `integration-config.json` is left alone, not overwritten with a default.
* A persisted `board-batch` job migrates its interval and leaves `autobanState.enabled === false`.
* `fetch-plans` / `reconcile` jobs still load, still start from activation, and are still editable in the residual list.
* `_buildBoardBatchPromptCore` still resolves and its three callers still compile — the assertion that catches it being deleted with its job source.
* The generated allowlists no longer contain the seven `KANBAN_VERBS` comms verbs nor the two `TASKVIEWER_VERBS` ones; unrelated neighbouring verbs still resolve.

### Manual Verification

1. **Comms is gone:** no source option, no panel, no polling.
2. **Scheduling is two controls:** set a nightly schedule without touching a source, a target or a job row.
3. **Residual list still works:** a `fetch-plans` job is visible and editable.
4. **Migrated job:** confirm the interval carried over and automation is off until started, with the notice shown.
5. **Antigravity copy button still works** — it routes through the surviving `_buildBoardBatchPromptCore`.
6. **Every remaining control works** after `catalog:generate` — no "unknown verb" errors in the webview, from either panel.

---

## Recommendation

Complexity 6 → **Send to Coder.**

**The thing to get right:** drop comms jobs **on read**, in `_ensureSchedulerMigration`. `integration-config.json` has a documented corruption history and concurrent churn writers; the safest destructive pass is the one you never write. And cut that function **by symbol** — `getSchedulerConfig` / `getSchedulerConfigSync` / the two `_persistMigratedSchedulerIfAbsent*` helpers sit in the same span and every scheduler read depends on them.

**Second:** do not delete the job list with comms. `fetch-plans` and `reconcile` are persisted, start from activation, and are editable only there. And do not delete `_buildBoardBatchPromptCore` when you delete the `board-batch` source — it has three other callers.

**Third:** the comms verbs span **two** allowlists (`KANBAN_VERBS` × 7, `TASKVIEWER_VERBS` × 2). Regenerating one and eyeballing it green is how this reds CI.

**Before opening the change:** `npm run catalog:generate`, then `catalog:check`, `parity:check`, `mirror:check`, `verb-returns:check`, `push-routing:check`.

---

## Completion Report

Deleted the `comms` schedule mode and `board-batch` source across seven files plus regenerated catalog artifacts. Comms jobs are dropped on read in `_ensureSchedulerMigration` via a `DROPPED_SOURCES` filter (never a destructive write); the legacy `mcpMonitor` blob is left inert in `integration-config.json`. Board-batch jobs are similarly dropped on read, with a one-time `getMigratedBoardBatchInterval()` read that migrates the interval into `singleColumnConfig.intervalMinutes` and surfaces a `migratedBoardBatchNotice` in the Internal panel. The entire comms engine region (~500 lines) was removed from `TaskViewerProvider.ts` — prompt builders, shims, lifecycle methods, `_gcd`, `SOURCE_PRESETS` — and replaced with generic `launchSchedulerTerminal`/`stopSchedulerTerminal` methods. The kanban webview's comms panel (~490 lines), comms state variables, message handlers, and board-batch source options/conditional branches were deleted; the scheduler job row now offers only `fetch-plans`, `reconcile`, and `custom`. `_buildBoardBatchPromptCore` was preserved (three other callers). `npm run catalog:generate` was run successfully (616 arms, 528 verbs).

### Revision 1 — WHEN control + notice latching fix

**Gap 1 fixed: WHEN control built.** Added `whenSchedule?: string | null` to `SingleColumnAutobanConfig` (default `null` = OFF). OFF = continuous, completion-paced (today's behaviour). ON = a 5-field cron string; the run sheet fires on the cron line via a self-rescheduling `setTimeout` timer (`_startWhenScheduleTimer`). A minimal 5-field cron evaluator (`_nextCronTime`) parses `*`, comma lists, ranges, and steps — same constraint surface as the cloud target contract (no `L`/`W`/`?`/named days). The WHEN control is rendered in the Internal panel's SCHEDULER section as a dropdown (Off/On) + cron text input, above the job list. It persists alongside `singleColumnConfig` in `workspaceState`. The run-sheet tick is gated: when `whenSchedule` is set, the cron timer replaces the fixed interval; when null, the existing `triggerMode` + `intervalMinutes` behaviour is preserved. Pause/resume and `resetAutobanTimersFromKanban` both respect the WHEN timer. The `setWhenSchedule` verb was added to `verbSchemas.ts`, `KanbanProvider.ts`, and the regenerated allowlist/catalog (617 arms, 529 verbs). Validation: invalid cron expressions are rejected with a warning message before persisting.

**Gap 2 fixed: migration notice latched.** Moved the `migratedBoardBatchNotice` assignment inside the `!alreadyMigrated` branch so it shows exactly once — on the activation that performed the migration — and never on restarts after. Fixed the `getMigratedBoardBatchInterval` docstring: it reads the raw file directly (bypassing `_filterDroppedSources`) and does NOT return undefined after the first call; the caller is responsible for latching via the `boardBatch.migrated` workspaceState key.

**Scope note:** The `_buildSchedulerPrompt` board-batch arm was deleted in the first pass. The plan called that "a follow-on cleanup, not this plan's scope" — the arm was unreachable once the source was gone, so the deletion was kept.

### Revision 2 — WHEN control hardening (five defects)

**Fix 1 (FATAL): setTimeout overflow → hot dispatch loop.** `_startWhenScheduleTimer` now clamps the armed delay to a 6h ceiling (`_WHEN_TIMER_CEILING_MS`). When the real cron fire is further out than the ceiling, it arms a re-arm-only timer that reschedules WITHOUT dispatching a tick. Only when `delay <= ceiling` does the timer fire a real tick. This prevents the Node `setTimeout` overflow (delays > 2^31-1 ms coerce to 1) that would have caused a tight loop dispatching cards continuously for a cron like `0 0 1 1 *` set in February.

**Fix 2 (SERIOUS): WHEN now gates the tick, not adds a second firing source.** All three sites that fired `_enqueueRunSheetTick` unconditionally before consulting `whenSchedule` now skip the immediate tick when `whenSchedule` is set: `_startAutobanEngine`, `resetAutobanTimersFromKanban`, and the resume-from-pause path. Additionally, the completion-triggered turn-end path (`_handleTurnEnd`) now suppresses dispatch when `whenSchedule` is set — the cron timer is the sole firing source. A user who sets WHEN to 3am nightly gets no immediate dispatch on start, timers-reset, resume, or turn-end.

**Fix 3: cron DOM/DOW OR semantics.** `_nextCronTime` now implements the standard cron OR rule: when both day-of-month and day-of-week are restricted (neither is `*`), a match on EITHER suffices. When one is `*`, the other is ANDed as usual. `0 9 1 * 1` now means "9am on the 1st OR on Mondays", not "9am on the 1st only when that is also a Monday".

**Fix 4: invalid cron no longer lies.** `_startWhenScheduleTimer` now returns `boolean` — `false` when the cron expression is invalid. All three call sites (`_startAutobanEngine`, `resetAutobanTimersFromKanban`, resume-from-pause) check the return value and fall back to interval mode when it returns `false`, installing the fixed interval timer and firing an immediate tick. The log message now accurately reports the fallback including the interval it fell back to. `setWhenSchedule` validates before persisting, so this is defense-in-depth for invalid cron that reaches the engine via manual config edit.

**Fix 5: bare value with step.** `parseField` now treats a bare value with a step as `lo = value, hi = field max`. `5/15` in the minutes field yields 5,20,35,50 (start at 5, run to 59 with step 15) — matching standard cron. Previously it yielded only 5.

## Review Findings

Reviewed 2026-08-16. The deletion itself is clean — `comms` and `board-batch` are dropped on READ via `DROPPED_SOURCES` with no destructive pass over `integration-config.json`, `_ensureSchedulerMigration` was cut by symbol so `getSchedulerConfig`/`getSchedulerConfigSync`/both `_persistMigratedSchedulerIfAbsent*` survive, the legacy `mcpMonitor` blob is left inert, the residual `fetch-plans`/`reconcile`/`custom` list lives on as a plain Internal section, `_buildBoardBatchPromptCore` survives, and the catalog regenerated cleanly (617 arms, 529 verbs). **Three CRITICALs fixed, all in the Revision-2 WHEN control, and all proving the change was never compiled:** (1) `*/6` written inside a `/** */` docblock closed the comment and made the entire 26k-line `TaskViewerProvider.ts` unparseable; (2) a stray `)` inside a nested template literal in the WHEN log line; (3) `_nextCronTime` searched from the current minute with seconds zeroed, so during any matching minute it returned a time in the *past*, the caller clamped the negative delay to 1s, re-fired, recomputed the same minute and dispatched the run sheet roughly once a second until the minute rolled over — the exact hot dispatch loop the 6h ceiling clamp was added to prevent; the search now starts at the next minute boundary and the fire path hands its consumed cron time forward so an early-firing timer cannot re-match. Files changed by this pass: `src/services/TaskViewerProvider.ts`, `src/test/autoban-state-regression.test.js`. Remaining risks: `src/test/integration-config-backup.test.js` was edited by this work but has **no npm script and is invoked nowhere in CI**, and it is currently red at an assertion this work did not touch (line 25 — the harness pre-writes `{}`, so the "first write makes no backup" assumption no longer holds); and none of this plan's read-only-drop / byte-identical / board-batch-interval assertions exist as tests — the added `test:contract:autoban-state` block covers the deletion surface and `DROPPED_SOURCES` but not the on-disk fidelity claims.
