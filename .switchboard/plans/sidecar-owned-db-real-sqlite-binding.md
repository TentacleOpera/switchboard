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

**2. An entire cache-eviction subsystem exists solely to survive this.** `_residentDbBudgetBytes = 500 * 1024 * 1024` (`:1049`); `_summedResidentDbBytes()` sums `PRAGMA page_count x page_size` across `_instances`, `_instancesByDbPath` (`:1017-1018`) and `_archiveInstances`; `startEvictionSweep()` LRU-evicts cold archives first then idle hot instances (`:1832-1849`, `guard++ < 32`); `_isActiveRoot()` (`:1851`) exempts the focused workspace so the board the user is looking at is not closed underneath them; `_closeDb()` (`:1736`) exists to unlink MEMFS buffers from the shared WASM heap and is documented as fixing "the mechanism-6 leak". The schema is metadata-only today — `imported_docs` stores `content_hash` and `file_path`, and `plans` stores `plan_file` with no body column — so this cost is structural to the engine, not driven by data volume.

**That is a load-bearing property, and it has an expiry date.** The control-plane scaffold plan moves protocol and skill *bodies* into the store, which is fine — roughly 744K of text. But `.switchboard/plans/` is 43M across 1,984 files at ~22KB average, and if anyone later reasons that plan bodies belong in the store too, `sql.js` would hold a 43M WASM image and allocate ~129M of transient copies on **every write** (`export()` plus `Buffer.from()`). So this plan gets more urgent as the store takes on content, not less. Hence the boundary rule below.

**3. Two in-memory images of the same file silently clobber each other.** The diagnostic comment at `:1050` states it directly: it exists to determine "whether the KanbanProvider and the GlobalPlanWatcherService are operating on the SAME in-memory sql.js instance. If they differ for the same on-disk DB, a stale-snapshot `_persist()` can silently overwrite an `is_feature=1` write". Concurrency control is only an mtime baseline (`_loadedMtime`, `:1620`) plus `_reloadIfStale()` — there is no lock and no row-level merge, so the loser of a race loses its whole database, not one row.

The same mechanism produces the worst user-visible outage. `SCHEMA_WORKTREE_COLUMN_DEFS` (`:953`) exists because, per its own comment, "a DB stamped at/after V42 whose columns never actually landed (stale sql.js image restored from a .tmp/backup, a partial persist, or a table recreated by an early V24/V25 path) is NEVER healed" — the version-gated ALTERs do not re-run, `getWorktrees()` throws `no such column`, and `refreshWithData` dies before `updateBoard` is posted, giving a blank board.

### Root Cause

Two root causes, and they compound:

1. **The engine has no memory or durability model.** `sql.js` cannot do incremental writes. Every mutation is export-the-world.
2. **There is no single owner.** 62 files import `KanbanDatabase`, with 158 `getInstance`/`forWorkspace`/`new` sites. Multiple images of one file can exist concurrently, and with whole-file export that is a data-loss primitive rather than a performance nuisance.

`better-sqlite3` was previously rejected on compatibility grounds. That rejection was correct for the *placement*, not the library: it is a native module compiled against the Electron ABI, and the VS Code extension host is Electron. `node:sqlite` avoids compilation entirely but requires Node >= 22.5, while `engines.vscode` is `^1.93.0` — a VS Code that ships Node 20. Both objections dissolve if the DB owner is not inside Electron: `engines.node` is already `>=22.0.0` for the standalone host, which runs on the user's own Node, outside the extension host.

### Storage boundary rule (applies programme-wide)

**The database may hold control-plane definitions as bodies. It must never become the sole home of a user artifact.**

Not an aesthetic preference. The global-database and backup plans both rest on "the DB is a derived index over committed markdown, so plan identity and relationships survive a total loss by re-ingesting the repo." Move plan or feature bodies into the store and that recovery floor disappears, and the backup plan's risk calculus changes with it. Control-plane definitions are safe because they are regenerable from the extension bundle; user artifacts are not regenerable from anything.

### Non-goals

- Changing the SQL dialect, the schema, or the DB file location. File format is unchanged; `.switchboard/kanban.db` stays where it is in this plan.
- Consolidating per-workspace databases into one (separate plan).
- Adding a remote/cloud backend (separate plan).
- Fixing the `updateFeatureStatus` logic bug (separate plan — it survives this change).

## Metadata

**Complexity:** 10
**Tags:** database, backend, refactor, performance, reliability, infrastructure

## User Review Required

Yes — two decisions:

1. **Binding choice.** Three candidates: `node:sqlite` (built into Node — no native module at all), `better-sqlite3` (synchronous, closest to existing call shapes, node-gyp prebuilds per ABI), and `@libsql/client` (N-API prebuilds, async-first, and the same client can later speak a remote protocol).

   **Recommendation: `node:sqlite`.** It is the only candidate with *no native dependency*, so there is no per-platform prebuild that can be missing at install time. That matters more here than anywhere else in the codebase: `node-pty` is already a native dependency, but it is guarded by `isPtyAvailable()` and its absence degrades to "no terminals". **A missing database binding has no graceful degradation — it means no product.** So the platform-coverage bar for this dependency is strictly higher than anything shipped natively so far, and eliminating the native module outright beats managing a matrix.

   Cost: a Node >= 22.5 floor for the sidecar (`engines.node` is already `>=22.0.0`), and the API was experimental through 22.x before stabilising in 24.

   **Fallback if that floor is unacceptable:** `better-sqlite3`, accepting a *complete* prebuild matrix — Windows x64 and ARM64, macOS x64 and arm64, Linux glibc and musl — with no `isPtyAvailable`-style escape hatch to hide a gap.

   **Explicitly NOT `@libsql/client`.** An earlier revision of this plan recommended it, reasoning that adopting it here would collapse the pluggable-backend plan into a config flip. That reasoning was wrong, and the error is worth recording so it is not repeated: the *seam* is what makes a future remote backend cheap — that is the entire function of a seam — so prepaying for it in the foundation is exactly what having one makes unnecessary. libSQL entered this programme to answer a hypothetical about a cloud database, and was then allowed to back-propagate into the most load-bearing plan in the set. The four drivers actually stated — stability, memory, storage location, one global store — are served by getting off `sql.js` onto *any* real binding. None of them is served by libSQL specifically. Pick the boring option here; keep libSQL as the right answer for the remote plan if that plan is ever scheduled.

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
- **The cursor rewrite is the dominant cost, and it is unavoidable with every candidate.** Measured touchpoints in `KanbanDatabase.ts`: `.prepare(` 146, `.exec(` 156, `_db.run(` 150, `.free()` 117, `.step()` 109, `.getAsObject(` 102 — roughly 780, not the ~460 an earlier revision of this plan claimed. The `prepare` / `bind` / `step` / `getAsObject` / `free` triple is sql.js's **cursor** idiom:

  ```js
  const stmt = this._db.prepare('SELECT value FROM config WHERE key = ? LIMIT 1', [key]);
  try { if (!stmt.step()) return null; return String(stmt.getAsObject().value ?? ''); }
  finally { stmt.free(); }
  ```

  No other binding has that shape — `node:sqlite` and `@libsql/client` return batched rows, `better-sqlite3` offers `.get()`/`.all()`/`.iterate()`. So ~330 sites need their **loop shape** rewritten, not an `await` added. This cost is identical across all three candidates, so it is not a differentiator — but it is the real size of this plan, and it is why the complexity score is 10 rather than 9.

  **Mitigation worth evaluating first:** a sql.js-shaped cursor shim — a `prepare()` that returns an object exposing `.step()` / `.getAsObject()` / `.free()` backed by a pre-materialised row array. That leaves ~330 sites untouched and makes the migration nearly mechanical. The risk is that it materialises result sets that currently stream lazily; only one `SELECT * FROM plans` lacks a `LIMIT`, so the exposure is small and auditable. Do not let the shim become permanent — it re-imports the O(result-set) memory shape this plan exists to remove.
- **Async conversion is a much smaller problem than the cursor rewrite.** 217 public methods on `KanbanDatabase` are *already* `public async`. Exactly three sync methods touch `_db`: `dispose()`, `getConfigSync()`, and `getProjectConfigJsonSync()`. `getConfigSync` is already documented as best-effort — `KanbanProvider.ts:515` records that it "returns null while the DB is still loading at activation", and the constructor deliberately routes around it. `getProjectConfigJsonSync` is the genuine blocker, called at `KanbanProvider.ts:695` and `:775` inside tiered config resolution; those callers need either a cache or an async conversion.
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

1. **`src/services/sqliteDriver.ts` (new).** A thin driver interface — `run`, `get`, `all`, `prepare`, `transaction`, `close`, `lastInsertRowid` — with a `node:sqlite` implementation. Bumps `_dataVersion` on every mutating call. The interface is the seam the (unscheduled) pluggable-backend plan would implement a second time — defining it here is worth doing for testability alone, independently of whether a second backend is ever built.
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
- **Dialect parity:** assert the 18 `rowid` sites, `last_insert_rowid()` (`:4094`), the 6 `PRAGMA` uses, 13 `AUTOINCREMENT` columns and 15 `datetime('now')` calls behave identically under the new binding as under sql.js. All three candidates are SQLite, so this should be a formality — run it anyway, because "should be" is the assumption the whole binding choice rests on, and `node:sqlite`'s API surface is narrower than sql.js's.
- **Existing suite:** the ~220-file test suite must pass, with the eviction/persist tests deleted rather than skipped.

## Outstanding Questions

- How large is the async conversion inside the sidecar, measured rather than estimated? This is the deciding number for the binding choice; scope it in the first day of work and report before proceeding.
- Does the extension host ever need synchronous DB reads that cannot become async? If so, which call sites, and can they be served from a cached snapshot instead?
- Should the sidecar be shared across all VS Code windows on the machine, or one per window? (One per machine is required by the global-DB plan; confirm it does not break per-window terminal ownership.)
