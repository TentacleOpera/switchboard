# Sidebar Status Subheaders with Accordion Collapses in Tickets Tab

## Goal

The tickets tab sidebar in planning.html currently renders all tickets as a flat, ungrouped list. Tickets of different statuses (e.g., "To Do", "In Progress", "Done") are thrown together with no visual separation. The sidebar needs status-based subheaders with accordion collapse/expand functionality so users can organize and navigate tickets by status.

### Problem Analysis & Root Cause

**Root cause:** Both `renderTicketsClickUpList` (line ~8961 in planning.js) and `renderTicketsLinearList` (line ~8411 in planning.js) call `getFilteredClickUpTasks()` / `getFilteredLinearIssues()` and immediately `.map()` over the flat result array, producing a single ungrouped list of `ticket-node` divs inside `#tickets-issues-container`. There is no grouping logic by status, no header elements, and no collapsible sections.

The status filter dropdown (`#tickets-status-filter` for ClickUp, `#state-filter` for Linear) allows filtering by a single status, but there is no way to see all statuses at once with visual grouping.

## Metadata
**Tags:** ui, frontend, sidebar, tickets-tab, grouping, accordion
**Complexity:** 5

## Complexity Audit

### Routine
- Group filtered tickets by status name before rendering.
- Render a header row for each status group with a count badge.
- Add accordion toggle (click header to collapse/expand its ticket list).

### Complex / Risky
- **Delta-render compatibility:** The sidebar uses a string-comparison cache (`_lastTicketsIssuesContainerHtml` / `_lastTicketsClickUpIssuesContainerHtml`) to skip DOM updates when content hasn't changed. Adding accordion state (which sections are collapsed) means the cache string must encode collapse state, or collapsed sections will reset on every re-render.
- **Status ordering:** Status groups should appear in a logical order (e.g., "To Do" → "In Progress" → "In Review" → "Done"), not alphabetical. Need a status ordering heuristic.
- **Empty status:** Tickets with no status should be grouped under "Unknown" or "No Status".
- **Search interaction:** When a search filter is active, some status groups may become empty. Empty groups should be hidden.

## Edge-Case & Dependency Audit

- **Accordion state persistence:** If the user collapses "Done" and then a new ticket is added, the re-render must preserve the collapsed state of "Done". Solution: track collapsed status names in a module-level `Set` (e.g., `_collapsedTicketStatuses`), and include the collapsed set in the cache string.
- **Status filter interaction:** If the user selects a specific status in the dropdown filter, only that group will have tickets. The accordion header should still show, but there's only one group. Consider auto-expanding when a filter is active.
- **ClickUp vs Linear status names:** ClickUp uses `task.status` (string), Linear uses `issue.state?.name` (string). Both are used in the existing card rendering. The grouping logic must handle both.
- **DOM event delegation:** The existing click handler on `#tickets-issues-container` (line ~7751) uses event delegation for card clicks and button clicks. Accordion header clicks must be intercepted before the card-click handler to prevent selecting a ticket when the user just wants to collapse/expand a section.

## Proposed Changes

### 1. Add module-level state for collapsed sections
**File:** `src/webview/planning.js`

Near the other ticket-related state variables (around line ~260):

```javascript
let _collapsedTicketStatuses = new Set();
```

### 2. Add status ordering helper
**File:** `src/webview/planning.js`

Near the `_ticketStatusLightColor` function (line ~8383):

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

Replace the flat `.map()` in `renderTicketsClickUpList` (line ~8984-9008) with grouped rendering:

```javascript
const tasks = getFilteredClickUpTasks();
if (tasks.length === 0) {
    // ... existing empty state
} else {
    const groups = _groupTicketsByStatus(tasks, t => t.status || '');
    const html = groups.map(([statusName, groupTasks]) => {
        const isCollapsed = _collapsedTicketStatuses.has(statusName);
        const statusColor = _ticketStatusLightColor(statusName);
        const headerHtml = `
            <div class="ticket-status-group-header" data-status-name="${escapeAttr(statusName)}" style="display:flex;align-items:center;gap:6px;padding:6px 8px;cursor:pointer;user-select:none;border-bottom:1px solid var(--border-color);background:var(--panel-bg2,#1a1a2e);font-size:11px;font-weight:600;text-transform:uppercase;color:var(--text-secondary);">
                <span class="accordion-arrow" style="transition:transform 0.2s;${isCollapsed ? '' : 'transform:rotate(90deg);'}">▶</span>
                <span class="ticket-status-light" style="background:${escapeAttr(statusColor)};width:8px;height:8px;border-radius:50%;flex-shrink:0;"></span>
                <span>${escapeHtml(statusName)}</span>
                <span style="margin-left:auto;opacity:0.6;font-weight:400;">${groupTasks.length}</span>
            </div>
        `;
        const listHtml = isCollapsed ? '' : groupTasks.map(task => {
            // ... existing ticket-node rendering (lines 8987-9007)
        }).join('');
        return `<div class="ticket-status-group">${headerHtml}<div class="ticket-status-group-body" ${isCollapsed ? 'style="display:none;"' : ''}>${listHtml}</div></div>`;
    }).join('');
    
    if (_lastTicketsClickUpIssuesContainerHtml !== html) {
        issuesContainer.innerHTML = html;
        _lastTicketsClickUpIssuesContainerHtml = html;
    }
}
```

### 5. Update renderTicketsLinearList to group by status
**File:** `src/webview/planning.js`

Apply the same grouping pattern to `renderTicketsLinearList` (line ~8460-8483), using `issue.state?.name` as the status getter:

```javascript
const groups = _groupTicketsByStatus(filteredIssues, i => i.state?.name || '');
// ... same accordion header + body pattern as ClickUp
```

### 6. Add accordion header click handler
**File:** `src/webview/planning.js`

In the `#tickets-issues-container` click handler (line ~7751), add accordion toggle handling BEFORE the card-click logic:

```javascript
document.getElementById('tickets-issues-container')?.addEventListener('click', (e) => {
    // Accordion header toggle
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
    // ... existing button/card click handlers
});
```

### 7. Add CSS for accordion animation (optional)
**File:** `src/webview/planning.html`

In the `<style>` section, add:

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

### Automated Tests
- N/A (webview UI changes; manual verification via VS Code extension host).

**Recommendation:** Send to Coder
