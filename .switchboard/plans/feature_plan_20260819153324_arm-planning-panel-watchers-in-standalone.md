# Arm Planning Panel Watchers in Standalone Host

## Goal

The Planning panel has 8 file watchers that are only armed from `open()` — the VS Code webview-panel opening path that standalone never calls. In the standalone host, zero Planning panel watchers are armed, so new/changed/deleted files in managed folders, kanban plans, features, constitution files, insights, and Antigravity brain directories are never detected.

### Problem Analysis & Root Cause

`PlanningPanelProvider.open()` (line 945-954) calls all 8 watcher setups:

```ts
this._setupDocsFolderWatcher(this._getWorkspaceRoot() || this._getWorkspaceRoots()[0]);
this._setupLocalFolderWatchers();
this._setupPlanningHtmlFolderWatchers();
this._setupAntigravityWatcher();
this._setupKanbanPlansWatcher();
this._setupFeatureDocsWatcher();
this._setupConstitutionWatcher();
this._setupInsightsWatcher();
```

In standalone, `open()` is never called. The bootstrap injects `_hostSeams` and `_broadcaster` directly (`bootstrap.ts:982-983`), bypassing `open()` entirely. The webview communicates over HTTP/WS, not a VS Code webview panel.

Compare with the Tickets panel, which was properly fixed: it exposes a `setupTicketsWatcher` verb (`TicketsPanelProvider.ts:1919`) that the webview sends on load, arming watchers via the message handler path that standalone actually uses. The Planning panel has no equivalent.

The 8 broken watchers and their seam methods:

| Watcher | Method | Seam call |
|---------|--------|-----------|
| Docs folder | `_setupDocsFolderWatcher` | `watchFolder` |
| Local folder docs | `_setupLocalFolderWatchers` | `watchFolder` |
| Planning HTML folder | `_setupPlanningHtmlFolderWatchers` | `watchFolder` |
| Antigravity brain | `_setupAntigravityWatcher` | `watchFolder` |
| Kanban plans | `_setupKanbanPlansWatcher` | `watchFolder` |
| Feature docs | `_setupFeatureDocsWatcher` | `watchFolder` |
| Constitution | `_setupConstitutionWatcher` | `watchFile` |
| Insights | `_setupInsightsWatcher` | `watchFolder` |

**Dependency:** This plan depends on plan 1 (fix the no-op shim). Without the shim fix, `watchFile` (Constitution watcher) remains a no-op even after arming. `watchFolder` watchers would work via the bootstrap override, but the override is removed in plan 1 — so both plans must land together. Additionally, plan 1 adds the `RelativePattern` class to the shim, which is required for `VscodeHostFileWatcher.watchFile` to not crash on `new vscode.RelativePattern(...)` when `_setupConstitutionWatcher` is called.

## Metadata

**Complexity:** 3
**Tags:** backend, bugfix, reliability
**Project:** Browser Switchboard

## User Review Required

No user decision needed. The fix adds existing watcher-setup method calls to an existing verb handler that runs in both hosts. All methods are already idempotent and called from multiple sites.

## Complexity Audit (Routine vs Complex/Risky)

**Routine.** The fix is a single block of method calls added to an existing verb handler. All 8 `_setup*Watchers` methods already exist, are idempotent (dispose existing watchers before re-arming), and are called from multiple sites already (e.g., `addLocalFolder` calls `_setupLocalFolderWatchers`). The only new thing is calling them from a path that runs in standalone.

### Complex / Risky
- None

## Edge-Case & Dependency Audit

- **Double-arming in VS Code:** `open()` arms the watchers, then `fetchRoots` (which fires when the webview sends its first message) would arm them again. This is safe — every `_setup*Watchers` method disposes existing watchers before re-arming. The second call replaces the first set cleanly. The only cost is creating and disposing `fs.FSWatcher` objects unnecessarily. Mitigation: acceptable — happens once per panel open.
- **Config race:** `open()` may arm zero watchers if `LocalFolderService`'s async config load hasn't resolved yet (the sync DB fallback returns empty). By the time `fetchRoots` arrives, the async load has resolved and the DB is ready, so `getFolderPaths()` returns the full configured set. This actually fixes a VS Code race as a side effect.
- **`_handleFetchRoots` called multiple times:** The webview sends `fetchRoots` on page load and on workspace changes. Each call re-arms all watchers. Safe but wasteful. Mitigation: could add a folder-path-changed guard (same pattern as `TicketsPanelProvider._rearmTicketsViewWatcherIfFoldersChanged` at line 635-641), but not required for correctness.
- **`_setupDocsFolderWatcher` parameter:** Takes a workspace root string. In `_handleFetchRoots`, use `this._getWorkspaceRoot() || this._getWorkspaceRoots()[0]` — same pattern as `open()` line 946.
- **`_handleFetchRoots` call site:** The method is called only from `case 'fetchRoots'` at line 2659, which is the verb handler the webview sends on page load. Arming watchers here is equivalent to arming from the verb handler directly.

## Dependencies

- `feature_plan_20260819153323_fix-vscodeShim-createFileSystemWatcher-noop` — Fix no-op vscodeShim.createFileSystemWatcher. Must land together: plan 1 removes the bootstrap `watchFolder` override that `watchFolder` callers currently depend on, and adds the `RelativePattern` class that `watchFile` (Constitution watcher) requires to not crash.

## Adversarial Synthesis

Key risks: (1) Double-arming in VS Code — safe due to idempotent dispose-before-rearm pattern, minor waste only. (2) Config race actually fixed as side effect — `fetchRoots` arrives after async config load resolves. (3) Multiple `fetchRoots` calls re-arm wastefully — acceptable, could add a guard later. No blocking risks identified.

## Proposed Changes

### 1. Arm all Planning panel watchers from `_handleFetchRoots`

**File:** `src/services/PlanningPanelProvider.ts` (method `_handleFetchRoots`, lines 6039-6055)

```ts
// AFTER:
private async _handleFetchRoots(forceLocalDocs: boolean = false): Promise<any> {
    const localDocs = await this._sendLocalDocsReady(forceLocalDocs);
    const onlineDocs = await this._sendOnlineDocsReady();
    await this._sendPlanningHtmlDocsReady();
    const importedDocsRes = await this._handleFetchImportedDocs(this._getWorkspaceRoot() || '');

    // Arm file watchers. In VS Code these are also armed in open(), but
    // open() never runs in the standalone host — fetchRoots is the first
    // message the webview sends on page load (planning.js:9259), so this
    // is the standalone initialization path. Each _setup* method disposes
    // existing watchers before re-arming, so a double-call in VS Code is
    // safe. By this point LocalFolderService's async config load has
    // resolved, so getFolderPaths() returns the full configured set.
    this._setupDocsFolderWatcher(this._getWorkspaceRoot() || this._getWorkspaceRoots()[0]);
    this._setupLocalFolderWatchers();
    this._setupPlanningHtmlFolderWatchers();
    this._setupAntigravityWatcher();
    this._setupKanbanPlansWatcher();
    this._setupFeatureDocsWatcher();
    this._setupConstitutionWatcher();
    this._setupInsightsWatcher();

    const cyberAnimationDisabled = ...
    // ... rest unchanged
}
```

No other file changes needed. The webview already sends `fetchRoots` on page load (`planning.js:9259`), so no webview changes are required.

## Verification Plan

1. **Standalone — local folder docs:** Start standalone host. Add a `.md` file to a managed folder via terminal. Confirm it appears in the Docs sidebar within ~1 second (debounce) without any tab switching or manual refresh.

2. **Standalone — kanban plans:** Add a new plan file to `.switchboard/plans/`. Confirm it appears in the Kanban tab without manual refresh.

3. **Standalone — feature docs:** Add a new feature file to `.switchboard/features/`. Confirm the Features list updates.

4. **Standalone — constitution:** Edit a constitution file on disk. Confirm the Constitution tab live-updates. (Requires plan 1's shim fix for `watchFile`.)

5. **Standalone — insights:** Add a file to `.switchboard/insights/`. Confirm the Insights list updates.

6. **Standalone — Antigravity brain:** Add a `.md` file to the Antigravity brain directory. Confirm it appears in the Antigravity sessions section.

7. **Standalone — planning HTML folder:** Add an HTML file to a configured planning HTML folder. Confirm the HTML tab updates.

8. **VS Code regression:** Open the planning panel in VS Code. Confirm all watchers still fire correctly. Confirm no duplicate events (the dedup logic in each handler should suppress redundant refreshes).

9. **Multi-root workspaces:** Confirm watchers are armed for all workspace roots, not just the active one.

## Completion Report

Implemented file watcher arming for all 8 Planning panel watchers inside `PlanningPanelProvider._handleFetchRoots`. Made `_setupDocsFolderWatcher` idempotent by disposing previous watcher before re-arming, matching the rest of the watcher setup methods. Changed file: `src/services/PlanningPanelProvider.ts`. No issues encountered during implementation.
