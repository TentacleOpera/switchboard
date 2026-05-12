# Remove Fallback Template and Give Intern/Analyst Dedicated Templates

## Goal
Eliminate the generic fallback template entirely and give intern and analyst roles their own dedicated prompt templates. No role should use a fallback template — every role must have its own explicit template.

## Metadata
**Tags:** [backend, workflow]
**Complexity:** 3

## Current State
- **Planner**: Dedicated template (line 245-305) with workflow path, dependency check, design doc, split plan, aggressive pair programming
- **Reviewer**: Dedicated template (line 308-344) with Grumpy/Balanced review stages, advanced regression analysis
- **Tester**: Dedicated template (line 346-383) with acceptance testing against PRD/design doc
- **Lead**: Dedicated template (line 385-404) with inline challenge block, pair programming "Complex only" note, dependency ordering
- **Coder**: Dedicated template (line 406-425) with accuracy mode instruction, pair programming "Routine only" note
- **Intern**: Fallback template (line 427-434) — generic "Please process the following N plans" + batch rules
- **Analyst**: Fallback template (line 427-434) — same generic template as intern
- **Custom agents**: Fallback template (line 427-434) — same generic template

The fallback template is a shared bucket — intern, analyst, and custom agents all share this generic template. This is problematic because:
1. Any change to the fallback affects all three roles identically
2. There's no way to customize one role without affecting others at the template level
3. The fallback provides no role-specific orchestration — it's bare-minimum "process these plans" + batch rules

## Desired State
- **Intern**: Dedicated `if (role === 'intern')` branch with its own template
- **Analyst**: Dedicated `if (role === 'analyst')` branch with its own template
- **Custom agents**: No template — if no custom prompt is defined, prompt is just the plan file link
- **Fallback template**: Removed entirely — the final return should throw an error for unknown roles
- Every built-in role has explicit template control; custom agents use plan file as fallback

## Complexity Audit

### Routine
- Add `if (role === 'intern')` branch after coder branch (after line 425)
- Add `if (role === 'analyst')` branch after intern branch
- Initially copy the current fallback template content to both new branches
- Replace final fallback return with error throw for unknown roles
- Custom agents are handled elsewhere (plan file link as fallback) — no change needed in this file

### Complex / Risky
- None — this is a straightforward code organization change with no behavioral impact in the initial implementation

## Edge-Case & Dependency Audit

- **Behavioral Impact**: None — initial templates are identical to current fallback, so existing behavior is preserved
- **Custom Agents**: Handled elsewhere (plan file link as fallback) — no change needed in this file
- **Unknown Roles**: Will throw error instead of silently using fallback — this is intentional to catch configuration bugs
- **defaultPromptOverrides**: Still works as before for per-role customizations
- **Column Mapping**: No changes needed to `columnToPromptRole()` — intern and analyst are already mapped correctly

## Dependencies
None - this is a self-contained prompt template refactoring

## Adversarial Synthesis
Key risk: Accidentally diverging intern/analyst templates from current fallback behavior in the initial implementation. Mitigation: Copy the exact fallback template content verbatim to both new branches. Use the same template literal structure and variable references. Test that intern and analyst prompts are identical before and after the change. The error throw for unknown roles is intentional — it catches configuration bugs early rather than silently using wrong prompts. Custom agents are handled elsewhere (plan file link as fallback) and are not affected by this change.

## Files to Modify

### 1. src/services/agentPromptBuilder.ts
**Context**: `buildKanbanBatchPrompt()` has dedicated if branches for planner, reviewer, tester, lead, and coder roles. Intern and analyst fall through to the generic fallback at line 427-434. Custom agents are handled elsewhere (plan file link as fallback).

**Logic**: Add dedicated if branches for intern and analyst before the final return. Initially copy the fallback template content to both branches for backward compatibility. Replace the final fallback return with an error throw for unknown roles. Custom agents are not affected by this change.

**Implementation**:

After line 425 (end of coder branch), add:

```typescript
if (role === 'intern') {
    let internPrompt = `Please process the following ${plans.length} plans.

${batchExecutionRules}

${dispatchContextPrefix}${focusDirective}${GIT_PROHIBITION_DIRECTIVE}

PLANS TO PROCESS:
${planList}`;
    return applyPromptOverride(internPrompt, dispatchContextBlock, planList, promptOverride);
}

if (role === 'analyst') {
    let analystPrompt = `Please process the following ${plans.length} plans.

${batchExecutionRules}

${dispatchContextPrefix}${focusDirective}${GIT_PROHIBITION_DIRECTIVE}

PLANS TO PROCESS:
${planList}`;
    return applyPromptOverride(analystPrompt, dispatchContextBlock, planList, promptOverride);
}

// No fallback — every built-in role must have an explicit template
throw new Error(`Unknown role '${role}' in buildKanbanBatchPrompt. Role must be one of: planner, reviewer, tester, lead, coder, intern, analyst. Custom agents use plan file link as fallback and are not routed through this function.`);
```

## Implementation Steps

1. **Add intern branch**
   - Insert `if (role === 'intern')` block after line 425
   - Copy the exact fallback template content to the intern branch
   - Use `internPrompt` variable name for clarity
   - Return via `applyPromptOverride(internPrompt, dispatchContextBlock, planList, promptOverride)`

2. **Add analyst branch**
   - Insert `if (role === 'analyst')` block after the intern branch
   - Copy the exact fallback template content to the analyst branch
   - Use `analystPrompt` variable name for clarity
   - Return via `applyPromptOverride(analystPrompt, dispatchContextBlock, planList, promptOverride)`

3. **Remove fallback return**
   - Replace the fallback return at line 427-434 with an error throw
   - Error message should list all valid built-in roles: planner, reviewer, tester, lead, coder, intern, analyst
   - Note that custom agents use plan file link as fallback and are not routed through this function

## Verification Plan

### Automated Tests
- No existing automated test suite for this module. Manual verification required.

### Manual Verification
1. Build the extension
2. Open kanban.html prompts tab
3. Select intern role from dropdown
4. Generate prompt preview — verify it contains the expected template structure
5. Select analyst role from dropdown
6. Generate prompt preview — verify it contains the expected template structure
7. Verify intern and analyst prompts are identical to each other (initial state, matching old fallback)
8. Test intern dispatch from PLAN REVIEWED → INTERN CODED — verify it uses the intern template
9. Test analyst dispatch — verify it uses the analyst template
10. Verify backward compatibility: existing intern and analyst prompts are identical before and after the change
