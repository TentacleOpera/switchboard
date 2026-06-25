# Workspace Dropdowns in project.html & planning.html Should Default to the Kanban Workspace Selection

## Goal

When the user selects a workspace in the **Kanban** panel (`kanban.html`), the workspace filter dropdowns in **project.html** (Kanban/Epics/Constitution/System/Tuning tabs) and **planning.html** (Docs/Tickets workspace filters) should default to that same workspace on panel open/refresh, instead of each independently falling back to "All Workspaces" or the first workspace item.

### Problem Analysis

The Kanban panel is the canonical workspace selector in Switchboard. `KanbanProvider` persists the user's choice in `context.workspaceState` under `kanban.lastSelectedWorkspace` and exposes it via `getCurrentWorkspaceRoot()` (`src/services/KanbanProvider.ts:711-713`). The kanban webview seeds its `currentWorkspaceRoot` from a `data-initial-workspace-root` body attribute injected at HTML-render time from `this._resolveWorkspaceRoot()` (`KanbanProvider.ts:7788-7793`).

The other two panels do **not** consult this canonical selection:

1. **project.html** (`src/webview/project.js`) — `populateWorkspaceDropdowns()` (`project.js:801-819`) sets `kanbanWorkspaceFilter.value = currentWS` where `currentWS = kanbanFilters.workspaceRoot`, which is initialized to `''` ("All Workspaces") at `project.js:275`. There is no read of the kanban provider's persisted selection. The `kanbanPlansReady` message (`PlanningPanelProvider.ts:2557-2564`) sends `workspaceItems` but **not** the kanban-selected root, so the project panel has no signal to default to it.

2. **planning.html** (`src/webview/planning.js`) — `resolveDocsWorkspaceFilter()` (`planning.js:83-102`) defaults to `items[0].workspaceRoot` (first workspace) when no restored panel state exists. The `ticketsDefaultRoot` handler (`PlanningPanelProvider.ts:1718-1751`) defaults to the first allowed root. Neither consults `kanbanProvider.getCurrentWorkspaceRoot()`.

### Root Cause

There is no cross-panel coordination of the default workspace selection. `PlanningPanelProvider` already holds a reference to the `KanbanProvider` (`this._kanbanProvider`, set via `setKanbanProvider()` at `extension.ts:852`), and `DesignPanelProvider` already uses `kanbanProvider!.getCurrentWorkspaceRoot()` as its default root factory (`extension.ts:856-858`). The planning/project panels simply never call it when computing the default dropdown value.

## Metadata
- **Complexity:** 4
- **Tags:** ui, frontend, workspace, coordination

## Complexity Audit

### Routine
- Adding a `kanbanWorkspaceRoot` field to the `kanbanPlansReady` and `localDocsReady` / `ticketsDefaultRoot` messages so the webview knows the kanban selection.
- Setting the dropdown `.value` to that root (when no explicit user-override was already restored from panel state) in the existing `populateWorkspaceDropdowns()` / `resolveDocsWorkspaceFilter()` / `ticketsDefaultRoot` handlers.

### Complex / Risky
- **Preserving explicit user overrides:** Each panel persists its own filter selection (e.g. `docs.root`, `tickets.root` via `PanelStateStore`). The kanban default must only apply when the user has **not** already made an explicit choice in that panel. Otherwise switching the kanban workspace would clobber a deliberate per-panel filter — a regression in multi-workspace workflows where the user intentionally views Docs for workspace A while Kanban shows workspace B.
- **Timing / message ordering:** `kanbanPlansReady` and `localDocsReady` arrive independently and may race with `restoredTabState`. The kanban-root default must be applied only after restored state has been considered, and must not override a non-empty restored value.
- **`getCurrentWorkspaceRoot()` may be null** on first activation before the user opens the kanban panel. The fallback to the existing behavior (first workspace / All Workspaces) must be preserved.

## Edge-Case & Dependency Audit

### Race Conditions
- `kanbanPlansReady` (project panel) and `localDocsReady`/`restoredTabState` (planning panel) arrive asynchronously. The default-root application must be idempotent: applying the kanban root when the dropdown is still at its initial `''`/first-item state is safe; re-applying after the user manually changed it is not. Guard by only setting the default when the current filter value is empty/unset AND no restored per-panel state exists for that tab.

### Security
- None. Workspace roots are local FS paths already present in `workspaceItems`; no new data crosses the webview boundary.

### Side Effects
- **Epics/Constitution/System/Tuning tabs** in project.html share `populateWorkspaceDropdowns()` but each tracks its own filter (`epicsFilters.workspaceRoot`, etc.). Only `kanbanWorkspaceFilter` and `epicsWorkspaceFilter` are populated in that function today (`project.js:802`); the others (`tuningWorkspaceFilter`) are populated but have no separate filter state. Applying the kanban default to all of them is the desired behavior (they are all scoped to the same kanban workspace conceptually).
- **`copyChatPrompt`** reads `kanbanWorkspaceFilter.value` (`project.js:1214`) — defaulting it to the kanban root means chat prompts target the kanban-selected workspace, which is the intended UX.

### Dependencies & Conflicts
- **`PlanningPanelProvider._kanbanProvider`** is set at `extension.ts:852`. It is available before any webview message is handled, so `getCurrentWorkspaceRoot()` is safe to call in `fetchKanbanPlans` / `_sendLocalDocsReady` / `ticketsDefaultRoot`.
- **`KanbanProvider.getCurrentWorkspaceRoot()`** returns `string | null` (`KanbanProvider.ts:711-713`). Null must be treated as "no kanban selection yet" → fall back to existing default logic.
- **`buildWorkspaceItems`** produces the `workspaceItems` array; the kanban root must be validated against it before applying (it may not be in the allowed-roots list if the kanban selection is stale).

## Proposed Changes

### File: `src/services/PlanningPanelProvider.ts`

#### Change A — include `kanbanWorkspaceRoot` in `kanbanPlansReady`

In the `fetchKanbanPlans` handler (`:2557-2564`), add the kanban provider's current root to the message:

```ts
this._projectPanel?.webview.postMessage({
    type: 'kanbanPlansReady',
    plans: allPlans,
    workspaceItems,
    allWorkspaceProjects,
    columns: mergedColumns,
    kanbanWorkspaceRoot: this._kanbanProvider?.getCurrentWorkspaceRoot() || null,
    requestId
});
```

#### Change B — include `kanbanWorkspaceRoot` in `localDocsReady`

In `_sendLocalDocsReady` (`:6265-6274`), add the field:

```ts
this._panel.webview.postMessage({
    type: 'localDocsReady',
    sourceId: 'local-folder',
    folderPathsByRoot: configuredFolderPathsByRoot,
    ticketsFolderPathsByRoot,
    nodes: mappedNodes,
    workspaceItems,
    kanbanWorkspaceRoot: this._kanbanProvider?.getCurrentWorkspaceRoot() || null,
    antigravitySessions,
    antigravityEnabled: agEnabled
});
```

Do the same in the error-branch postMessage (`:6278-6286`).

#### Change C — prefer kanban root in `ticketsDefaultRoot` handler

In `case 'ticketsDefaultRoot'` (`:1718-1751`), consult the kanban provider before falling back to the first allowed root:

```ts
case 'ticketsDefaultRoot': {
    const restoredRoot = this._stateStore.getPanelState<string>('tickets.root');
    const allowedRoots = buildWorkspaceItems(allRoots).map(item => item.workspaceRoot);
    const kanbanRoot = this._kanbanProvider?.getCurrentWorkspaceRoot() || null;
    let defaultRoot: string | undefined;

    if (restoredRoot && allowedRoots.includes(restoredRoot)) {
        defaultRoot = restoredRoot;
    } else if (kanbanRoot && allowedRoots.includes(kanbanRoot)) {
        defaultRoot = kanbanRoot;
    } else if (allowedRoots.length > 0) {
        defaultRoot = allowedRoots[0];
    } else {
        defaultRoot = allRoots[0];
    }
    // ... rest unchanged
```

### File: `src/webview/project.js`

#### Change D — default `kanbanFilters.workspaceRoot` from `kanbanPlansReady`

In the `kanbanPlansReady` handler (`:298-308`), after populating workspace items, seed the filter from the kanban root when no explicit filter has been set yet:

```js
_kanbanPlansCache = msg.plans || [];
_kanbanAllWorkspaceProjects = msg.allWorkspaceProjects || {};
_kanbanWorkspaceItems = msg.workspaceItems || [];
_kanbanAvailableColumns = msg.columns || [];
// Default the workspace filter to the Kanban panel's selection when the
// user has not yet made an explicit choice in this panel.
if (!kanbanFilters.workspaceRoot && msg.kanbanWorkspaceRoot &&
    _kanbanWorkspaceItems.some(ws => ws.workspaceRoot === msg.kanbanWorkspaceRoot)) {
    kanbanFilters.workspaceRoot = msg.kanbanWorkspaceRoot;
}
populateWorkspaceDropdowns();
populateKanbanFilters();
renderKanbanPlans();
```

`populateWorkspaceDropdowns()` already does `kanbanWorkspaceFilter.value = currentWS` (`project.js:817`), so setting `kanbanFilters.workspaceRoot` before the call propagates the default. The `epicsWorkspaceFilter` should also default to the same root — add after `populateWorkspaceDropdowns()`:

```js
if (!epicsFilters.workspaceRoot && msg.kanbanWorkspaceRoot &&
    _kanbanWorkspaceItems.some(ws => ws.workspaceRoot === msg.kanbanWorkspaceRoot)) {
    epicsFilters.workspaceRoot = msg.kanbanWorkspaceRoot;
    if (epicsWorkspaceFilter) epicsWorkspaceFilter.value = msg.kanbanWorkspaceRoot;
}
```

### File: `src/webview/planning.js`

#### Change E — default `docsWorkspaceRootFilter` from `localDocsReady`

In `resolveDocsWorkspaceFilter()` (`:83-102`), accept an optional `kanbanRoot` argument and prefer it over the first-item fallback:

```js
function resolveDocsWorkspaceFilter(workspaceItems, kanbanRoot) {
    const items = workspaceItems || [];
    const panel = _restoredPanelState.panel || {};
    const hasRestored = Object.prototype.hasOwnProperty.call(panel, 'docs.root') && panel['docs.root'] !== undefined;
    const restored = hasRestored ? panel['docs.root'] : null;

    let resolved;
    if (restored === '') {
        resolved = ''; // user explicitly chose All Workspaces previously
    } else if (restored && items.some(item => item.workspaceRoot === restored)) {
        resolved = restored; // restored specific root still present
    } else if (kanbanRoot && items.some(item => item.workspaceRoot === kanbanRoot)) {
        resolved = kanbanRoot; // default to the Kanban panel's selection
    } else {
        resolved = items[0] ? items[0].workspaceRoot : ''; // default to first workspace
    }

    state.docsWorkspaceRootFilter = resolved;
    const dropdown = document.getElementById('docs-workspace-filter');
    if (dropdown) dropdown.value = resolved;
    return resolved;
}
```

Update the two call sites (`:2601`, `:2635`) to pass `msg.kanbanWorkspaceRoot`:

```js
resolveDocsWorkspaceFilter(msg.workspaceItems || [], msg.kanbanWorkspaceRoot || null);
```

#### Change F — default tickets workspace from `ticketsDefaultRoot` message

The `ticketsDefaultRoot` message (`:4880-4892`) already sets `ticketsWorkspaceRoot = msg.workspaceRoot`. With Change C, `msg.workspaceRoot` will now be the kanban root when no restored tickets state exists — no webview change needed beyond confirming the existing handler picks it up. No edit required.

## Verification Plan

### Static check
- `grep -n "kanbanWorkspaceRoot" src/services/PlanningPanelProvider.ts src/webview/project.js src/webview/planning.js` — confirm the field is sent and consumed in all three files.

### Manual (installed VSIX)
1. Open the Kanban panel and select a non-default workspace (not the first one). Confirm `currentWorkspaceRoot` updates.
2. Open the Project panel (project.html). Verify the Kanban tab's workspace filter dropdown defaults to the kanban-selected workspace, not "All Workspaces". Verify the Epics tab dropdown also defaults to it.
3. Open the Planning panel (planning.html). Verify the Docs workspace filter defaults to the kanban-selected workspace (not the first workspace item).
4. Open the Tickets tab in planning.html with no prior tickets workspace state. Verify the tickets workspace filter defaults to the kanban-selected workspace.
5. **Override preservation:** manually change the Docs workspace filter to a different workspace. Reload the panel. Verify the restored (manually-chosen) value wins over the kanban default.
6. **No kanban selection:** close/reopen VS Code without opening the Kanban panel first. Open Project/Planning panels. Verify they fall back to the existing behavior (first workspace / All Workspaces) without errors.
7. **Multi-workspace:** with 2+ workspaces, switch the kanban selection. Reopen the Project panel. Verify the dropdown reflects the new kanban selection (only when no explicit per-panel override was saved).

---

**Recommendation:** Complexity 4 → **Send to Intern.**
