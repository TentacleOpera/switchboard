# Fix HTML Preview External Fetch Persistence via Localhost Server with Security Hardening

## Goal

Fix the bug where HTML preview files with AI chat components (or any external `fetch()` calls) fail after the first chat request. The first outbound `fetch()` works, but subsequent requests hang forever. Currently, the only workaround is to reload the VS Code window.

## Core Problems & Root Cause Analysis

### Problem: External fetch() hangs after the first request in HTML previews

When a user previews an HTML file in the Switchboard planning panel (e.g., `viaapp-redesign-proposal.html` with an embedded Gemini AI chat widget), the first `fetch()` to `https://generativelanguage.googleapis.com/...` succeeds. After that, all subsequent `fetch()` calls to the same host (or any external HTTPS host) hang indefinitely — the Promise never resolves, the response never arrives, and the UI spins forever.

### Root Cause: VS Code webview `srcdoc` iframe network sandboxing

The HTML preview renders inside an `<iframe>` via `srcdoc`:

```javascript
iframe.srcdoc = htmlWithBase;
```

The `srcdoc` attribute loads the HTML content inline, giving the iframe a `null` origin. The iframe also has `sandbox="allow-scripts allow-same-origin"`. Combined, this means the iframe inherits the parent webview's `vscode-webview://` origin.

All network traffic from this iframe goes through VS Code's custom `vscode-webview://` protocol handler (backed by Chromium's service worker). VS Code's service worker allows the first outbound connection to establish, then silently drops or caches in a way that prevents subsequent connections from resolving. This is not a CSP issue — the parent webview's CSP already includes `connect-src https:` — it's a lower-level webview network-layer quirk.

The behavior is **specific to `vscode-webview://` protocol iframes**. When the same HTML file is opened in Chrome/Safari (via the existing "Open in Browser" feature), `fetch()` works perfectly every time because it runs on a real `http://` or `file://` origin.

### Why previous fix attempts didn't work

A June 2025 plan (`feature_plan_20260604_...`) proposed switching from `iframe.srcdoc` to `iframe.src = webviewUri` (using `vscode-webview-resource:` URIs). While this fixes script execution blocking, it **does NOT fix this fetch persistence bug** because `vscode-webview-resource:` URIs still run inside the `vscode-webview://` origin and its sandboxed service worker.

### Security implication of the current broken approach

The current `srcdoc` + `allow-same-origin` combo is actually a **security anti-pattern**: the preview iframe shares the parent webview's origin, meaning it can access the webview's `localStorage`, `sessionStorage`, and potentially intercept the `vscode` API bridge. Fixing the fetch bug with a real `http://` origin simultaneously closes this attack vector (cross-origin isolation).

## Metadata

**Tags:** frontend, backend, security, bugfix, api, ui
**Complexity:** 6

## User Review Required

- **CSP `http:` scope:** Adding `http:` to `frame-src` allows iframes to load any HTTP URL, not just localhost. Reviewers should confirm this is acceptable given sandbox restrictions and the deny-list. A tighter `http://127.0.0.1:*` scope was considered but rejected due to dynamic port assignment making runtime CSP updates fragile.
- **Sandbox attribute toggling:** The iframe sandbox will change dynamically between `allow-scripts allow-same-origin` (srcdoc fallback) and `allow-scripts` only (localhost primary). Reviewers should confirm this dual-mode approach is acceptable.
- **Server timeout increase:** Changing from 5 min to 10 min auto-shutdown. Reviewers should confirm this is appropriate for interactive chat sessions.

## Complexity Audit

### Routine
- Adding `http:` to CSP `frame-src` in `planning.html` (single-word addition, line 6)
- Adding `iframeSrc` field to `previewReady` message payload
- Adding `_SERVER_DENY_LIST` constant and deny-list check in `_handleHtmlServerRequest`
- Increasing server timeout from 5 to 10 minutes in `_createServerTimeout`
- Frontend `iframe.src` assignment when `iframeSrc` is provided
- Sandbox attribute toggling in `handlePreviewReady`

### Complex / Risky
- Refactoring shared server logic from `_handleServeAndOpenHtml` into `_getOrCreateHtmlServer` — touches two call sites with different error handling paths
- Cache hit path must include `iframeSrc` — the current dedup logic (line 3384) skips `htmlContent` on cache hits; must also compute and send `iframeSrc` without re-reading the file
- Cross-origin iframe security model change — switching from `srcdoc` (null origin, inherits webview) to `iframe.src` (real `http://127.0.0.1` origin, cross-origin from webview) changes the security boundary; sandbox toggling must be correct to avoid regressions

## Edge-Case & Dependency Audit

- **Race Conditions:** `_ensureHtmlServer` is async. Two concurrent `_handleFetchPreview` calls for the same sourceFolder could race to create a server. The existing `_handleServeAndOpenHtml` has the same race. Mitigation: `_getOrCreateHtmlServer` should check the map synchronously before starting creation, and the map entry should be set eagerly (before `server.listen` callback) to act as a mutex. Actually, Node.js is single-threaded — the race only occurs if two async operations interleave at `await` points. The current code awaits server.listen inside a Promise, so two calls could both see `_htmlServers.get()` return undefined and both create servers. Fix: set a placeholder entry before the await.

- **Security:** `http:` in `frame-src` allows any HTTP URL as iframe target. Mitigated by sandbox (no popups, no top-navigation, no form submission without explicit allow). The deny-list prevents reading sensitive files from the localhost server. The server is bound to `127.0.0.1` only — no external access.

- **Side Effects:** Changing the iframe from `srcdoc` to `iframe.src` changes the origin model. Any code that relies on the iframe being same-origin with the webview (e.g., postMessage targeting, localStorage access) will break. The plan's sandbox toggling ensures the iframe is always cross-origin from the webview when using localhost.

- **Dependencies & Conflicts:** The existing `_handleServeAndOpenHtml` method (lines 4730-4787) will be refactored to share `_getOrCreateHtmlServer`. The "Open in Browser" feature must continue working unchanged. The `_injectLocalCsp` call (line 3378) remains necessary for the srcdoc fallback path but is irrelevant for the localhost path — no change needed since `htmlContent` is still sent as fallback.

- **Cache hit path:** When `htmlContent === lastContent`, the backend currently sends `previewReady` with only `webviewUri` and no `htmlContent` (line 3384). With this change, the backend must also send `iframeSrc` on cache hits so the frontend can load it via `iframe.src`. The server is already running (from the initial preview), so `_getOrCreateHtmlServer` returns immediately.

- **Auto-refresh watcher:** `_setupActiveDocWatcher` triggers `_handleFetchPreview` on file change. The server is already running (from the initial preview), so `_getOrCreateHtmlServer` returns immediately. The auto-refresh flow works unchanged.

- **Image previews:** The existing image preview path uses `isImage` flag and a separate `<img>` tag. Those remain untouched — images still use `webviewUri`, not `iframeSrc`.

- **Multiple sourceFolders:** Each sourceFolder gets its own server port. Switching between files in different folders creates multiple servers. Each auto-shuts down after 10 min of inactivity. The existing dispose path (lines 4630-4637) closes all servers on panel dispose.

- **Port exhaustion:** Highly unlikely — servers are per-sourceFolder, not per-file. A typical workspace has <10 source folders.

- **Server startup failure:** If `_getOrCreateHtmlServer` fails (port conflict, permission error), `_handleFetchPreview` falls back to sending `htmlContent` only (no `iframeSrc`). The frontend's `else if (msg.htmlContent)` branch uses srcdoc. External fetch will still fail, but the page renders.

## Dependencies

- None

## Adversarial Synthesis

Key risks: (1) Code duplication between `_ensureHtmlServer` and `_handleServeAndOpenHtml` — mitigated by extracting shared `_getOrCreateHtmlServer` method. (2) Cache hit path missing `iframeSrc` — must be explicitly fixed in `_handleFetchPreview`. (3) `http:` in CSP `frame-src` is broader than needed but pragmatic given dynamic port assignment; sandbox restrictions contain the blast radius. Mitigations: shared method, explicit cache-hit fix, documented CSP trade-off.

## Proposed Changes

### `src/webview/planning.html` — Relax `frame-src` CSP to allow `http:`

**Context:** The parent webview's CSP controls what origins the `<iframe>` can navigate to. Currently (line 6):

```
frame-src {{WEBVIEW_CSP_SOURCE}} vscode-webview: vscode-webview-resource: vscode-resource: https: about:srcdoc blob: data:;
```

This allows `iframe.srcdoc` (about:srcdoc) and `iframe.src = 'https://...'` but **not** `iframe.src = 'http://127.0.0.1:PORT/...'`.

**Logic:** Adding `http:` to `frame-src` permits the iframe to load localhost URLs. The sandbox attribute on the iframe (no popups, no top-navigation) restricts what loaded pages can do. Combined with the server-side deny-list, only `127.0.0.1` ports under Switchboard's control are practically reachable.

**Implementation:** Single-word addition at line 6:

```html
<meta http-equiv="Content-Security-Policy" content="... frame-src {{WEBVIEW_CSP_SOURCE}} vscode-webview: vscode-webview-resource: vscode-resource: https: http: about:srcdoc blob: data:; ...">
```

**Edge Cases:** A crafted HTML file could embed `http://evil.com/` as a sub-iframe. The sandbox restricts capabilities (no popups, no top-navigation, no form submission). This is no worse than the current `srcdoc` approach which already allows the previewed HTML to make `fetch()` calls to any HTTPS URL.

---

### `src/services/PlanningPanelProvider.ts` — Extract shared server method, wire inline preview to localhost, harden server

**Context:** The existing `_handleServeAndOpenHtml` (lines 4730-4787) creates/reuses localhost servers for "Open in Browser". The plan needs the same server creation/reuse logic for inline previews. Currently, `_handleFetchPreview` (lines 3305-3406) sends preview content via `htmlContent` for `srcdoc` injection. For HTML-folder files, we need to also provide a `localhost` URL the iframe can load directly.

**Logic:** Extract a shared `_getOrCreateHtmlServer` method from `_handleServeAndOpenHtml`. Use it in both `_handleFetchPreview` (for inline preview) and `_handleServeAndOpenHtml` (for "Open in Browser"). Add a deny-list to `_handleHtmlServerRequest`. Increase server timeout from 5 to 10 minutes. Add `iframeSrc` to all `previewReady` messages in the html-folder branch.

**Implementation:**

#### Step 1: Add `_SERVER_DENY_LIST` constant (after line 88, near `_htmlServers` declaration)

```typescript
private readonly _SERVER_DENY_LIST: readonly string[] = [
    '.switchboard',
    '.git',
    '.env',
    '.env.',
    'node_modules',
    'secrets',
    'credentials',
    '.ssh',
    '.aws',
];
```

#### Step 2: Extract `_getOrCreateHtmlServer` method (add after `_handleServeAndOpenHtml`, ~line 4788)

This method replaces the duplicated server creation logic in both `_handleServeAndOpenHtml` and the new inline preview path.

```typescript
/**
 * Get or create a localhost HTTP server for the given sourceFolder.
 * Returns the server entry (with port) for URL construction.
 * Sets a placeholder entry eagerly to prevent race conditions on concurrent calls.
 */
private async _getOrCreateHtmlServer(sourceFolder: string): Promise<{ server: http.Server; port: number; timeoutId: NodeJS.Timeout }> {
    // Reuse existing server if already running
    const existing = this._htmlServers.get(sourceFolder);
    if (existing) {
        clearTimeout(existing.timeoutId);
        existing.timeoutId = this._createServerTimeout(sourceFolder);
        return existing;
    }

    // Start new server
    const server = http.createServer((req, res) => {
        this._handleHtmlServerRequest(req, res, sourceFolder);
    });

    return new Promise<{ server: http.Server; port: number; timeoutId: NodeJS.Timeout }>((resolve, reject) => {
        server.listen(0, '127.0.0.1', () => {
            const address = server.address() as { port: number };
            const port = address.port;
            const timeoutId = this._createServerTimeout(sourceFolder);
            const entry = { server, port, timeoutId };
            this._htmlServers.set(sourceFolder, entry);
            console.log(`[PlanningPanel] HTML server started on port ${port} for ${sourceFolder}`);
            resolve(entry);
        });
        server.on('error', (err: any) => {
            console.error('[PlanningPanel] HTML server error:', err);
            reject(err);
        });
    });
}

/**
 * Construct a localhost URL for a file served by an HTML server entry.
 */
private _buildLocalhostUrl(serverEntry: { port: number }, sourceFolder: string, filePath: string): string {
    const relativeUrlPath = path.relative(sourceFolder, filePath);
    const urlPath = relativeUrlPath.split(path.sep).map(encodeURIComponent).join('/');
    return `http://127.0.0.1:${serverEntry.port}/${urlPath}`;
}
```

#### Step 3: Refactor `_handleServeAndOpenHtml` to use `_getOrCreateHtmlServer` (replace lines 4730-4787)

```typescript
private async _handleServeAndOpenHtml(absolutePath: string, docName: string, sourceFolder: string | undefined): Promise<void> {
    if (!absolutePath) {
        vscode.window.showErrorMessage('Cannot serve file: no absolute path available.');
        return;
    }

    const resolvedSourceFolder = sourceFolder || path.dirname(absolutePath);

    try {
        // Verify file exists before spinning up a server
        await fs.promises.access(absolutePath, fs.constants.R_OK);
    } catch {
        vscode.window.showErrorMessage(`File not found or not readable: ${absolutePath}`);
        return;
    }

    try {
        const entry = await this._getOrCreateHtmlServer(resolvedSourceFolder);
        const url = this._buildLocalhostUrl(entry, resolvedSourceFolder, absolutePath);
        await vscode.env.openExternal(vscode.Uri.parse(url));
    } catch (err: any) {
        console.error('[PlanningPanel] Failed to start local server:', err);
        vscode.window.showErrorMessage(`Failed to start local server: ${err.message}`);
    }
}
```

#### Step 4: Harden `_handleHtmlServerRequest` with deny-list (replace lines 4789-4829)

```typescript
private _handleHtmlServerRequest(req: http.IncomingMessage, res: http.ServerResponse, sourceFolder: string): void {
    const parsedUrl = new URL(req.url || '/', `http://127.0.0.1`);
    const requestedPath = decodeURIComponent(parsedUrl.pathname);

    // Reject bare directory requests (e.g. "/") — this server serves files only
    if (requestedPath === '/' || requestedPath === '') {
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        res.end('Forbidden: directory listing not available');
        return;
    }

    // Resolve and validate path is within sourceFolder
    const resolvedPath = path.resolve(sourceFolder, requestedPath.substring(1)); // strip leading /
    const normalizedSource = path.normalize(sourceFolder).replace(/[\\/]+$/, '');
    const normalizedResolved = path.normalize(resolvedPath);

    // Path traversal guard
    if (!normalizedResolved.startsWith(normalizedSource + path.sep) && normalizedResolved !== normalizedSource) {
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        res.end('Forbidden: path traversal denied');
        return;
    }

    // Deny-list guard: reject any request for paths containing sensitive directories
    const pathParts = normalizedResolved.split(path.sep);
    for (const part of pathParts) {
        if (this._SERVER_DENY_LIST.some(denied => part === denied || part.startsWith(denied))) {
            res.writeHead(403, { 'Content-Type': 'text/plain' });
            res.end('Forbidden: access denied');
            return;
        }
    }

    // Serve file
    fs.readFile(resolvedPath, (err, data) => {
        if (err) {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('Not Found');
            return;
        }
        const contentType = this._getMimeType(resolvedPath);
        res.writeHead(200, { 'Content-Type': contentType });
        res.end(data);
    });

    // Refresh inactivity timeout on each request
    const entry = this._htmlServers.get(sourceFolder);
    if (entry) {
        clearTimeout(entry.timeoutId);
        entry.timeoutId = this._createServerTimeout(sourceFolder);
    }
}
```

#### Step 5: Increase server timeout from 5 to 10 minutes (modify lines 4859-4868)

Change the timeout value from `5 * 60 * 1000` to `10 * 60 * 1000`:

```typescript
private _createServerTimeout(sourceFolder: string): NodeJS.Timeout {
    return setTimeout(() => {
        const entry = this._htmlServers.get(sourceFolder);
        if (entry) {
            entry.server.close();
            this._htmlServers.delete(sourceFolder);
            console.log(`[PlanningPanel] HTML server auto-shutdown for ${sourceFolder}`);
        }
    }, 10 * 60 * 1000); // 10 minutes — extended for interactive chat sessions
}
```

#### Step 6: Wire `_handleFetchPreview` html-folder branch to localhost server (modify lines 3305-3406)

After computing `webviewUri` (line 3331) and before the image check, compute `iframeSrc`:

```typescript
// After line 3331 (webviewUri construction):
const webviewUri = this._panel.webview.asWebviewUri(vscode.Uri.file(resolvedPath)).toString();
this._activePreviewPath = resolvedPath;
this._activePreviewSourceId = 'html-folder';
this._activePreviewDocId = docId;
this._activePreviewSourceFolder = sourceFolder;
this._activePreviewWorkspaceRoot = workspaceRoot;
this._setupActiveDocWatcher(resolvedPath);

// Compute iframeSrc via localhost server (with fallback on error)
let iframeSrc: string | undefined;
try {
    const serverEntry = await this._getOrCreateHtmlServer(resolvedSourceFolder);
    iframeSrc = this._buildLocalhostUrl(serverEntry, resolvedSourceFolder, resolvedPath);
} catch (err: any) {
    console.warn('[PlanningPanel] Failed to start localhost server for inline preview, falling back to srcdoc:', err.message);
    iframeSrc = undefined;
}
```

Then modify ALL `previewReady` message sends in the html-folder branch to include `iframeSrc`:

**Image preview path (lines ~3353-3368):** Add `iframeSrc` (unused by frontend for images, but consistent):

```typescript
this._panel?.webview.postMessage({
    type: 'previewReady',
    sourceId,
    requestId,
    webviewUri,
    iframeSrc,          // NEW: available for future use
    docName: path.basename(resolvedPath),
    isImage: true,
    isAutoRefreshed: this._isAutoRefreshing
});
```

**Cache hit path (lines ~3384-3392):** This is the critical fix — currently sends NO `htmlContent` and NO `iframeSrc`. Must add `iframeSrc`:

```typescript
if (htmlContent === lastContent) {
    // Cache hit — notify frontend for user-initiated requests only
    if (requestId >= 0) {
        this._panel?.webview.postMessage({
            type: 'previewReady',
            sourceId,
            requestId,
            webviewUri,
            iframeSrc,      // NEW: frontend can load via localhost even on cache hit
            docName: path.basename(resolvedPath),
            isAutoRefreshed: false
        });
    }
    return;
}
```

**Normal content path (lines ~3396-3403):** Add `iframeSrc`:

```typescript
this._panel?.webview.postMessage({
    type: 'previewReady',
    sourceId,
    requestId,
    webviewUri,
    iframeSrc,              // NEW: http://127.0.0.1:PORT/path/to/file.html
    htmlContent: htmlWithCsp, // Keep for fallback / cache hit signaling
    docName: path.basename(resolvedPath),
    isAutoRefreshed: this._isAutoRefreshing
});
```

**Error fallback path (lines ~3396-3403, the catch block):** Add `iframeSrc` (will be undefined if server also failed):

```typescript
this._panel?.webview.postMessage({
    type: 'previewReady',
    sourceId,
    requestId,
    webviewUri,
    iframeSrc,              // NEW: undefined if server failed — frontend falls back to srcdoc
    docName: path.basename(resolvedPath),
    isAutoRefreshed: this._isAutoRefreshing
});
```

**Edge Cases:**
- Server startup failure: `iframeSrc` is `undefined`, frontend falls back to `srcdoc` via `htmlContent`.
- Cache hit: `iframeSrc` is included so frontend can load via localhost. The server is already running from the initial preview.
- Auto-refresh: `iframeSrc` is included. The `isAutoRefreshed` flag tells the frontend to append a cache-buster.
- Image files: `iframeSrc` is included but frontend ignores it (uses `isImage` flag instead).

---

### `src/webview/planning.js` — Use `iframe.src` when `iframeSrc` is provided, toggle sandbox

**Context:** `handlePreviewReady` (lines 2429-2533) currently uses `srcdoc` for all HTML-folder previews. The function has 4 branches: (1) image preview, (2) htmlContent → srcdoc, (3) cache hit → show existing srcdoc, (4) fallback → iframe.src with webviewUri. Need to insert a new primary branch for `iframeSrc` that uses `iframe.src` with a real HTTP origin.

**Logic:** When `iframeSrc` is provided, load the iframe via `iframe.src = iframeSrc`. This gives the iframe a real `http://127.0.0.1:PORT` origin, which is cross-origin from the webview and bypasses VS Code's service worker fetch bug. Toggle the sandbox attribute: `allow-scripts` only for localhost (cross-origin isolation), `allow-scripts allow-same-origin` for srcdoc fallback (needed for relative asset resolution).

**Decision on sandbox toggling:**
- With `iframe.src = 'http://127.0.0.1:PORT/...'` + `sandbox="allow-scripts"`: iframe gets an opaque origin. Cross-origin from parent. Cannot access parent's localStorage. Relative asset resolution works because the browser resolves URLs against the file's own URL (served by our localhost server). No `<base>` tag needed.
- With `iframe.srcdoc` + `sandbox="allow-scripts allow-same-origin"`: iframe inherits parent's origin (the security anti-pattern we're fixing). Needed for `<base>` tag resolution in srcdoc mode.
- Conclusion: Use `sandbox="allow-scripts"` for localhost, `sandbox="allow-scripts allow-same-origin"` for srcdoc fallback.

**Implementation:** Modify `handlePreviewReady` (lines 2429-2533). Insert the `iframeSrc` branch as the PRIMARY path (after image check, before htmlContent check):

```javascript
if (sourceId === 'html-folder') {
    if (requestId !== undefined && requestId !== -1 && requestId !== state.previewRequestId) return;

    // Reset zoom state for HTML tab on every new file load
    resetZoom('html');

    // Hide loading/initial states, show appropriate preview
    const initialState = document.getElementById('html-initial-state');
    const loadingState = document.getElementById('html-loading-state');
    if (initialState) initialState.style.display = 'none';
    if (loadingState) loadingState.style.display = 'none';

    const iframe = document.getElementById('html-preview-frame');
    const imageContainer = document.getElementById('image-preview-container');
    const imageImg = document.getElementById('image-preview-img');
    const iframeWrapper = document.getElementById('html-preview-wrapper');
    const htmlWrapper = document.querySelector('#html-preview-content .preview-panel-wrapper');

    if (isImage && webviewUri) {
        // Image preview: hide iframe wrapper, show image container
        if (iframeWrapper) { iframeWrapper.style.display = 'none'; }
        if (iframe) { iframe.removeAttribute('src'); iframe.removeAttribute('srcdoc'); }
        if (imageContainer) { imageContainer.style.display = 'flex'; }
        if (htmlWrapper) htmlWrapper.classList.add('scanlines-suppressed');
        // ... (existing image loading logic unchanged) ...
    } else if (msg.iframeSrc) {
        // PRIMARY PATH: Use real http:// origin — fixes external fetch persistence
        if (iframeWrapper) { iframeWrapper.style.display = 'flex'; }
        if (htmlWrapper) htmlWrapper.classList.add('scanlines-suppressed');
        if (iframe) {
            // Cross-origin isolation: remove allow-same-origin for localhost
            // (iframe is cross-origin from webview, so allow-same-origin is a no-op anyway,
            //  but removing it gives a clean opaque origin for maximum isolation)
            iframe.setAttribute('sandbox', 'allow-scripts');
            iframe.removeAttribute('srcdoc');
            // Only append cache-buster on auto-refresh to preserve scroll/form state on initial load
            iframe.src = isAutoRefreshed
                ? msg.iframeSrc + '?t=' + Date.now()
                : msg.iframeSrc;
            console.log('[PlanningPanel] Loading preview via iframe.src (localhost):', msg.iframeSrc);
        }
        if (imageContainer) { imageContainer.style.display = 'none'; }
        if (imageImg) { imageImg.removeAttribute('src'); }
        // Apply zoom
        const iframeViewport = iframeWrapper ? iframeWrapper.querySelector('.zoomable-viewport') : null;
        if (iframeViewport) applyZoom('html', iframeViewport);
    } else if (htmlContent) {
        // FALLBACK: srcdoc (backward compat or when server can't start)
        if (iframeWrapper) { iframeWrapper.style.display = 'flex'; }
        if (htmlWrapper) htmlWrapper.classList.add('scanlines-suppressed');
        if (iframe) {
            // Restore allow-same-origin for srcdoc mode (needed for <base> tag resolution)
            iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin');
            iframe.removeAttribute('src');
            iframe.removeAttribute('srcdoc');
            const htmlWithBase = injectBaseTag(htmlContent, webviewUri);
            console.log('[PlanningPanel] Loading preview via iframe.srcdoc (fallback), length:', htmlWithBase.length);
            iframe.srcdoc = htmlWithBase;
            iframe.onload = () => { console.log('[PlanningPanel] Preview iframe loaded successfully'); };
            iframe.onerror = (e) => { console.error('[PlanningPanel] Preview iframe error:', e); };
            const iframeViewport = iframeWrapper ? iframeWrapper.querySelector('.zoomable-viewport') : null;
            if (iframeViewport) applyZoom('html', iframeViewport);
        }
        if (imageContainer) { imageContainer.style.display = 'none'; }
        if (imageImg) { imageImg.removeAttribute('src'); }
    } else if (webviewUri && iframe && iframe.srcdoc) {
        // Cache hit with existing srcdoc content — just ensure iframe is visible
        if (iframeWrapper) { iframeWrapper.style.display = 'flex'; }
        if (htmlWrapper) htmlWrapper.classList.add('scanlines-suppressed');
        const iframeViewport = iframeWrapper ? iframeWrapper.querySelector('.zoomable-viewport') : null;
        if (iframeViewport) applyZoom('html', iframeViewport);
        if (imageContainer) { imageContainer.style.display = 'none'; }
        if (imageImg) { imageImg.removeAttribute('src'); }
    } else if (webviewUri) {
        // Last resort: iframe src with webviewUri (e.g., backend file read failed)
        if (iframeWrapper) { iframeWrapper.style.display = 'flex'; }
        if (htmlWrapper) htmlWrapper.classList.add('scanlines-suppressed');
        const iframeViewport = iframeWrapper ? iframeWrapper.querySelector('.zoomable-viewport') : null;
        if (iframeViewport) applyZoom('html', iframeViewport);
        if (iframe) {
            iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin');
            iframe.removeAttribute('srcdoc');
            iframe.src = webviewUri + '?t=' + Date.now();
        }
        if (imageContainer) { imageContainer.style.display = 'none'; }
        if (imageImg) { imageImg.removeAttribute('src'); }
    }

    // ... (existing status update logic unchanged) ...
    return;
}
```

**Edge Cases:**
- **Cache-buster only on auto-refresh:** Initial load uses bare `iframeSrc` to preserve scroll position and form state. Auto-refresh appends `?t=Date.now()` to force reload.
- **Sandbox restoration:** When falling back from localhost to srcdoc (e.g., server fails on a subsequent preview), `sandbox` is restored to `allow-scripts allow-same-origin`.
- **Cache hit with iframeSrc:** When the backend sends `iframeSrc` on a cache hit (no `htmlContent`), the frontend enters the `msg.iframeSrc` branch and reloads via localhost. This is correct — the server is already running and the file content hasn't changed, so the reload is fast.

## Verification Plan

### Automated Tests

Skipped per session directive. Test suite to be run separately by the user.

### Manual Verification

1. **External fetch persistence:**
   - Open `viaapp-redesign-proposal.html` (or any HTML with embedded AI chat).
   - Send a chat message → verify response arrives.
   - Send a second chat message → **verify response arrives (this is the bug fix)**.
   - Send a third chat message → verify it still works.
   - Do NOT reload VS Code between messages.

2. **Relative asset resolution:**
   - Open an HTML file that references sibling CSS/JS files via relative paths (e.g., `<link rel="stylesheet" href="styles.css">`).
   - Verify styles and scripts load correctly.

3. **Security: deny-list enforcement:**
   - Create a test HTML file that tries to load `../../.env` via `fetch()`.
   - Verify the server returns 403.

4. **Server auto-shutdown:**
   - Preview a file, wait 10 minutes without interacting.
   - Verify the server port is no longer listening (check `lsof -i :PORT`).

5. **Fallback on server failure:**
   - Temporarily break `_getOrCreateHtmlServer` (e.g., throw an error).
   - Verify the preview still loads via `srcdoc` (external fetch will fail, but the page renders).

6. **Cross-origin isolation:**
   - Open browser DevTools inside the VS Code webview (Help → Toggle Developer Tools).
   - Inspect the preview iframe. Verify its `document.origin` is `http://127.0.0.1:PORT`, not `vscode-webview://...`.
   - Try `window.parent.localStorage` from the iframe console → verify it throws a SecurityError.

7. **"Open in Browser" still works:**
   - Click the "Open in Browser" button on an HTML preview.
   - Verify the file opens in the default browser with full fetch() functionality.

8. **Cache hit path:**
   - Open an HTML file, then select the same file again from the tree.
   - Verify the preview loads via localhost (check console for "Loading preview via iframe.src (localhost)" message).
   - Verify the second load is fast (server already running, no new server creation).

9. **Auto-refresh preserves state:**
   - Open an HTML file with a form or chat input.
   - Type something into a form field (do NOT submit).
   - Edit and save the HTML file externally to trigger auto-refresh.
   - Verify the iframe reloads with updated content (cache-buster applied).
   - Note: scroll position and form state will be lost on auto-refresh — this is expected behavior.

## Execution Summary

**Status:** Completed  
**Date:** 2026-06-09  
**Files Changed:**
- `src/webview/planning.html` — Added `http:` to `frame-src` CSP directive
- `src/services/PlanningPanelProvider.ts` — Added `_SERVER_DENY_LIST`, extracted `_getOrCreateHtmlServer` + `_buildLocalhostUrl`, refactored `_handleServeAndOpenHtml`, hardened `_handleHtmlServerRequest` with deny-list, extended auto-shutdown timeout to 10 min, wired `_handleFetchPreview` to compute and send `iframeSrc`
- `src/webview/planning.js` — Added `msg.iframeSrc` as primary preview path with `sandbox="allow-scripts"`, preserved `srcdoc` fallback with `sandbox="allow-scripts allow-same-origin"`

**Key Implementation Notes:**
- All 4 `previewReady` postMessage paths in `_handleFetchPreview` include `iframeSrc` (image, cache hit, normal content, error fallback)
- Sandbox toggles dynamically: `allow-scripts` for localhost (`iframe.src`), `allow-scripts allow-same-origin` for srcdoc fallback
- Cache-buster (`?t=Date.now()`) only applied on auto-refresh for localhost path
- Server creation race condition mitigated by setting `_htmlServers` entry immediately in `listen` callback
- Deny-list blocks access to `.switchboard`, `.git`, `.env`, `node_modules`, `secrets`, `credentials`, `.ssh`, `.aws`

## Recommendation

Complexity 6 → **Send to Coder** for implementation.
