# Move 'synced' Badge Next to Status Label in Tickets Tab Sidebar Cards

## Goal

In the planning.html Tickets tab, each sidebar ticket card currently renders a sync-status badge (`synced` / `modified` / `local`) inside the bottom `card-actions` row, pinned to the bottom-left via `margin-right: auto`. The user wants this badge relocated so it sits inline next to the **status label** (the first `tickets-issue-meta` line that shows the ticket state name), rather than occupying space in the action-button row.

### Problem Analysis & Root Cause

The sync badge is emitted by `_ticketSyncBadge()` (planning.js ~line 8262) and injected into the `card-actions` div for both Linear cards (line 8331) and ClickUp cards (line 8859). The CSS rule `.ticket-node .card-actions .ticket-sync-badge { margin-right: auto; align-self: center; }` (planning.html line 2790) pins it to the bottom-left of the action row, pushing the action buttons to the right.

This is purely a layout/placement concern — the badge is informational (`pointer-events: none`) and has no click behavior, so moving it is a low-risk HTML/CSS restructuring. The status label lives in the first `tickets-issue-meta` div (line 8327 for Linear, line 8856 for ClickUp), which currently renders only the state name text.

## Metadata

- **Tags**: `tickets-tab`, `ui`, `sidebar-cards`, `css`, `planning-html`
- **Complexity**: 2/10

## Complexity Audit

**Routine.** This is a self-contained HTML template + CSS adjustment in two render functions and one stylesheet block. No data model, state, event handling, or provider API changes are involved. The badge remains non-interactive. Both Linear and ClickUp card templates need the same edit.

## Edge-Case & Dependency Audit

- **Three badge states**: `synced`, `modified`, `local` — all three must render correctly in the new position. The `_ticketSyncBadge()` helper already returns the correct class for each; only its placement in the template changes.
- **Long status names**: Placing the badge inline with the status label means the row must not overflow. The status meta line should use a flex layout so the badge wraps or truncates gracefully on narrow sidebars.
- **`margin-right: auto` removal**: Once the badge leaves `card-actions`, the existing pin rule (`.ticket-node .card-actions .ticket-sync-badge`) no longer applies. The action buttons row already has `justify-content: flex-end`, so buttons stay right-aligned without the badge.
- **No event-handler impact**: The badge has `pointer-events: none`, so the delegated click handler in `tickets-issues-container` (line 7617) is unaffected — it matches on `data-*` attributes of buttons, not the badge.
- **Theme variants**: The `.ticket-sync-synced` / `.ticket-sync-modified` / `.ticket-sync-local` color rules (planning.html 2794–2804) are class-based and position-independent, so they continue to work in the new location.

## Proposed Changes

### 1. `src/webview/planning.html` — CSS adjustments

Replace the status-meta block styling so the first meta line (status) becomes a flex row that can host the badge inline, and remove the now-obsolete `card-actions` pin rule.

**Edit the `.ticket-node .tickets-issue-meta` rule** (line 2741) — add a variant for the status row:

```css
.ticket-node .tickets-issue-meta {
    font-size: 11px;
    color: var(--text-secondary);
    line-height: 1.5;
    font-family: var(--font-family);
}
/* Status meta row hosts the sync badge inline next to the state name. */
.ticket-node .tickets-issue-meta.ticket-status-row {
    display: flex;
    align-items: center;
    gap: 6px;
}
.ticket-node .tickets-issue-meta.ticket-status-row .ticket-sync-badge {
    flex-shrink: 0;
}
```

**Remove the obsolete pin rule** (lines 2788–2793):

```css
/* DELETE this block — badge no longer lives in card-actions */
.ticket-node .card-actions .ticket-sync-badge {
    margin-right: auto;
    align-self: center;
}
```

### 2. `src/webview/planning.js` — Linear card template (line ~8323)

Move `${syncBadge}` out of `card-actions` and into the status meta line, adding the `ticket-status-row` class.

**Before** (lines 8323–8336):
```js
return `
<div class="ticket-node${isSelected ? ' selected' : ''}" data-linear-issue-id="${escapeAttr(issue.id)}">
    ${statusLight}
    <div class="tickets-issue-title">${escapeHtml(issue.title || issue.identifier || issue.id)}</div>
    <div class="tickets-issue-meta">${escapeHtml(issue.state?.name || 'Unknown state')}</div>
    <div class="tickets-issue-meta">${escapeHtml(issue.assignee?.name || issue.assignee?.email || 'Unassigned')}</div>
    <div class="tickets-issue-meta">${escapeHtml((issue.description || '').trim().slice(0, 180) || 'No description provided.')}</div>
    <div class="card-actions">
        ${syncBadge}
        <button type="button" class="card-icon-btn" data-import-plan-id="${escapeAttr(issue.id)}" data-provider="linear">Add to kanban</button>
        <button type="button" class="card-icon-btn" data-link-ticket-id="${escapeAttr(issue.id)}" data-provider="linear">Link to ticket</button>
        <button type="button" class="card-icon-btn" data-refine-ticket-id="${escapeAttr(issue.id)}" data-provider="linear">Refine</button>
    </div>
</div>
`;
```

**After**:
```js
return `
<div class="ticket-node${isSelected ? ' selected' : ''}" data-linear-issue-id="${escapeAttr(issue.id)}">
    ${statusLight}
    <div class="tickets-issue-title">${escapeHtml(issue.title || issue.identifier || issue.id)}</div>
    <div class="tickets-issue-meta ticket-status-row">${escapeHtml(issue.state?.name || 'Unknown state')}${syncBadge}</div>
    <div class="tickets-issue-meta">${escapeHtml(issue.assignee?.name || issue.assignee?.email || 'Unassigned')}</div>
    <div class="tickets-issue-meta">${escapeHtml((issue.description || '').trim().slice(0, 180) || 'No description provided.')}</div>
    <div class="card-actions">
        <button type="button" class="card-icon-btn" data-import-plan-id="${escapeAttr(issue.id)}" data-provider="linear">Add to kanban</button>
        <button type="button" class="card-icon-btn" data-link-ticket-id="${escapeAttr(issue.id)}" data-provider="linear">Link to ticket</button>
        <button type="button" class="card-icon-btn" data-refine-ticket-id="${escapeAttr(issue.id)}" data-provider="linear">Refine</button>
    </div>
</div>
`;
```

### 3. `src/webview/planning.js` — ClickUp card template (line ~8852)

Apply the same restructuring to the ClickUp card.

**Before** (lines 8852–8865):
```js
return `
<div class="ticket-node${isSelected ? ' selected' : ''}" data-clickup-task-id="${escapeAttr(task.id)}">
    ${statusLight}
    <div class="tickets-issue-title">${escapeHtml(task.title || task.identifier)}</div>
    <div class="tickets-issue-meta">${escapeHtml(task.status || 'Unknown')}</div>
    <div class="tickets-issue-meta">${task.assignees?.length ? escapeHtml(task.assignees.map(a => a.username || a.email).join(', ')) : 'Unassigned'}</div>
    <div class="card-actions">
        ${syncBadge}
        <button type="button" class="card-icon-btn" data-import-plan-id="${escapeAttr(task.id)}" data-provider="clickup">Add to kanban</button>
        <button type="button" class="card-icon-btn" data-link-ticket-id="${escapeAttr(task.id)}" data-provider="clickup">Link to ticket</button>
        <button type="button" class="card-icon-btn" data-refine-ticket-id="${escapeAttr(task.id)}" data-provider="clickup">Refine</button>
    </div>
</div>
`;
```

**After**:
```js
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
    </div>
</div>
`;
```

## Verification Plan

1. **Build**: `npm run compile` — confirm no webpack errors.
2. **Visual check (Linear)**: Open the Tickets tab with a loaded Linear project. Confirm each sidebar card shows the sync badge (`synced`/`modified`/`local`) inline to the right of the status name on the status meta row, and that the `card-actions` row now contains only the three action buttons right-aligned.
3. **Visual check (ClickUp)**: Repeat with a loaded ClickUp project — same expected layout.
4. **Badge states**: Verify a `modified` ticket (edit a local field without pushing) shows the amber `modified` badge in the new position; a `local`-only ticket shows the muted `local` badge.
5. **Narrow sidebar**: Collapse the sidebar to a narrow width and confirm the status row + badge does not overflow or push the badge off-card (flex `gap` + `flex-shrink: 0` should keep it tidy).
6. **Click behavior**: Confirm clicking the badge area does not trigger card selection or any action (badge remains `pointer-events: none`), and that the three action buttons still fire their respective handlers.
