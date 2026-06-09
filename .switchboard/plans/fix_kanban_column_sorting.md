# Fix Kanban Column Sorting

## Goal
Fix non-planning Kanban columns to display cards in descending last-activity order (most recently updated first), aligning the client-side sort with the database's `ORDER BY updated_at DESC` query.

## Problem
Kanban cards in the CODE REVIEWED column (and other non-planning columns) are displayed in random order rather than descending time order (most recently updated first).

## Root Cause
The database query correctly orders by `updated_at DESC`, but the webview's client-side sorting in `kanban.html` overrides this for non-planning columns.

In `src/webview/kanban.html` (lines 3761-3772), the sorting logic for non-planning columns is:

```javascript
const sortedItems = isPlanningColumn
    ? sortColumnByDependencies(items)
    : [...items].sort((a, b) => {
        const createdA = a.createdAt ? new Date(a.createdAt).getTime() : 0;
        const createdB = b.createdAt ? new Date(b.createdAt).getTime() : 0;
        if (isNaN(createdA) || isNaN(createdB)) {
            return (b._ts || 0) - (a._ts || 0);
        }
        if (createdA !== createdB) return createdA - createdB;  // ← Problem: ascending
        return (b._ts || 0) - (a._ts || 0);
    });
```

The code sorts primarily by `createdAt` ascending (oldest first), with `lastActivity` (`_ts`) as a secondary tiebreaker. This contradicts the database's `ORDER BY updated_at DESC` ordering.

## Metadata
- **Tags:** [frontend, bugfix, UI]
- **Complexity:** 2

## User Review Required
- Confirm that "most recently updated first" is the desired sort order for all non-planning columns (CODE REVIEWED, ACCEPTANCE TESTED, COMPLETED, etc.)

## Complexity Audit

### Routine
- Single-line sort expression change in `kanban.html`
- `_ts` is already pre-computed at line 3726 with `isNaN` guard baked in
- Collapsed coder column (line 3739) already uses the same `b._ts - a._ts` pattern — this fix aligns with existing precedent

### Complex / Risky
- None

## Edge-Case & Dependency Audit

- **Race Conditions:** None. Sort is synchronous and runs per render cycle.
- **Security:** No security implications.
- **Side Effects:** Cards with `_ts = 0` (missing/invalid `lastActivity`) will sort to the bottom. A secondary tiebreaker on `createdAt` descending ensures deterministic order even for these edge cases.
- **Dependencies & Conflicts:** None. This is a pure client-side display change with no API or DB impact.

## Dependencies
None

## Adversarial Synthesis
Key risks: cards with missing `lastActivity` (`_ts = 0`) lose deterministic sort order without a secondary tiebreaker; the fix silently changes behavior for any column currently relying on `createdAt` ascending. Mitigations: add `createdAt` descending as a secondary sort key; `_ts` is already NaN-safe from line 3726; the collapsed coder column already uses this exact pattern, confirming it works in production.

## Solution
Change the sorting logic for non-planning columns to sort by `_ts` (lastActivity) descending as the primary key, with `createdAt` descending as a secondary tiebreaker for cards with no activity timestamp:

```javascript
const sortedItems = isPlanningColumn
    ? sortColumnByDependencies(items)
    : [...items].sort((a, b) => {
        const tsDiff = (b._ts || 0) - (a._ts || 0);
        if (tsDiff !== 0) return tsDiff;
        // Secondary tiebreaker: createdAt descending (for cards with no lastActivity)
        const createdA = a.createdAt ? new Date(a.createdAt).getTime() : 0;
        const createdB = b.createdAt ? new Date(b.createdAt).getTime() : 0;
        return createdB - createdA;
    });
```

This aligns with:
- The DB query: `ORDER BY updated_at DESC` in `KanbanDatabase.ts` (lines 1878, 1908, etc.)
- The provider mapping: `lastActivity: row.updatedAt || row.createdAt || ''` in `KanbanProvider.ts` (lines 992, 1007, 1719, 1738, 1851, 1866)
- The `_ts` computation: `card._ts = isNaN(t) ? 0 : t` in `kanban.html` (line 3726)
- The collapsed coder column sort: `coderItems.sort((a, b) => b._ts - a._ts)` in `kanban.html` (line 3739)

## Proposed Changes

### `src/webview/kanban.html`
- **Context:** `renderBoard` function, lines 3761-3772. Non-planning column sort comparator.
- **Logic:** Replace `createdAt` ascending primary sort with `_ts` descending primary sort. Add `createdAt` descending as secondary tiebreaker.
- **Implementation:** Replace lines 3763-3772 with the new comparator shown above.
- **Edge Cases:** Cards where `lastActivity` is empty/invalid → `_ts = 0` → falls through to `createdAt` descending tiebreaker. `createdAt` parsing failures → `0` → deterministic bottom position.

## Verification Plan

### Automated Tests
- No existing automated tests cover the webview sort logic. Consider adding a unit test for the sort comparator if the sort logic is extracted to a testable function.

### Manual Verification
1. Cards in CODE REVIEWED column appear in descending order by lastActivity timestamp
2. Cards in other non-planning columns (ACCEPTANCE TESTED, COMPLETED) also display correctly
3. Planning columns (CREATED, PLAN REVIEWED) still use dependency sorting as before
4. Cards with no lastActivity still appear in a deterministic order (by createdAt descending)
5. Collapsed coder column behavior is unchanged (already uses `_ts` descending)

## Recommendation
**Send to Intern** — Complexity 2: single-file, localized change with clear existing pattern to follow.

---

## Review Pass (Grumpy + Balanced)

### Stage 1: Grumpy Principal Engineer Findings

1. **MAJOR** — Test file `src/test/kanban-sorting-timestamp-regression.test.js` (lines 10-24) used divergent NaN handling from production code. The test used `if (isNaN(createdA) || isNaN(createdB)) { return 0; }` which treats both cards as equal when either date is NaN, while production individually resets NaN values to 0 and continues comparison. Case 3 only asserted length, not ordering, so the divergence went undetected. This test would not catch a regression in NaN handling.

2. **MAJOR** — Plan's proposed code (lines 63-73) lacks NaN guards for `createdAt`. If `createdAt` is a truthy but unparseable string, `new Date(str).getTime()` returns `NaN`, and `createdB - NaN` = `NaN`, causing implementation-dependent sort behavior across JS engines. The actual implementation correctly added `isNaN` guards — an improvement over the plan — but the plan file was inaccurate.

3. **NIT** — Redundant `|| 0` on pre-computed `_ts` at kanban.html line 3772. `_ts` is guaranteed to be a number by line 3734's `isNaN(t) ? 0 : t`. The collapsed coder column at line 3747 omits this guard. Harmless but inconsistent.

4. **NIT** — No tertiary tiebreaker on `planId`/`sessionId`. Consistent with main DB `getBoard` query which also lacks one. Extremely unlikely edge case.

5. **NIT** — `countEl.textContent = items.length` at line 3781 uses unsorted array reference. Functionally identical since sorting doesn't change length.

### Stage 2: Balanced Synthesis

- **Fix now (MAJOR):** Updated `kanban-sorting-timestamp-regression.test.js` to match production NaN handling and strengthened Case 3 assertion
- **Fix now (MAJOR):** Noted plan's proposed code section is now inaccurate vs implementation (implementation is correct, plan was under-specified)
- **Defer (NIT):** Redundant `|| 0` — harmless defensive coding
- **Defer (NIT):** No tertiary tiebreaker — consistent with DB, extremely unlikely
- **Defer (NIT):** `items.length` vs `sortedItems.length` — functionally identical

### Stage 3: Code Fixes Applied

1. **`src/test/kanban-sorting-timestamp-regression.test.js`** — Updated `sortNonPlanningCards` function to match production NaN handling (individual `isNaN` guards with `let` reassignment instead of early `return 0`). Strengthened Case 3 to assert ordering: valid `createdAt` should sort above invalid (NaN→0).

### Stage 4: Verification Results

- `kanban-sorting-timestamp-regression.test.js`: passed ✅ (post-fix)
- Production sort logic verified: primary `_ts` descending, secondary `createdAt` descending, NaN-safe
- Grep confirmed no remnants of old ascending sort logic

### Stage 5: Remaining Risks

- No tertiary tiebreaker exists for cards with identical `_ts` AND `createdAt` — consistent with DB but technically non-deterministic in that edge case
- The plan's proposed code section (lines 63-73) is now under-specified vs the actual implementation (missing NaN guards) — future readers should reference the actual production code
