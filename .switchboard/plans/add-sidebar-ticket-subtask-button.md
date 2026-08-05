# Add +Subtask Button to Sidebar Ticket Actions Dropdown

## Metadata
**Complexity:** 2
**Tags:** frontend, ui, ux, feature
**Project:** Browser Switchboard

## Goal
Add a `+ Subtask` option to the "⋯ More" actions dropdown menu on each sidebar ticket card in `tickets.html` / `tickets.js`. Clicking this option should trigger the exact same subtask creation flow as the `+ Subtask` button in the preview controls strip (setting the clicked ticket as the parent and opening the `#create-ticket-modal`).

## Proposed Changes

### 1. Update Card Templates in `src/webview/tickets.js`
- In `_renderClickUpTicketCard(task)`:
  Add a `+ Subtask` button inside the card's `.overflow-menu-popover`:
  ```html
  <button type="button" class="card-icon-btn overflow-menu-item" data-add-subtask-ticket-id="${escapeAttr(task.id)}" data-provider="clickup" title="Create a subtask under this ticket">+ Subtask</button>
  ```
- In `_renderLinearTicketCard(issue)`:
  Add a `+ Subtask` button inside the card's `.overflow-menu-popover`:
  ```html
  <button type="button" class="card-icon-btn overflow-menu-item" data-add-subtask-ticket-id="${escapeAttr(issue.id)}" data-provider="linear" title="Create a subtask under this ticket">+ Subtask</button>
  ```

### 2. Refactor Subtask Creation Modal Logic into Reusable Helper in `src/webview/tickets.js`
- Create a helper function `openCreateSubtaskModal(provider, ticketId, ticketTitle)`:
  ```js
  function openCreateSubtaskModal(provider, ticketId, ticketTitle) {
      _subtaskParent = { id: ticketId, title: ticketTitle, provider };
      const modal = document.getElementById('create-ticket-modal');
      if (modal) {
          modal.style.display = 'block';
          const modalTitle = document.getElementById('create-ticket-modal-title');
          if (modalTitle) modalTitle.textContent = 'Create Subtask under ' + ticketTitle;
          const titleInput = document.getElementById('create-ticket-title');
          const descInput = document.getElementById('create-ticket-description');
          if (titleInput) { titleInput.value = ''; titleInput.focus(); }
          if (descInput) descInput.value = '';
          _resetCreateModalMetadata();
          _populateCreateModalStatus();
          _populateCreateModalPriority();
          _loadCreateModalMembers();
      }
  }
  ```
- Update the existing `#btn-add-subtask` click listener (in the preview control strip) to use `openCreateSubtaskModal(provider, ticketId, ticketTitle)`.

### 3. Wire Delegated Click Event Listener in `src/webview/tickets.js`
- In the `#tickets-issues-container` delegated click listener:
  - Add a case for `e.target.closest('[data-add-subtask-ticket-id]')`:
    - Extract `ticketId` and `provider`.
    - Stop event propagation (`e.stopPropagation()`).
    - Dismiss any active overflow popover (`_closeAllOverflowPopovers(null)`).
    - Resolve the ticket title from `clickUpProjectIssues` / `linearProjectIssues` / cached items.
    - Invoke `openCreateSubtaskModal(provider, ticketId, ticketTitle)`.

## Verification Plan

### Automated / Syntax Check
- Verify `tickets.js` and `tickets.html` have no JS syntax errors or unclosed HTML tags.

### Manual Verification
1. Open the Tickets tab in Switchboard (`tickets.html`).
2. Load tickets from a provider (ClickUp or Linear).
3. Hover/focus a ticket card in the sidebar and click its "⋯ More" overflow menu trigger.
4. Verify `+ Subtask` appears in the dropdown menu alongside `Move`.
5. Click `+ Subtask`.
   - Verify the overflow menu closes.
   - Verify `#create-ticket-modal` opens with title `"Create Subtask under <Ticket Title>"`.
6. Fill in the subtask title and click **Create**.
7. Confirm that the created task payload includes the correct `parentId` field.
