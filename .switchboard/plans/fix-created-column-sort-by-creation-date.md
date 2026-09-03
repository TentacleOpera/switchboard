# Fix Created Column Sort — Use createdAt, Not columnEnteredAt/lastActivity

<!-- board-collapse-03 -->
> **RESCOPED 2026-09-04 (Board Collapse 03, decision 16).** Scope narrows to **the comparator only**. Do not add a matching insertion rule: the sibling *Kanban card jumps to middle on copy-prompt advance* extracts the shared comparator and points `moveCardElements` at it, so this plan's ordering change is honoured by optimistic moves automatically. Land the extraction first.


## Goal

The CREATED column ("New") on the Kanban board should sort cards by **creation date** (newest first), so the order is stable and doesn't change when agents edit plan files. Currently it sorts by `columnEnteredAt` DESC (falling back to `lastActivity` when `columnEnteredAt` is NULL), which means any plan file edit that bumps `updated_at` reshuffles the column.

### Problem

When an agent edits a plan file, the file watcher re-imports it, which bumps `updated_at` in the DB. The card's `lastActivity` (mapped from `row.updatedAt`) changes. For cards with a NULL `columnEnteredAt`, the sort falls back to `_ts` (which is `lastActivity`), so the card jumps to the top of the CREATED column. Even for cards with a non-NULL `columnEnteredAt`, the sort is "when did this card enter the CREATED column" — not "when was this plan created" — which is semantically wrong for a column called "New."

### Root Cause

In `src/webview/kanban.html` (lines 8533–8554), the sort comparator is uniform across all columns:

```js
const sortedItems = [...items].sort((a, b) => {
    if (queueOrdered) { /* ... STAGING queue sort ... */ }
    // V61: sort by column_entered_at DESC (most recently moved
    // to column first), then createdAt DESC as tiebreaker.
    const colTsDiff = (b._colTs || 0) - (a._colTs || 0);
    if (colTsDiff !== 0) return colTsDiff;
    // Secondary tiebreaker: createdAt descending
    let createdA = a.createdAt ? new Date(a.createdAt).getTime() : 0;
    let createdB = b.createdAt ? new Date(b.createdAt).getTime() : 0;
    if (isNaN(createdA)) createdA = 0;
    if (isNaN(createdB)) createdB = 0;
    return createdB - createdA;
});
```

`_colTs` is computed at lines 8481–8484:
```js
const colTs = card.columnEnteredAt
    ? new Date(card.columnEnteredAt).getTime()
    : NaN;
card._colTs = isNaN(colTs) ? card._ts : colTs;
```

When `columnEnteredAt` is NULL, `_colTs` falls back to `_ts` (`lastActivity` / `updated_at`). Every plan file re-import bumps `updated_at`, so the card's `_colTs` changes and it jumps position.

The V61 design intent was "most recently moved to column first" for **workflow columns** (Coder, Reviewed, etc.) — that's correct there. But CREATED is semantically different: it's the entry column, and users expect creation order.

## Metadata

**Complexity:** 2
**Tags:** frontend, bugfix, ui
**Project:** Browser Switchboard

## User Review Required

- **BACKLOG sort semantic:** When `showingBacklog` is true, BACKLOG cards render in the `col-CREATED` DOM container, so `isCreatedCol` is true and they also sort by `createdAt` DESC. This treats BACKLOG as an entry column where creation order is the expected sort. If users instead expect recently-parked BACKLOG items at the top (so they remember what they shelved), this needs a separate branch. Proceeding on the assumption that creation-order sort is acceptable for BACKLOG.

## Complexity Audit

### Routine
- Single-file frontend change in `src/webview/kanban.html` — one new branch in an existing sort comparator.
- Follows the existing `queueOrdered` pattern (column-specific branch in the same comparator).
- Test file addition to `src/test/kanban-non-planning-sort.test.js` — new function + test cases mirroring existing test structure.
- No backend changes, no DB schema changes, no new dependencies.

### Complex / Risky
- None

## Edge-Case & Dependency Audit

### Race Conditions
- None. The sort runs synchronously inside `renderBoard`, which is called from a single message handler. No concurrent state mutation.

### Security
- None. No user input involved; sort keys (`createdAt`, `columnEnteredAt`) come from the DB via the extension backend.

### Side Effects
- **BACKLOG cards in CREATED slot:** When `showingBacklog` is true, BACKLOG cards are remapped to `effectiveCol = 'CREATED'` (line 8345) and render in the `col-CREATED` container. `isCreatedCol` is true, so they sort by `createdAt` DESC. See User Review Required for the semantic choice.
- **Other columns unchanged:** `isCreatedCol` is only true when `col === 'CREATED'`. All other columns (PLAN REVIEWED, LEAD CODED, STAGING, etc.) keep the existing V61 `_colTs` DESC sort.

### Dependencies & Conflicts
- None. No new dependencies. No conflicting changes to other files.

## Dependencies

None — standalone bugfix.

## Adversarial Synthesis

Key risks: (1) wrong line numbers in the original plan would have misled the implementer — corrected to actual source locations (8533–8554, 8481–8484, 8532). (2) BACKLOG cards in the CREATED slot inherit the creation-date sort — a semantic choice that should be user-confirmed. (3) The fabricated `showingDispatch` edge case has been replaced with the real mutual-exclusivity reasoning (`queueOrdered` is `col === 'STAGING'`, which can never be `'CREATED'`). Mitigations: line numbers verified against source, BACKLOG choice promoted to User Review Required, edge case corrected.

## Proposed Changes

### src/webview/kanban.html

#### Context

The sort comparator at line 8533 runs for every column inside the `columns.forEach` loop (line 8515). It needs a column-specific branch for CREATED that sorts by `createdAt` DESC instead of `_colTs` DESC. The `queueOrdered` flag is defined at line 8532 as `const queueOrdered = (col === 'STAGING')`.

#### Logic

Add a `const isCreatedCol = (col === 'CREATED')` check before the sort comparator. When true, sort by `createdAt` DESC as the primary key, with `_colTs` DESC as the secondary tiebreaker (so cards that re-entered CREATED more recently sort above same-createdAt peers). When false, the existing V61 logic is unchanged.

```js
const isCreatedCol = (col === 'CREATED');
const sortedItems = [...items].sort((a, b) => {
    if (queueOrdered) {
        const ap = a.queuePosition, bp = b.queuePosition;
        const an = (ap === null || ap === undefined), bn = (bp === null || bp === undefined);
        if (an && !bn) return 1;
        if (!an && bn) return -1;
        if (!an && !bn) {
            const d = ap - bp;
            if (d !== 0) return d;
        }
    }
    if (isCreatedCol) {
        // CREATED sorts by creation date (newest first) — stable across
        // plan file edits that bump updated_at. _colTs is the tiebreaker
        // so cards re-entering CREATED sort above same-createdAt peers.
        let createdA = a.createdAt ? new Date(a.createdAt).getTime() : 0;
        let createdB = b.createdAt ? new Date(b.createdAt).getTime() : 0;
        if (isNaN(createdA)) createdA = 0;
        if (isNaN(createdB)) createdB = 0;
        const createdDiff = createdB - createdA;
        if (createdDiff !== 0) return createdDiff;
        return (b._colTs || 0) - (a._colTs || 0);
    }
    // V61: sort by column_entered_at DESC (most recently moved
    // to column first), then createdAt DESC as tiebreaker.
    const colTsDiff = (b._colTs || 0) - (a._colTs || 0);
    if (colTsDiff !== 0) return colTsDiff;
    let createdA = a.createdAt ? new Date(a.createdAt).getTime() : 0;
    let createdB = b.createdAt ? new Date(b.createdAt).getTime() : 0;
    if (isNaN(createdA)) createdA = 0;
    if (isNaN(createdB)) createdB = 0;
    return createdB - createdA;
});
```

#### Implementation

1. At line 8532 (after `const queueOrdered = (col === 'STAGING');`), add `const isCreatedCol = (col === 'CREATED');`.
2. After the `queueOrdered` block (line 8543, the closing `}` of the `if (queueOrdered)` block), add the `if (isCreatedCol) { ... }` branch that sorts by `createdAt` DESC primary, `_colTs` DESC secondary.
3. The existing V61 comparator body (lines 8544–8553) becomes the fallback path — unchanged.

#### Edge Cases

- **BACKLOG cards in the CREATED slot:** When `showingBacklog` is true, BACKLOG cards render in the `col-CREATED` DOM container (line 8345: `if (showingBacklog && card.column === 'BACKLOG') effectiveCol = 'CREATED'`). The `col` variable is `'CREATED'`, so `isCreatedCol` is true — BACKLOG cards also sort by `createdAt` DESC. See User Review Required for the semantic choice.
- **NULL `createdAt`:** The NaN guard (`isNaN(createdA) ? 0`) sends NULL/invalid createdAt cards to the bottom (0). Deterministic.
- **Two cards with identical `createdAt`:** `_colTs` DESC breaks the tie — a card re-entered CREATED more recently sorts above a peer created at the same time. If `_colTs` is also identical, the sort is stable (JS Array.sort is stable in V8 / Chromium, which powers VS Code webviews).
- **Legacy rows with NULL `columnEnteredAt`:** In the CREATED branch, `_colTs` is only the tiebreaker, not the primary key — so the NULL→`_ts` fallback doesn't affect the primary sort. These cards sort by `createdAt` like everything else.
- **STAGING queue interaction:** `queueOrdered` is `col === 'STAGING'` (line 8532). `isCreatedCol` is `col === 'CREATED'`. A column cannot be both STAGING and CREATED, so the `isCreatedCol` branch is unreachable when `queueOrdered` is true. No conflict.
- **CODED_AUTO sort path:** The collapsed-coder sort at line 8500 uses `_ts` (lastActivity), not `_colTs`, and is a separate code path outside the `columns.forEach` loop. Unaffected by this change.

### src/test/kanban-non-planning-sort.test.js

#### Context

The existing test replicates the V61 sort comparator as `sortNonPlanningColumn`. Add a `sortCreatedColumn` function and test cases for the new CREATED-specific sort.

#### Logic

Add a `sortCreatedColumn` function that sorts by `createdAt` DESC primary, `_colTs` DESC secondary:

```js
function sortCreatedColumn(items) {
    return [...items].sort((a, b) => {
        let createdA = a.createdAt ? new Date(a.createdAt).getTime() : 0;
        let createdB = b.createdAt ? new Date(b.createdAt).getTime() : 0;
        if (isNaN(createdA)) createdA = 0;
        if (isNaN(createdB)) createdB = 0;
        const createdDiff = createdB - createdA;
        if (createdDiff !== 0) return createdDiff;
        return (b._colTs || 0) - (a._colTs || 0);
    });
}
```

Add test cases:

1. **Primary sort by createdAt DESC:** Three cards with different createdAt, same _colTs → sorted newest-first by createdAt.
2. **createdAt beats _colTs:** A card with older `_colTs` but newer `createdAt` sorts first — the inverse of the V61 non-CREATED behavior.
3. **Tiebreaker by _colTs DESC:** Two cards with identical createdAt, different _colTs → the one with newer _colTs sorts first.
4. **Stability across lastActivity changes:** Two cards with the same createdAt and _colTs but different lastActivity (_ts) → order unchanged (proves plan edits don't reshuffle).
5. **NULL createdAt falls to bottom:** Card with NULL createdAt sorts below a card with a valid createdAt.

## Verification Plan

### Automated Tests

Run `node src/test/kanban-non-planning-sort.test.js` and `node src/test/kanban-sorting-timestamp-regression.test.js` — both must pass. The new `sortCreatedColumn` test cases must pass. The existing `sortNonPlanningColumn` tests must still pass (unchanged behavior for non-CREATED columns).

### Manual Verification

1. **Created column sorts by creation date:** Create 3 plans at different times. Verify they appear newest-first in the Created column. Order should not change when plans are edited.
2. **Agent edit doesn't reshuffle:** While viewing the Created column, have an agent edit one of the plans. Verify the card does NOT jump position.
3. **Other columns unchanged:** Move cards to Coder/Reviewed columns. Verify those columns still sort by "most recently moved to column" (columnEnteredAt DESC).
4. **Backlog view:** Toggle to Backlog view. Verify Backlog cards in the Created slot also sort by creation date.
5. **Compile check:** Run `npm run compile` and verify no build errors.
