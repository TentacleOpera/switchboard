# Plans in the reviewed column are out of order

plans in the reviewed column are not ordered by timestamp, like other columns. they need to be ordered consistently

## Goal
Ensure all kanban columns — including CODE REVIEWED — sort their cards consistently by `lastActivity` timestamp (oldest first, matching the order used by the autoban engine). Currently, cards appear in whatever order the backend returns them with no client-side sorting.

## Source Analysis

**Card rendering** in `src/webview/kanban.html`, `renderBoard()` (lines 717–740):
```js
function renderBoard(cards) {
    currentCards = cards;
    const buckets = {};
    columns.forEach(c => buckets[c] = []);
    cards.forEach(card => {
        const col = columns.includes(card.column) ? card.column : 'CREATED';
        buckets[col].push(card);
    });
    columns.forEach(col => {
        const container = document.getElementById('col-' + col);
        const items = buckets[col];
        container.innerHTML = items.map(card => createCardHtml(card)).join('');
    });
}
```
**No sorting** is applied to `items` before rendering. Cards appear in the order they arrive from the backend.

**Backend card order** in `src/services/KanbanProvider.ts`, `_refreshBoard()` (lines 257–343):
- Cards are built from `legacySnapshot` (sheets processed via `Promise.all`), then optionally overridden by DB rows.
- Neither path sorts the cards before sending to the webview.
- The `KanbanDatabase.getBoard()` query doesn't include an `ORDER BY` clause — it returns rows in insertion order.

**Autoban engine sorting** in `src/services/TaskViewerProvider.ts` (line 1300):
```js
cardsInColumn.sort((a, b) => (a.lastActivity || '').localeCompare(b.lastActivity || ''));
```
The autoban engine sorts oldest-first for dispatch priority. The UI should match this ordering for consistency.

**Card data includes** `lastActivity` field (ISO timestamp string) — already available in every `KanbanCard` object sent to the webview.

## Proposed Changes

### Step 1: Add client-side sorting in renderBoard() (Routine)
**File:** `src/webview/kanban.html` (line ~731, inside `renderBoard()`)
- After bucketing cards, sort each bucket by `lastActivity` (oldest first):
  ```js
  columns.forEach(col => {
      const items = buckets[col];
      items.sort((a, b) => (a.lastActivity || '').localeCompare(b.lastActivity || ''));
      // ... render
  });
  ```
- This is a 1-line addition inside the existing `columns.forEach` loop.

### Step 2 (Optional): Add ORDER BY to DB query (Routine)
**File:** `src/services/KanbanDatabase.ts`
- In `getBoard()` query, add `ORDER BY updated_at ASC` to ensure consistent DB-level ordering.
- This is belt-and-suspenders — the client-side sort is sufficient, but consistent DB ordering prevents subtle bugs.

## Dependencies
- **Plan 4 (separate coder/lead columns):** Adds columns but doesn't affect sorting logic. No conflict.
- No blocking dependencies.

## Verification Plan
1. Open kanban board with multiple cards in CODE REVIEWED column.
2. Confirm cards are ordered oldest-first (earliest `lastActivity` at top).
3. Move a card into CODE REVIEWED → confirm it appears at the correct position based on its timestamp.
4. Verify all other columns are also sorted consistently.
5. Run `npm run compile`.

## Complexity Audit

### Band A (Routine)
- 1-line sort in `renderBoard()`.
- Optional: 1-line `ORDER BY` in DB query.

### Band B — Complex / Risky
- None.


## Adversarial Review

### Grumpy Critique
- "Why sort client-side when the backend could send pre-sorted data?" → Both is ideal. Client-side sort is a fast fix; backend sort prevents the issue for any future consumers.
- "What about newly dropped cards? They get optimistic UI placement, then on next refresh they'll jump to their sorted position." → Acceptable. The optimistic placement is temporary (subsecond), and the refresh re-sorts correctly.
- "Is oldest-first the right order for all columns? Maybe the user wants newest-first for CODE REVIEWED to see recently reviewed plans." → The user asked for consistency with "other columns." Oldest-first matches autoban dispatch priority. If the user wants configurable sort, that's a follow-up.

### Balanced Synthesis
- The 1-line client-side sort is the right fix. Minimal, correct, and consistent with autoban ordering.
- Add the DB `ORDER BY` as well for robustness.
- No need for configurable sort direction in this plan — oldest-first is the consistent standard.

## Agent Recommendation
Send it to the **Coder agent** — this is a 1-2 line fix. Trivially routine.
