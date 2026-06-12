# Move Stitch Screen Preview Overlays into Non-Distracting Solid Header and Footer Panels

## Metadata
**Tags:** ui, ux, refactor
**Complexity:** 3

## Goal

In the Stitch tab of the Design panel (`design.html`), the screen preview overlays (`.preview-top-overlay` and `.preview-bottom-overlay`) render directly on top of the generated UI screens. When an image occupies the full area of the container, these overlays cover vital parts of the generated screen and cause visual clutter.

The goal is to convert these overlays into static, solid header and footer bars that frame the screen preview image, keeping the image viewport completely unobstructed. Furthermore, we want to consolidate the footer layout into a single, compact toolbar row by moving the aspects selection checkboxes (Layout, Color, etc.) into a custom split-button dropdown attached directly to the "+3 Variants" button.

### Root Cause Analysis & Problem Context
- **Overlay Layout**: The overlay divs are positioned absolutely (`position: absolute`) within the preview image container, causing them to draw on top of whatever is rendered beneath them.
- **Obstructed Details**: Important elements at the top (close buttons, title, download actions) and bottom (refinement input, creatively aspects chips, apply actions) overlap the top and bottom of the previewed screen.
- **Wasted Space / Confusing UX**: The aspect chips (Layout, Color, Images, Font, Text) occupy an entire dedicated row in the footer, which is unnecessary and confusing since they are only used for generating variants (`+3 Variants`) and do not affect general edit refinements.

## User Review Required
No major architectural risks. This is a purely visual UI/UX layout improvement.

## Open Questions
None.

## Complexity Audit

### Routine
- Change `.preview-top-overlay` / `.preview-bottom-overlay` CSS from absolute-positioned gradients to static solid bars with borders.
- Restructure `#stitch-preview-pane` HTML: move overlays out of `.preview-image-container` to flex siblings.
- Create `.split-button-container` wrapper around `+3 Variants` button with dropdown trigger `[ ▾ ]`.
- Move aspect checkboxes into `#stitch-variants-dropdown-menu` absolute dropdown.
- Add dropdown toggle and outside-click-close listeners in `design.js`.

### Complex / Risky
- `openStitchPreview` recreates `previewBtnVariants` via `cloneNode(true)` on every preview open; wrapping it in a new container breaks the freshly-attached dropdown toggle listener. Must switch to event delegation or a stable trigger element.
- Aspects checkboxes move from `#stitch-aspects-checkboxes` into dropdown; `stitchAspectsCheckboxesContainer` query selector in `design.js` and the checkbox collection loop in the variants handler must be updated to the new container ID.
- Flex layout geometry: header/footer heights must be accounted for so `.preview-image-container` doesn't collapse on small screens or push the image off-center.
- `#stitch-preview-pane.loading` CSS currently hides `.preview-bottom-overlay`; must retarget `.preview-footer` without breaking loading state visibility.

## Edge-Case & Dependency Audit
- **Race Conditions:** None — purely UI layout, no async state.
- **Security:** Dropdown is webview-local only; no external input.
- **Side Effects:** `cloneNode(true)` on `previewBtnVariants` clones the old button including any stale listeners; replacing with event delegation avoids listener accumulation.
- **Dependencies & Conflicts:** No shared config or service changes. Confined to `design.html` and `design.js`.

## Dependencies
- `sess_20250612_004` — Split-button dropdown component and outside-click dismissal behavior.

## Adversarial Synthesis
Key risks: `cloneNode` listener loss on the variants button after DOM restructure; aspect checkbox selector drift when moved into dropdown; flex layout collapsing if header/footer lack explicit min-heights. Mitigations: use event delegation on `.split-button-container` for dropdown toggle; update JS queries to `#stitch-variants-dropdown-menu`; enforce `min-height` on header/footer bars.

## Proposed Changes

### Webview

#### [MODIFY] [design.html](file:///Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/design.html)

1. **Modify HTML structure** inside `#stitch-preview-pane` (lines 3699-3739) to pull the overlays out of `.preview-image-container` and rename their classes to reflect their new static roles:
   - Change `.preview-top-overlay` to `.preview-header`.
   - Change `.preview-bottom-overlay` to `.preview-footer`.
   - Place them as siblings to `.preview-image-container` inside the flexbox layout of `#stitch-preview-pane`.

2. **Create the Split Button with Aspects Dropdown** in the footer:
   - Wrap the `+3 Variants` button inside a `.split-button-container` wrapper.
   - Add a trigger button `[ ▾ ]` (`#preview-btn-variants-dropdown`) next to the main variants button.
   - Place the aspect checkboxes inside an absolute-positioned dropdown menu overlay (`#stitch-variants-dropdown-menu`) nested inside the split button container.
   - Group the refinement input, creative range select, apply edit button, and the variants split button container in a single flexbox row inside `.preview-footer`.

3. **Modify CSS styles** in the style tag:
   - Replace the absolute positioning, opacity transitions, hover behaviors, and background gradients of `.preview-top-overlay` and `.preview-bottom-overlay` with solid, clean panel styles:
     - Use `background: var(--panel-bg2)` for both.
     - Add borders to visually separate them: `border-bottom: 1px solid var(--border-color)` for `.preview-header` and `border-top: 1px solid var(--border-color)` for `.preview-footer`.
     - Remove `position: absolute`, top/bottom/left/right properties, and z-index.
     - Keep them visible at full opacity (`opacity: 1`) by removing the hover-fade properties.
   - Style the split button layout:
     - Use `display: inline-flex` on `.split-button-container`.
     - Remove internal borders and border-radiuses where the two buttons join to make it look like a cohesive split button.
     - Position the `.variants-dropdown-menu` absolutely above the button (`bottom: 100%`) with a solid background, borders, and a clean shadow.
   - Adjust `#stitch-preview-pane.loading` behaviors to target `.preview-footer` instead of `.preview-bottom-overlay`.

#### [MODIFY] [design.js](file:///Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/design.js)

1. **Add Toggle Behavior for the Dropdown Menu**:
   - Add event listeners in `design.js` to toggle the visibility of the aspects dropdown menu when the trigger button `[ ▾ ]` is clicked.
   - Add a document-wide click listener to automatically close the dropdown when clicking anywhere outside of it.

## Verification Plan

### Automated Tests
- `#stitch-preview-pane` renders with `.preview-header`, `.preview-image-container`, and `.preview-footer` as flex-column siblings; no absolute positioning remains on header/footer.
- `.preview-image-container` remains unobstructed; image is perfectly centered between header and footer bars at multiple viewport sizes.
- `#stitch-preview-pane.loading` hides `.preview-footer` while preserving loading state visibility.
- Split-button dropdown opens on `[ ▾ ]` click and closes on outside click or Escape key.
- Aspects checkboxes inside dropdown reflect default checked state; selection persists across preview open/close cycles.
- `+3 Variants` click correctly reads selected aspects from dropdown and includes them in the `stitchVariants` message payload.

### Manual Verification
1. Open the **STITCH** tab in the design panel.
2. Select or generate a screen.
3. Verify that:
   - The header (containing screen title, download buttons, and close button) is rendered on a solid dark background at the top of the panel and does not overlap the image.
   - The footer controls are consolidated on a single solid row at the bottom of the panel and do not overlap the image.
   - The image is perfectly centered between the header and footer bars.
   - Clicking the `[ ▾ ]` arrow next to `+3 Variants` displays the dropdown menu containing checkboxes for Layout, Color, Images, Font, and Text.
   - Clicking outside the dropdown closes it.
   - Changing the selection in the dropdown and clicking `+3 Variants` correctly generates variants based on the selected aspects.

## Recommendation
**Send to Intern** — Complexity 3 with localized changes confined to `design.html` and `design.js`; well-scoped UI refactor with clear verification steps.
