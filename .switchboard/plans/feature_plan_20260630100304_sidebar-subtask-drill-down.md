# Sidebar Subtask Drill-Down When Parent Task is Selected in Tickets Tab

## Goal

When a parent task with subtasks is selected in the tickets tab sidebar, the sidebar should list the parent's subtasks instead of (or in addition to) the full parent task list. Currently, subtasks only appear in a small "table of contents" navigation at the top of the detail panel (`#tickets-subtasks-nav`), and there is no way to use the sidebar buttons (Add to kanban, Link to ticket, Refine, Open) on individual subtasks.

### Problem Analysis & Root Cause

**Root cause:** The sidebar list functions `getFilteredClickUpTasks` (line ~8943) and `getFilteredLinearIssues` (line ~8360) explicitly **filter out** subtasks:

```javascript
// getFilteredClickUpTasks, line 8947:
if (task?.parentId) return false;

// getFilteredLinearIssues, line 8365:
if (issue?.parentId) return false;
```

This means subtasks never appear in the sidebar. The only place subtasks are visible is the `subtasksNav` element at the top of the detail panel (rendered in `renderTicketsClickUpTaskDetail` line ~9085 and `renderTicketsLinearTaskDetail` line ~8586), which shows a simple clickable list of subtask titles. Clicking a subtask nav item (handler at line ~7725) loads the subtask's detail view, but the sidebar still shows the parent-level task list.

The sidebar card buttons (Add to kanban, Link to ticket, Refine, Open) are only rendered on sidebar cards — the subtask nav items have no such buttons. So there is genuinely no way to perform sidebar actions on subtasks.

**Desired behavior:** When a parent task with subtasks is selected, the sidebar should switch to showing that parent's subtasks as full sidebar cards (with all the same buttons). The user should be able to navigate back to the full task list.

## Metadata
**Tags:** ui, frontend, sidebar, subtasks, navigation, tickets-tab
**Complexity:** 6

## Complexity Audit

### Routine
- Add a "drill-down" mode flag to track when the sidebar is showing a parent's subtasks.
- Filter `clickUpProjectIssues` / `linearProjectIssues` by `parentId === selectedTaskId` when in drill-down mode.
- Render subtask cards with the same card layout and buttons as parent tasks.

### Complex / Risky
- **Navigation state management:** Need a "back to all tasks" mechanism. When in drill-down mode, the sidebar header should show the parent task name and a back button. Selecting a different parent from the full list should either exit drill-down or drill into the new parent's subtasks.
- **Subtask data availability:** Subtasks are loaded asynchronously via `importTicketSubtasks` (triggered at line ~7843 when a parent is opened). The subtask data may not be in `clickUpProjectIssues` / `linearProjectIssues` yet — it's stored in the parent's `selectedClickUpIssue.subtasks` / `selectedLinearIssue.subtasks` array. The drill-down view must source its data from the selected issue's subtasks array, not the main issues array.
- **Subtask detail loading:** Clicking a subtask card in drill-down mode should load the subtask's detail view (same as clicking a subtask nav item). The existing `loadClickUpTaskDetails` / `loadLinearTaskDetails` functions handle this.
- **Cache invalidation:** The `_lastTicketsIssuesContainerHtml` / `_lastTicketsClickUpIssuesContainerHtml` cache strings will differ between drill-down and normal mode, so the cache will correctly invalidate when switching modes.

## Edge-Case & Dependency Audit

- **Parent with no subtasks:** If a parent has no subtasks, the sidebar should remain in normal mode (showing the full task list). Don't enter drill-down for childless parents.
- **Subtask of a subtask:** ClickUp supports nested subtasks. If a subtask itself has subtasks, drilling down further should work recursively. For simplicity, the initial implementation should support one level of drill-down (parent → subtasks). Deeper nesting can be a follow-up.
- **Selecting a subtask from the full list:** If a subtask somehow appears in the full list (e.g., via search), clicking it should show its detail but not trigger drill-down (it has no subtasks to show, or its subtasks are not loaded).
- **Back navigation:** When in drill-down mode, clicking "back" should return to the full task list with the parent task still selected in the detail view.
- **Linear subtask data:** Linear subtasks come from the `subtasks` field of the issue detail response. The `subtasks` array items have `id`, `title`, `identifier`, `state`, etc. — enough to render sidebar cards.
- **ClickUp subtask data:** ClickUp subtasks come from the `subtasks` field of the task detail response. Items have `id`, `name`/`title`, `status`, `assignees`, etc.

## Proposed Changes

### 1. Add drill-down state variables
**File:** `src/webview/planning.js`

Near the other ticket state variables (around line ~260):

```javascript
let _sidebarDrillDownParentId = null;  // null = normal mode, task id = drill-down mode
```

### 2. Add a back-to-list header when in drill-down mode
**File:** `src/webview/planning.js`

In `renderTicketsClickUpList` (line ~8961) and `renderTicketsLinearList` (line ~8411), prepend a back-navigation header when `_sidebarDrillDownParentId` is set:

```javascript
function _renderDrillDownHeader(parentTitle) {
    return `
        <div class="sidebar-drilldown-header" style="display:flex;align-items:center;gap:6px;padding:8px 10px;cursor:pointer;border-bottom:1px solid var(--border-color);background:var(--panel-bg2,#1a1a2e);font-size:11px;font-weight:600;color:var(--accent-teal,#00ffcc);user-select:none;">
            <span style="font-size:14px;">←</span>
            <span>Back to all tickets</span>
        </div>
        <div style="padding:6px 10px;font-size:10px;color:var(--text-secondary);border-bottom:1px solid var(--border-color);">
            Subtasks of: ${escapeHtml(parentTitle)}
        </div>
    `;
}
```

### 3. Update renderTicketsClickUpList for drill-down mode
**File:** `src/webview/planning.js`

```javascript
function renderTicketsClickUpList() {
    if (!isTicketsTabActive()) return;
    const { issuesContainer, emptyState, loadMoreButton, searchInput } = getTicketsTabElements();
    if (!issuesContainer) return;
    // ... existing search sync code ...

    if (clickUpProjectStatus === 'loading') { /* ... existing ... */ return; }
    if (emptyState) emptyState.style.display = 'none';

    let html;
    if (_sidebarDrillDownParentId && selectedClickUpIssue) {
        // Drill-down mode: show subtasks of the selected parent
        const subtasks = selectedClickUpIssue.subtasks || [];
        if (subtasks.length === 0) {
            html = `<div class="empty-state">No subtasks found for this ticket.</div>`;
        } else {
            const parentTitle = selectedClickUpIssue.task?.title || selectedClickUpIssue.task?.identifier || '';
            html = _renderDrillDownHeader(parentTitle);
            html += subtasks.map(subtask => {
                const isSelected = selectedClickUpIssue && selectedClickUpIssue.task.id === subtask.id;
                const syncBadge = _ticketSyncBadge(subtask.syncStatus || 'local');
                const statusName = subtask.status || '';
                const statusColor = _ticketStatusLightColor(statusName);
                const statusLight = `<span class="ticket-status-light" style="background:${escapeAttr(statusColor)}" title="${escapeAttr(statusName || 'No status')}"></span>`;
                const openUrl = _ticketExternalUrl('clickup', subtask.id, subtask.url);
                const openBtn = openUrl ? `<button type="button" class="card-icon-btn" data-open-ticket-url="${escapeAttr(openUrl)}">Open</button>` : '';
                return `
                <div class="ticket-node${isSelected ? ' selected' : ''}" data-clickup-task-id="${escapeAttr(subtask.id)}">
                    ${statusLight}
                    <div class="tickets-issue-title">${escapeHtml(subtask.title || subtask.name || subtask.id)}</div>
                    <div class="tickets-issue-meta ticket-status-row">${escapeHtml(subtask.status || 'Unknown')}${syncBadge}</div>
                    <div class="tickets-issue-meta">${subtask.assignees?.length ? escapeHtml(subtask.assignees.map(a => a.username || a.email).join(', ')) : 'Unassigned'}</div>
                    <div class="card-actions">
                        <button type="button" class="card-icon-btn" data-import-plan-id="${escapeAttr(subtask.id)}" data-provider="clickup">Add to kanban</button>
                        <button type="button" class="card-icon-btn" data-link-ticket-id="${escapeAttr(subtask.id)}" data-provider="clickup">Link to ticket</button>
                        <button type="button" class="card-icon-btn" data-refine-ticket-id="${escapeAttr(subtask.id)}" data-provider="clickup">Refine</button>
                        ${openBtn}
                    </div>
                </div>`;
            }).join('');
        }
    } else {
        // Normal mode: existing flat list (or grouped, per Issue 2)
        const tasks = getFilteredClickUpTasks();
        html = tasks.length === 0
            ? `<div class="empty-state">No tasks found.</div>`
            : tasks.map(task => { /* ... existing card rendering ... */ }).join('');
    }

    if (_lastTicketsClickUpIssuesContainerHtml !== html) {
        issuesContainer.innerHTML = html;
        _lastTicketsClickUpIssuesContainerHtml = html;
    }
    if (loadMoreButton) loadMoreButton.style.display = (!_sidebarDrillDownParentId && clickUpProjectHasMore) ? '' : 'none';
}
```

### 4. Update renderTicketsLinearList for drill-down mode
**File:** `src/webview/planning.js`

Apply the same drill-down pattern, sourcing subtasks from `selectedLinearIssue.subtasks`:

```javascript
if (_sidebarDrillDownParentId && selectedLinearIssue) {
    const subtasks = selectedLinearIssue.subtasks || [];
    // ... render drill-down header + subtask cards using subtask.id, subtask.title, subtask.state?.name, etc.
}
```

### 5. Enter drill-down mode when a parent with subtasks is selected
**File:** `src/webview/planning.js`

In the card click handler (line ~7801), after selecting a ticket, check if it has subtasks and enter drill-down mode:

```javascript
const card = e.target.closest('[data-linear-issue-id], [data-clickup-task-id]');
if (card) {
    // ... existing selection logic ...
    
    // After selection, check for subtasks and enter drill-down mode
    if (linearId) {
        const cached = linearIssueDetailCache.get(linearId);
        if (cached && cached.subtasks && cached.subtasks.length > 0) {
            _sidebarDrillDownParentId = linearId;
        } else {
            _sidebarDrillDownParentId = null;
        }
    } else if (clickUpId) {
        const cached = clickUpTaskDetailCache.get(clickUpId);
        if (cached && cached.subtasks && cached.subtasks.length > 0) {
            _sidebarDrillDownParentId = clickUpId;
        } else {
            _sidebarDrillDownParentId = null;
        }
    }
    // Re-render sidebar to show drill-down or normal mode
    renderTicketsTab();
}
```

**Important:** The drill-down should only trigger when the subtask data is actually loaded (detailsFetched). If subtasks haven't been loaded yet, stay in normal mode until the detail response arrives and triggers a re-render.

### 6. Handle drill-down back navigation click
**File:** `src/webview/planning.js`

In the `#tickets-issues-container` click handler, add handling for the back header:

```javascript
const backHeader = e.target.closest('.sidebar-drilldown-header');
if (backHeader) {
    e.stopPropagation();
    _sidebarDrillDownParentId = null;
    if (lastIntegrationProvider === 'linear') renderTicketsLinearList();
    else renderTicketsClickUpList();
    return;
}
```

### 7. Exit drill-down when subtask detail loads
**File:** `src/webview/planning.js`

When a subtask is clicked in drill-down mode, the subtask's detail loads via `loadClickUpTaskDetails` / `loadLinearTaskDetails`. The subtask itself likely has no subtasks, so `_sidebarDrillDownParentId` should be set to `null` (or kept as the original parent so the user stays in the subtask list context). 

**Decision:** Keep `_sidebarDrillDownParentId` as the original parent ID so the sidebar continues showing the sibling subtasks. The user can click "back" to return to the full list. This means the drill-down check in step 5 should only change `_sidebarDrillDownParentId` when clicking a card from the **normal** (non-drill-down) list, not when clicking a subtask card in drill-down mode.

Update step 5's logic:

```javascript
// Only enter/exit drill-down when clicking from the normal list (not a subtask card)
if (!_sidebarDrillDownParentId) {
    if (cached && cached.subtasks && cached.subtasks.length > 0) {
        _sidebarDrillDownParentId = clickUpId || linearId;
    }
}
```

## Verification Plan

### Manual Testing
1. Select a parent task that has subtasks in the tickets tab sidebar.
2. Verify: the sidebar switches to show the parent's subtasks as full cards with all buttons (Add to kanban, Link to ticket, Refine, Open).
3. Verify: a "← Back to all tickets" header appears at the top of the sidebar.
4. Verify: clicking a subtask card loads its detail view in the preview panel, and the sidebar remains in drill-down mode showing sibling subtasks.
5. Verify: clicking "← Back to all tickets" returns to the full task list.
6. Verify: selecting a parent task with no subtasks does NOT enter drill-down mode.
7. Verify: sidebar buttons on subtask cards work correctly (e.g., "Add to kanban" imports the subtask, not the parent).
8. Verify: both ClickUp and Linear providers support drill-down.
9. Verify: search/filter still works in normal mode; in drill-down mode, search filters within the subtask list.

### Automated Tests
- N/A (webview UI changes; manual verification via VS Code extension host).

**Recommendation:** Send to Coder
