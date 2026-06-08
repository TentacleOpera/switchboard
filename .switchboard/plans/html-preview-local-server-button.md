# Add Local Server Launch Button to HTML Preview Cards

## Goal

Add a "Serve & Open" button to HTML preview cards that starts a transient local HTTP server and opens the file in the system browser, enabling proper rendering of HTML files with relative asset references (CSS, JS, images) that fail under `file://` protocol.

**Problem:** In the HTML Previews tab, each HTML file card only offers a "Link Doc" action. Users need a one-click way to preview HTML in a real browser with a local HTTP server so relative assets resolve correctly.

**Root Cause:** No existing mechanism in the webview or extension host to start a local HTTP server for arbitrary HTML files and open them in the system browser.

## Metadata
- **Status**: Draft
- **Created**: 2025-01-27
- **Tags**: [frontend, backend, feature, ui]
- **Complexity**: 4
- **Files Touched**: `src/webview/planning.js`, `src/services/PlanningPanelProvider.ts`, `src/webview/planning.html`

## User Review Required

- Confirm the 5-minute inactivity auto-shutdown timeout is acceptable (vs. shorter/longer)
- Confirm no desire for a "Stop Server" button in the UI (current design: auto-shutdown only)

## Complexity Audit

### Routine
- Adding action to `renderNode()` actions array (single line change)
- Adding icon button rendering + click handler in `renderDocCard()` (follows existing `Link Doc` pattern exactly)
- Adding `serveAndOpenHtml` message case in `_handleMessage()` switch (follows existing pattern)
- Adding server cleanup in `dispose()` (follows existing watcher cleanup pattern)
- Optional CSS hover rule for browser button

### Complex / Risky
- `_handleServeAndOpenHtml()` implementation: Node `http` server with path sanitization, MIME detection, port assignment, and inactivity timeout — multi-concern method but each concern is well-understood
- Server map keyed by `sourceFolder` (not `absolutePath`) to avoid duplicate servers for files in the same directory

## Edge-Case & Dependency Audit

- **Race Conditions**: Double-click on "Serve & Open" could trigger two server starts. Mitigation: check `_htmlServers` map before creating; if server exists for that `sourceFolder`, reuse it.
- **Security**: Path traversal via crafted URL (e.g., `http://localhost:PORT/../../etc/passwd`). Mitigation: `path.normalize` + `path.resolve` + check that resolved path starts with `sourceFolder` before serving.
- **Side Effects**: Server holds a port open until timeout or dispose. Multiple directories = multiple servers. Mitigation: one server per `sourceFolder`, 5-minute inactivity shutdown, full cleanup on dispose.
- **Dependencies & Conflicts**: `LocalApiServer.ts` already uses `http.createServer` + `listen(0, '127.0.0.1')`. The new server follows the same pattern. No port conflict risk because OS assigns ephemeral ports. No import conflicts — `http` is a Node built-in already used in the codebase.

## Dependencies

- None (all Node built-in modules, no new packages)

## Adversarial Synthesis

Key risks: server map keyed by `absolutePath` (original plan) would spawn duplicate servers for co-located files — must key by `sourceFolder` instead. Path traversal requires `path.normalize` + `startsWith` check before serving. `sourceFolder` may be undefined in the message — must derive from `absolutePath` using `path.dirname`. Mitigations: follow `LocalApiServer` patterns for port assignment and server lifecycle; add `vscode.window.showErrorMessage` for server start failures.

## Solution Overview

Add a "Serve & Open" icon button to every HTML preview card. When clicked:
1. The webview sends a message to `PlanningPanelProvider`
2. The extension starts a transient Node.js HTTP server on an OS-assigned ephemeral port (`listen(0, '127.0.0.1')`)
3. The server serves the HTML file's parent directory (so relative assets like CSS, JS, images resolve correctly)
4. The system default browser is opened to `http://localhost:<port>/<filename>`
5. The server auto-shuts down after 5 minutes of inactivity or when the VS Code window closes

## Implementation Details

### 1. Front-end: Add Button to Cards

**File**: `src/webview/planning.js`

**Line 952** — In `renderNode()`, change the `actions` array for `sourceId === 'html-folder'`:
```js
} else if (sourceId === 'html-folder') {
    actions = ['Serve & Open', 'Link Doc'];
```

**Lines 826-836** — In `renderDocCard()`, add handling for `'Serve & Open'` in the action rendering block (after the `Link Doc` / `Delete` branch):
```js
if (action === 'Link Doc' || action === 'Delete') {
    // Icon button
    btn.className = 'card-icon-btn' + (action === 'Delete' ? ' card-delete-btn' : '');
    btn.textContent = action === 'Link Doc' ? '🔗' : '×';
    btn.title = action === 'Link Doc' ? 'Copy validated document path' : 'Delete';
    btn.setAttribute('aria-label', action === 'Link Doc' ? 'Link to document' : 'Delete document');
} else if (action === 'Serve & Open') {
    btn.className = 'card-icon-btn';
    btn.textContent = '🌐';
    btn.title = 'Start local server and open in browser';
    btn.setAttribute('aria-label', 'Open in browser via local server');
} else {
    // Text button (Set Context, Import, Sync)
    btn.className = 'planning-card-btn';
    btn.textContent = action;
}
```

**Lines 848-872** — In the click handler inside `renderDocCard()`, add after the `Link Doc` handler:
```js
} else if (action === 'Serve & Open') {
    vscode.postMessage({
        type: 'serveAndOpenHtml',
        docId: nodeId,
        docName: title,
        absolutePath: nodeMetadata?.absolutePath,
        sourceFolder: nodeMetadata?.sourceFolder
    });
```

### 2. Back-end: Message Handler & Server

**File**: `src/services/PlanningPanelProvider.ts`

**Line 1** — Add `http` import (if not already present):
```ts
import * as http from 'http';
```

**Line ~82** (after existing private fields) — Add server lifecycle map:
```ts
private _htmlServers = new Map<string, { server: http.Server; port: number; timeoutId: NodeJS.Timeout }>();
```

**Line ~1018** (in `_handleMessage()` switch) — Add new case after `linkToDocument`:
```ts
case 'serveAndOpenHtml': {
    await this._handleServeAndOpenHtml(
        msg.absolutePath as string,
        msg.docName as string,
        msg.sourceFolder as string | undefined
    );
    break;
}
```

**New private method** — Implement `_handleServeAndOpenHtml()`:
```ts
private async _handleServeAndOpenHtml(absolutePath: string, docName: string, sourceFolder: string | undefined): Promise<void> {
    if (!absolutePath) {
        vscode.window.showErrorMessage('Cannot serve file: no absolute path available.');
        return;
    }

    // Derive sourceFolder from absolutePath if not provided
    const resolvedSourceFolder = sourceFolder || path.dirname(absolutePath);

    // Reuse existing server for this sourceFolder
    const existing = this._htmlServers.get(resolvedSourceFolder);
    if (existing) {
        // Refresh inactivity timeout
        clearTimeout(existing.timeoutId);
        existing.timeoutId = this._createServerTimeout(resolvedSourceFolder);
        const filename = path.basename(absolutePath);
        const url = `http://127.0.0.1:${existing.port}/${encodeURIComponent(filename)}`;
        await vscode.env.openExternal(vscode.Uri.parse(url));
        return;
    }

    // Start new server
    const server = http.createServer((req, res) => {
        this._handleHtmlServerRequest(req, res, resolvedSourceFolder);
    });

    server.listen(0, '127.0.0.1', () => {
        const address = server.address() as { port: number };
        const port = address.port;
        const filename = path.basename(absolutePath);
        const url = `http://127.0.0.1:${port}/${encodeURIComponent(filename)}`;

        const timeoutId = this._createServerTimeout(resolvedSourceFolder);
        this._htmlServers.set(resolvedSourceFolder, { server, port, timeoutId });

        console.log(`[PlanningPanel] HTML server started on port ${port} for ${resolvedSourceFolder}`);
        vscode.env.openExternal(vscode.Uri.parse(url));
    });

    server.on('error', (err) => {
        console.error('[PlanningPanel] HTML server error:', err);
        vscode.window.showErrorMessage(`Failed to start local server: ${err.message}`);
    });
}
```

**New private method** — Request handler with path traversal protection and MIME detection:
```ts
private _handleHtmlServerRequest(req: http.IncomingMessage, res: http.ServerResponse, sourceFolder: string): void {
    const parsedUrl = new URL(req.url || '/', `http://127.0.0.1`);
    const requestedPath = decodeURIComponent(parsedUrl.pathname);

    // Resolve and validate path is within sourceFolder
    const resolvedPath = path.resolve(sourceFolder, requestedPath.substring(1)); // strip leading /
    const normalizedSource = path.normalize(sourceFolder);
    const normalizedResolved = path.normalize(resolvedPath);

    if (!normalizedResolved.startsWith(normalizedSource + path.sep) && normalizedResolved !== normalizedSource) {
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        res.end('Forbidden: path traversal denied');
        return;
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

**New private method** — Minimal MIME type map (no external dependencies):
```ts
private _getMimeType(filePath: string): string {
    const ext = path.extname(filePath).toLowerCase();
    const mimeMap: Record<string, string> = {
        '.html': 'text/html; charset=utf-8',
        '.htm': 'text/html; charset=utf-8',
        '.css': 'text/css; charset=utf-8',
        '.js': 'application/javascript; charset=utf-8',
        '.mjs': 'application/javascript; charset=utf-8',
        '.json': 'application/json; charset=utf-8',
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.gif': 'image/gif',
        '.svg': 'image/svg+xml; charset=utf-8',
        '.ico': 'image/x-icon',
        '.webp': 'image/webp',
        '.woff': 'font/woff',
        '.woff2': 'font/woff2',
        '.ttf': 'font/ttf',
        '.eot': 'application/vnd.ms-fontobject',
        '.webmanifest': 'application/manifest+json',
        '.xml': 'application/xml',
        '.txt': 'text/plain; charset=utf-8',
        '.pdf': 'application/pdf',
    };
    return mimeMap[ext] || 'application/octet-stream';
}
```

**New private method** — Inactivity timeout factory:
```ts
private _createServerTimeout(sourceFolder: string): NodeJS.Timeout {
    return setTimeout(() => {
        const entry = this._htmlServers.get(sourceFolder);
        if (entry) {
            entry.server.close();
            this._htmlServers.delete(sourceFolder);
            console.log(`[PlanningPanel] HTML server auto-shutdown for ${sourceFolder}`);
        }
    }, 5 * 60 * 1000); // 5 minutes
}
```

### 3. Dispose Cleanup

**File**: `src/services/PlanningPanelProvider.ts`

**Line ~4529** (in `dispose()`) — Add server cleanup before the `_disposables` loop:
```ts
// Clean up HTML preview servers
for (const [sourceFolder, entry] of this._htmlServers) {
    try {
        clearTimeout(entry.timeoutId);
        entry.server.close();
    } catch (e) {}
}
this._htmlServers.clear();
```

### 4. CSS (optional)

**File**: `src/webview/planning.html`

**Line ~1752** (after existing `.card-icon-btn:hover` rule) — Add distinct hover color for browser button:
```css
.card-icon-btn[title*="browser"]:hover {
    color: var(--accent-teal);
}
```

## Verification Plan

### Automated Tests
- N/A (skipped per session directive)

### Manual Verification
1. Open Planning Panel → HTML PREVIEWS tab
2. Configure a folder containing HTML files with relative CSS/JS/image references
3. Each HTML card should display a 🌐 icon button next to the existing 🔗 button
4. Clicking 🌐 should:
   - Start a server (verify via console log: `[PlanningPanel] HTML server started on port N`)
   - Open the system default browser to `http://127.0.0.1:<port>/<filename>`
   - The page should render correctly, including relative CSS/JS/image references
5. Clicking 🌐 on a second file in the same directory should reuse the existing server (same port)
6. After 5 minutes with no browser requests, the server should auto-shutdown (verify via console log)
7. Closing VS Code or the Planning Panel should clean up all running servers
8. Verify path traversal protection: manually request `http://127.0.0.1:<port>/../../etc/passwd` — should return 403

## Risks & Mitigations

| Risk | Mitigation |
|------|-----------|
| Port collision | OS-assigned ephemeral port via `listen(0, '127.0.0.1')` — no collision possible |
| Path traversal attack | `path.resolve` + `path.normalize` + `startsWith` check before serving |
| Server left running indefinitely | 5-minute inactivity timeout + dispose cleanup |
| Multiple clicks spawn duplicate servers | Reuse existing server keyed by `sourceFolder` |
| `sourceFolder` undefined in message | Derive from `absolutePath` using `path.dirname` |
| Server start failure | `vscode.window.showErrorMessage` + console error logging |

## Alternatives Considered

- **Use `npx serve` or `live-server`**: Requires external CLI tools and npm. Rejected to keep zero dependencies.
- **Open file directly via `file://` protocol**: Rejected because many modern web features (CORS, ES modules, fetch) are blocked on `file://` URLs. A local HTTP server is more reliable.

## Checklist

- [ ] Add `'Serve & Open'` to HTML card actions in `renderNode()` (line 952)
- [ ] Add icon button rendering in `renderDocCard()` (after line 826)
- [ ] Add click handler for `'Serve & Open'` in `renderDocCard()` (after line 848)
- [ ] Add `import * as http from 'http'` to `PlanningPanelProvider.ts` (line 1 area)
- [ ] Add `_htmlServers` map field to `PlanningPanelProvider` (after line 82)
- [ ] Add `serveAndOpenHtml` message case in `_handleMessage()` (after line 1449)
- [ ] Implement `_handleServeAndOpenHtml()` with server reuse + `listen(0, '127.0.0.1')`
- [ ] Implement `_handleHtmlServerRequest()` with path traversal check + MIME detection
- [ ] Implement `_getMimeType()` with minimal extension-to-MIME map
- [ ] Implement `_createServerTimeout()` for 5-minute inactivity auto-shutdown
- [ ] Add server cleanup in `dispose()` (before line 4575)
- [ ] Optional: Add CSS hover rule for browser button (after line 1752)
- [ ] Manual end-to-end verification

**Recommendation**: Complexity 4 → Send to Coder

## Review Findings

Two MAJOR issues found and fixed in `PlanningPanelProvider.ts`: (1) `_handleServeAndOpenHtml` new-server path returned before server was listening — wrapped `server.listen` + error handler in a `Promise<void>` so the method properly awaits startup; (2) bare directory requests (path `/`) caused EISDIR → 404 — added early 403 rejection for root-path requests and simplified the traversal check to remove dead code. Typecheck passes with zero errors in the modified file (pre-existing errors in unrelated files). Remaining risks: the `await` on `openExternal` is still not checked for failure in the reuse path (cosmetic); `mimeMap` is re-allocated per request (trivial perf).
