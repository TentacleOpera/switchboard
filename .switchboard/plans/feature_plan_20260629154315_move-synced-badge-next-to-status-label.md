# Move 'synced' Badge Next to Status Label in Tickets Tab Sidebar Cards

## Goal

In the planning.html Tickets tab, each sidebar ticket card currently renders a sync-status badge (`synced` / `modified` / `local`) inside the bottom `card-actions` row, pinned to the bottom-left via `margin-right: auto`. The user wants this badge relocated so it sits inline next to the **status label** (the first `tickets-issue-meta` line that shows the ticket state name), rather than occupying space in the action-button row.

### Problem Analysis & Root Cause

The sync badge is emitted by `_ticketSyncBadge()` (planning.js ~line 8262) and injected into the `card-actions` div for both Linear cards (line 8331) and ClickUp cards (line 8859). The CSS rule `.ticket-node .card-actions .ticket-sync-badge { margin-right: auto; align-self: center; }` (planning.html line 2790) pins it to the bottom-left of the action row, pushing the action buttons to the right.

This is purely a layout/placement concern — the badge is informational (`pointer-events: none`) and has no click behavior, so moving it is a low-risk HTML/CSS restructuring. The status label lives in the first `tickets-issue-meta` div (line 8327 for Linear, line 8856 for ClickUp), which currently renders only the state name text.

## Metadata

- **Tags:** frontend, ui, refactor
- **Complexity:** 2/10

## User Review Required

**No.** This is a self-contained, low-risk layout relocation with no data, event, or provider-API impact. The badge remains non-interactive. Proceed directly.

## Complexity Audit

### Routine
- Adding a `ticket-status-row` class to the status `tickets-issue-meta` div in two card templates (Linear line 8327, ClickUp line 8856).
- Moving `${syncBadge}` from the `card-actions` div into the status meta line in both templates.
- Adding one CSS rule (`.ticket-status-row` flex layout) and removing the obsolete `card-actions` pin rule (lines 2788–2793).
- The badge is `pointer-events: none` (line 2785) — no click-handler impact.

### Complex / Risky
- None.

## Edge-Case & Dependency Audit

- **Race Conditions:** None. The badge is rendered synchronously from `issue.syncStatus`/`task.syncStatus` already in memory at render time.
- **Security:** None. Pure layout change; no new data flows or attributes.
- **Side Effects:** Removing the `card-actions` pin rule (lines 2788–2793) is safe — `card-actions` already has `justify-content: flex-end` (line 2753), so the three action buttons stay right-aligned without the badge pushing them.
- **Dependencies & Conflicts:**
  - No dependency on any other plan.
  - Orthogonal to Plan 1 (Open button): Plan 1 adds a button to `card-actions`; Plan 2 removes the badge from `card-actions`. Both can land independently or together without conflict (they touch different rows of the same template).
  - **CSS specificity note (Clarification):** The base `.ticket-sync-badge` rule (line 2784) sets `align-self: flex-start`. When the badge moves into the new `.ticket-status-row` flex container (which uses `align-items: center`), the child's `align-self: flex-start` **overrides** the parent's `align-items: center`, causing the badge to top-align rather than vertically center with the status text. The new `.ticket-status-row .ticket-sync-badge` rule MUST reset `align-self: center` (see Proposed Changes §1).

## Dependencies

- None.

## Adversarial Synthesis

Key risks: (1) the base `.ticket-sync-badge` `align-self: flex-start` (line 2784) overrides the new status row's `align-items: center`, leaving the badge top-aligned next to the status text — fixed by explicitly setting `align-self: center` on `.ticket-status-row .ticket-sync-badge`; (2) long status names could crowd the badge on narrow sidebars — mitigated by `flex-shrink: 0` on the badge plus the row's `gap`. No event, data, or provider impact. Mitigations are pure CSS and self-contained.

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
    align-self: center; /* overrides base .ticket-sync-badge align-self: flex-start (line 2784) */
}
```

> **Clarification (added during review):** The `align-self: center` line above is required. Without it, the base `.ticket-sync-badge { align-self: flex-start; }` (line 2784) wins over the parent's `align-items: center` and the badge hugs the top of the row.

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

> Per session directives: skip compilation (`npm run compile`) and skip automated tests. The user runs those separately. Verification here is manual/visual.

### Automated Tests
- None run in this session.

### Manual Verification
1. **Visual check (Linear)**: Open the Tickets tab with a loaded Linear project. Confirm each sidebar card shows the sync badge (`synced`/`modified`/`local`) inline to the right of the status name on the status meta row, vertically centered with the status text (confirm the `align-self: center` fix holds — badge is NOT top-aligned). Confirm the `card-actions` row now contains only the three action buttons, right-aligned.
2. **Visual check (ClickUp)**: Repeat with a loaded ClickUp project — same expected layout.
3. **Badge states**: Verify a `modified` ticket (edit a local field without pushing) shows the amber `modified` badge in the new position; a `local`-only ticket shows the muted `local` badge.
4. **Narrow sidebar**: Collapse the sidebar to a narrow width and confirm the status row + badge does not overflow or push the badge off-card (flex `gap` + `flex-shrink: 0` should keep it tidy).
5. **Click behavior**: Confirm clicking the badge area does not trigger card selection or any action (badge remains `pointer-events: none`), and that the three action buttons still fire their respective handlers.
6. **Removed CSS rule**: Confirm no other element relied on the deleted `.ticket-node .card-actions .ticket-sync-badge` pin rule (grep should show no remaining references to it).

## Recommendation

Complexity 2 → **Send to Intern.** Self-contained HTML/CSS relocation in two templates and one stylesheet block; the only care point (the `align-self` override) is now explicitly documented in the CSS.
