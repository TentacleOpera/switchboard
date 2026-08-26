# Terminals Panel: Pane Seating and Shared Column Derivation

**Complexity:** 4

## Goal

Make the Terminals panel's grid behave the way the operator expects and make its embedded kanban pane agree with the board. Fill Grid today creates terminals it cannot seat, because it tops up empty panes but never displaces panes held by another role, so filling a one-slot grid with a role that has no live terminals leaves the pane showing the old role and the new terminal orphaned in the sidebar. Separately, the pane re-implements the board's column-set derivation and has drifted from it on three axes at once: the aggregate column's label, its position in the list, and whether it appears at all. Both are edits to the same regions of terminals.js and must be serialised regardless.

## How the Subtasks Achieve This

- **Fill Grid Does Not Displace Panes Held by Other Roles**: adds a `role` option to `fillEmptyPanes` so a fill frees panes held by a different role before seating, clears their pin flags to preserve the sanitiser's invariant, and filters the unseated list to the chosen role so displaced terminals do not reclaim the freed slots. It also makes the `need <= 0` path re-seat the grid instead of returning early with a "no grid to fill" toast while the panes show something else entirely.
- **Extract the kanban column-set derivation into a shared webview script**: creates `sharedKanbanColumns.js` exposing one pure `buildDisplayColumns(columns, { collapseCoders })`, ported from the board's canonical implementation, and rewires both the board and the pane to call it. It also moves `collapseCoders` out of per-webview `vscode.getState()` into a host-persisted scoped setting, which is what makes the pane able to see the board's collapse state at all.

## Reconciliation (improve-feature pass, 2026-08-14)

Both subtask plans were re-verified against the working tree. The set is coherent — no merge, split, or deletion was warranted — but one subtask's scope changed substantially and the sequencing note below needed a correction.

**The derivation subtask is ~60% already built, uncommitted.** `src/webview/terminals.js`, `src/webview/kanban.html`, `src/services/KanbanProvider.ts` and `src/test/browser-kanban-pane-order.test.js` carry modified-but-uncommitted work that already fixes the three visible defects (label, position, conditionality) *in each surface's own copy of the logic*, and already ships the whole cross-surface state layer: the `kanban.collapseCodersEnabled` scoped setting, the `toggleCollapseCoders` verb (already in `src/generated/verbAllowlist.ts`, so no catalog regeneration is needed), the `collapseCodersState` pushes, the `getKanbanStructure` return-body field, and the board's write-through and adoption. What remains is **only the extraction** — one shared script, two call sites rewired, two local derivations deleted. Commit or otherwise secure that working-tree state before starting so the extraction is a separable diff. Complexity drops 5 → 4.

**The fill-grid subtask's own proposed code had a confirmed defect**, now superseded in the plan: it tested "already seated" with an array-wide `paneAssignments.includes(...)`, but `sanitizePaneAssignments` sizes that array to `getMaxSlotCount()` rather than the current layout, so a terminal parked in a hidden slot counted as seated. Combined with an early `return 0` that skipped the render/persist tail, a role fill that shrank the grid returned "0 unseated", left the DOM disagreeing with `paneAssignments`, and persisted nothing. The plan now uses a slot-bounded seated set and a `freed` flag. It also gained a kanban-pane-aware `need` computation, since counting a kanban slot as seatable manufactures exactly the orphan the subtask exists to remove. Complexity rises 3 → 4.

**Shared-surface map.** The only file both subtasks touch is `src/webview/terminals.js`, at `~4920-5030` (derivation) and `~6474-6580` (fill grid) — ~1,400 lines apart, no shared symbol. No overlap, no contradiction, no supersession, no required order. The serialisation below is merge hygiene only.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Extract the kanban column-set derivation into a shared webview script](../plans/feature_plan_20260812143000_shared-kanban-column-set-derivation.md) — **PLAN REVIEWED** — ID: 883a52c0-3b0b-44e8-8c7e-3cd75384b758
- [ ] [Fill Grid Does Not Displace Panes Held by Other Roles — New Terminals Left Unassigned](../plans/feature_plan_20260812185906_fill-grid-displaces-other-roles.md) — **PLAN REVIEWED** — ID: 8e6804b2-f26b-4e17-aa70-8a1a0db9636d
<!-- END SUBTASKS -->

## Dependencies & sequencing

No hard functional dependency between the two — they fix unrelated defects in different functions. But both edit `src/webview/terminals.js`, so they serialise under the one-stream-per-file rule. Either order works; Fill Grid is the smaller, more localised change and is the natural first.

**Test-file contention:** Fill Grid extends `src/test/terminal-open-all-seating-contract.test.js`; the derivation plan rewrites part of `src/test/browser-kanban-pane-order.test.js`. Disjoint files — no collision.

> **Superseded:** "the column-derivation plan **deletes** two source-shape assertions from `browser-kanban-pane-order.test.js` (they pin the buggy tail-append and `coded.length > 1` shape, so a correct fix turns them red) … the derivation plan must not delete more than the two named assertions."
> **Reason:** No longer true, and following it would misdirect the coder. Those two assertions are already gone — the test file was rewritten alongside the uncommitted hand-fix and now pins the **correct** shape. But it pins it as *source text inside `terminals.js`*, so the extraction still turns it red: five assertions (the tail-append `doesNotMatch`, the `.filter(c => c.kind !== 'coded')` match, the `order: kanbanColumnsCache.find(...)?.order || 180` match, the `.sort((a, b) => ...)` match, and the whole `AGGREGATE_CODED_LABEL` casing test) scan for text the shared script takes with it. A coder hunting for two obsolete assertions finds neither, and may conclude the plan describes a different file.
> **Replaced with:** the derivation plan's retargeted Step 8, which names the five assertions to delete, the ones to keep (pane-local gating that does not move), and the parity assertion that replaces them.

**Fill Grid must not regress `openAllTerminals`**, which calls `fillEmptyPanes({ persist: false })` with no `role` — the displacement path is gated on `opts.role` being present. The existing contract test pins several literal substrings in `fillGrid` (`if (need <= 0)`, `LAYOUTS[mode].slots`, `setLayoutMode(mode)`, `t.status !== 'exited' && t.role === role`, and the absence of `confirm(`); the restructured function must preserve all of them.

**⚠ Cross-feature contention — the highest risk here.** *Staging is a filter, not a column* (in **The Dispatch-Analysis Pass** feature) rewrites the same terminals kanban-pane surfaces this feature's derivation plan rewrites: the column picker, `buildColumnList`, `bodySig`, the card fetch path and the empty-state string. That plan states the two must serialise and that whichever lands second adopts the first's synthetic-id and `bodySig` conventions rather than inventing a parallel one. Coordinate across the two features before either starts. A third plan on the same pane — *the per-row link button is inert* — is standalone in **PLAN REVIEWED** and adds tests to `browser-kanban-pane-order.test.js`; if it is dispatched around the same time, land it before the derivation plan's test replacement.

**Migration:** none. The new `kanban.collapseCodersEnabled` setting defaults to the board's existing in-webview default, and the value it supersedes was per-webview state that was never authoritative across surfaces.
