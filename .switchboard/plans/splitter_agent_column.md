# Splitter Agent Column

## Goal
Create a custom agent column called "Splitter Agent" that takes a plan from the "planned" column and splits it into Routine and Complex component plans using the existing complexity split rules. If the plan lacks a Complexity Audit section, the agent first applies the complexity scoring skill, then performs the split. The split output is handled by a different agent (Coder for Routine, Lead Coder for Complex).

## Metadata
**Tags:** frontend, agent, workflow
**Complexity:** 3

## User Review Required
None.

## Current State
- The split plan addon (`splitPlan`) instructs the planner to produce two files: original (Complex only) and `_routine.md` (Routine only)
- Pair programming mode dispatches Routine tasks to Coder agent concurrently
- The complexity scoring skill exists and can be invoked via skill: "complexity_scoring"
- Custom agents can be added to the kanban via the AGENTS tab
- Custom agent prompt addons allow adding directives to custom agents

## Complexity Audit

### Routine
- Add custom agent configuration for "Splitter Agent" with prompt instructions
- Add prompt addon to invoke complexity scoring skill if plan lacks Complexity Audit
- Add prompt addon to use existing split plan directive
- Configure agent to dispatch Routine plan to Coder, Complex plan to Lead Coder

### Complex / Risky
- None - leverages existing infrastructure

## Edge-Case & Dependency Audit
- **Race Conditions:** None - sequential operations
- **Security:** None - no file writes, only prompt generation
- **Side Effects:** Creates two plan files (same as split plan addon)
- **Dependencies & Conflicts:** No active plans conflict. Relies on existing split plan logic.

## Dependencies
- add_split_plan_checkbox_to_kanban_prompts.md (COMPLETED) — provides split plan directive
- feature_plan_20260501_add_custom_agents_to_kanban_agents_tab.md (COMPLETED) — provides custom agent infrastructure
- feature_plan_20260508_add_custom_agent_prompt_addons.md (COMPLETED) — allows custom agent configuration

## Proposed Solution

### 1. Splitter Agent Configuration

Create a custom agent that leverages existing split plan logic:

```typescript
{
  id: 'splitter_agent',
  role: 'custom_agent_splitter_agent',
  name: 'Splitter Agent',
  startupCommand: 'claude',
  promptInstructions: 'You are a Plan Splitter. Split the provided plan into Routine and Complex components using the existing complexity split rules.',
  includeInKanban: true,
  kanbanOrder: 100,
  dragDropMode: 'prompt',
  addons: {
    gitProhibitionEnabled: true,
    // Enable split plan mode via custom agent prompt addons
    splitPlan: true
  }
}
```

### 2. Agent Prompt Template

The splitter agent prompt should:

1. First check if the plan has a `## Complexity Audit` section with `### Routine` and `### Complex / Risky` subsections
2. If missing, invoke the `complexity_scoring` skill to add the complexity audit
3. Then apply the existing `splitPlan` directive to produce two files

Prompt structure:
```
You are a Plan Splitter Agent.

STEP 1: Check for Complexity Audit
Read the provided plan file. If it lacks a "## Complexity Audit" section with "### Routine" and "### Complex / Risky" subsections, invoke the complexity_scoring skill to add this section.

STEP 2: Apply Split Plan Directive
After ensuring the plan has a Complexity Audit, apply the existing split plan logic:

SPLIT PLAN MODE: Produce TWO files per plan.
1. **Original file** (keep existing filename): Contains ONLY the Complex / Risky implementation steps. Routine steps are REMOVED from Proposed Changes. In the ## Complexity Audit section, write under ### Routine: "See <filename_stem>_routine.md — handled by Coder agent." The ### Complex / Risky section contains the actual complex steps. Include all shared context sections verbatim.

2. **Routine file** (<filename_stem>_routine.md): Contains ONLY the Routine implementation steps. Complex steps are REMOVED from Proposed Changes. In the ## Complexity Audit section, write under ### Complex / Risky: "See <original_filename> — handled by Lead Coder." The ### Routine section contains the actual routine steps. Include all shared context sections verbatim.

STEP 3: Dispatch Instructions
- The original file (Complex) should be dispatched to the Lead Coder agent
- The _routine.md file should be dispatched to the Coder agent

Create both files in the same directory as the original plan.
```

### 3. Implementation Components

#### 3.1 Custom Agent Prompt Addon Extension

Extend the custom agent prompt addons to support the complexity scoring skill invocation:

Add to `CustomAgentAddons` interface in agentConfig.ts:
```typescript
export interface CustomAgentAddons {
    // ... existing addons
    complexityScoringSkill?: boolean; // Invoke complexity_scoring skill before processing
    splitPlan?: boolean; // Apply split plan directive
}
```

#### 3.2 Update buildCustomAgentPrompt

Modify `buildCustomAgentPrompt()` in TaskViewerProvider.ts to handle the new addons:

```typescript
private buildCustomAgentPrompt(
    plans: BatchPromptPlan[],
    promptInstructions?: string,
    addons?: CustomAgentAddons
): string {
    const planLinks = plans.map(p => `- [${p.topic}] Plan File: ${p.absolutePath}`).join('\n');
    let prompt = `PLANS TO PROCESS:\n${planLinks}`;
    
    if (addons) {
        // Invoke complexity scoring skill if requested
        if (addons.complexityScoringSkill) {
            prompt += `\n\n${COMPLEXITY_SCORING_DIRECTIVE}`;
        }
        
        // Apply split plan directive if requested
        if (addons.splitPlan) {
            prompt += `\n\n${SPLIT_PLAN_DIRECTIVE}`;
        }
        
        // ... existing addon handling
    }
    
    if (promptInstructions) {
        prompt += `\n\nAdditional Instructions: ${promptInstructions}`;
    }
    
    return prompt;
}
```

Where:
```typescript
const COMPLEXITY_SCORING_DIRECTIVE = `COMPLEXITY SCORING: Before proceeding, invoke the complexity_scoring skill to add a ## Complexity Audit section to the plan with ### Routine and ### Complex / Risky subsections. Classify each implementation step based on complexity.`;

const SPLIT_PLAN_DIRECTIVE = `SPLIT PLAN MODE: Produce TWO files per plan. Original file = Complex / Risky only. Companion file (<stem>_routine.md) = Routine only. Both files must include full shared context. Original file notes: "Assume Routine items implemented by Coder agent."`;
```

#### 3.3 UI Configuration

Add splitter agent configuration in custom agent modal (kanban.html):

```html
<div class="addon-group">
  <h4>Splitter Configuration</h4>
  <label class="checkbox-label">
    <input type="checkbox" id="custom-agent-complexity-scoring">
    <span>Apply Complexity Scoring (if plan lacks Complexity Audit)</span>
  </label>
  <label class="checkbox-label">
    <input type="checkbox" id="custom-agent-split-plan">
    <span>Split Plan into Routine/Complex components</span>
  </label>
</div>
```

## Implementation Steps

### Phase 1: Extend Custom Agent Addons
1. Add `complexityScoringSkill` and `splitPlan` to `CustomAgentAddons` interface
2. Update `parseCustomAgentAddons()` to handle new fields
3. Add directive constants for complexity scoring and split plan

### Phase 2: Update Prompt Builder
1. Modify `buildCustomAgentPrompt()` to apply complexity scoring directive
2. Modify `buildCustomAgentPrompt()` to apply split plan directive
3. Ensure directives are applied in correct order (complexity scoring first, then split)

### Phase 3: UI Configuration
1. Add splitter configuration checkboxes to custom agent modal in kanban.html
2. Add event listeners to handle checkbox state
3. Sync checkbox state with custom agent config

### Phase 4: Create Splitter Agent
1. Add default splitter agent configuration with `complexityScoringSkill: true` and `splitPlan: true`
2. Set prompt instructions to explain the two-step process
3. Configure as kanban column with appropriate ordering

### Phase 5: Testing
1. Test with plan that has Complexity Audit - should skip scoring, apply split
2. Test with plan without Complexity Audit - should apply scoring, then split
3. Verify two files are created (original and _routine.md)
4. Verify file contents match split plan addon behavior

## Verification Plan

### Manual Verification
1. Create a plan without Complexity Audit section
2. Dispatch to splitter agent
3. Verify Complexity Audit section is added
4. Verify two files are created: original.md and original_routine.md
5. Verify original.md contains only Complex steps
6. Verify original_routine.md contains only Routine steps
7. Test with plan that already has Complexity Audit
8. Verify scoring is skipped, split is applied

### Success Criteria
- Splitter agent appears in kanban
- Plans can be dropped on splitter agent
- Complexity scoring is applied if needed
- Two files are created using existing split plan logic
- File structure matches split plan addon output

## Risks and Considerations

- **Prompt Complexity:** The two-step process (score then split) may confuse some models. Mitigation: Provide clear sequential instructions.
- **Existing Split Plan:** If split plan addon is also enabled on planner, may cause confusion. Mitigation: Document that splitter agent is an alternative to split plan addon, not complementary.

## Files to Modify

1. `src/services/agentConfig.ts` — Extend CustomAgentAddons interface
2. `src/services/TaskViewerProvider.ts` — Update buildCustomAgentPrompt
3. `src/webview/kanban.html` — Add splitter configuration UI

## Recommendation

**Send to Coder**
