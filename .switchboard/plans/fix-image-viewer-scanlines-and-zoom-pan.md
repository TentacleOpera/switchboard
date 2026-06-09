# Fix Image Viewer: Remove Scanlines from Non-Text Previews & Add Zoom/Pan Canvas Behavior

## Goal

1. **Suppress scanlines** when non-markdown content (images, HTML iframes, JSON, YAML) is active in any preview pane that has a `.cyber-scanlines` overlay.
2. **Add zoom/pan interaction** to all image and HTML iframe previews, using a modifier-key activation model (hold Cmd/Ctrl + scroll to zoom, click-drag to pan).
3. **Add floating UI controls** (zoom in, zoom out, reset, fit) so users discover the capability without reading documentation.

**Problem Analysis:** In `planning.html`, the `.cyber-scanlines` overlay (CRT-style horizontal lines + animated sweep beam at `z-index: 5`) is applied indiscriminately across **all** preview types in tabs that have scanline elements. When a user opens an image file in the **Design System** tab or an image/HTML file in the **HTML Previews** tab, the scanline grid renders on top of the visual content, degrading the viewing experience. Scanlines are intended only for text documents (markdown), not for images, iframe HTML previews, JSON trees, or YAML views.

Additionally, image previews use a bare `<img>` tag with `max-width: 100%; max-height: 100%; object-fit: contain` inside an `overflow: auto` container. There is no zoom, pan, or canvas-style navigation. Users cannot inspect image details or navigate large HTML previews.

**Root Cause:** The scanline overlay is a static CSS-driven element — `.cyber-theme-enabled .cyber-scanlines { display: block }` (L2030) — with no JS logic to conditionally hide it based on content type. The image/iframe containers use simple overflow scrolling with no transform-based zoom capability.

## Metadata

**Tags:** frontend, ui, bugfix, feature
**Complexity:** 5

## User Review Required

- Confirm that zoom/pan interaction model (Cmd/Ctrl + scroll to zoom, click-drag to pan) is acceptable for the target user base.
- Confirm that floating toolbar position (bottom-right) does not overlap with existing UI elements.
- Confirm that iframe zoom behavior (entire iframe scales, internal scrolling still works when modifier not held) meets expectations.

## Complexity Audit

### Routine
- Adding CSS classes for zoomable container and toolbar styles
- Wrapping existing `<img>` and `<iframe>` elements in zoomable viewport divs
- Adding `.scanlines-suppressed` class toggle in JS preview handler
- Adding zoom state object and basic zoom/pan math functions
- Adding floating toolbar HTML markup

### Complex / Risky
- Iframe inside CSS-transformed container may exhibit blurry text or broken coordinate mapping in Chromium/Electron at high zoom levels
- Pan clamping must account for async image dimensions (naturalWidth/naturalHeight unknown until `onload`)
- Shared zoom state key (`'html'`) for both image and iframe in HTML Previews tab requires explicit reset on content type switch to prevent state leak

## Edge-Case & Dependency Audit

- **Race Conditions:** Rapid file switching could cause scanline state to drift if toggle is not in the same JS path as preview mode switch. Mitigation: Toggle scanline visibility inside `handlePreviewReady` (L2250) — the same function that switches preview modes.
- **Security:** No new security surface. Zoom/pan is purely client-side CSS transforms. No data exfiltration risk.
- **Side Effects:** Adding `transform` to containers may affect child element positioning (e.g., `position: fixed` inside iframe breaks under transform). This is a known limitation; acceptable for a viewer.
- **Dependencies & Conflicts:** The `:has()` CSS selector approach originally proposed is fragile (inline style string matching). Replaced with class-based toggle (`.scanlines-suppressed`). No dependency on external libraries.

## Dependencies

None — this is a self-contained UI change within `planning.html` and `planning.js`.

## Adversarial Synthesis

Key risks: (1) The HTML Previews tab has no `.cyber-scanlines` element — half the original CSS was dead code targeting a nonexistent element. (2) Shared zoom state key for image+iframe in HTML tab can leak zoom/pan across content switches if `resetZoom` is not called explicitly. (3) Pan clamping and fit-to-view were specified as stubs without implementation. Mitigations: Remove dead CSS, use class-based scanline toggle, wire `resetZoom` into every `handlePreviewReady` branch, implement `clampPan` and `fit` fully.

## Proposed Changes

### `src/webview/planning.html` — CSS Additions

**Context:** Add zoomable container, toolbar, and scanline-suppression styles to the `<style>` block (after existing scanline styles at ~L2064).

**Implementation:**

```css
/* Zoomable content wrapper */
.zoomable-container {
    position: relative;
    flex: 1;
    overflow: hidden;
    cursor: grab;
    display: flex;
    align-items: center;
    justify-content: center;
}
.zoomable-container.panning {
    cursor: grabbing;
}
.zoomable-viewport {
    transform-origin: top left;
    will-change: transform;
}

/* Class-based scanline suppression — toggled by JS */
.preview-panel-wrapper.scanlines-suppressed > .cyber-scanlines {
    display: none !important;
}

/* Floating zoom toolbar */
.zoom-toolbar {
    position: absolute;
    bottom: 12px;
    right: 12px;
    display: flex;
    gap: 4px;
    z-index: 10;
    background: rgba(0,0,0,0.6);
    backdrop-filter: blur(4px);
    padding: 4px;
    border-radius: 4px;
    border: 1px solid var(--border-color);
}
.zoom-btn {
    width: 28px;
    height: 28px;
    background: var(--panel-bg2);
    border: 1px solid var(--border-color);
    color: var(--text-secondary);
    font-size: 14px;
    line-height: 1;
    cursor: pointer;
    border-radius: 3px;
    transition: all 0.15s;
    display: flex;
    align-items: center;
    justify-content: center;
}
.zoom-btn:hover {
    border-color: var(--accent-teal-dim);
    color: var(--accent-teal);
    background: color-mix(in srgb, var(--accent-teal) 8%, transparent);
}
```

**Edge Cases:** The `.scanlines-suppressed` rule uses `!important` to override `.cyber-theme-enabled .cyber-scanlines { display: block }` (L2030). This is intentional — the JS toggle must win over the theme CSS.

---

### `src/webview/planning.html` — Design Tab Image Container (L3204-3206)

**Context:** Replace the bare image container with a zoomable wrapper.

**Current (L3204-3206):**
```html
<div id="image-preview-container-design" style="display: none; flex: 1; overflow: auto; padding: 16px; text-align: center; justify-content: center; align-items: center;">
    <img id="image-preview-img-design" style="max-width: 100%; max-height: 100%; object-fit: contain;" alt="Image preview" />
</div>
```

**New:**
```html
<div id="image-preview-container-design" class="zoomable-container" style="display: none; padding: 0;">
    <div class="zoomable-viewport">
        <img id="image-preview-img-design" alt="Image preview" style="display: block;" />
    </div>
    <div class="zoom-toolbar">
        <button class="zoom-btn" data-action="zoom-in" title="Zoom In (Cmd+Scroll)">+</button>
        <button class="zoom-btn" data-action="zoom-out" title="Zoom Out (Cmd+Scroll)">−</button>
        <button class="zoom-btn" data-action="reset" title="Reset Zoom">⟲</button>
        <button class="zoom-btn" data-action="fit" title="Fit to View">⤢</button>
    </div>
</div>
```

**Edge Cases:** Removed `max-width/max-height/object-fit` from the `<img>` — the zoomable viewport handles sizing via transform scale. The `padding: 0` override replaces the old `padding: 16px`.

---

### `src/webview/planning.html` — HTML Tab Image Container (L3243-3245)

**Context:** Replace the bare image container with a zoomable wrapper.

**Current (L3243-3245):**
```html
<div id="image-preview-container" style="display: none; flex: 1; overflow: auto; background: var(--panel-bg); padding: 16px; text-align: center;">
    <img id="image-preview-img" style="max-width: 100%; max-height: 100%; object-fit: contain;" alt="Image preview" />
</div>
```

**New:**
```html
<div id="image-preview-container" class="zoomable-container" style="display: none; padding: 0;">
    <div class="zoomable-viewport">
        <img id="image-preview-img" alt="Image preview" style="display: block;" />
    </div>
    <div class="zoom-toolbar">
        <button class="zoom-btn" data-action="zoom-in" title="Zoom In (Cmd+Scroll)">+</button>
        <button class="zoom-btn" data-action="zoom-out" title="Zoom Out (Cmd+Scroll)">−</button>
        <button class="zoom-btn" data-action="reset" title="Reset Zoom">⟲</button>
        <button class="zoom-btn" data-action="fit" title="Fit to View">⤢</button>
    </div>
</div>
```

---

### `src/webview/planning.html` — HTML Tab Iframe (L3242)

**Context:** Wrap the iframe in a zoomable container. The iframe remains a direct child of the viewport for correct rendering.

**Current (L3242):**
```html
<iframe id="html-preview-frame" sandbox="allow-scripts allow-same-origin" style="flex: 1; border: none; background: var(--panel-bg); width: 100%; height: 100%; display: none;"></iframe>
```

**New:**
```html
<div id="html-preview-wrapper" class="zoomable-container" style="display: none; flex: 1;">
    <div class="zoomable-viewport" style="width: 100%; height: 100%;">
        <iframe id="html-preview-frame" sandbox="allow-scripts allow-same-origin" style="border: none; background: var(--panel-bg); width: 100%; height: 100%; display: block;"></iframe>
    </div>
    <div class="zoom-toolbar">
        <button class="zoom-btn" data-action="zoom-in" title="Zoom In (Cmd+Scroll)">+</button>
        <button class="zoom-btn" data-action="zoom-out" title="Zoom Out (Cmd+Scroll)">−</button>
        <button class="zoom-btn" data-action="reset" title="Reset Zoom">⟲</button>
        <button class="zoom-btn" data-action="fit" title="Fit to View">⤢</button>
    </div>
</div>
```

**Edge Cases:** Iframe inside a CSS-transformed container may exhibit blurry text at high zoom in Chromium/Electron. This is a known limitation acceptable for a viewer (not an editor). The iframe's `display: block` removes the inline gap that `display: none` previously set — visibility is now controlled by the wrapper's `display: none`.

---

### `src/webview/planning.js` — Zoom/Pan Engine (insert after state initialization, ~L47)

**Context:** Add zoom state management, transform application, pan clamping, and event listener initialization.

**Logic:**

```js
// ── Zoom/Pan Engine ──
const zoomState = {
    html:     { scale: 1, panX: 0, panY: 0, isPanning: false, startX: 0, startY: 0 },
    design:   { scale: 1, panX: 0, panY: 0, isPanning: false, startX: 0, startY: 0 },
};

const ZOOM_MIN = 0.1;
const ZOOM_MAX = 10.0;
const ZOOM_STEP = 0.1;

function resetZoom(tab) {
    zoomState[tab] = { scale: 1, panX: 0, panY: 0, isPanning: false, startX: 0, startY: 0 };
}

function applyZoom(tab, viewportEl) {
    if (!viewportEl) return;
    viewportEl.style.transform = `translate(${zoomState[tab].panX}px, ${zoomState[tab].panY}px) scale(${zoomState[tab].scale})`;
}

function clampPan(tab, containerRect, contentWidth, contentHeight) {
    const s = zoomState[tab].scale;
    const minX = Math.min(0, containerRect.width - contentWidth * s);
    const minY = Math.min(0, containerRect.height - contentHeight * s);
    const maxX = Math.max(0, containerRect.width - contentWidth * s);
    const maxY = Math.max(0, containerRect.height - contentHeight * s);
    zoomState[tab].panX = Math.max(minX, Math.min(maxX, zoomState[tab].panX));
    zoomState[tab].panY = Math.max(minY, Math.min(maxY, zoomState[tab].panY));
}

function fitToContainer(tab, containerEl, viewportEl) {
    if (!containerEl || !viewportEl) return;
    const containerRect = containerEl.getBoundingClientRect();
    // Measure content: first child of viewport (img or iframe)
    const contentEl = viewportEl.firstElementChild;
    if (!contentEl) return;
    let contentW, contentH;
    if (contentEl.tagName === 'IMG') {
        contentW = contentEl.naturalWidth || contentEl.offsetWidth;
        contentH = contentEl.naturalHeight || contentEl.offsetHeight;
    } else {
        contentW = contentEl.offsetWidth;
        contentH = contentEl.offsetHeight;
    }
    if (!contentW || !contentH) return;
    const fitScale = Math.min(containerRect.width / contentW, containerRect.height / contentH, 1);
    zoomState[tab].scale = fitScale;
    zoomState[tab].panX = (containerRect.width - contentW * fitScale) / 2;
    zoomState[tab].panY = (containerRect.height - contentH * fitScale) / 2;
    applyZoom(tab, viewportEl);
}

function initZoomListeners(containerId, viewportSelector, tab) {
    const container = document.getElementById(containerId);
    if (!container) return;

    container.addEventListener('wheel', (e) => {
        if (!e.metaKey && !e.ctrlKey) return; // Modifier not held — let native scroll pass
        e.preventDefault();

        const delta = e.deltaY > 0 ? -ZOOM_STEP : ZOOM_STEP;
        zoomState[tab].scale = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, zoomState[tab].scale + delta));
        applyZoom(tab, container.querySelector(viewportSelector));
    }, { passive: false });

    container.addEventListener('mousedown', (e) => {
        // Only left-click, ignore toolbar clicks
        if (e.button !== 0 || e.target.closest('.zoom-toolbar')) return;
        zoomState[tab].isPanning = true;
        zoomState[tab].startX = e.clientX - zoomState[tab].panX;
        zoomState[tab].startY = e.clientY - zoomState[tab].panY;
        container.classList.add('panning');
    });

    window.addEventListener('mousemove', (e) => {
        if (!zoomState[tab].isPanning) return;
        zoomState[tab].panX = e.clientX - zoomState[tab].startX;
        zoomState[tab].panY = e.clientY - zoomState[tab].startY;
        // Clamp pan to keep content visible
        const containerRect = container.getBoundingClientRect();
        const viewportEl = container.querySelector(viewportSelector);
        const contentEl = viewportEl ? viewportEl.firstElementChild : null;
        if (contentEl) {
            const cw = contentEl.tagName === 'IMG' ? (contentEl.naturalWidth || contentEl.offsetWidth) : contentEl.offsetWidth;
            const ch = contentEl.tagName === 'IMG' ? (contentEl.naturalHeight || contentEl.offsetHeight) : contentEl.offsetHeight;
            clampPan(tab, containerRect, cw, ch);
        }
        applyZoom(tab, viewportEl);
    });

    window.addEventListener('mouseup', () => {
        if (!zoomState[tab].isPanning) return;
        zoomState[tab].isPanning = false;
        container.classList.remove('panning');
    });

    // Toolbar button delegation
    container.addEventListener('click', (e) => {
        const btn = e.target.closest('.zoom-btn');
        if (!btn) return;
        const action = btn.dataset.action;
        const viewportEl = container.querySelector(viewportSelector);
        if (action === 'zoom-in') {
            zoomState[tab].scale = Math.min(ZOOM_MAX, zoomState[tab].scale + ZOOM_STEP * 2);
        } else if (action === 'zoom-out') {
            zoomState[tab].scale = Math.max(ZOOM_MIN, zoomState[tab].scale - ZOOM_STEP * 2);
        } else if (action === 'reset') {
            resetZoom(tab);
        } else if (action === 'fit') {
            fitToContainer(tab, container, viewportEl);
            return; // fitToContainer calls applyZoom internally
        }
        applyZoom(tab, viewportEl);
    });
}
```

**Call initialization once during panel setup** (after DOM is ready, near end of IIFE):

```js
initZoomListeners('image-preview-container',       '.zoomable-viewport', 'html');
initZoomListeners('html-preview-wrapper',           '.zoomable-viewport', 'html');
initZoomListeners('image-preview-container-design', '.zoomable-viewport', 'design');
```

**Edge Cases:** Both HTML-tab containers share the `'html'` zoom state key. This is safe because only one is visible at a time, and `resetZoom('html')` is called on every file switch (see next section). The `fitToContainer` function handles the `fit` toolbar action fully — it measures content dimensions, computes fit scale, centers the content, and applies the transform.

---

### `src/webview/planning.js` — Scanline Toggle & Zoom Reset in `handlePreviewReady` (L2250)

**Context:** The `handlePreviewReady` function switches preview modes. This is the correct place to toggle scanline visibility and reset zoom state, because it's the single code path that controls what content type is displayed.

**Logic for `sourceId === 'html-folder'` branch (L2253-2314):**

At the top of the branch (after L2254 request ID check), add:

```js
// Reset zoom state for HTML tab on every new file load
resetZoom('html');
```

In the `isImage && webviewUri` block (L2266-2270), after showing the image container, add:

```js
// Apply initial fit-to-container after image loads
if (imageImg) {
    imageImg.onload = () => {
        const container = document.getElementById('image-preview-container');
        const viewport = container ? container.querySelector('.zoomable-viewport') : null;
        if (container && viewport) {
            fitToContainer('html', container, viewport);
        }
    };
}
```

In the `htmlContent` block (L2271-2286), after showing the iframe, add:

```js
// Apply default zoom for iframe (scale 1, pan 0 — already set by resetZoom)
const iframeWrapper = document.getElementById('html-preview-wrapper');
const iframeViewport = iframeWrapper ? iframeWrapper.querySelector('.zoomable-viewport') : null;
if (iframeWrapper && iframeViewport) {
    applyZoom('html', iframeViewport);
}
```

**Note:** The HTML Previews tab (`#preview-pane-html`) does NOT have a `.cyber-scanlines` element. No scanline toggle is needed for this tab — scanlines were never applied here.

---

**Logic for `sourceId === 'design-folder'` branch (L2317-2438):**

At the top of the branch (after L2318 request ID check), add:

```js
// Reset zoom state for Design tab on every new file load
resetZoom('design');
```

**Scanline toggle:** The Design tab's `.preview-panel-wrapper` (parent of `#preview-pane-design`) contains a `.cyber-scanlines` element at L3212. Toggle it based on content type:

```js
// Helper: toggle scanlines on the Design tab's preview-panel-wrapper
const designWrapper = document.querySelector('#design-content .preview-panel-wrapper');
```

Then in each content-type branch:

- **`isImage && webviewUri` (L2334-2340):** Add `if (designWrapper) designWrapper.classList.add('scanlines-suppressed');`
  Also add image fit-to-container:
  ```js
  if (imgImg) {
      imgImg.onload = () => {
          const container = document.getElementById('image-preview-container-design');
          const viewport = container ? container.querySelector('.zoomable-viewport') : null;
          if (container && viewport) {
              fitToContainer('design', container, viewport);
          }
      };
  }
  ```

- **`msg.fileType === 'json'` (L2341-2357):** Add `if (designWrapper) designWrapper.classList.add('scanlines-suppressed');`

- **`msg.fileType === 'yaml'` (L2358-2379):** Add `if (designWrapper) designWrapper.classList.add('scanlines-suppressed');`

- **`msg.fileType === 'css' || msg.fileType === 'xml' || msg.fileType === 'text'` (L2380-2391):** Add `if (designWrapper) designWrapper.classList.add('scanlines-suppressed');` — code previews should also suppress scanlines for readability.

- **Markdown/default (L2392-2413):** Add `if (designWrapper) designWrapper.classList.remove('scanlines-suppressed');` — restore scanlines for markdown text.

**Edge Cases:** The `scanlines-suppressed` class uses `!important` in CSS to override `.cyber-theme-enabled .cyber-scanlines { display: block }`. When switching back to markdown, the class is removed and scanlines reappear automatically.

---

### `src/webview/planning.js` — HTML Tab Container Visibility Updates

**Context:** The `handlePreviewReady` html-folder branch (L2253-2314) currently toggles `imageContainer.style.display` and `iframe.style.display`. After wrapping the iframe in `#html-preview-wrapper`, the visibility toggle must target the wrapper instead of the bare iframe.

**Changes in `isImage && webviewUri` block (L2266-2270):**
- `iframe.style.display = 'none'` → `const iframeWrapper = document.getElementById('html-preview-wrapper'); if (iframeWrapper) iframeWrapper.style.display = 'none';`

**Changes in `htmlContent` block (L2271-2286):**
- `iframe.style.display = ''` → `const iframeWrapper = document.getElementById('html-preview-wrapper'); if (iframeWrapper) iframeWrapper.style.display = 'flex';`
- The `iframe` element itself stays `display: block` (set in HTML) — the wrapper controls visibility.

**Changes in `loadDocumentPreview` html-folder branch (L1130-1166):**
- L1156: `if (previewFrame) previewFrame.style.display = 'none';` → `const iframeWrapper = document.getElementById('html-preview-wrapper'); if (iframeWrapper) iframeWrapper.style.display = 'none';`

**Changes in error handler (L2591-2612):**
- L2605-2606: `iframe.style.display = ''` → `const iframeWrapper = document.getElementById('html-preview-wrapper'); if (iframeWrapper) iframeWrapper.style.display = 'flex';`

## Verification Plan

### Automated Tests

No automated tests applicable — this is a webview UI feature. Manual verification required.

### Manual Verification

1. Open the **Design System** tab, select an image file. Confirm:
   - No scanline overlay on the image.
   - Hold Cmd + scroll → image zooms.
   - Click-drag → pans the zoomed image (content stays visible, no off-screen drift).
   - Floating toolbar buttons work (zoom in, zoom out, reset, fit).
   - Switch to a markdown file → scanlines return.
2. Open the **Design System** tab, select a JSON or YAML file. Confirm:
   - No scanline overlay on the JSON tree / YAML tree.
   - Switch to markdown → scanlines return.
3. Open the **HTML Previews** tab, select an image file. Confirm:
   - Same zoom/pan behavior as Design tab.
   - No scanline overlay (HTML tab never had scanlines, so this should be unchanged).
4. Open the **HTML Previews** tab, select an HTML file. Confirm:
   - Normal scroll works inside the iframe (modifier not held).
   - Cmd + scroll zooms the entire iframe view.
   - Click-drag pans the zoomed iframe.
   - Toolbar buttons work.
5. Switch between image and HTML file in HTML Previews tab. Confirm zoom state resets (no bleed-through from previous file).
6. Verify reduced-motion preference still works; the sweep beam animation is independent of the scanline visibility toggle.
7. Verify the `.edit-mode` CSS rule at L2429 still hides `#image-preview-container-design` correctly after the class change (the ID selector is unchanged, so this should work).

## Remaining Risks

- **Iframe rendering under transform:** Iframes inside CSS-transformed containers may exhibit blurry text or broken coordinate mapping at high zoom in Chromium/Electron. Acceptable for a viewer; not for an editor.
- **Accessibility:** Keyboard-only users cannot zoom/pan. Consider adding keyboard shortcuts (e.g., `+`, `-`, `0` keys when the preview pane is focused) in a follow-up.
- **Window-level listeners:** Three `mousemove`/`mouseup` pairs on `window` fire on every mouse event. Low overhead but could be optimized with attach-on-pan-start/detach-on-pan-end pattern in a follow-up.

## Review Findings

Two issues found and fixed in `src/webview/planning.js`. (1) CRITICAL: The HTML Previews tab has a `.cyber-scanlines` element (L3372) but the plan incorrectly stated it didn't; no scanline suppression was applied for HTML tab images/iframes. Fixed by adding `htmlWrapper` query and `scanlines-suppressed` class toggle in all html-folder branches. (2) MAJOR: `resetZoom()` resets JS state but never applies the reset transform to DOM viewport elements, causing stale transforms on cache-hit and fallback iframe branches. Fixed by adding `applyZoom()` calls after every container visibility toggle in both html-folder and design-folder branches. No automated tests apply (webview UI); manual verification per the Verification Plan is required.
