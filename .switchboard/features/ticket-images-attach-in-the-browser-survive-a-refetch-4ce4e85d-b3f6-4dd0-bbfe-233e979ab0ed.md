# Ticket Images - Attach in the Browser, Survive a Refetch

**Complexity:** 5

## Goal

Make inline images in the ticket editor work for someone sitting in front of a browser rather than an IDE. The attach-image button opens the file picker in VS Code instead of in the browser cockpit or the standalone host, and a refetch leaves description images blank until the operator clicks the same ticket a second time.

## How the Subtasks Achieve This

- **Tickets attach-image opens the file picker in VS Code, not in the browser** — makes the attach-image button work for an operator sitting in front of the browser cockpit or the standalone host.
- **Refetch leaves inline images blank until second click** — refreshes the detail pane when the import completes, so description images survive a refetch without a second click on the same ticket.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Tickets attach-image opens the file picker in VS Code, not in the browser](../plans/feature_plan_20260817160854_tickets-attach-image-opens-the-file-picker-in-vs-code-not-the-browser.md) — **PLAN REVIEWED**
- [ ] [Refetch Leaves Inline Images Blank Until Second Click — Refresh Detail Pane in importAllTicketsComplete](../plans/feature_plan_20260818084137_refetch-leaves-inline-images-blank-until-second-click.md) — **PLAN REVIEWED**
<!-- END SUBTASKS -->

## Dependencies & sequencing

No ordering constraints; independent defects. Both concern inline images in the ticket editor and can be verified in the same manual pass.

