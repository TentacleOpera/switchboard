# The Plan Log Renders start/stop To Nobody

<!-- board-collapse-01 -->
> **RESCOPED 2026-09-04 (Board Collapse 01).** **Do not reserve a migration number.** This plan claims "~V65"; the schema is at **V67**. Use "the next free migration version at implementation time".


## Goal

`plan_events` is 8,565 rows and roughly 40% of a 7.3 MB `kanban.db`. Every one of those rows renders in the UI as `action=start` or `action=stop`, because the renderer branches on an event vocabulary that was never written. Nothing else can read the table: there is no HTTP endpoint, no skill references it, and the Mission Control skill instructs the opposite ("re-read the board and git from scratch and decide from that").

Retire the log overlay, narrow the event vocabulary to the one question the table has ever actually answered — *why did this card move?* — and retune retention to match. The table stays; the panel and the noise go.

> **Decided: Alternative C.** Keep the `start`/`stop` vocabulary; add `from_column`/`to_column`/`actor`/`reason` as real columns. Retire the overlay and retune retention as written.
>
> The original objection cited `PipelineOrchestrator.getNextStage()` (`PipelineOrchestrator.ts:25`) as the reader that vocabulary narrowing would break. **That class is being deleted** by `scheduling-lives-in-two-places-only.md` — no webview posts any of its five verbs, its run-sheet callback is never wired, and its state broadcast has no consumer. So that half of the objection expires and no "migrate PipelineOrchestrator first" plan is needed.
>
> **But a second reader survives, and it decides this.** `KanbanProvider.ts:7482`, inside `_advanceSessionsInColumn`, reads the last run-sheet event and returns early when it is `{ workflow, action: 'start' }` — the guard that stops a duplicate advance. Run sheets are hydrated from `plan_events` (`SessionActionLog.ts:443`: "merges plan_events + plans table metadata"), so this is a genuine `plan_events` reader on a live board-advance path, and nothing retires it. Stopping `start` writes would silently re-enable duplicate advances. Alternative C is therefore the approach, on the strength of that one reader alone.

### Root Cause Analysis

**Layer 1 — five of the renderer's six branches are unreachable.**

`formatReviewLogEntries` (`src/services/reviewLogUtils.ts:11-40`) selects its output by `event.action`, branching on `execute`, `delegate_task`, `submit_result`, `start_workflow` and `complete_workflow_phase`. Measured across the whole table, the only `action` values that exist are:

| `action` | rows | share |
|---|---|---|
| `stop` | 5,487 | 64.1% |
| `start` | 3,077 | 35.9% |
| *(empty)* | 1 | 0.0% |

None of the five branches can fire. **100% of events fall to the `else`**, which emits `action=start` / `action=stop`. Every line of the overlay reads the same two ways.

**Layer 2 — the readable output needs fields nothing writes, and the one useful field the renderer doesn't check for.**

The good output (`SENT TO Lead Coder`, `COMPLETED — Reviewer`) is gated on `event.targetColumn`, resolved through a column→role map. Across all 8,565 rows:

- payload containing `targetColumn`: **0**
- payload containing `role`: **0**
- payload containing `outcome`: 5,487

So the role map is dead by construction — no event ever carries `targetColumn` or `role`.

> **Superseded:** The original analysis stated that `getPlanEventsByPlanId` (`KanbanDatabase.ts:9769`) does `SELECT *` + `getAsObject()`, so `payload` arrives as an unparsed JSON string and `event.outcome` is `undefined` on every DB-sourced event — "two independent reasons the same information cannot be displayed."
> **Reason:** The overlay's call chain goes through `SessionActionLog.getRunSheet` → `_hydrateRunSheet` → `db.getRunSheetByPlanId` (`KanbanDatabase.ts:9852`), which calls `getPlanEventsByPlanId` and then does `JSON.parse(e.payload)` on every row (line 9858). The `payload` IS parsed before it reaches the renderer. `event.outcome` IS available after parsing. The real reason `outcome` doesn't produce useful output is that `formatReviewLogEntries` only checks `outcome === 'failed' || outcome === 'fail'` (line 24 of `reviewLogUtils.ts`), and the actual outcome values are strings like `"User manually moved plan forwards"` — not `"failed"`. There is one reason (the renderer doesn't check for the outcomes that actually exist), not two.
> **Replaced with:** The `outcome` field is available after `getRunSheetByPlanId`'s `JSON.parse`, but `formatReviewLogEntries` only branches on `outcome === 'failed' || outcome === 'fail'`. The actual outcome values (`"User manually moved plan forwards"`, etc.) match no branch and fall to the `else`. The role map is dead because `targetColumn` and `role` are never written to any event payload — that is the single independent reason the good output never appears.

**Layer 3 — one event type, a quarter of it unlabelled.**

`event_type` has exactly one value across the measured table (`workflow_event`, 8,565/8,565). Note: the code also writes `event_type: 'completed'` from `LocalApiServer.ts:2479` for task-completion events, so the "one value" finding is specific to the measured DB, not a universal invariant. `workflow` is `unknown` on 2,242 rows (26%). The remainder are mostly `move-to-*` slugs — which is the signal worth keeping, and the only one.

**Layer 4 — the table is unreachable outside one webview overlay.**

Verified: no `pathname === '/kanban/...'` route exposes events or the run sheet; no file under `.agents/skills/` or `.agents/protocols/` references `plan_events` (the three "runsheet" matches are a homonym — the runtime preamble prepended to the Mission Control prompt). The sole consumer chain is:

`kanban-meta-log-btn` → `fetchKanbanPlanLog` (`project.js:2086`, `planning.js:5946`) → `PlanningPanelProvider.ts:4061` → `SessionActionLog.getRunSheet` → `_hydrateRunSheet` → `getRunSheetByPlanId` → `formatReviewLogEntries` → `kanbanPlanLogReady` → overlay display (`project.js:790` calls `showKanbanLogOverlay`; `planning.js:4333` builds the overlay inline in the case handler — there is no `showKanbanLogOverlay` function in `planning.js`).

An agent asked "what is the status of this plan" cannot consult it and does not try.

### Background

The table has paid for itself exactly once, and not through the UI. `kill-derivekanbancolumn-override-db-column-authoritative.md` states its root cause was "confirmed via `plan_events` + DB timestamp forensics" — the permanent column bounce-back was found by reading this table directly with SQL. That is the use worth preserving: **developer forensics for card movement**, reached by query, not by overlay.

## Metadata

**Complexity:** 6
**Tags:** bugfix, database, refactor, performance

## User Review Required

**None.** Deleting the overlay is settled — one entry point, two distinct strings across 8,565 rows, no second consumer. The vocabulary question is settled too: **Alternative C**, decided above. Keep `start`/`stop`, add `from_column`/`to_column`/`actor`/`reason` as real columns.

The deciding fact is `KanbanProvider.ts:7482`'s duplicate-advance guard, which reads `action: 'start'` from a `plan_events`-hydrated run sheet on a live board-advance path and is not retired by anything. `PipelineOrchestrator` — the reader the original objection named — is deleted by `scheduling-lives-in-two-places-only.md`, so it is not a factor and needs no migration plan.

## Complexity Audit

### Routine

- Deleting one button, one verb case, one message type, two `case` arms and one overlay function (`project.js`) / inline overlay block (`planning.js`).
- Deleting `reviewLogUtils.ts` and its single import.
- Changing two retention default values and threading one config key that already exists as a parameter.
- Adding `from_column`, `to_column`, `actor`, `reason` columns via a new migration (ALTER TABLE ADD COLUMN, additive with NULL defaults).

### Complex / Risky

- **The vocabulary change is gated on `kill-derivekanbancolumn…` landing first.** `deriveKanbanColumn` reads the `move-to-*` / `reset-to-*` slugs out of `workflow` at five production call sites (not six — `KanbanProvider.ts:8336` is a comment, not a call): `TaskViewerProvider.ts:5788`, `KanbanProvider.ts:7370`, `:7396`, `:7424`, `:7780`. Narrowing or re-shaping events while those readers are live changes board column resolution. That plan's §4 removes them; this plan must not start until it has.
- **One surviving reader of `action: 'start'`.** `KanbanProvider.ts:7482` (`_advanceSessionsInColumn`) returns early when the last run-sheet event is `{ workflow, action: 'start' }`, preventing a duplicate advance; run sheets hydrate from `plan_events` (`SessionActionLog.ts:443`). Stopping `start` writes re-enables duplicate advances silently. Alternative C avoids it. (`PipelineOrchestrator.ts:25` was the other reader and is deleted by `scheduling-lives-in-two-places-only.md` — not a factor.)
- **`getRunSheet` has ~17 call sites and only some of them are the overlay.** Five callers use the sheet purely for `planFile` / `completed` (both exist on `plans`): `TaskViewerProvider.ts:5594`, `:17719`, `:19269`, `:20586`, and `KanbanProvider.ts:8751`. Those must be repointed at the `plans` row, not deleted, or unrelated paths lose a fallback. See §2 for the full enumeration.
- **`plan_events` write sites feed the plan-file `events[]` mirror as well as the DB.** `SessionActionLog` migrates events from session files into `plan_events` (`KanbanDatabase.ts:9875`, `migrateSessionEvents`). Changing what is written affects both surfaces; the mirror is not in scope here and must keep working.
- **CSS class reuse in `project.html`.** `.kanban-log-overlay`, `.kanban-log-modal`, and `.kanban-log-close` are reused by `#new-feature-modal` (line 1546) and `#feature-add-subtask-overlay` (line 1569). Removing these CSS classes from `project.html` would break both modals. They must NOT be removed from `project.html`. They CAN be removed from `planning.html` (only used by the dynamic overlay). Dead copies also exist in `tickets.html` and `design.html` — harmless but should be cleaned up.

## Edge-Case & Dependency Audit

**Migration.** `plan_events` is a shipped table on ~4,000 installs. This plan does **not** rewrite existing rows: old `start`/`stop` rows stay until retention ages them out, and the forensic query tolerates them (they simply carry NULL `from_column`/`to_column`/`actor`/`reason`). Adding columns is additive with NULL defaults via a new migration (e.g., V65). Note: `plan_events` is NOT in `SCHEMA_TABLES_SQL` — it is created only in migrations (V5, V20). The new columns must be added via a new migration ALTER; `_ensureSchemaColumns()` does not reconcile `plan_events` columns because the table is not in `SCHEMA_TABLES_SQL`. Do not backfill — there is nothing to backfill *from*, since the fields were never captured.

**PipelineOrchestrator dependency.** `PipelineOrchestrator.getNextStage()` (`PipelineOrchestrator.ts:20-44`) reads `action: 'start'` events to determine `lastWorkflow` and route the next pipeline stage. It is instantiated in `TaskViewerProvider.ts:1698` and started by the `pipelineStart` verb (`TaskViewerProvider.ts:15779`). This is a live, user-activated reader of the `start`/`stop` vocabulary. Any vocabulary change that stops writing `start` events must migrate `PipelineOrchestrator` first. Alternative C (keep vocabulary, add columns) does not have this problem. Additionally, `KanbanProvider.ts:7407` checks for the last `action: 'start'` event before pushing a duplicate in `_advanceSessionsInColumn` — this check becomes a no-op if `start` events stop being written.

**Retention interaction.** `runTelemetryRetention` already exists, is wired at `extension.ts:799` on activation, and is **inert for this workload**: the default `planEventsMinPerPlan` is 50, the observed average is 2.9 events per card, and no card exceeds 50 — so all 3,040 age-eligible rows (35% of the table) are permanently protected by the floor. The extension's call site passes only `planEventsOlderThanDays` and `activityLogOlderThanDays`, so the floor cannot be changed by configuration at all.

**Host parity.** `runTelemetryRetention` is called in `extension.ts` and **not** in `src/standalone/bootstrap.ts` — standalone never prunes, so its `plan_events` and `activity_log` grow without bound. Per the standing rule in `CLAUDE.md` / `AGENTS.md`, this must be wired in both roots. See `standalone-arms-no-queue-watch.md` for the same class of divergence in another subsystem.

**Subtask coverage is NOT in scope.** Measured, subtasks carry roughly half the events of anything else:

| card kind | cards | avg events | zero events |
|---|---|---|---|
| standalone | 1,171 | 2.58 | 326 (28%) |
| feature | 274 | 2.59 | 40 (15%) |
| **subtask** | **847** | **1.30** | 28 (3%) |

The cause and the fix are already owned by `kill-derivekanbancolumn…` §3 ("Fan out `recordRunSheetForColumnMove` to subtasks during cascade"). This plan does not duplicate it. The 326 zero-event standalone cards are a separate, unexplained gap and are called out as a follow-up rather than fixed here.

**Not in scope: answering "what is the status of this plan".** That need is real and this table is the wrong instrument for it — the authoritative answer is `plans.kanban_column` plus whether a completion POST landed, and column position advances when work *starts*, never on finish. A `GET /kanban/plan/<id>/status` reading `plans` alone would serve it. Recorded here so the next reader does not try to rebuild it on event history.

## Dependencies

- **`kill-derivekanbancolumn-override-db-column-authoritative.md` (PLAN REVIEWED, complexity 5) must land first.** Its §4 removes the five `deriveKanbanColumn` production call sites (not six — one match is a comment); until then the event vocabulary is load-bearing for board column resolution. Its §3 also fixes the subtask fan-out this plan deliberately omits.

## Adversarial Synthesis

Key risks. (1) **PipelineOrchestrator reads `action: 'start'` events** — stopping `start`/`stop` writes breaks pipeline stage routing; every plan routes to Planner. Mitigation: Alternative C keeps the vocabulary and adds forensic columns instead. (2) Deleting `getRunSheet` wholesale would break five callers that use it only as a `planFile` / `completed` fallback — they must be repointed at `plans`, not removed. (3) Removing `.kanban-log-overlay` CSS from `project.html` would break `#new-feature-modal` and `#feature-add-subtask-overlay` — the CSS is reused. (4) Narrowing the vocabulary before `kill-derivekanbancolumn` lands silently changes which column a card resolves to, and no gate would catch it. (5) Retuning retention without threading `planEventsMinPerPlan` changes nothing at all, because the floor — not the window — is what makes the prune inert; a plan that only lowers `planEventsOlderThanDays` ships a no-op and reads as complete. (6) Wiring retention in one host repeats the divergence the standing rule was just written about. Mitigations: Alternative C avoids the pipeline risk; the five fallback callers are enumerated by line; the CSS reuse is called out per file; the dependency is stated as hard; the floor is named as the load-bearing value; both composition roots are named in the changes.

## Proposed Changes

### 1. Delete the plan-log overlay

**Remove:**
- `src/services/reviewLogUtils.ts` entirely, and its import at `PlanningPanelProvider.ts:44`.
- The `fetchKanbanPlanLog` case at `PlanningPanelProvider.ts:4061-4082`.
- `kanban-meta-log-btn` and its click handler — `project.js:2085-2087`, `planning.js:5942-5950` — and the button's markup in both panels (`project.js:2006`, `planning.js:5869`).
- The `kanbanPlanLogReady` arm at `project.js:790` and the `showKanbanLogOverlay` function at `project.js:3394-3420` (named function, includes overlay markup creation).
- The `kanbanPlanLogReady` case at `planning.js:4333-4374` — this is an **inline overlay builder**, not a named function. There is no `showKanbanLogOverlay` in `planning.js`. Remove the entire case block.

**CSS — do NOT remove from `project.html`:** The `.kanban-log-overlay`, `.kanban-log-modal`, `.kanban-log-close` CSS classes (defined at `project.html:507-535`) are reused by `#new-feature-modal` (line 1546) and `#feature-add-subtask-overlay` (line 1569). Removing them breaks both modals. Only remove `.kanban-log-entry`, `.kanban-log-timestamp`, `.kanban-log-workflow`, `.kanban-log-details` CSS (log-specific, not reused).

**CSS — safe to remove from `planning.html`:** The `.kanban-log-overlay`, `.kanban-log-modal`, `.kanban-log-close` classes (defined at `planning.html:3442-3501`) are only used by the dynamic overlay. No static HTML in `planning.html` uses `class="kanban-log-*"`.

**CSS — dead copies in `tickets.html` and `design.html`:** Both files define `.kanban-log-overlay` / `.kanban-log-modal` CSS (tickets.html:3494, design.html:2913) but neither has the overlay button or handler. These are harmless dead CSS; clean them up for consistency but they are not load-bearing.

**Also remove** `fetchKanbanPlanLog` from `PLANNING_VERBS` in `src/generated/verbAllowlist.ts` — that file is generated, so run `npm run catalog:generate` rather than hand-editing it, and expect `npm run catalog:check` to be the gate that catches a hand-edit.

**Retarget, do not delete:** `src/test/verb-engine-planning-headless.test.js:159-166` asserts `fetchKanbanPlanLog` returns in-body log entries. Delete that test case with a one-line rationale in the file; the verb no longer exists.

### 2. Repoint the five non-overlay `getRunSheet` callers that use only `planFile` / `completed`

> **Superseded:** The original plan enumerated only two callers (`TaskViewerProvider.ts:5594` and `:17712`).
> **Reason:** A comprehensive grep found three additional callers that also use `getRunSheet` purely for `planFile` or `completed`, both of which exist on `plans` (`plan_file`, `status`).
> **Replaced with:** Five callers enumerated below.

| File | Line | Uses | Repoint to |
|------|------|------|------------|
| `TaskViewerProvider.ts` | 5594 | `sheet.planFile` (complexity lookup + role routing) | `plans.plan_file` via `getPlanBySessionId` |
| `TaskViewerProvider.ts` | 17719 | `sheet?.planFile` + `sheet?.completed` (fallback after `getPlanBySessionId`) | Already has `plan` from `getPlanBySessionId` — use `plan?.planFile` / `plan?.status === 'completed'` directly, drop the sheet fallback |
| `TaskViewerProvider.ts` | 19269 | `sheet?.completed` (fallback after DB check for `plan.status === 'completed'`) | Already checks `plan.status === 'completed'` first — drop the sheet fallback entirely |
| `TaskViewerProvider.ts` | 20586 | `sheet?.planFile` (archiving) | Read `plans.plan_file` via `getPlanBySessionId` |
| `KanbanProvider.ts` | 8751 | `sheet?.planFile` (fallback, already DB-first) | Already DB-first with sheet as fallback — drop the sheet fallback |

**Do NOT repoint** callers that use `sheet.events`, `sheet.brainSourcePath`, `sheet.createdAt`, or `sheet.topic` — those fields are not on `plans` or are needed from the event log. Specifically: `:1716`, `:5966`, `:17917`, `:19215` (brainSourcePath), `:19533` (events + createdAt), `:20215` (brainSourcePath), `:20693` (brainSourcePath + planFile), `:21069` (full sheet for record building), `:24794`, and all `KanbanProvider.ts` callers that use `sheet.events` for `deriveKanbanColumn` (`:7365`, `:7391`, `:7422`, `:7780`).

This removes the overlay's dependency chain without touching `SessionActionLog`'s plan-file mirror, which stays.

### 3. Add forensic columns to `plan_events` (Alternative C — keep vocabulary)

> **Superseded:** The original plan proposed stopping `start` / `stop` writes and replacing them with one `card_move` row per card movement.
> **Reason:** `PipelineOrchestrator.getNextStage()` (`PipelineOrchestrator.ts:25`) reads `action: 'start'` events to determine `lastWorkflow` and route the next pipeline stage. Stopping `start`/`stop` writes would break pipeline orchestration — every plan would route to Planner. Additionally, `KanbanProvider.ts:7407` checks for the last `action: 'start'` event before pushing a duplicate in `_advanceSessionsInColumn`.
> **Replaced with:** Alternative C — keep the existing `start`/`stop` vocabulary entirely. Add `from_column`, `to_column`, `actor`, and `reason` as real columns on the existing `plan_events` table via a new migration. Populate them on card-movement events (the `move-to-*` / `reset-to-*` workflows written by `recordRunSheetForColumnMove` at `TaskViewerProvider.ts:7249`). The forensic query gets real columns; `PipelineOrchestrator` keeps its data; no vocabulary migration needed.

*(Only after the dependency lands — `deriveKanbanColumn` readers must be removed first, since the `move-to-*` / `reset-to-*` workflow slugs stay in the `workflow` column and the forensic columns are additive.)*

Add four columns to `plan_events` via a new migration (e.g., V65):

```sql
ALTER TABLE plan_events ADD COLUMN from_column TEXT;
ALTER TABLE plan_events ADD COLUMN to_column TEXT;
ALTER TABLE plan_events ADD COLUMN actor TEXT;
ALTER TABLE plan_events ADD COLUMN reason TEXT;
```

Populate them in the card-movement write path (`recordRunSheetForColumnMove` → `_updateSessionRunSheet` → `SessionActionLog._doUpdateRunSheet` → `db.appendPlanEventByPlanId`). The `from_column` and `to_column` are known at the call site (`recordRunSheetForColumnMove` receives `targetColumn`; the current column can be read from `plans.kanban_column`). `actor` is the seat, terminal, or `user` that caused the move — today nothing records this; `device_id` is `os.hostname()` and answers a different question. `reason` is the existing free-text (`"User manually moved plan forwards"`) promoted out of the payload.

Keep `payload` for anything unstructured. The `event_type` column stays as-is (`workflow_event` for most events, `completed` for task-completion events from `LocalApiServer.ts:2479`).

Old rows are left alone: they carry NULL `from_column`/`to_column`/`actor`/`reason` and read as "pre-forensic-columns". Retention ages them out.

**If the vocabulary narrowing is ever revisited:** the only reader to migrate is `KanbanProvider.ts:7482`'s duplicate-advance guard — it needs a different dedupe basis (e.g. a `last_workflow` column on `plans`) before `start` writes stop. `PipelineOrchestrator` is not part of that work; it is deleted by `scheduling-lives-in-two-places-only.md`. That migration is a separate plan and is not required for Alternative C.

### 4. Make retention actually reclaim, and wire it in both hosts

- Thread `planEventsMinPerPlan` through the `extension.ts:799` call site and add `switchboard.kanban.planEventsMinPerPlan` to `package.json`, default **5**.
- Lower `switchboard.kanban.planEventsRetentionDays` default from 90 to **30**. With the overlay gone, no user-visible surface depends on the window; the forensic question is always about a recent move.
- Add the same `runTelemetryRetention` call to `src/standalone/bootstrap.ts`, reading the same two settings, so standalone stops growing without bound.

On today's data this makes the prune non-inert for the first time: 3,040 rows are already age-eligible at 90 days and every one of them is currently held by the floor.

## Verification Plan

### Automated Tests

1. `npm run compile-tests` — clean.
2. `npm run catalog:check` — passes, proving `verbAllowlist.ts` was regenerated rather than hand-edited.
3. `npm run test:contract:verb-engine-planning` — passes with the `fetchKanbanPlanLog` case removed.
4. `npm run test:contract:panel-runtime-surface` and `npm run test:contract:setup-panel-element-ids` — regression check that removing `kanban-meta-log-btn` did not orphan a referenced element id.
5. New: given a DB whose cards each hold fewer events than the floor, assert `runTelemetryRetention` with `planEventsMinPerPlan: 5` removes age-eligible rows — the assertion that would have caught the inert prune. A test that only asserts "the function ran" reproduces the bug.
6. New: assert `bootstrap.ts` calls `runTelemetryRetention`, mirroring the host-parity checks.
7. New: assert `#new-feature-modal` and `#feature-add-subtask-overlay` still resolve `.kanban-log-overlay` / `.kanban-log-modal` CSS after the overlay removal — catches the CSS-removal regression.
8. New: assert `PipelineOrchestrator.getNextStage()` still returns correct stages given events with `action: 'start'` — guards against any accidental vocabulary change that breaks the pipeline.

**Gate wiring:** `test:contract:verb-engine-planning`, `test:contract:panel-runtime-surface` and `test:contract:setup-panel-element-ids` are all invoked by `.github/workflows/integration-tests.yml`. Any new test file needs both a `package.json` script and a workflow step.

### Goal Invariants

- Assert `formatReviewLogEntries` is absent from `src/services/reviewLogUtils.ts` (file deleted).
- Assert `fetchKanbanPlanLog` is absent from `PLANNING_VERBS` in `src/generated/verbAllowlist.ts`.
- Assert `kanban-meta-log-btn` is absent from `src/webview/project.js` and `src/webview/planning.js`.
- Assert `.kanban-log-overlay` CSS is present in `src/webview/project.html` (must NOT be removed — reused by other modals).
- Assert `.kanban-log-overlay` CSS is absent from `src/webview/planning.html` (safe to remove — only used by deleted overlay).
- Assert `runTelemetryRetention` is called in both `src/extension.ts` and `src/standalone/bootstrap.ts`.
- Assert `planEventsMinPerPlan` is passed to `runTelemetryRetention` in `src/extension.ts:799`.
- Assert `plan_events` table has columns `from_column`, `to_column`, `actor`, `reason` after migration.
- Assert `PipelineOrchestrator.ts:25` still filters on `action === 'start'` (vocabulary unchanged under Alternative C).

### Manual

9. Open a plan's meta panel in both the project and planning panels — confirm no log button, no console error, and no dead overlay markup.
10. Open the Create New Feature modal and the Add Subtask to Feature modal in the project panel — confirm both still render correctly (CSS not broken).
11. Move a card, then query `plan_events` directly: confirm the new row has populated `from_column`, `to_column`, `actor`, and `reason` columns.
12. Run the extension against a copy of a real DB and confirm the row count drops — on this workload roughly 3,040 rows.
13. Run the standalone host against the same copy and confirm it prunes too.
14. Start the Pipeline Orchestrator, dispatch a plan through Improved plan → Lead Coder, and confirm it routes correctly (not stuck at Planner).

## Recommendation

Send to Coder. The deletion is mechanical but spans two webviews (with a CSS-reuse trap in `project.html`), a generated file, and a test. The retention change is two values plus one config key, and the value that matters is the floor rather than the window — the obvious edit (lowering the days) ships a no-op. The forensic columns are additive ALTERs with a single write-site change. Alternative C keeps the complexity at 6 by avoiding the `PipelineOrchestrator` migration that the original vocabulary narrowing would have required.
