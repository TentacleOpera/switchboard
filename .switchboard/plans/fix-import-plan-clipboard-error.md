# Fix Plan Import Clipboard Error

## Goal

Prevent the "Run sheet not found" error that appears after importing a plan from clipboard, renaming its title, and saving — caused by a race condition between the file rename and the GlobalPlanWatcherService's delete handler.

## Metadata

- **Tags:** [bugfix, reliability]
- **Complexity:** 4

## User Review Required

- Verify that the chosen approach (file-existence check in `_handlePlanDelete` vs. suppress-flag) aligns with project conventions.
- Confirm whether updating `session_id` in the DB after rename is acceptable (it changes a legacy key).

## Complexity Audit

### Routine
- Adding `fs.existsSync` guard in `_handlePlanDelete` (single conditional, localized)
- Updating `session_id` column in `_renameSessionPlanFile` (one additional SQL UPDATE)
- Using the updated `sheet.planFile` / new sessionId for `getReviewTicketData` after rename

### Complex / Risky
- Race condition between 300ms debounce timer and async DB write — timing-dependent, hard to reproduce deterministically
- Secondary bug: `_handlePlanFile` fires for the new file path after rename, potentially inserting a duplicate plan row with `sessionId: ''` — needs coordinated fix
- Changing `session_id` affects legacy lookups across the codebase (`getPlanBySessionId`, `_resolvePlan`, deprecated methods)

## Edge-Case & Dependency Audit

- **Race Conditions:** The 300ms debounce in `_debounceHandleDelete` can fire before `db.updatePlanFile()` commits. On a loaded system or with WAL-mode SQLite, the write latency may exceed the debounce window. Both the VS Code FileSystemWatcher and the native `fs.watch` fallback trigger the same debounce path, doubling the chance.
- **Security:** No security implications — this is a local file-watcher race.
- **Side Effects:** If `_handlePlanDelete` incorrectly deletes the plan row, downstream `getReviewTicketData` fails, the plan disappears from kanban, and `_handlePlanFile` may re-import it as a new plan with `sessionId: ''`, creating a duplicate.
- **Dependencies & Conflicts:** `KanbanDatabase.updatePlanFile` (line 1414) updates `plan_file` but NOT `session_id`. `SessionActionLog._resolvePlan` (line 70) falls back to `getPlanBySessionId`, so stale `session_id` values still resolve — but only if the row hasn't been deleted by the watcher.

## Dependencies

- None

## Adversarial Synthesis

Key risks: (1) The watcher race is real but the error path may also involve the SessionActionLog, not just the KanbanDatabase — the fix must guard the watcher delete handler regardless. (2) A secondary duplicate-plan bug exists when `_handlePlanFile` processes the new path after rename. Mitigations: Add an `fs.existsSync` guard in `_handlePlanDelete` (simple, no coordination needed), and ensure `_renameSessionPlanFile` updates `session_id` to prevent stale references.

## Problem

After importing a plan from clipboard, changing its title, and clicking Save, a red error appears: `Run sheet not found for session <old-path>`. The plan file saves and renames correctly, but the error is shown anyway.

## Root Cause

When `_renameSessionPlanFile` renames the plan file on disk, it updates `plan_file` in the DB but does **not** update `session_id` (which is the old path). The ticket view still uses `sessionId` (old path) for lookups.

`SessionActionLog._resolvePlan` tries `getPlanByPlanFile(oldPath)` first, which returns null because `plan_file` is now the new path. It falls back to `getPlanBySessionId(oldPath)`, which should find the record.

However, `GlobalPlanWatcherService` also watches the plans directory. When a file is renamed, the old file appears "deleted" to the watcher. The watcher debounces for 300ms, then calls `_handlePlanDelete`, which looks up the plan by `plan_file` and **hard-deletes** the row from DB if found. If the DB update hasn't completed by the time the watcher fires, the plan is deleted. This creates a race condition where the plan row is removed from the DB, causing subsequent `getReviewTicketData` calls to fail with "Run sheet not found".

## Evidence

- `KanbanDatabase.deletePlanByPlanFile` performs a hard `DELETE FROM plans WHERE plan_file = ?` (KanbanDatabase.ts:1504)
- `GlobalPlanWatcherService._handlePlanDelete` calls `deletePlanByPlanFile` after detecting a file deletion (GlobalPlanWatcherService.ts:485)
- The watcher debounce is 300ms — long enough for the rename to complete but short enough to race with DB updates
- Both VS Code FileSystemWatcher (line 276) and native `fs.watch` (line 318) trigger `_debounceHandleDelete`, doubling the race surface

## Fix

### Primary Fix: Guard `_handlePlanDelete` with file-existence check

In `GlobalPlanWatcherService._handlePlanDelete` (line 485), add an `fs.existsSync` check before performing the DB delete. If the file still exists on disk (meaning it was renamed, not deleted), skip the deletion.

**File:** `src/services/GlobalPlanWatcherService.ts` (line ~494)

```typescript
// BEFORE (line 494):
const plan = await db.getPlanByPlanFile(relativePath, workspaceId);
if (plan) {
    if (plan.status === 'completed') { ... }
    await db.deletePlanByPlanFile(plan.planFile, plan.workspaceId);
}

// AFTER:
const plan = await db.getPlanByPlanFile(relativePath, workspaceId);
if (plan) {
    if (plan.status === 'completed') { ... }

    // Guard: if the file still exists on disk, this was a rename (not a true delete).
    // The watcher fires on the old path, but the file has moved — don't delete the DB row.
    if (fs.existsSync(uri.fsPath)) {
        this._outputChannel?.appendLine(`[GlobalPlanWatcher] Skipping delete for renamed plan (file still exists): ${relativePath}`);
        return;
    }

    await db.deletePlanByPlanFile(plan.planFile, plan.workspaceId);
}
```

**Rationale:** This is the simplest, most robust fix. It requires no coordination between the rename operation and the watcher. It works regardless of timing. A file that was truly deleted will not exist on disk, so the guard won't prevent legitimate deletions. A file that was renamed will still exist (at the old URI? No — the URI points to the old path which no longer exists after rename). **Correction:** After a rename, `uri.fsPath` is the OLD path, which no longer exists. So `fs.existsSync(uri.fsPath)` will return `false` even for renames. This guard alone is insufficient.

**Revised approach:** Instead of checking the old path, check whether the plan's `session_id` maps to a different `plan_file` that DOES exist on disk. This indicates a rename:

```typescript
// In _handlePlanDelete, after finding the plan by plan_file:
if (plan) {
    if (plan.status === 'completed') { ... return; }

    // Guard: check if this plan's session_id now points to a different plan_file
    // (indicating a rename). If the session has a new plan_file that exists on disk,
    // this "delete" event is from the old path of a rename — skip it.
    if (plan.sessionId) {
        const renamedPlan = await db.getPlanBySessionId(plan.sessionId);
        if (renamedPlan && renamedPlan.planFile !== plan.planFile) {
            const renamedPath = path.resolve(workspaceRoot, renamedPlan.planFile);
            if (fs.existsSync(renamedPath)) {
                this._outputChannel?.appendLine(`[GlobalPlanWatcher] Skipping delete for renamed plan (session moved to ${renamedPlan.planFile}): ${relativePath}`);
                return;
            }
        }
    }

    await db.deletePlanByPlanFile(plan.planFile, plan.workspaceId);
}
```

**However**, this still has the race: if `updatePlanFile` hasn't committed, `getPlanBySessionId` returns the SAME row (with old `plan_file`), so the check `renamedPlan.planFile !== plan.planFile` fails.

**Final approach — suppress via transient flag in GlobalPlanWatcherService:**

Add a `_recentRenames` Set to `GlobalPlanWatcherService` that stores the old path of recently-renamed files. `_renameSessionPlanFile` registers the old path before renaming. `_handlePlanDelete` checks this set and skips deletion if the path is present.

### Secondary Fix: Update `session_id` in `_renameSessionPlanFile`

In `TaskViewerProvider._renameSessionPlanFile` (line 12313), after calling `db.updatePlanFile(sessionId, nextRelative)`, also update the `session_id` column to the new relative path. This prevents stale `session_id` references.

**File:** `src/services/TaskViewerProvider.ts` (line ~12367)

```typescript
// AFTER the existing db.updatePlanFile call:
if (db) {
    await db.updatePlanFile(sessionId, nextRelative);
    // Also update session_id so lookups by the new path work
    await db.updateSessionId(sessionId, nextRelative);
}
```

This requires adding a new `updateSessionId` method to `KanbanDatabase`:

**File:** `src/services/KanbanDatabase.ts` (after line ~1436)

```typescript
public async updateSessionId(oldSessionId: string, newSessionId: string): Promise<boolean> {
    return this._persistedUpdate(
        'UPDATE plans SET session_id = ?, updated_at = ? WHERE session_id = ?',
        [this._ensureRelativePlanFile(newSessionId), new Date().toISOString(), oldSessionId]
    );
}
```

### Tertiary Fix: Use updated sessionId in `savePlanText` handler

In `TaskViewerProvider.updateReviewTicket` (line 12509, `savePlanText` case), after `_renameSessionPlanFile` returns, use the new plan file path for the final `getReviewTicketData` call instead of the stale `sessionId`.

**File:** `src/services/TaskViewerProvider.ts` (line ~12556)

The current code calls `getReviewTicketData(sessionId)` with the original (stale) sessionId. After rename, the sheet's `planFile` has been updated. The `getReviewTicketData` method resolves the workspace root from `sessionId`, then calls `log.getRunSheet(sessionId)`. If the run sheet's sessionId hasn't changed (it's in SessionActionLog, a separate DB), this should still work. But to be safe, we should use the sheet's current state.

**Clarification:** The `sessionId` used for `getReviewTicketData` is the original request sessionId, which is the old path. The `sheet` object has been mutated in place (line 12370: `sheet.planFile = nextRelative`), but `sheet.sessionId` is unchanged. The `getRunSheet(sessionId)` call in `getReviewTicketData` uses the old sessionId, which should still find the run sheet in SessionActionLog. The error "Run sheet not found" likely occurs when the kanban row was deleted by the watcher, causing `_getKanbanPlanRecordForSession` to return null, and then some downstream code throws. More investigation needed at implementation time to confirm the exact error path.

## Implementation Notes

- The `_renameSessionPlanFile` method already updates `sheet.planFile` in memory and the DB.
- The `refreshViews()` call after save triggers `_syncFilesAndRefreshRunSheets`, which re-reads from DB.
- If the DB row was deleted by the watcher, `_refreshRunSheets` will filter it out as a ghost plan.
- The safest fix combines: (1) suppress watcher during rename via `_recentRenames` flag, (2) update `session_id` in DB, (3) use updated sessionId for post-rename lookups.
- The `_handlePlanFile` method also fires for the new file path after a rename. If the kanban row still exists (watcher didn't delete it), `_handlePlanFile` will find it via `getPlanByPlanFile(newPath)` and update it. If the row was deleted, it will insert a new row with `sessionId: ''`, creating a duplicate. The `_recentRenames` flag approach also prevents this by ensuring the original row survives.

## Proposed Changes

### `src/services/GlobalPlanWatcherService.ts`
- **Context:** The service watches `.switchboard/plans/**/*.md` for file system events. When a file is deleted, it removes the corresponding DB row.
- **Logic:** Add a `private _recentRenames = new Set<string>()` property. Add a public `registerRename(oldPath: string)` method that adds the old path to the set and schedules its removal after 2 seconds. In `_handlePlanDelete`, check if the deleted file's relative path is in `_recentRenames` and skip deletion if so.
- **Implementation:**
  - Line ~13 (class properties): Add `_recentRenames = new Set<string>()`
  - After the property: Add `public registerRename(oldRelativePath: string): void { this._recentRenames.add(oldRelativePath); setTimeout(() => this._recentRenames.delete(oldRelativePath), 2000); }`
  - Line ~494 (in `_handlePlanDelete`, before the delete): Add guard: `if (this._recentRenames.has(relativePath)) { this._outputChannel?.appendLine(\`[GlobalPlanWatcher] Skipping delete for recently-renamed plan: ${relativePath}\`); return; }`
- **Edge Cases:** If the rename fails after `registerRename` is called, the set entry will expire after 2 seconds with no side effects. If two renames happen in quick succession for the same path, the set handles it idempotently.

### `src/services/TaskViewerProvider.ts`
- **Context:** `_renameSessionPlanFile` renames the plan file and updates the DB, but doesn't update `session_id` or notify the watcher.
- **Logic:** Before calling `fs.promises.rename`, register the old relative path with `GlobalPlanWatcherService.registerRename`. After `db.updatePlanFile`, also call `db.updateSessionId`.
- **Implementation:**
  - Line ~12347 (before `fs.promises.rename`): Call `this._planWatcher?.registerRename(currentRelative)` (need to ensure `_planWatcher` reference is available; check if `GlobalPlanWatcherService` is accessible from `TaskViewerProvider`).
  - Line ~12367 (after `db.updatePlanFile`): Add `await db.updateSessionId(sessionId, nextRelative)`
- **Edge Cases:** If `updateSessionId` fails, the row still has the old `session_id` but the new `plan_file`. `_resolvePlan` fallback still works. If `_planWatcher` is not available, the rename proceeds without suppression — the 300ms debounce may still race, but this is the existing behavior.

### `src/services/KanbanDatabase.ts`
- **Context:** The DB has `updatePlanFile` but no `updateSessionId`.
- **Logic:** Add `updateSessionId` method that updates the `session_id` column.
- **Implementation:**
  - After line ~1436: Add the `updateSessionId` method as shown in the Fix section above.
- **Edge Cases:** If multiple plans share the same `session_id` (shouldn't happen but defensive), the UPDATE would affect all of them. Add `LIMIT 1` equivalent or check count.

## Verification Plan

### Automated Tests
- **Test 1:** Import a plan from clipboard, change title, save — verify no error and plan appears in kanban with correct name.
- **Test 2:** Simulate the race condition: after `fs.promises.rename`, manually call `_handlePlanDelete` with the old path before `updatePlanFile` completes — verify the plan row is NOT deleted (due to `_recentRenames` guard).
- **Test 3:** Verify that legitimate file deletions still work: delete a plan file, wait for watcher, verify DB row is removed.
- **Test 4:** Verify `_handlePlanFile` for the new path after rename updates the existing row (doesn't create a duplicate with `sessionId: ''`).

### Manual Testing
1. Import a plan from clipboard.
2. Change the title in the ticket view.
3. Click Save.
4. Verify no red error appears.
5. Verify the plan file is renamed correctly on disk.
6. Verify the plan still appears in the sidebar/kanban.
7. Verify the plan's `session_id` in the DB matches the new file path.

## Recommendation

Complexity 4 → **Send to Coder**
