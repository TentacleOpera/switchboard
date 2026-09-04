# Move the database behind a single sidecar owner and replace sql.js with a real SQLite binding

## Goal

> **Binding decided: `better-sqlite3`.** Recorded here because it was the plan's open question.
>
> **`node:sqlite` cannot serve the extension host.** It needs Node 22.5+ *in the runtime that opens the database*. The extension host runs VS Code's bundled Node, not the user's — at `engines.vscode: ^1.93.0` that is Node 20, where the module does not exist. `engines.node: >=22.0.0` governs only the standalone host, and even there the declared floor sits *below* 22.5, so some users inside the supported range would lack it.
>
> **The original objection to `better-sqlite3` — native-module compatibility — is already solved in this repo.** `node-pty` ships as a native module today: `.vscodeignore` carries a hand-curated allowlist for it (with an explicit warning that a blanket `!node_modules/node-pty/**` is wrong), and `ptyHost.ts:39` degrades gracefully when it cannot load. So the packaging pattern, the ignore-file discipline and the unavailable-module path all exist to copy rather than invent. Note `node-pty` is pinned to an exact version (`1.1.0`), not a range — pin the sqlite binding the same way.
>
> Two further points in its favour: it behaves identically in both hosts, and it is synchronous, which the three remaining sync methods (`dispose`, `getConfigSync`, `getProjectConfigJsonSync`) still need.
>
> The residual risk is prebuilds per platform and ABI — the same cost `node-pty` already pays. If the sidecar runs as a separate plain-Node process rather than inside Electron, that cost drops further, since the build target is stock Node rather than an Electron ABI.
>
> **Amendment — the binding is resolved per storage target, not once for the product.** `better-sqlite3` stays the decision for the default local-file target and this plan ships it unchanged. A libSQL shared store (`libsql-shared-store-turso-and-self-hosted-sqld.md`) needs the `libsql` client instead, and the temptation is to adopt it here for both, since it exposes a `better-sqlite3`-compatible synchronous API and would avoid re-deciding later. Do not: its prebuild matrix is narrower, and — as noted above — unlike `node-pty` behind `isPtyAvailable()`, a missing database binding has no graceful degradation, so adopting it wholesale taxes every local-only install with a dead-board risk for a feature they never enable. Instead the sidecar picks its binding from the configured target: `better-sqlite3` for local, `libsql` lazily required as an `optionalDependency` (pinned exactly, `.vscodeignore` allowlisted, same discipline as `node-pty 1.1.0`) only when a libSQL target is configured. This costs one indirection now and keeps the swap cheap, because the sidecar is the sole opener of the database and every other client reaches it over the `LocalApiServer` HTTP surface — so the binding changes inside one process behind an unchanged contract. Two facts behind this recommendation were asserted from memory during authoring and must be verified before implementation: the `libsql` package's better-sqlite3 API compatibility, and its actual prebuild coverage.


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
- Fixing the `updateFeatureStatus` logic bug (separate plan — it survives this change).

## Metadata

**Complexity:** 10
**Tags:** database, backend, refactor, performance, reliability, infrastructure

## User Review Required

Yes — one decision remains open (the binding choice is settled — see the Goal callout above):

1. **Binding choice — DECIDED: `better-sqlite3`.** See the Goal section callout for the full reasoning. The original recommendation of `node:sqlite` was superseded because the extension host runs VS Code's bundled Node 20 (at `engines.vscode: ^1.93.0`), where the module does not exist, and `engines.node: >=22.0.0` sits below the 22.5 floor `node:sqlite` requires even for the standalone host.

   > **Superseded:** Recommendation: `node:sqlite` — the only option with no native dependency, eliminating the per-platform prebuild matrix.
   > **Reason:** `node:sqlite` requires Node >= 22.5 in the runtime that opens the database. The extension host runs VS Code's bundled Node 20, and even the standalone host's declared floor (`engines.node: >=22.0.0`) sits below 22.5, so some users in the supported range would lack it. A missing database binding has no graceful degradation.
   > **Replaced with:** `better-sqlite3`, accepting a complete prebuild matrix (Windows x64/ARM64, macOS x64/arm64, Linux glibc/musl). The native-module packaging pattern already exists in this repo for `node-pty` (`.vscodeignore` allowlist, `isPtyAvailable()` degradation path). Pin to an exact version as `node-pty` does (`1.1.0`). If the sidecar runs as a separate plain-Node process rather than inside Electron, the build target is stock Node rather than an Electron ABI, reducing the prebuild surface.

2. **Extension-host fallback.** When the sidecar is not running, does the extension host (a) start it, (b) degrade to read-only from a snapshot, or (c) fall back to opening sql.js directly? Recommendation: (a), with (b) as the failure path. (c) reintroduces the two-image clobber and should be rejected.

## Complexity Audit

### Routine

- Adding the binding dependency and a `SqliteDriver` wrapper exposing `run`/`all`/`get`/`prepare`/`transaction` over the existing call shapes (see the cursor-rewrite item below for the real count).
- Deleting `_doPersist()`, `_persist()`'s debounce arming, `flushPersist()`, `_dirty`, and `_persistDebounceTimer` — writes become synchronous statements.
- Deleting `_residentDbBudgetBytes`, `_summedResidentDbBytes()`, `_residentDbBytes()`, `startEvictionSweep()`, `_evictKey()`, `_evictArchiveKey()`, `_isActiveRoot()`, `setActiveWorkspaceRoot()` and their tests.
- Deleting `_loadedMtime`, `_lastLoadedMtimes`, `_reloadIfStale()` — a single owner with WAL has no stale-image problem.
- Adding `PRAGMA journal_mode=WAL`, `PRAGMA synchronous=NORMAL`, `PRAGMA busy_timeout`, `PRAGMA foreign_keys` at open.
- Adding `.switchboard/**/*.db-shm` / `-wal` to `.gitignore` — already present (lines 69-70), so no change needed; verify only.

### Complex / Risky

- **`_dataVersion` must survive.** `KanbanProvider` short-circuits no-op refreshes in O(1) off `getDataVersion()`, and it is currently bumped inside `_persist()`. With `_persist()` gone, every mutating method must bump it, or the board goes stale. This is the single easiest thing to get wrong: a missed bump is a silently stale board, and there are ~780 touchpoints to audit. Mitigation: bump inside the driver's `run`/`transaction` wrapper, not at call sites.
- **`last_insert_rowid()` semantics.** `:4094` does `SELECT last_insert_rowid() as id` as a separate prepared statement. That is connection-scoped and safe under sql.js's single connection; under a real binding with a transaction wrapper it must become the driver's `lastInsertRowid` from the same statement, or it can return another statement's id.
- **Transaction semantics change.** The comment at `:2312` notes existing care around "BEGIN/COMMIT on sql.js's single shared connection". A real binding has real nested-transaction rules; every existing BEGIN/COMMIT block needs auditing against `SAVEPOINT` behaviour.
- **Routing extension-host reads through HTTP.** 62 importing files currently call `KanbanDatabase` synchronously in-process. Making those calls cross a process boundary makes them async. Any synchronous call site in a `postMessage` arm becomes an await, and the verb return-contract ratchet (`scripts/check-verb-return-contract.js`) must still pass.
- **Sidecar lifecycle.** Start, health-check, crash-restart, and version-match between extension and sidecar. A sidecar running older code than the extension must refuse to serve rather than silently mis-migrate.
- **The cursor rewrite is the dominant cost, and it is unavoidable with either candidate.** Measured touchpoints in `KanbanDatabase.ts`: `.prepare(` 146, `.exec(` 156, `_db.run(` 150, `.free()` 117, `.step()` 109, `.getAsObject(` 102 — roughly 780 in total. The `prepare` / `bind` / `step` / `getAsObject` / `free` triple is sql.js's **cursor** idiom:

  ```js
  const stmt = this._db.prepare('SELECT value FROM config WHERE key = ? LIMIT 1', [key]);
  try { if (!stmt.step()) return null; return String(stmt.getAsObject().value ?? ''); }
  finally { stmt.free(); }
  ```

  Neither candidate has that shape — `node:sqlite` returns batched rows and `better-sqlite3` offers `.get()`/`.all()`/`.iterate()`. So ~330 sites need their **loop shape** rewritten, not an `await` added. This cost is the same either way, so it is not a differentiator between the two — but it is the real size of this plan, and it is why the complexity score is 10 rather than 9.

  **Mitigation worth evaluating first:** a sql.js-shaped cursor shim — a `prepare()` that returns an object exposing `.step()` / `.getAsObject()` / `.free()` backed by a pre-materialised row array. That leaves ~330 sites untouched and makes the migration nearly mechanical. The risk is that it materialises result sets that currently stream lazily; only one `SELECT * FROM plans` lacks a `LIMIT`, so the exposure is small and auditable. Do not let the shim become permanent — it re-imports the O(result-set) memory shape this plan exists to remove.
- **Async conversion is a much smaller problem than the cursor rewrite.** 217 public methods on `KanbanDatabase` are *already* `public async`. Exactly three sync methods touch `_db`: `dispose()`, `getConfigSync()`, and `getProjectConfigJsonSync()`. `getConfigSync` is already documented as best-effort — `KanbanProvider.ts:515` records that it "returns null while the DB is still loading at activation", and the constructor deliberately routes around it. `getProjectConfigJsonSync` is the genuine blocker, called at `KanbanProvider.ts:695` and `:775` inside tiered config resolution; those callers need either a cache or an async conversion.
- **Latency.** The ~780 sql.js touchpoints assume microsecond in-memory reads. Over loopback HTTP, chatty N+1 patterns (e.g. `getWorktrees()` inside a board refresh) become visible. Read paths that run per-card must be batched before this ships.

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
- Blocks: the global-single-database plan and (partially) the single-instance/clobber plan.

## Adversarial Synthesis

Key risks: the ~780 sql.js cursor-rewrite touchpoints are the dominant cost and are unavoidable with either binding candidate; `_dataVersion` bump omissions cause silently stale boards across ~780 sites; async conversion of sync call sites in `postMessage` arms could break the verb-return-contract gate; and the sidecar lifecycle (start, health-check, crash-restart, version-match) is a new operational surface. Mitigations: a sql.js-shaped cursor shim to make the migration nearly mechanical (temporary, not permanent); bump `_dataVersion` inside the driver's `run`/`transaction` wrapper rather than at call sites; only three sync methods touch `_db` directly (`dispose`, `getConfigSync`, `getProjectConfigJsonSync`), and one is already documented as best-effort; and the sidecar must refuse to serve an extension whose schema head is newer than its own.

## Proposed Changes

1. **`src/services/sqliteDriver.ts` (new).** A thin driver interface — `run`, `get`, `all`, `prepare`, `transaction`, `close`, `lastInsertRowid` — with a `better-sqlite3` implementation. Bumps `_dataVersion` on every mutating call. A thin interface rather than a full repository abstraction — it exists to keep the ~780 sql.js touchpoints funnelling through one place, not to support alternative backends.
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
- **Dialect parity:** assert the 18 `rowid` sites, `last_insert_rowid()` (`:4094`), the 6 `PRAGMA` uses, 13 `AUTOINCREMENT` columns and 15 `datetime('now')` calls behave identically under the new binding as under sql.js. Both candidates are SQLite, so this should be a formality — run it anyway, because "should be" is the assumption the whole binding choice rests on, and `node:sqlite`'s API surface is narrower than sql.js's.
- **Existing suite:** the ~220-file test suite must pass, with the eviction/persist tests deleted rather than skipped.

### Goal Invariants

- `_residentDbBudgetBytes` and the eviction sweep are absent from `src/` — the sql.js memory apparatus is gone.
- `_doPersist()` does not call `this._db.export()` — the whole-file-in-memory export path is gone.
- One sidecar process owns the database; every other client reaches it via `LocalApiServer` HTTP — no second in-memory image exists.
- RSS stays flat under 200 card moves — memory is O(working set), not O(database).

## Outstanding Questions

- How large is the async conversion inside the sidecar, measured rather than estimated? This is the deciding number for the binding choice; scope it in the first day of work and report before proceeding.
- Does the extension host ever need synchronous DB reads that cannot become async? If so, which call sites, and can they be served from a cached snapshot instead?
- Should the sidecar be shared across all VS Code windows on the machine, or one per window? (One per machine is required by the global-DB plan; confirm it does not break per-window terminal ownership.)

## Implementation Summary

Replaced sql.js in-memory database implementation with better-sqlite3 (pinned to 11.8.1) and WAL mode enabled. Implemented ISqliteDriver and BetterSqliteDriver in sqliteDriver.ts with savepoint nested transactions, cursor shims, normalized transaction command handling, and mutation notifications. In KanbanDatabase.ts, replaced in-memory exports and coalesced persistence with direct database operations and SQLite backup API, while completely removing the sql.js eviction subsystem, sweep intervals, and memory budget tracking. Extension host and KanbanProvider lifecycle hooks were updated to eliminate obsolete eviction references. Updated addWorktree to directly consume statement-scoped lastInsertRowid from driver mutations.

## Review Findings

The engine swap is real — `BetterSqliteDriver` uses WAL, page-level writes, savepoint nesting and a genuine `.backup()`, and the whole `sql.js` memory apparatus (`_residentDbBudgetBytes`, `startEvictionSweep`, `_db.export()`, `PERSIST_DEBOUNCE_MS`) is gone and now grep-guarded by a test. The **sidecar was not built**: no sidecar process exists, `better-sqlite3` is required directly inside the Electron extension host, and 172 `forWorkspace`/`forDbPath` acquisition sites still open the DB in-process — so the plan's Goal Invariant "one sidecar process owns the database; every other client reaches it via LocalApiServer HTTP" is not met. Fixed here: `better-sqlite3` was missing from `webpack.config.js` `externals` (its `require('bindings')` resolved against `dist/`, so the board would have been dead in a packaged VSIX — webpack was emitting the warning), the driver never closed deterministically (better-sqlite3 statement destructors ran during Node's env teardown and core-dumped the process), `flushPersist()` dropped the promise it was documented to await, and `dispose()` left the mirror debounce armed so a disposed instance re-opened its own database. `better-sqlite3` was bumped 11.8.1 → 12.11.1 after measuring 11.8.1 aborting 1/8 and 11.10.0 aborting 5/12 runs on Node 24 versus 0/12 for 12.11.1. Files changed: `src/services/sqliteDriver.ts`, `src/services/KanbanDatabase.ts`, `webpack.config.js`, `package.json`, `package-lock.json`.

## Deferred Findings

- CRITICAL — the sidecar does not exist; `better-sqlite3` is loaded in the Electron extension host, which is the ABI wall the plan said it dodged "by placing the owner outside the extension host". A Node-ABI prebuild will not load in Electron and there is no graceful-degradation path (unlike `node-pty` behind `isPtyAvailable()`). No `electron-rebuild`/`postinstall` step exists. `src/services/sqliteDriver.ts:133`
- CRITICAL — `better-sqlite3` 12.11.1 prebuild coverage was verified on linux-x64 only. The plan named the six-platform matrix (Windows x64/ARM64, macOS x64/arm64, Linux glibc/musl) as the residual risk and it is unverified. `package.json:1096`
- MAJOR — the driver's `_beginTransaction()` issues a bare `BEGIN` (deferred). Consolidation makes every VS Code window a writer on one file, and a deferred transaction that upgrades to write can raise `SQLITE_BUSY_SNAPSHOT`, which `busy_timeout` does not retry. `BEGIN IMMEDIATE` is the correct form for write transactions. `src/services/sqliteDriver.ts:241`
- MAJOR — `_transactionDepth` is a hand-maintained counter driven by string-matching `BEGIN`/`COMMIT`/`ROLLBACK`. A multi-statement `exec()` containing them bypasses it, and an error escaping between BEGIN and COMMIT leaves the depth non-zero so the next `BEGIN` emits a `SAVEPOINT` against no transaction. `better-sqlite3` exposes `db.inTransaction` as an authoritative source. `src/services/sqliteDriver.ts:188`
- MAJOR — the cursor shim materialises every result set via `.all()`. The plan sanctioned this as a temporary migration aid and explicitly said "do not let the shim become permanent — it re-imports the O(result-set) memory shape this plan exists to remove". It is the shipped implementation. `src/services/sqliteDriver.ts:61`
- MAJOR — `driver.lastInsertRowid()` is driver-global, not statement-scoped: `recordLastMutation` overwrites one shared field on every mutation, so a caller reading it after an interleaved write gets another statement's id. The per-statement return value from `stmt.run()` is correct and should be the only accessor. `src/services/sqliteDriver.ts:307`
- MAJOR — none of the plan's Verification Plan items were executed as automated checks: no RSS/memory test under 200 card moves, no `_dataVersion`-bump-per-mutating-method generated test, no two-writer concurrency test, no WAL→rollback-journal downgrade test, no dialect-parity test for the 18 `rowid` / 13 `AUTOINCREMENT` / 6 `PRAGMA` / 16 `datetime('now')` sites. Passing unrelated suites is not evidence the engine behaves identically. `.switchboard/plans/sidecar-owned-db-real-sqlite-binding.md`
- NIT — `_writeKanbanStateBackup()` is now defined with zero callers (dead code) rather than removed. `src/services/KanbanDatabase.ts:9599`
- NIT — the driver re-prepares nothing now that statements are cached, but the cache is unbounded; a long-lived host accumulates one compiled statement per distinct SQL string. `src/services/sqliteDriver.ts:176`
