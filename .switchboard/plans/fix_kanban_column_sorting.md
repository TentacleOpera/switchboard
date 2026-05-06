---
sessionId: fix-kanban-column-sorting
topic: Fix Kanban Column Sorting - Remove Dependency Sort from Coder Columns
complexity: low
kanbanColumn: CREATED
---

## Goal

Fix kanban column sorting to only apply dependency-based ordering to planning columns (CREATED, PLAN REVIEWED). Coder columns (LEAD CODED, CODER CODED, INTERN CODED) and the collapsed CODED_AUTO view should sort by timestamp (newest first) to ensure newly moved plans appear at the top.

## Metadata

**Tags:** frontend, bugfix, UI, workflow
**Complexity:** 3

## User Review Required

No

## Complexity Audit

### Routine
- Modify `renderBoard` function in `src/webview/kanban.html` to conditionally apply dependency sorting based on column type
- Fix CODED_AUTO collapsed view to sort combined coder items by timestamp (newest first)
- Verify sorting behavior for all column types after the change

### Complex / Risky
- Handling missing or invalid `lastActivity` timestamps in the sort comparator to avoid `NaN` comparisons producing unstable sort order per ECMAScript spec

## Edge-Case & Dependency Audit

**Race Conditions:** None - this is a frontend rendering change.

**Security:** None - no security implications.

**Side Effects:** Plans in coder columns will now appear in timestamp order (newest first) instead of dependency order, which is the correct behavior for active work columns.

**Dependencies & Conflicts:** Kanban dependency query could not be executed. Potential conflicts with other plans modifying `src/webview/kanban.html` cannot be ruled out. Review `.switchboard/plans/` for concurrent kanban-related plans before coding.

## Dependencies

None (kanban query failed — uncertainty noted in Edge-Case & Dependency Audit above)

## Adversarial Synthesis

Key risks: Invalid `lastActivity` strings produce `NaN` in naive timestamp subtraction, causing unstable sort order. Mitigations: Add a defensive `getTime` helper that returns `0` for invalid dates.

## Proposed Changes

### src/webview/kanban.html

**Context:** The `renderBoard` function currently applies `sortColumnByDependencies` to all columns (line 3482). This causes newly moved plans in coder columns to appear at the bottom instead of the top. Additionally, the collapsed CODED_AUTO view combines coder column items in column order (LEAD → CODER → INTERN) without re-sorting by timestamp.

**Implementation:**

1. **Fix individual column sorting (around line 3482):**
   Change from:
   ```javascript
   const sortedItems = sortColumnByDependencies(items);
   ```
   To:
   ```javascript
   // Only apply dependency sorting to planning columns
   const PLANNING_COLUMNS = ['CREATED', 'PLAN REVIEWED'];
   const isPlanningColumn = PLANNING_COLUMNS.includes(col);
   const sortedItems = isPlanningColumn
       ? sortColumnByDependencies(items)
       : items.sort((a, b) => {
             const ta = new Date(a.lastActivity).getTime();
             const tb = new Date(b.lastActivity).getTime();
             const va = isNaN(ta) ? 0 : ta;
             const vb = isNaN(tb) ? 0 : tb;
             return vb - va; // newest first
         });
   ```

2. **Fix CODED_AUTO collapsed view sorting (around line 3464):**
   Change from:
   ```javascript
   const sortedCoderItems = sortColumnByDependencies(coderItems);
   ```
   To:
   ```javascript
   // Sort combined coder items by timestamp (newest first)
   const getTs = (item) => {
       const t = new Date(item.lastActivity).getTime();
       return isNaN(t) ? 0 : t;
   };
   coderItems.sort((a, b) => getTs(b) - getTs(a));
   const sortedCoderItems = coderItems;
   ```

**Clarification:** The original plan referenced `'BACKLOG'` as a planning column, but BACKLOG is not a rendered kanban column — it is a card column value that gets remapped to display inside CREATED via the `_effectiveColumn` mechanism (lines 3440-3448 in `kanban.html`). Dependency sorting for CREATED therefore covers BACKLOG cards. `INTERN CODED` is a real column defined in `src/services/agentConfig.ts` line 56 and sent to the frontend via `updateColumns`; the hardcoded fallback at `kanban.html:2584-2600` is stale and gets overwritten on startup.

**Edge Cases:**
- Empty columns should handle gracefully (current code already does this)
- Plans with missing or invalid `lastActivity` timestamps sort to the bottom (defensive `isNaN` check in comparator enforces this)
- Two plans with identical `lastActivity` values will maintain their relative order (stable sort in modern JS engines)

## Verification Plan

### Automated Tests
- Unit test: `sortColumnByDependencies` is only called for planning columns
- Unit test: Coder columns use timestamp sorting
- Unit test: CODED_AUTO collapsed view sorts by timestamp
- Unit test: Missing or invalid `lastActivity` values sort to bottom

### Manual Tests
- Move a plan to LEAD CODED column - verify it appears at the top of that column
- Move a plan to CODER CODED column - verify it appears at the top of that column
- Move a plan to INTERN CODED column - verify it appears at the top of that column
- Collapse coder columns - verify CODED_AUTO shows items sorted by timestamp (newest first)
- Move a plan to CREATED column - verify dependency sorting still works correctly
- Move a plan to PLAN REVIEWED column - verify dependency sorting still works correctly

## Files Expected to Change

```
src/webview/kanban.html
```

## Success Criteria

- Coder columns sort by timestamp (newest first)
- CODED_AUTO collapsed view sorts by timestamp (newest first)
- Planning columns (CREATED, PLAN REVIEWED) still use dependency sorting
- Newly moved plans in coder columns appear at the top of the column

---

**Recommendation:** Send to Coder

## Post-Implementation Review

### Stage 1: Grumpy Principal Engineer Review
Are you intentionally trying to melt the user's CPU with `new Date().getTime()` inside a `.sort()` comparator? You're parsing the same ISO string `O(N log N)` times! And you did it *twice* — once for `coderItems` and once for `items.sort()`. That's not just slow, it's sloppy.
Also, mixing immutable and mutable patterns? `sortColumnByDependencies(items)` returns a new array, but `items.sort()` mutates `items` in-place. If someone relies on `items` remaining unsorted after this block, they are in for a nasty surprise.
Finally, why copy-paste the timestamp fallback logic? DRY it out! Cache the timestamp on the card objects before you even bucket them, so you parse it exactly once per card, not log(N) times per comparison.
**Findings:**
- [CRITICAL] `new Date()` instantiation inside `Array.prototype.sort()` comparator causes O(N log N) date string parsing, which is a significant performance bottleneck.
- [MAJOR] Mixed immutability patterns: `sortColumnByDependencies` is pure, but `items.sort()` mutates the source array.
- [NIT] Duplicated sorting logic for timestamp comparison.

### Stage 2: Balanced Synthesis
The logic to shift away from dependency sorting for non-planning columns is fundamentally sound and correctly targets the problem. However, the implementation has performance and structural flaws that need addressing before merging.

**Actionable Fixes:**
1. Loop over `displayCards` once at the start (or when bucketing) and attach a `_ts` property representing the parsed, safe timestamp.
2. Update the `coderItems.sort` and `items.sort` to simply compare `b._ts - a._ts`.
3. Use `[...items].sort(...)` to prevent mutating the original `buckets[col]` array, keeping it consistent with the pure `sortColumnByDependencies` behavior.

### Verification Results
- Changes successfully applied to `src/webview/kanban.html`.
- `_ts` cache logic implemented inside the card bucketing iteration.
- Comparators updated to use the cached timestamp logic.
- Array copy operator `[...items]` utilized to prevent bucket array mutation.
- Verified valid JavaScript syntax. `npx tsc --noEmit` showed 2 existing TS errors unrelated to this JavaScript logic (`src/services/ClickUpSyncService.ts` and `src/services/KanbanProvider.ts`).

### Files Changed
- `src/webview/kanban.html`

### Remaining Risks
- Relying on `_ts` as an undocumented local cache on the card dictionary is standard but assumes cards are not deeply cloned elsewhere right before sorting. Since the cache is injected locally, the risk is minimal.