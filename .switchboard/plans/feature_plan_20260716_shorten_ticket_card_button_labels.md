# Plan: Shorten Ticket Card Button Labels

## Problem
Button labels on ticket cards are too wordy: "Add to kanban", "Link to ticket", "Add sub-ticket", "Edit ticket", etc. These take up excessive horizontal space on small cards.

## Root Cause
- In `planning.js`, `_renderClickUpTicketCard` and `_renderLinearTicketCard` use verbose button text.

## Fix
Shorten button labels to 1-2 words max.

### Files to Change
1. **`src/webview/planning.js`** — `_renderClickUpTicketCard` and `_renderLinearTicketCard`

### Label Changes
| Old | New |
|-----|-----|
| Add to kanban | To kanban |
| Link to ticket | Link |
| Add sub-ticket | Sub-ticket |
| Edit ticket | Edit |
| Attach image | Image |
| Save ticket | Save |
| Cancel | Cancel (unchanged) |

## Verification
- Verify buttons fit on one line for most cards.
- Verify tooltips or title attributes still provide full context.
- Verify all button actions still work correctly.
