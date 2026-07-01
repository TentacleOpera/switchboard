# Epic Creation Delayed Board Refresh — Race in `recordBoardPush` dataVersion

**Plan ID:** a3b7c8d4-5e6f-4a2b-9c8d-1e2f3a4b5c6d

## Goal

Fix the multi-minute delay between creating an epic (via "Group Into Epic" or "Promote to Epic") and the epic card appearing on the kanban board. The epic IS created correctly in the DB and on disk, but the board doesn't reflect it until an unrelated user interaction or file-watcher event triggers a refresh.

### Problem Analysis

**Core Problem:** After `createEpicFromPlanIds` or `promoteToEpic` writes the epic to the DB and calls `_refreshBoard`, the board often doesn't update. The user waits "a few minutes" with no visual feedback, leading them to believe the button is broken (this was previously reported as "epic buttons do not create epics").

**Root Cause:** A race condition in the O(1) no-op early-out mechanism (`refreshWouldBeNoOp` / `recordBoardPush`). The push key is recorded with `db.getDataVersion()` at **recording time** (after the board push), not at **DB read time** (when the snapshot was taken). When a concurrent DB write happens between the DB read and the `recordBoardPush` call, the recorded push key contains a dataVersion that doesn't correspond to the data actually pushed. The next refresh sees the same dataVersion and skips as a "no-op," leaving stale data on the board.

**Detailed Race Scenario:**

1. Board is idle. `_lastPushKey` = `"ws|proj|repo|42|7"` (dataVersion=42).
2. A file-watcher event triggers `_scheduleBoardRefresh` (100ms debounce) → `_refreshBoard` → `refreshUI` → `_refreshRunSheets` → `_refreshRunSheetsImpl` starts (in-flight refresh).
3. User clicks "Group Into Epic" while the in-flight refresh is running.
4. `createEpicFromPlanIds` executes:
   - `db.upsertPlan(...)` → `_persist()` → `_dataVersion` becomes 43
   - `db.updateEpicStatus(...)` for each subtask → `_dataVersion` becomes 44, 45, ...
   - `db.recomputeEpicComplexity(...)` → `_dataVersion` becomes N
   - `db.updateEpicStatus(epicPlanId, 1, '')` → `_dataVersion` becomes N+1
5. `createEpicFromPlanIds` calls `_refreshBoard` → `refreshUI` → `_refreshRunSheets` → coalesced as trailing refresh (in-flight refresh still running).
6. The in-flight refresh (step 2) reads the DB. Two sub-cases:
   - **6a.** If the DB read happened BEFORE step 4's writes: reads stale data (no epic). Builds cards without epic. Pushes `updateBoard` (stale). Then calls `recordBoardPush(workspaceId, db.getDataVersion())` — but `_dataVersion` is now N+1 (bumped by step 4). Records `_lastPushKey` = `"ws|proj|repo|N+1|7"`.
   - **6b.** If the DB read happened AFTER step 4's writes: reads fresh data (with epic). Pushes `updateBoard` (correct). Records `_lastPushKey` = `"ws|proj|repo|N+1|7"`. This case is fine.
7. The trailing refresh (step 5) runs. Checks `refreshWouldBeNoOp(workspaceId, N+1)` → `_lastPushKey` is `"ws|proj|repo|N+1|7"`, new key is `"ws|proj|repo|N+1|7"` → **NO-OP! SKIPS!**
8. In case 6a: the board shows stale data (no epic). No further refresh is triggered until:
   - User interacts with the board (clicks a card, switches workspace, etc.)
   - Another plan file changes (file watcher event)
   - The periodic scan (every 10s) finds a genuinely new file not in the DB

   Since `registerPendingCreation` suppresses the file watcher for 10 seconds, and the periodic scan skips files already in the DB (`existingPaths.has(relativePath)` → `continue`), the epic file doesn't trigger a refresh. The user is stuck waiting.

**Why it feels like "a few minutes":** The user clicks the button, sees nothing happen, and waits. Without any board interaction or unrelated file change, nothing triggers a refresh. The delay ends only when the user gives up and clicks something else on the board, which triggers a refresh that finally shows the epic.

## Metadata

**Tags:** bugfix, backend, ui, ux, reliability
**Complexity:** 5

## User Review Required

Yes — the fix touches the performance-critical no-op early-out path that collapses refresh storms on large boards. A reviewer should confirm that capturing `dataVersionAtRead` before the DB read (rather than after) does not introduce redundant full refreshes during normal idle operation, and that the redundant `_markConfigDirty()` calls in `createEpicFromPlanIds` / `promoteToEpic` are acceptable noise.

## Complexity Audit

### Routine
- The fix is a data-flow correction: capture `dataVersion` at DB read time and pass it through to `recordBoardPush`.
- The `refreshWithData` method has only one production caller (`_refreshRunSheetsImpl`) and one test caller.
- No schema, API, or UI changes.
- The optional-parameter approach preserves backward compatibility for the existing test.

### Complex / Risky
- The `refreshWouldBeNoOp` / `recordBoardPush` mechanism is performance-critical — it collapses refresh storms on large boards. The fix must not weaken the no-op skip or cause redundant full refreshes.
- The `_buildPushKey` includes `configEpoch` as well as `dataVersion`. Any fix must preserve the configEpoch component.
- The `refreshWithData` method also has its own `refreshWouldBeNoOp` backstop check (line 1266) that uses `db.getDataVersion()`. This must also use the read-time dataVersion, or it could incorrectly skip a legitimate refresh.
- **Narrow intra-read race (refinement):** The DB read in `_refreshRunSheetsImpl` spans two separate `await` calls — `db.getBoard(workspaceId)` (line 15364) and `db.getCompletedPlans(workspaceId)` (line 15367). A concurrent `createEpicFromPlanIds` write can land in the yield window BETWEEN these two awaits. If `dataVersionAtRead` is captured AFTER both reads (the plan's original placement), it captures the bumped N+1 while `activeRows` is stale (no epic). The push key is then recorded as N+1 with stale data, and the trailing refresh skips — the bug persists in this narrow window. Capturing `dataVersionAtRead` BEFORE the first DB read (right after the primary early-out at line 15348) is the safer placement: it guarantees the recorded version is ≤ the actual data version, so any concurrent write always forces a key mismatch on the next refresh (the safe direction — a redundant refresh, never a stale skip).

## Edge-Case & Dependency Audit

- **Race Conditions:** This IS the race condition being fixed. The fix ensures the recorded push key always corresponds to the data that was actually read and pushed, regardless of concurrent writes.
- **Concurrent epic creation:** If two epic creations happen simultaneously, each bumps `_dataVersion`. The fix ensures each refresh records the dataVersion at its own read time, so neither refresh is incorrectly skipped.
- **File watcher suppression:** `registerPendingCreation` suppresses the watcher for 10 seconds. During this window, no file-watcher-driven refresh occurs. The explicit `_refreshBoard` at the end of `createEpicFromPlanIds` is the only refresh trigger. If this refresh is skipped (the bug), the epic is invisible until an unrelated event triggers a refresh. The fix ensures this explicit refresh is not skipped.
- **Periodic scan:** The 10-second periodic scan skips files already in the DB (`existingPaths.has(relativePath)`). The epic file IS in the DB (inserted by `createEpicFromPlanIds`), so the scan never triggers a refresh for it. This is correct behavior — the scan is for importing new files, not refreshing existing ones.
- **`promoteToEpic` file-watcher side effect:** The `writeFile` at line 8140 (modifying the plan file in place before the rename) triggers a file-watcher event that creates a spurious duplicate DB record. This duplicate is eventually cleaned up by `filterGhostPlans` (the old file no longer exists after the rename). This is a separate minor issue but not the cause of the delay.
- **Test impact:** The existing test at `src/services/__tests__/KanbanProvider.test.ts:467` calls `refreshWithData` without a dataVersion parameter. The fix adds an optional parameter, so the test continues to work (falls back to current behavior). NOTE: the original plan cited the wrong path (`src/test/KanbanProvider.test.ts`); the correct path is `src/services/__tests__/KanbanProvider.test.ts`.
- **`_markConfigDirty` redundancy in the concurrent case:** The belt-and-suspenders `_markConfigDirty()` calls (Proposed Change #3) do NOT provide the claimed protection when the race is concurrent. `_buildPushKey` reads `this._configEpoch` at key-build time, and `_markConfigDirty()` bumps it BEFORE the in-flight refresh calls `recordBoardPush`. So the in-flight refresh records its push key with the NEW configEpoch, and the trailing refresh's primary early-out builds the same key → still matches → still skips. The calls are harmless (epic creation always bumps dataVersion via DB writes, so configEpoch is redundant here) but the plan must not rely on them as a safety net for the concurrent race. Fix #1+#2 (read-time dataVersion capture) is the actual fix.

## Dependencies

None — this is a self-contained bugfix in two service files. No dependent sessions.

## Adversarial Synthesis

Key risks: (1) capturing `dataVersionAtRead` after the DB read leaves a narrow intra-read window where a concurrent write can record a high version with stale data, re-introducing the skip; (2) the `_markConfigDirty()` belt-and-suspenders calls are ineffective in the concurrent-race scenario because the in-flight refresh records with the already-bumped configEpoch. Mitigations: capture `dataVersionAtRead` BEFORE the first DB read (guarantees recorded version ≤ actual, forcing a safe redundant refresh on any concurrent write); treat the `_markConfigDirty()` calls as harmless defense-in-depth for the non-concurrent case only, not as a race fix.

## Proposed Changes

### 1. `src/services/KanbanProvider.ts` — `refreshWithData` method (line 1237)

**Change:** Add an optional `dataVersionAtRead` parameter. Use it for both the `refreshWouldBeNoOp` backstop check (line 1266) and `recordBoardPush` (line 1471). Fall back to `db.getDataVersion()` when not provided (backward compatibility for tests).

```typescript
public async refreshWithData(
    activeRows: import('./KanbanDatabase').KanbanPlanRecord[],
    completedRows: import('./KanbanDatabase').KanbanPlanRecord[],
    workspaceRoot: string,
    projects?: string[],
    dataVersionAtRead?: number
) {
    if (!this._panel) {
        console.warn('[KanbanProvider] refreshWithData: no panel — skipping');
        return;
    }

    try {
        const resolvedWorkspaceRoot = path.resolve(workspaceRoot);
        if (this._currentWorkspaceRoot) {
            const resolvedCurrentRoot = this.resolveEffectiveWorkspaceRoot(this._currentWorkspaceRoot);
            if (path.resolve(resolvedCurrentRoot) !== resolvedWorkspaceRoot) {
                console.log(`[KanbanProvider] refreshWithData: resolvedWorkspaceRoot ${resolvedWorkspaceRoot} differs from current (effective) ${resolvedCurrentRoot} — not refreshing board`);
                return;
            }
        }
        const db = this._getKanbanDb(resolvedWorkspaceRoot);

        const workspaceId = await db.getWorkspaceId();
        const projList = projects || (workspaceId ? await db.getProjects(workspaceId) : []);

        // Use the dataVersion captured at DB read time (passed by the caller) to
        // prevent the race where a concurrent DB write bumps _dataVersion between
        // the read and this check/record. Falling back to db.getDataVersion()
        // preserves backward compatibility for callers that don't pass it.
        const effectiveDataVersion = dataVersionAtRead ?? db.getDataVersion();

        // O(1) no-op early-out (backstop)
        if (workspaceId && this.refreshWouldBeNoOp(workspaceId, effectiveDataVersion)) {
            return;
        }

        // ... existing card-building logic unchanged ...

        // At line ~1471, change:
        //   this.recordBoardPush(workspaceId, db.getDataVersion());
        // to:
        if (workspaceId) {
            this.recordBoardPush(workspaceId, effectiveDataVersion);
        }
    }
}
```

### 2. `src/services/TaskViewerProvider.ts` — `_refreshRunSheetsImpl` method (line ~15348)

**Change:** Capture `db.getDataVersion()` BEFORE the DB read (immediately after the primary no-op early-out at line 15348, before `getBoard` at line 15364) and pass it to `refreshWithData`. This is the critical placement refinement: capturing before the read guarantees the recorded push-key version is ≤ the actual data version, so any concurrent write that lands during the read window forces a key mismatch on the next refresh (a safe redundant refresh) rather than a stale skip.

```typescript
// O(1) no-op early-out (PRIMARY) — unchanged, uses db.getDataVersion() at this moment
if (this._kanbanProvider?.refreshWouldBeNoOp(workspaceId, db.getDataVersion())) {
    // ... existing throttled log ...
    return;
}

// Capture the dataVersion BEFORE the DB read so the push key recorded by
// refreshWithData corresponds to a version ≤ the data actually read. If a
// concurrent write (e.g. createEpicFromPlanIds) lands during the read window,
// the recorded version will be lower than the post-write version, forcing the
// trailing refresh to re-read and push fresh data instead of skipping as a no-op.
const dataVersionAtRead = db.getDataVersion();

// ONE DB read — this snapshot feeds both sidebar and kanban
const repoScope = this._kanbanProvider?.getRepoScopeFilter() ?? null;
const projectFilter = this._kanbanProvider?.getProjectFilter() ?? null;

const activeRows = (projectFilter !== null || repoScope)
    ? await db.getBoardFilteredByProject(workspaceId, projectFilter, repoScope)
    : await db.getBoard(workspaceId);
const completedRows = (projectFilter !== null || repoScope)
    ? await db.getCompletedPlansFilteredByProject(workspaceId, projectFilter, repoScope)
    : await db.getCompletedPlans(workspaceId);

// ... existing logging ...

const projects = workspaceId ? await db.getProjects(workspaceId) : [];

// Pass dataVersionAtRead so refreshWithData uses the read-time version
await this._kanbanProvider?.refreshWithData(activeRows, completedRows, resolvedWorkspaceRoot, projects, dataVersionAtRead);
```

### 3. `src/services/KanbanProvider.ts` — `createEpicFromPlanIds` and `promoteToEpic` (defense-in-depth for the non-concurrent case)

**Change:** Call `_markConfigDirty()` before `_refreshBoard` at the end of both methods. This bumps `_configEpoch`, which is part of the push key, ensuring `refreshWouldBeNoOp` returns false for the non-concurrent case (no in-flight refresh) even if the dataVersion race somehow persists. NOTE: this does NOT protect the concurrent-race case (see Edge-Case & Dependency Audit), but it is harmless and provides defense-in-depth for the simpler scenario.

In `createEpicFromPlanIds` (before line 9318):
```typescript
this._markConfigDirty(); // defense-in-depth: ensure the post-creation refresh isn't skipped by the no-op guard
await this._refreshBoard(workspaceRoot);
```

In `promoteToEpic` (before line 8177):
```typescript
this._markConfigDirty(); // defense-in-depth: ensure the post-promotion refresh isn't skipped by the no-op guard
await this._refreshBoard(workspaceRoot);
```

## Verification Plan

### Manual Verification
1. Open the kanban board in VS Code with 2+ non-epic plans in the CREATED column.
2. Select 2+ cards → click "GROUP INTO EPIC" → enter name → submit.
3. **Verify:** The epic card appears on the board within 1-2 seconds (not minutes).
4. **Verify:** The selected plans are now subtasks of the epic (epic badge / subtask count).
5. Select 1 non-epic card → click "PROMOTE TO EPIC" → enter name → submit.
6. **Verify:** The plan transforms into an epic card within 1-2 seconds.
7. **Verify:** The board refreshes correctly after each operation without manual interaction.
8. **Stress test:** Rapidly create 3 epics in succession. Verify all 3 appear promptly.
9. **Concurrent-race test:** Trigger a file-watcher refresh (e.g. touch an unrelated plan file) and immediately click "GROUP INTO EPIC" within the 100ms debounce window. Verify the epic still appears promptly (this exercises the in-flight + trailing coalescing path).

### Automated Tests
- **Unit test** (`src/services/__tests__/KanbanProvider.test.ts`): Call `refreshWithData` with `dataVersionAtRead` parameter. Verify `recordBoardPush` uses the passed-in value, not `db.getDataVersion()`.
- **Race simulation test:** Mock a scenario where `db.getDataVersion()` returns a higher value after the DB read. Verify the push key is recorded with the read-time value, and the next refresh is NOT incorrectly skipped.
- **Intra-read race test:** Mock `getDataVersion` to return a lower value before `getBoard` and a higher value after `getCompletedPlans`. Verify the push key is recorded with the lower (pre-read) value, so the trailing refresh re-reads and pushes fresh data.
- **Existing test regression:** Verify the existing `refreshWithData` test (`src/services/__tests__/KanbanProvider.test.ts:467`) still passes without the `dataVersionAtRead` parameter (backward compatibility).

### Console Log Verification
During manual testing, watch the debug console for:
- `[KanbanProvider] createEpicFromPlanIds: verify is_epic=1, kanbanColumn=CREATED...` — confirms DB write succeeded.
- `[refreshRunSheets] DB returned N active...` — confirms refresh ran and read the epic.
- `[KanbanProvider] refreshWithData: sent N cards...` — confirms board push happened.
- Absence of `O(1) early-out: skipping no-op tick` immediately after epic creation — confirms the fix prevented the stale skip.

### Recommendation
Complexity 5 → **Send to Coder**.
