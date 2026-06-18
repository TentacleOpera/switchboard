# Fix ClickUp Refresh & Sync Status Bugs

## Goal
Fix two related bugs in the ClickUp tickets tab:
1. **Sync status always shows "modified"** even when the local file has not been edited since the last fetch.
2. **Two refresh clicks are required** to see the latest ClickUp updates.

Core problem: `TaskViewerProvider` and `KanbanProvider` both create `PlanningPanelCacheService` without injecting a `KanbanDatabase`. This causes `registerImportedTicket()` and `updateLastSynced()` to silently no-op, leaving `lastSyncedAt` unpopulated or stale. The sync-status logic compares fresh file `mtime` against a missing or stale `lastSyncedAt`, causing every ticket to appear "modified". Additionally, the display path (`PlanningPanelProvider.clickupLoadProject`) and the import path (`TaskViewerProvider.importAllTasks`) use different `ClickUpSyncService` instances with divergent cache injection: the display path (via `KanbanProvider._getClickUpService`) has no cache, while the import path (via `TaskViewerProvider._getClickUpService`) has a 5-minute cache. On refresh, the display fetches live API data but the auto-import reads stale cached data, requiring a second refresh.

### Root Cause Analysis

#### Bug 1: Sync Status "modified" Everywhere
`TaskViewerProvider` creates its own `PlanningPanelCacheService` without a `KanbanDatabase`:
```typescript
// src/services/TaskViewerProvider.ts:5153
service = new PlanningPanelCacheService(resolved);
```
`KanbanProvider` has the identical bug:
```typescript
// src/services/KanbanProvider.ts:170
const service = new PlanningPanelCacheService(resolved);
```

`registerImportedTicket()` has an early return when `_kanbanDb` is null:
```typescript
// src/services/PlanningPanelCacheService.ts:467
if (!this._kanbanDb) return;
```

`updateLastSynced()` shares the same guard:
```typescript
// src/services/PlanningPanelCacheService.ts:442
if (!this._kanbanDb) return;
```

So after `importAllTickets` bulk-imports tasks and writes them to disk, **`lastSyncedAt` is never updated in the DB**. The sync status logic compares the fresh file `mtime` against the stale (or missing) `lastSyncedAt`, causing every ticket to appear "modified".

#### Bug 2: Double-Click Refresh
The refresh button in `planning.js` only clears the **webview-side** detail cache (`clickUpTaskDetailCache`), but never invalidates the **extension-side** `PlanningPanelCacheService` task cache.

Additionally, the display path (`PlanningPanelProvider.clickupLoadProject`) uses `KanbanProvider._getClickUpService()` which is created **without** a cache service injected, so it always hits the live API. But the `importAllTickets` path uses `TaskViewerProvider._getClickUpService()` which **does** have a 5-minute cache injected. On refresh:
- Display fetches from API (may be eventually-consistent/stale on first call)
- Auto-import fires and reads from the 5-min cache (stale) → writes stale data to local files

## Metadata
**Tags:** bugfix, backend
**Complexity:** 6

## User Review Required
No — the fixes are internal wiring and cache-invalidation logic with no user-facing behavioral changes beyond the bugs being resolved.

## Complexity Audit

### Routine
- Adding `KanbanDatabase` parameter to two existing `PlanningPanelCacheService` constructors.
- Adding a single message handler case to `PlanningPanelProvider.ts`.
- Adding a single `postMessage` call and cache-invalidation call to existing handlers.

### Complex / Risky
- Multiple service instances (`KanbanProvider` vs `TaskViewerProvider` vs extension factory) create separate `PlanningPanelCacheService` instances; ensuring all three receive `KanbanDatabase` is easy to miss.
- Cache invalidation timing: the `invalidateClickUpCache` message and subsequent `loadClickUpProject` call must be serialized by the webview, but the extension-side handler must complete before `getListTasks` runs.
- `KanbanProvider._getCacheService` currently has no DB injection; leaving it unfixed means `ClickUpDocsAdapter` paths will still silently fail cache-backed operations.
- Divergent `ClickUpSyncService` instances between `KanbanProvider` and `TaskViewerProvider` mean cache invalidation must target the correct instance.

## Edge-Case & Dependency Audit

### Race Conditions
- Rapid successive refresh clicks could interleave messages. The `_pendingRefreshImport` flag already gates auto-import.
- Three distinct `PlanningPanelCacheService` instances exist per workspace root. Invalidating one does not invalidate the others. The proposed fixes reduce this to one canonical instance per root (via the extension factory) for the affected paths.

### Security
- No new secrets, tokens, or network endpoints introduced.
- Cache invalidation is local-only.

### Side Effects
- Passing `KanbanDatabase` enables DB writes that were previously silently skipped. Existing DB schemas already support these columns.
- `KanbanProvider._getCacheService` gaining a DB reference may cause `ClickUpDocsAdapter` to start caching docs that were previously uncached. This is generally desirable.

### Dependencies & Conflicts
- `KanbanDatabase.forWorkspace()` is already imported and used in `extension.ts` and `TaskViewerProvider.ts`.
- `KanbanProvider.ts` already imports `KanbanDatabase`.
- No external dependency version changes.
- No conflicts with concurrent sync-logic work.

## Dependencies
- `KanbanDatabase.forWorkspace()` must return a ready instance for the target root.
- The `extension.ts` `getCacheService` factory already demonstrates the correct pattern.

## Adversarial Synthesis
Key risks: divergent cache-service instances across `KanbanProvider`, `TaskViewerProvider`, and the extension factory can lead to partially-fixed state where one path writes DB records and another reads from a stale no-DB instance. Mitigations: fix all three constructors, verify `invalidateTaskCache` reaches the instance used by `TaskViewerProvider`'s ClickUp service, and confirm `_adapterFactories.getCacheService` returns the extension-factory singleton.

## Proposed Changes

### `src/services/TaskViewerProvider.ts`
**Context:** `TaskViewerProvider._getCacheService()` at ~5153 creates `PlanningPanelCacheService` without a `KanbanDatabase`, causing `registerImportedTicket()` and `updateLastSynced()` to silently no-op.

**Logic:** Mirror the extension factory pattern: pass `KanbanDatabase.forWorkspace(resolved)` to the constructor.

**Implementation:**
```typescript
// BEFORE
service = new PlanningPanelCacheService(resolved);

// AFTER
service = new PlanningPanelCacheService(resolved, KanbanDatabase.forWorkspace(resolved));
```

**Edge Cases:** `KanbanDatabase.forWorkspace()` returns immediately (synchronous factory), but DB readiness is checked lazily inside cache-service methods. If the DB is not yet initialized, `registerImportedTicket` will still gracefully no-op via the `ensureReady()` check inside `KanbanDatabase`.

### `src/services/KanbanProvider.ts`
**Context:** `KanbanProvider._getCacheService()` at ~170 has the identical bug — no `KanbanDatabase` passed. This affects `ClickUpDocsAdapter` and any cache-backed operations originating from the kanban provider.

**Logic:** Apply the same fix as TaskViewerProvider.

**Implementation:**
```typescript
// BEFORE
const { PlanningPanelCacheService } = require('./PlanningPanelCacheService');
const service = new PlanningPanelCacheService(resolved);

// AFTER
const { PlanningPanelCacheService } = require('./PlanningPanelCacheService');
const kanbanDb = KanbanDatabase.forWorkspace(resolved);
const service = new PlanningPanelCacheService(resolved, kanbanDb);
```

**Edge Cases:** Ensure `KanbanDatabase` is already imported at the top of `KanbanProvider.ts`; it is used elsewhere in the file.

### `src/webview/planning.js`
**Context:** The refresh button at ~5763 only clears webview-side detail caches (`clickUpTaskDetailCache`, `linearIssueDetailCache`) but never invalidates the extension-side `PlanningPanelCacheService` task cache or the `ClickUpSyncService` list index.

**Logic:** Before calling `loadClickUpProject(true)`, post a message to the extension to invalidate caches.

**Implementation:**
In the refresh button click handler, add the `postMessage` before the `loadClickUpProject(true)` call:
```javascript
refreshButton?.addEventListener('click', () => {
    linearIssueDetailCache.clear();
    clickUpTaskDetailCache.clear();
    _pendingRefreshImport = true;
    if (lastIntegrationProvider === 'linear') {
        loadLinearProject(true);
    } else if (lastIntegrationProvider === 'clickup') {
        if (clickUpSelectedListId) {
            vscode.postMessage({ type: 'invalidateClickUpCache', workspaceRoot: ticketsWorkspaceRoot });
            loadClickUpProject(true);
        } else {
            loadClickUpSpaces();
        }
    }
});
```

**Edge Cases:** The message is fire-and-forget; the webview does not wait for acknowledgment. This is acceptable because `loadClickUpProject` will itself trigger cache-invalidating logic directly in the handler (next change), providing defense-in-depth.

### `src/services/PlanningPanelProvider.ts`
**Context:** Two locations need updates.

**Location A — Message handler (~2470):** No handler exists for `invalidateClickUpCache`.

**Logic:** Add a handler that retrieves the workspace root's cache service and ClickUp service, invalidates the task cache, and clears the task-list index.

**Implementation:**
Add a new case in the main message switch:
```typescript
case 'invalidateClickUpCache': {
    const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
    if (!workspaceRoot) break;
    const cacheService = this._adapterFactories.getCacheService(workspaceRoot);
    cacheService.invalidateTaskCache('clickup');
    const clickUp = this._adapterFactories.getClickUpSyncService(workspaceRoot);
    clickUp.clearTaskListIndex();
    break;
}
```

**Location B — `clickupLoadProject` handler (~2815):** Before calling `clickUp.getListTasks(listId)`, the cache for the requested list should be invalidated so the display and any subsequent `importAllTickets` both use fresh data.

**Logic:** Call `invalidateTaskCache('clickup', listId)` before `getListTasks`. This invalidates the canonical cache service (from the extension factory) which `TaskViewerProvider` also uses via `_adapterFactories`.

**Implementation:**
Before `const tasks = await clickUp.getListTasks(listId, ...)`:
```typescript
const cacheService = this._adapterFactories.getCacheService(workspaceRoot);
cacheService.invalidateTaskCache('clickup', listId);
```

**Edge Cases:**
- `invalidateTaskCache('clickup', listId)` matches keys prefixed with `clickup:{listId}`. `ClickUpSyncService.getListTasks` uses `normalizedListId` as the cache key for simple queries, so this invalidation is precise.
- Even though the current `KanbanProvider._getClickUpService` lacks cache injection, this invalidation protects against future wiring changes and ensures the shared `PlanningPanelCacheService` (used by `TaskViewerProvider`) is cleared.

## Verification Plan

### Automated Tests
- **Unit test:** Verify `TaskViewerProvider._getCacheService` returns a `PlanningPanelCacheService` whose `_kanbanDb` is defined.
- **Unit test:** Verify `KanbanProvider._getCacheService` returns a `PlanningPanelCacheService` whose `_kanbanDb` is defined.
- **Unit test:** Verify `PlanningPanelCacheService.registerImportedTicket` writes to the DB when constructed with a `KanbanDatabase`.
- **Unit test:** Verify `PlanningPanelCacheService.updateLastSynced` updates `lastSyncedAt` in the DB when constructed with a `KanbanDatabase`.
- **Integration test:** Simulate `invalidateClickUpCache` message and assert `PlanningPanelCacheService.invalidateTaskCache('clickup')` and `ClickUpSyncService.clearTaskListIndex()` are called.
- **Integration test:** Simulate `clickupLoadProject` message and assert `invalidateTaskCache('clickup', listId)` is called before `getListTasks`.

### Manual Validation Steps
1. Open the ClickUp tab, select a list, and import all tickets.
2. Verify all tickets show **"synced"** (not "modified") immediately after import.
3. Edit a ticket directly on ClickUp web.
4. Click refresh **once** in the Switchboard ClickUp tab.
5. Verify the updated ticket appears with the new data.
6. Verify no tickets show "modified" unless you have actually edited the local `.md` file.

## Files to Change
- `src/services/TaskViewerProvider.ts`
- `src/services/KanbanProvider.ts`
- `src/webview/planning.js`
- `src/services/PlanningPanelProvider.ts`

---

**Send to Coder**
