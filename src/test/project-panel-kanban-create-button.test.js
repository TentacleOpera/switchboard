'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

async function run() {
    const htmlPath = path.join(process.cwd(), 'src', 'webview', 'project.html');
    const htmlSource = await fs.promises.readFile(htmlPath, 'utf8');

    assert.ok(
        htmlSource.includes('id="btn-create-kanban-plan"'),
        'project.html should contain the create button element'
    );
    assert.ok(
        htmlSource.includes('class="strip-btn"'),
        'project.html create button should use strip-btn class'
    );
    assert.ok(
        !htmlSource.includes('is-teal'),
        'project.html create button should not use non-existent is-teal class'
    );

    const jsPath = path.join(process.cwd(), 'src', 'webview', 'project.js');
    const jsSource = await fs.promises.readFile(jsPath, 'utf8');

    assert.ok(
        jsSource.includes("btnCreateKanbanPlan = document.getElementById('btn-create-kanban-plan')"),
        'project.js should retrieve DOM element for the create button'
    );
    assert.ok(
        jsSource.includes("type: 'createPlan'"),
        'project.js should post message type createPlan on click'
    );

    const providerPath = path.join(process.cwd(), 'src', 'services', 'PlanningPanelProvider.ts');
    const providerSource = await fs.promises.readFile(providerPath, 'utf8');

    assert.ok(
        providerSource.includes("case 'createPlan':"),
        'PlanningPanelProvider should handle createPlan message'
    );
    assert.ok(
        providerSource.includes("await vscode.commands.executeCommand('switchboard.initiatePlan')"),
        'PlanningPanelProvider createPlan case should delegate to initiatePlan command'
    );

    console.log('project panel kanban create button test passed');
}

run().catch((error) => {
    console.error('project panel kanban create button test failed:', error);
    process.exit(1);
});
