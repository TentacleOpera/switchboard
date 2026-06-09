# Fix: Accurate Coding checkbox in Prompts tab does not update prompt preview

## Goal
Fix the Prompts tab so that toggling the **Accurate Coding** add-on checkbox for the `coder` role immediately updates the prompt preview to include (or remove) the Accuracy Mode instruction block.

## Metadata
- **Tags:** [bugfix, frontend, UX]
- **Complexity:** 3

## User Review Required
- Confirm that the `lead` role's `accurateCoding` checkbox gap (UI exists but backend ignores it) should be tracked as a separate issue rather than fixed here.
- Confirm that adding per-role `accurateCodingByRole` resolution to `_getPromptsConfig` is a follow-up, not part of this fix.

## Complexity Audit

### Routine
- Add `accurateCodingEnabled` to the options object in two `buildKanbanBatchPrompt` calls in `KanbanProvider.ts`
- Both call sites already have `promptsConfig` available from `_getPromptsConfig()`
- The pattern for role-conditional options (`role === 'coder' ? value : undefined`) already exists for `advancedReviewerEnabled` and `dependencyCheckEnabled` in the same handler
- `buildKanbanBatchPrompt` already reads `options?.accurateCodingEnabled` and applies it via `withCoderAccuracyInstruction` — no changes needed in `agentPromptBuilder.ts`

### Complex / Risky
- None

## Edge-Case & Dependency Audit

- **Race Conditions:** None. The preview is generated synchronously from config state on each request; there is no async race between checkbox toggle and preview refresh.
- **Security:** No impact. This only affects prompt text displayed in a webview preview.
- **Side Effects:** None. Adding the option only affects the preview output; it does not change prompt generation for actual dispatch (which already passes `accurateCodingEnabled` correctly at lines 2308 and 5073).
- **Dependencies & Conflicts:**
  - The copy-to-clipboard path (`_generateBatchPromptForRole`, line 2270) intentionally omits `accurateCodingEnabled` with a documented comment (lines 2265-2266): "Accuracy mode is NOT included in copy-to-clipboard prompts — it requires MCP tools only available in CLI terminal sessions." **Do not add it there.**
  - `_getPromptsConfig` returns `accurateCodingEnabled` as a combined boolean (`coderConfig?.addons?.accurateCoding ?? leadConfig?.addons?.accurateCoding ?? config.get(...)`). This means if only `lead` has accurateCoding enabled, the combined boolean is `true`. Using the role-conditional pattern (`role === 'coder' ? ...`) mitigates this for the preview, but the underlying combined scalar is a pre-existing design debt that should be addressed separately (see User Review Required).

## Dependencies
- None

## Adversarial Synthesis
Key risks: (1) The combined `accurateCodingEnabled` boolean in `_getPromptsConfig` conflates coder and lead configs via `??` fallthrough, which could cause a false-positive preview if only lead has the addon enabled. Mitigation: use the role-conditional pattern (`role === 'coder' ? promptsConfig.accurateCodingEnabled : undefined`) matching existing conventions for `advancedReviewerEnabled`/`dependencyCheckEnabled`. (2) The `lead` role has an `accurateCoding` checkbox in the UI but the backend silently ignores it — this is a separate feature gap, not a regression, and should be tracked independently.

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

### `src/services/KanbanProvider.ts` — `getPromptPreview` handler

**Context:** Inside the `case 'getPromptPreview'` block, after `promptsConfig` is obtained from `_getPromptsConfig()`.

**Logic:** Add `accurateCodingEnabled` to the options object passed to `buildKanbanBatchPrompt`, scoped to the `coder` role only (matching the pattern used for `advancedReviewerEnabled` and `dependencyCheckEnabled`).

**Implementation:** In the options object at the `buildKanbanBatchPrompt` call (currently around line 5397), add:

```typescript
accurateCodingEnabled: role === 'coder' ? promptsConfig.accurateCodingEnabled : undefined,
```

This should be placed alongside the other role-conditional options (`advancedReviewerEnabled`, `dependencyCheckEnabled`, etc.) for consistency.

**Edge Cases:** If `role` is not `'coder'`, `undefined` is passed and `buildKanbanBatchPrompt` defaults to `false` — no change in behavior for other roles.

### `src/services/KanbanProvider.ts` — `_getDefaultPromptPreviews` method

**Context:** Inside the `for (const role of roles)` loop, after `promptsConfig` is obtained.

**Logic:** Same fix — add `accurateCodingEnabled` scoped to the `coder` role.

**Implementation:** In the options object at the `buildKanbanBatchPrompt` call (currently around line 2043), add:

```typescript
accurateCodingEnabled: role === 'coder' ? promptsConfig.accurateCodingEnabled : undefined,
```

**Edge Cases:** Same as above — harmless for non-coder roles.

### Note on `lead` role (out of scope)
`ROLE_ADDONS` defines `accurateCoding` for both `lead` and `coder` (see `sharedDefaults.js:72,78`), but `buildKanbanBatchPrompt` currently only applies the accuracy instruction for `coder` (via `withCoderAccuracyInstruction` at `agentPromptBuilder.ts:474`). If `lead` is also expected to trigger the accuracy workflow, a second change in `src/services/agentPromptBuilder.ts` would be needed to append the instruction for `lead` prompts as well. This is a **separate feature gap** — the checkbox exists in the UI but the backend silently ignores it. Track as a follow-up issue.

### Note on copy-to-clipboard path (no change needed)
The `_generateBatchPromptForRole` method (line 2270) also calls `buildKanbanBatchPrompt` without `accurateCodingEnabled`. This is **intentional** — there is an explicit comment (lines 2265-2266): "Accuracy mode is NOT included in copy-to-clipboard prompts — it requires MCP tools only available in CLI terminal sessions." Do not add `accurateCodingEnabled` there.

## Verification Steps
1. Open the Prompts tab in the Kanban webview.
2. Select the **Coder** role.
3. Check the **Accurate Coding** add-on.
4. Confirm the prompt preview updates to include the `Accuracy Mode` block referencing `.agent/workflows/accuracy.md`.
5. Uncheck the box and confirm the block disappears from the preview.
6. Switch to the **Lead** role, toggle **Accurate Coding**, and confirm the preview does NOT show the accuracy block (current expected behavior — the backend doesn't apply it for lead).
7. Reload the webview and confirm the default previews for all roles load without error.

## Verification Plan

### Automated Tests
- Add an assertion to `src/test/prompts-tab-move-regression.test.js` (or create a focused test) verifying that the `getPromptPreview` handler's source code passes `accurateCodingEnabled` to `buildKanbanBatchPrompt`. Pattern: assert that the `case 'getPromptPreview'` block in `KanbanProvider.ts` contains `accurateCodingEnabled` within the options object.
- If a unit test harness for `buildKanbanBatchPrompt` exists or is added, include a test case: `buildKanbanBatchPrompt('coder', [], { accurateCodingEnabled: true })` should return a string containing `Accuracy Mode` and `.agent/workflows/accuracy.md`.

## Recommendation
Complexity 3 → **Send to Intern**

---
## Code Review & Validation (Completed)

### Stage 1 (Grumpy)
- **[CRITICAL] Missing Tests:** The verification plan specifically requested a regex test in `prompts-tab-move-regression.test.js` or an assertion in `agentPromptBuilder.test.ts` for the coder accurate mode check. Both were missing. You implemented the feature perfectly but dropped the ball on testing.

### Stage 2 (Balanced)
- **What to Keep:** The inline ternary logic (`role === 'coder' ? promptsConfig.accurateCodingEnabled : undefined`) was injected perfectly into both `getPromptPreview` and `_getDefaultPromptPreviews`. It respects the existing pattern gracefully.
- **What to Fix:** I have added Test 10 into `prompts-tab-move-regression.test.js` to ensure this switch isn't removed in the future. Also added two `agentPromptBuilder` unit tests to ensure `Accuracy Mode` is injected properly.
- **What to Defer:** The lead role accurately ignoring this checkbox is functioning as intended per the original design, tracked separately.

### Validation Results
- Modified `prompts-tab-move-regression.test.js` to assert `accurateCodingEnabled` parsing in KanbanProvider.
- Added two explicit test cases to `agentPromptBuilder.test.ts`.
- `npm run compile-tests && node out/test/prompts-tab-move-regression.test.js` and `mocha` both run 100% green.

### Files Changed
- `src/services/__tests__/agentPromptBuilder.test.ts`
- `src/test/prompts-tab-move-regression.test.js`

### Remaining Risks
- None.
