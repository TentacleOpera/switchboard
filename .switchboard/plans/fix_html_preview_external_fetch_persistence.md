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

**Complexity:** 6
**Tags:** frontend, backend, security, bugfix, vscode-extension, api, ui

## Dependencies

- Existing localhost file server infrastructure (`_htmlServers`, `_handleHtmlServerRequest`, `_createServerTimeout`) in `PlanningPanelProvider.ts` — used by "Open in Browser" button. This plan reuses and hardens it.

## Proposed Changes

### 1. `src/webview/planning.html` — Relax `frame-src` CSP to allow `http:`

**Context:** The parent webview's CSP controls what origins the `<iframe>` can navigate to. Currently:

```
frame-src {{WEBVIEW_CSP_SOURCE}} vscode-webview: ... https: about:srcdoc blob: data:;
```

This allows `iframe.srcdoc` (about:srcdoc) and `iframe.src = 'https://...'` but **not** `iframe.src = 'http://127.0.0.1:PORT/...'`.

**Change:** Add `http:` to the `frame-src` directive. This is a single-word addition.

```html
<meta http-equiv="Content-Security-Policy" content="... frame-src {{WEBVIEW_CSP_SOURCE}} vscode-webview: vscode-webview-resource: vscode-resource: https: http: about:srcdoc blob: data:; ...">
```

**Security note:** `http:` is broad, but the iframe's `sandbox="allow-scripts allow-same-origin"` still restricts capabilities (no popups, no downloads, no top-navigation). Combined with the server-side deny-list (below), only `127.0.0.1` ports under Switchboard's control are reachable.

### 2. `src/services/PlanningPanelProvider.ts` — Wire inline preview to localhost server

**Context:** `_handleFetchPreview` currently sends preview content via `htmlContent` for `srcdoc` injection. For HTML-folder files, we need to also provide a `localhost` URL the iframe can load directly.

**Changes to `_handleFetchPreview` (html-folder branch):**

After computing `webviewUri`, ensure the localhost server is running for `sourceFolder`, compute the `iframeSrc` URL, and include it in the `previewReady` message:

```typescript
// After line ~3331 (webviewUri construction):
const cleanDocId = docId.includes(':') ? docId.substring(docId.indexOf(':') + 1) : docId;
const resolvedPath = path.resolve(path.join(resolvedSourceFolder, cleanDocId));

// ... (existing path validation and existence checks) ...

// Ensure localhost server is running for this sourceFolder
const iframeSrc = await this._ensureHtmlServer(sourceFolder, resolvedPath);

// ... (existing htmlContent read + CSP injection) ...

this._panel?.webview.postMessage({
    type: 'previewReady',
    sourceId, requestId,
    webviewUri,
    iframeSrc,          // NEW: http://127.0.0.1:PORT/path/to/file.html
    htmlContent,        // Keep for fallback / cache hit signaling
    docName,
    isAutoRefreshed: this._isAutoRefreshing
});
```

**New method: `_ensureHtmlServer(sourceFolder: string, filePath: string): Promise<string>`**

Reuses the existing `_htmlServers` map but adds a keep-alive mechanism for active previews.

```typescript
private async _ensureHtmlServer(sourceFolder: string, filePath: string): Promise<string> {
    // Reuse existing server if already running
    const existing = this._htmlServers.get(sourceFolder);
    if (existing) {
        clearTimeout(existing.timeoutId);
        existing.timeoutId = this._createServerTimeout(sourceFolder);
        const relativeUrlPath = path.relative(sourceFolder, filePath);
        const urlPath = relativeUrlPath.split(path.sep).map(encodeURIComponent).join('/');
        return `http://127.0.0.1:${existing.port}/${urlPath}`;
    }

    // Start new server
    const server = http.createServer((req, res) => {
        this._handleHtmlServerRequest(req, res, sourceFolder);
    });

    return new Promise((resolve, reject) => {
        server.listen(0, '127.0.0.1', () => {
            const address = server.address() as { port: number };
            const port = address.port;
            const timeoutId = this._createServerTimeout(sourceFolder);
            this._htmlServers.set(sourceFolder, { server, port, timeoutId });

            const relativeUrlPath = path.relative(sourceFolder, filePath);
            const urlPath = relativeUrlPath.split(path.sep).map(encodeURIComponent).join('/');
            resolve(`http://127.0.0.1:${port}/${urlPath}`);
        });
        server.on('error', reject);
    });
}
```

**Security hardening: `_handleHtmlServerRequest` deny-list**

The existing `_handleHtmlServerRequest` already validates path traversal. Add a deny-list for sensitive paths and tighten scope to the source folder only.

Replace the existing `_handleHtmlServerRequest` with a hardened version:

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

private _handleHtmlServerRequest(req: http.IncomingMessage, res: http.ServerResponse, sourceFolder: string): void {
    const parsedUrl = new URL(req.url || '/', `http://127.0.0.1`);
    const requestedPath = decodeURIComponent(parsedUrl.pathname);

    // Reject bare directory requests
    if (requestedPath === '/' || requestedPath === '') {
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        res.end('Forbidden: directory listing not available');
        return;
    }

    // Resolve path within sourceFolder
    const resolvedPath = path.resolve(sourceFolder, requestedPath.substring(1));
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

    // Refresh inactivity timeout
    const entry = this._htmlServers.get(sourceFolder);
    if (entry) {
        clearTimeout(entry.timeoutId);
        entry.timeoutId = this._createServerTimeout(sourceFolder);
    }
}
```

**Server lifetime adjustment**

The current 5-minute auto-shutdown (`_createServerTimeout`) is fine for "Open in Browser" but too aggressive for inline previews where users may chat for >5 minutes without triggering a file re-read. Increase to 10 minutes, or better: tie keep-alive to preview panel visibility.

Recommended change: increase timeout to **10 minutes** and add explicit shutdown when the panel is disposed or a different sourceFolder is previewed (to avoid port accumulation).

### 3. `src/webview/planning.js` — Use `iframe.src` when `iframeSrc` is provided

**Context:** `handlePreviewReady` currently uses `srcdoc` for all HTML-folder previews. Change it to prefer `iframe.src` when `iframeSrc` is available.

**Change in `handlePreviewReady` (html-folder branch):**

```javascript
if (sourceId === 'html-folder') {
    if (requestId !== undefined && requestId !== -1 && requestId !== state.previewRequestId) return;

    // Reset zoom state
    resetZoom('html');

    // Hide loading states
    const initialState = document.getElementById('html-initial-state');
    const loadingState = document.getElementById('html-loading-state');
    if (initialState) initialState.style.display = 'none';
    if (loadingState) loadingState.style.display = 'none';

    const iframe = document.getElementById('html-preview-frame');
    const iframeWrapper = document.getElementById('html-preview-wrapper');
    const htmlWrapper = document.querySelector('#html-preview-content .preview-panel-wrapper');

    if (msg.iframeSrc) {
        // Use real http:// origin — fixes external fetch persistence
        if (iframeWrapper) iframeWrapper.style.display = 'flex';
        if (htmlWrapper) htmlWrapper.classList.add('scanlines-suppressed');
        if (iframe) {
            iframe.removeAttribute('srcdoc');
            iframe.src = msg.iframeSrc + '?t=' + Date.now(); // cache-buster
            console.log('[PlanningPanel] Loading preview via iframe.src:', msg.iframeSrc);
        }
    } else if (msg.htmlContent) {
        // Fallback: srcdoc (backward compat or when server can't start)
        if (iframeWrapper) iframeWrapper.style.display = 'flex';
        if (htmlWrapper) htmlWrapper.classList.add('scanlines-suppressed');
        if (iframe) {
            iframe.removeAttribute('src');
            const htmlWithBase = injectBaseTag(msg.htmlContent, msg.webviewUri);
            iframe.srcdoc = htmlWithBase;
            console.log('[PlanningPanel] Loading preview via iframe.srcdoc (fallback)');
        }
    }

    // Apply zoom
    const iframeViewport = iframeWrapper ? iframeWrapper.querySelector('.zoomable-viewport') : null;
    if (iframeViewport) applyZoom('html', iframeViewport);

    // ... (existing status update) ...
    return;
}
```

**Important:** Remove `sandbox="allow-same-origin"` from the iframe in `planning.html` if using `iframe.src` with `http://` origin. Actually, keep `sandbox="allow-scripts"` **without** `allow-same-origin` for cross-origin isolation. But this breaks relative asset loading for same-folder CSS/JS.

**Decision:** Keep `sandbox="allow-scripts allow-same-origin"`. Rationale:
- With `iframe.src = 'http://127.0.0.1:PORT/...'`, the iframe's origin is `http://127.0.0.1:PORT`, which is **cross-origin** from `vscode-webview://`. The `allow-same-origin` sandbox token only restores same-origin behavior when the iframe's URL is same-origin with the parent — which it is not. So `allow-same-origin` is effectively a no-op here. It does not grant access to the parent webview.
- It *does* allow the iframe to access its own cookies/localStorage under `http://127.0.0.1:PORT`, which is harmless.
- Without `allow-same-origin`, the iframe gets an opaque origin, which would break `<base>` tag resolution and same-folder asset loading.

Wait — actually, re-reading the spec: when sandbox has `allow-same-origin` and the iframe has a real URL, the iframe uses its URL's origin. Without `allow-same-origin`, it uses a unique opaque origin. For our case:
- With `allow-same-origin` + `http://127.0.0.1:PORT` origin → cross-origin from parent, can't access parent. Can access its own localStorage.
- Without `allow-same-origin` + `http://127.0.0.1:PORT` origin → opaque origin. Still cross-origin from parent. But now can't access its own localStorage either.

So keeping `allow-same-origin` is fine and even slightly better (allows the preview's own localStorage). The key security improvement is that the iframe is now on a different origin from the webview, which it already was with `srcdoc` (null origin), but `null` origin is actually more dangerous for some attacks. The `http://` origin is cleaner.

Actually, let me reconsider. The iframe currently has:
```html
<iframe sandbox="allow-scripts allow-same-origin" srcdoc="..."></iframe>
```
With `srcdoc`, `allow-same-origin` means the iframe gets the parent webview's origin. That's the security problem.

When we change to `iframe.src = 'http://127.0.0.1:PORT/...'`, we should ideally remove `allow-same-origin` so the iframe gets an opaque origin. But then relative asset resolution might break.

Hmm, actually, `<base href="http://127.0.0.1:PORT/">` in the served HTML would fix relative paths. And the server serves sibling assets too. So we could remove `allow-same-origin`.

But the existing `injectBaseTag` adds a `<base>` tag. If we serve the file directly, the browser resolves relative URLs against the file's own URL, which is exactly what we want. No `<base>` tag needed.

So the simplest change: remove `allow-same-origin` from the sandbox when loading via `iframe.src`. But we need to keep it for `srcdoc` fallback.

**Revised approach:**

In `handlePreviewReady`:
- If using `iframe.src` (localhost server): set `iframe.sandbox = "allow-scripts"` (remove allow-same-origin)
- If using `iframe.srcdoc` (fallback): set `iframe.sandbox = "allow-scripts allow-same-origin"`

This gives maximum isolation for the primary path and maintains backward compatibility for the fallback.

## Edge-Case & Dependency Audit

- **Cache hit path:** When `htmlContent === lastContent`, the backend currently sends `previewReady` with only `webviewUri` and no `htmlContent`. With this change, the backend should still send `iframeSrc` on cache hits so the frontend can load it. The dedup logic should compare `iframeSrc` instead of (or in addition to) `htmlContent`.

- **Auto-refresh watcher:** `_setupActiveDocWatcher` triggers `_handleFetchPreview` on file change. The server is already running (from the initial preview), so `_ensureHtmlServer` will return immediately. The auto-refresh flow works unchanged.

- **Image previews:** The existing June 2025 image preview changes (if already implemented) use `isImage` flag and a separate `<img>` tag. Those remain untouched — images still use `webviewUri`, not `iframeSrc`.

- **Multiple sourceFolders:** Each sourceFolder gets its own server port. Switching between files in different folders creates multiple servers. Each auto-shuts down after 10 min of inactivity. Add a cleanup on panel dispose to close all servers immediately.

- **Port exhaustion:** Highly unlikely — servers are per-sourceFolder, not per-file. A typical workspace has <10 source folders.

- **Server startup failure:** If `_ensureHtmlServer` fails (port conflict, permission), fall back to `srcdoc` and log a warning. The frontend already has the `htmlContent` fallback branch.

- **CORS on localhost server:** The HTML server should add CORS headers to allow the webview iframe to load assets without cross-origin restrictions, though `http://127.0.0.1` is same-origin with itself, so this only matters if the HTML loads external resources.

## Adversarial Synthesis

| # | Finding | Severity | Mitigation |
|---|---|---|---|
| 1 | `http:` in `frame-src` is broad — could allow iframe to load any HTTP URL | LOW | The iframe sandbox (no `allow-popups`, no `allow-top-navigation`) prevents navigation. Combined with deny-list, only `127.0.0.1` ports are practically reachable. |
| 2 | Localhost server could be port-scanned by malicious preview HTML | LOW | Server is bound to `127.0.0.1` only. External machines cannot reach it. Deny-list prevents reading sensitive files. Port range is ephemeral. |
| 3 | `_ensureHtmlServer` could leak open ports if `_htmlServers.clear()` is called without `server.close()` | MEDIUM | The existing dispose path (line ~4631) iterates and closes servers. Verify this on implementation. |
| 4 | Removing `allow-same-origin` for `iframe.src` but keeping it for `srcdoc` creates inconsistent sandbox behavior | NIT | Document in code comments. Both paths are safe; `srcdoc` fallback is a degraded mode. |
| 5 | Cache-buster `?t=Date.now()` on `iframe.src` causes full iframe reload on every preview, losing scroll position and form state | MEDIUM | Cache-buster is needed for auto-refresh but harmful for initial load. Only append cache-buster when `isAutoRefreshed === true`. On initial load, use the bare `iframeSrc`. |

## Verification Plan

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
   - Temporarily break `_ensureHtmlServer` (e.g., throw an error).
   - Verify the preview still loads via `srcdoc` (external fetch will fail, but the page renders).

6. **Cross-origin isolation:**
   - Open browser DevTools inside the VS Code webview (Help → Toggle Developer Tools).
   - Inspect the preview iframe. Verify its `document.origin` is `http://127.0.0.1:PORT`, not `vscode-webview://...`.
   - Try `window.parent.localStorage` from the iframe console → verify it throws a SecurityError.

## Recommendation

Complexity 6 → **Send to Coder** for implementation.
