# Consolidate to one global database in ~/.switchboard and retire the location guard, db-pointer and mapping subsystem

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
- **Enables:** the pluggable-backend plan (this is already the cloud topology).

## Adversarial Synthesis

**"One database is a single point of failure."** Correct, and that is the real cost. It is answered by the prerequisites, not by avoidance: WAL plus real transactions removes the whole-file-clobber failure mode, and backup-plus-export makes recovery a supported operation instead of a rescue. Note also the mitigating asymmetry — the DB is substantially a *derived* index over committed markdown (`PlanIngestionEngine` reconstructs rows from `.md` on import; `**Feature:**` and `**Project:**` links ride in the frontmatter), so identity and relationships survive a total loss. What does not survive is workflow state: column position (the comment at `:874` is explicit that "a file re-import must never yank a card out of its column"), `dispatched_at`, `blocked_at`, worktrees, config. That set is what the migration and the backups must protect.

**"Keep per-workspace DBs, just move them to ~/.switchboard/<id>/."** Genuinely viable and much cheaper — it fixes the location problem, kills the guard and `db-pointer`, and avoids the merge entirely. It does not give cross-project views, does not remove the multi-instance handle management, and does not match the target topology for a future shared backend. The choice is scope, not correctness; recorded here so it is a decision rather than an omission.

**"The merge is too risky for 4,000 installs."** Which is why it is incremental and repeatable rather than a one-shot upgrade step: each source merges when discovered, archived not deleted, and a source that cannot reach head is reported and left alone. A user whose old project never gets reopened is never at risk.

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

## Outstanding Questions

- Is there any reliable enumeration of "workspaces this user has opened", or is discovery necessarily best-effort plus on-open?
- Should a workspace be removable from the global DB (a "forget this project" operation), and does that cascade to its plans, worktrees, and events?
- Multi-user machines: is a per-user home store sufficient, or does anyone run Switchboard under a shared account?
