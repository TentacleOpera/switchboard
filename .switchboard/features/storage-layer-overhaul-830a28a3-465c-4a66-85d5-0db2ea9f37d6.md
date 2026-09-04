---
description: 'Storage layer overhaul: real engine, one global store, durable persistence'
---

# Storage layer overhaul: real engine, one global store, durable persistence

**Complexity:** 10

## Goal

Replace the storage foundation underneath the Switchboard board. Today `kanban.db` is a `sql.js` image held entirely in RAM, rewritten in full on every write, living inside the repository, with one database per workspace. That single set of choices is the shared root cause of five separate problems: silent whole-database clobber between concurrent in-memory images, a 500 MB resident budget plus an LRU eviction subsystem and six enumerated leak mechanisms for a metadata-only schema, an entire location-guard/`db-pointer`/workspace-mapping apparatus that exists only to answer "which database does this folder use?", no coherent story for long-term persistence across projects, and ~900K of extension-shipped control-plane content committed into every repository Switchboard touches.

The end state: one global SQLite database in `~/.switchboard`, owned by a single sidecar process using a real SQLite binding with WAL, holding every workspace at once, with verified backups, per-project export/import, a defined retention policy, and the control-plane scaffold out of the repository entirely.

Deliberately **not** a *foreign-dialect* networked database. The measured dialect coupling (18 load-bearing `rowid` sites, 13 `AUTOINCREMENT`, 6 `PRAGMA`, 15 `datetime('now')`), the loss of offline operation, and a mandatory data migration across ~4,000 installs buy nothing that a real SQLite binding does not already deliver. That rejection stands for Postgres, MySQL and anything else that is not SQLite. What is worth taking from the hosted tools is the *data model* — one store, many projects, stable ids, cross-project views — not the deployment model.

> **Amended.** The paragraph above originally read "not a networked database of any kind", and that was too broad: each of its three clauses is aimed at a foreign dialect, and none of them reaches **libSQL**, which is a SQLite fork. The 52 dialect sites are SQLite semantics libSQL preserves; an embedded replica keeps a local SQLite file as the read path, so offline operation is the default rather than a casualty; and there is no mandatory migration because the local file stays the default and a remote is opt-in per install. A libSQL shared store is therefore admitted as an **opt-in** target, never a default and never Switchboard-hosted — see `../plans/libsql-shared-store-turso-and-self-hosted-sqld.md`. The remote's job there is arbitration and durability, not query serving, which is why it does not disturb this feature's engine, memory or locality reasoning.

> **Amended again — the rejection scopes to the LOCAL engine, and does not decide the remote.** The amendment above kept the original paragraph's frame: it argued that libSQL is admissible *because it is a SQLite fork*, which implies a foreign dialect would be inadmissible. That inference does not hold for the shared tier, and the three clauses should be read as bounded to the engine this feature replaces.
>
> Check each clause against the shared tier as `../plans/split-shared-board-state-from-machine-local-runtime.md` defines it. **Dialect coupling:** the 52 sites (verified: 18 `rowid`, 13 `AUTOINCREMENT`, 6 `PRAGMA`, 16 `datetime('now')`, plus 6 uncounted `INSERT OR REPLACE`) all execute against the local store, which stays SQLite under every proposal here. A remote holding shared board state is never handed `PRAGMA`. **Offline operation:** guaranteed by the local store being the read path, which is a property of the two-tier split itself, not of the remote's engine — an embedded replica is one way to obtain it, not the only one. **Mandatory migration:** none, because the local file stays the default and any remote is opt-in per install. All three clauses are arguments against *swapping the local engine*. None is an argument about what may hold the shared tier.
>
> The scale makes this concrete. That plan measures the shared facts changing at human pace — tens to hundreds of writes a day — against ~172,800 machine-local row writes a day from `recordLiveness()` alone, six orders of magnitude apart. And the shared subset is not "a database": two shipped serialisers converged independently on roughly sixteen scalar fields per card (`BoardSnapshotPublisher`'s `BoardCardEntry`, and `_writeKanbanStateBackup()`).
>
> The decisive evidence is inside this feature's own family. The sibling target for the *same* shared tier is the git orphan-branch snapshot — `board.json` on a branch, which is not SQLite, not SQL, and not a database. If a JSON blob on a git branch is an admissible home for shared board state, dialect compatibility cannot be what disqualifies anything else.
>
> **Therefore:** the rejection stands, in full, for the local engine — Postgres, MySQL and anything not SQLite remain rejected *there*, on the 52 sites, offline, and migration. It does not settle the remote. Choosing a store for the shared tier is an **operational** decision — auth model, hosting, cost, concurrency, and whether the project wants to own a schema mapping — not a dialectal one. What still argues specifically for libSQL is schema symmetry (no mapping layer to own, so the local-side conversion is a no-op) and not having to write a sync engine. What argues against it is that whole-database replication is the wrong granularity for a six-orders-of-magnitude split — `../plans/storage-topology-one-choice-three-stores.md` already has to make Archive a physically separate *database* purely to control what replicates — and that its single-writer model is the reason `../plans/sync-owner-lease-and-write-attribution.md` exists as a subtask at all. Those are the trade-offs a future reader should weigh. The dialect count is not one of them.

## How the Subtasks Achieve This

- **Move the database behind a single sidecar owner and replace sql.js with a real SQLite binding**: the foundation. Puts one process in charge of the database and swaps export-the-world for page-level writes and WAL. Deletes the persist debounce, the 500 MB resident budget, the eviction sweep, and the stale-image reload path. Dodges the Electron ABI wall that made `better-sqlite3` unworkable before, by placing the owner outside the extension host. Binding **DECIDED: `better-sqlite3`** (corrected 2026-09-04, Board Collapse 01 — this feature file previously said `node:sqlite`, contradicting its own subtask, which superseded that because VS Code's bundled Node 20 does not ship `node:sqlite`). A missing native prebuild has no graceful degradation, unlike `node-pty` behind `isPtyAvailable()`, so the binding is resolved per storage target and `libsql` is required lazily as an optional dependency only when a libSQL target is configured. Everything else depends on this.
- **Scope the ten unscoped tables by workspace_id and fix three colliding unique constraints**: makes the schema able to hold more than one workspace. Nine tables gain `workspace_id`; `worktrees.branch UNIQUE`, `job_instructions.file UNIQUE`, and `kanban_meta.key PRIMARY KEY` are rebuilt with workspace scope. Without this, consolidation fails on the first project that also has a `main` branch.
- **Enforce one database instance per path and fix the is_feature clobber**: closes an investigation open since July 2025. The stale-image half is dissolved by the engine swap; the `updateFeatureStatus` wrong-row half is arithmetic on ids and survives any storage change, so it needs its own fix. Ships independently of the rest.
- **Durable board backups and per-project export/import**: consolidation inverts the blast radius — one corrupt file would cost every project rather than one. Adds Online Backup API snapshots with integrity verification and retention, plus a per-workspace export format so "hand this project to someone else" still works once board state is no longer in the repo.
- **Consolidate to one global database in ~/.switchboard**: the centrepiece. Moves board state out of the repository into the home store as a single database holding every workspace, migrates existing per-workspace databases in with an N-to-1 merge, and deletes the location guard, `db-pointer`, and the database-resolution half of the mapping subsystem. Follows the path the secrets store and integration config already took.
- **Retention and archive policy for a global database that never gets deleted**: consolidation plus long-term persistence removes both mechanisms that used to bound database size. Ships size reporting first, then a rotation policy for the four append-only tables, with dormant-workspace archival — non-destructive throughout.
- **Retire the Google Drive, Dropbox and iCloud database-path presets**: a file-sync folder cannot hold a database that is rewritten whole on every write, and the codebase already names "stale image restored from a .tmp/backup" as the cause of its blank-board failure. Migrates anyone currently on a preset into the global store and removes the mechanism.
- **Get the control-plane scaffold out of the repository**: the one the user actually feels. `.agents/` (744K, ~51 files) and the `.claude/` mirror (152K) are extension-shipped content, byte-identical in every workspace, and committed — neither appears in `.gitignore`. Makes the store authoritative for control-plane definitions and the on-disk tree a gitignored, regenerated projection, because agent hosts discover capability by globbing the filesystem rather than calling an API. Also relocates seven machine-local JSON config files into the `config` table and moves the caches out of the repo. Independent of the engine work, so it could ship first.
- **Protocols become database rows injected into prompts**: the proof that the `control_plane` table can hold real, load-bearing content. The 32 protocols (424K) are UI-triggered instructions the extension delivers — nothing discovers them by globbing, and in the content-injection case the extension already reads the file itself, so a row read is a drop-in substitution. Removes the files rather than relocating them, which is what the earlier `move-protocols-out-of-skill-discovery` plan intended before its destination proved unshippable. 29 of the 32 move, one (`improve-remote-plan`) is deleted outright as unexecutable — the workflow pointing at it guarantees "no repo access" while its own Prerequisites require git and a reachable LocalApiServer — leaving `improve-plan` and `improve-feature` committed at ~28K permanently — they are the defaults of two user-editable path fields in the Prompts tab (`workflowFilePath`, `plannerFeatureWorkflowFilePath`) whose documented purpose is accepting third-party methodology files like GSD and Superpowers. The extension cannot inline or materialise a path a user typed, so that field's contract requires real files, and its own default cannot be the one entry that is not one. Delivery follows what the reader can reach: clipboard prompts inline the body, agents that can reach the LocalApiServer fetch it over a new `GET /protocol/<name>`, repo-less remote agents get the authoring instructions pushed to the tracker by the outward context sync that already mirrors the Dev Docs, PRDs and constitution, and only the clone-and-nothing-else case needs a file. `.agents/workflows/` (52K) and `.agents/skills/_lib/` stay committed as before.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Durable board backups and per-project export/import for the global database](../plans/board-backup-and-per-project-export.md) — **LEAD CODED** — ID: ecc1b4c8-eaff-488e-b48f-e8972cd76de4
- [ ] [Get the control-plane scaffold out of the repository](../plans/control-plane-scaffold-out-of-the-repo.md) — **LEAD CODED** — ID: e780ad93-da05-4f85-87b7-8c16312851cb
- [ ] [Protocols become database rows injected into prompts, not files scaffolded into every repo](../plans/protocols-as-db-rows-not-scaffolded-files.md) — **LEAD CODED** — ID: db63be21-0fc1-49ea-9488-b63904d39183
- [ ] [Retire the Google Drive, Dropbox and iCloud database-path presets](../plans/retire-cloud-file-sync-db-path-presets.md) — **LEAD CODED** — ID: 0e011823-3a54-4680-91f7-884676bcd6ee
- [ ] [Retention and archive policy for a global database that never gets deleted](../plans/retention-and-archive-for-unbounded-growth.md) — **LEAD CODED** — ID: c5e07d36-5a87-43ac-bd22-d72523dc96b3
- [ ] [Scope the ten unscoped tables by workspace_id and fix three colliding unique constraints](../plans/scope-unscoped-tables-by-workspace-id.md) — **LEAD CODED** — ID: 8fd3b786-2dca-4936-bd58-51a0ccd462de
- [ ] [Move the database behind a single sidecar owner and replace sql.js with a real SQLite binding](../plans/sidecar-owned-db-real-sqlite-binding.md) — **LEAD CODED** — ID: cc0e2653-25dc-46e2-ac26-27deb842c34c
- [ ] [Consolidate to one global database in ~/.switchboard and retire the location guard, db-pointer and mapping subsystem](../plans/single-global-database-in-home-store.md) — **LEAD CODED** — ID: f9e5511c-c518-4624-a6db-c54e1dc2f24d
- [ ] [Enforce one database instance per path and fix the is_feature clobber](../plans/single-instance-enforcement-and-is-feature-clobber.md) — **LEAD CODED** — ID: ed40b1f1-d48e-42a5-94db-5aea91baecab
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

## The storage programme — one order, stated once (2026-09-04, Board Collapse 07)

Storage is one chain of hard prerequisites spread over ten features and several loose plans. No
file stated it end to end, so cards that cannot be coded yet sat in Planned looking dispatchable.
The order is:

1. **Move the database behind a single sidecar owner and replace sql.js with a real SQLite binding.**
   The foundation. Nothing below it can be built on sql.js, which holds the whole database in memory
   and rewrites the entire image on each persist, so two processes lose each other's updates.
2. **Scope the ten unscoped tables by `workspace_id`** and fix the three colliding unique constraints.
3. **Durable board backups and per-project export/import.**
4. **Consolidate to one global database in `~/.switchboard`.**
5. **Storage topology: three stores, one operator choice.**
6. **Split the schema into shared board state and machine-local runtime.**
7. **Shared stores** — libSQL, or the git-carried snapshot. Operator picks one.

Steps 1 to 3 are independently useful and stay in Planned. So does *Enforce one database instance
per path and fix the `is_feature` clobber*: its clobber half is superseded by nothing and ships
before the engine swap.

Everything that depends on step 1 and cannot start without it is parked in **Backlog**, not
cancelled: the *Shared Board Stores*, *Two Machines One Board* and *Cloud-Driven Switchboard*
features, and the loose plans for the state home, the bundle ledger and board-control instructions.

One card moved the other way. *Global settings are a JSON file two boards can both write* waits only
on **step 1**, not step 4 as it claimed — the blocker is the engine, not the store's location — so
it stays available in New.

## Implementation Summary

All 9 subtasks implemented and committed (8258ce4b). The storage layer now uses better-sqlite3 with WAL mode instead of sql.js in-memory images, consolidates to a single global database in ~/.switchboard/switchboard.db, and scopes all previously unscoped tables by workspace_id with compound unique constraints. Durable backups use the SQLite Online Backup API with integrity verification and retention pruning. Per-project export/import and N-to-1 merge machinery support both the consolidation migration and dormant-workspace archival. The control-plane scaffold (.agents/ and .claude/) is now a gitignored projection regenerated from the control_plane DB table, with 29 protocols moved to database rows. Cloud-sync DB path presets (Google Drive, Dropbox, iCloud) are retired with automatic migration to the global store. The is_feature clobber is fixed with empty-ID rejection, plan_file ownership assertion, and a structural guard on .switchboard/features/ files. Retention and archive policy ships with size reporting, 6-hour rotation for append-only tables, dormant-workspace archival, and reactivation support. Both the VS Code extension and standalone host wire all new services with parity maintained throughout.
