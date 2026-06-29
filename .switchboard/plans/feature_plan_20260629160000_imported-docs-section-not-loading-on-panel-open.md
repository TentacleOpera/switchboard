# Imported Docs Section Never Loads on Panel Open

## Goal

The imported docs section (the "IMPORTED FROM {source}" cards rendered by `renderImportedDocsSection`) never appears when the planning panel is first opened. It only appears after a specific trigger (importing a doc, file watcher event, or resolving a duplicate). This makes the section invisible to users who have previously imported docs — they open the panel, see nothing, and assume their imports are gone.

### Core problem & background

The previous plan (feature_plan_20260629150054) added a `renderImportedDocsSection` function to `planning.js` that renders imported docs into the sidebar. It is called from within `renderUnifiedDocs` (line 2640), gated on `state._lastImportedDocs` being truthy:

```javascript
if (state._lastImportedDocs) {
    renderImportedDocsSection(state._lastImportedDocs);
}
```

`state._lastImportedDocs` is only populated inside `handleImportedDocsReady` (line 3435), which runs when the webview receives an `importedDocsReady` message from the backend.

The backend sends `importedDocsReady` from `_handleFetchImportedDocs` (`PlanningPanelProvider.ts:7451`). This function is called in response to:
- `fetchImportedDocs` message from webview (line 2482)
- File watcher events (line 737)
- After an import completes (lines 2761, 7772, 7905)
- After a delete (line 2761)

**But it is NOT called during initial panel load.** The initial load path is:

1. Webview sends `fetchRoots` on startup (`planning.js:9623`)
2. Backend handles `fetchRoots` (`PlanningPanelProvider.ts:1963`), which calls `_handleFetchRoots` (line 1988)
3. `_handleFetchRoots` (`PlanningPanelProvider.ts:7072`) calls `_sendLocalDocsReady`, `_sendOnlineDocsReady`, and `_sendPlanningHtmlDocsReady` — but **never calls `_handleFetchImportedDocs`**

So on panel open: local docs load, online docs load, planning HTML docs load, but imported docs are never fetched. `state._lastImportedDocs` stays `null`, the `if (state._lastImportedDocs)` guard at line 2640 fails, and `renderImportedDocsSection` is never called. The section is invisible.

### Root cause

`_handleFetchRoots` (`PlanningPanelProvider.ts:7072-7080`) is missing a call to `_handleFetchImportedDocs`. It fetches every other doc source but omits imported docs.

## Metadata

- **Tags:** [backend, bugfix, docs]
- **Complexity:** 2

## User Review Required

No — one-line fix with a clear root cause.

## Proposed Changes

### 1. `src/services/PlanningPanelProvider.ts` — fetch imported docs during initial load

In `_handleFetchRoots` (line 7072), add a call to `_handleFetchImportedDocs` alongside the other doc source fetches.

**Current code** (`PlanningPanelProvider.ts:7072-7080`):
```typescript
private async _handleFetchRoots(forceLocalDocs: boolean = false): Promise<void> {
    await this._sendLocalDocsReady(forceLocalDocs);
    await this._sendOnlineDocsReady();
    await this._sendPlanningHtmlDocsReady();
    const cyberAnimationDisabled = vscode.workspace.getConfiguration('switchboard').get<boolean>('theme.disableCyberAnimation', false);
    this._panel?.webview.postMessage({ type: 'cyberAnimationSetting', disabled: cyberAnimationDisabled });
    const currentTheme = vscode.workspace.getConfiguration('switchboard').get<string>('theme.name', 'afterburner');
    this._panel?.webview.postMessage({ type: 'switchboardThemeNameSetting', theme: currentTheme });
}
```

**Replace with:**
```typescript
private async _handleFetchRoots(forceLocalDocs: boolean = false): Promise<void> {
    await this._sendLocalDocsReady(forceLocalDocs);
    await this._sendOnlineDocsReady();
    await this._sendPlanningHtmlDocsReady();
    await this._handleFetchImportedDocs(this._getWorkspaceRoot());
    const cyberAnimationDisabled = vscode.workspace.getConfiguration('switchboard').get<boolean>('theme.disableCyberAnimation', false);
    this._panel?.webview.postMessage({ type: 'cyberAnimationSetting', disabled: cyberAnimationDisabled });
    const currentTheme = vscode.workspace.getConfiguration('switchboard').get<string>('theme.name', 'afterburner');
    this._panel?.webview.postMessage({ type: 'switchboardThemeNameSetting', theme: currentTheme });
}
```

The workspace root is available via `this._getWorkspaceRoot()` — the same method used elsewhere in the message handler that calls `_handleFetchRoots`. `_handleFetchImportedDocs` already handles multi-root workspaces internally (it iterates `this._getWorkspaceRoots()` at line 7453), so passing any root is fine; the function deduplicates by slug across all roots.

**Note:** `_handleFetchImportedDocs` takes a `workspaceRoot` parameter but only uses it as a fallback — its primary logic iterates all workspace roots via `this._getWorkspaceRoots()`. Passing `this._getWorkspaceRoot()` (the primary root) is consistent with how other callers use it (e.g., line 737, 2482).

## Verification Plan

### Manual Verification

1. Import a doc from an online source (ClickUp, Linear, or Notion).
2. **Verify:** The imported doc appears in the "IMPORTED FROM {source}" section.
3. Close the planning panel (or reload the VS Code window).
4. Reopen the planning panel and navigate to the Docs tab.
5. **Verify:** The imported docs section appears immediately with the previously imported docs — no manual refresh required.
6. Switch away from the Docs tab and back.
7. **Verify:** The imported docs section persists.

## Dependencies

None — this is a one-line backend fix.
