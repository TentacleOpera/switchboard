'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

async function run() {
    const implementationHtmlPath = path.join(process.cwd(), 'src', 'webview', 'implementation.html');
    const implementationHtml = await fs.promises.readFile(implementationHtmlPath, 'utf8');

    assert.ok(
        implementationHtml.includes("type: 'createDraftPlanTicket'"),
        'sidebar create button should request direct draft ticket creation'
    );
    assert.ok(
        !implementationHtml.includes('id="initiate-plan-modal"'),
        'legacy initiate-plan modal markup should be removed from the sidebar webview'
    );
    assert.ok(
        !implementationHtml.includes('openInitiatePlanModal'),
        'sidebar webview should not retain the legacy modal helper'
    );
    assert.ok(
        !implementationHtml.includes("type: 'initiatePlan'"),
        'sidebar webview should not post legacy initiatePlan modal messages'
    );
    assert.ok(
        !implementationHtml.includes('airlock_planSaved'),
        'sidebar webview should not retain stale airlock modal save status handling'
    );
    assert.ok(
        implementationHtml.includes('use CREATE to open a new ticket in edit mode'),
        'airlock guidance should describe the direct ticket creation flow'
    );

    const extensionSourcePath = path.join(process.cwd(), 'src', 'extension.ts');
    const extensionSource = await fs.promises.readFile(extensionSourcePath, 'utf8');

    assert.ok(
        extensionSource.includes("await taskViewerProvider?.createDraftPlanTicket();"),
        'switchboard.initiatePlan should create a draft ticket directly'
    );

    const providerPath = path.join(process.cwd(), 'src', 'services', 'TaskViewerProvider.ts');
    const providerSource = await fs.promises.readFile(providerPath, 'utf8');

    assert.ok(
        providerSource.includes("public async createDraftPlanTicket(): Promise<void>"),
        'TaskViewerProvider should expose a direct draft ticket helper'
    );
    assert.ok(
        providerSource.includes("const title = 'Untitled Plan';"),
        'draft ticket helper should use a safe placeholder title'
    );
    assert.ok(
        providerSource.includes("const idea = this._buildDraftPlanContent(title);"),
        'draft ticket helper should seed a scaffolded draft plan body'
    );
    assert.ok(
        providerSource.includes("case 'createDraftPlanTicket':"),
        'webview messages should route createDraftPlanTicket through the backend helper'
    );
    assert.ok(
        !providerSource.includes("case 'initiatePlan':"),
        'TaskViewerProvider should not retain the legacy initiatePlan webview message path'
    );
    assert.ok(
        !providerSource.includes('revealInitiatePlanModal'),
        'TaskViewerProvider should not expose the removed modal reveal helper'
    );
    assert.ok(
        !providerSource.includes('_handleInitiatePlan'),
        'TaskViewerProvider should not retain the removed modal plan handler'
    );
    assert.ok(
        !providerSource.includes('_buildInitiatedPlanPrompt'),
        'TaskViewerProvider should not retain the removed clipboard prompt helper'
    );
    assert.ok(
        !providerSource.includes('airlock_planSaved'),
        'TaskViewerProvider should not post stale airlock modal save messages'
    );
    assert.ok(
        providerSource.includes("await this._openPlanInReviewPanel(sessionId, planFileAbsolute, title);"),
        'draft ticket helper should open the review panel immediately'
    );
    assert.ok(
        providerSource.includes("initialMode: 'edit'"),
        'direct-created tickets should still open in edit mode'
    );

    const kanbanSourcePath = path.join(process.cwd(), 'src', 'services', 'KanbanProvider.ts');
    const kanbanSource = await fs.promises.readFile(kanbanSourcePath, 'utf8');

    assert.ok(
        kanbanSource.includes("await vscode.commands.executeCommand('switchboard.initiatePlan');"),
        'kanban create action should keep using the shared initiatePlan command'
    );

    console.log('direct create ticket regression test passed');
}

run().catch((error) => {
    console.error('direct create ticket regression test failed:', error);
    process.exit(1);
});
