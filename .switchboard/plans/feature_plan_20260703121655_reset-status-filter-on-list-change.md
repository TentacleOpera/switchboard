# Reset ClickUp status filter when the source list changes

## Goal

In the planning.html **Tickets tab**, when a user switches the ClickUp list (or any ancestor in the Space → Folder → List hierarchy), the tickets list renders empty if the newly-selected list does not share the same status set as the previously-selected list — even though the status-filter dropdown visually reads "All statuses".

### Problem analysis & root cause

The ClickUp tickets tab maintains two pieces of state that drive the status filter:

- `clickUpProjectStatusFilterValue` (line 294) — the currently-selected status string (e.g. `"In Progress"`), persisted across renders and into `saveTicketsState()`.
- `availableClickUpStatuses` (line 310) — the status set for the *currently-loaded list*, refreshed asynchronously via the `clickupLoadListStatuses` message after `clickupProjectLoaded` fires (lines 5533–5535).

The three hierarchy change handlers — **space** (line 9711), **folder** (line 9758), and **list** (line 9807) — each reset `clickUpSelectedListId`, `clickUpProjectIssues`, `selectedClickUpIssue`, and call `_resetSidebarDrillDown()`, but **none of them reset `clickUpProjectStatusFilterValue` or `availableClickUpStatuses`**.

The failure sequence on a list change:

1. User is on List A with status filter set to `"In Progress"` (a status that exists in List A).
2. User picks List B from the dropdown. `listSelect` change handler runs (line 9808): it clears `clickUpProjectIssues`, sets `clickUpSelectedListId = listId`, and calls `loadClickUpProject(false, listId)`. **`clickUpProjectStatusFilterValue` is left as `"In Progress"`.**
3. `clickupProjectLoaded` arrives (line 5525), populating `clickUpProjectIssues` with List B's tasks and clearing `availableClickUpStatuses = []` before re-requesting statuses for List B.
4. `renderTicketsClickUpStatusFilterOptions()` (line 9866) rebuilds the `<select>` options from the new status set. Because `"In Progress"` is not among List B's statuses, the browser silently resets the `<select>`'s `.value` to `""` (the first option, "All statuses") — so the **dropdown visually shows "All statuses"**.
5. However, the JS variable `clickUpProjectStatusFilterValue` still holds `"In Progress"`. `renderTicketsClickUpStatusFilterOptions` then runs `clickUpStatusFilter.value = clickUpProjectStatusFilterValue || ''` (line 9885), which assigns a value that isn't a valid option — the DOM `.value` stays `""` but the JS variable is unchanged.
6. `getFilteredClickUpTasks()` (line 9890) applies `if (statusFilter && task.status !== statusFilter) return false;` using the stale `clickUpProjectStatusFilterValue = "In Progress"`. Every List B task has a different status, so **all tasks are filtered out** and the panel shows "No tasks found."

The visible state (dropdown says "All statuses") and the actual filter state (JS variable holds a stale status) are decoupled, which is what makes this bug confusing to a user: it looks like no filter is applied, yet nothing shows.

The same stale-filter hazard exists for the space and folder change handlers, since changing either of those also implicitly changes the active list.

> Note on Linear: the issue mentions "or its linear equivalent", but the Linear tickets path has no status-filter dropdown and no `linearProjectStatusFilterValue` equivalent (verified by grep). The bug is ClickUp-specific; the fix is confined to the ClickUp hierarchy handlers.

## Metadata

- **Tags:** bug, tickets-tab, clickup, webview, status-filter, planning-html
- **Complexity:** 3/10
- **Project:** switchboard
- **Files touched:** `src/webview/planning.js` (single file)
- **Risk:** Low — adds two variable resets to existing change handlers; no data-model or persistence-shape changes.

## Complexity Audit

**Routine.** The fix is a missing state reset in three existing event handlers. There is no new abstraction, no backend round-trip, and no schema change. The only subtlety is ensuring the dropdown's DOM-guard cache (`_lastTicketsClickUpStateFilterHtml`) is invalidated so the rebuilt options actually re-render with the reset value — but since `availableClickUpStatuses` is also cleared, the generated HTML will differ from the cached string and the guard already handles that.

## Edge-Case & Dependency Audit

- **Restoring hierarchy on tab re-entry:** `_restoringClickUpHierarchy` paths (lines 5442, 5473, 5510) re-select a list via `loadClickUpProject(false, clickUpSelectedListId)`. These rely on `saveTicketsState`/`restoreTicketsState` to repopulate `clickUpProjectStatusFilterValue` (line 10434). Resetting the filter inside the *user-driven* change handlers does not interfere with restore, because restore does not go through the `change` listeners — it sets state directly and calls `loadClickUpProject`. ✅ Safe.
- **Closed-status one-off import:** `_onClickUpStatusFilterChanged` (line 9850) triggers a `refreshTicketsDelta` with `includeClosed: true` when a closed status is selected. If the user had a closed status selected on List A and switches to List B, the stale value would also have caused a spurious closed-import on the next render. Resetting the filter prevents that side effect too. ✅ Bonus fix.
- **Persisted state:** `saveTicketsState()` is called at the end of each change handler. Resetting `clickUpProjectStatusFilterValue = ''` before `saveTicketsState()` ensures the persisted state no longer carries the stale value, so a reload after switching lists won't resurrect the bug. ✅
- **Dropdown DOM-guard:** `renderTicketsClickUpStatusFilterOptions` caches the last HTML in `_lastTicketsClickUpStateFilterHtml`. After reset, `clickUpProjectStatusFilterValue` is `''` and `availableClickUpStatuses` is `[]`, so the generated HTML is `<option value="">All statuses</option>` — which differs from the previous list's HTML and will re-render correctly. ✅
- **Space/folder changes that clear the list:** When the user picks a different space or folder, `clickUpSelectedListId` is set to `''` and no list loads. Resetting the filter here is harmless (no tasks to filter) and prevents the stale value from re-applying if the user later picks a list in the new space/folder. ✅

## Proposed Changes

### `src/webview/planning.js` — reset status filter in all three hierarchy change handlers

Add two resets — `clickUpProjectStatusFilterValue = ''` and `availableClickUpStatuses = []` — to each of the space, folder, and list `change` handlers, alongside the existing `clickUpProjectIssues = []` / `_resetSidebarDrillDown()` calls. Also invalidate the dropdown's DOM-guard cache so the rebuilt options re-render immediately.

#### 1. Space change handler (around line 9711)

```js
spaceSelect?.addEventListener('change', (e) => {
    _restoringClickUpHierarchy = false;
    const spaceId = e.target.value;
    clickUpSelectedSpaceId = spaceId;
    clickUpSelectedFolderId = '';
    clickUpSelectedListId = '';
    clickUpAvailableFolders = [];
    clickUpAvailableListsInFolder = [];
    clickUpAvailableDirectLists = [];
    clickUpProjectIssues = [];
    selectedClickUpIssue = null;
    _resetSidebarDrillDown();
    // Reset the status filter: the new space's lists have different statuses,
    // and a stale value would silently hide every task (the dropdown shows
    // "All statuses" but the JS variable kept the old selection).
    clickUpProjectStatusFilterValue = '';
    availableClickUpStatuses = [];
    _lastTicketsClickUpStateFilterHtml = '';
    if (spaceId) {
        // ... unchanged
```

#### 2. Folder change handler (around line 9758)

```js
folderSelect?.addEventListener('change', (e) => {
    _restoringClickUpHierarchy = false;
    const folderId = e.target.value;
    clickUpSelectedListId = '';
    clickUpAvailableListsInFolder = [];
    clickUpProjectIssues = [];
    selectedClickUpIssue = null;
    _resetSidebarDrillDown();
    clickUpProjectStatusFilterValue = '';
    availableClickUpStatuses = [];
    _lastTicketsClickUpStateFilterHtml = '';
    if (folderId) {
        // ... unchanged
```

#### 3. List change handler (around line 9807) — the primary fix

```js
listSelect?.addEventListener('change', (e) => {
    _restoringClickUpHierarchy = false;
    const listId = e.target.value;
    clickUpSelectedListId = listId;
    clickUpProjectLoading = false;
    clickUpProjectIssues = [];
    selectedClickUpIssue = null;
    _resetSidebarDrillDown();
    // The new list has its own status set. Drop the old filter so tasks are
    // not hidden by a status that no longer exists in this list.
    clickUpProjectStatusFilterValue = '';
    availableClickUpStatuses = [];
    _lastTicketsClickUpStateFilterHtml = '';
    saveTicketsState();
    if (listId) {
        // ... unchanged
```

### Why reset `availableClickUpStatuses` too

`clickupProjectLoaded` already sets `availableClickUpStatuses = []` before re-requesting statuses (line 5534), so clearing it in the handlers is strictly defensive: it prevents `renderTicketsClickUpStatusFilterOptions` from briefly rendering the *old* list's statuses in the gap between the user's selection and the `clickupProjectLoaded` message arriving. This avoids a flash of stale options and guarantees the dropdown rebuilds from the new list's statuses.

### Why invalidate `_lastTicketsClickUpStateFilterHtml`

The DOM-guard at line 9882 skips re-rendering when the generated HTML matches the cached string. After a list change with the resets applied, the new HTML is `<option value="">All statuses</option>` (empty status set). If the previous list happened to also have an empty status set at some point, the guard could theoretically skip the re-render. Clearing the cache forces a fresh render and a correct `clickUpStatusFilter.value = ''` assignment, which is the visible-state half of the fix.

## Verification Plan

1. **Reproduce the original bug first** (confirms the diagnosis):
   - Open the Tickets tab, select a ClickUp list that has a status named e.g. "In Progress".
   - Set the status filter dropdown to "In Progress" — the list filters to in-progress tasks.
   - Switch to a second ClickUp list whose statuses do **not** include "In Progress".
   - **Before fix:** the panel shows "No tasks found" while the dropdown reads "All statuses".
2. **Apply the fix** and reload the webview.
3. **Verify the fix:**
   - Repeat the reproduction steps. After switching lists, the panel should show all of List B's tasks (grouped by their own statuses), and the dropdown should read "All statuses" with List B's statuses populated once `clickupListStatusesLoaded` arrives.
4. **Closed-status regression check:**
   - On List A, select a closed/done status (triggers the one-off closed import).
   - Switch to List B. Confirm no spurious `refreshTicketsDelta` with `includeClosed: true` fires for List B, and List B's open tasks render normally.
5. **Space and folder change checks:**
   - With a status filter active on List A, change the **folder** (then **space**) dropdown. Confirm the panel clears cleanly, no stale status filter persists, and selecting a new list in the new space/folder renders its tasks without manual filter clearing.
6. **Persistence check:**
   - Switch lists (with a previously-active filter), then close and reopen the Tickets tab. Confirm the restored state has no stale status filter and the new list's tasks render.
7. **No-confirm rule:** This change adds no dialogs or confirm gates — compliant with the project's "NEVER add confirmation dialogs" rule.
