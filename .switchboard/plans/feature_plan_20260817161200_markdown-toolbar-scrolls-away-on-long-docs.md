# Markdown editor toolbar scrolls out of reach on long docs and tickets

## Goal

Make the shared markdown editing toolbar stay pinned to the top of the visible editing area while the operator scrolls a long document or ticket, so Bold/H2/list/table/view-mode controls are reachable from anywhere in the file instead of only from the very top.

### Problem

Editing a long doc (Planning → Docs) or a long ticket description (Tickets tab) puts the formatting toolbar hundreds or thousands of pixels above the caret. To bold a word 400 lines down, the operator scrolls all the way up, clicks the button — which re-focuses the textarea and jumps the view back — and then scrolls back down. The toolbar is effectively unusable on exactly the documents that need formatting help most.

### Root cause

Two independent facts compose into the bug, both in `src/webview/markdownEditor.js` (the single shared editor used by all six attach sites):

1. **The editor shell grows to the full height of the document instead of filling a fixed viewport.**
   `.md-editor-shell` is `display:flex; flex-direction:column` with `min-height: 480px` and **no definite height** — the host panels never give it one. Its child `.md-body` is `flex: 1` in that auto-height column, so its used height falls back to the min-content height of its own children. One of those children is `.md-live-preview`, whose `height: 100%` resolves against an indefinite parent height and therefore degrades to `auto` — i.e. the full rendered height of the document. The preview's own `overflow-y: auto` never engages because there is no definite height to overflow. Net effect: `.md-body` — and therefore the whole shell — is as tall as the rendered markdown. The `<textarea>` (`height: auto`, cross-axis `stretch`) is dragged to the same height, so it never scrolls internally either. Scrolling is done by the *host* scroll container, and the toolbar, being a static block at the top of the shell, rides off the top of the screen.

   Confirmed scroll containers per surface:
   - Planning → Docs: `#preview-pane` (`overflow-y: auto; height: 100%`, `planning.html:1025`)
   - Tickets: `#markdown-preview-tickets` (`flex: 1; overflow-y: auto`, `tickets.html:1099`) inside `.preview-content-wrapper`
   - Project panel tabs: `.constitution-preview-pane` / `.tuning-preview-pane` (`overflow-y: auto`, `project.html:226`)

2. **`position: sticky` on the toolbar would currently be inert, because the shell is `overflow: hidden`.**
   `.md-editor-shell` sets `overflow: hidden` (`markdownEditor.js:19`) purely to clip the `border-radius: 6px` corners. `overflow: hidden` makes an element a scroll container, and a sticky descendant resolves its offsets against the **nearest scroll container ancestor** — which would be the shell itself. The shell's own scrollTop is permanently 0, so a sticky toolbar would simply sit at the shell's top and scroll away exactly as it does today. This is why the fix is two lines, not one: the `overflow: hidden` has to go, with the corner clipping re-expressed on the two children that actually paint the corners.

The default view mode is `split` (`markdownEditor.js:218`), which is why nearly every editing session hits this. In `view-edit` mode the preview is `display: none`, the shell collapses to its 480px floor, and the textarea scrolls internally — which is why the toolbar appears to behave in that one mode and masked the bug.

This is a CSS-only defect in one shared file. All six attach sites (`planning.js:6281`, `planning.js:7631`, `tickets.js:3092`, `project.js:3107`, `design.js:1881`) and both hosts (VS Code webviews and the standalone browser cockpit via `headlessPanelHtml.ts`) load the same `markdownEditor.js`, so a single fix covers every surface.

## Metadata

- **Complexity:** 2
- **Tags:** frontend, ui, bugfix
- **Project:** Browser Switchboard

## Complexity Audit (Routine vs Complex/Risky)

**Routine.** One file, CSS only, no JavaScript, no state, no persistence, no host round-trips, no migration surface.

- `.md-toolbar` gains `position: sticky; top: 0; z-index: 5` plus top-corner radii.
- `.md-editor-shell` drops `overflow: hidden`.
- `.md-body` gains the bottom-corner radii the shell used to clip (it already has `overflow: hidden`, so this is a one-property addition).

**The one non-obvious bit** is why removing `overflow: hidden` is required rather than optional — see root cause #2. A reviewer who deletes only the sticky line, or only the overflow line, will produce a change that looks correct in the diff and does nothing in the product.

**Not risky because:**
- Removing `overflow: hidden` from a `display: flex` element does not change layout: the flex formatting context already prevents margin collapse and float intrusion, which are the only other things `overflow: hidden` was buying here. Its sole live purpose was corner clipping, which is re-homed.
- `.md-body` keeps its `overflow: hidden`, so the bottom corners clip exactly as before.
- `position: sticky` is fully supported in the Chromium that backs both VS Code webviews and the browser cockpit.

**Explicitly out of scope:** giving the shell a definite height so the textarea and preview scroll independently. That is a real second problem (the whole editor is one tall page today), but it requires every host container to hand the shell a bounded height and would change scroll behaviour on five panels. The reported complaint is the toolbar; this plan fixes the toolbar and leaves the one-tall-page scroll model exactly as it is.

## Edge-Case & Dependency Audit

| Case | Behaviour after the change |
| :--- | :--- |
| **Short doc (shell fits in the viewport)** | No scrolling, so sticky never engages. Rendering is byte-identical to today. |
| **`view-edit` mode** | Shell collapses to its 480px floor and the textarea scrolls internally. Toolbar was already visible; sticky is a no-op. No regression. |
| **`view-preview` mode** | Shell is as tall as the rendered preview. Toolbar now sticks — a strict improvement (the Split/Edit/Preview switcher lives in the toolbar, so today you must scroll up just to switch back out of preview). |
| **Content scrolling *under* the toolbar** | `.md-toolbar` already paints an opaque `var(--panel-bg2, #0a0a0a)` background, so text does not bleed through. No new background needed. |
| **Table picker popover** | `.md-table-popover` is `position: absolute` inside `.md-table-picker-container` (`position: relative`) inside the toolbar, so it travels with the sticky toolbar and stays anchored to its button. It previously risked being clipped by the shell's `overflow: hidden` when opened; removing that clip is a second small win. Its `z-index: 1000` is inside the toolbar's new stacking context, so it still paints above the editor body. |
| **Tickets: `#markdown-preview-tickets` and `.preview-content-wrapper` are both `overflow-y: auto`** | Sticky binds to whichever actually scrolls (the nearest scroll-container ancestor). Both have `top` padding above the shell, not a sticky header, so `top: 0` lands the toolbar flush at the top of the scrollport either way. |
| **Tickets: content below the editor (Comments, Attachments)** | When the operator scrolls past the end of the shell, the toolbar un-sticks at the shell's bottom edge and scrolls away with it — correct, since there is nothing left to format. |
| **`.preview-panel-wrapper` is `position: relative; overflow: hidden`** (`planning.html:2484`) | It is an ancestor of the scrollport, not between the toolbar and the scrollport, so it does not capture the sticky. Verified. |
| **Cyber/Claudify themes and the scanline overlay** | Themes only re-colour `#preview-pane` / `.markdown-editor`; `.cyber-scanlines` is a sibling of the pane, not an ancestor of the toolbar. Neither participates in sticky resolution. |
| **`@media (max-width: 640px)`** | Only flips `.md-body` to column. Toolbar sticking is orthogonal. |
| **Standalone browser cockpit** | `headlessPanelHtml.ts` serves the same `markdownEditor.js` from `/static/webview/`. Fix lands there with no separate change. |
| **Design panel (`design.js:1881`)** | Its textarea carries inline `height: 100%`, which resolves to `auto` against the indefinite shell exactly like the CSS default. Same shell, same fix, no special-casing. |

**Dependencies:** none. No new files, no host-message contract, no schema, no dependency on the extension API server. `src/webview/*.js` is copied verbatim to `dist/webview/` by the `CopyPlugin` pattern at `webpack.config.js:86`, so no build-config change either.

## Proposed Changes

### `src/webview/markdownEditor.js`

All three edits are inside the injected `md-editor-styles` stylesheet at the top of the IIFE.

**1. Drop `overflow: hidden` from `.md-editor-shell` (line ~19).** This is the change that makes sticky work at all; the comment records why so nobody restores it.

```js
            .md-editor-shell {
                display: none;
                flex-direction: column;
                border: 1px solid var(--border-color, #30363d);
                /* Editing surface, NOT the panel surface. ...existing comment unchanged... */
                background: var(--md-editor-bg, #1a1a1a);
                border-radius: 6px;
                /* Deliberately NOT overflow:hidden. That made the shell its own
                   scroll container, which is what `position: sticky` resolves
                   against — so a sticky .md-toolbar would pin to the shell's own
                   (never-scrolled) top and ride off screen with it, exactly the
                   bug this replaced. Corner clipping moved to .md-toolbar's top
                   radii and .md-body's bottom radii. */
                width: 100%;
                min-height: 480px;
                box-sizing: border-box;
            }
```

**2. Make `.md-toolbar` sticky and give it the top corners (line ~27).**

```js
            .md-toolbar {
                display: flex;
                flex-wrap: wrap;
                align-items: center;
                gap: 4px;
                padding: 6px;
                background: var(--panel-bg2, #0a0a0a);
                border-bottom: 1px solid var(--border-color, #30363d);
                user-select: none;
                /* The shell is auto-height and grows to the full rendered doc, so
                   the HOST pane is the scroller. Sticky keeps the toolbar in reach
                   from anywhere in a long doc/ticket. The background above is
                   already opaque, so content scrolls under it cleanly. */
                position: sticky;
                top: 0;
                z-index: 5;
                border-radius: 5px 5px 0 0;
            }
```

`5px` (not `6px`) because the shell's `border-radius: 6px` is measured on the outside of its 1px border; the toolbar sits inside that border.

**3. Give `.md-body` the bottom corners the shell used to clip (line ~85).** It already has `overflow: hidden`, so this is one added property and no behavioural change.

```js
            .md-body {
                display: flex;
                flex: 1;
                position: relative;
                overflow: hidden;
                width: 100%;
                box-sizing: border-box;
                /* Bottom-corner clipping, moved off .md-editor-shell — see the
                   comment there. Safe to keep overflow:hidden here: the sticky
                   toolbar is a SIBLING of .md-body, not a descendant. */
                border-radius: 0 0 5px 5px;
            }
```

No other file changes. No JavaScript changes.

## Verification Plan

Build a VSIX from the change and test against the installed extension (`dist/` in the repo is not used for testing).

**A. Reproduce first (pre-fix baseline).**
1. Planning panel → Docs → open a document of at least ~300 lines → click Edit.
2. Scroll to the bottom of the editor. Confirm the toolbar is gone from view — this is the bug.

**B. Docs — the primary fix.**
3. Apply the change, rebuild, reload. Repeat step 1–2: the toolbar must stay pinned at the top of `#preview-pane` for the entire scroll, all the way to the last line.
4. Select a word near the bottom, click **B** in the pinned toolbar → `**word**` appears in place, and the live preview updates. The click must not scroll the view back to the top.
5. Click the **⊞** table button while scrolled to the bottom → the 5×5 picker opens directly under the button, is not clipped, and inserting a table lands the skeleton at the caret.
6. Toggle **Split → Preview → Edit** from the pinned toolbar mid-document; each switch must work without scrolling up.

**C. Tickets — the second reported surface.**
7. Tickets tab → open a ticket with a long description (or paste ~300 lines in) → Edit.
8. Scroll down through the description: toolbar stays pinned to the top of `#markdown-preview-tickets`.
9. Keep scrolling past the end of the editor into **Comments** / **Attachments**: the toolbar un-sticks with the shell and scrolls away. That is the expected end state, not a regression.
10. Apply a heading and a checkbox list from the pinned toolbar, Save, and confirm the ticket description round-trips to the provider unchanged in shape.

**D. No-regression sweep across the other attach sites.**
11. Project panel → Constitution (or System / Tuning) tab → Edit: toolbar pinned inside `.constitution-preview-pane`; short docs render exactly as before.
12. Design panel → open a markdown design doc → Edit: no layout shift versus pre-fix; toolbar pinned.
13. Short doc that fits entirely on screen (all panels): confirm the editor is visually identical to pre-fix — same 6px rounded frame, no square corners at top-left/top-right (toolbar radii) or bottom-left/bottom-right (`.md-body` radii), no double border, no gap between toolbar and body.
14. `view-edit` mode on a long doc: shell still collapses to its 480px floor, the textarea still scrolls internally, toolbar still visible. Unchanged from pre-fix.
15. Narrow the panel below 640px: `.md-body` still stacks to column, toolbar still pinned.

**E. Standalone browser cockpit.**
16. Open the Docs and Tickets panels in the browser cockpit (served from `/static/webview/markdownEditor.js`) and repeat steps 3 and 8. Behaviour must match the VS Code webviews — same file, same CSS.

**Regression risk if a reviewer trims the diff:** dropping edit #1 (keeping `overflow: hidden` on the shell) makes edits #2 and #3 completely inert while still looking like a fix in review. Step B/3 is the gate that catches it.
