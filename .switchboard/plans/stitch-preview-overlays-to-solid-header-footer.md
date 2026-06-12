# Move Stitch Screen Preview Overlays into Non-Distracting Solid Header and Footer Panels

## Metadata
**Complexity:** 3
**Tags:** ui, ux, refactor

## Goal

In the Stitch tab of the Design panel (`design.html`), the screen preview overlays (`.preview-top-overlay` and `.preview-bottom-overlay`) render directly on top of the generated UI screens. When an image occupies the full area of the container, these overlays cover vital parts of the generated screen and cause visual clutter.

The goal is to convert these overlays into static, solid header and footer bars that frame the screen preview image, keeping the image viewport completely unobstructed. Furthermore, we want to consolidate the footer layout into a single, compact toolbar row by replacing the inline aspect chips with a custom dropdown.

### Root Cause Analysis & Problem Context
- **Overlay Layout**: The overlay divs are positioned absolutely (`position: absolute`) within the preview image container, causing them to draw on top of whatever is rendered beneath them.
- **Obstructed Details**: Important elements at the top (close buttons, title, download actions) and bottom (refinement input, creatively aspects chips, apply actions) overlap the top and bottom of the previewed screen.
- **Wasted Space**: The aspect chips (Layout, Color, Images, Font, Text) occupy an entire dedicated row in the footer, which is unnecessary since they are only used for generating variants (`+3 Variants`).

## User Review Required
No major architectural risks. This is a purely visual UI/UX layout improvement.

## Open Questions
None.

## Proposed Changes

### Webview

#### [MODIFY] [design.html](file:///Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/design.html)

1. **Modify HTML structure** inside `#stitch-preview-pane` (lines 3699-3739) to pull the overlays out of `.preview-image-container` and rename their classes to reflect their new static roles:
   - Change `.preview-top-overlay` to `.preview-header`.
   - Change `.preview-bottom-overlay` to `.preview-footer`.
   - Place them as siblings to `.preview-image-container` inside the flexbox layout of `#stitch-preview-pane`.

2. **Consolidate footer elements** in `.preview-footer` into a single row:
   - Wrap the checkboxes in a custom, CSS-only or simple JS-based multi-select dropdown button (e.g. `<div class="aspects-dropdown">`) labeled "Vary Aspects ▾".
   - Put all input boxes, select tags, dropdowns, and action buttons in a single flexbox row inside `.preview-footer`.

3. **Modify CSS styles** in the style tag:
   - Replace the absolute positioning, opacity transitions, hover behaviors, and background gradients of `.preview-top-overlay` and `.preview-bottom-overlay` with solid, clean panel styles:
     - Use `background: var(--panel-bg2)` for both.
     - Add borders to visually separate them: `border-bottom: 1px solid var(--border-color)` for `.preview-header` and `border-top: 1px solid var(--border-color)` for `.preview-footer`.
     - Remove `position: absolute`, top/bottom/left/right properties, and z-index.
     - Keep them visible at full opacity (`opacity: 1`) by removing the hover-fade properties.
   - Design the `.aspects-dropdown` container:
     - Absolute-position the list of checkboxes beneath the "Vary Aspects" trigger button when expanded.
     - Give the list a solid background, borders, and a box-shadow for a clean popover appearance.
   - Adjust `#stitch-preview-pane.loading` behaviors to target `.preview-footer` instead of `.preview-bottom-overlay`.

## Verification Plan

### Manual Verification
1. Open the **STITCH** tab in the design panel.
2. Select or generate a screen.
3. Verify that:
   - The header (containing screen title, download buttons, and close button) is rendered on a solid dark background at the top of the panel and does not overlap the image.
   - The footer controls are consolidated on a single solid row at the bottom of the panel and do not overlap the image.
   - The image is perfectly centered between the header and footer bars.
   - Clicking "Vary Aspects ▾" displays a dropdown menu overlay with checkboxes for Layout, Color, Images, Font, and Text.
   - Changing these checkboxes and clicking "+3 Variants" correctly generates variants with the selected aspects.
