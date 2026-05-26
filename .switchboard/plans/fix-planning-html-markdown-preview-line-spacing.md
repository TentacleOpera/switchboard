# Fix Markdown Preview Extra New Lines in planning.html

## Goal
Fix excessive vertical spacing in the markdown preview within planning.html by correcting the `renderMarkdown` function's line-break handling and adjusting CSS margins to match VS Code's built-in markdown preview defaults.

## Metadata
- **Tags:** [frontend, bugfix, UX]
- **Complexity:** 3

## User Review Required
- Confirm that the desired paragraph spacing matches VS Code's built-in markdown preview appearance.
- Confirm that single newlines in markdown source should render as soft wraps (spaces), not hard line breaks.

## Complexity Audit

### Routine
- Change two regex patterns in `renderMarkdown` function (JS)
- Adjust CSS margin values for `p` and `li` elements
- Add empty-paragraph cleanup regex
- Split combined CSS rule into separate `p` and `li` rules

### Complex / Risky
- None

## Edge-Case & Dependency Audit

- **Race Conditions:** None — `renderMarkdown` is a synchronous pure function with no shared state.
- **Security:** No impact — changes only affect rendering, not input sanitization. The existing HTML escape step (lines 304-307) remains unchanged.
- **Side Effects:** `renderMarkdown` is called in 3 locations (lines 1006, 1048, 2304). The JS fix applies globally to all callers (docs preview, online docs, kanban preview). This is desirable — all previews should have consistent spacing. CSS changes are scoped to `#markdown-preview` and `#markdown-preview-online` selectors, so kanban preview styling is unaffected.
- **Dependencies & Conflicts:** The list-wrapping regex at line 343 (`(<li>.*<\/li>\n?)+`) processes list items before the `\n` replacement step, so changing `\n` → space won't break list grouping. The `\n` between list items inside `<ul>` tags will become a space, which is harmless since `<li>` is block-level.

## Dependencies
- None

## Adversarial Synthesis
Key risks: (1) Removing the `<p>` wrapper would create invalid HTML for multi-paragraph content — the first segment would be bare text without paragraph styling. Mitigation: keep the `<p>` wrapper and add empty-paragraph cleanup instead. (2) The original plan missed `#markdown-preview-online` CSS selectors, leaving the online docs tab with 16px margins. Mitigation: update both selector groups. (3) Empty `<p></p>` tags from block-element auto-close add ghost spacing. Mitigation: strip them with a post-processing regex.

## Proposed Changes

### `src/webview/planning.js` — `renderMarkdown` function (lines 300-354)

**Context:** The function uses regex-based markdown rendering. The line-break handling at lines 350-351 and the `<p>` wrapper at line 353 cause excessive spacing.

**Logic:**

1. **Line 350** — Change `\n\n` regex to `\n\n+` to collapse multiple blank lines into a single paragraph break:
   ```javascript
   // Current:
   .replace(/\n\n/g, '</p><p>')
   // Proposed:
   .replace(/\n\n+/g, '</p><p>')
   ```

2. **Line 351** — Change single newline from `<br>` to space (soft wrap, standard markdown behavior):
   ```javascript
   // Current:
   .replace(/\n/g, '<br>')
   // Proposed:
   .replace(/\n/g, ' ')
   ```

3. **Line 353** — KEEP the `<p>` wrapper (do NOT remove it). Removing it would leave the first paragraph as bare text without `<p>` styling. Instead, add a cleanup step after the wrapper to strip empty `<p></p>` tags that result from block-level elements auto-closing paragraphs:
   ```javascript
   // Current:
   return `<p>${html}</p>`;
   // Proposed:
   html = `<p>${html}</p>`;
   html = html.replace(/<p>\s*<\/p>/g, '');
   return html;
   ```

**Edge Cases:**
- Content with no double newlines: wrapped in single `<p>...</p>` — correct.
- Content with double newlines: `<p>text1</p><p>text2</p>` — correct.
- Content starting with a header: `<p><h1>Title</h1></p>` auto-closes to `<p></p><h1>Title</h1>`, then empty `<p></p>` is stripped — correct.
- Triple+ newlines: collapsed to single `</p><p>` — correct, matches standard markdown.
- List items: `<li>` elements are processed before `\n` replacement, so changing `\n` to space doesn't break list grouping.

### `src/webview/planning.html` — CSS (lines 754-760)

**Context:** The CSS targets BOTH `#markdown-preview` AND `#markdown-preview-online`. The original plan only addressed `#markdown-preview`. Both must be updated.

**Logic:** Split the combined `p, li` rule into separate rules with reduced margins. Use `em` units to match VS Code's markdown preview defaults (VS Code uses `0.7em` for paragraph spacing at 14px base ≈ 10px).

```css
/* Current (lines 754-760): */
#markdown-preview p, #markdown-preview li,
#markdown-preview-online p, #markdown-preview-online li {
    margin-bottom: 16px;
    line-height: inherit;
    color: var(--vscode-editor-foreground, #cccccc);
    font-size: inherit;
}

/* Proposed: */
#markdown-preview p,
#markdown-preview-online p {
    margin-bottom: 0.7em; /* Match VS Code's markdown.css default */
    line-height: inherit;
    color: var(--vscode-editor-foreground, #cccccc);
    font-size: inherit;
}

#markdown-preview li,
#markdown-preview-online li {
    margin-bottom: 0.25em; /* Tighter list item spacing */
    line-height: inherit;
    color: var(--vscode-editor-foreground, #cccccc);
    font-size: inherit;
}
```

**Rationale for `em` values:**
- `0.7em` for paragraphs matches VS Code's built-in markdown preview (approximately 10px at 14px base font).
- `0.25em` for list items provides minimal spacing (approximately 3.5px), keeping lists compact.
- Using `em` instead of `px` ensures spacing scales correctly if the user changes VS Code's font size.

## Implementation Steps

1. **Update `renderMarkdown` function** in `src/webview/planning.js`:
   - Line 350: Change `/\n\n/g` → `/\n\n+/g`
   - Line 351: Change `/\n/g, '<br>'` → `/\n/g, ' '`
   - Lines 353-354: Keep `<p>` wrapper, add empty-paragraph cleanup:
     ```javascript
     html = `<p>${html}</p>`;
     html = html.replace(/<p>\s*<\/p>/g, '');
     return html;
     ```

2. **Update CSS** in `src/webview/planning.html` (lines 754-760):
   - Split the combined `p, li` rule into separate `p` and `li` rules
   - Update both `#markdown-preview` and `#markdown-preview-online` selectors
   - Change `p` margin-bottom from `16px` to `0.7em`
   - Change `li` margin-bottom from `16px` to `0.25em`

3. **Visual verification** (manual):
   - Open planning.html in VS Code
   - Navigate to LOCAL DOCS or ONLINE DOCS tab
   - Select a markdown document
   - Verify spacing matches VS Code's built-in markdown preview
   - Verify lists render with compact spacing
   - Verify headers don't have ghost spacing above them
   - Check kanban preview pane for consistent rendering

## Files Changed
- `src/webview/planning.js` (lines 350-354)
- `src/webview/planning.html` (lines 754-760)

## Verification Plan

### Automated Tests
- SKIP: No automated tests to run per session directive.

### Manual Verification
After changes, the markdown preview should:
- Not have excessive vertical spacing between paragraphs
- Match the spacing of VS Code's built-in markdown preview
- Render lists with appropriate compact spacing
- Handle code blocks, headers, and other markdown elements correctly
- Not have ghost spacing above headers (empty `<p></p>` artifacts removed)
- Apply identical styling to both LOCAL DOCS and ONLINE DOCS tabs
- Render correctly in the kanban preview pane

## Recommendation
Complexity 3 → **Send to Intern**
