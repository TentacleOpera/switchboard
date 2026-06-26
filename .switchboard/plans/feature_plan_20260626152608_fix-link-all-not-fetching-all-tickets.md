# Fix "Link All" on Tickets Tab Not Fetching All Sidebar Tickets

## Goal

### Problem
The "Link all" button on the Tickets tab of `planning.html` is supposed to copy file paths for **all** tickets shown in the sidebar to the clipboard. In practice, it only copies paths for **some** of them — a subset of the visible tickets. The user reports tickets that were in the sidebar for 24 hours still had no local files when "Link all" was clicked.

### Background
The Tickets tab has two modes controlled by `ticketsAutoSync`:
- **Auto-sync mode (`ticketsAutoSync === true`):** Tickets are fetched from the API and displayed in the sidebar. After loading, an `importAllTickets` message with `importMode: 'document'` is sent to write local markdown files for all tasks. This is the "import everything in the sidebar" step the user expects.
- **Local-only mode (`ticketsAutoSync === false`):** Tickets are loaded from existing local files only. No API calls, no import needed.

The "Link all" button (`#tickets-link-all`) sends filtered ticket IDs to the backend via `copyToClipboard`. The backend (`PlanningPanelProvider.ts`, `case 'copyToClipboard'`, line 5137) tries to find a local file for each ID. If none exists, it falls back to `importTaskAsDocument` — which makes a **live per-ticket API call** to fetch full details and write a local file.

### Root Cause
**Two bugs, not one:**

**Bug A — The initial sidebar import only covers the first page.** When `ticketsAutoSync` is true and the sidebar loads, the webview sends `importAllTickets` with `importMode: 'document'` but **without a `page` parameter** (<ref_snippet file="/Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/planning.js" lines="4927-4934" />). The backend document fast path (`TaskViewerProvider.ts`, line 18629) defaults `page` to 1 and slices to `pageSize` (100 for ClickUp, 50 for Linear):

```ts
const pageSize = 100;
const startIndex = (page - 1) * pageSize;
items = tasks.slice(startIndex, startIndex + pageSize);  // only first 100
```

The `getListTasks` / `queryIssues` call already returns ALL tasks in memory, but the slice discards everything beyond the first page. If there are 150 tickets, 50 are visible in the sidebar but never get local files. They sit there for 24 hours with no local file — exactly what the user observed.

**Bug B — `copyToClipboard` silently makes per-ticket API calls to patch the gap.** When "Link all" runs, `_findTicketFilePath` finds local files for the first batch but not the rest. The "ensure-then-link" fallback (<ref_snippet file="/Users/patrickvuleta/Documents/GitHub/switchboard/src/services/PlanningPanelProvider.ts" lines="5143-5178" />) then calls `importTaskAsDocument` per missing ticket — each making a live API call (`linear.getIssue(id)` / `clickUp.getTaskDetails(id)`), **sequentially**, with no concurrency, no retry, and silent per-ticket failure (`continue` on error). Rate-limited calls drop tickets silently.

A "copy file paths" button should never make API calls. The import should have already happened during the sidebar load. The API-call fallback is a band-aid for Bug A.

## Metadata
- **Tags:** `bug`, `tickets-tab`, `link-all`, `copyToClipboard`, `importAllTickets`, `pagination`, `backend`, `PlanningPanelProvider.ts`, `TaskViewerProvider.ts`, `planning.js`
- **Complexity:** 5/10

## Complexity Audit
**Complex/Risky.** Two files need changes:
1. `TaskViewerProvider.ts` — Remove the pagination slice from the document fast path so ALL tasks get local files during the initial sidebar load. The data is already in memory; this is removing an unnecessary `slice()` call. Low risk.
2. `PlanningPanelProvider.ts` — Remove the "ensure-then-link" API-call fallback from `copyToClipboard`. It should only copy paths for tickets that already have local files and report how many were skipped. This is a behavior change — "Link all" will no longer import missing tickets on the fly. Risk: if Bug A's fix doesn't fully cover all edge cases, some tickets might still lack local files and "Link all" would skip them. But that's the correct behavior — a copy-paths button shouldn't be an import button.

## Edge-Case & Dependency Audit
- **Document fast path pagination:** The `slice(startIndex, startIndex + pageSize)` was likely added to avoid writing too many files at once, but the data is already fetched — the slice just discards work already done. Removing it means writing all files in one pass. For very large lists (500+ tickets), this could be slow, but it's a one-time write per refresh and `importAllTasks` already processes sequentially within the fast path.
- **`page` parameter from webview:** The webview never sends `page` for the document import (only for the slow/plan path via "Load More"). After the fix, the `page` parameter becomes irrelevant for the document fast path — all items are processed regardless.
- **`copyToClipboard` single-ticket path:** The per-card "Link to ticket" button (planning.js:8654) sends `ticketIds: [id]`. With the API-call fallback removed, if that single ticket has no local file, the user gets a clear "ticket not imported" error instead of a silent API call. This is better — the user should import the ticket first (via "Add to Kanban" or "Refetch").
- **`copyToClipboard` directory-listing path:** When `ticketIds` is empty (no IDs sent), the handler lists ticket directories instead. This path is unchanged.
- **`ticketsAutoSync === false` mode:** In local-only mode, all sidebar tickets already have local files. "Link all" finds them all — no change needed.
- **Refetch button:** The "Refetch" button sets `_pendingRefreshImport = true` and reloads, which triggers `importAllTickets` document mode. With Bug A fixed, refetch will now import ALL tickets, not just the first page.
- **Existing local files for tickets no longer in the API:** `_findTicketFilePath` scans recursively by ID prefix, so it finds files regardless of when they were created. No issue.

## Proposed Changes

### 1. `src/services/TaskViewerProvider.ts` — Remove pagination slice from document fast path

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
items = tasks;  // Process all tasks — data is already in memory
```

**Before (Linear, ~line 18669):**
```ts
const issues = await linear.queryIssues({ projectId });
const pageSize = 50;
const startIndex = (page - 1) * pageSize;
items = issues.slice(startIndex, startIndex + pageSize);
```

**After:**
```ts
const issues = await linear.queryIssues({ projectId });
items = issues;  // Process all issues — data is already in memory
```

### 2. `src/services/PlanningPanelProvider.ts` — Remove API-call fallback from `copyToClipboard`

Replace the "ensure-then-link" loop (lines 5143–5178) with a simple local-file-only lookup. No API calls, no imports:

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

### 3. `src/webview/planning.js` — Report partial results in the status footer

Update the `ticketLinkCopied` handler (line 4142) to warn when some tickets were skipped:

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

### 4. No changes to `importTaskAsDocument`

The `importTaskAsDocument` method (`TaskViewerProvider.ts:18276`) is unchanged. It's still used by "Add to Kanban", "Edit", and the per-card "Link to ticket" button (which can keep its ensure-then-link behavior for single tickets if desired — see edge-case note below).

**Optional:** If the per-card "Link to ticket" button should also stop making API calls, apply the same local-file-only logic to the single-ticket path. This is a separate decision — the user's complaint is specifically about "Link all".

## Verification Plan
1. Open the Tickets tab with `ticketsAutoSync` enabled and a ClickUp/Linear source that has **more than 100 tickets** (or more than 50 for Linear).
2. Let the sidebar load. Wait for the `importAllTickets` document import to complete.
3. **Confirm:** Local markdown files exist for ALL sidebar tickets, not just the first 100/50. Check by looking in `.switchboard/tickets/` or the configured `ticketSaveLocation`.
4. Click "Link all".
5. **Confirm:** The clipboard contains file paths for **all** visible sidebar tickets — no subset, no missing.
6. **Confirm:** The status footer shows "Copied N ticket links ✓" with N matching the sidebar count.
7. **Confirm:** No API calls are made during "Link all" (check network tab in Developer Tools).
8. **Edge case test:** Delete a few local ticket files manually, then click "Link all".
9. **Confirm:** The status footer shows "Copied N of M ticket links — X have no local file. Click Refetch to import them."
10. Click "Refetch", wait for import, then click "Link all" again.
11. **Confirm:** All tickets now have local files and "Link all" copies all paths.
12. **Confirm:** The per-card "Link to ticket" button still works for a single already-imported ticket.
