# Fix: Bottom Terminal Row Clipped in 2x3 and 3x3 Layouts

## Goal

In the `2x3` and `3x3` grid layouts of `terminals.html`, the bottom row of terminal panes has a portion of its display cut off by the bottom edge of the screen. The terminal content in the bottom row is partially invisible — the last few lines of terminal output are hidden below the viewport boundary. This must be fixed so all rows fit entirely within the available space.

### Problem Analysis & Root Cause

**Symptom:** When using the 2x3 (6-pane) or 3x3 (9-pane) layout, the bottom-most row of panes is clipped. A strip of terminal content at the bottom of each bottom-row pane is not visible. The issue is not present (or not noticeable) in simpler layouts like `1`, `2h`, or `2v`.

**Root Cause:** The `.pane-grid` element in `terminals.html` (line 595) has **both** `flex: 1` and `height: 100%`:

```css
.pane-grid {
    flex: 1;
    display: grid;
    gap: 4px;
    padding: 4px;
    position: relative;
    background: var(--bg-color);
    width: 100%;
    height: 100%;     /* ← problem */
    box-sizing: border-box;
}
```

`.pane-grid` lives inside `.terminals-main`, a flex column container (`terminals.html` line 401). The `.terminals-main` contains:
1. `.layout-toolbar` (~37px tall, fixed by content)
2. `#layout-fallback-banner` (0px when hidden)
3. `#pane-toast` (0px when hidden)
4. `.pane-grid` (the grid itself)

The `height: 100%` on `.pane-grid` resolves against `.terminals-main`'s full height, which is `100vh` (inherited from `body { height: 100vh }`). This means the grid attempts to be `100vh` tall — but the toolbar (~37px) sits **above** it in the flex column. The grid therefore overflows by approximately the toolbar height. Since `body` has `overflow: hidden` (line 99), the overflow is silently clipped, taking the bottom ~37px of the grid with it.

In layouts with 1 row (`1`, `2h`), the single row absorbs the full grid height, so the clipping takes ~37px off one row — noticeable but less severe since the row is tall. In `2v` (2 rows), each row is ~50% of the grid, so each loses ~18px — borderline noticeable. In `2x3` (2 rows) and `3x3` (3 rows), the rows are much shorter (50% and 33% of grid height respectively), so losing ~37px off the bottom row is a much larger fraction of that row's height — making the clipping clearly visible.

A secondary contributing factor: the grid rows use `1fr`, which CSS Grid resolves as `minmax(auto, 1fr)`. The `auto` minimum means rows won't shrink below their content's intrinsic minimum height. If the xterm terminal canvas has a minimum content height, rows can expand beyond their `1fr` share, worsening the overflow. Changing to `minmax(0, 1fr)` forces rows to respect the equal distribution.

## Metadata

**Complexity:** 2
**Tags:** frontend, ui, bugfix
**Project:** Browser Switchboard

## User Review Required

No — this is a pure CSS bugfix with no design decisions or behavior changes. The fix corrects an overflow that was never intentional. No user-facing configuration or workflow changes.

## Complexity Audit

### Routine
- The fix is a pure CSS change in `terminals.html` — no JavaScript logic changes, no layout algorithm changes, no new dependencies.
- The `height: 100%` property is redundant with `flex: 1`; removing it cannot change the grid's intended size, only correct the overflow.
- The `minmax(0, 1fr)` pattern is a well-established CSS Grid idiom for preventing content from expanding tracks beyond their fractional share.
- The `min-height: 0` addition is a standard flexbox fix that allows a flex item to shrink below its content's intrinsic minimum size.

### Complex / Risky
- None

## Edge-Case & Dependency Audit

**Race Conditions:** None — the fix is pure CSS. The `ResizeObserver` on each terminal will fire once on the next render after the CSS change takes effect (the bottom-row panes will have a slightly smaller height), calling `fit()` to recalculate terminal rows/cols for the correct box. This is the expected behavior — the terminal will show fewer rows, but all of them will be visible.

**Security:** None — no input handling, no data flow changes.

**Side Effects:**
- The `height: 100%` removal affects all layouts identically — the grid still gets its height from `flex: 1` in the column flex container, which is the correct mechanism.
- The `minmax(0, 1fr)` change applies to multi-row layouts only; single-row layouts (`1`, `2h`) are unaffected since they have one row that takes all available space regardless.
- The column `minmax(0, 1fr)` changes (2x2, 2x3, 3x3) are defensive — they only activate if terminal content reports a minimum width that would otherwise expand columns beyond their fractional share. No horizontal clipping bug has been reported, but this prevents the same class of issue.
- The `width: 100%` on `.pane-grid` is the cross-axis size in the column flex container and is left unchanged — it is not the cause of the bug.

**Dependencies & Conflicts:**
- `resolveFlooredLayout()` in `terminals.js` (line 2311) measures `paneGridEl.getBoundingClientRect()` to decide if the window is too small for the requested layout. With the overflow fix, the measured height will be correct (100vh minus toolbar) instead of inflated (100vh). This makes the floor logic slightly more conservative — it will floor down at slightly taller window sizes than before. This is the right direction (better to floor down than show clipped panes).
- `applyLayoutFloor()` (line 2836) calls `resolveFlooredLayout()` and re-renders if the floored layout changed. The more conservative measurement may cause an extra floor-down render in edge cases where the window is just barely tall enough for the current layout under the old (inflated) measurement. This is correct behavior.
- No test changes needed: the existing `terminal-pane-grid-reconcile-contract.test.js` tests JS reconciliation logic, not CSS sizing.

## Dependencies

No cross-plan dependencies. This is a standalone CSS bugfix.

## Adversarial Synthesis

Key risks: floor logic becomes more conservative (measures actual grid height, not inflated 100vh — favorable direction); column `minmax` change is defensive scope expansion (zero-risk, only activates if content reports a minimum width). Mitigations: floor logic correctly re-evaluates on next resize via `resolveFlooredLayout()`; column changes have no effect unless content tries to expand tracks.

## Proposed Changes

### File: `src/webview/terminals.html`

**Change 1: Remove `height: 100%` and add `min-height: 0` to `.pane-grid`** (line 595)

```css
/* BEFORE */
.pane-grid {
    flex: 1;
    display: grid;
    gap: 4px;
    padding: 4px;
    position: relative;
    background: var(--bg-color);
    width: 100%;
    height: 100%;
    box-sizing: border-box;
}

/* AFTER */
.pane-grid {
    flex: 1;
    display: grid;
    gap: 4px;
    padding: 4px;
    position: relative;
    background: var(--bg-color);
    width: 100%;
    min-height: 0;
    box-sizing: border-box;
}
```

Rationale: `flex: 1` already gives the grid the remaining height in the `.terminals-main` column flex container. `height: 100%` was redundant and incorrect — it resolved against the parent's full height (including the toolbar), causing overflow. `min-height: 0` replaces the default `min-height: auto` so the grid can shrink to fit the available space rather than being forced to its content's intrinsic minimum.

**Change 2: Use `minmax(0, 1fr)` for multi-row grid templates** (lines 608–611)

```css
/* BEFORE */
.pane-grid.layout-2v { grid-template-columns: 1fr; grid-template-rows: 1fr 1fr; }
.pane-grid.layout-2x2 { grid-template-columns: 1fr 1fr; grid-template-rows: 1fr 1fr; }
.pane-grid.layout-2x3 { grid-template-columns: repeat(3, 1fr); grid-template-rows: repeat(2, 1fr); }
.pane-grid.layout-3x3 { grid-template-columns: repeat(3, 1fr); grid-template-rows: repeat(3, 1fr); }

/* AFTER */
.pane-grid.layout-2v { grid-template-columns: 1fr; grid-template-rows: repeat(2, minmax(0, 1fr)); }
.pane-grid.layout-2x2 { grid-template-columns: repeat(2, minmax(0, 1fr)); grid-template-rows: repeat(2, minmax(0, 1fr)); }
.pane-grid.layout-2x3 { grid-template-columns: repeat(3, minmax(0, 1fr)); grid-template-rows: repeat(2, minmax(0, 1fr)); }
.pane-grid.layout-3x3 { grid-template-columns: repeat(3, minmax(0, 1fr)); grid-template-rows: repeat(3, minmax(0, 1fr)); }
```

Rationale: `1fr` is shorthand for `minmax(auto, 1fr)`, where `auto` means "at least as tall as the content's minimum size". If the xterm canvas reports a minimum height, rows expand beyond their `1fr` share, causing overflow. `minmax(0, 1fr)` sets the minimum to 0, forcing rows to respect the equal distribution. The columns are also changed for consistency (prevents the same issue horizontally if terminals report a minimum width). The single-row layouts (`1`, `2h`) are left unchanged — one row/column always takes all available space, so `minmax` is a no-op there. The `2v` single column is left as `1fr` — a single column in a single-column grid can only expand to the grid's full width and cannot push other columns (there are none).

## Verification Plan

### Automated Tests

No automated tests required — this is a pure CSS change with no JS logic changes. The existing `terminal-pane-grid-reconcile-contract.test.js` tests JS reconciliation logic, not CSS sizing. Compilation and automated tests are skipped per session directives.

### Manual Verification

1. **Manual visual check — 3x3 layout:** Open the terminals panel, select the 3x3 layout, and populate all 9 panes with terminals. Verify that the bottom row of panes is fully visible — no clipping at the bottom edge. The terminal prompt line should be completely visible in every pane.

2. **Manual visual check — 2x3 layout:** Same as above with the 2x3 layout (6 panes, 2 rows). Verify the bottom row is fully visible.

3. **Manual visual check — 2v layout:** Select the 2v layout (2 stacked panes). Verify both panes are fully visible (this layout was borderline before; confirm it's now correct).

4. **Layout toolbar interaction:** Toggle between all layouts (1, 2V, 2H, 2x2, 2x3, 3x3) rapidly. Verify no layout clips the bottom row and the grid always fits within the viewport below the toolbar.

5. **Fallback banner:** Shrink the window until the fallback banner appears. Verify the grid still fits below both the toolbar and the banner — no clipping.

6. **Window resize:** With a multi-row layout active, drag the window shorter. Verify the rows shrink proportionally and the bottom row remains fully visible at all sizes. The terminal `fit()` should recalculate rows/cols via the ResizeObserver.

7. **Solo mode:** Open a terminal in solo mode (direct URL or New Window). Verify the single pane fills the viewport with no clipping — solo mode was never affected and should remain unaffected.

**Completion Report:** Implemented the bottom-row clipping fix in `src/webview/terminals.html` by removing the redundant `height: 100%` from `.pane-grid` and replacing it with `min-height: 0`, and by switching the multi-row grid templates (`2v`, `2x2`, `2x3`, `3x3`) to use `minmax(0, 1fr)`. The `1x3` layout was also added in the related subtask, so the shared CSS surface is now final. No compilation or tests were run per the session directives. No issues were encountered.

## Review Findings

**Reviewer pass (in-place, 2026-08-06):** Verified all CSS changes in `src/webview/terminals.html` (lines 596-613) match the plan exactly — `height: 100%` → `min-height: 0` on `.pane-grid`, `minmax(0, 1fr)` on all multi-row grid templates. No CRITICAL or MAJOR findings. Two NITs: stale comment on `terminals.js:5` (lists 4 of 7 layout keys, pre-existing), and `2h` columns left as `1fr` instead of `minmax(0, 1fr)` (deliberate per plan, not a clipping issue). Regression analysis: `resolveFlooredLayout()` now measures correct grid height (not inflated 100vh), making floor logic slightly more conservative — favorable direction. Tests run independently: `terminal-pane-grid-reconcile` (7/7 pass), `terminal-pane-pinning` (15/15 pass), `terminal-solo-popout` (11/11 pass), ESLint (0 errors). Pre-existing failures in `terminal-pane-fit` (missing `DEFAULT_ROLES` at HEAD) and `terminal-focus-affordance` (socket reconnect) confirmed unrelated to this change via git stash. Gate-wiring audit: no automated checks named in plan, clean pass. Remaining risk: manual visual verification of clipping fix in live VS Code webview not performed in this review pass.
