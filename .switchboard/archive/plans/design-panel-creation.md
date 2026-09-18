# Create the New Design Panel Webview and Provider

## Goal

Create a new, dedicated `DesignPanel` by building `src/webview/design.html`, `src/webview/design.js`, and `src/services/DesignPanelProvider.ts`. The panel must replicate the planning panel's dark theme and house three tabs: **Design System** (migrated from `planning.html`), **HTML Previews** (migrated from `planning.html`), and **Stitch** (new, integrating `@google/stitch-sdk` v0.3.5 for AI-generated UI screens).

**Core Problem & Background:**

`src/webview/planning.html` (3,467 lines, 141 KB) is overloaded with eight tabs. The Design System and HTML Preview tabs contain substantial DOM, CSS, and JavaScript that bloat the single-file architecture. Extracting them into a dedicated panel reduces planning-panel scope by ~30% and creates a clean surface for Stitch SDK integration.

## Metadata

**Tags:** frontend, backend, api, ui, feature, refactor
**Complexity:** 6

## User Review Required

- Stitch API key is user-supplied; no OAuth flow. User must provide key via VS Code settings (`switchboard.stitch.apiKey`) or an inline "Configure API Key" prompt in the Stitch tab.
- The new Design Panel is a net-new surface; users should verify their existing design/HTML folders load correctly.

## Complexity Audit

### Routine
- Copy CSS/theme blocks (`:root`, `@font-face`, `body.theme-claudify`, `.cyber-theme-enabled`) into new `src/webview/design.html` from `src/webview/planning.html`.
- Port `switchTab`, `applySidebarState`, tree rendering, and preview logic to `src/webview/design.js`.
- Add Stitch settings and `@google/stitch-sdk` dependency to `package.json`.
- Configure webpack to copy new webview files (already covered by `src/webview/*.html` / `*.js` glob at `webpack.config.js` lines 76–87).

### Complex / Risky
- Integrating `@google/stitch-sdk` v0.3.5 with async SDK calls (`project.generate()`, `screen.getHtml()`, `screen.getImage()`), temporary-URL asset downloads, and user-friendly error handling.
- Ensuring `_getHtml()` fallback path resolution works for `design.html` across packaged vs. development builds.
- Caching Stitch SDK `Screen` instances in `_activeScreens` so that `.edit()` and `.variants()` can be called later.

## Edge-Case & Dependency Audit

- **Security:** The Stitch API key must never be logged or exposed to the webview; it stays in the Node.js extension host.
- **Dependencies & Conflicts:** `@google/stitch-sdk` is a new runtime dependency. It requires either `STITCH_API_KEY` env var or `switchboard.stitch.apiKey` setting. `LocalFolderService` remains shared; both providers instantiate it per workspace root.
- **Memory leaks:** The `_activeScreens` Map caches SDK instances. It must be cleared in `dispose()`.

## Dependencies

- `design-panel-extraction-and-stitch-integration.md` — this plan is a follow-up to the parent plan that covers the full extraction.

## Adversarial Synthesis

Key risks: Stitch SDK v0.3.5 is a pre-1.0 Google library with an unstable API surface; `_getHtml` substitution must include `{{DESIGN_JS_URI}}` or the webview loads a blank panel silently; `_activeScreens` must cache real SDK instances, not plain objects, or `screen.edit()` will throw. Mitigations: pin SDK to `^0.3.5` with wrapped try/catch, mirror `PlanningPanelProvider._getHtml()` exactly with the new asset URI, and validate `_activeScreens.get(screenId).edit` is callable before caching.

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
- `dispose(): void` — dispose panel, all watchers, and clear `_activeScreens`.
- `_getHtml(webview: vscode.Webview): string` — identical fallback-path logic to `PlanningPanelProvider._getHtml()` but reads `design.html` and substitutes `{{DESIGN_JS_URI}}` pointing to `dist/webview/design.js`.
- `_setupHtmlFolderWatchers(): void` — file watchers for HTML folders.
- `_setupDesignFolderWatchers(): void` — file watchers for design folders.
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
- The `@google/stitch-sdk` does **not** use OAuth. It requires either an `apiKey` string or an `accessToken` + `projectId` pair.
- The provider should read `switchboard.stitch.apiKey` from VS Code settings. If empty, it falls back to the `STITCH_API_KEY` environment variable.
- If neither is available, the Stitch tab shows an inline "Configure API Key" input that writes to VS Code settings (via a message back to the extension host).

## Verification Plan

### Automated Tests
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

## Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Stitch SDK v0.3.5 is pre-1.0 and API may change | Low | Pin the version to `^0.3.5` and wrap all SDK calls in try/catch with user-friendly error messages. If the API changes, only `DesignPanelProvider.ts` needs updates. |
| `_getHtml` missing `{{DESIGN_JS_URI}}` substitution | High | Mirror `PlanningPanelProvider._getHtml()` exactly, adding `const designJsUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'dist', 'webview', 'design.js'));` and `htmlContent.replace(/\{\{DESIGN_JS_URI\}\}/g, designJsUri.toString())`. |
| `stitchEdit`/`stitchVariants` fail because `Screen` instance was garbage-collected or lost | Medium | `_activeScreens` Map caches instances by `screen.id`. Ensure the Map is cleared in `dispose()` to prevent memory leaks. Document that edits require the panel to remain open since generation. |
| PNG downloads are corrupted due to string conversion | Medium | Strictly use `response.arrayBuffer()` → `Buffer.from(arrayBuffer)` for all binary assets. Never pass a string representation of a PNG to `vscode.workspace.fs.writeFile`. |

## Files Changed

### New Files
- `src/services/DesignPanelProvider.ts`
- `src/webview/design.html`
- `src/webview/design.js`

### Modified Files
- `package.json` — add `@google/stitch-sdk` dependency
- `package-lock.json` — updated by `npm install`

## Recommendation

**Send to Coder**

## Review Findings
Reviewed 2026-06-11 (commit 6b62378). Core requirements verified: `_getHtml` fallback chain + all placeholder substitutions, API key never leaves the extension host (webview only receives a `configured` boolean), binary downloads use `arrayBuffer()`→`Buffer.from`, `_activeScreens` cached and cleared in `dispose()`, `stitchEdit`/`stitchVariants` throw on cache miss, sync writes `.stitch/screens/*` + `DESIGN.md` via `vscode.workspace.fs`, no confirm() dialogs anywhere. Fixed during review: webview-supplied filename now sanitized with `path.basename` in `stitchDownloadAsset` (path traversal); the dead `switchboard.stitch.defaultOutputFolder` and `defaultProjectId` settings are now consumed (output dir resolution + project pre-select); theme messages (`switchboardThemeChanged`/`cyberAnimationSetting`/`themeChanged`) previously had webview listeners but no sender — provider now sends initial theme on `ready` and registers change listeners; design.js theme handler rewritten to mirror planning.js semantics (was force-enabling cyber for all non-claudify themes and wiping body classes). Removed unused `os` import. Remaining risks: `@google/stitch-sdk` is pre-1.0 with `// @ts-ignore` on import (API drift lands at runtime); `stitchGenerate` without a projectId calls `stitch.generate(...)` which may not exist on the SDK root (error is caught and surfaced); verification was static only per session constraints — run `npm run compile` and the manual checklist before use.

### Post-compile addendum (2026-06-11)
`npm run compile` surfaced 7 errors, all in `DesignPanelProvider.ts`, all fixed and the build now compiles clean: (1) `@google/stitch-sdk` is ESM-only (no `require` export condition) — replaced the static import with a lazy `new Function('return import(...)')` dynamic import that webpack/TS cannot rewrite; (2) `LocalFolderService.readFile` does not exist — `fetchPreview` now strips the `folderIndex:` prefix from tree node ids, validates `sourceFolder` against the configured design/html folder sets with a traversal guard, and reads via `fs.promises.readFile` (this also fixes a latent broken-image-preview bug from joining the prefixed id into a path); (3) the SDK has no root-level `generate` — `stitchGenerate` now requires a selected project and errors cleanly otherwise; (4) `Screen` has no `name`/`deviceType` properties — read from `screen.data?.name/title/deviceType` with fallbacks; (5) `variants()` takes `{ variantCount }`, not `{ count }`. Projects are now also mapped to plain `{id, name}` objects before posting (Project instances don't survive postMessage serialization usefully). Remaining risk: the singleton SDK client initializes lazily on first use and caches the API key — changing the key mid-session requires a window reload to take effect.
