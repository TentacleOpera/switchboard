# Fix: create-epic Endpoint Fails to Set is_epic=1 on Some Created Epics

## Goal

When creating epics via the `create-epic.js` script (or the `/kanban/epic` API endpoint), some epics end up with `is_epic = 0` in the database, rendering them as normal plan cards instead of epic cards. This happened for 3 of the 8 epics created in a recent batch.

### Root Cause

`createEpicFromPlanIds` in `KanbanProvider.ts` (line 8442) creates the epic via `db.upsertPlan()` at line 8503, passing `isEpic: 1`. It then writes the epic file at line 8541, which triggers the file watcher. The file watcher calls `insertFileDerivedPlan` which does an `INSERT ... ON CONFLICT DO UPDATE` — but its conflict clause does NOT touch `is_epic`, so `is_epic` should survive.

However, after the subtask linking loop (lines 8542-8545), the code calls `_regenerateEpicFile` (line 8547), which writes the file again. This second write triggers the file watcher again. The watcher's `_handlePlanFile` in `GlobalPlanWatcherService.ts` (line 601-613) calls `insertFileDerivedPlan` with the updated record. For existing plans, it spreads `...plan` (the existing DB record) and updates only `topic`, `complexity`, `tags`, `project`, `updatedAt`. Since `plan.isEpic` is read from the DB and should be `1`, the spread should preserve it.

The actual clobber path: `insertFileDerivedPlan`'s SQL (line 1334-1348) does NOT include `is_epic` in its column list or conflict update set. So on conflict, `is_epic` is left untouched. This is correct behavior.

The real issue is a **race condition**: the `upsertPlan` call at line 8503 and the subsequent `updateEpicStatus` calls for subtasks (line 8545) and the final re-assert at line 8551 all use `updateEpicStatus`, which does `UPDATE plans SET is_epic = ?, epic_id = ?, updated_at = ? WHERE plan_file = ? AND workspace_id = ?`. If the file watcher's `insertFileDerivedPlan` runs between the `upsertPlan` (which sets `is_epic = 1`) and the `updateEpicStatus` re-assert, the watcher's INSERT...ON CONFLICT may not touch `is_epic`, but the `upsertPlan`'s own conflict clause uses `is_epic = COALESCE(excluded.is_epic, is_epic)` — and if the watcher triggers a re-upsert through a different code path that passes `isEpic: 0` or `isEpic: undefined`, the COALESCE treats `0` as a valid value (not NULL) and clobbers `is_epic` to `0`.

The defensive re-assert at line 8551 (`await db.updateEpicStatus(planId, 1, '')`) is meant to fix this, but it runs BEFORE `_refreshBoard`. If `_refreshBoard` triggers another file scan that re-upserts the epic record with `isEpic: 0`, the re-assert is undone.

Additionally, the `create-epic.js` script routes through the `/kanban/epic` endpoint, which calls `createEpicFromPlanIds`. The method returns `{ success: true }` even if the `is_epic` flag was clobbered after the verify check — there is no post-refresh verification.

### Background

The `UPSERT_PLAN_SQL` conflict clause at line 592 uses:
```sql
is_epic = COALESCE(excluded.is_epic, is_epic),
```

`COALESCE` returns the first non-NULL value. Since `upsertPlans` passes `record.isEpic ?? 0` (line 1281), `excluded.is_epic` is `0` (not NULL) when `isEpic` is not explicitly set. `COALESCE(0, 1)` returns `0`, clobbering the existing `is_epic = 1` to `0`.

## Metadata

**Complexity:** 3
**Tags:** bugfix, backend, database, kanban, epic

## Files to Modify

### 1. `src/services/KanbanDatabase.ts`

**Fix the UPSERT_PLAN_SQL conflict clause** — change `is_epic` from COALESCE to a preserve-unless-explicit pattern:

```sql
-- Before:
is_epic = COALESCE(excluded.is_epic, is_epic),

-- After:
is_epic = CASE WHEN excluded.is_epic > 0 THEN excluded.is_epic ELSE plans.is_epic END,
```

This preserves the existing `is_epic` value unless the caller explicitly sets `isEpic: 1`. Callers that want to clear `is_epic` (e.g., `updateEpicStatus` with `isEpic: 0`) already use dedicated UPDATE statements, not the upsert path.

### 2. `src/services/KanbanProvider.ts`

**Add post-refresh verification in `createEpicFromPlanIds`** — after `_refreshBoard`, re-check `is_epic` and re-assert if clobbered:

```typescript
// After line 8554 (after _refreshBoard):
await this._refreshBoard(workspaceRoot);
// Post-refresh re-assert: the refresh may have triggered file watcher re-imports
// that clobber is_epic. Verify and fix.
const postRefreshEpic = await db.getPlanByPlanId(planId);
if (!postRefreshEpic || !postRefreshEpic.isEpic) {
    console.warn(`[KanbanProvider] createEpicFromPlanIds: is_epic clobbered after refresh, re-asserting`);
    await db.updateEpicStatus(planId, 1, '');
    await this._refreshBoard(workspaceRoot);
}
return { success: true, epicPlanId: planId, epicSessionId: sessionId };
```

## Verification

- Create an epic via `node .agents/skills/kanban_operations/create-epic.js`
- Check DB: `SELECT is_epic FROM plans WHERE plan_id = '<epic_id>'` — must be `1`
- Refresh the kanban board — verify the epic badge appears
- Check DB again after refresh — `is_epic` must still be `1`
- Create 3 epics in rapid succession — all 3 must have `is_epic = 1`
