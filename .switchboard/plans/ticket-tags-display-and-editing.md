# Ticket Tags Display and Editing

## Goal

Add tag display and editing functionality to the planning.html tickets tab for both Linear and ClickUp integrations. Tags should be displayed as pills above the H1 header, and a "Tags" button in the control strip should open a modal for adding/removing tags. Tag changes should sync using existing sync mechanisms.

**Core Problem:** The tickets preview pane renders ticket titles and descriptions but completely omits labels/tags, forcing users to open the external integration to see categorization. There is also no in-app way to re-categorize tickets, which breaks the "stay in the editor" workflow.

**Root Cause:** The `_mapClickUpTaskToSidebar` helper strips tags from the mapped object, and the frontend preview renderers have no tag UI. Linear labels flow through unmapped, but the frontend still never renders them. No message handlers exist for tag mutation on either provider.

## Metadata

**Tags:** ui, feature, frontend, backend  
**Complexity:** 6  
**User Review Required:** Yes — confirm whether ClickUp space tag colors should be preserved when editing (API returns colors but update accepts names only; colors may be lost if tag name is newly created).

## Complexity Audit

### Routine
- Add `tags` field to `_mapClickUpTaskToSidebar` in two providers
- Add tag pill CSS and HTML button to planning.html
- Add modal open/close JS and event listeners
- Add `updateIssueLabels` to `LinearSyncService` following existing `issueUpdate` mutation pattern
- Add message handlers in both providers following existing switch-case patterns
- Render tag pills in `renderTicketsLinearPanel` and `renderTicketsClickUpPanel`

### Complex / Risky
- ClickUp `updateTask` accepts `tags?: string[]` (names only), but the frontend receives full tag objects with colors. Mapping selected objects to name strings without losing newly-created tags requires careful payload construction
- Frontend state shape mismatch: `selectedLinearIssue` is a wrapper `{ issue, subtasks, comments, ... }`, not the issue itself; same for `selectedClickUpIssue` wrapper. Direct property assignments in the plan target the wrong level
- Phase 5 (available tags) requires new backend methods: Linear's `getAutomationCatalog` exists but has no webview message handler; ClickUp has no space-tag fetch method at all
- Cache invalidation after ClickUp tag update is missing from the plan but required to avoid stale sidebar data
- Two integration providers means every backend/frontend change must be implemented twice and tested for cross-provider leakage

## Edge-Case & Dependency Audit

- **Race Conditions:** If user opens tags modal and the provider refreshes in background, available tags array may be stale. Modal should read from latest cached arrays
- **Security:** No new secrets. Existing auth tokens used. Tag names are user-controlled strings; render as textContent (plan already does) to avoid XSS
- **Side Effects:** Tag update mutations modify external tickets. No local file changes. Cache invalidation needed for both providers
- **Dependencies & Conflicts:**
  - Depends on existing `LinearSyncService.issueUpdate` mutation pattern
  - Depends on `ClickUpSyncService.updateTask` public method
  - No conflicts with existing kanban or local docs tabs

## Dependencies

None — this plan introduces no new external libraries or session dependencies.

## Adversarial Synthesis

Key risks: ClickUp type mismatch (object vs string[]), frontend wrapper-state shape bugs, and missing backend endpoints for fetching available tags. Mitigations: map ClickUp selections to `string[]` before sending, mutate `.issue`/`.task` sub-properties, and add explicit `linearLoadAutomationCatalog` / `clickupLoadSpaceTags` message handlers before the modal can be used.

## Implementation Plan

### Phase 1: Backend Data Mapping

**File: `src/services/PlanningPanelProvider.ts`**

1. Update `_mapClickUpTaskToSidebar` to include tags:
```typescript
private _mapClickUpTaskToSidebar(task: any): any {
    return {
        id: task.id,
        title: task.name,
        identifier: task.id,
        status: task.status?.status || 'Unknown',
        statusColor: task.status?.color || '',
        assignees: task.assignees || [],
        description: task.description?.trim() || 'No description provided.',
        markdownDescription: task.markdownDescription || '',
        list: task.list,
        url: task.url,
        parentId: task.parentId || task.parent || null,
        tags: Array.isArray(task.tags) ? task.tags.map((t: any) => ({
            name: String(t?.name || '').trim(),
            tagFg: String(t?.tag_fg || t?.tagFg || '').trim(),
            tagBg: String(t?.tag_bg || t?.tagBg || '').trim()
        })) : []
    };
}
```

**File: `src/services/TaskViewerProvider.ts`**

2. Apply the same change to `_mapClickUpTaskToSidebar` in TaskViewerProvider

### Phase 2: Backend Tag Update Methods

**File: `src/services/LinearSyncService.ts`**

3. Add method to update issue labels:
```typescript
public async updateIssueLabels(issueId: string, labelIds: string[]): Promise<void> {
    const config = await this.loadConfig();
    if (!config?.setupComplete) {
        throw new Error('Linear not configured');
    }

    const normalizedIssueId = String(issueId || '').trim();
    if (!normalizedIssueId) {
        throw new Error('Linear label updates require an issue ID.');
    }

    const result = await this.graphqlRequest(`
        mutation($id: String!, $labelIds: [String!]!) {
            issueUpdate(id: $id, input: { labelIds: $labelIds }) { success }
        }
    `, { id: normalizedIssueId, labelIds });

    if (!result.data?.issueUpdate?.success) {
        throw new Error(`Linear issue ${normalizedIssueId} rejected the requested label update.`);
    }

    // Invalidate cache
    if (this._cacheService) {
        const projectId = this._issueProjectIndex.get(normalizedIssueId);
        if (projectId) {
            this._cacheService.invalidateTaskCache('linear', `project:${projectId}`);
        } else {
            this._cacheService.invalidateTaskCache('linear');
        }
    }
}
```

**File: `src/services/PlanningPanelProvider.ts`**

4. Add message handler for Linear tag updates in the message handler switch:
```typescript
case 'linearUpdateIssueLabels': {
    const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
    const issueId = String(msg.issueId || '').trim();
    const labelIds = Array.isArray(msg.labelIds) ? msg.labelIds : [];
    
    if (!workspaceRoot || !issueId) {
        this._panel?.webview.postMessage({
            type: 'linearError',
            scope: 'task',
            issueId,
            error: 'Invalid issue ID or workspace.',
            workspaceRoot
        });
        break;
    }

    try {
        const linear = this._getLinearService(workspaceRoot);
        await linear.updateIssueLabels(issueId, labelIds);
        this._panel?.webview.postMessage({
            type: 'linearLabelsUpdated',
            issueId,
            labelIds,
            workspaceRoot
        });
    } catch (error) {
        this._panel?.webview.postMessage({
            type: 'linearError',
            scope: 'task',
            issueId,
            error: error instanceof Error ? error.message : String(error),
            workspaceRoot
        });
    }
    break;
}
```

5. Add message handler for ClickUp tag updates:
```typescript
case 'clickupUpdateTaskTags': {
    const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
    const taskId = String(msg.taskId || '').trim();
    const rawTags = Array.isArray(msg.tags) ? msg.tags : [];
    // ClickUp updateTask accepts tags?: string[] — extract names
    const tagNames = rawTags.map((t: any) => typeof t === 'string' ? t : String(t?.name || '')).filter(Boolean);

    if (!workspaceRoot || !taskId) {
        this._panel?.webview.postMessage({
            type: 'clickupError',
            scope: 'task',
            taskId,
            error: 'Invalid task ID or workspace.',
            workspaceRoot
        });
        break;
    }

    try {
        const clickUp = this._getClickUpService(workspaceRoot);
        await clickUp.updateTask(taskId, { tags: tagNames });
        // Invalidate ClickUp cache to prevent stale sidebar data
        const listId = clickUp['_taskListIndex']?.get(taskId);
        if (clickUp['_cacheService']) {
            if (listId) {
                clickUp['_cacheService'].invalidateTaskCache('clickup', listId);
            } else {
                clickUp['_cacheService'].invalidateTaskCache('clickup');
            }
        }
        this._panel?.webview.postMessage({
            type: 'clickupTagsUpdated',
            taskId,
            tags: tagNames,
            workspaceRoot
        });
    } catch (error) {
        this._panel?.webview.postMessage({
            type: 'clickupError',
            scope: 'task',
            taskId,
            error: error instanceof Error ? error.message : String(error),
            workspaceRoot
        });
    }
    break;
}
```

**File: `src/services/TaskViewerProvider.ts`**

6. Add the same message handlers to TaskViewerProvider for the sidebar view

### Phase 3: Frontend HTML Changes

**File: `src/webview/planning.html`**

7. Add "Tags" button to the tickets control strip (in the first controls-strip-row):
```html
<button id="tickets-tags" class="strip-btn" disabled title="Edit tags">Tags</button>
```

8. Add tags display container in the preview pane (above the markdown-preview-tickets):
```html
<div id="tickets-tags-display" style="display: none; padding: 12px 16px 8px 16px; gap: 6px; flex-wrap: wrap;"></div>
```

9. Add tags modal HTML (after create-ticket-modal):
```html
<div class="folder-modal" id="tags-modal" style="display: none;" role="dialog" aria-modal="true" aria-labelledby="tags-modal-title">
    <div class="modal-content" style="max-width: 500px;">
        <div class="modal-header">
            <h3 id="tags-modal-title">Edit Tags</h3>
            <button class="modal-close-btn" id="btn-close-tags-modal" aria-label="Close">&times;</button>
        </div>
        <div class="modal-body" style="margin-top: 10px;">
            <div style="display: flex; flex-direction: column; gap: 12px;">
                <div>
                    <label style="font-size: 11px; text-transform: uppercase; color: var(--text-secondary); display: block; margin-bottom: 8px;">Available Tags</label>
                    <div id="tags-available-list" style="display: flex; flex-direction: column; gap: 6px; max-height: 300px; overflow-y: auto;"></div>
                </div>
                <div style="display: flex; justify-content: flex-end; gap: 8px; margin-top: 12px;">
                    <button id="btn-cancel-tags" class="strip-btn">Cancel</button>
                    <button id="btn-save-tags" class="planning-button" style="margin: 0; padding: 4px 12px;">Save</button>
                </div>
            </div>
        </div>
    </div>
</div>
```

10. Add CSS for tag pills and modal (in the style section):
```css
/* Tag pills */
.ticket-tag-pill {
    display: inline-flex;
    align-items: center;
    padding: 3px 8px;
    border-radius: 12px;
    font-size: 10px;
    font-weight: 500;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    border: 1px solid transparent;
    background: var(--panel-bg2);
    color: var(--text-secondary);
}

.ticket-tag-pill.clickup {
    background: var(--tag-bg, var(--panel-bg2));
    color: var(--tag-fg, var(--text-secondary));
    border-color: var(--tag-bg, var(--border-color));
}

.ticket-tag-pill.linear {
    background: var(--accent-teal-dim);
    color: var(--accent-teal);
    border-color: var(--accent-teal-dim);
}

/* Tags modal checkbox styling */
.tag-checkbox-item {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 8px;
    border-radius: 4px;
    cursor: pointer;
    transition: background 0.15s;
}

.tag-checkbox-item:hover {
    background: var(--card-bg-hover);
}

.tag-checkbox-item input[type="checkbox"] {
    margin: 0;
    cursor: pointer;
}

.tag-checkbox-label {
    font-size: 12px;
    color: var(--text-primary);
}
```

### Phase 4: Frontend JavaScript Changes

**File: `src/webview/planning.js`**

11. Add state variables for tags:
```javascript
let currentTicketTags = [];
let availableLinearLabels = [];
let availableClickUpTags = [];
```

12. Add function to render tag pills:
```javascript
function renderTicketTags(tags, provider) {
    const container = document.getElementById('tickets-tags-display');
    if (!container) return;
    
    container.innerHTML = '';
    container.style.display = 'flex';
    
    if (!tags || tags.length === 0) {
        container.style.display = 'none';
        return;
    }
    
    tags.forEach(tag => {
        const pill = document.createElement('span');
        pill.className = `ticket-tag-pill ${provider}`;
        
        if (provider === 'clickup' && tag.tagFg && tag.tagBg) {
            pill.style.setProperty('--tag-fg', tag.tagFg);
            pill.style.setProperty('--tag-bg', tag.tagBg);
        }
        
        pill.textContent = tag.name || tag;
        container.appendChild(pill);
    });
}
```

13. Add function to open tags modal:
```javascript
function openTagsModal() {
    const modal = document.getElementById('tags-modal');
    const availableList = document.getElementById('tags-available-list');
    
    if (!modal || !availableList) return;
    
    availableList.innerHTML = '';
    
    const provider = lastIntegrationProvider;
    const availableTags = provider === 'linear' ? availableLinearLabels : availableClickUpTags;
    
    if (availableTags.length === 0) {
        availableList.innerHTML = '<div style="color: var(--text-secondary); font-size: 12px; padding: 8px;">No tags available</div>';
    } else {
        availableTags.forEach(tag => {
            const item = document.createElement('label');
            item.className = 'tag-checkbox-item';
            
            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.value = provider === 'linear' ? tag.id : tag.name;
            
            const currentTagNames = currentTicketTags.map(t => t.name || t);
            checkbox.checked = currentTagNames.includes(tag.name);
            
            const label = document.createElement('span');
            label.className = 'tag-checkbox-label';
            label.textContent = tag.name;
            
            item.appendChild(checkbox);
            item.appendChild(label);
            availableList.appendChild(item);
        });
    }
    
    modal.style.display = 'flex';
}
```

14. Add function to save tags:
```javascript
function saveTags() {
    const modal = document.getElementById('tags-modal');
    const availableList = document.getElementById('tags-available-list');

    if (!modal || !availableList) return;

    const checkboxes = availableList.querySelectorAll('input[type="checkbox"]:checked');
    const selectedIds = Array.from(checkboxes).map(cb => cb.value);

    const provider = lastIntegrationProvider;
    // State wrappers: selectedLinearIssue.issue.id / selectedClickUpIssue.task.id
    const ticketId = provider === 'linear'
        ? selectedLinearIssue?.issue?.id
        : selectedClickUpIssue?.task?.id;

    if (!ticketId) {
        showTicketsStatus('No ticket selected', true);
        return;
    }

    if (provider === 'linear') {
        vscode.postMessage({
            type: 'linearUpdateIssueLabels',
            issueId: ticketId,
            labelIds: selectedIds,
            workspaceRoot: ticketsWorkspaceRoot
        });
    } else {
        // For ClickUp, checkbox values are already tag names (string[])
        vscode.postMessage({
            type: 'clickupUpdateTaskTags',
            taskId: ticketId,
            tags: selectedIds,
            workspaceRoot: ticketsWorkspaceRoot
        });
    }

    modal.style.display = 'none';
}
```

15. Update `renderTicketsLinearPanel` to:
   - Enable the Tags button when a ticket is selected (`document.getElementById('tickets-tags').disabled = !selectedLinearIssue`)
   - Render tags from `selectedLinearIssue.issue.labels` via `renderTicketTags(selectedLinearIssue.issue.labels, 'linear')`
   - Store available labels from the Linear team in `availableLinearLabels`

16. Update `renderTicketsClickUpPanel` to:
   - Enable the Tags button when a ticket is selected (`document.getElementById('tickets-tags').disabled = !selectedClickUpIssue`)
   - Render tags from `selectedClickUpIssue.task.tags` via `renderTicketTags(selectedClickUpIssue.task.tags, 'clickup')`
   - Store available tags from ClickUp space in `availableClickUpTags`

17. Add event listeners for the Tags button and modal:
```javascript
// Tags button
document.getElementById('tickets-tags')?.addEventListener('click', openTagsModal);

// Modal close buttons
document.getElementById('btn-close-tags-modal')?.addEventListener('click', () => {
    document.getElementById('tags-modal').style.display = 'none';
});
document.getElementById('btn-cancel-tags')?.addEventListener('click', () => {
    document.getElementById('tags-modal').style.display = 'none';
});
document.getElementById('btn-save-tags')?.addEventListener('click', saveTags);
document.getElementById('tags-modal')?.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) {
        e.currentTarget.style.display = 'none';
    }
});
```

18. Add message handlers for tag update responses:
```javascript
case 'linearLabelsUpdated':
    if (selectedLinearIssue && selectedLinearIssue.issue?.id === msg.issueId) {
        // Re-fetch to get updated label objects
        loadLinearTaskDetails(msg.issueId);
    }
    showTicketsStatus('Labels updated successfully');
    break;

case 'clickupTagsUpdated':
    if (selectedClickUpIssue && selectedClickUpIssue.task?.id === msg.taskId) {
        selectedClickUpIssue.task.tags = msg.tags || [];
        renderTicketTags(selectedClickUpIssue.task.tags, 'clickup');
    }
    showTicketsStatus('Tags updated successfully');
    break;
```

### Phase 5: Fetch Available Tags (Backend + Frontend)

19. Add `linearLoadAutomationCatalog` message handler in `PlanningPanelProvider.ts` and `TaskViewerProvider.ts`:
```typescript
case 'linearLoadAutomationCatalog': {
    const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
    if (!workspaceRoot) { break; }
    try {
        const linear = this._getLinearService(workspaceRoot);
        const catalog = await linear.getAutomationCatalog();
        this._panel?.webview.postMessage({
            type: 'linearAutomationCatalogLoaded',
            labels: catalog.labels,
            workspaceRoot
        });
    } catch (error) {
        this._panel?.webview.postMessage({
            type: 'linearError',
            scope: 'task',
            error: error instanceof Error ? error.message : String(error),
            workspaceRoot
        });
    }
    break;
}
```

20. Add `getSpaceTags` to `ClickUpSyncService.ts`:
```typescript
public async getSpaceTags(spaceId: string): Promise<Array<{ name: string; tagFg: string; tagBg: string }>> {
    const config = await this.loadConfig();
    if (!config?.setupComplete || !config.workspaceId) {
        throw new Error('ClickUp not configured');
    }
    const normalizedSpaceId = String(spaceId || '').trim();
    if (!normalizedSpaceId) {
        throw new Error('Space ID required');
    }
    const result = await this.httpRequest('GET', `/space/${normalizedSpaceId}/tag`);
    const tags = Array.isArray(result.data?.tags) ? result.data.tags : [];
    return tags.map((tag: any) => ({
        name: String(tag?.name || '').trim(),
        tagFg: String(tag?.tag_fg || tag?.tagFg || '').trim(),
        tagBg: String(tag?.tag_bg || tag?.tagBg || '').trim()
    })).filter((t: { name: string }) => t.name.length > 0);
}
```

21. Add `clickupLoadSpaceTags` message handler in `PlanningPanelProvider.ts` and `TaskViewerProvider.ts`:
```typescript
case 'clickupLoadSpaceTags': {
    const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
    const spaceId = String(msg.spaceId || '').trim();
    if (!workspaceRoot || !spaceId) { break; }
    try {
        const clickUp = this._getClickUpService(workspaceRoot);
        const tags = await clickUp.getSpaceTags(spaceId);
        this._panel?.webview.postMessage({
            type: 'clickupSpaceTagsLoaded',
            tags,
            workspaceRoot
        });
    } catch (error) {
        this._panel?.webview.postMessage({
            type: 'clickupError',
            scope: 'task',
            error: error instanceof Error ? error.message : String(error),
            workspaceRoot
        });
    }
    break;
}
```

22. Frontend: in `planning.js`, add message handlers for catalog responses:
```javascript
case 'linearAutomationCatalogLoaded':
    availableLinearLabels = msg.labels || [];
    break;

case 'clickupSpaceTagsLoaded':
    availableClickUpTags = msg.tags || [];
    break;
```

23. Frontend: trigger fetches after loading projects/spaces:
    - In the `linearProjectLoaded` handler, post `linearLoadAutomationCatalog`
    - In the `clickupSpacesLoaded` handler, post `clickupLoadSpaceTags` with the first space ID (or selected space)

## Edge Cases

1. **No tags available**: Show "No tags available" message in modal
2. **Network errors during tag update**: Show error message in status bar
3. **Ticket without tags**: Hide the tags display container
4. **Permission errors**: Linear/ClickUp will return errors, display to user
5. **Large number of tags**: Add max-height and scroll to the modal list
6. **Tag colors**: Use ClickUp's tagFg/tagBg colors, use accent color for Linear

## Testing

1. Test with Linear integration:
   - Verify labels display above H1
   - Verify modal opens and shows available labels
   - Verify adding/removing labels works
   - Verify sync happens when "Sync changes" is clicked

2. Test with ClickUp integration:
   - Verify tags display with correct colors
   - Verify modal opens and shows available tags
   - Verify adding/removing tags works
   - Verify sync happens when "Sync changes" is clicked

3. Test edge cases:
   - Ticket with no tags
   - Integration with no available tags
   - Network errors during update
   - Switching between Linear and ClickUp

## Proposed Changes

### `src/services/PlanningPanelProvider.ts`
- **Context:** Central message router between webview and integration services.
- **Logic:** Add `tags` to `_mapClickUpTaskToSidebar`; add `linearUpdateIssueLabels`, `clickupUpdateTaskTags`, `linearLoadAutomationCatalog`, and `clickupLoadSpaceTags` case handlers in the message switch.
- **Implementation:** Follow existing normalization and error-posting patterns. ClickUp tag update extracts names from objects before calling `updateTask`.
- **Edge Cases:** Missing workspaceRoot or IDs handled with early error posts; ClickUp cache invalidated via `_taskListIndex` after update.

### `src/services/TaskViewerProvider.ts`
- **Context:** Sidebar variant of the planning panel; mirrors PlanningPanelProvider message handlers.
- **Logic:** Duplicate the same four message handlers and `_mapClickUpTaskToSidebar` tag mapping.
- **Implementation:** Copy-paste-adapt from PlanningPanelProvider; use `this._view?.webview.postMessage` instead of `this._panel`.
- **Edge Cases:** Same as PlanningPanelProvider.

### `src/services/LinearSyncService.ts`
- **Context:** Linear GraphQL API wrapper.
- **Logic:** Add `updateIssueLabels` mutation method and expose `getAutomationCatalog` to webview via new message handler.
- **Implementation:** Reuse `graphqlRequest`, `loadConfig`, and cache-invalidation patterns already present for state updates.
- **Edge Cases:** Empty `labelIds` array is valid (removes all labels); invalid issue ID throws before network call.

### `src/services/ClickUpSyncService.ts`
- **Context:** ClickUp REST API wrapper.
- **Logic:** Add `getSpaceTags` method to fetch space-level tag definitions.
- **Implementation:** `httpRequest('GET', \`/space/\${spaceId}/tag\`)`; normalize response casing (`tag_fg` vs `tagFg`).
- **Edge Cases:** Space ID missing or empty throws early; non-200 responses fall through to existing error handling.

### `src/webview/planning.html`
- **Context:** Tickets tab UI markup and styles.
- **Logic:** Add Tags button, tags display container above markdown preview, tags modal, and tag-pill CSS.
- **Implementation:** Reuse `.folder-modal` and `.strip-btn` patterns; modal placed after `create-ticket-modal`.
- **Edge Cases:** Container defaults to `display: none`; modal has `max-height` and `overflow-y: auto` for long tag lists.

### `src/webview/planning.js`
- **Context:** Tickets tab frontend state and rendering.
- **Logic:** Add tag state variables, `renderTicketTags`, modal open/save functions, event listeners, and message handlers. Fix state-shape references (`selectedLinearIssue.issue.labels`, `selectedClickUpIssue.task.tags`).
- **Implementation:** Tag pills rendered via DOM; modal uses checkboxes against `availableLinearLabels` / `availableClickUpTags`.
- **Edge Cases:** ClickUp update sends `string[]` names only; Linear update sends `labelIds`; both refresh local state after success.

## Verification Plan

### Automated Tests
- **Skipped per session directive.** No compilation or test execution performed.
- **Recommended post-implementation tests:**
  1. Linear: load project, select issue, verify labels render, open modal, toggle labels, save, confirm `issueUpdate` mutation called with correct `labelIds`.
  2. ClickUp: load space, select task, verify tags render with colors, open modal, toggle tags, save, confirm `updateTask` called with `tags: string[]`, confirm cache invalidation fires.
  3. Switch provider while modal is open — modal should close or refresh with new available tags.
  4. Offline/error path: verify `linearError` / `clickupError` messages display in status bar.

## Files Changed

- `src/services/PlanningPanelProvider.ts`
- `src/services/TaskViewerProvider.ts`
- `src/services/LinearSyncService.ts`
- `src/services/ClickUpSyncService.ts`
- `src/webview/planning.html`
- `src/webview/planning.js`

**Recommendation:** Complexity is 6 → Send to Coder.
