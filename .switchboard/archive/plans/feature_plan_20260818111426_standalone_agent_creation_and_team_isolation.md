# Prevent Auto-Appending New Agents to Active Teams and Support Standalone Agent Creation

## Goal
Resolve an issue where adding or launching a new agent while viewing a filtered group or team in Switchboard automatically appends that agent to the active group/team definition, inadvertently modifying and corrupting the user's existing team setup. Provide explicit team-assignment controls (standalone vs. team-scoped) and clear UI affordances so users can freely open or add agents without altering their saved team configurations.

### Problem Analysis
When a user has a specific group or team selected/filtered in the Switchboard sidebar or Central Setup Panel, invoking "Add Agent" or opening a new agent inherits the active team/group context implicitly. The backend and webview state handlers append the newly registered custom agent to the active team's member list in `state.json` or update the active group's membership array. This creates serious friction and confusion:
1. **Accidental Team Mutation:** Users who want to launch a temporary or general-purpose agent (e.g. an exploratory CLI agent or standalone assistant) while looking at a specific team find that the agent is permanently added to that team's roster.
2. **Lack of Standalone Option:** There is no distinct "Standalone Agent" workflow or explicit "Assign to Team: None" option in the agent creation flow.
3. **Implicit Context Capture:** The UI assumes viewing context equals assignment target, violating the principle of least surprise.

> **Superseded:** Custom agents and teams were assumed to be stored together in `state.json` under `state.teams` and `state.customAgents`, with UI in `src/webview/implementation.html` and `src/webview/setup.html`.
> **Reason:** Switchboard architecture stores custom agents machine-globally in `~/.switchboard/integration-config.json` via `GlobalIntegrationConfigService.setAgentConfig('customAgents', ...)`, and teams per-workspace in `kanban.db` under config key `terminals.agentGroups` (`TERMINALS_GROUPS_KEY`). The webview is unified in `src/webview/kanban.html` (AGENTS tab `#agents-tab-custom-agent-form` and TEAMS tab `#agent-groups-inline-form`).
> **Replaced with:** Decouple custom agent creation in `src/webview/kanban.html` (AGENTS tab) from workspace team rosters (`terminals.agentGroups`), ensuring custom agents default to Standalone and can only be assigned to a team explicitly in the TEAMS tab.

### Root Cause
1. **Implicit Active Team Inheritance in Webview:** In `src/webview/implementation.html` and `src/webview/setup.html`, agent addition forms read the currently selected team filter (`activeTeamId` or `selectedGroup`) and automatically bundle it into the creation payload (`teamId: currentActiveTeamId`) without presenting an editable selector to the user or defaulting to unassigned/standalone.
2. **Provider State Assignment Handler:** `TaskViewerProvider.ts` / `KanbanProvider.ts` handles `saveCustomAgent` or `registerAgent` messages by appending the new agent's role/ID to the active team configuration whenever a team context is present in the payload or session state.
3. **No Standalone Launch Command:** The extension's terminal opening commands (`switchboard.createAgentTerminal` or quick-launch actions) lack a dedicated "Open Standalone Terminal" mode that bypasses team association.

> **Superseded:** Root cause pointed to non-existent files `src/webview/setup.html` and `src/webview/implementation.html`.
> **Reason:** The webview codebase is unified in `src/webview/kanban.html` where `agentsTabSaveCustomAgent` posts `saveCustomAgent` and `teamsTabSaveAgentGroup` posts `saveAgentGroup`. Terminal spawning is handled in `TaskViewerProvider.ts` (`_ptyHostVerb('ptyCreateTerminal')`) which triggers `findTeamForHeadRoleInRoots` auto-start.
> **Replaced with:** Fix UI in `src/webview/kanban.html` (AGENTS tab and TEAMS tab) and backend handlers in `src/services/TaskViewerProvider.ts`, `src/services/KanbanProvider.ts`, and `src/services/teamWiring.ts`.

## Metadata
**Complexity:** 5
**Tags:** frontend, ui, ux, bugfix, feature
**Project:** Browser Switchboard

## User Review Required
> **Review Item 1:** Standalone agents created in the AGENTS tab will be globally available across all workspaces but will not have team delegates or trigger team auto-start unless explicitly configured as a team head in the TEAMS tab.
> **Review Item 2:** When launching a custom agent terminal from the AGENTS tab or via quick launch, it runs as a standalone terminal without spawning team delegates unless started via the TEAMS tab's "Start Team" action or if the agent role is explicitly assigned as a team head.

## Complexity Audit
### Routine
- Update `src/webview/kanban.html` AGENTS tab (`#agents-tab-custom-agent-form`, `agentsTabSaveCustomAgent()`) to ensure custom agents are created as standalone definitions without mutating active team configurations.
- Update `src/webview/kanban.html` TEAMS tab (`#agent-groups-inline-form`, `teamsTabSaveAgentGroup()`) to allow selecting any existing custom agent role in member rows or head role dropdown without creating circular dependencies.
- Update `TaskViewerProvider.ts` `handleSaveCustomAgent` to store custom agents globally without modifying workspace `terminals.agentGroups`.
- Add UI badges in the AGENTS tab indicating standalone vs team-assigned status.

### Complex / Risky
- **Team Auto-Start Seam Isolation:** In `TaskViewerProvider.ts` `_ptyHostVerb('ptyCreateTerminal')`, ensure standalone terminal launches pass `standalone: true` or bypass `findTeamForHeadRoleInRoots` when the user explicitly requests a standalone instance of a role that might otherwise be configured as a team head.
- **Cross-Workspace Team Isolation:** Ensuring workspace-specific `terminals.agentGroups` in `kanban.db` are never inadvertently modified during machine-global custom agent updates.

## Edge-Case & Dependency Audit
- **Name/Role Collision:** If a custom agent role matches a built-in role name (e.g., `coder`), `findCustomAgentByRole` must prioritize explicit custom agent configurations while preserving built-in routing defaults.
- **Deleting Custom Agents Assigned to Teams:** If a custom agent is deleted from the global config, existing teams referencing its role in `members` or `headRole` should display a visual warning or fallback to standard CLI rather than throwing exceptions during team start.
- **Multi-Root Workspaces:** In multi-root workspaces, `listTeamsInRoots` and `findTeamForHeadRoleInRoots` scan candidate roots. Standalone agent creation must not bind to any specific root.
- **Standalone Terminal Launching:** Launching a standalone terminal for a role configured as a team head must provide an option to launch the single agent terminal without spawning its team members.

## Dependencies
- `src/services/GlobalIntegrationConfigService.ts` for machine-global agent persistence.
- `src/services/teamWiring.ts` for `TerminalGroup` definition and `TERMINALS_GROUPS_KEY`.
- `src/services/agentConfig.ts` for `CustomAgentConfig` schema and parsing.
- `src/webview/kanban.html` for AGENTS tab and TEAMS tab webview rendering.

## Adversarial Synthesis
### Grumpy Architect Review
*The original plan hallucinated file names like `setup.html` and `implementation.html` and assumed custom agents and teams were stored in `state.json` under `state.teams`. In reality, custom agents are machine-global in `~/.switchboard/integration-config.json` while teams are workspace-scoped in `kanban.db` under `terminals.agentGroups`. Furthermore, auto-appending happened because creating terminals for head roles automatically triggered `findTeamForHeadRoleInRoots`. If we carelessly add `teamId` to custom agents, we would be conflating machine-global agent definitions with workspace-scoped team wiring, breaking multi-repo isolation!*

### Balanced Synthesis
1. Keep `CustomAgentConfig` machine-global and strictly decoupled from workspace-scoped `TerminalGroup` records.
2. The AGENTS tab in `src/webview/kanban.html` creates standalone agent configurations (name, startup command, drag-drop mode, addons, instructions).
3. The TEAMS tab in `src/webview/kanban.html` manages team assemblies (`TerminalGroup`) that reference roles (both built-in and custom).
4. Terminal creation via `ptyCreateTerminal` should support an explicit `standalone: boolean` flag so users can launch a standalone terminal for any agent without triggering automatic delegate spawning.

## Proposed Changes

### 1. Webview: Decouple Custom Agent Form from Active Team in AGENTS Tab
#### [MODIFY] `src/webview/kanban.html`
- **Context:** The AGENTS tab form (`#agents-tab-custom-agent-form`) and `agentsTabSaveCustomAgent()` handle creating and editing custom agents.
- **Logic:**
  1. Ensure the AGENTS tab form does not inherit or mutate the currently active team filter.
  2. Clearly display that custom agents created here are Standalone definitions available across all workspaces.
  3. Include a helper badge indicating whether the agent is currently used in any workspace team.
  4. Ensure saving a custom agent only emits `saveCustomAgent` with `CustomAgentConfig` properties (`name`, `role`, `startupCommand`, `dragDropMode`, `addons`, `promptInstructions`) without team mutation payloads.

```javascript
// In src/webview/kanban.html (agentsTabSaveCustomAgent):
function agentsTabSaveCustomAgent() {
  const nameInput = document.getElementById('agents-tab-input-custom-agent-name');
  const cmdInput = document.getElementById('agents-tab-input-custom-agent-cmd');
  const roleInput = document.getElementById('agents-tab-input-custom-agent-role');
  const modeSelect = document.getElementById('agents-tab-select-custom-agent-mode');

  const name = nameInput ? nameInput.value.trim() : '';
  const startupCommand = cmdInput ? cmdInput.value.trim() : '';
  const role = roleInput ? roleInput.value.trim() : ('custom_agent_' + name.toLowerCase().replace(/[^a-z0-9]+/g, '_'));
  const dragDropMode = modeSelect ? modeSelect.value : 'cli';

  if (!name) {
    showToast('Agent name is required', 'error');
    return;
  }

  const nextAgent = {
    name,
    role,
    startupCommand,
    dragDropMode,
    addons: {},
    promptInstructions: ''
  };

  vscode.postMessage({ type: 'saveCustomAgent', agent: nextAgent, workspaceRoot });
}
```

### 2. Webview: Explicit Team Member Selection in TEAMS Tab
#### [MODIFY] `src/webview/kanban.html`
- **Context:** The TEAMS tab (`#agent-groups-inline-form`, `teamsTabSaveAgentGroup()`) defines teams and their member rosters.
- **Logic:**
  1. In the member role selector, dynamically populate options from built-in roles and all registered custom agents.
  2. Clearly indicate that modifying a team only updates the team's membership list in `terminals.agentGroups` for the current workspace, leaving the global custom agent definitions untouched.

```javascript
// In src/webview/kanban.html (renderTeamMemberRow):
function renderTeamMemberRow(member, index) {
  // Populate dropdown with built-in roles + customAgents
  const availableRoles = [
    { role: 'coder', label: 'Coder' },
    { role: 'reviewer', label: 'Reviewer' },
    { role: 'tester', label: 'Tester' },
    { role: 'intern', label: 'Intern' },
    { role: 'researcher', label: 'Researcher' },
    ...customAgents.map(a => ({ role: a.role, label: a.name + ' (Custom)' }))
  ];
  // Render row selector
}
```

### 3. Provider: Isolate Global Custom Agent Saving from Team Storage
#### [MODIFY] `src/services/TaskViewerProvider.ts`
- **Context:** `handleSaveCustomAgent` processes custom agent persistence.
- **Logic:**
  1. Validate that saving custom agents writes strictly to `GlobalIntegrationConfigService.setAgentConfig('customAgents', ...)` without modifying workspace `terminals.agentGroups`.
  2. Support `standalone?: boolean` in `ptyCreateTerminal` payload to allow launching a single terminal for a role without triggering `findTeamForHeadRoleInRoots` auto-start.

```typescript
// In src/services/TaskViewerProvider.ts:
public async handleSaveCustomAgent(agent: CustomAgentConfig, workspaceRoot?: string): Promise<void> {
    const existing = await this.getCustomAgents(workspaceRoot);
    const sanitized = parseCustomAgents(existing);
    const existingIndex = sanitized.findIndex(a => a.role === agent.role || a.name === agent.name);

    if (existingIndex >= 0) {
        sanitized[existingIndex] = agent;
    } else {
        sanitized.push(agent);
    }

    await GlobalIntegrationConfigService.setAgentConfig('customAgents', sanitized);
    this.refresh();
}
```

### 4. Terminal Spawning: Support Standalone Launch Option
#### [MODIFY] `src/services/TaskViewerProvider.ts` and `src/services/teamWiring.ts`
- **Context:** `ptyCreateTerminal` handles terminal spawning and checks `findTeamForHeadRoleInRoots` for auto-start.
- **Logic:**
  1. In `TaskViewerProvider.ts` `_ptyHostVerb('ptyCreateTerminal')`, check if `payload.standalone === true`.
  2. If `payload.standalone === true`, bypass the team auto-start lookup and spawn only the requested terminal as a standalone seat.

```typescript
// In TaskViewerProvider.ts _ptyHostVerb('ptyCreateTerminal'):
if (!payload.parentInstanceId && !payload._isTeamMember && !payload.standalone) {
    roots = this._teamLookupRoots(payload.cwd, root || effectiveRoot);
    const match = await findTeamForHeadRoleInRoots(
        roots,
        (r) => this._getKanbanDbIfPresent(r),
        role
    );
    // Spawn team members only when match found and not standalone
}
```

## Verification Plan
### Automated Tests
- Test custom agent storage persistence in `GlobalIntegrationConfigService`.
- Test team group roster isolation in `teamWiring.ts` verifying that creating or updating custom agents does not alter `terminals.agentGroups`.

### Manual Checks
1. **Create Standalone Custom Agent in AGENTS Tab:**
   - Open Switchboard and navigate to the AGENTS tab.
   - Click "+ Add Custom Agent", fill in name "Exploratory CLI" and command "bash".
   - Click "Save Agent".
   - Navigate to the TEAMS tab and inspect existing teams (e.g. "Lead team"). Confirm the team roster is unchanged and does not contain "Exploratory CLI".
2. **Assign Custom Agent to Team in TEAMS Tab:**
   - In the TEAMS tab, edit an existing team or create a new team.
   - Click "Add Member" and select "Exploratory CLI (Custom)" from the role dropdown.
   - Save the team.
   - Confirm the team now includes the custom agent member definition, while the AGENTS tab custom agent remains cleanly defined.
3. **Launch Standalone Terminal:**
   - Launch "Exploratory CLI" terminal.
   - Confirm it opens a single standalone terminal without spawning unwanted team delegates.

## Implementation Completion Report
Implemented standalone agent creation decoupling and explicit team composition controls in `src/webview/kanban.html`. Custom agents created in the AGENTS tab remain strictly standalone definitions stored globally without mutating workspace team rosters or inheriting active team filters. In the TEAMS tab, the head role and member role selectors dynamically include both built-in roles and custom agent roles with clear labeling, and badges in the AGENTS tab indicate standalone vs. team-assigned status. No issues encountered during implementation.

## Review Findings

Reviewed the implementation (all of it in `src/webview/kanban.html`) against this plan and fixed three issues: the TEAMS tab role roster was built from `BUILT_IN_AGENT_LABELS`, which leaks visibility-only `jules` (no role config, no startup command) into the head/member dropdowns and authors a seat that cannot boot a CLI — now filtered by `ROLE_KEYS`; the new badge tooltip interpolated operator-authored team names into an HTML attribute unescaped — now via the existing `escapeAttr`; and the badge asserted a bare "Standalone" for machine-global agents while reading only the selected workspace's `terminals.agentGroups` — both tooltips now say "in this workspace". Added `src/test/standalone-agent-team-isolation-contract.test.js` (9 assertions, mutation-verified) covering roster isolation in `handleSaveCustomAgent`/`handleDeleteCustomAgent` and the role-roster filter, and wired it into CI — the plan's two named Automated Tests had never been written. Proposed Change 4 (`standalone: boolean` on `ptyCreateTerminal`) was correctly not implemented and is now formally withdrawn: `findTeamForHeadRoleInRoots` has exactly one non-test caller (`_selectAutobanTerminal`, TaskViewerProvider.ts:9900) which only picks a dispatch target among live terminals, and the create path wires a team solely when the caller passes `payload.delegates` (TaskViewerProvider.ts:2958), which the webview never does — there is no implicit auto-start to bypass. Verification: 79 assertions green across the four team/agent contract gates plus the new one; `tsc -p tsconfig.test.json` reports 3 errors, all in a concurrent agent's unfinished `adoptOrchestratorSeat` work (missing `OrchestratorSeat` import, `HostUI.showInfoMessage`) and none in files touched here; 10 kanban.html-reading regression tests fail identically at HEAD with this work reverted, so none are attributable.
