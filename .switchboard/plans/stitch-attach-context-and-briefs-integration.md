# Stitch: Replace Image-to-Prompt with Attach Context + Briefs Integration

## Metadata

**Complexity:** 6
**Tags:** frontend, backend, ui, ux, refactor, feature

## Problem Analysis

### Background

The Stitch tab in `design.html` has an "Image to Prompt" button that opens a modal for uploading images and generating a meta-prompt text to copy to clipboard. This feature is entirely client-side — it never interacts with the Stitch SDK. The Stitch SDK's `project.upload(filePath)` method is the proper way to upload reference assets (PNG/JPG/WEBP/HTML) to a Stitch project.

Additionally, the existing "Add Brief" button in the Stitch generation strip uses a dropdown that renders upward (`bottom: 100%`) and clips outside the webview bounds, making it unusable.

The user wants:
1. Remove "Image to Prompt" entirely — replaced by a `+` attach context button next to the prompt input
2. A bridge between the Briefs tab and the Stitch tab — both a "Send to Stitch" action on the Briefs tab and an optional brief attachment step in the Stitch "New Project" flow
3. Remove the buggy "Add Brief" dropdown from the Stitch generation strip

### Root Cause

The "Image to Prompt" feature was built as a workaround before the SDK's `upload()` method was available. It generates a text prompt from images and copies it to the clipboard — a manual, multi-step process. The SDK now supports direct file uploads, making this obsolete.

The "Add Brief" dropdown is buggy because it uses `position: absolute; bottom: 100%` which renders outside the webview's clipping bounds.

## Goal

Replace the obsolete "Image to Prompt" workflow with a streamlined attach-context `+` button, and create a proper Briefs → Stitch bridge with two entry points.

## User Review Required

Yes — this plan removes a user-facing feature ("Image to Prompt") and replaces the "Add Brief" dropdown with a new attach-context flow. The UX changes should be reviewed before implementation to confirm the replacement workflows match user expectations.

## Complexity Audit

### Routine
- Removing HTML elements (button, modal, dropdown) and their associated CSS — straightforward deletion
- Removing JS variable declarations, functions, and event listeners for the old Image-to-Prompt feature — mechanical cleanup
- Removing the `fetchBriefForInjection` backend handler — single case block deletion
- Adding a new `+` button and chips container to the HTML generation strip — follows existing `strip-btn` pattern
- Adding chip CSS — small, self-contained style block
- Adding `stitchPickAttachFiles` backend handler — standard `showOpenDialog` pattern already used elsewhere in the file
- Adding "Send to Stitch" button to the Briefs controls strip — follows existing `strip-btn` pattern

### Complex / Risky
- **`stitchGenerate` modification**: Injecting upload logic before generate changes the critical generation path. Upload failures must not block generation — error handling is non-trivial
- **`stitchCreateProject` modification**: Adding a multi-step quick pick flow to an existing operation-locked handler. Must handle cancellation at each step without leaving the lock held
- **Brief → Stitch state bridge**: The webview JS must look up brief metadata from `_lastBriefsDocsMsg` nodes (title not stored in state), construct the correct `docId` format, and coordinate tab switching + project selection + prompt injection across two message handlers
- **`stitchSendBrief` handler**: Must post `stitchProjectsReady` (so the dropdown updates) AND `stitchBriefInjected` (so the prompt populates) in the correct order — missing either breaks the flow

## SDK Constraints

- `project.upload(filePath: string)` — accepts a **file path on disk**, supports: `.png`, `.jpg`, `.jpeg`, `.webp`, `.html`, `.htm`. Returns `Screen[]`.
- `project.generate(prompt: string, deviceType?, modelId?)` — text-only, no reference parameter.
- `DesignTheme.designMd` — string field for markdown content in design systems. Semantically scoped to visual style rules, not general context.
- Webview `File` objects do not expose disk paths. File selection must go through the extension host via `vscode.window.showOpenDialog` to get real file paths for `upload()`.

## Proposed Changes

### Phase 1: Remove "Image to Prompt" and "Add Brief" Dropdown

#### 1.1 HTML — Remove "Image to Prompt" button
- **File:** `src/webview/design.html`
- Remove the `<button id="btn-stitch-prompt-generator">` at line 3804
- Remove the entire `<!-- Image to Prompt Modal -->` block at lines 3893-3908

#### 1.2 HTML — Remove "Add Brief" dropdown
- **File:** `src/webview/design.html`
- Remove the `<div class="dropdown-container">` wrapping `btn-stitch-add-brief` and `stitch-briefs-dropdown-menu` at lines 3805-3813

#### 1.3 HTML — Remove orphaned CSS
- **File:** `src/webview/design.html`
- Remove `.stitch-generator-thumbnails`, `.stitch-generator-thumb-container`, `.stitch-generator-thumb`, `.stitch-generator-thumb-remove` styles (lines 3396-3437)
- Keep `.stitch-prompt-modal` styles — they're shared with the Design System CRUD modal and Apply modal (those reuse the class)

#### 1.4 JS — Remove Image-to-Prompt logic
- **File:** `src/webview/design.js`
- Remove variable declarations: `btnStitchPromptGenerator`, `stitchPromptModal`, `btnCloseStitchGenerator`, `stitchGeneratorInput`, `stitchGeneratorImageInput`, `stitchGeneratorThumbnails`, `btnCopyStitchPrompt` (lines 1465-1471)
- Remove state fields: `stitchGeneratorOpen` (line 57), `stitchGeneratorImages` (line 58)
- Remove functions: `updateCopyButtonState`, `openStitchGenerator`, `closeStitchGenerator`, `clearStitchGeneratorImages`, `handleStitchGeneratorImagesChange`, `renderThumbnail`, `generateStitchMetaPrompt`, `copyStitchPromptToClipboard` (lines 1523-1671)
- Remove the `btnStitchPromptGenerator.disabled` line in `setStitchBusy` (line 1519)
- Remove the `updateCopyButtonState()` call in `setStitchBusy` (line 1520)
- Remove the `stitchGeneratorOpen` check in the Escape key handler (lines 2042-2044)
- Remove all event listener wiring for the prompt generator (lines 2049-2071)

#### 1.5 JS — Remove "Add Brief" dropdown logic
- **File:** `src/webview/design.js`
- Remove the `btnAddBrief`, `briefDropdownMenu`, `briefListContainer` variable declarations and event listener block in `initStitchControls` (lines 3176-3222)
- Remove the `briefContentForInjectionReady` message handler (lines 2641-2657) — this logic will be replaced by the new attach context flow

#### 1.6 Backend — Remove `fetchBriefForInjection` handler
- **File:** `src/services/DesignPanelProvider.ts`
- Remove the `case 'fetchBriefForInjection'` block (lines 2247-2278) — replaced by new handlers in Phase 3

### Phase 2: Add `+` Attach Context Button to Stitch Generation Strip

#### 2.1 HTML — Add `+` button and chips container
- **File:** `src/webview/design.html`
- In the generation strip (after the prompt input, before the device select), add:
  - A `+` button: `<button id="btn-stitch-attach" class="strip-btn" title="Attach reference files (images, HTML, markdown)">+</button>`
  - A hidden file input is NOT used — file selection goes through the extension host
  - A chips container below the generation strip: `<div id="stitch-attached-files" style="display: none; ..."></div>` — shows filename chips with remove buttons

#### 2.2 CSS — Chip styles
- **File:** `src/webview/design.html`
- Add `.stitch-attach-chip` style: small pill with filename, file type icon, and `×` remove button. Match existing `strip-btn` aesthetic.

#### 2.3 JS — Attach context state and UI
- **File:** `src/webview/design.js`
- Add `state.stitchAttachedFiles = []` — array of `{ path, name, type }` where type is `'image'`, `'html'`, or `'markdown'`
- `+` button click → `vscode.postMessage({ type: 'stitchPickAttachFiles' })`
- Handle `stitchAttachedFilesPicked` message → render chips in the container
- Chip remove button → remove from `state.stitchAttachedFiles`, re-render
- On Generate click: include `attachedFiles` array in the `stitchGenerate` message
- **Clarification:** Add `btnStitchAttach.disabled = busy` to `setStitchBusy()` (after line 1517, alongside the other button disable lines) so the `+` button is disabled during generation. Without this, users can trigger the file picker mid-operation.
- **Clarification:** Add `const btnStitchAttach = document.getElementById('btn-stitch-attach');` to the variable declarations near line 1465 (replacing the removed `btnStitchPromptGenerator` declaration)

#### 2.4 Backend — File picker handler
- **File:** `src/services/DesignPanelProvider.ts`
- Add `case 'stitchPickAttachFiles'`:
  - Call `vscode.window.showOpenDialog` with `canSelectMany: true`, filters for `['png', 'jpg', 'jpeg', 'webp', 'html', 'htm', 'md']`
  - For each selected path, determine type: images (png/jpg/jpeg/webp), html (html/htm), markdown (md)
  - Post back `{ type: 'stitchAttachedFilesPicked', files: [{ path, name, type }] }`

#### 2.5 Backend — Upload references on Generate
- **File:** `src/services/DesignPanelProvider.ts`
- Modify `case 'stitchGenerate'` (line 2280):
  - Before calling `projectInstance.generate()`, check `message.attachedFiles`
  - For each file with type `image` or `html`: call `await projectInstance.upload(filePath)` — upload as reference assets to the project
  - For each file with type `markdown`: read file contents with `fs.promises.readFile(filePath, 'utf8')` and append to the prompt string with a context header (e.g., `\n\n--- Design Context ---\n{content}\n---`)
  - Then proceed with `projectInstance.generate(augmentedPrompt, deviceType, modelId)`
  - If upload fails, log error but continue with generate (don't block generation for a failed reference upload)

### Phase 3: Briefs → Stitch Bridge

#### 3.1 HTML — "Send to Stitch" button on Briefs tab
- **File:** `src/webview/design.html`
- Add a button to the Briefs controls strip (line 3515-3527): `<button id="btn-send-brief-to-stitch" class="strip-btn" disabled>Send to Stitch</button>`
- Position after "Edit" button (line 3522), before the search input (line 3525)
- Enabled only when a brief is selected in the sidebar
- **Clarification:** The enable/disable logic must be added to `updateBriefDocControls()` in `src/webview/design.js` (line 1289). Currently this function enables/disables `btn-edit-brief` and `btn-delete-brief` based on `hasDoc`. Add: `const btnSendToStitch = document.getElementById('btn-send-brief-to-stitch'); if (btnSendToStitch) btnSendToStitch.disabled = !hasDoc || state.briefEditMode;`

#### 3.2 JS — "Send to Stitch" handler
- **File:** `src/webview/design.js`
- The currently selected brief is tracked in existing state fields:
  - `state.activeBriefDocId` — format is `${folderIndex}:${relativePath}` (the full docId used by tree nodes)
  - `state.activeDocSourceFolder` — the source folder path
  - Brief title is NOT in state — look it up from `state._lastBriefsDocsMsg.nodes` by matching `node.id === state.activeBriefDocId`
- On "Send to Stitch" click:
  - Look up the brief title: `const briefNode = (state._lastBriefsDocsMsg?.nodes || []).find(n => n.id === state.activeBriefDocId); const briefTitle = briefNode?.title || briefNode?.name || 'Untitled';`
  - Send `vscode.postMessage({ type: 'stitchSendBrief', docId: state.activeBriefDocId, briefTitle, sourceFolder: state.activeDocSourceFolder })`
  - Show status: "Creating Stitch project from brief…"
- **Clarification:** The message sends `docId` (not `relativePath`) because the backend path resolution code strips the `${folderIndex}:` prefix from `docId` to get `relativePath` — same pattern as the old `fetchBriefForInjection` handler and `fetchPreview` handler

#### 3.3 Backend — `stitchSendBrief` handler
- **File:** `src/services/DesignPanelProvider.ts`
- Add `case 'stitchSendBrief'`:
  1. Read the brief file contents using the same path resolution as the old `fetchBriefForInjection` handler (lines 2247-2278):
     - Extract `relativePath` from `message.docId` by stripping the `${folderIndex}:` prefix
     - Resolve `sourceFolder` and verify it's a configured briefs folder via `_getLocalFolderService(root).getBriefsFolderPaths()`
     - Verify the resolved path stays within the source folder (path traversal guard)
     - Read with `fs.promises.readFile(absPath, 'utf8')`
  2. Show `vscode.window.showInputBox` for project title (default: `message.briefTitle`)
  3. If user dismisses the input box, return — no project created
  4. Acquire `_stitchOperationLock`, then:
     - Create the Stitch project: `await stitch.createProject(title)`
     - Fetch the updated project list: `const list = await stitch.projects()`
     - Map projects to `{ id, name, updateTime }` (same as `stitchCreateProject` handler, lines 1854-1859)
     - Persist projects to KanbanDatabase if `workspaceRoot` is set (same as lines 1862-1867)
     - Post `{ type: 'stitchProjectsReady', projects, defaultProjectId: project.id, selectProjectId: project.id, workspaceRoot }` — this updates the project dropdown and auto-selects the new project
     - Post `{ type: 'stitchBriefInjected', content, projectId: project.id }` — this populates the prompt input
  5. Release `_stitchOperationLock` in `finally` block
- **Critical:** Both `stitchProjectsReady` and `stitchBriefInjected` must be posted. Without `stitchProjectsReady`, the project dropdown won't update and the user can't select the new project. Without `stitchBriefInjected`, the prompt won't be populated.

#### 3.4 JS — Handle `stitchBriefInjected`
- **File:** `src/webview/design.js`
- Add handler for `stitchBriefInjected` message in the message switch block (near line 2641 where `briefContentForInjectionReady` was handled):
  - Set `stitchPromptInput.value` to the brief content with a context header: `\n\n--- Design Brief ---\n${msg.content}\n---`
  - The project dropdown is already updated and auto-selected by the `stitchProjectsReady` message (handled by the existing `stitchProjectsReady` handler which reads `selectProjectId`)
  - Switch to the Stitch tab: `document.querySelector('[data-tab="stitch"]')?.click()`
  - Show status: `setStitchStatus('Brief loaded — review and click Generate', 'success')`
- **Note:** The existing `stitchProjectsReady` message handler already handles `selectProjectId` to auto-select a project in the dropdown. No new project selection logic is needed in the `stitchBriefInjected` handler.

#### 3.5 Backend — Enhance "New Project" flow with optional brief
- **File:** `src/services/DesignPanelProvider.ts`
- Modify `case 'stitchCreateProject'` (line 1837):
  - After the title input box (line 1846-1850), show a `showQuickPick` with two options: `['Yes, attach a brief', 'No, skip']`
  - If "No, skip" or dismissed → proceed as before (create project, post `stitchProjectsReady`, done)
  - If "Yes, attach a brief":
    - Collect available briefs by iterating all workspace roots and calling `this._getLocalFolderService(root).listBriefsFiles()` (returns `Array<{ id, name, relativePath, sourceFolder, title }>`)
    - Build quick pick items: `{ label: file.title || file.name, detail: file.sourceFolder, data: file }`
    - Show `vscode.window.showQuickPick(items, { placeHolder: 'Select a design brief' })`
    - If user dismisses, proceed without a brief (don't block project creation)
    - Read the selected brief's content: resolve `path.resolve(file.sourceFolder, file.relativePath)`, read with `fs.promises.readFile(absPath, 'utf8')`
    - After creating the project and posting `stitchProjectsReady` (existing lines 1853-1869), also post `{ type: 'stitchBriefInjected', content, projectId: project.id }`
  - **Clarification:** Use `LocalFolderService.listBriefsFiles()` directly — NOT `_sendBriefsDocsReady()` (which posts to the webview and would deadlock in a message handler context)

## Edge-Case & Dependency Audit

### Race Conditions
- **Upload before generate race**: If `upload()` is slow and the user clicks Generate again, the operation lock (`_stitchOperationLock`) prevents concurrent operations. Safe.
- **`stitchSendBrief` + concurrent Generate**: The `_stitchOperationLock` is shared across all Stitch operations. If `stitchSendBrief` holds the lock during project creation, a concurrent `stitchGenerate` will be rejected with "Another Stitch operation is in progress." Safe.
- **File picker during busy state**: The `+` attach button must be disabled in `setStitchBusy` to prevent opening a file picker mid-generation. See Phase 2.3 clarification.

### Security
- **Path traversal in `stitchSendBrief`**: The backend must validate that the resolved brief path stays within the configured briefs source folder (same guard as `fetchBriefForInjection` lines 2260-2262 and `fetchPreview` lines 1243-1245). Without this, a crafted `docId` could read arbitrary files.
- **File picker scope**: `showOpenDialog` for attach files has no directory restriction — users can pick files from anywhere on disk. This is intentional (reference assets may live outside the workspace) but means `upload()` receives arbitrary paths. The SDK accepts any valid file path.

### Side Effects
- **Existing `.stitch-prompt-modal` CSS reuse**: The Design System CRUD modal and Apply modal both use `.stitch-prompt-modal` as a class. Only remove the `.stitch-generator-*` styles, not the modal class itself.
- **`upload()` return value**: `project.upload()` returns `Screen[]` for reference assets. These are NOT generated screens — they should NOT be added to `_activeScreens` or displayed in the thumbnail strip. The upload is fire-and-forget (with error logging).
- **`briefContentForInjectionReady` removal**: Removing this handler (Phase 1.5) is safe because the old `fetchBriefForInjection` handler that sends it is also removed (Phase 1.6). No other code path sends this message type.

### Dependencies & Conflicts
- **`_lastBriefsDocsMsg` availability**: The "Send to Stitch" handler relies on `state._lastBriefsDocsMsg` being populated (set when `briefsDocsReady` message arrives). If the Briefs tab hasn't been loaded yet, this will be `null` and the title lookup will fall back to `'Untitled'`. Low risk since the user must select a brief (which requires the docs to be loaded).
- **`stitchProjectsReady` handler**: The existing `stitchProjectsReady` message handler in design.js already processes `selectProjectId` to auto-select a project. The `stitchBriefInjected` handler relies on this having run first. The backend must post `stitchProjectsReady` BEFORE `stitchBriefInjected`.
- **MD files with non-UTF8 encoding**: `readFile` with `'utf8'` encoding may fail on binary content. The file picker filters to `.md` only, so this is low risk.
- **Tab switching from Briefs → Stitch**: The webview JS uses `document.querySelector('[data-tab="stitch"]')?.click()` to switch tabs. This pattern is consistent with the `data-tab` attribute system on `.shared-tab-btn` buttons.

## Dependencies

- None — this plan is self-contained within the Switchboard extension codebase

## Adversarial Synthesis

Key risks: (1) `stitchSendBrief` must post both `stitchProjectsReady` and `stitchBriefInjected` in order or the project dropdown won't update, (2) the brief title is not in state and must be looked up from `_lastBriefsDocsMsg` nodes, (3) the `+` attach button must be wired into `setStitchBusy` to prevent file picker during generation. Mitigations: all three are addressed with clarifying implementation details in Phases 2.3, 3.2, and 3.3 respectively.

## Files Changed

| File | Change |
|------|--------|
| `src/webview/design.html` | Remove Image-to-Prompt button + modal, remove Add Brief dropdown, add `+` attach button + chips container + chip CSS, add "Send to Stitch" button on Briefs tab |
| `src/webview/design.js` | Remove Image-to-Prompt JS + Add Brief dropdown JS, add attach context state/UI, add "Send to Stitch" handler, add `stitchBriefInjected` handler |
| `src/services/DesignPanelProvider.ts` | Remove `fetchBriefForInjection` handler, add `stitchPickAttachFiles` handler, modify `stitchGenerate` to upload references, add `stitchSendBrief` handler, enhance `stitchCreateProject` with optional brief |

## Verification Plan

### Automated Tests

No automated tests will be run as part of this session (per session directive). The test suite will be run separately by the user.

### Manual Verification Steps

1. **Image to Prompt removal**: Verify the button and modal are gone, no console errors referencing removed elements
2. **Add Brief dropdown removal**: Verify the button and dropdown are gone, no console errors
3. **`+` attach button**: Click `+` → native file picker opens → select PNG → chip appears → click Generate → file uploaded via SDK → screen generated
4. **`+` attach with MD**: Select `.md` file → chip appears → click Generate → MD content injected into prompt → screen generated
5. **`+` button disabled during generation**: Click Generate → verify `+` button is disabled → generation completes → `+` button re-enabled
6. **Send to Stitch from Briefs**: Select a brief → click "Send to Stitch" → project title input (pre-filled with brief title) → project created → auto-switch to Stitch tab → prompt populated with brief content → new project selected in dropdown
7. **New Project with brief**: Click "+ New Project" → enter title → choose "Yes, attach a brief" → select brief from quick pick → project created → Stitch tab shows with brief content in prompt
8. **New Project without brief**: Click "+ New Project" → enter title → choose "No, skip" → project created (existing behavior unchanged)
9. **Send to Stitch with no brief selected**: Verify "Send to Stitch" button is disabled when no brief is selected
10. **Send to Stitch during brief edit mode**: Verify "Send to Stitch" button is disabled when in brief edit mode

## Recommendation

**Complexity: 6** → Send to Coder

This plan involves multi-file coordination across HTML, JS, and TypeScript, with moderate logic changes to the Stitch generation flow and a new cross-tab bridge. The majority of work is routine deletion + pattern-following additions, but the `stitchGenerate` modification and `stitchSendBrief` handler have enough moving parts to warrant an experienced coder.
