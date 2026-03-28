# Add Tombstone Cleanup Job for Deleted Plans

## Goal
Add a scheduled cleanup job that permanently purges old tombstoned plans (`status = 'deleted'`) from the KanbanDatabase to prevent indefinite table growth.

## Background
The stale kanban card fix (`feature_plan_20260328_184608_stale_kanban_card_persistence.md`) tombstones orphaned plans by setting `status = 'deleted'` instead of permanently deleting them. This is correct for safety (recoverable), but the `plans` table accumulates these tombstones indefinitely.

The plan explicitly noted this was out of scope: *"A future job can purge old deleted plans"*. This is that future job.

## Implementation

### 1. Add purgeOldTombstones method
**File:** `src/services/KanbanDatabase.ts`

Add after `purgeOrphanedPlans()` (around line 688):

```typescript
/**
 * Permanently delete tombstoned plans older than the specified threshold.
 * Default: 30 days. Returns number of records purged.
 */
public async purgeOldTombstones(
    workspaceId: string,
    olderThanDays: number = 30
): Promise<number> {
    if (!(await this.ensureReady()) || !this._db) return 0;

    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - olderThanDays);
    const cutoffIso = cutoff.toISOString();

    const stmt = this._db.prepare(
        `DELETE FROM plans 
         WHERE workspace_id = ? 
           AND status = 'deleted' 
           AND updated_at < ?`,
        [workspaceId, cutoffIso]
    );
    
    try {
        stmt.step();
        const purged = this._db.getRowsModified();
        stmt.free();
        
        if (purged > 0) {
            await this._persist();
            console.log(`[KanbanDatabase] Purged ${purged} old tombstones older than ${olderThanDays} days`);
        }
        return purged;
    } catch (e) {
        stmt.free();
        console.error('[KanbanDatabase] Failed to purge old tombstones:', e);
        return 0;
    }
}
```

### 2. Wire into manual sync path
**File:** `src/services/TaskViewerProvider.ts`

In `_syncKanbanDbFromSheetsSnapshot()` (around line 925, after `purgeOrphanedPlans`):

```typescript
// Purge orphaned plans whose files no longer exist on disk
if (archiveMissing) {
    const purged = await db.purgeOrphanedPlans(workspaceId, (planFile: string) => {
        return path.resolve(workspaceRoot, planFile);
    });
    if (purged > 0) {
        console.log(`[TaskViewerProvider] Purged ${purged} orphaned plan(s) during sync`);
    }

    // Also clean up old tombstones (runs infrequently, safe to do here)
    const tombstonesPurged = await db.purgeOldTombstones(workspaceId, 30);
    if (tombstonesPurged > 0) {
        console.log(`[TaskViewerProvider] Cleaned up ${tombstonesPurged} old tombstones`);
    }
}
```

### 3. Optional: Add explicit cleanup command
**File:** `src/services/TaskViewerProvider.ts` (message handler)

Add a new message handler for manual tombstone cleanup:

```typescript
case 'cleanupTombstones': {
    const db = await this._getKanbanDb(resolvedWorkspaceRoot);
    if (db) {
        const workspaceId = await db.getWorkspaceId() || await db.getDominantWorkspaceId();
        if (workspaceId) {
            const purged = await db.purgeOldTombstones(workspaceId, msg.olderThanDays || 30);
            vscode.window.showInformationMessage(`Cleaned up ${purged} old deleted plan records.`);
        }
    }
    break;
}
```

This is optional — automatic cleanup during manual sync is probably sufficient.

## Verification Plan

### Automated Tests
- Run `npx tsc --noEmit` — no type errors
- Add unit test for `purgeOldTombstones`:
  1. Insert test plans with `status = 'deleted'` and old `updated_at`
  2. Call `purgeOldTombstones` with threshold
  3. Verify old records deleted, recent records preserved

### Manual Verification
1. Create a plan, then delete/rename its file to trigger orphan purge
2. Verify plan is tombstoned (`status = 'deleted'`)
3. Manually adjust `updated_at` in DB to 31 days ago (or wait)
4. Trigger a manual sync (Refresh button or extension reload)
5. **Expected:** Old tombstone is permanently deleted
6. **Failure mode:** Tombstone persists indefinitely; table grows

### Performance Verification
1. Create 1000 tombstoned plans with old dates
2. Trigger cleanup
3. Verify completes in < 100ms

## Complexity
- **Scope:** 2 files (`KanbanDatabase.ts`, `TaskViewerProvider.ts`), ~30 lines
- **Risk:** Low — only touches `status = 'deleted'` records, has time threshold guard
- **Dependencies:** Stale kanban card fix must be deployed (it is)

## Adversarial Considerations
- **Accidental deletion risk:** Query explicitly filters `status = 'deleted'` — active/archived/completed plans cannot be touched
- **Time threshold bypass:** Default 30 days provides recovery window; caller can pass custom value (dangerous but explicit)
- **Race condition:** If a plan is being tombstoned while cleanup runs, the `updated_at` timestamp will be recent (now), so it won't match the `< cutoff` condition — safe
- **DB locked:** `_persist()` handles persistence; if it fails, in-memory changes are discarded on next load — safe failure mode

## Agent Recommendation
**Send to Coder** — Straightforward DB operation with clear safety guards, minimal integration points. Pattern already established by `purgeOrphanedPlans`.
