# Design Briefs Tab for Stitch Panel

## Metadata
**Complexity:** 6
**Tags:** frontend, backend, feature, ui

## Goal
Add a "Briefs" tab to the Design Panel (design.html) that lets users browse, create, edit, and delete local markdown design briefs, then insert selected briefs into Stitch prompt inputs as contextual text.

### Problem Context
The Stitch generation flow currently relies on raw prompt text with no structured way to incorporate design briefs. Users maintain design briefs as scattered markdown files but have no way to reference them inside the Stitch panel. This leads to repeated typing of context and inconsistent prompts.

### Root Cause
The Design Panel (design.html) only exposes: (1) Stitch generation, (2) HTML previews, (3) Image gallery, and (4) Design System docs. There is no local document management surface scoped specifically to design briefs, even though the LocalFolderService already supports arbitrary folder-backed file types.

## Requirements

### Functional
1. New "Briefs" tab in design.html tab bar alongside existing Stitch / HTML Previews / Images / Design System tabs.
2. Folder-backed storage: Uses LocalFolderService with a new briefsFolderPaths config array. Users add/remove folders via a "Manage Folders" button.
3. Sidebar tree: Lists brief files from configured folders, grouped by source folder, with search filtering.
4. Preview pane: Renders selected brief as markdown. Supports Edit / Save / Cancel.
5. CRUD: Create new brief, edit existing, delete (with confirmation). All backed by LocalFolderService file ops.
6. Stitch prompt injection: A button near #stitch-prompt-input opens a dropdown of available briefs. On select, appends the brief text at the end of the prompt.
7. No external sync: No ClickUp/Linear/Notion integration. Purely local.

### Non-Functional
- Reuse existing CSS / layout patterns from Local Docs and Design System tabs to avoid visual drift.
- Use the same postMessage ↔ extension host ↔ LocalFolderService architecture already used by PlanningPanelProvider for local docs.
- Maintain state persistence across panel reloads via vscode.setState / vscode.getState.
## User Review Required
- Confirm tab order: Briefs placed immediately before Stitch tab (left of Stitch) so it sits adjacent to the generation flow.
- Confirm brief injection template wording: "Here is the design brief for this task:" — acceptable or needs adjustment?
- Confirm whether New Brief should auto-create the file in the first configured folder or prompt user to choose among configured folders.

## Complexity Audit

### Routine
- Add briefsFolderPaths to LocalFolderPathsConfig and mirror getter/setter/list methods in LocalFolderService.
- Add tab button and tab content div in design.html using cloned markup from Design System tab.
- Add CSS selectors for briefs pane elements (reuse existing selector groups).
- Add state variables, render function, and message handlers in design.js.
- Add _sendBriefsDocsReady() and _setupBriefsFolderWatchers() in DesignPanelProvider.
- Add listBriefsFolders / addBriefsFolder / removeBriefsFolder message cases in DesignPanelProvider._handleMessage.
- Add briefsDocsReady / briefsFoldersListed cases in design.js message switch.
- Add briefs to requestAllFolders() and folderModalScope handling in design.js.

### Complex / Risky
- saveFileContent and fetchPreview validation: The existing saveFileContent handler validates write paths against getDesignFolderPaths() and getHtmlFolderPaths() only. Briefs files must also be validated against getBriefsFolderPaths(). Similarly, fetchPreview restricts allowed folders to design/html. Briefs previews must be added to the allowed set. Missing these gates blocks CRUD entirely.
- _updateWebviewRoots local resource roots: The webview localResourceRoots must include briefs folder URIs or markdown image references inside briefs will break.
- Stitch prompt brief-block replacement regex: Must reliably detect and replace an existing brief block without false positives.
- Dirty-state warning on tab switch: The existing design.js has no generic "dirty check before navigate" pattern.
- File watcher lifecycle: _setupBriefsFolderWatchers must dispose old watchers in disposeWatchers() and re-register on workspace changes.

## Edge-Case & Dependency Audit

### Race Conditions
- Rapid folder add/remove: Ensure _setupBriefsFolderWatchers is called after every add/remove.
- Save during file watcher refresh: Acceptable — webview receives briefsDocsReady after saveFileContentResult and reconciles.

### Security
- Path traversal in brief file ops: deleteFile() and fetchDocContent() already validate sourceFolder against configured paths. Briefs wrappers must use the same validation against briefsFolderPaths.
- Arbitrary file write via saveFileContent: Adding briefs to the allowed list does not expand attack surface beyond what exists for design/html folders.
- Markdown XSS in preview: Brief previews use existing renderMarkdown() utility. No new XSS surface.

### Side Effects
- Config file growth: Adding briefsFolderPaths to .switchboard/local-folder-config.json is forward-compatible. Old code ignores unknown keys. No migration needed.
- Panel state keys: Adding briefs and briefs.root to the tabKeys array means persisted state will grow. No side effects for users without briefs folders configured.

### Dependencies & Conflicts
- No external dependencies beyond existing VS Code APIs.
- Conflicts unlikely: touches LocalFolderService (additive only), DesignPanelProvider (new message cases only), and webview files (new tab only).
- Dependency on existing folder-modal being generic — it already scopes by folderModalScope, so adding briefs is a one-line scope value change.
## Dependencies
- None — self-contained feature within existing Design Panel architecture.

## Adversarial Synthesis

Key risks: (1) saveFileContent and fetchPreview path validation gates forgetting to include briefs folders, which would silently block all brief CRUD and previews; (2) dirty-state loss on tab switch because no generic unsaved-changes guard exists in design.js; (3) the prompt-injection regex failing to replace an existing brief block if the user edits the header text, leading to duplicate blocks. Mitigations: explicitly add getBriefsFolderPaths() to the allowed-paths arrays in both saveFileContent and fetchPreview handlers; accept dirty-state loss as a known limitation or implement a lightweight beforeTabSwitch guard; make the replacement regex anchor on the fixed header line and consume to end-of-input.

## Proposed Changes

### src/services/LocalFolderService.ts

Context: LocalFolderService manages per-workspace-root folder configuration. It already supports designFolderPaths, imagesFolderPaths, stitchFolderPaths, etc. Briefs needs the same treatment.

Logic & Implementation:
1. In LocalFolderPathsConfig interface (line ~13), add briefsFolderPaths: string[] after stitchFolderPaths.
2. In loadFolderPathsConfig() (line ~94), include briefsFolderPaths: parsed.briefsFolderPaths || [] in the returned object.
3. In saveFolderPathsConfig() (line ~130), no change needed — it writes the whole config object.
4. Add getBriefsFolderPaths(): string[] mirroring getDesignFolderPaths() (line ~672). Include briefsFolderPaths in the _folderPathsCache fallback read. No migration flag needed.
5. Add getBriefsFolderPath(): string returning getBriefsFolderPaths()[0] ?? ''.
6. Add addBriefsFolderPath() and removeBriefsFolderPath() mirroring addDesignFolderPath / removeDesignFolderPath (line ~716).
7. Add listBriefsFiles() mirroring listDesignFiles() (line ~971). Scan briefsFolderPaths for files matching _isTextFile() (.md, .txt, .markdown, .rst, .adoc). Reuse _scanFolder().
8. Update loadConfig() (line ~73) to strip briefsFolderPaths from the returned LocalFolderConfig.
9. Update _folderPathsCache fallback reads inside getFolderPaths(), getHtmlFolderPaths(), getDesignFolderPaths(), getImagesFolderPaths(), and getStitchFolderPaths() to include briefsFolderPaths.

Edge Cases:
- Empty briefsFolderPaths → listBriefsFiles() returns [] (same as other folder types).
- Duplicate paths in config → getBriefsFolderPaths() deduplicates via seen Set.
- Title extraction failures → non-critical, file still listed without a title.
### src/services/DesignPanelProvider.ts

Context: DesignPanelProvider hosts the Design Panel webview and routes all postMessage traffic.

Logic & Implementation:
1. Add private fields: _briefsFolderWatchers, _briefsDocsDebounce.
2. In disposeWatchers(), dispose _briefsFolderWatchers.
3. In open(), after _setupImagesFolderWatchers(), call _setupBriefsFolderWatchers().
4. In _updateWebviewRoots(), inside the workspace-root loop, push getBriefsFolderPaths() into folderUris. Critical for markdown image resolution.
5. In case ready, add briefs and briefs.root to tabKeys.
6. Add _setupBriefsFolderWatchers() mirroring _setupDesignFolderWatchers(). Debounce to _sendBriefsDocsReady().
7. Add _sendBriefsDocsReady() mirroring _sendDesignDocsReady(). Posts briefsDocsReady to webview.
8. Add message handlers: listBriefsFolders, addBriefsFolder, removeBriefsFolder, createBrief, deleteBrief.
9. CRITICAL FIX in saveFileContent: Expand allAllowedPaths to include getBriefsFolderPaths().
10. CRITICAL FIX in fetchPreview: Expand allowedFolders to include getBriefsFolderPaths().
11. In case ready, after _sendImagesDocsReady(), add await this._sendBriefsDocsReady().

Edge Cases:
- _sendBriefsDocsReady debounce cancels prior timer.
- createBrief duplicate title: overwrite acceptable for MVP.
- deleteBrief on removed folder: deleteFile() rejects. Acceptable.
### src/webview/design.html

Context: The tab bar has four buttons; the container has four tab-content divs. Each tab follows the same two-pane layout.

Logic & Implementation:
1. In #research-tab-bar (line ~3483), add <button class="research-tab-btn" data-tab="briefs">BRIEFS</button> immediately before the existing Stitch button.
2. Add #briefs-content tab div inside .container. Use cloned two-pane layout:
   - Controls strip: #briefs-workspace-filter, #btn-manage-folders-briefs, #btn-new-brief, #briefs-docs-search, #status-briefs
   - content-row with #tree-pane-briefs and #preview-pane-briefs
   - Inside #preview-pane-briefs: #markdown-preview-briefs, #markdown-editor-briefs (textarea, hidden)
3. Reuse #folder-modal — it already scopes by folderModalScope variable in JS. No new modal markup needed.
4. In CSS, add #briefs-content, #tree-pane-briefs, #preview-pane-briefs, #markdown-preview-briefs, #markdown-editor-briefs to existing grouped selectors so they inherit the same styling.

Edge Cases:
- #briefs-content without active class → hidden by default.
- #markdown-editor-briefs starts display: none.

### src/webview/design.js

Context: design.js holds all webview-side state, rendering, and message handling.

Logic & Implementation:
1. Add to state object (line ~7):
   - briefsWorkspaceRootFilter: ''
   - briefsDocsSearch: ''
   - briefsFolderPathsByRoot: persistedState.briefsFolderPathsByRoot || {}
   - _lastBriefsDocsMsg: null
   - activeBriefSourceId: null
   - activeBriefDocId: null
   - briefEditMode: false
2. In switchTab() (line ~123), add briefs tab to generic tab switch logic (it already uses btn.dataset.tab and content.id === tabName + '-content').
3. Add renderBriefsDocs(rootEntry) mirroring renderDesignDocs() (line ~415). Use #tree-pane-briefs. Filter nodes by briefsDocsSearch.
4. Add briefs workspace filter change listener mirroring existing filter listeners.
5. Add briefs search input listener.
6. In loadDocumentPreview() (line ~742), add else if (sourceId === 'briefs-folder') branch.
7. In handlePreviewReady() (line ~864), add else if (sourceId === 'briefs-folder') branch.
8. Add briefs edit/save/cancel controls mirroring enterDesignEditMode / exitDesignEditMode (line ~1063).
9. Wire New Brief: prompt for title, post { type: 'createBrief', sourceFolder, title }.
10. Wire Delete: confirmation dialog, then post { type: 'deleteBrief', docId, sourceFolder }.
11. Stitch prompt injection (line ~1165 area): Add "Add Brief" button near #stitch-prompt-input. On click, open dropdown from _lastBriefsDocsMsg nodes. On select, append brief block:
    ```
    Here is the design brief for this task:
    <brief content>
    ```
    If existing brief block detected via regex /\n*Here is the design brief for this task:[\s\S]*$/, replace instead of append.
12. In message switch (line ~2070), add cases for briefsDocsReady, briefsFoldersListed, briefSaved, briefDeleted.
13. In requestAllFolders() (line ~2566), add listBriefsFolders postMessage.
14. In openFoldersModal() (line ~2608), add briefs scope title.
15. In renderFolderListModal() (line ~2624), add briefs branch.
16. In folder modal add/remove handlers (line ~2762 and ~2673), add briefs branches.
17. In applySidebarState() (line ~2781), add briefs row collapse restoration.

Edge Cases:
- Dirty state on tab switch: Accept for MVP or add beforeTabSwitch guard.
- Empty briefs list: Show empty-state div.
- Brief content fetch for injection: Use cached content if available, else fetch via fetchPreview.

## Verification

1. Open Design Panel → Briefs tab → Manage Folders → add a folder containing .md files → files appear in sidebar.
2. Click a brief → preview renders as markdown.
3. Click Edit → textarea appears → modify → Save → file writes to disk, preview updates.
4. Click New Brief → enter title → new .md file created, appears in list.
5. Click Delete → confirmation → file removed.
6. Switch to Stitch tab → click "Add Brief" → dropdown shows briefs → select one → prompt input appends brief text.
7. Select a different brief → existing brief block in prompt is replaced, not duplicated.
8. Reload VS Code: window → Briefs tab state restores.

## Recommendation

**Send to Coder.** Complexity 6. The plan follows well-established patterns across four files, but requires careful attention to three critical validation gates (saveFileContent, fetchPreview, _updateWebviewRoots) and correct file watcher lifecycle management. A mid-level coder can execute this with the line-number references provided.
