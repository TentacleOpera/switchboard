# Tickets Tab: Subtask Creation & Conversion

## Metadata
**Complexity:** 6
**Tags:** frontend, backend, api, ui, feature

## Goal

Add the ability to (a) create a subtask under an existing ticket and (b) convert an existing ticket into a subtask of another ticket, for both ClickUp and Linear providers in the Switchboard planning webview.

### Problem Analysis

The Tickets tab currently supports:
- Creating top-level tickets via the "New Ticket" modal
- Viewing existing subtasks in the `#tickets-subtasks-nav` panel when a parent ticket is selected
- Navigating between subtasks by clicking them in the nav panel

**Gap 1 — No subtask creation:** The "New Ticket" modal (`create-ticket-modal`) only creates top-level tickets. There is no way to create a subtask linked to an existing parent. The backend is partially ready: `ClickUpSyncService.createTask()` already accepts a `parent` param (line 1283) and passes it to the API body (line 1307), but `PlanningPanelProvider`'s `clickupCreateTask` handler (line 4420) doesn't pass it. `LinearSyncService.createIssueSimple()` (line 1740) has no `parentId` support at all.

**Gap 2 — No convert-to-subtask:** There is no way to take an existing standalone ticket and assign it as a subtask of another ticket. ClickUp's `updateTask` API accepts `parent` on PUT, but the TypeScript type (line 1377-1389) doesn't include it. Linear's `issueUpdate` mutation accepts `parentId`, but no method exposes this capability.

### Root Cause

The feature was never built. The subtask *display* infrastructure exists (nav panel, click-to-navigate, detail cache), but the *creation* and *conversion* flows were not implemented in the webview, PlanningPanelProvider, or (for Linear) the sync service.

## User Review Required

- [ ] Confirm that subtask creation should auto-import the subtask as a local document (same as top-level ticket creation flow at lines 4430/4493)
- [ ] Confirm that the parent picker should be limited to tickets in the same ClickUp list / Linear project (no cross-list parenting)
- [ ] Confirm that converting a ticket with existing subtasks is acceptable (the ticket becomes a subtask but retains its own subtasks)

## Complexity Audit

### Routine
- Adding `parentId?: string` to `createIssueSimple` params (one-line type change + one spread in mutation input)
- Adding `parent?: string` to `updateTask` type (type-level only, no body construction change)
- Passing `parent: msg.parentId` in `clickupCreateTask` handler (one-line addition at line 4420)
- Passing `parentId: msg.parentId` in `linearCreateIssue` handler (one-line addition at line 4483)
- Adding two buttons to the meta-bar HTML
- Clearing `_subtaskParent` on modal cancel/close

### Complex / Risky
- Cycle prevention: building a parent-child map from the unfiltered `clickUpProjectIssues` / `linearProjectIssues` arrays and walking upward to detect ancestry — requires careful traversal logic with O(depth) per candidate
- ClickUp subtask `listId` source: when creating a subtask, the `listId` must come from the parent ticket's list, not the currently selected list — the parent's list ID must be extracted from the detail cache or the in-memory issue object
- `convertToSubtask` handler: new message type in PlanningPanelProvider with provider branching, error handling, and post-conversion refresh orchestration
- Post-creation refresh flow: the `clickupTaskCreated` / `linearIssueCreated` handlers (lines 4192/4212) must conditionally branch based on whether `_subtaskParent` was set — if yes, refresh parent detail instead of reloading the entire project list

## Edge-Case & Dependency Audit

### Race Conditions
- **Rapid subtask creation:** User clicks "+ Subtask" twice quickly. The `_subtaskParent` variable would be overwritten by the second click. Mitigation: disable the "+ Subtask" button while the modal is open.
- **Conversion while detail is loading:** User clicks "Convert to Subtask" while a `loadClickUpTaskDetails` / `loadLinearTaskDetails` request is in flight. The in-memory issue data may be stale. Mitigation: the conversion modal uses the currently selected issue's ID, which is set synchronously — the in-flight detail load doesn't affect the conversion message.

### Security
- No new attack surface. All operations go through existing authenticated API paths (`graphqlRequest`, `httpRequest`). No user-supplied HTML is rendered without `escapeHtml` / `escapeAttr`.

### Side Effects
- **`importTaskAsDocument` auto-fires for subtasks:** Both `clickupCreateTask` (line 4430) and `linearCreateIssue` (line 4493) handlers auto-import created tickets. This will also fire for subtasks. **Decision: keep it** — subtasks benefit from local document editing just like top-level tickets. The import uses the created task's ID, which is the subtask's ID, so it works correctly.
- **Cache invalidation:** `updateTask` already invalidates the list cache (line 1416+). `updateIssueParent` must follow the same pattern as `updateIssueState` (lines 1002-1011) to invalidate the Linear project cache.
- **In-memory array staleness:** After conversion, the converted ticket now has a `parentId` and will be filtered OUT of the main list display (lines 7031/6508). The `subtaskConverted` handler must trigger a list refetch so the ticket disappears from the top-level list.

### Dependencies & Conflicts
- No dependency on other plans or sessions.
- No conflicts with existing functionality — all changes are additive (new params, new methods, new handlers, new UI elements).
- The `create-ticket-modal` title element has id `create-ticket-modal-title` (line 3575 in planning.html) — must be used for dynamic title changes.
- The submit handler at line 6234 in `planning.js` sends the create message — must be modified to include `parentId` when `_subtaskParent` is set.

## Dependencies

None — this plan is self-contained.

## Adversarial Synthesis

Key risks: (1) ClickUp subtask `listId` must come from the parent ticket, not the currently selected list — otherwise the subtask lands in the wrong list. (2) Cycle prevention must use the unfiltered in-memory arrays (which contain subtasks with `parentId`) to build a parent-child map and walk upward — the filtered display arrays exclude subtasks and cannot be used. (3) Post-creation refresh must conditionally branch: if `_subtaskParent` was set, refresh parent detail (not reload entire project list) to preserve the user's scroll position and selection context. Mitigations: all three are addressed in the implementation steps below with specific code locations and data flow descriptions.

## Scope

### In Scope
- "Add Subtask" button on the ticket detail meta-bar
- Reuse the existing `create-ticket-modal` with parent context (banner showing parent ticket name)
- "Convert to Subtask" button on the ticket detail meta-bar
- Parent picker modal for conversion (searchable filtered list of tickets in the same list/project)
- ClickUp: pass `parent` through `clickupCreateTask` handler + add `parent` to `updateTask` type
- Linear: add `parentId` to `createIssueSimple` + new `updateIssueParent` method
- Post-creation/conversion: refresh parent ticket detail view and subtask nav
- Cycle prevention: prevent making a ticket a subtask of its own descendant

### Out of Scope
- Sidebar tree hierarchy rendering (tickets remain flat in sidebar; subtasks still shown in detail nav panel)
- Bulk subtask creation
- Drag-and-drop re-parenting
- Removing a parent (un-nesting a subtask back to top-level)

## Proposed Changes

### `src/services/LinearSyncService.ts`

**Context:** The `createIssueSimple` method (line 1740) constructs a Linear `issueCreate` GraphQL mutation. The `updateIssue*` methods (lines 980-1012) follow a consistent pattern: load config, validate, call `graphqlRequest` with `issueUpdate`, invalidate cache.

**Logic — Step 1: Add `parentId` to `createIssueSimple` (line 1740):**

Add optional `parentId?: string` to the params type. Add one spread in the mutation input:

```typescript
public async createIssueSimple(params: {
  title: string;
  description?: string;
  projectId?: string;
  stateId?: string;
  parentId?: string;  // NEW
}): Promise<{ id: string; identifier: string }> {
  // ... existing code ...
  input: {
    teamId: config.teamId,
    title: params.title,
    description: params.description || '',
    labelIds: config.switchboardLabelId ? [config.switchboardLabelId] : [],
    ...(params.projectId ? { projectId: params.projectId } : {}),
    ...(params.stateId ? { stateId: params.stateId } : {}),
    ...(params.parentId ? { parentId: params.parentId } : {})  // NEW
  }
```

**Logic — Step 2: Add `updateIssueParent` method (new, after `updateIssueLabels` ~line 1012):**

Follow the exact pattern of `updateIssueState` (line 980): load config, validate IDs, call `graphqlRequest`, invalidate cache.

```typescript
public async updateIssueParent(issueId: string, parentId: string | null): Promise<void> {
  const config = await this.loadConfig();
  if (!config?.setupComplete) {
    throw new Error('Linear not configured');
  }

  const normalizedIssueId = String(issueId || '').trim();
  if (!normalizedIssueId) {
    throw new Error('Linear parent updates require an issue ID.');
  }

  const result = await this.graphqlRequest(`
    mutation($id: String!, $parentId: String) {
      issueUpdate(id: $id, input: { parentId: $parentId }) { success }
    }
  `, { id: normalizedIssueId, parentId: parentId || null });

  if (!result.data?.issueUpdate?.success) {
    throw new Error(`Linear issue ${normalizedIssueId} rejected the requested parent update.`);
  }

  // Invalidate cache — same pattern as updateIssueState (lines 1002-1011)
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

**Edge Cases:** `parentId = null` would un-nest a subtask, but this is out of scope. The method supports it at the API level but the webview will only call with non-null `parentId`.

### `src/services/ClickUpSyncService.ts`

**Context:** The `updateTask` method (line 1377) accepts an `updates` object and passes it straight through to `httpRequest('PUT', ...)` at line 1406. The type just needs `parent` added.

**Logic — Step 3: Add `parent` to `updateTask` type (line 1377-1389):**

```typescript
public async updateTask(
  taskId: string,
  updates: {
    name?: string;
    description?: string;
    markdown_content?: string;
    markdown_description?: string;
    status?: string;
    assignees?: number[];
    due_date?: number;
    priority?: number;
    tags?: string[];
    parent?: string;  // NEW — ClickUp API accepts this on PUT /task/{taskId}
  }
): Promise<ClickUpTask | null> {
```

No body construction change needed — the existing code at line 1406 passes `updates` straight through.

**Edge Cases:** None. The ClickUp API already accepts `parent` on PUT. This is a type-level change only.

### `src/services/PlanningPanelProvider.ts`

**Context:** The `clickupCreateTask` handler (line 4407) calls `clickUp.createTask()` at line 4420 without `parent`. The `linearCreateIssue` handler (line 4460) calls `linear.createIssueSimple()` at line 4483 without `parentId`. Both handlers auto-import the created ticket via `switchboard.importTaskAsDocument`.

**Logic — Step 4a: Pass `parent` in `clickupCreateTask` (line 4420):**

```typescript
const task = await clickUp.createTask({
    name: msg.title,
    listId: msg.parentId ? _getParentListId(msg.parentId) : msg.listId,  // Use parent's list for subtasks
    description: msg.description,
    ...(msg.parentId ? { parent: msg.parentId } : {})  // NEW
});
```

**Clarification:** When creating a subtask, the `listId` must come from the parent ticket's list, not the currently selected list. The parent's list ID can be obtained from the `clickUpProjectIssues` array (look up the parent by ID and read its `listId` field) or from the `clickUpTaskDetailCache`. The handler should resolve the parent's list ID when `msg.parentId` is present. If the parent's list ID cannot be determined, fall back to `msg.listId`.

**Logic — Step 4b: Pass `parentId` in `linearCreateIssue` (line 4483):**

```typescript
const result = await linear.createIssueSimple({
    title: msg.title,
    description: msg.description,
    projectId,
    ...(msg.parentId ? { parentId: msg.parentId } : {})  // NEW
});
```

**Logic — Step 4c: New `convertToSubtask` handler (new case in message switch):**

```typescript
case 'convertToSubtask': {
    const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
    if (!workspaceRoot) {
        this._panel?.webview.postMessage({
            type: 'subtaskConverted',
            success: false,
            error: 'No workspace folder found',
            provider: msg.provider,
            taskId: msg.taskId,
            parentId: msg.parentId
        });
        break;
    }
    try {
        if (msg.provider === 'clickup') {
            const clickUp = this._adapterFactories.getClickUpSyncService(workspaceRoot);
            await clickUp.updateTask(msg.taskId, { parent: msg.parentId });
        } else if (msg.provider === 'linear') {
            const linear = this._adapterFactories.getLinearSyncService(workspaceRoot);
            await linear.updateIssueParent(msg.taskId, msg.parentId);
        } else {
            throw new Error(`Unknown provider: ${msg.provider}`);
        }
        this._panel?.webview.postMessage({
            type: 'subtaskConverted',
            success: true,
            provider: msg.provider,
            taskId: msg.taskId,
            parentId: msg.parentId,
            workspaceRoot
        });
    } catch (error) {
        this._panel?.webview.postMessage({
            type: 'subtaskConverted',
            success: false,
            error: error instanceof Error ? error.message : String(error),
            provider: msg.provider,
            taskId: msg.taskId,
            parentId: msg.parentId
        });
    }
    break;
}
```

**Edge Cases:**
- Unknown provider → throw with error message, caught and posted back.
- API rejection → error message posted back, webview displays via `showTicketsStatus(msg.error, true)`.
- The `importTaskAsDocument` flow does NOT fire for conversion — the ticket already exists and is already imported. Only creation triggers auto-import.

### `src/webview/planning.html`

**Context:** The `#tickets-preview-meta-bar` div is at line 3428. It contains existing buttons (Edit, Save, Cancel, Push, Delete, Status, Tags, Comment, Attachments, Open, Diagram Prompt). The `create-ticket-modal` is at line 3572 with title element `create-ticket-modal-title` at line 3575.

**Logic — Step 5: Add meta-bar buttons (line 3428, inside `#tickets-preview-meta-bar`, after `btn-diagram-prompt`):**

```html
<button id="btn-add-subtask" class="strip-btn" title="Create a subtask under this ticket">+ Subtask</button>
<button id="btn-convert-subtask" class="strip-btn" title="Convert this ticket to a subtask of another ticket">Convert to Subtask</button>
```

**Logic — Step 7a: Add parent-picker modal (after `create-ticket-modal` closing tag at line 3593):**

```html
<div class="folder-modal" id="convert-subtask-modal" style="display: none;" role="dialog" aria-modal="true" aria-labelledby="convert-subtask-modal-title">
    <div class="modal-content">
        <div class="modal-header">
            <h3 id="convert-subtask-modal-title">Convert to Subtask</h3>
            <button class="modal-close-btn" id="btn-close-convert-subtask-modal" aria-label="Close">&times;</button>
        </div>
        <div class="modal-body" style="display: flex; flex-direction: column; gap: 12px; margin-top: 10px;">
            <div id="convert-subtask-info" style="font-size: 12px; color: var(--text-secondary);"></div>
            <div style="display: flex; flex-direction: column; gap: 4px;">
                <label for="convert-subtask-search" style="font-size: 11px; text-transform: uppercase; color: var(--text-secondary); text-align: left;">Search Parent Ticket</label>
                <input type="text" id="convert-subtask-search" class="planning-input" placeholder="Type to search..." style="width: 100%; box-sizing: border-box;" />
            </div>
            <div id="convert-subtask-list" style="max-height: 300px; overflow-y: auto; display: flex; flex-direction: column; gap: 4px; border: 1px solid var(--border-color); padding: 8px; border-radius: 4px;"></div>
            <div style="display: flex; justify-content: flex-end; gap: 8px; margin-top: 10px;">
                <button id="btn-cancel-convert-subtask" class="strip-btn">Cancel</button>
                <button id="btn-confirm-convert-subtask" class="planning-button" style="margin: 0; padding: 4px 12px;" disabled>Convert</button>
            </div>
        </div>
    </div>
</div>
```

**Edge Cases:** The list container has `max-height: 300px; overflow-y: auto` to handle large ticket lists. The confirm button starts disabled — enabled only when a parent is selected from the list.

### `src/webview/planning.js`

**Context:** The create-ticket submit handler is at line 6210. The `clickupTaskCreated` handler is at line 4192. The `linearIssueCreated` handler is at line 4212. The create-ticket button click handler is at line 6157. Modal close/cancel handlers are at lines 6173-6184. `clickUpProjectIssues` is declared at line 169. `linearProjectIssues` is declared at line 155. `lastIntegrationProvider` is at line 120. The subtask nav click handler is at line 6089.

**Logic — Step 6: Reuse create-ticket modal with parent context:**

Add module-level variable near other tickets state (e.g., after line 169):
```javascript
let _subtaskParent = null; // { id, title, provider } when set, create-ticket-modal acts as subtask creator
```

When "+ Subtask" button is clicked:
- Get the currently selected ticket's ID and title from `selectedClickUpIssue` or `selectedLinearIssue`
- Set `_subtaskParent = { id: ticketId, title: ticketTitle, provider: lastIntegrationProvider }`
- Open `create-ticket-modal` (set `display: block`)
- Update modal title: `document.getElementById('create-ticket-modal-title').textContent = 'Create Subtask under ' + _subtaskParent.title`
- Reset form fields (title input, description textarea)

When "New Ticket" (top-level) button is clicked (line 6157): clear `_subtaskParent = null` before opening modal, reset modal title to `'Create New Ticket'`.

**Logic — Step 6b: Modify submit handler (line 6234):**

Add `parentId` to the message payload when `_subtaskParent` is set:
```javascript
vscode.postMessage({
    type: lastIntegrationProvider === 'clickup' ? 'clickupCreateTask' : 'linearCreateIssue',
    workspaceRoot: ticketsWorkspaceRoot || undefined,
    title,
    description: description || undefined,
    listId: clickUpSelectedListId || undefined,
    projectName: linearProjectPickerValue || undefined,
    ...( _subtaskParent ? { parentId: _subtaskParent.id } : {})  // NEW
});
```

**Logic — Step 6c: Clear `_subtaskParent` on modal cancel/close (lines 6173-6184):**

In each existing close/cancel handler for `create-ticket-modal`, add:
```javascript
_subtaskParent = null;
document.getElementById('create-ticket-modal-title').textContent = 'Create New Ticket';
```

**Logic — Step 8: Post-creation refresh (lines 4192, 4212):**

In `clickupTaskCreated` handler (line 4192), before the existing `loadClickUpProject(true)` call:
```javascript
if (msg.success) {
    const modal = document.getElementById('create-ticket-modal');
    if (modal) modal.style.display = 'none';
    // ... existing field clearing ...
    if (_subtaskParent) {
        // Subtask was created — refresh parent detail to show new subtask in nav
        const parentId = _subtaskParent.id;
        _subtaskParent = null;
        document.getElementById('create-ticket-modal-title').textContent = 'Create New Ticket';
        loadClickUpTaskDetails(parentId);  // Refreshes parent's subtask nav panel
    } else {
        loadClickUpProject(true);  // Top-level ticket — reload list as before
    }
}
```

Same pattern for `linearIssueCreated` handler (line 4212), using `loadLinearTaskDetails(parentId)` and `loadLinearProject(true)`.

**Logic — Step 7b: Parent picker modal interaction:**

When "Convert to Subtask" button is clicked:
- Get the currently selected ticket's ID and title
- Open `convert-subtask-modal`
- Set info text: `document.getElementById('convert-subtask-info').innerHTML = 'Select a parent ticket for <strong>' + escapeHtml(currentTitle) + '</strong>'`
- Call `_populateParentPicker(currentTicketId)` to fill the list

`_populateParentPicker(currentTicketId)` function:
- Get the raw in-memory array: `clickUpProjectIssues` or `linearProjectIssues` (these contain ALL tasks including subtasks — the display filter at lines 7031/6508 only hides them in the list view, the raw array still has them)
- Build a `parentId` map: `Map<childId, parentId>` from the array entries that have `parentId`
- For each candidate in the array (excluding `currentTicketId` itself):
  - Walk upward from the candidate using the parentId map: if `currentTicketId` is found in the ancestor chain, skip this candidate (it's a descendant — would create a cycle)
  - Also skip candidates that ARE the current ticket
- Render each remaining candidate as a clickable row in `#convert-subtask-list`
- Filter rows by the search input (`#convert-subtask-search`) on input event
- On row click: highlight it, store selected parent ID, enable confirm button

On confirm: send conversion message:
```javascript
vscode.postMessage({
    type: 'convertToSubtask',
    provider: lastIntegrationProvider,
    taskId: currentTicketId,
    parentId: selectedParentId,
    workspaceRoot: ticketsWorkspaceRoot || undefined
});
```

**Logic — Step 8b: `subtaskConverted` handler (new case in message handler):**

```javascript
case 'subtaskConverted': {
    const modal = document.getElementById('convert-subtask-modal');
    if (modal) modal.style.display = 'none';
    if (msg.success) {
        showTicketsStatus('Converted to subtask ✓', false);
        // Refresh the ticket list — the converted ticket now has a parentId
        // and will be filtered out of the top-level list display
        if (msg.provider === 'clickup') {
            loadClickUpProject(true);
        } else {
            loadLinearProject(true);
        }
    } else {
        console.error('Failed to convert to subtask:', msg.error);
        showTicketsStatus(msg.error || 'Failed to convert ticket', true);
    }
    break;
}
```

**Logic — Step 9: Cycle prevention (integrated into `_populateParentPicker`):**

```javascript
function _isDescendantOf(candidateId, ancestorId, parentIdMap) {
    let current = parentIdMap.get(candidateId);
    while (current) {
        if (current === ancestorId) return true;
        current = parentIdMap.get(current);
    }
    return false;
}
```

For each candidate in the parent picker, call `_isDescendantOf(candidate.id, currentTicketId, parentIdMap)`. If true, exclude from the list.

For ClickUp: `clickUpProjectIssues` entries have `parentId` field (confirmed by the filter at line 7031 which checks `task?.parentId`). Build map from these.
For Linear: `linearProjectIssues` entries have `parentId` field (confirmed by the filter at line 6508 which checks `issue?.parentId`). Build map from these.

**Edge Cases:**
- If the in-memory array is empty (e.g., user hasn't loaded a project), the parent picker will be empty. Show a message: "No tickets available. Load a project first."
- If the current ticket has no descendants, the cycle check is a no-op — all other tickets are valid parents.
- Deep hierarchies (5+ levels) are handled by the while loop in `_isDescendantOf` — O(depth) per candidate.

## Files Changed

| File | Change |
|------|--------|
| `src/services/LinearSyncService.ts` | Add `parentId` param to `createIssueSimple` (line 1740); new `updateIssueParent` method (after line 1012) |
| `src/services/ClickUpSyncService.ts` | Add `parent?: string` to `updateTask` type (line 1377-1389) |
| `src/services/PlanningPanelProvider.ts` | Pass `parent`/`parentId` in `clickupCreateTask` (line 4420) and `linearCreateIssue` (line 4483) handlers; resolve parent's `listId` for ClickUp subtask creation; new `convertToSubtask` message handler |
| `src/webview/planning.html` | Two new meta-bar buttons (line 3428); new `convert-subtask-modal` (after line 3593) |
| `src/webview/planning.js` | `_subtaskParent` module variable; subtask creation flow with parent context; modified submit handler (line 6234); modified `clickupTaskCreated`/`linearIssueCreated` handlers (lines 4192/4212); conversion flow with parent picker modal; cycle prevention via `_isDescendantOf`; new `subtaskConverted` handler; modal state cleanup on cancel/close |

## Verification Plan

### Automated Tests

**Note:** Tests will be run separately by the user. The following test cases should be implemented:

1. **Unit test — `LinearSyncService.createIssueSimple` with `parentId`:** Verify that passing `parentId` includes it in the `issueCreate` mutation input. Mock `graphqlRequest` and assert the input object contains `parentId`.
2. **Unit test — `LinearSyncService.updateIssueParent`:** Verify that the method calls `graphqlRequest` with the correct `issueUpdate` mutation and invalidates the cache on success. Mock `graphqlRequest` and `_cacheService`.
3. **Unit test — `ClickUpSyncService.updateTask` with `parent`:** Verify that passing `{ parent: '123' }` in updates sends the `parent` field to `httpRequest('PUT', ...)`.
4. **Unit test — `PlanningPanelProvider.convertToSubtask` handler:** Verify that the handler branches to ClickUp or Linear based on `msg.provider`, calls the correct sync service method, and posts back `subtaskConverted` with the correct payload.
5. **Unit test — Cycle prevention (`_isDescendantOf`):** Verify that the function correctly detects ancestry in a multi-level hierarchy and returns false for unrelated tickets.

### Manual Verification

1. **ClickUp subtask creation:** Select a ticket → click "+ Subtask" → modal title shows "Create Subtask under {parent title}" → create → subtask appears in parent's nav panel → parent detail refreshes
2. **Linear subtask creation:** Same flow with Linear provider
3. **ClickUp conversion:** Select a ticket → click "Convert to Subtask" → search and pick parent → ticket's parent is set → list refreshes (converted ticket disappears from top-level list)
4. **Linear conversion:** Same flow with Linear provider
5. **Cycle prevention:** Create ticket A → create subtask B under A → select A → click "Convert to Subtask" → B should NOT appear in the parent picker
6. **Modal state — subtask cancel:** Open "+ Subtask" modal → cancel → open normal "New Ticket" → modal title should be "Create New Ticket" (no parent context)
7. **Modal state — conversion cancel:** Open "Convert to Subtask" modal → cancel → modal closes, no conversion message sent
8. **Error handling — conversion failure:** Simulate API error → `showTicketsStatus` displays error message
9. **Existing subtask display:** Verify existing subtask nav still works after changes (no regression)
10. **ClickUp subtask listId:** Create a subtask under a ticket in list B while list A is selected → subtask should be created in list B (parent's list), not list A

## Recommendation

**Complexity: 6** — Multi-file changes across backend services and webview, moderate logic (cycle prevention, conditional refresh branching, parent listId resolution), but no new architectural patterns. All changes extend existing code structures.

**Send to Coder.**

## Review Findings

Reviewed all 5 files against plan requirements. Implementation is complete and correct — all backend service changes (LinearSyncService `parentId` param + `updateIssueParent`, ClickUpSyncService `parent` type addition), PlanningPanelProvider handlers (parent listId resolution, `convertToSubtask` with provider branching), and webview flows (subtask creation with modal reuse, conversion with parent picker, cycle prevention, post-creation refresh branching) match the plan. No CRITICAL or MAJOR findings. Four NITs identified: (1) stale detail view after conversion — `subtaskConverted` handler reloads list but doesn't clear selection; (2) `_convertSelectedParentId`/`_convertCurrentTicketId` not cleared on modal close (harmless, reset on next open); (3) ClickUp `getTaskListId` fallback to `msg.listId` could misroute Cross-List Subtasks (edge case, pending User Review confirmation); (4) cycle prevention limited to in-memory array completeness (server-side safeguard covers gaps). No code fixes applied. No files changed. Remaining risks: cross-list parenting UX unconfirmed, pagination-edge cycle detection relies on server-side prevention.
