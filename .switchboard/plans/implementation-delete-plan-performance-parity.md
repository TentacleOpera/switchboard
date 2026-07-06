# Speed Up implementation.html Delete Button — Parity with project.html

## Goal

The DELETE button in `implementation.html` takes several seconds to complete, while the DELETE button in `project.html` (Kanban/Features tabs) is snappy. Bring the implementation.html delete path close to the project.html path's performance by: (1) switching from the deprecated session-keyed `deletePlan(sessionId)` to `deletePlanByPlanId`, (2) making the Linear/ClickUp delete-sync calls non-blocking (fire-and-forget), and (3) replacing the full `_syncFilesAndRefreshRunSheets` (which does an Antigravity/flat-plan directory rescan + run-sheet rebuild) with a lightweight `_refreshRunSheets` that skips the file rescan — the file watcher already handles the deleted file's disappearance.

### Problem Analysis & Root Cause

The two delete buttons go through completely different backend handlers:

**project.html (snappy, ~50ms):** `project.js` sends `deleteKanbanPlan` → `PlanningPanelProvider.ts:3538` → `db.deletePlanByPlanId(planId)` + `fs.unlink(planFile)` → post `kanbanPlanDeleted` → webview re-fetches the list. Three steps, no file scan, no external API calls, no run-sheet operations.

**implementation.html (laggy, ~2-5s):** `implementation.html` sends `deletePlan` → `TaskViewerProvider._handleDeletePlan` (`TaskViewerProvider.ts:15101`) → a 19-step sequence including:
1. Run-sheet read (`getRunSheet`)
2. Review-file scan (`_findReviewFilesForSession`)
3. Tombstone write + claim-marker unlink
4. Brain file unlink + mirror file unlink + review-file unlinks
5. DB lookup for Linear/ClickUp sync (`getPlanBySessionId`)
6. **Potential Linear API call** (`linear.archiveIssue`) — network round-trip, 1-3s
7. **Potential ClickUp API call** (`clickup.archiveTask`) — network round-trip, 1-3s
8. `db.deletePlan(sessionId)` — the **deprecated** session-keyed path (extra `getPlanBySessionId` lookup before the DELETE)
9. Plan-registry status update
10. **`_syncFilesAndRefreshRunSheets`** — full Antigravity/flat-plan directory rescan (`_rescanAntigravityPlanSources`) + run-sheet rebuild. This is the single biggest cost: it scans all configured IDE plan directories, stats every candidate file, and processes new/changed candidates through the mirror/claim/tombstone pipeline.

The three offenders are:
- **`_syncFilesAndRefreshRunSheets`** (step 10) — the full file-system rescan is unnecessary after a delete because the `GlobalPlanWatcherService` already watches `.switchboard/plans/` and will fire a delete event when the .md file is unlinked. The rescan is a legacy safety net that predates the watcher.
- **Linear/ClickUp sync** (steps 6-7) — network API calls that block the entire delete completion. These are best-effort cleanup operations (the plan is already deleted locally) and don't need to block the UI.
- **`db.deletePlan(sessionId)`** (step 8) — the deprecated path does an extra `getPlanBySessionId` lookup before the DELETE. The run sheet already carries `planId` (`sheet.planId` at line 15284), so we can call `deletePlanByPlanId` directly.

## Metadata

- **Tags:** performance, backend, implementation-html, delete, kanban
- **Complexity:** 4
- **Files:** `src/services/TaskViewerProvider.ts`, `src/webview/implementation.html`

## Complexity Audit

### Routine
- Replace `db.deletePlan(sessionId)` with `db.deletePlanByPlanId(sheet.planId)` at line 15290 — the `sheet` object already has `planId` (used at line 15284 for `_activeDispatchSessions.delete(sheet.planId)`).
- Replace `_syncFilesAndRefreshRunSheets(resolvedWorkspaceRoot)` at line 15310 with `_refreshRunSheets(resolvedWorkspaceRoot)` — the lighter path that skips the Antigravity rescan.
- Make Linear/ClickUp delete-sync fire-and-forget (don't `await`).

### Complex / Risky
- **File-watcher reliability:** Replacing `_syncFilesAndRefreshRunSheets` with `_refreshRunSheets` relies on the `GlobalPlanWatcherService` detecting the .md file deletion and updating the DB. The watcher is already the primary mechanism for file changes (the rescan is a fallback). However, if the watcher misses the deletion (e.g., the file is on a network drive, or the watcher's debounce drops the event), the stale DB row would persist until the next manual refresh. Mitigation: the existing `_refreshRunSheets` still rebuilds run sheets from the DB, so the sidebar updates correctly regardless — only the (rare) stale-row case is affected, and it self-heals on the next board refresh or restart.
- **Brain-source plans:** For brain-source plans (Antigravity/managed imports), the brain file deletion is what removes the plan from the external scan. The rescan would have re-mirrored the brain file if it still existed — but since we just deleted it, the rescan would find nothing. Skipping the rescan is safe here too.
- **Linear/ClickUp sync failure visibility:** Making the sync fire-and-forget means the user won't see sync failures in the UI. The existing code already logs warnings and continues with local deletion on failure, so the behavior change is only that the user doesn't wait for the sync to complete. If the sync fails, the warning is in the console log — same as today.

## Edge-Case & Dependency Audit

- **`sheet.planId` may be undefined:** The run sheet is fetched at line 15113 (`const sheet = await log.getRunSheet(sessionId)`). If `sheet.planId` is missing (legacy run sheet from before planId was introduced), fall back to the existing `db.deletePlan(sessionId)` path. The `sheet?.planId` guard at line 15284 already checks for this.
- **`_refreshRunSheets` vs `_syncFilesAndRefreshRunSheets` for brain plans:** The `_syncFilesAndRefreshRunSheets` path includes `_rescanAntigravityPlanSources` which re-mirrors brain plans. After a delete, the brain file is gone, so the rescan would find nothing to re-mirror. The `_refreshRunSheets` path (which just rebuilds run sheets from the DB) is sufficient — the DB row is already deleted, so the plan won't appear in the run-sheet list.
- **Coalescing:** `_refreshRunSheets` has built-in coalescing (lines 15480-15498: one in-flight + one queued). This means if a watcher event fires simultaneously, the two refreshes collapse into one. `_syncFilesAndRefreshRunSheets` has the same coalescing (lines 15660-15676). No change in behavior.
- **`handleDeletePlanFromReview` caller (line 3697):** This public method also calls `_handleDeletePlan` and is used from the review panel. The performance improvements apply to this caller too — no change needed.
- **implementation.html has no delete-result handler:** The webview doesn't listen for a specific delete-result message — it relies on the `runSheets` message (sent by `_refreshRunSheets`) to update the dropdown. This means the UI won't update until the refresh completes. Making the refresh lighter (skipping the rescan) means the `runSheets` message arrives sooner — the UI updates faster.

## Proposed Changes

### 1. `src/services/TaskViewerProvider.ts` — Switch to `deletePlanByPlanId` (line ~15289-15291)

**Before:**
```typescript
if (db && (!brainSourcePath || isManagedImport)) {
    await db.deletePlan(sessionId);
    console.log(`[TaskViewerProvider] _handleDeletePlan: db plan deleted for sessionId=${sessionId}`);
}
```

**After:**
```typescript
if (db && (!brainSourcePath || isManagedImport)) {
    const deletePlanId = sheet?.planId || sessionId;
    if (sheet?.planId) {
        await db.deletePlanByPlanId(sheet.planId);
    } else {
        // Legacy run sheet without planId — fall back to deprecated session-keyed path
        await db.deletePlan(sessionId);
    }
    console.log(`[TaskViewerProvider] _handleDeletePlan: db plan deleted for planId=${deletePlanId}`);
}
```

### 2. `src/services/TaskViewerProvider.ts` — Make Linear/ClickUp sync fire-and-forget (lines ~15239-15280)

Wrap the Linear and ClickUp sync blocks in fire-and-forget IIFEs so they don't block the delete completion. The `planRecord` lookup must remain awaited (it's needed for the registry status update later), but the API calls themselves become non-blocking.

**Before (Linear, lines 15239-15258):**
```typescript
if (planRecord?.linearIssueId) {
    try {
        const linear = this._getLinearService(resolvedWorkspaceRoot);
        const linearConfig = await linear.loadConfig();
        if (linearConfig?.deleteSyncEnabled === true) {
            const archiveResult = await linear.archiveIssue(planRecord.linearIssueId);
            if (!archiveResult.success) {
                console.warn(/* ... */);
            }
        }
    } catch (archiveError) {
        console.warn(/* ... */);
    }
}
```

**After (Linear):**
```typescript
if (planRecord?.linearIssueId) {
    const linearIssueId = planRecord.linearIssueId;
    const linear = this._getLinearService(resolvedWorkspaceRoot);
    void (async () => {
        try {
            const linearConfig = await linear.loadConfig();
            if (linearConfig?.deleteSyncEnabled === true) {
                const archiveResult = await linear.archiveIssue(linearIssueId);
                if (!archiveResult.success) {
                    console.warn(
                        `[TaskViewerProvider] _handleDeletePlan: Linear archive failed for issue ${linearIssueId}: ${archiveResult.error}. ` +
                        `Local deletion already completed.`
                    );
                }
            }
        } catch (archiveError) {
            console.warn(
                `[TaskViewerProvider] _handleDeletePlan: Linear archive threw for session ${sessionId}: ${archiveError}. ` +
                `Local deletion already completed.`
            );
        }
    })();
}
```

Apply the same fire-and-forget pattern to the ClickUp block (lines 15261-15280).

### 3. `src/services/TaskViewerProvider.ts` — Replace full rescan with lightweight refresh (line ~15309-15313)

**Before:**
```typescript
if (mirrorPath || brainSourcePath) {
    await this._syncFilesAndRefreshRunSheets(resolvedWorkspaceRoot);
} else {
    await this._refreshRunSheets(resolvedWorkspaceRoot);
}
```

**After:**
```typescript
// Use the lightweight refresh (DB→run-sheet rebuild) instead of the full
// _syncFilesAndRefreshRunSheets (which includes _rescanAntigravityPlanSources —
// a directory scan of all configured IDE plan folders). The file watcher
// (GlobalPlanWatcherService) already detects the .md file deletion and updates
// the DB; the rescan is a legacy safety net that adds ~1-2s of latency.
if (mirrorPath || brainSourcePath) {
    await this._refreshRunSheets(resolvedWorkspaceRoot);
} else {
    await this._refreshRunSheets(resolvedWorkspaceRoot);
}
```

This simplifies to a single `await this._refreshRunSheets(resolvedWorkspaceRoot)` call (both branches now do the same thing).

## Verification Plan

1. **Local plan delete (implementation.html):** Select a plan in the implementation.html dropdown, click DELETE. Verify the plan disappears from the dropdown within ~200ms (vs the previous ~2-5s). Verify no console errors.
2. **Brain-source plan delete:** Delete a plan that has a brain source (Antigravity). Verify the brain file is deleted, the mirror file is deleted, and the plan disappears from the dropdown quickly. Verify the plan does NOT reappear (the watcher should not re-import a deleted brain file — the tombstone prevents this).
3. **Linear delete-sync (if enabled):** With `deleteSyncEnabled` true and a plan linked to a Linear issue, delete the plan. Verify the local deletion completes immediately and the Linear issue is archived asynchronously (check console for the warning or success log within a few seconds).
4. **ClickUp delete-sync (if enabled):** Same as above for ClickUp.
5. **Legacy run sheet (no planId):** Delete a plan whose run sheet has no `planId` field. Verify it falls back to `db.deletePlan(sessionId)` and still deletes successfully.
6. **project.html delete regression:** Verify the project.html delete button is unaffected (it uses a completely different handler in PlanningPanelProvider.ts).
7. **File-watcher integration:** After deleting a plan, verify the `GlobalPlanWatcherService` logs a delete event for the .md file (check console). If the watcher is functioning, the DB row is removed by the watcher's delete handler — the `_refreshRunSheets` just rebuilds the UI from the already-updated DB.
8. **`npm run compile`** succeeds.

## Recommendation

Complexity 4 → **Send to Coder**.
