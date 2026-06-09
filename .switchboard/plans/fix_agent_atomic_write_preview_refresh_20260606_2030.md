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

---

## Reviewer Pass — Completed

### Stage 1: Grumpy Adversarial Findings

- **[MAJOR]** *Copy-paste engineering.* You duplicated ~30 lines of refresh logic instead of extracting a `_triggerActiveDocRefresh` helper. The plan itself flagged this as a risk: "Maintenance drift from duplicated refresh logic." Your mitigation? A TODO comment. A. TODO. Comment. That is not a mitigation; that is a confession. The next engineer who needs to tweak debounce timing or add a new `sourceId` branch will update one handler and forget the other. I guarantee it.
- **[NIT]** *The `watchCreate: false` lie.* The plan claims `createFileSystemWatcher` has `watchCreate: false`. The actual API parameter is `ignoreCreateEvents`, and the code passes `false` — meaning it DOES watch create events. The comment at line 616 says `// watch create` which is behaviorally right but semantically confused. Read the API docs before you annotate parameters.
- **[NIT]** *No guard against double-fire.* On some platforms, an atomic rename can trigger BOTH `onDidCreate` and `onDidChange`. The debounce coalesces them into one refresh, which is fine, but the log message will only say `(create)`. If I'm debugging a race, I want to know both events fired, not just the one that won the debounce.

### Stage 2: Balanced Synthesis

- **What to keep:** The `onDidCreate` handler is functionally correct. The generation guard, panel-write guard, debounce, source-id branching, and auto-refresh flag are all faithfully reproduced. The preview pane will now refresh on atomic writes. This is the right fix.
- **What to fix now:** Nothing blocking. The duplicated logic works today.
- **What to defer:** Extract `_triggerActiveDocRefresh(gen, filePath)` and call it from both handlers. Add distinct log prefixes for `onDidChange` vs `onDidCreate` to aid future debugging.

### Code Fixes Applied

None. No CRITICAL findings. The MAJOR finding (duplication) is a maintainability debt that does not affect runtime correctness and is pre-acknowledged by the plan. Deferring extraction to a follow-up refactor.

### Verification Results

- **Code read:** `@/Users/patrickvuleta/Documents/GitHub/switchboard/src/services/PlanningPanelProvider.ts:621-691` confirms both `onDidChange` and `onDidCreate` handlers are present with matching guard/debounce/refresh logic.
- **TODO comments:** Present at lines 621 (`TODO: Keep onDidChange and onDidCreate refresh logic in sync`) and 657 (`TODO: Keep onDidCreate and onDidChange refresh logic in sync`).
- **Compilation:** Skipped per session directive.
- **Tests:** Skipped per session directive.

### Files Changed

- `src/services/PlanningPanelProvider.ts` (lines 657–691 added)

### Remaining Risks

- **Minimal.** The change is purely additive. No existing behavior is modified.
- **Maintenance drift:** If the `onDidChange` refresh logic evolves, the `onDidCreate` copy must be kept in sync. Mitigated by TODO comments; permanent fix is helper extraction.

**Reviewer Verdict:** Approved with technical debt noted. Ship it, then schedule the refactor.
