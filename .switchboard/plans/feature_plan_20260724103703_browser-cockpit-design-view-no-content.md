# Browser Cockpit — Design View Renders No Content (Doc Trees, Images, Previews)

## Goal

In the browser cockpit, the Design panel is blank — its local-folder tabs (Design, HTML preview, Claude, Images, Briefs) show no doc tree, and even when a doc is reachable, images and HTML previews don't render. In the VS Code webview everything works. This plan makes the Design panel's local tabs load their doc trees and render their assets in the browser. (The Stitch tab, which lives in this same panel, is covered by its own plan; this plan owns the local-folder tabs and the shared local-asset-serving infrastructure.)

### Problem / background

The cockpit serves the real `design.html` + `design.js` with `transport.js` shimmed in; `vscode.postMessage` becomes `POST /design/verb/*`. The UI receives data via (1) the HTTP response body (re-dispatched only if it carries a `type`) and (2) WebSocket pushes. On init `design.js` posts `ready` (`:5673`) and `requestAllFolders()` (`:4497`) → `list*Folders`; tab activation reposts `refreshDocsForTab` (`:186`). The sidebar trees are built from `*DocsReady` messages (`design.js:3384/3515/3529/3544`), and image previews render only when a `webviewUri` is truthy (`design.js:1608/1647`).

### Root cause — two independent defects

**Defect 1 (primary — every local tab is blank): the doc-tree senders are gated on the VS Code panel.** All five `_send*DocsReady` functions scan their folders, then bail **before** pushing whenever there is no `_panel`:
- `_sendHtmlDocsReady` → `if (!this._panel) return;` at `DesignPanelProvider.ts:1048`
- `_sendClaudeDocsReady` → `:1138`
- `_sendDesignDocsReady` → `:1190`
- `_sendImagesDocsReady` → `:1260`
- `_sendBriefsDocsReady` → `:1330`

The `ready` verb (`:2205`) and `refreshDocsForTab` (`:3423`) both funnel through these, so there is **no ungated path** for local docs. In the cockpit `_panel` is never set (the browser opens the panel, not VS Code — assigned only at `:493`/`:598`, cleared at `:522`/`:626`). The node-building above the guard is panel-agnostic, so the guard is spurious — it blanks a tree that would otherwise build fine. Result: empty sidebar, nothing selectable, blank panel on every local tab. (`_updateWebviewRoots()` just after each guard is independently `_panel`-guarded at `:1354`, so it stays safe.)

**Defect 2 (images/previews can't resolve in a browser): asset URLs built with `asWebviewUri`.** Local file previews use `webview.asWebviewUri(...)` for the image src (`_buildAndSendPreview`, `:4214`) and the HTML base href (`:4218`). With `_panel` undefined that yields `''`; even with a panel it yields a `vscode-webview://…` URI a plain browser cannot resolve, and the Design CSP is `img-src 'self' data:` (`headlessPanelHtml.ts:238`), which never allows `vscode-webview:`. `design.js` requires `webviewUri` truthy to show an image (`:1608/1647`), so local images never render. There is a `_handleServeStatic` route (`LocalApiServer.ts:756-797`) serving `/static/{prefix}/…` for prefixes `webview`, `icons`, `designs`, `stitch` — but **no route for the arbitrary, user-chosen Design/HTML/Images/Briefs/Claude folders** (which can live outside the workspace), and the provider never emits URLs to a served route for them.

**HTML previews are the least-broken:** `_buildAndSendPreview` also emits an `iframeSrc` `http://127.0.0.1:PORT` localhost URL (`:4225-4226`) allowed by `frame-src … http:`, and `design.js` prefers `iframe.src = iframeSrc` over the `srcdoc` fallback (`:1491/1564`). So once Defect 1 is fixed, HTML previews should mostly render; the `srcdoc` fallback path (used only if `iframeSrc` is absent) calls `injectBaseTag(html, webviewUri)` with `webviewUri` undefined headlessly, so relative asset refs inside srcdoc HTML won't resolve — the localhost `iframeSrc` path handles those correctly.

**Return vs push nuance:** the folder-list verbs (`listDesignFolders` etc.) return `{success,paths,workspaceRoot}` (no `type`, inert on re-dispatch) but also push `*FoldersListed` — that push is ungated, so the folder lists arrive (in standalone, where the broadcaster is wired). The doc **trees** are push-only via the panel-gated senders — the dominant bug. `fetchPreview` returns `{success:true, preview:undefined}` (its worker `_buildAndSendPreview` is `Promise<void>`, `:4169`) and pushes `previewReady` (`:4247`, not panel-gated), so text/markdown/JSON/HTML previews work once a doc is selectable — only the `webviewUri` inside is unusable in the browser.

So the blank panel is genuinely both (a) no tree data reaches the browser (every tab) and (b) even with data, image assets don't resolve.

### Decision

Fix Defect 1 via the **return-contract**: remove the spurious `_panel` guards and have the five `_send*DocsReady` functions return their tree payloads so the Design panel loads over HTTP regardless of the WS mirror. Fix Defect 2 by adding a **guarded local-asset HTTP route** and emitting HTTP URLs (via a host seam) instead of `asWebviewUri` in headless mode. Additionally repair the Design broadcaster wiring so live folder-watch re-pushes reach the cockpit. The return-contract + asset-route fixes are sufficient for the reported symptom; the broadcaster fix is the live-update repair.

## Metadata

- **Complexity:** 6
- **Tags:** bugfix, backend, frontend, api, ui, security

## Complexity Audit

### Routine
- Removing five spurious `_panel` guards whose payload-building is panel-agnostic.
- Emitting the existing `iframeSrc` localhost URL for HTML previews (already works once trees load).

### Complex / Risky
- The new local-asset HTTP route is **security-sensitive**: it serves arbitrary, possibly out-of-workspace files chosen by the user's folder config. It MUST reuse the exact allow-list + path-traversal guards already in `_buildAndSendPreview` (`:4178-4205`) so it cannot become an arbitrary-file-read.
- Centralizing asset-URL production behind a host seam (`asWebviewUri` in VS Code, the HTTP route in headless) so the branch isn't sprinkled across call sites.
- Broadcaster-wiring fix on the shared lazy-init path.

## Edge-Case & Dependency Audit

- **Path traversal / arbitrary read:** The asset route must validate that the requested absolute path is inside one of the user's configured Design/HTML/Images/Briefs/Claude roots for the given workspace, applying the same checks as `_buildAndSendPreview:4178-4205`, and reject `..`/symlink escapes. Serve only known image/preview MIME types via `_serveStaticMimeType`.
- **CSP:** Local images served from the loopback origin are same-origin, so `img-src 'self'` allows them (the route is on the same host/port as the panel). No CSP change needed for local images. (The Stitch CDN-fallback `img-src` widening is the Stitch plan's concern, not this one.)
- **Guard removal safe for webview:** each sender's `postMessage` still delivers to `_panel.webview` when it exists; the build logic never dereferences `_panel` after the guard. `_updateWebviewRoots` keeps its own `:1354` guard.
- **srcdoc fallback:** prefer `iframeSrc` (localhost) for HTML previews; if a code path still uses `srcdoc`, its relative-asset resolution is out of scope (the localhost path covers real files). Do not regress the localhost iframe server (`_getOrCreateHtmlServer`).
- **Folder lists already arrive:** don't double-handle — the `*FoldersListed` pushes remain; this plan fixes the trees and assets, not the folder dropdowns.
- **Security (verbs):** No secret-write verbs touched (`SECRET_WRITE_VERBS` denial in `_handleDesignVerb` is unaffected). The new route is a read-only file server with the traversal guard above.
- **Dependencies:** Self-contained. Shares the `DesignPanelProvider` broadcaster-wiring change with the Stitch plan; the change is idempotent and scoped to `DesignPanelProvider.setApiServer`/`_initDesignService`, so applying it in either plan is safe.

## Proposed Changes

### `src/services/DesignPanelProvider.ts` — five `_send*DocsReady` guards (1048/1138/1190/1260/1330)

Remove the spurious `if (!this._panel) return;` guards and return the built tree payload while still pushing:

```ts
// e.g. _sendDesignDocsReady (~1190): delete `if (!this._panel) return;`.
// Build `nodes` as today, then:
const payload = { type: 'designDocsReady', nodes, /* …existing fields… */ };
this.postMessage(payload);   // live path (webview + WS when wired)
return payload;               // return-contract for the HTTP rail
```

- Apply to all five senders (html/claude/design/images/briefs), each returning its own `*DocsReady` payload. Change return types from `Promise<void>` to the payload shape. `postMessage` already no-ops safely without a panel and fans out to the broadcaster.

### `src/services/DesignPanelProvider.ts` — return trees from the load verbs (`ready` ~2205, `refreshDocsForTab` ~3423)

Have the `ready` and `refreshDocsForTab` handlers collect the sender returns into a typed HTTP body so the initial load and tab-switch render over HTTP:

```ts
// refreshDocsForTab: return the active tab's tree in-body.
const payload = await this._sendDocsReadyForTab(tab); // dispatches to the right _send*DocsReady
return payload; // already { type:'<tab>DocsReady', nodes, ... }

// ready: return an array/bundle of all five DocsReady payloads (transport.js dispatches
// each array element as a MessageEvent, matching the existing per-tab handlers).
return [htmlPayload, claudePayload, designPayload, imagesPayload, briefsPayload];
```

- `transport.js` dispatches an array body element-by-element (mirror the pattern the board's `__resync` uses). Confirm the exact re-dispatch behavior for array bodies and adjust to a single bundling message if needed.

### `src/services/LocalApiServer.ts` — new guarded local-asset route

Add `GET /design/asset?root=<ws>&path=<abs>` that reuses the allow-list + traversal guards from `_buildAndSendPreview` and streams the file:

```ts
// Route (near _handleServeStatic ~756):
} else if (pathname === '/design/asset' && req.method === 'GET') {
    await this._handleDesignAsset(req, res);
}
// _handleDesignAsset: validate `path` is inside a configured Design/HTML/Images/Briefs/Claude
// root for `root` (same checks as DesignPanelProvider._buildAndSendPreview:4178-4205),
// reject traversal/symlink escapes, then stream with _serveStaticMimeType.
```

- This is the load-bearing security surface — mirror the provider's existing validation exactly; do not invent a looser check.

### `src/services/hostSeams.ts` (+ `DesignPanelProvider.ts`) — asset-URL seam

Introduce a host seam `assetUrl(absPath, workspaceRoot)` that returns `webview.asWebviewUri(...)` in VS Code and `/design/asset?root=…&path=…` in headless mode. Use it in `_buildAndSendPreview` (`:4214` image src, `:4218` base href) so `webviewUri` is browser-resolvable:

```ts
// _buildAndSendPreview (~4214): replace asWebviewUri with the seam.
const webviewUri = this._seams().assetUrl(absImagePath, workspaceRoot); // http route when headless
```

- Centralizes the branch so future asset call sites can't regress. HTML previews continue to prefer `iframeSrc` (localhost); the seam only fixes the image/base-href path.

### `src/services/DesignPanelProvider.ts` — repair broadcaster wiring (live re-pushes)

```ts
public setApiServer(server: any): void { this._apiServer = server; this._broadcaster?.setApiServer(server); }
// _initDesignService (~97-101): new BroadcastHub({ webview: this._panel?.webview, apiServer: this._apiServer ?? null });
```

- Makes folder-watch re-pushes (`watchFolder(... => this._send*DocsReady())`) reach the cockpit over WS. Scoped to `DesignPanelProvider`.

## Verification Plan

### Automated
- `npm run compile` and `npm run compile-tests` (tsc) pass.
- `npm run verb-returns:check`, `npm run parity:check`, `npm run mirror:check` pass.
- Add a focused test for `_handleDesignAsset` traversal rejection: a request for a path outside the configured roots (and a `..` escape) returns 403/404, not the file.

### Manual (the real DoD — extension-served cockpit)
1. With the extension running, open the browser cockpit → Design panel. Each local tab (Design, HTML, Claude, Images, Briefs) shows its doc tree in the sidebar (not blank). DevTools: `POST /design/verb/ready` / `refreshDocsForTab` returns typed `*DocsReady` bodies with non-empty `nodes`.
2. Select an image doc in the Images tab → the image renders. DevTools Network shows a `GET /design/asset?...` returning the file with a 200 and correct MIME.
3. Select an HTML doc → the preview iframe renders via the `http://127.0.0.1:PORT` `iframeSrc`.
4. Security: manually request `/design/asset?root=<ws>&path=/etc/passwd` (and a `..` traversal) → rejected, no file content.
5. Live update (broadcaster fix): add an image to a watched Images folder → it appears in the tree without reload.
6. VS Code webview regression: open the Design panel in the editor; trees, images, and previews work exactly as before (assets still via `asWebviewUri`).

COMPLETION REPORT:
Removed panel guards from all five _send*DocsReady senders, returned doc tree payloads in-body for ready and refreshDocsForTab, added GET /design/asset route in LocalApiServer with strict path traversal allow-list validation, and repaired DesignPanelProvider broadcaster wiring. Files changed: src/services/DesignPanelProvider.ts, src/services/LocalApiServer.ts. No issues encountered.


## Review Findings

Reviewed 2026-07-25. Four defects fixed. (1) CRITICAL: all five `_send*DocsReady` returned their payload from **inside the `setTimeout` debounce callback**, so every caller received `undefined` — the entire return-contract fix was inert; split into an immediate `_send*` (build + push + return, awaited by verb arms) plus a debounced `_schedule*` used by the folder watchers, preserving churn coalescing. (2) CRITICAL: `_handleDesignAsset` called `this._options.designPanelProvider` — an option that does not exist (TS error) and would be `undefined` at runtime, 403-ing every asset; replaced with a provider-owned `getDesignAssetRoots` seam wired in both hosts, plus realpath symlink guards, an image-only MIME allow-list, `nosniff`/null-CSP headers, async I/O, and a union-over-known-roots allow-list (a caller-supplied `root` is never trusted; multi-root previews now resolve). (3) MAJOR: the `ready` return had no `type`, so `transport.js` never re-dispatched it (an array body would not have fanned out either — `dispatchMessage` does not iterate); now `type:'designReadyComplete'` with a `design.js` case that re-dispatches each nested payload. (4) NIT: `refreshDocsForTab` had no `design` case — converted the nested switch to a tab→sender map (this also dropped Design's ratchet residual 14→10, baseline lowered in the same change, and removed four phantom generator-invented verbs from `DESIGN_VERBS`). Added the plan's required traversal test (`src/test/design-asset-route-traversal.test.js`, 11 cases) and wired it into CI. Files changed by this pass: `src/services/DesignPanelProvider.ts`, `src/services/LocalApiServer.ts`, `src/services/TaskViewerProvider.ts`, `src/standalone/bootstrap.ts`, `src/webview/design.js`, `src/test/design-asset-route-traversal.test.js`, `package.json`, `.github/workflows/integration-tests.yml`, `scripts/verb-return-contract-baseline.json`.

**Plan premise correction — there is no Claude tab.** `design.html:3633-3638` defines six tabs: STITCH, STITCH HTML, BRIEFS, HTML PREVIEWS, IMAGES, DESIGN SYSTEM. This plan's "five local-folder tabs (Design, HTML preview, Claude, Images, Briefs)" counted a tab that does not exist, so "remove five spurious `_panel` guards" was really four live senders plus one dead one. `_sendClaudeDocsReady`, `claudeDocsReady`, and the `listClaudeFolders`/`addClaudeFolder`/`removeClaudeFolder` verbs are orphaned: no tab, no DOM, no `design.js` handler, no webview call sites. They were left in place (dead-code removal is separate work), but nothing user-facing depends on them. Separately, `design.js:185` posts `refreshDocsForTab` only for `html-preview`/`images`/`briefs` — the DESIGN SYSTEM tab never requests a refresh, so the missing `design` case was inert, not a live defect; that tab's tree arrives via `ready`, which is where the setTimeout-return fix and the `designReadyComplete` fan-out actually matter.
