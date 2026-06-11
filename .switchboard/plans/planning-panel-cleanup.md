# Clean Up Design & HTML Preview Logic from Planning Panel

## Goal

Surgically remove the `design-content` and `html-preview-content` tabs and all associated logic from `src/webview/planning.html`, `src/webview/planning.js`, and `src/services/PlanningPanelProvider.ts` after the new `DesignPanel` has been created. Ensure the remaining six tabs (Local Docs, Online Docs, Kanban Plans, Tickets, Research, NotebookLM) continue to work without regression.

**Core Problem & Background:**

`src/webview/planning.html` (3,467 lines) and `src/webview/planning.js` (7,282 lines) are overloaded. The Design System and HTML Preview tabs contain substantial DOM, CSS, JavaScript, file watchers, and a mini HTTP server lifecycle that bloats the single-file architecture. Removing this logic reduces the planning panel's scope by ~30% and eliminates dead code after extraction to the dedicated `DesignPanel`.

## Metadata

**Tags:** frontend, refactor, cleanup
**Complexity:** 5

## User Review Required

- The `DESIGN SYSTEM` and `HTML PREVIEWS` buttons disappear from the Planning panel tab bar (exact lines: `planning.html:2927–2931`); users must open the dedicated Design panel via command palette, status bar, or the quick-action button in `implementation.html`.
- Existing design/HTML folder configurations in `local-folder-config.json` are preserved without migration, but users should verify the new Design Panel loads their folders correctly.

## Complexity Audit

### Routine
- Remove `<button>` elements from `#research-tab-bar` in `planning.html`.
- Remove `<div id="design-content">` and `<div id="html-preview-content">` blocks from `planning.html`.
- Remove CSS selectors specific to `#design-content`, `#html-preview-content`, and related sidebar/preview pane IDs.

### Complex / Risky
- Surgical removal of design/HTML-related functions, state, event listeners, and message handlers from `src/webview/planning.js` (7,282 lines) without regressing the remaining six tabs.
- Removing file watchers (`_setupHtmlFolderWatchers` at `PlanningPanelProvider.ts:453`, `_setupDesignFolderWatchers` at `PlanningPanelProvider.ts:497`), debounced refresh methods (`_sendHtmlDocsReady` at `PlanningPanelProvider.ts:3559`, `_sendDesignDocsReady` at `PlanningPanelProvider.ts:3638`), and the mini HTTP server lifecycle (`_htmlServers` / `_htmlServerCreationPromises` at `PlanningPanelProvider.ts:88–89`, server methods at `PlanningPanelProvider.ts:5285–5432`) from `PlanningPanelProvider.ts`.
- Ensuring shared state keys (`activeDocId`, `selectedEl`, `previewRequestId`, `activeDocContent`) in `planning.js` are not accidentally corrupted by removing design/html branches.

## Edge-Case & Dependency Audit

- **Race Conditions:** During the transition, both `PlanningPanelProvider` and `DesignPanelProvider` could theoretically watch the same folders if the cleanup is incomplete. Mitigation: remove `_htmlFolderWatchers` and `_designFolderWatchers` entirely from `PlanningPanelProvider` before the new provider starts; the `refreshSource` and folder add/remove handlers in `PlanningPanelProvider` (lines 1276–1356) must also be removed or rerouted.
- **Side Effects:** Users lose direct access to Design System and HTML Previews from the Planning panel. The `LocalFolderService` configuration format and paths do not change, so no data migration is needed.
- **Dependencies:** No upstream plan dependencies. Downstream dependency: `design-panel-creation.md` must be completed first so the Design Panel exists to receive the extracted functionality.

## Adversarial Synthesis

Key risks: surgical removal from a 7,282-line `planning.js` is error-prone and may leave orphaned state keys or event listeners that silently break remaining tabs; shared `state` keys (`activeDocId`, `selectedEl`, `previewRequestId`) are reused across tabs and must be audited before deletion. Mitigations: perform a grep-driven pass using identifiers `design-`, `html-`, `tree-pane-design`, `tree-pane-html`; validate after each cleanup pass by switching through all six remaining tabs.

## Proposed Changes

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

## Verification Plan

### Manual Verification Checklist
- [ ] The Planning panel no longer shows Design System or HTML Previews tabs.
- [ ] The Planning panel's remaining tabs (Local, Online, Kanban, Tickets, Research, NotebookLM) continue to work without regression.
- [ ] Tab switching between all six remaining tabs works correctly.
- [ ] Local Docs tree rendering, search, and preview still function.
- [ ] Online Docs tree rendering, search, and preview still function.
- [ ] No console errors in the Planning panel webview DevTools after cleanup.

## Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Removing design/HTML code from `planning.js` (7,282 lines) is error-prone | Medium | Do a surgical pass: grep for `design-`, `html-`, `tree-pane-design`, `tree-pane-html` identifiers and remove only those functions/listeners. Verify remaining six tabs still render and switch correctly. |
| Shared `state` keys (`activeDocId`, `selectedEl`) corrupted by partial removal | Medium | Before deleting any `state.*` keys, grep for every reference across all tabs. Ensure the remaining branches (local-folder, online, kanban) don't accidentally depend on removed design/html state. |
| Two providers watch the same folders (race conditions) | Low | Remove `_htmlFolderWatchers` and `_designFolderWatchers` from `PlanningPanelProvider` entirely (lines 66–69, 453–540). Only `DesignPanelProvider` will watch design/HTML folders. |

## Files Changed

### Modified Files
- `src/webview/planning.html` — remove design-content and html-preview-content tabs
- `src/webview/planning.js` — remove all design/HTML related handlers and state
- `src/services/PlanningPanelProvider.ts` — remove design/HTML watchers, message handlers, and state

## Recommendation

**Send to Coder**
