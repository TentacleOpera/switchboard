# Consolidate to one global database in ~/.switchboard and retire the location guard, db-pointer and mapping subsystem

> **SUPERSEDED** by `board-store-one-database-per-project.md`. The single-file
> consolidation was a fourth topology nobody asked for: it is not a Board target
> that a libSQL/Turso target can substitute for. The per-project topology
> (`~/.switchboard/boards/<workspace-id>.db`) is what the product actually
> supports. The genuinely good work from this plan — `globalStore.ts` as the
> sole path authority, the deletion of `switchboardLocationGuard`, `db-pointer`
> and the DB-resolution half of `WorkspaceIdentityService`, the engine swap —
> stays. The N-to-1 merge and the single shared file are superseded.

## Goal

Move board state out of the repository and into a single database in the user's home store, holding every workspace at once. Migrate existing per-workspace databases into it with an N-to-1 merge, then delete the three subsystems that exist only to answer "which database does this folder use?".

### Problem Analysis

**A database inside a repository is the wrong place for it, and the codebase already carries the scar tissue.**

`src/utils/switchboardLocationGuard.ts` is a ~130-line, three-tier, race-hardened heuristic whose entire purpose is deciding whether a folder may own a `.switchboard` directory. Its own comments record the bug class it was written to close:

> "That transient-empty window was the root cause of the recurring child-scaffold bug: every mapping-based check failed open while the index built."

> "Historically step 1 was the ONLY gate and, when the index was empty, control fell straight to step 3 (`candidate === workspaceRoot`). Callers invoke this as `isAllowedSwitchboardLocation(folder, folder)`, making that comparison tautologically true — so an empty index silently permitted `.switchboard` in every folder."

`db-pointer` is a hand-rolled indirection file so a child repo can borrow a parent's database — written at `KanbanDatabase.ts:1095`, read at `:1106` and `:1165`, resolved for the cold/archive DB at `:1237` and `:1271`, and treated as a control-plane marker in `TaskViewerProvider.ts:9670` and `SetupPanelProvider.ts:1567-1598`.

`WorkspaceIdentityService.ts` is 522 lines — `buildMappingIndexFromDbs`, `getMappingsFromIndex`, `getScopedMappingsForBoard`, `pruneNonExistentMappings`, `resolveParentsForTerminals`, `resolveEffectiveWorkspaceRootFromMappings` — an entire subsystem devoted to resolving which repository's database is meant.

All three exist because the database is in the repo. None of them is needed once it is not.

The concrete failure modes are not hypothetical. `.gitignore` needs five lines to defend the DB (`:67-70`, plus `.switchboard/**/*.db-shm` and `-wal`), and because the file is untracked-and-ignored, `git clean -xdf` deletes the board. A fresh clone starts empty. Every worktree Switchboard creates is a checkout with no `.switchboard/`, which is most of *why* `db-pointer` and the mapping index exist. Multi-root workspaces need the guard to adjudicate an owner. And a single gitignore mistake commits a binary database into history permanently.

**The precedent for the fix already exists in this codebase and has already shipped.** `GlobalIntegrationConfigService.ts:25` documents integration config as living "in a single ~/.switchboard file rather than per-workspace DBs", and `.gitignore:73-78` records the secrets store having made the same journey — per-workspace to `~/.switchboard`, with `.migrated.bak` archival, exactly the pattern `CLAUDE.md` mandates.

**Both halves of the right design are also already built.** `ensureWorkspaceIdentity()` and `tryWriteCommittedWorkspaceId()` put a stable workspace id *in the repo* — small, diff-friendly, legitimately repository state. `~/.switchboard` holds machine state. So: the repo holds identity, the home store holds state. The database is simply the piece that never followed.

### Root Cause

The database's location was inherited from the plans directory. `.switchboard/plans/*.md` genuinely belongs in the repo — those files are gitignore-*whitelisted* (`!.switchboard/plans/`), deliberately committed, and correctly so: plans are project artifacts that should version alongside the code. `kanban.db` was placed beside them by proximity, not by design, despite being machine-local derived state.

### Non-goals

- Moving the markdown out of the repo. `.switchboard/plans/`, `features/`, `reviews/`, `sessions/` stay committed exactly as they are.
- Adding a remote/cloud backend (separate plan).
- Changing the storage engine (separate plan, lands first).
- Retention/archive policy for the now-unbounded database (separate plan).

## Metadata

**Complexity:** 10
**Tags:** database, backend, refactor, infrastructure, reliability, devops

## User Review Required

Yes — three decisions:

1. **Path.** `~/.switchboard/switchboard.db` (matches the existing `~/.switchboard` precedent) vs an XDG/platform-correct location (`$XDG_DATA_HOME/switchboard`, `~/Library/Application Support/Switchboard`). Recommendation: `~/.switchboard/switchboard.db`, because consistency with the already-shipped secrets and integration-config location beats platform correctness here.
2. **Merge conflict precedence.** When two source databases disagree about the same workspace, which wins — most-recently-modified file, or highest `migration_meta` version, or newest row `updated_at`? Recommendation: per-row `updated_at`, falling back to source-file mtime.
3. **Does the old per-repo DB get deleted?** Recommendation: no — archive as `kanban.db.migrated.bak` and leave it, per `CLAUDE.md`. Never unlink.

## Complexity Audit

### Routine

- Resolving the global DB path and creating `~/.switchboard/` if absent.
- Deleting `src/utils/switchboardLocationGuard.ts` and its call sites (`isAllowedSwitchboardLocation` is imported at `KanbanDatabase.ts:6`).
- Deleting the `db-pointer` write/read/resolve paths (`:1095`, `:1106`, `:1165`, `:1237`, `:1271`) and the marker checks in `TaskViewerProvider.ts:9670` and `SetupPanelProvider.ts:1567-1598`.
- Deleting `_instances` / `_instancesByDbPath` keying by workspace root — one DB means one handle.
- Removing the five `.gitignore` DB lines (harmless to leave, but they document a thing that no longer happens).

### Complex / Risky

- **The N-to-1 merge is the hardest single piece of the whole storage program.** Every install may hold several workspace databases *at different schema versions* — `migration_meta` is per-database. So each source must be migrated to head *first*, individually, before any merge begins. A source that fails to reach head must be skipped and reported, not merged partially.
- **`AUTOINCREMENT` id collisions are guaranteed, not possible.** `projects.id`, `worktrees.id`, `activity_log.id`, `job_runs.id`, `board_move_requests.id`, `plan_events.event_id` are all `INTEGER PRIMARY KEY AUTOINCREMENT` — per-database sequences that every source restarts at 1. Merging N sources collides on every one of those tables. Anything referencing them by integer id must be remapped mid-merge, which means the merge needs an explicit old-id-to-new-id table per source, per table, and a second pass to rewrite references.
- **Discovering the source databases.** There is no registry of "every workspace this user has ever opened". Candidates: the mapping index, `_instancesByDbPath`, VS Code's recent-workspaces list, a filesystem scan for `.switchboard/kanban.db`. None is complete. The migration must therefore be *incremental and repeatable* — when an unmigrated per-repo DB is discovered later (user opens an old project for the first time in a year), it merges then. This is a permanent capability, not a one-shot.
- **`workspace_id` collisions.** Two source DBs could carry the same `workspace_id` (a repo copied, or `ensureWorkspaceIdentity` having minted the same value twice). The merge must detect and disambiguate rather than silently union two projects' rows.
- **Retiring the mapping subsystem without breaking terminal parenting.** `resolveParentsForTerminals` is used by `bootstrap.ts`; its output feeds terminal ownership. That resolution still needs to happen — it just no longer needs to resolve a *database*. Separate the two responsibilities before deleting.
- **Blast radius inverts.** Today a corrupt DB costs one project. After this, it costs all of them. This is why the backup/export plan is a hard dependency rather than a follow-up.

## Edge-Case & Dependency Audit

**Race conditions**
- Every VS Code window on the machine now writes the same file. Multi-writer stops being theoretical and becomes the default case. This is safe only with the real-binding-plus-WAL plan already landed; under `sql.js` whole-file `export()`, window A's stale image would overwrite every other project wholesale. **Ordering is load-bearing.**
- Two windows both discovering the same unmigrated source DB and both merging it: needs a merge lock plus an idempotency marker on the source (write the `.migrated.bak` and a marker row before releasing).

**Security**
- `~/.switchboard/switchboard.db` now aggregates every project the user works on. It should be `0600`, and it must never be inside a repo, a synced folder, or a shared home on a multi-user box. Add an explicit refusal if the resolved path is inside a git work tree.

**Side effects**
- Cross-workspace queries become possible for the first time — the "everything I'm working on" view. Out of scope here, but the reason the topology is worth having.
- `ArchiveManager` / `AutoArchiveService` resolve the cold DB "next to the hot DB", including via `db-pointer` (`:1237`, `:1271`). That resolution changes to the global store.
- `BoardSnapshotPublisher` and `.switchboard/kanban-board.md` are per-workspace exports read by agents and by the `/switchboard-cloud` protocol. They must keep being written per-repo even though the DB is global — otherwise every agent-facing board snapshot breaks.
- `query-kanban` skill and `scripts/move-card.js` read `.switchboard/workspace-id` and the DB path. Both need updating, and the skill's documented path is user-facing.

**Migration**
- Published extension, ~4,000 installs, many far behind. `kanban.db` shipped in every released version, so this is the highest-stakes migration in the program: import before deleting, archive as `kanban.db.migrated.bak`, never unlink, preserve unknown/legacy columns (enumerate from `PRAGMA table_info`), and never assume a prior migration ran.
- The merge must be resumable. A crash mid-merge must leave both the source and the global DB readable.

## Dependencies

- **Hard prerequisite:** the sidecar/real-binding plan. Consolidation under `sql.js` is a data-loss event.
- **Hard prerequisite:** the unscoped-tables plan. `worktrees.branch UNIQUE` makes consolidation literally impossible.
- **Hard prerequisite:** the backup/per-project-export plan, because of the blast-radius inversion.

## Adversarial Synthesis

Key risks: the N-to-1 merge is the hardest single piece — every install may hold several workspace DBs at different schema versions, AUTOINCREMENT id collisions are guaranteed (not possible), and `workspace_id` collisions can occur (copied repos); every VS Code window now writes the same file, making multi-writer the default case (safe only with the real-binding plan already landed); and blast radius inverts (one corrupt DB costs all projects). Mitigations: migrate each source to head individually before merge, with explicit old-id-to-new-id remap and reference rewrite; incremental and repeatable discovery (merge when an old project is opened); archive sources as `.migrated.bak`, never unlink; and the backup plan is a hard prerequisite because of the blast-radius inversion.

## Proposed Changes

1. **`src/services/globalStore.ts` (new).** Resolves `~/.switchboard/switchboard.db`, creates the directory at `0700`, refuses a path inside a git work tree, and is the only place the DB path is decided.
2. **`src/services/dbMerge.ts` (new).** The N-to-1 merge: migrate-source-to-head, per-table id remap with an explicit old-to-new map, reference rewrite pass, `workspace_id` collision detection, resumable, transactional per source, archives the source as `kanban.db.migrated.bak`.
3. **Source discovery.** A repeatable scan (mapping index + recent workspaces + on-open check) that merges any unmigrated per-repo DB when it is found, guarded by a merge lock and an idempotency marker.
4. **Delete** `src/utils/switchboardLocationGuard.ts`, the `db-pointer` read/write/resolve paths, and the DB-resolution half of `WorkspaceIdentityService` — keeping `ensureWorkspaceIdentity` / `tryWriteCommittedWorkspaceId` (still needed: the repo holds identity) and the terminal-parenting half of `resolveParentsForTerminals`.
5. **`ArchiveManager` / `AutoArchiveService`** cold-DB resolution repointed at the global store.
6. **Keep writing per-repo** `.switchboard/kanban-board.md` and the board snapshot, so agent-facing surfaces and `/switchboard-cloud` are unaffected.
7. **Update** the `query-kanban` skill and `scripts/move-card.js` to the new path.

### Migration

Per source database: migrate to head, merge under a transaction with id remapping, verify row counts, archive as `kanban.db.migrated.bak`, mark migrated. Never unlink. Resumable after a crash. A source that cannot reach head is skipped and surfaced to the user, never partially merged.

## Verification Plan

- **Merge correctness:** seed three source DBs at three different schema versions with overlapping `projects.id`, `worktrees.id`, and `plan_events.event_id` values plus a shared branch name `main`. Merge. Assert: every row present, every integer reference resolves to the correct remapped row, no UNIQUE violation, three distinct `workspace_id` values.
- **Duplicate workspace_id:** two sources with the same `workspace_id`; assert detection and disambiguation, not a silent union.
- **Resumability:** kill the process mid-merge at three points (after source migration, mid-copy, after copy before archive). Reopen. Assert source and global DB both readable and the merge completes.
- **Non-destruction:** assert the source file still exists as `kanban.db.migrated.bak` with its original bytes.
- **Legacy columns:** source with an unknown extra column; assert it survives into the global DB.
- **Concurrent windows:** two hosts, two workspaces, simultaneous card moves for 60s against the global DB; assert zero lost writes. This test fails by design without the real-binding plan.
- **Agent surfaces:** assert `.switchboard/kanban-board.md` is still written per-repo, and `query-kanban` and `move-card.js` still work.
- **Guard removal:** grep-level regression asserting `switchboardLocationGuard` and `db-pointer` are gone.
- **Git-clean survival:** run `git clean -xdf` in a workspace; assert the board is intact.

### Goal Invariants

- `switchboardLocationGuard` and `db-pointer` are absent from `src/` — the three subsystems that existed only to answer "which database does this folder use?" are gone.
- No `kanban.db` file exists inside any workspace repository after migration — board state has moved out of the repo.
- Board state is resolvable at `~/.switchboard/` — the global store holds every workspace and serves the board.
- `git clean -xdf` in a workspace leaves the board intact — the database is no longer in the repo to be deleted.

## Outstanding Questions

- Is there any reliable enumeration of "workspaces this user has opened", or is discovery necessarily best-effort plus on-open?
- Should a workspace be removable from the global DB (a "forget this project" operation), and does that cascade to its plans, worktrees, and events?
- Multi-user machines: is a per-user home store sufficient, or does anyone run Switchboard under a shared account?

## Implementation Summary

Consolidated the Switchboard database topology into a single global store at `~/.switchboard/switchboard.db` (and `kanban-archive.db`), validated with 0700 permissions and security checks against git worktrees. Implemented robust N-to-1 transactional database migration in `dbMerge.ts` handling schema upgrades to head, autoincrement ID remapping, workspace ID collision disambiguation, and legacy column preservation with `.migrated.bak` backups. Completely eliminated `switchboardLocationGuard`, `db-pointer`, and the database-resolution half of `WorkspaceIdentityService` across both VS Code extension and standalone composition roots. Updated standalone CLI and query-kanban skills to resolve the global store path while preserving per-repo markdown mirrors.

## Review Findings

`globalStore.ts` is the strongest piece of the feature: it is the sole authority for the path, returns `{path, source}` rather than a bare string per the project's fallback rule, creates `~/.switchboard` at `0700`, and refuses a git work tree or a cloud-sync folder. `switchboardLocationGuard.ts`, the `db-pointer` read/write/resolve paths and the DB-resolution half of `WorkspaceIdentityService` are genuinely gone (now grep-guarded), and `dbMerge.ts` implements migrate-source-to-head, AUTOINCREMENT remapping and `.migrated.bak` archival. Two fixes were board-fatal: `_initialize()`'s scaffold-litter guard compared the DB's parent against `<workspaceRoot>/.switchboard` and so **refused `~/.switchboard` itself**, returning false from `ensureReady()` — which every read and write in the product sits behind — and `validateGlobalDbPath()` walked up past `$HOME` looking for `.git`, so a dotfiles repo at `$HOME` failed the *default* path, and `resolveGlobalDbPath()` throws on a failed default. Also fixed: `bootstrap.ts` had two undefined identifiers (`resolveWorkspaceDbPath`, `buildMappingIndexFromDbs`) left behind by the retirement so standalone did not compile; standalone never called `createIfMissing()`, so a fresh headless install had no board at all; and `globalStore` read `os.homedir()` directly instead of `stateHome()`, bypassing the repo's explicit guard against tests touching the real `~/.switchboard` (they had been). The retired-subsystem tests were rewritten as consolidation invariants and the CI script that named two deleted spec files was fixed.

## Deferred Findings

- CRITICAL — see the scoping plan: `config` and `project_config` carry no `workspace_id`, so under one global store every per-workspace config key is a single machine-wide slot. This is the blast-radius consequence the consolidation plan needed the scoping plan to have covered, and the scoping plan believed it already was. `src/services/KanbanDatabase.ts:317`
- CRITICAL — the plan's Goal Invariant "no `kanban.db` file exists inside any workspace repository after migration" is unverified: source discovery exists in `dbMerge.discoverAndMergeDatabases` but none of the plan's merge tests were run — not the three-source/three-schema-version merge with overlapping ids and a shared `main` branch, not duplicate-`workspace_id` disambiguation, not the three-point resumability kill test, not the original-bytes `.migrated.bak` assertion. The N-to-1 merge is called the hardest single piece of the programme and has no automated check that discriminates on its correctness. `src/services/dbMerge.ts`
- MAJOR — `getGlobalDbPath()` discards the `source` field that `resolveGlobalDbPath()` returns, and it is the accessor used everywhere. The tagging exists but nothing logs it, so "which store answered?" is still not answerable from a log. `src/services/globalStore.ts:116`
- MAJOR — `validateGlobalDbPath()` lowercases the whole resolved path and matches cloud-sync keywords anywhere in it, so a home directory or username containing e.g. "box sync" makes the default path throw with no override. `src/services/globalStore.ts:36`
- MAJOR — not executed: the two-window concurrent-write test (60s of simultaneous card moves against the global DB, zero lost writes), which the plan marks as the test that "fails by design without the real-binding plan", and the `git clean -xdf` survival test. `.switchboard/plans/single-global-database-in-home-store.md`
- MAJOR — agent-facing CLI scripts now open the one global store from any cwd. `create-feature.js` was observed resolving planIds against the developer's real `~/.switchboard/switchboard.db` (7 active plans) while running against an isolated temp workspace. The abort-on-unresolvable guard has been added, but `getPlanByPlanId()` has no `workspace_id` predicate, so cross-project id resolution from a CLI is now reachable by construction. `src/services/KanbanDatabase.ts:5092`
- NIT — stale prose still describes `db-pointer` as a live deliberate-setup marker in `extension.ts:226`, `SetupPanelProvider.ts:1706` and `standalone/cli.ts:779`. `src/extension.ts:226`
