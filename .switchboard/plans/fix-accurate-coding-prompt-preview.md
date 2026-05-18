# Fix: Accurate Coding checkbox in Prompts tab does not update prompt preview

## Problem
In the Prompts tab of `kanban.html`, toggling the **Accurate Coding** add-on checkbox for the `coder` (and `lead`) role has no effect on the prompt preview. The checkbox state is saved correctly, but the preview never reflects the change.

## Root Cause
1. The frontend correctly saves `roleConfigs[role].addons.accurateCoding` and calls `refreshPreview()`, which sends `getPromptPreview` to the backend.
2. `KanbanProvider.ts` handles `getPromptPreview` by calling `_getPromptsConfig()` — which **does** read `accurateCodingEnabled` from the saved role config.
3. However, the handler then calls `buildKanbanBatchPrompt(role, [], { ... })` but **omits** `accurateCodingEnabled` from the options object.
4. `buildKanbanBatchPrompt` supports the flag (it passes it to `withCoderAccuracyInstruction` for the `coder` role), but because it is never passed, the preview always behaves as if the checkbox is unchecked.

The same omission exists in `_getDefaultPromptPreviews()`.

## Affected Files
- `src/services/KanbanProvider.ts` — missing `accurateCodingEnabled` in two `buildKanbanBatchPrompt` calls

## Fix
1. **In `KanbanProvider.ts` `getPromptPreview` handler** (~line 5390), add `accurateCodingEnabled: promptsConfig.accurateCodingEnabled` to the options passed to `buildKanbanBatchPrompt`.
2. **In `KanbanProvider.ts` `_getDefaultPromptPreviews`** (~line 2043), add the same option.

### Note on `lead` role
`ROLE_ADDONS` defines `accurateCoding` for both `lead` and `coder`, but `buildKanbanBatchPrompt` currently only applies the accuracy instruction for `coder`. If `lead` is also expected to trigger the accuracy workflow, a second change in `src/services/agentPromptBuilder.ts` would be needed to append the instruction for `lead` prompts as well. Verify whether this is intended before expanding scope.

## Verification Steps
1. Open the Prompts tab in the Kanban webview.
2. Select the **Coder** role.
3. Check the **Accurate Coding** add-on.
4. Confirm the prompt preview updates to include the `Accuracy Mode` block referencing `.agent/workflows/accuracy.md`.
5. Uncheck the box and confirm the block disappears from the preview.

## Optional Test Update
- If there is an existing test that asserts `getPromptPreview` output, add an assertion verifying that toggling `accurateCodingEnabled` changes the preview for the `coder` role.
