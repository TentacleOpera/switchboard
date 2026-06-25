# Workspace Dropdowns in project.html & planning.html Should Default to the Kanban Workspace Selection

## Goal

When the user selects a workspace in the **Kanban** panel (`kanban.html`), the workspace filter dropdowns in **project.html** (Kanban/Epics/Constitution/System/Tuning tabs) and **planning.html** (Docs/Tickets workspace filters) should default to that same workspace on panel open/refresh, instead of each independently falling back to "All Workspaces" or the first workspace item.

### Problem Analysis

The Kanban panel is the canonical workspace selector in Switchboard. `KanbanProvider` persists the user's choice in `context.workspaceState` under `kanban.lastSelectedWorkspace` and exposes it via `getCurrentWorkspaceRoot()` (`src/services/KanbanProvider.ts:711-713`). The kanban webview seeds its `currentWorkspaceRoot` from a `data-initial-workspace-root` body attribute injected at HTML-render time from `this._resolveWorkspaceRoot()` (`KanbanProvider.ts:7789-7793`).

The other two panels do **not** consult this canonical selection:

1. **project.html** (`src/webview/project.js`) — `populateWorkspaceDropdowns()` (`project.js:801-819`) sets `kanbanWorkspaceFilter.value = currentWS` where `currentWS = kanbanFilters.workspaceRoot`, which is initialized to `''` ("All Workspaces") at `project.js:275`. There is no read of the kanban provider's persisted selection. The `kanbanPlansReady` message (`PlanningPanelProvider.ts:2557-2564`) sends `workspaceItems` but **not** the kanban-selected root, so the project panel has no signal to default to it. Additionally, `populateGovernanceFilters()` (`project.js:1627-1644`) populates the Constitution and System workspace filters from `_constitutionWsFilter` / `_systemWsFilter` (both initialized to `''` at `project.js:186-187`), triggered by the `constitutionFilesLoaded` message (`project.js:441-449`) — which also does not carry the kanban root. The `tuningWorkspaceFilter` is populated with options in `populateWorkspaceDropdowns()` but its `.value` is never explicitly set, so it always defaults to "All Workspaces".

2. **planning.html** (`src/webview/planning.js`) — `resolveDocsWorkspaceFilter()` (`planning.js:83-102`) defaults to `items[0].workspaceRoot` (first workspace) when no restored panel state exists. The `ticketsDefaultRoot` handler (`PlanningPanelProvider.ts:1718-1751`) defaults to the first allowed root. Neither consults `kanbanProvider.getCurrentWorkspaceRoot()`. Furthermore, `resolveDocsWorkspaceFilter` is called from **four** sites (`planning.js:73`, `:2600`, `:2634`, `:3566`), and the `onlineDocsReady` message (`PlanningPanelProvider.ts:6319-6324`) does not carry `kanbanWorkspaceRoot` — meaning `handleOnlineDocsReady` (`planning.js:2629-2639`) would overwrite any kanban default set by `handleLocalDocsReady` because `_handleFetchRoots` sends both messages sequentially (`PlanningPanelProvider.ts:6327-6329`).

### Root Cause

There is no cross-panel coordination of the default workspace selection. `PlanningPanelProvider` already holds a reference to the `KanbanProvider` (`this._kanbanProvider`, set via `setKanbanProvider()` at `extension.ts:852`), and `DesignPanelProvider` already uses `kanbanProvider!.getCurrentWorkspaceRoot()` as its default root factory (`extension.ts:856-858`). The planning/project panels simply never call it when computing the default dropdown value.

## Metadata
- **Complexity:** 5
- **Tags:** ui, frontend, feature

## User Review Required

No user review required before implementation. The change is a UX default-value coordination across existing panels, with no data migration, no new user-facing settings, and no breaking changes to persisted state. Override preservation is the only behavioral subtlety, and it is fully specified in the Proposed Changes below.

## Complexity Audit

### Routine
- Adding a `kanbanWorkspaceRoot` field to the `kanbanPlansReady`, `localDocsReady`, and `constitutionFilesLoaded` messages so the webview knows the kanban selection.
- Setting the dropdown `.value` to that root (when no explicit user-override was already restored from panel state) in the existing `populateWorkspaceDropdowns()` / `resolveDocsWorkspaceFilter()` / `ticketsDefaultRoot` / `populateGovernanceFilters()` handlers.
- Setting `tuningWorkspaceFilter.value` in `populateWorkspaceDropdowns()` to match the kanban default.

### Complex / Risky
- **Preserving explicit user overrides:** Each panel persists its own filter selection (e.g. `docs.root`, `tickets.root` via `PanelStateStore`). The kanban default must only apply when the user has **not** already made an explicit choice in that panel. Otherwise switching the kanban workspace would clobber a deliberate per-panel filter — a regression in multi-workspace workflows where the user intentionally views Docs for workspace A while Kanban shows workspace B.
- **Timing / message ordering:** `kanbanPlansReady` and `localDocsReady` arrive independently and may race with `restoredTabState`. The kanban-root default must be applied only after restored state has been considered, and must not override a non-empty restored value.
- **`onlineDocsReady` overwrite race:** `_handleFetchRoots` sends `localDocsReady` then `onlineDocsReady` sequentially. `handleOnlineDocsReady` calls `resolveDocsWorkspaceFilter` without a kanban root argument, which would overwrite the kanban default set by `handleLocalDocsReady`. Fix: store the kanban root in a module-level variable (`_kanbanDefaultRoot`) in planning.js so all call sites can use it as a fallback.
- **`getCurrentWorkspaceRoot()` may be null** on first activation before the user opens the kanban panel. The fallback to the existing behavior (first workspace / All Workspaces) must be preserved.

## Edge-Case & Dependency Audit

### Race Conditions
- `kanbanPlansReady` (project panel) and `localDocsReady`/`restoredTabState` (planning panel) arrive asynchronously. The default-root application must be idempotent: applying the kanban root when the dropdown is still at its initial `''`/first-item state is safe; re-applying after the user manually changed it is not. Guard by only setting the default when the current filter value is empty/unset AND no restored per-panel state exists for that tab.
- **`onlineDocsReady` overwrite:** `handleOnlineDocsReady` (`planning.js:2634`) calls `resolveDocsWorkspaceFilter` without a kanban root. If `handleLocalDocsReady` set the kanban default first, `handleOnlineDocsReady` would reset it to `items[0]`. Mitigated by storing the kanban root in a module-level `_kanbanDefaultRoot` variable that `resolveDocsWorkspaceFilter` reads as a fallback when no explicit `kanbanRoot` argument is provided.
- **`resolveDocsWorkspaceFilter` has 4 call sites** (`planning.js:73`, `:2600`, `:2634`, `:3566`), not 2. All must benefit from the kanban default. The module-level variable approach handles all of them uniformly.

### Security
- None. Workspace roots are local FS paths already present in `workspaceItems`; no new data crosses the webview boundary.

### Side Effects
- **Epics/Constitution/System/Tuning tabs** in project.html share `populateWorkspaceDropdowns()` but each tracks its own filter (`epicsFilters.workspaceRoot`, `_constitutionWsFilter`, `_systemWsFilter`). Only `kanbanWorkspaceFilter` and `epicsWorkspaceFilter` are populated in that function today (`project.js:802`); `tuningWorkspaceFilter` is populated but its `.value` is never set. Constitution and System filters are populated via a separate `populateGovernanceFilters()` function (`project.js:1627`). Applying the kanban default to all of them is the desired behavior (they are all scoped to the same kanban workspace conceptually).
- **`copyChatPrompt`** reads `kanbanWorkspaceFilter.value` (`project.js:1214`) — defaulting it to the kanban root means chat prompts target the kanban-selected workspace, which is the intended UX.
- **Tuning filter has no persisted state** — `tuningWorkspaceFilter` has no `_tuningWsFilter` variable or PanelStateStore key. Its value resets every time `populateWorkspaceDropdowns()` is called (e.g. on `kanbanPlansReady`). Setting it to the kanban root instead of "All Workspaces" is strictly better than the current behavior, though the user's manual tuning selection will be lost on the next kanban refresh. This matches existing behavior (the tuning filter already resets today).

### Dependencies & Conflicts
- **`PlanningPanelProvider._kanbanProvider`** is set at `extension.ts:852`. It is available before any webview message is handled, so `getCurrentWorkspaceRoot()` is safe to call in `fetchKanbanPlans` / `_sendLocalDocsReady` / `ticketsDefaultRoot` / `constitutionFilesLoaded`.
- **`KanbanProvider.getCurrentWorkspaceRoot()`** returns `string | null` (`KanbanProvider.ts:711-713`). Null must be treated as "no kanban selection yet" → fall back to existing default logic.
- **`buildWorkspaceItems`** produces the `workspaceItems` array; the kanban root must be validated against it before applying (it may not be in the allowed-roots list if the kanban selection is stale).
- **`constitutionFilesLoaded`** sends `workspaces` (not `workspaceItems`) — the kanban root must be validated against `msg.workspaces` in the project.js handler, not against `_kanbanWorkspaceItems`.

## Dependencies

None — this plan is self-contained and does not depend on other plans or sessions.

## Adversarial Synthesis

Key risks: (1) the `onlineDocsReady` message overwrites the kanban default set by `localDocsReady` because `resolveDocsWorkspaceFilter` is called from 4 sites, not all carrying the kanban root; (2) the Constitution, System, and Tuning tabs were named in the Goal but entirely missing from the original Proposed Changes; (3) explicit per-panel user overrides must not be clobbered. Mitigations: store the kanban root in a module-level `_kanbanDefaultRoot` variable in planning.js so all `resolveDocsWorkspaceFilter` call sites use it as a fallback; add `kanbanWorkspaceRoot` to the `constitutionFilesLoaded` message and default `_constitutionWsFilter`/`_systemWsFilter`/`tuningWorkspaceFilter` from it; guard every default with a "no restored explicit override" check.

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

#### Change C2 — include `kanbanWorkspaceRoot` in `constitutionFilesLoaded`

In the `constitutionFilesLoaded` postMessage (`:3075-3078`), add the kanban root:

```ts
this._projectPanel?.webview.postMessage({
    type: 'constitutionFilesLoaded',
    workspaces,
    kanbanWorkspaceRoot: this._kanbanProvider?.getCurrentWorkspaceRoot() || null
});
```

### File: `src/webview/project.js`

#### Change D — default `kanbanFilters.workspaceRoot` and `epicsFilters.workspaceRoot` from `kanbanPlansReady`

In the `kanbanPlansReady` handler (`:298-308`), after populating workspace items, seed both the kanban and epics filters from the kanban root when no explicit filter has been set yet. Set both BEFORE calling `populateWorkspaceDropdowns()` so the dropdown values are picked up naturally:

```js
_kanbanPlansCache = msg.plans || [];
_kanbanAllWorkspaceProjects = msg.allWorkspaceProjects || {};
_kanbanWorkspaceItems = msg.workspaceItems || [];
_kanbanAvailableColumns = msg.columns || [];
// Default the workspace filters to the Kanban panel's selection when the
// user has not yet made an explicit choice in this panel.
if (msg.kanbanWorkspaceRoot &&
    _kanbanWorkspaceItems.some(ws => ws.workspaceRoot === msg.kanbanWorkspaceRoot)) {
    if (!kanbanFilters.workspaceRoot) {
        kanbanFilters.workspaceRoot = msg.kanbanWorkspaceRoot;
    }
    if (!epicsFilters.workspaceRoot) {
        epicsFilters.workspaceRoot = msg.kanbanWorkspaceRoot;
    }
}
populateWorkspaceDropdowns();
populateKanbanFilters();
renderKanbanPlans();
```

`populateWorkspaceDropdowns()` already does `kanbanWorkspaceFilter.value = currentWS` (`project.js:817`) and `epicsWorkspaceFilter.value = epicsFilters.workspaceRoot` (`project.js:818`), so setting both filter states before the call propagates the defaults.

#### Change D2 — default `tuningWorkspaceFilter` in `populateWorkspaceDropdowns()`

In `populateWorkspaceDropdowns()` (`project.js:801-819`), after setting the kanban and epics dropdown values, also set the tuning filter to the kanban default when it has no explicit value:

```js
kanbanWorkspaceFilter.value = currentWS;
epicsWorkspaceFilter.value = epicsFilters.workspaceRoot;
if (tuningWorkspaceFilter && currentWS) {
    tuningWorkspaceFilter.value = currentWS;
}
```

Note: the tuning filter has no persisted state, so this resets on every `kanbanPlansReady`. This matches existing behavior (the filter already resets to "All Workspaces" every time).

#### Change D3 — default Constitution and System filters from `constitutionFilesLoaded`

In the `constitutionFilesLoaded` handler (`project.js:441-449`), default `_constitutionWsFilter` and `_systemWsFilter` from the kanban root before calling `populateGovernanceFilters()`:

```js
case 'constitutionFilesLoaded':
    _constitutionWorkspaces = msg.workspaces || [];
    // Default governance filters to the Kanban panel's selection when the
    // user has not yet made an explicit choice.
    if (msg.kanbanWorkspaceRoot &&
        _constitutionWorkspaces.some(ws => ws.workspaceRoot === msg.kanbanWorkspaceRoot)) {
        if (!_constitutionWsFilter) {
            _constitutionWsFilter = msg.kanbanWorkspaceRoot;
        }
        if (!_systemWsFilter) {
            _systemWsFilter = msg.kanbanWorkspaceRoot;
        }
    }
    populateGovernanceFilters();
    renderConstitutionDocList();
    renderSystemDocList();
    break;
```

### File: `src/webview/planning.js`

#### Change E — module-level `_kanbanDefaultRoot` + updated `resolveDocsWorkspaceFilter`

Add a module-level variable near the top of planning.js (after the existing state declarations) to cache the kanban root across all `resolveDocsWorkspaceFilter` call sites:

```js
let _kanbanDefaultRoot = null;
```

Update `resolveDocsWorkspaceFilter()` (`:83-102`) to accept an optional `kanbanRoot` argument and fall back to `_kanbanDefaultRoot` when not provided:

```js
function resolveDocsWorkspaceFilter(workspaceItems, kanbanRoot) {
    const items = workspaceItems || [];
    const panel = _restoredPanelState.panel || {};
    const hasRestored = Object.prototype.hasOwnProperty.call(panel, 'docs.root') && panel['docs.root'] !== undefined;
    const restored = hasRestored ? panel['docs.root'] : null;
    const effectiveKanbanRoot = kanbanRoot !== undefined ? kanbanRoot : _kanbanDefaultRoot;

    let resolved;
    if (restored === '') {
        resolved = ''; // user explicitly chose All Workspaces previously
    } else if (restored && items.some(item => item.workspaceRoot === restored)) {
        resolved = restored; // restored specific root still present
    } else if (effectiveKanbanRoot && items.some(item => item.workspaceRoot === effectiveKanbanRoot)) {
        resolved = effectiveKanbanRoot; // default to the Kanban panel's selection
    } else {
        resolved = items[0] ? items[0].workspaceRoot : ''; // default to first workspace
    }

    state.docsWorkspaceRootFilter = resolved;
    const dropdown = document.getElementById('docs-workspace-filter');
    if (dropdown) dropdown.value = resolved;
    return resolved;
}
```

#### Change E2 — set `_kanbanDefaultRoot` from `handleLocalDocsReady`

In `handleLocalDocsReady` (`:2595-2609`), cache the kanban root and pass it to `resolveDocsWorkspaceFilter`:

```js
function handleLocalDocsReady(msg) {
    console.log('[PlanningPanel Webview] handleLocalDocsReady called:', msg);
    state._lastLocalDocsMsg = msg;
    state.localFolderPathsByRoot = msg.folderPathsByRoot || {};
    state.ticketsFolderPathsByRoot = msg.ticketsFolderPathsByRoot || {};
    if (msg.kanbanWorkspaceRoot !== undefined) {
        _kanbanDefaultRoot = msg.kanbanWorkspaceRoot || null;
    }
    resolveDocsWorkspaceFilter(msg.workspaceItems || [], msg.kanbanWorkspaceRoot || null);
    populateWorkspaceDropdown('docs-workspace-filter', msg.workspaceItems || [], state.docsWorkspaceRootFilter);
    // ... rest unchanged
```

The other call sites (`:73`, `:2634`, `:3566`) do NOT need modification — they call `resolveDocsWorkspaceFilter` without a `kanbanRoot` argument, so the function falls back to `_kanbanDefaultRoot` automatically. This handles the `onlineDocsReady` overwrite race: `handleOnlineDocsReady` (`:2634`) will use the cached `_kanbanDefaultRoot` instead of resetting to `items[0]`.

#### Change F — default tickets workspace from `ticketsDefaultRoot` message

The `ticketsDefaultRoot` message (`:4879-4892`) already sets `ticketsWorkspaceRoot = msg.workspaceRoot`. With Change C, `msg.workspaceRoot` will now be the kanban root when no restored tickets state exists — no webview change needed beyond confirming the existing handler picks it up. No edit required.

## Verification Plan

### Automated Tests

Tests will be run separately by the user. No automated tests are included in this verification plan per session directives.

### Static check
- `grep -n "kanbanWorkspaceRoot" src/services/PlanningPanelProvider.ts src/webview/project.js src/webview/planning.js` — confirm the field is sent and consumed in all three files.
- `grep -n "_kanbanDefaultRoot" src/webview/planning.js` — confirm the module-level variable is declared, set, and read.
- `grep -n "tuningWorkspaceFilter.value" src/webview/project.js` — confirm the tuning filter value is now set in `populateWorkspaceDropdowns()`.

### Manual (installed VSIX)
1. Open the Kanban panel and select a non-default workspace (not the first one). Confirm `currentWorkspaceRoot` updates.
2. Open the Project panel (project.html). Verify the Kanban tab's workspace filter dropdown defaults to the kanban-selected workspace, not "All Workspaces". Verify the Epics tab dropdown also defaults to it.
3. Verify the Constitution tab dropdown defaults to the kanban-selected workspace. Verify the System tab dropdown also defaults to it.
4. Verify the Tuning tab dropdown defaults to the kanban-selected workspace (not "All Workspaces").
5. Open the Planning panel (planning.html). Verify the Docs workspace filter defaults to the kanban-selected workspace (not the first workspace item). Verify it survives the `onlineDocsReady` message arriving after `localDocsReady`.
6. Open the Tickets tab in planning.html with no prior tickets workspace state. Verify the tickets workspace filter defaults to the kanban-selected workspace.
7. **Override preservation:** manually change the Docs workspace filter to a different workspace. Reload the panel. Verify the restored (manually-chosen) value wins over the kanban default.
8. **No kanban selection:** close/reopen VS Code without opening the Kanban panel first. Open Project/Planning panels. Verify they fall back to the existing behavior (first workspace / All Workspaces) without errors.
9. **Multi-workspace:** with 2+ workspaces, switch the kanban selection. Reopen the Project panel. Verify all five dropdowns (Kanban, Epics, Constitution, System, Tuning) reflect the new kanban selection (only when no explicit per-panel override was saved).

---

**Recommendation:** Complexity 5 → **Send to Coder.**
