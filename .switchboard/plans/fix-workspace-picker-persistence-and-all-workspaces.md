# Fix Workspace Picker Persistence and Filter Tickets Dropdown by Integration

## Goal

Fix five workspace dropdowns across `planning.html` and `design.html` that fail to remember the last selected workspace across panel close/reopen and VS Code restart. Also fix the Tickets tab workspace picker to only show workspaces that actually have ClickUp or Linear configured — and hide the picker entirely when only one workspace has an integration.

## Metadata

**Complexity:** 6
**Tags:** bugfix, frontend, ui, reliability

## User Review Required

- Confirm behavior when restored workspace has unreachable integration config: show setup prompt (not fallback to next workspace).
- Confirm conditional picker visibility: hidden when 0 or 1 integration workspace; visible as filtered dropdown when 2+.

## Complexity Audit

### Routine
- Append `.root` keys to existing `tabKeys` arrays in `PlanningPanelProvider.ts` and `DesignPanelProvider.ts`.
- Add `persistTab` to images change handler in `design.js`.
- Sync `_restoredPanelState.panel` for research, notebook, and images in `restoredTabState` handlers.
- Add `_getIntegrationWorkspaces` helper and `integrationWorkspaces` message in backend.
- Add `updateTicketsWorkspacePicker` function and `integrationWorkspaces` message handler in frontend.
- Wrap tickets `<select>` in container with static label in HTML.

### Complex / Risky
- Adjusting `ticketsDefaultRoot` fallback logic to unconditionally prefer the restored root even when its integration config is temporarily unreachable.
- Coordinating `restoredTabState` → `ticketsRootChanged` → `integrationProviderPreference` flow to resolve the missing-provider auto-load race.
- Coordinating `integrationWorkspaces` message arrival with `restoredTabState` and `workspaceItemsUpdated` to avoid flicker or stale dropdown content.
- Ensuring the conditional hide/show of the tickets picker does not break existing tab layout or event handlers.
- Cross-file coordination between `PlanningPanelProvider.ts`, `planning.js`, `design.js`, and `design.html`.

## Problem Analysis

### Root Cause: Systematic Key Mismatch in `tabKeys`

`PanelStateStore` persists panel-level state under keys like `switchboard.panelState.planning.tickets.root.panel`. The `getAllStates()` method iterates a `tabKeys` array and calls `getPanelState(tabKey)` for each. The frontend writes workspace selection state with keys like `'tickets.root'`, but the backend's `tabKeys` array only includes the tab name (`'tickets'`), not the root-selection key (`'tickets.root'`). So `restoredTabState` never sends the persisted workspace back, and the frontend always falls through to defaults.

Working pickers (local, online, kanban in planning; html, design in design) have their `.root` keys present in `tabKeys`. Broken ones do not.

### Broken Picker Inventory

| File | Dropdown ID | Persist Key | tabKeys Has Key? | Root Cause |
|---|---|---|---|---|
| `planning.html` | `tickets-workspace-filter` | `tickets.root` | No (only `'tickets'`) | Missing `.root` key; also shows all workspaces including those without ClickUp/Linear |
| `planning.html` | `research-workspace-filter` | `research.root` | No (only `'research'`) | Missing `.root` key |
| `planning.html` | `notebook-workspace-filter` | `notebook.root` | No (only `'notebook'`) | Missing `.root` key |
| `design.html` | `stitch-workspace-filter` | `stitch.root` | No (only `'stitch'`) | Missing `.root` key |
| `design.html` | `images-workspace-filter` | `images.root` | **Never persisted** | Change handler missing `persistTab` call entirely; `images.root` absent from `tabKeys` |

### Additional Issues

1. **Tickets tab shows irrelevant workspaces**: The tickets workspace picker uses the generic `workspaceItems` list, which includes every VS Code workspace folder. Most of those workspaces have no ClickUp/Linear integration, so selecting them shows an empty or broken state. The picker should only show workspaces with a configured integration.

2. **Tickets picker is redundant with one integration workspace**: When only one workspace has ClickUp/Linear, the dropdown still renders with a single option. It should be hidden and the workspace shown as static text.

3. **Tickets change handler short-circuits on empty values**: `if (!newRoot) return` prevents graceful handling when the picker is hidden or when no integration workspaces exist.

4. **`ticketsDefaultRoot` race/overwrite**: The frontend handler for `ticketsDefaultRoot` blindly assigns `ticketsWorkspaceRoot = msg.workspaceRoot` without checking if a restored value was already set by `restoredTabState`. If `ticketsDefaultRoot` arrives after `restoredTabState`, it clobbers the user's persisted choice.

5. **`lastIntegrationProvider` not restored**: When `restoredTabState` does restore `ticketsWorkspaceRoot` directly, it never sets `lastIntegrationProvider`. Later, the auto-load guard `if (lastIntegrationProvider && !ticketsLoadedOnce)` fails, so tickets don't fetch until manual Refresh.

6. **Backend `ticketsDefaultRoot` over-eager fallback**: When the restored root's ClickUp/Linear config is temporarily unreachable, the backend falls back to iterating all other roots to find one with a valid integration — potentially returning a *different* workspace than the user had selected.

## Edge Cases

- **Stale persisted roots**: If a persisted workspace root is removed from the VS Code workspace, the dropdown should fall back to the first available integration workspace, leaving the `globalState` entry alone so it works again if the repo returns.
- **Race between `restoredTabState` and `ticketsDefaultRoot`**: Both messages may arrive in either order. The frontend must prefer the explicitly restored value over the computed default.
- **Zero integration workspaces**: If no workspace has ClickUp/Linear configured, the frontend should show a "Configure Integration" prompt instead of an empty dropdown.
- **Single integration workspace**: The picker is hidden; tickets load automatically for that workspace without user interaction.
- **Multiple integration workspaces**: The dropdown shows only workspaces with integrations. Selecting one loads tickets for that workspace.
- **Images tab**: Adding `persistTab` to the change handler is new behavior — previously images workspace selection was purely in-memory. This is a bugfix, not a breaking change.

## Edge-Case & Dependency Audit

### Race Conditions
- `restoredTabState`, `workspaceItemsUpdated`, and `integrationWorkspaces` may arrive in any order. The frontend must handle late arrival of `integrationWorkspaces` by re-rendering the tickets picker without overwriting the user's current selection.
- If `integrationWorkspaces` arrives after the user has already manually selected a workspace, the dropdown filter should update but the current selection should be preserved if still valid.
- `ticketsRootChanged` (posted after restore) and `integrationProviderPreference` response may arrive before or after the user switches to the Tickets tab. The frontend's `switchToTab` uses `lastIntegrationProvider && !ticketsLoadedOnce` to trigger fetch, so late arrival is safe.

### Security
- No new user inputs introduced. Workspace root strings are already validated against `allRoots` before use. No injection risk.

### Side Effects
- Images tab now persists workspace selection to global state; previously it was session-only. This is a behavior change but aligns with every other tab.
- Backend `integrationWorkspaces` scans all roots for ClickUp/Linear config at panel init. This is I/O-bound (config file reads) but only happens once per panel lifecycle.
- Backend `ticketsDefaultRoot` may now return a root with `null` provider, causing the frontend to show a "Configure Integration" prompt instead of auto-loading a different workspace.

### Dependencies & Conflicts
- No external dependencies. Internal dependency on `PanelStateStore` key naming convention (`*.root`). If another feature adds new workspace dropdowns, it must follow the same pattern to avoid repeating this bug.
- Conflicts: any concurrent work touching `tabKeys`, `ticketsDefaultRoot`, workspace-filter change handlers, or the `workspaceItemsUpdated` message shape in `planning.js` / `design.js`.

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

### 2. Backend: Expose Integration-Capable Workspaces

#### [NEW] `src/services/PlanningPanelProvider.ts`

Add a private helper that scans all roots for ClickUp/Linear config and returns every workspace that has one:

```typescript
private async _getIntegrationWorkspaces(): Promise<Array<{ workspaceRoot: string; provider: 'clickup' | 'linear' }>> {
    const allRoots = this._getWorkspaceRoots();
    const results: Array<{ workspaceRoot: string; provider: 'clickup' | 'linear' }> = [];
    for (const root of allRoots) {
        try {
            const [clickUpConfig, linearConfig] = await Promise.all([
                this._adapterFactories.getClickUpSyncService(root).loadConfig(),
                this._adapterFactories.getLinearSyncService(root).loadConfig()
            ]);
            const provider = (clickUpConfig?.setupComplete) ? 'clickup'
                : (linearConfig?.setupComplete) ? 'linear'
                : null;
            if (provider) {
                results.push({ workspaceRoot: root, provider });
            }
        } catch {
            // Config unreadable — skip this root
        }
    }
    return results;
}
```

In the `ready` / `fetchRoots` handler (around line ~947), after sending `workspaceItemsUpdated` and `restoredTabState`, also send integration workspaces:

```typescript
const integrationWorkspaces = await this._getIntegrationWorkspaces();
this._panel?.webview.postMessage({
    type: 'integrationWorkspaces',
    workspaces: integrationWorkspaces
});
```

#### [MODIFY] `src/services/PlanningPanelProvider.ts` — Refactor `ticketsDefaultRoot`

Replace the inline scan logic in `ticketsDefaultRoot` (line ~988) with a call to `_getIntegrationWorkspaces()`:

```typescript
case 'ticketsDefaultRoot': {
    const restoredRoot = this._stateStore.getPanelState<string>('tickets.root');
    const integrationWorkspaces = await this._getIntegrationWorkspaces();
    let defaultRoot: string | undefined;
    let defaultProvider: 'clickup' | 'linear' | null = null;

    // Prefer restored root if it still has a valid integration
    if (restoredRoot && integrationWorkspaces.some(w => w.workspaceRoot === restoredRoot)) {
        defaultRoot = restoredRoot;
        defaultProvider = integrationWorkspaces.find(w => w.workspaceRoot === restoredRoot)!.provider;
    }

    // Fall back to first integration workspace
    if (!defaultRoot && integrationWorkspaces.length > 0) {
        defaultRoot = integrationWorkspaces[0].workspaceRoot;
        defaultProvider = integrationWorkspaces[0].provider;
    }

    // Final fallback: restored root or first root (provider null)
    if (!defaultRoot) {
        defaultRoot = (restoredRoot && allRoots.includes(restoredRoot)) ? restoredRoot : allRoots[0];
    }

    this._panel?.webview.postMessage({
        type: 'ticketsDefaultRoot',
        workspaceRoot: defaultRoot,
        provider: defaultProvider
    });
    break;
}
```

### 3. Frontend: Filter Tickets Dropdown by Integration + Conditional Hide

#### [MODIFY] `src/webview/planning.js`

Add a module-level variable to store integration workspaces:

```javascript
let _integrationWorkspaces = []; // Array of { workspaceRoot, provider }
```

In the message handler, add a case for `integrationWorkspaces`:

```javascript
case 'integrationWorkspaces': {
    _integrationWorkspaces = msg.workspaces || [];
    updateTicketsWorkspacePicker();
    break;
}
```

Replace the `tickets-workspace-filter` registration and change handler (around line ~4858) with a dedicated tickets picker setup:

```javascript
function updateTicketsWorkspacePicker() {
    const select = document.getElementById('tickets-workspace-filter');
    const staticLabel = document.getElementById('tickets-workspace-label');
    if (!select || !staticLabel) return;

    const count = _integrationWorkspaces.length;

    if (count === 0) {
        // No integrations — show static "Configure Integration" prompt
        select.style.display = 'none';
        staticLabel.style.display = '';
        staticLabel.textContent = 'Configure ClickUp or Linear in workspace settings to browse tickets.';
        return;
    }

    if (count === 1) {
        // Exactly one integration — hide picker, show workspace name
        select.style.display = 'none';
        staticLabel.style.display = '';
        const single = _integrationWorkspaces[0];
        const item = _workspaceItems.find(i => i.workspaceRoot === single.workspaceRoot);
        staticLabel.textContent = item ? item.label : path.basename(single.workspaceRoot);
        // Auto-select the single workspace if not already set
        if (ticketsWorkspaceRoot !== single.workspaceRoot) {
            ticketsWorkspaceRoot = single.workspaceRoot;
            persistTab('tickets.root', ticketsWorkspaceRoot);
            vscode.postMessage({ type: 'ticketsRootChanged', workspaceRoot: ticketsWorkspaceRoot });
        }
        return;
    }

    // Two or more — show filtered dropdown
    select.style.display = '';
    staticLabel.style.display = 'none';
    const current = ticketsWorkspaceRoot || '';
    select.innerHTML = '';
    for (const ws of _integrationWorkspaces) {
        const item = _workspaceItems.find(i => i.workspaceRoot === ws.workspaceRoot);
        const option = document.createElement('option');
        option.value = ws.workspaceRoot;
        option.textContent = item ? item.label : path.basename(ws.workspaceRoot);
        select.appendChild(option);
    }
    // Preserve current selection if still valid, otherwise select first
    if (_integrationWorkspaces.some(w => w.workspaceRoot === current)) {
        select.value = current;
    } else {
        select.value = _integrationWorkspaces[0].workspaceRoot;
        ticketsWorkspaceRoot = select.value;
        persistTab('tickets.root', ticketsWorkspaceRoot);
        vscode.postMessage({ type: 'ticketsRootChanged', workspaceRoot: ticketsWorkspaceRoot });
    }
}

// Remove the old registerWorkspaceDropdown call for tickets
// registerWorkspaceDropdown('tickets-workspace-filter', 'tickets', false);

// Attach change handler for when dropdown IS visible
document.getElementById('tickets-workspace-filter')?.addEventListener('change', (e) => {
    const newRoot = e.target.value;
    if (!newRoot) return; // Should not happen with filtered list, but guard anyway
    ticketsWorkspaceRoot = newRoot;
    persistTab('tickets.root', ticketsWorkspaceRoot);
    vscode.postMessage({ type: 'ticketsRootChanged', workspaceRoot: ticketsWorkspaceRoot });
    // ... existing root change logic (load tickets, etc.)
});
```

#### [MODIFY] `src/webview/planning.html`

At line ~3161, wrap the select in a container that supports both dropdown and static label modes:

```html
<div class="tickets-workspace-picker">
    <select id="tickets-workspace-filter" class="workspace-filter-select" style="display:none;"></select>
    <span id="tickets-workspace-label" class="workspace-static-label" style="display:none;"></span>
</div>
```

### 4. Frontend: Fix `ticketsDefaultRoot` Race

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

### 5. Frontend: Ensure `lastIntegrationProvider` After Restore

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

### 6. Backend: Prefer Restored Root in `ticketsDefaultRoot`

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

### 7. Frontend: Fix Images Tab Persistence

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

### 8. Frontend: Ensure Restored State Applies to Images and Research/Notebook

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

The Tickets tab workspace picker is unique because not every VS Code workspace has ClickUp/Linear configured. Showing all workspaces in the dropdown creates noise — most options lead to empty or broken states. The fix is to filter the dropdown to only workspaces with a configured integration, and to hide the picker entirely when there's only one such workspace (since there's no meaningful choice to make).

This approach:
- Eliminates dead-end workspace options in the tickets dropdown
- Removes UI clutter when only one workspace has an integration
- Preserves the existing persistence model (`tickets.root`)
- Reuses the backend's integration-scanning logic, just exposes the full list instead of only the first match
- Does NOT implement multi-root ticket aggregation — that remains out of scope

## Verification Plan

1. Open Planning panel → Tickets tab. Select a workspace. Close panel. Reopen. Verify same workspace is selected.
2. Open Planning panel → Research tab. Select a workspace. Close panel. Reopen. Verify same workspace is selected.
3. Open Planning panel → NotebookLM tab. Select a workspace. Close panel. Reopen. Verify same workspace is selected.
4. Open Design panel → Stitch tab. Select a workspace. Close panel. Reopen. Verify same workspace is selected.
5. Open Design panel → Images tab. Select a workspace. Close panel. Reopen. Verify same workspace is selected.
6. Tickets tab with 0 integration workspaces: verify picker shows "Configure ClickUp or Linear..." message and no dropdown.
7. Tickets tab with 1 integration workspace: verify picker is hidden, workspace name shown as static text, tickets auto-load.
8. Tickets tab with 2+ integration workspaces: verify dropdown shows only workspaces with integrations, selecting one loads tickets for that workspace.
7. With a persisted tickets workspace: close VS Code entirely, reopen, open Planning panel → Tickets. Verify the restored workspace is selected and ticket fetching works without manual Refresh.
8. Regression: verify Local Docs, Online Docs, Kanban Plans, HTML Previews, and Design System tabs still remember their workspaces.

## Dependencies

None — all changes are within existing files and use existing `PanelStateStore` / `persistTab` infrastructure.

## Remaining Risks

- If `integrationWorkspaces` arrives after the user has already manually selected a workspace, `updateTicketsWorkspacePicker` may briefly show the wrong filtered list before preserving the valid selection. This is mitigated by the selection-preservation logic in `updateTicketsWorkspacePicker`.
- If the restored root no longer has a valid integration (e.g., config removed), `ticketsDefaultRoot` will fall back to the first available integration workspace. This is acceptable — the user's persisted choice is no longer actionable.
- If `integrationWorkspaces` is slow to arrive (I/O-bound config scanning), the tickets picker may momentarily show the generic workspace list before filtering. This is mitigated by hiding the select by default (`style="display:none"`) and only showing it after `integrationWorkspaces` is received.
- The `images-workspace-filter` change handler addition is a net-new `persistTab` call. If the user previously relied on images always defaulting to the first workspace on panel open, this changes behavior to remember their last choice. This is a bugfix, not a regression.

## Adversarial Synthesis

Key risks: (1) `ticketsDefaultRoot` may still scan every root if the restored root lacks a provider, but the revised logic now pins the returned root to the user's persisted choice when still valid, avoiding workspace hijack. (2) The conditional hide/show of the tickets picker introduces a new UI state machine; if `integrationWorkspaces` and `restoredTabState` arrive out of order, the picker may flicker or show the wrong mode. This is mitigated by defaulting to hidden and only revealing the appropriate mode once both messages are processed. (3) Reusing `ticketsRootChanged` to fetch the provider after restore avoids inventing a new message type, but it assumes the backend handler remains provider-only; any future side effects added to `ticketsRootChanged` would change restore behavior. Mitigations: add a comment in the backend `ticketsRootChanged` case noting that it is also used during restore, and guard `ticketsDefaultRoot` against overwriting restored values.

**Recommendation:** Send to Coder
