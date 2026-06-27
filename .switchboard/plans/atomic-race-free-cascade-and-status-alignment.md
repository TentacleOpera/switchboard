# Atomic Race-Free Epic Cascade + Subtask Status Alignment

## Goal

Two related defects remain in the epic cascade paths after the comprehensive epic fix:

1. **Subtask `status` is not cascaded by Class 3/7 completion paths (Issue 2).** When an epic is completed via `completePlan`/`completeSelected`/`completeAll` or recovered via `uncompleteCard`, the cascade only updates `kanban_column` — subtask `status` stays `active`. But Class 8 (`completeMultipleByPlanFile`) cascades both `kanban_column` AND `status`. This inconsistency means a subtask completed via the card Done button has `column=COMPLETED` + `status='active'`, while one completed via run-sheet flip has `column=COMPLETED` + `status='completed'`. The Class 6 agent-prompt cascade uses `WHERE epic_id = ? AND status = 'active'`, so a "completed" subtask with `status='active'` can be re-yanked on the next epic move.

2. **Read-then-write subtask race in Class 2/3/7 (Issue 4).** The explicit-`subtaskPlanIds[]` cascade pattern reads subtasks via `getSubtasksByEpicId(plan.planId)` then passes those IDs to `updateColumnWithEpicCascadeByPlanId` in a separate call. A subtask added/removed between the read and the write (file watcher from another IDE, concurrent card creation) is missed. Class 8 already uses the atomic `WHERE epic_id = ? AND status = 'active'` form (race-free). User Review Required #4 from the comprehensive plan proposed switching Class 2/3/7 to the same form — this plan implements that.

**Root cause:** Both issues stem from the same design choice: the Class 2/3/7 cascade uses a two-step read-then-write pattern with explicit subtask IDs, while Class 8 uses a single atomic UPDATE with a `WHERE epic_id = ?` subquery. The two-step pattern is both race-prone (issue 4) and status-incomplete (issue 2 — it only cascades `kanban_column` because `updateColumnWithEpicCascadeByPlanId` is column-only by design).

## Metadata

**Tags:** bugfix, backend, database
**Complexity:** 5

## User Review Required

1. **Replace `updateColumnWithEpicCascadeByPlanId` or add a new method?** The existing method takes explicit `subtaskPlanIds[]` and only updates `kanban_column`. Options:
   - **(a) Add a new method** `cascadeEpicByPlanId(epicPlanId, targetColumn, targetStatus?)` that uses `WHERE epic_id = ? AND status = 'active'` (atomic, race-free) and optionally cascades `status`. Keep the old method for backward compat.
   - **(b) Modify the existing method** to accept an optional `targetStatus` parameter and switch to the `WHERE epic_id = ?` form internally. Breaking change for any caller passing explicit IDs (but grep confirms all callers are in the comprehensive fix's call sites — no external consumers).

   **Default below uses (a)** — additive, zero risk to existing callers, and the old method can be deprecated once all sites switch.

2. **Should `uncompleteCard` cascade `status='active'` to subtasks?** When recovering an epic from COMPLETED, the epic gets `status='active'` (line 6811 in KanbanProvider). Should subtasks also get `status='active'`? **Confirm yes** — a recovered epic's subtasks should be active too, matching the epic-as-rigid-unit model. The rollback path (re-cascade to COMPLETED) should also set `status='completed'`.

## Complexity Audit

### Routine
- New `cascadeEpicByPlanId` method is a near-clone of `updateColumnWithEpicCascadeByPlanId` but swaps the explicit-ID subtask UPDATE for `WHERE epic_id = ? AND status = 'active'`, and adds an optional `status` SET clause.
- Caller updates are mechanical: replace `getSubtasksByEpicId` + `updateColumnWithEpicCascadeByPlanId(planId, subtaskPlanIds, col)` with `cascadeEpicByPlanId(planId, col)` (or `cascadeEpicByPlanId(planId, col, 'completed')` for completion paths). Removes the read step entirely.

### Complex / Risky
- **`WHERE epic_id = ? AND status = 'active'` excludes completed/deleted subtasks.** This is correct for forward moves (don't re-yank a completed subtask) but means a completed subtask won't be recovered when the epic is uncompleted. The `uncompleteCard` path needs `WHERE epic_id = ?` (no status filter) or a separate `status='active'` SET to re-activate subtasks. **This is the one site where the status filter must be relaxed.**
- **`testingFailureReport` moves to LEAD CODED but shouldn't change `status`.** A plan sent back for fixes stays `status='active'` — only the column changes. So `cascadeEpicByPlanId` must make `targetStatus` truly optional (omit from SET when not provided).
- **`_restoreFromArchive` moves to CREATED and sets `status='active'`.** Subtasks should get both `kanban_column='CREATED'` and `status='active'`. But the `WHERE epic_id = ? AND status = 'active'` filter would exclude subtasks that were `status='completed'` or `status='deleted'` before archiving. The restore path needs `WHERE epic_id = ?` (no status filter) to catch all subtasks, plus set `status='active'`.

## Edge-Case & Dependency Audit

**Race Conditions**
- The new method eliminates the read-then-write race for all Class 2/3/7 sites. The subtask UPDATE uses `WHERE epic_id = ?` inside the same `BEGIN`/`COMMIT` as the epic UPDATE — atomic, no read step. A subtask added between the epic UPDATE and the subtask UPDATE is still caught because the `WHERE epic_id = ?` subquery runs at UPDATE time, not at read time.

**Side Effects**
- Subtasks of a completed epic will now get `status='completed'` (not just `kanban_column='COMPLETED'`). This aligns with Class 8 and fixes the Class 6 re-yank risk. Any code that checks `subtask.status === 'active'` to determine if a subtask is "done" will now correctly see completed subtasks as completed.
- Subtasks of a recovered (uncompleted) epic will now get `status='active'` (not just `kanban_column` moved back). This is correct — a recovered epic's subtasks are active again.
- The `subtaskSessionIds` variable (used for integration sync fan-out in `moveCardToColumn`/`moveCardToColumnByPlanFile`) is still needed — the atomic cascade doesn't return which subtasks it moved, so the sync fan-out still needs the read step. This is a benign residual: the sync fan-out is best-effort (`Promise.allSettled`), and a missed subtask just doesn't get synced to Linear/ClickUp on this move (it'll be reconciled on the next inbound poll). The race here is harmless (sync is not authoritative).

**Dependencies & Conflicts**
- Depends on the comprehensive epic fix (already implemented) — specifically `updateColumnWithEpicCascadeByPlanId` and the caller sites it created.
- The Notion restore cascade plan should use `cascadeEpicByPlanId` if this plan is implemented first.
- The `move-card.js` skill script (line 128) uses the old `updateColumnWithEpicCascade` in its direct-DB fallback — that should also be updated to use the new method, but it's in the "Replace Raw Prompt SQL" plan's scope (or a separate fix).

## Adversarial Synthesis

Key risks: (1) the `WHERE epic_id = ? AND status = 'active'` filter is correct for forward moves but wrong for recovery/restore paths (uncomplete, restore-from-archive) where you want to catch ALL subtasks regardless of status — these sites need the filter relaxed; (2) the integration sync fan-out still needs `getSubtasksByEpicId` to know which subtask `sessionId`s to sync, so the read step isn't fully eliminated at `moveCardToColumn`/`moveCardToColumnByPlanFile` — only the cascade's race is closed, not the sync's; (3) `cascadeEpicByPlanId` with no `targetStatus` must omit `status` from the SET clause entirely (not set it to NULL or empty), so non-completion moves don't accidentally clear subtask status.

## Proposed Changes

### `src/services/KanbanDatabase.ts`
- **Context:** Central DB layer. New atomic cascade method. Verified: `updateColumnWithEpicCascadeByPlanId` exists at line 3826 (not ~3909 as previously stated). `cascadeEpicByPlanId` does NOT yet exist. All required symbols verified: `VALID_KANBAN_COLUMNS` (line 631), `SAFE_COLUMN_NAME_RE` (line 638), `ensureReady` (line 1136), `_persist` (line 5456), `_db` (line 1104), `getSubtasksByEpicId` (line 3811), `updateColumn` (line 1463), `updateStatus` (line 1656). Class 8 reference: `completeMultipleByPlanFile` at line 2878 uses the atomic `WHERE epic_id = ? AND status = 'active'` form with both column+status (lines 2900-2903) — this is the pattern to replicate.
- **Logic:** Add `cascadeEpicByPlanId` after `updateColumnWithEpicCascadeByPlanId` (line 3826):

```typescript
/**
 * Atomic, race-free epic cascade: move an epic and all its active subtasks
 * to a target column in one transaction. Optionally also update status.
 *
 * Unlike updateColumnWithEpicCascadeByPlanId (which takes explicit subtaskPlanIds[]
 * and has a read-then-write race), this uses `WHERE epic_id = ?` inside the UPDATE
 * — subtasks added between the epic move and the subtask move are still caught.
 *
 * @param epicPlanId    The epic's plan_id.
 * @param targetColumn  Target kanban column (validated against VALID_KANBAN_COLUMNS).
 * @param targetStatus  Optional status to also set for the epic + subtasks (e.g. 'completed').
 *                      When omitted, status is NOT touched (correct for non-completion moves).
 * @param includeAllSubtasks When true, do NOT filter subtasks by status='active' (needed for
 *                      recovery/restore paths that must catch completed/deleted subtasks too).
 *                      Default false (only active subtasks cascade on forward moves).
 */
public async cascadeEpicByPlanId(
    epicPlanId: string,
    targetColumn: string,
    targetStatus?: string,
    includeAllSubtasks: boolean = false
): Promise<boolean> {
    if (!(await this.ensureReady()) || !this._db) return false;
    if (!VALID_KANBAN_COLUMNS.has(targetColumn) && !SAFE_COLUMN_NAME_RE.test(targetColumn)) {
        console.error(`[KanbanDatabase] cascadeEpicByPlanId rejected invalid column: ${targetColumn}`);
        return false;
    }
    const now = new Date().toISOString();
    const statusClause = targetStatus ? ', status = ?' : '';
    const subtaskStatusFilter = includeAllSubtasks ? '' : " AND status = 'active'";
    try {
        this._db.run('BEGIN');
        // Move the epic itself
        const epicParams: unknown[] = targetStatus
            ? [targetColumn, targetStatus, now, epicPlanId]
            : [targetColumn, now, epicPlanId];
        this._db.run(
            `UPDATE plans SET kanban_column = ?${statusClause}, updated_at = ? WHERE plan_id = ?`,
            epicParams
        );
        // Cascade subtasks atomically (no read-then-write race)
        const subtaskParams: unknown[] = targetStatus
            ? [targetColumn, targetStatus, now, epicPlanId]
            : [targetColumn, now, epicPlanId];
        this._db.run(
            `UPDATE plans SET kanban_column = ?${statusClause}, updated_at = ? WHERE epic_id = ?${subtaskStatusFilter}`,
            subtaskParams
        );
        this._db.run('COMMIT');
        await this._persist();
        return true;
    } catch (err) {
        try { this._db.run('ROLLBACK'); } catch { /* ignore */ }
        console.error('[KanbanDatabase] cascadeEpicByPlanId failed:', err);
        return false;
    }
}
```

- **Edge Cases:** `targetStatus` omitted → status not touched. `includeAllSubtasks=true` → catches completed/deleted subtasks (recovery/restore). Column validation matches sibling methods.

### `src/services/KanbanProvider.ts`
- **Context:** Webview handlers + card-move orchestration.
- **Logic:** Replace each Class 2/3/7 cascade site:

1. **`moveCardToColumn` (~4839-4842):** Replace `getSubtasksByEpicId` + `updateColumnWithEpicCascadeByPlanId` with `cascadeEpicByPlanId(plan.planId, targetColumn)`. Keep the `getSubtasksByEpicId` call ONLY for the integration sync fan-out (`subtaskSessionIds`).

2. **`moveCardToColumnByPlanFile` (~4905-4908):** Same replacement with `cascadeEpicByPlanId(previousRecord.planId, targetColumn)`. Keep `getSubtasksByEpicId` for sync fan-out.

3. **`completePlan` (~6694-6698):** Replace with `cascadeEpicByPlanId(plan.planId, 'COMPLETED', 'completed')`. Remove the separate `getSubtasksByEpicId` + explicit-ID construction.

4. **`completeSelected` (~6720-6724):** Same — `cascadeEpicByPlanId(plan.planId, 'COMPLETED', 'completed')` in the loop.

5. **`completeAll` (~6762-6764):** Same — `cascadeEpicByPlanId(card.planId, 'COMPLETED', 'completed')`.

6. **`uncompleteCard` (~6800-6813 + rollback ~6827):** Forward: `cascadeEpicByPlanId(epicPlanId, targetColumn, 'active', true)` — `includeAllSubtasks=true` because recovering an epic must pull ALL subtasks back, not just active ones (a completed subtask should be re-activated when the epic is recovered). Rollback: `cascadeEpicByPlanId(epicPlanId, 'COMPLETED', 'completed')`.

7. **`testingFailureReport` (~7108-7112):** Replace with `cascadeEpicByPlanId(plan.planId, 'LEAD CODED')` — no `targetStatus` (plan stays active, only column changes).

### `src/services/TaskViewerProvider.ts`
- **Context:** Sidebar/agent dispatch fallbacks.
- **Logic:**

8. **`_updateKanbanColumnForSession` fallback (~2260-2263):** Replace with `cascadeEpicByPlanId(plan.planId, column)`. Keep the empty-sessionId guard.

9. **`_restoreFromArchive` fallback (~11644-11648):** Replace with `cascadeEpicByPlanId(restorePlan.planId, 'CREATED', 'active', true)` — `includeAllSubtasks=true` because restoring from archive must catch all subtasks regardless of prior status.

10. **`markPlanComplete` fallback (~14077-14081):** Replace with `cascadeEpicByPlanId(completePlan.planId, 'COMPLETED', 'completed')`.

## Verification Plan

> Per project conventions: skip compilation and automated tests during implementation; the user runs the suite separately.

### Manual tests
- Complete an epic via card Done button → epic + all subtasks get `kanban_column=COMPLETED` AND `status=completed` (verify with `SELECT plan_id, kanban_column, status FROM plans WHERE epic_id = '<epicPlanId>'`).
- Complete an epic via Complete Selected → same.
- Complete an epic via Complete All → same.
- Recover an epic from COMPLETED (uncompleteCard) → epic + all subtasks get `kanban_column=<target>` AND `status=active`, including subtasks that were previously `status=completed`.
- Rollback of a failed epic recovery → epic + subtasks re-cascade to `COMPLETED` + `status=completed`.
- Move an epic from CREATED to PLAN REVIEWED (drag) → epic + subtasks move, `status` stays `active` (no status cascade on non-completion moves).
- Testing failure report on an epic → epic + subtasks move to LEAD CODED, `status` stays `active`.
- Restore an epic from archive with `_kanbanProvider` null → epic + ALL subtasks (including previously completed/deleted) move to CREATED + `status=active`.
- Mark an epic complete via run-sheet editor with `_kanbanProvider` null → epic + subtasks get `COMPLETED` + `status=completed`.
- Add a subtask to an epic while the epic is being moved (concurrent file watcher) → new subtask is caught by the atomic `WHERE epic_id = ?` cascade (no read-then-write miss).
- Class 6 agent-prompt cascade on a previously-completed epic → subtasks with `status=completed` are NOT re-yanked (the `WHERE status = 'active'` filter excludes them — this is the fix for the re-yank risk).

## Recommendation

Complexity 5 (Medium: new DB method + 10 mechanical caller updates, with the `includeAllSubtasks` flag being the only non-obvious design decision) → **Send to Coder**. The implementer must pay attention to which sites need `includeAllSubtasks=true` (uncompleteCard, _restoreFromArchive) vs. the default `false` (forward moves, completions, testing failure). The `targetStatus` parameter must be omitted (not set to empty string) for non-completion moves.
