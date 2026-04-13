# Restore Completed Column Visibility and Preserve Completed Status

## Goal

Fix the Completed-column disappearance by restoring `completed` as the canonical board lifecycle state, preventing startup/full-sync registry saves from silently rewriting completed DB rows to `archived`, and repairing already-affected workspaces. Keep filesystem archival of completed plan artifacts intact, but stop conflating that file-storage behavior with the Kanban lifecycle status.

## Metadata
**Tags:** backend, database, bugfix, ui
**Complexity:** 7

## User Review Required
> [!NOTE]
> - This plan fixes the **Completed-column disappearance and status-coercion regression only**.
> - `switchboard.archive.autoArchiveCompleted` should remain **out of scope** for this plan. It is a separate latent settings/UI defect and should not be bundled into the status repair unless explicitly requested later.
> - The implementation must repair **existing damaged DB rows**, not just prevent new corruption.
> - Keep the current filesystem archival behavior (`_archiveCompletedSession()`) intact. The bug is that lifecycle state drifted from `completed` to `archived`, not that files were moved to `.switchboard/archive/...`.
> - Do **not** “fix” this by broadening the Completed query to generic archived rows. That would mask the corruption loop instead of removing it.
> - **Recommended Agent:** Lead Coder

## Complexity Audit
### Routine
- **[R1]** Add `'completed'` to `PlanRegistryEntry.status` type union at `src/services/TaskViewerProvider.ts:127`. Single-line type widening; no runtime impact.
- **[R2]** Remove the `completed -> archived` coercion in `_loadPlanRegistry()` at lines 5726 and 5740. Replace `p.status === 'completed' ? 'archived' : p.status` with `p.status` (preserving the `as PlanRegistryEntry['status']` cast). Two identical one-line changes.
- **[R3]** Fix `_migrateLegacyToRegistry()` at line 6375 to map `sheet.completed === true` to `'completed'` instead of `'archived'`. Single-line change.
- **[R4]** Fix `_handleCompletePlan()` at lines 8539 and 8542 to pass `'completed'` instead of `'archived'` to `_updatePlanRegistryStatus()`. Two one-line changes.
- **[R5]** Add V10 self-heal migration step in `_runMigrations()` after the V9 block (after line 1535 in `KanbanDatabase.ts`) to repair existing damaged rows.
- **[R6]** Verify `_getRecoverablePlans()` at line 5999 only lists `'archived'` or `'orphan'` entries — currently correct, no change needed.
- **[R7]** Verify `_handleRestorePlan()` at line 6135 already allows `'completed'` in `allowedRestoreStatuses` — currently correct, no change needed.
- **[R8]** Add regression test file `src/test/completed-column-status-regression.test.js`.

### Complex / Risky
- **[C1] UPSERT lifecycle overwrite (the core of the causal chain):** `UPSERT_PLAN_SQL` at `KanbanDatabase.ts:145-173` overwrites `status` (line 157) and `kanban_column` (line 156) on every conflict. This is the vector that allows reconciliation saves to clobber completed DB rows. The fix must remove these two lines from the `ON CONFLICT DO UPDATE SET` clause. **Risk:** Any caller that relies on upsert to set lifecycle fields on existing rows will silently stop working. Audit of all `upsertPlans()` call sites confirms only two exist: `_savePlanRegistry()` (TaskViewerProvider.ts:5859) and `_registerPlan()` (TaskViewerProvider.ts:5913). Both read existing lifecycle fields before calling `upsertPlans()`, so neither depends on conflict-overwrite for lifecycle transitions. Explicit mutations go through `updateStatus()` / `updateColumn()`. But this must be verified for any new call sites added concurrently.
- **[C2] The causal chain is multi-step:** The bug is not a single bad line. It spans five coordinated mutations: (1) type definition missing `'completed'`, (2) `_loadPlanRegistry()` coercion at two locations, (3) `_migrateLegacyToRegistry()` coercion, (4) `_handleCompletePlan()` setting registry to `'archived'`, (5) UPSERT overwriting lifecycle on conflict. A partial fix that addresses only some of these will appear to work until the next startup/full-sync re-corrupts the data. All five must land atomically.
- **[C3] `_savePlanRegistry()` as a corruption amplifier:** This method (line 5830) is called from rename (line 8154), topic-update (lines 8287, 8328, 8959), reconciliation (line 6525), restore (line 6179), and legacy-migration (line 6383) flows. After the UPSERT fix it becomes safe — but if the UPSERT fix is missing or incomplete, every one of these call sites is a re-corruption vector.
- **[C4] `_handleCompletePlan()` double-write ordering:** At line 8539/8542, `_updatePlanRegistryStatus()` writes to DB via `updateStatus()` using `_getRegistrySessionIdCandidates()` session IDs. Then at line 8548, `db.updateStatus(sessionId, 'completed')` writes again using the raw `sessionId`. These may resolve to different DB rows if the planId-to-sessionId mapping diverges from the raw sessionId. After the fix (both write `'completed'`), this becomes a redundant-but-harmless idempotent write. **Clarification:** add an inline comment at line 8548 documenting this belt-and-suspenders pattern.

## Edge-Case & Dependency Audit
- **Startup / refresh path:** `initializeKanbanDbOnStartup() -> _collectAndSyncKanbanSnapshot() -> _reconcileLocalPlansFromRunSheets() -> _savePlanRegistry()` must no longer be able to demote completed rows. The UPSERT fix ([C1]) is the primary guard; the registry coercion fixes ([R2]-[R4]) prevent the in-memory registry from ever holding stale `'archived'` status for completed plans.
- **Timestamp preservation:** The V10 repair for existing bad rows should **not** touch `updated_at`; Completed card ordering/history should remain based on the original completion timestamp. The `UPDATE plans SET status = 'completed' WHERE ...` SQL deliberately omits `updated_at` from the SET clause.
- **Local + brain plans:** Both local runsheet-backed plans and brain/mirror-backed plans must keep `completed` semantics after reload. In `_handleCompletePlan()`, brain plans are handled at line 8539 (using `pathHash` as planId) and local plans at line 8542 (using `sessionId` as planId). Both must pass `'completed'`.
- **Recovery semantics:** The Completed column already has an explicit recover path (`restorePlanFromKanban`). `_getRecoverablePlans()` at line 5999 filters to `'archived'` or `'orphan'` only, so completed cards will NOT appear in the generic recover modal. `_handleRestorePlan()` at line 6135 includes `'completed'` in `allowedRestoreStatuses`, so the dedicated Completed-card recovery action still works.
- **DB query contract:** `getCompletedPlans()` at KanbanDatabase.ts:772-782 should stay strict to `status='completed'`; once data and lifecycle writes are fixed, the existing query becomes correct again.
- **`_updatePlanRegistryStatus()` pass-through:** At line 5949, the mapping `status === 'orphan' ? 'archived' : status` passes `'completed'` through unchanged to `updateStatus()`. No change needed, but verify this implicit pass-through after adding `'completed'` to the type union.
- **`_registerPlan()` orphan mapping:** At line 5919, `entry.status === 'orphan' ? 'archived' : entry.status` also passes `'completed'` through unchanged. Safe.
- **No local-diff dependency:** Current git inspection for `package.json`, `src/services/KanbanDatabase.ts`, `src/services/KanbanProvider.ts`, and `src/services/TaskViewerProvider.ts` is clean, so the fix should target committed behavior rather than assuming dirty-worktree-only conditions.
- **Cross-plan conflicts:** Kanban board scan (2026-04-12) shows no other plans in **New** or **Planned** columns that conflict with this work. The predecessor investigation "Investigate Completed Column Disappearance and Phantom Auto-Archive" is in **Coder** (already implemented). No dependency or merge conflicts detected.
- **Race Conditions:** `_savePlanRegistry()` is called from multiple async flows (rename, topic, reconcile, restore). If two calls overlap, one could re-read stale registry state and overwrite a concurrent lifecycle transition. The UPSERT fix ([C1]) mitigates this by removing lifecycle fields from the conflict clause, so even overlapping saves won't clobber lifecycle state.
- **Security:** No security implications. All changes are internal DB state management.
- **Side Effects:** The V10 migration repairs `archived + COMPLETED` rows to `completed`. The `COMPLETED` kanban_column value is only written by `_handleCompletePlan()` and `updateColumn(sessionId, 'COMPLETED')`, so `archived + COMPLETED` is always the damaged shape — never a legitimate combination.

## Adversarial Synthesis
### Grumpy Critique
> Oh, wonderful. Another "multi-layered fix" that requires touching a type definition, two load paths, a completion handler, a SQL upsert template, AND a migration — all to fix a regression that a single well-placed `if` could have avoided in the original `f439869` commit. Let me count the ways this can still go wrong:
>
> 1. **The UPSERT lobotomy is the scariest part.** You're ripping `kanban_column = excluded.kanban_column` (line 156) and `status = excluded.status` (line 157) out of the ON CONFLICT clause. Great — except every future developer who calls `upsertPlans()` expecting it to set lifecycle fields will silently ignore. There's no compile-time guard, no runtime warning, no assertion. The next person who adds a new `upsertPlans()` call site will spend a day debugging why their status change doesn't persist. You audited two call sites today — what about the one someone adds tomorrow?
>
> 2. **The V10 migration is a one-way door.** Once you convert `archived + COMPLETED` → `completed`, there's no way to distinguish which rows were legitimately archived vs. bug-damaged. The plan hand-waves this with "COMPLETED column is only written by _handleCompletePlan" — but what about manual DB edits, future ClickUp sync pipelines writing `kanban_column` directly, or the `updateColumn()` API being called from new code paths?
>
> 3. **`_handleCompletePlan` has a subtle double-write.** You call `_updatePlanRegistryStatus(resolvedWorkspaceRoot, pathHash, 'completed')` at line 8539, which writes to DB via `updateStatus()` using `_getRegistrySessionIdCandidates()`. Then at line 8548 you call `db.updateStatus(sessionId, 'completed')` AGAIN using the raw `sessionId`. These use DIFFERENT session ID resolution strategies. If they resolve to different DB rows, you get a split where one row is `completed` and another still has the old status. Yes, both write `'completed'` now, but the structural ambiguity is a maintenance trap.
>
> 4. **No functional integration test.** The regression test at step 6 asserts source-level patterns (string-matching on function bodies). That's fragile. Someone refactors `p.status` to `plan.status` — the old-pattern assertion passes because the old string is gone, even if the new code reintroduces coercion. Where's the in-memory DB test that seeds an `archived+COMPLETED` row, runs the migration, then verifies `getCompletedPlans()` returns it?
>
> 5. **The `_savePlanRegistry()` amplifier at line 5842 still maps `'orphan' -> 'archived'`.** What if a completed plan somehow becomes orphaned and then re-registered? It would go `completed -> orphan -> archived` in the registry, then if the UPSERT fix ever regresses, `_savePlanRegistry` would write that `archived` back to DB. The UPSERT fix prevents DB clobbering today, but the in-memory registry would still hold the wrong status until the next reload.

### Balanced Response
> The Grumpy critique raises five legitimate concerns. Here's how the implementation addresses each:
>
> 1. **UPSERT documentation guard:** Add a JSDoc comment on `UPSERT_PLAN_SQL` explicitly stating that lifecycle fields (`status`, `kanban_column`) are NOT overwritten on conflict, and that callers must use `updateStatus()` / `updateColumn()` for lifecycle transitions. This matches the existing pattern where `updateStatus` and `updateColumn` are already separate dedicated methods. A compile-time guard isn't feasible in raw SQL, but the documentation + regression test lock the contract.
>
> 2. **V10 migration safety:** The concern about manual DB edits is valid but theoretical. The `COMPLETED` kanban_column value is only written by `_handleCompletePlan()` and `updateColumn(sessionId, 'COMPLETED')`. No external integration currently writes this column directly. The migration is idempotent and becomes a no-op on clean databases.
>
> 3. **Double-write in `_handleCompletePlan`:** This is a real structural concern. After the fix, both writes set `'completed'`, making the second a redundant-but-harmless idempotent write. The plan adds an explicit inline comment at line 8548 documenting this as a belt-and-suspenders pattern. The dual-write exists because `_updatePlanRegistryStatus` uses registry-derived session IDs while line 8548 uses the raw `sessionId` — both are needed to cover all ID resolution paths.
>
> 4. **Source-level test brittleness:** The plan already includes an "Optional Follow-up" to replace source-level assertions with in-memory DB tests. For the initial fix, the source-level test catches the exact patterns that caused this specific regression. A functional DB test is valuable and should be prioritized in a follow-up, but it should not block the urgent data repair.
>
> 5. **Orphan → completed edge case:** If a completed plan is orphaned, `_getRecoverablePlans()` only lists `'archived'` and `'orphan'` plans — completed plans are visible in the Completed column and would not enter the orphan path. The UPSERT fix ensures the DB lifecycle is not clobbered regardless of the in-memory registry state. If a future bug creates this edge case, the DB remains authoritative.

## Problem Summary

The investigation established this exact sequence:

1. `5611028` added the Completed column, but the query has always been strict to `status='completed'`.
2. `f439869` introduced the latent coercion:
   - `_loadPlanRegistry()` maps `p.status === 'completed' ? 'archived' : p.status` (lines 5726, 5740)
   - `_migrateLegacyToRegistry()` maps `sheet.completed === true ? 'archived' : 'active'` (line 6375)
3. `231c3b4` changed `UPSERT_PLAN_SQL` so `ON CONFLICT(plan_id)` now overwrites:
   - `kanban_column = excluded.kanban_column` (line 156)
   - `status = excluded.status` (line 157)
4. Startup/full sync later ran `_savePlanRegistry()` (line 5830) through the normal reconciliation chain, causing old completed rows to be silently rewritten to archived rows in the DB — because `_loadPlanRegistry()` coerces `completed -> archived` in-memory, and `_savePlanRegistry()` then feeds that coerced status back through `upsertPlans()`.
5. The Completed board then went empty because `getCompletedPlans()` (KanbanDatabase.ts:772) queries strictly for `status='completed'` and no longer matched those rows.

This also explains the "why today?" contradiction:

- There was **not** a mass `mark_complete`/archive event today.
- The DB could still lose Completed visibility today because registry saves preserved old `updated_at` values while overwriting `status`.
- Current DB evidence now shows the damaged state directly:
  - `status='completed'`: **0**
  - `status='archived' AND kanban_column='COMPLETED'`: **179**

## Proposed Changes
> [!IMPORTANT]
> **MAXIMUM DETAIL REQUIRED:** The eventual implementation should fix the full causal chain, not just the visible query symptom.

### 1. Restore `completed` as a first-class registry lifecycle state
#### [MODIFY] `src/services/TaskViewerProvider.ts`
- **Context:** The registry type currently has no first-class `completed` state (`PlanRegistryEntry.status` at line 127 is `'active' | 'archived' | 'deleted' | 'orphan'`), which forces completion-like data into `archived`.
- **Logic:**
  1. **Line 127** — Extend `PlanRegistryEntry.status` to include `'completed'`:
     ```ts
     // BEFORE (line 127):
     status: 'active' | 'archived' | 'deleted' | 'orphan';
     // AFTER:
     status: 'active' | 'archived' | 'completed' | 'deleted' | 'orphan';
     ```
  2. **Lines 5726, 5740** — In `_loadPlanRegistry()`, remove the `completed -> archived` coercion in BOTH the stale-entry path and the main entries path:
     ```ts
     // BEFORE (line 5726, stale-entry path):
     status: p.status === 'completed' ? 'archived' : p.status as PlanRegistryEntry['status'],
     // AFTER:
     status: p.status as PlanRegistryEntry['status'],

     // BEFORE (line 5740, main entries path — identical change):
     status: p.status === 'completed' ? 'archived' : p.status as PlanRegistryEntry['status'],
     // AFTER:
     status: p.status as PlanRegistryEntry['status'],
     ```
  3. **Line 6375** — In `_migrateLegacyToRegistry()`, map `sheet.completed` to `'completed'`:
     ```ts
     // BEFORE (line 6375):
     status: sheet.completed === true ? 'archived' : 'active'
     // AFTER:
     status: sheet.completed === true ? 'completed' : 'active'
     ```
  4. **Lines 8539, 8542** — In `_handleCompletePlan()`, pass `'completed'` to `_updatePlanRegistryStatus()` for both brain and local plan paths:
     ```ts
     // BEFORE (line 8539, brain plan path):
     await this._updatePlanRegistryStatus(resolvedWorkspaceRoot, pathHash, 'archived');
     // AFTER:
     await this._updatePlanRegistryStatus(resolvedWorkspaceRoot, pathHash, 'completed');

     // BEFORE (line 8542, local plan path):
     await this._updatePlanRegistryStatus(resolvedWorkspaceRoot, sessionId, 'archived');
     // AFTER:
     await this._updatePlanRegistryStatus(resolvedWorkspaceRoot, sessionId, 'completed');
     ```
  5. **Clarification:** Add an inline comment at line 8548 (`db.updateStatus(sessionId, 'completed')`) explaining this is a belt-and-suspenders write using the raw sessionId, complementing the registry-derived write above.
  6. **Line 5999** — `_getRecoverablePlans()` check: currently scoped to `entry.status === 'archived' || entry.status === 'orphan'` — **no change needed**. Completed plans stay out of the recover modal.
  7. **Line 6135** — `_handleRestorePlan()` check: `allowedRestoreStatuses` already includes `'completed'` — **no change needed**. Kanban's Completed-card recovery action still routes through this handler.
- **Implementation Notes:**
  - The important separation is:
    - `status='completed'` → visible terminal board state
    - archived files on disk → storage detail, not board lifecycle
  - Do not remove `_archiveCompletedSession()` from the completion flow in this plan.
  - `_updatePlanRegistryStatus()` at line 5949 maps `'orphan' -> 'archived'` but passes `'completed'` through unchanged — no change needed.
  - `_registerPlan()` at line 5919 has the same `'orphan' -> 'archived'` mapping — passes `'completed'` through unchanged — no change needed.
- **Edge Cases Handled:** Completed cards stay visible after reload, but the existing "recover from Completed back to active board" behavior still works.

### 2. Stop generic registry saves from overwriting existing DB lifecycle fields
#### [MODIFY] `src/services/KanbanDatabase.ts`
- **Context:** `231c3b4` changed `UPSERT_PLAN_SQL` (lines 145-173) so every conflict update now writes `status` and `kanban_column`, which is dangerous because `_savePlanRegistry()` is used by rename/topic/reconcile flows that are **not** lifecycle-authoritative.
- **Logic:**
  1. **Lines 156-157** — Remove `kanban_column` and `status` from the `ON CONFLICT DO UPDATE SET` clause:
     ```sql
     -- BEFORE (lines 156-157 of UPSERT_PLAN_SQL):
         kanban_column = excluded.kanban_column,
         status = excluded.status,
     -- AFTER: (these two lines are deleted entirely)
     ```
  2. **Clarification:** Add a JSDoc comment above `UPSERT_PLAN_SQL` (before line 145) explaining lifecycle exclusion:
     ```ts
     /**
      * Generic plan upsert. On conflict, updates metadata fields (topic, plan_file, etc.)
      * but intentionally does NOT overwrite lifecycle fields (status, kanban_column).
      * Use updateStatus() and updateColumn() for explicit lifecycle transitions.
      */
     ```
  3. **Audit `upsertPlans()` call sites** — only two exist in the codebase:
     - `_savePlanRegistry()` at TaskViewerProvider.ts:5859 — metadata sync; reads existing lifecycle from DB at line 5841 (`existing?.kanbanColumn || 'CREATED'`) and line 5842 (`entry.status`). After the UPSERT fix, the lifecycle values it passes are irrelevant for existing rows because the ON CONFLICT clause no longer writes them. For new rows (no conflict), the INSERT still sets all fields correctly. **Safe.**
     - `_registerPlan()` at TaskViewerProvider.ts:5913 — plan registration; reads `existing?.kanbanColumn || 'CREATED'` at line 5918 and status at line 5919. Same analysis applies. **Safe.**
     - If any future caller genuinely requires lifecycle overwrite on conflict, add an explicit dedicated API or opt-in flag rather than keeping lifecycle overwrite global.
  4. Leave `getCompletedPlans()` (line 772) strict to `status='completed'`.
- **Implementation Notes:**
  - The current `KanbanMigration.syncPlansMetadata()` comment already says status/column are **never** overwritten for existing records; the DB API should match that contract again.
  - This change is what prevents ordinary startup reconciliation from clobbering Completed rows the next time `_savePlanRegistry()` runs.
- **Edge Cases Handled:** Topic/path/metadata syncs remain safe for existing rows; lifecycle updates still happen through explicit mutation paths instead of incidental full-registry saves.

### 3. Repair already-corrupted workspaces idempotently
#### [MODIFY] `src/services/KanbanDatabase.ts`
- **Context:** Existing databases already contain many rows that are stuck in `status='archived'` while still living in `kanban_column='COMPLETED'`. Current evidence: 179 affected rows, 0 genuine `status='completed'` rows.
- **Logic:**
  1. **After line 1535** — Add a V10 self-heal migration step in `_runMigrations()`, after the existing V9 block:
     ```ts
     // V10: repair completed-column status regression — archived rows in COMPLETED
     // column should have status='completed'. See: restore_completed_column_visibility plan.
     try {
         const repairStmt = this._db.prepare(
             "SELECT COUNT(*) as cnt FROM plans WHERE status = 'archived' AND kanban_column = 'COMPLETED'"
         );
         let repairedCount = 0;
         if (repairStmt.step()) {
             repairedCount = Number(repairStmt.getAsObject().cnt);
         }
         repairStmt.free();
         if (repairedCount > 0) {
             this._db.exec(
                 "UPDATE plans SET status = 'completed' WHERE status = 'archived' AND kanban_column = 'COMPLETED'"
             );
             console.log(`[KanbanDatabase] V10 migration: repaired ${repairedCount} completed-column status row(s)`);
         }
     } catch (e) {
         console.error('[KanbanDatabase] V10 completed-status repair failed:', e);
     }
     ```
  2. Use direct SQL to restore only the damaged shape:
     ```sql
     UPDATE plans
     SET status = 'completed'
     WHERE status = 'archived' AND kanban_column = 'COMPLETED';
     ```
  3. Do **not** touch `updated_at`, `created_at`, or `kanban_column`.
  4. Log the repaired row count for diagnostics.
  5. Let `getCompletedPlans()`, `SessionActionLog.getCompletedRunSheets()`, and mirror-reconciliation logic pick up the repaired rows naturally.
- **Implementation Notes:**
  - Re-running the migration on later startups should be a no-op once the damaged rows are fixed.
  - This is safer than widening the Completed query because it restores the intended data shape instead of normalizing around corruption.
  - The migration runs inside `_runMigrations()` which is called from both `ensureReady()` (line 1357) and `_reloadIfStale()` (line 1307), so it executes on first load and on stale-DB reload.
- **Edge Cases Handled:** Preserves historical completion ordering and works across DBs that already contain affected rows.

### 4. Keep board / restore behavior coherent after the status fix
#### [AUDIT / MINIMAL MODIFY] `src/services/KanbanProvider.ts`
- **Context:** The board already:
  - renders Completed from `db.getCompletedPlans(...)`
  - writes `completed` on explicit board moves to `COMPLETED`
  - and has a dedicated Completed-card recovery path that sets rows back to `active`
- **Logic:**
  1. Keep the Completed rendering contract unchanged after the DB and registry fixes.
  2. Audit comments/log text that still describe Completed as "archived plans" and update only where it would mislead future maintenance.
  3. Verify the Completed-card recovery flow still rolls back to `status='completed'` on failed restore and `status='active'` on successful recovery.
- **Implementation Notes:**
  - This file may not need substantial logic changes once the upstream lifecycle fixes land.
  - Avoid adding a fallback query for `archived` rows here; the data repair should make that unnecessary.
- **Edge Cases Handled:** Keeps manual board movement and recovery semantics stable while the underlying lifecycle model is corrected.

### 5. Leave the phantom archive setting as a separate follow-up
#### [NO CHANGE] `package.json`, `src/webview/setup.html`, archive setting plumbing
- **Context:** `switchboard.archive.autoArchiveCompleted` is real but unused. It did not cause today's disappearance.
- **Logic:**
  1. Explicitly leave this setting untouched in this plan.
  2. If the team wants to expose or honor that setting, create a separate implementation plan after the Completed regression is fixed.
- **Edge Cases Handled:** Keeps the incident fix small, testable, and causally aligned with the actual regression.

### 6. Add regression coverage that locks the causal chain
#### [CREATE] `src/test/completed-column-status-regression.test.js`
- **Context:** This bug crossed registry typing, migration, completion handling, DB upsert semantics, and startup repair. A focused regression test should lock all of those together.
- **Logic:**
  1. Read `src/services/TaskViewerProvider.ts` and assert `PlanRegistryEntry.status` includes `'completed'`.
  2. Assert `_loadPlanRegistry()` no longer contains `p.status === 'completed' ? 'archived' : p.status`.
  3. Assert `_migrateLegacyToRegistry()` no longer contains `sheet.completed === true ? 'archived' : 'active'`.
  4. Assert `_handleCompletePlan()` still calls `_archiveCompletedSession(...)` but updates registry status to `'completed'` (not `'archived'`).
  5. Assert `UPSERT_PLAN_SQL` in `src/services/KanbanDatabase.ts` no longer contains `status = excluded.status` or `kanban_column = excluded.kanban_column` in the ON CONFLICT clause.
  6. Assert the V10 DB migration/self-heal exists: search for `status = 'completed' WHERE status = 'archived' AND kanban_column = 'COMPLETED'` in `_runMigrations()`.
  7. Assert `getCompletedPlans()` remains strict to `status='completed'` so future regressions cannot reintroduce hidden corruption behind a widened query.
  8. Assert `_getRecoverablePlans()` still lists archived/orphan entries only (line 5999 checks `'archived'` or `'orphan'`), while `_handleRestorePlan()` still accepts `'completed'` in `allowedRestoreStatuses` (line 6135) for Kanban recovery.
- **Optional Follow-up:** If the source-level test becomes too brittle, replace part of it with a small in-memory DB test that seeds an `archived+COMPLETED` row and verifies the migration/self-heal restores visibility without changing `updated_at`.

## Verification Plan
### Manual Checks
- Start from a workspace whose DB currently has `status='archived' AND kanban_column='COMPLETED'` rows.
- Launch/reload the extension and confirm the Completed column repopulates without creating a fresh archive-wave in `updated_at`.
- Move a live plan into `COMPLETED`, reload/startup again, and verify it remains visible in Completed.
- Recover a Completed card back to an active column and confirm it returns to `active` without duplicate rows or missing files.
- Confirm the recover modal still shows archived/orphan plans only, not visible Completed cards.

### Database Checks
- Before fix (current damaged shape):
  ```sql
  SELECT COUNT(*) FROM plans WHERE status = 'completed';
  SELECT COUNT(*) FROM plans WHERE status = 'archived' AND kanban_column = 'COMPLETED';
  ```
- After fix:
  - `status='completed'` should include the historical Completed backlog again.
  - `status='archived' AND kanban_column='COMPLETED'` should be **0** unless a future bug reintroduces corruption.
- Also verify timestamp preservation:
  ```sql
  SELECT session_id, topic, status, kanban_column, updated_at
  FROM plans
  WHERE kanban_column = 'COMPLETED'
  ORDER BY updated_at DESC
  LIMIT 20;
  ```

### Automated Checks
- `npm run compile`
- `node src/test/completed-column-status-regression.test.js`
- If the implementation adjusts recovery assertions, also run:
  - `node src/test/plan-recovery-regression.test.js`

## Agent Recommendation
Send to Lead Coder

## Review Findings

### Stage 1 — Grumpy Principal Engineer

- [NIT] The implementation is annoyingly complete: `src/services/TaskViewerProvider.ts` preserves `completed`, `src/services/KanbanDatabase.ts` stops lifecycle overwrite in `UPSERT_PLAN_SQL` and adds the V10 repair, and `src/test/completed-column-status-regression.test.js` exercises the whole chain.
- [NIT] I do not see any CRITICAL or MAJOR defects left in the completed-status repair path. The only lingering risk is future callers reusing generic upsert semantics for lifecycle mutations, which the code now documents against in `src/services/KanbanDatabase.ts:145-149`.

### Stage 2 — Balanced Synthesis

- Keep the current implementation as-is: the lifecycle fix, startup repair, and regression coverage are aligned with the plan.
- No code fixes were required during review.
- Defer only the usual future hardening: if a new lifecycle-mutating call site is added later, it should use `updateStatus()` / `updateColumn()` instead of generic upsert.

## Fixes Applied

- None. The checked-in implementation already matched the plan requirements.

## Files Changed

- `.switchboard/plans/restore_completed_column_visibility_and_preserve_completed_status.md`

## Validation Results

- `npm run compile` ✅
- `node src/test/completed-column-status-regression.test.js` ✅

## Remaining Risks

- A future `upsertPlans()` caller could reintroduce lifecycle overwrite if it ignores the documented contract.
- The V10 repair is intentionally broad for the damaged shape (`archived + COMPLETED`); any future legitimate use of that combination would need a separate migration strategy.
