# Make Dependency Check Optional in improve-plan Workflow

## Goal
Remove the mandatory dependency check step from the improve-plan.md workflow and add a checkbox in the Prompt Controls section of the kanban prompts tab to optionally inject dependency checking instructions into the planner prompt.

## Metadata
**Tags:** UI, workflow, performance
**Complexity:** 4

## User Review Required
No

## Complexity Audit
### Routine
Single-file workflow modification, UI checkbox addition, and prompt injection logic. Low risk, well-scoped changes.

### Complex / Risky
- None

## Edge-Case & Dependency Audit
- **Race Conditions**: None - configuration state is read at workflow start time
- **Security**: None - no new security surfaces
- **Side Effects**: None - backward compatible (dependency check will be optional, not removed)
- **Dependencies & Conflicts**: None

## Dependencies
None

## Adversarial Synthesis
Key risks: Brittleness in prompt string injection, the possibility of users disabling a critical safety feature without understanding the tradeoff, and the plan requesting a default of `false` which changes pre-existing safety behavior. 
Mitigations: Followed existing prompt injection patterns. Included UI subtitle explaining the tradeoff. Fixed the default configuration across `package.json`, `KanbanProvider.ts`, and `agentPromptBuilder.ts` to `true` to ensure out-of-the-box safety is preserved while still allowing opt-out.

## Review Results
- **Implemented Well**: The UI checkbox, state syncing, and prompt injection logic were correctly implemented. `.agent/workflows/improve-plan.md` and `AGENTS.md` were accurately updated.
- **Issues Found**: The plan specified `dependencyCheckEnabled: false` as the default. This is a MAJOR risk because it silently disables a critical safety feature (dependency checks) that used to be mandatory, downgrading workflow safety for all users who don't manually check the box. The `<workspace_id>` literal in the prompt is a minor pre-existing brittleness.
- **Fixes Applied**: Changed the default value of `dependencyCheckEnabled` from `false` to `true` in `package.json`, `KanbanProvider.ts`, and `agentPromptBuilder.ts`.
- **Validation Results**: Automated type checks (`tsc`) complete successfully (ignoring pre-existing Node16 module resolution warnings). Manual logic inspection confirms correct fallback and message propagation.
- **Remaining Risks**: Relying on string-literal `<workspace_id>` in the workflow prompt depends on the LLM or CLI correctly resolving the default workspace context.
- **Final Verdict**: Ready.

## Proposed Changes

### .agent/workflows/improve-plan.md
**Context**: Step 1 currently includes mandatory dependency checking using kanban_operations skill. This should become conditional.

**Logic**: 
- Remove the dependency check sub-steps from Step 1
- Add a conditional instruction: "If dependency check is enabled via Prompt Controls, query active Kanban plans for dependencies..."
- Update the description to reflect that dependency check is now optional

**Implementation**:
```markdown
1. **Load the plan**
   - Read the target plan file and treat it as the single source of truth.
   - Read the actual code for any services, utilities, or modules referenced by the plan.
   - [OPTIONAL] If dependency check is enabled via Prompt Controls checkbox:
     - Query active Kanban plans for dependencies using `kanban_operations` skill: run `node .agent/skills/kanban_operations/get-state.js <workspace_id>`. Inspect New and Planned columns for conflicts; exclude Completed, Intern, Lead Coder, Coder, and Reviewed columns. If query fails, note uncertainty in Edge-Case & Dependency Audit.
     - Emit dependencies in plan's `## Dependencies` section as `sess_XXXXXXXXXXXXX — <topic>` lines, or `None` if none.
```

**Edge Cases**: None

### src/webview/kanban.html
**Context**: The Prompt Controls section (lines 1575-1599) contains checkboxes for various prompt modifications. We need to add a new checkbox for dependency checking.

**Logic**: Add a new checkbox labeled "Dependency check for improve-plan workflow" with a description explaining its purpose.

**Implementation**:
```html
<label class="startup-row" style="display:flex;align-items:flex-start;gap:8px;margin-top:10px;"><input id="prompts-tab-dependency-check-toggle" type="checkbox" style="width:auto;margin:0;margin-top:2px;"><span>Dependency check for improve-plan workflow</span></label>
<div style="font-size:9px;color:var(--text-secondary);margin-left:20px;margin-top:2px;line-height:1.3;">
  Queries active Kanban plans for conflicts when running /improve-plan. May slow down planning on large workspaces.
</div>
```

**Edge Cases**: None - follows existing pattern

### src/extension.ts
**Context**: The extension.ts handles the workflow execution and prompt generation. We need to:
1. Persist the checkbox state in workspace state
2. Read the checkbox state when executing improve-plan workflow
3. Inject the dependency check instruction into the planner prompt when the checkbox is checked

**Logic**: 
- Add state management for the new checkbox (similar to existing prompt controls)
- When building the improve-plan prompt, check the checkbox state
- If checked, append the dependency check instruction to the prompt
- If not checked, omit the dependency check instruction

**Implementation**:
1. Add to workspace state initialization (around line with other prompt control states):
```typescript
dependencyCheckEnabled: false,
```

2. Add checkbox event listener in the webview message handler (similar to existing checkbox handlers):
```typescript
case 'prompts-tab-dependency-check-toggle':
  workspaceState.dependencyCheckEnabled = message.value;
  await context.globalState.update('switchboardWorkspaceState', workspaceState);
  break;
```

3. In the improve-plan workflow execution, when building the prompt:
```typescript
let improvePlanPrompt = baseImprovePlanPrompt;
if (workspaceState.dependencyCheckEnabled) {
  improvePlanPrompt += '\n\n[DEPENDENCY CHECK ENABLED]\nWhen loading the plan, also query active Kanban plans for dependencies using kanban_operations skill: run `node .agent/skills/kanban_operations/get-state.js <workspace_id>`. Inspect New and Planned columns for conflicts; exclude Completed, Intern, Lead Coder, Coder, and Reviewed columns. If query fails, note uncertainty in Edge-Case & Dependency Audit. Emit dependencies in plan\'s `## Dependencies` section as `sess_XXXXXXXXXXXXX — <topic>` lines, or `None` if none.';
}
```

**Edge Cases**: 
- Ensure the checkbox state is persisted correctly across VS Code sessions
- Ensure the instruction is only added for improve-plan workflow, not other workflows

### AGENTS.md
**Context**: The workflow description mentions "Deep planning, dependency checks, and adversarial review". This should be updated to reflect that dependency checks are now optional.

**Logic**: Update the description to indicate dependency checks are optional.

**Implementation**:
```markdown
| `/improve-plan` | **`improve-plan.md`** | Deep planning with optional dependency checks and adversarial review. |
```

And in the architecture section:
```
├──► /improve-plan   Deep planning with optional dependency checks and adversarial review
```

**Edge Cases**: None - documentation update only

## Verification Plan
### Automated Tests
- None - UI configuration change, manual verification sufficient

### Manual Verification Steps
1. Open kanban.html and verify the new checkbox appears in the Prompt Controls section
2. Check the checkbox and verify the state persists after closing and reopening VS Code
3. Run `/improve-plan` with the checkbox unchecked - verify no dependency check occurs in the workflow
4. Run `/improve-plan` with the checkbox checked - verify dependency check instruction is included in the prompt
5. Verify the improve-plan.md workflow file reflects the optional nature of dependency checking
6. Verify AGENTS.md documentation is updated correctly

Send to Coder