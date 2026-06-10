# Extract Design & HTML Previews to a Dedicated Design Panel, Add Google Stitch SDK Integration

## Metadata
**Complexity:** 8
**Tags:** frontend, backend, api, ui, feature, refactor

---

## Problem & Context

`src/webview/planning.html` is overloaded at 3,467 lines / 141 KB. It currently hosts eight tabs (Local Docs, Online Docs, Kanban Plans, HTML Previews, Tickets, Research, Design System, NotebookLM). The **Design System** and **HTML Previews** tabs contain substantial DOM, CSS, and JavaScript logic that bloats the single-file architecture, slows load time, and couples design-related workflows with research/planning workflows.

The user wants these tabs extracted into a **standalone `design.html` panel** styled identically to the planning panel, plus a new **Stitch** tab that integrates Google's `@google/stitch-sdk` for AI-generated UI screens.

## Goals

1. **Extract** the `design-content` and `html-preview-content` tabs from `planning.html` / `planning.js` / `PlanningPanelProvider.ts` into a new, dedicated `DesignPanel`.
2. **Create** `design.html` and `design.js` webview files that replicate the planning panel's dark theme, tab bar, sidebar+preview layout, and all existing Design System / HTML Previews functionality.
3. **Integrate** `@google/stitch-sdk` (v0.3.5) into the new panel with a **Stitch** tab for generating UI screens, downloading PNGs/HTML, and opening/managing Stitch projects.
4. **Register** the new panel with a VS Code command, a status bar button, and a quick-action button in `implementation.html`.
5. **Preserve** all existing user configurations (design folder paths, HTML folder paths) without requiring migration — these are stored in `local-folder-config.json` and consumed by `LocalFolderService`.

## Root Cause Analysis

- **Single-file bloat:** `planning.html` embeds CSS for eight distinct workflows. Any change to one tab risks regressing others.
- **Provider overload:** `PlanningPanelProvider.ts` (5,432 lines) handles file watchers, message routing, and preview logic for design docs, HTML files, local docs, online docs, kanban plans, and tickets. Splitting the design/HTML surface area off reduces its scope by ~30%.
- **Missing SDK integration:** There is currently no bridge between Switchboard and Google Stitch. The `@google/stitch-sdk` package exposes a high-level object API (`stitch.project().generate().getHtml()`) that is ideal for a VS Code webview panel but requires a dedicated provider to manage async SDK calls and temporary-URL downloads.

## Plan

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
  - Stitch: project selector dropdown, prompt input, device-type selector (DESKTOP / MOBILE / TABLET / AGNOSTIC), generate button, screen gallery with thumbnail + "Download PNG" / "Download HTML" buttons, edit/variant controls.
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
  - `stitchGenerate` — call `project.generate(prompt, deviceType)`, then `screen.getHtml()` + `screen.getImage()`, post `stitchScreenReady`.
  - `stitchEdit` — call `screen.edit(prompt)`, post updated screen.
  - `stitchVariants` — call `screen.variants(prompt, options)`, post variant array.
  - `stitchDownloadAsset` — `fetch()` the temporary URL, write to disk using VS Code `workspace.fs` or prompt for path.
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
- **Remove** the `DESIGN SYSTEM` and `HTML PREVIEWS` buttons from `#research-tab-bar`.
- **Remove** the entire `<div id="design-content">` block (lines ~3155–3200).
- **Remove** the entire `<div id="html-preview-content">` block (lines ~3202–3258).
- **Remove** CSS selectors specific to `#design-content`, `#html-preview-content`, `#tree-pane-design`, `#tree-pane-html`, `#preview-pane-design`, `#preview-pane-html`, and related `cyber-theme-enabled` rules.
- **Remove** the `folder-modal-html` modal block if it exists only for HTML previews.

#### 3.2 `src/webview/planning.js`
- **Remove** all design-docs-related functions: `handleDesignDocsReady`, `renderDesignDocs`, `renderDesignFolderListModal`, `populateDesignFolderPicker`, etc.
- **Remove** all HTML-preview-related functions: `handleHtmlDocsReady`, `renderHtmlDocs`, `renderHtmlFolderListModal`, `loadDocumentPreview` branches for `html-folder`, `serveHtmlFile`, etc.
- **Remove** event listeners on `#design-workspace-filter`, `#html-workspace-filter`, `#design-docs-search`, `#html-docs-search`, design/html sidebar toggle buttons.
- **Remove** `state.designWorkspaceRootFilter`, `state.htmlWorkspaceRootFilter`, `state.designDocsSearch`, `state.htmlDocsSearch`, `state._lastDesignDocsMsg`, `state._lastHtmlDocsMsg`.
- **Update** `switchTab` to remove `design` and `html-preview` branches.
- **Update** `applySidebarState` calls to remove design/html entries.

#### 3.3 `src/services/PlanningPanelProvider.ts`
- **Remove** private fields: `_htmlFolderWatchers`, `_htmlDocsDebounce`, `_designFolderWatchers`, `_designDocsDebounce`, `_activeDesignDocSourceId`, `_activeDesignDocId`, `_activeDesignSystemDocSourceId`, `_activeDesignSystemDocId`, `_htmlServers`, `_htmlServerCreationPromises`.
- **Remove** methods: `_setupHtmlFolderWatchers()`, `_setupDesignFolderWatchers()`, `_sendHtmlDocsReady()`, `_sendDesignDocsReady()`, `_serveHtmlFile()`, all HTML-server lifecycle methods.
- **Remove** `_handleMessage` branches for design/HTML document loading, HTML server requests, design doc active-state messages, etc.
- **Remove** `_sendActiveDesignDocState()`.
- **Update** `_getHtml()` to no longer reference design/HTML-specific content (this is mostly about reducing the HTML file size, but the provider method itself stays structurally the same).

### Phase 4: Wire the New Panel into the Extension Host

#### 4.1 `src/extension.ts`
- **Import** `DesignPanelProvider`.
- **Instantiate** after `planningPanelProvider`:
  ```typescript
  const designPanelProvider = new DesignPanelProvider(
      context.extensionUri,
      () => kanbanProvider!.getCurrentWorkspaceRoot() ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
  );
  context.subscriptions.push(designPanelProvider);
  ```
- **Register command:**
  ```typescript
  const openDesignPanelDisposable = vscode.commands.registerCommand(
      'switchboard.openDesignPanel',
      async () => { await designPanelProvider.open(); }
  );
  context.subscriptions.push(openDesignPanelDisposable);
  ```
- **Status bar item:** Add `designStatusBarItem` (priority 93, right-aligned) with `$(paintcan)` or `$(symbol-color)` icon, tooltip "Open Design Panel", command `switchboard.openDesignPanel`.
- **Update** `updateStatusBarVisibility()` to include a `switchboard.statusBar.showDesignButton` toggle.
- **Add** `kanbanProvider!.setDesignPanelProvider(designPanelProvider)` if the kanban provider needs to reference it (optional, only if cross-panel coordination is needed).
- **Add** configuration change listener: if `switchboard.stitch.apiKey` changes, post a message to the design panel to refresh the Stitch tab auth state.

#### 4.2 `src/webview/implementation.html`
In the Quick Actions section (around line 1893), add a fourth button:
```html
<button id="btn-quick-design" class="secondary-btn is-teal" style="flex:1">design</button>
```
And its event listener:
```javascript
const btnQuickDesign = document.getElementById('btn-quick-design');
if (btnQuickDesign) btnQuickDesign.addEventListener('click', () => vscode.postMessage({ type: 'openDesignPanel' }));
```

#### 4.3 `src/services/TaskViewerProvider.ts`
Add a handler for the `openDesignPanel` message type that executes the command:
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

### Phase 6: Build & Verification Checklist

- [ ] `npm install` picks up `@google/stitch-sdk`.
- [ ] `npm run compile` succeeds with no TypeScript errors.
- [ ] Webpack copies `src/webview/design.html` and `src/webview/design.js` into `dist/webview/`.
- [ ] `DesignPanelProvider._getHtml()` resolves `design.html` from the fallback path chain.
- [ ] Running `Switchboard: Open Design Panel` opens a webview panel titled `DESIGN`.
- [ ] The Design System tab loads and displays configured design folders correctly.
- [ ] The HTML Previews tab loads and displays configured HTML folders correctly; iframe preview works; zoom toolbar works.
- [ ] The Stitch tab shows a "Configure API Key" prompt when no key is set.
- [ ] After setting an API key, the Stitch tab lists projects from `stitch.projects()`.
- [ ] Generating a screen from a prompt returns a thumbnail and download URLs.
- [ ] Downloading PNG/HTML writes files to the configured output folder or prompts for a path.
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

## Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Removing design/HTML code from `planning.js` (335 KB) is error-prone | Medium | Do a surgical pass: grep for `design-`, `html-`, `tree-pane-design`, `tree-pane-html` identifiers and remove only those functions/listeners. Run the existing test suite afterward. |
| Stitch SDK v0.3.5 is young and API may change | Low | Pin the version to `^0.3.5` and wrap all SDK calls in try/catch with user-friendly error messages. If the API changes, only `DesignPanelProvider.ts` needs updates. |
| Users with existing design/HTML configs see broken panels | High | The `LocalFolderService` config format and paths do not change. The new `DesignPanelProvider` reads the same `local-folder-config.json`. No migration needed. |
| Two providers watch the same folders (race conditions) | Low | Remove the watchers from `PlanningPanelProvider` entirely. Only `DesignPanelProvider` will watch design/HTML folders. |
| Webview CSP issues with iframe src for HTML previews | Low | Continue using `srcdoc` or `blob:` URLs for HTML preview iframe content, or serve via the local HTTP server on `localhost`. The existing pattern in `PlanningPanelProvider` works. |

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
