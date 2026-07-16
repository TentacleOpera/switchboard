# Plan: Fix Table Icon Shows Calendar Emoji

## Goal
Replace the calendar emoji (📅) on the "Insert Table" toolbar button in the markdown editor with a glyph that reads as a table/grid, so the button visually communicates its function.

**Problem.** The "Insert Table" button in the markdown editor toolbar shows a calendar emoji (📅) instead of a table icon. The button works (it opens the table-size picker popover), but the icon misleads the user.

**Root cause.** In `src/webview/markdownEditor.js` (~line 417) the toolbar button is created with `createBtn('📅', 'Insert Table', …)`. 📅 is CALENDAR, a copy-paste error — it has nothing to do with tables. The `title` attribute ("Insert Table") is already correct; only the visible label is wrong.

## Metadata
- **Tags:** ui, bugfix
- **Complexity:** 1

## User Review Required
- None. The replacement glyph is `⊞` (U+229E, SQUARED PLUS) — a pure cosmetic label change with no product decision. If you would prefer a different glyph, the alternatives are listed under Proposed Changes.

## Complexity Audit

### Routine
- Single-character label change in one `createBtn` call in one file.
- No logic, no state, no message contract, no CSS touched.
- Reuses the existing `createBtn(label, title, action)` pattern unchanged.

### Complex / Risky
- None.

## Edge-Case & Dependency Audit
- **Race Conditions:** None. Static button label set once at editor-attach time.
- **Security:** None. `createBtn` assigns the label via `innerHTML`, but the value here is a hard-coded, developer-controlled glyph literal (no user input) — no injection surface introduced or changed.
- **Side Effects:** None. The button's `title` ("Insert Table") and click action (toggle the table-size popover) are untouched — only the visible glyph changes.
- **Dependencies & Conflicts:** Shares the file `src/webview/markdownEditor.js` with the "Fix Blue Background" and "Fix Internal Scrollbar" subtasks, but touches a completely different region (line ~417, the toolbar-button creation) from those two (the injected `<style>` block, lines ~7-111). No merge overlap with any sibling.

## Dependencies
- None. Independent of all sibling subtasks in the "Markdown Editor Polish" feature. Can land in any order.

## Adversarial Synthesis
Key risks: essentially zero — the only realistic failure is picking a glyph that renders as a missing-glyph box (tofu) in the webview font. Mitigation: `⊞` (U+229E) is in the long-established Unicode "Mathematical Operators" block with broad system-font coverage; confirm it renders during the visual verification step, and if it does not, fall back to `▦` or `▤`.

## Proposed Changes

### `src/webview/markdownEditor.js`
- **Context:** Line ~417, inside `SwitchboardMarkdownEditor.attach()`, where the table-picker button is created:
  ```js
  const tableBtn = createBtn('📅', 'Insert Table', () => {
      popover.classList.toggle('show');
  });
  ```
- **Logic:** Swap only the first argument (the label) from `'📅'` to `'⊞'`. Leave the `title` and the click handler exactly as-is.
- **Implementation:**
  ```js
  // Before
  const tableBtn = createBtn('📅', 'Insert Table', () => {
      popover.classList.toggle('show');
  });

  // After
  const tableBtn = createBtn('⊞', 'Insert Table', () => {
      popover.classList.toggle('show');
  });
  ```
- **Glyph options** (if `⊞` is unsatisfactory):

  | Icon | Codepoint | Description |
  |------|-----------|-------------|
  | `⊞` | U+229E | Squared plus — reads as a grid/insert-table (recommended) |
  | `▦` | U+25A6 | Square with vertical fill — grid pattern |
  | `▤` | U+25A4 | Square with horizontal fill — table rows |
  | `▭` | U+25AD | Rectangle — table-like outline |

- **Edge Cases:** The picker popover, its grid cells, and the GFM-table insertion logic are unaffected — this change only alters what the trigger button displays.

## Verification Plan

### Automated Tests
- None. Per session directive, no automated tests are run for this change; there is no test harness for webview toolbar glyphs and the change has no logic to assert.

### Manual / Observational
1. Open a ticket in the Tickets tab and enter edit mode so the markdown editor toolbar renders.
2. Confirm the "Insert Table" button shows a grid/table glyph (`⊞`), not a calendar, and does not render as a missing-glyph box.
3. Hover the button → tooltip still reads "Insert Table".
4. Click the button → the table-size picker popover still opens; pick a size → a GFM table skeleton is inserted. (Behaviour unchanged.)

## Recommendation
Complexity 1 → **Send to Intern.** Mechanical one-character label fix; the only care point is confirming the glyph renders.

## Completion Report (2026-07-16)
Implemented as planned: swapped the Insert Table toolbar button label from 📅 to ⊞ (U+229E) in `src/webview/markdownEditor.js` (~line 416), leaving the title and click handler untouched. Single file changed. Syntax-checked with node --check; no issues encountered. Visual glyph-render confirmation remains a manual step in the running webview.

## Review Findings
Reviewed against plan and regression-audited the `createBtn` call path. No CRITICAL/MAJOR findings: the change is a single hard-coded glyph literal swap with no signature, state, or message-contract impact; `createBtn`'s `innerHTML` assignment carries no user input here (no injection surface). No orphaned references to the old 📅 label (it was a literal, not an identifier). No code fixes applied. Remaining risk: cosmetic only — confirm `⊞` (U+229E) renders in the webview font (not tofu); fallbacks `▦`/`▤` are documented in the plan.
