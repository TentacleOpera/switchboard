# Make status & assignee labels on ticket sidebar cards open edit modals

> Imported from user request (memo)

## Goal

In the Tickets tab of `planning.html`, the sidebar ticket cards (rendered by `_renderLinearTicketCard` / `_renderClickUpTicketCard` in `planning.js`) currently show a status row and an assignee row as **plain, non-interactive `<div class="tickets-issue-meta">` text**. Clicking on them does nothing — the user has to first select the card, then use the detail-pane meta-bar (`#select-status-ticket` dropdown and `btn-assign-ticket` button) to change status or assignees.

The user expects: clicking the **status label** or the **assignees label** directly on a sidebar card should open a modal that lets them edit that field for the clicked ticket, without first having to select the card and travel to the detail pane.

### Problem analysis & root cause

1. **Card markup has no affordance.** `_renderLinearTicketCard` (planning.js:9989-10014) emits:
   - `<div class="tickets-issue-meta ticket-status-row">${state name}${syncBadge}</div>` (line 10002)
   - `<div class="tickets-issue-meta">${assignee name | 'Unassigned'}</div>` (line 10003)
   `_renderClickUpTicketCard` (planning.js:9961-9985) emits the same two rows (lines 9974-9975). None of these rows carry `data-*` attributes, cursor styling, or any click target.

2. **The delegated click handler has no branch for them.** The single delegated listener on `#tickets-issues-container` (planning.js:9133-9292) handles: priority dot, status-group accordion header, drill-down back header, import/link/move/refine/open buttons, and finally the bare card (selecting the ticket). There is no `closest('.ticket-status-row')` / assignee-row branch, so clicks on those rows fall through to the card-selection branch at line 9241 — they select the ticket but never open an editor.

3. **Status editing has no modal at all.** Status is changed only via the `#select-status-ticket` `<select>` in the detail meta-bar (planning.html:3863), whose `change` handler (planning.js:8845-8854) posts `changeTicketStatus`. There is no status modal to reuse.

4. **The assignee modal is selection-coupled.** `openAssignModal()` (planning.js:488-531) and `saveAssign()` (planning.js:644-712) both read the *currently selected* ticket (`selectedLinearIssue?.issue?.id` / `selectedClickUpIssue?.task?.id`) and `lastIntegrationProvider`. The result handlers `linearUpdateIssueAssigneeResult` / `clickupUpdateTaskAssigneesResult` (planning.js:5898-5929) mutate `selectedLinearIssue`/`selectedClickUpIssue` and the matching entry in `linearProjectIssues`/`clickUpProjectIssues`. So the modal cannot be opened for an arbitrary card without that card being the selected ticket.

**Root cause:** the sidebar card rows were authored as display-only text; the edit affordances were placed only in the detail-pane meta-bar and bound to the selection state. To make the labels clickable we must (a) tag the rows, (b) intercept their clicks before the card-selection fallback, (c) ensure the clicked ticket becomes the selected ticket (so the existing assignee modal + all result handlers work unchanged), and (d) add a status modal reusing the existing `changeTicketStatus` message path.

## Metadata

- **Tags:** frontend, ui, ux
- **Complexity:** 4

## User Review Required

No — this is a self-contained webview-only UX change. The approach (tag rows, intercept clicks, select-then-open-modal, new status modal reusing existing message) is well-scoped and reuses existing patterns. No architectural decisions need user sign-off.

## Complexity Audit

### Routine

- Add `data-edit-status` (with `data-provider` + `data-ticket-id`) to the status row and `data-edit-assignees` (with `data-provider` + `data-ticket-id`) to the assignee row in both `_renderLinearTicketCard` (planning.js:9989) and `_renderClickUpTicketCard` (planning.js:9961). Add `cursor:pointer` to these rows via a small CSS rule in planning.html.
- Add two branches near the top of the `#tickets-issues-container` delegated click handler (planning.js:9133), before the card-selection fallback at line 9241: one for `[data-edit-status]`, one for `[data-edit-assignees]`. Each calls `e.stopPropagation()` then a new helper that selects the clicked ticket and opens the relevant modal.
- Add a new `showTicketStatusModal(provider, ticketId)` function and a new `<div class="folder-modal" id="ticket-status-modal">` block in planning.html (mirroring the existing `#assign-modal` structure at planning.html:4179-4198), wired to post the existing `changeTicketStatus` message.

### Complex / Risky

- **Moderate risk — selection coupling.** `openAssignModal`/`saveAssign`/result handlers all key off `selectedLinearIssue`/`selectedClickUpIssue` and `lastIntegrationProvider`. The clean fix is to make the new click branches **select the clicked ticket first** (reuse the exact selection logic from the card-click branch at planning.js:9241-9291: set `selectedLinearIssue`/`selectedClickUpIssue` from the detail cache or the issues array, call `renderTicketsLinearPanel()`/`renderTicketsClickUpPanel()`, and post `readLocalTicketFile`), then call `openAssignModal()`. This keeps `openAssignModal`/`saveAssign`/result handlers untouched and avoids a risky refactor of selection-coupled code. The risk is double-render flicker; acceptable for a modal-opening path.
- **Low risk — status options availability.** `availableLinearStates` (planning.js:308, populated at 5884) and `availableClickUpStatuses` (planning.js:310, populated at 5996) are loaded asynchronously and may be empty if the user opens the status modal before the project/list statuses arrive. The status modal must show a "Loading statuses…" placeholder and re-render when `linearStatesLoaded`/`clickupListStatusesLoaded` arrive, OR disable Save until populated. The existing `#select-status-ticket` dropdown already handles this by falling back to deriving states from `linearProjectIssues` (planning.js:10265-10273) — reuse that fallback in the modal.
- **Low risk — ClickUp assignees need `list.id`.** `openAssignModal` reads `selectedClickUpIssue?.task?.list?.id` (planning.js:503-505) for the `loadTicketAssignees` message. Selecting the ticket first (from `clickUpProjectIssues` or `clickUpTaskDetailCache`) preserves `task.list.id`, so this works unchanged.

## Edge-Case & Dependency Audit

- **Drill-down / subtask cards.** `_renderLinearTicketCard` is also used for subtask cards in drill-down mode (planning.js:10167). The new click branches must work for subtask cards too — selecting a subtask sets `selectedLinearIssue`/`selectedClickUpIssue` to the subtask, which is the correct behavior (the assignee/status modal should edit the subtask). The `data-ticket-id` on the row disambiguates; the selection helper must look up the issue in `linearProjectIssues` **or** `_drillDownSubtasks` (mirroring the refine branch at planning.js:9211-9219).
- **Click vs. text selection.** Adding `cursor:pointer` and a click handler to the status/assignee rows must not break double-click text selection or the existing card-selection behavior for the rest of the card. `e.stopPropagation()` in the new branches prevents the card-selection fallback from also firing.
- **Sync badge inside status row.** The status row contains `${syncBadge}` (planning.js:10002, 9974). The `data-edit-status` attribute goes on the row `<div>`, and `closest('[data-edit-status]')` from the click target handles clicks on the badge text too — acceptable (editing status from anywhere on the row). If the badge should be excluded, scope the attribute to a child span; not required by the issue.
- **Empty / loading states.** Status modal when `availableLinearStates` is empty: reuse the derive-from-issues fallback. Assignee modal already shows "Loading members…" (planning.js:520).
- **Provider mismatch.** `lastIntegrationProvider` must match the card's provider. Since cards are only rendered for the active provider's list, `data-provider` on the row will match `lastIntegrationProvider`; the helper should assert/guard anyway.
- **No backend changes.** Both `changeTicketStatus` and `loadTicketAssignees`/`linearUpdateIssueAssignee`/`clickupUpdateTaskAssignees` messages already exist and are handled. No extension-host / TS changes required — this is a webview-only change.
- **Dependencies & conflicts:** None. Self-contained within `planning.js` and `planning.html`.

## Dependencies

None — this plan does not depend on any other plan or session. It is self-contained within `planning.js` and `planning.html`.

## Adversarial Synthesis

Key risks: (1) selection-coupling — `openAssignModal`/`saveAssign` key off `selectedLinearIssue`/`selectedClickUpIssue`, so the click branch must select the ticket first (mitigated by `_selectTicketFromCard` reusing the exact card-click selection logic); (2) double-render flicker from selecting then opening a modal (acceptable for a modal-opening path); (3) status options may be empty if the modal opens before async state data arrives (mitigated by reusing the derive-from-issues fallback from the existing `#select-status-ticket` dropdown). The plan correctly avoids refactoring selection-coupled code and instead works within its constraints.

## Proposed Changes

### `/Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/planning.js`

**1. Tag the status & assignee rows in `_renderClickUpTicketCard` (lines 9974-9975):**

```js
<div class="tickets-issue-meta ticket-status-row" data-edit-status data-provider="clickup" data-ticket-id="${escapeAttr(task.id)}">${escapeHtml(task.status || 'Unknown')}${syncBadge}</div>
<div class="tickets-issue-meta ticket-edit-assignees" data-edit-assignees data-provider="clickup" data-ticket-id="${escapeAttr(task.id)}">${task.assignees && task.assignees.length ? escapeHtml(task.assignees.map(a => a.username || a.email).join(', ')) : 'Unassigned'}</div>
```

**2. Tag the same rows in `_renderLinearTicketCard` (lines 10002-10003):**

```js
<div class="tickets-issue-meta ticket-status-row" data-edit-status data-provider="linear" data-ticket-id="${escapeAttr(issue.id)}">${escapeHtml(issue.state?.name || 'Unknown state')}${syncBadge}</div>
<div class="tickets-issue-meta ticket-edit-assignees" data-edit-assignees data-provider="linear" data-ticket-id="${escapeAttr(issue.id)}">${escapeHtml(issue.assignee?.name || issue.assignee?.email || 'Unassigned')}</div>
```

**3. Add a `_selectTicketFromCard(provider, id)` helper** (place near `_maybeEnterDrillDown`, ~line 10054) that encapsulates the selection logic currently inline at lines 9241-9291, looking up the issue in `linearProjectIssues`/`clickUpProjectIssues` **or** `_drillDownSubtasks`, setting `selectedLinearIssue`/`selectedClickUpIssue` from the detail cache when available, calling `renderTicketsLinearPanel()`/`renderTicketsClickUpPanel()`, and posting `readLocalTicketFile` (+ `linearLoadTaskDetails`/`clickupLoadTaskDetails` when not cached). This is a pure extract refactor of the existing card-click branch — no behavior change for plain card clicks.

**4. Add two branches at the top of the `#tickets-issues-container` click handler** (insert after the `priorityDot` branch at line 9145, before the `statusHeader` branch at line 9149):

```js
const statusRow = e.target.closest('[data-edit-status]');
if (statusRow) {
    e.stopPropagation();
    const provider = statusRow.dataset.provider;
    const id = statusRow.dataset.ticketId;
    _selectTicketFromCard(provider, id);
    showTicketStatusModal(provider, id);
    return;
}
const assigneeRow = e.target.closest('[data-edit-assignees]');
if (assigneeRow) {
    e.stopPropagation();
    const provider = assigneeRow.dataset.provider;
    const id = assigneeRow.dataset.ticketId;
    _selectTicketFromCard(provider, id);
    openAssignModal();
    return;
}
```

**5. Add `showTicketStatusModal(provider, ticketId)`** (place near `showMoveTicketModal`, line 998). It:
- Builds the option list from `availableLinearStates` (Linear) or `availableClickUpStatuses` (ClickUp), with the same derive-from-issues fallback used at planning.js:10265-10273 when `availableLinearStates` is empty.
- Pre-selects the ticket's current status (Linear: `issue.state.id` / `.name`; ClickUp: `task.status` matched by `s.status`).
- Shows the modal (`#ticket-status-modal`).
- Wires the modal's Save button to post the existing `changeTicketStatus` message (`{ type: 'changeTicketStatus', provider, id, statusId, workspaceRoot }`) — identical to the `#select-status-ticket` change handler at planning.js:8845-8854. The existing `changeTicketStatusResult` handler (planning.js:5417-5447) updates the issue and re-renders the list, so the sidebar card status text updates after save.
- Wires Cancel / close to hide the modal.

**6. Wire the status modal buttons** in the tickets-tab init block (near line 9360 where `btn-assign-ticket` is wired): `btn-close-ticket-status-modal`, `btn-cancel-ticket-status`, `btn-save-ticket-status`.

### `/Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/planning.html`

**7. Add CSS** (near the `.ticket-node .tickets-issue-meta` rule at line 2839) making the two editable rows afford clicking:

```css
.ticket-node .tickets-issue-meta[data-edit-status],
.ticket-node .tickets-issue-meta[data-edit-assignees] {
    cursor: pointer;
}
.ticket-node .tickets-issue-meta[data-edit-status]:hover,
.ticket-node .tickets-issue-meta[data-edit-assignees]:hover {
    text-decoration: underline;
    color: var(--accent-teal, #00ffcc);
}
```

**8. Add the status modal markup** (place immediately after the `#assign-modal` block ending at line 4198), mirroring its structure:

```html
<div class="folder-modal" id="ticket-status-modal" style="display: none;" role="dialog" aria-modal="true" aria-labelledby="ticket-status-modal-title">
    <div class="modal-content" style="max-width: 420px;">
        <div class="modal-header">
            <h3 id="ticket-status-modal-title">Change Status</h3>
            <button class="modal-close-btn" id="btn-close-ticket-status-modal" aria-label="Close">&times;</button>
        </div>
        <div class="modal-body" style="margin-top: 10px;">
            <div style="display: flex; flex-direction: column; gap: 12px;">
                <select id="ticket-status-select" class="kanban-meta-dropdown" style="width: 100%; background: var(--panel-bg2, #1a1a2e); border: 1px solid var(--border-color); color: var(--text-primary); font-size: 12px; padding: 4px 8px; box-sizing: border-box; border-radius: 3px;"></select>
                <div id="ticket-status-modal-loading" style="display:none; font-size:12px; color: var(--text-secondary);">Loading statuses…</div>
                <div style="display: flex; justify-content: flex-end; gap: 8px; margin-top: 12px;">
                    <button id="btn-cancel-ticket-status" class="strip-btn">Cancel</button>
                    <button id="btn-save-ticket-status" class="planning-button" style="margin: 0; padding: 4px 12px;">Save</button>
                </div>
            </div>
        </div>
    </div>
</div>
```

## Verification Plan

- [ ] **Linear status:** Open Tickets tab → Linear project. Click the status text on a sidebar card → status modal opens with the ticket's current status pre-selected. Pick a different status → Save → `changeTicketStatusResult` fires, the card's status row text updates, and the card moves to the new status-group accordion section on next render.
- [ ] **Linear assignees:** Click the assignee text on a sidebar card → assign modal opens with the current assignee pre-checked. Change assignee → Save → `linearUpdateIssueAssigneeResult` fires, the card's assignee row text updates.
- [ ] **ClickUp status:** Repeat the status flow for a ClickUp list. Confirm `availableClickUpStatuses` populates the modal and `changeTicketStatusResult` updates `task.status` and re-renders.
- [ ] **ClickUp assignees:** Repeat the assignee flow for a ClickUp task (multi-select checkboxes). Confirm `clickupUpdateTaskAssigneesResult` updates `task.assignees` and re-renders the card.
- [ ] **Subtask / drill-down cards:** Enter drill-down for a parent with subtasks. Click status/assignee on a subtask card → modal opens for the subtask (not the parent); save updates the subtask.
- [ ] **No regression on plain card click:** Clicking the card title, description, priority dot, or action buttons still selects the ticket / opens the right popover and does **not** open the status/assignee modal.
- [ ] **Empty status catalog:** Open the status modal before `availableLinearStates` arrives → modal shows the derive-from-issues fallback list (or "Loading statuses…" then populates); Save is disabled until a status is selectable.
- [ ] **Cursor / hover affordance:** Status and assignee rows show `cursor:pointer` and underline on hover; other meta rows do not.
