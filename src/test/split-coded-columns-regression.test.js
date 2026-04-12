'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const agentConfigSource = fs.readFileSync(path.join(process.cwd(), 'src', 'services', 'agentConfig.ts'), 'utf8');
const taskViewerSource = fs.readFileSync(path.join(process.cwd(), 'src', 'services', 'TaskViewerProvider.ts'), 'utf8');
const kanbanProviderSource = fs.readFileSync(path.join(process.cwd(), 'src', 'services', 'KanbanProvider.ts'), 'utf8');
const kanbanHtmlSource = fs.readFileSync(path.join(process.cwd(), 'src', 'webview', 'kanban.html'), 'utf8');
const registerToolsSource = fs.readFileSync(path.join(process.cwd(), 'src', 'mcp-server', 'register-tools.js'), 'utf8');

function expectRegex(source, regex, message) {
    assert.match(source, regex, message);
}

function run() {
    expectRegex(
        agentConfigSource,
        /{ id: 'LEAD CODED', label: 'Lead Coder', role: 'lead', order: 180, kind: 'coded', autobanEnabled: true, dragDropMode: 'cli' }[\s\S]*{ id: 'CODER CODED', label: 'Coder', role: 'coder', order: 190, kind: 'coded', autobanEnabled: true, dragDropMode: 'cli' }/s,
        'Expected built-in Kanban columns to define separate Lead Coder and Coder lanes.'
    );
    expectRegex(
        taskViewerSource,
        /case 'lead':[\s\S]*return 'LEAD CODED';[\s\S]*case 'coder':[\s\S]*return 'CODER CODED';/s,
        'Expected TaskViewerProvider role-to-column mapping to route lead and coder into separate lanes.'
    );
    expectRegex(
        kanbanProviderSource,
        /case 'LEAD CODED': return 'lead';[\s\S]*case 'CODER CODED': return 'coder';/s,
        'Expected KanbanProvider target-column routing to understand the split coded lanes.'
    );
    expectRegex(
        kanbanHtmlSource,
        /{ id: 'LEAD CODED', label: 'Lead Coder', role: 'lead', autobanEnabled: true },[\s\S]*{ id: 'CODER CODED', label: 'Coder', role: 'coder', autobanEnabled: true },[\s\S]*{ id: 'CODE REVIEWED', label: 'Reviewed', role: 'reviewer', autobanEnabled: false },[\s\S]*{ id: 'ACCEPTANCE TESTED', label: 'Acceptance Tested', role: 'tester', autobanEnabled: false },/s,
        'Expected the Kanban webview to render separate Lead Coder and Coder columns.'
    );
    assert.ok(!kanbanHtmlSource.includes('coded-target-select'), 'Expected the Kanban coded-target dropdown to be removed.');
    expectRegex(
        registerToolsSource,
        /const BUILTIN_KANBAN_COLUMN_DEFINITIONS = \[[\s\S]*\{ id: 'PLAN REVIEWED', label: 'Planned'[^}]*\},[\s\S]*\{ id: 'INTERN CODED', label: 'Intern'[^}]*\},[\s\S]*\{ id: 'LEAD CODED', label: 'Lead Coder'[^}]*\},[\s\S]*\{ id: 'CODER CODED', label: 'Coder'[^}]*\},[\s\S]*\{ id: 'CODE REVIEWED', label: 'Reviewed'[^}]*\},[\s\S]*\{ id: 'ACCEPTANCE TESTED', label: 'Acceptance Tested'[^}]*\}/s,
        'Expected MCP kanban readers to preserve the split coded columns in the shared column definitions.'
    );

    console.log('split coded columns regression test passed');
}

try {
    run();
} catch (error) {
    console.error('split coded columns regression test failed:', error);
    process.exit(1);
}
