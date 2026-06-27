# Notion Restore: Epic Subtask Cascade

## Goal

Notion backup restore (`NotionBackupService.restoreFromNotion`) updates each restored plan's `kanban_column` via `db.updateColumn(sessionId, column)` — the same epic-agnostic pattern as the original Class 7 bugs, with no epic check or subtask cascade. Restoring an epic from Notion moves the epic card but leaves its subtasks stranded in their pre-restore columns. Additionally, Notion backup does not capture `is_epic` or `epic_id` at all, so the restore path has no way to know which restored plans are epics or which subtasks belong to them — unless we either extend the Notion schema or use the local DB's existing epic/subtask relationships.

**Root cause:** `_notionPageToPlanRecord` (line 456) never sets `isEpic` or `epicId` — these fields are absent from both the Notion property schema (`_planToNotionProperties`, line 436) and the reverse mapping. The Class 1 `CASE` fix (from the comprehensive epic fix plan) incidentally preserves local `is_epic` on restore (because `upsertPlans` passes `isEpic ?? 0` and the `CASE` keeps the existing value), but `epic_id` is NOT sticky — it's handled by a separate `COALESCE(excluded.epic_id, ...)` clause that may or may not preserve it depending on whether the restored record carries the field. Since `_notionPageToPlanRecord` omits `epicId`, the upsert's `epic_id` handling determines whether subtask links survive.

**Background:** This was explicitly scoped out of the comprehensive epic fix plan (User Review Required #2) because it requires a semantic decision: should Notion backup capture `is_epic`/`epic_id`, or should restore use local DB relationships to cascade? This plan addresses that deferred decision.

## Metadata

**Tags:** bugfix, backend, database
**Complexity:** 4

## User Review Required

1. **Should Notion backup capture `is_epic` and `epic_id`?** Two options:
   - **(a) Extend Notion schema** — add `is_epic` (checkbox) and `epic_id` (rich_text) properties to the Notion database, capture them in `_planToNotionProperties`, and restore them in `_notionPageToPlanRecord`. This makes the backup self-contained and allows cross-workspace restore to reconstruct epic/subtask relationships. **Risk:** existing Notion databases in production don't have these properties — adding them requires a schema migration (auto-add properties on first backup/restore, or instruct users to add them manually).
   - **(b) Use local DB relationships only** — don't change the Notion schema. On restore, after `upsertPlans`, query the local DB for which restored plans are epics (`is_epic = 1`) and cascade their subtasks' columns to match. This is simpler but assumes the local DB already has the correct `is_epic`/`epic_id` relationships (which it does, since the Class 1 fix preserves `is_epic` on upsert, and `epic_id` is preserved by the existing `COALESCE` if the restored record omits it). **Limitation:** a restore to a fresh/empty workspace (no pre-existing local data) cannot reconstruct epic/subtask links because Notion doesn't carry them.

   **Default below uses (b)** — it's lower-risk (no Notion schema migration), and the common restore scenario is restoring over an existing workspace where local epic/subtask relationships are already intact. Option (a) can be a follow-up if cross-workspace restore becomes a requirement.

2. **Should restore cascade subtask `status` as well as `kanban_column`?** If an epic is restored to `COMPLETED`, should its subtasks also get `status='completed'`? The comprehensive fix plan's Risk #2 identified that completion paths are inconsistent about cascading `status`. **Confirm:** for Notion restore, cascade both `kanban_column` and `status` to match the epic's restored values (so the board and the status field agree). This is the safer choice — a subtask showing `COMPLETED` on the board but `status='active'` in the DB is the exact inconsistency that Risk #2 flags.

## Complexity Audit

### Routine
- After `upsertPlans` + `updateColumn` loop, add a post-restore cascade pass: query local DB for restored plans that are epics, find their subtasks, and cascade the epic's column (and status) to all active subtasks. Localized to `NotionBackupService.restoreFromNotion`.
- Reuses `getSubtasksByEpicId` and a new cascade call (either the existing `updateColumnWithEpicCascadeByPlanId` or the atomic variant from the "Atomic Race-Free Cascade" plan, whichever is available).

### Complex / Risky
- **`epic_id` preservation on upsert — VERIFIED SAFE.** The restored record from `_notionPageToPlanRecord` (line 456) omits `epicId`. `upsertPlans` (line 1251) binds `record.epicId || ''` (line 1284) → empty string `''`. The `UPSERT_PLAN_SQL` conflict clause (line 595): `epic_id = CASE WHEN excluded.epic_id IS NOT NULL AND excluded.epic_id != '' THEN excluded.epic_id ELSE epic_id END`. Since `excluded.epic_id` is `''`, the condition `IS NOT NULL AND != ''` is FALSE → ELSE preserves the existing local `epic_id`. **Confirmed by tracing the binding chain.** No change needed to the upsert clause.
- **File-based plan gap in the proposed cascade code.** The `columnUpdates` array (built at lines 129-131) uses `plan.sessionId` as the key. For file-based plans, `sessionId` is `''`. The original proposed code uses `getPlanBySessionId(sessionId)` which would match a random plan for empty sessionId, then "guards" by skipping empty sessionId — but this means file-based epics restored from Notion DON'T CASCADE. **Fix:** carry `planId` in the `columnUpdates` tuples and use `getPlanByPlanId(planId)` for the cascade lookup. The restored record has `planId` from Notion's 'Plan ID' property (verified at `_notionPageToPlanRecord` line 467).
- **Fresh-workspace restore gap (option (b) only).** If restoring to a workspace with no pre-existing local data, the local DB has no `is_epic`/`epic_id` relationships to cascade from. The upsert creates rows with `is_epic=0` (default) and `epic_id=''` (default) because Notion doesn't carry these fields. The post-restore cascade pass finds no epics and no subtasks — nothing cascades. This is an inherent limitation of option (b); documented as a remaining risk, not a bug.
- **Unchanged-epic-column edge case.** The `columnUpdates` array is built only when `local.kanbanColumn !== plan.kanbanColumn` (line 129) — i.e., only for plans whose column CHANGED. An epic whose column didn't change but whose subtasks are in wrong columns won't be re-aligned by the cascade. This is a minor limitation of the restore path, not a bug — restore is typically used to recover from data loss where columns have drifted. Documented as a known limitation.

## Edge-Case & Dependency Audit

**Race Conditions**
- The stopgap post-restore cascade reads subtasks via `getSubtasksByEpicId` and updates them in a separate call — same read-then-write race as the existing Class 2/3/7 paths. If the "Atomic Race-Free Cascade" plan (Plan 2) is implemented first, use its atomic `cascadeEpicByPlanId` method (preferred path above) which eliminates the race.

**Side Effects**
- Notion restore will now move subtask cards to match the epic's restored column. Previously, subtasks stayed wherever they were. This is a behavior change — but it's the correct one (an epic and its subtasks should be in the same column after restore).
- If a subtask was deliberately moved to a different column than its epic before the backup was taken, restore will now yank it back to the epic's column. This matches the "epic-as-rigid-unit" model the board already enforces on manual moves.

**Dependencies & Conflicts**
- Depends on the Class 1 `CASE` fix (already implemented) preserving `is_epic` on upsert — verified.
- Depends on `epic_id` being preserved by the upsert's `CASE` clause when the restored record omits it — **VERIFIED SAFE** (traced binding chain: `record.epicId || ''` → `''` → CASE ELSE preserves existing `epic_id`).
- If the "Atomic Race-Free Cascade" plan is implemented first, this plan should use its atomic cascade method (`cascadeEpicByPlanId`) instead of `updateColumnWithEpicCascadeByPlanId`.

## Dependencies

- **Comprehensive Epic Fix** (already implemented) — Class 1 `CASE` fix preserves `is_epic` on upsert; Class 2 `updateColumnWithEpicCascadeByPlanId` provides the cascade method.
- **Atomic Race-Free Cascade plan** (if implemented first) — provides `cascadeEpicByPlanId` (race-free, atomic, optional status cascade) that this plan should use as the preferred path.

## Adversarial Synthesis

Key risks: (1) the original proposed code used `getPlanBySessionId(sessionId)` as the lookup key, but for file-based plans `sessionId` is `''` — this either matches a random plan or gets skipped by the guard, meaning file-based epics don't cascade — **fix: use `getPlanByPlanId(planId)` and carry `planId` in `columnUpdates`**; (2) the `epic_id` preservation uncertainty is resolved — verified safe by tracing the binding chain (`record.epicId || ''` → `''` → CASE ELSE preserves existing); (3) the stopgap status cascade is N separate `updateStatus` calls (not atomic) — if Plan 2 is implemented first, use `cascadeEpicByPlanId` for atomic column+status in one transaction; (4) unchanged-epic-column edge case: epics whose column didn't change aren't in `columnUpdates`, so scattered subtasks won't be re-aligned — documented as a known limitation. Mitigations: use `planId` as lookup key; present both code paths (Plan 2 atomic preferred, stopgap fallback); document the unchanged-column limitation.

## Proposed Changes

### `src/services/NotionBackupService.ts`
- **Context:** Notion backup/restore service. Verified: `restoreFromNotion` at line 88, `upsertPlans` at line 138, `updateColumn` loop at lines 140-142, `columnUpdates` built at lines 129-131 with `{ sessionId: plan.sessionId, column: plan.kanbanColumn }`. `_notionPageToPlanRecord` at line 456 omits `isEpic`/`epicId` (verified). `_planToNotionProperties` at line 436 omits `is_epic`/`epic_id` (verified). All required KanbanDatabase methods verified: `getPlanBySessionId` (2556), `getPlanByPlanId` (2648), `getSubtasksByEpicId` (3811), `updateColumnWithEpicCascadeByPlanId` (3826), `updateStatus` (1656), `updateColumn` (1463). `cascadeEpicByPlanId` does NOT yet exist (Plan 2 adds it).
- **Logic:**
  1. **Extend `columnUpdates` to carry `planId`** (lines 129-131): change the push to include `planId` from the restored record:
     ```typescript
     columnUpdates.push({ sessionId: plan.sessionId, planId: plan.planId, column: plan.kanbanColumn });
     ```
     This fixes the file-based-plan gap — file-based plans have `sessionId=''` but `planId` is always present from Notion's 'Plan ID' property.

  2. After the `upsertPlans` + `updateColumn` loop (line 142), add a post-restore epic cascade pass. **Two code paths depending on whether Plan 2 is implemented:**

     **Preferred path (Plan 2 implemented — atomic, race-free):**
     ```typescript
     // Post-restore: cascade epic column (and status) to subtasks.
     // The upsert preserves local is_epic (Class 1 CASE fix) and epic_id (CASE clause, verified safe),
     // so we can query the local DB for epic/subtask relationships after restore.
     for (const { planId, column } of columnUpdates) {
         if (!planId) continue; // skip if no planId (shouldn't happen — Notion always has Plan ID)
         const epic = await kanbanDb.getPlanByPlanId(planId);
         if (epic && epic.isEpic) {
             // Use atomic cascade from Plan 2 — handles both column + status in one transaction.
             // For COMPLETED epics, cascade status='completed'; for others, column-only.
             const targetStatus = epic.status === 'completed' ? 'completed' : undefined;
             await kanbanDb.cascadeEpicByPlanId(epic.planId, column, targetStatus);
         }
     }
     ```

     **Stopgap path (Plan 2 NOT yet implemented — read-then-write, manual status loop):**
     ```typescript
     for (const { planId, column } of columnUpdates) {
         if (!planId) continue;
         const epic = await kanbanDb.getPlanByPlanId(planId);
         if (epic && epic.isEpic) {
             const subtasks = await kanbanDb.getSubtasksByEpicId(epic.planId);
             const subtaskPlanIds = subtasks.map(st => st.planId).filter(Boolean) as string[];
             await kanbanDb.updateColumnWithEpicCascadeByPlanId(epic.planId, subtaskPlanIds, column);
             // If the epic's restored status is 'completed', cascade status to subtasks too.
             if (epic.status === 'completed') {
                 for (const st of subtasks) {
                     if (st.status === 'active') {
                         await kanbanDb.updateStatus(st.planId, 'completed');
                     }
                 }
             }
         }
     }
     ```

  3. **Use `planId` as the lookup key, NOT `sessionId`.** The original proposed code used `getPlanBySessionId(sessionId)` which is dangerous for file-based plans (sessionId='' matches a random plan). The corrected code uses `getPlanByPlanId(planId)` directly — `planId` is always present from Notion's 'Plan ID' property.
- **Edge Cases:** Fresh-workspace restore (no local epic data) → cascade is a no-op (finds no epics); documented as inherent limitation of option (b). `epic_id` preservation on upsert — VERIFIED SAFE (no change needed). Unchanged-epic-column edge case: an epic whose column didn't change won't be in `columnUpdates`, so its subtasks won't be re-aligned — documented as a known limitation.

## Verification Plan

> Per project conventions: skip compilation and automated tests during implementation; the user runs the suite separately.

### Automated Tests

Skipped per session directive — the user runs the test suite separately. No compilation or automated test steps are included in this plan.

### Manual tests
- Restore a Notion backup over a workspace with an existing epic in COMPLETED → epic + all subtasks move to COMPLETED, subtask `status` also becomes `completed`.
- Restore a Notion backup over a workspace with an epic in PLAN REVIEWED → epic + subtasks move to PLAN REVIEWED, subtask `status` stays `active`.
- Restore a Notion backup where a subtask was in a different column than its epic before backup → subtask now matches the epic's restored column (epic-as-rigid-unit model).
- Restore over a fresh workspace (no pre-existing local data) → no cascade occurs (no local epic relationships); plans restore with `is_epic=0`. Documented limitation.
- Verify `epic_id` is preserved after restore: restore a workspace with epic/subtask links, then query `SELECT plan_id, epic_id, is_epic FROM plans WHERE is_epic = 1 OR epic_id != ''` — links should be intact.
- Restore a Notion backup with a file-based epic (`sessionId=''`) → epic + subtasks cascade correctly via `getPlanByPlanId(planId)` lookup (the `planId`-based fix). Verify subtask columns match the epic's restored column.

## Recommendation

Complexity 4 (Medium: single-file change, reuses existing cascade mechanism, `epic_id` preservation verified safe, but has the fresh-workspace limitation and the file-based-plan lookup fix) → **Send to Coder**. Implement option (b) (local DB relationships) as the default; option (a) (extend Notion schema) can be a follow-up if cross-workspace restore is needed. **Critical:** use `planId` (not `sessionId`) as the cascade lookup key — the original proposed code's `sessionId`-based lookup silently drops file-based epics. If Plan 2 is implemented first, use the atomic `cascadeEpicByPlanId` path; otherwise use the stopgap with `updateColumnWithEpicCascadeByPlanId` + manual `updateStatus` loop.
