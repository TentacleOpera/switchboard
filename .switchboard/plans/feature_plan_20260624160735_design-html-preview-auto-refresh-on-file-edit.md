# Add Auto-Refresh on File Edit to HTML Previews Tab in design.html

## Goal

Wire the existing file-watching infrastructure to re-render the **active** HTML Previews iframe (with `isAutoRefreshed: true`) when the currently-previewed file is edited, so the user no longer has to manually re-select the file in the sidebar to see changes.

### Problem
In the Design panel (`design.html`), the **HTML Previews** tab does not refresh the iframe preview when the underlying HTML file is edited. The user must manually re-select the file in the sidebar tree to see their changes. Other tabs (Design docs, Briefs) have the same limitation, but the issue specifically calls out the HTML Previews tab.

### Root Cause Analysis
The file-watching infrastructure exists but is only wired to refresh the **sidebar file tree**, not the **active preview**:

1. **Backend watcher** (`DesignPanelProvider.ts`, lines 390-410 — _Clarification: the plan originally cited 398-407; the actual `_setupHtmlFolderWatchers` block is 390-410_): A `vscode.FileSystemWatcher` is created for each configured HTML folder. On any file change/create/delete, it calls `_sendHtmlDocsReady()`.

2. **`_sendHtmlDocsReady()`** (lines 434-484): This method debounces (300ms), re-reads the folder, and posts an `htmlDocsReady` message containing the updated file tree nodes. It does **NOT** re-fetch or re-send the currently displayed preview content.

3. **Frontend `htmlDocsReady` handler** (`design.js`, line 2681): Re-renders the sidebar tree via `renderHtmlDocs()`. It does **NOT** check whether the currently previewed file was the one that changed, and does **NOT** re-request the preview.

4. **`isAutoRefreshed` flag**: The frontend `handlePreviewReady()` function (line 964) already has logic to display "Auto-refreshed" status text (line 1026) and to append a cache-busting `?t=` query param to iframe URLs (line 1003). However, this flag is **never set to `true`** by the backend — the `fetchPreview` handler (lines 1427-1527) always sends `previewReady` without `isAutoRefreshed`. The infrastructure for auto-refresh exists in the frontend but is never triggered.

   _Clarification (verified line numbers): the plan originally cited frontend lines 1037/1015/1002/980; the live file has the equivalent logic at 1026 (status text), 1003 (iframe cache-bust), 990 (image cache-bust), and 968 (`requestId === -1` skip)._

**The fix**: When the file watcher fires and a file is currently being previewed in the HTML Previews tab, the backend should re-send the preview for that file with `isAutoRefreshed: true`. The frontend already handles this flag correctly — it just needs the backend to send it.

## Metadata
- **Tags:** feature, backend, ui
  - _(Allowed-list tags only. Original descriptive keywords retained for searchability: design.html, html-previews, auto-refresh, file-watcher, iframe.)_
- **Complexity:** 4/10

## User Review Required
- **None.** This is a self-contained behavioural fix that reuses existing infrastructure and a frontend flag the UI already honours. No product decisions are outstanding.

## Complexity Audit
**Routine with moderate wiring.** The frontend already supports `isAutoRefreshed` (cache-busting query param, status text). The backend has the file watcher and the `fetchPreview` logic. The missing piece is: (a) tracking which file is currently being previewed in the backend, and (b) re-sending the preview when that file changes. The main complexity is in tracking the active preview state and avoiding redundant refreshes (e.g., when the file tree refresh is already debounced).

### Routine
- Adding one nullable instance field to track the active HTML preview.
- Recording that field inside the existing `fetchPreview` case.
- Adding a `uri` parameter to the existing `watcher.onDidChange` callback.
- Re-using existing helpers (`_getOrCreateHtmlServer`, `_buildLocalhostUrl`, `_injectLocalCsp`, `asWebviewUri`) — no new patterns.
- Frontend requires **zero** changes (the flag is already honoured).

### Complex / Risky
- **Avoiding logic drift between `fetchPreview` and the new refresh path.** The original draft duplicated ~50 lines of preview-building logic, which would silently diverge (it already omits `parsedJson` for YAML). Mitigation: extract a shared `_buildAndSendPreview(...)` helper (see Proposed Changes §0).
- **Debounce coherence.** The tree refresh is debounced at 300ms; the preview refresh must not fire un-throttled on every keystroke-save burst.
- **Editing the existing `activeTabChanged` case rather than adding a duplicate** (a second `case 'activeTabChanged'` would be unreachable dead code).

## Edge-Case & Dependency Audit

### Race Conditions
- **Mid-write reads** — A `onDidChange` can fire while the editor is still flushing the file to disk, yielding a truncated/empty read. The refresh path must wrap the read in try/catch and silently skip on failure (the next save fires another event). The original draft already does this.
- **Debounce / rapid saves** — `_sendHtmlDocsReady()` debounces at 300ms. The preview refresh should share an equivalent debounce so multi-save bursts collapse into one refresh and the final state reflects the latest save. The original draft fired the refresh un-debounced (contradicting Verification step 7) — corrected in Proposed Changes §2.
- **Stale active-preview after tab switch** — If the user switches files quickly, `_activeHtmlPreview` reflects the latest `fetchPreview`. The watcher only matches by absolute path, so an in-flight refresh for a no-longer-active file is naturally filtered by the path equality check.

### Security
- **Path confinement** — The refresh re-derives the absolute path from the tracked `sourceFolder` + `docId`. Since `sourceFolder` was already validated against configured folders during the original `fetchPreview` (lines 1438-1456), and the watcher only fires for paths inside configured HTML folders, no new traversal surface is opened. The shared helper (§0) preserves the existing `absPath.startsWith(resolvedFolder + path.sep)` guard.
- **No new server exposure** — Re-uses the already-running localhost server keyed by `sourceFolder`; no new ports or routes.

### Side Effects
- **Wasted refresh while hidden/inactive** — Clearing `_activeHtmlPreview` on `activeTabChanged` away from `html-preview` ensures no refresh when another tab is active. Panel-hidden-but-tab-active refreshes are harmless (retainContextWhenHidden) and rare; not specially guarded.
- **iframe vs srcdoc** — The localhost path (`iframeSrc`) gets `?t=` cache-busting on auto-refresh; the `srcdoc` fallback replaces inline content wholesale so it always reflects the new file without cache-busting. Both refresh correctly.
- **Image previews** — Images always get `?t=` cache-busting (line 990), so an edited image in the HTML folder refreshes too.

### Dependencies & Conflicts
- **Pre-existing 4s external-file poll** (`_pollTick`, line 2792) refreshes the **tree** for files changed by external editors (which VS Code's watcher may miss) but does **not** re-render the preview. This change is watcher-driven, so it covers in-VS-Code edits (the case the issue describes); external-editor edits will still update the tree via the poll but will not auto-refresh the preview. This is an accepted scope boundary, not a regression (today neither path refreshes the preview).
- **Multiple workspace roots** — Watchers cover all configured HTML folders across all roots; the path-equality match selects the right one. Preserved.
- **`activeTabChanged` already handled** at line 1307 — must MERGE the clear-on-switch logic into that case, not add a second one.

## Dependencies
- None. This plan is self-contained within `DesignPanelProvider.ts` and requires no other in-flight sessions.

## Adversarial Synthesis

**Risk Summary:** Key risks: (1) logic drift if `fetchPreview` and the refresh path duplicate preview-building code; (2) un-throttled refreshes on rapid saves; (3) accidentally adding a duplicate `activeTabChanged` case. Mitigations: extract a single `_buildAndSendPreview(...)` helper used by both call sites, debounce the refresh to match the 300ms tree debounce, and merge into the existing `activeTabChanged` case. With those, the change reduces to a tracked field + a one-line watcher callback edit and is low-risk.

## Proposed Changes

> **Implementation note (correction over original draft):** Rather than duplicating the ~50 lines of `fetchPreview` body inside a new `_autoRefreshHtmlPreview` (which drops `parsedJson` for YAML and will drift over time), extract the preview-building/sending logic into a shared private method and call it from both the `fetchPreview` message handler and the watcher. The original duplication-based draft is preserved below §2 (Alternative) for reference, with its bugs flagged.

### 0. Backend: Extract a shared preview builder (`DesignPanelProvider.ts`) — RECOMMENDED

Refactor the body of `case 'fetchPreview'` (lines 1427-1527) into a reusable method. The message handler becomes a thin caller, and the watcher reuses the identical logic:

```ts
// Returns nothing; posts 'previewReady' or 'previewError' itself.
private async _buildAndSendPreview(opts: {
    sourceId: string;
    sourceFolder: string;
    docId: string;
    requestId: number;        // -1 for auto-refresh (frontend skips request matching)
    isAutoRefreshed?: boolean;
}): Promise<void> {
    const { sourceId, sourceFolder, docId, requestId, isAutoRefreshed } = opts;
    try {
        if (!sourceFolder) throw new Error('sourceFolder is required');
        const relativePath = docId.includes(':')
            ? docId.substring(docId.indexOf(':') + 1)
            : docId;

        // Only configured design/html/briefs/images folders may be read from.
        const allowedFolders = new Set<string>();
        for (const root of this._getWorkspaceRoots()) {
            try {
                const svc = this._getLocalFolderService(root);
                svc.getDesignFolderPaths().forEach(p => allowedFolders.add(path.resolve(p)));
                svc.getHtmlFolderPaths().forEach(p => allowedFolders.add(path.resolve(p)));
                svc.getBriefsFolderPaths().forEach(p => allowedFolders.add(path.resolve(p)));
                svc.getImagesFolderPaths().forEach(p => allowedFolders.add(path.resolve(p)));
            } catch {}
        }
        const resolvedFolder = path.resolve(sourceFolder);
        if (!allowedFolders.has(resolvedFolder)) {
            throw new Error('sourceFolder is not a configured design/html/briefs/images folder');
        }
        const absPath = path.resolve(resolvedFolder, relativePath);
        if (absPath !== resolvedFolder && !absPath.startsWith(resolvedFolder + path.sep)) {
            throw new Error('Invalid file path');
        }

        const fileExt = path.extname(relativePath).toLowerCase();
        const isImage = ['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.bmp'].includes(fileExt);
        const isHtmlFile = fileExt === '.html' || fileExt === '.htm';

        let fileContent = '';
        let webviewUri: string | undefined;
        if (isImage) {
            webviewUri = this._panel?.webview.asWebviewUri(vscode.Uri.file(absPath)).toString();
        } else {
            fileContent = await fs.promises.readFile(absPath, 'utf8');
            if (isHtmlFile) {
                webviewUri = this._panel?.webview.asWebviewUri(vscode.Uri.file(absPath)).toString();
            }
        }

        let iframeSrc: string | undefined;
        if (isHtmlFile) {
            try {
                const serverEntry = await this._getOrCreateHtmlServer(resolvedFolder);
                iframeSrc = this._buildLocalhostUrl(serverEntry, resolvedFolder, absPath);
            } catch {
                iframeSrc = undefined;
            }
        }

        const fileTypeMap: Record<string, string> = {
            '.json': 'json',
            '.yaml': 'yaml', '.yml': 'yaml',
            '.md': 'markdown', '.markdown': 'markdown', '.txt': 'markdown'
        };
        const fileType = isImage ? 'image' : (fileTypeMap[fileExt] || 'text');

        let parsedJson: any = undefined;
        if (fileType === 'yaml') {
            try { parsedJson = require('js-yaml').load(fileContent); } catch {}
        }

        this.postMessage({
            type: 'previewReady',
            sourceId,
            requestId,
            content: isImage ? '' : fileContent,
            docName: path.basename(relativePath),
            filePath: absPath,
            fileType,
            parsedJson,
            isImage,
            webviewUri,
            iframeSrc,
            htmlContent: isHtmlFile ? this._injectLocalCsp(fileContent) : undefined,
            isAutoRefreshed: isAutoRefreshed || undefined
        });
    } catch (err: any) {
        // Auto-refresh (requestId === -1) must fail silently — the file may be mid-write.
        if (requestId === -1) return;
        this.postMessage({
            type: 'previewError',
            sourceId,
            requestId,
            error: err.message || String(err)
        });
    }
}
```

Then `case 'fetchPreview'` collapses to:

```ts
case 'fetchPreview': {
    const rawDocId = String(message.docId || '');
    if (message.sourceId === 'html-folder' && message.sourceFolder) {
        this._activeHtmlPreview = {
            sourceFolder: path.resolve(message.sourceFolder),
            docId: rawDocId,
            sourceId: message.sourceId
        };
    }
    await this._buildAndSendPreview({
        sourceId: message.sourceId,
        sourceFolder: message.sourceFolder,
        docId: rawDocId,
        requestId: message.requestId,
        isAutoRefreshed: false
    });
    break;
}
```

### 1. Backend: Track the active preview file (`DesignPanelProvider.ts`)

Add a field alongside the other watcher/state fields (near lines 45-55):

```ts
private _activeHtmlPreview: { sourceFolder: string; docId: string; sourceId: string } | null = null;
private _autoRefreshDebounce?: NodeJS.Timeout;
```

(The recording of this field happens in §0's slimmed `fetchPreview` case.)

### 2. Backend: Re-send preview on file change (`DesignPanelProvider.ts`)

Modify the HTML folder watcher (line 402) to also trigger a debounced preview refresh. **Note the parameter is `uri`, captured by the arrow function:**

```ts
// _setupHtmlFolderWatchers, replace:
watcher.onDidChange(() => this._sendHtmlDocsReady());
// with:
watcher.onDidChange((uri) => {
    this._sendHtmlDocsReady();
    this._autoRefreshHtmlPreview(uri);
});
// onDidCreate / onDidDelete remain tree-only.
```

Add the refresh method (debounced; delegates to the shared §0 helper):

```ts
private _autoRefreshHtmlPreview(changedUri: vscode.Uri): void {
    if (!this._activeHtmlPreview || !this._panel) return;

    const active = this._activeHtmlPreview;
    const relativePath = active.docId.includes(':')
        ? active.docId.substring(active.docId.indexOf(':') + 1)
        : active.docId;
    const activePath = path.resolve(active.sourceFolder, relativePath);

    // Only refresh when the changed file IS the file currently previewed.
    if (path.resolve(changedUri.fsPath) !== activePath) return;

    // Debounce to match the 300ms tree-refresh and collapse rapid-save bursts.
    if (this._autoRefreshDebounce) clearTimeout(this._autoRefreshDebounce);
    this._autoRefreshDebounce = setTimeout(() => {
        this._autoRefreshDebounce = undefined;
        if (!this._activeHtmlPreview || !this._panel) return;
        this._buildAndSendPreview({
            sourceId: active.sourceId,
            sourceFolder: active.sourceFolder,
            docId: active.docId,
            requestId: -1,            // frontend accepts -1 without request matching
            isAutoRefreshed: true
        });
    }, 300);
}
```

> **Alternative (original draft — preserved, with bugs flagged):** The first draft added a standalone `async _autoRefreshHtmlPreview(changedUri)` that duplicated the fetchPreview body inline. Two defects to avoid if that route is taken: (a) it referenced `uri.fsPath` where the parameter is `changedUri` (use `changedUri.fsPath`); (b) it was not debounced, so rapid saves fire one refresh each — contradicting Verification step 7. The §0 + §2 approach above supersedes it.

### 3. Backend: Clear active preview on tab switch (`DesignPanelProvider.ts`)

The `activeTabChanged` message **already has a `case` at line 1307** — do NOT add a second one (it would be unreachable). Merge the clear into the existing case:

```ts
case 'activeTabChanged': {
    this._activeTab = message.tab;
    if (message.tab !== 'html-preview') {
        this._activeHtmlPreview = null;          // <-- add this line
    }
    if (this._isPolledTab(message.tab) && this._panel?.visible) {
        this._startExternalFilePoll();
    } else {
        this._stopExternalFilePoll();
    }
    break;
}
```

Also clear the debounce timer on dispose (in the existing `dispose()` / `disposeWatchers()` path is fine):

```ts
if (this._autoRefreshDebounce) { clearTimeout(this._autoRefreshDebounce); this._autoRefreshDebounce = undefined; }
```

### 4. Frontend: No changes needed

The frontend `handlePreviewReady()` (line 964) already handles `isAutoRefreshed` for the `html-folder` source:
- Line 1003: `iframe.src = isAutoRefreshed ? msg.iframeSrc + '?t=' + Date.now() : msg.iframeSrc;` — cache-busting for iframe src
- Line 990: `imageImg.src = webviewUri + '?t=' + Date.now();` — cache-busting for images (always applied)
- Line 1026: `statusHtml.textContent = isAutoRefreshed ? 'Auto-refreshed' : '';` — status text
- Line 968: `if (requestId !== undefined && requestId !== -1 && requestId !== state.previewRequestId) return;` — accepts `requestId: -1`
- `fetchPreview` is sent with `sourceId: 'html-folder'`, `docId`, `sourceFolder`, `requestId` (line 890) — matching the backend tracking.

No frontend changes are required.

## Verification Plan
1. **Setup** — Configure an HTML folder in the Design panel. Select an HTML file in the HTML Previews tab. Confirm the preview renders.
2. **Edit and save** — Open the same HTML file in the VS Code editor. Make a visible change (e.g., change a heading text). Save the file.
3. **Verify auto-refresh** — The iframe preview should update automatically within ~300ms of saving. The status bar should show "Auto-refreshed".
4. **Verify image auto-refresh** — Select an image file in the HTML Previews tab. Edit and save it. The preview should update (cache-busted).
5. **Verify no refresh when different file changes** — With file A being previewed, edit and save file B (in the same folder). The preview of file A should NOT refresh.
6. **Verify no refresh when tab is not active** — Switch to the Design tab (clears `_activeHtmlPreview`). Edit and save the previously previewed HTML file. No errors should occur and no unnecessary refresh should be sent.
7. **Verify rapid saves** — Save the file multiple times quickly. The 300ms debounce should collapse the burst into a single refresh. The final state should reflect the latest save.
8. **Verify tab re-entry** — Switch away from HTML Previews and back. The file tree should refresh (existing behaviour). Select a file again and confirm auto-refresh still works.
9. **Verify srcdoc fallback** — Force the `srcdoc` path (e.g., a folder whose localhost server fails to start). Edit and save; confirm the inline preview still updates.

### Automated Tests
- No automated test suite currently covers `DesignPanelProvider` preview behaviour, and the change is exercised through the VS Code webview message bus + `FileSystemWatcher` (hard to unit-test without an Extension Host). Verification is **manual** per the steps above. _(Per session directive, the user will run any tests separately; no new test scaffolding is added here.)_
- If unit coverage is later desired, the cleanest seam is `_buildAndSendPreview(...)` (§0): inject a fake `postMessage` and assert the emitted `previewReady` payload (`isAutoRefreshed`, `requestId: -1`, `iframeSrc`) for a given file, plus the path-equality gate in `_autoRefreshHtmlPreview`.

---

**Recommendation: Send to Coder** (Complexity 4/10).
