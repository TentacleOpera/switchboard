# Fix MERGE Column Persistence When Worktrees Disabled

## Goal
The MERGE column should persist in the kanban board even when worktree mode is disabled, if there are still plans in the MERGE column. Currently, the MERGE column disappears entirely when worktrees are off, causing plans in MERGE to display incorrectly (falling back to 'new' column).

## Metadata
- **Tags:** [bugfix, frontend, ux]
- **Complexity:** 4

## User Review Required
Yes — verify that the proposed conditional MERGE column inclusion logic correctly handles the transition from worktree-enabled to worktree-disabled states without losing plan visibility.

> [!IMPORTANT]
> The plan's proposed `_hasPlansInMergeColumn()` helper originally omitted the required `workspaceId` argument to `db.getAllPlans()`. The corrected implementation below adds an explicit `await db.getWorkspaceId()` call. All 10 call sites of `_buildKanbanColumns()` also require explicit `await` once the method is made async — see the Proposed Changes section for the full enumeration.

## Problem
The MERGE column is only added to the kanban board when worktree mode is enabled:

**File**: `src/services/KanbanProvider.ts`, lines 392-406

```typescript
private _buildKanbanColumns(
    customAgents: CustomAgentConfig[],
    customKanbanColumns: CustomKanbanColumnConfig[] = []
): KanbanColumnDefinition[] {
    const columns = buildKanbanColumns(customAgents, customKanbanColumns, { orderOverrides: this._getEffectiveKanbanOrderOverrides() });
    const workspaceRoot = this._currentWorkspaceRoot;
    if (workspaceRoot && this._worktreeModeEnabledMap.get(workspaceRoot)) {
        const reviewerIdx = columns.findIndex(col => col.id === 'CODE REVIEWED');
        const insertIdx = reviewerIdx !== -1 ? reviewerIdx + 1 : columns.length - 1;
        columns.splice(insertIdx, 0, {
            id: 'MERGE',
            label: 'MERGE',
            role: undefined,
            order: 310,
            kind: 'merge',
            source: 'built-in',
            autobanEnabled: false,
            dragDropMode: 'disabled'
        });
    }
    return columns;
}
```

When worktree mode is disabled (`_worktreeModeEnabledMap.get(workspaceRoot)` returns `false`), the MERGE column is not added to the column list. However, plans that were moved to MERGE while worktree mode was enabled still have `kanban_column = 'MERGE'` in the database. When the column list is rebuilt without MERGE, these plans have no valid column to display in and fall back to the default column (likely 'new').

This causes confusion:
- User completes work and moves plan to MERGE
- User disables worktree mode
- Plan disappears from MERGE column and appears in 'new' column
- User cannot see that the plan is actually in MERGE state
- User may attempt to re-work the plan thinking it's not done

## Root Cause
The MERGE column inclusion logic is purely based on the worktree mode setting, without considering whether there are existing plans in the MERGE column. This creates a state inconsistency where the database contains plans with a column that doesn't exist in the column definition.

## Complexity Audit

### Routine
- DB query pattern (`getWorkspaceId()` + `getAllPlans()`) follows established patterns in the file
- MERGE column insertion logic is unchanged — only the condition wrapping it changes
- `try/catch` returning `false` on error follows the codebase's conservative fallback pattern

### Complex / Risky
- Making `_buildKanbanColumns()` async is a viral signature change: all **10 call sites** require explicit `await` addition — missing any one silently operates on a `Promise` object
- Two call sites chain directly on the return value (`.map()` at line 1279, `.find()` at line 3182) — calling `.map()`/`.find()` on a `Promise` returns `undefined`, not an array error, making it hard to detect without tests
- Each board refresh now triggers an extra `getWorkspaceId()` + `getAllPlans()` DB scan; in workspaces with many plans this may cause a perceptible refresh lag
- The `_mergeColumnCheckCache` invalidation must happen wherever `kanban_column` is written (e.g. card moves) — if invalidation is missed, stale `false` could cause MERGE to disappear prematurely

## Edge-Case & Dependency Audit

### Race Conditions
- `_buildKanbanColumns()` is called twice within the same `try/catch` block (lines 1076 and 1080 in `_refreshBoardImpl()`). After going async, both calls independently hit the DB, which is safe but redundant. No race condition since SQL.js is single-threaded, but back-to-back queries on the same tick is inefficient.
- If the user rapidly toggles worktree mode, multiple refresh events fire. Each refresh independently calls `_hasPlansInMergeColumn()`. Since the DB is the source of truth and the check is read-only, this is safe.

### Security
- None. This is a read-only DB query with no user-controlled inputs.

### Side Effects
- **Existing behavior preserved**: at `_getNextColumnId()` (line 2824), MERGE is still skipped as an auto-advance target when `!planWorktreeId`. This means MERGE will be visible when plans are in it, but cards will NOT auto-advance into it without a worktree. This is correct and intentional behavior — it should be documented in release notes.
- `_buildKanbanColumns()` is used in `_getKanbanColumnIds()` (line 1279) which is used by ClickUp/Linear sync for column ID validation. The async change must propagate correctly or sync will silently receive no column IDs.

### Dependencies & Conflicts
- `KanbanDatabase.getAllPlans(workspaceId: string)` — **requires `workspaceId` parameter** (confirmed from `KanbanDatabase.ts:3082`). The helper must call `await db.getWorkspaceId()` first.
- `KanbanDatabase.getWorkspaceId()` — already used widely in the file; no new dependency.
- `_filterDynamicColumns()` (called at line 1078, immediately after `_buildKanbanColumns()`) — passes the columns array, not `_buildKanbanColumns` itself; no recursive issue.

## Dependencies
- No cross-plan dependencies. This is a self-contained bugfix.

## Adversarial Synthesis
Key risks: (1) the viral async signature change requires all 10 call sites to add `await` — missing even one silently produces a `Promise` object instead of an array, with no TypeScript error in many contexts; (2) `getAllPlans()` requires a `workspaceId` argument that the original proposed helper omitted, which would cause a runtime type error. Mitigations: the Proposed Changes section below explicitly lists every call site change with before/after code, and the corrected `_hasPlansInMergeColumn` implementation includes the required `getWorkspaceId()` call; a `_mergeColumnCheckCache` is added to limit DB scan frequency.

## Proposed Changes

### `src/services/KanbanProvider.ts`

#### Step 1 — Add `_mergeColumnCheckCache` private field (near line 139)

Add after `private _worktreeModeEnabledMap = new Map<string, boolean>();`:

```typescript
// Cache: workspaceRoot → boolean (true if any plan in MERGE column)
// Invalidated on any column move or board refresh.
private _mergeColumnCheckCache = new Map<string, boolean | null>();
```

#### Step 2 — Add `_hasPlansInMergeColumn()` helper (near line 387, before `_buildKanbanColumns`)

**Corrected implementation** (fixes missing `workspaceId` argument from original plan):

```typescript
/**
 * Check if there are any active plans in the MERGE column for the current workspace.
 * Used to determine whether to show the MERGE column even when worktree mode is disabled.
 * Returns false on any error (conservative — if we can't check, don't show the column).
 */
private async _hasPlansInMergeColumn(workspaceRoot: string): Promise<boolean> {
    const cached = this._mergeColumnCheckCache.get(workspaceRoot);
    if (cached !== null && cached !== undefined) { return cached; }
    try {
        const db = this._getKanbanDb(workspaceRoot);
        if (!db || !await db.ensureReady()) {
            this._mergeColumnCheckCache.set(workspaceRoot, false);
            return false;
        }
        const workspaceId = await db.getWorkspaceId();
        if (!workspaceId) {
            this._mergeColumnCheckCache.set(workspaceRoot, false);
            return false;
        }
        const plans = await db.getAllPlans(workspaceId);
        const result = plans.some(plan => plan.kanbanColumn === 'MERGE');
        this._mergeColumnCheckCache.set(workspaceRoot, result);
        return result;
    } catch {
        this._mergeColumnCheckCache.set(workspaceRoot, false);
        return false;
    }
}
```

**Add cache invalidation** in `_refreshBoardImpl()` (or any method that moves cards) — add at the start of board refresh:
```typescript
// Invalidate MERGE column check cache on each refresh
this._mergeColumnCheckCache.delete(resolvedWorkspaceRoot);
```

#### Step 3 — Update `_buildKanbanColumns()` signature to `async` (line 387)

**Current**:
```typescript
private _buildKanbanColumns(
    customAgents: CustomAgentConfig[],
    customKanbanColumns: CustomKanbanColumnConfig[] = []
): KanbanColumnDefinition[] {
```

**Proposed**:
```typescript
private async _buildKanbanColumns(
    customAgents: CustomAgentConfig[],
    customKanbanColumns: CustomKanbanColumnConfig[] = []
): Promise<KanbanColumnDefinition[]> {
```

#### Step 4 — Update MERGE inclusion condition (lines 392-406)

**Current**:
```typescript
const workspaceRoot = this._currentWorkspaceRoot;
if (workspaceRoot && this._worktreeModeEnabledMap.get(workspaceRoot)) {
    const reviewerIdx = columns.findIndex(col => col.id === 'CODE REVIEWED');
    const insertIdx = reviewerIdx !== -1 ? reviewerIdx + 1 : columns.length - 1;
    columns.splice(insertIdx, 0, {
        id: 'MERGE',
        label: 'MERGE',
        role: undefined,
        order: 310,
        kind: 'merge',
        source: 'built-in',
        autobanEnabled: false,
        dragDropMode: 'disabled'
    });
}
```

**Proposed**:
```typescript
const workspaceRoot = this._currentWorkspaceRoot;
// Show MERGE column if worktree mode is enabled OR if there are existing plans in MERGE.
// This prevents plans from disappearing when the user disables worktree mode.
const worktreeEnabled = workspaceRoot && this._worktreeModeEnabledMap.get(workspaceRoot);
const hasMergePlans = workspaceRoot ? await this._hasPlansInMergeColumn(workspaceRoot) : false;
if (worktreeEnabled || hasMergePlans) {
    const reviewerIdx = columns.findIndex(col => col.id === 'CODE REVIEWED');
    const insertIdx = reviewerIdx !== -1 ? reviewerIdx + 1 : columns.length - 1;
    columns.splice(insertIdx, 0, {
        id: 'MERGE',
        label: 'MERGE',
        role: undefined,
        order: 310,
        kind: 'merge',
        source: 'built-in',
        autobanEnabled: false,
        dragDropMode: 'disabled'
    });
}
```

#### Step 5 — Update ALL 10 call sites to add `await`

Each call site below must be updated from `this._buildKanbanColumns(...)` to `await this._buildKanbanColumns(...)`.

**Line 1076** (inside `_refreshBoardImpl()` try block):
```typescript
// Before:
columns = this._buildKanbanColumns(customAgents, customKanbanColumns);
// After:
columns = await this._buildKanbanColumns(customAgents, customKanbanColumns);
```

**Line 1080** (inside `_refreshBoardImpl()` catch block):
```typescript
// Before:
columns = this._buildKanbanColumns([]);
// After:
columns = await this._buildKanbanColumns([]);
```

**Line 1279** (inside `_getKanbanColumnIds()` — ⚠️ chained `.map()` on return value):
```typescript
// Before:
return this._buildKanbanColumns(customAgents, customKanbanColumns).map((column) => column.id);
// After:
return (await this._buildKanbanColumns(customAgents, customKanbanColumns)).map((column) => column.id);
```

**Line 1738** (inside async method):
```typescript
// Before:
const columns = this._buildKanbanColumns(customAgents, customKanbanColumns);
// After:
const columns = await this._buildKanbanColumns(customAgents, customKanbanColumns);
```

**Line 1892** (inside `_exportKanbanBoard()`):
```typescript
// Before:
const columns = this._buildKanbanColumns(customAgents, customKanbanColumns);
// After:
const columns = await this._buildKanbanColumns(customAgents, customKanbanColumns);
```

**Line 2824** (inside `_getNextColumnId()`):
```typescript
// Before:
const allColumns = this._buildKanbanColumns(customAgents, customKanbanColumns);
// After:
const allColumns = await this._buildKanbanColumns(customAgents, customKanbanColumns);
```

**Line 2901** (inside `_generatePromptForColumn()`):
```typescript
// Before:
const allColumns = this._buildKanbanColumns(customAgents, customKanbanColumns);
// After:
const allColumns = await this._buildKanbanColumns(customAgents, customKanbanColumns);
```

**Line 3182** (inside `_resolveKanbanDispatchSpec()` — ⚠️ chained `.find()` on return value):
```typescript
// Before:
const column = this._buildKanbanColumns(customAgents, customKanbanColumns)
    .find((entry) => entry.id === targetColumn);
// After:
const column = (await this._buildKanbanColumns(customAgents, customKanbanColumns))
    .find((entry) => entry.id === targetColumn);
```

**Line 3250** (inside `_syncCustomAgentsAndColumns()`):
```typescript
// Before:
const columns = this._buildKanbanColumns(customAgents, customKanbanColumns);
// After:
const columns = await this._buildKanbanColumns(customAgents, customKanbanColumns);
```

**Line 6731** (inside `_autoCreateWorktree()`):
```typescript
// Before:
const columnDefs = this._buildKanbanColumns(
    await this._getCustomAgents(workspaceRoot),
    await this._getCustomKanbanColumns(workspaceRoot)
);
// After:
const columnDefs = await this._buildKanbanColumns(
    await this._getCustomAgents(workspaceRoot),
    await this._getCustomKanbanColumns(workspaceRoot)
);
```

> [!NOTE]
> Line 3279 (`const builtInRoles = buildKanbanColumns([]).map(...)`) uses the free function `buildKanbanColumns`, not `this._buildKanbanColumns()`. **No change needed there.**

## Verification Plan

### Automated Tests
- No automated tests added (test suite to be run separately by user).

### Manual Verification
1. Enable worktree mode in a workspace
2. Create a plan and move it through the pipeline to MERGE
3. Disable worktree mode
4. Verify the MERGE column still appears in the kanban board
5. Verify the plan is still visible in the MERGE column
6. Move the plan from MERGE to COMPLETED
7. Verify the MERGE column disappears (no plans in MERGE, worktree mode disabled)
8. Re-enable worktree mode
9. Verify the MERGE column reappears

### Edge Case Testing
1. Test with multiple plans in MERGE column when worktree mode is disabled → verify all remain visible
2. Test with plans in MERGE column across multiple workspaces → verify each workspace checks its own database
3. Test with database unavailable → verify MERGE column is not shown (conservative fallback)
4. Test rapid toggle of worktree mode → verify column state updates correctly without race conditions
5. **New**: Verify ClickUp/Linear sync still resolves correct column IDs (exercises `_getKanbanColumnIds()` at line 1279)
6. **New**: Verify drag-drop dispatch still works (exercises `_resolveKanbanDispatchSpec()` at line 3182)

## Acceptance Criteria
- [ ] MERGE column persists when worktree mode is disabled if there are plans in MERGE
- [ ] Plans in MERGE column remain visible after worktree mode is disabled
- [ ] MERGE column disappears when worktree mode is disabled AND no plans are in MERGE
- [ ] MERGE column reappears when worktree mode is re-enabled
- [ ] No regression in normal worktree mode workflow
- [ ] Database errors during MERGE check are handled gracefully (column not shown)
- [ ] ClickUp/Linear sync column ID resolution unaffected (line 1279 await correct)
- [ ] Drag-drop dispatch column resolution unaffected (line 3182 await correct)

## Recommendation
Complexity 4 → **Send to Coder**
