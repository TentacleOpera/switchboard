# Markdown Editor Independent Preview Scrolling and Inline Image Sizing

## Goal
In any panel containing the shared markdown document editor (`markdownEditor.js` across Docs, Design, Project, and Tickets), the markdown editor textarea and the live preview pane get severely out of sync when inline images are present. Because images render at full natural height in the preview while taking up only a single line of text in the raw markdown, the vertical proportions diverge drastically.

The preview panel must be independently scrollable from the editor, and images in the preview must have appropriate responsive layout constraints so the preview remains fluid, aligned, and readable.

### Problem & Root Cause Analysis
1. **Container Height and Scroll Containment**: In `src/webview/markdownEditor.js`, `.md-editor-shell` defines `min-height: 480px` without a rigid height constraint or independent flex layout in certain host panel containers. When images expand `.md-live-preview`, the entire shell/parent container expands, causing the outer page scrollbar to move both panels together rather than allowing the preview pane to scroll within its own viewport.
2. **Missing Image Max-Width/Height Bounds**: In `.md-live-preview.markdown-body img`, if image dimensions are unconstrained, huge screenshots (e.g. 4000x2000px) blow out the preview width and vertical length.
3. **Independent Scroll Synchronization**: In split mode, the editor textarea has its own native scroll, but `.md-live-preview` must have strict `overflow-y: auto`, `height: 100%`, and isolated wheel event handling so users can scroll the preview independently without jerking the editor textarea.

### Deepened Root Cause — The Flexbox Height Chain (added during improve pass)

The original analysis correctly identified the symptoms but located the fix in the wrong layer. The root cause is a **broken flexbox height-resolution chain** from each host panel's bounded container down to `.md-editor-shell`. `height: 100%` only resolves to a definite length if the parent has a definite height. In all four host panels, intermediate containers between the bounded ancestor (`.preview-panel-wrapper` with `height: 100%; overflow: hidden`) and `.md-editor-shell` lack `min-height: 0` and/or `overflow: hidden`, so their heights compute to `auto` (content-determined). This makes `.md-editor-shell`'s `height: 100%` also resolve to `auto` — the shell grows with its content, `.md-live-preview`'s `overflow-y: auto` never triggers (the element is exactly as tall as its content), and the outer panel scrollbar moves instead.

The fix must be applied at **two layers**:
- **Layer 1 — `markdownEditor.js`**: The shell, body, textarea, and preview CSS must establish internal scroll containment (`height: 100%`, `overflow: hidden` on shell and body, `overflow-y: auto` on textarea and preview, `overscroll-behavior: contain` on preview).
- **Layer 2 — Host panel containers**: Every intermediate flex container between `.preview-panel-wrapper` and `.md-editor-shell` must have `min-height: 0` (the classic flexbox overflow fix) so it can shrink below its content size, and `overflow: hidden` so it doesn't become the scroller itself. Two panels (tickets.html, design.html) have inline `overflow-y: auto` on intermediate containers that actively makes the wrapper the scroller — these must be changed to `overflow: hidden`.

## Metadata
- **Complexity:** 5
- **Tags:** frontend, ui, ux, bugfix
- **Project:** Browser Switchboard

## User Review Required

This plan changes CSS in 4 host panel HTML files and 1 JS file. The changes are scoped to edit-mode layout only (view-mode preview containers are untouched), but the `min-height: 0` and `overflow: hidden` additions to intermediate containers could affect non-edit-mode layout if those containers are shared between modes. Review the per-file changes below before implementation to confirm no view-mode regressions.

## Complexity Audit

### Routine
- Adding `max-width: 100%; height: auto` image constraint CSS to `.md-live-preview.markdown-body img` in `markdownEditor.js` — standard responsive image pattern, no existing rule covers this selector.
- Adding `overscroll-behavior: contain` to `.md-live-preview` for scroll isolation.
- Adding `overflow-y: auto !important` and `height: 100%` to the textarea inside `.md-body` so it scrolls independently.
- Adding `min-height: 0` to intermediate flex containers in the 4 host panel HTML files — a one-property-per-container additive change.

### Complex / Risky
- **Tickets.html**: `.preview-content-wrapper` has inline `overflow-y: auto` that must change to `overflow: hidden` — this wrapper is shared between edit mode and view mode (ticket detail rendering). Changing it to `overflow: hidden` could clip view-mode ticket detail content that currently scrolls via the wrapper. Must verify that view-mode content has its own scroll container or that `#tickets-detail-content` handles overflow.
- **Design.html**: `#preview-pane-design` has inline `overflow: auto` — same shared-container concern. This pane hosts markdown preview, HTML preview, image preview, and JSON preview, not just the editor. Changing it to `overflow: hidden` could break non-markdown preview modes.
- **Tickets.js**: The textarea is created with inline `style="min-height:480px;height:auto;resize:vertical;..."`. The `resize:vertical` must change to `resize: none` to prevent manual resize from breaking the flex layout. This is a JS source change in a dynamically-generated HTML string.
- **Project.html**: `.preview-panel-wrapper` has different CSS (`flex: 1; flex-shrink: 0; min-width: 360px`) from the other three panels (`flex: 3; height: 100%; overflow: hidden`). The height chain may require different handling here.

## Edge-Case & Dependency Audit
- **Split View vs Full Preview**: In 'split' view mode, `.md-body` splits 50/50 horizontally. Both the `<textarea>` and `.md-live-preview` must independently scroll their respective overflow content. The `flex: 1` on both children handles the 50/50 split; the `overflow-y: auto` on each handles independent scroll.
- **Host Panel Styles**: Host panel CSS (e.g. `#tickets-detail-content`, `.preview-content-wrapper`) must not force `overflow: visible` or unconstrained heights on the `.md-editor-shell`. The intermediate containers need `overflow: hidden` and `min-height: 0` to establish the bounded height chain.
- **Large Inline Images / Diagrams**: SVGs, Mermaid diagrams, and PNG/JPEG attachments must scale cleanly to fit container width (`max-width: 100%; height: auto;`). The existing panel-level image rules (`#markdown-preview img`, `#kanban-preview-pane img`, etc.) target view-mode preview containers and do NOT cover `.md-live-preview img` — the new rule in `markdownEditor.js` fills this gap.
- **Toolbar Wrap**: The toolbar has `flex-wrap: wrap`. On narrow viewports, buttons wrap to a second row, making the toolbar taller. The `.md-body` must use `flex: 1` (not a fixed `calc(100% - 37px)`) so it fills the remaining space regardless of toolbar height.
- **View-Mode Regression Risk**: The intermediate containers being modified (`#preview-pane`, `.preview-content-wrapper`, `#preview-pane-design`) are shared between edit mode and view mode. The `overflow: hidden` + `min-height: 0` changes must not clip or break view-mode content scrolling.
- **Mobile/Narrow Viewport**: The `@media (max-width: 640px)` rule switches `.md-body` to `flex-direction: column`. In column mode, the textarea and preview stack vertically — both still need `overflow-y: auto` and bounded heights to scroll independently. The `flex: 1` on each child handles this in column mode too.
- **Large Document Pause**: `markdownEditor.js` already pauses live preview for documents > 30,000 chars and forces edit mode. This is unaffected by the CSS changes.

## Dependencies
- None

## Adversarial Synthesis

Key risks: (1) The original plan's CSS-only fix to `markdownEditor.js` cannot work without bounded ancestor containers — `height: 100%` resolves to `auto` when the parent height is content-determined, so the preview pane never scrolls independently. (2) Two host panels (tickets.html, design.html) have inline `overflow-y: auto` on intermediate containers that makes the wrapper the scroller, actively breaking the design. (3) The shared-container changes (`overflow: hidden` on intermediate wrappers) could regress view-mode content scrolling in tickets and design. Mitigations: add `min-height: 0` + `overflow: hidden` to every intermediate flex container in the chain; change inline `overflow-y: auto` to `overflow: hidden` on the two affected panels; use `flex: 1` instead of `calc(100% - 37px)` for toolbar-height resilience; verify view-mode layout in each panel after changes.

## Proposed Changes

### `src/webview/markdownEditor.js` — injected CSS (lines 7–220)

Update the injected stylesheet to establish internal scroll containment within the shell. The shell, body, textarea, and preview must form a self-contained scroll system once the ancestor chain is bounded.

> **Superseded:** The original plan proposed adding `height: 100%`, `max-height: 100%` to `.md-editor-shell`, `height: calc(100% - 37px)` to `.md-body`, and `overflow-y: auto !important` to the textarea — all in `markdownEditor.js` alone, with no changes to host panel containers.
> **Reason:** `height: 100%` on `.md-editor-shell` resolves to `auto` when the parent container's height is content-determined (which it is in all four host panels — the intermediate flex containers lack `min-height: 0`). The shell grows with content, `overflow-y: auto` on `.md-live-preview` never triggers, and the outer panel scrolls instead. The `calc(100% - 37px)` is fragile — the toolbar wraps on narrow viewports, making 37px wrong. The existing `flex: 1` on `.md-body` already fills the remaining space after the toolbar without a magic number.
> **Replaced with:** The CSS changes below for `markdownEditor.js` (internal scroll containment) PLUS the host panel container fixes in the sections that follow. The shell uses `height: 100%; max-height: 100%; overflow: hidden` — but these only work because the host panel changes establish a bounded ancestor chain. The `calc(100% - 37px)` is dropped; `flex: 1` on `.md-body` is kept as-is. The textarea gets `height: 100% !important; overflow-y: auto !important` to scroll independently within the body.

**`.md-editor-shell`** (currently lines 7–23):
```css
.md-editor-shell {
    display: none;
    flex-direction: column;
    border: 1px solid var(--border-color, #30363d);
    background: var(--md-editor-bg, #1a1a1a);
    border-radius: 6px;
    overflow: hidden;
    width: 100%;
    height: 100%;        /* NEW — resolves to definite once ancestors are bounded */
    min-height: 480px;
    max-height: 100%;    /* NEW — prevents growing beyond parent */
    box-sizing: border-box;
}
```

**`.md-body`** (currently lines 85–92) — keep `flex: 1`, add `min-height: 0` (the flexbox overflow fix):
```css
.md-body {
    display: flex;
    flex: 1;
    min-height: 0;       /* NEW — allows body to shrink below content size so children can scroll */
    position: relative;
    overflow: hidden;
    width: 100%;
    box-sizing: border-box;
}
```

**`.md-body > textarea.markdown-editor`** (currently lines 93–111) — change `height: auto` to `height: 100%` and add `overflow-y: auto`:
```css
.md-body > textarea.markdown-editor {
    flex: 1;
    min-height: 0;       /* NEW — allows textarea to shrink so overflow-y triggers */
    border: none !important;
    resize: none;
    background: transparent;
    color: var(--text-color, #c9d1d9);
    font-family: var(--font-code);
    font-size: 13px;
    padding: 12px;
    box-sizing: border-box;
    outline: none;
    height: 100% !important;       /* CHANGED from height: auto */
    overflow-y: auto !important;   /* NEW — independent textarea scroll */
    margin: 0 !important;
    display: block !important;
}
```

**`.md-live-preview`** (currently lines 112–123) — add `min-height: 0`, `max-height: 100%`, `overscroll-behavior: contain`, change `overflow-y: auto` to `overflow-y: auto !important`:
```css
.md-live-preview {
    flex: 1;
    min-height: 0;               /* NEW — allows preview to shrink so overflow-y triggers */
    border-left: 1px solid var(--border-color, #30363d);
    padding: 12px;
    overflow-y: auto !important; /* CHANGED — !important to beat host panel rules */
    overflow-x: hidden;
    box-sizing: border-box;
    background: var(--md-editor-bg, #1a1a1a);
    height: 100%;
    max-height: 100%;            /* NEW — prevents growing beyond body */
    overscroll-behavior: contain; /* NEW — scroll isolation, no scroll chaining */
}
```

**Image containment** — add a new rule after the `.md-live-preview.markdown-body` block (after line 130):
```css
.md-live-preview.markdown-body img {
    max-width: 100%;
    height: auto;
    border-radius: 4px;
    margin: 8px 0;
    display: block;
}
```

### `src/webview/planning.html` — ancestor chain fix (Docs tab)

The Docs tab container chain: `.preview-panel-wrapper` (bounded ✓) → `#preview-pane` → `.preview-content-wrapper` → `.md-editor-shell`.

**`#preview-pane`** (line 3699, inline style) — add `min-height: 0; overflow: hidden`:
```html
<div id="preview-pane" style="flex: 1; width: 100%; box-sizing: border-box; display: flex; flex-direction: column; min-height: 0; overflow: hidden;">
```

**`.preview-content-wrapper`** (CSS at line 1038) — add `min-height: 0; overflow: hidden`:
```css
.preview-content-wrapper {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;        /* NEW */
    overflow: hidden;     /* NEW */
}
```

### `src/webview/tickets.html` — ancestor chain fix + inline overflow removal

The Tickets tab container chain: `.preview-panel-wrapper` (bounded ✓) → `.preview-content-wrapper` (inline `overflow-y: auto` — THE SCROLLER, must change) → `#tickets-detail-content` → `.md-editor-shell`.

**`.preview-content-wrapper`** (line 4099, inline style) — change `overflow-y: auto` to `overflow: hidden`, add `min-height: 0`:
```html
<div class="preview-content-wrapper" style="flex: 1; overflow: hidden; min-height: 0;">
```

**`.preview-content-wrapper`** (CSS at line 1073) — add `min-height: 0; overflow: hidden` to the class rule (the inline style overrides for the tickets-detail pane, but the class rule covers other instances):
```css
.preview-content-wrapper {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;        /* NEW */
    overflow: hidden;     /* NEW */
}
```

**`#tickets-detail-content`** — this div has no explicit CSS height. In edit mode, the `.md-editor-shell` is inserted as its child. For the shell's `height: 100%` to resolve, `#tickets-detail-content` needs to fill its parent. Add a CSS rule:
```css
.edit-mode #tickets-detail-content {
    flex: 1;
    min-height: 0;
    overflow: hidden;
    display: flex;
    flex-direction: column;
}
```

### `src/webview/tickets.js` — textarea inline style fix (line 3100)

The textarea is created with inline `height:auto;resize:vertical`. The `resize:vertical` lets the user manually resize the textarea, which breaks the flex layout (the textarea gets a fixed pixel height that overrides `flex: 1`). Change `resize:vertical` to `resize:none` and remove `height:auto` (the stylesheet's `height: 100% !important` will control it):

```javascript
html += `<textarea id="ticket-edit-description" class="markdown-editor" spellcheck="true" style="min-height:480px;resize:none;white-space:pre-wrap;line-height:1.6;">${escapeHtml(descMarkdown)}</textarea>`;
```

Note: `min-height:480px` is kept as a fallback for when the shell hasn't attached yet (the shell's `min-height: 480px` takes over once attached). The `height:auto` is removed because the stylesheet's `height: 100% !important` supersedes it.

### `src/webview/design.html` — ancestor chain fix + inline overflow removal

The Design tab container chain: `.preview-panel-wrapper` (bounded ✓) → `#preview-pane-design` (inline `overflow: auto` — THE SCROLLER, must change) → `.preview-content-wrapper` (inline `height: 100%`) → `.md-editor-shell`.

**`#preview-pane-design`** (line 3733, inline style) — change `overflow: auto` to `overflow: hidden`, add `min-height: 0`:
```html
<div id="preview-pane-design" style="flex: 1; width: 100%; box-sizing: border-box; overflow: hidden; height: 100%; min-height: 0;">
```

**`.preview-content-wrapper`** (line 3734, inline style) — add `min-height: 0; overflow: hidden`:
```html
<div class="preview-content-wrapper" style="height: 100%; display: flex; flex-direction: column; min-height: 0; overflow: hidden;">
```

**`.preview-content-wrapper`** (CSS at line 1007) — add `min-height: 0; overflow: hidden` to the class rule:
```css
.preview-content-wrapper {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;        /* NEW */
    overflow: hidden;     /* NEW */
}
```

**CAUTION**: `#preview-pane-design` hosts markdown preview, HTML preview, image preview, and JSON preview — not just the editor. Changing `overflow: auto` to `overflow: hidden` could clip non-markdown preview content. Verify that each preview mode (`#html-preview-container-design`, `#image-preview-container-design`, `#json-preview-container-design`) has its own overflow handling. If they rely on `#preview-pane-design`'s `overflow: auto` to scroll, the change must be scoped to edit mode only — e.g., use `.edit-mode #preview-pane-design { overflow: hidden; }` instead of changing the inline style.

### `src/webview/project.html` — ancestor chain fix

The Project tab has multiple editor instances (kanban, features, constitution, system, tuning, projects), each in its own preview pane. The `.preview-panel-wrapper` here has different CSS (`flex: 1; flex-shrink: 0; min-width: 360px`) — no `height: 100%` or `overflow: hidden`.

**`.preview-panel-wrapper`** (CSS at line 211) — add `height: 100%; overflow: hidden` to match the other panels:
```css
.preview-panel-wrapper {
    flex: 1;
    flex-shrink: 0;
    min-width: 360px;
    height: 100%;       /* NEW */
    overflow: hidden;   /* NEW */
    display: flex;
    flex-direction: column;
}
```

**`.kanban-preview-pane, .features-preview-pane`** (CSS at line 220) — already have `flex: 1; display: flex; flex-direction: column; min-height: 0` ✓. No change needed.

**`.constitution-preview-pane, .tuning-preview-pane`** (CSS at line 226) — these have `overflow-y: auto` (they are the scroller in view mode). In edit mode, the `.md-editor-shell` is inserted as a child. For the shell to fill the pane, add an edit-mode override:
```css
.edit-mode .constitution-preview-pane,
.edit-mode .tuning-preview-pane {
    overflow: hidden;
}
```

**`#projects-preview-pane`** (line 1348) — uses class `constitution-preview-pane`, so the edit-mode override above covers it.

**Each editor textarea** (`#kanban-editor`, `#features-editor`, `#constitution-editor`, `#system-editor`, `#tuning-editor`, `#projects-editor`) — these are children of their respective preview panes. When `SwitchboardMarkdownEditor.attach()` wraps them in `.md-editor-shell`, the shell becomes the pane's child. The pane's `flex: 1; min-height: 0` (for kanban/features) or the edit-mode `overflow: hidden` override (for constitution/tuning) establishes the bounded height. No per-textarea CSS change needed — the `markdownEditor.js` injected CSS handles the shell internals.

## Verification Plan

### Automated Tests
- Run webview panel contract tests:
  - `npm run test:contract:panel-runtime-surface`
  - `npm run test:contract:panel-scrollbars`

Note: these tests validate panel-level CSS patterns (scrollbar styling, CSP, terminal handlers) and do NOT directly test the markdown editor's scroll behavior. They serve as regression guards to confirm the host panel CSS changes don't break existing panel contracts. The real verification is the manual steps below.

### Manual Verification
1. Open the Docs tab in Planning, or Edit mode on a ticket in Tickets.
2. Insert 3 large inline image URLs or markdown image tags (`![test](image.png)`) alongside paragraphs of text.
3. Switch to "Split" view mode.
4. Scroll the raw markdown textarea: verify it scrolls independently and smoothly (the preview pane does NOT move).
5. Place cursor in the Preview pane and scroll with mousewheel/trackpad: verify the preview scrolls completely independently from top to bottom without forcing the textarea to scroll or distorting the layout. **Critical check**: confirm the preview pane has its OWN scrollbar (6px dark styled), NOT the outer panel scrollbar moving.
6. Verify images are constrained to the preview container width (`max-width: 100%`) and maintain aspect ratio (`height: auto`).
7. Repeat steps 1–6 in each of the four host panels: Planning (Docs), Tickets, Design, Project (any sub-tab with an editor).
8. In each panel, switch to "Edit" only mode and "Preview" only mode — verify the layout fills the container without clipping or overflow.
9. In Tickets, verify that view-mode (non-edit) ticket detail content still scrolls correctly (the `overflow: hidden` on `.preview-content-wrapper` must not clip view-mode content).
10. In Design, verify that HTML preview, image preview, and JSON preview modes still scroll correctly (the `overflow: hidden` on `#preview-pane-design` must not clip non-markdown preview content — if it does, scope the change to edit mode only).
11. Narrow the browser window to < 640px width — verify the split view switches to column mode and both textarea and preview still scroll independently.
