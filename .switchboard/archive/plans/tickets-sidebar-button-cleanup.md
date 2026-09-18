# Clean Up Tickets Tab Sidebar Buttons

## Goal
Remove unnecessary buttons from ticket cards in the planning.html tickets tab sidebar, improve button labels for clarity, and add bulk actions for the tickets tab.

## Metadata
**Tags:** ui, frontend, bugfix
**Complexity:** 5

## User Review Required
- Confirm "Sync changes" scope: push ALL local ticket files back to integration, not just visible ones.
- Confirm "Link all" expected behavior: copy absolute file paths or relative paths?
- Approve removal of REFINE and Import Doc buttons (no replacement functionality).

## Complexity Audit

### Routine
- Remove REFINE button HTML and event handlers.
- Remove Import Doc button HTML and event handlers.
- Rename "Import Plan" to "Add to kanban" label change.
- Rename "Refresh" to "Refetch" label change.
- Rename and move "Import as Plans" button to sidebar header.

### Complex / Risky
- Add "Link to ticket" button with backend file search and VS Code open logic.
- Add "Sync changes" bulk push with per-ticket error handling and sequential integration API calls.
- Add "Link all" bulk clipboard copy with backend filesystem walk.
- Coordinate DOM element reference updates in `getTicketsTabElements` and CSS selector updates for moved button.

## Edge-Case & Dependency Audit

- **Race Conditions:** "Sync changes" pushes tickets sequentially; rapid clicks could queue overlapping syncs. Button should disable during operation.
- **Security:** `openLocalTicket` searches `.switchboard/tickets/` with `startsWith` matching; no path traversal risk since directory is controlled, but ambiguous matches if multiple files share prefix open arbitrary first match.
- **Side Effects:** "Sync changes" reads every `.md` file in ticket dirs and pushes to remote; unsaved in-memory edits not flushed to disk will be ignored.
- **Dependencies & Conflicts:** Depends on existing `switchboard.pushTicketEdits` command (plan incorrectly references non-existent `_pushLinearTicket` / `_pushClickUpTicket`). CSS selector `#controls-strip-tickets.tickets-local-mode #btn-import-all-plans` must update to new button ID. `getTicketsTabElements` must include new button references.

## Dependencies
- Existing `vscode.commands.executeCommand('switchboard.pushTicketEdits')` backend command.
- Existing `_getTicketDocumentDirs` helper in `PlanningPanelProvider.ts`.
- Existing `vscode.env.clipboard.writeText` API.

## Adversarial Synthesis
Key risks: invented `_pushLinearTicket` / `_pushClickUpTicket` methods do not exist and must use the real `switchboard.pushTicketEdits` command; missing per-ticket error handling in `syncAllTickets` causes single failure to abort entire batch. Mitigations: use existing command wrapper, wrap each push in try/catch with aggregated results.

## Background & Problem Analysis
The tickets tab sidebar currently displays three buttons on each ticket card:
1. **REFINE** - Previously requested for removal but still present
2. **Import Doc** - Meaningless since docs are already imported when the full ticket list loads
3. **Import Plan** - Unclear label, should be "Add to kanban"

Additionally:
- There is no button to link to the local ticket file for quick access
- The "Refresh" button label is unclear - should be "Refetch"
- There is no bulk action to push all local ticket changes back to the integration
- There is no bulk action to copy all ticket file paths to clipboard
- The "Import as Plans" button should be renamed and moved to the sidebar header

## Requirements
- Remove the REFINE button from both Linear and ClickUp ticket cards
- Remove the Import Doc button from both Linear and ClickUp ticket cards
- Rename "Import Plan" button to "Add to kanban" for both Linear and ClickUp ticket cards
- Add a new "Link to ticket" button that opens the local ticket file in VS Code
- Rename "Refresh" button to "Refetch"
- Add a "Sync changes" button that pushes all local ticket changes back to the integration
- Add a "Link all" button at the top of the sidebar that copies all ticket file paths to clipboard
- Rename "Import as Plans" button to "Import all to kanban" and move it to the sidebar header
- Ensure "Link all", "Import all to kanban", and the sidebar collapse button are on the same row

## Proposed Changes

### 1. Remove REFINE button
**File**: `src/webview/planning.js`

**Location 1 - Linear tickets (line ~5810)**:
```javascript
// Remove this line:
<button type="button" class="card-icon-btn" data-refine-issue-id="${escapeAttr(issue.id)}" data-issue-title="${escapeAttr(issue.title || '')}" data-issue-description="${escapeAttr(issue.description || '')}">REFINE</button>
```

**Location 2 - ClickUp tickets (line ~6236)**:
```javascript
// Remove this line:
<button type="button" class="card-icon-btn" data-refine-task-id="${escapeAttr(task.id)}" data-issue-title="${escapeAttr(task.title || '')}" data-issue-description="${escapeAttr(task.markdownDescription || task.description || '')}">REFINE</button>
```

**Cleanup**: Remove associated event handlers for refine buttons (lines ~5311-5319, ~5372-5379, and the `handleTicketsRefine` function at ~6423).

### 2. Remove Import Doc button
**File**: `src/webview/planning.js`

**Location 1 - Linear tickets (line ~5812)**:
```javascript
// Remove this line:
<button type="button" class="card-icon-btn" data-import-doc-id="${escapeAttr(issue.id)}" data-provider="linear">Import Doc</button>
```

**Location 2 - ClickUp tickets (line ~6238)**:
```javascript
// Remove this line:
<button type="button" class="card-icon-btn" data-import-doc-id="${escapeAttr(task.id)}" data-provider="clickup">Import Doc</button>
```

**Cleanup**: Remove associated event handlers for import-doc buttons (lines ~5374-5389).

### 3. Rename Import Plan to "Add to kanban"
**File**: `src/webview/planning.js`

**Location 1 - Linear tickets (line ~5811)**:
```javascript
// Change from:
<button type="button" class="card-icon-btn" data-import-plan-id="${escapeAttr(issue.id)}" data-provider="linear">Import Plan</button>
// To:
<button type="button" class="card-icon-btn" data-import-plan-id="${escapeAttr(issue.id)}" data-provider="linear">Add to kanban</button>
```

**Location 2 - ClickUp tickets (line ~6237)**:
```javascript
// Change from:
<button type="button" class="card-icon-btn" data-import-plan-id="${escapeAttr(task.id)}" data-provider="clickup">Import Plan</button>
// To:
<button type="button" class="card-icon-btn" data-import-plan-id="${escapeAttr(task.id)}" data-provider="clickup">Add to kanban</button>
```

### 4. Add Link to ticket button
**File**: `src/webview/planning.js`

**Add to Linear tickets (after line ~5811)**:
```javascript
<button type="button" class="card-icon-btn" data-link-ticket-id="${escapeAttr(issue.id)}" data-provider="linear">Link to ticket</button>
```

**Add to ClickUp tickets (after line ~6237)**:
```javascript
<button type="button" class="card-icon-btn" data-link-ticket-id="${escapeAttr(task.id)}" data-provider="clickup">Link to ticket</button>
```

**Add event handler (in the click delegation section, around line ~5373)**:
```javascript
const linkTicketBtn = e.target.closest('[data-link-ticket-id]');
if (linkTicketBtn) {
    const id = linkTicketBtn.dataset.linkTicketId;
    const provider = linkTicketBtn.dataset.provider;
    handleLinkToTicket(provider, id);
}
```

**Add handler function**:
```javascript
function handleLinkToTicket(provider, id) {
    // Determine the expected local file path based on provider and id
    // File pattern: {provider}_{id}_{title}.md
    // Need to search in the tickets folder for matching file
    vscode.postMessage({
        type: 'openLocalTicket',
        provider,
        id
    });
}
```

**Backend handler in `src/services/PlanningPanelProvider.ts`**:
Add a new case in the message handler:
```typescript
case 'openLocalTicket': {
    const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
    const provider = msg.provider;
    const id = msg.id;

    if (workspaceRoot) {
        for (const dir of this._getTicketDocumentDirs(workspaceRoot, provider)) {
            if (!fs.existsSync(dir)) { continue; }
            const files = fs.readdirSync(dir);
            const match = files.find(f => f.startsWith(`${provider}_${id}_`));
            if (match) {
                const filePath = path.join(dir, match);
                vscode.workspace.openTextDocument(filePath).then(doc => vscode.window.showTextDocument(doc.uri));
                break;
            }
        }
    }
    break;
}
```

### 5. Rename "Refresh" to "Refetch"
**File**: `src/webview/planning.html`

**Location (line ~3192)**:
```html
<!-- Change from: -->
<button id="tickets-refresh" class="strip-btn" title="Re-fetch from source and save local copies">Refresh</button>
<!-- To: -->
<button id="tickets-refresh" class="strip-btn" title="Re-fetch from source and save local copies">Refetch</button>
```

### 6. Add "Sync changes" button
**File**: `src/webview/planning.html`

**Location (in controls-strip-tickets, after the Refetch button, line ~3193)**:
```html
<button id="tickets-sync-all" class="strip-btn" title="Push all local ticket changes back to the integration">Sync changes</button>
```

**File**: `src/webview/planning.js`

**Add to element references (around line ~276)**:
```javascript
syncAllButton: document.getElementById('tickets-sync-all'),
```

**Add event handler (around line ~5304)**:
```javascript
syncAllButton?.addEventListener('click', () => {
    setTicketsLoadingState(true);
    vscode.postMessage({
        type: 'syncAllTickets',
        provider: lastIntegrationProvider,
        workspaceRoot: ticketsWorkspaceRoot
    });
});
```

**Backend handler in `src/services/PlanningPanelProvider.ts`**:
Add a new case in the message handler:
```typescript
case 'syncAllTickets': {
    const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
    const provider = msg.provider;
    const results = { succeeded: 0, failed: 0, errors: [] as string[] };
    
    if (workspaceRoot) {
        const tickets: any[] = [];
        for (const dir of this._getTicketDocumentDirs(workspaceRoot, provider)) {
            if (!fs.existsSync(dir)) { continue; }
            const files = fs.readdirSync(dir);
            for (const fileName of files) {
                const match = fileName.match(/^(linear|clickup)_([^_]+)_(.*)\.md$/);
                if (!match || match[1] !== provider) { continue; }
                const filePath = path.join(dir, fileName);
                const content = fs.readFileSync(filePath, 'utf8');
                tickets.push({ id: match[2], content, filePath });
            }
        }
        
        for (const ticket of tickets) {
            try {
                const result: any = await vscode.commands.executeCommand(
                    'switchboard.pushTicketEdits',
                    { workspaceRoot, provider, id: ticket.id }
                );
                if (result?.success) {
                    results.succeeded++;
                } else {
                    results.failed++;
                    results.errors.push(`${ticket.id}: ${result?.error || 'Unknown error'}`);
                }
            } catch (err) {
                results.failed++;
                results.errors.push(`${ticket.id}: ${err instanceof Error ? err.message : String(err)}`);
            }
        }
        
        this._panel?.webview.postMessage({
            type: 'syncAllTicketsResult',
            success: results.failed === 0,
            count: tickets.length,
            succeeded: results.succeeded,
            failed: results.failed,
            errors: results.errors
        });
    }
    break;
}
```

### 7. Add "Link all" button
**File**: `src/webview/planning.html`

**Location (in tree-pane-tickets sidebar, in the sidebar-toggle-row, around line ~3202)**:
```html
<div class="sidebar-toggle-row">
    <button id="tickets-link-all" class="strip-btn" title="Copy all ticket file paths to clipboard">Link all</button>
    <button id="tickets-import-all-kanban" class="strip-btn" title="Import all tickets as Switchboard plans">Import all to kanban</button>
    <button class="sidebar-toggle-btn" title="Toggle sidebar">«</button>
</div>
```

**File**: `src/webview/planning.js`

**Add to element references (around line ~276)**:
```javascript
linkAllButton: document.getElementById('tickets-link-all'),
importAllKanbanButton: document.getElementById('tickets-import-all-kanban'),
```

**Add event handler (around line ~5304)**:
```javascript
linkAllButton?.addEventListener('click', () => {
    vscode.postMessage({
        type: 'copyToClipboard',
        provider: lastIntegrationProvider,
        workspaceRoot: ticketsWorkspaceRoot
    });
});
```

**Backend handler in `src/services/PlanningPanelProvider.ts`**:
Add a new case in the message handler:
```typescript
case 'copyToClipboard': {
    const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
    const provider = msg.provider;
    const paths: string[] = [];
    if (workspaceRoot) {
        for (const dir of this._getTicketDocumentDirs(workspaceRoot, provider)) {
            if (!fs.existsSync(dir)) { continue; }
            const files = fs.readdirSync(dir);
            for (const fileName of files) {
                if (fileName.match(/^(linear|clickup)_([^_]+)_(.*)\.md$/)) {
                    paths.push(path.join(dir, fileName));
                }
            }
        }
    }
    await vscode.env.clipboard.writeText(paths.join('\n'));
    break;
}
```

### 8. Rename and move "Import as Plans" button
**File**: `src/webview/planning.html`

**Remove from controls-strip-tickets (line ~3193)**:
```html
<!-- Remove this line: -->
<button id="btn-import-all-plans" class="strip-btn" style="display:none" title="Import all tickets as Switchboard plans">Import as Plans</button>
```

**Add to sidebar-toggle-row (as shown in step 7 above)** with new ID and label:
```html
<button id="tickets-import-all-kanban" class="strip-btn" title="Import all tickets as Switchboard plans">Import all to kanban</button>
```

**File**: `src/webview/planning.js`

**Update element reference (line ~285)**:
```javascript
// Change from:
btnImportAllPlans: document.getElementById('btn-import-all-plans'),
// To:
importAllKanbanButton: document.getElementById('tickets-import-all-kanban'),
```

**Update event handler references (lines ~2962, ~5111, ~5945)**:
Replace all `btnImportAllPlans` with `importAllKanbanButton`.

### 9. Ensure sidebar header buttons are on same row
**File**: `src/webview/planning.html`

The sidebar-toggle-row structure (from step 7) already places all three buttons on the same row. Verify the CSS for `.sidebar-toggle-row` uses `display: flex` and `gap` for proper spacing.

**CSS check (line ~242 in planning.html)**:
```css
.sidebar-toggle-row {
    display: flex;
    justify-content: flex-end;
    align-items: center;
    gap: 8px;
    margin-bottom: 8px;
}
```

This should already handle the layout. If adjustments are needed, modify the gap or justify-content values.

**CSS Update**: In `src/webview/planning.html`, update the selector `#controls-strip-tickets.tickets-local-mode #btn-import-all-plans` to `#controls-strip-tickets.tickets-local-mode #tickets-import-all-kanban`.
**Visibility**: Ensure `renderTicketsLinearPanel` also sets `importAllKanbanButton.style.display` appropriately (currently only `renderTicketsClickUpPanel` controls it).

## Verification Plan

### Automated Tests
- N/A (UI changes in webview; manual verification via VS Code extension host).
- Verify button removals: no REFINE or Import Doc buttons rendered on Linear/ClickUp cards.
- Verify renames: "Add to kanban", "Refetch", "Import all to kanban" labels present.
- Verify "Link to ticket" opens correct local `.md` file for both providers.
- Verify "Sync changes" pushes all local tickets and reports success/failure count.
- Verify "Link all" copies non-empty path list when in local view.
- Verify sidebar header buttons ("Link all", "Import all to kanban", collapse) are on same row.

**Recommendation:** Send to Coder

## Review Findings

Files changed: `src/services/PlanningPanelProvider.ts` (1 fix applied).

Validation: No orphaned references to removed buttons (`btn-import-all-plans`, `data-refine`, `data-import-doc`) found across the `src` tree. All renamed element references (`importAllKanbanButton`, `linkAllButton`, `syncAllButton`) are wired in `initTicketsTab` and returned by `getTicketsTabElements`. CSS selector updated to `#tree-pane-tickets.tickets-local-mode #tickets-import-all-kanban`. Backend handlers for `openLocalTicket`, `syncAllTickets`, and `copyToClipboard` are present and match the plan.

Fix applied: Added `syncAllTicketsResult` fallback in `PlanningPanelProvider.ts` when `workspaceRoot` is unresolved, preventing the webview loading state and sync button from getting stuck disabled.

Remaining risks: `syncAllTickets` reads every ticket file's `content` into memory but never uses it (harmless waste). `openLocalTicket` uses `startsWith` file matching which can return ambiguous matches if ticket IDs share prefixes.
