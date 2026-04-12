# Setup View Improvements

## Goal
Improve the setup view by making UI refinements:
1. Rename the "Project Management" accordion to "ClickUp, Linear and Notion Integration" for clearer labeling
2. Prevent auto-expanding the setup accordion when the webview opens
3. Add a new "Agents" accordion underneath the setup accordion that consolidates:
   - Prompt controls from the setup accordion
   - Agent visibility and CLI commands from the terminal operations sidebar panel
   - Default prompt overrides (moved from its own accordion into a new section header within the Agents accordion)
4. Remove the standalone "Default Prompt Overrides" accordion
5. Add explanatory text to the "Orchestration Framework Integration" accordion explaining it allows Switchboard to be a GUI for OpenCode, GitHub Squads and other multi-agent orchestration frameworks, with the team lead agent as the orchestration agent that receives instructions

## Metadata
**Tags:** frontend, UI
**Complexity:** 7

## User Review Required
> [!NOTE]
> - This is a layout and wiring refinement only. It should preserve the current saved state shape, existing webview message types, and current setup / onboarding behavior.
> - Clarification: keep the internal `project-mgmt` section key and related message payloads unchanged unless a concrete implementation point requires otherwise. Only user-facing labels and helper copy should change.
> - Clarification: keep `#jules-auto-sync-toggle` in `src/webview/implementation.html` for this pass unless implementation proves it must move. The request explicitly names the built-in agent visibility / CLI command block, not every Terminal Operations control.

## Background
The current implementation is split across two webviews:

- `src/webview/setup.html` currently contains:
  - an initially open `Setup` accordion (`#setup-toggle`, `#startup-fields`)
  - prompt controls (`#design-doc-toggle`, `#accurate-coding-toggle`, `#lead-challenge-toggle`, `#advanced-reviewer-toggle`, `#aggressive-pair-toggle`)
  - a standalone `Default Prompt Overrides` accordion (`#prompt-overrides-toggle`, `#prompt-overrides-fields`)
  - the existing `Project Management` accordion (`#project-mgmt-toggle`, `#project-mgmt-fields`)
  - the existing `Orchestration Framework Integration` accordion for Team Lead controls
- `src/webview/implementation.html` still owns the built-in agent visibility / CLI command rows in Terminal Operations via:
  - `.agent-visible-toggle`
  - `input[type="text"][data-role]`
  - the `createAgentGrid` save-and-launch path that reads those inputs before opening terminals
- `src/services/TaskViewerProvider.ts` already pushes the full setup-panel state on `ready` via `postSetupPanelState()`, including startup commands, visible agents, Team Lead routing settings, prompt toggles, git-ignore config, prompt overrides, DB path, and integration setup status.
- `src/services/SetupPanelProvider.ts` already routes the setup-panel message types needed for this work (`getStartupCommands`, `getVisibleAgents`, `getDefaultPromptOverrides`, `getTeamLeadRoutingSettings`, `getIntegrationSetupStates`, and the prompt-toggle getters). The plan should reuse those routes rather than inventing a new aggregate message.

## Complexity Audit

### Routine
- Rename the visible `Project Management` label in `src/webview/setup.html`.
- Remove the default-open `open` classes from the Setup accordion in `src/webview/setup.html`.
- Insert a new `Agents` accordion in `src/webview/setup.html`.
- Move the prompt-controls markup and the default-prompt-override summary/button into the new `Agents` accordion while preserving existing element IDs.
- Remove the built-in agent visibility / CLI command rows from `src/webview/implementation.html`.
- Update regression tests that assert setup-panel structure and Terminal Operations contents.

### Complex / Risky
- **Cross-webview state ownership:** `src/webview/implementation.html` currently reads built-in command / visibility inputs directly before saving and launching terminals. Once those rows move to `src/webview/setup.html`, the sidebar must rely on cached `lastStartupCommands` / `lastVisibleAgents` state instead of querying DOM that no longer exists.
- **Hydration drift:** moving the built-in agent rows into `src/webview/setup.html` is not only HTML movement. The setup-panel save path and setup-panel message handlers must also hydrate and persist those rows, or the UI will display defaults and overwrite saved state.
- **Accordion loading behavior:** prompt controls move out of the Setup accordion, so the current `bindAccordion('setup-toggle', ...)` refresh path becomes stale. The new `Agents` accordion must request the moved state instead.
- **Regression coupling:** this plan overlaps recently reviewed setup-panel work in `src/webview/setup.html`, `src/webview/implementation.html`, and the related regex-based tests. Small markup changes can easily break structural regression coverage if the plan does not call out the exact assertions to update.

## Edge-Case & Dependency Audit
- **Race Conditions:** `postSetupPanelState()` already pushes setup state on webview `ready`, and the new `Agents` accordion should request fresh state again on open. Do not rely on accordion-open timing alone; otherwise saving before opening the accordion can write defaults back into state.
- **Security:** No new secret storage or network path should be introduced. Token fields remain in the project-management section, and built-in CLI command fields continue to persist through the existing `saveStartupCommands` path.
- **Side Effects:** Removing `.agent-visible-toggle` and `input[data-role]` rows from `src/webview/implementation.html` without updating the `createAgentGrid` click handler will silently break terminal launching, because that path currently saves from those DOM nodes immediately before launch. Removing prompt controls from the Setup accordion without moving the corresponding fetch logic will also make the toggles render stale values.
- **Dependencies & Conflicts:** `get_kanban_state` shows this plan as the only active item in the New / Planned columns, so there are no active Kanban blockers. Historical overlap still exists with already reviewed plans that touched the same files:
  - `add_project_management_accordion_to_central_setup.md`
  - `feature_plan_20260411_014806_move_configuration_components_to_central_setup_panel.md`
  - `customize_default_prompts.md`
  - `feature_plan_20260411_021725_feature_plan_add_acceptance_tester_role.md`
  - `fix_team_lead_default_active_and_move_to_dedicated_accordion.md`
  
  These are not active dependencies under the planning rules, but they are merge-churn hotspots. The implementation must preserve their current behavior in:
  - `src/webview/setup.html`
  - `src/webview/implementation.html`
  - `src/test/setup-panel-migration.test.js`
  - `src/test/team-lead-visibility-defaults-regression.test.js`

## Implementation Breakdown

### Low Complexity / UI Wiring
1. Rename the visible Project Management label in `src/webview/setup.html`, and update any user-facing tooltip text in `src/webview/kanban.html` that still says "Project Management setup".
2. Remove the default-open setup state in `src/webview/setup.html` by deleting the `open` classes from `#setup-chevron` and `#startup-fields`.
3. Insert a new `Agents` accordion immediately after the Setup accordion in `src/webview/setup.html`.
4. Move the prompt-controls block and default-prompt-override summary/button into the Agents accordion while preserving existing IDs so the modal logic continues to work.
5. Remove the built-in agent visibility / CLI command rows from `src/webview/implementation.html`.
6. Update the setup-panel structural regression tests to match the new accordion layout.

### High Complexity / Integration Coordination
1. Update the setup-panel save path in `src/webview/setup.html` so it now collects:
   - built-in CLI command inputs from the new Agents accordion
   - built-in agent visibility checkboxes from the new Agents accordion
   - the existing Team Lead command / visibility / routing controls from Orchestration
   - custom-agent visibility from the existing custom-agent section
2. Update the setup-panel hydration path in `src/webview/setup.html` so `startupCommands` and `visibleAgents` messages populate the newly moved built-in rows instead of only Team Lead and prompt controls.
3. Update the sidebar launch path in `src/webview/implementation.html` so Terminal Operations launches from cached saved state (`lastStartupCommands`, `lastVisibleAgents`) rather than querying DOM rows that no longer exist there.
4. Keep the Orchestration accordion dedicated to Team Lead and explanatory copy. Do not accidentally fold Team Lead into the new Agents accordion; the dedicated orchestration setup is a reviewed behavior guarded by existing tests.

## Adversarial Synthesis

### Grumpy Critique
This draft was drifting toward classic webview cargo-culting: move some HTML around, sprinkle a new accordion ID on it, and pray the state sync gods do the rest. They will not.

The real trap is that Terminal Operations is not just "displaying" those CLI rows. It actively reads them inside the `createAgentGrid` launch path. If you remove that block from `src/webview/implementation.html` without rewriting the launch/save flow, the sidebar happily saves half-empty state and launches the wrong agent configuration. That is not a cosmetic bug; that is self-inflicted config corruption.

The second lazy assumption is the auto-expand behavior. The current codebase does not have some dramatic `DOMContentLoaded` auto-open routine to rip out. The setup accordion opens because the HTML ships with `class="open"` already applied. If the implementer hunts for a phantom event listener instead of removing the literal default-open classes, they will "fix" nothing and declare victory.

And please do not invent a heroic new `getAgentConfigStates` provider message because it sounds tidy. `TaskViewerProvider.postSetupPanelState()` already pushes the setup state buffet on `ready`, and `SetupPanelProvider.ts` already routes the granular messages you need. Adding another aggregate message here is how people create redundant plumbing, stale tests, and a future bug where two supposedly equivalent state payloads quietly disagree.

### Balanced Response
The implementation should treat this as a state-ownership refactor, not a markup shuffle.

The safest path is:
1. keep the existing state model and message contracts intact,
2. move only the relevant built-in rows and prompt sections into `src/webview/setup.html`,
3. teach `src/webview/setup.html` to save and hydrate those moved rows,
4. teach `src/webview/implementation.html` to stop querying removed DOM and rely on cached saved state instead.

That addresses the real failure modes without adding scope. The Project Management rename stays user-facing only, the setup accordion starts collapsed by default by removing the literal `open` classes, Team Lead remains in the dedicated Orchestration accordion, and the reviewed setup-panel provider plumbing stays single-sourced.

## Agent Recommendation

Send to Lead Coder

## Proposed Changes

### 1. Rename Project Management Accordion
#### [MODIFY] `src/webview/setup.html`

- **Context:** The visible accordion label is still `Project Management`, but the requested copy is `ClickUp, Linear and Notion Integration`.
- **Logic:**
  1. Update only the visible section label text inside `#project-mgmt-toggle`.
  2. Keep the internal IDs (`project-mgmt-toggle`, `project-mgmt-fields`, `project-mgmt-chevron`) and the `openSetupSection` payload key `project-mgmt` unchanged unless a concrete implementation point requires renaming them.
  3. Preserve the existing integration subsections and setup buttons exactly as-is.
- **Clarification:** Because the label becomes user-facing copy, update any visible tooltip or helper text elsewhere in the product that still tells the user to "open Project Management setup".

Change the accordion title from "Project Management" to "ClickUp, Linear and Notion Integration":

```html
<div class="startup-section">
    <div class="startup-toggle" id="project-mgmt-toggle">
        <div class="section-label">ClickUp, Linear and Notion Integration</div>
        <span class="chevron" id="project-mgmt-chevron">▶</span>
    </div>
    <!-- existing #project-mgmt-fields content stays under the same IDs -->
</div>
```

#### [MODIFY] `src/webview/kanban.html`

- **Context:** The Kanban integration buttons still surface user-facing tooltips that say "Project Management setup".
- **Logic:** Update only the tooltip copy; keep the existing `postKanbanMessage({ type: 'openSetupPanel', section: 'project-mgmt' })` behavior unchanged.
- **Implementation targets:**
  - `ClickUp sync error — open Project Management setup`
  - `Open Project Management setup`
  - `Linear sync error — open Project Management setup`

Recommended replacement copy:

```text
ClickUp sync error - open ClickUp, Linear and Notion Integration setup
Open ClickUp, Linear and Notion Integration setup
Linear sync error - open ClickUp, Linear and Notion Integration setup
```

### 2. Prevent Auto-Expanding Setup Accordion on Webview Open
#### [MODIFY] `src/webview/setup.html`

- **Context:** The current setup accordion is open by default because the HTML ships with `open` classes already applied.
- **Logic:**
  1. Remove `open` from `#setup-chevron`.
  2. Remove `open` from `#startup-fields`.
  3. Do not add any new auto-open behavior elsewhere.
  4. Keep the accordion binding itself (`bindAccordion('setup-toggle', 'startup-fields', 'setup-chevron', ...)`) intact.
  5. Once prompt controls move into Agents, narrow the Setup accordion refresh callback so it only requests data still owned by Setup (notably git-ignore state).

Current root cause to remove:

```html
<div class="startup-toggle" id="setup-toggle">
    <div class="section-label">Setup</div>
    <span class="chevron" id="setup-chevron">▶</span>
</div>
<div class="startup-fields" id="startup-fields" data-accordion="true">
```

- **Clarification:** The existing draft example about removing a `DOMContentLoaded` auto-expand listener is only a reference anti-pattern. The current codebase should be fixed by removing the default-open classes above, not by hunting for a nonexistent page-load expander.

Illustrative anti-pattern reference only:

```javascript
// Remove any auto-expand on page load
// document.addEventListener('DOMContentLoaded', () => {
//     // Auto-expand setup accordion
//     expandAccordion('setup-toggle');
// });
```

Ensure all accordions start in a collapsed state by default.

### 3. Add New "Agents" Accordion and Reorganize Content
#### [MODIFY] `src/webview/setup.html`

- **Context:** The built-in agent command / visibility rows still live in `src/webview/implementation.html`, while prompt controls and prompt overrides live in separate areas of `src/webview/setup.html`.
- **Logic:**
  1. Insert a new `Agents` accordion immediately after the Setup accordion.
  2. Move the prompt-controls block out of `#startup-fields` and into the new accordion.
  3. Copy the built-in agent visibility / CLI command rows from `src/webview/implementation.html` into the new accordion.
  4. Move the default-prompt-override summary/button from the standalone `Default Prompt Overrides` accordion into a subsection inside the new accordion.
  5. Keep Team Lead controls in `#orchestration-fields`; do not fold them into Agents.
  6. Preserve existing IDs and classes wherever possible so the current modal and save logic can be extended instead of rewritten.
  7. Keep `#custom-agent-list` and the custom-agent modal in the existing `Custom Agents` accordion; this request does not move custom agents.

Add a new "Agents" accordion underneath the setup accordion with the following structure:

```html
<div class="startup-section">
    <div class="startup-toggle" id="agents-toggle">
        <div class="section-label">Agents</div>
        <span class="chevron" id="agents-chevron">▶</span>
    </div>
    <div class="startup-fields" id="agents-fields" data-accordion="true">
        <div style="font-size: 10px; color: var(--text-secondary); margin: 10px 0 4px; font-family: var(--font-mono); letter-spacing: 1px;">
            Configure agent behavior, built-in agent visibility, and default prompts.
        </div>

        <div class="db-subsection">
            <div class="subsection-header">
                <span>Prompt Controls</span>
            </div>
            <!-- Move the existing prompt-control rows here, preserving:
                 #design-doc-toggle
                 #design-doc-status-line
                 #accurate-coding-toggle
                 #lead-challenge-toggle
                 #advanced-reviewer-toggle
                 #aggressive-pair-toggle -->
        </div>

        <div class="db-subsection">
            <div class="subsection-header">
                <span>Agent Visibility &amp; CLI Commands</span>
            </div>
            <!-- Copy the existing built-in rows from implementation.html and preserve:
                 .agent-visible-toggle
                 input[type="text"][data-role]
                 roles: planner, lead, coder, intern, reviewer, tester, analyst, jules (visibility only if retained) -->
            <div style="font-size: 9px; color: var(--text-secondary); margin-top: 6px; line-height: 1.3; font-style: italic;">
                Note: You must use the attached PRD or Notion integration. This compares the implementation against the overall spec to prevent scope drift.
            </div>
        </div>

        <div class="db-subsection">
            <div class="subsection-header">
                <span>Default Prompt Overrides</span>
            </div>
            <div style="font-size: 10px; color: var(--text-secondary); margin-bottom: 8px; line-height: 1.4;">
                Customize the default system prompts used by agents. These overrides apply globally unless specific agents have their own custom prompts configured.
            </div>
            <div id="default-prompt-override-summary" style="font-size:10px; color:var(--text-secondary); font-family:var(--font-mono); min-height:14px;"></div>
            <button id="btn-customize-default-prompts" class="secondary-btn w-full">CUSTOMIZE DEFAULT PROMPTS</button>
        </div>
    </div>
</div>
```

#### [MODIFY] `src/webview/setup.html` (Remove Prompt Controls from Setup Accordion)

- **Context:** Once prompt controls move to Agents, the Setup accordion should contain only setup-specific actions and the existing git-ignore controls.
- **Logic:** Remove the entire `PROMPT CONTROLS` label block and its associated rows from `#startup-fields`, but keep:
  - `#btn-initialize`
  - `#btn-connect-mcp`
  - `#btn-copy-mcp-config`
  - git-ignore UI
  - `#btn-save-startup`
  - `#btn-open-docs`

Remove the prompt controls section from the setup accordion since they are now in the Agents accordion.

#### [MODIFY] `src/webview/setup.html` (Remove Default Prompt Overrides Accordion)

- **Context:** The standalone `Default Prompt Overrides` accordion becomes redundant once its content is embedded inside Agents.
- **Logic:**
  1. Delete `#prompt-overrides-toggle`, `#prompt-overrides-chevron`, and `#prompt-overrides-fields`.
  2. Delete the associated `bindAccordion('prompt-overrides-toggle', ...)` block in the script.
  3. Keep the prompt-override modal, `PROMPT_ROLES`, save handler, preview loading, and modal buttons intact.

Remove the standalone "Default Prompt Overrides" accordion and its associated JavaScript binding.

#### [MODIFY] `src/webview/setup.html` (Save / hydrate / accordion wiring)

- **Context:** Moving built-in rows into setup requires matching script changes; otherwise the moved UI renders but never round-trips state.
- **Logic:**
  1. Add a new `bindAccordion('agents-toggle', 'agents-fields', 'agents-chevron', ...)` callback that reuses existing message types:
     - `getStartupCommands`
     - `getVisibleAgents`
     - `getDefaultPromptOverrides`
     - `getAccurateCodingSetting`
     - `getAdvancedReviewerSetting`
     - `getLeadChallengeSetting`
     - `getAggressivePairSetting`
     - `getDesignDocSetting`
  2. Narrow `bindAccordion('setup-toggle', ...)` so it only requests data still owned by Setup, especially `getGitIgnoreConfig`.
  3. Extend the existing `btn-save-startup` handler so it gathers built-in command inputs and built-in visibility toggles from the new Agents accordion before posting `saveStartupCommands`.
  4. Extend the existing `startupCommands` message handler so it populates the newly moved built-in command inputs in setup, not just `team-lead` and plan-ingestion fields.
  5. Extend the existing `visibleAgents` message handler so it populates the newly moved built-in checkboxes in setup, not just the Team Lead toggle and custom-agent list.
  6. Do not introduce a new aggregate provider message such as `getAgentConfigStates`; the existing message routes already cover the required state.

Correct setup binding shape:

```javascript
bindAccordion('agents-toggle', 'agents-fields', 'agents-chevron', () => {
    vscode.postMessage({ type: 'getStartupCommands' });
    vscode.postMessage({ type: 'getVisibleAgents' });
    vscode.postMessage({ type: 'getDefaultPromptOverrides' });
    vscode.postMessage({ type: 'getAccurateCodingSetting' });
    vscode.postMessage({ type: 'getAdvancedReviewerSetting' });
    vscode.postMessage({ type: 'getLeadChallengeSetting' });
    vscode.postMessage({ type: 'getAggressivePairSetting' });
    vscode.postMessage({ type: 'getDesignDocSetting' });
});
```

Save-handler implementation detail to add around the existing payload construction:

```javascript
const commands = {
    ...lastStartupCommands,
    'team-lead': teamLeadCommandInput?.value.trim() || ''
};
document.querySelectorAll('#agents-fields input[type="text"][data-role]').forEach(input => {
    const role = input.dataset.role;
    if (role) {
        commands[role] = input.value.trim();
    }
});

const visibleAgents = {
    ...lastVisibleAgents,
    ...getCustomVisibleAgentsPatch(),
    'team-lead': !!teamLeadVisibleToggle?.checked
};
document.querySelectorAll('#agents-fields .agent-visible-toggle').forEach(cb => {
    const role = cb.dataset.role;
    if (role) {
        visibleAgents[role] = cb.checked;
    }
});
```

Hydration implementation detail to add to the existing message handlers:

```javascript
case 'startupCommands': {
    lastStartupCommands = message.commands || {};
    document.querySelectorAll('#agents-fields input[type="text"][data-role]').forEach(input => {
        input.value = lastStartupCommands[input.dataset.role] || '';
    });
    if (teamLeadCommandInput) {
        teamLeadCommandInput.value = lastStartupCommands['team-lead'] || '';
    }
    break;
}

case 'visibleAgents':
    if (message.agents) {
        lastVisibleAgents = { ...lastVisibleAgents, ...message.agents };
        document.querySelectorAll('#agents-fields .agent-visible-toggle').forEach(cb => {
            const role = cb.dataset.role;
            if (role && role in lastVisibleAgents) {
                cb.checked = lastVisibleAgents[role];
            }
        });
        if (teamLeadVisibleToggle) {
            teamLeadVisibleToggle.checked = lastVisibleAgents['team-lead'] !== false;
        }
        renderCustomAgentConfigList();
    }
    break;
```

#### [MODIFY] `src/webview/implementation.html`

- **Context:** Terminal Operations should stop owning the built-in agent visibility / CLI command UI, but it still must be able to launch agents using the last saved state.
- **Logic:**
  1. Remove the `AGENT VISIBILITY & CLI COMMANDS` label block and the built-in rows that use:
     - `.agent-visible-toggle`
     - `input[type="text"][data-role]`
  2. Keep:
     - `#createAgentGrid`
     - `#btn-deregister-all`
     - `#btn-open-central-setup`
     - `#btn-easter-egg`
     - `#jules-auto-sync-toggle` (per scope clarification above)
  3. Update the `createAgentGrid` click handler to save using cached `lastStartupCommands` / `lastVisibleAgents` instead of querying removed DOM rows.
  4. Update the `startupCommands` and `visibleAgents` message handlers to stop iterating removed terminal-ops inputs / checkboxes. They should continue updating onboarding inputs and the local caches used by the agent list.
  5. Keep the existing `getStartupCommands`, `getVisibleAgents`, and `getCustomAgents` requests when Terminal Operations opens, because the sidebar still needs those values for rendering and launch behavior.

Remove the agent visibility and CLI commands section from the terminal operations sidebar panel since they are now in the Agents accordion in `setup.html`.

Required launch-path rewrite:

```javascript
const commands = {
    ...lastStartupCommands,
    'team-lead': lastStartupCommands['team-lead'] || ''
};
const visibleAgents = {
    ...lastVisibleAgents,
    'team-lead': lastVisibleAgents['team-lead'] !== false
};
const julesAutoSyncEnabled = !!document.getElementById('jules-auto-sync-toggle')?.checked;
vscode.postMessage({ type: 'saveStartupCommands', commands, visibleAgents, julesAutoSyncEnabled });
```

Startup/visibility handler cleanup:

```javascript
case 'startupCommands':
    if (message.commands) {
        lastStartupCommands = message.commands;
        const onboardingFields = {
            lead: document.getElementById('onboard-cli-lead'),
            coder: document.getElementById('onboard-cli-coder'),
            intern: document.getElementById('onboard-cli-intern'),
            reviewer: document.getElementById('onboard-cli-reviewer'),
            tester: document.getElementById('onboard-cli-tester'),
            planner: document.getElementById('onboard-cli-planner'),
            analyst: document.getElementById('onboard-cli-analyst')
        };
        Object.entries(onboardingFields).forEach(([role, input]) => {
            if (input) input.value = message.commands[role] || '';
        });
    }
    break;

case 'visibleAgents':
    if (message.agents) {
        lastVisibleAgents = { ...lastVisibleAgents, ...message.agents };
        document.querySelectorAll('.onboard-agent-toggle').forEach(cb => {
            const role = cb.dataset.role;
            if (role && role in lastVisibleAgents) cb.checked = lastVisibleAgents[role];
        });
        renderAgentList();
    }
    break;
```

### 4. Add Explanatory Text to Orchestration Framework Integration Accordion
#### [MODIFY] `src/webview/setup.html`

- **Context:** The existing Orchestration accordion is Team Lead-specific today, but the requested copy should explain the broader orchestration-framework concept without changing the actual control ownership.
- **Logic:**
  1. Add explanatory text at the top of `#orchestration-fields`, above the current Team Lead subsection label.
  2. Keep Team Lead controls in this accordion and keep their existing IDs unchanged.
  3. Do not move Team Lead into the new Agents accordion.

Add explanatory text at the top of the "Orchestration Framework Integration" accordion:

```html
<div class="startup-section">
    <div class="startup-toggle" id="orchestration-toggle">
        <div class="section-label">Orchestration Framework Integration</div>
        <span class="chevron" id="orchestration-chevron">▶</span>
    </div>
    <div class="startup-fields" id="orchestration-fields" data-accordion="true">
        <div style="font-size: 10px; color: var(--text-secondary); margin: 10px 0 4px; font-family: var(--font-mono); letter-spacing: 1px;">
            ORCHESTRATION FRAMEWORKS
        </div>
        <div style="font-size: 10px; color: var(--text-secondary); margin-bottom: 12px; line-height: 1.4;">
            This allows Switchboard to act as a GUI for OpenCode, GitHub Squads, and other multi-agent orchestration frameworks. The Team Lead agent is the orchestration-facing agent that receives instructions from those systems.
        </div>
        <div style="font-size: 10px; color: var(--text-secondary); margin: 10px 0 4px; font-family: var(--font-mono); letter-spacing: 1px;">
            TEAM LEAD (OPENCODE)
        </div>
        <!-- existing Team Lead controls remain here -->
    </div>
</div>
```

### 5. Regression Coverage for the New Layout
#### [MODIFY] `src/test/setup-panel-migration.test.js`

- **Context:** This is the most direct structural regression guard for the central setup panel.
- **Logic:**
  1. Update the setup-panel assertions so they require:
     - `id="agents-toggle"`
     - `id="agents-fields"`
     - `id="project-mgmt-fields"`
     - absence of `id="prompt-overrides-toggle"`
  2. Add a regex/assertion confirming the Setup accordion is not open by default anymore.
  3. Update the implementation-webview assertions so they confirm Terminal Operations no longer includes the built-in `.agent-visible-toggle` rows.
  4. Keep the existing assertions that confirm `btn-open-central-setup` still exists.

#### [MODIFY] `src/test/team-lead-visibility-defaults-regression.test.js`

- **Context:** This test guards the reviewed decision that Team Lead remains in its own orchestration-specific surface.
- **Logic:**
  1. Keep the current assertions that Team Lead is present in `#orchestration-fields`.
  2. Add or adjust assertions so the new Agents accordion does not accidentally become the Team Lead surface.

#### [MODIFY] `src/test/challenge-prompt-regression.test.js`

- **Context:** Prompt controls move from Setup to Agents, but their IDs stay the same.
- **Logic:** If any assertions implicitly depend on prompt controls being inside the Setup accordion, re-anchor them to the control IDs instead of the old accordion location.

#### [MODIFY] `src/test/plan-ingestion-config-regression.test.js`

- **Context:** The Setup accordion still owns plan-ingestion state and the shared `saveStartupCommands` button.
- **Logic:** Preserve the existing assertions that verify `planIngestionFolder` stays in the save payload after the prompt-controls move.

#### [MODIFY] `src/test/integration-auto-pull-regression.test.js`

- **Context:** The Kanban setup buttons still target `section: 'project-mgmt'`, but user-facing copy may change.
- **Logic:** Keep the regex that asserts the redirect target remains `project-mgmt`. Update only human-readable expectation strings if the test text itself should match the renamed visible label.

## Verification Plan

### Automated Tests
- `node src/test/setup-panel-migration.test.js`
- `node src/test/team-lead-visibility-defaults-regression.test.js`
- `node src/test/challenge-prompt-regression.test.js`
- `node src/test/plan-ingestion-config-regression.test.js`
- `node src/test/integration-auto-pull-regression.test.js`
- `npm run compile`

### Manual Verification Steps
1. Open the central setup panel and confirm the `Setup` accordion is collapsed on initial render.
2. Open `Setup` and confirm it contains init / MCP / git-ignore / save / docs controls, but no prompt-control block.
3. Open `Agents` and confirm it contains:
   - prompt controls
   - built-in agent visibility / CLI command rows
   - the default prompt override summary/button
4. Confirm the standalone `Default Prompt Overrides` accordion is gone.
5. Confirm `Orchestration Framework Integration` still contains Team Lead controls plus the new explanatory text.
6. Open the sidebar Terminal Operations section and confirm the built-in agent visibility / CLI command rows are gone, while the setup button and launch controls still work.
7. Save changed built-in agent commands in Setup, return to the sidebar, and verify `OPEN AGENT TERMINALS` launches using the updated commands.
8. Open the Kanban board integration buttons and verify they still open the setup panel to the `project-mgmt` section, but the visible setup label now reads `ClickUp, Linear and Notion Integration`.

## Implementation Order
1. Update `src/webview/setup.html` structure: collapse default Setup state, insert Agents accordion, move prompt controls, move prompt-override summary/button, add orchestration copy, rename visible project-management label.
2. Update `src/webview/setup.html` script: add Agents accordion refresh behavior, update Setup refresh behavior, extend save/hydration logic for moved built-in rows, remove the standalone prompt-overrides accordion binding.
3. Update `src/webview/implementation.html` markup to remove the built-in agent visibility / CLI command block.
4. Update `src/webview/implementation.html` script so Terminal Operations launches from cached state instead of removed DOM.
5. Update `src/webview/kanban.html` tooltip copy for the renamed integration section.
6. Update the regex-based regression tests to match the new layout and preserved Team Lead ownership.

## Success Criteria
- The setup webview opens with the `Setup` accordion collapsed by default.
- The visible `Project Management` label is replaced everywhere user-facing in this flow with `ClickUp, Linear and Notion Integration`.
- The new `Agents` accordion contains prompt controls, built-in agent visibility / CLI rows, and the default prompt override summary/button.
- The standalone `Default Prompt Overrides` accordion no longer exists.
- The sidebar Terminal Operations panel no longer renders the built-in agent visibility / CLI rows.
- Saving built-in agent command / visibility changes from Setup still persists correctly and Terminal Operations still launches with the saved values.
- Team Lead remains exclusively under `Orchestration Framework Integration`.

## Execution Notes

### Fixed Items
- Reviewer pass completed against the implemented setup-view changes.
- Confirmed the setup implementation already satisfies the plan's structural and state-wiring requirements:
  - Setup starts collapsed by default.
  - Agents owns prompt controls, built-in agent visibility / CLI commands, and default prompt overrides.
  - Team Lead remains under Orchestration Framework Integration.
  - Terminal Operations launches from cached saved state instead of removed built-in config DOM.
- Fixed related documentation drift in `README.md` so user instructions now reference `Setup → ClickUp, Linear and Notion Integration` instead of the removed `Project Management` label.

### Files Changed
- Reviewer fix:
  - `README.md`
- Reviewed implementation surfaces:
  - `src/webview/setup.html`
  - `src/webview/implementation.html`
  - `src/webview/kanban.html`
  - `src/test/setup-panel-migration.test.js`
  - `src/test/team-lead-visibility-defaults-regression.test.js`
  - `src/test/challenge-prompt-regression.test.js`
  - `src/test/plan-ingestion-config-regression.test.js`
  - `src/test/integration-auto-pull-regression.test.js`

### Validation Results
- `node src/test/setup-panel-migration.test.js` ✅
- `node src/test/team-lead-visibility-defaults-regression.test.js` ✅
- `node src/test/challenge-prompt-regression.test.js` ✅
- `node src/test/plan-ingestion-config-regression.test.js` ✅
- `node src/test/integration-auto-pull-regression.test.js` ✅
- `npm run compile` ✅

### Remaining Risks
- Regex-based tests can still fail on small markup-order changes even when behavior is correct.
- Manual UI walkthrough steps from the verification plan were not executed in this reviewer pass, so this result is based on static inspection plus automated verification.

### Unresolved Issues
- None. The internal `project-mgmt` key remains unchanged as required, while user-facing renamed copy is now consistent in the reviewed implementation and README.
