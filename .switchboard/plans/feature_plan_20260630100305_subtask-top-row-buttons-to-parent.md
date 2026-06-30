# Replace Subtask Top-Row Buttons with "To Parent Task" Navigation in Tickets Tab

## Goal

When a subtask is opened in the tickets tab detail view, the top-row meta bar still shows the "+ Subtask" and "To subtask" buttons. These buttons are confusing in the subtask context — "+ Subtask" would create a sub-subtask, and "To subtask" would convert the subtask to a subtask of another ticket (rarely useful). These buttons should be replaced by a "To parent task" button that navigates back to the parent ticket's detail view.

### Problem Analysis & Root Cause

**Root cause:** The meta bar buttons are defined as static HTML in `planning.html` (lines 3674-3675):

```html
<button id="btn-add-subtask" class="strip-btn" title="Create a subtask under this ticket">+ Subtask</button>
<button id="btn-convert-subtask" class="strip-btn" title="Convert this ticket to a subtask of another ticket">To subtask</button>
```

These buttons are always visible whenever the `#tickets-preview-meta-bar` is shown (line 3659). The meta bar visibility is controlled in `renderTicketsClickUpTaskDetail` (line 9110) and `renderTicketsLinearTaskDetail` (line 8591) — it's shown whenever a ticket is selected, regardless of whether the selected ticket is a parent or a subtask.

There is no logic anywhere that:
1. Detects whether the currently selected ticket is a subtask (has a `parentId`).
2. Hides the "+ Subtask" and "To subtask" buttons when a subtask is selected.
3. Shows a "To parent task" button that navigates to the parent.

The `+ Subtask` button handler (line 8031) uses `selectedClickUpIssue` / `selectedLinearIssue` and creates a subtask under the currently selected task. When a subtask is selected, this would create a sub-subtask — technically valid in ClickUp but confusing UX. The `To subtask` button handler (line 8053) opens the convert modal for the currently selected task — converting a subtask to a subtask of a different parent is an edge case that most users won't need.

**What the buttons actually do when a subtask is selected:**
- `+ Subtask`: Creates a subtask under the subtask (a sub-subtask). Applies to the subtask, not the parent.
- `To subtask`: Opens the convert modal to convert the subtask to a subtask of a different parent. Applies to the subtask.

Both technically work but are confusing. The user's expectation is to navigate back to the parent task.

**Parent ID availability (confirmed via API research):** The `selectedClickUpIssue.task` and `selectedLinearIssue.issue` objects come from the backend API response (`msg.task` / `msg.issue` in the `clickupTaskDetailsLoaded` / `linearTaskDetailsLoaded` handlers at lines 5200 / 5058). Research confirms the actual API field structures:

- **ClickUp API v2:** The `Get Task` response (`GET /api/v2/task/{task_id}`) includes a field named `parent` which is a **flat string** containing the parent task ID (e.g., `"parent": "8ckjp5"`), or `null` for top-level tasks. There is **no** `parentId` field in the response. Subtasks are only included when `include_subtasks=true` is passed as a query parameter; each subtask in the `subtasks` array has its own `parent` field with the parent's string ID.
- **Linear API (GraphQL):** The `Issue` type includes a field named `parent` which is a **nested object** of type `Issue` (or `null` for top-level issues). To get the parent ID, the query must request `parent { id }`. There is **no** flat `parentId` field on the query response — `parentId` is only used as an input field in mutations (`IssueCreateInput`, `IssueUpdateInput`). Sub-issues are under the `children` field (an `IssueConnection` with `nodes`).

**Backend bug identified:** The backend code in `TaskViewerProvider.ts` uses `task?.parentId` (line 5539) for ClickUp and `(issue as any)?.parentId` (line 5272) for Linear when writing the `parentId:` frontmatter field. Since neither API response includes a `parentId` field, these conditions evaluate to `undefined` and the `parentId:` frontmatter line is **never written**. This means the subtask filter `if (task?.parentId) return false;` in `getFilteredClickUpTasks` (line 8999) and `getFilteredLinearIssues` (line 8426) never filters out file-backed subtasks. This is a pre-existing bug that should be fixed as part of this plan (see step 4a below).

## Metadata
**Tags:** frontend, ui, bugfix
**Complexity:** 3

## User Review Required
Yes — before implementation, confirm:
- Should the "+ Subtask" and "To subtask" buttons be completely hidden when a subtask is selected, or should they remain accessible via a dropdown/overflow menu?
- Should the "To parent task" button text be "To parent task" or something shorter like "↑ Parent"?
- If the parent task has been deleted (orphaned subtask), should the "To parent task" button be hidden or show an error on click?

## Complexity Audit

### Routine
- Detect whether the currently selected ticket is a subtask (has `parentId` in its data).
- Hide `#btn-add-subtask` and `#btn-convert-subtask` when a subtask is selected.
- Show a new `#btn-to-parent-task` button when a subtask is selected.
- Add click handler for "To parent task" that navigates to the parent ticket's detail view.

### Complex / Risky
- **Parent ID field structure (confirmed):** ClickUp API v2 returns `parent` as a flat string ID (not `parentId`, not `parent.id`). Linear API returns `parent` as a nested object (access via `parent?.id`, not `parentId`). The `_getSelectedParentId()` helper must use the correct field for each provider: `task?.parent` for ClickUp, `issue?.parent?.id` for Linear. The helper should also check `parentId` as a fallback in case the backend normalizes the field.
- **Backend frontmatter bug:** `TaskViewerProvider.ts` uses `task?.parentId` (line 5539) and `(issue as any)?.parentId` (line 5272) to write the `parentId:` frontmatter field. Since neither API includes `parentId` on the response, this field is never written. This must be fixed to use `task?.parent` (ClickUp) and `(issue as any)?.parent?.id` (Linear). See step 4a.
- **Parent detail cache:** When navigating to the parent, the parent's detail may already be cached in `clickUpTaskDetailCache` / `linearIssueDetailCache` (lines 326-327). If not, it needs to be re-fetched. The existing card-click handler (line 7875) already handles this caching logic.

## Edge-Case & Dependency Audit

- **Race Conditions:** None — button visibility is set synchronously during `renderTicketsClickUpTaskDetail` / `renderTicketsLinearTaskDetail`, and the click handler reads `selectedClickUpIssue` / `selectedLinearIssue` at click time.
- **Security:** No security implications. Parent IDs are internal identifiers used for navigation.
- **Side Effects:** Hiding/showing buttons changes the meta bar layout. The meta bar uses `display: flex` (line 9110 / 8591), so hiding buttons with `display: none` will cause remaining buttons to reflow. This is expected behavior.
- **Dependencies & Conflicts:** This plan is compatible with Plan 3 (Subtask Drill-Down). When the user clicks "To parent task", the parent's detail loads and the drill-down state (if active) should be preserved or reset depending on the Plan 3 implementation. No direct conflict.
- **Subtask loaded directly (not via parent):** If a subtask is loaded via search or direct navigation (not by clicking from a parent), the parent ID must still be available. ClickUp task detail responses include `parent` (flat string with parent task ID); Linear issue detail responses include `parent` (nested object with `id`). Since the frontend stores the whole `msg.task` / `msg.issue` object, the parent field will be available as long as the backend passes it through.
- **Orphaned subtasks:** If a subtask's parent has been deleted, clicking "To parent task" should show an error or gracefully handle the missing parent. The `loadClickUpTaskDetails` / `loadLinearTaskDetails` functions will get an error from the API, which is already handled by the existing error display.
- **Top-level task with no parent:** A top-level task has no `parentId` — the "To parent task" button should not be shown. The "+ Subtask" and "To subtask" buttons should remain visible for top-level tasks.
- **Meta bar visibility:** The meta bar is shown/hidden as a unit (`previewMetaBar.style.display = 'flex'` / `'none'`). The individual button visibility changes should not affect the meta bar's overall visibility.
- **`getTicketsTabElements` does not include `btn-add-subtask` / `btn-convert-subtask`:** These buttons are NOT in the `getTicketsTabElements()` function (line 1054). The plan uses `document.getElementById()` directly, which is consistent with the existing button handlers (lines 8031, 8053).

## Dependencies
- None — this plan is self-contained within `src/webview/planning.js`, `src/webview/planning.html`, and `src/services/TaskViewerProvider.ts`.

## Adversarial Synthesis
Key risks: (1) the backend `TaskViewerProvider.ts` uses `task?.parentId` / `(issue as any)?.parentId` which don't exist on the API responses — the `parentId:` frontmatter field is never written, breaking subtask filtering for file-backed tickets, (2) the `_getSelectedParentId()` helper must use provider-specific field names (`task?.parent` for ClickUp, `issue?.parent?.id` for Linear), (3) navigating to the parent when the parent detail is not cached will trigger an API fetch with a loading state. Mitigations: fix the backend frontmatter writing to use correct API field names, use provider-specific field access in `_getSelectedParentId()` with `parentId` fallback, and use the existing cache-and-fetch pattern from the card click handler.

## Proposed Changes

### 1. Add "To parent task" button to the HTML
**File:** `src/webview/planning.html`

In the `#tickets-preview-meta-bar` (line 3659), after the existing subtask buttons (line 3675), add a new button:

```html
<button id="btn-add-subtask" class="strip-btn" title="Create a subtask under this ticket">+ Subtask</button>
<button id="btn-convert-subtask" class="strip-btn" title="Convert this ticket to a subtask of another ticket">To subtask</button>
<!-- NEW: shown only when a subtask is selected -->
<button id="btn-to-parent-task" class="strip-btn" title="Navigate to the parent task" style="display:none;">To parent task</button>
```

### 2. Detect subtask selection and toggle button visibility
**File:** `src/webview/planning.js`

Create a helper function near the other ticket helpers (around line 8445):

```javascript
function _getSelectedParentId() {
    if (lastIntegrationProvider === 'linear') {
        const issue = selectedLinearIssue?.issue;
        // Linear API: parent is a nested Issue object with an id field
        return issue?.parent?.id || issue?.parentId || null;
    } else {
        const task = selectedClickUpIssue?.task;
        // ClickUp API v2: parent is a flat string containing the parent task ID
        return task?.parent || task?.parentId || null;
    }
}
```

In `renderTicketsClickUpTaskDetail` (line 9110, after `previewMetaBar.style.display = 'flex'`), add button visibility logic:

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

Apply the same logic in `renderTicketsLinearTaskDetail` (line 8591, after `previewMetaBar.style.display = 'flex'`).

### 3. Add "To parent task" click handler
**File:** `src/webview/planning.js`

In the event listener setup section (around line 8031, near the existing `#btn-add-subtask` handler):

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

### 4. Fix backend frontmatter writing to use correct API field names
**File:** `src/services/TaskViewerProvider.ts`

The backend currently uses `task?.parentId` (line 5539) for ClickUp and `(issue as any)?.parentId` (line 5272) for Linear. Research confirms neither API includes a `parentId` field on the response — these must be changed to the correct field names:

```typescript
// ClickUp (line 5539) — change from:
if (task?.parentId) { fmLines.push(`parentId: ${String(task.parentId).trim()}`); }
// to:
if (task?.parent) { fmLines.push(`parentId: ${String(task.parent).trim()}`); }

// Linear (line 5272) — change from:
if ((issue as any)?.parentId) { fmLines.push(`parentId: ${String((issue as any).parentId).trim()}`); }
// to:
if ((issue as any)?.parent?.id) { fmLines.push(`parentId: ${String((issue as any).parent.id).trim()}`); }
```

This fix ensures the `parentId:` frontmatter field is actually written for subtasks, which also fixes the subtask filtering in `getFilteredClickUpTasks` (line 8999) and `getFilteredLinearIssues` (line 8426) for file-backed tickets.

### 4a. Ensure parentId is available on subtask detail objects (frontend)
**File:** `src/webview/planning.js`

When a subtask is loaded via the subtask nav click handler (line 7798) or via the API detail response, the parent ID must be available on the task/issue object.

For the subtask nav click handler, the subtask objects from the parent's `subtasks` array contain parent information. When `selectedClickUpIssue` / `selectedLinearIssue` is set from the cache (lines 7810-7811 / 7816-7817), the subtask's `task` / `issue` object should include the parent field.

For API-loaded subtask details, the `clickupTaskDetailsLoaded` (line 5200) / `linearTaskDetailsLoaded` (line 5058) handlers store the whole `msg.task` / `msg.issue` object. Since the API responses include the `parent` field (flat string for ClickUp, nested object for Linear), the parent ID will be available via `_getSelectedParentId()`.

No explicit extraction is needed on the frontend — the `_getSelectedParentId()` helper reads the correct field directly from the stored API response object. However, as a safety net, normalize the parent ID into a `parentId` field in the detail handlers:

```javascript
// In clickupTaskDetailsLoaded (line 5203), after building selectedClickUpIssue:
// Normalize parent string into parentId for consistent access
if (msg.task?.parent && !msg.task.parentId) {
    msg.task.parentId = msg.task.parent;
}

// In linearTaskDetailsLoaded (line 5061), after building selectedLinearIssue:
// Normalize parent.id into parentId for consistent access
if (msg.issue?.parent?.id && !msg.issue.parentId) {
    msg.issue.parentId = msg.issue.parent.id;
}
```

### 5. Reset button visibility when no ticket is selected
**File:** `src/webview/planning.js`

In the "no selection" branches of `renderTicketsClickUpTaskDetail` (line 9092) and `renderTicketsLinearTaskDetail` (line 8573), the meta bar is already hidden (`previewMetaBar.style.display = 'none'`), so the button visibility doesn't matter. No additional change needed.

## Verification Plan

### Automated Tests
- N/A (webview UI changes; manual verification via VS Code extension host).

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
11. Verify (backend fix): after re-importing a subtask, the `parentId:` field is present in the ticket file's frontmatter (check the `.md` file).
12. Verify (backend fix): file-backed subtasks are now correctly filtered out of the sidebar list (they should not appear as top-level entries).

**Recommendation:** Send to Coder

## Review Findings

**Reviewer pass:** Implementation is complete and correct. Files changed: `src/webview/planning.html` (new `#btn-to-parent-task` button), `src/webview/planning.js` (helper `_getSelectedParentId` with provider-specific field access and fallbacks, helper `_toggleSubtaskMetaButtons`, called from both `renderTicketsClickUpTaskDetail` and `renderTicketsLinearTaskDetail`, click handler for "To parent task" with cache-or-fetch navigation). The plan's step 4 (backend frontmatter fix in `TaskViewerProvider.ts`) was correctly NOT applied — the plan's analysis was wrong about the API field names: both `ClickUpSyncService` (line 740) and `LinearSyncService` (line 393) already normalize `parent` → `parentId` before the object reaches `TaskViewerProvider.ts`, so the existing `task?.parentId` / `(issue as any)?.parentId` checks at lines 5550/5281 work correctly and the `parentId:` frontmatter field IS written. Step 4a (frontend parentId normalization in detail handlers) was also correctly skipped — the backend `_mapClickUpTaskToSidebar` (line 5946) already normalizes `parentId: task.parentId || task.parent || null`. No CRITICAL or MAJOR findings. One NIT: `localTicketFilesListed` handler doesn't pass `parentId` through for file-backed tickets — not a bug (backend filters subtask files at line 5322), but a defense-in-depth gap. Verification: compilation and tests skipped per session instructions; code trace confirms button toggle on subtask vs top-level selection, cache-or-fetch parent navigation, and drill-down state preserved when navigating to parent.
