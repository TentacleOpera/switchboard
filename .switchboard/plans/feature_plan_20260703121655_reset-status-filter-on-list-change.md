# Reset ClickUp status filter when the source list changes

## Goal

In the planning.html **Tickets tab**, when a user switches the ClickUp list (or any ancestor in the Space → Folder → List hierarchy), the tickets list renders empty if the newly-selected list does not share the same status set as the previously-selected list — even though the status-filter dropdown visually reads "All statuses".

### Problem analysis & root cause

The ClickUp tickets tab maintains two pieces of state that drive the status filter:

- `clickUpProjectStatusFilterValue` (line 291) — the currently-selected status string (e.g. `"In Progress"`), persisted across renders and into `saveTicketsState()` (line 10291).
- `availableClickUpStatuses` (line 307) — the status set for the *currently-loaded list*, refreshed asynchronously via the `clickupLoadListStatuses` message after `clickupProjectLoaded` fires (lines 5406–5408).

The three hierarchy change handlers — **space** (line 9584), **folder** (line 9631), and **list** (line 9681) — each reset `clickUpSelectedListId`, `clickUpProjectIssues`, `selectedClickUpIssue`, and call `_resetSidebarDrillDown()`, but **none of them reset `clickUpProjectStatusFilterValue` or `availableClickUpStatuses`**.

The failure sequence on a list change:

1. User is on List A with status filter set to `"In Progress"` (a status that exists in List A).
2. User picks List B from the dropdown. `listSelect` change handler runs (line 9681): it clears `clickUpProjectIssues`, sets `clickUpSelectedListId = listId`, and calls `loadClickUpProject(false, listId)`. **`clickUpProjectStatusFilterValue` is left as `"In Progress"`.**
3. `clickupProjectLoaded` arrives (line 5398), populating `clickUpProjectIssues` with List B's tasks and clearing `availableClickUpStatuses = []` (line 5407) before re-requesting statuses for List B (line 5408).
4. `renderTicketsClickUpStatusFilterOptions()` (line 9739) rebuilds the `<select>` options from the new status set. Because `"In Progress"` is not among List B's statuses, the browser silently resets the `<select>`'s `.value` to `""` (the first option, "All statuses") — so the **dropdown visually shows "All statuses"**.
5. However, the JS variable `clickUpProjectStatusFilterValue` still holds `"In Progress"`. `renderTicketsClickUpStatusFilterOptions` then runs `clickUpStatusFilter.value = clickUpProjectStatusFilterValue || ''` (line 9758), which assigns a value that isn't a valid option — the DOM `.value` stays `""` but the JS variable is unchanged.
6. `getFilteredClickUpTasks()` (line 9763) applies `if (statusFilter && task.status !== statusFilter) return false;` (line 9768) using the stale `clickUpProjectStatusFilterValue = "In Progress"`. Every List B task has a different status, so **all tasks are filtered out** and the panel shows "No tasks found."

The visible state (dropdown says "All statuses") and the actual filter state (JS variable holds a stale status) are decoupled, which is what makes this bug confusing to a user: it looks like no filter is applied, yet nothing shows.

The same stale-filter hazard exists for the space and folder change handlers, since changing either of those also implicitly changes the active list.

> Note on Linear: the issue mentions "or its linear equivalent", but the Linear tickets path has no per-ticket status-filter dropdown and no `linearProjectStatusFilterValue` equivalent (verified by grep — Linear only has `linearProjectStateFilterValue`, a *project-picker* state filter at line 8192, which is a different control). The bug is ClickUp-specific; the fix is confined to the ClickUp hierarchy handlers.

## Metadata

- **Tags:** bugfix, frontend, ui
- **Complexity:** 3/10
- **Project:** switchboard
- **Files touched:** `src/webview/planning.js` (single file)
- **Risk:** Low — adds two variable resets + one cache invalidation to existing change handlers; no data-model or persistence-shape changes.

## User Review Required

No. The fix is a pure state-reset in three existing event handlers, fully verified against the current source. No product-scope change, no new UX, no confirmation dialogs. Safe to dispatch directly to a coder.

## Complexity Audit

### Routine
- Adding `clickUpProjectStatusFilterValue = ''` to three existing `change` handlers — single-file, localized.
- Adding `availableClickUpStatuses = []` to the same three handlers — defensive/cosmetic flash prevention (the `clickupProjectLoaded` handler already clears it at line 5407).
- Invalidating `_lastTicketsClickUpStateFilterHtml = ''` so the rebuilt dropdown re-renders with the reset value.
- Reuses existing patterns — no new abstraction, no backend round-trip, no schema change.

### Complex / Risky
- None.

## Edge-Case & Dependency Audit

- **Race Conditions:**
  - **Restore path:** `_restoringClickUpHierarchy` paths (lines 5315, 5346, 5383) re-select a list via `loadClickUpProject`. These rely on `saveTicketsState`/`restoreTicketsStateForRoot` to repopulate `clickUpProjectStatusFilterValue` (line 10307). Resetting the filter inside the *user-driven* change handlers does not interfere with restore, because restore does not go through the `change` listeners — it sets state directly and calls `loadClickUpProject`. ✅ Safe.
  - **Double-switch race:** If the user picks List B then immediately picks List C before B's `clickupListStatusesLoaded` arrives, a stale statuses-loaded message for B could theoretically populate `availableClickUpStatuses` with B's statuses after C is selected. However, `clickupProjectLoaded` for C clears `availableClickUpStatuses = []` (line 5407) and re-requests for C, so the window is self-correcting. No extra fix needed. ✅ Self-healing.

- **Security:** No security implications — purely client-side webview filter state. ✅

- **Side Effects:**
  - **Persisted state:** `saveTicketsState()` is called inside each change handler (space: lines 9599/9620; folder: lines 9643/9670; list: line 9689). Resetting `clickUpProjectStatusFilterValue = ''` *before* `saveTicketsState()` ensures the persisted state no longer carries the stale value, so a reload after switching lists won't resurrect the bug. ✅
  - **Closed-status dropdown behavior:** `_onClickUpStatusFilterChanged` (line 9723) triggers `refreshTicketsDelta` with `includeClosed: true` only when a closed status is selected *via an explicit dropdown `onchange` event* (lines 8200, 9759) — never via a re-render. A stale `clickUpProjectStatusFilterValue` does NOT trigger a spurious closed-import; its only harm is the silent filter-out in `getFilteredClickUpTasks` (line 9768), which is the core bug already addressed. (Earlier draft of this plan incorrectly claimed a "bonus" closed-import fix — that claim is retracted; the stale value has no such side effect.)

- **Dependencies & Conflicts:**
  - **Dropdown DOM-guard:** `renderTicketsClickUpStatusFilterOptions` caches the last HTML in `_lastTicketsClickUpStateFilterHtml` (line 9755). After reset, `clickUpProjectStatusFilterValue` is `''` and `availableClickUpStatuses` is `[]`, and `clickUpProjectIssues` is `[]`, so the generated HTML is `<option value="">All statuses</option>` — which differs from the previous list's HTML and will re-render correctly. Invalidation of the cache is cheap insurance against the rare case where a prior render produced that exact empty string (e.g. rapid double-switch before statuses load). ✅
  - **Space/folder changes that clear the list:** When the user picks a different space or folder, `clickUpSelectedListId` is set to `''` and no list loads. Resetting the filter here is harmless (no tasks to filter) and prevents the stale value from re-applying if the user later picks a list in the new space/folder. ✅

## Dependencies

- None. This is a standalone bugfix with no prerequisite plans or sessions.

## Adversarial Synthesis

**Risk Summary:** Key risks: stale line numbers could mislead a coder into patching the wrong functions (corrected — all references now match current source); a false "bonus closed-import fix" claim could mask the actual failure mode (retracted — the stale value's only harm is the silent filter-out). Mitigations: line numbers verified against `src/webview/planning.js` as of this review; the double-switch race is self-correcting via `clickupProjectLoaded`'s clear-and-re-request; the fix is three localized resets with no schema or persistence-shape change.

## Proposed Changes

### `src/webview/planning.js` — reset status filter in all three hierarchy change handlers

Add three resets — `clickUpProjectStatusFilterValue = ''`, `availableClickUpStatuses = []`, and `_lastTicketsClickUpStateFilterHtml = ''` — to each of the space, folder, and list `change` handlers, alongside the existing `clickUpProjectIssues = []` / `_resetSidebarDrillDown()` calls.

#### 1. Space change handler (line 9584)

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

#### 2. Folder change handler (line 9631)

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

#### 3. List change handler (line 9681) — the primary fix

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

`clickupProjectLoaded` already sets `availableClickUpStatuses = []` before re-requesting statuses (line 5407), so clearing it in the handlers is strictly **cosmetic/defensive**: it prevents `renderTicketsClickUpStatusFilterOptions` from briefly rendering the *old* list's statuses in the gap between the user's selection and the `clickupProjectLoaded` message arriving. This avoids a flash of stale options. It is not load-bearing — the bug fix works without it — but it produces a cleaner visual transition.

### Why invalidate `_lastTicketsClickUpStateFilterHtml`

The DOM-guard at line 9755 skips re-rendering when the generated HTML matches the cached string. After a list change with the resets applied, both `availableClickUpStatuses` and `clickUpProjectIssues` are empty, so the new HTML is `<option value="">All statuses</option>`. If the previous render happened to produce that exact string (e.g. a rapid double-switch before statuses loaded), the guard could skip the re-render. Clearing the cache forces a fresh render and a correct `clickUpStatusFilter.value = ''` assignment, which is the visible-state half of the fix. Cheap insurance.

## Verification Plan

### Automated Tests

Skipped per session directive. This is a webview UI state-reset fix; verification is manual via the steps below. (No project compilation step is run per session directive either — `src/` is the source of truth.)

### Manual Verification

1. **Reproduce the original bug first** (confirms the diagnosis):
   - Open the Tickets tab, select a ClickUp list that has a status named e.g. "In Progress".
   - Set the status filter dropdown to "In Progress" — the list filters to in-progress tasks.
   - Switch to a second ClickUp list whose statuses do **not** include "In Progress".
   - **Before fix:** the panel shows "No tasks found" while the dropdown reads "All statuses".
2. **Apply the fix** and reload the webview.
3. **Verify the fix:**
   - Repeat the reproduction steps. After switching lists, the panel should show all of List B's tasks (grouped by their own statuses), and the dropdown should read "All statuses" with List B's statuses populated once `clickupListStatusesLoaded` arrives.
4. **Space and folder change checks:**
   - With a status filter active on List A, change the **folder** (then **space**) dropdown. Confirm the panel clears cleanly, no stale status filter persists, and selecting a new list in the new space/folder renders its tasks without manual filter clearing.
5. **Persistence check:**
   - Switch lists (with a previously-active filter), then close and reopen the Tickets tab. Confirm the restored state has no stale status filter and the new list's tasks render.
6. **Double-switch race check (optional):**
   - Rapidly switch List A → List B → List C before B's statuses load. Confirm List C's statuses and tasks render correctly (the `clickupProjectLoaded` clear-and-re-request self-corrects).
7. **No-confirm rule:** This change adds no dialogs or confirm gates — compliant with the project's "NEVER add confirmation dialogs" rule.

## Recommendation

Complexity 3/10 → **Send to Intern**. Single-file, three handlers, two resets + one cache invalidation. Line numbers verified against current source. No research needed — all claims confirmed by reading `src/webview/planning.js`.
