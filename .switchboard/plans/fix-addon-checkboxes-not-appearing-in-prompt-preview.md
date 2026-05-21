# Fix Addon Checkboxes Not Appearing in Prompt Preview

## Goal
Fix addon checkboxes in the Prompts tab so that checking/unchecking them updates the prompt preview to reflect the corresponding addon content.

## Metadata
- **Tags:** [bugfix, frontend, UX]
- **Complexity:** 5

## User Review Required
- Confirm whether `pairProgrammingEnabled` in preview should read from role config addons (UI checkbox state) or from `autobanState.pairProgrammingMode` (dispatch-time state). Recommendation: use role config addons for preview, since that's what the checkbox controls.

## Complexity Audit

### Routine
- Fix two typoed property names in `getPromptPreview` handler
- Add missing option passthrough in `getPromptPreview` handler
- Add missing option passthrough in `_getDefaultPromptPreviews`
- Add `pairProgramming` extraction to `_getPromptsConfig()`
- Fix inconsistent addon reading in `_getPromptsConfig()` for `aggressivePairProgramming` and `designDocEnabled`

### Complex / Risky
- The `pairProgrammingEnabled` option in `buildKanbanBatchPrompt` has different semantics in dispatch vs. preview: dispatch uses `autobanState.pairProgrammingMode`, preview should use the role config addon value. Must ensure the preview path doesn't accidentally change dispatch behavior.

## Edge-Case & Dependency Audit
- **Race Conditions:** None — preview generation is synchronous after config read.
- **Security:** No security implications — preview is read-only display.
- **Side Effects:** Fixing `_getPromptsConfig()` to read `aggressivePairProgramming` from role config instead of VS Code settings may change the value returned for existing users who have the VS Code setting set but haven't toggled the UI checkbox. The fallback chain (role config → VS Code setting → default) preserves backward compatibility.
- **Dependencies & Conflicts:** The `_generateBatchPlannerPrompt` and `_generateBatchExecutionPrompt` methods also call `_getPromptsConfig()` and pass options to `buildKanbanBatchPrompt()`. These dispatch paths already work correctly and should NOT be changed. Only the two preview paths need fixes.

## Dependencies
- None

## Adversarial Synthesis
Key risks: (1) Two typoed property names cause silent `undefined` resolution for `aggressivePairProgramming` and `splitPlan` in the `getPromptPreview` handler. (2) Missing option passthrough in both preview methods leaves `includeInlineChallenge`, `pairProgrammingEnabled`, and deep-planning options invisible. (3) `_getPromptsConfig()` doesn't read `pairProgramming` from lead/coder role configs, making those checkboxes dead in the preview. Mitigations: All fixes are single-file, additive-only, and the dispatch paths are unaffected.

## Problem
Addon checkboxes in the Switchboard UI (kanban.html) do not actually add their corresponding content to the prompt preview. When users check addon boxes like "Dependency Check", "Aggressive Pair Programming", "Split Plan", etc., the changes are saved to workspace state but are not reflected in the prompt preview box.

## Root Cause (Corrected)
The original diagnosis was partially wrong. `_getPromptsConfig()` (line 2129) already extracts most addon configs. The actual bugs are:

1. **Typoed property names in `getPromptPreview` handler (line 5472-5473):** References `promptsConfig.aggressivePairProgrammingEnabled` and `promptsConfig.splitPlanEnabled`, but `_getPromptsConfig()` returns `aggressivePairProgramming` and `splitPlan` (no "Enabled" suffix). These always resolve to `undefined`.

2. **Missing option passthrough in `getPromptPreview` handler (line 5464-5476):** Doesn't pass `includeInlineChallenge` (from `leadChallengeEnabled`) for lead, `pairProgrammingEnabled` for lead/coder, or `enableDeepPlanning`/`researchDepth` for research_planner.

3. **Missing option passthrough in `_getDefaultPromptPreviews` (line 2060-2095):** Same gaps — no `includeInlineChallenge`, no `pairProgrammingEnabled`, no `accurateCodingEnabled`, no `advancedReviewerEnabled`, no `dependencyCheckEnabled`, no `splitPlan`.

4. **`_getPromptsConfig()` doesn't extract `pairProgramming` from lead/coder role configs.** The UI saves it to `roleConfigs.lead.addons.pairProgramming`, but the method never reads it.

5. **Inconsistent addon reading in `_getPromptsConfig()`:** `dependencyCheckEnabled` and `splitPlan` correctly read from role config first (with VS Code settings fallback). But `aggressivePairProgramming` (line 2149) and `designDocEnabled` (line 2151) only read from VS Code settings, ignoring the role config. This means the planner's "Aggressive Pair Programming" and "Design Doc" checkboxes saved via the UI are invisible to the preview.

## Files to Modify
- `src/services/KanbanProvider.ts` — Fix `_getPromptsConfig()`, `getPromptPreview` handler, and `_getDefaultPromptPreviews`

## Addon-to-Option Mapping Table

This table maps each ROLE_ADDONS entry (from `sharedDefaults.js`) to the corresponding `PromptBuilderOptions` field (from `agentPromptBuilder.ts`) and shows the current extraction/passthrough status:

| Role | Addon ID | `_getPromptsConfig()` Property | `PromptBuilderOptions` Field | Extracted? | Passed in Preview? |
|:-----|:---------|:-------------------------------|:-----------------------------|:------------|:-------------------|
| planner | switchboardSafeguards | `switchboardSafeguardsByRole.planner` | `switchboardSafeguardsEnabled` | Yes | Yes |
| planner | dependencyCheck | `dependencyCheckEnabled` | `dependencyCheckEnabled` | Yes | Yes |
| planner | designDoc | `designDocEnabled` / `designDocLink` | `designDocLink` / `designDocContent` | Partially (VS Code only, not role config) | No (deliberate for preview) |
| planner | aggressivePairProgramming | `aggressivePairProgramming` | `aggressivePairProgramming` | Partially (VS Code only, not role config) | **BROKEN** (typo: `aggressivePairProgrammingEnabled`) |
| planner | gitProhibition | `gitProhibitionByRole.planner` | `gitProhibitionEnabled` | Yes | Yes |
| planner | splitPlan | `splitPlan` | `splitPlan` | Yes | **BROKEN** (typo: `splitPlanEnabled`) |
| planner | clearAntigravityContext | `clearAntigravityContextByRole.planner` | `clearAntigravityContext` | Yes | Yes |
| lead | switchboardSafeguards | `switchboardSafeguardsByRole.lead` | `switchboardSafeguardsEnabled` | Yes | Yes |
| lead | pairProgramming | *(not extracted)* | `pairProgrammingEnabled` | **NO** | **NO** |
| lead | leadChallenge | `leadChallengeEnabled` | `includeInlineChallenge` | Yes | **NO** |
| lead | accurateCoding | `accurateCodingEnabled` | `accurateCodingEnabled` | Yes | **NO** (only passed for coder) |
| lead | gitProhibition | `gitProhibitionByRole.lead` | `gitProhibitionEnabled` | Yes | Yes |
| lead | clearAntigravityContext | `clearAntigravityContextByRole.lead` | `clearAntigravityContext` | Yes | Yes |
| coder | switchboardSafeguards | `switchboardSafeguardsByRole.coder` | `switchboardSafeguardsEnabled` | Yes | Yes |
| coder | pairProgramming | *(not extracted)* | `pairProgrammingEnabled` | **NO** | **NO** |
| coder | accurateCoding | `accurateCodingEnabled` | `accurateCodingEnabled` | Yes | Yes (only in `getPromptPreview`, not in `_getDefaultPromptPreviews`) |
| coder | gitProhibition | `gitProhibitionByRole.coder` | `gitProhibitionEnabled` | Yes | Yes |
| coder | clearAntigravityContext | `clearAntigravityContextByRole.coder` | `clearAntigravityContext` | Yes | Yes |
| reviewer | switchboardSafeguards | `switchboardSafeguardsByRole.reviewer` | `switchboardSafeguardsEnabled` | Yes | Yes |
| reviewer | advancedRegression | `advancedReviewerEnabled` | `advancedReviewerEnabled` | Yes | Yes (only in `getPromptPreview`, not in `_getDefaultPromptPreviews`) |
| reviewer | gitProhibition | `gitProhibitionByRole.reviewer` | `gitProhibitionEnabled` | Yes | Yes |
| reviewer | clearAntigravityContext | `clearAntigravityContextByRole.reviewer` | `clearAntigravityContext` | Yes | Yes |
| research_planner | (deep planning) | `researchPlanner.enableDeepPlanning` | `enableDeepPlanning` | Yes | Yes (only in `_getDefaultPromptPreviews`, not in `getPromptPreview`) |
| research_planner | (research depth) | `researchPlanner.researchDepth` | `researchDepth` | Yes | Yes (only in `_getDefaultPromptPreviews`, not in `getPromptPreview`) |

## Implementation Plan

### Step 1: Fix `_getPromptsConfig()` to extract missing addons and fix inconsistencies
File: `src/services/KanbanProvider.ts`, method `_getPromptsConfig()` (line 2129)

**1a. Add `pairProgrammingEnabled` extraction from lead/coder role configs:**
Add to the returned object:
```typescript
pairProgrammingEnabled: {
    lead: leadConfig?.addons?.pairProgramming ?? false,
    coder: coderConfig?.addons?.pairProgramming ?? false,
},
```

**1b. Fix `aggressivePairProgramming` to read from role config first:**
Change line 2149 from:
```typescript
aggressivePairProgramming: config.get<boolean>('aggressivePairProgramming.enabled', false),
```
To:
```typescript
aggressivePairProgramming: plannerConfig?.addons?.aggressivePairProgramming ?? config.get<boolean>('aggressivePairProgramming.enabled', false),
```

**1c. Fix `designDocEnabled` to read from role config first:**
Change line 2151 from:
```typescript
designDocEnabled: config.get<boolean>('planner.designDocEnabled', false),
```
To:
```typescript
designDocEnabled: plannerConfig?.addons?.designDoc ?? config.get<boolean>('planner.designDocEnabled', false),
```

### Step 2: Fix `getPromptPreview` handler — typos and missing options
File: `src/services/KanbanProvider.ts`, case `'getPromptPreview'` (line 5457)

**2a. Fix typoed property names (line 5472-5473):**
Change:
```typescript
aggressivePairProgramming: role === 'planner' ? promptsConfig.aggressivePairProgrammingEnabled : undefined,
splitPlan: role === 'planner' ? promptsConfig.splitPlanEnabled : undefined,
```
To:
```typescript
aggressivePairProgramming: role === 'planner' ? promptsConfig.aggressivePairProgramming : undefined,
splitPlan: role === 'planner' ? promptsConfig.splitPlan : undefined,
```

**2b. Add missing `includeInlineChallenge` for lead role:**
Add to the options object:
```typescript
includeInlineChallenge: role === 'lead' ? (promptsConfig.leadChallengeEnabled ?? false) : undefined,
```

**2c. Add missing `pairProgrammingEnabled` for lead/coder roles:**
Add to the options object:
```typescript
pairProgrammingEnabled: (role === 'lead' || role === 'coder') ? (promptsConfig.pairProgrammingEnabled?.[role] ?? false) : undefined,
```

**2d. Add missing `accurateCodingEnabled` for lead role:**
Change:
```typescript
accurateCodingEnabled: role === 'coder' ? promptsConfig.accurateCodingEnabled : undefined
```
To:
```typescript
accurateCodingEnabled: (role === 'coder' || role === 'lead') ? promptsConfig.accurateCodingEnabled : undefined
```

**2e. Add missing `enableDeepPlanning` / `researchDepth` for research_planner:**
Add to the options object:
```typescript
enableDeepPlanning: role === 'research_planner' ? promptsConfig.researchPlanner?.enableDeepPlanning : undefined,
researchDepth: role === 'research_planner' ? promptsConfig.researchPlanner?.researchDepth : undefined,
```

### Step 3: Fix `_getDefaultPromptPreviews` — add missing role-specific options
File: `src/services/KanbanProvider.ts`, method `_getDefaultPromptPreviews()` (line 2060)

The current call (line 2072-2088) only passes safeguards, git prohibition, clear antigravity, deep planning, and a few planner-specific options. Add the missing role-specific options to match what `getPromptPreview` passes:

```typescript
const preview = buildKanbanBatchPrompt(role as any, [], {
    workspaceRoot,
    clearAntigravityContext: promptsConfig.clearAntigravityContextByRole?.[role as any] ?? false,
    defaultPromptOverrides,
    gitProhibitionEnabled: promptsConfig.gitProhibitionByRole?.[role as any] ?? true,
    switchboardSafeguardsEnabled: promptsConfig.switchboardSafeguardsByRole?.[role as any] ?? true,
    enableDeepPlanning: promptsConfig.researchPlanner?.enableDeepPlanning,
    researchDepth: promptsConfig.researchPlanner?.researchDepth,
    // Planner-specific options
    plannerWorkflowPath: role === 'planner' ? promptsConfig.plannerWorkflowPath : undefined,
    dependencyCheckEnabled: role === 'planner' ? promptsConfig.dependencyCheckEnabled : undefined,
    aggressivePairProgramming: role === 'planner' ? promptsConfig.aggressivePairProgramming : undefined,
    splitPlan: role === 'planner' ? promptsConfig.splitPlan : undefined,
    // Lead-specific options
    includeInlineChallenge: role === 'lead' ? (promptsConfig.leadChallengeEnabled ?? false) : undefined,
    pairProgrammingEnabled: (role === 'lead' || role === 'coder') ? (promptsConfig.pairProgrammingEnabled?.[role] ?? false) : undefined,
    // Coder/Lead-specific options
    accurateCodingEnabled: (role === 'coder' || role === 'lead') ? promptsConfig.accurateCodingEnabled : undefined,
    // Reviewer-specific options
    advancedReviewerEnabled: role === 'reviewer' ? promptsConfig.advancedReviewerEnabled : undefined,
});
```

### Step 4: Test the fix
After implementing the changes:
1. Open the Switchboard kanban board
2. Navigate to the Prompts tab
3. Select a role (e.g., planner, lead, coder)
4. Check/uncheck various addon checkboxes
5. Verify that the prompt preview updates to reflect the addon content
6. Test for all major roles: planner, lead, coder, reviewer

## Expected Outcome
After the fix:
- Checking "Dependency Check" for planner should add the DEPENDENCY_CHECK_DIRECTIVE to the preview
- Checking "Aggressive Pair Programming" for planner should add the AGGRESSIVE_PAIR_PROGRAMMING_DIRECTIVE
- Checking "Split Plan" for planner should add the SPLIT_PLAN_DIRECTIVE
- Checking "Inline Adversarial Challenge" for lead should add the INLINE_CHALLENGE_DIRECTIVE
- Checking "Pair Programming" for lead should add the pair programming note
- Checking "Pair Programming" for coder should add the "only do Routine work" instruction
- Checking "Accuracy Mode" for coder or lead should add the accuracy instruction
- Checking "Advanced Regression Analysis" for reviewer should add the ADVANCED_REVIEWER_DIRECTIVE
- All other addon checkboxes should similarly add their corresponding content to the prompt preview

## Validation
The fix can be validated by:
1. Manually testing each addon checkbox in the UI and verifying the preview updates
2. Checking that the actual prompts generated during dispatch also include the addon content (since they use the same `buildKanbanBatchPrompt()` function) — dispatch paths should be UNCHANGED by this fix
3. Ensuring no regressions in existing prompt generation behavior

## Recommendation
Complexity 5 → **Send to Coder**

---

## Reviewer Pass — 2026-05-21

### Stage 1: Grumpy Principal Engineer Findings

| # | Finding | Severity | Status |
|---|---------|----------|--------|
| 1 | `getPromptPreview` handler read `pairProgrammingEnabled` from `autobanState.pairProgrammingMode` (dispatch-time state) instead of `promptsConfig.pairProgrammingEnabled?.[role]` (role config addon, what the checkbox controls). The core bug was still present for the pair programming checkbox — toggling it had no visible effect on the interactive preview. | **CRITICAL** | **FIXED** |
| 2 | `_getDefaultPromptPreviews` passes `enableDeepPlanning`/`researchDepth` unconditionally for all roles, while `getPromptPreview` gates them to `research_planner` only. Inconsistent but harmless — `buildKanbanBatchPrompt` ignores these for non-research_planner roles. | NIT | Deferred |
| 3 | Test file `kanban-default-prompt-previews.test.js` only covers `_getDefaultPromptPreviews`, not the `getPromptPreview` handler (where the bug was). | NIT | Deferred |

### Stage 2: Balanced Synthesis

- **Finding 1 (CRITICAL): Fix applied.** Changed `getPromptPreview` to read `pairProgrammingEnabled` from `promptsConfig.pairProgrammingEnabled?.[role]` (role config addon) instead of `autobanState.pairProgrammingMode`. This matches the plan's Step 2c and the `_getDefaultPromptPreviews` implementation. Dispatch paths (`_generateBatchExecutionPrompt`, `_dispatchWithPairProgrammingIfNeeded`) remain unchanged — they correctly use `autobanState` for dispatch-time behavior.
- **Finding 2 (NIT): Deferred.** Harmless inconsistency. Can be cleaned up in a future pass.
- **Finding 3 (NIT): Deferred.** Testing `getPromptPreview` would require mocking the full message handler infrastructure. The `_getDefaultPromptPreviews` test covers the same `buildKanbanBatchPrompt` option-passthrough logic.

### Code Fix Applied

**File:** `src/services/KanbanProvider.ts`, `getPromptPreview` handler (line ~5779-5801)

**Before (broken):**
```typescript
// Pair programming: use runtime autoban state for interactive preview
// (matches _generateBatchExecutionPrompt which reads from autoban state)
const pairProgrammingEnabled = (role === 'lead' || role === 'coder' || role === 'intern')
    ? (this._autobanState?.pairProgrammingMode ?? 'off') !== 'off'
    : undefined;
// ... later:
pairProgrammingEnabled,
```

**After (fixed):**
```typescript
// Preview reads from role config addon (what the checkbox controls);
// dispatch paths (_generateBatchExecutionPrompt etc.) correctly use autobanState.
pairProgrammingEnabled: (role === 'lead' || role === 'coder') ? (promptsConfig.pairProgrammingEnabled?.[role] ?? false) : undefined,
```

### Verification Results

- **TypeScript check:** Pre-existing errors only (import path extensions in `ClickUpSyncService.ts:2309` and `KanbanProvider.ts:4470`). No new errors from this change.
- **Unit test `kanban-default-prompt-previews.test.js`:** PASS (all assertions)
- **Unit test `agent-prompt-builder-subagents.test.js`:** PASS (all 23 sub-tests)

### Implementation Step Verification

| Step | Description | Status |
|------|-------------|--------|
| 1a | Add `pairProgrammingEnabled` extraction to `_getPromptsConfig()` | ✅ Verified (line 2244-2247) |
| 1b | Fix `aggressivePairProgramming` to read from role config first | ✅ Verified (line 2250) |
| 1c | Fix `designDocEnabled` to read from role config first | ✅ Verified (line 2252) |
| 2a | Fix typoed property names (`aggressivePairProgrammingEnabled` → `aggressivePairProgramming`, `splitPlanEnabled` → `splitPlan`) | ✅ Verified (no occurrences of typoed names remain) |
| 2b | Add `includeInlineChallenge` for lead role | ✅ Verified (line 5798) |
| 2c | Add `pairProgrammingEnabled` for lead/coder from role config | ✅ Fixed during review (line 5801) — was reading from `autobanState`, now reads from `promptsConfig.pairProgrammingEnabled?.[role]` |
| 2d | Add `accurateCodingEnabled` for lead role | ✅ Verified (line 5797) |
| 2e | Add `enableDeepPlanning`/`researchDepth` for research_planner | ✅ Verified (lines 5802-5803) |
| 3 | Fix `_getDefaultPromptPreviews` — add missing role-specific options | ✅ Verified (lines 2170-2184) |

### Remaining Risks

1. **`intern` role pair programming:** The `getPromptPreview` handler no longer includes `intern` in the `pairProgrammingEnabled` check (matching the plan and `_getDefaultPromptPreviews`). The `intern` role has no `pairProgramming` addon in `ROLE_ADDONS`, so this is correct. Dispatch paths still handle intern pair programming via `autobanState`.
2. **`designDocEnabled` in preview:** The plan's mapping table marks design doc as "No (deliberate for preview)" for the `getPromptPreview` handler. The implementation does pass `designDocLink`/`designDocContent` for planner in the preview, which is more than the original table suggested. This is a positive deviation — it makes the preview more accurate.
3. **No test for `getPromptPreview` handler directly.** The interactive preview path relies on the same `buildKanbanBatchPrompt` options that are tested via `_getDefaultPromptPreviews`. A dedicated test would require mocking the webview message infrastructure.
