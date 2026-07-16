# Plan: Sort Tickets by Priority Within Status Groups

## Problem
Tickets in the sidebar are sorted only by dateCreated (newest-first) within each status group. Priority is ignored, so high-priority tickets get buried below low-priority ones.

## Root Cause
- `getFilteredLinearIssues()` (planning.js) sorts by `dateCreated` then `title` — no priority consideration.
- `getFilteredClickUpTasks()` (planning.js) sorts by `dateCreated` then `title` — no priority consideration.
- `_groupTicketsByStatus()` preserves the internal order from the filtered arrays, so the sort from the filter functions is what the user sees.

## Fix
Add priority as a secondary sort key within each status group, after the primary status-group sort.

### Files to Change
1. **`src/webview/planning.js`** — `getFilteredLinearIssues()` and `getFilteredClickUpTasks()`
   - After the existing dateCreated sort, add a priority sort within each status group.
   - For Linear: sort by `priority` field (1=urgent, 4=low) ascending within each status group.
   - For ClickUp: sort by `priority` field (1=urgent, 5=low) ascending within each status group.
   - Or: add priority comparison in `_groupTicketsByStatus()` after grouping.

### Approach
Modify `_groupTicketsByStatus()` to sort each group's array by priority (ascending: urgent first) as a secondary key after dateCreated. This is cleaner than modifying both filter functions.

```js
// In _groupTicketsByStatus(), after building each group array:
group.sort((a, b) => {
    const pa = a.priority || 99;
    const pb = b.priority || 99;
    if (pa !== pb) return pa - pb; // lower number = higher priority
    // tiebreak: keep existing dateCreated order (newest first)
    return new Date(b.dateCreated) - new Date(a.dateCreated);
});
```

## Verification
- Open tickets tab, verify high-priority tickets appear at top of each status group.
- Verify tickets with no priority fall to bottom of their group.
- Verify dateCreated order is preserved among same-priority tickets.
