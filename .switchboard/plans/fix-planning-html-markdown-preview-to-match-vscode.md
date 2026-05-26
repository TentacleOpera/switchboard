# Fix planning.html Markdown Preview to Match VS Code Defaults

## Goal
Replace the hardcoded custom markdown preview styling in `planning.html` with VS Code's built-in markdown preview CSS conventions (em-based typography, `--vscode-*` theme variables) so the preview visually matches VS Code's native markdown rendering and adapts to the user's active theme.

## Metadata
- **Tags:** [frontend, UI, UX]
- **Complexity:** 3

## User Review Required
- Confirm that `max-width: 800px` centered layout should be kept (deliberate readability deviation from VS Code's full-width preview).
- Confirm that the kanban dark theme for UI chrome (tabs, buttons, sidebar) must remain untouched — only markdown preview content styling changes.

## Complexity Audit

### Routine
- Replacing hardcoded hex colors with `--vscode-*` CSS variable references
- Switching from absolute px font sizes to em-based sizing matching VS Code's scale
- Removing the dot-pattern background from preview pane containers
- Adding missing element styles (hr, img) that VS Code's preview defines

### Complex / Risky
- None

## Edge-Case & Dependency Audit

- **Race Conditions:** None — this is static CSS with no runtime state.
- **Security:** No security implications. CSS variable references are safe.
- **Side Effects:** The `:root` CSS variables (lines 9-45) are shared between kanban UI chrome and markdown preview. Changes MUST be scoped strictly to `#markdown-preview` / `#markdown-preview-online` selectors to avoid altering kanban tabs, buttons, or sidebar styling.
- **Dependencies & Conflicts:** VS Code webviews automatically inject `--vscode-*` CSS variables onto the `<html>` element. This webview already uses some (`--vscode-font-family`, `--vscode-editor-font-family`, `--vscode-scrollbarSlider-*` at lines 31-32, 676-681), confirming availability. Custom themes may not define all variables — fallback values must be provided.

## Dependencies
- None

## Adversarial Synthesis
Key risks: (1) Accidentally bleeding markdown preview variable changes into shared `:root` variables that also style the kanban chrome. Mitigation: scope all changes strictly to `#markdown-preview` / `#markdown-preview-online` selectors, never modify `:root`. (2) Missing VS Code CSS variables in custom themes causing unstyled elements. Mitigation: every `var(--vscode-*)` reference includes a hardcoded fallback matching VS Code's dark default.

## Proposed Changes

### `src/webview/planning.html`

**Context:** The markdown preview styling lives in lines 694-854. The preview pane containers with the dot-pattern background are at lines 643-653. The `:root` variables at lines 9-45 are shared with kanban UI chrome and must NOT be modified for this plan.

#### Change 1: Remove dot-pattern background from preview pane containers (lines 643-653)

**Current (line 648):**
```css
background-image: radial-gradient(circle, #333 1px, transparent 1px);
background-size: 20px 20px;
```

**New:**
```css
/* Removed dot-pattern — VS Code preview uses solid backgrounds */
```

Also change the `background` property on these containers from `var(--panel-bg)` to `var(--vscode-editor-background, var(--panel-bg))` so the preview pane adapts to the user's theme.

**Edge Cases:** The dot-pattern is applied to `#preview-pane` and `#preview-pane-online` (the container divs), NOT to `#markdown-preview` / `#markdown-preview-online` (the content divs). Both container selectors must be updated.

#### Change 2: Replace markdown preview container styling (lines 695-702)

**Current:**
```css
#markdown-preview,
#markdown-preview-online {
    flex: 1;
    overflow-y: auto;
    padding: 40px;
    max-width: 800px;
    margin: 0 auto;
}
```

**New:**
```css
#markdown-preview,
#markdown-preview-online {
    flex: 1;
    overflow-y: auto;
    padding: 0 26px; /* Match VS Code's markdown.css default */
    max-width: 800px; /* Clarification: kept for readability, VS Code uses full width */
    margin: 0 auto;
    font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, "Segoe WPC", "Segoe UI", system-ui, "Ubuntu", "Droid Sans", sans-serif);
    font-size: var(--vscode-font-size, 14px);
    line-height: var(--vscode-font-line-height, 22px);
    word-wrap: break-word;
    color: var(--vscode-editor-foreground, #cccccc);
}
```

**Clarification:** `max-width: 800px` is kept as a deliberate readability improvement. VS Code's native preview fills the full width, but plans benefit from tighter line lengths.

#### Change 3: Replace heading styles with VS Code's em-based scale (lines 704-729)

**Current:** Absolute px sizes (h1: 16px, h2: 14px, h3: 13px) with `color: var(--accent-teal)`.

**New:**
```css
#markdown-preview h1, #markdown-preview h2, #markdown-preview h3, #markdown-preview h4, #markdown-preview h5, #markdown-preview h6,
#markdown-preview-online h1, #markdown-preview-online h2, #markdown-preview-online h3, #markdown-preview-online h4, #markdown-preview-online h5, #markdown-preview-online h6 {
    margin-top: 24px;
    margin-bottom: 16px;
    font-weight: 600;
    line-height: 1.25;
    color: var(--vscode-editor-foreground, #e0e0e0); /* VS Code uses foreground, not accent */
}

#markdown-preview h1,
#markdown-preview-online h1 {
    font-size: 2em; /* VS Code default: 2em relative to 14px base = 28px */
    margin-top: 0;
    padding-bottom: 0.3em;
    border-bottom: 1px solid var(--vscode-widget-border, rgba(255, 255, 255, 0.18));
}

#markdown-preview h2,
#markdown-preview-online h2 {
    font-size: 1.5em; /* VS Code default: 1.5em = 21px */
    padding-bottom: 0.3em;
    border-bottom: 1px solid var(--vscode-widget-border, rgba(255, 255, 255, 0.18));
}

#markdown-preview h3,
#markdown-preview-online h3 {
    font-size: 1.25em; /* VS Code default: 1.25em = 17.5px */
}

#markdown-preview h4,
#markdown-preview-online h4 {
    font-size: 1em;
}

#markdown-preview h5,
#markdown-preview-online h5 {
    font-size: 0.875em;
}

#markdown-preview h6,
#markdown-preview-online h6 {
    font-size: 0.85em;
}
```

**Logic:** VS Code's markdown preview uses em units relative to the 14px base, so headings scale proportionally. Colors use `--vscode-editor-foreground` (not accent colors) matching VS Code's approach where headings are the same color as body text, differentiated by size/weight only.

#### Change 4: Replace paragraph/list styling (lines 731-737)

**Current:** `color: #cccccc; font-size: 12px; line-height: 1.5;`

**New:**
```css
#markdown-preview p, #markdown-preview li,
#markdown-preview-online p, #markdown-preview-online li {
    margin-bottom: 16px;
    line-height: inherit; /* Inherits from container's var(--vscode-font-line-height, 22px) */
    color: var(--vscode-editor-foreground, #cccccc);
    font-size: inherit; /* Inherits from container's var(--vscode-font-size, 14px) */
}

#markdown-preview li p,
#markdown-preview-online li p {
    margin-bottom: 0.7em; /* Match VS Code's tighter spacing inside list items */
}
```

#### Change 5: Replace code block styling (lines 739-765)

**Current:** Custom `rgba(255,255,255,0.04)` background, `11px` font size.

**New:**
```css
#markdown-preview pre,
#markdown-preview-online pre {
    background-color: var(--vscode-textCodeBlock-background, rgba(255,255,255,0.04));
    border: 1px solid var(--vscode-widget-border, rgba(127, 127, 127, 0.35));
    border-radius: 3px;
    overflow-x: auto;
    padding: 16px; /* VS Code default */
    margin: 16px 0;
}

#markdown-preview pre code,
#markdown-preview-online pre code {
    background: none;
    padding: 0;
    border: none;
    display: inline-block;
    color: var(--vscode-editor-foreground, #cccccc);
    tab-size: 4;
}

#markdown-preview code,
#markdown-preview-online code {
    font-family: var(--vscode-editor-font-family, 'SF Mono', Monaco, Menlo, Consolas, monospace);
    font-size: 1em; /* Match VS Code: inline code is same size as surrounding text */
    line-height: 1.357em;
    background-color: var(--vscode-textCodeBlock-background, rgba(255,255,255,0.06));
    padding: 1px 4px;
    border-radius: 3px;
}
```

#### Change 6: Replace blockquote styling (lines 767-774)

**Current:** `border-left: 3px solid var(--border-color); padding-left: 8px;`

**New:**
```css
#markdown-preview blockquote,
#markdown-preview-online blockquote {
    margin: 0;
    padding: 0 16px 0 10px; /* Match VS Code's markdown.css */
    border-left: 5px solid var(--vscode-textBlockQuote-border, var(--border-color));
    border-radius: 2px;
    color: var(--vscode-editor-foreground, var(--text-secondary));
    background: transparent;
}
```

#### Change 7: Replace list styling (lines 776-780)

**Current:** `margin-bottom: 16px; padding-left: 24px;`

**New:**
```css
#markdown-preview ul, #markdown-preview ol,
#markdown-preview-online ul, #markdown-preview-online ol {
    margin-bottom: 0.7em; /* Match VS Code's tighter list spacing */
    padding-left: 2em;
}
```

#### Change 8: Replace table styling (lines 782-829)

**Current:** Custom teal header colors, `12px` font size, explicit border colors.

**New:**
```css
#markdown-preview table,
#markdown-preview-online table {
    border-collapse: collapse;
    margin-bottom: 0.7em;
    font-size: inherit; /* Inherits from container */
}

#markdown-preview th,
#markdown-preview-online th {
    text-align: left;
    border-bottom: 1px solid var(--vscode-widget-border, rgba(255, 255, 255, 0.69));
    font-weight: 600;
    padding: 5px 10px;
}

#markdown-preview td,
#markdown-preview-online td {
    padding: 5px 10px;
    border-top: 1px solid var(--vscode-widget-border, rgba(255, 255, 255, 0.18));
    color: var(--vscode-editor-foreground, var(--text-primary));
}

#markdown-preview tr:hover td,
#markdown-preview-online tr:hover td {
    background: var(--vscode-list-hoverBackground, var(--card-bg-hover));
}
```

**Logic:** Removed the teal-colored table headers and explicit per-cell right borders. VS Code uses simple border-bottom on `th` and border-top on `td`, which is cleaner. The `--vscode-widget-border` variable handles theme adaptation.

#### Change 9: Replace link styling (lines 831-844)

**Current:** `color: var(--accent-teal); border-bottom: 1px solid var(--accent-teal-dim);`

**New:**
```css
#markdown-preview a,
#markdown-preview-online a {
    color: var(--vscode-textLink-foreground, var(--accent-teal));
    text-decoration: none;
}

#markdown-preview a:hover,
#markdown-preview-online a:hover {
    color: var(--vscode-textLink-activeForeground, var(--accent-teal-bright));
    text-decoration: underline;
}
```

**Logic:** VS Code's preview uses `text-decoration: underline` on hover (not a border-bottom). The `--vscode-textLink-foreground` variable adapts to the active theme. Fallback to `--accent-teal` preserves the current look if the variable is missing.

#### Change 10: Add missing element styles (hr, img)

**Add after the link styles:**
```css
#markdown-preview hr,
#markdown-preview-online hr {
    border: 0;
    height: 1px;
    border-bottom: 1px solid var(--vscode-widget-border, rgba(255, 255, 255, 0.18));
}

#markdown-preview img,
#markdown-preview-online img {
    max-width: 100%;
    max-height: 100%;
}
```

**Logic:** VS Code's markdown.css defines these rules. Without them, `<hr>` renders as a thick default border and `<img>` can overflow the container.

#### Change 11: Update empty state styling (lines 846-854)

**Current:** `color: var(--text-secondary); font-size: 14px;`

**New:**
```css
#markdown-preview .empty-state,
#markdown-preview-online .empty-state {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 100%;
    color: var(--vscode-editor-foreground, var(--text-secondary));
    font-size: inherit; /* Inherits from container's 14px */
    opacity: 0.5;
}
```

## Verification Plan

### Automated Tests
- No automated tests applicable for CSS styling changes.

### Manual Verification
1. Open the Planning panel in VS Code with the default Dark Modern theme
2. Load a markdown document containing: h1-h6 headings, paragraphs, inline code, code blocks, blockquotes, ordered/unordered lists, tables, links, horizontal rules, and images
3. Compare side-by-side with VS Code's built-in markdown preview (`Markdown: Open Preview`) — typography scale, colors, and spacing should match
4. Switch to a light theme (e.g., Light Modern) — verify the preview adapts (text becomes dark, backgrounds become light, no unreadable contrast)
5. Switch to High Contrast theme — verify borders and text remain visible
6. Verify the kanban UI chrome (tab bar, sidebar, buttons) is unchanged — still uses teal accents and dark theme
7. Verify the dot-pattern background is gone from the preview pane area
8. Verify `max-width: 800px` centered layout is preserved

## Problem
The markdown preview in `planning.html` looks significantly different from VS Code's default markdown preview. This creates visual inconsistency and a poorer reading experience.

## Key Issues Identified

1. **Hardcoded Custom Styling**
   - Custom dark theme with teal accents (`--accent-teal: #3ddbd9`) that doesn't match VS Code themes
   - Smaller font sizes than typical (h1: 16px, h2: 14px, p: 12px)
   - Custom spacing and line heights that differ from VS Code defaults

2. **Limited VS Code Theme Integration**
   - References some VS Code CSS variables but not the full set
   - Doesn't automatically adapt to user's current VS Code theme
   - VS Code's native preview uses the same typography system as the editor

3. **Custom Background Pattern**
   - Line 648: `background-image: radial-gradient(circle, #333 1px, transparent 1px);` adds a dot pattern
   - This can make text harder to read and changes the visual feel
   - VS Code's preview uses solid backgrounds

4. **Inconsistent Typography**
   - Specific font sizes and weights that may not match editor settings
   - VS Code's preview uses the same typography system for consistency

## Solution

### Phase 1: Audit VS Code's Native Markdown Preview CSS
- Research VS Code's built-in markdown preview CSS classes and variables
- Identify which VS Code CSS variables are available for theming
- Document the default typography, spacing, and color values

### Phase 2: Replace Hardcoded Values with VS Code Variables
- Replace hardcoded colors with VS Code theme variables:
  - `--accent-teal` → `var(--vscode-textLink-foreground)`
  - Custom background colors → `var(--vscode-editor-background)`
  - Text colors → `var(--vscode-editor-foreground)`
- Replace hardcoded font sizes with VS Code's typography scale
- Use VS Code's spacing variables where available

### Phase 3: Remove Custom Visual Elements
- Remove the dot pattern background (line 648)
- Remove custom borders and shadows that don't match VS Code
- Simplify the styling to match VS Code's clean aesthetic

### Phase 4: Match VS Code Typography
- Update heading sizes to match VS Code defaults
- Update paragraph line-height and spacing
- Ensure code blocks match VS Code's code styling
- Match list styling and indentation

### Phase 5: Test Across Themes
- Test with different VS Code themes (dark, light, high contrast)
- Ensure the preview adapts correctly to theme changes
- Verify readability and contrast ratios

## Files to Modify
- `src/webview/planning.html` (lines 643-854 primarily)

## Success Criteria
- Markdown preview visually matches VS Code's native preview
- Preview adapts to user's VS Code theme automatically
- Typography, spacing, and colors are consistent with editor
- No custom visual elements that deviate from VS Code's aesthetic
- Readable across all VS Code themes

## Notes
- The file has both `#markdown-preview` and `#markdown-preview-online` selectors - both need updating
- Maintain the existing layout structure (sidebar + preview pane)
- Keep the kanban dark theme for the UI elements (tabs, buttons, etc.) - only change the markdown preview styling
- `max-width: 800px` centered layout is kept as a deliberate readability deviation from VS Code's full-width preview

## Recommendation
Complexity 3 → **Send to Intern**
