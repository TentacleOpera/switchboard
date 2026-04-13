const assert = require('assert');
const path = require('path');
const { parseCustomAgents, parseCustomKanbanColumns, buildKanbanColumns, reweightSequence } = require(path.join(process.cwd(), 'out', 'services', 'agentConfig.js'));

describe('agentConfig — dragDropMode', () => {
    describe('parseCustomAgents()', () => {
        const baseAgent = {
            id: 'test_agent',
            name: 'Test Agent',
            startupCommand: 'test-cli run',
            includeInKanban: true,
            kanbanOrder: 400
        };

        it('returns dragDropMode "cli" when field is missing', () => {
            const agents = parseCustomAgents([{ ...baseAgent }]);
            assert.strictEqual(agents.length, 1);
            assert.strictEqual(agents[0].dragDropMode, 'cli');
        });

        it('returns dragDropMode "prompt" when explicitly set', () => {
            const agents = parseCustomAgents([{ ...baseAgent, dragDropMode: 'prompt' }]);
            assert.strictEqual(agents.length, 1);
            assert.strictEqual(agents[0].dragDropMode, 'prompt');
        });

        it('returns dragDropMode "cli" for invalid values', () => {
            const agents = parseCustomAgents([{ ...baseAgent, dragDropMode: 'banana' }]);
            assert.strictEqual(agents.length, 1);
            assert.strictEqual(agents[0].dragDropMode, 'cli');
        });

        it('returns dragDropMode "cli" when value is null', () => {
            const agents = parseCustomAgents([{ ...baseAgent, dragDropMode: null }]);
            assert.strictEqual(agents.length, 1);
            assert.strictEqual(agents[0].dragDropMode, 'cli');
        });

        it('returns dragDropMode "cli" when value is undefined', () => {
            const agents = parseCustomAgents([{ ...baseAgent, dragDropMode: undefined }]);
            assert.strictEqual(agents.length, 1);
            assert.strictEqual(agents[0].dragDropMode, 'cli');
        });
    });

    describe('buildKanbanColumns()', () => {
        it('sets dragDropMode "cli" on all default columns', () => {
            const columns = buildKanbanColumns([]);
            for (const col of columns) {
                assert.strictEqual(col.dragDropMode, 'cli', `Default column "${col.id}" should have dragDropMode "cli"`);
            }
        });

        it('propagates dragDropMode from custom agent', () => {
            const agents = parseCustomAgents([{
                id: 'prompt_agent',
                name: 'Prompt Agent',
                startupCommand: 'prompt-cli run',
                includeInKanban: true,
                kanbanOrder: 400,
                dragDropMode: 'prompt'
            }]);
            const columns = buildKanbanColumns(agents);
            const customCol = columns.find(c => c.kind === 'custom-agent');
            assert.ok(customCol, 'Custom column should exist');
            assert.strictEqual(customCol.dragDropMode, 'prompt');
        });

        it('propagates dragDropMode "cli" from custom agent when not specified', () => {
            const agents = parseCustomAgents([{
                id: 'cli_agent',
                name: 'CLI Agent',
                startupCommand: 'cli-tool run',
                includeInKanban: true,
                kanbanOrder: 400
            }]);
            const columns = buildKanbanColumns(agents);
            const customCol = columns.find(c => c.kind === 'custom-agent');
            assert.ok(customCol, 'Custom column should exist');
            assert.strictEqual(customCol.dragDropMode, 'cli');
        });

        it('propagates persisted user-authored kanban columns with prompt metadata', () => {
            const userColumns = parseCustomKanbanColumns([{
                id: 'design_review',
                label: 'Design Review',
                role: 'reviewer',
                triggerPrompt: 'Review architecture decisions before implementation.',
                order: 275,
                dragDropMode: 'prompt'
            }]);
            const columns = buildKanbanColumns([], userColumns);
            const customCol = columns.find(c => c.kind === 'custom-user');
            assert.ok(customCol, 'User-authored column should exist');
            assert.strictEqual(customCol.source, 'custom-user');
            assert.strictEqual(customCol.dragDropMode, 'prompt');
            assert.strictEqual(customCol.triggerPrompt, 'Review architecture decisions before implementation.');
        });

        it('applies persisted built-in order overrides', () => {
            const columns = buildKanbanColumns([], {
                orderOverrides: {
                    'CODE REVIEWED': 150,
                    'LEAD CODED': 250
                }
            });
            const orderedIds = columns.map(column => column.id);
            assert.ok(
                orderedIds.indexOf('CODE REVIEWED') < orderedIds.indexOf('LEAD CODED'),
                'Expected built-in overrides to change sorted column order.'
            );
        });
    });

    describe('reweightSequence()', () => {
        it('returns deterministic gap-based weights', () => {
            assert.deepStrictEqual(
                reweightSequence(['PLAN REVIEWED', 'LEAD CODED', 'CODER CODED']),
                {
                    'PLAN REVIEWED': 100,
                    'LEAD CODED': 200,
                    'CODER CODED': 300
                }
            );
        });

        it('ignores duplicate and fixed-anchor IDs', () => {
            assert.deepStrictEqual(
                reweightSequence(['CREATED', 'PLAN REVIEWED', 'PLAN REVIEWED', 'COMPLETED', 'LEAD CODED']),
                {
                    'PLAN REVIEWED': 100,
                    'LEAD CODED': 200
                }
            );
        });
    });
});
