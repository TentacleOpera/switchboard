# Ticket Docs Don't Show Local Images Until Pushed to Remote

## Goal

Ticket documents in the Tickets tab of `planning.html` must render locally-referenced images (relative and absolute `file://` paths) immediately from the on-disk markdown file — without requiring a push to the remote (ClickUp/Linear) first. Today images only appear after the remote hosts them and returns `https://` URLs.

### Problem
Ticket documents in the Tickets tab of `planning.html` do not display locally-referenced images until the ticket has been pushed to the remote (ClickUp/Linear). After pushing, the images appear — because the remote returns the description with hosted `https://` image URLs.

### Background Context
Tickets are stored as local markdown files on disk (under `.switchboard/tickets/<provider>/.../<provider>_<id>_<slug>.md` or a configured global `ticketSaveLocation`). These files can contain image references such as `![](assets/screenshot.png)` (relative) or `![](file:///Users/.../img.png)` (absolute).

When a ticket card is clicked, the webview sends `readLocalTicketFile` to the backend (`PlanningPanelProvider.ts` ~line 5453). The backend reads the raw file, strips front-matter, and posts `localTicketFileRead` back with the raw `content`. The webview handler (`planning.js` ~line 4534) then calls the shared `renderMarkdown(localBodyMarkdown)` (`sharedUtils.js` line 98), which converts `![alt](url)` into `<img src="${safeUrl}" ...>` (line 223-226) **without any path rewriting**.

### Root Cause
Three compounding issues prevent local images from rendering:

1. **No path-to-webview-URI rewriting.** `renderMarkdown` emits the image `src` verbatim from the markdown. A relative path like `assets/screenshot.png` resolves against the webview's origin (`https://file+.vscode-resource.vscode-cdn.net/...`), not the ticket file's directory on disk — so it 404s. An absolute `file:///...` path is blocked by CSP (see #2). The `readLocalTicketFile` backend handler has the ticket file's on-disk path (`filePath`) but discards it — it only sends `title` and `content`, never the directory or rewritten image URIs.

2. **CSP blocks `file:` images.** The `planning.html` Content-Security-Policy (line 6) declares:
   ```
   img-src {{WEBVIEW_CSP_SOURCE}} vscode-webview: vscode-webview-resource: vscode-resource: https: data:
   ```
   Note the **absence of `file:`**. (By contrast, `design.html` includes `file:` in its `img-src`.) So even absolute `file:///` image references are silently blocked.

3. **`sanitizeUrl` rewrites webview-scheme URIs to `#`.** *(Discovered during adversarial review.)* Even after the backend rewrites image paths to `asWebviewUri` URIs (scheme `vscode-webview-resource:` / `vscode-resource:`), the webview's `renderMarkdown` calls `sanitizeUrl(url)` (`sharedUtils.js` line 224) before emitting `src`. `sanitizeUrl` (lines 16-28) returns `'#'` for **any** URL whose scheme is not `http/https/mailto/tel`. So a `vscode-webview-resource://...` URI is collapsed to `src="#"` — a broken image. **This must be fixed or no rewritten image will ever render.**

After pushing to the remote, the provider (ClickUp/Linear) hosts the image on its CDN and the task description comes back with `https://...` URLs. The `https:` scheme is allowed by CSP *and* passes `sanitizeUrl`, so the images render — but only via the API-fetched description (`clickupTaskDetailsLoaded` / `linearTaskDetailsLoaded`), not the local file.

The workspace folders are already registered as `localResourceRoots` (`PlanningPanelProvider.ts` line 7063), so `asWebviewUri` for files inside the workspace will produce URIs the CSP permits (`vscode-resource:` / `vscode-webview-resource:`). **However, a configured global `ticketSaveLocation` is NOT currently included in `localResourceRoots`** — `localResourceRoots` (lines 7058-7065) is built from extension dirs + workspace folders + `service.getFolderPaths()`, and `getFolderPaths()` (`LocalFolderService.ts` line 210) returns only `cfg.localFolderPaths`, not `ticketSaveLocation`. So tickets saved to a global location reference images whose `asWebviewUri` URIs are CSP-blocked unless `ticketSaveLocation` is explicitly registered (or the `file:` CSP fallback is used).

## Metadata
- **Tags:** frontend, ui, bugfix
- **Complexity:** 5/10

## User Review Required
Yes — confirm whether to (a) register `ticketSaveLocation` as a `localResourceRoot` (preferred, scoped), (b) add `file:` to the CSP `img-src` as a blanket fallback (simpler, broader exposure), or (c) both. Also confirm the ~300ms image flicker after an inline edit-save is acceptable (self-heals via the file watcher).

## Complexity Audit

### Routine
- Adding `file:` to the `planning.html` CSP `img-src` (one-token edit, mirrors `design.html`).
- Extending `sanitizeUrl`'s scheme allowlist to include `vscode-webview-resource:`, `vscode-resource:`, `vscode-webview:` (one-line condition change).
- Adding `ticketSaveLocation` (clickup + linear) to the `localResourceRoots` array.
- Routing the `ticketFileChanged` file-watcher content through the same rewrite helper.

### Complex / Risky
- The `_rewriteLocalImagePaths` helper must correctly resolve relative paths against the ticket file's directory, handle `file:///` absolute URIs, leave `http(s):`/`data:`/already-webview URIs untouched, and skip missing files gracefully — all without writing back to disk (display-only).
- The `rawContent` vs `content` split: the edit textarea must show original local paths (so push sends real paths and the file is never mutated), while the preview uses rewritten webview URIs. Getting this backwards corrupts the push flow.
- The inline save path (`btn-save-ticket-edit`, `planning.js` line 7745) recomputes `rendered = renderMarkdown(markdownBody)` in the webview from the textarea's raw value — producing a transient un-rewritten preview until the file watcher re-rewrite arrives (~300ms). Cosmetic, self-healing, but a known flicker.

## Edge-Case & Dependency Audit
- **Relative vs absolute paths:** `![](assets/img.png)` must resolve against the ticket file's directory; `![](/abs/path/img.png)` and `![](file:///abs/path/img.png)` must be handled as absolute.
- **Already-https images:** Must be left untouched (don't double-rewrite remote URLs). `sanitizeUrl` already passes these.
- **`data:` URIs:** Must be left untouched. `sanitizeUrl` returns these verbatim (no scheme match → falls through to `return trimmed`).
- **Already-rewritten webview URIs:** If content is re-read, a `vscode-webview-resource:` URL must not be re-resolved. The helper's scheme guard handles this.
- **Images outside resource roots:** If a ticket file references an image outside the workspace and outside `ticketSaveLocation`, `asWebviewUri` produces a URI but CSP (`vscode-resource:`) blocks it unless the root is registered. Mitigation: register `ticketSaveLocation` AND add `file:` to CSP as a defense-in-depth fallback for arbitrary disk paths.
- **`ticketFileChanged` handler** (`planning.js` ~line 4576) also calls `renderMarkdown` on local content — the same rewriting must apply there. The backend `ticketFileChanged` message (line 8604) must route content through `_rewriteLocalImagePaths` with the ticket's directory before posting.
- **Push flow:** When `pushTicketEdits` sends the description to the remote, the **original** local markdown (with local paths) must be sent, not the rewritten-for-display version. Satisfied by sending `rawContent` for `descriptionMarkdown` (edit mode) and using `content` only for the preview render. The webview's save handler (`planning.js` line 7757) posts `saveLocalTicketFile` with the textarea's raw markdown — which is `descriptionMarkdown` (original paths) — so the file is never mutated. Confirmed display-only.
- **Inline save flicker:** `btn-save-ticket-edit` (line 7745) recomputes `rendered` in-webview from raw markdown → preview briefly loses images until `ticketFileChanged` re-rewrite arrives. Self-healing; documented as known.
- **Regex limitations:** `!\[([^\]]*)\]\(([^)]+)\)` breaks on paths containing `)` (legal on macOS), reference-style images `![alt][ref]`, and embedded `<img>` HTML tags. Known limitation; acceptable for v1.
- **ClickUp `markdownDescription` vs `description`:** The API-fetched description uses remote URLs and is rendered via `markdown.api.render` (backend) — unaffected by this fix.
- **`sanitizeUrl` link branch:** The same `sanitizeUrl` is used for `<a href>` (line 228). Extending the scheme allowlist also permits webview-scheme links — benign (links to local files), but note it.

## Dependencies
- None. This is a self-contained fix to existing code.

## Adversarial Synthesis
**Risk Summary:** Key risks: (1) `sanitizeUrl` collapses `vscode-webview-resource:` URIs to `#` — without fixing it the primary mechanism is DOA; (2) `ticketSaveLocation` is absent from `localResourceRoots`, breaking the global-save-location case; (3) the inline save path recomputes the preview from un-rewritten markdown, causing a transient image flicker. Mitigations: extend `sanitizeUrl`'s allowlist (mandatory), register `ticketSaveLocation` in `localResourceRoots` (mandatory for global locations), and accept the self-healing save flicker as a documented known cosmetic issue.

## Proposed Changes

### `src/webview/sharedUtils.js` — `sanitizeUrl` (line 16-28)  **[MANDATORY — without this, nothing renders]**
Extend the scheme allowlist so `vscode-webview-resource:`, `vscode-resource:`, and `vscode-webview:` URIs (produced by `asWebviewUri`) pass through instead of being collapsed to `#`.

**Before:**
```js
function sanitizeUrl(rawUrl) {
    const trimmed = String(rawUrl).trim();
    if (/^(#|\/|\.{1,2}\/)/.test(trimmed)) { return trimmed; }
    const schemeMatch = trimmed.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):/);
    if (schemeMatch) {
        const scheme = schemeMatch[1].toLowerCase();
        if (scheme === 'http' || scheme === 'https' || scheme === 'mailto' || scheme === 'tel') {
            return trimmed;
        }
        return '#';
    }
    return trimmed;
}
```
**After:**
```js
function sanitizeUrl(rawUrl) {
    const trimmed = String(rawUrl).trim();
    if (/^(#|\/|\.{1,2}\/)/.test(trimmed)) { return trimmed; }
    const schemeMatch = trimmed.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):/);
    if (schemeMatch) {
        const scheme = schemeMatch[1].toLowerCase();
        if (scheme === 'http' || scheme === 'https' || scheme === 'mailto' || scheme === 'tel'
            || scheme === 'vscode-webview-resource' || scheme === 'vscode-resource' || scheme === 'vscode-webview') {
            return trimmed;
        }
        return '#';
    }
    return trimmed;
}
```

### `src/services/PlanningPanelProvider.ts` — `readLocalTicketFile` handler (~line 5453)
After reading the file content, rewrite local image references to `asWebviewUri` URIs before posting to the webview. Send **both** `content` (rewritten, for preview) and `rawContent` (original, for edit mode / push integrity).

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
        // Rewrite local image paths to webview-accessible URIs for display only.
        // rawContent preserves original local paths for edit mode + push flow.
        const displayContent = this._rewriteLocalImagePaths(content, path.dirname(filePath));
        this._panel?.webview.postMessage({ type: 'localTicketFileRead', provider, id, success: true, title, content: displayContent, rawContent: content });
    } catch {
        this._panel?.webview.postMessage({ type: 'localTicketFileRead', provider, id, success: false });
    }
    break;
}
```

### `src/services/PlanningPanelProvider.ts` — new helper `_rewriteLocalImagePaths`
Add a private method that scans markdown for `![alt](url)` and rewrites local paths (relative or `file://`) to `asWebviewUri` URIs, leaving `http(s):`, `data:`, and already-webview URIs untouched.

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

### `src/services/PlanningPanelProvider.ts` — `ticketFileChanged` file-watcher handler (~line 8604)
Apply the same rewriting to the `ticketFileChanged` content so live file-watch updates also show images. Route the content through `_rewriteLocalImagePaths` with the ticket's directory before posting.

**Before (line 8598-8604):**
```ts
const raw = nfs.readFileSync(uri.fsPath, 'utf8');
const content = raw.replace(/^---\n[\s\S]*?\n---\n?/, '').trim();
const h1 = content.match(/^#\s+(.+)$/m);
const title = h1 ? h1[1].trim() : id;
this._panel?.webview.postMessage({ type: 'ticketFileChanged', provider, id, title, content });
```
**After:**
```ts
const raw = nfs.readFileSync(uri.fsPath, 'utf8');
const content = raw.replace(/^---\n[\s\S]*?\n---\n?/, '').trim();
const h1 = content.match(/^#\s+(.+)$/m);
const title = h1 ? h1[1].trim() : id;
const displayContent = this._rewriteLocalImagePaths(content, path.dirname(uri.fsPath));
this._panel?.webview.postMessage({ type: 'ticketFileChanged', provider, id, title, content: displayContent });
```
> Note: `ticketFileChanged` does not need `rawContent` — the webview handler (line 4581-4593) sets `descriptionMarkdown` from `msg.content`. Since file-watcher events fire from *external* edits (not inline save), using the rewritten content for both preview and `descriptionMarkdown` is acceptable; the next inline edit will read the file fresh. If strict original-path preservation is desired in `descriptionMarkdown` after external edits, add `rawContent` here too and update the webview handler symmetrically.

### `src/services/PlanningPanelProvider.ts` — `localResourceRoots` (~line 7048-7065)  **[MANDATORY for global ticketSaveLocation]**
Add the configured `ticketSaveLocation` for both providers to `localResourceRoots` so `asWebviewUri` URIs for tickets saved outside the workspace are CSP-permitted.

**Before (line 7048-7065):**
```ts
const folderUris: vscode.Uri[] = [];
for (const r of allRoots) {
    try {
        const service = this._getLocalFolderService(r);
        for (const p of service.getFolderPaths()) {
            folderUris.push(vscode.Uri.file(p));
        }
    } catch (err) {}
}

const localResourceRoots = [
    vscode.Uri.joinPath(this._extensionUri, 'dist'),
    vscode.Uri.joinPath(this._extensionUri, 'webview'),
    vscode.Uri.joinPath(this._extensionUri, 'designs'),
    vscode.Uri.joinPath(this._extensionUri, 'node_modules'),
    ...(vscode.workspace.workspaceFolders || []).map(folder => folder.uri),
    ...folderUris
];
```
**After:**
```ts
const folderUris: vscode.Uri[] = [];
for (const r of allRoots) {
    try {
        const service = this._getLocalFolderService(r);
        for (const p of service.getFolderPaths()) {
            folderUris.push(vscode.Uri.file(p));
        }
    } catch (err) {}
}
// Register global ticket save locations so asWebviewUri URIs for ticket images
// are CSP-permitted even when tickets live outside the workspace.
const clickupCfg = GlobalIntegrationConfigService.loadConfigSync('clickup');
const linearCfg = GlobalIntegrationConfigService.loadConfigSync('linear');
if (clickupCfg?.ticketSaveLocation) { folderUris.push(vscode.Uri.file(clickupCfg.ticketSaveLocation)); }
if (linearCfg?.ticketSaveLocation) { folderUris.push(vscode.Uri.file(linearCfg.ticketSaveLocation)); }

const localResourceRoots = [
    vscode.Uri.joinPath(this._extensionUri, 'dist'),
    vscode.Uri.joinPath(this._extensionUri, 'webview'),
    vscode.Uri.joinPath(this._extensionUri, 'designs'),
    vscode.Uri.joinPath(this._extensionUri, 'node_modules'),
    ...(vscode.workspace.workspaceFolders || []).map(folder => folder.uri),
    ...folderUris
];
```

### `src/webview/planning.html` — CSP fallback (line 6)
Add `file:` to `img-src` as a defense-in-depth fallback for images referenced outside any registered root (e.g. an arbitrary `file:///Users/.../screenshot.png`). This mirrors `design.html`. **Security note:** this permits any `file://` image to load, including from outside intended roots — acceptable for a local dev tool, but it is a relaxation, not a freebie.

**Before:**
```
img-src {{WEBVIEW_CSP_SOURCE}} vscode-webview: vscode-webview-resource: vscode-resource: https: data:;
```
**After:**
```
img-src {{WEBVIEW_CSP_SOURCE}} vscode-webview: vscode-webview-resource: vscode-resource: https: data: file:;
```

> The `asWebviewUri` rewriting + `sanitizeUrl` fix + `ticketSaveLocation` root registration are the primary mechanism. The `file:` CSP addition is a fallback for out-of-root images.

### `src/webview/planning.js` — `localTicketFileRead` handler (~line 4534)
Use `rawContent` (original paths) for `descriptionMarkdown` / edit mode, and `content` (rewritten) for `renderedDescriptionHtml` / preview.

**Before (line 4542-4543):**
```js
const localBodyMarkdown = (msg.content || '').replace(/^#[^\n]*\n?/, '').trim();
const rendered = renderMarkdown(localBodyMarkdown);
```
**After:**
```js
// rawContent = original local paths (for edit textarea + push flow);
// content = rewritten webview URIs (for preview render).
const editMarkdown = (msg.rawContent || msg.content || '').replace(/^#[^\n]*\n?/, '').trim();
const previewMarkdown = (msg.content || '').replace(/^#[^\n]*\n?/, '').trim();
const rendered = renderMarkdown(previewMarkdown);
```
Then set `descriptionMarkdown: editMarkdown` (both ClickUp branch line 4554 and Linear branch line 4567) and `renderedDescriptionHtml: rendered`. The `renderTicketsTab()` call remains.

### Known limitation: inline save flicker
`btn-save-ticket-edit` (`planning.js` line 7745) computes `rendered = renderMarkdown(markdownBody)` in the webview from the textarea's raw value (original paths). Because the webview cannot call `asWebviewUri`, this locally-recomputed preview will lack images until the `ticketFileChanged` file-watcher event (~300ms debounce) re-rewrites via the backend. This is self-healing and cosmetic. No fix planned for v1; documented here for awareness.

## Verification Plan
> Per session directives: NO compilation, NO automated tests. Verification is manual via an installed VSIX.

### Automated Tests
- None run in this session (skipped per directive). The user will run the test suite separately.

### Manual Verification
1. Create a ClickUp/Linear ticket whose local markdown file references a local image via a relative path (`![](assets/screenshot.png)`). Place the image next to the ticket file.
2. Open the Tickets tab, select the ticket (before pushing) — confirm the image now renders in the preview.
3. Click **Edit** — confirm the textarea shows the **original** relative path (`assets/screenshot.png`), not a `vscode-webview-resource://` URI.
4. Click **Save** (without pushing) — confirm the local file still contains the original relative path (display-only rewriting, no file mutation). Note the brief image flicker before the file watcher re-rewrite.
5. Push the ticket to the remote — confirm the push sends the original local-path markdown and that after the API refetch the remote-hosted `https://` images render.
6. Test with an absolute `file:///` image path — confirm it renders.
7. Test with an `https://` image — confirm it still renders (not double-rewritten).
8. Test with a `data:` URI image — confirm it still renders.
9. Test with a missing image file — confirm no crash and the broken-img placeholder shows.
10. Toggle claudify/cyber themes — confirm no visual regression.
11. Edit the ticket file externally (file watcher) — confirm the `ticketFileChanged` update also shows the image.
12. Configure a global `ticketSaveLocation` outside the workspace, save a ticket there with a local image — confirm the image renders (validates the `localResourceRoots` registration).

## Recommendation
Complexity 5/10 → **Send to Coder**.

## Review Findings

Implementation matched the plan across all six change sites (sanitizeUrl allowlist, `_rewriteLocalImagePaths` helper, `readLocalTicketFile` rawContent/content split, `ticketFileChanged` rewriting, `localResourceRoots` ticketSaveLocation registration, CSP `file:` addition, webview `localTicketFileRead` handler). One CRITICAL regression found and fixed: the `ticketFileChanged` backend sent only rewritten `content` (webview URIs) with no `rawContent`, so the webview handler stored rewritten URIs into `descriptionMarkdown`; the next Edit→Save cycle would write those URIs to disk, permanently corrupting the local file (the plan's note at line 192 explicitly flagged this as optional, but its mitigation — "the next inline edit will read the file fresh" — is incorrect because `enterTicketsEditMode` reads from the in-memory cache, not disk). Fix applied: backend now sends `rawContent: content` (PlanningPanelProvider.ts:8663) and the webview handler uses `editBodyMarkdown` (from `rawContent`) for `descriptionMarkdown` at all three cache sites (planning.js:4630,4636,4657,4664) while keeping `changedBodyMarkdown` (from `content`) for the preview render. Files changed: `src/services/PlanningPanelProvider.ts`, `src/webview/planning.js`. Validation: no compilation/tests per session directives; grep-verified no leftover `descriptionMarkdown: changedBodyMarkdown` references and no other `ticketFileChanged` listeners. Remaining risks: the documented inline-save flicker (~300ms, self-healing, no fix planned for v1) and the regex `([^)]+)` limitation on paths containing `)` (accepted v1).
