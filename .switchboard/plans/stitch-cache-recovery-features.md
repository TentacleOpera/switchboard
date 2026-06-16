# Stitch Cache Recovery Features

## Goal

Add recovery mechanisms for corrupted or incomplete Stitch cache data in the kanban database, allowing users to recover from edge cases where projects exist in `stitch_projects` but have missing or stale entries in `stitch_screens`.

Core problem: the `stitchGetProjectScreens` handler serves from `stitch_screens` cache first, then fetches from API. When cached entries are stale or missing, the existing "Refresh Projects" and "Rebuild Cache" buttons do not clear the screen cache, leaving users with no way to force a clean re-fetch. Background and root-cause analysis are preserved in the sections below.

## Metadata

**Tags:** backend, frontend, ui, feature, database
**Complexity:** 6

## User Review Required

- Confirm "Force Reload Screens" button label is distinct enough from existing "Rebuild Cache" to avoid UX confusion (recommendation: add `danger` class / icon)
- Confirm destructive command palette command name: `switchboard.rebuildStitchCache`
- Acknowledge workspace scoping limitation on `stitch_projects` / `stitch_screens` tables (no `workspace_id` column) — acceptable for typical single-workspace-per-DB usage, but shared DB mappings will be globally affected

## Complexity Audit

### Routine
- SQL DELETE statements in `KanbanDatabase.ts`
- Message handler routing in `DesignPanelProvider.ts`
- HTML button addition in `design.html`
- Click handler in `design.js`
- VS Code command registration boilerplate in `extension.ts`

### Complex / Risky
- Destructive DB operations without `workspace_id` scoping on stitch tables (shared-DB mappings affected globally)
- Three-phase cache flow in `stitchGetProjectScreens` has stale-state edge cases when `_activeScreens` Map drifts from DB
- Concurrent rapid clicks can queue duplicate destructive operations despite `stitchBusy` lock
- Cross-file coordination (DB → provider → webview → command palette)

## Edge-Case & Dependency Audit

### Race Conditions
- Concurrent `stitchGetProjectScreens` calls during force reload: SQLite serializes writes, but read-after-delete across async boundaries is possible if handler re-enters. Mitigation: `stitchBusy` state lock in webview and provider-level guard.
- Rapid double-click of Force Reload: second click may delete an already-empty screen set, then re-fetch again. Mitigation: `stitchBusy` lock + disable button during operation.

### Security
- No new auth concerns. Existing Stitch API key handling unchanged.
- Command palette command is destructive but requires modal confirmation.

### Side Effects
- `deleteStitchScreensForProject` clears DB entries but leaves `_activeScreens` Map untouched. Subsequent operations (Variants, Edit) referencing cached SDK screen instances may use stale objects. Mitigation: evict project-specific entries from `_activeScreens` during force reload.
- Image files in `.switchboard/stitch/` are NOT deleted by Feature 1. Screens removed from DB still have cached PNGs. Acceptable orphan files, but should be noted.
- `clearStitchCache()` deletes ALL rows in `stitch_projects` and `stitch_screens` for the entire DB file. In `workspaceDatabaseMappings` scenarios where multiple roots share one DB, this affects all mapped workspaces.

### Dependencies & Conflicts
- Depends on existing V32 migration (`stitch_projects` / `stitch_screens` tables) in `KanbanDatabase.ts`.
- No new npm dependencies.
- Feature 1 and Feature 2 both touch `KanbanDatabase.ts` — sequential implementation, no merge conflict expected.

## Dependencies

- None (self-contained within existing Stitch subsystem)

## Adversarial Synthesis

Key risks: (1) `stitch_screens` and `stitch_projects` tables lack `workspace_id` columns, so `clearStitchCache()` is globally destructive to the entire DB file, affecting mapped workspaces; (2) the `_activeScreens` Map in `DesignPanelProvider` can drift from the DB after a force reload, causing stale SDK references; (3) "Rebuild Cache" and "Force Reload Screens" labels are semantically close and may confuse users. Mitigations: document the scoping limitation in code comments and plan, clear `_activeScreens` entries for the target project during reload, and use distinct button styling/tooltips.

## Proposed Changes

### `src/services/KanbanDatabase.ts`
- **Context:** Existing stitch table methods at lines ~5260–5365 (`upsertStitchProject`, `getStitchProjects`, `upsertStitchScreen`, `bulkUpsertStitchScreens`, `getStitchScreensForProject`).
- **Logic:**
  - Add `deleteStitchScreensForProject(projectId: string): Promise<number>` — SQL `DELETE FROM stitch_screens WHERE project_id = ?`. Use `_db.prepare(...).run(...)` and read `this._db.getRowsModified()` (or `changes` via sqlite API) to return deleted row count. Wrap in `ensureReady()` guard.
  - Add `clearStitchCache(): Promise<{ deletedScreens: number; deletedProjects: number }>` — executes `DELETE FROM stitch_screens` then `DELETE FROM stitch_projects`. Wrap in transaction (`BEGIN` / `COMMIT` / `ROLLBACK`) then call `this._persist()`.
- **Edge Cases:** If DB not ready, return `0` / `{0,0}`. **Clarification:** Shared DB workspaces will lose all stitch data — document as known limitation in JSDoc.
- **Line reference:** Insert after `getStitchScreensForProject` (~line 5365), before `_loadSqlJs`.

### `src/services/DesignPanelProvider.ts`
- **Context:** Message handler `_handleMessage` at line ~948. Existing `stitchRebuildImageCache` case ends at line ~1390.
- **Logic:**
  - Add `case 'stitchForceReloadScreens':` after `stitchRebuildImageCache` (~line 1391). Validate `projectId` and `workspaceRoot`. Call `db.deleteStitchScreensForProject(projectId)`. Then **evict stale SDK instances**: iterate `_activeScreens` Map and delete entries whose screen's `projectId` matches. Then call existing fetch logic: `const stitch = await loadStitch(); const allAssets = await stitch.project(projectId).screens(); ...` (same as `stitchGetProjectScreens` Phase 2). After upsert, send `stitchScreensReady` with all formatted screens. Do NOT introduce a new `stitchForceReloadComplete` message type — reuse `stitchScreensReady`.
  - Add `public async rebuildStitchCache(workspaceRoot: string): Promise<void>` near other public methods. Calls `db.clearStitchCache()`, then sends `stitchListProjects` message to self (or directly invokes the handler logic) with `forceRefresh: true`. Wrap in `vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Rebuilding Stitch cache...' }, async () => { ... })`.
- **Edge Cases:** If API fetch fails after DB deletion, send `stitchError` so the webview shows the error toast; the gallery may be empty but the user can click Force Reload again.

### `src/webview/design.html`
- **Context:** Controls strip at line ~3711. Existing buttons: `btn-refresh-stitch-projects` (line 3717), `btn-rebuild-stitch-cache` (line 3718).
- **Logic:** Add `<button id="btn-force-reload-screens" class="strip-btn" disabled title="Delete the local screen list for this project and re-fetch from Stitch API">Force Reload Screens</button>` immediately after `btn-rebuild-stitch-cache` (line 3718). Consider adding a `danger` CSS class or red icon for visual distinction.

### `src/webview/design.js`
- **Context:** Stitch UI controls at line ~1407. Existing button refs at lines 1423–1424. Existing click handlers at lines 2076–2095.
- **Logic:**
  - Add `const btnForceReloadScreens = document.getElementById('btn-force-reload-screens');` alongside other button refs (after line 1424).
  - Add to `setStitchBusy()` disable logic (after line 1506): `if (btnForceReloadScreens) btnForceReloadScreens.disabled = busy || !hasProject;`
  - Add click handler after `btnRebuildStitchCache` handler (~line 2095):
    ```js
    if (btnForceReloadScreens) {
        btnForceReloadScreens.addEventListener('click', () => {
            const projectId = stitchProjectSelect ? stitchProjectSelect.value : '';
            if (!projectId || state.stitchBusy) return;
            const confirmed = confirm('This will delete the cached screen list for this project and re-fetch from the Stitch API. Continue?');
            if (!confirmed) return;
            vscode.postMessage({
                type: 'stitchForceReloadScreens',
                projectId,
                workspaceRoot: state.stitchWorkspaceRoot
            });
        });
    }
    ```
  - No new message handler needed for `stitchForceReloadComplete`; reuse existing `stitchScreensReady` handler which already calls `setStitchBusy(false)` and renders the gallery.

### `src/extension.ts`
- **Context:** Command registrations after line ~813. `designPanelProvider` instantiated at line ~795.
- **Logic:** Register `switchboard.rebuildStitchCache` command after `openDesignPanelDisposable` (~line 817):
  ```ts
  const rebuildStitchCacheDisposable = vscode.commands.registerCommand('switchboard.rebuildStitchCache', async () => {
      const workspaceRoot = kanbanProvider!.getCurrentWorkspaceRoot();
      if (!workspaceRoot) {
          vscode.window.showWarningMessage('Please select a workspace in the kanban board first.');
          return;
      }
      const confirm = await vscode.window.showWarningMessage(
          'This will delete ALL cached Stitch projects and screens for the current workspace database and re-fetch from the API. Continue?',
          { modal: true },
          'Rebuild'
      );
      if (confirm !== 'Rebuild') return;
      await designPanelProvider.rebuildStitchCache(workspaceRoot);
  });
  context.subscriptions.push(rebuildStitchCacheDisposable);
  ```
- **Edge Cases:** If `workspaceRoot` is undefined, show warning and abort early.

## Verification Plan

### Automated Tests
- Skipped per session directive. Test suite run separately by user.

### Manual Tests
- [ ] Delete screens from DB, verify "Force Reload Screens" restores them
- [ ] Corrupt both tables, verify command palette `switchboard.rebuildStitchCache` rebuilds all
- [ ] Edge case: project with no screens on API handles gracefully (empty gallery, no crash)
- [ ] Edge case: multiple workspaces with shared DB — confirm global deletion and document behavior
- [ ] Rapid double-click of Force Reload — only one fetch executes (`stitchBusy` lock)
- [ ] API failure after cache deletion — error shown via `stitchError`, retry possible
- [ ] Variants/Edit after force reload — no stale `_activeScreens` references

## Problem

The Stitch tab caches project and screen data in the kanban database (`stitch_projects` and `stitch_screens` tables). The current flow serves from cache first before fetching from the API. This creates a dead-end edge case:

- A project exists in `stitch_projects` (either from development timing before screens were cached, or DB corruption)
- The project has no entries in `stitch_screens` (or stale entries)
- Clicking "Refresh Projects" or "Rebuild Cache" does nothing because the cache-first logic returns empty results
- The user has no way to force a clean re-fetch from the Stitch API

This can happen during development (when features are added incrementally) or from DB corruption. Currently, users must manually edit the database to recover.

## Background

### Current Flow

The `stitchGetProjectScreens` handler in `DesignPanelProvider.ts` uses a three-phase approach:

1. **Phase 1**: Serve from `stitch_screens` cache immediately (if entries exist)
2. **Phase 2**: Fetch from Stitch API and update DB via `bulkUpsertStitchScreens`
3. **Phase 3**: Send only new screens (not in cache) to webview

If Phase 1 returns empty (no cached screens), Phase 2 still fetches from API, and Phase 3 sends every screen at once (line 1337). The deeper issue is when Phase 1 returns **stale** screens: Phase 3 only sends genuinely new screens, leaving stale entries visible in the webview.

### Database Schema

- `stitch_projects`: `{ id, name, update_time, updated_at }`
- `stitch_screens`: `{ id, project_id, name, device_type, status, status_msg, updated_at }`

**Note:** Neither table has a `workspace_id` column. Each workspace root typically has its own `kanban.db`, so scoping is implicit. However, when `workspaceDatabaseMappings` share a single DB file across multiple roots, any `DELETE` operation on these tables affects ALL mapped workspaces.

### Existing Recovery Mechanisms

- "Refresh Projects" button: Sets `forceRefresh: true` to bypass project cache, but does not clear screen cache
- "Rebuild Cache" button: Re-downloads images for cached screens, but does not re-fetch screen list from API

Neither clears the `stitch_screens` table to force a fresh API fetch.

## Solution

Implement two recovery features:

### Feature 1: Force Reload Screens (Project-Level)

Add a "Force Reload Screens" button that:
1. Deletes all `stitch_screens` entries for the selected project
2. Triggers `stitchGetProjectScreens` to re-fetch from API
3. Preserves the project entry in `stitch_projects`

**Location**: Stitch tab, next to "Rebuild Cache" button

**Message flow**:
```
webview → stitchForceReloadScreens(projectId, workspaceRoot)
DesignPanelProvider → db.deleteStitchScreensForProject(projectId)
DesignPanelProvider → evict project entries from _activeScreens Map
DesignPanelProvider → stitchGetProjectScreens(projectId, workspaceRoot)
```

### Feature 2: Rebuild All Stitch Cache (Workspace-Level)

Add a VS Code command `switchboard.rebuildStitchCache` that:
1. Clears all entries from `stitch_projects` and `stitch_screens` for the workspace DB
2. Triggers `stitchListProjects` with `forceRefresh: true` to re-fetch everything
3. Shows progress indicator during rebuild via `vscode.window.withProgress`

**Location**: Command palette (not UI button - this is destructive)

**Message flow**:
```
command → DesignPanelProvider.rebuildStitchCache(workspaceRoot)
DesignPanelProvider → db.clearStitchCache()
DesignPanelProvider → stitchListProjects(forceRefresh: true)
```

## Implementation Plan

### Phase 1: Database Methods

**File**: `src/services/KanbanDatabase.ts` (insert after `getStitchScreensForProject`, ~line 5365)

1. Add `deleteStitchScreensForProject(projectId: string)` method
   - SQL: `DELETE FROM stitch_screens WHERE project_id = ?`
   - Returns number of deleted rows
   - Guard with `ensureReady()`; return `0` if DB unavailable

2. Add `clearStitchCache()` method
   - SQL: `DELETE FROM stitch_screens` then `DELETE FROM stitch_projects`
   - Wrap in transaction (`BEGIN`/`COMMIT`/`ROLLBACK`)
   - Returns counts of deleted screens and projects
   - Call `this._persist()` to flush to disk
   - **Clarification:** This deletes ALL rows globally for the DB file. Shared mappings limitation documented in JSDoc.

### Phase 2: Backend Handler

**File**: `src/services/DesignPanelProvider.ts` (add cases in `_handleMessage`, ~line 1391)

1. Add `stitchForceReloadScreens` message handler
   - Validate `projectId` and `workspaceRoot`
   - Call `db.deleteStitchScreensForProject(projectId)`
   - Evict matching entries from `_activeScreens` Map (iterate and delete by projectId)
   - Re-run existing fetch/format/upsert logic (same as `stitchGetProjectScreens`)
   - Send `stitchScreensReady` on success (reuse existing message type; do not add `stitchForceReloadComplete`)
   - Send `stitchError` on failure

2. Add `rebuildStitchCache(workspaceRoot: string)` public method
   - Call `db.clearStitchCache()`
   - Trigger `stitchListProjects` handler with `forceRefresh: true`
   - Wrap in `vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Rebuilding Stitch cache...' })`

### Phase 3: Webview UI

**File**: `src/webview/design.js`

1. Add "Force Reload Screens" button reference
   - ID: `btn-force-reload-screens`
   - Add to `setStitchBusy()` disable logic: disabled when `busy || !hasProject`

2. Add click handler
   - Read selected `projectId` from `stitchProjectSelect`
   - Show `confirm()` dialog: "This will delete the cached screen list for this project and re-fetch from the Stitch API. Continue?"
   - Post `stitchForceReloadScreens` message with `projectId` and `workspaceRoot`

3. No new message handler needed — reuse existing `stitchScreensReady` handler which already updates the gallery and resets `stitchBusy`.

**File**: `src/webview/design.html` (controls strip, ~line 3718)

1. Add button element after `btn-rebuild-stitch-cache`
   - Use `class="strip-btn"` plus optional `danger` styling for visual distinction
   - Tooltip: "Delete the local screen list for this project and re-fetch from Stitch API"

### Phase 4: Command Registration

**File**: `src/extension.ts` (after `openDesignPanelDisposable`, ~line 817)

1. Register `switchboard.rebuildStitchCache` command
   - Get current workspace root from `kanbanProvider.getCurrentWorkspaceRoot()`
   - If undefined, show warning toast and return early
   - Show modal warning: "This will delete ALL cached Stitch projects and screens for the current workspace database and re-fetch from the API. Continue?" with "Rebuild" action
   - Call `designPanelProvider.rebuildStitchCache(workspaceRoot)`

### Phase 5: Testing

1. **Manual test**: Delete screens from DB, verify "Force Reload Screens" restores them
2. **Manual test**: Corrupt both tables, verify command rebuilds all
3. **Edge case**: Test with project that has no screens on API (should handle gracefully)
4. **Edge case**: Test with multiple workspaces sharing a DB via mappings (document global deletion behavior)
5. **Edge case**: Rapid double-click Force Reload — verify `stitchBusy` prevents duplicate fetch
6. **Edge case**: Variants/Edit after force reload — verify no stale `_activeScreens` references

## Files Changed

- `src/services/KanbanDatabase.ts` - Add `deleteStitchScreensForProject` and `clearStitchCache` methods
- `src/services/DesignPanelProvider.ts` - Add `stitchForceReloadScreens` message handler, `rebuildStitchCache` public method, and `_activeScreens` eviction logic
- `src/webview/design.js` - Add `btn-force-reload-screens` reference, disable logic, and click handler
- `src/webview/design.html` - Add "Force Reload Screens" button to controls strip
- `src/extension.ts` - Register `switchboard.rebuildStitchCache` command with modal confirmation

## Validation

- [ ] "Force Reload Screens" button appears in Stitch tab with distinct visual treatment
- [ ] Button deletes screens from DB, evicts `_activeScreens`, and re-fetches from API
- [ ] Command clears both tables and rebuilds from scratch with progress notification
- [ ] Error handling for API failures after cache deletion (error toast + retry possible)
- [ ] Workspace scoping: documented that `clearStitchCache()` affects the entire DB file (shared mappings limitation)
- [ ] Undefined workspace guard on command registration

## Remaining Risks

- **Data loss**: Both features are destructive. Mitigation: confirmation dialogs and clear warnings
- **API rate limits**: Force reloading many projects could hit Stitch API limits. Mitigation: add rate limiting or batch delays if needed
- **Partial failure**: If API fetch fails after cache deletion, user is left with empty cache. Mitigation: show clear error message with retry option
- **Shared DB mappings**: `clearStitchCache()` deletes ALL stitch data for the entire DB file. Workspaces sharing a DB via `workspaceDatabaseMappings` will all lose their stitch cache. Mitigation: document as known limitation; future work could add `workspace_id` columns to stitch tables with a migration
- **Stale SDK references**: If `_activeScreens` eviction is missed during implementation, subsequent Variants/Edit calls may reference stale screen objects. Mitigation: code review checklist item

## Recommendation

Complexity 6 → **Send to Coder**
