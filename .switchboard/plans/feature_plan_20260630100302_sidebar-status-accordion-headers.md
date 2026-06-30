# Sidebar Status Subheaders with Accordion Collapses in Tickets Tab

## Goal

The tickets tab sidebar in planning.html currently renders all tickets as a flat, ungrouped list. Tickets of different statuses (e.g., "To Do", "In Progress", "Done") are thrown together with no visual separation. The sidebar needs status-based subheaders with accordion collapse/expand functionality so users can organize and navigate tickets by status.

### Problem Analysis & Root Cause

**Root cause:** Both `renderTicketsClickUpList` (line 9013 in planning.js) and `renderTicketsLinearList` (line 8473 in planning.js) call `getFilteredClickUpTasks()` / `getFilteredLinearIssues()` and immediately `.map()` over the flat result array, producing a single ungrouped list of `ticket-node` divs inside `#tickets-issues-container`. There is no grouping logic by status, no header elements, and no collapsible sections.

The status filter dropdown (`#tickets-status-filter` for ClickUp, `#state-filter` for Linear) allows filtering by a single status, but there is no way to see all statuses at once with visual grouping.

## Metadata
**Tags:** frontend, ui, feature
**Complexity:** 5

## User Review Required
Yes — before implementation, confirm:
- Should collapsed state persist across tab switches (session-level) or reset when the tickets tab is closed and reopened?
- Should the status group ordering heuristic be customizable, or is the built-in ordering (To Do → In Progress → Blocked → Review → Done) sufficient?
- Should empty status groups be hidden by default, or shown with a "(0)" count badge?

## Complexity Audit

### Routine
- Group filtered tickets by status name before rendering.
- Render a header row for each status group with a count badge.
- Add accordion toggle (click header to collapse/expand its ticket list).
- Add CSS for accordion header hover and arrow rotation animation.

### Complex / Risky
- **Delta-render compatibility:** The sidebar uses a string-comparison cache (`_lastTicketsIssuesContainerHtml` at line 311 / `_lastTicketsClickUpIssuesContainerHtml` at line 314) to skip DOM updates when content hasn't changed. Adding accordion state (which sections are collapsed) means the cache string must encode collapse state, or collapsed sections will reset on every re-render. The collapsed set must be serialized into the cache comparison string.
- **Status ordering:** Status groups should appear in a logical order (e.g., "To Do" → "In Progress" → "In Review" → "Done"), not alphabetical. Need a status ordering heuristic.
- **Empty status:** Tickets with no status should be grouped under "Unknown" or "No Status".
- **Search interaction:** When a search filter is active, some status groups may become empty. Empty groups should be hidden.

## Edge-Case & Dependency Audit

- **Race Conditions:** The `renderTicketsClickUpList` / `renderTicketsLinearList` functions can be called re-entrantly if a `localTicketFilesListed` message arrives while the user is clicking an accordion header. The cache string guard prevents double-render, but the collapsed state `Set` must be read atomically (JavaScript is single-threaded, so this is safe).
- **Security:** Status names come from ClickUp/Linear API responses and are passed through `escapeHtml` / `escapeAttr` in the existing rendering. The accordion header must also use these escape functions for the status name text and `data-status-name` attribute.
- **Side Effects:** Adding accordion headers changes the DOM structure inside `#tickets-issues-container`. The existing event delegation handler (line 7825) uses `e.target.closest()` for card clicks and button clicks. The accordion header click must be intercepted BEFORE the card-click handler via `e.target.closest('.ticket-status-group-header')` to prevent selecting a ticket when the user just wants to collapse/expand a section.
- **Dependencies & Conflicts:** This plan conflicts with Plan 3 (Subtask Drill-Down), which also modifies `renderTicketsClickUpList` / `renderTicketsLinearList` and the click handler. If both are implemented, the accordion grouping must be applied within the normal (non-drill-down) mode only, and the drill-down mode should render subtask cards without status grouping (since subtasks may share the parent's status). The click handler must check for accordion headers first, then drill-down back header, then card clicks.

## Dependencies
- None — this plan is self-contained within `src/webview/planning.js` and `src/webview/planning.html`.

## Adversarial Synthesis
Key risks: (1) accordion collapse state lost on re-render unless encoded in cache string, (2) event delegation conflict with existing card-click handler if accordion header click not intercepted first, (3) status ordering heuristic may not cover all custom ClickUp/Linear status names. Mitigations: serialize collapsed Set into cache comparison string, add accordion header check at the top of the click handler, use a catch-all fallback order (50) for unrecognized statuses.

## Proposed Changes

### 1. Add module-level state for collapsed sections
**File:** `src/webview/planning.js`

Near the other ticket-related state variables (around line 260, after `let clickUpProjectIssues = [];` at line 258):

```javascript
let _collapsedTicketStatuses = new Set();
```

### 2. Add status ordering helper
**File:** `src/webview/planning.js`

Near the `_ticketStatusLightColor` function (line 8445):

```javascript
function _ticketStatusOrder(statusName) {
    const s = String(statusName || '').toLowerCase();
    if (!s) return 99;
    if (/(backlog|todo|to do|open|created|new|triage|planned|ready)/.test(s)) return 0;
    if (/(progress|doing|active|started|develop|dev|wip|implement|build)/.test(s)) return 1;
    if (/(block|hold|stuck|waiting|paused)/.test(s)) return 2;
    if (/(review|qa|testing|verify|approval)/.test(s)) return 3;
    if (/(done|complete|closed|resolved|merged|shipped|deployed|archived|live)/.test(s)) return 4;
    return 50;
}
```

### 3. Add grouping helper function
**File:** `src/webview/planning.js`

```javascript
function _groupTicketsByStatus(tickets, statusGetter) {
    const groups = new Map();
    for (const t of tickets) {
        const status = statusGetter(t) || 'No Status';
        if (!groups.has(status)) groups.set(status, []);
        groups.get(status).push(t);
    }
    // Sort groups by status order, then alphabetically
    return Array.from(groups.entries()).sort((a, b) => {
        const orderDiff = _ticketStatusOrder(a[0]) - _ticketStatusOrder(b[0]);
        if (orderDiff !== 0) return orderDiff;
        return a[0].localeCompare(b[0]);
    });
}
```

### 4. Update renderTicketsClickUpList to group by status
**File:** `src/webview/planning.js`

Replace the flat `.map()` in `renderTicketsClickUpList` (line 9035-9060) with grouped rendering. The existing code at line 9035 is:

```javascript
const tasks = getFilteredClickUpTasks();
const html = tasks.length === 0
    ? `<div class="empty-state">No tasks found.</div>`
    : tasks.map(task => {
        // ... existing ticket-node rendering (lines 9037-9058)
    }).join('');
```

Replace with:

```javascript
const tasks = getFilteredClickUpTasks();
let html;
if (tasks.length === 0) {
    html = `<div class="empty-state">No tasks found.</div>`;
} else {
    const groups = _groupTicketsByStatus(tasks, t => t.status || '');
    html = groups.map(([statusName, groupTasks]) => {
        // Hide empty groups (can happen during search)
        if (groupTasks.length === 0) return '';
        const isCollapsed = _collapsedTicketStatuses.has(statusName);
        const statusColor = _ticketStatusLightColor(statusName);
        const headerHtml = `
            <div class="ticket-status-group-header" data-status-name="${escapeAttr(statusName)}" style="display:flex;align-items:center;gap:6px;padding:6px 8px;cursor:pointer;user-select:none;border-bottom:1px solid var(--border-color);background:var(--panel-bg2,#1a1a2e);font-size:11px;font-weight:600;text-transform:uppercase;color:var(--text-secondary);">
                <span class="accordion-arrow" style="transition:transform 0.2s;${isCollapsed ? '' : 'transform:rotate(90deg);'}">▶</span>
                <span class="ticket-status-light" style="background:${escapeAttr(statusColor)};width:8px;height:8px;border-radius:50%;flex-shrink:0;position:relative;top:0;right:0;"></span>
                <span>${escapeHtml(statusName)}</span>
                <span style="margin-left:auto;opacity:0.6;font-weight:400;">${groupTasks.length}</span>
            </div>
        `;
        const listHtml = isCollapsed ? '' : groupTasks.map(task => {
            const isSelected = selectedClickUpIssue && selectedClickUpIssue.task.id === task.id;
            const syncBadge = _ticketSyncBadge(task.syncStatus);
            const statusNameInner = task.status || '';
            const statusColorInner = task.statusColor || _ticketStatusLightColor(statusNameInner);
            const statusLight = `<span class="ticket-status-light" style="background:${escapeAttr(statusColorInner)}" title="${escapeAttr(statusNameInner || 'No status')}"></span>`;
            const openUrl = _ticketExternalUrl('clickup', task.id, task.url);
            const openBtn = openUrl ? `<button type="button" class="card-icon-btn" data-open-ticket-url="${escapeAttr(openUrl)}">Open</button>` : '';
            return `
            <div class="ticket-node${isSelected ? ' selected' : ''}" data-clickup-task-id="${escapeAttr(task.id)}">
                ${statusLight}
                <div class="tickets-issue-title">${escapeHtml(task.title || task.identifier)}</div>
                <div class="tickets-issue-meta ticket-status-row">${escapeHtml(task.status || 'Unknown')}${syncBadge}</div>
                <div class="tickets-issue-meta">${task.assignees?.length ? escapeHtml(task.assignees.map(a => a.username || a.email).join(', ')) : 'Unassigned'}</div>
                <div class="card-actions">
                    <button type="button" class="card-icon-btn" data-import-plan-id="${escapeAttr(task.id)}" data-provider="clickup">Add to kanban</button>
                    <button type="button" class="card-icon-btn" data-link-ticket-id="${escapeAttr(task.id)}" data-provider="clickup">Link to ticket</button>
                    <button type="button" class="card-icon-btn" data-refine-ticket-id="${escapeAttr(task.id)}" data-provider="clickup">Refine</button>
                    ${openBtn}
                </div>
            </div>`;
        }).join('');
        return `<div class="ticket-status-group">${headerHtml}<div class="ticket-status-group-body" ${isCollapsed ? 'style="display:none;"' : ''}>${listHtml}</div></div>`;
    }).join('');
    // Include collapsed state in cache key to prevent state loss on re-render
    html += `<!-- collapsed:${Array.from(_collapsedTicketStatuses).sort().join(',')} -->`;
}

if (_lastTicketsClickUpIssuesContainerHtml !== html) {
    issuesContainer.innerHTML = html;
    _lastTicketsClickUpIssuesContainerHtml = html;
}
```

**Note:** The `.ticket-status-light` in the header uses `position:relative;top:0;right:0;` to override the existing CSS `position:absolute;top:8px;right:8px;` (line 2807 in planning.html) which would position the dot in the corner of the header instead of inline.

### 5. Update renderTicketsLinearList to group by status
**File:** `src/webview/planning.js`

Apply the same grouping pattern to `renderTicketsLinearList` (line 8473), using `issue.state?.name` as the status getter. The existing code at line 8519 is:

```javascript
const newHtml = filteredIssues.map((issue) => {
    // ... existing ticket-node rendering (lines 8519-8545)
}).join('');
```

Replace with the same grouped pattern as ClickUp (step 4), using `i => i.state?.name || ''` as the status getter, and the Linear card rendering code. Include the collapsed state cache key suffix.

### 6. Add accordion header click handler
**File:** `src/webview/planning.js`

In the `#tickets-issues-container` click handler (line 7825), add accordion toggle handling BEFORE the existing button/card click logic:

```javascript
document.getElementById('tickets-issues-container')?.addEventListener('click', (e) => {
    // Accordion header toggle — must be first to prevent card selection
    const header = e.target.closest('.ticket-status-group-header');
    if (header) {
        e.stopPropagation();
        const statusName = header.dataset.statusName;
        if (_collapsedTicketStatuses.has(statusName)) {
            _collapsedTicketStatuses.delete(statusName);
        } else {
            _collapsedTicketStatuses.add(statusName);
        }
        // Re-render to update accordion state
        if (lastIntegrationProvider === 'linear') renderTicketsLinearList();
        else renderTicketsClickUpList();
        return;
    }
    // ... existing button/card click handlers (importPlanBtn, linkTicketBtn, refineBtn, openTicketBtn, card)
});
```

### 7. Add CSS for accordion animation
**File:** `src/webview/planning.html`

In the `<style>` section, after the existing `.ticket-status-light` styles (around line 2819), add:

```css
.ticket-status-group-header:hover {
    background: var(--panel-bg, #2a2a3e) !important;
}
.accordion-arrow {
    display: inline-block;
    font-size: 10px;
    transition: transform 0.2s ease;
}
.ticket-status-group-body {
    transition: max-height 0.2s ease;
}
```

## Verification Plan

### Automated Tests
- N/A (webview UI changes; manual verification via VS Code extension host).

### Manual Testing
1. Open the tickets tab with both ClickUp and Linear providers (test both).
2. Verify: tickets are grouped under status subheaders (e.g., "TO DO", "IN PROGRESS", "DONE").
3. Verify: each header shows a count badge with the number of tickets in that group.
4. Verify: clicking a header collapses/expands its ticket list with a smooth arrow rotation.
5. Verify: collapsed state persists across re-renders (e.g., after selecting a different ticket).
6. Verify: status groups appear in logical order (To Do → In Progress → Done), not alphabetical.
7. Verify: searching filters tickets within groups, and empty groups are hidden.
8. Verify: clicking a ticket card inside a group still selects it and loads the detail view.
9. Verify: tickets with no status are grouped under "No Status".

**Recommendation:** Send to Coder
