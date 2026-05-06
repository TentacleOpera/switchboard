---
sessionId: planning-panel-collapsible-docs-auto-refresh
topic: Planning Panel: Collapsible Docs List & Auto-Refresh
complexity: low
kanbanColumn: CREATED
---

## Goal

Add a collapsible documents list sidebar and auto-refresh on external file changes to the Switchboard Planning Panel, reducing UI friction when working with agent chat windows and external editors.

## Metadata

**Tags:** frontend, UI, UX
**Complexity:** 6

## User Review Required

No

## Overview

Two UX improvements to the Switchboard Planning Panel:
1. **Collapsible docs list sidebar** - Allow users to collapse the left-hand documents list to reclaim horizontal space when working with agent chat windows open
2. **Auto-refresh on file change** - Watch the active document file and auto-refresh it when modified externally, eliminating the need for manual refresh via the file list button

## Current Pain Points

- When working on a single document with agent chat windows open, the docs list consumes horizontal real estate unnecessarily
- Users must manually click the file list refresh button to see external changes to the active document
- This creates friction when iterating on documents with both AI assistance and external editors

## Complexity Audit

### Routine
- Add CSS class toggling and transition styles for sidebar collapse (`.content-row` grid change from `280px 1fr` to `40px 1fr`)
- Add toggle button markup to `tree-pane` and `tree-pane-online` headers in `src/webview/planning.html`
- Persist and restore collapse state via `vscode.setState()` / `vscode.getState()` in `src/webview/planning.js`
- Add message handler for `toggleDocsListCollapsed` in `src/services/PlanningPanelProvider.ts` `_handleMessage`
- Wire up click listener in webview JS to post collapse toggle message

### Complex / Risky
- **Cross-tab collapse synchronization**: The panel has two tabs (Local Docs and Online Docs) with independent `#tree-pane` and `#tree-pane-online` elements. Collapse state should be unified across both tabs, but the DOM elements are separate. Clarification: Use a single shared CSS class on `.content-row` and a single state flag, then apply the collapsed style to both panes identically.
- **Active file watcher lifecycle management**: A new `vscode.FileSystemWatcher` must be created/destroyed every time the user switches active documents. The existing `_docsFolderWatcher` (`src/services/PlanningPanelProvider.ts:36`) only watches `.switchboard/docs/*.md` for the imported docs list, not the currently previewed file. A new `_activeDocWatcher` field is required with proper disposal to avoid leaking watchers.
- **Distinguishing user-initiated vs external file changes**: When the user imports a full doc or syncs to source, the file on disk changes but the webview should NOT auto-reload from disk and overwrite the in-memory preview state. The watcher must only trigger for external changes, not for changes caused by panel actions. Mitigation: Track a `_lastPanelWriteTimestamp` and ignore file events within 1 second of panel-initiated writes.
- **Race between cache refresh and file watcher**: The provider already serves cached content first and refreshes in background (`_refreshCacheInBackground`, line 1181). The auto-refresh watcher may trigger while a background cache refresh is in flight, causing double UI updates. Debouncing (300ms) mitigates this but must be carefully coordinated.

## Edge-Case & Dependency Audit

**Race Conditions:**
- If the user rapidly clicks between documents, the `_activeDocWatcher` may be disposed and recreated faster than the file system can register/unregister watchers. The implementation must queue/dispose synchronously before creating the new watcher.
- Rapid external saves on large documents (>1MB) could cause the preview reload to lag behind subsequent watcher events. The debounce timer must reset on each new event.

**Security:**
- No new security surface area. The file watcher uses `vscode.workspace.createFileSystemWatcher` which respects VS Code's existing file system sandbox.
- Sanitization of paths is already handled by `_resolveWorkspacePath` and `_handleFetchDocsFile`.

**Side Effects:**
- Auto-refresh will trigger when the user runs external scripts that modify `.switchboard/docs/*.md` (e.g., CI, git operations). This is expected behavior but may surprise users if the preview suddenly updates. Clarification: A brief "External change detected — refreshed" status text (not a modal) is sufficient to signal this.
- Collapsing the sidebar reduces the tree-pane width to ~40px, which may clip long document names or folder subheaders. The collapsed state should hide text labels and show only an expand icon.

**Dependencies & Conflicts:**
- Kanban query verified: No plans in `NEW` or `PLANNED` columns. No active parallel work in those stages.
- This plan touches `src/services/PlanningPanelProvider.ts`, which is also modified by the "Fix Planning Panel Workspace Root Detection" plan (sess_1777428318801). That plan is in CODE REVIEWED and targets workspace root resolution, not UI state or file watching. Low conflict risk, but coordinate merges.
- This plan modifies the same webview HTML/JS as the "Research Tab for Planning View" plan (sess_1777415652953), which is in CODE REVIEWED. That plan adds the Research tab UI; this plan modifies the Local/Online tab layout. Both changes affect `src/webview/planning.html` and `src/webview/planning.js`. **Merge conflict risk is high** if both plans are coded simultaneously. Sequence them or isolate edits to non-overlapping line ranges.

## Dependencies

- `sess_1777415652953` — Research Tab for Planning View (CODE REVIEWED; potential file conflict in planning.html/planning.js)
- `sess_1777428318801` — Fix Planning Panel Workspace Root Detection (CODE REVIEWED; low conflict risk, same file but non-overlapping concerns)
- `sess_1777583384344` — Unify Planning Panel Database with Kanban.db (CODE REVIEWED; medium conflict risk, modifies PlanningPanelProvider.ts)

## Adversarial Synthesis

Key risks: (1) Merge conflict with Research Tab and Unify DB plans touching PlanningPanelProvider.ts — all in CODE REVIEWED, sequence after both; (2) 7 `previewReady` emission points but only 5 are doc-level — flag must NOT be added to `_handleFetchPageContent` (lines 583, 1667); (3) `_handleSyncToSource` writes to remote adapter, not local disk — does NOT need timestamp gating; (4) Multi-page import loop requires timestamp after each `writeContentToDocsDir`, not just at method entry; (5) `_watcherGeneration` counter needed to reject stale watcher events from rapid doc switching. Mitigations: Enumerate all 7 previewReady paths and flag only 5; remove gate from sync-to-source; set timestamp per-write in import loop; add generation counter; sequence after Research Tab and Unify DB plans.

## Proposed Changes

### Step 1: Add Collapsible Sidebar State

**Files to modify:**
- `src/services/PlanningPanelProvider.ts`
- `src/webview/planning.html`
- `src/webview/planning.js`

**Context:** The webview layout uses `.content-row` with `grid-template-columns: 280px 1fr` (planning.html line 163). Both `#local-content` and `#online-content` have their own `.content-row` containing `#tree-pane` / `#tree-pane-online` (280px) and `#preview-pane` / `#preview-pane-online` (1fr).

**Implementation:**
- [ ] In `src/webview/planning.js`, add `docsListCollapsed: persistedState.docsListCollapsed || false` to the `state` object (after line 21).
- [ ] Add a `toggleSidebarCollapsed()` helper in `planning.js` that:
  - Toggles `state.docsListCollapsed`
  - Persists via `vscode.setState({ ...vscode.getState(), docsListCollapsed: state.docsListCollapsed })`
  - Applies a `collapsed` CSS class to ALL `.content-row` elements in both tabs
  - Updates the toggle button icon/text (e.g., `«` / `»`)
- [ ] In `src/webview/planning.html`, add a toggle button inside `#tree-pane` and `#tree-pane-online` at the top. Style it as a small absolute-positioned or flex item. Example markup inserted before the `.empty-state` or first child:
  ```html
  <div class="sidebar-toggle-row">
      <button class="sidebar-toggle-btn" title="Toggle sidebar">«</button>
  </div>
  ```
- [ ] In `planning.html` `<style>`, add `.content-row.collapsed { grid-template-columns: 40px 1fr; }` and `.content-row.collapsed #tree-pane, .content-row.collapsed #tree-pane-online { padding: 4px; overflow: hidden; }`. Hide `.file-name`, `.folder-subheader`, `.source-header` text when collapsed (use `.content-row.collapsed .file-name { display: none; }`). Keep `.tree-node.selected` border or background visible as the active indicator.
- [ ] In `planning.js`, bind click listeners to `.sidebar-toggle-btn` elements to call `toggleSidebarCollapsed()`.
- [ ] In `planning.js`, on initial load, read `state.docsListCollapsed` and apply the `collapsed` class immediately before the first render to avoid layout shift.

**Edge Cases:**
- If the sidebar is collapsed and the user clicks a tree node icon (not the text), the document should still load. Ensure the click handler is on `.tree-node`, not just the label.
- If no document is active and the sidebar is collapsed, the expand handle must still be visible and clickable.
- The active document indicator (`.selected` class on `.tree-node`) must remain visible in collapsed state via background color or left border.

**Clarification:** Collapsed state should be per-panel-instance (persisted via `vscode.setState`), not global workspace state, because the user may want different layouts per VS Code window.

### Step 2: File Watcher for Auto-Refresh

**Files to modify:**
- `src/services/PlanningPanelProvider.ts`
- `src/webview/planning.js`

**Context:** The provider already has `_docsFolderWatcher` (`line 36`) that watches `.switchboard/docs/*.md` for changes to refresh the imported docs list. It does NOT watch the individual file currently being previewed. `_handleFetchDocsFile` (line 1299) reads the file from disk and sends `previewReady` to the webview. `_handleFetchPreview` (line 1076) handles both local-folder docs (via `LocalFolderService`) and online docs (via adapters/cache).

**Implementation:**
- [ ] In `src/services/PlanningPanelProvider.ts`, add new private fields:
  ```ts
  private _activeDocWatcher: vscode.FileSystemWatcher | undefined;
  private _activeDocWatchDebounce: NodeJS.Timeout | undefined;
  private _lastPanelWriteTimestamp: number = 0;
  private _isAutoRefreshing: boolean = false;
  private _activePreviewPath: string | null = null;
  private _activePreviewSourceId: string | null = null;
  private _activePreviewDocId: string | null = null;
  private _watcherGeneration: number = 0;
  ```
- [ ] Add a new method `_setupActiveDocWatcher(filePath: string | null): void` that:
  - Disposes any existing `_activeDocWatcher` synchronously (wrapped in try-finally) and clears `_activeDocWatchDebounce`
  - Increments `this._watcherGeneration` and captures `const gen = this._watcherGeneration` for closure
  - If `filePath` is null or `!fs.existsSync(filePath)`, returns early
  - Creates `vscode.workspace.createFileSystemWatcher(vscode.Uri.file(filePath), false, false, true)` (watch for create/change, ignore delete — delete is handled separately). Wrapped in try-catch; on failure, log and return (continue without watching).
  - On `onDidChange`, checks if `gen !== this._watcherGeneration`; if so, returns (stale watcher from previous doc)
  - Checks if `Date.now() - this._lastPanelWriteTimestamp < 1000`; if so, returns (panel-initiated write)
  - Otherwise, checks if `filePath !== this._activePreviewPath`; if so, returns (stale watcher event for a previously active document)
  - Otherwise, clears any pending `_activeDocWatchDebounce` and sets a new 300ms debounce timer. On debounce completion:
    - Set `this._isAutoRefreshing = true`
    - If `_activePreviewSourceId === 'local-folder'`, call `this._handleFetchPreview(workspaceRoot, 'local-folder', this._activePreviewDocId!, undefined)`
    - Else call `this._handleFetchDocsFile(workspaceRoot, this._activePreviewDocId!, undefined)`
    - Set `this._isAutoRefreshing = false`
  - On `onDidDelete`, clear the debounce timer, post `previewError` with message "File deleted externally" to the webview, and dispose the watcher.
  - Pushes the watcher into `this._disposables`
- [ ] In `_handleFetchPreview` (line 1076), after resolving the file path for `local-folder` docs or after cache resolution for online docs, update:
  ```ts
  this._activePreviewSourceId = sourceId;
  this._activePreviewDocId = docId;
  // For local-folder, resolve absolute path via localFolderService.getFolderPath() + docId
  // For imported/online docs, use the cached file path from _cacheService.resolveImportedDocPath
  this._activePreviewPath = resolvedFilePath;
  this._setupActiveDocWatcher(resolvedFilePath);
  ```
  Then, in every doc-level `previewReady` postMessage within `_handleFetchPreview`, include `isAutoRefreshed: this._isAutoRefreshing`. **Do NOT add to `_handleFetchPageContent` (lines 583, 1667)** — those are sub-page fetches, not doc-level previews.
- [ ] In `_handleFetchDocsFile` (line 1299), after resolving `filePath` (line 1312), update:
  ```ts
  this._activePreviewSourceId = 'local-folder';
  this._activePreviewDocId = slugPrefix;
  this._activePreviewPath = filePath;
  this._setupActiveDocWatcher(filePath);
  ```
  Then, in the `previewReady` postMessage at line 1337, include `isAutoRefreshed: this._isAutoRefreshing`.
- [ ] In `_handleImportFullDoc` (line 1438), set `this._lastPanelWriteTimestamp = Date.now()` after EACH `writeContentToDocsDir` call — both in the multi-page loop (after line 1530) and the single-doc fallback (after line 1586). A single timestamp at method entry expires mid-import for multi-page docs.
- [ ] ~~In `_handleSyncToSource` (line 1355), set `this._lastPanelWriteTimestamp = Date.now()` before calling `adapter.updateContent(...)`~~ **REMOVED** — `_handleSyncToSource` writes to the REMOTE adapter, not local disk. The file watcher does not fire for remote writes. No gate needed.
- [ ] In `_handleAppendToPlannerPrompt` (line 1206), set `this._lastPanelWriteTimestamp = Date.now()` before calling `writeContentToDocsDir` or `writeFromPlanningCache`.
- [ ] In `dispose()`, add explicit cleanup before the existing loop:
  ```ts
  if (this._activeDocWatchDebounce) { clearTimeout(this._activeDocWatchDebounce); }
  if (this._activeDocWatcher) { this._activeDocWatcher.dispose(); }
  ```
  (Note: `_activeDocWatcher` is already in `_disposables`, so the loop would dispose it, but explicit cleanup is safer for ordering.)
- [ ] In `src/webview/planning.js`, in the `previewReady` handler (line 731), after setting `targetStatus.textContent = ''` (line 820), add:
  ```js
  if (msg.isAutoRefreshed) {
      targetStatus.textContent = 'Externally updated — refreshed';
      setTimeout(() => { if (targetStatus.textContent === 'Externally updated — refreshed') targetStatus.textContent = ''; }, 2000);
  }
  ```

**Edge Cases:**
- If the active doc is an online doc (ClickUp/Linear/Notion) cached locally, the watcher watches the cached file path in `.switchboard/docs/`, not the remote URL. `_handleFetchPreview` already resolves this path when it initializes the cache service.
- If the user switches active documents rapidly, the old watcher is disposed synchronously BEFORE creating the new one. The `_activePreviewPath` check in the callback provides a second layer of defense against stale events.
- If the file is deleted while the debounce timer is pending, the timer is cleared and the deletion state is posted immediately.
- Only `.md` files are relevant; the watcher is scoped to the specific resolved active file path.
- If a non-imported doc in `.switchboard/docs/` is previewed (direct path fallback in `_handleFetchDocsFile`), `_setupActiveDocWatcher` still receives the resolved `filePath` and watches it correctly.
- `_handleAppendToPlannerPrompt` writes to the docs directory and must be gated, or the watcher will fire and reload while the user is appending content.

**Clarification:** Auto-refresh does NOT need a user setting toggle. The plan scope is limited to automatic refresh; a toggle would be net-new product scope. If users report annoyance, a toggle can be added later.

### Step 3: Testing & Edge Cases

**Test scenarios:**
- [ ] Collapse/expand works with active document set and without
- [ ] Auto-refresh works for documents imported from both LOCAL and ONLINE sources
- [ ] Rapid external saves don't cause UI flicker (debouncing works)
- [ ] File deleted externally shows appropriate state, doesn't crash
- [ ] Panel reload preserves collapse state
- [ ] Switching between two local documents disposes the old watcher and creates a new one (verify via console.log or debugger)
- [ ] Importing a full document from ClickUp does NOT trigger the auto-refresh watcher (verify `_lastPanelWriteTimestamp` gates the event)
- [ ] Sync-to-source write does NOT trigger auto-refresh
- [ ] Append to planner prompt does NOT trigger auto-refresh on the active document
- [ ] Collapsed sidebar still allows selecting documents by clicking icons
- [ ] Online docs tab sidebar also collapses and shares the same collapsed state as local docs tab
- [ ] Non-imported docs in `.switchboard/docs/` (opened via direct path fallback) are watched correctly

## Verification Plan

### Automated Tests
- Add unit tests in `src/services/__tests__/` (or create `PlanningPanelProvider.ui.test.ts`) that:
  - [ ] Verify `_setupActiveDocWatcher` creates a watcher with the correct URI
  - [ ] Verify disposing the provider clears `_activeDocWatcher`, `_activePreviewPath`, and any pending debounce timers
  - [ ] Verify `_lastPanelWriteTimestamp` gates file events within 1 second
  - [ ] Verify `_lastPanelWriteTimestamp` is NOT set in `_handleSyncToSource` (remote write, no local file change)
  - [ ] Verify `_lastPanelWriteTimestamp` is set after each `writeContentToDocsDir` call in `_handleImportFullDoc` (both multi-page loop and single-doc fallback)
  - [ ] Verify `_lastPanelWriteTimestamp` is set before `writeContentToDocsDir`/`writeFromPlanningCache` in `_handleAppendToPlannerPrompt`
  - [ ] Verify `onDidDelete` posts `previewError` and disposes the watcher
  - [ ] Verify `_activePreviewPath`, `_activePreviewSourceId`, and `_activePreviewDocId` are updated in `_handleFetchPreview` and `_handleFetchDocsFile`
  - [ ] Verify `isAutoRefreshed` is `true` in `previewReady` messages when `_isAutoRefreshing` is set
  - [ ] Verify `isAutoRefreshed` is NOT added to `previewReady` in `_handleFetchPageContent` (page-level fetches)
  - [ ] Verify `_watcherGeneration` counter rejects stale watcher events after doc switch
  - [ ] Verify watcher creation failure (invalid path) logs error and continues without watching
- Add webview JS tests (if test harness exists) that:
  - [ ] Verify `toggleSidebarCollapsed` persists state via `vscode.setState`
  - [ ] Verify `collapsed` class is applied to `.content-row` on load when persisted state says collapsed
  - [ ] Verify `isAutoRefreshed` status indicator appears when `previewReady` has `isAutoRefreshed: true`

### Manual Tests
- [ ] Open Planning Panel → select a local doc → collapse sidebar → verify width reduces to ~40px
- [ ] Switch to Online Docs tab → verify sidebar is also collapsed
- [ ] Close and reopen panel → verify collapse state restored
- [ ] Open a local doc in an external editor → save → verify preview updates within ~1 second with "Externally updated" status
- [ ] Rapidly save the external file 5 times in 1 second → verify preview reloads only once after debounce
- [ ] Delete the active file externally → verify panel shows "File deleted externally" without crashing
- [ ] Import a full ClickUp doc → verify no auto-refresh flicker occurs
- [ ] Append the active document to planner prompt → verify no auto-refresh flicker occurs
- [ ] Open a non-imported `.md` file directly from `.switchboard/docs/` → verify external edits trigger auto-refresh

## Open Questions

1. Should the collapsed state be global or per-workspace? **Clarification:** Per-panel instance via `vscode.setState` is sufficient and simpler.
2. Should we show a badge/count of documents in collapsed state? **Not in scope.** This would require additional DOM elements and state tracking.
3. Should auto-refresh be toggleable (user setting)? **Not in scope.** Auto-refresh is the core value of this feature; a toggle adds unnecessary complexity for a first iteration.

## Files Expected to Change

```
src/services/PlanningPanelProvider.ts
src/webview/planning.html
src/webview/planning.js
```

## Success Criteria

- [ ] Docs list can be collapsed to minimal width with single click
- [ ] Collapse state persists across panel sessions
- [ ] Active document auto-reflects external file changes without manual action
- [ ] No noticeable performance impact from file watching

## Improve-Plan Review Findings

**Date:** 2026-05-04 (2nd rerun — full code verification)
**Workflow:** `/improve-plan`

### Verified (Code-Level)
- `planning.html:161-166` — `.content-row` grid layout (`280px 1fr`) confirmed. No existing `.collapsed` modifier.
- `planning.js:8-22` — State object lacks `docsListCollapsed`; confirmed insertion point after `analystAvailable: false`.
- `planning.html:1128,1162` — `#tree-pane` and `#tree-pane-online` each contain a single `.empty-state` div. Toggle button can be prepended as first child.
- `PlanningPanelProvider.ts:36` — `_docsFolderWatcher` field exists.
- `PlanningPanelProvider.ts:1076` — `_handleFetchPreview` exists. Handles local-folder (line 1081) and online docs (line 1099+).
- `PlanningPanelProvider.ts:1299` — `_handleFetchDocsFile` exists. Resolves paths via `cacheService.resolveImportedDocPath` (line 1305) or direct fallback (line 1310).
- `PlanningPanelProvider.ts:1355` — `_handleSyncToSource` writes to REMOTE adapter (`adapter.updateContent`, line 1426). Does NOT modify local file. **Timestamp gate is unnecessary here.**
- `PlanningPanelProvider.ts:1438` — `_handleImportFullDoc` exists. Multi-page import loop (lines 1518-1565) calls `writeContentToDocsDir` per page. **Single timestamp at method entry is insufficient — must set after each write.**
- `PlanningPanelProvider.ts:1206` — `_handleAppendToPlannerPrompt` exists. Calls `writeContentToDocsDir` (line 1211) or `writeFromPlanningCache` (line 1213). Timestamp gate IS needed.
- `PlanningPanelProvider.ts:1872-1880` — `dispose()` exists but lacks explicit `_activeDocWatcher` cleanup.
- **7 `previewReady` emission points:** lines 583, 1088, 1124, 1142, 1168, 1337, 1667. Lines 583 & 1667 are in `_handleFetchPageContent` (sub-page fetches — do NOT add `isAutoRefreshed`). Only lines 1088, 1124, 1142, 1168, 1337 need the flag.
- Kanban: Plan is in PLAN REVIEWED. `sess_1777415652953` (Research Tab) & `sess_1777428318801` (Workspace Root) are in CODE REVIEWED. New: `sess_1777583384344` (Unify Planning Panel DB) also CODE REVIEWED, touches `PlanningPanelProvider.ts` — medium conflict risk.

### Adversarial Review (2nd Pass)

**Stage 1 — Grumpy Critique:**

1. **7 `previewReady` emission points, plan only accounts for 3** — Found at lines 583, 1088, 1124, 1142, 1168, 1337, 1667. Lines 583 & 1667 are in `_handleFetchPageContent` (sub-page fetches, NOT doc-level previews). Adding `isAutoRefreshed` there is wrong — the watcher tracks the parent doc, not individual pages. Only lines 1088, 1124, 1142, 1168, 1337 need the flag.

2. **`_handleFetchDocsFile` vs `_handleFetchPreview` path resolution conflated** — `_handleFetchPreview` handles local-folder docs at line 1081 via `localFolderService.fetchDocContent`. `_handleFetchDocsFile` handles imported docs at line 1299 via `cacheService.resolveImportedDocPath`. The watcher must resolve the file path differently for each: local-folder uses `path.join(localFolderService.getFolderPath(), docId)`, imported docs use the already-resolved `filePath` from cache service.

3. **`_lastPanelWriteTimestamp` 1-second gate is too aggressive for multi-page imports** — `_handleImportFullDoc` has a multi-page loop (lines 1518-1565) that calls `writeContentToDocsDir` per page. A single timestamp at method entry expires mid-import. Must set `this._lastPanelWriteTimestamp = Date.now()` after EACH `writeContentToDocsDir` call in the loop, not just at method entry.

4. **`_handleSyncToSource` writes to REMOTE, not local disk** — Line 1426: `adapter.updateContent()`. This does NOT trigger the file watcher. The plan says to gate it with `_lastPanelWriteTimestamp`, but there's nothing to gate. Remove the gate from this method.

5. **`_watcherGeneration` counter from previous review is good but underspecified** — Need: `private _watcherGeneration = 0;`, increment in `_setupActiveDocWatcher`, capture `const gen = this._watcherGeneration` in closure, check `gen !== this._watcherGeneration` in callback before processing.

6. **New dependency: `sess_1777583384344` (Unify Planning Panel Database)** — Also in CODE REVIEWED, also modifies `PlanningPanelProvider.ts`. Medium merge conflict risk. Must sequence or isolate line ranges.

**Stage 2 — Balanced Synthesis:**

Valid: #1 (previewReady paths need precise enumeration), #2 (path resolution differs by handler), #3 (multi-page import gate timing), #4 (sync-to-source doesn't need gating), #5 (generation counter needs spec), #6 (new dependency).

Mitigations:
- #1: Only add `isAutoRefreshed` to 5 doc-level paths (1088, 1124, 1142, 1168, 1337). Skip page-level paths (583, 1667).
- #2: In `_handleFetchPreview` for local-folder, resolve path via `path.join(localFolderService.getFolderPath(), docId + '.md')`. In `_handleFetchDocsFile`, use the already-resolved `filePath`.
- #3: Set `_lastPanelWriteTimestamp` after each `writeContentToDocsDir` call in the multi-page loop (line 1524) and single-doc fallback (line 1586).
- #4: Remove `_lastPanelWriteTimestamp` from `_handleSyncToSource` — it writes remotely, not locally.
- #5: Add `_watcherGeneration` field, increment on each `_setupActiveDocWatcher` call, capture in closure, check in callback.
- #6: Coordinate with Unify DB plan; sequence this plan after it or isolate edits to non-overlapping line ranges.

The plan's core approach (active-preview tracking, timestamp gating, debounce) is sound. These are precision refinements, not architectural changes.

### Updated Implementation Details

**Step 1: Collapsible Sidebar** — No changes. CSS grid approach is sound. DOM structure verified: `#tree-pane` contains `.empty-state` as only child — toggle button can be prepended.

**Step 2: File Watcher** — Refinements from this review:
- **Remove `_lastPanelWriteTimestamp` from `_handleSyncToSource`** — remote write, no local file change.
- **Set `_lastPanelWriteTimestamp` after each `writeContentToDocsDir` in `_handleImportFullDoc`** — both in multi-page loop (after line 1530) and single-doc fallback (after line 1586).
- **Path resolution in `_handleFetchPreview`**: for local-folder, compute `path.join(localFolderService.getFolderPath(), docId + '.md')` and set `_activePreviewPath`. For online/cached docs, use the cached file path from `_cacheService`.
- **`isAutoRefreshed` flag**: Add to 5 doc-level `previewReady` calls only (lines 1088, 1124, 1142, 1168, 1337). Do NOT add to `_handleFetchPageContent` (lines 583, 1667).
- **`_watcherGeneration`**: Add field, increment in `_setupActiveDocWatcher`, capture in closure, check in callback:
  ```ts
  private _watcherGeneration = 0;
  // In _setupActiveDocWatcher:
  this._watcherGeneration++;
  const gen = this._watcherGeneration;
  // In onDidChange callback:
  if (gen !== this._watcherGeneration) return; // stale event
  ```
- Keep try-finally disposal and try-catch creation from previous review.

**Step 3: Testing** — Add test cases for:
- Watcher creation failure (invalid path)
- `_handleSyncToSource` does NOT set `_lastPanelWriteTimestamp`
- Multi-page import sets timestamp after each page write
- `_watcherGeneration` counter rejects stale events

### Remaining Risks
- Merge conflict with Research Tab plan (`sess_1777415652953`) and Unify DB plan (`sess_1777583384344`) — both in CODE REVIEWED, both touch `PlanningPanelProvider.ts`. Recommend sequencing this plan after both.
- `_handleFetchPreview` for online docs uses background cache refresh; auto-refresh watcher may race with it. 300ms debounce + `_watcherGeneration` guard mitigates but doesn't eliminate.
- `vscode.FileSystemWatcher` behavior may differ across platforms (Windows vs macOS) for disposal timing.

---

**Recommendation:** Send to Coder
