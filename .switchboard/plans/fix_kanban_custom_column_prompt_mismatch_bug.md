# Fix Kanban Custom Column Prompt Mismatch Bug

## Goal
Fix bug where advancing plans via kanban prompt buttons ("Copy Prompt" / "Advance") generates a prompt for the source column's role instead of the destination custom column's configured role, causing custom columns to receive incorrect prompts.

## Metadata
**Tags:** [bugfix, workflow]
**Complexity:** 5
**Repo:** *(single-repo workspace)*

## User Review Required
- Verify that the proposed fix correctly handles the `PLAN REVIEWED` + custom-column-destination scenario (currently blocked by a `column !== 'PLAN REVIEWED'` guard on line 4179).
- Confirm whether `custom-agent` columns (source: `'custom-agent'`) should also receive destination-based prompts, or only `custom-user` columns.

## Complexity Audit
### Routine
- Add `destinationColumn` parameter to `_generatePromptForColumn` signature
- Reorder `promptSelected` and `promptAll` to call `_getNextColumnId` before `_generatePromptForColumn`
- Pass `nextCol` through to `_generatePromptForColumn`
- Add destination-role override logic inside `_generatePromptForColumn` using `column.source === 'custom-user'` or `column.source === 'custom-agent'`

### Complex / Risky
- **PLAN REVIEWED guard bypass**: `promptSelected` line 4179 has `column !== 'PLAN REVIEWED' && dispatchSpec?.source === 'custom-user'`. When the source is `PLAN REVIEWED` and the next column is a custom column, this guard skips the custom dispatch path and falls through to the PLAN REVIEWED complexity-routing block (lines 4201-4225). The fix must either (a) remove the `column !== 'PLAN REVIEWED'` condition when the destination is custom, or (b) add a pre-check before the PLAN REVIEWED block. This is the most architecturally sensitive change.
- **Double-fetching of custom agents/columns**: `_getNextColumnId` and `_generatePromptForColumn` both call `_getCustomAgents` + `_getCustomKanbanColumns` + `_buildKanbanColumns`. After the fix, `_resolveKanbanDispatchSpec` (called right after `_getNextColumnId`) also fetches these. Should pass the already-resolved `KanbanColumnDefinition` or `KanbanDispatchSpec` to avoid triple-fetching.

## Edge-Case & Dependency Audit
- **Race Conditions**: No new race conditions introduced. The column resolution is sequential and uses the same cached `_lastCards` state.
- **Security**: No security implications — this is purely prompt text generation logic.
- **Side Effects**: Changing the prompt generation order (get nextCol first) means that if `_getNextColumnId` returns null, no prompt is generated at all. Currently the prompt is generated even when there's no next column. Must preserve the "generate prompt even without a next column" behavior (prompt-only mode without advancement).
- **Dependencies & Conflicts**: No active CREATED/BACKLOG plans conflict with this change. The kanban board has no other plans modifying `KanbanProvider.ts` prompt handlers.

## Dependencies
None

## Adversarial Synthesis
Key risks: (1) The `column !== 'PLAN REVIEWED'` guard on line 4179 blocks custom-column dispatch when source is PLAN REVIEWED — the most common custom-column scenario. (2) Triple-fetching of custom agents/columns across `_getNextColumnId`, `_generatePromptForColumn`, and `_resolveKanbanDispatchSpec` creates a performance regression. (3) Reordering to get `nextCol` before generating the prompt must preserve the behavior where prompts are generated even when no next column exists. Mitigations: (1) Restructure the conditional to check destination type before the PLAN REVIEWED block. (2) Pass resolved column definition or dispatch spec as parameter. (3) Generate prompt first with source column logic, then overlay destination role if applicable — or generate prompt unconditionally and only gate the card advancement on `nextCol`.

## Current State
When a user clicks "Copy Prompt" or "Advance" on cards in a kanban column:
- The prompt is generated based on the SOURCE column's role mapping via `columnToPromptRole(sourceColumn)` inside `_generatePromptForColumn`
- The card is moved to the NEXT column (which could be a custom column)
- **Bug**: If the next column is a custom column with its own configured role, the generated prompt doesn't match that role — it still reflects the source column's canonical role

## Root Cause
In `src/services/KanbanProvider.ts`, the `promptSelected` and `promptAll` handlers:
1. Call `_generatePromptForColumn(sourceCards, column, workspaceRoot)` — generates prompt for SOURCE column (line 4167 / 4252)
2. Call `_getNextColumnId(column, workspaceRoot)` — finds next column (line 4171 / 4256)
3. Move cards to the next column

The `_generatePromptForColumn()` method (line 2192) uses `columnToPromptRole(sourceColumn)` (line 2198) to determine the role. `columnToPromptRole()` in `agentPromptBuilder.ts` (line 427) only maps canonical columns to roles; for custom columns it returns the column name itself if it starts with `'custom_agent_'`, but the prompt generation is called with the *source* column, not the destination.

Additionally, there is a guard on line 4179: `column !== 'PLAN REVIEWED' && dispatchSpec?.source === 'custom-user'`. This means even if the dispatch spec resolves to a custom column, when the source is `PLAN REVIEWED`, the custom dispatch path is skipped entirely in favor of the PLAN REVIEWED complexity-routing block.

## Affected Code Paths
- `src/services/KanbanProvider.ts`:
  - `promptSelected` handler (lines 4153-4240)
  - `promptAll` handler (lines 4242-4329)
  - `_generatePromptForColumn()` method (lines 2191-2227)
  - `_resolveKanbanDispatchSpec()` method (lines 2326-2370)
  - `_columnToRole()` method (lines 4995-5008)
- `src/services/agentPromptBuilder.ts`:
  - `columnToPromptRole()` function (lines 427-441)
- `src/services/agentConfig.ts`:
  - `KanbanColumnDefinition` interface (lines 23-34) — defines `source: 'built-in' | 'custom-agent' | 'custom-user'` and `role?: string`

## Proposed Changes

### `src/services/KanbanProvider.ts`

#### 1. Update `_generatePromptForColumn()` signature and logic (lines 2191-2227)

Add an optional `destinationColumn` parameter. When the destination is a custom column with a configured role, use that role instead of the source column's canonical mapping.

```typescript
private async _generatePromptForColumn(
    cards: KanbanCard[], 
    sourceColumn: string, 
    workspaceRoot: string,
    destinationColumn?: string
): Promise<string> {
    // If destination is a custom column with a role, generate prompt for that role
    if (destinationColumn) {
        const [customAgents, customKanbanColumns] = await Promise.all([
            this._getCustomAgents(workspaceRoot),
            this._getCustomKanbanColumns(workspaceRoot)
        ]);
        const allColumns = this._buildKanbanColumns(customAgents, customKanbanColumns);
        const destCol = allColumns.find(c => c.id === destinationColumn);
        
        if (destCol && (destCol.source === 'custom-user' || destCol.source === 'custom-agent') && destCol.role) {
            // Use the custom column's configured role for prompt generation
            return this._generatePromptForDestinationRole(cards, destCol.role, workspaceRoot);
        }
    }
    
    // Existing logic for canonical columns (unchanged)
    if (sourceColumn === 'PLAN REVIEWED') {
        return await this._generateBatchExecutionPrompt(cards, workspaceRoot);
    }
    
    const role = columnToPromptRole(sourceColumn);
    if (role === 'planner') {
        return await this._generateBatchPlannerPrompt(cards, workspaceRoot);
    }
    if (role === 'reviewer') {
        const repoScopeMap = new Map<string, string>();
        const db = this._getKanbanDb(workspaceRoot);
        if (await db.ensureReady()) {
            for (const card of cards) {
                const plan = await db.getPlanBySessionId(card.sessionId);
                if (plan?.repoScope) {
                    repoScopeMap.set(card.sessionId, plan.repoScope);
                }
            }
        }
        const promptsConfig = await this._getPromptsConfig(workspaceRoot);
        const defaultPromptOverrides = await this._getDefaultPromptOverrides(workspaceRoot);
        return buildKanbanBatchPrompt('reviewer', this._cardsToPromptPlans(cards, workspaceRoot, repoScopeMap), { 
            advancedReviewerEnabled: promptsConfig.advancedReviewerEnabled,
            defaultPromptOverrides,
            workspaceRoot
        });
    }
    if (role === 'tester') {
        return await this._generateBatchTesterPrompt(cards, workspaceRoot);
    }
    return await this._generateBatchExecutionPrompt(cards, workspaceRoot);
}
```

#### 2. Add `_generatePromptForDestinationRole()` helper

Routes a custom column's role to the appropriate prompt generator. Mirrors the role-based branching already in `_generatePromptForColumn` but driven by an explicit role string rather than column ID.

```typescript
private async _generatePromptForDestinationRole(
    cards: KanbanCard[], 
    role: string, 
    workspaceRoot: string
): Promise<string> {
    if (role === 'planner') {
        return await this._generateBatchPlannerPrompt(cards, workspaceRoot);
    }
    if (role === 'reviewer') {
        const repoScopeMap = new Map<string, string>();
        const db = this._getKanbanDb(workspaceRoot);
        if (await db.ensureReady()) {
            for (const card of cards) {
                const plan = await db.getPlanBySessionId(card.sessionId);
                if (plan?.repoScope) {
                    repoScopeMap.set(card.sessionId, plan.repoScope);
                }
            }
        }
        const promptsConfig = await this._getPromptsConfig(workspaceRoot);
        const defaultPromptOverrides = await this._getDefaultPromptOverrides(workspaceRoot);
        return buildKanbanBatchPrompt('reviewer', this._cardsToPromptPlans(cards, workspaceRoot, repoScopeMap), { 
            advancedReviewerEnabled: promptsConfig.advancedReviewerEnabled,
            defaultPromptOverrides,
            workspaceRoot
        });
    }
    if (role === 'tester') {
        return await this._generateBatchTesterPrompt(cards, workspaceRoot);
    }
    // For custom agent roles (e.g. 'lead', 'coder', 'intern', or custom_agent_*),
    // use the batch execution prompt which handles role-specific templating
    const overrideRole = (role === 'lead' || role === 'coder' || role === 'intern') ? role : undefined;
    return await this._generateBatchExecutionPrompt(cards, workspaceRoot, overrideRole);
}
```

#### 3. Update `promptSelected` handler (lines 4153-4240)

Reorder to get next column before generating prompt. Also fix the `column !== 'PLAN REVIEWED'` guard to allow custom-column dispatch when source is PLAN REVIEWED.

```typescript
case 'promptSelected': {
    const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
    if (!workspaceRoot || !Array.isArray(msg.sessionIds) || msg.sessionIds.length === 0) { break; }
    const column: string = msg.column;
    await this._refreshBoard(workspaceRoot);
    const sourceCards = this._lastCards.filter(card => card.workspaceRoot === workspaceRoot && msg.sessionIds.includes(card.sessionId));
    if (sourceCards.length === 0) {
        vscode.window.showInformationMessage('No matching plans found for prompt generation.');
        break;
    }
    
    // Get next column BEFORE generating prompt so we can use destination role
    const nextCol = await this._getNextColumnId(column, workspaceRoot);
    
    // Generate prompt — if nextCol is a custom column, its role overrides source role
    const prompt = await this._generatePromptForColumn(sourceCards, column, workspaceRoot, nextCol ?? undefined);
    await vscode.env.clipboard.writeText(prompt);

    // If no next column, still copy the prompt but don't advance
    if (!nextCol) {
        await this._refreshBoard(workspaceRoot);
        vscode.window.showInformationMessage(`Copied prompt for ${sourceCards.length} plans. No next column to advance to.`);
        break;
    }

    const dispatchSpec = await this._resolveKanbanDispatchSpec(workspaceRoot, nextCol);
    // CHANGED: Removed `column !== 'PLAN REVIEWED'` condition — custom columns should 
    // be dispatched regardless of source column. When destination is custom-user and 
    // source is PLAN REVIEWED, the custom column's role should take precedence.
    if (dispatchSpec?.source === 'custom-user' && this._taskViewerProvider) {
        const instruction = dispatchSpec.role === 'planner' ? 'improve-plan' : undefined;
        const dispatched = await this._taskViewerProvider.dispatchConfiguredKanbanColumnAction(dispatchSpec.role, msg.sessionIds, {
            targetColumn: nextCol,
            dragDropMode: 'prompt',
            additionalInstructions: dispatchSpec.triggerPrompt,
            instruction,
            workspaceRoot: workspaceRoot || undefined
        });
        if (dispatched && dispatchSpec.role === 'lead') {
            const leadCards = sourceCards
                .filter(card => !this._isLowComplexity(card) && card.complexity !== 'Unknown');
            if (leadCards.length > 0) {
                await this._dispatchWithPairProgrammingIfNeeded(leadCards, workspaceRoot);
            }
        }
        await this._refreshBoard(workspaceRoot);
        vscode.window.showInformationMessage(`Copied prompt for ${sourceCards.length} plans and advanced to ${nextCol}.`);
        break;
    }

    // PLAN REVIEWED uses dynamic complexity routing per-session (visual move only)
    // This now only fires when destination is NOT a custom-user column
    if (column === 'PLAN REVIEWED') {
        // ... existing PLAN REVIEWED complexity routing logic unchanged (lines 4202-4239)
    } else {
        // ... existing non-PLAN-REVIEWED advance logic unchanged (lines 4227-4239)
    }
    break;
}
```

#### 4. Update `promptAll` handler (lines 4242-4329)

Same reordering as `promptSelected`: get next column before generating prompt, pass destination column to `_generatePromptForColumn`.

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
    
    // Get next column BEFORE generating prompt so we can use destination role
    const nextCol = await this._getNextColumnId(column, workspaceRoot);
    
    // Generate prompt — if nextCol is a custom column, its role overrides source role
    const prompt = await this._generatePromptForColumn(sourceCards, column, workspaceRoot, nextCol ?? undefined);
    await vscode.env.clipboard.writeText(prompt);

    if (!nextCol) {
        await this._refreshBoard(workspaceRoot);
        vscode.window.showInformationMessage(`Copied prompt for ${sourceCards.length} plans. No next column to advance to.`);
        break;
    }

    const sessionIds = sourceCards.map(card => card.sessionId);

    const dispatchSpec = await this._resolveKanbanDispatchSpec(workspaceRoot, nextCol);
    if (dispatchSpec?.source === 'custom-user' && this._taskViewerProvider) {
        // ... existing custom-user dispatch logic unchanged (lines 4267-4284)
    }

    // PLAN REVIEWED uses dynamic complexity routing
    if (column === 'PLAN REVIEWED') {
        // ... existing PLAN REVIEWED complexity routing logic unchanged (lines 4288-4314)
    } else {
        // ... existing advance logic unchanged (lines 4315-4328)
    }
    break;
}
```

#### 5. Performance optimization (optional, reduces triple-fetching)

To avoid calling `_getCustomAgents` + `_getCustomKanbanColumns` + `_buildKanbanColumns` three times (in `_getNextColumnId`, `_generatePromptForColumn`, and `_resolveKanbanDispatchSpec`), extract the resolution into the handlers and pass the pre-built column list down:

```typescript
// In promptSelected / promptAll, after getting nextCol:
const [customAgents, customKanbanColumns] = await Promise.all([
    this._getCustomAgents(workspaceRoot),
    this._getCustomKanbanColumns(workspaceRoot)
]);
const allColumns = this._buildKanbanColumns(customAgents, customKanbanColumns);

// Then pass allColumns to _generatePromptForColumn and _resolveKanbanDispatchSpec
// instead of having them fetch internally.
```

This is an optional improvement — the functional fix works without it, just with redundant async calls.

### `src/services/agentPromptBuilder.ts`
No changes needed. `columnToPromptRole()` remains the canonical mapping for source columns. The destination-role override is handled entirely within `KanbanProvider.ts`.

## Test Cases
1. **Custom column between canonical columns**:
   - Setup: CREATED → PLAN REVIEWED → CUSTOM_COLUMN (role: 'reviewer') → CODE REVIEWED
   - Action: Click "Copy Prompt" on cards in PLAN REVIEWED
   - Expected: Prompt generated using CUSTOM_COLUMN's role ('reviewer'), cards move to CUSTOM_COLUMN
   - Current bug: Prompt generated using PLAN REVIEWED's canonical role ('planner' → lead via `_generateBatchExecutionPrompt`), cards move to CUSTOM_COLUMN

2. **Multiple custom columns in sequence**:
   - Setup: CREATED → CUSTOM_1 (role: 'planner') → CUSTOM_2 (role: 'reviewer') → CODE REVIEWED
   - Action: Click "Copy Prompt" on cards in CUSTOM_1
   - Expected: Prompt generated for CUSTOM_2's role ('reviewer'), cards move to CUSTOM_2

3. **Canonical column with no custom columns**:
   - Setup: CREATED → PLAN REVIEWED → CODE REVIEWED
   - Action: Click "Copy Prompt" on cards in PLAN REVIEWED
   - Expected: Current behavior maintained — prompt for source column's role

4. **Custom column at end of pipeline**:
   - Setup: CODE REVIEWED → CUSTOM_FINAL (role: 'tester')
   - Action: Click "Copy Prompt" on cards in CODE REVIEWED
   - Expected: Prompt generated for CUSTOM_FINAL's role ('tester'), cards move to CUSTOM_FINAL

5. **Custom column with no role configured**:
   - Setup: PLAN REVIEWED → CUSTOM_NOROLE (no role property)
   - Action: Click "Copy Prompt" on cards in PLAN REVIEWED
   - Expected: Falls back to source column role (current behavior) — no crash

6. **Custom-agent column as destination**:
   - Setup: PLAN REVIEWED → custom_agent_specialist (source: 'custom-agent', role: 'specialist')
   - Action: Click "Copy Prompt" on cards in PLAN REVIEWED
   - Expected: Prompt generated for 'specialist' role

7. **No next column available**:
   - Setup: COMPLETED (last column)
   - Action: Click "Copy Prompt" on cards in CODE REVIEWED where next = COMPLETED and no acceptance tester
   - Expected: Prompt still generated and copied, message shows "No next column to advance to"

## Verification Plan
### Automated Tests
- Add unit test for `_generatePromptForColumn()` with `destinationColumn` parameter:
  - Test with destination as custom-user column with role → returns destination-role prompt
  - Test with destination as custom-agent column with role → returns destination-role prompt
  - Test with destination as canonical column → returns source-role prompt (existing behavior)
  - Test with no destination → returns source-role prompt (existing behavior)
  - Test with destination as custom column with no role → falls back to source-role prompt
- Add unit test for `_generatePromptForDestinationRole()`:
  - Test each role branch: 'planner', 'reviewer', 'tester', 'lead', 'coder', 'intern', custom role
- No existing tests for this area (confirmed: no test files reference `_generatePromptForColumn` or `columnToPromptRole`)

### Manual Testing
1. Create a custom column in kanban setup with a configured role
2. Place plans in the column before it
3. Click "Copy Prompt" and verify the generated prompt matches the custom column's role
4. Verify cards advance to the custom column
5. Test with PLAN REVIEWED as source and custom column as destination (the key scenario)

## Files to Modify
- `src/services/KanbanProvider.ts`:
  - Update `_generatePromptForColumn()` to accept optional `destinationColumn` parameter (line 2192)
  - Add `_generatePromptForDestinationRole()` helper method
  - Update `promptSelected` handler: reorder nextCol resolution before prompt generation, pass `nextCol` to `_generatePromptForColumn`, remove `column !== 'PLAN REVIEWED'` guard on custom dispatch path (lines 4153-4240)
  - Update `promptAll` handler: reorder nextCol resolution before prompt generation, pass `nextCol` to `_generatePromptForColumn` (lines 4242-4329)

## Edge Cases
- Custom column with no role configured: Falls back to source column role — no crash, graceful degradation
- Custom column with `dragDropMode: 'disabled'`: Not reachable via prompt buttons, so irrelevant to this fix
- Custom column with `dragDropMode: 'cli'`: Prompt buttons bypass CLI-mode dispatch; only `promptSelected`/`promptAll` are affected. CLI columns don't appear in prompt-mode flows.
- Custom column with `triggerPrompt` configured: The `triggerPrompt` is passed through `dispatchSpec.triggerPrompt` and is unaffected by this change
- `PLAN REVIEWED` as source with custom destination: The most critical edge case — currently blocked by the `column !== 'PLAN REVIEWED'` guard. Fix removes this guard when destination is custom.

## Recommendation
Complexity ≤ 6 — **Send to Coder**
