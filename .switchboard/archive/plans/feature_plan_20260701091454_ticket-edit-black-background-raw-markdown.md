# Ticket Edit Mode Shows Raw Markdown on Pure Black Background

## Goal

Fix the visual styling of the ticket edit textarea in the Tickets tab so it blends with the surrounding pane background across all themes, instead of rendering as a stark pure-black (`#000000`) rectangle. The raw-markdown editing behavior is intentional and remains unchanged.

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

1. **Bypass all theme overrides.** The claudify theme sets `#preview-pane-tickets` to `#1C1C1C` (a neutral dark gray, line 2364), but the inline `background:var(--panel-bg)` forces pure `#000000`, producing a stark black rectangle on a gray surface. The cyber theme's `.markdown-editor { background: transparent; }` override (line 2354) is also ignored.
2. **Don't match the Docs tab visual contract.** The Docs editor fills its pane and inherits theme styling; the ticket editor is a standalone inline-styled block with `min-height:480px` that sits awkwardly above the comments/attachments sections.

The raw-markdown display itself is **intentional** (the comment at line 8510 states "Edit RAW markdown so headings/lists can actually be restructured"), so the fix targets only the visual styling, not the raw-markdown behavior.

## Metadata
- **Tags:** ui, ux, bugfix, frontend
- **Complexity:** 3/10

## User Review Required
No. This is a contained CSS/styling refactor with no data-flow, persistence, or backend changes. Visual verification across themes is the only review gate (see Verification Plan).

## Complexity Audit

### Routine
- Replacing inline-styled `<textarea>` with one using the shared `.markdown-editor` class in a single function (`enterTicketsEditMode`, `planning.js` line 8529).
- Adding one base-stylesheet rule (`#tickets-detail-content .markdown-editor { background: transparent; }`) so the editor inherits the pane background in every theme.
- Preserving the `ticket-edit-description` ID so the save handler (`planning.js` line 7729) and focus call (line 8549) keep working unchanged.

### Complex / Risky
- None. No data-flow, backend, or persistence changes. The only risk is a minor behavioral regression in textarea wrapping/resizing (see Edge-Case & Dependency Audit), which is addressed by preserving inline overrides.

## Edge-Case & Dependency Audit

- **Race Conditions:** None. `enterTicketsEditMode` runs synchronously and rebuilds `innerHTML` atomically; the save handler reads the textarea by ID after the rebuild. No async path touches the textarea styling.
- **Security:** None. The textarea content is already `escapeHtml(descMarkdown)`-sanitized; the class swap does not change escaping. No new injection surface.
- **Side Effects:**
  - **Wrapping behavior:** The `.markdown-editor` class sets `white-space: pre` (line 2465), which disables line wrapping (long lines scroll horizontally). The original inline-styled textarea used the browser default `pre-wrap` (wrapping). To preserve the original wrapping UX, the inline style must re-assert `white-space: pre-wrap`.
  - **Resize behavior:** The `.markdown-editor` class sets `resize: none` (line 2463). The original textarea had `resize: vertical`. To preserve user resizing, the inline style must re-assert `resize: vertical`.
  - **Line height:** The original set `line-height: 1.6`; the class does not set line-height. Re-assert `line-height: 1.6` inline to preserve readability.
  - **Comments/attachments below the textarea:** The textarea has `min-height:480px`; after switching to `.markdown-editor` (which uses `height:100%`), the inline `height:auto` override ensures the textarea sizes to content (min 480px) and lets comments/attachments flow beneath in normal document flow.
- **Dependencies & Conflicts:**
  - **Claudify theme:** `#preview-pane-tickets` is `#1C1C1C` (line 2364); with `background: transparent` the editor blends. Confirmed: claudify does not set a `.markdown-editor` override, so the base `transparent` rule applies cleanly.
  - **Cyber theme:** `.cyber-theme-enabled .markdown-editor { background: transparent; }` (line 2354) exists. The new `#tickets-detail-content .markdown-editor` rule (ID + class) has higher specificity and also sets `transparent` — consistent, no conflict.
  - **Default theme:** `#preview-pane-tickets` base background is `var(--panel-bg)` = `#000000` (line 986). With `transparent`, the textarea shows the same pure black — visually identical to before in the default theme, but no longer a separate harsh block. The fix's value is realized in claudify/cyber.
  - **Selector isolation:** `#tickets-detail-content .markdown-editor` only matches the ticket editor. The docs `#markdown-editor` lives inside `#preview-pane`, not `#tickets-detail-content` — no cross-contamination.
  - **Save path** (`btn-save-ticket-edit` handler, line 7729) reads `ticket-edit-description` by ID via `.value` — unaffected by the class/inline-style change. ID preserved.
  - **`exitTicketsEditMode()`** (line 8552) restores the rendered view by re-calling `renderTicketsTab()` — unaffected by the styling change.

## Dependencies
- None. This plan is self-contained.

## Adversarial Synthesis
Key risks: (1) blindly adopting the `.markdown-editor` class silently drops two original UX behaviors — vertical resize and line wrapping — because the class sets `resize:none` and `white-space:pre`; (2) the `transparent` background makes the editor visually indistinguishable from the rendered preview in the default black theme, which could reduce the "I am editing" affordance. Mitigations: re-assert `resize:vertical`, `white-space:pre-wrap`, and `line-height:1.6` inline so only the background/styling is delegated to the class; accept the default-theme blending (it matches the docs editor contract) and rely on the contenteditable title + Save/Cancel buttons as the edit-mode affordance.

## Proposed Changes

### `src/webview/planning.js` — `enterTicketsEditMode()` (line 8529)
Replace the inline-styled textarea with one that uses the shared `.markdown-editor` class, keeping the `ticket-edit-description` ID. Re-assert the three original UX properties (resize, wrapping, line-height) inline so the class swap changes only the background/typography sourcing, not the editing behavior.

**Before (line 8529):**
```js
html += `<textarea id="ticket-edit-description" spellcheck="true" style="width:100%;box-sizing:border-box;outline:none;border:none;padding:16px;min-height:480px;line-height:1.6;font-family:var(--vscode-editor-font-family,monospace);font-size:13px;resize:vertical;background:var(--panel-bg);color:var(--text-primary,#ddd);">${escapeHtml(descMarkdown)}</textarea>`;
```

**After:**
```js
html += `<textarea id="ticket-edit-description" class="markdown-editor" spellcheck="true" style="min-height:480px;height:auto;resize:vertical;white-space:pre-wrap;line-height:1.6;">${escapeHtml(descMarkdown)}</textarea>`;
```

**Why each inline override:**
- `min-height:480px` — preserves the original usable minimum height inside the scrollable detail container (class sets `height:100%`, which would collapse against an auto-height parent).
- `height:auto` — overrides the class's `height:100%` so the textarea sizes to its content and lets comments/attachments flow beneath.
- `resize:vertical` — re-asserts the original resizability (class sets `resize:none`).
- `white-space:pre-wrap` — re-asserts the original line-wrapping behavior (class sets `white-space:pre`, which would force horizontal scrolling on long lines).
- `line-height:1.6` — re-asserts the original readable line spacing (class does not set line-height).

The `.markdown-editor` class (line 2454) now contributes: `width:100%`, `background:var(--panel-bg)` (overridden to `transparent` by the new CSS rule below), `color:var(--text-primary)`, `font-family:var(--font-mono)`, `font-size:13px`, `border:none`, `padding:16px`, `outline:none`, `box-sizing:border-box`, `tab-size:4`.

### `src/webview/planning.html` — base stylesheet, ticket editor background
Add a base (non-theme-scoped) rule so the ticket editor inherits the surrounding pane background in every theme. Place it immediately after the `.markdown-editor` block (~line 2468):

```css
/* Ticket edit textarea blends with the pane background, matching the docs editor */
#tickets-detail-content .markdown-editor {
    background: transparent;
}
```

Using `transparent` (rather than a hardcoded color) lets the editor inherit whatever background the surrounding `#preview-pane-tickets` / `#markdown-preview-tickets` uses in every theme — default black (line 986), claudify `#1C1C1C` (line 2364), cyber glass (line 2246). This mirrors the cyber-theme `.markdown-editor { background: transparent; }` philosophy (line 2354) and makes the editor seamless in all themes. Applying it to the base stylesheet (not just a theme override) ensures it works universally without per-theme duplication.

> **Note:** If `transparent` causes the textarea to look indistinguishable from the rendered preview in the default black theme (reducing the "editing" affordance), an alternative is `background: var(--panel-bg2)` (`#0a0a0a`) for a subtle contrast. Confirm visually during verification. The contenteditable title border + visible Save/Cancel buttons already signal edit mode, so `transparent` is the recommended default.

## Verification Plan

### Automated Tests
None. This is a pure CSS/styling change with no logic change; the textarea ID, value-reading save path, and exit path are structurally unchanged. Automated tests are skipped per session directive.

### Manual Verification
1. Open the Planning panel → Tickets tab.
2. Select a ClickUp ticket with a description; click **Edit**.
   - Confirm the textarea shows raw markdown (unchanged behavior).
   - Confirm the background is **not** a stark pure-black rectangle — it should blend with the surrounding pane.
   - Confirm long lines **wrap** (no horizontal scrollbar) — verifies `white-space:pre-wrap`.
   - Confirm the textarea is **vertically resizable** via the drag handle — verifies `resize:vertical`.
3. Repeat with a Linear issue.
4. Toggle the **claudify** theme (Setup tab) and repeat step 2 — the editor background should match the `#1C1C1C` pane, not pure black.
5. Toggle the **cyber** theme and repeat — the editor should be transparent/seamless over the glass surface.
6. Click **Save** and **Cancel** — confirm both still work (ID preserved, exit path intact, `.value` read correctly).
7. Confirm comments/attachments still render below the textarea when present.
8. In the default (black) theme, confirm the editor is still visually distinguishable as an editing surface (title border + Save/Cancel visible). If not, switch the CSS rule to `background: var(--panel-bg2)`.

## Recommendation
Complexity 3/10 → **Send to Coder**. Contained single-function + single-CSS-rule change, but requires careful preservation of three inline UX overrides (resize, wrapping, line-height) that a naive class swap would silently drop.

## Review Findings
Implementation matches the plan exactly with no deviations. `src/webview/planning.js:8585` uses `class="markdown-editor"` with the three preserved inline overrides (`resize:vertical`, `white-space:pre-wrap`, `line-height:1.6`) plus `min-height:480px;height:auto`; `src/webview/planning.html:2469-2471` adds the `#tickets-detail-content .markdown-editor { background: transparent; }` rule immediately after the base `.markdown-editor` block. Regression audit clean: save handler (`planning.js:7795`) reads `.value` by preserved ID, focus call (`planning.js:8605`) intact, no orphaned references, no race conditions (synchronous `innerHTML` rebuild), no double-trigger, selector isolation confirmed (`#tickets-detail-content` scope does not collide with docs `#preview-pane` editor). No code fixes required. Remaining risk: default black-theme editor may be visually indistinguishable from rendered preview — plan's `var(--panel-bg2)` fallback is available if manual verification flags it; deferred to visual review.
