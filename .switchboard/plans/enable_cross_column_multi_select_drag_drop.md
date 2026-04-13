# Enable Cross-Column Multi-Select Drag and Drop

## Goal
Fix the Kanban board drag and drop behavior so that when users select cards across multiple columns and drag them to a new column, ALL selected cards are moved together, not just the cards from the single column where the drag originated.
## Metadata
**Tags:** frontend, UI, bugfix
**Complexity:** 4

## User Review Required
> [!NOTE]
> - Clarification: in the current `src/webview/kanban.html`, card selection is toggled by clicking a `.kanban-card`; there are no per-card selection checkboxes to update as part of this fix.
> - Clarification: keep the drag payload as the existing JSON array of session IDs so `handleDrop()` and `KanbanProvider` batch handlers continue to work unchanged.
> - Clarification: do not add new drop-time selection clearing. `handleDrop()` already clears `.selected` state in the `CODED_AUTO` branch (current lines 2381-2382) and again in the general branch (current lines 2571-2573).

## Complexity Audit
### Routine
- Add a board-wide rendered-selection helper immediately after `getSelectedInColumn()` in `src/webview/kanban.html`.
- Update `handleDragStart()` in `src/webview/kanban.html` so a drag started from any selected card packages all rendered selected cards, while single-card drags still emit a one-item payload.
- Add a focused regression test under `src/test/` that locks `handleDragStart()` to the new board-wide helper instead of `getSelectedInColumn(card.column)`.

### Complex / Risky
- The helper must ignore stale IDs that remain in `selectedCards` when cards are no longer rendered in the active board view (for example after collapsed coder rendering or backlog/view-state changes), otherwise invisible cards can hitchhike in the drag payload.
- The fix must preserve the existing array payload contract so the current `handleDrop()` batching, `promptOnDrop`, `triggerBatchAction`, `moveCardForward`, and `moveCardBackwards` flows continue to behave correctly for mixed-source drags.

## Edge-Case & Dependency Audit
- **Race Conditions:** `selectedCards` is mutated by card clicks and re-applied during render, but `handleDragStart()` itself is synchronous. The real risk is stale UI state, not async racing, so the fix should read the rendered `.kanban-card.selected` nodes at drag time instead of inferring scope from `card.column` or trusting every ID still present in the Set.
- **Security:** No new privileged operations are needed. Keep the change inside the existing webview selection/drag code path and preserve the current `postKanbanMessage()` payload shape so no new trust boundary is introduced.
- **Side Effects:** Do not refactor drop handling, provider routing, or selection-clearing behavior. `handleDrop()` already supports array payloads, already clears selection after successful drops, and already contains the special `CODED_AUTO` and backlog display logic this bugfix must leave intact.
- **Dependencies & Conflicts:** `switchboard-get_kanban_state` shows no active **New** items and three active **Planned** items: this plan, `remove_clickup_automation_debt.md`, and `add_kanban_column_management.md`. `remove_clickup_automation_debt.md` only touches ClickUp/database cleanup and is not a dependency. `add_kanban_column_management.md` is a real concurrency conflict because it also plans to change `src/webview/kanban.html` and drag/drop column behavior; if both move forward, rebase this bugfix against that work or land this smaller fix first to avoid overlapping edits in the same drag/drop surface.

## Adversarial Synthesis
### Grumpy Critique
This draft was one sleepy read-through away from shipping the wrong fix. The actual defect is in `handleDragStart()`: it calls `getSelectedInColumn(card.column)`, which neatly lops off every selected card outside the drag origin lane. Yet the earlier draft also tried to “fix” `handleDrop()` selection clearing that is already implemented twice. That is how tiny bugfixes turn into self-inflicted regressions.

And let's stop inventing UI that does not exist. The current board selects cards by clicking `.kanban-card`, then re-applies that state after re-render. If you blindly trust the global `selectedCards` Set without checking what is actually rendered, you will eventually drag ghost IDs from collapsed coder/backlog states and act surprised when batch routing misfires. The only sane plan is: package the rendered selected cards across the whole board, keep the existing array payload contract, and add a regression test that nails the exact bad call site so this column-scoped nonsense cannot slither back in later.

### Balanced Response
The revised plan narrows scope to the real bug surface in `src/webview/kanban.html`: the helper area around `getSelectedInColumn()` and the multi-select branch inside `handleDragStart()`. It adds one board-wide rendered-selection helper, swaps the drag-packaging logic to use that helper only when the dragged card already belongs to a multi-selection, and deliberately leaves `handleDrop()` untouched because selection clearing is already present in both drop paths.

Verification is also corrected. `split-coded-columns-regression.test.js` remains useful for guarding the `CODED_AUTO` board shape, `review-send-agent-trigger-regression.test.js` remains useful for batch trigger plumbing, and the plan adds a new focused regression test for the actual selection-packaging bug. The previously cited `kanban-view-plan-removal-regression.test.js` is not a meaningful verifier for this issue and should not be treated as acceptance coverage.

## Agent Recommendation

Send to Coder

## Proposed Changes
> [!IMPORTANT]
> **MAXIMUM DETAIL REQUIRED:** Fix only the drag payload construction for cross-column multi-select. Do not refactor the selection model, do not change provider-side routing, and do not add new drop-path behavior unless the implementation below explicitly calls for it.

### High Complexity
- None. The bugfix stays intentionally narrow and does not require a separate high-complexity implementation track beyond the risks already called out in the audit.

### Low Complexity
- Step 1 (`src/webview/kanban.html`) and Step 2 (`src/test/kanban-cross-column-multi-select-drag-regression.test.js`) are the full implementation surface for this fix.

### 1. Package rendered multi-selection across the whole board
#### [MODIFY] `src/webview/kanban.html`
- **Context:** `selectedCards` is declared near current line 1378, `getSelectedInColumn()` lives near lines 1475-1482, and `handleDragStart()` lives near lines 2285-2312. The current multi-select drag branch narrows the payload to `getSelectedInColumn(card.column)`, so dragging a selected card from one column drops every selected card from the other columns on the floor.
- **Logic:**
  1. Add a new helper immediately after `getSelectedInColumn()` named `getRenderedSelectedSessionIds()`.
  2. Implement that helper with `document.querySelectorAll('.kanban-card.selected')`, mapping `data-session` values and filtering falsy results. This intentionally scopes the drag payload to cards that are actually rendered in the current board view.
  3. In `handleDragStart()`, keep the existing guard that only multi-drags when the dragged card is itself selected and `selectedCards.size > 1`.
  4. Replace the `currentCards.find(...)/getSelectedInColumn(card.column)` branch with `getRenderedSelectedSessionIds()`. Only promote the drag to a batch when the rendered selection contains more than one card and still includes the dragged card; otherwise fall back to `[draggedId]`.
  5. Leave the rest of `handleDragStart()` untouched so the payload still uses `application/json` + `text/plain` and the existing drop code keeps working unchanged.
  6. **Clarification:** do **not** add extra selection clearing here or in `handleDrop()`. The current implementation already clears selection in the `CODED_AUTO` path and the general path.
- **Implementation:**

```diff
--- a/src/webview/kanban.html
+++ b/src/webview/kanban.html
@@
         /** Get all selected session IDs within a specific column. */
         function getSelectedInColumn(col) {
             const container = document.getElementById('col-' + col);
             if (!container) return [];
             const ids = [];
             container.querySelectorAll('.kanban-card.selected').forEach(el => {
                 ids.push(el.dataset.session);
             });
             return ids;
         }
+
+        /** Get all selected session IDs currently rendered on the board. */
+        function getRenderedSelectedSessionIds() {
+            return Array.from(document.querySelectorAll('.kanban-card.selected'))
+                .map(el => el.dataset.session)
+                .filter(Boolean);
+        }
@@
         function handleDragStart(e) {
             const draggedId = e.target.dataset.session;
             draggedSessionId = draggedId;
             e.target.classList.add('dragging');
             e.dataTransfer.effectAllowed = 'move';
 
             // Check if the dragged card is part of a multi-selection
             let idsToTransfer = [draggedId];
             if (selectedCards.has(draggedId) && selectedCards.size > 1) {
-                const card = currentCards.find(c => c.sessionId === draggedId);
-                if (card) {
-                    const selectedInColumn = getSelectedInColumn(card.column);
-                    if (selectedInColumn.length > 1) {
-                        idsToTransfer = selectedInColumn;
-                    }
+                const renderedSelected = getRenderedSelectedSessionIds();
+                if (renderedSelected.length > 1 && renderedSelected.includes(draggedId)) {
+                    idsToTransfer = renderedSelected;
                 }
             }
 
             // Add dragging class to all cards being transferred
             idsToTransfer.forEach(id => {
                 const el = document.querySelector(`.kanban-card[data-session="${id}"]`);
                 if (el) el.classList.add('dragging');
             });
 
             e.dataTransfer.setData('application/json', JSON.stringify(idsToTransfer));
```
- **Edge Cases Handled:** Using rendered `.selected` nodes automatically respects collapsed coder rendering, backlog display remapping, and any transient stale IDs left in `selectedCards` after a board refresh. Because the payload remains the same array of session IDs, mixed-source drops still flow through the existing `handleDrop()` routing without provider changes.

### 2. Add a regression test for the actual bug surface
#### [CREATE] `src/test/kanban-cross-column-multi-select-drag-regression.test.js`
- **Context:** No current test in `src/test/` directly protects the selection-packaging logic in `handleDragStart()`. `split-coded-columns-regression.test.js` is a useful nearby guard for `CODED_AUTO`, but `kanban-view-plan-removal-regression.test.js` only checks the removed Kanban view button path and does not exercise drag selection semantics.
- **Logic:**
  1. Follow the existing repository pattern of string-based regression tests that read source files directly.
  2. Assert that `kanban.html` now defines `getRenderedSelectedSessionIds()` and that the helper reads `.kanban-card.selected` from the rendered DOM.
  3. Assert that the multi-select branch in `handleDragStart()` uses `getRenderedSelectedSessionIds()` and assigns `idsToTransfer = renderedSelected`.
  4. Assert that the old `getSelectedInColumn(card.column)` line is gone from the drag-start multi-select path.
  5. Keep the test intentionally narrow so unrelated Kanban markup churn does not create false negatives.
- **Implementation:**

```javascript
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

function run() {
    const kanbanHtmlPath = path.join(process.cwd(), 'src', 'webview', 'kanban.html');
    const kanbanHtmlSource = fs.readFileSync(kanbanHtmlPath, 'utf8');

    assert.match(
        kanbanHtmlSource,
        /function getRenderedSelectedSessionIds\(\)\s*\{\s*return Array\.from\(document\.querySelectorAll\('\.kanban-card\.selected'\)\)\s*\.map\(el => el\.dataset\.session\)\s*\.filter\(Boolean\);\s*\}/s,
        'Expected kanban.html to expose a board-wide helper that gathers rendered selected cards across visible columns.'
    );

    assert.match(
        kanbanHtmlSource,
        /if \(selectedCards\.has\(draggedId\) && selectedCards\.size > 1\) \{[\s\S]*const renderedSelected = getRenderedSelectedSessionIds\(\);[\s\S]*if \(renderedSelected\.length > 1 && renderedSelected\.includes\(draggedId\)\) \{[\s\S]*idsToTransfer = renderedSelected;[\s\S]*\}/s,
        'Expected handleDragStart() to transfer all rendered selected cards when the dragged card belongs to a multi-selection.'
    );

    assert.ok(
        !kanbanHtmlSource.includes("const selectedInColumn = getSelectedInColumn(card.column);"),
        'Expected handleDragStart() to stop restricting drag payloads to the dragged card\'s source column.'
    );

    console.log('kanban cross-column multi-select drag regression test passed');
}

try {
    run();
} catch (error) {
    console.error('kanban cross-column multi-select drag regression test failed:', error);
    process.exit(1);
}
```
- **Edge Cases Handled:** This test locks the exact regression boundary without pretending to simulate the entire webview. If a future change reintroduces column-scoped packaging, the test fails immediately even if other drag/drop code still compiles.

## Verification Plan
### Automated Tests
- `npm run compile`
- `node src/test/kanban-cross-column-multi-select-drag-regression.test.js`
- `node src/test/split-coded-columns-regression.test.js`
- `node src/test/review-send-agent-trigger-regression.test.js`
- **Clarification:** do not use `node src/test/kanban-view-plan-removal-regression.test.js` as acceptance coverage for this bug. Source inspection shows it only guards the removed Kanban `viewPlan` action path.

### Manual Verification Steps
1. **Clarification:** selection in the current board is toggled by clicking cards, so select at least one rendered card in each of two different visible columns.
2. Start dragging one of the selected cards.
3. Drop into a different target column such as `CODE REVIEWED` or another valid destination for the chosen cards.
4. Verify every rendered selected card moves, not just the cards from the drag origin column.
5. Repeat with cards drawn from multiple coded lanes and drop onto `CODED_AUTO`; verify the existing complexity-based routing still lands each card in its resolved real coded column.
6. Verify selection styling is cleared after the successful drop (existing behavior preserved; no new code required).
7. Verify dragging an unselected card still moves only that card.

## Preserved Original Draft (Verbatim)

# Enable Cross-Column Multi-Select Drag and Drop

## Goal
Fix the Kanban board drag and drop behavior so that when users select cards across multiple columns and drag them to a new column, ALL selected cards are moved together, not just the cards from the single column where the drag originated.

## Metadata
**Tags:** frontend, kanban, bugfix, UX
**Complexity:** 4

## User Review Required
> [!NOTE]
> - Clarification: The UI already shows cards as "selected" across columns (checkboxes are checked), but the drag operation only transfers cards from the column being dragged from. The fix should maintain the current selection UI behavior but ensure all selected cards are included in the drag data.
> - Clarification: When dragging cards from multiple source columns to a single target column, each card should be processed according to its own forward/backward status relative to the target (the existing `handleDrop` logic already handles this correctly).

## Complexity Audit
### Routine
- Modify `handleDragStart` in `src/webview/kanban.html` to collect all selected cards globally from `selectedCards` Set instead of only from the dragged card's column.
- Ensure the `getAllSelectedCards()` helper returns session IDs from all columns when `selectedCards.size > 1`.
- Maintain backward compatibility: single-card drags without multi-selection should still work exactly as before.

### Complex / Risky
- **Column affinity on drop**: When cards from multiple columns are dropped, each card needs to resolve its own target column correctly. The existing `handleDrop` logic handles this, but we need to verify the `CODED_AUTO` synthetic column routing still works when source cards come from mixed real columns.
- **Selection state consistency**: After a successful drop, the selection state should be cleared to prevent accidental operations on cards that are now in a different column. This matches current single-column multi-select behavior.
- **Drag preview/visual feedback**: The drag preview currently shows the dragged card. When dragging a multi-column selection, this is still acceptable since the primary feedback is the selection highlighting itself.

## Edge-Case & Dependency Audit
- **Race Conditions**: The `selectedCards` Set is modified by checkbox clicks and cleared on various operations. The drag start handler reads it synchronously, so there are no race conditions.
- **CODED_AUTO synthetic column**: When cards from LEAD CODED, CODER CODED, or INTERN CODED are selected together and dragged, they all reside in the CODED_AUTO container in the DOM. The fix must ensure `getAllSelectedCards()` returns all of them correctly.
- **BACKLOG/CREATED view switching**: When `showingBacklog` is true, BACKLOG cards are rendered in the CREATED column container. The fix must handle this correctly when gathering selected cards.
- **Dependencies & Conflicts**: No active plans modify the Kanban drag and drop behavior. Recent nearby reviewed work:
  - `split-coded-columns-regression.test.js` - verifies CODED_AUTO behavior
  - `kanban-view-plan-removal-regression.test.js` - verifies selection and view state

## Adversarial Synthesis
### Grumpy Critique
The current implementation is a classic "UI says one thing, code does another" bug. The user sees 5 cards selected across 3 columns, drags them, and... surprise! Only 2 cards move because they happened to grab from the LEAD CODED column. That's not a feature, that's a broken contract.

The root cause is an over-specific helper: `getSelectedInColumn()` was designed for column-specific operations (like "archive selected in COMPLETED") but was repurposed for drag-and-drop without considering cross-column scenarios. The original author clearly assumed users would only multi-select within a column, which is either optimistic or never actually tested with real workflows.

A minimal fix might seem like changing one function call, but watch out: `selectedCards` is a global Set, and simply using it directly could include cards that aren't visible (e.g., filtered out). The fix needs to be "all selected cards that are currently rendered" not "all cards in the Set".

### Balanced Response
The corrected approach adds a new helper `getAllSelectedSessionIds()` that:
1. Returns all session IDs from `selectedCards` that have a rendered DOM element
2. Falls back to the dragged card alone if nothing else is selected
3. Preserves the existing drag data format so `handleDrop` requires no changes

This keeps the change minimal while fixing the user-facing bug. The selection clearing after drop already happens in `handleDrop` for the CODED_AUTO path (line 2381-2382) and should be extended to all drop paths for consistency.

## Agent Recommendation

Send to Coder

## Proposed Changes
> [!IMPORTANT]
> **MAXIMUM DETAIL REQUIRED:** The implementation below is intentionally scoped to fix the cross-column drag bug without refactoring the entire selection system. Do not change the selection UI, do not modify the drop handling logic, and do not alter the `selectedCards` data structure.

### 1. Add global selection helper
#### [MODIFY] `src/webview/kanban.html`
- **Context:** The `handleDragStart` function currently uses `getSelectedInColumn()` which restricts multi-selection to a single column. A global helper is needed to gather selected cards from all columns.
- **Logic:**
  1. Add a new function `getAllSelectedSessionIds()` that iterates over the `selectedCards` Set
  2. For each selected session ID, verify the card element exists in the DOM (to exclude filtered/hidden cards)
  3. Return the array of all valid selected session IDs
- **Implementation:**

```diff
--- a/src/webview/kanban.html
+++ b/src/webview/kanban.html
@@
         /** Get all selected session IDs within a specific column. */
         function getSelectedInColumn(col) {
             const container = document.getElementById('col-' + col);
             if (!container) return [];
             const ids = [];
             container.querySelectorAll('.kanban-card.selected').forEach(el => {
                 ids.push(el.dataset.session);
             });
             return ids;
         }
+
+        /** Get all selected session IDs across all visible columns. */
+        function getAllSelectedSessionIds() {
+            if (selectedCards.size === 0) return [];
+            const ids = [];
+            selectedCards.forEach(sessionId => {
+                // Only include if the card element exists in DOM (not filtered out)
+                const el = document.querySelector(`.kanban-card[data-session="${sessionId}"]`);
+                if (el) ids.push(sessionId);
+            });
+            return ids;
+        }
```

### 2. Update drag start to use global selection
#### [MODIFY] `src/webview/kanban.html`
- **Context:** The `handleDragStart` function needs to use the new helper to collect all selected cards across columns.
- **Logic:**
  1. Replace the `getSelectedInColumn()` call with `getAllSelectedSessionIds()`
  2. Keep the logic that checks if the dragged card is part of a multi-selection
  3. Ensure single-card drags still work correctly when `selectedCards.size === 1`
- **Implementation:**

```diff
--- a/src/webview/kanban.html
+++ b/src/webview/kanban.html
@@
         function handleDragStart(e) {
             const draggedId = e.target.dataset.session;
             draggedSessionId = draggedId;
             e.target.classList.add('dragging');
             e.dataTransfer.effectAllowed = 'move';
 
-            // Check if the dragged card is part of a multi-selection
+            // Check if the dragged card is part of a multi-selection
             let idsToTransfer = [draggedId];
-            if (selectedCards.has(draggedId) && selectedCards.size > 1) {
-                const card = currentCards.find(c => c.sessionId === draggedId);
-                if (card) {
-                    const selectedInColumn = getSelectedInColumn(card.column);
-                    if (selectedInColumn.length > 1) {
-                        idsToTransfer = selectedInColumn;
-                    }
-                }
+            if (selectedCards.has(draggedId) && selectedCards.size > 1) {
+                const allSelected = getAllSelectedSessionIds();
+                if (allSelected.length > 1) {
+                    idsToTransfer = allSelected;
+                }
             }
 
             // Add dragging class to all cards being transferred
             idsToTransfer.forEach(id => {
```

### 3. Ensure selection clears after cross-column drop
#### [MODIFY] `src/webview/kanban.html`
- **Context:** The CODED_AUTO drop path clears selection (lines 2381-2382), but the general drop path does not. This should be consistent.
- **Logic:**
  1. Add selection clearing to the end of `handleDrop` for all successful drop operations
  2. Ensure the visual selection state is also cleared (remove `.selected` class)
- **Implementation:**

```diff
--- a/src/webview/kanban.html
+++ b/src/webview/kanban.html
@@
             if (uncompleteIds.length > 0) {
                 postKanbanMessage({ type: 'uncompleteCard', sessionIds: uncompleteIds, targetColumn: effectiveTargetColumn, workspaceRoot });
                 uncompleteIds.forEach(id => {
                     const card = currentCards.find(c => c.sessionId === id);
                     if (card) card.column = effectiveTargetColumn;
                 });
             }
+
+            // Clear selection after successful drop
+            document.querySelectorAll('.kanban-card.selected').forEach(el => el.classList.remove('selected'));
+            selectedCards.clear();
         }
```

## Verification Plan
### Automated Tests
- Run existing Kanban regression tests to ensure no regressions:
  - `node src/test/split-coded-columns-regression.test.js`
  - `node src/test/kanban-view-plan-removal-regression.test.js`
  - `npm run compile`

### Manual Verification Steps
1. Create or identify at least 3 plans in different columns (e.g., one in LEAD CODED, one in CODER CODED, one in INTERN CODED)
2. Use checkboxes to select all 3 cards across the different columns
3. Drag from any one column to the REVIEWED column
4. Verify all 3 cards move to REVIEWED, not just the cards from the dragged column
5. Repeat test with cards in CREATED and PLAN REVIEWED columns, drag to CODED_AUTO
6. Verify each card routes to its appropriate complexity-based column (or CODER CODED if no complexity)
7. Verify selection is cleared after drop (checkboxes are unchecked)
8. Verify single-card drag (without multi-selection) still works normally

## Original Draft Notes (Preserved)

## Problem
When users select cards across multiple columns (e.g., some in LEAD CODED, some in CODER CODED) and drag them to a new column, only the cards from the column where the drag originated are moved. The UI shows all cards as selected, but the drag operation doesn't respect the full selection.

## Root Cause
In `handleDragStart` (lines 2285-2312), when a dragged card is part of a multi-selection, the code uses `getSelectedInColumn(card.column)` which only returns selected cards from that specific column:

```javascript
if (selectedCards.has(draggedId) && selectedCards.size > 1) {
    const card = currentCards.find(c => c.sessionId === draggedId);
    if (card) {
        const selectedInColumn = getSelectedInColumn(card.column);  // <-- Only one column!
        if (selectedInColumn.length > 1) {
            idsToTransfer = selectedInColumn;
        }
    }
}
```

The `getSelectedInColumn()` function queries the DOM for `.kanban-card.selected` within a specific column container, so it cannot see selected cards in other columns.

## Files to Modify
- `src/webview/kanban.html` - Add global selection helper and update drag start logic

## Testing
1. Select cards across multiple columns
2. Drag to a target column
3. Verify all selected cards move
4. Verify single-card drag still works
5. Verify selection clears after drop

## Direct Reviewer Pass (2026-04-12)

### Stage 1 - Grumpy Principal Engineer
- [NIT] This fix wisely stops at the real crime scene: `handleDragStart()`. Thank heaven. One eager detour into `handleDrop()` and this tidy payload repair would have turned into a routing-regression carnival.
- [NIT] One of the suggested nearby guards is yelling about `review.html` not posting `sendToAgent`. That may be a legitimate review-ticket problem, but it is not evidence against this drag-packaging fix and should not be mistaken for one.

### Stage 2 - Balanced Synthesis
- **Keep:** The board-wide rendered-selection helper, the narrow `handleDragStart()` change, and the deliberate refusal to touch `handleDrop()`.
- **Fix now:** None in the drag implementation. The shipped bugfix matches the plan and the focused regression proves the exact bad call site is gone.
- **Defer:** Investigate the unrelated `review-send-agent-trigger-regression.test.js` failure in a dedicated review-ticket UI pass, not in this drag/drop bugfix.

### Fixed Items
- None in reviewer pass.

### Files Changed
- No additional reviewer-pass changes to the drag implementation.
- Reviewed implementation files:
  - `src/webview/kanban.html`
  - `src/test/kanban-cross-column-multi-select-drag-regression.test.js`

### Validation Results
- `npm run compile` - **PASSED**
- `node src/test/kanban-cross-column-multi-select-drag-regression.test.js` - **PASSED**
- `node src/test/split-coded-columns-regression.test.js` - **PASSED**
- `node src/test/review-send-agent-trigger-regression.test.js` - **FAILED (unrelated pre-existing review ticket UI regression: `src/webview/review.html` does not currently post `sendToAgent`)**

### Remaining Risks
- Verification still depends on a focused source-based regression rather than a DOM-level interaction test.
- The unrelated review-ticket UI guard remains red and should not be mistaken for a failure of the drag payload fix itself.
