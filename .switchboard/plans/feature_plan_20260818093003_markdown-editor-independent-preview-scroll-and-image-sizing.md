# Markdown Editor Independent Preview Scrolling and Inline Image Sizing

## Goal
In any panel containing the shared markdown document editor (`markdownEditor.js` across Docs, Design, Project, and Tickets), the markdown editor textarea and the live preview pane get severely out of sync when inline images are present. Because images render at full natural height in the preview while taking up only a single line of text in the raw markdown, the vertical proportions diverge drastically.

The preview panel must be independently scrollable from the editor, and images in the preview must have appropriate responsive layout constraints so the preview remains fluid, aligned, and readable.

### Problem & Root Cause Analysis
1. **Container Height and Scroll Containment**: In `src/webview/markdownEditor.js`, `.md-editor-shell` defines `min-height: 480px` without a rigid height constraint or independent flex layout in certain host panel containers. When images expand `.md-live-preview`, the entire shell/parent container expands, causing the outer page scrollbar to move both panels together rather than allowing the preview pane to scroll within its own viewport.
2. **Missing Image Max-Width/Height Bounds**: In `.md-live-preview.markdown-body img`, if image dimensions are unconstrained, huge screenshots (e.g. 4000x2000px) blow out the preview width and vertical length.
3. **Independent Scroll Synchronization**: In split mode, the editor textarea has its own native scroll, but `.md-live-preview` must have strict `overflow-y: auto`, `height: 100%`, and isolated wheel event handling so users can scroll the preview independently without jerking the editor textarea.

## Metadata
- **Complexity:** 4
- **Tags:** frontend, ui, ux, bugfix
- **Project:** Browser Switchboard

## Complexity Audit
- **Routine (3/4):** Adding CSS rules in `markdownEditor.js` for `.md-live-preview img`, adjusting flexbox properties on `.md-body` and `.md-editor-shell`, and ensuring `overflow-y: auto` is strictly enforced with independent scrolling.
- **Risky/Complex (1/4):** Verifying that all 4 hosting panels (`planning.html`, `design.html`, `project.html`, `tickets.html`) maintain clean layouts in both split, preview-only, and edit-only modes.

## Edge-Case & Dependency Audit
- **Split View vs Full Preview**: In 'split' view mode, `.md-body` splits 50/50 horizontally. Both the `<textarea>` and `.md-live-preview` must independently scroll their respective overflow content.
- **Host Panel Styles**: Host panel CSS (e.g. `#tickets-detail-content`, `.doc-editor-container`) must not force `overflow: visible` or unconstrained heights on the `.md-editor-shell`.
- **Large Inline Images / Diagrams**: SVGs, Mermaid diagrams, and PNG/JPEG attachments must scale cleanly to fit container width (`max-width: 100%; height: auto;`).

## Proposed Changes

### `src/webview/markdownEditor.js`
- Update injected CSS styles for `.md-editor-shell`, `.md-body`, `.md-live-preview`, and images:

```css
.md-editor-shell {
    display: none;
    flex-direction: column;
    border: 1px solid var(--border-color, #30363d);
    background: var(--md-editor-bg, #1a1a1a);
    border-radius: 6px;
    overflow: hidden;
    width: 100%;
    height: 100%;
    min-height: 480px;
    max-height: 100%;
    box-sizing: border-box;
}

.md-body {
    display: flex;
    flex: 1;
    position: relative;
    overflow: hidden;
    width: 100%;
    height: calc(100% - 37px); /* Subtract toolbar height */
    box-sizing: border-box;
}

.md-body > textarea.markdown-editor {
    flex: 1;
    height: 100% !important;
    overflow-y: auto !important;
    box-sizing: border-box;
    /* ... existing font and background styles ... */
}

.md-live-preview {
    flex: 1;
    border-left: 1px solid var(--border-color, #30363d);
    padding: 16px;
    overflow-y: auto !important;
    overflow-x: hidden;
    box-sizing: border-box;
    background: var(--md-editor-bg, #1a1a1a);
    height: 100%;
    max-height: 100%;
    overscroll-behavior: contain;
}

/* Image containment in preview */
.md-live-preview.markdown-body img {
    max-width: 100%;
    height: auto;
    border-radius: 4px;
    margin: 8px 0;
    display: block;
}
```

### Hosting Panel Checks (`tickets.html`, `planning.html`, `design.html`, `project.html`)
- Verify `.edit-mode .md-editor-shell` containers allow flex expansion with `height: 100%` or set container bounds so scrolling occurs within textarea/preview rather than bloating the parent page.

## Verification Plan

### Automated Tests
- Run webview panel contract tests:
  - `npm run test:contract:panel-runtime-surface`
  - `npm run test:contract:panel-scrollbars`

### Manual Verification
1. Open the Docs tab in Planning, or Edit mode on a ticket in Tickets.
2. Insert 3 large inline image URLs or markdown image tags (`![test](image.png)`) alongside paragraphs of text.
3. Switch to "Split" view mode.
4. Scroll the raw markdown textarea: verify it scrolls independently and smoothly.
5. Place cursor in the Preview pane and scroll with mousewheel/trackpad: verify the preview scrolls completely independently from top to bottom without forcing the textarea to scroll or distorting the layout.
6. Verify images are constrained to the preview container width.
