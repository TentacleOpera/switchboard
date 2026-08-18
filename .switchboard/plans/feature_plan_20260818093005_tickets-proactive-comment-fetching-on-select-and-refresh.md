# Proactive Ticket Comment Fetching on Selection, Refresh, and Refetch

## Goal
In `tickets.html`, comments for tickets are not fetched proactively. Currently, comments are only retrieved lazily when the user explicitly clicks the "Comment" button to open the comment manager modal (`openCommentManager` at `tickets.js` line 2344, which calls `loadCommentThreads` at 2358), and they are never updated during "Refresh" (delta) or "Refetch" (full sync). As a result, comment counts/threads are not pre-cached, and remote comments added by team members remain invisible until the modal is manually toggled.

Comments should be proactively fetched whenever a ticket is selected or loaded in detail view, and comment caches should be automatically refreshed during user-initiated ticket Refresh and Refetch operations.

### Problem & Root Cause Analysis
1. **Lazy Modal-Only Loading**: In `src/webview/tickets.js`, `loadCommentThreads` (line 2372) is invoked exclusively within `openCommentManager` (2358), after comment posting (8004, 8018), and via the comment-manager refresh button (5381). Selecting a ticket card in the sidebar does not trigger `loadCommentThreads`.
2. **Missing Sync in Refresh/Refetch Pipelines**: When the user clicks "Refresh" or "Refetch", `TicketsPanelProvider.refreshTicketsDelta` (line 2029) and `importAllTasks` fetch task markdown descriptions and metadata, but the `importAllTicketsComplete` handler (8122-8149) completely skips refreshing comment threads for the selected ticket or active list.
3. **No Background Cache Pre-warming**: When switching between tickets in the sidebar, users experience a noticeable lag while "Loading comments..." fetches over the network because no per-ticket cache exists.

## Metadata
- **Complexity:** 4
- **Tags:** frontend, backend, api, ui, feature
- **Project:** Browser Switchboard
- **Feature:** 820d1f5b-f9aa-4e26-84ec-b64a198d3d5c

## User Review Required
No user decision required. The prefetch hooks, cache, and auto-sync gate are well-scoped against existing handlers; no new backend verb is needed (`loadTicketComments` already exists at `TicketsPanelProvider` line 3402).

## Complexity Audit
### Routine
- Calling `loadCommentThreads(provider, id)` upon ticket selection in `tickets.js` (inside `renderTicketsLinearTaskDetail` ~3364 and `renderTicketsClickUpTaskDetail` ~3474, gated by a cache-freshness check).
- Re-fetching comments for the currently selected ticket in the `importAllTicketsComplete` handler (8122), gated on `!message.autoSync`.
- Populating a per-ticket cache (`ticketCommentsCache`) in the `ticketCommentsLoaded` handler (8035) unconditionally, so prefetched threads land in the cache.

### Complex / Risky
- Preventing redundant network requests when rapidly clicking through sidebar tickets and when the 45s auto-sync fires — handled by the existing `_pendingRefetchTicketId` in-flight guard (2375) plus a short cache TTL on the selection path and the `!autoSync` gate on the refresh path.

## Edge-Case & Dependency Audit
- **Rapid Ticket Selection**: The existing `_pendingRefetchTicketId` guard (2375-2381) blocks a duplicate fetch for the SAME in-flight id; a fetch for a different id proceeds and overwrites the marker, so the previous id's response is silently dropped by `ticketCommentsLoaded` (8038 only clears when `_pendingRefetchTicketId === message.id`). This is correct for the modal but means a prefetched ticket whose selection was superseded never lands in the cache — acceptable, since the now-selected ticket is the one the user wants. Add a short cache-freshness gate (e.g. 15s) on the selection path so re-selecting the same ticket does not refetch.
- **Auto-sync drip**: `importAllTicketsComplete` fires on BOTH manual refresh AND 45s background auto-sync (`message.autoSync`, per comment at 8131-8133). The refresh-path comment refetch MUST be gated on `!message.autoSync` so a selected ticket's comments are not re-fetched every 45s indefinitely — a steady drip against a rate-limited comment endpoint.
- **Provider Support**: Both Linear and ClickUp comment endpoints are already supported via `loadTicketComments` (`TicketsPanelProvider` line 3402); the prefetch reuses the same `loadCommentThreads` path, so no per-provider branching is needed.
- **Offline / Rate-Limiting**: `loadCommentThreads` already degrades gracefully — a failed fetch leaves the cache empty and the modal shows "Loading comments..." on open. Prefetch failures must not block ticket detail rendering or sidebar rendering (they don't — the prefetch is fire-and-forget, separate from the detail-render path).
- **Cache population**: `ticketCommentsLoaded` (8035) must populate `ticketCommentsCache` UNCONDITIONALLY (not only when the comment modal is open), so a prefetched ticket's threads are available for instant modal rendering later.

## Dependencies
- None. This plan touches `tickets.js` only (selection handlers, `importAllTicketsComplete`, `ticketCommentsLoaded`). The backend `loadTicketComments` verb (`TicketsPanelProvider` line 3402) is unchanged.

## Adversarial Synthesis
Key risks: (1) hooking the refresh path into `importAllTicketsComplete` without the `!autoSync` gate turns the prefetch into a 45s background drip against a rate-limited endpoint; (2) a write-only cache that the selection path never consults is dead code. Mitigations: gate the refresh-path refetch on `!message.autoSync`, gate the selection-path prefetch on a short cache TTL, and populate the cache unconditionally in `ticketCommentsLoaded` so prefetched threads are actually reusable.

## Proposed Changes

### `src/webview/tickets.js`
- Add a per-ticket comment cache and a freshness gate near the existing `_cm*` state (line 182):
```javascript
const ticketCommentsCache = new Map(); // id -> { threads, fetchedAt }
const _COMMENT_PREFETCH_TTL_MS = 15000; // skip refetch if cached within 15s
```

- In the ticket selection / detail-render paths (`renderTicketsLinearTaskDetail` ~3364, `renderTicketsClickUpTaskDetail` ~3474), after `_toggleSubtaskMetaButtons()`:
  - Proactively prefetch comments in the background, gated by cache freshness so rapid re-selection of the same ticket does not refetch.
```javascript
// Proactively preload comments in background (fire-and-forget).
// Gated by cache freshness so re-selecting the same ticket doesn't refetch.
const _id = issue.id; // (Linear) or selectedClickUpIssue?.task?.id (ClickUp)
if (_id) {
    const cached = ticketCommentsCache.get(_id);
    const fresh = cached && (Date.now() - cached.fetchedAt < _COMMENT_PREFETCH_TTL_MS);
    if (!fresh) {
        loadCommentThreads(lastIntegrationProvider, _id);
    }
}
```

- In the `importAllTicketsComplete` handler (line 8122-8149), after `loadLocalTicketFiles()`:
  - Re-fetch comments for the currently selected ticket, GATED on `!message.autoSync` so the 45s background auto-sync does not drip comment API calls.
```javascript
// Refresh comments for the selected ticket on a USER-initiated sync only.
// autoSync fires every ~45s in the background — refetching comments on each
// tick would drip a rate-limited comment endpoint for whichever ticket is
// selected. Skip on auto-sync; the user's next manual Refresh re-warms it.
if (!message.autoSync) {
    const activeId = _cmActiveTicketId
        || (lastIntegrationProvider === 'linear' ? selectedLinearIssue?.issue?.id : selectedClickUpIssue?.task?.id);
    if (activeId) {
        loadCommentThreads(lastIntegrationProvider, activeId);
    }
}
```

- In the `ticketCommentsLoaded` handler (line 8035), populate the cache UNCONDITIONALLY (before the existing `_pendingRefetchTicketId` clear / stale-refetch logic), so prefetched threads land even when the modal is not open:
```javascript
// Cache threads for this ticket regardless of modal state, so a later
// openCommentManager() can render instantly. Prefetched threads for a
// superseded selection are simply overwritten when the now-selected
// ticket's response arrives.
if (message.id) {
    ticketCommentsCache.set(message.id, { threads: message.threads || [], fetchedAt: Date.now() });
}
```

- In `openCommentManager` (line 2344-2358): before showing the "Loading comments..." placeholder, check the cache and render cached threads instantly if present, then let `loadCommentThreads` reconcile in the background.
```javascript
const cached = ticketCommentsCache.get(id);
if (cached && cached.threads) {
    _cmThreads = cached.threads;
    renderCommentManager(_cmThreads, _cmMembers);
}
// Still call loadCommentThreads below to reconcile with remote.
```

### `src/services/TicketsPanelProvider.ts`
- No change required. `loadTicketComments` (line 3402) already handles background fetching cleanly and returns structured thread data via `ticketCommentsLoaded` regardless of modal state. The original plan's proposed change here is already satisfied by the shipped verb.

## Verification Plan

### Automated Tests
- Run tickets comment and verb engine tests:
  - `npm test src/test/verb-engine-tickets-headless.test.js`
  - `npm test src/test/tickets-comments.test.js`
- Add a test asserting that selecting a ticket triggers a `loadTicketComments` message, that `importAllTicketsComplete` with `autoSync: true` does NOT trigger a comment refetch, and that `importAllTicketsComplete` with `autoSync: false` does.

### Manual Verification
1. Open the Tickets panel and click on a ticket that has existing remote comments in ClickUp or Linear.
2. Verify in network/logs that comments are requested immediately upon ticket selection.
3. Click the "Comment" button: verify comments display instantly from cache, then reconcile with remote without a prolonged loading spinner.
4. Add a comment on the remote platform (ClickUp/Linear web UI).
5. In Switchboard Tickets panel, click "Refresh" (manual): verify the new remote comment is fetched and reflected in the comment manager.
6. Leave the panel idle for >45s and observe the auto-sync fire: verify NO comment refetch occurs for the selected ticket during auto-sync.
