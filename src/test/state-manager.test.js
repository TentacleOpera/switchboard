/**
 * Unit tests for state-manager.js
 * Run with: node src/test/state-manager.test.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const TEST_ROOT = path.join(process.cwd(), 'tmp', `state-manager-test-${Date.now()}`);
const LOCAL_WORKSPACE_ROOT = path.join(TEST_ROOT, 'workspace');
const SHARED_WORKSPACE_ROOT = path.join(TEST_ROOT, 'repo-workspace');
const SHARED_STATE_ROOT = path.join(TEST_ROOT, 'control-plane');
const MODULE_PATH = '../mcp-server/state-manager';

const originalWorkspaceRoot = process.env.SWITCHBOARD_WORKSPACE_ROOT;
const originalStateRoot = process.env.SWITCHBOARD_STATE_ROOT;

let passed = 0;
let failed = 0;

function stateFileFor(root) {
    return path.join(root, '.switchboard', 'state.json');
}

function resetDirectory(root) {
    fs.rmSync(root, { recursive: true, force: true });
    fs.mkdirSync(path.join(root, '.switchboard'), { recursive: true });
}

function loadStateManager({ workspaceRoot = LOCAL_WORKSPACE_ROOT, stateRoot } = {}) {
    if (workspaceRoot) {
        process.env.SWITCHBOARD_WORKSPACE_ROOT = workspaceRoot;
    } else {
        delete process.env.SWITCHBOARD_WORKSPACE_ROOT;
    }

    if (stateRoot) {
        process.env.SWITCHBOARD_STATE_ROOT = stateRoot;
    } else {
        delete process.env.SWITCHBOARD_STATE_ROOT;
    }

    delete require.cache[require.resolve(MODULE_PATH)];
    return require(MODULE_PATH);
}

async function test(name, fn) {
    try {
        resetDirectory(LOCAL_WORKSPACE_ROOT);
        resetDirectory(SHARED_WORKSPACE_ROOT);
        resetDirectory(SHARED_STATE_ROOT);
        await fn();
        console.log(`  ✅ ${name}`);
        passed++;
    } catch (e) {
        console.error(`  ❌ ${name}: ${e.message}`);
        failed++;
    }
}

async function run() {
    console.log('\n🧪 State Manager Tests\n');

    await test('loadState returns INITIAL_STATE when no file exists', async () => {
        const { loadState } = loadStateManager();
        const state = await loadState();
        assert.strictEqual(state.session.status, 'IDLE');
        assert.strictEqual(state.session.activeWorkflow, null);
        assert.deepStrictEqual(state.terminals, {});
    });

    await test('loadState creates state file on first call', async () => {
        const { loadState } = loadStateManager();
        await loadState();
        assert.ok(fs.existsSync(stateFileFor(LOCAL_WORKSPACE_ROOT)), 'state.json should exist after loadState');
    });

    await test('updateState persists changes', async () => {
        const { loadState, updateState } = loadStateManager();
        await updateState(current => {
            current.session.activeWorkflow = 'test-workflow';
            current.session.status = 'IN_PROGRESS';
            return current;
        });

        const state = await loadState();
        assert.strictEqual(state.session.activeWorkflow, 'test-workflow');
        assert.strictEqual(state.session.status, 'IN_PROGRESS');
    });

    await test('updateState is atomic (temp file cleaned up)', async () => {
        const { updateState } = loadStateManager();
        await updateState(current => {
            current.tasks.push('task-1');
            return current;
        });

        const files = fs.readdirSync(path.join(LOCAL_WORKSPACE_ROOT, '.switchboard'));
        const tmpFiles = files.filter(f => f.endsWith('.tmp'));
        assert.strictEqual(tmpFiles.length, 0, `Found leftover tmp files: ${tmpFiles.join(', ')}`);
    });

    await test('updateState handles terminal registration', async () => {
        const { loadState, updateState } = loadStateManager();
        await updateState(current => {
            current.terminals.coding = {
                purpose: 'coding',
                pid: 12345,
                status: 'active',
                friendlyName: 'Coding',
                icon: 'code',
                color: 'blue'
            };
            return current;
        });

        const state = await loadState();
        assert.ok(state.terminals.coding, 'Terminal should be registered');
        assert.strictEqual(state.terminals.coding.pid, 12345);
    });

    await test('concurrent updateState calls do not corrupt state', async () => {
        const { loadState, updateState } = loadStateManager();
        await updateState(current => {
            current.tasks = [];
            return current;
        });

        const promises = [];
        for (let i = 0; i < 5; i++) {
            promises.push(updateState(current => {
                current.tasks.push(`task-${i}`);
                return current;
            }));
        }

        await Promise.all(promises);

        const state = await loadState();
        assert.strictEqual(state.tasks.length, 5, `Expected 5 tasks, got ${state.tasks.length}`);
    });

    await test('loadState recovers from corrupt JSON', async () => {
        const { loadState } = loadStateManager();
        fs.writeFileSync(stateFileFor(LOCAL_WORKSPACE_ROOT), '{ broken json !!!');
        const state = await loadState();
        assert.strictEqual(state.session.status, 'IDLE');
    });

    await test('updateState preserves unrelated fields', async () => {
        const { loadState, updateState } = loadStateManager();
        await updateState(current => {
            current.session.activeWorkflow = 'review';
            current.terminals.test = { pid: 999 };
            return current;
        });

        await updateState(current => {
            current.session.status = 'IN_PROGRESS';
            return current;
        });

        const state = await loadState();
        assert.strictEqual(state.session.activeWorkflow, 'review');
        assert.strictEqual(state.session.status, 'IN_PROGRESS');
        assert.ok(state.terminals.test, 'Terminal should still exist');
    });

    await test('state root env overrides workspace root for persisted state', async () => {
        const { loadState, updateState } = loadStateManager({
            workspaceRoot: SHARED_WORKSPACE_ROOT,
            stateRoot: SHARED_STATE_ROOT
        });

        await loadState();
        await updateState(current => {
            current.session.id = 'shared-session';
            return current;
        });

        assert.ok(fs.existsSync(stateFileFor(SHARED_STATE_ROOT)), 'Expected state.json to be created under the override state root.');
        assert.ok(!fs.existsSync(stateFileFor(SHARED_WORKSPACE_ROOT)), 'Expected repo workspace root not to get its own state.json when state root override is set.');

        const persisted = JSON.parse(fs.readFileSync(stateFileFor(SHARED_STATE_ROOT), 'utf8'));
        assert.strictEqual(persisted.session.id, 'shared-session');
    });

    try {
        fs.rmSync(TEST_ROOT, { recursive: true, force: true });
    } catch { }

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

    console.log(`\n📊 Results: ${passed} passed, ${failed} failed\n`);
    process.exit(failed > 0 ? 1 : 0);
}

run();
