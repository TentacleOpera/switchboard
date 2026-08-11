# Tickets sync badge reads a different workspace's DB row than the refetch stamps

## Goal

Make the Tickets sidebar's sync badge read `last_synced_at` from the **same** `kanban.db` row that a refetch writes, so a full refetch from source actually clears the `modified` badge.

### Problem

A ticket in the Tickets sidebar shows `modified` and keeps showing `modified` after a full "Refetch" pull from ClickUp/Linear. The local file is byte-for-byte what the remote produced, but the badge never returns to `synced`.

### Root cause — read and write land in different databases

The badge is computed in `src/services/TicketsPanelProvider.ts:392` (`_ticketSyncStatusFromTimestamps`) as:

```ts
return mtimeMs > lastSyncedMs + 1000 ? 'modified' : 'synced';
```

`lastSyncedAt` comes from an `imported_docs` row read through `this._cacheService`. That field is a **single memoized instance** bound to whichever workspace root reached the provider first, and it is never rebound when the Tickets tab's workspace changes. Every one of the 8 binding sites uses the same first-wins guard (`src/services/TicketsPanelProvider.ts:349, 803, 1830, 1987, 2143, 2796, 2811, 3370`):

```ts
if (!this._cacheService) {
    this._cacheService = this._adapterFactories.getCacheService(workspaceRoot);
}
```

`getCacheService` (`src/extension.ts:1266`) is correctly a per-root map, and `KanbanDatabase.forWorkspace(resolved)` opens **that workspace's own `.switchboard/kanban.db`**. So the first root the provider ever sees pins the panel to one database for the rest of the extension-host lifetime.

Meanwhile the *write* path is per-root correct. `refreshTicketsDelta` (`src/services/TicketsPanelProvider.ts:1819`) dispatches `switchboard.importAllTasks`, which lands in `TaskViewerProvider._writeTaskDocument` and restamps through `this._getCacheService(resolvedRoot)` — a genuinely per-root lookup keyed on the *message's* `workspaceRoot` (`src/services/TaskViewerProvider.ts:22421-22426`).

The tab's workspace is user-selectable: `ticketsWorkspaceRoot` in `src/webview/tickets.js:113` defaults to `_workspaceItems[0]` and is sent on every message. So the write goes to workspace B's DB while the read still comes from workspace A's DB. **The refetch stamps a row nobody reads.**

This is not theoretical — it is the current state on this machine:

```
# .switchboard/kanban.db  (workspace 038bffef-…, the switchboard repo)
clickup_86d3cz53f | last_synced_at 2026-06-20T13:13:06.344Z
                  | file_path /Users/…/Documents/Gitlab/.switchboard/tickets/clickup/…

# /Users/…/Documents/Gitlab/.switchboard/kanban.db  (workspace 64a73ddc0069)
clickup_86d3cz53f | last_synced_at 2026-07-03T00:07:09.520Z
                  | file_path .switchboard/tickets/clickup/…   (relative)
```

Same ticket, same file on disk, two bookkeeping rows in two databases. The file's mtime is `2026-07-03T00:07:09Z`. Against the Gitlab row it reads `synced`; against the switchboard row (frozen on 2026-06-20, and never advanced by any refetch since) it reads `modified` — permanently. All 27 ticket rows in the switchboard DB are frozen at 2026-06-20 and every one of them points at files under the *Gitlab* tree.

### Why one file has rows in several databases

Ticket save location is **global**, not per workspace. `_getTicketDocumentDirs` (`src/services/TicketsPanelProvider.ts:277-289`) reads `GlobalIntegrationConfigService.loadConfigSync(provider).ticketSaveLocation` — one directory shared by every workspace. So there is exactly one `.md` file per ticket, but its `imported_docs` bookkeeping is written into whichever per-workspace DB happened to be resolved at write time. One file, N rows, N different `last_synced_at` values, and the badge picks by accident.

### Two secondary defects that keep the stale row stale

1. **The 24h heal only inserts, never repairs.** `listLocalTicketFiles` (`src/services/TicketsPanelProvider.ts:2004-2027`) rescans the ticket folders when the DB is empty or the heal is older than 24h, but the backfill is guarded by `if (!exists)` — rows that already exist are never re-examined, so a stale `last_synced_at` survives every heal forever.

2. **Absolute vs relative `file_path` masks the mismatch.** `upsertImportedTicket` stores `this._ensureRelativePlanFile(filePath)` and `listImportedTickets` returns `this._resolveAbsolutePlanFile(row.file_path)` (`src/services/KanbanDatabase.ts:3427, 3462`). The switchboard DB's rows were written with an **absolute** path into another workspace's tree, so they survive relativization, still pass `fs.existsSync`, and still `statSync` successfully. Had they been relative they would have resolved to a nonexistent local file and reported `local-only` — a different wrong answer, not a right one.

### Scope

This plan fixes **which row is read**. It deliberately does not change what `modified` means (mtime-vs-timestamp), nor add an escape hatch for genuinely-edited files — those are separate concerns.

## Metadata

- **Complexity:** 6
- **Tags:** bugfix, backend, database, reliability
- **Project:** Browser Switchboard

## Complexity Audit

**Routine**
- Replacing a memoized field with a per-root `Map` accessor. Mechanical, 8 binding sites, all in one file.
- Adding a diagnostic log line naming the resolved root and workspace id.

**Complex / Risky**
- **Shipped state.** `imported_docs` ships in released versions with ~4,000 installs. This plan must not delete or rewrite rows wholesale. The heal repairs `file_path` drift and re-validates existing rows; it never drops a row, and no schema change is involved.
- **The auto-sync engine shares the field.** Sites `803` (auto-sync delta timer) and `3370` (`syncAllTickets`) read `(this._cacheService as any)._kanbanDb` for the delta cursor (`last_delta_pull_<provider>_<id>`). Rebinding per root moves those cursors into the correct DB — correct, but it means an install's first post-fix refresh in a previously-mispinned workspace has no cursor and falls back to a full import. That is the right behaviour (a full pull re-stamps everything) but it must be called out, not discovered.
- **The delta cursor and the ticket rows must agree.** `refreshTicketsDelta` reads the cursor from one DB and the import writes rows to another today. Both must move together in the same change or the delta window is computed against the wrong history.
- **`_getWorkspaceRoot()` fallback.** `_resolveWorkspaceRoot(undefined)` falls back to the primary root. Sites that currently pass a possibly-empty root must keep behaving when the tab has no selection yet (`src/webview/tickets.js:1304` deliberately does not bail on an empty `ticketsWorkspaceRoot`).

## Edge-Case & Dependency Audit

- **Empty `msg.workspaceRoot`.** The Tickets tab sends `workspaceRoot: ticketsWorkspaceRoot || undefined` before the workspace list arrives. `_resolveWorkspaceRoot` already falls back to the primary root; the accessor must accept `null`/`undefined` and use the same fallback rather than throwing.
- **Root not in the workspace folder list.** `_resolveWorkspaceRoot` returns `givenRoot` verbatim when it doesn't match a known folder (`src/services/TicketsPanelProvider.ts:189`). The accessor must `path.resolve` before using it as a map key so `/a/b` and `/a/b/` share one instance, matching `getCacheService`'s own `path.resolve`.
- **Single-workspace installs.** With one workspace root the behaviour is unchanged — same DB before and after. The fix is a no-op for them, which is why this survived so long.
- **`_getEffectiveWorkspaceId` throws.** It raises when a DB has no `workspace_id` (`src/services/PlanningPanelCacheService.ts:60-64`). Site `1995` calls it inside a try; the accessor must not introduce a new unguarded call.
- **Rows for a ticket that was re-titled remotely.** The filename is slugified from the title, so a rename writes a new path and `_removeOrphanTicketFiles` deletes the old file. A row whose `file_path` no longer exists is rename drift, not a missing ticket — the heal should re-point it via `_findTicketFilePath` rather than leaving it to report `local-only`.
- **Concurrency.** `PlanningPanelCacheService` instances are already shared per root via the extension factory; adding a second map in the panel does not create a second DB handle, it only caches the same instance.
- **`sql.js` heap.** Binding a second workspace's DB in the same host loads another `sql.js` database into WASM memory. That already happens (`KanbanDatabase.forWorkspace` is called by the write path today), so the fix does not add a new DB — it stops the panel from being the odd one out.
- **Dependencies:** none outside `src/services/TicketsPanelProvider.ts` and one new regression test. No schema migration, no webview change, no protocol change.

## Proposed Changes

### 1. `src/services/TicketsPanelProvider.ts` — per-root cache-service resolution

Replace the single memo field with a keyed map plus an accessor.

```ts
// BEFORE (line 63)
private _cacheService: any | undefined;

// AFTER
/**
 * One cache service per workspace root. A single memoized instance pinned the
 * whole panel to whichever root arrived FIRST, while the import path resolved
 * per-root — so a refetch stamped last_synced_at in workspace B's kanban.db
 * while the sync badge kept reading workspace A's frozen row and reported
 * "modified" forever. Ticket files live in ONE global folder
 * (GlobalIntegrationConfigService.ticketSaveLocation) but their imported_docs
 * bookkeeping is per-workspace, so read and write MUST agree on the root.
 */
private _cacheServices: Map<string, any> = new Map();

private _getCacheServiceFor(givenRoot?: string | null): any | undefined {
    const root = this._resolveWorkspaceRoot(givenRoot || undefined);
    if (!root) { return undefined; }
    const key = path.resolve(root);
    let svc = this._cacheServices.get(key);
    if (!svc) {
        svc = this._adapterFactories.getCacheService(key);
        this._cacheServices.set(key, svc);
    }
    return svc;
}
```

Rewrite all 8 binding sites to call the accessor with the root already resolved for that handler. Pattern, applied at lines `349`, `803`, `1830`, `1987`, `2143`, `2796`, `2811`, `3370`:

```ts
// BEFORE
if (!this._cacheService) {
    this._cacheService = this._adapterFactories.getCacheService(workspaceRoot);
}
const dbTickets = await this._cacheService.getImportedTickets();

// AFTER
const cacheService = this._getCacheServiceFor(workspaceRoot);
if (!cacheService) { /* existing empty-result path for this handler */ }
const dbTickets = await cacheService.getImportedTickets();
```

Delete the `_cacheService` field once every reader is converted — leaving it as a shim invites a future call site to reintroduce the pin. The reads to convert are lines `352`, `806`, `1833`, `1991-2029`, `2146-2151`, `2799`, `2816-2819`, `3373`.

Site `1830` matters most: the delta cursor (`last_delta_pull_clickup_<listId>` / `last_delta_pull_linear_<projectId>`) is read from `(this._cacheService as any)?._kanbanDb` and written back at line `1863`. Both must use the per-root service so the cursor lives in the same DB as the rows it describes.

### 2. `src/services/TicketsPanelProvider.ts` — make the 24h heal repair, not only insert

In `listLocalTicketFiles` (`~2004-2027`), extend the backfill loop so existing rows are re-pointed when their recorded path has drifted:

```ts
for (const t of scannedTickets) {
    const exists = dbTickets.find((dbT: any) => dbT.slugPrefix === `${provider}_${t.id}`);
    if (!exists) {
        await this._cacheService.registerImportedTicket(/* … unchanged … */);
        continue;
    }
    // Rename drift: the filename is slugified from the title, so a remote
    // re-title writes a new path and _removeOrphanTicketFiles deletes the old
    // one. A row pointing at a file that no longer exists is drift, not a
    // missing ticket — re-point it. Never touches last_synced_at for rows
    // whose file is still where the row says it is: that timestamp is the
    // sync baseline and re-stamping it would silently mark local edits synced.
    if (exists.filePath !== t.filePath && !fs.existsSync(exists.filePath)) {
        await this._cacheService.registerImportedTicket(
            provider, t.id, exists.docName, exists.slugPrefix, t.filePath, '', undefined, exists.url
        );
    }
}
```

### 3. `src/services/TicketsPanelProvider.ts` — one diagnostic line

In `listLocalTicketFiles`, after resolving the service, log which DB answered. This class of bug is invisible today because every surface reports plausible-looking data:

```ts
console.log(
    `[TicketsPanelProvider] listLocalTicketFiles root=${workspaceRoot} ` +
    `wsId=${effectiveWsId} rows=${dbTickets.length} provider=${provider}`
);
```

### 4. `src/test/tickets-sync-status-workspace-binding.test.js` — new regression test

Static/seam test in the style of `src/test/tickets-sidebar-list-scoping.test.js`:

- Drive the provider with `listLocalTicketFiles { workspaceRoot: '/ws/a' }`, then `refreshTicketsDelta { workspaceRoot: '/ws/b' }`, then `listLocalTicketFiles { workspaceRoot: '/ws/b' }` through a stubbed `getCacheService` that records the root it was called with. Assert the third call resolved `/ws/b`, not `/ws/a`.
- Assert the source of `TicketsPanelProvider.ts` contains no `if (!this._cacheService)` guard, so the first-wins pin cannot be reintroduced.

## Verification Plan

1. **Unit / regression**
   - `node src/test/tickets-sync-status-workspace-binding.test.js` passes.
   - `npm test` — confirm no new failures against the known-red baseline (stash first and record the pre-existing failures before attributing any red to this change).

2. **Reproduce the bug before the fix** (proves the diagnosis, not just the patch)
   ```bash
   sqlite3 .switchboard/kanban.db \
     "SELECT slug_prefix, last_synced_at, file_path FROM imported_docs
      WHERE content_type='ticket' ORDER BY last_synced_at DESC LIMIT 5;"
   sqlite3 /Users/patrickvuleta/Documents/Gitlab/.switchboard/kanban.db \
     "SELECT slug_prefix, last_synced_at, file_path FROM imported_docs
      WHERE slug_prefix='clickup_86d3cz53f';"
   ```
   Confirm the same `slug_prefix` exists in both with different `last_synced_at`, and that the file's mtime sits between them.

3. **Manual, in an installed VSIX** (not `dist/` — testing is VSIX-only per project rules)
   - Open a window with two workspace folders, both with tickets configured against the same global save location.
   - In the Tickets sidebar select workspace A, let it load, then switch to workspace B and hit **Refetch**.
   - Every card that previously read `modified` reads `synced` after the refetch completes.
   - Re-check the DB: `last_synced_at` advanced in **B's** `kanban.db` and the badge derived from that same row.

4. **Delta cursor sanity**
   - After the first post-fix refresh in workspace B, `sqlite3 <B>/.switchboard/kanban.db "SELECT key, value FROM meta WHERE key LIKE 'last_delta_pull_%';"` shows a fresh cursor in B's DB.
   - A second **Refresh** (not Refetch) performs a delta pull and does not re-download the whole list.

5. **Single-workspace no-regression**
   - In a one-folder window, badges, refresh, refetch, and subtask enrichment behave exactly as before the change.
