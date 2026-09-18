# Move 'Open' Button from Ticket Top Bar into Sidebar Cards

## Goal

In the planning.html Tickets tab, the "Open" button (which opens the external ticket URL in the browser) currently lives in the ticket detail **top bar** (`#tickets-preview-meta-bar`, button `#btn-open-ticket`, planning.html line 3626). The user wants it removed from the top bar and instead placed on each **sidebar card** in the `card-actions` row, alongside the existing "Add to kanban", "Link to ticket", and "Refine" buttons.

### Problem Analysis & Root Cause

The "Open" button is a single DOM element (`#btn-open-ticket`) in the preview meta bar. Its visibility and `dataset.url` are set dynamically in `renderTicketsLinearTaskDetail()` (planning.js line 8390) and `renderTicketsClickUpTaskDetail()` (planning.js line 8922), based on the currently-selected ticket. The click handler (line 7391) reads `dataset.url` and posts `openExternalUrl`.

This design ties the "open externally" action to the detail pane — you must first select a ticket to see the Open button. The user wants per-card Open buttons so any ticket can be opened directly from the sidebar list without first selecting it.

The URL resolution logic already exists in `_ticketExternalUrl()` (line 8254): ClickUp URLs are deterministic from the task id; Linear uses the API-provided `url` field (falling back to nothing for local-only Linear tickets that lack a url). This helper can be reused per-card at render time.

### ⚠️ Critical Finding — Linear `url` is NOT available on sidebar cards

**The sidebar is always file-backed** (planning.js line 5252 comment: *"The sidebar is always file-backed now"*). `loadLocalTicketFiles()` is called at lines 4936, 5118, and 5259 immediately after every API load, and the `localTicketFilesListed` handler (line 4394) **overwrites** `linearProjectIssues`/`clickUpProjectIssues` with file-backed data.

The file-backed mapping **drops the `url` field**:
- **Webview** (line 4408, Linear): `{ id, title, identifier, state, assignee, description, filePath, syncStatus }` — no `url`.
- **Webview** (line 4399, ClickUp): `{ id, title, identifier, status, assignees, filePath, syncStatus }` — no `url`.
- **Backend payload** (`PlanningPanelProvider.ts` line 5192): `{ id, title, status, filePath, lastSyncedAt, syncStatus }` — no `url`.
- **Cache DB** (`ImportedDocEntry` via `registerImportedTicket`, `PlanningPanelCacheService.ts` line 458): stores `sourceId, docId, docName, slugPrefix, filePath, contentHash` — no `url` column.

**Consequence:** `_ticketExternalUrl('linear', issue.identifier || issue.id, issue.url)` receives `undefined` for `url`. Linear URLs are NOT deterministic from id (they require the team slug + number + title-slug, supplied by the API as `url`). The helper returns `''`. **Therefore NO Linear sidebar card will render an Open button** under the current file-backed pipeline. This is not an edge case — it is every Linear card.

ClickUp is unaffected: `_ticketExternalUrl('clickup', id, undefined)` falls back to `https://app.clickup.com/t/${id}`.

This means deleting the top-bar Open button (which currently works for Linear after selection, because the detail fetch populates `issue.url`) would be a **regression for Linear** unless the `url` is threaded through the file-backed pipeline.

### Decision Required (see ## User Review Required)

Two paths resolve this:
- **Path A (recommended):** Thread `url` through the file-backed pipeline so Linear cards get working Open buttons. Requires a cache-DB schema addition + migration (shipped state), backend payload change, and webview mapping change. Higher scope.
- **Path B (lower scope):** Frontend-only. Accept that Linear sidebar cards show no Open button (only ClickUp does). **Do NOT remove the top-bar Open button** in this path, or Linear loses the Open action entirely.

## Metadata

- **Tags:** frontend, ui, feature
- **Complexity:** 6/10 (Path A: routine frontend + one moderate backend/DB-migration risk; Path B: 3/10 frontend-only but half-delivered)

## User Review Required

**Yes.** The reviewer must choose Path A vs Path B before implementation:

1. **Path A — Thread `url` through the file-backed pipeline (recommended).** Linear cards get working Open buttons. Cost: cache-DB schema change + migration (shipped state per CLAUDE.md), backend payload + webview mapping edits. Complexity ~6.
2. **Path B — Frontend-only, accept Linear limitation.** Only ClickUp cards get Open buttons. The top-bar Open button must be RETAINED (not removed) so Linear keeps a working Open action via the detail pane. Complexity ~3.

The plan below documents both paths. The frontend card-template + delegated-handler work (Steps 1–3) is common to both; Step 4 (top-bar removal) is Path-A-only; Step 5 (backend `url` threading) is Path-A-only.

## Complexity Audit

### Routine
- Adding an Open button to the two card templates (Linear line ~8330, ClickUp line ~8858) with a `data-open-ticket-url` attribute.
- Wiring a delegated click handler branch in the `tickets-issues-container` listener (line 7617), placed after the `refineBtn` branch (line 7656) and before the card-selection fallback (line 7658).
- Reusing `_ticketExternalUrl()` (line 8254) — no new URL logic.
- `flashIconBtn()` (line 9161) feedback for click consistency.
- Click isolation via `return` so Open clicks don't fall through to card selection.
- ClickUp cards always resolve a URL (deterministic fallback).

### Complex / Risky
- **Linear `url` unavailability on file-backed sidebar cards** — the core blocker. Resolving via Path A touches the cache DB schema (shipped state → migration required), the backend `localTicketFilesListed` payload, and the webview mappings. Getting this wrong silently drops the Open button for all Linear cards.
- **Cache-DB migration (Path A only)** — `ImportedDocEntry`/`imported_tickets` table gains a `url` column; existing rows must be backfilled or treated as url-less until next sync. Per CLAUDE.md, shipped state must be migrated, not dropped.
- **Top-bar removal is unsafe under Path B** — removing `#btn-open-ticket` while Linear cards lack `url` deletes the only working Linear Open action.

## Edge-Case & Dependency Audit

- **Race Conditions:** None. Card templates render synchronously from the in-memory `linearProjectIssues`/`clickUpProjectIssues` arrays; the Open button is static per-render.
- **Security:** The resolved URL is placed in `data-open-ticket-url` via `escapeAttr()` (line 535) and posted to the extension host as `openExternalUrl`. The host already validates/handles `openExternalUrl` for the top-bar button — no new trust surface.
- **Side Effects:** Removing the top-bar Open button (Path A) deletes `#btn-open-ticket` (planning.html line 3626), its `getTicketsTabElements()` entry (line 1081), its click listener (lines 7390–7394), and the two `if (btnOpenTicket)` blocks in the detail renderers (lines 8390–8393 Linear, 8922–8925 ClickUp). All must be removed together to avoid dangling references / webpack errors.
- **Dependencies & Conflicts:**
  - Path A depends on the cache-DB schema change landing before the frontend relies on `url`.
  - The `localTicketFilesListed` backend payload (PlanningPanelProvider.ts line 5192) and the `_scanLocalTicketFiles` fallback path must both emit `url`.
  - No conflict with Plan 2 (sync-badge relocation) — both edit the same card templates but different rows (`card-actions` vs status-meta). If implemented together, the Open button is added to `card-actions` while the sync badge leaves it; the two edits are orthogonal.

## Dependencies

- None (no other plan must land first). Path A is self-contained but spans frontend + backend + cache DB.

## Adversarial Synthesis

Key risks: (1) Linear sidebar cards have no `url` in the file-backed pipeline, so the Open button silently never renders for Linear — a regression vs. the current top-bar button; (2) removing the top-bar button before `url` is threaded through (Path A) deletes Linear's only working Open action; (3) cache-DB schema change is shipped-state and requires a migration. Mitigations: choose Path A to thread `url` through the cache DB + backend payload + webview mapping (with migration), OR choose Path B and retain the top-bar button for Linear.

## Proposed Changes

### 1. `src/webview/planning.js` — Linear card template (line ~8323)

Add an Open button to `card-actions`, rendered only when a URL resolves.

**Before** (lines 8330–8335):
```js
<div class="card-actions">
    <button type="button" class="card-icon-btn" data-import-plan-id="${escapeAttr(issue.id)}" data-provider="linear">Add to kanban</button>
    <button type="button" class="card-icon-btn" data-link-ticket-id="${escapeAttr(issue.id)}" data-provider="linear">Link to ticket</button>
    <button type="button" class="card-icon-btn" data-refine-ticket-id="${escapeAttr(issue.id)}" data-provider="linear">Refine</button>
</div>
```

**After** (compute `openUrl` before the `return` at line 8323, recommended over an inline IIFE):
```js
const openUrl = _ticketExternalUrl('linear', issue.identifier || issue.id, issue.url);
const openBtn = openUrl ? `<button type="button" class="card-icon-btn" data-open-ticket-url="${escapeAttr(openUrl)}">Open</button>` : '';
```
```html
<div class="card-actions">
    <button type="button" class="card-icon-btn" data-import-plan-id="${escapeAttr(issue.id)}" data-provider="linear">Add to kanban</button>
    <button type="button" class="card-icon-btn" data-link-ticket-id="${escapeAttr(issue.id)}" data-provider="linear">Link to ticket</button>
    <button type="button" class="card-icon-btn" data-refine-ticket-id="${escapeAttr(issue.id)}" data-provider="linear">Refine</button>
    ${openBtn}
</div>
```

> Note: `issue` in the Linear list render is the issue object from `linearProjectIssues` which carries `identifier`, `id`, and (under Path A) `url`. Under Path B, `issue.url` is `undefined` so `openBtn` is `''` and no button renders — by design.

### 2. `src/webview/planning.js` — ClickUp card template (line ~8852)

Same addition for ClickUp cards. ClickUp always resolves a URL (deterministic from id), so the button will always render regardless of path.

**Before** (lines 8858–8863):
```js
<div class="card-actions">
    <button type="button" class="card-icon-btn" data-import-plan-id="${escapeAttr(task.id)}" data-provider="clickup">Add to kanban</button>
    <button type="button" class="card-icon-btn" data-link-ticket-id="${escapeAttr(task.id)}" data-provider="clickup">Link to ticket</button>
    <button type="button" class="card-icon-btn" data-refine-ticket-id="${escapeAttr(task.id)}" data-provider="clickup">Refine</button>
</div>
```

**After** (compute `openUrl` before the return):
```js
const openUrl = _ticketExternalUrl('clickup', task.id, task.url);
const openBtn = openUrl ? `<button type="button" class="card-icon-btn" data-open-ticket-url="${escapeAttr(openUrl)}">Open</button>` : '';
```
```html
<div class="card-actions">
    <button type="button" class="card-icon-btn" data-import-plan-id="${escapeAttr(task.id)}" data-provider="clickup">Add to kanban</button>
    <button type="button" class="card-icon-btn" data-link-ticket-id="${escapeAttr(task.id)}" data-provider="clickup">Link to ticket</button>
    <button type="button" class="card-icon-btn" data-refine-ticket-id="${escapeAttr(task.id)}" data-provider="clickup">Refine</button>
    ${openBtn}
</div>
```

### 3. `src/webview/planning.js` — Delegated click handler (line ~7617)

Add a branch for the new `data-open-ticket-url` button, placed alongside the existing `importPlanBtn` / `linkTicketBtn` / `refineBtn` branches.

**Insert after the `refineBtn` branch** (after line 7656, before the card-selection fallback at line 7658):
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

### 4. Remove the top-bar Open button — PATH A ONLY

> ⚠️ Do NOT perform this step under Path B. Under Path B the top-bar button is the only working Linear Open action and must be retained.

**`src/webview/planning.html`** — delete line 3626:
```html
<button id="btn-open-ticket" class="strip-btn" style="display:none;">Open</button>
```

**`src/webview/planning.js`** — remove the three references:
- Line 1081: `btnOpenTicket: document.getElementById('btn-open-ticket'),` from `getTicketsTabElements()`.
- Lines 7390–7394: the `btn-open-ticket` click listener.
- Lines 8390–8393 (Linear detail): the `if (btnOpenTicket) { ... }` block.
- Lines 8922–8925 (ClickUp detail): the `if (btnOpenTicket) { ... }` block.

### 5. Thread `url` through the file-backed pipeline — PATH A ONLY

This is the work that makes Linear sidebar cards actually show an Open button.

**5a. Cache DB schema + migration** (`src/services/KanbanDatabase.ts`):
- Add a nullable `url` TEXT column to the `imported_tickets` table (or equivalent).
- Migration: `ALTER TABLE ... ADD COLUMN url TEXT` (idempotent — guard against duplicate-column errors). Existing rows get `NULL` url; they backfill on the next sync/import. Do NOT drop/recreate the table (shipped state).

**5b. Persist `url` at import time** (`src/services/PlanningPanelCacheService.ts`, `registerImportedTicket` ~line 458):
- Accept and store the `url` parameter; pass it through to `upsertImportedTicket`.
- The import path that calls `registerImportedTicket` must supply the provider `url` (Linear `issue.url`, ClickUp `task.url`).

**5c. Emit `url` in the `localTicketFilesListed` payload** (`src/services/PlanningPanelProvider.ts` ~line 5192):
- Add `url: dbT.url` to the ticket object pushed at line 5192.
- Also update the `_scanLocalTicketFiles` fallback path so it emits `url` when available (or `''`).

**5d. Preserve `url` in the webview mappings** (`src/webview/planning.js`):
- Line 4408 (Linear `localTicketFilesListed` mapping): add `url: t.url` to the mapped object.
- Line 4399 (ClickUp `localTicketFilesListed` mapping): add `url: t.url` to the mapped object.
- The API-loaded paths (`linearProjectLoaded` line 4903, `clickupProjectLoaded` line 5088) already assign the raw API objects (which carry `url`), but they are immediately overwritten by `loadLocalTicketFiles()` — so 5c/5d are what actually matter for the sidebar.

## Verification Plan

> Per session directives: skip compilation (`npm run compile`) and skip automated tests. The user runs those separately. Verification here is manual/visual.

### Automated Tests
- None run in this session. (If a webview unit test exists for ticket card rendering, it should assert the Open button's presence/absence based on `url` availability — left to the user's test run.)

### Manual Verification
1. **ClickUp cards**: Load a ClickUp project in the Tickets tab. Confirm every sidebar card shows an "Open" button in the action row. Click it — `https://app.clickup.com/t/<id>` opens in the browser.
2. **Linear cards (Path A)**: Load a Linear project. After sync, confirm each card with a resolvable `url` shows an "Open" button. Click it — the external Linear issue URL opens. Confirm cards whose cache row still has `NULL` url (pre-migration rows not yet re-synced) gracefully show no Open button.
3. **Linear cards (Path B)**: Confirm Linear sidebar cards show NO Open button (expected). Confirm the top-bar Open button still appears when a Linear ticket is selected and works.
4. **Top bar (Path A only)**: Confirm the ticket detail top bar no longer has an "Open" button, and that no console errors reference the removed `btn-open-ticket` element.
5. **Click isolation**: Clicking the Open button must NOT also trigger card selection (the `return` in the delegated handler prevents fall-through). Verify the card does not get selected when Open is clicked.
6. **Visual feedback**: Confirm `flashIconBtn` fires on Open click for visual consistency with the other card buttons.
7. **Empty-URL guard**: Manually set a card's `data-open-ticket-url` to empty and click — confirm no `openExternalUrl` message is posted (the `if (url)` guard holds).

## Recommendation

- **Path A (chosen): Complexity 6 → Send to Coder.** The frontend card work is routine; the backend `url`-threading + cache-DB migration is the moderate, well-scoped risk. A coder can handle it with the migration guarded as idempotent.
- **Path B (if chosen): Complexity 3 → Send to Intern.** Frontend-only, but the feature is half-delivered (Linear gets no card Open button) and the top-bar button must be retained.

---

## Code Review Results (Reviewer Pass — Path A verified)

### Stage 1 — Grumpy Principal Engineer

> *"Four layers. FOUR. Cache DB, cache service, backend payload, webview mappings. Miss one and every Linear card silently loses its Open button. Let's see if you can count to four."*

- **PASS — Layer 1, Cache DB schema (`KanbanDatabase.ts:264`):** V40 migration `ALTER TABLE imported_docs ADD COLUMN url TEXT`. Idempotent guard present (line 5162: catches `duplicate column` / `already exists`). Shipped-state migration, not a drop/recreate. You read CLAUDE.md. I'm genuinely surprised.
- **PASS — Layer 1, read paths return `url`:** `listImportedTickets` (line 2183) and `getImportedDoc` (line 2107) both map `row.url`. `ImportedDocEntry.url?` (line 76). No silent drop.
- **PASS — Layer 2, cache service (`PlanningPanelCacheService.ts:466`):** `registerImportedTicket` accepts `url?` and forwards to upsert. The upsert uses `url = COALESCE(excluded.url, imported_docs.url)` (line 2142) — so a partial update that omits `url` (e.g. the push-edits path at `TaskViewerProvider.ts:18657`) will NOT clobber an existing url. That's the kind of defensive SQL that separates engineers from script-kiddies.
- **PASS — Layer 3, backend payload (`PlanningPanelProvider.ts:5118`):** `localTicketFilesListed` emits `url: dbT.url || ''`. The `_scanLocalTicketFiles` fallback (line 8230) emits `url: ''`. Both paths covered.
- **PASS — Layer 4, webview mappings (`planning.js:4409` ClickUp, `4418` Linear):** Both map `url: t.url`. The file-backed arrays now carry `url` end-to-end.
- **PASS — Import path supplies `url`:** `TaskViewerProvider.importTaskAsDocument` sets `ticketUrl = issue.url` for Linear (line 18411) and `ticketUrl = clickUpTask.url` for ClickUp (lines 18450, 18706). Bulk-write path `_writeTaskDocument` (line 18699/18706) and the register call (line 18722) both pass it. The push-edits path (line 18657) omits it — safe under COALESCE.
- **PASS — Card templates (`planning.js:8333-8334` Linear, `8859-8860` ClickUp):** `openUrl`/`openBtn` computed before the return; `${openBtn}` appended in `card-actions`. Empty-url guard (`openUrl ? ... : ''`) means no button renders when url is absent. Matches the integrated final state.
- **PASS — Delegated click handler (`planning.js:7659-7667`):** Placed after the `refineBtn` branch. `if (url)` guard prevents posting `openExternalUrl` on empty. `return` isolates the click from card selection. `flashIconBtn` fires for visual consistency.
- **PASS — Top-bar removal (Path A):** `#btn-open-ticket` gone from `planning.html`. `btnOpenTicket` gone from `getTicketsTabElements()` (line 1054+). Old click listener gone. Both `if (btnOpenTicket)` detail-renderer blocks gone. `grep` for `btnOpenTicket|btn-open-ticket` → 0 matches. No dangling references.
- **PASS — Backend `openExternalUrl` handler retained (`PlanningPanelProvider.ts:4852`):** Validates `https://`/`http://` scheme. The card button reuses the same trusted handler — no new trust surface.
- **NIT — Pre-fetched Linear create path (`TaskViewerProvider.ts:18397-18403`):** When `preFetchedTask` is set (just-created issue), the manually-built `issue` object omits `url`, so `ticketUrl` is `undefined` for that insert. Acceptable — a freshly-created issue's url may not be in the create response, and it backfills on next sync. COALESCE protects any pre-existing row. Not a defect, just noting the edge.
- **BONUS — Diagram-prompt handler (`planning.js:7406`):** This pre-existing feature also calls `_ticketExternalUrl(..., issue.issue.url)`. It now benefits from the url threading — Linear diagram prompts will resolve the real url instead of falling back. Positive side effect, not a concern.

### Stage 2 — Balanced Synthesis

| Finding | Severity | Disposition |
|---|---|---|
| All 4 url-threading layers complete & coherent | — | Keep (correct) |
| V40 migration idempotent-guarded | — | Keep (correct) |
| COALESCE protects url on partial upserts | — | Keep (correct) |
| Card templates + click handler match spec | — | Keep (correct) |
| Top-bar fully removed, no dangling refs | — | Keep (correct) |
| Pre-fetched Linear create path omits url | NIT | Defer — backfills on next sync; COALESCE-safe |
| Stale `_ticketSyncBadge` comment (planning.js:8270) | NIT | Defer — belongs to badge subtask; non-functional |

**No CRITICAL or MAJOR findings. No code fixes applied.**

### Files Changed (verified in place)
- `src/services/KanbanDatabase.ts` — V40 migration: `url TEXT` column on `imported_docs` (line 264, idempotent guard 5162); `ImportedDocEntry.url?` (line 76); `listImportedTickets` returns url (2183); `getImportedDoc` returns url (2107); upsert stores url with COALESCE (2142).
- `src/services/PlanningPanelCacheService.ts` — `registerImportedTicket` accepts `url?` (line 466) and forwards to upsert (481).
- `src/services/PlanningPanelProvider.ts` — `localTicketFilesListed` payload emits `url: dbT.url || ''` (line 5118); `_scanLocalTicketFiles` fallback emits `url: ''` (line 8230).
- `src/services/TaskViewerProvider.ts` — import paths supply `ticketUrl`: Linear `issue.url` (18411), ClickUp `clickUpTask.url` (18450, 18706); bulk-write passes it (18722); push-edits omits safely under COALESCE (18657).
- `src/webview/planning.js` — Linear card template: `openUrl`/`openBtn` (8333-8334), `${openBtn}` in card-actions (8346); ClickUp: same (8859-8860, 8871); delegated click handler (7659-7667); webview mappings preserve `url: t.url` (4409 ClickUp, 4418 Linear); top-bar `btnOpenTicket` refs removed (getTicketsTabElements, click listener, both detail renderers).
- `src/webview/planning.html` — `#btn-open-ticket` top-bar button deleted.

### Validation Results
- **Grep — `btnOpenTicket|btn-open-ticket` in planning.js:** 0 matches. ✓
- **Grep — `btn-open-ticket` in planning.html:** 0 matches. ✓
- **Grep — `data-open-ticket-url` in planning.js:** 3 matches (handler 7659, Linear template 8334, ClickUp template 8860). ✓
- **Grep — `openExternalUrl` backend handler:** present at `PlanningPanelProvider.ts:4852` with scheme validation. ✓
- **Grep — `card-actions .ticket-sync-badge` (obsolete pin rule):** 0 matches. ✓
- **Url-threading layer trace:** DB schema (264) → DB read (2183) → cache service (466/481) → backend payload (5118) → webview mapping (4409/4418) → card template (8333/8859). All 4 layers connected. ✓
- **V40 migration idempotency:** guard at line 5162 catches `duplicate column`/`already exists`. ✓
- **COALESCE protection:** upsert SQL line 2142 — partial updates preserve existing url. ✓
- **Compilation/tests:** Skipped per session directives.

### Remaining Risks
- **NIT:** Pre-fetched Linear create path (`TaskViewerProvider.ts:18397-18403`) builds the issue object without `url`, so the first insert for a just-created Linear ticket stores `NULL` url. The card shows no Open button until the next sync re-imports with the real url. Acceptable per plan ("Existing rows get NULL; they backfill on the next import/sync").
- **NIT (cross-plan):** Stale `_ticketSyncBadge` comment at `planning.js:8270` — tracked under the badge subtask; non-functional.
