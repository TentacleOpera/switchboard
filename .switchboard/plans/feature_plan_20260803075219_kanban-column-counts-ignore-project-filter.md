# Kanban Column Plan Counts Ignore Project Filter

## Goal

When a project filter is active on the Switchboard kanban board, the plan count badges at the top of each column display cumulative counts across ALL projects instead of reflecting only the filtered project's plans. For example, creating a new project with 0 plans still shows the full cumulative count in every column.

### Root Cause

`computeColumnOccupancy` (kanban.html:6209) receives the **unfiltered** `allCards` cache from both of its call sites:

- `renderBoard` at line 6326: `computeColumnOccupancy(allCards.length ? allCards : cards)`
- `refreshColumnCounts` at line 6234: `computeColumnOccupancy(allCards.length ? allCards : currentCards)`

The function itself does NOT apply `boardProjectFilter` — it only filters out backlog/created cards and subtasks. The comments at lines 6205–6208 explicitly state this was intentional ("so columns that hold cards only in other (hidden) projects still show their true counts"), but this design means the count badges never respect the active project filter.

Meanwhile, the actual card DOM IS correctly filtered: `renderBoard` calls `applyBoardProjectFilter(allCards)` at line 7655 to produce the visible `nextCards` set. So there is a mismatch — the cards shown are project-scoped, but the count badges are global.

The fix is to apply `applyBoardProjectFilter` inside `computeColumnOccupancy` so counts match the filtered view when a project filter is active, while preserving the "show all" behavior when no filter is set (`boardProjectFilter === null`).

## Metadata

- **Complexity:** 3
- **Tags:** frontend, bugfix, ui

## Complexity Audit

**Routine.** The fix is a single-function change: add one `applyBoardProjectFilter` call inside `computeColumnOccupancy`. Both call sites already pass `allCards` (the unfiltered cache), and `applyBoardProjectFilter` is a pure filter function that returns the input unchanged when `boardProjectFilter === null`. No new state, no new data flow, no backend changes.

## Edge-Case & Dependency Audit

- **No filter active (`boardProjectFilter === null`):** `applyBoardProjectFilter` returns cards unchanged — behavior identical to current. No regression.
- **`__unassigned__` filter:** `applyBoardProjectFilter` filters to cards with `!c.project` — counts will correctly reflect only unassigned plans.
- **Named project filter:** Counts will reflect only that project's plans. This is the fix.
- **Collapsed coder columns (CODED_AUTO):** The `coderOccupancy` sum at line 6342 is derived from `occupancyCounts`, which comes from `computeColumnOccupancy`. After the fix, this will also respect the project filter. The comment at line 6340 ("Count badge reflects unfiltered occupancy") will need updating.
- **`refreshColumnCounts` (line 6233):** Also calls `computeColumnOccupancy(allCards ...)` — will be fixed by the same change since the filter is applied inside the function.
- **Backlog view toggle:** `computeColumnOccupancy` already handles backlog/created filtering. The project filter is orthogonal and composes correctly.
- **Subtask hiding:** `computeColumnOccupancy` already excludes feature subtasks (`!card.featureId`). Project filter composes with this correctly.

## Proposed Changes

### File: `src/webview/kanban.html`

**Change 1: Apply project filter inside `computeColumnOccupancy` (line ~6213)**

Add `applyBoardProjectFilter` to the card set before counting, right after the backlog/created filter.

Current code at lines 6209–6226:
```js
function computeColumnOccupancy(cards) {
    const counts = {};
    [...columns, ...CODED_IDS].forEach(c => { counts[c] = 0; });
    if (!Array.isArray(cards) || cards.length === 0) return counts;
    let displayCards = cards;
    if (!showingBacklog) {
        displayCards = cards.filter(card => card.column !== 'BACKLOG');
    } else {
        displayCards = cards.filter(card => card.column !== 'CREATED');
    }
    displayCards = displayCards.filter(card => !card.featureId);
    displayCards.forEach(card => {
        const effectiveCol = (showingBacklog && card.column === 'BACKLOG') ? 'CREATED' : card.column;
        const col = columns.includes(effectiveCol) ? effectiveCol : (CODED_IDS.includes(effectiveCol) ? effectiveCol : null);
        if (!col) return;
        counts[col] = (counts[col] || 0) + 1;
    });
    return counts;
}
```

Changed code:
```js
function computeColumnOccupancy(cards) {
    const counts = {};
    [...columns, ...CODED_IDS].forEach(c => { counts[c] = 0; });
    if (!Array.isArray(cards) || cards.length === 0) return counts;
    let displayCards = cards;
    if (!showingBacklog) {
        displayCards = cards.filter(card => card.column !== 'BACKLOG');
    } else {
        displayCards = cards.filter(card => card.column !== 'CREATED');
    }
    displayCards = displayCards.filter(card => !card.featureId);
    displayCards = applyBoardProjectFilter(displayCards);
    displayCards.forEach(card => {
        const effectiveCol = (showingBacklog && card.column === 'BACKLOG') ? 'CREATED' : card.column;
        const col = columns.includes(effectiveCol) ? effectiveCol : (CODED_IDS.includes(effectiveCol) ? effectiveCol : null);
        if (!col) return;
        counts[col] = (counts[col] || 0) + 1;
    });
    return counts;
}
```

The single new line is `displayCards = applyBoardProjectFilter(displayCards);` inserted after the subtask filter and before the counting loop.

**Change 2: Update stale comments (lines 6205–6208 and 6323–6325)**

Update the comment block above `computeColumnOccupancy` at lines 6205–6208:
```js
// Compute per-column occupancy from the allCards cache, applying the active
// project filter so count badges match the visible (filtered) board. When no
// project filter is set (boardProjectFilter === null), counts reflect all cards.
// Applies the same backlog-view + subtask-hiding display rules as renderBoard.
```

Update the comment at lines 6323–6325:
```js
// Column occupancy is computed from the allCards cache with the active project
// filter applied, so count badges match the filtered board. Falls back to the
// passed-in cards before the first updateBoard populates allCards.
```

Update the comment at line 6340:
```js
// Count badge reflects project-filtered occupancy across the three coder columns;
// the DOM renders only the project-filtered subset.
```

Update the comment at lines 6229–6232:
```js
// Lightweight count-only refresh: updates column count badges from the
// allCards cache (with project filter applied) without rebuilding card DOM.
// Used when the filtered board signature is unchanged but allCards changed
// (e.g. a card added to a hidden project) so occupancy counts stay accurate.
```

## Verification Plan

1. **No filter (default):** Open kanban with no project filter. Column counts should show total plans across all projects — same as before the fix.
2. **Named project filter:** Select a project with plans. Column counts should match the number of visible cards in each column.
3. **Empty project:** Create a new project with 0 plans. Select it. All column counts should show 0.
4. **`__unassigned__` filter:** Select "Unassigned" in the project filter. Counts should reflect only plans with no project assignment.
5. **Collapsed coder columns:** Enable coder collapse mode. The CODED_AUTO aggregate count badge should respect the project filter.
6. **Backlog view toggle:** Toggle backlog view on/off with a project filter active. Counts should remain project-filtered in both modes.
7. **Card move:** Move a card between columns with a project filter active. The count badges should update correctly (decrement source, increment target) for the filtered project only.
