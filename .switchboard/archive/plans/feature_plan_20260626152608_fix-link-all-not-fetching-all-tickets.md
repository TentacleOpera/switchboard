# Fix "Link All" on Tickets Tab Not Fetching All Sidebar Tickets

## Goal

### Problem
The "Link all" button on the Tickets tab of `planning.html` is supposed to copy file paths for **all** tickets shown in the sidebar to the clipboard. In practice, it only copies paths for **some** of them — a subset of the visible tickets. The user reports tickets that were in the sidebar for 24 hours still had no local files when "Link all" was clicked.

### Background
The Tickets tab has two modes controlled by `ticketsAutoSync`:
- **Auto-sync mode (`ticketsAutoSync === true`):** Tickets are fetched from the API and displayed in the sidebar. After loading, an `importAllTickets` message with `importMode: 'document'` is sent to write local markdown files for all tasks. This is the "import everything in the sidebar" step the user expects.
- **Local-only mode (`ticketsAutoSync === false`):** Tickets are loaded from existing local files only. No API calls, no import needed.

The "Link all" button (`#tickets-link-all`) sends filtered ticket IDs to the backend via `copyToClipboard`. The backend (`PlanningPanelProvider.ts`, `case 'copyToClipboard'`, line 5134) tries to find a local file for each ID. If none exists, it falls back to `importTaskAsDocument` — which makes a **live per-ticket API call** to fetch full details and write a local file.

### Root Cause
**Two bugs, not one:**

**Bug A — The initial sidebar import only covers the first page.** When `ticketsAutoSync` is true and the sidebar loads, the webview sends `importAllTickets` with `importMode: 'document'` but **without a `page` parameter** (<ref_snippet file="/Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/planning.js" lines="4927-4934" />). The backend document fast path (`TaskViewerProvider.ts`, line 18629) defaults `page` to 1 and slices to `pageSize` (100 for ClickUp, 50 for Linear):

```ts
const pageSize = 100;
const startIndex = (page - 1) * pageSize;
items = tasks.slice(startIndex, startIndex + pageSize);  // only first 100
```

The `getListTasks` / `queryIssues` call already returns tasks in memory, but the slice discards everything beyond the first page. If there are 150 tickets, 50 are visible in the sidebar but never get local files. They sit there for 24 hours with no local file — exactly what the user observed.

**Critical Linear nuance discovered during plan review:** Linear's `queryIssues` has its OWN internal limit. When called without a `limit` parameter (as the document fast path does — <ref_snippet file="/Users/patrickvuleta/Documents/GitHub/switchboard/src/services/TaskViewerProvider.ts" lines="18669" />), it defaults to **50 issues** (`LinearSyncService.ts` lines 716-718: `const limit = ... : 50`). The `maxPages = 10` cap with `first: 50` per page means it fetches exactly 1 page and stops. Removing the `slice(0, 50)` from an array that's already capped at 50 is a **no-op**. The Linear fix MUST also pass `limit: 100` to `queryIssues` to match the sidebar's own limit of 100 (`PlanningPanelProvider.ts` line 4089: `limit: 100`).

Note: The `projectId` parameter passed to `queryIssues` from the document fast path is used **only for cache keying**, not for actual API filtering (<ref_snippet file="/Users/patrickvuleta/Documents/GitHub/switchboard/src/services/LinearSyncService.ts" lines="726-728" />). The actual issue filtering comes from the config's include/exclude project name lists. This means the document import and the sidebar load fetch the same underlying set of issues — they just differ in limit.

**Bug B — `copyToClipboard` silently makes per-ticket API calls to patch the gap.** When "Link all" runs, `_findTicketFilePath` finds local files for the first batch but not the rest. The "ensure-then-link" fallback (<ref_snippet file="/Users/patrickvuleta/Documents/GitHub/switchboard/src/services/PlanningPanelProvider.ts" lines="5148-5170" />) then calls `importTaskAsDocument` per missing ticket — each making a live API call (`linear.getIssue(id)` / `clickUp.getTaskDetails(id)`), **sequentially**, with no concurrency, no retry, and silent per-ticket failure (`continue` on error). Rate-limited calls drop tickets silently.

A "copy file paths" button should never make API calls. The import should have already happened during the sidebar load. The API-call fallback is a band-aid for Bug A.

## Metadata
- **Tags:** bugfix, backend, frontend, api, ui, reliability
- **Complexity:** 5/10

## User Review Required
Yes — the plan changes the behavior of "Link all" from "silently import missing tickets via API calls" to "copy only existing local files and report missing ones." This is a deliberate UX change. The user should confirm that "Link all" should NOT import tickets on the fly, and that the "Click Refetch to import them" guidance is acceptable.

## Complexity Audit

### Routine
- Removing the `slice()` call from the ClickUp document fast path — the data is already in memory, this just stops discarding it.
- Removing the `slice()` call from the Linear document fast path (in combination with the limit fix).
- Updating the `ticketLinkCopied` webview handler to display partial-result warnings.
- The `copyToClipboard` rewrite reuses existing `_findTicketFilePath` and `_getTicketDocumentDirs` methods — no new file-scanning logic.

### Complex / Risky
- **Linear `queryIssues` limit fix**: Adding `limit: 100` to the `queryIssues` call in the document fast path. This changes the number of API pages fetched (from 1 page of 50 to 2 pages of 50). Must verify the `maxPages = 10` cap is not hit and the cache key still works correctly with the new limit.
- **Behavioral change in `copyToClipboard`**: Removing the API-call fallback means "Link all" will no longer import missing tickets. If Bug A's fix doesn't fully cover all edge cases (e.g., Linear sidebar limit of 100, import failures), some tickets will be reported as missing instead of silently imported. This is the correct behavior but is a user-visible change.
- **Linear sidebar limit of 100 (known limitation, out of scope)**: The Linear sidebar itself loads with `limit: 100` (`PlanningPanelProvider.ts` line 4089). Even after this fix, Linear users with more than 100 issues will only see 100 in the sidebar. "Link all" will cover all 100 visible tickets, but tickets beyond 100 are not shown at all. This is a separate issue.

## Edge-Case & Dependency Audit
- **Document fast path pagination (ClickUp):** The `slice(startIndex, startIndex + pageSize)` was likely added to avoid writing too many files at once, but `getListTasks` already paginates internally through ALL tasks (ClickUpSyncService.ts lines 1157-1176: while loop breaks when `pageTasks.length < 100`). The slice just discards work already done. Removing it means writing all files in one pass. For very large lists (500+ tickets), this could be slow, but it's a one-time write per refresh and `_writeTaskDocument` already processes sequentially within the fast path.
- **Document fast path pagination (Linear):** `queryIssues` does NOT paginate internally beyond the `limit` parameter. Without passing `limit: 100`, it defaults to 50 and fetches only 1 page. The fix must pass `limit: 100` to match the sidebar. The `maxPages = 10` cap is not a concern (100 issues = 2 pages of 50, well within 10).
- **`page` parameter from webview:** The webview never sends `page` for the document import (only for the slow/plan path via "Load More"). After the fix, the `page` parameter becomes irrelevant for the document fast path — all items are processed regardless.
- **`copyToClipboard` single-ticket path:** The per-card "Link to ticket" button (planning.js:8654) sends `ticketIds: [id]`. With the API-call fallback removed, if that single ticket has no local file, the user gets a clear "ticket not imported" error instead of a silent API call. This is better — the user should import the ticket first (via "Add to Kanban" or "Refetch").
- **`copyToClipboard` directory-listing path:** When `ticketIds` is empty (no IDs sent), the handler lists ticket directories instead. This path is unchanged.
- **`ticketsAutoSync === false` mode:** In local-only mode, all sidebar tickets already have local files. "Link all" finds them all — no change needed.
- **Refetch button:** The "Refetch" button sets `_pendingRefreshImport = true` and reloads, which triggers `importAllTickets` document mode. With Bug A fixed, refetch will now import ALL tickets (up to the limit), not just the first page.
- **Existing local files for tickets no longer in the API:** `_findTicketFilePath` scans recursively by ID prefix, so it finds files regardless of when they were created. No issue.
- **Cache invalidation:** The ClickUp document fast path invalidates the cache on `page === 1 && !append` (line 18643). Since `page` defaults to 1, this still fires correctly after the fix. The Linear path does not have this cache invalidation logic — it relies on the cache key including the limit. Adding `limit: 100` changes the cache key, which means the first call with the new limit will miss cache and fetch fresh data. This is correct behavior.
- **`importAllTicketsComplete` webview handler (planning.js line 4181):** No change needed. After the fix, `successCount` will reflect the full count (not just the first page). The existing handler displays this count correctly.

## Dependencies
- None — this plan is self-contained within the switchboard extension's existing code.

## Adversarial Synthesis
Key risks: (1) Linear fix is a no-op without the `limit: 100` addition — the plan's original version would ship without actually fixing Linear. (2) Removing the API-call fallback changes "Link all" from "best-effort import + copy" to "copy only what exists" — a UX regression for failure cases, but the correct architectural decision. (3) Linear's sidebar limit of 100 means the fix only covers up to 100 Linear issues; beyond that is a separate bug. Mitigations: add `limit: 100` to the Linear `queryIssues` call, guide users to "Refetch" when tickets are missing, and document the Linear 100-issue sidebar limit as a known limitation.

## Proposed Changes

### 1. `src/services/TaskViewerProvider.ts` — Remove pagination slice from document fast path (ClickUp)

In `importAllTasks`, the document fast path (line 18629) slices items to `pageSize`. Remove the slice so ALL fetched tasks are processed:

**Before (ClickUp, ~line 18646):**
```ts
const tasks = await clickup.getListTasks(listId);
const pageSize = 100;
const startIndex = (page - 1) * pageSize;
items = tasks.slice(startIndex, startIndex + pageSize);
```

**After:**
```ts
const tasks = await clickup.getListTasks(listId);
items = tasks;  // Process all tasks — getListTasks already paginates internally through ALL tasks
```

### 2. `src/services/TaskViewerProvider.ts` — Remove pagination slice AND fix limit (Linear)

**CRITICAL:** Linear's `queryIssues` defaults to limit=50 when no `limit` is passed. Removing the slice alone is a no-op. Must also pass `limit: 100` to match the sidebar's limit.

**Before (Linear, ~line 18669):**
```ts
const issues = await linear.queryIssues({ projectId });
const pageSize = 50;
const startIndex = (page - 1) * pageSize;
items = issues.slice(startIndex, startIndex + pageSize);
```

**After:**
```ts
const issues = await linear.queryIssues({ projectId, limit: 100 });
items = issues;  // Process all fetched issues — limit: 100 matches the sidebar's own limit
```

**Why `limit: 100`:** The sidebar loads via `linearLoadProject` which calls `queryIssues({ ..., limit: 100 })` (PlanningPanelProvider.ts line 4089). The document import must fetch the same set. The `queryIssues` internal cap is `Math.min(requestedLimit, 100)` (LinearSyncService.ts line 717), so 100 is the maximum. The `maxPages = 10` cap allows up to 500 issues, so 100 issues (2 pages of 50) is well within bounds.

**Note on `projectId`:** The `projectId` parameter in `queryIssues` is used only for cache keying (LinearSyncService.ts lines 726-728), not for API-level filtering. The actual filtering comes from the config's include/exclude project name lists. Adding `limit: 100` changes the cache key, causing a fresh fetch on the first call — this is correct.

### 3. `src/services/PlanningPanelProvider.ts` — Remove API-call fallback from `copyToClipboard`

Replace the "ensure-then-link" loop (lines 5142–5175) with a simple local-file-only lookup. No API calls, no imports:

```ts
case 'copyToClipboard': {
    const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
    const provider = msg.provider;
    const paths: string[] = [];
    const missingIds: string[] = [];
    if (workspaceRoot) {
        if (Array.isArray(msg.ticketIds) && msg.ticketIds.length > 0) {
            const providerDir = provider === 'clickup' ? 'clickup' : 'linear';
            for (const id of msg.ticketIds) {
                if (typeof id === 'string' && id && !id.includes('/') && !id.includes('\\') && !id.includes('..')) {
                    const filePath = this._findTicketFilePath(workspaceRoot, providerDir, id);
                    if (filePath) {
                        paths.push(filePath);
                    } else {
                        missingIds.push(id);
                    }
                }
            }
        } else {
            for (const dir of this._getTicketDocumentDirs(workspaceRoot, provider)) {
                if (!fs.existsSync(dir)) { continue; }
                paths.push(dir);
            }
        }
    }
    if (Array.isArray(msg.ticketIds) && msg.ticketIds.length > 0) {
        if (paths.length === 0) {
            this._panel?.webview.postMessage({
                type: 'ticketLinkFailed',
                error: missingIds.length > 0
                    ? `No local files found for ${missingIds.length} ticket(s). Click "Refetch" to import them first.`
                    : 'Could not locate local files for these tickets.'
            });
        } else {
            await vscode.env.clipboard.writeText(paths.join('\n'));
            this._panel?.webview.postMessage({
                type: 'ticketLinkCopied',
                count: paths.length,
                requestedCount: msg.ticketIds.length,
                missingCount: missingIds.length
            });
        }
    } else {
        await vscode.env.clipboard.writeText(paths.join('\n'));
    }
    break;
}
```

Key changes:
- **No `importTaskAsDocument` calls** — "Link all" is a copy-paths button, not an import button.
- **`missingIds` tracked** — tickets without local files are counted and reported, not silently dropped.
- **Error message guides the user** — "Click Refetch to import them first" instead of a generic failure.
- **`lastError` variable removed** — no longer needed since there are no API calls to fail.

### 4. `src/webview/planning.js` — Report partial results in the status footer

Update the `ticketLinkCopied` handler (**line 4209**, not 4142 as originally stated) to warn when some tickets were skipped:

```js
case 'ticketLinkCopied':
    if (msg.missingCount && msg.missingCount > 0) {
        showTicketsStatus(
            `Copied ${msg.count} of ${msg.requestedCount} ticket links — ${msg.missingCount} have no local file. Click "Refetch" to import them.`,
            true  // isError = true, shows as warning
        );
    } else {
        showTicketsStatus(`Copied ${msg.count} ticket link${msg.count > 1 ? 's' : ''} ✓`, false);
    }
    if (_lastLinkTicketBtn) {
        flashCopyBtn(_lastLinkTicketBtn);
        _lastLinkTicketBtn = null;
    }
    break;
```

### 5. No changes to `importTaskAsDocument`

The `importTaskAsDocument` method (`TaskViewerProvider.ts:18276`) is unchanged. It's still used by "Add to Kanban", "Edit", and the per-card "Link to ticket" button (which can keep its ensure-then-link behavior for single tickets if desired — see edge-case note below).

**Optional:** If the per-card "Link to ticket" button should also stop making API calls, apply the same local-file-only logic to the single-ticket path. This is a separate decision — the user's complaint is specifically about "Link all".

## Verification Plan
### Automated Tests
> Per session directives: compilation and automated tests are skipped. The test suite will be run separately by the user.

### Manual Verification Steps
1. Open the Tickets tab with `ticketsAutoSync` enabled and a ClickUp source that has **more than 100 tickets**.
2. Let the sidebar load. Wait for the `importAllTickets` document import to complete.
3. **Confirm:** Local markdown files exist for ALL sidebar tickets, not just the first 100. Check by looking in `.switchboard/tickets/` or the configured `ticketSaveLocation`.
4. Click "Link all".
5. **Confirm:** The clipboard contains file paths for **all** visible sidebar tickets — no subset, no missing.
6. **Confirm:** The status footer shows "Copied N ticket links ✓" with N matching the sidebar count.
7. **Confirm:** No API calls are made during "Link all" (check network tab in Developer Tools).
8. **Linear test:** Open the Tickets tab with a Linear source that has **more than 50 but fewer than 100 issues**.
9. Let the sidebar load and import complete.
10. **Confirm:** Local files exist for ALL sidebar tickets (up to 100), not just the first 50.
11. Click "Link all".
12. **Confirm:** All visible sidebar tickets have paths in the clipboard.
13. **Edge case test:** Delete a few local ticket files manually, then click "Link all".
14. **Confirm:** The status footer shows "Copied N of M ticket links — X have no local file. Click Refetch to import them."
15. Click "Refetch", wait for import, then click "Link all" again.
16. **Confirm:** All tickets now have local files and "Link all" copies all paths.
17. **Confirm:** The per-card "Link to ticket" button still works for a single already-imported ticket.

### Recommendation
Complexity is 5/10 → **Send to Coder**.

---

## Code Review (Reviewer Pass — 2026-06-28)

### Stage 1 — Grumpy Principal Engineer

> Five out of ten complexity and a plan that spells out FOUR distinct changes, and
> I would bet my pension that someone did three of them, felt productive, and went
> to lunch. Let's count the bodies.
>
> **§1 — ClickUp slice removal.** `TaskViewerProvider.ts:18727-18728`:
> `const tasks = await clickup.getListTasks(listId); items = tasks;`. The
> page-slicing knife is gone. `getListTasks` already paginates internally, so we
> stop throwing away tickets 101+. Fine. ✓
>
> **§2 — Linear slice removal AND the limit fix.** `18748-18749`:
> `linear.queryIssues({ projectId, limit: 100 }); items = issues;`. And before you
> ask — yes, I went and READ `LinearSyncService.ts:715-718`. Without a `limit` it
> defaults to **50** and the slice removal would have been a glorious no-op; the
> cap is `Math.min(floor(requestedLimit), 100)`, so `limit: 100` is both honored
> and the ceiling, matching the sidebar's own `limit: 100`. This is the ONE subtle
> trap in the whole plan and they didn't faceplant. ✓
>
> **§3 — `copyToClipboard` de-fanged.** `PlanningPanelProvider.ts:5140-5193`. The
> "ensure-then-link" loop that fired a live `importTaskAsDocument` API call per
> missing ticket — sequentially, silently, swallowing rate-limit failures with a
> `continue` — is **gone**. I grepped the block for `importTaskAsDocument`,
> `ensureTicket`, `lastError`: nothing. It now does a pure `_findTicketFilePath`
> lookup, pushes hits to `paths`, pushes misses to `missingIds`, and posts
> `ticketLinkCopied { count, requestedCount, missingCount }` or `ticketLinkFailed`.
> A copy-paths button that no longer phones an API. ✓
>
> **§4 — …and here's the corpse.** The whole POINT of this plan is that tickets
> stop vanishing SILENTLY. The backend dutifully ships `missingCount` and
> `requestedCount` across the wire — and the webview handler at
> `planning.js:4222` **threw them in the bin.** It read:
> `showTicketsStatus('Copied ${msg.count} ticket links ✓', false)` — full stop.
> So you ask for 100 links, 20 have no local file, and the UI chirps *"Copied 80
> ticket links ✓"* with a happy green checkmark. **You reintroduced the EXACT
> silent-truncation the user filed this bug about** — except now there's no API
> fallback papering over it either, so it's *more* silent than before. The plan
> hands you the replacement verbatim in §4 and someone skipped it. That is a
> **MAJOR**. The backend half of the fix is useless if the frontend smiles and lies
> about it.

### Stage 2 — Balanced Synthesis

- **Keep:** §1, §2, §3 — all correct, including the genuinely subtle Linear
  `limit: 100` fix (verified against `LinearSyncService.ts:715-718`) and the
  complete removal of the per-ticket API fallback (no orphaned `lastError`/
  `importTaskAsDocument`/`ensureTicket` references remain).
- **Fix now (MAJOR):** §4 — the `ticketLinkCopied` webview handler must surface
  `missingCount`/`requestedCount` as a warning, or the entire fix is invisible to
  the user and the original silent-truncation symptom returns. **Fixed this pass.**
- **Defer / accept:** Linear sidebar 100-issue ceiling remains a known,
  out-of-scope limitation (documented in the plan). Slow/plan path slices at
  `18789-18800` are intentionally untouched — they serve the "Load More" explicit-ID
  path, not the document fast path.

### Fixes Applied
- **`src/webview/planning.js` (`ticketLinkCopied` handler, ~line 4222):**
  Implemented Proposed Change §4. When `msg.missingCount > 0`, the handler now shows
  `Copied N of M ticket links — X have no local file. Click "Refetch" to import them.`
  as a warning (`isError = true`); otherwise the original `Copied N ticket links ✓`
  success message. `flashCopyBtn`/`_lastLinkTicketBtn` reset preserved in both branches.

### Files Changed (by implementation, verified this pass)
- `src/services/TaskViewerProvider.ts` — ClickUp fast-path slice removed (`18727-18728`); Linear fast-path slice removed + `limit: 100` added (`18748-18749`).
- `src/services/PlanningPanelProvider.ts` — `copyToClipboard` rewritten to local-file-only with `missingIds` tracking (`5140-5193`); API-call fallback removed.
- `src/webview/planning.js` — `ticketLinkFailed` handler present (`4229-4235`); **`ticketLinkCopied` partial-result warning added this pass (`4222-4235`).**

### Validation
- `node --check src/webview/planning.js` → **passed** (syntax OK after the §4 edit).
- `copyToClipboard` block re-grepped: no orphaned `lastError`/`importTaskAsDocument`/`ensureTicket` references.
- Linear `limit` cap confirmed in `LinearSyncService.ts:715-718` (`Math.min(floor(limit),100)`, default 50) — `limit: 100` is correct and matches the sidebar.
- Compilation & automated tests skipped per session directive.

### Remaining Risks
- **Linear sidebar 100-issue ceiling (known, out of scope):** Linear users with >100
  issues still only see 100 in the sidebar; "Link all" covers all 100 visible, but
  issues beyond 100 are never shown. Tracked as a separate limitation.
- **Behavioral change is intentional:** "Link all" no longer imports missing tickets
  on the fly. With §4 now wired, the user is told exactly how many are missing and to
  click Refetch — which is the designed UX. Confirm via manual verification steps 13–16.
