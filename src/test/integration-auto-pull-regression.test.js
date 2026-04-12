'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

function readSource(...segments) {
    return fs.readFileSync(path.join(process.cwd(), ...segments), 'utf8');
}

function run() {
    const clickupSource = readSource('src', 'services', 'ClickUpSyncService.ts');
    const linearSource = readSource('src', 'services', 'LinearSyncService.ts');
    const providerSource = readSource('src', 'services', 'KanbanProvider.ts');
    const extensionSource = readSource('src', 'extension.ts');
    const kanbanSource = readSource('src', 'webview', 'kanban.html');

    assert.match(
        clickupSource,
        /export interface ClickUpConfig \{[\s\S]*autoPullEnabled: boolean;[\s\S]*pullIntervalMinutes: AutoPullIntervalMinutes;[\s\S]*\}/m,
        'Expected ClickUpConfig to persist auto-pull enablement and interval settings.'
    );
    assert.match(
        clickupSource,
        /private _normalizeConfig\(raw: Partial<ClickUpConfig> \| null\): ClickUpConfig \| null \{[\s\S]*autoPullEnabled: raw\.autoPullEnabled === true,[\s\S]*pullIntervalMinutes: normalizedInterval[\s\S]*\}/m,
        'Expected ClickUp config loading to normalize legacy configs with safe auto-pull defaults.'
    );
    assert.match(
        clickupSource,
        /let config = await this\.loadConfig\(\);[\s\S]*autoPullEnabled: false,[\s\S]*pullIntervalMinutes: 60/m,
        'Expected first-time ClickUp setup to seed disabled auto-pull settings.'
    );

    assert.match(
        linearSource,
        /export interface LinearConfig \{[\s\S]*autoPullEnabled: boolean;[\s\S]*pullIntervalMinutes: AutoPullIntervalMinutes;[\s\S]*\}/m,
        'Expected LinearConfig to persist auto-pull enablement and interval settings.'
    );
    assert.match(
        linearSource,
        /private _normalizeConfig\(raw: Partial<LinearConfig> \| null\): LinearConfig \| null \{[\s\S]*autoPullEnabled: raw\.autoPullEnabled === true,[\s\S]*pullIntervalMinutes: normalizedInterval[\s\S]*\}/m,
        'Expected Linear config loading to normalize legacy configs with safe auto-pull defaults.'
    );
    assert.match(
        linearSource,
        /await this\.saveConfig\(\{[\s\S]*setupComplete: true,[\s\S]*lastSync: null,[\s\S]*autoPullEnabled: false,[\s\S]*pullIntervalMinutes: 60[\s\S]*\}\);/m,
        'Expected first-time Linear setup to seed disabled auto-pull settings.'
    );

    assert.match(
        providerSource,
        /private readonly _integrationAutoPull = new IntegrationAutoPullService\(\);[\s\S]*private async _getIntegrationImportDir\(workspaceRoot: string\): Promise<string> \{[\s\S]*this\._taskViewerProvider\?\.getPlanIngestionFolder\(workspaceRoot\);[\s\S]*return configured \|\| path\.join\(workspaceRoot, '\.switchboard', 'plans'\);/m,
        'Expected KanbanProvider to own the auto-pull scheduler and share the manual import destination resolution path.'
    );
    assert.match(
        providerSource,
        /private _buildClickUpState\(config: ClickUpConfig \| null, syncError = false\) \{[\s\S]*autoPullEnabled: config\?\.autoPullEnabled \?\? false,[\s\S]*pullIntervalMinutes: config\?\.pullIntervalMinutes \?\? 60/m,
        'Expected ClickUp webview state payloads to include auto-pull settings.'
    );
    assert.match(
        providerSource,
        /private _buildLinearState\(config: LinearConfig \| null, syncError = false\) \{[\s\S]*autoPullEnabled: config\?\.autoPullEnabled \?\? false,[\s\S]*pullIntervalMinutes: config\?\.pullIntervalMinutes \?\? 60/m,
        'Expected Linear webview state payloads to include auto-pull settings.'
    );
    assert.match(
        providerSource,
        /public async initializeIntegrationAutoPull\(\): Promise<void> \{[\s\S]*await this\._configureClickUpAutoPull\(workspaceRoot\);[\s\S]*await this\._configureLinearAutoPull\(workspaceRoot\);/m,
        'Expected KanbanProvider to initialize auto-pull scheduling for each workspace.'
    );
    assert.match(
        providerSource,
        /case 'saveIntegrationAutoPullSettings': \{[\s\S]*integration !== 'clickup' && integration !== 'linear'[\s\S]*Auto-pull interval must be 5, 15, 30, or 60 minutes\.[\s\S]*await this\._configureClickUpAutoPull\(workspaceRoot\);[\s\S]*await this\._configureLinearAutoPull\(workspaceRoot\);/m,
        'Expected KanbanProvider to validate and persist integration auto-pull settings through a single message handler.'
    );

    assert.match(
        extensionSource,
        /void kanbanProvider\.initializeIntegrationAutoPull\(\);[\s\S]*vscode\.workspace\.onDidChangeWorkspaceFolders\(\(\) => \{[\s\S]*void kanbanProvider\.initializeIntegrationAutoPull\(\);[\s\S]*\}\)/m,
        'Expected extension activation to start and reconfigure integration auto-pull timers.'
    );
    const sharedPlansDirLine = "const plansDir = await taskViewerProvider.getPlanIngestionFolder(workspaceRoot) || path.join(workspaceRoot, '.switchboard', 'plans');";
    assert.strictEqual(
        extensionSource.split(sharedPlansDirLine).length - 1,
        2,
        'Expected manual ClickUp and Linear imports to resolve the same ingestion folder as timed imports.'
    );

    assert.match(
        kanbanSource,
        /id="integration-settings-modal"[\s\S]*id="integration-autopull-toggle"[\s\S]*id="integration-interval-select"[\s\S]*id="integration-settings-save"/m,
        'Expected the Kanban webview to expose an integration auto-pull settings modal.'
    );
    assert.match(
        kanbanSource,
        /document\.getElementById\('clickup-setup-btn'\)\?\.addEventListener\('click', \(\) => \{[\s\S]*postKanbanMessage\(\{ type: 'openSetupPanel', section: 'project-mgmt' \}\);[\s\S]*\}\);[\s\S]*document\.getElementById\('linear-setup-btn'\)\?\.addEventListener\('click', \(\) => \{[\s\S]*postKanbanMessage\(\{ type: 'openSetupPanel', section: 'project-mgmt' \}\);/m,
        'Expected ClickUp and Linear setup buttons to redirect into the central integration setup section.'
    );
    assert.match(
        kanbanSource,
        /ClickUp sync error — open ClickUp, Linear and Notion Integration setup[\s\S]*Open ClickUp, Linear and Notion Integration setup[\s\S]*Linear sync error — open ClickUp, Linear and Notion Integration setup/m,
        'Expected Kanban integration tooltips to use the renamed ClickUp, Linear and Notion Integration copy.'
    );
    assert.match(
        kanbanSource,
        /type: 'saveIntegrationAutoPullSettings',[\s\S]*integration: activeIntegration,[\s\S]*autoPullEnabled: !!toggle\.checked,[\s\S]*pullIntervalMinutes: Number\(select\.value \|\| 60\)/m,
        'Expected the Kanban settings modal to save auto-pull settings through the provider message channel.'
    );

    console.log('integration auto-pull regression test passed');
}

try {
    run();
} catch (error) {
    console.error('integration auto-pull regression test failed:', error);
    process.exit(1);
}
