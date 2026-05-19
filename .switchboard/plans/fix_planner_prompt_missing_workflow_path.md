# Fix Default Prompt Previews Missing Role-Specific Options

## Goal
Fix the `_getDefaultPromptPreviews` method in `KanbanProvider.ts` so that the Prompts tab preview includes role-specific options (planner workflow path, dependency check, pair programming, split plan, and reviewer advanced regression) instead of silently falling back to defaults.

## Metadata
- **Tags:** [bugfix, frontend]
- **Complexity:** 3

## Problem
The Prompts tab preview for the planner and reviewer roles never reflects their role-specific configuration. Checkboxes and settings are saved correctly, but the preview always shows defaults because `_getDefaultPromptPreviews` omits the options entirely.

## Root Cause
In `KanbanProvider.ts`, there are two code paths that generate prompt previews:

1. **`getPromptPreview` handler (line 5382-5406)** — This path **correctly** passes `plannerWorkflowPath` on line 5400:
   ```typescript
   plannerWorkflowPath: role === 'planner' ? promptsConfig.plannerWorkflowPath : undefined,
   ```
   This path is **NOT broken**.

2. **`_getDefaultPromptPreviews` (line 2030-2057)** — This path generates previews for ALL roles in a loop but **does not pass `plannerWorkflowPath`** (or any other planner-specific options) to `buildKanbanBatchPrompt`. The options object (lines 2043-2051) only includes generic options plus `enableDeepPlanning`/`researchDepth` for research_planner:
   ```typescript
   const preview = buildKanbanBatchPrompt(role as any, [], {
       workspaceRoot,
       personaContent: personaContent?.trim() || undefined,
       defaultPromptOverrides,
       gitProhibitionEnabled: promptsConfig.gitProhibitionByRole?.[role as any] ?? true,
       switchboardSafeguardsEnabled: promptsConfig.switchboardSafeguardsByRole?.[role as any] ?? true,
       enableDeepPlanning: promptsConfig.researchPlanner?.enableDeepPlanning,
       researchDepth: promptsConfig.researchPlanner?.researchDepth
   });
   ```

When `plannerWorkflowPath` is absent, `buildKanbanBatchPrompt` (agentPromptBuilder.ts line 285) falls back to `DEFAULT_PLANNER_WORKFLOW` (`'.agent/workflows/improve-plan.md'`), so the preview never shows the user's configured path. Similarly, when `advancedReviewerEnabled` is absent, the reviewer preview never reflects the advanced regression setting.

**Reference patterns**:
- `_generateBatchPlannerPrompt` (line 2214-2227) correctly passes all planner options.
- `_generateBatchReviewerPrompt` (line 2493-2501) correctly passes `advancedReviewerEnabled`.

Both should be used as canonical references for what `_getDefaultPromptPreviews` should include for their respective roles.

## User Review Required
- None

## Complexity Audit
### Routine
- Add `plannerWorkflowPath`, `dependencyCheckEnabled`, `aggressivePairProgramming`, `splitPlan` to the `_getDefaultPromptPreviews` options object for the planner role
- Add `advancedReviewerEnabled` to the `_getDefaultPromptPreviews` options object for the reviewer role
- Add unit tests verifying the options are passed through

### Complex / Risky
- None

## Edge-Case & Dependency Audit
- **Race Conditions**: None — `_getDefaultPromptPreviews` is a synchronous-reading async method with no shared mutable state concerns.
- **Security**: No security implications — this is a UI preview path only.
- **Side Effects**: Adding options to the `buildKanbanBatchPrompt` call is purely additive. The function already handles `undefined` values gracefully. No existing behavior changes for roles other than planner and reviewer.
- **Dependencies & Conflicts**: No conflicts with other in-flight work. The `buildKanbanBatchPrompt` interface already supports all the options being added.

## Dependencies
- None

## Adversarial Synthesis
Key risks: Fixing only `plannerWorkflowPath` without the other planner-specific options (`dependencyCheckEnabled`, `aggressivePairProgramming`, `splitPlan`) creates an inconsistent preview where some planner settings are reflected and others aren't. The same class of bug affects the reviewer role (`advancedReviewerEnabled` missing). Mitigations: Add all role-specific options in one pass, matching the `_generateBatchPlannerPrompt` and `_generateBatchReviewerPrompt` reference patterns. The `getPromptPreview` handler is NOT broken and should not be modified.

## Proposed Changes

### `src/services/KanbanProvider.ts` — `_getDefaultPromptPreviews` (line 2043-2051)
- **Context**: This method generates preview prompts for all roles. It currently omits planner-specific and reviewer-specific options.
- **Logic**: When `role === 'planner'`, add the same planner-specific options that `_generateBatchPlannerPrompt` passes (line 2214-2227). When `role === 'reviewer'`, add `advancedReviewerEnabled` that `_generateBatchReviewerPrompt` passes (line 2493-2501).
- **Implementation**: Modify the options object in the loop body to conditionally include role-specific options:
  ```typescript
  const preview = buildKanbanBatchPrompt(role as any, [], {
      workspaceRoot,
      personaContent: personaContent?.trim() || undefined,
      defaultPromptOverrides,
      gitProhibitionEnabled: promptsConfig.gitProhibitionByRole?.[role as any] ?? true,
      switchboardSafeguardsEnabled: promptsConfig.switchboardSafeguardsByRole?.[role as any] ?? true,
      enableDeepPlanning: promptsConfig.researchPlanner?.enableDeepPlanning,
      researchDepth: promptsConfig.researchPlanner?.researchDepth,
      // Planner-specific options (matching _generateBatchPlannerPrompt pattern)
      plannerWorkflowPath: role === 'planner' ? promptsConfig.plannerWorkflowPath : undefined,
      dependencyCheckEnabled: role === 'planner' ? promptsConfig.dependencyCheckEnabled : undefined,
      aggressivePairProgramming: role === 'planner' ? promptsConfig.aggressivePairProgramming : undefined,
      splitPlan: role === 'planner' ? promptsConfig.splitPlan : undefined,
      // Reviewer-specific options (matching _generateBatchReviewerPrompt pattern)
      advancedReviewerEnabled: role === 'reviewer' ? promptsConfig.advancedReviewerEnabled : undefined,
  });
  ```
- **Edge Cases**: When `plannerWorkflowPath` is `undefined` (no custom path configured), `buildKanbanBatchPrompt` falls back to `DEFAULT_PLANNER_WORKFLOW` — this is correct default behavior and should not be overridden.

### `src/test/minimal-prompt.test.js` or `src/test/agent-prompt-builder-subagents.test.js`
- **Context**: Existing tests already verify `plannerWorkflowPath` in `buildKanbanBatchPrompt`. No test exists for `_getDefaultPromptPreviews` passing the option through.
- **Logic**: Add tests that call `_getDefaultPromptPreviews` (or the message handler) and verify the planner and reviewer previews include their role-specific options when configured.
- **Implementation**: Add test cases that set custom `plannerWorkflowPath` and `advancedReviewerEnabled` in config, call the method, and assert the preview text reflects the configured values rather than defaults.
- **Edge Cases**: Test both default (no config) and custom config scenarios for both planner and reviewer.

## Verification Plan
### Automated Tests
1. Unit test: `_getDefaultPromptPreviews` returns a planner preview containing the configured `plannerWorkflowPath` when set.
2. Unit test: `_getDefaultPromptPreviews` returns a planner preview containing the default workflow path when no custom path is configured.
3. Unit test: `_getDefaultPromptPreviews` returns a reviewer preview reflecting `advancedReviewerEnabled` when set.
4. Existing test suite (`agent-prompt-builder-subagents.test.js`, `minimal-prompt.test.js`) should continue to pass unchanged.

### Manual Verification
1. Open the Prompts tab in the Kanban webview.
2. Select the **Planner** role.
3. Verify the prompt preview includes the workflow file path (e.g., "Read .agent/workflows/improve-plan.md and follow it step-by-step").
4. Change the workflow file path in the configuration.
5. Confirm the prompt preview updates to reflect the new path.
6. Select the **Reviewer** role.
7. Toggle the advanced regression analysis setting.
8. Confirm the prompt preview updates to include or exclude the advanced regression block.

## Affected Files
- `src/services/KanbanProvider.ts` — add planner-specific and reviewer-specific options to `_getDefaultPromptPreviews` options object (line ~2043-2051)

## Recommendation
Complexity ≤ 6 → **Send to Coder**

## Reviewer-Executor Verification

### Stage 1: Grumpy Review (Findings)
- **[CRITICAL]** The plan instructs adding `plannerWorkflowPath`, `dependencyCheckEnabled`, `aggressivePairProgramming`, `splitPlan`, and `advancedReviewerEnabled` to the options object in `_getDefaultPromptPreviews` in `KanbanProvider.ts`. However, looking at the code, these changes (and even `accurateCodingEnabled`) have **already been applied**! 
- **[CRITICAL]** The plan demands tests be added to `minimal-prompt.test.js` or `agent-prompt-builder-subagents.test.js`, but these files test `buildKanbanBatchPrompt` directly, NOT `KanbanProvider._getDefaultPromptPreviews`. There is an existing test file `kanban-default-prompt-previews.test.js` that tests this exact behavior.

### Stage 2: Balanced Synthesis
- **Keep**: The intent of the plan was correct; `_getDefaultPromptPreviews` needed to mirror the `role === 'role'` conditionally injected variables to maintain preview accuracy.
- **Fix Now**: The code has actually already been updated (as shown in my `git diff` and search results), and the test `kanban-default-prompt-previews.test.js` already covers this behavior. 
- **Defer**: No actual code changes are required because the bug was already fixed in a previous or parallel commit.

### Fixes Applied
- None required (implementation was already completed previously).

### Verification Results
- **Files Changed**: None.
- **Validation**: Reviewed `src/services/KanbanProvider.ts` and the `_getDefaultPromptPreviews` block contains all required options mapping to `promptsConfig`.
- **Remaining Risks**: None. The changes meet all requirements of the plan.