# Fix Orchestrate Button: Add Clear Tooltip and Reflect Orchestrator Agent Configuration State

## Goal

Make the Orchestrate button in the Epics tab communicate (1) what it does via a clear, descriptive tooltip, and (2) whether an orchestrator agent is actually configured via its visual state — dimmed/secondary when no orchestrator agent is set up, teal/active only when one is. Currently the button always renders with a teal accent border regardless of orchestrator configuration, misleading the user into thinking orchestration is ready when it is not.

### Problem analysis & root cause

The Orchestrate button is rendered in `renderEpicMetaBar` (`project.js:1354`):

```javascript
<button class="strip-btn" id="btn-epic-orchestrate" style="border-color: var(--accent-teal);" title="Assemble the orchestrator prompt for this epic and copy it">Orchestrate</button>
```

Two problems:

1. **Tooltip is unclear.** The `title` attribute says "Assemble the orchestrator prompt for this epic and copy it" — but the user doesn't know what "orchestrate" means in this context. It doesn't explain that it hands the whole epic to a single orchestrator agent that uses native subagents, nor that it copies the prompt if no orchestrator terminal exists. The user reports: "I am not sure what it does."

2. **Always looks active.** The button has `border-color: var(--accent-teal)` hardcoded — a teal accent that visually signals "primary/active action." But the orchestrator agent is **hidden by default** (`orchestrator: false` in `getVisibleAgents` defaults at `TaskViewerProvider.ts:3616`). The project.js webview **never receives agent visibility info** (confirmed: no `visibleAgents` or `startupCommands` handler in `project.js`), so it cannot know whether an orchestrator terminal is configured. The button looks ready even when no orchestrator agent is set up, which is the user's complaint: "it shows as active even though I have not set any orchestration agent."

**Root cause:** The epic-orchestration-onramp plan (Phase 2) added the Orchestrate button with a static teal style and a terse tooltip, without wiring it to backend agent-configuration state. The webview has no data about orchestrator availability.

## Metadata

- **Tags:** `feature`, `ui`, `backend`, `epics-tab`
- **Complexity:** 3/10 (one new backend method + one field in an existing message + conditional button styling)

## Complexity Audit

### Routine
- Expanding the `title` attribute on the Orchestrate button — pure HTML/JS string change.
- Conditionally applying the teal border vs. a dimmed style based on a boolean flag — simple CSS class toggle.
- Adding `orchestratorAvailable` to the existing `kanbanPlansReady` message payload (`PlanningPanelProvider.ts:2557-2564`) — one extra field.

### Complex / Risky
- **New public method on KanbanProvider** to check orchestrator availability — must access `this._taskViewerProvider?.getVisibleAgents()` (private field) and `getStartupCommands()`. The method must be safe to call when `_taskViewerProvider` is undefined (returns false).
- **State sync timing** — `kanbanPlansReady` is sent on plan list refresh. If the user enables the orchestrator agent in the kanban Agents tab after the Epics tab loaded, the button state won't update until the next `kanbanPlansReady` message. This is acceptable (the user can refresh by switching tabs), but a re-send on webview visibility change would be ideal.

## Edge-Case & Dependency Audit

- **No orchestrator terminal configured:** Button renders dimmed with tooltip explaining the user needs to enable the Orchestrator agent in the kanban Agents tab. Clicking still works (copies the prompt — the backend's `dispatchEpicOrchestration` already handles missing terminals gracefully by copying instead, per `PlanningPanelProvider.ts:2871-2878`).
- **Orchestrator visible but no startup command:** Button renders dimmed — the orchestrator is enabled but has no CLI command configured, so dispatch will fail. Check both visibility AND startup command presence.
- **`_taskViewerProvider` is null:** `isOrchestratorAvailable()` returns false — safe fallback.
- **Standalone epic documents:** The Orchestrate button is already hidden for standalone epics (`isManageable` guard at `project.js:1351`). No change needed.
- **No confirmation dialogs** (project rule) — not applicable (this is a visual/tooltip fix).
- **Button still works when dimmed:** The button is NOT disabled — it is visually de-emphasized to signal "no agent configured," but clicking it still copies the prompt (the backend always copies, dispatch is optional). This matches the existing fallback behavior.

## Proposed Changes

### `src/services/KanbanProvider.ts` — New public method

**1. Add `isOrchestratorAvailable` method (near `dispatchEpicOrchestration` at line 3037):**

```typescript
/**
 * Returns true if the orchestrator agent is both visible (enabled) and has
 * a startup command configured. Used by the Epics tab to style the
 * Orchestrate button to reflect whether dispatch will succeed.
 */
public async isOrchestratorAvailable(workspaceRoot?: string): Promise<boolean> {
    if (!this._taskViewerProvider) { return false; }
    try {
        const visibleAgents = await this._taskViewerProvider.getVisibleAgents(workspaceRoot);
        if (!visibleAgents?.orchestrator) { return false; }
        const commands = await this._taskViewerProvider.getStartupCommands(workspaceRoot);
        return !!(commands?.orchestrator && commands.orchestrator.trim());
    } catch {
        return false;
    }
}
```

### `src/services/PlanningPanelProvider.ts` — Include orchestrator availability in `kanbanPlansReady`

**2. Add `orchestratorAvailable` to the `kanbanPlansReady` message (line 2557-2564):**

```typescript
this._projectPanel?.webview.postMessage({
    type: 'kanbanPlansReady',
    plans: allPlans,
    workspaceItems,
    allWorkspaceProjects,
    columns: mergedColumns,
    requestId,
    orchestratorAvailable: this._kanbanProvider
        ? await this._kanbanProvider.isOrchestratorAvailable()
        : false
});
```

> **Note:** Also add `orchestratorAvailable: false` to the error branch at line 2567 for consistency.

### `src/webview/project.js` — Store orchestrator availability and style the button

**3. Add a state variable (near other state variables, ~line 167):**

```javascript
let _orchestratorAvailable = false;
```

**4. Update the state from `kanbanPlansReady` handler (in the message listener that processes `kanbanPlansReady`):**

```javascript
// Inside the kanbanPlansReady handler
_orchestratorAvailable = !!msg.orchestratorAvailable;
```

**5. Update `renderEpicMetaBar` to use the flag (line 1354):**

Replace the static Orchestrate button:

```javascript
// OLD:
<button class="strip-btn" id="btn-epic-orchestrate" style="border-color: var(--accent-teal);" title="Assemble the orchestrator prompt for this epic and copy it">Orchestrate</button>

// NEW:
<button class="strip-btn" id="btn-epic-orchestrate" style="${_orchestratorAvailable ? 'border-color: var(--accent-teal);' : 'opacity: 0.6; border-color: var(--border-color);'}" title="${_orchestratorAvailable ? 'Hand this epic to one orchestrator agent that runs all subtasks end-to-end with native subagents. Copies the prompt and dispatches to the orchestrator terminal.' : 'Hand this epic to one orchestrator agent that runs all subtasks end-to-end. No orchestrator agent is configured yet — clicking copies the prompt. Enable the Orchestrator agent in the kanban Agents tab to dispatch directly.'}">Orchestrate</button>
```

**6. Re-render the meta-bar when `kanbanPlansReady` arrives (if an epic is selected):**

After setting `_orchestratorAvailable`, if `_epicSelectedPlan` exists, call `renderEpicMetaBar(_epicSelectedPlan)` to update the button style in place:

```javascript
_orchestratorAvailable = !!msg.orchestratorAvailable;
if (_epicSelectedPlan) renderEpicMetaBar(_epicSelectedPlan);
```

## Verification Plan

> Manual verification against an installed VSIX (per project norm).

### Manual Verification

1. **No orchestrator configured (default state):** Open the Epics tab, select a DB-backed epic → the Orchestrate button is dimmed (opacity 0.6, default border color). Hover shows the long tooltip explaining what it does and that no orchestrator is configured.
2. **Orchestrator configured:** Enable the Orchestrator agent in the kanban Agents tab (check the visibility checkbox, enter a startup command) → return to the Epics tab, refresh → the Orchestrate button is teal/active. Hover shows the tooltip explaining it dispatches to the orchestrator terminal.
3. **Click when dimmed:** Click the dimmed Orchestrate button → the orchestration overlay opens with the assembled prompt, and a toast says "Orchestrator prompt copied" (no terminal dispatch since none is configured). The button still works — it is NOT disabled.
4. **Click when active:** Click the active Orchestrate button → the prompt is dispatched to the orchestrator terminal and copied.
5. **Tooltip clarity:** The tooltip clearly explains what "Orchestrate" means: "Hand this epic to one orchestrator agent that runs all subtasks end-to-end with native subagents."
6. **State updates on refresh:** After toggling orchestrator visibility in the Agents tab, switching to the Epics tab and back (or triggering a plan refresh) updates the button style correctly.
7. **No regression:** The +Subtask and Delete Epic buttons in the meta-bar are unaffected.
