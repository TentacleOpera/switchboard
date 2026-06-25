# Add Line Breaks Between Example Lines in Memo Tab Placeholder

## Goal

### Problem
In the Memo sub-tab of `implementation.html`, the textarea's placeholder example text shows three sample entries (a Bug, a Thought, and an Issue) separated by only a single newline (`&#10;`). Visually, the three lines run together with no breathing room, making the example look cramped and harder to scan. The user wants blank lines between each example line so the placeholder reads as distinct, separated entries.

### Root Cause
The placeholder attribute on the memo `<textarea>` (line 1586 of `src/webview/implementation.html`) uses a single `&#10;` entity between each example line:

```html
placeholder="Bug: login button overlaps on mobile&#10;Thought: maybe cache the user profile&#10;Issue: API returns 500 on empty payload..."
```

A single `&#10;` produces one line break — the lines are adjacent with no blank line between them. To get visual separation (a blank line between entries), each separator needs to be a double newline (`&#10;&#10;`).

### Background
- The Memo tab is a sub-tab inside the Agents panel of the implementation webview.
- The placeholder is purely a UI hint shown when the textarea is empty; it is not saved or processed.
- The actual memo content is loaded from `.switchboard/memo.md` via the `memoLoad` / `memoContent` message round-trip in `TaskViewerProvider.ts` and is unrelated to the placeholder.

## Metadata
- **Tags:** ui, webview, memo, cosmetic
- **Complexity:** 1/10

## Complexity Audit
**Routine.** This is a single-attribute cosmetic change to static HTML. No logic, no state, no data flow, no migrations. The only risk is malformed HTML entities, which is trivially verifiable by inspection.

## Edge-Case & Dependency Audit
- **Placeholder rendering:** Textarea placeholders honor `&#10;` as a line break in VS Code webviews (Chromium-based). Double `&#10;&#10;` will render a blank line between entries. No CSS change needed.
- **No effect on saved content:** The placeholder is never written to `.switchboard/memo.md`. Existing user memos are unaffected.
- **No effect on prompt generation:** `memoGeneratePrompt` reads `textarea.value`, not the placeholder. Empty textarea still yields empty content.
- **No dependency on other files:** The placeholder is self-contained in `implementation.html`.

## Proposed Changes

### File: `src/webview/implementation.html` (line 1586)

Replace the single-newline separators in the placeholder with double-newline separators so a blank line appears between each example entry.

**Before:**
```html
<textarea id="memo-textarea" class="modal-textarea"
          placeholder="Bug: login button overlaps on mobile&#10;Thought: maybe cache the user profile&#10;Issue: API returns 500 on empty payload..."
          style="width: 100%; min-height: 240px; resize: vertical; font-family: var(--font-mono, monospace); font-size: 13px;"></textarea>
```

**After:**
```html
<textarea id="memo-textarea" class="modal-textarea"
          placeholder="Bug: login button overlaps on mobile&#10;&#10;Thought: maybe cache the user profile&#10;&#10;Issue: API returns 500 on empty payload..."
          style="width: 100%; min-height: 240px; resize: vertical; font-family: var(--font-mono, monospace); font-size: 13px;"></textarea>
```

The only change is `&#10;` → `&#10;&#10;` between each example line.

## Verification Plan
1. Open the implementation webview in VS Code and switch to the Agents panel → Memo sub-tab.
2. Ensure the textarea is empty (clear it if needed) so the placeholder is visible.
3. Confirm the three example lines now appear with a blank line between each:
   - `Bug: login button overlaps on mobile`
   - *(blank line)*
   - `Thought: maybe cache the user profile`
   - *(blank line)*
   - `Issue: API returns 500 on empty payload...`
4. Confirm that typing into the textarea still replaces the placeholder and that Save / Clear / Copy Prompt / Send to Planner all behave as before.
