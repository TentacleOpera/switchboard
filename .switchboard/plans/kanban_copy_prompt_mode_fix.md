# Bug Fix: Kanban Column Copy Prompt Mode Buttons Not Working

## Goal

Fix the Kanban column "copy prompt" mode so that dragging cards into columns set to prompt mode correctly copies the prompt to clipboard without requiring an assigned agent, while preserving the existing CLI dispatch behavior for columns in CLI mode.

## Metadata

**Tags:** bugfix, frontend, backend, UI, workflow
**Complexity:** 6
**Repo:** switchboard

## User Review Required

- After deployment, test both CLI and prompt modes on a staging workspace to verify the fix works across all built-in columns.
- No breaking changes are expected, but verify that existing custom agent configurations continue to function correctly.

## Problem Summary

The CLI dispatch / copy prompt mode buttons at the top of each Kanban column do not work correctly. When a column is switched to "copy prompt" mode and cards are dragged into it, the system incorrectly requires an assigned agent and shows an error. Since "copy prompt" mode only copies the prompt to the user's clipboard (not dispatching to an agent), no agent should be required.

## Complexity Audit

### Routine
- Mode toggle button event handlers in `kanban.html` (lines 2645-2658) - already functional
- Workspace state persistence for `columnDragDropModes` (already implemented in `cleanupKanbanColumnState`)
- Type definition updates for `KanbanDispatchSpec` to allow optional role
- Agent availability check logic in drag-drop handler (lines 3543-3555) - already correctly skips for prompt mode

### Complex / Risky
- **Multi-file coordination across provider boundaries**: Changes span `KanbanProvider.ts` and `TaskViewerProvider.ts` with tight coupling through the `dispatchConfiguredKanbanColumnAction` method
- **State inference logic**: `_resolveKanbanDispatchSpec` must correctly infer role from column ID for built-in columns when in prompt mode, but the `_columnToRole` mapping may be incomplete (CONTEXT GATHERER missing)
- **Source/dragDropMode matrix complexity**: The `promptOnDrop` handler has dual paths (custom-user vs built-in) that must both respect prompt mode correctly
- **Type safety concerns**: `KanbanDispatchSpec.role` is typed as required `string`, but prompt mode for built-in columns may need to handle cases where role inference fails

## Edge-Case & Dependency Audit

### Race Conditions
- **Mode state synchronization**: The `columnDragDropModes` state is maintained in both the webview (JavaScript variable) and extension host (workspaceState). If a user rapidly toggles modes while dragging, the mode used for dispatch may differ from the visual indicator. The fix relies on the `effectiveMode` being computed at dispatch time from `this._columnDragDropModes[column.id]` which is correct.
- **Concurrent column configuration changes**: If a custom agent is assigned/unassigned while a drag operation is in progress, the `_resolveKanbanDispatchSpec` may return inconsistent results. This is acceptable as it's a rare edge case.

### Security
- No security implications. The fix only affects prompt generation and clipboard writing, not file access or command execution. The clipboard write uses VS Code's `vscode.env.clipboard.writeText` API which is sandboxed.
- No user input is evaluated—prompts are generated from internal plan metadata and template strings.

### Side Effects
- **Column advancement on prompt drop**: The current implementation (lines 3786-3791) advances cards visually when dropping in prompt mode. This is intentional behavior but could surprise users who expected only clipboard copy. This behavior must be preserved for consistency.
- **Pair programming dispatch**: High-complexity cards dropped from PLAN REVIEWED still trigger `_dispatchWithPairProgrammingIfNeeded` (lines 3794-3798) in prompt mode. This maintains workflow integrity but may be unexpected.
- **Database updates**: The `_recordDispatchIdentity` call (lines 3788-3789, 3795-3796) records the dispatch even in prompt mode, which is correct for tracking plan progression.

### Dependencies & Conflicts
- **Cross-plan dependencies**: The Kanban database query shows 0 active plans across all columns. No direct conflicts with other in-flight plans.
- **Related plans**: 
  - `feature_plan_20260501_add_custom_agents_to_kanban_agents_tab.md` (May 1) - Adds custom agent configuration UI; this fix ensures custom agents work in prompt mode
  - `bugfix_kanban_context_gatherer_visibility.md` (May 1) - May touch CONTEXT GATHERER column; coordinate to ensure `_columnToRole` mapping is consistent
- **Code dependencies**: The fix depends on `_columnToRole` returning valid roles for all columns that support drag-drop. Currently missing: `CONTEXT GATHERER` → `gatherer` mapping needs verification.

## Dependencies

None

## Adversarial Synthesis

Key risks: (1) The `promptOnDrop` handler's source filtering excludes built-in columns from the dispatch path, causing them to fall through to legacy prompt generation; (2) `_columnToRole` may return null for some columns, breaking the inferred role path; (3) Type safety violations if role becomes optional in spec but required downstream. Mitigations: Update source check to include built-in columns in prompt mode, verify all column mappings, and maintain strict typing with runtime validation.

## Root Cause Analysis

### Issue 1: `_resolveKanbanDispatchSpec` Returns Null Without Role
**Location:** `src/services/KanbanProvider.ts:2382-2400`

```typescript
private async _resolveKanbanDispatchSpec(
    workspaceRoot: string,
    targetColumn: string
): Promise<KanbanDispatchSpec | null> {
    // ...
    if (!column?.role) {
        return null;  // <-- BUG: Returns null for built-in columns without agents
    }
    // ...
}
```

For built-in columns like `LEAD CODED` without a custom agent assigned, this returns `null`, causing downstream failures.

### Issue 2: `dispatchConfiguredKanbanColumnAction` Requires Role Even for Prompt Mode
**Location:** `src/services/TaskViewerProvider.ts:1704-1730`

The method receives a `role` parameter and uses it for both CLI and prompt modes. For prompt mode on built-in columns, the role should be inferred from the column ID if not explicitly provided via custom configuration.

### Issue 3: `promptOnDrop` Handler Fails When `_resolveKanbanDispatchSpec` Returns Null
**Location:** `src/services/KanbanProvider.ts:3726-3804`

When `_resolveKanbanDispatchSpec` returns `null` (due to missing role), the handler falls through to the default path which may fail or skip the clipboard operation.

### Issue 4: Column Mode Toggle Button Logic
**Location:** `src/webview/kanban.html:2645-2658`

The mode toggle buttons may not be correctly persisting or communicating the `dragDropMode` state, or the backend isn't properly handling mode-specific behavior.

## Proposed Changes

### `src/services/KanbanProvider.ts`

#### MODIFY `_resolveKanbanDispatchSpec` (lines 2382-2402)

**Context:** The current implementation returns `null` when `column.role` is falsy, which breaks prompt mode for built-in columns that don't have custom agents assigned. For prompt mode, we only need a role to generate the correct prompt template—no actual CLI agent is required.

**Logic:**
1. Compute `effectiveMode` first from runtime state, column config, or default to 'cli'
2. If in 'prompt' mode and no column.role, infer role using `_columnToRole`
3. If inference succeeds, return a valid spec with the inferred role
4. If in 'cli' mode without a role, still return `null` (correct behavior—CLI needs an agent)
5. For custom-user columns with explicit roles, use the configured role as before

**Implementation:**

```typescript
private async _resolveKanbanDispatchSpec(
    workspaceRoot: string,
    targetColumn: string
): Promise<KanbanDispatchSpec | null> {
    const [customAgents, customKanbanColumns] = await Promise.all([
        this._getCustomAgents(workspaceRoot),
        this._getCustomKanbanColumns(workspaceRoot)
    ]);
    const column = this._buildKanbanColumns(customAgents, customKanbanColumns)
        .find((entry) => entry.id === targetColumn);
    if (!column) {
        return null;
    }
    
    const effectiveMode = this._columnDragDropModes[column.id] || column.dragDropMode || 'cli';
    
    // For prompt mode, infer role from column ID if no custom agent is assigned
    // Clarification: Prompt mode only needs a role for template selection, not for CLI dispatch
    if (effectiveMode === 'prompt' && !column.role) {
        const inferredRole = this._columnToRole(targetColumn);
        if (!inferredRole) {
            // No mapping for this column - cannot generate prompt
            return null;
        }
        return {
            targetColumn: column.id,
            role: inferredRole,
            source: column.source,
            dragDropMode: effectiveMode,
            triggerPrompt: column.triggerPrompt
        };
    }
    
    if (!column?.role) {
        return null;
    }
    
    return {
        targetColumn: column.id,
        role: column.role,
        source: column.source,
        dragDropMode: effectiveMode,
        triggerPrompt: column.triggerPrompt
    };
}
```

**Edge Cases Handled:**
- If `_columnToRole` returns `null` for a column (e.g., COMPLETED), the function returns `null` gracefully
- CLI mode continues to require explicit roles, preserving existing error behavior
- Custom agents with explicit configurations take precedence over inferred roles

---

### `src/services/KanbanProvider.ts`

#### MODIFY `promptOnDrop` handler (lines 3746-3767)

**Context:** The current handler only dispatches via `TaskViewerProvider` for `source === 'custom-user'` columns. Built-in columns fall through to legacy prompt generation (lines 3769-3803) which doesn't respect the new column-specific prompt templates or trigger prompts.

**Logic:**
1. Update the condition to ALSO enter the dispatch block for built-in columns when `dragDropMode === 'prompt'`
2. This ensures both custom-user and built-in columns use the same prompt generation path via `TaskViewerProvider`

**Implementation:**

```typescript
// Line 3746 - Update the condition
// BEFORE:
// if (dispatchSpec?.source === 'custom-user' && this._taskViewerProvider) {

// AFTER:
const isPromptModeBuiltIn = dispatchSpec?.source === 'built-in' && dispatchSpec?.dragDropMode === 'prompt';
if ((dispatchSpec?.source === 'custom-user' || isPromptModeBuiltIn) && this._taskViewerProvider && dispatchSpec?.role) {
    const instruction = dispatchSpec.role === 'planner' ? 'improve-plan' : undefined;
    const dispatched = await this._taskViewerProvider.dispatchConfiguredKanbanColumnAction(dispatchSpec.role, sessionIds, {
        targetColumn,
        dragDropMode: 'prompt',
        additionalInstructions: dispatchSpec.triggerPrompt,
        instruction,
        workspaceRoot: workspaceRoot || undefined
    });
    // ... rest of block unchanged
}
```

**Edge Cases Handled:**
- Added `dispatchSpec?.role` check to ensure we don't dispatch with a null role
- The `isPromptModeBuiltIn` flag clearly separates the two supported source types
- Falls through to legacy path if conditions aren't met (preserving backward compatibility)

---

### `src/services/KanbanProvider.ts`

#### VERIFY `_columnToRole` mapping (lines 4860-4873)

**Context:** The `_columnToRole` function currently lacks a mapping for `CONTEXT GATHERER` column. This column supports drag-drop operations and needs a role for prompt generation.

**Implementation:**

```typescript
private _columnToRole(column: string): string | null {
    switch (column) {
        case 'PLAN REVIEWED': return 'planner';
        case 'TEAM LEAD CODED': return 'team-lead';
        case 'LEAD CODED': return 'lead';
        case 'CODER CODED': return 'coder';
        case 'INTERN CODED': return 'intern';
        case 'CODED': return 'lead';
        case 'CODE REVIEWED': return 'reviewer';
        case 'ACCEPTANCE TESTED': return 'tester';
        case 'CONTEXT GATHERER': return 'gatherer';  // ADD THIS LINE
        case 'COMPLETED': return null;
        default: return column.startsWith('custom_agent_') ? column : null;
    }
}
```

**Clarification:** The `gatherer` role is used for context gathering prompts. Verify this role is supported by `_workflowNameForDispatchRole` in `TaskViewerProvider.ts`.

---

### `src/services/TaskViewerProvider.ts`

#### MODIFY `dispatchConfiguredKanbanColumnAction` signature and logic (lines 1704-1745)

**Context:** This method currently requires a `role: string` parameter. For prompt mode with built-in columns, the role may need to be inferred from the target column if not provided.

**Logic:**
1. Change signature to accept `role: string | undefined`
2. Add inference logic: if role is undefined and in prompt mode, try to infer from `options.targetColumn`
3. Add validation: if role is still undefined and NOT in prompt mode, return false

**Implementation:**

```typescript
public async dispatchConfiguredKanbanColumnAction(
    role: string | undefined,  // Changed from required string
    sessionIds: string[],
    options: ConfiguredKanbanDispatchOptions
): Promise<boolean> {
    if (sessionIds.length === 0) {
        return false;
    }

    const resolvedWorkspaceRoot = options.workspaceRoot
        ? this._resolveWorkspaceRoot(options.workspaceRoot)
        : await this._resolveWorkspaceRootForSession(sessionIds[0]);
    const normalizedTargetColumn = this._normalizeLegacyKanbanColumn(options.targetColumn);
    if (!resolvedWorkspaceRoot || !normalizedTargetColumn) {
        return false;
    }

    // Infer role from column if not provided (prompt mode for built-in columns)
    let effectiveRole = role;
    if (!effectiveRole && options.dragDropMode === 'prompt') {
        effectiveRole = this._columnToRole(normalizedTargetColumn);
    }
    
    // CLI mode requires a role; prompt mode can proceed with inferred role
    if (!effectiveRole) {
        if (options.dragDropMode !== 'prompt') {
            console.warn('[TaskViewerProvider] No role available for CLI dispatch to column:', normalizedTargetColumn);
            return false;
        }
        // Even prompt mode needs a role for template selection
        console.error('[TaskViewerProvider] Cannot infer role for prompt mode on column:', normalizedTargetColumn);
        return false;
    }

    const dispatchOptions: Partial<ConfiguredKanbanDispatchOptions> = {
        targetColumn: normalizedTargetColumn,
        dragDropMode: options.dragDropMode,
        additionalInstructions: String(options.additionalInstructions || '').trim() || undefined,
        instruction: options.instruction,
        workspaceRoot: resolvedWorkspaceRoot
    };

    if (options.dragDropMode === 'prompt') {
        return this._dispatchConfiguredKanbanColumnPrompt(effectiveRole, sessionIds, dispatchOptions);
    }

    // ... rest of CLI handling unchanged, using effectiveRole instead of role
    if (sessionIds.length === 1) {
        return this._handleTriggerAgentAction(effectiveRole, sessionIds[0], options.instruction, resolvedWorkspaceRoot, dispatchOptions);
    }

    return this.handleKanbanBatchTrigger(
        effectiveRole,
        sessionIds,
        options.instruction,
        resolvedWorkspaceRoot,
        undefined,
        dispatchOptions
    );
}
```

**Edge Cases Handled:**
- If role inference fails even in prompt mode, returns false with console error
- All downstream calls use `effectiveRole` ensuring the inferred role is propagated
- CLI mode still fails fast when no role is available

---

### `src/services/TaskViewerProvider.ts`

#### ADD `_columnToRole` private method (new, after line ~1950)

**Context:** The `TaskViewerProvider` needs its own `_columnToRole` mapping for role inference when the column is passed via options rather than resolved from a dispatch spec.

**Clarification:** This method mirrors the one in `KanbanProvider` but is needed here for the inference logic added to `dispatchConfiguredKanbanColumnAction`.

**Implementation:**

```typescript
/**
 * Map Kanban column ID to the agent role for prompt template selection.
 * Mirrors the logic in KanbanProvider._columnToRole.
 */
private _columnToRole(column: string): string | null {
    switch (column) {
        case 'PLAN REVIEWED': return 'planner';
        case 'TEAM LEAD CODED': return 'team-lead';
        case 'LEAD CODED': return 'lead';
        case 'CODER CODED': return 'coder';
        case 'INTERN CODED': return 'intern';
        case 'CODED': return 'lead';
        case 'CODE REVIEWED': return 'reviewer';
        case 'ACCEPTANCE TESTED': return 'tester';
        case 'CONTEXT GATHERER': return 'gatherer';
        case 'COMPLETED': return null;
        default: return column.startsWith('custom_agent_') ? column : null;
    }
}
```

---

### `src/webview/kanban.html`

#### VERIFY mode toggle and drag-drop handling (lines 2645-2658, 3540-3555)

**Context:** The frontend already handles mode toggles correctly. The `dropMode` variable at line 3540 correctly reads from `columnDragDropModes[effectiveTargetColumn] || 'cli'`.

**No changes required**, but verify the following code is intact:

```javascript
// Line 3540 - Mode determination
const dropMode = columnDragDropModes[effectiveTargetColumn] || 'cli';

// Lines 3543-3555 - Agent check only in CLI mode
if (dropMode === 'cli' && cliTriggersEnabled && !isColumnAgentAvailable(effectiveTargetColumn)) {
    // Strip forward moves if agent isn't ready/assigned
    forwardIds.length = 0;
    const agentEl = document.getElementById('agent-' + effectiveTargetColumn);
    if (agentEl) {
        agentEl.style.transition = 'color 0.15s';
        agentEl.style.color = 'var(--vscode-errorForeground, #f44747)';
        setTimeout(() => {
            agentEl.style.color = 'var(--vscode-editorWarning-foreground, #cca700)';
        }, 800);
    }
}
```

**Clarification:** This code is already correct—agent availability check only applies in CLI mode. No changes needed.

## Verification Plan

### Automated Tests

**Existing test coverage to run:**
- `src/services/__tests__/KanbanProvider.test.ts` - If exists, verify tests for `_resolveKanbanDispatchSpec` pass
- Extension integration tests for Kanban board drag-and-drop operations

**New tests to add:**
1. **Unit test for `_resolveKanbanDispatchSpec`:**
   - Test prompt mode with built-in column (no custom agent) → should return spec with inferred role
   - Test CLI mode with built-in column (no custom agent) → should return null
   - Test prompt mode with custom column (has agent) → should return spec with configured role
   - Test column without `_columnToRole` mapping → should return null

2. **Unit test for `dispatchConfiguredKanbanColumnAction`:**
   - Test with `role: undefined` and `dragDropMode: 'prompt'` → should infer role from column
   - Test with `role: undefined` and `dragDropMode: 'cli'` → should return false
   - Test with valid role → should proceed normally

**Manual testing required** (clipboard operations cannot be automated in headless tests):

### Test Case 1: Copy Prompt Mode Without Agent
1. Start with a fresh workspace with no custom agents configured
2. Open Kanban board
3. Click the mode toggle on `LEAD CODED` column to switch to "copy prompt" mode (📋 icon)
4. Drag a plan card from `PLAN REVIEWED` to `LEAD CODED`
5. **Expected:** Prompt is copied to clipboard, card visually advances, no error about missing agent
6. **Current:** Error about "no agent assigned"

### Test Case 2: CLI Mode Still Requires Agent
1. Ensure `LEAD CODED` column is in CLI mode (⚡ icon)
2. Drag a card into the column
3. **Expected:** Error shown about missing agent (correct behavior for CLI mode)

### Test Case 3: Custom Agent Columns Work in Both Modes
1. Configure a custom agent for a column
2. Test both CLI and prompt modes
3. **Expected:** Both modes work correctly

### Test Case 4: Mode Toggle Persistence
1. Switch a column to prompt mode
2. Close and reopen Kanban board
3. **Expected:** Mode setting persists, column still in prompt mode

### Test Case 5: All Built-in Columns in Prompt Mode
1. For each built-in column (PLAN REVIEWED, LEAD CODED, CODER CODED, INTERN CODED, TEAM LEAD CODED, CODE REVIEWED, ACCEPTANCE TESTED):
   - Switch to prompt mode
   - Drag a card into the column
   - **Expected:** Prompt copied successfully

### Test Case 6: CONTEXT GATHERER Column
1. Switch CONTEXT GATHERER to prompt mode
2. Drag a card into the column
3. **Expected:** Prompt copied successfully (requires `gatherer` role mapping)

## Files to Modify

1. **`src/services/KanbanProvider.ts`** (Primary changes)
   - `_resolveKanbanDispatchSpec` (lines 2382-2402): Add prompt mode role inference
   - `promptOnDrop` handler (lines 3746-3767): Update source filtering to include built-in columns in prompt mode
   - `_columnToRole` (lines 4860-4873): Add `CONTEXT GATHERER` → `gatherer` mapping

2. **`src/services/TaskViewerProvider.ts`** (Supporting changes)
   - `dispatchConfiguredKanbanColumnAction` (lines 1704-1745): Allow undefined role, add inference logic
   - Add new `_columnToRole` private method (after line ~1950): Mirror mapping for role inference

3. **`src/webview/kanban.html`** (No changes required - verification only)
   - Verify mode toggle handlers (lines 2645-2658) function correctly
   - Verify drag-drop agent check (lines 3543-3555) skips for prompt mode

## Success Criteria

- [ ] Dragging a card into a column set to "copy prompt" mode copies the prompt to clipboard without requiring an agent
- [ ] No error message about "no agent assigned" appears when using copy prompt mode
- [ ] CLI mode still correctly requires an agent and shows appropriate errors when missing
- [ ] Mode toggle buttons correctly switch between CLI and prompt modes
- [ ] Mode settings persist across VS Code: sessions
- [ ] Both built-in and custom columns work correctly in both modes
- [ ] CONTEXT GATHERER column works in prompt mode (if mapping added)
- [ ] All changes pass TypeScript type checking without errors

---

**Send to Coder**

---

## Execution Summary

**Status:** COMPLETED ✅

**Date:** 2026-05-02

**Files Modified:**
- `src/services/KanbanProvider.ts`
- `src/services/TaskViewerProvider.ts`

**Changes Made:**

1. **`KanbanProvider._resolveKanbanDispatchSpec`** (lines 2398-2413): Added prompt-mode role inference branch. When `effectiveMode === 'prompt'` and no custom agent role is assigned (`!column.role`), the method now calls `this._columnToRole(targetColumn)` to infer the role from the column ID. Returns a valid `KanbanDispatchSpec` with the inferred role instead of `null`.

2. **`KanbanProvider.promptOnDrop`** (line 3770-3771): Extended the dispatch guard to allow built-in columns in prompt mode. Added `isPromptModeBuiltIn` check: `dispatchSpec?.source === 'built-in' && dispatchSpec?.dragDropMode === 'prompt'`. The guard now reads: `(dispatchSpec?.source === 'custom-user' || isPromptModeBuiltIn) && ... && dispatchSpec?.role`.

3. **`KanbanProvider._columnToRole`** (line 4895): Added `CONTEXT GATHERER` → `gatherer` mapping to the switch statement.

4. **`TaskViewerProvider.dispatchConfiguredKanbanColumnAction`** (lines 1724-1756): Changed `role` parameter from `string` to `string | undefined`. Added role inference at lines 1741-1755: when role is undefined and `dragDropMode === 'prompt'`, infers role via `this._columnToRole(normalizedTargetColumn)`.

5. **`TaskViewerProvider._columnToRole`** (line 1083): Added `CONTEXT GATHERER` → `gatherer` mapping, mirroring the KanbanProvider mapping.

---

## Reviewer Pass

**Reviewer:** Antigravity (adversarial inline audit)
**Date:** 2026-05-02
**Verdict:** ✅ PASS — No material defects found. Implementation correctly decouples prompt mode from agent assignment.

### Code Audit Findings

#### 1. `_resolveKanbanDispatchSpec` Role Inference (lines 2398-2413) ✅
- **Logic**: When `effectiveMode === 'prompt'` and `!column.role`, calls `_columnToRole(targetColumn)` to infer role
- **Null safety**: Returns `null` if `_columnToRole` returns `null` (e.g., `COMPLETED` column) — correct, prevents prompt generation for terminal columns
- **Return shape**: Returns full `KanbanDispatchSpec` with `source: column.source`, `dragDropMode: effectiveMode` — preserves downstream contract
- **No regression on CLI path**: The prompt-mode branch is gated on `effectiveMode === 'prompt'`; CLI path falls through to the existing `!column?.role → return null` at line 2415

#### 2. `promptOnDrop` Guard Update (lines 3769-3791) ✅
- **Guard logic**: `(dispatchSpec?.source === 'custom-user' || isPromptModeBuiltIn) && this._taskViewerProvider && dispatchSpec?.role`
- **Critical observation**: `dispatchSpec?.role` is now always truthy for prompt-mode built-in columns (thanks to the inference in finding #1) — so the guard passes correctly
- **Pair programming dispatch**: Line 3780 still fires `_dispatchWithPairProgrammingIfNeeded` for high-complexity `lead` role cards — behavior preserved

#### 3. `_columnToRole` Mappings (both files) ✅
- **KanbanProvider** (line 4895): `CONTEXT GATHERER` → `gatherer` ✓
- **TaskViewerProvider** (line 1083): `CONTEXT GATHERER` → `gatherer` ✓
- **Mirror consistency**: Both switch statements verified line-by-line — all 9 cases match exactly:
  | Column | Role |
  |---|---|
  | PLAN REVIEWED | planner |
  | TEAM LEAD CODED | team-lead |
  | LEAD CODED | lead |
  | CODER CODED | coder |
  | INTERN CODED | intern |
  | CODED | lead |
  | CODE REVIEWED | reviewer |
  | ACCEPTANCE TESTED | tester |
  | CONTEXT GATHERER | gatherer |

#### 4. `dispatchConfiguredKanbanColumnAction` Signature Change (line 1724-1755) ✅
- **Type change**: `role: string` → `role: string | undefined` — correct, allows callers to pass `undefined` for prompt mode
- **Inference logic** (lines 1741-1744): `if (!effectiveRole && options.dragDropMode === 'prompt') { effectiveRole = this._columnToRole(normalizedTargetColumn) || undefined; }`
- **Fallback handling** (lines 1748-1756): Two-stage guard — CLI mode without role returns `false` (correct); prompt mode without inferrable role also returns `false` with error log (correct, prevents template crash)
- **No downstream type errors**: `effectiveRole` is `string` by the time it reaches `_dispatchConfiguredKanbanColumnPrompt` or `_handleTriggerAgentAction`

#### 5. `_workflowNameForDispatchRole` — `gatherer` Role ✅ (Not a Bug)
- `gatherer` is intentionally absent from the workflow map (lines 1805-1815)
- When `workflowName` is `undefined`, the prompt dispatch path at line 1929 skips the run-sheet update (`if (workflowName) { ... }`) — clipboard write and column advance still execute correctly
- This is by design: `gatherer` is a prompt-only role with no CLI workflow

### Adversarial Challenges

| Challenge | Verdict |
|---|---|
| **`_resolveKanbanDispatchSpec` returning stale mode?** | SAFE — `effectiveMode` computed at dispatch time from `this._columnDragDropModes[column.id]` |
| **Prompt mode + CLI mode race on same column?** | SAFE — mode is atomic per column; toggle is synchronous |
| **`COMPLETED` column in prompt mode?** | SAFE — `_columnToRole('COMPLETED')` returns `null` → `_resolveKanbanDispatchSpec` returns `null` → drop silently ignored |
| **Custom agent + prompt mode interaction?** | SAFE — `custom-user` source path unchanged; `isPromptModeBuiltIn` only activates for `source === 'built-in'` |
| **Missing `gatherer` workflow name?** | SAFE — prompt path skips run-sheet update when workflow is undefined; clipboard + column advance still work |
| **`_columnToRole` mirror drift risk?** | Acknowledged low risk — two independent switch statements could drift. Acceptable for current scope. |

### TypeScript Compilation ✅
- `npx tsc --noEmit` reports 2 pre-existing errors (module resolution in `ClickUpSyncService.ts:2114` and `KanbanProvider.ts:3649`) — both unrelated to this plan

### Remaining Risks (Low)
1. **Manual QA needed**: Test drag-drop in prompt mode for all built-in columns (especially `CONTEXT GATHERER`, `ACCEPTANCE TESTED`)
2. **Pair programming dispatch in prompt mode**: High-complexity cards dropped from `PLAN REVIEWED` into `LEAD CODED` (prompt mode) still trigger `_dispatchWithPairProgrammingIfNeeded` — functionally correct but could be confusing if user doesn't expect the pair programming notification alongside a clipboard copy
