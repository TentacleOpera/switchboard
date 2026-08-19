# Arm Design Panel Watchers in Standalone Host

## Goal

The Design panel has 5 file watchers. 4 of them are only armed from `open()` — the VS Code webview-panel opening path that standalone never calls. The 5th (`_setupStitchHtmlFolderWatchers`) is armed from verb handlers (`stitchHtmlListDocs` / `fetchPreview`) that do run in standalone, but depends on the shim fix from plan 1. In the standalone host, the 4 primary watchers are never armed, so new/changed/deleted files in HTML folders, Claude folders, Design folders, and Images folders are never detected.

### Problem Analysis & Root Cause

`DesignPanelProvider.open()` (lines 733-736) calls all 4 primary watcher setups:

```ts
this._setupHtmlFolderWatchers();
this._setupClaudeFolderWatchers();
this._setupDesignFolderWatchers();
this._setupImagesFolderWatchers();
```

The 5th watcher (`_setupStitchHtmlFolderWatchers`) is armed from a verb handler (`stitchHtmlListDocs` / `fetchPreview` for the Stitch HTML tab), so it does run in standalone — but it depends on `_seams().watcher.watchFolder` which was a no-op before plan 1's shim fix.

In standalone, `open()` is never called. The bootstrap injects `_hostSeams` and `_broadcaster` directly (`bootstrap.ts:855-856`), bypassing `open()` entirely.

The Design panel has a `ready` verb handler (`DesignPanelProvider.ts:2515-2558`) that runs in both hosts — it's the equivalent of Planning's `fetchRoots`. It sends initial doc data but does **not** arm watchers. The `refreshDocsForTab` verb (`line 3972`) only re-sends doc data, not watchers.

The 5 watchers and their seam methods:

| Watcher | Method | Seam call | Native fallback? |
|---------|--------|-----------|-----------------|
| HTML folder | `_setupHtmlFolderWatchers` | `watchFolder` | Yes (`_setupNativeFolderWatchFallback`) |
| Claude folder | `_setupClaudeFolderWatchers` | `watchFolder` | Yes |
| Design folder | `_setupDesignFolderWatchers` | `watchFolder` | Yes |
| Images folder | `_setupImagesFolderWatchers` | `watchFolder` | No |
| Stitch HTML | `_setupStitchHtmlFolderWatchers` | `watchFolder` | Yes |

Note: 3 of the 4 primary watchers have a native `fs.watch` fallback (`_setupNativeFolderWatchFallback`, lines 1011-1065). But that fallback is called from within the `_setup*Watchers` methods, which themselves only run from `open()`. So the native fallback never runs in standalone either.

**Dependency:** This plan depends on plan 1 (fix the no-op shim). Without the shim fix, `watchFolder` remains a no-op (the bootstrap override is removed in plan 1). The native `fs.watch` fallbacks would work independently of the shim, but only if the `_setup*Watchers` methods are actually called — which is what this plan does. Additionally, plan 1 adds the `RelativePattern` class to the shim, which is required for `VscodeHostFileWatcher.watchFolder` to not crash on `new vscode.RelativePattern(...)`.

## Metadata

**Complexity:** 3
**Tags:** backend, bugfix, reliability
**Project:** Browser Switchboard

## User Review Required

No user decision needed. The fix adds existing watcher-setup method calls to an existing verb handler that runs in both hosts. All methods are already idempotent and called from multiple sites.

## Complexity Audit (Routine vs Complex/Risky)

**Routine.** Same pattern as plan 2 (Planning panel): add watcher setup calls to an existing verb handler that runs in both hosts. All `_setup*Watchers` methods already exist, are idempotent, and are called from multiple sites already (e.g., `addHtmlFolder` calls `_setupHtmlFolderWatchers` at line 3897).

### Complex / Risky
- None

## Edge-Case & Dependency Audit

- **Double-arming in VS Code:** `open()` arms the watchers, then `ready` would arm them again. Safe — all `_setup*Watchers` methods dispose existing watchers first. The native `fs.watch` fallbacks also dispose existing native watchers before re-arming (each method clears its `_*NativeWatchers` array).
- **`_setupStitchHtmlFolderWatchers` is async:** It returns `Promise<void>`. The `ready` handler is already async, so it can be awaited. However, it depends on `_activeStitchHtmlProjectId` and `_activeStitchHtmlWorkspaceRoot` being set, which only happens when the user selects a Stitch project. Calling it from `ready` before a project is selected will return early (line 1101-1102: `if (!projectId || !workspaceRoot) return`). This is correct — the watcher is armed later when the user picks a project (via the `fetchPreview` verb handler at line 2772).
- **`disposeWatchers` method:** The `onDidChangeWorkspaceFolders` handler at line 745 calls `this.disposeWatchers()` before re-arming. This handler is only registered in `open()`, so in standalone it is never registered. This is acceptable — standalone workspace folders are set at bootstrap and do not change dynamically. The `ready`-path arming doesn't need to dispose first because each `_setup*Watchers` method does its own disposal.
- **`_setupImagesFolderWatchers` has no native fallback:** Unlike the other 3, it doesn't call `_setupNativeFolderWatchFallback`. It relies entirely on `this._seams().watcher.watchFolder` (line 1493). After plan 1's shim fix, this will work. Before plan 1, it would be a no-op even if armed.

## Dependencies

- `feature_plan_20260819153323_fix-vscodeShim-createFileSystemWatcher-noop` — Fix no-op vscodeShim.createFileSystemWatcher. Must land together: plan 1 removes the bootstrap `watchFolder` override, adds the `RelativePattern` class (required for `VscodeHostFileWatcher.watchFolder` to not crash), and makes `createFileSystemWatcher` real. Without plan 1, arming the watchers would either crash (`RelativePattern` undefined) or produce silent no-ops (`createFileSystemWatcher` stub).

## Adversarial Synthesis

Key risks: (1) Double-arming in VS Code — safe due to idempotent dispose-before-rearm pattern. (2) `_setupImagesFolderWatchers` has no native fallback — entirely dependent on plan 1's shim fix, which is the dependency. (3) `onDidChangeWorkspaceFolders` not registered in standalone — acceptable, standalone workspace folders are static. (4) Stitch HTML watcher not armed from `ready` — correct, it requires an active project ID and is armed on project selection. No blocking risks identified.

## Proposed Changes

### 1. Arm Design panel watchers from the `ready` verb handler

**File:** `src/services/DesignPanelProvider.ts` (case `'ready'`, lines 2515-2558)

Add watcher setup calls after the initial doc sends, before the return:

```ts
case 'ready': {
    const allRoots = this._getWorkspaceRoots();
    const items = buildWorkspaceItems(allRoots);
    // ... existing state restore code ...

    const htmlDocs = await this._sendHtmlDocsReady();
    const claudeDocs = await this._sendClaudeDocsReady();
    const designDocs = await this._sendDesignDocsReady();
    const imagesDocs = await this._sendImagesDocsReady();
    await this._sendActiveDesignDocState();

    // Arm file watchers. In VS Code these are also armed in open(), but
    // open() never runs in the standalone host — 'ready' is the first
    // verb the webview sends on page load, so this is the standalone
    // initialization path. Each _setup* method disposes existing
    // watchers before re-arming, so a double-call in VS Code is safe.
    this._setupHtmlFolderWatchers();
    this._setupClaudeFolderWatchers();
    this._setupDesignFolderWatchers();
    this._setupImagesFolderWatchers();
    // Stitch HTML watcher is armed on project selection, not here —
    // _setupStitchHtmlFolderWatchers requires an active project ID.

    return { success: true, type: 'designReadyComplete', items, statePayload, htmlDocs, claudeDocs, designDocs, imagesDocs };
}
```

No webview changes needed — `design.js` already sends `ready` on page load.

## Verification Plan

1. **Standalone — HTML folder:** Start standalone host. Add an HTML file to a configured HTML folder. Confirm the HTML Previews tab updates without manual refresh.

2. **Standalone — Claude folder:** Add a file to a configured Claude folder. Confirm the Claude tab updates.

3. **Standalone — Design folder:** Add a file to a configured Design folder. Confirm the Design System tab updates.

4. **Standalone — Images folder:** Add an image file to a configured Images folder. Confirm the Images tab updates. (Requires plan 1's shim fix — no native fallback on this watcher.)

5. **Standalone — Stitch HTML:** Select a Stitch project. Add a file to the project's cache directory. Confirm the Stitch HTML tab updates. (This watcher is armed from the project-selection path, not from `ready` — but it depends on the shim fix.)

6. **VS Code regression:** Open the Design panel in VS Code. Confirm all watchers still fire. Confirm no duplicate events from double-arming.

7. **Auto-refresh preview:** With a file open in the HTML preview pane, modify it on disk. Confirm the preview auto-refreshes (the `_autoRefreshHtmlPreview` callback in each watcher should fire).
