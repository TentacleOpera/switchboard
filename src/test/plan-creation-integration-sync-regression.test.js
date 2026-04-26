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

    assert.match(
        kanbanProviderSource,
        /public async queueIntegrationSyncForSession\([\s\S]*await Promise\.allSettled\(\[[\s\S]*this\._queueClickUpSync\([\s\S]*this\._queueLinearSync\(/m,
        'Expected KanbanProvider to expose a shared integration sync bridge that fans out to ClickUp and Linear.'
    );

    assert.match(
        providerSource,
        /private async _createInitiatedPlan\([\s\S]*await this\._logEvent\('plan_management',[\s\S]*await this\._kanbanProvider\?\.queueIntegrationSyncForSession\(\s*workspaceRoot,\s*sessionId,\s*'CREATED'/m,
        'Expected initiated plan creation to queue integration sync once the local plan has been persisted.'
    );

    assert.match(
        providerSource,
        /private async _handleCopyPlanLink\([\s\S]*await this\._applyManualKanbanColumnChange\([\s\S]*await this\._kanbanProvider\?\.queueIntegrationSyncForSession\(\s*resolvedWorkspaceRoot,\s*sessionId,\s*targetColumn/m,
        'Expected copy-prompt auto-advance to queue integration sync for the routed target column.'
    );

    console.log('plan creation integration sync regression test passed');
}

try {
    run();
} catch (error) {
    console.error('plan creation integration sync regression test failed:', error);
    process.exit(1);
}
