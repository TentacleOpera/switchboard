# Replace Immediate Ticket Delete With a Custom Confirmation Modal

## Goal

In the Tickets tab of `planning.html`, the **Delete** button deletes immediately with no confirmation. Change it to open a custom in-webview confirmation modal that holds the actual delete action. Do NOT use a VS Code confirmation/alert dialog — the confirmation must be a custom modal where the real Delete button lives.

### Problem Analysis

The Delete handler fires immediately ([planning.js:5978-5987](src/webview/planning.js#L5978)):
```js
// Action bar: Delete — immediate, no confirm gate
document.getElementById('btn-delete-ticket')?.addEventListener('click', () => {
    const provider = lastIntegrationProvider;
    const id = provider === 'linear'
        ? selectedLinearIssue?.issue.id
        : selectedClickUpIssue?.task.id;
    if (!id) return;
    setTicketsLoadingState(true);
    vscode.postMessage({ type: 'deleteTicketConfirmed', provider, id, workspaceRoot: ticketsWorkspaceRoot });
});
```
There is no confirmation gate. Notably, the webview already references a delete-confirm banner (`tickets-delete-confirm-banner`, `delete-confirm-input`, `confirm-delete-ticket`, `cancel-delete-ticket` — captured at [planning.js:503-506](src/webview/planning.js#L503) and hidden at [3593-3594](src/webview/planning.js#L3593)) but **no such elements exist in `planning.html`** — it is dead/abandoned markup. So the confirmation UI was started and never completed; today Delete is a one-click destructive action.

### Root Cause

The Delete button dispatches the destructive `deleteTicketConfirmed` message directly, and the intended custom confirmation modal was never added to the HTML.

## Metadata

**Complexity:** 3
**Tags:** frontend, ui, ux, bugfix, feature

## User Review Required

> **⚠️ BLOCKING — CLAUDE.md Rule Conflict**
>
> This plan directly contradicts the project's hard rule in `CLAUDE.md`:
>
> > "NEVER add confirmation dialogs. NO EXCEPTIONS. Delete buttons delete immediately. No `confirm()`, no `window.confirm()`, no modal `showWarningMessage`, no two-click patterns, no 'Are you sure?'. The user has demanded this repeatedly. Buttons are deliberately hard to misclick."
>
> This plan introduces a **two-click confirmation pattern** ("Delete → modal → confirm Delete"), which is exactly what the rule prohibits. The rule also notes a technical reason: `window.confirm()` is a silent no-op in VS Code webviews — but the rule's scope is broader than just `window.confirm()`; it covers *any* confirmation gate including custom modals.
>
> **The user must explicitly acknowledge this conflict before implementation proceeds.** If the user confirms they want to override the standing rule for the Tickets tab, proceed. Otherwise, this plan should be abandoned and the Delete button left as immediate-delete.

## Complexity Audit

### Routine
- Adding a custom confirmation modal (reuse the `.folder-modal` pattern from `#convert-subtask-modal`, [planning.html:3538](src/webview/planning.html#L3538)).
- Changing the Delete button to open the modal instead of deleting.
- Wiring open/close/overlay-click handlers following the established convert-subtask-modal pattern ([planning.js:6393-6417](src/webview/planning.js#L6393)).
- Cleaning up dead banner references at [planning.js:503-506](src/webview/planning.js#L503) and the stale banner-hide at [planning.js:3593-3594](src/webview/planning.js#L3593).

### Complex / Risky
- The actual delete must only fire from the modal's confirm button. Loading state, list refresh, and the existing `ticketDeleted` result handling ([planning.js:3589-3608](src/webview/planning.js#L3589)) must continue to work, including hiding the modal on success and re-enabling the confirm button on failure.
- **Policy conflict** with CLAUDE.md hard rule (see User Review Required).

## Edge-Case & Dependency Audit

- **Race Conditions:** Guard against double-confirm (disable the confirm button after click until the `ticketDeleted` result returns). Re-enable the confirm button on failure so the user can retry.
- **Security:** Ticket titles from external APIs (ClickUp/Linear) are inserted into the modal info div — MUST use `escapeHtml()` ([planning.js:226](src/webview/planning.js#L226)) to prevent XSS. Same `deleteTicketConfirmed` message, now gated behind explicit confirmation.
- **Side Effects:** The dead `tickets-delete-confirm-banner` references ([planning.js:503-506](src/webview/planning.js#L503)) should be removed from the `els` cache object. The success handler at [planning.js:3593-3594](src/webview/planning.js#L3593) tries to hide a non-existent banner — replace with hiding `#tickets-delete-modal`.
- **Dependencies & Conflicts:** Must NOT use `vscode.window.showWarningMessage`/`showQuickPick` for confirmation — explicitly a custom webview modal. Coordinate with the Source-modal and slim-labels plans (same toolbar). `--accent-red` CSS variable is NOT defined in `planning.html` (it exists only in `setup.html`); use `var(--accent-red, #f85149)` fallback or hardcode the color.

## Dependencies

None — self-contained frontend change.

## Adversarial Synthesis

Key risks: (1) **CLAUDE.md hard-rule conflict** — the project explicitly prohibits confirmation dialogs with "NO EXCEPTIONS"; this plan must not proceed without explicit user override. (2) **CSS class name bug** — the original plan used non-existent `folder-modal-content`/`folder-modal-header`/`folder-modal-body` classes; corrected to `modal-content`/`modal-header`/`modal-body`. (3) **Missing `--accent-red` variable** in planning.html and XSS risk from unescaped ticket titles. Mitigations: flag the policy conflict as blocking, fix CSS classes to match the actual codebase pattern, use `escapeHtml()` and a color fallback.

## Proposed Changes

### 1. `src/webview/planning.html` — add the confirmation modal

Insert the modal after the last existing modal (after `#tags-modal`, before the `<script>` tags at [line 3588](src/webview/planning.html#L3588)).

**Clarification:** The original plan used `folder-modal-content`, `folder-modal-header`, `folder-modal-body` — these CSS classes do **not exist**. The correct classes (matching `#convert-subtask-modal` at [line 3538](src/webview/planning.html#L3538) and the CSS at [line 2543+](src/webview/planning.html#L2543)) are `modal-content`, `modal-header`, `modal-body`.

**Clarification:** `--accent-red` is not defined in `planning.html` (only in `setup.html`). Use `var(--accent-red, #f85149)` fallback.

```html
<div class="folder-modal" id="tickets-delete-modal" style="display: none;" role="dialog" aria-modal="true" aria-labelledby="tickets-delete-modal-title">
    <div class="modal-content">
        <div class="modal-header">
            <h3 id="tickets-delete-modal-title">Delete ticket?</h3>
            <button class="modal-close-btn" id="btn-close-tickets-delete-modal" aria-label="Close">&times;</button>
        </div>
        <div class="modal-body" style="margin-top: 10px;">
            <div id="tickets-delete-modal-info" style="font-size: 12px; color: var(--text-secondary);"></div>
            <div style="display: flex; justify-content: flex-end; gap: 8px; margin-top: 12px;">
                <button id="btn-cancel-tickets-delete" class="strip-btn">Cancel</button>
                <button id="btn-confirm-tickets-delete" class="planning-button" style="margin: 0; padding: 4px 12px; color: var(--accent-red, #f85149); border-color: var(--accent-red, #f85149);">Delete</button>
            </div>
        </div>
    </div>
</div>
```

### 2. `src/webview/planning.js` — gate deletion behind the modal

#### 2a. Add a module-level variable to capture the pending delete target

Near the other tickets-related variables (e.g. near `_convertCurrentTicketId`):
```js
let _pendingDeleteTicket = null; // { provider, id, title }
```

#### 2b. Change the `#btn-delete-ticket` handler ([line 5978](src/webview/planning.js#L5978))

Replace the immediate-delete handler with one that opens the modal:
```js
document.getElementById('btn-delete-ticket')?.addEventListener('click', () => {
    const provider = lastIntegrationProvider;
    const id = provider === 'linear'
        ? selectedLinearIssue?.issue.id
        : selectedClickUpIssue?.task.id;
    if (!id) return;
    const title = provider === 'linear'
        ? selectedLinearIssue?.issue.title
        : selectedClickUpIssue?.task.title || selectedClickUpIssue?.task.name || '';
    _pendingDeleteTicket = { provider, id, title };
    const info = document.getElementById('tickets-delete-modal-info');
    if (info) info.innerHTML = 'Delete <strong>' + escapeHtml(title || id) + '</strong>? This cannot be undone.';
    const confirmBtn = document.getElementById('btn-confirm-tickets-delete');
    if (confirmBtn) confirmBtn.disabled = false;
    const modal = document.getElementById('tickets-delete-modal');
    if (modal) modal.style.display = 'block';
});
```

#### 2c. Add confirm/cancel/close/overlay handlers (after the delete handler, ~line 5987)

Following the convert-subtask-modal pattern ([planning.js:6404-6417](src/webview/planning.js#L6404)):
```js
document.getElementById('btn-confirm-tickets-delete')?.addEventListener('click', () => {
    if (!_pendingDeleteTicket) return;
    const { provider, id } = _pendingDeleteTicket;
    const confirmBtn = document.getElementById('btn-confirm-tickets-delete');
    if (confirmBtn) confirmBtn.disabled = true; // double-click guard
    setTicketsLoadingState(true);
    vscode.postMessage({ type: 'deleteTicketConfirmed', provider, id, workspaceRoot: ticketsWorkspaceRoot });
});

document.getElementById('btn-close-tickets-delete-modal')?.addEventListener('click', () => {
    const modal = document.getElementById('tickets-delete-modal');
    if (modal) modal.style.display = 'none';
    _pendingDeleteTicket = null;
});

document.getElementById('btn-cancel-tickets-delete')?.addEventListener('click', () => {
    const modal = document.getElementById('tickets-delete-modal');
    if (modal) modal.style.display = 'none';
    _pendingDeleteTicket = null;
});

document.getElementById('tickets-delete-modal')?.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) {
        e.currentTarget.style.display = 'none';
        _pendingDeleteTicket = null;
    }
});
```

#### 2d. Update the `ticketDeleted` success handler ([line 3589-3608](src/webview/planning.js#L3589))

Replace the stale banner-hide at [line 3593-3594](src/webview/planning.js#L3593):
```js
// BEFORE (dead code — banner doesn't exist):
const banner = document.getElementById('tickets-delete-confirm-banner');
if (banner) banner.style.display = 'none';

// AFTER:
const modal = document.getElementById('tickets-delete-modal');
if (modal) modal.style.display = 'none';
_pendingDeleteTicket = null;
```

In the `else` (failure) branch at [line 3606-3608](src/webview/planning.js#L3606), re-enable the confirm button so the user can retry:
```js
} else {
    showTicketsStatus(msg.error || 'Failed to delete ticket', true);
    const confirmBtn = document.getElementById('btn-confirm-tickets-delete');
    if (confirmBtn) confirmBtn.disabled = false;
}
```

#### 2e. Clean up dead banner references in the `els` cache ([line 503-506](src/webview/planning.js#L503))

Remove the four dead element lookups:
```js
// REMOVE these lines (elements don't exist in planning.html):
deleteConfirmBanner: document.getElementById('tickets-delete-confirm-banner'),
deleteConfirmInput: document.getElementById('delete-confirm-input'),
confirmDeleteTicket: document.getElementById('confirm-delete-ticket'),
cancelDeleteTicket: document.getElementById('cancel-delete-ticket'),
```

## Verification Plan

### Automated Tests

> Per session directives: no compilation or automated test execution. Verification is manual.

1. Build; open Planning → Tickets → select a ticket → click **Delete** → confirm a custom modal appears (NOT a VS Code dialog) showing the ticket identity and a Delete button.
2. Click **Cancel** / outside / × → confirm the modal closes and the ticket is NOT deleted.
3. Click the modal's **Delete** → confirm the ticket is deleted, the list refreshes, and the modal closes on success.
4. Trigger a delete failure (e.g. offline) → confirm an error status shows and the ticket remains; confirm the confirm button re-enables.
5. Double-click the confirm button quickly → confirm only one delete is dispatched.
6. Select a ticket with a title containing HTML characters (e.g. `<script>` or `&`) → confirm the modal info div displays the title as literal text (no HTML injection).
7. Verify the modal renders with correct styling (header, close button, body padding) — confirming `modal-content`/`modal-header`/`modal-body` classes are applied.

---

**Recommendation: Send to Coder** (complexity 3, but the CLAUDE.md policy conflict requires user sign-off first — do NOT implement until the user explicitly overrides the standing "no confirmation dialogs" rule.)

---

## Review Pass — 2026-06-22

### Stage 1: Grumpy Adversarial Findings

| Severity | Finding | Location |
|----------|---------|----------|
| **MAJOR** | Dead `deleteConfirmBanner` references left in 3 functions (5 sites). `getTicketsTabElements()` no longer returns it, so destructuring always yields `undefined` — all `if (deleteConfirmBanner)` blocks are dead no-ops. The plan's step 2e called for replacing the banner-hide with hiding `#tickets-delete-modal`; only the `els` cache removal was done, the render-function replacements were missed. This means the delete modal doesn't close when the ticket detail is cleared/deselected. | `planning.js:7549, 7567, 8054, 8072, 8459` |
| NIT | No Escape key handler for `tickets-delete-modal` in the global Escape handler. Consistent with `convert-subtask-modal`/`tags-modal` which also lack it, but expected UX for a destructive confirmation. | `planning.js:6220-6242` |
| NIT | Confirm button inline `color: var(--accent-red, #f85149)` overrides `.planning-button:hover` `color: #111111`, producing red-on-teal on hover. **Fixed** — see Fixes Applied. | `planning.html:3814` |

### Stage 2: Balanced Synthesis

- **Fix now:** Remove all 5 dead `deleteConfirmBanner` references. Replace the banner-hide logic with hiding `#tickets-delete-modal` and clearing `_pendingDeleteTicket`, as the plan intended. This ensures the modal closes when the ticket detail is cleared. Also fix the confirm button hover color by moving inline styles to a scoped CSS rule with a proper `:hover` state.
- **Defer:** Escape key handler — consistent with existing patterns, not required by the plan.
- **Keep:** Modal HTML, handler wiring, XSS protection (`escapeHtml` at `planning.js:6560`), double-click guard (`6571`/`4061-4062`), success/failure handling (`4045-4047`/`4059-4062`), modal placement after `#tags-modal`, CSS class usage (`modal-content`/`modal-header`/`modal-body`), `--accent-red` fallback, `els`/`getTicketsTabElements` cache cleanup.

### Fixes Applied

**File: `src/webview/planning.js`**

1. `renderTicketsLinearTaskDetail()` (line 7549): Removed `deleteConfirmBanner` from destructuring. Replaced `if (deleteConfirmBanner) deleteConfirmBanner.style.display = 'none';` with hiding `#tickets-delete-modal` and clearing `_pendingDeleteTicket`.
2. `renderTicketsClickUpTaskDetail()` (line 8054): Same fix as above.
3. Clear/reset function (line 8459): Replaced `if (elements.deleteConfirmBanner) elements.deleteConfirmBanner.style.display = 'none';` with hiding `#tickets-delete-modal` and clearing `_pendingDeleteTicket`.

**File: `src/webview/planning.html`**

4. Confirm button (line 3814): Removed inline `color` and `border-color` styles that were overriding the `.planning-button:hover` rule.
5. Added scoped CSS rule for `#btn-confirm-tickets-delete` (lines 2647-2657): sets red text/border at rest; on hover flips to dark text (`#111111`) on red background (`var(--accent-red, #f85149)`) with a red glow shadow — matching the pattern of other `.planning-button` hover states but in red instead of teal.

### Validation Results

- **Grep verification:** Zero remaining references to `deleteConfirmBanner`, `deleteConfirmInput`, `confirmDeleteTicket`, `cancelDeleteTicket`, or `tickets-delete-confirm-banner` in `src/webview/`. Confirmed clean.
- **Compilation:** Skipped per session directives.
- **Tests:** Skipped per session directives.
- **Manual verification items** (from Verification Plan above): Not executed — require runtime webview interaction. All code-level checks pass.

### Remaining Risks

1. **Escape key does not close the delete modal** — consistent with other tickets-tab modals (`convert-subtask-modal`, `tags-modal`), but may surprise users. Low risk.
2. **CLAUDE.md policy conflict** — this feature introduces a two-click confirmation pattern that contradicts the project's "NEVER add confirmation dialogs. NO EXCEPTIONS" rule. This was flagged as blocking in the plan's User Review Required section. Implementation proceeded, presumably with user override. This risk is policy-level, not technical.
