# Replace Subtask Top-Row Buttons with "To Parent Task" Navigation in Tickets Tab

## Goal

When a subtask is opened in the tickets tab detail view, the top-row meta bar still shows the "+ Subtask" and "To subtask" buttons. These buttons are confusing in the subtask context — "+ Subtask" would create a sub-subtask, and "To subtask" would convert the subtask to a subtask of another ticket (rarely useful). These buttons should be replaced by a "To parent task" button that navigates back to the parent ticket's detail view.

### Problem Analysis & Root Cause

**Root cause:** The meta bar buttons are defined as static HTML in `planning.html` (line ~3664-3665):

```html
<button id="btn-add-subtask" class="strip-btn" title="Create a subtask under this ticket">+ Subtask</button>
<button id="btn-convert-subtask" class="strip-btn" title="Convert this ticket to a subtask of another ticket">To subtask</button>
```

These buttons are always visible whenever the `#tickets-preview-meta-bar` is shown (line ~3650). The meta bar visibility is controlled in `renderTicketsClickUpTaskDetail` (line ~9057) and `renderTicketsLinearTaskDetail` (line ~8528) — it's shown whenever a ticket is selected, regardless of whether the selected ticket is a parent or a subtask.

There is no logic anywhere that:
1. Detects whether the currently selected ticket is a subtask (has a `parentId`).
2. Hides the "+ Subtask" and "To subtask" buttons when a subtask is selected.
3. Shows a "To parent task" button that navigates to the parent.

The `+ Subtask` button handler (line ~7957) uses `selectedClickUpIssue` / `selectedLinearIssue` and creates a subtask under the currently selected task. When a subtask is selected, this would create a sub-subtask — technically valid in ClickUp but confusing UX. The `To subtask` button handler (line ~7979) opens the convert modal for the currently selected task — converting a subtask to a subtask of a different parent is an edge case that most users won't need.

**What the buttons actually do when a subtask is selected:**
- `+ Subtask`: Creates a subtask under the subtask (a sub-subtask). Applies to the subtask, not the parent.
- `To subtask`: Opens the convert modal to convert the subtask to a subtask of a different parent. Applies to the subtask.

Both technically work but are confusing. The user's expectation is to navigate back to the parent task.

## Metadata
**Tags:** ui, frontend, subtasks, navigation, bugfix, tickets-tab
**Complexity:** 3

## Complexity Audit

### Routine
- Detect whether the currently selected ticket is a subtask (has `parentId` in its data).
- Hide `#btn-add-subtask` and `#btn-convert-subtask` when a subtask is selected.
- Show a new `#btn-to-parent-task` button when a subtask is selected.
- Add click handler for "To parent task" that navigates to the parent ticket's detail view.

### Complex / Risky
- **Parent ID availability:** The selected subtask's data comes from the `subtasks` array of the parent's detail response. ClickUp subtask objects have a `parent` field with the parent task ID. Linear subtask objects have a `parent` field with the parent issue ID. However, when a subtask is loaded via `loadClickUpTaskDetails` / `loadLinearTaskDetails`, the detail response may or may not include the parent ID. Need to verify the data structure.
- **Parent detail cache:** When navigating to the parent, the parent's detail may already be cached in `clickUpTaskDetailCache` / `linearIssueDetailCache`. If not, it needs to be re-fetched. The existing card-click handler (line ~7801) already handles this caching logic.

## Edge-Case & Dependency Audit

- **Subtask loaded directly (not via parent):** If a subtask is loaded via search or direct navigation (not by clicking from a parent), the parent ID must still be available. ClickUp task detail responses include `parent.id`; Linear issue detail responses include `parent.id`. This should be stored in the cached detail object.
- **Orphaned subtasks:** If a subtask's parent has been deleted, clicking "To parent task" should show an error or gracefully handle the missing parent. The `loadClickUpTaskDetails` / `loadLinearTaskDetails` functions will get an error from the API, which is already handled by the existing error display.
- **Top-level task with no parent:** A top-level task has no `parentId` — the "To parent task" button should not be shown. The "+ Subtask" and "To subtask" buttons should remain visible for top-level tasks.
- **Meta bar visibility:** The meta bar is shown/hidden as a unit (`previewMetaBar.style.display = 'flex'`). The individual button visibility changes should not affect the meta bar's overall visibility.

## Proposed Changes

### 1. Add "To parent task" button to the HTML
**File:** `src/webview/planning.html`

In the `#tickets-preview-meta-bar` (line ~3664-3665), add a new button after the existing subtask buttons:

```html
<button id="btn-add-subtask" class="strip-btn" title="Create a subtask under this ticket">+ Subtask</button>
<button id="btn-convert-subtask" class="strip-btn" title="Convert this ticket to a subtask of another ticket">To subtask</button>
<!-- NEW: shown only when a subtask is selected -->
<button id="btn-to-parent-task" class="strip-btn" title="Navigate to the parent task" style="display:none;">To parent task</button>
```

### 2. Add element reference for the new button
**File:** `src/webview/planning.js`

In `getTicketsTabElements` (around line ~1067), add:

```javascript
btnToParentTask: document.getElementById('btn-to-parent-task'),
```

### 3. Detect subtask selection and toggle button visibility
**File:** `src/webview/planning.js`

Create a helper function to determine if the currently selected ticket is a subtask and get its parent ID:

```javascript
function _getSelectedParentId() {
    if (lastIntegrationProvider === 'linear') {
        const issue = selectedLinearIssue?.issue;
        return issue?.parentId || issue?.parent?.id || null;
    } else {
        const task = selectedClickUpIssue?.task;
        return task?.parentId || task?.parent?.id || null;
    }
}
```

In `renderTicketsClickUpTaskDetail` (line ~9057, after `previewMetaBar.style.display = 'flex'`), add button visibility logic:

```javascript
if (previewMetaBar) {
    previewMetaBar.style.display = 'flex';
    // ... existing attachment/diagram/status code ...
    
    // Toggle subtask vs parent buttons
    const parentId = _getSelectedParentId();
    const btnAddSubtask = document.getElementById('btn-add-subtask');
    const btnConvertSubtask = document.getElementById('btn-convert-subtask');
    const btnToParent = document.getElementById('btn-to-parent-task');
    if (parentId) {
        // Subtask selected: show "To parent task", hide subtask creation buttons
        if (btnAddSubtask) btnAddSubtask.style.display = 'none';
        if (btnConvertSubtask) btnConvertSubtask.style.display = 'none';
        if (btnToParent) btnToParent.style.display = '';
    } else {
        // Parent/top-level selected: show subtask buttons, hide "To parent task"
        if (btnAddSubtask) btnAddSubtask.style.display = '';
        if (btnConvertSubtask) btnConvertSubtask.style.display = '';
        if (btnToParent) btnToParent.style.display = 'none';
    }
}
```

Apply the same logic in `renderTicketsLinearTaskDetail` (line ~8528, after `previewMetaBar.style.display = 'flex'`).

### 4. Add "To parent task" click handler
**File:** `src/webview/planning.js`

In the event listener setup section (around line ~7957, near the existing subtask button handlers):

```javascript
document.getElementById('btn-to-parent-task')?.addEventListener('click', () => {
    const parentId = _getSelectedParentId();
    if (!parentId) return;
    
    if (lastIntegrationProvider === 'linear') {
        const cached = linearIssueDetailCache.get(parentId);
        if (cached && cached.detailsFetched) {
            selectedLinearIssue = cached;
            renderTicketsLinearPanel();
        } else {
            loadLinearTaskDetails(parentId);
        }
    } else {
        const cached = clickUpTaskDetailCache.get(parentId);
        if (cached && cached.detailsFetched) {
            selectedClickUpIssue = cached;
            renderTicketsClickUpPanel();
        } else {
            loadClickUpTaskDetails(parentId);
        }
    }
});
```

### 5. Ensure parentId is stored in subtask detail objects
**File:** `src/webview/planning.js`

When a subtask is loaded via the subtask nav click handler (line ~7725) or via the API detail response, ensure the `parentId` is preserved on the task/issue object.

For the subtask nav click handler, the subtask objects from the parent's `subtasks` array already contain parent information. When `selectedClickUpIssue` / `selectedLinearIssue` is set from the cache (line ~7741-7743), the subtask's `task` / `issue` object should include the parent ID.

For API-loaded subtask details, verify that the ClickUp/Linear detail response handlers store `parentId` on the task/issue object. Check the `clickupTaskDetailsLoaded` / `linearTaskDetailsLoaded` message handlers and add `parentId` extraction if missing:

```javascript
// In the ClickUp task details handler, when building the task object:
parentId: task.parent ? task.parent.id : (task.parentId || undefined)

// In the Linear issue details handler:
parentId: issue.parent ? issue.parent.id : (issue.parentId || undefined)
```

### 6. Reset button visibility when no ticket is selected
**File:** `src/webview/planning.js`

In the "no selection" branches of `renderTicketsClickUpTaskDetail` (line ~9026) and `renderTicketsLinearTaskDetail` (line ~8497), the meta bar is already hidden (`previewMetaBar.style.display = 'none'`), so the button visibility doesn't matter. No additional change needed.

## Verification Plan

### Manual Testing
1. Select a parent task with subtasks in the tickets tab.
2. Verify: the top-row meta bar shows "+ Subtask" and "To subtask" buttons. "To parent task" is NOT visible.
3. Click a subtask (from the subtask nav or sidebar drill-down).
4. Verify: the meta bar now shows "To parent task" instead of "+ Subtask" and "To subtask".
5. Click "To parent task".
6. Verify: the detail view navigates back to the parent task, and the meta bar switches back to showing "+ Subtask" and "To subtask".
7. Verify: if the parent detail is cached, navigation is instant. If not cached, the loading state shows briefly.
8. Verify: a top-level task (no parent) never shows "To parent task".
9. Verify: both ClickUp and Linear providers handle the button toggle correctly.
10. Verify: after navigating to the parent, the "+ Subtask" button creates a subtask under the parent (not under the previously selected subtask).

### Automated Tests
- N/A (webview UI changes; manual verification via VS Code extension host).

**Recommendation:** Send to Coder
