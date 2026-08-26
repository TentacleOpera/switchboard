# Tickets panel: dead controls (attachments + sidebar)

**Complexity:** 5

## Goal

Three Tickets-panel controls that render but do not function. The attachments-modal Reveal button reports success while doing nothing (deleted, replaced with Copy path); attachment chips in the ticket detail fire a background re-download instead of opening the viewer, duplicating the file on disk each click; and the sidebar collapse toggle has fully-ported CSS but no click listener, extraction residue from planning.js.

All three are the same class of defect and the reason they are grouped: a control that is *present* but not *wired*, which the project PRD's contract #6 (capability-gating honesty) forbids outright — "a panel or verb with no headless route/wiring is absent or disabled, never a control that dead-clicks and never a stub that fakes success". Two of the three additionally fake success (`Attachment revealed ✓` for a no-op; `Attachment downloaded ✓` for an unwanted duplicate), so UAT on the browser cockpit could not distinguish them from working controls.

## How the Subtasks Achieve This

- **Delete the attachments-modal "Reveal" button and replace it with "Copy path"**: removes the `revealAttachment` verb end-to-end — button, listener, provider arm, response arm, the orphaned `revealInExplorer` standalone stub, and the generated allow-list entry — and puts a purely client-side clipboard write in the slot it vacated. Kills the feature's clearest fake-success (`revealInExplorer` handed a raw string resolves nothing and returns without throwing) and replaces it with the operation the workflow actually performs, with no verb and no host round-trip.
- **Clicking an attachment tag on a ticket must open the attachment viewer, not silently re-download the file**: repoints the ticket-detail attachment chip from the *acquisition* verb (`downloadAttachment`) to the *presentation* surface (`viewAttachments` → the existing attachments modal), with a pending-focus token that survives the download → re-render round-trip. Turns a chip that dead-ends in a 5-second toast into one that shows the attachment, and eliminates the `-${Date.now()}` duplicate-file-per-click path as a side effect.
- **Wire the Tickets sidebar collapse toggle — the « button has markup and CSS but no click listener**: adds the missing `apply`/`toggle` helpers and the one init-time binding, and persists the flag through `vscode.setState` (live on both hosts) rather than the `persistTab`/`restoredTabState` path, whose read leg `TicketsPanelProvider` never wires. Makes roughly 40 lines of already-ported, already-tuned `.content-row.collapsed #tree-pane-tickets` CSS reachable for the first time.

## Dependencies & sequencing

- **Reveal→Copy path must land before the chip-opens-viewer subtask.** Both rewrite `renderAttachmentsList` in `src/webview/tickets.js` (2808-2929): the first replaces the `isDownloaded` button branch and its listener block, the second appends a focus-consume step after those same listener bindings and describes the row's buttons in its edge cases and UAT steps. Landing them in the other order forces a second rewrite of the same lines and leaves the second plan's text describing a deleted button.
- **The sidebar-toggle subtask has no content dependency** on the other two — it touches the init-bindings region and adds a helper, with no overlap on the attachment surfaces. It can land first, last, or between them.
- **All three must be serialised in the working tree regardless of order.** Every one of them edits `src/webview/tickets.js`; the project PRD's orchestration discipline is one agent stream per provider file, and same-file parallel edits collide.
- **Prerequisite for the Copy-path subtask:** `npm run catalog:generate` must be run (never hand-edit `src/generated/verbAllowlist.ts`), and only the `revealInExplorer` stub in `src/standalone/bootstrap.ts:831` may be deleted — `revealFileInOS` at 830 still has two live callers.
- **Guard against widening:** the two surviving `revealFileInOS` callers (`PlanningPanelProvider.ts:3102`, `TaskViewerProvider.ts:11282`) are the same faked-success shape on the standalone host and are deliberately **out of scope** for this feature. They warrant their own plan; do not pull them in.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Delete the attachments-modal "Reveal" button and replace it with "Copy path"](../plans/feature_plan_20260811143000_attachments_modal_reveal_button_is_a_silent_noop.md) — **PLAN REVIEWED** — ID: 577744ca-3af0-4c5e-a2b0-4b0f177cf059
- [ ] [Clicking an attachment tag on a ticket must open the attachment viewer, not silently re-download the file](../plans/feature_plan_20260811143100_attachment_tag_click_opens_viewer_instead_of_downloading.md) — **PLAN REVIEWED** — ID: 548d7420-854d-41fd-b58b-c9dc0ea42544
- [ ] [Wire the Tickets sidebar collapse toggle — the « button has markup and CSS but no click listener](../plans/feature_plan_20260811143200_tickets_sidebar_collapse_toggle_has_no_click_listener.md) — **PLAN REVIEWED** — ID: ff18076c-c912-4416-a67a-c29095972b50
<!-- END SUBTASKS -->

