---
description: 'Tickets Tab Sidebar Card Layout & Actions'
---

# Tickets Tab Sidebar Card Layout & Actions

## Goal

Make the planning.html Tickets tab sidebar cards self-contained and visually clean by relocating the sync-status badge inline with the status label and adding a per-card Open button so users can open any ticket external URL directly from the sidebar without first selecting it. These two plans both restructure the same Linear and ClickUp card templates — one moves a badge out of the card-actions row, the other adds an Open button into it — and together they complete the sidebar card information architecture.

### Problem Analysis & Root Cause

The sidebar ticket cards (Linear + ClickUp) share an identical structural problem: the `card-actions` row is overloaded. It currently holds the sync-status badge (`synced`/`modified`/`local`, pinned bottom-left via `margin-right: auto`) PLUS three action buttons. The badge is informational (`pointer-events: none`) yet occupies action-row real estate, while the "Open externally" action is missing from cards entirely — it lives only in the ticket detail top bar (`#btn-open-ticket`, planning.html line 3626), forcing a select-then-open round trip.

Two independent root causes drive the two subtasks:
1. **Badge placement** — `_ticketSyncBadge()` (planning.js ~line 8272) emits the badge and both card templates inject it into `card-actions` (Linear line 8341, ClickUp line 8869). The CSS pin rule (planning.html lines 2788–2793) anchors it bottom-left. This is a pure layout/HTML-CSS concern.
2. **Open action placement** — the Open button is a single top-bar DOM element whose `dataset.url` is set per-selection in the detail renderers. Per-card Open buttons require resolving the external URL at render time via `_ticketExternalUrl()` (line 8264). ClickUp URLs are deterministic from id; Linear URLs require the API-provided `url` field — **which is NOT present in the file-backed sidebar data** (the `localTicketFilesListed` handler overwrites the API arrays and drops `url`). This makes the Open-button subtask's Path A (threading `url` through the cache DB + backend payload + webview mappings) the binding complexity of the entire epic.

## How the Subtasks Achieve This

- **Move 'synced' Badge Next to Status Label**: Relocates the sync-status badge (synced/modified/local) from the bottom card-actions row up to the status meta line, sitting inline next to the state name. This frees the action row to hold only buttons and improves information hierarchy.
- **Move 'Open' Button from Ticket Top Bar into Sidebar Cards**: Adds a per-card Open button to the card-actions row (resolving the external ticket URL per provider), so any ticket can be opened in the browser directly from the sidebar. Path A also threads the Linear url through the file-backed pipeline so Linear cards get working Open buttons.

## Metadata

- **Tags:** frontend, ui, refactor, feature
- **Complexity:** 6/10

## User Review Required

**Yes — inherited from the Open-button subtask.** The Open-button plan requires a Path A vs Path B decision before implementation:

1. **Path A (recommended, chosen in this epic's Goal):** Thread `url` through the file-backed pipeline so Linear cards get working Open buttons. Requires a cache-DB schema addition + migration (shipped state per CLAUDE.md), backend payload change, and webview mapping change. The top-bar Open button is removed once per-card Open works for both providers.
2. **Path B (lower scope, NOT chosen):** Frontend-only. Only ClickUp cards get Open buttons; the top-bar Open button is RETAINED so Linear keeps a working Open action via the detail pane.

This epic assumes **Path A** (the Goal explicitly references threading the Linear url). If the reviewer prefers Path B, the epic's Proposed Changes §4 (top-bar removal) and §5 (backend `url` threading) must be dropped, and the top-bar button retained.

## Complexity Audit

### Routine
- Adding a `ticket-status-row` class to the status `tickets-issue-meta` div in both card templates and moving `${syncBadge}` into it (badge subtask).
- Adding one CSS rule (`.ticket-status-row` flex layout with `align-self: center` override) and removing the obsolete `card-actions` pin rule (badge subtask).
- Adding an Open button to both card templates with a `data-open-ticket-url` attribute, rendered only when a URL resolves (Open-button subtask).
- Wiring a delegated click handler branch in the `tickets-issues-container` listener, placed after the `refineBtn` branch (Open-button subtask).
- Reusing `_ticketExternalUrl()` — no new URL logic.
- `flashIconBtn()` feedback + click isolation via `return` for the Open button.
- ClickUp cards always resolve a URL (deterministic fallback `https://app.clickup.com/t/${id}`).

### Complex / Risky
- **Path A cache-DB schema migration** — `imported_tickets` table gains a nullable `url` TEXT column; `ALTER TABLE ... ADD COLUMN url TEXT` must be idempotent (guard against duplicate-column errors). Existing rows get `NULL` url and backfill on next sync. Shipped state per CLAUDE.md — must migrate, not drop/recreate. This is the binding risk of the epic.
- **`url` threading across 4 layers** — cache DB (`KanbanDatabase.ts`), cache service (`PlanningPanelCacheService.ts` `registerImportedTicket`), backend payload (`PlanningPanelProvider.ts` `localTicketFilesListed` ~line 5192 + `_scanLocalTicketFiles` fallback), and webview mappings (planning.js lines 4399 ClickUp, 4408 Linear). A miss at any layer silently drops the Open button for all Linear cards.
- **Template application order** — both subtasks edit the exact same Linear and ClickUp card template strings. The Open-button subtask's "Before" snippet omits `${syncBadge}` (it was authored against the post-badge-move state). If applied against current `main` without the badge subtask first, the diff won't match. See Dependencies.
- **Top-bar removal is unsafe under Path B** — removing `#btn-open-ticket` while Linear cards lack `url` deletes Linear's only working Open action. Path-A-only.

## Edge-Case & Dependency Audit

- **Race Conditions:** None. Both card templates render synchronously from in-memory `linearProjectIssues`/`clickUpProjectIssues` arrays. The badge is static per-render; the Open button is static per-render (URL resolved at render time).
- **Security:** The resolved URL is placed in `data-open-ticket-url` via `escapeAttr()` and posted to the extension host as `openExternalUrl`. The host already validates/handles `openExternalUrl` for the top-bar button — no new trust surface.
- **Side Effects:**
  - Removing the `card-actions` pin rule (planning.html lines 2788–2793) is safe — `card-actions` already has `justify-content: flex-end` (line 2753), so action buttons stay right-aligned without the badge pushing them.
  - Removing the top-bar Open button (Path A) deletes `#btn-open-ticket` (planning.html line 3626), its `getTicketsTabElements()` entry (line 1081), its click listener (lines 7390–7394), and the two `if (btnOpenTicket)` blocks in the detail renderers (lines 8390–8393 Linear, 8922–8925 ClickUp). All must be removed together to avoid dangling references.
- **Dependencies & Conflicts:**
  - **Application order dependency (Clarification):** The Open-button subtask's "Before" snippets for `card-actions` do NOT include `${syncBadge}` — they assume the badge subtask has already moved it out. **Apply the badge subtask FIRST, then the Open-button subtask.** If applied in reverse or independently against current `main`, the Open-button "Before" won't match the live code (which still has `${syncBadge}` at line 8341 Linear / 8869 ClickUp). The integrated final state below resolves this regardless of order.
  - The two subtasks are otherwise orthogonal: the badge subtask touches the status-meta row + CSS; the Open-button subtask touches `card-actions` + the click handler + (Path A) the backend pipeline. No logical conflict.
  - Path A's cache-DB schema change must land before the frontend relies on `url` in the sidebar mapping.
  - The `localTicketFilesListed` backend payload AND the `_scanLocalTicketFiles` fallback path must both emit `url`.

## Dependencies

- None (no external plan must land first). The epic is self-contained but spans frontend + backend + cache DB under Path A. The two subtasks have an internal application-order dependency (badge first, then Open-button) documented above.

## Adversarial Synthesis

Key risks: (1) both subtasks edit the same card template strings and the Open-button plan's "Before" omits `${syncBadge}`, creating an application-order hazard — mitigated by applying the badge subtask first and specifying the integrated final template state; (2) Path A's cache-DB schema migration is shipped-state and must be idempotent-guarded, with `url` threaded across 4 layers or Linear cards silently get no Open button; (3) no isolated subtask verifies the combined end state — mitigated by adding an integrated visual check. Mitigations are documented in the Proposed Changes and Verification Plan.

## Proposed Changes

> The two subtask plans are the detailed implementation references. This section specifies the **integrated final state** of the shared card templates so the two subtasks compose without merge ambiguity. Apply the badge subtask first, then the Open-button subtask.

### 1. `src/webview/planning.html` — CSS (badge subtask)

Add a flex variant for the status meta row; remove the obsolete `card-actions` pin rule.

```css
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

Delete the obsolete pin rule (lines 2788–2793):
```css
/* DELETE — badge no longer lives in card-actions */
.ticket-node .card-actions .ticket-sync-badge {
    margin-right: auto;
    align-self: center;
}
```

### 2. `src/webview/planning.html` — Remove top-bar Open button (Path A only, Open-button subtask)

Delete line 3626:
```html
<button id="btn-open-ticket" class="strip-btn" style="display:none;">Open</button>
```

### 3. `src/webview/planning.js` — Linear card template INTEGRATED FINAL STATE (both subtasks)

After both subtasks, the Linear card template (currently lines 8333–8347) becomes:

```js
const openUrl = _ticketExternalUrl('linear', issue.identifier || issue.id, issue.url);
const openBtn = openUrl ? `<button type="button" class="card-icon-btn" data-open-ticket-url="${escapeAttr(openUrl)}">Open</button>` : '';
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
        ${openBtn}
    </div>
</div>
`;
```

Key changes vs. current: `${syncBadge}` moved from `card-actions` into the status meta row (which gains `ticket-status-row` class); `${openBtn}` appended in `card-actions`.

### 4. `src/webview/planning.js` — ClickUp card template INTEGRATED FINAL STATE (both subtasks)

After both subtasks, the ClickUp card template (currently lines 8862–8874) becomes:

```js
const openUrl = _ticketExternalUrl('clickup', task.id, task.url);
const openBtn = openUrl ? `<button type="button" class="card-icon-btn" data-open-ticket-url="${escapeAttr(openUrl)}">Open</button>` : '';
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
        ${openBtn}
    </div>
</div>
`;
```

### 5. `src/webview/planning.js` — Delegated click handler for Open button (Open-button subtask)

Insert after the `refineBtn` branch (after line 7656, before the card-selection fallback at line 7658):

```js
const openTicketBtn = e.target.closest('[data-open-ticket-url]');
if (openTicketBtn) {
    const url = openTicketBtn.dataset.openTicketUrl;
    if (url) {
        vscode.postMessage({ type: 'openExternalUrl', url });
        flashIconBtn(openTicketBtn);
    }
    return;
}
```

### 6. `src/webview/planning.js` — Remove top-bar Open button references (Path A only, Open-button subtask)

- Line 1081: remove `btnOpenTicket: document.getElementById('btn-open-ticket'),` from `getTicketsTabElements()`.
- Lines 7390–7394: remove the `btn-open-ticket` click listener.
- Lines 8390–8393 (Linear detail): remove the `if (btnOpenTicket) { ... }` block.
- Lines 8922–8925 (ClickUp detail): remove the `if (btnOpenTicket) { ... }` block.

### 7. Thread `url` through the file-backed pipeline (Path A only, Open-button subtask)

- **7a. Cache DB schema + migration** (`src/services/KanbanDatabase.ts`): add nullable `url` TEXT column to `imported_tickets`; `ALTER TABLE ... ADD COLUMN url TEXT` idempotent-guarded. Existing rows get `NULL`; backfill on next sync.
- **7b. Persist `url` at import** (`src/services/PlanningPanelCacheService.ts`, `registerImportedTicket` ~line 458): accept and store `url`; all callers must supply the provider `url`.
- **7c. Emit `url` in `localTicketFilesListed` payload** (`src/services/PlanningPanelProvider.ts` ~line 5192): add `url: dbT.url`; also update `_scanLocalTicketFiles` fallback.
- **7d. Preserve `url` in webview mappings** (`src/webview/planning.js`): line 4408 (Linear) add `url: t.url`; line 4399 (ClickUp) add `url: t.url`.

## Verification Plan

> Per session directives: skip compilation (`npm run compile`) and skip automated tests. The user runs those separately. Verification here is manual/visual.

### Automated Tests
- None run in this session.

### Manual Verification
1. **Integrated visual check (Linear, Path A)** — Load a Linear project. After sync, confirm each sidebar card shows: (a) the sync badge inline to the right of the status name on the status meta row, vertically centered (NOT top-aligned — confirms the `align-self: center` fix); (b) an "Open" button in the `card-actions` row; (c) `card-actions` contains ONLY the three original buttons + Open (no sync badge); (d) the top-bar Open button is gone.
2. **Integrated visual check (ClickUp)** — Repeat with a ClickUp project — same expected layout. Every ClickUp card shows an Open button (deterministic URL).
3. **Open button click (Linear)** — Click Open on a Linear card with a resolvable `url` — the external Linear issue URL opens in the browser. Confirm cards with `NULL` url (pre-migration rows not yet re-synced) gracefully show no Open button.
4. **Open button click (ClickUp)** — Click Open on a ClickUp card — `https://app.clickup.com/t/<id>` opens.
5. **Click isolation** — Clicking Open must NOT trigger card selection (the `return` in the delegated handler prevents fall-through). Verify the card does not get selected.
6. **Badge states** — A `modified` ticket shows the amber badge in the new status-row position; a `local`-only ticket shows the muted badge.
7. **Narrow sidebar** — Collapse the sidebar; confirm the status row + badge does not overflow (flex `gap` + `flex-shrink: 0`).
8. **Removed CSS rule** — Grep confirms no remaining references to the deleted `.ticket-node .card-actions .ticket-sync-badge` pin rule.
9. **No dangling top-bar refs (Path A)** — Confirm no console errors reference the removed `btn-open-ticket` element.
10. **Empty-URL guard** — Manually set a card's `data-open-ticket-url` to empty and click — confirm no `openExternalUrl` message is posted.

## Recommendation

Complexity 6 → **Send to Coder.** The frontend card work (both subtasks) is routine HTML/CSS/JS; the binding complexity is Path A's `url`-threading across the cache DB + backend payload + webview mappings with an idempotent schema migration. Apply the badge subtask first, then the Open-button subtask, using the integrated final template state in Proposed Changes §3–§4 as the merge target.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Move 'synced' Badge Next to Status Label in Tickets Tab Sidebar Cards](../plans/feature_plan_20260629154315_move-synced-badge-next-to-status-label.md) — **CODER CODED**
- [ ] [Move 'Open' Button from Ticket Top Bar into Sidebar Cards](../plans/feature_plan_20260629154316_move-open-button-into-sidebar-cards.md) — **CODER CODED**
<!-- END SUBTASKS -->
