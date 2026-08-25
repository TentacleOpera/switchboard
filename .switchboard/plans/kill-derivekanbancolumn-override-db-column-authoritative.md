# Kill deriveKanbanColumn Override — DB Column Is Authoritative

## Metadata

**Tags:** bugfix, database, refactor
**Complexity:** 5

## Goal

The kanban column position has two parallel sources of truth in the same `kanban.db`:

1. `plans.kanban_column` — the authoritative field, set by `cascadeFeatureByPlanId` and `updateColumnByPlanFileWithReason`, preserved by ON CONFLICT clauses.
2. `plan_events` → `deriveKanbanColumn(events)` — a re-derivation from the event log, used as a fallback or override in several code paths.

These diverge whenever the event log isn't perfectly maintained. The specific trigger: when a feature is dragged to a new column, `cascadeFeatureByPlanId` updates subtask DB columns correctly, but `recordRunSheetForColumnMove` is only called for the feature's sessionId — subtask `plan_events` are never updated. Any code path that calls `deriveKanbanColumn(events)` on a subtask sees the stale last move (`move-to-plan-reviewed`) instead of the actual column (`LEAD CODED`), and can write that stale value back to the DB, causing the permanent bounce-back.

## Root Cause (confirmed via plan_events + DB timestamp forensics)

The bounce-back has **three independent failure layers** that must all be fixed:

### Layer 1 — `_persist()` debounce race (the immediate cause of THIS bounce-back)

The dispatch path pushes an `'Improved plan'` event and calls `cascadeFeatureByPlanId`, which writes PLAN REVIEWED to the **in-memory** sql.js DB. But `_persist()` at `KanbanDatabase.ts` line ~9568 is **debounced 300ms** — it arms a timer and returns `true` immediately. The disk file still has CREATED.

`_regenerateFeatureFile` then reads PLAN REVIEWED from the **in-memory** DB and writes the feature file (mtime 05:06:45, showing PLAN REVIEWED). So the feature file is correct.

But the disk DB never gets the cascade's changes. The evidence (from the original incident):
- Feature `column_entered_at` = 05:04:20 (the pre-cascade time), not 05:06:45
- Subtask `column_entered_at` = creation times (never moved in the DB)
- Subtask `plan_events` show only `unknown` at creation — no `'Improved plan'` event for subtasks

When a second VS Code window (or any external DB file mtime change) triggers `_reloadIfStale`, it calls `flushPersist()` which writes the **stale in-memory image** (CREATED) to disk, overwriting the first window's PLAN REVIEWED. This is the "stale-snapshot _persist()" problem documented in the diagnostic comment at `KanbanDatabase.ts` line 1112-1115.

**Critical gap discovered during improve-pass:** The debounce race is NOT limited to feature cascades. `updateColumnByPlanFileWithReason` (line 2617) — the **standalone plan move path** — also calls `await this._persist()` (line 2638) without `flushPersist()`. This plan's own kanban state proves it: `plan_events` show `move-to-plan-reviewed` at 06:09:46, but `plans.kanban_column` is still `CREATED` and `column_entered_at` is the creation timestamp (03:00:53). The in-memory write was lost to the debounce race.

### Layer 2 — `deriveKanbanColumn` override (the legacy cause of other bounce-backs)

`deriveKanbanColumn` is a legacy from before the DB existed. It was never removed when `plans.kanban_column` became the source of truth. It is a redundant derivation of the same fact, stored in the same database, that diverges whenever the event log isn't perfectly maintained, and it is used to override the authoritative field.

### Layer 3 — Subtask `plan_events` never updated during cascade

When a feature is moved via `moveCardToColumnWithReason`, `cascadeFeatureByPlanId` updates subtask DB columns, but `recordRunSheetForColumnMove` is only called for the feature's sessionId. Subtask `plan_events` are never updated, so any code path that calls `deriveKanbanColumn(events)` on a subtask sees a stale column.

## Fix

Four changes, in order:

### 1. Flush `cascadeFeatureByPlanId` and `updateColumnWithFeatureCascadeByPlanId` to disk immediately (Layer 1 — feature cascade path)

**STATUS: ALREADY COMMITTED.** Both functions already have `await this.flushPersist();` after `await this._persist();` in the committed code. No git diff for `KanbanDatabase.ts` confirms these are in the tree, not the working tree.

**`KanbanDatabase.ts` — `cascadeFeatureByPlanId`** (line 6772-6779):
```
this._db.run('COMMIT');
await this._persist();
// Force an immediate disk flush — _persist() is debounced 300ms, so the
// disk file still has the pre-cascade column when the file watcher fires
// on _regenerateFeatureFile's write. If anything triggers _reloadIfStale
// in that window (a second IDE window, a backup restore, a stat check),
// the stale disk state clobbers the in-memory cascade. Flushing here
// closes the race: the disk file is authoritative before control returns.
await this.flushPersist();
return true;
```

**`KanbanDatabase.ts` — `updateColumnWithFeatureCascadeByPlanId`** (line 6713-6714):
```
this._db.run('COMMIT');
await this._persist();
await this.flushPersist();
return true;
```

### 2. Flush `updateColumnByPlanFileWithReason` to disk immediately (Layer 1 — standalone plan path)

> **Superseded:** The original plan only patched the two feature-cascade functions, leaving the standalone plan move path unprotected.
> **Reason:** `updateColumnByPlanFileWithReason` (line 2617) is the path that standalone (non-feature) plans take when moved. It calls `await this._persist()` (line 2638) — debounced 300ms — without `flushPersist()`. This plan's own stuck state (kanban_column=CREATED, plan_events show move-to-plan-reviewed) proves the debounce race strikes here too. The feature-cascade fix is necessary but not sufficient.
> **Replaced with:** Add `await this.flushPersist();` after `await this._persist();` in `updateColumnByPlanFileWithReason`, extending the same debounce-race fix to the standalone path.

**`KanbanDatabase.ts` — `updateColumnByPlanFileWithReason`** (line 2638):
```
await this._persist();
await this.flushPersist();  // ← ADD: force immediate disk write (same fix as cascade functions)
```

This is the single most critical change. Without it, every standalone plan move is vulnerable to the same debounce race that stuck this plan.

### 3. Fan out `recordRunSheetForColumnMove` to subtasks during cascade (Layer 3)

**STATUS: ALREADY IN WORKING TREE** (visible in `git diff src/services/KanbanProvider.ts`).

When a feature is moved, `cascadeFeatureByPlanId` updates subtask DB columns. `recordRunSheetForColumnMove` is then called for the feature's sessionId only. Subtask `plan_events` are never updated, creating the divergence.

**`KanbanProvider.ts` — `moveCardToColumnWithReason`** (line 8225):

The fan-out is already implemented inside `moveCardToColumnWithReason` itself (lines 8238, 8244, 8271-8277), so every call site that goes through this function gets the subtask fan-out for free. The `subtaskKeys` array collects `sessionId || planId` for each subtask, and after the cascade succeeds, `recordRunSheetForColumnMove` is fanned out to each subtask key via `Promise.allSettled`.

```
let subtaskKeys: string[] = [];  // sessionId or planId — for runsheet fan-out
if (plan && plan.isFeature) {
    const subtasks = await db.getSubtasksByFeatureId(plan.planId);
    subtaskSessionIds = subtasks.map(st => st.sessionId).filter(Boolean);
    subtaskKeys = subtasks.map(st => st.sessionId || st.planId).filter(Boolean);
    ...
}
```

Then after the integration sync fan-out:

```
if (subtaskKeys.length > 0) {
    await Promise.allSettled(
        subtaskKeys.map(key =>
            this._taskViewerProvider?.recordRunSheetForColumnMove(key, targetColumn, 'forward', workspaceRoot)
        )
    );
}
```

> **Superseded:** The original plan listed "all other cascade call sites" at lines 6895, 6938, 8614, 8670, 10008, 10053 and instructed auditing each one.
> **Reason:** Those line numbers are stale. More importantly, since the fan-out is inside `moveCardToColumnWithReason`, every external call site that calls `moveCardToColumn` or `moveCardToColumnWithReason` already gets the subtask fan-out for free. The audit instruction was solving a problem that is already solved by the internal placement.
> **Replaced with:** No external call site changes needed. The fan-out inside `moveCardToColumnWithReason` covers all paths.

### 4. Remove `deriveKanbanColumn` from all column-determination paths (Layer 2)

The DB `plans.kanban_column` is the only source of truth for column position. `deriveKanbanColumn(events)` must never be used to determine, override, or fallback for a card's column.

**Production call sites of `deriveKanbanColumn` (from comprehensive grep):**

| File | Line | Function | Use | Action |
|------|------|----------|-----|--------|
| `KanbanProvider.ts` | 7303 | `_getEligibleSessionIds` | Current-column check | Replace with DB lookup |
| `KanbanProvider.ts` | 7329 | `_advanceSessionsInColumn` | Current-column check | Replace with DB lookup |
| `KanbanProvider.ts` | 7357 | `_advanceSessionsInColumn` | Target column derivation from freshly-pushed event | Keep (see note below) |
| `KanbanProvider.ts` | 7713 | `_sheetToCard` | Column for card | Delete (dead code) |
| `TaskViewerProvider.ts` | 5768 | `_getEffectiveKanbanColumnForSession` | Fallback when DB column empty | Delete (dead code in production) |

#### `KanbanProvider.ts` — `_getEligibleSessionIds` (line 7288)

> **Superseded:** The original plan called this function `_filterSessionsInColumn` at line ~7239.
> **Reason:** The function was renamed or the plan referenced an older version. The actual name is `_getEligibleSessionIds` at line 7288.
> **Replaced with:** Corrected name and line number.

Currently calls `deriveKanbanColumn(events, customAgents)` at line 7303 to check if a session is in the expected column. Replace with a DB lookup: read the plan by sessionId/planId and check `plan.kanbanColumn`.

```
// BEFORE (line 7303):
const currentColumn = deriveKanbanColumn(events, customAgents);
if (currentColumn === expectedColumn) {

// AFTER:
const db = this._getKanbanDb(resolvedWorkspaceRoot);
const plan = await db.getPlanBySessionId(sessionId);
const currentColumn = plan?.kanbanColumn || 'CREATED';
if (currentColumn === expectedColumn) {
```

Note: `_getEligibleSessionIds` already has access to `resolvedWorkspaceRoot` and can obtain the DB instance. The `customAgents` and `log` (session log) variables become unused if this is the only use — check before removing.

#### `KanbanProvider.ts` — `_advanceSessionsInColumn` (line 7312)

Currently calls `deriveKanbanColumn(events, customAgents)` at line 7329 to get the current column. Replace the current-column check with a DB lookup, same pattern as `_getEligibleSessionIds`.

```
// BEFORE (line 7329):
const currentColumn = deriveKanbanColumn(events, customAgents);
if (currentColumn !== expectedColumn) {

// AFTER:
const db = this._getKanbanDb(resolvedWorkspaceRoot);
const plan = await db.getPlanBySessionId(sessionId);
const currentColumn = plan?.kanbanColumn || 'CREATED';
if (currentColumn !== expectedColumn) {
```

**Line 7357 — target column derivation:** This call derives the TARGET column from the updated event log after pushing a workflow event. This is a workflow→column mapping, not a current-column check. `deriveKanbanColumn` scans from the most recent event backwards, and the freshly-pushed event is the last element, so stale events don't affect it. This is a legitimate use — it computes where to move the card, not where the card currently is.

> **Superseded:** The original plan said "The target column derivation (`_nextColumnAfter`) should operate on the DB column, not the events-derived column."
> **Reason:** There is no `_nextColumnAfter` function. The target is derived from the workflow event just pushed, not from the current DB column. `deriveKanbanColumn` here is a workflow→target mapper, not a state checker. Conflating "what column is this card in" with "what column should this card move to" is incorrect — they are different questions.
> **Replaced with:** Keep line 7357 as-is. It is a legitimate use of `deriveKanbanColumn` as a workflow→column mapper. The most-recent-event-wins design protects it from stale events. Optionally, extract the workflow→column mapping into a dedicated function (e.g. `workflowToColumn(workflow, customAgents)`) to make the distinction explicit, but this is a clarification, not a correctness fix.

#### `KanbanProvider.ts` — `_sheetToCard` (line 7711)

**Dead code.** Comprehensive grep across `src/` finds zero callers of `_sheetToCard`. It is defined but never invoked. The board refresh path (`_refreshBoardImpl` at line 4011) already reads `row.kanbanColumn` from the DB directly.

> **Superseded:** The original plan said to "audit all callers of `_sheetToCard` — if any feed the board, replace with DB-sourced column."
> **Reason:** There are no callers. The function is dead code.
> **Replaced with:** Delete `_sheetToCard` (lines 7711-7732). It uses `deriveKanbanColumn` for column determination but is never called, so it poses no risk — but dead code that references a function being removed from other paths is a confusion surface.

#### `TaskViewerProvider.ts` — `_getEffectiveKanbanColumnForSession` (line 5762)

**Dead code in production.** Comprehensive grep finds zero callers in production code. The only reference is in `src/test/review-column-persistence-regression.test.js` (line 28), which checks the source text for the function's existence.

Currently returns `row?.kanbanColumn || derivedColumn` — falls back to `deriveKanbanColumn(events)` when the DB column is empty.

> **Superseded:** The original plan said to "remove the fallback. If `row.kanbanColumn` is empty or missing, return `'CREATED'`."
> **Reason:** The function is dead code in production. Modifying it has no effect on runtime behavior. The only consumer is a test that checks for the function's source text.
> **Replaced with:** Delete `_getEffectiveKanbanColumnForSession` (lines 5762-5770) and update `review-column-persistence-regression.test.js` to remove the reference. If deletion is too aggressive for a single pass, update the fallback to `return this._normalizeLegacyKanbanColumn(row?.kanbanColumn || 'CREATED');` for consistency, but note it has no production effect.

#### `TaskViewerProvider.ts` — `_buildKanbanRecordFromSheet` (line 5793)

Hardcodes `kanbanColumn: 'CREATED'` at line 5834. When `preserveExistingFields = true` (line 5851), the preserved fields list (lines 5858-5866) does NOT include `kanbanColumn`. Add `kanbanColumn: existing.kanbanColumn` to the preserved fields so the record carries the actual DB column, not 'CREATED'.

The ON CONFLICT clause in `UPSERT_PLAN_SQL` (line 935-938) already protects `kanban_column` from being overwritten on upsert (it only updates on deleted→active recovery). This fix is belt-and-suspenders — it prevents confusion and helps debugging, but the SQL already handles the correctness issue.

```
// BEFORE (line 5856-5867):
return {
    ...baseRecord,
    project: existing.project || '',
    projectId: existing.projectId ?? null,
    clickupTaskId: existing.clickupTaskId || '',
    linearIssueId: existing.linearIssueId || '',
    routedTo: existing.routedTo || '',
    dispatchedAgent: existing.dispatchedAgent || '',
    dispatchedIde: existing.dispatchedIde || '',
    worktreeId: existing.worktreeId,
    tags: existing.tags || baseRecord.tags,
};

// AFTER:
return {
    ...baseRecord,
    kanbanColumn: existing.kanbanColumn || 'CREATED',  // ← ADD: carry actual DB column
    project: existing.project || '',
    projectId: existing.projectId ?? null,
    clickupTaskId: existing.clickupTaskId || '',
    linearIssueId: existing.linearIssueId || '',
    routedTo: existing.routedTo || '',
    dispatchedAgent: existing.dispatchedAgent || '',
    dispatchedIde: existing.dispatchedIde || '',
    worktreeId: existing.worktreeId,
    tags: existing.tags || baseRecord.tags,
};
```

## What NOT to change

- **`deriveKanbanColumn` function itself** — leave it in `kanbanColumnDerivation.ts` / `kanbanColumnDerivationImpl.js`. It is still used for target column derivation in `_advanceSessionsInColumn` (line 7357) and by tests. Just stop using it for current-column determination.
- **`plan_events` table** — keep it. It's the activity/audit log. The fix is about not using it as a source of truth for column position, not about removing the event log.
- **`recomputeFeatureColumnFromSubtasks`** — the guard at line 8132 (`if (current !== 'CREATED') return;`) already prevents backward moves. With the DB as the only source of truth, this function becomes less critical, but it's a safety net for the fresh-INSERT case. Leave it.
- **`insertFileDerivedPlan` hardcoding `'CREATED'`** — this only fires on fresh INSERT (row doesn't exist). The ON CONFLICT clause preserves the column for existing rows. With the runsheet override removed, even if a fresh INSERT happens, the recompute will derive from subtask DB columns (which are correct), not from stale runsheet events.

## Complexity Audit

### Routine
- Adding `await this.flushPersist();` after `await this._persist();` in `updateColumnByPlanFileWithReason` — one-line addition, mirrors the existing pattern in cascade functions.
- Adding `kanbanColumn: existing.kanbanColumn` to the preserved fields in `_buildKanbanRecordFromSheet` — one-line addition.
- Deleting dead code (`_sheetToCard`, optionally `_getEffectiveKanbanColumnForSession`).

### Complex / Risky
- Replacing `deriveKanbanColumn(events)` with DB lookups in `_getEligibleSessionIds` (line 7303) and `_advanceSessionsInColumn` (line 7329) — these functions are on the dispatch/advance critical path. The DB lookup adds an async `getPlanBySessionId` call inside a loop. Must verify the DB instance is accessible from these functions (they already have `resolvedWorkspaceRoot`).
- The `flushPersist()` addition to `updateColumnByPlanFileWithReason` forces an immediate disk write on every standalone card move, bypassing the 300ms debounce. This is a performance trade-off: correctness over coalescing. Card moves are low-frequency user actions, not hot paths, so the impact is negligible. The cascade functions already set this precedent.

## Edge-Case & Dependency Audit

### Race Conditions
- **Debounce race (Layer 1):** The primary bug. `_persist()` arms a 300ms timer; if `_reloadIfStale` fires in that window (from a second VS Code window or external mtime change), the stale in-memory image is flushed to disk, clobbering the column write. Fix: `flushPersist()` forces immediate disk write, closing the window. This fix must cover ALL three column-write functions: `cascadeFeatureByPlanId`, `updateColumnWithFeatureCascadeByPlanId`, AND `updateColumnByPlanFileWithReason`.
- **`_reloadIfStale` self-flush:** `_reloadIfStale` (line 6807) calls `flushPersist()` at line 6831 before reloading. This protects the SAME instance's in-memory writes. But a SECOND instance (second window) has its own stale in-memory image — its `flushPersist()` writes the stale state. The fix (flushing after every column write) ensures the disk is authoritative before any second instance can clobber it.
- **`_doPersist` mtime update:** `_doPersist` (line 9641) updates `_loadedMtime` at line 9655 after writing, so `_reloadIfStale` doesn't re-read its own write as an external modification. This is correct and unaffected by the fix.

### Security
- No security implications. All changes are internal column-determination logic.

### Side Effects
- **Disk I/O increase:** `flushPersist()` on every standalone card move bypasses the 300ms debounce. Each call does `db.export()` + atomic tmp-file write + rename. For low-frequency card moves, this is negligible. The cascade functions already do this.
- **Dead code deletion:** Deleting `_sheetToCard` removes an unused function. No runtime effect. Deleting `_getEffectiveKanbanColumnForSession` removes an unused-in-production function — the test file `review-column-persistence-regression.test.js` must be updated.
- **`_advanceSessionsInColumn` target derivation (line 7357):** Keeping `deriveKanbanColumn` here means the function is still imported. The import is not removed — only the current-column-check calls are removed.

### Dependencies & Conflicts
- **Pre-existing working-tree changes in `KanbanProvider.ts`:** The `git diff` shows Fix #2 (subtask fan-out) AND unrelated worktree changes (per-feature worktree mode, `copyWorktreeMergePrompt` refactoring, `cleanupWorktree` simplification). The unrelated changes are not part of this plan and should not be conflated with it.
- **Pre-existing committed changes in `KanbanDatabase.ts`:** Fix #1 for the cascade functions (`cascadeFeatureByPlanId` and `updateColumnWithFeatureCascadeByPlanId`) is already committed. `git diff HEAD` shows no diff for this file. Fix #2 for `updateColumnByPlanFileWithReason` is NOT yet applied — this is the critical remaining change.
- **Test files:** `review-column-persistence-regression.test.js` references `_getEffectiveKanbanColumnForSession` in a source-text check. If the function is deleted, this test must be updated. `kanban-backward-reset-regression.test.js` and `kanbanColumnDerivation.test.ts` test `deriveKanbanColumn` directly — these are unaffected since the function itself is not deleted.

## Dependencies

- None. This plan is self-contained.

## Adversarial Synthesis

Key risks: (1) The debounce race fix must cover `updateColumnByPlanFileWithReason` — the standalone plan path — not just the feature cascade functions; this plan's own stuck state proves the gap. (2) Replacing `deriveKanbanColumn` with DB lookups in `_getEligibleSessionIds` and `_advanceSessionsInColumn` adds async DB calls inside loops on the dispatch critical path — must verify the DB instance is accessible and handle `plan === null` gracefully. (3) Dead code deletion (`_sheetToCard`, `_getEffectiveKanbanColumnForSession`) requires updating the test that references the latter. Mitigations: the `flushPersist()` pattern is already proven in the cascade functions; the DB lookup is a simple `getPlanBySessionId` with a `|| 'CREATED'` fallback; the test update is a one-line change.

## Proposed Changes

### `src/services/KanbanDatabase.ts`

- **Context:** The debounce race in `_persist()` affects all three column-write functions. Two are already fixed (committed). The third — `updateColumnByPlanFileWithReason` — is not.
- **Logic:** Add `await this.flushPersist();` after `await this._persist();` at line 2638.
- **Implementation:** One-line addition, mirroring the existing pattern in `cascadeFeatureByPlanId` (line 6779) and `updateColumnWithFeatureCascadeByPlanId` (line 6714).
- **Edge Cases:** If `flushPersist()` throws (disk full, permission error), the column is still correct in the in-memory DB — the board reads from in-memory. The error is caught by the existing try/catch at line 2639 and returned as `{ ok: false, reason: 'error' }`.

### `src/services/KanbanProvider.ts`

- **Context:** `deriveKanbanColumn` is used in two places for current-column checking (lines 7303, 7329) and one place for target derivation (line 7357). Only the current-column checks should be replaced.
- **Logic:** Replace `deriveKanbanColumn(events, customAgents)` with `db.getPlanBySessionId(sessionId)` → `plan?.kanbanColumn || 'CREATED'` at lines 7303 and 7329.
- **Implementation:** Both functions (`_getEligibleSessionIds`, `_advanceSessionsInColumn`) already have `resolvedWorkspaceRoot`. Obtain the DB instance via `this._getKanbanDb(resolvedWorkspaceRoot)`. The `customAgents` and `log` variables may become partially unused — check before removing.
- **Edge Cases:** If `getPlanBySessionId` returns null (plan not in DB), fall back to `'CREATED'` (the schema default). This matches the current behavior of `deriveKanbanColumn` returning `'CREATED'` for empty events.
- **Dead code:** Delete `_sheetToCard` (lines 7711-7732). Zero callers found.

### `src/services/TaskViewerProvider.ts`

- **Context:** `_getEffectiveKanbanColumnForSession` (line 5762) is dead code in production — zero callers outside tests. `_buildKanbanRecordFromSheet` (line 5793) hardcodes `kanbanColumn: 'CREATED'` and doesn't preserve the existing column.
- **Logic:** Delete `_getEffectiveKanbanColumnForSession` (lines 5762-5770). Add `kanbanColumn: existing.kanbanColumn || 'CREATED'` to the preserved fields in `_buildKanbanRecordFromSheet` (line 5856).
- **Implementation:** The deletion removes the last `deriveKanbanColumn` import usage in this file — check if the import at line 77 can be removed. The preserved-fields addition is a one-line change.
- **Edge Cases:** The test file `src/test/review-column-persistence-regression.test.js` (line 28) checks for the source text of `_getEffectiveKanbanColumnForSession`. If the function is deleted, update the test to remove the reference or change the assertion.

## Verification Plan

### Automated Tests

1. **TypeScript compiles clean** — `npm run compile` (webpack) or `npx tsc --noEmit`.
2. **Existing tests pass** — `npm test` or the project's test runner. Pay attention to:
   - `src/test/review-column-persistence-regression.test.js` — references `_getEffectiveKanbanColumnForSession` in a source-text check. Must be updated if the function is deleted.
   - `src/test/kanban-backward-reset-regression.test.js` — tests `deriveKanbanColumn` directly. Unaffected (function not deleted).
   - `src/services/__tests__/kanbanColumnDerivation.test.ts` — tests `deriveKanbanColumn` directly. Unaffected.
3. **Grep audit:** After changes, `grep -r "deriveKanbanColumn" src/services/` should show:
   - The import in `KanbanProvider.ts` (still needed for line 7357 target derivation).
   - The import in `kanbanColumnDerivation.ts` (the re-export).
   - The definition in `kanbanColumnDerivationImpl.js`.
   - The comment at `KanbanProvider.ts` line 8269 (documentation).
   - Zero calls in current-column-determination paths (lines 7303 and 7329 replaced with DB lookups).

### Goal Invariants

- **Assert** `updateColumnByPlanFileWithReason` in `src/services/KanbanDatabase.ts` contains `await this.flushPersist()` after `await this._persist()` — the standalone plan move path must force immediate disk write.
- **Assert** `cascadeFeatureByPlanId` in `src/services/KanbanDatabase.ts` contains `await this.flushPersist()` after `await this._persist()` — the feature cascade path must force immediate disk write.
- **Assert** `_getEligibleSessionIds` in `src/services/KanbanProvider.ts` does NOT contain a call to `deriveKanbanColumn` — current-column checking must use the DB, not the event log.
- **Assert** `_advanceSessionsInColumn` in `src/services/KanbanProvider.ts` does NOT contain a call to `deriveKanbanColumn` at the current-column check (line 7329) — but the target derivation at line 7357 MAY still call it (legitimate workflow→column mapping).
- **Assert** `_sheetToCard` is absent from `src/services/KanbanProvider.ts` — dead code using `deriveKanbanColumn` for column determination must be removed.
- **Assert** the count of `deriveKanbanColumn(` call expressions in `src/services/KanbanProvider.ts` is exactly 1 (the target derivation at line 7357), down from 4.
- **Assert** the count of `deriveKanbanColumn(` call expressions in `src/services/TaskViewerProvider.ts` is 0, down from 1.

### Manual Test

1. Create a feature with subtasks in PLAN REVIEWED.
2. Drag the feature to LEAD CODED.
3. Confirm the feature AND all subtasks show LEAD CODED on the board.
4. Trigger a board refresh (reload window).
5. Confirm the feature AND all subtasks still show LEAD CODED — no bounce-back.
6. Check `plan_events` for subtasks — each subtask should now have a `move-to-lead-coded` event.
7. **Standalone plan test:** Move a standalone (non-feature) plan from CREATED to PLAN REVIEWED.
8. Trigger a board refresh (reload window).
9. Confirm the plan still shows PLAN REVIEWED — no bounce-back to CREATED.
10. **Regression test:** Drag a subtask backward (LEAD CODED → PLAN REVIEWED). Confirm the subtask moves but the feature stays at LEAD CODED (subtask moves don't drag the feature).

## Pre-existing edits (made during investigation)

### `src/services/KanbanDatabase.ts` — ALREADY COMMITTED

Two `await this.flushPersist();` calls were added after `await this._persist();`:

1. **`cascadeFeatureByPlanId`** (line 6779): Added `await this.flushPersist();` after `await this._persist();` with a comment explaining the debounce race. This implements Fix #1 for this function. **Status: committed** — `git diff HEAD` shows no diff for this file.

2. **`updateColumnWithFeatureCascadeByPlanId`** (line 6714): Added `await this.flushPersist();` after `await this._persist();`. This implements Fix #1 for this function. **Status: committed**.

**NOT YET APPLIED:** `updateColumnByPlanFileWithReason` (line 2638) — the standalone plan move path — still needs `await this.flushPersist();`. This is the critical remaining Fix #2 (renumbered from Fix #1 in the original plan to Fix #2 in this improved version).

### `src/services/KanbanProvider.ts` — IN WORKING TREE

In `moveCardToColumnWithReason` (line 8225):

1. Added `let subtaskKeys: string[] = [];` declaration (line 8238).
2. Added `subtaskKeys = subtasks.map(st => st.sessionId || st.planId).filter(Boolean);` (line 8244).
3. Added a `Promise.allSettled` block (lines 8271-8277) that fans out `recordRunSheetForColumnMove` to subtasks. This implements Fix #3 (subtask event fan-out).

These changes are visible in `git diff src/services/KanbanProvider.ts`. The diff also contains **unrelated worktree changes** (per-feature worktree mode, `copyWorktreeMergePrompt` refactoring, `cleanupWorktree` simplification) that are not part of this plan.

### `src/services/TaskViewerProvider.ts` — NO CHANGES YET

No pre-existing edits. All changes in this file (deleting `_getEffectiveKanbanColumnForSession`, adding `kanbanColumn` to preserved fields in `_buildKanbanRecordFromSheet`) are new work from this plan.
