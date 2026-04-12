'use strict';

const assert = require('assert');
const path = require('path');

const { deriveKanbanColumn } = require(path.join(process.cwd(), 'src', 'services', 'kanbanColumnDerivationImpl.js'));

function run() {
    assert.strictEqual(
        deriveKanbanColumn([{ workflow: 'reset-to-code-reviewed' }], []),
        'CODE REVIEWED',
        'reset-to-code-reviewed should derive back to CODE REVIEWED'
    );

    assert.strictEqual(
        deriveKanbanColumn([{ workflow: 'move-to-code-reviewed' }], []),
        'CODE REVIEWED',
        'move-to-code-reviewed should derive forward manual moves to CODE REVIEWED'
    );

    assert.strictEqual(
        deriveKanbanColumn([{ workflow: 'reset-to-acceptance-tested' }], []),
        'ACCEPTANCE TESTED',
        'reset-to-acceptance-tested should derive back to ACCEPTANCE TESTED'
    );

    assert.strictEqual(
        deriveKanbanColumn([{ workflow: 'move-to-acceptance-tested' }], []),
        'ACCEPTANCE TESTED',
        'move-to-acceptance-tested should derive forward manual moves to ACCEPTANCE TESTED'
    );

    const customAgents = [
        { role: 'custom_agent_docs' }
    ];
    assert.strictEqual(
        deriveKanbanColumn([{ workflow: 'reset-to-custom_agent_docs' }], customAgents),
        'custom_agent_docs',
        'reset-to-custom_agent_* should derive back to the matching custom column'
    );

    assert.strictEqual(
        deriveKanbanColumn([{ workflow: 'move-to-custom_agent_docs' }], customAgents),
        'custom_agent_docs',
        'move-to-custom_agent_* should derive forward manual moves to the matching custom column'
    );

    console.log('kanban backward reset regression test passed');
}

try {
    run();
} catch (error) {
    console.error('kanban backward reset regression test failed:', error);
    process.exit(1);
}
