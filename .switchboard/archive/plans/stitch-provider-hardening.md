# Stitch Provider Hardening

## Goal

Fix four operational risks in the Stitch subsystem of `DesignPanelProvider.ts` that were identified during review of the Stitch Cache Recovery Features implementation.

**Core problems:**
1. **Concurrent mutating operations interleave** in `_handleMessage` because there is no provider-level concurrency guard. Rapid webview clicks can trigger overlapping `stitchForceReloadScreens` + `stitchGenerate` flows, corrupting `_activeScreens` and the KanbanDatabase cache.
2. **Orphaned PNG cache files accumulate** in `.switchboard/stitch/` because `stitchForceReloadScreens` deletes DB entries and evicts `_activeScreens` but never deletes the on-disk PNGs.
3. **Fragile `_activeScreens` eviction** checks both `screen.projectId` and `screen.project_id` to handle SDK naming inconsistencies, making the code brittle against future SDK changes.
4. **Orphaned command registration** in `package.json` references `switchboard.rebuildStitchCache`, a command that was removed during review of the Stitch Cache Recovery Features plan. The command palette entry now silently fails with "command not found".

## Metadata

**Tags:** backend, bugfix, reliability
**Complexity:** 5

## User Review Required

- [ ] Confirm concurrency guard error message wording: `Another Stitch operation is in progress. Please wait.`
- [ ] Confirm removal of `switchboard.rebuildStitchCache` from `package.json` is acceptable (command was already non-functional)
- [ ] Confirm `_activeScreens.clear()` on force reload is acceptable even though it evicts screens for OTHER projects (they will be re-fetched from DB on next project switch)

## Complexity Audit

### Routine
- Add a `private _stitchOperationLock = false` field and wrap 6 existing `case` blocks in `if (lock) return` + `try/finally`.
- Add PNG deletion loop inside `stitchForceReloadScreens` using the same pattern already present in `stitchRebuildImageCache`.
- Replace 4-line eviction loop with `this._activeScreens.clear()`.
- Remove one JSON object from `package.json` `commands` array.

### Complex / Risky
- `_activeScreens.clear()` evicts ALL projects' in-memory screen instances, not just the current one. If the user switches to another project before its screens are re-fetched, `stitchEdit`/`stitchVariants` will throw `Screen instance not found` until `stitchGetProjectScreens` runs.
- `_stitchOperationLock` is a boolean, not a semaphore. If an operation hangs (e.g., SDK network timeout), all subsequent Stitch operations are blocked until the provider is disposed or VS Code restarts.
- `dispose()` must reset `_stitchOperationLock = false` to prevent a hung operation from permanently bricking the provider after panel close/reopen.

## Edge-Case & Dependency Audit

### Race Conditions
- **Double-submit via rapid clicks:** The webview `stitchBusy` flag reduces this, but the provider-side guard is the authoritative backstop. Both layers should remain.
- **Interleaved mutation:** `stitchForceReloadScreens` (deletes DB, clears cache, fetches API) racing with `stitchEdit` (reads `_activeScreens`, mutates via SDK) can leave the DB, `_activeScreens`, and disk cache in inconsistent states.
- **dispose() during operation:** If the webview panel closes while a Stitch operation is in-flight, `_stitchOperationLock` would stay `true` unless `dispose()` resets it.

### Security
- PNG deletion uses `path.basename(screenId)` to prevent directory traversal if a malicious screen ID contains `../`. This matches the existing `stitchRebuildImageCache` pattern.
- No new user input is accepted.

### Side Effects
- `_activeScreens.clear()` drops cached SDK Screen instances for ALL projects. The next `stitchGetProjectScreens` for any project will re-fetch from the API instead of using the in-memory cache.
- PNG deletion in `stitchForceReloadScreens` removes files BEFORE the subsequent API fetch repopulates them. The gallery will temporarily show empty/loading state.

### Dependencies & Conflicts
- No new runtime dependencies.
- Depends on existing `KanbanDatabase` methods: `getStitchScreensForProject`, `deleteStitchScreensForProject`.
- Depends on existing `_getImageCacheDir` helper.

## Dependencies

No external session dependencies.

## Adversarial Synthesis

Key risks: the boolean lock can deadlock if an operation hangs; `_activeScreens.clear()` has cross-project eviction side effects; the original Fix 2 targeted `rebuildStitchCache` which was removed in a prior plan review and no longer exists in code. Mitigations: reset the lock in `dispose()`; scope PNG cleanup to the DB query result rather than `_activeScreens`; remove the orphaned `package.json` command entry.

## Proposed Changes

### `src/services/DesignPanelProvider.ts`

**Context:** Class field declaration area, after line ~48 (`_activeScreens` declaration).

**Logic:**
- Add `private _stitchOperationLock = false;` after `_activeScreens`.
- In `dispose()` (line ~165), add `this._stitchOperationLock = false;` after `this._activeScreens.clear();`.

**Context:** `_handleMessage` method, `case 'stitchRebuildImageCache'` at line ~1354.

**Logic:**
- Insert lock guard at the top of the `try` block:
  ```ts
  if (this._stitchOperationLock) {
      this.postMessage({ type: 'stitchError', error: 'Another Stitch operation is in progress. Please wait.', workspaceRoot });
      return;
  }
  this._stitchOperationLock = true;
  ```
- Wrap the existing logic in `try { ... } finally { this._stitchOperationLock = false; }`.
- The existing `catch` block at lines 1387-1388 already posts `stitchError`; no change needed.

**Context:** `_handleMessage` method, `case 'stitchForceReloadScreens'` at line ~1392.

**Logic:**
- Insert lock guard at the top of the `try` block (same pattern as above).
- Wrap existing logic in `try { ... } finally { this._stitchOperationLock = false; }`.
- **Before** `await db.deleteStitchScreensForProject(projectId);`, query the DB for screen IDs:
  ```ts
  const cached = await db.getStitchScreensForProject(projectId);
  const cacheDir = this._getImageCacheDir(workspaceRoot);
  for (const s of cached) {
      const fileUri = vscode.Uri.file(path.join(cacheDir, `${path.basename(s.id)}.png`));
      try { await vscode.workspace.fs.delete(fileUri); } catch { /* ignore if not exist */ }
  }
  ```
- Then proceed with `await db.deleteStitchScreensForProject(projectId);`.
- Replace the targeted eviction loop (lines 1404-1408):
  ```ts
  // Before:
  // for (const [screenId, screen] of this._activeScreens.entries()) {
  //     if (screen && (screen.projectId === projectId || screen.project_id === projectId)) {
  //         this._activeScreens.delete(screenId);
  //     }
  // }
  // After:
  this._activeScreens.clear();
  ```

**Context:** `_handleMessage` method, `case 'stitchCreateProject'` at line ~1436.

**Logic:**
- Insert lock guard + `try/finally` around existing logic (same pattern).

**Context:** `_handleMessage` method, `case 'stitchGenerate'` at line ~1866.

**Logic:**
- Insert lock guard + `try/finally` around existing logic (same pattern).

**Context:** `_handleMessage` method, `case 'stitchEdit'` at line ~1884.

**Logic:**
- Insert lock guard + `try/finally` around existing logic (same pattern).

**Context:** `_handleMessage` method, `case 'stitchVariants'` at line ~1897.

**Logic:**
- Insert lock guard + `try/finally` around existing logic (same pattern).

### `package.json`

**Context:** `contributes.commands` array. Find the object with `"command": "switchboard.rebuildStitchCache"`.

**Logic:**
- Remove the entire command object (lines ~138-142):
  ```json
  {
    "command": "switchboard.rebuildStitchCache",
    "title": "Switchboard: Rebuild Stitch Cache",
    "category": "Switchboard"
  },
  ```

## Verification Plan

### Manual Tests
- [ ] Rapid clicks on "Force Reload Screens" while another operation is running shows error toast in webview.
- [ ] Force reload deletes orphaned PNGs from `.switchboard/stitch/` (verify by creating a fake PNG, triggering force reload, confirming deletion).
- [ ] Variants/Edit after force reload uses fresh screen objects (no stale references).
- [ ] Close Design Panel mid-operation, reopen, confirm new operations are not blocked.
- [ ] Verify `Switchboard: Rebuild Stitch Cache` no longer appears in Command Palette.

### Automated Tests
- **SKIP:** Per session directive. Test suite will be run separately by user.

## Remaining Risks

- `_stitchOperationLock` is a boolean without timeout. If the Stitch SDK hangs on a network call, the provider stays locked until `dispose()` is called or VS Code restarts. A future enhancement could add a `Promise`-based lock with `AbortController` timeout.
- `_activeScreens.clear()` evicts screens for ALL projects. If the user has multiple Stitch projects and switches to another project before its screens are re-fetched, `stitchEdit`/`stitchVariants` will fail with `Screen instance not found in memory cache.` The webview will auto-fetch on project switch, so the window of failure is narrow.

---

## Review Findings

Implementation reviewed against plan requirements. All 4 fixes are correctly applied:
- `_stitchOperationLock` added and reset in `dispose()`
- Lock guards wrap the 6 specified case blocks with `try/finally` release
- `stitchForceReloadScreens` deletes orphaned PNGs before DB deletion using `path.basename(s.id)` sanitization
- `_activeScreens.clear()` replaces the fragile dual-key eviction loop
- `switchboard.rebuildStitchCache` command removed from `package.json`

**Files changed:** `src/services/DesignPanelProvider.ts`, `package.json`

**Validation:** Not run per session directive (compilation and tests skipped; user will run separately).

**Remaining risks:**
- `_stitchOperationLock` is a boolean without timeout; a hung SDK call blocks all Stitch operations until `dispose()` or restart.
- `_activeScreens.clear()` evicts screens for ALL projects; cross-project switch before re-fetch causes transient `Screen instance not found` errors.
- Two cache-writing paths (`stitchGetProjectScreens`, `stitchRefreshScreen`) do not check the lock; analysis found no corruption path but coverage is incomplete.

**Recommendation:** Send to Coder
