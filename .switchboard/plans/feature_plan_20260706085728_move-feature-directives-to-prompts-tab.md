# Remove "Apply Feature Ultracode/Goal Directives" Checkbox from Custom Agent Form

## Goal

In the Agents tab of `kanban.html`, the "New Custom Agent" form has a checkbox labeled "Apply feature ultracode/goal directives" that controls whether the board's ultracode/goal directives are prepended when the agent is dispatched on a feature. The user questions why this checkbox exists in the agent creation form when prompt add-ons are configured in the Prompts tab after the agent is created. The checkbox should be removed from the creation form and moved to the Prompts tab as a role-specific add-on for custom agents, consolidating all add-on configuration in one place.

### Problem Analysis & Root Cause

The checkbox at line 2785-2789 of `src/webview/kanban.html` is in the custom agent creation/edit form:
```html
<label class="checkbox-item" title="When dispatched on a feature, prepend the board's ultracode//goal directives (as for Lead/Coder/Intern)." style="margin-top:8px;">
  <input type="checkbox" id="agents-tab-custom-agent-apply-feature-directives">
  <span>Apply feature ultracode/goal directives</span>
  <span class="tooltip">When dispatched on a feature, prepend the board's ultracode//goal directives (as for Lead/Coder/Intern).</span>
</label>
```

The checkbox IS wired up — it's read at line 3582 and saved into `nextAgent.addons.applyFeatureDirectives`, and the backend uses it at `KanbanProvider.ts` line 4001 to prepend feature directives during dispatch. So it's functionally important, not dead code.

However, the Prompts tab already has a mechanism for configuring role-specific add-ons via `renderRoleAddons()`. For custom agents, it currently shows two add-ons: "Workflow File" and "Worktrees Per Plan" (lines 3338-3341). The "Apply Feature Directives" setting should be moved there as a third add-on, so all custom agent configuration lives in the Prompts tab.

The root cause is a design inconsistency: most agent add-ons are in the Prompts tab, but this one was placed in the creation form, likely because it felt like a "creation-time" decision. In practice, the user expects to configure all add-ons in one place after the agent exists.

## Metadata

- **Tags:** ui-cleanup, agents-tab, prompts-tab, custom-agents, kanban-html
- **Complexity:** 3

## Complexity Audit

**Routine.** Remove a checkbox from the creation form, add it as a role-specific add-on in the Prompts tab's `renderRoleAddons` function for custom agents, and ensure the save/load path still works. The backend (`applyFeatureDirectives` in `agentConfig.ts` and `KanbanProvider.ts`) does not need changes — it reads the flag from `addons` regardless of where the UI sets it.

## Edge-Case & Dependency Audit

- **Existing custom agents:** Agents already saved with `applyFeatureDirectives: true` must retain that setting. The Prompts tab add-on will read from `roleConfigs[role].addons.applyFeatureDirectives`, which is loaded from the backend via `getSetting` → `roleConfig_<role>`. No migration needed — the data model is unchanged.
- **`agentsTabShowInlineForm`:** Currently reads the checkbox at line 3540 (`!!agent?.addons?.applyFeatureDirectives`) and sets it. After removing the checkbox, this line must be removed too.
- **`agentsTabSaveCustomAgent`:** Currently reads the checkbox at line 3582 and merges it into `nextAgent.addons`. After removing the checkbox, this must be removed. The `applyFeatureDirectives` flag will instead be saved through the Prompts tab's add-on save path (which writes to `roleConfigs[role].addons`).
- **Prompts tab save path:** The Prompts tab already saves add-on changes via `postKanbanMessage({ type: 'setSetting', key: 'roleConfig_<role>', value: roleConfigs[role] })`. Adding the new add-on to `ROLE_ADDONS` for custom agents will make it render and save automatically through this existing path.
- **`AgentSkillExporter.ts` line 346:** Reads `addons.applyFeatureDirectives` — unaffected by UI changes.
- **`agentConfig.ts` line 214:** Copies `applyFeatureDirectives` from settings to agent — unaffected.

## Proposed Changes

### 1. `src/webview/kanban.html` — Remove checkbox from custom agent form (~lines 2785-2789)

Delete the entire `<label class="checkbox-item">` block for the apply-feature-directives checkbox.

Also remove the explanatory paragraph below it (lines 2790-2792) if it only relates to this checkbox — but check: it says "Configure prompt add-ons and custom instructions in the PROMPTS tab after saving this agent." This is still useful guidance, so **keep it**.

### 2. `src/webview/kanban.html` — Remove checkbox read in `agentsTabShowInlineForm` (~line 3540)

Delete:
```javascript
document.getElementById('agents-tab-custom-agent-apply-feature-directives').checked = !!agent?.addons?.applyFeatureDirectives;
```

### 3. `src/webview/kanban.html` — Remove checkbox read in `agentsTabSaveCustomAgent` (~lines 3582-3583)

Delete:
```javascript
const applyFeatureDirectives = document.getElementById('agents-tab-custom-agent-apply-feature-directives').checked;
nextAgent.addons = { ...(nextAgent.addons || {}), applyFeatureDirectives };
```

Note: The existing `nextAgent.addons` preservation logic at lines 3577-3578 already copies `existing.addons` when editing, so the `applyFeatureDirectives` flag will be preserved through edits without the explicit merge.

### 4. `src/webview/kanban.html` — Add "Apply Feature Directives" add-on for custom agents in `renderRoleAddons` (~line 3338)

In the `renderRoleAddons` function, the custom agent fallback addons array (lines 3338-3341) should include the new add-on:

```javascript
if (addons.length === 0 && role.startsWith('custom_agent_')) {
    addons = [
        { id: 'workflowFilePath', label: 'Workflow File', tooltip: 'Read a workflow file and follow it step-by-step', type: 'file', default: false },
        { id: 'useWorktreesPerPlan', label: 'Worktrees Per Plan', tooltip: 'Instruct the agent to use its native subagent/orchestration capabilities to process each plan in an isolated git worktree', default: false },
        { id: 'applyFeatureDirectives', label: 'Apply Feature Ultracode/Goal Directives', tooltip: 'When dispatched on a feature, prepend the board\'s ultracode//goal directives (as for Lead/Coder/Intern)', default: false }
    ];
}
```

### 5. Verify the Prompts tab add-on save/load path handles the new add-on

The `renderRoleAddons` function renders checkboxes that, when toggled, update `roleConfigs[role].addons[id]` and save via `setSetting`. Verify that the `applyFeatureDirectives` id flows through this path correctly by checking the checkbox event handler in `renderRoleAddons` (it should use the `addon.id` as the key, which it does generically).

## Verification Plan

1. Open the Kanban board → Agents tab.
2. Click "ADD CUSTOM AGENT" — verify the form no longer has the "Apply feature ultracode/goal directives" checkbox.
3. Save a new custom agent — verify it saves successfully.
4. Switch to the Prompts tab and select the custom agent from the Role dropdown.
5. Verify the "Apply Feature Ultracode/Goal Directives" checkbox appears in the Add-ons section alongside "Workflow File" and "Worktrees Per Plan".
6. Toggle the checkbox — verify it saves (check that the setting persists after switching roles and coming back).
7. Edit an existing custom agent that had `applyFeatureDirectives: true` — verify the checkbox in the Prompts tab is checked.
8. Dispatch the custom agent on a feature with the checkbox enabled — verify ultracode/goal directives are prepended (backend behavior unchanged).
