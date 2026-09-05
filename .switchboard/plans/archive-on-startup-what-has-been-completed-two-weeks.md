# Archive on Startup What Has Been in Completed Two Weeks

kanbanColumn: CREATED

## Goal

At startup, once, move every card that entered COMPLETED two or more weeks ago into the cold store. Replace the dwell-triggered auto-completion sweep with this.

### Problem analysis

**Nothing has ever been archived.** No `kanban-archive.db` exists in this workspace or in `~/.switchboard`, and there are no archive config rows — on a board holding plans since June, with `switchboard.archive.autoArchiveCompleted` defaulting to `true`.

**The immediate cause is a composition-root divergence.** `startAutoArchiveForAll()` is called only from `extension.ts` (`:1269`, `:1273`, `:1279`). `bootstrap.ts` contains no reference to it, so on the standalone host the service is never constructed and its sweep never ticks. This is the third instance of that pattern found on 2026-09-05, alongside the managed-block refresh and the protocol scaffolder — the trap `CLAUDE.md` opens by describing, where "never wired" and "working" produce identical gates.

**But the extension has been running for months and archived nothing either**, so the wiring gap is not the whole story. Something else prevents it firing even where it is started, and that needs establishing rather than assuming.

**And the existing rule is not the rule that is wanted.** Its docblock:

> *"After a configurable dwell in a **designated** column (default = the stage immediately before Completed), a plan **auto-moves to Completed** and archives locally."*

That is auto-completion on a two-hour dwell, swept every five minutes. On this board it would have taken the 2,063 cards resting in CODE REVIEWED and force-completed them, unattended, two hours after each arrived. It never ran, which is fortunate.

**What is wanted is narrower and safer.** Archive what a human already marked done, once, at startup:

| | current | wanted |
| :--- | :--- | :--- |
| watches | the column *before* COMPLETED | COMPLETED |
| threshold | 2 hours | 2 weeks |
| cadence | every 5 minutes | once, at startup |
| effect | moves the card *into* COMPLETED, then archives | archives what is already there |

It cannot advance a card, it acts only on an explicit human decision, and it does no work while the board is in use.

**The data supports it today.** `column_entered_at` is populated on all 2,567 COMPLETED rows with no nulls, and **485** of them are already past two weeks.

## Metadata

- **Complexity:** 4
- **Tags:** archive, watcher, both-hosts, bugfix

## User Review Required

None.

## Proposed Changes

### 1. Archive on startup, on age in COMPLETED

One pass at startup. Any card whose `column_entered_at` is two or more weeks ago and whose column is COMPLETED moves to the cold store.

Two weeks is the default and should be configurable. No periodic sweep — a board that has been up for a month has nothing new to archive that a restart will not catch.

### 2. Delete the dwell-triggered auto-completion

The current rule moves cards *into* COMPLETED after a dwell. Remove it rather than reconfiguring it: an unattended mechanism that marks work done because it sat still is not a behaviour to keep, and on a board with 2,063 resting cards it is a foot-gun that happens not to have fired.

State that in the change so it is not reinstated as a configurable option.

### 3. Establish why the extension archived nothing either

The standalone wiring gap explains the last month. It does not explain the months before, when the extension was in use and `startAutoArchiveForAll()` *was* called.

Find that cause before building — if it is a second defect, the new rule inherits it.

### 4. Wire it in both hosts

`bootstrap.ts` must start it too. Since the trigger becomes "at startup", it belongs beside the other startup work in each composition root rather than behind a lazily-built accessor that only one caller reaches.

## Edge-Case & Dependency Audit

1. **Archiving must move the plan file, or the folder still grows.** `ArchiveManager` contains no `unlink`, `rename` or `copyFile`; archival today is a status change only. If the file stays in `.switchboard/plans/`, the scanner's directory listing and recognition set keep growing and the archive has not solved what it appears to solve. Decide explicitly whether the file moves.
2. **`status` on an archived row is `'completed'`, not `'archived'`.** The V10 migration rewrote historical `'archived'` rows, and the `archive` skill records that filtering on `'archived'` returns zero rows on a full archive. Do not reintroduce the other value.
3. **A card moved to COMPLETED by hand and moved back out** must not be archived on the strength of a stale `column_entered_at`. Confirm the field is rewritten on every column change, not only the first.
4. **485 cards would archive on the first run.** That is correct and intended, but it is a large single-pass change to a live board — it should report what it did rather than doing it silently.
5. **Features and their subtasks** must archive together or not at all; a feature in the cold store with live subtasks on the board is worse than either.
6. **The cold store does not exist yet.** First run creates it. Confirm creation is explicit rather than relying on `sqlite3` conjuring an empty file, which the `archive` skill warns about by name.

## Verification Plan

1. On startup, cards two or more weeks in COMPLETED are archived; younger ones are not.
2. No card is moved *into* COMPLETED by this mechanism, ever.
3. No periodic sweep runs.
4. Both hosts archive identically.
5. The plan file is handled per the change-1 decision, and the plans directory shrinks if that decision is to move it.
6. An archived row carries `status = 'completed'`.
7. A card returned from COMPLETED to an active column is not archived.
8. A feature and its subtasks archive together.
9. The first run reports the count rather than archiving silently.
