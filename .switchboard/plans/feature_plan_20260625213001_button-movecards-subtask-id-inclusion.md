# Fix: Button-Driven `moveCards` Send Sites Missing Subtask-ID Inclusion for Epic Cascades

## Goal

Extend the `_collectAllMovedSessionIds` helper (introduced in the epic-styling-lost-on-drag fix) to the remaining 16 button-driven `moveCards` send sites in `KanbanProvider.ts`. These sites currently pass only the directly-moved session IDs to the webview's `moveCards` delta, omitting subtask session IDs for epic cascade moves. This causes the same styling-loss bug as the drag-and-drop paths — but triggered by button clicks (Move Selected, Move All, Prompt Selected, Prompt All, Distribute Planner, Testing Failed) instead of drags.

### Problem

When a user clicks a button to move an epic card (e.g. "Move Selected Forward", "Move All Forward", "Prompt Selected"), the backend's `moveCardToColumn` cascades the move to all subtasks in the DB, but the `moveCards` delta sent to the webview only includes the epic's session ID. The webview's `currentCards` then has subtasks in the old column while the DB has them in the new column. The next `updateBoard` from a file watcher or scheduled refresh detects a signature mismatch and triggers a full `renderBoard`, which can race with pending messages and lose epic styling — the identical root cause documented in the parent plan.

### Root Cause Analysis

The parent plan (`feature_plan_20260625141328_epic-styling-lost-on-drag.md`) identified 21 total `moveCards` send sites and fixed 5 (the drag-and-drop paths). The remaining 16 are button-driven paths with the same latent bug. The `_collectAllMovedSessionIds` helper already exists and is proven correct — this plan is purely about applying it consistently.

The 16 sites fall into two categories:

**Category A — Sites with a `moveCardToColumn` loop (10 sites):**
These already iterate over session IDs calling `moveCardToColumn`. The helper can be called per-iteration (same pattern as the fixed `moveCardForward`/`moveCardBackwards` handlers), accumulating subtask IDs into the `moveCards` delta.

| Line | Handler | sessionIds var | Notes |
|------|---------|----------------|-------|
| 3661 | `_distributePlannerDispatch` (fallback) | `movedIds` | Already has `workspaceRoot` |
| 3702 | `_distributePlannerDispatch` (main) | `movedIds` | Already has `workspaceRoot` |
| 6052 | `case 'moveSelected'` | `movedSids` | Complexity routing sub-loop |
| 6116 | `case 'moveSelected'` | `movedIds` | Main forward loop |
| 6179 | `case 'moveAll'` | `movedSids` | Complexity routing sub-loop |
| 6245 | `case 'moveAll'` | `movedIds` | Main forward loop |
| 6360 | `case 'promptSelected'` | `sids` | Complexity routing sub-loop |
| 6372 | `case 'promptSelected'` | `msg.sessionIds` | Custom-user dispatch path |
| 6441 | `case 'promptAll'` | `sids` | Complexity routing sub-loop |
| 6462 | `case 'promptAll'` | `sessionIds` | Custom-user dispatch path |

**Category B — Sites WITHOUT a `moveCardToColumn` loop (6 sites):**
These either delegate to `dispatchConfiguredKanbanColumnAction` (which persists the move internally) or use `db.updateColumn` directly. The helper must be called after the move is persisted, collecting subtask IDs for each moved session.

| Line | Handler | sessionIds var | Notes |
|------|---------|----------------|-------|
| 4045 | `_postMoveCardsByTarget` (helper) | `sessionIds` (loop var) | No `workspaceRoot` in scope — needs parameter |
| 6075 | `case 'moveSelected'` | `msg.sessionIds` | No moveCardToColumn — direct delta |
| 6202 | `case 'moveAll'` | `sessionIds` | No moveCardToColumn — direct delta |
| 6342 | `case 'promptSelected'` | `msg.sessionIds` | Custom-user dispatch, no loop |
| 6419 | `case 'promptAll'` | `sessionIds` | Custom-user dispatch, no loop |
| 6924 | `case 'testingFailed'` | `msg.sessionIds` | Uses `db.updateColumn` directly |

## Metadata

- **Tags**: `bugfix`, `ui`, `ux`, `frontend`, `backend`, `tech-debt`
- **Complexity**: 3
- **Affected Files**: `src/services/KanbanProvider.ts`
- **Parent Plan**: `feature_plan_20260625141328_epic-styling-lost-on-drag.md` (Risk 1)

## Complexity Audit

### Routine
- The `_collectAllMovedSessionIds` helper already exists and is proven correct — no new logic needed.
- Category A sites (10) follow the exact same pattern as the already-fixed `moveCardForward`/`moveCardBackwards` handlers: call helper per-iteration, accumulate into an array, pass to `moveCards`.
- No schema changes, no new APIs, no migration needed.

### Complex / Risky
- **`_postMoveCardsByTarget` (line 4045)**: This is a generic helper that posts `moveCards` deltas for arbitrary `{sessionId, targetColumn}` pairs. It has no `workspaceRoot` in scope. Making it async and passing `workspaceRoot` changes its signature, which affects all callers. This is the only site requiring a signature change.
- **Category B sites without loops**: These don't call `moveCardToColumn`, so the helper must be called after the dispatch/persist completes. The timing matters — if the move hasn't been persisted yet, `getPlanBySessionId` still returns the correct `isEpic`/`epicId` (the helper only reads those fields, not the column), so this is safe.
- **`testingFailed` (line 6924)**: Uses `db.updateColumn` directly (not `moveCardToColumn`), so there's no epic cascade — subtasks are NOT moved. Including subtask IDs in the `moveCards` delta here would cause the webview to move subtask cards to `LEAD CODED` while the DB leaves them in their current column. This site should be **EXCLUDED** from the fix.

## Edge-Case & Dependency Audit

### Race Conditions
- Same race window as the parent plan: the `moveCards` delta vs `updateBoard` race. The `lastBoardSignature` fix from the parent plan covers the webview side. This plan only ensures the delta includes all affected IDs.

### Security
- No security implications.

### Side Effects
- **Subtask cards on the board**: Including subtask IDs in button-driven `moveCards` deltas will visually move subtask cards to the target column, matching the DB cascade. This is correct behavior.
- **`testingFailed` exclusion**: This site uses `db.updateColumn` (no cascade), so subtasks are NOT moved in the DB. Including subtask IDs would cause a webview/DB mismatch. This site must be excluded.
- **`_postMoveCardsByTarget` signature change**: Making this method async and adding a `workspaceRoot` parameter affects all callers. Need to audit callers.

### Dependencies & Conflicts
- Depends on the `_collectAllMovedSessionIds` helper from the parent plan (already merged).
- No conflicts with other in-flight changes expected — the fix is additive.

| Edge Case | Impact | Mitigation |
|-----------|--------|------------|
| `testingFailed` handler (line 6924) | Uses `db.updateColumn` (no cascade) — subtasks NOT moved in DB | **EXCLUDE** this site from the fix |
| `_postMoveCardsByTarget` (line 4045) | No `workspaceRoot` in scope | Add `workspaceRoot` parameter; make method async; update all callers |
| Epic with 0 subtasks | `moveCards` delta includes only epic ID | No change needed — empty subtask array handled |
| Non-epic card moved via button | Helper returns `[sessionId]` — same as today | No change in behavior |

## Dependencies

- **Parent plan**: `feature_plan_20260625141328_epic-styling-lost-on-drag.md` must be merged first (provides the `_collectAllMovedSessionIds` helper).

## Proposed Changes

### 1. Category A — Sites with `moveCardToColumn` loops (10 sites)

For each of these sites, follow the pattern already established in `moveCardForward`/`moveCardBackwards`:

```ts
// Before each moveCards post, accumulate subtask IDs:
const allMovedIds: string[] = [];
for (const sid of sessionIds) {
    await this.moveCardToColumn(workspaceRoot, sid, targetColumn);
    // ... existing per-iteration logic ...
    const movedIds = await this._collectAllMovedSessionIds(workspaceRoot, sid);
    allMovedIds.push(...movedIds);
}
this._panel?.webview.postMessage({ type: 'moveCards', sessionIds: allMovedIds, targetColumn });
```

**Sites to update** (line numbers are current, may shift during editing — match by handler name and context):

1. **`_distributePlannerDispatch` fallback (line 3661)**: Accumulate `allMovedIds` in the existing loop, replace `movedIds` in the `moveCards` post.
2. **`_distributePlannerDispatch` main (line 3702)**: Same pattern.
3. **`case 'moveSelected'` complexity routing (line 6052)**: Accumulate `allMovedSids` in the inner `sids` loop, replace `movedSids` in the `moveCards` post.
4. **`case 'moveSelected'` main forward (line 6116)**: Accumulate `allMovedIds` in the existing loop, replace `movedIds`.
5. **`case 'moveAll'` complexity routing (line 6179)**: Same as #3.
6. **`case 'moveAll'` main forward (line 6245)**: Same as #4.
7. **`case 'promptSelected'` complexity routing (line 6360)**: Same as #3.
8. **`case 'promptSelected'` custom-user dispatch (line 6372)**: After `dispatchConfiguredKanbanColumnAction`, collect IDs per session.
9. **`case 'promptAll'` complexity routing (line 6441)**: Same as #3.
10. **`case 'promptAll'` custom-user dispatch (line 6462)**: Same as #8.

### 2. Category B — Sites without `moveCardToColumn` loops (5 sites, excluding `testingFailed`)

For these sites, the move is persisted by a different mechanism (`dispatchConfiguredKanbanColumnAction` or direct delta). Call the helper after the persist completes:

```ts
const allMovedIds: string[] = [];
for (const sid of sessionIds) {
    const movedIds = await this._collectAllMovedSessionIds(workspaceRoot, sid);
    allMovedIds.push(...movedIds);
}
this._panel?.webview.postMessage({ type: 'moveCards', sessionIds: allMovedIds, targetColumn });
```

**Sites to update:**

11. **`case 'moveSelected'` direct delta (line 6075)**: Wrap in helper collection loop.
12. **`case 'moveAll'` direct delta (line 6202)**: Same.
13. **`case 'promptSelected'` direct delta (line 6342)**: Same.
14. **`case 'promptAll'` direct delta (line 6419)**: Same.

### 3. `_postMoveCardsByTarget` (line 4045) — Signature change

This helper posts `moveCards` deltas for arbitrary `{sessionId, targetColumn}` pairs. It needs to become async and accept `workspaceRoot`:

```ts
private async _postMoveCardsByTarget(
    pairs: { sessionId: string; targetColumn: string }[],
    workspaceRoot: string
): Promise<void> {
    if (!this._panel || !Array.isArray(pairs) || pairs.length === 0) { return; }
    const byTarget = new Map<string, string[]>();
    for (const { sessionId, targetColumn } of pairs) {
        if (!sessionId || !targetColumn) { continue; }
        const movedIds = await this._collectAllMovedSessionIds(workspaceRoot, sessionId);
        if (!byTarget.has(targetColumn)) { byTarget.set(targetColumn, []); }
        byTarget.get(targetColumn)!.push(...movedIds);
    }
    for (const [targetColumn, sessionIds] of byTarget) {
        this._panel.webview.postMessage({ type: 'moveCards', sessionIds, targetColumn });
    }
}
```

**Caller audit required**: Grep for `_postMoveCardsByTarget` calls and update each to pass `workspaceRoot` and `await` the call.

### 4. EXCLUDE — `testingFailed` (line 6924)

This handler uses `db.updateColumn` directly (no epic cascade). Subtasks are NOT moved in the DB. Do NOT include subtask IDs in the `moveCards` delta — it would cause a webview/DB mismatch. Leave this site unchanged.

## Verification Plan

### Automated Tests
- Relevant existing tests to check for regressions:
  - `src/test/kanban-subtask-column-leak-regression.test.js`
  - `src/services/__tests__/KanbanDatabase.epicStatus.test.ts`

### Manual Verification

1. **Move Selected Forward — epic with subtasks:**
   - Select an epic card (with 2+ subtasks) in CREATED
   - Click "Move Selected Forward" button
   - Verify: epic retains `epic-card` styling
   - Verify: subtask cards also move to the target column

2. **Move All Forward — epic with subtasks:**
   - In a column with an epic + non-epic cards, click "Move All Forward"
   - Verify: epic retains styling, subtasks move, non-epics move

3. **Prompt Selected — epic with subtasks:**
   - Select an epic, click "Prompt Selected"
   - Verify: epic retains styling after the `moveCards` delta

4. **Prompt All — epic with subtasks:**
   - Click "Prompt All" in a column with an epic
   - Verify: epic retains styling

5. **Distribute Planner — epic with subtasks:**
   - Trigger distribute planner dispatch with an epic in the batch
   - Verify: epic retains styling

6. **Testing Failed — epic (regression):**
   - Mark an epic's test as failed
   - Verify: epic card moves to LEAD CODED, subtasks do NOT move (correct — no cascade)
   - Verify: epic retains styling

7. **`_postMoveCardsByTarget` callers:**
   - Identify all callers and verify they pass `workspaceRoot` and `await` the call
   - Verify no TypeScript compile errors from the signature change

8. **Regression — non-epic button moves:**
   - Move non-epic cards via all button paths
   - Verify: cards move correctly, no epic styling appears

---

**Recommendation**: Complexity 3 → **Send to Coder**
