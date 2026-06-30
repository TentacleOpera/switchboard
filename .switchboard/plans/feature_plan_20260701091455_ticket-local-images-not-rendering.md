# Ticket Docs Don't Show Local Images Until Pushed to Remote

## Goal

### Problem
Ticket documents in the Tickets tab of `planning.html` do not display locally-referenced images until the ticket has been pushed to the remote (ClickUp/Linear). After pushing, the images appear — because the remote returns the description with hosted `https://` image URLs.

### Background Context
Tickets are stored as local markdown files on disk (under `.switchboard/tickets/<provider>/.../<provider>_<id>_<slug>.md` or a configured global `ticketSaveLocation`). These files can contain image references such as `![](assets/screenshot.png)` (relative) or `![](file:///Users/.../img.png)` (absolute).

When a ticket card is clicked, the webview sends `readLocalTicketFile` to the backend (`PlanningPanelProvider.ts` ~line 5453). The backend reads the raw file, strips front-matter, and posts `localTicketFileRead` back with the raw `content`. The webview handler (`planning.js` ~line 4534) then calls the shared `renderMarkdown(localBodyMarkdown)` (`sharedUtils.js` line 98), which converts `![alt](url)` into `<img src="${safeUrl}" ...>` (line 223-226) **without any path rewriting**.

### Root Cause
Two compounding issues prevent local images from rendering:

1. **No path-to-webview-URI rewriting.** `renderMarkdown` emits the image `src` verbatim from the markdown. A relative path like `assets/screenshot.png` resolves against the webview's origin (`https://file+.vscode-resource.vscode-cdn.net/...`), not the ticket file's directory on disk — so it 404s. An absolute `file:///...` path is blocked by CSP (see #2). The `readLocalTicketFile` backend handler has the ticket file's on-disk path (`filePath`) but discards it — it only sends `title` and `content`, never the directory or rewritten image URIs.

2. **CSP blocks `file:` images.** The `planning.html` Content-Security-Policy (line 6) declares:
   ```
   img-src {{WEBVIEW_CSP_SOURCE}} vscode-webview: vscode-webview-resource: vscode-resource: https: data:
   ```
   Note the **absence of `file:`**. (By contrast, `design.html` includes `file:` in its `img-src`.) So even absolute `file:///` image references are silently blocked.

After pushing to the remote, the provider (ClickUp/Linear) hosts the image on its CDN and the task description comes back with `https://...` URLs. The `https:` scheme is allowed by CSP, so the images render — but only via the API-fetched description (`clickupTaskDetailsLoaded` / `linearTaskDetailsLoaded`), not the local file.

The workspace folders are already registered as `localResourceRoots` (`PlanningPanelProvider.ts` line 7063), so `asWebviewUri` for files inside the workspace will produce URIs the CSP permits (`vscode-resource:` / `vscode-webview-resource:`). For ticket files outside the workspace (global `ticketSaveLocation`), the `folderUris` in `localResourceRoots` must include that location — verify this is already the case or add it.

## Metadata
- **Tags:** tickets, images, webview, csp, local-files, planning-webview
- **Complexity:** 5/10

## Complexity Audit
**Complex/Risky.** The fix touches the backend message handler (`readLocalTicketFile`) and requires image-path rewriting logic that must correctly resolve relative paths against the ticket file's directory, handle both relative and absolute `file://` references, and produce CSP-legal `asWebviewUri` URIs. Edge cases around path traversal, missing files, and non-workspace ticket locations add risk. A CSP change may also be needed if any images live outside registered resource roots.

## Edge-Case & Dependency Audit
- **Relative vs absolute paths:** `![](assets/img.png)` must resolve against the ticket file's directory; `![](/abs/path/img.png)` and `![](file:///abs/path/img.png)` must be handled as absolute.
- **Already-https images:** Must be left untouched (don't double-rewrite remote URLs).
- **`data:` URIs:** Must be left untouched.
- **Images outside resource roots:** If a ticket file references an image outside the workspace and outside `folderUris`, `asWebviewUri` will still produce a URI, but CSP (`vscode-resource:`) will block it unless the root is registered. Need to either register the ticket directory's parent as a resource root, or add `file:` to `img-src` as a fallback.
- **`ticketFileChanged` handler** (`planning.js` ~line 4576) also calls `renderMarkdown` on local content — the same rewriting must apply there (the backend `ticketFileChanged` message would need to carry rewritten content or the directory, OR the rewriting should move to the webview with a shared helper that receives the ticket dir).
- **Push flow:** When `pushTicketEdits` sends the description to the remote, the **original** local markdown (with local paths) must be sent, not the rewritten-for-display version. The rewriting must be display-only — never written back to the file. This is naturally satisfied if rewriting happens at read/render time, not at save time.
- **ClickUp `markdownDescription` vs `description`:** The API-fetched description uses remote URLs and is rendered via `markdown.api.render` (backend) — unaffected by this fix.

## Proposed Changes

### `src/services/PlanningPanelProvider.ts` — `readLocalTicketFile` handler (~line 5453)
After reading the file content, rewrite local image references to `asWebviewUri` URIs before posting to the webview. Send the rewritten `content` for display.

```ts
case 'readLocalTicketFile': {
    const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
    const provider = msg.provider as 'clickup' | 'linear';
    const id = msg.id;
    if (!workspaceRoot || !provider || !id) {
        this._panel?.webview.postMessage({ type: 'localTicketFileRead', provider, id, success: false });
        break;
    }
    const filePath = this._findTicketFilePath(workspaceRoot, provider, id);
    if (!filePath) {
        this._panel?.webview.postMessage({ type: 'localTicketFileRead', provider, id, success: false });
        break;
    }
    try {
        const raw = fs.readFileSync(filePath, 'utf8');
        const content = raw.replace(/^---\n[\s\S]*?\n---\n?/, '').trim();
        const h1 = content.match(/^#\s+(.+)$/m);
        const title = h1 ? h1[1].trim() : id;
        // Rewrite local image paths to webview-accessible URIs for display
        const displayContent = this._rewriteLocalImagePaths(content, path.dirname(filePath));
        this._panel?.webview.postMessage({ type: 'localTicketFileRead', provider, id, success: true, title, content: displayContent });
    } catch {
        this._panel?.webview.postMessage({ type: 'localTicketFileRead', provider, id, success: false });
    }
    break;
}
```

### `src/services/PlanningPanelProvider.ts` — new helper `_rewriteLocalImagePaths`
Add a private method that scans markdown for `![alt](url)` and rewrites local paths (relative or `file://`) to `asWebviewUri` URIs, leaving `http(s):`, `data:`, and `vscode-resource:` URIs untouched.

```ts
private _rewriteLocalImagePaths(markdown: string, baseDir: string): string {
    return markdown.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (match, alt, url) => {
        const trimmed = url.trim();
        // Leave remote, data, and already-webview URIs alone
        if (/^(https?:|data:|vscode-resource:|vscode-webview-resource:|vscode-webview:)/i.test(trimmed)) {
            return match;
        }
        try {
            let absPath: string;
            if (/^file:\/\/\//i.test(trimmed)) {
                absPath = vscode.Uri.parse(trimmed).fsPath;
            } else {
                absPath = path.resolve(baseDir, trimmed);
            }
            if (!fs.existsSync(absPath)) { return match; } // don't rewrite missing files
            const webviewUri = this._panel?.webview.asWebviewUri(vscode.Uri.file(absPath));
            if (!webviewUri) { return match; }
            return `![${alt}](${webviewUri.toString()})`;
        } catch {
            return match;
        }
    });
}
```

### `src/services/PlanningPanelProvider.ts` — `ticketFileChanged` message
Apply the same rewriting to the `ticketFileChanged` content path so live file-watch updates also show images. Locate where `ticketFileChanged` is posted (the file watcher) and route its content through `_rewriteLocalImagePaths` with the ticket's directory, OR pass `baseDir` in the message and rewrite in the webview. Simplest: rewrite at the source before posting.

### `src/webview/planning.html` — CSP fallback (line 6)
If some ticket image locations are not registered as `localResourceRoots`, add `file:` to `img-src` as a safety net (matching `design.html`):

**Before:**
```
img-src {{WEBVIEW_CSP_SOURCE}} vscode-webview: vscode-webview-resource: vscode-resource: https: data:;
```
**After:**
```
img-src {{WEBVIEW_CSP_SOURCE}} vscode-webview: vscode-webview-resource: vscode-resource: https: data: file:;
```

> Prefer the `asWebviewUri` rewriting as the primary mechanism (it's the VS Code-sanctioned approach). The `file:` CSP addition is a fallback for out-of-root images; verify whether `folderUris` already covers the global `ticketSaveLocation` before relying on it.

### `src/webview/planning.js` — `localTicketFileRead` handler (~line 4542)
No change needed if the backend sends pre-rewritten content. The existing `renderMarkdown(localBodyMarkdown)` will then emit `<img src="vscode-webview-resource://...">` which the CSP allows. Confirm the `descriptionMarkdown` stored for edit mode (line 4554) is also the rewritten version — **but the edit textarea should show the ORIGINAL local paths**, not the webview URIs. To support this, send both `content` (rewritten, for display) and `rawContent` (original, for editing) from the backend, and use `rawContent` for `descriptionMarkdown` / edit mode.

Adjust the backend post:
```ts
this._panel?.webview.postMessage({ type: 'localTicketFileRead', provider, id, success: true, title, content: displayContent, rawContent: content });
```
And the webview handler:
```js
const localBodyMarkdown = (msg.rawContent || msg.content || '').replace(/^#[^\n]*\n?/, '').trim();
const rendered = renderMarkdown((msg.content || '').replace(/^#[^\n]*\n?/, '').trim());
```
So `descriptionMarkdown` (used by edit mode) keeps original paths, while `renderedDescriptionHtml` (used by preview) uses webview URIs.

## Verification Plan
1. Create a ClickUp/Linear ticket whose local markdown file references a local image via a relative path (`![](assets/screenshot.png)`). Place the image next to the ticket file.
2. Open the Tickets tab, select the ticket (before pushing) — confirm the image now renders in the preview.
3. Click **Edit** — confirm the textarea shows the **original** relative path (`assets/screenshot.png`), not a `vscode-webview-resource://` URI.
4. Click **Save** (without pushing) — confirm the local file still contains the original relative path (display-only rewriting, no file mutation).
5. Push the ticket to the remote — confirm the push sends the original local-path markdown (or the provider's upload flow handles it) and that after the API refetch the remote-hosted `https://` images render.
6. Test with an absolute `file:///` image path — confirm it renders.
7. Test with an `https://` image — confirm it still renders (not double-rewritten).
8. Test with a missing image file — confirm no crash and the broken-img placeholder shows.
9. Toggle claudify/cyber themes — confirm no visual regression.
10. Edit the ticket file externally (file watcher) — confirm the `ticketFileChanged` update also shows the image.
