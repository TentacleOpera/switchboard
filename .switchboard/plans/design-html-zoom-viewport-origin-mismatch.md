# Fix Zoomable Viewport Transform-Origin / Centering Mismatch in design.html

## Metadata
**Complexity:** 5
**Tags:** bugfix, frontend, ui

## Goal

### Problem
`.zoomable-container` uses `align-items: center; justify-content: center` (`:1972-1973`) to center its content, but `.zoomable-viewport` has `transform-origin: top left` (`:1979`). When a zoom transform (scale + translate) is applied, the math assumes top-left origin, but the initial position is center-aligned. This causes a visual jump when zooming starts — the content snaps from center to top-left coordinates.

The comment at `:1983` explicitly notes that the pan math "mirrors the inline width/height:100% on the iframe viewport" and assumes top-left origin, confirming the mismatch is unintentional.

### Root Cause
The container was designed for centering content at rest (nice default for image/HTML preview), but the zoom/pan system was designed with top-left origin math. These two approaches are incompatible without an explicit coordinate reconciliation step.

### Background
Three zoomable containers exist:
- `#image-preview-container-design` (`:3587`) — image preview in Design tab
- `#image-preview-container-images` (`:3719`) — image preview in Images tab
- `#html-preview-wrapper` (`:3668`) — HTML iframe preview in HTML Previews tab

## Approach
1. **Option A: Remove centering, use top-left positioning**
   - Change `.zoomable-container` to `align-items: flex-start; justify-content: flex-start`
   - Add `fitToContainer` logic in JS to compute the initial translate that centers content, using top-left origin math
   - This makes the rest and zoom states use the same coordinate system

2. **Option B: Keep centering, adjust zoom math**
   - Compute the centering offset and fold it into the initial transform matrix
   - More complex but preserves the visual centering at rest without JS

3. **Recommended: Option A** — simpler, more predictable, and the JS already handles transforms

## Files Changed
- `src/webview/design.html` — `.zoomable-container` alignment properties
- Companion JS file — `fitToContainer` function may need adjustment to compute initial centering translate

## Risks
- The zoom/pan JS logic needs careful testing — any change to the coordinate system affects all three zoomable containers
- The `fitToContainer` function likely already has logic to handle this — need to read the JS before deciding

## Verification
- Open Design tab, preview an image, zoom in/out — verify no jump on first zoom interaction
- Open Images tab, preview an image, zoom in/out — same test
- Open HTML Previews tab, preview an HTML file, hold Space + scroll to zoom — verify no jump
- Double-click to reset zoom — verify content returns to centered fit position
