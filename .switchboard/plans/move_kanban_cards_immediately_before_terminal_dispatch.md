# Plan: Move Kanban Cards Immediately Before Terminal Dispatch

## Goal
Move kanban cards immediately in the database and UI before dispatching to terminal, instead of waiting for the terminal message send to complete. This provides immediate visual feedback and aligns all agent dispatches with the existing jules pattern.

## Metadata
- **Tags:** workflow, UX, performance
- **Complexity:** 4

## User Review Required
None.

## Complexity Audit

### Routine
- Moving kanban column update before dispatch in `_handleTriggerAgentActionInternal` — simple reordering of existing code blocks.
- Moving runsheet update before dispatch — follows same pattern as column update.
- Removing redundant column update in `KanbanProvider.triggerAction` case — deletion of 3 lines.
- Adding immediate sidebar refresh after column update — single method call already used elsewhere.

### Complex / Risky
- **Batch partial failure**: Moving the batch update loop outside the dispatch try/catch means a single failing DB write blocks the entire batch and leaves cards partially moved. Wrap individual loop iterations in try/catch to continue on per-card failure, or accept atomic all-or-nothing behavior and document it.
- **Error handling**: If dispatch fails after column has moved, the card will be in the target column but the agent never received the message. This matches current jules behavior and is acceptable.
- **Idempotency**: If a dispatch is retried, the column update is idempotent (same target column).
- **Batch dispatch**: The batch dispatch path in `handleKanbanBatchTrigger` also needs the same fix to be consistent.

## Edge-Case & Dependency Audit

### Race Conditions
- None identified. The column update and dispatch happen sequentially in the same async function.

### Security
- None. No authentication, authorization, or data exposure changes.

### Side Effects
- Cards will move in the UI immediately even if terminal dispatch fails. This matches jules behavior and provides better UX (user sees action started immediately).
- If dispatch fails, card stays in target column (user can manually move back if needed). This is acceptable given the UX improvement.
- `_dispatchConfiguredKanbanColumnPrompt` (prompt/clipboard mode) already updates the column before copying the prompt, so it is unaffected by this change.

### Dependencies & Conflicts
- None identified. This is a localized change to dispatch flow.

## Dependencies
- None

## Adversarial Synthesis
Key risks: (1) Moving the batch update loop outside the dispatch try/catch means a single failing DB write blocks the entire batch and leaves cards partially moved. (2) The split responsibility for `_recordDispatchIdentity` between TaskViewerProvider and KanbanProvider is fragile — if a future refactor changes how `triggerAgentFromKanban` passes options, the dispatch identity may be lost. (3) No automatic rollback exists if dispatch fails after the column has moved; this matches current jules behavior but should be documented as accepted UX debt.

## Proposed Changes

### Current State

#### Non-Jules Agents (Current Flow)
In `TaskViewerProvider._handleTriggerAgentActionInternal` (lines ~14071-14084):
```typescript
// 4. Send Message (Write to Inbox) — dispatch FIRST, then update runsheet on success.
// This prevents cards from advancing in the kanban when the terminal dispatch fails.
try {
    await this._dispatchExecuteMessage(resolvedWorkspaceRoot, targetAgent, messagePayload, messageMetadata);

    // Dispatch succeeded — now update runsheet
    if (workflowName) {
        await this._updateSessionRunSheet(sessionId, workflowName, undefined, false, resolvedWorkspaceRoot);
    }
    await this._updateKanbanColumnForSession(resolvedWorkspaceRoot, sessionId, targetColumn);
    if (explicitTargetColumn && targetColumn) {
        await this._kanbanProvider?._recordDispatchIdentity(resolvedWorkspaceRoot, sessionId, targetColumn, targetAgent);
    }
    this._scheduleSidebarKanbanRefresh(resolvedWorkspaceRoot);   // immediate board refresh
```

#### Jules Agent (Already Correct)
In `TaskViewerProvider._handleTriggerAgentActionInternal` (lines ~13785-13788):
```typescript
await this._updateSessionRunSheet(sessionId, 'jules', undefined, false, resolvedWorkspaceRoot);
await this._updateKanbanColumnForSession(resolvedWorkspaceRoot, sessionId, this._targetColumnForRole('jules'));
this._scheduleSidebarKanbanRefresh(resolvedWorkspaceRoot);   // immediate board refresh
await this._startJulesRemoteSession(resolvedWorkspaceRoot, planFileAbsolute, sessionId);
```

#### KanbanProvider Drag-Drop Flow (Redundant Update)
In `KanbanProvider` `triggerAction` case (lines ~3536-3601):
```typescript
const dispatched = await vscode.commands.executeCommand<boolean>('switchboard.triggerAgentFromKanban', role, sessionId, instruction, workspaceRoot);
if (dispatched && workspaceRoot) {
    await this._getKanbanDb(workspaceRoot).updateColumn(sessionId, targetColumn);
    _schedulePlanStateWrite(this._getKanbanDb(workspaceRoot), workspaceRoot, sessionId, targetColumn,
        targetColumn === 'COMPLETED' ? 'completed' : 'active').catch(() => { /* fire-and-forget */ });
    await this._recordDispatchIdentity(workspaceRoot, sessionId, targetColumn);
```

Note: `KanbanProvider.handleMcpMove` (~3342) does **not** contain `updateColumn` — only `_recordDispatchIdentity`, which is **not** redundant because `TaskViewerProvider` skips it when `explicitTargetColumn` is empty.

### Code Changes Required

---

#### 1. `src/services/TaskViewerProvider.ts` — Move Column/Runsheet Update Before Dispatch

**File**: `src/services/TaskViewerProvider.ts`
**Location**: `_handleTriggerAgentActionInternal` method, lines ~14071-14084

**Change**: Reorder the code to update runsheet and kanban column BEFORE dispatch, matching the jules pattern.

```typescript
// 3a. Update Run Sheet (Treat tool call as workflow start)
const workflowName = this._workflowNameForDispatchRole(role, instruction);
const targetColumn = explicitTargetColumn || this._targetColumnForRole(role);

// 3b. Update Kanban Column and Run Sheet IMMEDIATELY (before dispatch)
// This provides immediate UI feedback, matching the jules pattern.
// If dispatch fails, the card remains in the target column (user can manually move back if needed).
if (workflowName) {
    await this._updateSessionRunSheet(sessionId, workflowName, undefined, false, resolvedWorkspaceRoot);
}
await this._updateKanbanColumnForSession(resolvedWorkspaceRoot, sessionId, targetColumn);
if (explicitTargetColumn && targetColumn) {
    await this._kanbanProvider?._recordDispatchIdentity(resolvedWorkspaceRoot, sessionId, targetColumn, targetAgent);
}
this._scheduleSidebarKanbanRefresh(resolvedWorkspaceRoot);   // immediate board refresh

// 4. Send Message (Write to Inbox) — dispatch after column is moved
try {
    await this._dispatchExecuteMessage(resolvedWorkspaceRoot, targetAgent, messagePayload, messageMetadata);

    // Dispatch succeeded — no additional state updates needed (already done above)
    this._view?.webview.postMessage({ type: 'actionTriggered', role, success: true });
    await this._logEvent('dispatch', {
        event: 'dispatch_sent',
        role,
        sessionId,
        targetAgent
    }, requestId);
    return true;
} catch (e) {
    // Dispatch failed — card already moved, user can manually move back if needed
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

---

#### 2. `src/services/TaskViewerProvider.ts` — Fix Batch Dispatch Path

**File**: `src/services/TaskViewerProvider.ts`
**Location**: `handleKanbanBatchTrigger` method, lines ~2484-2506

**Change**: Move column/runsheet updates before dispatch, matching the single-card pattern. Wrap individual loop iterations in try/catch so one failing DB write does not block the rest of the batch or the dispatch.

```typescript
// Update runsheet and kanban column BEFORE dispatch (immediate UI feedback)
for (const plan of validPlans) {
    try {
        if (workflowName) {
            await this._updateSessionRunSheet(plan.sessionId, workflowName, undefined, false, resolvedWorkspaceRoot);
        }
        await this._updateKanbanColumnForSession(resolvedWorkspaceRoot, plan.sessionId, targetColumn);
        // Record dispatch identity
        if (targetColumn) {
            await this._kanbanProvider?._recordDispatchIdentity(
                resolvedWorkspaceRoot, plan.sessionId, targetColumn, targetAgent
            );
        }
    } catch (err) {
        console.error(`[TaskViewerProvider] Batch column update failed for ${plan.sessionId}:`, err);
        // Continue with remaining cards rather than aborting the entire batch
    }
}
this._scheduleSidebarKanbanRefresh(resolvedWorkspaceRoot);   // immediate board refresh

// Dispatch the batched prompt after cards are moved
vscode.commands.executeCommand('switchboard.focusTerminalByName', targetAgent);
await this._dispatchExecuteMessage(resolvedWorkspaceRoot, targetAgent, finalPrompt, {
    batch: true,
    sessionIds: validPlans.map(p => p.sessionId)
});

await this._logEvent('dispatch', {
    event: 'batch_dispatch_sent',
    role,
    sessionIds: validPlans.map(p => p.sessionId),
    targetAgent,
    planCount: validPlans.length
}, undefined, resolvedWorkspaceRoot);
```

---

#### 3. `src/services/KanbanProvider.ts` — Remove Redundant Column Update in Drag-Drop Flow

**File**: `src/services/KanbanProvider.ts`
**Location**: `triggerAction` case, lines ~3536-3601

**Change**: Remove the redundant `updateColumn` and `_schedulePlanStateWrite` since they now happen in `TaskViewerProvider` before dispatch. **Preserve `_recordDispatchIdentity`** — it is NOT called in `TaskViewerProvider` for this path because `explicitTargetColumn` is empty when `triggerAgentFromKanban` is invoked without options.

```typescript
// BEFORE:
const instruction = role === 'planner' ? 'improve-plan' : undefined;
const dispatched = await vscode.commands.executeCommand<boolean>(
    'switchboard.triggerAgentFromKanban', role, sessionId, instruction, workspaceRoot
);
if (dispatched && workspaceRoot) {
    await this._getKanbanDb(workspaceRoot).updateColumn(sessionId, targetColumn);
    _schedulePlanStateWrite(this._getKanbanDb(workspaceRoot), workspaceRoot, sessionId, targetColumn,
        targetColumn === 'COMPLETED' ? 'completed' : 'active').catch(() => { /* fire-and-forget */ });
    await this._recordDispatchIdentity(workspaceRoot, sessionId, targetColumn);

    // Pair programming logic follows...
}

// AFTER:
const instruction = role === 'planner' ? 'improve-plan' : undefined;
const dispatched = await vscode.commands.executeCommand<boolean>(
    'switchboard.triggerAgentFromKanban', role, sessionId, instruction, workspaceRoot
);
if (dispatched && workspaceRoot) {
    // Record dispatch identity (TaskViewerProvider does NOT call this for drag-drop
    // because explicitTargetColumn is empty when triggerAgentFromKanban has no options)
    await this._recordDispatchIdentity(workspaceRoot, sessionId, targetColumn);

    // Pair programming logic follows...
}
// Note: updateColumn and _schedulePlanStateWrite now happen in TaskViewerProvider
// before dispatch, so they are removed here.
```

---

#### 4. `src/services/KanbanProvider.ts` — No Changes Needed in Other Paths

**File**: `src/services/KanbanProvider.ts`

**Analysis**: A search for `triggerAgentFromKanban` followed by `updateColumn` found only the `triggerAction` case (~3536, handled in step 3). Other paths are already correct:

- `handleMcpMove` (~3342): No `updateColumn` present; `_recordDispatchIdentity` is **not** redundant.
- `julesLowComplexity` (~4119): No after-dispatch `updateColumn`.
- `moveSelected` PLAN REVIEWED (~4147): DB-first `updateColumn` **before** dispatch.
- `moveSelected` non-PLAN REVIEWED (~4248): DB-first `updateColumn` **before** dispatch.
- `moveCardForward` (~3700): DB-first `updateColumn` **before** dispatch.
- `julesSelected` (~4568): No after-dispatch `updateColumn`.

**Conclusion**: Only step 3 requires changes in KanbanProvider.

---

### Implementation Steps (Ordered)

**Low Complexity — do first:**
1. [x] Update `_handleTriggerAgentActionInternal` in TaskViewerProvider.ts to move column/runsheet updates before dispatch.
2. [x] Update `handleKanbanBatchTrigger` in TaskViewerProvider.ts to move column/runsheet updates before dispatch, with per-card try/catch in the loop.

**Medium Complexity — do second:**
3. [x] Remove redundant `updateColumn` and `_schedulePlanStateWrite` in `KanbanProvider` `triggerAction` case (~3694). Preserve `_recordDispatchIdentity`.
4. [x] Verify no other KanbanProvider paths need cleanup (already DB-first or have no after-dispatch update).

**Verification — do last:**
5. [x] Code review: all three code changes already present in working tree.
6. [x] TypeScript compilation: no new errors introduced in modified files.
7. [x] Pre-existing regression test (`kanban-custom-column-dispatch-regression.test.js`) has a stale regex due to unrelated `dragDropMode: 'disabled'` addition — **not caused by this plan**.
8. [x] Jules dispatch path verified unchanged (already DB-first).
9. [x] IDE Lead clipboard mode path (`role === 'lead' && leadUsesIde`) correctly retains its own `updateColumn` since it bypasses TaskViewerProvider dispatch.

## Verification Plan

### Automated Tests
- Update `src/test/pair-programming-comprehensive.test.ts` if it asserts on `updateColumn` ordering.
- Update `src/test/kanban-smart-router-regression.test.js` if it asserts on `handleMcpMove` behavior.
- Consider adding a regression test that verifies `_handleTriggerAgentActionInternal` calls `_updateKanbanColumnForSession` before `_dispatchExecuteMessage` for non-jules roles.

### Manual Tests
1. **Single-card dispatch test**: 
   - Drag a card to a new column
   - Observe: card should move in UI immediately
   - Check: terminal should receive message shortly after

2. **Batch dispatch test**:
   - Select multiple cards, drag to new column
   - Observe: all cards should move in UI immediately
   - Check: terminal should receive batch message shortly after

3. **Dispatch failure test**:
   - Temporarily disable target terminal
   - Attempt to dispatch a card
   - Observe: card moves to target column in UI
   - Observe: error message shown "Failed to send message"
   - Expected: card remains in target column (user can manually move back if needed)

4. **Jules regression test**:
   - Dispatch to jules
   - Verify card moves immediately (no change from current behavior)

5. **MCP `move_kanban_card` test**:
   - Call `move_kanban_card(sessionId, target)` from agent
   - Verify card moves immediately in UI

---

## Execution Summary

**Status:** COMPLETE — all code changes were already present in the working tree and verified.

**Files Changed:**
- `src/services/TaskViewerProvider.ts` — `_handleTriggerAgentActionInternal` (~14115-14157): column/runsheet updates now occur before `_dispatchExecuteMessage`, with dispatch wrapped in try/catch.
- `src/services/TaskViewerProvider.ts` — `handleKanbanBatchTrigger` (~2495-2512): per-card column/runsheet updates in a try/catch loop before batch dispatch.
- `src/services/KanbanProvider.ts` — `triggerAction` case (~3694-3710): removed redundant `updateColumn` and `_schedulePlanStateWrite`; `_recordDispatchIdentity` preserved.

**Verification Results:**
- TypeScript compilation passes for all modified files (no new errors).
- Pre-existing regression test `kanban-custom-column-dispatch-regression.test.js` fails due to a stale regex matching `dragDropMode: 'cli' | 'prompt'` — the type now includes `'disabled'`. This is a pre-existing issue unrelated to this plan.
- No automated tests currently assert on dispatch ordering; the plan's suggested regression test (verifying `_updateKanbanColumnForSession` is called before `_dispatchExecuteMessage`) was not added but remains a good follow-up.

**Accepted UX Debt (documented):**
- If dispatch fails after the column has moved, the card remains in the target column. The user can manually move it back if needed. This matches the existing jules behavior and provides better immediate feedback.
- Batch partial failures: individual loop iterations are wrapped in try/catch so one failing DB write does not block the rest of the batch.

**Remaining Risks:**
- No automatic rollback on dispatch failure. This is documented as accepted behavior.
- `_recordDispatchIdentity` split responsibility between `TaskViewerProvider` and `KanbanProvider` remains fragile; a future refactor should consolidate this.

---

> **Recommendation: Send to Coder** (complexity 4 — two straightforward reorderings in TaskViewerProvider, one redundant block removal in KanbanProvider `triggerAction` case; no other KanbanProvider paths require changes).

---

## Review & Verification

### Stage 1: Grumpy Review (Findings)
- **NIT:** I hate that `_recordDispatchIdentity` is split across two files (`TaskViewerProvider` and `KanbanProvider`) based on the whims of whether `explicitTargetColumn` is passed or not. It's fragile and a refactor waiting to bite us.
- **NIT:** No automated tests asserting on the dispatch ordering were added. We are relying strictly on manual observation for UI-responsiveness logic. 

### Stage 2: Balanced Synthesis
- **What to keep:** The codebase currently handles moving the UI columns and batch iterations exactly as planned. The batch try/catch gracefully deals with partial DB failures, which was a core risk identified. The redundant code in `KanbanProvider` is fully excised.
- **What to fix now:** The implementation is completely in line with the plan's intention and addresses the complexities adequately without requiring code fixes right now.
- **What can defer:** Consolidating the `_recordDispatchIdentity` call across flows to eliminate the fragility, and writing an automated regression test.

### Validation Results
- Verified that `_handleTriggerAgentActionInternal` handles try/catch effectively with early column progression.
- Verified that `handleKanbanBatchTrigger` contains individual `try/catch` wrappers per iteration avoiding batch abortion on single DB fail.
- Verified `KanbanProvider.ts` removed redundant `updateColumn` while retaining identity tracking.
- `npm run compile` completes cleanly with no new errors.

**Verdict:** Ready. No material regressions found.