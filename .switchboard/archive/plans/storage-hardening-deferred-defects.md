# Storage hardening: close the deferred code defects

## Goal

Fix the thirteen small code defects the storage-overhaul review found and deferred. Three are live hazards created by consolidation; the rest are correctness and hygiene. All are contained, none needs a decision.

### Problem Analysis

Each item was measured during the review of `8258ce4b` and recorded in the per-subtask `## Deferred Findings` sections. They were deferred to keep the review pass bounded, which was the wrong call for items this cheap.

**Live hazards.**

1. **`sqliteDriver.ts:241` issues a bare `BEGIN`.** A deferred transaction that later upgrades to a write can raise `SQLITE_BUSY_SNAPSHOT`, which `busy_timeout` does **not** retry — unlike ordinary `SQLITE_BUSY`. Write transactions need `BEGIN IMMEDIATE`. This matters wherever two hosts share a file.
2. **`globalStore.ts:36` matches cloud-sync keywords anywhere in the lowercased resolved path.** A home directory or username containing `dropbox`, `box sync`, `icloud` and so on fails validation, and `resolveGlobalDbPath()` **throws** on a failed default — so the board never opens, with no override. The check must apply to path *segments* the user chose, not to every character of an absolute path.
3. **`.gitignore:75` gained `.switchboard/**/*.bak`.** Not in any plan. It hides the `.migrated.bak` archives that four sibling plans depend on being visible to the user as proof nothing was destroyed.

**Correctness.**

4. **`sqliteDriver.ts:188` maintains `_transactionDepth` by string-matching `BEGIN`/`COMMIT`/`ROLLBACK`.** A multi-statement `exec()` containing them bypasses the counter, and an error escaping between `BEGIN` and `COMMIT` leaves the depth non-zero, so the next `BEGIN` emits a `SAVEPOINT` against no transaction. `better-sqlite3` exposes `db.inTransaction` as an authoritative source.
5. **`sqliteDriver.ts:307` `lastInsertRowid()` is driver-global.** `recordLastMutation` overwrites one shared field on every mutation, so a caller reading it after an interleaved write gets another statement's id. The per-statement value returned by `stmt.run()` is correct and should be the only accessor.
6. **`KanbanDatabase.ts:9213` V70 still lists `plan_events_v20` in `alterTables`.** It is V20's rename-target scratch table, dropped by step 12 of that same migration, so it never exists at rest. A harmless no-op that records a table that is not real.
7. **`globalStore.ts:116` discards the `source` field it just computed.** The `{path, source}` tagging exists to answer "which store answered?" after the fact, and nothing logs it — half of the project's own fallback rule.
8. **`featureClobberDiag.ts` still writes `.switchboard/feature-clobber-diagnostic.txt`, and `instanceId` is still stamped into the clobber log.** Two plans specified deleting the diagnostic once the clobber tests passed; the tests now pass.

**Hygiene.**

9. `_writeKanbanStateBackup()` has zero callers — dead code left behind rather than removed. (Removal is owned by the JSON-migration subtask if that lands first; delete it here otherwise.)
10. The driver's statement cache is unbounded: one compiled statement per distinct SQL string, for the life of the process.
11. `updateFeatureStatus` returns `true` from its features-directory refusal arm even when it declined the requested `is_feature=0` write, so a caller cannot distinguish "applied" from "refused".
12. Stale prose describes `db-pointer` as a live deliberate-setup marker in `extension.ts:226`, `SetupPanelProvider.ts:1706` and `standalone/cli.ts:779`.
13. `control_plane` carries both `override_body` and `workspace_override`, and every writer sets them to the same value — the protocols plan asked for a rename, and got both columns.

### Root Cause

A review pass that fixed the board-fatal defects and wrote the rest down. The cheap ones should have been fixed in the same pass.

### Non-goals

- The sidecar, the Board-store retarget, the protocols reconnect, the JSON migrations, or the verification backfill. Each has its own subtask.
- Removing the cursor shim. It materialises result sets via `.all()`, which the sidecar plan sanctioned as a temporary migration aid and warned against making permanent — but replacing it is a large, separate audit of ~330 sites, not a hardening item.

## Metadata

**Complexity:** 3
**Tags:** bugfix, database, refactor, reliability

## User Review Required

No.

## Complexity Audit

### Routine

Items 3, 6, 7, 9, 11, 12, 13 — one-line or single-site changes with no behavioural ambiguity.

### Complex / Risky

- **Item 1 (`BEGIN IMMEDIATE`)** changes lock acquisition timing. A write transaction now takes the write lock at `BEGIN` instead of at first write, which can surface contention earlier as a clean `SQLITE_BUSY` (retried by `busy_timeout`) rather than later as an unretryable `SQLITE_BUSY_SNAPSHOT`. That is the improvement, but it means read-only transactions must **not** become `IMMEDIATE` or they will serialise needlessly. The driver must distinguish, and `transaction(fn)` has no way to know today.
- **Item 2 (sync-folder heuristic)** must not lose the protection it provides. Narrowing from "anywhere in the path" to "a segment of the user-supplied portion" keeps a `~/Dropbox/board.db` refusal while allowing a home directory that happens to contain the word. Test both directions.
- **Item 4 (`db.inTransaction`)** replaces a counter that nested `SAVEPOINT` naming depends on. The savepoint names are derived from the depth, so switching the source of truth must keep names unique and matched between `SAVEPOINT` and `RELEASE`.
- **Item 5 (`lastInsertRowid`)** has callers. `addWorktree` was already converted to the statement-scoped value; find the rest before removing the driver-global accessor rather than leaving a compile error to find them.

## Edge-Case & Dependency Audit

**Race conditions**
- Item 1 is specifically about a race, and its test needs two writers against one file.

**Security**
- Item 2 is a validation narrowing. It must not widen what is accepted beyond user-chosen sync folders; the git-work-tree refusal is untouched.

**Side effects**
- Item 7 adds a log line on every path resolution; log once per instance, not per call.
- Item 11 changes a return value a caller checks. `createFeatureFromPlanIds` captures `linkOk`; a newly-distinguishable refusal must not be treated as a link failure.

**Migration**
- Item 13 is schema debt, not a migration: both columns exist and are dual-written, so collapsing to one means a migration that copies `workspace_override` into `override_body` where they differ (they cannot today) and stops writing the second. Low risk, but it is a schema change and needs a version gate.

## Dependencies

- **Requires** nothing. Ships first and independently.
- Item 9 overlaps the JSON-migration subtask; whichever lands second finds it already done.

## Proposed Changes

1. `sqliteDriver.ts` — `BEGIN IMMEDIATE` for write transactions, with a read-only variant that stays deferred; `db.inTransaction` as the depth authority with savepoint names kept unique; remove the driver-global `lastInsertRowid()` accessor after converting its callers; bound the statement cache with an LRU.
2. `globalStore.ts` — narrow the cloud-sync check to user-supplied path segments; log the resolved `{path, source}` once per instance.
3. `.gitignore` — remove `.switchboard/**/*.bak`.
4. `KanbanDatabase.ts` — drop `plan_events_v20` from V70's `alterTables`; make `updateFeatureStatus` return a distinguishable refusal; delete `_writeKanbanStateBackup()` if still present; collapse `workspace_override` into `override_body` behind a version gate.
5. Delete `src/services/featureClobberDiag.ts` and its call sites, and the `instanceId` stamp in the clobber log.
6. Correct the stale `db-pointer` prose in the three named files.

## Verification Plan

### Automated

- **`BEGIN IMMEDIATE`:** two writers against one file in a loop for 30s; assert zero unretried `SQLITE_BUSY_SNAPSHOT` and zero lost writes. Assert a read-only transaction does not take the write lock.
- **Sync-folder heuristic:** `~/Dropbox/x.db` refused; a home directory containing the literal string `dropbox` with the DB at the default path accepted; the git-work-tree refusal unchanged.
- **`.bak` visibility:** `git check-ignore` reports `.switchboard/kanban.db.migrated.bak` as **not** ignored.
- **Transaction depth:** nested `transaction()` calls commit and roll back correctly; an error escaping between `BEGIN` and `COMMIT` leaves the driver able to start a fresh transaction.
- **`lastInsertRowid`:** grep-level assertion that the driver-global accessor is gone; two interleaved inserts each read back their own id.
- **Statement cache bound:** issue more distinct statements than the cap; assert the cache does not grow past it and queries still succeed.
- **Diagnostic removed:** `featureClobberDiag` and `feature-clobber-diagnostic.txt` absent from `src/`.
- **`updateFeatureStatus` refusal:** a features-directory demotion returns a value distinguishable from success, and `createFeatureFromPlanIds` does not treat it as a link failure.
- Each new check gets a `package.json` script **and** a workflow step.

### Goal Invariants

- No bare `BEGIN` for a write transaction in `sqliteDriver.ts`.
- The default global path validates on a machine whose home directory contains a sync-provider name.
- `.migrated.bak` files are visible in `git status`.
- `featureClobberDiag` is absent from `src/`.
- The driver-global `lastInsertRowid()` accessor is absent from `src/`.

## Outstanding Questions

- None.

## Implementation Summary

All thirteen deferred defects fixed. `sqliteDriver.ts`: bare `BEGIN` replaced with `BEGIN IMMEDIATE` for write transactions (with `readOnlyTransaction()` for reads); `_transactionDepth` counter replaced by `db.inTransaction` authority + `_savepointCounter` for unique savepoint names; driver-global `lastInsertRowid()` accessor removed (sole caller in `addWorktree` converted to per-statement value); statement cache bounded with LRU (cap 500). `globalStore.ts`: cloud-sync keyword check narrowed from full-path substring to user-supplied segment exact match; `{path, source}` logged once per distinct path per process. `.gitignore`: `.switchboard/**/*.bak` removed so `.migrated.bak` archives stay visible. `KanbanDatabase.ts`: `plan_events_v20` dropped from V70 alterTables; `updateFeatureStatus` returns `'applied'|'refused'|'not_found'|'error'` instead of boolean; `featureClobberDiag.ts` deleted and instanceId stamp removed from clobber log; V71 migration collapses `workspace_override` into `override_body` (column kept, no longer written or read). Stale `db-pointer` prose corrected in `extension.ts`, `SetupPanelProvider.ts`, and `standalone/cli.ts`. Item 9 (`_writeKanbanStateBackup`) was already removed by the JSON-migration subtask.
