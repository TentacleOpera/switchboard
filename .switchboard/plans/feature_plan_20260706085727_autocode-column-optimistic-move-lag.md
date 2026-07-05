# Fix Autocode Column Card Appearance Lag

## Goal

When a card is advanced to the AUTOCODE column (the collapsed view of the three coder columns: LEAD CODED, CODER CODED, INTERN CODED), it takes ~1 second for the card to visually appear in the column. Other columns show the card immediately via optimistic DOM updates. The AUTOCODE column is not as snappy because the optimistic move fails silently when coders are collapsed.

### Problem Analysis & Root Cause

When the "Collapse Coders" feature is enabled, the three coder columns (LEAD CODED, CODER CODED, INTERN CODED) are replaced by a single synthetic column with `id: 'CODED_AUTO'` and `label: 'AUTOCODE'` (see `renderColumns()` at line 4636-4655). This synthetic column exists in the rendered DOM as `col-CODED_AUTO`, but the **logical** column IDs remain `LEAD CODED`, `CODER CODED`, `INTERN CODED` — `CODED_AUTO` is NOT in the `columns` array.

The optimistic move path for the Copy Prompt button (lines 5480-5518) works as follows:
1. It gets the card's current column (e.g., `PLAN REVIEWED`).
2. It calls `getNextColumn(nextColSource)` to find the next column — which returns `LEAD CODED` (the first coder column in the `columns` array).
3. It calls `moveCardsOptimistically([sessionId], column, nextCol)` with `nextCol = 'LEAD CODED'`.

Inside `moveCardsOptimistically` (line 4404-4478):
```javascript
const targetBody = document.getElementById('col-' + targetColumn);
if (!targetBody) return;  // <-- EARLY RETURN: col-LEAD CODED doesn't exist when collapsed!
```

When coders are collapsed, `document.getElementById('col-LEAD CODED')` returns `null` because only `col-CODED_AUTO` exists in the DOM. The function returns immediately without moving the card. The card only appears after the backend processes the move and sends an `updateBoard` message with the new positions, which takes ~1 second round-trip.

The source column resolution already handles this correctly (line 4427):
```javascript
const sourceDomCol = (collapseCodersEnabled && CODED_IDS.includes(actualColumn))
    ? 'CODED_AUTO'
    : actualColumn;
```

But the **target** column is never resolved to `CODED_AUTO` when collapsed. This is the bug.

## Metadata

- **Tags:** bug, kanban-board, optimistic-ui, autocode, collapsed-coders
- **Complexity:** 4

## Complexity Audit

**Complex/Risky.** The optimistic move system has a render-guard (`optimisticMoveUntil`) that suppresses full re-renders during the optimistic window. If the target column resolution is wrong, the card may not appear at all during the guard window, or may appear in the wrong place. The fix must correctly resolve the target DOM column when coders are collapsed, and must also update the in-memory `card.column` to the correct logical column (not `CODED_AUTO`) so the backend round-trip is consistent.

The drag-drop path (`handleDrop` for `CODED_AUTO` at line 5900) already handles this correctly with bespoke logic, but the button-triggered path (`moveCardsOptimistically`) does not.

## Edge-Case & Dependency Audit

- **Collapsed vs expanded coders:** When coders are NOT collapsed, `col-LEAD CODED` exists and the current code works fine. The fix must only redirect to `CODED_AUTO` when `collapseCodersEnabled` is true.
- **`getNextColumn` return value:** Returns the logical column ID (e.g., `LEAD CODED`), not `CODED_AUTO`. The fix must map this to `CODED_AUTO` for DOM purposes while keeping the logical ID for `card.column` updates.
- **Count updates:** The target count element is `count-CODED_AUTO` when collapsed, not `count-LEAD CODED`. The count update logic (line 4457) uses `targetColumn` — this must also resolve to the DOM column.
- **Render guard:** The `optimisticMoveUntil` window (2000ms) suppresses `renderBoard` calls. If the optimistic move succeeds, the card appears immediately and the guard prevents reversion. If it fails (current bug), the card is invisible until the guard expires and a fresh `updateBoard` triggers a render.
- **Feature cards:** Feature cards are excluded from `CODED_AUTO` (line 4505: `&& !c.featureId`). The fix should not affect feature card behavior.
- **Backward moves:** Moving a card backward FROM a coder column also needs the source resolution (already handled) but the target could be a non-coder column — no change needed there.

## Proposed Changes

### `src/webview/kanban.html` — Resolve target column to DOM column in `moveCardsOptimistically` (~line 4404)

Add target column resolution at the top of `moveCardsOptimistically`, mirroring the source resolution pattern:

```javascript
function moveCardsOptimistically(sessionIds, sourceColumn, targetColumn) {
    // When coders are collapsed, the target DOM container is CODED_AUTO, not the
    // individual coder column. Resolve the DOM target while keeping the logical
    // targetColumn for card.column updates.
    const CODED_IDS = ['LEAD CODED', 'CODER CODED', 'INTERN CODED'];
    const domTargetColumn = (collapseCodersEnabled && CODED_IDS.includes(targetColumn))
        ? 'CODED_AUTO'
        : targetColumn;

    const targetBody = document.getElementById('col-' + domTargetColumn);
    if (!targetBody) return;
    // ... rest of function uses domTargetColumn for DOM operations ...
```

Then update all DOM references within the function to use `domTargetColumn` instead of `targetColumn`:

1. **Empty state removal (line 4409):** Already uses `targetBody` — no change needed.
2. **Count increment (line 4457):** Change `count-' + targetColumn` to `count-' + domTargetColumn`:
   ```javascript
   const tgtCount = document.getElementById('count-' + domTargetColumn);
   ```
3. **Card.column update (line 4436):** Keep using `targetColumn` (the logical column) — this is correct:
   ```javascript
   if (cardData) cardData.column = targetColumn;  // logical column, NOT domTargetColumn
   ```

### `src/webview/kanban.html` — Fix Copy Prompt handler target resolution (~line 5499-5507)

The Copy Prompt handler at line 5499 calls `getNextColumn(nextColSource)` which returns a logical column ID. When coders are collapsed and the next column is a coder column, the `moveCardsOptimistically` call will now handle the DOM resolution internally (per the fix above). No change needed here — the fix in `moveCardsOptimistically` is sufficient.

However, the target column highlight (line 5502-5506) also uses `nextCol` directly:
```javascript
const targetBody = document.getElementById('col-' + nextCol);
```
This will also fail when collapsed. Fix it to resolve the DOM column:
```javascript
const CODED_IDS = ['LEAD CODED', 'CODER CODED', 'INTERN CODED'];
const domNextCol = (collapseCodersEnabled && CODED_IDS.includes(nextCol)) ? 'CODED_AUTO' : nextCol;
const targetBody = document.getElementById('col-' + domNextCol);
```

## Verification Plan

1. Enable "Collapse Coders" so the AUTOCODE column is visible.
2. Create a plan in the PLAN REVIEWED column.
3. Click "Copy Prompt" on the card to advance it.
4. Verify the card immediately appears in the AUTOCODE column (no ~1s delay).
5. Verify the AUTOCODE column count increments immediately.
6. Verify the source column count decrements and shows "No plans" if empty.
7. Verify the card stays in the column (no snap-back) during the 2s render-guard window.
8. Disable "Collapse Coders" and repeat — verify cards still move correctly to individual coder columns.
9. Test advancing a card that is already in a coder column (e.g., LEAD CODED → next column) — verify it works both collapsed and expanded.
