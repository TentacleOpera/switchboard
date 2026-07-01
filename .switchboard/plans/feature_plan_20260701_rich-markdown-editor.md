# Enhanced Markdown Editor: Toolbar, Shortcuts, Table Inserter & Live Side-by-Side Preview for Doc Panels

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
   - Empty content → show a subtle "Nothing to preview" placeholder.

5. **Self-contained CSS.** The module injects a single `<style id="md-editor-styles">` once (guarded), styling `.md-editor-shell`, `.md-toolbar`, `.md-body`, `.md-live-preview`. This keeps CSS DRY across the 3 HTML files (note: `shared-tabs.css` is dead; panels inline CSS — so injecting from the module is the clean path). The live-preview container reuses the **same visual rules as read-mode preview** (apply the existing preview/`markdown-body` selectors to `.md-live-preview` too) so live == read == saved appearance, including cyber-theme.

6. **Responsive.** Below a width threshold (e.g. pane < 640px) auto-collapse to single-pane and default the toggle to **Edit** (preview one tap away). Prevents the split from being unusable when the sidebar is open on a narrow panel.

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
- The textarea now lives inside the shell and is always displayed within it (the old `.edit-mode .markdown-editor { display:block }` becomes irrelevant/harmless).
These rules live in the module's injected stylesheet, so no per-file CSS edits — but each panel's existing `.edit-mode #<tab>-preview-content { display:none }` rules remain correct and unchanged.

### 4. Wiring per panel (minimal)

For each panel JS, after the DOM is ready (or right when an editor is first shown), call `SwitchboardMarkdownEditor.attach()` on each `.markdown-editor` textarea, passing a `renderPreview` that posts `renderMarkdownLive`. Because `attach` is idempotent, it's safe to call on tab switches. No changes to save/cancel logic.

---

## File-by-file change list

**New**
- `src/webview/markdownEditor.js` — the shared enhancer (toolbar, shortcuts, table picker, split view, debounced live preview, injected CSS). ~400–500 lines, zero dependencies.

**HTML (add one script tag + a URI placeholder each; no structural DOM changes required — the module wraps at runtime)**
- `src/webview/project.html` — add `<script nonce="{{NONCE}}" src="{{MARKDOWN_EDITOR_URI}}"></script>` before `project.js`.
- `src/webview/planning.html` — same, before `planning.js`.
- `src/webview/design.html` — same, before `design.js`.

**Providers (URI substitution + live-render handler)**
- `src/services/PlanningPanelProvider.ts` — substitute `{{MARKDOWN_EDITOR_URI}}` in **both** the project.html and planning.html render paths (mirror the existing `SHARED_UTILS_URI` substitution); add the `renderMarkdownLive` message handler.
- `src/services/DesignPanelProvider.ts` — substitute `{{MARKDOWN_EDITOR_URI}}` for design.html; add the `renderMarkdownLive` message handler.

**Panel JS (attach the enhancer)**
- `src/webview/project.js` — attach to the 6 editors.
- `src/webview/planning.js` — attach to the docs/kanban editor(s).
- `src/webview/design.js` — attach to `markdown-editor-briefs`, `markdown-editor-design`.

**Build**
- No `webpack.config.js` change (the `src/webview/*.js` glob already copies the new file).

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

## Testing / verification plan (via installed VSIX; `src/` is source of truth, ignore `dist/`)

1. **Each of the 3 panels, each editor**: enter edit mode → toolbar appears, split view renders, live preview matches read-mode output for the same content.
2. **Toolbar actions**: bold/italic/headings/lists/checkbox/quote/inline-code/code-block/link each insert correct markdown and toggle off on re-press; multi-line list/quote works on multi-line selection.
3. **Shortcuts**: Cmd/Ctrl+B, +I, +K work.
4. **Table picker**: inserts an aligned, valid GFM table; renders correctly in live preview and after save.
5. **Save round-trip**: Save writes exactly the markdown shown in the textarea; reopen shows identical content; agent-facing markers (`## Metadata`, `**Complexity:**`, code fences, HTML comments) are byte-identical.
6. **Dirty/cancel**: editing sets dirty; Cancel restores original; unchanged doc doesn't prompt.
7. **Responsive**: narrow the panel → collapses to single pane; toggle still switches views.
8. **Theme**: verify default and cyber themes both style toolbar + live preview correctly.
9. **Perf**: paste a large plan, type rapidly — no jank, preview settles after debounce, no out-of-order flicker.

---

## Metadata

**Complexity:** 5

**Tags:** frontend, ui, ux, feature, docs
