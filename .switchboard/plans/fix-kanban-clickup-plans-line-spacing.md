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

The `<pre><code>` block protection on line 387 (`if (i % 2 === 1) return part`) already ensures code blocks are unaffected.

**Additional fix required (discovered in review):** The list-wrapping regex on line 374 (`(<li>.*<\/li>\n?)+`) captures `\n` between consecutive `<li>` items. After the `\n` → `<br>` conversion, this produces spurious `<br>` tags between list items inside `<ul>` blocks, causing extra blank-line spacing. A cleanup step is needed after the `<br>` conversion:

```js
html = html.replace(/<\/li><br><li>/g, '</li><li>');
```

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
8. Verify that bullet lists (`* item`) render without extra spacing between items (no spurious `<br>`)

## Recommendation
Complexity 3 → **Send to Intern**

---

## Review Pass (2026-05-28)

### Stage 1: Grumpy Findings

| # | Severity | Finding |
|---|----------|---------|
| 1 | **MAJOR** | Spurious `<br>` inside `<ul>` blocks — list-wrapping regex captures `\n` between `<li>` items, which becomes `<br>` after the conversion, causing extra blank lines between list items across all 6 `renderMarkdown()` call sites |
| 2 | **NIT** | Stale comment on lines 382-384 says "soft-wrap (space) behavior" but code now does `<br>` (hard line break) |
| 3 | **NIT** | `<br>` after block-level elements (`</h1>`, etc.) adds extra spacing beyond CSS margins — minor cosmetic, GFM-standard behavior |

### Stage 2: Balanced Synthesis

- **MAJOR #1 → Fix now.** Added `html.replace(/<\/li><br><li>/g, '</li><li>')` after the `<br>` conversion (line 394). Targeted fix — only removes `<br>` between `</li>` and `<li>`, preserving intentional `<br>` inside list item content.
- **NIT #2 → Fix now.** Updated comment to reflect `<br>` behavior instead of "soft-wrap (space)".
- **NIT #3 → Defer.** Extra spacing after block elements is GFM-standard. Not a regression from the old space behavior (which was incorrect).

### Files Changed

- `src/webview/planning.js` — Lines 382-394: Updated comment + added `<br>` cleanup for list items

### Validation

- Typecheck: Skipped per session directive
- Tests: Skipped per session directive
- Manual trace: Verified list rendering path (`* item1\n* item2` → `<ul><li>item1</li><li>item2</li></ul>` — no spurious `<br>`)
- Manual trace: Verified ClickUp content path (single-newline text → `<br>` line breaks — correct)
- Manual trace: Verified `<pre><code>` blocks remain protected (pre-block splitting unchanged)

### Remaining Risks

- Content with `<br>` intentionally placed between `</li>` and `<li>` (extremely unlikely — no markdown syntax produces this) would have the `<br>` stripped. Acceptable trade-off.
- Extra `<br>` spacing after block-level headers is a known minor cosmetic difference from the old behavior. Aligns with GFM standard.
