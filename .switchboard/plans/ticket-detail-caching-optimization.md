# Ticket Detail Caching Optimization

## Goal

Eliminate the API round-trip delay when clicking on tickets that have already been viewed. Currently, every click on a ticket triggers a fresh API fetch for details (subtasks, comments, attachments), even if those details were already loaded. This causes a noticeable delay on every interaction.

## Metadata

- **Tags:** frontend, performance, ui, ux
- **Complexity:** 3

## User Review Required

None. This is a self-contained frontend optimization with no external API contract changes.

## Complexity Audit

### Routine
- Adding two `Map` declarations to module-level state.
- Wrapping existing click handler with `if (cache.has(id))` branches.
- Adding two `cache.set(...)` calls in existing message handlers.
- Clearing caches in existing reset/refresh handlers.

### Complex / Risky
- None

## Problem Analysis

**Current Behavior:**
- When the tickets list loads, `queryIssues()` fetches basic issue fields (id, title, description, state, assignee, etc.)
- When a user clicks a ticket, `loadLinearTaskDetails()` or `loadClickUpTaskDetails()` always calls the API to fetch full details (subtasks, comments, attachments, rendered HTML)
- This happens even if the same ticket was already viewed and its details are still in memory

**Root Cause:**
- The click handler in `planning.js` (lines 5341-5350) unconditionally calls `loadLinearTaskDetails()` or `loadClickUpTaskDetails()`
- These functions (lines 6292-6297, 6330-6335) always send a `vscode.postMessage` to fetch from the backend
- No caching mechanism exists for the full ticket details
- The `selectedLinearIssue` and `selectedClickUpIssue` variables store the currently selected ticket's details, but these are not reused when re-selecting the same ticket

**Why This Matters:**
- Users frequently toggle between tickets while reviewing work
- Each toggle incurs a 0.5-2 second API delay
- The data being fetched (subtasks, comments, attachments) is relatively static during a session
- This creates a poor UX for what should be instant navigation

## Solution Design

**Caching Strategy:**
1. Extend the existing `linearProjectIssues` and `clickUpProjectIssues` arrays to include full detail fields when available
2. Add a separate `Map` cache for tickets that have been fully loaded (to avoid bloating the list arrays)
3. On ticket click, check the cache first before calling the API
4. Cache is populated when details are successfully fetched
5. Cache is invalidated on explicit refresh or workspace switch

**Data Flow:**
```
User clicks ticket
  ↓
Check if ticket ID in detail cache
  ↓
Yes → Use cached details (instant render)
  ↓
No → Call API to fetch details
  ↓
Store result in cache
  ↓
Render details
```

## Proposed Changes

### `src/webview/planning.js`

#### Context
The webview maintains `selectedLinearIssue` and `selectedClickUpIssue` to render ticket details. Currently, every click unconditionally triggers `loadLinearTaskDetails()` or `loadClickUpTaskDetails()`, which posts to the backend even if the data was already fetched. We add in-memory Maps to store fetched details keyed by issue/task ID.

#### Logic
1. Check cache on click.
2. If miss, call existing loader (which posts to backend).
3. On backend response, populate cache before rendering.
4. Clear cache on workspace switch (`resetTicketsInMemoryState`) and manual refresh.

#### Implementation

**Step 1 — Cache declarations (around line 214)**
Add after the existing `_lastTickets...` variables:
```javascript
// Full detail caches for tickets that have been expanded
let linearIssueDetailCache = new Map(); // issueId -> { issue, subtasks, comments, attachments, renderedDescriptionHtml }
let clickUpTaskDetailCache = new Map(); // taskId -> { task, subtasks, comments, attachments, renderedDescriptionHtml }
```

**Step 2 — Cache invalidation in `resetTicketsInMemoryState()` (around line 6402)**
Insert inside the function:
```javascript
linearIssueDetailCache.clear();
clickUpTaskDetailCache.clear();
```

**Step 3 — Update the ticket click handler (around line 5341-5350)**
```javascript
const card = e.target.closest('[data-linear-issue-id], [data-clickup-task-id]');
if (card) {
    const linearId = card.dataset.linearIssueId;
    const clickUpId = card.dataset.clickupTaskId;
    if (linearId) {
        if (linearIssueDetailCache.has(linearId)) {
            selectedLinearIssue = linearIssueDetailCache.get(linearId);
            renderTicketsLinearPanel();
        } else {
            loadLinearTaskDetails(linearId);
        }
    } else if (clickUpId) {
        if (clickUpTaskDetailCache.has(clickUpId)) {
            selectedClickUpIssue = clickUpTaskDetailCache.get(clickUpId);
            renderTicketsClickUpPanel();
        } else {
            loadClickUpTaskDetails(clickUpId);
        }
    }
}
```

**Step 4 — Update `linearTaskDetailsLoaded` message handler (around line 3352)**
```javascript
case 'linearTaskDetailsLoaded':
    selectedLinearIssue = {
        issue: msg.issue,
        subtasks: msg.subtasks || [],
        comments: msg.comments || [],
        attachments: msg.attachments || [],
        renderedDescriptionHtml: msg.renderedDescriptionHtml
    };
    // Cache the full details
    linearIssueDetailCache.set(msg.issue.id, selectedLinearIssue);
    renderTicketsTab();
    break;
```

**Step 5 — Update `clickupTaskDetailsLoaded` message handler (around line 3466)**
```javascript
case 'clickupTaskDetailsLoaded':
    selectedClickUpIssue = {
        task: msg.task,
        subtasks: msg.subtasks || [],
        comments: msg.comments || [],
        attachments: msg.attachments || [],
        renderedDescriptionHtml: msg.renderedDescriptionHtml
    };
    // Cache the full details
    clickUpTaskDetailCache.set(msg.task.id, selectedClickUpIssue);
    renderTicketsTab();
    break;
```

**Step 6 — Cache invalidation in refresh button handler (around line 5251)**
```javascript
document.getElementById('tickets-refresh')?.addEventListener('click', () => {
    linearIssueDetailCache.clear();
    clickUpTaskDetailCache.clear();
    if (lastIntegrationProvider === 'linear') {
        loadLinearProject(true);
    } else {
        loadClickUpProject(true);
    }
});
```

**Step 7 — Cache is already cleared in `resetTicketsInMemoryState()` which is called on workspace switch (Step 2)**

#### Edge Cases
- **Reference mutation:** Cache stores object references. Render logic must not mutate `selectedLinearIssue` or `selectedClickUpIssue` properties directly, as this would poison cached entries for future clicks.
- **Stale data after external edits:** If a teammate updates a ticket, the cached details will be stale until the user clicks Refresh or switches workspaces. This is acceptable per product requirements.
- **Subtask navigation:** Subtask clicks call the same loader functions and will automatically benefit from the same cache.

## Edge-Case & Dependency Audit

### Race Conditions
- None expected. The cache is synchronous and single-threaded. No async operations touch the cache directly.

### Security
- None. Cache is in-memory only within the webview context. No sensitive data is persisted to disk or exposed.

### Side Effects
- **Memory growth:** Unbounded `Map` growth in very long sessions. Mitigation: typical usage is <100 tickets; manual refresh or workspace switch clears the cache.
- **Reference mutation risk:** `selectedLinearIssue` and cache entries point to the same object. If render logic mutates the selected issue, the cache becomes poisoned. The existing code treats these objects as read-only during rendering, but this is an implicit contract.
- **Stale data after external edits:** If a teammate updates a ticket, the cached details will be stale until the user clicks Refresh or switches workspaces. This is acceptable per product requirements.

### Dependencies & Conflicts
- No dependencies on other plans or backend changes.
- Conflicts: None. The change is additive and does not modify existing function signatures or message contracts.

## Edge Cases & Considerations

**Cache Key Uniqueness:**
- Linear: issue ID is globally unique
- ClickUp: task ID is globally unique within a workspace
- Cache is workspace-scoped via `resetTicketsInMemoryState()` on workspace switch

**Memory Management:**
- Cache is in-memory only (cleared on extension reload)
- No size limit needed - typical session has <100 tickets viewed
- If memory becomes a concern, add LRU eviction with 200-item limit

**Stale Data:**
- User can manually refresh via Refresh button (clears cache)
- Subtasks/comments/attachments don't change frequently during a session
- If user needs fresh data, they can click Refresh

**Subtask Navigation:**
- Subtask clicks already call `loadLinearTaskDetails()` or `loadClickUpTaskDetails()`
- These will benefit from the same cache check
- No additional changes needed

**Error Handling:**
- If API fetch fails, cache is not populated
- Subsequent clicks will retry the API fetch
- No special error handling needed beyond existing

## Dependencies

- None

## Adversarial Synthesis

Key risks: unbounded memory growth in extreme sessions and potential reference mutation poisoning if render logic ever mutates cached objects. Mitigations: cache is scoped to workspace/session and cleared on refresh/switch; objects are treated as immutable by convention.

## Verification Plan

### Automated Tests
No automated test changes required for this frontend-only optimization. Manual verification per checklist below.

### Manual Verification

- [ ] Click a ticket for the first time → API fetch occurs
- [ ] Click the same ticket again → Instant render (no API call)
- [ ] Click a different ticket → API fetch occurs
- [ ] Click back to the first ticket → Instant render (from cache)
- [ ] Click Refresh button → Cache cleared, next click fetches from API
- [ ] Switch workspaces → Cache cleared
- [ ] Navigate subtasks → Cached data used where available
- [ ] Verify no console errors related to cache operations

## Files Modified

1. `src/webview/planning.js` - Add cache structures, modify click handler, update message handlers

---

**Recommendation:** Send to Intern
