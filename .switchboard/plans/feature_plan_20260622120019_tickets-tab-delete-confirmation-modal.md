# Replace Immediate Ticket Delete With a Custom Confirmation Modal

## Goal

In the Tickets tab of `planning.html`, the **Delete** button deletes immediately with no confirmation. Change it to open a custom in-webview confirmation modal that holds the actual delete action. Do NOT use a VS Code confirmation/alert dialog — the confirmation must be a custom modal where the real Delete button lives.

### Problem Analysis

The Delete handler fires immediately ([planning.js:5963-5972](src/webview/planning.js#L5963)):
```js
// Action bar: Delete — immediate, no confirm gate
document.getElementById('btn-delete-ticket')?.addEventListener('click', () => {
    ...
    setTicketsLoadingState(true);
    vscode.postMessage({ type: 'deleteTicketConfirmed', provider, id, workspaceRoot: ticketsWorkspaceRoot });
});
```
There is no confirmation gate. Notably, the webview already references a delete-confirm banner (`tickets-delete-confirm-banner`, `delete-confirm-input`, `confirm-delete-ticket`, `cancel-delete-ticket` — captured at [planning.js:502-505](src/webview/planning.js#L502) and hidden at [3587-3588](src/webview/planning.js#L3578)) but **no such elements exist in `planning.html`** — it is dead/abandoned markup. So the confirmation UI was started and never completed; today Delete is a one-click destructive action.

### Root Cause

The Delete button dispatches the destructive `deleteTicketConfirmed` message directly, and the intended custom confirmation modal was never added to the HTML.

## Metadata

**Complexity:** 3
**Tags:** frontend, tickets, ux, safety, modal

## Complexity Audit

### Routine
- Adding a custom confirmation modal (reuse the `.folder-modal` pattern from `#convert-subtask-modal`, [planning.html:3538](src/webview/planning.html#L3538)).
- Changing the Delete button to open the modal instead of deleting.

### Complex / Risky
- The actual delete must only fire from the modal's confirm button. Loading state, list refresh, and the existing `ticketDeleted` result handling ([planning.js:3583-3594](src/webview/planning.js#L3583)) must continue to work, including hiding the modal on success.

## Edge-Case & Dependency Audit

- **Race Conditions:** Guard against double-confirm (disable the confirm button after click until the `ticketDeleted` result returns).
- **Security:** None new — same `deleteTicketConfirmed` message, now gated behind explicit confirmation.
- **Side Effects:** The dead `tickets-delete-confirm-banner` references can be removed or repurposed; ensure the success handler hides the new modal (the existing code tries to hide a non-existent banner, [planning.js:3577-3578](src/webview/planning.js#L3577)).
- **Dependencies & Conflicts:** Must NOT use `vscode.window.showWarningMessage`/`showQuickPick` for confirmation — explicitly a custom webview modal. Coordinate with the Source-modal and slim-labels plans (same toolbar).

## Proposed Changes

### 1. `src/webview/planning.html` — add the confirmation modal
Add a `.folder-modal` `#tickets-delete-modal` (modelled on `#convert-subtask-modal`):
```html
<div class="folder-modal" id="tickets-delete-modal" style="display:none;" role="dialog" aria-modal="true" aria-labelledby="tickets-delete-modal-title">
  <div class="folder-modal-content">
    <div class="folder-modal-header">
      <h3 id="tickets-delete-modal-title">Delete ticket?</h3>
      <button class="modal-close-btn" id="btn-close-tickets-delete-modal" aria-label="Close">&times;</button>
    </div>
    <div class="folder-modal-body">
      <div id="tickets-delete-modal-info" style="font-size:12px; color:var(--text-secondary);"></div>
      <div style="display:flex; justify-content:flex-end; gap:8px; margin-top:12px;">
        <button id="btn-cancel-tickets-delete" class="strip-btn">Cancel</button>
        <button id="btn-confirm-tickets-delete" class="planning-button" style="margin:0; padding:4px 12px; color:var(--accent-red); border-color:var(--accent-red);">Delete</button>
      </div>
    </div>
  </div>
</div>
```

### 2. `src/webview/planning.js` — gate deletion behind the modal
- Change the `#btn-delete-ticket` handler ([5963](src/webview/planning.js#L5963)) to capture provider+id, populate `#tickets-delete-modal-info` (ticket title/id), and show `#tickets-delete-modal` — do NOT post `deleteTicketConfirmed` here.
- Add a `#btn-confirm-tickets-delete` handler that posts `deleteTicketConfirmed` (with the captured provider/id), sets loading state, and disables itself.
- Add Cancel / close / overlay-click handlers that hide the modal without deleting.
- In the `ticketDeleted` success handler ([3583-3594](src/webview/planning.js#L3583)), hide `#tickets-delete-modal` (replace the stale `tickets-delete-confirm-banner` lookup).

## Verification Plan

1. Build; open Planning → Tickets → select a ticket → click **Delete** → confirm a custom modal appears (NOT a VS Code dialog) showing the ticket identity and a Delete button.
2. Click **Cancel** / outside / × → confirm the modal closes and the ticket is NOT deleted.
3. Click the modal's **Delete** → confirm the ticket is deleted, the list refreshes, and the modal closes on success.
4. Trigger a delete failure (e.g. offline) → confirm an error status shows and the ticket remains; confirm the confirm button re-enables.
5. Double-click the confirm button quickly → confirm only one delete is dispatched.
