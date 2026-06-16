# Fix Epic Button Path Mismatch in KanbanDatabase

## Goal
Fix the epic button in kanban.html that fails to update epic status due to a path mismatch between in-memory absolute paths and database-stored relative paths. The fix is a single-line normalization in `updateEpicStatus` so the UPDATE WHERE clause uses the same relative path format the database stores. See the **Problem Analysis** section below for the full root-cause breakdown.

## Metadata
**Tags:** bugfix, database, reliability
**Complexity:** 3

## User Review Required
- **Confirm scope:** The required change is a single line in `updateEpicStatus`. The previously-proposed "Improve `_persistedUpdate`" enhancement has been demoted to out-of-scope (see Proposed Changes) because the sql.js wrapper used here does not expose row-change counts — confirmed by the existing manual-count workaround at `src/services/KanbanDatabase.ts:3144`.
- **Confirm test scope:** Per session directive, automated tests are authored in this plan but executed separately by the user.

## Complexity Audit

### Routine
- Single-line change in one method (`updateEpicStatus`).
- Reuses the existing `_ensureRelativePlanFile` helper already applied by every sibling UPDATE method.
- No schema, API, or UI changes.

### Complex / Risky
- None. The fix is symmetric with the INSERT-time path normalization and introduces no new code paths.

## Edge-Case & Dependency Audit
- **Race Conditions:** None introduced. `_persistedUpdate` serializes through the existing write tail; this change only alters one parameter value passed to it.
- **Security:** None. `_ensureRelativePlanFile` already rejects malformed/absolute-looking segments and returns empty for traversal attempts; reusing it tightens, not loosens, behavior.
- **Side Effects:** None beyond the intended one — `is_epic`/`epic_id` rows now actually update. All six callers (`KanbanProvider.ts` promote/add/remove/create-epic flows and `PlanningPanelProvider.ts` add/remove flows) benefit from the single centralized fix.
- **Dependencies & Conflicts:** Self-contained within the database layer. Outside-workspace absolute paths round-trip symmetrically (INSERT stores as-is, new WHERE re-normalizes to the same as-is value), so no regression for that edge case.

## Dependencies
None — self-contained bug fix within the database layer.

## Problem Analysis

### Core Problem
The epic button in the kanban board UI appears to work (no errors thrown) but fails to actually update the `is_epic` and `epic_id` columns in the database. Users click the button, select options, and the UI indicates success, but the plan's epic status remains unchanged.

### Root Cause
The issue is in `KanbanDatabase.ts` in the `updateEpicStatus` method:

1. **Data flow:**
   - Database stores `plan_file` as **relative paths** (e.g., `.switchboard/plans/my-plan.md`)
   - `_readRows` method (line 5225) converts these to **absolute paths** in memory for application use (e.g., `/Users/user/workspace/.switchboard/plans/my-plan.md`)
   - `getPlanByPlanId` returns a `KanbanPlanRecord` with `planFile` as an absolute path

2. **The bug:**
   - `updateEpicStatus` (line 1325-1332) fetches a plan via `getPlanByPlanId`, which returns an absolute `planFile`
   - The UPDATE query uses this absolute path in the WHERE clause:
     ```sql
     UPDATE plans SET is_epic = ?, epic_id = ?, updated_at = ? 
     WHERE plan_file = ? AND workspace_id = ?
     ```
   - Since the database stores relative paths, the WHERE clause matches **zero rows**
   - `_persistedUpdate` returns `true` regardless of rows affected, so the caller believes the operation succeeded

3. **Why this is silent:**
   - No error is thrown because the SQL is valid
   - The method returns `true` (success) even when zero rows are updated
   - The UI has no way to detect that the update was a no-op

### Impact
- Users cannot create, manage, or modify epics through the kanban UI
- The epic workflow is completely broken despite the UI appearing functional
- All epic-related operations (promote to epic, add to epic, manage epic) fail silently

## Solution

### Fix Location
File: `src/services/KanbanDatabase.ts`
Method: `updateEpicStatus` (lines 1325-1332)

### Implementation
Convert the absolute `plan.planFile` back to a relative path before using it in the UPDATE WHERE clause by calling `_ensureRelativePlanFile`:

```typescript
public async updateEpicStatus(planId: string, isEpic: number, epicId: string): Promise<boolean> {
    const plan = await this.getPlanByPlanId(planId);
    if (!plan) return false;
    const relativePlanFile = this._ensureRelativePlanFile(plan.planFile);
    return this._persistedUpdate(
        'UPDATE plans SET is_epic = ?, epic_id = ?, updated_at = ? WHERE plan_file = ? AND workspace_id = ?',
        [isEpic, epicId, new Date().toISOString(), relativePlanFile, plan.workspaceId]
    );
}
```

### Why This Fix Works
- `_ensureRelativePlanFile` is the same method used during INSERT operations to normalize paths to relative format
- It handles edge cases (absolute paths outside workspace, malformed paths, etc.)
- This ensures the WHERE clause uses the same path format as stored in the database

### Additional Considerations

#### Audit Other Methods
Check if other methods in `KanbanDatabase.ts` have the same pattern of using absolute paths in UPDATE WHERE clauses:

- `updateColumnByPlanFile` - already uses `_ensureRelativePlanFile` (line 1307)
- `updateColumn` - deprecated, delegates to `updateColumnByPlanFile`
- Other UPDATE methods should be reviewed for similar issues

#### Improve `_persistedUpdate`
Consider enhancing `_persistedUpdate` to return the number of rows affected, allowing callers to detect no-op updates:

```typescript
private _persistedUpdate(sql: string, params: unknown[]): { success: boolean; rowsAffected: number } {
    // ... existing code ...
    const info = this._db.run(sql, params);
    return { success: true, rowsAffected: info.changes };
}
```

This would allow `updateEpicStatus` to return `false` when zero rows are affected, providing better error feedback to the UI.

## Implementation Steps

1. **Fix the immediate bug:**
   - Modify `updateEpicStatus` to convert `plan.planFile` to relative path before UPDATE
   - Add unit test to verify the fix

2. **Audit for similar issues:**
   - Search for all UPDATE statements in `KanbanDatabase.ts` that use `plan_file` in WHERE clauses
   - Verify each uses relative paths

3. **Add regression test:**
   - Create a test that:
     - Inserts a plan with relative path
     - Calls `updateEpicStatus`
     - Verifies the database row was actually updated
     - Verifies `getPlanByPlanId` returns the updated epic status

4. **Optional enhancement:**
   - Modify `_persistedUpdate` to return rows affected
   - Update callers to check for zero-row updates
   - Add error logging when updates affect zero rows unexpectedly

## Testing

### Manual Testing
1. Open kanban board in VS Code
2. Select 2+ non-epic plans
3. Click EPIC button
4. Create epic with name and description
5. Verify:
   - Epic card appears on board with purple border
   - Selected plans are now subtasks of the epic
   - Epic can be managed (add/remove subtasks, delete epic)

### Automated Testing
Add test case in `KanbanDatabase.test.ts`:
```typescript
test('updateEpicStatus updates database with relative path', async () => {
    const db = new KanbanDatabase(workspaceRoot, dbPath);
    await db.initialize();
    
    // Insert plan with relative path
    const planId = 'test-plan-id';
    await db.insertPlan({
        planId,
        planFile: '.switchboard/plans/test.md', // relative
        workspaceId: 'test-workspace',
        // ... other fields
    });
    
    // Update epic status
    const result = await db.updateEpicStatus(planId, 1, 'epic-123');
    expect(result).toBe(true);
    
    // Verify database was actually updated
    const updated = await db.getPlanByPlanId(planId);
    expect(updated.isEpic).toBe(1);
    expect(updated.epicId).toBe('epic-123');
});
```

## Risks

- **Low risk:** The fix is a single-line change that aligns with existing patterns in the codebase
- **No breaking changes:** This only affects the internal database layer, not the API or UI
- **Edge cases:** `_ensureRelativePlanFile` already handles paths outside workspace and malformed paths, so no new edge cases are introduced

## Dependencies
None - this is a self-contained bug fix within the database layer.
