# implementation.html plan select dropdown must respect active kanban board project filter

**Plan ID:** a1b2c3d4-0002-4a7b-8c9d-0e1f2a3b4c5d

## Goal

The plan select dropdown in implementation.html (the sidebar) must show only plans belonging to the active kanban board's project filter. When the user selects a project on the kanban board, the sidebar dropdown must refresh to reflect that filter.

### Problem

The plan select dropdown in implementation.html (the sidebar) shows plans from ALL projects, ignoring the active kanban board's project filter. When the user selects a project on the kanban board (e.g., "Project Foo"), the sidebar dropdown should only show plans belonging to "Project Foo" — but it currently shows every plan in the workspace.

### Background

The sidebar dropdown is populated by the `runSheets` message, which is sent from `TaskViewerProvider._refreshRunSheetsImpl` (TaskViewerProvider.ts:15320-15474). This method reads the project filter via `this._kanbanProvider?.getProjectFilter()` (line 15409) and uses it to query the DB: `getBoardFilteredByProject(workspaceId, projectFilter, repoScope)` (line 15412).

So the backend **does** pass the project filter to the DB query. The question is why the dropdown still shows all plans.

### Root Cause

The `_projectFilter` field in `KanbanProvider` (KanbanProvider.ts:182) is initialized to `KanbanDatabase.UNASSIGNED_PROJECT_FILTER` (`'__unassigned__'`), which means "show only unassigned plans" — NOT "show all plans". The `getProjectFilter()` method (KanbanProvider.ts:4811-4813) returns this value directly.

In `_refreshRunSheetsImpl` (TaskViewerProvider.ts:15411), the condition is:
```ts
const activeRows = (projectFilter !== null || repoScope)
    ? await db.getBoardFilteredByProject(workspaceId, projectFilter, repoScope)
    : await db.getBoard(workspaceId);
```

When `_projectFilter` is `'__unassigned__'`, `projectFilter` is `'__unassigned__'` (not null), so it takes the filtered path. `getBoardFilteredByProject` with `project === '__unassigned__'` adds `AND plans.project_id IS NULL` (KanbanDatabase.ts:2767) — showing only plans with no project. This is correct for the "base workspace" filter.

When the user selects a specific project (e.g., "Foo"), `setProjectFilter('Foo')` is called, `_projectFilter` becomes `'Foo'`, and the query correctly filters to Foo's plans.

**The actual bug**: The sidebar dropdown is NOT being refreshed when the project filter changes. `setProjectFilter` (KanbanProvider.ts:4937-4961) updates `_projectFilter` and persists it, but does NOT trigger a sidebar refresh directly. The kanban board refreshes via `_refreshBoard` (called from the `setProjectFilter` message handler at KanbanProvider.ts:5631-5637), which calls `switchboard.refreshUI` via `executeCommand` (KanbanProvider.ts:2224), which calls `taskViewerProvider.refreshUI()` (TaskViewerProvider.ts:2761-2791), which calls `_refreshRunSheets()` (TaskViewerProvider.ts:2788). So the sidebar SHOULD refresh.

**Verification of the refresh chain:** The chain is complete and functional — `setProjectFilter` (synchronous field update) → `_refreshBoard` (awaited) → `executeCommand('switchboard.refreshUI')` (line 2224) → command registered in extension.ts calls `taskViewerProvider.refreshUI(workspaceRoot)` → `_refreshRunSheets` reads `this._kanbanProvider?.getProjectFilter()` (line 15409). The chain works in principle.

**The most likely cause**: The `executeCommand('switchboard.refreshUI')` call is async — if the command execution fails, is delayed, or the sidebar view isn't ready yet, the sidebar doesn't update. The most robust fix is to (a) add the project filter value to the `runSheets` message so the webview can display it and confirm it received the right filter, and (b) add an explicit direct `_taskViewerProvider?.refreshUI()` call in the `setProjectFilter` handler as a safety net, bypassing the command indirection.

## Metadata

- **Complexity:** 5
- **Tags:** ui, bugfix, backend, frontend

## User Review Required

None. Pure refresh-chain and message-payload enhancement; no state migration, no schema change.

## Complexity Audit

### Routine
- Adding `projectFilter` field to the `runSheets` postMessage (TaskViewerProvider.ts:15468) and error-path posts (lines 15472, 15521).
- Storing `currentProjectFilter` in implementation.html's `runSheets` handler and optionally displaying a filter indicator in the dropdown.
- Adding an explicit `this._taskViewerProvider?.refreshUI(workspaceRoot)` call in the `setProjectFilter` message handler (KanbanProvider.ts:5631-5637).

### Complex / Risky
- The refresh flow uses single-flight coalescing (`_refreshRunSheets` wrapper at TaskViewerProvider.ts:15298-15318). Adding a direct `refreshUI` call alongside the command-based path could cause a double-refresh if both fire. The single-flight wrapper handles this (coalesces concurrent calls), but the implementer should verify no redundant DB reads.

## Edge-Case & Dependency Audit

- **Race Conditions:** The explicit `refreshUI` call and the command-based `executeCommand('switchboard.refreshUI')` may both fire. The single-flight wrapper in `_refreshRunSheets` (TaskViewerProvider.ts:15298-15318) coalesces concurrent calls, so this is safe — at most one DB read + postMessage lands.
- **Security:** No untrusted input; `projectFilter` is read from `getProjectFilter()` which returns the internal `_projectFilter` field.
- **Side Effects:** Each `refreshWithData` call will now also push `projectFilter` in the `runSheets` message. The webview handler is additive (reads `message.projectFilter ?? null`), so existing behavior is unchanged if the field is absent.
- **Dependencies & Conflicts:** This plan touches the `runSheets` message payload, which is also modified by Plan 4 (adding `isEpic`/`epicId` to `toSheet`). The changes are to different parts of the message (`projectFilter` is a top-level field; `isEpic`/`epicId` are per-sheet fields). They compose without conflict.
- **`setProjectFilter` call sites**: KanbanProvider.ts:5493 (workspace switch reset), 5495 (workspace switch preserve), 5547 (project creation), 5613 (project deletion reset), 5634 (setProjectFilter message handler). Each is followed by `_refreshBoard` which triggers the refresh chain. The explicit `refreshUI` call is only added to the message handler (5631-5637); the other call sites already go through `_refreshBoard` which triggers the chain.
- **`UNASSIGNED_PROJECT_FILTER` ('__unassigned__')**: Means "base workspace board" — show only plans with no project. This is a valid filter value, not "show all". The sidebar must respect this too.
- **`null` vs `'__unassigned__'`**: `getProjectFilter()` returns `_projectFilter` which is initialized to `UNASSIGNED_PROJECT_FILTER` and never set to null in practice (the handler at line 5634 coerces null to `UNASSIGNED_PROJECT_FILTER` via `??`). The `_refreshRunSheetsImpl` condition `projectFilter !== null` is always true when a kanban provider exists, so the filtered path is always taken. The `getBoard(workspaceId)` branch (unfiltered) is only taken when `_kanbanProvider` is undefined (degraded state).
- **Sidebar not visible**: If the sidebar view is disposed/hidden, `this._view` may be falsy and `runSheets` won't be posted. When the sidebar becomes visible again, it needs a refresh. This is handled by the `onDidChangeViewState` handler which calls `refreshUI`.
- **Workspace switch**: When the workspace changes, `setProjectFilter(UNASSIGNED_PROJECT_FILTER)` is called (KanbanProvider.ts:5493). The sidebar refresh follows. This is correct.
- **Multi-workspace**: The sidebar shows plans from the current workspace only. The project filter is per-workspace (persisted in `workspaceState`). This is correct.

## Dependencies

None. This plan is self-contained and does not depend on any other plan in the epic. It composes with Plan 4 (which adds per-sheet `isEpic`/`epicId` fields to the same `runSheets` message) without conflict.

## Adversarial Synthesis

Key risk: the original plan's root cause analysis was inconclusive — it traced the refresh chain, found it functional, then proposed a safety-net fix without identifying the exact failure point. The refresh chain (`setProjectFilter` → `_refreshBoard` → `executeCommand` → `refreshUI` → `_refreshRunSheets`) IS complete and should work. The explicit `refreshUI` call is a belt-and-suspenders safety net for cases where the command-based path fails or races. The `projectFilter` field in the `runSheets` message is the more valuable addition — it enables debugging and a webview filter indicator. Mitigation: the single-flight wrapper coalesces any double-refresh from both paths. Line numbers refreshed (off by 10-50 in the original).

## Proposed Changes

> **Implementer note:** Line numbers verified against current source. If shifted, grep for `_refreshRunSheetsImpl`, `case 'setProjectFilter'`, and `type: 'runSheets'` to locate insertion points.

### 1. `src/services/TaskViewerProvider.ts` — include project filter in `runSheets` message

Add the current project filter to the `runSheets` message so the webview knows which filter was applied. This helps with debugging and enables the webview to show a filter indicator.

```ts
// BEFORE (line 15468)
this._view.webview.postMessage({ type: 'runSheets', activeSheets, completedSheets, kanbanColumns });

// AFTER
const currentProjectFilter = this._kanbanProvider?.getProjectFilter() ?? null;
this._view.webview.postMessage({
    type: 'runSheets',
    activeSheets,
    completedSheets,
    kanbanColumns,
    projectFilter: currentProjectFilter
});
```

Also update the error-path posts (lines 15472, 15521) to include `projectFilter: null`.

### 2. `src/services/KanbanProvider.ts` — explicit sidebar refresh in `setProjectFilter` handler

The current flow (`setProjectFilter` → `_refreshBoard` → `executeCommand('switchboard.refreshUI')` → `refreshUI` → `_refreshRunSheets`) should work, but the command-based path has an indirection that can fail silently. Add a direct call as a safety net:

```ts
// BEFORE (line 5631-5637)
case 'setProjectFilter': {
    const workspaceRoot = this._currentWorkspaceRoot;
    if (workspaceRoot && (msg.project === null || typeof msg.project === 'string')) {
        this.setProjectFilter(msg.project ?? KanbanDatabase.UNASSIGNED_PROJECT_FILTER);
        await this._refreshBoard(workspaceRoot);
    }
    break;
}

// AFTER
case 'setProjectFilter': {
    const workspaceRoot = this._currentWorkspaceRoot;
    if (workspaceRoot && (msg.project === null || typeof msg.project === 'string')) {
        this.setProjectFilter(msg.project ?? KanbanDatabase.UNASSIGNED_PROJECT_FILTER);
        await this._refreshBoard(workspaceRoot);
        // Explicit: ensure the sidebar picks up the new filter even if the
        // command-based refresh chain has a gap. The single-flight wrapper
        // in _refreshRunSheets coalesces any concurrent refresh from both paths.
        this._taskViewerProvider?.refreshUI(workspaceRoot);
    }
    break;
}
```

Note: `refreshUI` is async but we don't need to await it here — the `_refreshRunSheets` inside it will fire and post the updated `runSheets` message. The single-flight wrapper (TaskViewerProvider.ts:15298-15318) coalesces concurrent calls from both the command path and this direct call.

### 3. `src/webview/implementation.html` — store and optionally display the active project filter

```js
// In the runSheets message handler (around line 2293-2307)
case 'runSheets':
    if (message.activeSheets !== undefined || message.completedSheets !== undefined) {
        currentActiveSheets = message.activeSheets || [];
        currentCompletedSheets = message.completedSheets || [];
        currentRunSheets = [...currentActiveSheets, ...currentCompletedSheets];
    } else {
        currentRunSheets = message.sheets || [];
        currentActiveSheets = currentRunSheets;
        currentCompletedSheets = [];
    }
    currentKanbanColumns = message.kanbanColumns || [];
    currentProjectFilter = message.projectFilter ?? null;  // NEW
    renderRunSheetDropdown();
    break;
```

Add `let currentProjectFilter = null;` to the state variables near the top of the script.

### 4. `src/webview/implementation.html` — show project filter context in the dropdown (optional enhancement)

When a project filter is active (not `null` and not `'__unassigned__'`), prepend a non-selectable indicator to the dropdown:

```js
// In renderRunSheetDropdown(), after clearing the dropdown (line 2496):
if (currentProjectFilter && currentProjectFilter !== '__unassigned__') {
    const filterOpt = document.createElement('option');
    filterOpt.disabled = true;
    filterOpt.text = `— Project: ${currentProjectFilter} —`;
    filterOpt.value = '';
    runSheetSelect.appendChild(filterOpt);
}
```

For `'__unassigned__'`, show `— Base Workspace —` as the indicator.

## Verification Plan

> **Session directives:** SKIP compilation (no `npm run compile` / `tsc`) and SKIP automated tests in this session — the project is pre-compiled and tests run separately. The steps below are for the implementer/user to run after the session.

### Automated Tests
- (Run separately by user) Any existing `_refreshRunSheets` / `setProjectFilter` tests. The fix adds a field to the message payload and a direct call — existing assertions on the `runSheets` message should still pass (additive change).

### Manual Verification
1. **Select a project on kanban board**: Open the kanban board, select a specific project from the workspace/project dropdown. Verify the sidebar plan-select dropdown updates to show only plans from that project. Verify the project filter indicator is shown.
2. **Select base workspace (unassigned)**: On the kanban board, select the base workspace option (no project). Verify the sidebar dropdown shows only unassigned plans (no project). Verify the "Base Workspace" indicator.
3. **No project filter / all projects**: If there's a state where no filter is applied, verify the sidebar shows all plans.
4. **Create plan while filtered**: With a project filter active, create a new plan from the sidebar. Verify the new plan appears in the dropdown (it should inherit the active project filter).
5. **Switch workspace**: Switch to a different workspace on the kanban board. Verify the sidebar dropdown resets to the new workspace's plans with the default (unassigned) filter.
6. **Sidebar not visible during filter change**: Close the sidebar, change the project filter on the kanban board, then reopen the sidebar. Verify the dropdown shows the correctly filtered plans.
7. **Console log verification**: Check that `[refreshRunSheets]` logs show the correct `projectFilter` value being passed to the DB query.

## Recommendation

Complexity 5 → **Send to Coder** (multi-file change: backend message payload + handler safety-net call + frontend state + optional UI indicator; the single-flight coalescing needs verification but the changes are additive).

## Review Findings

**Status:** APPROVED with 1 fix applied.

**Files reviewed/changed:** `src/services/TaskViewerProvider.ts` (runSheets posts at lines 15477, 15489, 15544 — all include `projectFilter`), `src/services/KanbanProvider.ts` (setProjectFilter handler, line 5645-5653 — safety-net `refreshUI` call added), `src/webview/implementation.html` (currentProjectFilter state at line 1905, runSheets handler at line 2281, filter indicator at lines 2477-2489, selectedIndex fallback at line 2589).

**Fix applied:** `src/webview/implementation.html:2589` — The fallback `selectedIndex = 0` was landing on the disabled filter-indicator option (prepended at index 0 when a project filter is active), causing `runSheetSelect.value` to be `''` and all action buttons to be disabled. Changed to `selectedIndex = currentProjectFilter ? 1 : 0` to skip the indicator and select the first real plan.

**Verification:** Code inspection confirms all three `runSheets` posts include `projectFilter`. The safety-net `refreshUI` call fires after `_refreshBoard` is awaited (sequential, not concurrent), so the single-flight wrapper does NOT coalesce them — this causes a harmless double-refresh (two DB reads + two postMessages with identical data). The filter indicator is correctly displayed for both project-name and `__unassigned__` filters. Compilation and tests skipped per session directives.

**Remaining risks:** The double-refresh from the safety-net call is a minor performance waste (one extra DB read per filter change). Could be eliminated by removing the direct call and relying solely on the command chain, but the safety net was the plan's explicit intent. No functional risk.
