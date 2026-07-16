# Plan: Fix Status/Assignees Clickable Area on Ticket Cards

## Problem
The "Status" and "Assignees" meta rows on ticket cards are full-width divs. The click handler uses `closest('[data-edit-status]')` / `closest('[data-edit-assignees]')`, so clicking anywhere on the row — including empty space to the right of the text — triggers the edit action.

## Root Cause
- In `planning.js`, `_renderClickUpTicketCard` and `_renderLinearTicketCard` render meta rows as:
  ```html
  <div class="tickets-issue-meta" data-edit-status="...">
    <span class="kanban-meta-label">Status:</span>
    <span class="ticket-status-text">Open</span>
  </div>
  ```
- The `tickets-issue-meta` div is `display: flex` and full-width, so the entire row is the click target.
- Click handler: `e.target.closest('[data-edit-status]')` matches the full-width div.

## Fix
Wrap only the label + value in an inline span that carries the `data-edit-*` attribute, so only the text area is clickable.

### Files to Change
1. **`src/webview/planning.js`** — `_renderClickUpTicketCard` and `_renderLinearTicketCard`
   - Move `data-edit-status` and `data-edit-assignees` from the outer `tickets-issue-meta` div to an inner `<span>` with `display: inline-flex` or `display: inline-block`.
   - Add `cursor: pointer` to the inner span.

### Example
```html
<div class="tickets-issue-meta">
  <span class="ticket-meta-clickable" data-edit-status="..." style="display:inline-flex;align-items:center;cursor:pointer;">
    <span class="kanban-meta-label">Status:</span>
    <span class="ticket-status-text">Open</span>
  </span>
</div>
```

## Verification
- Click on the text "Status: Open" → edit dialog opens.
- Click on empty space to the right of the text on the same row → nothing happens.
- Same test for Assignees row.
