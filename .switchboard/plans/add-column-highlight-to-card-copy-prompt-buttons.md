# Add Column Highlight to Card Copy Prompt Buttons

## Goal
Add visual column feedback (teal highlight flash) when card-level "Copy prompt" buttons are clicked, matching the behavior of column header advance buttons.

## Metadata
- **Tags:** [frontend, UX, UI]
- **Complexity:** 3

## User Review Required
- Confirm whether card-level copy prompt buttons should also get optimistic card movement (like column header buttons)
- Confirm whether other card-level action buttons (recover, pair-program, send-to-backlog) should get similar feedback

## Problem
When clicking the "Copy prompt" button on individual kanban cards:
1. **No visual feedback on destination column** - users can't tell where cards will move until they actually move
2. **Inconsistent UX** - column header "Prompt Selected" button has column highlight, but card-level copy button does not
3. **Poor discoverability** - users may not realize the card will advance after copying the prompt

## Root Cause Analysis

### Current Implementation

**Column header "Prompt Selected" button** (has feedback):
- Location: `src/webview/kanban.html` lines 3866-3880
- Applies highlight class to target column (line 3873)
- Calls `moveCardsOptimistically()` to move cards immediately (line 3876)
- Removes highlight after animation (line 3874)

**Card-level "Copy prompt" button** (missing feedback):
- Location: `src/webview/kanban.html` lines 4182-4193
- Only sends backend message `promptSelected` (line 4187)
- No target column highlight
- No optimistic card movement
- No visual indication of destination

### Why the Discrepancy
The column header buttons were updated in plan `kanban-advance-button-target-column-flash-and-optimistic-ui.md` to include optimistic UI. The card-level buttons were missed in that implementation.

### Backend Processing
Both button types send the same backend message: `type: 'promptSelected'`. The backend:
- Generates the prompt for the card
- Advances the card to the next column
- Calls `_refreshBoard()` to reload the board state

The delay is the same for both button types (~2 seconds), but only the column header button provides visual feedback during this delay.

## Solution

Add the same optimistic UI pattern to the card-level copy prompt button handler:
1. Determine target column using `getNextColumn()`
2. Apply highlight class to target column body
3. Call `moveCardsOptimistically()` to move card immediately
4. Remove highlight after animation

### Implementation Steps

1. **Update card-level copy prompt button handler**
   - File: `src/webview/kanban.html` lines 4182-4193
   - After extracting `column` and `sessionId`, add optimistic UI logic
   - Resolve target column using coded-column resolution pattern from column header handler (lines 3815-3820)
   - Apply highlight class to target column body
   - Call `moveCardsOptimistically([sessionId], column, nextCol)`
   - Handle case where `nextCol` is null (no target column) - skip optimistic UI but still send backend message

2. **Handle coded column resolution**
   - When source column is a coded column (LEAD CODED, CODER CODED, INTERN CODED) or CODED_AUTO, must resolve to the last visible coded column before calling `getNextColumn()`
   - **CRITICAL**: Do NOT resolve to `'CODED_AUTO'` — it is NOT in the `columns` array (line 2974-2976) and `getNextColumn('CODED_AUTO')` returns `null`
   - Reuse the exact pattern from column header handler (lines 3815-3820):
     ```javascript
     const CODED_IDS = ['LEAD CODED', 'CODER CODED', 'INTERN CODED'];
     let nextColSource = column;
     if (CODED_IDS.includes(column) || column === 'CODED_AUTO') {
         const visibleCodedIds = CODED_IDS.filter(id => columns.includes(id));
         nextColSource = visibleCodedIds[visibleCodedIds.length - 1] || 'CODER CODED';
     }
     const nextCol = getNextColumn(nextColSource);
     ```
   - This same pattern is also used in card rendering (lines 4293-4301)

3. **Test the fix**
   - Click card-level "Copy prompt" button → verify target column flashes teal
   - Click card-level "Copy prompt" button → verify card moves immediately (no 2-second delay)
   - Verify prompt is still copied to clipboard
   - Verify backend processing still works (DB update, agent dispatch)
   - Test from coded columns → verify correct target column resolution
   - Test from CODED_AUTO (collapsed mode) → verify correct behavior

### Files to Modify

- `src/webview/kanban.html`:
  - Update card-level copy prompt button handler (lines 4182-4193)
  - Add optimistic UI logic matching column header button pattern

## Expected Outcome

After this fix:
- Clicking card-level "Copy prompt" buttons shows immediate visual feedback on the destination column (teal highlight flash)
- Cards move immediately in the UI (optimistic DOM update)
- No 2-second delay before cards appear in target column
- UX matches column header button behavior (consistent)
- Users can clearly see where cards are going after copying prompt

## Complexity Audit

### Routine
- Reusing existing `moveCardsOptimistically()` function (already exists at line 3399)
- Reusing existing `getNextColumn()` function (already exists at line 3379)
- Reusing existing highlight CSS animation (already exists at lines 620-628)
- Pattern matches column header button implementation (lines 3870-3876)
- Coded column resolution pattern already proven in column header handler (lines 3815-3820) and card rendering (lines 4293-4301)

### Complex / Risky
- **Coded column resolution**: Must use the correct resolution pattern (resolve to last visible coded column ID, NOT to 'CODED_AUTO'). The original plan's proposed code had a bug here — it resolved to 'CODED_AUTO' which is not in the `columns` array, causing `getNextColumn()` to return `null` and silently skipping all optimistic UI in the default (collapsed) configuration.
- **Single card vs multiple cards**: Column header button handles arrays of IDs; card button handles single ID. Need to wrap in array for `moveCardsOptimistically()`.

## Edge-Case & Dependency Audit

- **Race Conditions**: Same as column header buttons - if backend move fails, optimistic DOM state diverges. This is a known risk documented in the original plan and deferred to follow-up. The `_refreshBoard()` call after backend processing reconciles DOM state.
- **Coded Columns**: Must resolve to last visible coded column before calling `getNextColumn()`. Column header handler has this logic at lines 3815-3820. Card rendering has the same pattern at lines 4293-4301.
- **CODED_AUTO Collapse**: When coders collapsed, cards display in CODED_AUTO but are actually in individual coder columns. `moveCardsOptimistically()` already handles this (lines 3421-3424). The `data-column` attribute on the copy button (line 4321) stores `card.column` which is the real backend column, not CODED_AUTO (though `card.column` can be CODED_AUTO in some cases — the resolution logic handles both).
- **Empty States**: Moving last card from a column should show "No plans" empty state. `moveCardsOptimistically()` already handles this.
- **Count Badges**: Source and target column counts must update. `moveCardsOptimistically()` already handles this.
- **Security**: No security implications — purely UI/UX improvement.
- **Side Effects**: None expected — this adds visual feedback without changing backend logic.
- **Dependencies & Conflicts**:
  - Depends on `moveCardsOptimistically()` (already exists at line 3399)
  - Depends on `getNextColumn()` (already exists at line 3379)
  - Depends on coded column resolution pattern (exists in column header handler at lines 3815-3820 and card rendering at lines 4293-4301)
  - No new dependencies on backend services.

## Dependencies
None

## Adversarial Synthesis
Key risk: coded column resolution must use the proven pattern from lines 3815-3820 (resolve to last visible coded column ID like 'INTERN CODED', never to 'CODED_AUTO'). The original proposed code had a critical bug that resolved to 'CODED_AUTO' — which is not in the `columns` array — causing `getNextColumn()` to return null and silently disabling all optimistic UI in the default collapsed configuration. Mitigation: copy the exact resolution pattern from the column header handler. Secondary risk: rapid double-click could fire duplicate backend messages, but this is identical to the accepted risk for column header buttons and `_refreshBoard()` reconciles DOM state.

## Proposed Changes

### `src/webview/kanban.html` — Update card-level copy prompt button handler (lines 4182-4193)

**Context**: Current handler only sends backend message. Need to add optimistic UI before the message.

**Logic**: Extract column, resolve target column with coded-column handling (matching pattern from lines 3815-3820), apply highlight, move card optimistically, then send backend message.

**Implementation** (replace existing handler at lines 4182-4193):
```javascript
document.querySelectorAll('.card-btn.copy').forEach(btn => {
    btn.addEventListener('click', () => {
        const column = btn.dataset.column || btn.closest('.kanban-column')?.dataset?.column;
        const sessionId = btn.dataset.session || '';
        
        // Optimistic UI: highlight target column and move card immediately
        let nextCol = null;
        if (column) {
            // Handle coded columns: resolve to last visible coded column before calling getNextColumn
            // Pattern matches column header handler (lines 3815-3820) and card rendering (lines 4293-4301)
            // CRITICAL: Do NOT resolve to 'CODED_AUTO' — it is not in the `columns` array
            const CODED_IDS = ['LEAD CODED', 'CODER CODED', 'INTERN CODED'];
            let nextColSource = column;
            if (CODED_IDS.includes(column) || column === 'CODED_AUTO') {
                const visibleCodedIds = CODED_IDS.filter(id => columns.includes(id));
                nextColSource = visibleCodedIds[visibleCodedIds.length - 1] || 'CODER CODED';
            }
            nextCol = getNextColumn(nextColSource);
            
            if (nextCol) {
                const targetBody = document.getElementById('col-' + nextCol);
                if (targetBody) {
                    targetBody.classList.add('highlight');
                    targetBody.addEventListener('animationend', () => targetBody.classList.remove('highlight'), { once: true });
                }
                moveCardsOptimistically([sessionId], column, nextCol);
            }
        }
        
        postKanbanMessage({
            type: 'promptSelected',
            column,
            sessionIds: [sessionId],
            workspaceRoot: btn.dataset.workspaceRoot
        });
    });
});
```

**Edge Cases**:
- If `column` is undefined (missing data attribute), skip optimistic UI but still send backend message.
- If `nextCol` is null (no target column, e.g. card in last column), skip optimistic UI but still send backend message.
- Coded column resolution matches proven pattern from column header handler (lines 3815-3820) and card rendering (lines 4293-4301).
- Handles both `CODED_IDS.includes(column)` and `column === 'CODED_AUTO'` cases.
- Single sessionId wrapped in array for `moveCardsOptimistically()`.
- `moveCardsOptimistically()` internally resolves the actual source column from `currentCards` (line 3417-3418), so passing the raw `column` is correct even for coded columns.

## Verification Plan

### Manual Verification Steps
1. Click card-level "Copy prompt" button on a CREATED card → verify CODE REVIEWED column flashes teal
2. Click card-level "Copy prompt" button → verify card moves immediately (no 2-second delay)
3. Verify prompt is copied to clipboard
4. Click card-level "Copy prompt" button on a PLAN REVIEWED card → verify correct coder column flashes
5. Test from coded column (LEAD CODED) → verify advances to CODE REVIEWED, not CODER CODED
6. Test from CODED_AUTO (collapsed mode, `collapseCodersEnabled=true` which is the default) → verify correct target column flashes and card moves
7. Test on last card in a column → verify "No plans" empty state appears
8. Test on empty target column → verify "No plans" state is removed before card added
9. Verify column counts update correctly (source -1, target +1)
10. Verify column header "Prompt Selected" button still works (no regression)
11. Verify backend processing still works (check DB, agent dispatch logs)

### Automated Tests
- No automated tests exist for this webview UI component. Manual verification required.

## Remaining Risks

1. **Error revert path still deferred** — if backend move fails, optimistic DOM state diverges silently. No revert mechanism. This is a known risk from the original plan and deferred to follow-up. `_refreshBoard()` reconciles DOM state after backend processing completes.
2. **Coded column resolution** — the corrected pattern matches the proven column header handler. Manual verification from coded columns is still critical.
3. **Rapid double-click** — no button disabling during processing. Multiple optimistic moves could conflict. This is identical to the accepted risk for column header buttons. Low priority; `_refreshBoard()` reconciles.

## Recommendation
Complexity 3 → **Send to Intern**
