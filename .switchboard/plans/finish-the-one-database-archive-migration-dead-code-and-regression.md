# Finish the One-Database Archive Migration: Remove Dead Two-Store Code and Pin the Regression

**Complexity:** 3
**Tags:** database, cleanup, testing, backend

## Goal

# Finish the One-Database Archive Migration: Remove Dead Two-Store Code and Pin the Regression

## Goal

Close out the 2026-09-18 migration that moved the archive into the board database. Data and live
code paths are done; what remains is deleting the machinery that resolved a second database file,
and adding the test for the regression that caused the outage.

### Problem analysis

**The two-store machinery is still compiled in with no live callers.** `resolveArchiveDbPath`,
`getArchiveInstance`, `getArchiveInstanceIfPresent`, `hasArchiveInstance`, `archiveAvailable` and
`runPartitionSweep` have no callers outside tests, but still resolve and would construct a second
handle if called. `storage-topology-contract` still prints a resolved `-archive.db` path on every
run, which is how you can tell resolution survives. Dead code that can create a database file is
worse than ordinary dead code: the `archive` protocol warns by name that a wrong path makes
`sqlite3` silently create an empty database, and a stray empty archive is indistinguishable from
an empty one.

**The regression that caused the outage is not pinned by a test.** `PlanIngestionEngine` treated
an archived plan's on-disk file as new, re-ingesting 1,880 plans on every session start until the
heap aborted. The union helper written for exactly this case, `getPlanFileSetUnion`, had **zero
callers** -- a wiring omission, the class of bug a test catches and review does not. There is now
an `isPlanFileArchived` point lookup on the scan path and nothing asserts it stays wired.

**`getPlanFileSetUnion` is still a bulk fetch with no callers.** It reads the archive table now,
but returns every archived path -- the unbounded-read shape the scan path deliberately avoided.
Left in place it is an attractive nuisance for the next caller.

### Root Cause

The migration was done under an outage and sequenced to restore service first: migrate data,
repoint live readers, fix the scan. Removal and test coverage were deliberately deferred rather
than forgotten; this card is that deferral made explicit.

### What this card must do

1. Delete the archive-file resolution and instance machinery and its tests; confirm no path can
   create a `-archive.db` or `kanban-archive.db`.
2. Delete `getPlanFileSetUnion` or reimplement it bounded. Do not leave a whole-archive fetch on a
   public method.
3. Contract test: given a plan whose row is in `plans_archive` and whose file is on disk, a scan
   must not ingest it or re-create its row. Assert on the first scan of a session, when
   `prevPaths` is undefined and `lastScan` is 0 -- the state that failed.
4. Test that promotion is lossless: archive a plan with events, promote it, assert plan and every
   event return to the live tables.
5. Fix the `archive` protocol's remaining stale bullet (it still advises re-resolving a stray
   `kanban-archive.db` from the workspace root).

### Superseded approach: per-importer guards

The scan-path guard (`isPlanFileArchived` on `PlanIngestionEngine`) was the first fix and it was
not sufficient. Nine places in non-test code resolve the plans directory, and the file-derived
bulk importer -- a door that had not been found -- re-imported 1,767 archived plans on the first
plan creation after the fix. Auditing importers is unbounded work with no completion signal.

The archive files now live in `.switchboard/archive/`, outside every swept tree, which ends the
class structurally. The remaining guard is defence in depth, not the mechanism. Any new importer
is safe by default rather than safe-if-remembered.

### Recorded for provenance

- Archive tables created in the board database; 2,559 plans and 8,506 events migrated; verified
  `integrity_check ok`, zero id collisions, zero `plan_file` collisions, zero double-homed rows.
- Separate file retired to `...-archive.db.migrated.bak`; never unlinked.
- `archiveToCold` / `restoreToHot` rewritten as single in-database transactions deleting children
  before parents, fixing `b409a30b`.
- Foreign-key violations 1,922 to 0 after the orphan reap; board file 13.77 MB to 8.42 MB.
- Board verified up: HTTP 200, RSS flat ~360 MB against a pre-fix profile that climbed ~2 MB/s to
  a 1.9 GB abort.

## Metadata

**Complexity:** 3
**Tags:** database, cleanup, testing, backend
**Dependencies:** none -- the behaviour is already shipped. Should land before further archive
work so the next change starts from one store, not one-and-a-half.

## User Review Required

None.

