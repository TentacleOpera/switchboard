# Working-state data model + activity light ON at dispatch

## Goal

Introduce the per-card "agent working" state and turn it ON at the moment a card is
dispatched to an agent. This is the foundation subtask of the *Agent activity lights*
epic — every other light subtask depends on the state added here.

### Core problem & root cause

Switchboard has **no per-card activity concept**. The `plans` table has `routed_to`,
`dispatched_agent`, `dispatched_ide` (`src/services/KanbanDatabase.ts:137-139`) but **no
timestamp** — nothing records *when* an agent started, so nothing can decide whether it is
still working. There is no `working`/`activity`/`heartbeat`/`in_progress` state anywhere in
the DB or `KanbanProvider` (`lastActivity` on `KanbanCard` is only a sort key, populated
from `updatedAt || createdAt` at `KanbanProvider.ts:1373/1390`). The light cannot exist
until this state does.

### Design

Store a single `dispatched_at` timestamp column (nullable). "Working" is **derived**, not a
second stored boolean, to avoid a two-field consistency problem:

```
working = dispatched_at IS NOT NULL
          AND no `**Stage Complete:**` marker has cleared it   (subtask B-3)
          AND (now - dispatched_at) < 20 minutes               (subtask B-5)
```

Subtasks B-3 and B-5 clear `working` by **nulling `dispatched_at`**. So this subtask only
needs to (a) add the column, (b) set it at dispatch, (c) surface a computed `working` flag on
the card payload and in the re-render signature. The 20-min age check is applied at read time
here (cheap) and enforced authoritatively by the B-5 sweep.

## Metadata

- **Project:** Switchboard
- **Tags:** kanban, backend, migration, dispatch
- **Complexity:** 5

## Implementation

1. **Migration — add `dispatched_at`.**
   - Add `dispatched_at TEXT DEFAULT NULL` to the `plans` schema (`KanbanDatabase.ts:120-148`,
     near the dispatch columns at 137-139).
   - Add the matching idempotent `ALTER TABLE plans ADD COLUMN dispatched_at ...` in the
     migration block at `KanbanDatabase.ts:243-245` (follows the existing add-column pattern;
     no backfill needed — NULL correctly means "not currently working").
   - Add `dispatched_at` to `PLAN_COLUMNS` / `_readRows()` so it is selected into rows, and to
     `KanbanPlanRecord` (`KanbanDatabase.ts:35-65`).

2. **Write the timestamp at dispatch.**
   - Extend `updateDispatchInfoByPlanFile` (`KanbanDatabase.ts:6488`) to also set
     `dispatched_at = ?` (ISO string) in its UPDATE.
   - Set it centrally in `KanbanProvider._recordDispatchIdentity` (`KanbanProvider.ts:2721`)
     so **all** dispatch entry points inherit it uniformly (drag-drop/CLI at
     `KanbanProvider.ts:6437/6468/6968/6980`; terminal paths in `TaskViewerProvider.ts:3253/
     3680/14623/16723`). Per the historical note in
     `move_kanban_cards_immediately_before_terminal_dispatch.md`, dispatch responsibility is
     split between `TaskViewerProvider` and `KanbanProvider` depending on
     `explicitTargetColumn` — centralizing the write in `_recordDispatchIdentity` avoids
     missing a path. Confirm every entry point actually reaches `_recordDispatchIdentity`;
     if any bypasses it, set `dispatched_at` there too.

3. **Card payload + re-render signature.**
   - Add `working?: boolean` to the `KanbanCard` interface (`KanbanProvider.ts:104-118`).
   - Compute `working` when building card objects from rows at `KanbanProvider.ts:1366-1382`
     (active) and `1384-1398` (completed), and the parallel builders at `2913-2940` and
     `3084-3098`. Guard: never `working` for `status !== 'active'` or `kanban_column ===
     'COMPLETED'`.
   - Add `working` to the board-diff signature string at `kanban.html:4575` — it currently
     includes `lastActivity` but no working flag, so **without this the light will not
     re-render on state change.** (createCardHtml rendering itself is subtask B-6.)

## User Review Required

- Confirm `dispatched_at` (timestamp, derive `working`) over a stored `working` boolean.
- Confirm the light should be suppressed for completed/inactive cards.

## Complexity Audit

### Routine
- Add-column migration (follows the existing `ALTER TABLE` pattern at lines 243-245).
- Adding a field to `KanbanPlanRecord` / `KanbanCard` and to the card builders.
- Extending the dispatch UPDATE with one more assignment.

### Complex / Risky
- **Dispatch is not single-sourced.** Multiple call sites and a documented split between
  `TaskViewerProvider` and `KanbanProvider` mean a naive edit to one path leaves lights that
  never turn on. Centralize in `_recordDispatchIdentity` and audit all listed call sites.
- **Re-render signature is easy to miss.** If `working` is not added to the `kanban.html:4575`
  diff signature, the board's change-detection short-circuits and the light silently never
  updates — a classic "works in DB, invisible in UI" bug.
- **`_recordDispatchIdentity` returns early for untracked columns** (`KanbanProvider.ts:2728-
  2737`). Verify that dispatches you want lit are to tracked stage columns; decide whether a
  dispatch to an untracked column should still light up.

## Edge-Case & Dependency Audit

- **Re-dispatch:** dispatching an already-working card should refresh `dispatched_at` (resets
  the 20-min clock) — the UPDATE naturally overwrites it.
- **Migration on ~4,000 installs:** existing rows get `dispatched_at = NULL` = not working,
  which is correct. No backfill, no data loss (per repo migration rules in CLAUDE.md).
- **Dependencies:** none upstream. Downstream: B-3 (marker clear), B-5 (timeout sweep), B-6
  (UI) all consume `dispatched_at` / `working`.
- **Race:** the B-5 sweep and a fresh dispatch could interleave; since both are single-column
  writes on the same handle and the sweep only nulls rows older than 20 min, a just-set
  `dispatched_at` is never in scope for the sweep.
