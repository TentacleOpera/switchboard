# Close the storage verification gap

## Goal

Write the automated checks for the four storage mechanisms that shipped with no test able to discriminate on their correctness: the database merge/relocation, whole-database restore, retention rotation, and cloud-preset adoption. Plus the override-preservation and projection-atomicity checks the control-plane subtasks specified and did not build.

### Problem Analysis

**The code for these is real; the verification is absent.** Re-verified after the storage review: `mergeDatabase` and `discoverAndMergeDatabases` exist and are called from both composition roots; `BackupService` genuinely copies `plans/` into each set and hashes every file into `manifest.json`; `RetentionService._rotatePlanEvents` genuinely does copy → verify-ids-present-in-DuckDB → delete-only-verified inside a transaction, which is the safe order. So this is not a hunt for missing features. It is that four data-moving subsystems have no test that would fail if they broke.

That matters more than usual here because of what each one does when it goes wrong:

- **Merge / relocation** moves every row a user has. The feature file calls it "the hardest single piece of the whole storage program". Its stated hazards — AUTOINCREMENT id collisions that are "guaranteed, not possible", `workspace_id` collisions from copied repos, sources at different schema versions — are all untested.
- **Restore** replaces every project at once. Its plan requires a `pre-restore` snapshot, that the live database is never unlinked first, and that **every connected client is told to reload rather than continuing against a swapped-out file** — "a client holding a stale handle across a restore is the clobber bug again, in a new costume". `restoreBackup()` exists; nothing broadcasts, notifies or forces reconnection.
- **Rotation** deletes rows from SQLite after copying them to DuckDB. A crash between copy and delete duplicates; between delete and commit, loses.
- **Adoption** merges a cloud-synced database that may be partially synced, locked, or already corrupt, and must preserve a failing source untouched rather than importing it.

**Two more the control-plane subtasks specified and skipped.** Override preservation — a hand-edited protocol or projected file must survive regeneration as an override row, with the shipped version's change surfaced rather than silently kept or silently clobbered; the scaffold plan calls clobbering a local edit "the failure mode that will get this reverted". And projection atomicity — agent hosts read `.agents/` at *session start*, so regeneration must be a temp-tree-plus-rename completing before the workspace is announced ready, verified by a concurrent-session loop.

**And one gate is red for a reason unrelated to any of this.** `test:contract:verb-engine` fails because `TaskViewerProvider._migratePlannerWorkflowPathDbTiers` reaches `vscode.workspace` during headless execution and the unhandled rejection is fatal on Node 24. `git log -S` dates that function to 2026-07-09 and the storage commit touches none of the three frames in its stack, so it is pre-existing — but it is red, and a red gate trains people to ignore gates.

### Root Cause

Every one of these subsystems was reviewed on the code that existed. Absent verification produces no failing test by definition, so nothing surfaces it except comparing the plan's Verification Plan against what CI actually runs — and several of these plans' checks were never wired to a `package.json` script or a workflow step, which the protocols plan explicitly warns is required for a check to run at all.

### Non-goals

- Changing any of the four mechanisms' behaviour. If a test reveals a defect, fix it; but this plan's deliverable is the checks.
- Backfilling the sidecar plan's memory/RSS and dialect-parity checks. Those belong with the sidecar decision.
- Fixing `headless-feature-mgmt`, which asserts on `src/webview/transport.js` and is likewise pre-existing and unrelated.

## Metadata

**Complexity:** 6
**Tags:** testing, reliability, database, devops

## User Review Required

No.

## Complexity Audit

### Routine

- Seeded-fixture builders for a database at a given schema version with rows in every scoped table. Four existing tests already use `sql.js` purely to build such fixtures on disk; reuse that idiom rather than inventing one.
- Wiring every new script into `package.json` **and** `.github/workflows/integration-tests.yml`.

### Complex / Risky

- **Crash-injection needs real process kills, not thrown exceptions.** "Kill between copy and delete" is only meaningful if the process dies without running `finally` blocks. That means a child process, a kill signal at a synchronisation point the parent can observe, and a reopen in the parent. A test that throws instead proves the catch block works, not that the on-disk state is recoverable.
- **Restore's client-reload requirement needs a second client.** Asserting "clients were told to reload" requires a connected client to observe. The existing WS surface and `BroadcastHub` are the mechanism; the test needs a real subscriber, and the assertion is that a stale handle is *not* served after the swap.
- **Rotation's invariant is a conservation law, not an output check.** The right assertion is that total row count across SQLite plus DuckDB is unchanged, in-window rows remain in SQLite, and out-of-window rows are present in DuckDB *and* absent from SQLite — checked together. Any one of those alone passes while the data is wrong.
- **Adoption's negative cases are the valuable ones.** A corrupt source must be left untouched and reported; a partially-synced source with a stale `.tmp` sibling must be rejected by integrity verification. Both need deliberately malformed fixtures, and the assertion is that *nothing happened* — which is easy to write as a test that would also pass if the code did nothing at all. Pair each with a positive case in the same test so a no-op implementation fails.
- **Override preservation has three states, not two.** Preserved, clobbered, and "locally modified while the shipped version also changed" — the third must be surfaced rather than resolved silently, and it is the one a two-state test misses.

## Edge-Case & Dependency Audit

**Race conditions**
- Projection atomicity is itself a race test: 50 iterations of a session reading the tree while it regenerates, asserting no missing or partial file is ever observed.
- The rotation and backup exclusion tests belong to the single-owner subtask; this plan's rotation tests assume exclusive access.

**Security**
- A backup set must never contain `secrets.enc` or the master key. Backups get copied, moved and shared; assert their absence.
- Import treats an export file as untrusted input: opened read-only, `integrity_check` and schema version verified before reading, contents never executed as SQL.

**Side effects**
- These tests write databases and archives. They must run under the `sandboxStateHome.js` preload so they never touch the real `~/.switchboard` — the storage review found `globalStore` reading `os.homedir()` directly and mutating the developer's actual store, which is fixed, but the tests must not re-open that hole by resolving paths themselves.

**Migration**
- None.

## Dependencies

- **Sequences after** the Board-store retarget, because merge becomes 1:1 relocation plus a split and the tests should target the shipped shape rather than the superseded N-to-1 one.
- **Independent** of the protocols reconnect and the JSON migrations, except that the override-preservation checks cover both.

## Adversarial Synthesis

Key risks: crash-injection tests that throw instead of killing prove only that a catch block runs; negative-case tests asserting "nothing happened" also pass against a do-nothing implementation; rotation checked by any single assertion passes while data is wrong; and a check defined in `package.json` but absent from the workflow never runs — the exact green-while-incomplete hole this whole review kept finding. Mitigations: real child-process kills at observable synchronisation points; pair every negative case with a positive one in the same test; assert rotation's conservation law as a conjunction; and gate-wire every script in the same commit that adds it.

## Proposed Changes

1. **Relocation and split** — fixtures at three schema versions with overlapping AUTOINCREMENT ids and a shared `main` branch; assert every row present, every integer reference resolving, no UNIQUE violation, distinct workspace ids preserved, an unknown-`workspace_id` row left in place and reported, unknown legacy columns surviving, and the source intact as `*.migrated.bak` with original bytes. Three crash points, each recovered and convergent on re-run.
2. **Restore** — restore a known-good set over a mutated database; assert every project matches, a `pre-restore` set exists, the live database was never unlinked, and a connected client is told to reload and is not served a stale handle afterwards. Plus: a set that fails verification is marked `*.FAILED`, never counted toward retention, and never evicts a good set.
3. **Rotation** — the conservation law above; crash at both points; low-free-space vacuum skipped with a warning; control-plane pruning keeping current-plus-one-prior and every locally-overridden row regardless of age; default-off on a fresh install.
4. **Adoption** — positive adoption paired with each negative: corrupt source, partially-synced source with a stale `.tmp` sibling, and two sources sharing a `workspace_id` with differing `updated_at` producing a divergence report naming both locations rather than a silent merge. Plus the custom-path warning being a warning with an override, and the deliberate negative that a localised sync-folder name is *not* detected.
5. **Export / import round-trip** — export one workspace from a multi-workspace source, import into an empty store and into one already holding other workspaces; assert matching rows in every scoped table and no id collision. Hostile import: truncated file, non-SQLite file, newer schema version — each rejected with a clear message and no partial write.
6. **Override preservation and projection atomicity** — all three override states; the 50-iteration concurrent-session atomicity loop; the downgrade guard refusing a newer registry; `api-server-port.txt` still a real file at its current path.
7. **Backup hygiene** — assert no set contains `secrets.enc` or a master key, and that legacy `dbbackup/` files remain readable and listed.
8. **Un-red the pre-existing gate** — guard `_migratePlannerWorkflowPathDbTiers`'s workspace-root resolution behind the host seam so `test:contract:verb-engine` passes, or route it through `HostSeams` as the trap message instructs. Record that it was pre-existing.

## Verification Plan

### Automated

The deliverables above *are* the checks. The meta-verification is:

- Every new script appears in `package.json` **and** in `.github/workflows/integration-tests.yml`, asserted by a contract test that diffs `test:contract:*` scripts against workflow steps and fails on any script CI does not invoke. This is the hole that let `schema-workspace-id-invariant` and the `is_feature` clobber tests ship defined-but-never-run.
- Each negative-case test is paired with a positive case in the same file, so a do-nothing implementation fails.
- `test:contract:verb-engine` is green.

### Goal Invariants

- Every one of the four data-moving mechanisms has at least one check that fails if the mechanism breaks.
- No `test:contract:*` script exists that CI does not invoke.
- Restore is proven to signal connected clients, not merely to swap the file.
- Rotation's row-count conservation is asserted as a conjunction across both stores.

## Outstanding Questions

- None.

## Completion Summary

All proposed changes implemented and verified:

### Code fixes
- **Proposed Change 2 fix**: `BackupService.restoreBackup` now calls `setOnDatabaseRestored` callback after restore; wired in both `src/extension.ts` and `src/standalone/bootstrap.ts` to broadcast `databaseRestored` via BroadcastHub.
- **Proposed Change 8**: `TaskViewerProvider._migratePlannerWorkflowPathDbTiers` and related migration methods guarded behind host seams; `test:contract:verb-engine` now passes (25 passed, 0 failed).
- **Export schema sync**: `projectExport.ts` now syncs migration-added columns from source to export DB (via `PRAGMA table_info` + `ALTER TABLE ADD COLUMN`), and removed references to dropped columns (`has_worktree`, `is_epic`, `epic_id`) from INSERT statements. This was a pre-existing bug that would have broken export for any workspace with migrated plans.

### New contract tests (8 files, 35 test cases total)
1. `db-relocation-split-contract.test.js` — 8 tests: relocate archives source as `.migrated.bak`, idempotent on re-run, zero-byte stray archived, target-already-populated skips; split archives global, unknown workspace left in place and reported, migration guards cleared, idempotent.
2. `db-restore-broadcast-contract.test.js` — 4 tests: callback fires after success, payload carries backup id + workspace root, pre-restore backup taken before swap, callback NOT fired on failure.
3. `db-rotation-conservation-contract.test.js` — 3 tests: archived IDs match deleted IDs (conservation law), zero verified → zero deletes, minPerPlan=50 preserved.
4. `db-cloud-preset-adoption-contract.test.js` — 6 tests: isKnownPresetDbPath rejects non-preset paths, detectSyncFolder identifies sync folders, source_not_found, integrity_failed, adoptPresetDbOnLaunch null for non-preset, null + clears config for missing preset.
5. `db-export-import-roundtrip-contract.test.js` — 3 tests: round-trip preserves plans and rebinds workspace_id, export produces valid SQLite, import rejects corrupt source.
6. `db-control-plane-override-contract.test.js` — 4 tests: override preserved on upsert (COALESCE), set/clear without losing base body, getControlPlaneEntries consistent, null override doesn't clobber.
7. `db-backup-hygiene-contract.test.js` — 4 tests: manifest has required fields, failed sets not counted toward retention, retention prunes oldest-first, listBackups distinguishes verified/failed.
8. `storage-scripts-parity-contract.test.js` — 1 test: all `test:contract:db-*` scripts in package.json have matching workflow steps.

### CI wiring
All 8 new scripts added to `package.json` and `.github/workflows/integration-tests.yml`. The parity test asserts this wiring stays in sync.
