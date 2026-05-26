# Fix: Project Removed When Moving Cards Between Columns

## Goal
Prevent the `project` field (and other DB-managed fields) from being cleared when a kanban card is moved between columns, by fixing the `_buildKanbanRecordFromSheet` method that omits these fields during runsheet-triggered upserts.

## Metadata
- **Tags:** bugfix, backend, database
- **Complexity:** 4

## User Review Required
- Confirm that preserving all DB-managed fields during runsheet upserts is the desired behavior (vs. only preserving `project`).
- Confirm that the existing `_buildKanbanRecordFromSheet` callers (`_updateSessionRunSheet`, `_syncKanbanDbFromSheetsSnapshot`) should all adopt the preserve-existing-fields pattern.

## Complexity Audit

### Routine
- Adding the `project` field (and other missing fields) to the record returned by `_buildKanbanRecordFromSheet`
- Reading the existing DB record before building the sheet-derived record
- Spreading existing DB values for fields not available from the runsheet

### Complex / Risky
- Ensuring the fix doesn't interfere with the `_syncKanbanDbFromSheetsSnapshot` full-sync path, which uses `KanbanMigration.syncPlansMetadata` (a different upsert path that already preserves project correctly)
- The `_updateSessionRunSheet` path also overwrites `tags`, `dependencies`, `routedTo`, `dispatchedAgent`, `dispatchedIde`, `hasWorktree` with empty/zero values — deciding whether to preserve all of these or only `project`

## Edge-Case & Dependency Audit

- **Race Conditions:** The `_updateSessionRunSheet` method reads the existing DB record and then upserts. If another write happens between the read and the upsert, the project could still be lost. However, this window is extremely small (single async tick) and the existing code already has this pattern for other fields.
- **Security:** No security implications — this is internal data preservation.
- **Side Effects:** Fixing `_buildKanbanRecordFromSheet` will also preserve `clickupTaskId`, `linearIssueId`, `routedTo`, `dispatchedAgent`, `dispatchedIde`, and `hasWorktree` during runsheet upserts, which is desirable behavior.
- **Dependencies & Conflicts:** The `_syncKanbanDbFromSheetsSnapshot` path uses `KanbanMigration.syncPlansMetadata` which calls `updateMetadataBatchByPlanFile` (only updates specific fields, doesn't touch project). This path is safe and doesn't need changes. The `_updateSessionRunSheet` path is the only one that calls `db.upsertPlan(record)` directly with the incomplete record.

## Dependencies
- None

## Adversarial Synthesis
Key risks: (1) The original plan misidentified the root cause — the SQL UPDATE is innocent; the actual data loss occurs via `_buildKanbanRecordFromSheet` omitting `project` and the subsequent `upsertPlan` overwriting it with `''`. (2) The same upsert path also clears `clickupTaskId`, `linearIssueId`, and hardcodes several fields to empty values. Mitigations: Read the existing DB record in `_buildKanbanRecordFromSheet` and spread its values for all DB-managed fields not derivable from the runsheet.

## Bug Description
When a card is assigned to a project, moving the card to a new column causes it to suddenly be removed from the project and disappear from the project view.

## Root Cause Analysis (Corrected)

**The original root cause analysis was incorrect.** The SQL statement in `updateColumnByPlanFile` does NOT clear the `project` field. In SQL, an `UPDATE` statement only modifies columns explicitly listed in the `SET` clause; unmentioned columns retain their existing values. So:

```sql
UPDATE plans SET kanban_column = ?, updated_at = ? WHERE plan_file = ? AND workspace_id = ?
```

preserves the `project` field (and all other columns) as-is.

### Actual Root Cause

The bug is in `TaskViewerProvider._buildKanbanRecordFromSheet` (line 1792), which constructs a `KanbanPlanRecord` **without** the `project` field:

```typescript
return {
    planId,
    sessionId: sheet.sessionId,
    topic: ...,
    planFile: rawPlanFile,
    kanbanColumn: 'CREATED',
    status: ...,
    complexity,
    tags: '',           // hardcoded empty
    dependencies: '',   // hardcoded empty
    repoScope,
    workspaceId,
    createdAt,
    updatedAt,
    lastAction: ...,
    sourceType: ...,
    brainSourcePath: ...,
    mirrorPath: ...,
    routedTo: '',       // hardcoded empty
    dispatchedAgent: '', // hardcoded empty
    dispatchedIde: '',   // hardcoded empty
    hasWorktree: 0       // hardcoded zero
    // project: MISSING
    // clickupTaskId: MISSING
    // linearIssueId: MISSING
};
```

When this incomplete record is upserted via `db.upsertPlan(record)`, the `UPSERT_PLAN_SQL` on-conflict handler sets:

```sql
project = excluded.project
```

Since `record.project` is `undefined`, the binding code at line 1073 (`record.project || ''`) converts it to `''` (empty string), which **overwrites the existing project assignment**.

### Trigger Path

The bug is triggered by the following sequence during a card move:

1. User drags card to new column in the kanban board
2. Webview sends `moveCardForward` or `moveCardBackwards` message
3. `KanbanProvider` handler calls `moveCardToColumn(workspaceRoot, sid, targetColumn)` → `db.updateColumn(sessionId, targetColumn)` → `updateColumnByPlanFile` — **project preserved in DB** (SQL UPDATE only changes `kanban_column` and `updated_at`)
4. `KanbanProvider` handler calls `recordRunSheetForColumnMove(sid, targetColumn, 'forward', workspaceRoot)` → `_updateSessionRunSheet` → `_buildKanbanRecordFromSheet` → `db.upsertPlan(record)` — **project CLEARED** (record omits `project`, upsert overwrites with `''`)

Step 4 is the destructive operation. The `updateColumnByPlanFile` in step 3 is innocent.

### Collateral Damage

The same upsert path also clears these DB-managed fields that are either missing or hardcoded to empty values in `_buildKanbanRecordFromSheet`:

| Field | Value in record | Effect |
|-------|----------------|--------|
| `project` | Missing (`undefined → ''`) | Clears project assignment |
| `clickupTaskId` | Missing (`undefined → ''`) | Clears ClickUp task link |
| `linearIssueId` | Missing (`undefined → ''`) | Clears Linear issue link |
| `tags` | Hardcoded `''` | Clears tags |
| `dependencies` | Hardcoded `''` | Clears dependencies |
| `routedTo` | Hardcoded `''` | Clears routing info |
| `dispatchedAgent` | Hardcoded `''` | Clears dispatch agent |
| `dispatchedIde` | Hardcoded `''` | Clears dispatch IDE |
| `hasWorktree` | Hardcoded `0` | Clears worktree flag |

## Solution

Modify `_buildKanbanRecordFromSheet` in `src/services/TaskViewerProvider.ts` to read the existing DB record and preserve DB-managed fields that are not derivable from the runsheet.

### Approach

Before returning the record, read the existing plan from the DB. If it exists, spread its values for all DB-managed fields (project, clickupTaskId, linearIssueId, routedTo, dispatchedAgent, dispatchedIde, hasWorktree, tags, dependencies) over the sheet-derived defaults. This ensures that fields managed exclusively by the DB are never cleared by a runsheet-triggered upsert.

### Implementation

In `_buildKanbanRecordFromSheet` (line 1757 of `src/services/TaskViewerProvider.ts`):

1. After building the base record from the sheet, read the existing DB record:
   ```typescript
   const existing = await db.getPlanByPlanFile(rawPlanFile, workspaceId);
   ```

2. If the existing record exists, overlay its DB-managed fields:
   ```typescript
   if (existing) {
       return {
           ...baseRecord,
           project: existing.project || '',
           clickupTaskId: existing.clickupTaskId || '',
           linearIssueId: existing.linearIssueId || '',
           routedTo: existing.routedTo || '',
           dispatchedAgent: existing.dispatchedAgent || '',
           dispatchedIde: existing.dispatchedIde || '',
           hasWorktree: existing.hasWorktree ?? 0,
           tags: existing.tags || baseRecord.tags,
           dependencies: existing.dependencies || baseRecord.dependencies,
       };
   }
   return baseRecord;
   ```

   **Clarification**: `tags` and `dependencies` use the existing DB value as primary, falling back to the sheet-derived value. This is because `_updateSessionRunSheet` is not the authoritative source for tags/dependencies (those come from plan file parsing via `GlobalPlanWatcherService`), but we don't want to clear them either.

3. The method needs access to the DB instance. It currently doesn't have one. Add a `db` parameter or use the existing `_getKanbanDb` method. The simplest approach: pass `db` as a parameter since the caller (`_updateSessionRunSheet`) already has it.

## Files to Modify

1. `src/services/TaskViewerProvider.ts` — `_buildKanbanRecordFromSheet` method (line 1757)
   - Add DB parameter or access
   - Read existing record before returning
   - Preserve DB-managed fields from existing record

## Verification Plan

### Automated Tests
- Add a test that creates a plan, assigns it to a project, then calls the column move flow, and verifies the project is preserved in the DB afterward.
- Add a test that verifies `clickupTaskId`, `linearIssueId`, `routedTo`, `dispatchedAgent`, `dispatchedIde`, and `hasWorktree` are also preserved during runsheet upserts.

### Manual Testing
After implementing the fix:
1. Create a plan and assign it to a project
2. Move the card to a different column
3. Verify the card remains assigned to the project
4. Verify the card is still visible in the project view
5. Test with multiple cards in a project
6. Test with project filtering enabled
7. Assign a ClickUp task ID to a plan, move the card, verify the ClickUp task ID is preserved
8. Assign a Linear issue ID to a plan, move the card, verify the Linear issue ID is preserved
9. Set `routedTo`, `dispatchedAgent`, `dispatchedIde` on a plan, move the card, verify they are preserved

## Risk Assessment

- **Low risk**: The change only adds field preservation to an existing record-building method
- **Backward compatible**: Existing behavior is preserved (column still updates correctly)
- **No data migration needed**: This is a runtime fix only
- **Positive side effects**: Also fixes data loss for `clickupTaskId`, `linearIssueId`, `routedTo`, `dispatchedAgent`, `dispatchedIde`, `hasWorktree`

## Recommendation

Complexity 4 → **Send to Coder**

---

## Review Pass — 2026-05-26

### Stage 1: Grumpy Principal Engineer Findings

| # | Severity | Finding |
|---|----------|---------|
| 1 | **MAJOR** | N+1 DB query regression: `_buildKanbanRecordFromSheet` now calls `db.getPlanByPlanFile()` unconditionally, including from `_syncKanbanDbFromSheetsSnapshot` which calls it in a loop over all sheets. The `_syncKanbanDbFromSheetsSnapshot` path doesn't need DB field preservation — `KanbanMigration.syncPlansMetadata` already handles existing plans correctly via `updateMetadataBatchByPlanFile` (which doesn't touch `project`). Adding a DB read per sheet in the bulk sync path is an unnecessary performance hit. |
| 2 | NIT | `project` is declared optional (`project?: string`) in `KanbanPlanRecord` but the overlay always sets it to a string. Inconsistency between interface and runtime behavior. Harmless since `upsertPlans` does `record.project \|\| ''` anyway. |
| 3 | NIT | `tags` and `dependencies` fallback logic (`existing.tags \|\| baseRecord.tags`) is semantically correct but the plan's clarification suggests sheet-derived values could exist in the future. If tags ever come from the runsheet, the current fallback would silently prefer the (possibly stale) DB value over the fresh sheet value. |
| 4 | NIT | `KanbanMigration._toKanbanPlanRecords` drops `project` from input records, but this only matters during `bootstrapIfNeeded` which runs when there are no existing DB records — so there's nothing to preserve. False alarm. |
| 5 | **CRITICAL** (process) | `KanbanProvider.ts` changes (using `setProjectFilter(null)` instead of direct `_projectFilter = null`, removing redundant `setCurrentProject` call) are valid bug fixes but are **not mentioned in this plan**. The plan's "Files to Modify" section only lists `TaskViewerProvider.ts`. These are scope creep and should have been in a separate plan/commit. |

### Stage 2: Balanced Synthesis

| Finding | Verdict | Action |
|---------|---------|--------|
| 1. N+1 DB query | **Fix now** | Add `preserveExistingFields` parameter (default `true`), pass `false` from `_syncKanbanDbFromSheetsSnapshot` |
| 2. Optional vs required `project` | Defer | Harmless, cosmetic |
| 3. Tags/dependencies fallback | Defer | Correct today, revisit if sheet-derived tags become a thing |
| 4. Bootstrap drops project | No action | False alarm |
| 5. Unrelated KanbanProvider.ts changes | Document | Fixes are correct but belong in separate plan |

### Code Fixes Applied

1. **Added `preserveExistingFields: boolean = true` parameter** to `_buildKanbanRecordFromSheet` (line 1762 of `src/services/TaskViewerProvider.ts`). The DB read and field overlay are now gated behind this flag.
2. **Updated `_syncKanbanDbFromSheetsSnapshot` call site** (line 1855) to pass `false` for `preserveExistingFields`, eliminating the N+1 DB query during bulk sync operations.
3. **`_updateSessionRunSheet` call site** (line 13460) uses the default `true`, preserving the bug fix for single-record upserts.

### Files Changed (Review Pass)

- `src/services/TaskViewerProvider.ts` — Added `preserveExistingFields` parameter to `_buildKanbanRecordFromSheet`; updated `_syncKanbanDbFromSheetsSnapshot` call site to pass `false`

### Unrelated Changes in Same Commit (Not Part of This Plan)

- `src/services/KanbanProvider.ts` — Two changes:
  - Line 4208: `deleteProject` handler now uses `this.setProjectFilter(null)` instead of `this._projectFilter = null` (ensures `GlobalPlanWatcher` is notified when the filtered project is deleted)
  - Line 4223: `setProjectFilter` handler removed redundant `this._globalPlanWatcher?.setCurrentProject(workspaceRoot, msg.project || null)` call (already handled by `setProjectFilter()` method)
  - These are valid fixes but should be tracked separately.

### Validation Results

- **Typecheck**: Passes (2 pre-existing errors in `ClickUpSyncService.ts` and `KanbanProvider.ts` unrelated to this change — import path extension issues)
- **Automated tests**: Skipped per session instructions (to be run separately)

### Remaining Risks

- **Race condition**: The read-then-upsert pattern in `_updateSessionRunSheet` has a small window where another write could occur between the DB read and the upsert. This is pre-existing and the window is extremely small.
- **`KanbanMigration._toKanbanPlanRecords`**: Still drops `project`, `clickupTaskId`, `linearIssueId` from input records during bootstrap. Only affects the initial bootstrap scenario (no existing plans), so this is acceptable.
