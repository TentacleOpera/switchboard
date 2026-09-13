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
`purgeMissingPlansOlderThan` (`KanbanDatabase.ts:4100`):

```sql
DELETE FROM plans WHERE status = 'missing' AND workspace_id = ? AND updated_at < ?
```

`status = 'missing'` is hard-coded, so `deleted` rows are out of reach — 61 of them, indefinitely.
The sweep itself is healthy and correctly scheduled (`runPurgeSweep`, `PlanIngestionEngine.ts:973`, called at `:531`
on start and `:785` on the periodic pass, 24-hour cutoff); it simply has a predicate that excludes
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

**This was fixed once, in 2026, and the fix did not hold**

`Fix: Archived Plans Leave Ghost kanban_column — Invisible in UI, Visible in DB Queries` (`9ed3690e`,
**COMPLETED**) is this defect. Its goal statement names the same mechanism — status set, column left
behind — and it explicitly scoped the repair wider than archiving:

> A one-time migration repairs existing ghosts (**including `deleted` plans, which suffer the same
> defect**).

Yet 43 ghosts stand today, 30 of them `deleted`. **Resolved from the code (2026-09-12):** the
column-clearing landed on `archivePlan()` (`KanbanDatabase.ts:3685`, sets `kanban_column='COMPLETED'`)
— used by `AutoArchiveService` (archive), `KanbanProvider.reassignPlansWorkspace` (delete-on-reassign,
`:10137`), and `TaskViewerProvider` (archive/delete UI, `:17956`). It did **NOT** land on the two
delete paths that set `status='deleted'` directly without touching the column:

- `tombstonePlan(planId)` (`KanbanDatabase.ts:7861`) — `UPDATE plans SET status='deleted'` only.
- `purgeOrphanedPlans` (`KanbanDatabase.ts:8261`) — same one-dimensional shape.

The completion path clears the column via `updateColumn('COMPLETED')` *then* `updateStatus('completed')`
(`KanbanProvider.ts:12601/12608`), so normal completion is guarded — the 10 `completed|CODE REVIEWED`
ghosts are legacy/race rows from before that pairing, not the live write path. So the ghost-creating
paths are `tombstonePlan` and `purgeOrphanedPlans`, **not** `updateStatusByPlanFile` (which the prior
plan named as the suspect). The remedy is not another one-time migration that leaves the write path
unguarded — it is routing every delete through the one seam that clears the column (`archivePlan`),
so a new delete cannot create a ghost in the first place.

## Metadata

**Complexity:** 5
**Tags:** kanban, database, hygiene

## User Review Required

None.

## Complexity Audit

### Routine
- The column-clearing seam already exists: `archivePlan()` (`KanbanDatabase.ts:3685`) sets `kanban_column='COMPLETED'` atomically with status — the fix routes the two unguarded delete callers to it rather than inventing a new mechanism.
- The purge sweep is already scheduled and healthy (`runPurgeSweep`, `PlanIngestionEngine.ts:973`, called at `:531` on start and `:785` on the periodic pass); widening its predicate is a one-line SQL change plus a rename.
- A one-time repair of the 43 standing ghosts reuses the same `UPDATE` shape the prior migration used.

### Complex / Risky
- Two delete paths (`tombstonePlan`, `purgeOrphanedPlans`) are called from multiple sites; routing them through `archivePlan` changes a seam that callers may depend on for the *column-not-cleared* property (e.g., undelete/restore that reads the pre-death column). The restore path must be verified, not assumed.
- Widening the purge to `deleted` reaps rows an operator may expect to recover; the retention window for an operator-initiated delete must be longer than the 24h file-vanish window, and the external-tracker archival (`PlanIngestionEngine.ts` archive-before-delete) must run for the newly-covered rows too.
- The 440 `completed`-with-no-file rows are the only record of finished work (no archive store exists); reaping them silently destroys the last trace. This is a decision, not a purge target.

## Edge-Case & Dependency Audit

- **Race Conditions:** a delete that clears the column must not race a concurrent move that sets a new column — the column-clear must be in the same atomic `UPDATE` as the status set (as `archivePlan` already does), not two separate statements.
- **Security:** none — internal hygiene, no auth surface.
- **Side Effects:** undelete/restore must recover a sensible column; if the pre-death column is needed for that, it must live in a plainly historical field, not in the one the board reads.
- **Dependencies & Conflicts:** `regenerateFeatureFile` must still fire for a deleted row that belongs to a feature. The `deleteSyncEnabled` gating on external-tracker archival must apply to the newly-purged `deleted` rows, not only `missing`. The auto-archive card (`a064cf90`) fixes the archive switch but must not enable archiving before the store placement (`fbdddc53`) lands — the two cards are complementary, not conflicting.

## Dependencies

- Complementary to `a064cf90` (auto-archive): that card fixes the switch and leaves the effective default off; this card fixes the column-clearing and the purge. Neither pre-empts the other.
- The 440 `completed` rows are not reaped until a real archive store exists (the store placement is `fbdddc53`'s decision, deliberately not this card's).

## Adversarial Synthesis

Key risks: routing deletes through `archivePlan` could break a restore path that relied on the stale column; widening the purge could reap recoverable rows before their tracker counterpart is archived. Mitigations: make the column-clear atomic with the status set (already true in `archivePlan`), give `deleted` its own longer retention window, and run the external-tracker archive-before-delete for `deleted` rows too. Do not reap `completed` rows — the row is the only archive until a store exists.

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

### 3. Do not reap the 440 completed-with-no-file rows

- **Logic:** These are historical completions whose plan files were removed. There is **no archive
  store** — no DuckDB file exists, and `archive-on-startup-what-has-been-completed-two-weeks.md`
  (`ccffc96a`) is a proposal, not shipped — so the file content is simply gone and the row is the
  only record. **Decision: do not reap them.** The row is the archive until a real archive store
  exists (the store placement is `fbdddc53`'s decision). Ensure completed rows sit in the `COMPLETED`
  column (the completion path already does via `updateColumn`); a one-time repair can fix the 10
  legacy `completed|CODE REVIEWED` ghosts to `COMPLETED`, but no row is deleted.
- **Rationale:** Reaping them silently would destroy the last trace of 440 finished plans. Leaving
  the question open in a plan a coder is supposed to execute is not a decision — this is.

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
