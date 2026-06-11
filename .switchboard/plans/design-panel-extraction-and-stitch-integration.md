# Extract Design & HTML Previews to a Dedicated Design Panel, Add Google Stitch SDK Integration

## Goal

Extract the `design-content` and `html-preview-content` tabs from `planning.html` / `planning.js` / `PlanningPanelProvider.ts` into a new, dedicated `DesignPanel`, create `design.html` and `design.js` webview files that replicate the planning panel's dark theme and all existing Design System / HTML Previews functionality, and integrate `@google/stitch-sdk` (v0.3.5) with a **Stitch** tab for AI-generated UI screens. Register the new panel with a VS Code command, a status bar button, and a quick-action button in `implementation.html`, while preserving all existing user configurations without migration.

**Core Problem, Background & Root-Cause Analysis:**

- **Single-file bloat:** `src/webview/planning.html` (3,467 lines, 141 KB) embeds CSS for eight distinct workflows. Any change to one tab risks regressing others.
- **Provider overload:** `src/services/PlanningPanelProvider.ts` (5,436 lines) handles file watchers, message routing, and preview logic for design docs, HTML files, local docs, online docs, kanban plans, and tickets. Splitting the design/HTML surface area off reduces its scope by ~30%.
- **Missing SDK integration:** There is currently no bridge between Switchboard and Google Stitch. The `@google/stitch-sdk` package exposes a high-level object API (`stitch.project().generate().getHtml()`) that is ideal for a VS Code webview panel but requires a dedicated provider to manage async SDK calls and temporary-URL downloads.

## Metadata

**Tags:** frontend, backend, api, ui, feature, refactor
**Complexity:** 8

## User Review Required

- Stitch API key is user-supplied; no OAuth flow. User must provide key via VS Code settings (`switchboard.stitch.apiKey`) or an inline "Configure API Key" prompt in the Stitch tab.
- Existing design/HTML folder configurations in `local-folder-config.json` are preserved without migration, but users should verify the new Design Panel loads their folders correctly after extraction.
- The `DESIGN SYSTEM` and `HTML PREVIEWS` buttons disappear from the Planning panel tab bar (exact lines: `planning.html:2927–2931`); users must open the dedicated Design panel via command palette, status bar, or the quick-action button in `implementation.html`.

## Complexity Audit

### Routine
- Copy CSS/theme blocks (`:root`, `@font-face`, `body.theme-claudify`, `.cyber-theme-enabled`) into new `src/webview/design.html` from `src/webview/planning.html`.
- Port `switchTab`, `applySidebarState`, tree rendering, and preview logic to `src/webview/design.js`.
- Register `switchboard.openDesignPanel` command and status bar item in `src/extension.ts`.
- Add Design quick-action button in `src/webview/implementation.html` (line ~1893).
- Add Stitch settings and `@google/stitch-sdk` dependency to `package.json`.
- Configure webpack to copy new webview files (already covered by `src/webview/*.html` / `*.js` glob at `webpack.config.js` lines 76–87).

### Complex / Risky
- Surgical removal of design/HTML-related functions, state, event listeners, and message handlers from `src/webview/planning.js` (7,282 lines) without regressing the remaining six tabs.
- Moving file watchers (`_setupHtmlFolderWatchers` at `PlanningPanelProvider.ts:453`, `_setupDesignFolderWatchers` at `PlanningPanelProvider.ts:497`), debounced refresh methods (`_sendHtmlDocsReady` at `PlanningPanelProvider.ts:3559`, `_sendDesignDocsReady` at `PlanningPanelProvider.ts:3638`), and the mini HTTP server lifecycle (`_htmlServers` / `_htmlServerCreationPromises` at `PlanningPanelProvider.ts:88–89`, server methods at `PlanningPanelProvider.ts:5285–5432`) from `PlanningPanelProvider.ts` into a new `DesignPanelProvider.ts`.
- Integrating `@google/stitch-sdk` v0.3.5 with async SDK calls (`project.generate()`, `screen.getHtml()`, `screen.getImage()`), temporary-URL asset downloads, and user-friendly error handling.
- Ensuring `_getHtml()` fallback path resolution works for `design.html` across packaged vs. development builds.

## Edge-Case & Dependency Audit

- **Race Conditions:** During the transition, both `PlanningPanelProvider` and `DesignPanelProvider` could theoretically watch the same folders if the cleanup in Phase 3 is incomplete. Mitigation: remove `_htmlFolderWatchers` and `_designFolderWatchers` entirely from `PlanningPanelProvider` before the new provider starts; the `refreshSource` and folder add/remove handlers in `PlanningPanelProvider` (lines 1276–1356) must also be removed or rerouted.
- **Security:** The HTML preview iframe uses `sandbox="allow-scripts"` (or `allow-scripts allow-same-origin` for srcdoc fallback). The local HTTP server enforces `_SERVER_DENY_LIST` (`PlanningPanelProvider.ts:90–100`). The Stitch API key must never be logged or exposed to the webview; it stays in the Node.js extension host.
- **Side Effects:** Users lose direct access to Design System and HTML Previews from the Planning panel. The `LocalFolderService` configuration format and paths do not change, so no data migration is needed.
- **Dependencies & Conflicts:** `@google/stitch-sdk` is a new runtime dependency. It requires either `STITCH_API_KEY` env var or `switchboard.stitch.apiKey` setting. `LocalFolderService` remains shared; both providers instantiate it per workspace root.

## Dependencies

- No upstream plan dependencies.

## Adversarial Synthesis

Key risks: surgical removal of design/HTML logic from a 7 KB `planning.js` is error-prone and may leave orphaned state keys or event listeners that silently break remaining tabs; Stitch SDK v0.3.5 is a pre-1.0 Google library with an unstable API surface; moving the `_htmlServers` Map and server lifecycle to a new provider risks port leaks if `dispose()` is incomplete. Mitigations: perform a grep-driven pass using identifiers `design-`, `html-`, `tree-pane-design`, `tree-pane-html`, pin the SDK to `^0.3.5` with wrapped try/catch, and mirror the existing server cleanup loop in `DesignPanelProvider.dispose()`.

## Proposed Changes

### Phase 1: Create the New Design Panel Webview (`design.html`, `design.js`)

#### 1.1 `src/webview/design.html`
Create a new webview HTML file that replicates the planning panel's visual identity:

- **CSS vars:** Copy the full `:root` block and `@font-face` declarations from `planning.html` (GeistPixel, Hanken Grotesk, Poppins, kanban dark theme colors, spacing rhythm, shadows).
- **Theme support:** Include the `body.theme-claudify` override and `.cyber-theme-enabled` modifiers.
- **Layout:** Same tab bar (`research-tab-bar` class), controls strip, `content-row` with collapsible sidebar (`tree-pane-*`) + preview pane (`preview-pane-*`) pattern.
- **Tabs:** Three tabs only:
  - `DESIGN SYSTEM` (migrated from `design-content`)
  - `HTML PREVIEWS` (migrated from `html-preview-content`)
  - `STITCH` (new)
- **DOM structure per tab:**
  - Design System: workspace filter dropdown, search input, sidebar tree (`tree-pane-design`), preview area with markdown/image/JSON containers (identical to current `design-content`).
  - HTML Previews: workspace filter, "Open in Browser" / "Copy Link" buttons, sidebar tree (`tree-pane-html`), iframe preview + image preview with zoom toolbar (identical to current `html-preview-content`).
  - Stitch: project selector dropdown, prompt input, device-type selector (DESKTOP / MOBILE / TABLET / AGNOSTIC), generate button, screen gallery with thumbnail + "Download PNG" / "Download HTML" buttons, edit/variant controls, and a **"Sync Project to Workspace"** button that triggers `stitchSyncProject` to download all screens and compile a `DESIGN.md` handoff file.
- **Script loading:** `<script nonce="{{NONCE}}" src="{{DESIGN_JS_URI}}"></script>` at the bottom of `<body>`.
- **Font placeholders:** `{{GEIST_PIXEL_FONT_URI}}`, `{{HANKEN_FONT_URI}}`, `{{POPPINS_SEMIBOLD_FONT_URI}}`, `{{POPPINS_BOLD_FONT_URI}}`.

#### 1.2 `src/webview/design.js`
Create the webview-side JavaScript:

- **Tab switching:** `switchTab(tabName)` with the same `.active` class toggling pattern used in `planning.js`.
- **Sidebar collapse:** Same `applySidebarState` / `toggleSidebarCollapsed` pattern for all three tabs.
- **Design System tree rendering:** Port `renderDesignDocs()` and `handleDesignDocsReady()` from `planning.js`.
- **HTML Preview tree rendering:** Port `renderHtmlDocs()` and `handleHtmlDocsReady()` from `planning.js`.
- **Stitch UI handlers:**
  - `populateStitchProjects(projects)` — fill the project dropdown from `stitch.projects()`.
  - `sendStitchGenerate()` — post `stitchGenerate` message with prompt + deviceType.
  - `sendStitchEdit(screenId, prompt)` / `sendStitchVariants(screenId, prompt, count)` — refinement messages.
  - `sendStitchSyncProject(projectId)` — post `stitchSyncProject` message to extension host to download all screens and compile `DESIGN.md`.
  - `renderStitchScreen(screen)` — display thumbnail (from `getImage()` URL) and download buttons.
  - `downloadStitchAsset(url, filename)` — post `stitchDownloadAsset` message to extension host.
- **Message listeners:** Listen for `designDocsReady`, `htmlDocsReady`, `stitchProjectsReady`, `stitchScreenReady`, `stitchError`, `themeChanged`, `switchboardThemeChanged`, `cyberAnimationSetting`.
- **State management:** A `state` object mirroring the `planning.js` pattern (selected nodes, collapsed flags, dirty flags, last message caches).

### Phase 2: Create the Extension Host Provider (`DesignPanelProvider.ts`)

#### 2.1 `src/services/DesignPanelProvider.ts`
Create a new provider class following the `KanbanProvider` / `SetupPanelProvider` pattern:

```typescript
export class DesignPanelProvider implements vscode.Disposable {
    private _panel?: vscode.WebviewPanel;
    private _disposables: vscode.Disposable[] = [];
    private _nonce: string = '';
    private _htmlFolderWatchers: vscode.FileSystemWatcher[] = [];
    private _designFolderWatchers: vscode.FileSystemWatcher[] = [];
    private _htmlDocsDebounce?: NodeJS.Timeout;
    private _designDocsDebounce?: NodeJS.Timeout;
    private _activeScreens = new Map<string, any>(); // Key: screen.id, Value: SDK Screen instance
    // ...
}
```

**Constructor dependencies:**
- `_extensionUri: vscode.Uri` — for loading HTML/JS/font assets.
- `_getWorkspaceRoot: () => string | undefined` — same pattern as `PlanningPanelProvider`.

**Methods:**
- `open(): Promise<void>` — create/reveal the webview panel (`switchboard-design` viewType, title `DESIGN`, `ViewColumn.One`).
- `postMessage(message: any): void` — passthrough to webview.
- `dispose(): void` — dispose panel and all watchers.
- `_getHtml(webview: vscode.Webview): string` — identical fallback-path logic to `PlanningPanelProvider._getHtml()` but reads `design.html` and substitutes `{{DESIGN_JS_URI}}` pointing to `dist/webview/design.js`.
- `_setupHtmlFolderWatchers(): void` — moved from `PlanningPanelProvider`.
- `_setupDesignFolderWatchers(): void` — moved from `PlanningPanelProvider`.
- `_sendHtmlDocsReady(): void` — scan HTML folders and post `htmlDocsReady` to webview.
- `_sendDesignDocsReady(): void` — scan design folders and post `designDocsReady` to webview.
- `_handleMessage(message: any): Promise<void>` — route webview messages:
  - `ready` — trigger initial doc sends and theme messages.
  - `loadDocumentPreview` — handle design doc / HTML file preview loading.
  - `stitchListProjects` — call `stitch.projects()` and post results.
  - `stitchGenerate` — call `project.generate(prompt, deviceType)`, cache the returned `Screen` instance in `_activeScreens` (key: `screen.id`), then call `screen.getHtml()` + `screen.getImage()`, post `stitchScreenReady`.
  - `stitchEdit` — resolve the `Screen` instance from `_activeScreens` using `message.screenId`; if missing, throw `Error('Screen instance not found in memory cache.')`. Call `screenInstance.edit(prompt)`, update cache with the returned screen, post updated screen.
  - `stitchVariants` — resolve the `Screen` instance from `_activeScreens` using `message.screenId`; call `screenInstance.variants(prompt, options)`, post variant array.
  - `stitchSyncProject` — call `stitch.project(message.projectId).screens()`, loop through all screens, fetch HTML (`.getHtml()`) and PNG (`.getImage()`) temporary URLs, write each screen's HTML and PNG to `workspaceRoot/<outputDir>/screens/<safeScreenId>.html` and `.png`, then compile a unified `DESIGN.md` manifest file at `workspaceRoot/<outputDir>/DESIGN.md`. Use `vscode.workspace.fs.createDirectory` and `vscode.workspace.fs.writeFile` for all disk operations.
  - `stitchDownloadAsset` — `fetch()` the temporary URL. For binary assets (PNG), convert the response via `response.arrayBuffer()` then `Buffer.from(arrayBuffer)` before writing with `vscode.workspace.fs.writeFile(targetUri, binaryBuffer)`. For text assets (HTML), use `response.text()`.
  - `serveHtmlFile` — reuse the existing mini HTTP server logic from `PlanningPanelProvider` (or extract to a shared utility).

**Stitch SDK usage:**
```typescript
import { stitch } from '@google/stitch-sdk';
```
The SDK defaults to `STITCH_API_KEY` from `process.env`. The provider should also support an explicit key from VS Code settings (`switchboard.stitch.apiKey`), setting it in `process.env` before SDK calls if configured.

**Credential handling (not OAuth):**
- The `@google/stitch-sdk` does **not** use OAuth. It requires either:
  - An `apiKey` string, **or**
  - An `accessToken` + `projectId` pair.
- The provider should read `switchboard.stitch.apiKey` from VS Code settings. If empty, it falls back to the `STITCH_API_KEY` environment variable.
- If neither is available, the Stitch tab shows an inline "Configure API Key" input that writes to VS Code settings (via a message back to the extension host).

### Phase 3: Clean Up `planning.html`, `planning.js`, and `PlanningPanelProvider.ts`

#### 3.1 `src/webview/planning.html`
- **Remove** the `DESIGN SYSTEM` and `HTML PREVIEWS` buttons from `#research-tab-bar` (exact lines 2927–2931: remove `<button class="research-tab-btn" data-tab="html-preview">HTML PREVIEWS</button>` and `<button class="research-tab-btn" data-tab="design">DESIGN SYSTEM</button>`).
- **Remove** the entire `<div id="design-content">` block (exact lines 3155–3201, starting at `<div id="design-content" class="research-tab-content">` through closing `</div>` before `html-preview-content`).
- **Remove** the entire `<div id="html-preview-content">` block (exact lines 3202–3258, starting at `<div id="html-preview-content" class="research-tab-content">` through closing `</div>` before `tickets-content`).
- **Remove** CSS selectors specific to `#design-content`, `#html-preview-content`, `#tree-pane-design`, `#tree-pane-html`, `#preview-pane-design`, `#preview-pane-html`, and related `cyber-theme-enabled` rules (exact lines 173–191 in the combined `#local-content, #online-content, #kanban-content, #design-content, #html-preview-content, #tickets-content` block and their `.active` variants; also lines 2236–2239 in `.cyber-theme-enabled` rules).
- **Remove** the `folder-modal-html` modal block if it exists only for HTML previews.

#### 3.2 `src/webview/planning.js`
- **Remove** all design-docs-related functions: `handleDesignDocsReady`, `renderDesignDocs`, `renderDesignFolderListModal`, `populateDesignFolderPicker`, etc.
- **Remove** all HTML-preview-related functions: `handleHtmlDocsReady`, `renderHtmlDocs`, `renderHtmlFolderListModal`, `loadDocumentPreview` branches for `html-folder`, `serveHtmlFile`, etc.
- **Remove** event listeners on `#design-workspace-filter`, `#html-workspace-filter`, `#design-docs-search`, `#html-docs-search`, design/html sidebar toggle buttons.
- **Remove** `state.designWorkspaceRootFilter`, `state.htmlWorkspaceRootFilter`, `state.designDocsSearch`, `state.htmlDocsSearch`, `state._lastDesignDocsMsg`, `state._lastHtmlDocsMsg`.
- **Update** `switchTab` (`planning.js:470–510`) to remove `design` and `html-preview` branches (lines 474–475 for dirty-flag checks, lines 486–488 for `html-preview` reset, lines 499–500 for `applySidebarState` calls).
- **Update** `applySidebarState` calls (`planning.js:454–459`) to remove design/html entries.

#### 3.3 `src/services/PlanningPanelProvider.ts`
- **Remove** private fields: `_htmlFolderWatchers` (line 66), `_htmlDocsDebounce` (line 67), `_designFolderWatchers` (line 68), `_designDocsDebounce` (line 69), `_activeDesignDocSourceId` (line 84), `_activeDesignDocId` (line 85), `_activeDesignSystemDocSourceId` (line 86), `_activeDesignSystemDocId` (line 87), `_htmlServers` (line 88), `_htmlServerCreationPromises` (line 89).
- **Remove** methods: `_setupHtmlFolderWatchers()` (lines 453–495), `_setupDesignFolderWatchers()` (lines 497–540), `_sendHtmlDocsReady()` (lines 3559–3636), `_sendDesignDocsReady()` (lines 3638–3741), `_serveHtmlFile()`, and all HTML-server lifecycle methods (`_getOrCreateHtmlServer` at line 5285, `_createHtmlServer` at line 5312, `_createServerTimeout` at line 5425, and related cleanup in `dispose()` at lines 5155–5162).
- **Remove** `_handleMessage` branches for design/HTML document loading, HTML server requests, design doc active-state messages, etc. (folder add/remove handlers for `addHtmlFolder`/`removeHtmlFolder`/`listHtmlFolders` at lines 1276–1307, `addDesignFolder`/`removeDesignFolder`/`listDesignFolders` at lines 1309–1341, and `refreshSource` branches at lines 1347–1356).
- **Update** `_getHtml()` to no longer reference design/HTML-specific content (this is mostly about reducing the HTML file size, but the provider method itself stays structurally the same).

### Phase 4: Wire the New Panel into the Extension Host

#### 4.1 `src/extension.ts`
- **Import** `DesignPanelProvider` (add after line 24, after `import { PlanningPanelProvider } from './services/PlanningPanelProvider';`).
- **Instantiate** after `planningPanelProvider` (insert after the `planningPanelProvider` instantiation block):
  ```typescript
  const designPanelProvider = new DesignPanelProvider(
      context.extensionUri,
      () => kanbanProvider!.getCurrentWorkspaceRoot() ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
  );
  context.subscriptions.push(designPanelProvider);
  ```
- **Register command** (insert after existing command registrations, before `context.subscriptions.push(openDesignPanelDisposable);`):
  ```typescript
  const openDesignPanelDisposable = vscode.commands.registerCommand(
      'switchboard.openDesignPanel',
      async () => { await designPanelProvider.open(); }
  );
  context.subscriptions.push(openDesignPanelDisposable);
  ```
- **Status bar item:** Add `designStatusBarItem` (priority 93, right-aligned) with `$(paintcan)` icon, tooltip "Open Design Panel", command `switchboard.openDesignPanel`. Insert after `artifactsStatusBarItem` creation (line 1736) in the existing status bar item block.
- **Update** `updateStatusBarVisibility()` (lines 1738–1772): add `showDesignButton` read at the top, conditional `designStatusBarItem.show()/hide()` in the body, and `e.affectsConfiguration('switchboard.statusBar.showDesignButton')` in the config-change listener (around line 1791).
- **Add** configuration change listener: if `switchboard.stitch.apiKey` changes, post a message to the design panel to refresh the Stitch tab auth state.

#### 4.2 `src/webview/implementation.html`
In the Quick Actions section (exact lines 1895–1899), add a fourth button:
```html
<button id="btn-quick-design" class="secondary-btn is-teal" style="flex:1">design</button>
```
And its event listener (add alongside existing quick-action listeners):
```javascript
const btnQuickDesign = document.getElementById('btn-quick-design');
if (btnQuickDesign) btnQuickDesign.addEventListener('click', () => vscode.postMessage({ type: 'openDesignPanel' }));
```

#### 4.3 `src/services/TaskViewerProvider.ts`
Add a handler for the `openDesignPanel` message type (insert after the existing `openPlanningPanel` case at lines 7640–7642):
```typescript
case 'openDesignPanel':
    await vscode.commands.executeCommand('switchboard.openDesignPanel');
    break;
```

### Phase 5: Update `package.json` Contributions

#### 5.1 Commands
Add to `contributes.commands`:
```json
{
  "command": "switchboard.openDesignPanel",
  "title": "Switchboard: Open Design Panel",
  "category": "Switchboard"
}
```

#### 5.2 Settings
Add to `contributes.configuration.properties`:
```json
"switchboard.stitch.apiKey": {
  "type": "string",
  "default": "",
  "description": "Google Stitch API key. Falls back to STITCH_API_KEY environment variable if empty.",
  "scope": "application"
},
"switchboard.stitch.defaultProjectId": {
  "type": "string",
  "default": "",
  "description": "Default Stitch project ID to pre-select in the Design panel.",
  "scope": "application"
},
"switchboard.stitch.defaultOutputFolder": {
  "type": "string",
  "default": "",
  "description": "Default folder path for downloaded Stitch assets (PNG/HTML). Relative to workspace root.",
  "scope": "resource"
},
"switchboard.statusBar.showDesignButton": {
  "type": "boolean",
  "default": false,
  "description": "Controls visibility of the Open Design Panel button on the status bar.",
  "scope": "window"
}
```

#### 5.3 Dependency
Add `@google/stitch-sdk` to `dependencies` in `package.json`:
```json
"@google/stitch-sdk": "^0.3.5"
```

## Verification Plan

### Automated Tests
- **Compilation check:** `npm run compile` (or `tsc --noEmit`) must pass with zero TypeScript errors across all modified `.ts` files. (Session directive: skip actual compilation step; plan assumes pre-compiled state.)
- **Webpack asset copy:** Verify `src/webview/design.html` and `src/webview/design.js` are emitted to `dist/webview/` by the existing `CopyWebpackPlugin` glob (`webpack.config.js:76–87`).
- **Fallback-path test:** `DesignPanelProvider._getHtml()` must resolve `design.html` from the fallback chain (`dist/webview/design.html` → `webview/design.html` → `src/webview/design.html`).

### Manual Verification Checklist
- [ ] Running `Switchboard: Open Design Panel` opens a webview panel titled `DESIGN`.
- [ ] The Design System tab loads and displays configured design folders correctly.
- [ ] The HTML Previews tab loads and displays configured HTML folders correctly; iframe preview works; zoom toolbar works.
- [ ] The Stitch tab shows a "Configure API Key" prompt when no key is set.
- [ ] After setting an API key, the Stitch tab lists projects from `stitch.projects()`.
- [ ] Generating a screen from a prompt returns a thumbnail and download URLs.
- [ ] Editing a previously generated screen (`stitchEdit`) succeeds because the `Screen` instance is cached in `_activeScreens`.
- [ ] Downloading PNG/HTML writes files to the configured output folder or prompts for a path.
- [ ] Downloaded PNG files are not corrupted (verify via `Buffer.from(await response.arrayBuffer())` before writing).
- [ ] The "Sync Project to Workspace" button loops through all project screens, writes each screen's HTML and PNG to `./.stitch/screens/`, and compiles a `DESIGN.md` manifest file.
- [ ] The Planning panel no longer shows Design System or HTML Previews tabs.
- [ ] The Planning panel's remaining tabs (Local, Online, Kanban, Tickets, Research, NotebookLM) continue to work without regression.
- [ ] The `implementation.html` sidebar shows the new Design quick-action button and opens the panel.
- [ ] The status bar Design button appears when enabled in settings.

## Key Design Decisions

1. **No shared CSS file:** The planning panel's CSS is deeply embedded in its HTML. Rather than extract a shared stylesheet (which would touch every panel), `design.html` will carry its own copy of the relevant CSS block. This is a deliberate trade-off for minimal blast radius. Future work could extract a shared `panel-base.css`.

2. **Stitch auth is API-key-based, not OAuth:** The user assumed OAuth, but the `@google/stitch-sdk` v0.3.5 only supports API keys (`STITCH_API_KEY`) or access tokens. The plan reflects this reality: a simple string setting, not an OAuth flow.

3. **LocalFolderService remains shared:** Both `PlanningPanelProvider` and `DesignPanelProvider` will instantiate `LocalFolderService` per workspace root. There is no need to migrate config files or split the service.

4. **Message passing, not direct SDK access from webview:** The Stitch SDK runs in the Node.js extension host, not the webview. All SDK calls go through `DesignPanelProvider._handleMessage()` to avoid CSP and module-loading issues in the webview sandbox.

5. **HTTP server logic may be extracted:** The mini HTTP server used for serving local HTML files in `PlanningPanelProvider` (`_htmlServers`) should be evaluated for extraction into a shared utility (e.g., `HtmlPreviewServerService`) so both providers can use it without duplicating code.

6. **Screen instances must be cached in extension host memory:** The Stitch SDK requires an active, in-memory `Screen` instance to call `.edit()` and `.variants()`. A string `screenId` sent from the webview is insufficient. `DesignPanelProvider` maintains a `_activeScreens` Map keyed by `screen.id` and clears it on `dispose()`.

7. **Binary assets require `arrayBuffer()` conversion:** PNG downloads fetched via `fetch()` must be processed as `response.arrayBuffer()` and wrapped with `Buffer.from(arrayBuffer)` before writing through `vscode.workspace.fs.writeFile`. Passing a string representation of binary data will corrupt the image.

## Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Removing design/HTML code from `planning.js` (7,282 lines) is error-prone | Medium | Do a surgical pass: grep for `design-`, `html-`, `tree-pane-design`, `tree-pane-html` identifiers and remove only those functions/listeners. Verify remaining six tabs still render and switch correctly. |
| Stitch SDK v0.3.5 is pre-1.0 and API may change | Low | Pin the version to `^0.3.5` and wrap all SDK calls in try/catch with user-friendly error messages. If the API changes, only `DesignPanelProvider.ts` needs updates. |
| Users with existing design/HTML configs see broken panels | High | The `LocalFolderService` config format and paths do not change. The new `DesignPanelProvider` reads the same `local-folder-config.json`. No migration needed. |
| Two providers watch the same folders (race conditions) | Low | Remove `_htmlFolderWatchers` and `_designFolderWatchers` from `PlanningPanelProvider` entirely (lines 66–69, 453–540). Only `DesignPanelProvider` will watch design/HTML folders. |
| Webview CSP issues with iframe src for HTML previews | Low | Continue using `srcdoc` or `blob:` URLs for HTML preview iframe content, or serve via the local HTTP server on `localhost` (existing server lifecycle at `PlanningPanelProvider.ts:5285–5432`, moved to `DesignPanelProvider`). The existing sandbox attributes (`allow-scripts`, `allow-same-origin` for srcdoc) remain. |
| `stitchEdit`/`stitchVariants` fail because `Screen` instance was garbage-collected or lost | Medium | `_activeScreens` Map caches instances by `screen.id`. Ensure the Map is cleared in `dispose()` to prevent memory leaks. Document that edits require the panel to remain open since generation. |
| PNG downloads are corrupted due to string conversion | Medium | Strictly use `response.arrayBuffer()` → `Buffer.from(arrayBuffer)` for all binary assets. Never pass a string representation of a PNG to `vscode.workspace.fs.writeFile`. |

## Files Changed

### New Files
- `src/services/DesignPanelProvider.ts`
- `src/webview/design.html`
- `src/webview/design.js`

### Modified Files
- `src/webview/planning.html` — remove design-content and html-preview-content tabs
- `src/webview/planning.js` — remove all design/HTML related handlers and state
- `src/services/PlanningPanelProvider.ts` — remove design/HTML watchers, message handlers, and state
- `src/extension.ts` — wire DesignPanelProvider, command, status bar, sidebar button
- `src/webview/implementation.html` — add Design quick-action button
- `src/services/TaskViewerProvider.ts` — add `openDesignPanel` message handler
- `package.json` — add command, settings, and `@google/stitch-sdk` dependency
- `package-lock.json` — updated by `npm install`

## Recommendation

**Send to Lead Coder**
