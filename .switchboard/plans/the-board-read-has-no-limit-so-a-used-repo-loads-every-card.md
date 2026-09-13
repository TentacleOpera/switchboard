# The Board's Active Read Has No Limit, So a Used Repo Loads Every Card

## Goal

Put a ceiling on the board's active read, and make a truncated board say so. Today
`getBoard()` selects every `status='active'` row with no `LIMIT`, so the number of cards the
host holds in memory is whatever the repository happens to contain. On the 1 GB board-only
configuration that is the difference between a board that opens and one that does not.

### Problem analysis

**The active read is unbounded, and only the completed half was ever capped.**

```sql
SELECT <36 columns> FROM plans
 WHERE workspace_id = ? AND status = 'active'
 ORDER BY updated_at DESC
```

No `LIMIT`. `getBoardFiltered` and `getBoardFilteredByProject` delegate to it for the
unfiltered case. The hot window (`getCompletedPlansInHotWindow`, default
`kanban.hotWindowDays = 45`, floor `minCount = 25`) bounds **completed** rows only — it never
applies to active ones. So the one class of row that has no ceiling is the class a fresh
import creates.

**Measured on this workspace (2026-09-11):** 548 active rows against 2,322 plan files on
disk. The gap is only that small because most of those files have already been walked through
to completion on this board over months. A repository whose plans have *not* been worked here
imports every one of them as active — see the companion plan on first-run import volume.

**The cost is not one SELECT.** Each returned row is materialised by `_readRows` into a
`KanbanPlanRecord` with 36 columns, then the machine-local runtime overlay issues a second
prepared statement built as `plan_id IN (?, ?, …)` across the whole result set, then every
record is projected into a card and pushed to the webview. The active row count multiplies
through all of it. At around 32k rows the overlay would also exceed SQLite's variable limit
and now re-throws rather than degrading.

**Why the window cannot be asked to do this job.** It keys on `updated_at`, which is a
file-touch timestamp rather than an activity one: `upsertPlan` sets
`updated_at = excluded.updated_at`, so the plan-file watcher re-stamps rows on every
working-tree change. Two bulk re-imports on this board (2026-09-05 and 2026-09-09) stamped
2,084 months-old plans as freshly updated. A ceiling that depends on that timestamp is not a
ceiling. That is its own defect and its own card; this plan does not depend on it being fixed,
which is the point — a `LIMIT` holds regardless of what the timestamps say.

### Root cause

The board was built where the row count equalled the work in front of one person, so "every
active row" and "the board" were the same set. Nothing revisited that when a workspace could
carry thousands of plan files, and the retention work that did add a bound added it to the
completed pile — the half that was already terminal — because that is where growth was visible.

### Non-goals

- The storage topology. There is no cold store and none is wanted; this is a `LIMIT` on one
  query, not a second database.
- Retention or deletion. Nothing here removes a row.
- The `updated_at` window key. Named above as the reason the window cannot substitute for a
  limit, owned by its own card.
- Pagination of the webview. The board may render fewer cards than it holds; that is a
  separate question from how many the host loads.

## Metadata

**Complexity:** 4
**Tags:** database, performance, reliability, backend, ux

## User Review Required

None.

## Complexity Audit

### Routine
- The fix is a `LIMIT` + an explicit `ORDER BY` on one query (`getBoard`, `KanbanDatabase.ts:4491`); `_resolveBoard` (LocalApiServer `:9790`) funnels every board-backed read (`/kanban/board`, `/kanban/plans`, `/kanban/features`) through it, so one edit bounds them all.
- Returning a total alongside the page is a count query; the runtime overlay's `IN (…)` parameter list is automatically bounded once the read is capped.

### Complex / Risky
- The `ORDER BY` decides which cards survive the cut; `updated_at` is a file-touch stamp (the watcher re-stamps rows on every working-tree change), so the order must be column-role-first then recency, not recency alone — otherwise a bulk re-import demotes in-progress cards.
- A bounded board that does not say it is bounded is the `200 []` failure in another costume; the "showing N of M" UI surface must be pinned to an exact string/field so a coder does not implement it five ways.
- The ceiling must be chosen against the 1 GB board-only configuration (182 MB idle host), not a developer machine, and stated in the setting's description.

## Edge-Case & Dependency Audit

- **Race Conditions:** a `LIMIT` read is a single SELECT snapshot; no write race is introduced. The total count is approximate by nature (rows may change between the page read and the count) — acceptable for a "showing N of M" indicator.
- **Security:** none.
- **Side Effects:** truncation drops cards from the host's in-memory set; the UI must surface the excluded count so a card that is not shown is not assumed absent.
- **Dependencies & Conflicts:** the `updated_at` window-key defect is owned by its own card (named in the analysis); this plan deliberately does not depend on it being fixed — a `LIMIT` holds regardless of what the timestamps say. The first-run import card (`452a92a1`) keeps the number small at the source; this card keeps it safe when it is not. Both are wanted.

## Dependencies

- Companion to `452a92a1` (first-run import volume): that card keeps the active count small at the source; this card caps the read when it is not. Both are wanted — a `LIMIT` alone leaves a first run importing thousands and showing a permanently truncated board (correct, but useless).
- Independent of the `updated_at` window-key defect (its own card): the `LIMIT` holds regardless of what the timestamps say.

## Adversarial Synthesis

Key risks: a `LIMIT` alone silently drops cards (the `200 []` failure in another costume); an `ORDER BY updated_at` lets a bulk re-import demote in-progress cards. Mitigations: return the total + excluded count and pin the "showing N of M" UI string; order by working-column-first then recency so the cut keeps useful cards; choose the ceiling against 1 GB RSS.

## Proposed Changes

1. **A `LIMIT` on the active read**, with an explicit `ORDER BY` that makes the retained set
   the useful one rather than an arbitrary one — column order then recency, so the cards a
   person is working survive the cut.
2. **Return the total alongside the page.** `getBoard` returns records and a count of what was
   excluded, so a caller can tell a bounded board from a complete one.
3. **Say it in the UI.** A truncated board states "showing N of M". A board that silently drops
   cards is the `200 []` failure in another costume — the same shape this feature's
   empty-body subtask exists to kill.
4. **A ceiling that suits the smallest target.** The default has to be chosen against the 1 GB
   board-only configuration, not against a developer machine, and stated in the setting's
   description.

## Verification Plan

- **Bounded load:** a workspace with 5,000 active rows. Assert the host materialises at most
  the ceiling, and that RSS after a board read is flat against the same measurement at 500 rows.
- **The cut is the useful one:** assert cards in working columns survive truncation ahead of
  cards sitting in `CREATED`.
- **Truncation is visible:** assert the response carries the excluded count and the UI renders
  "showing N of M" — never a silently short board.
- **Parity:** assert both composition roots answer the bounded read identically, since
  `getBoard` is reached from the extension and the standalone host alike.
- **Overlay bound:** assert the runtime overlay's `IN (…)` parameter list cannot exceed
  SQLite's variable limit once the read is capped.

### Goal Invariants

- **No unbounded active read remains:** assert no `status = 'active'` SELECT in
  `KanbanDatabase` lacks a `LIMIT`, as a source-level check that survives refactors.
- **Truncation is reported, never silent:** assert a board at the ceiling returns a total
  distinct from the returned count, and that the count reaches the webview.
- **Independent of the window:** assert the ceiling holds with every row's `updated_at` set to
  now — the state a fresh import produces — so the limit cannot be defeated by timestamps.
