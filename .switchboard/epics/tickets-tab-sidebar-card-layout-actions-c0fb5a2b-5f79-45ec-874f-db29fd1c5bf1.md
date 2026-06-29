---
description: 'Tickets Tab Sidebar Card Layout & Actions'
---

# Tickets Tab Sidebar Card Layout & Actions

## Goal

Make the planning.html Tickets tab sidebar cards self-contained and visually clean by relocating the sync-status badge inline with the status label and adding a per-card Open button so users can open any ticket external URL directly from the sidebar without first selecting it. These two plans both restructure the same Linear and ClickUp card templates — one moves a badge out of the card-actions row, the other adds an Open button into it — and together they complete the sidebar card information architecture.

## How the Subtasks Achieve This

- **Move 'synced' Badge Next to Status Label**: Relocates the sync-status badge (synced/modified/local) from the bottom card-actions row up to the status meta line, sitting inline next to the state name. This frees the action row to hold only buttons and improves information hierarchy.
- **Move 'Open' Button from Ticket Top Bar into Sidebar Cards**: Adds a per-card Open button to the card-actions row (resolving the external ticket URL per provider), so any ticket can be opened in the browser directly from the sidebar. Path A also threads the Linear url through the file-backed pipeline so Linear cards get working Open buttons.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Move 'synced' Badge Next to Status Label in Tickets Tab Sidebar Cards](../plans/feature_plan_20260629154315_move-synced-badge-next-to-status-label.md) — **PLAN REVIEWED**
- [ ] [Move 'Open' Button from Ticket Top Bar into Sidebar Cards](../plans/feature_plan_20260629154316_move-open-button-into-sidebar-cards.md) — **PLAN REVIEWED**
<!-- END SUBTASKS -->
