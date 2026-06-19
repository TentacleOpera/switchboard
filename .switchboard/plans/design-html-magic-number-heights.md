# Replace Magic Number Heights with Flexbox in design.html

## Metadata
**Complexity:** 4
**Tags:** bugfix, frontend, ui

## Goal

### Problem
`design.html` uses hardcoded pixel offsets in `calc()` for container heights that assume the exact height of sibling elements. If those siblings' sizes change (font size, padding, content), the layout silently breaks with gaps or overlaps.

Three instances:
1. `.container` — `height: calc(100vh - 40px)` (`:119`) assumes the `.shared-tab-bar` is exactly 40px
2. `#design-local-panel` — `height: calc(100% - 75px)` (`:3572`) assumes controls strip + sub-tab switcher = 75px
3. `#design-systems-panel` — `height: calc(100% - 75px)` (`:3609`) same assumption

### Root Cause
Instead of using flexbox to distribute remaining height, the author computed sibling heights manually and subtracted them. This is fragile because the sibling heights are not fixed — they depend on font rendering, padding, and content.

### Background
The `.shared-tab-bar` has `padding: 8px 16px 0` with buttons at `font-size: 10px; padding: 8px 16px`. Its actual height depends on font metrics and is not explicitly set. The controls strip + sub-tab switcher combined height is similarly unconstrained.

## Approach
1. **`.container`**: Make the parent (`<body>`) a flex column with `height: 100vh`. The `.shared-tab-bar` gets `flex-shrink: 0` and `.container` gets `flex: 1; min-height: 0`. Remove the `calc(100vh - 40px)`.
2. **`#design-local-panel` / `#design-systems-panel`**: Make `#design-content` a flex column. Give the controls strip and sub-tab switcher `flex-shrink: 0`, and give the panels `flex: 1; min-height: 0`. Remove the `calc(100% - 75px)`.
3. Test with different font sizes and zoom levels to confirm the layout adapts.

## Files Changed
- `src/webview/design.html` — CSS and inline styles on affected elements

## Risks
- Flexbox `min-height: 0` is required to prevent flex children from overflowing — easy to forget
- The `#design-content` is a `.shared-tab-content` which already has `flex: 1` — need to verify nesting doesn't conflict

## Verification
- Open Design System tab, verify no gap/overlap between controls strip, sub-tab switcher, and content panel
- Change VS Code font size settings and verify layout still works
- Test with the Stitch tab (which uses `.container` height) to verify it fills correctly
