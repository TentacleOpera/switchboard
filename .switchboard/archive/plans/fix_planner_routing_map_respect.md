# Fix Planner Advice to Respect Routing Map Configuration

## Problem Statement

The planner advice generated from the improve-plan.md workflow does not respect the routing map configuration as defined in the setup tab of kanban.html. At the bottom of the planner output, it says "Still complexity 3 — Send to Coder" using hardcoded thresholds instead of the user's custom routing map configuration.

## Root Cause Analysis

### 1. Routing Map Configuration

In `kanban.html` (line 2794), there is a routing map configuration that maps complexity scores to agent tiers:

```javascript
let routingMapConfig = { lead: [7, 8, 9, 10], coder: [4, 5, 6], intern: [1, 2, 3] };
```

This configuration is editable via the "OPEN ROUTING MAP" button in the setup tab (lines 2262-2296), allowing users to customize which complexity scores map to which agent tiers (lead, coder, intern).

### 2. The Bug in improve-plan.md Workflow

In `.agent/workflows/improve-plan.md` (line 70), the workflow uses hardcoded thresholds to determine the recommendation:

```markdown
- End with a recommendation: if complexity ≤ 6, say "Send to Coder". If complexity ≥ 7, say "Send to Lead Coder".
```

This hardcoded logic does not:
- Check the routing map configuration
- Consider the intern role at all
- Respect custom user configurations

### 3. Why This Is a Bug

The routing map configuration is the single source of truth for complexity-to-role mapping throughout the system (used by KanbanProvider's `resolveRoutedRole`, kanban.html's `resolveCodedAutoTarget`, etc.). However, the improve-plan workflow ignores this configuration and uses simple hardcoded thresholds.

This means:
- If a user configures complexity scores 1-5 to route to intern via the routing map
- The planner will still recommend "Send to Coder" for complexity 3
- The intern role is completely ignored in the planner advice
- The planner recommendation is inconsistent with the actual routing behavior

## Solution

### Approach: Update Hardcoded Thresholds to Match Default Routing Map

Update the hardcoded thresholds in improve-plan.md to match the DEFAULT routing map configuration exactly. This is a simple, low-risk change that requires no infrastructure modifications.

### Implementation

The default routing map in kanban.html is:
- intern: [1, 2, 3]
- coder: [4, 5, 6]
- lead: [7, 8, 9, 10]

Current hardcoded logic (incorrect):
- complexity ≤ 6 → Send to Coder (treats 1-3 as coder instead of intern)
- complexity ≥ 7 → Send to Lead Coder

Updated hardcoded logic (correct):
- complexity 1-3 → Send to Intern
- complexity 4-6 → Send to Coder
- complexity 7-10 → Send to Lead Coder

### Files to Modify

1. **.agent/workflows/improve-plan.md**
   - Update line 70 to use three-tier thresholds matching default routing map

### Updated Workflow Logic

Replace the current recommendation with:

```markdown
4. **Update the original plan file**
   - Write the improvement findings back into the same feature plan file.
   - Preserve all existing implementation steps, code blocks, and goal statements.
   - Mark completed checklist items when appropriate.
   - End with a recommendation based on complexity:
     - If complexity is 1-3 → "Send to Intern"
     - If complexity is 4-6 → "Send to Coder"
     - If complexity is 7-10 → "Send to Lead Coder"
```

### Limitation

Custom routing map configurations will not be reflected in planner advice - the advice will always use the default thresholds. This is documented as a known limitation since making the workflow access VS Code settings would require significant infrastructure changes.

### Testing Strategy

1. **Unit Tests**: Test the recommendation logic with various routing map configurations
2. **Integration Tests**: Test full improve-plan workflow execution with custom routing maps
3. **Manual Testing**:
   - Configure routing map with non-default assignments (e.g., intern: [1,2,3,4,5])
   - Run improve-plan workflow on a plan with complexity 3
   - Verify recommendation says "Send to Intern" not "Send to Coder"
   - Test all three roles with different complexity scores

## Verification Steps

1. After implementing the fix, verify that:
   - Planner advice respects custom routing map configurations
   - Intern role appears in recommendations when configured in routing map
   - Default behavior still works when no custom routing map is configured
   - All three roles (lead, coder, intern) can be recommended appropriately

2. Test edge cases:
   - No custom routing map configured → use default thresholds
   - Custom routing map with intern role → recommend intern for appropriate scores
   - Custom routing map with all scores assigned to one role → recommend that role
   - Invalid routing map configuration → fall back to defaults

## Risk Assessment

**Medium Risk**: This requires modifying the workflow execution logic to pass additional context (routing map configuration) to the AI agent. Need to ensure:
- The routing map configuration is correctly passed to the workflow
- The workflow can reliably access and use this configuration
- Fallback to defaults works when configuration is missing or invalid

## Rollback Plan

If issues arise, revert the workflow changes to the original hardcoded thresholds. The routing map configuration will still work for actual routing (kanban board), but planner advice will use defaults.

## Complexity Audit
**Manual Complexity Override:** 1

### Complex / Risky
- None.

---
## Review & Execution Notes

### Stage 1: Grumpy Principal Engineer Review
- **CRITICAL**: The plan states "Custom routing map configurations will not be reflected in planner advice - the advice will always use the default thresholds." The problem statement explicitly says: "The planner advice generated from the improve-plan.md workflow does not respect the routing map configuration as defined in the setup tab of kanban.html." BUT the solution proposed *only* changes the hardcoded default mapping in `improve-plan.md` to be three tiers instead of two. It completely abandons actually making the planner respect custom user routing configurations, calling it a limitation. The title of the plan is literally "Fix Planner Advice to Respect Routing Map Configuration", but the implementation explicitly *doesn't* do that.
- **MAJOR**: The solution relies on the LLM blindly following markdown instructions for thresholds. It is acceptable as a stopgap but completely fails to address the root bug as described ("This hardcoded logic does not: Check the routing map configuration, Consider the intern role at all, Respect custom user configurations"). It only fixes "Consider the intern role at all".

### Stage 2: Balanced Synthesis
- **What to keep**: The change to `.agent/workflows/improve-plan.md` correctly adds the intern tier to the default logic. Keep this change as the baseline default behavior.
- **What to fix now**: We need to actually inject the user's custom routing map configuration from VS Code into the planner prompt context so the LLM knows the current mapping. We can achieve this without changing the `improve-plan.md` workflow further by updating `agentPromptBuilder.ts` to prepend the configured `kanban.routingMapConfig` if one is present.

### Execution Results
1. **Fix Applied**: Updated `src/services/agentPromptBuilder.ts` to add a `routingMapConfig` property to `PromptBuilderOptions`. When this property is provided, the planner base prompt now explicitly details the user's exact complexity thresholds for Intern, Coder, and Lead Coder.
2. **Plumbing Updated**: Updated `src/services/KanbanProvider.ts` (line 2235) and `src/services/TaskViewerProvider.ts` (lines 6136, 14692) to retrieve the `'kanban.routingMapConfig'` VS Code setting and pass it down into the prompt builder when dispatching the planner.
3. **Compilation Errors Fixed**: Fixed pre-existing minor TS type and module resolution errors across `ClickUpSyncService.ts`, `KanbanProvider.ts`, and `TaskViewerProvider.ts` to ensure a clean `npm run compile` and `npm run test`.
4. **Validation**: Verified successful type-checking (`npx tsc --noEmit` and `webpack` compilation). Tests passed successfully via `.vscode-test.mjs`.

The implementation now *actually* respects the routing map configuration.
