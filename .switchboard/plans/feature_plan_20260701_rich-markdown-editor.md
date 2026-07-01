# Enhanced Markdown Editor: Toolbar, Shortcuts, Table Inserter & Live Side-by-Side Preview for Doc Panels

**Plan ID:** 5e88856b-8a66-4f30-abb2-639a5faf08b9

## Goal

Make editing docs in the **Planning**, **Project**, and **Design** panels pleasant instead of painful, **without changing the saved file format** (plain markdown, consumed by agents).

### The problem (root-cause analysis)

Today, every doc editor across the three panels works the same way:

- **Read mode** = a `*-preview-content` pane that shows server-rendered HTML (via VS Code's built-in `markdown.api.render` command).
- **Edit mode** = the `.edit-mode` class hides the preview and shows a bare full-bleed `<textarea class="markdown-editor">`. You hand-type **raw markdown** (`**bold**`, `## heading`, `- list`, table pipes) with **no toolbar, no shortcuts, and no preview** until you toggle back out.

The user's own words: *"it just looks bad unformatted, so it's difficult to actually edit a complex doc as everything looks the same."* The edit surface is an undifferentiated wall of monospace text — on a long plan/PRD you cannot visually distinguish a heading from body from a list, so navigating and editing is slow and error-prone. Pain ranked 1–3:

1. No toolbar / keyboard shortcuts — must remember and hand-type every markdown token.
2. Cannot see the result live — must toggle edit↔preview.
3. Tables are miserable — hand-aligning pipes.

### The critical constraint

These docs (plans, PRDs, constitutions, epics, design briefs) are **read by agents as raw markdown**, and several contain structured markers agents parse: `## Metadata`, `**Complexity:**`, `**Tags:**`, `## Goal`, code fences, HTML-comment markers, checklists. Therefore the **source of truth must remain clean markdown**. A true WYSIWYG editor that round-trips markdown↔rich-HTML can silently rewrite/mangle those markers on save and is explicitly rejected. The chosen model (confirmed with the user) is an **Enhanced Markdown editor**: markdown stays visible and authoritative; the tooling just helps you write and see it.

### The solution (one sentence)

In edit mode, replace the bare textarea with a **toolbar + split pane** (raw-markdown textarea on the left, a **live server-rendered preview** on the right), driven by a single shared, reusable webview module attached to every existing `.markdown-editor` textarea — the textarea element itself is preserved so all current save/cancel/dirty/external-change logic keeps working.

---

## User Review Required

Yes — review the **CSS-preservation constraint** (the existing `.edit-mode .markdown-editor { display:block !important }` rules in `planning.html:2500` and `design.html:2459` are load-bearing and must NOT be deleted) and the **doc-size guard threshold** (30,000 chars; above this live preview auto-disables). Both are judgment calls the implementer should confirm before coding.

## Complexity Audit

### Routine
- Adding one `<script nonce … src="{{MARKDOWN_EDITOR_URI}}">` tag to each of the 3 HTML files (mirrors the existing `SHARED_UTILS_URI` pattern at `planning.html:4046`, `project.html:1718`, `design.html:4109`).
- Adding the `{{MARKDOWN_EDITOR_URI}}` substitution + `renderMarkdownLive` message handler to `PlanningPanelProvider.ts` and `DesignPanelProvider.ts` (mirrors existing `SHARED_UTILS_URI` substitution at `PlanningPanelProvider.ts:485/1425` and `DesignPanelProvider.ts:367`).
- Webpack auto-bundles the new `src/webview/markdownEditor.js` via the existing `src/webview/*.js` glob (`webpack.config.js:84`) — no build-config change.
- Toolbar button markdown insertion (bold/italic/headings/lists/quote/code/link) — pure client-side string ops on the textarea selection.
- Idempotent `attach()` guard prevents double-wrapping on tab re-entry.

### Complex / Risky
- **CSS dependency on `!important` rules.** The textareas in `planning.html` and `design.html` carry an inline `style="display:none"`; only the existing `.edit-mode .markdown-editor { display:block !important }` rules override it. The shell approach works *only if those rules are preserved*. A future cleaner who reads "the old rule becomes irrelevant" will delete it and break the editor on two of three panels.
- **Host-side render cost on large docs.** `markdown.api.render` (the built-in VS Code markdown engine) runs on the extension host per debounced keystroke. For very large plans/PRDs this is real CPU. Mitigated by debounce + single-in-flight + a doc-size guard (see Design §1).
- **DOM-move preserves listeners but can reset scroll/focus.** `attach()` must capture and restore `scrollTop` + `selectionStart/End` around the move.

---

## Current architecture (verified)

**Editors (all share the `.edit-mode` + `textarea.markdown-editor` + `*-preview-content` pattern):**

| Panel HTML | Provider | Editor textareas |
| :-- | :-- | :-- |
| `src/webview/project.html` | `PlanningPanelProvider.ts` | `kanban-editor`, `projects-editor`, `epics-editor`, `constitution-editor`, `system-editor`, `tuning-editor` |
| `src/webview/planning.html` | `PlanningPanelProvider.ts` | `markdown-editor` (docs), plus kanban/docs tabs via `enterEditMode`/`exitEditMode` |
| `src/webview/design.html` | `DesignPanelProvider.ts` | `markdown-editor-briefs`, `markdown-editor-design` |

- Each HTML loads `{{SHARED_UTILS_URI}}` then its own panel JS. All scripts use `nonce-{{NONCE}}`.
- The CSP already permits inline styles (`style-src … 'unsafe-inline'`) and nonce'd local scripts. Loading **one more local `.js`** is fully compatible; **no external CDN** is allowed (irrelevant — we add no third-party lib).
- Webpack copies `src/webview/*.js` → `dist/webview/` via a glob, so **a new `src/webview/markdownEditor.js` is bundled automatically — no `webpack.config.js` change.**
- Markdown→HTML rendering is **server-side** via `vscode.commands.executeCommand('markdown.api.render', content)` (no `marked`/`markdown-it` dependency exists). Read-mode preview HTML arrives as `msg.renderedHtml`.
- Edit/save/cancel is wired per panel: `enterEditMode(tab)`/`exitEditMode(tab)` in `project.js` and `planning.js`; inline `classList.add/remove('edit-mode')` in `design.js`. Save reads `textarea.value`; an `input` listener sets a dirty flag.

**Design implication:** because live preview must match read mode exactly, the live preview **reuses the same `markdown.api.render` path** rather than bundling a client-side renderer. We add one generic request/response message so any editor can ask the host to render arbitrary in-progress content.

---

## Design

### 1. Shared module: `src/webview/markdownEditor.js`

A dependency-free module exposing a global (matching the existing `sharedUtils` global convention), e.g.:

```
SwitchboardMarkdownEditor.attach(textareaEl, {
    renderPreview: (markdown) => Promise<htmlString>,  // async, host round-trip
    initialView: 'split' | 'edit' | 'preview',         // default 'split'
})
```

Responsibilities (all client-side, idempotent — calling `attach` twice on the same textarea is a no-op):

1. **Wrap, don't replace.** Build a shell around the *existing* textarea:
   ```
   .md-editor-shell
     ├─ .md-toolbar        (buttons + view toggle)
     └─ .md-body           (flex row)
         ├─ <textarea .markdown-editor>   ← the ORIGINAL element, moved in unchanged
         └─ .md-live-preview              ← new; live-rendered HTML
   ```
   The textarea keeps its `id`, `value`, event listeners, and `input` events, so every existing consumer (save handlers, dirty flags, external-change reconciliation) is untouched.

2. **Toolbar actions** operate on the textarea's current selection and then **dispatch a synthetic `input` event** so existing dirty-flag listeners fire:
   - **Bold** `**…**` (Cmd/Ctrl+B), **Italic** `*…*` (Cmd/Ctrl+I)
   - **H1 / H2 / H3** (line-prefix toggles `# `, `## `, `### `)
   - **Bullet list** `- ` / **Numbered list** `1. ` (line-prefix, multi-line aware)
   - **Checkbox** `- [ ] `
   - **Blockquote** `> `
   - **Inline code** `` `…` `` / **Code block** fenced ```` ``` ````
   - **Link** `[sel](url)` (Cmd/Ctrl+K; if selection looks like a URL, put it in the paren)
   - **Table** → small **N×M grid picker** (hover to choose size) that inserts a properly aligned markdown table skeleton (header row + `---` separator + empty cells) at the cursor. Directly kills pain #3.
   - Selection-aware wrap/unwrap: pressing Bold on already-bold text removes the markers (toggle).

3. **View toggle** in the toolbar: `[ Split | Edit | Preview ]`. Persists last choice per session (in-memory; no settings write needed). Default **Split** so the formatted reference is always visible — the core fix for "everything looks the same."

4. **Live preview** (right pane):
   - On textarea `input`, debounce **~200ms**, then call `renderPreview(textarea.value)` and set `.md-live-preview.innerHTML` to the returned HTML.
   - Concurrency: tag each request with an incrementing id; ignore stale responses (last-write-wins) so fast typing can't paint an out-of-order preview.
   - **Doc-size guard:** if `textarea.value.length > 30000`, disable live preview, force the view toggle to **Edit**, and show a subtle "Live preview paused (large doc)" hint in the preview pane. Keeps the extension host responsive on big plans/PRDs — `markdown.api.render` is the built-in engine and is not free at scale.
   - Empty content → show a subtle "Nothing to preview" placeholder.
   - **Scroll/focus preservation on attach:** before moving the textarea into the shell, capture `textarea.scrollTop`, `selectionStart`, and `selectionEnd`; restore them after the move so the caret and scroll position don't jump.

5. **Self-contained CSS.** The module injects a single `<style id="md-editor-styles">` once (guarded), styling `.md-editor-shell`, `.md-toolbar`, `.md-body`, `.md-live-preview`. This keeps CSS DRY across the 3 HTML files (note: `shared-tabs.css` is dead; panels inline CSS — so injecting from the module is the clean path). The live-preview container reuses the **same visual rules as read-mode preview** (apply the existing preview/`markdown-body` selectors to `.md-live-preview` too) so live == read == saved appearance, including cyber-theme.

6. **Responsive.** Below a width threshold (e.g. pane < 640px) auto-collapse to single-pane. On collapse, **keep whichever pane was active** (don't yank the preview from a user who narrowed the panel to read it). Only auto-default to **Edit** when entering edit mode fresh on an already-narrow panel. Prevents the split from being unusable when the sidebar is open on a narrow panel.

### 2. Host-side live render message (one generic pair)

Add a generic render request handled by the providers that already call `markdown.api.render`:

- Webview → host: `{ type: 'renderMarkdownLive', requestId, content }`
- Host → webview: `{ type: 'markdownLiveRendered', requestId, html }`

Handler simply does `const html = await vscode.commands.executeCommand('markdown.api.render', content)` and posts it back with the same `requestId`. Add to:
- `PlanningPanelProvider.ts` (covers **project.html** and **planning.html**)
- `DesignPanelProvider.ts` (covers **design.html**)

The webview's `renderPreview` callback wraps this in a promise keyed by `requestId`.

### 3. CSS toggle integration

The existing rules hide `*-preview-content` and show `.markdown-editor` under `.edit-mode`. Adjust so the **shell** is the thing toggled by edit mode:
- `.md-editor-shell { display: none; }` by default; `.edit-mode .md-editor-shell { display: flex; }`.
- The textarea now lives inside the shell. The existing `.edit-mode .markdown-editor { display:block }` rules are **load-bearing and MUST be preserved unchanged** — they are not "irrelevant." In `planning.html:2500` and `design.html:2459` these rules use `display:block !important` specifically to override the inline `style="display:none"` on those textareas (`planning.html:3499`, `design.html:3598/3642`). Without the `!important` rule the textarea stays hidden even inside a visible shell. (`project.html:255` has no `!important` and its textareas carry no inline `display:none`, so it works either way — preserve it too for consistency.)
These rules live in the module's injected stylesheet, so no per-file CSS edits — but each panel's existing `.edit-mode #<tab>-preview-content { display:none }` rules AND the `.edit-mode .markdown-editor { display:block [!important] }` rules remain correct and unchanged.

### 4. Wiring per panel (minimal)

Call `SwitchboardMarkdownEditor.attach()` **lazily on first `enterEditMode` per editor** (idempotent guard prevents double-wrap), passing a `renderPreview` that posts `renderMarkdownLive`. Verified: `enterEditMode` (`planning.js:6610`, `project.js:2658`, `design.js:1555/1675`) sets `textarea.value` and toggles `.edit-mode` but does **not** rebuild the textarea DOM, so attach-once-per-editor is safe across edit-mode toggles. Lazy attach avoids wrapping editors the user never opens. No changes to save/cancel logic.

---

## Proposed Changes

### `src/webview/markdownEditor.js` (NEW)
- **Context:** No shared markdown-editing module exists today; each panel's edit mode is a bare textarea. This file is the single shared enhancer.
- **Logic:** Exposes a global `SwitchboardMarkdownEditor.attach(textareaEl, { renderPreview, initialView })`. Wraps (does not replace) the existing textarea into a `.md-editor-shell > .md-toolbar + .md-body > textarea + .md-live-preview` structure. Toolbar actions operate on the textarea selection and dispatch a synthetic `input` event so existing dirty-flag listeners fire. Live preview debounces ~200ms, calls `renderPreview`, and paints `.md-live-preview.innerHTML` with last-write-wins on `requestId`.
- **Implementation:** ~400–500 lines, zero dependencies. Injects one guarded `<style id="md-editor-styles">`. Includes the N×M table grid picker (inline popover built with `createElement` + `addEventListener`, no inline handlers), keyboard shortcuts (Cmd/Ctrl+B/I/K), view toggle (Split/Edit/Preview), doc-size guard (>30000 chars → Edit-only), responsive collapse, and scroll/focus preservation on attach.
- **Edge Cases:** Idempotent attach (no-op if shell already present). Agent markers byte-preserved (no markdown transformation, only insertion). Stale preview responses ignored. Non-`.markdown-editor` textareas never touched.

### `src/webview/project.html`
- **Context:** Loads `{{SHARED_UTILS_URI}}` then `{{PROJECT_JS_URI}}` at `project.html:1718-1719`.
- **Logic:** Add one nonce'd script tag for the new module.
- **Implementation:** Insert `<script nonce="{{NONCE}}" src="{{MARKDOWN_EDITOR_URI}}"></script>` between the `SHARED_UTILS_URI` and `PROJECT_JS_URI` tags. No structural DOM changes — the module wraps at runtime. Preserve the existing `.edit-mode .markdown-editor { display:block }` rule (`project.html:255`) unchanged.
- **Edge Cases:** None — additive script tag, CSP already permits nonce'd local scripts.

### `src/webview/planning.html`
- **Context:** Loads `{{SHARED_UTILS_URI}}` then `{{PLANNING_JS_URI}}` at `planning.html:4046-4047`.
- **Logic/Implementation:** Insert the same `{{MARKDOWN_EDITOR_URI}}` script tag before `{{PLANNING_JS_URI}}`. Preserve the existing `.edit-mode .markdown-editor { display:block !important }` rule (`planning.html:2500`) unchanged — it is load-bearing (overrides the inline `display:none` on `#markdown-editor` at `planning.html:3499`).
- **Edge Cases:** The `#markdown-editor` textarea has inline `style="display:none"`; the `!important` rule must remain for the textarea to be visible inside the shell.

### `src/webview/design.html`
- **Context:** Loads `{{SHARED_UTILS_URI}}`, `{{DESIGN_JS_URI}}`, `{{INSPECT_JS_URI}}` at `design.html:4109-4111`.
- **Logic/Implementation:** Insert the `{{MARKDOWN_EDITOR_URI}}` script tag before `{{DESIGN_JS_URI}}`. Preserve the existing `.edit-mode .markdown-editor { display:block !important }` rule (`design.html:2459`) unchanged — load-bearing for `#markdown-editor-briefs` (`design.html:3598`) and `#markdown-editor-design` (`design.html:3642`), both of which carry inline `style="display:none"`.
- **Edge Cases:** The `#design-system-tokens` JSON textarea is NOT `.markdown-editor` and is never attached.

### `src/services/PlanningPanelProvider.ts`
- **Context:** Already substitutes `{{SHARED_UTILS_URI}}` at lines 485 and 1425 (project.html and planning.html render paths) and calls `markdown.api.render` at lines 1368/3584/3706/6547. Message dispatch is a `switch(msg.type)` at line 2095.
- **Logic:** Add `{{MARKDOWN_EDITOR_URI}}` substitution in both render paths (mirror `SHARED_UTILS_URI`); add a `case 'renderMarkdownLive'` handler that does `const html = await vscode.commands.executeCommand<string>('markdown.api.render', msg.content)` and posts back `{ type: 'markdownLiveRendered', requestId: msg.requestId, html }`.
- **Implementation:** No collision with existing message types (verified: no `renderMarkdown*` handler exists). Handler is generic — covers both project.html and planning.html editors.
- **Edge Cases:** If `markdown.api.render` throws, post back `{ type:'markdownLiveRendered', requestId, html:'', error:String(err) }` so the webview can show a graceful placeholder.

### `src/services/DesignPanelProvider.ts`
- **Context:** Already substitutes `{{SHARED_UTILS_URI}}` at line 367 (design.html render path).
- **Logic/Implementation:** Add `{{MARKDOWN_EDITOR_URI}}` substitution mirroring `SHARED_UTILS_URI`; add the same `renderMarkdownLive` handler in its `_handleMessage` switch.
- **Edge Cases:** Same error-handling pattern as PlanningPanelProvider.

### `src/webview/project.js`
- **Context:** `enterEditMode(tab)` at line 2658 sets `textarea.value` and toggles `.edit-mode`; does NOT rebuild the textarea. 6 editors: `kanban-editor`, `projects-editor`, `epics-editor`, `constitution-editor`, `system-editor`, `tuning-editor`.
- **Logic/Implementation:** On first `enterEditMode` per editor, call `SwitchboardMarkdownEditor.attach(textareaEl, { renderPreview })` where `renderPreview` posts `renderMarkdownLive`. Idempotent guard makes re-entry safe.
- **Edge Cases:** Verified no editor textarea uses `.closest()`/`.parentNode` for sibling traversal — DOM-move is safe.

### `src/webview/planning.js`
- **Context:** `enterEditMode(tab)` at line 6610; editors `markdown-editor` (docs) and `kanban-editor` (kanban).
- **Logic/Implementation:** Lazy attach on first `enterEditMode` for each editor. External-change reconciliation (defers edit-mode on file change) is untouched.
- **Edge Cases:** None — attach is additive.

### `src/webview/design.js`
- **Context:** Inline `classList.add/remove('edit-mode')` at lines 1562/1577 (design) and 1675/1690 (briefs); no shared `enterEditMode` helper.
- **Logic/Implementation:** Lazy attach inside `enterDesignEditMode()` and the briefs equivalent, on first entry per editor.
- **Edge Cases:** None.

### `webpack.config.js`
- **No change.** The `src/webview/*.js` glob at line 84 auto-copies the new `markdownEditor.js` to `dist/webview/`.

---

## Edge cases & how they're handled

- **Agent markers survive.** We never transform the markdown; toolbar only inserts/wraps tokens the user invoked. `## Metadata`, `**Complexity:**`, code fences, HTML comments are byte-preserved. (No round-trip == no corruption.)
- **Save/Cancel/dirty flags unchanged.** Same textarea element + synthetic `input` events → existing listeners fire exactly as before.
- **External-change reconciliation** (planning.js defers edit-mode on external file change) is unaffected — we don't touch that flow.
- **Non-markdown textareas excluded.** The design-system-tokens JSON textarea is `#design-system-tokens`, not `.markdown-editor`, so the enhancer never touches it. Only `.markdown-editor` elements are attached.
- **Stale live-preview responses** ignored via `requestId` last-write-wins.
- **Large docs / rapid typing**: 200ms debounce + single in-flight render keeps the host responsive.
- **Narrow panels / sidebar open**: responsive collapse to single pane.
- **Idempotent attach** guards against double-wrapping on tab re-entry.
- **No migration required** — this changes only the editing UX; the on-disk markdown format is identical. (Per repo migration rule: nothing shipped-state changes.)
- **`confirm()`/modals**: none introduced (repo hard rule). The table grid picker is a lightweight inline popover, not a modal dialog.

## Risks

- **Low overall.** The one behavioral dependency is the debounced host round-trip for live preview; if it's ever slow, the editor is still fully usable (preview just lags). Mitigated by debounce + async, and by the Edit-only view toggle.
- **Visual parity**: live-preview must reuse read-mode CSS or it'll look subtly different. Mitigated by pointing the existing preview/`markdown-body` selectors at `.md-live-preview`.
- **Three-panel consistency**: handled by centralizing all logic + CSS in the single shared module.

## Out of scope (explicit)

- True WYSIWYG / rich-HTML round-tripping (rejected — corrupts agent markers).
- HTML-paste → markdown conversion (paste was not flagged as a pain; would need a converter and risks messy output).
- CodeMirror syntax-highlighting of the raw textarea (the CodeMirror model was not chosen; live preview addresses the "looks the same" complaint).
- Scroll-sync between editor and preview (optional future enhancement; imperfect without source-line mapping — left out of MVP to keep scope tight).

## Edge-Case & Dependency Audit

**Race Conditions**
- Live preview request ordering: fast typing could let an earlier render reply arrive after a later one. Mitigated by `requestId` last-write-wins (each request tagged with incrementing id; stale responses discarded).
- Multiple in-flight renders: the debounce + single-in-flight guard ensures only one `markdown.api.render` round-trip is pending at a time per editor.
- Double-attach on tab re-entry: idempotent guard (no-op if shell already wraps the textarea) prevents double-wrapping.

**Security**
- No `eval`, no external CDN, no third-party JS. CSP already permits nonce'd local scripts and inline styles (verified `planning.html:6`). The new `markdownEditor.js` is a local nonce'd script — fully CSP-compliant.
- Toolbar inserts only literal markdown tokens the user invoked; no HTML injection. Live preview HTML comes from VS Code's own `markdown.api.render` (sanitized by the platform), set via `innerHTML` on a dedicated preview container — same trust level as the existing read-mode preview.
- No `confirm()`/modal dialogs introduced (repo hard rule). Table picker is an inline popover, not a modal.

**Side Effects**
- The textarea element is moved (not replaced) into the shell; its `id`, `value`, event listeners, and `input` events are preserved. Verified no editor textarea uses `.closest()`/`.parentNode` for sibling traversal, so the DOM-move breaks no existing logic.
- Synthetic `input` events dispatched by toolbar actions keep existing dirty-flag listeners firing exactly as before.
- On-disk markdown format is identical — no migration required (per repo migration rule: nothing shipped-state changes).

**Dependencies & Conflicts**
- Depends on the existing `.edit-mode .markdown-editor { display:block [!important] }` CSS rules being preserved in all 3 HTML files. These are load-bearing for `planning.html` and `design.html` (override inline `display:none`). Deletion = editor invisible.
- Depends on `markdown.api.render` (built-in VS Code command) being available — already used in 6 places in `PlanningPanelProvider.ts` and 2 in `TaskViewerProvider.ts`.
- No new npm dependency. No `webpack.config.js` change (glob at line 84 auto-copies).
- No conflict with existing message types (verified: no `renderMarkdown*` handler exists in either provider).

## Dependencies

- None. This plan is self-contained — no prerequisite plan sessions.

## Adversarial Synthesis

Key risks: (1) the `!important` CSS rules in `planning.html:2500` and `design.html:2459` are load-bearing and must be preserved, not deleted as "irrelevant"; (2) host-side `markdown.api.render` cost on large docs, mitigated by a 30k-char doc-size guard; (3) DOM-move resetting scroll/focus, mitigated by capture/restore in `attach()`. Mitigations are scoped and cheap; the architecture (wrap-don't-replace, no round-trip, reuse the platform renderer) is sound. Complexity stays at 5.

## Verification Plan

> Verification is via the installed VSIX (`src/` is the source of truth; `dist/` is not audited). Per session directives: **no project compilation step and no automated test run** is executed as part of this plan — the user runs the build and test suite separately.

### Automated Tests
- None prescribed. This is a webview-UX feature with no existing unit/integration test harness for the webview layer; verification is manual via the installed VSIX (steps below). If a webview test harness is added later, cover: toolbar token insertion/toggle correctness, `requestId` last-write-wins, doc-size guard threshold, and idempotent attach.

### Manual verification (via installed VSIX)
1. **Each of the 3 panels, each editor**: enter edit mode → toolbar appears, split view renders, live preview matches read-mode output for the same content.
2. **Toolbar actions**: bold/italic/headings/lists/checkbox/quote/inline-code/code-block/link each insert correct markdown and toggle off on re-press; multi-line list/quote works on multi-line selection.
3. **Shortcuts**: Cmd/Ctrl+B, +I, +K work.
4. **Table picker**: inserts an aligned, valid GFM table; renders correctly in live preview and after save.
5. **Save round-trip**: Save writes exactly the markdown shown in the textarea; reopen shows identical content; agent-facing markers (`## Metadata`, `**Complexity:**`, code fences, HTML comments) are byte-identical.
6. **Dirty/cancel**: editing sets dirty; Cancel restores original; unchanged doc doesn't prompt.
7. **Responsive**: narrow the panel → collapses to single pane (keeps active pane); toggle still switches views.
8. **Theme**: verify default and cyber themes both style toolbar + live preview correctly.
9. **Perf / doc-size guard**: paste a >30k-char plan → live preview auto-disables with hint, editor stays responsive; under 30k, type rapidly — no jank, preview settles after debounce, no out-of-order flicker.
10. **CSS-preservation regression**: confirm the `.edit-mode .markdown-editor` rules remain in all 3 HTML files and the textarea is visible in edit mode on all panels.

---

## Metadata

**Complexity:** 5

**Tags:** frontend, ui, ux, feature, docs

**Recommendation:** Send to Coder (complexity 4-6).
