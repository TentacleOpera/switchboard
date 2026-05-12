# Feature Plan: Switchboard Safeguards Prompt Add-On

## Goal
Add a "Switchboard Safeguards" checkbox to the Prompts Tab Add-Ons menu for all roles, allowing users to toggle the inclusion of `batchExecutionRules` and `FOCUS_DIRECTIVE` in prompts — ON by default for built-in roles (preserving current behavior), OFF by default for custom agents (preserving current behavior).

## Metadata
- **Tags:** workflow, reliability
- **Complexity:** 5

## User Review Required
- Whether "Switchboard Safeguards" should also auto-enable `gitProhibitionEnabled` when toggled ON for custom agents, or keep git prohibition as an independent checkbox.

## Complexity Audit
### Routine
- Add `switchboardSafeguards` field to `CustomAgentAddons` interface and `parseCustomAgentAddons`
- Add `switchboardSafeguardsEnabled` to `PromptBuilderOptions` interface
- Add checkbox entry to `ROLE_ADDONS` and `DEFAULT_CONFIG` in `kanban.html`
- Add checkbox to custom agent addon form in `kanban.html` and `setup.html`
- Update `renderRoleAddons` — no code change needed, dynamic system handles it
- Update `parseCustomAgentAddons` to read the new field
- Update custom agent form save/load to include the new addon

### Complex / Risky
- Modify `buildKanbanBatchPrompt` to conditionally include `batchExecutionRules` and `FOCUS_DIRECTIVE` based on `switchboardSafeguardsEnabled` flag — must default to `true` to preserve current behavior for all 10 built-in roles
- Modify `buildCustomAgentPrompt` to inject `batchExecutionRules` when `addons?.switchboardSafeguards` is true — must avoid double-injecting `FOCUS_DIRECTIVE` (currently added unconditionally at line 5609)
- Wire `switchboardSafeguardsEnabled` through `_getPromptsConfig()` in `KanbanProvider.ts` so the flag flows from `roleConfigs[role].addons.switchboardSafeguards` → `PromptBuilderOptions`

## Edge-Case & Dependency Audit
- **Race Conditions**: None — checkbox state is read synchronously from `roleConfigs` at prompt generation time
- **Security**: No security implications — this controls prompt text, not access control
- **Side Effects**: Unchecking safeguards for a built-in role removes `batchExecutionRules` and `FOCUS_DIRECTIVE` from that role's prompt. Agents may then blend context across plans or misinterpret plan paths. This is intentional (user opt-out) but should be clearly communicated via tooltip.
- **Dependencies & Conflicts**: Git prohibition is already independently controlled via its own checkbox (`gitProhibition` in `ROLE_ADDONS`, `gitProhibitionEnabled` in `CustomAgentAddons`). The safeguards toggle should NOT override the independent git prohibition checkbox — they are orthogonal. Safeguards = batch rules + focus directive only.

## Dependencies
- None

## Adversarial Synthesis
Key risks: (1) Double `FOCUS_DIRECTIVE` injection in `buildCustomAgentPrompt` if safeguards ON, since line 5609 adds it unconditionally. (2) Default value mismatch — if `switchboardSafeguardsEnabled` defaults to `false` in `PromptBuilderOptions`, all built-in roles lose `batchExecutionRules` and `FOCUS_DIRECTIVE` immediately. Mitigations: Default to `true` in `PromptBuilderOptions`; refactor `buildCustomAgentPrompt` line 5609 to conditionally include `FOCUS_DIRECTIVE` based on safeguards flag.

## Context & Motivation
Currently, built-in roles (like Lead, Intern, Reviewer) automatically receive a set of strict orchestration directives in their prompts, including:
1. `batchExecutionRules`: Directives on how to safely process multiple plans sequentially without blending context.
2. `FOCUS_DIRECTIVE`: Instruction to treat the absolute path as the single source of truth (ignoring brain path mirrors/hashing).

Custom agents explicitly *do not* receive `batchExecutionRules` (to allow for custom workflows). However, if a user wants to safely batch 5 plans to a Custom Agent, they currently have to manually write out defensive orchestration instructions in their custom prompt definition to prevent the agent from mixing up the plans.

`GIT_PROHIBITION_DIRECTIVE` is already independently controllable via the existing `gitProhibition` checkbox for both built-in roles and custom agents, so it is NOT part of this feature's scope.

## Current State (Verified Against Codebase)
- **Built-in roles** (`buildKanbanBatchPrompt` in `agentPromptBuilder.ts:225-553`):
  - ALL built-in roles ALWAYS get `batchExecutionRules` (for planner: only when `plans.length > 1`; for all others: always)
  - ALL built-in roles ALWAYS get `FOCUS_DIRECTIVE`
  - Git prohibition is per-role via `gitProhibitionEnabled` option (defaults vary: `false` for planner, `true` for all others)
  - Per-role git prohibition setting flows from `roleConfigs[role].addons.gitProhibition` → `_getPromptsConfig()` → `gitProhibitionByRole` → `PromptBuilderOptions`
- **Custom agents** (`buildCustomAgentPrompt` in `TaskViewerProvider.ts:5593-5651`):
  - Always gets `FOCUS_DIRECTIVE` (line 5609, unconditional)
  - Gets `GIT_PROHIBITION_DIRECTIVE` only if `addons?.gitProhibitionEnabled` is true
  - Does NOT get `batchExecutionRules` at all
  - Addons are per-custom-agent, stored in `CustomAgentConfig.addons`
- **UI - Prompts Tab** (`kanban.html`):
  - Planner has hardcoded addon checkboxes (lines 2160-2196)
  - Other built-in roles use `ROLE_ADDONS` config (line 2348) + `renderRoleAddons()` (line 2446) for dynamic checkboxes
  - Custom agents have their own addon section in the agent form (line 2066)
  - Role addon state persisted via `saveRoleConfig()` → VS Code settings `roleConfig_<role>`

## Proposed Solution

### 1. Data Model Changes

**`src/services/agentConfig.ts`** — Add to `CustomAgentAddons`:
```typescript
export interface CustomAgentAddons {
    // Core
    gitProhibitionEnabled?: boolean;
    workspaceTypeDetection?: boolean;
    switchboardSafeguards?: boolean;  // NEW: include batch execution rules + focus directive
    // ... rest unchanged
}
```

Update `parseCustomAgentAddons` (line 140-171) to read:
```typescript
if (s.switchboardSafeguards === true) a.switchboardSafeguards = true;
```

**`src/services/agentPromptBuilder.ts`** — Add to `PromptBuilderOptions`:
```typescript
export interface PromptBuilderOptions {
    // ... existing fields ...
    /** When true (default), include batchExecutionRules and FOCUS_DIRECTIVE. When false, omit them. */
    switchboardSafeguardsEnabled?: boolean;
}
```

### 2. UI Changes

**`src/webview/kanban.html`** — Add to `ROLE_ADDONS` (line 2348) for ALL built-in roles:
```javascript
const ROLE_ADDONS = {
    planner: [
        // ... existing addons ...
        { id: 'switchboardSafeguards', label: 'Switchboard Safeguards', tooltip: 'Include batch execution rules and focus directive', default: true }
    ],
    lead: [
        // ... existing addons ...
        { id: 'switchboardSafeguards', label: 'Switchboard Safeguards', tooltip: 'Include batch execution rules and focus directive', default: true }
    ],
    coder: [
        // ... existing addons ...
        { id: 'switchboardSafeguards', label: 'Switchboard Safeguards', tooltip: 'Include batch execution rules and focus directive', default: true }
    ],
    reviewer: [
        // ... existing addons ...
        { id: 'switchboardSafeguards', label: 'Switchboard Safeguards', tooltip: 'Include batch execution rules and focus directive', default: true }
    ],
    tester: [
        // ... existing addons ...
        { id: 'switchboardSafeguards', label: 'Switchboard Safeguards', tooltip: 'Include batch execution rules and focus directive', default: true }
    ],
    intern: [
        // ... existing addons ...
        { id: 'switchboardSafeguards', label: 'Switchboard Safeguards', tooltip: 'Include batch execution rules and focus directive', default: true }
    ],
    analyst: [
        // ... existing addons ...
        { id: 'switchboardSafeguards', label: 'Switchboard Safeguards', tooltip: 'Include batch execution rules and focus directive', default: true }
    ],
    ticket_updater: [
        { id: 'switchboardSafeguards', label: 'Switchboard Safeguards', tooltip: 'Include batch execution rules and focus directive', default: true },
        { id: 'gitProhibition', label: 'Git Prohibition', tooltip: 'Include git prohibition directive', default: true },
        { id: 'ticketUpdateEnabled', label: 'Ticket Update', tooltip: 'Update associated ticket with AI analysis', default: true }
    ],
    researcher: [
        { id: 'switchboardSafeguards', label: 'Switchboard Safeguards', tooltip: 'Include batch execution rules and focus directive', default: true },
        { id: 'gitProhibition', label: 'Git Prohibition', tooltip: 'Include git prohibition directive', default: true },
        { id: 'researchEnabled', label: 'Deep Research', tooltip: 'Enable deep research mode', default: true }
    ],
    splitter: [
        { id: 'switchboardSafeguards', label: 'Switchboard Safeguards', tooltip: 'Include batch execution rules and focus directive', default: true },
        { id: 'gitProhibition', label: 'Git Prohibition', tooltip: 'Include git prohibition directive', default: true },
        { id: 'complexityScoringSkill', label: 'Complexity Scoring', tooltip: 'Invoke complexity scoring before split', default: false }
    ]
};
```

Update `DEFAULT_CONFIG` (line 2382) to include `switchboardSafeguards: true` for all built-in roles.

**Custom agent addon form** — Add checkbox to both `kanban.html` (line ~2069) and `setup.html` (line ~602):
```html
<label class="checkbox-label"><input type="checkbox" id="ca-addon-switchboard-safeguards" style="width:auto;margin:0;"> Switchboard Safeguards</label>
```

Update the custom agent form load/save JS to include the new addon field.

### 3. Prompt Builder Updates

**`src/services/agentPromptBuilder.ts`** — Modify `buildKanbanBatchPrompt`:

Add at line ~238 (after `gitProhibitionEnabled`):
```typescript
const switchboardSafeguardsEnabled = options?.switchboardSafeguardsEnabled ?? true;
```

Then wrap `batchExecutionRules` and `FOCUS_DIRECTIVE` injection in each role template with a conditional. Example for `lead` role (line 406-424):
```typescript
if (role === 'lead') {
    const safeguardsBlock = switchboardSafeguardsEnabled
        ? `${batchExecutionRules}\n\n${dispatchContextPrefix}${FOCUS_DIRECTIVE}`
        : `${dispatchContextPrefix}`;
    let leadPrompt = `Please execute the following ${plans.length} plans.

${executionDirective}

${safeguardsBlock}${challengeBlock}${gitProhibitionEnabled ? GIT_PROHIBITION_DIRECTIVE : ''}

PLANS TO PROCESS:
${planList}`;
    // ... rest unchanged
}
```

Apply the same pattern to all 10 role templates. When `switchboardSafeguardsEnabled` is `true` (default), output is identical to current behavior.

**`src/services/TaskViewerProvider.ts`** — Modify `buildCustomAgentPrompt` (line 5593-5651):

Refactor line 5609 to conditionally include `FOCUS_DIRECTIVE` and add `batchExecutionRules`:
```typescript
private buildCustomAgentPrompt(
    plans: BatchPromptPlan[],
    promptInstructions?: string,
    addons?: CustomAgentAddons,
    workspaceRoot?: string
): string {
    const { planList, dispatchContextBlock } = buildPromptDispatchContext(plans);
    const dispatchContextPrefix = dispatchContextBlock ? `${dispatchContextBlock}\n\n` : '';

    // Custom workflow: prepend read-workflow instruction
    if (addons?.customWorkflowPath) {
        return `Read ${addons.customWorkflowPath} and follow it step-by-step.\n\n` +
            this.buildCustomAgentPrompt(plans, promptInstructions,
                { ...addons, customWorkflowPath: undefined }, workspaceRoot);
    }

    // Build safeguards block (batch rules + focus directive)
    const safeguardsBlock = addons?.switchboardSafeguards
        ? (() => {
            const parallelInstruction = plans.length > 1
                ? `If your platform supports parallel sub-agents, dispatch one sub-agent per plan to execute them concurrently. If not, process them sequentially.\n\n`
                : '';
            return `${parallelInstruction}CRITICAL INSTRUCTIONS:
1. Treat each plan file path below as a completely isolated context. Do not mix requirements between plans.
2. Execute each plan fully before moving to the next (if sequential).
3. If one plan hits an issue, report it clearly but continue processing the remaining plans when safe to do so.\n\n${FOCUS_DIRECTIVE}`;
        })()
        : `${FOCUS_DIRECTIVE}`;

    let prompt = `${dispatchContextPrefix}${safeguardsBlock}\n\nPLANS TO PROCESS:\n${planList}`;

    // Apply directives in defined order (unchanged from current)
    if (addons?.gitProhibitionEnabled) prompt += GIT_PROHIBITION_DIRECTIVE;
    // ... rest of addon directives unchanged ...
```

**Key fix**: `FOCUS_DIRECTIVE` is now inside the conditional block — when safeguards ON, it appears once (inside `safeguardsBlock`); when safeguards OFF, it appears once (as the fallback). No duplication.

### 4. Data Flow Wiring

**`src/services/KanbanProvider.ts`** — Update `_getPromptsConfig()` (line 2006-2029):

Add `switchboardSafeguardsByRole` to the returned config object:
```typescript
return {
    // ... existing fields ...
    switchboardSafeguardsByRole: {
        planner: plannerConfig?.addons?.switchboardSafeguards ?? true,
        lead: leadConfig?.addons?.switchboardSafeguards ?? true,
        coder: coderConfig?.addons?.switchboardSafeguards ?? true,
        reviewer: reviewerConfig?.addons?.switchboardSafeguards ?? true,
        tester: testerConfig?.addons?.switchboardSafeguards ?? true,
        intern: internConfig?.addons?.switchboardSafeguards ?? true,
        analyst: analystConfig?.addons?.switchboardSafeguards ?? true,
        researcher: researcherConfig?.addons?.switchboardSafeguards ?? true,
        splitter: splitterConfig?.addons?.switchboardSafeguards ?? true,
        ticket_updater: ticketUpdaterConfig?.addons?.switchboardSafeguards ?? true,
    },
};
```

Then update all call sites that build `PromptBuilderOptions` to include:
```typescript
switchboardSafeguardsEnabled: promptsConfig.switchboardSafeguardsByRole?.[role] ?? true
```

Call sites to update in `KanbanProvider.ts`:
- `_generateBatchPlannerPrompt` (line 2093)
- `_generateBatchExecutionPrompt` (line 2138)
- `_dispatchWithPairProgrammingIfNeeded` (line 2170)
- `_generatePromptForColumn` reviewer branch (line 2302)
- `_generatePromptForDestinationRole` reviewer branch (line 2336)
- `_generateBatchTesterPrompt` (line ~5383)

Call sites to update in `TaskViewerProvider.ts`:
- `_buildKanbanBatchPrompt` (line 5563)
- Single-plan dispatch in ticket viewer (line ~13832)

## Proposed Changes

### `src/services/agentConfig.ts`
- **Context**: Defines `CustomAgentAddons` interface and `parseCustomAgentAddons` function
- **Logic**: Add `switchboardSafeguards?: boolean` to `CustomAgentAddons`; add parsing line in `parseCustomAgentAddons`
- **Implementation**: 2 lines added (interface field + parser line)
- **Edge Cases**: Existing custom agents without the field default to `undefined` (falsy) — correct behavior (safeguards OFF)

### `src/services/agentPromptBuilder.ts`
- **Context**: Canonical prompt builder for built-in roles; defines `PromptBuilderOptions`, `batchExecutionRules`, `FOCUS_DIRECTIVE`
- **Logic**: Add `switchboardSafeguardsEnabled?: boolean` to `PromptBuilderOptions` (default `true`); wrap `batchExecutionRules` and `FOCUS_DIRECTIVE` in conditional blocks across all 10 role templates
- **Implementation**: Add option field + modify each role template to use conditional safeguards block
- **Edge Cases**: Default `true` preserves current behavior. Must verify each role template produces identical output when flag is `true`.

### `src/services/TaskViewerProvider.ts`
- **Context**: Contains `buildCustomAgentPrompt` for custom agents
- **Logic**: When `addons?.switchboardSafeguards` is true, inject `batchExecutionRules` before `FOCUS_DIRECTIVE`. Refactor line 5609 so `FOCUS_DIRECTIVE` is not duplicated.
- **Implementation**: Replace unconditional `FOCUS_DIRECTIVE` at line 5609 with conditional `safeguardsBlock` construction
- **Edge Cases**: When safeguards OFF (default for custom agents), output must be identical to current: `dispatchContextPrefix + FOCUS_DIRECTIVE + planList + addons`. When safeguards ON, adds `batchExecutionRules` before `FOCUS_DIRECTIVE`.

### `src/services/KanbanProvider.ts`
- **Context**: `_getPromptsConfig()` bridges UI role configs to `PromptBuilderOptions`
- **Logic**: Add `switchboardSafeguardsByRole` map, reading from `roleConfigs[role].addons.switchboardSafeguards` with default `true`
- **Implementation**: Add map to returned config; update all call sites to pass `switchboardSafeguardsEnabled`
- **Edge Cases**: Roles without `switchboardSafeguards` in their `roleConfigs` default to `true` via `?? true`

### `src/webview/kanban.html`
- **Context**: Prompts Tab UI with `ROLE_ADDONS`, `DEFAULT_CONFIG`, custom agent addon form
- **Logic**: Add `switchboardSafeguards` entry to `ROLE_ADDONS` for all 10 built-in roles (default: `true`); add to `DEFAULT_CONFIG`; add checkbox to custom agent addon form; update load/save JS
- **Implementation**: ~30 lines added across `ROLE_ADDONS`, `DEFAULT_CONFIG`, custom agent form HTML, and load/save JS
- **Edge Cases**: `ticket_updater`, `researcher`, `splitter` currently have NO `ROLE_ADDONS` entries — must add full addon arrays for them (they already have `DEFAULT_CONFIG` entries)

### `src/webview/setup.html`
- **Context**: Setup panel custom agent form with addon checkboxes
- **Logic**: Add "Switchboard Safeguards" checkbox; update load/save JS
- **Implementation**: 1 checkbox HTML line + 2 JS lines (load + save)
- **Edge Cases**: None

## Verification Plan

### Automated Tests
No automated test infrastructure exists for prompt generation. Manual verification required:

1. **Built-in role with safeguards ON (default)**: Open Prompts Tab, select Lead role → verify "Switchboard Safeguards" checked → preview shows `batchExecutionRules` + `FOCUS_DIRECTIVE` → identical to current output
2. **Built-in role with safeguards OFF**: Uncheck "Switchboard Safeguards" for Lead → preview should NOT contain `batchExecutionRules` or `FOCUS_DIRECTIVE`
3. **Custom agent with safeguards OFF (default)**: Create/edit custom agent → verify "Switchboard Safeguards" unchecked → dispatch prompt contains only `FOCUS_DIRECTIVE` (no batch rules)
4. **Custom agent with safeguards ON**: Check "Switchboard Safeguards" for custom agent → dispatch prompt contains `batchExecutionRules` + `FOCUS_DIRECTIVE` (no duplication)
5. **Multi-plan dispatch**: Batch 3 plans to custom agent with safeguards ON → verify parallel instruction + batch rules appear
6. **Single-plan dispatch**: Dispatch 1 plan with safeguards ON → verify NO parallel instruction (only batch rules + focus)
7. **State persistence**: Toggle safeguards, reload window → verify checkbox state preserved
8. **Backward compatibility**: Open workspace with existing `state.json` lacking `switchboardSafeguards` → verify defaults kick in (ON for built-in, OFF for custom)
9. **Git prohibition independence**: Toggle safeguards OFF but git prohibition ON → verify git prohibition still appears in prompt
10. **Preview refresh**: Toggle checkbox → verify preview updates immediately

## Expected Benefits
- **Flexibility**: Users can easily apply Switchboard's robust multi-plan orchestration rules to their Custom Agents with a single click, rather than hardcoding defensive instructions.
- **Opt-out for Built-ins**: Users who want a built-in agent (like a Coder) to intentionally synthesize multiple plans together can simply uncheck the box to drop the batch isolation rules.
- **Architectural Cleanliness**: Moves batch execution constraints out of hardcoded role templates and into a composable user-controlled toggle via the existing `ROLE_ADDONS` system.

## Files to Modify
- `src/services/agentConfig.ts` — `CustomAgentAddons` interface + `parseCustomAgentAddons`
- `src/services/agentPromptBuilder.ts` — `PromptBuilderOptions` + conditional safeguards in all role templates
- `src/services/TaskViewerProvider.ts` — `buildCustomAgentPrompt` safeguards block
- `src/services/KanbanProvider.ts` — `_getPromptsConfig` + call sites
- `src/webview/kanban.html` — `ROLE_ADDONS`, `DEFAULT_CONFIG`, custom agent form
- `src/webview/setup.html` — custom agent addon checkbox

## Success Criteria
- [ ] "Switchboard Safeguards" checkbox appears in Prompts Tab for all 10 built-in roles
- [ ] Built-in roles default to ON, custom agents default to OFF
- [ ] Toggling checkbox immediately updates prompt preview
- [ ] Dispatching plans respects the checkbox state
- [ ] No double `FOCUS_DIRECTIVE` in custom agent prompts when safeguards ON
- [ ] Git prohibition checkbox works independently of safeguards toggle
- [ ] State persists across IDE restarts via `roleConfigs` / `CustomAgentAddons`
- [ ] Backward compatible with existing configs (defaults kick in for missing field)
- [ ] `ticket_updater`, `researcher`, `splitter` now have `ROLE_ADDONS` entries in Prompts Tab

**Recommendation: Send to Coder** (Complexity ≤ 6)
