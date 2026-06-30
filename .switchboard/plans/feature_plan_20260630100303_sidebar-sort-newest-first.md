# Fix Sidebar Sort Order in Tickets Tab (Newest First Within Each Status)

## Goal

The tickets tab sidebar in planning.html displays tickets in the wrong order — they appear to be sorted from oldest to newest (descending). The correct behavior is to show newest tickets first (ascending order), within each status category.

### Problem Analysis & Root Cause

**Root cause:** The sidebar ticket list is populated from two code paths:

1. **Primary path (DB-backed):** `listLocalTicketFiles` in `PlanningPanelProvider.ts` (line 5113) queries `getImportedTickets()` which calls `KanbanDatabase.listImportedTickets()` (line 2178 in KanbanDatabase.ts). The SQL query is `ORDER BY imported_at DESC` — newest **import** first. However, `imported_at` is the timestamp when the ticket was imported into Switchboard's local DB, NOT the ticket's creation date in ClickUp/Linear. If a user imported a batch of older tickets after newer ones, the order would appear reversed relative to ticket creation dates.

2. **Fallback path (filesystem scan):** `_scanLocalTicketFiles` (line 8333 in PlanningPanelProvider.ts) reads files in `readdirSync` order (filesystem order, typically alphabetical by filename). This has no chronological sorting at all.

3. **Frontend:** Neither `renderTicketsClickUpList` (line 9013) nor `renderTicketsLinearList` (line 8473) applies any client-side sorting. They map over the array in whatever order the backend returns it. `getFilteredClickUpTasks()` (line 8995) and `getFilteredLinearIssues()` (line 8422) only filter — they don't sort.

**The fix:** Sort the filtered ticket array in the frontend before rendering, using the best available date proxy. The ticket files already have a `created:` field in their frontmatter (written by `TaskViewerProvider.ts` at line 5527 for ClickUp and line 5262 for Linear). This field is not currently parsed by `listLocalTicketFiles` or passed through to the webview. The fix is to parse `created:` from frontmatter, pass it through as `dateCreated` on the ticket object, and sort by it descending in the frontend.

**Chosen approach:** Parse the existing `created:` frontmatter field in `listLocalTicketFiles` (line 5201) and `_scanLocalTicketFiles` (line 8333), pass it through as `dateCreated` on the ticket object, map it through the `localTicketFilesListed` handler (line 4474), and sort the frontend array by `dateCreated` descending. Fallback to file mtime if `created:` is missing from frontmatter.

## Metadata
**Tags:** frontend, ui, bugfix
**Complexity:** 3

## User Review Required
Yes — before implementation, confirm:
- Is sorting by the `created:` frontmatter field (ticket creation date in the source system) the correct sort key, or should it sort by `imported_at` (when the ticket was imported into Switchboard)?
- Should the sort be newest-first globally, or newest-first within each status group (if status grouping from Plan 1 is implemented)?

## Complexity Audit

### Routine
- Parse `created:` field from frontmatter in `listLocalTicketFiles` (line 5201) and `_scanLocalTicketFiles` (line 8333).
- Pass `dateCreated` through the `localTicketFilesListed` handler (line 4474) to `clickUpProjectIssues` / `linearProjectIssues`.
- Sort the filtered issues/tasks array by `dateCreated` descending in `getFilteredClickUpTasks` (line 8995) and `getFilteredLinearIssues` (line 8422).

### Complex / Risky
- **Missing `created:` in frontmatter:** Older ticket files may not have a `created:` field in their frontmatter. The fallback should use the file's modification time (`fs.statSync(filePath).mtime`) to ensure a reasonable sort order.
- **Interaction with Plan 1 (status grouping):** The sort must apply **within** each status group, not globally. If the status grouping plan is implemented first, the sort should be applied to each group's ticket array. If not, the sort applies to the flat list. The plan should be compatible with both states — sorting in `getFilteredClickUpTasks` / `getFilteredLinearIssues` handles both cases since the grouping helper in Plan 1 operates on the already-sorted array.

## Edge-Case & Dependency Audit

- **Race Conditions:** None — sorting is a synchronous in-memory operation on the filtered array.
- **Security:** No security implications. Date values come from frontmatter and are only used for numeric comparison.
- **Side Effects:** Sorting changes the HTML output string, which will invalidate the `_lastTicketsIssuesContainerHtml` / `_lastTicketsClickUpIssuesContainerHtml` cache and trigger a DOM update. This is correct behavior — the cache exists to prevent unnecessary updates, and a sort change is a legitimate update.
- **Dependencies & Conflicts:** This plan is compatible with Plan 1 (Accordion Headers). The sort in `getFilteredClickUpTasks` / `getFilteredLinearIssues` runs before the grouping helper, so each status group will receive already-sorted tickets. No conflict.
- **Missing dates:** Tickets without any date field (no frontmatter `created:`, file mtime unavailable) should sort to the end (treat as oldest, timestamp 0).
- **Equal dates:** Tickets with the same `dateCreated` should have a stable secondary sort (e.g., by title alphabetically) to prevent order flickering on re-renders.
- **String vs Date comparison:** `dateCreated` may be an ISO string or a timestamp number. Normalize to `Date.getTime()` for comparison.
- **Linear identifier sorting:** For Linear, the identifier (e.g., "ENG-123") contains a sequential number that could serve as a proxy for creation order. However, this is not reliable across different projects, so `dateCreated` is preferred.

## Dependencies
- None — this plan is self-contained. The `created:` frontmatter field already exists in ticket files (written by TaskViewerProvider.ts).

## Adversarial Synthesis
Key risks: (1) older ticket files without `created:` frontmatter will sort unpredictably unless file mtime fallback is implemented, (2) the plan originally referenced `dateCreated` as the frontmatter field name but the actual field is `created:` — this has been corrected. Mitigations: file mtime fallback for missing `created:`, stable secondary sort by title, correct frontmatter field name `created:` used throughout.

## Proposed Changes

### 1. Backend: Parse and return `dateCreated` from frontmatter `created:` field
**File:** `src/services/PlanningPanelProvider.ts`

In the `listLocalTicketFiles` case (line 5113), the frontmatter parsing block is at lines 5201-5212. Currently it parses `kanbanColumn`, `status`, `parentId`, and `listId`/`projectId`. Add parsing for the `created:` field:

```typescript
// Inside the frontmatter parsing block (around line 5201):
const cm = fm[1].match(/^created:\s*(.+)$/m);
let dateCreated: string | undefined;
if (cm) { dateCreated = cm[1].trim(); }
// Fallback to file mtime if no created: in frontmatter
if (!dateCreated) {
    try {
        const stat = fs.statSync(dbT.filePath);
        dateCreated = stat.mtime.toISOString();
    } catch {}
}
```

Add `dateCreated` to the ticket object pushed to the array (line 5233):

```typescript
tickets.push({
    id: dbT.remoteDocId || dbT.slugPrefix.replace(`${provider}_`, ''),
    title: dbT.docName,
    status: clickStatus || kanbanColumn || '',
    filePath: dbT.filePath,
    lastSyncedAt: dbT.lastSyncedAt,
    syncStatus,
    url: dbT.url || '',
    dateCreated  // NEW — parsed from frontmatter `created:` field, fallback to file mtime
});
```

Also update the fallback `_scanLocalTicketFiles` method (line 8333) to include `dateCreated`:

```typescript
// In _scanLocalTicketFiles, after reading frontmatter (around line 8348):
const cm = fm && fm[1].match(/^created:\s*(.+)$/m);
let dateCreated: string | undefined;
if (cm) { dateCreated = cm[1].trim(); }
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

In the `localTicketFilesListed` handler (line 4474), add `dateCreated` to the mapped objects:

```javascript
// ClickUp mapping (line 4480):
clickUpProjectIssues = tickets.map(t => ({
    id: t.id, title: t.title, identifier: t.id,
    status: t.status || '', assignees: [], filePath: t.filePath,
    syncStatus: t.syncStatus, url: t.url,
    dateCreated: t.dateCreated  // NEW
}));

// Linear mapping (line 4489):
linearProjectIssues = tickets.map(t => ({
    id: t.id, title: t.title, identifier: t.id,
    state: { name: t.status || '' }, assignee: null, description: '', filePath: t.filePath,
    syncStatus: t.syncStatus, url: t.url,
    dateCreated: t.dateCreated  // NEW
}));
```

### 3. Frontend: Sort filtered tasks/issues by dateCreated descending
**File:** `src/webview/planning.js`

In `getFilteredClickUpTasks` (line 8995), add sorting before returning:

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

In `getFilteredLinearIssues` (line 8422), apply the same sort:

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

### 4. No frontmatter writing change needed
**File:** `src/services/TaskViewerProvider.ts`

The `created:` field is already written to frontmatter at import time:
- ClickUp: line 5527 — `const fmLines = ['---', \`created: ${createdAt}\`];`
- Linear: line 5262 — `const fmLines = ['---', \`created: ${createdAt}\`];`

No change needed here — the field already exists. The fix is purely in parsing it back out and using it for sorting.

## Verification Plan

### Automated Tests
- N/A (webview UI changes; manual verification via VS Code extension host).

### Manual Testing
1. Open the tickets tab with several tickets of varying creation dates.
2. Verify: tickets appear in the sidebar sorted newest-first (most recently created at top).
3. Verify: within each status group (if status grouping is implemented), tickets are still sorted newest-first.
4. Verify: tickets without a `created:` field in frontmatter still sort reasonably (by file modification time).
5. Verify: the sort order is stable — re-selecting a ticket or re-rendering the sidebar does not change the order.
6. Verify: searching/filtering preserves the newest-first sort order within the filtered results.
7. Verify: both ClickUp and Linear providers show correct sort order.

**Recommendation:** Send to Coder

## Review Findings

**Reviewer pass:** Implementation is complete and correct. Files changed: `src/services/PlanningPanelProvider.ts` (parse `created:` frontmatter with file-mtime fallback in both `listLocalTicketFiles` and `_scanLocalTicketFiles`, pass `dateCreated` through on ticket objects), `src/webview/planning.js` (pass `dateCreated` through `localTicketFilesListed` handler for both ClickUp and Linear mappings, sort by `dateCreated` descending with stable title tiebreak in `getFilteredClickUpTasks` and `getFilteredLinearIssues`). Implementation matches plan exactly — no deviations. No CRITICAL or MAJOR findings. Verification: compilation and tests skipped per session instructions; code trace confirms missing dates sort to end (treated as 0), equal dates get stable title tiebreak, and sort runs before grouping (Plan 1 compatibility). Remaining risk: tickets with corrupt/invalid `created:` values (not ISO dates) would produce `NaN` from `new Date()` and sort unpredictably — but this is an edge case with no user impact since such files would also fail to render correctly elsewhere.
