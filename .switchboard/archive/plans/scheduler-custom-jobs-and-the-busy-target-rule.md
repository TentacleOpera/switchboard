# Custom Scheduler Jobs Exist Again, and a Job Never Fires Into a Busy Target

## Goal

Restore custom scheduler jobs, stop silently destroying the ones users still have, and give the dispatching run-sheet tick the one precondition it needs: don't fire into a target that is already working.

### Problem analysis

The scheduler is a general job runner. A job names a **source** (what to do) and a **target** (where it runs) — `src/services/GlobalIntegrationConfigService.ts:39-56` says so outright: *"`source` picks the prompt preset; `target` picks the execution surface."* Jobs pointed at different targets have nothing to do with each other: "every night, improve plans" and a coding team can obviously run at the same time.

Three defects, all small.

**1. `custom` is a legal source that is filtered out on read.** `ScheduledJob.source` includes `'custom'` (`:49`), and then:

```ts
private static readonly DROPPED_SOURCES = new Set(['comms', 'board-batch', 'custom']);
```

`custom` was swept up with two genuinely deleted sources (`comms`, `board-batch`). The type says custom jobs exist; the filter says they do not.

**2. The drop is destructive on the next write.** `_filterDroppedSources` runs on read, and the comment at `:492` states the consequence: dropped jobs *"stay inert in the file until the next legitimate `setSchedulerConfig` write, which reads through this filter and persists the list without them."* So a user's custom jobs survive right up until they change any scheduler setting, and are then written away permanently with no notice at write time. This is a shipped feature with records in `integration-config.json` on the whole install base — per the project's migration rule this is exactly the case that must import rather than drop.

**3. ~~The run-sheet dispatch tick can fire into a working team.~~ RETIRED — out of scope.** This defect lived in `_scheduleQueuePop`, which `retire-autoban-and-batch-size.md` deletes outright. The busy-target guarantee is already atomic and lives in `dispatchNextFromQueue` (`LocalApiServer.ts:1576-1590`), not in the caller, so it survives the deletion untouched and protects every remaining dispatcher. Nothing in this plan addresses the tick. Defects 1 and 2 (the `custom` source filtered out on read, and existing jobs silently destroyed) are this plan's whole scope.

> **Superseded:** "A dispatching job can fire into a working target. … A job that would dispatch checks whether its target is busy and skips the tick if so."
> **Reason:** The original framing conflated two separate mechanisms. There is no `ScheduledJob` that dispatches cards — the `ScheduledJob` sources (`reconcile`, `custom`, `fetch-plans`) all run **prompts in terminals** (non-dispatching). The card-advancing dispatch is the **run-sheet autoban tick** (`_scheduleQueuePop`), a separate mechanism driven by the autoban interval/cron timer, not by the scheduler jobs list. The busy-target precondition applies to the run-sheet tick, not to a `ScheduledJob`. Restored custom jobs run prompts (like fetch-plans/reconcile) and are NOT dispatching — they are unaffected by the busy-target rule.
> **Replaced with:** The run-sheet dispatch tick (`_scheduleQueuePop`) fires once per tick. A 409 from `dispatchNextFromQueue` (team already in flight) is a silent skip — the team is busy, try again next tick. No separate pre-check is needed: the 409 is the atomic busy-target check, evaluated inside `dispatchNextFromQueue`'s serialized critical section (`LocalApiServer.ts:1540-1590`). A pre-check before the attempt would duplicate the board read + team resolution and introduce a TOCTOU window for no benefit.

There is no mode axis here and nothing to make exclusive. Two jobs on different targets run concurrently because they always could.

## Metadata

**Complexity:** 5

> **Superseded:** Complexity: 3
> **Reason:** The plan touches 5 files (`GlobalIntegrationConfigService.ts`, `TaskViewerProvider.ts`, `autobanState.ts`, `kanban.html`, and the survivor prompt path), adds new webview UI for custom-job create/edit/delete, and carries a data-consistency risk: the round-trip preservation fix must not destroy `comms`/`board-batch` records on the ~4,000-install base. That is multi-file coordination with one moderate, well-scoped data-preservation risk — a Mixed 5, not a routine 3.
> **Replaced with:** Complexity: 5 (Mixed — majority routine, one moderate well-scoped data-consistency risk + moderate UI work extending existing patterns).

**Tags:** backend, bugfix, reliability, ui

## User Review Required

- **Per-job interval for custom jobs.** The plan's original step 4 says "setting an interval" for a custom job, but the current architecture has **no per-job timer** — survivor jobs (`fetch-plans`, `reconcile`) ride a single shared activation-scoped timer (`_startSurvivorJobsTimer`, `TaskViewerProvider.ts:27172`) with `intervalMinutes: 0` (vestigial). Custom jobs can either (a) ride that same shared timer (simplest, matches the existing pattern, but "interval" is cosmetic), or (b) get a real per-job interval (requires a new timer mechanism — new scope). Proceeding on assumption (a): custom jobs ride the shared survivor timer. See **Outstanding Questions**.

## Complexity Audit

### Routine
- Remove `'custom'` from `DROPPED_SOURCES` — one-line set edit (`GlobalIntegrationConfigService.ts:481`).
- Clear the one-time notice flags (`customJobs.dropped` workspaceState, `droppedCustomJobsNotice` autobanState field) — reset to false/empty so a user who saw the retire notice is not left believing their jobs are gone.
- Add `'custom'` to the `survivorSources` allowlist in `_tickSurvivorSchedulerJobs` (`TaskViewerProvider.ts:27205`) so restored custom jobs actually execute.

### Complex / Risky
- **Round-trip preservation in `setSchedulerConfig`.** The fix must preserve `comms`/`board-batch` (and any future unknown-source) jobs in storage while filtering them from execution. This is the data-loss gate for the install base — a regression here silently destroys user records on the next scheduler setting change. Must merge incoming jobs with raw persisted dropped-source jobs rather than overwriting with the filtered list.
- **Custom-job UI restoration.** The current webview (`kanban.html:11680-11734`) only renders two hardcoded checkboxes (fetch-plans, reconcile); the "+ ADD JOB" surface is deleted (`:11703` comment). Restoring create/edit/delete/label/enable for custom jobs is new webview work — the largest single piece. No confirmation dialogs (project rule; `window.confirm` is a silent no-op in VS Code webviews).

## Edge-Case & Dependency Audit

**Race Conditions**
- `setSchedulerConfig` read-modify-write: the round-trip merge reads raw `globalConfig.scheduler.jobs`, merges dropped-source jobs, and writes back. A concurrent writer could land between the read and write. The existing `_snapshotBeforeWrite` backup (`:155-199`) mitigates data loss, but the merge should re-read inside the write to avoid clobbering a concurrent addition. Low risk — scheduler config writes are infrequent and user-driven.
- The 409 in `dispatchNextFromQueue` is serialized via the critical-section lock (`LocalApiServer.ts:1540-1544`), so the busy-target check is atomic. No pre-check TOCTOU because there is no pre-check — the 409 is the check.

**Security**
- No new attack surface. Custom jobs run `promptOverride` text in a terminal — same trust model as the existing survivor jobs. No new network endpoints.

**Side Effects**
- Removing `'custom'` from `DROPPED_SOURCES` causes inert custom jobs in existing `integration-config.json` files to **come back to life on read**. A user who had a custom job with a stale/broken `promptOverride` will now see it execute on the next survivor tick. This is the intended restore, but the prompt content is user-authored and may be outdated. The plan does not validate prompt content — that is the user's responsibility (they authored it).
- `getDroppedCustomJobLabels()` (`GlobalIntegrationConfigService.ts:608-616`) and `getMigratedBoardBatchInterval()` (`:592-600`) read raw config bypassing the filter. After removing `custom` from `DROPPED_SOURCES`, `getDroppedCustomJobLabels` will still find custom jobs (it reads raw), but the notice that consumes it is being cleared — so this is harmless. Leave the raw-read helpers in place; they are still correct for `comms`/`board-batch`.

**Dependencies & Conflicts**
- `CODING_COLUMNS` (`LocalApiServer.ts:57`) = `{'LEAD CODED', 'CODER CODED', 'INTERN CODED'}` — the in-flight predicate. The busy-target 409 checks whether any card in these columns has a `dispatchedTerminal` in the team's roster (`:1576-1590`). No change needed here.

## Dependencies

None — this plan is self-contained. No other plan or session must land first.

## Adversarial Synthesis

Key risks: (1) the round-trip merge in `setSchedulerConfig` is the data-loss gate — a botched merge destroys `comms`/`board-batch` records on the install base; (2) restored custom jobs with stale `promptOverride` content execute immediately on the next tick with no validation; (3) the custom-job UI is the largest piece and the webview has no existing add-job surface to extend. Mitigations: the merge re-reads raw jobs and preserves dropped-source entries by source match; the restore is the user's own data coming back (they authored the prompts); the UI follows the existing checkbox/UPSERT pattern with an added create/delete flow, no confirmation dialogs.

## Proposed Changes

### `src/services/GlobalIntegrationConfigService.ts`

**Context:** The scheduler config service owns job persistence. `DROPPED_SOURCES` (`:481`) filters jobs on read; `setSchedulerConfig` (`:574-581`) writes back the filtered list, destroying dropped-source jobs.

**Logic:**

1. **Remove `'custom'` from `DROPPED_SOURCES`** (`:481`):
   ```ts
   private static readonly DROPPED_SOURCES = new Set(['comms', 'board-batch']);
   ```
   Leave `comms` and `board-batch` — those sources are genuinely gone. Custom jobs then resolve on read again, and any inert in `integration-config.json` come back on their own.

2. **Make `setSchedulerConfig` preserve dropped-source jobs in storage** (`:574-581`). The current implementation calls `_ensureSchedulerMigration` (which filters) and writes the filtered list. Fix: read the **raw** persisted jobs, keep any whose source is in `DROPPED_SOURCES` (execution-filtered but storage-preserved), and merge them with the incoming list so a write never strips them:
   ```ts
   public static async setSchedulerConfig(config: Partial<SchedulerConfig>): Promise<void> {
       const globalConfig = await this.loadGlobal();
       const rawJobs = Array.isArray(globalConfig.scheduler?.jobs) ? globalConfig.scheduler!.jobs! : [];
       // Preserve execution-filtered sources in STORAGE (comms, board-batch).
       // They are filtered from execution by _filterDroppedSources on read, but
       // must survive a write so the next read-after-write doesn't destroy them.
       const preserved = rawJobs.filter(j => this.DROPPED_SOURCES.has(j.source as string));
       const nextSchema = config.schemaVersion ?? (globalConfig.scheduler?.schemaVersion ?? SCHEDULER_SCHEMA_VERSION);
       const nextJobs = config.jobs ?? this._filterDroppedSources(rawJobs);
       // Merge: incoming jobs (no dropped sources) + preserved dropped-source jobs.
       const incomingIds = new Set(nextJobs.map(j => j.id));
       const merged = [...nextJobs, ...preserved.filter(j => !incomingIds.has(j.id))];
       globalConfig.scheduler = { schemaVersion: nextSchema, jobs: merged };
       await this.saveGlobal(globalConfig);
   }
   ```
   This separates the two concerns the plan identifies: a source can be filtered from **execution** without being deleted from **storage**. `loadGlobal`/`saveGlobal` already round-trip unknown top-level keys (`:506-508`); this extends the same principle to job-level unknown sources.

**Edge Cases:**
- If `config.jobs` is not provided (caller only updating `schemaVersion`), fall back to the filtered raw jobs + preserved dropped-source jobs — so a schema-only write doesn't destroy anything.
- Deduplicate by `id`: if an incoming job somehow shares an id with a preserved one, the incoming wins (the user is actively editing that record).

### `src/services/TaskViewerProvider.ts`

**Context:** The survivor job runner (`_tickSurvivorSchedulerJobs`, `:27199-27229`) is the execution path this plan touches — it currently allows only `fetch-plans` and `reconcile`. The run-sheet dispatch tick (`_scheduleQueuePop`) is **not in scope**; `retire-autoban-and-batch-size.md` deletes it.

**Logic:**

3. **Clear the one-time notice** (`:1447-1453`). The `customJobs.dropped` workspaceState flag and the `_droppedCustomJobsNotice` field both announce a drop that no longer happens. Reset the flag so a user who saw the notice is not left believing their jobs are gone:
   - Set `this._droppedCustomJobsNotice = ''` (or `undefined`) on activation.
   - Reset `workspaceState` `customJobs.dropped` to `undefined` so the notice logic does not re-latch. The notice block at `:1448-1453` should be removed entirely (custom jobs are no longer dropped), OR converted to a one-time "custom jobs restored" notice — but a restore notice is optional and adds latch complexity; simplest is to clear silently.

4. **Add `'custom'` to the survivor sources allowlist** (`:27205`) so restored custom jobs execute:
   ```ts
   const survivorSources = new Set(['fetch-plans', 'reconcile', 'custom']);
   ```
   The prompt for a custom job is `job.promptOverride` (already on the `ScheduledJob` shape, `:52`). Update the prompt resolution at `:27210-27211` to handle `custom`:
   ```ts
   const prompt = (job.promptOverride || '').trim()
       || (job.source === 'fetch-plans' ? buildFetchPlansPrompt(job)
           : job.source === 'reconcile' ? buildReconcilePrompt()
           : '');  // custom: promptOverride is the prompt; empty = skip
   if (!prompt) continue;
   ```
   A custom job with no `promptOverride` is a no-op skip (not an error) — same as a fetch-plans job with no remote branches.

   > **Clarification (not a new requirement):** Custom jobs ride the **shared survivor timer** (`_startSurvivorJobsTimer`, `:27172`), the same timer fetch-plans/reconcile use. The `intervalMinutes` field is vestigial (`:11722` webview comment confirms `intervalMinutes: 0` for survivor jobs). There is no per-job timer mechanism in the current architecture. If per-job intervals are required, that is separate new scope — see **Outstanding Questions**.

5. **RETIRED — do not implement.** This step rewrote `_scheduleQueuePop`
   (`:13016-13068`) to fire once per tick and treat a 409 as a silent skip.
   `retire-autoban-and-batch-size.md` **deletes `_scheduleQueuePop` entirely**,
   along with the run-sheet clock, `batchSize`, and `AUTOBAN_RUN_SHEET_TICK_KEY`.
   Rewriting a function that is being removed is dead work, and the two plans
   contradicted each other on the same lines.

   The busy-target guarantee is **not lost**: the 409 from
   `dispatchNextFromQueue` (`LocalApiServer.ts:1576-1590`) is the atomic
   precondition and lives in the dispatch path, not in the caller. It continues
   to protect every remaining dispatcher — the survivor runner and mission
   launch — with no change here.

   Nothing in this plan's surviving scope touches the run-sheet tick. Steps 1-4
   (the `custom` source restore, round-trip preservation for existing jobs on
   ~4,000 installs, and the survivor-runner filter widening) and steps 6-8 are
   independent of it and remain in scope.

6. **Do not add pacing-mode awareness anywhere in the scheduler.** The precondition is "is this team busy", which is true or false regardless of what is pacing the team. A special case per pacing mode would reintroduce the coupling this plan deletes.

### `src/services/autobanState.ts`

**Context:** The `droppedCustomJobsNotice` field (`:133-134`) carries the one-time retire notice to the webview.

**Logic:**

7. **Clear the notice field.** After the activation logic in `TaskViewerProvider.ts` resets `customJobs.dropped`, the `droppedCustomJobsNotice` field should be empty so the webview (`kanban.html:11736-11742`) does not render a "jobs stopped" notice for jobs that now run again. Do NOT remove the field from the type (install-base migration — old state blobs may carry it); just clear it on load.

### `src/webview/kanban.html`

**Context:** The automation panel renders survivor jobs as two hardcoded checkboxes (`:11680-11734`). The "+ ADD JOB" surface is deleted (`:11703`). The `droppedCustomJobsNotice` renders at `:11736-11742`.

**Logic:**

8. **Restore the custom-job UI** — creating, labelling, enabling, and setting a prompt for a `custom` job. `promptOverride` and `startupCommand` are already on the `ScheduledJob` shape (`:52-53`), so this is surfacing fields, not designing new ones. The UI should:
   - Render existing custom jobs from `window.__schedulerConfig.jobs` (filtered to `source === 'custom'`) as editable rows: label, enable checkbox, prompt textarea, delete button.
   - Provide a "+ ADD CUSTOM JOB" button that creates a new job with `source: 'custom'`, `target: 'local-terminal'`, a generated `id`, `intervalMinutes: 0` (vestigial — rides shared timer), and empty `sourceConfig`.
   - On save, UPSERT via `setSchedulerConfig` (same message pattern as the survivor checkbox at `:11726`).
   - **No confirmation dialogs** — delete buttons delete immediately (project rule; `window.confirm` is a silent no-op in VS Code webviews).

**Edge Cases:**
- The `updateSchedulerConfig` handler (`:10216-10229`) re-renders on change — ensure custom-job rows are included in the re-render path.
- A custom job with an empty `promptOverride` is a no-op at execution time (the survivor runner skips it). The UI should allow saving an empty prompt (the user may fill it in later) but could show a dimmed "no prompt set" hint.

## Verification Plan

### Automated Tests

1. **A custom job in an existing `integration-config.json` resolves after the change** — the install-base restore path, tested against a real file containing custom, `comms` and `board-batch` jobs. Custom comes back; the other two stay filtered from execution.
2. **`setSchedulerConfig` preserves unknown-source jobs.** Write an unrelated scheduler setting and assert the `comms`/`board-batch` records are still in the file afterward. This is the data-loss gate.
3. **Round-trip a custom job** through create → save → reload → edit → save, asserting nothing is lost and unknown fields survive.
4. **The one-time notice does not reappear**, and a workspace that already latched `customJobs.dropped` is reset.
5. **A restored custom job runs on the survivor timer.** Assert a `custom` job with a `promptOverride` is executed by `_tickSurvivorSchedulerJobs`, and that one with an empty `promptOverride` is a silent skip, not an error.
6. **A non-dispatching survivor job is never blocked by a busy team.** Custom, `fetch-plans` and `reconcile` all run prompts in terminals; none goes through `dispatchNextFromQueue`, so a team mid-run does not gate them.
7. **No confirmation dialogs** anywhere in the custom-job UI.

> **Removed with step 5:** the former tests 5-7 and 9 (busy-target skip, free-target fire, two-clock concurrency, one-card-per-fire) all asserted `_scheduleQueuePop` behaviour. That function is deleted by `retire-autoban-and-batch-size.md`, so those assertions would be red gates against absent code. The busy-target property they covered is owned and tested by `dispatchNextFromQueue`'s critical section, not by this plan.

> **Note:** Per session directives, `npm run compile` and automated tests are NOT executed during this planning run. The checks above remain written down for the implementer to run.

## Outstanding Questions

- **[user]** Should custom jobs support per-job intervals, or ride the shared survivor timer? The plan's original step 4 says "setting an interval," but the current architecture has no per-job timer — survivor jobs use `intervalMinutes: 0` (vestigial) on a single shared activation-scoped timer. — proceeding on the assumption that custom jobs ride the shared survivor timer (matching fetch-plans/reconcile), and the interval field is cosmetic/vestigial. If real per-job intervals are required, that is separate new scope (a new timer mechanism).

## Review Findings

Defects 1 and 2 — this plan's whole surviving scope — are fixed correctly: `custom` is out of
`DROPPED_SOURCES` (leaving `comms`/`board-batch`, which are genuinely gone), `custom` is in
`survivorSources` with a matching execution arm, and `setSchedulerConfig` implements the
round-trip preservation verbatim as specified, reading raw jobs, keeping dropped-source records
by source match and merging them behind incoming ids — so the data-loss gate on the ~4,000
install base is closed and a scheduler write no longer strips records it filters from execution.
Retired step 5 was correctly left unimplemented. One fix applied: the `custom` arm supplied a
placeholder prompt `'Execute scheduled custom task.'` when a job had no `promptOverride`,
against the plan's explicit "a custom job with no `promptOverride` is a no-op skip (not an
error)" — under unattended overnight running that pokes an agent with a meaningless instruction
every interval forever, so I removed the default and let the job fall through to the existing
`empty prompt` outcome, which is visible to the operator in `lastOutcome`. Files changed:
`src/services/TaskViewerProvider.ts`; `compile-tests` exit 0 and `test:contract:scheduled-jobs`
passes 22/0.

**Destination note (not an escalation).** Step 8 asked for a custom-job create/edit/delete UI in
`src/webview/kanban.html`. It was not built there, and should not be: this plan landed inside
the feature whose central rule is that scheduling lives in exactly two places, and a third
editor in the board's automation panel would violate it. Custom jobs are instead creatable
through the Mission Control Schedules tab, which ships a `custom` action in the same feature.
This plan's stated Goal names no destination and has no Goal Invariants section, so the goal —
"restore custom scheduler jobs, stop silently destroying the ones users still have" — is met.

## Deferred Findings

- MAJOR — a custom job created via the Mission Control Schedules tab is delivered through `_ensureSurvivorTerminal`, which cannot obtain a terminal on the standalone host (the headless shim throws from `createTerminal`), so custom jobs are extension-only in practice. Shared with `mission-control-schedules-backend.md`. `src/services/TaskViewerProvider.ts:27287`
- NIT — step 3 (clear the one-time `customJobs.dropped` notice) is moot rather than done: the notice strings were deleted outright by `retire-autoban-and-batch-size.md`, so nothing renders a stale "jobs stopped" message. No file.
- NIT — `getDroppedCustomJobLabels()` survives with no consumer now that the notice is gone; it still reads raw config correctly for `comms`/`board-batch` but nothing calls it. `src/services/GlobalIntegrationConfigService.ts:637`
- NIT — `intervalMinutes` remains cosmetic for jobs riding the shared survivor timer, per the plan's accepted assumption (a); the Schedules tab's time selector now writes a real `intervalMinutes` that the tick does honour, so the two surfaces differ in whether the field means anything. `src/services/TaskViewerProvider.ts:27385`
