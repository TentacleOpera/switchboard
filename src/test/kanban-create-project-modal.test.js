'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

async function run() {
    const htmlPath = path.join(process.cwd(), 'src', 'webview', 'kanban.html');
    const htmlSource = await fs.promises.readFile(htmlPath, 'utf8');

    // Check modal markup exists
    assert.ok(
        htmlSource.includes('id="create-project-modal"'),
        'kanban.html should contain the create-project-modal container'
    );
    assert.ok(
        htmlSource.includes('id="create-project-name"'),
        'kanban.html should contain the create-project-name input'
    );
    assert.ok(
        htmlSource.includes('id="create-project-description"'),
        'kanban.html should contain the create-project-description textarea'
    );
    assert.ok(
        htmlSource.includes('id="create-project-copy-prd"'),
        'kanban.html should contain the Copy PRD Prompt button'
    );
    assert.ok(
        htmlSource.includes('id="create-project-submit"'),
        'kanban.html should contain the Create Project submit button'
    );

    // Check modal JS logic is wired up
    assert.ok(
        htmlSource.includes('function initCreateProjectModal()'),
        'kanban.html script should define initCreateProjectModal'
    );
    assert.ok(
        htmlSource.includes("type: 'copyPrdPrompt'"),
        'kanban.html should post copyPrdPrompt message type'
    );

    // Check backend provider has updated cases
    const providerPath = path.join(process.cwd(), 'src', 'services', 'KanbanProvider.ts');
    const providerSource = await fs.promises.readFile(providerPath, 'utf8');

    assert.ok(
        providerSource.includes("case 'copyPrdPrompt':"),
        'KanbanProvider should support copyPrdPrompt message case'
    );
    assert.ok(
        providerSource.includes("vscode.env.clipboard.writeText"),
        'KanbanProvider copyPrdPrompt case should write to clipboard'
    );
    assert.ok(
        providerSource.includes("!created"),
        'KanbanProvider addProject case should check if db project addition was successful'
    );

    console.log('kanban create project modal verification test passed');
}

run().catch((error) => {
    console.error('kanban create project modal verification test failed:', error);
    process.exit(1);
});
