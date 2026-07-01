# Clicking a Ticket Shows "Cannot Fetch Ticket" Error

## Goal

Surface clear, actionable, user-friendly error messages when a ClickUp/Linear ticket-detail fetch fails in the Tickets tab, and ensure supplementary API failures (comments/attachments) are not presented as total failures when the local description is already displayed.

### Problem
When the user clicks a ticket card in the Tickets tab of `planning.html`, an error is surfaced. The current error text is a raw, confusing string like `"Failed to fetch ClickUp task abc123def456: 401"` — it exposes internal task IDs and HTTP status codes with no explanation of **why** the fetch failed or **what the user should do**. The user has no way to tell whether:
- Their API token is expired/invalid (401)
- The ticket was deleted from the remote (404)
- There's a network issue (timeout / 5xx)
- The integration was never configured
- The failure is supplementary (comments/attachments only) vs. total (no content at all)

This happens even when the local ticket file exists on disk and the ClickUp API token was configured at setup time — because the token may have expired or been regenerated since setup.

### Background Context
Clicking a ticket card (`planning.js` ~line 8168) triggers **two parallel backend messages**:

1. `readLocalTicketFile` — fast local-file read for the description (`PlanningPanelProvider.ts` ~line 5453). On success, the webview handler (~line 4534) sets `selectedClickUpIssue`/`selectedLinearIssue` with `localDescription: true` and renders the local markdown.
2. `linearLoadTaskDetails` / `clickupLoadTaskDetails` — live API fetch for comments/attachments (`PlanningPanelProvider.ts` ~line 4350 / ~line 4610). This is **supplementary** — the description already comes from the local file.

When the API fetch fails, the backend posts a `clickupError`/`linearError` message (scope `'task'`) with the raw error string. The webview routes this to `showTicketsError(msg.error)` (~line 5280 / ~line 5293), which displays it in red in the `#tickets-status-footer`.

### Root Cause
Two layers of problems:

**1. Backend produces cryptic error messages.** The sync services throw raw errors that expose internal IDs and HTTP codes:
- ClickUp `getTaskDetails` (`ClickUpSyncService.ts` line 1233): `throw new Error('Failed to fetch ClickUp task ${normalizedTaskId}: ${taskResult.status}')` → user sees `"Failed to fetch ClickUp task abc123def456: 401"`.
- ClickUp `httpRequest` (line 2241): `throw new Error('ClickUp API token not configured')` — at least clear, but doesn't tell the user how to fix it.
- Linear `graphqlRequest` (line 1754): `throw new Error('Linear API HTTP ${res.statusCode}')` → user sees `"Linear API HTTP 401"`.
- Linear `getIssue` returns `null` → backend posts `"Linear issue <id> was not found."` — doesn't distinguish "deleted" from "never existed" from "token can't access it".

There is **no HTTP status code interpretation** — 401 (auth), 404 (not found), 429 (rate limit), and 500 (server) all produce the same generic format. Compare to the Linear setup flow (line 1910) which already has a clear message: `"Linear token is invalid. Get a valid token at linear.app/settings/api"`.

**2. Webview doesn't contextualize or clear errors.** 
- The `localTicketFileRead` success handler never clears the footer — so a parallel API error persists even though local content rendered fine.
- The `clickupTaskDetailsLoaded` / `linearTaskDetailsLoaded` success handlers never clear the footer — stale errors from previous tickets persist.
- When local content is already displayed (`localDescription: true`), the API fetch failure means only "comments/attachments unavailable" — but the raw error makes the user think the whole ticket failed to load.
- If `readLocalTicketFile` returns `success: false`, the handler fires a **redundant second** API fetch (~line 4537-4538), racing with the one the card-click handler already sent. (Verified: the card-click handler at lines 8195-8196 / 8210-8211 ALWAYS dispatches the API fetch in parallel with `readLocalTicketFile`, and `readLocalTicketFile` is sent from NO other site in the codebase. So the fallback is always redundant.)

## Metadata
- **Tags:** frontend, backend, api, ux, bugfix, reliability
- **Complexity:** 5/10

## User Review Required
Yes — review the proposed error-message wording (especially the 404 "deleted ticket" warning vs. the "comments unavailable" supplementary message) and confirm the decision to **drop** the `loadLinearTaskDetails` / `loadClickUpTaskDetails` cache-guard change (see Adversarial Synthesis #3 — it was scope creep). Also confirm the decision to extract a shared `localizeHttpError` utility rather than duplicate it per service.

## Complexity Audit

### Routine
- Status-code → human-message mapping in a shared helper (well-precedented: `ClickUpDocsAdapter.ts` line 57 already does this).
- Rewriting the Linear `getIssue` null message to drop the raw ID.
- Adding a `clearTicketsStatus()` webview helper and calling it in three success handlers.
- Removing the redundant double-fetch fallback in `localTicketFileRead` (verified safe — card-click always sends the API fetch in parallel; `readLocalTicketFile` has no other senders).

### Complex / Risky
- Correctly distinguishing a **deleted-ticket (404)** failure from a **supplementary (auth/network/rate-limit)** failure when local content is already shown. A 404 means the local file is a stale snapshot of a deleted ticket — this must surface as a visible warning, NOT a "comments unavailable" whisper. Requires the backend to send a `kind` field on task-scope errors so the webview can branch correctly.
- Ensuring genuine total failures (no local file + API failure) still surface clearly in red.
- Preserving the existing `pendingClickUpDetailIssueId` clear behavior (line 5276) and the loading-flag clears in the error handlers while adding the contextualization branch.

## Edge-Case & Dependency Audit
- **Race Conditions:** The `readLocalTicketFile` and `linearLoadTaskDetails`/`clickupLoadTaskDetails` messages race. The local read usually wins (fast). The API error can arrive before OR after the local success. The contextualization must check `selectedClickUpIssue?.localDescription` / `selectedLinearIssue?.localDescription` AT ERROR-ARRIVAL TIME — which correctly reflects whether local content is currently displayed. No additional synchronization needed.
- **Security:** Error messages must NOT expose raw internal task IDs or tokens. The new messages strip the task ID. No secrets are logged.
- **Side Effects:** `showTicketsStatus` (line 548) auto-hides the footer after 4 seconds via `window._ticketsFooterTimeout`. The new `clearTicketsStatus()` helper MUST clear this timeout (not just blank the DOM) or a stale timer can wipe a subsequent status message. The existing manual-clear blocks in the original plan bypassed the timeout — the helper fixes this.
- **Dependencies & Conflicts:**
  - `ClickUpDocsAdapter.ts` already has a `_localizeHttpError` (line 57) with a different signature (`context` prefix, `errorMessages` record). The shared utility must not break the adapter's existing call sites (lines 465, 606, 627, 679, 859, 880, 958). Either refactor the adapter to use the shared util, or keep the adapter's private method and only share between the two sync services. Recommendation: extract a shared `localizeHttpError(status, provider, action)` and refactor all three call sites.
  - Subtask / parent navigation (`loadLinearTaskDetails` / `loadClickUpTaskDetails` from lines 8068, 8075, 8387, 8395) does NOT send `readLocalTicketFile`, so `localDescription` is false there → full error surfaces normally. Correct.
  - Cached `detailsFetched` shortcut (line 8185/8200): neither fetch is sent → unaffected.
  - `isAvailable()` pre-check (ClickUp line 2381, Linear line 1795): not called before task-detail fetch. Prefer interpreting the status code from the existing fetch (no extra round-trip).
  - ClickUp `httpRequest` non-200 handling: returns `{ status, data }` without throwing; the caller checks `status !== 200` and throws. Status-code interpretation belongs at the caller (`getTaskDetails`), not in `httpRequest`.
  - Linear `graphqlRequest` also rejects on GraphQL-level errors (line 1759): `"Linear GraphQL error: ${parsed.errors[0].message}"`. Pass these through with light contextualization (treat as `kind: 'generic'`).
  - `pendingClickUpDetailIssueId` is cleared in the `clickupError` task branch (line 5276) — preserve. There is NO `pendingLinearDetailIssueId` (confirmed: only ClickUp has one), so nothing to preserve on the Linear side.

## Dependencies
- None. This plan is self-contained.

## Adversarial Synthesis
Key risks: (1) downgrading a 404 "deleted ticket" to a "comments unavailable" whisper when local content is shown — the local file is a stale snapshot and the user must be warned the remote is gone; (2) the new footer-clear logic fighting the existing 4-second auto-hide timer in `showTicketsStatus`; (3) triplicating the `_localizeHttpError` helper across services. Mitigations: backend sends a `kind` field (`'deleted'`/`'auth'`/`'transient'`/`'generic'`) on task-scope errors so the webview only shows the subtle supplementary message for non-deleted failures; add a single `clearTicketsStatus()` helper that clears the timeout; extract one shared `localizeHttpError` utility. The `loadLinearTaskDetails`/`loadClickUpTaskDetails` cache-guard change from the original draft is DROPPED as scope creep (it risked hiding the loading indicator during parent/subtask navigation).

## Proposed Changes

### `src/services/errorMessages.ts` — NEW shared utility
Extract a single status-code → message mapper used by both sync services (and optionally refactor `ClickUpDocsAdapter` to use it).

```ts
export type ErrorProvider = 'clickup' | 'linear';

export function localizeHttpError(status: number, provider: ErrorProvider, action: string): string {
    const setupHint = provider === 'clickup'
        ? 'Update it in the Setup tab (get a new token at app.clickup.com/settings → Apps).'
        : 'Update it in the Setup tab (get a new token at linear.app/settings/api).';
    switch (status) {
        case 401:
            return `${provider === 'clickup' ? 'ClickUp' : 'Linear'} API token is invalid or expired. ${setupHint}`;
        case 403:
            return `${provider === 'clickup' ? 'ClickUp' : 'Linear'} rejected the request: your token lacks permission to ${action}.`;
        case 404:
            return `This ticket no longer exists on ${provider === 'clickup' ? 'ClickUp' : 'Linear'}. It may have been deleted.`;
        case 429:
            return `${provider === 'clickup' ? 'ClickUp' : 'Linear'} rate limit reached — wait a moment and try again.`;
        case 500: case 502: case 503: case 504:
            return `${provider === 'clickup' ? 'ClickUp' : 'Linear'} server error (HTTP ${status}) — try again in a moment.`;
        case 0:
            return `Network error — could not reach ${provider === 'clickup' ? 'ClickUp' : 'Linear'}. Check your internet connection.`;
        default:
            return `Could not ${action} (HTTP ${status}).`;
    }
}

/** Classify a status code for webview contextualization. */
export function classifyHttpError(status: number): 'deleted' | 'auth' | 'transient' | 'generic' {
    if (status === 404) return 'deleted';
    if (status === 401 || status === 403) return 'auth';
    if (status === 429 || status === 0 || status >= 500) return 'transient';
    return 'generic';
}
```

### `src/services/ClickUpSyncService.ts` — `getTaskDetails` (~line 1232)
Replace the generic throw with the shared utility. Strip the raw task ID.

**Before:**
```ts
if (taskResult.status !== 200) {
    throw new Error(`Failed to fetch ClickUp task ${normalizedTaskId}: ${taskResult.status}`);
}
```

**After:**
```ts
if (taskResult.status !== 200) {
    throw new Error(localizeHttpError(taskResult.status, 'clickup', 'fetch this ticket from ClickUp'));
}
```

(Add `import { localizeHttpError } from './errorMessages';` at the top of the file.)

### `src/services/LinearSyncService.ts` — `graphqlRequest` (~line 1753)
Replace the generic throw with the shared utility.

**Before:**
```ts
if (res.statusCode !== 200) {
    return safeReject(new Error(`Linear API HTTP ${res.statusCode}`));
}
```

**After:**
```ts
if (res.statusCode !== 200) {
    return safeReject(new Error(localizeHttpError(res.statusCode, 'linear', 'fetch from Linear')));
}
```

(Add `import { localizeHttpError } from './errorMessages';` at the top of the file.)

### `src/services/PlanningPanelProvider.ts` — `linearLoadTaskDetails` null-result message (~line 4387)
Drop the raw issue ID; clarify the cause.

**Before:**
```ts
error: `Linear issue ${issueId} was not found.`,
```

**After:**
```ts
error: `This Linear issue could not be found. It may have been deleted, or your token may lack access to it.`,
kind: 'deleted',
```

### `src/services/PlanningPanelProvider.ts` — add `kind` to task-scope error posts
Every `clickupError` / `linearError` post with `scope: 'task'` that originates from a failed API fetch must include a `kind` field derived from the thrown error's HTTP status. The simplest approach: catch the error in the `linearLoadTaskDetails` / `clickupLoadTaskDetails` handlers, inspect the message for a status code, and call `classifyHttpError`. Alternatively, have the sync services throw a typed error carrying the status. Recommended minimal approach (in the catch block of the task-details handlers):

```ts
} catch (err: any) {
    const msg = err?.message || String(err);
    // Derive a status code from the message when possible; default to generic.
    const statusMatch = msg.match(/HTTP (\d{3})/);
    const kind = statusMatch ? classifyHttpError(Number(statusMatch[1])) : 'generic';
    this._panel?.webview.postMessage({
        type: 'linearError', // or 'clickupError'
        scope: 'task',
        issueId, // or taskId
        error: msg,
        kind,
        workspaceRoot
    });
}
```

(Add `import { classifyHttpError } from './errorMessages';`. Apply to both the ClickUp and Linear task-details catch blocks. The existing "Select a Linear issue first." guard error at line 4355 should use `kind: 'generic'`.)

### `src/webview/planning.js` — new `clearTicketsStatus()` helper (~line 558, after `showTicketsStatus`)
Add a helper that clears the footer AND cancels the pending auto-hide timer.

```js
function clearTicketsStatus() {
    const { ticketsStatusFooter } = getTicketsTabElements();
    if (window._ticketsFooterTimeout) {
        clearTimeout(window._ticketsFooterTimeout);
        window._ticketsFooterTimeout = null;
    }
    if (ticketsStatusFooter) {
        ticketsStatusFooter.textContent = '';
        ticketsStatusFooter.style.display = 'none';
    }
}
```

### `src/webview/planning.js` — `localTicketFileRead` success handler (~line 4534)
Clear any prior error on local success; remove the redundant double-fetch fallback on local failure (verified safe: card-click always dispatches the API fetch in parallel, and `readLocalTicketFile` has no other senders).

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
        // parallel linearLoadTaskDetails / clickupLoadTaskDetails request.
        // Do NOT fire a redundant second fetch.
        break;
    }
    // ... render local content ...
    // Clear any stale error — the local description is already displayed,
    // so a supplementary API failure is not a total failure.
    clearTicketsStatus();
    renderTicketsTab();
    break;
}
```

### `src/webview/planning.js` — `clickupTaskDetailsLoaded` / `linearTaskDetailsLoaded` handlers (~line 5237 / ~line 5092)
Clear any prior error when the API fetch succeeds.

**Add at the end of each handler (before `break`):**
```js
clearTicketsStatus();
```

### `src/webview/planning.js` — `clickupError` handler (~line 5260)
Contextualize task-scope errors. When local content is already displayed AND the failure is NOT a deleted-ticket (404) case, show a subtle supplementary message. When the failure is a deleted ticket (`kind === 'deleted'`) but local content is shown, show a visible warning that the remote is gone. When no local content is displayed, show the full (now user-friendly) error in red.

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
    if (msg.scope === 'task' && selectedClickUpIssue?.localDescription) {
        if (msg.kind === 'deleted') {
            // Local copy is a stale snapshot of a deleted ticket — warn visibly.
            showTicketsError('This ticket was deleted from ClickUp. Showing the local copy, which may be out of date.');
        } else {
            // Supplementary fetch (comments/attachments) failed — not a total failure.
            showTicketsStatus('Could not load live comments/attachments — ' + (msg.error || 'ClickUp unavailable'), false);
        }
    } else {
        showTicketsError(msg.error || 'ClickUp request failed');
    }
    renderTicketsTab();
    break;
}
```

### `src/webview/planning.js` — `linearError` handler (~line 5284)
Apply the same contextualization for Linear. (Note: the existing switch only handles `scope: 'project'`; the `scope: 'task'` branch is handled by the post-switch contextualization check, which is correct since Linear DOES send `scope: 'task'` errors from `PlanningPanelProvider.ts` lines 4355 and 4384.)

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
        if (msg.kind === 'deleted') {
            showTicketsError('This issue was deleted from Linear. Showing the local copy, which may be out of date.');
        } else {
            showTicketsStatus('Could not load live comments/attachments — ' + (msg.error || 'Linear unavailable'), false);
        }
    } else {
        showTicketsError(msg.error || 'Linear request failed');
    }
    renderTicketsTab();
    break;
}
```

### DROPPED: `loadLinearTaskDetails` / `loadClickUpTaskDetails` cache-guard
The original draft proposed guarding `selectedLinearIssue = null; renderTicketsLinearPanel()` behind a cache check in `loadLinearTaskDetails` (~line 9765) and `loadClickUpTaskDetails` (~line 9803). This is **dropped** as scope creep: it is not part of the reported error bug, and skipping the render for cached tickets would hide the loading indicator during subtask/parent navigation (lines 8068, 8075, 8387, 8395), confusing users. The core fix (error display) does not require this change.

## Verification Plan

### Automated Tests
Automated tests are SKIPPED per session directive. The test suite will be run separately by the user. No compilation step is run per session directive.

### Manual Verification
1. **The user's scenario (local file exists, expired token → 401):**
   - Click a ticket whose local file exists but whose ClickUp API token is expired (revoke/regenerate in ClickUp settings to simulate).
   - Confirm the local description renders immediately.
   - Confirm the footer shows a subtle (non-red) message: `"Could not load live comments/attachments — ClickUp API token is invalid or expired. Update it in the Setup tab (get a new token at app.clickup.com/settings → Apps)."` — NOT a red `"Failed to fetch ClickUp task abc123: 401"`.
2. **No local file, expired token (401):**
   - Click a ticket with no local file and an expired token.
   - Confirm the full error appears in red: `"ClickUp API token is invalid or expired. Update it in the Setup tab (get a new token at app.clickup.com/settings → Apps)."`
3. **Task deleted from remote (404), local file exists:**
   - Delete a task in ClickUp that has a local file; click it in the Tickets tab.
   - Confirm local content renders and footer shows a RED warning: `"This ticket was deleted from ClickUp. Showing the local copy, which may be out of date."` — NOT the subtle "comments unavailable" message.
4. **Task deleted from remote (404), no local file:**
   - Confirm the full error appears in red: `"This ticket no longer exists on ClickUp. It may have been deleted."`
5. **Rate limiting (429):**
   - Simulate rate limiting — confirm subtle message (with local file) or red message (without): `"ClickUp rate limit reached — wait a moment and try again."`
6. **Network timeout:**
   - Block network — confirm message: `"Network error — could not reach ClickUp. Check your internet connection."`
7. **Linear equivalents:** Repeat steps 1-6 for Linear issues — confirm analogous messages with `linear.app/settings/api` link, and that the 404-with-local-file case shows the red "deleted" warning.
8. **Stale error clearing:** Click ticket A (API fails, message shows). Click ticket B (API succeeds). Confirm ticket B's view has no stale error footer (the `clearTicketsStatus()` calls in the details-loaded handlers and `localTicketFileRead` success handler cover this).
9. **No redundant double-fetch:** Click a ticket with no local file — confirm only ONE `clickupLoadTaskDetails` message is sent (open devtools message inspector).
10. **Subtask / parent navigation:** Click a subtask and use "To parent task" — confirm the API fetch still fires and errors surface normally (full red error, since `localDescription` is false on these paths).
11. **Cached ticket:** Click a fully-cached ticket (`detailsFetched: true`) — confirm no API fetch, no error, content displays immediately.
12. **Auto-hide timer interaction:** Trigger a status message, then immediately trigger a `clearTicketsStatus()` (e.g. by clicking a ticket whose local file loads). Confirm no stale timer wipes a subsequent status message within 4 seconds.
13. **Toggle claudify/cyber themes** — confirm no visual regression in the footer.
14. **`pendingClickUpDetailIssueId` preserved:** Confirm the ClickUp task-error path still clears `pendingClickUpDetailIssueId` (line 5276 behavior unchanged).

## Recommendation
Complexity 5/10 → **Send to Coder**.

## Review Findings
CRITICAL fixed: the `kind` derivation relied on regex-parsing `HTTP \d{3}` out of the localized message, but `localizeHttpError` strips the code from the 401/403/404/429/0 messages — so ClickUp 404 never classified as `'deleted'` and the plan's headline red "deleted" warning silently degraded to the subtle "comments unavailable" whisper. Fix: `getTaskDetails` (`ClickUpSyncService.ts`) and `graphqlRequest` (`LinearSyncService.ts`) now attach `err.statusCode`, and both task-detail catch blocks in `PlanningPanelProvider.ts` derive `kind` from `error.statusCode` (regex kept as fallback). Also fixed a shadowing bug where the ClickUp catch redeclared `msg` as the error string, making `taskId: msg.taskId` resolve to `undefined` (renamed to `errMsg`); updated the stale `Linear API HTTP 500` assertion in `linear-graphql-client.test.js`. Files changed: `ClickUpSyncService.ts`, `LinearSyncService.ts`, `PlanningPanelProvider.ts`, `linear-graphql-client.test.js`; webview changes in `planning.js`/`errorMessages.ts` verified correct as-is; compile/tests skipped per session directive (test-file syntax parsed clean). Remaining risks (both pre-accepted/cross-plan, not fixed): the transient `showTicketsError` "deleted" warning can be wiped early by the co-shipped 4s local-file poll's `clearTicketsStatus()`; and a stale `selectedClickUpIssue` from a prior ticket can mis-route the local-vs-full branch when clicking an uncached ticket with no local file (the `selectedIssue = null` reset was explicitly dropped as scope creep).
