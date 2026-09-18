# COMPLETED Is the Bin: a Card Moved There Archives Immediately and Leaves the Board

**Complexity:** 5
**Tags:** archive, database, ux, backend

## Goal

# COMPLETED Is the Bin: a Card Moved There Archives Immediately and Leaves the Board

## Goal

Make COMPLETED mean *disposed of*. Moving a card to COMPLETED archives it in the same action and
removes it from the board, the way dragging a file to the bin removes it from the desktop. The
operator keeps access through the ARCHIVES view, and nothing accumulates in a terminal column.

### Problem analysis

**Today COMPLETED is a permanent holding pen.** 32 cards sit in it on the live board and nothing
has ever removed one: auto-archive has never run (`a064cf90`), and the only sweep designed -- a
two-week dwell pass (`ccffc96a`) -- was never enabled. A terminal column that never drains is one
the operator scrolls past and mentally filters for the life of the board.

**The dwell window was the wrong shape.** A two-week delay exists to let someone change their
mind, but the board already has that: an archived card can be promoted back. Paying for
reversibility twice means the common case -- the card is done, get it out of the way -- is served
worst.

**The destination now exists and is cheap.** As of 2026-09-18 the archive is the `plans_archive` /
`plan_events_archive` tables inside the board database, so archiving is a row move in one
transaction and `restoreToHot` is its exact inverse. The cost argument against archiving eagerly
is gone.

**The ARCHIVES view already exists.** `project.html` has an ARCHIVES tab and `project.js` wires
`fetchArchivedPlans` and `queryArchivesPrompt`; the card that built it is itself archived. Its
backend was repointed at `plans_archive` on 2026-09-18. This card verifies it renders 2,559 rows
-- it does not build it.

### Root Cause

Completion and archival were designed as two lifecycle events joined by a timer, because the
archive used to be an expensive separate file worth writing lazily. Once it became a table in the
same database, the timer stopped buying anything and became the reason the board never drains.

### What this card must build

1. **Archive on transition into COMPLETED**, in the same transaction as the column write. Several
   paths do this move (`/kanban/move`, board drag, `completePlan`, `completeSelected`,
   `completeAll`, `moveAll`) and they must not disagree -- that disagreement is what produced four
   definitions of done.
2. **Features and subtasks archive together or not at all.** Carried from `ccffc96a` and more
   urgent under immediate archiving: a binned feature with live subtasks is worse than either
   state alone.
3. **Confirm the ARCHIVES view renders the table** and paginates rather than loading 2,559 rows.
4. **Promotion must be reachable from the view.** `restoreToHot` is a single-transaction row move;
   without a button, the bin is a one-way door and the operator will avoid it.
5. **Backfill the 32 cards already in COMPLETED** -- all that survives of `ccffc96a`.

### Non-goals

- Deleting anything. Disposal from the working set, not data loss; rows stay in the same file.
- Changing what the archive is or where it lives. Settled 2026-09-18.

## Metadata

**Complexity:** 5
**Tags:** archive, database, ux, backend
**Dependencies:** `b14b5eba` must land first -- with four incompatible definitions of done,
archiving on move to COMPLETED archives the wrong set. `a064cf90` should land with or before this
so one switch governs archival.

## User Review Required

1. **Where does a binned card's plan file live?** Resolved 2026-09-18 by operator decision: it
   moves to `.switchboard/archive/plans/` (features to `.switchboard/archive/features/`), a
   sibling of the live directories and outside every tree the importers walk. 1,880 plan files
   and 229 feature files were moved with `git mv`, and `.switchboard/archive/` was un-ignored so
   they stay tracked.

   This is the structural fix and it replaces the per-importer guards: three code paths discover
   plans by reading the plans directory, and one of them -- the file-derived bulk importer that
   sweeps the whole directory on every plan creation -- resurrected 1,767 archived cards on
   2026-09-18 because only the other path had been guarded. An importer cannot resurrect a file it
   never sees. `archiveToCold` and `restoreToHot` now move the file as part of the operation.

   Still open: the file move cannot join the SQL transaction, so a crash between the two leaves a
   repairable inconsistency. A reconcile pass at startup -- row archived but file still in
   `plans/`, or row live but file in `archive/` -- should close it.
2. **Undo window, or promotion only?** Recommendation: promotion only, surfaced in ARCHIVES. An
   undo window reintroduces the dwell this card removes.
3. **Should COMPLETED stay visible** once it drains on every move? Recommendation: keep as a drop
   target, collapsed by default.

