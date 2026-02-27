/**
 * Unit tests for state-manager.js
 * Run with: node src/test/state-manager.test.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Create isolated temp directory for each test run
const TEST_ROOT = path.join(os.tmpdir(), `switchboard-test-${Date.now()}`);
const STATE_DIR = path.join(TEST_ROOT, '.switchboard');
const STATE_FILE = path.join(STATE_DIR, 'state.json');

// Override env before requiring the module
process.env.SWITCHBOARD_WORKSPACE_ROOT = TEST_ROOT;
fs.mkdirSync(STATE_DIR, { recursive: true });

// Clear module cache to force re-initialization with test root
delete require.cache[require.resolve('../mcp-server/state-manager')];
const { loadState, updateState, INITIAL_STATE } = require('../mcp-server/state-manager');

let passed = 0;
let failed = 0;

async function test(name, fn) {
    try {
        // Clean state before each test
        if (fs.existsSync(STATE_FILE)) fs.unlinkSync(STATE_FILE);
        // Clean any stale lock files
        const lockFile = `${STATE_FILE}.lock`;
        if (fs.existsSync(lockFile)) {
            try { fs.unlinkSync(lockFile); } catch { }
        }

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
        const state = await loadState();
        assert.strictEqual(state.session.status, 'IDLE');
        assert.strictEqual(state.session.activeWorkflow, null);
        assert.deepStrictEqual(state.terminals, {});
    });

    await test('loadState creates state file on first call', async () => {
        await loadState();
        assert.ok(fs.existsSync(STATE_FILE), 'state.json should exist after loadState');
    });

    await test('updateState persists changes', async () => {
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
        await updateState(current => {
            current.tasks.push('task-1');
            return current;
        });

        // No .tmp files should remain
        const files = fs.readdirSync(STATE_DIR);
        const tmpFiles = files.filter(f => f.endsWith('.tmp'));
        assert.strictEqual(tmpFiles.length, 0, `Found leftover tmp files: ${tmpFiles.join(', ')}`);
    });

    await test('updateState handles terminal registration', async () => {
        await updateState(current => {
            current.terminals['coding'] = {
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
        assert.ok(state.terminals['coding'], 'Terminal should be registered');
        assert.strictEqual(state.terminals['coding'].pid, 12345);
    });

    await test('concurrent updateState calls do not corrupt state', async () => {
        // Initialize
        await updateState(current => {
            current.tasks = [];
            return current;
        });

        // Run 5 concurrent updates
        const promises = [];
        for (let i = 0; i < 5; i++) {
            promises.push(updateState(current => {
                current.tasks.push(`task-${i}`);
                return current;
            }));
        }

        await Promise.all(promises);

        const state = await loadState();
        // All 5 tasks should be present (proper-lockfile serializes them)
        assert.strictEqual(state.tasks.length, 5, `Expected 5 tasks, got ${state.tasks.length}`);
    });

    await test('loadState recovers from corrupt JSON', async () => {
        fs.writeFileSync(STATE_FILE, '{ broken json !!!');
        const state = await loadState();
        // Should return INITIAL_STATE on parse error
        assert.strictEqual(state.session.status, 'IDLE');
    });

    await test('updateState preserves unrelated fields', async () => {
        await updateState(current => {
            current.session.activeWorkflow = 'review';
            current.terminals['test'] = { pid: 999 };
            return current;
        });

        await updateState(current => {
            current.session.status = 'IN_PROGRESS';
            return current;
        });

        const state = await loadState();
        assert.strictEqual(state.session.activeWorkflow, 'review');
        assert.strictEqual(state.session.status, 'IN_PROGRESS');
        assert.ok(state.terminals['test'], 'Terminal should still exist');
    });

    // Cleanup
    try {
        fs.rmSync(TEST_ROOT, { recursive: true, force: true });
    } catch { }

    console.log(`\n📊 Results: ${passed} passed, ${failed} failed\n`);
    process.exit(failed > 0 ? 1 : 0);
}

run();
