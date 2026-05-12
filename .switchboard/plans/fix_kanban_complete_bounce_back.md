# Fix Kanban Complete Button Bounce-Back for Managed Imports

## Goal

Eliminate the temporary "bounce-back" of managed-import plan cards to the NEW column after clicking the complete button, by fixing the registry update key, cleaning up active mirror tracking, and adding an immediate post-completion sync guard.

## Metadata

- **Tags:** frontend, bugfix, reliability
- **Complexity:** 5

## User Review Required

No

## Complexity Audit

### Routine

- Single-file primary change (`TaskViewerProvider.ts`).
- Registry update uses existing `_updatePlanRegistryStatus` API.
- Set deletion and conditional sync call are straightforward.

### Complex / Risky

- **Race-condition fix requires precise ordering**: The immediate `_syncConfiguredPlanFolder` call must run after tombstone is written but before the general `_syncFilesAndRefreshRunSheets` refresh, or the race window remains open.
- **Nested sync risk**: `_syncConfiguredPlanFolder` calls `_syncFilesAndRefreshRunSheets` internally (line 8646); calling it inside `_handleCompletePlan` (which also calls `_syncFilesAndRefreshRunSheets` at line 12192) can cause double refresh and potential re-entrancy. Need to either suppress the nested call or accept the extra refresh.

## Edge-Case & Dependency Audit

- **Race Conditions**: The 300ms debounced watcher (`_configuredPlanSyncTimer`) can fire concurrently with `_handleCompletePlan`. The tombstone check in `_syncConfiguredPlanFolder` (line 8556-8561) exists but the race window is between `_addTombstone` and the sync loop actually checking it.
- **Security**: No security implications; changes are localized to completion flow.
- **Side Effects**: Double `_syncFilesAndRefreshRunSheets` may cause two webview refreshes in rapid succession.
- **Dependencies & Conflicts**: None.

## Dependencies

None

## Adversarial Synthesis

Key risks: (1) `_syncConfiguredPlanFolder` running inside `_handleCompletePlan` causes redundant board refreshes because it already calls `_syncFilesAndRefreshRunSheets`; (2) if the nested sync throws, it must not fail the whole completion flow; (3) older managed imports created before the `source === 'managed-import'` field was added may not match the condition. Mitigations: wrap the immediate sync in try/catch, and consider a fallback check on `planFile` basename matching `ingested_*.md` pattern if `source` is absent.

## Proposed Changes

### `src/services/TaskViewerProvider.ts`

#### `_handleCompletePlan` (line ~12130)

- **Context**: For managed imports, `sheet.brainSourcePath` is set to the source file path and `sheet.source === 'managed-import'`. The registry entry was created with `planId = sessionId` (line 11289), not the source path hash.
- **Logic**: After archiving (line 12146-12151) and after the existing tombstone + registry update block (line 12161-12176), add:
  1. A registry update using `sessionId` when `sheet.source === 'managed-import'`.
  2. Removal of the mirror filename from `_managedImportMirrorsForActiveFolder`.
  3. An immediate `_syncConfiguredPlanFolder(configuredPlanFolder, resolvedWorkspaceRoot, true)` wrapped in try/catch, placed before the final `_syncFilesAndRefreshRunSheets`.
- **Implementation**:

```typescript
// In _handleCompletePlan, after the existing registry update block (~line 12176):

if (sheet?.source === 'managed-import') {
    // 1. Update registry using sessionId (managed imports register with sessionId as planId)
    await this._updatePlanRegistryStatus(resolvedWorkspaceRoot, sessionId, 'completed');

    // 2. Remove from active tracking so cleanup pass will purge any race-recreated mirror
    if (sheet.planFile) {
        const mirrorFilename = path.basename(sheet.planFile);
        this._managedImportMirrorsForActiveFolder.delete(mirrorFilename);
    }

    // 3. Immediate cleanup of any mirror recreated during the race window
    try {
        const configuredPlanFolder = this._normalizeConfiguredPlanFolder(
            await this.getPlanIngestionFolder(resolvedWorkspaceRoot), resolvedWorkspaceRoot
        );
        if (configuredPlanFolder) {
            await this._syncConfiguredPlanFolder(configuredPlanFolder, resolvedWorkspaceRoot, true);
        }
    } catch (e) {
        console.warn('[TaskViewerProvider] Post-completion configured-folder sync failed:', e);
    }
}
```

- **Edge Cases**:
  - If `sheet.source` is undefined (legacy managed import), fall back to checking if `planFile` basename matches `/^ingested_[0-9a-f]{64}\.md$/i`.
  - If `_syncConfiguredPlanFolder` throws, log and continue; do not fail the completion.

### `src/services/KanbanProvider.ts`

#### `completePlan` / `completeSelected` / `completeAll` (lines ~4593-4659)

- **Context**: KanbanProvider already does a DB-first update before calling the command, then refreshes the board.
- **Logic**: No structural changes needed. The existing `_refreshBoard` after command execution is sufficient. The fix in TaskViewerProvider handles the server-side race.
- **Edge Cases**: None.

## Verification Plan

### Automated Tests

- [ ] Add unit test for `_handleCompletePlan` with a mocked `sheet.source === 'managed-import'`:
  - Verify `_updatePlanRegistryStatus` is called with `sessionId`, not just `pathHash`.
  - Verify the mirror filename is deleted from `_managedImportMirrorsForActiveFolder`.
- [ ] Add unit test for `_syncConfiguredPlanFolder` to verify it respects tombstones and does not recreate a mirror for a tombstoned source.

### Manual Tests

1. Ingest a plan from a configured plan folder into the kanban (NEW column).
2. Click the tick button on the plan card.
3. **Expected**: Card animates to COMPLETED and stays there; no duplicate appears in NEW.
4. Verify the mirror file is moved to `.switchboard/archive/plans/`.
5. Wait 10 seconds and refresh the kanban — confirm no duplicate in NEW.
6. Verify the source file still exists in the configured plan folder (it should; only the mirror is archived).
7. Complete a brain plan (non-managed-import) and verify it still works correctly.

## Root Cause Analysis

Three interacting issues cause the bounce:

### 1. Race Condition with Configured-Folder Sync

Managed imports have a **source file** in the configured plan folder and a **mirror file** in `.switchboard/plans/`. When completing:

1. `_handleCompletePlan` archives the mirror and adds a tombstone for the source path hash.
2. But `_syncConfiguredPlanFolder` (which watches the source folder, 300ms debounce) may run concurrently and recreate the mirror from the still-existing source file before the tombstone is fully effective.
3. The recreated mirror triggers `_handlePlanCreation`, which creates a **new active runsheet + DB row**.
4. On the next kanban refresh, this new active row appears in the **NEW** column, creating the "bounce back".
5. Eventually the tombstone takes effect on a subsequent sync, and the duplicate is cleaned up — explaining the "few minutes lag".

### 2. Registry Update Uses Wrong `planId` for Managed Imports

In `_handleCompletePlan` (`TaskViewerProvider.ts:12169-12172`):

```typescript
const pathHash = crypto.createHash('sha256').update(stablePath).digest('hex');
await this._addTombstone(resolvedWorkspaceRoot, pathHash);
await this._updatePlanRegistryStatus(resolvedWorkspaceRoot, pathHash, 'completed');
```

For managed imports, the registry entry was created with `planId = sessionId` (e.g. `sess_123...`), **not** `pathHash`. Calling `_updatePlanRegistryStatus(pathHash, 'completed')` logs a warning and leaves the registry entry as `active`. This stale `active` registry entry can influence downstream sync behavior.

### 3. `_managedImportMirrorsForActiveFolder` Not Cleaned Up on Complete

The set `_managedImportMirrorsForActiveFolder` tracks which mirrors should exist. When a managed import is completed, its mirror filename is never removed from this set, so `_syncConfiguredPlanFolder`'s `cleanupMissingManagedImports` pass won't proactively delete a race-recreated mirror.

## Files to Modify

1. `src/services/TaskViewerProvider.ts`
   - `_handleCompletePlan` — fix registry update for managed imports + remove mirror from active tracking + immediate post-completion sync
   - `_syncConfiguredPlanFolder` — existing tombstone check is sufficient; no changes needed here if Fix 3 above is implemented

2. `src/services/KanbanProvider.ts` (no changes needed)
   - `completePlan` / `completeSelected` handlers — existing DB-first + refresh pattern is adequate

## Risks

- **Low**: The immediate `_syncConfiguredPlanFolder` call adds a small amount of sync work after completion, but it only runs for managed imports.
- **Low**: If the configured folder watcher fires rapidly, the `_recentlyCompletedMirrors` TTL (5s) might need tuning.
- **Very low**: Brain-plan completion behavior should be unchanged; all changes are scoped to the managed-import branch.

---

**Recommendation:** Send to Coder. Complexity is 5 — routine fixes with one moderate risk (nested sync ordering) that is well-scoped and documented.
