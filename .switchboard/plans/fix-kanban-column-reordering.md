# Fix Kanban Column Reordering Bug

## Goal
Fix kanban setup tab column drag-and-drop so columns stay in their new position after being dropped, instead of snapping back to their original position.

## Metadata
- **Tags:** [bugfix, UI]
- **Complexity:** 3

## User Review Required
No — single-file bugfix with clear repro and verification.

## Problem
In the kanban.html setup tab, users can drag columns to reorder them, but the columns never lock into their new position. After dropping a column in a new location, it snaps back to its original position.

## Root Cause
Two compounding bugs in `reorderVisibleKanbanStructure()` at `@/Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/kanban.html:5604-5618`:

**Bug 1 — Filter mismatch (primary cause when hidden columns exist):**
The function filters by `!item.fixed` only (line 5606), including hidden columns in the reorder sequence. But the backend validation at `@/Users/patrickvuleta/Documents/GitHub/switchboard/src/services/TaskViewerProvider.ts:5557-5559` expects only **visible** reorderable columns:
```typescript
const reorderableIds = structure
    .filter((item) => item.reorderable && item.visible !== false)
    .map((item) => item.id);
```
When hidden columns exist (e.g., Context Gatherer, Intern Coded), the frontend sends a sequence with extra IDs. `_validateKanbanStructureSequence` at line 1325 throws because `normalized.length !== reorderableIds.length`. The update silently fails and the column snaps back.

The `setup.html` version at `@/Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/setup.html:2120-2122` correctly filters:
```javascript
const middleIds = renderable
    .filter(item => !item.fixed && item.visible !== false)
```

**Bug 2 — Race condition from redundant `getKanbanStructure` call:**
The frontend sends `updateKanbanStructure` then immediately `getKanbanStructure` (line 5615-5617). The `updateKanbanStructure` handler in KanbanProvider.ts (`@/Users/patrickvuleta/Documents/GitHub/switchboard/src/services/KanbanProvider.ts:5008-5015`) already awaits `handleUpdateKanbanStructure` then reads and sends the updated structure back. But the frontend's separate `getKanbanStructure` message is processed concurrently during the `updateState` 100ms batching window (`@/Users/patrickvuleta/Documents/GitHub/switchboard/src/services/TaskViewerProvider.ts:1041-1049`), reading stale data from disk and sending a stale `kanbanStructure` message that overwrites the correct one in the webview.

## Investigation
- Drag-and-drop handlers work correctly — user can drag and drop columns
- `reorderVisibleKanbanStructure()` sends `updateKanbanStructure` message with new sequence (line 5604 in kanban.html)
- KanbanProvider.ts handler (lines 5008-5015):
  1. Calls `handleUpdateKanbanStructure` to update state
  2. Then calls `handleGetKanbanStructure` to read structure
  3. Sends structure back to webview
- TaskViewerProvider.ts `handleUpdateKanbanStructure` (lines 5545-5593):
  1. Calls `updateState` to queue the state update
  2. `updateState` uses a 100ms timer to batch updates (line 1047)
  3. The actual disk write happens after the timer fires
- `handleGetKanbanStructure` reads from disk immediately, getting stale data before the queued update writes
- The filter `!item.fixed` at line 5606 includes hidden columns, but backend validation at line 5557-5559 only accepts visible reorderable columns — mismatch causes validation failure when hidden columns exist

## Complexity Audit
### Routine
- Remove redundant `getKanbanStructure` call (1 line deletion)
- Add `item.visible !== false` to filter (1 line change)
### Complex / Risky
- None

## Edge-Case & Dependency Audit
- **Race Conditions:** The redundant `getKanbanStructure` call creates a concurrent stale read during the `updateState` 100ms batching window. Fix: remove the call; the `updateKanbanStructure` handler already sends the updated structure.
- **Security:** No impact — kanban column ordering is a user preference, not security-sensitive.
- **Side Effects:** Removing `getKanbanStructure` means the webview relies solely on the `updateKanbanStructure` handler's response. This is correct — the handler already sends `kanbanStructure` after the update completes (KanbanProvider.ts lines 5012-5014).
- **Dependencies & Conflicts:** None. The `setup.html` version of this function already uses the correct filter and doesn't send a redundant `getKanbanStructure` call.

## Dependencies
None

## Adversarial Synthesis
Key risks: (1) Hidden-column filter mismatch causes silent validation failure — the primary snap-back trigger when any column is hidden. (2) Redundant `getKanbanStructure` call causes stale-data race. Mitigations: both fixes are single-line changes in the same function; the `setup.html` counterpart already implements the correct pattern, confirming the approach.

## Proposed Changes

### `/Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/kanban.html`
- **Context:** `reorderVisibleKanbanStructure` function at line 5604
- **Logic:** Two fixes in one function:
  1. Change filter from `!item.fixed` to `!item.fixed && item.visible !== false` to match backend validation expectations and the `setup.html` reference implementation
  2. Remove the redundant `postKanbanMessage({ type: 'getKanbanStructure' })` call — the `updateKanbanStructure` handler in KanbanProvider.ts already sends the updated structure back after the state update completes
- **Implementation:**

**Before (lines 5604-5618):**
```javascript
function reorderVisibleKanbanStructure(draggedId, targetId) {
    const renderable = getRenderableKanbanStructure();
    const middleIds = renderable.filter(item => !item.fixed).map(item => item.id);
    const fromIndex = middleIds.indexOf(draggedId);
    const toIndex = middleIds.indexOf(targetId);
    if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) return;

    const nextSequence = [...middleIds];
    const [movedId] = nextSequence.splice(fromIndex, 1);
    nextSequence.splice(toIndex, 0, movedId);

    postKanbanMessage({ type: 'updateKanbanStructure', sequence: nextSequence });
    // Reload from extension to get updated order
    postKanbanMessage({ type: 'getKanbanStructure' });
}
```

**After:**
```javascript
function reorderVisibleKanbanStructure(draggedId, targetId) {
    const renderable = getRenderableKanbanStructure();
    const middleIds = renderable.filter(item => !item.fixed && item.visible !== false).map(item => item.id);
    const fromIndex = middleIds.indexOf(draggedId);
    const toIndex = middleIds.indexOf(targetId);
    if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) return;

    const nextSequence = [...middleIds];
    const [movedId] = nextSequence.splice(fromIndex, 1);
    nextSequence.splice(toIndex, 0, movedId);

    postKanbanMessage({ type: 'updateKanbanStructure', sequence: nextSequence });
}
```

- **Edge Cases:** If all non-fixed columns are hidden, `middleIds` will be empty and the function returns early (existing guard at `fromIndex < 0`). No new edge cases introduced.

## Verification Plan
### Automated Tests
No automated tests exist for kanban.html webview drag-and-drop. Manual verification required.

### Manual Verification Steps
1. Open the kanban setup tab
2. Drag a non-fixed, visible column to a new position → verify it stays
3. Refresh the page → verify the order persists
4. Test that fixed columns (New, Completed) cannot be dragged
5. **Test with hidden columns:** Hide a built-in column (e.g., Context Gatherer), then drag another visible column → verify the reorder succeeds (this was the primary failure scenario)
6. Test that hidden columns cannot be dragged (existing behavior preserved)

## Notes
- The KanbanProvider.ts handler already sends the updated structure back to the webview after the state update completes (lines 5012-5014)
- The redundant `getKanbanStructure` call in the frontend was causing a race condition where it retrieved stale data
- The filter mismatch (`!item.fixed` vs `!item.fixed && item.visible !== false`) was causing silent validation failures when hidden columns existed — this was likely the primary cause of the snap-back in most real scenarios
- The `setup.html` reference implementation already uses the correct filter pattern, confirming this is the right fix
- No backend changes required — the extension logic is correct

---

**Recommendation:** Send to Coder (complexity ≤ 6)
