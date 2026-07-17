# Fix bullet/numbered-list rendering in the Tickets document view

## Metadata

- **Complexity:** 4
- **Tags:** frontend, bugfix, ui

## Goal

Bullet points and numbered lists render as **literal marker text** (`- `, `1.`) in the planning panel's Tickets tab document view, instead of as proper `<ul>`/`<ol>` lists with markers. Fix the shared webview markdown renderer so lists render correctly everywhere it is used.

### Problem & root cause

The Tickets document view does **not** use VS Code's `markdown.api.render` for the description. When a ticket is selected, `readLocalTicketFile` is dispatched and the local `.md` file is treated as the source of truth. On response (`localTicketFileRead` handler, `planning.js:5613`), the description is rendered with the **webview's custom `renderMarkdown`** (`sharedUtils.js:99`), and `localDescription: true` is set. That flag then causes the host's correctly-rendered HTML (produced via `markdown.api.render` in `PlanningPanelProvider.ts:5098`/`5338`) to be **discarded** when `linearTaskDetailsLoaded`/`clickupTaskDetailsLoaded` arrives (`planning.js:6335`/`6497`). So whenever a local ticket file exists — the common case after first view — the buggy client renderer is the production path. This affects both freshly-fetched and locally-edited tickets.

**Why project.html / implementation.html render lists correctly:** `TaskViewerProvider` renders with `markdown.api.render` directly and has no local-file override stealing the render. Same host API, different consumption — proving the API works in this editor and the defect is isolated to the client-side `renderMarkdown`.

The local ticket file format is not plain markdown (it carries metadata and custom image-URI rewriting), so routing the ticket description through the host markdown previewer is not viable. The fix must live in the client renderer.

### The list bugs (`sharedUtils.js`, lines 221-223)

```js
.replace(/^\* (.+)$/gm, '<li>$1</li>')          // only '*' recognized — '-' and '+' are not
.replace(/(<li>.*<\/li>\n?)+/g, '<ul>$&</ul>')  // wraps runs in <ul> BEFORE ordered <li> exist
.replace(/^\d+\. (.+)$/gm, '<li>$1</li>')       // ordered <li> created but NEVER wrapped in <ol>
```

- **Ordered lists:** `<li>` items from `\d+\. ` are never wrapped in `<ol>`. They become orphan list items (then get pulled into `<p>` by the `html = '<p>' + html + '</p>'` step at line 242), so no numbers render.
- **`- ` and `+ ` bullets:** not matched by the `^\* ` regex, so they pass through as literal text.
- **The `<ul>` wrap runs before ordered-list conversion**, so even if the wrap regex were reused it would miss ordered items.
- **No nested-list support** — indented list items are not handled at all.

The CSS is correct (`planning.html:1267` sets `padding-left: 2em` on `#markdown-preview-tickets ul, ol`; no `list-style: none` on these containers), so once proper `<ul>`/`<ol>` HTML reaches the DOM, markers render.

## Scope

`renderMarkdown` (`sharedUtils.js:99`) is shared by **17 call sites**:
- `planning.js` (12): docs preview, research page list, ticket description (`localTicketFileRead`, `ticketFileChanged`, edit-save), kanban preview.
- `design.js` (4): design + briefs previews.

All callers benefit from correct list rendering. There are no existing tests for `renderMarkdown`.

## Implementation

All changes are in `src/webview/sharedUtils.js`, inside `renderMarkdown`. The line-based regex pipeline (lines 210-243) must be replaced with list-aware block grouping. Keep the rest of the pipeline (code fences, tables, blockquotes, alerts, headings, inline emphasis, links, images, the `<p>` wrapping, and the `__ESCAPED_BACKTICK__` / in-code toggling at lines 234-268) intact.

### Step 1 — Group list items into typed, nested blocks before inline replacement

After the existing `groupedLines`/`processedLines` block grouping (which already handles code fences, tables, blockquotes, alerts), introduce a **list-block grouping pass** that runs on `processedLines` *before* the inline `.replace` chain (line 210). Walk the lines and collect consecutive list lines into list blocks, tracking:

- **Marker type per line:** unordered (`-`, `*`, `+`) via `/^\s{0,3}([-*+])\s+(.+)$/`, ordered (`\d+.` or `\d+)`) via `/^\s{0,3}(\d+[.)])\s+(.+)$/`.
- **Indentation level** from leading spaces (0/2/4…), to support nesting.
- **Ordered vs unordered** at each level, so the correct wrapper (`<ul>`/`<ol>`) is emitted per nesting level.

Emit each list block as a single sentinel-delimited chunk (e.g. `HTML_LIST_START...HTML_LIST_END`, mirroring the existing `HTML_TABLE_START/END` pattern at line 161) containing fully-formed `<ul>`/`<ol>`/`<li>` HTML with nested lists. Non-list lines pass through unchanged.

Requirements for the grouping:
- A list block starts at a list line and continues while consecutive lines are list lines **or** blank lines immediately followed by another list line at the same or deeper indent (loose lists). A blank line followed by a non-list line ends the block.
- Trailing/leading blank lines inside a block must not produce empty `<li>`.
- Nested lists: a line whose indent is greater than the current item's indent opens a child list under the previous `<li>`; a return to a lesser indent closes child lists back to that level.
- Mixed ordered/unordered at different nesting levels each get their own wrapper type.

### Step 2 — Convert sentinel chunks to HTML late, outside `<p>` wrapping

In the late-stage HTML substitution section (alongside the `HTML_TABLE_START…END`, `HTML_ALERT…`, `HTML_BLOCKQUOTE…` replacements at lines 245-253), add:

```js
html = html.replace(/HTML_LIST_START([\s\S]*?)HTML_LIST_END/g, (_, listHtml) => `</p>${listHtml}<p>`);
```

This drops list blocks out of the `<p>${html}</p>` wrapping (line 242), exactly as tables/blockquotes already are, so lists are not nested inside `<p>`.

### Step 3 — Remove the broken inline list replacements

Delete the three now-redundant replacements at lines 221-223:

```js
.replace(/^\* (.+)$/gm, '<li>$1</li>')
.replace(/(<li>.*<\/li>\n?)+/g, '<ul>$&</ul>')
.replace(/^\d+\. (.+)$/gm, '<li>$1</li>')
```

Also remove the now-unnecessary `</li><br><li>` → `</li><li>` patch at line 240 (list items are no longer separated by `<br>` because they are emitted as a single block; verify this during implementation and keep it only if still needed).

### Step 4 — Preserve inline formatting inside list items

List item text captured in Step 1 must still receive inline formatting (bold/italic/code/links/images). Two options, pick whichever fits the pipeline cleanly:
- (a) Capture raw item text in the sentinel chunk and let the existing inline `.replace` chain (lines 218-231) run over the whole `processed` string including the sentinel contents, then strip the sentinel wrappers afterward; **or**
- (b) Run inline formatting per item during grouping.

Option (a) is preferred — it reuses the existing inline replacements and guarantees list items get the same inline treatment as paragraphs. Ensure the sentinel markers themselves are not mangled by the inline regexes (use markers that contain no regex-special characters matched by the inline patterns, or apply inline replacements only to content between sentinels).

### Step 5 — Code-fence safety

List grouping must not run inside fenced code blocks. The existing `inCodeFence` tracking (lines 177-182) already excludes code-fence lines from table grouping; reuse the same guard so a line like `* item` inside a ``` block is not converted to a list. Lines inside `inCodeFence` are pushed verbatim and must be skipped by the list grouping pass.

## Edge cases to handle

- `-`, `*`, `+` all valid for unordered lists; `1.` and `1)` valid for ordered (match CommonMark-ish subset; `\d+.` is the primary).
- Loose lists (blank line between items) vs tight lists — both should produce valid `<ul>`/`<ol>`; loose-list items may wrap content in `<p>`, but for this fix tight wrapping (no per-item `<p>`) is acceptable and matches current behavior.
- A list immediately followed by another list of a different type (e.g. `* ` block then `1.` block with no blank line) must produce two separate `<ul>`/`<ol>`, not merge.
- Nested lists up to at least 3 levels.
- List items containing inline code, bold, links, images.
- A `-` line that is actually a thematic break (`---` on its own line) must not be treated as a list item — `---` has no content after the marker and should be skipped by the list regex (require `\s+` + non-empty content).
- Lists inside blockquotes/alerts are out of scope for this fix (blockquote content is already rendered via a separate path); do not regress them.

## Verification plan

1. **Unit tests (new):** add `src/test/sharedUtils-renderMarkdown.test.js` covering `renderMarkdown`:
   - `*`, `-`, `+` unordered lists → `<ul><li>` with all items wrapped.
   - `1.` / `1)` ordered lists → `<ol><li>` (the core regression).
   - Nested lists (2-3 levels, mixed ordered/unordered) → correct nesting.
   - List followed by a different-type list with no blank line → two separate list elements.
   - Inline bold/code/link inside a list item renders.
   - Code fence containing `* foo` is NOT converted to a list.
   - `---` is not a list item.
   - Existing behavior preserved for headings, tables, blockquotes, alerts, images, links (snapshot a few representative inputs).
   Run via the existing test runner (`npm test` / the repo's configured command — confirm in `package.json`).
2. **Manual:** open the planning panel Tickets tab, select a ClickUp and a Linear ticket whose descriptions contain `-`/`*` bullets and `1.`/`2.` numbered lists (including a nested example). Confirm markers render. Edit a ticket's markdown locally (add a `- ` list and a `1.` list), save, confirm render. Confirm docs/research/kanban/design previews still render lists correctly (no regressions).
3. **Regression sweep:** visually load a docs file with tables + blockquotes + lists adjacent to each other to confirm the sentinel/`</p>` substitution still produces clean HTML (no stray `<p></p>` around lists).
4. **No host-side changes** — `PlanningPanelProvider.ts` and `TaskViewerProvider.ts` are untouched; the `localDescription: true` override behavior stays as-is.

## Out of scope

- Routing ticket descriptions through `markdown.api.render` (ruled out — local ticket files are not plain markdown).
- Thematic-break (`---`) rendering as `<hr>`.
- Task-list checkboxes (`- [ ]`).
- Lists inside blockquotes/alerts.
- Any change to the `localDescription` source-of-truth logic.
