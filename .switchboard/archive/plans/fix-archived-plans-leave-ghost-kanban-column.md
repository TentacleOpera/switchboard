# Fix: Archived Plans Leave Ghost kanban_column — Invisible in UI, Visible in DB Queries

**Plan ID:** 7c1a2b3c-4d5e-6f70-8190-1234567890ab

## Goal

When a plan is archived (e.g. decomposed into an epic + subtasks), its `status` is set to `archived` but its `kanban_column` is left at whatever column it was in (e.g. `PLAN REVIEWED`). The board UI filters by `status = 'active'`, so the plan becomes invisible on the board — but it still exists in the DB with its old column, creating a "ghost" that confuses any tool or query that doesn't filter by status. This plan fixes the inconsistency by ensuring archiving a plan also moves it to a terminal column (`COMPLETED`) and stamps `last_action = 'archived'`, so the DB state matches the UI state. A one-time migration repairs existing ghosts (including `deleted` plans, which suffer the same defect).

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

**The board UI** (`getPlansByColumn`, `KanbanDatabase.ts:2785-2810`) queries `WHERE status = 'active' AND kanban_column = ?` for non-COMPLETED columns. Since `status = 'archived'`, the plan is filtered out — invisible on the board.

**But the plan is NOT in the COMPLETED column either** — `getPlansByColumn` for COMPLETED queries `WHERE status = 'completed'`. Since `status = 'archived'` (not `completed`), the plan is invisible there too.

**Result:** the plan is a ghost — present in the DB, assigned to a column, but invisible on every board surface. It only appears in the TaskViewer Archive/Recovery UI (`TaskViewerProvider.ts:11724-11726`), which explicitly queries `status = 'archived'` or `status = 'orphan'`.

**Root cause:** The archive operation sets `status = 'archived'` but does not update `kanban_column` or `last_action`. There is no code path that moves an archived plan to a terminal column or clears its column assignment. The `updateStatusByPlanFile()` method (`KanbanDatabase.ts:1857-1867`) and the deprecated `updateStatus()` (`KanbanDatabase.ts:1870-1874`, which delegates to `updateStatusByPlanFile`) are one-dimensional — they update only `status` and `updated_at` via `'UPDATE plans SET status = ?, updated_at = ? WHERE plan_file = ? AND workspace_id = ?'`, leaving `kanban_column` and `last_action` stale.

**Why this matters beyond the single case:**
- Any tool that queries the DB by `kanban_column` without a `status` filter (like the `group-into-epics` DB query did) will see ghost plans.
- The kanban-state file export (`exportStateToFile`) correctly filters by `status = 'active'` (via `getBoard()`), so ghosts don't appear in the files — but direct DB queries are unguarded.
- The Archive/Recovery UI shows the plan in its old column, which is confusing — the user archived it, but it appears to still be "in" PLAN REVIEWED.
- The same ghost class affects `status = 'deleted'` plans left in non-terminal columns.

## Metadata
- **Tags:** bug, backend, database, kanban, archive, status, ghost-plan
- **Complexity:** 3

## User Review Required

Yes — confirm the semantic decision to bucket archived/deleted plans into the `COMPLETED` column (a pragmatic terminal bucket, since no `ARCHIVED` column exists in `VALID_KANBAN_COLUMNS`). Archived plans remain invisible on the board because `getPlansByColumn('COMPLETED')` filters `status = 'completed'`, not `archived`. The column label is a cosmetic compromise, not a functional one. Also confirm that the board's "Archive Selected" button (which uses `ArchiveManager` to export to DuckDB and does **not** set `status='archived'` in the kanban DB) is intentionally out of scope for this plan.

## Complexity Audit

### Routine
- Adding a dedicated `archivePlan()` method that updates `status`, `kanban_column`, and `last_action` in a single SQL statement
- Routing the two existing archive call sites (`PlanManifestService`, `TaskViewerProvider`) through `archivePlan()` when the target status is `archived` (or `deleted`)
- Adding a version-gated V44 migration that repairs existing ghost rows

### Complex / Risky
- **Semantic compromise of moving archived → COMPLETED.** Moving to COMPLETED is misleading — the plan wasn't completed, it was archived/superseded. Clearing the column (setting to `''` or a dedicated `ARCHIVED` column) is more accurate but would break code that assumes every plan has a valid column in `VALID_KANBAN_COLUMNS` (no `ARCHIVED` column exists; `VALID_KANBAN_COLUMNS` is `CREATED, RESEARCHER, PLAN REVIEWED, LEAD CODED, CODER CODED, INTERN CODED, CODE REVIEWED, ACCEPTANCE TESTED, TICKET UPDATER, COMPLETED, BACKLOG, CODED`). Setting `kanban_column = 'COMPLETED'` is the least disruptive option that puts the ghost in a terminal bucket while keeping it invisible on the board.
- **V10 precedent conflation.** V10 (`KanbanDatabase.ts:4736-4757`) historically flipped `status = 'archived' AND kanban_column = 'COMPLETED'` → `status = 'completed'`. V10 is version-gated and will not re-run, so moving new archived plans into COMPLETED does not conflict. The historical conflation is acknowledged but not reintroduced: new archived plans keep `status = 'archived'` (V10 only ran for the legacy install base).
- **Scope of `last_action` updates.** The dedicated `archivePlan()` method is the only place `last_action` is stamped for archive operations. The generic `updateStatusByPlanFile()` is **not** modified to write `last_action` for every status change — doing so would clobber meaningful move events (e.g. `move-to-plan-reviewed`) with noisy `status-changed-to-active` values.

## Edge-Case & Dependency Audit

- **Race Conditions:** `archivePlan()` performs a single atomic UPDATE (status + column + last_action + updated_at in one statement via `_persistedUpdate`), so there is no window where a reader sees a half-archived row. The migration runs inside the existing `_runMigrations` transaction (BEGIN/COMMIT with ROLLBACK on failure), matching the V43 precedent.
- **Security:** No external input flows into the SQL; all values are internal status/column literals or parameter-bound. No injection surface.
- **Side Effects:**
  - Archived plans move from their old column to `COMPLETED`. They were already invisible on the board (filtered by `status`), so no UI change is visible to the user.
  - `last_action` changes from the prior move event to `archived` (or `archived-ghost-repaired` for migrated rows). This is intentional and self-documenting.
  - The Archive/Recovery UI (`TaskViewerProvider.ts:11724`) queries by `status`, not by column, so it continues to show archived plans correctly — now with a consistent `COMPLETED` column.
- **Dependencies & Conflicts:**
  - **Plans archived via manifest:** `PlanManifestService.ts:231-233` calls `db.updateStatusByPlanFile(entry.planFile, workspaceId, entry.status)`. `VALID_STATUSES` is `{'active','archived','completed','deleted'}`. The fix routes `entry.status === 'archived'` (and `'deleted'`) through `db.archivePlan()` instead.
  - **Plans archived via TaskViewerProvider:** `TaskViewerProvider.ts:11724-11726` calls `db.updateStatus(sessionId, dbStatus)` where `dbStatus = status === 'orphan' ? 'archived' : status`. The fix routes the `archived`/`deleted` cases through `db.archivePlan()` (resolving `planFile`/`workspaceId` via `getPlanBySessionId` first, since `archivePlan` keys on `plan_file`).
  - **Board "Archive Selected" button (OUT OF SCOPE):** `kanban.html:4698-4700` + `KanbanProvider.ts:6160-6268` calls `ArchiveManager.archivePlan(plan)` which exports the plan to DuckDB. It does **not** set `status='archived'` in the kanban DB — the row keeps its existing `status` (typically `'completed'`) and column (`'COMPLETED'`). This is a different archive mechanism and is not affected by this plan.
  - **V10 migration precedent:** `KanbanDatabase.ts:4736-4757` already repaired `status = 'archived' AND kanban_column = 'COMPLETED'` rows by flipping status to `completed`. V10 is version-gated (runs once at V10) and will not re-run, so moving new archived plans into COMPLETED is safe.
  - **Published extension (~4,000 installs):** Any existing install may have ghost plans. The V44 migration repairs them safely — it only moves archived/deleted plans to COMPLETED and stamps `last_action`, neither of which affects what the user sees (archived/deleted plans are already invisible on the board).
  - **Migration version assignment:** This plan uses **V44**. The sibling plan `fix-imported-docs-relative-paths-convention.md` uses **V45**. Both are part of the "Kanban DB Storage Consistency" epic and run sequentially in the same migration chain (V44 before V45). No version collision.

## Dependencies

- None blocking. This plan is part of epic "Kanban DB Storage Consistency" alongside `fix-imported-docs-relative-paths-convention.md` (V45). The two migrations are independent data repairs and can run in either order, but V44 is assigned to this plan and V45 to the sibling to avoid sentinel/version collision.

## Adversarial Synthesis

Key risks: (1) semantic compromise of bucketing archived plans into `COMPLETED` (cosmetic-only, since the board filters by `status`); (2) over-broad `last_action` writes clobbering meaningful move events — mitigated by confining `last_action` updates to the dedicated `archivePlan()` method only; (3) the `deleted` ghost class was originally unaddressed — mitigated by extending the migration and `archivePlan()` to cover `deleted` as well. The board's DuckDB "Archive Selected" button is confirmed out of scope (different mechanism).

## Proposed Changes

### 1. Add a dedicated `archivePlan()` method (does NOT touch `updateStatusByPlanFile`)

**File:** `src/services/KanbanDatabase.ts`

Add a new method near `updateStatusByPlanFile()` (~line 1867). This updates `status`, `kanban_column`, `last_action`, and `updated_at` in a single atomic statement. It handles both `archived` and `deleted` terminal statuses:

```typescript
/**
 * Archive or delete a plan in a single atomic update: sets status, moves the
 * plan to the COMPLETED terminal column, and stamps last_action so the row is
 * self-documenting for direct DB queries. Use this instead of
 * updateStatusByPlanFile() when the target status is 'archived' or 'deleted'
 * so the kanban_column does not go stale (ghost-plan bug).
 */
public async archivePlan(
    planFile: string,
    workspaceId: string,
    status: 'archived' | 'deleted'
): Promise<boolean> {
    if (!(await this.ensureReady()) || !this._db) return false;
    const normalized = this._ensureRelativePlanFile(planFile);
    return this._persistedUpdate(
        'UPDATE plans SET status = ?, kanban_column = ?, last_action = ?, updated_at = ? WHERE plan_file = ? AND workspace_id = ?',
        [status, 'COMPLETED', status, new Date().toISOString(), normalized, workspaceId]
    );
}
```

**Do NOT modify `updateStatusByPlanFile()` or `updateStatus()`.** They remain one-dimensional for non-terminal status transitions (e.g. `active` ↔ `completed`), preserving existing `last_action` move-event semantics. Only `archivePlan()` writes `last_action` for terminal transitions.

### 2. Add a one-time V44 repair migration for existing ghost plans (archived AND deleted)

**File:** `src/services/KanbanDatabase.ts` (in the migration chain, after the V43 block at ~line 5468-5483)

Add a `MIGRATION_V44_SQL` constant and a version-gated block matching the V43 precedent. This repairs ghost plans — archived **and** deleted plans left in non-COMPLETED columns:

```typescript
const MIGRATION_V44_SQL: string[] = [
    // No schema change — this is a data-only repair.
    // Sentinel is not needed; the WHERE clause is self-selecting.
];

// ...inside _runMigrations(), after the V43 block:
const v44 = await this.getMigrationVersion();
if (v44 < 44) {
    try {
        this._db.exec('BEGIN');
        for (const sql of MIGRATION_V44_SQL) {
            this._db.exec(sql);
        }
        // V44: repair ghost plans — archived/deleted plans left in non-terminal columns.
        const ghostStmt = this._db.prepare(
            "SELECT COUNT(*) as cnt FROM plans WHERE status IN ('archived','deleted') AND kanban_column != 'COMPLETED'"
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
                "UPDATE plans SET kanban_column = 'COMPLETED', last_action = 'archived-ghost-repaired' " +
                "WHERE status IN ('archived','deleted') AND kanban_column != 'COMPLETED'"
            );
            console.log(`[KanbanDatabase] V44 migration: repaired ${ghostCount} archived/deleted ghost plan(s) left in non-COMPLETED columns`);
        }
        this._db.exec('COMMIT');
        await this.setMigrationVersion(44);
        console.log('[KanbanDatabase] V44 migration completed: archived/deleted ghost plans repaired');
    } catch (e) {
        try { this._db.exec('ROLLBACK'); } catch { /* ignore */ }
        console.error('[KanbanDatabase] V44 migration FAILED — rolled back. DB unchanged. Error:', e);
    }
}
```

This moves all existing ghost plans to `COMPLETED` and stamps `last_action = 'archived-ghost-repaired'`. They remain invisible on the board (`getPlansByColumn('COMPLETED')` filters `status = 'completed'`, not `archived`/`deleted`), but their DB state is now consistent — no plan claims to be in `PLAN REVIEWED` when it's actually archived. The specific ghost `7b8e38de` is repaired by this migration; no separate one-time DB fix is needed.

### 3. Route the two archive call sites through `archivePlan()`

**File:** `src/services/PlanManifestService.ts` (~line 231-233)

When `entry.status` is `archived` or `deleted`, call `db.archivePlan()` instead of `db.updateStatusByPlanFile()`:

```typescript
// ── status ──
if (entry.status && VALID_STATUSES.has(entry.status)) {
    if (plan.status !== entry.status) {
        let ok: boolean;
        if (entry.status === 'archived' || entry.status === 'deleted') {
            ok = await db.archivePlan(entry.planFile, workspaceId, entry.status as 'archived' | 'deleted');
        } else {
            ok = await db.updateStatusByPlanFile(entry.planFile, workspaceId, entry.status as 'active' | 'completed');
        }
        if (!ok) {
            log?.(`[PlanManifest] status update failed for ${entry.planFile} → ${entry.status}`);
        }
    }
}
```

**File:** `src/services/TaskViewerProvider.ts` (~line 11724-11726)

When `dbStatus` is `archived` or `deleted`, resolve the plan's `planFile`/`workspaceId` and call `db.archivePlan()`:

```typescript
const dbStatus = status === 'orphan' ? 'archived' : status;
for (const sessionId of this._getRegistrySessionIdCandidates(planId, entry.sourceType)) {
    if (dbStatus === 'archived' || dbStatus === 'deleted') {
        const plan = await db.getPlanBySessionId(sessionId);
        if (plan) {
            await db.archivePlan(plan.planFile, plan.workspaceId, dbStatus as 'archived' | 'deleted');
        }
    } else {
        await db.updateStatus(sessionId, dbStatus as KanbanPlanRecord['status']);
    }
}
```

### 4. Board "Archive Selected" button — explicitly out of scope

**No change.** The board's "Archive Selected" button (`kanban.html:4698-4700`, `KanbanProvider.ts:6160-6268`) calls `ArchiveManager.archivePlan(plan)` to export plans to DuckDB. It does not set `status='archived'` in the kanban DB — the row keeps its existing `status` (typically `'completed'`) and column (`'COMPLETED'`). This is a different archive mechanism (DuckDB export) and is not affected by the ghost-plan bug. Documented here to prevent a future implementer from mistakenly routing it through `archivePlan()`.

## Verification Plan

> Per session directives: **no compilation, no automated tests.** Verification is manual/inspection-only.

### Automated Tests
- *(skipped per session directive — the user runs the test suite separately)*

### Manual Verification (inspection + DB queries)
1. **Ghost repair migration:** On a DB with the ghost plan `7b8e38de`, after V44 runs, verify `kanban_column` changed from `PLAN REVIEWED` to `COMPLETED` and `last_action` changed to `archived-ghost-repaired`. Query: `SELECT plan_id, kanban_column, status, last_action FROM plans WHERE plan_id LIKE '7b8e38de%';`
2. **Board UI unaffected:** After V44, the board UI shows the same plans. The ghost was already invisible (filtered by `status`); it remains invisible in COMPLETED (which requires `status = 'completed'`).
3. **Archive via manifest:** Create a plan, then ingest a manifest with `status: 'archived'` → verify the plan's `kanban_column = 'COMPLETED'`, `status = 'archived'`, `last_action = 'archived'` in a single row state.
4. **Archive via TaskViewer:** Archive a plan via the TaskViewer recovery UI → verify the same DB state as step 3.
5. **Delete via manifest:** Ingest a manifest with `status: 'deleted'` → verify `kanban_column = 'COMPLETED'`, `status = 'deleted'`, `last_action = 'deleted'`.
6. **Direct DB query consistency:** After archiving, `SELECT * FROM plans WHERE kanban_column = 'PLAN REVIEWED'` → the archived/deleted plan must NOT appear (it's now in COMPLETED).
7. **No regression on active plans:** Active plans' `kanban_column`, `status`, and `last_action` remain unchanged (the generic `updateStatusByPlanFile` was not modified).
8. **`last_action` not clobbered for non-terminal transitions:** Move an active plan between columns → verify `last_action` still reflects the move event (e.g. `move-to-plan-reviewed`), NOT `status-changed-to-active`.

## Acceptance
- Archiving or deleting a plan (via manifest or TaskViewer) sets `kanban_column = 'COMPLETED'`, `status` to the terminal value, and `last_action` to the terminal value in a single atomic operation.
- A one-time V44 migration repairs all existing ghost plans (archived **and** deleted plans in non-COMPLETED columns) by moving them to COMPLETED.
- No archived/deleted plan remains in a non-COMPLETED column after the migration.
- The board UI is unaffected (archived/deleted plans were already invisible; they remain invisible).
- Direct DB queries by `kanban_column` no longer surface archived/deleted plans in pre-coding columns.
- `updateStatusByPlanFile()` is unchanged — `last_action` move-event semantics for non-terminal transitions are preserved.

## Uncertain Assumptions

- **None material.** All code claims were verified against current source by read-only subagent exploration (line numbers corrected: `updateStatusByPlanFile` at 1857-1867, `getPlansByColumn` at 2785-2810, V10 at 4736-4757, TaskViewer call at 11724-11726, latest migration V43). No web research is needed for this plan.

## Recommendation

Complexity 3 → **Send to Intern** (single-file core change in `KanbanDatabase.ts` + two small caller updates; reuses existing `_persistedUpdate` and migration-chain patterns; no new architectural patterns).

## Review Findings

Reviewed commits `13b93d4` (ghost-kanban) + `510daaf` (relative-paths, for migration sequencing) against plan requirements. Implementation matches the plan: `archivePlan()` added with atomic status+column+last_action UPDATE, V44 data-only migration repairs archived/deleted ghosts, `PlanManifestService` and `TaskViewerProvider` call sites routed correctly, `updateStatusByPlanFile` left unchanged. **One CRITICAL fix applied:** `KanbanProvider.ts:5488` (`reassignPlansWorkspace`) called `updateStatusByPlanFile(..., 'deleted')` — a third call site the plan's dependency audit missed, recreating the exact ghost bug on every workspace reassignment; rerouted to `sourceDb.archivePlan(..., 'deleted')`. Post-fix grep confirms zero un-routed `'archived'`/`'deleted'` setters remain. No compilation/tests run per session directives. Remaining risk: the V44 migration stamps `last_action = 'archived-ghost-repaired'` for both archived and deleted ghosts (cosmetic, intentional per plan).
