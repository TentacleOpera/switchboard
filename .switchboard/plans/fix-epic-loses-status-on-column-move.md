# Fix: Epics Lose is_epic Status When Moved Between Columns

## Goal

When an epic card is dragged to a new kanban column, it silently loses its `is_epic = 1` flag in the database and renders as a normal plan card on the next board refresh. This makes the epic badge disappear, breaks subtask cascading on subsequent moves, and orphans the subtask linkage.

### Root Cause

`updateColumnWithEpicCascade` in `KanbanDatabase.ts` (line 3826) updates the epic's column using `WHERE session_id = ?`:

```sql
UPDATE plans SET kanban_column = ?, updated_at = ? WHERE session_id = ?
```

File-watcher-imported epics have `session_id = ''` (empty string). The query matches zero rows, the column update silently fails, and the `moveCardToColumn` handler at line 4830 reports success because `updateColumnWithEpicCascade` returns `true` (it doesn't check rows-affected).

The parallel path `moveCardToColumnByPlanFile` (line 4900) has a fallback: if `epicSessionId` is empty, it uses `updateColumnByPlanFile` for the epic and `updateColumnTransaction` for subtasks. But `updateColumnTransaction` also uses `WHERE session_id IN (...)` — subtasks imported by the file watcher also have empty `session_id`, so the cascade fails too.

Additionally, the deprecated `moveCardToColumn` path (line 4810) uses `getPlanBySessionId(sessionId)` to detect whether the card is an epic. For file-based plans with empty `session_id`, this lookup returns the wrong record or null, so the `plan.isEpic` check fails and the epic is treated as a normal plan — no cascade, and `db.updateColumn(sessionId, targetColumn)` may update the wrong row.

The `is_epic` clobber happens when `moveCardToColumn` falls through to the non-epic branch and calls `db.updateColumn(sessionId, targetColumn)`. The `updateColumn` method calls `getPlanBySessionId(sessionId)`, which may return a different plan (one that happens to have a matching `session_id`), and then calls `updateColumnByPlanFile` on that wrong plan. The epic's row is never touched, but the board refresh re-reads all rows and the epic still has `is_epic = 1` in the DB — so the clobber must happen elsewhere.

The actual clobber path: when the column move triggers `_refreshBoard`, the board refresh path in `TaskViewerProvider` may call `syncTerminalRegistryWithState` or other registry code that calls `upsertPlans` with records that have `isEpic: 0` or `isEpic: undefined`. The `UPSERT_PLAN_SQL` conflict clause uses `is_epic = COALESCE(excluded.is_epic, is_epic)`, and since `upsertPlans` passes `record.isEpic ?? 0` (line 1281), any upsert that doesn't explicitly set `isEpic: 1` clobbers `is_epic` to `0`.

### Background

The `session_id` column is a legacy from when Claude's process session ID was the plan primary key. File-watcher-imported plans set `session_id = ''` because the file has no session ID. The `plan_id` (UUID) is the canonical primary key. All epic move/cascade operations must use `plan_id`, not `session_id`.

## Metadata

**Complexity:** 4
**Tags:** bugfix, backend, database, kanban, epic

## Files to Modify

### 1. `src/services/KanbanDatabase.ts`

**a. Add `updateColumnWithEpicCascadeByPlanId`** — new method mirroring `updateColumnWithEpicCascade` but using `plan_id` instead of `session_id`:

```typescript
public async updateColumnWithEpicCascadeByPlanId(
    epicPlanId: string,
    subtaskPlanIds: string[],
    targetColumn: string
): Promise<boolean> {
    if (!(await this.ensureReady()) || !this._db) return false;
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

**b. Fix `UPSERT_PLAN_SQL` is_epic clobber** — change the conflict clause from:
```sql
is_epic = COALESCE(excluded.is_epic, is_epic),
```
to:
```sql
is_epic = CASE WHEN excluded.is_epic > 0 THEN excluded.is_epic ELSE plans.is_epic END,
```

This preserves the existing `is_epic` value unless the caller explicitly sets `isEpic: 1`. Callers that want to clear `is_epic` (e.g., `updateEpicStatus`) already use dedicated UPDATE statements, not the upsert path.

### 2. `src/services/KanbanProvider.ts`

**a. `moveCardToColumn` (line ~4810)** — replace `getPlanBySessionId(sessionId)` with `getPlanByPlanId` or `getPlanByPlanFile`. Use `plan_id` for the epic cascade:

```typescript
// Before:
const plan = await db.getPlanBySessionId(sessionId);
if (plan && plan.isEpic) {
    const subtasks = await db.getSubtasksByEpicId(plan.planId);
    subtaskSessionIds = subtasks.map(st => st.sessionId).filter(Boolean);
    moved = await db.updateColumnWithEpicCascade(sessionId, subtaskSessionIds, targetColumn);
}

// After:
const plan = await db.getPlanByPlanId(sessionId) ?? await db.getPlanBySessionId(sessionId);
if (plan && plan.isEpic) {
    const subtasks = await db.getSubtasksByEpicId(plan.planId);
    const subtaskPlanIds = subtasks.map(st => st.planId).filter(Boolean) as string[];
    moved = await db.updateColumnWithEpicCascadeByPlanId(plan.planId, subtaskPlanIds, targetColumn);
}
```

**b. `moveCardToColumnByPlanFile` (line ~4900)** — replace the cascade call:

```typescript
// Before:
const epicSessionId = previousRecord.sessionId || '';
if (epicSessionId) {
    moved = await db.updateColumnWithEpicCascade(epicSessionId, subtaskSessionIds, targetColumn);
} else {
    moved = await db.updateColumnByPlanFile(planFile, workspaceId, targetColumn);
    if (moved && subtaskSessionIds.length > 0) {
        await db.updateColumnTransaction(subtaskSessionIds, targetColumn);
    }
}

// After:
const subtaskPlanIds = subtasks.map(st => st.planId).filter(Boolean) as string[];
moved = await db.updateColumnWithEpicCascadeByPlanId(previousRecord.planId, subtaskPlanIds, targetColumn);
```

**c. Complete-plan handler (line ~6748)** — same fix: use `plan_id` cascade:

```typescript
// Before:
const subtaskSessionIds = subtasks.map(st => st.sessionId).filter(Boolean);
await dbAll.updateColumnWithEpicCascade(cardKey, subtaskSessionIds, 'COMPLETED');

// After:
const subtaskPlanIds = subtasks.map(st => st.planId).filter(Boolean) as string[];
await dbAll.updateColumnWithEpicCascadeByPlanId(card.planId, subtaskPlanIds, 'COMPLETED');
```

## Verification

- Create an epic with subtasks via the board
- Move the epic to PLAN REVIEWED → verify epic AND all subtasks move, epic badge persists
- Move the epic to CODE REVIEWED → same verification
- Move the epic to COMPLETED → same verification
- Move the epic back to CREATED → same verification
- Check DB: `SELECT plan_id, is_epic, kanban_column FROM plans WHERE plan_id = '<epic_id>'` — `is_epic` must be `1` after every move
