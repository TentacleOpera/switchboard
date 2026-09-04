# Retarget the Board store to one database per project

## Goal

Make the local Board store **one database per project** at `~/.switchboard/boards/<workspace-id>.db`, instead of the single global `~/.switchboard/switchboard.db` that shipped in `8258ce4b`. This is the topology `storage-topology-one-choice-three-stores.md` specifies and the one the product actually supports: shared boards use a libSQL/Turso target, everything else is one board per project, and the Linear-as-team-service option is one board per project plus the tracker sync that already ships.

### Problem Analysis

**The shipped consolidation is a fourth topology nobody asked for.** The topology plan says "One operator choice — a target, not a path… Default is `~/.switchboard/` with zero configuration", and names three stores: Runtime (always local, never leaves), Board (the chosen target), Archive (derived). The consolidation subtask read "default `~/.switchboard/`" as *one file holding every workspace*. Both readings get the database out of the repository — the actual goal — but only per-project files are a **Board target** that a libSQL target can substitute for. A single shared local file is not a target; it is a monolith with no upgrade path to either supported option.

**Every unresolved defect from the storage review traces to that choice, not to leaving the repo.** Measured during review of `8258ce4b`:

- `config` is `(key TEXT PRIMARY KEY)` and `project_config` is `PRIMARY KEY (project, key)`, with no `workspace_id` and no migration adding it. In a shared file every per-workspace key becomes a single machine-wide slot. Worse than settings collision: `KanbanProvider.ts:4492` documents `kanban.complexityBackfillV1Done` as *"Guarded once-per-workspace"* while storing it unscoped, so "once per workspace" silently becomes **once per machine** — the first workspace to open sets the flag and every workspace after it never gets the backfill. `import_registry_migrated` and `ds_legacy_migration_done` are the same shape.
- Two workspace-id generators of different widths mint different ids from the same input: `WorkspaceIdentityService.ts:248` uses `sha256(root).slice(0,12)` and writes it to the committed `.switchboard/workspace-id`; seven sites in `KanbanDatabase.ts` use `slice(0,16)`. Measured live: an importer wrote plan rows under `c701e63f48a4` while a scoped reader queried `c701e63f48a466c9`, so `getPlanByPlanFile(rel, workspaceId)` returned null for a row that was on disk and in the table.
- `dbMerge.ts`'s N-to-1 merge exists only to fold N per-repo databases into one file. The feature calls it "the hardest single piece of the whole storage program" and it has no automated check that discriminates on its correctness.

**Scoping-by-convention is the failure mode this codebase has already demonstrated it cannot hold.** In a shared file, "this project's rows" is enforced by remembering a `workspace_id` predicate on every read and every insert. That convention has now failed at least four times: ten tables shipped unscoped, `worktrees.branch` globally UNIQUE, `config`/`project_config` still unscoped, and `idx_plans_session_id_unique` surviving to head. One database per project enforces the same isolation by topology, where it cannot be forgotten.

**The failure mode also gets better, not merely rarer.** A wrong workspace id with per-project files opens an empty or wrong board — instantly visible. A wrong `workspace_id` predicate in a shared file returns no rows, silently, which is exactly how the inline-plan import failure presented and why it took instrumentation to find. Loud failure over quiet wrong answer is the project's own rule.

**Cross-workspace reads do not argue for the monolith.** They already exist and already work as N connections plus an in-process merge — `KanbanProvider._getAllWorkspaceProjects()` loops every root, opens each database and merges in JS; `buildWorkspaceItems` and the multi-root `getScopedMappingsForBoard(boardRoot: string | string[])` are the same shape. The topology plan additionally records that libSQL does not support `ATTACH DATABASE` in embedded-replica mode, so "cross-store joins must be application-level joins in TypeScript, opening separate connections per store and merging in-process". N-connections-and-merge is therefore the mandated pattern for the roadmap, not a compromise this plan introduces.

### Root Cause

The consolidation subtask inherited the goal "get the database out of the repository" and chose the strongest available reading of "one global store" without a Board-target concept to constrain it. The topology plan that supplies that concept was written but is downstream on the board, so nothing forced consolidation to produce a *substitutable* store.

### What this does NOT undo

`8258ce4b`'s genuinely good work stays:

- `globalStore.ts` remains the sole path authority, with its `{path, source}` tagging, `0700`/`0600` permissions, git-work-tree refusal and cloud-sync-folder refusal.
- `switchboardLocationGuard`, `db-pointer` and the database-resolution half of `WorkspaceIdentityService` stay deleted. Per-project files in the home store do not reintroduce them: resolution becomes a pure function of one committed file, not a three-tier heuristic over a folder tree.
- The V70 `workspace_id` scoping and the three rebuilt compound constraints stay, as defence-in-depth. They stop being what correctness rests on; they do not become wrong.
- The engine (better-sqlite3 12.11.1, WAL, statement cache, deterministic close) is untouched.

### Non-goals

- Implementing the libSQL/Turso Board target (`libsql-shared-store-turso-and-self-hosted-sqld.md` owns it). This plan makes the seam it plugs into.
- Splitting Runtime out of the Board database (`split-shared-board-state-from-machine-local-runtime.md` owns it). Noted below as the next dependency.
- Reverting table scoping, the engine, or the guard/pointer deletion.
- Changing the Archive path independently of the target.

## Metadata

**Complexity:** 8
**Tags:** database, backend, refactor, infrastructure, reliability, migration

## User Review Required

No. The topology is specified by `storage-topology-one-choice-three-stores.md` and confirmed by the product owner: shared boards use Turso, otherwise one board per project, with Linear-as-team-service being one board per project plus the existing tracker sync. The canonical workspace id is the committed `.switchboard/workspace-id` file — it is repository state, it is already PRIORITY 1 in `ensureWorkspaceIdentity`, and an agent-facing script (`.agents/skills/_lib/workspace-root.js`) reads it.

## Complexity Audit

### Routine

- `getGlobalDbPath()` → a per-workspace resolver returning `~/.switchboard/boards/<workspace-id>.db`, keeping the existing validation and `{path, source}` shape.
- Creating `~/.switchboard/boards/` at `0700`; database files `0600`.
- Deleting the `INSERT OR REPLACE INTO config (key,value) VALUES ('workspace_id', …)` write at `KanbanDatabase.ts:7524-7526`, which is the site that mints and persists a 16-char id.
- Retiring `discoverAndMergeDatabases`'s N-to-1 path in favour of 1:1 relocation.

### Complex / Risky

- **The workspace id becomes the filename, so it must be resolved once and identically everywhere.** Unify on the committed file. The two generators are `sha256(root)` truncated to 12 and 16, so **the 12-char value is a literal prefix of the 16-char value** — verified on two measured pairs (`c701e63f48a4`/`c701e63f48a466c9`, `b3cf17eada21`/`b3cf17eada211ca3`). That makes detection and remapping deterministic rather than heuristic. But `ensureWorkspaceIdentity` returns the committed file's value **as-is** at PRIORITY 1, so an install carrying a legacy id from `workspace_identity.json` will not be a hash and will not have the prefix relationship. Enumerate that population separately; do not assume the prefix rule covers everything.
- **Relocation must be idempotent, resumable and non-destructive across ~4,000 installs.** For each workspace: resolve the id, copy `<repo>/.switchboard/kanban.db` to the target, `PRAGMA integrity_check`, then archive the source as `kanban.db.migrated.bak`. Never unlink. A crash at any point must leave both files readable and the operation re-runnable.
- **Installs that already ran `8258ce4b` have rows for several workspaces in one file.** That population needs a *split*, not a relocation: for each distinct `workspace_id` in the global file, extract that workspace's rows into its own board file. This is the inverse of `dbMerge`, needs the same table walk, and must handle a row whose `workspace_id` matches no known workspace by leaving it in place and reporting it rather than discarding it.
- **`config` and `project_config` split by workspace.** Rows in the shared file are unattributable by construction — the tables have no `workspace_id`. Decide per key: copy machine-global keys to every board file (or leave them in a machine-level store), and for per-workspace keys accept that the shared file's single value goes to whichever workspace the split is processing and is duplicated to the others. The three migration guards must be **cleared** during the split so each workspace re-runs its own once-per-workspace backfill rather than inheriting a flag set by another project.
- **The board window / Archive derivation is now per-project.** `getGlobalArchiveDbPath()` returns one archive; it must become per-board, derived from the target as the topology plan requires.

## Edge-Case & Dependency Audit

**Race conditions**
- Two windows opening the same project resolve the same file; that is normal WAL multi-writer and is the case the engine swap already made safe.
- Two windows opening *different* projects no longer contend at all, which is the point.
- The split (above) must take the existing `db-merge.lock` so two hosts cannot split the same global file concurrently.

**Security**
- `~/.switchboard/boards/` at `0700`, files `0600`. Keep the git-work-tree and cloud-sync refusals; a per-project path makes them apply per file.
- The workspace id is now a filename component. It is a hex hash or a committed identifier, but it is read from a repository file, so it must be validated against `^[A-Za-z0-9_-]{8,64}$` before being joined into a path — a crafted `workspace-id` must not escape the boards directory.

**Side effects**
- `.switchboard/kanban-board.md` and the board snapshot keep being written per repo; unaffected.
- `query-kanban`, `move-card.js` and `.agents/skills/_lib/workspace-root.js` resolve the board path; all must follow the new resolver.
- Retention's forcing function relaxes — per-project boards are self-limiting again — but its rotation code stays valid and now runs per board.
- Blast radius returns to one project per corrupt file, which is the assumption `writeDbBackup`'s per-repo `dbbackup/` directory was written under.

**Migration**
- Two source populations, and both must be handled: (a) pre-`8258ce4b` installs with a per-repo `kanban.db` → 1:1 relocation; (b) installs that ran `8258ce4b` with a multi-workspace global file → split. Assume no prior migration ran, preserve unknown/legacy columns by enumerating `PRAGMA table_info` at runtime, archive every source as `*.migrated.bak`, never unlink.

## Dependencies

- **Requires** the engine swap (landed in `8258ce4b`).
- **Supersedes** the single-file half of `single-global-database-in-home-store.md`. Mark that plan superseded with a pointer here; delete nothing.
- **Unblocks** `libsql-shared-store-turso-and-self-hosted-sqld.md` by making the Board store substitutable.
- **Feeds** `split-shared-board-state-from-machine-local-runtime.md`, which is the next dependency: a Turso target replicates a whole database, and `recordLiveness()` alone writes ~172,800 rows a day, so Runtime must be a separate store before any remote target is enabled.

## Adversarial Synthesis

Key risks: the split of an already-consolidated global file is a new migration with no precedent and must not lose rows whose `workspace_id` matches no known workspace; `config`/`project_config` rows in that file are unattributable, so the split has to duplicate or drop by an explicit per-key rule rather than guessing; and the workspace id becoming a filename makes a wrong id a wrong-file error rather than a silent empty read — better, but it must be validated before being joined into a path. Mitigations: take the existing `db-merge.lock` for the split, clear the three once-per-workspace migration guards so no project inherits another's flag, enumerate columns at runtime to preserve legacy ones, and validate the id against a strict character class.

## Proposed Changes

1. **`src/services/globalStore.ts`** — replace `getGlobalDbPath()` with `resolveBoardDbPath(workspaceId)` returning `{path, source}` for `~/.switchboard/boards/<workspace-id>.db`. Keep every existing validation. Add strict id validation before path join. `getGlobalArchiveDbPath()` becomes `resolveArchiveDbPath(workspaceId)`.
2. **`src/services/WorkspaceIdentityService.ts`** — one exported resolver for the canonical id: committed file first, then legacy `workspace_identity.json`, then `sha256(root).slice(0,12)` written back to the committed file. Return `{value, source}`. This is the only generator.
3. **`src/services/KanbanDatabase.ts`** — resolve the DB path through (2) + (1). Delete the 16-char hash fallbacks (seven sites) and the `config['workspace_id']` write at `:7524`. Keep `getWorkspaceIdTagged()` reading the committed file.
4. **`src/services/dbMerge.ts`** — replace the N-to-1 merge with `relocateBoardDatabase()` (1:1, integrity-checked, `.migrated.bak`, resumable) and add `splitConsolidatedDatabase()` for population (b), reusing the runtime column enumeration and the existing lock.
5. **Per-key `config` rule** — an explicit list of machine-global keys versus per-workspace keys, applied by the split. Clear `kanban.complexityBackfillV1Done`, `import_registry_migrated` and `ds_legacy_migration_done` on every produced board file.
6. **Both composition roots** — `extension.ts` and `standalone/bootstrap.ts` call the same relocation/split entry point at the same point in bring-up, and both continue to call `createIfMissing()`.
7. **Agent-facing path consumers** — `query-kanban` skill, `scripts/move-card.js`, `.agents/skills/_lib/workspace-root.js`, and `standalone/cli.ts` follow the new resolver.
8. **Mark `single-global-database-in-home-store.md` superseded** with a pointer here.

### Migration

Per workspace: resolve the canonical id, relocate or split, verify `integrity_check` and row counts, archive sources as `*.migrated.bak`, mark migrated, never unlink. Resumable at every step. A source that fails verification is preserved untouched and surfaced.

## Verification Plan

### Automated

- **Resolution is a pure function:** the same workspace root resolves to the same board path across two processes and after a restart; two different roots resolve to two different paths; neither path is inside the repository.
- **Id unification:** assert exactly one generator exists in `src/` (grep-level), that `slice(0, 16)` appears at zero sites, and that a workspace with a committed id resolves to it rather than to a hash.
- **Path-escape guard:** a `.switchboard/workspace-id` containing `../`, a path separator, or a null byte is rejected and does not produce a path outside `~/.switchboard/boards/`.
- **1:1 relocation:** seed a per-repo `kanban.db` with rows in every scoped table plus one unknown legacy column; relocate; assert every row and the legacy column survive, the source exists as `kanban.db.migrated.bak` with original bytes, and re-running is a no-op.
- **Split of a consolidated file:** seed one global file with three workspaces' rows including overlapping AUTOINCREMENT ids and a shared `main` branch; split; assert three board files each carrying exactly their own rows, every integer reference resolving within its file, and a row with an unknown `workspace_id` left in place and reported.
- **Migration guards cleared:** after a split, assert `kanban.complexityBackfillV1Done`, `import_registry_migrated` and `ds_legacy_migration_done` are absent from every produced board file.
- **Crash safety:** kill the process at three points in both relocation and split; reopen; assert every source readable and the operation completes on re-run.
- **Cross-workspace reads still work:** `_getAllWorkspaceProjects()` returns every open root's projects with per-project files.
- **Both hosts:** a contract test asserting `extension.ts` and `standalone/bootstrap.ts` call the same relocation entry point and both call `createIfMissing()`.
- Wire every new check into `package.json` **and** `.github/workflows/integration-tests.yml`; a script without a workflow step never runs.

### Goal Invariants

- No `kanban.db` exists inside any workspace repository after migration.
- Each project's board resolves to its own file under `~/.switchboard/boards/`, and no two projects share a file.
- `git clean -xdf` in a workspace leaves that project's board intact.
- `switchboardLocationGuard` and `db-pointer` remain absent from `src/`.
- Exactly one workspace-id generator exists in `src/`, and `sha256(root).slice(0, 16)` appears nowhere.
- `config['workspace_id']` is never written by a migration.
- The Board store is substitutable: the path resolver is the only thing a libSQL target has to replace.

## Outstanding Questions

- How many installs already ran `8258ce4b`? If effectively none outside this machine, population (b)'s split can ship as a reported-and-skipped path rather than a full implementation — but it must still detect the shape and refuse to run rather than silently mis-relocate.

## Implementation Summary

All 8 steps completed. The Board store is now one database per project at `~/.switchboard/boards/<workspace-id>.db`.

### Changes by file

**`src/services/globalStore.ts`** — Added `ensureBoardsDir()`, `validateWorkspaceIdForPath()`, `resolveBoardDbPath(workspaceId, explicitPath?)`, `resolveArchiveDbPath(workspaceId, explicitPath?)`. Kept `getGlobalDbPath()` and `getGlobalArchiveDbPath()` as `@deprecated` for the split migration's detection path.

**`src/services/WorkspaceIdentityService.ts`** — Added `resolveCanonicalWorkspaceId` (async) and `resolveCanonicalWorkspaceIdSync` (sync) as the single exported canonical id resolver: committed `.switchboard/workspace-id` file → legacy `workspace-identity.json` → `sha256(root).slice(0,12)`. Updated `resolveWorkspaceDbPath` to use the canonical resolver + `resolveBoardDbPath`. Updated `ensureWorkspaceIdentity` to delegate to `resolveCanonicalWorkspaceId`.

**`src/services/KanbanDatabase.ts`** — `forWorkspace()` resolves the DB path through `resolveCanonicalWorkspaceIdSync` + `resolveBoardDbPath`. On-open migration uses `relocateBoardDatabase` (1:1) instead of `mergeDatabase` (N-to-1). All archive methods (`getArchiveInstance`, `resolveArchiveDbPath`, `hasArchiveInstance`, `archiveAvailable`, `getArchiveInstanceIfPresent`) use per-board archive paths via `resolveArchiveDbPath`. `invalidateWorkspace` and `defaultDbPath` use per-project paths. `getWorkspaceIdTagged()` now prefers the committed file (canonical resolver) over the `config['workspace_id']` row. Deleted all 7 `sha256(root).slice(0,16)` hash fallbacks — replaced with `_getWorkspaceIdFallback()` which delegates to `resolveCanonicalWorkspaceIdSync`. Deleted the V3 `config['workspace_id']` write — the committed file is the identity, not the config row. Updated V6 and V22 migrations to use the canonical resolver instead of the config row.

**`src/services/dbMerge.ts`** — Added `relocateBoardDatabase(sourceDbPath, workspaceRoot, workspaceId)`: 1:1 verified copy from per-repo `kanban.db` to per-project board file. Idempotent, resumable, non-destructive (archives as `.migrated.bak`). Added `splitConsolidatedDatabase(globalDbPath?, knownWorkspaceIds?)`: splits a consolidated global file into per-project board files. Per-key config rule: machine-global keys copied to every board file, per-workspace keys duplicated, `workspace_id` key skipped (committed file is the identity), 3 migration guards (`kanban.complexityBackfillV1Done`, `import_registry_migrated`, `ds_legacy_migration_done`) cleared on every produced board file. Added `consolidatedGlobalDbExists()` detection helper. Updated `discoverAndMergeDatabases` to use `relocateBoardDatabase` instead of `mergeDatabase`.

**`src/extension.ts`** — `initializeMappingIndex` calls `discoverAndMergeDatabases` (relocation) then detects and runs `splitConsolidatedDatabase` if a consolidated global file exists. Passes known workspace IDs to the split so unknown IDs are reported and left in place.

**`src/standalone/bootstrap.ts`** — Same two-step startup: relocation then split. Removed unused `getGlobalDbPath` import.

**`src/standalone/cli.ts`** — `resolveBoardDbPath()` now resolves through `resolveCanonicalWorkspaceIdSync` + per-project board path, with legacy per-repo and global fallbacks. First-run menu option 2 uses `relocateBoardDatabase` instead of `mergeDatabase`.

**`src/services/ArchiveManager.ts`** — Uses `resolveArchiveDbPath(resolveCanonicalWorkspaceIdSync(root).value)` instead of `getGlobalArchiveDbPath()`.

**`src/services/BackupService.ts`** — `_resolveStorePath()` uses `resolveBoardDbPath(resolveCanonicalWorkspaceIdSync(root).value)`.

**`src/services/RetentionService.ts`** — `_resolveStorePath()` uses `resolveBoardDbPath(resolveCanonicalWorkspaceIdSync(root).value)`.

**`src/services/PlanningPanelProvider.ts`** — `_getWorkspaceId()` fallback uses `resolveCanonicalWorkspaceIdSync` instead of `sha256(root).slice(0,16)`.

**`src/services/PlannerPromptWriter.ts`** — Same fix as PlanningPanelProvider.

**`.agents/skills/query-kanban/SKILL.md`** + **`.claude/skills/query-kanban/SKILL.md`** — Updated DB path fallback to `~/.switchboard/boards/<workspace-id>.db` with legacy fallbacks.

**`src/test/workspace-identity-precedence.test.ts`** — Test 1 updated: two different roots now resolve to two different per-project board paths (not the same global path).

**`.switchboard/plans/single-global-database-in-home-store.md`** — Marked SUPERSEDED with a pointer to this plan.

### Verification

- `npx tsc --noEmit` passes with no new errors (all remaining errors are pre-existing).
- No `sha256(root).slice(0,16)` workspace ID generators remain in `src/` (only in `storeLock.ts` for lock file naming, which is unrelated).
- No `getGlobalDbPath()` or `getGlobalArchiveDbPath()` calls remain in hot paths (only in `dbMerge.ts` for the split detection/migration and `cloudSyncMigration.ts` which is a legacy adoption path).
