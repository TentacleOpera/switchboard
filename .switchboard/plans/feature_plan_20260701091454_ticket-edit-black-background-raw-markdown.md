# Ticket Edit Mode Shows Raw Markdown on Pure Black Background

## Goal

### Problem
When the user clicks **Edit** on a ticket in the Tickets tab of `planning.html`, the ticket description is replaced with a `<textarea>` showing raw markdown. This textarea renders over a **pure black (`#000000`) background**, which looks jarring and inconsistent with the Docs tab edit experience, whose editor does not present a harsh black surface.

### Background Context
The Docs/Kanban tabs share a single edit mechanism: `enterEditMode(tab)` toggles an `.edit-mode` CSS class on the preview pane, which hides the rendered preview (`#markdown-preview`) and reveals a pre-styled `.markdown-editor` `<textarea>` that lives inside the preview pane DOM. The `.markdown-editor` class (`planning.html` ~line 2454) provides consistent typography, padding, and a `background: var(--panel-bg)` that is then **overridden per-theme** (e.g. `.cyber-theme-enabled .markdown-editor { background: transparent; }` at line 2354, and the claudify theme sets the surrounding `#preview-pane` to `#1C1C1C` at line 2363). Because the editor is part of the preview pane layout and inherits theme overrides, it blends seamlessly.

The Tickets tab takes a **completely separate path**. `enterTicketsEditMode()` (`planning.js` ~line 8503) rebuilds the entire `#tickets-detail-content` `innerHTML` with an inline-styled `<textarea>`:

```js
html += `<textarea id="ticket-edit-description" spellcheck="true" style="width:100%;box-sizing:border-box;outline:none;border:none;padding:16px;min-height:480px;line-height:1.6;font-family:var(--vscode-editor-font-family,monospace);font-size:13px;resize:vertical;background:var(--panel-bg);color:var(--text-primary,#ddd);">${escapeHtml(descMarkdown)}</textarea>`;
```

### Root Cause
The ticket edit textarea uses **hardcoded inline styles** — notably `background:var(--panel-bg)` (which resolves to `#000000` pure black per `:root` at `planning.html` line 40) — instead of reusing the shared `.markdown-editor` CSS class. Because the styles are inline, they:

1. **Bypass all theme overrides.** The claudify theme sets `#preview-pane-tickets` to `#1C1C1C` (a neutral dark gray), but the inline `background:var(--panel-bg)` forces pure `#000000`, producing a stark black rectangle on a gray surface. The cyber theme's `.markdown-editor { background: transparent; }` override is also ignored.
2. **Don't match the Docs tab visual contract.** The Docs editor fills its pane and inherits theme styling; the ticket editor is a standalone inline-styled block with `min-height:480px` that sits awkwardly above the comments/attachments sections.

The raw-markdown display itself is **intentional** (the comment at line 8510 states "Edit RAW markdown so headings/lists can actually be restructured"), so the fix targets only the visual styling, not the raw-markdown behavior.

## Metadata
- **Tags:** tickets, edit-mode, ui-consistency, planning-webview, theme
- **Complexity:** 3/10

## Complexity Audit
**Routine.** This is a CSS/styling refactor in a single function (`enterTicketsEditMode`). No data-flow, backend, or persistence changes. The only risk is regressions in theme appearance, which is contained to the ticket edit textarea.

## Edge-Case & Dependency Audit
- **Claudify theme:** `#preview-pane-tickets` is `#1C1C1C`; the editor must blend, not clash. Reusing `.markdown-editor` (which claudify does not explicitly override, but which inherits `var(--panel-bg)`) still yields black — so the fix must either (a) add a claudify override for the ticket editor matching the docs editor treatment, or (b) use `transparent`/inherit so the pane background shows through.
- **Cyber theme:** `.markdown-editor { background: transparent; }` exists; the ticket editor must pick this up.
- **Comments/attachments below the textarea:** The textarea has `min-height:480px`; after switching to `.markdown-editor` (which uses `height:100%`), the layout must still allow comments/attachments to flow beneath. The textarea should keep a `min-height` so it remains usable when the detail content is short.
- **`exitTicketsEditMode()`** restores the rendered view by re-calling `renderTicketsTab()` — unaffected by the styling change.
- **Save path** (`btn-save-ticket-edit` handler, line 7729) reads `ticket-edit-description` by ID — the ID must be preserved.

## Proposed Changes

### `src/webview/planning.js` — `enterTicketsEditMode()` (~line 8529)
Replace the inline-styled textarea with one that uses the shared `.markdown-editor` class, keeping the `ticket-edit-description` ID and a `min-height` for usability.

**Before:**
```js
html += `<textarea id="ticket-edit-description" spellcheck="true" style="width:100%;box-sizing:border-box;outline:none;border:none;padding:16px;min-height:480px;line-height:1.6;font-family:var(--vscode-editor-font-family,monospace);font-size:13px;resize:vertical;background:var(--panel-bg);color:var(--text-primary,#ddd);">${escapeHtml(descMarkdown)}</textarea>`;
```

**After:**
```js
html += `<textarea id="ticket-edit-description" class="markdown-editor" spellcheck="true" style="min-height:480px;height:auto;">${escapeHtml(descMarkdown)}</textarea>`;
```

The `.markdown-editor` class (line 2454) already provides: `width:100%`, `background:var(--panel-bg)`, `color:var(--text-primary)`, `font-family:var(--font-mono)`, `font-size:13px`, `border:none`, `padding:16px`, `resize:none`, `outline:none`, `box-sizing:border-box`. The inline `min-height:480px` overrides the class's `height:100%` so the editor is usable inside the scrollable detail container.

### `src/webview/planning.html` — theme overrides for ticket editor
Add a claudify override so the ticket editor matches the docs editor treatment (the docs editor sits inside `#preview-pane` which claudify sets to `#1C1C1C`; the ticket editor sits inside `#markdown-preview-tickets` whose parent `#preview-pane-tickets` is also `#1C1C1C`). Add near the existing `.cyber-theme-enabled .markdown-editor` block (~line 2354):

```css
/* Ticket edit textarea blends with the pane background, matching the docs editor */
#tickets-detail-content .markdown-editor {
    background: transparent;
}
```

Using `transparent` (rather than a hardcoded color) lets the editor inherit whatever background the surrounding `#preview-pane-tickets` / `#markdown-preview-tickets` uses in every theme — default black, claudify `#1C1C1C`, cyber, etc. This mirrors the cyber-theme `.markdown-editor { background: transparent; }` philosophy and makes the editor seamless in all themes. (Apply this to the base stylesheet, not just a theme override, so it works universally.)

> **Note:** If `transparent` causes the textarea to look indistinguishable from the rendered preview in the default black theme, an alternative is `background: var(--panel-bg2)` (`#0a0a0a`) for a subtle contrast. Confirm visually during verification.

## Verification Plan
1. Open the Planning panel → Tickets tab.
2. Select a ClickUp ticket with a description; click **Edit**.
   - Confirm the textarea shows raw markdown (unchanged behavior).
   - Confirm the background is **not** a stark pure-black rectangle — it should blend with the surrounding pane.
3. Repeat with a Linear issue.
4. Toggle the **claudify** theme (Setup tab) and repeat step 2 — the editor background should match the `#1C1C1C` pane, not pure black.
5. Toggle the **cyber** theme and repeat — the editor should be transparent/seamless.
6. Click **Save** and **Cancel** — confirm both still work (ID preserved, exit path intact).
7. Confirm comments/attachments still render below the textarea when present.
