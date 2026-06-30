# Fix Sidebar Sort Order in Tickets Tab (Newest First Within Each Status)

## Goal

The tickets tab sidebar in planning.html displays tickets in the wrong order — they appear to be sorted from oldest to newest (descending). The correct behavior is to show newest tickets first (ascending order), within each status category.

### Problem Analysis & Root Cause

**Root cause:** The sidebar ticket list is populated from two code paths:

1. **Primary path (DB-backed):** `listLocalTicketFiles` in `PlanningPanelProvider.ts` (line ~5112) queries `getImportedTickets()` which calls `KanbanDatabase.listImportedTickets()` (line ~2161 in KanbanDatabase.ts). The SQL query is `ORDER BY imported_at DESC` — newest **import** first. However, `imported_at` is the timestamp when the ticket was imported into Switchboard's local DB, NOT the ticket's creation date in ClickUp/Linear. If a user imported a batch of older tickets after newer ones, the order would appear reversed relative to ticket creation dates.

2. **Fallback path (filesystem scan):** `_scanLocalTicketFiles` (line ~8332 in PlanningPanelProvider.ts) reads files in `readdirSync` order (filesystem order, typically alphabetical by filename). This has no chronological sorting at all.

3. **Frontend:** Neither `renderTicketsClickUpList` (line ~8961) nor `renderTicketsLinearList` (line ~8411) applies any client-side sorting. They map over the array in whatever order the backend returns it. `getFilteredClickUpTasks()` and `getFilteredLinearIssues()` only filter — they don't sort.

**The fix:** Sort the filtered ticket array in the frontend before rendering, using the best available date proxy. The ticket objects from the DB path include `lastSyncedAt` and the file's modification time can be used as a fallback. For the DB path, `imported_at` is available on the `ImportedDocEntry` but is not currently passed through to the webview. The simplest reliable approach is to sort by the file's modification time (newest first), which is available via `fs.statSync` on the backend, or by adding a `createdAt` or `dateCreated` field to the frontmatter and passing it through.

**Chosen approach:** Add a `dateCreated` field to the ticket data returned by the backend (parsed from frontmatter if available, falling back to file mtime), and sort the frontend array by this field descending. This is the most semantically correct solution and aligns with the user's expectation of "newest first."

## Metadata
**Tags:** ui, frontend, sorting, bugfix, tickets-tab
**Complexity:** 3

## Complexity Audit

### Routine
- Add `dateCreated` field to the ticket objects returned by `listLocalTicketFiles` in `PlanningPanelProvider.ts`.
- Parse `dateCreated` from frontmatter in the DB path (line ~5203) and the scan path (line ~8348).
- Sort the filtered issues/tasks array by `dateCreated` descending in the frontend render functions.

### Complex / Risky
- **Missing `dateCreated` in frontmatter:** Older ticket files may not have a `dateCreated` field in their frontmatter. The fallback should use the file's modification time (`fs.statSync(filePath).mtime`) to ensure a reasonable sort order.
- **Interaction with Issue 2 (status grouping):** The sort must apply **within** each status group, not globally. If the status grouping plan is implemented first, the sort should be applied to each group's ticket array. If not, the sort applies to the flat list. The plan should be compatible with both states.

## Edge-Case & Dependency Audit

- **Missing dates:** Tickets without any date field (no frontmatter `dateCreated`, file mtime unavailable) should sort to the end (treat as oldest).
- **Equal dates:** Tickets with the same `dateCreated` should have a stable secondary sort (e.g., by title alphabetically) to prevent order flickering on re-renders.
- **String vs Date comparison:** `dateCreated` may be an ISO string or a timestamp number. Normalize to `Date.getTime()` for comparison.
- **Linear identifier sorting:** For Linear, the identifier (e.g., "ENG-123") contains a sequential number that could serve as a proxy for creation order. However, this is not reliable across different projects, so `dateCreated` is preferred.
- **Cache string impact:** Sorting changes the HTML output string, which will invalidate the `_lastTicketsIssuesContainerHtml` cache and trigger a DOM update. This is correct behavior — the cache exists to prevent unnecessary updates, and a sort change is a legitimate update.

## Proposed Changes

### 1. Backend: Parse and return `dateCreated` from frontmatter
**File:** `src/services/PlanningPanelProvider.ts`

In the `listLocalTicketFiles` case (line ~5193-5241), when reading frontmatter from each ticket file, also extract `dateCreated`:

```typescript
// Inside the frontmatter parsing block (around line 5203):
const dcm = fm[1].match(/^dateCreated:\s*(.+)$/m);
let dateCreated: string | undefined;
if (dcm) { dateCreated = dcm[1].trim(); }
// Fallback to file mtime if no dateCreated in frontmatter
if (!dateCreated) {
    try {
        const stat = fs.statSync(dbT.filePath);
        dateCreated = stat.mtime.toISOString();
    } catch {}
}
```

Add `dateCreated` to the ticket object pushed to the array (line ~5233):

```typescript
tickets.push({
    id: dbT.remoteDocId || dbT.slugPrefix.replace(`${provider}_`, ''),
    title: dbT.docName,
    status: clickStatus || kanbanColumn || '',
    filePath: dbT.filePath,
    lastSyncedAt: dbT.lastSyncedAt,
    syncStatus,
    url: dbT.url || '',
    dateCreated  // NEW
});
```

Also update the fallback `_scanLocalTicketFiles` method (line ~8332) to include `dateCreated`:

```typescript
// In _scanLocalTicketFiles, after reading frontmatter:
const dcm = fm && fm[1].match(/^dateCreated:\s*(.+)$/m);
let dateCreated: string | undefined;
if (dcm) { dateCreated = dcm[1].trim(); }
if (!dateCreated) {
    try {
        const stat = nfs.statSync(fullPath);
        dateCreated = stat.mtime.toISOString();
    } catch {}
}
out.push({ id, title, status: kanbanColumn || '', filePath: fullPath, url: '', dateCreated });
```

### 2. Frontend: Pass `dateCreated` through to the issues arrays
**File:** `src/webview/planning.js`

In the `localTicketFilesListed` handler (line ~4420), add `dateCreated` to the mapped objects:

```javascript
// ClickUp mapping (line ~4425):
clickUpProjectIssues = tickets.map(t => ({
    id: t.id, title: t.title, identifier: t.id,
    status: t.status || '', assignees: [], filePath: t.filePath,
    syncStatus: t.syncStatus, url: t.url,
    dateCreated: t.dateCreated  // NEW
}));

// Linear mapping (line ~4434):
linearProjectIssues = tickets.map(t => ({
    id: t.id, title: t.title, identifier: t.id,
    state: { name: t.status || '' }, assignee: null, description: '', filePath: t.filePath,
    syncStatus: t.syncStatus, url: t.url,
    dateCreated: t.dateCreated  // NEW
}));
```

### 3. Frontend: Sort filtered tasks/issues by dateCreated descending
**File:** `src/webview/planning.js`

In `getFilteredClickUpTasks` (line ~8943), add sorting before returning:

```javascript
function getFilteredClickUpTasks() {
    const search = String(clickUpProjectSearchValue || '').trim().toLowerCase();
    const statusFilter = String(clickUpProjectStatusFilterValue || '').trim();
    const filtered = clickUpProjectIssues.filter(task => {
        if (task?.parentId) return false;
        if (statusFilter && task.status !== statusFilter) return false;
        if (!search) return true;
        const haystack = [
            task.id, task.identifier, task.title, task.description,
            task.assignees?.map(a => a.username || a.email).join(' ')
        ].join('\n').toLowerCase();
        return haystack.includes(search);
    });
    // Sort newest first by dateCreated, fallback to title for stability
    return filtered.sort((a, b) => {
        const aTime = a.dateCreated ? new Date(a.dateCreated).getTime() : 0;
        const bTime = b.dateCreated ? new Date(b.dateCreated).getTime() : 0;
        if (bTime !== aTime) return bTime - aTime;
        return (a.title || '').localeCompare(b.title || '');
    });
}
```

In `getFilteredLinearIssues` (line ~8360), apply the same sort:

```javascript
function getFilteredLinearIssues() {
    const search = String(linearProjectSearchValue || '').trim().toLowerCase();
    const stateFilter = String(linearProjectStateFilterValue || '').trim();
    const projectFilter = String(linearProjectPickerValue || '').trim();
    const filtered = linearProjectIssues.filter((issue) => {
        if (issue?.parentId) return false;
        if (stateFilter && String(issue?.state?.name || '') !== stateFilter) return false;
        if (projectFilter && String(issue?.project?.name || '') !== projectFilter) return false;
        if (!search) return true;
        const haystack = [
            issue.identifier, issue.title, issue.description,
            issue.assignee?.name, issue.assignee?.email
        ].join('\n').toLowerCase();
        return haystack.includes(search);
    });
    // Sort newest first by dateCreated, fallback to title for stability
    return filtered.sort((a, b) => {
        const aTime = a.dateCreated ? new Date(a.dateCreated).getTime() : 0;
        const bTime = b.dateCreated ? new Date(b.dateCreated).getTime() : 0;
        if (bTime !== aTime) return bTime - aTime;
        return (a.title || '').localeCompare(b.title || '');
    });
}
```

### 4. Ensure `dateCreated` is written to frontmatter at import time
**File:** `src/services/TaskViewerProvider.ts`

When tickets are imported and saved as local `.md` files, ensure the `dateCreated` field from the API response is written into the frontmatter. Search for the ticket file writing logic and add `dateCreated` to the frontmatter block. The ClickUp API returns `date_created` (epoch timestamp) and Linear returns `createdAt` (ISO string). Normalize both to ISO string in the frontmatter.

This step ensures that future imports include the creation date, so the sort is accurate. Existing files without `dateCreated` will fall back to file mtime.

## Verification Plan

### Manual Testing
1. Open the tickets tab with several tickets of varying creation dates.
2. Verify: tickets appear in the sidebar sorted newest-first (most recently created at top).
3. Verify: within each status group (if status grouping is implemented), tickets are still sorted newest-first.
4. Verify: tickets without a `dateCreated` field in frontmatter still sort reasonably (by file modification time).
5. Verify: the sort order is stable — re-selecting a ticket or re-rendering the sidebar does not change the order.
6. Verify: searching/filtering preserves the newest-first sort order within the filtered results.
7. Verify: both ClickUp and Linear providers show correct sort order.

### Automated Tests
- N/A (webview UI changes; manual verification via VS Code extension host).

**Recommendation:** Send to Coder
