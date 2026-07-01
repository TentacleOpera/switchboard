# Comments Manager in Tickets Tab Does Not Show Replies After Refetch

## Goal

### Problem
The comments manager in the Tickets tab of `planning.html` does not show replies to comments you post, even after clicking refresh or refetch. When a user posts a reply, the reply appears briefly (optimistic insert) but then disappears when the backend refetch completes.

### Background
The comments manager supports threaded comments for Linear and ClickUp tickets. When a user posts a reply:
1. The frontend optimistically inserts the reply into the UI (`optimisticInsertComment`)
2. The frontend sends a `postTicketReply` message to the backend
3. The backend posts the reply to the provider API (Linear/ClickUp)
4. The backend **immediately** refetches all comments via `loadTicketComments`
5. The backend sends `ticketCommentsLoaded` back to the frontend
6. The frontend **replaces all threads** with the refetched data, discarding the optimistic reply

### Root Cause
**API propagation delay + optimistic insert overwrite.** The refetch at step 4 happens immediately after the reply is posted. Linear and ClickUp's backends have eventual consistency — the newly posted reply may not yet be indexed when the fresh query executes. The refetch returns threads without the new reply, and the `ticketCommentsLoaded` handler at `planning.js:4776` replaces `_cmThreads` entirely (`_cmThreads = msg.threads || []`), discarding the optimistic insert.

The same issue affects the manual refresh button: if the user clicks refresh before the API has propagated the reply, the reply vanishes.

## Metadata
- **Tags**: `planning`, `comments`, `tickets`, `linear`, `clickup`, `bug`
- **Complexity**: 5

## Complexity Audit
**Routine with a twist.** The fix involves two coordinated changes:
1. **Frontend**: Preserve optimistic replies across refetch by merging instead of replacing — this is straightforward state-merging logic.
2. **Backend**: Add a short delay before refetching to allow API propagation — a one-line change but introduces a latency tradeoff.

The twist is that optimistic replies need to be reconciled with real data once the API eventually returns them. We need to match optimistic entries to real entries by content/timestamp and replace them, rather than showing duplicates. This is moderately complex but well-bounded.

## Edge-Case & Dependency Audit
- **Edge case: User posts multiple replies quickly.** Each optimistic insert must be preserved independently. The merge logic must handle multiple pending optimistic replies.
- **Edge case: API never propagates the reply.** The optimistic reply stays visible indefinitely. This is acceptable — it's better than the reply vanishing. A subsequent manual refresh will eventually pick it up.
- **Edge case: Optimistic reply matches a real reply by content.** When the API does return the reply, we should replace the optimistic entry with the real one (which has a proper ID, author info, etc.) rather than showing both.
- **Edge case: Reply posting fails.** The existing `rollbackOptimisticComment` function handles this — no change needed.
- **Dependency: `_pendingRefetchTicketId` / `_refetchStale` guard.** The existing stale-refetch guard at `planning.js:4779-4787` must continue to work alongside the new merge logic.
- **Dependency: Manual refresh button** at `planning.js:8001-8008` also triggers `loadCommentThreads`, which sends `loadTicketComments` and receives `ticketCommentsLoaded`. The merge logic must apply to manual refreshes too — but in this case there are no optimistic inserts to preserve (unless the user refreshes right after posting).
- **No migration needed.** This is unreleased dev behavior — no shipped state to migrate.

## Proposed Changes

### 1. `src/services/TaskViewerProvider.ts` — Add delay before refetch in `postTicketReply`

**File**: `src/services/TaskViewerProvider.ts`, lines 19921-19952

Add a 1500ms delay before refetching to allow the provider API to propagate the new reply:

```typescript
// Refetch threads and update JSON
// Delay to allow provider API propagation — Linear/ClickUp have eventual consistency
// and a fresh query immediately after posting may not include the new reply.
await new Promise(resolve => setTimeout(resolve, 1500));
const loadResult = await this.loadTicketComments(workspaceRoot, { provider, id });
```

### 2. `src/webview/planning.js` — Merge optimistic replies into refetched data

**File**: `src/webview/planning.js`, lines 4773-4789

Instead of blindly replacing `_cmThreads`, merge optimistic entries from the previous state into the refetched data:

```javascript
case 'ticketCommentsLoaded':
    setTicketsLoadingState(false);
    if (msg.success) {
        const newThreads = msg.threads || [];
        // Preserve optimistic replies that haven't been confirmed by the API yet.
        // Match by body+author+timestamp proximity to replace optimistic with real.
        _cmThreads = mergeOptimisticReplies(_cmThreads, newThreads);
        _cmMembers = msg.members || [];
        _cmThreadingSupported = msg.threadingSupported !== false;
        // Refetch stale guard: if a new optimistic insert arrived
        // while this refetch was pending, discard and re-fetch.
        if (_pendingRefetchTicketId === msg.id) {
            _pendingRefetchTicketId = null;
            if (_refetchStale) {
                _refetchStale = false;
                loadCommentThreads(msg.provider, msg.id);
                break;
            }
        }
        renderCommentManager(_cmThreads, _cmMembers);
    } else {
        // ... existing error handling ...
    }
    break;
```

### 3. `src/webview/planning.js` — Add `mergeOptimisticReplies` helper function

Add a new helper function near `optimisticInsertComment` (around line 862):

```javascript
/**
 * Merge optimistic replies from oldThreads into newThreads.
 * - For each optimistic reply in oldThreads that has a matching real reply
 *   in newThreads (matched by body content), the optimistic entry is replaced
 *   by the real one (which has a proper ID and author info).
 * - For each optimistic reply with NO match in newThreads, it is preserved
 *   (appended to the corresponding thread's replies).
 */
function mergeOptimisticReplies(oldThreads, newThreads) {
    if (!oldThreads || !oldThreads.length) return newThreads;
    const oldOptimistic = [];
    // Collect all optimistic entries with their parent thread IDs
    for (const thread of oldThreads) {
        if (thread._optimistic) {
            oldOptimistic.push({ entry: thread, parentId: null });
        }
        if (thread.replies) {
            for (const reply of thread.replies) {
                if (reply._optimistic) {
                    oldOptimistic.push({ entry: reply, parentId: thread.id });
                }
            }
        }
    }
    if (!oldOptimistic.length) return newThreads;

    // For each optimistic entry, check if a matching real entry exists in newThreads
    for (const { entry, parentId } of oldOptimistic) {
        const matched = findMatchingRealEntry(newThreads, entry, parentId);
        if (!matched) {
            // No match — preserve the optimistic entry
            if (parentId) {
                const thread = newThreads.find(t => t.id === parentId);
                if (thread) {
                    thread.replies = thread.replies || [];
                    if (!thread.replies.some(r => r._optimistic && r.body === entry.body)) {
                        thread.replies.push(entry);
                    }
                }
            } else {
                // Top-level optimistic thread
                if (!newThreads.some(t => t._optimistic && t.body === entry.body)) {
                    newThreads.push(entry);
                }
            }
        }
        // If matched, the real entry is already in newThreads — do nothing (optimistic is dropped)
    }
    return newThreads;
}

/**
 * Check if a real (non-optimistic) entry matching the optimistic entry exists.
 * Match by body content (trimmed, case-insensitive) within the same thread.
 */
function findMatchingRealEntry(threads, optimisticEntry, parentId) {
    if (parentId) {
        const thread = threads.find(t => t.id === parentId);
        if (thread && thread.replies) {
            return thread.replies.find(r =>
                !r._optimistic &&
                (r.body || '').trim().toLowerCase() === (optimisticEntry.body || '').trim().toLowerCase()
            );
        }
    } else {
        return threads.find(t =>
            !t._optimistic &&
            (t.body || '').trim().toLowerCase() === (optimisticEntry.body || '').trim().toLowerCase()
        );
    }
    return null;
}
```

## Verification Plan
1. **Manual test with Linear**: Open a ticket in the Tickets tab, open the comments manager, post a reply to an existing comment. Verify the reply stays visible after the automatic refetch completes.
2. **Manual test with ClickUp**: Same as above with a ClickUp ticket.
3. **Manual refresh test**: Post a reply, then immediately click the refresh button. Verify the reply persists.
4. **Multiple rapid replies**: Post two replies in quick succession. Verify both persist after refetch.
5. **Reply replacement**: Post a reply, wait for the API to propagate (2-3 seconds), then click refresh. Verify the optimistic reply is replaced by the real reply (with proper author info and non-optimistic ID).
6. **Failed reply rollback**: Disconnect network, post a reply, verify the optimistic reply is rolled back via the existing `rollbackOptimisticComment` path.
7. **Compile check**: `npm run compile` — verify no TypeScript errors.
