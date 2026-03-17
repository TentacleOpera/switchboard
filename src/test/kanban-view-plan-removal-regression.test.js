'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

function run() {
    const kanbanHtmlPath = path.join(process.cwd(), 'src', 'webview', 'kanban.html');
    const implementationHtmlPath = path.join(process.cwd(), 'src', 'webview', 'implementation.html');
    const kanbanProviderPath = path.join(process.cwd(), 'src', 'services', 'KanbanProvider.ts');
    const taskViewerPath = path.join(process.cwd(), 'src', 'services', 'TaskViewerProvider.ts');
    const extensionPath = path.join(process.cwd(), 'src', 'extension.ts');

    const kanbanHtmlSource = fs.readFileSync(kanbanHtmlPath, 'utf8');
    const implementationHtmlSource = fs.readFileSync(implementationHtmlPath, 'utf8');
    const kanbanProviderSource = fs.readFileSync(kanbanProviderPath, 'utf8');
    const taskViewerSource = fs.readFileSync(taskViewerPath, 'utf8');
    const extensionSource = fs.readFileSync(extensionPath, 'utf8');

    assert.ok(
        !kanbanHtmlSource.includes("document.querySelectorAll('.card-btn.view')"),
        'Expected kanban.html to remove the card-btn.view click binding.'
    );
    assert.ok(
        !kanbanHtmlSource.includes("type: 'viewPlan'"),
        'Expected kanban.html to stop posting Kanban viewPlan messages.'
    );
    assert.ok(
        !kanbanHtmlSource.includes('card-btn icon-btn view'),
        'Expected kanban.html to stop rendering the Kanban View button.'
    );
    assert.ok(
        kanbanHtmlSource.includes('title="Review Plan Ticket"') &&
        kanbanHtmlSource.includes('title="Complete Plan"') &&
        kanbanHtmlSource.includes('${copyLabel}'),
        'Expected the remaining Kanban card actions to stay intact.'
    );

    assert.ok(
        !kanbanProviderSource.includes("case 'viewPlan'"),
        'Expected KanbanProvider to remove the Kanban-only viewPlan message handler.'
    );
    assert.ok(
        !extensionSource.includes('switchboard.viewPlanFromKanban'),
        'Expected extension.ts to remove the Kanban-only viewPlan command registration.'
    );
    assert.ok(
        !taskViewerSource.includes('public async handleKanbanViewPlan('),
        'Expected TaskViewerProvider to remove the unused handleKanbanViewPlan wrapper.'
    );

    assert.ok(
        implementationHtmlSource.includes("vscode.postMessage({ type: 'viewPlan', sessionId });"),
        'Expected the generic implementation viewPlan flow to remain intact.'
    );
    assert.ok(
        taskViewerSource.includes('private async _handleViewPlan(sessionId: string, workspaceRoot?: string) {'),
        'Expected TaskViewerProvider to preserve the generic _handleViewPlan implementation.'
    );

    console.log('kanban view-plan removal regression test passed');
}

try {
    run();
} catch (error) {
    console.error('kanban view-plan removal regression test failed:', error);
    process.exit(1);
}
