# Clicking a Ticket Shows "Cannot Fetch Ticket" Error

## Goal

### Problem
When the user clicks a ticket card in the Tickets tab of `planning.html`, an error is surfaced (paraphrased by the user as "cannot fetch ticket") instead of the ticket detail rendering reliably.

### Background Context
Clicking a ticket card (`planning.js` ~line 8168) triggers **two parallel backend messages** for an uncached/not-fully-fetched ticket:

1. `readLocalTicketFile` — fast local-file read for the description (`PlanningPanelProvider.ts` ~line 5453).
2. `linearLoadTaskDetails` / `clickupLoadTaskDetails` — live API fetch for comments/attachments (`PlanningPanelProvider.ts` ~line 4350 / ~line 4610).

If the local file read fails (`success: false`), the `localTicketFileRead` webview handler (~line 4534) **falls back** by calling `loadLinearTaskDetails(msg.id)` / `loadClickUpTaskDetails(msg.id)` — which sets `selectedLinearIssue = null` / `selectedClickUpIssue = null`, re-renders, and sends **another** `linearLoadTaskDetails` / `clickupLoadTaskDetails` message. This means up to **two concurrent API fetches** are in flight for the same ticket.

### Root Cause
The error the user sees is the backend API fetch failing. The backend handlers post a `linearError` / `clickupError` message (scope `'task'`) on failure, which the webview routes to `showTicketsError(msg.error || 'ClickUp request failed' / 'Linear request failed')` (~line 5280 / ~line 5293), displayed in the `#tickets-status-footer`. The backend failure conditions are:

- **`clickupLoadTaskDetails`** (~line 4610): throws `'No workspace folder found'` if `_resolveWorkspaceRoot` returns null; or `clickUp.getTaskDetails(taskId)` throws — most commonly `'ClickUp not configured'` (`ClickUpSyncService.ts` line 1220, when `config?.setupComplete` is false) or `'Failed to fetch ClickUp task <id>: <status>'` (line 1233, non-200 HTTP).
- **`linearLoadTaskDetails`** (~line 4350): throws `'Select a Linear issue first.'` if `workspaceRoot` or `issueId` is empty; or `linear.getIssue(issueId)` throws `'Linear not configured'` (`LinearSyncService.ts` line 890, when `config?.setupComplete || !config.teamId`); or returns `null` → `'Linear issue <id> was not found.'`.

The **most likely trigger** is the **double-fetch race + the `readLocalTicketFile` fallback**. When no local ticket file exists yet (the ticket was never imported/saved locally), `readLocalTicketFile` returns `success: false`, and the fallback calls `loadClickUpTaskDetails`/`loadLinearTaskDetails` — firing a **second** API request on top of the one the card-click handler already sent. If the integration is not fully configured (token expired, no `setupComplete`, no `teamId`), or the API returns an error, **both** fetches fail and the error is shown. Even when configured, the redundant second fetch wastes a round-trip and can surface a transient error that would otherwise have been superseded by the first fetch's success.

A secondary contributor: `loadClickUpTaskDetails` / `loadLinearTaskDetails` set `selectedClickUpIssue = null` / `selectedLinearIssue = null` and re-render **before** sending the message, so the user briefly sees an empty detail pane followed by the error — making the failure more visible than it needs to be.

## Metadata
- **Tags:** tickets, error-handling, race-condition, api-fetch, planning-webview
- **Complexity:** 4/10

## Complexity Audit
**Complex.** The fix is primarily control-flow logic in the webview message handler — eliminating the redundant double-fetch and improving error surfacing. No backend data-model changes. Risk is low-moderate: must ensure the local-file-fallback still works when the card-click API fetch is suppressed, and that legitimate errors still surface.

## Edge-Case & Dependency Audit
- **Card-click already sends the API fetch:** The fallback in `localTicketFileRead` must NOT re-send the same message when the card-click handler already did. The card-click path (~line 8195-8211) sends `readLocalTicketFile` AND `linearLoadTaskDetails`/`clickupLoadTaskDetails` together. So when `readLocalTicketFile` fails, the API fetch is already in flight — the fallback is redundant.
- **Subtask / parent navigation paths:** `loadLinearTaskDetails` / `loadClickUpTaskDetails` are also called from subtask navigation (~line 8068, 8075) and parent navigation (~line 8387, 8395), where there is **no** accompanying `readLocalTicketFile`. These callers still need the API fetch. The fix must only suppress the fallback inside the `localTicketFileRead` handler, not these other callers.
- **`pendingClickUpDetailIssueId` / `pendingLinearDetailIssueId`:** The error handler clears `pendingClickUpDetailIssueId` (line 5276). A double-fetch can clear this prematurely. Deduplicating removes the race.
- **Cached `detailsFetched` shortcut:** When a ticket is fully cached, neither `readLocalTicketFile` nor the API fetch is sent (line 8185/8200) — unaffected.
- **`importTicketSubtasks`** (line 8218): sent alongside on first open — unaffected by this fix.
- **Genuine "not configured" errors:** If the integration genuinely isn't configured, the user still needs a clear message. The fix should surface a single, clear error rather than two overlapping ones.

## Proposed Changes

### `src/webview/planning.js` — `localTicketFileRead` handler (~line 4534)
Remove the redundant API-fetch fallback. The card-click handler already sends `linearLoadTaskDetails` / `clickupLoadTaskDetails` in parallel with `readLocalTicketFile`. When the local file is missing, the in-flight API fetch will deliver the detail (or the error) — no second fetch is needed.

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
```

**After:**
```js
case 'localTicketFileRead': {
    if (!msg.success) {
        // No local file — the card-click handler already dispatched a
        // parallel linearLoadTaskDetails / clickupLoadTaskDetails request
        // for comments/attachments. Do NOT fire a redundant second fetch
        // (it races with the first and double-surfaces errors).
        break;
    }
    // ... render local content ...
```

> **Caveat for non-card-click callers:** If any other code path sends `readLocalTicketFile` **without** a parallel API fetch and relies on the fallback, this change would break it. A grep confirms `readLocalTicketFile` is only sent from the card-click handler (~line 8195/8210) — so the fallback is safe to remove. If future callers are added, they should send their own API-fetch message explicitly.

### `src/webview/planning.js` — `loadClickUpTaskDetails` / `loadLinearTaskDetails` (~line 9765 / 9803)
Avoid blanking the selection and re-rendering an empty pane before the fetch completes, which makes the error state more jarring. Only clear the selection if there is no existing cached partial detail to show.

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
    // if there is genuinely nothing to show (avoids an empty-pane flash
    // before the error/success arrives).
    if (!linearIssueDetailCache.get(issueId)) {
        selectedLinearIssue = null;
        renderTicketsLinearPanel();
    }
    vscode.postMessage({ type: 'linearLoadTaskDetails', issueId, workspaceRoot: ticketsWorkspaceRoot || undefined });
}
```

Apply the analogous change to `loadClickUpTaskDetails` (~line 9803) using `clickUpTaskDetailCache`.

### `src/webview/planning.js` — error handlers (~line 5260 / 5284)
Make the error message more actionable so the user can distinguish "not configured" from "network/transient". The backend already sends specific messages (`'ClickUp not configured'`, `'Linear not configured'`, `'No workspace folder found'`); ensure these surface verbatim rather than being masked by the generic fallback. The current code already uses `msg.error || 'ClickUp request failed'`, so the specific message is preserved — **no change needed** as long as the backend sends `error`. Confirm the backend `clickupError`/`linearError` posts always include `error` for scope `'task'` (they do: lines 4616, 4648, 4358, 4387, 4415).

Optional polish: only show the task-scope error if no detail is currently displayed (avoid overwriting a successfully rendered local-file detail with a stale API error from a redundant fetch). After the double-fetch fix above this is less critical, but as a guard:

```js
case 'clickupError': {
    switch (msg.scope) {
        // ... existing cases ...
        case 'task':
            pendingClickUpDetailIssueId = '';
            // Only clobber the detail pane if nothing is shown yet
            if (!selectedClickUpIssue) {
                setTicketsLoadingState(false);
                showTicketsError(msg.error || 'ClickUp request failed');
            }
            renderTicketsTab();
            break;
    }
    // ... (remove the unconditional showTicketsError at function level for task scope)
}
```

Apply analogously to `linearError`. (Keep the unconditional `showTicketsError` for `hierarchy`/`project` scopes.)

## Verification Plan
1. **Reproduce the original error:** With the integration misconfigured (e.g., expired token or `setupComplete` false), click a ticket — confirm a **single** clear error appears (e.g. "ClickUp not configured"), not a double error or empty-pane flash.
2. **No local file, configured integration:** Click a ticket that has never been imported locally — confirm the detail (description + comments + attachments) loads via the single API fetch with no redundant second request (verify in the browser devtools network/message log that only one `clickupLoadTaskDetails`/`linearLoadTaskDetails` is sent).
3. **Local file exists:** Click an imported ticket — confirm the local description renders instantly and the API fetch supplements comments/attachments without error.
4. **Cached ticket:** Click a fully-cached ticket a second time — confirm no API fetch is sent (existing shortcut) and no error.
5. **Subtask / parent navigation:** Click a subtask and use "To parent task" — confirm the API fetch still fires (these paths don't go through `readLocalTicketFile` and must still fetch).
6. **Transient network failure:** Simulate a non-200 API response — confirm the error message surfaces once and the loading state clears (no stuck spinner).
7. **Workspace not selected:** With no workspace root chosen, click a ticket — confirm "No workspace folder found" appears clearly.
8. Toggle claudify/cyber themes — confirm no visual regression in the error footer.
