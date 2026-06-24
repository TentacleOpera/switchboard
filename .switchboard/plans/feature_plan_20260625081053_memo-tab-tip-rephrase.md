# Rephrase Memo Tab Tip to Mention the Natural-Language Chat Trigger

## Goal

Make the Memo sub-tab's helper tip understandable to users who don't already know what "the /memo skill" is.

**Problem.** In the Agents panel's **Memo** sub-tab (`implementation.html`), the second helper line reads:

> Tip: use the /memo skill to start memo capture.

This phrasing is opaque. It assumes the reader knows (a) that "/memo" is a skill/slash-command, (b) that it must be typed into an agent chat, and (c) what "the /memo skill" even is. A user looking at the sidebar Memo tab has no obvious way to connect "use the /memo skill" to an action they can take. The tip therefore fails its only job — telling the user there's a chat-based alternative to the sidebar textarea.

**Root cause.** The copy was written from the implementer's vocabulary (skill/command names) rather than the user's. The Memo capture workflow (`.agents/workflows/memo.md`) is entered in two ways: clicking into this sidebar tab, or instructing an agent in chat to begin capture. The tip is meant to surface the second path, but names the internal mechanism (`/memo` skill) instead of describing the plain-language thing the user can say.

**Fix.** Reword the tip to point at a natural-language phrase the user can speak to an agent:

> Tip: you can also use 'start memo capture' in an agent chat.

This is a pure user-facing copy change in a single static HTML string. The word "also" correctly frames it as an alternative to the sidebar Memo tab the user is already looking at. The memo skill's own description ("Memo capture mode — append-only, no analysis") means an agent that receives "start memo capture" will reasonably load and run the memo workflow, so the suggested phrase is functionally accurate.

## Metadata

- **Tags:** ui-copy, memo, implementation-html, sidebar, trivial
- **Complexity:** 1/10
- **Affected surface:** Memo sub-tab in the Agents panel (sidebar webview)
- **Files touched:** 1 (`src/webview/implementation.html`)

## Complexity Audit

**Routine.** This is a one-line static-text edit to an HTML literal. No JavaScript, event handlers, state, or message-passing is involved — the tip is plain text inside a `<p>` element with no `id` and no script reference. There is no logic change, no new behavior, and nothing that triggers memo capture from the click of this element (it is informational only). Risk is limited to a typo in the replacement string.

## Edge-Case & Dependency Audit

- **Single source of truth.** `grep` across `src/` finds the string `Tip: use the /memo skill to start memo capture.` in exactly one place: `src/webview/implementation.html:1630`. There is no duplicate in `design.html`, `kanban.html`, `project.html`, or any JS file. One edit fully covers the change.
- **`dist/` copy — ignore.** A matching line exists in `dist/webview/implementation.html`, but per project rules `dist/` is a build artifact not used during development or testing and must not be hand-edited or flagged. `npm run compile` regenerates it only when producing a VSIX. No action needed there.
- **No element identity to preserve.** The `<p>` has no `id`, `class` hooks, or selectors targeting its text, so no JS or CSS depends on the literal content. Changing the text cannot break a query or handler.
- **No migration concern.** This is presentational copy in a webview template, not persisted state, settings, or a shipped data format. The Users & Migrations rule does not apply — nothing is read back from this string.
- **Quoting.** The replacement contains single quotes around `start memo capture`. These sit inside an HTML text node (not an attribute value), so no escaping is required and they will render literally. Keep them as plain ASCII apostrophes to match the surrounding copy.
- **Accuracy of the suggested phrase.** "start memo capture" is not a formally registered trigger string (the documented command is `/memo`), but the memo skill's description makes it an unambiguous natural-language request an agent will honor. The tip intentionally offers a human phrase rather than a command token, which is the point of the change. No code enforces or parses this phrase, so there is nothing to keep in sync.

## Proposed Changes

### `src/webview/implementation.html`

Replace the tip text on line 1630 inside the `#agent-list-memo` block.

**Before:**
```html
<p style="font-size: 11px; color: var(--text-secondary); margin: 0 0 4px;">
    Tip: use the /memo skill to start memo capture.
</p>
```

**After:**
```html
<p style="font-size: 11px; color: var(--text-secondary); margin: 0 0 4px;">
    Tip: you can also use 'start memo capture' in an agent chat.
</p>
```

Only the text node changes; the `<p>` element, its inline style, and surrounding markup are untouched.

## Verification Plan

1. **Source check.** Confirm `src/webview/implementation.html:1630` now reads `Tip: you can also use 'start memo capture' in an agent chat.` and that no other line in `src/` still contains `use the /memo skill` (`grep -rn "use the /memo" src/` returns nothing).
2. **Render check (manual, in installed VSIX).** Build/install the VSIX, open the sidebar, click the **Memo** sub-tab under the Agents panel, and confirm the second helper line displays the new wording with the single quotes rendering correctly and no broken markup.
3. **Layout check.** Verify the new (slightly longer) line wraps cleanly within the sidebar width and does not overlap the textarea below it — the `<p>` already has `margin: 0 0 4px` and the container is a vertical flex column, so wrapping is expected to be clean.
4. **No regression.** Confirm the Clear / Copy Prompt / Send to Planner buttons and the memo textarea below are unaffected (they are — no shared selectors), and that the tab still switches normally.
