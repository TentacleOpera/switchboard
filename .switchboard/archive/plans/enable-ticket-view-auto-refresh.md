# Enable Auto-Refresh for Ticket View in Kanban

## Goal

Add auto-refresh to the ReviewProvider (Plan Review panel) so that when a plan file changes on disk, the open ticket view updates automatically — eliminating the need for manual refresh.

## Metadata

- **Tags:** [frontend, UX, reliability]
- **Complexity:** 4

## User Review Required

- Should auto-refresh be opt-in (default off) or opt-out (default on)? The implementation below defaults to on with a user setting to disable.
- Should unsaved edits in the review panel block auto-refresh, or should the view always reflect the latest file content? The implementation below preserves the existing mtime conflict detection on save.

## Complexity Audit

### Routine

- Adding a `FileSystemWatcher` in ReviewProvider for the currently-open plan file
- Debouncing file change events (300ms, matching TaskViewerProvider's existing pattern)
- Calling existing `_renderCurrentPlan()` on file change
- Adding a `switchboard.review.autoRefresh` user setting to `package.json`
- Adding a visual "Updated" flash indicator in review.html
- Disposing the watcher when the panel closes or a different plan is opened

### Complex / Risky

- Race condition: auto-refresh vs. user actively editing in the review panel's edit mode — could clobber unsaved changes or cause jarring UI jumps. Mitigated by checking edit mode and mtime before refreshing.
- Rapid successive file changes (e.g., agent writing plan in batches) could cause excessive re-renders. Mitigated by 300ms debounce (same as TaskViewerProvider).

## Edge-Case & Dependency Audit

- **Race Conditions:** User is typing in edit mode when auto-refresh fires. The refresh would overwrite the textarea. Mitigation: skip auto-refresh if the review panel is in edit mode and has unsaved changes; instead show a "File changed — click to reload" banner.
- **Security:** FileSystemWatcher only watches files within allowed workspace roots. ReviewProvider already validates paths via `_isPathWithinAllowedRoots()`. No new attack surface.
- **Side Effects:** `_renderCurrentPlan()` calls `_loadCurrentTicketData()` which reads the file and re-renders markdown. This is idempotent. The existing mtime conflict detection on save (`_applyTicketUpdate` lines ~429-430) continues to protect against overwrites.
- **Dependencies & Conflicts:** TaskViewerProvider already watches plan files and syncs to DB. ReviewProvider's new watcher is independent — it watches the same file but for a different purpose (UI refresh vs. DB sync). No conflict because ReviewProvider doesn't write to DB on file change.

## Dependencies

None — this is a self-contained feature that adds a watcher to an existing component.

## Adversarial Synthesis

Key risks: (1) auto-refresh clobbering user edits in edit mode, (2) excessive re-renders from rapid file changes. Mitigations: skip auto-refresh when in edit mode with unsaved changes (show banner instead), and debounce at 300ms matching the existing TaskViewerProvider pattern. The implementation is low-complexity because ReviewProvider already has `_currentPlan`, `_renderCurrentPlan()`, and mtime conflict detection.

## Problem

The ticket view (Plan Review panel managed by ReviewProvider) does NOT automatically update when the underlying plan file changes. While the kanban board (cards, columns) already auto-updates via TaskViewerProvider's `_refreshRunSheets()` → `KanbanProvider.refreshWithData()` pipeline, the ReviewProvider panel only loads content on `open()`, `ready`, or manual actions (save, metadata changes). If an agent modifies the plan file while the review panel is open, the user sees stale content.

## Current Architecture

### Existing File Watching Infrastructure

1. **TaskViewerProvider** — Dual-layer file watching (VS Code `FileSystemWatcher` + native `fs.watch`) for `.switchboard/plans/**/*.md` files. Debounced at 300ms via `debouncedTitleSync()`. On change: calls `_handlePlanTitleSync()` and `_handlePlanMetadataSync()`, then `_refreshRunSheets()` which pushes updates to both KanbanProvider and sidebar.

2. **KanbanProvider** — NO file watchers. DB-first: receives data from TaskViewerProvider via `refreshWithData()`. The kanban board (cards/columns) already auto-refreshes.

3. **ReviewProvider** — NO file watchers. Opens a separate webview panel (`switchboard-review`) with `review.html`. Tracks `_currentPlan` (including `planFileAbsolute`). Has `_renderCurrentPlan()` and `_loadCurrentTicketData()` for loading content. Has mtime-based conflict detection on save. Does NOT auto-refresh when the plan file changes on disk.

### Current Update Flow

When a plan file changes:
1. TaskViewerProvider's file watcher fires → `debouncedTitleSync()` (300ms debounce)
2. Calls `_handlePlanTitleSync()` → updates DB topic, SessionActionLog, plan registry
3. Calls `_handlePlanMetadataSync()` → updates DB tags/dependencies/repoScope
4. Calls `_refreshRunSheets()` → reads DB → pushes to:
   - `KanbanProvider.refreshWithData()` → kanban board cards update ✅
   - Sidebar `postMessage({ type: 'runSheets' })` → sidebar dropdown updates ✅
   - ReviewProvider → **NOT NOTIFIED** ❌

### What Does NOT Update

The **ReviewProvider panel** (the "ticket view") does not auto-refresh:
- Content is loaded only on `open()`, `ready` message, or manual actions
- `_loadCurrentTicketData()` reads the file and renders markdown
- `_renderCurrentPlan()` orchestrates the load + render
- mtime is captured at load time for conflict detection on save
- No watcher, no polling, no notification from other components

## Solution Design

### Approach A: ReviewProvider Self-Watch (Recommended)

Add a `FileSystemWatcher` directly in ReviewProvider for the currently-open plan file. When the file changes, debounce and call `_renderCurrentPlan()`.

**Why this approach:**
- ReviewProvider already knows which file is open (`_currentPlan.planFileAbsolute`)
- ReviewProvider already has the render pipeline (`_renderCurrentPlan()` → `_loadCurrentTicketData()` → `_renderTicketData()`)
- No cross-component coupling needed — self-contained change
- Consistent with VS Code extension patterns (each panel watches its own resource)

**Approach B: TaskViewerProvider Notification (Alternative)**

Have TaskViewerProvider notify ReviewProvider when a plan changes, similar to how it notifies KanbanProvider. More architecturally consistent but adds coupling and requires ReviewProvider to be reachable from TaskViewerProvider.

**Approach C: Frontend Polling (Fallback)**

Add periodic polling in review.html to check if the file has changed. Simpler backend but adds polling overhead and less responsive.

## Implementation Plan (Approach A — ReviewProvider Self-Watch)

### Phase 1: Add FileSystemWatcher to ReviewProvider

**File: `src/services/ReviewProvider.ts`**

1. Add watcher property and debounce timer:
   ```typescript
   private _planFileWatcher?: vscode.FileSystemWatcher;
   private _planRefreshTimer?: NodeJS.Timeout;
   ```

2. Create a method to set up the watcher when a plan is opened:
   ```typescript
   private _setupPlanFileWatcher(planFileAbsolute: string): void {
       this._teardownPlanFileWatcher();

       const autoRefresh = vscode.workspace.getConfiguration('switchboard.review')
           .get<boolean>('autoRefresh', true);
       if (!autoRefresh) return;

       this._planFileWatcher = vscode.workspace.createFileSystemWatcher(
           new vscode.RelativePattern(
               vscode.Uri.file(planFileAbsolute),
               path.basename(planFileAbsolute)
           )
       );

       this._planFileWatcher.onDidChange(() => {
           if (this._planRefreshTimer) clearTimeout(this._planRefreshTimer);
           this._planRefreshTimer = setTimeout(() => {
               this._planRefreshTimer = undefined;
               this._autoRefreshPlan();
           }, 300); // 300ms debounce matching TaskViewerProvider
       });

       this._planFileWatcher.onDidDelete(() => {
           this._teardownPlanFileWatcher();
           this._panel?.webview.postMessage({ type: 'planDeleted' });
       });
   }

   private _teardownPlanFileWatcher(): void {
       if (this._planRefreshTimer) {
           clearTimeout(this._planRefreshTimer);
           this._planRefreshTimer = undefined;
       }
       if (this._planFileWatcher) {
           this._planFileWatcher.dispose();
           this._planFileWatcher = undefined;
       }
   }
   ```

3. Add auto-refresh logic that respects edit mode:
   ```typescript
   private async _autoRefreshPlan(): Promise<void> {
       if (!this._panel || !this._currentPlan) return;

       // Ask the webview if it's in edit mode with unsaved changes
       this._panel.webview.postMessage({ type: 'checkEditMode' });
       // The webview will respond with 'editModeStatus' message
   }
   ```

4. Handle the webview's edit mode response:
   ```typescript
   case 'editModeStatus': {
       const { isEditing, hasUnsavedChanges } = msg;
       if (isEditing && hasUnsavedChanges) {
           // Show "file changed" banner instead of auto-refreshing
           this._panel?.webview.postMessage({ type: 'fileChangedBanner', show: true });
       } else {
           // Safe to auto-refresh
           await this._renderCurrentPlan();
           this._panel?.webview.postMessage({ type: 'refreshFlash' });
       }
       break;
   }
   ```

5. Call `_setupPlanFileWatcher()` in the `open()` method after setting `_currentPlan`:
   ```typescript
   public async open(plan: ReviewPlanContext): Promise<void> {
       this._currentPlan = plan;
       // ... existing panel creation code ...
       this._setupPlanFileWatcher(plan.planFileAbsolute);
       await this._renderCurrentPlan();
   }
   ```

6. Call `_teardownPlanFileWatcher()` in `dispose()` and when the panel is disposed:
   ```typescript
   // In dispose():
   this._teardownPlanFileWatcher();

   // In panel.onDidDispose callback (already exists):
   this._panel = undefined;
   this._lastSelection = undefined;
   this._teardownPlanFileWatcher(); // Add this line
   ```

7. Also teardown + re-setup when a different plan is opened (the `open()` method already handles this since it calls `_setupPlanFileWatcher` which calls `_teardownPlanFileWatcher` first).

### Phase 2: Frontend Changes in review.html

**File: `src/webview/review.html`**

1. Add handler for `checkEditMode` message from backend:
   ```javascript
   case 'checkEditMode': {
       const editor = document.getElementById('planEditor');
       const isEditing = /* check if in edit mode */;
       const hasUnsavedChanges = /* check if editor content differs from saved */;
       vscode.postMessage({
           type: 'editModeStatus',
           isEditing,
           hasUnsavedChanges
       });
       break;
   }
   ```

2. Add handler for `refreshFlash` message:
   ```javascript
   case 'refreshFlash': {
       const flash = document.getElementById('refreshFlash');
       if (flash) {
           flash.textContent = 'Updated';
           flash.classList.add('visible');
           setTimeout(() => flash.classList.remove('visible'), 2000);
       }
       break;
   }
   ```

3. Add handler for `fileChangedBanner` message:
   ```javascript
   case 'fileChangedBanner': {
       const banner = document.getElementById('fileChangedBanner');
       if (banner) {
           banner.style.display = msg.show ? 'flex' : 'none';
       }
       break;
   }
   ```

4. Add handler for `planDeleted` message:
   ```javascript
   case 'planDeleted': {
       document.getElementById('planContent').innerHTML =
           '<div style="padding:20px;color:#f48771;">This plan file has been deleted.</div>';
       break;
   }
   ```

5. Add visual elements to the HTML:
   ```html
   <!-- Refresh flash indicator (add near status bar) -->
   <div id="refreshFlash" class="refresh-flash">Updated</div>

   <!-- File changed banner (add above editor) -->
   <div id="fileChangedBanner" style="display:none;" class="file-changed-banner">
       <span>File changed on disk</span>
       <button onclick="reloadFromDisk()">Reload</button>
       <button onclick="dismissBanner()">Dismiss</button>
   </div>
   ```

6. Add CSS for the indicators:
   ```css
   .refresh-flash {
       position: fixed; bottom: 30px; right: 20px;
       background: var(--vscode-button-background);
       color: var(--vscode-button-foreground);
       padding: 4px 12px; border-radius: 4px;
       opacity: 0; transition: opacity 0.3s;
       font-size: 12px; z-index: 100;
   }
   .refresh-flash.visible { opacity: 1; }
   .file-changed-banner {
       display: flex; align-items: center; gap: 8px;
       background: var(--vscode-inputValidation-warningBackground);
       border: 1px solid var(--vscode-inputValidation-warningBorder);
       padding: 6px 12px; margin: 4px 0; border-radius: 4px;
   }
   ```

7. Add `reloadFromDisk()` function:
   ```javascript
   function reloadFromDisk() {
       document.getElementById('fileChangedBanner').style.display = 'none';
       vscode.postMessage({ type: 'reloadFromDisk' });
   }
   ```

8. Add backend handler for `reloadFromDisk`:
   ```typescript
   case 'reloadFromDisk': {
       await this._renderCurrentPlan();
       this._panel?.webview.postMessage({ type: 'refreshFlash' });
       break;
   }
   ```

### Phase 3: User Configuration

**File: `package.json`**

Add setting in the existing `switchboard.*` configuration namespace:
```json
{
    "switchboard.review.autoRefresh": {
        "type": "boolean",
        "default": true,
        "description": "Automatically refresh the Plan Review panel when the underlying plan file changes on disk",
        "scope": "resource"
    }
}
```

This follows the existing pattern of `switchboard.kanban.*` and `switchboard.planWatcher.*` settings.

### Phase 4: Testing

1. **Manual Tests:**
   - Open a plan in the Review panel
   - Modify the plan file externally (e.g., in another editor or via agent)
   - Verify the Review panel auto-refreshes within ~300ms
   - Verify the "Updated" flash indicator appears
   - Switch to edit mode, make changes, then modify file externally
   - Verify the "File changed on disk" banner appears instead of auto-refresh
   - Click "Reload" on the banner and verify content refreshes
   - Disable auto-refresh via setting, modify file, verify no auto-refresh
   - Delete the plan file while viewing, verify "plan deleted" message

2. **Edge Cases:**
   - Rapid successive file changes (debounce behavior — should coalesce into single refresh)
   - Plan deleted while being viewed
   - File system errors during refresh (existing try/catch in `_loadCurrentTicketData` handles this)
   - Opening a different plan while watcher is active (teardown + re-setup)
   - Panel hidden then revealed (`retainContextWhenHidden: true` preserves state)
   - Multiple plans open in different Review panels (each has its own watcher — but note: ReviewProvider currently uses a single `_panel`, so only one review panel exists at a time)

## Files to Modify

1. `src/services/ReviewProvider.ts` — Add FileSystemWatcher, debounce, auto-refresh logic, edit-mode check, new message handlers
2. `src/webview/review.html` — Add refresh flash indicator, file-changed banner, edit-mode status response, reload button
3. `package.json` — Add `switchboard.review.autoRefresh` configuration setting

## Success Criteria

- [ ] Review panel auto-refreshes when the underlying plan file changes on disk
- [ ] Auto-refresh can be disabled via `switchboard.review.autoRefresh` setting
- [ ] "Updated" flash indicator appears when content is auto-refreshed
- [ ] Edit mode with unsaved changes blocks auto-refresh and shows "File changed" banner instead
- [ ] "Reload" button on banner triggers manual refresh
- [ ] Deleted plan file shows appropriate message
- [ ] No performance degradation from auto-refresh (debounced, single watcher)
- [ ] Existing mtime conflict detection on save continues to work

## Risks and Mitigations

**Risk:** Auto-refresh could overwrite user edits in edit mode
**Mitigation:** Check edit mode + unsaved changes before refreshing; show banner instead of auto-refreshing

**Risk:** Performance impact from frequent file changes
**Mitigation:** 300ms debounce (matching TaskViewerProvider pattern); single watcher per open plan

**Risk:** Race condition between auto-refresh and user saving
**Mitigation:** Existing mtime conflict detection in `_applyTicketUpdate()` (lines ~429-430) already prevents overwrites; auto-refresh re-reads the file which updates the mtime baseline

## Estimated Effort

- ReviewProvider.ts changes: 1-2 hours
- review.html changes: 1-2 hours
- package.json + testing: 1 hour
- **Total: 3-5 hours**

## Recommendation

Complexity 4 → **Send to Coder**

## Review Pass — Completed

**Reviewer:** Grumpy Principal Engineer (inline review)
**Date:** 2026-05-21

### Stage 1: Adversarial Findings

| # | Severity | Finding | File | Lines |
|---|----------|---------|------|-------|
| 1 | **CRITICAL** | `RelativePattern` base is `Uri.file(planFileAbsolute)` (a file path) instead of a directory. The resolved glob becomes `/path/to/plan.md/plan.md` — a path that never exists. The FileSystemWatcher never fires, making the entire auto-refresh feature a no-op. | `src/services/ReviewProvider.ts` | 154-158 |
| 2 | NIT | `fileChangedBanner` CSS uses hardcoded `rgba(204,167,0,...)` colors instead of VS Code theme variables (`--vscode-inputValidation-warningBackground`, `--vscode-inputValidation-warningBorder`). Breaks on light themes. | `src/webview/review.html` | 331-332 |
| 3 | NIT | `planDeleted` handler only disables `togglePreviewBtn` and `savePlanButtonEl`. Other controls (column, complexity, dependencies, complete, delete, copy link) remain interactive on a deleted plan. | `src/webview/review.html` | 1272-1280 |
| 4 | NIT | `_autoRefreshPlan` is `async` but never `await`s anything. Misleading signature. | `src/services/ReviewProvider.ts` | 186 |
| 5 | NIT | No guard against orphaned `editModeStatus` responses when file changes rapidly. Multiple `checkEditMode` messages can be in flight, causing redundant `_renderCurrentPlan()` calls. Idempotent so no correctness risk. | `src/services/ReviewProvider.ts` | 186-190 |

### Stage 2: Balanced Synthesis

| Finding | Action | Rationale |
|---------|--------|-----------|
| #1 (CRITICAL) | **Fix now** | Feature is completely non-functional. |
| #2 (NIT) | **Fix now** | Trivial one-line change, prevents theme breakage. |
| #3 (NIT) | Defer | Low impact, controls fail gracefully without sessionId. |
| #4 (NIT) | **Fix now** | Remove one keyword. |
| #5 (NIT) | Defer | Idempotent, no correctness risk. |

### Code Fixes Applied

1. **`src/services/ReviewProvider.ts` line 155-156** — Changed `RelativePattern` base from `vscode.Uri.file(planFileAbsolute)` to `path.dirname(planFileAbsolute)`, matching the established pattern in `PlanningPanelProvider.ts` line 369. This is the only pattern that correctly watches a specific file.

2. **`src/webview/review.html` lines 331-332** — Replaced hardcoded `rgba(204, 167, 0, ...)` with `var(--vscode-inputValidation-warningBackground, rgba(204, 167, 0, 0.1))` and `var(--vscode-inputValidation-warningBorder, rgba(204, 167, 0, 0.4))`. Uses VS Code theme variables with the original RGBA as fallback.

3. **`src/services/ReviewProvider.ts` line 186** — Changed `private async _autoRefreshPlan(): Promise<void>` to `private _autoRefreshPlan(): void`. The method only calls `postMessage()` (synchronous), so `async` was misleading.

### Validation Results

- **Webpack production build:** `compiled successfully` (no errors)
- **TypeScript `--noEmit`:** No errors in ReviewProvider.ts (pre-existing errors only in ClickUpSyncService.ts and KanbanProvider.ts, unrelated)
- **Lint:** ESLint not configured for this project (no eslint.config.js)

### Remaining Risks / Deferred Items

- **#3 (NIT):** `planDeleted` handler should disable all interactive controls, not just two buttons. Low priority — other controls fail gracefully.
- **#5 (NIT):** Rapid file changes could cause multiple in-flight `checkEditMode` → `editModeStatus` round-trips. Idempotent, no data risk. Could be addressed with a pending-response guard if desired.
- **No automated tests:** The plan's Phase 4 lists only manual tests. Consider adding integration tests for the watcher lifecycle in a future iteration.
