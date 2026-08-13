# Preserve Loose-List Blank Lines in Ticket Markdown Rendering and Edit Round-Trip

## Goal

Make the ticket detail view render a bullet list the way the remote source ticket does: when the source markdown separates bullets with blank lines, the rendered list must show that vertical separation. And make the in-panel markdown editor stop destroying those blank lines when the user saves.

### The problem

A remote ticket's description uses blank lines inside a bullet list to break one long list into visually distinct sub-groups (a "loose list" in CommonMark terms — every `<li>` gets `<p>` wrapping and therefore vertical spacing). In the local ticket display the whole thing collapses into one undifferentiated tight list, so the sub-group boundaries the author put there are invisible.

Verified against the live integration API on 2026-08-12 for ClickUp task `86d3y200v`, section `## Change Daily Diary Record Screen`. Both remote read paths return the blank line:

- detail fetch (`GET /v2/task/86d3y200v?include_markdown_description=true`) returns
  `...\n*   search bar underneath each emoji category\n\n*   Header - When?\n...`
- list fetch (`GET /v2/list/{id}/task?include_markdown_description=true`) returns the identical `\n\n` boundary.

The rendered local display shows no gap at that boundary.

### Root cause 1 — the renderer discards loose-list blank lines (the reported defect)

`src/webview/sharedUtils.js:314-347`, inside `renderMarkdown`. The list-block grouping pass collects a run of consecutive list lines and, by design, **continues the run across blank lines**:

```js
} else if (typeof cur === 'string' && cur.trim() === '') {
    // Blank line: continue run only if a subsequent list line exists.
    let j = k + 1;
    while (j < processedLines.length && processedLines[j].trim() === '') { j++; }
    if (j < processedLines.length && ... && matchListLine(processedLines[j])) {
        k = j;                       // <-- blank line consumed, no record kept
    } else { break; }
}
```

`run` is an array of `{ indent, ordered, text }` produced by `matchListLine` (247-254). There is no field for "a blank line preceded this item", so by the time `buildListHtml(run)` runs (259-290) the looseness is unrecoverable. `buildListHtml` emits an unconditionally **tight** list — `<ul><li>a</li><li>b</li></ul>` — with no `<p>` wrappers and no per-item class. The blank line the author typed produces exactly zero difference in output.

This is a display-layer defect in a **shared** renderer. `sharedUtils.js` is injected into four panels by `headlessPanelHtml.ts` (lines 251/287/324/433 rewrite `{{SHARED_UTILS_URI}}` for design, planning, tickets and project), and `renderMarkdown` is called from `tickets.js` (9 call sites), `planning.js` (8) and `design.js` (3). Every one of those surfaces changes behaviour.

### Root cause 2 — the WYSIWYG save path rewrites the file as a tight list

`src/webview/tickets.js:1871-1872` (inside `nodeToMarkdown`, which starts at 1841) serialises a `<ul>` back to markdown as:

```js
case 'ul': return Array.from(node.children).filter(c => c.tagName === 'LI')
    .map(li => `- ${nodeToMarkdown(li).trim()}\n`).join('') + '\n';
```

One `\n` per item, no blank lines — and `htmlToMarkdown` (1889-1892) then applies `.replace(/\n{3,}/g, '\n\n').trim()`. So an HTML→markdown round trip through the editor converts any loose list into a tight one *in the saved file*, permanently. Fixing root cause 1 alone would leave a fix that silently un-fixes itself the first time the user edits and saves the ticket.

### Root cause 3 — a `<p>`-wrapper fix would be silently cancelled by existing CSS

This is the decisive constraint on the *shape* of the fix, and it is not a matter of taste. Every panel that styles rendered markdown already ships a rule that zeroes the margin on paragraphs inside list items:

```css
#markdown-preview li p,
#markdown-preview-online li p,
#markdown-preview-design li p,
#kanban-preview-pane li p,
#markdown-preview-tickets li p {
    margin-bottom: 0; /* Paragraphs inside list items: zero extra margin (li already spaced) */
}
```

Present at `tickets.html:1256-1262`, `planning.html:1238-1241` and `design.html:1221+`. So the CommonMark-canonical fix — emit `<p>` wrappers for loose items — produces markup whose spacing is **explicitly cancelled** by a rule already in all three stylesheets. A coder who implements looseness as `<p>` wrapping will see no visual change, conclude the renderer change did not land, and start debugging the sentinel path. The per-item class below is therefore *required*, not merely preferred.

### What is NOT the cause

The import writers were checked and are clean — they must not be "fixed":

- `TaskViewerProvider._buildClickUpImportPlanContent` (`src/services/TaskViewerProvider.ts:7790`) takes `markdownDescription` and only `.trim()`s it.
- `TaskViewerProvider.importTaskAsDocument` (line 22258) and `_writeTaskDocument` (line 23327) write that string verbatim.
- `_relocalizeInlineImages` (line 22759) only rewrites `![...](url)` refs.
- `ClickUpSyncService._normalizeClickUpTask` (line 758) does `String(raw.markdown_description || ...)` with no whitespace pass.

No import-path change is in scope.

## Metadata

- **Complexity:** 4
- **Tags:** frontend, ui, bugfix
- **Project:** Browser Switchboard

## Complexity Audit (Routine vs Complex/Risky)

**Routine**
- Adding a `looseBefore` flag to the `run` items in the list-grouping pass.
- Emitting `<p>` wrappers (or a `class="loose"` marker) from `buildListHtml`.
- Adding CSS for the loose-item spacing.

**Complex / Risky**
- `renderMarkdown` is a hand-rolled markdown pipeline shared by four panels (`headlessPanelHtml.ts` injects `sharedUtils.js` into design, planning, tickets and project). A regression here is a regression everywhere. The sentinel protocol is load-bearing: `buildListHtml`'s output is embedded as `HTML_LIST_START${...}HTML_LIST_END` into a `\n`-joined buffer (346), and only converted back to real HTML at line 390 — *after* the `\n\n+ → </p><p>` and `\n → <br>` passes at 375. The emitted list HTML **must remain a single line with no internal `\n`**, or line 375 injects `<br>` between `<li>`s. Any looseness marker must be inline in that same single-line string.
- **The per-item-class shape is forced by existing CSS, not chosen.** See "Root cause 3" — `li p { margin-bottom: 0 }` already ships in all three stylesheets, so a `<p>`-wrapper implementation renders identically to today and reads as "the fix didn't work".
- `nodeToMarkdown` is the editor's only serialiser. Changing its `ul`/`ol` output changes what gets written to disk and therefore what gets pushed to the remote. The push path (`pushTicketEdits`, `TaskViewerProvider.ts:22834`) sends the local body as a **full replacement** of the remote description, so a serialiser bug becomes remote data loss.
- The `.replace(/\n{3,}/g, '\n\n')` in `htmlToMarkdown` must stay — it is what prevents runaway blank lines from nested block elements. The fix is to make the `ul` case emit `\n\n` between loose items, which survives that collapse; it must not emit three or more.

## Edge-Case & Dependency Audit

1. **Nested loose lists.** `buildListHtml` maintains an indent stack. A blank line before a *deeper-indented* item must not be treated as a paragraph break on the parent item. Decision: `looseBefore` applies to the item it precedes, at that item's own level.
2. **Blank line before the FIRST item of a list.** Already handled upstream — the run starts at the first list line, so a preceding blank is outside the run. Must stay outside; a leading `looseBefore` would add a spurious top gap. Explicitly set `looseBefore = false` for `run[0]`.
3. **All-or-nothing vs per-item.** CommonMark makes looseness a property of the whole list. This codebase's users are asking for the *specific* gaps they typed, so per-item spacing (gap only where a blank line exists) is the chosen behaviour. State this in the code comment so a future "correctness" refactor to all-or-nothing does not silently erase it.
4. **Sentinel single-line invariant.** Assert in the test that `buildListHtml`'s output contains no `\n`.
5. **The `\n\n+ → </p><p>` pass at line 375** runs on `processed` *after* lists are already sentinels, so list content is not exposed to it. Confirm this still holds after the change — if the sentinel body ever contains `\n\n`, the list would be split by a `</p><p>`.
6. **Two blank lines between items** should render the same single gap as one blank line — not a double gap. `looseBefore` is a boolean, so this falls out.
7. **Ordered lists** get the identical treatment (`<ol>`), not just `<ul>`.
8. **Editor round-trip idempotence.** After the `nodeToMarkdown` fix, `md → renderMarkdown → htmlToMarkdown` must return spacing-equivalent markdown. Bullet marker normalisation (`*   ` → `- `) is pre-existing and acceptable; blank-line loss is not.
9. **Push safety.** A ticket whose file gains `\n\n` inside a list will show as `modified` against `last_synced_at` and become push-eligible. That is correct — but the change must not itself rewrite any file. The renderer fix touches display only; the serialiser fix only affects files the user explicitly saves.
10. **`markdownEditor.js`** is a separate editor surface (`src/webview/markdownEditor.js`) with its own path. Check whether it also serialises HTML→markdown; if it does not (it is a raw-markdown textarea per the comment at `tickets.js:5149` — "The editor now holds raw markdown — use it verbatim, no lossy HTML round-trip"), no change is needed there. Confirm before editing.
11. **No confirm dialogs** anywhere in this work (repo rule).

## Proposed Changes

### `src/webview/sharedUtils.js`

**a) Record looseness while collecting the run** (in the loop at ~line 314):

```js
const run = [];
run.push({ ...firstMatch, looseBefore: false });   // first item never gets a leading gap
k++;
let sawBlank = false;
while (k < processedLines.length) {
    const cur = processedLines[k];
    if (typeof cur === 'string' && cur.trim().startsWith('```')) break;
    if (isSentinelLine(cur)) break;
    const m = matchListLine(cur);
    if (m) {
        run.push({ ...m, looseBefore: sawBlank });
        sawBlank = false;
        k++;
    } else if (typeof cur === 'string' && cur.trim() === '') {
        let j = k + 1;
        while (j < processedLines.length &&
               typeof processedLines[j] === 'string' &&
               processedLines[j].trim() === '') { j++; }
        if (j < processedLines.length &&
            !isSentinelLine(processedLines[j]) &&
            !(typeof processedLines[j] === 'string' && processedLines[j].trim().startsWith('```')) &&
            matchListLine(processedLines[j])) {
            sawBlank = true;      // <-- the fix: remember it instead of dropping it
            k = j;
        } else { break; }
    } else { break; }
}
```

**b) Emit the gap from `buildListHtml`** (~line 259). Per-item class, NOT a `<p>` wrapper — a `<p>` inside `<li>` changes the box model for every existing tight list and risks a global spacing regression:

```js
// Per-ITEM looseness, deliberately not CommonMark's all-or-nothing list-level
// rule: users type a blank line where they want THAT gap, and collapsing it to
// "the whole list is loose" erases the sub-grouping they were expressing.
// Output MUST stay a single line with no \n — the HTML_LIST sentinel is emitted
// into a \n-joined buffer whose \n are later mapped to <br>.
const liOpen = (item) => item.looseBefore ? '<li class="md-li-loose">' : '<li>';
```

and replace each `<li>${item.text}` / `</li><li>${item.text}` construction with `${liOpen(item)}${item.text}`.

**c) Add the stylesheet rule — to all three panel stylesheets, not just tickets.**

`sharedUtils.js` is a script, not a stylesheet, and the panels **inline their own CSS** (there is no shared stylesheet to edit — the same `li` block is duplicated per panel). Because the renderer is shared, the `md-li-loose` class will now be emitted in planning and design too; a panel without the rule gets the class with no styling, i.e. an invisible partial fix that looks like the change failed on that surface.

Add the rule immediately after the existing `li p { margin-bottom: 0 }` block in each of:

- `src/webview/tickets.html` (block at 1245-1262)
- `src/webview/planning.html` (block at 1227-1241)
- `src/webview/design.html` (block at 1209-1221)

```css
/* A blank line between bullets in the source is a deliberate sub-group break —
   render it as one. Per-ITEM (not a <p> wrapper): `li p { margin-bottom: 0 }`
   directly above would cancel a <p>-based gap, and a per-item class leaves a
   tight list byte-for-byte unchanged. */
.md-li-loose { margin-top: 0.65em; }
```

`src/webview/project.html` loads `sharedUtils.js` but defines no rendered-markdown `li` rules and has no `renderMarkdown` call site — leave it alone. Do not introduce a global stylesheet just for this; that is a larger change than the defect warrants and cuts against the per-panel inlining the codebase already uses.

### `src/webview/tickets.js`

**Stop the editor round-trip from flattening loose lists** (`nodeToMarkdown`, the `ul`/`ol` arms at 1871-1872):

```js
case 'ul': case 'ol': {
    const ordered = tag === 'ol';
    const items = Array.from(node.children).filter(c => c.tagName === 'LI');
    return items.map((li, i) => {
        const prefix = ordered ? `${i + 1}. ` : '- ';
        // A loose item carries its gap back out as a blank line, so a
        // render → serialise round trip is spacing-preserving. htmlToMarkdown's
        // /\n{3,}/ -> '\n\n' collapse is why this emits exactly one blank line.
        const gap = (i > 0 && li.classList.contains('md-li-loose')) ? '\n' : '';
        return `${gap}${prefix}${nodeToMarkdown(li).trim()}\n`;
    }).join('') + '\n';
}
```

(The two existing `case 'ul'` / `case 'ol'` arms are replaced by this single arm.)

## Verification Plan

1. **Unit — renderer.** New test asserting `renderMarkdown` output for:
   - `- a\n- b\n- c` → contains `<li>a</li>`, and contains **no** `md-li-loose`.
   - `- a\n- b\n\n- c` → `- c`'s `<li>` carries `md-li-loose`; `- b`'s does not.
   - `- a\n- b\n\n\n- c` → exactly one `md-li-loose` (double blank ≠ double gap).
   - `1. a\n\n2. b` → ordered list, second `<li>` loose.
   - Nested: `- a\n\n  - b` → the nested `<ul>`'s first `<li>` is the run's deeper level; assert no `<br>` appears anywhere in the list HTML.
   - **Invariant:** the substring between `HTML_LIST_START` and `HTML_LIST_END` contains no `\n`.
2. **Unit — round trip.** `htmlToMarkdown(renderMarkdown(src))` for `- a\n- b\n\n- c` returns markdown whose `- c` is preceded by a blank line; for the tight input it returns no blank lines.
3. **Regression sweep.** Run the existing webview/markdown suites plus `src/test/tickets-subtask-embedding.test.js` (it executes provider source via `new Function` and is sensitive to display-path changes). Note: five regression tests are red at HEAD independently of this work — stash-verify before attributing any red to this change.
4. **Manual, against the live server.** With the extension running, open the Tickets panel, select ClickUp ticket `86d3y200v`, scroll to `## Change Daily Diary Record Screen`, and confirm a visible gap appears before `Header - When?`, before `Header - How was it?`, before `Header - Medication`, and before `Header - Add a note` — matching the remote. Confirm no gap appears inside the four bullets under `Header - When?`.
   - Remember the browser panel is served from the installed VSIX's `dist/`, not from `src/`. Rebuild and reinstall the VSIX (or verify in the editor webview) before concluding the fix did not work.
5. **Manual, edit round trip.** Click Edit on that ticket, change one unrelated word, Save. Re-read the file on disk and confirm the `\n\n` boundaries inside the list survived. Then Push and confirm the remote description still has them.
6. **Tight-list non-regression.** Open two other tickets whose lists have no blank lines and confirm their spacing is pixel-identical to before the change.
7. **Shared-renderer sweep (the step most likely to be skipped).** `renderMarkdown` is shared, so the class now appears in the Planning and Design panels too. Open a plan with a loose list in the Planning panel and a rendered markdown block in the Design panel, and confirm the gap appears in **both** — if it appears only in Tickets, the stylesheet rule was added to one file instead of three. Then confirm the Project panel is visually unchanged (it has no rule and no call site, so it must be a no-op).
8. **`<p>`-wrapper trap.** Assert in the renderer test that the emitted list HTML contains **no** `<p>` inside `<li>`. This is the guard against a future "make it CommonMark-correct" refactor reintroducing the shape that `li p { margin-bottom: 0 }` silently cancels.

## Completion Summary

Implemented all three root causes per the plan. In `src/webview/sharedUtils.js`, the list-grouping pass now records a per-item `looseBefore` flag (false for `run[0]`, true when a blank line preceded the item, collapsed so double blanks still yield one gap) and `buildListHtml` emits `<li class="md-li-loose">` for those items via a new `liOpen(item)` helper — output stays single-line with no internal `\n`, preserving the HTML_LIST sentinel invariant. In `src/webview/tickets.js`, the `nodeToMarkdown` `ul`/`ol` arms were merged into one that prepends a `\n` gap before any `<li>` carrying `md-li-loose`, so the render→serialise round trip is spacing-preserving and survives `htmlToMarkdown`'s `\n{3,}→\n\n` collapse. The `.md-li-loose { margin-top: 0.65em }` rule was added immediately after the existing `li p { margin-bottom: 0 }` block in `tickets.html`, `planning.html`, and `design.html` (the latter including its `#stitch-html-markdown-preview` selector), so the shared renderer's new class is styled on every surface that calls it; `project.html` was left alone as it has no `renderMarkdown` call site. Confirmed `markdownEditor.js` has no HTML→markdown serialiser (edge case 10 — no change needed) and that `buildListHtml`/`HTML_LIST_START` exist only in `sharedUtils.js`. No compilation or automated tests were run per instructions; verification steps 1–8 above remain to be executed.
