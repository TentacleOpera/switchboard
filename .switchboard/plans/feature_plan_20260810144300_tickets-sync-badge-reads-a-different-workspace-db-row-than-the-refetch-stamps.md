# Tickets sync badge reads a different workspace's DB row than the refetch stamps

<!-- board-collapse-audit -->
> **REDIRECT 2026-09-04 (Board Collapse audit, decision 15).** This plan names `feature_plan_20260810144131_tickets-source-not-sticky-across-restarts.md` as a file-level dependency. That plan has been **merged into `tickets-panel-8-single-source-for-tickets-root.md` and deleted** — both fixed the same broken `restoredTabState` push and the same `persistTabState` arm from two different features.
> > 
> > The file-level contention is unchanged and still real: this plan and the merge target both edit `TicketsPanelProvider.ts`. Serialise with the merge target instead.


## Goal

Make the Tickets sidebar's sync badge read `last_synced_at` from the **same** `kanban.db` row that a refetch writes, so a full refetch from source actually clears the `modified` badge.

### Problem

A ticket in the Tickets sidebar shows `modified` and keeps showing `modified` after a full "Refetch" pull from ClickUp/Linear. The local file is byte-for-byte what the remote produced, but the badge never returns to `synced`.

### Root cause — read and write land in different databases

The badge is computed in `src/services/TicketsPanelProvider.ts:397` (`_ticketSyncStatusFromTimestamps`) as:

```ts
return mtimeMs > lastSyncedMs + 1000 ? 'modified' : 'synced';
```

`lastSyncedAt` comes from an `imported_docs` row read through `this._cacheService`. That field is a **single memoized instance** bound to whichever workspace root reached the provider first, and it is never rebound when the Tickets tab's workspace changes. Every binding site uses the same first-wins guard:

```ts
if (!this._cacheService) {
    this._cacheService = this._adapterFactories.getCacheService(workspaceRoot);
}
```

> **Superseded:** "Every one of the 8 binding sites uses the same first-wins guard (`src/services/TicketsPanelProvider.ts:349, 803, 1830, 1987, 2143, 2796, 2811, 3370`)."
> **Reason:** verified against HEAD — the count and every line number had drifted. There are **10** binding sites, plus one read-only presence check, and 38 total references to the field.
> **Replaced with:** binding sites at `:354`, `:990`, `:2040`, `:2204`, `:2397`, `:3101`, `:3116`, `:3278`, `:3715`, `:3808`. Two of them (`:2204`, `:2397`) use the variant guard `if (!this._cacheService && workspaceRoot)`. Line `:2400` is a *presence* check (`if (!this._cacheService)` → empty-result path), not a binding, and must not be converted into one. Exact inventory: `grep -c "this\._cacheService" src/services/TicketsPanelProvider.ts` → 38; `grep -c "if (!this\._cacheService" …` → 11.

`getCacheService` (`src/extension.ts:1266`) is correctly a per-root map, and `KanbanDatabase.forWorkspace(resolved)` opens **that workspace's own `.switchboard/kanban.db`**. So the first root the provider ever sees pins the panel to one database for the rest of the extension-host lifetime.

Meanwhile the *write* path is per-root correct. `refreshTicketsDelta` (`:2029`) dispatches `switchboard.importAllTasks`, which lands in `TaskViewerProvider._writeTaskDocument` and restamps through `this._getCacheService(resolvedRoot)` — a genuinely per-root lookup keyed on the *message's* `workspaceRoot`.

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

Ticket save location is **global**, not per workspace. `_getTicketDocumentDirs` (`:282`) reads `GlobalIntegrationConfigService.loadConfigSync(provider).ticketSaveLocation` — one directory shared by every workspace. So there is exactly one `.md` file per ticket, but its `imported_docs` bookkeeping is written into whichever per-workspace DB happened to be resolved at write time. One file, N rows, N different `last_synced_at` values, and the badge picks by accident.

### Two secondary defects that keep the stale row stale

1. **The 24h heal only inserts, never repairs.** `listLocalTicketFiles` (`:2181`) rescans the ticket folders when the DB is empty or the heal is older than 24h (`:2219`–`:2250`), but the backfill is guarded by `if (!exists)` — rows that already exist are never re-examined, so a stale `last_synced_at` survives every heal forever.

2. **Absolute vs relative `file_path` masks the mismatch.** `upsertImportedTicket` stores `this._ensureRelativePlanFile(filePath)` (`src/services/KanbanDatabase.ts:3446`) and `listImportedTickets` returns `this._resolveAbsolutePlanFile(row.file_path)` (`:3474`). The switchboard DB's rows were written with an **absolute** path into another workspace's tree, so they survive relativization, still pass `fs.existsSync`, and still `statSync` successfully. Had they been relative they would have resolved to a nonexistent local file and reported `local-only` — a different wrong answer, not a right one.

### Scope

This plan fixes **which row is read**. It deliberately does not change what `modified` means (mtime-vs-timestamp), nor add an escape hatch for genuinely-edited files — those are separate concerns.

## Metadata

- **Complexity:** 7
- **Tags:** bugfix, backend, database, reliability
- **Project:** Browser Switchboard

> **Superseded:** Complexity 6.
> **Reason:** the `file_path` repair cannot be done with `registerImportedTicket` as originally proposed — that path restamps `last_synced_at` and clobbers `content_hash` (see Proposed Change 2). Doing it correctly requires a **new narrow method on `KanbanDatabase`**, which is shipped state across ~4,000 installs. Adding a write path to `imported_docs` plus rewriting ten binding sites plus the two-host factory divergence is multi-file coordination on data-consistency-critical code.
> **Replaced with:** Complexity 7.

## User Review Required

None. The first post-fix refresh falling back to a full import in a previously-mispinned workspace is the accepted, correct outcome and is stated in the plan rather than left as a surprise.

## Complexity Audit

### Routine
- Replacing a memoized field with a per-root `Map` accessor. Mechanical, 10 binding sites, all in one file.
- Adding a diagnostic log line naming the resolved root and workspace id.

### Complex / Risky
- **Shipped state.** `imported_docs` ships in released versions with ~4,000 installs. This plan must not delete or rewrite rows wholesale. The heal repairs `file_path` drift and re-validates existing rows; it never drops a row, and no schema change is involved.
- **`registerImportedTicket` is not a safe repair primitive.** `upsertImportedTicket` (`KanbanDatabase.ts:3411`) does `ON CONFLICT … DO UPDATE SET … imported_at = excluded.imported_at, last_synced_at = excluded.last_synced_at, content_hash = excluded.content_hash`, with both timestamps bound to `new Date().toISOString()`. Calling it to fix a path therefore **restamps `last_synced_at` to now** — silently marking every locally-edited file as `synced`, which is the exact class of bug this plan exists to remove — and, called with `contentHash: ''`, wipes the stored hash. A `file_path`-only UPDATE is required.
- **The two hosts build cache services differently.** `src/extension.ts:1266` memoizes per resolved root **and** injects `KanbanDatabase.forWorkspace(resolved)`. `src/standalone/bootstrap.ts:787` and `:794` are `(root: string) => new PlanningPanelCacheService(root)` — a **fresh instance on every call, with no `kanbanDb` argument**. `PlanningPanelCacheService`'s constructor takes `kanbanDb?` optional (`:46`), and every DB method opens with `if (!this._kanbanDb) return [] / return;`. So in standalone the cache service is a silent no-op today and `(svc as any)._kanbanDb` is `undefined`.
- **The auto-sync engine shares the field.** Sites `:990` (auto-sync delta timer) and `:3715` (`syncAllTickets`) read `(this._cacheService as any)?._kanbanDb` for the delta cursor (`last_delta_pull_<provider>_<id>`). Rebinding per root moves those cursors into the correct DB — correct, but an install's first post-fix refresh in a previously-mispinned workspace has no cursor and falls back to a full import. That is the right behaviour (a full pull re-stamps everything) but it must be called out, not discovered.
- **The delta cursor and the ticket rows must agree.** `refreshTicketsDelta` (`:2029`) reads the cursor at `:2043`–`:2046` from one DB and the import writes rows to another today. Both must move together in the same change or the delta window is computed against the wrong history.
- **`_getWorkspaceRoot()` fallback.** `_resolveWorkspaceRoot(undefined)` (`:185`) falls back to the primary root. Sites that currently pass a possibly-empty root must keep behaving when the tab has no selection yet (`src/webview/tickets.js` deliberately does not bail on an empty `ticketsWorkspaceRoot`).

## Edge-Case & Dependency Audit

- **Empty `msg.workspaceRoot`.** The Tickets tab sends `workspaceRoot: ticketsWorkspaceRoot || undefined` before the workspace list arrives. `_resolveWorkspaceRoot` already falls back to the primary root; the accessor must accept `null`/`undefined` and use the same fallback rather than throwing.
- **Root not in the workspace folder list.** `_resolveWorkspaceRoot` returns `givenRoot` verbatim when it doesn't match a known folder (`:194`). The accessor must `path.resolve` before using it as a map key so `/a/b` and `/a/b/` share one instance, matching `getCacheService`'s own `path.resolve`.
- **Single-workspace installs.** With one workspace root the behaviour is unchanged — same DB before and after. The fix is a no-op for them, which is why this survived so long.
- **Standalone host.** The per-root map is *more* important there, not less: `bootstrap.ts` returns a new instance per call, so the current `if (!this._cacheService)` memo is the only thing preventing unbounded construction. Replacing it with a keyed map preserves that bound (one instance per root) rather than removing it. Separately, because bootstrap passes no `kanbanDb`, every cache-service read is already an empty no-op in standalone — the badge is uniformly `local-only` there. **This plan does not fix that**; it must simply not make it worse, and the new accessor must tolerate `_kanbanDb === undefined` on every path (it is read via `(svc as any)?._kanbanDb` at `:993`, `:2043`, `:2209`, `:3718`, all already optional-chained except `:2209`, which sits behind an `if (this._cacheService)` guard).
- **`_getEffectiveWorkspaceId` throws.** It raises when a DB has no `workspace_id` (`src/services/PlanningPanelCacheService.ts:54`). Site `:2212` calls it inside a try; the accessor must not introduce a new unguarded call.
- **Rows for a ticket that was re-titled remotely.** The filename is slugified from the title, so a rename writes a new path and `_removeOrphanTicketFiles` deletes the old file. A row whose `file_path` no longer exists is rename drift, not a missing ticket — the heal should re-point it via `_findTicketFilePath` (`:352`) rather than leaving it to report `local-only`.
- **Concurrency.** In the extension host, `PlanningPanelCacheService` instances are already shared per root via `extension.ts`'s own map, so the panel-side map caches the same instance rather than creating a second DB handle. In standalone there is no upstream map, so the panel-side map becomes the sharing point.
- **`sql.js` heap.** Binding a second workspace's DB in the same host loads another `sql.js` database into WASM memory. That already happens (`KanbanDatabase.forWorkspace` is called by the write path today), so the fix does not add a new DB — it stops the panel from being the odd one out. Worth watching: WASM heap exhaustion in this codebase surfaces as a bogus "disk I/O error" across *all* DBs, not as an allocation failure, so a report of that shape after this change is a memory symptom, not corruption.

**Race conditions.** None introduced: the map is populated synchronously inside a single-threaded handler, and duplicate construction for the same key is impossible because the `get` and `set` are adjacent.

**Security.** None. No new input reaches SQL; the new UPDATE is parameterised like every other statement in `KanbanDatabase`.

**Side effects.** The `file_path` repair rewrites rows in shipped state. Bounded to: one column, only when the recorded path does not exist on disk and a scanned file for the same `slug_prefix` does. `last_synced_at`, `content_hash`, `imported_at` and `url` are untouched.

**Dependencies & conflicts:** `src/services/TicketsPanelProvider.ts`, one new method on `src/services/KanbanDatabase.ts` + its `PlanningPanelCacheService` passthrough, and one new regression test. No schema migration, no webview change, no verb-signature change — so no `verbSchemas.ts` entry and no movement in the `Tickets` return-contract ratchet ceiling.

## Dependencies

- `feature_plan_20260810144131_tickets-source-not-sticky-across-restarts.md` — **file-level only.** Both edit `src/services/TicketsPanelProvider.ts`, so under the PRD's one-stream-per-provider-file rule they serialise. Neither blocks the other functionally: this plan touches the cache-service binding sites and the heal loop; that one touches `persistTabState` (`:1332`) and `fetchRoots` (`:1338`). No shared symbols.
- No session dependencies (`sess_…`) — none recorded for this work.

## Adversarial Synthesis

**Risk summary.** The rebinding itself is mechanical; the danger is concentrated in the repair path, where the obvious primitive (`registerImportedTicket`) silently restamps `last_synced_at` and would convert this bug-fix into a data-integrity bug across ~4,000 installs — hence the new `file_path`-only UPDATE. The second risk is the two hosts diverging: the extension memoizes and injects a DB, standalone does neither, so any reasoning about "the factory already shares instances" is only half true and the accessor must own the sharing. The third is the delta cursor and the ticket rows moving apart; they must be converted in the same change or the delta window is computed against the wrong history.

## Proposed Changes

### 1. `src/services/TicketsPanelProvider.ts` — per-root cache-service resolution

Replace the single memo field with a keyed map plus an accessor.

```ts
// BEFORE (line 64)
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
 *
 * This map is also the only instance-sharing point in the standalone host:
 * bootstrap.ts's getCacheService constructs a NEW PlanningPanelCacheService on
 * every call (and passes no kanbanDb), unlike extension.ts, which memoizes per
 * resolved root and injects KanbanDatabase.forWorkspace(root).
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

Rewrite all 10 binding sites to call the accessor with the root already resolved for that handler. Pattern, applied at `:354`, `:990`, `:2040`, `:2204`, `:2397`, `:3101`, `:3116`, `:3278`, `:3715`, `:3808`:

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

The presence check at `:2400` (`if (!this._cacheService) { … }` guarding an empty-result path) becomes `if (!cacheService) { … }` — it is a guard, not a binding, and must not gain a `getCacheService` call.

Delete the `_cacheService` field once every reader is converted — leaving it as a shim invites a future call site to reintroduce the pin.

Site `:2040` matters most: the delta cursor (`last_delta_pull_clickup_<listId>` / `last_delta_pull_linear_<projectId>`, built at `:2045`–`:2046`) is read from `(this._cacheService as any)?._kanbanDb` and written back later in the same arm. Both must use the per-root service so the cursor lives in the same DB as the rows it describes. The same applies to the `syncAllTickets` cursor at `:3715`–`:3722`.

### 2. `src/services/KanbanDatabase.ts` — a `file_path`-only repair primitive

> **Superseded:** the heal repair was to call `this._cacheService.registerImportedTicket(provider, t.id, exists.docName, exists.slugPrefix, t.filePath, '', undefined, exists.url)`, under the comment "Never touches `last_synced_at` for rows whose file is still where the row says it is."
> **Reason:** that comment is false against the actual SQL. `registerImportedTicket` → `upsertImportedTicket` (`KanbanDatabase.ts:3411`) binds `const now = new Date().toISOString()` into **both** `imported_at` and `last_synced_at`, and its `ON CONFLICT … DO UPDATE SET` assigns `last_synced_at = excluded.last_synced_at` and `content_hash = excluded.content_hash`. Repairing a path through it would restamp the sync baseline to now — marking every locally-edited file `synced` — and, with `contentHash: ''`, blank the stored hash. That is a worse bug than the one being fixed, on shipped state.
> **Replaced with:** a new narrow, additive method that writes one column.

```ts
/**
 * Re-point a ticket row at a moved file. Rename drift only: the filename is
 * slugified from the title, so a remote re-title writes a new path and the old
 * file is deleted. Deliberately writes file_path and NOTHING else —
 * upsertImportedTicket restamps last_synced_at and content_hash, which would
 * silently mark locally-edited files as synced.
 */
public async repointImportedTicketFilePath(
    workspaceId: string,
    slugPrefix: string,
    newFilePath: string
): Promise<void> {
    if (!(await this.ensureReady()) || !this._db) return;
    this._db.run(
        `UPDATE imported_docs SET file_path = ?
          WHERE workspace_id = ? AND slug_prefix = ? AND content_type = 'ticket'`,
        [this._ensureRelativePlanFile(newFilePath), workspaceId, slugPrefix]
    );
    // persist through whatever mechanism the surrounding writes already use
}
```

Add the matching passthrough on `PlanningPanelCacheService`, mirroring `registerImportedTicket`'s `_getEffectiveWorkspaceId` + `if (!this._kanbanDb) return;` shape so it is a no-op in standalone rather than a throw.

`_ensureRelativePlanFile` is applied on the way in, matching `upsertImportedTicket` — a repair that stored an absolute path would recreate the second defect described in the root cause.

### 3. `src/services/TicketsPanelProvider.ts` — make the 24h heal repair, not only insert

In `listLocalTicketFiles`, extend the backfill loop (`:2226`–`:2243`) so existing rows are re-pointed when their recorded path has drifted:

```ts
for (const t of scannedTickets) {
    const exists = dbTickets.find((dbT: any) => dbT.slugPrefix === `${provider}_${t.id}`);
    if (!exists) {
        await cacheService.registerImportedTicket(/* … unchanged … */);
        continue;
    }
    // Rename drift: the filename is slugified from the title, so a remote
    // re-title writes a new path and _removeOrphanTicketFiles deletes the old
    // one. A row pointing at a file that no longer exists is drift, not a
    // missing ticket — re-point it. file_path ONLY: last_synced_at is the sync
    // baseline and re-stamping it would silently mark local edits synced.
    if (exists.filePath !== t.filePath && !fs.existsSync(exists.filePath)) {
        await cacheService.repointImportedTicketFilePath(exists.slugPrefix, t.filePath);
    }
}
```

The `!fs.existsSync(exists.filePath)` condition is load-bearing: a row whose file is still present is not drift, and re-pointing it would move bookkeeping off a file the user may have edited.

### 4. `src/services/TicketsPanelProvider.ts` — one diagnostic line

In `listLocalTicketFiles`, after resolving the service, log which DB answered. This class of bug is invisible today because every surface reports plausible-looking data:

```ts
console.log(
    `[TicketsPanelProvider] listLocalTicketFiles root=${workspaceRoot} ` +
    `wsId=${effectiveWsId} rows=${dbTickets.length} provider=${provider}`
);
```

### 5. `src/test/tickets-sync-status-workspace-binding.test.js` — new regression test

Static/seam test in the style of `src/test/tickets-sidebar-list-scoping.test.js`:

- Drive the provider with `listLocalTicketFiles { workspaceRoot: '/ws/a' }`, then `refreshTicketsDelta { workspaceRoot: '/ws/b' }`, then `listLocalTicketFiles { workspaceRoot: '/ws/b' }` through a stubbed `getCacheService` that records the root it was called with. Assert the third call resolved `/ws/b`, not `/ws/a`.
- Assert the source of `TicketsPanelProvider.ts` contains no `if (!this._cacheService)` guard and no `this._cacheService` field, so the first-wins pin cannot be reintroduced.
- Assert the heal's repair branch calls `repointImportedTicketFilePath` and **not** `registerImportedTicket` — the substitution that would restamp `last_synced_at`.
- Assert `repointImportedTicketFilePath`'s SQL body contains no `last_synced_at` and no `content_hash`.

## Verification Plan

### Automated Tests

1. `node src/test/tickets-sync-status-workspace-binding.test.js` passes.
2. `npm test` — confirm no new failures against the known-red baseline (stash first and record the pre-existing failures before attributing any red to this change).

### Manual

3. **Reproduce the bug before the fix** (proves the diagnosis, not just the patch)
   ```bash
   sqlite3 .switchboard/kanban.db \
     "SELECT slug_prefix, last_synced_at, file_path FROM imported_docs
      WHERE content_type='ticket' ORDER BY last_synced_at DESC LIMIT 5;"
   sqlite3 /Users/patrickvuleta/Documents/Gitlab/.switchboard/kanban.db \
     "SELECT slug_prefix, last_synced_at, file_path FROM imported_docs
      WHERE slug_prefix='clickup_86d3cz53f';"
   ```
   Confirm the same `slug_prefix` exists in both with different `last_synced_at`, and that the file's mtime sits between them.

4. **Manual, in an installed VSIX** (not `dist/` — testing is VSIX-only per project rules)
   - Open a window with two workspace folders, both with tickets configured against the same global save location.
   - In the Tickets sidebar select workspace A, let it load, then switch to workspace B and hit **Refetch**.
   - Every card that previously read `modified` reads `synced` after the refetch completes.
   - Re-check the DB: `last_synced_at` advanced in **B's** `kanban.db` and the badge derived from that same row.

5. **The repair must not restamp.** Before the heal, note `last_synced_at` for a drifted row. Trigger the heal (empty the throttle key or wait out the 24h window), then confirm `file_path` changed and `last_synced_at`, `content_hash` and `imported_at` did **not**:
   ```bash
   sqlite3 <root>/.switchboard/kanban.db \
     "SELECT slug_prefix, file_path, last_synced_at, content_hash, imported_at
        FROM imported_docs WHERE slug_prefix='clickup_<id>';"
   ```
   A locally-edited file must still read `modified` after the repair.

6. **Delta cursor sanity**
   - After the first post-fix refresh in workspace B, `sqlite3 <B>/.switchboard/kanban.db "SELECT key, value FROM meta WHERE key LIKE 'last_delta_pull_%';"` shows a fresh cursor in B's DB.
   - A second **Refresh** (not Refetch) performs a delta pull and does not re-download the whole list.

7. **Single-workspace no-regression**
   - In a one-folder window, badges, refresh, refetch, and subtask enrichment behave exactly as before the change.

8. **Standalone no-regression.** In `npx switchboard`, confirm the Tickets sidebar still lists tickets and does not throw. The cache service there has no `kanbanDb`, so every DB read stays an empty no-op and badges stay `local-only` — unchanged from today, and explicitly out of this plan's scope.

---

**Recommendation:** Complexity 7 → **Send to Lead Coder**. Serialise with `feature_plan_20260810144131` (same provider file), either order.
