# Relocate Stitch Preview Controls to Title Bar

## Goal
Move the control toolbar from below the title area into the title bar itself, allowing the preview image to expand vertically and fill the available space in the Stitch preview panel.

The preview panel in the Stitch interface currently wastes significant vertical space: a control toolbar sits between the title/header area and the preview content; the title bar contains only the preview title and a close button, leaving ample unused horizontal space; and the preview image is constrained and cannot expand to fill the panel.

The solution is to consolidate the title bar by moving all control buttons from the current toolbar row into the title/header bar, positioned to the right of the title text or aligned opposite the close button; remove the dedicated toolbar row that currently sits below the title area; expand the preview area so the preview image/container grows vertically to occupy the reclaimed space; and preserve all existing functionality (no controls are removed or hidden, only their layout position changes).

## Metadata
- **Complexity:** 3
- **Tags:** frontend, ui, ux

## User Review Required
- Confirm desired responsive behavior for the title bar when the VS Code panel is resized to a narrow width (< 400 px).
- Approve the proposed placement of the refine input and aspect checkboxes (slim toolbar row below header vs. inside header).
- Verify that removing the 60vh max-height on the preview image does not conflict with intended design constraints on small screens.

## Complexity Audit

### Routine
- Reordering DOM nodes within a single HTML file.
- Adjusting CSS flex properties and removing `max-height` constraints.
- Removing unused CSS rules for the old side-panel layout.
- No backend or API changes.

### Complex / Risky
- Responsive header overflow when many buttons share a single row at narrow widths.
- Ensuring the thumbnail strip (`#stitch-thumbnail-strip`) is not pushed below the visible area by an aggressively expanding image.
- Preserving event listener wiring in `design.js` which relies on `cloneNode` and `getElementById`; moving elements across the DOM is safe by ID but must stay within `#stitch-preview-pane`.

## Edge-Case & Dependency Audit

- **Race Conditions:** None. This is a static layout change with no asynchronous state.
- **Security:** None. No new user input surfaces or sanitization gaps introduced.
- **Side Effects:** The `.preview-controls`, `.preview-actions`, and `.preview-refine` CSS classes will become dead rules after the DOM is restructured. They should be removed or repurposed to avoid CSS bloat. No other component in the codebase uses these classes (confirmed via grep).
- **Dependencies & Conflicts:** No external dependencies. The Stitch preview pane is self-contained within the Design webview. No other plans or features depend on the current side-panel layout.

## Dependencies
- None.

## Adversarial Synthesis
Key risks: header overflow on narrow panels, thumbnail strip displacement if the image expands unchecked, and a mismatch between the plan's referenced controls ("Improve Situation", "Revert") and the actual controls in the code (DL HTML, DL PNG, Apply Edit, +3 Variants). Mitigations: use a wrapped flex header for buttons, cap image growth with `flex: 1` and `min-height: 0`, keep refine inputs in a slim sub-header row rather than inside the title bar, and audit the real control inventory before editing.

## Proposed Changes

### `src/webview/design.html` — DOM Restructure (~lines 3474–3521)
**Context:** `#stitch-preview-pane` currently contains `.preview-header` (title + close button) and `.preview-body` (image container + `.preview-controls` side panel).

**Logic:** Move the compact action buttons into `.preview-header`. Move the refine input, creative range select, and aspect checkboxes into a new slim `.preview-toolbar` row directly below the header. Remove the 280px `.preview-controls` side panel from `.preview-body`. Restructure `.preview-body` to hold only the image container, allowing it to fill all remaining vertical space.

**Implementation:**
1. **`.preview-header` (line ~3476):**
   - Keep `.preview-title-block` (title + meta) on the left.
   - Insert a new `.preview-header-actions` flex group between the title block and the close button.
   - Move the existing `.preview-actions` buttons (`#preview-btn-html`, `#preview-btn-png`) into this group.
   - Move the action buttons (`#preview-btn-edit`, `#preview-btn-variants`) into this group.
   - Add `flex-wrap: wrap` and `gap: 8px` to `.preview-header` so buttons wrap gracefully on narrow panels.

2. **New `.preview-toolbar` row (insert after `.preview-header`):**
   - Move the refine input (`#preview-refine-input`), creative range select (`#stitch-creative-range-select`), and aspects checkboxes (`#stitch-aspects-checkboxes`) here.
   - Style as a single horizontal row: `display: flex; gap: 8px; flex-wrap: wrap; align-items: center; padding: 8px 0; border-bottom: 1px solid var(--border-color);`.
   - *Clarification:* This row replaces the bulky side panel but is not the same as the old "dedicated toolbar row" described in the plan. It is a minimal, single-line control strip that keeps the header uncluttered.

3. **`.preview-body` (line ~3483):**
   - Remove the `.preview-controls` wrapper entirely.
   - Keep only `.preview-image-container` (and its child `#preview-image` and `#preview-image-placeholder`).
   - Change `.preview-body` CSS from `flex-direction: row; flex-wrap: wrap;` to `flex-direction: column; flex: 1; min-height: 0;`.

4. **`.preview-image-container` (CSS line ~2981):**
   - Remove `max-height: 60vh;`.
   - Ensure `flex: 1; min-height: 0;` so it grows to fill available vertical space without pushing the thumbnail strip off-screen.

5. **`#preview-image` (CSS line ~2993):**
   - Remove `max-height: 60vh;`.
   - Keep `max-width: 100%; object-fit: contain;`.

6. **`#stitch-preview-pane` (CSS line ~2954):**
   - Add `flex: 1; min-height: 0;` so the pane itself expands within the parent `.content-row` flex column.

7. **Dead CSS cleanup (lines ~2998–3015):**
   - Remove or repurpose `.preview-controls`, `.preview-actions`, `.preview-refine` rules. If the new toolbar reuses `.preview-actions`, update its rules to horizontal layout (`flex-direction: row;`) instead of the old column context.

### `src/webview/design.js` — Event Wiring Verification (~lines 1019–1139)
**Context:** `openStitchPreview` clones control nodes and re-attaches event listeners by ID.

**Logic:** No IDs change and no elements are removed from the DOM; they are only moved within `#stitch-preview-pane`. The existing `getElementById` calls and `cloneNode` logic will continue to function because the elements remain in the document and the script re-queries them on every open.

**Implementation:**
- No code changes required.
- **Clarification:** If elements are ever moved outside `#stitch-preview-pane`, the script would need updates. Keep all relocated controls inside the pane.

### Edge Cases
- **Narrow panel overflow:** `.preview-header` uses `flex-wrap: wrap` so buttons drop to a second line rather than being clipped.
- **Empty refine input:** The existing guard in `previewBtnEdit`'s click handler (`if (!prompt) { setStitchStatus(...); return; }`) remains unchanged.
- **Thumbnail strip visibility:** `#stitch-thumbnail-strip` is a sibling of `#stitch-preview-pane` inside `.content-row` (`flex-direction: column; overflow-y: auto;`). Giving `#stitch-preview-pane` `flex: 1` lets it absorb free space while the strip keeps its natural height. Users can scroll if the combined height exceeds the viewport.

## Verification Plan

### Manual Checks
- [ ] Open a Stitch screen preview and confirm the image fills the available vertical space (no 60vh cap).
- [ ] Confirm all control buttons remain visible and clickable in the new header/toolbar positions.
- [ ] Verify the title bar layout remains visually balanced (title left, actions center/right, close button right).
- [ ] Test at minimum and maximum panel widths; confirm buttons wrap gracefully without clipping.
- [ ] Hover over each button and confirm tooltips/titles still appear.
- [ ] Verify "Apply Edit" and "+3 Variants" still trigger the correct `vscode.postMessage` events.
- [ ] Verify "DL HTML" and "DL PNG" still download the correct assets.
- [ ] Verify the thumbnail strip remains accessible below the preview pane.

### Automated Tests
- **Skipped per session directive.** The user will run the test suite separately.

---

## Review Findings

Implementation matches plan requirements. DOM restructure, CSS updates, and dead-rule cleanup are all correct. `design.js` event wiring verified by ID — no regressions. No code changes required.

**Files reviewed:** `src/webview/design.html` (~lines 2954–3515), `src/webview/design.js` (~lines 1031–1177)
**Validation:** Skipped per session directive (no compilation or test run).
**Remaining risks:** Responsive header wrap at very narrow widths (< 350 px) may push close button to second line; pre-existing `.content-row > :first-child` `overflow-y: auto` can create nested scrollbars on short viewports.

**Recommendation:** Send to Coder (complexity 3, routine UI relocation with well-scoped edge cases).
