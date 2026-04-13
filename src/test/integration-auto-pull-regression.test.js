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
    const taskViewerSource = readSource('src', 'services', 'TaskViewerProvider.ts');
    const extensionSource = readSource('src', 'extension.ts');
    const kanbanSource = readSource('src', 'webview', 'kanban.html');

    assert.match(
        clickupSource,
        /export interface ClickUpConfig \{[\s\S]*realTimeSyncEnabled: boolean;[\s\S]*autoPullEnabled: boolean;[\s\S]*pullIntervalMinutes: AutoPullIntervalMinutes;[\s\S]*\}/m,
        'Expected ClickUpConfig to persist realtime sync and auto-pull settings together.'
    );
    assert.match(
        clickupSource,
        /realTimeSyncEnabled: raw\.realTimeSyncEnabled === undefined[\s\S]*raw\.setupComplete === true[\s\S]*raw\.realTimeSyncEnabled === true/m,
        'Expected ClickUp config normalization to default legacy configured workspaces to realtime sync enabled.'
    );

    assert.match(
        linearSource,
        /export interface LinearConfig \{[\s\S]*realTimeSyncEnabled: boolean;[\s\S]*autoPullEnabled: boolean;[\s\S]*pullIntervalMinutes: AutoPullIntervalMinutes;[\s\S]*automationRules: LinearAutomationRule\[\];[\s\S]*\}/m,
        'Expected LinearConfig to persist realtime sync, auto-pull, and automation rules together.'
    );
    assert.match(
        linearSource,
        /realTimeSyncEnabled: raw\.realTimeSyncEnabled === undefined[\s\S]*raw\.setupComplete === true[\s\S]*raw\.realTimeSyncEnabled === true/m,
        'Expected Linear config normalization to default legacy configured workspaces to realtime sync enabled.'
    );

    assert.match(
        providerSource,
        /private _buildClickUpState\([\s\S]*realTimeSyncEnabled: config\?\.realTimeSyncEnabled \?\? false,[\s\S]*autoPullEnabled: config\?\.autoPullEnabled \?\? false,[\s\S]*pullIntervalMinutes: config\?\.pullIntervalMinutes \?\? 60/m,
        'Expected ClickUp webview state payloads to include realtime sync and auto-pull flags.'
    );
    assert.match(
        providerSource,
        /private _buildLinearState\(config: LinearConfig \| null, syncError = false\) \{[\s\S]*realTimeSyncEnabled: config\?\.realTimeSyncEnabled \?\? false,[\s\S]*autoPullEnabled: config\?\.autoPullEnabled \?\? false,[\s\S]*pullIntervalMinutes: config\?\.pullIntervalMinutes \?\? 60/m,
        'Expected Linear webview state payloads to include realtime sync and auto-pull flags.'
    );
    assert.match(
        providerSource,
        /public async applyLiveSyncConfig\(workspaceRoot\?: string\): Promise<void> \{[\s\S]*liveSyncConfig\.enabled[\s\S]*clickUpConfig\?\.setupComplete === true && clickUpConfig\.realTimeSyncEnabled === true[\s\S]*linearConfig\?\.setupComplete === true && linearConfig\.realTimeSyncEnabled === true[\s\S]*this\._continuousSync\.start/s,
        'Expected global live sync to start only when the global toggle is enabled and at least one integration has realtime sync enabled.'
    );
    assert.match(
        providerSource,
        /private async _configureClickUpAutomation\(workspaceRoot: string\): Promise<void> \{[\s\S]*config\.autoPullEnabled === true[\s\S]*automationRules\.some\(\(rule\) => rule\.enabled !== false\)/m,
        'Expected ClickUp automation polling to key off auto-pull plus enabled automation rules rather than a global mode.'
    );
    assert.match(
        providerSource,
        /private async _configureLinearAutomation\(workspaceRoot: string\): Promise<void> \{[\s\S]*config\.autoPullEnabled === true[\s\S]*automationRules\.some\(\(rule\) => rule\.enabled !== false\)/m,
        'Expected Linear automation polling to key off auto-pull plus enabled automation rules rather than a global mode.'
    );
    assert.match(
        providerSource,
        /public async initializeIntegrationAutoPull\(\): Promise<void> \{[\s\S]*await this\._configureClickUpAutoPull\(workspaceRoot\);[\s\S]*await this\._configureClickUpAutomation\(workspaceRoot\);[\s\S]*await this\._configureLinearAutoPull\(workspaceRoot\);[\s\S]*await this\._configureLinearAutomation\(workspaceRoot\);/m,
        'Expected KanbanProvider to keep initializing all four integration scheduler categories.'
    );
    assert.match(
        providerSource,
        /case 'saveIntegrationAutoPullSettings': \{[\s\S]*await this\._configureClickUpAutoPull\(workspaceRoot\);[\s\S]*await this\._configureClickUpAutomation\(workspaceRoot\);[\s\S]*await this\._configureLinearAutoPull\(workspaceRoot\);[\s\S]*await this\._configureLinearAutomation\(workspaceRoot\);/m,
        'Expected saved auto-pull changes to re-run both import and automation scheduler configuration.'
    );
    assert.match(
        taskViewerSource,
        /public async handleApplyClickUpConfig\([\s\S]*await this\._kanbanProvider\?\.initializeIntegrationAutoPull\(\);[\s\S]*await this\._kanbanProvider\?\.applyLiveSyncConfig\(resolvedRoot\);/m,
        'Expected ClickUp apply flows to reconfigure live sync immediately after realtime sync settings change.'
    );
    assert.match(
        taskViewerSource,
        /public async handleApplyLinearConfig\([\s\S]*await this\._kanbanProvider\?\.initializeIntegrationAutoPull\(\);[\s\S]*await this\._kanbanProvider\?\.applyLiveSyncConfig\(resolvedRoot\);/m,
        'Expected Linear apply flows to reconfigure live sync immediately after realtime sync settings change.'
    );

    assert.match(
        extensionSource,
        /void kanbanProvider\.initializeIntegrationAutoPull\(\);[\s\S]*vscode\.workspace\.onDidChangeWorkspaceFolders\(\(\) => \{[\s\S]*void kanbanProvider\.initializeIntegrationAutoPull\(\);[\s\S]*\}\)/m,
        'Expected extension activation to keep initializing integration schedulers on startup and workspace changes.'
    );

    assert.ok(
        kanbanSource.includes('id="integration-settings-modal"') &&
        kanbanSource.includes('id="integration-autopull-toggle"') &&
        kanbanSource.includes('id="integration-interval-select"') &&
        kanbanSource.includes('Realtime sync is configured in Setup.'),
        'Expected the Kanban integration settings modal to clarify that realtime sync now lives in Setup.'
    );
    assert.match(
        kanbanSource,
        /case 'clickupState': \{[\s\S]*realTimeSyncEnabled: msg\.realTimeSyncEnabled === true,[\s\S]*autoPullEnabled: msg\.autoPullEnabled === true/m,
        'Expected the Kanban ClickUp state handler to hydrate realtime sync and auto-pull flags.'
    );
    assert.match(
        kanbanSource,
        /case 'linearState': \{[\s\S]*realTimeSyncEnabled: msg\.realTimeSyncEnabled === true,[\s\S]*autoPullEnabled: msg\.autoPullEnabled === true/m,
        'Expected the Kanban Linear state handler to hydrate realtime sync and auto-pull flags.'
    );

    console.log('integration auto-pull regression test passed');
}

try {
    run();
} catch (error) {
    console.error('integration auto-pull regression test failed:', error);
    process.exit(1);
}
