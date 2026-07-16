# Plan: Justify Ticket Card Buttons Left

## Problem
Ticket card action buttons (`.ticket-node .card-actions`) are justified to the right (`justify-content: flex-end`), while tree node card actions default to left. This inconsistency makes ticket cards look different from plan cards.

## Root Cause
- `planning.html` line ~2857: `.ticket-node .card-actions { justify-content: flex-end; }`
- `.tree-node .card-actions` has no `justify-content` set (defaults to `flex-start`).

## Fix
Change `justify-content: flex-end` to `justify-content: flex-start` (or remove the property entirely).

### Files to Change
1. **`src/webview/planning.html`** — `.ticket-node .card-actions` rule (~line 2857)

### Change
```css
/* Before */
.ticket-node .card-actions {
    display: flex;
    gap: 4px;
    margin-top: 4px;
    justify-content: flex-end;
}

/* After */
.ticket-node .card-actions {
    display: flex;
    gap: 4px;
    margin-top: 4px;
    justify-content: flex-start;
}
```

## Verification
- Verify ticket card buttons now align to the left, matching tree node cards.
- Verify buttons still wrap correctly on narrow cards.
