# Tickets: stale doc preview when switching list/project

**Plan ID:** d4e5f6a7-b8c9-0d1e-2f3a-4b5c6d7e8f9a

## Goal

### Problem
In the **Tickets tab** of `planning.html`, when the user switches to a new list (ClickUp) or project (Linear), the previously-viewed ticket remains rendered in the **doc preview area** even though the sidebar (ticket list) is now empty/loading. The preview should reset to the empty state when the underlying list context changes, because the displayed ticket no longer belongs to the visible list.

### Background context
The Tickets tab has two panes:
- **Sidebar** — the ticket list (`issuesContainer`), rendered by `renderTicketsLinearList()` / `renderTicketsClickUpList()`.
- **Doc preview area** — the detail pane (`markdown-preview-tickets` / `detailContent`), rendered by `renderTicketsLinearTaskDetail()` (`:9161`) / `renderTicketsClickUpTaskDetail()` (`:9690`).

The detail render functions only clear the preview when the module-level selection variable (`selectedLinearIssue` / `selectedClickUpIssue`) is `null`. If it is still set, they re-render the old ticket's description, status select, subtask nav, comments, and meta bar.

### Root cause
The list/project **change handlers** update the list id and re-render the sidebar, but they **never null out the selection**:

- Linear project picker `change` — `src/webview/planning.js:8023-8041` sets `linearProjectPickerValue`, calls `renderTicketsLinearList()`, sends `refreshTicketsDelta` (lines 8033-8040), but does not touch `selectedLinearIssue`.
- ClickUp list-select `change` — `src/webview/planning.js:9519-9545` sets `clickUpSelectedListId`, clears `clickUpProjectIssues = []`, and calls `loadClickUpProject()`, but does not touch `selectedClickUpIssue`.
- ClickUp space-select (`:9426-9468`) and folder-select (`:9471-9516`) `change` handlers likewise clear `clickUpProjectIssues` but leave `selectedClickUpIssue` set.

Because the selection survives the context switch, the subsequent `renderTicketsLinearPanel()` (`:8659-8660`, calls both list + detail) / `renderTicketsClickUpPanel()` call into the detail renderer with a non-null selection, so the old ticket stays on screen while the sidebar shows the new (possibly empty/loading) list.

Note: the `linearProjectLoaded` / `clickupProjectLoaded` message handlers (lines 5059, 5250) also do not clear the selection — but those fire on **refresh** of the *same* list, where preserving the selection is desirable. The correct fix point is therefore the **user-initiated context-switch handlers**, not the load-complete handlers.

### Correction (verified 2026-07-02)
The original plan stated the Linear picker "only does `linearProjectPickerValue = e.target.value; renderTicketsLinearList(); saveTicketsState()`" — this was based on outdated code. The picker **already** sends `refreshTicketsDelta` with `projectId` (lines 8033-8040). However, the fix is still correct: the picker sends the import message but does not null `selectedLinearIssue`, so the stale preview persists until the import completes and a full panel render occurs.

## Metadata
- **Tags:** bugfix, ui
- **Complexity:** 3/10

## User Review Required
None. The fix is a minimal state reset in existing event handlers — null the selection variable and call `_resetSidebarDrillDown()` on user-initiated context switches. No judgment calls needed.

## Complexity Audit

### Routine
- Nulling `selectedLinearIssue` / `selectedClickUpIssue` in change handlers (one line per handler)
- Calling `_resetSidebarDrillDown()` in change handlers (one line per handler)
- Calling `renderTicketsLinearTaskDetail()` explicitly in the Linear handler to clear preview immediately

### Complex / Risky
- None. The fix is small, localized, and reuses existing patterns. The only risk (over-clearing on refresh) is avoided by scoping to user-initiated `change` handlers only.

## Edge-Case & Dependency Audit
- **Race Conditions**: None. The change handlers are synchronous user-initiated events.
- **Security**: No new surfaces.
- **Side Effects**: The Linear handler will render the detail pane twice — once immediately (to clear stale preview) and once when the `refreshTicketsDelta` import completes and triggers a full panel render. This is intentional and harmless: both renders show the empty state since `selectedLinearIssue` is null.
- **Dependencies & Conflicts**: None. This plan is self-contained within `planning.js`.
- **Refresh vs. switch:** The Refresh button (`:8061`) and the `*ProjectLoaded` handlers must continue to preserve the current selection (the ticket is still in the same list). The fix must NOT clear selection there.
- **Drill-down mode:** Switching list while inside a subtask drill-down should also reset drill-down state. `_resetSidebarDrillDown()` already exists (`:9015`) and is called by the status-filter handlers; the list/space/folder change handlers should call it too for consistency.
- **Edit mode:** If `ticketsEditMode` is true when the list changes, the detail renderer early-returns. Clearing the selection variable is still safe and correct — the edit guard is in the render path, not the state path. Exiting edit mode on a context switch is out of scope for this fix.
- **Detail cache:** `linearIssueDetailCache` / `clickUpTaskDetailCache` are keyed by id and are not list-scoped, so they do not need clearing on list switch. No change required.
- **Cross-provider:** Switching provider (Linear ↔ ClickUp) is handled elsewhere and already nulls both selections via `resetTicketsInMemoryState()` (`:10040-10077`, called at `:7671`). Not in scope.
- **Empty list-select value:** When the user picks the blank/"none" option in the ClickUp list-select, `listId` is falsy and the handler takes the `else` branch (`:9542`). The selection must still be cleared in this branch.

## Dependencies
- None. This plan is self-contained within `src/webview/planning.js`. No dependency on other plans in this epic.

## Adversarial Synthesis
Key risks: (1) the original plan incorrectly stated the Linear picker doesn't send `refreshTicketsDelta` — it does (lines 8033-8040); the fix is still correct because the picker doesn't null the selection. (2) The explicit `renderTicketsLinearTaskDetail()` call causes a double-render (immediate clear + eventual panel render on import complete) — harmless and intentional. Mitigations: fix scoped to user-initiated `change` handlers only; refresh/load-complete paths untouched; `_resetSidebarDrillDown()` reused from existing status-filter handlers.

## Proposed Changes

### File: `src/webview/planning.js`

#### 1. Linear project picker `change` handler (line 8023)
Clear the Linear selection and drill-down state before re-rendering the sidebar.

```js
projectPicker?.addEventListener('change', (e) => {
    linearProjectPickerValue = e.target.value;
    // Context switch: the previously-selected ticket belongs to the old project.
    // Drop it so the doc preview resets to the empty state instead of showing a
    // ticket that is no longer in the visible list.
    selectedLinearIssue = null;
    _resetSidebarDrillDown();
    renderTicketsLinearList();
    renderTicketsLinearTaskDetail();
    saveTicketsState();
    if (linearProjectPickerValue) {
        vscode.postMessage({
            type: 'refreshTicketsDelta',
            provider: 'linear',
            projectId: linearProjectPickerValue,
            workspaceRoot: ticketsWorkspaceRoot
        });
    }
});
```

> `renderTicketsLinearTaskDetail()` is called explicitly here because `renderTicketsLinearList()` only re-renders the sidebar; the panel-level `renderTicketsLinearPanel()` (which calls both) is not invoked by this handler. Calling the detail renderer directly ensures the preview pane is cleared immediately rather than waiting for the next full panel render. The `refreshTicketsDelta` message (lines 8033-8040) already exists in the current code — this change only adds the selection null + drill-down reset + explicit detail render.

#### 2. ClickUp list-select `change` handler (line 9519)
Clear the ClickUp selection and drill-down state in **both** branches.

```js
const listSelect = document.getElementById('tickets-list-select');
listSelect?.addEventListener('change', (e) => {
    _restoringClickUpHierarchy = false;
    const listId = e.target.value;
    clickUpSelectedListId = listId;
    clickUpProjectLoading = false;
    clickUpProjectIssues = [];
    // Context switch: drop the previously-viewed ticket so the doc preview
    // resets to the empty state instead of showing a ticket from the old list.
    selectedClickUpIssue = null;
    _resetSidebarDrillDown();
    saveTicketsState();
    if (listId) {
        const spaceName = clickUpAvailableSpaces.find(s => s.id === clickUpSelectedSpaceId)?.name || '';
        const folderName = clickUpAvailableFolders.find(f => f.id === clickUpSelectedFolderId)?.name || '';
        const availableLists = clickUpSelectedFolderId ? clickUpAvailableListsInFolder : clickUpAvailableDirectLists;
        const listName = availableLists.find(l => l.id === listId)?.name || '';
        vscode.postMessage({
            type: 'clickupSaveListSelection',
            spaceId: clickUpSelectedSpaceId,
            spaceName,
            folderId: clickUpSelectedFolderId,
            folderName,
            listId,
            listName,
            workspaceRoot: ticketsWorkspaceRoot || undefined
        });
        loadClickUpProject(false, listId); // sets status='loading' and re-renders panel (incl. detail)
    } else {
        renderTicketsClickUpPanel(); // re-renders list + detail; detail clears because selection is null
    }
});
```

> When `listId` is truthy, `loadClickUpProject()` calls `renderTicketsClickUpPanel()`, which invokes `renderTicketsClickUpTaskDetail()` — and since `selectedClickUpIssue` is now `null`, the detail pane clears. When `listId` is falsy, the explicit `renderTicketsClickUpPanel()` call does the same.

#### 3. ClickUp space-select and folder-select `change` handlers (~lines 9426-9516)
Apply the same two-line reset (`selectedClickUpIssue = null; _resetSidebarDrillDown();`) at the top of each handler body, immediately after the existing `clickUpProjectIssues = []` / `clickUpSelectedListId = ''` assignments. These handlers already call `renderTicketsClickUpPanel()` (directly or via `loadClickUpSpaces`), so the detail pane will clear on the next render.

For the **space-select** handler (`:9426`), add after the existing state resets:
```js
selectedClickUpIssue = null;
_resetSidebarDrillDown();
```

For the **folder-select** handler (`:9471`), add after `clickUpProjectIssues = []`:
```js
selectedClickUpIssue = null;
_resetSidebarDrillDown();
```

## Verification Plan

### Automated Tests
No automated tests run as part of this plan (session directive: skip tests). The test suite will be run separately by the user. Static check: `node -c src/webview/planning.js` for webview syntax.

### Manual
1. **ClickUp — switch to a new list with a ticket selected:**
   - Open the Tickets tab, select a ClickUp space/folder/list, click a ticket so its description shows in the preview.
   - Change the list dropdown to a different list.
   - **Expected:** sidebar shows the new list (or loading skeleton), and the doc preview area shows the empty state (`Select a ticket to preview` / `emptyPreview`), not the previous ticket.
2. **ClickUp — switch list to the blank/none option:**
   - With a ticket selected, pick the empty value in the list dropdown.
   - **Expected:** sidebar empties, preview resets to empty state.
3. **ClickUp — change space or folder with a ticket selected:**
   - With a ticket selected, change the space (or folder) dropdown.
   - **Expected:** preview resets to empty state; hierarchy reloads.
4. **Linear — switch project with a ticket selected:**
   - Open the Tickets tab with Linear as the provider, click a ticket so its description shows.
   - Change the project picker to a different project.
   - **Expected:** sidebar re-renders for the new project, preview resets to empty state.
5. **Regression — Refresh preserves selection:**
   - Select a ticket, then click the Refresh button (`:8061`).
   - **Expected:** the same ticket remains selected and visible in the preview after refresh completes (the fix does not touch the Refresh path or the `*ProjectLoaded` handlers).
6. **Regression — drill-down reset:**
   - Enter subtask drill-down for a parent ticket, then switch list.
   - **Expected:** drill-down mode exits and the preview resets to empty (no orphaned subtask nav).

> **Session directives:** No compilation step is run as part of verification (project assumed pre-compiled; `src/` is source of truth, `dist/` irrelevant). No automated tests run here.

**Recommendation**: Complexity 3/10 → Send to Intern. Small, localized state reset in existing event handlers, no new abstractions.
