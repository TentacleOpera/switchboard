# Fix: Optimistic Move Bounce-Back After Reload (CODE REVIEWED → LEAD CODED)

## Goal

### Core Problem

When a user drags a Kanban card to a dispatch column (e.g. CODE REVIEWED) in CLI trigger mode, the card is **optimistically moved in the DOM** before the backend processes the drop. If the dispatch fails or is skipped (agent unavailable, dispatch error, CLI triggers disabled), the card's kanban_column is **never updated in the DB** — but a 2-second **render guard** (`optimisticMoveUntil`) in the webview absorbs the corrective board refresh, hiding the discrepancy. The card appears to stay in the target column until a **window reload**, at which point the board reads from the DB and the card "bounces back" to its actual (unchanged) column.

### Desired Behavior

The card **always stays where the user dropped it** — the column move is persisted to the DB immediately, before the dispatch attempt. If the dispatch fails, the card's **copy-prompt button glows orange** and the target column's prompt is already copied to the clipboard. The user can paste it manually — the same fallback they use today when they move the card back and hit copy-prompt.

No snap-back. No bounce. The board stays snappy.

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

The `triggerAction` path (CLI-mode drag-to-dispatch) couples the column move to the dispatch outcome. When dispatch fails, the column is rolled back, but the render guard hides the rollback from the user. The fix is to **decouple** the column move from the dispatch — persist the move immediately, and treat dispatch failure as a separate concern (prompt fallback).

## Proposed Fix

### Design Principle

The card goes where the user dropped it. Dispatch success/failure is a separate concern. If dispatch fails, the user gets the prompt via the orange-glowing copy-prompt button.

### Fix 1: Persist the column move BEFORE dispatch (Scenarios B & C)

In `KanbanProvider.ts`, the `triggerAction` handler (line 5773) currently relies on `_handleTriggerAgentActionInternal` to update the column. Instead, call `moveCardToColumn` **first**, then dispatch. If dispatch fails, the card stays in the target column (no rollback).

```typescript
// KanbanProvider.ts, triggerAction handler, after resolving role (line 5786):

// Persist the column move FIRST — decouples the card position from
// dispatch success. The card stays where the user dropped it regardless
// of whether the agent dispatch succeeds.
await this.moveCardToColumn(workspaceRoot, sessionId, targetColumn);

// ... existing dispatch logic ...

// When dispatch fails (dispatched === false at line 5866):
// Instead of relying on _scheduleBoardRefresh (absorbed by render guard),
// generate the target column's prompt, copy to clipboard, and signal
// the webview to glow the copy-prompt button orange.
if (!dispatched) {
    const card = this._lastCards.find(c => (c.planId || c.sessionId) === sessionId);
    if (card) {
        const sourceColumn = this._columnToRole(targetColumn) === 'reviewer' ? 'LEAD CODED' : card.column;
        const prompt = await this._generatePromptForColumn([card], sourceColumn, workspaceRoot, targetColumn);
        await vscode.env.clipboard.writeText(prompt);
        this._panel?.webview.postMessage({
            type: 'dispatchFailedPromptReady',
            planId: card.planId || sessionId,
            sessionId: card.sessionId,
            targetColumn
        });
    }
}
```

For the `canDispatch === false` path (Scenario B), the same prompt-fallback applies — the card is already persisted, so just generate the prompt and signal the button.

### Fix 2: Remove the column rollback in TaskViewerProvider (Scenario C)

In `TaskViewerProvider.ts`, `_handleTriggerAgentActionInternal` (line 16173) currently rolls back the column on dispatch failure (line 16502-16503). Since the `triggerAction` handler now persists the move independently, the rollback should be **skipped** when the call comes from the kanban drag-dispatch path.

Add a `persistColumnOnError` flag to `ConfiguredKanbanDispatchOptions`:

```typescript
// TaskViewerProvider.ts, _handleTriggerAgentActionInternal, dispatch-failure rollback (line 16500):
} else {
    // Dispatch failed
    if (!options?.persistColumnOnError && previousColumn) {
        // Only roll back when the caller hasn't taken responsibility for
        // the column move (e.g. sidebar dispatch). The kanban triggerAction
        // handler persists the move independently and handles the fallback.
        await this._updateKanbanColumnForSession(resolvedWorkspaceRoot, sessionId, previousColumn);
        this._scheduleSidebarKanbanRefresh(resolvedWorkspaceRoot);
    }
    // ... rest of failure handling ...
}
```

The `triggerAgentFromKanban` command (extension.ts:1231) needs to pass this flag. Since the command doesn't currently pass options, the handler can infer it: when called via `triggerAgentFromKanban`, set `persistColumnOnError = true`.

Alternatively, the simpler approach: since `triggerAction` in KanbanProvider now calls `moveCardToColumn` before dispatch, and `_handleTriggerAgentActionInternal` also calls `_updateKanbanColumnForSession` at line 16466 (which is now redundant but harmless — same column), the rollback at line 16503 would revert to `previousColumn`. But since `triggerAction` already persisted the move, we need to either:
- Pass `persistColumnOnError: true` through the command, OR
- Have `triggerAction` skip the dispatch via `triggerAgentFromKanban` and instead call the dispatch directly with the flag

The cleanest path: add `persistColumnOnError` to the options passed through `dispatchConfiguredKanbanColumnAction` and `handleKanbanTrigger`, defaulting to `true` for kanban-triggered dispatches.

### Fix 3: Webview — Agent unavailable sends `moveCardForward` + prompt fallback (Scenario A)

In `kanban.html`, when `isColumnAgentAvailable(group.targetColumn)` returns false at line 5868, instead of silently returning, send `moveCardForward` to persist the move. The backend `moveCardForward` handler already calls `moveCardToColumn` and sends a `moveCards` delta.

```javascript
// kanban.html, line 5868:
if (!isColumnAgentAvailable(group.targetColumn)) {
    // No agent to dispatch — still persist the card move to the DB.
    // Without this, the optimistic DOM move is never persisted and
    // the card bounces back on reload. The moveCardForward handler
    // will also send a moveCards delta to confirm the UI position.
    postKanbanMessage({
        type: 'moveCardForward',
        sessionIds: groupedIds,
        targetColumn: group.targetColumn,
        workspaceRoot
    });
    return;
}
```

The prompt fallback for Scenario A is handled by a separate message: since no backend dispatch was attempted, the backend doesn't know the prompt was needed. Two options:
1. Have the webview also send a `promptSelected` message to get the prompt copied
2. Send a new `dispatchFailedPromptReady` request from the webview

Option 1 is simpler — piggyback on the existing `promptSelected` flow:

```javascript
if (!isColumnAgentAvailable(group.targetColumn)) {
    postKanbanMessage({ type: 'moveCardForward', sessionIds: groupedIds, targetColumn: group.targetColumn, workspaceRoot });
    // Also copy the prompt for manual paste
    postKanbanMessage({ type: 'promptSelected', column: group.sourceColumn, sessionIds: groupedIds, workspaceRoot });
    return;
}
```

But this would also advance the card via `promptSelected`'s logic, causing a double-advance. Better to use a dedicated message or have `moveCardForward` also trigger the prompt copy when the dispatch was the original intent.

**Simplest approach:** Send only `moveCardForward`. The user can click the copy-prompt button manually if they want the prompt. The card stays in the right column — that's the critical fix. The orange glow is only for Scenarios B & C where the backend attempted a dispatch and failed.

### Fix 4: Webview — Orange glow on copy-prompt button + message handler

Add CSS for the orange glow state on the copy-prompt button:

```css
/* Card Copy Button — dispatch failed, prompt ready */
@keyframes promptReadyGlow {
    0%, 100% { box-shadow: 0 0 4px 1px rgba(255, 165, 0, 0.6); border-color: rgba(255, 165, 0, 0.8); }
    50% { box-shadow: 0 0 8px 2px rgba(255, 165, 0, 0.9); border-color: rgba(255, 165, 0, 1); }
}
.card-btn.copy.prompt-ready {
    animation: promptReadyGlow 2s ease-in-out infinite;
    border: 1px solid rgba(255, 165, 0, 0.8);
}
```

Add a message handler in the webview:

```javascript
case 'dispatchFailedPromptReady': {
    const planId = msg.planId || msg.sessionId;
    const btn = document.querySelector(`.card-btn.copy[data-plan-id="${CSS.escape(planId)}"]`)
        || document.querySelector(`.card-btn.copy[data-session="${CSS.escape(msg.sessionId)}"]`);
    if (btn) {
        btn.classList.add('prompt-ready');
        // Remove the glow after 30 seconds or on click
        const removeGlow = () => btn.classList.remove('prompt-ready');
        btn.addEventListener('click', removeGlow, { once: true });
        setTimeout(removeGlow, 30000);
    }
    // Show a status message
    const statusEl = document.getElementById('status-message');
    if (statusEl) {
        statusEl.textContent = 'Dispatch failed — prompt copied. Paste manually or click the glowing button.';
        statusEl.style.color = 'rgba(255, 165, 0, 1)';
        statusEl.style.display = 'inline-block';
        statusEl.classList.add('flashing');
    }
    break;
}
```

## Files to Modify

1. **`src/services/KanbanProvider.ts`**
   - `triggerAction` handler (line 5773): call `moveCardToColumn` before dispatch; on `!dispatched`, generate prompt + copy to clipboard + send `dispatchFailedPromptReady` message
   - `triggerBatchAction` handler (line 5893): same pattern for batch dispatches

2. **`src/services/TaskViewerProvider.ts`**
   - `_handleTriggerAgentActionInternal` (line 16173): add `persistColumnOnError` option; skip column rollback when set
   - `ConfiguredKanbanDispatchOptions` type: add `persistColumnOnError?: boolean`
   - `handleKanbanTrigger` (line 2855): pass `persistColumnOnError: true` for kanban-triggered dispatches

3. **`src/webview/kanban.html`**
   - CSS: add `.card-btn.copy.prompt-ready` glow animation
   - Message handler: add `dispatchFailedPromptReady` case
   - `isColumnAgentAvailable` guard (line 5868): send `moveCardForward` instead of silent return

4. **`src/extension.ts`**
   - `triggerAgentFromKanban` command (line 1231): pass `persistColumnOnError: true` in options

## Testing

1. **Scenario A test:** Unassign the reviewer agent. Drag a card from LEAD CODED to CODE REVIEWED. Verify:
   - Card stays in CODE REVIEWED (no bounce)
   - DB shows CODE REVIEWED (via sqlite3 query)
   - Reload window — card still in CODE REVIEWED

2. **Scenario B test:** Unassign all agents. Drag a card to a dispatch column. Verify:
   - Card stays in target column
   - Copy-prompt button glows orange
   - Prompt is in clipboard (paste to verify)
   - Reload — card still in target column

3. **Scenario C test:** Force a dispatch failure (close agent terminal mid-dispatch, or use an invalid terminal name). Verify:
   - Card stays in target column (no rollback)
   - Copy-prompt button glows orange
   - Prompt is in clipboard
   - Reload — card still in target column

4. **Normal dispatch test:** Drag a card to a column with a valid, running agent. Verify:
   - Card moves to target column
   - Agent receives the dispatch
   - No orange glow (dispatch succeeded)
   - Reload — card still in target column

5. **Copy-prompt button click after failed dispatch:** Click the orange-glowing button. Verify:
   - Glow disappears
   - Prompt is re-copied to clipboard (via the existing `copyPlanLinkResult` flow)
   - Button returns to normal state

6. **Batch dispatch test:** Drag multiple cards to a dispatch column. Verify all cards persist their move regardless of dispatch outcome.
