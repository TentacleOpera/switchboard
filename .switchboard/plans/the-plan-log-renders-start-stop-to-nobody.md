# The Plan Log Renders start/stop To Nobody

## Goal

`plan_events` is 8,565 rows and roughly 40% of a 7.3 MB `kanban.db`. Every one of those rows renders in the UI as `action=start` or `action=stop`, because the renderer branches on an event vocabulary that was never written. Nothing else can read the table: there is no HTTP endpoint, no skill references it, and the Mission Control skill instructs the opposite ("re-read the board and git from scratch and decide from that").

Retire the log overlay, narrow the event vocabulary to the one question the table has ever actually answered — *why did this card move?* — and retune retention to match. The table stays; the panel and the noise go.

### Root Cause Analysis

**Layer 1 — five of the renderer's six branches are unreachable.**

`formatReviewLogEntries` (`src/services/reviewLogUtils.ts:11-40`) selects its output by `event.action`, branching on `execute`, `delegate_task`, `submit_result`, `start_workflow` and `complete_workflow_phase`. Measured across the whole table, the only `action` values that exist are:

| `action` | rows | share |
|---|---|---|
| `stop` | 5,487 | 64.1% |
| `start` | 3,077 | 35.9% |
| *(empty)* | 1 | 0.0% |

None of the five branches can fire. **100% of events fall to the `else`**, which emits `action=start` / `action=stop`. Every line of the overlay reads the same two ways.

**Layer 2 — the readable output needs fields nothing writes, and a parse nothing performs.**

The good output (`SENT TO Lead Coder`, `COMPLETED — Reviewer`) is gated on `event.targetColumn`, resolved through a column→role map. Across all 8,565 rows:

- payload containing `targetColumn`: **0**
- payload containing `role`: **0**
- payload containing `outcome`: 5,487

So the role map is dead by construction. Worse, the one genuinely useful field that *is* written — `"outcome":"User manually moved plan forwards"` — never reaches the renderer either: `getPlanEventsByPlanId` (`KanbanDatabase.ts:9769`) does `SELECT *` + `getAsObject()`, so `payload` arrives as an unparsed JSON **string** and `event.outcome` is `undefined` on every DB-sourced event.

Two independent reasons the same information cannot be displayed.

**Layer 3 — one event type, a quarter of it unlabelled.**

`event_type` has exactly one value across the table (`workflow_event`, 8,565/8,565). `workflow` is `unknown` on 2,242 rows (26%). The remainder are mostly `move-to-*` slugs — which is the signal worth keeping, and the only one.

**Layer 4 — the table is unreachable outside one webview overlay.**

Verified: no `pathname === '/kanban/...'` route exposes events or the run sheet; no file under `.agents/skills/` or `.agents/protocols/` references `plan_events` (the three "runsheet" matches are a homonym — the runtime preamble prepended to the Mission Control prompt). The sole consumer chain is:

`kanban-meta-log-btn` → `fetchKanbanPlanLog` (`project.js:2086`, `planning.js:5946`) → `PlanningPanelProvider.ts:4061` → `SessionActionLog.getRunSheet` → `formatReviewLogEntries` → `kanbanPlanLogReady` → `showKanbanLogOverlay` (`project.js:790`, `planning.js:4333`).

An agent asked "what is the status of this plan" cannot consult it and does not try.

### Background

The table has paid for itself exactly once, and not through the UI. `kill-derivekanbancolumn-override-db-column-authoritative.md` states its root cause was "confirmed via `plan_events` + DB timestamp forensics" — the permanent column bounce-back was found by reading this table directly with SQL. That is the use worth preserving: **developer forensics for card movement**, reached by query, not by overlay.

## Metadata

**Complexity:** 5
**Tags:** bugfix, database, refactor, performance

## User Review Required

None. Deleting the overlay is settled — it has one entry point, renders two distinct strings across 8,565 rows, and no second consumer exists. The vocabulary narrowing keeps the only field set the table has demonstrably been used for.

## Complexity Audit

### Routine

- Deleting one button, one verb case, one message type, two `case` arms and one overlay function.
- Deleting `reviewLogUtils.ts` and its single import.
- Changing two retention default values and threading one config key that already exists as a parameter.

### Complex / Risky

- **The vocabulary change is gated on `kill-derivekanbancolumn…` landing first.** `deriveKanbanColumn` reads the `move-to-*` / `reset-to-*` slugs out of `workflow` at six call sites. Narrowing or re-shaping events while those readers are live changes board column resolution. That plan's §4 removes them; this plan must not start until it has.
- **`getRunSheet` has ~15 call sites and only some of them are the overlay.** `TaskViewerProvider.ts:5594` and `:17712` use the sheet purely for `sheet.planFile` / `sheet.completed`, both of which exist on `plans`. Those must be repointed at the `plans` row, not deleted, or two unrelated paths lose a fallback.
- **`plan_events` write sites feed the plan-file `events[]` mirror as well as the DB.** `SessionActionLog` migrates events from session files in (`KanbanDatabase.ts:9872`). Changing what is written affects both surfaces; the mirror is not in scope here and must keep working.

## Edge-Case & Dependency Audit

**Migration.** `plan_events` is a shipped table on ~4,000 installs. This plan does **not** rewrite existing rows: old `start`/`stop` rows stay until retention ages them out, and the forensic query tolerates them (they simply carry no from/to columns). Adding columns is additive with NULL defaults. Do not backfill — there is nothing to backfill *from*, since the fields were never captured.

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

- **`kill-derivekanbancolumn-override-db-column-authoritative.md` (PLAN REVIEWED, complexity 5) must land first.** Its §4 removes the six `deriveKanbanColumn` readers; until then the event vocabulary is load-bearing for board column resolution. Its §3 also fixes the subtask fan-out this plan deliberately omits.

## Adversarial Synthesis

Key risks. (1) Deleting `getRunSheet` wholesale would break two callers that use it only as a `planFile` / `completed` fallback — they must be repointed at `plans`, not removed. (2) Narrowing the vocabulary before `kill-derivekanbancolumn` lands silently changes which column a card resolves to, and no gate would catch it. (3) Retuning retention without threading `planEventsMinPerPlan` changes nothing at all, because the floor — not the window — is what makes the prune inert; a plan that only lowers `planEventsOlderThanDays` ships a no-op and reads as complete. (4) Wiring retention in one host repeats the divergence the standing rule was just written about. Mitigations: the dependency is stated as hard; the two fallback callers are enumerated by line; the floor is named as the load-bearing value; both composition roots are named in the changes.

## Proposed Changes

### 1. Delete the plan-log overlay

**Remove:**
- `src/services/reviewLogUtils.ts` entirely, and its import at `PlanningPanelProvider.ts:44`.
- The `fetchKanbanPlanLog` case at `PlanningPanelProvider.ts:4061-4082`.
- `kanban-meta-log-btn` and its click handler — `project.js:2085-2087`, `planning.js:5942-5950` — and the button's markup in both panels.
- The `kanbanPlanLogReady` arms at `project.js:790` and `planning.js:4333`, and `showKanbanLogOverlay` plus its overlay markup/CSS.

**Also remove** `fetchKanbanPlanLog` from `PLANNING_VERBS` in `src/generated/verbAllowlist.ts` — that file is generated, so run `npm run catalog:generate` rather than hand-editing it, and expect `npm run catalog:check` to be the gate that catches a hand-edit.

**Retarget, do not delete:** `src/test/verb-engine-planning-headless.test.js:159` asserts `fetchKanbanPlanLog` returns in-body log entries. Delete that test case with a one-line rationale in the file; the verb no longer exists.

### 2. Repoint the two non-overlay `getRunSheet` callers

`TaskViewerProvider.ts:5594` uses `sheet.planFile` to look up complexity and resolve a routed role. `TaskViewerProvider.ts:17712` uses `sheet?.planFile` and `sheet?.completed` as a fallback when `getPlanBySessionId` misses. Both fields live on `plans` (`plan_file`, `status`). Read the `plans` row directly at both sites.

This removes the overlay's dependency chain without touching `SessionActionLog`'s plan-file mirror, which stays.

### 3. Narrow the event vocabulary to card movement

*(Only after the dependency lands.)*

Stop writing `start` / `stop` pairs. Write one row per card movement, carrying what a forensic query actually needs and currently has to infer:

- `from_column` and `to_column` as real columns, not payload keys.
- `actor` — the seat, terminal, or `user` that caused the move. Today nothing records who moved a card; `device_id` is `os.hostname()` and answers a different question.
- `reason` — the existing free-text (`"User manually moved plan forwards"`) promoted out of the payload.

`event_type` becomes meaningful (`card_move`) rather than a single constant. Keep `payload` for anything unstructured, but stop relying on it for fields a query needs.

Old rows are left alone: they carry NULL `from_column`/`to_column`/`actor` and read as "pre-vocabulary". Retention ages them out.

### 4. Make retention actually reclaim, and wire it in both hosts

- Thread `planEventsMinPerPlan` through the `extension.ts:799` call site and add `switchboard.kanban.planEventsMinPerPlan` to `package.json`, default **5**.
- Lower `switchboard.kanban.planEventsRetentionDays` default from 90 to **30**. With the overlay gone, no user-visible surface depends on the window; the forensic question is always about a recent move.
- Add the same `runTelemetryRetention` call to `src/standalone/bootstrap.ts`, reading the same two settings, so standalone stops growing without bound.

On today's data this makes the prune non-inert for the first time: 3,040 rows are already age-eligible at 90 days and every one of them is currently held by the floor.

## Verification Plan

### Automated

1. `npm run compile-tests` — clean.
2. `npm run catalog:check` — passes, proving `verbAllowlist.ts` was regenerated rather than hand-edited.
3. `npm run test:contract:verb-engine-planning` — passes with the `fetchKanbanPlanLog` case removed.
4. `npm run test:contract:panel-runtime-surface` and `npm run test:contract:setup-panel-element-ids` — regression check that removing `kanban-meta-log-btn` did not orphan a referenced element id.
5. New: given a DB whose cards each hold fewer events than the floor, assert `runTelemetryRetention` with `planEventsMinPerPlan: 5` removes age-eligible rows — the assertion that would have caught the inert prune. A test that only asserts "the function ran" reproduces the bug.
6. New: assert `bootstrap.ts` calls `runTelemetryRetention`, mirroring the host-parity checks.

**Gate wiring:** `test:contract:verb-engine-planning`, `test:contract:panel-runtime-surface` and `test:contract:setup-panel-element-ids` are all invoked by `.github/workflows/integration-tests.yml`. Any new test file needs both a `package.json` script and a workflow step.

### Manual

7. Open a plan's meta panel in both the project and planning panels — confirm no log button, no console error, and no dead overlay markup.
8. Move a card, then query `plan_events` directly: confirm one `card_move` row with populated `from_column`, `to_column` and `actor`.
9. Run the extension against a copy of a real DB and confirm the row count drops — on this workload roughly 3,040 rows.
10. Run the standalone host against the same copy and confirm it prunes too.

## Recommendation

Send to Coder. The deletion is mechanical but spans two webviews, a generated file and a test; the retention change is two values plus one config key, and the value that matters is the floor rather than the window — the obvious edit (lowering the days) ships a no-op.
