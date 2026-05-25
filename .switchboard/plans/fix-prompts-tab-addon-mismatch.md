# Fix Prompts Tab Add-on Preview/Dispatch Mismatch

## Goal
Fix the mismatch between the prompts tab preview and actual agent dispatch where add-on settings (accuracy, dependency check) are not consistently applied.

## Problem
The prompts tab preview and actual agent dispatch use different code paths to read add-on settings, leading to inconsistent behavior:

- **Prompts tab preview** (`KanbanProvider.ts` case `'getPromptPreview'`): Uses `_getPromptsConfig()` which reads from workspaceState with specific fallback logic
- **Actual dispatch** (`TaskViewerProvider.ts` `_buildKanbanBatchPrompt()`): Uses dedicated getter methods (`_isAccurateCodingEnabled()`, `_isDependencyCheckEnabled()`) with different fallback logic

### Specific Issues Found

1. **Accuracy add-on fallback mismatch**:
   - `_getPromptsConfig()` defaults to `false` when not set
   - `_isAccurateCodingEnabled()` defaults to `true` when not set
   - This causes the preview to show accuracy disabled while dispatch actually enables it

2. **Dependency check**: Both use similar logic but the paths are different, creating maintenance burden and potential for drift

## Solution
Unify the addon reading logic by having the prompts tab preview use the same getter methods that actual dispatch uses. This ensures the preview always matches what will be sent to the agent.

## Implementation Plan

### Step 1: Expose TaskViewerProvider getter methods to KanbanProvider
- Add public methods to `TaskViewerProvider.ts`:
  - `public isAccurateCodingEnabled(role: string): boolean`
  - `public isDependencyCheckEnabled(): boolean`
  - `public isAdvancedReviewerEnabled(): boolean`
  - `public isLeadInlineChallengeEnabled(): boolean`
  - `public isAggressivePairProgrammingEnabled(): boolean`
  - `public isSplitPlanEnabled(): boolean`
- These methods should accept an optional `role` parameter to return role-specific values

### Step 2: Update KanbanProvider getPromptPreview handler
- Modify `KanbanProvider.ts` case `'getPromptPreview'` (line 5838)
- Replace direct config reading with calls to TaskViewerProvider getter methods
- Ensure the same logic is used for both preview and dispatch

### Step 3: Update _getPromptsConfig for consistency
- Either deprecate `_getPromptsConfig()` or update it to use the same getter methods
- This ensures all paths use the same source of truth

### Step 4: Test the fix
- Verify that checking/unchecking accuracy checkbox in prompts tab updates the preview correctly
- Verify that checking/unchecking dependency checkbox in prompts tab updates the preview correctly
- Verify that the preview matches what is actually sent when dispatching

## Files to Modify
1. `src/services/TaskViewerProvider.ts` - Expose getter methods as public
2. `src/services/KanbanProvider.ts` - Update getPromptPreview to use TaskViewerProvider methods
3. Optionally: `src/services/KanbanProvider.ts` - Update _getPromptsConfig for consistency

## Success Criteria
- Prompts tab preview accurately reflects the addon settings that will be applied during dispatch
- No mismatch between preview and actual agent prompts
- Accuracy checkbox state in preview matches actual dispatch behavior
- Dependency checkbox state in preview matches actual dispatch behavior
