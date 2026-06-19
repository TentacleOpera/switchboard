# Add @supports Fallbacks for color-mix() and backdrop-filter in design.html

## Metadata
**Complexity:** 4
**Tags:** refactor, frontend, reliability

## Goal

### Problem
`design.html` uses `color-mix(in srgb, ...)` 100+ times and `backdrop-filter` extensively in cyber-theme rules, with no `@supports` fallbacks. If the VS Code Electron version doesn't support these features, colors break silently and backgrounds become fully transparent, making content unreadable.

### Root Cause
Modern CSS features were adopted without providing fallbacks for older rendering engines.

### Background
- `color-mix(in srgb, ...)` — supported since Chrome 111 (March 2023). VS Code's Electron is usually current, but users on older versions would see broken colors (property ignored, falling back to inherited/initial values).
- `backdrop-filter` — supported since Chrome 76 but with `-webkit-` prefix needed for some versions. Already uses `-webkit-backdrop-filter` in some places (`:2155`, `:2169`) but not consistently.

## Approach
1. **For `color-mix()`**:
   - Add a `@supports not (color: color-mix(in srgb, red, blue))` block
   - Provide fallback solid colors or rgba values for the most critical properties (backgrounds, borders, text colors)
   - Focus on properties that affect readability: `background`, `color`, `border-color` on containers and text
   - Don't need to fallback every single usage — prioritize visible elements

2. **For `backdrop-filter`**:
   - Ensure all `backdrop-filter` usages also have `-webkit-backdrop-filter` (some already do, audit for consistency)
   - Add `@supports not (backdrop-filter: blur(4px))` fallbacks that provide solid or semi-opaque backgrounds
   - Critical: `.cyber-theme-enabled .controls-strip`, `.cyber-theme-enabled #tree-pane-*`, `.cyber-theme-enabled .planning-card` — these would be fully transparent without fallback

## Files Changed
- `src/webview/design.html` — add `@supports` blocks and fallback values

## Risks
- Fallback colors won't match the cyber aesthetic exactly — acceptable since they're only for unsupported browsers
- Adding fallbacks increases CSS size — offset by doing this after dead CSS cleanup
- Some `color-mix` usages are in inline styles (see inline styles plan) — those can't have `@supports` fallbacks and would need to be moved to CSS classes first

## Verification
- Test in current VS Code — verify no visual change (fallbacks shouldn't apply)
- If possible, test in an older Electron/Chrome version to verify fallbacks render acceptably
- Verify cyber theme is still readable with fallbacks (no transparent backgrounds on text containers)
