# Migrate _readSessionTitleMap to Database-First

## Goal
Eliminate the remaining filesystem dependency in `SessionActionLog._readSessionTitleMap()` by migrating it to query the `KanbanDatabase.plans` table instead of reading `sessions/` and `archive/` directories.

## Background
The SQLite migration (`feature_plan_20260328_131128_finish_sqlite_migration.md`) moved session and activity logging from filesystem to database. However, `_readSessionTitleMap()` still walks the filesystem:

```typescript
const archiveDir = path.join(this.sessionsDir, '..', 'archive');
const archiveEntries = await fs.promises.readdir(archiveDir);
const sessionEntries = await fs.promises.readdir(this.sessionsDir);
```

This was acceptable during the transition window, but represents technical debt. The `KanbanDatabase.plans` table already stores `topic` (the session title) for every plan.

## Implementation

### 1. Add DB-first query to _readSessionTitleMap
**File:** `src/services/SessionActionLog.ts`

Modify `_readSessionTitleMap()` (around line 412) to query the database first:

```typescript
private async _readSessionTitleMap(): Promise<Record<string, string>> {
    const now = Date.now();
    if (now - this._sessionTitleCacheTime < 5000 && this._sessionTitleCache) {
        return this._sessionTitleCache;
    }

    // DB-first: query titles from KanbanDatabase
    const db = await this._ensureDbReady();
    if (db) {
        try {
            const workspaceId = await db.getWorkspaceId() || await db.getDominantWorkspaceId();
            if (workspaceId) {
                const plans = await db.getAllPlans(workspaceId);
                const titleMap: Record<string, string> = {};
                for (const plan of plans) {
                    if (plan.sessionId && plan.topic) {
                        titleMap[plan.sessionId] = plan.topic;
                    }
                }
                this._sessionTitleCache = titleMap;
                this._sessionTitleCacheTime = now;
                return titleMap;
            }
        } catch (e) {
            // Fall through to filesystem fallback during transition
            console.warn('[SessionActionLog] Failed to read titles from DB, falling back to filesystem:', e);
        }
    }

    // DEPRECATED: Filesystem fallback — remove once all legacy files migrated
    // [existing readdir logic remains as fallback]
    return this._readSessionTitleMapFromFilesystem();
}

private async _readSessionTitleMapFromFilesystem(): Promise<Record<string, string>> {
    // [move existing readdir implementation here]
}
```

### 2. Add getAllPlans method if missing
**File:** `src/services/KanbanDatabase.ts`

Ensure `getAllPlans(workspaceId: string)` exists. It should be similar to `getBoard()` but return all plans regardless of status:

```typescript
public async getAllPlans(workspaceId: string): Promise<KanbanPlanRecord[]> {
    if (!(await this.ensureReady()) || !this._db) return [];
    const stmt = this._db.prepare(
        `SELECT ${PLAN_COLUMNS} FROM plans WHERE workspace_id = ? ORDER BY updated_at ASC`,
        [workspaceId]
    );
    return this._readRows(stmt);
}
```

Note: `getAllPlans` may already exist — verify before adding.

### 3. Add migration timeline comment
**File:** `src/services/SessionActionLog.ts`

Add a TECH-DEBT comment above the filesystem fallback:

```typescript
// TECH-DEBT: Filesystem fallback for title map — remove after all legacy .json files purged
// Target removal: 30 days after SQLite migration confirmed stable
```

## Verification Plan

### Automated Tests
- Run `npx tsc --noEmit` — no type errors from new async patterns
- Run `npm test` — existing SessionActionLog tests should pass

### Manual Verification
1. Open Switchboard with a workspace that has active plans
2. Trigger any action that generates an activity event (dispatch, terminal command)
3. Open the Activity feed in the sidebar
4. **Expected:** Activity events display with correct session titles
5. **Failure mode:** If broken, titles show as session IDs or empty strings

### Multi-workspace Verification
1. Open two workspace folders
2. Verify `_readSessionTitleMap` correctly returns titles for the active workspace only
3. Switch between workspaces and verify titles update correctly

## Complexity
- **Scope:** 2 files (`SessionActionLog.ts`, possibly `KanbanDatabase.ts`)
- **Risk:** Low — additive change with fallback; existing behavior preserved if DB fails
- **Dependencies:** SQLite migration must be stable (it is)

## Adversarial Considerations
- **Shape mismatch risk:** `KanbanPlanRecord.topic` vs legacy file `topic` field — verify both sources return same shape
- **Cache invalidation:** The 5-second TTL cache remains; DB query is faster than readdir so no perf concern
- **Workspace isolation:** Must ensure `getAllPlans` filters by correct `workspaceId` to avoid cross-workspace title leakage

## Agent Recommendation
**Send to Coder** — Refactoring within established patterns, clear fallback strategy, well-scoped. No architectural changes.
