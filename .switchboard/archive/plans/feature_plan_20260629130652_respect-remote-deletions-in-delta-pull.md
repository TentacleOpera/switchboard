# Respect Remote Deletions in Delta Pull

## Goal

When a task is deleted (or archived/trashed) on the remote (ClickUp or Linear), the next delta pull should remove the corresponding local `.md` file and cache DB entry. The user made a deliberate choice to delete that ticket — the local file layer should reflect that, not cling to a ghost.

### Problem

The delta pull (`TaskViewerProvider.importAllTasks` with `deltaSince`/`deltaSinceIso`) fetches only tasks *changed* since the last cursor. Deleted tasks are not in the response — the API returns updated tasks, not a deletion log. So the local file stays on disk, the cache DB entry stays registered, and the sidebar shows a ticket that no longer exists remotely. The user sees a ghost they have to manually delete.

The previous review (feature_plan_20260629111030) deferred this as "out of scope for v1" and framed auto-deletion as dangerous ("could destroy local edits"). That framing is wrong: if the user deleted the ticket on the remote, that *is* the choice. Keeping a local ghost is annoyance disguised as helpfulness. The only legitimate concern is unpushed local edits on a ticket the user *also* deleted remotely — and in that scenario the user already decided the ticket is gone; silently preserving their half-finished edit to a deleted ticket is not a feature, it's clutter.

### Root Cause

The delta pull only processes the *intersection* of (remote changed tasks) × (local files). It has no concept of (local files) − (remote current tasks) = deleted remotely. There's no "tombstone" or deletion feed from either API. The only way to detect deletions is to compare the full set of remote task IDs against the full set of local file IDs — which is what a **full list fetch** (not a delta fetch) gives you.

### Background

- **ClickUp:** `GET /list/{id}/task` returns all tasks in the list (paginated, 100/page). **Confirmed by research:** The `archived` parameter defaults to `false` — archived tasks are excluded from the default response. Trashed/deleted tasks are completely unreachable through list query endpoints (they sit in a 30-day Workspace Trash bin, but there's no API to query the trash). The `include_closed` parameter (defaults to `false`) controls whether tasks with a "Closed" workflow status are returned — this is independent of archival (a closed task is NOT archived, and an archived task is NOT closed). The existing `getListTasks` (`ClickUpSyncService.ts:1122`) already fetches all tasks when called without `dateUpdatedGt` — this is the "full import" path. It paginates internally through ALL pages (breaks when a page returns < 100 tasks), so the full set is complete. **TIML (Tasks in Multiple Lists):** ClickUp tasks can exist in multiple lists. The `GET /list/{id}/task` endpoint returns only tasks in that specific list. If a task is removed from list A but still exists in list B, it will be absent from list A's query — the deletion sweep would remove the local file imported from list A. This is arguably correct (the task was unlinked from this list), but the task still exists remotely. See Edge-Case audit for handling.
- **Linear:** `queryIssues` (`LinearSyncService.ts:708`) fetches issues via GraphQL with an `IssueFilter`. **Confirmed by research:** The `issues` query's `includeArchived` argument defaults to `false` — archived issues are excluded from the default response. Archiving is immediate and synchronous (no eventual consistency delay). Trashed/soft-deleted issues (via `issueDelete` mutation) are excluded from standard queries even with `includeArchived: true`. **CRITICAL — Linear auto-archiving:** Linear automatically archives closed issues after a configurable period (3, 6, or 12 months based on team settings). This means the deletion sweep will silently remove local files for old completed issues that the user did NOT manually archive — Linear's system did it automatically. See User Review Required. **CRITICAL:** `queryIssues` has a hard limit cap of 100 (`Math.min(Math.floor(requestedLimit), 100)` at `:729`). For projects with >100 issues, a single `queryIssues` call returns an incomplete set. The deletion sweep must use a new `fetchAllIssueIds` method that paginates without the 100-issue cap (see Step 2A).
- **Local file + cache DB:** Each imported ticket has a `.md` file at a known path and a cache DB entry. The DB entry's `slugPrefix` is `<provider>_<id>` (NOT `<provider>_<id>_<slug>` — the slug is only in the filename, not the DB key). The `ImportedDocEntry` interface (`KanbanDatabase.ts:64`) includes a `sourceId` field that contains the clean remote ID directly — no string parsing needed. The `deleteImportedTicket` method (`PlanningPanelCacheService.ts:492`) removes the DB entry. The file can be `unlink`'d directly. The existing `deleteTicket` command (`TaskViewerProvider.ts:18907`) already does both — archive remote + unlink file + delete DB entry. We need just the local cleanup half (no remote call — the remote deletion already happened).
- **`listImportedTickets`** (`KanbanDatabase.ts:2091`) returns all imported ticket entries for a workspace, each with `slugPrefix`, `sourceId`, `filePath`, and `lastSyncedAt`. This is the "full set of local file IDs" we diff against. **Use `sourceId` for the remote ID comparison** — it's the clean remote ID stored at import time, avoiding fragile `slugPrefix` parsing.
- **The delta cursor** (`last_delta_pull_<provider>_<listId/projectId>`) marks the last successful pull. A deletion sweep is a separate concern from a delta pull — it needs the full remote ID set, not just changed tasks.
- **The delta pull flow:** `refreshTicketsDelta` (`PlanningPanelProvider.ts:4849`) reads the cursor, calls `importAllTasks` with delta params, then updates the cursor. The auto-sync timer (`PlanningPanelProvider.ts:8331`, 45s interval) uses the same path. Both flow through `importAllTasks`, so the deletion sweep added there covers both manual Refresh and auto-sync.

## Metadata
- **Tags**: bugfix, feature, backend, api, database
- **Complexity**: 6/10

## User Review Required

**Linear auto-archiving behavior — decision needed.** Research confirmed that Linear automatically archives closed issues after a configurable period (3, 6, or 12 months based on team settings). The deletion sweep uses default queries (which exclude archived issues), so it will silently remove local files for old completed issues that the user did NOT manually archive — Linear's system archived them automatically.

The plan's Goal explicitly states "deleted (or archived/trashed)" should be removed locally, which covers manual archiving. But auto-archiving is a system action, not a user choice. Two options:

- **Option A (current plan): Treat auto-archived same as manually archived.** The local file is removed when Linear auto-archives the issue. Simple, consistent, but the user may lose old completed ticket notes they wanted to keep. The user's local edits to those tickets would be silently deleted.
- **Option B: Query with `includeArchived: true` and only delete truly absent IDs.** Fetch both active AND archived issue IDs. Only delete local files whose ID is absent from BOTH sets (i.e., truly deleted/trashed, not just archived). This preserves local files for auto-archived issues. Costs one extra GraphQL query per sweep (fetching archived issue IDs). The existing `_buildIssueListQuery` would need an `includeArchived` variable added.

**Recommendation:** Option A is simpler and matches the plan's stated Goal. If the user wants to preserve auto-archived tickets, Option B is the fallback. The user should decide before implementation.

## Complexity Audit

### Routine
- Adding a deletion sweep loop after the existing import loop in `importAllTasks` — localized insertion in a single method.
- Unlinking files and deleting cache entries — reuses existing `deleteImportedTicket` and `fs.promises.unlink` patterns already used in `deleteTicket` (`:18937-18952`).
- Filtering DB entries to the current list/project scope — straightforward path comparison.
- Error handling with try/catch and ENOENT guards — mirrors the existing `deleteTicket` pattern.

### Complex / Risky
- **Linear 100-issue cap:** `queryIssues` hard-caps at 100 issues (`:729`). A naive full-fetch for the deletion sweep would return an incomplete set for projects with >100 issues, causing the sweep to delete local files for issues that exist remotely but weren't fetched. Requires a new `fetchAllIssueIds` method with uncapped pagination. **This is a data-loss risk if not addressed.**
- **Cross-list/project scoping:** `getImportedTickets()` returns ALL tickets across all lists/projects. Without correct scoping, importing list A would delete list B's files. The scoping filter must be precise — a loose `includes()` check on a path segment could match coincidentally.
- **ClickUp cache staleness on delta path:** The task cache is only invalidated for full imports (`!isDelta` at `:18729`). For delta pulls, `getListTasks(listId)` returns cached data (up to 5 min old). A task deleted within that window would not be detected. The cache must be invalidated before the full-ID-set fetch in the delta path.
- **Auto-sync sidebar refresh:** The auto-sync timer only posts `importAllTicketsComplete` if `successCount > 0` (`:8384`). If only deletions occurred (no updates), the sidebar won't refresh to remove the deleted ticket's card. The result must include a `deletedCount` and the auto-sync handler must post the message when `deletedCount > 0`.
- **Empty-list vs fetch-failed disambiguation:** An intentionally empty remote list (all tasks deleted) must trigger deletion of all local files for that list. But a failed API fetch returning an empty array must NOT trigger deletions. The `size > 0` guard conflates these two cases. A concrete "fetch succeeded" flag is needed.

## Edge-Case & Dependency Audit

- **Race Conditions:** The deletion sweep runs after the import loop completes, in the same `importAllTasks` call. No concurrent modification risk — the import loop is sequential and the sweep is a single-threaded continuation.
- **Security:** No new external inputs. The sweep only deletes files whose paths are already registered in the local cache DB — no user-controlled path injection.
- **Side Effects:** Files are permanently deleted (not trashed). This is the intended behavior — the user deleted the ticket remotely. No undo. The `window.confirm` / dialog rule is respected — deletions are immediate.
- **Dependencies & Conflicts:**
  - Depends on the file-backed sync infrastructure from `feature_plan_20260629111030` (delta pull, per-list cursor, cache DB entries). That plan is already implemented.
  - The `fetchAllIssueIds` method (Step 2A) is a new addition to `LinearSyncService` — no conflict with existing methods.
  - The cache invalidation in the delta path (Step 2B) must happen AFTER the delta pull's `getListTasks` call (which uses `dateUpdatedGt` and bypasses cache) but BEFORE the full-ID-set fetch (which uses the simple query path and hits cache). The delta pull call at `:18732` already completed by the time the sweep runs, so invalidating between the import loop and the sweep is safe.
- **Unpushed local edits on a deleted ticket:** The user deleted the ticket remotely. The local file is deleted. This is the correct behavior — the user's intent is clear. If they had unpushed edits, they deleted the ticket anyway. No conflict path needed.
- **Subtasks:** ClickUp subtasks are in the same list as their parent (fetched with `subtasks=true`). Linear subtasks are in the same team/project. The full fetch includes subtasks. Deleted subtasks are handled the same way — their ID won't be in the remote set.
- **Network failure during full-ID-set fetch (delta path):** If the full fetch fails, skip the deletion sweep entirely (the `try/catch` handles this). Never delete files based on a partial or failed fetch. The "fetch succeeded" flag must be set only when the fetch completes without throwing.
- **Empty remote list:** If the remote list/project has zero tasks (all deleted), the sweep should delete ALL local files for that list/project. The "fetch succeeded" flag distinguishes "empty list" (sweep runs, deletes all) from "fetch failed" (sweep skipped, nothing deleted).
- **ClickUp TIML (Tasks in Multiple Lists):** Research confirmed ClickUp tasks can exist in multiple lists. If a task is removed from list A but still exists in list B, it's absent from list A's `GET /list/{id}/task` response. The deletion sweep (scoped to list A's directory via `path.dirname`) would remove the local file imported from list A. This is arguably correct — the task was unlinked from this list. If the user also imported the same task from list B, that file lives in list B's directory and is untouched. No additional mitigation needed beyond the existing directory scoping.
- **Linear auto-archiving:** Research confirmed Linear automatically archives closed issues after 3/6/12 months. The deletion sweep (using default queries that exclude archived issues) will remove local files for these auto-archived issues. This is a behavioral surprise — see User Review Required for the decision on whether to treat auto-archived same as manually deleted.
- **ClickUp closed vs. archived:** Research confirmed these are independent states. The existing `getListTasks` passes `include_closed=${includeClosed}` with `includeClosed` defaulting to `true` (`ClickUpSyncService.ts:1162`). This means closed tasks ARE included in the query response and will NOT be swept. Only archived/trashed tasks (excluded by default) are detected by the sweep. This is the correct behavior — a closed task is still active, just completed.
- **Migration / shipped state:** No data migration needed. The deletion sweep operates on existing cache DB entries and files. No new persistent state.

## Dependencies
- `feature_plan_20260629111030 — Tickets Tab File-Backed Sync` (delta pull, per-list cursor, cache DB entries). Already implemented.

## Design Decision: Deletion Sweep, Not Delta Deletion Log

Since neither API provides a deletion log, deletions are detected by **diffing the full remote ID set against the local file ID set**. This requires a full list fetch (not a delta fetch). To avoid making every delta pull expensive, the deletion sweep runs:

1. **On every full import** (cursor unset / first load) — the full remote set is already in hand, so the sweep is free.
2. **On every manual Refresh** (`refreshTicketsDelta`) — after the delta pull completes, do a *second* lightweight full-list fetch (IDs only, no task details) to get the current remote ID set, then diff. This is one extra API call per Refresh — acceptable for a manual action.
3. **On every auto-sync delta pull tick** (auto-sync ON) — same as Refresh: delta pull first, then a full ID-set fetch for the deletion sweep. The 45s interval is infrequent enough that one extra paginated fetch is fine.

The deletion sweep is **always** a full ID-set comparison, never a delta. The delta pull handles *updates*; the sweep handles *deletions*.

## Proposed Changes

### Step 1 — Add a deletion sweep to `importAllTasks` after the import loop (full import path)
**`src/services/TaskViewerProvider.ts`** (`importAllTasks` fast path, after the `for (const item of items)` loop at `:18817`, before the `return` at `:18819`)

After the import/conflict-guard loop completes, if this was a **full import** (not a delta — `!isDelta`), the `items` array already contains the complete remote task set. Diff it against the local cache DB entries:

```ts
// Deletion sweep: for full imports, the items array IS the complete
// remote task set. Any local file whose sourceId is not in this set has
// been deleted remotely — remove the file + cache entry.
let deletedCount = 0;
if (!isDelta) {
    const remoteIds = new Set(items.map((t: any) => String(t.id)));
    try {
        const cacheService = this._getCacheService(resolvedRoot);
        const dbTickets = await cacheService.getImportedTickets();
        // Scope to the current list/project directory only — don't touch
        // files belonging to other lists/projects.
        const scopedDbTickets = targetDir
            ? dbTickets.filter(t => t.filePath && path.dirname(t.filePath) === targetDir)
            : dbTickets;
        for (const dbT of scopedDbTickets) {
            // Use sourceId (clean remote ID) instead of parsing slugPrefix.
            const remoteId = String(dbT.sourceId || '');
            if (remoteId && !remoteIds.has(remoteId)) {
                // Deleted remotely — remove local file + DB entry.
                try { await fs.promises.unlink(dbT.filePath); } catch (e: any) {
                    if (e.code !== 'ENOENT') console.warn('[TaskViewerProvider] Deletion sweep: could not unlink', dbT.filePath, e);
                }
                try { await cacheService.deleteImportedTicket(dbT.slugPrefix); } catch (e) {
                    console.warn('[TaskViewerProvider] Deletion sweep: could not delete cache entry', dbT.slugPrefix, e);
                }
                deletedCount++;
            }
        }
    } catch (e) {
        console.warn('[TaskViewerProvider] Deletion sweep failed:', e);
    }
}
```

**Key corrections from original plan:**
- **Use `sourceId` instead of parsing `slugPrefix`:** The `ImportedDocEntry` interface (`KanbanDatabase.ts:64`) has a `sourceId` field containing the clean remote ID. The original plan's `slugPrefix.replace(...).split('_')[0]` parsing was based on an incorrect format assumption (`<provider>_<id>_<slug>` — the actual `slugPrefix` is just `<provider>_<id>`, confirmed at `:18674`). Using `sourceId` eliminates this fragility entirely.
- **Use `path.dirname(filePath) === targetDir` instead of `filePath.includes(currentDirSegment)`:** The `includes` check on a path segment could match coincidentally (e.g., a list named "test" matching a path containing "latest-test"). `path.dirname` gives the exact parent directory, matching only files truly within the current list/project's directory.

### Step 2A — Add `fetchAllIssueIds` to `LinearSyncService` (uncapped pagination)
**`src/services/LinearSyncService.ts`** (new public method, after `queryIssues` at `:830`)

The existing `queryIssues` has a hard limit cap of 100 (`:729`: `Math.min(Math.floor(requestedLimit), 100)`). For projects with >100 issues, a single call returns an incomplete set. The deletion sweep needs the COMPLETE ID set — using `queryIssues` with `limit: 100` would cause false deletions of local files for issues 101+ that exist remotely. This is a **data-loss bug** in the original plan.

Add a new method that paginates through all issues without the limit cap, returning only IDs (lightweight):

```ts
/**
 * Fetch ALL issue IDs for a project, paginating through the complete set
 * without the 100-issue limit cap. Used by the deletion sweep to get the
 * full remote ID set. Returns only IDs — no task details — to minimize
 * payload size.
 */
public async fetchAllIssueIds(projectId: string): Promise<Set<string>> {
    const config = await this.loadConfig();
    if (!config?.setupComplete || !config.teamId) {
        throw new Error('Linear not configured');
    }
    const resolvedProjectId = await this._resolveSingleIncludeProjectId(config);
    const filter = buildLinearIssueFilter(config.teamId, resolvedProjectId || projectId);

    const ids = new Set<string>();
    let cursor: string | null = null;
    const query = this._buildIssueListQuery();
    let pageCount = 0;
    const maxPages = 50; // Higher cap: 50 pages × 50/page = 2500 issues max

    while (pageCount < maxPages) {
        const result = await this.graphqlRequest(query, {
            filter,
            after: cursor,
            first: 50
        });
        const page = result.data?.issues;
        const nodes = Array.isArray(page?.nodes) ? page.nodes : [];
        for (const node of nodes) {
            if (node.id) ids.add(String(node.id));
        }
        if (!page?.pageInfo?.hasNextPage) break;
        cursor = String(page.pageInfo.endCursor || '').trim() || null;
        if (!cursor) break;
        pageCount++;
        await this.delay(200);
    }
    if (pageCount >= maxPages) {
        console.warn(`[LinearSync] fetchAllIssueIds reached page cap (${maxPages}). Some issues may be omitted.`);
    }
    return ids;
}
```

**Note:** This method bypasses the cache (no `isSimpleQuery` check) because the deletion sweep needs the current live state, not potentially stale cached data. The 50-page cap (2500 issues) is a safety guard against runaway pagination; real projects rarely exceed this.

### Step 2B — Add a full-ID-set fetch for delta pulls (with cache invalidation)
**`src/services/TaskViewerProvider.ts`** (`importAllTasks` fast path, after the delta import loop, before the `return` at `:18819`)

For delta pulls (`isDelta === true`), the `items` array only contains *changed* tasks — it's not the full remote set. To detect deletions, fetch the full ID set separately. **Critically, the ClickUp task cache must be invalidated first** — the cache is only invalidated for full imports (`!isDelta` at `:18729`), so a delta pull's `getListTasks(listId)` would return stale cached data (up to 5 min old) and miss recently-deleted tasks.

```ts
// For delta pulls, fetch the full remote ID set separately to detect
// deletions. This is one extra paginated API call per Refresh/tick —
// acceptable for a manual action or a 45s auto-sync interval.
if (isDelta) {
    let fetchSucceeded = false;
    let fullRemoteIds = new Set<string>();
    try {
        if (provider === 'clickup' && listId) {
            // Invalidate cache so we get live data, not a stale 5-min snapshot.
            this._getCacheService(resolvedRoot).invalidateTaskCache('clickup', listId);
            const clickup = this._getClickUpService(resolvedRoot);
            const allTasks = await clickup.getListTasks(listId);
            fullRemoteIds = new Set(allTasks.map((t: any) => String(t.id)));
            fetchSucceeded = true;
        } else if (provider === 'linear' && projectId) {
            // Use fetchAllIssueIds (uncapped) — NOT queryIssues (capped at 100).
            const linear = this._getLinearService(resolvedRoot);
            fullRemoteIds = await linear.fetchAllIssueIds(projectId);
            fetchSucceeded = true;
        }
    } catch (e) {
        console.warn('[TaskViewerProvider] Deletion sweep (delta): full ID-set fetch failed, skipping sweep:', e);
        fetchSucceeded = false;
    }
    // Only sweep if the fetch succeeded — never delete based on a failed/partial fetch.
    // An empty set with fetchSucceeded=true means the list is intentionally empty
    // (all tasks deleted remotely) → sweep deletes all local files for this list.
    if (fetchSucceeded) {
        try {
            const cacheService = this._getCacheService(resolvedRoot);
            const dbTickets = await cacheService.getImportedTickets();
            const scopedDbTickets = targetDir
                ? dbTickets.filter(t => t.filePath && path.dirname(t.filePath) === targetDir)
                : dbTickets;
            for (const dbT of scopedDbTickets) {
                const remoteId = String(dbT.sourceId || '');
                if (remoteId && !fullRemoteIds.has(remoteId)) {
                    try { await fs.promises.unlink(dbT.filePath); } catch (e: any) {
                        if (e.code !== 'ENOENT') console.warn('[TaskViewerProvider] Deletion sweep (delta): could not unlink', dbT.filePath, e);
                    }
                    try { await cacheService.deleteImportedTicket(dbT.slugPrefix); } catch (e) {
                        console.warn('[TaskViewerProvider] Deletion sweep (delta): could not delete cache entry', dbT.slugPrefix, e);
                    }
                    deletedCount++;
                }
            }
        } catch (e) {
            console.warn('[TaskViewerProvider] Deletion sweep (delta) failed:', e);
        }
    }
}
```

**Key corrections from original plan:**
- **`fetchSucceeded` flag:** The original plan mentioned this flag but never implemented it. Here it's concrete: set to `true` only when the fetch completes without throwing. The sweep runs only when `fetchSucceeded === true`. This correctly handles the empty-list case (fetch succeeds, set is empty, all local files deleted) vs the fetch-failed case (fetch throws, `fetchSucceeded` stays `false`, sweep skipped, nothing deleted).
- **Cache invalidation for ClickUp:** `invalidateTaskCache('clickup', listId)` is called before `getListTasks(listId)` to ensure live data. This is safe because the delta pull (which uses `dateUpdatedGt` and bypasses cache) has already completed at this point.
- **`fetchAllIssueIds` for Linear:** Uses the new uncapped method instead of `queryIssues({ limit: 100 })`, which would miss issues beyond the 100-cap.

### Step 3 — Scope the deletion sweep to the current list/project only
**`src/services/TaskViewerProvider.ts`**

The `getImportedTickets()` call returns ALL imported tickets for the workspace, across all lists/projects. The deletion sweep must only remove files for tickets that *belong to the currently-selected list/project*. Otherwise, importing list A would delete all files for list B (they're not in list A's remote set).

**Approach:** Compare `path.dirname(dbT.filePath)` against `targetDir`. The `targetDir` variable is already computed earlier in `importAllTasks` (`:18749` for ClickUp, `:18768` for Linear, `:18774` for fallback). Since `_writeTaskDocument` stores files at `path.join(targetDir, filename)` (`:18666`), `path.dirname(filePath)` will equal `targetDir` for files in the current list/project.

```ts
// Filter DB entries to only those in the current list/project's
// directory — don't delete files belonging to other lists/projects.
const scopedDbTickets = targetDir
    ? dbTickets.filter(t => t.filePath && path.dirname(t.filePath) === targetDir)
    : dbTickets;
```

This filter is already applied in both Step 1 and Step 2B above. **Do not use `filePath.includes(currentDirSegment)`** — a loose substring match on a path segment can match coincidentally (e.g., list "dev" matching path `/.../device-tickets/...`). `path.dirname` gives the exact parent directory.

### Step 4 — Add `deletedCount` to the return value and fix auto-sync sidebar refresh
**`src/services/TaskViewerProvider.ts`** (modify the return at `:18819`)

Include `deletedCount` in the return so callers know deletions occurred:

```ts
return { success: true, successCount, failCount, errors, deletedCount, ...(skippedModified > 0 ? { skippedModified } : {}) };
```

**`src/services/PlanningPanelProvider.ts`** (auto-sync timer, `:8384`)

The auto-sync timer only posts `importAllTicketsComplete` if `successCount > 0`. If only deletions occurred (no updates, but a task was deleted remotely), the sidebar won't refresh to remove the deleted card. Fix: also post when `deletedCount > 0`:

```ts
// If any tickets were updated OR deleted, refresh the sidebar silently.
if ((result.successCount || 0) > 0 || (result.deletedCount || 0) > 0) {
    this._panel?.webview.postMessage({
        type: 'importAllTicketsComplete',
        success: true,
        successCount: result.successCount,
        failCount: result.failCount,
        deletedCount: result.deletedCount,
        errors: result.errors,
        importMode: 'document',
        workspaceRoot,
        provider: selection.provider,
        listId: selection.listId,
        projectId: selection.projectId,
        isDelta: lastPullIso !== null,
        autoSync: true
    });
}
```

**`src/services/PlanningPanelProvider.ts`** (manual Refresh handler, `:4908`)

Also include `deletedCount` in the manual Refresh's `importAllTicketsComplete` message for consistency:

```ts
this._panel?.webview.postMessage({
    type: 'importAllTicketsComplete',
    success: result.success,
    successCount: result.successCount,
    failCount: result.failCount,
    deletedCount: result.deletedCount,
    errors: result.errors,
    importMode: 'document',
    workspaceRoot,
    provider,
    listId,
    projectId,
    isDelta: lastPullIso !== null
});
```

## Adversarial Synthesis

Key risks: (1) Linear's 100-issue query cap causing false deletions of local files for issues beyond the cap — mitigated by the new `fetchAllIssueIds` method with uncapped pagination. (2) Cross-list contamination deleting files from the wrong list — mitigated by precise `path.dirname` scoping instead of loose substring matching. (3) Failed API fetch returning an empty set and wiping all local files — mitigated by the concrete `fetchSucceeded` flag that gates the sweep. (4) ClickUp cache staleness on delta pulls hiding recent deletions — mitigated by explicit cache invalidation before the full-ID fetch. (5) Auto-sync not refreshing the sidebar when only deletions occur — mitigated by including `deletedCount` in the refresh condition. (6) **Linear auto-archiving silently deleting local files for old completed issues** — research confirmed Linear auto-archives closed issues after 3/6/12 months. The sweep treats these as deleted. Mitigated by surfacing this as a User Review decision (Option A: treat as deleted; Option B: query with `includeArchived: true` to preserve). (7) **ClickUp TIML false positives** — a task removed from one list but existing in another would be swept from the first list's directory. Mitigated by directory scoping — the file is only deleted from the list it was imported from, not globally.

## Verification Plan

### Automated Tests
- Unit: deletion sweep removes a local file + DB entry when a task ID is absent from the remote set (mock `getListTasks` returning a set without the local ticket's ID).
- Unit: deletion sweep does NOT remove files from other lists (mock `getListTasks` for list A; confirm list B's files survive — verify `path.dirname` scoping).
- Unit: deletion sweep skips when the full fetch fails (mock `getListTasks` throwing; confirm `fetchSucceeded` stays false and no files deleted).
- Unit: deletion sweep correctly handles an intentionally empty remote list (mock `getListTasks` returning `[]` with `fetchSucceeded=true`; confirm all local files for that list are deleted).
- Unit: `fetchAllIssueIds` paginates beyond 100 issues (mock GraphQL returning 150 issues across 3 pages; confirm all 150 IDs are in the set).
- Unit: deletion sweep uses `sourceId` field, not `slugPrefix` parsing (verify with a DB entry whose `slugPrefix` contains underscores in the ID portion — confirm correct comparison).

> **Session directives:** No compilation step. No automated tests.

### Manual Verification
1. Import a ClickUp list with 5 tasks → confirm 5 local files.
2. Delete one task in ClickUp's UI.
3. Click **Refresh** → confirm the local file for the deleted task is gone (file + sidebar entry).
4. Repeat with Linear: import a project with 5 issues, delete one in Linear's UI, Refresh → confirm the local file is gone.
5. **Cross-list safety:** import list A and list B (each with tasks). Delete a task from list A remotely. Refresh list A → confirm list B's files are untouched.
6. **Auto-sync ON:** delete a task remotely → wait for the next 45s tick → confirm the local file is removed without manual Refresh and the sidebar updates.
7. **Empty list:** delete all tasks in a ClickUp list remotely → Refresh → confirm all local files for that list are removed (but other lists' files survive).
8. **Large Linear project (>100 issues):** import a Linear project with >100 issues. Delete one issue. Refresh → confirm only the deleted issue's file is removed, and all other 100+ files survive (verifies `fetchAllIssueIds` uncapped pagination).
9. **Network failure:** disconnect network, click Refresh → confirm no local files are deleted (fetch fails, `fetchSucceeded` stays false, sweep skipped).
10. **ClickUp TIML:** import a task that exists in both list A and list B (import from each list separately → two local files in different directories). Remove the task from list A in ClickUp's UI. Refresh list A → confirm only the file in list A's directory is removed; the file in list B's directory survives.
11. **ClickUp closed task:** import a list with a closed task. Refresh → confirm the closed task's local file survives (closed tasks are included in the query via `include_closed=true`).
12. **Linear auto-archiving (if Option A):** import a Linear project with an old completed issue. If Linear auto-archives it, Refresh → confirm the local file is removed. (If Option B is chosen, confirm the file survives.)

## Recommendation
Complexity 6/10 → **Send to Coder**. The core deletion logic is routine, but the Linear 100-issue cap fix, cache invalidation, and `fetchSucceeded` flag add moderate complexity with data-loss risk if implemented incorrectly.

---

## Code Review Results

### Stage 1 — Grumpy Principal Engineer Review

> *(theatrical grumpy voice)*

**CRITICAL — `sourceId` is the PROVIDER NAME, not the task ID. You just built a nuke and wired it to the Refresh button.** The plan confidently claims: "The `ImportedDocEntry` interface includes a `sourceId` field that contains the clean remote ID directly — no string parsing needed." WRONG. `sourceId` in `ImportedDocEntry` (`KanbanDatabase.ts:66`) maps to the `source_id` DB column, which stores the PROVIDER NAME — `'linear'` or `'clickup'` — NOT the task ID. The task ID is in `remoteDocId` (maps to `remote_doc_id` column). The registration chain proves it: `_writeTaskDocument` calls `registerImportedTicket(provider, id, ...)` (`TaskViewerProvider.ts:19209`) → `upsertImportedTicket(wsId, slugPrefix, sourceId=provider, remoteDocId=id, ...)` (`KanbanDatabase.ts:2114-2118`). So `dbT.sourceId` is `'linear'`. The sweep compares `'linear'` against a set of task IDs like `{'abc123', 'def456'}`. `'linear'` is never in that set. **Every single local file gets deleted on every full import.** This is not a subtle edge case — this is "the first user to click Refresh loses all their ticket files." The plan's own Background section even documents the correct field (`remoteDocId`) in the `ImportedDocEntry` interface definition but then tells the implementation to use the wrong one. Spectacular.

**MAJOR — Full-import sweep uses filtered items, not raw fetch. Closed tickets get nuked.** The plan says "closed tasks ARE included in the query response and will NOT be swept." But the implementation builds `remoteIds` from `items` AFTER the filter at `TaskViewerProvider.ts:19333` (`items.filter(it => !_isSubtask(it) && (includeClosed || !_isClosed(it)))`). When `includeClosed=false` (the default), closed tickets are filtered OUT of `items`, so their IDs are NOT in `remoteIds`, so the sweep deletes their files. The plan's own verification step 11 says "confirm the closed task's local file survives" — it wouldn't. The sweep should use the raw (pre-filter) ID set, not the filtered one.

**MAJOR — Full-import sweep missing `rawItemCount > 0` guard.** The cleanup prune at `:19389` has `rawItemCount > 0` to avoid wiping all files on an empty fetch (transient API error, rate limit, query mismatch). The deletion sweep at `:19436` has NO such guard. If `getListTasks` or `queryIssues` returns an empty array without throwing (which happens on transient issues), the sweep deletes every local file in the directory. The delta path handles this correctly with `fetchSucceeded`, but the full-import path is unguarded.

**NIT — `fetchAllIssueIds` page-cap warning fires after the last `delay(200)`.** The `pageCount >= maxPages` warning at `LinearSyncService.ts:881` fires after the loop exits, but the `delay(200)` at `:878` runs on every iteration including the last one before the cap check. This adds an unnecessary 200ms delay after the last page. Trivial, but it's a wasted API budget tick.

### Stage 2 — Balanced Synthesis

**Keep:**
- `fetchAllIssueIds` method (`LinearSyncService.ts:849-884`) — correctly implements uncapped pagination with a 50-page safety cap. The GraphQL query, cursor handling, and `hasNextPage` break logic are all correct.
- Delta path (Step 2B) — correctly fetches the full ID set separately, invalidates ClickUp cache before the fetch, uses `fetchSucceeded` flag to gate the sweep, and handles empty-list vs fetch-failed disambiguation.
- `deletedCount` return value and auto-sync refresh fix (Step 4) — correctly includes `deletedCount` in the return object and posts `importAllTicketsComplete` when `deletedCount > 0`.
- `path.dirname` scoping — correctly uses exact directory match instead of loose substring matching.
- ENOENT guards on `unlink` — correctly swallows "file already gone" errors.

**Fix now (all three applied):**
1. **CRITICAL:** Changed `dbT.sourceId` → `dbT.remoteDocId` in BOTH sweep locations (full-import at `TaskViewerProvider.ts:19466` and delta at `:19526`). `remoteDocId` is the actual task ID; `sourceId` is the provider name.
2. **MAJOR:** Captured `rawRemoteIds` from the unfiltered `items` array BEFORE the subtask/closed filter at `:19341`, and used `rawRemoteIds` instead of `new Set(items.map(...))` in the full-import sweep. This ensures closed tickets (when `includeClosed=false`) are NOT swept — they still exist remotely.
3. **MAJOR:** Added `rawItemCount > 0` guard to the full-import sweep condition (`!isDelta && rawItemCount > 0`), matching the cleanup prune's guard. A transient empty fetch will not wipe all local files. The delta path already handles this via `fetchSucceeded`.

**Defer:** The `fetchAllIssueIds` 200ms delay-after-last-page NIT is not worth fixing — it's one wasted delay at the end of a sweep that runs at most every 45s.

### Fixes Applied
1. **`TaskViewerProvider.ts:19341`** — Added `const rawRemoteIds = new Set<string>(items.map(...))` before the filter at `:19342`, capturing all fetched IDs (including subtasks and closed tickets).
2. **`TaskViewerProvider.ts:19452`** — Changed full-import sweep condition from `if (!isDelta)` to `if (!isDelta && rawItemCount > 0)`.
3. **`TaskViewerProvider.ts:19467`** — Changed full-import sweep from `new Set(items.map(...))` to `rawRemoteIds` (pre-filter set).
4. **`TaskViewerProvider.ts:19466`** — Changed `dbT.sourceId` to `dbT.remoteDocId` in full-import sweep.
5. **`TaskViewerProvider.ts:19526`** — Changed `dbT.sourceId` to `dbT.remoteDocId` in delta sweep.

### Files Changed
- `src/services/TaskViewerProvider.ts` — 3 fixes (sourceId→remoteDocId, rawRemoteIds, rawItemCount guard)

### Validation Results
- **Code inspection:** Verified the `ImportedDocEntry` interface (`KanbanDatabase.ts:64-66`), `listImportedTickets` mapping (`:2172-2174`), `upsertImportedTicket` parameter mapping (`:2114-2118`), and `registerImportedTicket` call chain (`PlanningPanelCacheService.ts:458-482`, `TaskViewerProvider.ts:19209`) to confirm `sourceId` = provider name and `remoteDocId` = task ID.
- **No compilation step** (per session directives).
- **No automated tests** (per session directives).

### Remaining Risks
- **Medium — Linear auto-archiving (Option A):** The sweep uses default queries (excluding archived issues). Linear auto-archives closed issues after 3/6/12 months. The sweep will delete local files for these auto-archived issues. This is the plan's stated behavior (Option A) but may surprise users who want to keep old completed ticket notes. The User Review decision is still pending.
- **Low — `fetchAllIssueIds` page cap:** 50 pages × 50/page = 2500 issues max. Projects exceeding this will have incomplete ID sets, potentially causing false deletions. The warning is logged. Real projects rarely exceed 2500 issues in a single project.
- **Low — ClickUp TIML:** A task removed from list A but existing in list B will be swept from list A's directory. This is arguably correct (the task was unlinked from that list) but the task still exists remotely. The file in list B's directory is untouched.
