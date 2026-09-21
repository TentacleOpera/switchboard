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

    // ACCEPTANCE TESTED is retired — historical events naming it must not
    // resurrect the column; both directions derive to CODE REVIEWED.
    assert.strictEqual(
        deriveKanbanColumn([{ workflow: 'reset-to-acceptance-tested' }], []),
        'CODE REVIEWED',
        'reset-to-acceptance-tested should derive back to CODE REVIEWED'
    );

    assert.strictEqual(
        deriveKanbanColumn([{ workflow: 'move-to-acceptance-tested' }], []),
        'CODE REVIEWED',
        'move-to-acceptance-tested should derive forward manual moves to CODE REVIEWED'
    );

    assert.strictEqual(
        deriveKanbanColumn([{ workflow: 'tester-pass' }], []),
        'CODE REVIEWED',
        'tester-pass should derive to CODE REVIEWED — the tester stage is retired'
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
