# Fix Agent Atomic Write Preview Refresh in Planning Panel

## Metadata
- **Complexity:** 2
- **Tags:** bugfix, frontend, vscode, filesystem, webview

## Goal
Fix the bug where the Planning Panel preview pane does **not** auto-refresh when an external agent (e.g., Cursor, Claude Code, Gemini CLI) modifies the currently viewed file. The sidebar tree updates correctly, but the preview pane stays stale.

## Background & Root Cause
When external agents write files, they often use an **atomic write pattern**: write to a temporary file, then rename (`mv`) the temp file over the original. On macOS (and other Unix-like systems), VS Code's `FileSystemWatcher` frequently emits a `create` event for the target file path rather than a `change` event.

The `_setupActiveDocWatcher` method in `PlanningPanelProvider.ts` only registers an `onDidChange` handler. It does **not** handle `onDidCreate`.

Meanwhile, the **folder-level** watchers (`_setupLocalFolderWatchers`, `_setupDesignFolderWatchers`, etc.) correctly register all three event handlers (`onDidCreate`, `onDidChange`, `onDidDelete`). This explains why the **tree sidebar** refreshes (it catches the `create` event), but the **preview pane** does not (the per-file watcher ignores it).

### Affected Code
```typescript
@/Users/patrickvuleta/Documents/GitHub/switchboard/src/services/PlanningPanelProvider.ts:590-675
```

The `createFileSystemWatcher` call at line 614 already has `watchCreate: false` (line 616), but even if it were `true`, there is no `onDidCreate` listener registered.

## User Review Required
- None. The fix is additive and mirrors existing battle-tested logic.

## Complexity Audit

### Routine
- Purely additive: register one new event handler alongside an existing one.
- Reuses existing debounce, generation guard, and refresh logic.
- No new API surface or dependency.

### Complex / Risky
- None

## Edge-Case & Dependency Audit
- **Race Conditions:** Covered by existing `gen !== this._watcherGeneration` guard and debounce. No new race introduced.
- **Security:** None. No additional file-system access is granted; the watcher is already configured to observe the file.
- **Side Effects:** The preview pane will now refresh on `create` events. This is the intended behavior and aligns with the tree sidebar.
- **Dependencies & Conflicts:** None. The VS Code `FileSystemWatcher` API is stable and the glob pattern is exact (`path.basename(filePath)`).

## Dependencies
- None

## Adversarial Synthesis
Key risks: Maintenance drift from duplicated refresh logic (both `onDidChange` and `onDidCreate` contain identical 30-line blocks); if refresh logic evolves, both handlers must be updated in tandem. Mitigations: Add a cross-referencing TODO comment above each handler; consider a follow-up refactor to extract `_triggerActiveDocRefresh` once the fix is validated.

## Proposed Changes

### `src/services/PlanningPanelProvider.ts`
- **Context:** Inside `_setupActiveDocWatcher` (lines 590–675).
- **Logic:** Add an `onDidCreate` handler that mirrors the existing `onDidChange` handler. The `createFileSystemWatcher` is already configured with `ignoreCreateEvents: false`, so create events are already being emitted; only the listener is missing.
- **Implementation:** Insert the following block after line 654 (after the `onDidChange` block, before `onDidDelete`):

```typescript
this._activeDocWatcher.onDidCreate(() => {
    if (gen !== this._watcherGeneration) { return; } // stale watcher
    if (Date.now() - this._lastPanelWriteTimestamp < 1000) { return; } // panel-initiated write
    if (filePath !== this._activePreviewPath) { return; } // stale path

    if (this._activeDocWatchDebounce) {
        clearTimeout(this._activeDocWatchDebounce);
    }

    this._activeDocWatchDebounce = setTimeout(async () => {
        if (gen !== this._watcherGeneration || filePath !== this._activePreviewPath) { return; }
        
        const workspaceRoot = this._activePreviewWorkspaceRoot
            || this._getWorkspaceRoot()
            || (this._getWorkspaceRoots().length > 0 ? this._getWorkspaceRoots()[0] : undefined);
        if (!workspaceRoot) return;

        console.log('[PlanningPanel] Auto-refreshing active document (create):', filePath);
        this._isAutoRefreshing = true;
        try {
            if (this._activePreviewSourceId === 'local-folder' || this._activePreviewSourceId === 'html-folder') {
                // Re-fetch local doc or HTML doc
                await this._handleFetchPreview(workspaceRoot, this._activePreviewSourceId, this._activePreviewDocId!, -1, this._activePreviewSourceFolder!);
            } else if (this._activePreviewSourceId === 'kanban-plan') {
                await this._handleFetchKanbanPlanPreview(this._activePreviewDocId!, -1);
            } else {
                // Re-fetch imported doc via fetchDocsFile
                await this._handleFetchDocsFile(workspaceRoot, this._activePreviewDocId!, -1);
            }
        } finally {
            this._isAutoRefreshing = false;
        }
    }, 300);
});
```

- **Edge Cases:**
  - **Rapid consecutive events:** The 300ms debounce coalesces them into a single refresh.
  - **Panel-initiated writes:** The `Date.now() - this._lastPanelWriteTimestamp < 1000` guard prevents self-triggered refresh.
  - **Stale watcher:** The generation guard prevents races when switching documents.
  - **Deleted then recreated:** `onDidDelete` disposes the watcher; the user must re-click to re-establish it.

**Alternative (preferred to avoid duplication):** Extract the shared logic into a private helper method `_triggerActiveDocRefresh(gen: number, filePath: string)` and call it from both `onDidChange` and `onDidCreate`. However, given the low complexity, inline duplication is acceptable and safer (no risk of breaking the existing `onDidChange` handler). A TODO comment should be added above both handlers to keep them in sync.

## Verification Plan

### Automated Tests
- Not applicable per session directive (skip tests). Manual verification steps below.

### Manual Verification
1. Open the Switchboard Planning Panel and select a file in the Local Docs tab.
2. From a terminal, simulate an atomic write:
   ```bash
   cat /path/to/your/file.md > /tmp/temp.md && mv /tmp/temp.md /path/to/your/file.md
   ```
3. **Expected:** The preview pane updates to show the new content within ~1 second, and the status bar shows "auto-refreshed".
4. **Before fix:** The preview pane stays unchanged; only the tree sidebar would update.
5. Regression: Edit the file from within the panel and save. Confirm the preview does NOT flash/reload (the 1000ms write guard should prevent self-triggered refresh).

## Risks
- **Minimal.** The change is a pure addition of an event handler that mirrors existing, battle-tested logic. No existing behavior is modified.
- The `FileSystemWatcher` API is already configured to emit create events (`ignoreCreateEvents: false`), so no additional system-level watcher overhead is introduced.

**Recommendation:** Send to Intern
