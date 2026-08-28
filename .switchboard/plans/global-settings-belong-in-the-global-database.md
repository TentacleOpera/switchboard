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

**The existing churn machinery does not address either.** `CHURN_PATHS` and `isSignificantWrite` (`:128`, `:153`) canonicalise and strip `clickup.lastSync` / `linear.lastSync` / `notion.lastSync` so a poll-driven timestamp does not trigger a backup. That is a *backup rotation* fix — it stops the snapshot ring filling with no-op writes. It says nothing about two writers, and cannot: it compares an incoming config against the one this process last read.

**The same reasoning that condemns a synced database condemns this file.** `retire-cloud-file-sync-db-path-presets.md` refuses cloud-folder database targets because "every write rewrites the whole database file" and a second writer "picks a winner, or writes a conflict copy". `integration-config.json` is a whole-file rewrite with two local writers. The argument transfers verbatim; only the blast radius is smaller.

**The root cause is that settings were never given a home, only a file.** `single-global-database-in-home-store.md:25` cites this file as the *precedent* for moving the board — "integration config as living in a single `~/.switchboard` file rather than per-workspace DBs" — and `.gitignore:73-78` records the secrets store making the same journey. Both are used to justify relocating the board. Neither proposes finishing the job. `storage-topology-one-choice-three-stores.md` opens with "where does my data live currently has ten answers" and then defines three stores — Runtime, Board, Archive — none of which is settings. So after the entire storage programme ships, a machine still has a global SQLite database *and* a global JSON file, with settings split across both.

**And they are already split, with the two copies disagreeing.** `agents.startupCommands` exists in the global file *and* as a row in the per-workspace database `config` table. `getStartupCommands` (`TaskViewerProvider.ts:7960`) reads the file first, then per-IDE `globalState`, then the DB. Measured on this install, the file says `lead → devin --permission-mode bypass` while the DB row says `lead → claude`. The DB row is stale and unreachable, and reads as authoritative to anyone inspecting the database. This plan resolves the duplicate rather than leaving a silent fallback that misleads the next reader.

## Metadata

- **Complexity:** 6
- **Tags:** backend, database, reliability, refactor, devops

## User Review Required

None. Three decisions are made here and recorded:

1. **Store shape: a `config` table in the global database, keyed `(key)`, values as JSON text** — matching the per-workspace `config` table's existing shape so `getConfigJson`/`setConfig` semantics carry over unchanged. Not a typed column per setting: the blob is heterogeneous and provider blocks are opaque by design.
2. **Granularity: one row per top-level block** (`agents`, `clickup`, `linear`, `notion`, `scheduler`, `mcpMonitor`, `ticketsAutoSync`, `migrationComplete`), not one row for the whole document. This is what removes the lost update — two boards editing agents and ClickUp respectively no longer touch the same row.
3. **The facade stays.** `GlobalIntegrationConfigService`'s 25 public statics keep their signatures. Callers are not touched; only the private load/save underneath changes. This is what keeps the change bounded.

## Complexity Audit

### Routine

- Swapping `_loadFromDisk`/`saveGlobal` internals for DB reads/writes behind unchanged public signatures.
- Deleting the fixed-`tempPath` write once the file is no longer the store.
- Archiving the JSON as `integration-config.json.migrated.bak`.

### Complex / Risky

- **The sync getters.** `loadGlobalSync`, `loadConfigSync`, `getAgentConfigSync`, `getAgentStartupCommandsSync`, `getSchedulerConfigSync`, `getMigratedBoardBatchInterval` are synchronous and called from paths that cannot await. The DB layer must expose a synchronous read for the config table, or these callers must be converted. **Enumerate every sync caller before starting** — this is the single largest risk in the plan and the reason it is a 6, not a 3.
- **Bootstrap ordering.** The service is read during activation, potentially before the global database is open. The migration must not deadlock a boot that needs settings to decide where the database lives.

## Edge-Case & Dependency Audit

- **First run with no database.** If the global DB does not exist yet, the service must still answer — fall back to reading the JSON until the DB is available, then migrate on first write.
- **A workspace opened while another board holds the DB.** Row-level writes in one transaction; no whole-document read-modify-write. Two boards may write different rows concurrently without loss.
- **The stale per-workspace `agents.*` rows.** After migration they are unreachable but still present, and still disagree. Delete them as part of the migration, and assert their absence.
- **`~4,000 installs.`** This state shipped. The JSON must be imported before it is archived, never unlinked, per the CLAUDE.md migration rule. A no-op migration on a machine that never had the file must be safe.
- **`mcpMonitor.sourceLastCheckAt`** is a poll timestamp and belongs on the churn list alongside the three `lastSync` paths once writes are row-scoped — otherwise the `mcpMonitor` row churns on every poll.

## Dependencies

- **Hard prerequisite: `single-global-database-in-home-store.md`** (PLAN REVIEWED). There is no global database to host a config table until that lands. This plan is meaningless before it and obvious after it.
- **Coordinate with `state-home-derives-from-an-explicit-control-plane.md`** (CREATED). That plan relocates `integration-config.json` as a file alongside `secrets.enc` and `cache/`. If it lands first, this plan removes the file it just learned to relocate — so this plan's migration step must read from wherever that plan put it, not from a hardcoded `~/.switchboard`.
- **Does not depend on** `storage-topology-one-choice-three-stores.md`, but should be reflected in it: settings are a fourth thing its three stores do not cover.
- **Secrets stay out of scope.** `secrets.enc` + `.master-key` remain files. They are encrypted-at-rest with different threat properties and are read-mostly; folding them into a database is a separate argument nobody has made.

## Adversarial Synthesis

Key risks. (1) The synchronous getters have no async escape and a partial conversion leaves half the callers reading a store that no longer updates — mitigation: enumerate and convert every sync caller in one pass, and assert zero remaining readers of the JSON. (2) A boot that needs settings to locate the database, from a database that holds the settings — mitigation: keep the JSON fallback for the pre-DB window and migrate on first write, never at read time. (3) Archiving before importing destroys settings for ~4,000 installs — mitigation: import, verify row counts, then archive as `.migrated.bak`; never unlink. (4) Silently leaving the stale per-workspace `agents.*` rows preserves exactly the ambiguity this plan exists to remove — mitigation: delete them and assert absence in a test.

## Proposed Changes

### `src/services/GlobalIntegrationConfigService.ts`

- Replace the private disk load/save with global-DB `config` reads/writes, one row per top-level block. Keep all 25 public signatures unchanged.
- Delete the fixed-`tempPath` write path once the file is no longer the store.
- Add `mcpMonitor.sourceLastCheckAt` to `CHURN_PATHS`; keep `isSignificantWrite` for the pre-migration window and for backup decisions.
- Add a one-time migration: if the JSON exists and the config rows are absent, import it, verify, then rename to `integration-config.json.migrated.bak`.

### The global database layer

- Add a `config` table to the global store mirroring the per-workspace one, with a synchronous read for the sync getters.

### Per-workspace database

- Delete the stale `agents.startupCommands`, `agents.visibleAgents` and `agents.customAgents` rows once the global store is authoritative.

## Files Changed

- `src/services/GlobalIntegrationConfigService.ts` — backing store, migration, churn list
- The global database module — `config` table plus a sync read
- `src/services/TaskViewerProvider.ts` — drop the now-dead DB fallback in `getStartupCommands`
- Tests — migration, concurrency, and the sync-getter inventory

## Verification Plan

1. **Migration imports before archiving.** Given a populated JSON and no rows, assert every block lands as a row, values match, and the file is renamed `.migrated.bak` — not deleted.
2. **No-op on a clean machine.** No JSON, no rows: boot succeeds, no file is written, no error.
3. **Concurrent writers do not lose an update.** Two connections; one sets `agents`, the other sets `clickup`; assert both survive. This is the test that fails today by construction.
4. **No torn read.** Assert no code path writes a fixed `.tmp` beside the config any more.
5. **Sync getters still answer.** Every synchronous public static returns the same value pre- and post-migration.
6. **Stale rows are gone.** Assert the per-workspace `agents.*` rows are absent after migration, and that `getStartupCommands` returns the global value with no DB fallback reachable.
7. **Both hosts.** Extension and standalone composition roots each resolve settings from the new store — diff the two roots by hand; a verb-reachability audit proves nothing here.
