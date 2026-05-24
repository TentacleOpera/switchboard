# Kanban Advance Button Target Column Flash and Optimistic UI

## Goal
Add visual feedback (highlight flash) on the destination column when advance buttons are clicked, and implement optimistic DOM updates so cards move immediately instead of waiting 2+ seconds for backend processing.

## Metadata
- **Tags:** [frontend, UX, UI, performance]
- **Complexity:** 5

## User Review Required
- Confirm the teal highlight animation style matches desired UX
- Confirm whether other button handlers (julesSelected, rePlanSelected, completeSelected, completeAll) should also get optimistic UI
- Confirm whether error handling for failed backend moves is in scope (recommended but could be a separate follow-up)

## Problem
When clicking kanban advance buttons (moveSelected, moveAll, promptSelected):
1. **No visual feedback on destination column** - users can't tell where cards will move until they actually move
2. **2+ second delay before cards move** - cards don't move until backend DB updates, agent dispatch, and `refreshBoard()` complete
3. **Poor UX** - users are unsure what's happening during the delay, with no indication of the target column

## Root Cause Analysis

### Current Advance Button Implementation
- **Location**: `src/webview/kanban.html` lines 3559-3667
- **Current behavior**:
  - Flashes the button itself via `flashIconBtn(btn)` (line 3562)
  - Sends message to backend via `postKanbanMessage()`
  - Removes selection from `selectedCards` set
  - **No optimistic DOM updates** - cards stay in place until backend responds
  - **No target column highlight** - no visual indication of destination

### Backend Processing Flow
- **Location**: `src/services/KanbanProvider.ts`
- **`moveSelected` handler** (line 4856):
  - Updates DB immediately
  - Triggers agent dispatch if applicable
  - Calls `_refreshBoard()` (line 4953) - this reloads entire board state
- **`moveAll` handler** (line 4956):
  - Calls `_refreshBoard()` twice (lines 4961 and end)
- **`promptSelected` handler** (line 5084):
  - Generates prompt
  - Moves cards
  - Calls `_refreshBoard()`

### Why 2+ Second Delay
The delay is the sum of:
1. Backend DB write operations
2. Agent dispatch (if applicable - e.g., triggering coder, reviewer)
3. `_refreshBoard()` - full board state reload from database
4. Webview message round-trip
5. DOM rebuild via `renderBoard()`

### Drag-Drop Has Optimistic UI (Reference Implementation)
- **Location**: `src/webview/kanban.html` line 4429
- **Reference**: "Optimistic DOM move: relocate cards to COMPLETED column with animation"
- Drag-drop immediately moves cards in DOM before backend processing
- This provides instant visual feedback
- Advance buttons should follow the same pattern

## Solution

Add two improvements to advance button handlers:
1. **Target column highlight flash** - add CSS animation and apply to destination column when button clicked
2. **Optimistic DOM updates** - immediately move cards to target column in DOM before backend processing (like drag-drop)

### Implementation Steps

1. **Add CSS animation for column highlight**
   - File: `src/webview/kanban.html` — `<style>` section (after line 585, after `.flash` class)
   - Add `@keyframes columnHighlight` animation: teal background pulse → fade
   - Add `.column-body.highlight` class with the animation

2. **Add helper function for optimistic card movement**
   - File: `src/webview/kanban.html` (after `flashIconBtn` at line 3221)
   - Create `moveCardsOptimistically(sessionIds, sourceColumn, targetColumn)` function
   - Follow pattern from drag-drop handler (lines 4429-4456)
   - Handle: card element relocation, empty-state management, count updates, source column cleanup
   - **Clarification**: Use `currentCards.find(c => c.sessionId === id)?.column` to resolve each card's actual source column (do NOT use `cardEl.dataset.column` — cards have no `data-column` attribute at line 4061). Capture source body via `getElementById` before `appendChild`.

3. **Update advance button handlers**
   - File: `src/webview/kanban.html` lines 3571-3608
   - Apply to `moveSelected`, `moveAll`, `promptSelected`, `promptAll`
   - After `flashIconBtn(btn)` (already called at 3562), add optimistic UI in each case:
     - Determine `domTargetCol`: for CODED_AUTO, `nextCol` from `getNextColumn(backendColumn)` works since `backendColumn` resolves to a real coder column (e.g., `LEAD CODED`), and these columns are present in `columns` when coders are NOT collapsed. When collapsed, `columns` has `CODED_AUTO` not `LEAD CODED`, so `getNextColumn('LEAD CODED')` returns null — optimistic UI is skipped (pre-existing behavior, not a regression)
     - Apply highlight class to target column body
     - Call `moveCardsOptimistically()` to move cards immediately
     - Remove highlight after animation via `animationend` listener

4. **Handle CODED_AUTO collapse mode in `moveCardsOptimistically`**
   - CODED_AUTO is synthetic - when coders are collapsed, cards render inside `col-CODED_AUTO`
   - Resolve actual source column for each card: `currentCards.find(c => c.sessionId === id)?.column`
   - When coders collapsed, actual source column (e.g., `LEAD CODED`) has no visible DOM container — use `col-CODED_AUTO` as source body for empty-state check
   - Decrement `count-CODED_AUTO` (visible count) when actual source is a coder column and coders are collapsed

5. **Test the fix**
   - Verify target column flashes when advance buttons clicked
   - Verify cards move immediately (no 2-second delay)
   - Verify backend still processes correctly (DB updates, agent dispatch)
   - Verify drag-drop still works (no regression)
   - Verify CODED_AUTO collapse mode works correctly

### Files to Modify

- `src/webview/kanban.html`:
  - Add CSS animation for column highlight (in `<style>` section after line 585)
  - Add `moveCardsOptimistically()` helper function (after `flashIconBtn` at line 3221)
  - Update advance button handlers: `moveSelected`, `moveAll`, `promptSelected`, `promptAll`
  - Leave `julesSelected`, `rePlanSelected`, `completeSelected`, `completeAll`, `testingFailed` unchanged (no forward-advance target column)

## Expected Outcome

After this fix:
- Clicking advance buttons shows immediate visual feedback on the destination column (teal highlight flash)
- Cards move immediately in the UI (optimistic DOM update)
- No 2-second delay before cards appear in target column
- Backend processing happens invisibly in background
- UX matches drag-drop behavior (consistent)
- Users can clearly see where cards are going

## Complexity Audit

### Routine
- Adding CSS `@keyframes` and class rules — follows existing patterns (see `@keyframes iconFlash` at line 578)
- `moveCardsOptimistically()` function — reuses drag-drop logic pattern (lines 4429-4456)
- Applying highlight class to target column — simple DOM manipulation
- Removing highlight after animation — standard event listener pattern

### Complex / Risky
- **`data-column` absent on cards**: Cards (line 4061) only carry `data-plan-id`, `data-session`, `data-workspace-root`. Must use `currentCards.find()` for actual column lookup, not `cardEl.dataset.column`.
- **Source body capture order**: Must capture source body via `getElementById` BEFORE `appendChild(cardEl)`. `closest('.column-body')` after `appendChild` will return the *target* body.
- **CODED_AUTO count updates**: When coders collapsed, visible count is `count-CODED_AUTO`. When expanded, individual coder column counts. Must check `collapseCodersEnabled` to decrement correct count.
- **Optimistic UI race conditions**: If backend move fails (e.g., DB error, agent dispatch failure), cards will have moved optimistically but won't be reflected in database. Need error handling to revert optimistic moves on failure.
- **CODED_AUTO + getNextColumn null**: When coders are collapsed, `columns` array has `CODED_AUTO`, not real coder column IDs. `getNextColumn('LEAD CODED')` returns null → optimistic UI skipped. This is pre-existing behavior, acceptable.

## Edge-Case & Dependency Audit

- **Race Conditions**:
  - If backend move fails, optimistic DOM state will be out of sync with DB. Need to add error handling in message handlers to revert optimistic moves on failure.
  - If user clicks advance multiple times rapidly, multiple optimistic moves could conflict. Button should be disabled during processing.
- **CODED_AUTO Collapse Mode**:
  - When coders are collapsed, cards display in CODED_AUTO but are actually in individual coder columns. Advancing from CODED_AUTO needs to move cards from their actual source columns to CODE REVIEWED.
  - Target column highlight should show CODE REVIEWED (the real destination).
- **Empty States**:
  - Moving last card from a column should show "No plans" empty state.
  - Moving to an empty column should remove empty state before appending cards.
- **Count Badges**:
  - Source column count must decrement.
  - Target column count must increment.
  - CODED_AUTO count must update when moving from individual coder columns in collapsed mode.
- **Security**: No security implications — purely UI/UX improvements.
- **Side Effects**: None expected — this adds visual feedback without changing backend logic.
- **Dependencies & Conflicts**:
  - Depends on `getNextColumn()` function (already exists, line 3209)
  - Depends on `postKanbanMessage()` (already exists)
  - Depends on `currentCards` array for actual column lookup per card
  - No new dependencies on backend services.

## Dependencies
None

## Adversarial Synthesis
Key risks: `data-column` is absent from card DOM elements (cards only have `data-session`/`data-plan-id`/`data-workspace-root`), so the CODED_AUTO actual-source-column lookup must use `currentCards.find()` not `cardEl.dataset.column`. Source body must be captured before `appendChild` or `getElementById` used instead. No error revert path is provided — if backend fails, optimistic DOM state diverges silently. Mitigations: use `currentCards` for column resolution, capture source body before move, defer error revert to follow-up plan.

## Proposed Changes

### `src/webview/kanban.html` — `<style>` section (after line 585, after `.flash` class)

**Context**: Existing `.flash` class ends at line 585. Existing `@keyframes` patterns show the convention.

**Logic**: Add CSS animation for column highlight flash.

**Implementation**:
```css
/* Column Highlight Animation for Advance Operations */
@keyframes columnHighlight {
    0% { background: color-mix(in srgb, var(--accent-teal) 20%, transparent); }
    50% { background: color-mix(in srgb, var(--accent-teal) 30%, transparent); }
    100% { background: transparent; }
}
.column-body.highlight {
    animation: columnHighlight 0.8s ease-out forwards;
}
```

**Edge Cases**: Uses same teal color as drag-over (line 414) for visual consistency. `forwards` fill mode ensures it ends at transparent.

### `src/webview/kanban.html` — Optimistic move helper function (after `flashIconBtn` at line 3221)

**Context**: Existing DOM manipulation helpers in this area. Drag-drop has similar logic at lines 4429-4456. Cards do NOT have `data-column` attribute — use `currentCards` for actual column lookup.

**Logic**: Reusable function that moves cards optimistically in the DOM, handling empty states and count updates. Captures source body before `appendChild` to avoid closure-over-moved-node bug.

**Implementation**:
```javascript
/**
 * Move cards optimistically in the DOM before backend processing.
 * @param {string[]} sessionIds - Session IDs to move
 * @param {string} sourceColumn - Logical source column (may be 'CODED_AUTO')
 * @param {string} targetColumn - Logical target column
 */
function moveCardsOptimistically(sessionIds, sourceColumn, targetColumn) {
    const targetBody = document.getElementById('col-' + targetColumn);
    if (!targetBody) return;

    // Remove empty state from target if present
    const emptyState = targetBody.querySelector('.empty-state');
    if (emptyState) emptyState.remove();

    // Track which source DOM columns need empty-state check and count decrements
    // Key: DOM column ID, Value: set of sessionIds moved from that DOM col
    const sourceDomColCounts = {};

    sessionIds.forEach(id => {
        const cardEl = document.querySelector(`.kanban-card[data-session="${id}"]`);
        if (!cardEl) return;

        // Resolve actual source column from currentCards (cards have no data-column attribute)
        const cardData = currentCards.find(c => (c.sessionId || c.planId) === id);
        const actualColumn = cardData ? cardData.column : sourceColumn;

        // When coders are collapsed, actual coder columns display in CODED_AUTO DOM container
        const CODED_IDS = ['LEAD CODED', 'CODER CODED', 'INTERN CODED'];
        const sourceDomCol = (collapseCodersEnabled && CODED_IDS.includes(actualColumn))
            ? 'CODED_AUTO'
            : actualColumn;

        // Capture source body BEFORE appendChild (closest() changes after move)
        const sourceBody = document.getElementById('col-' + sourceDomCol);

        // Move card to target
        cardEl.classList.add('card-completing');
        targetBody.appendChild(cardEl);

        // Track for post-loop empty state + count updates
        if (!sourceDomColCounts[sourceDomCol]) sourceDomColCounts[sourceDomCol] = 0;
        sourceDomColCounts[sourceDomCol]++;
    });

    // Update source column empty states and counts
    Object.entries(sourceDomColCounts).forEach(([domCol, movedCount]) => {
        const sourceBody = document.getElementById('col-' + domCol);
        if (sourceBody && sourceBody.querySelectorAll('.kanban-card').length === 0) {
            sourceBody.innerHTML = '<div class="empty-state">No plans</div>';
        }
        const srcCount = document.getElementById('count-' + domCol);
        if (srcCount) {
            srcCount.textContent = String(Math.max(0, parseInt(srcCount.textContent || '0') - movedCount));
        }
    });

    // Increment target count
    const tgtCount = document.getElementById('count-' + targetColumn);
    if (tgtCount) {
        tgtCount.textContent = String((parseInt(tgtCount.textContent || '0') + sessionIds.length));
    }
}
```

**Edge Cases**:
- Missing card elements handled gracefully (skipped).
- Source body captured via `getElementById` before `appendChild` — avoids post-move `closest()` returning wrong element.
- Counts deduplicated per DOM column — handles multiple cards from same source.
- CODED_AUTO collapse: coder cards map to `col-CODED_AUTO` DOM container for empty state + count.

### `src/webview/kanban.html` — Update advance button handlers (lines 3571-3608)

**Context**: Current handlers only flash button and send message. Need to add optimistic UI after existing `flashIconBtn(btn)` call at line 3562. `nextCol` is already computed at line 3568 — reuse it.

**Logic**: After IDs are gathered, apply highlight to target column and call `moveCardsOptimistically()`. Apply to `moveSelected`, `moveAll`, `promptSelected`, `promptAll`.

**Implementation** (replace existing switch cases at lines 3572-3608):
```javascript
case 'moveSelected': {
    const ids = getSelectedInColumn(column);
    if (ids.length === 0) return;
    // Optimistic UI: highlight target column and move cards immediately
    if (nextCol) {
        const targetBody = document.getElementById('col-' + nextCol);
        if (targetBody) {
            targetBody.classList.add('highlight');
            targetBody.addEventListener('animationend', () => targetBody.classList.remove('highlight'), { once: true });
        }
        moveCardsOptimistically(ids, column, nextCol);
    }
    postKanbanMessage({ type: 'moveSelected', column: backendColumn, sessionIds: ids });
    ids.forEach(id => selectedCards.delete(id));
    break;
}
case 'moveAll': {
    const ids = getAllInColumn(column);
    if (ids.length === 0) return;
    // Optimistic UI: highlight target column and move cards immediately
    if (nextCol) {
        const targetBody = document.getElementById('col-' + nextCol);
        if (targetBody) {
            targetBody.classList.add('highlight');
            targetBody.addEventListener('animationend', () => targetBody.classList.remove('highlight'), { once: true });
        }
        moveCardsOptimistically(ids, column, nextCol);
    }
    // CODED_AUTO: backend moveAll filters by single column, so send explicit IDs instead
    if (column === 'CODED_AUTO') {
        postKanbanMessage({ type: 'moveSelected', column: backendColumn, sessionIds: ids });
    } else {
        postKanbanMessage({ type: 'moveAll', column: backendColumn });
    }
    ids.forEach(id => selectedCards.delete(id));
    break;
}
case 'promptSelected': {
    const ids = getSelectedInColumn(column);
    if (ids.length === 0) return;
    // Optimistic UI: highlight target column and move cards immediately
    if (nextCol) {
        const targetBody = document.getElementById('col-' + nextCol);
        if (targetBody) {
            targetBody.classList.add('highlight');
            targetBody.addEventListener('animationend', () => targetBody.classList.remove('highlight'), { once: true });
        }
        moveCardsOptimistically(ids, column, nextCol);
    }
    postKanbanMessage({ type: 'promptSelected', column: backendColumn, sessionIds: ids });
    ids.forEach(id => selectedCards.delete(id));
    break;
}
case 'promptAll': {
    const ids = getAllInColumn(column);
    if (ids.length === 0) return;
    // Optimistic UI: highlight target column and move cards immediately
    if (nextCol) {
        const targetBody = document.getElementById('col-' + nextCol);
        if (targetBody) {
            targetBody.classList.add('highlight');
            targetBody.addEventListener('animationend', () => targetBody.classList.remove('highlight'), { once: true });
        }
        moveCardsOptimistically(ids, column, nextCol);
    }
    // CODED_AUTO: backend promptAll filters by single column, so send explicit IDs instead
    if (column === 'CODED_AUTO') {
        postKanbanMessage({ type: 'promptSelected', column: backendColumn, sessionIds: ids });
    } else {
        postKanbanMessage({ type: 'promptAll', column: backendColumn });
    }
    ids.forEach(id => selectedCards.delete(id));
    break;
}
```

**Edge Cases**: If `nextCol` is null (no target column — pre-existing for CODED_AUTO when collapsed), skip optimistic UI but still send backend message. `promptAll` now gets same treatment as `moveAll` — this was missing from original plan.

## Verification Plan

### Automated Tests
- No automated tests exist for this webview UI component. Manual verification required.

Manual verification steps:
1. Click "Move Selected" button → verify target column flashes teal
2. Click "Move Selected" button → verify cards move immediately (no 2-second delay)
3. Click "Move All" button → verify target column flashes and all cards move immediately
4. Click "Prompt Selected" button → verify target column flashes and cards move immediately
5. Click "Prompt All" button → verify target column flashes and all cards move immediately
6. Test advancing from CODED_AUTO (collapsed mode) → verify cards move from CODED_AUTO DOM container
7. Test advancing last card in a column → verify "No plans" empty state appears
8. Test advancing to an empty column → verify "No plans" state is removed before cards added
9. Verify column counts update correctly (source -N, target +N)
10. Verify drag-drop still works (no regression)
11. Verify backend processing still works (check DB, agent dispatch logs)

### Error Handling Verification (Post-Implementation — deferred)
- Simulate backend failure (e.g., DB error) → verify optimistic move is reverted and error message shown
- Test network timeout → verify UI handles gracefully

---

## Review Pass — Grumpy Principal Engineer

### Findings

| # | Severity | Finding | Status |
|---|----------|---------|--------|
| 1 | CRITICAL | `card-completing` class makes cards invisible — `cardComplete` animation ends at `opacity:0; height:0` with `forwards` fill. Cards vanish in target column instead of appearing. | **Fixed** — replaced with `card-dropped` (arrival pulse animation) |
| 2 | CRITICAL | `getNextColumn(backendColumn)` returns wrong target for coded columns — e.g. `getNextColumn('LEAD CODED')` returns `'CODER CODED'` not `'CODE REVIEWED'`. Coded columns are parallel (same stage), not sequential. The drag-drop handler (line 4206) already solves this by resolving to the LAST visible coded column. | **Fixed** — added coded-column resolution logic matching drag-drop pattern |
| 3 | MAJOR | `currentCards` not updated after optimistic move — `card.column` stays at old value. Drag-drop reference updates `card.column = effectiveTargetColumn` (line 4650). Stale data can cause incorrect behavior for subsequent operations before refresh. | **Fixed** — added `if (cardData) cardData.column = targetColumn;` in loop |
| 4 | MAJOR | Target count incremented by `sessionIds.length` instead of actual moved count — if any card element is missing from DOM (skipped), count drifts. | **Fixed** — added `actualMovedCount` tracker, used for target count increment |
| 5 | NIT | `sourceBody` variable captured (line 3358) but never used — dead code. Post-loop empty-state check re-fetches via `getElementById`. | **Fixed** — removed unused variable |
| 6 | NIT | No arrival animation — cards just appear in target column with zero visual feedback. `card-dropped` class exists and provides a scale-pulse animation. | **Fixed** — `card-dropped` class now added (replaced `card-completing`) |

### Files Changed

- `src/webview/kanban.html`:
  - `moveCardsOptimistically()`: replaced `card-completing` → `card-dropped`, added `currentCards` update, added `actualMovedCount` tracker, removed dead `sourceBody` variable
  - Advance button handler: fixed `getNextColumn` resolution for coded columns — now resolves to last visible coded column before calling `getNextColumn`, matching drag-drop pattern (line 4206)

### Validation Results

- TypeScript: pre-existing errors only (import path issues in `.ts` files, unrelated to HTML changes). No new errors introduced.
- No automated tests exist for this webview UI component. Manual verification required per Verification Plan above.
- Compilation and automated tests skipped per session instructions.

### Remaining Risks

1. **Error revert path still deferred** — if backend move fails, optimistic DOM state diverges silently. No revert mechanism. This was documented in the original plan as a follow-up.
2. **CODED_AUTO collapsed mode still skips optimistic UI** — when coders are collapsed, `columns` array has individual coder IDs (not `CODED_AUTO`), so `getNextColumn(lastCodedCol)` returns `'CODE REVIEWED'` correctly. However, `document.getElementById('col-CODE REVIEWED')` exists in the DOM even when collapsed, so the optimistic UI should now work for CODED_AUTO collapsed mode too. Manual verification needed.
3. **Rapid double-click** — no button disabling during processing. Multiple optimistic moves could conflict. Low priority.

---
**Recommendation**: Send to Coder
