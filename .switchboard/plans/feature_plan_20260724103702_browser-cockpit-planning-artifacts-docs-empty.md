# Browser Cockpit — Planning / Artifacts Tab Loads No Docs

## Goal

In the browser cockpit, the Planning ("Artifacts") panel's **DOCS** tab loads no documents — the tree pane stays on its "Loading docs…" placeholder. In the VS Code webview the tree fills with local-folder docs, online source roots (ClickUp/Linear/Notion), and imported docs. This plan makes the DOCS tree load in the browser by delivering the doc-tree payloads through the cockpit's HTTP return-contract (and repairs the Planning WebSocket mirror for live re-pushes).

### Problem / background

The cockpit serves the real `planning.html` + `planning.js` with `transport.js` shimmed in. In the browser, `vscode.postMessage` becomes `POST /planning/verb/*` (both `/planning/verb/*` and `/project/verb/*` route to `_handlePlanningVerb`, `LocalApiServer.ts:3154-3159`). The UI receives data via (1) the HTTP response body, which `transport.js` re-dispatches only if it carries a `type` field, and (2) WebSocket pushes.

The DOCS tab (default-active, `planning.html:3696`, container `#docs-content`) builds its tree from three fire-and-forget messages, each with an existing handler in `planning.js`:
- local-folder docs (+ Antigravity sessions) → `handleLocalDocsReady` from `localDocsReady` (`planning.js:5471`)
- online source roots → `handleOnlineDocsReady` from `onlineDocsReady` (`planning.js:5486`)
- imported docs → `importedDocsReady` (`planning.js:6437`)

On init `planning.js` posts `fetchRoots` (`:12654`) and `refreshSource {sourceId:'local-folder'}` (`:12655`). `planning.js` does not read the injected `data-initial-workspace-root`; the workspace list arrives via `workspaceItemsUpdated` pushes.

### Root cause — two independent defects

**Defect 1 — the doc-tree senders are gated on the VS Code panel, which never exists in the browser.** `_sendLocalDocsReady` (`PlanningPanelProvider.ts:8267`) has `if (!this._panel) { throw … }` at `:8319`, caught downstream and turned into a `localDocsReady` with `nodes: []`. `_sendOnlineDocsReady` (`:8385`) has `if (!this._panel) return;` at `:8398` that silently skips the push — its own comment claims "the fetchRoots arm returns the aggregate payload in-body," but the `fetchRoots` return (`:2603`, `type:'fetchRootsComplete'`) omits all doc-tree nodes, and `planning.js` has no `fetchRootsComplete` handler, so the in-body return is discarded. The node-building in both senders (`_mapLocalFilesToTreeNodes` at `:8244`, etc.) never dereferences `_panel`, so the guards are spurious — they blank a payload that would otherwise build fine headlessly. `refreshSource` for `local-folder` (`:3037`) calls the same `_sendLocalDocsReady`, so it hits the same wall.

**Defect 2 — the Planning WS broadcaster is never wired in the extension host path.** `postMessageToWebview` (`:1022`) → `broadcaster.push(msg,'planning')` → `mirrorToWs` broadcasts only if the broadcaster's `apiServer` is set (`broadcastHub.ts:80`). `setApiServer` (`:145`) is `this._broadcaster?.setApiServer(server)` — a no-op when `_broadcaster` is still undefined. The broadcaster is created lazily by `_initPlanningService` (from `handleServiceVerb:96` or panel-open) with `apiServer: null` hardcoded (`:139`), which runs **after** the activation-time wiring calls (`TaskViewerProvider.setPlanningPanelProvider:3097`, LocalApiServer start `:1944`) — so the server is never attached and `mirrorToWs` never fires. Standalone avoids this by pre-assigning a shared broadcaster (`bootstrap.ts:563`) then `setApiServer` (`:986`), so its WS is wired — but standalone still hits Defect 1 for local/online docs.

**Combined effect:** extension cockpit → nothing loads (WS unwired + `_panel` guards). Standalone cockpit → only imported docs load (`_handleFetchImportedDocs` has no `_panel` guard and returns in-body at `:8871`; local + online stay empty).

The WS plumbing itself is fine (`wsHub.broadcast` fans out with no surface filtering, `transport.js` dispatches every WS message) — the failure is upstream (guarded senders + unwired mirror).

### Decision

Fix primarily via the **return-contract** (the code's own stated "Layer-1 return-in-body" intent that `_sendOnlineDocsReady`'s comment already assumes): remove the spurious `_panel` guards, have the senders also return their payloads, fold them into the `fetchRoots` in-body return, and add a `fetchRootsComplete` handler in `planning.js` that routes the nested payloads to the existing handlers. This is host-agnostic and race-free (no dependency on the WS mirror). Additionally repair the Planning broadcaster wiring so live file-watcher re-pushes work in the extension cockpit.

## Metadata

- **Complexity:** 5
- **Tags:** bugfix, backend, frontend, api, ui

## Complexity Audit

### Routine
- Deleting two spurious `_panel` guards (`:8319`, `:8398`) whose payload-building is panel-agnostic.
- Adding a `case 'fetchRootsComplete'` in `planning.js` that fans out to existing, idempotent handlers.

### Complex / Risky
- Refactoring `_sendLocalDocsReady` / `_sendOnlineDocsReady` / `_handleFetchImportedDocs` to **return** their payloads while still pushing (dual delivery), and having `_handleFetchRoots` collect them into the `fetchRoots` return without changing the VS Code push behavior.
- The broadcaster-wiring fix touches the shared lazy-init path; must not double-wire or regress the webview.

## Edge-Case & Dependency Audit

- **No double-render in VS Code:** In the webview, `_handleMessage`'s return value is discarded by the `onDidReceiveMessage` listener (`:754-762`); only the HTTP transport consumes the return. So adding data to the `fetchRoots` return is browser-only in effect. The existing handlers are idempotent replacements, so even if both a push and an HTTP body arrive in the browser, the tree just rebuilds once with the same data.
- **Guard removal safe for webview:** `postMessageToWebview` still delivers to `_panel.webview` when it exists; neither sender dereferences `_panel` after the guard (confirmed). Note `:2407` (`if (!this._panel) { return match; }`) is a *different*, legitimate guard for webview-URI rewriting in headless mode — leave it; doc-tree nodes are file paths, not webview URIs, so the tree does not need that rewriting to render its labels.
- **Online sources when integrations unconfigured:** `_sendOnlineDocsReady` should still return a well-formed (possibly empty) `onlineDocs` payload when ClickUp/Linear/Notion aren't configured, so the tree shows local/imported docs without erroring.
- **Imported-docs path already works standalone:** Fold `_handleFetchImportedDocs`'s in-body payload (`:8871`) into `fetchRootsComplete` too, so all three sub-trees arrive uniformly on one response rather than via a mix of channels.
- **Asset/URI note:** DOCS-tree rendering needs only file metadata (labels/paths), not webview asset URIs, so unlike the Design panel this fix needs no static asset route. Preview/opening of a selected doc is a separate path (not the reported "no docs in the tree" symptom).
- **Security:** No new external surface; all verbs already wired and allow-listed (`fetchRoots`/`refreshSource` in `PLANNING_VERBS`). No secrets touched.
- **Dependencies:** Self-contained. The broadcaster sub-fix is scoped to `PlanningPanelProvider` and does not collide with the other panels' providers.

## Proposed Changes

### `src/services/PlanningPanelProvider.ts` — `_sendLocalDocsReady` (~8267) & `_sendOnlineDocsReady` (~8385)

Remove the spurious panel guards and make each sender return its payload (while keeping the push for the live path):

```ts
// _sendLocalDocsReady (~8319): delete the `if (!this._panel) { throw … }` guard.
// Build nodes as today, then BOTH push and return:
const payload = { type: 'localDocsReady', nodes, /* …existing fields… */ };
this.postMessageToWebview(payload);   // live path (webview + WS when wired)
return payload;                        // return-contract for the HTTP rail

// _sendOnlineDocsReady (~8398): delete the `if (!this._panel) return;` guard.
// Same dual-delivery shape:
const payload = { type: 'onlineDocsReady', nodes, /* …existing fields… */ };
this.postMessageToWebview(payload);
return payload;
```

- Change the return types from `Promise<void>` to `Promise<PayloadShape>`. The build logic is unchanged; only the guard is removed and the built payload is returned in addition to being pushed.

### `src/services/PlanningPanelProvider.ts` — `_handleFetchRoots` (~8424) & `case 'fetchRoots'` (~2544)

Collect the sender payloads and include them in the `fetchRoots` in-body return:

```ts
// _handleFetchRoots: capture the returns instead of firing-and-forgetting.
const localDocs = await this._sendLocalDocsReady();
const onlineDocs = await this._sendOnlineDocsReady();
const importedDocs = await this._handleFetchImportedDocs(); // already returns in-body (~8871)
return { localDocs, onlineDocs, importedDocs };

// case 'fetchRoots' (~2603): merge those into the existing return object.
return {
    type: 'fetchRootsComplete',
    sources, workspaceItems, restoredTabState, integrationWorkspaces, integrationProviderStates,
    localDocs, onlineDocs, importedDocs,   // NEW: the doc-tree payloads
};
```

### `src/webview/planning.js` — add `case 'fetchRootsComplete'` (near ~5210)

Route the nested payloads to the existing handlers:

```js
case 'fetchRootsComplete': {
    // Browser return-contract: fetchRoots' HTTP body carries the doc-tree payloads
    // that the VS Code webview receives as separate pushes.
    if (msg.workspaceItems)   handleWorkspaceItemsUpdated({ items: msg.workspaceItems });
    if (msg.restoredTabState) applyRestoredTabState(msg.restoredTabState);
    if (msg.localDocs)        handleLocalDocsReady(msg.localDocs);
    if (msg.onlineDocs)       handleOnlineDocsReady(msg.onlineDocs);
    if (msg.importedDocs)     handleImportedDocsReady(msg.importedDocs);
    break;
}
```

- Use the exact existing handler names/entry points (`handleLocalDocsReady` `:5471`, `handleOnlineDocsReady` `:5486`, the `importedDocsReady` handler `:6437`, `workspaceItemsUpdated` `:5214`, `restoredTabState` `:5226`). The sub-payloads must be shaped exactly as those handlers expect (i.e. return from the senders the same object the push sends).

### `src/services/PlanningPanelProvider.ts` — repair broadcaster wiring (live re-pushes)

```ts
// Add a stored server; set it in setApiServer; pass it on lazy creation.
public setApiServer(server: any): void {
    this._apiServer = server;
    this._broadcaster?.setApiServer(server);
}
// _initPlanningService (~139):
this._broadcaster = new BroadcastHub({ webview: this._panel?.webview, apiServer: this._apiServer ?? null });
```

- Makes live file-watcher re-pushes (`_sendLocalDocsReady()` on watched-file change, `:1161`) reach the cockpit over WS. Same latent pattern exists in `KanbanProvider`/`DesignPanelProvider`/`SetupPanelProvider`; this change is scoped to Planning.

## Verification Plan

### Automated
- `npm run compile` and `npm run compile-tests` (tsc) pass.
- `npm run verb-returns:check` passes (records the enriched `fetchRoots` return); `npm run parity:check` and `npm run mirror:check` pass.

### Manual (the real DoD — extension-served cockpit)
1. With the extension running, open the browser cockpit → Planning/Artifacts panel. The DOCS tree leaves "Loading docs…" and fills with local-folder docs (and Antigravity sessions), online source roots (if integrations configured), and imported docs — matching the editor.
2. DevTools: `POST /planning/verb/fetchRoots` returns a body with `type:"fetchRootsComplete"` carrying non-empty `localDocs`/`onlineDocs`/`importedDocs`; the tree renders from it.
3. Standalone regression: run `npx switchboard` against a repo with docs; confirm the DOCS tree now shows local + online docs (previously only imported), proving the guard removal + return-contract works host-agnostically.
4. Live update (broadcaster fix): add a file to a watched local doc folder → the tree updates in the cockpit without reload (WS `localDocsReady` frame arrives).
5. VS Code webview regression: open the Planning panel in the editor; the DOCS tree loads and live-updates exactly as before (no double-render, no missing sub-trees).
