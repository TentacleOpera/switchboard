# A Dead Row Keeps Its Working Column, and Nothing Ever Reaps It

## Goal

A row that is deleted or completed must stop claiming a working column, and dead rows must not
accumulate forever. Today 41 rows with no plan file sit in CREATED, PLAN REVIEWED and CODE REVIEWED,
and the only purge that exists cannot touch any of them.

### Problem analysis

**Counted on this board, 2026-09-09.** Every `plans` row was checked against the filesystem — 511 of
3,136 have no plan file:

| status | kanban_column | rows |
| :--- | :--- | ---: |
| completed | COMPLETED | 440 |
| deleted | COMPLETED | 30 |
| **deleted** | **PLAN REVIEWED** | **15** |
| **deleted** | **CREATED** | **15** |
| **completed** | **CODE REVIEWED** | **10** |
| **missing** | **CREATED** | **1** |

The bolded 41 are the ones in working columns. **None of them is `status='active'`** — verified — and
the board does not serve them: the live API returns 524 rows, of which **0** have an absent file. So
nothing the operator sees is wrong today. The defect is in what the rows say about themselves and in
the fact that they are permanent.

#### Two separate faults

**1. `kanban_column` is never cleared when a row dies.** Deleting a card out of Planned leaves
`deleted | PLAN REVIEWED` forever; the column records where the card was standing when it died, not
where it is. That is a field that reads as live state and is not. Ten rows go further and are
internally contradictory — `completed | CODE REVIEWED` asserts both that the work finished and that
it is awaiting review. Whichever field a reader trusts, the other one contradicts it.

**2. Nothing purges a dead row.** The only reaper is
`purgeMissingPlansOlderThan` (`KanbanDatabase.ts:3591`):

```sql
DELETE FROM plans WHERE status = 'missing' AND workspace_id = ? AND updated_at < ?
```

`status = 'missing'` is hard-coded, so `deleted` rows are out of reach — 61 of them, indefinitely.
The sweep itself is healthy and correctly scheduled (`PlanIngestionEngine.ts:956`, called at `:522`
on start and `:768` on the periodic pass, 24-hour cutoff); it simply has a predicate that excludes
almost everything dead.

#### Why it matters despite the board being clean

The safe queries carry `AND status = 'active'` — every template in the `query-kanban` skill does. The
risk is the query that does not. An agent, a report or a hand-rolled `WHERE kanban_column = 'CODE
REVIEWED'` picks up all 41, and ten of them look like finished work parked in Reviewed. The rows are
invisible through the API and visible through SQL, which is the worst combination: the surface that
gets audited is clean and the surface agents actually query is not.

**Observed cost already.** Two cards this session were investigated as orphans before being found
intact — `1e5da4ea` (recovered from a stash) and `209ce349` (present on the Pi, uncommitted). Neither
was a database fault. A fileless row is currently indistinguishable from a lost plan, so every one of
them invites the same investigation.

## Metadata

**Complexity:** 3
**Tags:** kanban, database, hygiene

## User Review Required

None.

## Proposed Changes

### 1. A dead row stops claiming a working column

- **Logic:** On delete and on completion, `kanban_column` must reflect the row's actual state — set it
  to the terminal column, or null it. A row must never assert a working column and a dead status at
  once.
- **Edge cases:** Undelete and reopen must restore a sensible column rather than stranding the card
  outside every lane. If the pre-death column is needed for that, keep it in a field that is plainly
  historical, not in the one the board reads.

### 2. The purge reaps every dead row, not only `missing`

- **Logic:** Widen `purgeMissingPlansOlderThan` to cover `deleted` as well, with its own retention
  window — deletion is an operator action and deserves a longer grace period than a vanished file.
  Rename it; the current name will be a lie the moment it stops being missing-only.
- **Edge cases:** The sweep already archives ClickUp/Linear/Notion counterparts before deleting
  (`PlanIngestionEngine.ts:970-1014`) and that must run for the newly-covered rows too, gated on the
  same `deleteSyncEnabled` checks. A row belonging to a feature must still trigger
  `regenerateFeatureFile`.

### 3. Decide what the 440 completed-with-no-file rows are

- **Logic:** These are historical completions whose plan files were removed. There is **no archive
  store** — no DuckDB file exists, and `archive-on-startup-what-has-been-completed-two-weeks.md`
  (`ccffc96a`) is a proposal, not shipped — so the file content is simply gone and the row is the
  only record. Either that is acceptable and the row should say so, or those completions should be
  archived somewhere before their rows are reaped. Not a purge target until that is decided.
- **Rationale:** Reaping them silently would destroy the last trace of 440 finished plans.

## Verification Plan

### Automated Tests
- Deleting a card from PLAN REVIEWED leaves no row asserting PLAN REVIEWED.
- Completing a card leaves no row asserting CODE REVIEWED.
- The purge removes an aged `deleted` row and archives its tracker counterpart when delete-sync is on.
- The purge leaves `completed` rows alone.
- A query filtering only on `kanban_column`, with no status predicate, returns no dead rows.

### Goal Invariants
- No row carries a working column and a dead status simultaneously.
- Every dead row has a path out of the table.
- SQL and the API agree about what is on the board.

### Manual
- Re-run the filesystem cross-check after a sweep and confirm the working-column count is zero.

## Outstanding Questions

- None.
