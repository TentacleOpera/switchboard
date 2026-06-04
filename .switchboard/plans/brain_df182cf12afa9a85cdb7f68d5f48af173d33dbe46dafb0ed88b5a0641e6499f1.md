# Auto Refresh Support for Kanban Plans and Disk Document Edits

## Goal
Provide support for automatically refreshing the active Kanban plan preview pane in the Research & Planning panel (`planning.html`) when the plan file is updated externally. Resolve the issue where panel-initiated writes trigger redundant file watcher reloads.

## Metadata
- **Tags:** frontend, backend, bugfix, reliability, UX
- **Complexity:** 5

## User Review Required
> [!NOTE]
> No breaking changes or configuration modifications are required. The changes are local to the extension backend (`PlanningPanelProvider.ts`) and webview frontend (`planning.js`).

## Complexity Audit

### Routine
- Extracting `_handleFetchKanbanPlanPreview` helper from the inline `fetchKanbanPlanPreview` case in `_handleMessage` (lines 1370–1389).
- Adding `_activePreviewPath`, `_activePreviewSourceId`, `_activePreviewDocId` assignments and `_setupActiveDocWatcher` call in the new helper (mirrors existing pattern in `_handleFetchPreview` at lines 1989–1993 and 2019–2023).
- Adding `isAutoRefreshed` flag to `kanbanPlanPreviewReady` message payload (mirrors `previewReady` at line 2000).
- Bypassing the `requestId !== -1` check in `handleKanbanPlanPreviewReady` (line 2859).
- Setting `_lastPanelWriteTimestamp = Date.now()` in `saveFileContent` before the `writeFile` call (line 1435).
- Adding `externalChangePending` to the global `state` object (line 8).
- Updating `_kanbanSelectedPlan` in `handleKanbanPlansReady` when the plans list refreshes (line 2822).

### Complex / Risky
- Managing state for pending external changes when the user is in edit mode. When a reload message is discarded because of active editing, we must track that a reload is pending and trigger it automatically if the user cancels their edits. This requires coordinated state across `handleKanbanPlanPreviewReady`, `handlePreviewReady`, and `exitEditMode`.

## Edge-Case & Dependency Audit
- **Race Conditions**: Rapidly switching plan cards while a file read is pending could cause a stale preview to overwrite the active selection. We mitigate this by matching the `requestId` for user-initiated loads and checking that the file path matches `_activePreviewPath` for auto-refreshes. The existing `_watcherGeneration` counter (line 525) ensures stale watchers are ignored.
- **Security**: File path parameters sent from the webview must be validated against the workspace roots to prevent directory traversal. The existing `isAllowed` check (line 1375) in `fetchKanbanPlanPreview` already handles this; the extracted helper must preserve it.
- **Side Effects**: Updating `_lastPanelWriteTimestamp` on panel saves suppresses the file watcher `onDidSave` event for 1000ms (line 543). If an external edit occurs within that same 1000ms window, the refresh would be temporarily ignored. This is acceptable because the next watcher event after the window expires will trigger the refresh.
- **Dependencies & Conflicts**: None.

## Dependencies
None.

## Adversarial Synthesis
Key risks: Missing `isAutoRefreshed` flag on `kanbanPlanPreviewReady` makes edit-mode guard impossible; stale auto-refreshes could clobber unsaved edits if the `requestId` check is bypassed without also checking edit mode; and a deleted plan in `handleKanbanPlansReady` would leave `_kanbanSelectedPlan` pointing to a stale entry. Mitigations: Add `isAutoRefreshed` flag to backend message; defer reloads during active edit sessions with `externalChangePending` tracking; guard against undefined plan in `_kanbanSelectedPlan` update.

## Proposed Changes

### Extension Webview Backend

#### [MODIFY] [PlanningPanelProvider.ts](file:///Users/patrickvuleta/Documents/GitHub/switchboard/src/services/PlanningPanelProvider.ts)

**Step 1: Extract `_handleFetchKanbanPlanPreview` helper** (new method, ~after line 589)

Extract the inline `fetchKanbanPlanPreview` case (lines 1370–1389) into a dedicated method:

```typescript
private async _handleFetchKanbanPlanPreview(filePath: string, requestId: number): Promise<void> {
    const allRoots = this._getWorkspaceRoots();
    const resolved = path.resolve(filePath);
    const isAllowed = allRoots.some(r => resolved.startsWith(path.resolve(r)));
    if (!filePath || !isAllowed || !fs.existsSync(resolved)) {
        this._panel?.webview.postMessage({
            type: 'kanbanPlanPreviewReady', requestId,
            content: '', error: 'File not found or not in workspace'
        });
        return;
    }
    try {
        const content = await fs.promises.readFile(resolved, 'utf8');

        // Set active preview state (mirrors _handleFetchPreview pattern)
        this._activePreviewPath = resolved;
        this._activePreviewSourceId = 'kanban-plan';
        this._activePreviewDocId = filePath;
        this._setupActiveDocWatcher(resolved);

        this._panel?.webview.postMessage({
            type: 'kanbanPlanPreviewReady', requestId, content,
            isAutoRefreshed: this._isAutoRefreshing
        });
    } catch (err) {
        this._panel?.webview.postMessage({
            type: 'kanbanPlanPreviewReady', requestId, content: '', error: String(err)
        });
    }
}
```

Key additions vs. the original inline code:
- Sets `_activePreviewPath`, `_activePreviewSourceId`, `_activePreviewDocId` so the active doc watcher knows which file to monitor.
- Calls `_setupActiveDocWatcher(resolved)` to register the per-file watcher.
- Passes `isAutoRefreshed: this._isAutoRefreshing` in the response message (mirrors `previewReady` at line 2000).

**Step 2: Replace inline `fetchKanbanPlanPreview` case** (lines 1370–1389)

Replace the entire `case 'fetchKanbanPlanPreview':` block with:

```typescript
case 'fetchKanbanPlanPreview': {
    const filePath: string = msg.filePath || '';
    const requestId = typeof msg.requestId === 'number' ? msg.requestId : 0;
    await this._handleFetchKanbanPlanPreview(filePath, requestId);
    break;
}
```

**Step 3: Add `kanban-plan` branch to `_setupActiveDocWatcher`'s `onDidChange` handler** (line 560–566)

In the `onDidChange` debounce callback (around line 560), add a `kanban-plan` branch after the existing `local-folder`/`html-folder` and imported-doc branches:

```typescript
if (this._activePreviewSourceId === 'local-folder' || this._activePreviewSourceId === 'html-folder') {
    await this._handleFetchPreview(workspaceRoot, this._activePreviewSourceId, this._activePreviewDocId!, -1, this._activePreviewSourceFolder!);
} else if (this._activePreviewSourceId === 'kanban-plan') {
    await this._handleFetchKanbanPlanPreview(this._activePreviewDocId!, -1);
} else {
    await this._handleFetchDocsFile(workspaceRoot, this._activePreviewDocId!, -1);
}
```

**Step 4: Set `_lastPanelWriteTimestamp` before writing in `saveFileContent`** (line 1435)

Insert `this._lastPanelWriteTimestamp = Date.now();` BEFORE the `writeFile` call at line 1435:

```typescript
this._lastPanelWriteTimestamp = Date.now();
await fs.promises.writeFile(resolved, content, 'utf8');
```

This ensures panel-initiated writes suppress the file watcher's `onDidChange` event for 1000ms (checked at line 543), preventing redundant auto-refreshes.

---

### Webview Frontend

#### [MODIFY] [planning.js](file:///Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/planning.js)

**Step 1: Add `externalChangePending` to global `state`** (line 8–31)

Add to the `state` object:

```javascript
externalChangePending: { local: false, kanban: false },
```

**Step 2: Update `handleKanbanPlanPreviewReady`** (lines 2858–2885)

Replace the existing `requestId` guard (line 2859) with a more permissive check that allows auto-refreshes (requestId -1) through:

```javascript
function handleKanbanPlanPreviewReady(msg) {
    // Allow auto-refreshes (requestId -1 or undefined) and matching request IDs
    if (msg.requestId !== undefined && msg.requestId !== -1 && msg.requestId !== _kanbanPreviewRequestId) return;
    if (!kanbanPreviewContent) return;

    if (msg.error) {
        kanbanPreviewContent.innerHTML = `<div class="kanban-empty-state" style="color: var(--vscode-errorForeground, #ff6b6b);">Error reading file: ${escapeHtml(msg.error)}</div>`;
        return;
    }

    // If user is in edit mode, defer the reload instead of clobbering
    if (state.editMode.kanban && msg.isAutoRefreshed) {
        state.externalChangePending.kanban = true;
        // Show warning in kanban controls strip
        const kanbanStrip = document.querySelector('.kanban-controls-strip');
        if (kanbanStrip) {
            let statusEl = kanbanStrip.querySelector('.kanban-external-change-warning');
            if (!statusEl) {
                statusEl = document.createElement('span');
                statusEl.className = 'kanban-external-change-warning';
                statusEl.style.cssText = 'font-size:11px; color:var(--vscode-errorForeground, #ff6b6b); margin-left:8px;';
                kanbanStrip.appendChild(statusEl);
            }
            statusEl.textContent = 'File changed externally — save to overwrite or cancel to reload';
        }
        return;
    }

    // Show auto-refresh notification (mirrors local tab behavior at line 1265)
    if (msg.isAutoRefreshed) {
        const kanbanStrip = document.querySelector('.kanban-controls-strip');
        if (kanbanStrip) {
            let statusEl = kanbanStrip.querySelector('.kanban-auto-refresh-indicator');
            if (!statusEl) {
                statusEl = document.createElement('span');
                statusEl.className = 'kanban-auto-refresh-indicator';
                statusEl.style.cssText = 'font-size:11px; color:var(--accent-teal); margin-left:8px; opacity:0; transition:opacity 0.3s;';
                kanbanStrip.appendChild(statusEl);
            }
            statusEl.textContent = 'Plan auto-refreshed';
            statusEl.style.opacity = '1';
            clearTimeout(statusEl._fadeTimer);
            statusEl._fadeTimer = setTimeout(() => { statusEl.style.opacity = '0'; }, 2000);
        }
    }

    // Store original content
    state.editOriginalContent.kanban = msg.content || '';
    state.dirtyFlags.kanban = false;

    if (msg.content) {
        kanbanPreviewContent.innerHTML = renderMarkdown(msg.content);
    } else {
        kanbanPreviewContent.innerHTML = '<div class="kanban-empty-state">Plan file is empty</div>';
    }

    const btnEditKanban = document.getElementById('btn-edit-kanban');
    if (btnEditKanban) {
        btnEditKanban.disabled = !_kanbanSelectedPlan || !_kanbanSelectedPlan.planFile;
    }
    const btnReviewKanban = document.getElementById('btn-review-kanban');
    if (btnReviewKanban) {
        btnReviewKanban.disabled = !_kanbanSelectedPlan || !_kanbanSelectedPlan.planFile;
    }
}
```

**Step 3: Update `handlePreviewReady` for local tab edit-mode guard** (lines 1264–1276)

In the auto-refresh notification block (lines 1265–1276), add an edit-mode guard BEFORE the existing notification logic:

```javascript
// Auto-refresh notification
if (isAutoRefreshed) {
    if (state.editMode.local) {
        // Defer reload — don't clobber the editor
        state.externalChangePending.local = true;
        const statusLocal = document.getElementById('status');
        if (statusLocal) {
            statusLocal.textContent = 'File changed externally — save to overwrite or cancel to reload';
            statusLocal.style.color = 'var(--vscode-errorForeground, #ff6b6b)';
        }
        return;
    }
    // ... existing auto-refresh toast code (lines 1266–1276) ...
}
```

**Step 4: Update `exitEditMode` to handle pending external changes** (lines 3005–3028)

After the existing `state.dirtyFlags[tab] = false;` line (3026), add logic to trigger a deferred reload:

```javascript
function exitEditMode(tab, discard) {
    if (!discard && state.dirtyFlags[tab]) {
        if (!confirm('You have unsaved changes. Discard them?')) {
            return false;
        }
    }

    const previewPane = tab === 'local' ? document.getElementById('preview-pane') : document.getElementById('kanban-preview-pane');
    if (previewPane) {
        previewPane.classList.remove('edit-mode');
    }

    const btnEdit = document.getElementById(tab === 'local' ? 'btn-edit-local' : 'btn-edit-kanban');
    const btnSave = document.getElementById(tab === 'local' ? 'btn-save-local' : 'btn-save-kanban');
    const btnCancel = document.getElementById(tab === 'local' ? 'btn-cancel-local' : 'btn-cancel-kanban');

    if (btnEdit) btnEdit.style.display = '';
    if (btnSave) btnSave.style.display = 'none';
    if (btnCancel) btnCancel.style.display = 'none';

    state.editMode[tab] = false;
    state.dirtyFlags[tab] = false;

    // Trigger deferred reload if an external change was pending
    if (state.externalChangePending[tab]) {
        state.externalChangePending[tab] = false;
        if (tab === 'kanban' && _kanbanSelectedPlan && _kanbanSelectedPlan.planFile) {
            _kanbanPreviewRequestId++;
            vscode.postMessage({
                type: 'fetchKanbanPlanPreview',
                filePath: _kanbanSelectedPlan.planFile,
                requestId: _kanbanPreviewRequestId
            });
        } else if (tab === 'local') {
            if (state.activeSource === 'local-folder' || state.activeSource === 'html-folder') {
                vscode.postMessage({
                    type: 'fetchPreview',
                    sourceId: state.activeSource,
                    docId: state.activeDocId,
                    requestId: ++state.previewRequestId,
                    sourceFolder: state.activeDocFilePath ? state.activeDocFilePath.substring(0, state.activeDocFilePath.lastIndexOf('/')) : undefined
                });
            } else {
                vscode.postMessage({
                    type: 'fetchDocsFile',
                    slugPrefix: state.activeDocId,
                    requestId: ++state.previewRequestId
                });
            }
        }
    }

    return true;
}
```

**Step 5: Update `handleKanbanPlansReady` to refresh `_kanbanSelectedPlan`** (lines 2822–2856)

After `_kanbanPlansCache = msg.plans || [];` (line 2830), add:

```javascript
// Refresh selected plan reference from updated cache
if (_kanbanSelectedPlan) {
    const updated = _kanbanPlansCache.find(p => p.planId === _kanbanSelectedPlan.planId);
    if (updated) {
        _kanbanSelectedPlan = updated;
    } else {
        // Plan was deleted externally — clear selection
        _kanbanSelectedPlan = null;
        if (kanbanPreviewContent) {
            kanbanPreviewContent.innerHTML = '<div class="kanban-empty-state">Select a plan to preview</div>';
        }
    }
}
```

## Verification Plan

### Automated Tests
- No compilation or automated test steps required for this session.

### Manual Verification
1. Open the Research Panel.
2. Select a Kanban plan card and verify that editing the markdown file externally updates the preview with a `"Plan auto-refreshed"` status.
3. Enter edit mode on the preview, edit the file externally, and verify the warning status appears (`"File changed externally — save to overwrite or cancel to reload"`).
4. Click Cancel and verify the preview automatically reloads the updated file content from disk.
5. Click edit, write changes, save, and verify no duplicate reload occurs.
6. Delete the selected plan's file externally and verify the plan list refresh clears the selection and shows the empty state.
7. Switch to the Local Docs tab, select a local doc, enter edit mode, edit the file externally, and verify the warning status appears. Click Cancel and verify the preview reloads.

## Recommendation
Complexity 5 → **Send to Coder**
