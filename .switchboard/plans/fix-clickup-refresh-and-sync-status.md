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

## Code Review (Reviewer Pass — 2026-06-19)

### Stage 1 — Grumpy Principal Engineer

> *Gather round, children. The build is "complete," they said. Let me put on my reading glasses and discover, as I always do, that "complete" is a word people use the way toddlers use "finished" about a plate of vegetables — most of it is fixed, one bite is hidden in the napkin.*
>
> **CRITICAL — The cache invalidation is shouting into the wrong room.** The plan, with the unearned confidence of a junior who has never been paged at 3am, asserts (lines 179 & 190) that `_adapterFactories.getCacheService` returns "the canonical cache service **which `TaskViewerProvider` also uses**." It does NOT. `TaskViewerProvider` builds its *own* `PlanningPanelCacheService` from its *own* private `_cacheServices` Map (`TaskViewerProvider.ts:5205`) and injects *that* instance into its ClickUp service (`5118–5119`). The extension factory's singleton (`extension.ts:746`) is a **different object** with a **different in-memory `_taskCache` Map** (`PlanningPanelCacheService.ts:35`, 5-min TTL, in-memory only — no shared disk read-back). So when the refresh handler dutifully calls `invalidateTaskCache('clickup', listId)` on the *singleton*, and then the auto-import (`importAllTasks` → `getListTasks`, `TaskViewerProvider.ts:17931`) reads from the *other* cache, the stale entry is sitting right there, untouched, smug. The import writes stale `.md` files to disk. Bug 2 — the entire reason we are here — is **not fixed for the imported file content.** You moved the furniture in the room nobody was standing in.
>
> **MAJOR — Two of the three invalidation calls are theatre.** The display path uses `KanbanProvider._getClickUpService` (`KanbanProvider.ts:1338`) which **never** calls `setCacheService`, so its `_cacheService` is `null` and `getListTasks` *always* hits live API. Fine — but that means the `invalidateTaskCache` call in `clickupLoadProject` (`PlanningPanelProvider.ts:3107`) protects a cache nobody reads, and `clearTaskListIndex()` in the `invalidateClickUpCache` handler (`3062`) clears an index that service never populated (guarded at `ClickUpSyncService.ts:1175`). Harmless. Also pointless. The plan dresses them up as the fix; they are decoration.
>
> **NIT — The slow path was left holding the same stale bag.** `importAllTasks`' plan-mode branch (`TaskViewerProvider.ts:17999`) reads the very same cached list. A task created on the remote a minute ago won't appear in a refresh-into-plan-mode. Per-item fetches are live, so the blast radius is "you don't import the brand-new ticket," not "you import garbage." Survivable. Note it and move on.
>
> *The good news, grudgingly: Bug 1 is actually fixed. I checked. Twice. Don't let it go to your heads.*

### Stage 2 — Balanced Synthesis

**Keep (correctly implemented, verified end-to-end):**
- DB injection into both constructors — `KanbanProvider.ts:188`, `TaskViewerProvider.ts:5211`. This is the real Bug 1 fix.
- `registerImportedTicket` → `upsertImportedTicket` writes `last_synced_at = now` (`KanbanDatabase.ts:1893–1894`); `_writeTaskDocument` calls it on every bulk import (`TaskViewerProvider.ts:17889`); `_ticketSyncStatusFromTimestamps` 1s grace then yields `synced` (`PlanningPanelProvider.ts:6298`). Chain is sound.
- `KanbanDatabase.forWorkspace` is a per-root **singleton** (`KanbanDatabase.ts:725–730`), so the import's DB write and the `getTicketSyncStatuses` read (`PlanningPanelProvider.ts:3732`) see the same rows despite distinct cache-service instances. Bug 1 closed.
- Cache-key matching is precise: simple queries key on `normalizedListId` (`ClickUpSyncService.ts:1132`) → stored as `clickup:{listId}` → matched exactly by `invalidateTaskCache('clickup', listId)` (`PlanningPanelCacheService.ts:656`).
- `planning.js` refresh handler posts `invalidateClickUpCache` before `loadClickUpProject(true)` (`planning.js:5910`). Fine.

**Fix now (done in this pass):**
- The CRITICAL instance-mismatch. The clean, minimal fix lives at the layer that *owns* the import's cache: `TaskViewerProvider.importAllTasks` invalidates its own list entry **on the first page only** (`page === 1 && !append`) before `getListTasks`, so a refresh pulls live data while paginated imports still reuse the freshly-populated cache. Applied at `TaskViewerProvider.ts:~17931` (document fast-path, which is the `importMode: 'document'` route the refresh auto-import actually takes).

**Defer:**
- The plan-mode slow-path stale-ID edge (`17999`) — low impact, not the reported bug.
- Leaving the singleton-cache invalidation calls in place: they're defensive no-ops today but harmless and future-proof if wiring converges later. No change.

### Fixes Applied
- **`src/services/TaskViewerProvider.ts`** (`importAllTasks`, ClickUp document fast-path, ~L17931): added `if (page === 1 && !append) { this._getCacheService(resolvedRoot).invalidateTaskCache('clickup', listId); }` before `getListTasks(listId)`, with an explaining comment. This is the actual fix for the double-click refresh writing stale files — it clears the *correct* (this-provider-owned) cache instance.

### Validation Results
- **Compilation:** SKIPPED per session directive. ⚠️ The extension runs from `dist/` (webpack) — **all** of this plan's changes, including this fix, are inert until `npm run compile` is run.
- **Automated tests:** SKIPPED per session directive (user will run separately).
- **Static trace (manual):** Verified the import read path (`importAllTasks` → `_getClickUpService` → `_getCacheService` = own instance) vs. the handler invalidation path (extension singleton) are distinct instances; confirmed `forWorkspace` DB singleton makes Bug 1's write/read coherent; confirmed cache-key shape matches the invalidation pattern.

### Remaining Risks
- **Rebuild required.** Changes do not take effect until `npm run compile` rebuilds `dist/extension.js`.
- **One extra live list fetch per auto-sync load.** With autoSync on, the import's first page now always fetches live instead of from its own 5-min cache. This is the correct tradeoff (correctness over one cached call) and mirrors the pre-existing display-vs-import double-fetch divergence.
- **Plan-mode slow path** (`17999`) can still serve a stale ID list on refresh-into-plan-mode; brand-new remote tickets may be skipped until TTL/next refresh. Deferred (NIT).

### Summary by Severity
- **CRITICAL** — Cache invalidation targeted the extension-singleton cache, but the refresh auto-import reads `TaskViewerProvider`'s own distinct `PlanningPanelCacheService` instance (`TaskViewerProvider.ts:5205` / `5118` vs `extension.ts:746`); Bug 2's stale-file-on-single-refresh was not actually fixed. **FIXED** at `TaskViewerProvider.ts:~17931`.
- **MAJOR** — `clickupLoadProject` (`PlanningPanelProvider.ts:3107`) and `invalidateClickUpCache` (`3060`/`3062`) invalidate caches/indexes that the active read paths don't use (display = no-cache `KanbanProvider` service; import = the other instance). Harmless defensive no-ops; **kept**.
- **NIT** — Plan-mode slow path (`TaskViewerProvider.ts:17999`) shares the same stale list cache; **deferred**.
- **VERIFIED OK** — Bug 1 (DB injection → `last_synced_at` populated → `synced` status) fully fixed and traced end-to-end.

---

**Send to Coder**
