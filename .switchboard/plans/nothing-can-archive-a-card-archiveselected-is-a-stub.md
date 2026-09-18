# Nothing Can Archive a Card: archiveSelected Is a Stub That Returns an Error

**Complexity:** 3
**Tags:** archive, ux, backend

## Goal

# Nothing Can Archive a Card: archiveSelected Is a Stub That Returns an Error

## Goal

Give archiving a trigger. There is a working archive destination and a working move operation, and
no way to reach either.

### Problem analysis

**The only archive button is a stub.** `archiveSelected` (`KanbanProvider.ts:12249`) validates its
arguments, resolves the workspace root, and then returns:

```
{ success: false, error: 'The archive export has been removed. Completed cards leave the
  board via the hot window; their rows stay in the board store.' }
```

That message was accurate when archiving meant a DuckDB export, deleted with `ArchiveManager` on
2026-09-11. It is no longer accurate: archiving now means moving a row into `plans_archive` and its
file into `.switchboard/archive/`, which is a real operation the stub refuses to perform.

**So `archiveToCold` has no caller.** The method exists, is transactional, moves child rows and
moves the plan file -- and nothing in the product invokes it. `AutoArchiveService` would, but its
effective switch has never been written (`a064cf90`). The consequence is that the file-move half
shipped on 2026-09-18 has never executed even once.

**This undercuts the bin card.** `COMPLETED Is the Bin` specifies archive-on-move-to-COMPLETED and
promotion from the ARCHIVES view. Both need a trigger that works; neither can be built on a stub
that returns an error. The gap is not visible from that card's text, which is why it is its own.

### Root Cause

The button and the mechanism were retired together and then the mechanism was rebuilt without the
button. The stub's error message is a tombstone for a DuckDB export, left in place as documentation,
and it reads as a deliberate refusal rather than a missing wire.

### What this card must do

1. Reimplement `archiveSelected` against `archiveToCold` -- per card, transactional, with features
   and their subtasks moving together or not at all.
2. Report honestly per card: archived, already archived, or failed with a reason. A partial batch
   must not report success.
3. Give promotion a trigger too (`restoreToHot`), reachable from the ARCHIVES view.
4. Delete the DuckDB-era error message rather than editing it -- it describes a subsystem that no
   longer exists in any form.
5. This is the first execution path for the plan-file move, so it is also its first test: assert the
   row lands in `plans_archive`, the file lands in `.switchboard/archive/`, and a promote reverses
   both.

## Metadata

**Complexity:** 3
**Tags:** archive, ux, backend
**Dependencies:** none to start. `COMPLETED Is the Bin` depends on this, not the reverse -- the bin
card's automatic path should call the same operation this card exposes manually.

## User Review Required

1. **Does a manual archive button survive once COMPLETED is the bin?** Recommendation: yes, for
   cards that are stale rather than complete -- otherwise the only way to clear a card is to declare
   it done, which is a lie the board will later report as history.

