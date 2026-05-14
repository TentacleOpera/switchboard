# Fix: CODE REVIEWED Column Lost Timestamp-Based Ordering

## Goal
Restore timestamp-based ordering in non-planning Kanban columns so plans appear sorted by most-recent activity (`lastActivity` / `_ts`) rather than creation date (`createdAt`).

## Metadata
- **Tags:** bugfix, UI
- **Complexity:** 1

## Problem
The `CODE REVIEWED` column in the Kanban board has lost its timestamp-based ordering. Plans no longer appear sorted by most-recent activity.

## Root Cause
In `src/webview/kanban.html` (lines 3808–3817), the sort comparator for non-planning columns prioritizes `createdAt` as the **primary** sort key (ascending), with `_ts` (which holds `lastActivity`) only used as a tiebreaker:

```javascript
if (createdA !== createdB) return createdA - createdB;   // ascending — OLDEST first
return (b._ts || 0) - (a._ts || 0);                        // descending — only if same createdAt
```

`createdAt` is the plan creation date and rarely identical across plans. This means a plan created 3 days ago always appears before one created yesterday, even if yesterday's plan was reviewed 5 minutes ago while the older plan was reviewed last week. The `_ts` sort is effectively overridden.

## Impact
- `CODE REVIEWED` (and all other non-planning columns: `LEAD CODED`, `CODER CODED`, `INTERN CODED`, `ACCEPTANCE TESTED`, `COMPLETED`) display plans in creation-date order instead of activity order.
- Users cannot see which plans were most recently reviewed at a glance.

## User Review Required
No. This is a straightforward display-order bugfix with no product behavior changes.

## Complexity Audit
### Routine
- Single-file comparator swap in `kanban.html:3808–3817`.
- Reuses existing `_ts` and `createdAt` fields already present on card objects.
- No new architectural patterns, no data mutations, no pipeline changes.
- The `CODED_AUTO` batch already sorts by `_ts` (line 3784), confirming this pattern is established in the same file.

### Complex / Risky
- None

## Edge-Case & Dependency Audit
- **Race Conditions:** None. This is a pure frontend display change; no asynchronous state mutation.
- **Security:** None. No input handling or trust-boundary changes.
- **Side Effects:** Card order in non-planning columns will change to reflect actual recent activity. This is the intended fix. `CREATED` and `PLAN REVIEWED` columns remain unchanged because they use `sortColumnByDependencies`.
- **Dependencies & Conflicts:** None. Isolated sorting logic. No shared state with other comparators.

## Dependencies
None.

## Adversarial Synthesis
Key risks: Plans with missing or unparseable `lastActivity` receive `_ts = 0` and sink to the bottom; however, `lastActivity` is populated at creation and updated on every column move, so this only affects pre-migration or corrupted plans. The `isNaN` tiebreaker simplification is behaviorally equivalent when `_ts` is equal (returns `0` vs. `_ts` difference of `0`). No pipeline or data-persistence impact. The `CODED_AUTO` synthetic column uses a simpler `_ts`-only sort without `createdAt` tiebreaker, but that is out of scope and semantically appropriate for a merged column.

## Proposed Changes
### `src/webview/kanban.html` (lines 3808–3817)
- **Context:** The non-planning column sort comparator currently sorts by `createdAt` ascending (oldest first) with `_ts` descending as a tiebreaker.
- **Logic:** Swap priority so `_ts` (last activity) is the primary sort key (newest first) and `createdAt` is only a fallback tiebreaker (newest first).
- **Implementation:**

**Change the sort comparator from:**
```javascript
[...items].sort((a, b) => {
    const createdA = a.createdAt ? new Date(a.createdAt).getTime() : 0;
    const createdB = b.createdAt ? new Date(b.createdAt).getTime() : 0;
    if (isNaN(createdA) || isNaN(createdB)) {
        return (b._ts || 0) - (a._ts || 0);
    }
    if (createdA !== createdB) return createdA - createdB;
    return (b._ts || 0) - (a._ts || 0);
});
```

**To:**
```javascript
[...items].sort((a, b) => {
    const tsA = a._ts || 0;
    const tsB = b._ts || 0;
    if (tsA !== tsB) {
        return tsB - tsA; // newest activity first
    }
    const createdA = a.createdAt ? new Date(a.createdAt).getTime() : 0;
    const createdB = b.createdAt ? new Date(b.createdAt).getTime() : 0;
    if (isNaN(createdA) || isNaN(createdB)) {
        return 0;
    }
    return createdB - createdA; // tiebreak: newest plan first
});
```

- **Edge Cases:**
  - Cards with equal `_ts` and valid `createdAt` are tiebroken by newest creation date.
  - Cards with equal `_ts` and malformed `createdAt` preserve array order (`return 0`).
  - Cards with missing `_ts` (`0`) sort below cards with any activity timestamp.

## Verification Plan
### Manual Steps
1. Open the Switchboard Kanban board.
2. Ensure at least two plans exist in `CODE REVIEWED` with different `createdAt` values.
3. Verify the plan with the most recent `lastActivity` (i.e., the one moved to `CODE REVIEWED` most recently) appears at the top of the column, regardless of creation date.
4. Confirm the same behavior holds for `LEAD CODED`, `CODER CODED`, `INTERN CODED`, `ACCEPTANCE TESTED`, and `COMPLETED`.
5. Confirm `CREATED` and `PLAN REVIEWED` still use dependency-based sorting (unchanged).

### Automated Tests
- No automated test currently covers the `kanban.html` inline comparator. Add a regression test in `src/test/` that exercises the comparator logic with mock cards having varying `lastActivity` and `createdAt` values to prevent future regressions. (Clarification: extracting the comparator into a testable function is out of scope for this bugfix; the test should replicate the logic or test at the integration level.)

## Risks
- **Low.** This only reorders the frontend display of non-planning columns. No database writes, no state mutations, no pipeline logic changes. The `createdAt` tiebreaker still provides stable ordering for cards with identical `_ts` values.

## Complexity
1 — single-file, single-block change with no downstream dependencies.

**Recommendation:** Send to Coder.
