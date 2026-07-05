# Fix: Remove or Clarify Confusing Docs-Tab Sync Mode Dropdown

**Plan ID:** c9f3b8e2-5d6a-4719-8b3c-2e7d6f9a4c1b

## Goal

Address the confusing "Manual / Auto Sync All / Sync Selected Containers" dropdown (`docs-cache-mode`) in the planning.html Docs tab controls strip. The user reports this dropdown is unintelligible, was never requested, and they don't understand what it does. The plan is to **remove the dropdown** entirely, since its functionality is either redundant with existing per-source sync buttons or not needed in the Docs tab context.

### Problem & background

The Docs tab controls strip (planning.html:3557-3583) contains a `<select id="docs-cache-mode">` with three options:
- `no-sync` (label: "Manual") — default, selected
- `auto-sync-all` (label: "Auto Sync All")
- `sync-selected` (label: "Sync Selected Containers")

This dropdown was introduced in commit `6f64897` (2026-06-19, "Simplify Setup Panel: Remove Kanban & Artifacts Tabs, Relocate Settings"). It controls the `PlanningPanelCacheService` sync mode, which periodically caches all online documents (ClickUp, Linear, Notion) to local storage.

**What the dropdown actually does:**
- **Manual (no-sync)**: No automatic caching. Documents are fetched on-demand when clicked.
- **Auto Sync All**: Every 30 minutes, `syncAllDocuments()` iterates all online sources and caches every document's content locally via `PlanningPanelCacheService.cacheDocument()`.
- **Sync Selected Containers**: Every 30 minutes, `syncSelectedContainers()` caches only documents from user-selected containers (ClickUp lists, Linear projects, Notion pages, local folders). Selecting this mode reveals a container picker (`docs-sync-container-picker`) with checkboxes.

**Why it's confusing:**
1. The labels are vague — "Manual" vs "Auto Sync All" vs "Sync Selected Containers" don't explain what's being synced, where, or why.
2. The dropdown sits in the Docs tab controls strip alongside unrelated controls (workspace filter, source filter, search, edit/save buttons) with no visual separation or explanation.
3. The "Sync Selected Containers" mode reveals a secondary picker panel that pushes the sidebar down, which is jarring.
4. The feature overlaps with the existing per-source "Sync to Online" button (`btn-sync-to-online`) and the per-source refresh buttons, making it unclear which sync mechanism to use.
5. The user explicitly states "I never asked for this" — the dropdown was added as part of a setup-panel simplification commit, not in response to a user request.

### Root cause

The dropdown was added as part of a broader setup-panel reorganization (commit `6f64897`) that relocated settings into the planning panel. The sync-mode feature was likely intended for power users who want offline access to all online docs, but it was placed in the main Docs tab controls strip without adequate labeling, documentation, or user onboarding — making it appear as an unrequested, confusing control.

The sync mode is persisted in the Kanban database (`planning.syncMode` config key) and read back on panel init via `getPlanningPanelSyncMode` message. The periodic sync timer (`startPeriodicSync`) runs every 30 minutes when mode is not `no-sync`.

## Metadata

- **Tags**: ux, cleanup, docs-tab, planning-panel, sync
- **Complexity**: 3/10
- **Files**: src/webview/planning.html, src/webview/planning.js, src/services/PlanningPanelProvider.ts

## Complexity Audit

**Routine:**
- Removing the `<select>` element and its container picker from planning.html
- Removing the `change` event listener and `planningPanelSyncModeReady`/`availableSyncContainersReady` message handlers from planning.js
- Removing the `getPlanningPanelSyncMode`, `setPlanningPanelSyncMode`, `fetchAvailableSyncContainers`, `setPlanningPanelSelectedContainers` message handlers from PlanningPanelProvider.ts
- Removing `syncAllDocuments`, `syncSelectedContainers`, `startPeriodicSync`, `stopPeriodicSync`, `triggerSync` methods (if not used elsewhere)

**Complex/Risky:**
- Determining whether the periodic sync functionality is used by any other feature or test
- Migrating any users who have `planning.syncMode` set to a non-default value (per CLAUDE.md migration rules — this setting shipped in a released version, so we must migrate)
- Ensuring `stopPeriodicSync()` is still called in `dispose()` to clean up any running timer

## Edge-Case & Dependency Audit

- **Migration**: Per CLAUDE.md, `planning.syncMode` and `planning.selectedContainers` may exist in the Kanban DB for users who set them. Since this shipped in a released version (~4,000 installs), we must not silently leave orphaned config. The removal should either: (a) leave the config keys in the DB harmlessly (they'll just never be read), or (b) explicitly clear them on next panel init. Option (a) is safer — no data loss risk.
- **Periodic sync timer**: If a user had `auto-sync-all` mode active, `startPeriodicSync` is running a 30-minute `setInterval`. The `dispose()` method calls `stopPeriodicSync()` which clears it. After removing the dropdown, the timer won't be started on new panel opens, but existing running timers (from a previous session) will be cleaned up on dispose.
- **`triggerSync` usage**: Check if `triggerSync` is called from anywhere other than the `setPlanningPanelSyncMode` handler. If it's called on panel init (line 582), that call must also be removed.
- **`_resolveSyncConfig` usage**: This method is used by multiple handlers (savePlanningContainerSelection, createOnlineDocument, setPlanningPanelSyncMode). It reads `planning.syncMode` among other config. Removing the sync mode dropdown doesn't require removing `_resolveSyncConfig` — it still reads `browseFilterContainers`, `uploadLocations`, and `docMappings` which are used by other features.
- **Container picker**: The `docs-sync-container-picker` div (planning.html:3584-3587) and its `docs-containers-list` child are only shown when mode is `sync-selected`. Removing the dropdown removes the need for this panel too.
- **Tests**: Check for any tests that reference `planningPanelSyncMode`, `setPlanningPanelSyncMode`, `syncAllDocuments`, or `syncSelectedContainers`.

## Proposed Changes

### 1. Remove the dropdown and container picker from planning.html

**File**: `src/webview/planning.html`
**Lines**: 3569-3573 (dropdown) and 3584-3587 (container picker)
**Change**: Remove both elements:
```html
<!-- REMOVE these lines: -->
<select id="docs-cache-mode" class="workspace-filter-select" style="margin-right: 12px;" title="Document caching mode">
    <option value="no-sync" selected>Manual</option>
    <option value="auto-sync-all">Auto Sync All</option>
    <option value="sync-selected">Sync Selected Containers</option>
</select>
```
```html
<!-- REMOVE these lines: -->
<div id="docs-sync-container-picker" style="display: none; ...">
    <div style="font-weight: bold; ...">Sync Selected Containers:</div>
    <div id="docs-containers-list" style="..."></div>
</div>
```

### 2. Remove the dropdown event listener and message handlers from planning.js

**File**: `src/webview/planning.js`
**Lines**: ~1372-1385 (docs-cache-mode change listener), ~3948-3963 (planningPanelSyncModeReady handler), ~3964-4019 (availableSyncContainersReady handler), ~1555 and ~10936 (getPlanningPanelSyncMode message sends)
**Change**: Remove the `docs-cache-mode` change event listener, the `planningPanelSyncModeReady` case, the `availableSyncContainersReady` case, and the two `getPlanningPanelSyncMode` message sends.

Specifically remove:
```javascript
// Line ~1372-1385: docs-cache-mode change listener
document.getElementById('docs-cache-mode')?.addEventListener('change', (e) => {
    const mode = e.target.value;
    vscode.postMessage({ type: 'setPlanningPanelSyncMode', mode });
    // ... picker visibility logic
});

// Line ~1555: getPlanningPanelSyncMode send in tab switch
if (tabName === 'docs') {
    vscode.postMessage({ type: 'getPlanningPanelSyncMode' });  // REMOVE
    vscode.postMessage({ type: 'fetchKanbanPlans', requestId: Date.now() });
}

// Line ~10936: getPlanningPanelSyncMode send on init
vscode.postMessage({ type: 'getPlanningPanelSyncMode' });  // REMOVE

// Lines ~3948-3963: planningPanelSyncModeReady case
case 'planningPanelSyncModeReady': { ... }  // REMOVE

// Lines ~3964-4019: availableSyncContainersReady case
case 'availableSyncContainersReady': { ... }  // REMOVE
```

### 3. Remove the sync mode message handlers from PlanningPanelProvider.ts

**File**: `src/services/PlanningPanelProvider.ts`
**Lines**: ~6753-6782 (getPlanningPanelSyncMode), ~6784-6797 (setPlanningPanelSyncMode), ~6798-6858 (fetchAvailableSyncContainers), ~6860-6872 (setPlanningPanelSelectedContainers)
**Change**: Remove all four message cases. Also remove the `triggerSync` call on panel init (line ~582):
```typescript
// Line ~578-583: Remove this block from panel init
const { config, sourceRoot } = await this._resolveSyncConfig();
const syncMode = config.syncMode || 'no-sync';
if (syncMode !== 'no-sync' && sourceRoot) {
    await this.triggerSync(sourceRoot, syncMode);
}
```

### 4. Remove the sync methods from PlanningPanelProvider.ts (if not used elsewhere)

**File**: `src/services/PlanningPanelProvider.ts`
**Lines**: ~8682-8728 (syncAllDocuments), ~8730-8774 (syncSelectedContainers), ~8776-8797 (startPeriodicSync), ~8799-8806 (stopPeriodicSync), ~8808-8831 (triggerSync)
**Change**: Search for all references to these methods. If they are only called from the removed message handlers and `dispose()`, remove them. Keep `stopPeriodicSync()` call in `dispose()` (line 9139) as a safety cleanup, but the method body can remain as a no-op if the timer is never started.

**Before removing, verify with grep:**
```bash
grep -rn "syncAllDocuments\|syncSelectedContainers\|startPeriodicSync\|triggerSync" src/
```

### 5. Clean up related state fields

**File**: `src/services/PlanningPanelProvider.ts`
**Lines**: ~81-84
**Change**: Remove the unused state fields (only if methods are removed):
```typescript
// Remove these if sync methods are removed:
private _periodicSyncTimer: NodeJS.Timeout | undefined;
private _currentSyncMode: string = 'no-sync';
private _syncCancellationSource: AbortController | undefined;
```

Keep `stopPeriodicSync()` as a no-op safety in `dispose()`:
```typescript
public dispose(): void {
    this.stopPeriodicSync();  // no-op if timer was never started, but safe
    // ... rest of dispose
}
```

## Verification Plan

1. **Docs tab loads without errors**:
   - Open planning panel → Docs tab
   - Verify the controls strip no longer shows the "Manual / Auto Sync All / Sync Selected Containers" dropdown
   - Verify no JavaScript console errors

2. **Existing docs functionality intact**:
   - Verify local docs still list in the sidebar
   - Verify online docs (ClickUp, Linear, Notion) still list if configured
   - Verify the "Sync to Online" button still works for individual documents
   - Verify the source filter dropdown still works
   - Verify the workspace filter dropdown still works
   - Verify search still works

3. **No orphaned container picker**:
   - Verify the `docs-sync-container-picker` div is no longer in the DOM
   - Verify no empty space where it used to be

4. **Migration safety**:
   - For a user who previously set `planning.syncMode` to `auto-sync-all`:
     - Open the panel → verify no errors
     - Verify no periodic sync timer starts (check with `console.log` or breakpoint)
     - Verify the orphaned config key in the DB doesn't cause issues

5. **Run existing tests**:
   - `npm test` — verify no regressions
   - Search for any tests referencing the removed handlers:
     ```bash
     grep -rn "planningPanelSyncMode\|setPlanningPanelSyncMode\|syncAllDocuments\|syncSelectedContainers\|docs-cache-mode" src/test/
     ```

6. **Compile check**:
   - `npm run compile` — verify no TypeScript errors from removed methods/handlers
