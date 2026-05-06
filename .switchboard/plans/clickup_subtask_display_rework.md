# Plan: Rework ClickUp Subtask Display in implementation.html

## Goal

Filter subtasks out of the main ClickUp task list and render them as interactive, clickable items within the task detail view, matching the existing Linear tab pattern.

## Metadata

**Tags:** frontend, UI, bugfix
**Complexity:** 4

## User Review Required

- [ ] Confirm that subtask statuses should NOT appear in the main list status filter dropdown (or confirm they should remain)
- [ ] Confirm subtask click behavior should load detail view inline (same as parent task cards)

## Problem

In the ClickUp tab of `implementation.html`, subtasks are currently displayed as part of the main task list (one huge unordered list alongside parent tasks). The task detail view renders subtasks as static, non-interactive `<div>` elements.

The desired behavior is:
1. **Main list**: Show only parent tasks. Hide subtasks entirely.
2. **Detail view**: Show subtasks under the "Subtasks" heading as clickable links that load the subtask detail when clicked.

## Root Cause

1. `getFilteredClickUpTasks()` returns every task in `clickUpProjectIssues` without filtering out items that have a `parentId`.
2. `renderSidebarClickUpTaskDetail()` renders subtasks as plain `<div class="project-detail-item">` with no interactivity.
3. There is no click handler for subtask items in the ClickUp detail view (unlike the Linear detail view, which uses `<button data-linear-subtask-id="...">` and delegates clicks to `loadLinearTaskDetails()`).

## Complexity Audit

### Routine
- Step 1: Filter subtasks out of the main task list (`implementation.html` lines 4128–4144)
- Step 2: Render subtasks as clickable `<button>` elements in the detail view (`implementation.html` lines 4080–4091)
- Step 3: Add delegated click listener for ClickUp subtask buttons (`implementation.html` lines 4348–4354)

### Complex / Risky
- None

## Edge-Case & Dependency Audit

- **Race Conditions:** None. This is a purely presentational change with no async logic.
- **Security:** `escapeAttr(st.id)` and `escapeHtml(st.title/status)` are already used consistently. No XSS vector introduced.
- **Side Effects:** The status filter dropdown (`renderSidebarClickUpStatusFilterOptions` at line 3962) builds its options from `clickUpProjectIssues`, which still contains subtasks. Subtask statuses will still appear in the filter dropdown. This is harmless and may even be useful.
- **Dependencies & Conflicts:** None in CREATED/BACKLOG. Adjacent PLAN REVIEWED items `fix_clickup_sidebar_autoload.md` and `fix_clickup_description_word_wrap.md` touch the same file but different functions. No logical conflicts.

## Dependencies

None

## Adversarial Synthesis

Key risks: (1) `parentId` may not be populated by `_normalizeClickUpTask` if the backend shape changes, causing the filter to silently fail, (2) ClickUp task IDs in HTML attributes are typically numeric strings but custom IDs could contain characters needing escaping. Mitigations: verify `parentId` field exists in the mapped task object before coding; `escapeAttr` handles standard attribute escaping.

## Proposed Changes

### `src/webview/implementation.html`

**Context 1:** `getFilteredClickUpTasks()` (lines 4128–4144) returns every task in `clickUpProjectIssues` without filtering out items that have a `parentId`. This causes subtasks to appear in the main task list.

**Logic:** Add a filter to exclude tasks that have a `parentId`.

**Implementation (line 4129, after `let tasks = [...clickUpProjectIssues];`):**
```js
// Exclude subtasks from the main list; they belong in the detail view
tasks = tasks.filter(task => !task.parentId);
```

**Edge Cases:** If `parentId` is `undefined` (not present), it is falsy and the task passes the filter — correct behavior. If `parentId` is an empty string, it is also falsy — correct behavior.

**Context 2:** `renderSidebarClickUpTaskDetail()` (lines 4046–4126) renders subtasks as plain `<div class="project-detail-item">` with no interactivity. The Linear tab already uses `<button data-linear-subtask-id="...">` with a delegated click handler.

**Logic:** Replace the non-interactive `<div>` markup for subtasks with `<button>` elements carrying a `data-clickup-subtask-id` attribute.

**Implementation (lines 4080–4087):**
Change:
```js
const subtasksHtml = subtasks.length === 0
    ? '<p>No subtasks.</p>'
    : subtasks.map(st => `
        <div class="project-detail-item">
            <span class="project-detail-item-title">${escapeHtml(st.title)}</span>
            <span class="project-detail-item-status">${escapeHtml(st.status)}</span>
        </div>
    `).join('');
```
to:
```js
const subtasksHtml = subtasks.length === 0
    ? '<p>No subtasks.</p>'
    : subtasks.map(st => `
        <button type="button" class="project-detail-item" data-clickup-subtask-id="${escapeAttr(st.id)}">
            <span class="project-detail-item-title">${escapeHtml(st.title)}</span>
            <span class="project-detail-item-status">${escapeHtml(st.status)}</span>
        </button>
    `).join('');
```

**Edge Cases:** `st.id` is the ClickUp task ID (numeric string). `escapeAttr` handles attribute escaping. The `_lastClickUpDetailSubtasksHtml` cache comparison at line 4089 still works because it compares the full HTML string.

**Context 3:** There is no click handler for ClickUp subtask items in the detail view. The Linear detail view uses a delegated listener on `detailSubtasksList` that calls `loadLinearTaskDetails()` when a `[data-linear-subtask-id]` button is clicked.

**Logic:** Attach a delegated click listener on `detailSubtasksList` in the same `DOMContentLoaded` listener block where Linear listeners are registered.

**Implementation (immediately after line 4354 in `DOMContentLoaded` listener):**
```js
detailSubtasksList?.addEventListener('click', (event) => {
    const button = event.target.closest('[data-clickup-subtask-id]');
    if (!button) {
        return;
    }
    loadClickUpTaskDetails(button.dataset.clickupSubtaskId);
});
```

**Edge Cases:** If `detailSubtasksList` is null (e.g., tab not rendered yet), the optional chaining `?.` prevents an error. The `loadClickUpTaskDetails` function (line 3671) already handles arbitrary task IDs because ClickUp's `getTaskDetails` API works for any task, including subtasks.

**Clarification:** The `detailSubtasksList` element is shared between Linear and ClickUp views. The existing Linear listener at line 4348 checks `[data-linear-subtask-id]`, and the new ClickUp listener checks `[data-clickup-subtask-id]`. Since the two attribute names are different, the listeners do not interfere. Both listeners fire on a click inside `detailSubtasksList`, but each will correctly no-op if the wrong button type is clicked.

## Verification Plan

### Automated Tests

No existing automated tests cover ClickUp subtask rendering. Add manual verification:

1. Open the ClickUp tab in the Switchboard sidebar.
2. Select a Space → Folder → List that contains tasks with subtasks.
3. Confirm the main card list shows **only parent tasks** (no subtask rows).
4. Click a parent task to open its detail view.
5. Confirm the **Subtasks** section lists each subtask as a clickable row.
6. Click a subtask row — the detail view should reload to show that subtask's details.
7. Use the **BACK TO LIST** button to return to the parent task list.

### Regression Tests

- Confirm the Linear tab subtask display and click behavior remain unaffected.
- Confirm status filter and search still work correctly on the parent task list.
- Confirm ClickUp task detail view renders correctly for tasks with no subtasks.

## Risks & Notes

- **No backend changes required.** The `parentId` field is already populated by `_normalizeClickUpTask()` in `ClickUpSyncService.ts`.
- **API parameter `subtasks=true`** in `getListTasks()` could optionally be removed to reduce payload size, but that is out of scope for this UI-only fix. Leaving it as-is is safe because the frontend now filters subtasks out.
- The Linear tab already uses this exact pattern (`data-linear-subtask-id` + delegated click handler), so the ClickUp tab should follow it for consistency.

**Recommendation:** Send to Coder

---

## Review & Validation (Grumpy/Balanced)

### Stage 1: Grumpy Review (Adversarial)
* "Well, well, well. For once, a frontend change that actually does exactly what it says on the tin and nothing more. You successfully used `!task.parentId` to hide the subtasks, and you managed to not screw up the delegated event listener by using `[data-clickup-subtask-id]`. My only lingering concern—because I *must* find something—is whether the backend `parentId` is strictly populated as a string or `null`. Since JS's falsy checks are a blunt instrument, it works out here. It's almost... competent." [NIT]

### Stage 2: Balanced Synthesis
* **What's good:** The implementation perfectly matches the plan. Subtasks are excluded from the main list using `!task.parentId`, rendered as interactive `<button>` elements with the correct attributes, and the event listener correctly calls `loadClickUpTaskDetails` via event delegation.
* **What needs fixing:** No material code fixes are required.
* **Risks:** The status dropdown will still show subtask statuses, but the plan acknowledges this as a harmless/useful side effect.

### Validation Results
* **Files Changed:** `src/webview/implementation.html`
* **Status:** The Javascript changes are syntactically sound and correctly use the existing escaping functions (`escapeHtml`, `escapeAttr`).
* **Code Fixes Applied:** None required. The implementation is solid.
* **Remaining Risks:** None within the scope of this UI change.
