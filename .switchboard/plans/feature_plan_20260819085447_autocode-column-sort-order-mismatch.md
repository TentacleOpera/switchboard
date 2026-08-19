# Fix Autocode Column Sort Order — Missing createdAt Tiebreaker

## Goal

The synthetic AUTOCODE column (the collapsed view that merges LEAD CODED, CODER CODED, and INTERN CODED) displays cards from oldest to newest, while every other column displays newest to oldest. The AUTOCODE column must match the other columns' newest-first ordering.

### Problem Analysis

The Kanban board renders cards in two paths:

1. **Normal columns** (CREATED, PLAN REVIEWED, CODE REVIEWED, etc.) — rendered at `kanban.html` line 7959 inside `columns.forEach`. The sort comparator (lines 7977–7996) uses a **two-tier** sort:
   - Primary: `(b._ts || 0) - (a._ts || 0)` — `lastActivity` descending (newest first)
   - Secondary: `createdB - createdA` — `createdAt` descending (newest first by creation time)

2. **AUTOCODE column** (synthetic CODED_AUTO) — rendered at `kanban.html` line 7937 inside `if (collapseCodersEnabled)`. The sort comparator (line 7944) uses a **single-tier** sort:
   - `b._ts - a._ts` — `lastActivity` descending only
   - **No secondary tiebreaker by `createdAt`**

### Root Cause

When `_ts` values are equal — which happens when:
- Multiple cards are moved to coder columns within the same second (batch dispatch)
- `lastActivity` (`updatedAt`) is missing or unparseable, flooring `_ts` to 0
- The backend's `ORDER BY updated_at DESC` is a lexicographic TEXT sort that is not chronological for mixed timestamp formats (ISO-8601 vs SQLite `YYYY-MM-DD HH:MM:SS`)

—the normal columns fall back to `createdAt` descending (newest first), but the AUTOCODE column has no fallback. JavaScript's `Array.sort` is stable in modern V8, so the AUTOCODE column preserves insertion order: LEAD CODED bucket items first, then CODER CODED, then INTERN CODED, each in backend response order. This insertion order can present as oldest-to-newest, producing the mismatch the user observes.

The terminals.js kanban pane (`compareCardsByRecency`, line 5440) already has the correct two-tier sort, confirming the intended behavior.

## Metadata

**Complexity:** 3
**Tags:** bugfix, ui, frontend
**Project:** Browser Switchboard

## User Review Required

No user review required — the fix replicates an existing sort pattern already present 50 lines below in the same file. The correct behavior is defined by the normal column sort (lines 7988–7995) and by `compareCardsByRecency` in terminals.js (line 5440). There is no design decision to confirm.

## Complexity Audit

### Routine
- Single sort comparator change in `kanban.html` line 7944 — adding the same `createdAt` descending secondary tiebreaker that the normal column sort already uses (lines 7988–7995).
- The pattern to replicate is 6 lines of code that already exists 50 lines below in the same file.
- No new data, no backend changes, no schema migration.

### Complex / Risky
- None

## Edge-Case & Dependency Audit

- **Cards with missing `createdAt`:** The normal column sort handles this with `isNaN(createdA) ? 0 : createdA` flooring. The fix must replicate this guard.
- **Cards with missing `lastActivity` (`_ts = 0`):** Already handled — `_ts` is set to 0 at line 7928. The `|| 0` guard in the primary sort (`(b._ts || 0) - (a._ts || 0)`) is defensive; the current autocode sort (`b._ts - a._ts`) works because `_ts` is always a number (0 or a timestamp). Adding `|| 0` for parity is harmless.
- **Non-collapsed mode:** When `collapseCodersEnabled` is false, individual coder columns render through the normal path (line 7959), which already has the tiebreaker. No change needed there.
- **Queue-ordered columns (PLAN REVIEWED in Dispatch view):** The AUTOCODE column never uses queue ordering, so the `queueOrdered` branch is irrelevant.
- **Terminals.js kanban pane:** Already uses `compareCardsByRecency` with the two-tier sort (line 5440). No change needed.

## Dependencies

None — this is a self-contained frontend sort fix with no dependency on other plans or sessions.

## Adversarial Synthesis

Key risks: none of substance. The fix is a mechanical replication of an existing, verified sort pattern. The `|| 0` defensive guard on `_ts` is redundant (the Edge-Case audit confirms `_ts` is always a number) but harmless and matches the normal column sort for consistency. No contradiction or gap found between the stated goal (newest-first AUTOCODE ordering) and the proposed change.

## Proposed Changes

### `src/webview/kanban.html` — line 7944

Replace the single-tier sort:

```js
// Sort combined coder items by timestamp (newest first)
coderItems.sort((a, b) => b._ts - a._ts);
```

With the two-tier sort matching the normal column path (lines 7988–7995):

```js
// Sort combined coder items by timestamp (newest first), with createdAt
// descending as the secondary tiebreaker — matching the normal column sort
// (lines 7988-7995) so the AUTOCODE column does not fall back to insertion
// order when _ts values are equal.
coderItems.sort((a, b) => {
    const tsDiff = (b._ts || 0) - (a._ts || 0);
    if (tsDiff !== 0) return tsDiff;
    let createdA = a.createdAt ? new Date(a.createdAt).getTime() : 0;
    let createdB = b.createdAt ? new Date(b.createdAt).getTime() : 0;
    if (isNaN(createdA)) createdA = 0;
    if (isNaN(createdB)) createdB = 0;
    return createdB - createdA;
});
```

No other files need changes.

## Verification Plan

1. **Build:** Run `npm run build` (or the project's webpack build) and confirm no errors.
2. **Manual test — newest-first ordering:**
   - Create 3+ plans and move them to different coder columns (LEAD CODED, CODER CODED, INTERN CODED) at slightly different times.
   - Enable the AUTOCODE collapse toggle.
   - Verify the AUTOCODE column shows the most recently moved card at the top, matching the order of other columns.
3. **Manual test — equal-timestamp tiebreaker:**
   - Move 2+ cards to coder columns simultaneously (batch dispatch or rapid sequential moves so `updatedAt` is within the same second).
   - Verify the AUTOCODE column orders them by `createdAt` descending (newest creation first), matching other columns.
4. **Manual test — missing lastActivity:**
   - Verify cards with empty/invalid `lastActivity` still sort by `createdAt` descending in the AUTOCODE column, not by insertion order.
5. **Regression — non-collapsed mode:** Disable the AUTOCODE collapse toggle and verify individual coder columns still sort correctly (unchanged code path).
