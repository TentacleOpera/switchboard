# Research Document Import

## Goal
Add a clipboard-based research document import flow to the RESEARCH tab in planning.html, enabling users to import markdown output from Google AI Studio (or any AI tool) as a document in `.switchboard/docs/`.

## Overview
Add instructions and enhanced import functionality to the RESEARCH tab in planning.html to enable users to run research in Google AI Studio (or any AI tool) and import the markdown output as a local document. This is a simpler, more flexible approach than direct API integration.

## Background
Currently, the RESEARCH tab provides a prompt template but requires manual copy-paste to external AI services. Users run research in Google AI Studio, get markdown output, and want to import it as a local document for reference. The extension already has clipboard import for plans - this extends it for research documents.

## Metadata
- **Tags:** [frontend, backend, UX, workflow]
- **Complexity:** 4

## Technical Context
- **planning.html location**: `src/webview/planning.html`
- **Existing clipboard import**: `btn-import-plans` in CLIPBOARD IMPORT tab (line 1259) — sends `importPlansFromClipboard` message which delegates to `switchboard.importPlanFromClipboard` command, creating *kanban plan cards* (not docs)
- **Import docs destination**: `.switchboard/docs/` — managed by `PlannerPromptWriter._writeDocToDocsDir()` (line 53-126 of `PlannerPromptWriter.ts`). NOT `.switchboard/local-docs/` (that path does not exist).
- **Import registry**: `PlanningPanelCacheService.registerImport()` — required for docs to appear in the "Imported Docs" sidebar section
- **Existing import pattern**: `_handleImportFullDoc()` in `PlanningPanelProvider.ts` (line 1701) — reads content, calls `writeContentToDocsDir()`, registers in cache. This is the pattern to follow.
- **ResearchImportService**: This is an adapter registry for *online sources* (Notion, Linear, ClickUp) — it is NOT relevant to clipboard-based import. Do NOT use it for this feature.
- **LocalFolderService**: Manages a configurable external folder path (`switchboard.research.localFolderPath` setting) — this is a separate feature for browsing user-owned doc folders, NOT the import destination.

## User Review Required
- Confirm whether the "HOW TO RUN RESEARCH" instructions card should be collapsible by default (to keep the RESEARCH tab compact) or always visible
- Confirm whether a secondary "Import as Research Doc" button should also appear in the CLIPBOARD IMPORT tab, or if the RESEARCH tab alone is sufficient

## Complexity Audit

### Routine
- Adding HTML card and button elements to the RESEARCH tab section (lines 1293-1345 of planning.html)
- Adding a JS click handler in planning.js that sends a `importResearchDoc` message
- Adding a new `case 'importResearchDoc'` branch in `_handleMessage()` (PlanningPanelProvider.ts, around line 734)
- Reusing existing `PlannerPromptWriter.writeContentToDocsDir()` for file write + import registry

### Complex / Risky
- None — this is a straightforward extension of the existing import pipeline with a new message type

## Edge-Case & Dependency Audit

- **Race Conditions**: The existing `_importInProgress` guard (PlanningPanelProvider.ts line 35) already prevents concurrent imports. The new handler should check this flag the same way `_handleImportFullDoc` does.
- **Security**: Clipboard content is untrusted. The existing `writeContentToDocsDir` uses content-hash-based filenames (no user-controlled path segments), which prevents path traversal. The custom filename input (if kept) must be sanitized to slug format before use — or better, use it only as a `docTitle` parameter (which gets slugified by `_writeDocToDocsDir`), not as a raw filename.
- **Side Effects**: Writing to `.switchboard/docs/` triggers the `_docsFolderWatcher` (line 286-309), which auto-refreshes the Imported Docs sidebar. This is desired behavior.
- **Dependencies & Conflicts**: The `importPlansFromClipboard` handler creates kanban plans; the new `importResearchDoc` handler creates docs files. These are completely separate pipelines with no conflict. The only shared resource is the clipboard read (`vscode.env.clipboard.readText()`), which is not concurrent.

## Dependencies
- None

## Adversarial Synthesis
Key risks: (1) The original plan referenced the wrong folder (`.switchboard/local-docs/`) and wrong service (`ResearchImportService`) — corrected to `.switchboard/docs/` and `PlannerPromptWriter`. (2) Custom filename input could enable path traversal if used as a raw filename — mitigated by using it only as `docTitle` (which gets slugified). (3) Missing import registry registration would make docs invisible in sidebar — mitigated by reusing `writeContentToDocsDir()` which handles registration.

## Implementation Plan

### Phase 1: Add Research Instructions and Import Panel to RESEARCH Tab

**File**: `src/webview/planning.html`

1. Add instructions card to RESEARCH tab (insert after line 1305, before the COMPLEXITY LEVEL card at line 1307)
   - Section header: "HOW TO RUN RESEARCH"
   - Two workflow options:

   **Option A: Google AI Studio**
   1. Go to Google AI Studio (aistudio.google.com)
   2. Select any Gemini Flash model (free tier) or Gemini Pro (free with Google AI Pro subscription)
   3. Enable Search Grounding for web search
   4. Use the research prompt template below
   5. Copy the markdown output
   6. Click IMPORT RESEARCH DOC button below

   **Option B: NotebookLM**
   1. Use the NOTEBOOKLM INTEGRATION tab to bundle code and upload to NotebookLM
   2. In NotebookLM, create a new notebook with your sources
   3. Generate research using the sprint planning prompt
   4. Copy the markdown output
   5. Click IMPORT RESEARCH DOC button below

   - Link to Google AI Studio (external link, handled by `airlock_openNotebookLM` pattern or `vscode.env.openExternal`)
   - Note about free tier: "All Gemini Flash models are free with generous limits (5,000 search queries/month). Google AI Pro subscribers can use Gemini Pro models in AI Studio for free without a paid API key."
   - Note about NotebookLM: "Unlimited Gemini quota when using NotebookLM with your own sources"
   - **Clarification**: Make this card collapsible by default to keep the tab compact; expand on click

2. Keep existing research prompt input and controls (lines 1293-1305)
   - Research prompt textarea
   - Complexity level radio buttons
   - Import toggle
   - COPY PROMPT button (for convenience)

3. Add clipboard import card to RESEARCH tab (insert after the IMPORT OPTIONS card, before line 1345 closing `</div>`)
   - Section header: "IMPORT RESEARCH DOC"
   - Filename input field (optional, used as `docTitle` for slug generation — NOT as raw filename)
   - Default docTitle: "Research-{timestamp}" (e.g., `research-2026-05-26T11-38`)
   - IMPORT RESEARCH DOC button (`id="btn-import-research-doc"`)
   - Status/error message display (`id="research-import-status"`)
   - Note: "Copy research output from Google AI Studio or NotebookLM, then click import"

### Phase 2: Add Secondary Import Button in CLIPBOARD IMPORT Tab

**File**: `src/webview/planning.html`

1. Add "IMPORT RESEARCH DOC" button in CLIPBOARD IMPORT tab (after line 1259, alongside existing `btn-import-plans`)
   - Button label: "IMPORT RESEARCH DOC" (clearly differentiated from "IMPORT PLANS")
   - Same `id` and handler as the RESEARCH tab button
   - Both buttons send the same `importResearchDoc` message
   - **Clarification**: This provides discoverability — users in the CLIPBOARD IMPORT tab who have research output (not plans) can import it without switching tabs

### Phase 3: Backend Import Logic

**File**: `src/services/PlanningPanelProvider.ts`

1. Add `importResearchDoc` case in `_handleMessage()` switch (insert near line 734, after `importPlansFromClipboard` case)
   - Message type: `importResearchDoc`
   - Optional field: `docTitle` (custom title from filename input)
   - Handler: `_handleImportResearchDoc(workspaceRoot, docTitle?)`

2. Implement `_handleImportResearchDoc()` method
   - Check `_importInProgress` guard (same as `_handleImportFullDoc`, line 1703)
   - Read clipboard via `vscode.env.clipboard.readText()`
   - Validate: non-empty content, content length < 200KB (same limit as plan import, line 15172-15174 of TaskViewerProvider.ts)
   - Derive `docTitle`: use custom title if provided, else extract from first H1 header (`/^#\s+(.+)$/m`), else fallback to `"Research-{ISO timestamp}"`
   - Call `this._plannerPromptWriter.writeContentToDocsDir(workspaceRoot, content, docTitle, 'research-clipboard', { skipDesignDocLink: true })`
     - This handles: slug generation, content-hash filename, front-matter, file write, and import registry registration
     - `sourceId: 'research-clipboard'` distinguishes research imports from adapter imports
     - `skipDesignDocLink: true` prevents setting the design doc config (research docs aren't design docs)
   - Post `importResearchDocResult` message back to webview (success/error)
   - On success, also call `_handleFetchImportedDocs(workspaceRoot)` to refresh the Imported Docs sidebar

### Phase 4: Webview JavaScript Updates

**File**: `src/webview/planning.js`

1. Add button click handler for research import (insert near line 105, after `importPlansBtn` handler)
   ```javascript
   const importResearchDocBtn = document.getElementById('btn-import-research-doc');
   if (importResearchDocBtn) {
       importResearchDocBtn.addEventListener('click', () => {
           const docTitleInput = document.getElementById('research-doc-title');
           const docTitle = docTitleInput ? docTitleInput.value.trim() : undefined;
           importResearchDocBtn.disabled = true;
           importResearchDocBtn.innerText = 'IMPORTING...';
           vscode.postMessage({ type: 'importResearchDoc', docTitle: docTitle || undefined });
       });
   }
   ```

2. Handle `importResearchDocResult` message in the existing message listener (near line 1400+)
   - On success: show status "Imported: {docTitle}", re-enable button, clear title input
   - On error: show error in `research-import-status` element, re-enable button

3. Do NOT modify existing clipboard import logic
   - The existing `importPlansFromClipboard` creates kanban plans — leave it alone
   - Research import is a separate, explicit action via dedicated button
   - No auto-detection of "research vs plan" format — the user chooses via which button they click

## Proposed Changes

### `src/webview/planning.html`
- **Context**: RESEARCH tab content is at lines 1293-1345. CLIPBOARD IMPORT tab is at lines 1251-1262.
- **Logic**: Add "HOW TO RUN RESEARCH" collapsible card after line 1305. Add "IMPORT RESEARCH DOC" card before line 1345. Add secondary "IMPORT RESEARCH DOC" button after line 1259.
- **Implementation**:
  - Insert "HOW TO RUN RESEARCH" card with collapsible toggle, Google AI Studio instructions, NotebookLM instructions
  - Insert "IMPORT RESEARCH DOC" card with `id="research-doc-title"` input and `id="btn-import-research-doc"` button and `id="research-import-status"` status display
  - Add `id="btn-import-research-doc-clipboard"` button in CLIPBOARD IMPORT tab (or reuse same ID if only one instance is rendered at a time — note: tab content divs are shown/hidden, so same ID would conflict; use distinct IDs with shared handler)
- **Edge Cases**: Both RESEARCH tab and CLIPBOARD IMPORT tab have import buttons — use distinct element IDs (`btn-import-research-doc` and `btn-import-research-doc-clipboard`) but wire both to the same handler logic

### `src/services/PlanningPanelProvider.ts`
- **Context**: `_handleMessage()` switch is around lines 530-840. `_handleImportFullDoc()` is at line 1701.
- **Logic**: Add `case 'importResearchDoc'` that delegates to new `_handleImportResearchDoc()` method
- **Implementation**:
  - Add case branch after `importPlansFromClipboard` (line 734-736)
  - New method `_handleImportResearchDoc(workspaceRoot: string, docTitle?: string)`:
    1. Check `_importInProgress` guard
    2. Read clipboard
    3. Validate non-empty + size limit
    4. Derive docTitle (custom → H1 → timestamp fallback)
    5. Call `writeContentToDocsDir()` with `sourceId: 'research-clipboard'`
    6. Post result + refresh imported docs
- **Edge Cases**: Empty clipboard, oversized content, concurrent import attempts

### `src/webview/planning.js`
- **Context**: Button handlers are near lines 76-200. Message listener is around lines 1400+.
- **Logic**: Add click handlers for both research import buttons, handle `importResearchDocResult` messages
- **Implementation**:
  - Add handler for `btn-import-research-doc` and `btn-import-research-doc-clipboard`
  - Both read `research-doc-title` input value and send `importResearchDoc` message
  - Add `importResearchDocResult` case in message listener
- **Edge Cases**: Button disabled during import, status display on error

## Verification Plan

### Automated Tests
- (Skipped per session directive — test suite will be run separately)

### Manual Verification
- [ ] Research instructions display correctly in RESEARCH tab
- [ ] "HOW TO RUN RESEARCH" card is collapsible
- [ ] Link to Google AI Studio opens external browser
- [ ] COPY PROMPT button copies research template
- [ ] IMPORT RESEARCH DOC button appears in both RESEARCH tab and CLIPBOARD IMPORT tab
- [ ] Custom doc title input works (slugified correctly, no path traversal)
- [ ] Default title generation works (H1 extraction → timestamp fallback)
- [ ] Research document saves to `.switchboard/docs/` (not `.switchboard/local-docs/`)
- [ ] Research document appears in Imported Docs sidebar section
- [ ] Research document can be previewed in the LOCAL DOCS tab
- [ ] Import registry entry is created (doc visible after panel reopen)
- [ ] Error handling for empty clipboard (warning message)
- [ ] Error handling for oversized content (>200KB)
- [ ] Success notification displays in status element
- [ ] Concurrent import prevention works (button disabled during import)
- [ ] Existing IMPORT PLANS button still works (no regression)

## File Changes Summary

### Modified Files
- `src/webview/planning.html` - Add research instructions card and import panel to RESEARCH tab; add secondary import button to CLIPBOARD IMPORT tab
- `src/webview/planning.js` - Add research import button handlers and `importResearchDocResult` message handler
- `src/services/PlanningPanelProvider.ts` - Add `importResearchDoc` message case and `_handleImportResearchDoc()` method

## Testing Checklist

- [ ] Research instructions display correctly in RESEARCH tab
- [ ] Link to Google AI Studio works
- [ ] COPY PROMPT button copies research template
- [ ] IMPORT RESEARCH DOC button appears in CLIPBOARD IMPORT tab
- [ ] Custom filename input works
- [ ] Default filename generation works (H1 → timestamp fallback)
- [ ] Research document saves to `.switchboard/docs/` folder
- [ ] Research document appears in Imported Docs sidebar
- [ ] Research document can be previewed
- [ ] Error handling for empty clipboard
- [ ] Error handling for oversized content
- [ ] Success notification displays
- [ ] Import registry entry created (persistent across panel reopen)

## Benefits of This Approach

- **No API key management**: Users manage keys in Google AI Studio
- **Model flexibility**: Works with any AI provider (Gemini, Claude, GPT, etc.)
- **Simpler implementation**: No backend service, no secret storage
- **Leverages existing infrastructure**: `PlannerPromptWriter.writeContentToDocsDir()` handles file write, slug generation, content-hash naming, front-matter, and import registry
- **User control**: Users can use any AI tool they prefer
- **Free tier access**: All Gemini Flash models are free in Google AI Studio; Google AI Pro subscribers get Gemini Pro for free

## Future Enhancements

- Auto-detect research vs plan format from clipboard content
- Add research-specific templates (technical, academic, market research)
- Add citation parsing for research documents
- Add research metadata (date, topic, sources count)
- Batch import for multiple research documents
- Integration with other AI studio interfaces

## Recommendation
**Send to Coder** — Complexity 4: routine multi-file changes that extend existing patterns with no architectural risk.
