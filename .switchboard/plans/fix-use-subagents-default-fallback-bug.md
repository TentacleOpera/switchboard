# Fix "Use Subagents for Multiple Plans" Default Fallback Bug

## Goal

Fix the bug where the "Use Subagents for Multiple Plans" checkbox setting is not respected in generated prompts. Even when the checkbox is unchecked, prompts still include the parallel sub-agent instruction.

**AUDIT FINDING #1**: This is the ONLY addon with a mismatch between UI defaults and backend fallbacks. All other addons (switchboardSafeguards, gitProhibition, cavemanOutput, skipCompilation, skipTests, clearAntigravityContext, suppressWalkthrough, includeDependencyInstructions) have matching defaults between `sharedDefaults.js` and `KanbanProvider.ts` fallbacks.

**AUDIT FINDING #2 (ROOT CAUSE)**: The bug exists in FOUR locations:
1. `agentPromptBuilder.ts` line 286: `?? true` fallback
2. `KanbanProvider.ts` line 2440-2450: `useSubagentsByRole` map with `?? true` fallbacks
3. `TaskViewerProvider.ts` line 6156: `?? true` fallback in `_dispatchConfiguredKanbanColumnPrompt`
4. `TaskViewerProvider.ts` line 2808: `?? true` fallback in pair programming prompt
5. `TaskViewerProvider.ts` lines 14822-14948: `buildKanbanBatchPrompt` calls in `_handleTriggerAgentActionInternal` MISSING parameters compared to Kanban board prompts

**CRITICAL FINDING**: The implementation.html action buttons use a DIFFERENT code path (`_handleTriggerAgentActionInternal` in TaskViewerProvider.ts) than the Kanban board (`_generateBatchPlannerPrompt` in KanbanProvider.ts). Both call `buildKanbanBatchPrompt`, but they pass DIFFERENT parameters. This is wrong - they should pass IDENTICAL parameters so prompts are consistent across all UI surfaces.

**ARCHITECTURAL FIX REQUIRED**: Having two separate prompt-building code paths in different files (`KanbanProvider.ts` vs `TaskViewerProvider.ts`) is unnecessary and error-prone. The proper fix is to consolidate these into a single shared prompt-building method. This plan includes the consolidation as part of the fix, not as future work.

**Example - Planner Role Comparison:**

**Kanban board (KanbanProvider.ts line 2839-2857):**
- `clearAntigravityContext: promptsConfig.clearAntigravityContextByRole?.planner ?? false`
- `cavemanOutputEnabled: promptsConfig.cavemanOutputByRole?.planner ?? false`
- `aggressivePairProgramming`
- `dependencyCheckEnabled: promptsConfig.dependencyCheckEnabled`
- `plannerWorkflowPath: promptsConfig.plannerWorkflowPath`
- `designDocLink`
- `designDocContent`
- `splitPlan: promptsConfig.splitPlan`
- `skipCompilation: promptsConfig.skipCompilationByRole?.planner ?? false`
- `skipTests: promptsConfig.skipTestsByRole?.planner ?? false`
- `gitProhibitionEnabled: promptsConfig.gitProhibitionEnabled`
- `switchboardSafeguardsEnabled: promptsConfig.switchboardSafeguardsByRole?.planner ?? true`
- `useSubagentsEnabled: promptsConfig.useSubagentsByRole?.planner ?? true`
- `defaultPromptOverrides`
- `workspaceRoot`
- `sourceColumnLabel`
- `routingMapConfig: this._routingMapConfig`

**Implementation.html (TaskViewerProvider.ts line 14822-14833):**
- `instruction: plannerInstruction`
- `aggressivePairProgramming: this._isAggressivePairProgrammingEnabled()`
- `splitPlan: this._isSplitPlanEnabled()`
- `designDocLink`
- `designDocContent`
- `defaultPromptOverrides: this._cachedDefaultPromptOverrides`
- `workspaceRoot: effectiveWorkspaceRoot`
- `gitProhibitionEnabled`
- `switchboardSafeguardsEnabled`
- `routingMapConfig`

**MISSING from implementation.html:**
- `clearAntigravityContext`
- `cavemanOutputEnabled`
- `dependencyCheckEnabled`
- `plannerWorkflowPath`
- `skipCompilation`
- `skipTests`
- `useSubagentsEnabled`
- `sourceColumnLabel`
- `includeDependencyInstructions`

This means implementation.html buttons send fundamentally different prompts than the Kanban board, even though both should use the same `buildKanbanBatchPrompt` function.

## Metadata

**Tags:** bugfix, prompt-builder, configuration
**Complexity:** 3

## User Review Required

No breaking changes. This is a bugfix to make the UI checkbox behavior match the actual prompt output.

## Complexity Audit

### Routine
- Change fallback from `?? true` to `?? false` in `KanbanProvider.ts` `useSubagentsByRole` map (line 2440-2450)
- Change fallback from `?? true` to `?? false` in `agentPromptBuilder.ts` extraction (line 286)
- Change fallback from `?? true` to `?? false` in `TaskViewerProvider.ts` line 6156
- Change fallback from `?? true` to `?? false` in `TaskViewerProvider.ts` line 2808
- **Consolidate prompt-building paths**: Move `_generateBatchPlannerPrompt`, `_generateBatchExecutionPrompt`, `_generateBatchReviewerPrompt`, `_generateBatchTesterPrompt` from `KanbanProvider.ts` to a shared location (e.g., `agentPromptBuilder.ts` or a new `promptBuilderHelpers.ts`)
- Update `TaskViewerProvider.ts` `_handleTriggerAgentActionInternal` to call the shared prompt-building methods instead of duplicating the logic
- Update unit test to reflect new default behavior (sequential instead of parallel)

## Edge-Case & Dependency Audit

### Race Conditions
- None. This is a pure configuration read path change.

### Security
- None. This only affects prompt text content.

### Side Effects
- Users who have never saved a config will now get sequential instruction by default (matching the unchecked checkbox state)
- Users with existing saved configs will get their saved value (no change)
- The change aligns backend behavior with the UI default (`default: false` in `ROLE_ADDONS` and `DEFAULT_ROLE_CONFIG`)

### Dependencies & Conflicts
- None. This is a localized change to two files.

## Dependencies

None

## Adversarial Synthesis

The root cause is a mismatch between UI defaults and backend fallbacks across multiple files:
- UI: `ROLE_ADDONS` has `default: false` for the checkbox
- UI: `DEFAULT_ROLE_CONFIG` has `useSubagents: false` for all roles
- Backend KanbanProvider: uses `?? true` fallback when reading config
- Backend agentPromptBuilder: uses `?? true` fallback when extracting option
- Backend TaskViewerProvider: uses `?? true` fallback in two locations
- Backend TaskViewerProvider: MISSING `useSubagentsEnabled` parameter in `buildKanbanBatchPrompt` calls for implementation.html action buttons

This means when the checkbox is unchecked (no saved config), the backend interprets `undefined` as `true` via the fallbacks, sending the parallel instruction despite the user's choice.

Fix: Change all fallbacks to `?? false` and add missing `useSubagentsEnabled` parameters to match the UI defaults.

## Proposed Changes

### `src/services/KanbanProvider.ts`

**Context**: Line 2439-2451, the `useSubagentsByRole` map uses `?? true` fallback for all roles.

**Implementation**:

Change all `?? true` to `?? false` in the `useSubagentsByRole` map:

```typescript
useSubagentsByRole: {
    planner: plannerConfig?.addons?.useSubagents ?? false,
    lead: leadConfig?.addons?.useSubagents ?? false,
    coder: coderConfig?.addons?.useSubagents ?? false,
    reviewer: reviewerConfig?.addons?.useSubagents ?? false,
    tester: testerConfig?.addons?.useSubagents ?? false,
    intern: internConfig?.addons?.useSubagents ?? false,
    analyst: analystConfig?.addons?.useSubagents ?? false,
    researcher: researcherConfig?.addons?.useSubagents ?? false,
    splitter: splitterConfig?.addons?.useSubagents ?? false,
    ticket_updater: ticketUpdaterConfig?.addons?.useSubagents ?? false,
    code_researcher: codeResearcherConfig?.addons?.useSubagents ?? false,
},
```

---

### `src/services/agentPromptBuilder.ts`

**Context**: Line 286, the extraction uses `?? true` fallback.

**Implementation**:

Change the fallback from `?? true` to `?? false`:

```typescript
const useSubagentsEnabled = options?.useSubagentsEnabled ?? false;
```

---

### `src/test/agent-prompt-builder-subagents.test.js`

**Context**: Line 376-378, the test expects default behavior to include parallel instruction.

**Implementation**:

Update the test to expect sequential instruction as the new default:

```javascript
// Default behavior (no option passed) → should include sequential instruction (default false)
const defaultPrompt = buildKanbanBatchPrompt('coder', plans2, {});
assert.ok(!defaultPrompt.includes('parallel sub-agents'), 'Default (no useSubagentsEnabled) should NOT include parallel instruction');
assert.ok(defaultPrompt.includes('Process each plan sequentially'), 'Default (no useSubagentsEnabled) SHOULD include sequential instruction');
```

---

### `src/services/TaskViewerProvider.ts` - Fallback #1

**Context**: Line 6156, `_dispatchConfiguredKanbanColumnPrompt` uses `?? true` fallback.

**Implementation**:

Change the fallback from `?? true` to `?? false`:

```typescript
const useSubagentsEnabled = roleConfig?.addons?.useSubagents ?? false;
```

---

### `src/services/TaskViewerProvider.ts` - Fallback #2

**Context**: Line 2808, pair programming prompt uses `?? true` fallback.

**Implementation**:

Change the fallback from `?? true` to `?? false`:

```typescript
useSubagentsEnabled: coderConfig?.addons?.useSubagents ?? false
```

---

### `src/services/agentPromptBuilder.ts` - Add Shared Prompt-Building Methods

**Context**: Currently `KanbanProvider.ts` has `_generateBatchPlannerPrompt`, `_generateBatchExecutionPrompt`, `_generateBatchReviewerPrompt`, `_generateBatchTesterPrompt` which are NOT shared with `TaskViewerProvider.ts`. This causes parameter drift and inconsistent prompts.

**Implementation**:

Move these methods from `KanbanProvider.ts` to `agentPromptBuilder.ts` as exported functions. Update them to accept configuration as parameters instead of reading from `this._context`:

```typescript
// Add to agentPromptBuilder.ts
export interface PromptBuilderConfig {
    workspaceRoot: string;
    roleConfig?: any;
    promptsConfig?: any;
    defaultPromptOverrides?: Partial<Record<string, DefaultPromptOverride>>;
    routingMapConfig?: { lead: number[]; coder: number[]; intern: number[] } | null;
    // Add other config fields as needed
}

export function buildBatchPlannerPrompt(
    plans: BatchPromptPlan[],
    config: PromptBuilderConfig,
    options?: PromptBuilderOptions
): string {
    // Move logic from KanbanProvider._generateBatchPlannerPrompt here
    // Use config.roleConfig?.addons instead of this._getSetting
    // Use config.promptsConfig instead of this._getPromptsConfig
}

export function buildBatchExecutionPrompt(
    role: 'lead' | 'coder' | 'intern',
    plans: BatchPromptPlan[],
    config: PromptBuilderConfig,
    options?: PromptBuilderOptions
): string {
    // Move logic from KanbanProvider._generateBatchExecutionPrompt here
}

export function buildBatchReviewerPrompt(
    plans: BatchPromptPlan[],
    config: PromptBuilderConfig,
    options?: PromptBuilderOptions
): string {
    // Move logic from KanbanProvider._generateBatchReviewerPrompt here
}

export function buildBatchTesterPrompt(
    plans: BatchPromptPlan[],
    config: PromptBuilderConfig,
    options?: PromptBuilderOptions
): string {
    // Move logic from KanbanProvider._generateBatchTesterPrompt here
}
```

---

### `src/services/KanbanProvider.ts` - Use Shared Methods

**Context**: Update KanbanProvider to call the shared methods from `agentPromptBuilder.ts`.

**Implementation**:

```typescript
import { buildBatchPlannerPrompt, buildBatchExecutionPrompt, buildBatchReviewerPrompt, buildBatchTesterPrompt } from './agentPromptBuilder';

private async _generateBatchPlannerPrompt(cards: KanbanCard[], workspaceRoot: string, sourceColumnLabel?: string): Promise<string> {
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
    
    return buildBatchPlannerPrompt(
        await this._cardsToPromptPlans(cards, workspaceRoot, repoScopeMap),
        {
            workspaceRoot,
            promptsConfig,
            defaultPromptOverrides,
            routingMapConfig: this._routingMapConfig
        },
        {
            clearAntigravityContext: promptsConfig.clearAntigravityContextByRole?.planner ?? false,
            cavemanOutputEnabled: promptsConfig.cavemanOutputByRole?.planner ?? false,
            aggressivePairProgramming: promptsConfig.aggressivePairProgramming,
            dependencyCheckEnabled: promptsConfig.dependencyCheckEnabled,
            plannerWorkflowPath: promptsConfig.plannerWorkflowPath,
            designDocLink: promptsConfig.designDocEnabled ? (promptsConfig.designDocLink || '').trim() : undefined,
            designDocContent: /* ... existing logic ... */,
            splitPlan: promptsConfig.splitPlan,
            skipCompilation: promptsConfig.skipCompilationByRole?.planner ?? false,
            skipTests: promptsConfig.skipTestsByRole?.planner ?? false,
            gitProhibitionEnabled: promptsConfig.gitProhibitionEnabled,
            switchboardSafeguardsEnabled: promptsConfig.switchboardSafeguardsByRole?.planner ?? true,
            useSubagentsEnabled: promptsConfig.useSubagentsByRole?.planner ?? false, // Changed to ?? false
            sourceColumnLabel
        }
    );
}

// Similar updates for _generateBatchExecutionPrompt, _generateBatchReviewerPrompt, _generateBatchTesterPrompt
```

---

### `src/services/TaskViewerProvider.ts` - Use Shared Methods

**Context**: Update `_handleTriggerAgentActionInternal` to call the shared methods instead of duplicating logic.

**Implementation**:

```typescript
import { buildBatchPlannerPrompt, buildBatchExecutionPrompt, buildBatchReviewerPrompt, buildBatchTesterPrompt } from './agentPromptBuilder';

// In _handleTriggerAgentActionInternal, replace the existing buildKanbanBatchPrompt calls:

if (role === 'planner') {
    const plannerInstruction = (baseInstruction === 'improve-plan' || baseInstruction === 'enhance') ? baseInstruction : undefined;
    const promptsConfig = await this._getPromptsConfig(resolvedWorkspaceRoot);
    const defaultPromptOverrides = await this._getDefaultPromptOverrides(resolvedWorkspaceRoot);
    
    messagePayload = buildBatchPlannerPrompt([dispatchPlan], {
        workspaceRoot: effectiveWorkspaceRoot,
        promptsConfig,
        defaultPromptOverrides,
        routingMapConfig: this.getSetting<{ lead: number[]; coder: number[]; intern: number[] } | null>('kanban.routingMapConfig', null)
    }, {
        instruction: plannerInstruction,
        aggressivePairProgramming: this._isAggressivePairProgrammingEnabled(),
        splitPlan: this._isSplitPlanEnabled(),
        designDocLink: this._isDesignDocEnabled() ? this._getDesignDocLink() : undefined,
        designDocContent: this._isDesignDocEnabled() ? await this._getDesignDocContent(resolvedWorkspaceRoot) || undefined : undefined,
        gitProhibitionEnabled,
        switchboardSafeguardsEnabled,
        useSubagentsEnabled: roleConfig?.addons?.useSubagents ?? false, // Now uses the shared method
        // All other parameters handled by the shared method
    });
    
    // Append dispatch-specific strict/light mode delivery extensions (keep existing)
} else if (role === 'reviewer') {
    // Similar pattern using buildBatchReviewerPrompt
} else if (role === 'tester') {
    // Similar pattern using buildBatchTesterPrompt
} else if (role === 'lead' || role === 'coder' || role === 'intern') {
    // Similar pattern using buildBatchExecutionPrompt
}
```

## Verification Plan

### Automated Tests

```bash
# Run the updated test
node src/test/agent-prompt-builder-subagents.test.js

# TypeScript compilation check
npx tsc --noEmit
```

### Manual Verification

1. Open Kanban Prompts tab
2. Verify "Use Subagents for Multiple Plans" checkbox is unchecked for all roles (default state)
3. Select multiple cards in Coder column
4. Verify prompt preview contains `"Process each plan sequentially"` instead of `"parallel sub-agents"`
5. Check the checkbox for Coder role → save
6. Verify prompt preview now contains `"parallel sub-agents"`
7. Uncheck the checkbox → verify preview reverts to sequential instruction

## Files Changed

- `src/services/agentPromptBuilder.ts` — Change `useSubagentsEnabled` extraction fallback from `?? true` to `?? false`; Add shared prompt-building methods (`buildBatchPlannerPrompt`, `buildBatchExecutionPrompt`, `buildBatchReviewerPrompt`, `buildBatchTesterPrompt`)
- `src/services/KanbanProvider.ts` — Change `useSubagentsByRole` fallback from `?? true` to `?? false`; Update to use shared prompt-building methods from `agentPromptBuilder.ts`
- `src/services/TaskViewerProvider.ts` — Change fallback from `?? true` to `?? false` in line 6156; Change fallback from `?? true` to `?? false` in line 2808; Update `_handleTriggerAgentActionInternal` to use shared prompt-building methods from `agentPromptBuilder.ts`
- `src/test/agent-prompt-builder-subagents.test.js` — Update default behavior test expectation

## Risks

- **Low risk**: This aligns backend behavior with the documented UI defaults
- **Backward compatible**: Users with existing saved configs will continue to get their saved value
- **New users**: Will now get sequential instruction by default (matching the unchecked checkbox state), which is the intended behavior
