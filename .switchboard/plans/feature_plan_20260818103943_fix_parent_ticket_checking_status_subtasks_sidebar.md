# Fix Parent Ticket Card Stuck on 'Checking' Sync Status in Subtasks Sidebar

## Goal
In `tickets.html`, when viewing subtasks in drill-down mode, the sidebar displays a header section with a card representing the parent ticket (`_renderDrillDownHeader`). Currently, this parent ticket card is permanently stuck showing the `checking` sync status badge (`<span class="ticket-sync-badge ticket-sync-pending">checking</span>`), even after local files and sync statuses have been fully loaded and resolved.

### Root Cause Analysis
1. **Sync Badge Evaluation:** In `src/webview/tickets.js`, `_ticketSyncBadge(syncStatus)` outputs the badge based on `syncStatus`: `'modified'`, `'synced'`, `'local-only'`, or falls back to `<span class="ticket-sync-badge ticket-sync-pending">checking</span>` if `syncStatus` is `undefined` or unset.
2. **Detail Cache Object Disconnect:** When rendering the drill-down header, `_renderDrillDownHeader` renders the parent card using the cached detail object (`linearIssueDetailCache.get(parentId).issue` or `clickUpTaskDetailCache.get(parentId).task`). These detail objects originate from API task detail responses (`linearLoadTaskDetails` / `clickupLoadTaskDetails`), which do not populate `syncStatus`.
3. **Missing Parent ID in Sync Status Request:** In `_requestTicketSyncStatuses()`, the requested IDs are gathered from `issues` (`linearProjectIssues` / `clickUpProjectIssues`) plus `_drillDownSubtasks`. If the parent ticket is not in the current page or filtered slice of `issues`, `_sidebarDrillDownParentId` is omitted from the batch request.
4. **Cache Not Updated on Response:** When `ticketSyncStatusesLoaded` arrives with resolved statuses, it updates `.syncStatus` on the list items in `clickUpProjectIssues` / `linearProjectIssues` and `_drillDownSubtasks`, but never updates `detail.issue.syncStatus` or `detail.task.syncStatus` inside `linearIssueDetailCache` or `clickUpTaskDetailCache`.
5. **Missing Fallback to List State:** `_renderDrillDownHeader` does not fall back to copying `syncStatus` from `linearProjectIssues` / `clickUpProjectIssues` if the detail object's `syncStatus` is undefined.

## Metadata
- **Complexity:** 3
- **Tags:** frontend, ui, ux, bugfix
- **Project:** Browser Switchboard

## Complexity Audit
- **Routine:** Yes. The fix is confined to `src/webview/tickets.js` (and built distribution `dist/webview/tickets.js`), adjusting ID collection in `_requestTicketSyncStatuses`, updating the detail cache objects in `ticketSyncStatusesLoaded`, and ensuring `_renderDrillDownHeader` reads or falls back to known sync status.
- **Risks & Mitigations:**
  - *Risk:* Overwriting an in-progress modified status when delta syncs occur.
  - *Mitigation:* Ensure `syncStatus` values faithfully reflect backend `getTicketSyncStatuses` results and local file frontmatter state without overriding dirty/edit state.

## Edge-Case & Dependency Audit
- **Parent Not in Current List Page (ClickUp pagination):** When a list has multiple pages and the parent was loaded on an earlier page or directly by ID, `_sidebarDrillDownParentId` must be explicitly included in `_requestTicketSyncStatuses()`.
- **Subtask Navigation inside Drill-Down:** Clicking between subtasks in the detail pane re-renders the drill-down view; the parent card must retain its resolved sync badge and not revert to "checking".
- **Local-Only vs Synced vs Modified:** If a parent ticket is modified locally, the badge must render `modified`; if in sync with remote, `synced`; if created locally and not yet pushed, `local`.
- **Dual Providers (Linear vs ClickUp):** Both Linear (`linearIssueDetailCache`, `linearProjectIssues`) and ClickUp (`clickUpTaskDetailCache`, `clickUpProjectIssues`) paths must be updated consistently.

## Proposed Changes

### `src/webview/tickets.js`

#### 1. Include `_sidebarDrillDownParentId` in `_requestTicketSyncStatuses`
Ensure `_sidebarDrillDownParentId` is explicitly included in the array of IDs requested for sync status check when drill-down is active:
```javascript
function _requestTicketSyncStatuses() {
    if (!lastIntegrationProvider) return;
    const issues = lastIntegrationProvider === 'clickup' ? clickUpProjectIssues : linearProjectIssues;
    const drillIds = _isDrillDownActive(lastIntegrationProvider)
        ? [
            _sidebarDrillDownParentId,
            ...(_drillDownSubtasks || []).map(s => s.id)
          ].filter(Boolean)
        : [];
    const ids = Array.from(new Set([...issues.map(t => t.id), ...drillIds])).filter(Boolean);
    if (ids.length === 0) return;
    vscode.postMessage({
        type: 'getTicketSyncStatuses',
        provider: lastIntegrationProvider,
        ids,
        workspaceRoot: ticketsWorkspaceRoot || undefined,
        listId: lastIntegrationProvider === 'clickup' ? (clickUpSelectedListId || undefined) : undefined,
        projectId: lastIntegrationProvider === 'linear' ? (linearProjectPickerValue || undefined) : undefined
    });
}
```

#### 2. Update Detail Caches in `ticketSyncStatusesLoaded` Handler
When `ticketSyncStatusesLoaded` receives the dictionary of statuses (`message.statuses`):
```javascript
case 'ticketSyncStatusesLoaded': {
    if (!_isForThisPanel(message)) { break; }
    const statuses = message.statuses || {};
    const provider = message.provider || lastIntegrationProvider;
    
    // Update active list items
    const issues = provider === 'linear' ? linearProjectIssues : clickUpProjectIssues;
    for (const issue of issues) {
        if (issue && issue.id && statuses[issue.id] !== undefined) {
            issue.syncStatus = statuses[issue.id];
        }
    }
    
    // Update active drill-down subtasks
    if (_drillDownSubtasks && Array.isArray(_drillDownSubtasks)) {
        for (const sub of _drillDownSubtasks) {
            if (sub && sub.id && statuses[sub.id] !== undefined) {
                sub.syncStatus = statuses[sub.id];
            }
        }
    }
    
    // Update detail cache entries (including parent tickets)
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
    
    // Re-render current list / panel so updated badges display
    if (provider === 'linear') {
        renderTicketsLinearList();
    } else {
        renderTicketsClickUpList();
    }
    break;
}
```

#### 3. Fall Back to List `syncStatus` in `_renderDrillDownHeader`
When preparing `parentCard` in `_renderDrillDownHeader`, ensure `syncStatus` is hydrated from the list array or detail cache:
```javascript
function _renderDrillDownHeader(parentTitle, provider) {
    const parentId = _sidebarDrillDownParentId;
    let parentCard = '';
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
    // ... rest of _renderDrillDownHeader
}
```

## Verification Plan

### Automated Tests
Create a dedicated test file `src/test/tickets-subtask-parent-sync-badge-regression.test.js`:
1. **Sync Status Request Coverage:** Verify that `_requestTicketSyncStatuses()` includes `_sidebarDrillDownParentId` when drill-down is active.
2. **Detail Cache Sync Status Propagation:** Verify that processing `ticketSyncStatusesLoaded` sets `syncStatus` on `linearIssueDetailCache` and `clickUpTaskDetailCache` objects.
3. **Drill-Down Header Parent Card Rendering:** Verify that `_renderDrillDownHeader` renders the parent card with `ticket-sync-synced`, `ticket-sync-modified`, or `ticket-sync-local` badges instead of `ticket-sync-pending` (`checking`).

### Manual Verification
1. Open the Tickets tab in Switchboard with Linear or ClickUp connected.
2. Click on the subtask-count chip of a parent ticket with subtasks to enter drill-down mode.
3. Verify that the parent ticket card at the top of the sidebar displays its resolved sync status badge (`synced`, `modified`, or `local`) instead of remaining permanently on `checking`.
4. Click between individual subtasks and verify the parent card remains on the correct sync status.
5. Modify the parent ticket locally and verify that its badge updates to `modified` in the drill-down view.
