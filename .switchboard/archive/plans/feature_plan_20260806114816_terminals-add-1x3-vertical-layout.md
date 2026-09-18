# Add 1x3 Terminal Layout (3 Panes Stacked Vertically)

## Goal

Add a new terminal grid layout option that arranges 3 terminal panes in a single column (1 column, 3 rows). This extends the existing layout picker with a "1x3" option, giving operators a way to monitor three terminals stacked vertically — a natural extension of the existing `2v` (2 stacked) layout for users who need to watch one more terminal without jumping to the 6-pane `2x3` grid.

### Problem Analysis & Root Cause

**Symptom:** The layout picker in `terminals.html` offers 6 layouts: `1`, `2h` (2 side-by-side), `2v` (2 stacked), `2x2` (4 panes), `2x3` (6 panes), and `3x3` (9 panes). There is no option for exactly 3 panes stacked vertically. An operator who wants to watch 3 terminals must either use `2x2` (which wastes the 4th pane or leaves it empty) or `2x3` (which shows 6 panes in a dense grid, making each pane small).

**Root Cause:** This is a missing feature, not a bug. The layout system is designed to be extensible — the `LAYOUTS` object in `terminals.js` (line 620) maps layout keys to `{ slots, minW, minH }` specs, and the CSS in `terminals.html` maps layout keys to `grid-template-*` rules. Adding a new layout requires touching three places: the `LAYOUTS` object, the CSS grid template, and the layout picker button. The `LAYOUT_FLOOR_ORDER` array (line 629) must also be updated so the floor logic can demote the new layout when the window is too short.

## Metadata

**Complexity:** 3
**Tags:** frontend, ui, feature
**Project:** Browser Switchboard

## User Review Required

No — this is a purely additive feature following an established pattern in the codebase. The `1x3` layout key, CSS rule, and picker button all mirror existing layouts. No design decisions require user sign-off; the `minH` threshold and floor order placement follow directly from the existing `3x3` layout's values (same row count).

## Complexity Audit

### Routine
- Adding a layout is a well-established pattern in this codebase — the `LAYOUTS` object, CSS grid template, and layout picker button all follow the same structure for every existing layout.
- The `1x3` layout is structurally identical to `2v` (single column, multiple rows) but with 3 rows instead of 2. No new CSS techniques or JS patterns are needed.
- The layout persistence system (`saveLayoutSettings` / `loadLayoutSettings`) stores the layout key as `terminals.layoutMode` — a plain string. No schema change needed; the new key `1x3` is just another string value.
- The `paneAssignments` array is already padded to `getMaxSlotCount()` (9, from `3x3`), so 3 slots is well within the existing capacity. No array resizing logic changes.
- `syncLayoutPickerUI()` (line 1475) is generic — it iterates all `.btn-layout` buttons and toggles `active` based on `data-layout` matching `currentLayout`. No change needed.
- `setLayoutMode()` (line 1481) checks `LAYOUT_MODES.includes(mode)` — `LAYOUT_MODES` is derived from `Object.keys(LAYOUTS)` (line 630), so adding `1x3` to `LAYOUTS` automatically includes it. No change needed.
- `getMaxSlotCount()` (line 636) computes `Math.max(...LAYOUT_MODES.map(m => LAYOUTS[m].slots))` — the max is still 9 (from `3x3`), so adding 3 slots doesn't change it. No change needed.

### Complex / Risky
- **Floor order placement:** The `LAYOUT_FLOOR_ORDER` array (line 629) determines which layouts the floor logic demotes to when the window is too small. The new `1x3` layout needs a minimum height (3 rows × ~150px = 450px) and must be placed in the order so it floors down correctly. The ordering must go from most panes to fewest: `['3x3', '2x3', '2x2', '1x3', '2h', '2v', '1']`. `1x3` has 3 slots, `2x2` has 4, so `1x3` goes after `2x2`. And `2h` has 2 slots with minW 400 — `1x3` has 3 slots with minW 0, so `1x3` should be before `2h` in the floor order (more panes = higher in the order).
- **`isTerseLayout()` check:** The function at line 2109 returns `true` for `2x3` and `3x3`, which collapses the pane header input-state chip to a dot. The `1x3` layout has only 3 panes — each pane is wide (full width) and reasonably tall (~1/3 of grid height). The header does NOT need the terse treatment; `isTerseLayout()` should not include `1x3`. No change needed — it already only checks `2x3` and `3x3`.

## Edge-Case & Dependency Audit

**Race Conditions:** None — the layout system is synchronous. `setLayoutMode()` sets `currentLayout` and `effectiveLayout`, calls `syncLayoutPickerUI()`, then `applyLayoutFloor()` re-evaluates. No async race.

**Security:** None — no input handling, no data flow changes. The `1x3` key is a hardcoded string constant, not user input.

**Side Effects:**
- Minimum height: Each pane needs at least ~150px of height for a usable terminal (header 22px + a few terminal rows). With 3 rows, 2 gaps (4px), and grid padding (4px), the minimum grid height is ~450px. The `minH` should be set to 450, matching `3x3`'s `minH`. This means the floor logic will demote `1x3` when the window is shorter than 450px.
- Minimum width: Since `1x3` is a single column, there is no horizontal minimum beyond what a single terminal needs. Set `minW: 0`, same as `2v` and `1`. The floor logic will never demote `1x3` for width reasons.
- Pane header sizing: The `2x3` and `3x3` layouts have condensed header CSS (10px font, 2px padding — lines 613–624). The `1x3` layout should NOT inherit these — its panes are full-width, so the standard header (11px font, 0 8px padding) is appropriate. No additional CSS is needed for the header. The condensed header CSS only targets `.pane-grid.layout-2x3` and `.pane-grid.layout-3x3` explicitly, so `1x3` is unaffected.
- Pane action buttons: The `2x3` and `3x3` layouts abbreviate pane action buttons to single letters (per the `isTerseLayout()` check). Since `1x3` is not terse, the full text labels ("clear", "hide", "pin") will be shown. This is correct — the panes are wide enough.
- Kanban pane mode: A pane in `1x3` can be in kanban mode (same as any other layout). The kanban pane rendering is layout-agnostic — it fills the pane's `.pane-content` area. No changes needed.
- Existing persisted layouts: Users who have a persisted `terminals.layoutMode` of an existing layout (e.g., `2v`) will not be affected. The new `1x3` key only appears when the user explicitly selects it. Old persisted values remain valid.
- `LAYOUT_MODES` derivation: `LAYOUT_MODES` is derived from `Object.keys(LAYOUTS)` (line 630), so adding `'1x3'` to the `LAYOUTS` object automatically includes it in `LAYOUT_MODES`. The `setLayoutMode` guard (line 1482, `if (!LAYOUT_MODES.includes(mode)) return`) will accept the new key.

**Dependencies & Conflicts:**
- **Companion clipping fix:** The `1x3` CSS rule uses `minmax(0, 1fr)` for rows, which is consistent with the companion clipping fix plan that changes all multi-row layouts to `minmax(0, 1fr)`. If the clipping fix is applied first, the `1x3` CSS is already correct. If `1x3` is applied first, its CSS is still correct — `minmax(0, 1fr)` is the right pattern regardless. The two plans are independent but the clipping fix should land first so the `1x3` verification (step 2: "no clipping") passes without conditional language.
- **Floor order interaction with `2h`:** `2h` has `minW: 400` and `minH: 0`. `1x3` has `minW: 0` and `minH: 450`. In the floor order, `1x3` is placed before `2h` (3 slots vs 2 slots). When the window is narrow but tall, `2h` would floor down to `2v` or `1` (because `2h` requires 400px width). When the window is wide but short, `1x3` would floor down to `2h` (requires only width 400, no height) or `2v` (requires height 250) or `1`. These are independent demotions and do not conflict.
- **`data-layout` key:** The key must be `1x3` — it is load-bearing: `terminals.layoutMode` persists it, `.pane-grid.layout-1x3` styles it, and `LAYOUTS['1x3']` specs it. The CSS class name `layout-1x3` must match exactly.
- **Layout picker button label:** The existing buttons use the `NxM` format for grids (`2x2`, `2x3`, `3x3`) and shorthand for simple splits (`1`, `2V`, `2H`). The new button should be labeled `1x3` to match the grid format, with a tooltip: "Three horizontal terminals, stacked" (following the convention where the label describes what the operator counts on screen — "2H" = two horizontal terminals stacked, so "three horizontal terminals, stacked"). The `1x3` label follows the grid convention used by 3 of 6 existing buttons (2x2, 2x3, 3x3); the `2V`/`2H` labels are the exception for 2-pane splits where the split-axis naming is confusing.

## Dependencies

- **Companion plan:** `feature_plan_20260806114815_terminals-x3-layouts-bottom-row-clipped.md` (clipping fix) — should land first. The `1x3` CSS already uses `minmax(0, 1fr)`, so it is correct regardless of ordering, but the verification step for "no clipping" depends on the fix being applied.

## Adversarial Synthesis

Key risks: floor order rationale was factually wrong about `2h` skip behavior (corrected — floor goes to `2h` when wide-but-short, not always `2v`); `minH: 450` is conservative but correct for 3 rows of usable terminals; button label follows grid convention (3 of 6 existing buttons). Mitigations: floor order placement is correct regardless of rationale error; conservative floor prevents unreadable panes; `syncLayoutPickerUI()` and `setLayoutMode()` are generic and need no changes.

## Proposed Changes

### File: `src/webview/terminals.js`

**Change 1: Add `1x3` to the `LAYOUTS` object** (line 620)

```js
/* BEFORE */
const LAYOUTS = {
    '1':   { slots: 1, minW: 0,   minH: 0   },
    '2h':  { slots: 2, minW: 400, minH: 0   },
    '2v':  { slots: 2, minW: 0,   minH: 250 },
    '2x2': { slots: 4, minW: 500, minH: 300 },
    '2x3': { slots: 6, minW: 750, minH: 300 },
    '3x3': { slots: 9, minW: 750, minH: 450 },
};

/* AFTER */
const LAYOUTS = {
    '1':   { slots: 1, minW: 0,   minH: 0   },
    '2h':  { slots: 2, minW: 400, minH: 0   },
    '2v':  { slots: 2, minW: 0,   minH: 250 },
    '1x3': { slots: 3, minW: 0,   minH: 450 },
    '2x2': { slots: 4, minW: 500, minH: 300 },
    '2x3': { slots: 6, minW: 750, minH: 300 },
    '3x3': { slots: 9, minW: 750, minH: 450 },
};
```

**Change 2: Add `1x3` to `LAYOUT_FLOOR_ORDER`** (line 629)

```js
/* BEFORE */
const LAYOUT_FLOOR_ORDER = ['3x3', '2x3', '2x2', '2h', '2v', '1'];

/* AFTER */
const LAYOUT_FLOOR_ORDER = ['3x3', '2x3', '2x2', '1x3', '2h', '2v', '1'];
```

Rationale: `1x3` has 3 slots, so it sits between `2x2` (4 slots) and `2h` (2 slots) in the floor order. The floor loop (`resolveFlooredLayout()`, line 2311) walks forward from the current layout's position toward `1`, checking each layout's `minW` and `minH` against the window size.

> **Superseded:** "When the window is too short for `1x3` (height < 450px), the floor demotes to `2v` (minH 250), then `1` — skipping `2h` which requires 400px width (not height)."
> **Reason:** This is factually wrong. The floor loop checks BOTH `minW` and `minH` for each layout. If the window is wide (>= 400px) but short (< 450px), `2h` fits (minW 400 ✓, minH 0 ✓) and the floor returns `2h` — NOT `2v`. `2h` is only skipped if the window is ALSO too narrow (< 400px). The floor order placement is still correct; only the rationale was wrong.
> **Replaced with:** When `1x3` is too short (height < 450px), the floor checks `2h` next (minW 400, minH 0). If the window is wide enough (>= 400px), the floor returns `2h` (side-by-side panes, which need no height — the right fallback for a short window). If the window is too narrow for `2h` (< 400px), the floor checks `2v` (minW 0, minH 250). If tall enough (>= 250px), returns `2v` (stacked). If too short (< 250px), returns `1`. The order is correct because the floor loop walks from the current layout's position toward `1`, checking each layout's minW/minH against the window size.

### File: `src/webview/terminals.html`

**Change 3: Add CSS grid template for `layout-1x3`** (after line 608)

```css
.pane-grid.layout-1x3 { grid-template-columns: 1fr; grid-template-rows: repeat(3, minmax(0, 1fr)); }
```

Insert this line after the `layout-2v` rule (line 608) and before `layout-2x2` (line 609), keeping the CSS rules in slot-count order. The `minmax(0, 1fr)` prevents content from expanding rows beyond their equal share (same pattern as the companion clipping fix applies to all multi-row layouts).

**Change 4: Add the layout picker button** (after line 1239)

```html
<button type="button" class="btn-layout" data-layout="1x3" title="Three horizontal terminals, stacked">1x3</button>
```

Insert this button after the `2v` button (line 1239) and before the `2x2` button (line 1240), matching the slot-count ordering of the CSS rules and the `LAYOUTS` object. The label `1x3` follows the `NxM` grid format used by `2x2`, `2x3`, `3x3`. The tooltip follows the convention from the `2v` button: "Two horizontal terminals, stacked" → "Three horizontal terminals, stacked".

## Verification Plan

### Automated Tests

No automated tests required — this is a purely additive UI feature following an established pattern. The existing `terminal-pane-grid-reconcile-contract.test.js` tests JS reconciliation logic, not layout rendering. Compilation and automated tests are skipped per session directives.

### Manual Verification

1. **Button appears:** Open the terminals panel. Verify a `1x3` button appears in the layout picker between `2H` and `2x2`, with the tooltip "Three horizontal terminals, stacked".

2. **Layout renders correctly:** Click the `1x3` button. Verify the grid shows 3 panes in a single column, each taking approximately 1/3 of the available height. All 3 panes should be fully visible (no clipping — this depends on the companion x3 clipping fix being applied; if that fix is not yet applied, the bottom pane may still clip).

3. **Pane assignment:** Assign terminals to all 3 panes by clicking terminals in the sidebar. Verify each pane shows its assigned terminal and the terminal fits within the pane (xterm `fit()` recalculates rows/cols for the pane size).

4. **Layout persistence:** Select `1x3`, then reload the terminals panel. Verify the `1x3` layout is restored from persisted settings (`terminals.layoutMode`). The `syncLayoutPickerUI()` function should highlight the `1x3` button.

5. **Floor logic — short window:** Select `1x3`, then shrink the window height below 450px. If the window is wide (>= 400px), verify the layout floors down to `2h` (2 side-by-side panes). If the window is narrow (< 400px) but still >= 250px tall, verify it floors to `2v` (2 stacked panes). Shrink further below 250px and verify it floors to `1` (single pane).

6. **Floor logic — restore:** Widen the window back above 450px. Verify the layout returns to `1x3` and the fallback banner hides.

7. **Layout switching:** Toggle between `1x3` and other layouts (especially `2v` and `2x2`). Verify pane assignments are preserved across layout changes (terminals parked in slots 0–2 remain assigned; slot 3+ terminals are parked but not rendered in `1x3`).

8. **Kanban pane mode:** Set one pane to kanban mode in the `1x3` layout. Verify the kanban pane renders correctly (full-width column viewer) and the other 2 panes show terminals normally.

9. **Existing layouts unaffected:** Verify all existing layouts (`1`, `2V`, `2H`, `2x2`, `2x3`, `3x3`) still render and function correctly. The new `1x3` entry in `LAYOUTS` and `LAYOUT_FLOOR_ORDER` should not affect their behavior.

**Completion Report:** Added the `1x3` vertical-stacked layout to `src/webview/terminals.js` by inserting the new `1x3` entry in the `LAYOUTS` object (3 slots, `minH: 450`) and adding it to `LAYOUT_FLOOR_ORDER` between `2x2` and `2h`. In `src/webview/terminals.html` I added the `.pane-grid.layout-1x3` CSS rule and a new picker button after the `2v` button with the tooltip "Three horizontal terminals, stacked". The preceding clipping fix already ensures the 1x3 rows do not overflow. No compilation or tests were run per the session directives. No issues were encountered.

## Review Findings

**Reviewer pass (in-place, 2026-08-06):** Verified all changes in `src/webview/terminals.js` (LAYOUTS object line 634, LAYOUT_FLOOR_ORDER line 640) and `src/webview/terminals.html` (CSS rule line 610, picker button line 1258) match the plan exactly. No CRITICAL or MAJOR findings. One NIT: stale comment on `terminals.js:5` doesn't list `1x3` (pre-existing pattern, comment policy prohibits fixing). Regression analysis: floor order behavior change is intended — narrow-but-tall windows that previously floored to `2h` now correctly floor to `1x3` (3 slots > 2 slots). Full execution path traced: button click → `setLayoutMode('1x3')` → `LAYOUT_MODES.includes` accepts → `renderPaneGrid` renders 3 panes → CSS applies 1-column 3-row grid → `applyLayoutFloor` evaluates `minH: 450`. No double-trigger, no race conditions, no orphaned references. Tests run independently: `terminal-pane-grid-reconcile` (7/7 pass), `terminal-pane-pinning` (15/15 pass), `terminal-solo-popout` (11/11 pass), ESLint (0 errors). Pre-existing failures in `terminal-pane-fit` and `terminal-focus-affordance` confirmed unrelated via git stash. Gate-wiring audit: no automated checks named in plan, clean pass. Remaining risk: manual visual verification of 1x3 layout rendering and floor logic in live VS Code webview not performed in this review pass.
