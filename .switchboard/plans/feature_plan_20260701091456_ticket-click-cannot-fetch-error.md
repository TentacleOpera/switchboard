# Clicking a Ticket Shows "Cannot Fetch Ticket" Error

## Goal

### Problem
When the user clicks a ticket card in the Tickets tab of `planning.html`, an error is surfaced (paraphrased by the user as "cannot fetch ticket"). This happens even though the local ticket file exists on disk and the ClickUp API token is configured. The error makes the user think the entire ticket fetch failed, even though the local description content is (or should be) available.

### Background Context
Clicking a ticket card (`planning.js` ~line 8168) triggers **two parallel backend messages** for an uncached/not-fully-fetched ticket:

1. `readLocalTicketFile` — fast local-file read for the description (`PlanningPanelProvider.ts` ~line 5453). On success, the webview handler (~line 4534) sets `selectedClickUpIssue`/`selectedLinearIssue` with `localDescription: true` and calls `renderTicketsTab()` to display the local markdown.
2. `linearLoadTaskDetails` / `clickupLoadTaskDetails` — live API fetch for comments/attachments (`PlanningPanelProvider.ts` ~line 4350 / ~line 4610). This is **supplementary** — its only purpose is to enrich the view with live comments and attachments. The description itself already comes from the local file.

The API fetch can fail for many reasons even when the token is configured: the task was deleted from the remote, a network timeout, rate limiting (429), a transient 5xx, or the token expired after initial setup. When it fails, the backend posts a `clickupError`/`linearError` message (scope `'task'`), which the webview routes to `showTicketsError(msg.error)` (~line 5280 / ~line 5293). This displays the raw API error text (e.g., `"Failed to fetch ClickUp task abc123: 404"`) in the `#tickets-status-footer` — a red, prominent-looking message at the bottom of the detail pane.

### Root Cause
The error is **not suppressed or contextualized when the local file was already successfully read.** The supplementary API fetch (comments/attachments only) fails, but its error is surfaced with the same prominence as a total fetch failure. Three compounding problems:

1. **No error clearing on local-file success.** The `localTicketFileRead` success handler (~line 4534) sets `selectedClickUpIssue` and renders the local content, but it **never clears** the `#tickets-status-footer`. If the `clickupError` arrives before or after the local content renders, the error text persists in the footer (auto-hiding after 4 seconds via `showTicketsStatus`'s timeout, but still visible long enough to confuse the user).

2. **No error clearing on API success.** The `clickupTaskDetailsLoaded` / `linearTaskDetailsLoaded` handlers (~line 5237 / ~line 5092) also **never clear** the footer. So a stale error from a previous failed fetch can persist even after a successful API load of a different ticket.

3. **The error message is not contextualized.** When the local file was successfully read (`selectedClickUpIssue?.localDescription === true`), the API fetch failure means only "comments/attachments unavailable" — not "cannot fetch ticket." But the raw error text (`"Failed to fetch ClickUp task ..."`) makes the user think the whole ticket failed to load.

A secondary issue (still worth fixing): if `readLocalTicketFile` returns `success: false` (file not found), the handler falls back to calling `loadClickUpTaskDetails`/`loadLinearTaskDetails` (~line 4537-4538), which sets `selectedClickUpIssue = null`, re-renders an empty pane, and sends a **second** API fetch — racing with the one the card-click handler already sent. This is not the user's scenario (their local files exist), but it compounds the error-surfacing problem for tickets without local files.

## Metadata
- **Tags:** tickets, error-handling, api-fetch, planning-webview, ux
- **Complexity:** 4/10

## Complexity Audit
**Complex.** The fix is primarily control-flow logic in the webview message handlers — suppressing/contextualizing the supplementary API fetch error when local content is already displayed, and clearing stale errors on success. No backend data-model changes. Risk is low-moderate: must ensure genuine errors (integration not configured, no local file AND API fails) still surface clearly.

## Edge-Case & Dependency Audit
- **Local file exists, API fails (the user's scenario):** Local content renders, but the API error appears in the footer. Fix: clear footer on local success + suppress/contextualize the API error.
- **No local file, API fails:** No content at all. The error MUST still surface clearly — this is a genuine total failure. Fix: only suppress the error when `selectedClickUpIssue?.localDescription === true`.
- **No local file, API succeeds:** Content loads from API. Fix: clear any stale footer error on API success.
- **Local file exists, API succeeds:** Best case — local description + live comments/attachments. Fix: clear any stale footer error on API success.
- **Subtask / parent navigation:** `loadLinearTaskDetails` / `loadClickUpTaskDetails` are called from subtask navigation (~line 8068, 8075) and parent navigation (~line 8387, 8395), where there is no accompanying `readLocalTicketFile`. These callers need the API fetch and its error to surface normally. The fix must only suppress errors when local content is already displayed, not in these paths.
- **`pendingClickUpDetailIssueId`:** The error handler clears this (line 5276). The fix should preserve this behavior.
- **Cached `detailsFetched` shortcut:** When a ticket is fully cached, neither `readLocalTicketFile` nor the API fetch is sent (line 8185/8200) — unaffected.
- **`showTicketsStatus` auto-hide:** The footer auto-hides after 4 seconds for all messages (line 555-557). Errors are not persistent, but 4 seconds is long enough to confuse the user.
- **`importTicketSubtasks`** (line 8218): sent alongside on first open — unaffected.

## Proposed Changes

### `src/webview/planning.js` — `localTicketFileRead` success handler (~line 4534)
Clear any prior error in the footer when the local file is successfully read. Also remove the redundant double-fetch fallback when `success: false` (the card-click handler already sent the API fetch in parallel).

**Before:**
```js
case 'localTicketFileRead': {
    if (!msg.success) {
        // No local file — fall back to live API fetch
        if (msg.provider === 'clickup') loadClickUpTaskDetails(msg.id);
        else loadLinearTaskDetails(msg.id);
        break;
    }
    // ... render local content ...
    renderTicketsTab();
    break;
}
```

**After:**
```js
case 'localTicketFileRead': {
    if (!msg.success) {
        // No local file — the card-click handler already dispatched a
        // parallel linearLoadTaskDetails / clickupLoadTaskDetails request
        // for comments/attachments. Do NOT fire a redundant second fetch.
        break;
    }
    // ... render local content ...
    // Clear any stale error from a previous/parallel failed API fetch —
    // the local description is already displayed, so a supplementary
    // API failure (comments/attachments only) is not a total failure.
    const { ticketsStatusFooter } = getTicketsTabElements();
    if (ticketsStatusFooter) {
        ticketsStatusFooter.textContent = '';
        ticketsStatusFooter.style.display = 'none';
    }
    renderTicketsTab();
    break;
}
```

### `src/webview/planning.js` — `clickupTaskDetailsLoaded` / `linearTaskDetailsLoaded` handlers (~line 5237 / ~line 5092)
Clear any prior error in the footer when the API fetch succeeds.

**Add at the end of each handler (before `break`):**
```js
// Clear any stale error footer — the API fetch succeeded
const { ticketsStatusFooter } = getTicketsTabElements();
if (ticketsStatusFooter) {
    ticketsStatusFooter.textContent = '';
    ticketsStatusFooter.style.display = 'none';
}
```

### `src/webview/planning.js` — `clickupError` handler, scope `task` (~line 5260)
When the API fetch fails but the local file was already successfully read (`selectedClickUpIssue?.localDescription === true`), suppress the prominent error and show a subtle, contextual message instead. When no local content is displayed, show the full error as before (genuine total failure).

**Before:**
```js
case 'clickupError': {
    switch (msg.scope) {
        case 'hierarchy':
            clickUpHierarchyLoading = false;
            break;
        case 'project':
            clickUpProjectLoading = false;
            clickUpProjectStatus = 'error';
            clickUpProjectMessage = msg.error || 'Failed to load tasks';
            break;
        case 'task':
            pendingClickUpDetailIssueId = '';
            break;
    }
    setTicketsLoadingState(false);
    showTicketsError(msg.error || 'ClickUp request failed');
    renderTicketsTab();
    break;
}
```

**After:**
```js
case 'clickupError': {
    switch (msg.scope) {
        case 'hierarchy':
            clickUpHierarchyLoading = false;
            break;
        case 'project':
            clickUpProjectLoading = false;
            clickUpProjectStatus = 'error';
            clickUpProjectMessage = msg.error || 'Failed to load tasks';
            break;
        case 'task':
            pendingClickUpDetailIssueId = '';
            break;
    }
    setTicketsLoadingState(false);
    // When the local file was already read, the API fetch is supplementary
    // (comments/attachments only). Its failure is not a total ticket-fetch
    // failure — show a subtle contextual message instead of the raw API error.
    if (msg.scope === 'task' && selectedClickUpIssue?.localDescription) {
        showTicketsStatus('Live comments/attachments unavailable', false);
    } else {
        showTicketsError(msg.error || 'ClickUp request failed');
    }
    renderTicketsTab();
    break;
}
```

### `src/webview/planning.js` — `linearError` handler, scope `task` (~line 5284)
Apply the same contextualization for Linear.

**Before:**
```js
case 'linearError': {
    switch (msg.scope) {
        case 'project':
            linearProjectLoading = false;
            linearProjectStatus = 'error';
            linearProjectMessage = msg.error || 'Failed to load issues';
            break;
    }
    setTicketsLoadingState(false);
    showTicketsError(msg.error || 'Linear request failed');
    renderTicketsTab();
    break;
}
```

**After:**
```js
case 'linearError': {
    switch (msg.scope) {
        case 'project':
            linearProjectLoading = false;
            linearProjectStatus = 'error';
            linearProjectMessage = msg.error || 'Failed to load issues';
            break;
    }
    setTicketsLoadingState(false);
    if (msg.scope === 'task' && selectedLinearIssue?.localDescription) {
        showTicketsStatus('Live comments/attachments unavailable', false);
    } else {
        showTicketsError(msg.error || 'Linear request failed');
    }
    renderTicketsTab();
    break;
}
```

> **Note:** The `linearError` handler currently doesn't have a `case 'task'` in its switch — the scope is only checked for `'project'`. The `msg.scope === 'task'` check in the conditional works regardless, since the backend sends `scope: 'task'` for task-detail failures (line 4355, 4384, 4412).

### `src/webview/planning.js` — `loadClickUpTaskDetails` / `loadLinearTaskDetails` (~line 9765 / ~line 9803)
Avoid blanking the selection and re-rendering an empty pane before the fetch completes. Only clear the selection if there is no existing cached partial detail to show. This prevents an empty-pane flash when the API fetch is a refetch (e.g., from subtask navigation) and there's already content displayed.

**Before (loadLinearTaskDetails):**
```js
function loadLinearTaskDetails(issueId) {
    if (!issueId) return;
    selectedLinearIssue = null;
    renderTicketsLinearPanel();
    vscode.postMessage({ type: 'linearLoadTaskDetails', issueId, workspaceRoot: ticketsWorkspaceRoot || undefined });
}
```

**After:**
```js
function loadLinearTaskDetails(issueId) {
    if (!issueId) return;
    // Keep any cached partial detail visible while refetching; only blank
    // if there is genuinely nothing to show (avoids an empty-pane flash).
    if (!linearIssueDetailCache.get(issueId)) {
        selectedLinearIssue = null;
        renderTicketsLinearPanel();
    }
    vscode.postMessage({ type: 'linearLoadTaskDetails', issueId, workspaceRoot: ticketsWorkspaceRoot || undefined });
}
```

Apply the analogous change to `loadClickUpTaskDetails` (~line 9803) using `clickUpTaskDetailCache`.

## Verification Plan
1. **The user's scenario (local file exists, API token configured, API call fails):**
   - Click a ticket whose local file exists but whose ClickUp API call fails (simulate by temporarily revoking the API token or blocking the network).
   - Confirm the local description renders immediately.
   - Confirm the footer shows a subtle "Live comments/attachments unavailable" message (non-error color), NOT a red "Failed to fetch ClickUp task ..." error.
   - Confirm the footer auto-hides after 4 seconds.
2. **No local file, API fails (genuine total failure):**
   - Click a ticket with no local file and a failing API.
   - Confirm the full error message appears in red (e.g., "Failed to fetch ClickUp task ...") — this is a real failure the user needs to see.
3. **No local file, API succeeds:**
   - Click a ticket with no local file but a working API.
   - Confirm the detail loads from the API and no error footer appears.
4. **Local file exists, API succeeds:**
   - Click a ticket with both local file and working API.
   - Confirm local description renders instantly, then comments/attachments supplement it.
   - Confirm no error footer appears.
5. **Stale error clearing:**
   - Click ticket A (API fails, subtle message shows). Then click ticket B (API succeeds).
   - Confirm ticket B's view has no stale error footer from ticket A.
6. **Subtask / parent navigation:**
   - Click a subtask and use "To parent task" — confirm the API fetch still fires and errors still surface normally (these paths don't go through `readLocalTicketFile`).
7. **Cached ticket:** Click a fully-cached ticket a second time — confirm no API fetch, no error, content displays immediately.
8. **No redundant double-fetch:** Click a ticket with no local file — confirm only ONE `clickupLoadTaskDetails` message is sent (not two).
9. **Toggle claudify/cyber themes** — confirm no visual regression in the footer.
