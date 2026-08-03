# Terminals Pane Resize on Layout Change

**Complexity:** 7

## Goal

Panes keep their old rendered size when the browser Terminals layout changes (e.g. 3x3 to single). Root cause: renderPaneGrid blanks the grid with innerHTML='' on every render, detaching every live xterm; xterm's RenderService parks the renderer resize and full repaint while its IntersectionObserver reports non-intersection, and rAF runs before that delivery. FitAddon.fit() then short-circuits on matching cols/rows, so the stale canvas is permanent. Subtask 1 makes the fit verify itself and retry; subtask 2 removes the DOM churn that creates the race.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Verified Pane Fit After a Terminals-Panel Layout Change](../plans/feature_plan_20260803144948_verified-pane-fit-after-layout-change.md) — **PLAN REVIEWED**
- [ ] [Reconcile the Terminals Pane Grid In Place Instead of Rebuilding It](../plans/feature_plan_20260803144949_pane-grid-in-place-reconciliation.md) — **PLAN REVIEWED**
<!-- END SUBTASKS -->

