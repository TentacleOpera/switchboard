'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const TEST_ROOT = path.join(process.cwd(), 'tmp', `state-root-fragmentation-${Date.now()}`);
const PLAN_IMPORTER_PATH = path.join(process.cwd(), 'out', 'services', 'PlanFileImporter.js');
const KANBAN_DB_PATH = path.join(process.cwd(), 'out', 'services', 'KanbanDatabase.js');
const REGISTER_TOOLS_PATH = path.join(process.cwd(), 'src', 'mcp-server', 'register-tools.js');
const STATE_MANAGER_PATH = path.join(process.cwd(), 'src', 'mcp-server', 'state-manager.js');
const EXTENSION_SOURCE = fs.readFileSync(path.join(process.cwd(), 'src', 'extension.ts'), 'utf8');
const MCP_SERVER_SOURCE = fs.readFileSync(path.join(process.cwd(), 'src', 'mcp-server', 'mcp-server.js'), 'utf8');
const REGISTER_TOOLS_SOURCE = fs.readFileSync(REGISTER_TOOLS_PATH, 'utf8');
const REGISTER_MCP_SOURCE = fs.readFileSync(path.join(process.cwd(), 'src', 'mcp-server', 'register-mcp.js'), 'utf8');

const originalWorkspaceRoot = process.env.SWITCHBOARD_WORKSPACE_ROOT;
const originalStateRoot = process.env.SWITCHBOARD_STATE_ROOT;

function readText(result) {
    return result?.content?.[0]?.text || '';
}

function buildPlanContent(sessionId, kanbanColumn) {
    return [
        '# Child Repo Fixture',
        '',
        '## Goal',
        'Verify control-plane state roots win over fragmented child state.',
        '',
        `**Plan ID:** ${sessionId}`,
        `**Session ID:** ${sessionId}`,
        '',
        '## Switchboard State',
        `**Kanban Column:** ${kanbanColumn}`,
        '**Status:** active',
        '**Last Updated:** 2026-04-15T00:00:00.000Z',
        '**Format Version:** 1',
        ''
    ].join('\n');
}

function loadMcpToolHandlers(workspaceRoot, stateRoot) {
    process.env.SWITCHBOARD_WORKSPACE_ROOT = workspaceRoot;
    process.env.SWITCHBOARD_STATE_ROOT = stateRoot;
    delete require.cache[require.resolve(STATE_MANAGER_PATH)];
    delete require.cache[require.resolve(REGISTER_TOOLS_PATH)];

    const stateManager = require(STATE_MANAGER_PATH);
    const { registerTools } = require(REGISTER_TOOLS_PATH);
    const tools = {};
    registerTools({
        tool(name, _schema, handler) {
            tools[name] = handler;
        },
        resource() {
            // no-op for tests
        }
    });

    return { tools, stateManager };
}

async function run() {
    assert.match(
        MCP_SERVER_SOURCE,
        /const SWITCHBOARD_DIR = path\.join\(STATE_ROOT, '\.switchboard'\);/,
        'Expected mcp-server.js to derive the switchboard runtime directory from STATE_ROOT.'
    );
    assert.match(
        REGISTER_TOOLS_SOURCE,
        /function getStateRoot\(\)/,
        'Expected register-tools.js to expose a dedicated state-root helper.'
    );
    assert.match(
        REGISTER_TOOLS_SOURCE,
        /const targetDir = path\.join\(stateRoot, '\.switchboard', requestedBox, storageAgent\);/,
        'Expected check_inbox to read from the effective state root.'
    );
    assert.match(
        REGISTER_MCP_SOURCE,
        /SWITCHBOARD_STATE_ROOT/,
        'Expected register-mcp.js to emit SWITCHBOARD_STATE_ROOT for external registrations.'
    );
    assert.match(
        EXTENSION_SOURCE,
        /importPlanFiles\(\s*workspaceRoot,\s*resolveEffectiveStateRoot\(workspaceRoot\) \|\| workspaceRoot\s*\)/,
        'Expected extension.ts to pass the shared effective state root into importPlanFiles during DB reset.'
    );

    fs.rmSync(TEST_ROOT, { recursive: true, force: true });
    fs.mkdirSync(TEST_ROOT, { recursive: true });

    const { importPlanFiles } = require(PLAN_IMPORTER_PATH);
    const { KanbanDatabase } = require(KANBAN_DB_PATH);

    const controlPlaneRoot = path.join(TEST_ROOT, 'control-plane');
    const childRepoRoot = path.join(controlPlaneRoot, 'child-repo');
    const controlPlaneSwitchboard = path.join(controlPlaneRoot, '.switchboard');
    const childSwitchboard = path.join(childRepoRoot, '.switchboard');
    const childPlansDir = path.join(childSwitchboard, 'plans');

    fs.mkdirSync(controlPlaneSwitchboard, { recursive: true });
    fs.mkdirSync(childPlansDir, { recursive: true });
    fs.writeFileSync(path.join(controlPlaneSwitchboard, 'kanban.db'), 'stub', 'utf8');
    fs.writeFileSync(
        path.join(controlPlaneSwitchboard, 'state.json'),
        JSON.stringify({
            customAgents: [],
            customKanbanColumns: [
                {
                    id: 'custom_column_docs_ready',
                    label: 'Docs Ready',
                    role: 'coder',
                    order: 250,
                    dragDropMode: 'cli'
                }
            ]
        }, null, 2),
        'utf8'
    );
    fs.writeFileSync(
        path.join(childSwitchboard, 'state.json'),
        JSON.stringify({
            customAgents: [],
            customKanbanColumns: []
        }, null, 2),
        'utf8'
    );
    fs.writeFileSync(
        path.join(childPlansDir, 'child-fixture.md'),
        buildPlanContent('child-fragmentation-fixture', 'custom_column_docs_ready'),
        'utf8'
    );

    const imported = await importPlanFiles(childRepoRoot, controlPlaneRoot);
    assert.strictEqual(imported.count, 1, 'Expected importPlanFiles to discover the child plan fixture.');

    const db = KanbanDatabase.forWorkspace(childRepoRoot);
    try {
        const ready = await db.ensureReady();
        assert.strictEqual(ready, true, 'Expected child repo KanbanDatabase to initialize for regression coverage.');

        const importedPlan = await db.getPlanBySessionId('child-fragmentation-fixture');
        assert.ok(importedPlan, 'Expected imported child fixture to be persisted.');
        assert.strictEqual(
            importedPlan?.kanbanColumn,
            'custom_column_docs_ready',
            'Expected child plan import to validate custom columns against the parent control-plane state.json.'
        );
    } finally {
        await KanbanDatabase.invalidateWorkspace(childRepoRoot);
    }

    const repoRoot = path.join(TEST_ROOT, 'repo-root');
    const stateRoot = path.join(TEST_ROOT, 'runtime-state-root');
    fs.mkdirSync(repoRoot, { recursive: true });
    fs.mkdirSync(stateRoot, { recursive: true });

    const { tools, stateManager } = loadMcpToolHandlers(repoRoot, stateRoot);
    const { updateState } = stateManager;

    await updateState((current) => {
        current.session.activeWorkflow = 'handoff';
        current.session.status = 'IN_PROGRESS';
        current.session.currentStep = 1;
        return current;
    });

    const statusResult = await tools.set_agent_status({ name: 'planner', status: 'active' });
    assert.ok(!statusResult.isError, readText(statusResult));
    assert.ok(
        fs.existsSync(path.join(stateRoot, '.switchboard', 'inbox', 'planner')),
        'Expected set_agent_status auto-provisioning to create inboxes under the shared state root.'
    );
    assert.ok(
        !fs.existsSync(path.join(repoRoot, '.switchboard', 'inbox', 'planner')),
        'Expected repo workspace root not to receive auto-provisioned inboxes when a state root override is set.'
    );

    const sendResult = await tools.send_message({ action: 'delegate_task', payload: 'Do the shared task.' });
    assert.ok(!sendResult.isError, readText(sendResult));
    const coderInbox = path.join(stateRoot, '.switchboard', 'inbox', 'coder');
    assert.ok(fs.existsSync(coderInbox), 'Expected send_message to persist routed inbox messages under the shared state root.');
    assert.ok(
        !fs.existsSync(path.join(repoRoot, '.switchboard', 'inbox', 'coder')),
        'Expected repo workspace root not to receive routed inbox messages when a state root override is set.'
    );

    const inboxResult = await tools.check_inbox({ agent: 'coder', box: 'inbox', verbose: true });
    assert.ok(!inboxResult.isError, readText(inboxResult));
    assert.match(
        readText(inboxResult),
        /Do the shared task\./,
        'Expected check_inbox to read the durable inbox payload from the shared state root.'
    );

    fs.rmSync(TEST_ROOT, { recursive: true, force: true });

    if (originalWorkspaceRoot === undefined) {
        delete process.env.SWITCHBOARD_WORKSPACE_ROOT;
    } else {
        process.env.SWITCHBOARD_WORKSPACE_ROOT = originalWorkspaceRoot;
    }

    if (originalStateRoot === undefined) {
        delete process.env.SWITCHBOARD_STATE_ROOT;
    } else {
        process.env.SWITCHBOARD_STATE_ROOT = originalStateRoot;
    }

    console.log('state root fragmentation regression test passed');
}

run().catch((error) => {
    if (originalWorkspaceRoot === undefined) {
        delete process.env.SWITCHBOARD_WORKSPACE_ROOT;
    } else {
        process.env.SWITCHBOARD_WORKSPACE_ROOT = originalWorkspaceRoot;
    }

    if (originalStateRoot === undefined) {
        delete process.env.SWITCHBOARD_STATE_ROOT;
    } else {
        process.env.SWITCHBOARD_STATE_ROOT = originalStateRoot;
    }

    console.error('state root fragmentation regression test failed:', error);
    process.exit(1);
});
