# Re-register File Watchers on Workspace Folder Change

## Metadata
**Complexity:** 3
**Tags:** backend, bugfix

## Goal
Fix the Design Panel so that adding, removing, or reordering workspace folders correctly re-registers file system watchers and refreshes all local-folder-backed tabs (HTML Previews, Design System, Images, Briefs).

### Problem Context
When a user adds or removes a workspace folder while the Design Panel is open, the existing `onDidChangeWorkspaceFolders` handler posts a `workspaceItemsUpdated` message to the webview but **never disposes or re-creates the underlying `FileSystemWatcher` instances**. This means:
- Newly added workspace folders never get file watchers, so their local-folder trees stay empty until the panel is reopened.
- Removed workspace folders leave orphaned watchers that still fire events, wasting CPU and potentially crashing on disposed filesystem handles.
- Removed folders' files remain visible in the sidebar trees until the panel is reopened.

### Root Cause
The `onDidChangeWorkspaceFolders` handler at `@/Users/patrickvuleta/Documents/GitHub/switchboard/src/services/DesignPanelProvider.ts:119` only updates workspace items in the webview. It does not call `disposeWatchers()` or any `_setupXFolderWatchers()` methods. Each `_setupXFolderWatchers()` method only registers watchers for the current `_getWorkspaceRoots()`, so without being called again after a change, the watcher set becomes stale.

## User Review Required
No — this is a self-contained bugfix with no product-scope changes.

## Requirements

### Functional
1. On any workspace-folder change event, dispose all existing file watchers and re-register them for the new set of workspace roots.
2. After re-registering watchers, trigger a data refresh for all four local-folder tabs: HTML Previews, Design System, Images, Briefs.
3. Gracefully handle roots that no longer exist (e.g., removed workspace folder): `_getLocalFolderService(root)` may throw; catch and continue.
4. Do not duplicate the watcher-disposal logic that already exists inside `_setupHtmlFolderWatchers()`; normalize the pattern.

### Non-Functional
- Keep the change scoped to `DesignPanelProvider.ts`.
- No webview-side changes required; the existing `workspaceItemsUpdated` and `*DocsReady` message handlers already render correctly.
- Do not break the existing dispose-on-panel-close path (`disposeWatchers()` via `onDidDispose`).

## Complexity Audit

### Routine
- Extend the `onDidChangeWorkspaceFolders` handler to call `disposeWatchers()`, then `_setupHtmlFolderWatchers()`, `_setupDesignFolderWatchers()`, `_setupImagesFolderWatchers()`, `_setupBriefsFolderWatchers()`.
- After watcher re-registration, await `_sendHtmlDocsReady()`, `_sendDesignDocsReady()`, `_sendImagesDocsReady()`, `_sendBriefsDocsReady()`.
- Remove the redundant `disposeWatchers()` call inside `_setupHtmlFolderWatchers()` since the caller will now handle it.

### Complex / Risky
- `_setupHtmlFolderWatchers()` currently calls `disposeWatchers()` internally. If the handler also calls `disposeWatchers()`, we get a double-dispose on the html path (harmless but noisy). The fix is to remove `disposeWatchers()` from `_setupHtmlFolderWatchers()` and let the top-level lifecycle caller own disposal.
- `_sendXDocsReady()` are async and debounced; calling them sequentially may overlap but the debounce timer resets each call, so this is safe.

## Edge-Case & Dependency Audit

### Race Conditions
- Rapid workspace folder changes: the debounced `_sendXDocsReady()` calls may stack, but each debounce resets the 300ms timer. The worst case is a slightly delayed final refresh.
- Watcher event fire during re-registration: old watchers are disposed before new ones are created, so no double-fire.

### Security
- None. This is purely lifecycle management of existing watchers.

### Side Effects
- Normalizing all four `_setupXFolderWatchers()` to self-dispose means message handlers that call them in isolation (e.g., `addHtmlFolderPath`) will correctly replace only their own watchers instead of either over-killing (HTML) or leaking (Design, Images).

### Dependencies & Conflicts
- None external.
- `PlanningPanelProvider` already handles workspace changes correctly (`_ensureAdaptersRegistered()` + `_setupKanbanPlansWatcher()`). No conflict.

## Dependencies
- None

## Adversarial Synthesis
Key risks: (1) Removing `disposeWatchers()` from `_setupHtmlFolderWatchers()` without making the method self-dispose its own array would leak HTML watchers when message handlers (add/remove folder path) call it in isolation. (2) `_sendXDocsReady()` methods return immediately after scheduling debounced timers; the `await` in the workspace-change handler does not block on actual webview refresh. (3) Existing `_sendXDocsReady()` null-guard on `this._panel` prevents crashes during panel dispose, but rapid workspace changes during close could still schedule redundant timers. Mitigations: normalize all four `_setupXFolderWatchers()` to dispose only their own array; rely on existing panel-null guard; accept that debounce timer overlap is harmless.

## Proposed Changes

### src/services/DesignPanelProvider.ts

Context: The `open()` method initializes watchers and registers the workspace-change listener.

Logic & Implementation:
1. In `_setupHtmlFolderWatchers()` (line 267), replace the `this.disposeWatchers();` call at the top with:
   ```ts
   this._htmlFolderWatchers.forEach(w => w.dispose());
   this._htmlFolderWatchers = [];
   ```
2. In `_setupDesignFolderWatchers()` (line 288), add at the top (before `const roots = ...`):
   ```ts
   this._designFolderWatchers.forEach(w => w.dispose());
   this._designFolderWatchers = [];
   ```
3. In `_setupImagesFolderWatchers()` (line 412), add at the top (before `const roots = ...`):
   ```ts
   this._imagesFolderWatchers.forEach(w => w.dispose());
   this._imagesFolderWatchers = [];
   ```
4. `_setupBriefsFolderWatchers()` (line 484) already self-disposes its own array; no change required.
5. In the `onDidChangeWorkspaceFolders` handler (line 119), add after the existing `postMessage`:
   ```ts
   this.disposeWatchers();
   this._setupHtmlFolderWatchers();
   this._setupDesignFolderWatchers();
   this._setupImagesFolderWatchers();
   this._setupBriefsFolderWatchers();
   await this._sendHtmlDocsReady();
   await this._sendDesignDocsReady();
   await this._sendImagesDocsReady();
   await this._sendBriefsDocsReady();
   ```
   Make the lambda `async` to allow `await`. Note: `_sendXDocsReady()` methods return immediately after scheduling a 300ms debounce timer, so `await` does not block on actual webview refresh.

Edge Cases:
- Removed workspace root: `_getLocalFolderService(root)` throws; the `try/catch` inside each `_setupXFolderWatchers()` already swallows it.
- Empty workspace (all folders removed): `_getWorkspaceRoots()` returns `[]`; `disposeWatchers()` clears all arrays, then each setup method finds no roots and registers nothing. Sidebar trees empty via the subsequent `_sendXDocsReady()` calls.

## Verification Plan

### Manual Steps
1. Open Design Panel.
2. Add a workspace folder that contains HTML/design/images/briefs files → within a few seconds, the files appear in all four tabs.
3. Remove that workspace folder → within a few seconds, the files disappear from all four tabs.
4. Close the Design Panel → no watcher leaks (verify via `disposeWatchers` on panel dispose).

### Automated Tests
- Session directive: **Skip compilation and automated tests** for this plan. The test suite will be run separately by the user.
- Suggested regression test: Add a unit test in `DesignPanelProvider` tests that simulates `onDidChangeWorkspaceFolders`, asserts that old watcher instances are disposed, and asserts that new watcher instances are created per current workspace roots. Verify that `_sendXDocsReady()` is invoked for all four tabs.

## Recommendation

**Send to Intern** — Complexity 3. Single-file change with localized lifecycle logic. All patterns are pre-existing; no architectural invention required.

## Review Findings

Implementation matches plan exactly. One file changed: `src/services/DesignPanelProvider.ts` (committed in `331d2a9`). All four `_setupXFolderWatchers()` methods now self-dispose, the `onDidChangeWorkspaceFolders` handler disposes and re-registers all watchers then triggers refreshes for all four tabs, and isolated message handlers no longer over-kill cross-tab watchers. No CRITICAL or MAJOR issues found; three NIT-level items deferred (outer try/catch, redundant `_updateWebviewRoots` calls, DRY extraction). Compilation and tests skipped per plan directive.
