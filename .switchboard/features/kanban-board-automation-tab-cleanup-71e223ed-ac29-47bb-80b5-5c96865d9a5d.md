# Kanban Board & Automation Tab Cleanup

**Complexity:** 4

## Goal

Three board-surface defects: the DRAIN/WATCH trigger toggle explains itself only through terse native title attributes in a panel that routes every other control through its own tooltip overlay; the 'Antigravity Batch (legacy)' mode option is unselectable because remapAutomationMode rewrites it to 'scheduler' on the next config push; and the workspace/project dropdown is torn down and rebuilt on every 10s board poll because updateWorkspaceSelection is posted unconditionally while its sibling updateColumns is signature-guarded.

## How the Subtasks Achieve This

- **Kanban Automation Tab: DRAIN/WATCH Toggle Needs Real Tooltips**: Swaps the toggle's native `title` attributes for the panel's own `data-tooltip` overlay, with substantive multi-line copy condensed from the Watch warning banner, so the user learns what Watch costs (immediate unattended dispatch, one agent run per arrival, never auto-stops) *before* enabling it instead of after. Also clears any live overlay when the automation panel re-renders so no stale tooltip pins to a destroyed node.
- **Kanban Automation Tab: Remove the Unselectable "Antigravity Batch (legacy)" Mode**: Deletes the MODE dropdown option that `remapAutomationMode` instantly rewrites to Scheduler, removes the now-unreachable mode-specific branches, and trims the grouped conditionals — while deliberately keeping the union member, the provider guard, and the remap as migration surface for shipped installs. Removes a control the code actively refuses to honour.
- **Kanban Board: Workspace/Project Dropdown Is Torn Down and Rebuilt on Every Board Poll**: Signature-guards the provider's `updateWorkspaceSelection` push at the three poll sites (never the connect-time resync) and adds change-detection plus an interaction guard with deferred-replay to the webview's dropdown rebuild, so an open `<select>` survives the 10s poll and real updates still land.

## Dependencies & sequencing

- **Cross-feature dependencies:** None. All work is inside `src/webview/kanban.html` (all three) and `src/services/KanbanProvider.ts` (dropdown fix only); nothing must land from other features first.
- **Shipping order within this feature:** Subtasks touch disjoint symbols (toggle factory + `renderAutobanPanel` top / MODE option list + dead branches / workspace dropdown + provider push sites) and can land in any order. If coded sequentially in one tree, prefer tooltips → legacy-mode removal → dropdown rebuild (smallest diff first), and anchor every edit to symbol names, not the cited line numbers — each landed subtask shifts the lines of the others.
- **Prerequisites / guards:** The legacy-mode removal must keep `remapAutomationMode`, the `autobanState.ts` union member, and the `TaskViewerProvider` `setAutomationMode` guard (shipped-state migration surface). The dropdown fix must never signature-guard the per-connection resync at `KanbanProvider.ts:1136-1152`.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Kanban Automation Tab: DRAIN/WATCH Toggle Needs Real Tooltips](../plans/feature_plan_20260805105307_kanban-automation-drain-watch-tooltips.md) — **PLAN REVIEWED**
- [ ] [Kanban Automation Tab: Remove the Unselectable "Antigravity Batch (legacy)" Mode](../plans/feature_plan_20260805105308_remove-antigravity-batch-legacy-automation-mode.md) — **PLAN REVIEWED**
- [ ] [Kanban Board: Workspace/Project Dropdown Is Torn Down and Rebuilt on Every Board Poll](../plans/feature_plan_20260805105309_kanban-workspace-project-dropdown-rebuilt-on-every-poll.md) — **PLAN REVIEWED**
<!-- END SUBTASKS -->

