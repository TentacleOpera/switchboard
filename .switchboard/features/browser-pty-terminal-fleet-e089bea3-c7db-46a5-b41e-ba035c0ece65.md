# Browser PTY Terminal Fleet

**Complexity:** 7

## Goal

Make the browser-mode PTY terminal fleet usable at fleet scale: stop layout switches and mis-clicks from destroying pane assignments, raise the grid from 4 to 9 simultaneously-visible panes, and fix dispatch so browser-surface sends reach PTY terminals instead of failing with 'The terminal is not running in VS Code'. Land the assignment-durability subtask before the grid expansion — the expansion widens the blast radius of the truncation bug the durability work removes.

## How the Subtasks Achieve This

- **Stop Losing Browser Terminal Pane Assignments on Layout Switch and Mis-Click**: Removes the three assignment-destruction mechanisms in `src/webview/terminals.js` — the layout-downshift truncation, the silent focused-pane eviction, and the indistinguishable pane-clear/kill controls — and adds undo + pane-index visibility. This is the foundation: it makes every pane-count change non-destructive, which the grid expansion depends on.
- **Expand the Browser Terminals Grid Beyond Four Panes**: Replaces the five hardcoded four-layout lists with a single `LAYOUTS` table and adds `2x3`/`3x3` modes, lifting the panel from 4 to 9 simultaneously-visible panes. This delivers the fleet-scale visibility the feature exists for, safe to ship once durability has removed the truncation bug it would otherwise widen.
- **Route Browser-Surface Dispatch to the PTY Fleet Instead of Refusing It**: Splits the overloaded `apiOriginated` flag, stamps it centrally on the HTTP verb rails, and gives resolution the same PTY-eligibility rule delivery already had — so browser-surface sends actually reach the PTY panes the first two subtasks make usable. Without it, a bigger, sturdier grid still receives no dispatches.

## Dependencies & sequencing

- **Cross-feature dependencies:** none. All three subtasks are self-contained in this repo (`src/webview/terminals.*`, `src/services/*`, `src/extension.ts`) and require nothing from other features.
- **Shipping order:** (1) pane-assignment durability → (2) grid expansion → (3) dispatch routing. Durability must land before the grid expansion because the expansion widens the truncation bug's blast radius from 4 lost assignments to 8. Dispatch routing is code-independent of both (different files) and could land in any position, but ships last because its value — delivering prompts into browser panes — is only fully realised once the grid can show them.
- **Shared-surface reconciliation (pinned):** durability and grid both rewrite `sanitizePaneAssignments()` sizing. End-state: durability lands first with `MAX_PANE_SLOTS = 9`; the grid plan then performs exactly one substitution — delete the constant, call its table-derived `getMaxSlotCount()`. Neither plan re-applies the other's hunk; the `LAYOUTS` table is the single owner of slot counts.
- **Guards:** the grid expansion's responsive-floor parity for the existing four layouts is a hard requirement (verification items 7-11 in its plan); the dispatch routing's CLI-triggers gate quadrants must hold (its plan's verification items 10-12) before the flag split is considered safe.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Expand the Browser Terminals Grid Beyond Four Panes](../plans/feature_plan_20260731120000_browser-terminal-grid-beyond-four-panes.md) — **LEAD CODED**
- [ ] [Stop Losing Browser Terminal Pane Assignments on Layout Switch and Mis-Click](../plans/feature_plan_20260731120100_stop-losing-browser-terminal-pane-assignments.md) — **LEAD CODED**
- [ ] [Route Browser-Surface Dispatch to the PTY Fleet Instead of Refusing It](../plans/feature_plan_20260731120200_route-browser-surface-dispatch-to-pty-fleet.md) — **LEAD CODED**
<!-- END SUBTASKS -->

