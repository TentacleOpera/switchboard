# Refactoring Subagent Policy Configuration Options

This plan describes changes to refine the subagent spawning policies across all agent roles (including Planner) and Custom Agents in the Switchboard Kanban interface. It replaces the ambiguous "Default" vs "No Subagents" options with clear, distinct settings: "Not Specified", "No Subagents", "Yes (Use Subagents)", and "Custom Subagent" (with optional Custom Subagent naming).

## Goal

Refactor the subagent policy from a 3-state radio ("Default", "No Subagents", "Custom Subagent") plus a separate Planner checkbox into a unified 4-state radio across all roles and Custom Agents, eliminating the legacy `useSubagents` boolean fallback and the Planner-specific checkbox.

## Metadata

- **Tags:** [frontend, UX, workflow]
- **Complexity:** 5

## User Review Required

> [!IMPORTANT]
> **Key Refactoring Actions**:
> - **"Not Specified" (value: `'default'`)**: Will not inject *any* subagent policy or sequential/parallel instruction in prompt templates, letting the execution platform decide.
> - **"No Subagents" (value: `'noSubagents'`)**: Injects strict prohibition directive `NO_SUBAGENTS_DIRECTIVE` in the prompt template.
> - **"Yes (Use Subagents)" (value: `'useSubagents'`)**: Injects parallel subagent authorization instruction when handling multiple plans.
> - **"Custom Subagent" (value: `'customSubagent'`)**: Injects specific custom subagent instructions.
> - **Unification**: The Planner role's subagent policy will be unified to use the same four-state subagent policy rather than a standalone boolean checkbox.
> - **Behavioral Change**: The current "Default" option injects a sequential processing directive for multi-plan batches. The new "Not Specified" option will inject *no* subagent directive at all, letting the platform decide. This is an intentional behavioral change — users who want explicit sequential processing should select "No Subagents" or rely on platform defaults.

---

## Complexity Audit

### Routine
- Adding `useSubagents` as a fourth radio option to `ROLE_ADDONS` entries in `sharedDefaults.js` (mechanical repetition across 11 roles)
- Updating radio option labels from "Default" to "Not Specified" and adjusting tooltips
- Adding `useSubagents` radio option to the Custom Agent form in `kanban.html`
- Updating `noSubagentsByRole` and `customSubagentNameByRole` mappings in `KanbanProvider.ts` (no logic change, just confirming they already work correctly)

### Complex / Risky
- **Planner checkbox → radio migration**: Removing the hardcoded `plannerAddonUseSubagents` checkbox and replacing it with the dynamic `renderRoleAddons` radio group requires careful HTML restructuring and listener cleanup. The Planner is the only role with a hand-coded checkbox; all other roles use the dynamic renderer.
- **Backward compatibility for legacy `useSubagents` boolean**: Existing saved configs may have `addons.useSubagents = true/false` without a `subagentPolicy` key, or `subagentPolicy = 'default'` with `useSubagents = true`. The `useSubagentsByRole` mapping and `buildCustomAgentPrompt` path both have fallback chains that read the legacy boolean. These must be updated to recognize the new `'useSubagents'` policy value while gracefully handling legacy configs.
- **Behavioral change for "default" option**: Currently `subagentPolicy === 'default'` with multiple plans injects `Process each plan sequentially. Do not use parallel sub-agents.` The new behavior injects nothing. Users relying on the explicit sequential directive will see a change.

---

## Edge-Case & Dependency Audit

- **Race Conditions**: None. Subagent policy is resolved at prompt-build time (synchronous), not during concurrent operations.
- **Security**: The `customSubagentName` is already sanitized via regex (`/[^a-zA-Z0-9_]/g`) in `agentPromptBuilder.ts` line 346. No new security exposure.
- **Side Effects**: Removing the Planner checkbox listener at kanban.html line 3567 and the checkbox element at line 2537 will break if any other code references `plannerAddonUseSubagents`. A grep confirms it's only referenced in the Planner-specific listener array and the Planner load block.
- **Dependencies & Conflicts**: No other plans depend on the subagent policy structure. The `buildCustomAgentPrompt` function in `agentPromptBuilder.ts` (line 1113) has its own `useSubagentsEnabled` resolution that must be updated in tandem with `KanbanProvider.ts`.

---

## Dependencies

None

---

## Adversarial Synthesis

Key risks: backward compatibility for legacy `useSubagents` boolean configs (users with `useSubagents: true` but no `subagentPolicy` will silently lose parallel behavior), and the behavioral change where "Not Specified" no longer injects a sequential directive. Mitigations: add migration logic in `useSubagentsByRole` to detect legacy boolean and map it to `'useSubagents'` policy; document the behavioral change clearly in the User Review section.

---

## Proposed Changes

### Configuration Defaults

#### [MODIFY] [sharedDefaults.js](file:///Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/sharedDefaults.js)

**Lines 62–232 (`ROLE_ADDONS` object)**

For every role that has a `subagentPolicy` radio entry (planner, lead, coder, reviewer, tester, intern, analyst, ticket_updater, researcher, splitter, code_researcher), update the `options` array:

1. Change the first option's label from `'Default'` to `'Not Specified'` and update its tooltip from `'Use platform default subagent behavior (sequential processing)'` to `'Let the execution platform decide subagent behavior'`.
2. Add a new option **after** `'noSubagents'` and **before** `'customSubagent'`:
   ```
   { value: 'useSubagents', label: 'Yes (Use Subagents)', tooltip: 'Instruct the agent to use parallel subagents when handling multiple plans' }
   ```

The resulting options array for each role becomes:
```javascript
options: [
    { value: 'default', label: 'Not Specified', tooltip: 'Let the execution platform decide subagent behavior' },
    { value: 'noSubagents', label: 'No Subagents', tooltip: 'Explicitly instruct the agent not to spawn or invoke any subagents' },
    { value: 'useSubagents', label: 'Yes (Use Subagents)', tooltip: 'Instruct the agent to use parallel subagents when handling multiple plans' },
    { value: 'customSubagent', label: 'Custom Subagent', tooltip: 'Instruct the agent to use a specific custom subagent', textInputOn: 'customSubagent' }
]
```

Also add `subagentPolicy` and `customSubagentName` to the `gatherer` role's `DEFAULT_ROLE_CONFIG` (line 34) and `ROLE_ADDONS` (lines 226–232), matching the same four-option radio pattern. Currently `gatherer` is the only role without subagent policy configuration.

### Webview Interface

#### [MODIFY] [kanban.html](file:///Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/kanban.html)

**1. Remove Planner hardcoded checkbox (line 2536–2540)**

Delete the following HTML block:
```html
<label class="checkbox-item" title="When processing multiple plans, instruct platform to use parallel subagents (if supported)">
  <input type="checkbox" id="plannerAddonUseSubagents">
  <span>Use Subagents for Multiple Plans</span>
  <span class="tooltip">When processing multiple plans, instruct platform to use parallel subagents (if supported)</span>
</label>
```

The Planner's subagent policy will now be rendered dynamically by `renderRoleAddons('planner')` using the updated `ROLE_ADDONS.planner` definition (which already includes the `subagentPolicy` radio entry at sharedDefaults.js line 71).

**2. Update Planner load logic (line 2815)**

Remove:
```javascript
document.getElementById('plannerAddonUseSubagents').checked = config.addons?.useSubagents !== false;
```

The `renderRoleAddons('planner')` call at line 2829 already handles loading the `subagentPolicy` radio state from `roleConfigs.planner.addons.subagentPolicy`. No additional load code is needed.

**3. Update Planner save listener (line 3567)**

Remove `'plannerAddonUseSubagents'` from the Planner add-on listener array:
```javascript
// Before:
['plannerAddonSwitchboardSafeguards', 'plannerAddonDependencyCheck', 'plannerAddonDesignDoc', 'plannerAddonAggressivePairProgramming', 'plannerAddonGitProhibition', 'plannerAddonClearAntigravityContext', 'plannerAddonCavemanOutput', 'plannerAddonSkipCompilation', 'plannerAddonSkipTests', 'plannerAddonUseSubagents'].forEach(id => {

// After:
['plannerAddonSwitchboardSafeguards', 'plannerAddonDependencyCheck', 'plannerAddonDesignDoc', 'plannerAddonAggressivePairProgramming', 'plannerAddonGitProhibition', 'plannerAddonClearAntigravityContext', 'plannerAddonCavemanOutput', 'plannerAddonSkipCompilation', 'plannerAddonSkipTests'].forEach(id => {
```

The `subagentPolicy` radio for Planner is now handled by the generic `renderRoleAddons` radio change listener (kanban.html line 2905–2929).

**4. Add `useSubagents` option to Custom Agent form (lines 2383–2394)**

Insert a new radio option between `noSubagents` and `customSubagent`:
```html
<label class="checkbox-label" style="display:flex; align-items:center; gap:6px;">
  <input type="radio" name="ca-subagent-policy" value="useSubagents" style="width:auto; margin:0;">
  <span>Yes (Use Subagents)</span>
</label>
```

Also update the "Default" label to "Not Specified":
```html
<!-- Before: -->
<span>Default (sequential)</span>
<!-- After: -->
<span>Not Specified</span>
```

### Prompt Composition and Resolution

#### [MODIFY] [KanbanProvider.ts](file:///Users/patrickvuleta/Documents/GitHub/switchboard/src/services/KanbanProvider.ts)

**Lines 2638–2649 (`useSubagentsByRole` mapping)**

Replace the current fallback-chain logic with a direct `subagentPolicy === 'useSubagents'` check, plus a legacy migration path for configs that have `useSubagents: true` but no `subagentPolicy`:

```typescript
// Before (per-role example):
planner: plannerConfig?.addons?.subagentPolicy === 'default' ? false : (plannerConfig?.addons?.useSubagents ?? false),

// After (per-role example):
planner: plannerConfig?.addons?.subagentPolicy === 'useSubagents'
    || (plannerConfig?.addons?.subagentPolicy === undefined && plannerConfig?.addons?.useSubagents === true),
```

Apply this pattern to all 11 roles in the `useSubagentsByRole` mapping. The second condition (`subagentPolicy === undefined && useSubagents === true`) handles legacy configs that were saved before this refactoring.

The `noSubagentsByRole` and `customSubagentNameByRole` mappings (lines 2651–2675) already work correctly with the existing `subagentPolicy` checks and need no changes.

#### [MODIFY] [agentPromptBuilder.ts](file:///Users/patrickvuleta/Documents/GitHub/switchboard/src/services/agentPromptBuilder.ts)

**Lines 349–363 (built-in role prompt builder)**

Update the subagent block logic for the `'default'` case. Currently, when `subagentPolicy === 'default'` and there are multiple plans, a sequential directive is injected. The new behavior: when `subagentPolicy === 'default'` (Not Specified), inject *no* subagent block at all:

```typescript
// Before (lines 357-362):
} else if (plans.length > 1) {
    if (useSubagentsEnabled) {
        subagentBlock = `If your platform supports parallel sub-agents, dispatch one sub-agent per plan to execute them concurrently. If not, process them sequentially.`;
    } else {
        subagentBlock = `Process each plan sequentially. Do not use parallel sub-agents.`;
    }
}

// After:
} else if (plans.length > 1 && useSubagentsEnabled) {
    subagentBlock = `If your platform supports parallel sub-agents, dispatch one sub-agent per plan to execute them concurrently. If not, process them sequentially.`;
}
// When useSubagentsEnabled is false and no other policy applies, subagentBlock remains '' (no directive injected)
```

**Lines 1111–1129 (custom agent prompt builder)**

Update the `useSubagentsEnabled` resolution to recognize the new `'useSubagents'` policy value and handle legacy configs:

```typescript
// Before (line 1113):
const useSubagentsEnabled = addons?.subagentPolicy === 'default' ? false : (addons?.useSubagents !== false);

// After:
const useSubagentsEnabled = addons?.subagentPolicy === 'useSubagents'
    || (addons?.subagentPolicy === undefined && addons?.useSubagents === true);
```

Also apply the same sequential-directive removal as the built-in path:

```typescript
// Before (lines 1123-1128):
} else if (plans.length > 1) {
    if (useSubagentsEnabled) {
        subagentBlock = `If your platform supports parallel sub-agents, dispatch one sub-agent per plan to execute them concurrently. If not, process them sequentially.`;
    } else {
        subagentBlock = `Process each plan sequentially. Do not use parallel sub-agents.`;
    }
}

// After:
} else if (plans.length > 1 && useSubagentsEnabled) {
    subagentBlock = `If your platform supports parallel sub-agents, dispatch one sub-agent per plan to execute them concurrently. If not, process them sequentially.`;
}
```

---

## Verification Plan

### Automated Tests
- Run existing regression tests to ensure no regressions:
  ```bash
  npm run test
  ```

### Manual Verification
- Open the Prompts tab in the Kanban board.
- Check that the subagent policy options are correctly displayed as "Not Specified", "No Subagents", "Yes (Use Subagents)", and "Custom Subagent" for all roles (including Planner).
- Verify the Planner no longer shows a "Use Subagents for Multiple Plans" checkbox — it should now show the same 4-option radio group as other roles.
- Toggle between options and check that prompt preview dynamically updates:
  - **Not Specified**: No subagent policy or sequential/parallel instructions appear in the preview.
  - **No Subagents**: Strict `SUBAGENT POLICY: You are strictly forbidden from spawning or invoking any subagents` is appended.
  - **Yes (Use Subagents)**: Parallel execution instructions are appended when multiple plans are present.
  - **Custom Subagent**: Custom subagent directive is appended with the specified name.
- Create/edit a Custom Agent and verify that the Subagent Policy settings save and function identically, including the new "Yes (Use Subagents)" option.
- Test backward compatibility: load a workspace where Planner had `useSubagents: true` saved (no `subagentPolicy` key). Verify the prompt preview still shows parallel subagent instructions (legacy migration path).

---

**Recommendation**: Complexity 5 → Send to Coder
