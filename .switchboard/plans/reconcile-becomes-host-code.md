# Replace Reconcile with Remote Plan Import

## Goal

Replace the `reconcile` scheduled job with an `import-remote-plans` job that, on
a set schedule (e.g. once a day), ensures recently pulled work is properly
reflected in kanban card positions. The job diffs the plan directory between the
last processed HEAD and the current HEAD, imports new plan files, and moves
cards to **Coded** — reflecting work done by an external agent (Claude Cloud, a
remote VM, another developer) that pushed code and plan-file updates but was
never dispatched through Switchboard.

### The use case

1. A plan sits in **Plan Reviewed**.
2. You send it to an external agent outside Switchboard — no dispatch, no standing
   orders, no `POST /kanban/queue/done`. It's just an external thing coding a plan.
3. That agent codes the plan, updates the plan file, and pushes to a branch.
4. You pull (or the external agent's CI merges to your branch and you pull).
5. On the next scheduled sweep, the job diffs the plan directory between the last
   processed HEAD and the current HEAD, sees the plan file changed, and moves the
   card to **Coded** via the move endpoint — a plain column move, no dispatch.
   The board now reflects reality.

The external agent is not part of Switchboard. It has no completion directive, no
API port, no standing orders. The only signal it leaves is the git push — code
changes and a plan-file update. **The job never pulls.** Pulling is the
operator's decision. The job is a scheduled reconcile step that ensures whatever
the operator has already brought into the working tree is properly reflected on
the board.

### What's wrong with the current reconcile

The current `reconcile` job (`buildReconcilePrompt` in `schedulerPresets.ts:79`)
scans for new `## Completion Report` or `## Review Findings` sections in plan
files. This is wrong for the use case:

- **The external agent was never told to write those headings.** It has no
  `CODING_COMPLETION_REPORT_DIRECTIVE`. It may write `## Completion Report`, or
  `## Summary`, or nothing with a heading, or just edit the plan file. The
  detection mechanism depends on a convention the external agent doesn't know about.
- **"New since the last reconcile pass" is undefined state.** The prompt offers two
  ways to scope it and records neither. The agent re-derives the boundary every run,
  so the same update can be processed twice.
- **`git pull --all || true` merges into the operator's working tree on a schedule.**
  An unattended job should never move the branch the operator is sitting on. The
  `|| true` swallows pull failures (merge conflicts, no remote, dirty tree) — the
  agent proceeds against a stale HEAD, finds nothing, and reports "nothing to do"
  while the board stays wrong. The fix is to remove pulling entirely: the job
  reconciles what the operator has already pulled.
- **"Determine the correct next column from the workspace pipeline" is vague.** The
  target is always Coded — the work was done externally, the card should reflect
  that. There is no pipeline inference needed.

The root cause is inheritance: the prompt text was carried forward from a retired
scheduler surface and never reconsidered against the actual use case.

A second root cause, deeper than the prompt text: the entire **prompt-based
execution model** is wrong for this job. The current `reconcile` and `fetch-plans`
jobs build a text prompt and send it to a terminal agent (an LLM) via
`sendRobustText`. The host has no output-capture mechanism — `sendRobustText` is
fire-and-forget, and `runSchedulerJob` records only `lastRunAt` / `lastOutcome` /
`lastTarget`. The work this job does (git diff, import files, move cards, persist
a watermark SHA) is purely mechanical and deterministic. Using an LLM for it is
fragile (the agent may hallucinate, skip steps, or move the wrong card),
expensive (consumes agent turns for mechanical work), and broken in the standalone
host (where `vscode.window.createTerminal` throws — see Scope section below).

## Metadata
- **Complexity:** 6
- **Tags:** backend, reliability, refactor

## User Review Required

This plan makes an **architectural correction** from the original approach. The
original plan proposed a prompt-based replacement (`buildImportRemotePlansPrompt`)
that would keep the LLM-in-a-terminal execution model. This plan instead converts
the job to **host code** — deterministic execution via `child_process` and direct
`KanbanProvider` calls, no terminal, no LLM, no prompt. The reasons are:

1. `sourceConfig.lastImportedSha` persistence is impossible in the prompt-based
   model (the host cannot capture agent output to extract the new SHA, and no API
   endpoint exists for an agent to write back to config).
2. The standalone host's `vscode.window.createTerminal` throws, so the prompt-based
   model is broken there.
3. The work is mechanical — no reasoning needed.
4. The job never pulls — it only reads HEAD and diffs against the watermark. An
   LLM is not needed for a git diff and a card move.

**Reviewers should confirm** that converting from prompt-based to host-code
execution is acceptable, as it introduces a new execution path in `runSchedulerJob`
(a branch that runs code directly instead of building a prompt and sending it to a
terminal).

## Migration: load-time source rename

> **Superseded:** "Clean break. No migration. The job keeps its stored config
> (interval, enabled, etc.) but the `source` changes from `reconcile` to
> `import-remote-plans`. Existing schedules with `source: 'reconcile'` are updated
> to `source: 'import-remote-plans'` on load — a one-line rename in the config
> reader, not a migration. No persisted user data is at risk; the job's
> `lastRunAt` / `lastOutcome` carry forward unchanged."
>
> **Reason:** Calling it "no migration" while describing a load-time rename is
> self-contradictory. The `reconcile` and `fetch-plans` sources are in the
> published `ScheduledJob` type (`GlobalIntegrationConfigService.ts:49`), so they
> shipped — users may have jobs with these sources. Per CLAUDE.md: "When unsure
> whether something shipped, assume it did and migrate." The load-time rename IS
> the migration, and it is the correct approach. Calling it "no migration"
> understates the change and could lead a future reader to skip the rename.
>
> **Replaced with:** A load-time source rename migration in
> `_ensureSchedulerMigration` (or a new rename step before `_filterDroppedSources`)
> that rewrites `source: 'reconcile'` and `source: 'fetch-plans'` to
> `source: 'import-remote-plans'` on read. The job's `lastRunAt` / `lastOutcome` /
> `lastTarget` carry forward unchanged. The rename is non-destructive: it mutates
> the in-memory config object on read, and the next legitimate
> `setSchedulerConfig` write persists it. This is a migration, not a clean break.

## Scope: both composition roots

> **Superseded:** "The survivor scheduler jobs (`fetch-plans`, `reconcile`,
> `team-automation`) are wired in `TaskViewerProvider` (extension) only. The
> standalone host (`bootstrap.ts`) has none of them — a pre-existing divergence.
> This plan wires `import-remote-plans` in both roots in one diff, per CLAUDE.md's
> no-divergence rule."
>
> **Reason:** The divergence claim is imprecise. `restoreAutobanOnStartup()` IS
> called in standalone (`bootstrap.ts:3180`), which calls `_tryRestoreAutoban()`,
> which calls `_startSurvivorJobsTimer()` (`TaskViewerProvider.ts:11656`). So the
> survivor jobs timer IS armed in standalone. But `_ensureSurvivorTerminal` calls
> `vscode.window.createTerminal`, which **throws** in the standalone shim
> (`vscodeShim.ts:184-186`: "vscode.window.createTerminal is not available in the
> headless standalone host"). Every tick fails with "terminal creation failed"
> before any prompt is sent. The jobs are armed but inert.
>
> **Replaced with:** The host-code execution path needs no terminal — it runs a
> git diff via `child_process` and moves cards via `KanbanProvider` directly. The
> timer already fires in both roots; the host-code branch in `runSchedulerJob`
> works identically in both. No additional wiring is needed in `bootstrap.ts` —
> the existing `restoreAutobanOnStartup()` call already arms the timer. This is
> the key advantage of host-code over prompt-based: it fixes the standalone
> divergence as a natural consequence of eliminating the terminal dependency.

The `fetch-plans` job is subsumed: `import-remote-plans` imports new plan files
(what `fetch-plans` does) **and** detects updates to existing plan files (what
`reconcile` was trying to do). `fetch-plans` is deleted; `buildFetchPlansPrompt`
is deleted with it.

## Complexity Audit

### Routine
- Deleting `buildReconcilePrompt` and `buildFetchPlansPrompt` from `schedulerPresets.ts` — straightforward removal of dead code after the host-code path lands.
- Updating the `survivorSources` set in `_tickSurvivorSchedulerJobs` (`TaskViewerProvider.ts:28179`) — swap `'fetch-plans'` and `'reconcile'` for `'import-remote-plans'`.
- Updating the `ScheduledJob.source` type union in `GlobalIntegrationConfigService.ts:49` — remove `'reconcile'` and `'fetch-plans'`, add `'import-remote-plans'`.
- Removing the `fetch-plans` / `reconcile` prompt branch in `runSchedulerJob` (`TaskViewerProvider.ts:28217-28234`).
- Config writeback for `lastImportedSha` — the `finally` block in `runSchedulerJob` (`TaskViewerProvider.ts:28241-28257`) already finds the job and writes fields; adding `sourceConfig.lastImportedSha` is one line alongside `lastRunAt` / `lastOutcome` / `lastTarget`.
- Calling `importPlanFiles(workspaceRoot)` — existing function from `PlanFileImporter.ts`, already used by ClickUp/Linear automation polling and inline plan creation.
- Calling `kanbanProvider.moveCardToColumnByPlanFile` — existing method (`KanbanProvider.ts:8777`), already used by the board's column-move path.

### Complex / Risky
- **New host-code execution path in `runSchedulerJob`.** This is the first survivor scheduler job that runs code directly instead of building a prompt and sending it to a terminal. The branch must handle git rev-parse/diff failures (detached HEAD, corrupt repo), DB lookups, column checks, and card moves — all without a terminal or LLM in the loop. New pattern in this codebase.
- **Git operations via `child_process`.** No git utility module exists in `src/` — git commands currently appear only in prompt text (`schedulerPresets.ts`) and the webview (`mission-control.js`). The host-code path must shell out to `git rev-parse` and `git diff --name-only` via `child_process.execSync` or `exec`, with proper error handling for non-zero exits. No `git pull` — the job never pulls.
- **Load-time source rename migration.** The existing `_filterDroppedSources` mechanism **drops** jobs with deleted sources. This plan needs to **rename** `reconcile` and `fetch-plans` to `import-remote-plans` instead — a new migration step that runs before the drop filter, rewrites the `source` field in-memory, and lets the next `setSchedulerConfig` write persist it.
- **"At or past Coded" column logic.** There is no single "Coded" column — there are three (`LEAD CODED` order 180, `CODER CODED` order 190, `INTERN CODED` order 200), plus a legacy `CODED` alias (normalizes to `LEAD CODED`). The host code must determine whether a card's current column is at or past Coded by checking the column's `order` against the minimum Coded order (180), or by checking the column `kind` (`'coded'`, `'reviewed'`, `'completed'`). Custom columns with arbitrary orders add complexity.
- **Target column ambiguity.** The plan says "the target column is always Coded" but does not specify which Coded variant. The host-code path must pick one. Recommendation: `LEAD CODED` (the default Coded, what the legacy `CODED` alias resolves to, and the highest-complexity default).

## Edge-Case & Dependency Audit

### Race Conditions
- **Concurrent `runSchedulerJob` for the same job.** Already guarded by `_schedulerInFlight` (`TaskViewerProvider.ts:28204-28206`). The host-code branch inherits this guard — no new race.
- **Operator commits between `git rev-parse HEAD` and `git diff`.** The job reads HEAD, then diffs. If the operator commits between the two reads, the diff may include the operator's own plan-file edits. This is benign — the operator's edits to plan files are their own work, and if they moved a card themselves the forward-only check skips it. The next run's watermark advances past the operator's commit.
- **Plan file changed between diff and card move.** The diff is computed at a point in time; a concurrent commit could change the file. This is benign — the card move is idempotent (skip if already at/past Coded), and the next run's diff will catch anything missed.

### Security
- **`child_process` git execution.** All git commands use the workspace root as `cwd` — no user input reaches the command line. The diff path is hardcoded to `.switchboard/plans/`. No shell injection surface.
- **No auth on `moveCardToColumnByPlanFile`.** This is an in-process call, not an HTTP request — no auth needed. The `POST /kanban/move` endpoint's auth check does not apply.

### Side Effects
- **Card moves trigger cascade side-effects.** `moveCardToColumnByPlanFile` inherits the feature→subtask cascade and the Linear/ClickUp sync fan-out. Moving a card to LEAD CODED will sync to external trackers if configured. This is the correct behavior — the board reflects external work, and the tracker should too.
- **`importPlanFiles` creates new plan records.** New plan files from the diff are imported into the DB with cards in CREATED. This is the same behavior as the old `fetch-plans` job.

### Dependencies & Conflicts
- **`importPlanFiles` from `PlanFileImporter.ts`.** Existing function, already used in 3+ places in `KanbanProvider`. No new dependency.
- **`KanbanProvider.moveCardToColumnByPlanFile`.** Existing method. No new dependency.
- **`KanbanDatabase.getPlanByPlanFile`.** Existing method. Used to look up plan records by file path and check current column.
- **`DEFAULT_KANBAN_COLUMNS` from `agentConfig.ts`.** Column definitions with `order` and `kind` fields. Used to determine "at or past Coded" logic.
- **`GlobalIntegrationConfigService.setSchedulerConfig`.** Existing method. Used to persist `sourceConfig.lastImportedSha` in the `finally` block.
- **No new npm dependencies.** `child_process` is a Node.js built-in.

## Dependencies
- None — this plan is self-contained. No other plan needs to land first.

## Adversarial Synthesis

Key risks: (1) the new host-code execution path is the first of its kind in
`runSchedulerJob` — a prompt-free branch that runs a git diff and moves cards
directly, with no LLM safety net; if the diff logic or column-check logic is
wrong, cards move incorrectly with no agent to catch it. (2) The load-time source
rename must handle both `reconcile` and `fetch-plans` (the implementation steps
originally named only `reconcile`). Mitigations: the `_schedulerInFlight` guard
prevents concurrent runs; the column check is forward-only (skip if at/past
Coded); git failures are caught and reported, not retried; the rename migration
is non-destructive (in-memory on read, persisted on next write). The job never
pulls — it only reads the current HEAD and diffs against the watermark, so there
is no risk of mutating the operator's working tree.

## Proposed Changes

### `src/services/schedulerPresets.ts`
- **Context:** This file holds the prompt builders for survivor scheduler jobs. `buildFetchPlansPrompt` (line 29) and `buildReconcilePrompt` (line 79) are the two being replaced. `buildTeamAutomationPrompt` (line 108) stays. `BOARD_DRIVING_CONTRACT` (line 18) stays — `buildTeamAutomationPrompt` still uses it.
- **Logic:** Delete `buildFetchPlansPrompt` and `buildReconcilePrompt`. Do NOT add `buildImportRemotePlansPrompt` — the replacement is host code, not a prompt. Update the module docstring (lines 1-10) to reflect that only `buildTeamAutomationPrompt` and `BOARD_DRIVING_CONTRACT` remain.
- **Implementation:** Remove the two function bodies and their docstrings. Remove the import of `buildFetchPlansPrompt` and `buildReconcilePrompt` from `TaskViewerProvider.ts:62` — keep `buildTeamAutomationPrompt`.
- **Edge Cases:** `BOARD_DRIVING_CONTRACT` is still imported by `KanbanProvider` (`KanbanProvider.BOARD_DRIVING_CONTRACT` aliases it). Do not delete the constant.

### `src/services/GlobalIntegrationConfigService.ts`
- **Context:** Defines the `ScheduledJob` type (line 45) with `source: 'reconcile' | 'custom' | 'fetch-plans' | 'team-automation'` (line 49). The `_filterDroppedSources` method (line 489) drops jobs with sources in `DROPPED_SOURCES` (`comms`, `board-batch`, `custom`). The `_ensureSchedulerMigration` method (line 502) calls `_filterDroppedSources` on read.
- **Logic:**
  1. Update the `source` union: remove `'reconcile'` and `'fetch-plans'`, add `'import-remote-plans'`. The union becomes `'import-remote-plans' | 'team-automation'` (`'custom'` is already in `DROPPED_SOURCES` and can be removed from the union or left as a dropped value — removing it is cleaner).
  2. Add a load-time source rename step in `_ensureSchedulerMigration` (or a new `_renameLegacySources` method called before `_filterDroppedSources`) that rewrites `source: 'reconcile'` → `source: 'import-remote-plans'` and `source: 'fetch-plans'` → `source: 'import-remote-plans'` on the in-memory jobs array. This runs on every read — idempotent, non-destructive. The next `setSchedulerConfig` write persists the renamed sources.
- **Implementation:** The rename step iterates `jobs`, and for each job with `source === 'reconcile' || source === 'fetch-plans'`, sets `source = 'import-remote-plans'`. It runs before `_filterDroppedSources` so renamed jobs are not dropped.
- **Edge Cases:** A job with `source: 'reconcile'` and a `promptOverride` — the override carries forward unchanged. The host-code path ignores `promptOverride` (no prompt is built), but the field stays in the type for `team-automation` jobs.

### `src/services/TaskViewerProvider.ts`
- **Context:** The survivor scheduler job infrastructure lives here. `_startSurvivorJobsTimer` (line 28154) arms a 60-second timer. `_tickSurvivorSchedulerJobs` (line 28177) filters to enabled jobs with surviving sources and calls `runSchedulerJob`. `runSchedulerJob` (line 28197) builds a prompt and sends it to a terminal via `_ensureSurvivorTerminal`. The `finally` block (line 28241) persists `lastRunAt` / `lastOutcome` / `lastTarget`.
- **Logic:**
  1. **Update `survivorSources`** (line 28179): change from `new Set(['fetch-plans', 'reconcile', 'team-automation'])` to `new Set(['import-remote-plans', 'team-automation'])`.
  2. **Add a host-code branch in `runSchedulerJob`** for `job.source === 'import-remote-plans'`. This branch runs BEFORE the prompt-based branches (which are being removed). It does NOT call `_ensureSurvivorTerminal` — no terminal is needed. The job never pulls — it only reads the current HEAD and diffs against the watermark. The branch:
     a. Resolves the workspace root via `this._resolveWorkspaceRoot()`. If null, outcome = "no workspace root".
     b. Reads `lastImportedSha` from `job.sourceConfig.lastImportedSha` (string or undefined).
     c. Runs `git rev-parse HEAD` via `child_process.execSync` in the workspace root to get the current HEAD SHA. On failure, outcome = "git rev-parse failed: <error>".
     d. If `lastImportedSha` is unset (first run): record the current HEAD as the baseline, outcome = "baseline established: <sha>", import nothing, move nothing. Skip to step g.
     e. If the current HEAD equals `lastImportedSha`, nothing has been pulled since the last run — outcome = "no new commits", skip to step g.
     f. Runs `git diff --name-only <lastImportedSha> <currentHead> -- .switchboard/plans/` via `child_process.execSync`. Parse the output into a list of changed plan file paths (relative to workspace root). For each changed file:
        - Look up the plan record via `db.getPlanByPlanFile(relPath, workspaceId)`. If not found, the file is new — collect it in a `newFiles` list.
        - If found, the file is updated — check the plan's current column. If the column is at or past Coded (column order >= 180, or column kind is `'coded'` / `'reviewed'` / `'completed'`), skip and record in `skippedCards`. Otherwise, call `kanbanProvider.moveCardToColumnByPlanFile(workspaceRoot, relPath, 'LEAD CODED')` and record in `movedCards`.
     g. If `newFiles` is non-empty, call `importPlanFiles(workspaceRoot)` once to import all new plan files into the DB. New cards go to CREATED (the default).
     h. Set `newSha` variable to the current HEAD SHA (or the current HEAD if first run). The `finally` block writes this to `targetJob.sourceConfig.lastImportedSha`.
     i. Set `outcome` to a parseable summary: `"imported=<N> moved=<N> skipped=<N> baseline=<sha|->"`.
  3. **Remove the `fetch-plans` / `reconcile` prompt branch** (lines 28217-28234). The `team-automation` branch (lines 28213-28216) stays. The `else` branch for unsupported sources (line 28235) stays.
  4. **Update the `finally` block** (lines 28241-28257): alongside `targetJob.lastRunAt`, `targetJob.lastOutcome`, `targetJob.lastTarget`, also set `targetJob.sourceConfig.lastImportedSha = newSha` (if `newSha` was set by the `import-remote-plans` branch). Use a branch-scoped variable (like `outcome` and `resolvedTarget`) that the finally block picks up.
  5. **Update the return value** (line 28259): the success check `outcome === 'sent'` is prompt-specific. For the host-code branch, success is determined by whether the outcome starts with a non-error prefix. Consider changing to `!outcome.startsWith('error') && !outcome.includes('failed')` or tracking a separate `success` boolean.
- **Implementation:** The host-code branch needs access to `this._kanbanProvider` (for `moveCardToColumnByPlanFile`) and `this._resolveWorkspaceRoot()`. Both are available in `TaskViewerProvider`. For `db.getPlanByPlanFile`, access `this._kanbanProvider._getKanbanDb(workspaceRoot)` and `db.getWorkspaceId()`. For `importPlanFiles`, import it from `PlanFileImporter` (already imported in `KanbanProvider` — add the import to `TaskViewerProvider` or call through `kanbanProvider`).
- **Edge Cases:**
  - **Detached HEAD:** `git rev-parse HEAD` still works. The diff runs against the detached HEAD. No special handling needed.
  - **Plan file deleted between watermark and HEAD:** `git diff --name-only` lists it (as deleted). `getPlanByPlanFile` returns null (or the record may still exist). Skip and report.
  - **Plan file renamed:** Shows as a delete + add in the diff. The old path's card is skipped (file not found), the new path is imported as a new plan. This is correct — a rename is a new plan from the board's perspective.
  - **Card moved backwards by a human:** The column check sees it behind Coded. The plan says skip — do not undo a deliberate human action. But this means a plan file update from an external agent is ignored if a human moved the card back. This is the correct behavior: the human has context the import job doesn't.
  - **Operator hasn't pulled since last run:** HEAD equals `lastImportedSha`. Outcome = "no new commits". No diff, no imports, no moves. This is the common case on a daily schedule — most runs are no-ops.

### `src/standalone/bootstrap.ts`
- **Context:** The standalone host calls `restoreAutobanOnStartup()` (line 3180), which arms the survivor jobs timer. No changes are needed to `bootstrap.ts` itself — the timer already fires, and the host-code branch in `runSchedulerJob` works without a terminal.
- **Logic:** No changes. The host-code path eliminates the terminal dependency that made survivor jobs inert in standalone. The existing `restoreAutobanOnStartup()` call is sufficient.
- **Verification:** Confirm the job runs successfully in standalone (no "terminal creation failed" outcome).

### `src/extension.ts`
- **Context:** The extension host calls `restoreAutobanOnStartup()` through the sidebar's `ready` handler (line 1198 references it). No changes needed — the timer is armed the same way.
- **Logic:** No changes. The host-code branch works identically in the extension host.

## Verification Plan

### Automated Tests
1. `npm run compile` clean.
2. **Idempotency:** run the job twice with no new commits between; confirm the
   second run imports nothing and moves nothing (HEAD equals watermark).
3. Pull a branch with a plan file update; run the job; confirm the matching card
   moves to LEAD CODED.
4. Run the job again immediately; confirm no double-move (HEAD equals watermark).
5. Manually advance a card to LEAD CODED, then pull a plan file update; run the
   job; confirm the card is skipped, not re-moved.
6. Manually move a card backwards to a pre-coding column, then pull a plan file
   update; run the job; confirm the card is skipped and reported.
7. Pull a new plan file (not previously imported); run the job; confirm it is
   imported and no card is moved (no card exists yet — the new card goes to CREATED).
8. First run with no watermark: confirm nothing moves and a baseline is recorded.
9. Confirm `lastOutcome` carries parseable counts, and the panel renders them.
10. Both hosts — confirm the job runs under standalone, not just the extension.
11. Confirm `fetch-plans` is deleted and existing `source: 'fetch-plans'` jobs are
    renamed to `import-remote-plans` on load.
12. Confirm `source: 'reconcile'` jobs are renamed to `import-remote-plans` on load.
13. Confirm `buildReconcilePrompt` and `buildFetchPlansPrompt` are absent from
    `schedulerPresets.ts`.
14. Confirm `buildTeamAutomationPrompt` and `BOARD_DRIVING_CONTRACT` are still
    present and `buildTeamAutomationPrompt` still works.
15. Confirm `team-automation` jobs are unaffected by the source rename migration.
16. Confirm the job never runs `git pull` — no pull command in the host-code branch.

### Goal Invariants
- Assert `buildReconcilePrompt` is absent from `src/services/schedulerPresets.ts`.
- Assert `buildFetchPlansPrompt` is absent from `src/services/schedulerPresets.ts`.
- Assert the string `'import-remote-plans'` is present in the `ScheduledJob` type's `source` union in `src/services/GlobalIntegrationConfigService.ts`.
- Assert the strings `'reconcile'` and `'fetch-plans'` are absent from the `ScheduledJob` type's `source` union in `src/services/GlobalIntegrationConfigService.ts`.
- Assert `runSchedulerJob` in `src/services/TaskViewerProvider.ts` has a branch matching `job.source === 'import-remote-plans'` that does NOT call `_ensureSurvivorTerminal`.
- Assert the `survivorSources` set in `_tickSurvivorSchedulerJobs` includes `'import-remote-plans'` and excludes `'reconcile'` and `'fetch-plans'`.
- Assert `_ensureSchedulerMigration` (or a method it calls) rewrites `source: 'reconcile'` and `source: 'fetch-plans'` to `source: 'import-remote-plans'` on read.
- Assert `buildTeamAutomationPrompt` is still present and exported from `src/services/schedulerPresets.ts`.
- Assert `BOARD_DRIVING_CONTRACT` is still present and exported from `src/services/schedulerPresets.ts`.
- Assert the string `git pull` is absent from the `import-remote-plans` branch of `runSchedulerJob` in `src/services/TaskViewerProvider.ts` (the job never pulls).
- Assert the `import-remote-plans` branch of `runSchedulerJob` calls `git rev-parse HEAD` and `git diff --name-only` (the job reads HEAD and diffs against the watermark).
