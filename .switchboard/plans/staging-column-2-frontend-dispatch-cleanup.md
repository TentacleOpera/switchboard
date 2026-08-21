# STAGING column — frontend DISPATCH cleanup and drag-into-STAGING routing

## Goal

> **Continuation note:** This plan picks up from `staging-column-replaces-dispatch-view.md` (Session 1), which completed all backend work (Phases 1-3) and partially completed the frontend (Phase 4-6). The backend is done — `_getNextColumnId` skip logic, `appendQueuePositions` retarget, `_runQueuePop` filter, complexity routing extension, all comment updates. This plan is frontend-only: `kanban.html` drag-drop handlers, `getNextColumn` skip, `btn-stage-for-queue` removal, and the drag-into-STAGING routing that was never implemented. Do NOT redo any backend work.

Finish the DISPATCH → STAGING migration in `kanban.html`: remove all remaining `showingDispatch` references and DISPATCH column references in drag-drop handlers, add frontend `getNextColumn` skip logic for STAGING, remove the STAGE FOR QUEUE button, route drag-into-STAGING through `stageForQueue`, and re-point the queue reorder handler at STAGING.

### Problem Analysis

Session 1 of the STAGING migration completed the backend (Phases 1-3) and partially completed the frontend (Phase 4-6). The coder removed the `showingDispatch` state variable declaration and several usage sites, but ~7 `showingDispatch` references remain in drag-drop handlers — these are now dead references to a variable that no longer exists, causing ReferenceError at runtime. Additionally, ~10 DISPATCH column references remain in drag-drop code paths that must be removed or retargeted to STAGING.

The drag-into-STAGING routing (Amendment A from the original plan) was never implemented: a drag drop into STAGING currently lands in the generic `moveCardToColumn` path, which sets the column but does NOT assign `queue_position`, does NOT refuse subtasks, and does NOT arm the stall watch. The reorder handler (Amendment C) is still gated on the deleted `showingDispatch` variable, making it unreachable.

### Root Cause

The original plan was a mega-plan (8 phases, 42 steps) that should have been split. The coder burned its context window partway through the frontend changes, leaving a partially-complete state removal that introduces runtime errors.

## Metadata

**Complexity:** 5
**Tags:** frontend, ui, refactor, bugfix
**Project:** Browser Switchboard

## User Review Required

None.

## Complexity Audit

### Routine
- Removing dead `showingDispatch` references (find-and-delete)
- Removing DISPATCH column references in drag-drop index calculations
- Removing `btn-stage-for-queue` button and handler
- Updating run sheet display (DISPATCH → STAGING)
- Updating comments

### Complex / Risky
- **Drag-into-STAGING routing through `stageForQueue`** — the drop handler must detect STAGING as the target and post `stageForQueue` instead of the generic column-move message. This is new conditional logic in the drop handler, not a find-and-replace. Must handle: single-card drag, multi-card drag, subtask refusal (backend handles this, but the frontend must post the right message type).
- **Reorder handler re-pointing** — the same-column drag reorder gate must change from `showingDispatch && effectiveTargetColumn === 'DISPATCH'` to `effectiveTargetColumn === 'STAGING'`. The reorder logic itself (building ordered id list, optimistic DOM reorder, posting `reorderQueue`) stays as-is — only the gate condition changes. But the gate is embedded in a function with other DISPATCH references that must be removed simultaneously.
- **Frontend `getNextColumn` skip for STAGING** — currently a pure index walk (`columns[idx + 1]`). Must skip columns with no role. STAGING is now a real column in `columns[]`, so without this fix, advancing from any column before STAGING lands cards in STAGING instead of the coder columns.

## Edge-Case & Dependency Audit

- **`showingDispatch` is already removed as a variable** — the remaining references will throw ReferenceError at runtime. This is a bug introduced by the partial cleanup, not a pre-existing condition. All references must be removed, not just commented out.
- **STAGING drag from PLAN REVIEWED** — a card dragged from PLAN REVIEWED to STAGING should call `stageForQueue`, which moves the card to STAGING AND assigns `queue_position`. The generic move path would set the column but leave `queue_position = NULL`.
- **STAGING drag from other columns** — a card dragged from CREATED or RESEARCHER to STAGING should also call `stageForQueue`. The `_resolveStageablePlanIds` backend function already handles stageability checks (refuses subtasks, refuses already-dispatched plans).
- **STAGING drag to another column** — a card dragged FROM STAGING to a coder column should use the generic move path (not `stageForQueue`). The `moveCardToColumnWithReason` backend already clears `queue_position` on exit from STAGING.
- **Reorder only meaningful with positions** — if `stageForQueue` is not called on drag-in (the bug this plan fixes), cards arrive with `queue_position = NULL` and all sort last together. Reorder is meaningless without positions. This plan fixes both: drag-in assigns positions (step 3), reorder re-points to STAGING (step 4).
- **`getNextColumn` callers** — `getNextColumn` is called from: advance button handler (line ~7828), prompt-selected handler (line ~8774), copy-prompt label derivation (line ~9015). All three must skip STAGING. The backend `_getNextColumnId` already has the skip logic (completed in Session 1).

## Dependencies

- Depends on: `staging-column-replaces-dispatch-view.md` (Session 1 — backend + column definition + partial frontend). Must be completed first.

## Adversarial Synthesis

Key risks: (1) Dead `showingDispatch` references cause runtime errors — must be fully removed, not partially patched. (2) Drag-into-STAGING routing is new logic, not find-and-replace — the drop handler must intercept STAGING targets before the generic move path fires. (3) The reorder handler and the DISPATCH display-mode removal are in the same function and must be done together — splitting them would leave the function in a broken intermediate state. Mitigations: all changes are in one file (kanban.html), the drop handler already has precedent for special-casing column targets (CODED_AUTO), and the reorder logic itself is unchanged (only the gate condition moves).

## Proposed Changes

### `src/webview/kanban.html`

**Step 1: Remove all remaining `showingDispatch` references.**

The following sites reference `showingDispatch` which no longer exists as a variable. Each must be removed or rewritten:

- **Line ~8986:** Card-level "→ Planned" button — the `showingDispatch && card.column === 'DISPATCH'` arm. Remove this arm entirely. STAGING cards don't need a "→ Planned" button (the user can drag them back).
- **Line ~9339:** Source DOM column resolution in `moveCardElements` — `(card.column === 'DISPATCH' && showingDispatch ? 'PLAN REVIEWED' : card.column)`. Remove the DISPATCH case. STAGING is a real column, so `card.column` resolves directly.
- **Lines ~9394-9396:** `effectiveTargetColumn` mapping — `(showingDispatch && targetColumn === 'PLAN REVIEWED') ? 'DISPATCH' : targetColumn`. Remove the DISPATCH mapping. STAGING is a real column — no mapping needed.
- **Lines ~9491-9494:** Source DOM column for empty-state check — `(card.column === 'DISPATCH' && showingDispatch) ? 'PLAN REVIEWED' : card.column`. Remove DISPATCH case.
- **Lines ~9566-9569:** Source DOM column in multi-card move — `(card && card.column === 'DISPATCH' && showingDispatch) ? 'PLAN REVIEWED' : ...`. Remove DISPATCH case.

**Step 2: Remove remaining DISPATCH column references in drag-drop handlers.**

- **Lines ~8930-8935:** Copy-prompt DISPATCH resolution — `if (sourceColumn === 'DISPATCH') { sourceColumn = 'PLAN REVIEWED'; }`. Remove entirely. STAGING is a real column in `columns[]`, so `getNextColumn('STAGING')` works directly (after step 5 adds the skip logic).
- **Lines ~8974-8977:** Comment about DISPATCH being an ordered session queue. Update comment to reference STAGING.
- **Lines ~9457-9461:** Source column index DISPATCH mapping — `card.column === 'DISPATCH' ? 'PLAN REVIEWED' : card.column`. Remove DISPATCH case. STAGING is a real column — use `card.column` directly.
- **Line ~10904:** Stage-for-queue comment — "already in DISPATCH (re-positioning)". Update to STAGING.
- **Lines ~11921-11923:** Run sheet display — `{ sourceColumn: 'DISPATCH', headRole: 'coding' }`. Change to `'STAGING'`. Also update the comment at line ~11921.

**Step 3: Route drag-into-STAGING through `stageForQueue`.**

In the drop handler (around line ~9452, after the reorder gate and before the generic `sessionIds.forEach` loop), add a conditional:

```javascript
// STAGING is a queue, not a plain column — route drops through stageForQueue
// so cards get queue_position, subtask refusal, and stall-watch arming.
if (effectiveTargetColumn === 'STAGING') {
    const stagedIds = sessionIds.filter(id => {
        const card = currentCards.find(c => (c.planId || c.sessionId) === id);
        return card && card.column !== 'STAGING'; // skip cards already in STAGING
    });
    if (stagedIds.length > 0) {
        postKanbanMessage({ type: 'stageForQueue', sessionIds: stagedIds, workspaceRoot });
    }
    // Optimistic DOM move for visual feedback
    stagedIds.forEach(id => { /* move card element to STAGING column body */ });
    document.querySelectorAll('.kanban-card.selected').forEach(el => el.classList.remove('selected'));
    selectedCards.clear();
    updateReassignButtonVisibility();
    updateFeatureActionButton();
    return; // do not fall through to generic column-move path
}
```

This must be placed BEFORE the generic `sessionIds.forEach` loop that calls `moveCardToColumn`. The `stageForQueue` backend handler (KanbanProvider.ts:12044) already handles subtask refusal and reports refused count.

**Step 4: Re-point the reorder drop path at STAGING.**

Change the reorder gate (line ~9408) from:
```javascript
if (showingDispatch && effectiveTargetColumn === 'DISPATCH') {
```
to:
```javascript
if (effectiveTargetColumn === 'STAGING') {
```

Then update the draggedIds filter (line ~9411) from `card.column === 'DISPATCH'` to `card.column === 'STAGING'`.

The rest of the reorder logic (building ordered id list, optimistic DOM reorder, posting `reorderQueue`) stays as-is. Update the comment at line ~9416 from "DISPATCH cards" to "STAGING cards".

**Step 5: Add frontend `getNextColumn` skip logic for STAGING.**

Change `getNextColumn` (line ~7113) from:
```javascript
function getNextColumn(col) {
    const idx = columns.indexOf(col);
    if (idx < 0 || idx >= columns.length - 1) return null;
    return columns[idx + 1];
}
```
to:
```javascript
function getNextColumn(col) {
    const idx = columns.indexOf(col);
    if (idx < 0 || idx >= columns.length - 1) return null;
    // Skip columns with no dispatch role (e.g. STAGING — a queue, not a coding seat).
    // Advancing from any column must land on the next role-bearing column, not a queue.
    for (let i = idx + 1; i < columns.length; i++) {
        const def = columnDefinitions.find(d => d.id === columns[i]);
        if (def && !def.role && def.kind !== 'completed') continue; // skip role-less non-terminal columns
        return columns[i];
    }
    return null;
}
```

Verify: `getNextColumn('PLAN REVIEWED')` returns the first coder column (LEAD CODED), not STAGING. `getNextColumn('RESEARCHER')` returns LEAD CODED, not STAGING. `getNextColumn('CREATED')` returns PLAN REVIEWED, not STAGING.

**Step 6: Remove `btn-stage-for-queue` button and handler.**

- Remove the button from the sub-bar HTML (line ~3021).
- Remove the click event handler (line ~13415).
- Remove the stage-button visibility check (line ~10907) that enables/disables the button based on selection.

The `stageForQueue` verb handler in the backend stays — it is now called by the drag-into-STAGING path (step 3) and the remote control dep.

**Step 7: Verify no `showingDispatch` or DISPATCH column references remain in kanban.html.**

After all changes, grep for `showingDispatch` and `DISPATCH` (as a column name, not as UI text like "DISPATCHED") in `kanban.html`. The only acceptable remaining matches are:
- Comments explaining what was removed (if any)
- The `dispatchAnalyze` action name (this is a button action, not a column reference — it stays)

## Verification Plan

### Manual Verification

1. **No runtime errors** — Open the kanban board. No ReferenceError in console. All columns render.
2. **STAGING column visible** — STAGING appears between RESEARCHER and LEAD CODED.
3. **Advance from CREATED** — Click advance on CREATED. Card goes to PLAN REVIEWED, NOT to STAGING.
4. **Advance from RESEARCHER** — Click advance on RESEARCHER. Card goes to LEAD CODED, NOT to STAGING.
5. **Drag into STAGING** — Drag a card from PLAN REVIEWED to STAGING. Card moves, receives a `queue_position` (check via query-kanban skill), and the stall watch arms. No agent triggers.
6. **Drag subtask into STAGING** — Drag a subtask (featureId set) into STAGING. Backend refuses it with a reason. Card stays in original column.
7. **Reorder within STAGING** — Put 3 cards in STAGING. Drag the bottom card above the top card. `queue_position` is rewritten. Run queue pops in the new order.
8. **Run queue from STAGING** — Put cards in STAGING, ensure a coding terminal is live, click "Run queue" — first card dispatches to coder, completion pulls next.
9. **No STAGE FOR QUEUE button** — The sub-bar no longer has a STAGE FOR QUEUE button.
10. **Run sheet display** — The autoban run sheet (if visible) shows STAGING, not DISPATCH.

### Automated Tests

- `getNextColumn('PLAN REVIEWED')` returns first coder column, not STAGING
- `getNextColumn('RESEARCHER')` returns LEAD CODED, not STAGING
- `getNextColumn('CREATED')` returns PLAN REVIEWED, not STAGING
- Grep assertion: no `showingDispatch` references in kanban.html
- Grep assertion: no `DISPATCH` column references in kanban.html (excluding `dispatchAnalyze` action name and comments)

> **Note:** Per session directives, compilation and automated tests are NOT executed during this planning run.

---

## Completion Report

Implemented all 7 steps in `src/webview/kanban.html` (frontend-only, no backend changes). Removed all 6 `showingDispatch` references and all DISPATCH column references from drag-drop handlers, `effectiveTargetColumn` mapping, source DOM column resolution, copy-prompt resolution, and the run sheet display. Re-pointed the reorder gate from `showingDispatch && effectiveTargetColumn === 'DISPATCH'` to `effectiveTargetColumn === 'STAGING'`, and added a combined STAGING drop handler that routes cross-column drops through `stageForQueue` (with optimistic DOM move) while same-column drops still trigger `reorderQueue`. Added `getNextColumn` skip logic that skips role-less non-terminal columns (STAGING). Removed the `btn-stage-for-queue` button HTML, its click handler, and its visibility check in `updateReassignButtonVisibility`; also removed the now-dead `send-to-planned-btn` click handler. Grep verification confirms zero `showingDispatch` and zero `DISPATCH` matches remain. No issues encountered.
