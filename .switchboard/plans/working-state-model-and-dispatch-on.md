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
   - Extend `updateDispatchInfoByPlanFile` (`KanbanDatabase.ts:6929`; the UPDATE SQL is at
     line 6936) to also set `dispatched_at = ?` (ISO string) in its UPDATE. Note
     `_recordDispatchIdentity` actually calls the deprecated `updateDispatchInfo` wrapper
     (`KanbanDatabase.ts:6942`) which looks up the plan by sessionId and funnels into
     `updateDispatchInfoByPlanFile` — so editing the latter covers both call shapes.
   - Set it centrally in `KanbanProvider._recordDispatchIdentity` (`KanbanProvider.ts:2723`)
     so **all** dispatch entry points inherit it uniformly (the `_recordDispatchIdentity`
     call sites are at `KanbanProvider.ts:6606, 6637, 7137, 7149`; terminal paths in
     `TaskViewerProvider.ts:3253/3680/14623/16723`). Per the historical note in
     `move_kanban_cards_immediately_before_terminal_dispatch.md`, dispatch responsibility is
     split between `TaskViewerProvider` and `KanbanProvider` depending on
     `explicitTargetColumn` — centralizing the write in `_recordDispatchIdentity` avoids
     missing a path. Confirm every entry point actually reaches `_recordDispatchIdentity`;
     if any bypasses it, set `dispatched_at` there too.

3. **Card payload + re-render signature.**
   - Add `working?: boolean` to the `KanbanCard` interface (`KanbanProvider.ts:106-120`).
   - Compute `working` when building card objects from rows. There are **three** card-build
     sites that must all set it (verified): the primary board builder at
     `KanbanProvider.ts:1368-1384` (active) and `1386-1400` (completed); and the two
     parallel builders at `~2929-2940` (active) + `~2952-2958` (completed) and
     `~3102-3109` (active) + `~3117-3123` (completed). Guard: never `working` for
     `status !== 'active'` or `kanban_column === 'COMPLETED'`. A build site that is missed
     yields a board path where the light never appears.
   - Add `working` to the board-diff signature string in `buildBoardSignature`
     (`kanban.html:4604-4609`, the `.map(...)` at line 4607) — append
     `|${card.working ? '1' : '0'}` to the per-card signature. It currently includes
     `lastActivity` but no working flag, so **without this the light will not re-render on
     state change.** (createCardHtml rendering itself is subtask B-6.)

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

## Dependencies

- None upstream — this is the foundation subtask (B-1) of the *Agent activity light* feature.
- Downstream (intra-feature): `stage-complete-marker-clears-working-state.md` (B-2) consumes
  `dispatched_at` + a new `clearWorkingState` method; `working-state-timeout-sweep.md` (B-5)
  consumes `dispatched_at` + adds `clearStaleWorkingState`; `card-working-light-ui.md` (UI)
  consumes the `working` flag + the re-render signature change added here.

## Proposed Changes

A per-file change manifest (merge-surface map). Detailed steps live in **## Implementation** above.

### src/services/KanbanDatabase.ts
- **Context:** owns the `plans` schema, migrations, and the dispatch UPDATE.
- **Logic:** add `dispatched_at TEXT DEFAULT NULL` to the `plans` DDL (~line 140, beside the
  other dispatch columns) and to `KanbanPlanRecord` (lines 36-66); add an idempotent
  `ALTER TABLE plans ADD COLUMN dispatched_at ...` migration block mirroring `MIGRATION_V7_SQL`
  (lines 243-247); add `dispatched_at` to `PLAN_COLUMNS` / `_readRows()` so rows carry it;
  extend the UPDATE in `updateDispatchInfoByPlanFile` (line 6936) with `dispatched_at = ?`.
- **Edge cases:** NULL default = not working (correct for ~4,000 legacy installs, no backfill);
  re-dispatch overwrites the timestamp (resets the 20-min clock); the deprecated
  `updateDispatchInfo` wrapper (6942) funnels through this method so both paths are covered.

### src/services/KanbanProvider.ts
- **Context:** builds `KanbanCard` objects and records dispatch identity centrally.
- **Logic:** add `working?: boolean` to `KanbanCard` (106-120); compute `working` at all three
  card-build sites (1368-1384/1386-1400, ~2929-2958, ~3102-3123) with the active/completed
  guard; `dispatched_at` is set via `updateDispatchInfoByPlanFile` reached through
  `_recordDispatchIdentity` (2723) — no extra call-site edits needed once the DB method writes
  the column.
- **Edge cases:** `_recordDispatchIdentity` returns early at line 2740 for columns outside
  `roleFromColumn` (custom columns, BACKLOG) — dispatches to those columns will NOT light up;
  confirm whether that is desired or whether the early-return should be relaxed for the light.

### src/webview/kanban.html
- **Context:** `buildBoardSignature` drives the board's change-detection diff.
- **Logic:** append `|${card.working ? '1' : '0'}` to the per-card signature in
  `buildBoardSignature` (line 4607).
- **Edge cases:** without this, the light renders once and never updates (works-in-DB,
  invisible-in-UI). Rendering of the dot itself is the UI subtask.

## Adversarial Synthesis

Key risks: (1) three card-build sites must each set `working` — missing one yields a board
path with a permanently absent light; (2) `_recordDispatchIdentity` early-returns for
untracked columns, so custom-column/BACKLOG dispatches silently never light; (3) the
re-render signature at `kanban.html:4607` is the single point that makes the light live-update
— omit it and the feature is invisible. Mitigations: enumerate all three build sites in the
PR diff; decide explicitly whether untracked columns should light; add `working` to the
signature in the same commit as the backend flag.

## Verification Plan

> Per session directives: no automated tests, no compilation. Verify via the installed VSIX
> (per CLAUDE.md, `dist/` is not used in dev — `src/` is the source of truth).

### Manual checks
- After migrating on an existing workspace, confirm `dispatched_at` column exists
  (`sqlite3` on `kanban.db` `.schema plans`) and all existing rows are NULL (no light on
  pre-existing cards).
- Dispatch a card in a tracked column (e.g. PLAN REVIEWED / CODER CODED) → confirm the light
  turns ON within one refresh.
- Confirm the light does NOT appear for cards in BACKLOG / custom columns (matches the
  `_recordDispatchIdentity` early-return) — or, if the decision is to light them, confirm it
  does.
- Confirm completed/inactive cards never show the light.
- Re-dispatch an already-working card → confirm the light stays on and the 20-min clock
  resets (visually: stays on past the prior window).

### Recommendation
Complexity 5 → **Send to Coder.**
