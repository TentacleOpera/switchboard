# Tickets Panel: Seven Stub/Missing Functions Never Ported from planning.js

## Goal

Port seven functions that were left as stubs or missing entirely when the Tickets panel was extracted from `planning.js` into `tickets.js`. Each has a real implementation in `planning.js` that was never copied across. All seven are in the "2c slice" of the extraction, which was partially completed — some 2c functions were ported, these were not.

### Problem analysis

The extraction moved the Tickets surface from `src/webview/planning.js` into `src/webview/tickets.js` in labeled "slices" (2a, 2b, 2c, 2d, 2e, 2f). The 2c slice was supposed to port the card-click handler, drill-down logic, file poll, priority popover, and load-more pagination. It partially completed — the card renderers and list renderers were ported — but seven functions were left as explicit `/* 2c stub */` no-ops or missing entirely.

The stubs are labeled in the code. A `grep -n "stub" src/webview/tickets.js` finds them. They were never replaced because the extraction was abandoned mid-slice.

### Root cause

A file-to-file port preserves text but not wiring. The extraction tracked "which functions to port" via slice comments, but no gate checked that every function called in `tickets.js` was actually defined in `tickets.js`. The stubs exist so the panel renders without `ReferenceError`, but they silently disable the features they implement.

## Metadata

- **Complexity:** 4
- **Tags:** bugfix, ui, reliability
- **Project:** Browser Switchboard

## Proposed Changes

Port each function verbatim from `planning.js` into `tickets.js`, replacing the stub. All seven are self-contained — they call only functions already ported in earlier slices or globals already available.

### 1. `_maybeEnterDrillDown` (tickets.js:3391 → planning.js:8047)

**Impact:** Subtask drill-down is dead. Clicking a parent ticket card calls this function (tickets.js:5058, 5072) and `clickupTaskDetailsLoaded` calls it (7170). All calls are no-ops. The sidebar never shows the isolated parent+subtasks list.

**Fix:** Replace the stub body with the real implementation from `planning.js:8047-8061`. The function checks `_pendingDrillDownParentId`, looks up the cached detail, and sets `_sidebarDrillDownParentId`/`_drillDownSubtasks`/`_drillDownProvider`/`_drillDownParentTitle` when subtasks exist.

### 2. `loadMoreClickUpTasks` (tickets.js:3392 → planning.js:8768)

**Impact:** ClickUp "Load more" pagination is dead. The button (tickets.js:4753) is wired to the stub → dead click.

**Fix:** Replace the stub body with the real implementation from `planning.js:8768`. The function increments the page counter and posts `clickupLoadProject` with the next page number.

### 3. `_startTicketsFilePoll` (MISSING → planning.js:1543)

**Impact:** The 4-second file poll that auto-refreshes the selected ticket's content was never ported. The provider watcher (`ticketFileChanged`) covers the primary case, but the poll was defence-in-depth for catching external file changes that the watcher might miss.

**Fix:** Add the function from `planning.js:1543-1548`. It sets a 4s `setInterval` that calls `_refreshSelectedTicketFromFile()` when the Tickets tab is active.

### 4. `_stopTicketsFilePoll` (tickets.js:3390 + 4092 → planning.js:1550)

**Impact:** The stop function is a stub (defined twice — at 3390 and 4092, both no-ops). Paired with #3 — there's no poll to stop, but once #3 is ported, this needs to clear the interval.

**Fix:** Replace BOTH stub definitions with the real implementation from `planning.js:1550-1552`. Remove the duplicate at 4092 (keep only one).

### 5. `outsideClickPriorityClose` (MISSING → planning.js:1059)

**Impact:** `ReferenceError` when the priority popover opens. `tickets.js:3129` does `document.addEventListener('click', outsideClickPriorityClose)` — `outsideClickPriorityClose` is not defined → the addEventListener call throws, and the popover opens but can never be closed by clicking outside.

**Fix:** Add the function from `planning.js:1059-1064`. It checks whether the click target is outside the popover and outside the priority dot, and calls `closePriorityPopover()`.

### 6. `escPriorityClose` (MISSING → planning.js:1066)

**Impact:** `ReferenceError` when the priority popover opens. `tickets.js:3130` does `document.addEventListener('keydown', escPriorityClose)` — `escPriorityClose` is not defined → same failure as #5.

**Fix:** Add the function from `planning.js:1066-1070`. It checks for `Escape` key and calls `closePriorityPopover()`.

### 7. `closePriorityPopover` (tickets.js:584 → planning.js:1072)

**Impact:** The tickets.js version is a simplified stub — it hides the popover and clears `_openPriorityPopoverFor` but does NOT call `removeEventListener` for the click/keydown/scroll listeners. Once #5 and #6 are ported, the listeners are added but never removed → they leak and fire on every subsequent click/keypress.

**Fix:** Replace the simplified body (tickets.js:584-590) with the full implementation from `planning.js:1072-1083`. The full version calls `document.removeEventListener('click', outsideClickPriorityClose)`, `document.removeEventListener('keydown', escPriorityClose)`, and `container.removeEventListener('scroll', closePriorityPopover)`.

## Verification Plan

1. `grep -n "stub\|2c stub" src/webview/tickets.js` — must return zero results.
2. `grep -n "function _maybeEnterDrillDown\|function loadMoreClickUpTasks\|function _startTicketsFilePoll\|function _stopTicketsFilePoll\|function outsideClickPriorityClose\|function escPriorityClose" src/webview/tickets.js` — must return 6 results (one per function, `_stopTicketsFilePoll` only once).
3. Open the Tickets tab, click a parent ticket with subtasks → sidebar must show the drill-down subtask list with a "back" header.
4. Open the Tickets tab with ClickUp, scroll to the bottom of a list with more than one page → "Load more" button must fetch the next page.
5. Open a ticket, click the priority dot → popover opens. Click outside → popover closes. Press Escape → popover closes. Click another priority dot → first popover closes, second opens.
6. `git status` — only `src/webview/tickets.js` modified.

## Review Findings

**Reviewer pass (in-place).** Six of seven functions were correctly ported verbatim from `planning.js`; the seventh (`_startTicketsFilePoll`, function #3) was missing entirely and was added during review. Files changed: `src/webview/tickets.js` (reviewer added `_startTicketsFilePoll` at line 3406, `pagehide`/`beforeunload` cleanup listeners at line 7841, and updated the stale "Remaining stubs" comment). The diff also contains extra scope from other plans (progressive subtask import removal, `+ Subtask` overflow menu, `ticketsSourceHierarchyMissing` catch-up, Move handler refactor to document level, deleted-ticket ghost removal, `openCreateSubtaskModal` extraction) — these are functionally correct and introduce no regressions but were not part of this plan. Verification: `grep "2c stub"` returns zero results, function count is 6/6, `_stopTicketsFilePoll` defined once, compilation passes, all tickets contract tests pass (subtasks, verb-engine-tickets, sidebar-scoping, delta-sweep-gate, cross-panel-scope, assignee-filter). Remaining risk: `_startTicketsFilePoll` is defined but never called (same as in `planning.js` — dead code in both files); the `pagehide`/`beforeunload` listeners are now in place if a call site is later wired.
