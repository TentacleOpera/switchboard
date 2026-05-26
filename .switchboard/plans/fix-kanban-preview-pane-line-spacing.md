# Fix Kanban Preview Pane Line Spacing

## Goal
Apply markdown preview CSS styling to the kanban preview pane to fix cramped display with no line spacing between lines.

## Metadata
- **Tags:** [frontend, bugfix, UX]
- **Complexity:** 2

## User Review Required
- Confirm that kanban preview pane should match the spacing of LOCAL DOCS and ONLINE DOCS tabs
- Confirm that all markdown elements (paragraphs, lists, headers, code blocks, etc.) should render identically across all three preview contexts

## Complexity Audit

### Routine
- Add `#kanban-preview-pane` selector to existing markdown preview CSS rules in `planning.html`
- No JavaScript changes required
- No logic changes required

### Complex / Risky
- None

## Edge-Case & Dependency Audit

- **Race Conditions:** None — CSS-only change, no dynamic state
- **Security:** No impact — purely presentational CSS
- **Side Effects:** The change applies to all markdown preview CSS rules, ensuring consistent styling across all three preview contexts (local docs, online docs, kanban). This is the intended behavior.
- **Dependencies & Conflicts:** The `renderMarkdown()` function (line 2271 in planning.js) already calls the same markdown renderer for kanban preview as for other contexts, so the CSS change will work correctly without any JS modifications.

## Dependencies
- None

## Adversarial Synthesis
Key risks: (1) CSS specificity conflict — adding `#kanban-preview-pane` to the base container rule would override the `.kanban-preview-pane` class padding (12px) with the markdown preview padding (0 26px), since ID selectors outrank class selectors. Mitigation: create a separate base rule for `#kanban-preview-pane` that includes only font/text properties, not layout properties. (2) The base container rule also sets `max-width: 800px` and `margin: 0 auto`, which would constrain and center content inappropriately in the split-pane layout. Mitigation: exclude these layout properties from the kanban base rule.

## Proposed Changes

### `src/webview/planning.html` — CSS (lines 716-904)

**Context:** The markdown preview CSS is currently scoped to `#markdown-preview` and `#markdown-preview-online`. The kanban preview pane uses `#kanban-preview-pane` (an ID) with class `kanban-preview-pane` and lacks these styling rules, causing cramped display.

**CSS Specificity Note (Critical):** The HTML element at line 1622 has both `id="kanban-preview-pane"` and `class="kanban-preview-pane"`. An ID selector (`#kanban-preview-pane`, specificity 1,0,0) **outranks** a class selector (`.kanban-preview-pane`, specificity 0,1,0). Therefore, any property set by an `#kanban-preview-pane` rule will override the same property set by `.kanban-preview-pane`. The base container rule (lines 716-728) sets `padding: 0 26px`, `max-width: 800px`, and `margin: 0 auto` — all of which would override the kanban split-pane layout if `#kanban-preview-pane` were added to that rule group. **The base container rule must be handled differently from child element rules.**

**Logic:** Split the treatment into two categories:

#### Category A: Base Container Rule (lines 716-728) — SEPARATE RULE

Do NOT add `#kanban-preview-pane` to the existing base container rule. Instead, create a new separate rule for `#kanban-preview-pane` that includes only the font/text properties (NOT the layout properties). The `.kanban-preview-pane` class already handles `flex`, `overflow-y`, `padding: 12px`, and `border-left`.

Insert this new rule immediately after the existing base container rule (after line 728):

```css
/* Kanban preview pane: inherits font/text styling but keeps its own layout */
#kanban-preview-pane {
    font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, "Segoe WPC", "Segoe UI", system-ui, "Ubuntu", "Droid Sans", sans-serif);
    font-size: var(--vscode-font-size, 14px);
    line-height: var(--vscode-font-line-height, 22px);
    word-wrap: break-word;
    color: var(--vscode-editor-foreground, #cccccc);
}
```

Properties deliberately **excluded** (already handled by `.kanban-preview-pane` class at line 1322):
- `flex: 1` — already set by class
- `overflow-y: auto` — already set by class
- `padding: 0 26px` — class uses `padding: 12px` for split-pane; ID would override class (wrong)
- `max-width: 800px` — not desired in split-pane layout
- `margin: 0 auto` — not desired in split-pane layout

#### Category B: Child Element Rules (lines 730-904) — ADD SELECTOR

Add `#kanban-preview-pane` to all child element selector groups. These target nested elements (h1, p, li, etc.) and do not conflict with the `.kanban-preview-pane` class. Specifically:

1. **Headers** (lines 730-772): Add `#kanban-preview-pane h1` through `#kanban-preview-pane h6` to all heading selectors
2. **Paragraphs** (lines 774-780): Add `#kanban-preview-pane p` to `p` selector
3. **List items** (lines 782-793): Add `#kanban-preview-pane li` and `#kanban-preview-pane li p` to selectors
4. **Code blocks** (lines 795-823): Add `#kanban-preview-pane pre`, `#kanban-preview-pane pre code`, `#kanban-preview-pane code` to selectors
5. **Blockquotes** (lines 825-833): Add `#kanban-preview-pane blockquote` to selector
6. **Lists** (lines 835-839): Add `#kanban-preview-pane ul`, `#kanban-preview-pane ol` to selectors
7. **Tables** (lines 841-867): Add `#kanban-preview-pane table`, `#kanban-preview-pane th`, `#kanban-preview-pane td`, `#kanban-preview-pane tr:hover td` to selectors
8. **Links** (lines 869-880): Add `#kanban-preview-pane a`, `#kanban-preview-pane a:hover` to selectors
9. **Horizontal rules** (lines 882-887): Add `#kanban-preview-pane hr` to selector
10. **Images** (lines 889-893): Add `#kanban-preview-pane img` to selector
11. **Empty state** (lines 895-904): Add `#kanban-preview-pane .empty-state` to selector

**Example transformation for child element rules:**

```css
/* Current (line 774): */
#markdown-preview p,
#markdown-preview-online p {
    margin-bottom: 0.7em;
    /* ... */
}

/* Proposed: */
#markdown-preview p,
#markdown-preview-online p,
#kanban-preview-pane p {
    margin-bottom: 0.7em;
    /* ... */
}
```

## Implementation Steps

1. **Add separate base container rule for `#kanban-preview-pane`** in `src/webview/planning.html` (insert after line 728):
   - Include only font/text properties: font-family, font-size, line-height, word-wrap, color
   - Do NOT include padding, max-width, or margin (these are handled by `.kanban-preview-pane` class or are inappropriate for split-pane)

2. **Add `#kanban-preview-pane` to all 11 child element CSS selector groups** in `src/webview/planning.html` (lines 730-904):
   - Headers (h1-h6): lines 730-772
   - Paragraphs (p): lines 774-780
   - List items (li, li p): lines 782-793
   - Code blocks (pre, pre code, code): lines 795-823
   - Blockquotes (blockquote): lines 825-833
   - Lists (ul, ol): lines 835-839
   - Tables (table, th, td, tr:hover td): lines 841-867
   - Links (a, a:hover): lines 869-880
   - Horizontal rules (hr): lines 882-887
   - Images (img): lines 889-893
   - Empty state (.empty-state): lines 895-904
   - Do NOT modify the `.kanban-preview-pane` class definition at line 1322

3. **Visual verification** (manual):
   - Open planning.html in VS Code
   - Navigate to KANBAN PLANS tab
   - Select a plan with varied markdown content (paragraphs, lists, headers, code blocks)
   - Verify line spacing matches LOCAL DOCS and ONLINE DOCS tabs
   - Verify all markdown elements render correctly
   - Verify the preview pane padding remains 12px (not 26px)
   - Verify content is not constrained to 800px or centered with auto margins

## Files Changed
- `src/webview/planning.html` (lines 716-904) — add `#kanban-preview-pane` to markdown preview CSS selectors; add separate base container rule for kanban

## Verification Plan

### Automated Tests
- SKIP: No automated tests to run per session directive.

### Manual Verification
After changes, the kanban preview pane should:
- Display paragraphs with proper spacing (margin-bottom: 0.7em)
- Display list items with compact spacing (margin-bottom: 0.25em)
- Display headers with correct margins and borders
- Display code blocks with proper padding and background
- Match the visual appearance of LOCAL DOCS and ONLINE DOCS tabs
- Not have cramped line spacing between text lines
- Retain its 12px padding (not switch to 26px horizontal padding)
- Not be constrained to 800px max-width or centered with auto margins

### Specificity Regression Check
- Inspect the kanban preview pane in browser dev tools
- Confirm `padding` is computed as `12px` (from `.kanban-preview-pane`), NOT `0 26px`
- Confirm `max-width` is NOT set to `800px`
- Confirm `margin` is NOT set to `0 auto`

## Recommendation
Complexity 2 → **Send to Intern**
