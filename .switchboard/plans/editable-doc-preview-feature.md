# Feature Plan: Editable Doc Preview in Planning.html

## Goal
Add toggle-based edit functionality to the doc preview panes in planning.html, allowing users to edit markdown content directly in the webview for local-folder docs and kanban plans, then persist changes back to disk via the existing webview message channel.

## Metadata
- **Tags:** [frontend, UI, UX]
- **Complexity:** 5

## User Review Required
- Should the "Open File" and "Set Context" buttons be removed from kanban plan items, or kept as fallbacks alongside the new Edit button?
- Should the kanban list/preview pane proportions be adjusted (wider preview), and if so, what ratio?
- Should online docs (ClickUp/Linear/Notion) show a disabled Edit button or hide it entirely?

## Complexity Audit

### Routine
- Adding Edit/Save/Cancel buttons to existing controls strips (follows `.strip-btn` pattern)
- Adding hidden textarea elements alongside existing preview divs
- CSS for `.edit-mode` / `.preview-mode` class toggling (standard show/hide pattern)
- Wiring button click handlers in planning.js (follows existing `addEventListener` pattern)
- Adding `saveFileContent` message type to `PlanningPanelProvider._handleMessage` switch (follows existing pattern at line 537)
- Re-rendering markdown preview after save (reuses existing `renderMarkdown()` function)
- Styling textarea with monospace font matching existing `--font-mono` variable

### Complex / Risky
- Dirty-state tracking: warning user before navigating away from unsaved edits (cross-tab state management)
- Save conflict detection: comparing original loaded content with current disk content before overwriting
- Kanban plans: ensuring `planFile` path is resolved safely for writes (path traversal guard using existing `isPathWithinRoot` pattern)
- Online docs scope: ClickUp/Linear/Notion docs are remote — Edit must be disabled for these sources, not just "handle errors"

## Edge-Case & Dependency Audit

- **Race Conditions:** User edits in webview while file is modified externally in VS Code. Mitigation: on save, read current disk content and compare with the content originally loaded into the textarea. If different, show conflict warning modal (reuse existing `.duplicate-modal` pattern from line 1138-1165 in planning.html).
- **Security:** File write path must be validated against workspace roots using the same `isPathWithinRoot` / workspace-root check already used in `openKanbanPlan` (PlanningPanelProvider.ts line 1025). Never trust a file path from the webview without server-side validation.
- **Side Effects:** Saving a file triggers the existing `GlobalPlanWatcherService` file watcher, which may auto-refresh the preview. The `isAutoRefreshed` pattern in `handlePreviewReady` (planning.js line 990-1005) already handles this gracefully.
- **Dependencies & Conflicts:** The `state.activeDocContent` field (planning.js line 12) stores the raw markdown for the current preview. This is the source for populating the textarea on edit mode entry. Must be kept in sync — after save, update `state.activeDocContent` with the saved content.

## Dependencies
- None — this feature is self-contained within the planning panel webview and its provider.

## Adversarial Synthesis
Key risks: online docs are remote and cannot be saved (must disable Edit for those sources); dirty-state navigation can cause data loss without a warning; save conflicts when files are edited externally. Mitigations: scope Edit to local-folder and kanban-plan tabs only; add dirty-state guard on doc/tab navigation; compare disk content before overwrite on save.

## Proposed Changes

### src/webview/planning.html
- **Context:** Three tabs each have a controls strip and a preview pane. Local: `#controls-strip-local` (line 1414) + `#markdown-preview` (line 1441). Online: `#controls-strip-online` (line 1458) + `#markdown-preview-online` (line 1473). Kanban: `.kanban-controls-strip` (line 1633) + `#kanban-preview-pane` (line 1655).
- **Logic:** Add Edit/Save/Cancel buttons to local and kanban controls strips. Add hidden textarea elements inside each preview pane wrapper. For online docs tab, either hide the Edit button or show it disabled with a tooltip "Editing not available for remote docs."
- **Implementation:**
  1. In `#controls-strip-local` (after line 1418), add: `<button id="btn-edit-local" class="strip-btn" disabled>Edit</button>`, `<button id="btn-save-local" class="strip-btn" style="display:none;">Save</button>`, `<button id="btn-cancel-local" class="strip-btn" style="display:none;">Cancel</button>`
  2. In `#preview-pane` (inside `.preview-content-wrapper`, after `#markdown-preview` at line 1443), add: `<textarea id="markdown-editor-local" class="markdown-editor" style="display:none;"></textarea>`
  3. In `#controls-strip-online` (after line 1461), add: `<button id="btn-edit-online" class="strip-btn" disabled title="Editing not available for remote docs">Edit</button>` — shown but always disabled for online sources.
  4. In `.kanban-controls-strip` (after line 1648), add: `<button id="btn-edit-kanban" class="strip-btn" disabled>Edit</button>`, `<button id="btn-save-kanban" class="strip-btn" style="display:none;">Save</button>`, `<button id="btn-cancel-kanban" class="strip-btn" style="display:none;">Cancel</button>`
  5. In `#kanban-preview-pane` (after line 1656), add: `<textarea id="kanban-editor" class="markdown-editor" style="display:none;"></textarea>`
  6. Add CSS for `.markdown-editor`: `width: 100%; height: 100%; background: var(--panel-bg); color: var(--text-primary); font-family: var(--font-mono); font-size: 13px; border: none; padding: 0 26px; resize: none; outline: none; white-space: pre; tab-size: 4;`
  7. Add CSS for `.edit-mode` on preview pane: `.edit-mode #markdown-preview, .edit-mode #markdown-preview-online, .edit-mode #kanban-preview-pane { display: none !important; }` and `.edit-mode .markdown-editor { display: block !important; }`
- **Edge Cases:** When no doc is selected, Edit button stays disabled (matching existing pattern for other strip-btns). When switching tabs while in edit mode, auto-cancel (revert to preview mode) to avoid state confusion.

### src/webview/planning.js
- **Context:** State object at line 8-23 tracks active doc info. Message handler at line 1584-1817 processes backend responses. Kanban logic at lines 2046-2368 manages kanban plans.
- **Logic:** Add edit mode state tracking, toggle functions, save/cancel handlers, and dirty-state guard.
- **Implementation:**
  1. Add to `state` object (after line 22): `editMode: { local: false, kanban: false }, editOriginalContent: { local: null, kanban: null }, dirtyFlags: { local: false, kanban: false }`
  2. Add function `enterEditMode(tab)`:
     - For `tab='local'`: populate `#markdown-editor-local` with `state.activeDocContent`, store original in `state.editOriginalContent.local`, add `.edit-mode` class to `#preview-pane`, show Save/Cancel, hide Edit, set `state.editMode.local = true`
     - For `tab='kanban'`: populate `#kanban-editor` with current kanban preview content (from `_kanbanSelectedPlan`), store original, add `.edit-mode` class to `#kanban-preview-pane` parent, show Save/Cancel, hide Edit, set `state.editMode.kanban = true`
  3. Add function `exitEditMode(tab, discard)`:
     - If `discard` is false and `state.dirtyFlags[tab]` is true, show confirmation: "Discard unsaved changes?" (use existing modal pattern from `showDuplicateModal` at line 1568)
     - Remove `.edit-mode` class, hide Save/Cancel, show Edit, set `state.editMode[tab] = false`, `state.dirtyFlags[tab] = false`
     - If not discarding, re-render preview from saved/original content
  4. Add `input` event listener on textareas to set `state.dirtyFlags[tab] = true`
  5. Add dirty-state guard to `loadDocumentPreview` (line 451): before loading a new doc, check if local edit mode is dirty and warn
  6. Add dirty-state guard to kanban plan item click handler (line 2142): before selecting a new plan, check if kanban edit mode is dirty and warn
  7. Add save handler: `vscode.postMessage({ type: 'saveFileContent', filePath, content, originalContent, tab })`
  8. Add message handler case for `saveFileContentResult`: on success, update `state.activeDocContent`, exit edit mode, show success status; on conflict (content differs on disk), show conflict modal; on error, show error and stay in edit mode
  9. Wire Edit button clicks to `enterEditMode(tab)`, Save to save handler, Cancel to `exitEditMode(tab, true)`
  10. Enable Edit button when a doc is loaded: in `handlePreviewReady` (line 990), enable `#btn-edit-local` for local-folder source; in `handleKanbanPlanPreviewReady` (line 2261), enable `#btn-edit-kanban` when `planFile` exists
  11. For online docs: `#btn-edit-online` stays disabled always (remote sources are read-only)
- **Edge Cases:** Tab switching while in edit mode — auto-exit edit mode (discard if not dirty, warn if dirty). Kanban plan with no `planFile` — keep Edit button disabled.

### src/services/PlanningPanelProvider.ts
- **Context:** `_handleMessage` switch at line 537 handles ~25 message types. File writes already use `fs.promises.writeFile` elsewhere (line 576). Path safety uses workspace root validation (line 1025).
- **Logic:** Add `saveFileContent` message type that validates the file path, checks for conflicts, and writes the file.
- **Implementation:**
  1. Add case `'saveFileContent'` in `_handleMessage` switch (after line 1081):
     ```
     case 'saveFileContent': {
         const filePath = String(msg.filePath || '');
         const content = String(msg.content || '');
         const originalContent = String(msg.originalContent || '');
         const tab = String(msg.tab || '');
         const resolved = path.resolve(filePath);
         const isAllowed = allRoots.some(r => resolved.startsWith(path.resolve(r)));
         if (!filePath || !isAllowed) {
             this._panel?.webview.postMessage({ type: 'saveFileContentResult', success: false, error: 'Invalid file path', tab });
             break;
         }
         try {
             // Conflict detection: compare disk content with original
             const diskContent = await fs.promises.readFile(resolved, 'utf8');
             if (originalContent && diskContent !== originalContent) {
                 this._panel?.webview.postMessage({ type: 'saveFileContentResult', success: false, conflict: true, diskContent, tab });
                 break;
             }
             await fs.promises.writeFile(resolved, content, 'utf8');
             this._panel?.webview.postMessage({ type: 'saveFileContentResult', success: true, tab });
         } catch (err) {
             this._panel?.webview.postMessage({ type: 'saveFileContentResult', success: false, error: String(err), tab });
         }
         break;
     }
     ```
  2. No new VS Code command needed — the message handler pattern is sufficient and consistent with all other write operations in this provider.
- **Edge Cases:** File deleted between load and save — `readFile` will throw, caught by try/catch. Permission denied — same. Path traversal — blocked by `isAllowed` check.

## Verification Plan

### Automated Tests
- (Skipped per session directive — test suite will be run separately by the user)

### Manual Verification Checklist
- [ ] Edit button appears in Local Docs tab when a doc is selected
- [ ] Edit button appears in Kanban Plans tab when a plan with a file is selected
- [ ] Edit button is disabled for Online Docs tab (ClickUp/Linear/Notion)
- [ ] Clicking Edit switches to textarea with current markdown content
- [ ] Textarea uses monospace font matching dark theme
- [ ] Typing in textarea marks the tab as dirty
- [ ] Save button writes changes to file and switches back to preview
- [ ] Preview shows updated markdown after save
- [ ] Cancel button discards changes and switches back to preview
- [ ] Dirty-state warning appears when navigating away from unsaved edits
- [ ] Conflict warning appears if file was modified externally while editing
- [ ] Error handling for permission denied / file not found
- [ ] Kanban plans with no file path keep Edit button disabled
- [ ] Tab switching while in edit mode properly exits edit mode
- [ ] No performance degradation with typical markdown files (<100KB)

## Overview
Add toggle-based edit functionality to the doc preview panes in planning.html, allowing users to edit markdown content directly in the webview. This applies to:
- Local Docs tab preview pane
- Online Docs tab preview pane (read-only — Edit disabled)
- Kanban Plans tab preview pane

## Current State
- Preview panes (`#markdown-preview`, `#markdown-preview-online`, `#kanban-preview-pane`) are read-only
- No edit controls or save functionality
- Users must open files in VS Code editor to make changes

## Proposed Solution
Implement a toggle-based edit mode:
- **Preview mode**: Current styled markdown rendering (default)
- **Edit mode**: Textarea for raw markdown editing
- Toggle button switches between modes
- Save button persists changes via webview message to PlanningPanelProvider

## Implementation Steps

### 1. HTML Changes (planning.html)

#### 1.1 Add Edit Controls to Local Docs Tab
- Add "Edit" button to `#controls-strip-local` (after line 1418)
- Add "Save" and "Cancel" buttons (hidden by default)
- Add hidden textarea `#markdown-editor-local` for edit mode (inside `#preview-pane .preview-content-wrapper`, after line 1443)

#### 1.2 Add Edit Controls to Online Docs Tab
- Add "Edit" button to `#controls-strip-online` (after line 1461) — always disabled with tooltip "Editing not available for remote docs"
- No Save/Cancel/textarea needed for online docs (remote sources are read-only)

#### 1.3 Add Edit Controls to Kanban Plans Tab
- Add "Edit" button to `.kanban-controls-strip` (after line 1648)
- Add "Save" and "Cancel" buttons (hidden by default)
- Add hidden textarea `#kanban-editor` for edit mode (inside `#kanban-preview-pane`, after line 1656)

#### 1.4 Add CSS Styling
- Style edit buttons to match existing `.strip-btn` styling
- Style textarea (`.markdown-editor`): dark theme background, `--font-mono`, `white-space: pre`, `tab-size: 4`, no border, full height/width
- Add `.edit-mode` class rules: hide preview div, show textarea
- Ensure smooth toggle (no layout jump)

### 2. JavaScript Changes (planning.js)

#### 2.1 Add Edit Mode State
- Add to `state` object: `editMode`, `editOriginalContent`, `dirtyFlags` for each tab
- Track whether user has unsaved changes per tab

#### 2.2 Add Edit Mode Toggle Logic
- Function `enterEditMode(tab)`:
  - Populate textarea with current content (`state.activeDocContent` for local, kanban preview content for kanban)
  - Store original content for conflict detection
  - Add `.edit-mode` class to preview pane
  - Show Save/Cancel, hide Edit
- Function `exitEditMode(tab, discard)`:
  - If dirty and not discarding, show confirmation modal
  - Remove `.edit-mode` class
  - Show Edit, hide Save/Cancel
  - Reset dirty flag

#### 2.3 Add Save Functionality
- Send `saveFileContent` message to backend with `filePath`, `content`, `originalContent`, `tab`
- Handle `saveFileContentResult` response:
  - Success: update `state.activeDocContent`, exit edit mode, show success status
  - Conflict: show conflict modal (overwrite/reload/cancel)
  - Error: show error, stay in edit mode

#### 2.4 Add Cancel Functionality
- Call `exitEditMode(tab, true)` — discards changes
- If dirty, show confirmation first

#### 2.5 Dirty-State Guards
- On doc selection change (`loadDocumentPreview`): warn if local edit is dirty
- On kanban plan selection change: warn if kanban edit is dirty
- On tab switch: auto-exit edit mode (warn if dirty)

#### 2.6 Enable Edit Button on Doc Load
- In `handlePreviewReady`: enable `#btn-edit-local` for `local-folder` and `antigravity` sources
- In `handleKanbanPlanPreviewReady`: enable `#btn-edit-kanban` when `_kanbanSelectedPlan.planFile` exists
- Disable Edit when no doc is selected or for online sources

### 3. Backend Changes (PlanningPanelProvider.ts)

#### 3.1 Add saveFileContent Message Handler
- Add `case 'saveFileContent'` in `_handleMessage` switch (after line 1081)
- Validate file path against workspace roots (same pattern as `openKanbanPlan` at line 1025)
- Conflict detection: read current disk content, compare with `originalContent`
- If conflict: return `{ type: 'saveFileContentResult', success: false, conflict: true, diskContent }`
- If no conflict: write file with `fs.promises.writeFile`, return success
- On error: return error message

#### 3.2 No New VS Code Command Needed
- The existing `postMessage` / `_handleMessage` pattern is sufficient
- All other write operations in PlanningPanelProvider use this same pattern

### 4. Edge Cases & Considerations

#### 4.1 Online Docs Are Read-Only
- ClickUp, Linear, and Notion docs are remote sources
- Edit button is disabled for these sources (not just "handle the error on save")
- Tooltip explains why: "Editing not available for remote docs"

#### 4.2 File Changed Externally
- Conflict detection on save: compare `originalContent` with current disk content
- If different: show conflict modal with options (overwrite / reload / cancel)
- Reuses existing `.duplicate-modal` pattern from planning.html

#### 4.3 Kanban Plans Without File Paths
- If `_kanbanSelectedPlan.planFile` is null/empty, Edit button stays disabled
- No auto-generate filename logic needed — every real plan has a file path

#### 4.4 Large Files
- Textarea performance is fine for typical markdown files (<100KB)
- For very large files (>1MB), could show a warning, but this is unlikely for plan/docs markdown
- Defer size warning to follow-up if needed

#### 4.5 Markdown Syntax Highlighting
- Plain textarea with monospace font is sufficient for MVP
- Tab key support: intercept Tab key in textarea to insert spaces/tab character (prevent focus change)
- Syntax highlighting can be added later as an enhancement

### 5. Optional Follow-Up Items (Not in Scope)

#### 5.1 Remove Obsolete Kanban Controls
- Remove "Open File" button from kanban plan items (redundant with edit mode)
- Remove "Set Context" button from kanban plan items (user reports this is useless)
- Move column status badge from right-justified position to inline
- **Recommendation:** Do this as a separate task after edit mode is stable, to avoid losing the Open File fallback

#### 5.2 Adjust Kanban Layout
- Reduce width of kanban list pane, increase preview pane width
- Update CSS grid/flex layout proportions
- **Recommendation:** Separate task — independent of edit functionality

## Testing Checklist

- [ ] Edit button appears in Local Docs tab
- [ ] Edit button is disabled in Online Docs tab
- [ ] Edit button appears in Kanban Plans tab
- [ ] Clicking Edit switches to textarea with current content
- [ ] Save button writes changes to file
- [ ] Cancel button discards changes
- [ ] Preview mode renders updated markdown after save
- [ ] Error handling for permission denied
- [ ] Error handling for file not found
- [ ] Kanban plans can be edited and saved
- [ ] Textarea styling matches dark theme (monospace font)
- [ ] Toggle is smooth (no layout jump)
- [ ] Dirty-state warning when navigating away from unsaved edits
- [ ] Conflict warning when file modified externally
- [ ] Tab key inserts spaces/tab in textarea (doesn't change focus)
- [ ] Tab switching exits edit mode properly

## Files to Modify

1. `/Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/planning.html`
   - Add edit controls HTML (lines ~1418, ~1461, ~1648)
   - Add textarea elements (lines ~1443, ~1656)
   - Add CSS styling for `.markdown-editor` and `.edit-mode`

2. `/Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/planning.js`
   - Add edit mode state to `state` object (line ~22)
   - Add `enterEditMode` / `exitEditMode` functions
   - Add save/cancel handlers
   - Add dirty-state guards in `loadDocumentPreview` and kanban click handler
   - Add `saveFileContentResult` message handler case (line ~1816)
   - Enable Edit buttons in `handlePreviewReady` and `handleKanbanPlanPreviewReady`

3. `/Users/patrickvuleta/Documents/GitHub/switchboard/src/services/PlanningPanelProvider.ts`
   - Add `case 'saveFileContent'` in `_handleMessage` switch (after line 1081)
   - Path validation, conflict detection, file write

## Alternative Approaches Considered

### Contenteditable Div
- Pros: Maintains styling while editing
- Cons: Complex cursor handling, markdown syntax issues
- Decision: Not chosen - textarea is simpler and more reliable

### Side-by-Side Editor
- Pros: Always see both views
- Cons: Takes more screen space, complex layout
- Decision: Not chosen - toggle is cleaner for current layout

### Live Preview While Typing
- Pros: Immediate feedback
- Cons: Performance overhead, complex implementation
- Decision: Not chosen - toggle is sufficient for MVP

### New VS Code Command for Save
- Pros: Reusable command
- Cons: Unnecessary indirection — the message handler pattern is already used for all other operations
- Decision: Not chosen — `saveFileContent` message type in `_handleMessage` is sufficient and consistent

## Success Criteria

- Users can edit local-folder docs and kanban plans in planning.html without opening VS Code editor
- Online docs (ClickUp/Linear/Notion) correctly show Edit as disabled
- Changes are persisted to disk correctly with conflict detection
- UI remains clean and matches existing design
- No performance degradation
- Dirty-state warnings prevent accidental data loss
- Error handling is robust

## Recommendation
**Send to Coder** — Complexity 5 (multi-file changes across HTML/CSS/JS/TS with moderate logic for dirty-state tracking and conflict detection, but reuses existing patterns throughout).
