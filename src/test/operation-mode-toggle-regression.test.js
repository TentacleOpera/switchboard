'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

function readSource(...segments) {
    return fs.readFileSync(path.join(process.cwd(), ...segments), 'utf8');
}

function run() {
    const providerSource = readSource('src', 'services', 'TaskViewerProvider.ts');
    const kanbanProviderSource = readSource('src', 'services', 'KanbanProvider.ts');
    const kanbanSource = readSource('src', 'webview', 'kanban.html');
    const setupSource = readSource('src', 'webview', 'setup.html');

    assert.ok(
        providerSource.includes("type: 'integrationSetupStates'") &&
        !providerSource.includes("type: 'operationModeChanged'"),
        'Expected postSetupPanelState() to broadcast integration setup state without the removed operationModeChanged payload.'
    );
    assert.match(
        providerSource,
        /public async getIntegrationSetupStates\(workspaceRoot\?: string\): Promise<\{[\s\S]*clickupState\?: ClickUpSetupState;[\s\S]*linearState\?: LinearSetupState;[\s\S]*notionState\?: NotionSetupState;[\s\S]*\}> \{/m,
        'Expected TaskViewerProvider.getIntegrationSetupStates() to include the new Notion and per-integration checkbox hydration state.'
    );

    assert.ok(
        !setupSource.includes('OPERATION MODE') &&
        !setupSource.includes('updateOperationModeUi') &&
        !setupSource.includes('currentOperationMode') &&
        !setupSource.includes('currentOperationNeedsSetup') &&
        setupSource.includes('renderNotionSetupState') &&
        setupSource.includes('renderClickupOptionSummary') &&
        setupSource.includes('renderLinearOptionSummary'),
        'Expected setup.html to remove the global mode state machine and render integration summaries directly from hydrated config.'
    );

    assert.ok(
        !kanbanProviderSource.includes('_operationMode') &&
        !kanbanProviderSource.includes('setOperationMode(') &&
        !kanbanProviderSource.includes('getOperationMode(') &&
        kanbanProviderSource.includes('realTimeSyncEnabled'),
        'Expected KanbanProvider to remove the global operation mode and gate behavior on per-integration realtime sync flags instead.'
    );

    assert.ok(
        !kanbanSource.includes('currentOperationMode') &&
        !kanbanSource.includes('currentOperationNeedsSetup') &&
        !kanbanSource.includes('updateModeToggleButtonState') &&
        !kanbanSource.includes('switchOperationMode') &&
        !kanbanSource.includes('operationModeChanged') &&
        kanbanSource.includes("postKanbanMessage({ type: 'openSetupPanel', section: 'project-mgmt' });") &&
        kanbanSource.includes('Open ClickUp, Linear and Notion Integration setup') &&
        kanbanSource.includes('Integrations'),
        'Expected the Kanban header control to be a static setup shortcut instead of a mode toggle.'
    );

    console.log('operation mode toggle regression test passed');
}

try {
    run();
} catch (error) {
    console.error('operation mode toggle regression test failed:', error);
    process.exit(1);
}
