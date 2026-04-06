# Bug Report: Plan Recovery Fails for Completed Plans

## Goal
Fix the plan recovery flow so that plans moved to the "completed" Kanban column can be recovered by the user. The root cause is that the mark-complete flow sets the Plan Registry status to `'archived'` (not `'completed'`), but the error message reports `'active'` — indicating the mark-complete flow did not update the registry at all for the affected plan. The fix must ensure (1) the Plan Registry status is reliably set when a plan completes, and (2) recovery logic handles all legitimate recoverable statuses.

## Metadata
**Tags:** backend, bugfix
**Complexity:** 5

## User Review Required
> [!NOTE]
> This fix modifies plan recovery logic in `TaskViewerProvider.ts`. Plans that were previously stuck in an unrecoverable state (registry says `'active'` but kanban says `'completed'`) will become recoverable after this fix. No data migration is needed — the fix widens the filter to include these orphaned-active plans.

## Complexity Audit
### Routine
- Add `'completed'` to the `_getRecoverablePlans` status filter (line 4869) so plans with registry status `'completed'` are included in the recovery list.
- Add `'completed'` to the `_handleRestorePlan` guard (line 4974) so plans with registry status `'completed'` can be restored.

### Complex / Risky
- **Root cause diagnosis:** The mark-complete flow at lines 6967-6978 calls `_updatePlanRegistryStatus(resolvedWorkspaceRoot, pathHash, 'archived')` for brain plans and `_updatePlanRegistryStatus(resolvedWorkspaceRoot, sessionId, 'archived')` for local plans — setting the registry to `'archived'`, not `'completed'`. The kanban DB then gets `db.updateStatus(sessionId, 'completed')` and `db.updateColumn(sessionId, 'COMPLETED')`. The error message showing `"active"` instead of `"archived"` means `_updatePlanRegistryStatus` silently failed (likely because `planId` lookup didn't match the registry key). This is the deeper sync gap that makes completed plans invisible to recovery.
- **Fallback recovery for orphaned-active plans:** Plans stuck with registry status `'active'` but kanban column `'COMPLETED'` need a cross-system check: when `_getRecoverablePlans` encounters an `'active'` plan, it should query the kanban DB to check if that plan is actually completed, and if so, include it in the recovery list. This is the only way to recover plans already in this broken state without a data migration.

## Edge-Case & Dependency Audit
- **Race Conditions:** `_handleRestorePlan` reads and writes `_planRegistry.entries[planId]` synchronously within a single async function call. No concurrent access risk because VS Code extension host is single-threaded.
- **Security:** No security implications — this is internal plan state management.
- **Side Effects:** Widening the recovery filter means more plans appear in the recovery UI. Plans that were silently lost will now be visible. This is the desired behavior.
- **Dependencies & Conflicts:**
  - **`embed_kanban_state_in_plan_files.md`** (Complexity 8) — This plan adds kanban state persistence to plan `.md` files and modifies `KanbanProvider.ts` column-update call sites. It does NOT modify `_getRecoverablePlans` or `_handleRestorePlan`, so there is **no direct conflict**. However, once that plan lands, the recovery flow could also read embedded state from plan files as an additional recovery signal. Note for future enhancement only; not required for this fix.
  - No other active plans modify the plan recovery flow.

## Root Cause (Detailed Analysis)

### Two Parallel Status Systems

| System | File | Valid Statuses |
|--------|------|----------------|
| **Plan Registry** | `plan_registry.json` | `'active'`, `'archived'`, `'deleted'`, `'orphan'` |
| **Kanban DB** | `kanban.sqlite` | `'active'`, `'archived'`, `'completed'`, `'deleted'` |

### Mark-Complete Flow (lines 6955-6987 in `TaskViewerProvider.ts`)

When a user marks a plan complete, the following happens:

```
1. _updatePlanRegistryStatus(workspaceRoot, pathHash, 'archived')  ← sets registry to 'archived'
2. db.updateStatus(sessionId, 'completed')                         ← sets kanban DB to 'completed'
3. db.updateColumn(sessionId, 'COMPLETED')                         ← sets kanban column
4. _archiveCompletedSession(...)                                   ← moves files
```

**The key finding:** `_updatePlanRegistryStatus` (line 4813) looks up the entry by `planId`:
```typescript
private async _updatePlanRegistryStatus(workspaceRoot: string, planId: string, status: PlanRegistryEntry['status']): Promise<void> {
    const entry = this._planRegistry.entries[planId];
    if (!entry) return;  // ← SILENT NO-OP if planId doesn't match a registry key
```

For brain plans, the `planId` passed is `pathHash` (SHA-256 of the stable brain path). For local plans, it's `sessionId`. If either doesn't match the key used when the plan was registered, the update silently does nothing, leaving the registry status as `'active'`.

**This explains the error message:** The user sees `Plan cannot be restored from status "active"` because the registry was never updated from `'active'` — the `_updatePlanRegistryStatus` call was a silent no-op.

### Recovery Flow (lines 4847-4977)

1. `_getRecoverablePlans()` (line 4869) filters: `entry.status === 'archived' || entry.status === 'orphan'` — excludes `'active'` and `'completed'`.
2. `_handleRestorePlan()` (line 4974) guards: `entry.status !== 'archived' && entry.status !== 'orphan'` — rejects everything else.

A plan stuck as `'active'` in the registry (but `'completed'` in kanban) is invisible to both functions.

## Adversarial Synthesis

### Grumpy Critique
> *Oh, this is a real masterpiece of distributed state.* Two status systems that don't agree, a silent no-op when they fail to sync, and a recovery flow that trusts only the system that wasn't updated. Chef's kiss.
>
> The original proposed fix — "just add `'completed'` to the filter" — is adorable in its naïveté. The Plan Registry **never gets status `'completed'`**. Its valid statuses are `'active'`, `'archived'`, `'deleted'`, and `'orphan'`. Adding `'completed'` to the filter matches exactly zero existing plans. You'd ship a "fix" that fixes nothing, high-five each other, and the bug report comes right back.
>
> The REAL problem is that `_updatePlanRegistryStatus` silently returns when the `planId` doesn't match. Why doesn't it log a warning? Why doesn't the mark-complete flow verify the registry was actually updated? It's a fire-and-forget write to a critical status field with NO error handling.
>
> And even if you fix the sync going forward, what about the plans already stuck in this state? Users have plans that are `'active'` in registry but `'completed'` in kanban RIGHT NOW. Your fix needs a cross-system reconciliation path, not just a filter tweak.
>
> Finally — the `_getRecoverablePlans` function is 115 lines long and does topic inference, date lookups, archive scanning, and DB queries all in one method. Adding MORE conditional logic to it is like adding more rooms to a Winchester Mystery House. But that's a refactor for another day. For now, just make it work.

### Balanced Response
Grumpy is correct on the critical points:

1. **Adding `'completed'` to the filter alone is insufficient** — the registry never reaches `'completed'` status. The fix must handle plans stuck as `'active'` in the registry but `'completed'` in the kanban DB.
2. **Silent no-op in `_updatePlanRegistryStatus`** is the root cause of the sync gap. Adding a warning log is cheap insurance. However, fully fixing the `planId` mismatch is a deeper investigation (which `planId` format was used at registration time vs completion time) and risks scope creep. A warning log is the right level for this bugfix.
3. **Cross-system fallback in `_getRecoverablePlans`** is necessary to recover already-broken plans. The implementation below adds a kanban DB check for `'active'` registry plans that are actually `'completed'` in the DB. This is bounded: it only queries the DB for `'active'` plans (which are a small set) and reuses the existing `db` handle already obtained at line 4865.

The plan below implements three changes: (A) add warning log to `_updatePlanRegistryStatus`, (B) add cross-system check in `_getRecoverablePlans`, (C) widen `_handleRestorePlan` guard.

## Proposed Changes

### Change Site 1: Add Warning Log to `_updatePlanRegistryStatus`
#### [MODIFY] `src/services/TaskViewerProvider.ts`
- **Context:** `_updatePlanRegistryStatus` (line 4813) silently returns when the `planId` is not found in the registry. This masks sync failures in the mark-complete flow.
- **Logic:**
  1. Add a `console.warn` when the entry is not found, including the `planId` and `status` that was attempted.
  2. This is diagnostic only — it does not change behavior, but ensures future sync failures are visible in the developer console.
- **Implementation:**

Change lines 4813-4816 from:
```typescript
private async _updatePlanRegistryStatus(workspaceRoot: string, planId: string, status: PlanRegistryEntry['status']): Promise<void> {
    const entry = this._planRegistry.entries[planId];
    if (!entry) return;
```
To:
```typescript
private async _updatePlanRegistryStatus(workspaceRoot: string, planId: string, status: PlanRegistryEntry['status']): Promise<void> {
    const entry = this._planRegistry.entries[planId];
    if (!entry) {
        console.warn(`[TaskViewerProvider] _updatePlanRegistryStatus: no registry entry found for planId="${planId}" (attempted status="${status}"). Registry keys may use a different ID format.`);
        return;
    }
```

- **Edge Cases Handled:** No behavior change; purely diagnostic. Helps identify future sync mismatches immediately.

### Change Site 2: Cross-System Recovery Check in `_getRecoverablePlans`
#### [MODIFY] `src/services/TaskViewerProvider.ts`
- **Context:** `_getRecoverablePlans` (line 4869) only includes plans with registry status `'archived'` or `'orphan'`. Plans stuck as `'active'` in the registry but `'completed'` in the kanban DB are invisible. This change adds a cross-system check: for `'active'` registry plans, query the kanban DB to see if they are actually completed.
- **Logic:**
  1. After the existing `if (entry.status === 'archived' || entry.status === 'orphan')` block (which ends at line 4958), add a new block for `entry.status === 'active'`.
  2. In this new block, query the kanban DB using the plan's session ID(s) to check if the kanban status is `'completed'`.
  3. If the kanban DB confirms the plan is completed, include it in the recoverable list with status overridden to `'completed'` for display purposes.
  4. This reuses the existing `db` handle from line 4865.
- **Implementation:**

After the closing `}` of the existing `if (entry.status === 'archived' || entry.status === 'orphan')` block (line 4958, just before the `}` that closes the `for` loop at line 4959), insert:

```typescript
            // Cross-system recovery: detect plans stuck as 'active' in registry
            // but actually 'completed' in kanban DB (sync gap from planId mismatch)
            if (entry.status === 'active' && db) {
                const sessionIds = entry.sourceType === 'brain'
                    ? [`antigravity_${entry.planId}`]
                    : [entry.planId, `antigravity_${entry.planId}`];
                let isCompletedInDb = false;
                for (const sid of sessionIds) {
                    const plan = await db.getPlanBySessionId(sid);
                    if (plan && plan.status === 'completed') {
                        isCompletedInDb = true;
                        break;
                    }
                }
                if (isCompletedInDb) {
                    let topic = entry.topic;
                    if (this._isGenericTopic(topic)) {
                        topic = this._inferTopicFromPath(entry.brainSourcePath || entry.localPlanPath);
                    }
                    recoverable.push({
                        planId: entry.planId,
                        topic,
                        sourceType: entry.sourceType,
                        status: 'completed',
                        brainSourcePath: entry.brainSourcePath,
                        localPlanPath: entry.localPlanPath,
                        updatedAt: entry.updatedAt
                    });
                }
            }
```

- **Edge Cases Handled:**
  - Only queries the DB for `'active'` plans, keeping the performance impact bounded.
  - Uses the same `sessionId` resolution logic as the existing topic/date lookup code (lines 4937-4939).
  - Falls back to `_inferTopicFromPath` for topic resolution (simpler than the full topic inference in the archived block, but sufficient for recovery display).

### Change Site 3: Widen `_handleRestorePlan` Guard
#### [MODIFY] `src/services/TaskViewerProvider.ts`
- **Context:** `_handleRestorePlan` (line 4974) only allows restoration from `'archived'` or `'orphan'`. Plans surfaced by the cross-system check in Change Site 2 will have registry status `'active'` (the DB override to `'completed'` is only for display). The guard must also allow `'active'` plans to be restored when they are completed in the kanban DB.
- **Logic:**
  1. Add `'completed'` to the allowed statuses (for future-proofing if the registry ever does get `'completed'`).
  2. Add `'active'` to the allowed statuses — but ONLY after verifying the plan is `'completed'` in the kanban DB, to avoid accidentally allowing restoration of genuinely active plans.
- **Implementation:**

Change lines 4974-4977 from:
```typescript
if (entry.status !== 'archived' && entry.status !== 'orphan') {
    vscode.window.showErrorMessage(`Plan cannot be restored from status "${entry.status}".`);
    return false;
}
```
To:
```typescript
const allowedRestoreStatuses = ['archived', 'orphan', 'completed'];
if (!allowedRestoreStatuses.includes(entry.status)) {
    // For 'active' plans, check if kanban DB shows 'completed' (sync gap recovery)
    if (entry.status === 'active') {
        const db = await this._getKanbanDb(workspaceRoot);
        const sessionIds = entry.sourceType === 'brain'
            ? [`antigravity_${entry.planId}`]
            : [planId, `antigravity_${entry.planId}`];
        let isCompletedInDb = false;
        if (db) {
            for (const sid of sessionIds) {
                const plan = await db.getPlanBySessionId(sid);
                if (plan && plan.status === 'completed') {
                    isCompletedInDb = true;
                    break;
                }
            }
        }
        if (!isCompletedInDb) {
            vscode.window.showErrorMessage(`Plan cannot be restored from status "${entry.status}".`);
            return false;
        }
    } else {
        vscode.window.showErrorMessage(`Plan cannot be restored from status "${entry.status}".`);
        return false;
    }
}
```

- **Edge Cases Handled:**
  - Genuinely active plans (not completed in kanban) are still rejected — the DB check prevents accidental restoration.
  - Plans with registry status `'completed'` (if the sync is fixed in the future) are directly allowed.
  - Plans with registry status `'deleted'` are still rejected.

## Verification Plan
### Automated Tests
- **Existing test file:** Check for existing tests covering `_handleRestorePlan` and `_getRecoverablePlans` in `src/test/`. If tests exist, add cases for:
  1. Plan with registry status `'active'` + kanban status `'completed'` → should appear in recoverable list and be restorable.
  2. Plan with registry status `'active'` + kanban status `'active'` → should NOT appear in recoverable list.
  3. Plan with registry status `'completed'` → should appear in recoverable list and be restorable.

### Manual Verification Steps
1. Mark a plan as complete via the Kanban board UI.
2. Open the plan recovery dialog.
3. Verify the completed plan appears in the recoverable list.
4. Restore the plan — verify it returns to active state without errors.
5. Verify the developer console shows no `_updatePlanRegistryStatus` warnings for the normal flow (if warnings appear, the sync gap is still present and the `planId` format mismatch should be investigated separately).

### Recommendation
**Send to Coder** (Complexity 5 — multi-site changes within a single file, moderate conditional logic, but well-bounded scope with clear patterns to follow).

---

## Reviewer Pass

### Status: ✅ COMPLETE (no code fixes needed)

### Stage 1 — Grumpy Principal Engineer

> Well, well. Someone actually *read* my critique. The implementation nails all three change sites — the warning log, the cross-system fallback, and the widened restore guard. I'm almost disappointed I can't find a showstopper. Almost.
>
> Let me nitpick, because that's what I do:
>
> **NIT #1 — Inconsistent identifier usage in `_handleRestorePlan`.** Line 5015 builds the session ID array for local plans as `[planId, ...]` where `planId` is the *function parameter*. Meanwhile, `_getRecoverablePlans` (line 4968) consistently uses `entry.planId`. They're the same value (since `entry = this._planRegistry.entries[planId]`), but one uses the parameter, the other uses the entry field. Pick a convention and stick with it. It's not a bug, it's a *code smell* — the kind that becomes a bug six months from now when someone refactors the function signature.
>
> **NIT #2 — Topic inference shortcut in cross-system recovery.** The archived-plan block (lines 4883-4935) does a heroic multi-source topic inference: file system scan, H1 extraction, DB lookup, path inference fallback. The cross-system recovery block (lines 4978-4981) skips straight to `_inferTopicFromPath`. The plan explicitly calls this out as "sufficient for recovery display" — fine, I'll grudgingly accept it. But the user will see "Reverse Kanban Card Sort Order" for one recovered plan and "brain_a4f2e8..." for another, and they'll file a bug. Mark my words.
>
> **NIT #3 — Missing `updatedAt` DB enhancement.** The archived block (lines 4937-4950) queries the DB for a better date when the registry date is corrupted from migration. The cross-system block uses `entry.updatedAt` raw. For plans stuck in the sync gap, the registry date is likely the *creation* date (since `_updatePlanRegistryStatus` never ran), not the completion date. It's cosmetic, but the sort order in the recovery UI will be wrong for these plans.
>
> **MAJOR #0 — Actually, wait. Let me re-read the `PlanRegistryEntry` type...** `status: 'active' | 'archived' | 'deleted' | 'orphan'`. No `'completed'`. The `allowedRestoreStatuses` array includes `'completed'` (line 5008) which is *dead code* — `entry.status` can never be `'completed'` per the type. It's harmless but it's lying to the reader. The comment says "future-proofing" — that's not future-proofing, that's *present-confusing*. But it won't cause a runtime error, so I'll downgrade this to a NIT.
>
> All three change sites are correctly implemented. The cross-system DB check in both `_getRecoverablePlans` and `_handleRestorePlan` is properly bounded. The warning log is diagnostic-only. No behavior regressions. *Fine.* Ship it.

### Stage 2 — Balanced Synthesis

| # | Finding | Severity | Action |
|---|---------|----------|--------|
| 1 | Change Site 1 (warning log in `_updatePlanRegistryStatus`): correctly added ✅ | — | Keep |
| 2 | Change Site 2 (cross-system recovery in `_getRecoverablePlans`): correctly added ✅ | — | Keep |
| 3 | Change Site 3 (widened `_handleRestorePlan` guard with DB cross-check): correctly added ✅ | — | Keep |
| 4 | `planId` vs `entry.planId` inconsistency in `_handleRestorePlan` line 5015 | **NIT** | Defer — identical values, cosmetic only |
| 5 | Simpler topic inference in cross-system recovery block | **NIT** | Defer — plan explicitly accepts this tradeoff |
| 6 | Missing `updatedAt` DB date enhancement in cross-system block | **NIT** | Defer — cosmetic sort-order impact only |
| 7 | `'completed'` in `allowedRestoreStatuses` is dead code per `PlanRegistryEntry` type | **NIT** | Defer — harmless future-proofing, no runtime impact |

**Verdict:** All three change sites correctly implemented. No CRITICAL or MAJOR issues. Four NITs identified, all safe to defer.

### Code Fixes Applied

None required. All implementations match the plan specification.

### Files Changed
- `src/services/TaskViewerProvider.ts` — 3 change sites implemented (warning log, cross-system recovery, widened restore guard). No reviewer fixes needed.

### Verification Results
- **TypeScript check:** No new errors introduced. Pre-existing error in `KanbanProvider.ts` (import extension) is unrelated.
- **Automated tests:** No existing tests cover `_handleRestorePlan` or `_getRecoverablePlans`. Plan's Verification Plan recommends adding test cases for: (1) registry `'active'` + kanban `'completed'` → recoverable, (2) registry `'active'` + kanban `'active'` → NOT recoverable, (3) registry `'completed'` → recoverable.
- **Manual verification required:** See steps 1-5 in Verification Plan above.

### Remaining Risks
- **Low.** The cross-system DB check is bounded (only queries for `'active'` plans) and reuses existing DB handles. The warning log is diagnostic-only.
- **Future consideration:** The 4 NITs above (topic inference, date enhancement, identifier consistency, dead code) could be addressed in a follow-up cleanup pass if the recovery UI shows confusing data for recovered plans.
