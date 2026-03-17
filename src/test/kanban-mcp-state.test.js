/**
 * Regression tests for get_kanban_state MCP tool filtering and labels.
 * Run with: node src/test/kanban-mcp-state.test.js
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TEST_ROOT = path.join(os.tmpdir(), `switchboard-kanban-mcp-${Date.now()}`);
const SWITCHBOARD_DIR = path.join(TEST_ROOT, '.switchboard');
const SESSIONS_DIR = path.join(SWITCHBOARD_DIR, 'sessions');

let passed = 0;
let failed = 0;

function readText(result) {
    return result?.content?.[0]?.text || '';
}

function loadGetKanbanStateTool() {
    process.env.SWITCHBOARD_WORKSPACE_ROOT = TEST_ROOT;
    delete require.cache[require.resolve('../mcp-server/state-manager')];
    delete require.cache[require.resolve('../mcp-server/register-tools')];

    const { registerTools } = require('../mcp-server/register-tools');
    const tools = {};
    registerTools({
        tool(name, _schema, handler) {
            tools[name] = handler;
        },
        resource() {
            // no-op in tests
        }
    });

    return tools.get_kanban_state;
}

function writeJson(filePath, value) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function resetWorkspace() {
    if (fs.existsSync(TEST_ROOT)) {
        fs.rmSync(TEST_ROOT, { recursive: true, force: true });
    }

    fs.mkdirSync(SESSIONS_DIR, { recursive: true });
    writeJson(path.join(SWITCHBOARD_DIR, 'workspace_identity.json'), { workspaceId: 'ws-test' });
    writeJson(path.join(SWITCHBOARD_DIR, 'plan_registry.json'), {
        entries: {
            'sess-created': { ownerWorkspaceId: 'ws-test', status: 'active' },
            'sess-reviewed': { ownerWorkspaceId: 'ws-test', status: 'active' }
        }
    });

    writeJson(path.join(SESSIONS_DIR, 'sess-created.json'), {
        sessionId: 'sess-created',
        topic: 'Created ticket',
        createdAt: '2026-03-17T00:00:00.000Z',
        completed: false,
        events: []
    });

    writeJson(path.join(SESSIONS_DIR, 'sess-reviewed.json'), {
        sessionId: 'sess-reviewed',
        topic: 'Reviewed ticket',
        createdAt: '2026-03-17T01:00:00.000Z',
        completed: false,
        events: [{ workflow: 'improve-plan' }]
    });
}

async function test(name, fn) {
    try {
        resetWorkspace();
        await fn();
        console.log(`  PASS ${name}`);
        passed += 1;
    } catch (error) {
        console.error(`  FAIL ${name}: ${error.message}`);
        failed += 1;
    }
}

async function run() {
    console.log('\nRunning kanban MCP state tests\n');

    await test('get_kanban_state returns all built-in columns with UI labels', async () => {
        const getKanbanState = loadGetKanbanStateTool();
        const result = await getKanbanState({});
        const payload = JSON.parse(readText(result));

        assert.deepStrictEqual(
            Object.keys(payload),
            ['CREATED', 'PLAN REVIEWED', 'LEAD CODED', 'CODER CODED', 'CODE REVIEWED']
        );
        assert.strictEqual(payload.CREATED.label, 'Plan Created');
        assert.strictEqual(payload['PLAN REVIEWED'].label, 'Planned');
        assert.strictEqual(payload['LEAD CODED'].label, 'Lead Coder');
        assert.strictEqual(payload['CODER CODED'].label, 'Coder');
        assert.strictEqual(payload['CODE REVIEWED'].label, 'Reviewed');
        assert.strictEqual(payload.CREATED.items.length, 1);
        assert.strictEqual(payload['PLAN REVIEWED'].items.length, 1);
        assert.strictEqual(payload['LEAD CODED'].items.length, 0);
    });

    await test('get_kanban_state filters to a single column by id, alias, or UI label', async () => {
        const getKanbanState = loadGetKanbanStateTool();

        const fullResult = await getKanbanState({});
        const filteredById = await getKanbanState({ column: 'CREATED' });
        const filteredByAlias = await getKanbanState({ column: 'Plan Created' });
        const filteredByLabel = await getKanbanState({ column: 'Planned' });

        const filteredByIdPayload = JSON.parse(readText(filteredById));
        const filteredByAliasPayload = JSON.parse(readText(filteredByAlias));
        const filteredByLabelPayload = JSON.parse(readText(filteredByLabel));

        assert.deepStrictEqual(Object.keys(filteredByIdPayload), ['CREATED']);
        assert.strictEqual(filteredByIdPayload.CREATED.label, 'Plan Created');
        assert.strictEqual(filteredByIdPayload.CREATED.items.length, 1);

        assert.deepStrictEqual(Object.keys(filteredByAliasPayload), ['CREATED']);
        assert.strictEqual(filteredByAliasPayload.CREATED.label, 'Plan Created');
        assert.strictEqual(filteredByAliasPayload.CREATED.items.length, 1);

        assert.deepStrictEqual(Object.keys(filteredByLabelPayload), ['PLAN REVIEWED']);
        assert.strictEqual(filteredByLabelPayload['PLAN REVIEWED'].label, 'Planned');
        assert.strictEqual(filteredByLabelPayload['PLAN REVIEWED'].items.length, 1);

        assert.ok(
            readText(filteredById).length < readText(fullResult).length,
            'Expected filtered kanban output to be smaller than the full board payload.'
        );
    });

    await test('get_kanban_state rejects unknown columns with available labels', async () => {
        const getKanbanState = loadGetKanbanStateTool();
        const result = await getKanbanState({ column: 'Does Not Exist' });

        assert.strictEqual(result.isError, true);
        assert.match(readText(result), /Unknown kanban column 'Does Not Exist'/);
        assert.match(readText(result), /CREATED \(Plan Created\)/);
        assert.match(readText(result), /PLAN REVIEWED \(Planned\)/);
    });

    if (failed > 0) {
        console.error(`\n${failed} kanban MCP state test(s) failed.`);
        process.exitCode = 1;
        return;
    }

    console.log(`\nAll ${passed} kanban MCP state test(s) passed.`);
}

run().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
