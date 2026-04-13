'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const agentConfigPath = path.join(process.cwd(), 'src', 'services', 'agentConfig.ts');
const taskViewerPath = path.join(process.cwd(), 'src', 'services', 'TaskViewerProvider.ts');
const setupPanelPath = path.join(process.cwd(), 'src', 'services', 'SetupPanelProvider.ts');
const setupHtmlPath = path.join(process.cwd(), 'src', 'webview', 'setup.html');

const agentConfigSource = fs.readFileSync(agentConfigPath, 'utf8');
const taskViewerSource = fs.readFileSync(taskViewerPath, 'utf8');
const setupPanelSource = fs.readFileSync(setupPanelPath, 'utf8');
const setupHtmlSource = fs.readFileSync(setupHtmlPath, 'utf8');

function run() {
    assert.match(
        agentConfigSource,
        /export interface CustomKanbanColumnConfig[\s\S]*triggerPrompt:\s*string;[\s\S]*dragDropMode:\s*'cli'\s*\|\s*'prompt';/,
        'Expected agentConfig.ts to declare the persisted CustomKanbanColumnConfig shape.'
    );
    assert.match(
        agentConfigSource,
        /export function parseCustomKanbanColumns\(raw: unknown\): CustomKanbanColumnConfig\[][\s\S]*if \(!Array\.isArray\(raw\)\) \{[\s\S]*return \[\];/,
        'Expected agentConfig.ts to parse customKanbanColumns defensively.'
    );

    assert.match(
        taskViewerSource,
        /type SetupKanbanStructureItem = \{[\s\S]*source:\s*'built-in' \| 'custom-agent' \| 'custom-user';[\s\S]*assignedAgent\?: string;[\s\S]*triggerPrompt\?: string;[\s\S]*dragDropMode:\s*'cli' \| 'prompt';[\s\S]*editable: boolean;[\s\S]*deletable: boolean;/,
        'Expected TaskViewerProvider.ts to expose the expanded setup item fields for column management.'
    );
    assert.match(
        taskViewerSource,
        /state\.customKanbanColumns = sanitizedCustomKanbanColumns;/,
        'Expected TaskViewerProvider.ts to persist customKanbanColumns through handleSaveStartupCommands().'
    );
    assert.match(
        taskViewerSource,
        /private async _getCustomKanbanColumns\(workspaceRoot\?: string\): Promise<CustomKanbanColumnConfig\[]>/,
        'Expected TaskViewerProvider.ts to read customKanbanColumns from state.json.'
    );

    assert.match(
        setupPanelSource,
        /case 'saveStartupCommands':[\s\S]*handleSaveStartupCommands\(message\);/,
        'Expected SetupPanelProvider.ts to keep saveStartupCommands routed through TaskViewerProvider.'
    );
    assert.match(
        setupPanelSource,
        /case 'restoreKanbanDefaults':[\s\S]*handleRestoreKanbanDefaults\(\);[\s\S]*postSetupPanelState\(\);/,
        'Expected SetupPanelProvider.ts to route restoreKanbanDefaults and rehydrate setup state.'
    );

    assert.match(
        setupHtmlSource,
        /id="btn-add-kanban-column"[\s\S]*ADD COLUMN[\s\S]*id="btn-restore-kanban-defaults"[\s\S]*RESTORE DEFAULTS/s,
        'Expected setup.html to include Add Column and Restore Defaults controls.'
    );
    assert.match(
        setupHtmlSource,
        /id="kanban-column-modal"[\s\S]*id="kanban-column-label"[\s\S]*id="kanban-column-assigned-agent"[\s\S]*id="kanban-column-trigger-prompt"[\s\S]*id="kanban-column-dragdrop"/s,
        'Expected setup.html to include the custom-column modal fields.'
    );
    assert.match(
        setupHtmlSource,
        /customKanbanColumns:\s*getPersistedCustomKanbanColumns\(\)/,
        'Expected setup.html autosave payload to include customKanbanColumns.'
    );

    console.log('kanban custom column management regression test passed');
}

try {
    run();
} catch (error) {
    console.error('kanban custom column management regression test failed:', error);
    process.exit(1);
}
