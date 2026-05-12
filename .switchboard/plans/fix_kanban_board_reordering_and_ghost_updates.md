# Fix Kanban Board Reordering and Ghost Timestamp Updates

## Goal

Eliminate spontaneous kanban card reordering, phantom "just now" timestamps, and unwanted CREATED-column migrations by fixing path-normalization churn, excessive sync frequency, unstable column sorting, and missing kanban-column inheritance for ingested plans.

## Metadata

- **Tags:** frontend, backend, database, UI, bugfix, workflow
- **Complexity:** 6

## User Review Required

No — this is a pure bugfix with no product-level changes.

## Complexity Audit

### Routine
- Inline path-normalization helper in `_reviveDeletedLocalPlanForPath`.
- Optional `skipTimestampUpdate` parameter on `KanbanDatabase.updatePlanFile`.
- `anyMirrorChanged` gate in `_syncConfiguredPlanFolder`.
- Add `createdAt` to `KanbanCard` interface and `KanbanProvider.refreshWithData` mapping.
- Update kanban HTML sort comparator.

### Complex / Risky
- **Fix #5 (kanban-column inheritance for ingested plans):** Requires adding a DB query by `brain_source_path`, threading `managedImportSourcePath` through `_registerPlan`, and ensuring the lookup happens BEFORE `sessionId` generation. Multi-method coordination across `TaskViewerProvider` and `KanbanDatabase`.
- **Stable-sort edge cases:** Legacy rows may have malformed `createdAt`; the comparator must handle `NaN` gracefully to avoid silent sort inversion.

## Edge-Case & Dependency Audit

- **Race Conditions:** `_reviveDeletedLocalPlanForPath` runs during sync, not during user edits, so `skipTimestampUpdate` cannot swallow a genuine user edit. However, if a user edits a plan file while sync is in flight, the sync-cycle `updated_at` may still jitter. This is acceptable because the sync cycle is read-only with respect to content; only path metadata changes.
- **Security:** No external input is parsed; all paths come from the local filesystem watcher or `path.relative`.
- **Side Effects:** Skipping `_syncFilesAndRefreshRunSheets` when no mirror changed means the sidebar will NOT receive a heavy resync. The sidebar is already refreshed via `_refreshRunSheets` (DB-read-only), so this is safe. If `cleanupMissingManagedImports` is true, the heavy sync still runs because deletions mutate DB state.
- **Dependencies & Conflicts:**
  - `KanbanCard` type change affects `KanbanProvider.ts` and `kanban.html`. No other consumers reference `KanbanCard`.
  - `_registerPlan` signature change (adding `brainSourcePath` to `PlanRegistryEntry`) is internal only; no external callers pass this field today.

## Dependencies

None — this plan has no external blockers.

## Adversarial Synthesis

Key risks: (1) Path normalization on legacy absolute-path DB rows may incorrectly suppress needed updates; mitigated by limiting normalization to `./`, trailing-slash, and backslash differences. (2) `createdAt` must be wired through `KanbanCard` and `refreshWithData` or the sort comparator will silently receive `undefined`; mitigated by explicit `NaN` fallback to 0. (3) Fix #5 requires a new DB query method and cross-method wiring that is easy to miss; mitigated by step-by-step implementation detail below.

## Problem

The kanban board is constantly reordering itself. Every card shows "just now" as its timestamp even though no one edited those plans. Plans also spontaneously appear in the CREATED ("new") column.

## Root Cause

Two interacting bugs:

1. **Ghost `updated_at` bumps on every sync cycle**: `_syncConfiguredPlanFolder` → `_syncFilesAndRefreshRunSheets` → `_collectAndSyncKanbanSnapshot` → `_reconcileOnDiskLocalPlanFiles` → `_reviveDeletedLocalPlanForPath`. Inside `_reviveDeletedLocalPlanForPath` there is a path-mismatch guard that calls `db.updatePlanFile(...)` whenever `activeEntry.planFile !== normalizedRelativePath`. `updatePlanFile()` sets `updated_at = new Date().toISOString()`. Because the DB queries and the frontend both sort by `updated_at DESC`, every affected card jumps to the top and displays "just now".

2. **Ingested/mirror plans default to CREATED**: `_syncConfiguredPlanFolder` uses `_isLikelyPlanFile(filePath, { isAdditionalFolder: true })`, which relaxes validation and accepts any `.md` file. When a new mirror is created, `_handlePlanCreation` is called and the plan defaults to the CREATED column, even if the source already had a kanban column assignment elsewhere.

3. **Sync runs too frequently**: The additional-plan-folder watcher debounces at 300 ms, and `_syncConfiguredPlanFolder` unconditionally calls `_syncFilesAndRefreshRunSheets` at the end, triggering the heavy snapshot sync even when nothing actually changed.

## Proposed Changes

### `src/services/TaskViewerProvider.ts`

#### Fix 1 — Harden `_reviveDeletedLocalPlanForPath` path comparison

**Context** (~line 9887): `_reviveDeletedLocalPlanForPath` compares `activeEntry.planFile` against `normalizedRelativePath` with a plain string inequality. Because both values may differ only by `./` prefix, trailing slash, or Windows backslash, the guard fires on every sync cycle and bumps `updated_at`.

**Logic**: Normalize both sides with the same helper before comparing. If the only difference is formatting, skip the `updatePlanFile` call entirely.

**Implementation**:
```typescript
// Inside _reviveDeletedLocalPlanForPath (~line 9887)
const normalizeForCompare = (p: string) =>
    p.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
const storedNormalized = normalizeForCompare(activeEntry.planFile);
const desiredNormalized = normalizeForCompare(normalizedRelativePath);
if (storedNormalized !== desiredNormalized) {
    await db.updatePlanFile(activeEntry.sessionId, normalizedRelativePath);
}
```

**Edge Cases**:
- If both normalize to empty string (e.g., legacy root-level paths), do NOT skip the update; empty-string equality does not prove the paths are semantically identical.
- Case-sensitive filesystems: the helper intentionally does NOT lowercase paths, because `Foo.md` and `foo.md` could be different files.

#### Fix 3 — Reduce unnecessary sync churn in `_syncConfiguredPlanFolder`

**Context** (~line 8646): The method unconditionally calls `_syncFilesAndRefreshRunSheets` at the end, even when every mirror was skipped because it already matched the source.

**Logic**: Track whether any `fs.promises.writeFile` actually executed, and gate the heavy sync on that flag or on `cleanupMissingManagedImports`.

**Implementation**:
```typescript
// At the top of _syncConfiguredPlanFolder (~line 8512)
let anyMirrorChanged = false;

// Inside the writeFile branch (~line 8614)
await fs.promises.writeFile(mirrorPath, content);
anyMirrorChanged = true;

// At the end of the method, replace line 8646:
if (anyMirrorChanged || cleanupMissingManagedImports) {
    await this._syncFilesAndRefreshRunSheets(workspaceRoot);
}
```

**Edge Cases**:
- If a mirror is deleted by `cleanupMissingManagedImports`, the heavy sync must still run because DB state changed.
- If no mirrors changed and no cleanup ran, the sidebar is still refreshed by `_refreshRunSheets` via DB snapshot, so UI consistency is preserved.

---

#### Fix 5 — Preserve existing kanban column for ingested/mirror plans

**Context** (~line 11288): When `_handlePlanCreation` creates a new ingested mirror, it generates a fresh `sessionId` and passes it to `_registerPlan`. Because no existing DB row has that new `sessionId`, `_registerPlan` defaults `kanbanColumn` to `'CREATED'` (line 9148), even if the source plan was already assigned to another column.

**Logic**: Before generating the new `sessionId`, query the DB for an existing plan whose `brain_source_path` matches `managedImportSourcePath`. If found, use its `kanbanColumn` instead of `'CREATED'`. Thread `managedImportSourcePath` through to `_registerPlan` so the new row stores the linkage.

**Implementation**:

1. Add to `KanbanDatabase.ts` (~after `getPlanByPlanFile`):
```typescript
public async getPlanByBrainSourcePath(brainSourcePath: string, workspaceId: string): Promise<KanbanPlanRecord | null> {
    if (!(await this.ensureReady()) || !this._db) return null;
    const normalized = this._ensureRelativePlanFile(brainSourcePath);
    const stmt = this._db.prepare(
        `SELECT ${PLAN_COLUMNS} FROM plans
         WHERE workspace_id = ? AND status = 'active' AND brain_source_path = ?
         ORDER BY updated_at DESC LIMIT 1`,
        [workspaceId, normalized]
    );
    const rows = this._readRows(stmt);
    return rows.length > 0 ? rows[0] : null;
}
```

2. In `_handlePlanCreation` (~line 11170), after `db` and `workspaceId` are resolved:
```typescript
let inheritedKanbanColumn: string | undefined;
if (managedImportSourcePath && db && workspaceId) {
    const existingBySource = await db.getPlanByBrainSourcePath(managedImportSourcePath, workspaceId);
    if (existingBySource) {
        inheritedKanbanColumn = existingBySource.kanbanColumn;
    }
}
```

3. Thread `managedImportSourcePath` into `_registerPlan` (~line 11288):
```typescript
await this._registerPlan(resolvedWorkspaceRoot, {
    planId: sessionId,
    ownerWorkspaceId: wsId,
    sourceType: 'local',
    localPlanPath: normalizedPlanFileRelative,
    brainSourcePath: managedImportSourcePath || '',
    topic,
    createdAt: new Date(fileCreationTimeMs).toISOString(),
    updatedAt: new Date().toISOString(),
    status: 'active',
    kanbanColumn: inheritedKanbanColumn
});
```

4. Update `PlanRegistryEntry` type (~search in `TaskViewerProvider.ts` or a shared types file) to include optional `brainSourcePath?: string` and `kanbanColumn?: string`.

5. Update `_registerPlan` (~line 9148) to use the passed column:
```typescript
kanbanColumn: entry.kanbanColumn || existing?.kanbanColumn || 'CREATED',
```

**Edge Cases**:
- If multiple source plans share the same `brain_source_path`, the query uses `updated_at DESC LIMIT 1` to pick the most recently touched one. This is a best-effort heuristic; true duplicates should be prevented upstream.
- If the existing plan is `deleted`/`archived`, the query won't find it because of `status = 'active'`. This is intentional: we don't want to resurrect old column assignments for re-ingested plans.

### `src/services/KanbanDatabase.ts`

#### Fix 2 — Make `updatePlanFile` preserve timestamps for normalization-only changes

**Context** (lines 1137–1149): `updatePlanFile` unconditionally sets `updated_at = new Date().toISOString()`. When called from `_reviveDeletedLocalPlanForPath` for a pure path-normalization fix, this produces the ghost timestamp bump.

**Logic**: Add an optional `skipTimestampUpdate` parameter. When true, omit `updated_at` from the `UPDATE` statement.

**Implementation**:
```typescript
public async updatePlanFile(sessionId: string, planFile: string, skipTimestampUpdate?: boolean): Promise<boolean> {
    console.log(`[KanbanDatabase] updatePlanFile: sessionId=${sessionId}, planFile=${planFile}, skipTimestampUpdate=${skipTimestampUpdate}`);
    const sql = skipTimestampUpdate
        ? 'UPDATE plans SET plan_file = ? WHERE session_id = ?'
        : 'UPDATE plans SET plan_file = ?, updated_at = ? WHERE session_id = ?';
    const params = skipTimestampUpdate
        ? [this._ensureRelativePlanFile(planFile), sessionId]
        : [this._ensureRelativePlanFile(planFile), new Date().toISOString(), sessionId];
    const result = this._persistedUpdate(sql, params);
    // ...existing VERIFY block remains unchanged...
    return result;
}
```

Then update the call in `_reviveDeletedLocalPlanForPath`:
```typescript
await db.updatePlanFile(activeEntry.sessionId, normalizedRelativePath, true);
```

**Edge Cases**:
- The VERIFY log still runs after the update, so the change is auditable.
- If a caller accidentally passes `skipTimestampUpdate = true` for a genuine rename, the timestamp stays old. This is low-risk because `updatePlanFile` is only called from two places: `_reviveDeletedLocalPlanForPath` (safe) and `_mirrorBrainPlan` (should NOT skip timestamp because mirror creation is a real event).

### `src/services/KanbanProvider.ts`

#### Fix 4a — Add `createdAt` to `KanbanCard` and `refreshWithData`

**Context** (lines 79–89): `KanbanCard` does not carry `createdAt`, so the kanban webview cannot sort by it. `refreshWithData` (lines 815–842) maps DB rows to cards but omits `createdAt`.

**Logic**: Add `createdAt` to the interface and populate it from `row.createdAt`.

**Implementation**:
```typescript
// Lines 79–89
export interface KanbanCard {
    sessionId: string;
    topic: string;
    planFile: string;
    column: KanbanColumn;
    lastActivity: string;
    createdAt: string;
    complexity: string;
    workspaceRoot: string;
    dependencies: string[];
    hasBlockingDependencies: boolean;
}
```

```typescript
// Inside refreshWithData (~line 815)
return {
    sessionId: row.sessionId,
    topic: row.topic || row.planFile || 'Untitled',
    planFile: row.planFile || '',
    column: this._normalizeLegacyKanbanColumn(row.kanbanColumn) || 'CREATED',
    lastActivity: row.updatedAt || row.createdAt || '',
    createdAt: row.createdAt || '',
    complexity: row.complexity || 'Unknown',
    workspaceRoot: resolvedWorkspaceRoot,
    dependencies: deps,
    hasBlockingDependencies: deps.length > 0
};
```

Do the same for the `completedRows` mapping (~line 832).

**Edge Cases**:
- Legacy rows with empty `createdAt` will default to `''`; the sort comparator in `kanban.html` handles this by falling back to `0`.

### `src/webview/kanban.html`

#### Fix 4b — Add stable sort key to kanban columns

**Context** (~line 3806): Non-planning columns sort by `_ts` (`lastActivity` / `updated_at`) only. Every background timestamp bump reorders the entire column.

**Logic**: Sort by `createdAt` ascending first (stable chronological order), then by `_ts` descending (most recent activity within the same creation cohort).

**Implementation**:
```typescript
// Lines 3806–3808
const sortedItems = isPlanningColumn
    ? sortColumnByDependencies(items)
    : [...items].sort((a, b) => {
        const createdA = a.createdAt ? new Date(a.createdAt).getTime() : 0;
        const createdB = b.createdAt ? new Date(b.createdAt).getTime() : 0;
        if (isNaN(createdA) || isNaN(createdB)) {
            // Malformed dates: fall back to _ts-only sort
            return (b._ts || 0) - (a._ts || 0);
        }
        if (createdA !== createdB) return createdA - createdB;
        return (b._ts || 0) - (a._ts || 0);
    });
```

**Edge Cases**:
- `createdAt` is an ISO string from the DB; `new Date(...)` should always parse it, but `isNaN` guards against hypothetical corruption.
- If both `createdAt` values are identical (e.g., plans created in the same millisecond), `_ts` breaks the tie.

## Verification Plan

### Automated Tests

1. **Path normalization unit test** (`TaskViewerProvider` mock or helper extraction):
   - Input: `activeEntry.planFile = './plans/foo.md'`, `normalizedRelativePath = 'plans/foo.md'`
   - Expect: `updatePlanFile` is NOT called.
   - Input: `activeEntry.planFile = 'plans/foo.md'`, `normalizedRelativePath = 'plans/bar.md'`
   - Expect: `updatePlanFile` IS called.

2. **`updatePlanFile` timestamp preservation test** (`KanbanDatabase.test.ts`):
   - Call `updatePlanFile(sessionId, 'foo.md', true)` and verify the DB row retains its original `updated_at`.
   - Call `updatePlanFile(sessionId, 'foo.md')` and verify `updated_at` changes.

3. **Stable sort unit test** (`kanban.html` sort comparator extracted to testable function):
   - Cards with `createdAt: '2024-01-01'` and `createdAt: '2024-01-02'` should sort chronologically regardless of `_ts`.
   - Cards with identical `createdAt` should sort by `_ts` descending.
   - Cards with `createdAt: ''` should not throw and should fall back to `_ts` sort.

4. **Kanban column inheritance integration test**:
   - Create a source plan in the DB with `brain_source_path = '/external/plans/source.md'` and `kanban_column = 'PLAN REVIEWED'`.
   - Trigger `_handlePlanCreation` for a new mirror with `managedImportSourcePath = '/external/plans/source.md'`.
   - Assert the new DB row has `kanban_column = 'PLAN REVIEWED'`.

### Manual Steps
1. Open the kanban board and note the current order of cards.
2. Wait 30 seconds without touching any plan files.
3. Observe that cards do **not** reorder themselves and timestamps remain stable.
4. Add a new `.md` file to the additional plan folder and verify it appears in CREATED exactly once.
5. Move a plan to another column and verify it stays there after the next sync cycle.

---

**Recommendation:** Complexity is 6. Send to Coder.
