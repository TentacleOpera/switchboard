/**
 * Resilience Fixes Tests
 * Tests for improved error messages and --all phase-gate bypass
 * Run with: node src/test/resilience-fixes.test.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const TEST_ROOT = path.join(os.tmpdir(), `switchboard-resilience-fixes-${Date.now()}`);
const STATE_DIR = path.join(TEST_ROOT, '.switchboard');
const STATE_FILE = path.join(STATE_DIR, 'state.json');

process.env.SWITCHBOARD_WORKSPACE_ROOT = TEST_ROOT;
fs.mkdirSync(STATE_DIR, { recursive: true });

delete require.cache[require.resolve('../mcp-server/state-manager')];
delete require.cache[require.resolve('../mcp-server/register-tools')];

const { updateState } = require('../mcp-server/state-manager');
const { registerTools } = require('../mcp-server/register-tools');

const tools = {};
const mockServer = {
    tool(name, _schema, handler) {
        tools[name] = handler;
    },
    resource() {
        // no-op for unit tests
    }
};
registerTools(mockServer);
const sendMessage = tools.send_message;

let passed = 0;
let failed = 0;

function readText(result) {
    return result?.content?.[0]?.text || '';
}

async function resetWorkspace() {
    if (fs.existsSync(TEST_ROOT)) {
        fs.rmSync(TEST_ROOT, { recursive: true, force: true });
    }
    fs.mkdirSync(STATE_DIR, { recursive: true });
}

async function seedState({ sessionWorkflow = 'handoff', currentStep = 0 } = {}) {
    await updateState(state => {
        state.session = state.session || {};
        state.session.activeWorkflow = sessionWorkflow;
        state.session.status = sessionWorkflow ? 'IN_PROGRESS' : 'IDLE';
        state.session.currentStep = currentStep;
        return state;
    });
}

async function test(name, fn) {
    try {
        await resetWorkspace();
        await fn();
        console.log(`  ✓ PASS ${name}`);
        passed++;
    } catch (e) {
        console.error(`  ✗ FAIL ${name}: ${e.message}`);
        failed++;
    }
}

async function run() {
    console.log('\n=== Resilience Fixes Tests ===\n');

    // Test 1: Routing rejection message includes valid actions
    await test('routing rejection message includes valid actions list', async () => {
        await seedState({ sessionWorkflow: 'challenge', currentStep: 1 });

        const result = await sendMessage({
            action: 'delegate_task',  // Wrong action for challenge
            payload: 'review this'
        });

        assert.strictEqual(result.isError, true);
        const text = readText(result);
        
        // Should mention the action is not valid
        assert.match(text, /Action 'delegate_task' is not valid/i, 'Should say action is not valid');
        
        // Should list valid actions
        assert.match(text, /Valid actions for 'challenge'/i, 'Should mention valid actions');
        assert.match(text, /'execute'/i, 'Should list execute as valid action');
        
        // Should suggest correction
        assert.match(text, /Did you mean action:/i, 'Should suggest correction');
    });

    // Test 2: --all flag bypasses phase-gate for handoff
    await test('--all flag bypasses phase-gate for handoff workflow', async () => {
        await seedState({ sessionWorkflow: 'handoff', currentStep: 0 });

        // Without --all, should be blocked
        const blockedResult = await sendMessage({
            action: 'execute',
            payload: 'do work',
            metadata: {}
        });

        assert.strictEqual(blockedResult.isError, true);
        const blockedText = readText(blockedResult);
        assert.match(blockedText, /PHASE-GATE BLOCKED/i, 'Should block without --all');

        // With --all, should succeed (even though step is 0)
        await seedState({ sessionWorkflow: 'handoff', currentStep: 0 });
        const successResult = await sendMessage({
            action: 'execute',
            payload: 'do all work',
            metadata: { all: true }
        });

        assert.ok(!successResult.isError, `Should succeed with --all: ${readText(successResult)}`);
    });

    // Test 3: removed standby workflow no longer accepts delegation
    await test('removed standby workflow rejects delegation action', async () => {
        await seedState({ sessionWorkflow: 'standby', currentStep: 0 });

        const result = await sendMessage({
            action: 'delegate_task',
            payload: 'do work',
            metadata: {}
        });

        assert.strictEqual(result.isError, true);
        assert.match(readText(result), /is not valid for workflow 'standby'/i);
    });

    // Test 4: challenge execute does not require phase-gate bypass
    await test('challenge execute works at step 0 without --all', async () => {
        await seedState({ sessionWorkflow: 'challenge', currentStep: 0 });

        const result = await sendMessage({
            action: 'execute',
            payload: 'review this',
            metadata: {}
        });

        assert.ok(!result.isError, `Challenge execute should not be phase-gated: ${readText(result)}`);
    });

    // Test 5: Phase-gate error message is helpful
    await test('phase-gate error message includes helpful details', async () => {
        await seedState({ sessionWorkflow: 'handoff', currentStep: 0 });

        const result = await sendMessage({
            action: 'execute',
            payload: 'do work',
            metadata: {}
        });

        assert.strictEqual(result.isError, true);
        const text = readText(result);
        
        // Should mention phase-gate blocked
        assert.match(text, /PHASE-GATE BLOCKED/i, 'Should say phase-gate blocked');
        
        // Should mention what's required
        assert.match(text, /Required:/i, 'Should mention what is required');
        assert.match(text, /complete_workflow_phase/i, 'Should suggest complete_workflow_phase');
        
        // Should mention evidence expected
        assert.match(text, /Evidence expected:/i, 'Should mention evidence expected');
        
        // Should mention --all tip
        assert.match(text, /Tip:.*--all/i, 'Should suggest --all flag');
    });

    console.log(`\n=== Results ===`);
    console.log(`Passed: ${passed}`);
    console.log(`Failed: ${failed}`);
    console.log(`Total:  ${passed + failed}\n`);

    process.exit(failed > 0 ? 1 : 0);
}

run().catch(err => {
    console.error('Test suite failed:', err);
    process.exit(1);
});
