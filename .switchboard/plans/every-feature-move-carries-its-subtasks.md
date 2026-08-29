# Every Feature Move Carries Its Subtasks

## Goal

A feature card and its subtasks occupy the same column, always, no matter which
code path moved the feature. Today several column writers are feature-blind:
they update the feature's own row and leave its subtasks where they were. This
plan makes the feature-aware cascade the only way a feature row's column can
change, and adds a gate that fails when a feature and its subtasks disagree.

### Problem & background

**Observed, in this workspace, right now.** The feature *Connections — External
AI Surfaces* (`1dafe7bf-13b4-4360-93e3-ecfdf4ce5f4b`) sits in `CODE REVIEWED`
with seven subtasks. Six are in `CODE REVIEWED`. The seventh — *Connections Jobs
Tab* (`836dde1f-2b5a-403e-bed6-13852cb455fd`) — is stranded in `CODER CODED`.

The `column_entered_at` values prove no cascade ever ran on this family:

```
CODE REVIEWED  2026-08-05T06:04:15.268Z   Memo Write-Back Watcher
CODE REVIEWED  2026-08-05T06:32:39.300Z   External-Agent Skill Launchers
CODE REVIEWED  2026-08-05T10:26:41.632Z   Move the WEB AGENTS Tab
CODE REVIEWED  2026-08-05T11:19:11.594Z   switchboard-spark
CODE REVIEWED  2026-08-05T11:36:09.479Z   Connections Panel — Rename Remote Control
CODE REVIEWED  2026-08-06T09:21:31.174Z   Scheduled External-Agent Jobs
CODER CODED    2026-08-18T01:46:47.761Z   Connections Jobs Tab          ← stranded
CODE REVIEWED  2026-08-20T22:58:39.525Z   ★ the feature itself
```

A cascade writes one `now` to the feature and every subtask in a single
transaction, so a cascaded family shares a timestamp. These are eight distinct
ones, and the feature arrived **last** — two days after the stranded subtask was
moved. Whatever moved the feature to `CODE REVIEWED` on 2026-08-20 touched only
the feature row. `plan_events` for the feature stops at `2026-08-05T05:14:03`, so
that move also recorded no event.

**Why it matters beyond tidiness.** A stranded subtask renders as a loose card in
a coding column. On 2026-08-28 an instruction to "dispatch the card in coded"
resolved to this stranded subtask rather than the intended card, and a review
agent was dispatched against a plan whose work had been committed ten days
earlier by nobody's dispatch. The strand is not cosmetic; it is a false entry in
the set of things the board says are awaiting work.

### Root cause

**Two cascade primitives, and a family of feature-blind writers.**

1. `KanbanDatabase.cascadeFeatureByPlanId` (`KanbanDatabase.ts:6819`) is correct.
   It derives the subtask set **in SQL** — `UPDATE plans SET kanban_column = ?
   … WHERE feature_id = ?` — so the set cannot be incomplete, and it wraps the
   feature update and the subtask update in one `BEGIN`/`COMMIT`. Thirteen call
   sites use it.

2. `KanbanDatabase.updateColumnWithFeatureCascadeByPlanId` (`:6767`) takes a
   **caller-supplied `subtaskPlanIds: string[]`**. A caller that computes an
   incomplete list strands the remainder, silently, with a `true` return. It
   currently has **zero callers** — verified — so it is dead code that exists
   only as a future divergence vector.

3. Several writers change `kanban_column` with no feature awareness at all. Any
   of them, handed a feature row, moves the feature and nothing else:

   | method | line | feature-aware? |
   | --- | --- | --- |
   | `updateColumnByPlanFileWithReason` | `KanbanDatabase.ts:2663` | no |
   | `movePlanByPlanFile` | `KanbanDatabase.ts:2916` | no |
   | `archivePlan` | `KanbanDatabase.ts:3147` | no |
   | `completeMultiple` | `KanbanDatabase.ts:5602` | no (deprecated, zero callers) |

   `completeMultipleByPlanFile` (`KanbanDatabase.ts:5564`) was originally listed
   here as feature-blind, but code inspection reveals it **already has an inline
   cascade** — it queries `is_feature` and runs `UPDATE plans SET status =
   'completed', kanban_column = 'COMPLETED' ... WHERE feature_id = ? AND status =
   'active'` when the plan is a feature. See the Superseded callout in Proposed
   Changes §1 for the correction.

   The `plan_file`-keyed ones are the importer/watcher paths, which is consistent
   with the observed move recording no `plan_events` row.

The defect is not a missing cascade. It is that the cascade is one option among
several rather than the only door.

---

## Metadata

**Complexity:** 5
**Tags:** backend, bugfix, reliability, database
**Project:** Browser Switchboard

---

## User Review Required

**None.** Decisions made here:

* **Route, do not duplicate.** The feature-blind writers gain a feature check
  that delegates to `cascadeFeatureByPlanId`; they do not each grow their own
  subtask `UPDATE`. A second hand-rolled cascade is the bug this plan closes.
* **Delete `updateColumnWithFeatureCascadeByPlanId`.** Zero callers, and its
  caller-supplied set is unsound by construction. It is not kept "in case".
* **Delete `completeMultiple` (deprecated).** Zero callers, session-keyed in a
  plan_id world. Same dead-code rationale.
* **Refactor `completeMultipleByPlanFile`, do not layer on it.** It already has
  an inline cascade; the fix replaces the inline cascade with delegation to
  `cascadeFeatureByPlanId`, not a second cascade on top.
* **Repair the existing strand.** One subtask is diverged today. A one-shot
  reconciliation at startup re-aligns diverged subtasks to their feature. This is
  a data fix for shipped state, so it is idempotent and logs what it changed.
* **Reconciliation aligns subtasks to the feature, never the reverse.** The
  feature card is the one the operator moves and the one Mission Control reads.

---

## Complexity Audit

* **Score:** 5 / 10

### Routine
* `cascadeFeatureByPlanId` already exists, is transactional, and is used by
  thirteen call sites — this plan adds callers, it does not design a mechanism.
* Deleting two zero-caller methods (`updateColumnWithFeatureCascadeByPlanId`
  and the deprecated `completeMultiple`).
* The `is_feature` flag is already on every row and already read elsewhere.
* `completeMultipleByPlanFile` already cascades — refactoring it to delegate to
  `cascadeFeatureByPlanId` is a replacement, not new logic.

### Complex / Risky
* **The `plan_file`-keyed writers do not have a `plan_id` in hand.** They must
  resolve the row first to learn whether it is a feature, which adds a read to a
  hot import path. Resolve once and reuse; do not read twice.
* **Re-entrancy.** `cascadeFeatureByPlanId` calls `flushPersist()`. A
  feature-blind writer that now delegates must not also persist, or an import
  sweep over many files pays a synchronous disk flush per file.
* **`archivePlan` also writes `status`.** The cascade takes an optional
  `targetStatus`; this caller must pass it, or a feature is archived while its
  subtasks stay active.
* **`completeMultipleByPlanFile` refactor must not double-cascade.** The inline
  cascade block must be removed when `_cascadeIfFeature` is added, or subtasks
  are written twice in one call.
* **Shipped state.** Features are on the board in released versions, so the
  reconciliation is a migration over user data. It must be idempotent and must
  never invent a column for a feature that has none.

---

## Edge-Case & Dependency Audit

### Race Conditions
* `cascadeFeatureByPlanId` already documents and closes the debounced-persist
  race by calling `flushPersist()` before returning (`KanbanDatabase.ts:6853-6859`).
  New callers inherit that; they must not add a second flush.
* The startup reconciliation must run **after** schema migration (`ensureReady()`)
  and **before** the first board read. In `extension.ts`, it goes after
  `reconcileHotCold` (line ~723). In `bootstrap.ts`, it goes after `ensureReady()`
  (line 511) and before `ingestionEngine.initialize()` (line 830). The plan
  importer's first sweep is asynchronous (`PlanIngestionEngine._runStartupScan()`)
  and does not block activation, so the reconciliation runs before the sweep
  completes — this is correct, as it fixes existing DB rows, not pending imports.

### Security
* None. No new endpoint, no new input, no change to who may move a card.

### Side Effects
* Moving a feature now writes N+1 rows instead of 1. For the largest feature in
  this workspace that is 8 rows in one transaction — immaterial.
* The board emits a column-change event per affected card. Verify the board
  coalesces a cascade into one render rather than N.

### Dependencies & Conflicts
* Sibling: **A Subtask's Column Is Its Feature's Column** — that plan stops a
  subtask from diverging in the first place; this one stops the feature from
  leaving subtasks behind. Neither subsumes the other and they are independently
  shippable. If both land, the reconciliation here becomes a no-op after its
  first run, which is the intended end state.
* `auto-column-feature-subtasks-to-plan-reviewed-on-import.md` (PLAN REVIEWED)
  places a *freshly imported* subtask. It does not touch feature moves and does
  not overlap.

---

## Dependencies

_(None — this is a self-contained invariant-enforcement plan. No prerequisite
sessions. The sibling plan **A Subtask's Column Is Its Feature's Column** is not
blocking; see Dependencies & Conflicts above for the independence note.)_

---

## Adversarial Synthesis

Key risks: (1) `completeMultipleByPlanFile` already has an inline cascade —
adding `_cascadeIfFeature` to it without removing the inline cascade
double-writes subtasks in one call; (2) `completeMultiple` (5602) is deprecated
with zero callers — fixing it is wasted work, deleting it is better; (3) the two
composition roots have different startup sequences — `extension.ts` runs
migrations + `reconcileHotCold` synchronously, `bootstrap.ts` runs only
`ensureReady()`, so the reconciliation wiring is not symmetric; (4)
re-entrancy — `cascadeFeatureByPlanId` calls `flushPersist()`, so new callers
must not also persist. Mitigations: refactor `completeMultipleByPlanFile` to
delegate to `cascadeFeatureByPlanId` instead of layering a second cascade; delete
`completeMultiple` alongside the dead `updateColumnWithFeatureCascadeByPlanId`;
wire reconciliation after `ensureReady()` in both roots with `extension.ts`
also placing it after `migrateDeprecatedColumns`; delegate to cascade only (no
extra persist).

---

## Proposed Changes

### 1. `src/services/KanbanDatabase.ts` — one door

* Delete `updateColumnWithFeatureCascadeByPlanId` (`:6767-6800`). Zero callers.
* Delete `completeMultiple` (`:5602`). Deprecated, zero callers — same dead-code
  rationale as `updateColumnWithFeatureCascadeByPlanId`.
* Add a private helper `_cascadeIfFeature(planId, targetColumn, targetStatus?)`
  that returns `true` when the row is `is_feature = 1` and it delegated to
  `cascadeFeatureByPlanId`, `false` when the row is not a feature and the caller
  should do its own single-row update.
* Call it first in each feature-blind writer:
  `updateColumnByPlanFileWithReason` (`:2663`), `movePlanByPlanFile` (`:2916`),
  `archivePlan` (`:3147`). The `plan_file`-keyed ones resolve the row once
  and pass the resolved `plan_id` through.
* `archivePlan` passes its `status` as `targetStatus` so status cascades with
  the column.

> **Superseded:** `completeMultipleByPlanFile` (`:5564`) was listed as a
> feature-blind writer to receive `_cascadeIfFeature`. Code inspection reveals
> it **already has an inline cascade**: it queries `is_feature`, and when true,
> runs `UPDATE plans SET status = 'completed', kanban_column = 'COMPLETED' ...
> WHERE feature_id = ? AND status = 'active'`.
> **Reason:** Adding `_cascadeIfFeature` to this method without removing the
> inline cascade would double-write subtasks — the helper's
> `cascadeFeatureByPlanId` writes the feature + subtasks, then the method's own
> inline cascade writes the subtasks again. Same transaction, same `now`, so the
> shared-timestamp gate passes, but it is wasted work and a maintenance trap.
> **Replaced with:** Refactor `completeMultipleByPlanFile` to **replace** its
> inline cascade with a call to `_cascadeIfFeature(planId, 'COMPLETED',
> 'completed')`. Remove the inline `is_feature` query and the hand-rolled
> `UPDATE ... WHERE feature_id = ?` block. The method becomes: single-row
> update for non-features, `_cascadeIfFeature` delegation for features — the
> same shape as the other three writers.

**Edge cases:** a feature with zero subtasks cascades to itself and returns
`true` — correct, not a special case. A row that no longer exists returns
`false` and the caller's existing not-found handling applies unchanged.

### 2. `src/services/KanbanDatabase.ts` — reconciliation for shipped state

Add `reconcileFeatureSubtaskColumns(workspaceId)`: for every `is_feature = 1`
row, update active subtasks whose `kanban_column` differs to the feature's
column, in one transaction per feature. Return the count and log one line per
feature it changed. Idempotent — a second run changes nothing.

Call it once at startup, in **both** composition roots. The two roots have
different startup sequences:

* **`src/extension.ts`**: runs `db.ensureReady()` (schema migration) at line 711,
  then `migrateDeprecatedColumns` at 719, then `reconcileHotCold` at 722. Place
  `reconcileFeatureSubtaskColumns` immediately after `reconcileHotCold` (line
  ~723), before the first board read. The plan importer is NOT called during
  activation — `GlobalPlanWatcherService.initialize()` (line 791) triggers
  `PlanIngestionEngine._runStartupScan()` asynchronously, so the reconciliation
  runs before the first scan completes, which is correct (it fixes existing DB
  rows, not pending imports).
* **`src/standalone/bootstrap.ts`**: runs `db.ensureReady()` at line 511. There
  are NO migrations and NO `reconcileHotCold` call. Place
  `reconcileFeatureSubtaskColumns` immediately after `ensureReady()`, before
  `ingestionEngine.initialize()` (line 830).

Wiring it in one host only is the exact composition-root divergence `CLAUDE.md`
names; the seam must appear in both diffs.

**Edge cases:** a feature whose own column is empty or invalid is skipped and
logged, never used as a target. Subtasks with `status != 'active'` are left
alone, matching `cascadeFeatureByPlanId`'s own filter.

### 3. `src/test/feature-subtask-column-contract.test.js` — the gate

New contract test, wired into `package.json` and into
`.github/workflows/integration-tests.yml`. A test defined but not invoked by CI
is the "green while incomplete" hole this plan exists to close.

---

## Files Changed

* `src/services/KanbanDatabase.ts` (delete 2 dead methods, add `_cascadeIfFeature`,
  refactor `completeMultipleByPlanFile`, add `reconcileFeatureSubtaskColumns`)
* `src/extension.ts`, `src/standalone/bootstrap.ts` (reconciliation wiring, both roots)
* `src/test/feature-subtask-column-contract.test.js` — new
* `package.json`, `.github/workflows/integration-tests.yml` (gate wiring)

---

## Verification Plan

### Automated

1. **Every feature-blind writer cascades.** For each of the three genuinely
   feature-blind writers (`updateColumnByPlanFileWithReason`, `movePlanByPlanFile`,
   `archivePlan`): move a feature with three subtasks, assert all four rows share
   the new column **and the same `column_entered_at`**. The shared timestamp is
   the assertion that distinguishes a real cascade from N single-row writes.
2. **`completeMultipleByPlanFile` cascades via the shared primitive.** Move a
   feature with three subtasks to `COMPLETED`; assert all four rows share the
   column, status, and `column_entered_at`. Assert the inline cascade block
   (the old `UPDATE ... WHERE feature_id = ?` inside the method) is gone —
   `cascadeFeatureByPlanId` is the only cascade path.
3. **Non-features are untouched.** The same four methods against a plain plan
   update exactly one row.
4. **Status cascades too.** `archivePlan` and `completeMultipleByPlanFile` leave
   no subtask `active` under a completed feature.
5. **`updateColumnWithFeatureCascadeByPlanId` is gone** — zero occurrences in
   `src/`, so the caller-supplied-set primitive cannot be reintroduced by
   autocomplete.
6. **`completeMultiple` is gone** — zero occurrences in `src/`. The deprecated
   session-keyed method is deleted alongside the dead cascade primitive.
7. **Reconciliation.** Seed a feature in `CODE REVIEWED` with one subtask in
   `CODER CODED`; run it; assert the subtask moved and the feature did not. Run
   again; assert zero changes.
8. **Both roots wire it.** Assert `reconcileFeatureSubtaskColumns` appears in
   `src/extension.ts` (after `reconcileHotCold`) **and** in
   `src/standalone/bootstrap.ts` (after `ensureReady()`).
9. **The invariant holds.** Over a seeded board, assert zero rows where a
   subtask's column differs from its feature's.
10. **Gate wiring.** The new script is invoked by CI, not merely defined.

### Goal Invariants

1. `updateColumnWithFeatureCascadeByPlanId` is absent from all files in `src/`.
2. `completeMultiple` (the deprecated session-keyed method) is absent from all files in `src/`.
3. `reconcileFeatureSubtaskColumns` appears in both `src/extension.ts` and `src/standalone/bootstrap.ts`.
4. Zero rows in `plans` where `is_feature = 1 AND EXISTS (SELECT 1 FROM plans sub WHERE sub.feature_id = plans.plan_id AND sub.kanban_column != plans.kanban_column AND sub.status = 'active')` after reconciliation.
5. `completeMultipleByPlanFile` contains no inline `WHERE feature_id = ?` UPDATE — it delegates to `cascadeFeatureByPlanId` via `_cascadeIfFeature`.

### Manual

1. Move a feature across three columns on the board; every subtask follows, and
   the board renders one update, not N.
2. Against **this** workspace: run the reconciliation and confirm
   `836dde1f-2b5a-403e-bed6-13852cb455fd` moves from `CODER CODED` to
   `CODE REVIEWED` and the other six do not move.
3. Confirm no card in a coding column belongs to a feature afterwards.
4. Both hosts: the extension and `npx switchboard`.

---

## Recommendation

Complexity 5 → **Send to Coder.**
