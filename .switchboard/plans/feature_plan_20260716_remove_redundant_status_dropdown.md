# Plan: Remove Redundant Status Setter Dropdown from Tickets Preview Meta Bar

## Problem
The `select-status-ticket` dropdown in the tickets preview meta bar is redundant — status can now be set directly on the ticket cards in the sidebar via the clickable status row.

## Root Cause
- `planning.html` line 3859: `<select id="select-status-ticket" ...>` inside `tickets-preview-meta-bar`.
- The dropdown is populated and managed by JS code in `planning.js` that listens for ticket selection and populates statuses.
- The `data-edit-status` clickable row on cards already provides this functionality.

## Fix
Remove the `select-status-ticket` dropdown and its wrapper `kanban-meta-group` from the HTML, and remove associated JS initialization/handling code.

### Files to Change
1. **`src/webview/planning.html`** — Remove the `kanban-meta-group` div containing `select-status-ticket` (around line 3856-3860).
2. **`src/webview/planning.js`** — Remove code that:
   - Populates `select-status-ticket` with status options.
   - Handles `change` events on `select-status-ticket`.
   - References `select-status-ticket` by ID.

## Verification
- Verify ticket cards still allow status changes via the clickable status row.
- Verify the preview meta bar no longer shows a status dropdown.
- Verify no JS errors from missing element references.
