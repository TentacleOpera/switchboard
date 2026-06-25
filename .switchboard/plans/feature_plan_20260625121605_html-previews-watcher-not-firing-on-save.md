# Fix: HTML Previews Tab Auto-Refresh Watcher Not Firing on Save

## Goal

Fix the HTML Previews tab in `design.html` so that editing and saving an HTML file in the VS Code editor automatically refreshes the iframe preview, without requiring the user to click away to another file and back.

### Problem

In the Design panel's **HTML Previews** tab, when the user edits and saves the currently-previewed HTML file in the VS Code editor, the iframe preview does not update. The user must manually click a different file in the sidebar and then click back to the original file to see their changes. The sidebar file tree *does* refresh on save (file list updates), but the preview iframe does not.

### Root Cause Analysis

The auto-refresh infrastructure was added in commit `1db57b7` (2026-06-24) and is fully wired in the backend (`DesignPanelProvider.ts`) and frontend (`design.js`). However, the auto-refresh is **only triggered from `watcher.onDidChange`**, which does not reliably fire on macOS when VS Code's text editor saves a file.

**The critical bug** (in `_setupHtmlFolderWatchers`, lines 421-426):

```ts
watcher.onDidChange((uri) => {
    this._sendHtmlDocsReady();
    this._autoRefreshHtmlPreview(uri);     // <-- auto-refresh ONLY here
});
watcher.onDidCreate(() => this._sendHtmlDocsReady());   // <-- tree only, NO auto-refresh
watcher.onDidDelete(() => this._sendHtmlDocsReady());   // <-- tree only, NO auto-refresh
```

**Why `onDidChange` doesn't fire on save:**
VS Code's text editor on macOS uses **atomic saves** — it writes to a temporary file and then renames it over the original. The `vscode.workspace.createFileSystemWatcher` parcel watcher sees this as a **delete + create** sequence on the original path, not a change event. As a result:

1. `onDidCreate` fires for the original path (after rename) → `_sendHtmlDocsReady()` refreshes the **tree** ✓
2. `onDidChange` does **NOT** fire → `_autoRefreshHtmlPreview()` is **never called** ✗

This perfectly explains the user's experience: the file tree updates on save (proving the watcher fires), but the preview doesn't auto-refresh (because `_autoRefreshHtmlPreview` is only wired to `onDidChange`).

The same bug exists in the Claude folder watcher (`_setupClaudeFolderWatchers`, lines 446-453).

**Secondary issue:** The localhost HTML preview server (`_handleHtmlServerRequest`) does not set `Cache-Control` headers. While the frontend adds a `?t=` cache-busting query param on auto-refresh, adding `Cache-Control: no-store` to server responses provides a belt-and-suspenders guarantee against any browser-level caching.

## Metadata
- **Tags:** [bugfix, backend, ui]
- **Complexity:** 3/10

## User Review Required

No user review required. The fix is a targeted backend-only change with no product scope changes, no data migrations, and no configuration changes. All changes preserve existing behavior for non-matching paths.

## Complexity Audit

### Routine
- Adding `_autoRefreshHtmlPreview(uri)` to existing `onDidCreate` callbacks (2 watchers: HTML + Claude)
- Registering a `vscode.workspace.onDidSaveTextDocument` listener as a reliable fallback for editor saves
- Adding `Cache-Control: no-store` to localhost server response headers
- Disposing the new `onDidSaveTextDocument` listener in `dispose()`

### Complex / Risky
- None significant. The `_autoRefreshHtmlPreview` method already has a path-equality guard (`changedPath !== activePath`), so calling it from `onDidCreate` for genuinely new files is harmless (the new file's path won't match the active preview's path). The `onDidSaveTextDocument` listener filters by comparing `document.uri.fsPath` against the active preview path, so non-HTML saves are ignored.

## Edge-Case & Dependency Audit

### Race Conditions
- **Mid-write reads** — Already handled: `_buildAndSendPreview` with `requestId: -1` silently swallows errors (the file may be mid-write during atomic save). The 300ms debounce collapses rapid-save bursts.
- **Stale active-preview after rapid file switch** — Already handled: the debounce callback re-checks `currentPath !== activePath` against the *current* `_activeHtmlPreview`/`_activeClaudePreview`, not the one captured at debounce-creation time.
- **`onDidSaveTextDocument` + `onDidCreate` both firing** — Both may fire for the same save. The shared `_autoRefreshDebounce` timer ensures only one refresh executes (the second call clears the first's timer and sets a new one, collapsing into a single refresh).
- **Atomic save delete-create gap** — During atomic save, `onDidDelete` fires then `onDidCreate` fires. If the 300ms debounce fires in the gap between delete and create, `_buildAndSendPreview` with `requestId: -1` fails silently. The file reappears after the rename completes, so the next event triggers a successful refresh. No user-visible failure.

### Security
- **No new attack surface.** The `onDidSaveTextDocument` listener only reads `document.uri.fsPath` for a path comparison; it does not open or transmit file contents. The `_autoRefreshHtmlPreview` path-equality check and the `_buildAndSendPreview` `allowedFolders` confinement are unchanged.
- **`Cache-Control: no-store`** is a standard response header with no security implications.

### Side Effects
- **`onDidCreate` for new files** — `_autoRefreshHtmlPreview` is called but returns immediately because the new file's path won't match the active preview's path (a new file can't be the currently-previewed file). No side effect.
- **`onDidSaveTextDocument` for non-HTML files** — The listener checks `document.uri.fsPath` against the active preview path. Non-matching saves are ignored. No side effect.
- **Multiple workspace roots** — `onDidSaveTextDocument` fires for all saved documents across all roots; the path-equality check selects the correct one. Preserved.

### Dependencies & Conflicts
- **Pre-existing 4s external-file poll** (`_pollTick`) — Refreshes the tree for external-editor changes. Does not trigger preview auto-refresh. This change adds editor-save-triggered auto-refresh; external-editor edits still won't auto-refresh the preview (accepted scope boundary, same as before).
- **`activeTabChanged` clearing `_activeHtmlPreview`** — Unchanged. When the user switches away from the HTML Previews tab, `_activeHtmlPreview` is cleared, so `onDidSaveTextDocument` and `onDidCreate` both no-op.
- **Panel restore** — The `deserializeWebviewPanel()` method (line 188) calls `_setupHtmlFolderWatchers()` which will include the new `onDidCreate` wiring. The `onDidSaveTextDocument` listener must also be registered in `deserializeWebviewPanel()` (or registered once and not tied to watcher setup).
- **`onDidChangeWorkspaceFolders` calls `disposeWatchers()`** (lines 146, 240) — The `onDidSaveTextDocument` listener is workspace-global (not tied to specific folder patterns), so it must NOT be disposed in `disposeWatchers()`. If it were, workspace folder changes would silently kill the save listener with no re-registration. Dispose it in `dispose()` only.

## Dependencies

None. This plan is self-contained and does not depend on any other plan or session.

## Adversarial Synthesis

Key risks: (1) Disposing `_saveTextDocListener` in `disposeWatchers()` would silently kill the save listener after any workspace folder change — the listener is workspace-global and must be disposed in `dispose()` only. (2) The plan originally referenced a non-existent `restore()` method — the actual method is `deserializeWebviewPanel()`. (3) A third 403 response at line 1147 was missed in the Cache-Control rollout. Mitigations: dispose in `dispose()` only, correct method name to `deserializeWebviewPanel()`, add `Cache-Control` to all three 403 responses.

## Proposed Changes

### 1. Backend: Add `_autoRefreshHtmlPreview` to `onDidCreate` for HTML and Claude watchers (`src/services/DesignPanelProvider.ts`)

In `_setupHtmlFolderWatchers` (line 425), change:

```ts
watcher.onDidCreate(() => this._sendHtmlDocsReady());
```
to:
```ts
watcher.onDidCreate((uri) => {
    this._sendHtmlDocsReady();
    this._autoRefreshHtmlPreview(uri);
});
```

In `_setupClaudeFolderWatchers` (line 452), change:

```ts
watcher.onDidCreate(() => this._sendClaudeDocsReady());
```
to:
```ts
watcher.onDidCreate((uri) => {
    this._sendClaudeDocsReady();
    this._autoRefreshHtmlPreview(uri);
});
```

> `onDidDelete` does NOT need `_autoRefreshHtmlPreview` — deleting the active preview file should not refresh it (the file is gone). The tree refresh handles removing it from the list.

### 2. Backend: Register `onDidSaveTextDocument` as a reliable fallback (`src/services/DesignPanelProvider.ts`)

The `FileSystemWatcher` may still miss some save scenarios (e.g., network drives, certain macOS configurations). `vscode.workspace.onDidSaveTextDocument` fires reliably for every document saved by the VS Code editor. Add a listener that checks whether the saved document matches the active preview.

Add a new disposable field near the other watcher fields (line ~49, after `_briefsFolderWatchers`):

```ts
private _saveTextDocListener?: vscode.Disposable;
```

Add a new method:

```ts
private _registerSaveTextDocListener(): void {
    if (this._saveTextDocListener) return;   // already registered
    this._saveTextDocListener = vscode.workspace.onDidSaveTextDocument((document) => {
        // Only trigger if the panel is visible and there's an active preview.
        if (!this._panel?.visible) return;
        if (!this._activeHtmlPreview && !this._activeClaudePreview) return;
        // _autoRefreshHtmlPreview already does the path-equality check against
        // both _activeHtmlPreview and _activeClaudePreview, so we can call it
        // unconditionally — non-matching saves are silently skipped.
        this._autoRefreshHtmlPreview(document.uri);
    });
    this._disposables.push(this._saveTextDocListener);
}
```

Call `_registerSaveTextDocListener()` at the end of both `open()` (after `_setupBriefsFolderWatchers()`, line 138) and `deserializeWebviewPanel()` (after `_setupBriefsFolderWatchers()`, line 230).

> **Clarification:** The plan originally referenced a `restore()` method — no such method exists. The correct method is `deserializeWebviewPanel()` (line 188), which is the panel-restore entry point called by VS Code when a serialized webview panel is restored.

**Dispose in `dispose()` only — NOT in `disposeWatchers()`.** The `onDidSaveTextDocument` listener is workspace-global (it watches all saved documents, not specific folder patterns). `disposeWatchers()` is called from `onDidChangeWorkspaceFolders` (lines 146, 240) to re-register folder-specific watchers after workspace changes. If `_saveTextDocListener` were disposed there, it would never be re-registered, silently breaking auto-refresh after any workspace folder change.

Add disposal in `dispose()` (after the `disposeWatchers()` call at line 289, before the `_disposables.forEach` at line 298):

```ts
this._saveTextDocListener?.dispose();
this._saveTextDocListener = undefined;
```

> The `onDidDispose` handler (line 125) sets `_panel = undefined` and calls `disposeWatchers()`. The save listener's `if (!this._panel?.visible) return;` guard makes it a no-op when the panel is gone, so not disposing it in `onDidDispose` is harmless. It is properly cleaned up when `dispose()` is called (extension deactivation).

### 3. Backend: Add `Cache-Control: no-store` to localhost server responses (`src/services/DesignPanelProvider.ts`)

In `_handleHtmlServerRequest`, update both `res.writeHead` calls to include `Cache-Control`:

Line 1318 (HTML response):
```ts
res.writeHead(200, { 'Content-Type': mimeType, 'Cache-Control': 'no-store' });
```

Line 1321 (non-HTML response):
```ts
res.writeHead(200, { 'Content-Type': mimeType, 'Cache-Control': 'no-store' });
```

Also add it to **all three** 403 error responses for consistency (lines 1129, 1139, and 1147):
```ts
res.writeHead(403, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
```

> **Clarification:** The original plan only listed lines 1129 and 1139, missing the third 403 at line 1147 (the `_SERVER_DENY_LIST` check). All three should be updated for consistency.

### 4. Frontend: No changes needed

The frontend `handlePreviewReady()` already handles `isAutoRefreshed: true` correctly:
- Line 1074: `iframe.src = isAutoRefreshed ? msg.iframeSrc + '?t=' + Date.now() : msg.iframeSrc;` — cache-busting for iframe src
- Line 1097: `statusHtml.textContent = isAutoRefreshed ? 'Auto-refreshed' : '';` — status text
- Line 1039: `if (requestId !== undefined && requestId !== -1 && requestId !== state.previewRequestId) return;` — accepts `requestId: -1`

No frontend changes are required.

## Verification Plan

### Automated Tests

> Per session directives, automated tests are skipped in this planning session. The test suite will be run separately by the user. The following manual verification steps should be performed after implementation.

1. **Setup** — Configure an HTML folder in the Design panel. Select an HTML file in the HTML Previews tab. Confirm the preview renders in the iframe.
2. **Edit and save in VS Code editor** — Open the same HTML file in the VS Code editor. Make a visible change (e.g., change a heading text). Save the file (Cmd+S).
3. **Verify auto-refresh** — The iframe preview should update automatically within ~300ms of saving. The status bar should briefly show "Auto-refreshed".
4. **Verify rapid saves** — Save the file multiple times quickly (Cmd+S repeatedly). The 300ms debounce should collapse the burst into a single refresh. The final state should reflect the latest save.
5. **Verify no refresh when different file changes** — With file A being previewed, edit and save file B (in the same folder). The preview of file A should NOT refresh.
6. **Verify no refresh when tab is not active** — Switch to the Design tab (clears `_activeHtmlPreview`). Edit and save the previously previewed HTML file. No errors should occur and no unnecessary refresh should be sent.
7. **Verify image auto-refresh** — Select an image file in the HTML Previews tab. Edit and save it externally. The preview should update (cache-busted via `?t=`).
8. **Verify srcdoc fallback** — Force the `srcdoc` path (e.g., a folder whose localhost server fails to start). Edit and save; confirm the inline preview still updates.
9. **Verify Claude tab auto-refresh** — Select an HTML file in the Claude tab. Edit and save it. The Claude preview should auto-refresh.
10. **Verify external editor save** — Edit the HTML file in an external editor (e.g., vim in a terminal). Save. The tree should refresh via the watcher/poll. The preview may or may not auto-refresh depending on whether `onDidChange`/`onDidCreate` fires for external edits (accepted scope boundary — `onDidSaveTextDocument` only covers VS Code editor saves).
11. **Verify workspace folder change preserves save listener** — Add or remove a workspace folder (triggers `onDidChangeWorkspaceFolders` → `disposeWatchers()`). Then edit and save the previewed HTML file in the VS Code editor. The preview should still auto-refresh (confirms `_saveTextDocListener` was NOT disposed by `disposeWatchers()`).
12. **Verify panel restore** — Close the Design panel, then reopen it (or reload the VS Code window with panel serialization). Select an HTML file, edit and save in the editor. Auto-refresh should work (confirms `_registerSaveTextDocListener()` was called in `deserializeWebviewPanel()`).

---

## Reviewer Pass (2026-06-25)

### Stage 1: Adversarial Findings

| # | Severity | File:Line | Finding |
|---|----------|-----------|---------|
| 1 | NIT | `DesignPanelProvider.ts:1166` | 404 response in `_handleHtmlServerRequest` missing `Cache-Control: no-store` — all other 5 `writeHead` calls have it. Plan said "all responses." |
| 2 | — | `DesignPanelProvider.ts:430-433` | `onDidCreate` HTML watcher wiring: VERIFIED OK |
| 3 | — | `DesignPanelProvider.ts:460-463` | `onDidCreate` Claude watcher wiring: VERIFIED OK (Claude `onDidChange` also wired) |
| 4 | — | `DesignPanelProvider.ts:50,140,233,301-302,3143-3151` | `onDidSaveTextDocument` listener: registration, idempotency guard, disposal in `dispose()` only (NOT `disposeWatchers()`): VERIFIED OK |
| 5 | — | `DesignPanelProvider.ts:1140,1150,1158,1329,1332` | `Cache-Control: no-store` on all 200/403 responses: VERIFIED OK |
| 6 | — | `design.js` | Frontend unchanged for this plan (design.js diff is from Claude-tab-folder-management plan): VERIFIED OK |
| 7 | — | `DesignPanelProvider.ts:3165-3186` | Shared debounce collapses `onDidSaveTextDocument` + `onDidCreate` double-fire: VERIFIED OK |

### Stage 2: Balanced Synthesis

No CRITICAL or MAJOR findings. One NIT: the 404 response at line 1166 was the only `writeHead` in `_handleHtmlServerRequest` missing `Cache-Control: no-store`. Low real-world risk (auto-refresh uses `?t=` cache-busting on the iframe src, so a stale 404 won't be reused), but fixed for consistency with the plan's "all responses" intent.

### Fixes Applied

- **`src/services/DesignPanelProvider.ts:1166`** — Added `'Cache-Control': 'no-store'` to the 404 `writeHead` call. All 6 `writeHead` calls in `_handleHtmlServerRequest` now include the header.

### Verification Results

- **Typecheck/compilation:** Skipped per session directives.
- **Automated tests:** Skipped per session directives.
- **Manual verification:** All 12 manual verification steps in the plan remain valid and should be run by the user.
- **Static review:** All plan requirements verified against actual code. All `writeHead` calls confirmed consistent. Listener lifecycle confirmed correct (dispose in `dispose()` only, not `disposeWatchers()`).

### Remaining Risks

- **External editor saves** — `onDidSaveTextDocument` only fires for VS Code editor saves. External editor edits rely on `onDidChange`/`onDidCreate` from the file watcher, which may not fire on macOS atomic saves. This is an accepted scope boundary per the plan.
- **No automated test coverage** — The fix has no regression test. The 12 manual verification steps are the safety net. A future test could mock `onDidSaveTextDocument` and verify `_autoRefreshHtmlPreview` is called.

---

**Recommendation:** Complexity is 3/10 → **Send to Intern**
