# Add +Subtask Button to Sidebar Ticket Actions Dropdown

## Metadata
**Complexity:** 3
**Tags:** frontend, ui, ux, feature
**Project:** Browser Switchboard

## Goal
Add a `+ Subtask` option to the "⋯ More" actions dropdown menu on each sidebar ticket card in `tickets.html` / `tickets.js`. Clicking this option should trigger the exact same subtask creation flow as the `+ Subtask` button in the preview controls strip (setting the clicked ticket as the parent and opening the `#create-ticket-modal`).

**Problem / background.** Today subtask creation is only reachable from the preview-pane control strip (`#btn-add-subtask`), which requires first *selecting* a ticket to populate `selectedClickUpIssue` / `selectedLinearIssue`. The sidebar card already exposes per-card actions (`To kanban`, `Link`, `Open`, `Move`) via its `⋯ More` overflow popover, so adding `+ Subtask` there lets a user spawn a subtask under any visible card in one click without first selecting it. The card templates (`_renderClickUpTicketCard` / `_renderLinearTicketCard`) and the create-modal plumbing (`_subtaskParent`, `_resetCreateModalMetadata`, `_populateCreateModalStatus`, `_populateCreateModalPriority`, `_loadCreateModalMembers`) already exist; this plan reuses them verbatim and only adds a menu item + a thin opener helper + a click route.

## User Review Required
- **Confirm the wiring approach.** The plan supersedes the original "add a case to the `#tickets-issues-container` delegated listener" approach with a **document-level** delegated listener, because the shared overflow-menu code re-parents the open popover to `document.body` (see *Edge-Case & Dependency Audit*). If you have empirical evidence that the existing `Move` menu item *does* fire from the card popover today, the simpler container-listener approach is viable instead — tell the coder so they can drop the document-level listener. Default to the document-level approach (robust either way).

## Complexity Audit

### Routine
- Adding one `<button>` to each of the two card template strings (`_renderClickUpTicketCard`, `_renderLinearTicketCard`) — pure string-template edit, mirrors the existing `Move` item one line above.
- Extracting the existing `#btn-add-subtask` inline body into a named `openCreateSubtaskModal(provider, ticketId, ticketTitle)` helper — mechanical move, no behaviour change; the preview-strip button then calls the helper.
- Resolving the clicked card's title from the in-memory lists (`clickUpProjectIssues` / `linearProjectIssues` / `_drillDownSubtasks` / detail caches) — the lookup pattern already exists in `_selectTicketFromCard`.

### Complex / Risky
- **Popover re-parenting breaks container-scoped delegation.** `initOverflowMenus` (`src/webview/sharedUtils.js:555-556`) moves the open `[data-overflow-popover]` to `document.body` so it escapes `overflow:auto` ancestors. Once detached, a click on a menu item inside it bubbles `item → popover → body → document`, never through `#tickets-issues-container`. The existing `Move` handler lives in the container listener (`tickets.js:5130`) and therefore does not fire for the re-parented popover — `Move` is currently a dead click from the card menu (unreleased; introduced in the same commit `7c9a6880` as the re-parenting). The new `+ Subtask` item must NOT repeat this: wire it via a **document-level** delegated listener, not the container listener.

## Edge-Case & Dependency Audit

- **Race Conditions:** None. The opener is synchronous DOM + module-state mutation (`_subtaskParent = …`; `modal.style.display = 'block'`). The async member-load (`_loadCreateModalMembers` → `loadTicketMembers` postMessage) is unchanged from the preview-strip path.
- **Security:** No new `postMessage` types; the create-task payload is unchanged (still `clickupCreateTask` / `linearCreateIssue` with `parentId`). All user-supplied title/description flow through the existing escape helpers. The card `id` and `provider` come from `data-*` attributes rendered with `escapeAttr`.
- **Side Effects:**
  - The helper sets `_subtaskParent`, which the submit handler (`tickets.js:5354`) reads to inject `parentId`. The close/cancel handlers (`tickets.js:5229`, `5237`, `5245`) already clear `_subtaskParent` and reset the modal title, so a subtask-open that the user dismisses leaves no stale parent. No change needed.
  - `_closeAllOverflowPopovers(null)` must be called in the new handler so the `⋯ More` menu dismisses when `+ Subtask` is clicked (the shared outside-click closer does *not* fire for clicks inside the detached popover — see *Complex / Risky*).
- **Dependencies & Conflicts:**
  - **Provider/list context.** `_populateCreateModalStatus` / `_populateCreateModalPriority` / `_loadCreateModalMembers` and the submit handler all key off `lastIntegrationProvider` and the currently-selected list/project (`clickUpSelectedListId` / `linearProjectPickerValue`). The sidebar only renders one provider's tickets at a time, so a card's `data-provider` always equals `lastIntegrationProvider`, and the card belongs to the selected list/project — thus the modal's status/priority/assignee options and the `parentId` are consistent. *Clarification (not new scope):* if a future change lets the sidebar mix providers or show tickets outside the selected list, the submit handler would need to switch on `_subtaskParent.provider` instead of `lastIntegrationProvider`; out of scope here.
  - **Drill-down subtask cards.** In drill-down view the sidebar lists a parent's subtasks. A `+ Subtask` click on a subtask card would set that subtask as the parent (nested subtask). ClickUp/Linear nesting support is provider-defined; this matches the existing preview-strip `#btn-add-subtask` behaviour (which also operates on whatever is selected, including a drilled-in subtask), so parity is preserved. No special-casing added.
  - **Latent `Move` dead-click.** Same root cause as the wiring risk above. Fixing `Move` is *not* required for this plan's goal, but the document-level listener added here is the natural place to also route `[data-move-ticket-id]` → `showMoveTicketModal` if you want `Move` unblocked in the same change. Flagged for the user; default scope is `+ Subtask` only.
  - **No `dist/` or compilation involvement.** Per workspace rules, testing is via installed VSIX; `src/` is the source of truth. No `npm run compile` step is part of verification.

## Dependencies
- None. Single-file change to `src/webview/tickets.js` (card templates + opener helper + click route). No other plan or feature blocks this.

## Adversarial Synthesis
Key risks: (1) the original container-listener wiring is defeated by popover re-parenting and would ship a dead `+ Subtask` click — superseded with a document-level listener; (2) the same bug already makes `Move` a dead click and could lure a coder into copying the broken pattern; (3) provider/list context is only consistent because the sidebar is single-provider/single-list today — a fragility worth a code comment, not a fix. Mitigations: document-level delegation (robust to re-parenting), explicit `_closeAllOverflowPopovers(null)`, and reusing the verbatim modal-open sequence so the new path is behaviour-identical to the shipped preview-strip path.

## Proposed Changes

### 1. Add `+ Subtask` menu item to both card templates in `src/webview/tickets.js`
- In `_renderClickUpTicketCard(task)` (around `tickets.js:624`), add a second `overflow-menu-item` button inside the existing `.overflow-menu-popover`, immediately after the `Move` button:
  ```html
  <button type="button" class="card-icon-btn overflow-menu-item" data-add-subtask-ticket-id="${escapeAttr(task.id)}" data-provider="clickup" title="Create a subtask under this ticket">+ Subtask</button>
  ```
- In `_renderLinearTicketCard(issue)` (around `tickets.js:658`), add the analogous Linear item:
  ```html
  <button type="button" class="card-icon-btn overflow-menu-item" data-add-subtask-ticket-id="${escapeAttr(issue.id)}" data-provider="linear" title="Create a subtask under this ticket">+ Subtask</button>
  ```
- Context: both buttons live inside the same `[data-overflow-popover]` as `Move`, so they inherit the shared open/close positioning. No CSS change needed (`overflow-menu-item` is already styled).

### 2. Refactor the subtask-creation modal open into a reusable helper in `src/webview/tickets.js`
- Introduce `openCreateSubtaskModal(provider, ticketId, ticketTitle)` (place it adjacent to the existing `#btn-add-subtask` listener near `tickets.js:5359`). It is the exact body of the current inline listener, parameterised:
  ```js
  function openCreateSubtaskModal(provider, ticketId, ticketTitle) {
      if (!ticketId) return;
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
- Replace the body of the existing `#btn-add-subtask` click listener (`tickets.js:5359-5382`) with a call to `openCreateSubtaskModal(provider, ticketId, ticketTitle)`, keeping its existing `provider = lastIntegrationProvider` / `selectedLinearIssue` / `selectedClickUpIssue` resolution to derive the three args. This preserves the preview-strip path byte-for-behaviour.

### 3. Wire the new menu item via a DOCUMENT-level delegated listener in `src/webview/tickets.js`

> **Superseded:** Add a case for `e.target.closest('[data-add-subtask-ticket-id]')` inside the existing `#tickets-issues-container` delegated click listener (the original plan, mirroring `Move`).
> **Reason:** `initOverflowMenus` (`src/webview/sharedUtils.js:555-556`) re-parents the open `[data-overflow-popover]` to `document.body` so it can escape `overflow:auto` ancestors. Once detached, a click on a menu item inside it bubbles `item → popover → body → document` and never reaches `#tickets-issues-container`, so a container-scoped delegated listener cannot catch it. The existing `Move` handler (`tickets.js:5130`) suffers this exact dead-click today (unreleased, introduced in `7c9a6880`). Copying that pattern would ship a non-functional `+ Subtask` button.
> **Replaced with:** A `document`-level delegated click listener for `[data-add-subtask-ticket-id]`, registered once during init (alongside the other `document.getElementById(...)?.addEventListener` block, e.g. near `tickets.js:5359`). Document-level delegation catches the click regardless of the popover's current parent.

- Implementation:
  ```js
  document.addEventListener('click', (e) => {
      const subtaskBtn = e.target.closest('[data-add-subtask-ticket-id]');
      if (!subtaskBtn) return;
      e.stopPropagation();
      _closeAllOverflowPopovers(null); // dismiss the ⋯ More menu (shared outside-click won't fire inside the detached popover)
      const provider = subtaskBtn.dataset.provider;
      const ticketId = subtaskBtn.dataset.addSubtaskTicketId;
      // Resolve the title from the in-memory lists / drill-down subtasks / detail cache
      // (mirrors the lookup in _selectTicketFromCard, tickets.js:3031).
      let ticketTitle = '';
      if (provider === 'linear') {
          const issue = linearProjectIssues.find(i => i.id === ticketId)
              || (_drillDownSubtasks && _drillDownSubtasks.find(s => s.id === ticketId))
              || (linearIssueDetailCache.get(ticketId) && linearIssueDetailCache.get(ticketId).issue);
          ticketTitle = (issue && (issue.title || issue.identifier)) || '';
      } else {
          const task = clickUpProjectIssues.find(t => t.id === ticketId)
              || (_drillDownSubtasks && _drillDownSubtasks.find(s => s.id === ticketId))
              || (clickUpTaskDetailCache.get(ticketId) && clickUpTaskDetailCache.get(ticketId).task);
          ticketTitle = (task && (task.title || task.name)) || '';
      }
      openCreateSubtaskModal(provider, ticketId, ticketTitle);
  });
  ```
- Edge cases handled: missing title falls back to `''` (the modal still opens with `parentId` set; the title bar reads `Create Subtask under `); `_closeAllOverflowPopovers(null)` ensures the menu closes; `e.stopPropagation()` prevents any later document listeners from also acting on the click.
- **Optional, user-approved only:** in the same listener, also catch `[data-move-ticket-id]` → `showMoveTicketModal(provider, id)` to unblock the dead `Move` button. Default scope excludes this.

## Verification Plan

### Automated Tests
- None required (skip per session directive). No unit-test harness covers the webview DOM delegation; correctness is verified manually below.

### Manual Verification
1. Build/install the VSIX and open the Tickets tab (`tickets.html`).
2. Load tickets from a provider (ClickUp or Linear).
3. Hover/focus a sidebar ticket card and click its "⋯ More" overflow trigger; verify the popover opens with both `Move` and `+ Subtask`.
4. Click `+ Subtask`:
   - Verify the `⋯ More` popover closes.
   - Verify `#create-ticket-modal` opens with title `Create Subtask under <Ticket Title>`.
   - Verify the title input is focused and empty.
5. Fill in the subtask title and click **Create**.
6. Confirm the created task payload includes the correct `parentId` (the clicked card's id) and that the new subtask appears under the parent in the provider.
7. Repeat 3–6 from a **drill-down** subtask card (open a parent, then click `+ Subtask` on one of its subtask rows) — confirm the modal opens with that subtask as the parent.
8. Dismiss the modal via **Cancel** / **X** / backdrop click; confirm a subsequent `Create New Ticket` (top-level `tickets-create`) still opens with title `Create New Ticket` and no `parentId` (i.e. `_subtaskParent` was cleared).
9. **Regression spot-check:** click `Move` from the same `⋯ More` menu. If `Move` is in scope, confirm the move modal opens; if out of scope, note its current (pre-fix) behaviour for the user.

## Recommendation
Complexity 3 → **Send to Intern** (single-file, reuses existing patterns; the one non-trivial bit — document-level delegation instead of container delegation — is fully specified above).

## Completion Report
Implemented the +Subtask sidebar overflow action in `src/webview/tickets.js`. Added the menu item to both ClickUp and Linear card templates, extracted the existing preview-strip subtask open logic into a reusable `openCreateSubtaskModal` helper, and wired the new item via a document-level delegated click listener so it works despite the popover being re-parented to `<body>`. No compilation or automated tests were run per session directives. The only file changed was `src/webview/tickets.js`.

## Review Findings
Reviewed the +Subtask implementation against the plan. The feature is correct and plan-compliant: card templates, helper extraction, and document-level delegation all match the spec. No CRITICAL or MAJOR code issues found. The diff also contains concurrent changes from other plans (Move dead-click fix per audit plan defect #2, `_subtasksEnrichedFor` removal per subtask-block-leaks plan defect #4, and an ad-hoc `ticketsSourceHierarchyMissing` source-picker catch-up) — these are valid fixes from other plans, not scope creep from this one. Tests run independently: `tickets-subtask-embedding.test.js` PASSED, `verb-engine-tickets-headless.test.js` PASSED (31/31), ESLint clean. `tickets-delta-sweep-gate-regression.test.js` FAILED but from another plan's `TicketsPanelProvider.ts` changes, not this plan. Remaining risk: the `e.stopPropagation()` call in the subtask document listener is a harmless no-op (same-element listeners aren't gated by `stopPropagation`), but causes no regression.
