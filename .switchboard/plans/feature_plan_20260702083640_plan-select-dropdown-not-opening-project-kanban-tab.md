# implementation.html plan select dropdown not opening project.html kanban plans tab

## Goal

### Problem
When the user selects a plan from the implementation.html (sidebar) plan-select dropdown, the expected behavior is that the project.html Kanban Plans tab opens with the selected plan highlighted. Instead, nothing happens — the project panel does not open, or if it is already open, the Kanban tab is not activated and the plan is not selected.

### Background
The sidebar plan-select dropdown (`#run-sheet-select` in implementation.html) fires a `change` event on user selection. The handler (implementation.html:2138) sends a `reviewPlan` message to the backend (`TaskViewerProvider`). The backend handler (TaskViewerProvider.ts:9709) calls `this._kanbanProvider.activatePlanInProjectPanel(planFile, workspaceRoot, false)`, which posts `activateKanbanTabAndSelectPlan` to the project panel webview.

### Root Cause
There are two failure modes, both confirmed in the code:

1. **Missing `planFile` on the sheet object.** The `change` handler (implementation.html:2147-2148) looks up the sheet in `currentActiveSheets`/`currentCompletedSheets` by `sessionId`, then reads `sheet?.planFile`. However, the `toSheet` mapper (TaskViewerProvider.ts:15417-15423) **does** include `planFile`, so this is populated in the normal case. The real issue is the fallback: when `planFile` is empty (`sheet?.planFile || ''`), the backend handler (TaskViewerProvider.ts:9715) evaluates `workspaceRoot && planFile && this._kanbanProvider` as **false** (because `planFile` is empty string), and falls through to `_handleViewPlan` — which opens the raw markdown file in VS Code's editor instead of the project panel. This is the symptom the user sees: a VS Code editor tab opens instead of the project panel's Kanban tab.

2. **Project panel not yet created.** `activatePlanInProjectPanel` (KanbanProvider.ts:208-229) checks `hasProjectPanel()` and calls `openProject()` if needed. But `postMessageToProjectWebview` (PlanningPanelProvider.ts:789-795) queues the message in `_pendingProjectMessages` if `_projectPanelReady` is false. The queued message is flushed when the panel becomes ready. This path works in principle, but the `activateKanbanTabAndSelectPlan` handler in project.js (project.js:607-659) relies on `kanbanPlansReady` having already delivered the plan list to the cache. If the project panel was just opened, the plan list fetch is triggered by the tab click — but the `activateKanbanTabAndSelectPlan` message arrives and sets `_pendingKanbanSelection` before the plans are loaded. The retry mechanism (project.js:1582-1596) handles this, but only after 3 retries. The first `kanbanPlansReady` may not include the plan if the workspace filter is wrong.

The primary root cause is **#1**: when `planFile` is empty, the code takes the wrong branch entirely and never reaches the project panel.

## Metadata
- **Tags**: `implementation.html`, `plan-select`, `reviewPlan`, `project-panel`, `kanban-tab`, `bug`, `ui`
- **Complexity**: 4/10

## Complexity Audit
**Routine.** The fix is a single branch condition change in `TaskViewerProvider.ts` and ensuring the `planFile` is always populated. The `reviewPlan` handler already has the correct project-panel activation logic — it just needs to be reached even when `planFile` is empty. The fallback to `_handleViewPlan` should only happen when the project panel truly cannot be activated (no kanban provider, no workspace root), not when `planFile` is missing.

## Edge-Case & Dependency Audit
- **Ghost/malformed rows with no planFile**: These rows have `planFile: ''`. The current code falls back to `_handleViewPlan(sessionId)`. After the fix, we should still attempt `activatePlanInProjectPanel` with an empty `planFile` — the project.js `tryResolvePendingKanbanSelection` matches by `planId` OR `sessionId` OR `planFile`, so passing `sessionId` alone can still work if the plan is in the cache. The `_handleViewPlan` fallback should remain as a last resort when the project panel cannot be activated at all.
- **Project panel in another window**: `activatePlanInProjectPanel` checks `isProjectInCurrentWindow()` and only reveals if in current window. If the panel is in another window, it just posts the message without revealing. This is correct — the message is still delivered.
- **`reviewPlan` from kanban.html**: The kanban.html Review Plan button sends `reviewPlan` to `KanbanProvider` (KanbanProvider.ts:7110), which has its own handler that does NOT check `planFile` — it always posts to the project panel. So the fix is only needed in the `TaskViewerProvider` handler (the sidebar path).
- **Session ID resolution**: The sidebar sends `sessionId` (the run-sheet session ID). The project panel matches by `sessionId` in `tryResolvePendingKanbanSelection`. This works even without `planFile`.

## Proposed Changes

### 1. `src/services/TaskViewerProvider.ts` — fix `reviewPlan` handler to always try project panel first

```ts
// BEFORE (line 9709-9730)
case 'reviewPlan': {
    if (data.sessionId) {
        this._view?.webview.postMessage({ type: 'planLoading', value: true, sessionId: data.sessionId });
        try {
            const workspaceRoot = this._resolveWorkspaceRoot();
            const planFile = data.planFile || '';
            if (workspaceRoot && planFile && this._kanbanProvider) {
                // Open the plan in the Project panel, same as kanban.html's Review Plan button.
                await this._kanbanProvider.activatePlanInProjectPanel(planFile, workspaceRoot, false);
            } else {
                // Last-resort fallback for ghost/malformed rows with no planFile:
                // opens the raw file in VS Code's editor.
                await this._handleViewPlan(data.sessionId);
            }
        } finally {
            this._view?.webview.postMessage({ type: 'planLoading', value: false, sessionId: data.sessionId });
        }
    }
    break;
}

// AFTER
case 'reviewPlan': {
    if (data.sessionId) {
        this._view?.webview.postMessage({ type: 'planLoading', value: true, sessionId: data.sessionId });
        try {
            const workspaceRoot = this._resolveWorkspaceRoot();
            const planFile = data.planFile || '';
            // Always try the Project panel first — activatePlanInProjectPanel can
            // resolve the plan by sessionId even when planFile is empty (project.js
            // tryResolvePendingKanbanSelection matches on planId OR sessionId OR planFile).
            // Only fall back to the raw VS Code editor if the project panel truly
            // cannot be activated (no kanban provider or no workspace root).
            if (workspaceRoot && this._kanbanProvider) {
                await this._kanbanProvider.activatePlanInProjectPanel(planFile, workspaceRoot, false);
            } else {
                await this._handleViewPlan(data.sessionId);
            }
        } finally {
            this._view?.webview.postMessage({ type: 'planLoading', value: false, sessionId: data.sessionId });
        }
    }
    break;
}
```

### 2. `src/services/KanbanProvider.ts` — pass `sessionId` through to project panel

The `activatePlanInProjectPanel` method (KanbanProvider.ts:208-229) currently posts `activateKanbanTabAndSelectPlan` with `sessionId: ''` (empty). This means when `planFile` is also empty, the project panel has nothing to match on. We need to thread the `sessionId` through.

```ts
// BEFORE (line 208-229)
public async activatePlanInProjectPanel(planFile: string, workspaceRoot: string, autoEdit?: boolean): Promise<void> {
    if (!this._planningPanelProvider) { return; }
    if (!this._planningPanelProvider.hasProjectPanel()) {
        await this._planningPanelProvider.openProject();
    } else if (this._planningPanelProvider.isProjectInCurrentWindow()) {
        this._planningPanelProvider.revealProject();
    }
    const rawRoot = workspaceRoot || this.getCurrentWorkspaceRoot() || '';
    const effectiveRoot = rawRoot ? this.resolveEffectiveWorkspaceRoot(rawRoot) : '';
    this._planningPanelProvider.postMessageToProjectWebview({
        type: 'activateKanbanTabAndSelectPlan',
        planId: '',
        sessionId: '',          // <-- always empty
        planFile: planFile || '',
        workspaceRoot: effectiveRoot,
        autoEdit: autoEdit === true
    });
}

// AFTER
public async activatePlanInProjectPanel(
    planFile: string,
    workspaceRoot: string,
    autoEdit?: boolean,
    sessionId?: string
): Promise<void> {
    if (!this._planningPanelProvider) { return; }
    if (!this._planningPanelProvider.hasProjectPanel()) {
        await this._planningPanelProvider.openProject();
    } else if (this._planningPanelProvider.isProjectInCurrentWindow()) {
        this._planningPanelProvider.revealProject();
    }
    const rawRoot = workspaceRoot || this.getCurrentWorkspaceRoot() || '';
    const effectiveRoot = rawRoot ? this.resolveEffectiveWorkspaceRoot(rawRoot) : '';
    this._planningPanelProvider.postMessageToProjectWebview({
        type: 'activateKanbanTabAndSelectPlan',
        planId: '',
        sessionId: sessionId || '',   // <-- now threaded through
        planFile: planFile || '',
        workspaceRoot: effectiveRoot,
        autoEdit: autoEdit === true
    });
}
```

### 3. `src/services/TaskViewerProvider.ts` — pass `sessionId` to `activatePlanInProjectPanel`

```ts
// In the reviewPlan handler (the AFTER version from change #1):
if (workspaceRoot && this._kanbanProvider) {
    await this._kanbanProvider.activatePlanInProjectPanel(planFile, workspaceRoot, false, data.sessionId);
}
```

Also update the other call site at TaskViewerProvider.ts:16745 (in `createDraftPlanTicket`) to pass the sessionId if available — though that path already has `planFile` populated, so it's less critical.

## Verification Plan
1. **Sidebar plan select with valid planFile**: Open implementation.html, select a plan from the dropdown. Verify the project panel opens (or reveals) and the Kanban tab is activated with the plan selected and preview loaded.
2. **Sidebar plan select with empty planFile (ghost row)**: Create a scenario where a run-sheet row has `planFile: ''` (e.g., a brain-sourced plan with no local file). Select it from the dropdown. Verify the project panel still opens and attempts to select by sessionId. If the plan is not in the cache, verify the retry mechanism kicks in and eventually falls back to widest filters.
3. **Project panel already open in current window**: With the project panel already visible, select a plan from the sidebar. Verify the panel reveals and the plan is selected without opening a new panel.
4. **Project panel already open in another window**: Move the project panel to another VS Code window. Select a plan from the sidebar. Verify the plan is selected in the other window's panel (message delivered without forced reveal).
5. **No kanban provider**: In a degraded state where `_kanbanProvider` is null, verify the fallback to `_handleViewPlan` still works (opens raw markdown in editor).
6. **Regression check**: Verify the kanban.html Review Plan button still works (it uses the KanbanProvider.ts:7110 handler, which is unchanged).
