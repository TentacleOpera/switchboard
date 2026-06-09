# Fix HTML Preview Pane Clipping Under Left Sidebar

## Goal

Prevent HTML files rendered in the doc preview iframe from visually clipping underneath the left sidebar in the HTML PREVIEWS tab of `planning.html`.

### Background & Problem Analysis

The HTML PREVIEWS tab uses a `<div id="preview-pane-html">` with an `<iframe>` inside to render previewed HTML files. When an HTML file is loaded, its left edge appears to slide partially underneath the `#tree-pane-html` sidebar, cutting off content.

#### Root Cause

Every other tab in `planning.html` wraps its preview pane in a `.preview-panel-wrapper` element:

```html
<!-- Local Docs (correct pattern) -->
<div class="content-row">
    <div id="tree-pane">...</div>
    <div class="preview-panel-wrapper">  <!-- provides position: relative; flex: 3; height: 100% -->
        <div id="preview-pane">...</div>
    </div>
</div>
```

The HTML PREVIEWS tab deviates from this established pattern. It places `#preview-pane-html` directly inside `.content-row` without `.preview-panel-wrapper`:

```html
<!-- HTML Previews (missing wrapper) -->
<div class="content-row">
    <div id="tree-pane-html">...</div>
    <div id="preview-pane-html" style="display: flex; flex-direction: column; overflow: hidden; height: 100%;">
        <iframe id="html-preview-frame" style="...width: 100%...">...</iframe>
    </div>
</div>
```

`.preview-panel-wrapper` is defined in CSS as:
```css
.preview-panel-wrapper {
    position: relative;
    flex: 3;
    height: 100%;
}
```

Without this wrapper, `#preview-pane-html` serves double duty as both the `.content-row` flex child (receiving `flex: 3` via `.content-row > :last-child`) and the inner preview container. The `<iframe>` inside resolves `width: 100%` against an ambiguous or unconstrained context, allowing the iframe's content to visually bleed leftward into the tree pane area.

Additionally, the HTML PREVIEWS tab is missing a `.cyber-scanlines` overlay that all other preview tabs have for the cyber theme.

## Metadata

- **Tags:** bugfix, frontend, ui
- **Complexity:** 2

## User Review Required

- Confirm that preserving `display: flex; flex-direction: column; overflow: hidden` on `#preview-pane-html` inside the wrapper is acceptable (these are the existing layout properties that must be retained for child flex items).
- Confirm that the `.cyber-scanlines` overlay addition is desired as part of this bugfix (feature parity with all other tabs).

## Complexity Audit

### Routine
- Wrapping `#preview-pane-html` in `.preview-panel-wrapper` — exact pattern used by 5 other tabs
- Adding `.cyber-scanlines` div — identical to existing instances in all other tabs
- Merging inline styles to preserve flex layout while adding containment properties

### Complex / Risky
- None

## Edge-Case & Dependency Audit

- **Race Conditions:** None. This is a static HTML structure change; no async or state-dependent rendering involved.
- **Security:** No impact. The iframe `sandbox` attribute is unchanged. The wrapper div adds no security surface.
- **Side Effects:** The `.preview-panel-wrapper` wrapper will cause `.cyber-theme-enabled .preview-panel-wrapper` CSS rules (subtle glow `box-shadow`, transparent background) to apply to the HTML preview pane. This is feature parity with all other tabs and not a regression.
- **Dependencies & Conflicts:** No JS code references `#preview-pane-html` by ID. All JS targets child elements (`html-initial-state`, `html-loading-state`, `html-preview-frame`, `image-preview-container`) via `getElementById`. No DOM walking from children to parent. Wrapping is safe.

## Dependencies

None

## Adversarial Synthesis

Key risks: removing `display: flex; flex-direction: column` would break vertical layout of child elements (initial state, loading spinner, iframe, image container). Removing `overflow: hidden` could allow content to overflow beyond pane bounds. Mitigations: preserve both flex layout and overflow properties on the inner `#preview-pane-html` div, merging them with the containment styles from other tabs' preview panes.

## Proposed Changes

### `src/webview/planning.html` (line ~3230)

- **Context:** The HTML PREVIEWS tab's `.content-row` at line 3223 contains `#tree-pane-html` and `#preview-pane-html` as direct children. All other tabs insert a `.preview-panel-wrapper` between the tree pane and the preview pane.
- **Logic:** Wrap `#preview-pane-html` in `.preview-panel-wrapper` to establish a proper containing block (`position: relative; flex: 3; height: 100%`). Add `.cyber-scanlines` as a sibling inside the wrapper for cyber theme parity. Merge inline styles to preserve flex layout while adding containment.
- **Implementation:**

  Change lines 3230–3246 from:

  ```html
                <div id="preview-pane-html" style="display: flex; flex-direction: column; overflow: hidden; height: 100%;">
                    <div id="html-initial-state" style="flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 16px; padding: 32px; color: var(--text-secondary);">
                        <span style="font-size: 48px; opacity: 0.5;">🌐</span>
                        <div style="text-align: center;">
                            <div style="font-size: 14px; font-weight: 600; color: var(--text-primary); margin-bottom: 8px;">HTML & Asset Previewer</div>
                            <div style="font-size: 12px; max-width: 320px; line-height: 1.5;">Select a file from the sidebar to preview HTML pages, SVGs, and images. Configure folders using the Manage Folders button.</div>
                        </div>
                    </div>
                    <div id="html-loading-state" style="flex: 1; display: none; flex-direction: column; align-items: center; justify-content: center; gap: 12px; padding: 32px; color: var(--text-secondary);">
                        <div style="width: 32px; height: 32px; border: 3px solid var(--border-color); border-top-color: var(--accent-teal); border-radius: 50%; animation: spin 0.8s linear infinite;"></div>
                        <div style="font-size: 12px;">Loading preview...</div>
                    </div>
                    <iframe id="html-preview-frame" sandbox="allow-scripts allow-same-origin" style="flex: 1; border: none; background: var(--panel-bg); width: 100%; height: 100%; display: none;"></iframe>
                    <div id="image-preview-container" style="display: none; flex: 1; overflow: auto; background: var(--panel-bg); padding: 16px; text-align: center;">
                        <img id="image-preview-img" style="max-width: 100%; max-height: 100%; object-fit: contain;" alt="Image preview" />
                    </div>
                </div>
  ```

  To:

  ```html
                <div class="preview-panel-wrapper">
                    <div id="preview-pane-html" style="flex: 1; width: 100%; box-sizing: border-box; height: 100%; display: flex; flex-direction: column; overflow: hidden;">
                        <div id="html-initial-state" style="flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 16px; padding: 32px; color: var(--text-secondary);">
                            <span style="font-size: 48px; opacity: 0.5;">🌐</span>
                            <div style="text-align: center;">
                                <div style="font-size: 14px; font-weight: 600; color: var(--text-primary); margin-bottom: 8px;">HTML & Asset Previewer</div>
                                <div style="font-size: 12px; max-width: 320px; line-height: 1.5;">Select a file from the sidebar to preview HTML pages, SVGs, and images. Configure folders using the Manage Folders button.</div>
                            </div>
                        </div>
                        <div id="html-loading-state" style="flex: 1; display: none; flex-direction: column; align-items: center; justify-content: center; gap: 12px; padding: 32px; color: var(--text-secondary);">
                            <div style="width: 32px; height: 32px; border: 3px solid var(--border-color); border-top-color: var(--accent-teal); border-radius: 50%; animation: spin 0.8s linear infinite;"></div>
                            <div style="font-size: 12px;">Loading preview...</div>
                        </div>
                        <iframe id="html-preview-frame" sandbox="allow-scripts allow-same-origin" style="flex: 1; border: none; background: var(--panel-bg); width: 100%; height: 100%; display: none;"></iframe>
                        <div id="image-preview-container" style="display: none; flex: 1; overflow: auto; background: var(--panel-bg); padding: 16px; text-align: center;">
                            <img id="image-preview-img" style="max-width: 100%; max-height: 100%; object-fit: contain;" alt="Image preview" />
                        </div>
                    </div>
                    <div class="cyber-scanlines"></div>
                </div>
  ```

  **Key detail:** The inline style on `#preview-pane-html` is a *merge* of the original properties and the pattern used by other tabs:
  - **Preserved from original:** `display: flex; flex-direction: column; overflow: hidden;` — required for vertical flex layout of child elements (initial state, loading spinner, iframe, image container)
  - **Added from pattern:** `flex: 1; width: 100%; box-sizing: border-box;` — matches `#preview-pane`, `#preview-pane-online`, `#preview-pane-tickets`, `#preview-pane-design`
  - **Removed:** `height: 100%` is redundant inside the wrapper (which already sets `height: 100%` and `flex: 3`), but kept for safety since other preview panes vary on whether they include it

- **Edge Cases:**
  - The `.cyber-scanlines` overlay has `z-index: 5` and `position: absolute`. It sits on top of the pane content visually. All other tabs use this same structure without issue — the scanlines are a purely visual overlay and do not block pointer events on the iframe in practice (the iframe's interactive content remains clickable).
  - No JS code references `#preview-pane-html` by ID, so the wrapper insertion does not break any DOM queries.

## Verification Plan

### Automated Tests

- (No automated tests applicable — this is a visual/CSS layout fix in a webview HTML file. Verification is manual.)

### Manual Verification

1. Open the Switchboard Planning panel in VS Code.
2. Navigate to the **HTML PREVIEWS** tab.
3. Select an HTML file with visible left-aligned content (e.g., text, a left border, or a logo).
4. Confirm the left edge of the rendered HTML is fully visible and does not clip under the left sidebar.
5. Verify the `.cyber-scanlines` overlay still renders correctly when the cyber theme is enabled.
6. Verify the initial state (globe icon + text) displays centered vertically and horizontally.
7. Verify the loading spinner displays centered when a file is being loaded.
8. Verify image previews (SVG, PNG) display correctly within the pane bounds.
9. Toggle the sidebar open/closed and confirm the preview pane resizes correctly without clipping.

## Files Changed

- `src/webview/planning.html` — wrap `#preview-pane-html` in `.preview-panel-wrapper`, add `.cyber-scanlines`, merge inline styles to preserve flex layout.

## Risk Assessment

- **Low risk.** The change is a structural alignment with the established pattern used by all other tabs. No JavaScript or CSS selector changes are needed beyond the HTML structure. The `.cyber-scanlines` addition is a missing feature parity fix, not a new feature. The inline style merge preserves the existing flex layout rather than replacing it, avoiding the child layout regression identified during review.

---

**Recommendation:** Complexity 2 → **Send to Intern**

## Review Findings

Implementation verified correct. `#preview-pane-html` wrapped in `.preview-panel-wrapper` (line 3326), `.cyber-scanlines` overlay added (line 3372), inline styles preserve flex layout with containment properties. All 6 tabs now use identical wrapper pattern. No JS references to `#preview-pane-html` by ID were broken. Plan's proposed HTML was stale (missing `active-doc-banner-html` and zoomable containers added in later iterations), but implementation correctly preserved actual code. No code fixes needed. Remaining risk: `height: 100%` on `#preview-pane-html` is redundant inside wrapper but harmless and consistent with some other tabs.
