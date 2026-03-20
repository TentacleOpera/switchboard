# Check implementation of backwards move cards and cli trigger switch

The reviewer said they needed to implement the move cli cards backwards plan from scratch: [Allow plans to be moved backwards in Kanban](file:///c%3A/Users/patvu/Documents/GitHub/switchboard/.switchboard/plans/feature_plan_20260313_140058_allow_plans_to_be_moved_backwards_in_kanban.md)

Can we please check this implementation, and how does it interact with the cli trigger switch at the top of the kanban? is the integration clean?

## Goal
Audit the existing backward-move and CLI trigger switch implementations for correctness, edge cases, and clean integration. This is a **review-only** plan — no new features, just verification and bug fixes if needed.

## Source Analysis

### Backward Move Implementation

**Kanban webview** (`src/webview/kanban.html`, lines 884–968):
- `handleDrop()` splits dragged cards into `forwardIds` and `backwardIds` based on column index comparison.
- Forward moves are gated by `cliTriggersEnabled && isColumnAgentAvailable(targetColumn)` — if the target agent isn't ready, forward moves are blocked.
- Backward moves are **not** gated by agent availability — they always proceed. ✅ Correct behavior.
- Forward IDs dispatch via `triggerAction` / `triggerBatchAction` messages.
- Backward IDs dispatch via `moveCardBackwards` message (line 965).
- Both forward and backward moves get optimistic UI updates (card DOM moved, counts updated).

**KanbanProvider handler** (`src/services/KanbanProvider.ts`, lines 841–847):
```ts
case 'moveCardBackwards': {
    const { sessionIds, targetColumn } = msg;
    await vscode.commands.executeCommand('switchboard.kanbanBackwardMove', sessionIds, targetColumn, workspaceRoot);
}
```
Routes to `TaskViewerProvider.handleKanbanBackwardMove()`.

**TaskViewerProvider** (`src/services/TaskViewerProvider.ts`, lines 826–836):
```ts
public async handleKanbanBackwardMove(sessionIds, targetColumn, workspaceRoot) {
    const workflowName = 'reset-to-' + targetColumn.toLowerCase().replace(/\s+/g, '-');
    for (const sessionId of sessionIds) {
        await this._updateSessionRunSheet(sessionId, workflowName, 'User manually moved plan backwards', true, resolvedWorkspaceRoot);
    }
}
```
Appends a reset event to the runsheet. The column derivation logic (`kanbanColumnDerivation.js`) reads these events to determine the current column.

**Extension registration** (`src/extension.ts`, lines 835–838):
```ts
const kanbanBackwardMoveDisposable = vscode.commands.registerCommand('switchboard.kanbanBackwardMove', async (sessionIds, targetColumn, workspaceRoot) => {
    taskViewerProvider.handleKanbanBackwardMove(sessionIds, targetColumn, workspaceRoot);
});
```

### CLI Trigger Switch Implementation

**Kanban webview** (`src/webview/kanban.html`, lines 481–484, 506–507, 535–552, 1106–1111):
- Toggle checkbox `cli-triggers-toggle` controls `cliTriggersEnabled` boolean.
- When OFF: `triggers-off-badge` shown, title gets `triggers-off` class (dimmed).
- Forward drops are gated: if `cliTriggersEnabled && !isColumnAgentAvailable(targetColumn)`, forward moves are blocked (line 902–904).
- When CLI triggers are OFF (`!cliTriggersEnabled`), the gate at line 902 is **skipped** because the condition is `cliTriggersEnabled && !isColumnAgentAvailable()`. This means cards move freely without agent checks. ✅ Correct.
- **But** — the `postKanbanMessage({ type: 'triggerAction' })` still fires at line 959 even when triggers are off. The backend `KanbanProvider._handleMessage()` for `triggerAction` will still try to dispatch to the agent.

**KanbanProvider** (`src/services/KanbanProvider.ts`):
- `_cliTriggersEnabled` stored in workspace state (line 53).
- Need to verify: does `triggerAction` handler check `_cliTriggersEnabled` before dispatching?

## Issues Found

### Issue 1: Forward trigger fires even when CLI triggers are OFF (Bug)
**Location:** `src/webview/kanban.html` line ~958–961
The `triggerAction` / `triggerBatchAction` messages are posted unconditionally for forward moves. When CLI triggers are OFF, these messages should be suppressed — the user expects a silent move without agent dispatch.

**Fix:** Wrap the forward dispatch in a `cliTriggersEnabled` check:
```js
if (cliTriggersEnabled && forwardIds.length === 1) {
    postKanbanMessage({ type: 'triggerAction', ... });
} else if (cliTriggersEnabled && forwardIds.length > 1) {
    postKanbanMessage({ type: 'triggerBatchAction', ... });
}
```

### Issue 2: Backward move does not update the DB (Potential Bug)
**Location:** `src/services/TaskViewerProvider.ts` line ~826–836
`handleKanbanBackwardMove()` only updates the runsheet JSON. If the kanban DB is active (`KanbanDatabase.ts`), the `kanban_column` field in SQLite is not updated. The next `_refreshBoard()` call will sync from file-based derivation, but there may be a stale window.

**Fix:** After updating the runsheet, also call `db.updateColumn(sessionId, targetColumn)` if the DB is available.

### Issue 3: No column boundary validation on backward moves (Minor)
**Location:** `src/webview/kanban.html` line ~894
The webview splits by column index — dragging to the first column (CREATED) is allowed. There's no check preventing a backward move to a nonsensical position (e.g., CODE REVIEWED → CREATED, skipping intermediate columns). This is probably fine for flexibility but worth documenting as intentional.

## Proposed Changes

### Step 1: Fix CLI trigger gate for forward moves (Bug Fix)
**File:** `src/webview/kanban.html` (~lines 958–962)
- Wrap `triggerAction` and `triggerBatchAction` dispatches in `if (cliTriggersEnabled)` check.

### Step 2: Add DB column update for backward moves (Bug Fix)
**File:** `src/services/TaskViewerProvider.ts` (~line 834)
- After `_updateSessionRunSheet()`, call `this._kanbanProvider?.updateColumnInDb(sessionId, targetColumn, workspaceRoot)` or equivalent.
- If `KanbanDatabase` is available, update the `kanban_column` directly.

### Step 3: Verify column derivation handles reset events (Verification)
**File:** `src/services/kanbanColumnDerivation.js`
- Read and verify that events with workflow `'reset-to-*'` correctly derive to the target column.
- If not, this is a separate bug to fix in the derivation logic.

## Dependencies
- **Plan 4 (separate coder/lead columns):** Adding columns changes the index-based forward/backward determination. Both plans must be coordinated.
- No blocking dependencies for the bug fixes.

## Verification Plan
1. **CLI triggers OFF test:** Toggle CLI triggers OFF → drag card forward → confirm card moves visually but **no agent dispatch** fires (check terminal for absence of CLI command).
2. **CLI triggers ON test:** Toggle ON → drag card forward → confirm agent dispatch fires normally.
3. **Backward move test:** Drag card from CODE REVIEWED to PLAN REVIEWED → confirm card moves, runsheet updated, DB column updated.
4. **Backward move + triggers OFF:** Same test with triggers OFF → confirm backward move works identically.
5. Run `npm run compile`.

## Complexity Audit

### Band A (Routine)
- CLI trigger gate fix (~3 lines in kanban.html).
- DB column update for backward moves (~5 lines in TaskViewerProvider.ts).
- Verification of kanbanColumnDerivation.js (read-only).

### Band B — Complex / Risky
- None.


## Adversarial Review

### Grumpy Critique
- "Issue 1 could have been caught with a simple integration test. Where are the tests?" → Valid. Add a test case for `handleDrop` with `cliTriggersEnabled = false`.
- "Issue 2 is a data consistency bug between file-based and DB-based state. This is a systemic problem." → Partially valid. The DB sync in `_refreshBoard()` catches up, but there's a stale window. Direct DB update is the right fix.
- "You're mixing audit (this plan) with fixes. Should fixes be separate plans?" → Pragmatic to fix here since the fixes are ≤5 lines each.

### Balanced Synthesis
- Both bug fixes are minimal and low-risk. Implement them in this plan rather than creating separate tickets.
- The column derivation verification is read-only — flag any issues as separate plans.
- The forward-trigger-while-off bug is the most impactful fix.

## Agent Recommendation
Send it to the **Coder agent** — two small bug fixes and one verification step. All routine.

## Reviewer Pass Update

### Review Outcome
- Reviewer pass completed in-place against the implemented code.
- The implementation already cleanly handles the originally suspected CLI-trigger integration issue: when CLI triggers are OFF, forward drag moves now use the silent `moveCardForward` path, and the backend `triggerAction` / `triggerBatchAction` handlers also defensively no-op when `_cliTriggersEnabled` is false. Backward moves already update both the runsheet and the Kanban database.
- One material defect remained in the reset derivation layer: `handleKanbanBackwardMove()` emits `reset-to-*` workflow markers for any earlier target column, but `kanbanColumnDerivation.js` only understood resets to `CREATED`, `PLAN REVIEWED`, and `CODED`. That meant backward moves into `CODE REVIEWED` or into a custom Kanban column could snap back to the wrong derived column after a refresh.

### Fixed Items
- Generalized reset-event derivation so `reset-to-code-reviewed` correctly resolves to `CODE REVIEWED`.
- Added support for `reset-to-custom_agent_*` so backward moves into custom Kanban columns survive a board refresh.
- Added a focused regression test covering both the built-in `CODE REVIEWED` reset case and a custom-agent reset case.

### Files Changed During Reviewer Pass
- `src/services/kanbanColumnDerivation.js`
- `src/test/kanban-backward-reset-regression.test.js`

### Validation Results
- `npm run compile` ✅ Passed.
- `node src\test\kanban-backward-reset-regression.test.js` ✅ Passed.
- Review inspection confirmed:
  - CLI triggers OFF uses `moveCardForward` instead of dispatching an agent action.
  - `KanbanProvider` still guards `triggerAction` / `triggerBatchAction` when CLI triggers are disabled.
  - `TaskViewerProvider.handleKanbanBackwardMove()` already updates the Kanban DB column directly.
- `npm run lint` was not rerun for this pass because repository linting remains blocked by the pre-existing ESLint 9 configuration issue (`eslint.config.*` missing).

### Remaining Risks
- There is still no browser-level end-to-end test that drags cards across multiple custom-column orderings and verifies the derived column remains stable after a full refresh.
- Backward moves intentionally allow jumping across intermediate columns. That flexibility appears intentional, but if stricter workflow enforcement is desired later it should be addressed as a separate behavior change.

### Final Reviewer Assessment
- Ready. The CLI-trigger switch integration is clean, and the remaining backward-move reset derivation defect has been corrected and verified.

## Reviewer Continuation Update

### Continuation Outcome
- A deeper follow-up inspection found one more integration cleanliness issue in the CLI-triggers-OFF path.
- Silent forward moves were already avoiding live agent dispatch, but `handleKanbanForwardMove()` still recorded synthetic history using real workflow names such as `improve-plan`, `handoff`, or `reviewer-pass`. That made no-dispatch moves look like actual agent executions in the runsheet/action log, which was misleading.

### Additional Fixes Applied
- Changed silent forward moves to record `move-to-*` workflow markers instead of agent workflow names.
- Extended column derivation so both `reset-to-*` and `move-to-*` markers resolve correctly for built-in columns and custom Kanban columns.
- Expanded the existing regression test to cover forward manual moves into `CODE REVIEWED` and a custom column.

### Additional Files Changed
- `src/services/TaskViewerProvider.ts`
- `src/services/kanbanColumnDerivation.js`
- `src/test/kanban-backward-reset-regression.test.js`

### Additional Validation Results
- `npm run compile` ✅ Passed.
- `node src\test\kanban-backward-reset-regression.test.js` ✅ Passed after extending the assertions for `move-to-*` workflows.

### Additional Remaining Risks
- Historical sessions that already contain manual-forward events encoded as real workflow names will retain that older representation until they are moved again or otherwise updated.
- There is still no browser-level end-to-end test that verifies the ticket action log content after silent forward moves with CLI triggers disabled.
