# Replace the sidebar ticket card's overflow menu with a direct Move button

## Goal

Remove the per-card "⋯" overflow menu from Tickets sidebar cards and put **Move** on the card as a
plain, one-click button alongside *To kanban*, *Link* and *Open*.

### Problem

Every sidebar ticket card carries a "⋯" overflow menu holding exactly two items:

```js
// src/webview/tickets.js:647-653  (ClickUp card; the Linear card at :682-688 is identical)
<div class="overflow-menu" data-overflow-menu>
    <button ... class="overflow-menu-trigger" data-overflow-trigger ...>⋯</button>
    <div class="overflow-menu-popover" data-overflow-popover>
        <button ... data-move-ticket-id="..." data-provider="clickup" title="Move to another list">Move</button>
        <button ... data-add-subtask-ticket-id="..." data-provider="clickup" title="Create a subtask under this ticket">+ Subtask</button>
    </div>
</div>
```

One of those two items is redundant. **+ Subtask already exists in the tickets control strip's own
overflow menu** — `#btn-add-subtask` at `src/webview/tickets.html:4035`, wired at
`src/webview/tickets.js:5677`, which opens the same `openCreateSubtaskModal` against the currently
selected ticket. The card copy adds no capability; it only adds a second route to the same modal.

### Root cause

The overflow menu is not carrying its weight. Strip the duplicate and a single item is left, so the
menu is pure overhead: two clicks and a popover reparent to reach one action. Worse, because
`initOverflowMenus` moves an open popover to `<body>` (`src/webview/sharedUtils.js:555-557`) to
escape the sidebar's `overflow:auto`, the Move item cannot be caught by the container-scoped card
click handler at all — it needs a dedicated document-level listener with an explanatory comment
(`src/webview/tickets.js:4696-4711`) and a matching "NOT handled here" comment in the container
handler (`src/webview/tickets.js:5445-5448`). All of that machinery exists solely to route one
button.

Promoting Move to a direct card button deletes the duplicate, the popover, the reparenting hop and
one click.

## Metadata

- **Complexity:** 3
- **Tags:** ui, ux, frontend, refactor

## Complexity Audit (Routine vs Complex/Risky)

**Routine**
- Editing two card-renderer template strings.
- Deleting a now-unreferenced document-level click listener.

**Complex / Risky**
- **Event-ordering change.** Today Move lives in a popover reparented to `<body>`, so the only
  listener that sees its click is the document-level one. As a plain in-card button it sits inside
  `#tickets-issues-container`, whose delegated listener (`src/webview/tickets.js:5361`ff) bubbles
  **first** and ends with a catch-all card branch (`:5464`) that selects the ticket and enters
  subtask drill-down. Without an explicit early return, clicking Move would select and drill the
  card *and* open the Move modal. The document listener's `e.stopPropagation()` cannot prevent
  this — document is the last hop in the bubble chain, so the container handler has already run.
- **Two cards can render the same ticket at once.** In drill-down mode the parent's card is
  re-rendered inside the header (`_renderDrillDownHeader`, `src/webview/tickets.js:737-751`) by
  calling the same renderer. Both copies get the new Move button; both must work.
- **`data-empty` bookkeeping.** `_recomputeAllOverflowTriggers` (`src/webview/sharedUtils.js:535`)
  walks every `[data-overflow-menu]` in the document and is called from three places in tickets.js
  (`:1543`, `:3290`, `:3395`). It uses `querySelectorAll`, so removing card menus simply gives it
  fewer nodes — no crash — but this must be confirmed, not assumed.

## Edge-Case & Dependency Audit

| Case | Required behaviour |
| :--- | :--- |
| Click Move on a card | Move modal opens. The card is **not** selected, and the sidebar view does not change. |
| Move on the parent card inside the drill-down header | Works identically; drill-down state is untouched. |
| Move on a subtask card inside drill-down | Works — the existing `showMoveTicketModal(provider, id)` call is id-based and provider-agnostic about drill-down. |
| Keyboard/focus | `.ticket-node:focus-within .card-actions { opacity: 1 }` (`src/webview/tickets.html:2973`) already un-dims the row on focus, so a tab-focused Move button is visible. No change needed. |
| Card action row width | The row is `flex-wrap: wrap` (`src/webview/tickets.html:2962`), so replacing a ~22px trigger with a ~44px "Move" button wraps rather than overflows in a narrow sidebar. Confirm visually — do not assume. |
| Linear card vs ClickUp card | Both renderers change. Titles stay provider-correct: "Move to another project" (Linear) / "Move to another list" (ClickUp). |
| Control-strip overflow menu | Unchanged. It keeps its own `data-overflow-menu` and all its items, including `+ Subtask`. |
| Meta-bar overflow menu | Unchanged. |
| A ticket with no local file / local-only ticket | Unchanged — Move's enablement is not conditioned on file state today and this plan does not add a condition. |

**Dependencies**
- `showMoveTicketModal(provider, ticketId)` — `src/webview/tickets.js:4096`. Unchanged.
- `initOverflowMenus` / `_recomputeAllOverflowTriggers` / `_closeOneOverflowPopover` are
  `sharedUtils.js` globals shared with planning.js, project.js and other panels. **Do not modify
  sharedUtils.js** — this plan only stops *using* the component on ticket cards.
- After this change, `data-add-subtask-ticket-id` has zero emitters (verified: the only two are the
  card renderers at `src/webview/tickets.js:651` and `:686`), so its document-level listener at
  `src/webview/tickets.js:5687-5712` becomes dead code.

**Not a migration concern:** this is presentation-only. No persisted state, settings key or file
format changes, so no migration is needed for existing installs.

## Proposed Changes

### 1. `src/webview/tickets.js` — ClickUp card renderer (`_renderClickUpTicketCard`, ~line 643)

Replace the `card-actions` block's overflow menu with a direct button:

```js
            <div class="card-actions">
                <button type="button" class="card-icon-btn" data-import-plan-id="${escapeAttr(task.id)}" data-provider="clickup" title="Add to kanban">To kanban</button>
                <button type="button" class="card-icon-btn" data-link-ticket-id="${escapeAttr(task.id)}" data-provider="clickup" title="Link to ticket">Link</button>
                ${openBtn}
                <button type="button" class="card-icon-btn" data-move-ticket-id="${escapeAttr(task.id)}" data-provider="clickup" title="Move to another list">Move</button>
            </div>
```

### 2. `src/webview/tickets.js` — Linear card renderer (`_renderLinearTicketCard`, ~line 678)

```js
            <div class="card-actions">
                <button type="button" class="card-icon-btn" data-import-plan-id="${escapeAttr(issue.id)}" data-provider="linear" title="Add to kanban">To kanban</button>
                <button type="button" class="card-icon-btn" data-link-ticket-id="${escapeAttr(issue.id)}" data-provider="linear" title="Link to ticket">Link</button>
                ${openBtn}
                <button type="button" class="card-icon-btn" data-move-ticket-id="${escapeAttr(issue.id)}" data-provider="linear" title="Move to another project">Move</button>
            </div>
```

### 3. `src/webview/tickets.js` — stop the container handler from selecting the card on a Move click

In the `#tickets-issues-container` delegated listener, replace the stale "Move is NOT handled here"
comment block (`src/webview/tickets.js:5445-5448`) with a real early return, placed **before** the
`const card = e.target.closest(...)` fallback at `:5464`:

```js
            // Move is now a direct card button, so it bubbles through this container
            // handler on its way to the document-level listener that owns it. Return
            // here or the catch-all card branch below would also select the ticket and
            // enter drill-down on every Move click. (Container bubbles before document,
            // so the document listener's stopPropagation cannot prevent that.)
            if (e.target.closest('[data-move-ticket-id]')) {
                return;
            }
```

Keep the document-level Move listener at `src/webview/tickets.js:4702-4711` as-is: its
`closest('[data-overflow-popover]')` lookup now returns `null` and the guarded
`if (popover && ...)` branch simply no longer runs. Update its leading comment so it no longer
claims Move lives in a popover.

### 4. `src/webview/tickets.js` — delete the dead `+ Subtask` card listener

Remove the whole block at `src/webview/tickets.js:5687-5712` (the
`document.addEventListener('click', ...)` keyed on `[data-add-subtask-ticket-id]`). Nothing emits
that attribute after step 1 and 2.

`#btn-add-subtask` in the control-strip overflow (`src/webview/tickets.html:4035`, listener at
`src/webview/tickets.js:5677`) is the remaining and intended route — leave both untouched.

### 5. `src/webview/tickets.js` — optional cleanup

The `[data-overflow-trigger]` early return inside the container handler
(`src/webview/tickets.js:5461-5463`) exists only for card triggers and becomes unreachable. It is
harmless to keep; if removing it, first confirm no other overflow menu is ever rendered inside
`#tickets-issues-container`.

**No CSS change is required.** `.ticket-node .card-actions .card-icon-btn`
(`src/webview/tickets.html:2977`) already styles every direct card button, and the removed
`.overflow-menu` rules at `src/webview/tickets.html:3388`ff are shared with the control-strip and
meta-bar menus — **do not delete them.**

## Verification Plan

**Automated**
1. `npm test` — full suite green (stash-verify against HEAD first to separate pre-existing failures
   from new ones).
2. `grep -rn "data-add-subtask-ticket-id" src/` returns no hits outside tests.
3. `grep -n "overflow-menu" src/webview/tickets.js` returns no hits inside `_renderClickUpTicketCard`
   or `_renderLinearTicketCard`.

**Manual (installed VSIX — `dist/` is not used for testing)**
4. Tickets tab, ClickUp provider, a scoped list. Each sidebar card shows four buttons:
   **To kanban · Link · Open · Move**, and no "⋯" trigger.
5. Click **Move** on an unselected card:
   - The Move modal opens.
   - The card does **not** become selected, the detail pane does not change, and the sidebar does
     not switch into a subtask list.
   - Picking a target list and applying moves the ticket as before.
6. Click the card body (not a button) — normal selection still works.
7. Click **To kanban**, **Link** and **Open** — each behaves exactly as before.
8. Drill into a parent's subtasks. The parent card in the drill-down header shows the Move button
   and it works; a subtask card's Move button also works.
9. Repeat 4–8 with the Linear provider; confirm the Move tooltip reads "Move to another project".
10. Open the control-strip "⋯" menu — **+ Subtask** is present and still creates a subtask under the
    selected ticket. Open the meta-bar overflow menu — unchanged.
11. Narrow the sidebar to its minimum width. The four buttons wrap onto a second line; nothing is
    clipped or horizontally scrolled.
