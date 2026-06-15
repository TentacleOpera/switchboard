# Fix Tickets Tab "Import All" Button Functionality

## Goal
The "Import All" button in the tickets tab currently imports tickets as kanban plans (`importMode: 'plan'`). This is incorrect - it should import tickets as local markdown documents to the local tickets area for editing and pushing back. A separate "Import All as Plans" button should be added for the current kanban plan import functionality.

## Problem
- User clicked "Import All" expecting to import tickets to local tickets area
- Instead, it imported 40 tickets as kanban plans unexpectedly
- The button label is ambiguous about what it does
- No separate option exists for importing as plans vs importing as local documents

## Background
The tickets tab has two views: Online (ClickUp/Linear) and Local (imported markdown copies). Users can switch between these views. The "Import All" button is visible in the Online view and should import tickets to the Local view as editable markdown documents.

## Root Cause
In `planning.js` line 5029, the `importAllTickets` message sends `importMode: 'plan'` when it should send `importMode: 'document'` for importing to local tickets.

## Metadata
- **Tags:** ui, bugfix, frontend
- **Complexity:** 3

## User Review Required
No. This is a straightforward bugfix with clear scope. The product requirement (split button behavior) is self-evident from the current ambiguity.

## Complexity Audit

### Routine
- Add HTML button element to existing control strip
- Add CSS selector to existing local-mode hiding rule
- Add DOM reference to existing element getter
- Add variable to existing destructuring
- Change one string literal (`'plan'` → `'document'`) in existing handler
- Copy-paste existing handler pattern for new button
- Add one DOM re-enable call to existing completion handler

### Complex / Risky
- Bulk document import completion must trigger local tickets list refresh; otherwise the UI appears stale after "Import All" completes. The single-ticket `editTicketResult` handler auto-switches to Local view, but the bulk `importAllTicketsComplete` handler does not. This UX gap requires a targeted refresh call.

## Edge-Case & Dependency Audit

### Race Conditions
- Both buttons share `isImportingAll` flag, preventing concurrent bulk imports. Completion handler resets `isImportingAll = false` and re-enables both buttons simultaneously. This is safe because the backend processes one `importAllTickets` call at a time per workspace.

### Security
- No new attack surface. Both buttons post the same message type (`importAllTickets`) with the same payload shape. Backend already validates `workspaceRoot`, `provider`, and `ids`. `importMode` is strictly typed as `'plan' | 'document'`.

### Side Effects
- `importMode: 'document'` writes markdown files to the local tickets folder via `importTaskAsDocument()`. Files are named deterministically; overwriting existing imports is handled by the backend.
- `importMode: 'plan'` calls `_syncFilesAndRefreshRunSheets()` after completion, which refreshes the Kanban view. No extra side effects beyond existing behavior.

### Dependencies & Conflicts
- No external dependencies. Backend command `switchboard.importAllTasks` in `TaskViewerProvider.ts` already supports both modes.
- No migration needed. Existing kanban plans created by the old button are not affected.

## Dependencies
- None. All backend support for `importMode: 'document'` is already implemented.

## Adversarial Synthesis
Key risks: stale local view after bulk document import, and ambiguous completion status text that doesn't distinguish document vs plan import. Mitigations: add `requestLocalTickets()` refresh in the `importAllTicketsComplete` handler for document mode, and keep the shared `isImportingAll` guard to prevent race conditions.

## Proposed Changes

### Step 1: Add "Import All as Plans" button to HTML
**File:** `src/webview/planning.html`

Add a new button after the existing "Import All" button in the tickets control strip (around line 3158):

```html
<button id="btn-import-all-plans" class="strip-btn">Import All as Plans</button>
```

**CSS update:** Add the new button to the local mode hiding rule (around line 2720) so it's hidden when in Local view:

```css
#controls-strip-tickets.tickets-local-mode #btn-import-all-plans,
```

### Step 2: Add button reference in JavaScript
**File:** `src/webview/planning.js`

Add the new button to `getTicketsTabElements()` (around line 278):

```javascript
btnImportAllPlans: document.getElementById('btn-import-all-plans'),
```

Add it to the destructuring in `initTicketsTab()` (around line 4973):

```javascript
btnManageTicketFolders, btnImportAllTickets, btnImportAllPlans
```

### Step 3: Change existing button to use document mode
**File:** `src/webview/planning.js`

In the "Import All" button click handler (around line 5008-5032), change line 5030 from:

```javascript
importMode: 'plan'
```

to:

```javascript
importMode: 'document'
```

Also update the comment to clarify its purpose:

```javascript
// Import All button (imports as local documents for editing)
```

### Step 4: Add handler for new "Import All as Plans" button
**File:** `src/webview/planning.js`

Add a new click handler after the existing Import All handler (around line 5032):

```javascript
// Import All as Plans button (imports as kanban plans)
btnImportAllPlans?.addEventListener('click', () => {
    if (isImportingAll) return;
    const provider = lastIntegrationProvider;
    let ids = [];
    if (provider === 'linear') {
        ids = getFilteredLinearIssues().map(issue => issue.id);
    } else if (provider === 'clickup') {
        ids = getFilteredClickUpTasks().map(task => task.id);
    }
    if (ids.length === 0) {
        showTicketsStatus('No tickets to import', true);
        return;
    }
    isImportingAll = true;
    btnImportAllPlans.disabled = true;
    setTicketsLoadingState(true);
    vscode.postMessage({
        type: 'importAllTickets',
        workspaceRoot: ticketsWorkspaceRoot,
        provider,
        ids,
        importMode: 'plan'
    });
});
```

### Step 5: Update completion handler to re-enable both buttons
**File:** `src/webview/planning.js`

In the `importAllTicketsComplete` case handler (around line 2923-2927), add re-enabling for the new button:

```javascript
const importAllBtn = document.getElementById('btn-import-all-tickets');
const importAllPlansBtn = document.getElementById('btn-import-all-plans');
if (importAllBtn) importAllBtn.disabled = false;
if (importAllPlansBtn) importAllPlansBtn.disabled = false;
```

### Step 6: Refresh local tickets list after document bulk import
**File:** `src/webview/planning.js`

In the `importAllTicketsComplete` case handler (around line 2927), after the existing status message logic, add a refresh call so imported documents appear in the Local view:

```javascript
// After existing status display logic:
requestLocalTickets();
```

**Clarification:** This refresh is needed because `importTaskAsDocument()` writes files to disk, but the webview's `localTickets` array is only updated by the `localTicketsListed` message. Without `requestLocalTickets()`, the user would switch to Local view and see stale/empty state. The single-ticket `editTicketResult` handler auto-switches to Local view; bulk import should at minimum refresh the list.

## Verification Plan

### Automated Tests
- None. This is a VS Code extension webview UI change best verified through manual integration testing.

### Manual Verification
1. Reload the extension
2. Open tickets tab in Online view
3. Verify both "Import All" and "Import All as Plans" buttons are visible
4. Click "Import All" - should import tickets to local tickets area (check Local view)
5. Click "Import All as Plans" - should import tickets as kanban plans (check Kanban tab)
6. Verify sprint selector dropdowns still work correctly
7. Switch to Local view - verify both import buttons are hidden
8. Switch back to Online view - verify both buttons reappear
9. **Regression:** After clicking "Import All", verify Local view shows newly imported tickets without requiring a manual refresh

## Files Changed
- `src/webview/planning.html` - Add button and CSS rule
- `src/webview/planning.js` - Add button reference, change import mode, add new handler, update completion handler, add local tickets refresh

## Risks
- **Low risk:** Changes are localized to the import button functionality
- **Must verify:** Sprint selector dropdowns and other controls remain intact
- **Must verify:** No other functionality in tickets tab is affected
- **Must verify:** Local view correctly reflects imported tickets after bulk document import completes

**Recommendation:** Send to Intern
