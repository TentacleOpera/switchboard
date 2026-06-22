# Fix "Link to Ticket" Button in Planning Tickets Tab (and Stop It Regressing)

## Goal

The **Link to ticket** button on ticket cards in the Tickets tab of `planning.html` does not work. It must reliably copy an agent-usable reference to the ticket's local markdown file — and the fix must address *why this keeps breaking* so it stops recurring.

### Problem Analysis

Click flow:
1. Each card renders `<button ... data-link-ticket-id data-provider>Link to ticket</button>` ([planning.js:6864](src/webview/planning.js#L6864) for Linear, [7364](src/webview/planning.js#L7364) for ClickUp).
2. Delegated handler → `handleLinkToTicket(provider, id, btn)` ([planning.js:7669-7674](src/webview/planning.js#L7669)) posts `{ type: 'copyToClipboard', provider, workspaceRoot, ticketIds: [id] }`.
3. Backend `copyToClipboard` ([PlanningPanelProvider.ts:4434-4458](src/services/PlanningPanelProvider.ts#L4434)) resolves each id to a file path via `_findTicketFilePath(...)` and writes the joined paths to the clipboard.
4. `_findTicketFilePath` ([PlanningPanelProvider.ts:1487-1502](src/services/PlanningPanelProvider.ts#L1487)) scans `${ticketSaveLocation}/${provider}` and `${workspaceRoot}/.switchboard/tickets/${provider}` for a file named `${provider}_${id}_*`.

**Why it fails / keeps breaking:** the button copies a *pre-existing local file path*. If the ticket markdown has not yet been saved to disk (the user hasn't Refetched/imported, or the save location / workspace scoping changed), `_findTicketFilePath` returns `null`, `paths` stays empty, and the handler calls `clipboard.writeText('')` — **silently copying nothing**. There is no user feedback, so the button "does nothing." The path resolution is brittle: it depends on (a) the `ticketSaveLocation` config, (b) the nested provider hierarchy folder layout, and (c) workspace-scoping rules that have been refactored repeatedly (see `globalize-tickets-tab-remove-workspace-scoping`). Each refactor that touches save location or scoping silently re-breaks this lookup.

**Additional frontend bug:** `flashCopyBtn(btn)` is called *synchronously* in `handleLinkToTicket` ([planning.js:7673](src/webview/planning.js#L7673)) immediately after `postMessage`, before the backend has processed anything. The button flashes "Copied!" even when the clipboard receives an empty string. The same synchronous-flash problem affects the "Link all" button ([planning.js:5899](src/webview/planning.js#L5899)).

### Root Cause

The button assumes the ticket file already exists on disk and provides no fallback or feedback when it does not. The repeated breakage is the tight coupling to a path-reconstruction scan that changes whenever ticket storage/scoping changes. A secondary cause is the synchronous flash feedback that lies to the user about success.

## Metadata

**Complexity:** 5
**Tags:** backend, frontend, ui, bugfix, reliability

## User Review Required

Yes — the ensure-then-link approach creates a local ticket file as a side effect of clicking "Link to ticket." This is a behavior change (previously read-only). The user should confirm this is desirable before implementation. Additionally, the `@`-prefix convention for clipboard paths is a new agent-friendly format decision that should be reviewed.

## Complexity Audit

### Routine
- Adding feedback when no file is found (warning toast/status).
- Prepending an agent-safe `@` prefix to the copied path (new convention — agents in this ecosystem recognize `@` as a file reference, e.g. `@${planFile}` in prompt builders at [TaskViewerProvider.ts:15353](src/services/TaskViewerProvider.ts#L15353)).
- Moving `flashCopyBtn` from synchronous call to message-handler-driven callback.
- Adding a `ticketLinkCopied` / `ticketLinkFailed` message from backend to frontend.

### Complex / Risky
- The durable fix is **ensure-then-link**: if the local file is missing, import/save it on demand before copying, so the button never depends on prior state. This touches the import pipeline (`switchboard.importTaskAsDocument`).
- Must work for both ClickUp and Linear and across workspace-scoping modes.
- `importTaskAsDocument` returns `{ success, filePath }` ([TaskViewerProvider.ts:17692](src/services/TaskViewerProvider.ts#L17692)) — the plan should use `result.filePath` directly instead of re-scanning, with `_findTicketFilePath` as a fallback only.
- The `ticketSaveLocation` unconfigured case: `_buildTicketDir` returns `null` ([TaskViewerProvider.ts:17711-17712](src/services/TaskViewerProvider.ts#L17711)), causing `importTaskAsDocument` to return `{ success: false, error: 'Ticket save location not configured...' }`. The error must be surfaced to the user, not swallowed.

## Edge-Case & Dependency Audit

- **Race Conditions:** Import-then-copy must await the import completing before resolving the path; otherwise the scan runs before the file is written. Using `result.filePath` from the awaited import result eliminates this race entirely — no re-scan needed in the happy path.
- **Security:** Existing id guard (`!id.includes('/')...`) must be preserved at [PlanningPanelProvider.ts:4442](src/services/PlanningPanelProvider.ts#L4442).
- **Side Effects:** Ensure-then-link will create a local ticket file as a side effect of clicking Link — acceptable and arguably desirable; document it in the toast.
- **Dependencies & Conflicts:** Relies on `switchboard.importTaskAsDocument` (used by the `editTicket` handler at [PlanningPanelProvider.ts:4130-4139](src/services/PlanningPanelProvider.ts#L4130)). Coordinate with the copy-link `@`-prefix change so both copy paths agree.
- **Multi-ticket "Link all" path:** The "Link all" button ([planning.js:5885-5899](src/webview/planning.js#L5885)) sends all filtered ticket IDs through the same `copyToClipboard` message. The ensure-then-link loop will trigger sequential `importTaskAsDocument` calls for each missing file. For large ticket lists this means multiple API calls. This is acceptable because (a) existing files resolve instantly via scan, (b) users rarely click "Link all" on dozens of unimported tickets, and (c) the import is awaited sequentially so there's no thundering-herd. Document the latency trade-off in a comment.
- **`providerDir` vs `provider` inconsistency:** `copyToClipboard` uses `providerDir = provider === 'clickup' ? 'clickup' : 'linear'` while `saveLocalTicketFile` ([PlanningPanelProvider.ts:4119](src/services/PlanningPanelProvider.ts#L4119)) passes `provider` raw. Both work because values match, but the ensure-then-link code should use `msg.provider` consistently when calling `importTaskAsDocument`.

## Dependencies

- None — this plan is self-contained. The `switchboard.importTaskAsDocument` command already exists and is registered at [extension.ts:1498-1501](src/extension.ts#L1498).

## Adversarial Synthesis

Key risks: (1) `importTaskAsDocument` silently fails when `ticketSaveLocation` is unconfigured, so the ensure-then-link fallback must surface the real error rather than a generic "Try Refetch" message; (2) `flashCopyBtn` fires synchronously before the backend processes the message, so it must move to the `ticketLinkCopied` message handler with a stored button reference; (3) the plan should use `result.filePath` from the import return value directly instead of re-scanning, eliminating an unnecessary I/O round-trip and race window. Mitigations: surface import errors verbatim, track the clicked button in a module variable for the message callback, and use the returned `filePath` with scan-only-as-fallback.

## Proposed Changes

### 1. `src/services/PlanningPanelProvider.ts` — make `copyToClipboard` ensure the file exists and give feedback

In the `copyToClipboard` case ([4434](src/services/PlanningPanelProvider.ts#L4434)), when handling explicit `ticketIds`:

```ts
for (const id of msg.ticketIds) {
    if (typeof id === 'string' && id && !id.includes('/') && !id.includes('\\') && !id.includes('..')) {
        let filePath = this._findTicketFilePath(workspaceRoot, providerDir, id);
        if (!filePath) {
            // Ensure-then-link: import the ticket as a local doc, then use the
            // returned filePath directly (avoids a redundant re-scan race).
            try {
                const result: any = await vscode.commands.executeCommand('switchboard.importTaskAsDocument',
                    { workspaceRoot, provider, id, includeSubtasks: true });
                if (result?.filePath) {
                    filePath = result.filePath;
                } else if (result?.success === false) {
                    // Surface the real error (e.g. "Ticket save location not configured")
                    lastError = result.error || 'Could not import ticket.';
                    continue;
                }
                // Fallback: if filePath missing from result, re-scan.
                if (!filePath) {
                    filePath = this._findTicketFilePath(workspaceRoot, providerDir, id);
                }
            } catch (err: any) {
                lastError = err?.message || String(err);
            }
        }
        if (filePath) { paths.push('@' + filePath); }   // agent-safe prefix
    }
}
// ...
if (paths.length === 0) {
    const hint = lastError || 'Could not locate or create a local file for this ticket.';
    this._panel?.webview.postMessage({ type: 'ticketLinkFailed', error: hint });
    break;
}
await vscode.env.clipboard.writeText(paths.join('\n'));
this._panel?.webview.postMessage({ type: 'ticketLinkCopied', count: paths.length });
```

**Clarification:** Declare `let lastError: string | undefined;` before the loop. Use `msg.provider` (not `providerDir`) when calling `importTaskAsDocument` to match the command's expected parameter shape.

### 2. `src/webview/planning.js` — surface success/failure and fix premature flash

**2a. Track the clicked button for deferred flash.**

Add a module-level variable to store the last-clicked link button so the message handler can flash it:

```js
let _lastLinkTicketBtn = null;
```

In `handleLinkToTicket` ([7669](src/webview/planning.js#L7669)), remove the synchronous `flashCopyBtn` call and store the button ref instead:

```js
function handleLinkToTicket(provider, id, btn) {
    vscode.postMessage({ type: 'copyToClipboard', provider, workspaceRoot: ticketsWorkspaceRoot, ticketIds: [id] });
    if (btn) { _lastLinkTicketBtn = btn; }   // flash deferred to ticketLinkCopied handler
}
```

**2b. Handle `ticketLinkCopied` and `ticketLinkFailed` messages.**

In the message listener (near the `syncAllTicketsResult` handler at [3429](src/webview/planning.js#L3429)), add:

```js
case 'ticketLinkCopied':
    showTicketsStatus(`Copied ${msg.count} ticket link${msg.count > 1 ? 's' : ''} ✓`, false);
    if (_lastLinkTicketBtn) { flashCopyBtn(_lastLinkTicketBtn); _lastLinkTicketBtn = null; }
    break;
case 'ticketLinkFailed':
    showTicketsStatus(msg.error || 'Could not locate or create a local file for this ticket.', true);
    if (_lastLinkTicketBtn) {
        // Reset button text without success flash
        _lastLinkTicketBtn.disabled = false;
        _lastLinkTicketBtn = null;
    }
    break;
```

**2c. Fix the "Link all" button's premature flash.**

At [5885-5900](src/webview/planning.js#L5885), remove the synchronous `flashCopyBtn(linkAllButton)` call. The `ticketLinkCopied` handler will not flash the "Link all" button (it only flashes `_lastLinkTicketBtn`), so add a separate check:

```js
linkAllButton?.addEventListener('click', () => {
    // ... existing code to gather ids ...
    vscode.postMessage({
        type: 'copyToClipboard',
        provider: lastIntegrationProvider,
        workspaceRoot: ticketsWorkspaceRoot,
        ticketIds: ids
    });
    _lastLinkTicketBtn = linkAllButton;   // flash deferred to handler
});
```

### 3. Lock in with a regression test

Add `src/test/tickets-link-to-ticket-regression.test.js` following the static source-code assertion pattern used by existing tests (e.g. `context-map-batching-regression.test.js`). Assert:

- (a) The `copyToClipboard` case in `PlanningPanelProvider.ts` contains `importTaskAsDocument` (ensure-then-link logic is present).
- (b) The copied path uses `'@' +` prefix.
- (c) The backend posts a `ticketLinkCopied` message on success and `ticketLinkFailed` on failure (feedback is present, no silent empty clipboard write).
- (d) `planning.js` has a `ticketLinkCopied` case in the message listener and calls `showTicketsStatus` (no silent no-op).
- (e) `handleLinkToTicket` does NOT call `flashCopyBtn` synchronously (the premature flash is removed).
- (f) The `ticketLinkFailed` handler surfaces `msg.error` (real import errors are not swallowed).

This test is the guard against the recurring breakage — any future refactor that removes the ensure-then-link logic, the feedback, or re-introduces the synchronous flash will fail the test.

## Verification Plan

### Automated Tests

- Run `node src/test/tickets-link-to-ticket-regression.test.js` — verifies the static code invariants listed in Proposed Change 3.
- (The full test suite will be run separately by the user.)

### Manual Verification

1. Open Planning → Tickets, select a provider, Refetch.
2. Click **Link to ticket** on a ticket whose file already exists → paste into terminal → confirm `@/.../linear_<id>_*.md`.
3. Delete the local file (or pick a ticket never imported) → click **Link to ticket** → confirm it imports the file then copies the `@`-path, and shows a success status.
4. Force a no-result case (invalid id, or `ticketSaveLocation` unconfigured) → confirm a warning toast/status appears with the real error instead of a silent empty copy.
5. Click **Link all** → confirm all paths are copied with `@` prefix and the button flashes only on success.

---

**Recommendation:** Complexity is 5 → **Send to Coder**.
