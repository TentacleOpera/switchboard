# Comments Manager in Tickets Tab Does Not Show Replies After Refetch

**Plan ID:** a2b7c8d9-1e2f-3a4b-5c6d-7e8f9a0b1c2d

## Goal

### Problem
The comments manager in the Tickets tab of `planning.html` does not show replies to comments you post, even after clicking refresh or refetch. When a user posts a reply, the reply appears briefly (optimistic insert) but then disappears when the backend refetch completes.

### Background
The comments manager supports threaded comments for Linear and ClickUp tickets. When a user posts a reply:
1. The frontend optimistically inserts the reply into the UI (`optimisticInsertComment` at `planning.js:842`)
2. The frontend sends a `postTicketReply` message to the backend
3. The backend posts the reply to the provider API (Linear/ClickUp)
4. The backend **immediately** refetches all comments via `loadTicketComments` (`TaskViewerProvider.ts:20054`)
5. The backend sends `ticketCommentsLoaded` back to the frontend
6. The frontend **replaces all threads** with the refetched data, discarding the optimistic reply (`planning.js:4776`: `_cmThreads = msg.threads || []`)

### Root Cause
**API propagation delay + optimistic insert overwrite.** The refetch at step 4 happens immediately after the reply is posted. Linear and ClickUp's backends have eventual consistency — the newly posted reply may not yet be indexed when the fresh query executes. The refetch returns threads without the new reply, and the `ticketCommentsLoaded` handler at `planning.js:4776` replaces `_cmThreads` entirely (`_cmThreads = msg.threads || []`), discarding the optimistic insert.

The same issue affects the manual refresh button: if the user clicks refresh before the API has propagated the reply, the reply vanishes.

### Implementation Note: `_optimistic` Flag
The `_optimistic: true` flag is set by the **callers** before calling `optimisticInsertComment`, not by `optimisticInsertComment` itself:
- Reply insertion (`planning.js:827`): sets `_optimistic: true` on the reply object before calling `optimisticInsertComment`
- Top-level comment insertion (`planning.js:7993`): sets `_optimistic: true` on the thread object before calling `optimisticInsertComment`

The merge logic depends on this flag being present on optimistic entries. Backend data never includes `_optimistic`. This is correct — the flag distinguishes frontend-only entries from API-confirmed entries.

## Metadata
- **Tags**: bugfix, ui, reliability
- **Complexity**: 5/10

## User Review Required
None. The fix is a two-pronged approach (propagation delay + optimistic merge) that preserves user-posted replies across refetches. The 1500ms delay is a probabilistic mitigation — the merge logic is the deterministic guarantee.

## Complexity Audit

### Routine
- Adding a 1500ms `setTimeout` delay before refetch in `postTicketReply` (one-line change)
- The `ticketCommentsLoaded` handler change from replacement to merge (small refactor of existing handler)

### Complex / Risky
- `mergeOptimisticReplies` helper: collecting optimistic entries, matching by body content, preserving unmatched entries, replacing matched ones — moderately complex state-merging logic
- Body-matching by exact string comparison is fragile (markdown normalization, mention syntax differences between user input and API response) — acceptable for v1, documented as a known limitation
- Interaction between the stale-refetch guard (`_pendingRefetchTicketId` / `_refetchStale`) and the new merge logic — must coexist without double-triggering

## Edge-Case & Dependency Audit
- **Race Conditions**: If an optimistic insert arrives AFTER the refetch response (not during), the stale-refetch guard doesn't catch it — the optimistic data is lost. The merge logic fixes this by preserving optimistic entries across any refetch. The merge is placed BEFORE the guard check in the handler, which is correct: merge first, then check if re-fetch is needed.
- **Security**: No new surfaces. Reply posting uses existing auth.
- **Side Effects**: The 1500ms delay adds latency to the refetch cycle. This is acceptable — the user sees the optimistic reply immediately; the delay only affects when the "confirmed" data arrives.
- **Dependencies & Conflicts**: The existing stale-refetch guard at `planning.js:4779-4787` must continue to work alongside the new merge logic. The manual refresh button at `planning.js:8001-8008` also triggers `loadCommentThreads` — the merge logic applies to manual refreshes too (no optimistic inserts to preserve unless user refreshes right after posting).
- **Edge case: User posts multiple replies quickly.** Each optimistic insert must be preserved independently. The merge logic handles multiple pending optimistic replies.
- **Edge case: API never propagates the reply.** The optimistic reply stays visible indefinitely. This is acceptable — better than the reply vanishing. A subsequent manual refresh will eventually pick it up.
- **Edge case: Optimistic reply matches a real reply by content.** When the API does return the reply, the optimistic entry is replaced by the real one (which has a proper ID, author info). Body-matching by trimmed lowercase comparison may fail if the API normalizes content differently — documented as a known limitation.
- **Edge case: Reply posting fails.** The existing `rollbackOptimisticComment` function (`planning.js:864`) handles this — no change needed.
- **No migration needed.** This is unreleased dev behavior — no shipped state to migrate.

## Dependencies
- None. This plan is self-contained within `TaskViewerProvider.ts` and `planning.js`. No dependency on other plans in this epic.

## Adversarial Synthesis
Key risks: (1) the 1500ms delay is a probabilistic mitigation, not a guarantee — Linear/ClickUp propagation windows vary; the merge logic is the real fix. (2) Body-matching by exact string comparison is fragile when the API normalizes content differently from user input. (3) The `_optimistic` flag is set by callers, not by `optimisticInsertComment` — the plan's original description was factually wrong but the merge logic still works because the flag IS present on optimistic entries. Mitigations: merge logic guarantees preservation regardless of delay; body-matching is acceptable for v1 with documented limitations; line numbers corrected to actual locations (20032-20063 for `postTicketReply`, 842 for `optimisticInsertComment`).

## Proposed Changes

### 1. `src/services/TaskViewerProvider.ts` — Add delay before refetch in `postTicketReply`

**File**: `src/services/TaskViewerProvider.ts`, lines 20032-20063

Add a 1500ms delay before refetching to allow the provider API to propagate the new reply. This is a **probabilistic mitigation** — it reduces the window where optimistic and real entries coexist, making reconciliation simpler. The merge logic (Step 2) is the deterministic guarantee.

```typescript
// Refetch threads and update JSON
// Delay to allow provider API propagation — Linear/ClickUp have eventual consistency
// and a fresh query immediately after posting may not include the new reply.
// This is a probabilistic mitigation; the merge logic in the frontend is the
// deterministic guarantee that preserves optimistic replies.
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

Add a new helper function near `optimisticInsertComment` (around line 842). Note: the `_optimistic` flag is set by the callers of `optimisticInsertComment` (lines 827, 7993), not by `optimisticInsertComment` itself. The merge logic relies on this flag being present on frontend-only entries.

```javascript
/**
 * Merge optimistic replies from oldThreads into newThreads.
 * - For each optimistic reply in oldThreads that has a matching real reply
 *   in newThreads (matched by body content), the optimistic entry is replaced
 *   by the real one (which has a proper ID and author info).
 * - For each optimistic reply with NO match in newThreads, it is preserved
 *   (appended to the corresponding thread's replies).
 *
 * Note: The _optimistic flag is set by the callers of optimisticInsertComment
 * (lines 827, 7993), not by optimisticInsertComment itself. Backend data
 * never includes _optimistic.
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
 * Known limitation: may fail if the API normalizes content differently from
 * user input (e.g. mention syntax, markdown rendering).
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

### Automated Tests
No automated tests run as part of this plan (session directive: skip tests). The test suite will be run separately by the user. Static check: `node -c src/webview/planning.js` for webview syntax.

### Manual
1. **Manual test with Linear**: Open a ticket in the Tickets tab, open the comments manager, post a reply to an existing comment. Verify the reply stays visible after the automatic refetch completes.
2. **Manual test with ClickUp**: Same as above with a ClickUp ticket.
3. **Manual refresh test**: Post a reply, then immediately click the refresh button. Verify the reply persists.
4. **Multiple rapid replies**: Post two replies in quick succession. Verify both persist after refetch.
5. **Reply replacement**: Post a reply, wait for the API to propagate (2-3 seconds), then click refresh. Verify the optimistic reply is replaced by the real reply (with proper author info and non-optimistic ID).
6. **Failed reply rollback**: Disconnect network, post a reply, verify the optimistic reply is rolled back via the existing `rollbackOptimisticComment` path.

> **Session directives:** No compilation step is run as part of verification (project assumed pre-compiled; `src/` is source of truth, `dist/` irrelevant). No automated tests run here.

**Recommendation**: Complexity 5/10 → Send to Coder. Two-file change with merge logic and a delay, well-bounded scope.
