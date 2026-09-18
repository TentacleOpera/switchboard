# Multiple Docs Folders Support

## Goal
Extend the Local Docs tab in the ARTIFACTS panel to support multiple local folder paths, replacing the single `research.localFolderPath` string setting with a `research.localFolderPaths` array, and providing UI controls to add/remove folders with a unified tree view.

## Metadata
- **Tags:** frontend, backend, UI, UX
- **Complexity:** 6

## User Review Required

> [!IMPORTANT]
> **Source-folder required in all messages**: Each file returned by `listFiles()` includes its absolute `sourceFolder`. This must be included in all downstream webview messages (`fetchPreview`, `deleteLocalDoc`, `appendToPlannerPrompt`, `setActivePlanningContext`, `linkToDocument`). If `sourceFolder` is absent, the backend must return a hard error — no silent fallback to the first configured path.

> [!CAUTION]
> **Pre-existing persistence bug (confirmed, fix included in Phase 0)**: `getFolderPath()` and `setFolderPath()` call `vscode.workspace.getConfiguration('switchboard')` **without a resource URI**. Because `switchboard.research.localFolderPath` has `"scope": "resource"` in `package.json`, VS Code requires a resource URI to correctly resolve workspace-level values — without it, it falls back to the global/default (empty string). This means the path is correctly written to `.vscode/settings.json` on Browse, but is **silently read back as `''`** on every subsequent `fetchRoots` call (i.e., every panel open/reopen). The fix is to pass `vscode.Uri.file(this._workspaceRoot)` as the resource argument to `getConfiguration()` in both methods. This bug is fixed in **Phase 0** below and applies to both the old single-path setting and the new array setting.

## Complexity Audit

### Routine
- Adding `getFolderPaths()`, `addFolderPath()`, `removeFolderPath()` methods to `LocalFolderService`
- Replacing `package.json` settings schema entry with the new array setting
- Adding Add/Remove folder UI buttons and folder list to `planning.html`
- Calling `_setupLocalFolderWatchers()` after add/remove
- Updating the research prompt generator to reference all configured paths

### Complex / Risky
- **Source-folder disambiguation**: `docId` (relative path) alone is ambiguous across multiple folders. The `id` field in `listFiles()` results must be scoped per source folder, and `sourceFolder` must be threaded through all downstream handlers.
- **`deleteFile()` path resolution**: Must be updated to accept a `sourceFolder` parameter; the current implementation always resolves against a single `getFolderPath()`.
- **Watcher lifecycle during dynamic add/remove**: Adding a folder calls `_setupLocalFolderWatchers()`, which disposes **all** existing watchers and recreates them. During the disposal/creation window, file change events may be missed.

## Edge-Case & Dependency Audit

### Race Conditions
- `_sendLocalDocsReady()` and `_setupLocalFolderWatchers()` both iterate `getFolderPaths()`. If a folder is added while a scan is in-flight, the scan may not include the new folder. This is acceptable (the subsequent watcher-triggered refresh will catch it).
- Multiple rapid `addFolderPath`/`removeFolderPath` calls could interleave VS Code config writes. Mitigation: VS Code config updates are serialized by the extension host; no additional locking needed.

### Security
- Path traversal in `deleteFile()` and `fetchDocContent()` must be re-verified against the specific `sourceFolder`. The existing check `resolved.startsWith(path.resolve(folderPath))` must be applied against the provided `sourceFolder`, not the first configured path.
- `sourceFolder` values arriving from the webview must be validated server-side against the configured `getFolderPaths()` list. If the value is absent or not in the list, return a hard error.

### Side Effects
- The `handleLocalFolderPathUpdated` message handler in `planning.js` currently updates a single `pathInput` element. Post-migration this handler becomes the `addFolder` / `removeFolder` response and must re-render the full folder list.
- `state.localFolderPath` (single string) in `planning.js` must be replaced with `state.localFolderPaths` (array). The research prompt generator references `state.localFolderPath` at line 1736 — this must be updated to join all paths or show the primary path.

### Dependencies & Conflicts
- `_handleFetchPreview` (line 1257): Uses `localFolderService.getFolderPath()`. Must accept `sourceFolder` from message.
- `_handleSetActivePlanningContext` (line 929): Uses `localFolderService.getFolderPath()`. Same fix needed.
- `_handleLinkToDocument` (line 985): Same pattern. Same fix needed.
- `deleteLocalDoc` case (line 769): Passes `workspaceRoot` to `_getLocalFolderService()`, then calls `deleteFile(docId)`. Must pass `sourceFolder` instead.
- `_sendLocalDocsReady()` (line 1139): Already iterates workspace roots but calls `getFolderPath()` per root. Must call `getFolderPaths()` per root and scan all paths, adding deduplication across multiple roots × multiple paths.

## Dependencies
- None (self-contained feature; no cross-plan dependencies identified)

## Adversarial Synthesis
Key risks: (1) `docId` ambiguity — relative paths are not unique across multiple source folders, so `sourceFolder` must be embedded in every file tree node's `id` or passed as a separate field in all webview↔extension messages; (2) `deleteFile()`, `fetchDocContent()`, `_handleFetchPreview`, and two context-setting handlers all resolve paths against a single folder and all require the same `sourceFolder` threading fix; (3) the config migration from string to array must be idempotent and workspace-scope-only (or explicitly extended to global scope after user decision). Mitigations: encode `sourceFolder` in the node `id` as a stable prefix, validate all incoming `sourceFolder` values server-side against the configured list, and gate migration behind a check for whether `localFolderPaths` already exists.

## Proposed Changes

---

### Phase 0 — Bug Fix: Resource-scoped `getConfiguration()` (addresses persistence bug)

**Root cause**: `LocalFolderService.getFolderPath()` and `setFolderPath()` both call `vscode.workspace.getConfiguration('switchboard')` without passing a resource URI. The `switchboard.research.localFolderPath` setting has `"scope": "resource"` in `package.json`. VS Code resolves resource-scoped settings relative to a specific resource; without one, it returns the global/default value (empty string). The configured path in `.vscode/settings.json` is therefore never read on panel reopen.

**Fix — `src/services/LocalFolderService.ts`**:

In both `getFolderPath()` and `setFolderPath()`, pass the workspace root as a resource URI:

```typescript
// BEFORE:
const config = vscode.workspace.getConfiguration('switchboard');

// AFTER:
const config = vscode.workspace.getConfiguration('switchboard', vscode.Uri.file(this._workspaceRoot));
```

Apply this change to:
- `getFolderPath()` (line 63–67)
- `setFolderPath()` (line 69–75)

The same fix must be applied to the new `getFolderPaths()`, `addFolderPath()`, and `removeFolderPath()` methods introduced in Phase 1 — all must use `vscode.workspace.getConfiguration('switchboard', vscode.Uri.file(this._workspaceRoot))`.

**Scope**: This is a standalone fix that can be shipped independently of the multi-folder feature. The multi-folder work (Phases 1–4) builds on top of it.

---

### `package.json`
**Context**: The VS Code contribution schema defines the settings users configure.

**Implementation**:
- **Replace** the existing `switchboard.research.localFolderPath` (string) entry with `switchboard.research.localFolderPaths` (array). The old setting has never been released, so no migration or deprecation notice is needed.

```json
// REPLACE the localFolderPath block with:
"switchboard.research.localFolderPaths": {
  "type": "array",
  "items": { "type": "string" },
  "default": [],
  "description": "Paths to local folders containing research files (.md, .txt, .markdown, .rst, .adoc). Paths may be absolute or relative to the workspace root, and support ~ for home directory.",
  "scope": "resource"
}
```

---

### `src/services/LocalFolderService.ts`

**Context**: Core service for all local folder operations. Currently single-folder only.

**Phase 1 — New Methods**:

- **`getFolderPaths(): string[]`** — reads `research.localFolderPaths` (array). Returns resolved absolute paths, deduplicating and filtering out empty strings. This is synchronous (no migration needed).
- **`getFolderPath(): string`** — keep for internal use where only one path is needed; returns `getFolderPaths()[0] ?? ''`.
- **`addFolderPath(folderPath: string): Promise<void>`** — resolves the path, deduplicates against current list, appends to `research.localFolderPaths`, saves.
- **`removeFolderPath(folderPath: string): Promise<void>`** — removes a matching resolved path from `research.localFolderPaths`, saves.

> [!IMPORTANT]
> All `getConfiguration()` calls in this service **must** pass `vscode.Uri.file(this._workspaceRoot)` as the resource argument (Phase 0 fix). Omitting it silently reads the global/default value instead of the workspace setting.

```typescript
getFolderPaths(): string[] {
    const config = vscode.workspace.getConfiguration('switchboard', vscode.Uri.file(this._workspaceRoot));
    const paths = config.get<string[]>('research.localFolderPaths', []);
    const seen = new Set<string>();
    return paths
        .map(p => this.resolveFolderPath(p))
        .filter(p => p && !seen.has(p) && seen.add(p) as unknown as boolean);
}
```

**Phase 2 — Multi-Folder `listFiles()`**:

Update `listFiles()` return type to include `sourceFolder`:
```typescript
async listFiles(): Promise<Array<{
    id: string;
    name: string;
    relativePath: string;
    isFolder?: boolean;
    parentId?: string;
    sourceFolder: string;   // absolute path of the root folder this file belongs to
}>>
```

Implementation:
- Call `getFolderPaths()` to get all configured folders.
- For each folder: validate it exists, call `_scanFolder()`, tag each result with `sourceFolder: folderPath`.
- **Disambiguation**: prefix the `id` with the folder index or a stable hash to prevent collision. Recommended: `id = `${folderIndex}:${relativePath}`` so the webview can always resolve back to the correct root without sending the full absolute path.
- Deduplicate: if the same absolute `relativePath` appears in two folders, first folder wins (skip subsequent).

**`fetchDocContent(relativePath: string, sourceFolder: string)`**:
- `sourceFolder` is now **required**. If absent or not in `getFolderPaths()`, return `{ success: false, error: 'sourceFolder is required and must be a configured folder path' }`.
- The path traversal check must be applied against the provided `sourceFolder`.

**`deleteFile(relativePath: string, sourceFolder: string)`**:
- `sourceFolder` is now **required**. Same validation and traversal check as `fetchDocContent`.

---

### `src/services/PlanningPanelProvider.ts`

**`_setupLocalFolderWatchers()` (line 311)**:
- Replace `localFolderService.getFolderPath()` with `localFolderService.getFolderPaths()` (loop over all paths per root).
- The existing deduplication set (`watchedPaths`) already handles duplicates across roots.

**`_sendLocalDocsReady()` (line 1139)**:
- Replace `localFolderService.getFolderPath()` call with `localFolderService.getFolderPaths()`.
- Iterate over all paths per root, deduplicate across roots.
- `configuredFolderPath` (sent to webview) becomes `configuredFolderPaths: string[]`.

**`_handleFetchPreview()` (line 1257)**:
- Read `msg.sourceFolder` (**required** for `local-folder` source). Pass to `localFolderService.fetchDocContent(docId, msg.sourceFolder)`.
- If `msg.sourceFolder` is absent, post `previewError` with message `'sourceFolder is required'` — no fallback.

**`_handleSetActivePlanningContext()` (line 929)**:
- Read `msg.sourceFolder` (**required**). Validate against `getFolderPaths()`. Hard error if missing or invalid.

**`_handleLinkToDocument()` (line 985)**:
- Read `msg.sourceFolder` (**required**). Same validation. Hard error if missing or invalid.

**`deleteLocalDoc` case (line 769)**:
- Pass `msg.sourceFolder` to `service.deleteFile(docId, msg.sourceFolder)`. Hard error if `msg.sourceFolder` is absent.

**New message handlers**:

```
case 'addLocalFolder': {
    const result = await vscode.window.showOpenDialog({
        openLabel: 'Add Docs Folder',
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false
    });
    if (result && result.length > 0) {
        const service = this._getLocalFolderService(workspaceRoot);
        await service.addFolderPath(result[0].fsPath);
        this._setupLocalFolderWatchers();
        await this._sendLocalDocsReady();
    }
    break;
}
case 'removeLocalFolder': {
    const service = this._getLocalFolderService(workspaceRoot);
    await service.removeFolderPath(msg.folderPath);
    this._setupLocalFolderWatchers();
    await this._sendLocalDocsReady();
    break;
}
case 'listLocalFolders': {
    const service = this._getLocalFolderService(workspaceRoot);
    const paths = await service.getFolderPaths();
    this._panel?.webview.postMessage({ type: 'localFoldersListed', paths });
    break;
}
```

---

### `src/webview/planning.html`

**Context**: UI structure for the LOCAL DOCS tab. Currently has a single path input + Browse button.

**Implementation**:
- Replace the single `#local-folder-path` read-only input with a **folder list** `<div id="local-folders-list">` that renders each configured folder as a row: `[folder path] [Remove button]`.
- Add an **"Add Folder"** button above the list that sends `{ type: 'addLocalFolder' }`.
- Add CSS for `.folder-list-item`, `.folder-list-remove-btn`, `.folder-list-empty`.
- The existing Browse button becomes the "Add Folder" button (or is replaced). The `browseLocalFolder` message type can be retired in favor of `addLocalFolder`.

**Edge Cases**: Empty state when `paths.length === 0`: render "No folders configured. Click Add Folder to get started."

---

### `src/webview/planning.js`

**State changes**:
- Replace `state.localFolderPath: ''` with `state.localFolderPaths: []`.
- Update `handleLocalDocsReady(msg)` to use `msg.folderPaths` (array) instead of `msg.folderPath` (string).
- Update `handleLocalFolderPathUpdated()` → replace with a re-render of the folder list from `state.localFolderPaths`.

**New message handler** (receive from extension host):
```
case 'localFoldersListed':
    state.localFolderPaths = msg.paths || [];
    renderFolderList(state.localFolderPaths);
    break;
```

**`renderFolderList(paths)`** — new function:
- Clears `#local-folders-list`.
- For each path: render a row with truncated path display + Remove button that sends `{ type: 'removeLocalFolder', folderPath: path }`.
- Empty state if no paths.

**`renderLocalDocs()` update**:
- Replace single `pathInput` element with folder list container.
- Add "Add Folder" button.

**Source-folder in fetch/delete messages**:
- When rendering a node from `listFiles()`, store `sourceFolder` in the DOM node's `dataset` (e.g., `dataset.sourceFolder`).
- When sending `fetchPreview`, `deleteLocalDoc`, `appendToPlannerPrompt`, `setActivePlanningContext`, `linkToDocument` — include `sourceFolder: node.dataset.sourceFolder`.

**Research prompt generator** (line 1736):
```javascript
// Replace:
const configuredPath = state.localFolderPath;
const saveLocation = configuredPath || '[CONFIGURE LOCAL DOCS FOLDER]';
// With:
const configuredPaths = state.localFolderPaths;
const saveLocation = configuredPaths.length > 0 ? configuredPaths[0] : '[CONFIGURE LOCAL DOCS FOLDER]';
```

---

## Verification Plan

### Automated Tests
- (Skipped per session directive)

### Manual Verification
1. **Fresh start**: Confirm no `localFolderPath` or `localFolderPaths` key exists in `.vscode/settings.json` — extension loads cleanly with empty state.
2. **Add folder**: Click "Add Folder", select a folder → folder appears in list, files appear in tree.
3. **Remove folder**: Click Remove on a folder → folder disappears from list, its files removed from tree.
4. **Multi-folder file access**: Configure 2 folders, click a file from each → correct content loads.
5. **Deduplication**: Configure same folder path twice → only listed once.
6. **Delete**: Delete a file from the 2nd configured folder → file moves to trash (not a "path not found" error).
7. **Watcher**: Add a `.md` file to folder 2 while extension is active → file appears in tree without manual refresh.
8. **Hard failure**: Send a `fetchPreview` message for `local-folder` without `sourceFolder` → extension returns a `previewError` response, no crash.
9. **Empty state**: Remove all folders → empty state message shown.
10. **No setting configured**: No `localFolderPaths` set → empty state (no crash).
11. **Persistence across panel lifecycle** *(regression test for Phase 0 bug fix)*: Configure a folder via Browse, close the ARTIFACTS webview entirely, reopen it → folder path is still displayed and files are still listed. Confirm `.vscode/settings.json` contains the path. This test **must pass** before any further work proceeds.

---

**Recommendation**: Send to Coder

---

## Review Pass — 2026-05-26

### Stage 1: Grumpy Principal Engineer Findings

| # | Severity | Finding | Location |
|---|----------|---------|----------|
| 1 | **CRITICAL** | `loadDocumentPreview()` references undefined `sourceFolder` variable — the function signature is `loadDocumentPreview(sourceId, docId, docName)` with no `sourceFolder` parameter, but lines 502/512 send `sourceFolder: sourceFolder` in `fetchPreview` messages. This is always `undefined`, causing the backend to return "sourceFolder is required" for every local-folder document click. | `planning.js:442-513` |
| 2 | **CRITICAL** | Auto-refresh handler calls `_handleFetchPreview` without `sourceFolder` parameter — when a watched local-folder document changes on disk, the auto-refresh on line 451 calls `_handleFetchPreview(workspaceRoot, 'local-folder', this._activePreviewDocId!, -1)` with no 5th argument. The class stores `_activePreviewPath`, `_activePreviewSourceId`, `_activePreviewDocId` but has no `_activePreviewSourceFolder` field. Auto-refresh always fails with "sourceFolder is required". | `PlanningPanelProvider.ts:449-451` |
| 3 | **MAJOR** | `setFolderPath()` is destructive to multi-folder config — it writes `[folderPath]` to `research.localFolderPaths`, replacing the entire array with a single entry. If the user has configured 3 folders and any code path calls `setFolderPath`, two folders silently vanish. No active code calls it, but it remains exported as a public method. | `LocalFolderService.ts:81-87` |
| 4 | **MAJOR** | Empty state message says "Click Browse to select a folder" — the Browse button was retired in favor of "Add Folder". UX inconsistency. | `planning.js:652` |
| 5 | **MAJOR** | `KanbanProvider.ts` and `TaskViewerProvider.ts` still read the old `research.localFolderPath` (singular string) setting which no longer exists in `package.json`. They will always get `undefined`. Migration regression. | `KanbanProvider.ts:2363`, `TaskViewerProvider.ts:6001` |
| 6 | **NIT** | `listLocalFolders` handler `await`s synchronous `getFolderPaths()`. Harmless but misleading. | `PlanningPanelProvider.ts:667` |
| 7 | **NIT** | Message field name drift: plan specifies `configuredFolderPaths` but implementation sends `folderPaths`. Works correctly, just differs from plan spec. | `PlanningPanelProvider.ts:1413` |

### Stage 2: Balanced Synthesis

| Finding | Verdict | Action Taken |
|---------|---------|--------------|
| CRITICAL-1: `loadDocumentPreview` undefined `sourceFolder` | **Fix now** | Extract `sourceFolder` from `wrapper.dataset.sourceFolder` after `findTreeNode` call |
| CRITICAL-2: Auto-refresh missing `sourceFolder` | **Fix now** | Added `_activePreviewSourceFolder` field; store in `_handleFetchPreview`; pass in auto-refresh call |
| MAJOR-1: `setFolderPath` destructive | **Fix now** | Removed the method entirely — no active code calls it |
| MAJOR-2: Empty state says "Browse" | **Fix now** | Updated text to "Click Add Folder to get started." |
| MAJOR-3: Stale `localFolderPath` references | **Fix now** | Updated `KanbanProvider.ts` and `TaskViewerProvider.ts` to read `research.localFolderPaths` (array) and take first element |
| NIT-1: Spurious `await` | **Defer** | Harmless, cosmetic |
| NIT-2: Field naming drift | **Defer** | Works correctly |

### Files Changed

| File | Change |
|------|--------|
| `src/webview/planning.js` | Added `sourceFolder` extraction from `wrapper.dataset.sourceFolder` in `loadDocumentPreview()`; updated empty state message text |
| `src/services/PlanningPanelProvider.ts` | Added `_activePreviewSourceFolder` field; stored `sourceFolder` in `_handleFetchPreview` success path; passed `_activePreviewSourceFolder` in auto-refresh call |
| `src/services/LocalFolderService.ts` | Removed destructive `setFolderPath()` method |
| `src/services/KanbanProvider.ts` | Updated `localDocsPath` to read `research.localFolderPaths` (array) with `[0]` fallback |
| `src/services/TaskViewerProvider.ts` | Updated `localDocsPath` to read `research.localFolderPaths` (array) with `[0]` fallback |

### Validation Results

- **Stale setting check**: No active `.ts` files reference `research.localFolderPath` (singular). Only test file `planning-modal-contract.test.js` still uses the old key (3 occurrences) — tests deferred per session directive.
- **`browseLocalFolder` check**: No active source files reference the retired `browseLocalFolder` message type.
- **`setFolderPath` check**: No active source files reference the removed `setFolderPath` method.
- **Compilation/tests**: Skipped per session directive.
- **TypeScript syntax**: Field declarations and method signatures are consistent with existing patterns.

### Remaining Risks

1. **Test file stale references**: `src/test/planning-modal-contract.test.js` still sets `switchboard.research.localFolderPath` (singular) in mock config. These tests will fail when run — they need updating to use `research.localFolderPaths` (array).
2. **`listLocalFolders` handler `await` on sync method**: Cosmetic, no functional impact. Can be cleaned up in a future pass.
3. **`_handleFetchPreview` sourceFolder validation**: The method passes `sourceFolder` directly to `fetchDocContent`, which internally calls `resolveFolderPath()` and validates against `getFolderPaths()`. This works correctly for absolute paths (which is what `listFiles()` returns), but if a relative `sourceFolder` were ever sent from the webview, it would need to be resolved first. Currently safe because `listFiles()` always returns absolute paths in `sourceFolder`.
4. **Auto-refresh with `_activePreviewSourceFolder!`**: The non-null assertion (`!`) is safe because auto-refresh only fires when `_activePreviewSourceId === 'local-folder'`, which means `_activePreviewSourceFolder` was set during the initial preview fetch. If the extension restarts between preview and auto-refresh, the field resets to `null` and the watcher is also disposed, so the assertion is never reached in a stale state.
