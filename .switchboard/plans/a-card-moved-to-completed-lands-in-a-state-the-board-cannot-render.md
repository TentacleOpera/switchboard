# A Card Moved to COMPLETED Lands in a State the Board Cannot Render

## Goal

Moving a card to COMPLETED completes it. One notion of "done", written by every path that claims to
finish a card, so the Completed column shows what is in it and the archive can age it out.

### The problem, and the root cause

**Reproduced 2026-09-18 on the live board.** `POST /kanban/move` with
`targetColumn: "COMPLETED"` returned `{"success": true}`. The resulting row:

```
plan_id        8b7e5490…
kanban_column  COMPLETED
status         active          ← not 'completed'
completed_at   (empty)
column_entered_at  2026-09-18T05:18:20.695Z
```

The card is in the COMPLETED column and **does not appear in the Completed column**, because that
column is not rendered from the column value. `getPlansByColumn`
(`KanbanDatabase.ts:5478-5482`) switches on the column name and filters by *status* instead:

```ts
// For COMPLETED column, show status='completed' plans
// For other columns, show status='active' plans
const statusFilter = column === 'COMPLETED'
    ? `status = 'completed'`
    : `status = 'active'`;
```

So a card whose `kanban_column` is COMPLETED but whose `status` is `active` matches neither arm. It
is not in Completed (wrong status) and not in any other column (wrong column). It is on the board
and unreachable from it.

**Two writers, two different notions of done, and the move only sets one.** The move seam
(`bootstrap.ts:5406` → `resolveAndMoveCard`) writes `kanban_column` and `column_entered_at`.
Nothing on that path writes `status` or `completed_at` — a grep for `status = 'completed'` across
`KanbanProvider.ts` and `bootstrap.ts` returns nothing. The completion timestamp has exactly one
writer, and it is a different endpoint:

> **`setCompletedAt`** (`KanbanDatabase.ts:3797`): *"Set the asserted completion timestamp on a
> plan. Written by POST /kanban/task/complete — the only writer. **Does NOT move the card** or
> dispatch anything."*

So `/kanban/task/complete` sets the timestamp without moving the card, and `/kanban/move` moves the
card without setting the status or the timestamp. Neither endpoint alone produces a coherently
completed card, and nothing composes them.

**The archive still catches it, which is why this has stayed hidden.** Of the three paths that age
cards out, two key on fields the move *does* write:

| path | keys on | sees this card |
| :--- | :--- | :---: |
| `AutoArchiveService:228` | column-entry dwell, `?? updatedAt` | yes |
| `selectColdEligiblePlanIds` | `updated_at`, `status != 'deleted'` | yes |
| `getCompletedPlansInHotWindow` | `status = 'completed'` | **no** |

Nothing keys on `completed_at`, so the card is not orphaned from archiving — it just never renders.
A defect that loses a card from the UI while leaving every retention path happy produces no error
and no log line.

### Root cause

"Done" is stored twice — as a column and as a status — and the two are written by different
endpoints with no invariant tying them together. The Completed column then reads the status while
the board writes the column, so the one column whose contents are derived from a *different* field
than every other column is also the only column a gesture can put a card into incorrectly.

`CLAUDE.md`'s fallback rule is the same shape one level up: `status` and `kanban_column` are both
routing reads, and a row where they disagree is a value that looks configured and behaves wrongly.

## Non-goals

- **Collapsing `status` and `kanban_column` into one field.** `status` also carries `deleted` and
  `missing`, which are not columns, and the hot/cold split keys on `status != 'deleted'`. That is a
  schema change with a much larger blast radius than this bug.
- **Changing what the archive keys on.** All three paths are defensible as they stand; none of them
  is the defect.
- **The reverse fault.** A `kanban_column` outliving a deleted row is the same family and is
  already owned by feature `6b752808` (*Board Rows Outlive Their Plans, and Nothing Archives
  Them*). This card is the arrival case, not the survival case.

## Metadata

**Tags:** bugfix, kanban, data-integrity
**Complexity:** 3

## Scope: shared service, both roots

`resolveAndMoveCard` and the Completed-column read in `src/services/KanbanDatabase.ts`. Both are
shared services the two composition roots already consume, so the fix reaches the extension host
without any new wiring in `extension.ts`.

## Proposed changes

### 1. A move into COMPLETED sets the status and the timestamp

`resolveAndMoveCard` must, when the target column is COMPLETED, set `status = 'completed'` and
`completed_at` in the **same statement** as the column update — not a second write that can fail
independently and leave exactly the split state this card describes.

Moving *out* of COMPLETED must reverse it: `status = 'active'` and `completed_at = NULL`. That
writer already exists (`KanbanDatabase.ts:3820`), so the un-complete direction is a call, not new
code.

### 2. Refuse to write a row whose column and status disagree

A single guard at the write seam: a row may not be persisted with `kanban_column = 'COMPLETED'` and
`status = 'active'`, nor with `status = 'completed'` and any other column. Fail the write naming
both values rather than accepting it — the whole cost of this bug is that the inconsistent row was
written successfully and reported `{"success": true}`.

### 3. Repair the rows that already exist

One pass at open: any row whose column and status disagree is reconciled toward the **column**,
because the column is what the operator last acted on. Log each repair with both values. On this
board that is one row; on an install where operators have been dragging cards to Completed for
months it will not be.

### 4. Decide what `/kanban/task/complete` means, and say so

It currently sets a timestamp and deliberately does not move the card, which leaves a third state:
`completed_at` set, column and status untouched. Either it completes the card fully (and change 1's
logic is shared), or it is renamed to reflect that it records an assertion rather than completing
anything. Leaving two endpoints both called "complete" that produce different rows is what caused
this.

## Complexity Audit

### Routine

- Setting status and timestamp in the move's existing update.
- The reconciliation pass and its logging.

### Complex / Risky

- **The Completed column's read is the asymmetry.** Change 1 makes the two fields agree, but
  `getPlansByColumn` still derives one column from a different field than the other ten. Either
  leave it (correct once the invariant holds) or switch it to read `kanban_column` like every other
  column — the second is cleaner and changes what an existing `status='completed'` row with a
  non-COMPLETED column would render as. **Audit that population before switching**; the archive
  we ran on 2026-09-18 moved 2,559 such rows to cold, so the remaining hot population is small and
  now is the cheap moment to look.
- **Change 4 is a contract decision, not a code change.** `/kanban/task/complete` is agent-facing;
  agents call it to report completion. Changing its behaviour changes what `done` means to every
  seat. Decide deliberately, and if it stays as-is, document why in the handler.

## Edge-Case & Dependency Audit

- **A bulk move into COMPLETED** must set status for every card in the batch or none — the gate in
  change 2 makes a partial batch a hard failure rather than a set of half-completed rows.
- **`completed_at` already set, card then moved out of COMPLETED.** Clearing it is right; a stale
  completion timestamp on an active card is another value that looks authoritative and is not.
- **The archive interaction.** Once status is written correctly, a moved card becomes visible to
  `getCompletedPlansInHotWindow` and so starts being materialised into every board build for the
  hot-window duration — currently a 45-day default. That is correct behaviour and it is also the
  cost the 1 GB budget cares about; see
  `the-board-must-fit-a-1gb-pi-and-the-peak-is-what-does-not.md`, where completed rows inside the
  window were three quarters of every build.
- **Security/permissions:** none. No new surface; both writes already exist.

## Dependencies

None blocking. Related:

- `6b752808` — *Board Rows Outlive Their Plans, and Nothing Archives Them*. Same family, opposite
  direction: that feature covers a column surviving a row's death, this card covers a column
  arriving without its status.

## Verification Plan

### Automated Tests

- **Contract** — `POST /kanban/move` with `targetColumn: "COMPLETED"` produces a row with
  `status = 'completed'` and a non-empty `completed_at`, and the card appears in a subsequent
  Completed-column read. **This fails today and is the whole bug.**
- **Contract** — moving that card back out sets `status = 'active'` and `completed_at = NULL`.
- **Contract** — a write attempting `kanban_column = 'COMPLETED'` with `status = 'active'` is
  refused, naming both values.
- **Unit** — the reconciliation pass repairs a disagreeing row toward the column and logs both
  values; a consistent row is left byte-identical.
- **Regression** — no board read can return a card that matches neither the COMPLETED arm nor the
  active arm of `getPlansByColumn`.

Run `npm run compile-tests` before any `test:contract:*` script.

### Manual Verification

Drag a card to Completed on the board. It appears in Completed and stays there after a refresh.
Today it disappears from the board entirely.

### Goal Invariants

1. No row exists with `kanban_column = 'COMPLETED'` and a status other than `completed`.
2. Every card on the board is returned by exactly one column read.
3. A gesture that reports success leaves a row the board can render.

## Live evidence 2026-09-18 — four incompatible definitions of "done"

Measured on the board while investigating why auto-archive would archive the wrong rows. Each
plausible archive predicate selects a different and barely-overlapping set:

| predicate | selects |
| :--- | ---: |
| `status = 'completed'` | 1 |
| `kanban_column = 'COMPLETED'` | 32 (of which **31 are `status='deleted'`**) |
| `completed_at` populated | 39 (**none** of them in the COMPLETED column) |
| `kanban_column='COMPLETED'` AND `column_entered_at` > 2 weeks | 31 |

All 32 cards sitting in COMPLETED have an **empty `completed_at`**, while 39 cards in other
columns carry one. So the column and the completion timestamp disagree about which cards are
finished, in both directions.

This makes the card a hard prerequisite for `a064cf90` (Auto-Archive Has Never Run): fixing
the switch before this lands would archive 31 deleted cards and miss everything real.
