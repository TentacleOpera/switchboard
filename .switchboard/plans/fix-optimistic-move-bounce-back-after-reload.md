# Fix: Optimistic Move Bounce-Back After Reload (CODE REVIEWED → LEAD CODED)

**Plan ID:** b8d4e3f2-9c5e-4f7b-ad6d-2e3f4a5b6c7d

## Goal

Fix the kanban card visually bouncing back to its pre-move column after a window reload, by ensuring the optimistic column move is persisted to the DB immediately and never rolled back on dispatch failure. The card always stays where the user dropped it; dispatch failure is handled separately via an orange-glowing copy-prompt button.

### Core Problem

When a user drags a Kanban card to a dispatch column (e.g. CODE REVIEWED) in CLI trigger mode, the card is **optimistically moved in the DOM** before the backend processes the drop. If the dispatch fails or is skipped (agent unavailable, dispatch error, CLI triggers disabled), the card's kanban_column is **never updated in the DB** — but a 2-second **render guard** (`optimisticMoveUntil`) in the webview absorbs the corrective board refresh, hiding the discrepancy. The card appears to stay in the target column until a **window reload**, at which point the board reads from the DB and the card "bounces back" to its actual (unchanged) column.

### Desired Behavior

The card **always stays where the user dropped it** — the column move is persisted to the DB immediately, before the dispatch attempt. If the dispatch fails, the card's **copy-prompt button glows orange** and the target column's prompt is already copied to the clipboard. The user can paste it manually — the same fallback they use today when they move the card back and hit copy-prompt.

No snap-back. No bounce. The board stays snappy.

### Background Context

The drag-to-dispatch flow has three paths in `kanban.html` (lines 5850-5876):

1. **`promptOnDrop`** (prompt mode, line 5860) — copies prompt to clipboard, calls `moveCardToColumn` to update DB, sends `moveCards` delta. **No bounce** — DB and UI stay in sync.
2. **`moveCardForward`/`moveCardBackwards`** (move mode, lines 5850-5858) — calls `moveCardToColumn` to update DB, sends `moveCards` delta. **No bounce** — DB and UI stay in sync.
3. **`triggerAction`/`triggerBatchAction`** (CLI mode, lines 5872-5876) — dispatches an agent via `switchboard.triggerAgentFromKanban`. The column update happens **inside** `_handleTriggerAgentActionInternal` (TaskViewerProvider.ts:16495), **not** in the `triggerAction` handler itself. If the dispatch fails, the column is **rolled back** to `previousColumn` (TaskViewerProvider.ts:16531-16532). **This is the bounce path.**

### Root Cause Analysis

Three distinct failure scenarios, all hidden by the render guard:

**Scenario A — Agent not available in webview (`isColumnAgentAvailable` returns false):**
- `kanban.html:5871` — `if (!isColumnAgentAvailable(group.targetColumn)) return;`
- No message sent to backend at all. No DB update. No board refresh.
- Card was already optimistically moved at `kanban.html:5827` (`card.column = resolvedTarget`).
- Render guard armed at `kanban.html:5843` (`optimisticMoveUntil = Date.now() + OPTIMISTIC_MOVE_WINDOW_MS` where `OPTIMISTIC_MOVE_WINDOW_MS = 2000` at line 3823).
- Card appears to stay in target column indefinitely until reload.

**Scenario B — `canDispatch` false in KanbanProvider (`triggerAction` handler):**
- `KanbanProvider.ts:5820` — `const canDispatch = workspaceRoot ? await this._canAssignRole(workspaceRoot, role) : false;` returns false.
- Dispatch block skipped (line 5863 `if (canDispatch)` is false). No DB update.
- `KanbanProvider.ts:5923` — `_scheduleBoardRefresh` fires (~100ms debounce), sends `updateBoard` to webview.
- `kanban.html:6264-6274` — Render guard active, so `currentCards` is updated to DB values but `renderBoard` is NOT called.
- After 2 seconds, render guard expires, but no new refresh is triggered → card stays in target column visually until reload.

**Scenario C — Dispatch succeeds but column update is rolled back:**
- `TaskViewerProvider.ts:16495` — `_updateKanbanColumnForSession` sets column to target (e.g. CODE REVIEWED).
- `TaskViewerProvider.ts:16503` — `_dispatchExecuteMessage` fails or throws.
- `TaskViewerProvider.ts:16531-16532` — Column rolled back to `previousColumn` (e.g. LEAD CODED).
- `KanbanProvider.ts:5923` — `_scheduleBoardRefresh` fires, but render guard absorbs it.
- Card appears to stay in CODE REVIEWED until reload, then bounces to LEAD CODED.

**Why the render guard makes this worse:**
The render guard (`optimisticMoveUntil`, 2000ms) is designed to prevent stale `updateBoard` messages from reverting optimistic moves during the dispatch round-trip. But it also absorbs **corrective** refreshes that would reveal the DB/UI mismatch. After the guard expires, no mechanism triggers a new refresh — the card lives in a zombie state until the user reloads.

### Root Cause

The `triggerAction` path (CLI-mode drag-to-dispatch) couples the column move to the dispatch outcome. When dispatch fails, the column is rolled back, but the render guard hides the rollback from the user. The fix is to **decouple** the column move from the dispatch — persist the move immediately, and treat dispatch failure as a separate concern (prompt fallback).

## Metadata

**Complexity:** 7
**Tags:** frontend, backend, bugfix, ui, reliability

## User Review Required

Yes — the change alters the dispatch failure semantics (card stays in target column on failure instead of rolling back). This is a deliberate UX shift: the user must manually move the card back if they disagree with the target column after a failed dispatch. Confirm this is acceptable.

## Complexity Audit

### Routine
- Adding `persistColumnOnError?: boolean` to `ConfiguredKanbanDispatchOptions` type (1 line).
- Hardcoding `persistColumnOnError: true` in the `triggerAgentFromKanban` command handler and in `dispatchConfiguredKanbanColumnAction`'s `dispatchOptions` (2 lines).
- Adding the `if (!options?.persistColumnOnError && previousColumn)` guard around the rollback in `_handleTriggerAgentActionInternal` (2 locations: failure return + catch block).
- CSS for orange glow animation (standard `@keyframes` + class).
- Webview message handler for `dispatchFailedPromptReady` (mirrors existing `copyPlanLinkResult` handler pattern at lines 6536-6543).

### Complex / Risky
- **Decoupling column move from dispatch outcome** — changes the fundamental contract of `_handleTriggerAgentActionInternal`. The column is currently set before dispatch (line 16495) and rolled back on failure (16531-16532). With `persistColumnOnError`, the rollback is skipped. This means a failed dispatch leaves the card in the target column with no agent working on it. The user must notice the orange glow and paste manually, or move the card back themselves.
- **Two dispatch paths in `triggerAction`** — the custom-user branch (line 5821, uses `dispatchConfiguredKanbanColumnAction`) and the built-in branch (line 5863, uses `triggerAgentFromKanban` command). Both must be handled. The custom-user path goes through `dispatchConfiguredKanbanColumnAction` → `_handleTriggerAgentAction` → `_handleTriggerAgentActionInternal`. The built-in path goes through the VS Code command → `handleKanbanTrigger` → `_handleTriggerAgentAction` → `_handleTriggerAgentActionInternal`. The `persistColumnOnError` flag must reach `_handleTriggerAgentActionInternal` on both paths.
- **Scenario A (agent unavailable in webview)** — no backend call at all. Must send `moveCardForward` to persist the move. This is a different code path from Scenarios B & C.
- **Prompt generation on dispatch failure** — requires calling `_generatePromptForColumn` with the correct source column. The source column for prompt generation should be `card.column` (the card's actual column before the optimistic move), not a derived value.
- **Batch path (`handleKanbanBatchTrigger`)** — already has the desired behavior (no column rollback on failure). Must NOT be changed. Explicitly documented as a non-goal.

## Edge-Case & Dependency Audit

- **Race Conditions:** The `triggerAction` handler is async. If `moveCardToColumn` is called before dispatch and the dispatch also calls `_updateKanbanColumnForSession` (line 16495), there's a double-write to the DB — same value, so harmless. But if the dispatch fails and `persistColumnOnError` is true, the rollback is skipped, so the card stays. No race — the operations are sequential (`await`).
- **Security:** No security implications — no user input processing, no credential handling.
- **Side Effects:**
  - Failed dispatches now leave the card in the target column instead of reverting. This is the intended behavior change.
  - The clipboard is overwritten with the dispatch prompt on failure. This is consistent with the existing `promptOnDrop` behavior.
  - The orange glow CSS animation runs for 30 seconds or until the button is clicked. No persistent state.
- **Dependencies & Conflicts:**
  - **Batch path** — `handleKanbanBatchTrigger` (TaskViewerProvider.ts:3593) already persists columns on failure (no rollback in its catch block at line 3699). **No change needed.** Do not add `persistColumnOnError` logic to the batch path.
  - **Sidebar dispatch** — `_handleTriggerAgentAction` is also called from the sidebar (line 9734, `triggerAgentAction` message). The sidebar path does NOT pass `persistColumnOnError`, so the rollback still fires for sidebar-initiated dispatches. This is correct — sidebar dispatches should roll back on failure since there's no optimistic UI move to protect.
  - **`dispatchConfiguredKanbanColumnAction` prompt mode** — when `dragDropMode === 'prompt'`, it calls `_dispatchConfiguredKanbanColumnPrompt` (line 3027), not `_handleTriggerAgentAction`. The prompt path has its own column update logic. `persistColumnOnError` only affects the CLI path.
  - **`triggerBatchAgentFromKanban` command** (extension.ts:1252) — calls `handleKanbanBatchTrigger` directly. No `persistColumnOnError` needed (batch path already persists).
  - **Copy-prompt button attributes** — verified: the button at kanban.html:5473 has both `data-plan-id` and `data-session` attributes. The selector in the `dispatchFailedPromptReady` handler will match.
  - **`status-message` element** — verified: exists at kanban.html:2590 with `role="status"` and `aria-live="polite"`.

## Dependencies

None — this is a self-contained multi-file change with no external dependencies.

## Adversarial Synthesis

Key risks: (1) the `persistColumnOnError` flag must reach `_handleTriggerAgentActionInternal` on both the custom-user and built-in dispatch paths — the `triggerAgentFromKanban` command reconstructs options and drops unknown fields, so the flag must be hardcoded in the command handler; (2) Scenario A (agent unavailable in webview) has no backend round-trip, so the prompt-fallback (orange glow + clipboard) cannot be triggered from the backend — the card is persisted via `moveCardForward` but gets no orange glow, which is a deliberate tradeoff; (3) the `dispatched === false` branch referenced in the original plan does NOT exist — the actual code checks `if (dispatched && workspaceRoot)` at line 5899, so the `!dispatched` prompt-fallback logic must be ADDED as a new branch, not modified from existing code. Mitigations: hardcode `persistColumnOnError: true` in both the command handler and `dispatchConfiguredKanbanColumnAction`; document Scenario A asymmetry explicitly; add the `!dispatched` branch as new code after the existing `if (dispatched && workspaceRoot)` block.

## Proposed Fix

### Design Principle

The card goes where the user dropped it. Dispatch success/failure is a separate concern. If dispatch fails, the user gets the prompt via the orange-glowing copy-prompt button.

### Fix 1: Persist the column move BEFORE dispatch (Scenarios B & C)

In `KanbanProvider.ts`, the `triggerAction` handler (line 5806) currently relies on `_handleTriggerAgentActionInternal` to update the column. Instead, call `moveCardToColumn` **first**, then dispatch. If dispatch fails, the card stays in the target column (no rollback).

**For the custom-user branch (line 5821):**

After line 5816 (role resolution), before the `dispatchSpec?.source === 'custom-user'` check at line 5821, add:

```typescript
// Persist the column move FIRST — decouples the card position from
// dispatch success. The card stays where the user dropped it regardless
// of whether the agent dispatch succeeds.
if (workspaceRoot) {
    await this.moveCardToColumn(workspaceRoot, sessionId, targetColumn);
}
```

Then, inside the custom-user branch, after the dispatch attempt (line 5842-5858), add a `!dispatched` fallback:

```typescript
const dispatched = await this._taskViewerProvider.dispatchConfiguredKanbanColumnAction(role, [sessionId], {
    targetColumn,
    dragDropMode: dispatchMode,
    additionalInstructions: dispatchSpec.triggerPrompt,
    instruction,
    workspaceRoot: workspaceRoot || undefined,
    targetTerminalOverride
});
if (dispatched && plannerCursorLocationKey && tvp) {
    await tvp.advancePlannerRotationCursor(plannerCursorLocationKey, 1);
}
if (dispatched && role === 'lead') {
    const card = this._lastCards.find(c => (c.planId || c.sessionId) === sessionId && c.workspaceRoot === workspaceRoot);
    if (card && !this._isLowComplexity(card) && card.complexity !== 'Unknown') {
        await this._dispatchWithPairProgrammingIfNeeded([card], workspaceRoot);
    }
}
if (!dispatched) {
    // Dispatch failed — card is already persisted in target column.
    // Generate prompt, copy to clipboard, and signal the webview to glow
    // the copy-prompt button orange.
    const card = this._lastCards.find(c => (c.planId || c.sessionId) === sessionId && c.workspaceRoot === workspaceRoot);
    if (card && workspaceRoot) {
        const prompt = await this._generatePromptForColumn([card], card.column, workspaceRoot, targetColumn);
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

**For the built-in `canDispatch` branch (line 5863):**

The same `moveCardToColumn` call at the top (before the branch) already persists the move. After the dispatch attempt at line 5898, add the `!dispatched` fallback:

```typescript
const dispatched = await vscode.commands.executeCommand<boolean>('switchboard.triggerAgentFromKanban', role, sessionId, instruction, workspaceRoot, targetTerminalOverride);
if (dispatched && workspaceRoot) {
    // ... existing success logic (lines 5899-5917) ...
}
if (!dispatched && workspaceRoot) {
    // Dispatch failed — card is already persisted in target column.
    // Generate prompt, copy to clipboard, and signal the webview.
    const card = this._lastCards.find(c => (c.planId || c.sessionId) === sessionId && c.workspaceRoot === workspaceRoot);
    if (card) {
        const prompt = await this._generatePromptForColumn([card], card.column, workspaceRoot, targetColumn);
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

**For the `canDispatch === false` path (Scenario B):**

When `canDispatch` is false (line 5820), neither the custom-user branch nor the `canDispatch` branch executes. The `moveCardToColumn` call at the top of the handler (added above) already persists the move. The prompt-fallback should also fire here. Add after the `canDispatch` block (after line 5919, before the `_scheduleBoardRefresh` at line 5923):

```typescript
if (!canDispatch && workspaceRoot) {
    // No agent available to dispatch — card is already persisted in target
    // column via moveCardToColumn above. Generate prompt, copy to clipboard,
    // and signal the webview to glow the copy-prompt button.
    const card = this._lastCards.find(c => (c.planId || c.sessionId) === sessionId && c.workspaceRoot === workspaceRoot);
    if (card) {
        const prompt = await this._generatePromptForColumn([card], card.column, workspaceRoot, targetColumn);
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

**Note on `card.column` as source for prompt generation:** The `card` object from `_lastCards` reflects the DB state before the optimistic DOM move. `card.column` is the card's actual source column (e.g. LEAD CODED). This is the correct source for `_generatePromptForColumn(cards, column, workspaceRoot, destinationColumn)` — the `column` parameter is the source column, and `destinationColumn` is the target. Using `card.column` directly is simpler and more correct than the original plan's invented `this._columnToRole(targetColumn) === 'reviewer' ? 'LEAD CODED' : card.column` logic.

### Fix 2: Add `persistColumnOnError` to skip rollback in TaskViewerProvider (Scenario C)

**Step 2a: Add the field to `ConfiguredKanbanDispatchOptions`** (TaskViewerProvider.ts:157):

```typescript
export interface ConfiguredKanbanDispatchOptions {
    targetColumn: string;
    dragDropMode: 'cli' | 'prompt' | 'disabled';
    additionalInstructions?: string;
    instruction?: string;
    workspaceRoot?: string;
    workingDirectory?: string;
    gitProhibitionEnabled?: boolean;
    targetTerminalOverride?: string;
    persistColumnOnError?: boolean;  // NEW — skip column rollback on dispatch failure
}
```

**Step 2b: Skip rollback in `_handleTriggerAgentActionInternal`** (TaskViewerProvider.ts):

At the failure return block (lines 16529-16537), replace:

```typescript
} else {
    // Dispatch failed — roll back the column move
    if (previousColumn) {
        await this._updateKanbanColumnForSession(resolvedWorkspaceRoot, sessionId, previousColumn);
        this._scheduleSidebarKanbanRefresh(resolvedWorkspaceRoot);
    }
    this._view?.webview.postMessage({ type: 'actionTriggered', role, success: false });
    clearDispatchLock();
    return false;
}
```

with:

```typescript
} else {
    // Dispatch failed — roll back the column move UNLESS the caller has
    // taken responsibility for persisting the column (kanban drag-dispatch
    // persists the move independently and handles the fallback prompt).
    if (!options?.persistColumnOnError && previousColumn) {
        await this._updateKanbanColumnForSession(resolvedWorkspaceRoot, sessionId, previousColumn);
        this._scheduleSidebarKanbanRefresh(resolvedWorkspaceRoot);
    }
    this._view?.webview.postMessage({ type: 'actionTriggered', role, success: false });
    clearDispatchLock();
    return false;
}
```

At the catch block (lines 16539-16556), apply the same guard:

```typescript
} catch (e) {
    // Dispatch failed — roll back UNLESS caller persists column on error
    if (!options?.persistColumnOnError && previousColumn) {
        await this._updateKanbanColumnForSession(resolvedWorkspaceRoot, sessionId, previousColumn);
        this._scheduleSidebarKanbanRefresh(resolvedWorkspaceRoot);
    }
    this._view?.webview.postMessage({ type: 'actionTriggered', role, success: false });
    clearDispatchLock();
    await this._logEvent('dispatch', {
        event: 'dispatch_failed',
        role,
        sessionId,
        targetAgent,
        error: String(e)
    }, requestId);
    vscode.window.showErrorMessage(`Failed to send message: ${e}`);
    return false;
}
```

**Step 2c: Pass `persistColumnOnError: true` in `dispatchConfiguredKanbanColumnAction`** (TaskViewerProvider.ts:3017-3024):

Add `persistColumnOnError: true` to the `dispatchOptions` object:

```typescript
const dispatchOptions: Partial<ConfiguredKanbanDispatchOptions> = {
    targetColumn: normalizedTargetColumn,
    dragDropMode: options.dragDropMode,
    additionalInstructions: String(options.additionalInstructions || '').trim() || undefined,
    instruction: options.instruction,
    workspaceRoot: resolvedWorkspaceRoot,
    targetTerminalOverride: options.targetTerminalOverride,
    persistColumnOnError: true  // NEW — kanban drag-dispatch persists column on error
};
```

This covers the custom-user branch of `triggerAction` (which calls `dispatchConfiguredKanbanColumnAction`).

**Step 2d: Pass `persistColumnOnError: true` in the `triggerAgentFromKanban` command** (extension.ts:1252):

All calls to `triggerAgentFromKanban` are from the kanban drag-dispatch path, so hardcode the flag:

```typescript
const triggerFromKanbanDisposable = vscode.commands.registerCommand('switchboard.triggerAgentFromKanban', async (role: string, sessionId: string, instruction?: string, workspaceRoot?: string, targetTerminalOverride?: string) => {
    return await taskViewerProvider.handleKanbanTrigger(role, sessionId, instruction, workspaceRoot, { targetTerminalOverride, persistColumnOnError: true } as any);
});
```

This covers the built-in `canDispatch` branch of `triggerAction` (which calls the `triggerAgentFromKanban` command).

**Why hardcode instead of thread through?** The `triggerAgentFromKanban` command signature accepts only `(role, sessionId, instruction?, workspaceRoot?, targetTerminalOverride?)` — it does not accept arbitrary options. Changing the command signature would break all existing callers. Since ALL calls to this command are from kanban drag-dispatch, hardcoding `persistColumnOnError: true` in the command handler is correct and safe. The sidebar dispatch path (line 9734) calls `_handleTriggerAgentAction` directly without going through the command, so it is unaffected and retains rollback behavior.

### Fix 3: Webview — Agent unavailable sends `moveCardForward` (Scenario A)

In `kanban.html`, when `isColumnAgentAvailable(group.targetColumn)` returns false at line 5871, instead of silently returning, send `moveCardForward` to persist the move:

```javascript
// kanban.html, line 5871:
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

**Deliberate tradeoff — no orange glow for Scenario A:** Scenario A has no backend dispatch attempt, so the backend never knows the prompt was needed. The `dispatchFailedPromptReady` message is only sent from the backend (Scenarios B & C). For Scenario A, the card is persisted via `moveCardForward` and the user can click the copy-prompt button manually if they want the prompt. This asymmetry is intentional — adding a prompt-copy for Scenario A would require either a new webview-to-backend round-trip or duplicating prompt generation logic in the webview, both of which add complexity for a scenario where the user explicitly has no agent configured.

### Fix 4: Webview — Orange glow on copy-prompt button + message handler

Add CSS for the orange glow state on the copy-prompt button (in the existing `<style>` block, near the `.card-btn.copy.copied` rule at line 1032):

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

Add a message handler in the webview's message switch (near the existing `copyPlanLinkResult` handler at lines 6536-6543, which uses the same selector pattern):

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

**Verified:** The copy-prompt button at line 5473 has both `data-plan-id` and `data-session` attributes. The `status-message` element exists at line 2590. The selector pattern mirrors the existing `copyPlanLinkResult` handler at lines 6536-6543.

## Files to Modify

1. **`src/services/KanbanProvider.ts`**
   - `triggerAction` handler (line 5806): call `moveCardToColumn` before any dispatch branch; add `!dispatched` prompt-fallback for both custom-user and built-in branches; add `!canDispatch` prompt-fallback
   - `triggerBatchAction` handler (line 5926): **NO CHANGE** — batch path already persists columns on failure via `handleKanbanBatchTrigger` which has no rollback

2. **`src/services/TaskViewerProvider.ts`**
   - `ConfiguredKanbanDispatchOptions` type (line 157): add `persistColumnOnError?: boolean`
   - `_handleTriggerAgentActionInternal` (line 16202): add `if (!options?.persistColumnOnError && previousColumn)` guard around rollback in both the failure return (line 16531) and catch block (line 16541)
   - `dispatchConfiguredKanbanColumnAction` (line 3017): add `persistColumnOnError: true` to `dispatchOptions`

3. **`src/webview/kanban.html`**
   - CSS: add `.card-btn.copy.prompt-ready` glow animation (near line 1032)
   - Message handler: add `dispatchFailedPromptReady` case (near line 6536)
   - `isColumnAgentAvailable` guard (line 5871): send `moveCardForward` instead of silent return

4. **`src/extension.ts`**
   - `triggerAgentFromKanban` command (line 1252): add `persistColumnOnError: true` to the options object

## Non-Goals

- No change to the batch dispatch path (`handleKanbanBatchTrigger`) — it already persists columns on failure.
- No change to the sidebar dispatch path (`triggerAgentAction` at line 9734) — sidebar dispatches should retain rollback behavior since there's no optimistic UI move to protect.
- No change to `promptOnDrop` or `moveCardForward`/`moveCardBackwards` paths — they already persist to DB correctly.
- No prompt-copy or orange glow for Scenario A (agent unavailable in webview) — deliberate tradeoff documented above.
- No new "move back" button — the user can drag the card back manually if they disagree with the target column after a failed dispatch.

## Verification Plan

### Automated Tests

No automated test suite changes required. The change spans webview DOM behavior and backend dispatch logic, which are not covered by the existing test harness. All verification is manual.

### Manual Verification

1. **Scenario A test:** Unassign the reviewer agent. Drag a card from LEAD CODED to CODE REVIEWED. Verify:
   - Card stays in CODE REVIEWED (no bounce)
   - DB shows CODE REVIEWED (via sqlite3 query)
   - Reload window — card still in CODE REVIEWED
   - No orange glow (deliberate — Scenario A gets no glow)

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

6. **Batch dispatch test:** Drag multiple cards to a dispatch column. Verify all cards persist their move regardless of dispatch outcome (batch path unchanged).

7. **Sidebar dispatch regression:** Trigger a dispatch from the sidebar (not kanban drag). Force a failure. Verify the card **does** roll back (sidebar path retains rollback behavior).

8. **Custom-user column dispatch:** Configure a custom kanban column with a user-defined dispatch. Drag a card to it with the agent unavailable. Verify card stays, orange glow appears, prompt in clipboard.

## Recommendation

Complexity 7 → **Send to Lead Coder**.

## Review Findings

**Reviewed:** `src/services/KanbanProvider.ts` (triggerAction handler), `src/services/TaskViewerProvider.ts` (persistColumnOnError plumbing + rollback guards), `src/extension.ts` (command handler), `src/webview/kanban.html` (CSS glow + message handler + Scenario A moveCardForward). Two MAJOR findings fixed: (1) **Stale `card.column` race** — `moveCardToColumn` writes to DB before dispatch; a concurrent board refresh (scheduled by `_handleTriggerAgentActionInternal` via `_scheduleSidebarKanbanRefresh` → `_scheduleBoardRefresh`, 100ms debounce) updates `_lastCards` during the dispatch await, making `card.column` equal `targetColumn` instead of the source column. Fix: capture `sourceColumnForPrompt` from `_lastCards` BEFORE `moveCardToColumn` and use it in all four prompt-fallback locations (KanbanProvider.ts:6394-6401, 6453-6454, 6470-6471, 6528-6529, 6546-6547). (2) **Missing prompt fallback for custom-user `canRunConfiguredDispatch === false`** — when a custom-user column has `dragDropMode='cli'` and the agent is unavailable, the `if (canRunConfiguredDispatch)` block is skipped and the branch breaks before reaching the `!canDispatch` fallback. Fix: added `else` clause at KanbanProvider.ts:6464-6479 with the same prompt-fallback pattern. Two NITs deferred: redundant `moveCardToColumn` at line 6489 (IDE Lead mode, pre-existing), and `status-message` retains `flashing` class after animation (consistent with existing pattern). TypeScript typecheck: no new errors (5 pre-existing TS2835 errors in unrelated files). Remaining risk: the `sourceColumnForPrompt` guard (`&& sourceColumnForPrompt`) silently skips the prompt fallback if the card isn't in `_lastCards` — this is safe because if the card isn't in `_lastCards`, the prompt can't be generated anyway.
