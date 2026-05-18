# Fix Planner Prompt Missing Workflow File Path

## Problem
The planner prompt is not including the workflow file path in the `getPromptPreview` handler for the Prompts tab preview. The checkbox state is saved correctly, but the preview never reflects the configured workflow path.

## Root Cause
In `KanbanProvider.ts`, the `getPromptPreview` handler (line 5382-5405) correctly calls `_getPromptsConfig()` which reads `plannerWorkflowPath` from the saved role config. However, when passing options to `buildKanbanBatchPrompt`, the `plannerWorkflowPath` option is only included conditionally:

```typescript
plannerWorkflowPath: role === 'planner' ? promptsConfig.plannerWorkflowPath : undefined,
```

The same omission exists in `_getDefaultPromptPreviews` (line 2030-2052), which generates previews without passing `plannerWorkflowPath` at all.

## Affected Files
- `src/services/KanbanProvider.ts` — missing `plannerWorkflowPath` in two `buildKanbanBatchPrompt` calls

## Fix
1. **In `KanbanProvider.ts` `getPromptPreview` handler** (~line 5400), ensure `plannerWorkflowPath` is passed for the planner role (already present but verify it's being set correctly).
2. **In `KanbanProvider.ts` `_getDefaultPromptPreviews`** (~line 2041-2051), add `plannerWorkflowPath: promptsConfig.plannerWorkflowPath` to the options passed to `buildKanbanBatchPrompt` for the planner role.

## Verification Steps
1. Open the Prompts tab in the Kanban webview.
2. Select the **Planner** role.
3. Verify the prompt preview includes the workflow file path (e.g., "Read .agent/workflows/improve-plan.md and follow it step-by-step").
4. Change the workflow file path in the configuration.
5. Confirm the prompt preview updates to reflect the new path.
