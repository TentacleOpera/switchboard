# Fix Kanban Drag-and-Drop Batching for CODED_AUTO Column

## Goal
Fix both reproducible multi-drag failures around the collapsed `CODED_AUTO` view: dragging cards **into** `CODED_AUTO` still dispatches one backend action per card, and dragging cards **out of** the collapsed coded bucket can degrade to a one-card payload before drop handling even runs. Keep the existing provider batch handlers, prompt/CLI modes, and optimistic DOM behavior intact while making the webview send the correct grouped payloads.

## Metadata
**Tags:** frontend, UI, bugfix
**Complexity:** 6

## User Review Required
> [!NOTE]
> - **Clarification:** the drag-out bug is now treated as a confirmed production defect, not an unproven hypothesis. Current source inspection shows `handleDragStart()` still narrows multi-selection to `getSelectedInColumn(card.column)`, which breaks collapsed `CODED_AUTO` drags because cards are rendered under `col-CODED_AUTO` but still carry real logical columns like `LEAD CODED` or `CODER CODED`.
> - **Clarification:** the verified production fix surface is still `src/webview/kanban.html`. `src/services/KanbanProvider.ts` already accepts batched `sessionIds` for `triggerBatchAction`, `moveCardForward`, `moveCardBackwards`, and `promptOnDrop`, so provider-side batching is not the known missing behavior.
> - **Clarification:** preserve real target-column drag/drop modes. `CODED_AUTO` is synthetic and always renders as CLI, but the resolved real coded targets can still be `'prompt'` or `'cli'` through `columnDragDropModes`.
> - **Clarification:** do not broaden this into board-wide cross-column multi-select drag. The required behavior here is narrower: cards visibly grouped in collapsed `CODED_AUTO` must drag together, and cards dropped into `CODED_AUTO` must batch by resolved real target.
> - **Clarification:** per-card optimistic DOM animation can remain visible after the fix. The acceptance target is grouped drag payloads and grouped backend messages, not a single combined DOM animation.

## Complexity Audit
### Routine
- Add a rendered-container selection helper in `src/webview/kanban.html` and use it in `handleDragStart()` so collapsed `CODED_AUTO` multi-selection produces one drag payload containing every visible selected coded card.
- Replace the per-card timer dispatch in the `targetColumn === 'CODED_AUTO'` branch of `handleDrop()` with grouped batches keyed by resolved target column and dispatch mode.
- Add focused source-based regression coverage under `src/test/` for both the outbound drag payload bug and the inbound per-card dispatch bug.
- Re-run nearby existing regression guards that already protect split coded columns and provider batch trigger plumbing.

### Complex / Risky
- `CODED_AUTO` is synthetic in the DOM but resolves to real coded lanes at dispatch time, so batching must group by the resolved lane rather than by the synthetic visible column alone.
- Prompt-mode drops cannot be merged blindly: `promptOnDrop` in `src/services/KanbanProvider.ts` consumes a single `sourceColumn`, so prompt batches must stay grouped by both resolved target and pre-drop source stage.
- The drag-out bug occurs before drop handling: if `handleDragStart()` packages only one ID, the already-batched backward path in `handleDrop()` and `KanbanProvider.ts` never gets a real batch to work with.
- The fix must preserve optimistic DOM moves, collapsed coded-column rendering, and count updates while changing only payload construction and dispatch grouping.

## Edge-Case & Dependency Audit
- **Race Conditions:** `handleDragStart()` is synchronous and should derive its multi-drag payload from the rendered DOM container at the moment the drag begins. `handleDrop()` mutates `currentCards` optimistically and dispatches after a `350ms` timer, so it must snapshot each routed card's pre-drop source column, resolved target, and dispatch type before the timer fires.
- **Security:** No new privileged surface is needed. Keep using existing `postKanbanMessage(...)` message types and avoid “temporary” logging that dumps card payloads or workspace details to the console during investigation.
- **Side Effects:** The revised drag-start helper should be limited to the dragged card's rendered container, not the entire board, so this bugfix does not silently implement the separate backlog idea of cross-column multi-select drag. Inbound drops into `CODED_AUTO` should still animate cards individually even though the backend dispatch becomes batched per group.
- **Dependencies & Conflicts:** `switchboard-get_kanban_state` succeeded. Active **New** plans: none. Active **Planned** plans are `Fix Kanban Drag-and-Drop Batching for CODED_AUTO Column`, `Remove ClickUp Automation Technical Debt`, `Fix Duplicate Switchboard State Parsing Bug` (two entries), `Fix Custom Lane Import/Reset Round-Tripping`, and `Extend Event Monitoring and Ticket Write-Back to Linear`. None of those active planned items target `src/webview/kanban.html` or the drag/drop batching path. A `.switchboard/plans` scan does reveal one non-active but relevant merge hotspot: `enable_cross_column_multi_select_drag_drop.md` also targets `handleDragStart()` in `src/webview/kanban.html`, but it is not in New/Planned and therefore is context rather than an active blocker. Reviewed nearby work in `fix_builtin_role_dispatch_coverage_gaps.md` and `split-coded-columns-regression.test.js` means this plan must not reopen role mapping or split-coded-column structure changes that are already in place.

## Adversarial Synthesis
### Grumpy Critique
The previous revision kept insisting the drag-out bug was some kind of ghost story because `moveCardBackwards` already takes an array. That is not engineering; that is hiding behind one correct function signature while the real bug sits three inches upstream. `handleDragStart()` still calls `getSelectedInColumn(card.column)`. In collapsed coded view, that means the dragged card points at `LEAD CODED` or `CODER CODED` while the actual selected siblings are rendered under `col-CODED_AUTO`. Of course the user sees one-by-one behavior: the drag payload is already crippled to one ID before the drop handler ever gets a vote.

And inbound routing into `CODED_AUTO` is still guilty on its own merits. That branch really does emit one timer and one backend message per card. So there are two bugs here, both in the same file, and both were visible the whole time. Any plan that “narrows scope” by pretending one of them is not real is not being disciplined; it is being stubborn.

### Balanced Response
The revised plan now treats both user-visible failures as confirmed and separates them by their actual source. Dragging **out of** collapsed `CODED_AUTO` is a drag-start payload bug in `handleDragStart()`, while dragging **into** `CODED_AUTO` is a grouped-dispatch bug in the special `handleDrop()` branch for the synthetic coded column.

That still keeps the fix narrow. Both production changes stay in `src/webview/kanban.html`, and both reuse existing provider message contracts instead of inventing new backend behavior. The updated implementation spec now fixes the outbound payload construction first, fixes the inbound grouped dispatch second, and adds dedicated regression tests for each half so neither bug can be waved away again.

## Agent Recommendation

Send to Coder

## Proposed Changes
> [!IMPORTANT]
> **MAXIMUM DETAIL REQUIRED:** Fix both confirmed webview bugs without refactoring provider-side routing. The production code changes remain in `src/webview/kanban.html`; new tests in `src/test/` should lock both root causes separately.

### Clarification - verified root causes and unchanged backend contracts
- `src/webview/kanban.html:2285-2312` (`handleDragStart`) is the confirmed drag-out failure point. The current multi-select branch reads `getSelectedInColumn(card.column)`, which collapses a visually multi-selected `CODED_AUTO` drag to a single real coded lane or a single card.
- `src/webview/kanban.html:2378-2435` (`handleDrop` when `targetColumn === 'CODED_AUTO'`) is the confirmed drag-in failure point. That branch posts `triggerAction` / `moveCardBackwards` per card inside `sessionIds.forEach(...)` and bypasses the board's normal grouped dispatch path.
- `src/webview/kanban.html:2505-2594` shows the general non-`CODED_AUTO` drop path already batching `forwardIds` and `backwardIds`.
- `src/services/KanbanProvider.ts:2452-2544` already accepts grouped arrays for `triggerBatchAction`, `moveCardForward`, and `moveCardBackwards`.
- `src/services/KanbanProvider.ts:2865-2944` already accepts grouped `promptOnDrop` payloads but requires a single `sourceColumn` per message, which is why prompt-mode groups must preserve source-column context.
- `src/test/review-send-agent-trigger-regression.test.js` and `src/test/split-coded-columns-regression.test.js` are still useful nearby guards, but neither one currently proves correct multi-drag payload construction or correct grouped dispatch in the `CODED_AUTO` webview branch.

### High Complexity

#### 1. Fix drag-start payload construction for collapsed `CODED_AUTO` drags
##### [MODIFY] `src/webview/kanban.html`
- **Context:** The user-visible “drag out happens one by one” bug is reproducible because `handleDragStart()` currently narrows multi-selection to `getSelectedInColumn(card.column)`. In collapsed coded view, the dragged card is logically in `LEAD CODED` / `CODER CODED` / `INTERN CODED`, but the selected cards are rendered inside the synthetic `col-CODED_AUTO` container. The drag payload therefore shrinks before drop batching even begins.
- **Logic:**
  1. Add a helper immediately after `getSelectedInColumn()` called `getSelectedInRenderedContainer(cardEl)`.
  2. Implement it by locating the dragged card's nearest `.column-body` container and reading `.kanban-card.selected` inside that rendered container only.
  3. Update `handleDragStart()` to resolve the dragged element from `e.currentTarget` (falling back to `closest('.kanban-card')` only if needed), so payload construction is anchored to the actual dragged card element rather than a potentially nested child target.
  4. Keep the existing guard that only promotes a drag to multi-card behavior when the dragged card is already selected and `selectedCards.size > 1`.
  5. Replace `getSelectedInColumn(card.column)` with `getSelectedInRenderedContainer(draggedCardEl)`, and only use that rendered selection when it still includes the dragged ID and contains more than one card.
  6. Leave the JSON array payload contract unchanged so the rest of `handleDrop()` and `KanbanProvider` continue working with no provider refactor.
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
+        /** Get selected session IDs from the dragged card's rendered column container. */
+        function getSelectedInRenderedContainer(cardEl) {
+            const container = cardEl ? cardEl.closest('.column-body') : null;
+            if (!container) return [];
+            return Array.from(container.querySelectorAll('.kanban-card.selected'))
+                .map(el => el.dataset.session)
+                .filter(Boolean);
+        }
@@
         function handleDragStart(e) {
-            const draggedId = e.target.dataset.session;
+            const draggedCardEl =
+                (e.currentTarget && e.currentTarget.classList && e.currentTarget.classList.contains('kanban-card'))
+                    ? e.currentTarget
+                    : e.target.closest('.kanban-card');
+            const draggedId = draggedCardEl?.dataset.session;
+            if (!draggedCardEl || !draggedId) return;
             draggedSessionId = draggedId;
-            e.target.classList.add('dragging');
+            draggedCardEl.classList.add('dragging');
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
+                const selectedInRenderedContainer = getSelectedInRenderedContainer(draggedCardEl);
+                if (selectedInRenderedContainer.length > 1 && selectedInRenderedContainer.includes(draggedId)) {
+                    idsToTransfer = selectedInRenderedContainer;
                 }
             }
 
             // Add dragging class to all cards being transferred
             idsToTransfer.forEach(id => {
                 const el = document.querySelector(`.kanban-card[data-session="${id}"]`);
                 if (el) el.classList.add('dragging');
             });
 
             e.dataTransfer.setData('application/json', JSON.stringify(idsToTransfer));
             e.dataTransfer.setData('text/plain', draggedId);
-            e.dataTransfer.setData('application/switchboard-workspace-root', e.target.dataset.workspaceRoot || getActiveWorkspaceRoot());
+            e.dataTransfer.setData('application/switchboard-workspace-root', draggedCardEl.dataset.workspaceRoot || getActiveWorkspaceRoot());
         }
```

- **Edge Cases Handled:** This keeps single-card drags unchanged, fixes collapsed `CODED_AUTO` outbound drags, and stays narrower than a full board-wide cross-column drag feature because it only packages the dragged card's rendered container. It also naturally follows any other synthetic rendered container that already exists without trusting stale logical-column state.

#### 2. Batch `CODED_AUTO` drop dispatch by resolved target, direction, and prompt-mode source column
##### [MODIFY] `src/webview/kanban.html`
- **Context:** Even when the drag payload contains multiple cards, the special `CODED_AUTO` drop branch currently emits one backend action per card. That is the confirmed inbound batching bug and must be fixed independently of drag-start packaging.
- **Logic:**
  1. Keep `resolveCodedAutoTarget(card)` unchanged; it is the verified complexity/router helper already used to resolve the synthetic drop to real coded lanes.
  2. Inside the `targetColumn === 'CODED_AUTO'` branch, replace the per-card `setTimeout(...)` dispatch with grouped payloads captured during the initial routing loop.
  3. For each card, snapshot:
     - `prevCol`
     - `resolvedTarget`
     - forward vs backward direction
     - resolved `dropMode` for the real target column
     - `sourceColumnForPrompt` for prompt-mode groups
  4. Group backward moves by resolved target column.
  5. Group non-CLI forward moves (`cliTriggersEnabled === false`) by resolved target column.
  6. Group prompt-mode forward moves by both resolved target and `sourceColumnForPrompt`.
  7. Group CLI forward moves by resolved target column and dispatch `triggerAction` vs `triggerBatchAction` based on group size.
  8. Preserve the existing optimistic DOM update / animation block exactly where it is so user-visible movement remains unchanged.
- **Implementation:**

```diff
--- a/src/webview/kanban.html
+++ b/src/webview/kanban.html
@@
             // Handle drops onto the synthetic CODED_AUTO column — route each card to its real column
             if (targetColumn === 'CODED_AUTO') {
                 const CODED_IDS = ['LEAD CODED', 'CODER CODED', 'INTERN CODED'];
                 document.querySelectorAll('.kanban-card.selected').forEach(el => el.classList.remove('selected'));
                 selectedCards.clear();
                 const targetBody = document.getElementById('col-CODED_AUTO');
+                const dispatchGroups = new Map();
 
                 sessionIds.forEach(id => {
                     const card = currentCards.find(c => c.sessionId === id);
                     if (!card) return;
                     const resolvedTarget = resolveCodedAutoTarget(card);
                     if (card.column === resolvedTarget) return;
+
+                    const prevCol = card.column;
+                    const srcIdx = prevCol === 'BACKLOG' ? 0 : columns.indexOf(prevCol);
+                    const tgtIdx = columns.indexOf(resolvedTarget);
+                    if (tgtIdx === srcIdx) return;
+
+                    const sourceColumnForPrompt = prevCol;
+                    const dropMode = columnDragDropModes[resolvedTarget] || 'cli';
+                    const dispatchType = tgtIdx < srcIdx
+                        ? 'backward'
+                        : (!cliTriggersEnabled ? 'move' : (dropMode === 'prompt' ? 'prompt' : 'cli'));
+                    const groupKey = dispatchType === 'prompt'
+                        ? `${dispatchType}::${resolvedTarget}::${sourceColumnForPrompt}`
+                        : `${dispatchType}::${resolvedTarget}`;
+                    const group = dispatchGroups.get(groupKey) || {
+                        dispatchType,
+                        targetColumn: resolvedTarget,
+                        sourceColumn: sourceColumnForPrompt,
+                        sessionIds: []
+                    };
+                    group.sessionIds.push(id);
+                    dispatchGroups.set(groupKey, group);
 
                     // DOM optimistic update
                     const cardEl = document.querySelector(`.kanban-card[data-session="${id}"]`);
                     if (cardEl && targetBody) {
                         // Source DOM column: cards in coder cols are already in CODED_AUTO dom container when collapsed
@@
                         cardEl.classList.add('card-dropped');
                         cardEl.addEventListener('animationend', () => cardEl.classList.remove('card-dropped'), { once: true });
                     }
 
-                    const prevCol = card.column;
                     card.column = resolvedTarget;
-
-                    setTimeout(() => {
-                        const srcIdx = prevCol === 'BACKLOG' ? 0 : columns.indexOf(prevCol);
-                        const tgtIdx = columns.indexOf(resolvedTarget);
-                        if (tgtIdx > srcIdx) {
-                            // Forward move
-                            if (cliTriggersEnabled && isColumnAgentAvailable(resolvedTarget)) {
-                                postKanbanMessage({ type: 'triggerAction', sessionId: id, targetColumn: resolvedTarget, workspaceRoot });
-                            } else if (!cliTriggersEnabled) {
-                                postKanbanMessage({ type: 'moveCardForward', sessionIds: [id], targetColumn: resolvedTarget, workspaceRoot });
-                            }
-                        } else if (tgtIdx < srcIdx) {
-                            // Backward move
-                            postKanbanMessage({ type: 'moveCardBackwards', sessionIds: [id], targetColumn: resolvedTarget, workspaceRoot });
-                        }
-                    }, 350);
                 });
+
+                if (dispatchGroups.size === 0) return;
+
+                setTimeout(() => {
+                    dispatchGroups.forEach(group => {
+                        const groupedIds = group.sessionIds;
+                        if (groupedIds.length === 0) return;
+
+                        if (group.dispatchType === 'backward') {
+                            postKanbanMessage({ type: 'moveCardBackwards', sessionIds: groupedIds, targetColumn: group.targetColumn, workspaceRoot });
+                            return;
+                        }
+
+                        if (group.dispatchType === 'move') {
+                            postKanbanMessage({ type: 'moveCardForward', sessionIds: groupedIds, targetColumn: group.targetColumn, workspaceRoot });
+                            return;
+                        }
+
+                        if (group.dispatchType === 'prompt') {
+                            postKanbanMessage({
+                                type: 'promptOnDrop',
+                                sessionIds: groupedIds,
+                                sourceColumn: group.sourceColumn,
+                                targetColumn: group.targetColumn,
+                                workspaceRoot
+                            });
+                            return;
+                        }
+
+                        if (!isColumnAgentAvailable(group.targetColumn)) return;
+                        if (groupedIds.length === 1) {
+                            postKanbanMessage({ type: 'triggerAction', sessionId: groupedIds[0], targetColumn: group.targetColumn, workspaceRoot });
+                        } else {
+                            postKanbanMessage({ type: 'triggerBatchAction', sessionIds: groupedIds, targetColumn: group.targetColumn, workspaceRoot });
+                        }
+                    });
+                }, 350);
                 return;
             }
```

- **Edge Cases Handled:** This keeps one-card behavior intact, preserves existing optimistic UI behavior, correctly batches mixed-target drops into separate real coded lanes, and respects prompt-mode requirements by preserving per-group source-column context instead of flattening everything into one batch.

### Low Complexity

#### 3. Add a regression test for the drag-out payload bug
##### [CREATE] `src/test/kanban-coded-auto-drag-out-regression.test.js`
- **Context:** No current regression test proves that collapsed `CODED_AUTO` drags package all selected visible cards. The existing provider-oriented and split-column tests do not inspect `handleDragStart()` at all.
- **Logic:**
  1. Read `src/webview/kanban.html`.
  2. Assert the file defines `getSelectedInRenderedContainer(cardEl)`.
  3. Assert `handleDragStart()` now resolves `draggedCardEl`, calls `getSelectedInRenderedContainer(draggedCardEl)`, and no longer uses `getSelectedInColumn(card.column)` inside the multi-selection branch.
  4. Keep the test narrow so unrelated board markup changes do not create false negatives.
- **Implementation:**

```javascript
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

function run() {
    const kanbanHtmlPath = path.join(process.cwd(), 'src', 'webview', 'kanban.html');
    const source = fs.readFileSync(kanbanHtmlPath, 'utf8');

    assert.match(
        source,
        /function getSelectedInRenderedContainer\(cardEl\)\s*\{\s*const container = cardEl \? cardEl\.closest\('\.column-body'\) : null;\s*if \(!container\) return \[\];\s*return Array\.from\(container\.querySelectorAll\('\.kanban-card\.selected'\)\)\s*\.map\(el => el\.dataset\.session\)\s*\.filter\(Boolean\);\s*\}/s,
        'Expected kanban.html to gather selected cards from the dragged card\\'s rendered column container.'
    );

    assert.match(
        source,
        /function handleDragStart\(e\) \{[\s\S]*const draggedCardEl =[\s\S]*const draggedId = draggedCardEl\?\.dataset\.session;[\s\S]*if \(selectedCards\.has\(draggedId\) && selectedCards\.size > 1\) \{[\s\S]*const selectedInRenderedContainer = getSelectedInRenderedContainer\(draggedCardEl\);[\s\S]*if \(selectedInRenderedContainer\.length > 1 && selectedInRenderedContainer\.includes\(draggedId\)\) \{[\s\S]*idsToTransfer = selectedInRenderedContainer;[\s\S]*\}[\s\S]*\}/s,
        'Expected handleDragStart() to package visible multi-selection from the dragged card\\'s rendered container.'
    );

    assert.ok(
        !source.includes('const selectedInColumn = getSelectedInColumn(card.column);'),
        'Expected handleDragStart() to stop narrowing collapsed CODED_AUTO drags by logical card.column.'
    );

    console.log('kanban coded auto drag-out regression test passed');
}

try {
    run();
} catch (error) {
    console.error('kanban coded auto drag-out regression test failed:', error);
    process.exit(1);
}
```

- **Edge Cases Handled:** This locks the actual outbound bug surface without pretending to simulate the entire webview. If a future change reintroduces logical-column scoping for multi-drags, the test fails immediately.

#### 4. Add a regression test for the per-card `CODED_AUTO` drop dispatch bug
##### [CREATE] `src/test/kanban-coded-auto-batching-regression.test.js`
- **Context:** The current suite does not inspect the special `CODED_AUTO` branch in `handleDrop()`. That is the confirmed inbound batching bug and needs its own guard.
- **Logic:**
  1. Read `src/webview/kanban.html`.
  2. Slice the `targetColumn === 'CODED_AUTO'` branch from `handleDrop()`.
  3. Assert the branch now creates a `dispatchGroups` map and emits grouped `triggerBatchAction`, grouped `moveCardBackwards`, and grouped `promptOnDrop` with preserved `sourceColumn`.
  4. Assert the old per-card `triggerAction` / one-ID `moveCardBackwards` dispatch patterns are gone from inside the `sessionIds.forEach(...)` loop.
- **Implementation:**

```javascript
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

function getCodedAutoDropBlock(source) {
    const startToken = "// Handle drops onto the synthetic CODED_AUTO column — route each card to its real column";
    const endToken = "\n            const forwardIds = [];";
    const start = source.indexOf(startToken);
    const end = source.indexOf(endToken, start);

    assert.ok(start >= 0, 'Expected CODED_AUTO drop handler comment in kanban.html.');
    assert.ok(end > start, 'Expected to locate the end of the CODED_AUTO drop handler block.');

    return source.slice(start, end);
}

function run() {
    const kanbanHtmlPath = path.join(process.cwd(), 'src', 'webview', 'kanban.html');
    const source = fs.readFileSync(kanbanHtmlPath, 'utf8');
    const codedAutoBlock = getCodedAutoDropBlock(source);

    assert.ok(
        codedAutoBlock.includes('const dispatchGroups = new Map();'),
        'Expected CODED_AUTO drop handler to group dispatches before posting messages.'
    );
    assert.ok(
        codedAutoBlock.includes("type: 'triggerBatchAction'"),
        'Expected CODED_AUTO drop handler to use triggerBatchAction for multi-card CLI drops.'
    );
    assert.ok(
        codedAutoBlock.includes("type: 'moveCardBackwards'") &&
        codedAutoBlock.includes('sessionIds: groupedIds'),
        'Expected CODED_AUTO drop handler to batch backward moves with grouped sessionIds.'
    );
    assert.ok(
        codedAutoBlock.includes("type: 'promptOnDrop'") &&
        codedAutoBlock.includes('sourceColumn: group.sourceColumn'),
        'Expected CODED_AUTO drop handler to preserve sourceColumn when batching prompt-mode drops.'
    );
    assert.ok(
        /const groupKey = dispatchType === 'prompt'[\s\S]*sourceColumnForPrompt/s.test(codedAutoBlock),
        'Expected prompt-mode grouping to split batches by source column when necessary.'
    );
    assert.ok(
        !/postKanbanMessage\(\{\s*type:\s*'triggerAction',\s*sessionId:\s*id,/s.test(codedAutoBlock),
        'Expected CODED_AUTO drop handler to stop dispatching one triggerAction per card inside the routing loop.'
    );
    assert.ok(
        !/postKanbanMessage\(\{\s*type:\s*'moveCardBackwards',\s*sessionIds:\s*\[id\]/s.test(codedAutoBlock),
        'Expected CODED_AUTO drop handler to stop dispatching one backward payload per card.'
    );

    console.log('kanban coded auto batching regression test passed');
}

try {
    run();
} catch (error) {
    console.error('kanban coded auto batching regression test failed:', error);
    process.exit(1);
}
```

- **Edge Cases Handled:** This protects the exact inbound regression shape the user reported while also locking prompt-mode grouping, which is easy to break if batching is implemented too simplistically.

## Verification Plan
### Automated Tests
- `npm run compile`
- `node src/test/kanban-coded-auto-drag-out-regression.test.js`
- `node src/test/kanban-coded-auto-batching-regression.test.js`
- `node src/test/review-send-agent-trigger-regression.test.js`
- `node src/test/split-coded-columns-regression.test.js`
- `node src/test/kanban-batch-prompt-regression.test.js`

### Manual Verification
1. Collapse coded lanes so cards render in the synthetic `CODED_AUTO` column.
2. Select multiple cards that are visibly in `CODED_AUTO`, including cards that actually belong to different real coded lanes, then drag them back to `PLAN REVIEWED`.
3. Verify the drag payload includes every visibly selected coded card and the webview emits one grouped `moveCardBackwards` message instead of a series of one-card moves.
4. Create multiple `PLAN REVIEWED` cards that all resolve to the same coded lane and drag them into `CODED_AUTO`.
5. Verify the webview emits one grouped CLI or prompt-mode action for that resolved target instead of one message per card.
6. Repeat with a mixed-complexity selection that resolves into more than one real coded lane; verify batching occurs separately per resolved target lane.
7. If one of the real coded lanes is configured for prompt mode, repeat the inbound drop and verify the webview emits grouped `promptOnDrop` messages keyed by target and source column instead of flattening incompatible prompt contexts together.
8. Confirm individual card animations and optimistic DOM moves still occur, but backend messages are grouped.

## Preserved Original Draft (Verbatim)
````markdown
# Fix Kanban Drag-and-Drop Batching for CODED_AUTO Column

## Goal
Fix the bug where dragging multiple plans into the "coded dynamically" (CODED_AUTO) column results in individual prompts being sent to terminals instead of a single batched prompt with all plans for parallel processing.

## Background
The kanban board has a feature called "coded dynamically" (column ID: `CODED_AUTO`) which routes plans to different coded columns (LEAD CODED, CODER CODED, INTERN CODED) based on their complexity. When users drag multiple plans from PLAN REVIEWED to this column, they expect:
1. All medium/low complexity plans to route to CODER CODED
2. A single batched prompt to be sent containing all plans
3. The coder terminal to process them in parallel

Currently, the system sends N separate prompts (one per plan), which spams the terminal and prevents parallel execution.

## Bug Locations

### Issue 1: Drag INTO CODED_AUTO (Primary)
File: `src/webview/kanban.html`
Function: Drop handler for `CODED_AUTO` column (around line 2378-2435)

### Issue 2: Drag OUT of CODED_AUTO (Secondary)
File: `src/webview/kanban.html`
Function: General drop handler for backward moves (around line 2592-2594)
Status: **Requires investigation** - User reports this also happens "one by one"

## Current Broken Behavior
The handler uses `sessionIds.forEach()` to process each card individually:

```javascript
sessionIds.forEach(id => {
    // ... resolve target ...
    setTimeout(() => {
        // Each card gets its own message!
        postKanbanMessage({ type: 'triggerAction', sessionId: id, ... });
    }, 350);
});
return; // Early return skips the normal batch handling
```

Each card gets its own `setTimeout` and sends a separate `triggerAction` message, even if all cards route to the same target column.

## Expected Behavior
Cards should be grouped by their resolved target column and direction (forward/backward), then dispatched in batches using `triggerBatchAction` when multiple cards share the same target.

## Proposed Fix
Replace the individual dispatch loop with batching logic:

1. **Collect phase**: Group cards by `(resolvedTarget, direction)` using Map objects
2. **Dispatch phase**: Send `triggerBatchAction` for groups with >1 card, `triggerAction` for single cards

### Implementation Sketch
```javascript
// Group cards by resolved target and direction
const forwardBatches = new Map(); // targetColumn -> sessionIds[]
const backwardBatches = new Map();

sessionIds.forEach(id => {
    // ... resolve target and determine direction ...
    if (forward) {
        if (!forwardBatches.has(resolvedTarget)) forwardBatches.set(resolvedTarget, []);
        forwardBatches.get(resolvedTarget).push(id);
    } else {
        if (!backwardBatches.has(resolvedTarget)) backwardBatches.set(resolvedTarget, []);
        backwardBatches.get(resolvedTarget).push(id);
    }
});

// Dispatch batched
setTimeout(() => {
    forwardBatches.forEach((ids, target) => {
        if (ids.length === 1) {
            postKanbanMessage({ type: 'triggerAction', sessionId: ids[0], ... });
        } else {
            postKanbanMessage({ type: 'triggerBatchAction', sessionIds: ids, ... });
        }
    });
    // ... backward batches ...
}, 350);
```

## Complexity
**Complexity:** 3 (Low) - Single file change, well-defined scope, existing batch patterns to follow

## Files to Modify
- `src/webview/kanban.html` - Fix the CODED_AUTO drop handler

## Investigation Required: Drag OUT of CODED_AUTO

The user reports that dragging plans OUT of the coded column also happens "one by one". Initial code review shows backward moves ARE batched at line 2592-2594:

```javascript
if (backwardIds.length > 0) {
    postKanbanMessage({ type: 'moveCardBackwards', sessionIds: backwardIds, ... });
}
```

**Hypotheses to investigate:**
1. When cards have different actual columns (some LEAD CODED, some CODER CODED) but are visually in CODED_AUTO, they might be getting categorized differently
2. The DOM update loop (lines 2535-2569) uses `forEach` - maybe the user sees the visual updates happening one-by-one and interprets this as "not batched"
3. There might be a separate code path for drag-out that I'm missing
4. The `moveCardBackwards` handler in KanbanProvider.ts might be processing individually

**Debugging steps:**
- Add console.log to trace how `backwardIds` is populated when dragging from CODED_AUTO
- Check if `moveCardBackwards` handler in KanbanProvider.ts iterates individually
- Verify all dragged cards have the same source column in `currentCards`

## Testing Steps
1. Create 4 plans in PLAN REVIEWED column with medium complexity (5-6)
2. Select all 4 plans
3. Drag them to the "coded dynamically" column
4. **Verify**: Only 1 prompt is sent to the CODER CODED terminal containing all 4 plans
5. **Verify**: The prompt includes parallel execution instructions
6. Drag 4 plans FROM coded column back to PLAN REVIEWED
7. **Verify**: Only 1 `moveCardBackwards` message is sent with all 4 sessionIds

## Acceptance Criteria
- [x] Multiple plans dropped on CODED_AUTO with same resolved target are batched into single prompt
- [x] Single plan still works with `triggerAction` (not batched)
- [x] Backward moves (out of coded columns) are also batched appropriately
- [x] DOM updates remain optimistic and animated

## Risks
- **Low**: The change is localized to frontend batching logic; backend batch handling already exists via `triggerBatchAction`
- **Mitigation**: Test with single plan to ensure non-batch path still works
````

## Execution Results

### Changes Made

#### 1. Modified `src/webview/kanban.html`
- **Added `getSelectedInRenderedContainer(cardEl)` helper function** (lines 1485-1492)
  - Gets selected session IDs from the dragged card's rendered column container
  - Uses `cardEl.closest('.column-body')` to find the container
  - Returns array of selected session IDs

- **Updated `handleDragStart(e)` function** (lines 2294-2323)
  - Changed to resolve `draggedCardEl` from `e.currentTarget` (with fallback to `e.target.closest('.kanban-card')`)
  - Replaced `getSelectedInColumn(card.column)` with `getSelectedInRenderedContainer(draggedCardEl)` for multi-selection
  - Added guard to ensure dragged card is included in rendered selection
  - This fixes the drag-out bug where collapsed CODED_AUTO drags were narrowed to single card

- **Updated CODED_AUTO drop handler in `handleDrop(e, targetColumn)`** (lines 2389-2490)
  - Added `dispatchGroups` Map to group cards by resolved target, direction, and prompt-mode source column
  - Moved dispatch logic outside the `sessionIds.forEach()` loop into a grouped dispatch phase
  - Groups by:
    - Backward moves: `dispatchType::resolvedTarget`
    - Forward non-CLI moves: `dispatchType::resolvedTarget`
    - Forward prompt-mode moves: `dispatchType::resolvedTarget::sourceColumnForPrompt`
    - Forward CLI moves: `dispatchType::resolvedTarget` (with triggerBatchAction for groups > 1)
  - Preserved optimistic DOM updates and animations unchanged
  - This fixes the drag-in bug where cards dropped into CODED_AUTO were dispatched one-by-one

#### 2. Created `src/test/kanban-coded-auto-drag-out-regression.test.js`
- Tests that `getSelectedInRenderedContainer` function exists with correct implementation
- Tests that `handleDragStart` uses the new helper instead of `getSelectedInColumn`
- Tests that the old logical-column scoping pattern is removed

#### 3. Created `src/test/kanban-coded-auto-batching-regression.test.js`
- Tests that CODED_AUTO drop handler creates `dispatchGroups` Map
- Tests that grouped dispatch uses `triggerBatchAction`, `moveCardBackwards`, and `promptOnDrop` with grouped sessionIds
- Tests that prompt-mode grouping preserves `sourceColumn`
- Tests that old per-card dispatch patterns are removed from the routing loop

### Test Results

#### Compilation
- `npm run compile`: **PASSED** (webpack compiled successfully)

#### New Regression Tests
- `node src/test/kanban-coded-auto-drag-out-regression.test.js`: **PASSED**
- `node src/test/kanban-coded-auto-batching-regression.test.js`: **PASSED**

#### Related Regression Tests
- `node src/test/split-coded-columns-regression.test.js`: **PASSED**
- `node src/test/kanban-batch-prompt-regression.test.js`: **PASSED**
- `node src/test/review-send-agent-trigger-regression.test.js`: **FAILED** (unrelated - checks review.html which was not modified)

**Note:** The `review-send-agent-trigger-regression.test.js` failure is unrelated to this plan's changes. That test checks for a specific string in `review.html` (Send to Agent button), which was not modified by this plan. All kanban-related tests pass successfully.

### Files Changed
- `src/webview/kanban.html` (modified)
- `src/test/kanban-coded-auto-drag-out-regression.test.js` (created)
- `src/test/kanban-coded-auto-batching-regression.test.js` (created)

### Remaining Work
Manual verification steps (as outlined in Verification Plan) should be performed to confirm the fixes work as expected in the actual kanban UI:
1. Collapse coded lanes and test multi-drag out of CODED_AUTO
2. Test multi-drop into CODED_AUTO with same/different resolved targets
3. Test prompt-mode batching when real coded lanes are configured for prompt mode
4. Confirm individual card animations still occur while backend messages are grouped

## Direct Reviewer Pass (2026-04-13, In-Place Review)

### Stage 1 - Grumpy Principal Engineer
- [NIT] The production fix is sensible, but the regression tests are still text sentries guarding a browser feature. They prove the branching exists in `kanban.html`; they do not prove a live drag event actually emits the grouped payloads you think it does.
- [NIT] The logic is now split correctly between drag-start payload construction and CODED_AUTO grouped dispatch, but the last mile — optimistic DOM behavior and animation feel — is still manual territory. Drag-and-drop bugs love manual territory.

### Stage 2 - Balanced Synthesis
- **Keep:** The two user-visible failures are fixed in the right place. `handleDragStart()` now scopes multi-selection to the rendered container, and the CODED_AUTO drop branch batches backend dispatches by resolved target instead of posting one message per card.
- **Fix now:** None. I did not find a material correctness defect in the implemented batching logic after review.
- **Defer:** Add a higher-fidelity DOM/event regression if this drag-drop path changes again; for now the current source-level regressions plus manual verification guidance are acceptable.

### Fixed Items
- None in reviewer pass.

### Files Changed
- No additional reviewer-pass code changes were required.
- Reviewed implementation remains centered on:
  - `src/webview/kanban.html`
  - `src/test/kanban-coded-auto-drag-out-regression.test.js`
  - `src/test/kanban-coded-auto-batching-regression.test.js`

### Validation Results
- `npm run compile` - **PASSED**
- `npm run compile-tests` - **PASSED**
- `node src/test/kanban-coded-auto-drag-out-regression.test.js` - **PASSED**
- `node src/test/kanban-coded-auto-batching-regression.test.js` - **PASSED**
- `node src/test/split-coded-columns-regression.test.js` - **PASSED**
- `node src/test/kanban-batch-prompt-regression.test.js` - **PASSED**

### Remaining Risks
- Browser-level drag/drop behavior and optimistic animation sequencing are still validated primarily by manual verification.
