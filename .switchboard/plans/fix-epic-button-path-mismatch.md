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

## Adversarial Synthesis
**Key risks:** (1) the original "improve `_persistedUpdate`" snippet used `info.changes`, which is invalid here — the sql.js wrapper does not expose row counts (`KanbanDatabase.ts:3144`); (2) the audit was vague. **Mitigations:** demote the row-count enhancement to an explicitly out-of-scope note; state the concrete audit result (every other `WHERE plan_file = ?` UPDATE already normalizes — `updateEpicStatus` is the sole offender); cover all six epic call sites in the test/manual matrix. The core one-line fix is correct, minimal, and symmetric with INSERT-time normalization.

## Proposed Changes

### src/services/KanbanDatabase.ts
- **Context:** `updateEpicStatus` (lines 1325-1332) fetches a plan via `getPlanByPlanId`, whose `planFile` is hydrated to an **absolute** path by `_readRows` → `_resolveAbsolutePlanFile` (line 5225). It then passes that absolute path into a `WHERE plan_file = ?` clause against a column storing **relative** paths → zero rows matched, but `_persistedUpdate` returns `true` (silent no-op).
- **Logic:** Normalize `plan.planFile` to relative via `_ensureRelativePlanFile` before the UPDATE, matching every sibling method.
- **Implementation:** See the single-line fix in the **Solution → Implementation** block below.
- **Edge Cases:** Relative-stored paths round-trip cleanly; absolute-outside-workspace paths are returned unchanged by both INSERT and the new WHERE, preserving symmetry.

**Audit result (concrete):** All other `WHERE plan_file = ?` UPDATEs already call `_ensureRelativePlanFile` — `reassignWorkspaceByPlanFile` (1280), `updateColumnByPlanFile` (1293), `movePlanByPlanFile` (1350/1359), `updateComplexityByPlanFile` (1429), `updateTagsByPlanFile` (1457), and the `hasPlanByPlanFile` read (1247). `updateEpicStatus` is the **only** method that omitted normalization.

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

#### (OUT OF SCOPE) Improve `_persistedUpdate` no-op detection
> **Note:** This was previously proposed as an optional enhancement but is **out of scope** for this fix and must NOT be implemented as originally written.
>
> The original snippet relied on `this._db.run(sql, params).changes`. This is **invalid** for the sql.js wrapper used in this codebase: `_persistedUpdate` (line 4860) calls `this._db.run(sql, params)` which does not return a `changes`/`rowsAffected` value. This is confirmed by the existing workaround at `src/services/KanbanDatabase.ts:3144` ("Count matching rows first since the local type doesn't expose getRowsModified"), which performs a manual `SELECT COUNT(*)` precisely because row-change counts are unavailable.
>
> If no-op detection is desired in a future change, it must follow the line-3144 pattern (issue a `SELECT COUNT(*)` against the same WHERE clause) rather than reading a nonexistent `changes` field. Tracked as future work, not part of this bug fix.

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

4. **(OUT OF SCOPE) No-op detection:**
   - Do NOT modify `_persistedUpdate` to read `.changes`/`rowsAffected` — the sql.js wrapper does not expose it (see `KanbanDatabase.ts:3144`).
   - If pursued later, follow the line-3144 `SELECT COUNT(*)` pattern. Tracked as future work.

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

## Verification Plan

> **Session directive:** No project compilation and no automated test execution this session. Tests below are authored/specified; the user runs them separately.

### Automated Tests
- **Primary regression** (`KanbanDatabase.test.ts`): insert a plan with a relative `planFile`, call `updateEpicStatus(planId, 1, 'epic-123')`, assert it returns `true`, then assert `getPlanByPlanId(planId)` returns `isEpic === 1` and `epicId === 'epic-123'`. This fails before the fix (zero rows updated) and passes after. See the snippet in **Testing → Automated Testing**.
- **Caller coverage matrix** — exercise each distinct epic operation that routes through `updateEpicStatus`:
  - Promote-to-epic: `updateEpicStatus(planId, 1, '')` (KanbanProvider.ts:6445)
  - Create-epic-with-subtasks: epic set via `updateEpicStatus(planId, 1, '')` then each subtask `updateEpicStatus(st.planId, 0, planId)` (KanbanProvider.ts:6509/6523)
  - Add-subtask-to-epic: `updateEpicStatus(subtask.planId, 0, epic.planId)` (KanbanProvider.ts:6431, PlanningPanelProvider.ts:2056)
  - Remove-subtask-from-epic: `updateEpicStatus(subtask.planId, 0, '')` (KanbanProvider.ts:6535, PlanningPanelProvider.ts:2072)
- **Negative guard:** confirm `_ensureRelativePlanFile` rejection paths (malformed/traversal segments) still return empty and do not corrupt the WHERE clause.

### Manual Verification
See the **Testing → Manual Testing** steps (open kanban board, select 2+ plans, click EPIC, verify epic card, subtasks, and manage operations persist after refresh).

## Risks

- **Low risk:** The fix is a single-line change that aligns with existing patterns in the codebase
- **No breaking changes:** This only affects the internal database layer, not the API or UI
- **Edge cases:** `_ensureRelativePlanFile` already handles paths outside workspace and malformed paths, so no new edge cases are introduced

## Recommendation
**Complexity: 3 → Send to Intern.** Single-line, well-scoped fix reusing an established helper, with a clear regression test and a concrete audit confirming no sibling methods are affected.

## Dependencies
None - this is a self-contained bug fix within the database layer.
