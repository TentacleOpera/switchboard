# Fix Copy Coder Prompt Kanban Move Reliability

## Goal

Fix the bug where clicking "copy coder prompt" on a kanban card sometimes fails to advance the card to the next column on the first click, requiring a second click to succeed.

## Metadata

- **Tags:** [bugfix, reliability, workflow]
- **Complexity:** 3

## User Review Required

- [ ] Confirm the preferred UX when advance fails: show warning message vs. silent retry
- [ ] Confirm whether double-click protection is desired (disable button during advance)

## Problem

When clicking the "copy coder prompt" button on a kanban card, the prompt is copied to clipboard but the card sometimes fails to advance to the next column on the first click. A second click typically succeeds. The button tooltip says "Copy prompt and advance", indicating it should perform both actions.

## Root Cause

The column advance logic in `_handleCopyPlanLink` (TaskViewerProvider.ts:12690-12763) is wrapped in a fire-and-forget async function:

```typescript
void (async () => {
    try {
        // ... column advance logic
    } catch (bgError) {
        console.error(`[TaskViewerProvider] Background post-copy error for ${sessionId}:`, bgError);
    }
})();
```

This pattern causes the following issues:

1. **Race with return**: The function returns `true` at line 12765 before the column advance completes. If the user clicks again quickly, the second click may read stale DB state or conflict with the still-running first advance.
2. **DB re-read race**: The fire-and-forget block re-reads `effectiveColumn` and `planRecord` from DB (lines 12692-12704) even though these values were already resolved in the outer scope (lines 12618-12631). The re-read can return stale data if the DB hasn't settled.
3. **Outer catch swallows errors**: The outer catch at line 12760 only logs to console — no user notification for advance failures at that level. (Note: the inner catch at lines 12755-12758 already shows `showWarningMessage`, but the outer catch does not.)
4. **No retry mechanism**: If the advance fails, there's no retry or user notification at the outer level.

## Evidence

- Button tooltip: "Copy prompt and advance" (kanban.html:3970)
- Fire-and-forget pattern: TaskViewerProvider.ts:12690 (`void (async () => {`)
- Column advance logic: TaskViewerProvider.ts:12730-12736 (`_applyManualKanbanColumnChange`)
- Outer catch (no user notification): TaskViewerProvider.ts:12760-12762
- Inner catch (has user notification): TaskViewerProvider.ts:12755-12758
- User report: First click didn't move plan, second click did

## Complexity Audit

### Routine
- Remove `void (async () => { ... })();` wrapper and move advance logic into main try block
- Reuse outer-scope variables (`effectiveColumn`, `role`, `planRecord`) instead of re-reading from DB
- Add `showWarningMessage` to outer catch block

### Complex / Risky
- None

## Edge-Case & Dependency Audit

- **Race Conditions**: Double-click before first advance completes — mitigated by awaiting advance before return. The UI button should ideally be disabled during advance, but this is a separate enhancement.
- **Security**: No security implications — this is a UI reliability fix.
- **Side Effects**: Awaiting the column advance adds a small delay before `return true`, but the clipboard copy (line 12677) and `copyPlanLinkResult` message (lines 12681-12686) still happen immediately before the advance, so user feedback remains fast.
- **Dependencies & Conflicts**: The existing integration test at `src/test/plan-creation-integration-sync-regression.test.js` checks for the pattern `_handleCopyPlanLink` → `_applyManualKanbanColumnChange` → `queueIntegrationSyncForSession`. This pattern is preserved in the fix.

## Dependencies

- None

## Adversarial Synthesis

Key risks: double-click race during slow advance, existing integration test pattern must be preserved. Mitigations: awaiting advance before return eliminates the fire-and-forget race; reusing outer-scope variables avoids DB re-read races; the integration test pattern is unchanged.

## Fix

### Primary Fix: Await column advance using outer-scope variables

Remove the fire-and-forget wrapper and move the column advance logic into the main try block, reusing the already-resolved `effectiveColumn`, `role`, and `planRecord` variables from the outer scope (lines 12618-12642). This eliminates the DB re-read race and ensures the advance completes before the function returns.

**File:** `src/services/TaskViewerProvider.ts`

**Current code (lines 12688-12765):**
```typescript
// Fire-and-forget: column advance, integration sync, sidebar refresh
// All failures are logged to console; non-blocking warning shown if advance fails
void (async () => {
    try {
        let effectiveColumnBg = column || '';
        let planRecordBg: KanbanPlanRecord | null = null;
        const dbBg = await this._getKanbanDb(resolvedWorkspaceRoot);
        if (dbBg) {
            planRecordBg = sessionId ? await dbBg.getPlanBySessionId(sessionId) : null;
            if (!planRecordBg && planId) {
                planRecordBg = await dbBg.getPlanByPlanFile(planId, await this._getWorkspaceIdForRoot(resolvedWorkspaceRoot));
            }
            if (!effectiveColumnBg && planRecordBg?.kanbanColumn) {
                effectiveColumnBg = planRecordBg.kanbanColumn;
            }
        }
        effectiveColumnBg = this._normalizeLegacyKanbanColumn(effectiveColumnBg || 'CREATED');

        const customAgentsBg = await this.getCustomAgents(resolvedWorkspaceRoot);
        let roleBg: string;
        if (effectiveColumnBg === 'PLAN REVIEWED' && this._kanbanProvider) {
            const complexity = await this._kanbanProvider.getComplexityFromPlan(resolvedWorkspaceRoot, planFileAbsolute);
            roleBg = this._kanbanProvider.resolveRoutedRole(parseComplexityScore(complexity));
        } else {
            roleBg = columnToPromptRole(effectiveColumnBg) || 'coder';
        }

        const isTesterEligible = effectiveColumnBg === 'CODE REVIEWED' && roleBg === 'tester'
            && await this._isAcceptanceTesterActive(resolvedWorkspaceRoot);
        const workflowName = effectiveColumnBg === 'CREATED'
            ? 'improve-plan'
            : effectiveColumnBg === 'PLAN REVIEWED'
                ? (roleBg === 'lead' ? 'handoff-lead' : 'handoff')
                : this._isCompletedCodingColumn(effectiveColumnBg)
                    ? 'reviewer-pass'
                    : isTesterEligible
                        ? 'tester-pass'
                    : undefined;
        if (workflowName) {
            try {
                const targetColumn = this._targetColumnForRole(roleBg);
                if (targetColumn) {
                    const advanced = await this._applyManualKanbanColumnChange(
                        sessionId,
                        targetColumn,
                        workflowName,
                        `Auto-advanced after copying ${roleBg} prompt`,
                        resolvedWorkspaceRoot
                    );
                    if (advanced) {
                        await this._kanbanProvider?.queueIntegrationSyncForSession(
                            resolvedWorkspaceRoot,
                            sessionId,
                            targetColumn
                        );
                        await this._kanbanProvider?._recordDispatchIdentity(
                            resolvedWorkspaceRoot, sessionId, targetColumn, undefined, true
                        );
                        this._scheduleSidebarKanbanRefresh(resolvedWorkspaceRoot);
                        console.log(`[TaskViewerProvider] _handleCopyPlanLink: card advanced to ${targetColumn} for ${sessionId} via workflow '${workflowName}'`);
                    } else {
                        console.warn(`[TaskViewerProvider] _handleCopyPlanLink: column advance failed for ${sessionId} — copy succeeded but card remains in place`);
                        vscode.window.showWarningMessage('Prompt copied but card could not be advanced. Try refreshing the board.');
                    }
                } else {
                    await this._updateSessionRunSheet(sessionId, workflowName);
                }
            } catch (updateError) {
                console.error(`[TaskViewerProvider] Failed to auto-advance card after copy for ${sessionId}:`, updateError);
                vscode.window.showWarningMessage('Prompt copied but card advance errored. Try refreshing the board.');
            }
        }
    } catch (bgError) {
        console.error(`[TaskViewerProvider] Background post-copy error for ${sessionId}:`, bgError);
    }
})();

return true;
```

**Fixed code (replaces lines 12688-12765):**
```typescript
// Await column advance to ensure reliability — reuse outer-scope variables
// (effectiveColumn, role, planRecord already resolved at lines 12618-12642)
const isTesterEligible = effectiveColumn === 'CODE REVIEWED' && role === 'tester'
    && await this._isAcceptanceTesterActive(resolvedWorkspaceRoot);
const workflowName = effectiveColumn === 'CREATED'
    ? 'improve-plan'
    : effectiveColumn === 'PLAN REVIEWED'
        ? (role === 'lead' ? 'handoff-lead' : 'handoff')
        : this._isCompletedCodingColumn(effectiveColumn)
            ? 'reviewer-pass'
            : isTesterEligible
                ? 'tester-pass'
            : undefined;
if (workflowName) {
    try {
        const targetColumn = this._targetColumnForRole(role);
        if (targetColumn) {
            const advanced = await this._applyManualKanbanColumnChange(
                sessionId,
                targetColumn,
                workflowName,
                `Auto-advanced after copying ${role} prompt`,
                resolvedWorkspaceRoot
            );
            if (advanced) {
                await this._kanbanProvider?.queueIntegrationSyncForSession(
                    resolvedWorkspaceRoot,
                    sessionId,
                    targetColumn
                );
                await this._kanbanProvider?._recordDispatchIdentity(
                    resolvedWorkspaceRoot, sessionId, targetColumn, undefined, true
                );
                this._scheduleSidebarKanbanRefresh(resolvedWorkspaceRoot);
                console.log(`[TaskViewerProvider] _handleCopyPlanLink: card advanced to ${targetColumn} for ${sessionId} via workflow '${workflowName}'`);
            } else {
                console.warn(`[TaskViewerProvider] _handleCopyPlanLink: column advance failed for ${sessionId} — copy succeeded but card remains in place`);
                vscode.window.showWarningMessage('Prompt copied but card could not be advanced. Try refreshing the board.');
            }
        } else {
            await this._updateSessionRunSheet(sessionId, workflowName);
        }
    } catch (updateError) {
        console.error(`[TaskViewerProvider] Failed to auto-advance card after copy for ${sessionId}:`, updateError);
        vscode.window.showWarningMessage('Prompt copied but card advance errored. Try refreshing the board.');
    }
}

return true;
```

### Secondary Fix: Add user notification to outer catch

The outer catch at line 12766 (now wrapping the entire function) already shows an error for clipboard failures. No additional change needed — the advance errors are now handled within the main try block above.

## Proposed Changes

### src/services/TaskViewerProvider.ts
- **Context**: `_handleCopyPlanLink` method (lines 12598-12778)
- **Logic**: Remove the `void (async () => { ... })();` fire-and-forget wrapper (lines 12688-12763). Move the column advance logic into the main try block, directly after the clipboard write and `copyPlanLinkResult` message. Reuse the outer-scope variables `effectiveColumn`, `role`, and `planRecord` (already resolved at lines 12618-12642) instead of re-reading from DB with `Bg`-suffixed duplicates.
- **Implementation**: Replace lines 12688-12765 with the fixed code above. The key changes are:
  1. Remove `void (async () => {` at line 12690 and `})();` at line 12763
  2. Replace `effectiveColumnBg` with `effectiveColumn`, `roleBg` with `role`, `planRecordBg` with `planRecord`, `customAgentsBg` with `customAgents`, `dbBg` with `db`
  3. Remove the redundant DB re-read block (old lines 12692-12704) — these values are already in scope
  4. Remove the redundant `effectiveColumnBg = this._normalizeLegacyKanbanColumn(...)` and `roleBg` resolution — already done in outer scope
  5. Keep the existing inner try/catch with `showWarningMessage` calls
  6. Remove the outer `catch (bgError)` block that only logs to console — advance errors are now in the main try block
- **Edge Cases**: If `effectiveColumn` or `role` are somehow undefined in the outer scope (shouldn't happen given the defaults), the existing fallback logic (`|| 'CREATED'`, `|| 'coder'`) at lines 12631 and 12641 handles this.

## Implementation Notes

- The fix removes the fire-and-forget pattern and properly awaits the column advance
- The advance now uses outer-scope variables instead of re-reading from DB, eliminating the DB read race
- Errors are shown to the user via existing `vscode.window.showWarningMessage` calls
- The prompt copy still happens immediately (line 12677), so user feedback is fast
- The `copyPlanLinkResult` message is still sent immediately (lines 12681-12686), so the UI updates before the advance
- The column advance happens after the copy, so even if it fails, the user still gets the prompt
- The existing integration test pattern (`_handleCopyPlanLink` → `_applyManualKanbanColumnChange` → `queueIntegrationSyncForSession`) is preserved

## Verification Plan

### Automated Tests
- Run existing test: `node src/test/plan-creation-integration-sync-regression.test.js` — must still pass (verifies the `_handleCopyPlanLink` → `_applyManualKanbanColumnChange` → `queueIntegrationSyncForSession` pattern is preserved)

### Manual Testing
1. Click "copy coder prompt" on a plan in CREATED column
2. Verify prompt is copied to clipboard
3. Verify plan advances to next column (PLAN REVIEWED or appropriate target) on the FIRST click
4. Repeat for plans in different columns (PLAN REVIEWED, LEAD CODED, etc.)
5. Verify that if advance fails, a warning is shown

### Regression Testing
- Verify prompt copy still works immediately
- Verify integration sync still fires after successful advance
- Verify sidebar refresh still happens after successful advance
- Test with plans that have complexity-based routing (PLAN REVIEWED)

## Recommendation

Complexity 3 → **Send to Coder**

## Review and Execution

**Stage 1: Grumpy Review**
- **NIT:** The plan references line numbers (12688-12765) that do not perfectly align with the current file state. However, the logic and exact lines are easily identifiable, so it is a non-issue.
- **NIT:** The plan accurately identifies that we copy the clipboard and post `copyPlanLinkResult` first, and then conditionally advance. This maintains fast feedback loops for the UI.
- **MAJOR:** Did we actually implement the async await sequence properly for `_applyManualKanbanColumnChange` inside `TaskViewerProvider.ts`? Checking the file content, `const advanced = await this._applyManualKanbanColumnChange(...)` is correctly invoked in the main try-block without the fire-and-forget wrapper.

**Stage 2: Balanced Synthesis**
- The removal of `void (async () => { ... })();` was applied cleanly.
- Outer-scope variables (`effectiveColumn`, `role`, `planRecord`) are effectively reused, eliminating the DB race conditions.
- Test `plan-creation-integration-sync-regression.test.js` continues to pass, validating that `queueIntegrationSyncForSession` is called after successful progression.
- No code fixes are necessary as the plan instructions were cleanly integrated into `src/services/TaskViewerProvider.ts`.

**Execution:**
- **Code Fixes:** No code fixes required.
- **Validation:** 
  - Ran `node src/test/plan-creation-integration-sync-regression.test.js` successfully. Output: `plan creation integration sync regression test passed`.
- **Remaining Risks:** If the DB operation `_applyManualKanbanColumnChange` hangs, it could delay returning `true` to the caller, though clipboard data and messages are already posted to the UI so the perceived impact is minimal. User warning messages for failure cases have been correctly preserved.
