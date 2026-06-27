# Fix: Epics Lose is_epic Status When Epic Files Are Edited (Atomic Write Race)

## Goal

When an epic file is edited (e.g., by the `write` tool, an agent, or any external process that does an atomic write via temp file + rename), the epic temporarily loses its `is_epic = 1` status in the database. The card renders as a normal plan without the epic badge. Closing and reopening the panel restores the epic status.

This also explains why 3 of the 8 epics created in a recent batch had `is_epic = 0` — the `createEpicFromPlanIds` method writes the epic file twice (initial write + `_regenerateEpicFile`), and the second write triggers the same race.

> **Current code state (verified 2026-06-27):** BOTH proposed changes are already applied in `src/`. `GlobalPlanWatcherService.ts` line 617-620 has the unconditional `updateEpicStatus`; `KanbanDatabase.ts` line 594 has the `CASE WHEN excluded.is_epic > 0 ...` conflict clause. This plan now serves as the documented rationale + residual-risk record. The remaining work is the `kanban_column` clobber from the SAME race — tracked in `fix-epic-default-column-from-subtasks.md`.

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

`insertFileDerivedPlan`'s SQL (verified at `KanbanDatabase.ts` lines 1336-1350) does NOT include `is_epic` in its INSERT column list or conflict update set. On conflict (existing row), `is_epic` is preserved. On INSERT (new row), `is_epic` defaults to 0. The race causes an INSERT where an UPDATE was expected.

> **Clarification (verified, not a new requirement):** The same `insertFileDerivedPlan` INSERT also hardcodes `kanban_column = 'CREATED'` (line 1342) and omits `kanban_column` from its ON CONFLICT update set. So the identical race clobbers the epic's `kanban_column` back to `'CREATED'` on re-INSERT. Unlike `is_epic`, `_handlePlanFile` does NOT re-assert `kanban_column`. That clobber is the subject of `fix-epic-default-column-from-subtasks.md` — it is the SAME race, different column.

## Metadata

**Complexity:** 2
**Tags:** bugfix, backend, database, reliability

## User Review Required

Yes — confirm whether the residual `kanban_column` clobber (same race, tracked in the sibling plan) should be folded into this fix or kept separate. Both proposed changes here are already applied; the review is over the residual-risk documentation and the cross-plan dependency, not over new code.

## Complexity Audit

### Routine
- Single-concept race mitigation: make the `updateEpicStatus` call unconditional for files under `.switchboard/epics/`.
- One-line SQL conflict-clause change in a shared upsert constant (`UPSERT_PLAN_SQL`).
- Both changes are localized and idempotent (re-asserting `is_epic = 1` on an already-1 row is a no-op).

### Complex / Risky
- The fix is a **symptomatic** mitigation: the underlying DELETE-during-atomic-write race is still live and clobbers other columns (`kanban_column`, briefly `epic_id`/`project`) on re-INSERT. This plan only closes the `is_epic` vector.
- Brief inconsistency window: between the DELETE and the re-INSERT + `updateEpicStatus`, a concurrent reader (board refresh, `getSubtasksByEpicId`, integration sync) can see a missing row or a row with `is_epic = 0`.

## Edge-Case & Dependency Audit

**Race Conditions**
- The headline race: `_handlePlanDelete` + `_handlePlanFile` both debounced 300ms → concurrent fetch-then-write → DELETE then INSERT with column defaults. Mitigated for `is_epic` only.
- `_handlePlanDelete` re-invokes `_handlePlanFile` at line 706 on certain paths; the unconditional re-assert must remain safe under that re-entrant call (it is — idempotent).

**Security**
- None. No untrusted input reaches the changed paths; `updateEpicStatus` keys on `planId` derived from the filename UUID.

**Side Effects**
- `updateEpicStatus` calls `_persist()` (full DB serialize-to-disk). On rapid epic edits this runs once per debounced flush — acceptable and matches the existing pattern across all DB writes, but not free.
- The `UPSERT_PLAN_SQL` CASE change affects EVERY `upsertPlans` caller globally: any caller that previously relied on `isEpic: 0`/`undefined` clearing `is_epic` via the upsert path can no longer do so. Verified that `is_epic` clearing is owned by `updateEpicStatus(planId, 0, '')` (a dedicated UPDATE), not the upsert path — so no caller loses intended behavior.

**Dependencies & Conflicts**
- Shares the `UPSERT_PLAN_SQL` conflict-clause change with `fix-epic-loses-status-on-column-move.md` (same one-line edit, line 594). Already applied once; both plans must agree it is the canonical location.
- The `kanban_column` clobber from the same race is tracked in `fix-epic-default-column-from-subtasks.md`. Fixing `is_epic` without fixing `kanban_column` leaves the epic visually demoted to `CREATED` on edit even though the badge survives.

## Dependencies

- `fix-epic-default-column-from-subtasks.md` — same atomic-write race, different clobbered column (`kanban_column`). Should be implemented together to close the race for both vectors.
- `fix-epic-loses-status-on-column-move.md` — shares the `UPSERT_PLAN_SQL` `is_epic` CASE change (line 594); already applied.

## Adversarial Synthesis

Key risks: the unconditional `updateEpicStatus` closes the `is_epic` clobber but leaves the underlying atomic-write DELETE→re-INSERT race live, which clobbers `kanban_column` to `'CREATED'` (see sibling plan) and briefly drops the row for concurrent readers. The `UPSERT_PLAN_SQL` CASE change is already applied in code (line 594) — the original plan's "Still needed" label was stale and is corrected here. Mitigations: keep the unconditional re-assert (applied, correct); add a null guard on `updatedRecord` construction; treat the `kanban_column` clobber as a sibling plan rather than scope-creeping this one.

## Proposed Changes

### `src/services/GlobalPlanWatcherService.ts` — `_handlePlanFile` (existing-record branch, line 609-620)

**Status: APPLIED.** Changed the conditional `updateEpicStatus` call to unconditional for epic files:

```typescript
// Before:
if (relativePath.startsWith('.switchboard/epics/') && !plan.isEpic) {
    await db.updateEpicStatus(plan.planId, 1, '');
    updatedRecord.isEpic = 1;
}

// After (APPLIED at lines 610-620):
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

**Residual edge case (not yet applied):** `updatedRecord` is built by spreading `plan` (line 601-608) in the existing-record branch, which is only reached when `plan` is non-null. The new-record branch (line 577-580) already has its own unconditional `updateEpicStatus`. A defensive null guard (`if (!plan) return;` before constructing `updatedRecord`) is belt-and-suspenders but not strictly required given the branch structure — note for the implementer.

### `src/services/KanbanDatabase.ts` — `UPSERT_PLAN_SQL` (line 592-594)

**Status: APPLIED (line 594).** The original plan labeled this "Still needed"; verified it is already in the code. Change the `is_epic` conflict clause from COALESCE to a preserve-unless-explicit pattern:

```sql
-- Before:
is_epic = COALESCE(excluded.is_epic, is_epic),

-- After (APPLIED at line 594):
is_epic = CASE WHEN excluded.is_epic > 0 THEN excluded.is_epic ELSE plans.is_epic END,
```

This prevents `upsertPlans` from clobbering `is_epic` to 0 when callers pass `isEpic: 0` or `isEpic: undefined` (which becomes `0` via `record.isEpic ?? 0` at line 1283). `COALESCE(0, 1)` returns `0`; the CASE expression preserves the existing value. Callers that need to clear `is_epic` use `updateEpicStatus(planId, 0, '')` (a dedicated UPDATE), not the upsert path.

## Verification Plan

> Compilation and automated tests are deferred to the user (run separately). The verification below is manual/observational.

### Automated Tests
- Deferred to user. No unit/integration/e2e tests are run as part of this plan session. Suggested coverage if added later: a watcher test that simulates an atomic write (temp+rename) of an epic file and asserts `is_epic = 1` persists without a panel reopen; a regression test that `upsertPlans` with `isEpic: undefined` does not clear an existing `is_epic = 1`.

### Manual Verification
- Edit an epic file with an external tool that does atomic writes → epic badge must persist on the board without panel reopen
- Edit an epic file in-place → epic badge must persist
- Create an epic via `create-epic.js` → `is_epic = 1` immediately and after board refresh
- Rapidly edit 3 epic files in succession → all 3 must have `is_epic = 1` after all edits complete
- Check DB after edits: `SELECT plan_id, is_epic FROM plans WHERE plan_id = '<epic_id>'` — must be `1`
- **Residual check (expected to still fail until the sibling plan lands):** after an atomic-write edit, confirm `kanban_column` is NOT clobbered to `'CREATED'`. If it is, that is the `fix-epic-default-column-from-subtasks.md` scope, not a regression of this fix.
