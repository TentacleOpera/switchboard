# Fix Markdown Table Rendering in Planning Preview

## Goal

Make GitHub-Flavored Markdown (GFM) pipe tables render as proper HTML `<table>` elements in the Switchboard planning preview panel, instead of being displayed as unformatted raw text.

## Problem Analysis

The `renderMarkdown()` function in `src/webview/planning.js` (line 561) is a custom regex-based markdown parser. It handles headings, bold/italic, inline code, lists, links, blockquotes, and code fences, but it has **zero support for tables**.

When a markdown file containing a table like:

```markdown
| Analytical Capability | Amplitude | Mixpanel |
| :---- | :---- | :---- |
| **Primary User Persona** | Data Analysts | Growth Marketers |
```

is loaded, the pipe characters `|` and separator row `| :---- | ... |` pass through all transformations untouched. The newline-to-`<br>` conversion then turns the table into an unreadable blob of literal text with line breaks.

Notably, `src/webview/planning.html` **already contains table CSS styles** (`#markdown-preview table`, `th`, `td`, `tr:hover` at lines 1261-1295). The CSS is ready; only the JS parser is missing the table-to-HTML conversion step.

## Root Cause

`renderMarkdown()` processes markdown in a single chain of `.replace()` calls. There is no step that:
1. Identifies contiguous lines forming a GFM table block.
2. Parses the header row, alignment row (`:---`, `---:`, `:---:`), and body rows.
3. Converts them to `<table>` / `<thead>` / `<tbody>` / `<tr>` / `<th>` / `<td>`.
4. Protects the resulting table HTML from subsequent newline-to-`<br>` conversion.

## Metadata

- **Tags:** frontend, ui, bugfix
- **Complexity:** 5

## User Review Required

- Confirm that inline formatting (bold, italic, code, links) inside table cells is a hard requirement, not a nice-to-have. The implementation is significantly simpler if cells are rendered as plain text.
- Confirm whether the `.table-wrapper` scroll container should apply to ALL preview panes or only the kanban pane (narrowest viewport).

## Complexity Audit

### Routine
- Adding `.table-wrapper` CSS to `planning.html` (lines ~1261-1295) — follows existing pattern
- Placeholder emission/restoration (`HTML_TABLE_START...HTML_TABLE_END`) — mirrors existing alert/blockquote pattern at lines 628-631 and 676-681
- Cell-splitting on `|` with trim+discard — standard GFM parsing
- Alignment extraction from separator row (`:---`, `---:`, `:---:`) — straightforward regex

### Complex / Risky
- Code fence state tracking during table detection — must avoid false-positives on pipe characters inside ``` blocks
- Extracting inline transforms into a per-cell helper `renderInlineMarkdown(text)` — refactors existing chained `.replace()` calls; risk of missing a transform or breaking anchor-based regexes
- Integration point: table detection must be woven into the `processedLines` loop (lines 617-633) alongside blockquote detection, requiring careful ordering

## Edge-Case & Dependency Audit

- **Race Conditions:** None — `renderMarkdown()` is synchronous and stateless. No async paths.
- **Security:** Table cell content is already HTML-escaped at lines 568-571 before table detection runs. No XSS risk from cell content. The `renderInlineMarkdown()` helper must NOT double-escape.
- **Side Effects:** Extracting inline transforms into a helper function changes the function's internal structure. The global replace chain (lines 638-656) must continue to work for non-table content. The helper should be a subset of the chain (bold, italic, code, links, escape restoration) — NOT headings, lists, or block-level elements.
- **Dependencies & Conflicts:** The `<pre>` protection at lines 661-665 splits on `(<pre><code>[\s\S]*?<\/code><\/pre>)`. Table cells may contain `<code>` tags from backtick processing, but NOT `<pre><code>`, so no collision. This is a non-risk but worth documenting to prevent future confusion.

## Dependencies

None — this is a self-contained bugfix with no cross-plan dependencies.

## Adversarial Synthesis

Key risks: code fence false-positives during table detection (pipe chars inside code blocks), inline formatting anchor mismatch if per-cell processing doesn't extract transforms correctly, cell-splitting edge cases with irregular pipe placement. Mitigations: track code fence state during detection pass, extract inline transforms to a dedicated `renderInlineMarkdown()` helper that operates on plain text without `^`/`gm` anchors, use standard GFM cell-splitting with trim+discard of empty first/last elements.

## Constraints & Assumptions

- **Scope:** Only GFM pipe tables need to be supported. Grid tables, HTML tables, and other table dialects are out of scope.
- **Inline formatting in cells:** Table cells may contain bold, italic, inline code, and links. These must continue to work inside cells.
- **No external library:** The existing architecture uses a hand-rolled parser. To minimize risk and bundle size, the fix should extend the existing parser rather than importing a full markdown library like `marked.js` (which would also require CSP and bundling changes).
- **VS Code Webview context:** The code runs inside a VS Code webview with a strict CSP. Inline script changes are acceptable; external script tags are not.
- **Build artifact:** `dist/webview/planning.html` mirrors `src/webview/planning.html` and must be updated as part of the build step.
- **Clarification:** The `|` character is NOT affected by HTML escaping (lines 568-571), so pipe detection works correctly on HTML-escaped text. This is confirmed by reading the escape chain: only `&`, `<`, `>` are escaped.

## Proposed Changes

### `src/webview/planning.js` — Add table parsing to `renderMarkdown()` (~80-120 new lines)

**Context:** `renderMarkdown()` (line 561) processes markdown through: HTML escape → header dedup → blockquote grouping → processedLines → join → inline replace chain → `<pre>` protection → newline-to-`<br>` → paragraph wrap → placeholder restoration. Table detection must be inserted into the `processedLines` loop (lines 617-633) and placeholder restoration at lines 676-681.

**Logic:**

1. **New helper: `renderInlineMarkdown(text)`** (insert near line 560, before `renderMarkdown`)
   - Extract the inline-only transforms from the chain at lines 646-656 into a reusable function:
     - Bold: `**...**` → `<strong>`
     - Italic: `*...*` → `<em>`
     - Inline code: `` `...` `` → `<code>`
     - Links: `[text](url)` → `<a>`
     - Escape restoration: `\(char)` → `char`
   - This helper operates on a single cell's text. No `^` or `gm` flags needed.
   - The global replace chain (lines 638-656) remains unchanged for non-table content.

2. **New helper: `parseTableBlock(lines)`** → returns HTML string
   - Input: array of raw lines forming a contiguous table block
   - Algorithm:
     - **Separator detection:** Match `^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$`. This handles both `| a | b |` and `| a | b` (no trailing pipe) forms.
     - **Cell splitting:** Split each row on `|`, trim whitespace, discard empty first/last elements (from leading/trailing `|`).
     - **Header row:** First line before separator → `<thead><tr>` with `<th>` cells. Apply `renderInlineMarkdown()` to each cell.
     - **Alignment row:** Parse each separator cell for leading `:` (left), trailing `:` (right), both (center), neither (default/null). Store as array of `text-align` values.
     - **Body rows:** All lines after separator → `<tbody><tr>` with `<td>` cells. Apply `renderInlineMarkdown()` to each cell. Apply stored alignment as `style="text-align: X"` on matching cells.
     - **Padding:** If a body row has fewer columns than the header, pad with empty `<td></td>`.
     - **Wrapper:** Wrap entire `<table>` in `<div class="table-wrapper">...</div>`.
   - Return the complete HTML string.

3. **Table detection in the `processedLines` loop** (lines 617-633)
   - Add a **code fence state tracker**: boolean `inCodeFence`, toggled when a line matches `^````.
   - Add a **table block accumulator**: array `tableBlockLines`, boolean `inTableBlock`.
   - For each `item` in `groupedLines`:
     - If `inCodeFence` is true, skip table detection (pass through as string line).
     - If `inCodeFence` is false and line matches `^\s*\|` or `^\|`:
       - Accumulate into `tableBlockLines`.
     - When a non-table line is encountered (or end of loop) and `tableBlockLines.length >= 2`:
       - Check if any accumulated line is a valid separator row.
       - If yes: call `parseTableBlock(tableBlockLines)`, emit `HTML_TABLE_START${html}HTML_TABLE_END` placeholder.
       - If no: push accumulated lines as regular strings (not a table).
       - Reset accumulator.
     - If `inCodeFence` is false and line does NOT match table pattern:
       - If accumulator has lines, flush them (as above), then push current line normally.

4. **Placeholder restoration** (add at line 681, alongside existing alert/blockquote restoration)
   ```js
   html = html.replace(/HTML_TABLE_START([\s\S]*?)HTML_TABLE_END/g, (_, tableHtml) => {
       return `</p>${tableHtml}<p>`;
   });
   ```

**Edge Cases:**
- Empty cells (`|  |` or `||`) → emit `<td></td>` / `<th></th>`
- Rows with fewer columns than header → pad with empty `<td>`
- Code fences containing `|` → skipped by `inCodeFence` tracker
- Escaped pipes (`\|`) → pre-existing limitation; table support should not make it worse. The escape restoration at line 656 runs AFTER table detection, so `\|` in raw text will still be `\|` during detection. Clarification: table cell splitting should split on unescaped `|` only. A simple approach: replace `\|` with a placeholder before splitting, restore after. This is a nice-to-have, not a hard requirement.

### `src/webview/planning.html` — Add `.table-wrapper` CSS (~8 lines)

**Context:** Table CSS already exists at lines 1261-1295. Add scroll wrapper immediately after the existing `tr:hover` rule (after line 1295).

**Implementation:**

```css
#markdown-preview .table-wrapper,
#markdown-preview-online .table-wrapper,
#markdown-preview-design .table-wrapper,
#kanban-preview-pane .table-wrapper {
    overflow-x: auto;
    max-width: 100%;
    margin-bottom: 16px;
}
```

These 4 selectors cover all preview panes that call `renderMarkdown()`: local docs (`#markdown-preview`), online docs (`#markdown-preview-online`), design docs (`#markdown-preview-design`), and kanban plans (`#kanban-preview-pane`). Verified by tracing all 8 call sites of `renderMarkdown()` in `planning.js`.

### `dist/webview/planning.html` — Regenerated by build

Do not hand-edit. Regenerated from `src/` during build step.

## Verification Plan

### Automated Tests

(Skipped per session directive — no test execution in this session.)

### Manual Verification

1. Open the Amplitude/Mixpanel comparative analysis document in the planning preview. Verify all six tables render as bordered, aligned HTML tables.
2. Create a test markdown file with:
   - A simple 2-column table
   - A table with alignment (`:---`, `---:`, `:---:`)
   - A table with bold/italic/code/link content in cells
   - A table adjacent to a code fence containing `|` characters
   - A table with empty cells and varying column counts
3. Verify non-table markdown (headings, lists, code blocks, blockquotes, alerts) still renders correctly — no regressions.
4. Resize the preview pane to a narrow width. Verify tables scroll horizontally without breaking layout.
5. Test in at least two VS Code themes (dark + light) to verify table CSS contrast.

## Rollback Plan

If table parsing introduces regressions (e.g., false positives on non-table pipe usage), the change is isolated to:
- The table detection logic in the `processedLines` loop
- The `parseTableBlock()` and `renderInlineMarkdown()` helpers
- The placeholder restoration regex
- The `.table-wrapper` CSS

Reverting is a matter of removing the table-detection branch from the loop, the two helper functions, the placeholder restoration line, and the CSS block.

## Acceptance Criteria

- [ ] Opening a markdown file with GFM pipe tables in the planning preview displays the tables as bordered, aligned HTML tables.
- [ ] Inline formatting (bold, italic, code, links) still works inside table cells.
- [ ] Tables do not break the layout on narrow viewports (horizontal scroll).
- [ ] Non-table markdown content continues to render correctly (no regressions in headings, lists, code blocks, blockquotes, alerts).
- [ ] The sample Amplitude/Mixpanel document renders all six tables correctly.
- [ ] Code fences containing pipe characters do not trigger false table detection.

## Recommendation

Complexity 5 → **Send to Coder**
