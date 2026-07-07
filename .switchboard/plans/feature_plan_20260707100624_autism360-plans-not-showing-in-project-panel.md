# Fix: Project panel not refreshing — stale/empty plans until close-and-reopen

## Goal

Make the Project panel (`project.html` / `project.js`) reliably show current plans without requiring the user to close and reopen it. Currently, the panel's Kanban tab shows stale or empty plan data after the panel has been hidden and re-shown, or after the extension re-activates. Closing and reopening the panel fixes it because a fresh webview triggers a new `fetchKanbanPlans`, but the persisted webview never re-fetches on its own.

### Problem / background / root cause

The Project panel is created with `retainContextWhenHidden: true` (`PlanningPanelProvider.ts:352`), which preserves the webview's JS state when the panel is hidden. This is intentional — it prevents the webview from rebooting on every tab switch. But it creates a stale-data problem:

**Root cause: No re-fetch trigger when the panel becomes visible again.**

1. **No `onDidChangeViewState` handler.** Neither `PlanningPanelProvider` (Project panel) nor `KanbanProvider` (Kanban board) registers an `onDidChangeViewState` listener. When the panel is hidden and then shown again, the webview's JS state is preserved — the initial `fetchKanbanPlans` (project.js:390) only runs once during webview boot. No re-fetch is triggered on visibility change. If plans changed while the panel was hidden, the user sees stale data.

2. **`openProject()` short-circuits on existing panel.** When the panel already exists (`this._projectPanel` is truthy), `openProject()` (`PlanningPanelProvider.ts:341-343`) calls `reveal()` and returns immediately — it does NOT trigger a re-fetch. So if the panel was restored by VS Code (via `deserializeProjectPanel`) and the initial fetch returned empty or stale data, the user has no way to refresh it except by closing and reopening.

3. **Initial fetch can race with proactive pushes.** The `fetchKanbanPlans` handler has a request-ID guard (`PlanningPanelProvider.ts:3444` and `3493`). If a proactive `kanbanPlansReady` push (sent after a kanban board refresh, complexity edit, etc.) arrives while the initial fetch is still processing async DB queries, the guard at line 3493 (`if (requestId !== this._latestRequestIds.get(guardKey)) { break; }`) can discard the initial fetch's response. The webview then only has partial data from the proactive push (which covers one workspace, not all).

4. **Partial cache update can fragment the cache.** Proactive pushes set `msg.workspaceRoot` (e.g. `PlanningPanelProvider.ts:3663`), triggering the partial cache update path in project.js (lines 464-468):
   ```js
   _kanbanPlansCache = [
       ..._kanbanPlansCache.filter(p => p.workspaceRoot !== msg.workspaceRoot),
       ...(msg.plans || [])
   ];
   ```
   This replaces plans for ONE workspace only. If the initial full fetch (which sets the entire cache via the `else` branch at line 470) was discarded by the guard, the cache only has plans from whichever workspaces happened to send proactive pushes — not all workspaces.

**Why it only started recently:** The proactive push mechanism was added/enhanced in recent commits (the `kanbanPlansReady` push after complexity edits, column changes, etc.). Before these pushes existed, the initial fetch was the only source of data, and it usually completed without contention. Now, proactive pushes can arrive during the initial fetch's async window, causing the guard to discard the full response.

**Why closing and reopening fixes it:** Closing fires `onDidDispose`, clearing `_projectPanel`. Reopening calls `openProject()`, which creates a fresh webview. The fresh webview boots, sends `fetchKanbanPlans`, and — if no proactive push races with it — gets the full response. The cache is populated correctly.

## Metadata

**Tags:** backend, ui, bugfix, webview, refresh, reliability
**Complexity:** 3
**Project:** v5 funnel

## Proposed Changes

### src/services/PlanningPanelProvider.ts

**Change 1: Re-fetch when the Project panel becomes visible**

Register an `onDidChangeViewState` handler in `openProject()` (after the panel is created) and in `_hydratePanel()` (for restored panels). When the panel becomes visible, trigger a re-fetch by sending a `fetchKanbanPlans` message to the webview:

```js
// In openProject(), after creating the panel (after line 401):
this._projectPanel.onDidChangeViewState(
    (e) => {
        if (e.webviewPanel.visible) {
            // Panel became visible — re-fetch plans in case data changed while hidden.
            // The webview's JS state is preserved (retainContextWhenHidden), so this
            // does NOT re-boot. We must explicitly trigger a refresh.
            this._projectPanel?.webview.postMessage({ type: 'refreshKanbanPlans' });
        }
    },
    null,
    this._disposables
);
```

In `_hydratePanel()` (for restored panels), add the same handler after the dispose handler registration (after line 708 for the `isProject` branch):

```js
if (isProject) {
    panel.onDidChangeViewState(
        (e) => {
            if (e.webviewPanel.visible) {
                this._projectPanel?.webview.postMessage({ type: 'refreshKanbanPlans' });
            }
        },
        null,
        this._disposables
    );
}
```

**Change 2: Re-fetch when `openProject()` is called on an existing panel**

In `openProject()`, when the panel already exists, send a refresh trigger instead of just revealing:

```js
// BEFORE (line 341-343):
if (this._projectPanel) {
    this._projectPanel.reveal(vscode.ViewColumn.One);
    return;
}

// AFTER:
if (this._projectPanel) {
    this._projectPanel.reveal(vscode.ViewColumn.One);
    // The panel already exists (either restored or previously opened). Its webview
    // state is preserved (retainContextWhenHidden), so the initial fetchKanbanPlans
    // (project.js:390) did NOT re-fire. Trigger a refresh so the user sees current
    // data instead of stale cache from when the panel was last visible.
    if (this._projectPanelReady) {
        this._projectPanel.webview.postMessage({ type: 'refreshKanbanPlans' });
    }
    return;
}
```

**Change 3: Fix the request-ID guard race**

The guard at line 3493 discards the initial full fetch's response if any other `fetchKanbanPlans` request was processed while it was running. This is correct for deduplication (a newer request supersedes an older one), but it means the initial full fetch can be silently discarded, leaving the webview with only partial data from a proactive push.

Fix: When the initial full fetch (the one without `msg.workspaceRoot`) is about to be discarded by the guard, send it anyway if no full-fetch response has been sent yet. Track this with a boolean:

```js
// Add a field:
private _fullKanbanPlansSent = false;

// In the fetchKanbanPlans handler, reset it when the request starts:
case 'fetchKanbanPlans': {
    // ... existing guard check ...
    this._fullKanbanPlansSent = false;
    try {
        // ... existing fetch logic ...
        
        // BEFORE the guard check at line 3493:
        if (requestId !== this._latestRequestIds.get(guardKey)) {
            // A newer request was processed while we were running. If we haven't
            // sent a full response yet, send it anyway — partial proactive pushes
            // may have arrived but they don't cover all workspaces. The full
            // response is the only way to populate the complete cache.
            if (!this._fullKanbanPlansSent) {
                this._postToBothPanels({
                    type: 'kanbanPlansReady',
                    plans: allPlans,
                    workspaceItems,
                    allWorkspaceProjects,
                    columns: mergedColumns,
                    kanbanWorkspaceRoot: this._kanbanProvider?.getCurrentWorkspaceRoot() || null,
                    requestId
                });
                this._fullKanbanPlansSent = true;
            }
            break;
        }
        // ... existing response sending ...
        this._fullKanbanPlansSent = true;
    }
}
```

### src/webview/project.js

**Change 4: Handle the `refreshKanbanPlans` message**

Add a handler for the new `refreshKanbanPlans` message type that triggers a `fetchKanbanPlans`:

```js
case 'refreshKanbanPlans':
    vscode.postMessage({ type: 'fetchKanbanPlans', requestId: Date.now() });
    break;
```

This goes in the message handler switch statement (around line 397).

### src/services/KanbanProvider.ts

**Change 5: Re-fetch when the Kanban board becomes visible**

Register an `onDidChangeViewState` handler for the kanban panel. The kanban board already has a `_refreshBoard` mechanism — just call it when the panel becomes visible:

```js
// In the panel creation code (wherever the kanban panel is created):
this._panel.onDidChangeViewState(
    (e) => {
        if (e.webviewPanel.visible && this._currentWorkspaceRoot) {
            this._refreshBoard(this._currentWorkspaceRoot);
        }
    },
    null,
    this._disposables
);
```

## Verification Plan

1. **Repro the bug:** Open the Project panel. Switch to another editor tab. Wait a moment (or trigger a kanban board refresh from the kanban panel). Switch back to the Project panel. Observe: the Kanban tab shows stale data (or no plans if the initial fetch was discarded).
2. **Apply fixes.** Run `npm run compile`.
3. **Test visibility re-fetch:** Open the Project panel. Switch to another tab. Switch back. Verify: the Kanban tab re-fetches and shows current plans (check the browser console for a `fetchKanbanPlans` message on visibility change).
4. **Test `openProject()` on existing panel:** With the Project panel already open, run the "Switchboard: Open Project" command. Verify: the panel is revealed AND a re-fetch is triggered (plans update).
5. **Test race condition fix:** Open the Project panel. Immediately trigger a kanban board refresh (e.g. from the kanban panel). Verify: the Project panel still shows all plans from all workspaces (not just one workspace's partial data).
6. **Test kanban board visibility:** Open the Kanban board. Switch to another tab. Trigger a plan change (e.g. create a plan from the CLI). Switch back to the Kanban board. Verify: the board refreshes and shows the new plan.
7. **Test restored panel:** Enable `persistPanels`. Open the Project panel. Reload the VS Code window. Verify: the restored Project panel shows current plans (the `onDidChangeViewState` handler fires on first visibility, triggering a re-fetch).
8. **Run existing tests:** `npm test` — verify no regressions.
