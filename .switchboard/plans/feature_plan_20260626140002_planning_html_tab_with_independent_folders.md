# Add an "HTML" Tab to the Planning Panel (Independent of Design's "HTML Previews")

## Goal

Stakeholder-facing HTML docs currently live only behind the **HTML Previews** tab of the Design panel (`design.html`). That feels misplaced — stakeholder HTML belongs in the planning workflow, not the design tooling. Replicate that tab into the Planning panel (`planning.html`) with two deliberate differences:

1. **Independent folder management.** The new tab's "Manage Folders" configuration must be **its own list**, not shared with the Design panel's HTML Previews folders. Adding a folder in the Planning panel must not add it to the Design panel, and vice-versa.
2. **Different tab label.** In `planning.html` the tab is named **"HTML"** (not "HTML Previews"). The Design panel keeps its existing **"HTML PREVIEWS"** label unchanged.

### Problem analysis & root cause

The HTML Previews feature in the Design panel is not just markup — it is a stack spanning three layers:

**Webview markup — `src/webview/design.html`:**
- Tab button: `src/webview/design.html:3600` — `<button class="shared-tab-btn" data-tab="html-preview">HTML PREVIEWS</button>`
- Tab content pane: `src/webview/design.html:3731` — `<div id="html-preview-content" class="shared-tab-content">` containing `#html-workspace-filter`, `#html-docs-search`, `#status-html`, `#tree-pane-html`, `#preview-pane-html`, and the sandboxed `<iframe id="html-preview-frame">` (lines 3731–3777).
- A **shared** "Manage Folders" modal: `src/webview/design.html:4025` — `<div class="folder-modal" id="folder-modal">`. This single modal is reused across the design/html/claude/images/stitch/briefs tabs.
- Tab + modal CSS is inlined in `design.html` (`.folder-modal` at lines 2561–2660; `#tree-pane-html`/`#preview-pane-html` at lines 665+, 962+). Per project convention, `shared-tabs.css` is dead — each panel inlines its own tab CSS.

**Webview logic — `src/webview/design.js`:**
- `folderModalScope` (line 3552) is a single string (`'design' | 'html' | 'claude' | 'images' | 'stitch' | 'briefs'`) that multiplexes the **one shared modal** across tabs.
- `openFoldersModal(scope)` (line 3598) sets the title (`'Manage HTML Previews Folders'` for `'html'`, line 3604) and renders the list.
- `renderHtmlDocs(rootEntry)` (line 784) builds the file tree; its "Manage Folders" button calls `openFoldersModal('html')` (line 798).
- `loadDocumentPreview(sourceId, docId, docName)` (line 1026) — for `sourceId === 'html-folder'` (line 1041), shows loading state and posts `fetchPreview` with `sourceId: 'html-folder'`, `sourceFolder`, and `requestId`.
- `handlePreviewReady(msg)` (line 1131) — for `sourceId === 'html-folder'` (line 1193), checks `msg.iframeSrc` (preferred: sets `iframe.src` to localhost URL) or falls back to `msg.htmlContent` (sets `iframe.srcdoc`). Also handles `isImage` + `webviewUri` for image files.
- Message handlers: `htmlDocsReady` (line 2948) repopulates the tree from `state.htmlFolderPathsByRoot`; `htmlFoldersListed` (line 3004) updates the modal list.
- Outbound messages: `addHtmlFolder` (line 3820), `removeHtmlFolder` (line 3704), `fetchPreview` (used for rendering a selected file), `serveAndOpenHtml` (lines 1003, 2034 — serve over localhost and open in a browser), `linkToDocument`.

**Extension host — `src/services/DesignPanelProvider.ts`:**
- `_setupHtmlFolderWatchers()` (line 404) creates `FileSystemWatcher`s over the configured HTML folders and calls `_sendHtmlDocsReady()` + `_autoRefreshHtmlPreview()` on change.
- `_sendHtmlDocsReady()` (line 484, debounced) calls `localFolderService.listHtmlFiles()` and posts `htmlDocsReady` with the file tree.
- `_buildAndSendPreview()` (line 3034) — **the core preview builder**. Validates `sourceFolder` against an allowed-folders set (design/html/claude/briefs/images paths, lines 3050–3060), reads the file, detects file type (HTML/image/text), creates/gets a localhost server via `_getOrCreateHtmlServer()`, builds a localhost URL via `_buildLocalhostUrl()`, and posts `previewReady` with `iframeSrc`, `htmlContent` (CSP-injected), `webviewUri` (for images), `content`, `fileType`, `isImage`, etc. (lines 3110–3125).
- HTML server infrastructure: `_htmlServers` map (line 63, with 10-min idle auto-shutdown), `_getOrCreateHtmlServer()` (line 1083, with dedup + pending-promise tracking), `_createHtmlServer()` (line 1103), `_buildLocalhostUrl()` (line 1119), `_handleHtmlServerRequest()` (line 1125, with path-traversal protection + `_SERVER_DENY_LIST`), `_createServerTimeout()` (line 1362, 10-min idle shutdown), `_getMimeType()` (line 1334), `_injectLocalCsp()` (line 1372, for srcdoc fallback).
- Message cases: `addHtmlFolder` (line 2333) → `service.addHtmlFolderPath(...)`; `removeHtmlFolder` (line 2350) → `service.removeHtmlFolderPath(...)`; `fetchPreview` (line 1558) → delegates to `_buildAndSendPreview()`; `serveAndOpenHtml` (line 1620) → spins up an `http.Server` via `_getOrCreateHtmlServer()` and opens in browser; `_autoRefreshHtmlPreview` (line 3148) — auto-refreshes the active HTML preview when a watched file changes.
- `dispose()` (line 290) tears down all `_htmlServers` (clears timeouts, closes servers, lines 295–300) and all watchers via `disposeWatchers()` (line 311).

**Persistence — `src/services/LocalFolderService.ts`:**
- All folder lists live in **one** config object, `LocalFolderPathsConfig` (lines 14–24), persisted to the KanbanDatabase `config` table under key `folders.paths` (`saveFolderPathsConfig`, line 130). HTML Previews uses the `htmlFolderPaths` field, with `getHtmlFolderPaths()` / `addHtmlFolderPath()` / `removeHtmlFolderPath()` / `listHtmlFiles()` (lines 387–458).

**The root design fact that makes requirement #1 achievable cleanly:** the **Claude tab is already precedent** for an independent HTML-like folder list. Its comment (`LocalFolderService.ts:460-462`) states: *"The Claude tab has its own independent folder list, decoupled from HTML Previews. It previews the same file types (.html/.htm + images), so it reuses `_scanHtmlFolder`."* It adds a `claudeFolderPaths` field and `getClaudeFolderPaths()`/`addClaudeFolderPath()`/`removeClaudeFolderPath()`/`listClaudeFiles()` that delegate to the shared `_scanHtmlFolder` scanner. **The Planning HTML tab should mirror the Claude tab exactly** — a new `planningHtmlFolderPaths` field — which is what guarantees independence from `htmlFolderPaths`.

**The work, therefore, is a vertical port across all four layers**, not a copy of one HTML fragment. The Planning panel already imports and uses `LocalFolderService` (`PlanningPanelProvider.ts:17`, `_getLocalFolderService(...)`) and already handles `fetchPreview` (line 1911), `linkToDocument` (line 2245), and `addLocalFolder`/`removeLocalFolder`/`listLocalFolders` (lines 1962–1995) — so the folder-CRUD scaffolding partly exists and can be mirrored. **However, critical gaps exist** (detailed in the Proposed Changes):

1. **`_handleFetchPreview` (line 6467) only handles `sourceId === 'local-folder'`** (line 6482) — it calls `localFolderService.fetchDocContent()` which reads files as UTF-8 text for markdown rendering. It has **no branch for HTML files** and cannot produce `iframeSrc` or `htmlContent` for iframe rendering. The auto-refresh code at line 1181 references `'html-folder'` as a possible `_activePreviewSourceId`, but the actual handler doesn't support it. **A new HTML preview path must be added.**
2. **PlanningPanelProvider has none of the HTML server infrastructure** — no `_htmlServers`, no `_getOrCreateHtmlServer`, no `_buildLocalhostUrl`, no `_handleHtmlServerRequest`, no `_createServerTimeout`, no `_getMimeType`, no `_injectLocalCsp`, no `_buildAndSendPreview`, no `_autoRefreshHtmlPreview`. All must be ported from `DesignPanelProvider`.
3. **planning.js `handlePreviewReady` (line 2706) only renders markdown** into a `markdownPreview` div. It has **no iframe rendering logic** — no `iframeSrc` handling, no `htmlContent`/srcdoc fallback, no image preview. A new branch must be added for the planning-html sourceId.

**CSP compatibility (positive finding):** `planning.html`'s CSP meta tag (line 6) already includes `frame-src {{WEBVIEW_CSP_SOURCE}} vscode-webview: vscode-webview-resource: vscode-resource: https: http: about:srcdoc blob: data:;` — the `http:` directive means localhost-served HTML previews will render in the iframe **without any CSP changes**. This matches `design.html`'s CSP (line 6) exactly.

## Metadata

- **Tags:** `frontend, ui, feature`
- **Complexity:** 7 / 10
- **Affected files:**
  - `src/services/LocalFolderService.ts` (new independent `planningHtmlFolderPaths` field + methods)
  - `src/services/PlanningPanelProvider.ts` (folder CRUD + docs-ready broadcast + HTML server infrastructure + serve + watchers + preview builder + auto-refresh for planning HTML)
  - `src/webview/planning.html` (new "HTML" tab button, content pane, dedicated independent modal, inlined CSS)
  - `src/webview/planning.js` (tree render, dedicated modal logic, message handlers, outbound messages, iframe-aware preview handler)
  - `src/webview/design.html` / `src/services/DesignPanelProvider.ts` — **read-only reference**, not modified
- **User-facing:** Yes (new tab in Planning panel)
- **Migration required:** No new migration for the new field (additive, defaults to `[]`); existing `folders.paths` config is read with defaulted keys (see Edge-Case audit).

## User Review Required

Yes — this plan ports a substantial HTTP-server infrastructure into the Planning panel. The user should review:
1. Whether `serveAndOpenHtml` (open-in-browser via localhost) is desired in the Planning panel, or if iframe-only preview suffices (descoping reduces complexity significantly).
2. Whether the dedicated modal approach (`#html-folder-modal`) is preferred over extending the existing `folderModalScope` multiplexer with a `'planning-html'` scope.
3. Whether the tab `data-tab` attribute should be `"html"` (simple, matches convention) or `"planning-html"` (avoids any future ID collision if a Design-style `html-preview` tab is ever added to Planning).

## Complexity Audit

### Routine
- Adding `planningHtmlFolderPaths` field to `LocalFolderPathsConfig` interface and all 5 default/parse sites (mechanical, mirrors existing fields exactly)
- Adding `getPlanningHtmlFolderPaths`/`addPlanningHtmlFolderPath`/`removePlanningHtmlFolderPath`/`listPlanningHtmlFiles` methods (copy-paste of Claude-folder methods with renamed field)
- Adding the "HTML" tab button to the tab bar (one `<button>` element)
- Adding the content pane HTML (copy from design.html with renamed IDs)
- Adding the dedicated folder modal HTML (copy from planning.html's existing `#folder-modal` with new IDs)
- Adding CSS rules for the new IDs (extend existing selectors)
- Adding `planningHtmlDocsReady`/`planningHtmlFoldersListed` message handlers (mirror existing patterns)
- Adding `addPlanningHtmlFolder`/`removePlanningHtmlFolder`/`listPlanningHtmlFolders` message cases (mirror existing `addLocalFolder`/`removeLocalFolder`/`listLocalFolders`)

### Complex / Risky
- **Porting the full HTML server infrastructure** (8+ methods from DesignPanelProvider: `_getOrCreateHtmlServer`, `_createHtmlServer`, `_buildLocalhostUrl`, `_handleHtmlServerRequest`, `_createServerTimeout`, `_getMimeType`, `_injectLocalCsp`, `_buildAndSendPreview`). This is ~200 lines of HTTP server code with path-traversal protection, deny-list filtering, and idle-timeout management.
- **Adding a new HTML preview branch to `_handleFetchPreview`** (or a new `_buildAndSendPlanningHtmlPreview` method). The existing handler only supports `local-folder` (markdown/text). The new branch must validate against `planningHtmlFolderPaths`, read HTML files, create localhost servers, and post `previewReady` with `iframeSrc`/`htmlContent`/`webviewUri`/`isImage`.
- **Adding iframe rendering to planning.js `handlePreviewReady`**. The existing function only renders markdown into a div. A new branch must handle `iframeSrc` (set `iframe.src`), `htmlContent` (set `iframe.srcdoc`), and `isImage` + `webviewUri` (show image element) — mirroring design.js's `handlePreviewReady` html-folder branch (lines 1193–1240).
- **HTTP server lifecycle.** The Planning panel must manage and dispose its own `http.Server` instances — leaked servers/ports are a real failure mode. Disposal must hook into the panel's existing `dispose()` (line 7734).
- **FileSystemWatcher lifecycle.** Watchers must be created on config change and disposed with the panel; duplicated/leaked watchers cause double-refresh and resource leaks.
- **Auto-refresh infrastructure.** Porting `_autoRefreshHtmlPreview` (DesignPanelProvider line 3148) and `_registerSaveTextDocListener` (line 3138) so file changes on disk auto-refresh the active preview.
- **New persisted state field** in a config object that ships to ~4,000 installs — must be added without breaking existing `folders.paths` reads/writes (additive, defaulted).
- **Content pane ID convention.** `switchToTab` (planning.js line 1283) looks for `${tabName}-content`. With `data-tab="html"`, the content pane MUST have `id="html-content"` — NOT `planning-html-content` as initially proposed. If `planning-html` is used as the data-tab, then `id="planning-html-content"` is correct. The implementer must keep these consistent.

## Edge-Case & Dependency Audit

- **Config back-compat (no migration needed, but must not regress):** `LocalFolderService.loadFolderPathsConfig()` (lines 89–128) explicitly defaults every field (`parsed.xxx || []`). Adding `planningHtmlFolderPaths` means: (a) add it to the `LocalFolderPathsConfig` interface; (b) add `planningHtmlFolderPaths: []` to **both** the no-config default object (lines 93–103) and the parsed object (lines 104–114); (c) add it to the catch block (lines 116–127); (d) add it to `_getOrLoadCachedConfig` parsed (lines 165–175) and fallback (lines 180–190). Existing configs simply read back `[]` for the new field — a no-op for current users. **Do not** drop unknown keys: `saveFolderPathsConfig` already strips only known `_migrated*` keys (line 133); preserve that behavior.
- **Independence guarantee:** Because `planningHtmlFolderPaths` is a distinct field, the Design panel's `htmlFolderPaths` is untouched. Verify there is no shared in-memory cache collision — `_folderPathsCache` holds the whole config object, so both panels reading the same workspace's config see both fields but each only mutates its own. The Design panel must continue calling `getHtmlFolderPaths()`; the Planning panel must call the new `getPlanningHtmlFolderPaths()`.
- **Tab-label asymmetry is intentional:** Planning = `HTML`; Design = `HTML PREVIEWS`. Do not "normalize" them.
- **Content pane ID convention (critical):** `switchToTab` (planning.js line 1283) resolves the content pane as `document.getElementById(tabName === 'docs' ? 'docs-content' : \`${tabName}-content\`)`. If the tab button uses `data-tab="html"`, the content pane MUST have `id="html-content"`. If `data-tab="planning-html"` is used instead, the ID must be `planning-html-content`. The initial plan draft proposed `data-tab="html"` with `id="planning-html-content"` — **this is a mismatch that would cause the tab to show a blank pane.** Recommendation: use `data-tab="html"` with `id="html-content"` for simplicity (no existing `html-content` ID in planning.html to collide with).
- **Dedicated modal (satisfies requirement #1 at the UI layer):** Rather than reproduce design.js's `folderModalScope` multiplexer, give the Planning HTML tab its **own** modal element (e.g. `#html-folder-modal`) and its own open/close/render/add/remove handlers, fully self-contained. This is the clearest interpretation of "independent, not shared" and avoids coupling to planning.js's existing local/tickets folder modals. If planning.js already has a scope-based modal, an alternative is to add an `'planning-html'` scope — but a dedicated modal is preferred for isolation.
- **Empty / unconfigured state:** With no folders configured, show the same empty state as design.html ("Configure a folder to browse HTML files" / `#status-html` "No folder configured").
- **Workspace filtering:** design.html's HTML tab has a `#html-workspace-filter` dropdown and keys folders by workspace root (`state.htmlFolderPathsByRoot`). The Planning panel must mirror this with a planning-html-specific state map (e.g. `state.planningHtmlFolderPathsByRoot`) keyed by root, and respect the planning panel's existing per-tab workspace-selection model (planning tabs use independent workspace dropdowns).
- **File watcher disposal:** Add a `_planningHtmlFolderWatchers: vscode.FileSystemWatcher[]` array and dispose it in the panel's existing dispose path (line 7734, mirror the `_localFolderWatchers` disposal pattern at lines 7748–7751).
- **HTTP server disposal:** Mirror `DesignPanelProvider`'s `_htmlServers` map + cleanup (lines 295–300) in the planning panel's dispose path (line 7734). **Decision:** port `serveAndOpenHtml` for parity, since stakeholder HTML often needs to be opened in a real browser; if descoped to keep the change smaller, hide the "Open in browser" affordance rather than leaving a dead button.
- **Allowed-folders validation:** DesignPanelProvider's `_buildAndSendPreview` (lines 3050–3060) validates `sourceFolder` against an allowed-folders set (design/html/claude/briefs/images paths). The Planning panel's equivalent MUST include `getPlanningHtmlFolderPaths()` in its allowed-folders check — otherwise preview requests will be rejected with "sourceFolder is not a configured ... folder".
- **Preview rendering — critical gap:** `PlanningPanelProvider._handleFetchPreview` (line 6467) only handles `sourceId === 'local-folder'` (line 6482), which calls `localFolderService.fetchDocContent()` — a method that reads files as UTF-8 text for markdown rendering and validates against `getFolderPaths()` (the `localFolderPaths` field), NOT `getPlanningHtmlFolderPaths()`. It cannot produce `iframeSrc` or `htmlContent` for iframe rendering. **A new branch for `sourceId === 'planning-html-folder'`** (or a new `_buildAndSendPlanningHtmlPreview` method) must be added that mirrors DesignPanelProvider's `_buildAndSendPreview` (line 3034): validate sourceFolder, read file, detect type, create localhost server, build URL, post `previewReady` with `iframeSrc`/`htmlContent`/`webviewUri`/`isImage`.
- **planning.js `handlePreviewReady` — critical gap:** The existing `handlePreviewReady` (line 2706) only renders markdown content into a `markdownPreview` div. It has no iframe rendering logic. **A new branch for `sourceId === 'planning-html-folder'`** must be added that mirrors design.js's html-folder handling (lines 1193–1240): check `msg.iframeSrc` (set `iframe.src`), fall back to `msg.htmlContent` (set `iframe.srcdoc`), handle `isImage` + `webviewUri` (show image element), manage loading/initial/preview-wrapper visibility states.
- **Auto-refresh:** Port `_autoRefreshHtmlPreview` (DesignPanelProvider line 3148) and `_registerSaveTextDocListener` (line 3138) so that saving a file in the editor or on disk auto-refreshes the active planning-HTML preview. Track `_activePlanningHtmlPreview` state (mirror `_activeHtmlPreview` at DesignPanelProvider line 78).
- **CSP already compatible:** `planning.html` line 6 includes `frame-src ... http: ...` in its CSP meta tag. Localhost-served HTML previews will render without CSP changes. No action needed — noted as a positive finding.
- **Build/dev:** Editing `src/` is sufficient for dev/testing via the installed VSIX; `dist/` is not consulted in dev. Produce a VSIX only for release verification.
- **No confirmation dialogs:** Folder-remove buttons in the modal must delete immediately — no `confirm()` (a silent no-op in webviews) and no "Are you sure?" gate, per the hard project rule. Mirror design.js's immediate-remove handler (line 3704).

## Dependencies

- None — this is a self-contained feature port. No other plan or session is a prerequisite.

## Adversarial Synthesis

Key risks: (1) the plan's initial claim that `fetchPreview` can be "reused" was wrong — the Planning panel's handler only supports markdown, not HTML/iframe, so a full preview-builder port is required; (2) HTTP server lifecycle (port leaks, missing disposal) is the highest-severity operational risk; (3) the content-pane ID convention mismatch (`data-tab="html"` vs `id="planning-html-content"`) would silently render a blank tab. Mitigations: port the complete `_buildAndSendPreview` + server infrastructure from DesignPanelProvider verbatim; add `_planningHtmlServers` disposal to the existing `dispose()` path; use `id="html-content"` to match the `data-tab="html"` convention.

## Proposed Changes

### 1. `src/services/LocalFolderService.ts` — independent storage (mirror the Claude-folder precedent)

**1a. Interface** (lines 14–24) — add the field:

```typescript
export interface LocalFolderPathsConfig {
    localFolderPaths: string[];
    htmlFolderPaths: string[];
    planningHtmlFolderPaths: string[];   // NEW — independent from htmlFolderPaths (Design panel)
    claudeFolderPaths: string[];
    designFolderPaths: string[];
    ticketsFolderPaths: string[];
    imagesFolderPaths: string[];
    stitchFolderPaths: string[];
    briefsFolderPaths: string[];
    ticketsAutoSync?: boolean;
}
```

**1b. Defaults** — add `planningHtmlFolderPaths: []` (and `planningHtmlFolderPaths: parsed.planningHtmlFolderPaths || []` in the parsed branch) to **all five** default/parse sites: `loadFolderPathsConfig` no-config default (93–103), parsed (104–114), catch (116–127); and `_getOrLoadCachedConfig` parsed (165–175) and fallback (180–190).

**1c. Methods** — add, mirroring `getClaudeFolderPaths`/`addClaudeFolderPath`/`removeClaudeFolderPath`/`listClaudeFiles` (lines 464–528), delegating file listing to the existing `_scanHtmlFolder` scanner (which already handles `.html/.htm` + images):

```typescript
getPlanningHtmlFolderPaths(): string[] {
    const cfg = this._getOrLoadCachedConfig();
    const seen = new Set<string>();
    return (cfg.planningHtmlFolderPaths || [])
        .map(p => this.resolveFolderPath(p))
        .filter(p => p && !seen.has(p) && seen.add(p) as unknown as boolean);
}

async addPlanningHtmlFolderPath(folderPath: string): Promise<void> {
    const cfg = await this.loadFolderPathsConfig();
    const currentPaths = cfg.planningHtmlFolderPaths || [];
    const resolvedInput = this.resolveFolderPath(folderPath);
    if (!currentPaths.some(p => this.resolveFolderPath(p) === resolvedInput)) {
        cfg.planningHtmlFolderPaths = [...currentPaths, folderPath];
        await this.saveFolderPathsConfig(cfg);
    }
}

async removePlanningHtmlFolderPath(folderPath: string): Promise<void> {
    const cfg = await this.loadFolderPathsConfig();
    const currentPaths = cfg.planningHtmlFolderPaths || [];
    const resolvedToRemove = this.resolveFolderPath(folderPath);
    cfg.planningHtmlFolderPaths = currentPaths.filter(p => this.resolveFolderPath(p) !== resolvedToRemove);
    await this.saveFolderPathsConfig(cfg);
}

async listPlanningHtmlFiles(): Promise<Array<{ id: string; name: string; relativePath: string; isFolder?: boolean; parentId?: string; sourceFolder: string; title?: string; }>> {
    const folderPaths = this.getPlanningHtmlFolderPaths();
    if (folderPaths.length === 0) { return []; }
    const items: any[] = [];
    const seen = new Set<string>();
    for (let i = 0; i < folderPaths.length; i++) {
        const fp = folderPaths[i];
        try { if (!(await fs.promises.stat(fp)).isDirectory()) { continue; } } catch { continue; }
        await this._scanHtmlFolder(fp, fp, items, null, i, seen, 0);
    }
    return items;
}
```

### 2. `src/services/PlanningPanelProvider.ts` — host wiring (mirror Design's HTML infra, scoped to planning)

**2a. State fields** (add near line 77–100):
- `private _planningHtmlFolderWatchers: vscode.FileSystemWatcher[] = [];`
- `private _planningHtmlDocsDebounce: NodeJS.Timeout | undefined;`
- `private _planningHtmlServers = new Map<string, { server: http.Server; port: number; timeoutId: NodeJS.Timeout }>();`
- `private _planningHtmlServerCreationPromises = new Map<string, Promise<{ server: http.Server; port: number; timeoutId: NodeJS.Timeout }>>();`
- `private _activePlanningHtmlPreview: { sourceFolder: string; docId: string; sourceId: string } | null = null;`
- `private _planningHtmlAutoRefreshDebounce: NodeJS.Timeout | undefined;`
- `private _saveTextDocListener: vscode.Disposable | undefined;` (if not already present)
- `private readonly _SERVER_DENY_LIST: readonly string[] = ['.switchboard', '.git', '.env', '.env.', 'node_modules', 'secrets', 'credentials', '.ssh', '.aws'];` (copy from DesignPanelProvider line 65)

**2b. HTML server infrastructure** — port these methods verbatim from `DesignPanelProvider.ts`, renaming `_htmlServers` → `_planningHtmlServers` etc.:
- `_getOrCreatePlanningHtmlServer(sourceFolder)` (mirror line 1083)
- `_createPlanningHtmlServer(sourceFolder)` (mirror line 1103)
- `_buildLocalhostUrl(serverEntry, sourceFolder, filePath)` (mirror line 1119 — generic, can be shared)
- `_handlePlanningHtmlServerRequest(req, res, sourceFolder)` (mirror line 1125 — path traversal + deny list)
- `_createServerTimeout(sourceFolder)` (mirror line 1362 — 10-min idle shutdown, referencing `_planningHtmlServers`)
- `_getMimeType(filePath)` (mirror line 1334)
- `_injectLocalCsp(html)` (mirror line 1372 — for srcdoc fallback)

**2c. Preview builder** — add `_buildAndSendPlanningHtmlPreview(opts)` mirroring `DesignPanelProvider._buildAndSendPreview` (line 3034):
- Validate `sourceFolder` against an allowed-folders set that includes `getPlanningHtmlFolderPaths()` from all workspace roots (mirror lines 3050–3060, adding `svc.getPlanningHtmlFolderPaths().forEach(p => allowedFolders.add(path.resolve(p)))`)
- Read file, detect type (HTML/image/text), create/get localhost server, build URL
- Post `previewReady` with: `type`, `sourceId: 'planning-html-folder'`, `requestId`, `content`, `docName`, `filePath`, `fileType`, `isImage`, `webviewUri`, `iframeSrc`, `htmlContent` (CSP-injected if HTML), `isAutoRefreshed` (mirror message structure at lines 3110–3125)

**2d. Message cases** (add alongside the existing `addLocalFolder`/`removeLocalFolder`/`listLocalFolders` cases ~1962–1995):
- `addPlanningHtmlFolder` → resolve a folder via `vscode.window.showOpenDialog`, `await service.addPlanningHtmlFolderPath(...)`, then re-list + `_sendPlanningHtmlDocsReady()` and post `planningHtmlFoldersListed`. Re-setup watchers.
- `removePlanningHtmlFolder` → `await service.removePlanningHtmlFolderPath(message.folderPath)`, then re-broadcast + re-setup watchers.
- `listPlanningHtmlFolders` → post `planningHtmlFoldersListed` with `service.getPlanningHtmlFolderPaths()`.
- `fetchPreview` for `sourceId === 'planning-html-folder'` → delegate to `_buildAndSendPlanningHtmlPreview()`. **Add a new branch at the top of `_handleFetchPreview` (before line 6541's adapter lookup)** that checks `if (sourceId === 'planning-html-folder')` and calls `_buildAndSendPlanningHtmlPreview()`. Set `_activePlanningHtmlPreview` state (mirror DesignPanelProvider lines 1560–1573).
- `serveAndOpenHtml` → port from `DesignPanelProvider.ts:1620`, using `_planningHtmlServers` instead of `_htmlServers`.
- `linkToDocument` → the existing case (line 2245) should already work; verify it handles the planning-html sourceFolder.

**2e. Broadcast:** add `_sendPlanningHtmlDocsReady()` mirroring `DesignPanelProvider._sendHtmlDocsReady` (line 484) — debounced, calls `localFolderService.listPlanningHtmlFiles()` for all roots, posts `{ type: 'planningHtmlDocsReady', folderPathsByRoot, nodes, workspaceItems }`.

**2f. Watchers:** add `_setupPlanningHtmlFolderWatchers()` mirroring `DesignPanelProvider._setupHtmlFolderWatchers` (line 404) over `getPlanningHtmlFolderPaths()`; call it on init and when folders change; dispose in the panel's dispose path.

**2g. Auto-refresh:** add `_autoRefreshPlanningHtmlPreview(changedUri)` mirroring `DesignPanelProvider._autoRefreshHtmlPreview` (line 3148), checking `_activePlanningHtmlPreview`. Add `_registerSaveTextDocListener()` (mirror line 3138) that fires auto-refresh on save.

**2h. Dispose:** In `dispose()` (line 7734), add disposal for:
- `_planningHtmlFolderWatchers` (mirror `_localFolderWatchers` disposal at lines 7748–7751)
- `_planningHtmlServers` (mirror DesignPanelProvider lines 295–300: clear timeouts, close servers, clear map)
- `_planningHtmlServerCreationPromises` (clear)
- `_planningHtmlDocsDebounce` and `_planningHtmlAutoRefreshDebounce` (clearTimeout)
- `_saveTextDocListener` (dispose)

### 3. `src/webview/planning.html` — tab button, content pane, dedicated independent modal, CSS

- **Tab button** (in the `#research-tab-bar`, after the existing buttons at lines 3339–3343):

```html
<button class="shared-tab-btn" data-tab="html">HTML</button>
```

- **Content pane** — replicate design.html's `#html-preview-content` block (lines 3731–3777), with IDs matching the `data-tab="html"` convention. **The content pane MUST have `id="html-content"`** (per `switchToTab` line 1283: `${tabName}-content`). Use planning-specific IDs for inner elements to avoid collisions: `#tree-pane-planning-html`, `#preview-pane-planning-html`, `#planning-html-frame`, `#status-planning-html`, `#planning-html-workspace-filter`, `#planning-html-docs-search`, `#planning-html-initial-state`, `#planning-html-loading-state`, `#planning-html-preview-wrapper`. Keep the sandboxed iframe attributes identical (`sandbox="allow-scripts allow-same-origin"`).

- **Dedicated modal** — add a **separate** `<div class="folder-modal" id="html-folder-modal">` (do NOT reuse the shared `#folder-modal`), titled `Manage HTML Folders`, with its own `#html-folder-list-modal`, `#btn-add-html-folder-modal`, `#btn-close-html-folder-modal`. This is the concrete realization of requirement #1.

- **CSS** — the `.folder-modal`, `#tree-pane-*`, `#preview-pane-*` rules are inlined in design.html (lines 2561+, 665+, 962+). Copy the needed rules into planning.html's inline `<style>` if not already present (planning.html already styles `#tree-pane`/`#preview-pane` variants — extend those selectors to include the planning-html IDs). The `.folder-modal` CSS already exists in planning.html (lines 2523–2607) and applies to all `.folder-modal` elements, so the new `#html-folder-modal` inherits it automatically.

### 4. `src/webview/planning.js` — tree render, modal logic, message handlers, iframe-aware preview

- **State:** add `state.planningHtmlFolderPathsByRoot`, `state.planningHtmlWorkspaceRootFilter`, `state.planningHtmlDocsSearch`, `state._lastPlanningHtmlDocsMsg` (mirror design.js's `htmlFolderPathsByRoot`, `htmlWorkspaceRootFilter`, `htmlDocsSearch`, `_lastHtmlDocsMsg`).

- **Tab switch:** the existing `switchToTab` (line 1265) is data-attribute driven, so the new `data-tab="html"` button works once the content pane with `id="html-content"` exists. Add initialization in `switchToTab`: `if (tabName === 'html') { vscode.postMessage({ type: 'listPlanningHtmlFolders', workspaceRoot: ... }); }` to request folder list + docs on first activation.

- **Render:** add `renderPlanningHtmlDocs(rootEntry)` mirroring design.js `renderHtmlDocs` (line 784) but targeting the planning IDs (`#tree-pane-planning-html`) and wiring the "Manage Folders" button to a **dedicated** `openHtmlFolderModal()` (not `openFoldersModal('html')`). Filter doc nodes to `.html`/`.htm` extensions (mirror lines 819–824). Use `sourceId: 'planning-html-folder'` for all card clicks.

- **loadDocumentPreview extension:** Add a branch for `sourceId === 'planning-html-folder'` in `loadDocumentPreview` (or create a dedicated `loadPlanningHtmlPreview(docId, docName)`) that shows the loading state (`#planning-html-loading-state`), hides the initial state, and posts `fetchPreview` with `sourceId: 'planning-html-folder'`, `docId`, `requestId`, `sourceFolder`.

- **handlePreviewReady extension:** Add a new branch at the top of `handlePreviewReady` (line 2706) for `sourceId === 'planning-html-folder'` that mirrors design.js's html-folder handling (lines 1193–1240):
  - If `isImage && webviewUri`: hide iframe, show image element, set `img.src = webviewUri`
  - Else if `msg.iframeSrc`: show `#planning-html-preview-wrapper`, set `iframe.src = msg.iframeSrc` (append `?t=Date.now()` if auto-refreshed)
  - Else if `msg.htmlContent`: show wrapper, set `iframe.srcdoc = msg.htmlContent`
  - Hide loading/initial states, update `#status-planning-html`
  - **Return early** — do not fall through to the markdown rendering path

- **Modal logic:** add self-contained `openHtmlFolderModal()` / `closeHtmlFolderModal()` / `renderHtmlFolderList()` reading from `state.planningHtmlFolderPathsByRoot`. The per-row remove button posts `removePlanningHtmlFolder` **immediately** (no confirm). The add button posts `addPlanningHtmlFolder`.

- **Inbound handlers:** add `planningHtmlDocsReady` (repopulate tree, mirror design.js line 2948) and `planningHtmlFoldersListed` (update modal list, mirror line 3004).

- **Preview/serve:** on file click, call `loadPlanningHtmlPreview` which posts `fetchPreview` with `sourceId: 'planning-html-folder'`. Wire any "Open in browser" affordance to `serveAndOpenHtml` only if ported in step 2d.

- **Workspace filter + search:** wire `#planning-html-workspace-filter` change and `#planning-html-docs-search` input to re-filter and re-render the tree (mirror design.js lines 2525–2535 and 2627–2637).

## Verification Plan

### Automated Tests

No automated tests will be run as part of this plan (per session directive: SKIP TESTS). The test suite will be run separately by the user.

### Manual Verification

1. **Independence (core requirement #1):**
   - In the Planning panel HTML tab, add folder A. Confirm it appears there. Open the Design panel HTML Previews tab → folder A is **absent**.
   - In the Design panel HTML Previews tab, add folder B. Confirm the Planning panel HTML tab does **not** show folder B.
   - Inspect persisted config: `folders.paths` in the KanbanDatabase `config` table contains both `htmlFolderPaths` (B) and `planningHtmlFolderPaths` (A) as separate arrays.
2. **Label (core requirement #2):** Planning panel tab reads **"HTML"**; Design panel tab still reads **"HTML PREVIEWS"**.
3. **Tab activation:** Click the "HTML" tab → the `#html-content` pane becomes visible (not blank). If blank, check that `id="html-content"` matches `data-tab="html"` per `switchToTab` convention.
4. **Preview parity:** Configure a folder with `.html` files in the Planning panel. The tree lists them; selecting one renders it in the sandboxed iframe identically to the Design panel (via localhost URL in `iframe.src`).
5. **Image preview:** Select an image file (`.png`/`.jpg`) in the tree → it renders in the image preview element (not the iframe).
6. **Remove-immediately:** Click a folder's remove button in the Planning HTML modal → it is removed instantly with **no** confirmation dialog; tree updates.
7. **Empty state:** With no folders configured, the Planning HTML tab shows the "Configure a folder…" empty state and `#status-planning-html` shows "No folder configured".
8. **Back-compat:** Launch against an existing workspace whose `folders.paths` predates this change → no errors; existing Design HTML Previews folders still load; the new Planning HTML list is empty (defaulted `[]`).
9. **Watcher refresh:** With a folder configured in the Planning HTML tab, add/modify an `.html` file on disk → the tree auto-refreshes (watcher fires `planningHtmlDocsReady`).
10. **Auto-refresh:** With an HTML file selected (preview visible), modify and save it in the editor → the preview auto-refreshes without manual reload.
11. **Resource cleanup:** Close the Planning panel → confirm `_planningHtmlFolderWatchers` (and any `_planningHtmlServers`) are disposed (no leaked watchers/ports; check that re-opening doesn't multiply watchers).
12. **CSP/iframe:** Confirm the preview iframe renders under the Planning panel's nonce/CSP without console CSP violations (CSP already includes `frame-src ... http: ...`).
13. **If `serveAndOpenHtml` ported:** "Open in browser" serves the file over localhost and opens it; closing the panel tears down the server (10-min idle timeout also applies).
