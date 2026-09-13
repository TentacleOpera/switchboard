# A First Run Imports Every Plan File as Active Work

## Goal

Make installing on a repository that already contains plans a survivable first run. Today the
watcher imports every `.md` under the plans directory and each one lands in `CREATED` —
`status='active'` — so a repo carrying thousands of historical plans produces thousands of
active cards on a box chosen for being small. A repository's existing plans are history, not a
backlog somebody is holding.

### Problem analysis

**Every imported file becomes active work.** `plans.kanban_column` defaults to `'CREATED'` and
`CREATED` is an active column, so an import with no other signal produces an active row. The
importer has no notion of "this plan was finished before you ever saw it" — nothing in the file
tells it, and nothing asks.

**Measured on this workspace (2026-09-11):** 2,322 plan files on disk. Here they resolve to 548
active rows because this board has walked them through to completion over months of use, and
that history lives in the database rather than in the files. A *different* machine importing
the same repository has none of that history. It gets 2,322 active cards.

**This has already happened twice, on hardware that could absorb it.** Completed rows on this
board carry `updated_at` clustered on two days — 1,763 on 2026-09-09 and 321 on 2026-09-05 —
which is the signature of a bulk re-import, not of work. On a 4 GB machine it showed up as
bloat. The board-only configuration targets **1 GB**, where the host alone measures 182 MB idle
and drifts past 270 MB within an hour.

**The unbounded read makes it fatal rather than merely slow.** `getBoard()` selects every
active row with no `LIMIT`, materialises 36 columns per row, runs a second overlay statement
across the whole set, and pushes the lot to the webview. That is the companion card; this one
is why the number is large in the first place. Bounding the read alone would leave a first run
importing thousands of rows and showing a permanently truncated board — correct, but useless.

**There is no install base to protect.** The Pi product has not shipped. So this is not a
migration with legacy state to preserve: it is the definition of what a first run should do,
and it can be decided cleanly rather than compatibly.

### Root cause

Import was written for the case it was born in — a plans directory that grows as you work, one
file at a time, each one genuinely new. Under that assumption "a file appeared" and "there is
new work" are the same event, so `CREATED` is the right landing column and volume never arises.
Pointing the same watcher at an existing corpus breaks the assumption silently: every file
looks new because the *database* has not seen it, regardless of how old the work is.

### Non-goals

- A cold store or any second database. Explicitly not wanted; this is an import policy.
- Deleting or rewriting plan files. Nothing here touches the markdown.
- Retention. Nothing here removes a row.
- Bounding the board read — the companion card owns that, and both are wanted: this one keeps
  the number small, that one keeps it safe when it is not.

## Metadata

**Complexity:** 5
**Tags:** infrastructure, reliability, ux, backend, database

## User Review Required

None.

## Complexity Audit

### Routine
- The import default is already a schema constant (`kanban_column DEFAULT 'CREATED'`, `status DEFAULT 'active'`, `KanbanDatabase.ts:349-350`); redirecting historical plans to a non-active landing is a branch on the import path, not a new table.
- Reporting import counts reuses existing logger surfaces; the steady-state path (one new file → CREATED active) is unchanged.

### Complex / Risky
- "First run = empty board" is ambiguous: a board that has been wiped (all rows deleted) also looks empty, so a re-import after a wipe would treat live plans as history. The first-run detection must distinguish "never used" from "used then cleared" (e.g., an initialization sentinel).
- The age signal is the load-bearing decision. A `git clone` re-stamps every file's mtime to now, so on the very machine a fresh install happens on, mtime says "new" for everything. Git's first-commit time for the plan file is the honest signal; mtime is honest only on a hand-curated directory, not a clone. Where neither is trustworthy, default to history (visible, cheap to undo).
- Landing historical plans outside the active set must be reversible per card (move back into a working column) without stranding the card outside every lane.

## Edge-Case & Dependency Audit

- **Race Conditions:** a first run that overlaps a genuine new-file write must not classify the new file as history; the steady-state path must remain untouched (one new file on an established board → CREATED active).
- **Security:** none — import reads, it never writes (the plans directory is byte-identical before and after).
- **Side Effects:** misclassifying a live plan as history hides it from the active board until an operator moves it back; the failure mode is visible (the card is absent from the board) and cheap to undo, against one that fills a 1 GB board.
- **Dependencies & Conflicts:** the board-read LIMIT card (`1cb5a069`) caps the read; this card keeps the number small at the source. Both are wanted — bounding the read alone leaves a first run importing thousands and showing a permanently truncated board.

## Dependencies

- Companion to `1cb5a069` (board-read LIMIT): that card keeps the read safe when the count is large; this card keeps the count small at the source. Both are wanted and independent — neither blocks the other, but a first run on a 1 GB box wants both.

## Adversarial Synthesis

Key risks: "first run = empty board" misfires on a wiped-but-used board; mtime lies on a freshly cloned repo. Mitigations: detect first run via an initialization sentinel (not mere row absence); prefer git first-commit time for the age signal, fall back to mtime only when not a fresh clone, and default to history when neither is trustworthy. The steady-state path stays untouched.

## Proposed Changes

1. **A first run is a distinct event, and it knows it.** Importing into an empty board is not
   the same as noticing one new file, and it should not take the same path.
2. **Historical plans do not land in a working column.** A file that predates the board's own
   existence is history. Landing it outside the active set — a terminal column, or imported
   with a non-active status — is what keeps a first run bounded at the source, and it is
   reversible per card by moving it back.
3. **The age signal comes from the file, not the clock.** Import time tells you nothing:
   every file is "new" at first run. The file's own mtime, or git's record of it, is the only
   honest input. Where neither is available, treat it as history rather than as work — that is
   the failure that is visible and cheap to undo, against one that fills a 1 GB board.
4. **Say what happened.** A first run reports how many plans it imported and how many it placed
   as history. Silently creating 2,322 cards and silently creating 40 must not look the same.

## Verification Plan

- **Fresh install, used repo:** point a new board at a repository with 2,500 plan files.
  Assert the active card count is bounded by the policy rather than by the file count, and
  that the host stays within the 1 GB board-only budget throughout the import.
- **Genuinely new work is unaffected:** write one new plan file to an established board.
  Assert it lands in `CREATED` exactly as today — the steady-state path must not change.
- **Reversible:** assert a plan placed as history can be moved back into a working column and
  behaves normally afterwards.
- **Reported:** assert the first run's counts are surfaced, and that a run importing thousands
  is distinguishable from one importing a handful.
- **Parity:** assert both composition roots take the same import path; the watcher runs on both.

### Goal Invariants

- **A first run cannot fill the board:** assert that importing N historical files produces an
  active count independent of N.
- **The steady-state path is untouched:** assert a new file on an established board still
  becomes an active `CREATED` card, so the fix cannot be "import nothing".
- **No file is modified:** assert the plans directory is byte-identical before and after a
  first run — import reads, it never writes.
- **The signal is not import time:** assert the policy reads the file's own age, and that two
  files imported in the same second can land differently.
