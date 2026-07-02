# implementation.html plan select dropdown not opening project.html kanban plans tab

**Plan ID:** a1b2c3d4-0001-4a7b-8c9d-0e1f2a3b4c5d

## Goal

When the user selects a plan from the implementation.html (sidebar) plan-select dropdown, the project.html Kanban Plans tab must open with the selected plan highlighted. Today, when `planFile` is empty (ghost/malformed rows), the handler falls back to `_handleViewPlan` which opens the raw markdown in VS Code's editor instead of the project panel.

### Problem

When the user selects a plan from the implementation.html (sidebar) plan-select dropdown, the expected behavior is that the project.html Kanban Plans tab opens with the selected plan highlighted. Instead, nothing happens — the project panel does not open, or if it is already open, the Kanban tab is not activated and the plan is not selected.

### Background

The sidebar plan-select dropdown (`#run-sheet-select` in implementation.html) fires a `change` event on user selection. The handler (implementation.html:2138) sends a `reviewPlan` message to the backend (`TaskViewerProvider`). The backend handler (TaskViewerProvider.ts:9746) calls `this._kanbanProvider.activatePlanInProjectPanel(planFile, workspaceRoot, false)`, which posts `activateKanbanTabAndSelectPlan` to the project panel webview.

### Root Cause

There are two failure modes, both confirmed in the code:

1. **Missing `planFile` on the sheet object.** The `change` handler (implementation.html:2147-2148) looks up the sheet in `currentActiveSheets`/`currentCompletedSheets` by `sessionId`, then reads `sheet?.planFile`. The `toSheet` mapper (TaskViewerProvider.ts:15457-15463) **does** include `planFile`, so this is populated in the normal case. The real issue is the fallback: when `planFile` is empty (`sheet?.planFile || ''`), the backend handler (TaskViewerProvider.ts:9752) evaluates `workspaceRoot && planFile && this._kanbanProvider` as **false** (because `planFile` is empty string), and falls through to `_handleViewPlan` — which opens the raw markdown file in VS Code's editor instead of the project panel. This is the symptom the user sees: a VS Code editor tab opens instead of the project panel's Kanban tab.

2. **Project panel not yet created.** `activatePlanInProjectPanel` (KanbanProvider.ts:208-229) checks `hasProjectPanel()` and calls `openProject()` if needed. But `postMessageToProjectWebview` (PlanningPanelProvider.ts:790-796) queues the message in `_pendingProjectMessages` if `_projectPanelReady` is false. The queued message is flushed when the panel becomes ready. This path works in principle, but the `activateKanbanTabAndSelectPlan` handler in project.js (project.js:607-659) relies on `kanbanPlansReady` having already delivered the plan list to the cache. If the project panel was just opened, the plan list fetch is triggered by the tab click — but the `activateKanbanTabAndSelectPlan` message arrives and sets `_pendingKanbanSelection` before the plans are loaded. The retry mechanism (project.js:1582-1596) handles this, but only after 3 retries. The first `kanbanPlansReady` may not include the plan if the workspace filter is wrong.

The primary root cause is **#1**: when `planFile` is empty, the code takes the wrong branch entirely and never reaches the project panel.

## Metadata

- **Complexity:** 4
- **Tags:** ui, bugfix, frontend, backend

## User Review Required

None. Pure handler-logic fix; no state migration, no schema change.

## Complexity Audit

### Routine
- Single branch condition change in the `reviewPlan` handler in `TaskViewerProvider.ts` — drop the `planFile` check from the condition so the project panel is always tried first when `workspaceRoot && _kanbanProvider`.
- Adding an optional `sessionId` parameter to `activatePlanInProjectPanel` and threading it through.

### Complex / Risky
- None. The `tryResolvePendingKanbanSelection` in project.js already matches by `planId OR sessionId OR planFile` (project.js:1574-1581), so passing `sessionId` alone can still resolve the selection even when `planFile` is empty.

## Edge-Case & Dependency Audit

- **Race Conditions:** None. The `reviewPlan` handler is async and sequential; `activatePlanInProjectPanel` awaits `openProject()` before posting.
- **Security:** No untrusted input; `sessionId` and `planFile` come from the webview message, which is trusted.
- **Side Effects:** When `planFile` is empty and the project panel is activated, the plan may not be found in the cache (if it's a ghost row). The retry mechanism (3 retries) handles this, eventually falling back to widest filters. This is acceptable — the user sees the Kanban tab open even if the specific plan can't be selected.
- **Dependencies & Conflicts:** None. This plan is independent of the other epic subtasks (dropdown filtering, epic differentiation). It touches the `reviewPlan` handler, not the `runSheets`/`renderRunSheetDropdown` pipeline.
- **Ghost/malformed rows with no planFile**: These rows have `planFile: ''`. The current code falls back to `_handleViewPlan(sessionId)`. After the fix, `activatePlanInProjectPanel` is called with an empty `planFile` but a valid `sessionId` — the project.js `tryResolvePendingKanbanSelection` matches by `sessionId` (project.js:1574-1581), so passing `sessionId` alone can still work if the plan is in the cache. The `_handleViewPlan` fallback remains as a last resort when the project panel truly cannot be activated (no kanban provider, no workspace root).
- **Project panel in another window**: `activatePlanInProjectPanel` checks `isProjectInCurrentWindow()` and only reveals if in current window. If the panel is in another window, it just posts the message without revealing. This is correct — the message is still delivered.
- **`reviewPlan` from kanban.html**: The kanban.html Review Plan button sends `reviewPlan` to `KanbanProvider` (KanbanProvider.ts:7160), which has its own handler that does NOT check `planFile` — it always posts to the project panel and passes `sessionId: reviewId` (line 7181). So the fix is only needed in the `TaskViewerProvider` handler (the sidebar path). The kanban.html path already works correctly.
- **Session ID resolution**: The sidebar sends `sessionId` (the run-sheet session ID). The project panel matches by `sessionId` in `tryResolvePendingKanbanSelection`. This works even without `planFile`.

## Dependencies

None. This plan is self-contained and does not depend on any other plan in the epic.

## Adversarial Synthesis

Key risk: stale line numbers in the original plan (off by 37-50 lines) could mislead an implementer into editing the wrong handler — line numbers refreshed to verified current values. The fix logic is otherwise correct: always try the project panel first when `workspaceRoot && _kanbanProvider`, thread `sessionId` through `activatePlanInProjectPanel` so `tryResolvePendingKanbanSelection` can match by sessionId even when `planFile` is empty. Mitigation: grep for `case 'reviewPlan'` and `activatePlanInProjectPanel` rather than trusting line numbers.

## Proposed Changes

> **Implementer note:** Line numbers verified against current source. If shifted, grep for `case 'reviewPlan'` in TaskViewerProvider.ts, `activatePlanInProjectPanel` in KanbanProvider.ts, and `createDraftPlanTicket` for the second call site.

### 1. `src/services/TaskViewerProvider.ts` — fix `reviewPlan` handler to always try project panel first

```ts
// BEFORE (line 9746-9767)
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
                await this._kanbanProvider.activatePlanInProjectPanel(planFile, workspaceRoot, false, data.sessionId);
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

The `activatePlanInProjectPanel` method (KanbanProvider.ts:208-229) currently posts `activateKanbanTabAndSelectPlan` with `sessionId: ''` (empty, line 224). This means when `planFile` is also empty, the project panel has nothing to match on. Thread the `sessionId` through.

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

The `data.sessionId` is already passed in the AFTER code from change #1 (line: `await this._kanbanProvider.activatePlanInProjectPanel(planFile, workspaceRoot, false, data.sessionId)`).

Also update the other call site at TaskViewerProvider.ts:16764 (in `createDraftPlanTicket`) to pass the sessionId if available — though that path already has `planFile` populated, so it's less critical. The optional parameter means existing callers that don't pass `sessionId` are unaffected (defaults to `undefined` → coerced to `''`).

## Verification Plan

> **Session directives:** SKIP compilation (no `npm run compile` / `tsc`) and SKIP automated tests in this session — the project is pre-compiled and tests run separately. The steps below are for the implementer/user to run after the session.

### Automated Tests
- (Run separately by user) Any existing `reviewPlan` handler tests. The fix only changes the branch condition and adds an optional parameter — existing callers without the 4th arg are unaffected.

### Manual Verification
1. **Sidebar plan select with valid planFile**: Open implementation.html, select a plan from the dropdown. Verify the project panel opens (or reveals) and the Kanban tab is activated with the plan selected and preview loaded.
2. **Sidebar plan select with empty planFile (ghost row)**: Create a scenario where a run-sheet row has `planFile: ''` (e.g., a brain-sourced plan with no local file). Select it from the dropdown. Verify the project panel still opens and attempts to select by sessionId. If the plan is not in the cache, verify the retry mechanism kicks in and eventually falls back to widest filters.
3. **Project panel already open in current window**: With the project panel already visible, select a plan from the sidebar. Verify the panel reveals and the plan is selected without opening a new panel.
4. **Project panel already open in another window**: Move the project panel to another VS Code window. Select a plan from the sidebar. Verify the plan is selected in the other window's panel (message delivered without forced reveal).
5. **No kanban provider**: In a degraded state where `_kanbanProvider` is null, verify the fallback to `_handleViewPlan` still works (opens raw markdown in editor).
6. **Regression check**: Verify the kanban.html Review Plan button still works (it uses the KanbanProvider.ts:7160 handler, which is unchanged).

## Recommendation

Complexity 4 → **Send to Coder** (two-file change: handler branch condition + method signature + call site; the optional parameter is backward-compatible but needs care to thread correctly).
