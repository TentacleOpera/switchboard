# Fix Antigravity Brain Plan Mirroring on Startup and Reload

## Goal
Fix the reliability of Antigravity plan mirroring in the Switchboard extension by restoring the startup/reload rescan logic and updating the associated source-code regression tests.

### Core Problems & Root Cause Analysis

1. **Filesystem Watcher Race Condition & Timing Differences**:
   - **The Missed Plan (`4c24b49f-7094-41fa-a753-ba99ac07764a/`)**: When a new session starts, the directory and `implementation_plan.md` are created almost simultaneously. Since the directory is brand new, the VS Code recursive directory watcher is still registering it and misses the file's initial `onDidCreate` event. Because the watcher misses this, no claim or mirror operation is triggered, leaving the directory without a `.switchboard_claim_*.json` marker file.
   - **The Mirrored Plan (`76b6d4bf-e473-45b2-866b-2fff1dbae020/`)**: This session folder was created when the agent initialized. The `implementation_plan.md` was written minutes later after design discussion. Because the directory had already existed for several minutes, the watcher had fully registered it, successfully captured the `onDidCreate` event, claimed the plan (generating `.switchboard_claim_5a7b1232bfbd6433f6c845ae956daef62ea9e6e006f889fb37eb9ffd21ee0cf0.json`), and mirrored it to `.switchboard/plans/`.

2. **Accidental Removal of Rescan Logic**:
   - During the transition to the DB-first architecture (commit `dd7d5b8`), the helper method `_syncFilesToDb` was deleted from the codebase.
   - Along with it, the call to `_rescanAntigravityPlanSources(resolvedWorkspaceRoot)` was also removed from the reload/startup pipeline inside `_syncFilesAndRefreshRunSheets()`.
   - Consequently, when filesystem watcher events are missed due to folder-creation latency, there is no longer any rescan mechanism on reload/startup to recover those missed plans, leaving them permanently invisible on the Kanban board.
   - **Current code state verified**: `_rescanAntigravityPlanSources` still exists at line 11079 of TaskViewerProvider.ts but is never called (0 call sites). `_syncFilesToDb` no longer exists — only a stale comment reference at line 7319.

3. **Stale Regex Regression Test**:
   - The test `src/test/brain-rescan-regression.test.js` is currently failing because it asserts that `_syncFilesAndRefreshRunSheets` calls both `_rescanAntigravityPlanSources` and the now-deleted `_syncFilesToDb` method.

## Metadata
- **Tags:** database, workflow, testing, reliability, bugfix
- **Complexity:** 3

## User Review Required
> [!NOTE]
> This change restores the rescan check during extension load and workspace refreshes. It runs entirely locally on the developer's machine and has no schema migrations or remote impacts.

## Complexity Audit
### Routine
- Restoring the private call `await this._rescanAntigravityPlanSources(resolvedWorkspaceRoot)` inside `_syncFilesAndRefreshRunSheets` (line 13819, before the existing `_refreshRunSheets` call).
- Modifying the regex in `brain-rescan-regression.test.js` (line 19) to match the updated source sequence (removing the deleted `_syncFilesToDb` reference).

### Complex / Risky
- None

## Edge-Case & Dependency Audit
- **Race Conditions**: During folder creation latency, the initial file-create watcher event is missed. Restoring `_rescanAntigravityPlanSources` on load ensures those plans are recovered. `_mirrorBrainPlan` is called with `suppressFollowupSync = true` during rescans to avoid loop triggers. The `_recentMirrorProcessed` dedupe guard (5s TTL, line 11776-11779) prevents duplicate processing if `_syncFilesAndRefreshRunSheets` is called multiple times in quick succession.
- **Security**: None.
- **Side Effects**: Disk traversal is restricted to `~/.gemini/antigravity/brain` or equivalent, and is debounced by `_lastAntigravityRescanAt` to prevent performance overhead. The first call after a 30-minute window performs a full scan; subsequent calls have a ~2-second window and typically find zero new files.
- **Dependencies & Conflicts**: None.

## Dependencies
- None

## Adversarial Synthesis
Key risks: (1) Rescan failure could block the downstream `_refreshRunSheets` call if both share the same try/catch — mitigated by wrapping the rescan in its own try/catch so UI refresh proceeds even if rescan fails. (2) Adding rescan to `_syncFilesAndRefreshRunSheets` affects all 23 call sites — mitigated by `_lastAntigravityRescanAt` debouncing which limits full traversals to the first call after each 30-minute window. (3) Structural regex test is inherently fragile — acknowledged but out of scope for this fix.

## Proposed Changes

### [TaskViewerProvider.ts](file:///Users/patrickvuleta/Documents/GitHub/switchboard/src/services/TaskViewerProvider.ts)
- **Context**: Reload/startup refresh method `_syncFilesAndRefreshRunSheets` (line 13812).
- **Logic**: Restore call to `_rescanAntigravityPlanSources` with its own error isolation so a rescan failure does not block the UI refresh.
- **Implementation**: At line 13819, before the existing `await this._refreshRunSheets(resolvedWorkspaceRoot);`, insert:
  ```typescript
  try {
      await this._rescanAntigravityPlanSources(resolvedWorkspaceRoot);
  } catch (e) {
      console.error('[TaskViewerProvider] Antigravity rescan failed:', e);
  }
  ```
  The resulting method body should read:
  ```typescript
  private async _syncFilesAndRefreshRunSheets(workspaceRoot?: string) {
      try {
          const resolvedWorkspaceRoot = workspaceRoot
              ? this._resolveWorkspaceRoot(workspaceRoot)
              : this._resolveWorkspaceRoot();
          if (!resolvedWorkspaceRoot) return;

          try {
              await this._rescanAntigravityPlanSources(resolvedWorkspaceRoot);
          } catch (e) {
              console.error('[TaskViewerProvider] Antigravity rescan failed:', e);
          }
          await this._refreshRunSheets(resolvedWorkspaceRoot);
      } catch (e) {
          console.error('[TaskViewerProvider] Failed to refresh from DB:', e);
          this._view?.webview.postMessage({ type: 'runSheets', activeSheets: [], completedSheets: [] });
      }
  }
  ```
- **Edge Cases**: Debounced by `_lastAntigravityRescanAt` (line 255, initialized to 0). First rescan covers 30-minute window; subsequent rescans have ~2-second window. Error isolation ensures `_refreshRunSheets` always runs even if rescan fails.

### [brain-rescan-regression.test.js](file:///Users/patrickvuleta/Documents/GitHub/switchboard/src/test/brain-rescan-regression.test.js)
- **Context**: Structural source-code regression test, second assertion (line 19).
- **Logic**: Align test assertion regex with the current DB-first code by removing the deleted `_syncFilesToDb` reference.
- **Implementation**: On line 19, change the regex from:
  ```
  /private async _syncFilesAndRefreshRunSheets\(workspaceRoot\?: string\) \{[\s\S]*await this\._rescanAntigravityPlanSources\(resolvedWorkspaceRoot\);[\s\S]*await this\._syncFilesToDb\(resolvedWorkspaceRoot\);[\s\S]*await this\._refreshRunSheets\(resolvedWorkspaceRoot\);/
  ```
  to:
  ```
  /private async _syncFilesAndRefreshRunSheets\(workspaceRoot\?: string\) \{[\s\S]*await this\._rescanAntigravityPlanSources\(resolvedWorkspaceRoot\);[\s\S]*await this\._refreshRunSheets\(resolvedWorkspaceRoot\);/
  ```
  Also update the assertion message on line 21 from `'Expected the heavy refresh path to rescan Antigravity source files before syncing DB/UI snapshots.'` to `'Expected the heavy refresh path to rescan Antigravity source files before refreshing run sheets.'` to reflect the removal of the DB-sync step.
- **Edge Cases**: None.

## Verification Plan

### Automated Tests
- Run `npx mocha src/test/brain-rescan-regression.test.js` and verify it passes.
- **Note**: Compilation and test execution are skipped in this session per directive. The test suite will be run separately by the user.

### Manual Verification
- After implementing the fix, reload the VS Code window with an Antigravity brain directory containing a plan that was created while the extension was not running. Confirm the plan appears on the Kanban board after reload.
- Verify that plans already visible before reload remain visible (no regression).

***

### Recommendation
Send to Coder
