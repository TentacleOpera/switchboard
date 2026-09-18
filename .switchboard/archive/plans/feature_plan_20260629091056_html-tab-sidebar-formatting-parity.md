# HTML Tab Sidebar Formatting Parity with Design Panel

## Goal

Rewrite the Planning panel's HTML tab sidebar renderer to use the same folder-grouped, card-based layout as the Design panel's HTML Previews tab, replacing the current flat unstyled document list with proper folder headers, subfolder headers, link buttons, and document cards with Serve & Open and Link Doc actions.

### Problem
The HTML tab sidebar in `planning.html` (`#tree-pane-planning-html`) renders a flat, unstyled list of document names. It lacks the card-based layout with folder headers/subheaders, link buttons, serve & open buttons, subtitles, and proper visual hierarchy that the Design panel's HTML Previews tab (`design.html` / `design.js`) has. The user describes the current implementation as incomplete and demands parity with `design.html`'s HTML Previews tab.

### Root Cause
The `renderPlanningHtmlDocs()` function in `planning.js` (line 6500) creates flat `source-doc-card` / `source-doc-title` elements — CSS classes that **do not exist** anywhere in `planning.html`'s stylesheet (verified: zero matches for `source-doc-card` or `source-doc-title` in planning.html). The result is unstyled `<div>` elements with no visual treatment.

In contrast, `design.js`'s `renderHtmlDocs()` (line 837) uses a shared rendering pipeline:
- `renderFolderGroupedDocs()` (line 621) — groups docs by source folder, renders folder link headers
- `renderSubfolderGroups()` (line 576) — renders subfolder link headers
- `buildFolderLinkHeader()` (line 514) / `buildSubfolderLinkHeader()` (line 542) — folder/subfolder headers with "Link" buttons
- `renderDocCard()` (line 977) — creates proper `.tree-node` cards with `.card-title`, `.card-subtitle`, `.card-actions`, and action buttons (Serve & Open, Link Doc)

All the required CSS classes (`.tree-node`, `.card-text`, `.card-title`, `.card-subtitle`, `.card-actions`, `.card-icon-btn`, `.folder-subheader`, `.source-folder-header`, `.folder-link-btn`, `.source-doc-list`, `.html-serve-btn`, `.html-link-btn`) already exist in `planning.html`'s stylesheet — they are used by the Docs and Tickets tabs. The JS simply doesn't use them.

### Background
The planning panel and design panel share a common visual language (card-based sidebar with folder grouping). The design panel has a mature, well-structured rendering pipeline (`renderFolderGroupedDocs` + `renderDocCard` + `buildFolderLinkHeader` + `renderSubfolderGroups`) that all four design tabs use. The planning panel's HTML tab was implemented separately and bypassed this pipeline entirely, producing bare unstyled divs.

**Key finding**: `planning.js` already has its own `renderDocCard()` function (line 1605) used by the Docs tab. However, it does NOT handle the `'Serve & Open'` action — it only handles `'Link Doc'`, `'Delete'`, `'Sync'`, `'Import'`, and `'Set Context'`. This must be extended to match `design.js`'s implementation. The four folder-grouping helper functions (`renderFolderGroupedDocs`, `renderSubfolderGroups`, `buildFolderLinkHeader`, `buildSubfolderLinkHeader`) do NOT exist in `planning.js` and must be ported from `design.js`.

**Backend handlers confirmed present**: All three message types (`serveAndOpenHtml` at PlanningPanelProvider.ts line 2421, `linkToDocument` at line 2620, `linkToFolder` at line 2624) already exist in the planning panel's backend provider. No new message types or backend changes are needed.

## Metadata
- **Tags**: ui, ux, refactor
- **Complexity**: 5/10

## User Review Required
No user review required. This is a UI rendering refactor that replaces non-functional unstyled divs with the established card-based layout already used by other tabs in the same panel. No new product scope, no backend changes, no data migrations.

## Complexity Audit

### Routine
- All CSS classes already exist in `planning.html` — no CSS changes needed
- All backend message handlers already exist in `PlanningPanelProvider.ts` — no backend changes needed
- `planning.js` already has `renderDocCard()` (line 1605) — only needs one new action branch added
- The `renderPlanningHtmlDocs()` function already has the toggle row, Manage Folders button, search filtering, and empty-state logic — only the card rendering loop needs replacement
- `loadPlanningHtmlPreview()` (line 6574) already exists and works — the card click handler reuses it

### Complex / Risky
- Porting 4 helper functions (`renderFolderGroupedDocs`, `renderSubfolderGroups`, `buildFolderLinkHeader`, `buildSubfolderLinkHeader`) from `design.js` (lines 514-668) into `planning.js` — these are ~155 lines of code that must be adapted to planning.js's state object and patterns
- Extending `planning.js`'s `renderDocCard()` to handle the `'Serve & Open'` action — without this, the action button renders incorrectly as a full-width text button instead of a compact icon button
- Ensuring the ported `renderFolderGroupedDocs` correctly handles the planning panel's `folderPaths` format (which may differ from design.js's format — both use the same `sourceId`/`nodes`/`folderPaths` root entry structure, so this should be compatible)

## Edge-Case & Dependency Audit
- **Race Conditions**: None. `renderPlanningHtmlDocs()` is called synchronously in response to message handlers (`planningHtmlDocsReady` at line 6678, `planningHtmlDocsUpdated` at line 6695). No concurrent rendering paths.
- **Security**: No security implications. The `serveAndOpenHtml` handler (PlanningPanelProvider.ts line 2421) validates file access via `fs.promises.access()` before serving. The `linkToDocument` and `linkToFolder` handlers copy paths to clipboard — no injection risk.
- **Side Effects**: The rewritten function replaces the flat list with folder-grouped cards. The `state.activeSource` and `state.activeDocId` selection logic is preserved (the card's `isSelected` flag uses the same comparison as the current `source-doc-card.selected` class). The search filtering (`state.planningHtmlDocsSearch`) and workspace filter (`state.planningHtmlWorkspaceRootFilter`) are preserved.
- **Dependencies & Conflicts**: This plan is independent of the other two epic subtasks (tab reposition and scanline removal). No file conflicts — all three plans touch `planning.html` but in different sections (tab bar vs. scanline div vs. no HTML change for this plan). This plan touches `planning.js` only.
- **Empty state preservation**: The current function (line 6542) distinguishes between "no folders configured" (`!folderPaths || folderPaths.length === 0`) and "no HTML files found in configured folders". This distinction must be preserved in the rewrite — it guides the user to the correct action (configure folders vs. search differently).
- **Claudify theme**: `planning.html` has `.theme-claudify` overrides for `.tree-node` cards. The ported `renderDocCard` produces `.tree-node` elements, so these overrides will apply automatically. No extra work needed.

## Dependencies
- None

## Adversarial Synthesis
Key risks: (1) `planning.js`'s `renderDocCard` lacks a `'Serve & Open'` handler — without extending it, the action button renders as a wrong-styled text button; (2) the 4 ported helper functions must correctly handle planning.js's state object and `folderPaths` format; (3) the dual empty-state messages must be preserved. Mitigations: extend `renderDocCard` with the exact `'Serve & Open'` branch from design.js (lines 1021-1024, 1054-1061); the root entry structure (`sourceId`/`nodes`/`folderPaths`) is identical between both panels; explicitly preserve both empty-state branches in the rewrite.

## Proposed Changes

### File: `src/webview/planning.js`

#### Change 1: Port 4 helper functions from `design.js` (lines 514-668)

Add the following 4 functions to `planning.js`, ported from `design.js`. Place them near the existing `renderDocCard()` function (after line 1722):

1. **`buildFolderLinkHeader(folderPath, docCount)`** — from design.js line 514. Creates a `.folder-subheader.source-folder-header` div with folder name label and a "Link" button that sends `{ type: 'linkToFolder', folderPath }`.

2. **`buildSubfolderLinkHeader(folderId, folderName, docCount)`** — from design.js line 542. Creates a `.folder-subheader` div with subfolder name label and a "Link" button that sends `{ type: 'linkToFolder', folderPath: folderId }`.

3. **`renderSubfolderGroups(docList, docs, subfolderNodes, createCardFn, showAll)`** — from design.js line 576. Groups docs by parent folder ID, renders subfolder headers + cards, then root-level docs.

4. **`renderFolderGroupedDocs(docList, docNodes, folderNodes, folderPaths, search, createCardFn)`** — from design.js line 621. Top-level folder grouping: in search mode, shows only folders with matches; in no-search mode, shows all configured folders (including empty ones) plus any unconfigured source folders.

**Note**: These functions use `vscode.postMessage` which is available in planning.js's scope. They use optional chaining (`?.`) which is supported in VS Code's Chromium webview. No adaptation needed — port verbatim.

#### Change 2: Extend `renderDocCard()` to handle `'Serve & Open'` action (line 1605)

Add a new branch to `renderDocCard()` matching `design.js`'s implementation. In the `actions.forEach` loop (around line 1649), add a case for `'Serve & Open'`:

**Button styling** (add after the `'Link Doc'` / `'Delete'` branch, around line 1662):
```javascript
} else if (action === 'Serve & Open') {
    btn.className = 'card-icon-btn html-serve-btn';
    btn.innerHTML = '<span class="btn-label">Open</span>';
    btn.title = 'Start local server and open in browser';
    btn.setAttribute('aria-label', 'Serve and open in browser');
```

**Click handler** (add after the `'Link Doc'` handler, around line 1689):
```javascript
} else if (action === 'Serve & Open') {
    vscode.postMessage({
        type: 'serveAndOpenHtml',
        docId: nodeId,
        docName: title,
        absolutePath: nodeMetadata ? nodeMetadata.absolutePath : undefined,
        sourceFolder: nodeMetadata ? nodeMetadata.sourceFolder : undefined
    });
```

This matches design.js lines 1021-1024 (styling) and 1054-1061 (handler) exactly.

#### Change 3: Add `createPlanningHtmlDocCard()` function

Add this function near `renderPlanningHtmlDocs()` (after line 6572):

```javascript
function createPlanningHtmlDocCard(doc, sourceId) {
    return renderDocCard({
        title: doc.name || doc.id,
        subtitle: 'HTML',
        sourceId,
        nodeId: doc.id,
        nodeMetadata: doc.metadata,
        actions: ['Serve & Open', 'Link Doc'],
        isSelected: state.activeSource === sourceId && state.activeDocId === doc.id,
        clickHandler: () => {
            loadPlanningHtmlPreview(sourceId, doc.id, doc.name, doc.metadata && doc.metadata.sourceFolder);
        }
    });
}
```

This matches design.js's `createHtmlDocCard()` (line 892) except `clickHandler` calls `loadPlanningHtmlPreview` (planning.js line 6574) instead of `loadDocumentPreview`.

#### Change 4: Rewrite `renderPlanningHtmlDocs()` (line 6500)

Replace the flat-list rendering loop (lines 6551-6571) with a call to `renderFolderGroupedDocs`. Preserve the existing toggle row, Manage Folders button, search filtering, and dual empty-state logic.

**Replace lines 6551-6571** (the `docNodes.forEach` loop) with:

```javascript
renderFolderGroupedDocs(docList, docNodes, folderNodes, folderPaths, search,
    (doc) => createPlanningHtmlDocCard(doc, sourceId || 'planning-html-folder'));
```

The rest of the function (lines 6500-6549) stays unchanged — it already creates the toggle row, Manage Folders button, `docList` container, filters document/folder nodes, applies search filtering, and handles the dual empty-state messages.

**No changes to the empty-state logic** (lines 6542-6549): The current dual empty-state messages are preserved:
- "Configure a folder using Manage Folders." — when no folders are configured
- "No HTML files found in configured folders." — when folders exist but no HTML files match

### File: `src/webview/planning.html`
No CSS changes needed — all required classes (`.tree-node`, `.card-text`, `.card-title`, `.card-subtitle`, `.card-actions`, `.card-icon-btn`, `.folder-subheader`, `.source-folder-header`, `.folder-link-btn`, `.source-doc-list`, `.html-serve-btn`, `.html-link-btn`) already exist in the stylesheet.

### Backend (PlanningPanelProvider.ts)
No changes needed — all three message handlers already exist:
- `serveAndOpenHtml` (line 2421) — starts local server, opens in browser
- `linkToDocument` (line 2620) — copies validated document path to clipboard
- `linkToFolder` (line 2624) — copies folder path to clipboard

## Verification Plan

### Automated Tests
No automated tests required. The test suite will be run separately by the user.

### Manual Verification
1. Open the Switchboard Planning panel and switch to the HTML tab.
2. Configure one or more folders via "Manage Folders".
3. Verify the sidebar shows:
   - Folder headers with folder name and document count (e.g. `my-folder (3)`)
   - "Link" buttons on each folder header that copy the folder path
   - Subfolder headers (if the folder has subdirectories) with "Link" buttons
   - Document cards with title, "HTML" subtitle, and action buttons ("Open" / "Link")
   - Proper card styling: border, background, hover state, selected state
4. Click a document card — verify the HTML preview loads in the right pane.
5. Click "Open" (Serve & Open) — verify a local server starts and the file opens in a browser.
6. Click "Link" on a card — verify the document path is copied to clipboard.
7. Click "Link" on a folder header — verify the folder path is copied to clipboard.
8. Type in the search box — verify filtering works and only matching folders/docs are shown.
9. Test with the Claudify theme — verify card styling adapts correctly.
10. Test with the Afterburner theme — verify card styling and neon effects render correctly.
11. Collapse the sidebar — verify the toggle button and collapsed state work.
12. Verify the empty-state messages: with no folders configured, see "Configure a folder using Manage Folders."; with folders configured but no HTML files, see "No HTML files found in configured folders."

**Recommendation**: Complexity 5/10 → Send to Coder.

---

## Code Review (Reviewer Pass)

### Stage 1 — Grumpy Principal Engineer

> *"You ported four functions verbatim from design.js. Verbatim! And then you couldn't even be bothered to run `node --check` on the file before declaring 'implementation complete.' You know what happened? You inserted the `Serve & Open` branch AFTER the closing brace of the `Import` branch, creating a dangling `} else if` that makes the ENTIRE planning.js file fail to parse. The whole Planning panel is dead. Every tab. Dead. Because you couldn't count braces."*

**CRITICAL — Syntax error: dangling `} else if` in `renderDocCard` click handler** (`planning.js` line 1712)
The `Serve & Open` click handler branch was inserted after a standalone `}` that closed the `Import` branch, producing:
```javascript
                    } else if (action === 'Import') {
                        vscode.postMessage({ ... });
                    }           // ← closes Import branch
                    } else if (action === 'Serve & Open') {  // ← EXTRA } — closes the arrow callback, then dangles
```
`node --check` output: `SyntaxError: missing ) after argument list at line 1712`. The entire `planning.js` module fails to load — **every Planning panel tab is broken**, not just HTML.

**NIT — `Link Doc` sourceFolder guard diverges from design.js**: planning.js's `Link Doc` handler has a `console.error` guard when `nodeMetadata?.sourceFolder` is missing (lines 1684–1687), while design.js sends unconditionally. This is a planning.js-specific enhancement, not a bug — but it means the two panels behave differently on malformed metadata. Acceptable; documenting for awareness.

**NIT — No `aria-label` on `Serve & Open` in design.js reference**: planning.js adds `btn.setAttribute('aria-label', 'Serve and open in browser')` (line 1666) which design.js does not have. This is an improvement over the reference. No issue.

### Stage 2 — Balanced Synthesis

**Keep**:
- All four ported helper functions (`buildFolderLinkHeader`, `buildSubfolderLinkHeader`, `renderSubfolderGroups`, `renderFolderGroupedDocs`) — verified verbatim against design.js lines 514–669. Correct.
- `createPlanningHtmlDocCard` — matches design.js `createHtmlDocCard` (line 892) with correct `loadPlanningHtmlPreview` substitution. Correct.
- `renderPlanningHtmlDocs` rewrite — toggle row, Manage Folders button, search filtering, dual empty-state messages, and `renderFolderGroupedDocs` call all present and correct.
- `Serve & Open` button styling (lines 1662–1666) — matches design.js lines 1021–1024. Correct.
- All CSS classes confirmed present in `planning.html` stylesheet.
- All three backend handlers (`serveAndOpenHtml`, `linkToDocument`, `linkToFolder`) confirmed in `PlanningPanelProvider.ts`.

**Fix now**:
- **CRITICAL**: Remove the extra `}` at the former line 1711 that prematurely closed the `Import` branch, causing the `Serve & Open` `else if` to dangle. Merge the two branches into a proper `if/else if` chain.

**Defer**: Nothing.

### Code Fixes Applied

**Fix 1 (CRITICAL): `src/webview/planning.js` — removed duplicate closing brace in `renderDocCard` click handler**

Before (broken):
```javascript
                        });
                    }
                    } else if (action === 'Serve & Open') {
```

After (fixed):
```javascript
                        });
                    } else if (action === 'Serve & Open') {
```

The standalone `}` that closed the `Import` branch was removed, allowing the `Serve & Open` branch to properly continue the `if/else if` chain.

### Verification Results
- **Syntax check (`node --check src/webview/planning.js`)**: PASSED (exit code 0) after fix. FAILED before fix (`SyntaxError: missing ) after argument list` at line 1712).
- **Ported functions fidelity**: All 4 helper functions match design.js verbatim (minus JSDoc comments). ✓
- **`createPlanningHtmlDocCard`**: Matches design.js `createHtmlDocCard` with correct `loadPlanningHtmlPreview` call. ✓
- **`renderPlanningHtmlDocs` empty-state logic**: Dual messages preserved — "Configure a folder using Manage Folders." and "No HTML files found in configured folders." ✓
- **CSS classes**: All 12 required classes confirmed in `planning.html` stylesheet (`.tree-node`, `.card-text`, `.card-title`, `.card-subtitle`, `.card-actions`, `.card-icon-btn`, `.folder-subheader`, `.source-folder-header`, `.folder-link-btn`, `.source-doc-list`, `.html-serve-btn`, `.html-link-btn`). ✓
- **Backend handlers**: `serveAndOpenHtml` (line 2421), `linkToDocument` (line 2620), `linkToFolder` (line 2624) all present in `PlanningPanelProvider.ts`. ✓
- **No `planning.html` CSS changes needed**: Confirmed — all classes pre-exist. ✓

### Files Changed
- `src/webview/planning.js` — fixed CRITICAL syntax error in `renderDocCard` click handler (removed duplicate `}` at former line 1711)

### Remaining Risks
- **NIT**: The `Link Doc` handler's `sourceFolder` guard (console.error + return) diverges from design.js. If a doc card is created with missing `sourceFolder` metadata, the Link button silently does nothing in planning.js but sends a message in design.js. Low risk — metadata should always be present for HTML docs from configured folders.
- **Pre-existing**: `d.name.substring(d.name.lastIndexOf('.'))` at line 6673 could throw if `d.name` is undefined. Same pattern exists in design.js. Not introduced by this plan.
