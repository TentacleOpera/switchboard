# Durable board backups and per-project export/import for the global database

## Goal

Make loss of the board a recoverable event rather than a rescue operation, and make "hand this project to someone else" a supported action once the database no longer lives in the repository. Ship scheduled point-in-time backups of the global database plus a per-workspace export/import format.

### Problem Analysis

Two things change the moment the database becomes one global file, and both invert the current risk posture.

**Blast radius.** Today a corrupt or lost `kanban.db` costs one project. After consolidation it costs every project the user has. The existing `_writeKanbanStateBackup` is currently folded onto the coalesced persist tick inside `KanbanDatabase`, which makes it a side effect of writing rather than a backup regime: there is no retention, no point-in-time set, no integrity check, and no restore path a user can find.

**Portability.** Today "give this project to a colleague" is `git clone` — the plans are committed markdown, and whatever board state existed was incidental. After consolidation, board state lives in the user's home store and is not in the repo at all, so there is no way to move a project's workflow state between machines or people without an explicit export.

There is prior intent here: the commit "plans: add board-state backup discoverability + portable export/import" exists in history, which is the same conclusion reached from the other direction. This plan makes it a dependency of consolidation rather than a follow-up.

**What actually needs protecting is narrower than the whole database.** The DB is substantially a derived index over committed markdown — `PlanIngestionEngine` reconstructs plan rows from `.md` files on import, and `**Feature:**` / `**Project:**` relationships ride in the frontmatter. So plan identity and grouping survive a total loss by re-ingesting the repo. What does *not* survive is workflow state that exists only in the DB: column position (the schema comment at `KanbanDatabase.ts:874` is explicit that "a file re-import must never yank a card out of its column"), `dispatched_terminal`, `dispatched_at`, `last_liveness_at`, `blocked_at`, `worktrees` rows, `config`, `project_config`, `projects`, and the `plan_events` history. That set is the backup's real payload, and it is small.

### Root Cause

Backup was implemented as an incidental write alongside persistence, at a time when the database was per-repo, disposable, and re-derivable from committed files. Consolidation removes all three of those properties at once.

### Non-goals

- Cloud/remote backup destinations. `NotionBackupService` already provides a cloud mirror of plans, which covers durability-and-access without making the network a dependency.
- Backing up the markdown. That is git's job and it already does it.
- Cross-user merge of imported projects. Import targets a workspace id that does not already exist, or refuses.

## Metadata

**Complexity:** 6
**Tags:** database, reliability, backend, feature, devops

## User Review Required

Yes — two decisions:

1. **Backup cadence and retention.** Recommendation: SQLite Online Backup API on a timer (hourly while the sidecar is up) plus one on clean shutdown, keeping 24 hourly / 7 daily, in `~/.switchboard/backups/`. Confirm the retention numbers and whether a size cap is wanted.
2. **Export format.** A single SQLite file containing only that workspace's rows, or a JSON/JSONL bundle? Recommendation: SQLite file — it round-trips exactly, needs no serialiser to maintain alongside the schema, and can be opened by the same code path as a merge source. JSON is more diffable but will drift from the schema.

## Complexity Audit

### Routine

- A `backups/` directory under the global store, created `0700`.
- A timer in the sidecar driving the backup, and one on graceful shutdown.
- Retention pruning (count-based, oldest-first).
- A Setup-panel section listing backups with timestamp and size, and a restore action. Per the project rule, the restore button acts immediately with no confirmation dialog — it is a deliberate, hard-to-misclick control, and `window.confirm()` is a silent no-op in webviews anyway.

### Complex / Risky

- **Backup must not be a file copy.** Copying a WAL-mode database while the sidecar holds it open produces a torn file. It must use SQLite's Online Backup API (`better-sqlite3`'s `.backup()`), which is transactionally consistent against a live writer. This is the single most important correctness point in the plan.
- **Integrity verification.** A backup nobody has verified is not a backup. Each completed backup should be opened and `PRAGMA integrity_check`-ed before it is counted toward retention, and a failing backup must not evict a good one.
- **Restore is a whole-database swap.** Restoring replaces every project, not one. The sidecar must be the only holder, the current DB must itself be backed up first (as `pre-restore`), and every connected client must be told to reload rather than continuing against a swapped-out file.
- **Per-project export must carry a consistent row set across ~19 tables.** Extracting one `workspace_id` means walking every scoped table (this depends on the unscoped-tables plan having scoped all of them) *plus* remapping the `AUTOINCREMENT` integer ids so the export is self-consistent — the same old-id-to-new-id problem as the N-to-1 merge, in the opposite direction. Reuse `dbMerge.ts`'s remap machinery rather than writing a second implementation.
- **Import is a merge, not a copy.** An imported project lands in a DB that already has rows and its own id sequences. It is exactly a single-source N-to-1 merge, so it should go through the same code path.

## Edge-Case & Dependency Audit

**Race conditions**
- Backup timer firing during a merge or a migration: take the same lock the merge uses, and skip rather than queue.
- Restore while another window is live: the sidecar must reject the restore or force all clients to reconnect. A client holding a stale handle across a restore is the clobber bug again, in a new costume.

**Security**
- Backups aggregate every project. `0600` files in a `0700` directory. Refuse to write backups into a git work tree or a known cloud-sync folder — the latter reintroduces exactly the file-syncer hazard the preset-retirement plan removes.
- An imported export file is untrusted input: it is a SQLite database from elsewhere. Open it read-only, verify `integrity_check` and its schema version before reading, and never run its contents as SQL.

**Side effects**
- Removing `_writeKanbanStateBackup` from the persist tick changes nothing user-visible but does remove a write per card move.
- Export gives a sanctioned way to move a project between machines, which is what replaces the multi-device story the cloud-path presets were reaching for.

**Migration**
- No schema change to user data. Any pre-existing `kanban-state` backup files written by the old path should be left in place, not deleted, and listed in the UI if they parse.

## Dependencies

- **Requires** the sidecar/real-binding plan (Online Backup API needs a real binding; single ownership makes restore safe).
- **Requires** the unscoped-tables plan (per-project export needs every table scoped by `workspace_id`).
- **Is a hard prerequisite of** the single-global-database plan, because of the blast-radius inversion.
- Reuses `dbMerge.ts` from the global-database plan for export/import id remapping — so in practice these two land together, with the merge machinery built once.

## Adversarial Synthesis

Key risks: backup must use SQLite's Online Backup API (not file copy — a WAL-mode database copied live produces a torn file); restore is a whole-database swap that replaces every project (sidecar must be sole holder, current DB backed up first, all clients told to reload); and per-project export must remap AUTOINCREMENT integer ids across ~19 tables consistently (same old-id-to-new-id problem as the N-to-1 merge). Mitigations: reuse `dbMerge.ts`'s remap machinery for export/import; verify each backup with `PRAGMA integrity_check` before counting toward retention; and refuse backup destinations inside git work trees or sync folders.

## Proposed Changes

1. **`src/services/BackupService.ts` (new).** Timer-driven and shutdown-driven Online Backup API snapshots into `~/.switchboard/backups/`, each verified with `PRAGMA integrity_check` before counting toward retention; count-based pruning; a `pre-restore` snapshot before any restore.
2. **Restore path** in the sidecar: acquire exclusive ownership, snapshot current, swap, signal all clients to reload.
3. **`src/services/projectExport.ts` (new).** Export one `workspace_id` across every scoped table into a standalone SQLite file with remapped ids, reusing `dbMerge.ts`. Import routes through the merge as a single source.
4. **Setup panel section** listing backups (timestamp, size, integrity status) with immediate-acting restore, plus export/import actions per workspace.
5. **Remove** `_writeKanbanStateBackup` from the persist path once `BackupService` covers it; keep reading any legacy backup files it produced.
6. **`LocalApiServer`** verbs for backup/restore/export/import, validated in `verbSchemas.ts`.

### Migration

None for user data. Legacy `kanban-state` backup files are preserved and listed, never deleted.

## Verification Plan

- **Live-writer consistency:** drive continuous card moves while a backup runs; open the backup; assert `integrity_check` passes and the row set is a consistent point-in-time (no half-written transaction).
- **Torn-copy contrast test:** demonstrate that a naive `fs.copyFile` of the live WAL database *fails* `integrity_check` under the same load, proving the Online Backup API path is doing real work.
- **Retention:** generate 40 hourly backups; assert 24 hourly + 7 daily survive, oldest-first pruning, and that a corrupt backup never evicts a good one.
- **Restore:** restore a known-good backup over a mutated DB; assert every project matches the backup, a `pre-restore` snapshot exists, and connected clients reloaded rather than serving stale reads.
- **Export/import round-trip:** export workspace A from a three-workspace DB; import into an empty DB; assert every scoped table's rows match, all integer references resolve, and no id collides. Then import into a DB that already has workspaces B and C and assert A lands intact with remapped ids.
- **Hostile import:** feed import a truncated file, a non-SQLite file, and a DB with a newer schema version; assert each is rejected with a clear message and no partial write.
- **Path refusal:** assert backups refuse a destination inside a git work tree or a known sync folder.

## Outstanding Questions

- Should export include the workspace's markdown plans as well, producing a fully self-contained bundle, or stay DB-only on the assumption the recipient has the repo?
- Does restore need to be per-project (restore only workspace A from a full backup)? That is export/import applied to a backup file, so it is nearly free — worth confirming whether users will expect it.
