# Terminals Panel: Pane Seating and Shared Column Derivation

**Complexity:** 5

## Goal

Make the Terminals panel's grid behave the way the operator expects and make its embedded kanban pane agree with the board. Fill Grid today creates terminals it cannot seat, because it tops up empty panes but never displaces panes held by another role, so filling a one-slot grid with a role that has no live terminals leaves the pane showing the old role and the new terminal orphaned in the sidebar. Separately, the pane re-implements the board's column-set derivation and has drifted from it on three axes at once: the aggregate column's label, its position in the list, and whether it appears at all. Both are edits to the same regions of terminals.js and must be serialised regardless.

## How the Subtasks Achieve This

- **Fill Grid Does Not Displace Panes Held by Other Roles**: adds a `role` option to `fillEmptyPanes` so a fill frees panes held by a different role before seating, clears their pin flags to preserve the sanitiser's invariant, and filters the unseated list to the chosen role so displaced terminals do not reclaim the freed slots. It also makes the `need <= 0` path re-seat the grid instead of returning early with a "no grid to fill" toast while the panes show something else entirely.
- **Extract the kanban column-set derivation into a shared webview script**: creates `sharedKanbanColumns.js` exposing one pure `buildDisplayColumns(columns, { collapseCoders })`, ported from the board's canonical implementation, and rewires both the board and the pane to call it. It also moves `collapseCoders` out of per-webview `vscode.getState()` into a host-persisted scoped setting, which is what makes the pane able to see the board's collapse state at all.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Extract the kanban column-set derivation into a shared webview script](../plans/feature_plan_20260812143000_shared-kanban-column-set-derivation.md) — **PLAN REVIEWED**
- [ ] [Fill Grid Does Not Displace Panes Held by Other Roles — New Terminals Left Unassigned](../plans/feature_plan_20260812185906_fill-grid-displaces-other-roles.md) — **PLAN REVIEWED**
<!-- END SUBTASKS -->

## Dependencies & sequencing

No hard functional dependency between the two — they fix unrelated defects in different functions. But both edit `src/webview/terminals.js`, so they serialise under the one-stream-per-file rule. Either order works; Fill Grid is the smaller, more localised change and is the natural first.

**Test-file contention:** the column-derivation plan **deletes** two source-shape assertions from `src/test/browser-kanban-pane-order.test.js` (they pin the buggy tail-append and `coded.length > 1` shape, so a correct fix turns them red) and replaces them with direct unit tests of `buildDisplayColumns`. Fill Grid instead extends `src/test/terminal-open-all-seating-contract.test.js`, which the derivation plan does not touch — no collision there, but the derivation plan must not delete more of `browser-kanban-pane-order.test.js` than the two named assertions.

**Fill Grid must not regress `openAllTerminals`**, which calls `fillEmptyPanes({ persist: false })` with no `role` — the displacement path is gated on `opts.role` being present. The existing contract test pins several literal substrings in `fillGrid` (`if (need <= 0)`, `LAYOUTS[mode].slots`, `setLayoutMode(mode)`, `t.status !== 'exited' && t.role === role`, and the absence of `confirm(`); the restructured function must preserve all of them.

**⚠ Cross-feature contention — the highest risk here.** *Staging is a filter, not a column* (in **The Dispatch-Analysis Pass** feature) rewrites the same terminals kanban-pane surfaces this feature's derivation plan rewrites: the column picker, `buildColumnList`, `bodySig`, the card fetch path and the empty-state string. That plan states the two must serialise and that whichever lands second adopts the first's synthetic-id and `bodySig` conventions rather than inventing a parallel one. Coordinate across the two features before either starts. A third plan on the same pane — *the per-row link button is inert* — is standalone in **PLAN REVIEWED** and adds tests to `browser-kanban-pane-order.test.js`; if it is dispatched around the same time, land it before the derivation plan's test replacement.

**Migration:** none. The new `kanban.collapseCodersEnabled` setting defaults to the board's existing in-webview default, and the value it supersedes was per-webview state that was never authoritative across surfaces.
