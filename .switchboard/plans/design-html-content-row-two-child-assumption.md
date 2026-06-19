# Fix .content-row Two-Child Assumption in design.html

## Metadata
**Complexity:** 3
**Tags:** bugfix, frontend, ui

## Goal

### Problem
`.content-row > :first-child` gets `flex: 1` and `.content-row > :last-child` gets `flex: 3` (`:222-229`). This assumes exactly two children. If a content row ever has a different child count, the flex distribution breaks silently — a third child would get no explicit flex, and `:first-child` / `:last-child` would target the wrong elements.

The `#stitch-content .content-row` at `:3817` already works around this with `flex-direction: column`, but this is a band-aid, not a fix.

### Root Cause
The selector was written for the specific two-pane (sidebar + preview) layout without considering future content rows with different structures.

## Approach
1. **Use explicit child selectors** instead of `:first-child` / `:last-child`:
   - `.content-row > .tree-pane` (or equivalent class) gets `flex: 1`
   - `.content-row > .preview-panel-wrapper` gets `flex: 3`
2. **Or use a data attribute**: `.content-row > [data-flex="sidebar"]` and `.content-row > [data-flex="preview"]`
3. **Or use nth-child with explicit count**: Only apply if exactly 2 children — but CSS can't count children, so this isn't feasible
4. **Recommended**: Use explicit class-based selectors, which are self-documenting and don't depend on DOM order

## Files Changed
- `src/webview/design.html` — CSS selector changes
- HTML elements may need class additions if they don't already have distinguishing classes

## Risks
- Need to verify all `.content-row` instances in the HTML to ensure children have the right classes
- The collapsed state rules (`:231-236`) also use `:first-child` / `:last-child` — these need the same treatment

## Verification
- Open each tab with a `.content-row` and verify sidebar/preview split is correct
- Test sidebar collapse/expand on each tab
- Verify Stitch tab (which uses `flex-direction: column` override) still works
