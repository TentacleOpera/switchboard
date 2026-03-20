# Column dropdown in ticket view does not work

## Goal
Whenever i try to change the column dropdown in the ticket view of the kanban, it snaps bac kto the original column and does not let me change it. 

## Source Analysis
- `src/webview/review.html:471-472`
  - The ticket view already renders a real column dropdown via `<select id="column-select">`.
- `src/webview/review.html:688-704`
  - `renderColumns(columns, selected)` re-renders the select from the latest ticket data and marks the current column as selected.
- `src/webview/review.html:993-1001`
  - Changing the dropdown posts a `setColumn` ticket update when the selected value differs from `state.column`.
- `src/services/ReviewProvider.ts:158-164` and `376-424`
  - `setColumn` already flows through the same ticket-update pipeline as the other editable metadata fields.
- `src/services/TaskViewerProvider.ts:4900-4910`
  - The `setColumn` update currently only calls `db.updateColumn(sessionId, column)`.
  - It does **not** persist an equivalent workflow/event change to the runsheet.
- `src/services/TaskViewerProvider.ts:1005-1018` and `922-933`
  - Existing manual move flows (`handleKanbanForwardMove`, `handleKanbanBackwardMove`) persist both:
    - a runsheet event/workflow update via `_updateSessionRunSheet(...)`
    - a Kanban DB column update via `db.updateColumn(...)`
- `src/services/TaskViewerProvider.ts:4681-4724`
  - Ticket data prefers the Kanban DB row when present, so the dropdown can briefly show the changed value after `db.updateColumn(...)`.
- `src/services/TaskViewerProvider.ts:755-830`, `1960`, `5780`, and `src/services/KanbanMigration.ts:84-105`
  - The broader Kanban refresh/sync path reconstructs snapshot rows from runsheet events using `deriveKanbanColumn(...)`, then `upsertPlans(...)` writes that derived `kanban_column` back into the DB.
- `src/services/KanbanDatabase.ts:61-74`
  - `upsertPlans(...)` explicitly overwrites `kanban_column` on conflict.
- **Clarification:** the likely bug is not that the dropdown control itself is missing. The likely bug is that ticket-view `setColumn` only updates the DB, while later refresh/sync logic re-derives the “real” column from runsheet history and overwrites the manual selection, causing the visible snap-back.

## Dependencies / Cross-Plan Conflict Scan
- `feature_plan_20260316_070920_add_edit_metadata_icon_to_kanban_cards.md`
  - Direct conceptual overlap. That earlier ticket-view expansion introduced the editable column dropdown idea.
  - This bug fix should repair persistence of that control rather than redesign the ticket metadata UI.
- `feature_plan_20260317_071108_add_move_controls_to_ticket_view.md`
  - Direct implementation overlap. The ticket-view move buttons already use the more complete move path that updates both runsheet state and the DB.
  - This plan should reuse or align with that existing move persistence behavior instead of creating a third column-mutation path.
- `feature_plan_20260317_155208_send_to_agent_button_should_ignore_trigger_setting.md`
  - Shared ticket-view lifecycle surface.
  - This plan should stay scoped to manual column selection and must not change the semantics of the `Send to Agent` action.
- `feature_plan_20260313_140058_allow_plans_to_be_moved_backwards_in_kanban.md`
  - Related move semantics. Backward moves already have an explicit workflow/update path.
  - The dropdown fix should remain compatible with manual backwards/forwards movement history.
- `feature_plan_20260317_062223_restore_review_feature_and_merge_ticket_view.md`
  - Shared ticket-view rendering/update surface.
  - This fix should avoid unrelated changes to review mode, comment flow, or ticket layout.

## Proposed Changes

### Band A — Routine / Low Complexity
1. Reframe the fix as a persistence mismatch, not a dropdown-widget bug
   - **Files to inspect/fix:** `src/webview/review.html`, `src/services/ReviewProvider.ts`, `src/services/TaskViewerProvider.ts`
   - Keep the existing dropdown UI and update handshake intact unless a smaller bug is found there during implementation.
   - **Clarification:** the likely failing seam is persistence/synchronization after the selection change, not the existence of the `<select>` element or its event listener.
2. Make ticket-view column changes durable across refresh/sync
   - Update the `setColumn` path so a manual column change survives the same refreshes that currently rebuild the Kanban DB from runsheet data.
   - Reuse the existing manual move persistence approach already used by forward/backward Kanban moves wherever possible.
3. Keep the ticket view in sync after a successful column change
   - After the persisted change succeeds, the returned ticket data should reflect the new column consistently so the dropdown does not immediately re-render back to the old value.
   - Preserve the existing `ticketUpdateResult` / `ticketData` refresh loop; fix the underlying data source mismatch rather than adding fragile client-side hacks.
4. Add focused regression coverage for the snap-back scenario
   - Add a targeted regression test proving that a column changed from the ticket view remains changed after the normal refresh/sync path runs.
   - Prefer a source-level or provider-level regression test consistent with existing project patterns over introducing browser automation.

### Band B — Complex / Risky
1. Align manual ticket-view column edits with workflow/history semantics
   - The ticket view currently bypasses the runsheet event/workflow update that other move paths use.
   - Fixing this safely requires deciding how a dropdown-driven move should be represented in the same durable movement history used by `deriveKanbanColumn(...)`.
   - This is the risky part because it touches the relationship between:
     - editable ticket metadata,
     - runsheet event history,
     - derived Kanban column state,
     - DB snapshot/upsert refresh logic.
2. Avoid introducing a second source of truth for column state
   - The implementation should not “just stop syncing the DB” or special-case the dropdown in a way that leaves the DB and runsheet history disagreeing forever.
   - The correct fix should converge the persisted source of truth so future refreshes, ticket reloads, and board redraws all agree on the selected column.
3. Preserve existing move-control behavior while repairing dropdown edits
   - `Send to Agent`, backward/forward moves, and existing board moves already encode column transitions through established paths.
   - The dropdown fix must not regress those existing workflows or create ambiguous ordering/history when mixed with dropdown-driven moves.

## Verification Plan
1. Open a session-backed plan in the ticket view and change the column dropdown to a different valid column.
   - Confirm the selection stays changed immediately after the update completes.
2. Reload the ticket view after changing the column.
   - Confirm the dropdown still shows the new column and does not snap back.
3. Refresh/redraw the Kanban board after the dropdown change.
   - Confirm the card appears in the newly selected column.
4. Perform a known-good move using the existing ticket-view lifecycle controls and confirm those flows still behave exactly as before.
5. Confirm mixed behavior remains sane:
   - dropdown change,
   - reload,
   - subsequent `Send to Agent` or manual move,
   - no unexpected snap-back or stale column display.
6. Run targeted validation:
   - `npm run compile`
   - `npm run compile-tests`
   - the new focused regression test for ticket-view column persistence.

## Open Questions
- None.

## Complexity Audit

### Band A — Routine
- Keep the existing dropdown UI and update handshake.
- Fix the durable persistence of ticket-view column edits.
- Add targeted regression coverage for the snap-back scenario.

### Band B — Complex / Risky
- Align ticket-view manual column edits with the same runsheet/history semantics used by existing move flows.
- Eliminate the DB-vs-runsheet source-of-truth mismatch that currently causes refresh-time overwrite.
