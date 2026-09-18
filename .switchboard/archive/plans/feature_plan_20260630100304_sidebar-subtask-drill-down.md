# Sidebar Subtask Drill-Down When Parent Task is Selected in Tickets Tab

## Goal

When a parent task with subtasks is selected in the tickets tab sidebar, the sidebar should list the parent's subtasks instead of (or in addition to) the full parent task list. Currently, subtasks only appear in a small "table of contents" navigation at the top of the detail panel (`#tickets-subtasks-nav`), and there is no way to use the sidebar buttons (Add to kanban, Link to ticket, Refine, Open) on individual subtasks.

### Problem Analysis & Root Cause

**Root cause:** The sidebar list functions `getFilteredClickUpTasks` (line 8995) and `getFilteredLinearIssues` (line 8422) explicitly **filter out** subtasks:

```javascript
// getFilteredClickUpTasks, line 8999:
if (task?.parentId) return false;

// getFilteredLinearIssues, line 8426:
if (issue?.parentId) return false;
```

This means subtasks never appear in the sidebar. The only place subtasks are visible is the `subtasksNav` element at the top of the detail panel (rendered in `renderTicketsClickUpTaskDetail` at lines 9137-9161 and `renderTicketsLinearTaskDetail` at lines 8648-8672), which shows a simple clickable list of subtask titles. Clicking a subtask nav item (handler at line 7798) loads the subtask's detail view, but the sidebar still shows the parent-level task list.

The sidebar card buttons (Add to kanban, Link to ticket, Refine, Open) are only rendered on sidebar cards — the subtask nav items have no such buttons. So there is genuinely no way to perform sidebar actions on subtasks.

**Desired behavior:** When a parent task with subtasks is selected, the sidebar should switch to showing that parent's subtasks as full sidebar cards (with all the same buttons). The user should be able to navigate back to the full task list.

## Metadata
**Tags:** frontend, ui, feature
**Complexity:** 6

## User Review Required
Yes — before implementation, confirm:
- Should drill-down trigger automatically when selecting a parent with subtasks, or should it require an explicit "Show subtasks" button click?
- When in drill-down mode and the user clicks a subtask, should the sidebar stay in drill-down mode (showing sibling subtasks) or exit to the full list?
- Should the drill-down support recursive nesting (subtask of a subtask), or is one level sufficient for now?

## Complexity Audit

### Routine
- Add a "drill-down" mode flag to track when the sidebar is showing a parent's subtasks.
- Render subtask cards with the same card layout and buttons as parent tasks.
- Add a "back to all tickets" header when in drill-down mode.

### Complex / Risky
- **Navigation state management:** Need a "back to all tasks" mechanism. When in drill-down mode, the sidebar header should show the parent task name and a back button. Selecting a different parent from the full list should either exit drill-down or drill into the new parent's subtasks.
- **Subtask data availability:** Subtasks are loaded asynchronously via `importTicketSubtasks` (triggered at line 7919 when a parent is opened). The subtask data is stored in the parent's `selectedClickUpIssue.subtasks` / `selectedLinearIssue.subtasks` array (cache structure at lines 326-327). The drill-down view must source its data from the selected issue's subtasks array, not the main issues array.
- **Subtask detail loading:** Clicking a subtask card in drill-down mode should load the subtask's detail view (same as clicking a subtask nav item). The existing `loadClickUpTaskDetails` (line 9246) / `loadLinearTaskDetails` (line 9208) functions handle this.
- **Cache invalidation:** The `_lastTicketsIssuesContainerHtml` (line 311) / `_lastTicketsClickUpIssuesContainerHtml` (line 314) cache strings will differ between drill-down and normal mode, so the cache will correctly invalidate when switching modes.
- **Interaction with Plan 1 (Accordion Headers):** If both plans are implemented, the accordion grouping should only apply in normal (non-drill-down) mode. The drill-down mode should render subtask cards without status grouping. The click handler must check for accordion headers first, then drill-down back header, then card clicks.

## Edge-Case & Dependency Audit

- **Race Conditions:** The `importTicketSubtasks` message is sent asynchronously (line 7919). If the user selects a parent and the subtask data hasn't arrived yet, the drill-down should not trigger (or should show a loading state). The drill-down should only activate when `selectedClickUpIssue.subtasks` / `selectedLinearIssue.subtasks` has a non-empty array.
- **Security:** Subtask data comes from the ClickUp/Linear API and is rendered using `escapeHtml` / `escapeAttr`. No additional security concerns.
- **Side Effects:** Entering drill-down mode replaces the sidebar list content. The `loadMoreButton` visibility (line 9067) should be hidden in drill-down mode since pagination doesn't apply to subtasks.
- **Dependencies & Conflicts:** This plan conflicts with Plan 1 (Accordion Headers) in the `renderTicketsClickUpList` / `renderTicketsLinearList` functions and the click handler. The implementation must coordinate: accordion grouping in normal mode, flat subtask list in drill-down mode. The click handler order must be: accordion header → drill-down back header → card click.
- **Parent with no subtasks:** If a parent has no subtasks, the sidebar should remain in normal mode (showing the full task list). Don't enter drill-down for childless parents.
- **Subtask of a subtask:** ClickUp supports nested subtasks. If a subtask itself has subtasks, drilling down further should work recursively. For simplicity, the initial implementation should support one level of drill-down (parent → subtasks). Deeper nesting can be a follow-up.
- **Selecting a subtask from the full list:** If a subtask somehow appears in the full list (e.g., via search), clicking it should show its detail but not trigger drill-down (it has no subtasks to show, or its subtasks are not loaded).
- **Back navigation:** When in drill-down mode, clicking "back" should return to the full task list with the parent task still selected in the detail view.
- **Linear subtask data:** Linear subtasks come from the `subtasks` field of the issue detail response. The `subtasks` array items have `id`, `title`, `identifier`, `state`, etc. — enough to render sidebar cards.
- **ClickUp subtask data:** ClickUp subtasks come from the `subtasks` field of the task detail response. Items have `id`, `name`/`title`, `status`, `assignees`, etc.

## Dependencies
- None — this plan is self-contained within `src/webview/planning.js`. Subtask data is already available in `selectedClickUpIssue.subtasks` / `selectedLinearIssue.subtasks` after the detail response arrives.

## Adversarial Synthesis
Key risks: (1) drill-down triggers before subtask data is loaded, showing an empty list, (2) the card click handler at line 7875 sets `selectedClickUpIssue` / `selectedLinearIssue` and calls `renderTicketsClickUpPanel` / `renderTicketsLinearPanel` which re-renders the sidebar — the drill-down state must be preserved across this re-render, (3) clicking a subtask card in drill-down mode calls `loadClickUpTaskDetails` which sets `selectedClickUpIssue = null` (line 9248) before the API response arrives, which would exit drill-down mode prematurely. Mitigations: only enter drill-down when `subtasks.length > 0`, store `_sidebarDrillDownParentId` as a module-level variable that persists across re-renders, and only modify `_sidebarDrillDownParentId` when clicking from the normal list (not from drill-down subtask cards).

## Proposed Changes

### 1. Add drill-down state variables
**File:** `src/webview/planning.js`

Near the other ticket state variables (around line 260, after `let selectedClickUpIssue = null;` at line 259):

```javascript
let _sidebarDrillDownParentId = null;  // null = normal mode, task id = drill-down mode
```

### 2. Add a back-to-list header when in drill-down mode
**File:** `src/webview/planning.js`

Near the `_ticketStatusLightColor` function (line 8445), add a helper:

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

In `renderTicketsClickUpList` (line 9013), add a drill-down branch before the normal rendering. The existing code at line 9035 is:

```javascript
const tasks = getFilteredClickUpTasks();
const html = tasks.length === 0
    ? `<div class="empty-state">No tasks found.</div>`
    : tasks.map(task => { /* ... */ }).join('');
```

Replace with:

```javascript
let html;
if (_sidebarDrillDownParentId && selectedClickUpIssue && selectedClickUpIssue.task.id === _sidebarDrillDownParentId) {
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
    // Normal mode: existing flat list (or grouped, per Plan 1)
    const tasks = getFilteredClickUpTasks();
    html = tasks.length === 0
        ? `<div class="empty-state">No tasks found.</div>`
        : tasks.map(task => { /* ... existing card rendering ... */ }).join('');
}

if (_lastTicketsClickUpIssuesContainerHtml !== html) {
    issuesContainer.innerHTML = html;
    _lastTicketsClickUpIssuesContainerHtml = html;
}
if (loadMoreButton) {
    loadMoreButton.style.display = (!_sidebarDrillDownParentId && clickUpProjectHasMore) ? '' : 'none';
}
```

### 4. Update renderTicketsLinearList for drill-down mode
**File:** `src/webview/planning.js`

Apply the same drill-down pattern to `renderTicketsLinearList` (line 8473), sourcing subtasks from `selectedLinearIssue.subtasks`:

```javascript
if (_sidebarDrillDownParentId && selectedLinearIssue && selectedLinearIssue.issue.id === _sidebarDrillDownParentId) {
    const subtasks = selectedLinearIssue.subtasks || [];
    if (subtasks.length === 0) {
        // ... empty state
    } else {
        const parentTitle = selectedLinearIssue.issue?.title || selectedLinearIssue.issue?.identifier || '';
        let newHtml = _renderDrillDownHeader(parentTitle);
        newHtml += subtasks.map(subtask => {
            // ... render subtask card using subtask.id, subtask.title, subtask.state?.name, etc.
        }).join('');
        // ... cache guard and update
    }
} else {
    // ... existing normal mode rendering
}
```

### 5. Enter drill-down mode when a parent with subtasks is selected
**File:** `src/webview/planning.js`

In the card click handler (line 7875), after the existing selection logic (lines 7875-7926), add drill-down logic. The key constraint: only enter/exit drill-down when clicking from the **normal** (non-drill-down) list, not when clicking a subtask card in drill-down mode.

```javascript
const card = e.target.closest('[data-linear-issue-id], [data-clickup-task-id]');
if (card) {
    const linearId = card.dataset.linearIssueId;
    const clickUpId = card.dataset.clickupTaskId;
    
    // ... existing selection logic (lines 7877-7914) ...
    
    // Progressive subtask import (lines 7919-7926) ...
    
    // Drill-down logic — only when clicking from the normal list
    if (!_sidebarDrillDownParentId) {
        if (linearId) {
            const cached = linearIssueDetailCache.get(linearId);
            if (cached && cached.subtasks && cached.subtasks.length > 0) {
                _sidebarDrillDownParentId = linearId;
            }
        } else if (clickUpId) {
            const cached = clickUpTaskDetailCache.get(clickUpId);
            if (cached && cached.subtasks && cached.subtasks.length > 0) {
                _sidebarDrillDownParentId = clickUpId;
            }
        }
    }
    // Re-render sidebar to show drill-down or normal mode
    // (renderTicketsClickUpPanel / renderTicketsLinearPanel already called above)
}
```

**Important:** The drill-down should only trigger when the subtask data is actually loaded (`detailsFetched` and `subtasks.length > 0`). If subtasks haven't been loaded yet, stay in normal mode until the detail response arrives and triggers a re-render. The `importTicketSubtasks` message at line 7919 will eventually populate the subtasks array, but the re-render must be triggered when the subtask data arrives. Check the `clickupTaskDetailsLoaded` / `linearTaskDetailsLoaded` handlers (lines 5200 / 5058) to see if they call `renderTicketsTab()` — if so, the drill-down will activate on the next render after subtasks are loaded.

### 6. Handle drill-down back navigation click
**File:** `src/webview/planning.js`

In the `#tickets-issues-container` click handler (line 7825), add handling for the back header BEFORE the card click logic (but after the accordion header check from Plan 1, if implemented):

```javascript
// After accordion header check (Plan 1), before card click:
const backHeader = e.target.closest('.sidebar-drilldown-header');
if (backHeader) {
    e.stopPropagation();
    _sidebarDrillDownParentId = null;
    if (lastIntegrationProvider === 'linear') renderTicketsLinearList();
    else renderTicketsClickUpList();
    return;
}
```

### 7. Keep drill-down state when subtask is clicked within drill-down
**File:** `src/webview/planning.js`

When a subtask is clicked in drill-down mode, the existing card click handler (line 7875) will load the subtask's detail. The `loadClickUpTaskDetails` function (line 9246) sets `selectedClickUpIssue = null` before the API response arrives. This would cause the drill-down check (`selectedClickUpIssue.task.id === _sidebarDrillDownParentId`) to fail, exiting drill-down mode.

**Fix:** In the drill-down check in `renderTicketsClickUpList` (step 3), also handle the case where `selectedClickUpIssue` is null but `_sidebarDrillDownParentId` is set. The sidebar should show a loading state or keep the last-rendered subtask list until the subtask's detail loads. Alternatively, store the subtask list separately when entering drill-down:

```javascript
// Add near the drill-down state variable:
let _drillDownSubtasks = null;  // Cached subtask list for drill-down mode

// When entering drill-down (step 5):
if (cached && cached.subtasks && cached.subtasks.length > 0) {
    _sidebarDrillDownParentId = clickUpId || linearId;
    _drillDownSubtasks = cached.subtasks;
}

// In the drill-down render check (step 3):
if (_sidebarDrillDownParentId && _drillDownSubtasks) {
    const subtasks = _drillDownSubtasks;
    // ... render from _drillDownSubtasks instead of selectedClickUpIssue.subtasks
}

// When exiting drill-down (step 6):
_sidebarDrillDownParentId = null;
_drillDownSubtasks = null;
```

This ensures the sidebar keeps showing the subtask list even when `selectedClickUpIssue` is temporarily null during a subtask detail load.

## Verification Plan

### Automated Tests
- N/A (webview UI changes; manual verification via VS Code extension host).

### Manual Testing
1. Select a parent task that has subtasks in the tickets tab sidebar.
2. Verify: the sidebar switches to show the parent's subtasks as full cards with all buttons (Add to kanban, Link to ticket, Refine, Open).
3. Verify: a "← Back to all tickets" header appears at the top of the sidebar.
4. Verify: clicking a subtask card loads its detail view in the preview panel, and the sidebar remains in drill-down mode showing sibling subtasks.
5. Verify: clicking "← Back to all tickets" returns to the full task list.
6. Verify: selecting a parent task with no subtasks does NOT enter drill-down mode.
7. Verify: sidebar buttons on subtask cards work correctly (e.g., "Add to kanban" imports the subtask, not the parent).
8. Verify: both ClickUp and Linear providers support drill-down.
9. Verify: search/filter still works in normal mode; in drill-down mode, search is not applicable (subtask list is fixed).

**Recommendation:** Send to Coder

## Review Findings

**Reviewer pass:** Implementation is complete and correct. Files changed: `src/webview/planning.js` (state variables `_sidebarDrillDownParentId`/`_drillDownSubtasks`/`_drillDownParentTitle`/`_drillDownProvider`/`_pendingDrillDownParentId`, helpers `_renderDrillDownHeader`/`_isDrillDownActive`/`_maybeEnterDrillDown`/`_resetSidebarDrillDown`, drill-down branches in both `renderTicketsClickUpList` and `renderTicketsLinearList`, card-click drill-down activation, back-header click with parent restoration, refine-button subtask lookup fallback, `loadMoreButton` hidden in drill-down, state cleared in `resetTicketsInMemoryState`). Notable improvements over plan: `_drillDownSubtasks` cache decouples drill-down rendering from `selectedClickUpIssue` (survives the null-clear during subtask detail load), `_drillDownProvider` isolates drill-down to the active provider, `_pendingDrillDownParentId` handles async subtask-data arrival, back header restores parent as selected ticket so detail pane and sidebar agree. No CRITICAL or MAJOR findings. Verification: compilation and tests skipped per session instructions; code trace confirms correct click-handler ordering (accordion → back header → card), drill-down preservation across subtask clicks, provider switch resets state, and childless parents never enter drill-down. Remaining risk: one-level-only drill-down (no recursive nesting) as documented in plan.
