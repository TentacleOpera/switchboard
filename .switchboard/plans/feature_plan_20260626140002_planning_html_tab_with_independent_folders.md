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
- Message handlers: `htmlDocsReady` (line 2948) repopulates the tree from `state.htmlFolderPathsByRoot`; `htmlFoldersListed` (line 3004) updates the modal list.
- Outbound messages: `addHtmlFolder` (line 3820), `removeHtmlFolder` (line 3704), `fetchPreview` (used for rendering a selected file), `serveAndOpenHtml` (lines 1003, 2034 — serve over localhost and open in a browser), `linkToDocument`.

**Extension host — `src/services/DesignPanelProvider.ts`:**
- `_setupHtmlFolderWatchers()` (line 404) creates `FileSystemWatcher`s over the configured HTML folders and calls `_sendHtmlDocsReady()` + `_autoRefreshHtmlPreview()` on change.
- `_sendHtmlDocsReady()` (line 484, debounced) calls `localFolderService.listHtmlFiles()` and posts `htmlDocsReady` with the file tree.
- Message cases: `addHtmlFolder` (line 2333) → `service.addHtmlFolderPath(...)`; `removeHtmlFolder` (line 2350) → `service.removeHtmlFolderPath(...)`; `fetchPreview` (line 1558); `serveAndOpenHtml` (line 1620) → spins up an `http.Server`; `_autoRefreshHtmlPreview` (line 3148).

**Persistence — `src/services/LocalFolderService.ts`:**
- All folder lists live in **one** config object, `LocalFolderPathsConfig` (lines 14–24), persisted to the KanbanDatabase `config` table under key `folders.paths` (`saveFolderPathsConfig`, line 130). HTML Previews uses the `htmlFolderPaths` field, with `getHtmlFolderPaths()` / `addHtmlFolderPath()` / `removeHtmlFolderPath()` / `listHtmlFiles()` (lines 387–458).

**The root design fact that makes requirement #1 achievable cleanly:** the **Claude tab is already precedent** for an independent HTML-like folder list. Its comment (`LocalFolderService.ts:460-462`) states: *"The Claude tab has its own independent folder list, decoupled from HTML Previews. It previews the same file types (.html/.htm + images), so it reuses `_scanHtmlFolder`."* It adds a `claudeFolderPaths` field and `getClaudeFolderPaths()`/`addClaudeFolderPath()`/`removeClaudeFolderPath()`/`listClaudeFiles()` that delegate to the shared `_scanHtmlFolder` scanner. **The Planning HTML tab should mirror the Claude tab exactly** — a new `planningHtmlFolderPaths` field — which is what guarantees independence from `htmlFolderPaths`.

**The work, therefore, is a vertical port across all four layers**, not a copy of one HTML fragment. The Planning panel already imports and uses `LocalFolderService` (`PlanningPanelProvider.ts:17`, `_getLocalFolderService(...)`) and already handles `fetchPreview` (line 1911), `linkToDocument` (line 2245), and `addLocalFolder`/`removeLocalFolder`/`listLocalFolders` (lines 1962–1995) — so the folder-CRUD and preview-fetch scaffolding partly exists and can be mirrored. What it lacks is the **HTML-specific watcher + serve + docs-ready broadcast** infrastructure that `DesignPanelProvider` has.

## Metadata

- **Tags:** `planning-panel`, `design-panel`, `html-preview`, `local-folders`, `webview`, `feature`
- **Complexity:** 7 / 10
- **Affected files:**
  - `src/services/LocalFolderService.ts` (new independent `planningHtmlFolderPaths` field + methods)
  - `src/services/PlanningPanelProvider.ts` (folder CRUD + docs-ready broadcast + serve + watchers for planning HTML)
  - `src/webview/planning.html` (new "HTML" tab button, content pane, dedicated independent modal, inlined CSS)
  - `src/webview/planning.js` (tree render, dedicated modal logic, message handlers, outbound messages)
  - `src/webview/design.html` / `src/services/DesignPanelProvider.ts` — **read-only reference**, not modified
- **User-facing:** Yes (new tab in Planning panel)
- **Migration required:** No new migration for the new field (additive, defaults to `[]`); existing `folders.paths` config is read with defaulted keys (see Edge-Case audit).

## Complexity Audit

**Complex / Risky.** This is a four-layer feature port, not a markup change. Specific risk drivers:

- **New persisted state field** in a config object that ships to ~4,000 installs — must be added without breaking existing `folders.paths` reads/writes (additive, defaulted).
- **HTTP server lifecycle.** If the `serveAndOpenHtml` capability is ported, the Planning panel must manage and dispose its own `http.Server` instances (mirroring `DesignPanelProvider._htmlServers`) — leaked servers/ports are a real failure mode. Disposal must hook into the panel's existing `dispose()`.
- **FileSystemWatcher lifecycle.** Watchers must be created on config change and disposed with the panel; duplicated/leaked watchers cause double-refresh and resource leaks.
- **Two separate webview DOM trees.** `planning.html` and `design.html` are distinct webviews — there is no shared DOM, so independence at the DOM level is free, but it means the modal/JS must be **re-implemented**, not referenced.
- **Sandboxed iframe + CSP.** The preview iframe (`sandbox="allow-scripts allow-same-origin"`) and the panel's nonce/CSP rewriting (`PlanningPanelProvider._getHtml`, lines 1264–1341) must be honored so previews render under the Planning panel's CSP.

A focused implementation that **reuses** the planning panel's existing `fetchPreview`/`LocalFolderService` wiring and mirrors the Claude-folder precedent keeps this tractable, but it is decisively above the "routine" bar.

## Edge-Case & Dependency Audit

- **Config back-compat (no migration needed, but must not regress):** `LocalFolderService.loadFolderPathsConfig()` (lines 89–128) explicitly defaults every field (`parsed.xxx || []`). Adding `planningHtmlFolderPaths` means: (a) add it to the `LocalFolderPathsConfig` interface; (b) add `planningHtmlFolderPaths: []` to **both** the no-config default object (lines 93–103) and the parsed object (lines 104–114); (c) add it to the two fallback objects in `_getOrLoadCachedConfig` (lines 165–190) and the catch block (lines 116–127). Existing configs simply read back `[]` for the new field — a no-op for current users. **Do not** drop unknown keys: `saveFolderPathsConfig` already strips only known `_migrated*` keys (line 133); preserve that behavior.
- **Independence guarantee:** Because `planningHtmlFolderPaths` is a distinct field, the Design panel's `htmlFolderPaths` is untouched. Verify there is no shared in-memory cache collision — `_folderPathsCache` holds the whole config object, so both panels reading the same workspace's config see both fields but each only mutates its own. The Design panel must continue calling `getHtmlFolderPaths()`; the Planning panel must call the new `getPlanningHtmlFolderPaths()`.
- **Tab-label asymmetry is intentional:** Planning = `HTML`; Design = `HTML PREVIEWS`. Do not "normalize" them.
- **Dedicated modal (satisfies requirement #1 at the UI layer):** Rather than reproduce design.js's `folderModalScope` multiplexer, give the Planning HTML tab its **own** modal element (e.g. `#html-folder-modal`) and its own open/close/render/add/remove handlers, fully self-contained. This is the clearest interpretation of "independent, not shared" and avoids coupling to planning.js's existing local/tickets folder modals. If planning.js already has a scope-based modal, an alternative is to add an `'planning-html'` scope — but a dedicated modal is preferred for isolation.
- **Empty / unconfigured state:** With no folders configured, show the same empty state as design.html ("Configure a folder to browse HTML files" / `#status-html` "No folder configured").
- **Workspace filtering:** design.html's HTML tab has a `#html-workspace-filter` dropdown and keys folders by workspace root (`state.htmlFolderPathsByRoot`). The Planning panel must mirror this with a planning-html-specific state map (e.g. `state.planningHtmlFolderPathsByRoot`) keyed by root, and respect the planning panel's existing per-tab workspace-selection model (planning tabs use independent workspace dropdowns).
- **File watcher disposal:** Add a `_planningHtmlFolderWatchers: vscode.FileSystemWatcher[]` array and dispose it in the panel's existing dispose path (mirror `DesignPanelProvider.ts:312-313`).
- **HTTP server disposal (if `serveAndOpenHtml` is ported):** Mirror `DesignPanelProvider`'s `_htmlServers` map + cleanup (lines 295–300) in the planning panel's dispose path. **Decision:** port `serveAndOpenHtml` for parity, since stakeholder HTML often needs to be opened in a real browser; if descoped to keep the change smaller, hide the "Open in browser" affordance rather than leaving a dead button.
- **Preview rendering reuse:** `PlanningPanelProvider` already has a `fetchPreview` case (line 1911). Confirm it can render `.html` (it may currently target markdown/docs). If it does not handle HTML files, extend it to read the HTML file and post it back for the iframe, or add a dedicated `fetchPlanningHtmlPreview` — do not silently rely on a markdown-only path.
- **Build/dev:** Editing `src/` is sufficient for dev/testing via the installed VSIX; `dist/` is not consulted in dev. Produce a VSIX only for release verification.
- **No confirmation dialogs:** Folder-remove buttons in the modal must delete immediately — no `confirm()` (a silent no-op in webviews) and no "Are you sure?" gate, per the hard project rule. Mirror design.js's immediate-remove handler (line 3704).

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

**1b. Defaults** — add `planningHtmlFolderPaths: []` (and `planningHtmlFolderPaths: parsed.planningHtmlFolderPaths || []` in the parsed branch) to **all four** default/parse sites: `loadFolderPathsConfig` no-config default (93–103), parsed (104–114), catch (116–127); and `_getOrLoadCachedConfig` parsed (165–175) and fallback (180–190).

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

- **State:** add `private _planningHtmlFolderWatchers: vscode.FileSystemWatcher[] = [];` and, if porting serve, `private _planningHtmlServers = new Map<...>()` mirroring `DesignPanelProvider.ts:45,63`.
- **Message cases** (add alongside the existing `addLocalFolder`/`removeLocalFolder`/`listLocalFolders` cases ~1962–1995, mirroring `DesignPanelProvider.ts:2333,2350`):
  - `addPlanningHtmlFolder` → resolve a folder via `vscode.window.showOpenDialog`, `await service.addPlanningHtmlFolderPath(...)`, then re-list + `_sendPlanningHtmlDocsReady()` and post `planningHtmlFoldersListed`.
  - `removePlanningHtmlFolder` → `await service.removePlanningHtmlFolderPath(message.folderPath)`, then re-broadcast.
  - `listPlanningHtmlFolders` → post `planningHtmlFoldersListed` with `service.getPlanningHtmlFolderPaths()`.
- **Broadcast:** add `_sendPlanningHtmlDocsReady()` mirroring `DesignPanelProvider._sendHtmlDocsReady` (line 484) — debounced, calls `localFolderService.listPlanningHtmlFiles()`, posts `{ type: 'planningHtmlDocsReady', folderPathsByRoot, nodes }`.
- **Watchers:** add `_setupPlanningHtmlFolderWatchers()` mirroring `DesignPanelProvider._setupHtmlFolderWatchers` (line 404) over `getPlanningHtmlFolderPaths()`; call it on init and when folders change; dispose in the panel's dispose path.
- **Preview:** reuse the existing `fetchPreview` case (line 1911). Confirm it serves `.html`; if not, extend it (read file, post content for the iframe). Port `serveAndOpenHtml` from `DesignPanelProvider.ts:1620` with planning-scoped server map + disposal.

### 3. `src/webview/planning.html` — tab button, content pane, dedicated independent modal, CSS

- **Tab button** (in the `#research-tab-bar`, after the existing buttons at lines 3340–3343):

```html
<button class="shared-tab-btn" data-tab="html">HTML</button>
```

- **Content pane** — replicate design.html's `#html-preview-content` block (lines 3731–3777), renaming IDs to a planning-specific namespace to avoid collisions (`#planning-html-content`, `#tree-pane-planning-html`, `#preview-pane-planning-html`, `#planning-html-frame`, `#status-planning-html`, `#planning-html-workspace-filter`, `#planning-html-docs-search`). Keep the sandboxed iframe attributes identical.
- **Dedicated modal** — add a **separate** `<div class="folder-modal" id="html-folder-modal">` (do NOT reuse a shared modal), titled `Manage HTML Folders`, with its own `#html-folder-list-modal`, `#btn-add-html-folder-modal`, `#btn-close-html-folder-modal`. This is the concrete realization of requirement #1.
- **CSS** — the `.folder-modal`, `#tree-pane-*`, `#preview-pane-*` rules are inlined in design.html (lines 2561+, 665+, 962+). Copy the needed rules into planning.html's inline `<style>` if not already present (planning.html already styles `#tree-pane`/`#preview-pane` variants — extend those selectors to include the planning-html IDs).

### 4. `src/webview/planning.js` — tree render, modal logic, message handlers

- **State:** add `state.planningHtmlFolderPathsByRoot` and `state.planningHtmlWorkspaceRootFilter` (mirror design.js's `htmlFolderPathsByRoot`, line 25).
- **Tab switch:** the existing `switchToTab` (line 1265) is data-attribute driven, so the new `data-tab="html"` button works once the content pane exists; on activation, post `listPlanningHtmlFolders` + request docs.
- **Render:** add `renderPlanningHtmlDocs(rootEntry)` mirroring design.js `renderHtmlDocs` (line 784) but targeting the planning IDs and wiring the "Manage Folders" button to a **dedicated** `openHtmlFolderModal()` (not `openFoldersModal('html')`).
- **Modal logic:** add self-contained `openHtmlFolderModal()` / `closeHtmlFolderModal()` / `renderHtmlFolderList()` reading from `state.planningHtmlFolderPathsByRoot`. The per-row remove button posts `removePlanningHtmlFolder` **immediately** (no confirm). The add button posts `addPlanningHtmlFolder`.
- **Inbound handlers:** add `planningHtmlDocsReady` (repopulate tree, mirror design.js line 2948) and `planningHtmlFoldersListed` (update modal list, mirror line 3004).
- **Preview/serve:** on file click, post `fetchPreview` (reuse the planning panel's existing handler) to load the iframe; wire any "Open in browser" affordance to `serveAndOpenHtml` only if ported in step 2.

## Verification Plan

1. **Independence (core requirement #1):**
   - In the Planning panel HTML tab, add folder A. Confirm it appears there. Open the Design panel HTML Previews tab → folder A is **absent**.
   - In the Design panel HTML Previews tab, add folder B. Confirm the Planning panel HTML tab does **not** show folder B.
   - Inspect persisted config: `folders.paths` in the KanbanDatabase `config` table contains both `htmlFolderPaths` (B) and `planningHtmlFolderPaths` (A) as separate arrays.
2. **Label (core requirement #2):** Planning panel tab reads **"HTML"**; Design panel tab still reads **"HTML PREVIEWS"**.
3. **Preview parity:** Configure a folder with `.html` files in the Planning panel. The tree lists them; selecting one renders it in the sandboxed iframe identically to the Design panel.
4. **Remove-immediately:** Click a folder's remove button in the Planning HTML modal → it is removed instantly with **no** confirmation dialog; tree updates.
5. **Empty state:** With no folders configured, the Planning HTML tab shows the "Configure a folder…" empty state and `#status-planning-html` shows "No folder configured".
6. **Back-compat:** Launch against an existing workspace whose `folders.paths` predates this change → no errors; existing Design HTML Previews folders still load; the new Planning HTML list is empty (defaulted `[]`).
7. **Watcher refresh:** With a folder configured in the Planning HTML tab, add/modify an `.html` file on disk → the tree auto-refreshes (watcher fires `planningHtmlDocsReady`).
8. **Resource cleanup:** Close the Planning panel → confirm `_planningHtmlFolderWatchers` (and any `_planningHtmlServers`) are disposed (no leaked watchers/ports; check that re-opening doesn't multiply watchers).
9. **CSP/iframe:** Confirm the preview iframe renders under the Planning panel's nonce/CSP without console CSP violations.
10. **If `serveAndOpenHtml` ported:** "Open in browser" serves the file over localhost and opens it; closing the panel tears down the server.
