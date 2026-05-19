# Fix: Research docs saved to local folder not appearing in Local Docs tab

## Goal
When research results are saved to the configured local docs folder via the Research tab, they should automatically appear in the Local Docs tab. Currently, saved research docs are not visible until the user manually refreshes the local docs list, and the wrong folder path is sent to the webview, causing research prompts to reference the workspace root instead of the configured local folder.

## Metadata
- **Tags:** bugfix, reliability, workflow
- **Complexity:** 5

## User Review Required
No

## Complexity Audit
### Routine
- Fix `_sendLocalDocsReady()` to send the actual configured folder path instead of `allRoots[0]` (single-line change at line 1076, with a `configuredFolderPath` accumulator added to the loop at lines 1047-1066)
- Add `_localFolderWatcher` private field (line ~44, alongside existing `_docsFolderWatcher`)
- Add `_setupLocalFolderWatcher()` method modeled on `_setupDocsFolderWatcher()` (lines 284-307)
- Call `_setupLocalFolderWatcher(workspaceRoot)` in `open()` after line 278
- Call `_setupLocalFolderWatcher(workspaceRoot)` in `browseLocalFolder` handler (after line 535) and `setLocalFolderPath` handler (after line 548)
- Fix `_handleSetActivePlanningContext()` to use `LocalFolderService.getFolderPath()` instead of the wrong config key `planning.localFolderPath` (line 888)
- Dispose watcher in `dispose()` method (line ~2021, before `_disposables.forEach`)

### Complex / Risky
- The watcher glob pattern must use `**/*.{md,txt,markdown,rst,adoc}` (not just `*.md`) because `LocalFolderService.listFiles()` recursively scans subdirectories up to depth 10 and supports 5 file extensions — a flat `*.md` pattern would miss files in subdirectories and non-md text files
- The local docs folder path is user-configurable and may be outside the workspace root, which requires using `vscode.Uri.file()` with the absolute path for `RelativePattern` (same pattern as `_setupDocsFolderWatcher` at line 288)
- When the folder path changes at runtime, the old watcher must be disposed before creating a new one to avoid leaked watchers — the `_setupLocalFolderWatcher()` method handles this by disposing the existing watcher at the top, but old disposed watchers accumulate in `_disposables` (harmless but untidy; same pattern as existing `_docsFolderWatcher`)
- `_handleSetActivePlanningContext()` at line 888 reads `planning.localFolderPath` which is NOT a registered VS Code setting (confirmed: not in `package.json`). The correct setting is `research.localFolderPath` (registered at `package.json` line 343, read by `LocalFolderService.getFolderPath()` at line 65). This means "Set as Active Planning Context" for local-folder docs silently fails today

## Edge-Case & Dependency Audit
- **Race Conditions**: The watcher's `refreshLocalDocs` callback calls `_sendLocalDocsReady()` without debouncing. If multiple files are created/deleted rapidly (e.g., bulk save), multiple refresh calls will fire. This is consistent with the existing `_docsFolderWatcher` pattern (lines 296-304) which also has no debounce. Low risk since `_sendLocalDocsReady()` is idempotent and the webview handles duplicate `localDocsReady` messages gracefully.
- **Security**: The local folder path is already validated by `LocalFolderService` before use. `LocalFolderService.deleteFile()` has path-traversal protection (lines 155-158). The watcher only triggers a refresh — it does not expose file contents.
- **Side Effects**: Adding a watcher increases resource usage by one `FileSystemWatcher` per configured folder. This is acceptable (same cost as the existing `_docsFolderWatcher`). The watcher is only created when a folder path is configured, so no overhead when unconfigured.
- **Dependencies & Conflicts**: The `LocalFolderService` constructor creates a new instance per call (`_getLocalFolderService` at line 1026-1028 always returns `new LocalFolderService(workspaceRoot)`). This is an existing pattern — no state inconsistency risk since `LocalFolderService` reads config fresh each time via `getFolderPath()`.

## Dependencies
None

## Adversarial Synthesis
The plan correctly identifies two root causes but misses a third: `_handleSetActivePlanningContext()` uses the unregistered config key `planning.localFolderPath` instead of `research.localFolderPath`, causing "Set as Active Planning Context" to silently fail for local-folder docs. The proposed watcher glob `*.md` is too narrow — it must be `**/*.{md,txt,markdown,rst,adoc}` to match the recursive scan and multi-extension support in `LocalFolderService`. Disposal is partially redundant since `_disposables` already handles cleanup, but explicit disposal in `dispose()` is a safe belt-and-suspenders approach. The lack of debounce on watcher callbacks mirrors the existing pattern and is acceptable for idempotent refresh operations.

## Root Cause Analysis

### Issue 1: No file watcher for configured local folder
The Planning Panel has a file system watcher for `.switchboard/docs` directory (lines 284-307 in PlanningPanelProvider.ts) that refreshes the imported docs list when files change. However, there is no equivalent watcher for the user-configured local docs folder (stored in `switchboard.research.localFolderPath`). When the agent saves research results to this folder as instructed by the Research tab prompt, the Local Docs tab does not automatically refresh to show the new file.

### Issue 2: Wrong folder path sent to webview
In `_sendLocalDocsReady()` (line 1076 in PlanningPanelProvider.ts), the `folderPath` sent to the webview is set to `allRoots[0] || ''` (the workspace root), NOT the actual configured local folder path. This causes the research prompt generation to use the workspace root as the save location instead of the configured local folder. When the agent receives the placeholder `[CONFIGURE LOCAL DOCS FOLDER]` (because `state.localFolderPath` is set to the workspace root instead of the actual configured path), it may interpret this as the current directory and save to the repo root.

### Issue 3: Wrong config key in _handleSetActivePlanningContext (discovered during review)
In `_handleSetActivePlanningContext()` (line 888), the code reads `switchboard.planning.localFolderPath` — but this config key does NOT exist in `package.json`. The registered setting is `switchboard.research.localFolderPath` (package.json line 343). `LocalFolderService.getFolderPath()` correctly reads `research.localFolderPath` (LocalFolderService.ts line 65). As a result, when a user clicks "Set as Active Planning Context" on a local-folder doc, `folderPath` is always `undefined`, `docPath` is always `null`, and the operation silently fails with "Document not found".

## Proposed Changes

### `src/services/PlanningPanelProvider.ts`

**Context/Implementation:**

**Fix 1: Send correct folder path to webview**

1. In `_sendLocalDocsReady()` (around line 1076), replace the line that sends `allRoots[0]` as the folderPath with the actual configured local folder path. The method already retrieves the folderPath from `localFolderService.getFolderPath()` at line 1050, so we need to capture and send this value:

```typescript
private async _sendLocalDocsReady(): Promise<void> {
    try {
        const allRoots = this._getWorkspaceRoots();
        const allFiles: Array<{ id: string; name: string; relativePath: string; isFolder?: boolean; parentId?: string; _root?: string }> = [];
        const scannedPaths = new Set<string>();
        let configuredFolderPath: string | null = null; // Track the configured local folder path

        for (const root of allRoots) {
            try {
                const localFolderService = this._getLocalFolderService(root);
                const folderPath = localFolderService.getFolderPath();

                if (folderPath && scannedPaths.has(folderPath)) {
                    continue;
                }
                if (folderPath) {
                    scannedPaths.add(folderPath);
                    // Capture the first configured folder path to send to webview
                    if (!configuredFolderPath) {
                        configuredFolderPath = folderPath;
                    }
                }

                const files = await localFolderService.listFiles();
                // Tag files with their root for potential UI disambiguation
                allFiles.push(...files.map(f => ({ ...f, _root: root })));
            } catch (err) {
                // Log but continue — one bad root shouldn't break others
                console.debug('[PlanningPanel] Failed to list files for root:', root, err);
            }
        }

        if (!this._panel) {
            throw new Error('[PlanningPanel] _panel is undefined — cannot send localDocsReady');
        }

        console.log('[PlanningPanel] Sending localDocsReady, total nodes count:', allFiles.length);
        this._panel.webview.postMessage({
            type: 'localDocsReady',
            sourceId: 'local-folder',
            folderPath: configuredFolderPath || '', // Send actual configured folder path, not workspace root
            nodes: this._mapLocalFilesToTreeNodes(allFiles)
        });
    } catch (err) {
        console.error('[PlanningPanel] Failed to fetch local-folder roots:', err);
        this._panel?.webview.postMessage({
            type: 'localDocsReady',
            sourceId: 'local-folder',
            folderPath: '',
            nodes: [],
            error: String(err)
        });
    }
}
```

**Fix 2: Add file watcher for configured local folder**

2. Add a new private field for the local folder watcher (insert near line 44, alongside `_docsFolderWatcher`):
```typescript
private _localFolderWatcher: vscode.FileSystemWatcher | undefined;
```

3. Create a new method `_setupLocalFolderWatcher()` similar to `_setupDocsFolderWatcher()` (lines 284-307). **Important**: Use `**/*.{md,txt,markdown,rst,adoc}` as the glob pattern (not `*.md`) because `LocalFolderService.listFiles()` recursively scans subdirectories and supports 5 file extensions:

```typescript
private _setupLocalFolderWatcher(workspaceRoot: string | undefined): void {
    // Dispose existing watcher if present
    if (this._localFolderWatcher) {
        this._localFolderWatcher.dispose();
        this._localFolderWatcher = undefined;
    }

    if (!workspaceRoot) return;

    const localFolderService = this._getLocalFolderService(workspaceRoot);
    const folderPath = localFolderService.getFolderPath();
    
    if (!folderPath) return;

    const folderUri = vscode.Uri.file(folderPath);

    // Create watcher for the local docs folder — recursive, all supported text extensions
    this._localFolderWatcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(folderUri, '**/*.{md,txt,markdown,rst,adoc}')
    );

    // Refresh local docs when files are created, deleted, or changed
    const refreshLocalDocs = () => {
        this._sendLocalDocsReady();
    };

    this._localFolderWatcher.onDidCreate(refreshLocalDocs);
    this._localFolderWatcher.onDidDelete(refreshLocalDocs);
    this._localFolderWatcher.onDidChange(refreshLocalDocs);

    this._disposables.push(this._localFolderWatcher);
}
```

4. Call `_setupLocalFolderWatcher()` in the `open()` method after `_setupDocsFolderWatcher()` (after line 278):
```typescript
// After line 278: this._setupDocsFolderWatcher(workspaceRoot);
this._setupLocalFolderWatcher(workspaceRoot);
```

5. Update the `browseLocalFolder` message handler (lines 518-536) to recreate the watcher when the folder path changes:
```typescript
case 'browseLocalFolder': {
    const result = await vscode.window.showOpenDialog({
        openLabel: 'Select Planning Folder',
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false
    });
    if (result && result.length > 0) {
        const service = this._getLocalFolderService(workspaceRoot);
        const folderPath = await service.setFolderPath(result[0].fsPath);
        const files = await service.listFiles();
        const nodes = this._mapLocalFilesToTreeNodes(files);
        this._panel?.webview.postMessage({
            type: 'localFolderPathUpdated',
            folderPath,
            nodes
        });
        // Recreate watcher for new folder path
        this._setupLocalFolderWatcher(workspaceRoot);
    }
    break;
}
```

6. Update the `setLocalFolderPath` message handler (lines 538-548) to recreate the watcher:
```typescript
case 'setLocalFolderPath': {
    const service = this._getLocalFolderService(workspaceRoot);
    const folderPath = await service.setFolderPath(msg.folderPath || '');
    const files = await service.listFiles();
    const nodes = this._mapLocalFilesToTreeNodes(files);
    this._panel?.webview.postMessage({
        type: 'localFolderPathUpdated',
        folderPath,
        nodes
    });
    // Recreate watcher for new folder path
    this._setupLocalFolderWatcher(workspaceRoot);
    break;
}
```

7. Dispose the watcher in the `dispose()` method (add before line 2021 `this._disposables.forEach(d => d.dispose())`):
```typescript
if (this._localFolderWatcher) {
    this._localFolderWatcher.dispose();
}
```
Note: This is technically redundant since `_localFolderWatcher` is also pushed to `_disposables`, but provides belt-and-suspenders safety consistent with how `_activeDocWatcher` is handled at line 2017-2019.

**Fix 3: Fix wrong config key in _handleSetActivePlanningContext**

8. In `_handleSetActivePlanningContext()` (line 888), replace the direct config read of the wrong key `planning.localFolderPath` with a call to `LocalFolderService.getFolderPath()`, which correctly reads `research.localFolderPath`:

Change line 888 from:
```typescript
const folderPath = vscode.workspace.getConfiguration('switchboard').get<string>('planning.localFolderPath');
```
To:
```typescript
const localFolderService = this._getLocalFolderService(workspaceRoot);
const folderPath = localFolderService.getFolderPath();
```

This ensures the method reads the same config key and applies the same path resolution (tilde expansion, relative-to-workspace resolution) as all other local-folder operations.

**Edge Cases:**
- **No folder configured**: `_setupLocalFolderWatcher()` returns early if `folderPath` is empty (line `if (!folderPath) return;`). No watcher created, no errors.
- **Folder deleted externally**: The watcher will fire `onDidDelete` for files inside, triggering a refresh that returns an empty list. If the folder itself is deleted, VS Code's watcher handles this gracefully (no crash, refresh returns empty).
- **Folder path changed at runtime**: `_setupLocalFolderWatcher()` disposes the old watcher before creating a new one. The old watcher instance remains in `_disposables` but is already disposed — harmless.
- **Multi-root workspace**: The watcher is created for the first root's configured folder only (same limitation as `_setupDocsFolderWatcher`). In multi-root setups, each root could have a different local folder path, but the current architecture only watches one. This is an existing limitation, not introduced by this change.

## Verification Plan

### Automated Tests
- N/A (VS Code extension file watcher testing requires manual verification or integration test harness)

### Manual Testing
**Test Fix 1 (Correct folder path sent to webview):**
1. Open the Planning webview and navigate to the Local Docs tab
2. Configure a local docs folder (or use an existing one)
3. Navigate to the Research tab
4. Enable "Save research results locally"
5. Copy the research prompt and inspect it
6. **Expected**: The prompt should contain the actual configured local folder path (e.g., `/Users/username/Documents/research`), NOT the workspace root or `[CONFIGURE LOCAL DOCS FOLDER]`
7. **Verify**: If no local folder is configured, the prompt should contain `[CONFIGURE LOCAL DOCS FOLDER]` placeholder with a note to configure it

**Test Fix 2 (File watcher for local folder):**
1. Open the Planning webview and navigate to the Local Docs tab
2. Configure a local docs folder (or use an existing one)
3. Navigate to the Research tab
4. Enable "Save research results locally"
5. Generate a research prompt and run it (or manually create a .md file in the configured local folder)
6. Switch back to the Local Docs tab
7. **Expected**: The newly created research file should appear in the local docs list without manual refresh
8. **Verify**: Delete the file from the local docs tab - it should be removed from the list
9. **Verify**: Change the local docs folder configuration - the watcher should be updated to watch the new folder
10. **Verify**: If no local folder is configured, no watcher should be created (no errors)
11. **Verify**: Create a `.txt` or `.rst` file in a subdirectory of the configured folder — it should appear in the local docs list (tests recursive + multi-extension watcher)

**Test Fix 3 (Set as Active Planning Context for local-folder docs):**
1. Open the Planning webview and navigate to the Local Docs tab
2. Configure a local docs folder with at least one document
3. Right-click a local-folder document and select "Set as Active Planning Context"
4. **Expected**: The active planning context banner should update to show the document name
5. **Verify**: The `switchboard.planner.designDocLink` config should point to the actual file path inside the configured local folder

**Test Combined (End-to-end):**
1. Configure a local docs folder
2. Generate a research prompt with "Save research results locally" enabled
3. Run the research (or manually create a file in the configured folder)
4. **Expected**: The file should be saved to the configured local folder (NOT the repo root)
5. **Expected**: The file should appear in the Local Docs tab automatically (without manual refresh)

**Recommendation:** Send to Coder
