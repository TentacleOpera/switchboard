# Tickets Tab Interaction UX

**Complexity:** 4

## Goal

Improve the Tickets tab interaction model so users can edit tickets more directly — replacing the crude flat-dropdown Move modal with the existing themed Source/hierarchy modal, and making the status and assignee labels on sidebar cards clickable to open edit modals without first selecting the card and traveling to the detail pane. Both are webview-only changes confined to planning.js and planning.html.

## How the Subtasks Achieve This

- **Replace the Move-Ticket modal with the Source modal + Apply**: Rewires `showMoveTicketModal` to open the existing `tickets-source-modal` in a move mode with an Apply button, reusing the hierarchy nav for target selection. Eliminates the bespoke inline-styled flat-dropdown modal.
- **Make status & assignee labels on ticket sidebar cards open edit modals**: Tags the status/assignee rows on sidebar cards with `data-edit-*` attributes, adds delegated click branches that select the clicked ticket and open the assignee modal (existing) or a new status modal (reusing the existing `changeTicketStatus` message).

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Make status & assignee labels on ticket sidebar cards open edit modals](../plans/feature_plan_20260714100700_ticket_sidebar_status_assignee_modals.md) — **CODE REVIEWED**
- [ ] [Replace the Move-Ticket modal with the Source modal + Apply](../plans/feature_plan_20260714101818_replace-move-ticket-modal-with-source-modal.md) — **CODE REVIEWED**
<!-- END SUBTASKS -->

## Dependencies & sequencing

No hard ordering constraints; subtasks can be executed in parallel. Both modify `planning.js` and `planning.html` but touch different functions/DOM regions (move modal vs card render + delegated click handler), so merge conflicts are unlikely.

## Completion Report

Implemented both subtasks as webview-only changes confined to `src/webview/planning.js` and `src/webview/planning.html`. Subtask 1 (sidebar card labels): tagged the status/assignee rows in `_renderLinearTicketCard`/`_renderClickUpTicketCard` with `data-edit-status`/`data-edit-assignees` (+ provider/ticket-id), added a `_selectTicketFromCard` helper that selects the clicked ticket (from detail cache or sidebar list, with drill-down subtask fallback) without entering drill-down, added two delegated click branches that select-then-open the relevant modal, added a new themed `#ticket-status-modal` (markup + CSS + `showTicketStatusModal`/`closeTicketStatusModal` + Save wiring reusing the existing `changeTicketStatus` message), and reused the existing `openAssignModal` for assignee edits. Subtask 2 (Move modal): replaced the bespoke inline-styled `#move-ticket-modal` with a move-mode opener for the existing themed `#tickets-source-modal` — for ClickUp the existing hierarchy nav (space→folder→list) is used for move-target browsing (the core fix: replaces the flat unsorted mega-list with the hierarchy browser), with the active ClickUp hierarchy state snapshotted on enter and restored on exit (`_moveHierarchySnapshot`) so move-mode browsing does not mutate or persist the user's active source; the `tickets-list-select` change handler is guarded with a `_moveMode` check that captures the selected list id as `_moveSelectedTargetId`, enables Apply, and bails before `loadClickUpProject`/`clickupSaveListSelection`/`saveTicketsState`. For Linear (no hierarchy nav exists) a themed target `<select>` populated via `fetchMoveTargets` is shown instead. Added `#tickets-source-move-controls` (Linear flat select + search + refresh + unassign checkbox) and an `#btn-apply-move-ticket` button, introduced `_moveMode`/`_moveTicketId`/`_moveProvider`/`_moveSelectedTargetId` state with `exitMoveMode()` teardown, repointed `moveTargetsResult`/`moveTicketResult` at the new elements, guarded `renderTicketsClickUpPanel` to not reset the hierarchy nav display during move mode, and wired all Source-modal close paths to call `exitMoveMode()`. Files changed: `src/webview/planning.js`, `src/webview/planning.html`. No issues encountered; `node --check` passes.

## Review Findings

Both subtasks reviewed in-place against their plan files. Subtask 1 (status/assignee modals): no CRITICAL/MAJOR findings — 4 NITs deferred (redundant `stopPropagation`, ClickUp status value edge case, subtask status update gap, skipped subtask import). Subtask 2 (Move modal → Source modal): 2 CRITICAL findings fixed — space/folder change handlers were not `_moveMode`-guarded (persisted browsing state to ClickUp config during move-mode hierarchy navigation), and `clickupFoldersLoaded`/`clickupListsLoaded` result handlers were not stale-result-guarded (late-arriving fetch results could corrupt restored state after `exitMoveMode()`). Fixes applied to `src/webview/planning.js`: added `_moveMode` guards to space/folder change handlers (skip `saveTicketsState`/`clickupSaveSpaceSelection`/`clickupSaveFolderSelection`, keep `clickupLoadFolders`/`clickupLoadLists`), and added `msg.spaceId`/`msg.folderId` mismatch guards to the two result handlers. `node --check` passes after fixes. Remaining risks: ClickUp status-value edge case (NIT), stale-result guard assumes `spaceId`/`folderId` present in result messages (confirmed in backend).
