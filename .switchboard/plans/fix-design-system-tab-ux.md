# Fix Design System Tab — Doc Type Subheaders, Markdown Formatting, and Stuck Loading State

## Goal

Fix three UX defects in the Design System tab: (1) add doc-type subheaders (Markdown → YAML → JSON → Images) in the sidebar for Design System and HTML Preview tabs, (2) add `#markdown-preview-design` to unified markdown CSS selectors so Design System markdown renders with proper styling, and (3) eliminate the stuck "Loading preview..." state caused by stale `activeDocContent` short-circuiting the render.

**Root cause:** `renderDesignDocs()` and `renderHtmlDocs()` render all file types as a flat list within each folder; the unified markdown CSS block targets only `#markdown-preview` and `#markdown-preview-online`, omitting `#markdown-preview-design`; and `handlePreviewReady()` for `design-folder` has a content-equality short-circuit that fires falsely when switching from an image back to a previously-viewed markdown doc, because the image branch never clears `state.activeDocContent`.

## Metadata

- **Complexity:** 6
- **Tags:** frontend, ui, bugfix

## User Review Required

None — all changes are scoped to existing tabs with no new user-facing settings or configuration.

## Complexity Audit

### Routine
- Adding `#markdown-preview-design` to CSS selector groups (mechanical find-and-replace)
- Resetting `state.activeDocContent = null` in `loadDocumentPreview()` design-folder branch
- Adding `state.activeDocContent = content || ''` in CSS/XML/text branch of `handlePreviewReady()`
- Dist output sync from `src/webview/` to `dist/webview/`

### Complex / Risky
- Doc-type grouping logic in `renderDesignDocs()` and `renderHtmlDocs()` introduces new DOM structure (`.folder-subheader` type headers) — must not break existing tree rendering or click handlers
- ~25+ CSS selector groups must all be updated — a missed selector results in partial broken styling that may not be immediately obvious

## Problem Analysis

### Background
The Design System tab (`#design-content`) in `planning.html` renders a file tree in the left sidebar and a preview pane on the right. It reuses much of the same architecture as the Local Docs and HTML Preview tabs, but has accumulated three distinct UX defects.

### Root Cause 1 — No Doc-Type Subheaders
`renderDesignDocs()` (`planning.js:1474`) groups documents by `sourceFolder` and then by sub-folder, but within each folder all file types (`.md`, `.png`, `.json`, `.yaml`, `.css`, `.xml`, `.txt`) are rendered as a flat list with no visual separation. The user expects each type to have its own subheader in the left panel, ordered: **Markdown → YAML → JSON → Images**.

The same pattern exists in `renderHtmlDocs()` (`planning.js:1307`), which the user also wants fixed. Other tabs (Local, Online, Tickets, Kanban) must remain unchanged.

### Root Cause 2 — Markdown Preview Missing CSS
The unified markdown preview stylesheet block in `planning.html` ("Unified Markdown Preview Styling") targets only `#markdown-preview` and `#markdown-preview-online`. The Design System tab uses `#markdown-preview-design`, which was never added to any selector. As a result, markdown files in the Design System tab render with unstyled typography, broken margins, and missing code-block backgrounds.

### Root Cause 3 — Stuck on "Loading preview..."
In `loadDocumentPreview()` (`planning.js:1024`) for the `design-folder` path, the preview pane is set to "Loading preview..." before `vscode.postMessage({ type: 'fetchPreview' })` is sent.

In `handlePreviewReady()` (`planning.js:2080`) for the `design-folder` path, a content-equality short-circuit exists at line ~2162:

```javascript
if (state.activeDocContent === (content || '')) {
    return;
}
```

When the user views a Markdown doc, `state.activeDocContent` is set to that doc's text. When they switch to an **image** (`.png`, `.jpg`, etc.), `handlePreviewReady` renders the image but **does not clear or update** `state.activeDocContent`. When they switch back to the same Markdown doc, the new content equals the stale `activeDocContent`, so the function returns early — leaving the "Loading preview..." message permanently in the DOM.

The same bug affects the **CSS / XML / text** branch (`msg.fileType === 'css' || 'xml' || 'text'`), which also fails to update `state.activeDocContent`. It likely affects JSON and YAML too if switching between two docs with identical raw content, though the primary observed path is image → markdown.

## Goals

1. **Doc-type grouping:** In the Design System and HTML Preview sidebars, render a subheader for each file-type group present within a folder, in the order: Markdown → YAML → JSON → Images. Only these two tabs are affected.
2. **Unified markdown CSS:** Add `#markdown-preview-design` to every selector in the unified markdown preview CSS block so Design System markdown renders identically to Local and Online markdown.
3. **Eliminate stuck loading state:** Reset `state.activeDocContent` at the start of the `design-folder` `loadDocumentPreview` path so stale content can never short-circuit the preview render. Also add the missing `state.activeDocContent = content || ''` assignment in the CSS/XML/text branch of `handlePreviewReady` for consistency.

## Edge-Case & Dependency Audit

- **Race Conditions:** None — `renderDesignDocs`/`renderHtmlDocs` are synchronous DOM builders; `loadDocumentPreview` is single-threaded per user click.
- **Security:** No new user input handling; CSS changes are static selectors only.
- **Side Effects:** The `activeDocContent = null` reset eliminates the content-equality short-circuit, causing a re-render even when switching back to identical content. This is a negligible performance regression vs. the stuck-loading bug it fixes. Auto-refresh detection still works because `handlePreviewReady` updates status text regardless.
- **Dependencies & Conflicts:** The `.edit-mode` selector at `planning.html:2159-2161` already includes `#markdown-preview-design` — no change needed there. The `#kanban-preview-pane` selectors share some styling groups but are a separate element; they should NOT receive `#markdown-preview-design`.

## Dependencies

None — this plan is self-contained.

## Adversarial Synthesis

Key risks: missed CSS selector causing partial styling in Design tab, and negligible re-render regression from forced `activeDocContent` reset. Mitigations: systematic find-and-replace with visual verification catches missed selectors; the re-render trade-off is correct (stuck-loading bug far worse than micro-optimization loss). The `.edit-mode` selector already includes `#markdown-preview-design` — Step 3's note about updating it is incorrect and should be skipped.

## Implementation

### Step 1 — Add doc-type subheaders in `renderDesignDocs()`

Modify `renderDesignDocs()` (`planning.js:1474`). After the existing per-folder grouping logic, further bucket `folderDocsInSource` and `rootDocs` by file type.

For a given array of docs, create a helper `groupDocsByType(docs)` that returns an ordered map:

```javascript
const TYPE_ORDER = ['markdown', 'yaml', 'json', 'image'];

function getDocType(doc) {
    const name = doc.name || doc.id || '';
    const ext = name.substring(name.lastIndexOf('.')).toLowerCase();
    if (['.md', '.markdown'].includes(ext)) return 'markdown';
    if (['.yaml', '.yml'].includes(ext)) return 'yaml';
    if (ext === '.json') return 'json';
    if (['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.bmp'].includes(ext)) return 'image';
    return 'other'; // fallback, not rendered with a subheader
}
```

Then, after building `docsByFolder` and `rootDocs`, iterate over `TYPE_ORDER`. For each type present in the current scope, render a `.folder-subheader` with the type label (e.g., "Markdown", "YAML", "JSON", "Images"), then render the docs of that type via `renderNode()`.

Apply this grouping to:
- `folderDocsInSource` within each `sourceFolderNodes.forEach(folder => { ... })` block
- `rootDocs` within each `sourceFolders.forEach(sourceFolder => { ... })` block

### Step 2 — Add doc-type subheaders in `renderHtmlDocs()`

Apply the **exact same helper and grouping logic** from Step 1 to `renderHtmlDocs()` (`planning.js:1307`). The structure of `renderHtmlDocs` mirrors `renderDesignDocs`, so the insertion points are identical.

### Step 3 — Add `#markdown-preview-design` to unified CSS selectors

In `planning.html`, locate the "Unified Markdown Preview Styling" block (~line 960). Every selector list that contains `#markdown-preview` or `#markdown-preview-online` must also include `#markdown-preview-design`.

Examples of selectors to update:
- `#markdown-preview, #markdown-preview-online` → `#markdown-preview, #markdown-preview-online, #markdown-preview-design`
- `#markdown-preview h1, #markdown-preview-online h1, #kanban-preview-pane h1` → `#markdown-preview h1, #markdown-preview-online h1, #markdown-preview-design h1, #kanban-preview-pane h1`
- And so on for all headings, paragraphs, lists, tables, links, code blocks, blockquotes, images, `::selection`, `.empty-state`, `::before` counters, and cyber-theme overrides.

~~Also update the `.edit-mode` selector at ~line 2159~~ — **Already done.** The `.edit-mode` selector at `planning.html:2159-2161` already includes `#markdown-preview-design`. No change needed.

### Step 4 — Fix stuck loading state in `loadDocumentPreview()`

In `loadDocumentPreview()` (`planning.js:985`), within the `sourceId === 'design-folder'` branch (`~line 1024`), immediately after resetting `state.previewRequestId++` and before posting the `fetchPreview` message, add:

```javascript
state.activeDocContent = null; // Force re-render; prevent stale-content short-circuit
```

This guarantees that `handlePreviewReady` will never see `state.activeDocContent === (content || '')` when switching back to a previously viewed doc after viewing an image.

### Step 5 — Fix missing `activeDocContent` assignment in CSS/XML/text branch

In `handlePreviewReady()` (`planning.js:2080`), within the `sourceId === 'design-folder'` branch, locate the `msg.fileType === 'css' || msg.fileType === 'xml' || msg.fileType === 'text'` block (~line 2143). After setting `mdPrev.innerHTML`, add:

```javascript
state.activeDocContent = content || '';
```

This keeps state consistent for all non-image, non-JSON, non-YAML file types and prevents edge-case short-circuits.

### Step 6 — Dist output sync

After editing `src/webview/planning.html` and `src/webview/planning.js`, copy the modified files to `dist/webview/` so the built extension uses the updated versions.

## Proposed Changes

### `src/webview/planning.js`
- **Context:** `renderDesignDocs()` (line 1474) and `renderHtmlDocs()` (line 1307) render docs as flat lists within folders.
- **Logic:** Add `getDocType()` helper and `TYPE_ORDER` constant. After building `docsByFolder`/`rootDocs`, iterate `TYPE_ORDER` and render `.folder-subheader` for each present type, then render docs of that type.
- **Implementation:** See Steps 1-2 above.
- **Edge Cases:** Files with unrecognized extensions fall into `'other'` and render without a subheader (preserving current behavior). `.txt` files are classified as `'other'` — the `handlePreviewReady` `text` branch still works, just no subheader grouping.

- **Context:** `loadDocumentPreview()` design-folder branch (line 1024) sets "Loading preview..." but doesn't reset `state.activeDocContent`.
- **Logic:** Add `state.activeDocContent = null;` after `state.previewRequestId++` (line 1044) to prevent stale-content short-circuit.
- **Implementation:** See Step 4 above.
- **Edge Cases:** Causes re-render on identical content switch — negligible vs. stuck-loading bug.

- **Context:** `handlePreviewReady()` CSS/XML/text branch (line 2143) doesn't update `state.activeDocContent`.
- **Logic:** Add `state.activeDocContent = content || '';` after `mdPrev.innerHTML` assignment (line 2151).
- **Implementation:** See Step 5 above.
- **Edge Cases:** None — keeps state consistent across all file type branches.

### `src/webview/planning.html`
- **Context:** Unified Markdown Preview Styling block (lines 960-1189) targets only `#markdown-preview` and `#markdown-preview-online`. Cyber-theme overrides (lines 1828-1846) also omit `#markdown-preview-design`.
- **Logic:** Add `#markdown-preview-design` to every selector group that contains `#markdown-preview` or `#markdown-preview-online`. Do NOT add to `#kanban-preview-pane` selectors.
- **Implementation:** See Step 3 above. Use systematic find-and-replace.
- **Edge Cases:** The `.edit-mode` selector at line 2159 already includes `#markdown-preview-design` — skip it.

### `dist/webview/planning.html` and `dist/webview/planning.js`
- Sync from `src/webview/` after edits. Verify whether webpack build handles this or manual copy is needed.

## Files Changed

- `src/webview/planning.html` — add `#markdown-preview-design` to unified markdown preview CSS selectors
- `src/webview/planning.js` — add doc-type grouping helpers, apply to `renderDesignDocs()` and `renderHtmlDocs()`, reset `activeDocContent` in `loadDocumentPreview()`, add missing assignment in `handlePreviewReady()` CSS/XML/text branch
- `dist/webview/planning.html` — sync from `src/`
- `dist/webview/planning.js` — sync from `src/`

## Verification Plan

### Automated Tests

- **Unit test: `getDocType()` helper** — verify classification of `.md`, `.markdown`, `.yaml`, `.yml`, `.json`, `.png`, `.jpg`, `.svg`, `.css`, `.xml`, `.txt`, and extensionless files.
- **Unit test: content-equality short-circuit** — mock `state.activeDocContent`, call `handlePreviewReady` with matching content after `activeDocContent = null` reset, verify render occurs.

### Manual Verification

1. **Doc-type subheaders (Design System):**
   - Configure a Design System folder containing `.md`, `.yaml`, `.json`, and `.png` files in the same sub-folder.
   - Open the Design System tab.
   - Verify the left sidebar shows subheaders "Markdown", "YAML", "JSON", "Images" in that order.
   - Verify the Local Docs tab is unaffected (no type subheaders).

2. **Doc-type subheaders (HTML Preview):**
   - Configure an HTML Preview folder with mixed file types.
   - Verify type subheaders appear in the same order.

3. **Markdown formatting:**
   - Open a `.md` file in the Design System tab.
   - Verify headings, code blocks, tables, and blockquotes match the styling of the Local Docs tab.

4. **Stuck loading state:**
   - Open a `.md` file in the Design System tab (should render).
   - Open a `.png` file (should show image).
   - Re-open the same `.md` file — verify it renders immediately, not stuck on "Loading preview...".
   - Repeat with `.css` → `.md` and `.json` → `.md` transitions.

## Risks & Mitigations

- **Risk:** Adding `#markdown-preview-design` to cyber-theme selectors may inadvertently apply glow effects to the design tab. **Mitigation:** This is the intended behavior — the design tab should match the rest.
- **Risk:** The `activeDocContent = null` reset may break auto-refresh detection for external file changes. **Mitigation:** Auto-refresh in `handlePreviewReady` updates the status text but still renders content; the short-circuit only skips the render when content is identical, which is safe to bypass because the DOM is already correct.
- **Risk:** The `getDocType` helper may misclassify files with no extension. **Mitigation:** Files with unrecognized extensions fall into `'other'` and are rendered without a subheader, preserving current behavior.

**Recommendation:** Complexity 6 → **Send to Coder**
