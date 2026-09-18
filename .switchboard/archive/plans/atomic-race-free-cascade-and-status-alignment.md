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
- The `move-card.js` skill script (line 128) calls `updateColumnWithEpicCascade` — a method that does NOT EXIST in KanbanDatabase.ts — in its direct-DB fallback. This is a crash (TypeError), not a logic bug. The "Replace Raw Prompt SQL" plan (Plan 1) fixes this by replacing the call with `updateColumnWithEpicCascadeByPlanId` or `cascadeEpicByPlanId` (from this plan).

## Dependencies

- **Comprehensive Epic Fix** (already implemented) — provides `updateColumnWithEpicCascadeByPlanId` (KanbanDatabase.ts line 3826) and the 10 caller sites that this plan refactors to use the new atomic method.
- **Replace Raw Prompt SQL plan** (Plan 1, if implemented after) — uses `cascadeEpicByPlanId` from this plan in the `move-card.js` direct-DB fallback fix.
- **Notion Restore plan** (Plan 3, if implemented after) — uses `cascadeEpicByPlanId` from this plan as the preferred cascade method in the post-restore cascade pass.
- **Recommended implementation order:** Plan 2 (this plan) → Plan 1 → Plan 3. This ensures `cascadeEpicByPlanId` is available for both downstream plans.

## Adversarial Synthesis

Key risks: (1) the `WHERE epic_id = ? AND status = 'active'` filter is correct for forward moves but wrong for recovery/restore paths (uncompleteCard, _restoreRunSheet) where you want to catch ALL subtasks regardless of status — these sites need `includeAllSubtasks=true`; (2) the integration sync fan-out still needs `getSubtasksByEpicId` to know which subtask `sessionId`s to sync, so the read step isn't fully eliminated at `moveCardToColumn`/`moveCardToColumnByPlanFile` — only the cascade's race is closed, not the sync's; (3) `cascadeEpicByPlanId` with no `targetStatus` must omit `status` from the SET clause entirely (not set it to NULL or empty), so non-completion moves don't accidentally clear subtask status; (4) redundant `updateStatus` calls at completion sites (lines 6825, 6855, 6899, 14072) become harmless no-ops for epics but must NOT be removed — non-epic plans still need them; (5) all line numbers in the original plan were stale and three function names were wrong (`testingFailureReport`→`testingFailed`, `_restoreFromArchive`→`_restoreRunSheet`, `markPlanComplete`→unnamed case handler) — corrected above. Mitigations: use `includeAllSubtasks=true` only at uncompleteCard and _restoreRunSheet; document the redundant-but-necessary `updateStatus` pattern; verify all line numbers against current source before editing.

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
- **Context:** Webview handlers + card-move orchestration. All line numbers below are VERIFIED against current source (previous plan had stale numbers).
- **Logic:** Replace each Class 2/3/7 cascade site. **Important note on redundant `updateStatus` calls:** at `completePlan`, `completeSelected`, `completeAll`, and the unnamed handler at line 14077, the epic's OWN `status` is set separately AFTER the cascade via `db.updateStatus(sessionId, 'completed')` (lines 6825, 6855, 6899, 14072 respectively). With the new `cascadeEpicByPlanId(planId, 'COMPLETED', 'completed')` setting the epic's status atomically, these `updateStatus` calls become redundant for epics (harmless double-write — same value). **Do NOT remove them** — they're called unconditionally for both epic and non-epic plans, and non-epic plans still need the status update. The cascade only replaces the `getSubtasksByEpicId` + `updateColumnWithEpicCascadeByPlanId` read-then-write block, not the `updateStatus` call.

1. **`moveCardToColumn` (cascade at lines 4894-4897):** Replace `getSubtasksByEpicId` + `updateColumnWithEpicCascadeByPlanId` with `cascadeEpicByPlanId(plan.planId, targetColumn)`. Keep the `getSubtasksByEpicId` call ONLY for the integration sync fan-out (`subtaskSessionIds`).

2. **`moveCardToColumnByPlanFile` (cascade at lines 4967-4970):** Same replacement with `cascadeEpicByPlanId(previousRecord.planId, targetColumn)`. Keep `getSubtasksByEpicId` for sync fan-out.

3. **`completePlan` (cascade at lines 6813-6815, status at line 6825):** Replace with `cascadeEpicByPlanId(plan.planId, 'COMPLETED', 'completed')`. Remove the separate `getSubtasksByEpicId` + explicit-ID construction. **Keep** the `updateStatus(resolvedSessionId, 'completed')` at line 6825 — it's a no-op for epics (status already set by cascade) but needed for non-epic plans in the same code path.

4. **`completeSelected` (cascade at lines 6843-6845, status at line 6855):** Same — `cascadeEpicByPlanId(plan.planId, 'COMPLETED', 'completed')` in the loop. Keep `updateStatus(sessionId, 'completed')` at line 6855.

5. **`completeAll` (cascade at lines 6887-6889, status at line 6899):** Same — `cascadeEpicByPlanId(card.planId, 'COMPLETED', 'completed')`. Keep `updateStatus(cardKey, 'completed')` at line 6899.

6. **`uncompleteCard` (cascade at lines 6929-6942, status at line 6940, rollback at lines 6958-6971):** Forward: `cascadeEpicByPlanId(epicPlanId, targetColumn, 'active', true)` — `includeAllSubtasks=true` because recovering an epic must pull ALL subtasks back, not just active ones (a completed subtask should be re-activated when the epic is recovered). Keep `updateStatus(sessionId, 'active')` at line 6940 (no-op for epics, needed for non-epics). Rollback: `cascadeEpicByPlanId(epicPlanId, 'COMPLETED', 'completed')` — **no `includeAllSubtasks` needed here** because the forward path already re-activated all subtasks (set them to `status='active'`), so the rollback's `WHERE status = 'active'` filter catches them. This is subtle but correct — the rollback only runs after a failed forward path, at which point all subtasks are already `status='active'`.

7. **`testingFailed` (cascade at lines 7302-7304, previously misnamed `testingFailureReport`):** Replace with `cascadeEpicByPlanId(plan.planId, 'LEAD CODED')` — no `targetStatus` (plan stays active, only column changes). No `updateStatus` call to worry about — `testingFailed` doesn't set DB status (line 7313 is a file write via `_schedulePlanStateWrite`, not a DB status update).

**Class 8 follow-up note:** `completeMultipleByPlanFile` (line 2878, cascade at lines 2900-2903) already uses the atomic `WHERE epic_id = ? AND status = 'active'` form with both column+status. This is nearly identical to `cascadeEpicByPlanId`. A follow-up refactoring should make Class 8 call `cascadeEpicByPlanId` to eliminate the duplicate implementation — but this is out of scope for this plan to keep changes contained.

### `src/services/TaskViewerProvider.ts`
- **Context:** Sidebar/agent dispatch fallbacks. All line numbers and function names VERIFIED against current source (previous plan had wrong function names).
- **Logic:**

8. **`_updateKanbanColumnForSession` fallback (cascade at lines 2261-2263):** Replace with `cascadeEpicByPlanId(plan.planId, column)`. Keep the empty-sessionId guard.

9. **`_restoreRunSheet` fallback (cascade at lines 11646-11648, previously misnamed `_restoreFromArchive`):** Replace with `cascadeEpicByPlanId(restorePlan.planId, 'CREATED', 'active', true)` — `includeAllSubtasks=true` because restoring from archive must catch all subtasks regardless of prior status. Note: `updateStatus(sessionId, 'active')` at line 11639 stays (no-op for epics, needed for non-epics — same pattern as KanbanProvider completion sites).

10. **Unnamed case handler (cascade at lines 14078-14081, previously misnamed `markPlanComplete`):** Replace with `cascadeEpicByPlanId(completePlan.planId, 'COMPLETED', 'completed')`. Note: `updateStatus(sessionId, 'completed')` at line 14072 stays (no-op for epics, needed for non-epics).

## Verification Plan

> Per project conventions: skip compilation and automated tests during implementation; the user runs the suite separately.

### Automated Tests

Skipped per session directive — the user runs the test suite separately. No compilation or automated test steps are included in this plan.

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

Complexity 5 (Medium: new DB method + 10 mechanical caller updates, with the `includeAllSubtasks` flag and the redundant-`updateStatus`-keeping pattern being the only non-obvious design decisions) → **Send to Coder**. The implementer must pay attention to: (1) which sites need `includeAllSubtasks=true` (`uncompleteCard`, `_restoreRunSheet`) vs. the default `false` (forward moves, completions, `testingFailed`); (2) the `targetStatus` parameter must be omitted (not set to empty string) for non-completion moves; (3) the separate `updateStatus` calls at completion sites (lines 6825, 6855, 6899, 14072, 11639) must be KEPT — they're no-ops for epics but required for non-epic plans; (4) all line numbers have been verified against current source — re-verify before editing as they may shift if other changes land first.

---

## Review Pass — Completed

### Stage 1: Grumpy Principal Engineer Review

*Theatrical grumpy voice engaged. Findings severity-tagged.*

**CRITICAL:** None. The implementation is correct. I hate saying that.

**MAJOR:** None. All 10 call sites match the plan spec exactly. The new `cascadeEpicByPlanId` method (`KanbanDatabase.ts:3877-3917`) is a faithful clone of the plan's proposed code — same `statusClause` conditional, same `subtaskStatusFilter` logic, same BEGIN/COMMIT/ROLLBACK transaction pattern, same column validation. The `includeAllSubtasks=true` flag is correctly applied at exactly the two sites the plan specifies (`uncompleteCard` line 6931, `_restoreRunSheet` line 11644) and omitted everywhere else. The `targetStatus` parameter is correctly omitted at `moveCardToColumn` (4896), `moveCardToColumnByPlanFile` (4968), `testingFailed` (7291), and `_updateKanbanColumnForSession` (2261) — status is NOT touched on non-completion moves. The redundant `updateStatus` calls are all kept as instructed (lines 6821, 6849, 6891, 6929, 6948, 11637, 14068). I verified `getPlanBySessionId` has a plan_id fallback (line 2566), so the redundant `updateStatus(cardKey, ...)` calls where `cardKey = planId` don't silently fail — they resolve via the fallback. The old `updateColumnWithEpicCascadeByPlanId` is retained with zero callers (dead code, as the plan's option (a) intended). Class 8 (`completeMultipleByPlanFile` line 2878) still uses its inline form — correctly out of scope per the plan's follow-up note. The regression test at `src/test/kanban-subtask-column-leak-regression.test.js:86` asserts `completeAll` uses `cascadeEpicByPlanId`. I have nothing to yell about. This is infuriating.

**NIT-1:** `updateColumnWithEpicCascadeByPlanId` (`KanbanDatabase.ts:3826`) is now dead code — zero callers in `src/`. The plan says to keep it for backward compat (option a), but it should be marked `@deprecated` to signal to future readers that `cascadeEpicByPlanId` is the replacement. Not a bug, just hygiene.

**NIT-2:** The `move-card.js` skill script (`kanban_operations/move-card.js:128`) still calls the non-existent `updateColumnWithEpicCascade` method — a TypeError crash in its direct-DB fallback. The plan explicitly defers this to "Plan 1" (Replace Raw Prompt SQL). Confirmed still broken; confirmed out of scope for this plan.

**NIT-3:** Class 8 (`completeMultipleByPlanFile` lines 2900-2903) duplicates the `WHERE epic_id = ? AND status = 'active'` pattern inline instead of calling `cascadeEpicByPlanId`. The plan notes this as a follow-up refactoring. Confirmed still inline; confirmed out of scope.

**NIT-4:** In `uncompleteCard`, if `msg.targetColumn === 'COMPLETED'` (edge case — semantically nonsensical but possible if a caller passes it), the cascade at line 6931 sets subtasks to `kanban_column='COMPLETED'` + `status='active'` (inconsistent state). The `_schedulePlanStateWrite` at line 6940-6941 correctly maps this to `status='completed'` for the file write, but the DB would have `status='active'`. This is a pre-existing edge case in the `uncompleteCard` handler (the target column comes from `msg.targetColumn || 'CODE REVIEWED'`), not introduced by this plan. The default `'CODE REVIEWED'` avoids it. Not worth fixing here.

### Stage 2: Balanced Synthesis

**Keep as-is:**
- All 10 call site replacements — verified correct against plan spec.
- The `cascadeEpicByPlanId` method implementation — matches plan exactly.
- The redundant `updateStatus` calls — correctly kept (no-ops for epics, required for non-epics).
- The `getSubtasksByEpicId` reads at `moveCardToColumn` (4894) and `moveCardToColumnByPlanFile` (4966) — correctly retained for integration sync fan-out.
- The `uncompleteCard` rollback logic — the `WHERE status = 'active'` filter without `includeAllSubtasks` is correct because the forward path already re-activated all subtasks.

**Fix now:** None. No CRITICAL or MAJOR findings.

**Defer (out of scope, tracked by other plans):**
- `move-card.js` direct-DB fallback crash → Plan 1 (Replace Raw Prompt SQL).
- Class 8 inline cascade duplication → follow-up refactoring noted in plan.
- `@deprecated` marker on `updateColumnWithEpicCascadeByPlanId` → cosmetic hygiene, can be done in a future cleanup pass.

### Code Fixes Applied

None. The implementation is correct and complete. No code changes were needed.

### Verification Results

- **Compilation:** Skipped per session directive.
- **Automated tests:** Skipped per session directive.
- **Static verification performed:**
  - Confirmed `cascadeEpicByPlanId` exists at `KanbanDatabase.ts:3877` with correct signature and logic.
  - Confirmed all 10 call sites use `cascadeEpicByPlanId` with correct arguments (grep: 16 matches across 3 source files + 1 test file).
  - Confirmed zero remaining callers of `updateColumnWithEpicCascadeByPlanId` in `src/` (only the definition + docstring reference remain).
  - Confirmed `getSubtasksByEpicId` retained only at sync-fan-out sites (lines 4894, 4966) and unrelated display/helper sites.
  - Confirmed `KanbanCard` interface has `planId: string` (line 91) — `card.planId` at `completeAll` line 6881 is valid.
  - Confirmed `getPlanBySessionId` has plan_id fallback (line 2566) — redundant `updateStatus` calls with planId-as-sessionId resolve correctly.
  - Confirmed Class 8 (`completeMultipleByPlanFile` line 2878) still uses inline form — out of scope, no regression.
  - Confirmed regression test asserts `completeAll` uses `cascadeEpicByPlanId` (`kanban-subtask-column-leak-regression.test.js:86`).

### Files Changed (by implementation, not by this review)

- `src/services/KanbanDatabase.ts` — added `cascadeEpicByPlanId` method (lines 3877-3917).
- `src/services/KanbanProvider.ts` — 8 call site replacements (lines 4896, 4968, 6811, 6839, 6881, 6931, 6950, 7291).
- `src/services/TaskViewerProvider.ts` — 3 call site replacements (lines 2261, 11644, 14075).
- `src/test/kanban-subtask-column-leak-regression.test.js` — test assertion updated to check `cascadeEpicByPlanId` (line 86).

### Remaining Risks

1. **`move-card.js` direct-DB fallback** (`kanban_operations/move-card.js:128`) still calls non-existent `updateColumnWithEpicCascade` — TypeError crash. Fix is tracked by Plan 1 (Replace Raw Prompt SQL), which should use `cascadeEpicByPlanId` from this plan.
2. **Class 8 inline duplication** — `completeMultipleByPlanFile` (lines 2900-2903) duplicates the cascade logic inline instead of calling `cascadeEpicByPlanId`. Behavioral equivalence verified, but future drift risk if one is updated without the other. Follow-up refactoring noted in plan.
3. **`uncompleteCard` with `targetColumn='COMPLETED'`** — edge case producing inconsistent `column=COMPLETED` + `status='active'` in DB. Pre-existing, not introduced by this plan, default target is `'CODE REVIEWED'`.
4. **Dead code** — `updateColumnWithEpicCascadeByPlanId` has zero callers. Intentionally retained per plan option (a) for backward compat. Should be marked `@deprecated` in a future pass.
