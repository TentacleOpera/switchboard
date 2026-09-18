# Bugfix: Kanban "Assign to Workspace" Button - Wrong Database Query

## Goal

Fix the "ASSIGN TO WORKSPACE" button in `kanban.html` so that selected plans are correctly transferred from the source workspace's kanban database to the target workspace's kanban database. Currently the handler queries the wrong (target) database for the plan record, finds nothing, and silently does nothing.

## Metadata

- **Tags:** bugfix, database, UI
- **Complexity:** 4

## User Review Required

> [!IMPORTANT]
> **Open Question: Should plans be removed from the source workspace after reassignment?**
> Currently, leaving the plan in the source DB means it will still appear on the source board. The source file watcher may also re-insert the record if the plan file still exists on disk. Two options:
>
> **Option A (Recommended):** Soft-delete the plan in the source DB (`status = 'deleted'`) after a successful upsert to the target. The file watcher will eventually reconcile if the file moves, but the kanban board will not show it as active.
>
> **Option B:** Leave the plan in both DBs (current plan's `// Optionally: remove` comment). This creates phantom duplication and is not recommended.
>
> The implementation below uses Option A.

## Complexity Audit

### Routine
- Reading a plan record from the source DB via existing `getPlanBySessionId()` method
- Upserting that record to the target DB via existing `upsertPlan()` method — **no new DB method needed**
- Soft-deleting from source DB via existing `updateStatusByPlanFile()` method
- User-facing success/warning messages via existing VS Code notification API
- Board refresh via existing `_refreshBoard()` call

### Complex / Risky
- Dual-DB writes must be coordinated: if the upsert to the target DB succeeds but the source soft-delete fails, the plan exists in both workspaces. This is recoverable but unclean. Mitigate with a try/catch that logs but does not block success count.
- `_currentWorkspaceRoot` can be null if no workspace is active — must guard explicitly.

## Edge-Case & Dependency Audit

**Race Conditions**
- The GlobalPlanWatcher monitors plan files on disk. If the plan file still exists at its original path, the watcher may re-insert the plan into the source DB shortly after the soft-delete. This is expected and tolerable (the re-insert sets `status = 'active'` which overwrites the soft-delete). Long-term, the user should move the plan file if they intend full transfer.

**Security**
- No new attack surface. Source and target DB paths are already resolved via `_getKanbanDb()` which uses the existing path resolution logic.

**Side Effects**
- The board refresh after reassignment triggers `_refreshBoard(this._currentWorkspaceRoot)` which re-renders the source workspace's board, causing the reassigned card to disappear immediately (expected UX).

**Dependencies & Conflicts**
- `upsertPlan(record: KanbanPlanRecord)` at `KanbanDatabase.ts:1045` — already exists, **no new code needed in KanbanDatabase.ts**.
- `updateStatusByPlanFile(planFile, workspaceId, status)` at `KanbanDatabase.ts:1309` — used for soft-delete.
- `deletePlanByPlanFile(planFile, workspaceId)` at `KanbanDatabase.ts:1515` — available as an alternative hard-delete if preferred.

## Dependencies

- None (self-contained bugfix)

## Adversarial Synthesis

Key risks: (1) `upsertPlan` already exists with the full `KanbanPlanRecord` signature — the plan must not introduce a duplicate method with an incompatible schema; (2) leaving plans in both DBs creates phantom duplication if the file watcher re-inserts; (3) `_currentWorkspaceRoot` being null must be guarded before calling `_getKanbanDb`. Mitigations: use the existing `upsertPlan` method directly, soft-delete from source DB after successful target upsert, and add an explicit null-check on `_currentWorkspaceRoot` before proceeding.

## Proposed Changes

### `src/services/KanbanProvider.ts`

#### Context
`_handleMessage` switch case at lines 3965–4011. The current handler instantiates only the **target** DB, looks up the plan in the target DB (where it doesn't exist), finds null, and silently fails.

#### Logic
Replace the `reassignPlansWorkspace` case with corrected two-DB logic:
1. Resolve `sourceWorkspaceRoot = this._currentWorkspaceRoot` (guard for null).
2. Open `sourceDb` (current workspace) and `targetDb` (msg.targetWorkspaceRoot).
3. Resolve both workspace IDs.
4. For each sessionId: fetch plan from **source** DB → upsert full `KanbanPlanRecord` (with `workspaceId` overridden to `targetWorkspaceId`) into **target** DB → soft-delete from source DB.
5. Refresh board. Show success/warning message.

#### Implementation

Replace lines 3965–4011 in [KanbanProvider.ts](file:///Users/patrickvuleta/Documents/GitHub/switchboard/src/services/KanbanProvider.ts#L3965-L4011):

```typescript
case 'reassignPlansWorkspace': {
    const sessionIds: string[] = msg.sessionIds;
    const targetWorkspaceRoot: string = msg.targetWorkspaceRoot;

    if (!targetWorkspaceRoot || !Array.isArray(sessionIds) || sessionIds.length === 0) {
        break;
    }

    // Guard: source workspace must be known
    const sourceWorkspaceRoot = this._currentWorkspaceRoot;
    if (!sourceWorkspaceRoot) {
        vscode.window.showWarningMessage('Cannot determine source workspace for reassignment.');
        break;
    }

    // Prevent no-op reassignment to same workspace
    if (path.resolve(sourceWorkspaceRoot) === path.resolve(targetWorkspaceRoot)) {
        vscode.window.showWarningMessage('Source and target workspaces are the same — no plans were moved.');
        break;
    }

    const sourceDb = this._getKanbanDb(sourceWorkspaceRoot);
    const targetDb = this._getKanbanDb(targetWorkspaceRoot);

    if (!(await sourceDb.ensureReady()) || !(await targetDb.ensureReady())) {
        vscode.window.showWarningMessage('Failed to access one or both workspace databases.');
        break;
    }

    const sourceWorkspaceId = await this._readWorkspaceId(sourceWorkspaceRoot)
        || await sourceDb.getWorkspaceId()
        || await sourceDb.getDominantWorkspaceId();

    const targetWorkspaceId = await this._readWorkspaceId(targetWorkspaceRoot)
        || await targetDb.getWorkspaceId()
        || await targetDb.getDominantWorkspaceId();

    if (!sourceWorkspaceId || !targetWorkspaceId) {
        vscode.window.showWarningMessage('Cannot determine workspace IDs for reassignment.');
        break;
    }

    let successCount = 0;
    const totalCount = sessionIds.length;

    for (const sessionId of sessionIds) {
        // Query from SOURCE database (where the plan actually lives)
        const plan = await sourceDb.getPlanBySessionId(sessionId);
        if (!plan) {
            console.warn(`[KanbanProvider] reassignPlansWorkspace: plan ${sessionId} not found in source workspace`);
            continue;
        }

        try {
            // Upsert full record into target DB, overriding only the workspaceId and timestamp
            const ok = await targetDb.upsertPlan({
                ...plan,
                workspaceId: targetWorkspaceId,
                updatedAt: new Date().toISOString()
            });

            if (ok) {
                successCount++;
                // Soft-delete from source DB so the plan no longer appears on the source board.
                // If this fails, the plan will still be visible on the source board (acceptable fallback).
                await sourceDb.updateStatusByPlanFile(plan.planFile, sourceWorkspaceId, 'deleted');
            }
        } catch (err) {
            console.error(`[KanbanProvider] reassignPlansWorkspace: failed for session ${sessionId}:`, err);
        }
    }

    await this._refreshBoard(sourceWorkspaceRoot);

    if (successCount === 0) {
        vscode.window.showWarningMessage(
            `No plans were reassigned (0 of ${totalCount}). The plans may not exist in the source workspace.`
        );
    } else if (successCount < totalCount) {
        vscode.window.showWarningMessage(
            `Reassigned ${successCount} of ${totalCount} plans. ${totalCount - successCount} plan(s) failed — check the developer console for details.`
        );
    } else {
        vscode.window.showInformationMessage(
            `Successfully reassigned ${successCount} plan${successCount === 1 ? '' : 's'} to the target workspace.`
        );
    }
    break;
}
```

#### Edge Cases
- `_currentWorkspaceRoot` is null → guarded with early `break` + warning.
- Source and target workspace are the same → guarded with explicit path comparison.
- `getPlanBySessionId` returns null (plan not in source DB) → logged and skipped; counted in failure total.
- `upsertPlan` throws (e.g., schema mismatch) → caught, logged, counted as failure.
- `updateStatusByPlanFile` (soft-delete) fails → error is swallowed; plan remains visible on source board (acceptable fallback; user can manually refresh).

### `src/services/KanbanDatabase.ts`

**No changes required.** `upsertPlan(record: KanbanPlanRecord)` already exists at line 1045 as a convenience wrapper around `upsertPlans()`. The plan's proposed new method with a reduced signature would have created a TypeScript conflict. Use the existing method directly.

## Verification Plan

### Automated Tests
- No existing unit tests for `reassignPlansWorkspace`. Manual verification required.

### Manual Test Checklist

- [ ] Select a plan in the kanban board
- [ ] Change to a different workspace using the workspace selector
- [ ] Click "ASSIGN TO WORKSPACE" button
- [ ] Verify the plan **disappears** from the source board
- [ ] Switch to the target workspace
- [ ] Verify the plan **appears** in the target workspace's kanban board
- [ ] Verify the plan file still exists at its original path on disk (only DB record moves)
- [ ] Test with multiple plans selected at once
- [ ] Test selecting the **same** workspace as source/target — should show warning, no change
- [ ] Test clicking the button with no plans selected — button should be disabled (existing guard in HTML)
- [ ] Verify error handling: if a plan's sessionId does not exist in source DB, it is skipped and counted in warning message

---

**Recommendation: Send to Coder**

---

## Reviewer Pass — 2026-05-22

### Files Changed
- `src/services/KanbanProvider.ts` — `reassignPlansWorkspace` case (lines 3973–4071)

### Stage 1 — Grumpy Findings

| ID | Severity | Finding |
|---|---|---|
| G-01 | **MAJOR** | `getPlanBySessionId` has no `workspace_id` filter. In a mixed/migrated DB, it could return a ghost record belonging to a different workspace. That ghost would be upserted to the target with an incorrect `workspaceId` override, silently duplicating wrong data. |
| G-02 | **MAJOR** | `planFile` in the target DB record remains relative to the source workspace root. "Open Plan" on the moved card in the target workspace will silently fail until the user also moves the plan file on disk. The plan acknowledges DB-only transfer but understates this UX impact. |
| G-03 | NIT | `ensureReady()` is called once as a guard, then again implicitly inside every subsequent DB method — redundant (harmless, early-returns). |
| G-04 | NIT | `successCount` is incremented even when the post-upsert soft-delete fails; success message is optimistic in that case. Plan explicitly accepts this. |
| G-05 | NIT | `getPlanBySessionId` is `@deprecated`; preferred path is `getPlanByPlanFile`. Not actionable without webview contract change. |

### Stage 2 — Balanced Synthesis

| Finding | Decision |
|---|---|
| G-01 | **Fixed** — added workspace ID validation after `getPlanBySessionId` |
| G-02 | **Documented** — added inline comment warning about "Open Plan" limitation in target workspace |
| G-03 | Deferred — cosmetic |
| G-04 | Deferred — plan accepts this trade-off |
| G-05 | Deferred — needs webview contract change |

### Code Fix Applied

Added workspace ID guard immediately after `getPlanBySessionId` returns, before the upsert:

```typescript
if (plan.workspaceId !== sourceWorkspaceId) {
    console.warn(`[KanbanProvider] reassignPlansWorkspace: plan ${sessionId} belongs to workspace ${plan.workspaceId}, not source ${sourceWorkspaceId} — skipping`);
    continue;
}
```

Also added an inline comment on the upsert block documenting that `planFile` is relative to the source root and "Open Plan" won't resolve in the target until the file is physically moved.

### Validation Results

- `npx tsc --noEmit` — **2 pre-existing errors** (unrelated import extension issues in `ClickUpSyncService.ts:2309` and `KanbanProvider.ts:4543`). **Zero new errors** introduced by this change.
- No unit tests exist for `reassignPlansWorkspace`; manual verification per plan checklist required.

### Remaining Risks

1. **"Open Plan" broken in target** — The plan file is not moved on disk. Cards in the target workspace will display correctly on the board but the "Open Plan" action will fail silently until the file is moved. Low user impact for typical cross-workspace reassignment (user should move the file).
2. **File-watcher re-insertion** — If the plan file still exists at its original path, `GlobalPlanWatcherService` may re-insert the plan into the source DB (restoring `status = 'active'`) shortly after the soft-delete. Acknowledged in plan; expected and tolerable.
3. **Dual-DB inconsistency on soft-delete failure** — If `updateStatusByPlanFile` throws after a successful upsert, the plan appears on both boards. Logged, but the user-facing success count does not distinguish this case.
