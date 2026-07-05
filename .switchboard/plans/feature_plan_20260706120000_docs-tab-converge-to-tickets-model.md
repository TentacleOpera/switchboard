# Converge Docs Tab to Tickets Tab Import/Edit/Sync Model

**Plan ID:** a1b2c3d4-e5f6-7890-abcd-ef1234567890

## Goal

Make the Docs tab's online-document workflow match the Tickets tab's proven model: **no explicit import step, auto-import on edit/save, prominent Push button, create-then-auto-import, and remove the confusing sync-mode dropdown.** A user should not need to configure two separate systems or understand a cache-warming dropdown to edit an online doc.

### Problem & background

The Docs tab and Tickets tab handle the same fundamental operation — editing a remote item locally and pushing changes back — with completely different UX:

- **Tickets tab (good):** Click a ticket → Edit → Save (auto-imports on save if no local file exists) → Push. Create flow creates on remote then immediately auto-imports. No import step, no dropdown.
- **Docs tab (broken):** Click an online doc → **must click Import first** → Edit → Save → find the hidden per-card "Sync" action. Create flow creates on remote but does NOT auto-import. Plus a confusing "Manual / Auto Sync All / Sync Selected Containers" dropdown that only warms a preview cache and has nothing to do with editing.

The user reports the Docs tab is unintelligible: they can't figure out how to edit an online doc, can't find the sync-back button, and don't understand the dropdown. The Tickets tab solves all of these problems already — this plan converges the Docs tab to that model.

### Root cause

The Docs tab was built with a "local-cache-as-middleman" architecture that requires an explicit registration step (`registerImport`) before editing. The Tickets tab was built later with a smarter pattern: auto-import-on-first-edit, where the import happens transparently inside the save handler. The Docs tab was never updated to match.

The sync-mode dropdown (`docs-cache-mode`) was added in commit `6f64897` as a cache-warming feature, but it only calls `cacheDocument()` (which writes to `.switchboard/planning-cache/` and does NOT create a `registerImport` DB entry). So it doesn't bypass the import requirement — it only makes preview loads faster. This is why the dropdown feels useless: it doesn't change the edit flow at all.

## Metadata

- **Tags**: ux, docs-tab, tickets-tab, convergence, sync, import, planning-panel
- **Complexity**: 6/10
- **Files**: src/webview/planning.html, src/webview/planning.js, src/services/PlanningPanelProvider.ts, src/services/PlanningPanelCacheService.ts, src/extension.ts

## Complexity Audit

**Routine:**
- Removing the `docs-cache-mode` dropdown and container picker from planning.html
- Removing the dropdown's event listener and message handlers from planning.js
- Removing `getPlanningPanelSyncMode`, `setPlanningPanelSyncMode`, `fetchAvailableSyncContainers`, `setPlanningPanelSelectedContainers` handlers from PlanningPanelProvider.ts
- Removing the `switchboard.triggerPlanningPanelSync` command registration from extension.ts (missed by the original dropdown-removal plan)
- Adding a "Push" button to the Docs tab preview meta bar (mirrors `btn-push-ticket`)
- Wiring the Push button to the existing `syncToSource` message

**Complex/Risky:**
- Auto-import on edit: modifying the Docs tab Edit button handler to auto-import if the doc isn't already imported (mirrors `saveLocalTicketFile` pattern at PlanningPanelProvider.ts:5440-5457)
- Auto-import after create: modifying `createOnlineDocument` handler to call `importFullDoc` logic after creating the remote doc (mirrors `clickupCreateTask` pattern at PlanningPanelProvider.ts:6383-6405)
- Removing `syncAllDocuments`, `syncSelectedContainers`, `startPeriodicSync`, `stopPeriodicSync`, `triggerSync` methods — must verify no other callers exist (extension.ts:974-985 is a caller the original plan missed)
- Migration: `planning.syncMode` and `planning.selectedContainers` config keys may exist in users' Kanban DBs (shipped in a released version, ~4,000 installs). Per CLAUDE.md, leave them harmlessly in the DB — they'll just never be read.

## Edge-Case & Dependency Audit

- **Auto-import on edit — what if the adapter can't fetch content?** The existing `importFullDoc` handler already handles this (returns error to webview). The auto-import-on-edit path should surface the same error rather than silently failing.
- **Auto-import on edit — race with preview load.** The preview may have loaded from cache (not imported). When user clicks Edit, we auto-import, which fetches fresh content. This could differ from what the user is looking at. Solution: after auto-import, reload the preview from the imported file, then enter edit mode. The Tickets tab handles this by importing on `editTicket` (not on save), then returning the file path — same pattern.
- **`createOnlineDocument` auto-import — adapter doesn't support `fetchContent`.** The `createDocument` response returns `{ docId, url }` but not content. For auto-import we need content. Since we just created an empty doc, we can import with empty content (or the title as a heading). The ClickUp create flow handles this with `preFetchedTask` — we can pass the create response similarly.
- **`triggerSync` external caller.** `extension.ts:974-985` registers `switchboard.triggerPlanningPanelSync` command which calls `planningPanelProvider.triggerSync()`. This must be removed alongside the sync methods, or it will fail to compile.
- **`_resolveSyncConfig` shared usage.** This method is used by `createOnlineDocument`, `syncDocToOnline`, `setPlanningPanelSelectedContainers`, and `setUploadLocation`. Removing the sync-mode handlers does NOT require removing `_resolveSyncConfig` — it still reads `browseFilterContainers`, `uploadLocations`, and `docMappings` which are used by the remaining create/sync-to-online flows.
- **`stopPeriodicSync` in `dispose()`.** Keep as a no-op safety call (the timer will never be started after removal, but `dispose()` may be called on an old panel instance that has a running timer from a previous session).
- **Tests.** Search for tests referencing `planningPanelSyncMode`, `docs-cache-mode`, `syncAllDocuments`, `syncSelectedContainers`, `triggerSync`, `startPeriodicSync`. The `PlanningPanelCacheService.persistence.test.ts` and `PlanningPanelCacheService.duplicate.test.ts` test `registerImport` (which we keep) — verify they don't reference the sync-mode methods.

## Proposed Changes

### Phase 1: Remove the sync-mode dropdown (the red herring)

#### 1.1 Remove dropdown and container picker from planning.html

**File:** `src/webview/planning.html`
**Lines:** 3569-3573 (dropdown) and 3584-3587 (container picker)
**Change:** Remove both elements:
```html
<!-- REMOVE: -->
<select id="docs-cache-mode" class="workspace-filter-select" ...>
    <option value="no-sync" selected>Manual</option>
    <option value="auto-sync-all">Auto Sync All</option>
    <option value="sync-selected">Sync Selected Containers</option>
</select>
<!-- REMOVE: -->
<div id="docs-sync-container-picker" style="display: none; ...">...</div>
```

#### 1.2 Remove dropdown event listener and message handlers from planning.js

**File:** `src/webview/planning.js`
**Change:** Remove:
- The `docs-cache-mode` change event listener (~line 1372-1385)
- The `getPlanningPanelSyncMode` message sends (~lines 1555 and 10936)
- The `planningPanelSyncModeReady` case (~lines 3948-3963)
- The `availableSyncContainersReady` case (~lines 3964-4019)

#### 1.3 Remove sync-mode handlers from PlanningPanelProvider.ts

**File:** `src/services/PlanningPanelProvider.ts`
**Change:** Remove these message cases:
- `getPlanningPanelSyncMode` (~lines 6753-6782)
- `setPlanningPanelSyncMode` (~lines 6784-6797)
- `fetchAvailableSyncContainers` (~lines 6798-6858)
- `setPlanningPanelSelectedContainers` (~lines 6860-6872)

Remove the `triggerSync` call on panel init (~lines 578-583):
```typescript
// REMOVE this block from panel init:
const { config, sourceRoot } = await this._resolveSyncConfig();
const syncMode = config.syncMode || 'no-sync';
if (syncMode !== 'no-sync' && sourceRoot) {
    await this.triggerSync(sourceRoot, syncMode);
}
```

#### 1.4 Remove triggerPlanningPanelSync command from extension.ts

**File:** `src/extension.ts`
**Lines:** 974-985
**Change:** Remove the `switchboard.triggerPlanningPanelSync` command registration entirely. This was missed by the original dropdown-removal plan.

#### 1.5 Remove sync methods from PlanningPanelProvider.ts

**File:** `src/services/PlanningPanelProvider.ts`
**Lines:** ~8682-8728 (`syncAllDocuments`), ~8730-8774 (`syncSelectedContainers`), ~8776-8797 (`startPeriodicSync`), ~8808-8831 (`triggerSync`)
**Change:** Remove all four methods. Keep `stopPeriodicSync()` (~lines 8799-8806) as a no-op safety in `dispose()`.

**Before removing, verify:**
```bash
grep -rn "syncAllDocuments\|syncSelectedContainers\|startPeriodicSync\|triggerSync" src/
```
Expected callers after steps 1.3-1.4: only `stopPeriodicSync()` in `dispose()` (line 9139) and the internal `startPeriodicSync` calls inside `triggerSync` (which is being removed).

#### 1.6 Clean up state fields

**File:** `src/services/PlanningPanelProvider.ts`
**Lines:** ~81-84
**Change:** Remove:
```typescript
private _periodicSyncTimer: NodeJS.Timeout | undefined;
private _currentSyncMode: string = 'no-sync';
private _syncCancellationSource: AbortController | undefined;
```

### Phase 2: Auto-import on edit (converge to Tickets tab model)

#### 2.1 Add auto-import to the Docs tab Edit button handler

**File:** `src/webview/planning.js`
**Lines:** ~3162-3185 (the `btnEdit.disabled = !isImported` block in the preview-ready handler)
**Change:** Instead of disabling Edit when `!isImported`, always enable it. When the user clicks Edit on an unimported online doc, send a new `editOnlineDoc` message that triggers auto-import on the backend, then enters edit mode on success.

```javascript
// BEFORE (planning.js ~3172-3178):
const isImported = state.importedDocs.has(state.activeDocId);
if (btnEdit) {
    btnEdit.disabled = !isImported;
    if (!isImported) {
        btnEdit.title = 'Import this document first to edit';
    } else {
        btnEdit.title = 'Edit document content';
    }
}

// AFTER:
if (btnEdit) {
    btnEdit.disabled = false;
    btnEdit.title = 'Edit document content';
}
```

Then modify the Edit button click handler (~line 6980) to check if the doc is imported. If not, send `editOnlineDoc` first (which auto-imports on the backend), wait for `editOnlineDocResult`, then enter edit mode:

```javascript
// New flow in btnEditDocs click handler:
btnEditDocs.addEventListener('click', async () => {
    const isOnline = ONLINE_SOURCES.includes(state.activeSource);
    const isImported = state.importedDocs.has(state.activeDocId);
    if (isOnline && !isImported) {
        // Auto-import first (mirrors Tickets tab editTicket flow)
        vscode.postMessage({
            type: 'editOnlineDoc',
            sourceId: state.activeSource,
            docId: state.activeDocId,
            docName: state.activeDocName
        });
        // editOnlineDocResult handler will call enterEditMode('docs')
    } else {
        enterEditMode('docs');
    }
});
```

#### 2.2 Add `editOnlineDoc` handler to PlanningPanelProvider.ts

**File:** `src/services/PlanningPanelProvider.ts`
**Change:** Add a new message case that mirrors the Tickets tab's `editTicket` handler (line 5474-5497). It auto-imports the online doc, then returns the file path so the webview can enter edit mode:

```typescript
case 'editOnlineDoc': {
    const sourceId = String(msg.sourceId || '');
    const docId = String(msg.docId || '');
    const docName = String(msg.docName || '');
    try {
        // Auto-import (reuses existing importFullDoc logic)
        const importResult = await this._handleAutoImportOnlineDoc(sourceId, docId, docName);
        if (importResult.success) {
            // Refresh imported docs list so the doc shows as imported
            await this._sendImportedDocsReady();
            this._panel?.webview.postMessage({
                type: 'editOnlineDocResult',
                success: true,
                sourceId, docId,
                filePath: importResult.filePath,
                docName
            });
        } else {
            this._panel?.webview.postMessage({
                type: 'editOnlineDocResult',
                success: false,
                error: importResult.error,
                sourceId, docId
            });
        }
    } catch (error) {
        this._panel?.webview.postMessage({
            type: 'editOnlineDocResult',
            success: false,
            error: error instanceof Error ? error.message : String(error),
            sourceId, docId
        });
    }
    break;
}
```

#### 2.3 Add `_handleAutoImportOnlineDoc` helper to PlanningPanelProvider.ts

**File:** `src/services/PlanningPanelProvider.ts`
**Change:** Extract the core import logic from the existing `importFullDoc` handler into a reusable private method. This avoids duplicating the import logic between the manual Import button and the auto-import-on-edit flow.

The method should:
1. Fetch the doc content via the adapter (`adapter.fetchContent(docId)` or `adapter.fetchDocContent(docId)` for ClickUp)
2. Compute content hash
3. Call `this._cacheService.registerImport(sourceId, docId, docName, slugPrefix, { remoteContentHash })`
4. Write the content to `.switchboard/docs/{slugPrefix}.md`
5. Return `{ success: true, filePath }`

#### 2.4 Handle `editOnlineDocResult` in planning.js

**File:** `src/webview/planning.js`
**Change:** Add a new message case:
```javascript
case 'editOnlineDocResult':
    if (msg.success) {
        // Update state to mark doc as imported
        state.importedDocs.set(msg.docId, {
            sourceId: msg.sourceId,
            docId: msg.docId,
            docName: msg.docName,
            canSync: true
        });
        // Update the active doc file path for save
        state.activeDocFilePath = msg.filePath;
        // Enter edit mode
        enterEditMode('docs');
    } else {
        if (statusEl) statusEl.textContent = `Edit failed: ${msg.error}`;
    }
    break;
```

### Phase 3: Add prominent Push button (converge to Tickets tab model)

#### 3.1 Add Push button to Docs tab preview area

**File:** `src/webview/planning.html`
**Change:** Add a "Push" button next to the existing Edit/Save/Cancel buttons in the Docs tab controls strip (~line 3577):
```html
<button id="btn-push-doc" class="strip-btn" disabled title="Push local changes to the online source">Push</button>
```

#### 3.2 Wire Push button in planning.js

**File:** `src/webview/planning.js`
**Change:** Add click handler that sends the existing `syncToSource` message (the backend handler `_handleSyncToSource` already exists and works):
```javascript
const btnPushDoc = document.getElementById('btn-push-doc');
if (btnPushDoc) {
    btnPushDoc.addEventListener('click', () => {
        if (!state.activeDocId || !state.importedDocs.has(state.activeDocId)) return;
        btnPushDoc.disabled = true;
        btnPushDoc.textContent = 'Pushing…';
        vscode.postMessage({
            type: 'syncToSource',
            slugPrefix: state.activeDocId
        });
    });
}
```

Enable the Push button whenever an imported online doc is selected (in `updateSyncButtonVisibility` or a similar update function). Disable it when the doc is not imported or not an online source.

#### 3.3 Handle `syncResult` to re-enable Push button

**File:** `src/webview/planning.js`
**Change:** In the existing `syncResult` handler (or add one if it doesn't handle the Push button), re-enable the Push button and update its label:
```javascript
case 'syncResult':
    const btnPush = document.getElementById('btn-push-doc');
    if (btnPush) {
        btnPush.disabled = false;
        btnPush.textContent = 'Push';
    }
    if (msg.success) {
        if (statusEl) statusEl.textContent = msg.message || 'Pushed to remote';
    } else {
        if (statusEl) statusEl.textContent = `Push failed: ${msg.error}`;
    }
    break;
```

### Phase 4: Auto-import after create (converge to Tickets tab model)

#### 4.1 Modify `createOnlineDocument` handler to auto-import after creation

**File:** `src/services/PlanningPanelProvider.ts`
**Lines:** 6646-6650 (the success branch of `createOnlineDocument`)
**Change:** After `adapter.createDocument({ parentId, title })` succeeds, auto-import the created doc (mirrors `clickupCreateTask` pattern at line 6383-6405). Since the created doc is empty, import with the title as initial content:

```typescript
// AFTER (line ~6647):
const result = await adapter.createDocument({ parentId, title });
if (result.success && result.docId) {
    // Auto-import the created doc so it's immediately editable
    try {
        const initialContent = `# ${title}\n`;
        const slugPrefix = this._generateSlugPrefix(title);
        const contentHash = crypto.createHash('sha256').update(initialContent).digest('hex');
        await this._cacheService.registerImport(sourceId, result.docId, title, slugPrefix, {
            remoteContentHash: contentHash
        });
        // Write the local file
        const docsDir = path.join(this._getWorkspaceRoot() || '', '.switchboard', 'docs');
        const fileName = `${slugPrefix}_${contentHash.slice(0, 8)}.md`;
        const filePath = path.join(docsDir, fileName);
        await fs.promises.mkdir(docsDir, { recursive: true });
        await fs.promises.writeFile(filePath, initialContent, 'utf8');
    } catch (importErr) {
        console.error('[PlanningPanel] Created online doc but local import failed:', importErr);
        // Don't fail the whole operation — the doc was created remotely
    }
    this._sendOnlineDocsReady();
    await this._sendImportedDocsReady();
    this._panel?.webview.postMessage({
        type: 'onlineDocCreated',
        success: true,
        docId: result.docId,
        url: result.url,
        sourceId,
        autoImported: true
    });
} else { ... }
```

#### 4.2 Update `onlineDocCreated` handler in planning.js to select and make editable

**File:** `src/webview/planning.js`
**Lines:** 4329-4338
**Change:** After creation + auto-import, select the new doc and show it as editable:
```javascript
case 'onlineDocCreated':
    if (msg.success && msg.docId) {
        vscode.postMessage({ type: 'refreshSource', sourceId: msg.sourceId });
        vscode.postMessage({ type: 'fetchImportedDocs' });
        setTimeout(() => {
            loadDocumentPreview(msg.sourceId, msg.docId, msg.docName || 'New Document');
        }, 800);
        if (msg.autoImported) {
            if (statusEl) statusEl.textContent = 'Document created and ready to edit';
        }
    } else if (msg.error) {
        if (statusEl) statusEl.textContent = `Create failed: ${msg.error}`;
    }
    break;
```

### Phase 5: Remove the hidden "Sync to Online" strip button (replaced by Push)

#### 5.1 Remove `btn-sync-to-online` from planning.html

**File:** `src/webview/planning.html`
**Line:** 3580
**Change:** Remove the `<button id="btn-sync-to-online">` element. The Push button (Phase 3) replaces it for the push-local-to-remote flow. The multi-step "Sync to Online" modal (lines 3972-4022) can be kept for now as the "create remote from local doc" flow (different use case — pushing a purely local doc to a remote source for the first time), but the strip button that opens it should be moved to a less prominent location (e.g., an overflow menu or the per-doc action menu) to avoid confusion with the new Push button.

**Alternative:** Keep `btn-sync-to-online` but rename it to "Copy to Online…" to distinguish from "Push" (which updates an existing linked remote doc). The "Copy to Online" flow creates a NEW remote doc from a local file; "Push" updates the EXISTING linked remote doc.

## Verification Plan

1. **Dropdown removed:**
   - Open Docs tab → verify no "Manual / Auto Sync All / Sync Selected Containers" dropdown
   - Verify no container picker panel
   - Verify no JS console errors

2. **Auto-import on edit (the key convergence test):**
   - Browse to an online source (ClickUp/Linear/Notion)
   - Click an online doc that has NOT been imported
   - Click **Edit** → verify it enters edit mode immediately (no "Import first" tooltip)
   - Make a change → **Save** → verify the local file is written
   - Verify the doc now appears in the imported docs list

3. **Push button works:**
   - After editing + saving an imported online doc
   - Click **Push** → verify changes are pushed to the remote source
   - Verify the Push button shows "Pushing…" then reverts to "Push"
   - Verify success/error status message

4. **Create new online doc → immediately editable:**
   - Click "+ New" on an online source section
   - Enter a title → create
   - Verify the new doc appears in the sidebar AND in the imported docs list
   - Click Edit → verify it works immediately (no separate import step needed)

5. **Existing imported docs still work:**
   - Select an already-imported online doc
   - Edit → Save → Push → verify the full round-trip still works

6. **Local docs unaffected:**
   - Create/edit a local .md doc → verify no import/push buttons appear (local docs don't have a remote to push to)

7. **Migration safety:**
   - For a user who previously set `planning.syncMode` to `auto-sync-all`:
     - Open the panel → verify no errors
     - Verify no periodic sync timer starts
     - Verify the orphaned config key doesn't cause issues

8. **Compile check:**
   - `npm run compile` — verify no TypeScript errors from removed methods/handlers
   - Verify `extension.ts` compiles after removing `triggerPlanningPanelSync` command

9. **Run existing tests:**
   - `npm test` — verify no regressions
   - Search for tests referencing removed handlers:
     ```bash
     grep -rn "planningPanelSyncMode\|setPlanningPanelSyncMode\|syncAllDocuments\|syncSelectedContainers\|docs-cache-mode\|triggerPlanningPanelSync" src/test/
     ```

## What this plan does NOT do (out of scope)

- **Unifying the config systems** (planning.syncMode vs ticketSaveLocation/autoPullEnabled) — the dropdown removal eliminates `planning.syncMode`, but the remaining config keys (`planning.docMappings`, `planning.uploadLocations`) are still used by the create/sync-to-online flows. Full config unification is a separate effort.
- **Adding a top-level "+ New Doc" button** to the Docs controls strip — the per-source "+ New" button in the sidebar is adequate once auto-import-after-create works. A top-level button can be added later if discoverability is still an issue.
- **Adding conflict detection to the Push flow** — the Docs tab's existing `_handleSyncToSource` already has content-hash conflict detection (which the Tickets tab lacks). This is kept as-is.
- **Removing the "Sync to Online" modal** — this serves a different purpose (copying a local-only doc to a remote source for the first time). It should be relabeled but not removed.
