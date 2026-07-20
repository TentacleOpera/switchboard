# Tickets tab control-strip & sidebar cleanup

**Complexity:** 5

## Goal

The Tickets tab in planning.html is overloaded: the top control strip horizontally scrolls, the preview meta bar wraps 13 buttons onto multiple rows, and sidebar cards resize on hover. This feature declutters all three surfaces — merge Refresh/Refetch, remove the redundant Refine button, stop cards resizing on hover, move search into the sidebar, and collapse the preview meta bar behind a primary+overflow split — without changing any provider/state gating behaviour.

## How the Subtasks Achieve This

- **Move Refetch into a "More" menu (keep Refresh primary)**: The two top-strip buttons run near-identical handlers (delta vs `forceFull`), reading as confusing duplicates. Refetch stays — it's the only recovery path when local state drifts out of sync — but demotes into the "⋯ More" overflow menu with a purpose-stating label, leaving Refresh as the primary visible action.
- **Remove the Refine button from ticket cards**: Refine is redundant with Link — both hand the ticket to the agent to write up. Deletes the card button + its delegation (and the orphaned `copyRefinePrompt` handler / `refine_ticket` skill), trimming the card action row.
- **Stop sidebar cards resizing on hover**: The card action row is collapsed to zero height at rest and expands on hover, causing constant layout shift as the cursor scans the list. Makes the row always occupy its space (optionally dimmed until hover) so card height never changes.
- **Move the search input to the top of the sidebar**: Search currently sits mid-way through the overflowing top strip, far from the list it filters. Relocates it (same id/handlers) to the top of the sidebar above the cards, and handles the collapsed-rail state. Removes a wide element from the top strip.
- **De-overload the ticket preview meta bar**: 13 equal-weight buttons wrap onto 2–3 rows. Splits them into primary inline (Edit/Push/Comment), a reusable "⋯ More" overflow popover (Assign/Tags/Attachments/Diagram/subtask actions), and Delete pinned far-right — preserving all existing per-provider/state gating.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Tickets tab: move Refetch into a "More" menu (keep Refresh primary)](../plans/tickets-merge-refresh-refetch.md) — **CODE REVIEWED**
- [ ] [Tickets tab: remove the Refine button from ticket cards](../plans/tickets-remove-refine-button.md) — **CODE REVIEWED**
- [ ] [Tickets tab: stop sidebar cards resizing on hover](../plans/tickets-sidebar-cards-no-hover-resize.md) — **CODE REVIEWED**
- [ ] [Tickets tab: move the search input to the top of the sidebar](../plans/tickets-search-move-to-sidebar-top.md) — **CODE REVIEWED**
- [ ] [Tickets tab: de-overload the ticket preview meta bar](../plans/tickets-preview-meta-bar-deoverload.md) — **CODE REVIEWED**
<!-- END SUBTASKS -->

## Dependencies & sequencing

- **One real dependency:** *Move Refetch into a "More" menu* reuses the overflow-menu component built by *De-overload the ticket preview meta bar*. Land the meta-bar subtask first (or build the shared component in whichever lands first and have the other reuse it) — do not build two overflow menus.
- **Soft coupling to note:** *Remove Refine* and *Stop cards resizing on hover* both touch the sidebar card action row (`.card-actions` render + CSS). Landing Refine-removal first is slightly cleaner (the no-hover-resize plan then reasons about 4 buttons, not 5) but either order works.
- The remaining subtasks (*Move search to sidebar*) are independent and can land in any order.
- *Move search to sidebar* and *De-overload the meta bar* both serve the top-level "overloaded strips" goal but touch different regions (top strip vs. preview meta bar) with no overlap.
- All work is confined to `src/webview/planning.html` + `src/webview/planning.js` (plus minor backend cleanup in the Refine plan). No provider message-protocol changes; all existing per-provider/state gating must be preserved.

## Completion Summary

Implemented all five subtasks. Built a reusable multi-instance overflow-menu component (`[data-overflow-menu]`/`[data-overflow-trigger]`/`[data-overflow-popover]`, `position:fixed` popover with outside-click/Escape close, viewport-edge clamping, scroll/resize repositioning) in `src/webview/planning.html` (CSS) + `src/webview/planning.js` (`initOverflowMenus`, `_positionOverflowPopover`, `_closeAllOverflowPopovers`, `_recomputeAllOverflowTriggers`), then used it for both the preview meta-bar "⋯ More" (Assign/Tags/Attachments/Diagram/+Subtask/To subtask/To parent) and the top-strip "⋯ More" (Full re-fetch/Sync changes/Agent API). Primary inline meta-bar actions are now Edit/Save/Cancel/Push/Comment with Delete pinned far-right; Refresh stays primary on the top strip. Per-provider/state gating preserved — `_toggleSubtaskMetaButtons` and the Attachments/Diagram branches now call `_recomputeAllOverflowTriggers` so the "⋯ More" trigger hides when every item under it is hidden, and `_closeAllOverflowPopovers` runs when the meta bar is hidden. Removed the Refine button from both card renderers + its `data-refine-ticket-id` click-delegation branch, the `copyRefinePrompt` handler in `PlanningPanelProvider.ts`, the `refine_ticket` skill registration in `ClaudeCodeMirrorService.ts` (kept `refine_feature`), and `git rm`'d `.agents/skills/refine_ticket.md`. Sidebar card action row is now always-on with opacity-only dim/brighten (no height change on hover). Moved `#tickets-search` (same id/classes) into a full-width `sidebar-search-row` at the top of `#tree-pane-tickets` with a collapse rule. Files changed: `src/webview/planning.html`, `src/webview/planning.js`, `src/services/PlanningPanelProvider.ts`, `src/services/ClaudeCodeMirrorService.ts`, `.agents/skills/refine_ticket.md` (deleted). No issues encountered; `verbAllowlist.ts` and `KanbanProvider.ts` comments left as auto-generated/stale per plan (harmless, self-cleans on next `catalog:generate`).

