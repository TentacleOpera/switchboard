---
description: 'Storage layer overhaul: real engine, one global store, durable persistence'
---

# Storage layer overhaul: real engine, one global store, durable persistence

## Goal

Replace the storage foundation underneath the Switchboard board. Today `kanban.db` is a `sql.js` image held entirely in RAM, rewritten in full on every write, living inside the repository, with one database per workspace. That single set of choices is the shared root cause of five separate problems: silent whole-database clobber between concurrent in-memory images, a 500 MB resident budget plus an LRU eviction subsystem and six enumerated leak mechanisms for a metadata-only schema, an entire location-guard/`db-pointer`/workspace-mapping apparatus that exists only to answer "which database does this folder use?", no coherent story for long-term persistence across projects, and ~900K of extension-shipped control-plane content committed into every repository Switchboard touches.

The end state: one global SQLite database in `~/.switchboard`, owned by a single sidecar process using a real SQLite binding with WAL, holding every workspace at once, with verified backups, per-project export/import, a defined retention policy, and the control-plane scaffold out of the repository entirely.

Deliberately **not** a networked database of any kind. The measured dialect coupling (18 load-bearing `rowid` sites, 13 `AUTOINCREMENT`, 6 `PRAGMA`, 15 `datetime('now')`), the loss of offline operation, and a mandatory data migration across ~4,000 installs buy nothing that a real SQLite binding does not already deliver. What is worth taking from the hosted tools is the *data model* — one store, many projects, stable ids, cross-project views — not the deployment model.

## How the Subtasks Achieve This

- **Move the database behind a single sidecar owner and replace sql.js with a real SQLite binding**: the foundation. Puts one process in charge of the database and swaps export-the-world for page-level writes and WAL. Deletes the persist debounce, the 500 MB resident budget, the eviction sweep, and the stale-image reload path. Dodges the Electron ABI wall that made `better-sqlite3` unworkable before, by placing the owner outside the extension host. Recommends `node:sqlite` as the binding: the only candidate with no native module, so no per-platform prebuild can be missing at install — which matters because, unlike `node-pty` behind `isPtyAvailable()`, a missing database binding has no graceful degradation. Everything else depends on this.
- **Scope the ten unscoped tables by workspace_id and fix three colliding unique constraints**: makes the schema able to hold more than one workspace. Nine tables gain `workspace_id`; `worktrees.branch UNIQUE`, `job_instructions.file UNIQUE`, and `kanban_meta.key PRIMARY KEY` are rebuilt with workspace scope. Without this, consolidation fails on the first project that also has a `main` branch.
- **Enforce one database instance per path and fix the is_feature clobber**: closes an investigation open since July 2025. The stale-image half is dissolved by the engine swap; the `updateFeatureStatus` wrong-row half is arithmetic on ids and survives any storage change, so it needs its own fix. Ships independently of the rest.
- **Durable board backups and per-project export/import**: consolidation inverts the blast radius — one corrupt file would cost every project rather than one. Adds Online Backup API snapshots with integrity verification and retention, plus a per-workspace export format so "hand this project to someone else" still works once board state is no longer in the repo.
- **Consolidate to one global database in ~/.switchboard**: the centrepiece. Moves board state out of the repository into the home store as a single database holding every workspace, migrates existing per-workspace databases in with an N-to-1 merge, and deletes the location guard, `db-pointer`, and the database-resolution half of the mapping subsystem. Follows the path the secrets store and integration config already took.
- **Retention and archive policy for a global database that never gets deleted**: consolidation plus long-term persistence removes both mechanisms that used to bound database size. Ships size reporting first, then a rotation policy for the four append-only tables, with dormant-workspace archival — non-destructive throughout.
- **Retire the Google Drive, Dropbox and iCloud database-path presets**: a file-sync folder cannot hold a database that is rewritten whole on every write, and the codebase already names "stale image restored from a .tmp/backup" as the cause of its blank-board failure. Migrates anyone currently on a preset into the global store and removes the mechanism.
- **Get the control-plane scaffold out of the repository**: the one the user actually feels. `.agents/` (744K, ~51 files) and the `.claude/` mirror (152K) are extension-shipped content, byte-identical in every workspace, and committed — neither appears in `.gitignore`. Makes the store authoritative for control-plane definitions and the on-disk tree a gitignored, regenerated projection, because agent hosts discover capability by globbing the filesystem rather than calling an API. Also relocates seven machine-local JSON config files into the `config` table and moves the caches out of the repo. Independent of the engine work, so it could ship first.
- **Protocols become database rows injected into prompts**: the proof that the `control_plane` table can hold real, load-bearing content. The 32 protocols (424K) are UI-triggered instructions the extension delivers — nothing discovers them by globbing, and in the content-injection case the extension already reads the file itself, so a row read is a drop-in substitution. Removes the files rather than relocating them, which is what the earlier `move-protocols-out-of-skill-discovery` plan intended before its destination proved unshippable. 30 of the 32 move (~396K), leaving `improve-plan` and `improve-feature` committed at ~28K — `CLAUDE.md` cites their section schema as authoritative, so a cloud agent working from a clone must read them unaided. Delivery follows what the reader can reach: clipboard prompts inline the body, agents that can reach the LocalApiServer fetch it over a new `GET /protocol/<name>`, and only the repo-only case needs a file. `.agents/workflows/` (52K) and `.agents/skills/_lib/` stay committed as before.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Move the database behind a single sidecar owner and replace sql.js with a real SQLite binding](../plans/sidecar-owned-db-real-sqlite-binding.md)
- [ ] [Scope the ten unscoped tables by workspace_id and fix three colliding unique constraints](../plans/scope-unscoped-tables-by-workspace-id.md)
- [ ] [Enforce one database instance per path and fix the is_feature clobber](../plans/single-instance-enforcement-and-is-feature-clobber.md)
- [ ] [Durable board backups and per-project export/import for the global database](../plans/board-backup-and-per-project-export.md)
- [ ] [Consolidate to one global database in ~/.switchboard and retire the location guard, db-pointer and mapping subsystem](../plans/single-global-database-in-home-store.md)
- [ ] [Retention and archive policy for a global database that never gets deleted](../plans/retention-and-archive-for-unbounded-growth.md)
- [ ] [Retire the Google Drive, Dropbox and iCloud database-path presets](../plans/retire-cloud-file-sync-db-path-presets.md)
- [ ] [Get the control-plane scaffold out of the repository](../plans/control-plane-scaffold-out-of-the-repo.md)
- [ ] [Protocols become database rows injected into prompts, not files scaffolded into every repo](../plans/protocols-as-db-rows-not-scaffolded-files.md)
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

**Independent, and the best candidate to ship first:** *Get the control-plane scaffold out of the repository* needs only a store, and the current per-workspace one suffices. If it ships before consolidation the registry lives in the per-workspace DB and migrates along with everything else; if after, it lands in the global store directly. Either order works.

**Programme-wide boundary rule, introduced by the scaffold plan:** the store may hold control-plane definitions as bodies; it must never become the sole home of a user artifact. This is load-bearing rather than aesthetic — the consolidation and backup subtasks both rest on the database being a derived index over committed markdown, so plan identity survives total loss by re-ingesting the repo. Control-plane definitions are regenerable from the extension bundle; plans are regenerable from nothing. It also bounds the engine problem: 744K of protocol text in a sql.js image is tolerable, whereas the 43M in `plans/` would mean ~129M of transient copies on every single write.

**Independent:** *Single-instance enforcement + the `is_feature` clobber fix* can ship at any point, including first. Its stale-image half is largely superseded by (1), but the `updateFeatureStatus` wrong-row bug is unaffected by every other subtask here and should not wait on them.

One caution on read paths: the ~780 existing sql.js touchpoints assume microsecond in-memory reads, so the per-card N+1 patterns need auditing and batching before (1) routes extension-host reads across a process boundary.
