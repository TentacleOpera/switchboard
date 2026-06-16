# Apply Cyber Theme and Markdown Styling to project.html

## Goal
Apply the missing cyber theme CSS (background grid, CRT scanlines, glassmorphism) and unified markdown preview styling from `planning.html` to `project.html` to achieve visual consistency across Switchboard webviews.

## Problem Analysis
The new `project.html` file was created without copying the visual styling from `planning.html`, resulting in:
1. Pure black background instead of the cyber theme grid pattern
2. Missing CRT rolling scanline animation
3. Missing glassmorphism effects on panels
4. Markdown preview content lacking proper spacing and typography

## Root Cause
`project.html` was created as a minimal template and did not include:
- The cyber theme CSS section (lines 2096-2165+ in planning.html)
- The unified markdown preview CSS section (lines 951-1400+ in planning.html)
- The `<div class="cyber-scanlines"></div>` HTML elements

## Implementation Plan

### Step 1: Add Cyber Theme CSS
Copy the cyber theme CSS from `planning.html` (lines 2096-2165+) to `project.html` before the closing `</style>` tag. This includes:
- `body.cyber-theme-enabled` background grid pattern
- `.cyber-scanlines` static scanline texture
- CRT rolling sweep beam animation (`@keyframes scanline-sweep`)
- Glassmorphism effects on controls strip, sidebar panes, and preview panels
- Reduced motion media query for accessibility

### Step 2: Add Unified Markdown Preview CSS
Copy the unified markdown preview CSS from `planning.html` (lines 951-1400+) to `project.html` before the closing `</style>` tag. This includes:
- Base styling for `#kanban-preview-content`, `#epics-preview-content`, `#constitution-preview-content`
- Heading typography (h1-h6) with sizes, spacing, and cyber theme display font
- Paragraph spacing (`margin-bottom: 16px`)
- List item spacing and nesting
- Code blocks and inline code styling
- Blockquote styling
- Table styling
- Link styling
- Horizontal rules
- Image styling
- VS Code theme variable integration

### Step 3: Add Scanline Div Elements
Add `<div class="cyber-scanlines"></div>` elements to each preview panel wrapper in the HTML:
- Inside `.preview-panel-wrapper` for kanban tab
- Inside `.preview-panel-wrapper` for epics tab
- Inside `.preview-panel-wrapper` for constitution tab

### Step 4: Verify CSS Selectors
Update any CSS selectors in the copied markdown preview section to target the correct content divs:
- Replace `#kanban-preview-pane` with `#kanban-preview-content` where appropriate
- Add `#epics-preview-content` and `#constitution-preview-content` to selector groups

## Files Changed
- `/Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/project.html`

## Validation
- Open project.html in VS Code webview
- Verify background grid pattern is visible
- Verify CRT scanline animation is rolling
- Verify markdown preview content has proper spacing (paragraphs, lists, headings)
- Verify glassmorphism effects on panels

## Risks
- None - this is purely additive CSS styling
- No functional changes to JavaScript or TypeScript code

## Review Findings
Two missing cyber-theme CSS overrides from `planning.html` were found and fixed in `project.html`: `.cyber-theme-enabled .kanban-controls-strip` (should be transparent, was getting glassmorphism) and `.cyber-theme-enabled .markdown-editor` (should be transparent, was solid black). All plan requirements are now met: cyber theme grid, CRT scanlines, glassmorphism, unified markdown preview styling, and scanline divs in all three preview panels. No compilation or tests required (HTML/CSS only). Remaining risk: `::-webkit-scrollbar` base styles are absent from `project.html` (not in plan scope), so scrollbar cyber coloring cannot apply without them.

## Metadata
**Complexity:** 2
**Tags:** ui, frontend, css
