# Tickets Tab: Local-Only Sync Model (Git-Style Workflow)

## Goal
Refactor the tickets tab from an online/local split to a local-only sync model with git-style pull/push workflow. Remove the online/local toggle, make "Import All" the primary sync action, and add conflict detection for unpushed edits.

The online/local split adds cognitive overhead and doesn't match user mental models for ticket management. Users expect to work on tickets locally and sync changes explicitly, not toggle between viewing modes.

## Background
The current tickets tab has an online/local split that users find clunky:
- **Online mode**: Browse ClickUp/Linear tickets, click "Edit" to import individual tickets
- **Local mode**: Edit imported markdown copies, push back to remote
- Manual "Import All" buttons for bulk import

This requires users to mentally track which mode they're in and manually switch between browsing and editing. The proposed model simplifies this to a single local view with explicit sync actions (pull/push), similar to git workflow.

## Root Cause
The online/local split adds cognitive overhead and doesn't match user mental models for ticket management. Users expect to work on tickets locally and sync changes explicitly, not toggle between viewing modes.

## Current Architecture
The existing flow has a two-stage fetch:

1. **Frontend fetches for display**: When a user selects a Linear project or ClickUp list, `loadLinearProject()` / `loadClickUpSpaces()` fetch tickets into frontend arrays (`linearProjectIssues`, ClickUp task arrays). These populate the online ticket list.
2. **Import All scrapes IDs**: The Import All button (`planning.js:5016`) harvests IDs from those frontend arrays via `getFilteredLinearIssues().map(issue => issue.id)`.
3. **Backend imports individually**: `importAllTasks` (`TaskViewerProvider.ts:17548`) receives the `ids: string[]` array and imports each ticket one-by-one.

This works because the online view is the source of truth for which IDs to import. Remove the online view, and the `ids` array becomes empty. The fix is to make `importAllTasks` capable of fetching by `listId` directly, bypassing the frontend display cache entirely.

## Metadata
- **Tags:** refactor, ui, backend, api
- **Complexity:** 8

## User Review Required
- Confirm removal of Online mode is permanent (no rollback path or feature flag)
- Approve button label copy: "Sync" vs "Pull" vs "Fetch" for primary action
- Decide conflict-modal "Push First" behavior when unpushed tickets span multiple providers
- Determine whether to remove or repurpose `tickets-preview-meta-bar` (online ticket Edit/Push/Delete/Status/Comment actions)

## Complexity Audit

### Routine
- Removing UI elements (mode switch buttons, Import Doc buttons)
- Renaming button labels and tooltips
- Adding modal HTML and basic event listeners
- Reassigning CSS selectors for markdown preview consistency

### Complex / Risky
- Backend `importAllTasks` overload: add `listId`/`projectId` with optional `page`/`append` to existing method. Existing ClickUp/Linear services already support list-based fetching; this is a routing change, not new infrastructure
- Auto-load on tab open: must derive list configuration from existing persisted state (`clickUpSelectedSpaceId`/`FolderId`/`ListId`, `linearProjectPickerValue`) and trigger a backend fetch that currently only accepts explicit IDs
- Conflict detection `ticketsWithUnpushedEdits` Set is frontend-only and volatile (lost on webview reload). No filesystem-level dirty tracking exists
- Bulk push from conflict modal (`pushAllUnpushedTickets`) does not exist; only single-ticket `pushTicket` is implemented
- "Import as Plans" in local-only model: without an online list view, this action needs a separate fetch path or must operate on already-synced local tickets
- ~50 CSS selectors must be extended or refactored to style `#tickets-local-preview`

## Edge-Case & Dependency Audit

### Race Conditions
- User clicks Sync while a prior Sync or Push is in flight. `isImportingAll` exists but there is no guard against a push-then-sync sequence triggered from the conflict modal
- Concurrent edits during an active sync: local file may be overwritten mid-edit if sync proceeds while editor is open

### Security
- No new auth scopes required. Local ticket content is already file-system backed
- Conflict modal uses inline styles; no additional XSS vector beyond existing `renderMarkdown` usage

### Side Effects
- Removing `setTicketsViewMode` affects `saveTicketsState` / `restoreTicketsStateForRoot`, which persists `ticketsViewMode`. Backward compatibility for users with saved `ticketsViewMode: 'local'` needs graceful degradation (treat as default local)
- `ticketsWorkspaceRoot` and provider selection are shared with existing kanban and sync-to-online flows

### Dependencies & Conflicts
- Depends on `switchboard.importAllTasks` accepting optional `listId`/`projectId`/`page`/`append` (backward-compatible overload)
- Depends on `PanelStateStore` / `persistTab` for state persistence
- Conflict risk with any in-flight work on `src/webview/planning.js` tickets rendering (large file, high collision risk)

## Dependencies
None from prior sessions.

## Adversarial Synthesis
Key risks: volatile in-memory conflict tracking lost on webview reload, and missing bulk push infrastructure. Backend change is straightforward: overload `importAllTasks` with `listId`/`projectId` routing to existing ClickUp/Linear services. Mitigations: persist dirty flags via file-mtime comparison or a hidden marker file; implement bulk push as sequential single pushes with per-ticket error aggregation.

## Proposed Changes

### `src/webview/planning.html`
- **Context**: Tickets sidebar contains online/local mode switch and separate preview containers.
- **Logic**: Remove mode switch HTML; add conflict modal; unify markdown preview class.
- **Implementation**: Delete `.tickets-mode-switch` div (lines 3202-3205). Rename "Import All" to "Sync" and add title tooltip (line 3209). Rename "Import All as Plans" to "Import as Plans" (line 3210). Add `#tickets-conflict-modal` before closing `</body>`. Add `markdown-preview-content` class to both preview divs (lines 3251, 3261). Remove CSS block for `.tickets-mode-switch` and `.tickets-mode-btn` (lines ~2738-2749).
- **Edge Cases**: Ensure modal `z-index: 1000` exceeds all other UI layers. Inline styles in modal may clash with high-contrast themes.

### `src/webview/planning.js`
- **Context**: Core tickets tab state machine with online/local split.
- **Logic**: Eliminate `ticketsViewMode` state; always show local container; track unpushed edits; gate sync behind conflict check; auto-restore last list on tab activation using existing persisted state.
- **Implementation**: Remove `ticketsViewMode` var (line 195), mode switch listeners (lines 5078-5079), `setTicketsViewMode` (lines 5500-5546), and online preview toggles in render functions. Add `ticketsWithUnpushedEdits` Set. Wire `onLocalTicketEdited` into `btn-save-local-ticket` handler (after `localTicketContent = editor.value;` around line 5103). Wire `onLocalTicketPushed` into `pushTicketResult` message handler. Add `checkConflictsBeforeSync` called from sync button handler. Add `onTicketsTabActivated` auto-load logic using `clickUpSelectedListId` / `linearProjectPickerValue` from existing persisted state rather than a new `lastUsedListConfig` variable. Repurpose `tickets-load-more` handler to call backend with `page`/`append`.
- **Edge Cases**: Webview reload wipes unpushed-edit tracking. User may have no prior list selection. Edits during an in-progress sync need an `isImportingAll` guard.

### `src/webview/planning.html` (CSS)
- **Context**: Markdown preview styling only targets `#markdown-preview-tickets` and shared groups; `#tickets-local-preview` has zero rules.
- **Logic**: Extend all markdown rules to cover `#tickets-local-preview`.
- **Implementation**: Add `#tickets-local-preview` to every existing combined selector group that includes `#markdown-preview-tickets`. For example, change `#markdown-preview-tickets h1, ...` blocks to also include `#tickets-local-preview h1, ...`. This avoids a risky global refactor to class-based selectors.
- **Edge Cases**: Cyber-theme `body.cyber-theme-enabled` overrides must also cover local preview selectors.

### `src/services/PlanningPanelProvider.ts`
- **Context**: Message bridge for `importAllTickets` currently forwards `ids` array to `switchboard.importAllTasks`.
- **Logic**: Forward new optional fields (`listId`, `projectId`, `workspaceId`, `page`, `append`) to the same command. No branching needed; `importAllTasks` handles both `ids` and list-based fetching internally.
- **Implementation**: Update `case 'importAllTickets'` (line 2584) to pass all message fields through to `switchboard.importAllTasks`: `{ workspaceRoot, provider, ids, listId, projectId, workspaceId, page, append, importMode }`.
- **Edge Cases**: Maintain backward compatibility for callers that still send `ids`.

### `src/services/TaskViewerProvider.ts`
- **Context**: `importAllTasks` (line 17548) imports by explicit ID array with a concurrency pool of 3.
- **Logic**: Overload `importAllTasks` to accept `listId` (ClickUp) or `projectId` (Linear) with optional `page`/`append`. Route to existing ClickUp/Linear services for list-based fetching, then pipe resulting IDs into the same import loop.
- **Implementation**: Add `listId`, `projectId`, `workspaceId`, `page`, `append` optional fields to `importAllTasks` parameter object. If `ids` provided, use existing path. If `listId`/`projectId` provided, call `clickup.getTasksByList(listId, page)` or `linear.getIssuesByProject(projectId, page)`, extract IDs, then call the existing import loop. When `append: true`, skip folder cleanup.
- **Edge Cases**: Large lists (>100 items) need rate-limit handling. Token expiry during a paginated fetch must fail gracefully. Keep `ids` path for backward compatibility with kanban bulk import.

## Implementation Plan

### 1. Remove online/local toggle UI
**File**: `src/webview/planning.html`

Remove the mode switch buttons from the sidebar:
```html
<!-- DELETE lines 3202-3205 -->
<div class="tickets-mode-switch">
    <button id="tickets-mode-online" class="tickets-mode-btn active" title="Browse tickets on ClickUp/Linear">Online</button>
    <button id="tickets-mode-local" class="tickets-mode-btn" title="Imported local copies — edit as markdown, push back when done">Local</button>
</div>
```

Remove associated CSS for `.tickets-mode-switch` and `.tickets-mode-btn`.

### 2. Rename "Import All" to "Sync/Pull" and remove "Import Doc" from cards
**File**: `src/webview/planning.html`

Change button labels to reflect sync semantics:
```html
<!-- Line 3209: Change button label and add tooltip -->
<button id="btn-import-all-tickets" class="planning-button" style="width: 100%; box-sizing: border-box; text-align: center; margin: 0;" title="Pull latest tickets from remote (ClickUp/Linear)">Sync</button>

<!-- Line 3210: Keep Import All as Plans, clarify it's a secondary action -->
<button id="btn-import-all-plans" class="planning-button secondary" style="width: 100%; box-sizing: border-box; text-align: center; margin: 0;" title="Import tickets as Switchboard plans">Import as Plans</button>
```

**File**: `src/webview/planning.js`

Remove the "Import Doc" button from ticket cards since all tickets are now local copies (no longer need to import individual tickets):

Line 5726 (Linear issues):
```javascript
// REMOVE this line
<button type="button" class="card-icon-btn" data-import-doc-id="${escapeAttr(issue.id)}" data-provider="linear">Import Doc</button>
```

Line 6147 (ClickUp tasks):
```javascript
// REMOVE this line
<button type="button" class="card-icon-btn" data-import-doc-id="${escapeAttr(task.id)}" data-provider="clickup">Import Doc</button>
```

The card buttons should now be:
- Copy Prompt (was REFINE)
- Import as Plan (converts ticket to Switchboard plan)

### 3. Always show local container, hide online containers
**File**: `src/webview/planning.js`

Remove `setTicketsViewMode` function (lines 5500-5545) and related state:
- Remove `ticketsViewMode` variable (line 195)
- Remove mode switch event listeners (lines 5078-5079)
- Remove mode toggle logic from `renderTickets*` functions

Always display local container:
```javascript
// In DOM initialization, ensure local container is always visible
const localContainer = document.getElementById('tickets-local-container');
if (localContainer) localContainer.style.display = '';

// Hide online-only elements
const onlineEls = ['tickets-empty-state', 'tickets-issues-container', 'tickets-load-more'];
for (const id of onlineEls) {
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
}
```

### 4. Auto-load last used list on tab open
**File**: `src/webview/planning.js`

Existing `saveTicketsState` / `restoreTicketsStateForRoot` already persist ClickUp list IDs (`clickUpSelectedSpaceId`, `clickUpSelectedFolderId`, `clickUpSelectedListId`) and Linear project picker value (`linearProjectPickerValue`). Reuse this persisted state.

On tab activation, check restored state and auto-sync if a list/project is configured:
```javascript
function onTicketsTabActivated() {
    const hasClickUpList = clickUpSelectedListId;
    const hasLinearProject = linearProjectPickerValue;
    
    if (hasClickUpList || hasLinearProject) {
        showTicketsStatus('Loading last list...', false);
        proceedWithSync();
    } else {
        showTicketsStatus('Select a ClickUp/Linear list to sync', false);
    }
}
```

`proceedWithSync` sends `listId`/`workspaceId` (ClickUp) or `projectId` (Linear) to the backend. The backend fetches directly; no frontend ID scraping needed.

### 5. Add conflict detection modal
**File**: `src/webview/planning.html`

Add modal HTML before closing body tag:
```html
<div id="tickets-conflict-modal" style="display:none; position:fixed; top:0; left:0; right:0; bottom:0; background:rgba(0,0,0,0.7); z-index:1000; align-items:center; justify-content:center;">
    <div style="background:var(--panel-bg2); border:1px solid var(--accent-teal); border-radius:8px; padding:24px; max-width:400px; box-shadow:var(--shadow-md);">
        <h3 style="color:var(--accent-teal); margin-bottom:12px; font-size:14px;">Unpushed Changes Detected</h3>
        <p style="color:var(--text-primary); margin-bottom:16px; font-size:12px; line-height:1.5;">
            You have unpushed edits to local tickets. Syncing will overwrite your changes. Push your changes first, or continue to overwrite.
        </p>
        <div style="display:flex; gap:8px; justify-content:flex-end;">
            <button id="conflict-modal-cancel" class="planning-button secondary">Cancel</button>
            <button id="conflict-modal-push" class="planning-button">Push First</button>
            <button id="conflict-modal-overwrite" class="planning-button" style="border-color:#f14c4c; color:#f14c4c;">Overwrite</button>
        </div>
    </div>
</div>
```

**File**: `src/webview/planning.js`

Add conflict detection logic:
```javascript
// Track which local tickets have unpushed edits
const ticketsWithUnpushedEdits = new Set();

// When editing a local ticket, mark as unpushed
function onLocalTicketEdited(ticketId) {
    ticketsWithUnpushedEdits.add(ticketId);
}

// When pushing successfully, remove from set
function onLocalTicketPushed(ticketId) {
    ticketsWithUnpushedEdits.delete(ticketId);
}

// Before sync, check for conflicts
function checkConflictsBeforeSync() {
    if (ticketsWithUnpushedEdits.size > 0) {
        const modal = document.getElementById('tickets-conflict-modal');
        if (modal) modal.style.display = 'flex';
        return true; // Conflict detected
    }
    return false; // No conflicts
}

// Modal event handlers
document.getElementById('conflict-modal-cancel')?.addEventListener('click', () => {
    document.getElementById('tickets-conflict-modal').style.display = 'none';
});

document.getElementById('conflict-modal-push')?.addEventListener('click', () => {
    document.getElementById('tickets-conflict-modal').style.display = 'none';
    // Trigger push for all unpushed tickets
    pushAllUnpushedTickets();
});

document.getElementById('conflict-modal-overwrite')?.addEventListener('click', () => {
    document.getElementById('tickets-conflict-modal').style.display = 'none';
    // Proceed with sync, will overwrite
    proceedWithSync();
});
```

> **Clarification**: `pushAllUnpushedTickets()` does not currently exist. Only single-ticket `pushTicket` is supported. Implement as an async sequential loop over `ticketsWithUnpushedEdits`, posting `pushTicket` for each, then calling `proceedWithSync()` on completion. Failures should be aggregated and shown in status.

### 6. Update sync button handler with conflict check
**File**: `src/webview/planning.js`

Replace the ID-scraping handler with a list-based sync. The backend will fetch tickets directly by list/project, so the frontend no longer needs `linearProjectIssues` or ClickUp task arrays.

```javascript
btnImportAllTickets?.addEventListener('click', () => {
    if (checkConflictsBeforeSync()) return;
    proceedWithSync();
});

function proceedWithSync() {
    if (!lastIntegrationProvider) {
        showTicketsStatus('Select a list to sync', true);
        return;
    }
    
    btnImportAllTickets.disabled = true;
    if (btnImportAllPlans) btnImportAllPlans.disabled = true;
    
    showTicketsStatus('Syncing...', false);
    setTicketsLoadingState(true);
    isImportingAll = true;
    
    // Send list config, not IDs. Backend fetches directly.
    const payload = {
        type: 'importAllTickets',
        workspaceRoot: ticketsWorkspaceRoot,
        provider: lastIntegrationProvider,
        importMode: 'document'
    };
    
    if (lastIntegrationProvider === 'clickup') {
        payload.listId = clickUpSelectedListId;
        payload.workspaceId = clickUpSelectedSpaceId; // ClickUp uses space as workspace
    } else {
        payload.projectId = linearProjectPickerValue; // Linear uses project name/ID
    }
    
    vscode.postMessage(payload);
}
```

### 7. Add loading state for sync
**File**: `src/webview/planning.js`

Update the `importAllTicketsComplete` handler (around line 2940):
```javascript
case 'importAllTicketsComplete': {
    const importAllBtn = document.getElementById('btn-import-all-tickets');
    const importAllPlansBtn = document.getElementById('btn-import-all-plans');
    if (importAllBtn) importAllBtn.disabled = false;
    if (btnImportAllPlansBtn) importAllPlansBtn.disabled = false;
    
    // Update last used config
    if (msg.provider && msg.listId) {
        lastUsedListConfig = {
            provider: msg.provider,
            listId: msg.listId,
            workspaceId: msg.workspaceId
        };
    }
    
    if (msg.error) {
        showTicketsStatus(msg.error || 'Sync failed', true);
    } else {
        let statusText = `Synced ${msg.successCount} tickets`;
        if (msg.failCount > 0) {
            statusText += `, ${msg.failCount} failed`;
        }
        showTicketsStatus(statusText, false);
        setTimeout(() => showTicketsStatus('', false), 3000);
    }
    break;
}
```

### 8. Preserve pagination support
**File**: `src/webview/planning.js`

Repurpose "Load More" (line 3214) for paginated backend fetch. Track `currentSyncPage` in frontend state.

```javascript
let currentSyncPage = 1;

document.getElementById('tickets-load-more')?.addEventListener('click', () => {
    if (!lastIntegrationProvider) return;
    
    showTicketsStatus('Loading more tickets...', false);
    setTicketsLoadingState(true);
    
    const payload = {
        type: 'importAllTickets',
        workspaceRoot: ticketsWorkspaceRoot,
        provider: lastIntegrationProvider,
        importMode: 'document',
        page: currentSyncPage + 1,
        append: true
    };
    
    if (lastIntegrationProvider === 'clickup') {
        payload.listId = clickUpSelectedListId;
        payload.workspaceId = clickUpSelectedSpaceId;
    } else {
        payload.projectId = linearProjectPickerValue;
    }
    
    vscode.postMessage(payload);
});
```

Backend must support `page` and `append` parameters. The backend skips folder cleanup when `append: true` to avoid deleting already-imported tickets.

### 9. Update preview pane to always show local markdown with matching styling
**File**: `src/webview/planning.html`

The local preview (`#tickets-local-preview`) currently lacks the markdown styling that the online preview (`#markdown-preview-tickets`) has. Apply the same CSS to ensure visual consistency:

Add CSS to make `#tickets-local-preview` match `#markdown-preview-tickets` styling:
```css
/* Add after line 974 (after #markdown-preview-tickets h1-h6 rules) */
#tickets-local-preview h1, #tickets-local-preview h2, #tickets-local-preview h3, #tickets-local-preview h4, #tickets-local-preview h5, #tickets-local-preview h6 {
    margin-top: 24px;
    margin-bottom: 12px;
    font-weight: 600;
    line-height: 1.25;
}

/* Copy all other markdown styling from #markdown-preview-tickets to #tickets-local-preview */
#tickets-local-preview p,
#tickets-local-preview li,
#tickets-local-preview pre,
#tickets-local-preview code,
#tickets-local-preview blockquote,
#tickets-local-preview ul,
#tickets-local-preview ol,
#tickets-local-preview table,
#tickets-local-preview a,
#tickets-local-preview hr,
#tickets-local-preview img {
    /* Copy all the same rules from #markdown-preview-tickets */
}
```

Alternatively, add a shared class to both elements to avoid duplication:
```html
<!-- Change line 3251 -->
<div id="markdown-preview-tickets" class="markdown-preview-content">

<!-- Change line 3261 -->
<div id="tickets-local-preview" class="markdown-preview-content">
```

Then update CSS to use the class:
```css
/* Replace all #markdown-preview-tickets selectors with .markdown-preview-content */
.markdown-preview-content h1, .markdown-preview-content h2, .markdown-preview-content h3, .markdown-preview-content h4, .markdown-preview-content h5, .markdown-preview-content h6 {
    margin-top: 24px;
    margin-bottom: 12px;
    font-weight: 600;
    line-height: 1.25;
}
/* ... and so on for all other markdown styling rules */
```

**File**: `src/webview/planning.js`

Remove online preview pane logic, always show local markdown preview:
```javascript
// Remove online preview display logic (line 5528-5529)
// Always show local view
const localView = document.getElementById('tickets-local-view');
if (localView) localView.style.display = 'flex';

// Ensure local preview renders markdown (not raw text)
function renderLocalTicketPreview(markdownContent) {
    const preview = document.getElementById('tickets-local-preview');
    if (preview) {
        // Use the same markdown rendering logic as online preview
        preview.innerHTML = renderMarkdown(markdownContent);
    }
}
```

### 10. Backend: fetch by list instead of by IDs
**Files**: `src/services/TaskViewerProvider.ts`, `src/services/PlanningPanelProvider.ts`, `extension.ts`

**Problem**: `importAllTasks` (`TaskViewerProvider.ts:17548`) only accepts `ids: string[]`. In the local-only model, the frontend no longer maintains an online ticket cache, so there are no IDs to send.

**Solution**: Overload `importAllTasks` to accept either `ids` (backward compat) or `listId`/`projectId` with optional `page`/`append`. The existing ClickUp and Linear services already support list-based fetching.

**In `TaskViewerProvider.ts`:**
```typescript
public async importAllTasks(
    workspaceRoot: string,
    data: { 
        provider: 'linear' | 'clickup'; 
        ids?: string[]; 
        listId?: string;
        projectId?: string;
        workspaceId?: string;
        page?: number;
        append?: boolean;
        importMode: 'plan' | 'document';
    }
): Promise<...> {
    // If ids provided, use existing path
    if (data.ids && data.ids.length > 0) {
        return this._importByIds(workspaceRoot, data);
    }
    
    // Otherwise, fetch by list/project then import
    const resolvedRoot = this._resolveWorkspaceRoot(workspaceRoot);
    const { provider, listId, projectId, workspaceId, page = 1, append = false, importMode } = data;
    
    // Fetch tickets by list/project
    let tickets: any[] = [];
    if (provider === 'clickup' && listId) {
        const clickup = this._getClickUpService(resolvedRoot);
        tickets = await clickup.getTasksByList(listId, page);
    } else if (provider === 'linear' && projectId) {
        const linear = this._getLinearService(resolvedRoot);
        tickets = await linear.getIssuesByProject(projectId, page);
    }
    
    // Import each ticket (same concurrency pool as before)
    const ids = tickets.map(t => t.id);
    return this._importByIds(resolvedRoot, { provider, ids, importMode, append });
}
```

**In `PlanningPanelProvider.ts`:**
Update `case 'importAllTickets'` (line 2584) to forward `listId`/`projectId`/`page`/`append` in addition to `ids`:
```typescript
case 'importAllTickets': {
    const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
    const { provider, ids, listId, projectId, workspaceId, page, append, importMode } = msg;
    try {
        const result = await vscode.commands.executeCommand(
            'switchboard.importAllTasks',
            { workspaceRoot, provider, ids, listId, projectId, workspaceId, page, append, importMode }
        );
        // ... same postMessage as before, plus listId/projectId in response
        this._panel?.webview.postMessage({
            type: 'importAllTicketsComplete',
            success: result.success,
            successCount: result.successCount,
            failCount: result.failCount,
            errors: result.errors,
            importMode,
            workspaceRoot,
            provider,
            listId,
            projectId,
            page
        });
    } catch (error) { ... }
    break;
}
```

**In `extension.ts`:** No change needed if `importAllTasks` signature is backward-compatible. The command registration (`switchboard.importAllTasks`) accepts the same object shape with new optional fields.

**`append` behavior**: When `append: true`, skip the folder cleanup step in `_importByIds` so existing local tickets are not deleted before importing the new page.

## Edge Cases
1. **First-time user**: No last-used list config - show empty state with instruction to select a list
2. **List deleted on remote**: Handle gracefully, show error and clear last-used config
3. **Network failure during sync**: Show error, keep local copies intact
4. **Partial sync failure**: Some tickets succeed, some fail - report counts, don't rollback successes
5. **Large lists**: Async with loading state, consider showing progress indicator
6. **Concurrent edits**: If user edits while sync is in progress, handle gracefully

## Testing
1. First-time open: Verify empty state shows "Select a list to sync"
2. Sync after selecting list: Verify tickets import to local, loading state shows
3. Edit local ticket: Verify marked as unpushed
4. Sync with unpushed edits: Verify conflict modal appears
5. Cancel conflict modal: Verify sync doesn't proceed
6. Push from conflict modal: Verify push happens, then sync proceeds
7. Overwrite from conflict modal: Verify sync proceeds, local edits lost
8. Pagination: Verify "Load More" fetches additional pages and appends
9. Re-open tab: Verify last-used list auto-loads
10. Import as Plans: Verify still works as secondary action

## Verification Plan

### Automated Tests
- Skipped per session directive; test suite run separately by user.

### Manual Verification Steps
1. First-time open: Verify empty state shows "Select a list to sync"
2. Sync after selecting list: Verify tickets import to local, loading state shows
3. Edit local ticket: Verify marked as unpushed
4. Sync with unpushed edits: Verify conflict modal appears
5. Cancel conflict modal: Verify sync doesn't proceed
6. Push from conflict modal: Verify push happens, then sync proceeds
7. Overwrite from conflict modal: Verify sync proceeds, local edits lost
8. Pagination: Verify "Load More" fetches additional pages and appends
9. Re-open tab: Verify last-used list auto-loads
10. Import as Plans: Verify still works as secondary action

### Regression Checks
- Existing `saveTicketsState` / `restoreTicketsStateForRoot` round-trip still works after removing `ticketsViewMode`
- `renderMarkdown` output in `#tickets-local-preview` matches `#markdown-preview-tickets` visually
- `switchboard.importAllTasks` with `ids` array still functions for other callers (e.g., kanban bulk import)
- `btn-edit-ticket` online meta bar actions are either removed or correctly hidden when online mode is eliminated

## Review Findings

Reviewer-executor pass completed. **Files changed**: `src/webview/planning.js`, `src/webview/planning.html`, `src/extension.ts`. **Fixes applied**: Removed orphaned `ticketsViewMode` variable and `setTicketsViewMode` function (replaced with `ensureLocalViewVisible`); stripped "Import Doc" buttons from ticket cards; fixed `tickets-local-empty-state` text to remove online-mode references; removed orphaned `.tickets-mode-switch`/`.tickets-mode-btn` CSS block; cleaned `saveTicketsState`/`restoreTicketsStateForRoot` to stop persisting view mode; fixed `resetTicketsInMemoryState` to not reset to `'online'`; updated `extension.ts` command registration type to include new optional fields. **Validation**: No remaining references to `ticketsViewMode`, mode-switch DOM IDs, or `data-import-doc-id` in `planning.js`. **Remaining risks**: `append` parameter in backend `importAllTasks` is accepted but unused (no folder cleanup exists to skip); `pushAllUnpushedTickets` fallback uses `lastIntegrationProvider` for all tickets if `localTickets` cache is stale, which breaks multi-provider pushes.

## Recommendation
Send to Lead Coder
