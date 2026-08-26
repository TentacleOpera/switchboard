# Tickets sidebar: subtask visibility and card controls

**Complexity:** 5

## Goal

Makes parent/child relationships visible and controllable from the Tickets sidebar. Convert-to-subtask stamps parentId into the local ticket file so the file-backed sidebar actually reflects the change; cards gain a subtask count; drill-down becomes an explicit click on that count instead of a side effect of selecting a ticket; and the per-card overflow menu collapses to a direct Move button.

## How the Subtasks Achieve This

- **Convert-to-subtask must stamp `parentId` into the local ticket file and refresh the sidebar**: `convertToSubtask` currently updates only the remote (ClickUp/Linear) and never the local `.md`, so the file-backed sidebar keeps rendering the converted ticket as a top-level card forever. This splices `parentId:` into the ticket file's frontmatter (re-stamping `lastSyncedAt` so the write does not falsely badge the ticket as `modified`), invalidates both ends of the detail cache, and re-lists local files. It supplies the parentage data every other subtask reads.
- **Subtask-count chip on Tickets sidebar cards, and make it the only drill-down affordance**: tallies each ticket's locally-imported children in `listLocalTicketFiles` (both the DB-backed path and the filesystem-scan fallback), ships the count to the webview, and renders it as a clickable chip on the card. In the same change it removes the implicit drill-down arming from the card-click handler, so selecting a ticket no longer replaces the sidebar list — the chip becomes the deliberate way in. Count display and drill-down trigger are one element, which is why they are one subtask.
- **Replace the sidebar ticket card's overflow menu with a direct Move button**: strips the per-card "⋯" popover, whose only two items were Move and a `+ Subtask` that duplicates the control strip's own. Move becomes a plain fourth card button beside *To kanban · Link · Open*, with an early return in the container listener so a Move click no longer also selects the card. Deletes the popover-reparenting hop, the dead `+ Subtask` listener, and one click.

## Dependencies & sequencing

- **Land `parentId` stamping before the subtask-count chip.** The chip's file-derived count is built from `parentId:` frontmatter. Until conversion writes that key, only import-time-parented tickets are counted, so the chip demos as under-counting and the two changes cannot be verified together. Not a code dependency — each compiles and ships alone — but a verification one.
- **Serialise the count-chip subtask and the Move-button subtask.** Both edit `_renderClickUpTicketCard` / `_renderLinearTicketCard` in `src/webview/tickets.js` and both add branches to the same `#tickets-issues-container` delegated listener. Different lines and no logical conflict, so either order works — but one agent stream at a time, merged between, per the same-file rule.
- **Guard that must stay in place:** `_maybeEnterDrillDown`'s `_pendingDrillDownParentId !== id` check (`src/webview/tickets.js:3465`) becomes load-bearing once implicit arming is removed — it is then the only thing stopping the detail-loaded arms from drilling on an ordinary selection. Do not simplify it away.
- **Handler-order guard:** the chip lives inside the card's `[data-edit-status]` row, whose listener branch selects the ticket, opens the status modal and returns. The chip's branch must be registered above it.
- The Move-button subtask is otherwise independent of the other two and can land at any point.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Convert-to-subtask must stamp `parentId` into the local ticket file and refresh the sidebar](../plans/feature_plan_20260811100143_convert_to_subtask_stamps_parentid_and_refreshes_sidebar.md) — **CODE REVIEWED** — ID: 0023cd2f-abba-4e29-9898-43411749c4da
- [ ] [Replace the sidebar ticket card's overflow menu with a direct Move button](../plans/feature_plan_20260811100143_replace_sidebar_card_overflow_menu_with_direct_move_button.md) — **CODE REVIEWED** — ID: 1161ed65-cd4c-4cfd-8bae-d595eddd3fd0
- [ ] [Subtask-count chip on Tickets sidebar cards, and make it the only drill-down affordance](../plans/feature_plan_20260811100143_subtask_count_chip_is_the_explicit_drilldown_affordance.md) — **CODE REVIEWED** — ID: 4d3c8dc1-eca8-409f-b8d8-1acb68c29424
<!-- END SUBTASKS -->

## Review Findings

Reviewer pass over all three subtasks, reviewed as one diff since they share `TicketsPanelProvider.ts` and `webview/tickets.js`. Six MAJOR findings fixed: two file-corruption vectors in `_stampTicketParentIdInFile` (`String.replace` expanding `$&`/`` $` `` out of user frontmatter; a CRLF file getting a second `---` block that shadowed every other key), a status message that reported a failed write as "no local file to update", a Move-listener comment claiming the drill-down parent card renders outside `#tickets-issues-container` when it does not, a full-list flash from nulling `_drillDownSubtasks` before a synchronous re-render, and the complete absence of the automated tests all three plans specified. Tests were added to `verb-engine-tickets-headless.test.js` (6 behavioural) and `tickets-sidebar-list-scoping.test.js` (8 contract assertions) — both already invoked by `.github/workflows/integration-tests.yml`, so no check landed defined-but-unwired. Gate-wiring audit: all three named checks are CI-invoked (`verb-engine-tickets` :212, `tickets-sidebar-scoping` :278, `tickets-auto-refresh` :315). Verification was executed, not static: `npm run compile-tests` clean, `node --check src/webview/tickets.js` clean, 44/44 in `verb-engine-tickets` and all 8 CI-wired tickets suites green.

## Completion Report

Implemented all three subtasks in one pass. `TicketsPanelProvider` now stamps `parentId` into local `.md` files during `convertToSubtask`, re-stamps `lastSyncedAt` to avoid a false `modified` badge, and tallies file-derived subtask counts in both the DB-backed and scan-fallback `listLocalTicketFiles` paths. The sidebar card renderers now show a clickable subtask-count chip and a direct `Move` button, with the chip wired as the only drill-down affordance and card clicks no longer arming drill-down. Removed the dead `+ Subtask` card overflow listener and updated the `subtaskConverted` webview handler to invalidate caches and refresh the file-backed list. No issues encountered; no tests or compile steps were run per the provided skip flags.

**Reviewer pass (2026-08-11).** Applied six MAJOR fixes across `src/services/TicketsPanelProvider.ts`, `src/webview/tickets.js`, `src/test/verb-engine-tickets-headless.test.js` and `src/test/tickets-sidebar-list-scoping.test.js` — two frontmatter-corruption vectors in the parentId stamp, an honest failure message for a failed local write, a false comment about where the drill-down parent card renders, removal of a drill-down list flash, and the missing automated coverage all three plans specified. The plan files' "no tests were run per the skip flags" note was treated as a record of the coding pass, not a directive: this dispatch carried no SKIP TESTS/SKIP COMPILATION line, so verification was run independently. No issues remain open; residual risks are cosmetic and named in each subtask's Review Findings.
