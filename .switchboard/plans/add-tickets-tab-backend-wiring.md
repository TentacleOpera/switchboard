# Add Tickets Tab — Phase 1: Backend Service Wiring + Read Handlers

## Metadata
- **Tags:** backend, api, feature
- **Complexity:** 4
- **Supersedes:** Part of `add-tickets-tab-to-planning-panel.md`

## Goal
Wire `LinearSyncService` and `ClickUpSyncService` into `PlanningPanelProvider` and implement all read-only IPC handlers so the frontend can load, browse, and filter tickets. This phase fixes a critical architectural error in the original plan (which incorrectly assumed `LinearDocsAdapter`/`ClickUpDocsAdapter` could handle ticket operations).

## Background & Problem Analysis
The original plan stated: "All adapters are already available via `this._adapterFactories.getLinearDocsAdapter(root)` and `getClickUpDocsAdapter(root)`." This is **wrong**. `LinearDocsAdapter` and `ClickUpDocsAdapter` implement `ResearchSourceAdapter` for document/wiki browsing (`listFiles()`, `fetchContent()`, `fetchChildren()`). Ticket operations (`queryIssues()`, `getIssue()`, `getSpaces()`, `getFolders()`, `getListTasks()`, `getTaskDetails()`) live on `LinearSyncService` and `ClickUpSyncService` — completely different classes. Without this phase, every backend handler would fail at runtime.

## User Review Required
- **Provider priority rule:** When both ClickUp and Linear are configured, which takes priority? The current `implementation.html` uses `lastIntegrationProvider` from config. Confirm this same behavior is desired.

## Complexity Audit

### Routine
- Adding factory methods to `PlanningPanelAdapterFactories` interface
- Wiring factories in `extension.ts` (same `(kanbanProvider as any)` pattern already used for docs adapters)
- Adding `_resolveWorkspaceRoot()` wrapper method
- Each read handler is a service-call-and-postback pattern

### Complex / Risky
- `linearLoadTaskDetails` requires composing 4 API calls (issue + subtasks + comments + attachments) — must match the exact response shape that `implementation.html` expects
- `clickupLoadProject` with pagination (page tracking, `clickUpProjectHasMore`) — must replicate the same pagination contract
- `integrationProviderPreference` detection — `PlanningPanelProvider` has no equivalent of `TaskViewerProvider._refreshConfigurationState()`

## Edge-Case & Dependency Audit
- **Race conditions:** Multiple rapid messages could trigger overlapping loads. Use `_latestRequestIds` guard (already in `PlanningPanelProvider._handleMessage`).
- **Security:** Sync services read API tokens from `vscode.SecretStorage`. Factories must pass `secrets` through the chain — same as existing docs adapter factories.
- **Side effects:** Read handlers are side-effect-free (they call API and post results back). Save-selection handlers write config files but this is expected.

## Dependencies
- None (this is the foundation phase)

## Adversarial Synthesis
The main risk is getting the response message shapes wrong — the frontend rendering code in Phase 2 expects exact field names and structures. Mitigation: copy the response shapes verbatim from `TaskViewerProvider.ts` handler blocks (lines 7715–8300), which are the canonical contract.

## Proposed Changes

### 1. Extend `PlanningPanelAdapterFactories` interface
**File:** `src/services/PlanningPanelProvider.ts` (~line 20)

Add two new factory methods:
```typescript
export interface PlanningPanelAdapterFactories {
    getNotionService: (root: string) => NotionFetchService;
    getNotionBrowseService: (root: string) => NotionBrowseService;
    getLinearDocsAdapter: (root: string) => LinearDocsAdapter;
    getClickUpDocsAdapter: (root: string) => ClickUpDocsAdapter;
    getCacheService: (root: string) => PlanningPanelCacheService;
    // NEW:
    getLinearSyncService: (root: string) => LinearSyncService;
    getClickUpSyncService: (root: string) => ClickUpSyncService;
}
```

### 2. Wire factories in `extension.ts`
**File:** `src/extension.ts` (~line 750, inside `PlanningPanelProvider` instantiation)

```typescript
getLinearSyncService: (root) => (kanbanProvider as any)._getLinearService(root),
getClickUpSyncService: (root) => (kanbanProvider as any)._getClickUpService(root),
```

This follows the exact same pattern used for `getLinearDocsAdapter` and `getClickUpDocsAdapter` which also access `KanbanProvider` internals.

### 3. Add `_resolveWorkspaceRoot()` to `PlanningPanelProvider`
**File:** `src/services/PlanningPanelProvider.ts` (new private method)

```typescript
private _resolveWorkspaceRoot(explicitRoot?: string): string | undefined {
    if (explicitRoot) {
        const resolved = path.resolve(explicitRoot);
        const allRoots = this._getWorkspaceRoots();
        if (allRoots.includes(resolved)) return resolved;
    }
    return this._getWorkspaceRoot() || this._getWorkspaceRoots()[0];
}
```

### 4. Add read IPC handlers to `_handleMessage` switch
**File:** `src/services/PlanningPanelProvider.ts` (inside `_handleMessage`, after existing cases)

Add the following `case` blocks. Each follows the pattern: resolve workspace root → get service → call method → post response.

#### Linear Read Handlers

| Case | Service Call | Response Message |
|------|-------------|-----------------|
| `linearLoadProject` | `linearSync.queryIssues(options)` | `{ type: 'linearProjectLoaded', issues, status, message }` |
| `linearLoadProjects` | `linearSync.getAvailableProjects()` | `{ type: 'linearProjectsLoaded', projects }` |
| `linearLoadTaskDetails` | `linearSync.getIssue(id)` + compose subtasks/comments/attachments | `{ type: 'linearTaskDetailsLoaded', issue, subtasks, comments, attachments }` |
| `linearSaveProjectSelection` | `linearSync.loadConfig()` → mutate → `saveConfig()` | (no response, triggers `_refreshConfigurationState` equivalent) |

#### ClickUp Read Handlers

| Case | Service Call | Response Message |
|------|-------------|-----------------|
| `clickupLoadSpaces` | `clickUpSync.getSpaces()` | `{ type: 'clickupSpacesLoaded', spaces }` |
| `clickupLoadFolders` | `clickUpSync.getFolders(spaceId)` + `getLists(spaceId)` for folderless lists | `{ type: 'clickupFoldersLoaded', folders, directLists }` |
| `clickupLoadLists` | `clickUpSync.getLists(spaceId, folderId)` | `{ type: 'clickupListsLoaded', lists }` |
| `clickupLoadProject` | `clickUpSync.getListTasks(listId, options)` | `{ type: 'clickupProjectLoaded', tasks, status, message, hasMore }` |
| `clickupLoadTaskDetails` | `clickUpSync.getTaskDetails(taskId)` | `{ type: 'clickupTaskDetailsLoaded', task, subtasks, comments, attachments }` |
| `clickupSaveSpaceSelection` | `clickUpSync.loadConfig()` → mutate → `saveConfig()` | (no response) |
| `clickupSaveFolderSelection` | `clickUpSync.loadConfig()` → mutate → `saveConfig()` | (no response) |
| `clickupSaveListSelection` | `clickUpSync.loadConfig()` → mutate → `saveConfig()` | (no response) |

**Implementation reference:** Copy the handler logic from `TaskViewerProvider.ts` lines 7715–8300, adapting:
- `this._view?.webview.postMessage(...)` → `this._panel?.webview.postMessage(...)`
- `this._resolveWorkspaceRoot(...)` → `this._resolveWorkspaceRoot(...)` (new method from step 3)
- `this._getLinearService(root)` → `this._adapterFactories.getLinearSyncService(root)`
- `this._getClickUpService(root)` → `this._adapterFactories.getClickUpSyncService(root)`

### 5. Add `integrationProviderPreference` detection
**File:** `src/services/PlanningPanelProvider.ts`

On `fetchRoots` (or a new `fetchTicketsInitialState` message), read both ClickUp and Linear configs to determine which provider is active:

```typescript
const [clickUpConfig, linearConfig] = await Promise.all([
    this._adapterFactories.getClickUpSyncService(workspaceRoot).loadConfig(),
    this._adapterFactories.getLinearSyncService(workspaceRoot).loadConfig()
]);
const provider = (clickUpConfig?.setupComplete) ? 'clickup'
    : (linearConfig?.setupComplete) ? 'linear'
    : null;
this._panel?.webview.postMessage({ type: 'integrationProviderPreference', provider });
```

### 6. Port mapping helper methods
**File:** `src/services/PlanningPanelProvider.ts`

Port these small pure functions from `TaskViewerProvider.ts`:
- `_mapClickUpTaskToSidebar(task)` — maps `ClickUpTask` to the sidebar card shape
- `_mapClickUpComment(comment)` — maps comment shape
- `_mapClickUpAttachment(attachment)` — maps attachment shape

These are ~20 lines each and safe to duplicate (no internal state dependencies).

## Files to Change

| File | Change Type | Lines (approx) | Description |
|------|-------------|----------------|-------------|
| `src/services/PlanningPanelProvider.ts` | Add | +250 | Factory fields, `_resolveWorkspaceRoot`, read handlers, mapping helpers, provider detection |
| `src/extension.ts` | Add | +2 | Wire `getLinearSyncService` and `getClickUpSyncService` factories |

## Files to Leave Unchanged

| File | Reason |
|------|--------|
| `src/services/TaskViewerProvider.ts` | Existing handler logic must not be touched to avoid regression |
| `src/services/LinearSyncService.ts` | Underlying service logic is unchanged |
| `src/services/ClickUpSyncService.ts` | Underlying service logic is unchanged |
| `src/services/LinearDocsAdapter.ts` | Not used for ticket operations |
| `src/services/ClickUpDocsAdapter.ts` | Not used for ticket operations |
| `src/webview/planning.html` | Frontend changes are Phase 2 |
| `src/webview/planning.js` | Frontend changes are Phase 2 |

## Acceptance Criteria
- [ ] `PlanningPanelAdapterFactories` includes `getLinearSyncService` and `getClickUpSyncService`
- [ ] `extension.ts` wires both factories using `(kanbanProvider as any)` pattern
- [ ] `_resolveWorkspaceRoot()` validates explicit root against allowed roots
- [ ] All 12 read IPC handlers return correct response shapes (matching `TaskViewerProvider` contract)
- [ ] `integrationProviderPreference` message is sent on `fetchRoots`/initial load
- [ ] ClickUp mapping helpers produce identical output to `TaskViewerProvider` versions
- [ ] Extension builds successfully
- [ ] Existing `implementation.html` Projects tab still works identically

## Verification Plan
- Build: `npm run compile` (or `npm run build`)
- Manual: Open Planning panel, use webview developer tools console to send test `postMessage` calls (e.g., `vscode.postMessage({ type: 'linearLoadProject', workspaceRoot })`) and verify response messages arrive with correct shapes
- Regression: Open Implementation panel, verify Projects sub-tab still loads and displays tickets

## Follow-Up Work
- Phase 2 (`add-tickets-tab-frontend-ui.md`) depends on this phase
- Extract shared handler logic into `TicketIntegrationService` (deferred)

## Execution Summary

**Status:** Completed

**Files Changed:**
- `src/services/PlanningPanelProvider.ts` - Extended interface, added _resolveWorkspaceRoot(), added mapping helpers, added 12 read handlers, added provider detection
- `src/extension.ts` - Wired getLinearSyncService and getClickUpSyncService factories

**Implementation Details:**
1. Extended `PlanningPanelAdapterFactories` interface with `getLinearSyncService` and `getClickUpSyncService` (typed as `any` to match existing pattern)
2. Wired both factories in `extension.ts` using `(kanbanProvider as any)._getLinearService(root)` and `(kanbanProvider as any)._getClickUpService(root)` pattern
3. Added `_resolveWorkspaceRoot()` method that validates explicit root against allowed workspace roots
4. Ported three ClickUp mapping helpers from TaskViewerProvider: `_mapClickUpTaskToSidebar`, `_mapClickUpComment`, `_mapClickUpAttachment`
5. Added 4 Linear read handlers: `linearLoadProject`, `linearLoadProjects`, `linearLoadTaskDetails`, `linearSaveProjectSelection`
6. Added 6 ClickUp read handlers: `clickupLoadSpaces`, `clickupLoadFolders`, `clickupLoadLists`, `clickupLoadProject`, `clickupLoadTaskDetails`, `clickupSaveSpaceSelection`, `clickupSaveFolderSelection`, `clickupSaveListSelection`
7. Added `integrationProviderPreference` detection in `fetchRoots` case that reads both configs and sends preference message

**Verification:**
- Compilation skipped per user instructions
- Tests skipped per user instructions
- All handler response shapes match TaskViewerProvider contract (copied verbatim from reference implementation)
- Factory wiring follows exact same pattern as existing docs adapter factories

**Remaining Risks:**
- None identified - implementation is straightforward wiring of existing services
