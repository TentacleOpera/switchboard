# Redesign Switchboard Status Bar Quick Actions into Sidebar Control Center

## Goal
Redesign the cluttered VS Code status bar quick action buttons into a cohesive, dedicated "Switchboard Controls" dashboard in the sidebar webview (`implementation.html`) to simplify visual clutter, improve aesthetics, and provide premium interactive feedback.

## Metadata
- **Tags:** frontend, UI, UX, testing, configuration
- **Complexity:** 5
- **Repo:** switchboard

## User Review Required
> [!IMPORTANT]
> - **Configuration Scope**: Configuration edits will target the workspace settings scope (`vscode.ConfigurationTarget.Workspace`), ensuring changes apply consistently to the workspace.
> - **Unified Status Bar Option**: The existing VS Code status bar toggles in `setup.html` and their functionality in `extension.ts` will remain fully intact, allowing users who prefer status bar items to still use them.

## Complexity Audit
### Routine
- Adding message handlers for `setPreventAgentFileOpeningSetting` and `clearAllTerminals` in `TaskViewerProvider.ts`.
- Appending the configuration state `preventAgentFileOpening` to `initialState` and `_postSidebarConfigurationState` payloads.
- Modifying `extension.ts` to broadcast changes to the webview.

### Complex / Risky
- Redesigning the HTML/CSS markup in `implementation.html` to completely replace `.quick-actions-section` without breaking existing references or UI layout (e.g. scroll containers, button event listeners).
- Maintaining real-time state synchronization when the user toggles the shield block setting from either the settings page, the status bar, or the sidebar.

## Edge-Case & Dependency Audit
- **Race Conditions**: A race condition can occur if the configuration setting is updated in the sidebar and the configuration listener triggers a broadcast back to the sidebar webview before the local state transition completes.
  - *Mitigation*: Ensure the webview UI update function (`updateAgentOpenGuardUI`) is idempotent and handles rapid toggle transitions gracefully.
- **Security**: Allowing arbitrary messages from the webview to execute terminal controls could be a vector for unintended actions.
  - *Mitigation*: Restrict incoming message actions in `TaskViewerProvider.ts` to only the pre-defined cases (`clearAllTerminals` and `setPreventAgentFileOpeningSetting`) and validate inputs strictly.
- **Side Effects**: Replacing the Quick Actions HTML container may break selectors if they target specific container hierarchies.
  - *Mitigation*: Retain original HTML IDs (`btn-quick-kanban`, `btn-quick-planning`, `btn-quick-setup`) and place the new elements in the same hierarchy.
- **Dependencies & Conflicts**: The `switchboard` workspace has multiple open folders/repos.
  - *Mitigation*: Verify workspace config matches correct target.

## Dependencies
None.

## Adversarial Synthesis
Key risks: Malformed messages from the webview, scope conflicts in multi-root workspaces, and broken ID references from replacing elements. Mitigations: Preserve existing element IDs, implement strict boolean type checks on message inputs, and verify configuration targets.

## Proposed Changes

### Extension Services

#### [MODIFY] [TaskViewerProvider.ts](file:///Users/patrickvuleta/Documents/GitHub/switchboard/src/services/TaskViewerProvider.ts)

- **Context**: State hydration and sidebar view configuration messages.
- **Logic**:
  - Add `preventAgentFileOpening: this.handleGetPreventAgentFileOpeningSetting()` inside `_sendInitialState()` message payload.
  - Add `preventAgentFileOpeningSetting` message dispatch in `_postSidebarConfigurationState()`.
  - In `resolveWebviewView()` message listener switch block, handle cases:
    - `setPreventAgentFileOpeningSetting`: Validate that `data.enabled` is a boolean, then call `this.handleSetPreventAgentFileOpeningSetting(data.enabled)`.
    - `clearAllTerminals`: Call `vscode.commands.executeCommand('switchboard.clearAllTerminals')`.

---

### Sidebar Frontend

#### [MODIFY] [implementation.html](file:///Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/implementation.html)

- **Context**: Sidebar styles, markup, and event listeners.
- **Implementation**:
  - Add custom styling classes `.control-panel-grid`, `.control-panel-btn`, `.guard-panel-container`, and `.file-guard-btn` in CSS (around line 91). Include hover effects (scaling, brightness shifts) and transition delays.
  - Replace the existing `.quick-actions-section` (lines 1827-1837) with the new control panel dashboard markup, including buttons for Kanban, Artifacts, Setup, Open Grid, Clear, Reset, and the File Guard shield toggle.
  - Bind click listeners in script (around line 2072) to post corresponding messages (`createAgentGrid`, `clearAllTerminals`, `deregisterAllTerminals`) to the backend.
  - Implement a JavaScript function `updateAgentOpenGuardUI(enabled)` that updates the File Guard button style, classes (`is-allowed` / `is-blocked`), shield icon, and label state.
  - Add configuration update handling in the webview message event listener (around line 2517):
    - Extract `preventAgentFileOpening` from `initialState`.
    - Catch `preventAgentFileOpeningSetting` messages and update UI via `updateAgentOpenGuardUI(message.enabled)`.

---

### Extension Core

#### [MODIFY] [extension.ts](file:///Users/patrickvuleta/Documents/GitHub/switchboard/src/extension.ts)

- **Context**: Main entry point configuration event subscription.
- **Logic**:
  - Within `vscode.workspace.onDidChangeConfiguration` (around line 1756), if `switchboard.preventAgentFileOpening` changes, call `taskViewerProvider.broadcastToWebviews({ type: 'preventAgentFileOpeningSetting', enabled: value })`.

## Verification Plan

### Automated Tests
- Build code using `npm run compile` to verify TypeScript compliance.
- Run `npm test` to check core regression suites.

### Manual Verification
1. Launch extension in VS Code.
2. Verify visual appearance of "Switchboard Controls" panel matches the premium design.
3. Test all sidebar controls (Autoban, Artifacts, Setup, Grid, Clear, Reset) and confirm execution.
4. Toggle "File Guard": Verify visual state changes immediately and synchronizes with the VS Code Status Bar shield indicator and settings workspace value.
5. Toggle settings/status bar shield: Verify the sidebar Control Center button updates instantly.

---
**Recommendation**: Send to Coder
