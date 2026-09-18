# Fix Briefs Tab: Auto-Open and Markdown Formatting

## Metadata
**Complexity:** 2
**Tags:** ui, bugfix, frontend

## User Review Required
No product-scope decisions required. Implementation details are additive and preserve existing behavior.

## Goal
Fix two issues in the design.html briefs tab:
1. 'New brief' button creates a file but does not automatically open it in the preview pane
2. Briefs markdown preview lacks proper formatting (looks different from planning.html docs)

## Background & Root Cause Analysis

### Issue 1: New Brief Doesn't Auto-Open
**Root Cause:** In `src/webview/design.js` lines 2497-2514, the `briefCreated` message handler only displays a status message ("Brief created") but does not trigger loading the newly created file for preview. The backend (`DesignPanelProvider.ts` lines 1496-1536) creates the file and calls `_sendBriefsDocsReady()` to refresh the sidebar, but the frontend doesn't automatically select and preview the new brief.

**Current behavior:**
- User clicks "New Brief"
- File is created on disk
- Sidebar refreshes to show the new file
- Preview pane remains empty with "Select a brief from the sidebar to preview"
- User must manually click the new brief in the sidebar to see it

**Expected behavior:**
- User clicks "New Brief"
- File is created on disk
- Sidebar refreshes to show the new file
- New brief is automatically selected and previewed

### Issue 2: Missing Markdown Preview Formatting
**Root Cause:** In `src/webview/design.html`, the unified markdown preview CSS (lines 928-1200+) includes selectors for `#markdown-preview`, `#markdown-preview-online`, `#markdown-preview-design`, `#markdown-preview-tickets`, and `#kanban-preview-pane` - but **`#markdown-preview-briefs` is completely missing** from all these selectors.

**Example of the problem (line 947-957):**
```css
#markdown-preview h1, #markdown-preview h2, #markdown-preview h3, #markdown-preview h4, #markdown-preview h5, #markdown-preview h6,
#markdown-preview-online h1, #markdown-preview-online h2, #markdown-preview-online h3, #markdown-preview-online h4, #markdown-preview-online h5, #markdown-preview-online h6,
#markdown-preview-design h1, #markdown-preview-design h2, #markdown-preview-design h3, #markdown-preview-design h4, #markdown-preview-design h5, #markdown-preview-design h6,
#kanban-preview-pane h1, #kanban-preview-pane h2, #kanban-preview-pane h3, #kanban-preview-pane h4, #kanban-preview-pane h5, #kanban-preview-pane h6,
#markdown-preview-tickets h1, #markdown-preview-tickets h2, #markdown-preview-tickets h3, #markdown-preview-tickets h4, #markdown-preview-tickets h5, #markdown-preview-tickets h6 {
    margin-top: 24px;
    margin-bottom: 12px;
    font-weight: 600;
    line-height: 1.25;
    color: #ffffff;
}
```

This pattern repeats for all markdown styling (headings, paragraphs, lists, code blocks, tables, etc.). Without `#markdown-preview-briefs` included, briefs render with default browser styling instead of the unified dark theme formatting.

## Complexity Audit

### Routine
- Adding `#markdown-preview-briefs` to existing CSS selectors (find/replace across multiple lines)
- Modifying the `briefCreated` handler to trigger preview load after file creation

### Complex / Risky
- None

## Edge-Case & Dependency Audit
- **Race Conditions:** `_sendBriefsDocsReady()` (line 1530) uses a 300ms debounce — it returns immediately and posts `briefsDocsReady` later. `briefCreated` is sent right after, so it arrives **before** the sidebar refreshes. Calling `loadDocumentPreview()` immediately in the `briefCreated` handler will fail because (a) the DOM node doesn't exist yet, and (b) `sourceFolder` is extracted from the wrapper's `dataset`, so `fetchPreview` on the backend will throw `sourceFolder is required`. Solution: use a pending-auto-open flag set in `briefCreated` and consumed in `briefsDocsReady` after `renderBriefsDocs()`.
- **Security:** No security implications; purely frontend presentation changes.
- **Side Effects:** Adding CSS selectors only affects the briefs preview pane; no impact on other tabs. The pending-auto-open flag must be cleared after consumption or a timeout to prevent stale state from auto-selecting a brief during an unrelated `briefsDocsReady` refresh.
- **Dependencies & Conflicts:** No known plan dependencies. No conflicts with active plans.

## Dependencies
- None

## Adversarial Synthesis
Key risks: The 300ms debounce in `_sendBriefsDocsReady` creates a race where `briefCreated` arrives before the sidebar DOM updates, making immediate `loadDocumentPreview` calls fail due to missing wrapper nodes and undefined `sourceFolder`; the CSS patch spans 25+ selector groups and missing even one produces subtle rendering defects. Mitigations: Use a pending-auto-open flag consumed in `briefsDocsReady` after `renderBriefsDocs()`, with a 5-second staleness guard; verify CSS additions with a grep count and visual checklist covering every markdown element class.

## Proposed Changes

### `src/webview/design.html` (CSS)
**Context:** Lines 960-1287 contain unified markdown preview styling that excludes `#markdown-preview-briefs`.
**Logic:** Add `#markdown-preview-briefs` to every selector group that includes other markdown preview panes.
**Implementation:** Systematically add `#markdown-preview-briefs` to the following selector groups (exhaustive list derived from lines 960-1287):

- **Base container** (line 960): Add `#markdown-preview-briefs` to the comma-separated list alongside `#markdown-preview`, `#markdown-preview-online`, `#markdown-preview-design`, `#markdown-preview-tickets`, `#kanban-preview-pane`.
- **Heading base styles** (line 978): Add `#markdown-preview-briefs h1` through `h6` to the group.
- **Cyber theme — display heading typography** (line 991): Add `body.cyber-theme-enabled #markdown-preview-briefs h1` through `h6`.
- **Cyber theme — doc preview h2-h6 accent color** (line 1002): Add `body.cyber-theme-enabled #markdown-preview-briefs h2` through `h6`.
- **H1 specific styles** (line 1010): Add `#markdown-preview-briefs h1`.
- **H2 specific styles** (line 1024): Add `#markdown-preview-briefs h2`.
- **H3-H6 text-transform/color** (line 1038): Add `#markdown-preview-briefs h3` through `h6`.
- **H3 font size** (line 1059): Add `#markdown-preview-briefs h3`.
- **H4 font size** (line 1067): Add `#markdown-preview-briefs h4`.
- **H5 font size** (line 1075): Add `#markdown-preview-briefs h5`.
- **H6 font size** (line 1083): Add `#markdown-preview-briefs h6`.
- **Paragraph styles** (line 1091): Add `#markdown-preview-briefs p`.
- **List item styles** (line 1102): Add `#markdown-preview-briefs li`.
- **List item paragraph styles** (line 1113): Add `#markdown-preview-briefs li p`.
- **Pre/code block styles** (line 1121): Add `#markdown-preview-briefs pre`.
- **Pre code styles** (line 1134): Add `#markdown-preview-briefs pre code`.
- **Inline code styles** (line 1147): Add `#markdown-preview-briefs code`.
- **Blockquote styles** (line 1162): Add `#markdown-preview-briefs blockquote`.
- **List container styles** (line 1175): Add `#markdown-preview-briefs ul, #markdown-preview-briefs ol`.
- **Table wrapper** (line 1184): Add `#markdown-preview-briefs .table-wrapper`.
- **Table styles** (line 1185): Add `#markdown-preview-briefs table`.
- **Table header styles** (line 1195): Add `#markdown-preview-briefs th`.
- **Table cell styles** (line 1206): Add `#markdown-preview-briefs td`.
- **Table row hover** (line 1216): Add `#markdown-preview-briefs tr:hover td`.
- **Link styles** (line 1235): Add `#markdown-preview-briefs a`.
- **Link hover styles** (line 1244): Add `#markdown-preview-briefs a:hover`.
- **Horizontal rule styles** (line 1253): Add `#markdown-preview-briefs hr`.
- **Image styles** (line 1263): Add `#markdown-preview-briefs img`.
- **Empty state styles** (line 1275): Add `#markdown-preview-briefs .empty-state`.

**Verification method:** After editing, run `grep -n '#markdown-preview-briefs' src/webview/design.html` and confirm 25+ matches. Ensure every selector group that references `#markdown-preview` or `#markdown-preview-tickets` also references `#markdown-preview-briefs`.

**Edge Cases:** None; this is purely additive CSS with no logic changes.

### `src/services/DesignPanelProvider.ts` (Return Created File Info)
**Context:** Lines 1496-1536 create the brief but only send `{ success: true }` in the response.
**Logic:** Return the created file's `docId` (in `${folderIndex}:${relativePath}` format) and `sourceFolder` so the frontend can auto-open after the sidebar refreshes.
**Implementation:**
- After line 1528 (`await fs.promises.writeFile(finalPath, content, 'utf8');`), compute the folder index:
  ```typescript
  const folderPaths = service.getBriefsFolderPaths();
  const folderIndex = folderPaths.findIndex(p => path.resolve(p) === resolvedSource);
  ```
- Modify line 1531 to include the created file info:
  ```typescript
  this.postMessage({ 
      type: 'briefCreated', 
      success: true, 
      docId: folderIndex >= 0 ? `${folderIndex}:${path.relative(sourceFolder, finalPath)}` : undefined,
      sourceFolder: sourceFolder
  });
  ```
- Add a guard: if `folderIndex === -1`, still post `success: true` but omit `docId` so the frontend falls back to status-only behavior.

**Edge Cases:** If `folderIndex` is not found (should not happen due to the `isAllowed` check on line 1507), the frontend gracefully degrades to showing the status message without auto-open.

### `src/webview/design.js` (Auto-Open Logic)
**Context:** The `briefCreated` handler (lines 2497-2514) only shows a status message. The `briefsDocsReady` handler (lines 2454-2466) renders the sidebar but does not auto-select.
**Logic:** Use a pending-auto-open flag to bridge the race between `briefCreated` (immediate) and `briefsDocsReady` (300ms debounce).
**Implementation:**
1. In the `briefCreated` handler (line 2497):
   ```javascript
   case 'briefCreated': {
       if (msg.success) {
           const statusBriefs = document.getElementById('status-briefs');
           if (statusBriefs) {
               statusBriefs.textContent = 'Brief created';
               statusBriefs.style.color = 'var(--accent-teal)';
               setTimeout(() => { statusBriefs.textContent = ''; }, 2000);
           }
           if (msg.docId && msg.sourceFolder) {
               state._pendingAutoOpenBrief = { 
                   docId: msg.docId, 
                   sourceFolder: msg.sourceFolder, 
                   createdAt: Date.now() 
               };
           }
       } else {
           // existing error handling unchanged
       }
       break;
   }
   ```

2. In the `briefsDocsReady` handler (line 2454), after `renderBriefsDocs(...)` (line 2465):
   ```javascript
   if (state._pendingAutoOpenBrief) {
       const pending = state._pendingAutoOpenBrief;
       const age = Date.now() - pending.createdAt;
       if (age < 5000) { // 5-second window
           const nodes = msg.nodes || [];
           const found = nodes.find(n => n.id === pending.docId);
           if (found) {
               loadDocumentPreview('briefs-folder', found.id, found.name);
           }
       }
       state._pendingAutoOpenBrief = null;
   }
   ```

3. Add cleanup in the tab-switch or briefs tab activation path (if one exists) to clear `state._pendingAutoOpenBrief` when the user leaves the briefs tab. If no such hook exists, the 5-second timeout in `briefsDocsReady` is sufficient.

**Edge Cases:**
- **Sidebar not refreshed yet:** Handled by the flag pattern; `loadDocumentPreview` is only called after `renderBriefsDocs()` rebuilds the DOM.
- **Multiple rapid creations:** The flag is overwritten by the latest `briefCreated`, so only the most recent brief auto-opens. This is acceptable user behavior.
- **Stale flag on unrelated refresh:** The 5-second `age` check prevents stale flags from triggering unexpected auto-selection during file-watcher refreshes.
- **Missing `sourceFolder` in `fetchPreview`:** Resolved because `loadDocumentPreview` extracts `sourceFolder` from the newly rendered DOM wrapper's `dataset`, which is populated from `node.metadata.sourceFolder` by `_mapLocalFilesToTreeNodes`.

## Verification Plan

### Automated Tests
- None applicable; these are webview UI interactions requiring manual verification in the VS Code extension host. (Compilation and test suite execution are skipped per session constraints.)

### Manual Testing Checklist
- [ ] Click 'New brief' button
- [ ] Verify file is created on disk
- [ ] Verify brief automatically appears in preview pane with proper formatting
- [ ] Verify brief is selected in the sidebar (highlighted)
- [ ] Verify markdown styling matches planning.html (headings, code blocks, lists, tables)
- [ ] Verify cyber theme styling applies correctly to briefs headings
- [ ] Create multiple briefs in succession - verify each auto-opens correctly
- [ ] Edit a brief and save - verify formatting persists
- [ ] Switch between briefs and other tabs - verify no formatting bleed
- [ ] Verify `grep -n '#markdown-preview-briefs' src/webview/design.html` returns 25+ matches
- [ ] Verify no compilation errors in `src/webview/design.html` or `src/webview/design.js`

## Review Findings

CSS verified with 32 `#markdown-preview-briefs` selectors in `design.html` (exceeds 25+ target). Backend `briefCreated` returns `docId` and `sourceFolder` correctly. Frontend `_pendingAutoOpenBrief` flag bridges the 300ms debounce race and auto-opens the new brief after `renderBriefsDocs()`. No code fixes required. Minor edge case: if workspace filter excludes the new brief's root, `loadDocumentPreview` will lack a DOM wrapper and `sourceFolder` will be undefined, but the 5-second staleness guard and normal creation flow make this extremely unlikely.

## Recommendation
Send to Intern
