# Remove "Apply Feature Ultracode/Goal Directives" Checkbox from Custom Agent Form

**Plan ID:** 77055A58-571E-4105-9123-BEE2F47E05E0

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

**Dispatch-path verification (confirmed against source):** At `KanbanProvider.ts` lines 3960-3968, custom-agent dispatch builds `mergedAddons` by spreading the agent object's `addons` first, then the Prompts-tab `roleConfigAddons` (`this._getRoleConfig(role)?.addons`) on top:
```typescript
const roleConfigAddons = this._getRoleConfig(role)?.addons;
const mergedAddons = {
    ...agentConfig?.addons,
    ...(roleConfigAddons || {}),
};
```
Then line 4001 checks `mergedAddons.applyFeatureDirectives === true`. Because `roleConfigAddons` overrides `agentConfig?.addons`, a checkbox written to `roleConfigs[role].addons.applyFeatureDirectives` via the Prompts tab **does** control dispatch. The backend needs no change.

## Metadata

- **Tags:** ui, ux, refactor, frontend
- **Complexity:** 4

## User Review Required

Yes — moves a functionally important dispatch flag from the creation form to the Prompts tab. User should verify (a) the checkbox no longer appears in the creation form, (b) it appears in the Prompts tab for custom agents, and (c) an existing custom agent that previously had the flag enabled still gets feature directives prepended at dispatch. No backend/schema review needed — the data model is unchanged.

## Complexity Audit

### Routine
- Remove one `<label class="checkbox-item">` block from the creation form (lines 2785-2789).
- Remove two lines that read the checkbox in `agentsTabShowInlineForm` (line 3540) and `agentsTabSaveCustomAgent` (lines 3582-3583).
- Add one entry to the custom-agent fallback addons array in `renderRoleAddons` (lines 3338-3341).
- The generic checkbox event handler in `renderRoleAddons` (lines 3477-3496) already uses `addon.id` as the key and calls `saveRoleConfig(role)`, so the new add-on renders and persists with no handler changes.

### Complex / Risky
- **Existing-agent display/dispatch consistency (moderate, well-scoped):** agents created before this change stored `applyFeatureDirectives` in the *agent object's* `addons`, not in `roleConfig_<role>.addons`. The Prompts-tab checkbox reads only `roleConfigs[role]?.addons?.[addon.id] ?? addon.default`, so for those legacy agents the checkbox would render **unchecked** even though dispatch still honors the legacy agent-object value (the spread merge at `KanbanProvider.ts:3965` preserves it when `roleConfigAddons` lacks the key). This is a UI/dispatch inconsistency, not data loss — addressed by Step 6 below.

## Edge-Case & Dependency Audit

- **Existing custom agents (CORRECTED):** Agents already saved with `applyFeatureDirectives: true` in the agent object retain that setting at dispatch (the spread merge keeps it). However, the Prompts-tab checkbox reads from `roleConfigs[role].addons.applyFeatureDirectives` only — a *separate* store populated by `loadRoleConfigs()` (line 3244), which loads `roleConfig_<role>` settings and does NOT merge the agent object's addons. Result: the checkbox shows unchecked for legacy agents while dispatch still prepends directives. **Fix:** Step 6 seeds the checkbox's initial state from the agent object when `roleConfigs` lacks the key. No data migration of the agent object is needed; once the user toggles the checkbox in the Prompts tab, the value is written to `roleConfig_<role>` and takes over (it overrides the agent-object value in the spread merge).
- **`agentsTabShowInlineForm`:** Currently reads the checkbox at line 3540 (`!!agent?.addons?.applyFeatureDirectives`) and sets it. After removing the checkbox, this line must be removed too.
- **`agentsTabSaveCustomAgent`:** Currently reads the checkbox at lines 3582-3583 and merges it into `nextAgent.addons`. After removing the checkbox, this must be removed. The existing `nextAgent.addons` preservation logic at lines 3577-3578 already copies `existing.addons` when editing, so the `applyFeatureDirectives` flag is preserved through edits without the explicit merge. **Note:** new agents created after this change will no longer write `applyFeatureDirectives` into the agent object at all — it will live exclusively in `roleConfig_<role>`. This is fine because the spread merge reads both stores.
- **Prompts tab save path:** The Prompts tab already saves add-on changes via `postKanbanMessage({ type: 'saveSetting', key: 'roleConfig_<role>', value: roleConfigs[role] })` (via `saveRoleConfig`, line 3500). Adding the new add-on to the custom-agent fallback in `renderRoleAddons` makes it render and save automatically through this existing path. Verified the generic checkbox handler (lines 3488-3494) writes `roleConfigs[role].addons[addon.id] = e.target.checked` then `saveRoleConfig(role)`.
- **`AgentSkillExporter.ts` line 346:** Reads `addons.applyFeatureDirectives` — unaffected by UI changes (reads from the merged addons at export time).
- **`agentConfig.ts` line 214:** Copies `applyFeatureDirectives` from settings to agent — unaffected.
- **Built-in roles:** Feature-directive prepend for built-in roles (planner/lead/coder/intern) happens in a separate code path below line 4006 (the non-custom-agent branch), not via `roleConfig` addons. So scoping the new add-on to custom agents only is correct — it must not appear for built-in roles.
- **Race Conditions:** None — `renderRoleAddons` runs after `loadRoleConfigs()` and `getCustomAgents` hydrate; `lastCustomAgents` is populated by the time the user selects a role.
- **Security:** None.
- **Side Effects:** Removing the creation-form checkbox means new agents no longer carry `applyFeatureDirectives` in the agent object. Dispatch still works via `roleConfig_<role>`. No other code reads the agent-object `applyFeatureDirectives` except the spread merge (which tolerates its absence).
- **Dependencies & Conflicts:** Independent of the sibling subtask (role-selector visibility), which edits CSS + the tab-switch handler — non-overlapping line ranges in the same file.

## Dependencies

- None — standalone UI refactor. No prerequisite plans.

## Adversarial Synthesis

Key risks: (1) legacy agents with the flag in the agent object render an unchecked Prompts-tab checkbox while dispatch still honors the old value — a silent UI/dispatch mismatch that could confuse users into thinking the feature is off; (2) new agents no longer persist the flag in the agent object, so any external tool reading `agent.addons.applyFeatureDirectives` directly (outside the spread merge) would see `undefined`. Mitigations: Step 6 seeds the checkbox from the agent object on render so the UI reflects the effective dispatch state; the only direct reader (`AgentSkillExporter.ts:346`) operates on merged addons, so the second risk is theoretical.

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

The new entry has no `type` field, so it falls into the generic checkbox branch (lines 3477-3496), which reads/writes `roleConfigs[role].addons[addon.id]` and calls `saveRoleConfig(role)`.

### 5. Verify the Prompts tab add-on save/load path handles the new add-on

The `renderRoleAddons` function renders checkboxes that, when toggled, update `roleConfigs[role].addons[id]` and save via `setSetting`. Verified: the checkbox event handler in `renderRoleAddons` (lines 3488-3494) uses the `addon.id` as the key generically (`roleConfigs[role].addons[addon.id] = e.target.checked`), so `applyFeatureDirectives` flows through correctly with no handler changes.

### 6. `src/webview/kanban.html` — Seed checkbox initial state from the agent object for legacy agents (renderRoleAddons, ~line 3479)

The generic checkbox branch reads its initial state as:
```javascript
const isChecked = roleConfigs[role]?.addons?.[addon.id] ?? addon.default;
```

For custom agents, when `roleConfigs[role].addons` lacks `applyFeatureDirectives` (legacy agents that stored it in the agent object), fall back to the agent object so the checkbox reflects the effective dispatch state:

```javascript
let isChecked = roleConfigs[role]?.addons?.[addon.id] ?? addon.default;
// Clarification: legacy custom agents stored applyFeatureDirectives (and possibly
// useWorktreesPerPlan) in the agent object, not in roleConfig_<role>. Seed the
// checkbox from the agent object so the UI matches the effective dispatch value
// until the user toggles it (which then writes to roleConfig_<role> and takes over).
if (role.startsWith('custom_agent_') && isChecked === addon.default) {
    const agentObj = (typeof lastCustomAgents !== 'undefined' ? lastCustomAgents : [])
        .find(a => (a.role || ('custom_agent_' + a.id)) === role);
    if (agentObj?.addons?.[addon.id] === true) isChecked = true;
}
```

This is a read-only seed — it does not write to `roleConfig_<role>`, so it does not mutate stored state. The first user toggle persists the value to `roleConfig_<role>` via the existing change handler, after which the seed is no longer reached (the `?? addon.default` resolves to the stored value).

## Verification Plan

1. Open the Kanban board → Agents tab.
2. Click "ADD CUSTOM AGENT" — verify the form no longer has the "Apply feature ultracode/goal directives" checkbox.
3. Save a new custom agent — verify it saves successfully (no JS error from the removed checkbox element).
4. Switch to the Prompts tab and select the custom agent from the Role dropdown.
5. Verify the "Apply Feature Ultracode/Goal Directives" checkbox appears in the Add-ons section alongside "Workflow File" and "Worktrees Per Plan".
6. Toggle the checkbox — verify it saves (check that the setting persists after switching roles and coming back).
7. Edit an existing custom agent that had `applyFeatureDirectives: true` (legacy) — switch to the Prompts tab, select it, and verify the checkbox is **checked** (seeded from the agent object per Step 6).
8. Dispatch the custom agent on a feature with the checkbox enabled — verify ultracode/goal directives are prepended (backend behavior unchanged).
9. Dispatch a legacy agent whose checkbox shows checked but whose `roleConfig_<role>` has no key — verify directives still prepend (agent-object value survives the spread merge).

### Automated Tests

Skipped per session directive — this is a UI relocation with no new logic path to unit-test. Verification is manual (steps 1-9 above). The backend dispatch merge (`KanbanProvider.ts:3965`) is unchanged and already covered by existing behavior.

---

**Recommendation:** Complexity 4 → Send to Coder.

## Review Findings

Reviewed against commit `29b3060`. Checkbox removal from form, addon array addition, save-path removals, and legacy-agent seed all match the plan. **CRITICAL fix applied:** the seed condition `isChecked === addon.default` could not distinguish "roleConfig key absent" from "user explicitly set false" — a user who unchecked the checkbox would see it re-check on re-render (UI/dispatch mismatch on a dispatch-critical flag). Changed to guard on key existence (`=== undefined`) at `kanban.html:3487`. Also fixed a double-blank-line NIT at `kanban.html:3551`. File changed: `src/webview/kanban.html`. No orphaned references to the removed element ID. Dispatch merge path (`KanbanProvider.ts:3988-3991`) unchanged and correct. Verification (compile/tests) skipped per session directive. Remaining risk: narrow race where `lastCustomAgents` is empty if user selects a custom agent before the `getCustomAgents` async response arrives — seed falls back to default (false), self-corrects on next render.
