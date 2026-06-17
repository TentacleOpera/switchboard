# Online Docs Tab — Inline Editing & Unified Docs Model

## Goal

Eliminate the friction of the current import-to-local-then-switch workflow. Users should be able to view and edit online docs directly in the Online Docs tab, with a sync button to push changes back to the source. The local file is the working copy; the online source is the sync target — the same model the Tickets tab uses.

## Metadata

- **Complexity:** 6
- **Tags:** frontend, backend, ux, refactor

## User Review Required

Yes — the decision to collapse Online Docs and Local Docs into a single unified "Docs" tab (vs. keeping them separate with editing added to Online Docs) needs product sign-off before implementation.

## Problem Analysis

The current workflow to edit an online doc is:
1. Open Online Docs tab, find and view the doc
2. Click Import — doc is copied to `.switchboard/docs/`
3. Switch to Local Docs tab
4. Scroll through the list to find the imported doc
5. Edit it
6. Switch back to Online Docs tab to find the sync button

This is 6 steps with 2 tab switches for a task that should be 1 step. The underlying architecture already supports it: `_handleFetchDocsFile` reads the local `.md` cache file, and `_handleSyncToSource` pushes it back. The missing piece is just the edit surface in the Online Docs tab.

The deeper issue is that the Online Docs / Local Docs split is the wrong abstraction. From the user's perspective there is one thing: a doc. It may or may not be connected to an online source. The connection to an online source is metadata (a sync indicator), not a reason to live in a different tab.

## Requirements

### Option A — Inline editing in Online Docs tab (smaller change)

- When a doc is open in the Online Docs preview pane, show an Edit button
- Clicking Edit switches the preview to an editable textarea (same pattern as the Tickets tab edit mode)
- Saving writes to the local `.md` file
- The existing Sync button pushes the local file back to the source
- Import button remains for docs that haven't been fetched yet (first-time fetch)
- File watcher already added (see `_setupDocsFolderWatcher`) refreshes the panel when the file changes externally

### Option B — Unified Docs tab (larger change, better long-term)

- Merge Online Docs and Local Docs into a single Docs tab
- Each doc in the list shows a sync indicator: connected to source (ClickUp/Notion/Linear) or local-only
- Clicking a connected doc fetches latest from source if not yet local, then shows it in the edit pane
- Edit pane is always editable (no separate view/edit mode toggle needed)
- Save writes locally; Sync pushes to source
- Local-only docs have no sync button

**Recommendation: Option B.** Option A adds editing but leaves the confusing dual-tab model in place. The Local Docs tab becomes redundant once online docs are editable in place. Option B is more work upfront but removes a conceptual split that currently requires users to understand the import-to-local model.

## Complexity Audit

### Routine
- Adding `btn-edit-online`, `btn-save-online`, `btn-cancel-online` and `markdown-editor-online` textarea to `planning.html` (mirrors local docs pattern at lines ~2998–3000)
- Extending `state.editMode`, `state.editOriginalContent`, `state.dirtyFlags`, and `state.externalChangePending` in `planning.js` (line ~28) to include `online`
- Wiring `enterEditMode('online')` and `exitEditMode('online')` in `planning.js` (lines ~4832–4914) — follow existing `local`/`kanban` branches
- Adding `saveOnlineDocFile` message handler in `PlanningPanelProvider.ts` (around line ~1528 message switch) that resolves path via `cacheService.resolveImportedDocPath` and writes file
- Updating `switchToTab` and `loadDocumentPreview` in `planning.js` to exit online edit mode before tab/doc switches

### Complex / Risky
- **Edit mode state machine fragility:** `enterEditMode`/`exitEditMode` currently only handle `local`, `kanban`, and a broken `design` fallback. Adding `online` increases regression surface unless the functions are made source-agnostic. `design` tab currently falls through to `kanban-preview-pane` (line ~4836, ~4867).
- **File watcher jitter during active edit:** `_setupDocsFolderWatcher` (line ~534) triggers `_handleFetchImportedDocs` on every `.md` change in `.switchboard/docs/`. Writing the file during online edit will fire this, potentially re-rendering the imported docs list and resetting selection/scroll.
- **Phase 2 — View-layer unification:** `renderOnlineDocs` (line ~1493) and `renderLocalDocs` (line ~1131) emit separate DOM trees and message types. Merging them into `renderUnifiedDocs` requires consuming both `_sendLocalDocsReady` and `_handleFetchImportedDocs` outputs in one list without backend model changes.
- **Phase 2 — Data model merge (future):** `_sendLocalDocsReady` and `_handleFetchImportedDocs` post different message shapes (`localDocsReady` vs `importedDocsReady`). A true backend unification would require a new `_sendUnifiedDocsReady` method and retirement of the dual pipeline.
- **First-time fetch UX:** `_handleFetchPreview` (line ~4498) already auto-fetches from adapter and caches to `.switchboard/docs/` when a doc is not yet imported. The missing piece is surfacing an `Import first` error in the edit button state when `resolveImportedDocPath` returns null.
- **Conflict detection is already implemented:** `_handleSyncToSource` (line ~4970) performs SHA-256 hash comparison, fetches remote content, and shows a VS Code modal dialog for conflict resolution. This applies immediately to any doc edited inline; the plan should leverage it rather than marking it out of scope.

## Proposed Changes

### Phase 1 — Inline editing on Online Docs tab (unblocks agents immediately)

#### `src/webview/planning.html` (around line 3039)
- **Context:** Online Docs controls strip lacks edit/save/cancel buttons and the preview pane has no textarea.
- **Logic:** Mirror the Local Docs pattern (`btn-edit-local`, `btn-save-local`, `btn-cancel-local`, `markdown-editor-local`) in the Online Docs tab.
- **Implementation:**
  - Add `btn-edit-online`, `btn-save-online`, `btn-cancel-online` next to `#btn-import-full-doc-online` in `#controls-strip-online`.
  - Add `<textarea id="markdown-editor-online" class="markdown-editor" style="display:none; width:100%; height:100%; ...">` inside `#preview-pane-online`.
- **Edge Cases:** Ensure the new buttons reuse existing `.strip-btn` classes and the textarea uses the same CSS as `#markdown-editor-local` to avoid style drift.

#### `src/webview/planning.js` (lines ~28, ~421, ~955, ~1730, ~4832, ~4916)
- **Context:** `state.editMode` only supports `local` and `kanban`. `enterEditMode`/`exitEditMode` do not handle `online`.
- **Logic:** Extend edit-mode state machine to support a third tab key: `online`.
- **Implementation:**
  - Line ~28: Add `online: false` to `editMode`, `editOriginalContent`, `dirtyFlags`, and `externalChangePending`.
  - Line ~421 (`switchToTab`): Add `if (state.dirtyFlags.online && tabName !== 'online') { exitEditMode('online', true); }` and `if (state.editMode.online && tabName !== 'online') { exitEditMode('online', true); }`.
  - Line ~955 (`loadDocumentPreview`): Add `if (state.dirtyFlags.online) { exitEditMode('online', true); }` before loading a new doc.
  - Line ~1730 (`handlePreviewReady`): Add deferral guard for `state.editMode.online` on auto-refresh (mirror local logic: set `externalChangePending.online = true`, show warning in `#status-online`).
  - Line ~4832 (`enterEditMode`): Add `online` branch — resolve preview pane as `#preview-pane-online`, textarea as `#markdown-editor-online`, buttons as `#btn-edit-online` / `#btn-save-online` / `#btn-cancel-online`.
  - Line ~4864 (`exitEditMode`): Add `online` branch — toggle the same three buttons and remove `edit-mode` class from `#preview-pane-online`.
  - Line ~4916 (button wiring): Add event listeners for `#btn-edit-online` (enterEditMode), `#btn-save-online` (post `saveOnlineDocFile` with `slugPrefix: state.activeDocId` and textarea value), `#btn-cancel-online` (exitEditMode).
- **Edge Cases:** If the user switches tabs while online edit is dirty, changes are discarded without confirmation (matches current local behavior). Ensure `#btn-edit-online` is disabled when the doc is not yet imported (`resolveImportedDocPath` returns null).

#### `src/services/PlanningPanelProvider.ts` (around line 1528, new case in message switch)
- **Context:** No `saveOnlineDocFile` handler exists. The provider already handles `saveFileContent` (line ~2229) and `saveLocalTicketFile` (line ~2920).
- **Logic:** Resolve the local path via `cacheService.resolveImportedDocPath`, validate it lies within the workspace, write the content, and post a result message.
- **Implementation:**
  - Add `case 'saveOnlineDocFile':` in the main message switch near line 1528.
  - Resolve `workspaceRoot` via `this._resolveWorkspaceRoot(msg.workspaceRoot)`.
  - Get `workspaceId = await this._getWorkspaceId(workspaceRoot)`.
  - Call `localPath = await this._cacheService.resolveImportedDocPath(msg.slugPrefix, workspaceId)`.
  - If `!localPath`, post `saveOnlineDocFileResult` with `success: false, error: 'Document not imported yet'`.
  - Validate `localPath` is within workspace (reuse `saveFileContent` path guard logic).
  - Write with `fs.promises.writeFile(localPath, msg.content, 'utf8')`.
  - Update `this._lastPanelWriteTimestamp = Date.now()` (line ~5044 pattern) so the docs folder watcher can ignore self-induced writes.
  - Post `saveOnlineDocFileResult` with `success: true`.
- **Edge Cases:** Doc not yet imported → clear error message telling webview to import first. Path traversal attempt → reject with validation error.

#### `src/services/PlanningPanelProvider.ts` (around line 534, `_setupDocsFolderWatcher`)
- **Context:** The file watcher fires `_handleFetchImportedDocs` on every `.md` change, including writes from `saveOnlineDocFile`.
- **Logic:** Suppress the refresh when the write originated from the panel itself.
- **Implementation:** In `_setupDocsFolderWatcher`'s `refreshImportedDocs` callback, check `if (Date.now() - this._lastPanelWriteTimestamp < 2000) { return; }` before calling `_handleFetchImportedDocs`. `_lastPanelWriteTimestamp` is already updated during sync and file saves.
- **Edge Cases:** If an external agent edits the file within 2 seconds of a panel write, the refresh may be suppressed once. Acceptable trade-off; the next change will trigger it.

### Phase 2 — Unified Docs tab

#### `src/webview/planning.js` (around line 1493, new function)
- **Context:** `renderOnlineDocs` and `renderLocalDocs` produce separate DOM trees in separate tabs.
- **Logic:** Create a view-layer merge that consumes both `localDocsReady` and `importedDocsReady` messages and renders a single list.
- **Implementation:**
  - New function `renderUnifiedDocs(localRoots, onlineRoots, enabledSources)`.
  - Local docs inject `sourceId: 'local-only'`, `canSync: false`, `isLocalOnly: true`.
  - Online docs inject `sourceId` (clickup/linear/notion), `canSync: true` (if adapter supports sync), `isLocalOnly: false`.
  - Render a single `#tree-pane-unified` with source headers and doc cards, preserving search and workspace filter behavior.
- **Edge Cases:** Duplicate docs (same slug exists locally and online) — deduplicate by preferring the online entry with a `sync indicator` and keeping the local entry as a fallback row.

#### `src/webview/planning.html` (around line 3033)
- **Context:** Separate `#online-content` and `#local-content` tab bodies.
- **Logic:** Replace both with a single `#docs-content` tab that hosts the unified tree and preview.
- **Implementation:** Merge the two tab structures into one. Keep one tree pane, one preview pane, one controls strip. Retire `#tree-pane-online` and `#tree-pane` in favor of `#tree-pane-unified`.
- **Edge Cases:** Preserve persisted sidebar collapsed state and keyboard shortcuts.

#### `src/webview/planning.js` (around line 4832)
- **Context:** With a single Docs tab, there is no longer an "online" vs "local" edit mode — only a unified "docs" edit mode.
- **Logic:** Reuse the existing `local` edit mode machinery since the unified tab is essentially the local docs tab with extra online sources injected into the list.
- **Implementation:** Online docs selected from the unified list set `activeSource` to the real source ID (e.g. `clickup`). The edit path still resolves via `resolveImportedDocPath` and writes to `.switchboard/docs/`, exactly as Phase 1. Save and Sync behavior is identical.
- **Edge Cases:** Local-only docs have no sync button. Online docs show sync button only when `canSync` is true.

#### `src/services/PlanningPanelProvider.ts` (around line 4812 and 559)
- **Context:** `_handleFetchImportedDocs` and `_sendLocalDocsReady` emit separate messages.
- **Logic:** Eventually merge them into a single `_sendUnifiedDocsReady` method. This is a backend unification step to be done after the view-layer merge is stable.
- **Implementation:** (Future) Create `_sendUnifiedDocsReady` that gathers local docs + imported docs, merges them, and posts `unifiedDocsReady`. Update file watchers to call this instead of separate sends.
- **Edge Cases:** Preserve backward compatibility during transition by continuing to emit `localDocsReady` and `importedDocsReady` until the webview fully consumes `unifiedDocsReady`.

## Edge-Case & Dependency Audit

- **Race Conditions:** `_handleSyncToSource` and `saveOnlineDocFile` can race if the user clicks Sync immediately after Save. `saveFileContent` writes synchronously; `_handleSyncToSource` reads the file afterward. Safe as long as Save completes before Sync starts. No explicit re-entrancy guard exists on either handler.
- **Security:** `saveOnlineDocFile` must resolve the file path strictly within the workspace. `resolveImportedDocPath` (line ~535 in `PlanningPanelCacheService.ts`) uses DB lookup or directory scan limited to `.switchboard/docs/`. The new handler should reject any webview-supplied arbitrary path and fall back to the resolved path only.
- **Side Effects:** Writing to `.switchboard/docs/*.md` triggers `_setupDocsFolderWatcher` → `_handleFetchImportedDocs`. During active edit, this can cause list flicker. Mitigation: suppress the imported-docs refresh when the write originated from the panel itself (e.g., compare `_lastPanelWriteTimestamp` already tracked at line ~5044).
- **Dependencies & Conflicts:** Phase 2 unification touches both `_sendLocalDocsReady` (local folder service) and `_handleFetchImportedDocs` (DB-backed import registry). Both must continue to work independently during the transition. The `localWorkspaceRootFilter` and `onlineWorkspaceRootFilter` UI state would also need merging.

## Dependencies

- **Tickets tab file watcher fix** (already done) — proves the debounced refresh pattern works
- **`cacheService.resolveImportedDocPath`** must reliably return the local path for any imported doc (currently does; verified at `PlanningPanelCacheService.ts:535`)
- **`saveFileContent` path validation logic** (`PlanningPanelProvider.ts:2229`) — can be reused or referenced for the new `saveOnlineDocFile` handler
- **`_handleSyncToSource` conflict detection** (`PlanningPanelProvider.ts:4970`) — already implements remote hash comparison and modal resolution; applicable immediately

## Adversarial Synthesis

Key risks: (1) Adding a third edit mode to a fragile `enterEditMode`/`exitEditMode` state machine increases regression surface, especially given the existing `design` tab fallback bug; (2) The docs folder watcher fires on every write in `.switchboard/docs/`, which will jitter the imported docs list while a user is typing unless suppressed; (3) Option B's unified list model requires touching both `_sendLocalDocsReady` and `_handleFetchImportedDocs`, creating a dual-write hazard during transition. Mitigations: extend the edit-mode functions carefully with explicit `online` branches, add a `_panelWriteInProgress` guard or timestamp check in `_setupDocsFolderWatcher`, and implement Option B as view-layer unification first before merging backend data pipelines.

## Acceptance Criteria

- [ ] User can edit an online doc without leaving the Online Docs tab
- [ ] Save writes to the local `.md` file via `saveOnlineDocFile` → `resolveImportedDocPath` → `fs.promises.writeFile`
- [ ] Sync button pushes local changes back to the online source; existing conflict detection in `_handleSyncToSource` triggers if remote changed since last sync
- [ ] No tab switching required to go from viewing to editing
- [ ] File watcher keeps the pane live when an agent edits the file externally; auto-refresh defers reload if user is in online edit mode
- [ ] (Phase 2) Single Docs tab shows all docs regardless of source, with sync indicator per doc

## Verification Plan

### Automated Tests

- **Unit test `PlanningPanelCacheService.resolveImportedDocPath`:** Verify correct path resolution for hash-suffixed filenames (e.g., `docSlug_abc12345.md`) and collision suffixes (`_1`, `_2`).
- **Unit test `PlanningPanelProvider._handleSyncToSource` conflict detection:** Mock adapter with `fetchContent` returning changed content; assert modal flow and correct `updateLastSynced` call.
- **Integration test — online edit save → watcher → refresh:** Simulate webview posting `saveOnlineDocFile`, provider writing file, file watcher firing, and webview receiving `previewReady` with `isAutoRefreshed: true` while deferring reload because `editMode.online` is active.
- **UI test — end-to-end inline editing:** Click Edit on an imported online doc → textarea appears → modify content → Save → verify disk file updated → click Sync → verify `syncResult` success.
- **Regression test — local docs edit mode:** Confirm existing `local` edit/save/cancel flow remains unaffected after adding `online` branches.

> **Note:** Skip compilation and test execution for this session per directive. Tests will be run separately by the user.

**Recommendation: Send to Coder** (Complexity 6 — multi-file coordination with reused patterns, moderate risk from state machine extension).
