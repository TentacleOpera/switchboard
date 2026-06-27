# Fix: Epics Lose is_epic Status When Epic Files Are Edited (Atomic Write Race)

## Goal

When an epic file is edited (e.g., by the `write` tool, an agent, or any external process that does an atomic write via temp file + rename), the epic temporarily loses its `is_epic = 1` status in the database. The card renders as a normal plan without the epic badge. Closing and reopening the panel restores the epic status.

This also explains why 3 of the 8 epics created in a recent batch had `is_epic = 0` — the `createEpicFromPlanIds` method writes the epic file twice (initial write + `_regenerateEpicFile`), and the second write triggers the same race.

### Root Cause

**Race condition between `_handlePlanDelete` and `_handlePlanFile` in `GlobalPlanWatcherService.ts` during atomic writes.**

When a file is saved atomically (temp file + rename), both the VS Code file watcher and the native `fs.watch` watcher fire events:
- A delete event (old file removed)
- A create/change event (new file appears)

Both events are debounced with 300ms. After 300ms, both `_handlePlanDelete` and `_handlePlanFile` fire concurrently.

The race:

1. Both `_handlePlanDelete` and `_handlePlanFile` call `getPlanByPlanFile` concurrently — **both see the existing row with `is_epic = 1`**
2. `_handlePlanDelete` runs first → `deletePlanByPlanFile` deletes the DB row
3. `_handlePlanFile` continues → `insertFileDerivedPlan` runs. Since the row was just deleted, this does an **INSERT** (not an UPDATE). `insertFileDerivedPlan`'s SQL does NOT include `is_epic` in its INSERT column list, so the new row gets `is_epic = 0` (column default).
4. `_handlePlanFile` checks `if (relativePath.startsWith('.switchboard/epics/') && !plan.isEpic)` — but `plan` was fetched in step 1 when `is_epic` was still `1`, so `plan.isEpic` is truthy. The check is **false**. `updateEpicStatus` is **NOT called**.
5. The new row stays with `is_epic = 0` → card renders without epic badge

On panel reopen, `triggerScan` runs → `_handlePlanFile` fires again → this time `getPlanByPlanFile` returns the row with `is_epic = 0` → `!plan.isEpic` is **true** → `updateEpicStatus` is called → `is_epic = 1` → epic badge restored.

### Background

The `_recentRenames` set (line 32) is supposed to prevent delete events during renames, but it's only populated by `registerRename` — which is called for explicit extension-initiated renames, NOT for atomic writes by external tools. So the delete event from an atomic write is NOT suppressed.

`insertFileDerivedPlan`'s SQL (line 1334-1348) does NOT include `is_epic` in its column list or conflict update set. On conflict (existing row), `is_epic` is preserved. On INSERT (new row), `is_epic` defaults to 0. The race causes an INSERT where an UPDATE was expected.

## Metadata

**Complexity:** 2
**Tags:** bugfix, backend, database, kanban, epic, race-condition

## Files to Modify

### 1. `src/services/GlobalPlanWatcherService.ts` — `_handlePlanFile` (line 610)

**Already fixed.** Changed the conditional `updateEpicStatus` call to unconditional for epic files:

```typescript
// Before (line 610):
if (relativePath.startsWith('.switchboard/epics/') && !plan.isEpic) {
    await db.updateEpicStatus(plan.planId, 1, '');
    updatedRecord.isEpic = 1;
}

// After:
// Always assert is_epic=1 for epic files. The conditional check on
// !plan.isEpic is unsafe: plan was fetched before insertFileDerivedPlan,
// and a concurrent _handlePlanDelete (from an atomic write: temp+rename)
// can delete the row between the fetch and the insert. insertFileDerivedPlan
// then INSERTs a fresh row with is_epic=0 (column default), but the stale
// plan.isEpic=1 skips updateEpicStatus — leaving the new row stuck at 0.
// Unconditional update is idempotent and cheap.
if (relativePath.startsWith('.switchboard/epics/')) {
    await db.updateEpicStatus(updatedRecord.planId, 1, '');
    updatedRecord.isEpic = 1;
}
```

Also changed `plan.planId` to `updatedRecord.planId` — `plan` is the stale pre-fetch, `updatedRecord` has the correct `planId` derived from the filename UUID.

### 2. `src/services/KanbanDatabase.ts` — `UPSERT_PLAN_SQL` (line 592)

**Still needed.** Change the `is_epic` conflict clause from COALESCE to a preserve-unless-explicit pattern:

```sql
-- Before:
is_epic = COALESCE(excluded.is_epic, is_epic),

-- After:
is_epic = CASE WHEN excluded.is_epic > 0 THEN excluded.is_epic ELSE plans.is_epic END,
```

This prevents `upsertPlans` from clobbering `is_epic` to 0 when callers pass `isEpic: 0` or `isEpic: undefined` (which becomes `0` via `record.isEpic ?? 0` at line 1281). `COALESCE(0, 1)` returns `0`; the CASE expression preserves the existing value.

## Verification

- Edit an epic file with an external tool that does atomic writes → epic badge must persist on the board without panel reopen
- Edit an epic file in-place → epic badge must persist
- Create an epic via `create-epic.js` → `is_epic = 1` immediately and after board refresh
- Rapidly edit 3 epic files in succession → all 3 must have `is_epic = 1` after all edits complete
- Check DB after edits: `SELECT plan_id, is_epic FROM plans WHERE plan_id = '<epic_id>'` — must be `1`
