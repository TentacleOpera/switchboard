---
description: 'Storage layer overhaul: real engine, one global store, durable persistence'
---

# Storage layer overhaul: real engine, one global store, durable persistence

## Goal

Replace the storage foundation underneath the Switchboard board. Today `kanban.db` is a `sql.js` image held entirely in RAM, rewritten in full on every write, living inside the repository, with one database per workspace. That single set of choices is the shared root cause of four separate problems: silent whole-database clobber between concurrent in-memory images, a 500 MB resident budget plus an LRU eviction subsystem and six enumerated leak mechanisms for a metadata-only schema, an entire location-guard/`db-pointer`/workspace-mapping apparatus that exists only to answer "which database does this folder use?", and no coherent story for long-term persistence across projects.

The end state: one global SQLite database in `~/.switchboard`, owned by a single sidecar process using a real SQLite binding with WAL, holding every workspace at once, with verified backups, per-project export/import, a defined retention policy, and an optional libSQL remote backend for anyone who wants their board state in a cloud database without losing offline operation.

Deliberately **not** Postgres. The measured dialect coupling (18 load-bearing `rowid` sites, 13 `AUTOINCREMENT`, 6 `PRAGMA`, 15 `datetime('now')`), the loss of offline operation, and a mandatory data migration across ~4,000 installs buy nothing that a real SQLite binding does not already deliver. What is worth taking from the hosted tools is the *data model* — one store, many projects, stable ids, cross-project views — not the deployment model.

## How the Subtasks Achieve This

- **Move the database behind a single sidecar owner and replace sql.js with a real SQLite binding**: the foundation. Puts one process in charge of the database and swaps export-the-world for page-level writes and WAL. Deletes the persist debounce, the 500 MB resident budget, the eviction sweep, and the stale-image reload path. Dodges the Electron ABI wall that made `better-sqlite3` unworkable before, by placing the owner outside the extension host. Recommends `@libsql/client` in local-file mode as the binding — libSQL *is* SQLite, so the dialect is unchanged, and because the same client selects local, replica or remote purely by URL, this one choice collapses most of the final subtask into configuration. Everything else depends on this.
- **Scope the ten unscoped tables by workspace_id and fix three colliding unique constraints**: makes the schema able to hold more than one workspace. Nine tables gain `workspace_id`; `worktrees.branch UNIQUE`, `job_instructions.file UNIQUE`, and `kanban_meta.key PRIMARY KEY` are rebuilt with workspace scope. Without this, consolidation fails on the first project that also has a `main` branch.
- **Enforce one database instance per path and fix the is_feature clobber**: closes an investigation open since July 2025. The stale-image half is dissolved by the engine swap; the `updateFeatureStatus` wrong-row half is arithmetic on ids and survives any storage change, so it needs its own fix. Ships independently of the rest.
- **Durable board backups and per-project export/import**: consolidation inverts the blast radius — one corrupt file would cost every project rather than one. Adds Online Backup API snapshots with integrity verification and retention, plus a per-workspace export format so "hand this project to someone else" still works once board state is no longer in the repo.
- **Consolidate to one global database in ~/.switchboard**: the centrepiece. Moves board state out of the repository into the home store as a single database holding every workspace, migrates existing per-workspace databases in with an N-to-1 merge, and deletes the location guard, `db-pointer`, and the database-resolution half of the mapping subsystem. Follows the path the secrets store and integration config already took.
- **Retention and archive policy for a global database that never gets deleted**: consolidation plus long-term persistence removes both mechanisms that used to bound database size. Ships size reporting first, then a rotation policy for the four append-only tables, with dormant-workspace archival — non-destructive throughout.
- **Retire the Google Drive, Dropbox and iCloud database-path presets**: a file-sync folder cannot hold a database that is rewritten whole on every write, and the codebase already names "stale image restored from a .tmp/backup" as the cause of its blank-board failure. Migrates anyone currently on a preset into the global store and removes the mechanism.
- **Pluggable storage backend with libSQL as the one supported remote option**: the payoff. Extracts a repository-level seam (there is none today — 222 public methods and ~460 call sites in one 10,820-line class) and turns on an embedded local replica, giving genuine cloud persistence with local-speed reads and full offline operation. One blessed provider, not bring-your-own connection string. Its size is set by the first subtask's binding decision: if that shipped `@libsql/client`, this is a `syncUrl` plus the distributed-migration, conflict and secrets work; if it shipped `better-sqlite3`, it additionally carries a full second driver implementation.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Move the database behind a single sidecar owner and replace sql.js with a real SQLite binding](../plans/sidecar-owned-db-real-sqlite-binding.md)
- [ ] [Scope the ten unscoped tables by workspace_id and fix three colliding unique constraints](../plans/scope-unscoped-tables-by-workspace-id.md)
- [ ] [Enforce one database instance per path and fix the is_feature clobber](../plans/single-instance-enforcement-and-is-feature-clobber.md)
- [ ] [Durable board backups and per-project export/import for the global database](../plans/board-backup-and-per-project-export.md)
- [ ] [Consolidate to one global database in ~/.switchboard and retire the location guard, db-pointer and mapping subsystem](../plans/single-global-database-in-home-store.md)
- [ ] [Retention and archive policy for a global database that never gets deleted](../plans/retention-and-archive-for-unbounded-growth.md)
- [ ] [Retire the Google Drive, Dropbox and iCloud database-path presets](../plans/retire-cloud-file-sync-db-path-presets.md)
- [ ] [Pluggable storage backend with libSQL as the one supported remote option](../plans/pluggable-storage-backend-libsql-remote.md)
<!-- END SUBTASKS -->

## Dependencies & sequencing

Ordering is load-bearing here, unusually so — two of the constraints are data-loss risks rather than preferences.

**Tier 1 — must land first, in this order or in parallel:**
1. *Sidecar owner + real SQLite binding* is the hard prerequisite for everything below. Consolidating to one global database while writes are still whole-file `export()` calls means every VS Code window on the machine can overwrite every other project wholesale. Multi-writer is rare today only because each workspace has its own file; consolidation makes it the normal case.
2. *Scope the unscoped tables* is an absolute blocker on consolidation, independent of the engine: `worktrees.branch` is globally `UNIQUE` with no workspace scope, so the second project with a `main` branch fails on insert. Ships safely after (1) so the three table rebuilds run under a single writer with real transactions.

**Tier 2 — the consolidation itself:**
3. *Backups + per-project export* must land with or before consolidation, because consolidation inverts the blast radius. It also builds the id-remapping machinery that export, import, dormant-workspace archival, and the N-to-1 merge all share — so in practice it and (4) are built together, with the merge code written once.
4. *Consolidate to one global database* requires all three above.

**Tier 3 — consequences of consolidation:**
5. *Retention and archive* is a direct consequence of (4) and needs its measurement surface shipped before any policy is set.
6. *Retire the cloud presets* is cheapest after (4), because a synced database then becomes just one more merge source rather than needing bespoke relocation code.

**Tier 4 — the optional endpoint:**
7. *Pluggable backend + libSQL* requires (1), (2), (3) and (4): the seam it extends is introduced by (1), a shared database needs (2), seeding and promotion use (3)'s export machinery, and (4)'s topology *is* the remote topology. Because (1) recommends a client that already speaks the remote protocol, this subtask stays cheap to defer and cheap to reverse — a reason to prefer that binding even if this is never scheduled.

**Independent:** *Single-instance enforcement + the `is_feature` clobber fix* can ship at any point, including first. Its stale-image half is largely superseded by (1), but the `updateFeatureStatus` wrong-row bug is unaffected by every other subtask here and should not wait on them.

One caution on read paths: the ~460 existing call sites assume microsecond in-memory reads, so the per-card N+1 patterns need auditing and batching before (1) routes extension-host reads over a process boundary, and again before (7) introduces any network round-trip.
