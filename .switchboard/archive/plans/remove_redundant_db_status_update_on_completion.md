# Remove Redundant DB Status Update on Completion

## Goal

Remove the redundant `db.updateStatus(sessionId, 'completed')` call at line 12377. The status is already updated by `_updatePlanRegistryStatus(sessionId, 'completed')` at line 12352 (which calls `db.updateStatus` internally) and by KanbanProvider's DB-first update at line 4795.

## Metadata

- **Tags:** frontend, code-hygiene, performance
- **Complexity:** 1

## User Review Required

No

## Complexity Audit

### Routine

- Single-file change (`TaskViewerProvider.ts`).
- Remove one redundant line.
- No logic changes.

### Complex / Risky

- None. The status is already updated by two other sources; removing the third has no functional impact.

## Edge-Case & Dependency Audit

- **Race Conditions**: None.
- **Security**: No security implications; changes are localized to completion flow.
- **Side Effects**: None — only reduces redundant DB writes.
- **Dependencies & Conflicts**: None.

## Dependencies

None

## Adversarial Synthesis

Key risk: If `_updatePlanRegistryStatus` fails to call `db.updateStatus` (e.g., if the DB is unavailable), the explicit `db.updateStatus` at line 12377 would be a fallback. However, `_updatePlanRegistryStatus` already has error handling (it logs a warning and returns if the entry isn't found). If the DB is unavailable, both calls would fail. The explicit `db.updateStatus` provides no additional reliability.

Furthermore, KanbanProvider's DB-first update at line 4795 runs BEFORE `_handleCompletePlan` is called. So even if `_handleCompletePlan` fails to update the status, the status is already correct from KanbanProvider's update.

## Proposed Changes

### `src/services/TaskViewerProvider.ts`

#### `_handleCompletePlan` (line ~12374)

- **Context**: Line 12377 calls `db.updateStatus(sessionId, 'completed')`. This is redundant because:
  1. KanbanProvider's DB-first update at line 4795 already called `db.updateStatus(sessionId, 'completed')` BEFORE `_handleCompletePlan` ran.
  2. `_updatePlanRegistryStatus(sessionId, 'completed')` at line 12352 also calls `db.updateStatus(sessionId, 'completed')` internally (line 9306-9308).
- **Logic**: Remove the redundant `db.updateStatus(sessionId, 'completed')` at line 12377. Keep `db.updateColumn(sessionId, 'COMPLETED')` at line 12378 (this is NOT redundant — `_updatePlanRegistryStatus` only updates status, not column).
- **Implementation**:

```typescript
// Before (lines 12374-12378):
const db = await this._getKanbanDb(resolvedWorkspaceRoot);
if (db) {
    await db.updateStatus(sessionId, 'completed');
    await db.updateColumn(sessionId, 'COMPLETED');
}

// After:
const db = await this._getKanbanDb(resolvedWorkspaceRoot);
if (db) {
    await db.updateColumn(sessionId, 'COMPLETED');
}
```

## Verification Plan

### Manual Tests

1. Complete a managed-import plan.
2. **Expected**: Card animates to COMPLETED; status field in DB is 'completed'; column field in DB is 'COMPLETED'.
3. Complete a brain plan (non-managed-import).
4. **Expected**: Card animates to COMPLETED; status field in DB is 'completed'; column field in DB is 'COMPLETED'.
5. Complete a local plan (no brainSourcePath).
6. **Expected**: Card animates to COMPLETED; status field in DB is 'completed'; column field in DB is 'COMPLETED'.

## Files to Modify

1. `src/services/TaskViewerProvider.ts`
   - `_handleCompletePlan` — remove redundant `db.updateStatus(sessionId, 'completed')` at line 12377

## Risks

- **Very low**: The status is already updated by two other sources (KanbanProvider's DB-first update and `_updatePlanRegistryStatus`). Removing the third redundant call has no functional impact. The column update is still performed explicitly.

---

**Recommendation:** Send to Coder. Complexity is 1 — trivial code cleanup with negligible risk.
