# Terminal Grid Layout Fixes & Extensions

**Complexity:** 3

## Goal

Fixes bottom-row clipping in 2x3/3x3 grid layouts and adds a new 1x3 vertical-stacked layout option to the terminals panel. The clipping bug — caused by a redundant `height: 100%` on `.pane-grid` that overflows past the toolbar — makes bottom-row panes partially invisible in dense grids. The 1x3 layout fills a gap between `2v` (2 stacked) and `2x3` (6 panes) for operators who need exactly 3 stacked terminals. These plans are grouped because both touch the same CSS surface (`.pane-grid` layout rules in `terminals.html`) and the 1x3 layout's "no clipping" verification depends on the clipping fix being applied first.

## How the Subtasks Achieve This

- **Fix: Bottom Terminal Row Clipped in 2x3 and 3x3 Layouts**: Removes the redundant `height: 100%` from `.pane-grid` (replaced with `min-height: 0`) and changes `1fr` to `minmax(0, 1fr)` for all multi-row grid templates, so the grid correctly takes only the remaining height after the toolbar and rows respect equal distribution. This is the foundational fix — without it, any multi-row layout (including the new 1x3) clips the bottom row.
- **Add 1x3 Terminal Layout (3 Panes Stacked Vertically)**: Adds a new `1x3` key to the `LAYOUTS` object (3 slots, minH 450), inserts it into `LAYOUT_FLOOR_ORDER` between `2x2` and `2h`, adds a CSS grid rule (1 column, 3 rows with `minmax(0, 1fr)`), and adds a picker button. This gives operators a 3-pane vertical stack — the natural extension of `2v` for users who need one more terminal without the density of `2x3`.

## Dependencies & sequencing

- **Cross-feature dependencies:** None — this feature is self-contained within the terminals panel.
- **Shipping order within this feature:** The clipping fix (subtask 1) must land before the 1x3 layout (subtask 2). The 1x3 CSS already uses `minmax(0, 1fr)`, so it is correct regardless of order, but the 1x3 verification step 2 ("no clipping") depends on the clipping fix being applied. Landing the clipping fix first also means the shared CSS surface (lines 608–611) is already in its final state when the 1x3 rule is inserted.
- **Prerequisites:** None beyond the plans themselves. Both are pure CSS/JS changes to `src/webview/terminals.html` and `src/webview/terminals.js` with no external dependencies.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Add 1x3 Terminal Layout (3 Panes Stacked Vertically)](../plans/feature_plan_20260806114816_terminals-add-1x3-vertical-layout.md) — **CODE REVIEWED**
- [ ] [Fix: Bottom Terminal Row Clipped in 2x3 and 3x3 Layouts](../plans/feature_plan_20260806114815_terminals-x3-layouts-bottom-row-clipped.md) — **CODE REVIEWED**
<!-- END SUBTASKS -->

