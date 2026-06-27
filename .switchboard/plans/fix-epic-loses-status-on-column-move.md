# Fix: Epics Lose is_epic Status When Moved Between Columns

## Goal

When an epic card is dragged to a new kanban column, it silently loses its `is_epic = 1` flag in the database and renders as a normal plan card on the next board refresh. This makes the epic badge disappear, breaks subtask cascading on subsequent moves, and orphans the subtask linkage.

> **Current code state (verified 2026-06-27):** Four of the five proposed changes are ALREADY APPLIED in `src/`. The `updateColumnWithEpicCascadeByPlanId` method exists (line 3876, with column-name validation the original plan omitted); all call sites use plan_id-keyed cascade (`moveCardToColumn` line 4842, `moveCardToColumnByPlanFile` line 4908, `completePlan` 6698, `completeSelected` 6724, `completeAll` 6764, `uncompleteCard` 6813/6827); and the `UPSERT_PLAN_SQL` `is_epic` CASE change is applied (line 594). The one un-applied piece (`moveCardToColumn`'s `getPlanBySessionId` → plan_id-first lookup) is INEFFECTIVE as proposed — see Adversarial Synthesis. This plan now documents the applied state, the residual gap, and the dead-code cleanup.

### Root Cause

`updateColumnWithEpicCascade` in `KanbanDatabase.ts` (line 3843) updates the epic's column using `WHERE session_id = ?`:

```sql
UPDATE plans SET kanban_column = ?, updated_at = ? WHERE session_id = ?
```

File-watcher-imported epics have `session_id = ''` (empty string). The query matches zero rows, the column update silently fails, and the `moveCardToColumn` handler at line 4830 reports success because `updateColumnWithEpicCascade` returns `true` (it doesn't check rows-affected).

The parallel path `moveCardToColumnByPlanFile` (line 4900) has a fallback: if `epicSessionId` is empty, it uses `updateColumnByPlanFile` for the epic and `updateColumnTransaction` for subtasks. But `updateColumnTransaction` also uses `WHERE session_id IN (...)` — subtasks imported by the file watcher also have empty `session_id`, so the cascade fails too.

Additionally, the deprecated `moveCardToColumn` path (line 4810) uses `getPlanBySessionId(sessionId)` to detect whether the card is an epic. For file-based plans with empty `session_id`, this lookup returns the wrong record or null, so the `plan.isEpic` check fails and the epic is treated as a normal plan — no cascade, and `db.updateColumn(sessionId, targetColumn)` may update the wrong row.

> **CORRECTION (verified):** `getPlanBySessionId` (KanbanDatabase line 2556-2575) does NOT return null for empty `session_id`. Its first query is `WHERE session_id = ? LIMIT 1` (line 2561). For `session_id = ''` this matches the FIRST arbitrary file-based plan (any plan with empty session_id), returning the WRONG record — not null. Its plan_id fallback is gated behind `if (sessionId)` (line 2567), so empty strings skip the fallback entirely. This is worse than the plan states: it returns a wrong plan, which can then be mis-cascaded or mis-updated.

The `is_epic` clobber happens when `moveCardToColumn` falls through to the non-epic branch and calls `db.updateColumn(sessionId, targetColumn)`. The `updateColumn` method calls `getPlanBySessionId(sessionId)`, which may return a different plan (one that happens to have a matching `session_id`), and then calls `updateColumnByPlanFile` on that wrong plan. The epic's row is never touched, but the board refresh re-reads all rows and the epic still has `is_epic = 1` in the DB — so the clobber must happen elsewhere.

The actual clobber path: when the column move triggers `_refreshBoard`, the board refresh path in `TaskViewerProvider` may call `syncTerminalRegistryWithState` or other registry code that calls `upsertPlans` with records that have `isEpic: 0` or `isEpic: undefined`. The `UPSERT_PLAN_SQL` conflict clause uses `is_epic = COALESCE(excluded.is_epic, is_epic)`, and since `upsertPlans` passes `record.isEpic ?? 0` (line 1283), any upsert that doesn't explicitly set `isEpic: 1` clobbers `is_epic` to `0`.

> **CORRECTION (verified):** This clobber path is now CLOSED — not by the call-site refactors in this plan, but by the `UPSERT_PLAN_SQL` CASE change at line 594 (`is_epic = CASE WHEN excluded.is_epic > 0 THEN excluded.is_epic ELSE plans.is_epic END`), shared with `fix-create-epic-not-setting-is-epic.md`. With that change, `upsertPlans` callers passing `isEpic: 0`/`undefined` (→ literal `0` at line 1283) can no longer clear an existing `is_epic = 1`. The COALESCE path described above no longer exists in the code.

### Background

The `session_id` column is a legacy from when Claude's process session ID was the plan primary key. File-watcher-imported plans set `session_id = ''` because the file has no session ID. The `plan_id` (UUID) is the canonical primary key. All epic move/cascade operations must use `plan_id`, not `session_id`.

## Metadata

**Complexity:** 4
**Tags:** bugfix, backend, database, reliability

## User Review Required

Yes — confirm two cleanups:
1. Whether to delete the now-dead session_id-keyed `updateColumnWithEpicCascade` (line 3843) and `updateColumnTransaction` (line 3821), or keep them as deprecated scaffolding. Leaving them risks a future contributor re-calling the session_id-keyed path and reintroducing this exact bug.
2. Whether to add the early-return guard `if (!sessionId) return false;` to `moveCardToColumn` (the correct residual-gap fix) in addition to the already-applied cascade change.

## Complexity Audit

### Routine
- The plan_id-keyed cascade method and its call-site swaps are mechanical key-field replacements (session_id → plan_id).
- The `UPSERT_PLAN_SQL` one-line conflict-clause change is shared with Plan 1 and already applied.
- Most changes are already in the code; the remaining work is a guard + dead-code cleanup.

### Complex / Risky
- `moveCardToColumn` is called from ~18 sites; an early-return guard on empty `sessionId` changes behavior for any caller that currently passes `''` expecting a no-op vs. a `false`. Must verify no caller relies on the empty-string fallthrough.
- The `getPlanBySessionId` empty-string wrong-row match is a latent footgun across the whole codebase, not just epic moves — any caller passing an empty session_id gets an arbitrary file-based plan. Scope-creep risk if expanded broadly.

## Edge-Case & Dependency Audit

**Race Conditions**
- `updateColumnWithEpicCascadeByPlanId` wraps epic + subtask updates in a single `BEGIN/COMMIT` transaction (line 3889-3901), so the epic and its subtasks move atomically. No intermediate state where the epic moved but subtasks didn't.
- The complete-plan handlers re-fetch the plan via `getPlanByPlanId ?? getPlanBySessionId` (lines 6694, 6720) before cascading — a refresh between the move and the cascade could change subtask membership, but `getSubtasksByEpicId` reads the live DB so the cascade uses current linkage.

**Security**
- `updateColumnWithEpicCascadeByPlanId` validates the target column against `VALID_KANBAN_COLUMNS` / `SAFE_COLUMN_NAME_RE` (line 3883) — custom columns from user config are sanitized. The plan_id values come from DB records, not user input.

**Side Effects**
- Cascading an epic moves ALL its subtasks to the same column (rigid-unit model). If a subtask was intentionally in a different column, the move overrides it. This is the existing design (documented at line 6757-6759), not a regression.
- Integration sync (Linear/ClickUp) fans out for subtasks via `queueIntegrationSyncForSession` (lines 4851-4855, 4915-4920) — uses session_id, which is empty for file-based subtasks, so the sync may no-op for them. Pre-existing behavior, not introduced by this plan.

**Dependencies & Conflicts**
- Shares the `UPSERT_PLAN_SQL` `is_epic` CASE change (line 594) with `fix-create-epic-not-setting-is-epic.md` — already applied once; this is the canonical close of the is_epic-clobber path described in this plan's Root Cause.
- No conflict with `fix-epic-default-column-from-subtasks.md` (file-edit path vs column-move path).

## Dependencies

- `fix-create-epic-not-setting-is-epic.md` — provides the `UPSERT_PLAN_SQL` `is_epic` CASE change (line 594) that actually closes the is_epic-clobber-on-refresh path described in this plan's Root Cause. Already applied.

## Adversarial Synthesis

Key risks: four of five proposed changes are already applied; the fifth (`getPlanByPlanId ?? getPlanBySessionId` in `moveCardToColumn`) is ineffective for the empty-sessionId case it targets — traced: `getPlanByPlanId('')` returns null, falls through to `getPlanBySessionId('')` which matches an arbitrary file-based plan (`WHERE session_id = '' LIMIT 1`), and `getPlanBySessionId`'s own plan_id fallback is gated behind `if (sessionId)` so empty strings skip it. The is_epic clobber was actually closed by the `UPSERT_PLAN_SQL` CASE change (line 594, shared with Plan 1), not the call-site refactors. Mitigations: mark applied changes; replace the ineffective lookup with an early `if (!sessionId) return false;` guard in `moveCardToColumn` (the primary epic caller `markEpicOrchestrating` already routes empty-sessionId epics to `moveCardToColumnByPlanFile`); delete the now-dead session_id-keyed `updateColumnWithEpicCascade`/`updateColumnTransaction` to prevent regression.

## Proposed Changes

### `src/services/KanbanDatabase.ts`

**a. `updateColumnWithEpicCascadeByPlanId` (line 3876) — Status: APPLIED**

New method mirroring `updateColumnWithEpicCascade` but using `plan_id` instead of `session_id`. Already in the code with column-name validation (`VALID_KANBAN_COLUMNS` / `SAFE_COLUMN_NAME_RE` at line 3883) the original plan omitted:

```typescript
public async updateColumnWithEpicCascadeByPlanId(
    epicPlanId: string,
    subtaskPlanIds: string[],
    targetColumn: string
): Promise<boolean> {
    if (!(await this.ensureReady()) || !this._db) return false;
    if (!VALID_KANBAN_COLUMNS.has(targetColumn) && !SAFE_COLUMN_NAME_RE.test(targetColumn)) {
        console.error(`[KanbanDatabase] updateColumnWithEpicCascadeByPlanId rejected invalid column: ${targetColumn}`);
        return false;
    }
    const now = new Date().toISOString();
    try {
        this._db.run('BEGIN');
        this._db.run(
            `UPDATE plans SET kanban_column = ?, updated_at = ? WHERE plan_id = ?`,
            [targetColumn, now, epicPlanId]
        );
        if (subtaskPlanIds.length > 0) {
            const placeholders = subtaskPlanIds.map(() => '?').join(',');
            this._db.run(
                `UPDATE plans SET kanban_column = ?, updated_at = ? WHERE plan_id IN (${placeholders})`,
                [targetColumn, now, ...subtaskPlanIds]
            );
        }
        this._db.run('COMMIT');
        await this._persist();
        return true;
    } catch (err) {
        try { this._db.run('ROLLBACK'); } catch { /* ignore */ }
        console.error('[KanbanDatabase] updateColumnWithEpicCascadeByPlanId failed:', err);
        return false;
    }
}
```

**b. `UPSERT_PLAN_SQL` is_epic clobber (line 594) — Status: APPLIED**

Change the conflict clause from:
```sql
is_epic = COALESCE(excluded.is_epic, is_epic),
```
to:
```sql
is_epic = CASE WHEN excluded.is_epic > 0 THEN excluded.is_epic ELSE plans.is_epic END,
```

This preserves the existing `is_epic` value unless the caller explicitly sets `isEpic: 1`. Callers that want to clear `is_epic` (e.g., `updateEpicStatus`) already use dedicated UPDATE statements, not the upsert path. This is the change that actually closes the is_epic-clobber-on-refresh path in this plan's Root Cause.

**c. Dead-code cleanup (NOT applied — proposed) — Status: PROPOSED**

`updateColumnWithEpicCascade` (line 3843, session_id-keyed) and `updateColumnTransaction` (line 3821, session_id-keyed) now have ZERO live callers (verified by grep across `src/services`). They are marked `@deprecated` but remain. Delete them (or leave with the deprecation marker) to prevent a future contributor from re-calling the session_id-keyed path and reintroducing this bug. User decision required (see User Review Required).

### `src/services/KanbanProvider.ts`

**a. `moveCardToColumn` (line 4819-4863) — cascade: APPLIED (line 4842); lookup: RESIDUAL GAP**

The cascade call is already plan_id-keyed (line 4842):
```typescript
const subtasks = await db.getSubtasksByEpicId(plan.planId);
subtaskSessionIds = subtasks.map(st => st.sessionId).filter(Boolean);
const subtaskPlanIds = subtasks.map(st => st.planId).filter(Boolean) as string[];
moved = await db.updateColumnWithEpicCascadeByPlanId(plan.planId, subtaskPlanIds, targetColumn);
```

The original plan proposed also changing the lookup (line 4830) from `getPlanBySessionId(sessionId)` to `getPlanByPlanId(sessionId) ?? getPlanBySessionId(sessionId)`. **This is NOT applied, and as proposed is INEFFECTIVE** for the empty-sessionId case (see Adversarial Synthesis). The correct residual-gap fix is an early-return guard:

```typescript
// Correct fix (PROPOSED, not applied) — add at the top of moveCardToColumn:
public async moveCardToColumn(
    workspaceRoot: string,
    sessionId: string,
    targetColumn: string
): Promise<boolean> {
    // Empty sessionId matches an arbitrary file-based plan via getPlanBySessionId's
    // `WHERE session_id = '' LIMIT 1`. The primary epic caller (markEpicOrchestrating)
    // already routes empty-sessionId epics to moveCardToColumnByPlanFile; this guard
    // closes the gap for any other caller that passes ''.
    if (!sessionId) return false;
    try {
        const db = this._getKanbanDb(workspaceRoot);
        ...
```

**Why the original proposal fails:** `getPlanByPlanId('')` runs `WHERE plan_id = '' LIMIT 1` → no plan has an empty plan_id → returns null. Then `?? getPlanBySessionId('')` runs `WHERE session_id = '' LIMIT 1` → matches the FIRST arbitrary file-based plan → returns the WRONG plan. The plan_id-first lookup does not prevent the wrong-row match for empty strings.

**Mitigating context:** the primary epic-move caller `markEpicOrchestrating` (line 3215) already guards `if (epic.sessionId) { moveCardToColumn } else if (epic.planFile) { moveCardToColumnByPlanFile }`, so file-based epics never reach `moveCardToColumn` with an empty sessionId through that path. The residual gap is narrow (other callers passing `''`).

**b. `moveCardToColumnByPlanFile` (line 4878-4929) — Status: APPLIED (line 4908)**

Already uses plan_id-keyed cascade:
```typescript
const subtasks = await db.getSubtasksByEpicId(previousRecord.planId);
subtaskSessionIds = subtasks.map(st => st.sessionId).filter(Boolean) as string[];
const subtaskPlanIds = subtasks.map(st => st.planId).filter(Boolean) as string[];
moved = await db.updateColumnWithEpicCascadeByPlanId(previousRecord.planId, subtaskPlanIds, targetColumn);
```

The old `epicSessionId` branching (`if (epicSessionId) { cascade } else { updateColumnByPlanFile + updateColumnTransaction }`) is removed — the `updateColumnTransaction` fallback (which also failed for file-based subtasks) is gone.

**c. Complete-plan handlers (lines 6685-6837) — Status: APPLIED**

All four complete/uncomplete handlers use plan_id-keyed cascade with a plan_id-first lookup:
- `completePlan` (line 6694): `getPlanByPlanId(resolvedSessionId) ?? getPlanBySessionId(resolvedSessionId)` → `updateColumnWithEpicCascadeByPlanId(plan.planId, subtaskPlanIds, 'COMPLETED')` (line 6698)
- `completeSelected` (line 6720): same pattern → cascade (line 6724)
- `completeAll` (line 6762-6764): `getSubtasksByEpicId(card.planId)` → `updateColumnWithEpicCascadeByPlanId(card.planId, subtaskPlanIds, 'COMPLETED')`
- `uncompleteCard` (line 6813 forward, 6827 rollback): `updateColumnWithEpicCascadeByPlanId(epicPlanId, subtaskPlanIds, targetColumn/'COMPLETED')`

```typescript
// completePlan pattern (APPLIED):
const plan = await db.getPlanByPlanId(resolvedSessionId) ?? await db.getPlanBySessionId(resolvedSessionId);
if (plan && plan.isEpic) {
    const subtasks = await db.getSubtasksByEpicId(plan.planId);
    const subtaskPlanIds = subtasks.map(st => st.planId).filter(Boolean) as string[];
    await db.updateColumnWithEpicCascadeByPlanId(plan.planId, subtaskPlanIds, 'COMPLETED');
}
```

**Note on the complete-handler lookup:** `getPlanByPlanId(resolvedSessionId) ?? getPlanBySessionId(resolvedSessionId)` is safe here because `resolvedSessionId = this._resolveSessionId(msg.planId, msg.sessionId)` prefers a non-empty planId when available. If both `msg.planId` and `msg.sessionId` are empty, the same empty-string wrong-row risk exists — but that is a caller-data bug, not a move-path bug, and is out of scope for this plan.

## Verification Plan

> Compilation and automated tests are deferred to the user (run separately). The verification below is manual/observational.

### Automated Tests
- Deferred to user. Suggested coverage if added later: a test that moves a file-based epic (session_id='') to a target column and asserts the epic AND all subtasks move and `is_epic` stays `1`; a regression test that `upsertPlans` with `isEpic: undefined` does not clear `is_epic` after a column move + refresh; a test that `moveCardToColumn(ws, '', col)` returns `false` and does not mutate any row (covers the proposed early-return guard).

### Manual Verification
- Create an epic with subtasks via the board
- Move the epic to PLAN REVIEWED → verify epic AND all subtasks move, epic badge persists
- Move the epic to CODE REVIEWED → same verification
- Move the epic to COMPLETED → same verification
- Move the epic back to CREATED → same verification
- Check DB: `SELECT plan_id, is_epic, kanban_column FROM plans WHERE plan_id = '<epic_id>'` — `is_epic` must be `1` after every move
- **Residual-gap check (if the early-return guard is applied):** attempt a move with an empty session id → must return `false` and touch no rows.
- **Dead-code check (if cleanup is applied):** grep `updateColumnWithEpicCascade\b` and `updateColumnTransaction` — only the `ByPlanId` variant should remain.
