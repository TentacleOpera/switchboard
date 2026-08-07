# Add Drag-and-Drop Hint Tooltip to Terminal Kanban Mode Header

> **Superseded design — read this first.** The original plan specified a `⤿` glyph carrying a
> native `title` tooltip in the pane header. That shipped, was reviewed, and was **rejected on
> sight by the user (2026-08-07)**: the glyph rendered as tofu, the `cursor: help` painted a `?`
> under the pointer, and no tooltip ever appeared. Do **not** rebuild it. The sections below
> describe the replacement — an always-visible caption strip — which is what is now in the tree.

## Goal

When a terminal pane is switched to kanban mode, there is no visual indication that the plan cards in the kanban pane can be dragged onto a neighboring terminal pane to dispatch the prompt. The operator discovers this feature only by accident or by reading documentation. The kanban pane must state the drag-to-dispatch path outright, in visible text, without requiring a hover.

### Problem Analysis & Root Cause

**Symptom:** The kanban-mode pane in `terminals.html` shows plan cards with "Copy Prompt" and "link" buttons, and the rows are draggable (`row.draggable = true`). But nothing on screen says so. The feature is invisible to anyone who doesn't already know about it.

**Root Cause:** `renderKanbanPane` in `terminals.js` builds the pane header (pane-index chip, workspace/project picker, column picker, mode-toggle button) and the pane body (`.kanban-pane-list` of rows, or a "No plans in {column}" empty state). Neither carries any statement of the drag affordance.

### Why the first implementation failed

Four compounding defects, all of them invisible to the gates that passed it:

1. **The glyph cannot render.** `⤿` is U+293F. The panel pins `--font-family: 'Hanken Grotesk', Menlo, Consolas, sans-serif` (`terminals.html:33`); none of those faces carry that block, and the bundled `@font-face` suppresses OS symbol fallback. Result: tofu.
2. **`cursor: help`** painted a macOS `?` cursor over the tofu, so the only feedback on hover was a question mark.
3. **A native `title=` attribute is not a tooltip on this surface.** The entire "tooltip" was `hintEl.title = '…'` on an 11px span plus a duplicate on `.pane-header`. Nothing rendered it. The requested hint text existed only as an unread attribute — i.e. the deliverable was never actually built.
4. **Placement.** It went inside `.pane-title`, an `overflow: hidden` flex row already holding a chip and two `<select>` pickers — the most cramped strip in the pane.

The review pass signed this off on inspection while explicitly recording that it had *not* verified any of it: *"`⤿` glyph rendering across browser/OS combos not verified. Manual visual verification (steps 1-10) not run."*

**Design rule this establishes:** in Switchboard webviews, use codicons, the masked-SVG icon pattern, or plain text — never a decorative Unicode symbol. And never implement a hint as a bare `title=`. If it must be visible, render visible text; if it must be hover-only, use the body-level tooltip overlay (`kanban.html`, commit `e00c532d`).

## Metadata

**Complexity:** 2
**Tags:** frontend, ui, feature
**Project:** Browser Switchboard

## User Review Required

No — the form was chosen by the user on 2026-08-07 (always-visible caption strip, over a hover tooltip on the cards, over both, over deletion). Wording and placement settled. Proceed directly to implementation.

## Complexity Audit (Routine vs Complex/Risky)

### Routine
- Creating the hint `<div>` and its CSS rule is a handful of lines in the body-render path of `renderKanbanPane`.
- No backend changes, no state management, no event handling. The strip is static text.
- The body-render path is signature-gated (`bodySig`), so the strip is rebuilt only when the card set actually changes — not on every 5s poll tick.

### Complex / Risky
- **The list is the scroll container.** `.kanban-pane-list` was `height: 100%; overflow-y: auto`. Adding a sibling strip above it inside `.pane-content` would push the list's bottom past the pane, and `.terminal-pane`'s `overflow: hidden` would silently eat the last row. This is the one part that is not a drop-in.
- **Mode-switch cleanup.** Any new element in the kanban body must be torn down when the pane flips back to terminal mode, or it strands. This is the exact failure the previous review caught on `headerEl.title`.

## Edge-Case & Dependency Audit

**Scroll containment:** the strip and the list are wrapped in `.kanban-pane-body` (`height: 100%; min-height: 0; display: flex; flex-direction: column`). The strip is `flex-shrink: 0`; the list becomes `flex: 1; min-height: 0`. Without `min-height: 0` the flex item refuses to shrink below its content height and the pane scrolls instead of the list.

**Mode-switch teardown:** `updatePaneElement`'s stale-kanban sweep must remove `.kanban-pane-body`, not just `.kanban-pane-list` — removing the wrapper takes the list and strip with it.

**Dense layouts (2x3, 3x3):** the strip costs one ~16px row. It is `white-space: nowrap; overflow: hidden; text-overflow: ellipsis`, so a narrow pane truncates the sentence rather than wrapping onto a second row and doubling the cost.

**Empty and loading states:** the strip renders only on the populated-list path. "Loading…" and "No plans in {column}" return before the wrapper is built — there is nothing to drag in either state, so the hint would be noise.

**Theme compatibility:** `var(--text-secondary)` and `var(--border-color)`, matching the surrounding header chrome. No theme-specific overrides.

**Font safety:** plain Latin text only. No glyph, no icon font, no Unicode symbol — see the design rule above.

## Dependencies

None. Independent of the other subtasks in this feature. Most valuable alongside the drag-drop correctness fix — the strip advertises a path that fix makes reliable.

## Adversarial Synthesis

The real risk here was never the CSS; it was shipping something that looks done and teaches nothing. The first attempt cleared eight gates while being completely invisible, because every gate checked that code existed rather than that a human could see it. The mitigation is structural, not procedural: visible text has no rendering precondition — no font coverage, no hover, no platform tooltip delay, no `title` support. It either paints or the pane is blank.

Residual risks: (1) one row of vertical space per kanban pane, accepted by the user when choosing this form; (2) in the very narrowest 3x3 pane the sentence ellipsizes early — degradation, not failure.

## Proposed Changes

### File 1: `src/webview/terminals.js`

**1a. Delete the failed hint.** Remove the `headerEl.title = '…'` assignment at the top of `renderKanbanPane`, the `.kanban-pane-drag-hint` span (`⤿` glyph + `title`) from the header rebuild block, and the compensating `headerEl.title = ''` clear in `updatePaneElement`.

**1b. Wrap the body and add the strip.** In the populated-list path of `renderKanbanPane`, before building the list:

```js
const body = document.createElement('div');
body.className = 'kanban-pane-body';

const hint = document.createElement('div');
hint.className = 'kanban-pane-hint';
hint.textContent = 'Drag a card onto a terminal pane to dispatch it';
body.appendChild(hint);

const list = document.createElement('div');
list.className = 'kanban-pane-list';
// … rows …
body.appendChild(list);
contentEl.appendChild(body);
```

**1c. Extend the mode-switch teardown** in `updatePaneElement`:

```js
const staleKanban = contentEl.querySelectorAll('.kanban-pane-body, .kanban-pane-list, .kanban-pane-empty');
```

### File 2: `src/webview/terminals.html`

Delete the `.kanban-pane-drag-hint` rules. Add the wrapper and strip, and re-base the list off flex:

```css
.kanban-pane-body { height: 100%; min-height: 0; display: flex; flex-direction: column; }
.kanban-pane-hint {
    flex-shrink: 0;
    padding: 4px 6px;
    font-size: 10px;
    line-height: 1.3;
    color: var(--text-secondary);
    border-bottom: 1px solid var(--border-color);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}
.kanban-pane-list { overflow-y: auto; flex: 1; min-height: 0; padding: 4px; display: flex; flex-direction: column; gap: 4px; }
```

## Verification Plan

### Automated Tests

None. This is a CSS/DOM display change with no logic to assert on; no existing test references any `.kanban-pane-*` class. `node --check src/webview/terminals.js` for syntax.

### Manual Verification

**Precondition — the change is not live until it is packaged.** `/static/webview/*` resolves `extensionUri/dist/webview` **before** `src/webview` (`TaskViewerProvider.ts:2385`, `repoRoot = this._context.extensionUri.fsPath`), so the cockpit serves the installed VSIX's copy, never the working tree. Run `npm run compile` and reinstall before verifying, and hard-reload the tab.

1. Open the browser cockpit and switch an empty pane to kanban mode on a column that has plans.
2. **Verify:** a dim one-line strip sits directly under the pane header reading "Drag a card onto a terminal pane to dispatch it", with a hairline border below it, above the first card.
3. **Verify:** no `⤿`, no tofu box, no `?` cursor anywhere in the pane header.
4. **Scroll the card list.** Verify the list scrolls inside its own box, the strip stays put, and the last card is fully reachable (not clipped by the pane edge).
5. **Switch the pane's column to an empty one.** Verify the strip disappears along with the list, leaving only "No plans in {column}".
6. **Switch the pane back to terminal mode.** Verify no strip, no border, and no leftover hint text in the pane.
7. **Set the layout to 3x3.** Verify the strip ellipsizes on one line and never wraps to two.
8. **Drag a card onto a terminal pane** and confirm the dispatch the strip advertises actually fires.

## Review Findings

**2026-08-07 — redesign after user rejection.** The originally-shipped `⤿`-glyph-plus-`title` implementation was rejected in UAT: invisible glyph, `?` cursor, no tooltip. Root cause recorded under "Why the first implementation failed" above. Replaced with the always-visible caption strip specified here, per the user's choice among four presented forms.

Implemented and verified so far: the failed hint is fully removed (glyph, CSS, both `title` assignments, and the mode-switch clear that existed only to clean up after it); the strip and `.kanban-pane-body` wrapper are in place; `.kanban-pane-body` added to the stale-kanban teardown selector; `node --check` clean; no test references the touched classes.

**Not yet run:** `npm run compile`, VSIX reinstall, and manual steps 1-8. The strip is in `src/` only — by the precondition above, it is not visible in any running cockpit until packaged. Flagged explicitly because the previous pass on this plan closed with unverified manual steps and shipped a defect.
