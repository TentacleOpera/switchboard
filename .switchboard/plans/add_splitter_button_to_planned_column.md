# Add Splitter Button to Planned Column

## Goal
Add a splitter icon button to the top of the Planned (PLAN REVIEWED) column to trigger the splitter agent for selected plans. Remove the 'split plan' add-on from the prompts tab to prevent automatic splitting of all plans, while keeping the splitter agent available in the agents tab for manual invocation.

## Metadata
- **Created**: 2026-05-29
- **Complexity**: 4
- **Status**: active
- **Tags**: frontend, UI, UX

## User Review Required
- Confirm icon choice for the splitter button. The plan proposes reusing `ICON_JULES` (`{{ICON_28}}`), which means the splitter and Jules buttons display the same icon. Consider using a dedicated icon token (e.g. `{{ICON_SPLITTER}}`) if a distinct SVG asset is available, or accept the alias for now.
- Confirm whether `triggerBatchAgentFromKanban` (batch dispatch, consistent with `rePlanSelected`) or a looping `triggerAgentFromKanban` (per-session, consistent with `julesSelected`) is preferred for the splitter handler.

## Complexity Audit

**Manual Complexity Override:** 3


### Routine
- Adding a conditional button to `kanban.html` button area (same pattern as `julesBtn`, `rePlanBtn`)
- Removing a row from `ROLE_ADDONS` in `sharedDefaults.js`
- Removing a `splitPlan: false` key from the default addons object in `sharedDefaults.js`
- Adding a new `case 'splitterSelected'` handler in `KanbanProvider.ts` (mirrors existing handlers)

### Complex / Risky
- None.



## Edge-Case & Dependency Audit

### Race Conditions
- The `splitterSelected` handler must call `_getEligibleSessionIds` to re-validate that selected plans are still in `PLAN REVIEWED` at dispatch time. Without this, a plan moved between selection and button-click would be sent to the wrong agent context.

### Security
- No security implications; this is a UI dispatch change.

### Side Effects
- Plans with `splitPlan: true` persisted in `state.json` will have no effect post-change (the setting is ignored). No data loss — the splitter agent remains fully functional via the column button.
- The `SPLIT_PLAN_DIRECTIVE` constant in `agentPromptBuilder.ts` (line 225) and its usage in the `splitter` role prompt builder (lines 873-901) must **NOT** be removed — the splitter agent itself still uses this directive. Only the `planner` path injection (line 368-370) and the `TaskViewerProvider` custom-agent path (line 6203) should be removed.

### Dependencies & Conflicts
- No cross-plan dependencies.
- The `_isSplitPlanEnabled()` helper in `TaskViewerProvider.ts` is called from three sites (6069, 12717, 14756). All three must be cleaned up together with the helper removal.

## Dependencies
- None

## Adversarial Synthesis
Key risks: (1) partial `splitPlan` removal across 5 files risks TypeScript errors if the `_getPromptsConfig` return-type property is not removed alongside all its consumers; (2) the proposed handler silently dispatches to all plans if `msg.sessionIds` is absent — must mirror `julesSelected` guard pattern; (3) the splitter button would display the same icon as Jules (`ICON_28`) unless a distinct icon is used. Mitigations: remove all `splitPlan` sites atomically per the expanded file list below; copy the `_getEligibleSessionIds` + `_getVisibleAgents` guard from `julesSelected`; accept icon alias or add a dedicated token.

## Problem
Currently, the splitter agent is only available as a planner add-on in the prompts tab. This means:
- Users must remember to enable it before planning
- It applies to all plans when enabled, which is not desired for every plan
- Large refactors that need splitting are identified after planning, not before

Users want to selectively split plans after they've been moved to the Planned column, based on their assessment of the plan's complexity and scope.

## Root Cause
The splitter functionality is implemented as a planner addon (`splitPlan`) in `ROLE_ADDONS` and injected into the planner prompt via `SPLIT_PLAN_DIRECTIVE`. There is no UI trigger to invoke the splitter agent on-demand for specific plans in the Planned column.

## Proposed Changes

### `src/webview/kanban.html` — Add splitter button to PLAN REVIEWED column header

**Context** (lines 3844-3887): The PLAN REVIEWED column currently has `julesBtn` and `rePlanBtn` conditional buttons. Add a splitter button alongside these.

**Logic**: Add a splitter icon button that appears when the splitter agent is visible (`lastVisibleAgents.splitter !== false`). The button sends `splitterSelected` with the currently selected session IDs.

**Implementation**:

1. Add icon constant after line 3168 (after `ICON_ARCHIVE_SELECTED`):
```javascript
const ICON_SPLITTER = '{{ICON_28}}';  // Reuses ICON_JULES token; replace with dedicated token if available
```

2. Add splitter button declaration after `rePlanBtn` (after line 3853):
```javascript
const splitterBtn = (isPlanReviewed && lastVisibleAgents.splitter !== false)
    ? `<button class="column-icon-btn" data-action="splitterSelected" data-column="${escapeAttr(def.id)}" data-tooltip="Split selected plans into Routine and Complex files">
           <img src="${ICON_SPLITTER}" alt="Splitter">
       </button>`
    : '';
```

3. Include `splitterBtn` in `buttonArea` after `${rePlanBtn}` (line 3883):
```javascript
buttonArea = `<div class="column-button-area">
    <button class="column-icon-btn" data-action="moveSelected" ...>...</button>
    <button class="column-icon-btn" data-action="moveAll" ...>...</button>
    <button class="column-icon-btn" data-action="promptSelected" ...>...</button>
    <button class="column-icon-btn" data-action="promptAll" ...>...</button>
    ${julesBtn}
    ${rePlanBtn}
    ${splitterBtn}
    ${codeMapBtn}
    ${testingFailBtn}
    ${chatBtn}
</div>`;
```

**Edge Cases**: `lastVisibleAgents.splitter` is populated via the same `updateAgentVisibility` path as all other agents (line 5384). No additional wiring needed.

---

### `src/webview/sharedDefaults.js` — Remove splitPlan addon from planner ROLE_ADDONS

**Context** (lines 20, 61-70): The planner `ROLE_ADDONS` array includes `splitPlan`, and line 20 includes `splitPlan: false` in the default addons object.

**Logic**: Remove both occurrences to fully deprecate the addon from the UI.

**Implementation**:

1. Remove from default addons object (line 20):
```javascript
// Remove splitPlan: false from the addons object on line 20
```

2. Remove from `ROLE_ADDONS.planner` array (line 67):
```javascript
// Remove this entry:
{ id: 'splitPlan', label: 'Split Plan', tooltip: 'Produce separate Routine and Complex plan files', default: false }
```

---

### `src/services/agentPromptBuilder.ts` — Remove splitPlan from planner prompt injection only

**Context** (lines 96, 276, 368-370): `splitPlan` is declared in `PromptBuilderOptions`, extracted from options, and injected into the planner prompt.

**⚠️ DO NOT remove**: `SPLIT_PLAN_DIRECTIVE` constant (line 225) or its usage inside the `splitter` role prompt builder (lines 873-901). Those are required for the splitter agent to function.

**Logic**: Remove the `splitPlan` option from `PromptBuilderOptions` and its planner injection path only.

**Implementation**:

1. Remove from `PromptBuilderOptions` interface (line 96):
```typescript
// Remove this line:
splitPlan?: boolean;
```

2. Remove from options extraction (line 276):
```typescript
// Remove this line:
const splitPlan = options?.splitPlan ?? false;
```

3. Remove from planner directive injection (lines 368-370):
```typescript
// Remove this block:
if (splitPlan) {
    plannerBase += '\n\n' + SPLIT_PLAN_DIRECTIVE;
}
```

---

### `src/services/KanbanProvider.ts` — Remove splitPlan from _getPromptsConfig + add splitterSelected handler

**Context**: `splitPlan` appears at lines 2253, 2360, 2584, 2692, 5973. The `_getPromptsConfig` method returns an object with `splitPlan` (line 2360); all consumer sites must be removed atomically.

**Logic**: Remove `splitPlan` from the prompts config object and all consumer call sites, then add the new handler.

**Implementation**:

1. Remove from `_getPromptsConfig` return object (line 2360):
```typescript
// Remove:
splitPlan: plannerConfig?.addons?.splitPlan ?? false,
```

2. Remove from all consumer sites that pass `promptsConfig.splitPlan` (lines 2253, 2584, 2692, 5973):
```typescript
// Remove at each site:
splitPlan: role === 'planner' ? promptsConfig.splitPlan : undefined,
// and at line 2692:
splitPlan: promptsConfig.splitPlan,
```

3. Add `case 'splitterSelected'` handler after `case 'julesSelected'` (after line 5326), mirroring the `julesSelected` guard pattern:
```typescript
case 'splitterSelected': {
    const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
    if (!workspaceRoot || !Array.isArray(msg.sessionIds) || msg.sessionIds.length === 0) {
        vscode.window.showWarningMessage('Please select at least one plan to split.');
        break;
    }
    const visibleAgents = await this._getVisibleAgents(workspaceRoot);
    if (visibleAgents.splitter === false) {
        vscode.window.showWarningMessage('Splitter agent is currently disabled in setup.');
        break;
    }
    const eligibleSessionIds = await this._getEligibleSessionIds(msg.sessionIds, 'PLAN REVIEWED', workspaceRoot);
    if (eligibleSessionIds.length === 0) {
        vscode.window.showWarningMessage('No selected plans are currently in the Planned column.');
        break;
    }
    await vscode.commands.executeCommand(
        'switchboard.triggerBatchAgentFromKanban',
        'splitter',
        eligibleSessionIds,
        undefined,
        workspaceRoot
    );
    await this._refreshBoard(workspaceRoot);
    vscode.window.showInformationMessage(`Dispatched ${eligibleSessionIds.length} plan(s) to Splitter.`);
    break;
}
```

---

### `src/services/TaskViewerProvider.ts` — Remove all splitPlan references

**Context**: `splitPlan` appears at lines 6069, 6095, 6203, 12717, 12734, 14756. The `_isSplitPlanEnabled()` helper lives at lines 14176-14180.

**Logic**: Remove all references and the helper method.

**Implementation**:

1. Remove `const splitPlan = this._isSplitPlanEnabled();` and its usage `splitPlan,` (lines 6069, 6095):
```typescript
// Remove line 6069:
const splitPlan = this._isSplitPlanEnabled();
// Remove line 6095 (in the options object):
splitPlan,
```

2. Remove `if (addons?.splitPlan) prompt += '\n\n' + SPLIT_PLAN_DIRECTIVE;` (line 6203):
```typescript
// Remove this line entirely
```

3. Remove duplicate occurrence at lines 12717-12734 (same pattern as 6069/6095):
```typescript
// Remove line 12717:
const splitPlan = this._isSplitPlanEnabled();
// Remove line 12734:
splitPlan,
```

4. Remove `splitPlan: this._isSplitPlanEnabled()` (line 14756):
```typescript
// Remove this line from the options object
```

5. Remove `_isSplitPlanEnabled()` helper method (lines 14176-14180):
```typescript
// Remove this method:
private _isSplitPlanEnabled(): boolean {
    const plannerConfig: any = this.getSetting('switchboard.prompts.roleConfig_planner', undefined);
    if (plannerConfig?.addons?.splitPlan !== undefined) return plannerConfig.addons.splitPlan;
    return false;
}
```

6. If `SPLIT_PLAN_DIRECTIVE` is no longer imported by `TaskViewerProvider.ts` after step 2 is complete, remove it from the import at line 38.

**Clarification**: The `buildCustomAgentPrompt` call at line 6203 is the only place `TaskViewerProvider` injects `SPLIT_PLAN_DIRECTIVE` via the custom-agent addon path. This is separate from the splitter agent's own built-in prompt (in `agentPromptBuilder.ts`), which must remain intact.

## Verification Plan

### Manual Verification
1. Open the Kanban board with the splitter agent enabled in setup — verify the splitter button appears in the PLAN REVIEWED column header.
2. Disable the splitter agent in setup — verify the splitter button disappears from the column header.
3. Select one or more plans in PLAN REVIEWED and click the splitter button — verify `triggerBatchAgentFromKanban` is called for the selected session IDs only.
4. Click the splitter button with no plans selected — verify the warning `"Please select at least one plan to split."` appears and no agent is dispatched.
5. Open the Prompts tab for the Planner role — verify the "Split Plan" addon checkbox is no longer present.
6. Open the Agents tab — verify the Splitter Agent is still listed and configurable.
7. Trigger a planner prompt (copy or advance) — verify `SPLIT_PLAN_DIRECTIVE` is NOT included in the output.
8. Trigger a splitter agent prompt — verify `SPLIT_PLAN_DIRECTIVE` IS still present (the splitter's own logic is unchanged).

### Automated Tests
- Verify existing splitter agent prompt builder tests still pass (the `splitter` role path in `agentPromptBuilder.ts` is unchanged).
- Verify planner prompt generation tests pass without `splitPlan` option.
- Verify column button action tests (jules, re-plan) still work correctly (no regressions from adjacent code).

## Risks
- **Low risk overall**: This is a UI refactoring that moves splitter invocation from planner addon to column button.
- **Backward compatibility**: Plans with `splitPlan: true` in `state.json` will silently ignore the setting after this change (splitter must be invoked via button). No migration required.
- **User workflow**: Users must now explicitly click the splitter button instead of enabling the addon before planning. This is intentional UX improvement.

## Files Changed
- `src/webview/kanban.html` — Add splitter button to PLAN REVIEWED column header (after line 3168 for icon, after rePlanBtn in buttonArea)
- `src/webview/sharedDefaults.js` — Remove `splitPlan` from planner `ROLE_ADDONS` (line 67) and default addons object (line 20)
- `src/services/agentPromptBuilder.ts` — Remove `splitPlan` from `PromptBuilderOptions` interface and planner injection path (lines 96, 276, 368-370); preserve `SPLIT_PLAN_DIRECTIVE` and splitter role builder
- `src/services/KanbanProvider.ts` — Remove `splitPlan` from `_getPromptsConfig` return and all consumer sites (lines 2253, 2360, 2584, 2692, 5973); add `splitterSelected` handler
- `src/services/TaskViewerProvider.ts` — Remove all `splitPlan` references (lines 6069, 6095, 6203, 12717, 12734, 14756) and `_isSplitPlanEnabled()` helper (lines 14176-14180); remove `SPLIT_PLAN_DIRECTIVE` import if no longer used

---

**Recommendation**: Send to Coder
