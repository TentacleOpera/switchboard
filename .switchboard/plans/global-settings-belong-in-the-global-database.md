# Global settings are a JSON file two boards can both write, and they belong in the global database

## Goal

Move the machine-global settings store out of `~/.switchboard/integration-config.json` and into a `config` table in the global database, behind the `GlobalIntegrationConfigService` facade that already fronts every read and write. Settings stop being a whole-file read-modify-write with no transaction, and stop being a second answer to "where does my data live" sitting beside the database that was supposed to be the first.

### The problem, and the root cause

**Two boards on one machine both write this file, and nothing arbitrates.** The standalone instance guard is scoped to a workspace root, not to the machine — `cli.ts:1234` refuses a second instance only "for `{workspaceRoot}`", and the port probe deliberately falls back to an ephemeral port so a second board on a *different* root starts cleanly. That is correct and intended: an operator with a work board and a personal board runs two. But both processes then read and write one global JSON file holding agents, startup commands, visible agents, scheduler jobs, and the ClickUp/Linear/Notion blocks.

**Defect 1 — lost update.** `saveGlobal(config)` takes the *whole* config object, so every caller performs load → mutate → save. There is no compare-and-swap, no version column, no lock. Two boards interleaving that sequence silently discard one operator's change: A loads, B loads, A saves, B saves, A's edit is gone. Nothing reports it, because from each process's view the write succeeded.

**Defect 2 — a shared, fixed temp path.** The write is atomic per-process:

```ts
const tempPath = `${filePath}.tmp`;
await fs.promises.writeFile(tempPath, content, { encoding: 'utf8', mode: 0o600 });
await fs.promises.rename(tempPath, filePath);
```

`rename` is atomic, but `tempPath` is **fixed, not randomised**. Two processes writing concurrently target the same `integration-config.json.tmp`. One can be mid-`writeFile` when the other renames, publishing a partial document as the live config. This is the mechanism behind a file that has needed recovery repeatedly — `~/.switchboard` currently carries `integration-config.json.bak.before-wsid-repair`, `integration-config.json.pre-restore.bak`, and `integration-config.2026-07-30T19-56-02-577Z.pre-selected-restore.json`, which is what that recovery looks like in practice.

**The existing churn machinery does not address either.** `CHURN_PATHS` and `isSignificantWrite` (`:185`, `:210`) canonicalise and strip `clickup.lastSync` / `linear.lastSync` / `notion.lastSync` so a poll-driven timestamp does not trigger a backup. That is a *backup rotation* fix — it stops the snapshot ring filling with no-op writes. It says nothing about two writers, and cannot: it compares an incoming config against the one this process last read.

**The same reasoning that condemns a synced database condemns this file.** `retire-cloud-file-sync-db-path-presets.md` refuses cloud-folder database targets because "every write rewrites the whole database file" and a second writer "picks a winner, or writes a conflict copy". `integration-config.json` is a whole-file rewrite with two local writers. The argument transfers verbatim; only the blast radius is smaller.

**The root cause is that settings were never given a home, only a file.** `single-global-database-in-home-store.md:25` cites this file as the *precedent* for moving the board — "integration config as living in a single `~/.switchboard` file rather than per-workspace DBs" — and `.gitignore:73-78` records the secrets store making the same journey. Both are used to justify relocating the board. Neither proposes finishing the job. `storage-topology-one-choice-three-stores.md` opens with "where does my data live currently has ten answers" and then defines three stores — Runtime, Board, Archive — none of which is settings. So after the entire storage programme ships, a machine still has a global SQLite database *and* a global JSON file, with settings split across both.

**And they are already split, with the two copies disagreeing.** `agents.startupCommands` exists in the global file *and* as a row in the per-workspace database `config` table. `getStartupCommands` (`TaskViewerProvider.ts:9066`) reads the global file via `getAgentStartupCommands()` — the legacy per-IDE `globalState` fallback and the dead `state.json` fallback were already retired by `two-stores-hold-agent-startup-commands-and-they-disagree.md`, which collapsed the function to a single read. Measured on this install, the file says `lead → devin --permission-mode bypass` while the DB row says `lead → claude`. The DB row is stale and unreachable from code, and reads as authoritative to anyone inspecting the database. This plan resolves the duplicate rather than leaving a silent fallback that misleads the next reader.
  > **Note (Board Collapse 05, decision 12):** the stale per-workspace `agents.*` rows are retired **once**, by `two-stores-hold-agent-startup-commands-and-they-disagree.md`, which lands first and archives them per role. Do not delete them again here; read whatever that plan left as the migration input.

## Metadata

- **Complexity:** 6
- **Tags:** backend, database, reliability, refactor, devops

## User Review Required

None. Four decisions are made here and recorded:

1. **Store shape: a `config` table in the global database, keyed `(key)`, values as JSON text** — matching the per-workspace `config` table's existing shape so `getConfigJson`/`setConfig` semantics carry over unchanged. Not a typed column per setting: the blob is heterogeneous and provider blocks are opaque by design.
2. **Granularity: one row per top-level block** (`agents`, `clickup`, `linear`, `notion`, `scheduler`, `mcpMonitor`, `ticketsAutoSync`, `migrationComplete`), not one row for the whole document. This reduces contention — two boards editing agents and ClickUp respectively no longer touch the same row. **Clarification:** lost-update prevention comes from the database engine (WAL + row-level locking + transactions), not from the row-per-block split. Two boards editing the *same* block (e.g. both editing `agents`) still touch the same row; the engine serialises their writes so neither loses an update. Row-per-block is a contention optimisation, not the correctness mechanism.
3. **The facade stays.** `GlobalIntegrationConfigService`'s 25 public statics keep their signatures. Callers are not touched; only the private load/save underneath changes. This is what keeps the change bounded.
4. **Which database — Clarification.** The settings database is a **separate, machine-global database** opened directly by each process with better-sqlite3 (synchronous, WAL). It is NOT the sidecar-owned board database. The board topology is now per-project (`board-store-one-database-per-project.md` → `~/.switchboard/boards/<workspace-id>.db`); the sidecar owns those per-project board databases and other clients reach them over HTTP (async). Settings are machine-global, not per-project, and six synchronous getters (`loadGlobalSync`, `loadConfigSync`, `getAgentConfigSync`, `getAgentStartupCommandsSync`, `getSchedulerConfigSync`, `getMigratedBoardBatchInterval`) are called from 45 sites in paths that cannot await — including `stateConfigBridge.ts:74`, `KanbanDatabase.ts:12782-12784`, and 14 `loadConfigSync` calls across `PlanningPanelProvider.ts` and `TicketsPanelProvider.ts`. An HTTP-backed settings store breaks every one of them. The settings database must be opened directly. The path is `~/.switchboard/switchboard.db` via `resolveGlobalDbPath()` — the legacy consolidated board path that the per-project topology retires for board state, making it available to repurpose as the machine-global settings database. The dependency on `sidecar-owned-db-real-sqlite-binding.md` is for the **better-sqlite3 binding** (native module packaging, prebuild matrix, the pattern `node-pty` already establishes), not for the sidecar architecture.

## Complexity Audit

### Routine

- Swapping `_loadFromDisk`/`saveGlobal` internals for direct better-sqlite3 reads/writes on `~/.switchboard/switchboard.db`, one row per top-level block, behind unchanged public signatures.
- Deleting the fixed-`tempPath` write once the file is no longer the store.
- Archiving the JSON as `integration-config.json.migrated.bak`.
- Retiring the backup machinery (`_snapshotBeforeWrite`, `_pruneSnapshots`, `CHURN_PATHS`, `isSignificantWrite`, `_stripChurnFields`, `_canonicalStringify`) post-migration — all exist solely for the file-based backup rotation and are dead code once the file is gone.

### Complex / Risky

- **The sync getters.** `loadGlobalSync`, `loadConfigSync`, `getAgentConfigSync`, `getAgentStartupCommandsSync`, `getSchedulerConfigSync`, `getMigratedBoardBatchInterval` are synchronous and called from 45 sites in paths that cannot await. **This is the single largest risk in the plan and the reason it is a 6, not a 3.** The mitigation is decision 4 above: the settings database is opened directly with better-sqlite3, which is synchronous — so the sync getters translate mechanically from `fs.readFileSync` + `JSON.parse` to `db.prepare('SELECT value FROM config WHERE key = ?').get()`. No caller conversion is needed. The risk is not the sync reads themselves but the **bootstrap ordering**: the settings DB must be open before the first sync getter fires, which happens during activation (potentially before the board DB is open). The settings DB and the board DB are separate files with separate lifecycles — the settings DB opening must not depend on the board DB being ready.
- **Bootstrap ordering.** The service is read during activation, potentially before the global database is open. The migration must not deadlock a boot that needs settings to decide where the database lives. The settings DB path (`resolveGlobalDbPath()`) is a pure function of `stateHome()` + env, with no DB dependency, so opening it cannot deadlock on itself.

## Edge-Case & Dependency Audit

**Race Conditions:**
- Two boards writing the same row: better-sqlite3 WAL + `busy_timeout` serialises the writers; the second writer's read-modify-write sees the first's committed data. No lost update.
- Two boards writing different rows: no contention (row-per-block granularity).
- The settings DB is opened directly by each process (not via the sidecar), so there is no sidecar-lifecycle dependency for settings. The board sidecar can be down and settings still work.

**Security:**
- `~/.switchboard/switchboard.db` at `0600`, directory at `0700` — already enforced by `ensureDbPermissions` and `ensureGlobalStoreDir`. The settings DB inherits these.
- The JSON file held secrets-adjacent data (provider tokens are in `secrets.enc`, not here, but provider config blocks name workspaces/teams). The DB file has the same threat surface as the JSON file did.

**Side Effects:**
- The backup machinery (`_snapshotBeforeWrite`, `_pruneSnapshots`, `CHURN_PATHS`, `isSignificantWrite`, `_stripChurnFields`, `_canonicalStringify`) is dead post-migration. Retire it in the same pass — leaving it is dead code that implies a file that no longer exists.
- The `configbackup/` directory and its snapshot ring are orphaned post-migration. Leave the directory and its contents (they are historical backups, not dead config); do not unlink them.

**Dependencies & Conflicts:**
- **First run with no database.** If the settings DB does not exist yet, the service must still answer — fall back to reading the JSON until the DB is available, then migrate on first write. The `loadGlobalSync`/`loadGlobal` methods return `{}` when the file is absent; the DB-backed versions must return `{}` when the DB is absent or the row is missing, preserving the same contract.
- **A workspace opened while another board holds the settings DB.** Row-level writes in one transaction; no whole-document read-modify-write. Two boards may write different rows concurrently without loss. WAL + `busy_timeout` handles the case where both write the same row.
- **The stale per-workspace `agents.*` rows.**

  > **Superseded:** "Delete them as part of the migration, and assert their absence."
  > **Reason:** The Goal's Note (Board Collapse 05, decision 12) already assigns this deletion to `two-stores-hold-agent-startup-commands-and-they-disagree.md`, which lands first and archives them per role. Deleting them again here double-retires state that the other plan already archived, and the per-workspace DB is not the store this plan touches.
  > **Replaced with:** Do not delete the per-workspace `agents.*` rows here. Read whatever `two-stores-hold-agent-startup-commands-and-they-disagree.md` left as the migration input. If that plan has already archived and deleted them, this plan sees nothing and does nothing. If it has not yet run, this plan does not pre-empt it.

- **`~4,000 installs.`** This state shipped. The JSON must be imported before it is archived, never unlinked, per the CLAUDE.md migration rule. A no-op migration on a machine that never had the file must be safe.
- **`mcpMonitor.sourceLastCheckAt`** is a poll timestamp. Post-migration, the `mcpMonitor` block is its own row, and a poll timestamp update rewrites just that row — there is no whole-file backup to churn, so the churn-filtering machinery is irrelevant. Do not add `mcpMonitor.sourceLastCheckAt` to `CHURN_PATHS`; the churn list is being retired with the file.

## Dependencies

- **Hard prerequisite (corrected 2026-09-04, Board Collapse 05, decision 12): `sidecar-owned-db-real-sqlite-binding.md`**, not `single-global-database-in-home-store.md` (which is itself superseded by `board-store-one-database-per-project.md`).
  The blocker is the **binding**, not the store's location and not the sidecar architecture. sql.js holds the whole database in memory and writes the entire image back on each persist, so two processes writing it lose each other's updates exactly as two boards writing this JSON file do today — moving the settings into a sql.js database would change the file extension and nothing else, and row-per-block granularity only protects writers inside one process. Once better-sqlite3 is available as a binding (native module packaging, prebuilds, the pattern `node-pty` already establishes), this plan opens the settings DB directly with it. The sidecar architecture (one process owns the board DB, others use HTTP) is NOT used for settings — the settings DB is a separate file opened directly by each process, because the six sync getters cannot go over async HTTP. This plan is unblocked when the binding lands, not when the sidecar ships.
- **Coordinate with `state-home-derives-from-an-explicit-control-plane.md`** (PARKED in backlog). That plan relocates `integration-config.json` as a file alongside `secrets.enc` and `cache/`. If it lands first, this plan removes the file it just learned to relocate — so this plan's migration step must read from wherever that plan put it, not from a hardcoded `~/.switchboard`. The settings DB path must also honour `stateHome()` (which `resolveGlobalDbPath()` already does via `getGlobalStoreDir()`).
- **Does not depend on** `storage-topology-one-choice-three-stores.md`, but should be reflected in it: settings are a fourth thing its three stores do not cover.
- **Secrets stay out of scope.** `secrets.enc` + `.master-key` remain files. They are encrypted-at-rest with different threat properties and are read-mostly; folding them into a database is a separate argument nobody has made.

## Adversarial Synthesis

Key risks: (1) the plan never named which database — the per-project topology retired the single global board database, and the sidecar architecture (async HTTP) breaks the six sync getters — mitigation: the settings DB is a separate machine-global file (`~/.switchboard/switchboard.db` via `resolveGlobalDbPath()`) opened directly with better-sqlite3 (synchronous), not the sidecar-owned board database; (2) a boot that needs settings to locate the database, from a database that holds the settings — mitigation: the settings DB path is a pure function of `stateHome()` + env with no DB dependency, and the JSON fallback covers the pre-DB window; (3) archiving before importing destroys settings for ~4,000 installs — mitigation: import, verify row counts, then archive as `.migrated.bak`; never unlink; (4) the plan contradicted itself about the `agents.*` rows — mitigation: the Goal's Note is authoritative, the Edge-Case and Proposed Changes that said "delete them" are superseded; (5) the `getStartupCommands` description and the `TaskViewerProvider.ts` proposed change were stale — the two-stores plan already collapsed the fallback chain — mitigation: corrected the line reference and marked the proposed change as already done.

## Proposed Changes

### `src/services/GlobalIntegrationConfigService.ts`

- Replace the private disk load/save with direct better-sqlite3 reads/writes on `~/.switchboard/switchboard.db` (via `resolveGlobalDbPath()`), one row per top-level block. Keep all 25 public signatures unchanged. The sync getters (`loadGlobalSync`, `loadConfigSync`, `getAgentConfigSync`, `getAgentStartupCommandsSync`, `getSchedulerConfigSync`, `getMigratedBoardBatchInterval`) translate from `fs.readFileSync` + `JSON.parse` to `db.prepare('SELECT value FROM config WHERE key = ?').get()` — better-sqlite3 is synchronous, so no caller conversion is needed.
- Open the settings DB lazily on first access (not at module load), with `PRAGMA journal_mode=WAL`, `PRAGMA synchronous=NORMAL`, `PRAGMA busy_timeout=5000`. The DB handle is process-local; each process opens its own connection to the same file.
- Delete the fixed-`tempPath` write path once the file is no longer the store.
- Retire the backup machinery post-migration: `_snapshotBeforeWrite`, `_pruneSnapshots`, `CHURN_PATHS`, `isSignificantWrite`, `_stripChurnFields`, `_canonicalStringify`. These exist solely for the file-based backup rotation and are dead code once the file is gone. Do not add `mcpMonitor.sourceLastCheckAt` to `CHURN_PATHS` — the churn list is being retired.
- Add a one-time migration: if the JSON exists and the config rows are absent, import it, verify, then rename to `integration-config.json.migrated.bak`.

### The global database layer

- Add a `config` table to `~/.switchboard/switchboard.db` mirroring the per-workspace one (`CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT)`). This is the machine-global settings database, separate from the per-project board databases at `~/.switchboard/boards/<workspace-id>.db`. Opened directly by each process with better-sqlite3 — NOT via the sidecar HTTP surface.

### Per-workspace database

  > **Superseded:** "Delete the stale `agents.startupCommands`, `agents.visibleAgents` and `agents.customAgents` rows once the global store is authoritative."
  > **Reason:** The Goal's Note (Board Collapse 05, decision 12) assigns this deletion to `two-stores-hold-agent-startup-commands-and-they-disagree.md`, which lands first and archives them per role. This plan does not touch the per-workspace database.
  > **Replaced with:** Do not delete the per-workspace `agents.*` rows here. Read whatever `two-stores-hold-agent-startup-commands-and-they-disagree.md` left as the migration input. If that plan has already run, there is nothing to do.

### `src/services/TaskViewerProvider.ts`

  > **Superseded:** "Drop the now-dead DB fallback in `getStartupCommands`."
  > **Reason:** This was already done by `two-stores-hold-agent-startup-commands-and-they-disagree.md`. The current `getStartupCommands` (`TaskViewerProvider.ts:9066`) calls `GlobalIntegrationConfigService.getAgentStartupCommands()` exactly once and has no `globalState` fallback, no `state.json` fallback, and no DB fallback.
  > **Replaced with:** No change to `TaskViewerProvider.ts` in this plan. The fallback collapse is already shipped.

## Files Changed

- `src/services/GlobalIntegrationConfigService.ts` — backing store (direct better-sqlite3 on `~/.switchboard/switchboard.db`), migration, backup-machinery retirement
- `src/services/globalStore.ts` — `resolveGlobalDbPath()` is already the sole authority for `~/.switchboard/switchboard.db`; confirm it is not deprecated for the settings use case (it is deprecated as a *board* path, not as a *settings* path)
- Tests — migration, concurrency, and the sync-getter inventory (45 sites)

## Verification Plan

### Automated Tests

1. **Migration imports before archiving.** Given a populated JSON and no rows, assert every block lands as a row, values match, and the file is renamed `.migrated.bak` — not deleted.
2. **No-op on a clean machine.** No JSON, no rows: boot succeeds, no file is written, no error.
3. **Concurrent writers do not lose an update.** Two connections to `~/.switchboard/switchboard.db`; one sets `agents`, the other sets `clickup`; assert both survive. Then two connections setting different sub-keys of the same `agents` row; assert the second write sees the first's committed data (WAL serialisation, no lost update).
4. **No torn read.** Assert no code path writes a fixed `.tmp` beside the config any more.
5. **Sync getters still answer.** Every synchronous public static returns the same value pre- and post-migration. Enumerate all 45 sync call sites (`KanbanDatabase.ts:12782-12784`, `TaskViewerProvider.ts:3402/3514/3575/26004/27436/27462`, `PlanningPanelProvider.ts` ×7, `TicketsPanelProvider.ts` ×7, `stateConfigBridge.ts:74/96`) and assert none regresses.
6. **Stale rows are not touched by this plan.** Assert the per-workspace `agents.*` rows are left as whatever `two-stores-hold-agent-startup-commands-and-they-disagree.md` left — this plan neither deletes nor archives them.
7. **Both hosts.** Extension and standalone composition roots each open the settings DB directly from `resolveGlobalDbPath()` and resolve settings from it. Diff the two roots by hand — the seam each host wires is the DB open, not a verb reachability audit. Neither host reaches settings over the sidecar HTTP surface.
8. **Backup machinery is gone.** Assert `_snapshotBeforeWrite`, `_pruneSnapshots`, `CHURN_PATHS`, `isSignificantWrite`, `_stripChurnFields`, and `_canonicalStringify` are absent from `GlobalIntegrationConfigService.ts` post-migration.

### Goal Invariants

- A `config` table exists in `~/.switchboard/switchboard.db` (via `resolveGlobalDbPath()`) with `PRIMARY KEY (key)` and `value TEXT` columns.
- `integration-config.json` is absent from `~/.switchboard/` (renamed to `integration-config.json.migrated.bak`) after migration runs on a machine that had the file.
- `integration-config.json.migrated.bak` exists on a machine that had the original file (negative: the file is gone from its original name; positive: it is resolvable at the `.migrated.bak` name).
- No code path in `GlobalIntegrationConfigService.ts` writes a file with a `.tmp` suffix.
- `_snapshotBeforeWrite` is absent from `GlobalIntegrationConfigService.ts`.
- `CHURN_PATHS` is absent from `GlobalIntegrationConfigService.ts`.
- `loadGlobalSync()` in `src/services/GlobalIntegrationConfigService.ts` contains no `fs.readFileSync` call (it reads from the DB, not the file).
- `saveGlobal()` in `src/services/GlobalIntegrationConfigService.ts` contains no `fs.promises.writeFile` or `fs.rename` call.
- Count of `fs.readFileSync` calls in `src/services/GlobalIntegrationConfigService.ts` equals 0.
- The settings DB is opened directly (not via HTTP): `GlobalIntegrationConfigService.ts` imports `BetterSqliteDriver` or `better-sqlite3`, not an HTTP client.
