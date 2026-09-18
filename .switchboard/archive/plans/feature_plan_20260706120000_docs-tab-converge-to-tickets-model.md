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

- **Tags**: ux, ui, refactor, docs
- **Complexity**: 6/10
- **Files**: src/webview/planning.html, src/webview/planning.js, src/services/PlanningPanelProvider.ts, src/services/SetupPanelProvider.ts, src/extension.ts

## User Review Required

Yes — before coding. This plan removes user-facing UI (the sync-mode dropdown), changes the Docs-tab edit flow (auto-import on Edit instead of a required Import step), and adds a new Push button. A user who currently relies on the "Auto Sync All" / "Sync Selected Containers" cache-warming behavior will lose it. Confirm: (a) the dropdown removal is desired even though it removes the only cache-warming entry point; (b) auto-import-on-edit is the preferred convergence (vs. keeping a one-click Import); (c) the "Sync to Online" modal is kept (relabeled "Copy to Online…") rather than removed. The adversarial review below flagged several compile-breaking and data-loss risks that were corrected in this revision — review the corrected Phases 1–4 before approving.

## Complexity Audit

**Routine:**
- Removing the `docs-cache-mode` dropdown and container picker from planning.html
- Removing the dropdown's event listener and message handlers from planning.js
- Removing `getPlanningPanelSyncMode`, `setPlanningPanelSyncMode`, `fetchAvailableSyncContainers`, `setPlanningPanelSelectedContainers` handlers from PlanningPanelProvider.ts
- Removing the `switchboard.triggerPlanningPanelSync` command registration from extension.ts (missed by the original dropdown-removal plan)
- Adding a "Push" button to the Docs tab preview meta bar (mirrors `btn-push-ticket`)
- Wiring the Push button to the existing `syncToSource` message

**Complex/Risky:**
- Auto-import on edit: modifying the Docs tab Edit button handler to auto-import if the doc isn't already imported. **Reuses the existing `_handleImportFullDoc` (PlanningPanelProvider.ts:8209) wholesale** — NOT a simplified extraction — so the concurrency guard (`_importInProgress`), duplicate check (`duplicateDetected`), and multi-page ClickUp subpage handling (`listDocPages`/`fetchPageContent`, 8298+) are preserved. Mirrors `editTicket` (5459) → `editTicketResult`, reacting via the existing `importFullDocResult` channel.
- Auto-import after create: modifying `createOnlineDocument` (success branch at **6632-6635**, not 6646) to call `_handleImportFullDoc` after creating the remote doc. Mirrors `clickupCreateTask` pattern (6375-6413) which calls `switchboard.importTaskAsDocument` with `preFetchedTask`. Verified: ClickUp/Linear `fetchContent` (ClickUpDocsAdapter.ts:132, LinearDocsAdapter.ts:65) returns content or `''` for a freshly-created empty doc, so the import path is safe on a new empty doc.
- Removing `syncAllDocuments` (8663), `syncSelectedContainers` (8711), `startPeriodicSync` (8757), `triggerSync` (8789) methods — confirmed callers: `extension.ts:974-985` (`switchboard.triggerPlanningPanelSync` command) AND `SetupPanelProvider.ts:1627-1633` (`_triggerPlanningPanelSync` calls the same command). Both must be removed together.
- **SetupPanelProvider dead twin (NEW — missed by the original plan).** `SetupPanelProvider.ts` lines 889-940 handle the same four sync-mode messages, and 1539-1633 define six now-dead private methods (`_getPlanningPanelSyncMode`, `_setPlanningPanelSyncMode`, `_fetchAvailableSyncContainers`, `_setPlanningPanelSelectedContainers`, `_getPlanningPanelSelectedContainers`, `_triggerPlanningPanelSync`). Verified dead: `setup.html` has no `docs-cache-mode` element and does not load `planning.js`; `setup.js` sends none of these messages. Remove alongside Phase 1.
- **`stopPeriodicSync` vs removed state fields — compile-break risk (resolved).** `stopPeriodicSync` (8780-8786) references `_periodicSyncTimer` and `_syncCancellationSource`. Resolution: KEEP all three state fields (81-83) and KEEP `stopPeriodicSync` as a true no-op (it clears already-undefined values). Do NOT delete the fields. This avoids a compile break and matches CLAUDE.md's "leave orphaned state harmlessly" migration posture.
- Migration: `planning.syncMode` and `planning.selectedContainers` config keys may exist in users' Kanban DBs (shipped in a released version, ~4,000 installs). Per CLAUDE.md, leave them harmlessly in the DB — they'll just never be read.

## Edge-Case & Dependency Audit

- **Auto-import on edit — what if the adapter can't fetch content?** The existing `importFullDoc` handler already handles this (returns error to webview). The auto-import-on-edit path should surface the same error rather than silently failing.
- **Auto-import on edit — race with preview load.** The preview may have loaded from cache (not imported). When user clicks Edit, we auto-import, which fetches fresh content. This could differ from what the user is looking at. Solution: after auto-import, reload the preview from the imported file, then enter edit mode. The Tickets tab handles this by importing on `editTicket` (not on save), then returning the file path — same pattern.
- **`createOnlineDocument` auto-import — adapter doesn't support `fetchContent`.** The `createDocument` response returns `{ docId, url }` but not content. For auto-import we need content. Since we just created an empty doc, we can import with empty content (or the title as a heading). The ClickUp create flow handles this with `preFetchedTask` — we can pass the create response similarly.
- **`triggerSync` external caller.** `extension.ts:974-985` registers `switchboard.triggerPlanningPanelSync` command which calls `planningPanelProvider.triggerSync()`. This must be removed alongside the sync methods, or it will fail to compile.
- **`_resolveSyncConfig` shared usage.** This method is used by `createOnlineDocument`, `syncDocToOnline`, `setPlanningPanelSelectedContainers`, and `setUploadLocation`. Removing the sync-mode handlers does NOT require removing `_resolveSyncConfig` — it still reads `browseFilterContainers`, `uploadLocations`, and `docMappings` which are used by the remaining create/sync-to-online flows.
- **`stopPeriodicSync` in `dispose()`.** Keep as a no-op safety call (the timer will never be started after removal, but `dispose()` may be called on an old panel instance that has a running timer from a previous session).
- **Tests.** Search for tests referencing `planningPanelSyncMode`, `docs-cache-mode`, `syncAllDocuments`, `syncSelectedContainers`, `triggerSync`, `startPeriodicSync`. The `PlanningPanelCacheService.persistence.test.ts` and `PlanningPanelCacheService.duplicate.test.ts` test `registerImport` (which we keep) — verify they don't reference the sync-mode methods. Also grep for SetupPanelProvider sync method names (`_getPlanningPanelSyncMode`, `_triggerPlanningPanelSync`) in case any test exercises the dead twin.
- **Push button `slugPrefix` (CORRECTED).** The original Phase 3.2 sample sent `slugPrefix: state.activeDocId`. `_handleSyncToSource` (8125) resolves imports by slugPrefix via `getImportBySlugPrefix`, and `state.activeDocId` can hold the docId (not the slugPrefix) depending on the selection path. The codebase already has `resolveActiveOnlineSlugPrefix()` (planning.js:2322-2326) used by every existing sync send (3786, 6957, 6995). The Push button MUST use `resolveActiveOnlineSlugPrefix()`, not `state.activeDocId`, or it returns "Import entry not found."
- **No `_sendImportedDocsReady` / `_generateSlugPrefix` (CORRECTED).** Neither method exists. The real refresh is `_handleFetchImportedDocs(workspaceRoot)` (PlanningPanelProvider.ts:7971); the real slug logic is inline in `_handleImportFullDoc` (8268-8272). Phases 2 and 4 now route through `_handleImportFullDoc` instead of calling these ghosts.
- **`syncResult` duplicate-case risk (CORRECTED).** There are already two `syncResult` handlers in planning.js — a per-row one (3807, keyed on `msg.slugPrefix`) and a global one (5089). Phase 3.3 must EXTEND the existing global `syncResult` case (5089) to re-enable `btn-push-doc`; it must NOT declare a new `case 'syncResult':` in the same switch (SyntaxError) or in the per-row switch (Push button never re-enables).
- **`createOnlineDocument` success anchor (CORRECTED).** The success branch that posts `onlineDocCreated` is at **6632-6635**, not 6646-6650. The original anchor pointed at the `setUploadLocation` case. Phase 4.1 edits 6632-6635.

## Dependencies

None identified. This plan is self-contained within the "Docs Tab UX Convergence to Tickets Model" feature — no prior Switchboard session plans are required to land first. The redundant dropdown-removal plan (`32c21511`) was dropped as fully subsumed by Phase 1. Cross-file ordering within this plan: Phase 1 (dropdown removal + SetupPanelProvider dead-code cleanup) must land before Phase 2–4, because the auto-import/Push work touches the same planning.js message handlers and the same PlanningPanelProvider.ts region; doing them in parallel risks merge conflicts and dangling references to removed handlers.

## Adversarial Synthesis

Key risks: (1) a Push button that silently fails because it sends the docId instead of the slugPrefix; (2) a compile break from deleting state fields that the retained `stopPeriodicSync` still references; (3) silent data loss of ClickUp multi-page subpages if auto-import uses a simplified helper instead of the full `_handleImportFullDoc`; (4) a 100-line dead sync-mode twin left rotting in `SetupPanelProvider.ts`. Mitigations: route both auto-import-on-edit and auto-import-after-create through the existing `_handleImportFullDoc` + `importFullDocResult` channel (kills the nonexistent-method bug, the subpage-loss bug, and the duplicated logic in one stroke); use `resolveActiveOnlineSlugPrefix()` for the Push send; keep the three state fields so `stopPeriodicSync` compiles as a no-op; add Phase 1.7 to remove the SetupPanelProvider dead twin; pin Phase 3.3 to extend the existing global `syncResult` handler.

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
**Lines:** 8663 (`syncAllDocuments`), 8711 (`syncSelectedContainers`), 8757 (`startPeriodicSync`), 8789 (`triggerSync`)
**Change:** Remove all four methods. **KEEP `stopPeriodicSync()` (8780-8786) as a true no-op** — `dispose()` (9120) still calls it, and it is harmless once the timer/source are always undefined.

**Before removing, verify:**
```bash
grep -rn "syncAllDocuments\|syncSelectedContainers\|startPeriodicSync\|triggerSync" src/
```
Confirmed callers: `extension.ts:979` (removed in 1.4), `SetupPanelProvider.ts:1629` (removed in 1.7), the internal `startPeriodicSync` calls inside `triggerSync` (removed with it), and `stopPeriodicSync()` in `dispose()` (9120, kept). After 1.4 + 1.7 land, the only remaining references are the kept `stopPeriodicSync` and its `dispose()` call.

#### 1.6 Keep state fields (CORRECTED — do NOT remove)

**File:** `src/services/PlanningPanelProvider.ts`
**Lines:** 81-83
**Change:** **KEEP all three fields.** The original plan proposed removing them, but `stopPeriodicSync` (kept in 1.5) references `_periodicSyncTimer` (8781) and `_syncCancellationSource` (8785-8786); deleting the fields breaks compilation. Once `startPeriodicSync`/`triggerSync` are removed, these fields are never written, so `stopPeriodicSync` clears already-undefined values — a harmless no-op. This also matches CLAUDE.md's migration posture (leave orphaned state harmlessly rather than risk a missed reference).
```typescript
// KEEP (do not delete) — stopPeriodicSync still references these:
private _periodicSyncTimer: NodeJS.Timeout | undefined;
private _currentSyncMode: string = 'no-sync';
private _syncCancellationSource: AbortController | undefined;
```

#### 1.7 Remove the SetupPanelProvider dead sync-mode twin (NEW)

**File:** `src/services/SetupPanelProvider.ts`
**Lines:** 889-940 (four message handlers) and 1539-1633 (six private methods: `_getPlanningPanelSyncMode`, `_setPlanningPanelSyncMode`, `_fetchAvailableSyncContainers`, `_setPlanningPanelSelectedContainers`, `_getPlanningPanelSelectedContainers`, `_triggerPlanningPanelSync`)
**Change:** Remove all of it. Verified dead: `setup.html` contains no `docs-cache-mode` element and does not load `planning.js`; `setup.js` sends none of `getPlanningPanelSyncMode`/`setPlanningPanelSyncMode`/`fetchAvailableSyncContainers`/`setPlanningPanelSelectedContainers`. This twin was left behind by an earlier refactor and is the second caller of the `switchboard.triggerPlanningPanelSync` command deleted in 1.4 — leaving it would let `_triggerPlanningPanelSync` (1627-1633) silently no-op inside a try/catch, invisible rot. Removing it completes the dropdown's full footprint removal.

**Before removing, verify no test exercises the twin:**
```bash
grep -rn "_getPlanningPanelSyncMode\|_setPlanningPanelSyncMode\|_fetchAvailableSyncContainers\|_setPlanningPanelSelectedContainers\|_triggerPlanningPanelSync\|_getPlanningPanelSelectedContainers" src/test/
```

### Phase 2: Auto-import on edit (converge to Tickets tab model)

> **Design decision (from adversarial review):** Reuse the EXISTING `importFullDoc` message and `importFullDocResult` channel — do NOT introduce a parallel `editOnlineDoc`/`editOnlineDocResult` pair or a new `_handleAutoImportOnlineDoc` helper. The existing `_handleImportFullDoc` (PlanningPanelProvider.ts:8209) already carries the concurrency guard (`_importInProgress`), the duplicate check (`duplicateDetected`), and the multi-page ClickUp subpage handling (`listDocPages`/`fetchPageContent`, 8298+). A simplified extraction would silently drop subpages on multi-page docs. This mirrors the Tickets tab exactly: `editTicket` (5459) calls the real import command and reacts to `editTicketResult`; here, Edit calls the real `importFullDoc` and reacts to `importFullDocResult`.

#### 2.1 Always enable the Docs Edit button (remove the import gate)

**File:** `src/webview/planning.js`
**Lines:** 3163-3179 (the `else` branch of the preview-ready handler that disables `btnEdit` when `!isImported`)
**Change:** Instead of disabling Edit when `!isImported`, always enable it:
```javascript
// BEFORE (planning.js 3165-3173):
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

#### 2.2 Modify the Edit click handler to auto-import-then-edit

**File:** `src/webview/planning.js`
**Lines:** 6968-6974 (the `btnEditDocs` click handler, currently just `enterEditMode('docs')`)
**Change:** When the user clicks Edit on an unimported online doc, set an `editPending` flag and send the EXISTING `importFullDoc` message (the same message the manual Import button sends). The existing `importFullDocResult` handler (extended in 2.3) then enters edit mode once the import succeeds. If the doc is already imported (or is a local source), enter edit mode immediately as today.

```javascript
// AFTER (planning.js 6968-6974):
const btnEditDocs = document.getElementById('btn-edit');
if (btnEditDocs) {
    btnEditDocs.addEventListener('click', () => {
        const isOnline = ONLINE_SOURCES.includes(state.activeSource);
        const isImported = state.importedDocs.has(state.activeDocId);
        if (isOnline && !isImported) {
            // Auto-import first via the existing importFullDoc path (mirrors editTicket).
            // _handleImportFullDoc preserves subpages + dup-check + concurrency guard.
            state.editPending = true;
            vscode.postMessage({
                type: 'importFullDoc',
                sourceId: state.activeSource,
                docId: state.activeDocId,
                docName: state.activeDocName
            });
            // importFullDocResult handler (2.3) will call enterEditMode('docs') on success.
        } else {
            enterEditMode('docs');
        }
    });
}
```
Add `editPending: false` to the `state` object near its declaration (planning.js:17 area) so the flag has a defined home.

#### 2.3 Extend the existing `importFullDocResult` handler to honor `editPending`

**File:** `src/webview/planning.js`
**Lines:** 4413-4442 (the existing `case 'importFullDocResult':`)
**Change:** Do NOT add a new case. In the existing success branch, after the current refresh logic, check `state.editPending`: if set, clear it and call `enterEditMode('docs')` (the import already wrote the local file and refreshed the imported-docs list via `fetchImportedDocs` at line 4419, so edit mode loads the freshly-imported content). On failure, clear `editPending` and surface the error.
```javascript
// Inside the existing case 'importFullDocResult' success branch (after line ~4442):
if (state.editPending) {
    state.editPending = false;
    enterEditMode('docs');
}
// In the existing failure path (msg.success === false / msg.error):
if (state.editPending) {
    state.editPending = false;
    if (statusEl) statusEl.textContent = `Edit failed: ${msg.error || 'import failed'}`;
}
```
Note: the existing handler already posts `fetchImportedDocs` (4419), which is the backend's `_handleFetchImportedDocs` (PlanningPanelProvider.ts:7971) — this is the real "refresh imported docs list" step. No `_sendImportedDocsReady()` call is needed (that method does not exist).

#### 2.4 Backend: no new handler required

**File:** `src/services/PlanningPanelProvider.ts`
**Change:** NONE for Phase 2. The existing `case 'importFullDoc':` (line 2652) already dispatches to `_handleImportFullDoc` (8209), which fetches content, computes the hash, calls `registerImport`, writes the local file, handles subpages/duplicates/concurrency, and posts `importFullDocResult`. The original plan's `_handleAutoImportOnlineDoc` helper and `editOnlineDocResult` message are DROPPED — they duplicated this path, called nonexistent methods (`_sendImportedDocsReady`, `_generateSlugPrefix`), and would have lost multi-page subpages.

### Phase 3: Add prominent Push button (converge to Tickets tab model)

#### 3.1 Add Push button to Docs tab preview area

**File:** `src/webview/planning.html`
**Change:** Add a "Push" button next to the existing Edit/Save/Cancel buttons in the Docs tab controls strip (~line 3577):
```html
<button id="btn-push-doc" class="strip-btn" disabled title="Push local changes to the online source">Push</button>
```

#### 3.2 Wire Push button in planning.js

**File:** `src/webview/planning.js`
**Change:** Add click handler that sends the existing `syncToSource` message (the backend handler `_handleSyncToSource` at PlanningPanelProvider.ts:8125 already exists and works). **CORRECTED:** use `resolveActiveOnlineSlugPrefix()` (planning.js:2322-2326) for the `slugPrefix` — NOT `state.activeDocId`. `_handleSyncToSource` resolves imports via `getImportBySlugPrefix(slugPrefix)`, and `activeDocId` can hold the docId rather than the slugPrefix depending on the selection path; sending the docId returns "Import entry not found." Every existing sync send (3786, 6957, 6995) already uses `resolveActiveOnlineSlugPrefix()`.
```javascript
const btnPushDoc = document.getElementById('btn-push-doc');
if (btnPushDoc) {
    btnPushDoc.addEventListener('click', () => {
        const slugPrefix = resolveActiveOnlineSlugPrefix();
        if (!slugPrefix || !state.importedDocs.has(state.activeDocId)) return;
        btnPushDoc.disabled = true;
        btnPushDoc.textContent = 'Pushing…';
        vscode.postMessage({
            type: 'syncToSource',
            slugPrefix
        });
    });
}
```
The guard `state.importedDocs.has(state.activeDocId)` is safe because `importedDocs` is keyed by slugPrefix, docId, AND docName (planning.js:3627-3633), so the membership check succeeds regardless of which key `activeDocId` holds.

Enable the Push button whenever an imported online doc is selected (in `updateSyncButtonVisibility` or a similar update function). Disable it when the doc is not imported or not an online source.

#### 3.3 Extend the existing global `syncResult` handler to re-enable the Push button

**File:** `src/webview/planning.js`
**Change:** **CORRECTED — do NOT add a new `case 'syncResult':`.** There are already two `syncResult` handlers: a per-row one (3807, keyed on `msg.slugPrefix`) and a global one (5089). Re-declaring `case 'syncResult':` in the same switch is a SyntaxError, and adding it to the per-row switch means the Push button never re-enables. Instead, EXTEND the existing global `syncResult` case (5089) to also re-enable `btn-push-doc`:
```javascript
// Inside the existing global case 'syncResult' (planning.js:5089), add at the top:
const btnPush = document.getElementById('btn-push-doc');
if (btnPush) {
    btnPush.disabled = false;
    btnPush.textContent = 'Push';
}
// Then keep the existing success/error status logic; append Push-specific status:
if (msg.success && btnPush) {
    if (statusEl) statusEl.textContent = msg.message || 'Pushed to remote';
} else if (!msg.success) {
    if (statusEl) statusEl.textContent = `Push failed: ${msg.error}`;
}
```

### Phase 4: Auto-import after create (converge to Tickets tab model)

#### 4.1 Modify `createOnlineDocument` handler to auto-import after creation

**File:** `src/services/PlanningPanelProvider.ts`
**Lines:** 6632-6635 (the success branch of `createOnlineDocument` — **CORRECTED from 6646-6650**, which pointed at the `setUploadLocation` case)
**Change:** After `adapter.createDocument({ parentId, title })` succeeds, auto-import the created doc by calling the EXISTING `_handleImportFullDoc` (8209) — the same path used by the manual Import button and by Phase 2's auto-import-on-edit. This mirrors `clickupCreateTask` (6375-6413), which calls `switchboard.importTaskAsDocument` with `preFetchedTask` after creating the remote task. **CORRECTED:** drop the original plan's inline `registerImport` + manual file-write + `_generateSlugPrefix(title)` + `_sendImportedDocsReady()` — none of those helpers exist, and inlining duplicates `_handleImportFullDoc` while bypassing its subpage/dup-check logic. Verified safe: ClickUp/Linear `fetchContent` (ClickUpDocsAdapter.ts:132, LinearDocsAdapter.ts:65) returns content or `''` for a freshly-created empty doc, so `_handleImportFullDoc` imports cleanly.

```typescript
// AFTER (PlanningPanelProvider.ts 6632-6635):
const result = await adapter.createDocument({ parentId, title });
if (result.success) {
    // Auto-import the created doc so it's immediately editable.
    // Reuse _handleImportFullDoc (8209) — preserves subpages, dup-check, concurrency guard,
    // and the real slug logic (inline at 8268-8272). It posts importFullDocResult itself.
    if (result.docId) {
        try {
            const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot)
                || this._getWorkspaceRoot() || '';
            await this._handleImportFullDoc(workspaceRoot, sourceId, result.docId, title);
        } catch (importErr) {
            console.error('[PlanningPanel] Created online doc but local import failed:', importErr);
            // Don't fail the whole operation — the doc was created remotely.
        }
    }
    this._sendOnlineDocsReady();
    await this._handleFetchImportedDocs(this._getWorkspaceRoot() || '');  // real refresh (was _sendImportedDocsReady — nonexistent)
    this._panel?.webview.postMessage({
        type: 'onlineDocCreated',
        success: true,
        docId: result.docId,
        url: result.url,
        sourceId,
        autoImported: Boolean(result.docId)
    });
} else {
    this._panel?.webview.postMessage({ type: 'onlineDocCreated', success: false, error: result.error || 'Creation failed' });
}
```
Note: `_handleImportFullDoc` already calls `_handleFetchImportedDocs` internally (8286/8418) and posts `importFullDocResult`, so the explicit refresh here is belt-and-suspenders; keep it because the create flow posts its own `onlineDocCreated` and the webview (4.2) drives off that, not `importFullDocResult`.

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

8. **Multi-page ClickUp subpage preservation (NEW — guards the key data-loss risk):**
   - Browse to a ClickUp source → select a multi-page online doc that has NOT been imported
   - Click **Edit** → verify it enters edit mode
   - Save → verify ALL pages are present in the local file (not just page 1)
   - This confirms auto-import-on-edit routed through `_handleImportFullDoc` (with `listDocPages`/`fetchPageContent`) rather than a simplified helper.

9. **Setup panel still works after dead-twin removal (NEW):**
   - Open the Setup panel → verify it loads with no console errors
   - Verify no reference to the removed sync-mode handlers causes a runtime error
   - Confirms Phase 1.7 removed only dead code.

10. **Compile check (post-implementation — NOT run during this planning session per directive):**
   - `npm run compile` — verify no TypeScript errors from removed methods/handlers
   - Verify `extension.ts` compiles after removing `triggerPlanningPanelSync` command
   - Verify `SetupPanelProvider.ts` compiles after removing the dead twin (889-940, 1539-1633)
   - Verify `PlanningPanelProvider.ts` compiles with the three state fields KEPT (1.6) and `stopPeriodicSync` retained as a no-op (1.5)

11. **Run existing tests (post-implementation — NOT run during this planning session per directive):**
   - `npm test` — verify no regressions
   - Search for tests referencing removed handlers:
     ```bash
     grep -rn "planningPanelSyncMode\|setPlanningPanelSyncMode\|syncAllDocuments\|syncSelectedContainers\|docs-cache-mode\|triggerPlanningPanelSync" src/test/
     grep -rn "_getPlanningPanelSyncMode\|_setPlanningPanelSyncMode\|_fetchAvailableSyncContainers\|_setPlanningPanelSelectedContainers\|_triggerPlanningPanelSync\|_getPlanningPanelSelectedContainers" src/test/
     ```

### Automated Tests

> Per session directive, automated tests are NOT executed as part of this plan's verification. The items below are the post-implementation test obligations the coder must run once code lands. No new unit tests are mandated by this plan — the change is primarily UI-flow convergence and dead-code removal, exercised by the manual checks above — but the coder should confirm the existing `PlanningPanelCacheService.persistence.test.ts` and `PlanningPanelCacheService.duplicate.test.ts` still pass (they exercise `registerImport`, which this plan reuses unchanged via `_handleImportFullDoc`).

- **Compile gate (TypeScript):** `npm run compile` — must be green after Phases 1–5. Particular watch: the kept state fields (1.6) vs the retained `stopPeriodicSync` (1.5); the `SetupPanelProvider.ts` dead-twin removal (1.7); the `extension.ts` command removal (1.4).
- **Regression gate:** `npm test` — no new failures. The grep in item 11 surfaces any test that referenced the removed sync-mode surface; such tests must be updated (not deleted) to reflect the removal.
- **No new tests required for:** the `editPending` flag (pure webview state, covered by manual check 2), the Push button wiring (manual check 3), auto-import-after-create (manual check 4).

## What this plan does NOT do (out of scope)

- **Unifying the config systems** (planning.syncMode vs ticketSaveLocation/autoPullEnabled) — the dropdown removal eliminates `planning.syncMode`, but the remaining config keys (`planning.docMappings`, `planning.uploadLocations`) are still used by the create/sync-to-online flows. Full config unification is a separate effort.
- **Adding a top-level "+ New Doc" button** to the Docs controls strip — the per-source "+ New" button in the sidebar is adequate once auto-import-after-create works. A top-level button can be added later if discoverability is still an issue.
- **Adding conflict detection to the Push flow** — the Docs tab's existing `_handleSyncToSource` already has content-hash conflict detection (which the Tickets tab lacks). This is kept as-is.
- **Removing the "Sync to Online" modal** — this serves a different purpose (copying a local-only doc to a remote source for the first time). It should be relabeled but not removed.

## Recommendation

**Complexity: 6/10 → Send to Coder.** The plan is majority-routine (HTML/JS removal, a new button, wiring to an existing message) with two moderate, well-scoped risks (auto-import-on-edit reusing `_handleImportFullDoc` correctly; the SetupPanelProvider dead-twin cleanup). The adversarial review corrected four ship-blocking bugs (broken Push slugPrefix, two nonexistent methods, a compile break from deleted state fields, multi-page subpage loss) and one cleanup gap (the SetupPanelProvider dead twin). With those corrections applied in this revision, a competent coder can execute Phases 1→5 sequentially in a single PR. Phase 1 (removal + dead-twin cleanup) must land before Phases 2–4 to avoid dangling references to removed handlers.

## Review Findings

Reviewed `bd1c213` across all 5 phases; implementation is complete and correct — no CRITICAL/MAJOR issues, so no code fixes applied. Files: `planning.html` (dropdown/picker removed, `btn-push-doc` added, "Copy to Online…" relabel), `planning.js` (auto-import-on-edit via `editPending` handled in `handlePreviewReady` — a deliberate improvement over Phase 2.3 that dodges a stale-content race, plus multi-page graceful degradation, Push wiring via `resolveActiveOnlineSlugPrefix()`, extended global `syncResult`), `PlanningPanelProvider.ts` (create→auto-import via `_handleImportFullDoc`, three state fields kept, `stopPeriodicSync` no-op), `SetupPanelProvider.ts` + `extension.ts` (dead twin + command fully removed, verified by grep). Validation (no compile/tests per directive): grep confirms zero dangling references to removed sync-mode identifiers (only false positives are the unrelated modal-scoped `_triggerSync` and the pre-existing untracked-by-this-work `PlanningPanelProvider.ts.bak3`); the feared Push-button/import race is unreachable because `_handleImportFullDoc` posts `importedDocsReady` before `importFullDocResult` and webview messages are ordered. Remaining minor risks (all NIT, unfixed): `_currentSyncMode` is now genuinely unreferenced dead state (harmless, kept per migration posture); rapid doc-switching during an in-flight auto-import could leak `editPending` onto the next doc (low-likelihood edge, non-catastrophic); auto-import-after-create reuses the full dup-check, so a title colliding with an existing import surfaces the duplicate modal on a freshly-created doc (by-design trade-off to preserve subpage handling).
