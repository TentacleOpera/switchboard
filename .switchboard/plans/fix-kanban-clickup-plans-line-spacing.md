# Fix Kanban Plans Tab - ClickUp Imported Plans Line Spacing

## Goal
Fix the kanban plans tab so that ClickUp imported plans display with proper line breaks instead of appearing as a wall of text.

## Metadata
- **Tags:** [frontend, bugfix, UX]
- **Complexity:** 3

## User Review Required
- Verify the fix works with actual ClickUp imported plans (single-newline content)
- Confirm that existing markdown rendering (local preview, online preview) is not adversely affected by the `<br>` change

## Problem
In `planning.html`, in the kanban plans tab, plans imported from ClickUp appear as a wall of text with no spacing/line breaks. This differs from plans created in the IDE, which display with proper formatting.

## Root Cause (Corrected)

The original plan incorrectly identified the root cause as a missing `white-space: pre-line` CSS property on `#kanban-preview-pane`. **This CSS fix would have no effect** because:

1. ClickUp imported plans are NOT rendered as plain text — they are processed through `renderMarkdown()` (`planning.js:2552`: `kanbanPreviewContent.innerHTML = renderMarkdown(msg.content)`)
2. The `renderMarkdown()` function (`planning.js:388`) converts single newlines to spaces: `.replace(/\n/g, ' ')`
3. By the time the HTML reaches the DOM, all `\n` characters are already gone — `white-space: pre-line` has nothing to preserve

**Actual root cause:** `renderMarkdown()` at `planning.js:388` collapses single newlines (`\n`) to spaces. ClickUp imported content typically uses single newlines for line breaks (not double newlines that would create `<p>` paragraph breaks). This causes the content to render as a continuous wall of text.

The relevant code in `renderMarkdown()` (`planning.js:385-389`):
```js
const parts = html.split(/(<pre><code>[\s\S]*?<\/code><\/pre>)/);
html = parts.map((part, i) => {
    if (i % 2 === 1) return part; // pre block — preserve newlines
    return part.replace(/\n\n+/g, '</p><p>').replace(/\n/g, ' ');  // <-- BUG: \n → space
}).join('');
```

## Complexity Audit

### Routine
- Single-line change in `renderMarkdown()` function
- CSS-only change is not needed (removing it from the plan)
- The `renderMarkdown()` function is a simple regex-based renderer with no complex state

### Complex / Risky
- `renderMarkdown()` is shared across 6 call sites (local preview, online preview, kanban preview, page list content, save handlers) — changing single-newline behavior affects all of them
- However, converting `\n` → `<br>` is standard GFM behavior and improves rendering everywhere

## Edge-Case & Dependency Audit

- **Race Conditions:** None — `renderMarkdown()` is a pure function with no side effects
- **Security:** No XSS risk — HTML is already escaped before markdown processing (lines 335-338)
- **Side Effects:** All 6 `renderMarkdown()` call sites will now render single newlines as `<br>` instead of spaces. This is an improvement (GFM-standard behavior), but existing content that relied on the old soft-wrap behavior may display slightly differently
- **Dependencies & Conflicts:** `<pre><code>` blocks are already protected from newline conversion (line 387: `if (i % 2 === 1) return part`), so code blocks will not be affected

## Dependencies
- None

## Adversarial Synthesis
Key risks: (1) Changing `renderMarkdown()` affects all 6 call sites, not just kanban. (2) Content that previously relied on single-newline soft-wrap may show unexpected line breaks. Mitigations: (1) The change aligns with GFM standard behavior — it's an improvement, not a regression. (2) `<pre>` blocks are already protected from the change.

## Solution (Corrected)

Change `renderMarkdown()` to convert single newlines to `<br>` tags instead of spaces. This is the standard GFM (GitHub Flavored Markdown) `hard_wrap` behavior and correctly preserves line breaks in ClickUp imported content.

**No CSS changes are needed.** The original plan's proposed `white-space: pre-line` addition to `#kanban-preview-pane` is removed because it would have no effect on markdown-rendered HTML.

## Changes Required

### File: `src/webview/planning.js`

**Line 388** — Change single-newline replacement from space to `<br>`:

Before:
```js
return part.replace(/\n\n+/g, '</p><p>').replace(/\n/g, ' ');
```

After:
```js
return part.replace(/\n\n+/g, '</p><p>').replace(/\n/g, '<br>');
```

This is the only change needed. The `<pre><code>` block protection on line 387 (`if (i % 2 === 1) return part`) already ensures code blocks are unaffected.

### File: `src/webview/planning.html`

**No changes needed.** The original plan's proposed CSS change to `#kanban-preview-pane` (adding `white-space: pre-line`) is removed — it would have no effect since `renderMarkdown()` already converts newlines before the HTML reaches the DOM.

## Verification Plan

### Automated Tests
- (Skipped per session directive)

### Manual Verification
1. Open the planning panel and navigate to the kanban plans tab
2. Select a plan imported from ClickUp (content with single-newline line breaks)
3. Verify that the plan content displays with proper line breaks and spacing
4. Compare with a plan created in the IDE to ensure consistent formatting
5. Verify that local preview (non-kanban) still renders correctly with the `<br>` change
6. Verify that code blocks (`<pre><code>`) still render correctly (newlines preserved, not doubled)
7. Verify that double-newline paragraph breaks still create proper `<p>` separation

## Recommendation
Complexity 3 → **Send to Intern**
