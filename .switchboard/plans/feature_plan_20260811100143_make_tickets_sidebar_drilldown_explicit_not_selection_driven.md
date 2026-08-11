# Make Tickets sidebar drill-down explicit — selecting a parent must not replace the list

## Goal

Selecting a ticket in the Tickets sidebar should only load it into the detail pane. The sidebar
list must stay exactly where it is. Entering the subtask list becomes a deliberate act: clicking
the subtask-count affordance on the card.

### Problem

Clicking any ticket that happens to have subtasks silently replaces the whole sidebar. The grouped
status list — the thing being worked down — is swapped for that ticket's subtask list, and the only
way back is the "← Back to all tickets" header. Selecting a ticket to *read* it is indistinguishable
from asking to navigate into it, and the switch happens asynchronously, after the detail fetch
returns, so the list moves out from under the cursor a beat after the click.

### Root cause

The card-click handler treats *selection* as *navigation intent*. In the delegated
`#tickets-issues-container` listener (`src/webview/tickets.js:5464-5475`):

```js
            const card = e.target.closest('[data-linear-issue-id], [data-clickup-task-id]');
            if (card) {
                const linearId = card.dataset.linearIssueId;
                const clickUpId = card.dataset.clickupTaskId;
                // Drill-down intent: only when clicking from the NORMAL list ...
                if (!_sidebarDrillDownParentId) {
                    _pendingDrillDownParentId = clickUpId || linearId || null;
                    _maybeEnterDrillDown(linearId ? 'linear' : 'clickup', linearId || clickUpId);
                }
```

Every card click arms `_pendingDrillDownParentId`. The click itself usually cannot act on it —
details are not loaded yet, so `_maybeEnterDrillDown` returns early at
`src/webview/tickets.js:3467` (`if (!detail || !detail.detailsFetched) return;`). The flag stays
armed, and the drill-down is fired later by the detail-loaded arms
(`src/webview/tickets.js:7476` for Linear, `:7502` for ClickUp), which is why the list changes on a
delay. `_maybeEnterDrillDown` then enters unconditionally whenever the fetched ticket has children
(`:3470`, `if (subs && subs.length > 0)`).

The mechanism itself is sound — `_pendingDrillDownParentId` is exactly the right "the user asked
for this" signal. The defect is that **one** of its four arming sites arms it without the user
asking. The other three are genuine intent and must be preserved:

| Site | Intent | Keep? |
| :--- | :--- | :--- |
| `src/webview/tickets.js:5472` — any card click | Implicit. **This is the bug.** | Remove |
| `:5330` / `:5344` — clicking an item in the detail pane's inline subtask nav | User opened a subtask; the sidebar should show its siblings | Keep |
| `:7947` — after `clickupTaskCreated` with a `_subtaskParent` | User just created a subtask under this parent | Keep |
| `:7977` — after `linearIssueCreated` with a `_subtaskParent` | Same | Keep |

## Metadata

- **Complexity:** 4
- **Tags:** bugfix, ux, ui, frontend

## Complexity Audit (Routine vs Complex/Risky)

**Routine**
- Deleting a three-line block from the card-click handler.
- Adding one delegated branch for the new trigger element.

**Complex / Risky**
- **`_maybeEnterDrillDown` must keep its guard.** It is still called from the detail-loaded arms at
  `:7476` and `:7502`, which fire on *every* detail load — including plain selections. Its
  `if (!id || _pendingDrillDownParentId !== id) return;` guard (`:3465`) is what stops those from
  drilling. Do not "simplify" it away while removing the caller; it becomes load-bearing.
- **The trigger must not double-fire.** The container listener ends in the catch-all card branch.
  A trigger nested inside the card will reach that branch too, which is desirable (it performs the
  selection and the detail fetch that drill-down waits on) but means the branch must be able to
  distinguish "clicked the count" from "clicked the card".
- **Stale entry after exit.** `_resetSidebarDrillDown` (`:380`) clears `_pendingDrillDownParentId`.
  Verify that clicking the count, then clicking "← Back" before the detail fetch returns, does not
  re-enter drill-down when the response lands. The reset clears the pending id, so the guard at
  `:3465` rejects it — confirm this by test rather than by reading.
- **Discoverability.** Once the implicit path is gone, a user with no visible affordance has no way
  into the subtask list. The trigger is therefore part of this plan's deliverable, not a follow-up.

## Edge-Case & Dependency Audit

| Case | Required behaviour |
| :--- | :--- |
| Click a parent card body | Detail pane loads the parent. Sidebar list unchanged — same scroll position, same status groups, same collapsed/expanded state. |
| Click a childless card | Unchanged from today (never drilled anyway). |
| Click the subtask-count trigger | Sidebar enters drill-down for that ticket; the parent is also selected in the detail pane. |
| Click the trigger when details are not yet cached | Arm `_pendingDrillDownParentId`, fire the detail fetch, let the detail-loaded arm complete the entry — the existing async path. No spinner or placeholder needed. |
| Click the trigger, then "← Back" before the fetch returns | Must **not** re-enter when the response lands. `_resetSidebarDrillDown` clears the pending id and the `:3465` guard rejects the stale call. |
| Click the trigger twice rapidly | Idempotent — second click re-arms the same id; entry is a state assignment, not a toggle. |
| Click a card *inside* drill-down (a subtask card) | Selects that subtask; stays in drill-down. Today's `if (!_sidebarDrillDownParentId)` wrapper produced this; after the change it falls out for free, because nothing arms the flag on a card click at all. |
| Click the parent card in the drill-down header | Re-selects the parent, stays in drill-down. Same reasoning. |
| Trigger click while already drilled into that same ticket | No-op re-entry. Harmless. |
| Create a subtask via the control-strip **+ Subtask** | Still drills into the parent afterwards (`:7947` / `:7977` untouched) — that is intended feedback that the subtask landed. |
| Click an item in the detail pane's inline subtask nav | Still drills to show siblings (`:5330` / `:5344` untouched). |
| Status filter / search / provider switch / list change | All already call `_resetSidebarDrillDown` (`:916`, `:3644`, `:3685`, `:3896`, `:3959`, `:4319`, `:4876`, `:4899`, `:4908`). Unchanged. |

**Dependency — the trigger element.** The trigger is a per-card element carrying
`data-subtask-count-ticket-id` and `data-subtask-count-provider`, rendered inside
`_renderClickUpTicketCard` (`src/webview/tickets.js:624`) and `_renderLinearTicketCard` (`:661`).
If the card renderers already emit such an element, bind to it as-is and add nothing.
**If they do not, this plan adds the minimal version described in step 3** so the feature is
independently shippable.

**No migration required:** interaction-only. No persisted state, settings key, message schema or
file format changes.

## Proposed Changes

### 1. `src/webview/tickets.js` — stop arming drill-down on card selection

In the delegated `#tickets-issues-container` listener, replace the block at
`src/webview/tickets.js:5464-5475`:

```js
            const card = e.target.closest('[data-linear-issue-id], [data-clickup-task-id]');
            if (card) {
                const linearId = card.dataset.linearIssueId;
                const clickUpId = card.dataset.clickupTaskId;
                // Selecting a ticket loads it into the detail pane and NOTHING else.
                // Drill-down is entered only by an explicit act — the subtask-count
                // trigger handled above, the inline subtask nav, or creating a subtask.
                // Arming it here made every click on a parent silently replace the list
                // the user was working down, a beat after the click, once details landed.
```

…then leave the existing `if (linearId) { ... } else if (clickUpId) { ... }` cache-or-fetch bodies
exactly as they are.

**Do not touch `_maybeEnterDrillDown`.** Its `_pendingDrillDownParentId !== id` guard (`:3465`) is
now the sole thing preventing the detail-loaded arms at `:7476` / `:7502` from drilling on ordinary
selections.

### 2. `src/webview/tickets.js` — arm drill-down from the count trigger

Add a branch in the same container listener, placed **before** the card branch and deliberately
falling through to it (no `return`) so the click still selects the ticket and fires the detail
fetch that the pending entry waits on:

```js
            // Explicit drill-down request: the subtask-count affordance on a card.
            // Arms the intent, then falls through to the card branch below so the
            // ticket is selected and its details are fetched. If details are already
            // cached, _maybeEnterDrillDown enters synchronously there; otherwise the
            // detail-loaded arm completes the entry when the response lands.
            const subtaskCountTrigger = e.target.closest('[data-subtask-count-ticket-id]');
            if (subtaskCountTrigger) {
                const triggerId = subtaskCountTrigger.dataset.subtaskCountTicketId;
                const triggerProvider = subtaskCountTrigger.dataset.subtaskCountProvider;
                if (triggerId) {
                    _resetSidebarDrillDown();
                    _pendingDrillDownParentId = triggerId;
                    _maybeEnterDrillDown(triggerProvider, triggerId);
                }
                // no return — fall through to selection + fetch
            }
```

### 3. `src/webview/tickets.js` — the trigger element (only if the card renderers lack one)

If `_renderClickUpTicketCard` / `_renderLinearTicketCard` do not already render a subtask-count
element, add one. It needs a count to display; derive it from the ticket's detail cache, which is
populated for any ticket the user has selected:

```js
    // Explicit drill-down affordance. Rendered only when the count is known and
    // non-zero — an always-present "0 subtasks" chip is noise, and a chip that does
    // nothing when clicked is worse than no chip.
    //
    // ASCII text plus an existing sb-icon mask class only: this panel's font stack
    // carries no symbol glyphs, so a decorative arrow renders as tofu.
    function _ticketSubtaskCountTrigger(provider, id) {
        const cached = provider === 'linear' ? linearIssueDetailCache.get(id) : clickUpTaskDetailCache.get(id);
        const n = (cached && cached.detailsFetched && Array.isArray(cached.subtasks)) ? cached.subtasks.length : 0;
        if (!n) { return ''; }
        return `<span class="ticket-subtask-count" role="button" tabindex="0" data-subtask-count-ticket-id="${escapeAttr(id)}" data-subtask-count-provider="${escapeAttr(provider)}" title="Show ${n} subtask${n === 1 ? '' : 's'}"><span class="sb-icon sb-icon-sm sb-icon-chevron-right" aria-hidden="true"></span>${n}</span>`;
    }
```

Render it on the status/meta row of each card — ClickUp (`:641`):

```js
            <div class="tickets-issue-meta ticket-status-row" data-edit-status data-provider="clickup" data-ticket-id="${escapeAttr(task.id)}">${escapeHtml(task.status || 'Unknown')}${syncBadge}${_ticketSubtaskCountTrigger('clickup', task.id)}</div>
```

…and the equivalent on the Linear card (`:675`).

> That row carries `data-edit-status` and opens the status-edit modal on click
> (`src/webview/tickets.js:5371`). The status-edit branch runs earlier in the same listener, so the
> new branch must be placed **above** it, or the trigger must live on its own row. Decide by
> reading the handler order at implementation time and verify against the running panel.

### 4. `src/webview/tickets.html` — trigger CSS

Add beside the `ticket-sync-badge` rules:

```css
        .ticket-subtask-count {
            display: inline-flex;
            align-items: center;
            gap: 2px;
            margin-left: 6px;
            padding: 0 5px;
            height: 15px;
            border-radius: 7px;
            border: 1px solid var(--border-color);
            background: var(--panel-bg2, #1a1a2e);
            color: var(--text-secondary);
            font-size: 9px;
            font-weight: 600;
            line-height: 1;
            cursor: pointer;
        }

        .ticket-subtask-count:hover,
        .ticket-subtask-count:focus-visible {
            border-color: var(--accent-teal);
            color: var(--accent-teal);
        }
```

### 5. Comment maintenance

Update the now-inaccurate comment on `_renderDrillDownHeader` (`src/webview/tickets.js:733-736`),
which states that clicking the parent card "re-selects the parent WITHOUT leaving drill-down (the
card-click handler skips drill-down entry once `_sidebarDrillDownParentId` is set)". After this
change no card click ever enters drill-down, so the reason is different — say that instead.

## Verification Plan

**Automated**
1. `npm test` — full suite green. Stash-verify against HEAD first to separate pre-existing failures
   from new ones.
2. New test: simulate a card click on a ticket whose detail cache is populated and has 3 subtasks →
   assert `_sidebarDrillDownParentId` stays `null` and the rendered sidebar still contains the
   top-level status-group headers.
3. New test: simulate a click on `[data-subtask-count-ticket-id]` for the same ticket → assert
   drill-down activates and the sidebar renders the subtask cards plus the "← Back to all tickets"
   header.
4. New test (stale-entry guard): click the trigger with details **not** cached, then invoke
   `_resetSidebarDrillDown()`, then deliver the `clickupTaskDetailsLoaded` message → assert
   drill-down does **not** activate.
5. New test (preserved paths): the `clickupTaskCreated` arm with `_subtaskParent` set still drills
   into the parent; a `.subtask-nav-item` click still drills to siblings.

**Manual (installed VSIX — `dist/` is not used for testing)**
6. Tickets tab, ClickUp provider, a list containing parents with subtasks. Scroll partway down and
   collapse one status group. Click a parent card:
   - the detail pane loads the parent,
   - the sidebar list is unchanged — same scroll position, same collapsed group,
   - wait 3 seconds after the detail loads and confirm it *still* has not changed (the old bug was
     delayed, so an immediate check alone would not catch a regression).
7. Click the count chip on that card → the sidebar shows the subtask list with the parent card in
   the header. "← Back to all tickets" returns to the full list.
8. Click the count chip, then click "← Back" immediately, before the detail fetch returns. The
   sidebar must stay on the full list and must not flip into drill-down a moment later.
9. Inside drill-down, click a subtask card → it is selected; the sidebar stays on the sibling list.
10. Control-strip **+ Subtask** on a parent → after creation, the sidebar drills into that parent.
11. Detail pane inline subtask nav → clicking an item drills to the sibling list.
12. Repeat 6–11 with the Linear provider.
13. Tab to the count chip and press Enter/Space — if `role="button" tabindex="0"` is kept, keyboard
    activation must work; otherwise drop the role and tabindex rather than shipping a focusable
    element that does nothing.
