# Add Project Management Accordion to Central Setup Panel

## Goal
Add a "Project Management" accordion to the central setup panel that consolidates ClickUp, Linear, and Notion integration setup in one discoverable location. This eliminates the need for users to navigate through unexplained VS Code command palette prompts or hidden Kanban board buttons to configure external project management integrations.

## Metadata
**Tags:** frontend, backend, UI
**Complexity:** 5

## User Review Required
> [!NOTE]
> - This plan moves ClickUp and Linear setup from the Kanban board to the central setup panel.
> - Notion setup is added to the central setup panel (previously only available via command palette).
> - Clarification: the Kanban header buttons should become navigation shortcuts into the central setup panel, not the primary place where setup logic lives.
> - Clarification: do not reimplement the multi-step ClickUp and Linear wizards inside the webview; reuse the existing setup commands and services.
> - Existing users with configured integrations will continue to work without re-setup.
> - The Kanban board will retain sync status indicators, and the setup buttons will become redirects into the setup panel.
> - All three integrations will have consistent token/setup flows in one location.

## Background
Currently, external project management integrations have fragmented setup experiences:
- **ClickUp**: Setup button in Kanban board header (`kanban.html`), requires clicking "☁️ Setup ClickUp" button
- **Linear**: Setup button in Kanban board header (`kanban.html`), requires clicking "📐 Setup Linear" button  
- **Notion**: Only accessible via VS Code command palette (`switchboard.setNotionToken`), no UI entry point

This creates a poor user experience where:
1. Users must discover integration setup through different mechanisms (Kanban buttons vs command palette)
2. The setup flows are not self-documenting — users see buttons/prompts without context
3. Integration configuration is scattered across the UI
4. New users may never discover Notion integration exists

## Complexity Audit

### Routine
- Add new "Project Management" accordion section to `setup.html` with three subsections (ClickUp, Linear, Notion)
- Add token input fields with validation for each integration
- Add status indicators showing setup completion state
- Add message handlers in `SetupPanelProvider.ts` for token save and validation
- Update `TaskViewerProvider.ts` to push integration setup state to setup panel
- Repurpose ClickUp/Linear setup buttons in `kanban.html` as redirects while retaining sync status

### Complex / Risky
- **Message routing**: Setup panel must delegate token operations to existing sync services (`ClickUpSyncService`, `LinearSyncService`, `NotionFetchService`)
- **State synchronization**: When tokens are saved in setup panel, Kanban board must update its sync status indicators immediately
- **Backward compatibility**: Existing users with saved tokens must not lose configuration; the panel should detect and display existing setup state
- **Setup flow coordination**: ClickUp and Linear have multi-step setup wizards (workspace selection, list creation, state mapping) — these must be triggered from the setup panel and complete successfully
- **Notion token validation**: Notion requires API validation (`GET /v1/users/me`) to confirm token validity before marking as setup complete

## Edge-Case & Dependency Audit
- **Token storage**: All three integrations use VS Code SecretStorage for tokens — setup panel must use the same storage keys
- **Config persistence**: ClickUp and Linear have additional config files (`.switchboard/clickup-config.json`, `.switchboard/linear-config.json`) — setup panel must read these to determine setup completion
- **Notion config**: Notion has `.switchboard/notion-config.json` with `setupComplete` flag — panel must read this
- **Multi-workspace**: Each workspace can have different integration configs — panel must load config for the active workspace
- **Setup cancellation**: If user cancels mid-setup (e.g., during ClickUp workspace selection), panel must handle gracefully and not mark as partially configured
- **Network errors**: Token validation may fail due to network — panel should show error state but not prevent retry
- **Dependencies & Conflicts**: This plan depends on existing integration services being fully implemented (ClickUp, Linear, Notion foundation plans). The only active Planned-item overlap is `Design Comprehensive Test Suite for Notion, ClickUp, and Linear Integrations`; coordinate any setup-panel assertions, fixtures, or DOM snapshots if that plan reaches into the same files. No other New/Planned plan appears to target this UI surface directly.

## Implementation Breakdown

### Low Complexity / UI Wiring
- Add the Project Management accordion markup, descriptive copy, token fields, status labels, and error containers in `setup.html`.
- Add panel-open behavior that expands the Project Management section when invoked from the Kanban board.
- Add README wording that explains the new central entry point and the existing token requirements.

### High Complexity / Integration Coordination
- Wire the webview messages into `SetupPanelProvider.ts` and `TaskViewerProvider.ts` without duplicating the underlying ClickUp, Linear, or Notion setup logic.
- Keep SecretStorage keys and workspace config file reads aligned with the current integration implementations so existing users are not forced to reconfigure.
- Synchronize completion state back to the Kanban board so sync indicators stay accurate after setup completes or fails.

## Adversarial Review

### Grumpy Principal Engineer
This plan keeps pretending the hard part is HTML. It is not. ClickUp and Linear are multi-step setup flows with validation, API calls, and stateful orchestration; if you try to wedge that into a pretty accordion without reuse boundaries, you'll build a fragile duplicate setup system and a maintenance trap.

The other landmine is UX consistency. If the Kanban board loses its setup entry points outright, users will think you deleted the feature. If the setup panel does not open to the correct section, you've just moved the confusion around instead of removing it.

And the state story matters: if the panel saves a token but the Kanban indicators do not refresh immediately, the UI will lie. If the panel cannot reflect already-configured integrations on reopen, it will look broken even when the backend state is fine.

### Balanced synthesis
The plan should centralize discovery, not duplicate setup logic. Keep the accordion as the visible home for project management setup, but delegate the actual ClickUp and Linear wizards to the existing command and service layer so the complex setup steps remain single-sourced.

The Kanban buttons should be treated as entry shortcuts that open the setup panel to the Project Management accordion, preserving discoverability while moving the actual configuration surface into one place. Notion stays lightweight: token capture, validation, persistence, and status display.

To avoid stale UI state, the setup panel must request current integration status on open and after each setup attempt, and the board must refresh its indicators after success or failure.

## Agent Recommendation

Send to Coder

## Proposed Changes

### 1. Add Project Management Accordion to Setup Panel
#### [MODIFY] `src/webview/setup.html`

Add a new accordion section after "Database Operations":

```html
<div class="startup-section">
    <div class="startup-toggle" id="project-mgmt-toggle">
        <div class="section-label">Project Management</div>
        <span class="chevron" id="project-mgmt-chevron">▶</span>
    </div>
    <div class="startup-fields" id="project-mgmt-fields" data-accordion="true">
        <div style="font-size: 10px; color: var(--text-secondary); margin: 10px 0 4px; font-family: var(--font-mono); letter-spacing: 1px;">
            Configure external project management integrations for plan sync and import.
        </div>
        
        <!-- ClickUp Section -->
        <div class="db-subsection">
            <div class="subsection-header">
                <span>☁️ ClickUp</span>
                <span id="clickup-setup-status" style="margin-left:auto; font-size:9px; color:var(--text-secondary);">Not configured</span>
            </div>
            <div style="font-size: 10px; color: var(--text-secondary); margin-bottom: 8px; line-height: 1.4;">
                Sync plans to ClickUp tasks and import tasks from ClickUp.
            </div>
            <label class="startup-row" style="display:block; margin-top:6px;">
                <span style="display:block; margin-bottom:4px;">API Token</span>
                <input id="clickup-token-input" type="password" placeholder="Enter ClickUp API token" style="width:100%;">
            </label>
            <button id="btn-setup-clickup" class="action-btn w-full" style="margin-top: 8px;">SETUP CLICKUP</button>
            <div id="clickup-setup-error" style="min-height:16px; color: var(--accent-red); font-size: 10px; margin-top: 6px;"></div>
        </div>

        <!-- Linear Section -->
        <div class="db-subsection">
            <div class="subsection-header">
                <span>📐 Linear</span>
                <span id="linear-setup-status" style="margin-left:auto; font-size:9px; color:var(--text-secondary);">Not configured</span>
            </div>
            <div style="font-size: 10px; color: var(--text-secondary); margin-bottom: 8px; line-height: 1.4;">
                Sync plans to Linear issues and import issues from Linear.
            </div>
            <label class="startup-row" style="display:block; margin-top:6px;">
                <span style="display:block; margin-bottom:4px;">API Token</span>
                <input id="linear-token-input" type="password" placeholder="Enter Linear API token" style="width:100%;">
            </label>
            <button id="btn-setup-linear" class="action-btn w-full" style="margin-top: 8px;">SETUP LINEAR</button>
            <div id="linear-setup-error" style="min-height:16px; color: var(--accent-red); font-size: 10px; margin-top: 6px;"></div>
        </div>

        <!-- Notion Section -->
        <div class="db-subsection">
            <div class="subsection-header">
                <span>📝 Notion</span>
                <span id="notion-setup-status" style="margin-left:auto; font-size:9px; color:var(--text-secondary);">Not configured</span>
            </div>
            <div style="font-size: 10px; color: var(--text-secondary); margin-bottom: 8px; line-height: 1.4;">
                Fetch design documents from Notion pages for planner prompts.
            </div>
            <label class="startup-row" style="display:block; margin-top:6px;">
                <span style="display:block; margin-bottom:4px;">Integration Token</span>
                <input id="notion-token-input" type="password" placeholder="Enter Notion integration token (secret_... or ntn_...)" style="width:100%;">
            </label>
            <button id="btn-setup-notion" class="action-btn w-full" style="margin-top: 8px;">SAVE NOTION TOKEN</button>
            <div id="notion-setup-error" style="min-height:16px; color: var(--accent-red); font-size: 10px; margin-top: 6px;"></div>
        </div>
    </div>
</div>
```

Add accordion binding in the script section (after existing accordion bindings):

```javascript
bindAccordion('project-mgmt-toggle', 'project-mgmt-fields', 'project-mgmt-chevron', async () => {
    // Load integration setup states when accordion opens
    vscode.postMessage({ type: 'getIntegrationSetupStates' });
});
```

Add button handlers:

```javascript
// ClickUp setup
document.getElementById('btn-setup-clickup')?.addEventListener('click', async () => {
    const tokenInput = document.getElementById('clickup-token-input');
    const token = tokenInput?.value.trim();
    const errorDiv = document.getElementById('clickup-setup-error');
    const statusSpan = document.getElementById('clickup-setup-status');
    
    if (!token) {
        errorDiv.textContent = 'Token is required';
        return;
    }
    
    errorDiv.textContent = '';
    statusSpan.textContent = 'Setting up...';
    
    vscode.postMessage({ type: 'setupClickUp', token });
});

// Linear setup
document.getElementById('btn-setup-linear')?.addEventListener('click', async () => {
    const tokenInput = document.getElementById('linear-token-input');
    const token = tokenInput?.value.trim();
    const errorDiv = document.getElementById('linear-setup-error');
    const statusSpan = document.getElementById('linear-setup-status');
    
    if (!token) {
        errorDiv.textContent = 'Token is required';
        return;
    }
    
    errorDiv.textContent = '';
    statusSpan.textContent = 'Setting up...';
    
    vscode.postMessage({ type: 'setupLinear', token });
});

// Notion setup
document.getElementById('btn-setup-notion')?.addEventListener('click', async () => {
    const tokenInput = document.getElementById('notion-token-input');
    const token = tokenInput?.value.trim();
    const errorDiv = document.getElementById('notion-setup-error');
    const statusSpan = document.getElementById('notion-setup-status');
    
    if (!token) {
        errorDiv.textContent = 'Token is required';
        return;
    }
    
    if (!token.startsWith('secret_') && !token.startsWith('ntn_')) {
        errorDiv.textContent = 'Token must start with "secret_" or "ntn_"';
        return;
    }
    
    errorDiv.textContent = '';
    statusSpan.textContent = 'Validating...';
    
    vscode.postMessage({ type: 'setupNotion', token });
});
```

Add message handlers for integration state:

```javascript
case 'integrationSetupStates': {
    const clickupStatus = document.getElementById('clickup-setup-status');
    const linearStatus = document.getElementById('linear-setup-status');
    const notionStatus = document.getElementById('notion-setup-status');
    
    if (message.clickupSetupComplete) {
        clickupStatus.textContent = '✅ Configured';
        clickupStatus.style.color = 'var(--accent-green)';
    } else {
        clickupStatus.textContent = 'Not configured';
        clickupStatus.style.color = 'var(--text-secondary)';
    }
    
    if (message.linearSetupComplete) {
        linearStatus.textContent = '✅ Configured';
        linearStatus.style.color = 'var(--accent-green)';
    } else {
        linearStatus.textContent = 'Not configured';
        linearStatus.style.color = 'var(--text-secondary)';
    }
    
    if (message.notionSetupComplete) {
        notionStatus.textContent = '✅ Configured';
        notionStatus.style.color = 'var(--accent-green)';
    } else {
        notionStatus.textContent = 'Not configured';
        notionStatus.style.color = 'var(--text-secondary)';
    }
    break;
}

case 'clickupSetupResult': {
    const statusSpan = document.getElementById('clickup-setup-status');
    const errorDiv = document.getElementById('clickup-setup-error');
    
    if (message.success) {
        statusSpan.textContent = '✅ Configured';
        statusSpan.style.color = 'var(--accent-green)';
        errorDiv.textContent = '';
    } else {
        statusSpan.textContent = 'Setup failed';
        statusSpan.style.color = 'var(--accent-red)';
        errorDiv.textContent = message.error || 'Setup failed';
    }
    break;
}

case 'linearSetupResult': {
    const statusSpan = document.getElementById('linear-setup-status');
    const errorDiv = document.getElementById('linear-setup-error');
    
    if (message.success) {
        statusSpan.textContent = '✅ Configured';
        statusSpan.style.color = 'var(--accent-green)';
        errorDiv.textContent = '';
    } else {
        statusSpan.textContent = 'Setup failed';
        statusSpan.style.color = 'var(--accent-red)';
        errorDiv.textContent = message.error || 'Setup failed';
    }
    break;
}

case 'notionSetupResult': {
    const statusSpan = document.getElementById('notion-setup-status');
    const errorDiv = document.getElementById('notion-setup-error');
    
    if (message.success) {
        statusSpan.textContent = '✅ Configured';
        statusSpan.style.color = 'var(--accent-green)';
        errorDiv.textContent = '';
    } else {
        statusSpan.textContent = 'Setup failed';
        statusSpan.style.color = 'var(--accent-red)';
        errorDiv.textContent = message.error || 'Setup failed';
    }
    break;
}
```

### 2. Add Integration Setup Handlers to SetupPanelProvider
#### [MODIFY] `src/services/SetupPanelProvider.ts`

Add message cases:

```typescript
case 'getIntegrationSetupStates': {
    const states = await this._taskViewerProvider?.getIntegrationSetupStates();
    this._panel.webview.postMessage({ type: 'integrationSetupStates', ...states });
    break;
}
case 'setupClickUp': {
    const result = await this._taskViewerProvider?.handleSetupClickUp(message.token);
    this._panel.webview.postMessage({ type: 'clickupSetupResult', ...result });
    await vscode.commands.executeCommand('switchboard.refreshUI');
    break;
}
case 'setupLinear': {
    const result = await this._taskViewerProvider?.handleSetupLinear(message.token);
    this._panel.webview.postMessage({ type: 'linearSetupResult', ...result });
    await vscode.commands.executeCommand('switchboard.refreshUI');
    break;
}
case 'setupNotion': {
    const result = await this._taskViewerProvider?.handleSetupNotion(message.token);
    this._panel.webview.postMessage({ type: 'notionSetupResult', ...result });
    await vscode.commands.executeCommand('switchboard.refreshUI');
    break;
}
```

### 3. Add Integration Setup Methods to TaskViewerProvider
#### [MODIFY] `src/services/TaskViewerProvider.ts`

Add helper methods:

```typescript
public async getIntegrationSetupStates(): Promise<{
    clickupSetupComplete: boolean;
    linearSetupComplete: boolean;
    notionSetupComplete: boolean;
}> {
    const wsRoot = this._getWorkspaceRoot();
    if (!wsRoot) {
        return { clickupSetupComplete: false, linearSetupComplete: false, notionSetupComplete: false };
    }

    const clickupService = this._getClickUpService(wsRoot);
    const linearService = this._getLinearService(wsRoot);
    const notionService = this._getNotionService(wsRoot);

    const clickupConfig = await clickupService.loadConfig();
    const linearConfig = await linearService.loadConfig();
    const notionConfig = await notionService.loadConfig();

    return {
        clickupSetupComplete: clickupConfig?.setupComplete ?? false,
        linearSetupComplete: linearConfig?.setupComplete ?? false,
        notionSetupComplete: notionConfig?.setupComplete ?? false
    };
}

public async handleSetupClickUp(token: string): Promise<{ success: boolean; error?: string }> {
    try {
        const wsRoot = this._getWorkspaceRoot();
        if (!wsRoot) {
            return { success: false, error: 'No workspace open' };
        }

        // Store token via command to reuse existing setup logic
        await vscode.commands.executeCommand('switchboard.setClickUpToken', token);
        
        // Trigger the full setup wizard
        await vscode.commands.executeCommand('switchboard.setupClickUp');
        
        return { success: true };
    } catch (error: any) {
        return { success: false, error: error.message || 'Setup failed' };
    }
}

public async handleSetupLinear(token: string): Promise<{ success: boolean; error?: string }> {
    try {
        const wsRoot = this._getWorkspaceRoot();
        if (!wsRoot) {
            return { success: false, error: 'No workspace open' };
        }

        // Store token via command to reuse existing setup logic
        await vscode.commands.executeCommand('switchboard.setLinearToken', token);
        
        // Trigger the full setup wizard
        await vscode.commands.executeCommand('switchboard.setupLinear');
        
        return { success: true };
    } catch (error: any) {
        return { success: false, error: error.message || 'Setup failed' };
    }
}

public async handleSetupNotion(token: string): Promise<{ success: boolean; error?: string }> {
    try {
        const wsRoot = this._getWorkspaceRoot();
        if (!wsRoot) {
            return { success: false, error: 'No workspace open' };
        }

        const notionService = this._getNotionService(wsRoot);
        
        // Store token
        await this._context.secrets.store('switchboard.notion.apiToken', token.trim());
        
        // Validate token
        const isValid = await notionService.isAvailable();
        if (!isValid) {
            return { success: false, error: 'Token validation failed. Check that the token is valid and has the correct permissions.' };
        }
        
        return { success: true };
    } catch (error: any) {
        return { success: false, error: error.message || 'Setup failed' };
    }
}
```

Update `postSetupPanelState()` to include integration states:

```typescript
public async postSetupPanelState(): Promise<void> {
    // ... existing state pushes ...
    
    const integrationStates = await this.getIntegrationSetupStates();
    this._setupPanelProvider?.postMessage({ type: 'integrationSetupStates', ...integrationStates });
}
```

### 4. Update Kanban Board Setup Buttons to Open Setup Panel
#### [MODIFY] `src/webview/kanban.html`

Modify ClickUp and Linear setup button handlers to open setup panel:

```javascript
document.getElementById('clickup-setup-btn')?.addEventListener('click', () => {
    vscode.postMessage({ type: 'openSetupPanel', section: 'project-mgmt' });
});

document.getElementById('linear-setup-btn')?.addEventListener('click', () => {
    vscode.postMessage({ type: 'openSetupPanel', section: 'project-mgmt' });
});
```

#### [MODIFY] `src/services/KanbanProvider.ts`

Add message handler:

```typescript
case 'openSetupPanel': {
    await vscode.commands.executeCommand('switchboard.openSetupPanel');
    // Optionally send a message to setup panel to expand the project management section
    break;
}
```

### 5. Update README
#### [MODIFY] `README.md`

Add section in "Configuration" or "Setup" section:

```markdown
## Project Management Integrations

Switchboard integrates with external project management tools for plan synchronization and import:

### ClickUp
- Sync plans to ClickUp tasks as cards move between Kanban columns
- Import tasks from ClickUp as plans
- **Setup**: Open the Setup panel (sidebar → "OPEN SETUP" → "Project Management" accordion) and enter your ClickUp API token. The setup wizard will guide you through workspace, space, and list configuration.

### Linear  
- Sync plans to Linear issues as cards move between Kanban columns
- Import issues from Linear as plans
- **Setup**: Open the Setup panel (sidebar → "OPEN SETUP" → "Project Management" accordion) and enter your Linear API token. The setup wizard will guide you through team, project, and state mapping configuration.

### Notion
- Fetch design documents from Notion pages to embed in planner prompts
- **Setup**: Open the Setup panel (sidebar → "OPEN SETUP" → "Project Management" accordion) and enter your Notion integration token (starts with `secret_` or `ntn_`). After setup, paste a Notion page URL in the Design Doc field and click "Sync from Notion" to fetch content.

All API tokens are stored securely in your OS keychain via VS Code SecretStorage.
```

## Verification Plan

### Automated Tests
- Add test asserting `setup.html` contains Project Management accordion with all three integration subsections
- Add test asserting `SetupPanelProvider` handles integration setup messages
- Add test asserting `TaskViewerProvider.getIntegrationSetupStates()` returns correct completion flags

### Manual Verification Steps
1. Open central setup panel and verify "Project Management" accordion appears
2. Verify ClickUp, Linear, and Notion subsections are present with token inputs
3. Enter invalid Notion token (not starting with secret_/ntn_) → verify validation error
4. Enter valid ClickUp token → verify setup wizard triggers and completes
5. Enter valid Linear token → verify setup wizard triggers and completes  
6. Enter valid Notion token → verify token validates and status shows "Configured"
7. Close and reopen setup panel → verify setup status persists
8. Click ClickUp/Linear setup buttons in Kanban board → verify setup panel opens to Project Management section
9. After setup, verify Kanban board shows sync status indicators correctly

## Implementation Order
1. Add Project Management accordion HTML to `setup.html`
2. Add JavaScript handlers in `setup.html` for token inputs and setup buttons
3. Add message handlers in `SetupPanelProvider.ts`
4. Add helper methods in `TaskViewerProvider.ts`
5. Update Kanban board button handlers to open setup panel
6. Update README documentation
7. Test all three integration flows end-to-end

## Success Criteria
- All three integrations have setup UI in central setup panel
- No integration setup requires command palette usage
- Setup status persists across panel open/close
- Kanban board setup buttons redirect to setup panel
- README documents all three integrations
- Existing configured integrations continue to work without re-setup

## Execution Notes

### Fixed Items
- Notion setup state now comes from persisted setup config only, instead of treating a stored token as automatically configured.

### Files Changed
- `src/services/TaskViewerProvider.ts`
- `.switchboard/plans/add_project_management_accordion_to_central_setup.md`

### Validation Results
- `npm run compile` ✅
- `node src/test/setup-panel-migration.test.js` ✅
- `node src/test/integration-auto-pull-regression.test.js` ✅
- `npx tsc --noEmit` ⚠️ fails on pre-existing `src/services/KanbanProvider.ts:2405` ArchiveManager dynamic import extension complaint

### Remaining Risks
- Multi-root workspace selection still depends on the active workspace resolution path.
- `npx tsc --noEmit` still has the known pre-existing ArchiveManager import complaint outside this change.

### Unresolved Issues
- Yes: the known typecheck complaint remains unresolved because it is pre-existing and unrelated to this pass.
