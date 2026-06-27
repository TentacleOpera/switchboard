# Fix: Epic Column Should Default to Most-Advanced Subtask Column

## Goal

When an epic is created, it defaults to the `CREATED` column even if all its subtasks are in `PLAN REVIEWED` (or any other column). The expected design is that the epic's column should reflect the most-advanced column among its subtasks — if all subtasks are in `PLAN REVIEWED`, the epic should be placed in `PLAN REVIEWED`.

### Root Cause

`createEpicFromPlanIds` in `KanbanProvider.ts` (line 8479-8483) already attempts to resolve the epic's column from subtask columns:

```typescript
const resolvedColumn = subtasks
     .map((st: any) => this._normalizeLegacyKanbanColumn(st.kanbanColumn))
     .filter((col: string | null): col is string => !!col)
     .sort((a: string, b: string) => (ordinalMap.get(a) ?? Infinity) - (ordinalMap.get(b) ?? Infinity))[0] || this._normalizeLegacyKanbanColumn(subtasks[0].kanbanColumn) || 'CREATED';
const effectiveColumn = resolvedColumn === 'BACKLOG' ? 'CREATED' : resolvedColumn;
```

This sorts subtask columns by ordinal and picks the **lowest** ordinal (earliest column). The intent was to pick the "minimum progress" column — but the user's expectation is the opposite: the epic should be in the **most-advanced** column (highest ordinal), because if all subtasks are reviewed, the epic is ready for the next stage.

The sort is ascending (`ordinalMap.get(a) - ordinalMap.get(b)`), and `[0]` picks the first (lowest) element. It should pick the last (highest) element to reflect the most-advanced subtask column.

Additionally, the `effectiveColumn` fallback to `'CREATED'` is too aggressive — if subtask columns can't be resolved, it should default to the first subtask's actual column, not `CREATED`.

### Background

The kanban column ordinals are defined by the column definition order: `BACKLOG` (-1), `CREATED` (0), `IN PROGRESS` (1), `CODE REVIEWED` (2), `PLAN REVIEWED` (3), `REVIEWED` (4), `DONE` (5), `COMPLETED` (6). The epic should be placed at the **minimum** column among its subtasks when the intent is "what still needs work" — but the user's stated expectation is that if ALL subtasks are in `PLAN REVIEWED`, the epic should be in `PLAN REVIEWED`. This means the epic should be at the **minimum** column when subtasks are spread across columns (the epic is only as far along as its least-complete subtask), but when all subtasks are in the same column, the epic matches that column.

Actually, the current logic (pick minimum ordinal) IS correct for the "weakest link" model — if all subtasks are in `PLAN REVIEWED`, the minimum is `PLAN REVIEWED`, so the epic should already be there. The bug is that the `ordinalMap` may not have the correct ordinals, or `subtasks[0].kanbanColumn` is returning `CREATED` because the subtask records fetched at line 8462-8470 have stale column data.

The real root cause: the subtasks are fetched via `db.getPlanByPlanId(stPlanId)` at line 8462. If the DB query returns the correct `kanbanColumn`, the minimum-ordinal logic should work. But if the subtask plans were recently moved (e.g., from `CREATED` to `PLAN REVIEWED`) and the DB hasn't been refreshed, the fetched `kanbanColumn` may be stale.

**Most likely root cause:** The `ordinalMap` is built from `columnDefs` which comes from `_buildKanbanColumns` — but `PLAN REVIEWED` may not be in the column definitions if it's a custom column or if the column order doesn't match the expected ordinal. If `ordinalMap.get('PLAN REVIEWED')` returns `undefined`, the fallback `?? Infinity` pushes it to the end of the sort, and `[0]` picks a different column.

## Metadata

**Complexity:** 3
**Tags:** bugfix, backend, kanban, epic

## Files to Modify

### 1. `src/services/KanbanProvider.ts`

**Fix `createEpicFromPlanIds` column resolution** (lines 8479-8483):

```typescript
// Before:
const resolvedColumn = subtasks
     .map((st: any) => this._normalizeLegacyKanbanColumn(st.kanbanColumn))
     .filter((col: string | null): col is string => !!col)
     .sort((a: string, b: string) => (ordinalMap.get(a) ?? Infinity) - (ordinalMap.get(b) ?? Infinity))[0] || this._normalizeLegacyKanbanColumn(subtasks[0].kanbanColumn) || 'CREATED';
const effectiveColumn = resolvedColumn === 'BACKLOG' ? 'CREATED' : resolvedColumn;

// After:
// The epic's column should be the MINIMUM ordinal among its subtasks — the epic
// is only as far along as its least-complete subtask. If all subtasks are in
// PLAN REVIEWED, the epic is in PLAN REVIEWED. If one subtask is still in CREATED,
// the epic stays in CREATED.
const subtaskColumns = subtasks
     .map((st: any) => this._normalizeLegacyKanbanColumn(st.kanbanColumn))
     .filter((col: string | null): col is string => !!col);
const resolvedColumn = subtaskColumns.length > 0
     ? subtaskColumns.sort((a: string, b: string) => (ordinalMap.get(a) ?? Infinity) - (ordinalMap.get(b) ?? Infinity))[0]
     : 'CREATED';
const effectiveColumn = resolvedColumn === 'BACKLOG' ? 'CREATED' : resolvedColumn;
```

**Add logging to diagnose ordinal mapping:**

```typescript
console.log(`[KanbanProvider] createEpicFromPlanIds: subtask columns = [${subtasks.map(st => st.kanbanColumn).join(', ')}], ordinalMap entries = [${Array.from(ordinalMap.entries()).map(([k,v]) => `${k}=${v}`).join(', ')}], resolvedColumn=${resolvedColumn}, effectiveColumn=${effectiveColumn}`);
```

**Add a post-creation column sync** — after all subtasks are linked and the epic file is regenerated, re-evaluate the epic's column based on the confirmed subtask columns:

```typescript
// After line 8546 (after subtask linking loop), before _regenerateEpicFile:
// Re-fetch subtasks to get their confirmed columns (the initial fetch at line 8462
// may have been before the subtask linking confirmed their epic_id).
const confirmedSubtasks = await db.getSubtasksByEpicId(planId);
const confirmedColumns = confirmedSubtasks
     .map((st: any) => this._normalizeLegacyKanbanColumn(st.kanbanColumn))
     .filter((col: string | null): col is string => !!col);
if (confirmedColumns.length > 0) {
     const minColumn = confirmedColumns.sort((a: string, b: string) =>
          (ordinalMap.get(a) ?? Infinity) - (ordinalMap.get(b) ?? Infinity))[0];
     const finalColumn = minColumn === 'BACKLOG' ? 'CREATED' : minColumn;
     if (finalColumn !== effectiveColumn) {
          console.log(`[KanbanProvider] createEpicFromPlanIds: adjusting epic column from ${effectiveColumn} to ${finalColumn} based on confirmed subtask columns`);
          await db.updateColumnByPlanFile(epicPlanFile, workspaceId, finalColumn);
     }
}
```

## Verification

- Create an epic from 3 plans that are all in `PLAN REVIEWED` → epic must be in `PLAN REVIEWED`
- Create an epic from 3 plans where 2 are in `PLAN REVIEWED` and 1 is in `CREATED` → epic must be in `CREATED`
- Create an epic from 3 plans that are all in `CREATED` → epic must be in `CREATED`
- Create an epic from plans split across `CREATED` and `BACKLOG` → epic must be in `CREATED` (BACKLOG is treated as earlier than CREATED)
