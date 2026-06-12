# Fix Workspace Picker Persistence and Add "All Workspaces" to Tickets Tab

## Goal

Fix five workspace dropdowns across `planning.html` and `design.html` that fail to remember the last selected workspace across panel close/reopen and VS Code restart. Also add the missing "All Workspaces" aggregate view to the Tickets tab.

## Metadata

**Complexity:** 6
**Tags:** bugfix, frontend, ui, reliability

## User Review Required

- Confirm behavior when restored workspace has unreachable integration config: show setup prompt (not fallback to next workspace).
- Confirm "All Workspaces" resolution behavior: when selected, the backend scans all roots and returns the first with a valid ClickUp/Linear config, then the frontend loads tickets for that resolved workspace.

## Complexity Audit

### Routine
- Append `.root` keys to existing `tabKeys` arrays in `PlanningPanelProvider.ts` and `DesignPanelProvider.ts`.
- Add `<option value="">All Workspaces</option>` to tickets dropdown HTML.
- Flip `includeAllOption` boolean in `registerWorkspaceDropdown` call.
- Add `persistTab` to images change handler in `design.js`.
- Sync `_restoredPanelState.panel` for research, notebook, and images in `restoredTabState` handlers.

### Complex / Risky
- Adjusting `ticketsDefaultRoot` fallback logic to unconditionally prefer the restored root even when its integration config is temporarily unreachable.
- Coordinating `restoredTabState` → `ticketsRootChanged` → `integrationProviderPreference` flow to resolve the missing-provider auto-load race.
- Ensuring the "All Workspaces" auto-resolve via `ticketsDefaultRoot` does not conflict with the `ticketsDefaultRoot` guard that prevents overwriting a restored specific workspace.
- Cross-file coordination between `PlanningPanelProvider.ts`, `planning.js`, `design.js`, and `design.html`.

## Problem Analysis

### Root Cause: Systematic Key Mismatch in `tabKeys`

`PanelStateStore` persists panel-level state under keys like `switchboard.panelState.planning.tickets.root.panel`. The `getAllStates()` method iterates a `tabKeys` array and calls `getPanelState(tabKey)` for each. The frontend writes workspace selection state with keys like `'tickets.root'`, but the backend's `tabKeys` array only includes the tab name (`'tickets'`), not the root-selection key (`'tickets.root'`). So `restoredTabState` never sends the persisted workspace back, and the frontend always falls through to defaults.

Working pickers (local, online, kanban in planning; html, design in design) have their `.root` keys present in `tabKeys`. Broken ones do not.

### Broken Picker Inventory

| File | Dropdown ID | Persist Key | tabKeys Has Key? | Root Cause |
|---|---|---|---|---|
| `planning.html` | `tickets-workspace-filter` | `tickets.root` | No (only `'tickets'`) | Missing `.root` key; also lacks "All Workspaces" option |
| `planning.html` | `research-workspace-filter` | `research.root` | No (only `'research'`) | Missing `.root` key |
| `planning.html` | `notebook-workspace-filter` | `notebook.root` | No (only `'notebook'`) | Missing `.root` key |
| `design.html` | `stitch-workspace-filter` | `stitch.root` | No (only `'stitch'`) | Missing `.root` key |
| `design.html` | `images-workspace-filter` | `images.root` | **Never persisted** | Change handler missing `persistTab` call entirely; `images.root` absent from `tabKeys` |

### Additional Issues

1. **Tickets tab lacks "All Workspaces"**: `registerWorkspaceDropdown('tickets-workspace-filter', 'tickets', false)` passes `includeAllOption = false`, while every other tab passes `true`. The `<select>` in HTML is also empty, lacking the `<option value="">All Workspaces</option>` hardcoded in the other tabs. The change handler short-circuits on empty values (`if (!newRoot) return`), preventing the auto-resolve flow from functioning.

2. **`ticketsDefaultRoot` race/overwrite**: The frontend handler for `ticketsDefaultRoot` blindly assigns `ticketsWorkspaceRoot = msg.workspaceRoot` without checking if a restored value was already set by `restoredTabState`. If `ticketsDefaultRoot` arrives after `restoredTabState`, it clobbers the user's persisted choice.

3. **`lastIntegrationProvider` not restored**: When `restoredTabState` does restore `ticketsWorkspaceRoot` directly, it never sets `lastIntegrationProvider`. Later, the auto-load guard `if (lastIntegrationProvider && !ticketsLoadedOnce)` fails, so tickets don't fetch until manual Refresh.

4. **Backend `ticketsDefaultRoot` over-eager fallback**: When the restored root's ClickUp/Linear config is temporarily unreachable, the backend falls back to iterating all other roots to find one with a valid integration — potentially returning a *different* workspace than the user had selected.

## Edge Cases

- **Stale persisted roots**: If a persisted workspace root is removed from the VS Code workspace, the dropdown should fall back to the tab default ("All Workspaces" or first workspace), leaving the `globalState` entry alone so it works again if the repo returns.
- **Race between `restoredTabState` and `ticketsDefaultRoot`**: Both messages may arrive in either order. The frontend must prefer the explicitly restored value over the computed default.
- **"All Workspaces" + tickets fetch**: If the user selects "All Workspaces", the frontend delegates to `ticketsDefaultRoot`, which scans all roots and returns the first one with a valid ClickUp/Linear config. This is auto-resolution, not aggregation. The resolved workspace is then loaded normally.
- **Images tab**: Adding `persistTab` to the change handler is new behavior — previously images workspace selection was purely in-memory. This is a bugfix, not a breaking change.

## Edge-Case & Dependency Audit

### Race Conditions
- `restoredTabState` and `ticketsDefaultRoot` may arrive in either order. The frontend guard in `ticketsDefaultRoot` prevents overwrite, but if the restored root is invalid (e.g., repo removed) the fallback workspace may be selected instead of "All Workspaces".
- `ticketsRootChanged` (posted after restore) and `integrationProviderPreference` response may arrive before or after the user switches to the Tickets tab. The frontend's `switchToTab` uses `lastIntegrationProvider && !ticketsLoadedOnce` to trigger fetch, so late arrival is safe.

### Security
- No new user inputs introduced. Workspace root strings are already validated against `allRoots` before use. No injection risk.

### Side Effects
- Images tab now persists workspace selection to global state; previously it was session-only. This is a behavior change but aligns with every other tab.
- Backend `ticketsDefaultRoot` may now return a root with `null` provider, causing the frontend to show a "Configure Integration" prompt instead of auto-loading a different workspace.

### Dependencies & Conflicts
- No external dependencies. Internal dependency on `PanelStateStore` key naming convention (`*.root`). If another feature adds new workspace dropdowns, it must follow the same pattern to avoid repeating this bug.
- Conflicts: any concurrent work touching `tabKeys`, `ticketsDefaultRoot`, or workspace-filter change handlers in `planning.js` / `design.js`.

## Proposed Changes

### 1. Backend: Add Missing `.root` Keys to `tabKeys`

#### [MODIFY] `src/services/PlanningPanelProvider.ts`

Change the `tabKeys` array at line ~939 from:
```typescript
const tabKeys = ['local', 'online', 'kanban', 'tickets', 'research', 'notebook', 'localDocs.root', 'onlineDocs.root', 'kanban.root', 'kanban.project'];
```
To:
```typescript
const tabKeys = ['local', 'online', 'kanban', 'tickets', 'research', 'notebook', 'localDocs.root', 'onlineDocs.root', 'kanban.root', 'kanban.project', 'tickets.root', 'research.root', 'notebook.root'];
```

#### [MODIFY] `src/services/DesignPanelProvider.ts`

Change the `tabKeys` array at line ~841 from:
```typescript
const tabKeys = ['stitch', 'html-preview', 'images', 'design', 'html.root', 'design.root', 'briefs', 'briefs.root'];
```
To:
```typescript
const tabKeys = ['stitch', 'html-preview', 'images', 'design', 'html.root', 'design.root', 'briefs', 'briefs.root', 'stitch.root', 'images.root'];
```

### 2. Frontend: Add "All Workspaces" to Tickets Tab

#### [MODIFY] `src/webview/planning.html`

At line ~3161, change:
```html
<select id="tickets-workspace-filter" class="workspace-filter-select"></select>
```
To:
```html
<select id="tickets-workspace-filter" class="workspace-filter-select">
    <option value="">All Workspaces</option>
</select>
```

#### [MODIFY] `src/webview/planning.js`

At line ~4858, change:
```javascript
registerWorkspaceDropdown('tickets-workspace-filter', 'tickets', false);
```
To:
```javascript
registerWorkspaceDropdown('tickets-workspace-filter', 'tickets', true);
```

At line ~4862, the change handler currently has:
```javascript
if (!newRoot) return;
```
This must be replaced with logic that triggers the auto-resolve flow. When `newRoot === ''` ("All Workspaces"), the frontend posts `ticketsDefaultRoot` and lets the backend scan all roots to find the one with a valid integration.

Update the handler to:
```javascript
ticketsWorkspaceRoot = newRoot;
persistTab('tickets.root', ticketsWorkspaceRoot);
if (!newRoot) {
    // "All Workspaces" selected — let backend resolve the best workspace
    resetTicketsInMemoryState();
    vscode.postMessage({ type: 'ticketsDefaultRoot' });
    return;
}
// ... existing root change logic
```

### 3. Frontend: Fix `ticketsDefaultRoot` Race

#### [MODIFY] `src/webview/planning.js`

At line ~3403 (`case 'ticketsDefaultRoot'`), add a guard:
```javascript
case 'ticketsDefaultRoot': {
    // Don't overwrite a value already restored from persisted state
    if (ticketsWorkspaceRoot && _workspaceItems.some(item => item.workspaceRoot === ticketsWorkspaceRoot)) {
        break;
    }
    ticketsWorkspaceRoot = msg.workspaceRoot || '';
    // ... rest of existing logic
```

### 4. Frontend: Ensure `lastIntegrationProvider` After Restore

#### [MODIFY] `src/webview/planning.js`

At line ~2438 (`case 'restoredTabState'`), after restoring `ticketsWorkspaceRoot`, request the provider preference:
```javascript
if (!ticketsWorkspaceRoot) {
    // ... existing restore logic
} else {
    // Already restored from panel state — trigger provider lookup via existing backend path
    vscode.postMessage({ type: 'ticketsRootChanged', workspaceRoot: ticketsWorkspaceRoot });
}
```

### 5. Backend: Prefer Restored Root in `ticketsDefaultRoot`

#### [MODIFY] `src/services/PlanningPanelProvider.ts`

At line ~979 (`case 'ticketsDefaultRoot'`), change the fallback logic. If `restoredRoot` exists and is in `allRoots`, always return it as `defaultRoot` even if its integration config is temporarily unreachable. The provider can be `null` in that case, and the frontend can show a "configure integration" state instead of jumping to a different workspace.

```typescript
case 'ticketsDefaultRoot': {
    const restoredRoot = this._stateStore.getPanelState<string>('tickets.root');
    let defaultRoot: string | undefined;
    let defaultProvider: 'clickup' | 'linear' | null = null;

    // Always prefer the restored root if it exists, even if config is unreachable
    if (restoredRoot && allRoots.includes(restoredRoot)) {
        defaultRoot = restoredRoot;
        try {
            const [clickUpConfig, linearConfig] = await Promise.all([
                this._adapterFactories.getClickUpSyncService(restoredRoot).loadConfig(),
                this._adapterFactories.getLinearSyncService(restoredRoot).loadConfig()
            ]);
            defaultProvider = (clickUpConfig?.setupComplete) ? 'clickup'
                : (linearConfig?.setupComplete) ? 'linear'
                : null;
        } catch {
            defaultProvider = null; // Config unreadable — let frontend show setup prompt
        }
    }

    // Only fall back to scanning other roots if no restored root
    if (!defaultRoot) {
        // ... existing scan-all-roots logic
    }
    // ...
}
```

### 6. Frontend: Fix Images Tab Persistence

#### [MODIFY] `src/webview/design.js`

At line ~1989, the images workspace change handler currently reads:
```javascript
document.getElementById('images-workspace-filter')?.addEventListener('change', (e) => {
    state.imagesWorkspaceRootFilter = e.target.value;
    // ... renders but never persists
});
```

Add `persistTab` call and keep snapshot in sync:
```javascript
document.getElementById('images-workspace-filter')?.addEventListener('change', (e) => {
    state.imagesWorkspaceRootFilter = e.target.value;
    _restoredPanelState.panel['images.root'] = e.target.value;
    persistTab('images.root', state.imagesWorkspaceRootFilter);
    // ... existing render logic
});
```

### 7. Frontend: Ensure Restored State Applies to Images and Research/Notebook

#### [MODIFY] `src/webview/planning.js`

In the `restoredTabState` handler (around line ~2474), research and notebook roots are restored but **not** synced to `_restoredPanelState.panel` (unlike local/online which do). Add:
```javascript
_restoredPanelState.panel['research.root'] = researchWorkspaceRoot;
_restoredPanelState.panel['notebook.root'] = notebookWorkspaceRoot;
```

#### [MODIFY] `src/webview/design.js`

In the `restoredTabState` handler (around line ~2154), images root is not restored at all. Add:
```javascript
const restoredImagesRoot = _restoredPanelState.panel['images.root'] || '';
if (_workspaceItems.length === 0 || restoredImagesRoot === '' || _workspaceItems.some(i => i.workspaceRoot === restoredImagesRoot)) {
    state.imagesWorkspaceRootFilter = restoredImagesRoot;
} else {
    state.imagesWorkspaceRootFilter = '';
}
const imagesSelect = document.getElementById('images-workspace-filter');
if (imagesSelect) imagesSelect.value = state.imagesWorkspaceRootFilter;
```

## All Workspaces Implementation Strategy

The "All Workspaces" option for tickets is a **smart default** that delegates workspace selection to the backend's existing `ticketsDefaultRoot` logic. When the user has multiple VS Code workspaces open but only one has ClickUp/Linear configured, the workspace picker is noise. Selecting "All Workspaces" triggers `ticketsDefaultRoot`, which scans all roots, finds the first one with a valid integration, and returns it. The frontend then loads tickets for that resolved workspace exactly as if the user had picked it directly.

**This is auto-resolution, not aggregation.** True multi-root ticket aggregation would require querying every configured workspace and merging results from two different APIs — that is out of scope and should be a separate plan if needed.

## Verification Plan

1. Open Planning panel → Tickets tab. Select a workspace. Close panel. Reopen. Verify same workspace is selected.
2. Open Planning panel → Research tab. Select a workspace. Close panel. Reopen. Verify same workspace is selected.
3. Open Planning panel → NotebookLM tab. Select a workspace. Close panel. Reopen. Verify same workspace is selected.
4. Open Design panel → Stitch tab. Select a workspace. Close panel. Reopen. Verify same workspace is selected.
5. Open Design panel → Images tab. Select a workspace. Close panel. Reopen. Verify same workspace is selected.
6. Tickets tab: verify "All Workspaces" appears in dropdown. Selecting it triggers `ticketsDefaultRoot`, which resolves to the workspace with a ClickUp/Linear config, and tickets load for that workspace.
7. With a persisted tickets workspace: close VS Code entirely, reopen, open Planning panel → Tickets. Verify the restored workspace is selected and ticket fetching works without manual Refresh.
8. Regression: verify Local Docs, Online Docs, Kanban Plans, HTML Previews, and Design System tabs still remember their workspaces.

## Dependencies

None — all changes are within existing files and use existing `PanelStateStore` / `persistTab` infrastructure.

## Remaining Risks

- If `restoredTabState` and `ticketsDefaultRoot` arrive in rapid succession with the restored root invalid (e.g., repo removed), the user will see the fallback workspace rather than "All Workspaces". This is acceptable — the stale root fallback behavior is consistent with other tabs.
- The `images-workspace-filter` change handler addition is a net-new `persistTab` call. If the user previously relied on images always defaulting to the first workspace on panel open, this changes behavior to remember their last choice. This is a bugfix, not a regression.

## Adversarial Synthesis

Key risks: (1) `ticketsDefaultRoot` may still scan every root if the restored root lacks a provider, but the revised logic now pins the returned root to the user's persisted choice, avoiding workspace hijack. (2) "All Workspaces" delegates to `ticketsDefaultRoot` which may resolve to a workspace the user did not intend if multiple roots have integrations; this is acceptable because the user explicitly chose the auto-resolve option. (3) Reusing `ticketsRootChanged` to fetch the provider after restore avoids inventing a new message type, but it assumes the backend handler remains provider-only; any future side effects added to `ticketsRootChanged` would change restore behavior. Mitigations: add a comment in the backend `ticketsRootChanged` case noting that it is also used during restore, and guard `ticketsDefaultRoot` against overwriting restored values.

**Recommendation:** Send to Coder
