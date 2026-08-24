# Retire the Google Drive, Dropbox and iCloud database-path presets

## Goal

Remove the cloud-storage database-path presets and the custom-DB-path plumbing behind them, and migrate anyone currently pointed at a synced folder back to a safe location. A file-sync folder is not a shared database, and under this codebase's write model it is a corruption generator.

### Problem Analysis

`DATABASE_OPERATIONS_ANALYSIS.md` documents a "Cloud Database Location" panel offering three presets — `db-preset-google-btn`, `db-preset-dropbox-btn`, `db-preset-icloud-btn`, each posting `setPresetDbPath` with `google-drive` / `dropbox` / `icloud` — alongside Edit Path, Test, and Use Local DB. The intent is understandable: put the board where multiple machines can reach it. The mechanism cannot deliver it.

**Why it cannot work.** Every write rewrites the whole database file. `_doPersist()` (`KanbanDatabase.ts:9511`) does `this._db.export()` then writes a randomly-suffixed `.tmp` and renames it over the target. A file-sync client watching that directory sees a full-file replacement on a 300ms debounce (`PERSIST_DEBOUNCE_MS`, `:1643`), and races the rename with its own upload/download. Two machines editing the same synced database do not merge — the syncer picks a winner, or writes a conflict copy, and one machine's entire board is gone.

**The codebase already names this as a cause of its worst failure.** `SCHEMA_WORKTREE_COLUMN_DEFS` (`:953`) exists because a database "stamped at/after V42 whose columns never actually landed (stale `sql.js` image restored from a `.tmp`/backup, a partial persist, or a table recreated by an early V24/V25 path) is NEVER healed" — the version-gated ALTERs do not re-run, `getWorktrees()` throws `no such column`, and the board renders blank. "Stale image restored from a `.tmp`/backup" is precisely what a sync client does when it resurrects a `.tmp` file or rolls back a rename. The feature manufactures the exact state the schema layer has a permanent shim for.

Concurrency control does not help: it is only an mtime baseline (`_loadedMtime`, `:1620`) plus `_reloadIfStale()`. A sync client rewriting the file changes mtime, so the host reloads whatever the syncer left — including a partially downloaded file.

**And a real fix makes it worse, not better.** WAL mode (the real-binding plan) adds `-shm` and `-wal` sidecars that must stay byte-consistent with the main file. `.gitignore:69-70` already anticipates them. No file-sync client offers cross-file atomicity, so a synced WAL database is more fragile than a synced rollback-journal one, not less.

### Root Cause

The feature answers a real need — multi-device access to one board — with the only mechanism available at the time. The need is now served properly: the global home store gives one board per machine, per-project export moves a project between machines deliberately, and `NotionBackupService` already mirrors plans to the cloud for durability and access. The preset is a workaround whose replacements have arrived.

### Non-goals

- Removing the ability to relocate the database entirely. A custom path is legitimate (a different disk, a non-default home). Only *sync-folder* destinations are being refused.
- Building the remote-database option (separate plan).
- Changing the archive path independently of the global-store move.

## Metadata

**Complexity:** 3
**Tags:** database, reliability, ui, refactor, bugfix

## User Review Required

Yes — one decision. For users currently pointed at a synced folder: migrate them silently on next launch with a notification, or refuse to open and require an explicit choice? Recommendation: migrate silently into the global store, notify afterwards, and leave the synced file untouched as a `.migrated.bak`. Refusing to open strands a user with an unreadable board and no obvious next step.

## Complexity Audit

### Routine

- Deleting the three preset buttons and the "Cloud Database Location" preset row from the Database Operations panel.
- Deleting the `setPresetDbPath` message arm and its `google-drive` / `dropbox` / `icloud` branches.
- Deleting the preset path-construction helpers.

### Complex / Risky

- **Detecting a synced destination reliably.** Path-name matching (`Google Drive`, `Dropbox`, `iCloud Drive`, `OneDrive`, `~/Library/Mobile Documents`) is heuristic and locale-dependent — a localised Dropbox folder name will not match. It is good enough to warn but not good enough to be the only guard, so the refusal must be a warning-plus-override for custom paths, and a hard removal only for the *presets*, which are unambiguous because the product constructed them.
- **Migrating an in-place synced database.** The file may be partially synced, locked by the sync client, or already corrupt at the moment of migration. The migration must verify integrity before adopting it, and if the file fails verification it must be preserved untouched and reported rather than merged.
- **A synced DB may be shared by two machines that have both diverged.** There is no merge story and inventing one is out of scope. Each machine migrates the copy it can see into its own global store, and the user is told plainly that the two boards have diverged and where both copies are. Pretending to reconcile them would be worse than saying so.
- **Interaction with the global-store move.** If this ships alongside the consolidation plan, a synced source is just another merge source and reuses `dbMerge.ts`. If it ships first, it needs its own simpler relocation path. Sequencing it after consolidation is cheaper.

## Edge-Case & Dependency Audit

**Race conditions**
- Migrating while the sync client is mid-download: verify integrity, and take a stable read (open read-only, `PRAGMA integrity_check`) before copying. Retry once, then report.

**Security**
- Removing these presets also removes a path by which every project's board state was uploaded to a third-party consumer cloud account, in some cases unintentionally. Worth stating in the release note as a privacy improvement, not just a reliability one.

**Side effects**
- `SetupPanelProvider` owns the DB-path setting; the "Edit Path", "Test", and "Use Local DB" controls stay, so the panel does not lose its purpose.
- `isAllowedSwitchboardLocation` currently gates DB relocation targets (`:1443` logs "Blocked migration to ... not an allowed .switchboard location"). That guard is deleted by the consolidation plan, so the sync-folder warning must not be implemented inside it.
- Any user documentation or screenshots showing the cloud presets need updating.

**Migration**
- The presets shipped in released versions, so per the project rule this is import-before-delete: adopt the synced database into the global store, archive the original as `kanban.db.migrated.bak` in place, never unlink, and preserve unknown/legacy columns.
- Users who set a *custom* path that happens to be synced are detected heuristically and warned, not forcibly moved.

## Dependencies

- **Best sequenced after** the single-global-database plan, so a synced database is handled as one more merge source through `dbMerge.ts` rather than needing bespoke relocation code.
- **Requires** the backup plan's integrity-verification helper for the pre-adoption check.

## Adversarial Synthesis

Key risks: detecting a synced destination reliably is heuristic and locale-dependent (localised folder names won't match); a synced DB may be shared by two machines that have diverged (no merge story, and inventing one is out of scope); and the migration must verify integrity before adopting a synced file (it may be partially synced, locked, or already corrupt). Mitigations: hard removal only for product-constructed presets (unambiguous), warning-plus-override for custom paths; verify `PRAGMA integrity_check` before adoption, preserve untouched on failure; and each machine migrates the copy it can see, with a divergence report naming both locations.

## Proposed Changes

1. **Remove** the three preset buttons and the preset row from the Database Operations panel in the Setup/Implementation webview.
2. **Remove** the `setPresetDbPath` handler and its three path constructors.
3. **Add** a synced-path heuristic that warns (not blocks) when a *custom* DB path looks like a sync folder — `Google Drive`, `Dropbox`, `OneDrive`, `iCloud Drive`, `Library/Mobile Documents` — with an explicit acknowledgement to proceed.
4. **Add** a one-time adoption path: on launch, if the configured DB path is a known preset location, verify integrity, merge into the global store via `dbMerge.ts`, archive the source as `kanban.db.migrated.bak`, and notify. On verification failure, leave everything alone and report.
5. **Divergence notice:** if adoption detects a source whose `workspace_id` set already exists in the global store with differing `updated_at` values, report the divergence and both file locations rather than silently picking a winner.
6. **Update** the Database Operations documentation and any screenshots.

### Migration

Import before delete, archive as `.migrated.bak`, never unlink, preserve unknown columns. A source that fails `PRAGMA integrity_check` is preserved untouched and surfaced to the user.

## Verification Plan

- **Adoption:** configure a DB at a simulated preset path with real rows; launch; assert rows are present in the global store, the source survives as `.migrated.bak` with original bytes, and the notification fired.
- **Corrupt source:** truncate the source mid-file; launch; assert no merge, no data loss, source untouched, clear report.
- **Partially-synced source:** a file with a stale `.tmp` sibling and a mismatched size; assert integrity verification rejects it and the retry-then-report path runs.
- **Divergence:** two sources carrying the same `workspace_id` with different `updated_at`; assert the divergence report names both locations and no silent merge occurs.
- **Preset removal:** grep-level regression asserting `setPresetDbPath`, `db-preset-google-btn`, `db-preset-dropbox-btn`, and `db-preset-icloud-btn` are gone from source.
- **Custom-path warning:** set a custom path under a folder named `Dropbox`; assert a warning with an override, not a hard block. Set one under a localised sync folder name; assert it is *not* detected, confirming the heuristic's stated limits rather than pretending to completeness.
- **Remaining controls:** assert Edit Path, Test, and Use Local DB still function.

### Goal Invariants

- `setPresetDbPath`, `db-preset-google-btn`, `db-preset-dropbox-btn`, and `db-preset-icloud-btn` are absent from `src/` — the preset UI and its handler are gone.
- A custom DB path under a non-sync folder still works — the ability to relocate the database is preserved, only sync-folder destinations are refused.
- A user currently on a preset path is migrated to the global store on next launch, with the source archived as `.migrated.bak` — no data loss.

## Outstanding Questions

- Is there telemetry or any signal for how many installs currently use a preset path? It changes how prominent the release note needs to be.
- Should the adoption path also handle a synced *archive* (DuckDB) path, or is that rare enough to leave to the general archive repointing in the consolidation plan?
