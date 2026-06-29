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

The backend sends `importedDocsReady` from `_handleFetchImportedDocs` (`PlanningPanelProvider.ts:7420`). This function is called in response to:
- `fetchImportedDocs` message from webview (line 2480)
- File watcher events (line 735)
- After an import completes (lines 2759, 7741, 7874)
- After a delete (line 2759)

**But it is NOT called during initial panel load.** The initial load path is:

1. Webview sends `fetchRoots` on startup (`planning.js:9623`)
2. Backend handles `fetchRoots` (`PlanningPanelProvider.ts:1961`), which calls `_handleFetchRoots` (line 1986)
3. `_handleFetchRoots` (`PlanningPanelProvider.ts:7041`) calls `_sendLocalDocsReady`, `_sendOnlineDocsReady`, and `_sendPlanningHtmlDocsReady` — but **never calls `_handleFetchImportedDocs`**

So on panel open: local docs load, online docs load, planning HTML docs load, but imported docs are never fetched. `state._lastImportedDocs` stays `null`, the `if (state._lastImportedDocs)` guard at line 2640 fails, and `renderImportedDocsSection` is never called. The section is invisible.

### Root cause

`_handleFetchRoots` (`PlanningPanelProvider.ts:7041-7049`) is missing a call to `_handleFetchImportedDocs`. It fetches every other doc source but omits imported docs.

## Metadata

- **Tags:** [backend, bugfix, docs]
- **Complexity:** 2

## User Review Required

No — one-line fix with a clear root cause.

## Complexity Audit

### Routine
- Adding a single `await` call to an existing async method (`_handleFetchRoots`)
- The called method (`_handleFetchImportedDocs`) already exists, is fully tested via other call sites, and has its own error handling
- No new logic, no new state, no UI changes — just wiring up an existing fetch to an existing load path

### Complex / Risky
- `_handleFetchImportedDocs` runs a `healImports()` scan if one hasn't run in the last hour (lines 7433-7441). Adding this to the initial load path means cold panel opens may trigger a DB heal scan, adding latency. This is throttled (1/hour), idempotent, and consistent with existing behavior (file watchers and imports already trigger it). Acceptable but worth noting.

## Edge-Case & Dependency Audit

- **Race Conditions:** None. VS Code webview messages are queued and processed in order. `importedDocsReady` arrives after `planningHtmlDocsReady` and before theme settings. `handleImportedDocsReady` calls `rerenderUnifiedDocs()` which re-renders the full docs tree — the same pattern used by all other triggers (import, file watcher, delete).
- **Security:** No security implications. No new data paths; the function reads from the existing kanban DB cache.
- **Side Effects:** The `healImports()` call (throttled to 1/hour) may write to the kanban DB during initial load. This is idempotent and already triggered by other call sites.
- **Dependencies & Conflicts:** None. No other plans modify `_handleFetchRoots` or the initial load sequence.

## Dependencies

None — this is a one-line backend fix.

## Adversarial Synthesis

Key risks: (1) the `workspaceRoot` parameter passed to `_handleFetchImportedDocs` must satisfy TypeScript strict null checks since `_getWorkspaceRoot()` returns `string | undefined` — use `|| ''` fallback; (2) the `healImports()` scan inside `_handleFetchImportedDocs` adds latency to cold panel opens but is throttled and idempotent. Mitigations: the `|| ''` fallback is safe because the parameter is unused in the function body (it uses `this._getWorkspaceRoots()` internally); the heal scan is consistent with existing behavior from file watchers and imports.

## Proposed Changes

### 1. `src/services/PlanningPanelProvider.ts` — fetch imported docs during initial load

In `_handleFetchRoots` (line 7041), add a call to `_handleFetchImportedDocs` alongside the other doc source fetches.

**Current code** (`PlanningPanelProvider.ts:7041-7049`):
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
    await this._handleFetchImportedDocs(this._getWorkspaceRoot() || '');
    const cyberAnimationDisabled = vscode.workspace.getConfiguration('switchboard').get<boolean>('theme.disableCyberAnimation', false);
    this._panel?.webview.postMessage({ type: 'cyberAnimationSetting', disabled: cyberAnimationDisabled });
    const currentTheme = vscode.workspace.getConfiguration('switchboard').get<string>('theme.name', 'afterburner');
    this._panel?.webview.postMessage({ type: 'switchboardThemeNameSetting', theme: currentTheme });
}
```

**Why `this._getWorkspaceRoot() || ''`:** `_getWorkspaceRoot()` returns `string | undefined` (constructor line 155). With `strict: true` in `tsconfig.json`, passing `undefined` to `_handleFetchImportedDocs(workspaceRoot: string)` is a compilation error. The `|| ''` fallback satisfies the type checker. The empty string is harmless because the `workspaceRoot` parameter is **not used anywhere in `_handleFetchImportedDocs`** — the function body (lines 7420-7471) exclusively uses `this._getWorkspaceRoots()` to iterate all workspace roots and deduplicates by slug. The parameter is effectively dead code retained for signature compatibility with existing callers.

**Note on heal scan:** `_handleFetchImportedDocs` runs `kanbanDb.healImports()` if no scan has run in the past hour (lines 7433-7441). This means a cold panel open may trigger a heal scan. This is acceptable: the scan is idempotent, throttled to once per hour per workspace, and is already triggered by file watcher events (line 735) and import operations (lines 2759, 7741, 7874). The `await` means the theme settings messages will be delayed until the heal scan + DB query completes, but this is the same latency users already experience when importing a doc.

**Note on error handling:** `_handleFetchImportedDocs` has its own try/catch (lines 7421-7470) that sends `importedDocsReady` with an error payload on failure. The promise will not reject, so `_handleFetchRoots` will continue to send theme settings even if the imported docs fetch fails.

## Verification Plan

### Manual Verification

1. Import a doc from an online source (ClickUp, Linear, or Notion).
2. **Verify:** The imported doc appears in the "IMPORTED FROM {source}" section.
3. Close the planning panel (or reload the VS Code window).
4. Reopen the planning panel and navigate to the Docs tab.
5. **Verify:** The imported docs section appears immediately with the previously imported docs — no manual refresh required.
6. Switch away from the Docs tab and back.
7. **Verify:** The imported docs section persists.
8. **Multi-root workspace test:** Open a multi-root workspace where one root has imported docs and another does not. Reopen the panel. Verify imported docs from the root that has them appear, and no errors are thrown for the root that doesn't.

### Automated Tests

Skipped per session directive — test suite will be run separately by the user.

---

**Recommendation:** Complexity 2 → Send to Intern
