# Existing Installs Have No Archive At All: Schema, Folder, and a Backfill That Cannot Block Startup

**Complexity:** 6
**Tags:** migration, database, archive, backend, release

## Goal

# Existing Installs Have No Archive At All: Schema, Folder, and a Backfill That Cannot Block Startup

## Goal

Give every existing board what the operator's Pi got by hand on 2026-09-18: the archive tables, the
archive folder, any legacy archive imported, and a first backfill that moves the historical pile off
the hot board. Without this the in-database archive exists on exactly one machine.

### Problem analysis

**No code creates the archive tables.** `plans_archive` and `plan_events_archive` were created with
hand-run SQL on one board. There is no V-numbered migration, no `CREATE TABLE` anywhere in `src/`.
Every other install therefore has `_hasArchiveTables() === false`, which gates six call sites:
`archiveToCold` refuses, `restoreToHot` returns null, `getCompletedPlansCold` returns empty,
`getPlanByPlanIdUnion` cannot see archived rows, `getArchivedPlanFiles` returns empty, and
`getDistinctProjectsUnion` skips the archive. The degradation is safe -- nothing throws -- which is
precisely the danger: the feature is absent and nothing says so.

**Yes, upgrading users are stuck with everything active.** On the reference board, 2,559 of 3,283
plans (78%) belonged in the archive. An upgrading install keeps all of them in `plans`, so the
unbounded board read the archive exists to bound is exactly as unbounded as before. They also keep
every plan file in the swept tree, which is the condition that made the first scan of a session
expensive.

**Installs with a legacy archive lose sight of it.** Anyone whose hot/cold split ever ran has rows in
a separate `<workspace-id>-archive.db` or `kanban-archive.db`. Nothing reads those files any more.
Their archived history becomes invisible rather than merely stale. The storage-topology plan already
set the rule for this case -- "import before deleting, archive as `*.migrated.bak`, never unlink" --
and it must be honoured here.

**The backfill is not just a database operation; it renames the operator's tracked files.** Archived
plan files move to `.switchboard/archive/`. On the reference board that was 2,109 files, all tracked
by git, producing 2,109 renames. Done silently at startup, an upgrade would rewrite thousands of
paths in a repository the operator may have uncommitted work in. That is not a migration, it is an
ambush.

### Root Cause

The in-database archive was built under an outage, directly against the live board, in the order that
restored service fastest. The schema was created by hand because the goal was a working board that
evening, not a shippable upgrade path. Every step was applied to data that already existed, so no
step had to describe how to reach that state from a fresh install.

### What this card must build

1. **A V-numbered schema migration** creating `plans_archive` and `plan_events_archive` by cloning
   the live `plans` / `plan_events` schema rather than restating it, so the two cannot drift. The
   previous two-file archive drifted exactly this way and silently dropped a column's values from
   8,506 rows. Include the indexes, `plan_file` among them -- the scan path's archived-file lookup
   is a point query and is worthless without it.
2. **Create `.switchboard/archive/plans/` and `.switchboard/archive/features/`**, and un-ignore
   `.switchboard/archive/` in the workspace `.gitignore`. It must be a sibling of the live
   directories, never a subdirectory: `listImportablePlanFiles` recurses and treats a subdirectory as
   a repo scope, so an `archive/` folder inside `plans/` is still swept.
3. **Import any legacy archive database**, then rename it `*.migrated.bak`. Never unlink. Rows whose
   `plan_id` already exists in the board win from the board -- the legacy file is the older copy.
4. **The backfill, operator-initiated and resumable.** Batched, off the startup path, with a progress
   surface and a stated count before it starts. A crash must leave every file readable in one of the
   two locations and every row in exactly one table.
5. **Refuse to move files when the git working tree is dirty.** Thousands of renames mixed into
   uncommitted work is not something the operator can untangle. Detect, refuse, and say what to do.
   Use `git mv` when the tree is a clean repo so history follows; plain rename otherwise.
6. **A startup reconcile pass** closing the gap the filesystem cannot transact: row in
   `plans_archive` but file still under `plans/` -> move it (this is the resurrectable state, so it
   is the urgent direction); row in `plans` but file under `archive/` -> move it back. Cheap, bounded
   by the mismatch count, and it makes both the backfill and normal archiving self-healing.

### Reference numbers from the one board that has done this

Useful for sizing, and the only real data point:

| | |
| :--- | ---: |
| plans before | 3,283 |
| archived by the migration | 2,559 (78%) |
| files moved | 2,109 (1,880 plans + 229 features) |
| archive rows whose file no longer exists | 450 |
| board file, after prune + vacuum | 13.77 MB -> 8.42 MB |
| stray archived files left in the swept tree, before the folder move | 1,880 -> heap climbed ~2 MB/s to a 1.9 GB abort |

### Non-goals

- Deciding *when* a card archives. That is the bin card.
- Deciding *which* cards are archivable. Blocked on one notion of done.
- Retention inside the archive.

## Metadata

**Complexity:** 6
**Tags:** migration, database, archive, backend, release
**Dependencies:** the archivable predicate comes from `b14b5eba` (A Card Moved to COMPLETED Lands in
a State the Board Cannot Render) -- without it the backfill selects the wrong set, and on the
reference board the four candidate predicates selected 1, 31, 32 and 39 cards respectively. Ships
with or after the bin card.

## User Review Required

1. **Does the backfill run automatically on upgrade, or does the operator start it?**
   Recommendation: operator-initiated, with the count shown first ("2,559 of 3,283 cards and 2,109
   files will move"). It rewrites tracked paths in their repository; that deserves a decision, not a
   surprise.
2. **Do archived plan files stay in git?** Recommendation: yes -- un-ignore `.switchboard/archive/`
   and move with `git mv`, so history follows and nothing silently leaves the repo. The alternative
   is a one-time loss of 2,109 files from version control.
3. **What happens on a dirty working tree?** Recommendation: refuse the file half, offer to do the
   database half alone, and let the operator re-run the file move after committing.
4. **Is a board allowed to run with the tables created but the backfill never run?** Recommendation:
   yes, and that is the default post-upgrade state -- archiving works going forward, history is
   dealt with when the operator chooses.

