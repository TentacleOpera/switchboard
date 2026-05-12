# Ticket Updater Role

## Goal
Create a custom agent column called "Ticket Updater" that analyzes a plan and writes its analysis back to the associated ClickUp or Linear ticket under an "AI Analysis" section. The ticket number is automatically provided when the plan is imported via implementation.html import ticket function.

## Metadata
**Tags:** frontend, agent, integration
**Complexity:** 3

## User Review Required
None.

## Current State
- ClickUp and Linear API skills exist (clickup_api, linear_api) via LocalApiServer proxy
- Custom agents can be added to the kanban via the AGENTS tab
- Custom agent prompt addons allow adding directives to custom agents
- Plans can have ticket numbers in metadata from implementation.html import ticket function
- LocalApiServer provides POST endpoints for updating ClickUp/Linear tickets

## Complexity Audit

### Routine
- Add custom agent configuration for "Ticket Updater" with prompt instructions
- Add prompt addon to invoke clickup_api or linear_api skill
- Configure agent to extract ticket number from plan metadata
- Configure agent to write analysis to ticket comment or description

### Complex / Risky
- None - leverages existing API skills

## Edge-Case & Dependency Audit
- **Race Conditions:** None - sequential API operations
- **Security:** API calls use existing authentication via LocalApiServer
- **Side Effects:** Modifies ticket description or adds comment
- **Dependencies & Conflicts:** No active plans conflict. Relies on existing clickup_api/linear_api skills.

## Dependencies
- phase1_api_proxy_endpoints.md (COMPLETED) — provides API proxy endpoints
- feature_plan_20260501_add_custom_agents_to_kanban_agents_tab.md (COMPLETED) — provides custom agent infrastructure
- feature_plan_20260508_add_custom_agent_prompt_addons.md (COMPLETED) — allows custom agent configuration

## Proposed Solution

### 1. Ticket Updater Agent Configuration

Create a custom agent that leverages existing API skills:

```typescript
{
  id: 'ticket_updater',
  role: 'custom_agent_ticket_updater',
  name: 'Ticket Updater',
  startupCommand: 'claude',
  promptInstructions: 'You are a Ticket Updater. Analyze the provided plan and write your analysis back to the associated ticket under an "AI Analysis" section.',
  includeInKanban: true,
  kanbanOrder: 101,
  dragDropMode: 'prompt',
  addons: {
    gitProhibitionEnabled: true,
    // Enable ticket update capability (default off, user must enable)
    ticketUpdateEnabled: false
  }
}
```

### 2. Agent Prompt Template

The ticket updater agent prompt should:

1. Analyze the plan content (goal, proposed changes, complexity, dependencies)
2. Generate a concise analysis summary
3. Use the appropriate API skill (clickup_api or linear_api) to update the ticket (ticket number is already provided in context)

Prompt structure:
```
You are a Ticket Updater Agent.

STEP 1: Analyze the Plan
Generate a concise analysis covering:
- **Goal Summary**: Brief overview of what the plan aims to achieve
- **Complexity Assessment**: Overall complexity (Low/Medium/High) and key risk areas
- **Key Dependencies**: Major dependencies or blockers
- **Implementation Notes**: Any notable implementation considerations
- **Estimated Effort**: Rough effort estimate (if discernible from complexity)

Keep the analysis under 500 words for readability in the ticket.

STEP 2: Update the Ticket
The ticket number and platform (ClickUp or Linear) are already provided in the plan context. Use the appropriate API skill to add the analysis to the ticket:
- For ClickUp: Use clickup_api skill to add a comment with "AI Analysis" header
- For Linear: Use linear_api skill to add a comment with "AI Analysis" header

Format the analysis as:
```
## AI Analysis

[Your analysis content here]
```

Do not modify the original ticket description. Only add a comment.
```

### 3. Implementation Components

#### 3.1 Custom Agent Prompt Addon Extension

Extend the custom agent prompt addons to support ticket update capability:

Add to `CustomAgentAddons` interface in agentConfig.ts:
```typescript
export interface CustomAgentAddons {
    // ... existing addons
    ticketUpdateEnabled?: boolean; // Enable ticket update capability
}
```

#### 3.2 Update buildCustomAgentPrompt

Modify `buildCustomAgentPrompt()` in TaskViewerProvider.ts to handle the new addon:

```typescript
private buildCustomAgentPrompt(
    plans: BatchPromptPlan[],
    promptInstructions?: string,
    addons?: CustomAgentAddons
): string {
    const planLinks = plans.map(p => `- [${p.topic}] Plan File: ${p.absolutePath}`).join('\n');
    let prompt = `PLANS TO PROCESS:\n${planLinks}`;
    
    if (addons) {
        // Enable ticket update if requested
        if (addons.ticketUpdateEnabled) {
            prompt += `\n\n${TICKET_UPDATE_DIRECTIVE}`;
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
const TICKET_UPDATE_DIRECTIVE = `TICKET UPDATE MODE: You are authorized to update the associated ticket. Extract the ticket number from the plan metadata, analyze the plan, and use the clickup_api or linear_api skill to add an "AI Analysis" comment to the ticket. Do not modify the ticket description, only add a comment.`;
```

#### 3.3 UI Configuration

Add ticket updater configuration in custom agent modal (kanban.html):

```html
<div class="addon-group">
  <h4>Ticket Updater Configuration</h4>
  <label class="checkbox-label">
    <input type="checkbox" id="custom-agent-ticket-update">
    <span>Enable Ticket Update (add AI Analysis comment to ticket)</span>
  </label>
  <p class="hint">Ticket number is automatically provided when plan is imported via implementation.html. Uses clickup_api or linear_api skill.</p>
</div>
```

## Implementation Steps

### Phase 1: Extend Custom Agent Addons
1. Add `ticketUpdateEnabled` to `CustomAgentAddons` interface
2. Update `parseCustomAgentAddons()` to handle new field
3. Add directive constant for ticket update

### Phase 2: Update Prompt Builder
1. Modify `buildCustomAgentPrompt()` to apply ticket update directive
2. Ensure directive assumes ticket number is already provided in context

### Phase 3: UI Configuration
1. Add ticket updater configuration checkbox to custom agent modal in kanban.html
2. Add event listener to handle checkbox state
3. Sync checkbox state with custom agent config

### Phase 4: Create Ticket Updater Agent
1. Add default ticket updater agent configuration with `ticketUpdateEnabled: false` (default off)
2. Set prompt instructions to explain the three-step process
3. Configure as kanban column with appropriate ordering

### Phase 5: Testing
1. Test with plan containing ClickUp ticket in metadata
2. Verify analysis comment is added to ClickUp ticket
3. Test with plan containing Linear ticket in metadata
4. Verify analysis comment is added to Linear ticket
5. Test with plan without ticket number (should skip update gracefully)

## Verification Plan

### Manual Verification
1. Create a plan with ClickUp ticket number in metadata (e.g., `**Ticket:** CU-12345`)
2. Dispatch to ticket updater agent
3. Verify "AI Analysis" comment is added to ClickUp ticket
4. Verify comment contains goal summary, complexity assessment, and key dependencies
5. Repeat with Linear ticket
6. Test with plan without ticket number - should complete without error but skip ticket update

### Success Criteria
- Ticket updater agent appears in kanban
- Plans can be dropped on ticket updater agent
- Ticket number is extracted from plan metadata
- Analysis comment is added to ClickUp/Linear ticket
- Comment is formatted with "AI Analysis" header
- Agent handles missing ticket numbers gracefully

## Risks and Considerations

- **Ticket Number Format:** Different ticket formats (CU-12345 vs LIN-123) may require different parsing. Mitigation: Support multiple common formats.
- **API Rate Limits:** Frequent ticket updates may hit API rate limits. Mitigation: Add rate limiting or batch updates.
- **Analysis Quality:** LLM may produce verbose or low-quality analysis. Mitigation: Provide clear formatting instructions and word limit.
- **Permission Errors:** Agent may not have permission to modify tickets. Mitigation: Handle API errors gracefully and notify user.

## Files to Modify

1. `src/services/agentConfig.ts` — Extend CustomAgentAddons interface
2. `src/services/TaskViewerProvider.ts` — Update buildCustomAgentPrompt
3. `src/webview/kanban.html` — Add ticket updater configuration UI

## Recommendation

**Send to Coder**
