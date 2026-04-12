'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

function run() {
    const implementationPath = path.join(process.cwd(), 'src', 'webview', 'implementation.html');
    const setupPath = path.join(process.cwd(), 'src', 'webview', 'setup.html');
    const providerPath = path.join(process.cwd(), 'src', 'services', 'TaskViewerProvider.ts');
    const setupProviderPath = path.join(process.cwd(), 'src', 'services', 'SetupPanelProvider.ts');

    const implementationSource = fs.readFileSync(implementationPath, 'utf8');
    const setupSource = fs.readFileSync(setupPath, 'utf8');
    const providerSource = fs.readFileSync(providerPath, 'utf8');
    const setupProviderSource = fs.readFileSync(setupProviderPath, 'utf8');

    assert.ok(
        implementationSource.includes('id="terminal-operations-fields"') &&
        implementationSource.includes('id="btn-open-central-setup"'),
        'Expected the sidebar to keep terminal operations and expose an Open Setup button.'
    );
    assert.ok(
        !implementationSource.includes('id="jules-auto-sync-toggle"') &&
        implementationSource.includes('id="onboard-jules-auto-sync"'),
        'Expected steady-state Jules autosync to leave Terminal Operations while onboarding keeps its own toggle.'
    );
    assert.ok(
        !implementationSource.includes('id="custom-agent-list"') &&
        !implementationSource.includes('id="startup-fields"') &&
        !implementationSource.includes('id="db-sync-fields"') &&
        !implementationSource.includes('id="custom-prompts-modal"') &&
        !implementationSource.includes('id="custom-agent-modal"') &&
        !implementationSource.includes('class="agent-visible-toggle"') &&
        !implementationSource.includes('input type="text" data-role='),
        'Expected the sidebar implementation view to remove migrated setup, database, and built-in agent configuration UI.'
    );

    assert.ok(
        setupSource.includes('id="custom-agent-list"') &&
        setupSource.includes('id="startup-fields"') &&
        setupSource.includes('id="agents-fields"') &&
        setupSource.includes('id="db-sync-fields"') &&
        setupSource.includes('id="project-mgmt-fields"') &&
        setupSource.includes('id="clickup-token-input"') &&
        setupSource.includes('id="linear-token-input"') &&
        setupSource.includes('id="notion-token-input"') &&
        setupSource.includes('class="agent-visible-toggle"') &&
        setupSource.includes('id="default-prompt-override-summary"') &&
        setupSource.includes('id="btn-customize-default-prompts"') &&
        setupSource.includes('id="custom-prompts-modal"') &&
        setupSource.includes('id="custom-agent-modal"'),
        'Expected the central setup view to own the migrated configuration, agent controls, and integration UI.'
    );
    assert.ok(
        setupSource.includes('id="jules-auto-sync-toggle"') &&
        setupSource.includes('id="setup-save-status"'),
        'Expected the setup panel to own the persistent Jules autosync toggle and passive autosave status line.'
    );
    assert.ok(
        !setupSource.includes('id="prompt-overrides-toggle"') &&
        setupSource.includes('ClickUp, Linear and Notion Integration'),
        'Expected setup.html to fold prompt overrides into the Agents accordion and rename the integration section.'
    );
    assert.ok(
        setupSource.includes("type: 'saveStartupCommands'") &&
        setupSource.includes("type: 'saveDefaultPromptOverrides'") &&
        setupSource.includes("type: 'setPresetDbPath'") &&
        setupSource.includes("type: 'setupClickUp'") &&
        setupSource.includes("type: 'setupLinear'") &&
        setupSource.includes("type: 'setupNotion'") &&
        setupSource.includes("type: 'getIntegrationSetupStates'"),
        'Expected setup.html to wire migrated saves, database actions, and project-management setup actions through webview messages.'
    );

    assert.match(
        providerSource,
        /public async handleSaveStartupCommands\(data: any\): Promise<void> \{/,
        'Expected TaskViewerProvider to expose a shared saveStartupCommands handler for both webviews.'
    );
    assert.match(
        providerSource,
        /state\.visibleAgents\s*=\s*\{\s*\.\.\.\(state\.visibleAgents \|\| \{\}\),\s*\.\.\.visibleAgentsPatch\s*\};/s,
        'Expected shared startup-command saving to merge visibility patches instead of blindly replacing state.'
    );
    assert.match(
        providerSource,
        /await Promise\.all\(\[\s*this\._postSidebarConfigurationState\(activeWorkspaceRoot\),\s*this\.postSetupPanelState\(activeWorkspaceRoot\)\s*\]\);/s,
        'Expected saveStartupCommands to rebroadcast updated startup and visibility state to both webviews.'
    );
    assert.match(
        providerSource,
        /public async postSetupPanelState\(workspaceRoot\?: string\): Promise<void> \{/,
        'Expected TaskViewerProvider to expose a setup-panel state broadcaster.'
    );
    assert.match(
        providerSource,
        /postSetupPanelState\(workspaceRoot\?: string\): Promise<void> \{[\s\S]*type:\s*'julesAutoSyncSetting'/,
        'Expected postSetupPanelState() to hydrate the setup-panel Jules autosync toggle.'
    );
    assert.match(
        providerSource,
        /public async getIntegrationSetupStates\(workspaceRoot\?: string\): Promise<\{[\s\S]*clickupSetupComplete: boolean;[\s\S]*linearSetupComplete: boolean;[\s\S]*notionSetupComplete: boolean;[\s\S]*\}> \{/m,
        'Expected TaskViewerProvider to expose project-management integration status for the setup panel.'
    );
    assert.match(
        providerSource,
        /public async handleSetupClickUp\(token: string\): Promise<\{ success: boolean; error\?: string \}> \{[\s\S]*switchboard\.clickup\.apiToken[\s\S]*return await this\._getClickUpService\(resolvedRoot\)\.setup\(\);/m,
        'Expected TaskViewerProvider to reuse the ClickUp service setup flow from the central setup panel.'
    );
    assert.match(
        providerSource,
        /public async handleSetupLinear\(token: string\): Promise<\{ success: boolean; error\?: string \}> \{[\s\S]*switchboard\.linear\.apiToken[\s\S]*this\._getLinearService\(resolvedRoot\)\.setup\(\);/m,
        'Expected TaskViewerProvider to reuse the Linear service setup flow from the central setup panel.'
    );
    assert.match(
        providerSource,
        /public async handleSetupNotion\(token: string\): Promise<\{ success: boolean; error\?: string \}> \{[\s\S]*switchboard\.notion\.apiToken[\s\S]*Token validation failed\./m,
        'Expected TaskViewerProvider to validate and persist Notion setup from the central setup panel.'
    );

    assert.match(
        setupProviderSource,
        /class SetupPanelProvider implements vscode\.Disposable/,
        'Expected a dedicated SetupPanelProvider webview panel class.'
    );
    assert.match(
        setupProviderSource,
        /createWebviewPanel\(\s*'switchboard-setup',\s*'SETUP'/s,
        'Expected SetupPanelProvider.open\(\) to create the central setup editor panel.'
    );
    assert.match(
        setupProviderSource,
        /public postMessage\(message: any\): void \{\s*this\._panel\?\.webview\.postMessage\(message\);/s,
        'Expected SetupPanelProvider to support pushed state updates from TaskViewerProvider.'
    );
    assert.match(
        setupProviderSource,
        /public async open\(section\?: string\): Promise<void> \{[\s\S]*openSetupSection/s,
        'Expected SetupPanelProvider.open() to support focusing the Project Management accordion.'
    );
    assert.match(
        setupProviderSource,
        /case 'getIntegrationSetupStates': \{[\s\S]*case 'setupClickUp': \{[\s\S]*case 'setupLinear': \{[\s\S]*case 'setupNotion': \{/s,
        'Expected SetupPanelProvider to route project-management setup messages to TaskViewerProvider.'
    );
    assert.match(
        setupProviderSource,
        /this\._panel\.onDidDispose\(\(\) => \{\s*this\._panel = undefined;/s,
        'Expected SetupPanelProvider to clear panel state when disposed.'
    );

    console.log('setup panel migration test passed');
}

try {
    run();
} catch (error) {
    console.error('setup panel migration test failed:', error);
    process.exit(1);
}
