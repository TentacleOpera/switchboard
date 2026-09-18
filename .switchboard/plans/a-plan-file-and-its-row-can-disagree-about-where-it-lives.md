# A Plan File and Its Row Can Disagree About Where It Lives, and Nothing Reconciles Them

**Complexity:** 3
**Tags:** archive, reliability, database, backend

## Goal

# A Plan File and Its Row Can Disagree About Where It Lives, and Nothing Reconciles Them

## Goal

Close the one gap the in-database archive cannot close with a transaction. A plan's row moves between
`plans` and `plans_archive` inside SQLite; its file moves between `.switchboard/plans/` and
`.switchboard/archive/` on the filesystem. The two cannot share a transaction, so a crash between
them leaves a disagreement, and a startup pass should repair it.

### Problem analysis

**Two states are reachable, and they are not equally bad.**

| state | how | consequence |
| :--- | :--- | :--- |
| row archived, file still under `plans/` | crash after commit, before the file move | **the dangerous one** -- the file is back in the swept tree, so any importer sees a file with no row in `plans` and re-ingests it |
| row live, file under `archive/` | crash after the file move, before commit | benign -- a broken `plan_file` pointer; the row exists, so nothing resurrects it |

`archiveToCold` is deliberately ordered to fail into the second state: it moves the file first and
rolls the move back if the transaction fails. `restoreToHot` cannot have it both ways -- it also
moves the file first, which means its crash window lands in the *first* state. So promotion is the
operation that can produce a resurrectable file.

**The resurrectable state is exactly the outage.** On 2026-09-18, 1,880 archived plans whose files
sat in the swept tree were re-ingested on session start until the heap aborted. One file in that
state is not an outage, but it is the same defect with a smaller numerator, and it is silent.

**The migration needs this anyway.** The first backfill moves thousands of files outside any
transaction. Resumability after a crash mid-backfill is the same repair this card describes, so
building it once serves both.

### Root Cause

A filesystem is not transactional and the archive boundary now spans both stores. This was an
accepted, stated trade when the archive moved in-database; it was never given the compensating
repair pass.

### What this card must do

1. A startup pass, cheap and bounded by the mismatch count, not by board size:
   - row in `plans_archive` with a `plan_file` under `.switchboard/plans/` or
     `.switchboard/features/`, or whose file is found there -> move the file into the archive tree
     and correct the stored path. **Do this before the first scan runs**, or the importer wins the
     race.
   - row in `plans` whose file is found under `.switchboard/archive/` -> move it back and correct
     the path.
2. Log every repair with the plan id and both paths. A silent repair hides a crashing archive
   operation.
3. Treat a row whose file exists in neither place as legitimate, not broken -- 450 archive rows on
   the reference board outlived their files, and that is a known, tolerated state.
4. Idempotent: running it twice changes nothing the second time.

## Metadata

**Complexity:** 3
**Tags:** archive, reliability, database, backend
**Dependencies:** none. Shares its mechanism with the backfill in `Existing Installs Have No Archive
At All`; whichever lands first should expose the repair as a reusable pass rather than inlining it.

## User Review Required

None.

