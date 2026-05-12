# Fix Duplicate Kanban Cards on Extension Activation

**sessionId:** `fix_duplicate_kanban_cards_on_activation`

**Created:** 2026-05-11

## Goal

Prevent the Switchboard VS Code extension from creating duplicate kanban cards every time it is reloaded or reinstalled. The fix must eliminate the race between database identity hydration and plan file scanning, repair the path-comparison bug in periodic scans, and close the schema gap that silently permits duplicate insertions.

## Metadata

- **Tags:** bugfix, database, reliability, workflow
- **Complexity:** 7

## User Review Required

Yes — this plan modifies the database conflict resolution key (`ON CONFLICT` target) and introduces a destructive migration (V19) that deletes duplicate rows. The user should confirm:

1. The proposed deduplication heuristic (prefer non-`CREATED` kanban column, then latest `updated_at`) is acceptable for their data.
2. The activation-sequence reordering in `extension.ts` does not conflict with any planned startup behavior changes.

## Complexity Audit

### Routine
- Fix `_scanForNewFiles` path comparison (single method, localized logic).
- Add `session_id` fallback lookup in `_handlePlanFile` (single conditional block).

### Complex / Risky
- Change `UPSERT_PLAN_SQL` conflict target from `plan_id` to `session_id`: affects every caller of `upsertPlans` across the codebase; must verify all callers supply stable `session_id` values.
- V19 migration that deletes duplicate rows: destructive and irreversible; wrong row-selection logic causes permanent data loss (kanban column positions).
- Activation-sequence reordering in `extension.ts`: touches core startup path; risk of deadlock if `initializeKanbanDbOnStartup` blocks on async I/O or user interaction.

## Edge-Case & Dependency Audit

### Race Conditions
- **Current:** `_handlePlanFile` already has a `workspaceId` guard (lines 349–352), but it falls back to `getDominantWorkspaceId()` which returns a workspace_id from existing plans. On a fresh DB with no plans, `workspaceId` is still `''` and the guard fires. The real race is `_scanForNewFiles` firing on its first interval (10s) before path-fix migrations complete, compounded by the absolute-vs-relative path mismatch.
- **Mitigation:** Fix the path comparison AND add a `db.getWorkspaceId()` gate (not `getDominantWorkspaceId`) in `setGlobalPlanWatcher` before calling `triggerScan`.

### Security
- No direct security impact. The migration SQL is internal and does not expose user data.
- Path normalization uses existing `_ensureRelativePlanFile` which guards against path traversal.

### Side Effects
- `ON CONFLICT(session_id)` will now update existing rows when brain/ingested plans with the same `session_id` are re-imported. This is the desired behavior (idempotent ingestion) but must be verified against ClickUp/Linear automation flows that may rely on `plan_id` stability.
- `triggerScan` deferral adds ~50–200ms to first-time plan discovery on cold start.

### Dependencies & Conflicts
- No external dependencies.
- Internal: `KanbanDatabase`, `GlobalPlanWatcherService`, `KanbanProvider`, `TaskViewerProvider`, `WorkspaceIdentityService`.
- Potential conflict: `TaskViewerProvider.initializeKanbanDbOnStartup()` already calls `cleanupSpuriousMirrorPlans`. Ensure V19 deduplication and this cleanup do not fight each other.

## Dependencies

- None external.
- None in `sess_XXXXXXXXXXXXX` format — this is an isolated bugfix with no upstream plan dependencies.

## Adversarial Synthesis

Key risks: (1) the `ON CONFLICT(session_id)` change affects every `upsertPlans` caller and could corrupt ClickUp/Linear sync if `session_id` collisions exist in brain/automation flows; (2) the V19 migration row-selection heuristic (latest `updated_at`) may discard a correctly-tracked kanban column if the duplicate has a newer metadata timestamp; (3) the `_scanForNewFiles` path-comparison bug is the most urgent root cause and must be fixed first, otherwise periodic scans will continue regenerating duplicates regardless of other mitigations. Mitigations: add a `getPlanBySessionId` fallback before inserting, prioritize non-`CREATED` column in deduplication, and audit all `upsertPlans` call sites for `session_id` stability.

## Proposed Changes

### `@/Users/patrickvuleta/Documents/GitHub/switchboard/src/services/GlobalPlanWatcherService.ts`

**Context:** This file contains `_handlePlanFile` (plan ingestion), `_scanForNewFiles` (periodic background scan), and `_debounceHandleFile`.

**Logic & Implementation:**

1. **Fix 1 — `workspaceId` guard (already present, verify sufficiency):**
   The current `_handlePlanFile` (lines 349–352) already guards against empty `workspaceId`:
   ```typescript
   const workspaceId = await db.getWorkspaceId() || await db.getDominantWorkspaceId() || '';
   if (!workspaceId) {
       this._outputChannel?.appendLine(`[GlobalPlanWatcher] No workspaceId for ${workspaceRoot}, skipping import`);
       return;
   }
   ```
   **Clarification:** This guard is already implemented. The original bug report may have observed behavior from an older code revision, or the guard is insufficient because `getDominantWorkspaceId()` can return a workspace_id from existing plans while the `config.workspace_id` is not yet established, causing a mismatch in `getPlanByPlanFile`. No code change needed for this guard, but **Fix 5** (activation sequence) addresses the underlying race.

2. **Fix 2 — `_scanForNewFiles` path comparison (lines 95–142):**
   `getAllPlans` returns records via `_readRows`, which **expands** `planFile` to absolute paths using `_resolveAbsolutePlanFile`. The scan then computes `relativePath` and compares against `existingPaths` which contains absolute paths. The comparison never matches.

   Change line 106 from:
   ```typescript
   const existingPaths = new Set(existingPlans.map(p => p.planFile));
   ```
   To:
   ```typescript
   const existingPaths = new Set(
       existingPlans.map(p => path.isAbsolute(p.planFile) ? path.relative(workspaceRoot, p.planFile) : p.planFile)
           .map(p => p.replace(/\\/g, '/'))
   );
   ```

3. **Fix 6 — `session_id` fallback lookup in `_handlePlanFile` (lines 341–435):**
   After `getPlanByPlanFile` returns null, add a second lookup before treating the plan as new:
   ```typescript
   if (!plan) {
       // Fallback: plan may exist under a different path or workspace_id
       plan = await db.getPlanBySessionId(metadata.sessionId);
       if (plan) {
           // Update the plan_file if it has moved
           await db.updatePlanFile(plan.sessionId, relativePath);
       }
   }
   ```

**Edge Cases:**
- If `metadata.sessionId` is empty or malformed, the fallback lookup returns null and the plan is treated as new (existing behavior).
- If a brain plan and a local plan share the same `session_id` (extremely unlikely given hash-based derivation), the fallback would find the brain plan and update its `plan_file`. Add a `sourceType === 'local'` filter if this becomes an issue.

### `@/Users/patrickvuleta/Documents/GitHub/switchboard/src/services/KanbanDatabase.ts`

**Context:** This file defines `UPSERT_PLAN_SQL`, `_runMigrations`, and all DB access methods.

**Logic & Implementation:**

1. **Fix 3 — Change `UPSERT_PLAN_SQL` conflict target (lines 250–280):**
   Change:
   ```sql
   ON CONFLICT(plan_id) DO UPDATE SET ...
   ```
   To:
   ```sql
   ON CONFLICT(session_id) DO UPDATE SET ...
   ```
   This makes the conflict resolution key the **natural unique identifier** for a plan instead of a synthetic UUID. The `plan_id` column remains the PRIMARY KEY for foreign-key purposes, but duplicates are prevented at the `session_id` level.

2. **Fix 4 — V19 migration for duplicate cleanup and unique index:**
   Add after `MIGRATION_V18_SQL`:
   ```typescript
   const MIGRATION_V19_SQL = [
       // Step 1: Deduplicate by session_id — prefer non-CREATED column, then latest updated_at
       `DELETE FROM plans
        WHERE rowid NOT IN (
            SELECT rowid FROM plans AS p1
            WHERE p1.rowid = (
                SELECT p2.rowid FROM plans AS p2
                WHERE p2.session_id = p1.session_id
                ORDER BY
                    CASE p2.kanban_column WHEN 'CREATED' THEN 1 ELSE 0 END ASC,
                    p2.updated_at DESC
                LIMIT 1
            )
        )`,
       // Step 2: Enforce session_id uniqueness at the index level
       `CREATE UNIQUE INDEX IF NOT EXISTS idx_plans_session_id_unique ON plans(session_id)`
   ];
   ```

   Wire into `_runMigrations` after V18:
   ```typescript
   // V19: deduplicate plans by session_id and enforce unique index
   for (const sql of MIGRATION_V19_SQL) {
       try { this._db.exec(sql); } catch (e) {
           console.debug('[KanbanDatabase] V19 migration step skipped or failed:', e);
       }
   }
   ```

**Edge Cases:**
- The deduplication SQL uses a correlated subquery. On very large DBs (1000+ plans), this may be slow. Test performance on representative DB sizes.
- `IF NOT EXISTS` on the unique index is safe for reruns, but the `DELETE` step is NOT idempotent — it will run every time `_runMigrations` fires if the migration version tracking does not gate it. **Correction:** The migration should be version-gated via `getMigrationVersion()` / `setMigrationVersion()`, like other migrations. Add `await this.setMigrationVersion(19)` after V19 succeeds.

### `@/Users/patrickvuleta/Documents/GitHub/switchboard/src/services/KanbanProvider.ts`

**Context:** `setGlobalPlanWatcher` (lines 296–332) wires the watcher and immediately calls `triggerScan` for every watch folder.

**Logic & Implementation:**

**Fix 5 — Gate `triggerScan` on workspace identity readiness:**
   Replace the scan loop (lines 317–324):
   ```typescript
   const folders = this._getWatchFolders();
   for (const folder of folders) {
       try {
           await this._globalPlanWatcher.triggerScan(folder);
       } catch (err) {
           console.error(`[KanbanProvider] Failed to scan folder ${folder}:`, err);
       }
   }
   ```
   With:
   ```typescript
   const folders = this._getWatchFolders();
   for (const folder of folders) {
       try {
           const db = this._getKanbanDb(folder);
           await db.ensureReady();
           const wsId = await db.getWorkspaceId();
           if (!wsId) {
               console.warn(`[KanbanProvider] Deferring scan for ${folder}: workspace_id not yet set`);
               continue;
           }
           await this._globalPlanWatcher.triggerScan(folder);
       } catch (err) {
           console.error(`[KanbanProvider] Failed to scan folder ${folder}:`, err);
       }
   }
   ```

**Edge Cases:**
- If `getWorkspaceId()` returns null but `getDominantWorkspaceId()` would have returned a value, the scan is deferred. This is correct behavior — we want the explicitly configured `workspace_id`, not an inferred one, before importing plans.
- Plans discovered via file watchers (VS Code `FileSystemWatcher` and native `fs.watch`) still work after identity is established because those events route through `_debounceHandleFile` independently of `triggerScan`.

### `@/Users/patrickvuleta/Documents/GitHub/switchboard/src/extension.ts`

**Context:** Activation sequence at lines 1095–1323.

**Logic & Implementation:**

**Fix 5 (alternative) — Reorder activation sequence:**
   Move `initializeKanbanDbOnStartup` before `setGlobalPlanWatcher`:
   ```typescript
   // Before:
   await kanbanProvider.setGlobalPlanWatcher(globalPlanWatcher);
   // ...
   if (workspaceRoot) {
       void taskViewerProvider.initializeKanbanDbOnStartup();
   }

   // After:
   if (workspaceRoot) {
       await taskViewerProvider.initializeKanbanDbOnStartup();
   }
   await kanbanProvider.setGlobalPlanWatcher(globalPlanWatcher);
   ```

**Important:** `initializeKanbanDbOnStartup` currently returns a `void`-fired promise (line 1323: `void taskViewerProvider.initializeKanbanDbOnStartup()`). For the `await` to work, the method must be changed to return its promise directly (remove the `void` prefix and ensure it returns a `Promise<void>`).

**Recommendation:** Apply the `KanbanProvider` gate FIRST (safer, more localized), then optionally apply the `extension.ts` reordering as a secondary defense.

**Edge Cases:**
- If `initializeKanbanDbOnStartup` throws, the extension activation will fail and the Kanban board won't load. The `try/catch` inside the method mitigates this, but individual workspace failures currently bubble up. Consider wrapping in a try/catch at the call site.

## Verification Plan

### Automated Tests

1. **`GlobalPlanWatcherService._scanForNewFiles` path comparison**
   - Mock `KanbanDatabase.getAllPlans` to return records with **absolute** `planFile` paths (as `_readRows` produces).
   - Create a temp file on disk at a relative path under `.switchboard/plans`.
   - Run `_scanForNewFiles`.
   - Assert: `_debounceHandleFile` is **never** called for the existing file.

2. **`KanbanDatabase.upsertPlans` session_id conflict resolution**
   - Insert a plan with `sessionId: "abc"` and `planId: "uuid-1"`.
   - Insert a second plan with `sessionId: "abc"` and `planId: "uuid-2"` (different topic).
   - Assert: DB contains exactly one row for `sessionId: "abc"`.
   - Assert: The remaining row has `planId: "uuid-2"` and the second topic (later insert wins).

3. **`KanbanDatabase` V19 migration — deduplication and index creation**
   - Create a DB with three rows sharing `session_id: "dup"`:
     - Row A: `kanban_column: 'CREATED'`, `updated_at: '2026-01-01'`
     - Row B: `kanban_column: 'CODED'`, `updated_at: '2026-01-02'`
     - Row C: `kanban_column: 'CREATED'`, `updated_at: '2026-01-03'`
   - Run `ensureReady()` to trigger migrations.
   - Assert: Exactly one row remains.
   - Assert: The remaining row is Row B (non-CREATED takes precedence over newer CREATED).
   - Assert: `PRAGMA index_list(plans)` includes `idx_plans_session_id_unique`.

4. **`KanbanProvider.setGlobalPlanWatcher` deferred scan**
   - Mock `_getKanbanDb` to return a DB where `getWorkspaceId()` returns `null`.
   - Call `setGlobalPlanWatcher`.
   - Assert: `triggerScan` is **not** called for that folder.
   - Assert: A warning is logged to the output channel.

5. **`GlobalPlanWatcherService._handlePlanFile` session_id fallback**
   - Mock `getPlanByPlanFile` to return `null`.
   - Mock `getPlanBySessionId` to return an existing plan with an **old** `plan_file`.
   - Call `_handlePlanFile` with a **new** relative path.
   - Assert: `updatePlanFile` is called with the new path.
   - Assert: `upsertPlans` is **not** called with a new `planId`.

### Integration Tests

1. **Cold-start activation with 126 existing plans**
   - Create a workspace with `.switchboard/plans/*.md` containing 126 plans.
   - Set their `kanbanColumn` to various non-`CREATED` values via direct DB update.
   - Clear `KanbanDatabase._instances` to simulate extension host restart.
   - Trigger activation sequence.
   - Assert: DB contains exactly 126 active plans.
   - Assert: No `session_id` has `COUNT(*) > 1`.
   - Assert: All non-`CREATED` kanban columns are preserved.

### Manual Tests

1. **Reproduce original bug scenario**
   - Open a workspace with many plans in non-`CREATED` columns.
   - Run the **"Reload Window"** VS Code command.
   - Before fix: Observe duplicates in the "New" column.
   - After fix: Verify plans retain original columns; no duplicates appear.

## Risk Assessment

| Risk | Severity | Mitigation |
|------|----------|------------|
| Changing `ON CONFLICT(plan_id)` to `ON CONFLICT(session_id)` affects all `upsertPlans` callers | **High** | Audit every call site (`GlobalPlanWatcherService`, `TaskViewerProvider._registerPlan`, brain ingestion, ClickUp/Linear automation). Ensure all callers provide a stable `sessionId`. Add unit test covering each source type. |
| V19 migration deletes "duplicate" rows; user may lose data if we keep the wrong row | **Medium** | Deduplication heuristic prioritizes **non-`CREATED` kanban_column** first, then **latest `updated_at`**. Log every deleted row ID to the output channel before removal. |
| `session_id` uniqueness conflicts with brain/ingested plans that share a topic but have different files | **Medium** | Brain plans derive `session_id` from content hash; ingested plans from file path hash. These are effectively collision-resistant. If collisions are observed in testing, scope the unique index to `(session_id, workspace_id)` instead of just `session_id`. |
| Deferring `triggerScan` slows down first-time plan discovery | **Low** | Deferral only adds ~50–200ms. File watchers (VS Code + native) still detect new files after identity is established. |
| Reordering `extension.ts` activation causes startup failure if `initializeKanbanDbOnStartup` throws | **Low** | The method already has internal try/catch per workspace. Wrap the `await` call in an outer try/catch at the call site to prevent activation failure. |

## Rollback Plan

If the fix introduces regressions:

1. Revert the `ON CONFLICT` target back to `plan_id` in `KanbanDatabase.ts`.
2. Remove the V19 migration SQL from `_runMigrations` (the migration is version-gated; removing it stops running on new DBs but does not affect already-migrated ones).
3. Keep the `_scanForNewFiles` path-comparison fix — this is purely corrective and has no downside.
4. Keep the `session_id` fallback in `_handlePlanFile` — defensive and non-breaking.
5. Users with existing duplicate rows after rollback will need to run the **"Reset Database"** command to rebuild from plan files, or manually delete duplicates via the Kanban UI.

## Files to Change

1. `@/Users/patrickvuleta/Documents/GitHub/switchboard/src/services/GlobalPlanWatcherService.ts`
   - **Fix 2:** Fix path comparison in `_scanForNewFiles` (line 106).
   - **Fix 6:** Add `session_id` fallback lookup in `_handlePlanFile` (after line 360).
   - **Note:** `workspaceId` guard is already present at lines 349–352.

2. `@/Users/patrickvuleta/Documents/GitHub/switchboard/src/services/KanbanDatabase.ts`
   - **Fix 3:** Change `ON CONFLICT(plan_id)` to `ON CONFLICT(session_id)` in `UPSERT_PLAN_SQL` (lines 257).
   - **Fix 4:** Add `MIGRATION_V19_SQL` constant and wire into `_runMigrations`.
   - Ensure V19 sets migration version to 19 via `setMigrationVersion(19)`.

3. `@/Users/patrickvuleta/Documents/GitHub/switchboard/src/services/KanbanProvider.ts`
   - **Fix 5:** Add workspace-id readiness check before calling `triggerScan` in `setGlobalPlanWatcher` (lines 317–324).

4. `@/Users/patrickvuleta/Documents/GitHub/switchboard/src/extension.ts`
   - **Fix 5 (optional):** Reorder activation sequence: move `await taskViewerProvider.initializeKanbanDbOnStartup()` before `await kanbanProvider.setGlobalPlanWatcher(globalPlanWatcher)`.
   - Remove `void` prefix from `initializeKanbanDbOnStartup` call to make it awaitable.

## Acceptance Criteria

- [ ] Extension reload with 126 existing plans produces **zero** duplicate cards.
- [ ] Existing plans retain their original `kanbanColumn` after reload.
- [ ] New plans created after reload still appear in `CREATED` and are properly tracked.
- [ ] `SELECT session_id, COUNT(*) FROM plans GROUP BY session_id HAVING COUNT(*) > 1` returns 0 rows after V19 migration.
- [ ] All existing unit tests pass.
- [ ] New unit tests for path comparison, session_id conflict, V19 migration, and deferred scan pass.
- [ ] Manual test: "Reload Window" with 20+ plans in non-CREATED columns produces no duplicates.

## Estimated Effort

- Implementation: 2–3 hours
- Testing (unit + integration): 2–3 hours
- Review and verification: 1 hour
- **Total: 5–7 hours**

---

## Recommendation

**Send to Lead Coder.**

Complexity is **7** (high end of medium / low end of high). The changes span 4 files, involve a destructive DB migration (V19), and require careful coordination between the activation sequence and the scan pipeline. The `ON CONFLICT` target change affects all callers of `upsertPlans` and must be audited for `session_id` stability across brain ingestion, ClickUp automation, and Linear automation flows. A lead coder should review the migration SQL and deduplication heuristic before implementation.
