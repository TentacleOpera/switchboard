# Terminals Layout Picker: 2h/2v Labels Are Inverted and Mis-Ordered

## Goal

Fix the two-pane layout buttons in the Terminals panel toolbar so each label describes the geometry it actually produces, and put the side-by-side option first.

### Problem Analysis & Root Cause

The layout picker in `src/webview/terminals.html` offers six buttons: `1`, `2h`, `2v`, `2x2`, `2x3`, `3x3`. The two two-pane buttons are labelled backwards relative to the grids they render.

The grid CSS is the ground truth (`src/webview/terminals.html:581-582` — line numbers drift under concurrent edit; anchor on the `.pane-grid.layout-2h` / `.layout-2v` rules):

```css
.pane-grid.layout-2h { grid-template-columns: 1fr 1fr; grid-template-rows: 1fr; }
.pane-grid.layout-2v { grid-template-columns: 1fr; grid-template-rows: 1fr 1fr; }
```

- `layout-2h` produces **two columns** — two tall panes side by side, i.e. two *vertical* terminals separated by a vertical split.
- `layout-2v` produces **two rows** — two wide panes stacked, i.e. two *horizontal* terminals separated by a horizontal split.

The button text (`terminals.html:1097-1098`, inside the `.layout-picker` block) reads `2h` for the columns layout and `2v` for the rows layout — exactly inverted from what the user sees. The pane-size floor table agrees with the CSS, not the labels: `'2h'` carries `minW: 400` (it needs *width* because it splits horizontally into columns) and `'2v'` carries `minH: 250` (the `LAYOUTS` table, `src/webview/terminals.js:518-525`). So the geometry, the floor thresholds, and the CSS are all self-consistent; only the two visible strings are wrong.

Ordering is the second half of the complaint: the picker lists `2h` (columns) before `2v` (rows), and the user wants the side-by-side option — the one whose label becomes `2V` after the fix — listed first.

**Root cause:** the button label text was authored against the internal identifier (`2h` = "2 panes, horizontal split axis") rather than against what an operator counts on screen ("two vertical terminals"). Nothing downstream reads the label text, so the defect is confined to two `textContent` strings and their DOM order.

### Why this is a label change, not an identifier rename

`terminals.layoutMode` is a persisted setting (read in `loadLayoutSettings()`, `terminals.js:567`, validated at `:575-578`) holding the raw strings `'2h'` / `'2v'`, and those strings have shipped. Renaming the identifiers would require migrating every persisted value, and would touch `LAYOUTS`, `LAYOUT_FLOOR_ORDER`, `LAYOUT_MODES`, the six `.pane-grid.layout-*` CSS rules, and `src/test/terminal-pane-pinning-contract.test.js` (which references `2h` in prose). A no-op rename that risks resetting every user's saved layout buys nothing. Keep `data-layout="2h"` / `"2v"` as opaque keys, fix the two labels, reorder the buttons, and leave a comment recording that the internal keys name the *split axis* while the labels name the *pane orientation*.

## Metadata

- **Complexity:** 2
- **Tags:** frontend, ui, bugfix
- **Project:** Browser Switchboard
- **Files touched:** `src/webview/terminals.html`
- **Risk:** Very low — two label strings and one DOM reorder. No persisted-state, JS, or CSS behaviour change.

## User Review Required

None. The correct labelling is fully determined by the CSS, and the ordering was specified explicitly.

## Complexity Audit

### Routine
- Swap the visible text of two `<button>` elements.
- Reorder those two buttons so the side-by-side layout is first.
- Add a clarifying comment above the picker.

### Complex / Risky
- Nothing. Deliberately *out of scope*: renaming `2h`/`2v` internally, which would drag in a persisted-setting migration for ~4,000 installs and six CSS rules for zero user-visible gain.

## Edge-Case & Dependency Audit

1. **Persisted layout continuity.** `loadLayoutSettings()` reads `terminals.layoutMode` and validates against `LAYOUT_MODES` (`terminals.js:566-578`). Because `data-layout` values are untouched, a user whose saved value is `'2h'` keeps the exact same grid — it is simply now labelled `2V`. Verify by round-tripping the setting.
2. **Active-class selection.** `setLayoutMode` matches on `btn.getAttribute('data-layout') === mode` (`terminals.js:1134-1136`), never on label text, so the reorder cannot break the highlight. (Sibling plan "The Layout Picker Lies" extracts this toggle into `syncLayoutPickerUI()` — still keyed on `data-layout`, still order-independent.)
3. **Click handler binding.** Handlers are bound by iterating `.layout-picker .btn-layout` and reading `data-layout` (`terminals.js:392-396`). Order-independent.
4. **Pane-size floor.** `LAYOUT_FLOOR_ORDER = ['3x3','2x3','2x2','2h','2v','1']` (`terminals.js:527`) is a degradation sequence over identifiers, not display order. Unchanged — the picker's visual order and the floor's fallback order are independent by design (a narrow window should drop the width-hungry columns layout before the rows layout, which is what this order already does).
5. **Terse-layout initials.**

   > **Superseded:** `isTerseLayout()` shortens *pane action button* labels (`clear`→`c`).
   > **Reason:** Stale at authoring time and still false in the current working tree: `updatePaneElement` sets the pane action buttons to their full words (`clear`/`hide`) unconditionally, and the comment above `isTerseLayout()` (`terminals.js:1667-1669`) states explicitly "Button labels are NOT condensed". What terse layouts actually abbreviate is the input-state chip (to a dot) and the pane header font.
   > **Replaced with:** `isTerseLayout()` (true for `2x3`/`3x3`) only collapses the pane input-state chip to a dot and pairs with the reduced `.pane-header` CSS — it never touches layout-picker labels. No interaction with this change.
6. **Solo mode.** `body.is-solo` forces layout `1` and hides the toolbar; unaffected.
7. **Existing test prose.** `src/test/terminal-pane-pinning-contract.test.js:152` mentions "pin in 3x3, shrink to 2h" in a comment. Identifiers are unchanged, so the test and its comment stay valid.

## Dependencies

- None — no session dependencies and no sibling-plan prerequisite. Lands first within the feature only for merge-hygiene (it rewrites the same picker button block that "The Layout Picker Lies" annotates with a comment); see the feature file's Dependencies & sequencing.

## Adversarial Synthesis

Key risks: the label swap inverting in the wrong direction (mitigated by grounding `2V`/`2H` on the `.pane-grid.layout-2h`/`2v` CSS, the floor table, and a UAT that clicks each button and checks the rendered geometry), and a merge collision with the sibling picker plan on the same button block (mitigated by landing this one first; both edits key on `data-layout`, not label text). No persisted-state, behavioural, or API risk — the change is two strings, a DOM reorder, tooltips, and a comment.

## Proposed Changes

### `src/webview/terminals.html`

Replace the layout-picker button block (currently lines 1095-1101):

```html
<button type="button" class="btn-layout active" data-layout="1">1</button>
<button type="button" class="btn-layout" data-layout="2h">2h</button>
<button type="button" class="btn-layout" data-layout="2v">2v</button>
<button type="button" class="btn-layout" data-layout="2x2">2x2</button>
<button type="button" class="btn-layout" data-layout="2x3">2x3</button>
<button type="button" class="btn-layout" data-layout="3x3">3x3</button>
```

with:

```html
<!-- The `data-layout` keys name the SPLIT AXIS ("2h" = one horizontal split →
     two columns); the labels name what the operator counts on screen ("2V" =
     two vertical terminals). They are deliberately inverted, and the keys are
     load-bearing: `terminals.layoutMode` persists them and .pane-grid.layout-*
     styles them. Change a label freely; never a key. -->
<button type="button" class="btn-layout active" data-layout="1">1</button>
<button type="button" class="btn-layout" data-layout="2h" title="Two vertical terminals, side by side">2V</button>
<button type="button" class="btn-layout" data-layout="2v" title="Two horizontal terminals, stacked">2H</button>
<button type="button" class="btn-layout" data-layout="2x2">2x2</button>
<button type="button" class="btn-layout" data-layout="2x3">2x3</button>
<button type="button" class="btn-layout" data-layout="3x3">3x3</button>
```

Note the `data-layout="2h"` button (columns) now comes first and reads `2V`, satisfying "the 2v should be listed first".

## Verification Plan

> Session directive: no compilation step and no automated test runs as part of this verification. Static review plus manual UAT only.

1. **Static review:** confirm the picker block reads `1  2V  2H  2x2  2x3  3x3` in DOM order, each `data-layout` value is unchanged (`1`, `2h`, `2v`, `2x2`, `2x3`, `3x3`), and `2V` sits on `data-layout="2h"` while `2H` sits on `data-layout="2v"`. Confirm no JS or CSS rule keys on the old `2h`/`2v` label text (the JS keys on `data-layout` throughout — grep `btn-layout` and `data-layout` to prove it).
2. **UAT — labels match geometry.** Open the Terminals panel with two or more terminals running. Click `2V`: the grid must show two panes **side by side**. Click `2H`: two panes **stacked top/bottom**.
3. **UAT — ordering.** Picker reads left-to-right: `1  2V  2H  2x2  2x3  3x3`.
4. **UAT — persistence.** Select `2V`, reload the panel. The same side-by-side grid returns. (Highlight-restore after reload is the sibling plan "The Layout Picker Lies"'s fix — if this plan is UAT'd alone, expect the grid to be correct but the highlight to sit on `1`; that is the known defect the sibling resolves, not a regression from this change.)
5. **UAT — pre-existing saved value.** With `terminals.layoutMode` already equal to `'2h'` from before the change, reload: the grid is side by side (i.e. no user's saved layout silently changed shape); once the sibling sync plan lands, `2V` is highlighted too.
6. **UAT — tooltips.** Hovering each two-pane button shows the orientation sentence.

## Completion Report

Implemented the two-pane label fix in `src/webview/terminals.html`: the `data-layout="2h"` button now reads `2V` with a side-by-side tooltip, the `data-layout="2v"` button reads `2H` with a stacked tooltip, and the side-by-side option is listed first. Added the inverted-key comment explaining that the `data-layout` keys name the split axis while the labels name the pane orientation. No persisted identifiers, CSS rules, or JS selectors were changed. Static review confirms the JS still keys on `data-layout`, and `node --check src/webview/terminals.js` passed.
