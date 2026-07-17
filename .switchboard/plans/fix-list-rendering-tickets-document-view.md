# Fix bullet/numbered-list rendering in the Tickets document view

## Metadata

- **Complexity:** 5
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

The CSS is correct (`planning.html:1271` declares `#markdown-preview-tickets ul, #markdown-preview-tickets ol` with `padding-left: 2em` at line 1273; no `list-style: none` on these containers), so once proper `<ul>`/`<ol>` HTML reaches the DOM, markers render.

> **Superseded:** The original plan cited the CSS rule at `planning.html:1267` and the host provider at `src/providers/PlanningPanelProvider.ts`.
> **Reason:** Line-number drift — the `#markdown-preview-tickets ul, ol` selector lives at line 1271 and its `padding-left: 2em` declaration at line 1273. The provider file lives under `src/services/`, not `src/providers/` (no `src/providers/` directory exists); an implementer following the original path would not find the file.
> **Replaced with:** `planning.html:1271` (selector) / `:1273` (padding-left); `src/services/PlanningPanelProvider.ts` (lines 5098 and 5338 confirmed to call `markdown.api.render` for Linear and ClickUp descriptions respectively).

## User Review Required

Yes — review the chosen list-grouping approach (sentinel pattern vs. minimal regex patch vs. markdown library) and confirm the test-harness strategy (jsdom loading of a browser-global webview script) before implementation. Also confirm the bumped complexity score (4 → 5) is acceptable.

## Scope

`renderMarkdown` (`sharedUtils.js:99`) is shared by **17 call sites**:
- `planning.js` (12): docs preview, research page list, ticket description (`localTicketFileRead`, `ticketFileChanged`, edit-save), kanban preview.
- `design.js` (4): design + briefs previews.

All callers benefit from correct list rendering. There are no existing tests for `renderMarkdown`.

## Complexity Audit

### Routine
- Single production file touched (`src/webview/sharedUtils.js`) — all changes inside `renderMarkdown`.
- Reuses the existing sentinel-block pattern already used for tables (`HTML_TABLE_START/END`, line 161) and blockquotes/alerts (lines 200-202, 245-253).
- CSS already correct — no stylesheet changes needed.
- No host-side changes; `localDescription` source-of-truth logic untouched.
- Deleting three broken inline regexes (lines 221-223) is straightforward removal.

### Complex / Risky
- `renderMarkdown` is a shared function with 17 call sites — a regression here affects docs, research, kanban, design, and ticket previews simultaneously (high blast radius despite single-file scope).
- Correct nested-list grouping (indent tracking, mixed ordered/unordered per level, loose vs tight lists, adjacent different-type lists) is non-trivial parser logic — not a mechanical regex tweak.
- Inline formatting must still apply inside list items without mangling the sentinel wrappers or the emitted `<ul>/<li>` tags.
- The proposed unit test targets a browser-global script (`sharedUtils.js` has no `module.exports` and references `document`/`window` outside `renderMarkdown`); loading it into a Node test harness requires jsdom and a dedicated runner — not the repo's default `npm test` (`vscode-test`).

> **Superseded:** Complexity score of 4 (Low — routine single-file change).
> **Reason:** The change is single-file, but the list-grouping parser (nesting, loose/tight, mixed types) is moderate logic, the shared-function blast radius spans 17 call sites, and the test harness needs non-default setup. That fits "Mixed (5-6): majority routine but with one or two moderate, well-scoped risks extending existing patterns" better than "Routine (1-4)."
> **Replaced with:** Complexity 5. Routing recommendation is unchanged (4-6 → Send to Coder).

## Edge-Case & Dependency Audit

**Race Conditions**
- None. `renderMarkdown` is a pure synchronous string transform with no shared mutable state, no async, no event ordering. The `localDescription` override race (host HTML arriving after local render) is the existing, in-scope-untouched behavior — this fix does not alter it.

**Security**
- `renderMarkdown` already escapes `&`/`<`/`>` (lines 105-107) before any tag insertion, and `sanitizeUrl`/`escapeAttr` gate image/link URLs (lines 224-230). List-item text captured by the new grouping pass is raw (already-escaped) content that flows through the same inline chain — no new unescaped injection surface. Sentinel markers (`HTML_LIST_START`/`HTML_LIST_END`) are literal non-user strings; user content cannot produce them (same trust model as the existing table/blockquote sentinels).

**Side Effects**
- Removing the `</li><br><li>` → `</li><li>` patch (line 240): list blocks are emitted as single-line sentinels with no internal `\n`, so the `\n`→`<br>` mapping (line 237) never inserts `<br>` between `<li>`s. The patch becomes dead code and is safe to remove — but verify during implementation and keep only if still needed.
- The late `</p>${listHtml}<p>` substitution can produce a leading orphan `</p>` (list at document start) or trailing empty `<p>`; the existing `<p>\s*</p>` cleanup (line 254) handles empty `<p>` but not a leading `</p>`. This is the same characteristic the table/blockquote sentinels already exhibit, so it is pre-existing, not newly introduced — the regression sweep (lists adjacent to tables/blockquotes) must confirm no stray tags.

**Dependencies & Conflicts**
- No new runtime dependencies. jsdom (`^28.0.0`) and `@types/jsdom` (`^27.0.0`) are already devDependencies — available for the test harness.
- No conflict with the host `markdown.api.render` path; that path is untouched and only relevant when `localDescription` is false.

## Dependencies

- None (no prior-session dependencies).

## Adversarial Synthesis

Key risks: (1) shared-function blast radius — a `renderMarkdown` regression breaks 17 preview surfaces at once; (2) the nested-list parser is the real goal, and a minimal regex patch would *appear* to fix bullets/numbers while silently failing nesting and adjacent mixed-type lists; (3) the proposed test cannot run under the repo's default `npm test` and needs a jsdom-backed dedicated runner. Mitigations: reuse the proven sentinel pattern for consistency; keep inline formatting flowing through the existing chain so list items match paragraph treatment; correct the test-runner strategy to a dedicated `node` + jsdom script; add a regression sweep over lists adjacent to tables/blockquotes to catch stray `<p>`/`</p>` artifacts.

## Proposed Changes

### `src/webview/sharedUtils.js` — `renderMarkdown` (lines 99-271)

**Context:** `renderMarkdown` is a pure synchronous string transform. It escapes HTML, groups blockquotes (lines 127-144), then groups code fences / tables / blockquotes / alerts into `processedLines` (lines 146-208), joins them (line 208), runs an inline `.replace` chain (lines 210-232), splits out `<pre><code>` and converts `\n\n`→`</p><p>` / `\n`→`<br>` (lines 234-238), wraps in `<p>` (line 242), then substitutes sentinel blocks back out of the `<p>` wrapping (lines 245-254). The broken list handling is the three regexes at lines 221-223.

**Logic:** Replace the broken inline list regexes with a list-block grouping pass that emits fully-formed, sentinel-delimited `<ul>`/`<ol>`/`<li>` HTML (mirroring the table sentinel at line 161), then convert those sentinels to HTML late — outside the `<p>` wrapping — exactly as tables/blockquotes/alerts already are. Keep the rest of the pipeline (code fences, tables, blockquotes, alerts, headings, inline emphasis, links, images, the `<p>` wrapping, and the `__ESCAPED_BACKTICK__` / in-code toggling at lines 234-268) intact.

**Implementation:**

#### Step 1 — Group list items into typed, nested blocks before inline replacement

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
- **Clarification (strictly implied by Step 2/3):** each list block must be emitted as a **single line** in `processedLines` (no internal `\n`), so the `\n`→`<br>` mapping at line 237 does not insert `<br>` between `<li>`s and the `</li><br><li>` patch (line 240) becomes unnecessary.

#### Step 2 — Convert sentinel chunks to HTML late, outside `<p>` wrapping

In the late-stage HTML substitution section (alongside the `HTML_TABLE_START…END`, `HTML_ALERT…`, `HTML_BLOCKQUOTE…` replacements at lines 245-253), add:

```js
html = html.replace(/HTML_LIST_START([\s\S]*?)HTML_LIST_END/g, (_, listHtml) => `</p>${listHtml}<p>`);
```

This drops list blocks out of the `<p>${html}</p>` wrapping (line 242), exactly as tables/blockquotes already are, so lists are not nested inside `<p>`.

#### Step 3 — Remove the broken inline list replacements

Delete the three now-redundant replacements at lines 221-223:

```js
.replace(/^\* (.+)$/gm, '<li>$1</li>')
.replace(/(<li>.*<\/li>\n?)+/g, '<ul>$&</ul>')
.replace(/^\d+\. (.+)$/gm, '<li>$1</li>')
```

Also remove the now-unnecessary `</li><br><li>` → `</li><li>` patch at line 240 (list items are no longer separated by `<br>` because they are emitted as a single block; verify this during implementation and keep it only if still needed).

#### Step 4 — Preserve inline formatting inside list items

List item text captured in Step 1 must still receive inline formatting (bold/italic/code/links/images). Two options, pick whichever fits the pipeline cleanly:
- (a) Capture raw item text in the sentinel chunk and let the existing inline `.replace` chain (lines 218-231) run over the whole `processed` string including the sentinel contents, then strip the sentinel wrappers afterward; **or**
- (b) Run inline formatting per item during grouping.

Option (a) is preferred — it reuses the existing inline replacements and guarantees list items get the same inline treatment as paragraphs. Ensure the sentinel markers themselves are not mangled by the inline regexes (use markers that contain no regex-special characters matched by the inline patterns, or apply inline replacements only to content between sentinels). Note: the inline escape-unescape regex at line 232 (`.replace(/\\([\\`*_{}[\]()#+\-.!|])/g, '$1')`) and the `*`/`**` emphasis regexes (lines 218-219) will run over sentinel content — this is desired (so `**bold**` inside a list item renders) and does not mangle `<li>`/`<ul>` tags since those contain no `*`/`\`/matched-punctuation sequences.

#### Step 5 — Code-fence safety

List grouping must not run inside fenced code blocks. The existing `inCodeFence` tracking (lines 177-182) already excludes code-fence lines from table grouping; reuse the same guard so a line like `* item` inside a ``` block is not converted to a list. Lines inside `inCodeFence` are pushed verbatim and must be skipped by the list grouping pass.

**Edge Cases (preserved from original plan):**
- `-`, `*`, `+` all valid for unordered lists; `1.` and `1)` valid for ordered (match CommonMark-ish subset; `\d+.` is the primary).
- Loose lists (blank line between items) vs tight lists — both should produce valid `<ul>`/`<ol>`; loose-list items may wrap content in `<p>`, but for this fix tight wrapping (no per-item `<p>`) is acceptable and matches current behavior.
- A list immediately followed by another list of a different type (e.g. `* ` block then `1.` block with no blank line) must produce two separate `<ul>`/`<ol>`, not merge.
- Nested lists up to at least 3 levels.
- List items containing inline code, bold, links, images.
- A `-` line that is actually a thematic break (`---` on its own line) must not be treated as a list item — `---` has no content after the marker and should be skipped by the list regex (require `\s+` + non-empty content).
- Lists inside blockquotes/alerts are out of scope for this fix (blockquote content is already rendered via a separate path); do not regress them.
- **Known limitation (pre-existing, not introduced by this fix):** multi-line list items (a continuation line indented but bearing no marker, i.e. CommonMark lazy continuation) are not handled — the grouping requires a marker per line. Ticket descriptions rarely use this; flagging rather than expanding scope.

### `src/test/sharedUtils-renderMarkdown.test.js` (new — deliverable, not executed in this verification pass)

**Context:** `sharedUtils.js` is a browser-global webview script (no `module.exports`; declares functions as globals; references `document`/`window` in `renderJsonTree` and the click-flash init). `renderMarkdown` itself (lines 99-271) uses only string operations and no DOM. The repo's default `npm test` runs `vscode-test` (the VS Code extension host, TS-compiled suite) — it does **not** execute plain `.js` webview scripts. Existing `.js` contract tests run via dedicated `node` scripts (e.g. `test:contract:verb-engine`) and, where DOM is needed, jsdom (`onboarding-regression.test.js`).

> **Superseded:** "Run via the existing test runner (`npm test` / the repo's configured command — confirm in `package.json`)."
> **Reason:** `npm test` is `vscode-test`, which runs compiled TS in the extension host. A `.js` test for a browser-global webview script is not runnable there. No existing test loads a raw `src/webview/*.js` global script. jsdom (`^28.0.0`) is already a devDependency and is the correct mechanism.
> **Replaced with:** Add a dedicated npm script (e.g. `test:contract:rendermarkdown`) that runs `node src/test/sharedUtils-renderMarkdown.test.js`. The test must construct a jsdom environment, load `src/webview/sharedUtils.js` as a script (so `document`/`window` exist and `renderMarkdown` is exposed on the window), then assert against `window.renderMarkdown`. Per the session directive (SKIP TESTS), this file is authored as a deliverable but is **not executed** in the current verification pass.

**Coverage (to be authored):**
- `*`, `-`, `+` unordered lists → `<ul><li>` with all items wrapped.
- `1.` / `1)` ordered lists → `<ol><li>` (the core regression).
- Nested lists (2-3 levels, mixed ordered/unordered) → correct nesting.
- List followed by a different-type list with no blank line → two separate list elements.
- Inline bold/code/link inside a list item renders.
- Code fence containing `* foo` is NOT converted to a list.
- `---` is not a list item.
- Existing behavior preserved for headings, tables, blockquotes, alerts, images, links (snapshot a few representative inputs).

## Verification Plan

> **Session directives:** SKIP COMPILATION (no `npm run compile` / webpack / tsc) and SKIP TESTS (no automated test execution) apply to this verification pass. Verification is therefore manual UI confirmation plus static code review only. The test file above is a deliverable; running it is deferred.

### Automated Tests
Deferred per session directive. The test file `src/test/sharedUtils-renderMarkdown.test.js` is authored alongside the fix (with a dedicated `node` + jsdom runner per the superseded callout above) but is not executed in this pass. When the directive is lifted, run: `npm run test:contract:rendermarkdown` (after adding the script), then `npm test` for the broader suite.

### Manual verification
1. Open the planning panel Tickets tab; select a ClickUp and a Linear ticket whose descriptions contain `-`/`*` bullets and `1.`/`2.` numbered lists (including a nested example). Confirm markers render.
2. Edit a ticket's markdown locally (add a `- ` list and a `1.` list), save, confirm render.
3. Confirm docs/research/kanban/design previews still render lists correctly (no regressions across the 17 call sites).

### Static review
4. **Regression sweep:** visually load a docs file with tables + blockquotes + lists adjacent to each other to confirm the sentinel/`</p>` substitution still produces clean HTML (no stray `<p></p>` around lists, no leading orphan `</p>` when a list starts the document).
5. Code review the list-grouping pass for: code-fence guard reuse, sentinel marker collision safety, single-line emission (no `\n` inside list sentinels), and that inline emphasis still applies inside `<li>` content.
6. **No host-side changes** — confirm `src/services/PlanningPanelProvider.ts` and `src/services/TaskViewerProvider.ts` are untouched; the `localDescription: true` override behavior stays as-is.

## Out of scope

- Routing ticket descriptions through `markdown.api.render` (ruled out — local ticket files are not plain markdown).
- Thematic-break (`---`) rendering as `<hr>`.
- Task-list checkboxes (`- [ ]`).
- Lists inside blockquotes/alerts.
- Multi-line / lazy-continuation list items (known pre-existing limitation).
- Any change to the `localDescription` source-of-truth logic.

## Completion Summary

Implemented the sentinel-based list-grouping pass in `renderMarkdown` (`src/webview/sharedUtils.js`): a new pass after `flushTableBlock()` walks `processedLines`, collects consecutive list lines (unordered `-`/`*`/`+` and ordered `N.`/`N)`), tracks indentation for nesting, and emits each list block as a single `HTML_LIST_START...HTML_LIST_END` sentinel line containing fully-formed nested `<ul>`/`<ol>`/`<li>` HTML. The three broken inline regexes and the dead `</li><br><li>` patch were removed; a late `HTML_LIST_START/END` → `</p>...<p>` substitution was added alongside the existing table/blockquote substitutions so lists escape the `<p>` wrapping. Code-fence and table/blockquote/alert sentinels are skipped by the list pass. Files changed: `src/webview/sharedUtils.js` (production fix), `src/test/sharedUtils-renderMarkdown.test.js` (new jsdom-backed contract test, authored as a deliverable per SKIP TESTS), `package.json` (added `test:contract:rendermarkdown` script). No issues encountered; an isolated logic sanity check confirmed correct HTML for unordered/ordered/nested-mixed/deep-nest/adjacent-different-type/loose/thematic-break cases.

## Review Findings

Direct reviewer pass (in-place). The list-grouping implementation is structurally sound — `buildListHtml` correctly handles flat, nested-mixed, deep-nest (3-level), adjacent-different-type, loose, and thematic-break cases (all traced statically); code-fence guard, sentinel skipping, and the late `</p>...<p>` substitution mirror the existing table/blockquote pattern; `renderMarkdown` signature unchanged so all 17 call sites are safe; no orphaned references to the removed regexes; `jsdom` confirmed as a devDep. **One MAJOR finding fixed:** the `**`/`*` emphasis regexes (`sharedUtils.js:336-337`) used `(.+?)`, which paired `*` markers across `</li><li>` boundaries now that `buildListHtml` emits an entire list as a single line — corrupting the DOM when consecutive `*`-bullet items each contain a single `*`. Narrowed the capture to `([^<\n]+?)` so emphasis cannot span any HTML tag boundary while preserving original newline-boundary and intra-item literal-`*` behavior (verified: cross-`<li>` case no longer corrupts, `**a * b**` still bolds). **One NIT fixed:** removed the unused `stripP` helper from the test file. Files changed in review: `src/webview/sharedUtils.js` (regex narrowing, 2 lines), `src/test/sharedUtils-renderMarkdown.test.js` (dead-code removal). **Deferred (NIT, pre-existing):** list-at-document-start leaves a leading orphan `</p>` — identical to the existing table/blockquote-at-doc-start behavior, not a regression; belongs in a separate HTML-wrapper cleanup. **Note:** auto-commit `1590b6b` bundled an unrelated `TaskViewerProvider.ts` change from the Multi-Feature Batch Dispatch plan; this plan's own deliverable did not touch any host-side provider (`PlanningPanelProvider.ts`/`TaskViewerProvider.ts` confirmed untouched by this plan's work). Validation: static logic trace + isolated `node` sanity check of `buildListHtml` and the fixed emphasis regex (per SKIP COMPILATION / SKIP TESTS directives, no `npm test`/`tsc` run). Remaining risk: the deferred orphan-`</p>` (cosmetic, pre-existing); multi-line lazy-continuation list items remain unsupported (known pre-existing limitation, out of scope).
