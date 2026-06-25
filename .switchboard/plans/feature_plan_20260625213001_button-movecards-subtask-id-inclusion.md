# Fix: Button-Driven `moveCards` Send Sites Missing Subtask-ID Inclusion for Epic Cascades

## Goal

Extend the `_collectAllMovedSessionIds` helper (introduced in the epic-styling-lost-on-drag fix) to the remaining 16 button-driven `moveCards` send sites in `KanbanProvider.ts`. These sites currently pass only the directly-moved session IDs to the webview's `moveCards` delta, omitting subtask session IDs for epic cascade moves. This causes the same styling-loss bug as the drag-and-drop paths — but triggered by button clicks (Move Selected, Move All, Prompt Selected, Prompt All, Distribute Planner, Testing Failed) instead of drags.

### Problem

When a user clicks a button to move an epic card (e.g. "Move Selected Forward", "Move All Forward", "Prompt Selected"), the backend's `moveCardToColumn` cascades the move to all subtasks in the DB, but the `moveCards` delta sent to the webview only includes the epic's session ID. The webview's `currentCards` then has subtasks in the old column while the DB has them in the new column. The next `updateBoard` from a file watcher or scheduled refresh detects a signature mismatch and triggers a full `renderBoard`, which can race with pending messages and lose epic styling — the identical root cause documented in the parent plan.

### Root Cause Analysis

The parent plan (`feature_plan_20260625141328_epic-styling-lost-on-drag.md`) identified 21 total `moveCards` send sites and fixed 5 (the drag-and-drop paths). The remaining 16 are button-driven paths with the same latent bug. The `_collectAllMovedSessionIds` helper already exists and is proven correct — this plan is purely about applying it consistently.

**Verification of the cascade mechanism:** `moveCardToColumn` (line 4703) checks `plan.isEpic` and calls `db.updateColumnWithEpicCascade(sessionId, subtaskSessionIds, targetColumn)` (line 4723), which atomically moves the epic + all subtasks. The `_collectAllMovedSessionIds` helper (line 4737) reads only `isEpic` and `epicId` from the plan (not the column), so it can be called before or after the persist — it will always find the correct subtask IDs.

**Verification of custom-user dispatch persistence:** The Category B custom-user dispatch sites (lines 6075, 6202, 6342, 6419) send the `moveCards` delta and then call `dispatchConfiguredKanbanColumnAction`, which persists the column move via `_updateKanbanColumnForSession` → `moveCardToColumn` (when `_kanbanProvider` is set, which it always is in KanbanProvider-initiated dispatches). This means epics ARE cascaded in the DB for these paths, so subtask IDs MUST be included in the `moveCards` delta.

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
These either delegate to `dispatchConfiguredKanbanColumnAction` (which persists the move internally via `moveCardToColumn`) or use `db.updateColumn` directly. The helper must be called after the move is persisted, collecting subtask IDs for each moved session.

| Line | Handler | sessionIds var | Notes |
|------|---------|----------------|-------|
| 4045 | `_postMoveCardsByTarget` (helper) | `sessionIds` (loop var) | No `workspaceRoot` in scope — needs parameter |
| 6075 | `case 'moveSelected'` | `msg.sessionIds` | No moveCardToColumn — direct delta |
| 6202 | `case 'moveAll'` | `sessionIds` | No moveCardToColumn — direct delta |
| 6342 | `case 'promptSelected'` | `msg.sessionIds` | Custom-user dispatch, no loop |
| 6419 | `case 'promptAll'` | `sessionIds` | Custom-user dispatch, no loop |
| 6924 | `case 'testingFailed'` | `msg.sessionIds` | Uses `db.updateColumn` directly — EXCLUDED |

## Metadata

- **Tags:** bugfix, ui, ux, frontend, backend
- **Complexity:** 4
- **Affected Files:** `src/services/KanbanProvider.ts`
- **Parent Plan:** `feature_plan_20260625141328_epic-styling-lost-on-drag.md` (Risk 1)

## User Review Required

This plan modifies 15 `moveCards` send sites in a single file (`KanbanProvider.ts`) and changes the signature of a shared helper (`_postMoveCardsByTarget`). No user-facing configuration or behavior changes are needed — the fix is purely internal consistency. Review is recommended for:
- The `_postMoveCardsByTarget` signature change (sync → async, new `workspaceRoot` parameter) and its 2 callers
- The `testingFailed` exclusion rationale (uses `db.updateColumn`, no epic cascade)

## Complexity Audit

### Routine
- The `_collectAllMovedSessionIds` helper already exists and is proven correct — no new logic needed.
- Category A sites (10) follow the exact same pattern as the already-fixed `moveCardForward`/`moveCardBackwards` handlers: call helper per-iteration, accumulate into an array, pass to `moveCards`.
- No schema changes, no new APIs, no migration needed.
- All 15 sites are in a single file (`KanbanProvider.ts`).
- The 2 callers of `_postMoveCardsByTarget` (`batchPlannerPrompt` at line 5960, `batchLowComplexity` at line 5990) both have `workspaceRoot` in scope — the signature change is mechanical.

### Complex / Risky
- **`_postMoveCardsByTarget` (line 4036)**: This is a generic helper that posts `moveCards` deltas for arbitrary `{sessionId, targetColumn}` pairs. It is currently sync. Making it async and passing `workspaceRoot` changes its signature, which affects 2 callers. This is the only site requiring a signature change.
- **Error handling nuance for Category A sites with failure tracking**: Sites at lines 3661, 3702, 6052, 6116, 6179, 6245 have `if (ok) { movedIds.push(sid) } else { failures.push(...) }` error handling. The helper must only be called when `ok` is true — collecting subtask IDs for a failed move would send stale IDs to the webview. Sites at lines 6360, 6372, 6441, 6462 do NOT check `moveCardToColumn` return value (fire-and-forget), so the helper can be called unconditionally for those.
- **`testingFailed` (line 6924)**: Uses `db.updateColumn` directly (not `moveCardToColumn`), so there's no epic cascade — subtasks are NOT moved. Including subtask IDs in the `moveCards` delta here would cause the webview to move subtask cards to `LEAD CODED` while the DB leaves them in their current column. This site must be **EXCLUDED** from the fix.

## Edge-Case & Dependency Audit

### Race Conditions
- Same race window as the parent plan: the `moveCards` delta vs `updateBoard` race. The `lastBoardSignature` fix from the parent plan covers the webview side. This plan only ensures the delta includes all affected IDs.

### Security
- No security implications.

### Side Effects
- **Subtask cards on the board**: Including subtask IDs in button-driven `moveCards` deltas will visually move subtask cards to the target column, matching the DB cascade. This is correct behavior.
- **`testingFailed` exclusion**: This site uses `db.updateColumn` (no cascade), so subtasks are NOT moved in the DB. Including subtask IDs would cause a webview/DB mismatch. This site must be excluded.
- **`_postMoveCardsByTarget` signature change**: Making this method async and adding a `workspaceRoot` parameter affects 2 callers (`batchPlannerPrompt` at line 5960, `batchLowComplexity` at line 5990). Both callers are in async contexts and don't use the return value, so adding `await` is mechanical.
- **Ordering of `moveCards` delta vs dispatch for custom-user sites**: For `moveSelected`/`moveAll` custom-user (lines 6075, 6202), the `moveCards` delta is sent BEFORE `dispatchConfiguredKanbanColumnAction` (which persists the move). For `promptSelected`/`promptAll` custom-user (lines 6342, 6419), the delta is sent AFTER dispatch. In both cases, the helper can be called at any point since it only reads `isEpic`/`epicId` (not the column) — the subtask IDs are stable regardless of persist timing.

### Dependencies & Conflicts
- Depends on the `_collectAllMovedSessionIds` helper from the parent plan (already merged).
- No conflicts with other in-flight changes expected — the fix is additive.

| Edge Case | Impact | Mitigation |
|-----------|--------|------------|
| `testingFailed` handler (line 6924) | Uses `db.updateColumn` (no cascade) — subtasks NOT moved in DB | **EXCLUDE** this site from the fix |
| `_postMoveCardsByTarget` (line 4036) | No `workspaceRoot` in scope | Add `workspaceRoot` parameter; make method async; update 2 callers (`batchPlannerPrompt` line 5960, `batchLowComplexity` line 5990) |
| Epic with 0 subtasks | `moveCards` delta includes only epic ID | No change needed — empty subtask array handled |
| Non-epic card moved via button | Helper returns `[sessionId]` — same as today | No change in behavior |
| `moveCardToColumn` fails for an epic | Subtask IDs should NOT be collected | Only call helper inside `if (ok)` block for sites with error tracking (lines 3661, 3702, 6052, 6116, 6179, 6245) |
| `moveCardToColumn` return value not checked | All sids included in delta regardless | Call helper unconditionally for sites without error tracking (lines 6360, 6372, 6441, 6462) — matches existing behavior |

## Dependencies

- **Parent plan**: `feature_plan_20260625141328_epic-styling-lost-on-drag.md` must be merged first (provides the `_collectAllMovedSessionIds` helper at line 4737).

## Adversarial Synthesis

Key risks: (1) the `_postMoveCardsByTarget` signature change from sync to async could be missed at one of its 2 call sites, causing an unhandled promise or missing subtask IDs; (2) collecting subtask IDs for failed `moveCardToColumn` calls would send stale IDs to the webview; (3) incorrectly including subtask IDs in the `testingFailed` path would cause a webview/DB mismatch. Mitigations: audit both callers explicitly (`batchPlannerPrompt` line 5960, `batchLowComplexity` line 5990), only call the helper inside `if (ok)` blocks for sites with error tracking, and exclude `testingFailed` entirely.

## Proposed Changes

### 1. Category A — Sites with `moveCardToColumn` loops (10 sites)

For each of these sites, follow the pattern already established in `moveCardForward`/`moveCardBackwards` (lines 5522-5547).

**Pattern for sites WITH error tracking (lines 3661, 3702, 6052, 6116, 6179, 6245):**

```ts
// Replace movedIds.push(sid) with subtask-aware accumulation:
const allMovedIds: string[] = [];
for (const sid of sessionIds) {
    const ok = await this.moveCardToColumn(workspaceRoot, sid, targetColumn);
    if (ok) {
        await this._taskViewerProvider?.recordRunSheetForColumnMove(sid, targetColumn, 'forward', workspaceRoot);
        const movedIds = await this._collectAllMovedSessionIds(workspaceRoot, sid);
        allMovedIds.push(...movedIds);
    } else {
        failures.push({ id: sid, sourceColumn: column, reason: "couldn't save — board may be out of sync" });
    }
}
if (allMovedIds.length > 0) {
    this._panel?.webview.postMessage({ type: 'moveCards', sessionIds: allMovedIds, targetColumn });
}
```

**Pattern for sites WITHOUT error tracking (lines 6360, 6372, 6441, 6462):**

```ts
const allMovedIds: string[] = [];
for (const sid of sessionIds) {
    await this.moveCardToColumn(workspaceRoot, sid, targetColumn);
    await this._taskViewerProvider?.recordRunSheetForColumnMove(sid, targetColumn, 'forward', workspaceRoot);
    const movedIds = await this._collectAllMovedSessionIds(workspaceRoot, sid);
    allMovedIds.push(...movedIds);
}
this._panel?.webview.postMessage({ type: 'moveCards', sessionIds: allMovedIds, targetColumn });
```

**Sites to update** (line numbers are current, may shift during editing — match by handler name and context):

1. **`_distributePlannerDispatch` fallback (line 3661)**: Has `workspaceRoot` in scope. Accumulate `allMovedIds` in the existing loop (line 3650-3658), replacing `movedIds` in the `moveCards` post. Only collect on `ok`.
2. **`_distributePlannerDispatch` main (line 3702)**: Has `workspaceRoot` in scope. Accumulate `allMovedIds` in the existing loop (line 3691-3699), replacing `movedIds` in the `moveCards` post. Only collect on `ok`.
3. **`case 'moveSelected'` complexity routing (line 6052)**: Has `workspaceRoot` in scope. Accumulate `allMovedSids` in the inner `sids` loop (line 6042-6049), replacing `movedSids` in the `moveCards` post. Only collect on `ok`.
4. **`case 'moveSelected'` main forward (line 6116)**: Has `workspaceRoot` in scope. Accumulate `allMovedIds` in the existing loop (line 6106-6113), replacing `movedIds`. Only collect on `ok`.
5. **`case 'moveAll'` complexity routing (line 6179)**: Same as #3.
6. **`case 'moveAll'` main forward (line 6245)**: Same as #4.
7. **`case 'promptSelected'` complexity routing (line 6360)**: Has `workspaceRoot` in scope. Accumulate `allMovedSids` in the inner `sids` loop (line 6356-6359), replacing `sids` in the `moveCards` post. No error tracking — collect unconditionally.
8. **`case 'promptSelected'` else branch (line 6372)**: Has `workspaceRoot` in scope. Accumulate `allMovedIds` in the existing loop (line 6368-6371), replacing `msg.sessionIds` in the `moveCards` post. No error tracking — collect unconditionally.
9. **`case 'promptAll'` complexity routing (line 6441)**: Same as #7.
10. **`case 'promptAll'` else branch (line 6462)**: Same as #8.

### 2. Category B — Sites without `moveCardToColumn` loops (5 sites, excluding `testingFailed`)

For these sites, the move is persisted by a different mechanism (`dispatchConfiguredKanbanColumnAction` or `_advanceSessionsInColumn`). Call the helper to collect subtask IDs before sending the `moveCards` delta:

```ts
const allMovedIds: string[] = [];
for (const sid of sessionIds) {
    const movedIds = await this._collectAllMovedSessionIds(workspaceRoot, sid);
    allMovedIds.push(...movedIds);
}
this._panel?.webview.postMessage({ type: 'moveCards', sessionIds: allMovedIds, targetColumn });
```

**Sites to update:**

11. **`case 'moveSelected'` direct delta (line 6075)**: Has `workspaceRoot` in scope. The `moveCards` delta is currently sent BEFORE `dispatchConfiguredKanbanColumnAction`. Insert the collection loop before the `moveCards` post, replacing `msg.sessionIds` with `allMovedIds`. The helper reads `isEpic`/`epicId` only, so calling it before the dispatch persist is safe.
12. **`case 'moveAll'` direct delta (line 6202)**: Same as #11. Has `workspaceRoot` in scope.
13. **`case 'promptSelected'` custom-user dispatch (line 6342)**: Has `workspaceRoot` in scope. The `moveCards` delta is sent AFTER `dispatchConfiguredKanbanColumnAction`. Insert the collection loop before the `moveCards` post, replacing `msg.sessionIds` with `allMovedIds`.
14. **`case 'promptAll'` custom-user dispatch (line 6419)**: Same as #13. Has `workspaceRoot` in scope.

### 3. `_postMoveCardsByTarget` (line 4036) — Signature change

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

**Caller audit — exactly 2 callers, both in `KanbanProvider.ts`:**

| Caller | Line | Current | Updated |
|--------|------|---------|---------|
| `case 'batchPlannerPrompt'` | 5960 | `this._postMoveCardsByTarget(advanced);` | `await this._postMoveCardsByTarget(advanced, workspaceRoot);` |
| `case 'batchLowComplexity'` | 5990 | `this._postMoveCardsByTarget(advanced);` | `await this._postMoveCardsByTarget(advanced, workspaceRoot);` |

Both callers are in async case handlers and have `workspaceRoot` in scope. No other callers exist (verified by grep).

### 4. EXCLUDE — `testingFailed` (line 6924)

This handler uses `db.updateColumn` directly (line 6907, no epic cascade). Subtasks are NOT moved in the DB. Do NOT include subtask IDs in the `moveCards` delta — it would cause a webview/DB mismatch. Leave this site unchanged.

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
   - `batchPlannerPrompt` (line 5960): trigger batch planner prompt with an epic in CREATED
   - `batchLowComplexity` (line 5990): trigger batch low-complexity prompt with an epic in PLAN REVIEWED
   - Verify: epic retains styling, subtasks move to the correct target column
   - Verify: no TypeScript compile errors from the signature change (both callers `await` the call and pass `workspaceRoot`)

8. **Regression — non-epic button moves:**
   - Move non-epic cards via all button paths
   - Verify: cards move correctly, no epic styling appears

9. **Regression — `moveCardToColumn` failure path:**
   - Simulate a `moveCardToColumn` failure (e.g. DB not ready) for an epic via Move Selected
   - Verify: failed epic's subtask IDs are NOT included in the `moveCards` delta (no stale UI move)
   - Verify: `moveCardsFailed` message is posted for the failed epic

---

**Recommendation**: Complexity 4 → **Send to Coder**
