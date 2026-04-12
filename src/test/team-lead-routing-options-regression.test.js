'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

function readSource(...segments) {
    return fs.readFileSync(path.join(process.cwd(), ...segments), 'utf8');
}

function run() {
    const agentConfigSource = readSource('src', 'services', 'agentConfig.ts');
    const kanbanProviderSource = readSource('src', 'services', 'KanbanProvider.ts');
    const taskViewerSource = readSource('src', 'services', 'TaskViewerProvider.ts');
    const setupPanelProviderSource = readSource('src', 'services', 'SetupPanelProvider.ts');
    const setupSource = readSource('src', 'webview', 'setup.html');

    assert.match(
        agentConfigSource,
        /export interface KanbanColumnBuildOverrides \{[\s\S]*orderOverrides\?: Record<string, number>;[\s\S]*export function reweightSequence\(orderedIds: string\[\]\): Record<string, number> \{[\s\S]*const defaultColumns = DEFAULT_KANBAN_COLUMNS\.map\(column => \{[\s\S]*const override = overrides\.orderOverrides\?\.\[column\.id\];[\s\S]*order: typeof override === 'number' \? override : column\.order/m,
        'Expected agentConfig ordering logic to use generalized order overrides plus shared reweighting.'
    );

    assert.match(
        kanbanProviderSource,
        /workspaceState\.get<number>\('kanban\.teamLeadComplexityCutoff', 0\)[\s\S]*workspaceState\.get<number>\('kanban\.teamLeadKanbanOrder', 170\)[\s\S]*workspaceState\.get<Record<string, number>>\('kanban\.orderOverrides', \{\}\)[\s\S]*workspaceState\.update\('kanban\.teamLeadComplexityCutoff', normalized\)[\s\S]*workspaceState\.update\('kanban\.orderOverrides', normalized\)/m,
        'Expected KanbanProvider to persist Team Lead routing cutoff and generalized Kanban order overrides in workspace state.'
    );

    assert.match(
        kanbanProviderSource,
        /public resolveRoutedRole\(score: number\): 'lead' \| 'coder' \| 'intern' \| 'team-lead' \{[\s\S]*if \(this\._teamLeadComplexityCutoff > 0 && score >= this\._teamLeadComplexityCutoff\) \{[\s\S]*return 'team-lead';/m,
        'Expected Team Lead routing cutoff to override the standard routed role when enabled.'
    );

    assert.match(
        setupSource,
        /id="kanban-structure-toggle"[\s\S]*id="kanban-structure-list"[\s\S]*Drag active middle columns to change board order[\s\S]*id="team-lead-complexity-cutoff" type="range" min="0" max="10" step="1" value="0"[\s\S]*id="team-lead-complexity-cutoff-label"/m,
        'Expected setup.html to expose the Kanban Structure UI while keeping the Team Lead cutoff slider.'
    );

    assert.match(
        taskViewerSource,
        /handleGetTeamLeadRoutingSettings\(\): \{ complexityCutoff: number; kanbanOrder: number \} \{[\s\S]*complexityCutoff: 0,[\s\S]*kanbanOrder: 170[\s\S]*_buildKanbanColumnsForWorkspace\(customAgents: CustomAgentConfig\[\]\) \{[\s\S]*orderOverrides: this\._kanbanProvider\?\.getKanbanOrderOverrides\(\)[\s\S]*handleUpdateKanbanStructure\(sequence: unknown, workspaceRoot\?: string\): Promise<void>[\s\S]*_projectVisibleKanbanWeights/m,
        'Expected TaskViewerProvider to expose Team Lead routing settings and reuse generalized ordering helpers for setup drag persistence.'
    );

    assert.match(
        setupPanelProviderSource,
        /case 'getKanbanStructure': \{[\s\S]*handleGetKanbanStructure\(\)[\s\S]*type: 'kanbanStructure'[\s\S]*case 'getTeamLeadRoutingSettings': \{[\s\S]*handleGetTeamLeadRoutingSettings\(\)[\s\S]*type: 'teamLeadRoutingSettings'[\s\S]*case 'updateKanbanStructure'[\s\S]*handleUpdateKanbanStructure\(message\.sequence\)/m,
        'Expected SetupPanelProvider to relay Kanban structure hydration and drag updates alongside Team Lead routing settings.'
    );

    console.log('team lead routing options regression test passed');
}

try {
    run();
} catch (error) {
    console.error('team lead routing options regression test failed:', error);
    process.exit(1);
}
