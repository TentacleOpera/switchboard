# Fix: Archived Plans Leave Ghost kanban_column — Invisible in UI, Visible in DB Queries

## Goal

When a plan is archived (e.g. decomposed into an epic + subtasks), its `status` is set to `archived` but its `kanban_column` is left at whatever column it was in (e.g. `PLAN REVIEWED`). The board UI filters by `status = 'active'`, so the plan becomes invisible on the board — but it still exists in the DB with its old column, creating a "ghost" that confuses any tool or query that doesn't filter by status. This plan fixes the inconsistency by ensuring archiving a plan also moves it to a terminal column (`COMPLETED`) or clears its `kanban_column`, so the DB state matches the UI state.

### Problem Analysis & Root Cause

**The specific case that exposed this:**

Plan `7b8e38de` ("Epic Worktree Modes & Ultracode/Goal Directive Scoping") was decomposed into epic `8b50c095` + 5 subtask plans. During decomposition, the original plan's `status` was set to `archived` (via a manifest entry or `TaskViewerProvider._setPlanStatus`). However, its `kanban_column` remained `PLAN REVIEWED` and its `last_action` remained `move-to-plan-reviewed`.

**DB state:**
```
plan_id:     7b8e38de-...
kanban_column: PLAN REVIEWED
status:      archived
last_action: move-to-plan-reviewed
```

**The board UI** (`getPlansByColumn`, `KanbanDatabase.ts:2755-2779`) queries `WHERE status = 'active' AND kanban_column = ?` for non-COMPLETED columns. Since `status = 'archived'`, the plan is filtered out — invisible on the board.

**But the plan is NOT in the COMPLETED column either** — `getPlansByColumn` for COMPLETED queries `WHERE status = 'completed'`. Since `status = 'archived'` (not `completed`), the plan is invisible there too.

**Result:** the plan is a ghost — present in the DB, assigned to a column, but invisible on every board surface. It only appears in the TaskViewer Archive/Recovery UI (`TaskViewerProvider.ts:11724`), which explicitly queries `status = 'archived'` or `status = 'orphan'`.

**Root cause:** The archive operation sets `status = 'archived'` but does not update `kanban_column` or `last_action`. There is no code path that moves an archived plan to a terminal column or clears its column assignment. The `updateStatus()` / `updateStatusByPlanFile()` methods (`KanbanDatabase.ts:1840`, `:1830`) are one-dimensional — they update only `status` and `updated_at`, leaving `kanban_column` stale.

**Why this matters beyond the single case:**
- Any tool that queries the DB by `kanban_column` without a `status` filter (like my `group-into-epics` DB query did) will see ghost plans.
- The kanban-state file export (`exportStateToFile`) correctly filters by `status = 'active'` (via `getBoard()`), so ghosts don't appear in the files — but direct DB queries are unguarded.
- The Archive/Recovery UI shows the plan in its old column, which is confusing — the user archived it, but it appears to still be "in" PLAN REVIEWED.

## Metadata
- **Tags:** bug, backend, kanban, archive, status, ghost-plan
- **Complexity:** 3

## Complexity Audit

### Routine
- Adding a `kanban_column` update alongside the `status` update in the archive path
- Updating `last_action` to reflect the archive operation

### Complex / Risky
- **Whether to move archived plans to COMPLETED or clear their column.** Moving to COMPLETED is misleading — the plan wasn't completed, it was archived/superseded. Clearing the column (setting to `''` or a dedicated `ARCHIVED` column) is more accurate but may break code that assumes every plan has a valid column. The safest approach: set `kanban_column = 'COMPLETED'` (since COMPLETED already shows `status = 'completed'` plans, and archived plans won't appear there either) — OR introduce an `ARCHIVED` pseudo-column. Given the existing column set is fixed and UI-rendered, setting `kanban_column = 'COMPLETED'` is the least disruptive option that at least puts the ghost in the right "terminal" bucket.
- **Actually, the cleaner fix:** Don't move the column at all. Instead, ensure the `last_action` is updated to `archived` so the ghost is self-documenting, and ensure all DB query paths that surface plans to tools filter by `status = 'active'`. The ghost is only visible to direct DB queries — the UI already handles it correctly. The real fix is to make the ghost's state self-consistent (update `last_action`) and to ensure no code path surfaces archived plans without explicitly intending to.

## Edge-Case & Dependency Audit
- **Plans archived via manifest:** `PlanManifestService.ts:231-233` calls `db.updateStatusByPlanFile(entry.planFile, workspaceId, entry.status)`. This path sets `status` but not `kanban_column` or `last_action`. The fix should be in `updateStatusByPlanFile` or in a new `archivePlan` method that updates all three fields.
- **Plans archived via TaskViewerProvider:** `TaskViewerProvider.ts:11687-11690` calls `db.updateStatus(sessionId, dbStatus)`. Same gap — only `status` is updated.
- **Plans archived via the board UI (Archive button):** Need to check if the board's archive button goes through a different path. If it moves the card to COMPLETED first and then archives, the column is already correct. If it archives in-place, same bug.
- **V10 migration precedent:** `KanbanDatabase.ts:4672-4690` already repairs `status = 'archived' AND kanban_column = 'COMPLETED'` rows by flipping status to `completed`. This confirms the system has historically conflated archived and completed. A new migration could repair ghost rows where `status = 'archived' AND kanban_column != 'COMPLETED'`.
- **Published extension (~4,000 installs):** Any existing install may have ghost plans. A migration that repairs them is safe — it only moves archived plans to COMPLETED or updates `last_action`, neither of which affects what the user sees (archived plans are already invisible on the board).

## Proposed Changes

### 1. Add `last_action` update to the status-update methods

**File:** `src/services/KanbanDatabase.ts`

In `updateStatusByPlanFile()` (~line 1830) and `updateStatus()` (~line 1840), update `last_action` alongside `status`:

```typescript
// updateStatusByPlanFile (~line 1833)
return this._persistedUpdate(
    'UPDATE plans SET status = ?, last_action = ?, updated_at = ? WHERE plan_file = ? AND workspace_id = ?',
    [status, `status-changed-to-${status}`, new Date().toISOString(), normalized, workspaceId]
);
```

This makes the ghost self-documenting — a DB query can see that the plan was archived (`last_action = 'status-changed-to-archived'`) rather than thinking it was last moved to PLAN REVIEWED.

### 2. Add a one-time repair migration for existing ghost plans

**File:** `src/services/KanbanDatabase.ts` (in the migration chain, after the latest migration)

Add a migration that repairs ghost plans — archived plans with a non-COMPLETED `kanban_column`:

```typescript
// V<N>: repair ghost plans — archived plans left in non-terminal columns
try {
    const ghostStmt = this._db.prepare(
        "SELECT COUNT(*) as cnt FROM plans WHERE status = 'archived' AND kanban_column != 'COMPLETED'"
    );
    let ghostCount = 0;
    try {
        if (ghostStmt.step()) {
            ghostCount = Number(ghostStmt.getAsObject().cnt || 0);
        }
    } finally {
        ghostStmt.free();
    }
    if (ghostCount > 0) {
        this._db.exec(
            "UPDATE plans SET kanban_column = 'COMPLETED', last_action = 'archived-ghost-repaired' WHERE status = 'archived' AND kanban_column != 'COMPLETED'"
        );
        console.log(`[KanbanDatabase] V<N> migration: repaired ${ghostCount} archived ghost plan(s) left in non-COMPLETED columns`);
    }
} catch (e) {
    console.error(`[KanbanDatabase] V<N> archived-ghost repair failed:`, e);
}
```

This moves all existing ghost plans to COMPLETED, which is the terminal column. They remain invisible on the board (COMPLETED shows `status = 'completed'`, not `archived`), but their DB state is now consistent — no plan claims to be in PLAN REVIEWED when it's actually archived.

### 3. Ensure archiving sets `kanban_column` to COMPLETED going forward

**File:** `src/services/KanbanDatabase.ts`

Add a new method that archives a plan properly — updating status, column, and last_action in one call:

```typescript
public async archivePlan(planFile: string, workspaceId: string): Promise<boolean> {
    if (!(await this.ensureReady()) || !this._db) return false;
    const normalized = this._ensureRelativePlanFile(planFile);
    return this._persistedUpdate(
        'UPDATE plans SET status = ?, kanban_column = ?, last_action = ?, updated_at = ? WHERE plan_file = ? AND workspace_id = ?',
        ['archived', 'COMPLETED', 'archived', new Date().toISOString(), normalized, workspaceId]
    );
}
```

Then update the callers:

**File:** `src/services/PlanManifestService.ts` (~line 231-233)

When `entry.status === 'archived'`, call `db.archivePlan()` instead of `db.updateStatusByPlanFile()`:

```typescript
if (entry.status === 'archived') {
    const ok = await db.archivePlan(entry.planFile, workspaceId);
    // ...
} else {
    const ok = await db.updateStatusByPlanFile(entry.planFile, workspaceId, entry.status as ...);
    // ...
}
```

**File:** `src/services/TaskViewerProvider.ts` (~line 11687-11690)

When `dbStatus === 'archived'`, call `db.archivePlan()` instead of `db.updateStatus()`:

```typescript
if (dbStatus === 'archived') {
    const plan = await db.getPlanBySessionId(sessionId);
    if (plan) {
        await db.archivePlan(plan.planFile, plan.workspaceId);
    }
} else {
    await db.updateStatus(sessionId, dbStatus as KanbanPlanRecord['status']);
}
```

### 4. Clean up the specific ghost plan in this workspace

**One-time DB fix (not shipped code):**

```sql
UPDATE plans SET kanban_column = 'COMPLETED', last_action = 'archived-ghost-repaired' 
WHERE plan_id = '7b8e38de-f711-48d8-8e5c-73467a8edeb0';
```

This repairs the specific ghost that exposed the bug. The migration in step 2 will handle any others across the install base.

## Verification Plan

1. **Ghost repair migration:** Run the migration on a DB with the ghost plan → verify `kanban_column` changes from `PLAN REVIEWED` to `COMPLETED` and `last_action` changes to `archived-ghost-repaired`.
2. **Board UI unaffected:** After the migration, verify the board UI still shows the same plans (the ghost was already invisible — it should remain invisible, now in COMPLETED where `status = 'completed'` is required, so it's still filtered out).
3. **Archive via manifest:** Create a plan, then ingest a manifest with `status: 'archived'` → verify the plan's `kanban_column` is set to `COMPLETED`, `status` is `archived`, and `last_action` is `archived`.
4. **Archive via TaskViewer:** Archive a plan via the TaskViewer recovery UI → verify same DB state.
5. **Direct DB query consistency:** After archiving, query `SELECT * FROM plans WHERE kanban_column = 'PLAN REVIEWED'` → the archived plan should NOT appear (it's now in COMPLETED).
6. **No regression on active plans:** Verify active plans are unaffected — their `kanban_column`, `status`, and `last_action` remain unchanged.

## Acceptance
- Archiving a plan (via manifest or TaskViewer) sets `kanban_column = 'COMPLETED'`, `status = 'archived'`, and `last_action = 'archived'` in a single operation.
- A one-time migration repairs all existing ghost plans (archived plans in non-COMPLETED columns) by moving them to COMPLETED.
- No archived plan remains in a non-COMPLETED column after the migration.
- The board UI is unaffected (archived plans were already invisible; they remain invisible).
- Direct DB queries by `kanban_column` no longer surface archived plans in pre-coding columns.
