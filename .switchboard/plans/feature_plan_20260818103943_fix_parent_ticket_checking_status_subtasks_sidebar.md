# Fix Parent Ticket Card Stuck on 'Checking' Sync Status in Subtasks Sidebar

## Goal
In `tickets.html`, when viewing subtasks in drill-down mode, the sidebar displays a header section with a card representing the parent ticket (`_renderDrillDownHeader`). Currently, this parent ticket card is permanently stuck showing the `checking` sync status badge (`<span class="ticket-sync-badge ticket-sync-pending">checking</span>`), even after local files and sync statuses have been fully loaded and resolved.

### Root Cause Analysis
1. **Sync Badge Evaluation:** In `src/webview/tickets.js`, `_ticketSyncBadge(syncStatus)` (line 617) outputs the badge based on `syncStatus`: `'modified'`, `'synced'`, `'local-only'`, or falls back to `<span class="ticket-sync-badge ticket-sync-pending">checking</span>` if `syncStatus` is `undefined` or unset.
2. **Detail Cache Object Disconnect:** When rendering the drill-down header, `_renderDrillDownHeader` (line 787) renders the parent card using the cached detail object (`linearIssueDetailCache.get(parentId).issue` or `clickUpTaskDetailCache.get(parentId).task`). These detail objects originate from API task detail responses (`linearTaskDetailsLoaded` / `clickupTaskDetailsLoaded` handlers at lines 7659 / 7693), which set `issue: message.issue` / `task: message.task` directly from the API payload — and the API payload does not populate `syncStatus`.
3. **Missing Parent ID in Sync Status Request:** In `_requestTicketSyncStatuses()` (line 1403), the requested IDs are gathered from `issues` (`linearProjectIssues` / `clickUpProjectIssues`) plus `_drillDownSubtasks` subtask IDs. The parent ticket ID (`_sidebarDrillDownParentId`) is NOT included in the `drillIds` array. If the parent ticket is not in the current page or filtered slice of `issues`, its sync status is never requested.
4. **Cache Not Updated on Response:** When `ticketSyncStatusesLoaded` arrives (line 7779) with resolved statuses, it updates `.syncStatus` on the list items in `clickUpProjectIssues` / `linearProjectIssues` and `_drillDownSubtasks`, but never updates `detail.issue.syncStatus` or `detail.task.syncStatus` inside `linearIssueDetailCache` or `clickUpTaskDetailCache`.
5. **Missing Fallback to List State:** `_renderDrillDownHeader` (line 787) does not fall back to copying `syncStatus` from `linearProjectIssues` / `clickUpProjectIssues` if the detail object's `syncStatus` is undefined.
6. **Detail Re-fetch Wipes Resolved Status (additional edge case):** The `linearTaskDetailsLoaded` (line 7659) and `clickupTaskDetailsLoaded` (line 7693) handlers create a fresh cache entry with `issue: message.issue` / `task: message.task`. Even if `ticketSyncStatusesLoaded` had previously set `syncStatus` on the detail cache entry, a subsequent detail re-fetch (e.g. from a file-change invalidation or subtask conversion) replaces the entire cache entry with a fresh API object that has no `syncStatus`, wiping the resolved status back to `undefined` → `checking`.

## Metadata
- **Complexity:** 3
- **Tags:** frontend, ui, ux, bugfix
- **Project:** Browser Switchboard

## User Review Required

None. The root cause is confirmed against the live code (all six claims verified at the cited line numbers), the fix follows existing patterns in the same file, and no new product surface or design decision is introduced.

## Complexity Audit

### Routine
- Adding `_sidebarDrillDownParentId` to the `drillIds` array in `_requestTicketSyncStatuses` (line 1412) — one array element insertion.
- Adding a detail-cache update block to the `ticketSyncStatusesLoaded` handler (line 7779) — iterating `Object.entries(statuses)` and setting `.syncStatus` on matching cache entries.
- Adding a list-fallback hydration in `_renderDrillDownHeader` (line 787) — looking up the parent in `linearProjectIssues` / `clickUpProjectIssues` when `detail.issue.syncStatus` is undefined.
- Preserving `syncStatus` across detail re-fetches in `linearTaskDetailsLoaded` (line 7659) and `clickupTaskDetailsLoaded` (line 7693) — copying from the previous cache entry or the list before the fresh API object overwrites it.
- All changes are confined to `src/webview/tickets.js`. The built distribution `dist/webview/tickets.js` is a webpack copy artifact — only the source needs editing; `npm run compile` or `npm run watch` regenerates the dist.

### Complex / Risky
- *Detail re-fetch race:* A detail re-fetch arriving after `ticketSyncStatusesLoaded` wipes the detail cache's `syncStatus`. The fallback in `_renderDrillDownHeader` covers the case where the parent is in the list, but if the parent is NOT in the current list page (ClickUp pagination) AND the detail cache was re-fetched, only the preservation in the detail-load handler (change #4) prevents a revert to `checking`. Without change #4, the plan's own success check passes in the common case but fails in the pagination + re-fetch edge case.

## Edge-Case & Dependency Audit

### Race Conditions
- **Detail re-fetch after sync-status load:** `ticketSyncStatusesLoaded` sets `syncStatus` on the detail cache; a subsequent `linearTaskDetailsLoaded` / `clickupTaskDetailsLoaded` replaces the cache entry with a fresh API object, wiping `syncStatus`. Change #4 (preserve from previous cache entry or list) closes this race.
- **Sync-status response arrives before drill-down activates:** `_maybeEnterDrillDown` (line 3560) calls `_requestTicketSyncStatuses()` after setting `_drillDownProvider`. The response arrives asynchronously and updates the detail cache via change #2; a `renderTicketsTab()` call repaints the header. No race — the response is always applied to the current cache state.

### Security
- None. No new data flows, no user input handling, no API surface changes.

### Side Effects
- **Cache mutation in render function:** Change #3 mutates `detail.issue.syncStatus` inside `_renderDrillDownHeader`. This is a cache hydration side effect in a render function — acceptable because it is idempotent (only writes when `undefined`) and prevents repeated list lookups on every re-render.
- **Overwriting in-progress modified status:** The `ticketSyncStatusesLoaded` handler uses `statuses[t.id] ?? t.syncStatus` — nullish coalescing preserves an existing non-null status. The backend `getTicketSyncStatuses` faithfully reflects file frontmatter state, so a locally-modified ticket reports `modified` and is not overridden.

### Dependencies & Conflicts
- **Dual providers (Linear vs ClickUp):** Both `linearIssueDetailCache` / `linearProjectIssues` and `clickUpTaskDetailCache` / `clickUpProjectIssues` paths must be updated consistently. All four changes have provider-branched code.
- **Parent not in current list page (ClickUp pagination):** When a list has multiple pages and the parent was loaded on an earlier page or directly by ID, `_sidebarDrillDownParentId` must be explicitly included in `_requestTicketSyncStatuses()` (change #1). The fallback in change #3 looks up the list, which may not contain the parent — change #2 (detail cache update) and change #4 (detail re-fetch preservation) cover this gap.
- **Subtask navigation inside drill-down:** Clicking between subtasks in the detail pane re-renders the drill-down view via `renderTicketsTab()`. The parent card must retain its resolved sync badge and not revert to `checking`. Changes #2 and #4 ensure the detail cache retains `syncStatus` across re-renders.
- **Local-Only vs Synced vs Modified:** If a parent ticket is modified locally, the badge must render `modified`; if in sync with remote, `synced`; if created locally and not yet pushed, `local-only`. The backend `getTicketSyncStatuses` resolves these values; the frontend changes ensure they reach the parent card.

## Dependencies

None. This plan is self-contained — all changes are in `src/webview/tickets.js` and a new test file.

## Adversarial Synthesis

Key risks: (1) the original plan's proposed `ticketSyncStatusesLoaded` code dropped the existing `success === false` failure handling and used wrong render functions — corrected to preserve both; (2) a detail re-fetch race wipes resolved `syncStatus` from the detail cache — the original plan missed this entirely, requiring a fourth change to preserve `syncStatus` across detail re-fetches; (3) the ClickUp pagination + re-fetch edge case is the only scenario where the original three-change fix would still fail. Mitigations: all four changes are in place, the `??` nullish coalescing preserves dirty/edit state, and the render fallback is idempotent.

## Proposed Changes

### `src/webview/tickets.js`

#### 1. Include `_sidebarDrillDownParentId` in `_requestTicketSyncStatuses` (line 1412)

Ensure `_sidebarDrillDownParentId` is explicitly included in the array of IDs requested for sync status check when drill-down is active. The existing code at line 1412 only folds in subtask IDs:

```javascript
const drillIds = _isDrillDownActive(lastIntegrationProvider)
    ? (_drillDownSubtasks || []).map(s => s.id).filter(Boolean)
    : [];
```

Change to:

```javascript
const drillIds = _isDrillDownActive(lastIntegrationProvider)
    ? [
        _sidebarDrillDownParentId,
        ...(_drillDownSubtasks || []).map(s => s.id)
      ].filter(Boolean)
    : [];
```

The rest of `_requestTicketSyncStatuses` (the `vscode.postMessage` call with `ids`, `workspaceRoot`, `listId`, `projectId`) stays unchanged.

#### 2. Update Detail Caches in `ticketSyncStatusesLoaded` Handler (line 7779)

> **Superseded:** The original plan proposed a full replacement of the `ticketSyncStatusesLoaded` handler that (a) used `for...of` mutation loops instead of the existing `.map()` pattern, (b) called `renderTicketsLinearList()` / `renderTicketsClickUpList()` instead of the existing `renderTicketsTab()`, and (c) omitted the existing `success === false` failure-handling block.
> **Reason:** The existing handler uses `.map()` to create new array references (the codebase's consistent pattern) and calls `renderTicketsTab()` (which delegates to the correct panel renderer). Dropping the `success === false` check would silently swallow backend fetch failures — a regression of existing error handling. The `for...of` mutation approach, while functional, is inconsistent with the surrounding code style and could confuse a future reader into thinking the pattern changed.
> **Replaced with:** An additive change that preserves the existing `.map()` pattern, the `success === false` check, and the `renderTicketsTab()` call, and inserts only the new detail-cache update block before the re-render:

The existing handler at line 7779:

```javascript
case 'ticketSyncStatusesLoaded': {
    if (!_isForThisPanel(message)) { break; }
    const provider = message.provider;
    const statuses = message.statuses || {};
    if (message.success === false) {
        console.warn('[tickets] sync-status fetch failed:', message.error);
    }
    if (provider === 'clickup') {
        clickUpProjectIssues = clickUpProjectIssues.map(t => ({
            ...t, syncStatus: statuses[t.id] ?? t.syncStatus
        }));
    } else {
        linearProjectIssues = linearProjectIssues.map(t => ({
            ...t, syncStatus: statuses[t.id] ?? t.syncStatus
        }));
    }
    if (_drillDownSubtasks && _drillDownProvider === provider) {
        _drillDownSubtasks = _drillDownSubtasks.map(s => ({ ...s, syncStatus: statuses[s.id] ?? s.syncStatus }));
    }
    renderTicketsTab();
    break;
}
```

Insert the detail-cache update block after the `_drillDownSubtasks` patch and before `renderTicketsTab()`:

```javascript
    // Update detail cache entries (including parent tickets) so
    // _renderDrillDownHeader reads the resolved syncStatus from the
    // cached issue/task object directly. Without this, the detail
    // cache's syncStatus stays undefined and the parent card shows
    // "checking" even after statuses have loaded.
    if (provider === 'linear') {
        for (const [id, status] of Object.entries(statuses)) {
            const detail = linearIssueDetailCache.get(id);
            if (detail && detail.issue) {
                detail.issue.syncStatus = status;
            }
        }
    } else if (provider === 'clickup') {
        for (const [id, status] of Object.entries(statuses)) {
            const detail = clickUpTaskDetailCache.get(id);
            if (detail && detail.task) {
                detail.task.syncStatus = status;
            }
        }
    }
```

#### 3. Fall Back to List `syncStatus` in `_renderDrillDownHeader` (line 787)

When preparing `parentCard` in `_renderDrillDownHeader`, ensure `syncStatus` is hydrated from the list array if the detail object's `syncStatus` is undefined. The existing code at line 787:

```javascript
function _renderDrillDownHeader(parentTitle, provider) {
    const parentId = _sidebarDrillDownParentId;
    let parentCard = '';
    if (parentId) {
        if (provider === 'linear') {
            const detail = linearIssueDetailCache.get(parentId);
            if (detail && detail.issue) parentCard = _renderLinearTicketCard(detail.issue);
        } else if (provider === 'clickup') {
            const detail = clickUpTaskDetailCache.get(parentId);
            if (detail && detail.task) parentCard = _renderClickUpTicketCard(detail.task);
        }
    }
    // ... rest of _renderDrillDownHeader (parentSection, subtasksLabel, return)
```

Change the `if (parentId)` block to hydrate `syncStatus` before rendering:

```javascript
    if (parentId) {
        if (provider === 'linear') {
            const detail = linearIssueDetailCache.get(parentId);
            if (detail && detail.issue) {
                if (detail.issue.syncStatus === undefined) {
                    const fromList = linearProjectIssues.find(i => i.id === parentId);
                    if (fromList?.syncStatus) {
                        detail.issue.syncStatus = fromList.syncStatus;
                    }
                }
                parentCard = _renderLinearTicketCard(detail.issue);
            }
        } else if (provider === 'clickup') {
            const detail = clickUpTaskDetailCache.get(parentId);
            if (detail && detail.task) {
                if (detail.task.syncStatus === undefined) {
                    const fromList = clickUpProjectIssues.find(t => t.id === parentId);
                    if (fromList?.syncStatus) {
                        detail.task.syncStatus = fromList.syncStatus;
                    }
                }
                parentCard = _renderClickUpTicketCard(detail.task);
            }
        }
    }
```

The rest of `_renderDrillDownHeader` (the `parentSection`, `subtasksLabel`, and `return` template literal at lines 799-816) stays unchanged.

#### 4. Preserve `syncStatus` Across Detail Re-fetches (lines 7659 and 7693)

> **Superseded:** The original plan had no change for the detail-load handlers.
> **Reason:** The `linearTaskDetailsLoaded` and `clickupTaskDetailsLoaded` handlers create a fresh cache entry with `issue: message.issue` / `task: message.task` from the API payload, which has no `syncStatus`. Even after change #2 sets `syncStatus` on the detail cache, a subsequent detail re-fetch (from file-change invalidation, subtask conversion at line 7745, or manual re-selection) replaces the entire cache entry and wipes `syncStatus` back to `undefined`. In the ClickUp pagination edge case (parent not in list), the fallback in change #3 cannot recover, and the badge reverts to `checking` — the exact bug this plan exists to fix.
> **Replaced with:** A preservation step in both detail-load handlers that copies `syncStatus` from the previous cache entry or the list before the fresh API object overwrites it.

In `linearTaskDetailsLoaded` (line 7659), after `linearIssueDetailCache.set(message.issue.id, selectedLinearIssue)` and before `_maybeEnterDrillDown`:

```javascript
    // Preserve syncStatus across detail re-fetches: the API payload
    // does not carry syncStatus, so without this a re-fetch after
    // ticketSyncStatusesLoaded wipes the parent's resolved badge.
    if (selectedLinearIssue.issue && selectedLinearIssue.issue.syncStatus === undefined) {
        const prevStatus = _prevLinear?.issue?.syncStatus;
        if (prevStatus) {
            selectedLinearIssue.issue.syncStatus = prevStatus;
        } else {
            const fromList = linearProjectIssues.find(i => i.id === message.issue.id);
            if (fromList?.syncStatus) {
                selectedLinearIssue.issue.syncStatus = fromList.syncStatus;
            }
        }
    }
```

In `clickupTaskDetailsLoaded` (line 7693), after `clickUpTaskDetailCache.set(message.task.id, selectedClickUpIssue)` and before the corresponding `_maybeEnterDrillDown` call:

```javascript
    // Preserve syncStatus across detail re-fetches (same rationale as
    // the Linear handler above).
    if (selectedClickUpIssue.task && selectedClickUpIssue.task.syncStatus === undefined) {
        const prevStatus = _prevClickUp?.task?.syncStatus;
        if (prevStatus) {
            selectedClickUpIssue.task.syncStatus = prevStatus;
        } else {
            const fromList = clickUpProjectIssues.find(t => t.id === message.task.id);
            if (fromList?.syncStatus) {
                selectedClickUpIssue.task.syncStatus = fromList.syncStatus;
            }
        }
    }
```

Note: `_prevLinear` (line 7660) and `_prevClickUp` (line 7694) are already declared at the top of each handler — the preservation step reuses them without adding new variables.

## Verification Plan

### Automated Tests
Create a dedicated test file `src/test/tickets-subtask-parent-sync-badge-regression.test.js` following the existing source-level assertion pattern used by sibling ticket tests (e.g. `tickets-subtask-embedding.test.js` — read `src/webview/tickets.js` as text and assert on structural patterns, since the webview JS runs in a browser context and cannot be executed directly in Node):

1. **Sync Status Request Coverage:** Assert that the `drillIds` construction in `_requestTicketSyncStatuses` includes `_sidebarDrillDownParentId` (e.g. the source text between `_isDrillDownActive` and the `vscode.postMessage` call contains `_sidebarDrillDownParentId`).
2. **Detail Cache Sync Status Propagation:** Assert that the `ticketSyncStatusesLoaded` handler contains a detail-cache update block that iterates `Object.entries(statuses)` and sets `.syncStatus` on `linearIssueDetailCache` and `clickUpTaskDetailCache` entries.
3. **Drill-Down Header Fallback:** Assert that `_renderDrillDownHeader` contains a fallback lookup in `linearProjectIssues` / `clickUpProjectIssues` when `detail.issue.syncStatus` / `detail.task.syncStatus` is `undefined`.
4. **Detail Re-fetch Preservation:** Assert that `linearTaskDetailsLoaded` and `clickupTaskDetailsLoaded` contain a `syncStatus` preservation step that reads from `_prevLinear?.issue?.syncStatus` / `_prevClickUp?.task?.syncStatus` or the list array.
5. **Failure Handling Preserved:** Assert that the `ticketSyncStatusesLoaded` handler still contains the `success === false` check and `console.warn` call (regression guard — the original plan's proposed code would have dropped this).

### Manual Verification
1. Open the Tickets tab in Switchboard with Linear or ClickUp connected.
2. Click on the subtask-count chip of a parent ticket with subtasks to enter drill-down mode.
3. Verify that the parent ticket card at the top of the sidebar displays its resolved sync status badge (`synced`, `modified`, or `local`) instead of remaining permanently on `checking`.
4. Click between individual subtasks and verify the parent card remains on the correct sync status.
5. Modify the parent ticket locally and verify that its badge updates to `modified` in the drill-down view.
6. **Pagination edge case (ClickUp):** Navigate to a list with multiple pages. Enter drill-down on a parent from an earlier page (not in the current visible slice). Verify the parent card shows the resolved sync status, not `checking`.
7. **Detail re-fetch edge case:** While in drill-down mode, trigger a detail re-fetch (e.g. by converting a subtask or causing a file-change invalidation). Verify the parent card retains its resolved sync status after the re-fetch completes.
