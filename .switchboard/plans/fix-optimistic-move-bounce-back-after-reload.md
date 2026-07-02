# Fix: Optimistic Move Bounce-Back After Reload (CODE REVIEWED → LEAD CODED)

## Goal

### Core Problem

When a user drags a Kanban card to a dispatch column (e.g. CODE REVIEWED) in CLI trigger mode, the card is **optimistically moved in the DOM** before the backend processes the drop. If the dispatch fails or is skipped (agent unavailable, dispatch error, CLI triggers disabled), the card's kanban_column is **never updated in the DB** — but a 2-second **render guard** (`optimisticMoveUntil`) in the webview absorbs the corrective board refresh, hiding the discrepancy. The card appears to stay in the target column until a **window reload**, at which point the board reads from the DB and the card "bounces back" to its actual (unchanged) column.

### Background Context

The drag-to-dispatch flow has three paths in `kanban.html`:

1. **`promptOnDrop`** (prompt mode) — copies prompt to clipboard, calls `moveCardToColumn` to update DB, sends `moveCards` delta. **No bounce** — DB and UI stay in sync.
2. **`moveCardForward`/`moveCardBackwards`** (move mode) — calls `moveCardToColumn` to update DB, sends `moveCards` delta. **No bounce** — DB and UI stay in sync.
3. **`triggerAction`/`triggerBatchAction`** (CLI mode) — dispatches an agent via `switchboard.triggerAgentFromKanban`. The column update happens **inside** `_handleTriggerAgentActionInternal` (TaskViewerProvider.ts:16466), **not** in the `triggerAction` handler itself. If the dispatch fails, the column is **rolled back** to `previousColumn` (TaskViewerProvider.ts:16503). **This is the bounce path.**

### Root Cause Analysis

Three distinct failure scenarios, all hidden by the render guard:

**Scenario A — Agent not available in webview (`isColumnAgentAvailable` returns false):**
- `kanban.html:5868` — `if (!isColumnAgentAvailable(group.targetColumn)) return;`
- No message sent to backend at all. No DB update. No board refresh.
- Card was already optimistically moved at `kanban.html:5824` (`card.column = resolvedTarget`).
- Render guard armed at `kanban.html:5840` (`optimisticMoveUntil = Date.now() + 2000`).
- Card appears to stay in target column indefinitely until reload.

**Scenario B — `canDispatch` false in KanbanProvider (`triggerAction` handler):**
- `KanbanProvider.ts:5787` — `canDispatch = await this._canAssignRole(workspaceRoot, role)` returns false.
- Dispatch block skipped. No DB update.
- `KanbanProvider.ts:5890` — `_scheduleBoardRefresh` fires (100ms debounce), sends `updateBoard` to webview.
- `kanban.html:6261-6272` — Render guard active, so `currentCards` is updated to DB values but `renderBoard` is NOT called.
- After 2 seconds, render guard expires, but no new refresh is triggered → card stays in target column visually until reload.

**Scenario C — Dispatch succeeds but column update is rolled back:**
- `TaskViewerProvider.ts:16466` — `_updateKanbanColumnForSession` sets column to target (e.g. CODE REVIEWED).
- `TaskViewerProvider.ts:16474` — `_dispatchExecuteMessage` fails or throws.
- `TaskViewerProvider.ts:16502-16503` — Column rolled back to `previousColumn` (e.g. LEAD CODED).
- `KanbanProvider.ts:5890` — `_scheduleBoardRefresh` fires, but render guard absorbs it.
- Card appears to stay in CODE REVIEWED until reload, then bounces to LEAD CODED.

**Why the render guard makes this worse:**
The render guard (`optimisticMoveUntil`, 2000ms) is designed to prevent stale `updateBoard` messages from reverting optimistic moves during the dispatch round-trip. But it also absorbs **corrective** refreshes that would reveal the DB/UI mismatch. After the guard expires, no mechanism triggers a new refresh — the card lives in a zombie state until the user reloads.

## Root Cause

The `triggerAction` path (CLI-mode drag-to-dispatch) does not guarantee a DB column update. When the dispatch fails or is skipped, the only corrective signal is a `_scheduleBoardRefresh` call, which produces an `updateBoard` message that the webview's render guard silently absorbs. There is no `moveCards` delta (which bypasses the guard) sent to revert the card.

## Proposed Fix

### Fix 1: Webview — Revert optimistic move when agent unavailable (Scenario A)

In `kanban.html`, when `isColumnAgentAvailable(group.targetColumn)` returns false at line 5868, instead of silently returning, send a `moveCardForward` message (which updates the DB directly) OR revert the optimistic DOM move.

**Preferred approach:** Send `moveCardForward` so the card still advances in the DB even without a dispatch. This matches user intent — they dragged the card to a new column.

```javascript
// Before (line 5868):
if (!isColumnAgentAvailable(group.targetColumn)) return;

// After:
if (!isColumnAgentAvailable(group.targetColumn)) {
    // No agent to dispatch — still advance the card in the DB via the
    // non-dispatch move path. Without this, the optimistic DOM move
    // is never persisted and the card bounces back on reload.
    if (groupedIds.length === 1) {
        postKanbanMessage({ type: 'moveCardForward', sessionIds: groupedIds, targetColumn: group.targetColumn, workspaceRoot });
    } else {
        postKanbanMessage({ type: 'moveCardForward', sessionIds: groupedIds, targetColumn: group.targetColumn, workspaceRoot });
    }
    return;
}
```

### Fix 2: Backend — Send `moveCards` delta instead of `_scheduleBoardRefresh` when dispatch fails (Scenarios B & C)

In `KanbanProvider.ts`, the `triggerAction` handler (line 5773) currently calls `_scheduleBoardRefresh` at line 5890 as a catch-all corrective. This produces an `updateBoard` message absorbed by the render guard. Instead, when the dispatch did not happen or failed, send a targeted `moveCards` delta with the **actual** DB column — this bypasses the render guard.

```typescript
// In the triggerAction handler, after the dispatch attempt:
// Replace the unconditional _scheduleBoardRefresh with a targeted moveCards
// that reflects the actual DB state. This bypasses the render guard.

// After the canDispatch block (line 5886):
if (!canDispatch) {
    // Agent not assigned — revert the card to its actual DB column via
    // a moveCards delta (bypasses render guard, unlike _scheduleBoardRefresh).
    const db = this._getKanbanDb(workspaceRoot);
    if (db && await db.ensureReady()) {
        const plan = await db.getPlanBySessionId(sessionId);
        const actualColumn = plan ? (this._normalizeLegacyKanbanColumn(plan.kanbanColumn) || 'CREATED') : null;
        if (actualColumn) {
            this._panel?.webview.postMessage({ type: 'moveCards', sessionIds: [sessionId], targetColumn: actualColumn });
        }
    }
}
this._scheduleBoardRefresh(workspaceRoot ?? undefined);
```

For Scenario C (dispatch rolled back), the rollback in `TaskViewerProvider.ts:16502-16503` already calls `_scheduleSidebarKanbanRefresh`, which calls `_scheduleBoardRefresh`. But this is also absorbed. The fix is to have `_handleTriggerAgentActionInternal` send a `moveCards` delta via the KanbanProvider when rolling back:

```typescript
// TaskViewerProvider.ts, in the dispatch-failure rollback (line 16500-16508):
if (previousColumn) {
    await this._updateKanbanColumnForSession(resolvedWorkspaceRoot, sessionId, previousColumn);
    // Send a targeted moveCards delta that bypasses the webview render guard.
    // _scheduleBoardRefresh alone is absorbed by the optimistic-move guard
    // and the card appears stuck in the target column until a reload.
    this._kanbanProvider?._panel?.webview.postMessage({
        type: 'moveCards', sessionIds: [sessionId], targetColumn: previousColumn
    });
    this._scheduleSidebarKanbanRefresh(resolvedWorkspaceRoot);
}
```

### Fix 3: Webview — Trigger a board refresh after the render guard expires (safety net)

As a defense-in-depth measure, after the render guard window expires, trigger a board refresh to reconcile any stale optimistic moves:

```javascript
// In kanban.html, after setting optimisticMoveUntil:
optimisticMoveUntil = Date.now() + OPTIMISTIC_MOVE_WINDOW_MS;
// Schedule a reconciling refresh after the guard expires to catch
// any optimistic moves that were never persisted to the DB.
setTimeout(() => {
    if (Date.now() >= optimisticMoveUntil) {
        postKanbanMessage({ type: 'requestBoardRefresh' });
    }
}, OPTIMISTIC_MOVE_WINDOW_MS + 100);
```

This requires adding a `requestBoardRefresh` handler in KanbanProvider:
```typescript
case 'requestBoardRefresh':
    this._scheduleBoardRefresh(msg.workspaceRoot ?? undefined);
    break;
```

## Files to Modify

1. **`src/webview/kanban.html`** — Fix 1 (revert/advance when agent unavailable) + Fix 3 (post-guard refresh)
2. **`src/services/KanbanProvider.ts`** — Fix 2 (send `moveCards` instead of `_scheduleBoardRefresh` when dispatch skipped) + Fix 3 (`requestBoardRefresh` handler)
3. **`src/services/TaskViewerProvider.ts`** — Fix 2 (send `moveCards` delta on dispatch rollback)

## Testing

1. **Scenario A test:** Disable the reviewer agent (unassign it). Drag a card from LEAD CODED to CODE REVIEWED. Verify the card advances in the DB (via `moveCardForward`) and stays in CODE REVIEWED after reload.
2. **Scenario B test:** Unassign all agents for a column. Drag a card to that column. Verify the card reverts to its previous column immediately (via `moveCards` delta), not after reload.
3. **Scenario C test:** Force a dispatch failure (e.g. close the agent terminal mid-dispatch). Verify the card reverts to its previous column immediately.
4. **Reload test:** After each scenario, reload the VS Code window. Verify no bounce-back occurs.
5. **Normal dispatch test:** Drag a card to a column with a valid agent. Verify the card moves correctly and stays after reload.
