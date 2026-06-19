# Fix .shared-tab-content.active overflow-y Conflict in design.html

## Metadata
**Complexity:** 2
**Tags:** bugfix, frontend, ui

## Goal

### Problem
`.shared-tab-content.active` has `overflow-y: auto` (`:3492`), but individual tab contents set their own overflow properties. For example, `#briefs-content` contains a `.content-row` with `overflow: hidden` (`:217`). Nested overflow contexts can cause unexpected scrollbar behavior — double scrollbars, clipped content, or scroll capture going to the wrong element.

### Root Cause
The `.shared-tab-content.active` rule was added as a generic "make active tabs scrollable" without considering that child elements manage their own overflow.

## Approach
1. **Remove `overflow-y: auto`** from `.shared-tab-content.active` (`:3492`) — let each tab manage its own overflow
2. **Or change to `overflow: hidden`** on `.shared-tab-content.active` to prevent the outer container from scrolling, forcing scroll to happen at the appropriate child level
3. **Audit each tab** to ensure it has a proper scroll container:
   - Briefs: `.content-row` children have `overflow-y: auto` — OK
   - Design System: `#design-local-panel` has `overflow: hidden` — OK
   - HTML Previews: `#preview-pane-html` has `overflow: hidden` — OK
   - Images: `#preview-pane-images` has `overflow: hidden` — OK
   - Stitch: `.content-row` has `flex-direction: column` — needs verification
4. **Recommended**: Change to `overflow: hidden` and verify each tab's internal scroll works

## Files Changed
- `src/webview/design.html` — `.shared-tab-content.active` overflow property

## Risks
- If any tab relies on the outer container for scrolling, removing `overflow-y: auto` could make content unreachable — need to test each tab with long content

## Verification
- Open each tab with content taller than viewport — verify scrolling works
- Check for double scrollbars on any tab
- Verify sidebar scroll and preview pane scroll work independently
