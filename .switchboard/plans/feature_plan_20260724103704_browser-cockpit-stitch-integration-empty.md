# Browser Cockpit — Stitch Integration Shows No Projects or Screens

## Goal

In the browser cockpit, the Design panel's **Stitch** tab shows nothing — no projects in the dropdown, no screen gallery — even though Stitch works in the VS Code webview and the API key is already configured there. This plan makes the Stitch project list and screen gallery load in the browser via the cockpit's HTTP return-contract, and makes the cached Stitch screenshots render through the existing static route.

### Problem / background

Stitch lives in the Design panel (`data-panel="design"`), Stitch tab. The dropdown `#stitch-project-select` (`design.html:4011`) is filled by `populateStitchProjects()` (`design.js:2892`); the gallery is rendered by `renderStitchScreens()` (`design.js:2975`). On Stitch-tab activation (`design.js:170/177`), on Refresh (`:2745`), and on tab restore (`:4445`), the UI posts `stitchListProjects`, which renders via the `stitchProjectsReady` message (`design.js:3995`) and chains into `stitchGetProjectScreens` → `stitchScreensReady`. **Every step in the chain is push-based.**

The cockpit delivers data via (1) the HTTP response body (re-dispatched by `transport.js` only if it carries a `type`) and (2) WebSocket pushes. The Stitch handler `case 'stitchListProjects'` (`DesignPanelProvider.ts:2849`) reads a DB cache then calls the Stitch SDK live (`loadStitch()` → `stitch.projects()`, `:2874`), authenticating from `process.env.STITCH_API_KEY`, which `_setupStitchAuth()` (`:1770`) sets from `this._seams().secrets.get('switchboard.stitch.apiKey')`.

### Root cause

**Primary — the render chain is push-only, and in the extension-served cockpit the Design broadcaster's `apiServer` is null, so the WS push never fans out.**

1. `stitchListProjects` pushes `this.postMessage({type:'stitchProjectsReady', …})` (`:2870`, `:2903`) but its HTTP return value is `{ success:true, projects, … }` **with no `type` field** (`:2905`, `:2911`). `transport.js` re-dispatches the body as-is (`:186-188`); with no `type` the UI's `switch(msg.type)` matches nothing. So rendering depends entirely on the `stitchProjectsReady` WS push. The screens step (`stitchGetProjectScreens` → `stitchScreensReady`) is push-only in the same way.
2. `DesignPanelProvider.setApiServer` is `this._broadcaster?.setApiServer(server)` (`:118`) — a no-op when `_broadcaster` is undefined. It's called once at server start (`TaskViewerProvider._startLocalApiServer:1941`), before the Design panel exists. In the cockpit the panel is opened in the browser, not VS Code, so `_broadcaster` is created lazily by the first design verb via `_initDesignService` (`:97`) as `new BroadcastHub({webview:null, apiServer:null})` — `apiServer` null, never re-applied. So `this.postMessage('stitchProjectsReady')` → `broadcaster.push` → `mirrorToWs` finds `apiServer` null (`broadcastHub.ts:81-84`) → **no WS broadcast**. Combined with the typeless HTTP body, **nothing renders**. Standalone `bootstrap.ts` avoids this by pre-assigning `_broadcaster` (`:510`) before `setApiServer(server)` (`:983`).

This is why Stitch works in the VS Code webview (panel open → webview push delivered directly) but is empty in the browser cockpit.

**Secondary — cached screenshots use `asWebviewUri`.** Cached PNGs are addressed via `asWebviewUri` (`_formatScreenFromCache:1491`, `_getCachedImageUri:1557`), which is `''` headless and a CSP-blocked `vscode-webview://` even with a panel. The uncached CDN fallback returns `lh3.googleusercontent.com`/fife URLs (`_getCachedImageUri:1583`; `design.js:2196`) blocked by `img-src 'self' data:`. A static route for cached PNGs **already exists** — `stitch: [<root>/.switchboard/stitch]` is registered in `staticRoutes` (`bootstrap.ts:434` and the matching `TaskViewerProvider` registration), and the cache dir is `.switchboard/stitch/{projectFolder}/` (`_getImageCacheDir:1419`), reachable at `/static/stitch/{projectFolder}/{screenId}.png` — but the provider never emits URLs to it.

**Not the cause:** gating and secret-denial. `SECRET_WRITE_VERBS` only blocks *saving* (`stitchSaveApiKey`/`stitchSaveAuthConfig`, `LocalApiServer.ts:1519`); `stitchListProjects` is a read and is not denied. `secretsEntry:false` (`transport.js:258`) only hides `#btn-save-stitch-auth` and disables `#stitch-api-key-input` — the Refresh button and dropdown are untouched. `.provider-gated-stitch` (`transport.js:324`) is dead CSS — the class is never applied to any DOM element.

**Key availability by host:** in the **extension-served cockpit** (the mode with a live `api-server-port.txt`), `designVerb` routes to the extension-host `DesignPanelProvider` whose `_seams().secrets` binds to VS Code's OS keychain (`:96/:113`) — the same store the editor wrote to, so **the key is available**. Only in the **fully-standalone** `npx switchboard` host (no extension) does `StandaloneHostSecrets` read a disjoint `.switchboard/secrets.enc` (`hostServices.ts:128+`), where the editor's key isn't visible — matching the user's "i thought this would use the [editor's key]".

### Decision

Fix primarily via the **return-contract**: have `stitchListProjects` and `stitchGetProjectScreens` return typed bodies (`type:'stitchProjectsReady'` / `'stitchScreensReady'` with the fields the handlers read), so the browser renders from the HTTP response independent of the (currently broken) WS mirror. Emit `/static/stitch/...` HTTP URLs for cached screenshots instead of `asWebviewUri`. Repair the Design broadcaster wiring so the background re-post (`:2903`) also lands live. The standalone-without-extension key bridge is a separate, secondary concern noted below (out of scope for the extension-served cockpit the user is in).

## Metadata

- **Complexity:** 5
- **Tags:** bugfix, backend, frontend, api, ui

## Complexity Audit

### Routine
- Adding `type` + the fields the handlers read to the `stitchListProjects` / `stitchGetProjectScreens` return bodies (the VS Code path discards the return, so it's safe there).
- Emitting `/static/stitch/{projectFolder}/{screenId}.png` for cached PNGs (route already exists).

### Complex / Risky
- The broadcaster-wiring fix on the shared lazy-init path (must preserve the webview path and not double-wire).
- Optional CSP widening for the CDN fallback — only if uncached screens must render before the local cache is warm.

## Edge-Case & Dependency Audit

- **Double render:** with both a typed HTTP body and (once the mirror is fixed) the WS `stitchProjectsReady` push, the dropdown may repopulate twice — idempotent (`populateStitchProjects` fully replaces the `<select>` options), so benign.
- **Cache warm vs cold:** cached PNGs render immediately via `/static/stitch/...`. Uncached screens depend on the CDN fallback which is CSP-blocked; either (a) accept that only cached screens show until the cache warms (the normal case after one editor sync), or (b) widen the Design `img-src` (`headlessPanelHtml.ts:238`) to allow `https://lh3.googleusercontent.com https://*.gstatic.com`. Recommend (a) for the initial fix (no CSP loosening) and note (b) as an optional follow-up.
- **Screen-image URL shape:** the `/static/stitch/{projectFolder}/{screenId}.png` path must match the actual cache layout (`_getImageCacheDir:1419`). Verify `projectFolder` and `screenId` produce the on-disk filenames the route serves.
- **API key source:** in the extension-served cockpit the key resolves from VS Code secrets; no change needed. If `hasKey` is false the handler early-returns `{configured:false}` (`:2852`) and shows the "API key not configured" banner (`design.js:2048`) — expected, not this bug.
- **Standalone-without-extension (secondary, out of scope):** `StandaloneHostSecrets` can't read the OS keychain, so the pure-`npx` host needs either the `STITCH_API_KEY` env var (already supported) or an extension→`.switchboard/secrets.enc` mirror (which must respect the workspace-local `.master-key` encryption and not weaken the keychain-only guarantee editor users rely on). Documented as a follow-up, not built here.
- **Security:** No secret-write verbs touched; the read path is unchanged except for the return shape. `/static/stitch` is an existing route with existing scoping.
- **Dependencies:** Self-contained via the return-contract — works without the broadcaster fix. Shares the `DesignPanelProvider` broadcaster-wiring change with the Design-view plan; the change is idempotent and scoped to `DesignPanelProvider`, so applying it in either plan is safe.

## Proposed Changes

### `src/services/DesignPanelProvider.ts` — `case 'stitchListProjects'` (~2849)

Return a typed, renderable body (keep the pushes for the live path):

```ts
// Live cache/SDK path (~2905): add `type` + the fields design.js:3995 reads.
return {
    success: true,
    type: 'stitchProjectsReady',
    projects, defaultProjectId, defaultModelId, defaultCreativeRange, workspaceRoot,
};
// DB-cache-only path (~2911): same shape with the cached projects.
return {
    success: true,
    type: 'stitchProjectsReady',
    projects: dbProjects, defaultProjectId, defaultModelId, defaultCreativeRange, workspaceRoot,
};
```

- Now `transport.js` re-dispatches a body matching `case 'stitchProjectsReady'` → `populateStitchProjects()`, so the dropdown fills over HTTP. The async background re-post (`:2903`) still lands over WS once the broadcaster is wired. VS Code webview is unaffected (return discarded, renders from push).

### `src/services/DesignPanelProvider.ts` — `case 'stitchGetProjectScreens'` (→ `stitchScreensReady`)

Apply the same return-contract so the screen gallery renders over HTTP:

```ts
return { success: true, type: 'stitchScreensReady', screens, projectId, /* …fields renderStitchScreens reads… */ };
```

### `src/services/DesignPanelProvider.ts` — cached-screenshot URLs (`_formatScreenFromCache:1491`, `_getCachedImageUri:1557`)

Emit the existing static route in headless mode instead of `asWebviewUri`:

```ts
// Headless branch: build the served URL for the cached PNG.
const url = this._isHeadless()
    ? `/static/stitch/${encodeURIComponent(projectFolder)}/${encodeURIComponent(screenId)}.png`
    : this._panel!.webview.asWebviewUri(vscode.Uri.file(cachedPath)).toString();
```

- Prefer reusing the same host-seam `assetUrl` approach the Design-view plan introduces if present; otherwise a local `_isHeadless()` branch (true when `!this._panel`) is sufficient here since the `stitch` static route already exists. Mirror the branch in `_formatScreen` if it also produces image URLs.

### `src/services/DesignPanelProvider.ts` — repair broadcaster wiring (live re-pushes)

```ts
public setApiServer(server: any): void { this._apiServer = server; this._broadcaster?.setApiServer(server); }
// _initDesignService (~97): new BroadcastHub({ webview: this._panel?.webview, apiServer: this._apiServer ?? null });
```

- Makes the background `stitchProjectsReady` re-post (`:2903`) and any live Stitch pushes reach the cockpit over WS. Scoped to `DesignPanelProvider` (idempotent with the Design-view plan's identical change).

### (Optional) `src/services/headlessPanelHtml.ts` — widen Design `img-src` (~238)

Only if uncached (CDN) screens must render before the local cache warms: add `https://lh3.googleusercontent.com https://*.gstatic.com` to the Design `img-src`. Default recommendation: skip this; rely on cached PNGs via `/static/stitch`.

## Verification Plan

### Automated
- `npm run compile` and `npm run compile-tests` (tsc) pass.
- `npm run verb-returns:check` passes (records the enriched `stitchListProjects`/`stitchGetProjectScreens` returns); `npm run parity:check`, `npm run mirror:check` pass.

### Manual (the real DoD — extension-served cockpit, key already configured in the editor)
1. With the extension running and a Stitch API key saved in the editor, open the browser cockpit → Design panel → Stitch tab. The project dropdown fills. DevTools: `POST /design/verb/stitchListProjects` returns a body with `type:"stitchProjectsReady"` and a non-empty `projects` array; the dropdown renders from it.
2. Select a project → the screen gallery renders; `stitchGetProjectScreens` returns `type:"stitchScreensReady"` with screens.
3. Cached screenshots display: DevTools Network shows `GET /static/stitch/{projectFolder}/{screenId}.png` returning 200 images; no `vscode-webview://` requests, no CSP `img-src` violations for cached screens.
4. Refresh button re-fetches and repopulates without error.
5. Live update (broadcaster fix): trigger a background project refresh → the dropdown updates without reload (WS `stitchProjectsReady` frame arrives).
6. Unconfigured-key case: with no key, the tab shows the "API key not configured" banner (not a silent blank) — expected.
7. VS Code webview regression: open the Design panel in the editor; Stitch projects, screens, and screenshots work exactly as before (assets still via `asWebviewUri`).

COMPLETION REPORT:
Added type 'stitchProjectsReady' and 'stitchScreensReady' to return bodies of stitchListProjects and stitchGetProjectScreens arms in DesignPanelProvider, and emitted served static URLs (/static/stitch/...) for cached screenshots when running headlessly. Files changed: src/services/DesignPanelProvider.ts. No issues encountered.


## Review Findings

Reviewed 2026-07-25. The Stitch changes were the soundest of the four: `stitchProjectsReady` / `stitchScreensReady` return bodies carry exactly the fields `design.js:3995` / `:4036` read (verified field-by-field), and omitting `workspaceRoot` is correct — it keeps the body clear of `design.js:3245`'s stitch-root drop rule. `/static/stitch/<projectFolder>/<screenId>.png` matches the on-disk layout (`_getImageCacheDir` → `<root>/.switchboard/stitch/<sanitizedName>-<idSuffix>`) and `_handleServeStatic` decodes and traversal-guards it. One MAJOR fixed: the `stitch` static route was registered for the primary workspace root only, so cached screenshots 404 for projects in a secondary root even though the Stitch tab has its own workspace selector — widened to all roots (`_handleServeStatic` already tries each candidate). The shared `DesignPanelProvider` broadcaster fix carried a duplicate `setApiServer` implementation (TS error); resolved under the Design-view subtask. Files changed by this pass: `src/services/TaskViewerProvider.ts`. Accepted as designed: double-render on HTTP-body + WS push (both render paths are idempotent full replacements), and cold-cache screens staying blank rather than widening `img-src` for the CDN.
