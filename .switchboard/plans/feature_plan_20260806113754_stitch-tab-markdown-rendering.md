# Stitch HTML Tab: Detect and Render Markdown Files in Preview and Detail Views

## Goal

The Stitch HTML tab in the Design panel (`design.html`) currently treats every file in the `.stitch/screens/` cache directory as an HTML file. When a markdown (`.md`) file appears in that folder, the preview pane either shows nothing useful or attempts to render the raw markdown text inside an HTML iframe — producing garbage output instead of a nicely formatted markdown document. The tab should detect markdown files by extension and render them as formatted markdown in the preview pane (the surface that loads when you click a file in the sidebar tree), exactly as the Design-folder tab already does.

> **Clarification:** The original Goal wording referred to "both the preview pane and the detail view (the pane that loads when you click a file in the sidebar tree)." In this codebase those are the **same surface** — clicking a sidebar file calls `loadDocumentPreview()` → `handlePreviewReady()` renders into the preview pane. There is no separate detail view/modal for the stitch-html tab. The implementation correctly targets this single surface.

### Problem Analysis & Root Cause

**Symptom:** Clicking a `.md` file in the Stitch HTML sidebar tree loads it into the preview pane, but the content is not rendered as markdown. It either appears as raw text in an iframe or the pane stays blank.

**Root Cause:** The backend (`DesignPanelProvider.ts`) already correctly classifies file types — at line 4613-4619 it maps `.md`/`.markdown`/`.txt` to `fileType: 'markdown'` and sends the raw `content` in the `previewReady` payload. The bug is entirely frontend-side:

In `design.js`, the `handlePreviewReady()` function has a dedicated branch for `sourceId === 'stitch-html-folder'` (lines 1580-1646). This branch **only** handles two cases:
1. `msg.iframeSrc` — loads the file in an `<iframe>` (HTML files served via the localhost HTML server)
2. `htmlContent` — loads raw HTML via `iframe.srcdoc` (HTML files)

It **never checks `msg.fileType`**. For a markdown file, both `iframeSrc` and `htmlContent` are `undefined`, so neither branch executes. The iframe wrapper stays hidden (set to `display: none` at line 1450 during `loadDocumentPreview`), and the markdown content field (`msg.content`) is completely ignored. The user sees a blank pane or broken rendering.

By contrast, the `design-folder` branch (lines 1696-1784) correctly dispatches on `fileType`: it renders markdown via `renderMarkdown(content)` into a `#markdown-preview-design` element, images into an image container, JSON/YAML into tree viewers, and HTML into an iframe. The Stitch HTML tab needs the same dispatch logic.

**Why "as images":** The Stitch HTML tab's sidebar tree (`renderStitchHtmlDocs`, line 1151) lists all files from the cache directory without filtering by type. When a markdown file appears alongside HTML screens, the tree shows it with the same icon/treatment as HTML screens. The preview pane then has no rendering path for it, so the file is effectively miscategorized and misrendered.

## Metadata

**Complexity:** 5
**Tags:** frontend, ui, bugfix
**Project:** Browser Switchboard

## User Review Required

- **CSS selector proliferation strategy:** The plan adds `#stitch-html-markdown-preview` to ~30 existing CSS selector groups (56 occurrences of `#markdown-preview-design` across `design.html` lines 1047-1300). This is the highest-effort, highest-risk change. Review whether the ID-addition approach (drift-free, matches existing pattern, but large edit surface) is preferred over a single dedicated CSS block for the new ID (smaller edit surface, but duplicates property values and can drift from upstream changes). The plan recommends the ID-addition approach for long-term maintainability.
- **JSON/YAML rendering scope:** The plan renders JSON/YAML files as plain text through `renderMarkdown()` (no tree viewer). This is an MVP scope decision. Confirm this is acceptable or whether dedicated JSON/YAML tree viewers (like the design-folder tab has) should be added.

## Complexity Audit

### Routine
- Adding a `fileType`/`isImage` dispatch branch to an existing `handlePreviewReady` handler — the pattern is already implemented in the `design-folder` branch and can be mirrored directly.
- `renderMarkdown()` is already available globally via `sharedUtils.js` (line 122) and is used by the design-folder, planning, and tickets panels.
- The backend requires **no changes** — it already sends `fileType`, `content`, `isImage`, and `webviewUri` correctly (verified: `DesignPanelProvider.ts` lines 4613-4644).
- Adding the new container IDs to the `PREVIEW_ERROR_TARGETS` hide array (line 3424) — a one-line array extension.
- Using the existing `getDocType()` helper (line 999) for the sidebar subtitle fix — the helper already classifies markdown, yaml, json, image, html.

### Complex / Risky
- **CSS selector group proliferation (HIGH effort/risk):** The existing markdown-preview CSS at lines 1047-1300 uses ID selectors (`#markdown-preview`, `#markdown-preview-online`, `#markdown-preview-design`, `#markdown-preview-tickets`, `#kanban-preview-pane`) — there is **no `.markdown-preview` class**. Adding `#stitch-html-markdown-preview` to each selector group requires touching 56 occurrences across ~30 groups, with **no consistent insertion anchor** (some groups end with `#markdown-preview-tickets`, others with `#kanban-preview-pane`; cyber-theme variants repeat every ID with a `body.cyber-theme-enabled` prefix). A missed group produces partially-styled markdown (e.g. headings styled but code blocks unstyled). The coder must verify with a grep diff that every selector group containing `#markdown-preview-design` also contains `#stitch-html-markdown-preview` after the edit.
- **DOM placement precision:** The new containers must be inserted as siblings of `#stitch-html-preview-wrapper` (after line 3838 where the wrapper closes), NOT inside it. The `#stitch-tweak-popup` (line 3812) is a child of the wrapper, not a sibling — misplacement nests the containers inside the zoom/iframe wrapper where they inherit `display: flex` and zoom-viewport logic meant for the iframe.
- **Show/hide state machine extension:** `loadDocumentPreview` (line 1440) and the `previewError` handler (line 3424) both manage container visibility. Both must be updated to hide the new containers, or stale content leaks on error/reset.

## Edge-Case & Dependency Audit

1. **Mixed file types in the same folder:** The `.stitch/screens/` cache directory may contain `.html`, `.md`, `.json`, `.yaml`, and image files. The tree lists all of them. The preview handler must correctly dispatch for each type, not just HTML vs markdown. At minimum, markdown and image must be handled; JSON/YAML fall through to the markdown/text default (rendered as plain text via `renderMarkdown` — no tree viewer for MVP).

2. **Auto-refresh:** When a watched markdown file changes on disk, `_autoRefreshHtmlPreview` fires `fetchPreview` with `requestId: -1`. The `handlePreviewReady` handler checks `requestId !== state.previewRequestId` and bails for stale requests — this guard must be preserved in the new markdown branch. The `isAutoRefreshed` flag should skip zoom reset (already the case for HTML; markdown has no zoom anyway).

3. **Inspect Mode:** The Stitch HTML tab has an "Inspect Mode" toggle (`stitch-html-btn-inspect`) that only applies to HTML iframes. When a markdown file is loaded, the inspect button should be disabled or hidden, and `document.body.classList.remove('inspect-active')` should be called (already done at line 1589 unconditionally — safe).

4. **Edit bar visibility:** The edit bar (`stitch-html-edit-bar`, line 1642) is shown unconditionally after preview ready. For markdown files, the AI-edit/refine controls (which target HTML elements) are not applicable. The edit bar should be hidden for non-HTML files.

5. **Zoom state:** `resetZoom('stitchHtml')` and `_fitPending.stitchHtml` (lines 1595-1596) are iframe-specific. Calling them for a markdown render is harmless (no zoomable viewport exists), but `_stitchHtmlContentDims = null` (line 1598) should still be reset to avoid stale dimensions leaking to a subsequent HTML load.

6. **`renderMarkdown` availability:** The function is defined in `sharedUtils.js` (line 122) and loaded globally. The design.js file already calls it at line 1782 for the design-folder branch, confirming it is in scope. No import change needed.

7. **Sidebar file type badges:** `renderStitchHtmlDocs` (line 1151) renders doc cards with a hardcoded `subtitle: 'HTML'` (line 1194) for every file. This must be replaced with the shared `getDocType()` helper (line 999) so markdown files show a "Markdown" badge, images show "Image", etc.

8. **Preview error path (NEW):** The `PREVIEW_ERROR_TARGETS` table (line 3420-3425) hides `stitch-html-preview-wrapper` and `stitch-html-edit-bar` on a preview error, then shows the initial state. The new `stitch-html-markdown-preview` and `stitch-html-image-preview` containers must be added to the `hide` array (line 3424). Without this, a markdown/image container stays visible after a preview error, overlapping the re-shown initial state.

9. **Project switch:** On project dropdown change (line 4587), the edit bar is hidden but the preview containers are not reset (existing behavior for HTML too — the wrapper stays visible until a new file is clicked). This is existing behavior, not a new gap; the plan does not need to change it.

## Dependencies

- None

## Adversarial Synthesis

Key risks: (1) the plan's File 1 falsely claims a `.markdown-preview` CSS class exists — styling actually depends on File 4's ID-addition to ~30 selector groups; skipping File 4 produces unstyled markdown. (2) DOM placement guidance points inside the iframe wrapper instead of after it. (3) The `previewError` handler doesn't hide the new containers, causing stale-content leaks on error. Mitigations: correct the CSS class claim with a superseded callout, fix the placement to "after line 3838 as a sibling," add the new IDs to the `PREVIEW_ERROR_TARGETS.hide` array, and use the existing `getDocType()` helper for subtitle badges.

## Proposed Changes

### File 1: `src/webview/design.html` — Add markdown and image preview containers to the Stitch HTML subpanel

Locate the Stitch HTML preview pane. The `#stitch-html-preview-wrapper` opens at line 3808 and closes at line 3838. The `#stitch-tweak-popup` (line 3812) is a **child** of the wrapper, not a sibling.

> **Superseded:** Add two new sibling containers after the iframe wrapper, before the tweak popup.
> **Reason:** The tweak popup is inside the wrapper (opens 3808, closes 3838), not a sibling of it. Placing containers "before the tweak popup" nests them inside the zoom/iframe wrapper where they inherit `display: flex` and zoom-viewport logic meant for the iframe.
> **Replaced with:** Add the two new containers **after line 3838** (after `#stitch-html-preview-wrapper` closes), as true siblings of the wrapper — at the same DOM level as `#stitch-html-initial-state` (line 3797) and `#stitch-html-loading-state` (line 3804).

Add after line 3838 (after the wrapper's closing `</div>`):

```html
<!-- Markdown preview for .md/.txt files in the stitch screens folder -->
<div id="stitch-html-markdown-preview" style="display: none; flex: 1; overflow-y: auto; padding: 32px 24px 40px; width: 100%; box-sizing: border-box; margin: 0; font-family: var(--font-family); font-size: 14px; line-height: 1.6; word-wrap: break-word; color: var(--doc-text-bright);"></div>

<!-- Image preview for image files in the stitch screens folder -->
<div id="stitch-html-image-preview" style="display: none; flex: 1; align-items: center; justify-content: center; overflow: hidden;">
    <img id="stitch-html-image-img" style="max-width: 100%; max-height: 100%; object-fit: contain;" />
</div>
```

> **Superseded:** The `#stitch-html-markdown-preview` element reuses the existing `.markdown-preview` CSS class (already styled at lines 1047-1300 of design.html, which covers `#markdown-preview-design` and siblings).
> **Reason:** A grep of `design.html` for `.markdown-preview` returns **zero matches**. The markdown-preview CSS uses ID selectors (`#markdown-preview`, `#markdown-preview-online`, `#markdown-preview-design`, `#markdown-preview-tickets`, `#kanban-preview-pane`), not a class. A `class="markdown-preview"` attribute inherits no styles. File 4 (adding the ID to each selector group) is the actual styling mechanism.
> **Replaced with:** The inline `style` attributes on `#stitch-html-markdown-preview` above replicate the base container styles from the selector group at lines 1047-1063 (flex, overflow, padding, font, color) as a fallback. File 4 adds `#stitch-html-markdown-preview` to every shared selector group so it inherits heading, code-block, blockquote, table, and list styling. Both are needed: the inline style covers the container box model; File 4 covers the child-element typography.

### File 2: `src/webview/design.js` — Add fileType dispatch to the stitch-html-folder handlePreviewReady branch

In `handlePreviewReady()` (line 1505), the `stitch-html-folder` branch (lines 1580-1646), restructure the rendering logic to dispatch on `msg.fileType` and `msg.isImage` before falling through to the existing iframe logic.

**Current structure (simplified):**
```js
} else if (sourceId === 'stitch-html-folder') {
    // ... stale-request guard, inspect-mode reset, zoom reset ...
    if (msg.iframeSrc) { /* load iframe */ }
    else if (htmlContent) { /* load srcdoc */ }
    // nothing else — markdown/image fall through to nothing
}
```

**Proposed structure:**
```js
} else if (sourceId === 'stitch-html-folder') {
    if (requestId !== undefined && requestId !== -1 && requestId !== state.previewRequestId) {
        const loading = document.getElementById('stitch-html-loading-state');
        if (loading) loading.style.display = 'none';
        return;
    }
    state.stitchHtmlActiveFilePath = msg.filePath || null;
    const inspectBtn = document.getElementById('stitch-html-btn-inspect');
    if (inspectBtn) inspectBtn.classList.remove('active');
    document.body.classList.remove('inspect-active');
    const tweakPopup = document.getElementById('stitch-tweak-popup');
    if (tweakPopup) tweakPopup.style.display = 'none';
    state.stitchSelectedElement = null;
    _stitchHtmlContentDims = null;

    const initialState = document.getElementById('stitch-html-initial-state');
    const loadingState = document.getElementById('stitch-html-loading-state');
    if (initialState) initialState.style.display = 'none';
    if (loadingState) loadingState.style.display = 'none';

    // Grab all preview containers
    const mdPreview = document.getElementById('stitch-html-markdown-preview');
    const imgPreview = document.getElementById('stitch-html-image-preview');
    const imgImg = document.getElementById('stitch-html-image-img');
    const iframe = document.getElementById('stitch-html-preview-frame');
    const iframeWrapper = document.getElementById('stitch-html-preview-wrapper');

    // Helper: hide all preview containers
    const hideAllStitch = () => {
        if (iframeWrapper) iframeWrapper.style.display = 'none';
        if (mdPreview) mdPreview.style.display = 'none';
        if (imgPreview) imgPreview.style.display = 'none';
    };

    if (msg.isImage && msg.webviewUri) {
        // Image file — render in the image container
        hideAllStitch();
        if (imgPreview) imgPreview.style.display = 'flex';
        if (imgImg) imgImg.src = withCacheBust(msg.webviewUri);
        // Hide the edit bar — AI refine targets HTML elements, not images
        const shEditBar = document.getElementById('stitch-html-edit-bar');
        if (shEditBar) shEditBar.style.display = 'none';
    } else if (msg.fileType === 'markdown' || msg.fileType === 'text' ||
               (!msg.iframeSrc && !htmlContent && msg.content && msg.fileType !== 'html' && msg.fileType !== 'json' && msg.fileType !== 'yaml')) {
        // Markdown / text file — render as formatted markdown
        hideAllStitch();
        if (mdPreview) {
            mdPreview.style.display = 'block';
            mdPreview.innerHTML = renderMarkdown(msg.content) || '';
        }
        // Hide the edit bar — AI refine targets HTML elements, not markdown
        const shEditBar = document.getElementById('stitch-html-edit-bar');
        if (shEditBar) shEditBar.style.display = 'none';
    } else if (msg.fileType === 'json' || msg.fileType === 'yaml') {
        // JSON/YAML — render as plain text (MVP: no tree viewer in this tab)
        hideAllStitch();
        if (mdPreview) {
            mdPreview.style.display = 'block';
            mdPreview.innerHTML = '<pre style="white-space: pre-wrap; word-wrap: break-word; font-family: var(--font-mono, monospace); font-size: 13px;">' +
                (msg.content || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</pre>';
        }
        const shEditBar = document.getElementById('stitch-html-edit-bar');
        if (shEditBar) shEditBar.style.display = 'none';
    } else {
        // HTML file — existing iframe logic (unchanged)
        hideAllStitch();
        if (!isAutoRefreshed) {
            resetZoom('stitchHtml');
            _fitPending.stitchHtml = true;
        }
        if (iframeWrapper) iframeWrapper.style.display = 'flex';
        const stitchViewport = iframeWrapper ? iframeWrapper.querySelector('.zoomable-viewport') : null;
        if (stitchViewport) { stitchViewport.style.width = '100%'; stitchViewport.style.height = '100%'; }
        if (iframe) {
            iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin');
            if (msg.iframeSrc) {
                iframe.removeAttribute('srcdoc');
                iframe.src = isAutoRefreshed ? withCacheBust(msg.iframeSrc) : msg.iframeSrc;
            } else if (htmlContent) {
                iframe.removeAttribute('src');
                iframe.removeAttribute('srcdoc');
                iframe.srcdoc = injectBaseTag(htmlContent, webviewUri);
            }
        }
        if (stitchViewport) applyZoom('stitchHtml', stitchViewport);
        notifyIframeResize(iframe, iframeWrapper);
        if (iframe) iframe.addEventListener('load', () => notifyIframeResize(iframe, iframeWrapper), { once: true });
        // Show the edit bar for HTML files only
        const shEditBar = document.getElementById('stitch-html-edit-bar');
        if (shEditBar) shEditBar.style.display = 'block';
        const shRange = document.getElementById('stitch-html-creative-range-select');
        if (shRange) shRange.value = state.stitchCreativeRange;
        state.stitchHtmlActiveScreenProjectId = state.selectedStitchHtmlProjectId;
    }

    const statusEl = document.getElementById('status-stitch-html');
    if (statusEl) {
        statusEl.textContent = isAutoRefreshed ? 'Auto-refreshed' : '';
        statusEl.style.color = 'var(--accent-teal)';
    }
}
```

Key changes:
- The `hideAllStitch()` helper ensures only one preview container is visible at a time — prevents a stale markdown container from showing behind a newly-loaded HTML iframe.
- The markdown branch calls `renderMarkdown(msg.content)` — the same function used by the design-folder branch (line 1782).
- The edit bar is shown only for HTML files; hidden for markdown/image/JSON/YAML.
- Zoom/fit logic is moved inside the HTML-only else branch so it doesn't fire for markdown/image.
- The markdown condition is narrowed to `fileType === 'markdown' || fileType === 'text'` plus a fallback for unknown text types that aren't HTML/JSON/YAML. JSON/YAML get a dedicated `<pre>` plain-text render instead of being passed through `renderMarkdown()` (which would mangle structured data into paragraphs).
- `htmlContent` (local variable, destructured at line 1506) is used consistently instead of mixing `msg.htmlContent` and `htmlContent`.

### File 3: `src/webview/design.js` — Update `loadDocumentPreview` for stitch-html-folder (line 1440)

The `loadDocumentPreview` function hides the iframe wrapper and shows the loading state. It should also hide the new markdown and image containers during loading:

```js
} else if (sourceId === 'stitch-html-folder') {
    state.activeDocSourceFolder = sourceFolder || null;
    const statusEl = document.getElementById('status-stitch-html');
    if (statusEl) statusEl.textContent = 'Loading...';

    const initialState = document.getElementById('stitch-html-initial-state');
    const loadingState = document.getElementById('stitch-html-loading-state');
    const iframeWrapper = document.getElementById('stitch-html-preview-wrapper');
    const mdPreview = document.getElementById('stitch-html-markdown-preview');     // NEW
    const imgPreview = document.getElementById('stitch-html-image-preview');         // NEW
    if (initialState) initialState.style.display = 'none';
    if (loadingState) loadingState.style.display = 'flex';
    if (iframeWrapper) iframeWrapper.style.display = 'none';
    if (mdPreview) mdPreview.style.display = 'none';     // NEW
    if (imgPreview) imgPreview.style.display = 'none';   // NEW

    vscode.postMessage({ /* unchanged */ });
}
```

### File 4: `src/webview/design.html` — Add `#stitch-html-markdown-preview` to the shared markdown-preview CSS selectors

> **Note:** There is no `.markdown-preview` CSS class in `design.html`. The markdown-preview styles (lines 1047-1300) use ID selectors exclusively. This file adds the new ID to each selector group so it inherits the same heading, paragraph, code, blockquote, table, and list styling.

The existing CSS at lines 1047-1300 groups `#markdown-preview`, `#markdown-preview-online`, `#markdown-preview-design`, `#markdown-preview-tickets`, `#kanban-preview-pane` in every selector. Add `#stitch-html-markdown-preview` to each of these selector groups. This is a mechanical find-and-replace across the ~30 selector groups (56 occurrences of `#markdown-preview-design`) in that range.

**Critical:** There is no consistent insertion anchor — some groups end with `#markdown-preview-tickets`, others with `#kanban-preview-pane`, and cyber-theme variants repeat every ID with a `body.cyber-theme-enabled` prefix. The coder must:
1. Find every selector group containing `#markdown-preview-design` (grep anchor).
2. Append `,\n        #stitch-html-markdown-preview` to that group.
3. After editing, verify with a grep diff that the count of `#stitch-html-markdown-preview` matches the count of `#markdown-preview-design` (both should be 56). Any mismatch indicates a missed group.

Example (line 1047):
```css
/* Before */
#markdown-preview,
#markdown-preview-online,
#markdown-preview-design,
#markdown-preview-tickets,
#kanban-preview-pane {

/* After */
#markdown-preview,
#markdown-preview-online,
#markdown-preview-design,
#markdown-preview-tickets,
#kanban-preview-pane,
#stitch-html-markdown-preview {
```

### File 5: `src/webview/design.js` — Fix sidebar tree subtitle using the existing `getDocType()` helper

`renderStitchHtmlDocs` (line 1191-1205) hardcodes `subtitle: 'HTML'` for every doc card. Replace it with the existing `getDocType()` helper (line 999) which already classifies markdown, yaml, json, image, html, and other:

```js
filtered.forEach(doc => {
    const docType = getDocType(doc);  // returns 'html' | 'markdown' | 'yaml' | 'json' | 'image' | 'other'
    const subtitle = TYPE_LABELS[docType] || 'File';  // TYPE_LABELS at line 991 maps to 'HTML', 'Markdown', etc.
    const card = renderDocCard({
        title: doc.name || doc.file,
        subtitle,
        sourceId: 'stitch-html-folder',
        nodeId: doc.file,
        nodeMetadata: { sourceFolder: doc.sourceFolder, absolutePath: doc.absolutePath },
        actions: ['Serve & Open', 'Link Doc'],
        isSelected: state.activeSource === 'stitch-html-folder' && state.activeDocId === doc.file,
        clickHandler: () => {
            loadDocumentPreview('stitch-html-folder', doc.file, doc.name || doc.file);
        }
    });
    docList.appendChild(card);
});
```

> **Superseded:** Add an inline `ext` check: `if (ext === 'md' || ext === 'markdown') subtitle = 'Markdown';`
> **Reason:** The codebase already has a `getDocType()` helper (line 999) that classifies all file types, and a `TYPE_LABELS` map (line 991) that converts types to display labels. An inline ext check reinvents this and will diverge the moment someone adds a new type to `getDocType`.
> **Replaced with:** Use `getDocType(doc)` + `TYPE_LABELS[docType]` for the subtitle, so the sidebar badge stays in sync with the shared type system.

### File 6: `src/webview/design.js` — Add new containers to the `PREVIEW_ERROR_TARGETS` hide array (line 3424)

The `previewError` handler (line 3413-3439) uses a `PREVIEW_ERROR_TARGETS` table to hide containers and show the initial state on error. The `stitch-html-folder` entry (line 3421-3425) currently hides only the iframe wrapper and edit bar:

```js
'stitch-html-folder': {
    status: 'status-stitch-html',
    loading: 'stitch-html-loading-state',
    hide: ['stitch-html-preview-wrapper', 'stitch-html-edit-bar'],
    show: ['stitch-html-initial-state']
},
```

Add the new containers to the `hide` array:

```js
'stitch-html-folder': {
    status: 'status-stitch-html',
    loading: 'stitch-html-loading-state',
    hide: ['stitch-html-preview-wrapper', 'stitch-html-edit-bar', 'stitch-html-markdown-preview', 'stitch-html-image-preview'],
    show: ['stitch-html-initial-state']
},
```

Without this, a markdown/image container stays visible after a preview error, overlapping the re-shown initial state.

## Verification Plan

1. **Markdown rendering:** Place a `.md` file in a Stitch project's `.stitch/screens/` cache directory. Open the Design panel → Stitch HTML tab → select the project. Click the `.md` file in the sidebar tree. Verify the preview pane shows formatted markdown (headings, paragraphs, code blocks, lists) — not raw text, not an iframe, not blank.

2. **HTML still works:** Click an `.html` file in the same sidebar. Verify it renders in the iframe as before — inspect mode, edit bar, zoom all functional.

3. **Image rendering:** Place a `.png` in the cache directory. Click it in the sidebar. Verify the image renders in the image container, not the iframe.

4. **Edit bar visibility:** Verify the edit bar (refine input, variants button) is visible for HTML files and hidden for markdown/image/JSON/YAML files.

5. **Auto-refresh:** With a `.md` file open in the preview, edit and save it on disk. Verify the preview updates with the new content (auto-refresh path, `requestId: -1`).

6. **Container isolation:** Rapidly switch between a `.md` and an `.html` file in the sidebar. Verify no stale content leaks between containers — only one preview container is visible at a time.

7. **Preview error path:** Trigger a preview error (e.g. delete the file on disk while it's being re-fetched, or corrupt the file). Verify the markdown/image container is hidden and the initial state shows — no stale content overlapping the initial state.

8. **CSS parity:** Compare the markdown rendering in the Stitch HTML tab to the Design tab's markdown preview. Headings, code blocks, tables, and blockquotes should look identical (same CSS tokens applied). Run a grep diff confirming `#stitch-html-markdown-preview` appears in every selector group that contains `#markdown-preview-design`.

9. **Sidebar badges:** Verify `.md` files show a "Markdown" badge, `.png` files show "PNG", `.json` files show "JSON", and `.html` files show "HTML" in the Stitch HTML sidebar tree.

10. **JSON/YAML rendering:** Click a `.json` or `.yaml` file in the sidebar. Verify it renders as plain preformatted text (not mangled through the markdown parser).

### Automated Tests

- **SKIPPED per session directive.** The existing test files `src/test/stitch-html-tab-contract.test.js` and `src/test/design-view-state-seats-contract.test.js` exist and should be run manually by the coder after implementation. If they assert on the preview payload structure, confirm the new `fileType` dispatch doesn't break the contract. No automated test execution as part of this plan's verification.

---

**Recommendation:** Complexity 5 → **Send to Coder.**

---

## Completion Summary

Implemented markdown/image/JSON/YAML detection and rendering in the Stitch HTML tab preview pane. In `src/webview/design.html`, added `#stitch-html-markdown-preview` and `#stitch-html-image-preview` sibling containers after `#stitch-html-preview-wrapper` (with inline base styles), and added `#stitch-html-markdown-preview` to all 34 shared markdown-preview CSS selector groups (56 occurrences, parity-verified against `#markdown-preview-design`). In `src/webview/design.js`, restructured the `stitch-html-folder` `handlePreviewReady` branch to dispatch on `msg.isImage`/`msg.fileType` (image → image container; markdown/text → `renderMarkdown`; JSON/YAML → escaped `<pre>`; HTML → existing iframe path), with a `hideAllStitch()` helper enforcing single-container visibility, edit bar shown only for HTML, and zoom/fit moved into the HTML-only else; updated `loadDocumentPreview` and the `PREVIEW_ERROR_TARGETS.hide` array to hide the new containers on load/error; and replaced the hardcoded `'HTML'` sidebar subtitle with `getDocType()` + `TYPE_LABELS`. No issues encountered; `node --check src/webview/design.js` passed and CSS selector count parity (56=56) confirmed. Compilation and automated tests skipped per session directives.

## Review Findings

Two CRITICALs: (1) the feature was **unreachable** — `DesignPanelProvider.ts` filtered the stitch cache listing to `.html` only (`if (path.extname(entry) !== '.html') continue`), so a `.md` file never reached the sidebar, the tab's only way to open a file; the plan's "backend requires no changes" and edge-case #7 ("lists all files without filtering by type") were both wrong. (2) `getDocType(doc)` classifies off `doc.name`, but a stitch doc's `name` is the DB **screen display name** ("Screen A"), not a filename — every existing HTML card regressed from "HTML" to "File". One MAJOR: `#stitch-html-btn-inspect` lives in the controls strip, not the hidden edit bar, so it stayed enabled on a markdown preview and dead-clicked into a stale hidden iframe (PRD contract #6). Fixed in `DesignPanelProvider.ts` (listable-extension set admitting `.html/.htm/.md/.markdown/.txt` while still excluding images — each screen caches an `.html` *and* a `.png`, so listing images would double every row — plus filename-derived names for notes and an html-only "Rebuild Cache" hint), `design.js` (`getDocType({ name: doc.file })`, per-branch inspect-button gating), `design.html` (`.preview-overlay-btn:disabled` styling), and four new regression assertions in the already-CI-wired `src/test/stitch-html-tab-contract.test.js`. Verification: stitch-html-tab 15/15, design-view-state 11/11, plus design-asset/design-system/html-preview-fluid-width/rendermarkdown/panel-runtime-surface/panel-scrollbars/shim-injection all green; `verb-returns:check`, `parity:check`, `push-routing:check` green; `tsc --noEmit` clean for the changed files (5 pre-existing `TS2835` errors in unrelated providers exist at HEAD); eslint 0 errors; CSS parity re-verified per selector *group* (0 groups with `#markdown-preview-design` missing `#stitch-html-markdown-preview`). Remaining risks (deferred, all NIT): `.edit-mode #stitch-html-markdown-preview` is dead (`edit-mode` is set on `#preview-pane-design`, not an ancestor); the image-preview container is now unreachable for this source but kept as harmless plan-specified defensive markup; and `fileType: 'text'` (unknown extension) still routes through `renderMarkdown`, which the listing filter now makes unreachable.
