# advance and prompt buttons do not respect custom terminals

## Goal
Fix bug where "advance to next stage" (moveSelected/moveAll) and prompt buttons (promptSelected/promptAll) skip over custom Kanban columns when routing cards. When a custom terminal is inserted between PLAN REVIEWED and the coder columns, these buttons should advance cards to the custom column, not bypass it to LEAD CODED/CODER CODED.

## User Review Required
> [!NOTE]
> This fix changes the routing logic for moveSelected, moveAll, promptSelected, and promptAll actions. After applying this fix:
> - Cards will advance to the **next column in the sorted Kanban order** (respecting custom terminals)
> - CLI triggers will only fire if the next column has an associated role mapping
> - If the next column is a custom terminal without CLI triggers enabled, cards will move visually but won't auto-trigger the terminal
> - Users should verify that custom terminal columns have `includeInKanban: true` and appropriate `kanbanOrder` values in their agent configuration

## Complexity Audit
### Band A — Routine
- Update `_getNextColumnId` to correctly return the next column in the sorted order (already works correctly)
- Ensure `_columnToRole` returns the custom agent role for custom columns (already works via `column.startsWith('custom_agent_')` check)
- Update moveSelected/moveAll handlers to use `_getNextColumnId` consistently
- Update promptSelected/promptAll handlers to use `_getNextColumnId` for advancement instead of hardcoded workflow-based logic

### Band B — Complex / Risky
- **Prompt button advancement logic**: Currently uses `_advanceSessionsInColumn` which pushes workflow events based on `_workflowForColumn`. This bypasses the visual column order and directly advances cards based on workflow state, not Kanban column order. Need to replace with column-based advancement that respects custom terminals.
- **Workflow vs. Column mismatch**: The `_workflowForColumn` method returns workflows based on hardcoded column names (CREATED → improve-plan, PLAN REVIEWED → handoff, etc.). Custom columns don't have workflow mappings, which could break the advancement logic if not handled carefully.
- **CLI trigger conditional logic**: The code has branching logic for `this._cliTriggersEnabled`. When enabled, it calls `triggerAgentFromKanban` or `triggerBatchAgentFromKanban`. When disabled, it calls `kanbanForwardMove`. This dual-path logic needs to handle custom columns correctly in both branches.
- **Role resolution for custom columns**: Custom columns use their role as the column ID (e.g., `custom_agent_xyz`). The `_columnToRole` method returns this role, but we need to verify that `_canAssignRole` and the trigger commands handle custom agent roles correctly.

## Edge-Case & Dependency Audit
- **Race Conditions**: None identified. The advancement logic is sequential and uses async/await properly.
- **Security**: No security implications. This is internal routing logic.
- **Side Effects**: 
  - **Breaking change for workflows**: If users have custom terminals that expect specific workflow events, changing from workflow-based to column-based advancement might break their expectations. However, the current behavior is already broken (skips custom columns), so this is a net improvement.
  - **CLI trigger behavior**: If a custom column doesn't have a role mapping in `_columnToRole`, the CLI trigger path will fall back to `kanbanForwardMove` (visual move only). This is acceptable behavior.
  - **Prompt generation**: The `_generatePromptForColumn` method uses column-specific logic. Need to verify it handles custom columns gracefully.
- **Dependencies & Conflicts**: 
  - This plan does not conflict with other pending Kanban plans.
  - Depends on the existing `buildKanbanColumns` function correctly sorting columns by `kanbanOrder`.
  - Assumes custom agents have `includeInKanban: true` and valid `kanbanOrder` values to appear in the Kanban board.

## Adversarial Synthesis
### Grumpy Critique
**"Oh, wonderful. Another half-baked routing bug that's been lurking since custom terminals were added. Let me guess—someone hardcoded the workflow logic and forgot that Kanban columns are now DYNAMIC?"**

1. **Workflow-based advancement is fundamentally broken**: The `_advanceSessionsInColumn` method pushes workflow events (`improve-plan`, `handoff`, `review`) based on the SOURCE column, not the DESTINATION column. This is architecturally backwards. Workflows should be triggered when entering a column, not when leaving one. But changing this would require a massive refactor of the workflow system.

2. **The prompt buttons are lying to users**: They say "advance to next stage" but they're actually advancing based on WORKFLOW state, not visual column order. If I have columns ordered as [PLAN REVIEWED] → [Custom QA] → [LEAD CODED], pressing "prompt" from PLAN REVIEWED will skip Custom QA entirely because `_workflowForColumn('PLAN REVIEWED')` returns `'handoff'`, which triggers the lead/coder dispatch logic. This is a UX disaster.

3. **What happens when a custom column has no role?**: If `_columnToRole(nextCol)` returns `null` for a custom column (which shouldn't happen, but defensive coding says it WILL), the CLI trigger path will silently fall back to `kanbanForwardMove`. But the user won't know why their terminal didn't get triggered. Where's the error message? Where's the logging?

4. **The `_workflowForColumn` method is a hardcoded mess**: It only knows about built-in columns. What workflow should a custom column use? You're going to default to `'handoff'`, which might be completely wrong for a custom QA or review terminal. But you can't fix this without adding workflow configuration to the custom agent schema, which is out of scope.

5. **Prompt generation might break**: The `_generatePromptForColumn` method probably has column-specific logic. If it doesn't handle custom columns, you'll generate garbage prompts. Did you even CHECK this method?

6. **Testing nightmare**: How are you going to test this? You need to set up a custom terminal, configure it with `includeInKanban: true`, set a `kanbanOrder` between PLAN REVIEWED and LEAD CODED, create a plan, and then test all four button types (moveSelected, moveAll, promptSelected, promptAll) with both CLI triggers enabled and disabled. That's 8 test cases minimum. Where's your test plan?

### Balanced Response
Grumpy raises valid concerns, but let's address them systematically:

1. **Workflow architecture**: Yes, the workflow-based advancement is backwards, but a full refactor is out of scope. The pragmatic fix is to make prompt buttons use column-based advancement (like move buttons already do) and accept that workflows will be triggered based on the source column. This is consistent with the current architecture.

2. **Prompt button behavior**: Agreed—this is the core bug. The fix is to replace `_advanceSessionsInColumn` in the promptSelected/promptAll handlers with the same column-based logic used in moveSelected/moveAll. This ensures visual column order is respected.

3. **Null role handling**: The `_columnToRole` method already handles custom columns via `column.startsWith('custom_agent_') ? column : null`. Custom columns use their role as the column ID, so this should always return a valid role. However, we should add defensive logging if `role` is null in the CLI trigger path.

4. **Workflow for custom columns**: The `_workflowForColumn` default case returns `'handoff'`, which is reasonable for most custom terminals. If users need custom workflows, that's a future enhancement. For now, we'll document this behavior.

5. **Prompt generation**: I will verify `_generatePromptForColumn` handles custom columns. If it doesn't, we'll add a generic fallback.

6. **Testing**: The verification plan will include manual testing with a custom terminal configured between PLAN REVIEWED and LEAD CODED, testing all four button types with CLI triggers on/off.

## Proposed Changes
> [!IMPORTANT]
> **MAXIMUM DETAIL REQUIRED:** The changes below provide complete, fully functioning code blocks with step-by-step logic breakdowns.

### Background: How the Bug Occurs

The Kanban board supports custom terminals inserted between built-in columns. Custom agents are configured with:
- `includeInKanban: true` to appear in the Kanban board
- `kanbanOrder: <number>` to control their position (e.g., 150 places them between PLAN REVIEWED (100) and LEAD CODED (190))

The `buildKanbanColumns` function in `agentConfig.ts` merges built-in columns with custom columns and sorts them by `kanbanOrder`. This creates a dynamic column order like:
```
[CREATED (0)] → [PLAN REVIEWED (100)] → [custom_agent_qa (150)] → [LEAD CODED (190)] → [CODER CODED (200)] → [CODE REVIEWED (300)]
```

**The bug**: The prompt buttons (`promptSelected`, `promptAll`) use `_advanceSessionsInColumn`, which pushes workflow events based on `_workflowForColumn(column)`. This method has hardcoded mappings:
- `PLAN REVIEWED` → `handoff` workflow
- `LEAD CODED` → `handoff` workflow
- `CODER CODED` → `review` workflow

When a workflow event is pushed, the `deriveKanbanColumn` function (which reads workflow events to determine column position) jumps the card to the workflow's target column, bypassing any custom columns in between.

**The fix**: Replace workflow-based advancement in prompt buttons with column-based advancement (using `_getNextColumnId`), matching the behavior of move buttons.

### Component 1: KanbanProvider.ts - promptSelected Handler

#### MODIFY `c:\Users\patvu\Documents\GitHub\switchboard\src\services\KanbanProvider.ts`

**Context**: The `promptSelected` handler (lines 1236-1252) currently uses `_advanceSessionsInColumn` to advance cards based on workflow events. This bypasses custom columns.

**Logic**:
1. Keep the prompt generation logic (it's column-agnostic)
2. Replace `_advanceSessionsInColumn` with column-based advancement
3. Get the next column using `_getNextColumnId`
4. If CLI triggers are enabled and the next column has a role, trigger the agent
5. If CLI triggers are disabled or the next column has no role, use `kanbanForwardMove` for visual movement
6. Handle the PLAN REVIEWED special case (complexity routing) separately

**Implementation**:

```typescript
case 'promptSelected': {
    const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
    if (!workspaceRoot || !Array.isArray(msg.sessionIds) || msg.sessionIds.length === 0) { break; }
    const column: string = msg.column;
    await this._refreshBoard(workspaceRoot);
    const sourceCards = this._lastCards.filter(card => card.workspaceRoot === workspaceRoot && card.column === column && msg.sessionIds.includes(card.sessionId));
    if (sourceCards.length === 0) {
        vscode.window.showInformationMessage('No matching plans found for prompt generation.');
        break;
    }
    const prompt = this._generatePromptForColumn(sourceCards, column, workspaceRoot);
    await vscode.env.clipboard.writeText(prompt);
    
    // Column-based advancement (respects custom terminals)
    const nextCol = await this._getNextColumnId(column, workspaceRoot);
    if (!nextCol) {
        await this._refreshBoard(workspaceRoot);
        vscode.window.showInformationMessage(`Copied prompt for ${sourceCards.length} plans. No next column to advance to.`);
        break;
    }
    
    // PLAN REVIEWED uses dynamic complexity routing per-session
    if (column === 'PLAN REVIEWED') {
        const groups = await this._partitionByComplexityRoute(workspaceRoot, msg.sessionIds);
        for (const [role, sids] of groups) {
            if (sids.length === 0) { continue; }
            const targetCol = this._targetColumnForDispatchRole(role);
            if (this._cliTriggersEnabled) {
                if (sids.length === 1) {
                    await vscode.commands.executeCommand('switchboard.triggerAgentFromKanban', role, sids[0], undefined, workspaceRoot);
                } else {
                    await vscode.commands.executeCommand('switchboard.triggerBatchAgentFromKanban', role, sids, undefined, workspaceRoot);
                }
            } else {
                await vscode.commands.executeCommand('switchboard.kanbanForwardMove', sids, targetCol, workspaceRoot);
            }
        }
    } else {
        // For all other columns (including custom terminals), advance to next column
        if (this._cliTriggersEnabled) {
            const role = this._columnToRole(nextCol);
            if (role) {
                const instruction = role === 'planner' ? 'improve-plan' : undefined;
                if (msg.sessionIds.length === 1) {
                    await vscode.commands.executeCommand('switchboard.triggerAgentFromKanban', role, msg.sessionIds[0], instruction, workspaceRoot);
                } else {
                    await vscode.commands.executeCommand('switchboard.triggerBatchAgentFromKanban', role, msg.sessionIds, instruction, workspaceRoot);
                }
            } else {
                // Next column has no role mapping, fall back to visual move
                await vscode.commands.executeCommand('switchboard.kanbanForwardMove', msg.sessionIds, nextCol, workspaceRoot);
            }
        } else {
            // CLI triggers disabled, just move visually
            await vscode.commands.executeCommand('switchboard.kanbanForwardMove', msg.sessionIds, nextCol, workspaceRoot);
        }
    }
    
    await this._refreshBoard(workspaceRoot);
    vscode.window.showInformationMessage(`Copied prompt for ${sourceCards.length} plans and advanced to next stage.`);
    break;
}
```

**Edge Cases Handled**:
- **No next column**: If the card is in the last column, show a message and don't advance
- **PLAN REVIEWED complexity routing**: Preserved the existing complexity-based routing logic
- **Custom columns with no role**: Falls back to `kanbanForwardMove` (visual move only)
- **CLI triggers disabled**: Uses `kanbanForwardMove` for all columns
- **Single vs. batch**: Uses appropriate command for single or multiple cards

### Component 2: KanbanProvider.ts - promptAll Handler

#### MODIFY `c:\Users\patvu\Documents\GitHub\switchboard\src\services\KanbanProvider.ts`

**Context**: The `promptAll` handler (lines 1254-1270) has the same issue as `promptSelected`—it uses workflow-based advancement.

**Logic**: Identical to `promptSelected`, but operates on all cards in the column instead of selected cards.

**Implementation**:

```typescript
case 'promptAll': {
    const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
    if (!workspaceRoot) { break; }
    const column: string = msg.column;
    await this._refreshBoard(workspaceRoot);
    const sourceCards = this._lastCards.filter(card => card.workspaceRoot === workspaceRoot && card.column === column);
    if (sourceCards.length === 0) {
        vscode.window.showInformationMessage(`No plans in ${column} for prompt generation.`);
        break;
    }
    const prompt = this._generatePromptForColumn(sourceCards, column, workspaceRoot);
    await vscode.env.clipboard.writeText(prompt);
    
    // Column-based advancement (respects custom terminals)
    const nextCol = await this._getNextColumnId(column, workspaceRoot);
    if (!nextCol) {
        await this._refreshBoard(workspaceRoot);
        vscode.window.showInformationMessage(`Copied prompt for ${sourceCards.length} plans. No next column to advance to.`);
        break;
    }
    
    const sessionIds = sourceCards.map(card => card.sessionId);
    
    // PLAN REVIEWED uses dynamic complexity routing per-session
    if (column === 'PLAN REVIEWED') {
        const groups = await this._partitionByComplexityRoute(workspaceRoot, sessionIds);
        const movedParts: string[] = [];
        for (const [role, sids] of groups) {
            if (sids.length === 0) { continue; }
            const targetCol = this._targetColumnForDispatchRole(role);
            if (this._cliTriggersEnabled) {
                if (sids.length === 1) {
                    await vscode.commands.executeCommand('switchboard.triggerAgentFromKanban', role, sids[0], undefined, workspaceRoot);
                } else {
                    await vscode.commands.executeCommand('switchboard.triggerBatchAgentFromKanban', role, sids, undefined, workspaceRoot);
                }
            } else {
                await vscode.commands.executeCommand('switchboard.kanbanForwardMove', sids, targetCol, workspaceRoot);
            }
            movedParts.push(`${sids.length} → ${targetCol}`);
        }
        await this._refreshBoard(workspaceRoot);
        vscode.window.showInformationMessage(`Copied prompt for ${sourceCards.length} plans. Advanced: ${movedParts.join(', ')}.`);
    } else {
        // For all other columns (including custom terminals), advance to next column
        if (this._cliTriggersEnabled) {
            const role = this._columnToRole(nextCol);
            if (role) {
                const instruction = role === 'planner' ? 'improve-plan' : undefined;
                await vscode.commands.executeCommand('switchboard.triggerBatchAgentFromKanban', role, sessionIds, instruction, workspaceRoot);
            } else {
                // Next column has no role mapping, fall back to visual move
                await vscode.commands.executeCommand('switchboard.kanbanForwardMove', sessionIds, nextCol, workspaceRoot);
            }
        } else {
            // CLI triggers disabled, just move visually
            await vscode.commands.executeCommand('switchboard.kanbanForwardMove', sessionIds, nextCol, workspaceRoot);
        }
        await this._refreshBoard(workspaceRoot);
        vscode.window.showInformationMessage(`Copied prompt for ${sourceCards.length} plans and advanced to ${nextCol}.`);
    }
    break;
}
```

**Edge Cases Handled**: Same as `promptSelected`.

### Component 3: Verification of _generatePromptForColumn

#### READ `c:\Users\patvu\Documents\GitHub\switchboard\src\services\KanbanProvider.ts` (lines 430-467)

**Context**: Need to verify that `_generatePromptForColumn` handles custom columns gracefully.

**Expected behavior**: The method should generate a generic prompt for custom columns, or at minimum not crash.

**Clarification**: If `_generatePromptForColumn` has hardcoded logic for built-in columns only, we'll need to add a default case for custom columns. This will be verified during implementation and addressed if necessary.

### Component 4: Defensive Logging for Null Roles

#### MODIFY `c:\Users\patvu\Documents\GitHub\switchboard\src\services\KanbanProvider.ts`

**Context**: In the moveSelected/moveAll handlers (lines 1164-1180 and 1219-1230), when `_columnToRole(nextCol)` returns `null`, the code silently falls back to `kanbanForwardMove`. This is correct behavior, but should be logged for debugging.

**Logic**: Add a debug log when a column has no role mapping.

**Implementation**: Add logging in the `else` branch where `role` is null:

```typescript
// In moveSelected handler (around line 1175)
} else {
    // Next column has no role mapping, fall back to visual move
    console.log(`[Kanban] Column '${nextCol}' has no role mapping, using visual move only`);
    await vscode.commands.executeCommand('switchboard.kanbanForwardMove', msg.sessionIds, nextCol, workspaceRoot);
}
```

```typescript
// In moveAll handler (around line 1225)
} else {
    // Next column has no role mapping, fall back to visual move
    console.log(`[Kanban] Column '${nextCol}' has no role mapping, using visual move only`);
    await vscode.commands.executeCommand('switchboard.kanbanForwardMove', sessionIds, nextCol, workspaceRoot);
}
```

**Edge Cases Handled**: Provides visibility when custom columns don't have role mappings, aiding in debugging configuration issues.

## Verification Plan

### Automated Tests
- **Unit test for `_getNextColumnId`**: Verify it returns the correct next column when custom terminals are inserted between built-in columns.
- **Unit test for `_columnToRole`**: Verify it returns the custom agent role for custom column IDs (e.g., `custom_agent_qa`).
- **Integration test**: Mock a Kanban board with a custom terminal between PLAN REVIEWED and LEAD CODED, simulate promptSelected/promptAll actions, and verify cards advance to the custom column, not LEAD CODED.

### Manual Testing
1. **Setup**: Configure a custom agent with `includeInKanban: true` and `kanbanOrder: 150` (between PLAN REVIEWED and LEAD CODED).
2. **Test moveSelected**: Create a plan in PLAN REVIEWED, select it, click "Move Selected". Verify it moves to the custom column.
3. **Test moveAll**: Create multiple plans in PLAN REVIEWED, click "Move All". Verify they move to the custom column.
4. **Test promptSelected**: Create a plan in PLAN REVIEWED, select it, click "Prompt Selected". Verify prompt is copied and card advances to the custom column.
5. **Test promptAll**: Create multiple plans in PLAN REVIEWED, click "Prompt All". Verify prompt is copied and cards advance to the custom column.
6. **Test with CLI triggers disabled**: Repeat tests 2-5 with CLI triggers disabled. Verify cards move visually without triggering terminals.
7. **Test from custom column**: Create a plan in the custom column, test all four buttons. Verify it advances to LEAD CODED (the next column after the custom column).
8. **Test PLAN REVIEWED complexity routing**: Create plans with Band A (low complexity) and Band B (high complexity) in PLAN REVIEWED. Use promptSelected/promptAll. Verify Band A plans go to CODER CODED and Band B plans go to LEAD CODED (existing behavior should be preserved).

### Regression Testing
- Verify existing behavior for built-in columns (CREATED → PLAN REVIEWED → LEAD CODED → CODER CODED → CODE REVIEWED) is unchanged.
- Verify drag-and-drop still works correctly.
- Verify autoban (automatic advancement) still works correctly.

### Success Criteria
- All four button types (moveSelected, moveAll, promptSelected, promptAll) respect custom terminal columns in the Kanban order.
- Cards advance to the immediate next column, not skip over custom columns.
- CLI triggers fire correctly for custom columns when enabled.
- No regressions in existing built-in column behavior.
- PLAN REVIEWED complexity routing continues to work as expected.
