---
description: Optimize ClickUp Docs fetch to avoid rate limiting (200 API calls per doc)
---

# Planning Panel Overhaul: ClickUp Fetch Optimization, Bug Fixes & UX Improvements

## Goal
Reduce ClickUp Docs API calls from ~200 per doc to 2-3 for preview, add on-demand full import and page-level navigation, and fix a cluster of pre-existing planning panel bugs (dark theme, metadata, loading states, layout, error messages, cache mismatch, source selection, folder hierarchy).

## Metadata
**Tags:** frontend, backend, UX, performance, bugfix, UI, reliability
**Complexity:** 7

## User Review Required
> [!NOTE]
> - The `fetchDocContent` return type gains optional `pageTitles` and `firstPageContent` fields — any external consumers expecting only `content` must be verified.
> - Imported docs are saved to `.switchboard/docs/` — ensure this directory is gitignored.
> - `fetchContent()` at `ClickUpDocsAdapter.ts:88` calls `fetchDocContent` internally and promises a `string` return. The summary-mode refactor must preserve this contract by having `fetchContent()` explicitly call `fetchDocContent(docId, 'full')`.
> - `listDocPages` at `ClickUpDocsAdapter.ts:660` currently fetches pages WITH `content_format=text%2Fmd`. This must also be changed to summary-only to avoid burning API calls on tree expansion.

## Problem

**Current behavior:**
- `fetchDocContent` fetches ALL pages (up to MAX_PAGES=200) with full content
- Worst case: 202 API calls per doc (1 metadata + 1 page listing + 200 per-page fetches)
- ClickUp rate limit: ~100 calls/minute
- User clicking through 3-4 docs → 600-800 calls → rate limit errors

**Root cause:**
- Designed for "import entire doc" workflow, not preview
- Fetches full content even though research pane only needs summary
- No visibility into actual per-page fetch count

## Complexity Audit
### Routine
- Color palette CSS variable updates in `planning.html` (Step 0)
- Guard `doc.url` before metadata line (Step 0.5)
- Clear loading placeholder in `handleContainersReady` when no containers (Step 0.6)
- HTTP error message localization — static mapping function (Step 0.8)
- Add `importFullDoc` message case in `_handleMessage` switch (Step 4)
- Add "Import full doc" button HTML + click handler in webview (Step 3)
- Render page titles as clickable links in preview (Step 5)
- Add `pageTitles` and `firstPageContent` as optional fields to existing return type (backward compatible)
- Add source selection checkboxes in setup menu (Step 0.10)

### Complex / Risky
- **`fetchDocContent` mode parameter refactor** — Must preserve `fetchContent()` string-return contract. If `fetchContent()` calls `fetchDocContent(docId)` and gets a summary-only result, it must still return a usable string. Requires `fetchContent()` to call `fetchDocContent(docId, 'full')` explicitly.
- **`listDocPages` content_format removal** — Currently fetches pages WITH content at line 660. Removing `content_format` changes what data the tree view receives; must verify tree rendering still works with empty content nodes.
- **`fetchPageContent` no-pageId path consolidation** — Currently duplicates full-doc fetch logic (~80 lines). Delegating to `fetchDocContent(docId, 'full')` eliminates duplication but changes the call stack; must verify error handling and cache behavior are preserved.
- **Cache semantics for summary vs. full** — Summary preview caches first-page only; full import overwrites with complete content. The `(cached)` badge must distinguish preview cache from full-import cache to avoid user confusion.
- **Import progress feedback** — Full doc import with rate-limit retries can take minutes. Need `importProgress` message type and cancel mechanism to avoid perceived UI freeze.
- **Cached docs mismatch (Step 0.9)** — `saveCachedContent()` doesn't update document ID map, so sidebar shows "(no documents)" while preview shows "(cached)". Fix requires coordinating cache writes across two subsystems.
- **Local folder hierarchy (Step 0.11)** — Changing `LocalFolderService.listFiles()` from flat list to tree structure affects the adapter contract and webview rendering; must handle edge case of deeply nested folders and empty directories.
- **UI layout alignment (Step 0.7)** — Sidebar/preview pane vertical alignment and notion area horizontal alignment require careful CSS grid/flexbox restructuring; risk of regressions in other view modes.

## Edge-Case & Dependency Audit
- **Race Conditions:** `_handleFetchPreview` already has a `requestId` race guard at `PlanningPanelProvider.ts:438`. The new `importFullDoc` handler needs its own guard — if user clicks import twice rapidly, two full-fetch operations could run concurrently, doubling API calls. Add an `_importInProgress` flag.
- **Security:** Imported docs written to `.switchboard/docs/` — path traversal risk if `docId` contains `../`. Sanitize `docId` before constructing file path. The existing `cleanDocId` strip (`doc:` prefix) is insufficient; add a regex guard like `docId.replace(/[^a-zA-Z0-9_-]/g, '_')`.
- **Side Effects:** `fetchContent()` is called by `ResearchImportService` for the generic adapter path. Changing `fetchDocContent` default mode to `'summary'` would break this unless `fetchContent()` explicitly passes `'full'`. Also, the MCP server's `clickup_fetch` tool may call `fetchDocContent` directly — verify it still gets full content or update the call site.
- **Backward Compatibility:** The `fetchDocContent` return type gains optional fields (`pageTitles`, `firstPageContent`). Existing callers that only read `success`, `content`, `docTitle`, `error` are unaffected. New callers opt into the new fields.
- **Dependencies & Conflicts:** Kanban board shows no active plans in New/Planned columns that overlap with this work. The `enable_cross_column_multi_select_drag_drop` plan (Backlog, `sess_1776024641478`) touches `kanban.html` not `planning.html`, so no overlap. The `refactor_onboarding_state_synchronization` plan (Backlog, `import_a1b3054995747d5f`) touches `SetupPanelProvider.ts` which Step 0.10 also touches — if both land concurrently, coordinate the `SetupPanelProvider` edits.

## Dependencies
> [!IMPORTANT]
> None

## Adversarial Synthesis

### Grumpy Critique
Right, let's see what we're actually dealing with here. This plan touches **nine files** across backend services, webview HTML, webview JS, and the adapter layer. That's a lot of surface area. Here are the real risks:

1. **`fetchContent()` is a landmine.** Line 88 of `ClickUpDocsAdapter.ts` calls `fetchDocContent` and promises a `string` return. If `fetchDocContent` defaults to summary mode and returns `{ firstPageContent, pageTitles }`, `fetchContent()` will return `[object Object]` to every caller upstream. This is the single highest-risk change and Step 1 didn't even mention it.

2. **`listDocPages` still burns API calls.** Line 660 calls the page listing endpoint WITH `?content_format=text%2Fmd`. If the user expands a doc in the tree, this still fetches all page content in one shot. The plan's Phase 1 says "remove content_format from page listing" but Step 1 only mentioned `fetchDocContent`, not `listDocPages`. Gap.

3. **`fetchPageContent` no-pageId path duplicates full-fetch logic.** Lines 780-863 of `fetchPageContent` are essentially a copy of `fetchDocContent` with hierarchical indentation. If we're adding `fetchFullDocContent` as a separate method, we'll have THREE methods doing full-doc fetch. That's a maintenance nightmare. The no-pageId path should delegate to `fetchFullDocContent`.

4. **Cache semantics are undefined.** Currently `saveCachedContent` saves whatever `fetchDocContent` returns. If `fetchDocContent` now returns a summary, the cache will only have the first page. What happens when the user clicks "Import full doc" — does it overwrite the cache? Does the sidebar still say "(cached)"?

5. **No progress indicator for import.** Full doc import can take *minutes* with rate limit retries. The plan says "add import button" but doesn't mention any loading state, progress bar, or cancel mechanism. The user will click the button and stare at a frozen UI.

6. **The "undefined" metadata fix should be a guard, not a removal.** `doc.url` is undefined because the ClickUp v3 API doesn't always return a `url` field. The fix should be a guard (`doc.url ? ...`), not a removal — the metadata line is useful when the URL exists.

7. **Path traversal on import.** `docId` is used to construct the file path `.switchboard/docs/clickup-${docId}.md`. If `docId` contains `../`, this writes outside the intended directory. Sanitize it.

### Balanced Response
Grumpy's identified real risks, and the implementation steps below have been adjusted to address every one:

1. **`fetchContent()` contract:** `fetchDocContent` gets a `mode` parameter (`'summary'` | `'full'`), defaulting to `'summary'`. `fetchContent()` explicitly calls `fetchDocContent(docId, 'full')` to preserve its string-return contract. No breaking change. This is now explicitly called out in Step 1.

2. **`listDocPages` content_format:** Step 1 now explicitly includes removing `content_format` from `listDocPages` as well. The tree view will receive page nodes without content; clicking a page triggers `fetchPageContent` on demand.

3. **`fetchPageContent` consolidation:** Step 2 now specifies that the no-pageId path of `fetchPageContent` delegates to `fetchFullDocContent` instead of duplicating logic. This eliminates ~80 lines of duplication.

4. **Cache strategy:** Step 1 and Step 4 now specify cache semantics. Summary preview → cache summary with `cacheMode: 'preview'`. Full import → cache full content with `cacheMode: 'full'` (overwrites summary). The `(cached)` badge distinguishes via the `cacheMode` field.

5. **Import progress:** Step 4 now includes an `importProgress` message type that sends page count updates during full fetch. Webview shows "Importing page X of Y..." with a cancel button. An `_importInProgress` flag prevents double-import.

6. **Metadata guard:** Step 0.5 now specifies guarding `doc.url` with a ternary instead of removing the line.

7. **Path sanitization:** Step 4 now includes `docId.replace(/[^a-zA-Z0-9_-]/g, '_')` before constructing the file path.

## Proposed Solution

### Phase 1: Summary-Only Preview

**Goal:** Reduce API calls to 2-3 per doc (metadata + first page + page titles)

**Changes:**

1. **`ClickUpDocsAdapter.fetchDocContent`** — Add `mode` parameter, default `'summary'`
   - `mode='summary'`: Fetch doc metadata (1 call) + page listing WITHOUT content (1 call) + first page content (1 call) = 3 calls
   - `mode='full'`: Current behavior — fetch all pages with content, MAX_PAGES cap, MAX_CHARS truncation
   - Summary return adds optional `pageTitles: [{id, name}]` and `firstPageContent: string` fields
   - `content` field always populated (summary: first page only; full: everything)
   - `fetchContent()` explicitly calls `fetchDocContent(docId, 'full')` to preserve string contract

2. **Add `ClickUpDocsAdapter.fetchFullDocContent`** — Convenience method for import workflow
   - Delegates to `fetchDocContent(docId, 'full')`
   - Used when user clicks "Import full doc"
   - Still applies rate limit retry logic (429 handling)
   - Still applies MAX_PAGES cap (200)

3. **`ClickUpDocsAdapter.listDocPages`** — Remove `content_format` from page listing
   - Pages returned without inline content (tree nodes only)
   - User clicks page → `fetchPageContent` fetches content on demand

4. **Webview preview pane** — Add import button
   - Show summary preview (first page + page list)
   - Add "Import full doc to workspace" button
   - Button triggers `fetchFullDocContent` and saves to local file
   - Show page navigation links (clicking a page fetches that page only)

### Phase 2: Page-Level Navigation

**Goal:** Allow user to fetch specific pages on demand

**Changes:**

1. **`ClickUpDocsAdapter.fetchPageContent`** — Keep single-page path; consolidate no-pageId path
   - Single page: fetches that page's content (1-2 API calls)
   - No pageId: delegate to `fetchFullDocContent(docId)` instead of duplicating logic

2. **Webview preview pane** — Page navigation
   - Render page titles list as clickable links
   - Clicking a page title fetches that page's content
   - Cache fetched pages to avoid re-fetching

### Phase 3: Import Workflow

**Goal:** Full doc import to local workspace

**Changes:**

1. **Backend** — New message handler `importFullDoc`
   - Calls `adapter.fetchFullDocContent(docId)`
   - Sanitize docId: `docId.replace(/[^a-zA-Z0-9_-]/g, '_')` before constructing file path
   - Saves to `.switchboard/docs/clickup-{sanitizedDocId}.md`
   - Sends `importProgress` messages during fetch (page count updates)
   - `_importInProgress` flag prevents concurrent imports
   - Returns file path

2. **Webview** — Import button handler
   - Sends `importFullDoc` message
   - Shows progress: "Importing page X of Y..."
   - Cancel button sets `_importCancelled` flag
   - On success, shows "Imported to {file path}" and opens file in editor

## Implementation Steps

### Step 0: Color Palette Fix
**Goal:** Match planning panel dark theme to kanban (currently too light slate grey)

- [ ] Add dark background CSS variables to `src/webview/planning.html`:
  - `--bg-color: #1a1a1a`
  - `--panel-bg: #000000`
  - `--panel-bg2: #0a0a0a`
  - `--border-color: #333333`
  - `--border-bright: #555555`
- [ ] Update text colors to match kanban:
  - `--text-primary: #e0e0e0`
  - `--text-secondary: #888888`
- [ ] Update card backgrounds to use dark colors:
  - `--card-bg: #0a0a0a`
  - `--card-bg-hover: #1a1a1a`
- [ ] Update body background from `var(--vscode-editor-background)` to `var(--panel-bg)`

### Step 0.5: Metadata Fix
**Goal:** Fix "Fetched from ClickUp Docs: undefined" metadata line

**File:** `src/services/ClickUpDocsAdapter.ts`

- [ ] Line 620 in `fetchDocContent`: Change `> Fetched from ClickUp Docs: ${doc.url}` to conditional: `${doc.url ? `> Fetched from ClickUp Docs: ${doc.url}\n\n` : '\n'}`
- [ ] Line 801 in `fetchPageContent`: Same conditional guard for `doc.url`
- [ ] **Clarification:** The ClickUp v3 API doesn't always return a `url` field on doc objects. Guarding with a ternary preserves the metadata when available and omits it when not, rather than removing it entirely.

### Step 0.6: Notion Loading State Fix
**Goal:** Fix Notion (and other container sources) showing "Loading..." indefinitely when no containers found or no key set

**File:** `src/webview/planning.js`

- [ ] In `handleContainersReady` function (line 533):
  - Current: `if (!containers || containers.length === 0) return;` — returns early without clearing loading placeholder
  - Fix: Replace early return with empty-state rendering:
    ```javascript
    if (!containers || containers.length === 0) {
        const docList = treePane.querySelector(`.doc-list[data-source-id="${sourceId}"]`);
        if (docList) {
            docList.innerHTML = '<div class="empty-state">(no containers available)</div>';
        }
        return;
    }
    ```
  - Add `.empty-state` CSS class in `planning.html` (muted text, centered)

### Step 0.7: UI Layout Alignment Fix
**Goal:** Fix vertical alignment between sidebar and document viewer; fix notion area horizontal alignment with breadcrumb header

**File:** `src/webview/planning.html`

- [ ] Ensure the main content area uses CSS grid with two equal-height columns:
  ```css
  .main-content {
      display: grid;
      grid-template-columns: 280px 1fr;
      grid-template-rows: 1fr;
      height: calc(100vh - 40px); /* minus tab bar */
  }
  ```
- [ ] Fix notion area (container filter row) to stack vertically below breadcrumb header, not horizontally alongside it:
  ```css
  .filter-row {
      display: block; /* not inline-flex */
      width: 100%;
  }
  ```
- [ ] Verify sidebar (`tree-pane`) and preview pane (`preview-pane`) both stretch to full grid row height

### Step 0.8: HTTP Error Message Localization
**Goal:** Convert technical HTTP error messages to plain English for better UX

**File:** `src/services/ClickUpDocsAdapter.ts`

- [ ] Add private helper method `_localizeHttpError`:
  ```typescript
  private _localizeHttpError(status: number, context: string): string {
      const messages: Record<number, string> = {
          400: 'Invalid request — please check the document ID',
          403: 'You don\'t have permission to access this document',
          404: 'Document not found or you don\'t have access',
          429: 'Too many requests, please wait a moment',
          500: 'ClickUp is experiencing issues, please try again',
          502: 'ClickUp is temporarily unavailable, please try again',
          503: 'ClickUp service is down, please try again later',
      };
      return messages[status] || `${context} failed (HTTP ${status})`;
  }
  ```
- [ ] Replace all `ClickUp doc fetch failed (HTTP ${status})` strings with `_localizeHttpError` calls:
  - Line 562: `fetchDocContent` doc metadata fetch error
  - Line 579: `fetchDocContent` page listing fetch error
  - Line 747: `fetchPageContent` doc fetch error
  - Line 768: `fetchPageContent` page fetch error
  - Line 792: `fetchPageContent` page listing error
- [ ] Apply same pattern to `LinearDocsAdapter.ts` if it has similar raw HTTP error strings

### Step 0.9: Cached Docs Mismatch Fix
**Goal:** Fix mismatch where header shows "(cached)" but sidebar shows "(no documents)"

**Investigation Results:**
- Preview shows "(cached)" because `fetchDocContent()` loads content from cache file (via `saveCachedContent()`)
- Sidebar shows "(no documents)" because `listDocuments()` returns empty array
- `listDocuments()` checks document ID map cache (`_getCachedDocumentIdMapRobust()`) which lists available documents
- **Root cause:** `saveCachedContent()` only saves markdown content to file, but does NOT update the document ID map
- The document ID map is only updated when documents are fetched from API, not when content is loaded from cache
- When API fails (e.g., rate limiting, network error), content can be cached but ID map remains empty

**Fix:**
- [ ] Add a new method `_updateDocumentIdMapEntry(docId: string, docTitle: string, docUrl?: string)` that:
  1. Reads the current document ID map via `_getCachedDocumentIdMapRobust()`
  2. Checks if `docId` already exists in the map
  3. If not, appends `{ docId, title: docTitle, url: docUrl || '' }` to the map
  4. Writes the updated map back via `this._cacheService.cacheDocumentIdMap('clickup', map, new Date().toISOString())`
- [ ] Call `_updateDocumentIdMapEntry` inside `fetchDocContent` after a successful fetch (both summary and full modes), right after `saveConfig` and `saveCachedContent` (around line 641)
- [ ] Call `_updateDocumentIdMapEntry` inside `fetchPageContent` after successful full-doc fetch (around line 863)
- [ ] Test: fetch a doc when API is available → disconnect network → reload panel → sidebar should still show the doc from ID map cache

### Step 0.10: Setup Menu Source Selection
**Goal:** Allow users to select which sources to show in the planning panel (hide unused sources)

**Files:** `src/webview/setup.html`, `src/services/SetupPanelProvider.ts`, `src/webview/planning.js`

- [ ] In `setup.html`: Add a "Planning Sources" section with checkboxes/toggles for each source:
  - ClickUp Docs, Linear Docs, Notion, Local Folder, Clipboard Import
  - Each checkbox has `data-source-id` matching the adapter `sourceId`
  - Default: all checked
- [ ] In `SetupPanelProvider.ts`:
  - Add handler for `savePlanningSources` message
  - Persist source selections to `.switchboard/planning-sources.json`
  - On panel load, send `planningSources` message with saved preferences
- [ ] In `planning.js`:
  - On `handleRootsReady`, filter source headers by enabled sources before rendering
  - If `planningSources` message received, update visibility of source sections
  - Sources not in the config file default to visible (backward compat)

### Step 0.11: Local Folder Hierarchy Display
**Goal:** Show folder structure with subheaders instead of flat file list

**Files:** `src/services/LocalFolderService.ts`, `src/services/ResearchImportService.ts`, `src/webview/planning.js`

- [ ] In `ResearchImportService.ts`: Add `isFolder?: boolean` to the `ResearchFile` interface (currently lacks a kind/directory flag)
- [ ] In `LocalFolderService.ts`:
  - Modify `listFiles()` to walk directory tree recursively; emit folder nodes with `isFolder: true` and file nodes with `isFolder: false`
  - Include `parentId` concept: each entry gets a `parentId` field (relative path of parent folder, or `undefined` for root)
- [ ] In `ResearchImportService.ts`:
  - Update `LocalFolderResearchAdapter.fetchChildren(parentId?)` to return folder `TreeNode` nodes when `parentId` is a folder path (currently returns empty for non-root)
  - Root call (`parentId === undefined`): return top-level folders and files
  - Folder call: return children of that folder
- [ ] In `planning.js`:
  - Render folder nodes as expandable tree items (same pattern as ClickUp space/folder nodes)
  - File nodes render as leaf documents
  - Keep relative path as file ID for content fetching

### Step 1: Modify `fetchDocContent` for summary-only mode
**File:** `src/services/ClickUpDocsAdapter.ts`, `src/services/PlanningPanelProvider.ts`

- [ ] Add `mode` parameter to `fetchDocContent` signature:
  ```typescript
  async fetchDocContent(docId: string, mode: 'summary' | 'full' = 'summary'): Promise<{
      success: boolean; docTitle?: string; content?: string; error?: string;
      pageTitles?: Array<{id: string; name: string}>;
      firstPageContent?: string;
      totalPages?: number;
  }>
  ```
- [ ] When `mode='summary'`:
  1. Fetch doc metadata (1 call) — same as current lines 547-565
  2. Fetch page listing WITHOUT `content_format` (1 call):
     - Change line 568 from `/pages?content_format=text%2Fmd&max_page_depth=-1` to `/pages?max_page_depth=-1`
     - This returns page metadata (id, name, parent_id) without inline content
  3. Extract first page ID from the listing
  4. Fetch first page content (1 call): `/pages/${firstPageId}?content_format=text%2Fmd`
  5. Build return object:
     - `content`: first page content formatted as markdown (for backward compat with preview renderer)
     - `firstPageContent`: same content (explicit field for new callers)
     - `pageTitles`: array of `{id, name}` from the listing
     - `totalPages`: count of pages in the listing
  6. Skip the per-page fetch loop entirely
  7. Skip MAX_CHARS truncation (single page won't exceed 50k chars)
  8. Cache summary content via `saveCachedContent`
- [ ] When `mode='full'`:
  - Execute current logic exactly (lines 588-643) — the full page-by-page fetch loop with MAX_PAGES cap, MAX_CHARS truncation, and rate limit retry
- [ ] Update `fetchContent()` at line 88 to explicitly call `fetchDocContent(docId, 'full')` instead of the default `'summary'` — this preserves the `string` return contract
- [ ] Remove `content_format=text%2Fmd` from `listDocPages` (line 660) — same optimization for tree expansion. Pages returned without inline content; user clicks page → `fetchPageContent` fetches content on demand
- [ ] Update `PlanningPanelProvider._handleFetchPreview` (line 460) to handle new return structure:
  - When `pageTitles` is present, include it in the `previewReady` message
  - When `totalPages` is present, include it for "Showing page 1 of N" display

### Step 2: Add `fetchFullDocContent` method and consolidate `fetchPageContent`
**File:** `src/services/ClickUpDocsAdapter.ts`, `src/services/ResearchImportService.ts`

- [ ] Add convenience method that delegates to `fetchDocContent`:
  ```typescript
  async fetchFullDocContent(docId: string): Promise<{ success: boolean; docTitle?: string; content?: string; error?: string }> {
      return this.fetchDocContent(docId, 'full');
  }
  ```
- [ ] Refactor `fetchPageContent` no-pageId path (lines 780-863): replace the duplicated full-doc fetch logic with a delegation to `fetchFullDocContent(cleanDocId)`, then format the result with hierarchical indentation if needed
- [ ] Add `fetchFullDocContent` to `ResearchSourceAdapter` interface as optional method:
  ```typescript
  fetchFullDocContent?(docId: string): Promise<{ success: boolean; docTitle?: string; content?: string; error?: string }>;
  ```

### Step 3: Add import button to webview
**Files:** `src/webview/planning.html`, `src/webview/planning.js`

- [ ] In `planning.html`: Add "Import full doc" button in the preview action bar (next to existing "Append to Planner Prompt" and "Import & Copy Link" buttons):
  ```html
  <button id="btn-import-full-doc" class="action-btn" disabled>
      📥 Import Full Doc
  </button>
  ```
- [ ] In `planning.js`:
  - Add click handler for `btn-import-full-doc`:
    ```javascript
    btnImportFullDoc.addEventListener('click', () => {
        vscode.postMessage({
            type: 'importFullDoc',
            sourceId: state.currentSourceId,
            docId: state.currentDocId,
            docName: state.currentDocName
        });
        btnImportFullDoc.disabled = true;
        statusEl.textContent = 'Importing...';
    });
    ```
  - Enable button only when `sourceId === 'clickup'` and a doc is selected
  - Handle `importProgress` messages: update status text with "Importing page X of Y..."
  - Handle `importFullDocResult` messages: show success path or error
- [ ] Update `handlePreviewReady` to render page titles list below the first-page content:
  ```javascript
  if (msg.pageTitles && msg.pageTitles.length > 1) {
      const navHtml = `<div class="page-nav">
          <div class="page-nav-header">Pages (${msg.totalPages}):</div>
          ${msg.pageTitles.map(p =>
              `<a class="page-link" data-page-id="${p.id}">${p.name}</a>`
          ).join('')}
      </div>`;
      // Append below markdown preview
  }
  ```

### Step 4: Add backend import handler
**File:** `src/services/PlanningPanelProvider.ts`

- [ ] Add `importFullDoc` case in `_handleMessage` switch (after `importAndCopyLink` case around line 193):
  ```typescript
  case 'importFullDoc': {
      await this._handleImportFullDoc(workspaceRoot, msg.sourceId, msg.docId, msg.docName);
      break;
  }
  ```
- [ ] Add `_importInProgress` flag as class property: `private _importInProgress = false;`
- [ ] Implement `_handleImportFullDoc`:
  1. Guard: if `_importInProgress`, send error "Import already in progress"
  2. Set `_importInProgress = true`
  3. Sanitize docId: `const safeId = docId.replace(/[^a-zA-Z0-9_-]/g, '_');`
  4. Get adapter, call `adapter.fetchFullDocContent(cleanDocId)`
  5. On success: write content to `.switchboard/docs/clickup-${safeId}.md`
  6. Send `importFullDocResult` message with `{ success: true, filePath, content }`
  7. Open file in editor: `vscode.workspace.openTextDocument(filePath)` then `vscode.window.showTextDocument(doc)`
  8. On error: send `importFullDocResult` message with `{ success: false, error }`
  9. Finally: set `_importInProgress = false`
- [ ] Cache full content via `saveCachedContent` (overwrites any summary cache)

### Step 5: Add page navigation
**Files:** `src/webview/planning.js`, `src/services/PlanningPanelProvider.ts`

- [ ] In `planning.js`: Add click delegation on `.page-link` elements (event delegation on the page-nav container):
  ```javascript
  document.addEventListener('click', (e) => {
      const pageLink = e.target.closest('.page-link');
      if (!pageLink) return;
      const pageId = pageLink.dataset.pageId;
      vscode.postMessage({
          type: 'fetchPageContent',
          sourceId: state.currentSourceId,
          docId: state.currentDocId,
          pageId: pageId
      });
  });
  ```
- [ ] In `PlanningPanelProvider.ts`: Add `fetchPageContent` case in `_handleMessage`:
  ```typescript
  case 'fetchPageContent': {
      const adapter = this._researchImportService.getAdapter(msg.sourceId);
      if (adapter?.fetchPageContent) {
          const result = await adapter.fetchPageContent(msg.docId, msg.pageId);
          this._panel?.webview.postMessage({
              type: 'previewReady',
              sourceId: msg.sourceId,
              content: result.content,
              docName: result.docName
          });
      }
      break;
  }
  ```
- [ ] In `planning.js`: Cache fetched pages in webview state to avoid re-fetching:
  ```javascript
  state.cachedPages = state.cachedPages || {};
  // On page fetch success:
  state.cachedPages[pageId] = result.content;
  ```
- [ ] Update preview rendering on page click: replace markdown preview content with the fetched page

## Files to Change

- `src/webview/planning.html`
  - Step 0: Color palette fix (dark theme CSS variables)
  - Step 0.6: Add `.empty-state` CSS class
  - Step 0.7: UI layout alignment (CSS grid for main content, filter-row fix)
  - Step 3: Add "Import full doc" button HTML

- `src/webview/setup.html`
  - Step 0.10: Add "Planning Sources" section with checkboxes/toggles

- `src/services/SetupPanelProvider.ts`
  - Step 0.10: Save/load source selection preferences, `savePlanningSources` handler

- `src/services/LocalFolderService.ts`
  - Step 0.11: Return folder structure with `isFolder` flag and `parentId`

- `src/services/ResearchImportService.ts`
  - Step 0.11: Add `isFolder?: boolean` to `ResearchFile` interface
  - Step 0.11: Update `LocalFolderResearchAdapter.fetchChildren()` to return folder nodes
  - Step 2: Add `fetchFullDocContent?` to `ResearchSourceAdapter` interface

- `src/webview/planning.js`
  - Step 0.6: Notion loading state fix (clear loading placeholder when no containers)
  - Step 0.10: Filter sources by enabled preferences in `handleRootsReady`
  - Step 3: Import button click handler, `importProgress`/`importFullDocResult` message handling
  - Step 3: Page titles list rendering in `handlePreviewReady`
  - Step 5: Page link click delegation, page cache in state

- `src/services/ClickUpDocsAdapter.ts`
  - Step 0.5: Guard `doc.url` in metadata lines 620, 801
  - Step 0.8: Add `_localizeHttpError` method, replace raw HTTP error strings (lines 562, 579, 747, 768, 792)
  - Step 0.9: Add `_updateDocumentIdMapEntry` method, call after successful fetch
  - Step 1: Add `mode` parameter to `fetchDocContent`, summary-only path, update `fetchContent()` to call with `'full'`
  - Step 1: Remove `content_format` from `listDocPages` page listing (line 660)
  - Step 2: Add `fetchFullDocContent` convenience method, refactor `fetchPageContent` no-pageId path

- `src/services/PlanningPanelProvider.ts`
  - Step 1: Update `_handleFetchPreview` to handle `pageTitles`, `totalPages` in return structure
  - Step 4: Add `importFullDoc` case, `_handleImportFullDoc` method, `_importInProgress` flag
  - Step 5: Add `fetchPageContent` case in `_handleMessage`

- `src/services/LinearDocsAdapter.ts`
  - Step 0.8: Apply HTTP error localization if it has raw error strings

## Testing

- [ ] Verify summary preview loads with 2-3 API calls (check console logs for `[ClickUpDocsAdapter] Fetching doc:` count)
- [ ] Verify `fetchContent()` still returns full content string (backward compat)
- [ ] Verify `listDocPages` returns page nodes without content (tree expansion no longer burns API calls)
- [ ] Verify import button fetches full content and saves to `.switchboard/docs/`
- [ ] Verify import progress messages display during long fetches
- [ ] Verify `_importInProgress` flag prevents double-import
- [ ] Verify page navigation fetches single page on click
- [ ] Verify page cache prevents re-fetching already-viewed pages
- [ ] Verify rate limit retry still works for 429 errors
- [ ] Verify cached content is still used for re-views
- [ ] Verify `_updateDocumentIdMapEntry` populates sidebar after cache-only fetch
- [ ] Verify `doc.url` guard removes "undefined" from metadata without removing valid URLs
- [ ] Verify `_localizeHttpError` returns plain English for 403/404/429/500
- [ ] Verify color palette matches kanban dark theme
- [ ] Verify empty-state rendering when no containers available
- [ ] Verify sidebar/preview vertical alignment with CSS grid
- [ ] Verify source selection checkboxes persist and filter planning panel
- [ ] Verify local folder hierarchy shows expandable folders

## Open Questions (Resolved)

1. **Cache full doc after import?** → Yes. Step 4 specifies `saveCachedContent` overwrites summary cache with full content.
2. **Show page count in preview?** → Yes. Step 1 returns `totalPages`; Step 3 renders "Pages (N):" header in page nav.
3. **"Load more pages" button vs. individual page navigation?** → Individual page navigation. Each page title is a clickable link that fetches on demand. Simpler UX, avoids batch-fetch rate limit issues.
4. **Where to save imported docs?** → `.switchboard/docs/clickup-{sanitizedDocId}.md`. Sanitized docId prevents path traversal.

## Verification Plan
### Automated Tests
- Existing: No unit tests currently cover `ClickUpDocsAdapter` fetch logic directly (API-dependent). Manual verification via console log counting is the primary method.
- New: Add integration test for `_localizeHttpError` mapping (pure function, no API dependency).
- New: Add unit test for `_updateDocumentIdMapEntry` with mock cache service.
- New: Add unit test for docId sanitization regex (`/[^a-zA-Z0-9_-]/g`).

## Switchboard State
**Kanban Column:** CODE REVIEWED
**Status:** active
**Last Updated:** 2026-04-21T03:19:40.118Z
**Format Version:** 1

---

## Review Findings & Fixes (2025-07-14)

### Stage 1: Adversarial Critique

| # | Severity | Finding | Root Cause |
|---|----------|---------|------------|
| 1 | 🔴 CRITICAL | `state.currentDocId` never set in `planning.js` — import button and page navigation are completely non-functional | Variable renamed to `activeDocId` during implementation but new summary-mode references used stale name |
| 2 | 🟠 MAJOR | `listDocPages` still fetches with `content_format=text%2Fmd` — burns API calls on tree expansion | Plan requirement to remove `content_format` was not implemented |
| 3 | 🟠 MAJOR | Summary mode returns `{ pages }` with no `content`/`firstPageContent`/`totalPages` — preview shows only page index, no document content | Plan specified first-page content fetch in summary mode; implementation returned page list only |
| 4 | 🟠 MAJOR | No `_importInProgress` guard — concurrent imports possible on double-click | Plan called for concurrency flag; not implemented |
| 5 | 🟠 MAJOR | No docId sanitization in `_handleImportFullDoc` — malformed docId could cause path traversal in cache | Plan specified sanitization regex; not implemented |
| 6 | 🟡 NIT | `LinearDocsAdapter.fetchDocContent` doesn't guard `doc.url` — "undefined" appears in metadata header | Plan said "Apply same pattern to LinearDocsAdapter"; not done |
| 7 | 🟡 NIT | No `importProgress` messages during full import — UI appears frozen | Plan specified progress feedback; deferred as enhancement |
| 8 | 🟡 NIT | `fetchDocContent` default is `'full'` not `'summary'` — deviates from plan but safer for backward compat | Implementation choice; no fix needed |

### Stage 2: Balanced Synthesis — Fixes Applied

| # | Fix | File | Change |
|---|-----|------|--------|
| 1 | `state.currentDocId` → `state.activeDocId` (3 refs) | `src/webview/planning.js` | Lines 485, 512, 522 |
| 2 | Remove `content_format=text%2Fmd` from `listDocPages` | `src/services/ClickUpDocsAdapter.ts` | Line 747: endpoint now `/pages?max_page_depth=-1` only |
| 3 | Summary mode fetches first page content + returns `content`, `firstPageContent`, `totalPages` | `src/services/ClickUpDocsAdapter.ts` | Lines 612-663: added first-page fetch, header construction, new return fields |
| 3a | Updated `fetchDocContent` return type to include `firstPageContent` and `totalPages` | `src/services/ClickUpDocsAdapter.ts` | Line 584: extended Promise type |
| 3b | `_handleFetchPreview` passes `content` and `totalPages` to webview | `src/services/PlanningPanelProvider.ts` | Lines 476-484: added `content`, `totalPages` to `previewReady` message |
| 3c | Webview renders content alongside page list when available | `src/webview/planning.js` | Lines 505-512: conditional content rendering below page nav |
| 4 | Added `_importInProgress` flag + concurrency guard | `src/services/PlanningPanelProvider.ts` | Line 37: new property; lines 676-680: guard check; line 713: `finally` clear |
| 5 | Added docId sanitization (`/[^a-zA-Z0-9_-]/g` → `_`) | `src/services/PlanningPanelProvider.ts` | Line 683: `safeDocId` used for fetch and cache |
| 6 | Guard `doc.url` in LinearDocsAdapter | `src/services/LinearDocsAdapter.ts` | Line 280: ternary guard on `doc.url` |

### Files Changed

- `src/webview/planning.js` — Fix `currentDocId` → `activeDocId`; render content in summary preview
- `src/services/ClickUpDocsAdapter.ts` — Remove `content_format` from `listDocPages`; add first-page content to summary mode; extend return type
- `src/services/PlanningPanelProvider.ts` — Add `_importInProgress` guard; docId sanitization; pass content/totalPages in preview
- `src/services/LinearDocsAdapter.ts` — Guard `doc.url` in metadata header

### Validation Results

- **TypeScript**: `npx tsc --noEmit` — zero errors in changed files (pre-existing errors in `ClickUpSyncService.ts` and `KanbanProvider.ts` are unrelated)
- **Manual verification needed**: 
  - [ ] ClickUp doc preview shows first-page content + page navigation
  - [ ] Page navigation clicks fetch individual page content
  - [ ] "Import full doc" button triggers full import (not disabled/broken)
  - [ ] Double-clicking "Import full doc" shows "already in progress" error
  - [ ] Tree expansion for ClickUp docs no longer fetches inline content
  - [ ] Linear doc preview shows clean metadata (no "undefined" URL)

### Remaining Risks

1. **Summary mode adds 1 extra API call** (first page content) — total 3 calls per preview instead of 2. Acceptable trade-off for showing actual content.
2. **`safeDocId` used for `fetchFullDocContent`** — if the ClickUp API requires the original docId format (e.g. with colons), sanitization could break the fetch. The `fetchFullDocContent` method internally strips `doc:` prefix, so alphanumeric docIds should be safe. Monitor for edge cases.
3. **No import progress/cancel** — deferred. Large docs (>50 pages) may appear frozen during import. Low risk for typical usage.
4. **Sync methods still call `fetchDocContent` without mode** — defaults to `'full'`, which is correct for sync but still burns full API calls. Future optimization: add a `sync` mode that fetches only changed pages.
