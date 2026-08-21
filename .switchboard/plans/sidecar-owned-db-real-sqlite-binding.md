# Move the database behind a single sidecar owner and replace sql.js with a real SQLite binding

## Goal

Make one process the sole owner of `kanban.db`, and have it use a real SQLite binding (page-level writes, WAL) instead of `sql.js` (whole-database-in-memory, whole-file export on every write). Every other client — the VS Code extension host, the browser host, agent CLIs — reaches the DB through the existing `LocalApiServer` HTTP surface rather than opening its own image.

This is the prerequisite for the global-single-database work. It must land first.

### Problem Analysis

`sql.js` is WASM SQLite with no page cache: the entire database file lives in the shared WASM MEMFS heap, and a write is not a statement against a file — it is a full-image replacement. Three consequences, all currently paid:

**1. Memory is O(database), not O(working set), and spikes to ~3x on every write.** `_doPersist()` (`src/services/KanbanDatabase.ts:9511`):

```js
const data = this._db.export();                            // full copy #2, on the JS heap
await fs.promises.writeFile(tmpPath, Buffer.from(data));   // full copy #3 — Buffer.from copies
await fs.promises.rename(tmpPath, this._dbPath);
```

So a persist transiently holds the WASM image plus two full JS-heap copies. `PERSIST_DEBOUNCE_MS = 300` (`:1643`) means a burst of card moves repeats that spike.

**2. An entire cache-eviction subsystem exists solely to survive this.** `_residentDbBudgetBytes = 500 * 1024 * 1024` (`:1049`); `_summedResidentDbBytes()` sums `PRAGMA page_count x page_size` across `_instances`, `_instancesByDbPath` (`:1017-1018`) and `_archiveInstances`; `startEvictionSweep()` LRU-evicts cold archives first then idle hot instances (`:1832-1849`, `guard++ < 32`); `_isActiveRoot()` (`:1851`) exempts the focused workspace so the board the user is looking at is not closed underneath them; `_closeDb()` (`:1736`) exists to unlink MEMFS buffers from the shared WASM heap and is documented as fixing "the mechanism-6 leak". The schema is metadata-only — `imported_docs` stores `content_hash` and `file_path`, not content — so this cost is structural to the engine, not driven by data volume.

**3. Two in-memory images of the same file silently clobber each other.** The diagnostic comment at `:1050` states it directly: it exists to determine "whether the KanbanProvider and the GlobalPlanWatcherService are operating on the SAME in-memory sql.js instance. If they differ for the same on-disk DB, a stale-snapshot `_persist()` can silently overwrite an `is_feature=1` write". Concurrency control is only an mtime baseline (`_loadedMtime`, `:1620`) plus `_reloadIfStale()` — there is no lock and no row-level merge, so the loser of a race loses its whole database, not one row.

The same mechanism produces the worst user-visible outage. `SCHEMA_WORKTREE_COLUMN_DEFS` (`:953`) exists because, per its own comment, "a DB stamped at/after V42 whose columns never actually landed (stale sql.js image restored from a .tmp/backup, a partial persist, or a table recreated by an early V24/V25 path) is NEVER healed" — the version-gated ALTERs do not re-run, `getWorktrees()` throws `no such column`, and `refreshWithData` dies before `updateBoard` is posted, giving a blank board.

### Root Cause

Two root causes, and they compound:

1. **The engine has no memory or durability model.** `sql.js` cannot do incremental writes. Every mutation is export-the-world.
2. **There is no single owner.** 62 files import `KanbanDatabase`, with 158 `getInstance`/`forWorkspace`/`new` sites. Multiple images of one file can exist concurrently, and with whole-file export that is a data-loss primitive rather than a performance nuisance.

`better-sqlite3` was previously rejected on compatibility grounds. That rejection was correct for the *placement*, not the library: it is a native module compiled against the Electron ABI, and the VS Code extension host is Electron. `node:sqlite` avoids compilation entirely but requires Node >= 22.5, while `engines.vscode` is `^1.93.0` — a VS Code that ships Node 20. Both objections dissolve if the DB owner is not inside Electron: `engines.node` is already `>=22.0.0` for the standalone host, which runs on the user's own Node, outside the extension host.

### Non-goals

- Changing the SQL dialect, the schema, or the DB file location. File format is unchanged; `.switchboard/kanban.db` stays where it is in this plan.
- Consolidating per-workspace databases into one (separate plan).
- Adding a remote/cloud backend (separate plan).
- Fixing the `updateFeatureStatus` logic bug (separate plan — it survives this change).

## Metadata

**Complexity:** 9
**Tags:** database, backend, refactor, performance, reliability, infrastructure

## User Review Required

Yes — two decisions:

1. **Binding choice.** Three candidates: `better-sqlite3` (synchronous, closest to the existing call shapes, but node-gyp/NAN prebuilds per ABI), `node:sqlite` (no compilation, but needs Node >= 22.5), and `@libsql/client` in local-file mode (N-API with prebuilt per-platform binaries, so no compile step; async-first API).

   **Recommendation: `@libsql/client` in local-file mode (`file:kanban.db`).** libSQL *is* SQLite — same file format, same dialect, same semantics — so every SQLite-ism in this codebase survives untouched: the 18 `rowid` sites, `last_insert_rowid()` at `:4094`, the 6 `PRAGMA` uses, 13 `AUTOINCREMENT`, 15 `datetime('now')`.

   The decisive argument is programme-level rather than local. The pluggable-backend plan needs a remote SQLite option, and `@libsql/client` selects its mode by URL: `file:kanban.db` is pure local with no network, the same file plus a `syncUrl` is an embedded replica, and `libsql://…` is pure remote. Adopting it here means that plan stops being "implement a second backend behind the seam" and becomes "add a `syncUrl` and a config toggle". Choosing `better-sqlite3` instead puts two SQLite bindings in the tree and requires the second implementation to be written and separately verified.

   The cost is that `@libsql/client` is async-first while the ~460 call sites are written synchronously. That cost is largely already on this plan's bill: routing extension-host reads across the sidecar boundary makes those call sites async regardless (see Complex / Risky below). What it does add is that the *sidecar's own* in-process reads become async too, where `better-sqlite3` would have kept them synchronous.

   Reject this recommendation if the async conversion inside the sidecar proves to be the dominant cost of the plan — in which case `better-sqlite3` here plus a real second implementation in the pluggable-backend plan is the fallback, and the two-binding duplication is accepted deliberately.
2. **Extension-host fallback.** When the sidecar is not running, does the extension host (a) start it, (b) degrade to read-only from a snapshot, or (c) fall back to opening sql.js directly? Recommendation: (a), with (b) as the failure path. (c) reintroduces the two-image clobber and should be rejected.

## Complexity Audit

### Routine

- Adding the binding dependency and a `SqliteDriver` wrapper exposing `run`/`all`/`get`/`prepare`/`transaction` over the ~460 existing call shapes.
- Deleting `_doPersist()`, `_persist()`'s debounce arming, `flushPersist()`, `_dirty`, and `_persistDebounceTimer` — writes become synchronous statements.
- Deleting `_residentDbBudgetBytes`, `_summedResidentDbBytes()`, `_residentDbBytes()`, `startEvictionSweep()`, `_evictKey()`, `_evictArchiveKey()`, `_isActiveRoot()`, `setActiveWorkspaceRoot()` and their tests.
- Deleting `_loadedMtime`, `_lastLoadedMtimes`, `_reloadIfStale()` — a single owner with WAL has no stale-image problem.
- Adding `PRAGMA journal_mode=WAL`, `PRAGMA synchronous=NORMAL`, `PRAGMA busy_timeout`, `PRAGMA foreign_keys` at open.
- Adding `.switchboard/**/*.db-shm` / `-wal` to `.gitignore` — already present (lines 69-70), so no change needed; verify only.

### Complex / Risky

- **`_dataVersion` must survive.** `KanbanProvider` short-circuits no-op refreshes in O(1) off `getDataVersion()`, and it is currently bumped inside `_persist()`. With `_persist()` gone, every mutating method must bump it, or the board goes stale. This is the single easiest thing to get wrong: a missed bump is a silently stale board, and there are ~460 call sites to audit. Mitigation: bump inside the driver's `run`/`transaction` wrapper, not at call sites.
- **`last_insert_rowid()` semantics.** `:4094` does `SELECT last_insert_rowid() as id` as a separate prepared statement. That is connection-scoped and safe under sql.js's single connection; under a real binding with a transaction wrapper it must become the driver's `lastInsertRowid` from the same statement, or it can return another statement's id.
- **Transaction semantics change.** The comment at `:2312` notes existing care around "BEGIN/COMMIT on sql.js's single shared connection". A real binding has real nested-transaction rules; every existing BEGIN/COMMIT block needs auditing against `SAVEPOINT` behaviour.
- **Routing extension-host reads through HTTP.** 62 importing files currently call `KanbanDatabase` synchronously in-process. Making those calls cross a process boundary makes them async. Any synchronous call site in a `postMessage` arm becomes an await, and the verb return-contract ratchet (`scripts/check-verb-return-contract.js`) must still pass.
- **Sidecar lifecycle.** Start, health-check, crash-restart, and version-match between extension and sidecar. A sidecar running older code than the extension must refuse to serve rather than silently mis-migrate.
- **Async conversion inside the sidecar.** With `@libsql/client`, the ~460 call sites become async even for the sidecar's own in-process reads, not only for the extension host's cross-process ones. Most are already `async` methods on `KanbanDatabase` and only need `await` added at the driver call, but any synchronous helper reached from a hot loop (the dedupe SQL at `:607-610` and `:7490-7503`, `_residentDbBytes`'s `PRAGMA page_count`) needs restructuring rather than a mechanical `await`. Scope this before committing to the binding — it is the one measurement that could flip the decision back to `better-sqlite3`.
- **Latency.** The ~460 call sites assume microsecond in-memory reads. Over loopback HTTP, chatty N+1 patterns (e.g. `getWorktrees()` inside a board refresh) become visible. Read paths that run per-card must be batched before this ships.

## Edge-Case & Dependency Audit

**Race conditions**
- Sidecar not yet up when the extension activates: reads must queue or fail soft, never fall through to opening a second image.
- Two sidecars for the same DB path (user runs `npx` while the extension's sidecar is live): must be prevented by a lock file or a port/PID handshake, not by hoping.
- WAL checkpointing while an agent CLI reads: correct by construction with WAL, but `busy_timeout` must be set or writers will see `SQLITE_BUSY`.

**Security**
- The sidecar's HTTP surface is the DB. It already binds loopback; confirm no interface widening, and that `verbSchemas.ts` validation covers every newly-exposed DB verb.

**Side effects**
- `BoardSnapshotPublisher` / `_writeKanbanStateBackup` are currently folded onto the coalesced persist tick. With coalescing gone they need their own debounce, or every card move writes a snapshot.
- `ArchiveManager` / `AutoArchiveService` open DuckDB archive instances through `_archiveInstances`. Removing the eviction sweep must not orphan those handles.

**Migration**
- None for user data: file format and location are unchanged, and WAL is created on first open. Opening an existing `kanban.db` with a real binding is a no-op.
- Reverting to sql.js after WAL is enabled requires a clean checkpoint. Ship a `PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE` downgrade path so a rollback release can still read the file.

## Dependencies

- None upstream. This plan is the base of the storage program.
- Blocks: the global-single-database plan, the pluggable-backend plan, and (partially) the single-instance/clobber plan.

## Adversarial Synthesis

**"The DB is small — why does the engine matter?"** Because the costs are structural, not volumetric: the 500 MB budget, the eviction sweep, and six enumerated leak mechanisms all exist for a metadata-only schema. Small data does not make export-the-world cheap; it makes it absurd.

**"This is a big change for a rare bug."** The clobber is not rare enough to have avoided a dedicated investigation doc, and the blank-board failure has a permanent workaround shim in the schema layer. More importantly, the global-DB plan makes concurrent writes the normal case rather than the exception, and under whole-file export that turns a per-workspace annoyance into total loss.

**"Just enforce one instance and keep sql.js."** That fixes the clobber and nothing else: memory stays O(database), the 3x write spike stays, the eviction subsystem stays, and the global-DB plan stays unsafe. Worth doing as a stopgap (separate plan), not as the answer.

## Proposed Changes

1. **`src/services/sqliteDriver.ts` (new).** A thin driver interface — `run`, `get`, `all`, `prepare`, `transaction`, `close`, `lastInsertRowid` — with a `@libsql/client` local-file implementation (`file:kanban.db`). Bumps `_dataVersion` on every mutating call. The interface is deliberately the same one the pluggable-backend plan reuses, and the local/replica/remote distinction is a URL, not a second implementation.
2. **`src/services/KanbanDatabase.ts`.** Replace the sql.js handle with the driver. Delete `_doPersist`, `_persist` debounce, `flushPersist`, `_dirty`, `_persistDebounceTimer`, `_loadedMtime`, `_reloadIfStale`, and the whole eviction/budget subsystem. Set WAL pragmas at open.
3. **`src/standalone/bootstrap.ts`.** The sidecar becomes the sole DB owner; construct the driver here.
4. **`src/services/LocalApiServer.ts`.** Expose the DB verbs the extension host now needs, validated through `verbSchemas.ts`.
5. **Extension host.** Replace direct `KanbanDatabase` construction with an HTTP client implementing the same 222-method surface, so the 62 importing files change import target rather than call shape wherever possible.
6. **`src/services/hostSeams.ts`.** Add the sidecar-client seam so neither host reaches the DB directly.

### Migration

No user-data migration. Ship-order safety: the sidecar must refuse to serve an extension whose schema head is newer than its own, with a clear "restart Switchboard" message rather than a partial migration.

## Verification Plan

- **Memory:** open a board with a populated DB, drive 200 card moves, sample RSS. Expect flat, single-digit MB growth; today expect repeated ~3x-database spikes. Assert `_residentDbBudgetBytes` and the eviction sweep are gone (grep-level regression test).
- **Clobber:** the existing reproduction from `docs/investigation-epic-is_epic-clobber.md` candidate ❷ — drive a plan-watcher import concurrently with a `createFeature` and assert `is_feature` survives. Must pass without the single-instance fix.
- **Blank board:** construct a DB stamped at V42 with the V34/V42 worktree columns dropped, open it, assert the board still renders (the `SCHEMA_WORKTREE_COLUMN_DEFS` path) and that a real binding plus WAL prevents the state from arising in the first place.
- **Data version:** a regression test asserting every mutating public method bumps `getDataVersion()`. Generated from the method list so it cannot drift.
- **Concurrency:** two sidecar clients writing different plans in a loop for 60s; assert no lost writes and no `SQLITE_BUSY` escapes.
- **Rollback:** WAL-enabled DB, run the downgrade pragmas, assert sql.js can still open it.
- **Dialect parity:** assert the 18 `rowid` sites, `last_insert_rowid()` (`:4094`), the 6 `PRAGMA` uses, 13 `AUTOINCREMENT` columns and 15 `datetime('now')` calls behave identically under the new binding as under sql.js. libSQL being SQLite means this should be a formality — run it anyway, because "should be" is the assumption the whole binding choice rests on.
- **Existing suite:** the ~220-file test suite must pass, with the eviction/persist tests deleted rather than skipped.

## Outstanding Questions

- How large is the async conversion inside the sidecar, measured rather than estimated? This is the deciding number for the binding choice; scope it in the first day of work and report before proceeding.
- Does the extension host ever need synchronous DB reads that cannot become async? If so, which call sites, and can they be served from a cached snapshot instead?
- Should the sidecar be shared across all VS Code windows on the machine, or one per window? (One per machine is required by the global-DB plan; confirm it does not break per-window terminal ownership.)
