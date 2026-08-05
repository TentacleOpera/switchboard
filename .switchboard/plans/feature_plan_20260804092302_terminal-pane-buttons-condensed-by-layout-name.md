# Terminal pane buttons condensed to single letters by layout name, not by actual width

## Goal

In the Terminals view, when a multi-pane layout like 2x3 (6 panes) or 3x3 (9 panes) is selected, the per-pane `clear` and `hide` action buttons collapse to the single letters `c` and `h`. The user reports there is "heaps of room" — the condensation fires even on wide monitors where the full words fit easily. This is a UX regression: the buttons become ambiguous (c vs h are not self-explanatory) and the condensation is driven by the layout name, not by any measurement of available header width.

### Problem Analysis & Root Cause

The pane header is a flex row (`justify-content: space-between`) with two children:
- `.pane-title` — flex, with `overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0` (already designed to truncate gracefully when space is tight).
- `.pane-actions` — `flex-shrink: 0` (holds the buttons, designed to keep its full width).

This layout already has the correct overflow behavior: when the header is genuinely too narrow, the **title ellipsizes** while the buttons keep their full labels. The infrastructure for graceful degradation is already in place.

The bug is a **premature, layout-name-based shortcut** that bypasses this mechanism. It is still live at HEAD, but the code structure around it changed in `30d82f8`:

> **Superseded:** "`src/webview/terminals.js:1225` — `const terse = effectiveLayout === '2x3' || effectiveLayout === '3x3';` hardcodes the condensation at button creation time (lines 1222-1235), with `withClearingFeedback` at 1746-1755."
> **Reason:** `30d82f8` replaced per-render button creation with a reconcile model. Buttons are now created ONCE in `createPaneElement` (`terminals.js:1380-1457`) and re-labeled on every pass by `updatePaneElement` (`:1471`); the create-time ternaries at old lines 1222-1235 no longer exist, and the condensation was centralized into a helper.
> **Replaced with:** The condensation now lives in **`isTerseLayout()` (`terminals.js:1461-1463`)** — `return effectiveLayout === '2x3' || effectiveLayout === '3x3';` — with FIVE call sites:
> 1. `:1540-1541` — `updatePaneElement` sets `clearBtn.textContent = terse ? 'c' : 'clear'` and `hideBtn.textContent = terse ? 'h' : 'hide'` on every reconcile.
> 2. `:1549` — the pin button (added after this plan was first written) gets `terse ? (isPinned ? 'u' : 'p') : (isPinned ? 'unpin' : 'pin')`.
> 3. `:1427` — the clear button's click handler computes `const label = isTerseLayout() ? 'c' : 'clear';` at click time for `withClearingFeedback`.
> 4. `:1525` — the input-state chip: `stateEl.textContent = terse ? '' : state.label;` (dot-only in dense layouts).
> 5. `:1261-1262` — `refreshInputState` duplicates the check as `terseHeader` for the same chip.

The CSS side also moved, to `src/webview/terminals.html`:
- **`:730-733`** — `.pane-grid.layout-2x3 .btn-unassign-pane, .pane-grid.layout-3x3 .btn-unassign-pane { padding: 2px 4px; }` — the button shrink, justified by the same false "headers are too narrow" assertion. **Remove.**
- **`:580-583`** — header padding/font density shrink for 2x3/3x3. **Keep** — a reasonable density tweak that does not affect label text.
- **`:585-588`** — title ellipsis rules for 2x3/3x3. **Keep** — the correct overflow mechanism, still needed on narrow viewports.
- **`:692-694`** — input-state chip styling for 2x3/3x3. **Keep** — the chip is out of scope (see User Review Required).

**Root cause (unchanged):** The condensation is keyed on layout name (`'2x3'` / `'3x3'`) rather than on measured available width. The existing flex + ellipsis CSS already handles true overflow correctly — the `isTerseLayout()` flag is redundant for buttons and fires far too aggressively.

**`withClearingFeedback` (`terminals.js:2238-2247`)** — now reads `btn.textContent = restoreLabel.length <= 1 ? '…' : 'clearing';`. Once the button labels are always `'clear'`, the restore label is always length 5, so the transient state shows the full word `'clearing'` for 600ms — the intended treatment.

## Metadata

**Tags:** frontend, ui, ux, bugfix

**Complexity:** 3

**Project:** Browser Switchboard

## User Review Required

- **Scope decision — the input-state chip KEEPS its dense-layout dot-only mode.** Call sites 4 and 5 above are untouched: the chip sits *inside* the ellipsizing `.pane-title`, where its text competes directly with the terminal name (unlike the buttons, which are shielded by `flex-shrink: 0`). The colored dot plus `title` attribute carries the meaning. Veto this if you want the chip de-condensed too — that would widen the diff to `stateEl`/`refreshInputState` and the `:692-694` CSS.
- **No width measurement is added.** The fix trusts the existing flex degradation order (title ellipsizes first, buttons keep full labels) rather than measuring header width. True measured condensation was considered and rejected as machinery for a problem the user reports does not exist.

## Complexity Audit

### Routine
- Delete one helper usage pattern: collapse three button-label ternaries (`:1427`, `:1540-1541`, `:1549`) to constant full labels.
- Remove one CSS rule block (`terminals.html:730-733`).
- Keep `isTerseLayout()` (or rename it for clarity) solely for the chip call sites, and fix its misleading comment at `:1460`.

### Complex / Risky
- None beyond the visual: on genuinely narrow viewports the degradation order changes from "buttons shrink to initials" to "title ellipsizes to near-zero while buttons stay readable" — which is the designed behavior of the flex rules already in place.

No new logic, no state changes, no backend involvement, no migrations.

## Edge-Case & Dependency Audit

- **Narrow viewports / small webview panels:** With terse labels removed, `.pane-title` (`min-width: 0` + ellipsis) truncates first while `.pane-actions` (`flex-shrink: 0`) keeps the full `clear`/`hide` labels — the title is reduced to near-zero before the buttons are ever crowded. The `:585-588` title-ellipsis CSS is retained, so narrow-viewport truncation still works.
- **`withClearingFeedback` transient label:** Restore label becomes constant `'clear'` (length 5 > 1), so `:2241` shows `'clearing'` during the 600ms feedback window — the intended full-word path. The `hide` and pin buttons pass no restore label and are unaffected.
- **Pin button (`:1549`):** New since this plan was first written. It condenses to `p`/`u` under the same flag and is equally ambiguous — it gets full `pin`/`unpin` labels under this fix. Its `aria-pressed` state and `is-pinned` class are unchanged.
- **Layout demotion reconcile:** `updatePaneElement` re-derives labels every pass precisely so a 2x3 pane demoted to `2h` loses its initials. With constant labels this reconcile becomes a no-op assignment — harmless and keeps the code honest if labels ever become dynamic again.
- **No existing tests reference the terse labels:** A grep across `src/test/*terminal*` for `terse`, `'c'`, `'h'`, `btn-unassign` returned no matches. The condensation is untested; removing it breaks no contracts.
- **Sidebar list buttons:** The sidebar's per-terminal `clear` button already always uses the full `'clear'` label. This plan aligns the pane-grid buttons with the sidebar — consistency win.
- **Toolbar layout buttons:** Unrelated; the `2x3`/`3x3` toolbar buttons keep their labels.

## Dependencies

- No cross-session dependencies (`sess_…`): none recorded.
- **Sibling subtask (same feature):** *Terminal vertical scrollbar goes missing, especially in single/solo view mode* also edits `src/webview/terminals.js`. Per the PRD's one-agent-stream-per-file discipline, the two must land SERIALLY. This plan lands FIRST (mechanical, low blast radius), the scrollbar plan second. The surfaces are disjoint (header labels/CSS block vs fit ladder/viewport), so a rebase between them should be conflict-free.

## Adversarial Synthesis

Key risks: the plan's original line references were stale (fixed by the rewrite against HEAD), and widening scope to the input-state chip would conflate two different space economies. Mitigations: every call site and CSS line above was re-verified against `30d82f8`; chip scope is quarantined behind a User Review gate; narrow-viewport behavior rests on pre-existing flex rules, checked manually rather than assumed.

## Proposed Changes

### `src/webview/terminals.js` — buttons always full labels; chip keeps dense mode

**1. Clear/hide labels in `updatePaneElement` (`:1540-1541`):**

```js
// BEFORE
clearBtn.textContent = terse ? 'c' : 'clear';
hideBtn.textContent = terse ? 'h' : 'hide';

// AFTER — the pane-title flexes and ellipsizes when the header is genuinely
// narrow, so the buttons keep their full labels at every layout (same words
// the sidebar uses).
clearBtn.textContent = 'clear';
hideBtn.textContent = 'hide';
```

**2. Pin label (`:1549`):**

```js
// BEFORE
pinBtn.textContent = terse ? (isPinned ? 'u' : 'p') : (isPinned ? 'unpin' : 'pin');

// AFTER
pinBtn.textContent = isPinned ? 'unpin' : 'pin';
```

**3. Click-time restore label (`:1427`):**

```js
// BEFORE
const label = isTerseLayout() ? 'c' : 'clear';
withClearingFeedback(paneClearBtn, () => clearTerminal(targetName), label);

// AFTER
withClearingFeedback(paneClearBtn, () => clearTerminal(targetName), 'clear');
```

**4. `isTerseLayout()` (`:1460-1463`)** — keep the helper for the two chip call sites (`:1525`, `:1261`) but fix the comment, which falsely generalizes:

```js
// BEFORE
/** The 6- and 9-pane headers cannot fit the two-word button labels. */

// AFTER
/** Dense 6-/9-pane headers: the input-state chip (inside the ellipsizing
 *  title) collapses to a dot there. Button labels are NOT condensed — the
 *  title ellipsizes first by flex design. */
```

Optionally rename it `isDenseHeaderLayout()` at both call sites for honesty; not required.

**5. `terse` local in `updatePaneElement` (`:1486`)** — still needed by the chip line (`:1525`); keep it. If the rename in (4) is taken, it reads `const denseHeader = isDenseHeaderLayout();`.

### `src/webview/terminals.html` — remove the button-shrink block only

Remove `:730-733`:

```css
/* REMOVE — the pane-title ellipsizes when narrow; buttons keep full labels. */
.pane-grid.layout-2x3 .btn-unassign-pane,
.pane-grid.layout-3x3 .btn-unassign-pane {
    padding: 2px 4px;
}
```

**Keep** `:580-583` (header density), `:585-588` (title ellipsis), `:692-694` (chip styling) — all still load-bearing.

## Verification Plan

*Session directive: no project compilation and no automated tests. Verification is manual plus a syntax check.*

1. **Syntax check:** `node --check src/webview/terminals.js` passes.
2. **Manual — 2x3 layout on a wide window:**
   - Open the Terminals view, assign terminals to panes, select the `2x3` layout.
   - Confirm each pane header shows full `pin`/`unpin`, `clear` and `hide` labels (not `p`/`u`/`c`/`h`).
   - Confirm a long terminal name in a pane title ellipsizes (trailing `…`) rather than the buttons shrinking.
3. **Manual — 3x3 layout on a wide window:** Same checks as above for `3x3`.
4. **Manual — narrow viewport regression check:** Narrow the panel sharply in `2x3`/`3x3`. Confirm the title ellipsizes first and the buttons remain fully labeled until the header is too narrow for even the title — correct degradation order.
5. **Manual — clearing feedback:** Click `clear` on a pane button in `2x3`. Confirm the label changes to `clearing` for ~600ms then reverts to `clear`.
6. **Manual — chip retained:** In `2x3`/`3x3`, confirm the input-state chip still renders dot-only with its `title` tooltip, and still shows its word label in `1`/`2h`/`2x2` layouts.
7. **Repeat in the standalone browser host** (`npx switchboard`) — both hosts serve the same panel HTML, so one pass each is enough.

## Completion Summary

Removed the layout-name-keyed `isTerseLayout()` button condensation: `clear`/`hide`/`pin`/`unpin` labels are now constant in `updatePaneElement` (terminals.js), the click-time restore label in `createPaneElement`'s clear handler passes `'clear'` directly, and the now-unused `terse` local was dropped. `isTerseLayout()` is retained solely for the input-state chip (via `syncInputStateChip`) with a corrected doc comment. Removed the matching `.pane-grid.layout-2x3/3x3 .btn-unassign-pane { padding: 2px 4px }` CSS block from terminals.html; the header-density, title-ellipsis, and chip CSS blocks were kept. The plan's line references were stale (code moved past `30d82f8`); actual call sites were re-verified at HEAD before editing. `node --check src/webview/terminals.js` passes. No issues encountered.
