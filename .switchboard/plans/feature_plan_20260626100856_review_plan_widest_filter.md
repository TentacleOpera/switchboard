# Bug: Review Plan Button Opens Widest Filter Instead of Narrowest

## Goal

### Problem
Clicking "Review Plan" on a card in `kanban.html` opens the plan in the Project
panel (`project.html`) Kanban Plans tab, but it defaults to the widest possible
filter — "All Workspaces", "All Projects", "All Columns". This is confusing
because the user sees every plan on the board instead of the specific workspace,
project, and column the plan belongs to. It should open to the narrowest filter
— the plan's own workspace, project, and column.

### Background
The "Review Plan" button in `kanban.html` (handler at `src/webview/kanban.html`
lines 5130-5143) posts a `reviewPlan` message to the extension:

```javascript
document.querySelectorAll('.card-btn.review').forEach(btn => {
    btn.addEventListener('click', () => {
        const pid = btn.dataset.planId || btn.dataset.session || '';
        const cardData = currentCards.find(c => (c.planId || c.sessionId) === pid);
        postKanbanMessage({
            type: 'reviewPlan',
            sessionId: btn.dataset.session || '',
            planId: btn.dataset.planId || '',
            planFile: btn.dataset.planFile || '',
            workspaceRoot: btn.dataset.workspaceRoot,
            isEpic: cardData?.isEpic || false
        });
    });
});
```

The backend handler in `KanbanProvider.ts` (lines 6676-6697) opens/reveals the
project panel and posts `activateKanbanTabAndSelectPlan`:

```typescript
case 'reviewPlan': {
    const reviewId = this._resolveSessionId(msg.planId, msg.sessionId);
    if (reviewId && this._planningPanelProvider) {
        if (!this._planningPanelProvider.hasProjectPanel()) {
            await this._planningPanelProvider.openProject();
        } else if (this._planningPanelProvider.isProjectInCurrentWindow()) {
            this._planningPanelProvider.revealProject();
        }
        this._planningPanelProvider.postMessageToProjectWebview({
            type: 'activateKanbanTabAndSelectPlan',
            planId: msg.planId || '',
            sessionId: reviewId,
            planFile: msg.planFile || '',
            workspaceRoot: msg.workspaceRoot || '',
            isEpic: msg.isEpic === true
        });
    }
    break;
}
```

The project panel handler in `project.js` (lines 395-431) receives
`activateKanbanTabAndSelectPlan` and **explicitly clears all filters to the
widest choice**:

```javascript
case 'activateKanbanTabAndSelectPlan': {
    // ...
    _pendingKanbanSelection = { planId, sessionId, planFile, workspaceRoot };
    // Clear all filters so the target plan is guaranteed to be in the rendered
    // list regardless of workspace mapping (card.workspaceRoot is the actual
    // child folder but plan.workspaceRoot in the cache is the mapped parent).
    kanbanFilters.workspaceRoot = '';
    if (kanbanWorkspaceFilter) kanbanWorkspaceFilter.value = '';
    kanbanFilters.column = '';
    if (kanbanColumnFilter) kanbanColumnFilter.value = '';
    kanbanFilters.project = '';
    if (kanbanProjectFilter) kanbanProjectFilter.value = '';
    const kanbanTabBtn = document.querySelector('.shared-tab-btn[data-tab="kanban"]');
    if (kanbanTabBtn) kanbanTabBtn.click();
    tryResolvePendingKanbanSelection();
    break;
}
```

### Root Cause
The `activateKanbanTabAndSelectPlan` handler (project.js lines 417-425)
intentionally clears all filters to `''` ("All") with the comment: *"Clear all
filters so the target plan is guaranteed to be in the rendered list regardless of
workspace mapping."* This was a defensive choice to avoid the target plan being
hidden by a filter mismatch (the card's `workspaceRoot` is the child folder, but
the plan cache's `workspaceRoot` is the mapped parent).

The result: the user lands on "All Workspaces / All Projects / All Columns" and
sees the entire board instead of the plan's specific context.

Additionally, the `reviewPlan` message from `kanban.html` does NOT include the
plan's `project` or `column` — only `workspaceRoot`, `sessionId`, `planId`,
`planFile`, `isEpic`. So even if the project panel wanted to set narrow filters,
it doesn't receive the project/column values. The card data (`cardData`) in
kanban.html does have `project` and `column` available (the card DOM has
`data-project` and the card object has `column`), but they aren't passed through.

**Bug status: STILL PRESENT** (verified in source).

## Metadata
**Tags:** bug, kanban, review-plan, project-panel, filters, navigation
**Complexity:** 4
**Repo:** switchboard (source at `/Users/patrickvuleta/Documents/GitHub/switchboard`)

## Complexity Audit

### Routine
1. Pass `project` and `column` from `kanban.html` in the `reviewPlan` message.
2. Pass `project` and `column` through the backend `activateKanbanTabAndSelectPlan`
   message.
3. In `project.js`, set the narrow filters instead of clearing them.

### Complex / Risky
1. **Workspace mapping mismatch.** The original comment warns that
   `card.workspaceRoot` is the child folder while `plan.workspaceRoot` in the
   cache is the mapped parent. Setting the workspace filter to the child folder
   value could hide the plan if the filter compares against the parent. The fix
   must resolve the workspace filter value through the same mapping the plan
   cache uses, OR set the workspace filter and then verify the target plan is
   visible (fall back to "All Workspaces" if not found).
2. **Filter value must exist in the dropdown.** The workspace/project/column
   dropdowns are populated from `kanbanPlansReady`. If the target plan's
   workspace/project/column isn't in the dropdown options (e.g. the board shows
   a column the project panel doesn't know about), setting the filter value
   silently fails. Must guard: only set the filter if the option exists.
3. **`tryResolvePendingKanbanSelection` timing.** The selection resolution runs
   after the kanban tab click fires `fetchKanbanPlans`. If the narrow filter is
   applied before the fetch returns, the rendered list is filtered correctly and
   the plan is found. If the fetch returns the full list first and the filter is
   applied after, there could be a flash. The filter must be set BEFORE the tab
   click so the fetch + render applies it.

## Edge-Case & Dependency Audit

- **Epic review:** The epic path (lines 396-408) clears the epics workspace
  filter and switches to the epics tab. The same narrow-filter fix should apply
  to epics (set the epic's workspace filter, not clear it).
- **Plan not in cache yet:** `tryResolvePendingKanbanSelection` retries on
  `kanbanPlansReady`. If the narrow filter hides the plan due to a mapping
  mismatch, the retry never finds it. Mitigation: after N retries, fall back to
  clearing the filters (widest) so the plan is at least visible.
- **Cross-window project panel:** If the project panel is in another window,
  `revealProject()` is skipped and only the message is posted. The filter values
  travel in the message, so this works regardless of window.

## Proposed Changes

### File: `src/webview/kanban.html`

**Change 1 — Include `project` and `column` in the reviewPlan message (lines
5130-5143).**

```javascript
document.querySelectorAll('.card-btn.review').forEach(btn => {
    btn.addEventListener('click', () => {
        const pid = btn.dataset.planId || btn.dataset.session || '';
        const cardData = currentCards.find(c => (c.planId || c.sessionId) === pid);
        postKanbanMessage({
            type: 'reviewPlan',
            sessionId: btn.dataset.session || '',
            planId: btn.dataset.planId || '',
            planFile: btn.dataset.planFile || '',
            workspaceRoot: btn.dataset.workspaceRoot,
            project: cardData?.project || btn.dataset.project || '',
            column: cardData?.column || '',
            isEpic: cardData?.isEpic || false
        });
    });
});
```

### File: `src/services/KanbanProvider.ts`

**Change 2 — Pass `project` and `column` through to the project panel (lines
6688-6695).**

```typescript
this._planningPanelProvider.postMessageToProjectWebview({
    type: 'activateKanbanTabAndSelectPlan',
    planId: msg.planId || '',
    sessionId: reviewId,
    planFile: msg.planFile || '',
    workspaceRoot: msg.workspaceRoot || '',
    project: msg.project || '',
    column: msg.column || '',
    isEpic: msg.isEpic === true
});
```

### File: `src/webview/project.js`

**Change 3 — Set narrow filters instead of clearing them (lines 410-431).**

Replace the filter-clearing block with:
```javascript
_pendingKanbanSelection = {
    planId: msg.planId || '',
    sessionId: msg.sessionId || '',
    planFile: msg.planFile || '',
    workspaceRoot: msg.workspaceRoot || ''
};
_pendingAutoEdit = msg.autoEdit === true;

// Set the NARROWEST filter (the plan's own workspace/project/column) so the
// user lands in the plan's context, not the whole board. Each filter is only
// applied if the value is non-empty AND the corresponding dropdown has a
// matching option — otherwise it's left at "All" to avoid hiding the plan.
const desiredWorkspace = msg.workspaceRoot || '';
const desiredProject = msg.project || '';
const desiredColumn = msg.column || '';

kanbanFilters.workspaceRoot = '';
if (kanbanWorkspaceFilter) kanbanWorkspaceFilter.value = '';
kanbanFilters.project = '';
if (kanbanProjectFilter) kanbanProjectFilter.value = '';
kanbanFilters.column = '';
if (kanbanColumnFilter) kanbanColumnFilter.value = '';

// Stash desired filters to apply AFTER the dropdowns are populated by
// kanbanPlansReady (the tab click fires fetchKanbanPlans which is async).
_pendingKanbanFilterIntent = { workspaceRoot: desiredWorkspace, project: desiredProject, column: desiredColumn };

const kanbanTabBtn = document.querySelector('.shared-tab-btn[data-tab="kanban"]');
if (kanbanTabBtn) kanbanTabBtn.click();
tryResolvePendingKanbanSelection();
```

**Change 4 — Apply the pending filter intent after dropdowns populate.**

In the `kanbanPlansReady` handler (around line 329-338), after
`populateKanbanFilters()` and before `renderKanbanPlans()`, add:
```javascript
// Apply narrow filter intent from a Review Plan navigation.
if (_pendingKanbanFilterIntent) {
    const intent = _pendingKanbanFilterIntent;
    if (intent.workspaceRoot && kanbanWorkspaceFilter) {
        const opts = Array.from(kanbanWorkspaceFilter.options).map(o => o.value);
        if (opts.includes(intent.workspaceRoot)) {
            kanbanFilters.workspaceRoot = intent.workspaceRoot;
            kanbanWorkspaceFilter.value = intent.workspaceRoot;
        }
    }
    if (intent.project && kanbanProjectFilter) {
        const opts = Array.from(kanbanProjectFilter.options).map(o => o.value);
        if (opts.includes(intent.project)) {
            kanbanFilters.project = intent.project;
            kanbanProjectFilter.value = intent.project;
        }
    }
    if (intent.column && kanbanColumnFilter) {
        const opts = Array.from(kanbanColumnFilter.options).map(o => o.value);
        if (opts.includes(intent.column)) {
            kanbanFilters.column = intent.column;
            kanbanColumnFilter.value = intent.column;
        }
    }
    _pendingKanbanFilterIntent = null;
}
```

**Change 5 — Fallback to widest if the plan isn't found after N retries.**

In `tryResolvePendingKanbanSelection`, add a retry counter. After ~3 failed
resolutions (the plan isn't in the filtered list), clear all filters to "All" so
the plan becomes visible:
```javascript
if (_pendingKanbanSelectionRetries++ >= 3) {
    // Narrow filter may be hiding the plan (workspace mapping mismatch).
    // Fall back to widest filter so the plan is at least visible.
    kanbanFilters.workspaceRoot = '';
    if (kanbanWorkspaceFilter) kanbanWorkspaceFilter.value = '';
    kanbanFilters.project = '';
    if (kanbanProjectFilter) kanbanProjectFilter.value = '';
    kanbanFilters.column = '';
    if (kanbanColumnFilter) kanbanColumnFilter.value = '';
    vscode.postMessage({ type: 'fetchKanbanPlans', requestId: Date.now() });
}
```

## Verification Plan

1. **Repro on current build:** Click "Review Plan" on a card in kanban.html.
   Confirm the project panel opens with "All Workspaces / All Projects / All
   Columns" (bug).
2. **Apply the fix** and rebuild.
3. **Narrow filter test:** Click "Review Plan" on a card in a specific workspace,
   project, and column. Confirm the project panel opens with that workspace,
   project, and column selected, and the target plan is visible and selected.
4. **Workspace mapping mismatch test:** Review a plan whose card workspaceRoot
   is a child folder but whose cache workspaceRoot is the mapped parent. Confirm
   the fallback-to-widest kicks in after retries and the plan becomes visible.
5. **Epic review test:** Click "Review Plan" on an epic. Confirm the epics tab
   opens with the epic's workspace filter set (not cleared).
6. **Cross-window test:** With the project panel in a separate window, click
   Review Plan. Confirm the narrow filters apply in the other window.
7. **Dropdown-missing-option test:** Review a plan whose column isn't in the
   project panel's column dropdown. Confirm the column filter stays at "All"
   (guard works) and the plan is visible.
