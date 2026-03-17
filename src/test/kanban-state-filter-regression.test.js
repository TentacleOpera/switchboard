'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const {
    formatKanbanState,
    resolveRequestedKanbanColumn
} = require('../mcp-server/register-tools.js');

const registerToolsSource = fs.readFileSync(path.join(process.cwd(), 'src', 'mcp-server', 'register-tools.js'), 'utf8');

let passed = 0;
let failed = 0;

function test(name, fn) {
    try {
        fn();
        console.log(`  PASS ${name}`);
        passed++;
    } catch (error) {
        console.error(`  FAIL ${name}: ${error.message}`);
        failed++;
    }
}

function run() {
    console.log('\nRunning kanban state filter regression tests\n');

    test('formatKanbanState exposes UI labels for built-in and custom columns', () => {
        const formatted = formatKanbanState(
            {
                CREATED: [{ topic: 'Created item' }],
                custom_agent_ops: [{ topic: 'Ops item' }]
            },
            [
                { id: 'CREATED', label: 'Plan Created', order: 0 },
                { id: 'custom_agent_ops', label: 'Ops', order: 150 }
            ]
        );

        assert.strictEqual(formatted.CREATED.label, 'Plan Created');
        assert.deepStrictEqual(formatted.CREATED.items, [{ topic: 'Created item' }]);
        assert.strictEqual(formatted.custom_agent_ops.label, 'Ops');
        assert.deepStrictEqual(formatted.custom_agent_ops.items, [{ topic: 'Ops item' }]);
    });

    test('resolveRequestedKanbanColumn accepts internal keys and UI labels', () => {
        const availableColumns = ['CREATED', 'PLAN REVIEWED', 'LEAD CODED', 'CODER CODED', 'CODE REVIEWED'];

        assert.strictEqual(resolveRequestedKanbanColumn('CREATED', availableColumns), 'CREATED');
        assert.strictEqual(resolveRequestedKanbanColumn('New', availableColumns), 'CREATED');
        assert.strictEqual(resolveRequestedKanbanColumn('Plan Created', availableColumns), 'CREATED');
        assert.strictEqual(resolveRequestedKanbanColumn('Planned', availableColumns), 'PLAN REVIEWED');
        assert.strictEqual(resolveRequestedKanbanColumn('Lead Coder', availableColumns), 'LEAD CODED');
        assert.strictEqual(resolveRequestedKanbanColumn('Reviewed', availableColumns), 'CODE REVIEWED');
    });

    test('register-tools filters SQLite reads when a column is requested', () => {
        assert.match(
            registerToolsSource,
            /if \(requestedColumnId\) \{[\s\S]*kanban_column IN \(\?, \?\)[\s\S]*kanban_column = \?/s,
            'Expected readKanbanStateFromDb to narrow SQL rows when a specific kanban column is requested.'
        );
    });

    test('file fallback skips complexity reads for non-matching columns', () => {
        assert.match(
            registerToolsSource,
            /const col = normalizeKanbanColumnId\(deriveKanbanColumn\(sheet\.events \|\| \[\]\)\);[\s\S]*if \(requestedColumnId && col !== requestedColumnId\) continue;[\s\S]*let complexity = 'unknown';/s,
            'Expected the file fallback to short-circuit non-matching columns before reading plan files for complexity.'
        );
    });

    console.log(`\nResult: ${passed} passed, ${failed} failed`);
    if (failed > 0) {
        process.exit(1);
    }
}

run();
