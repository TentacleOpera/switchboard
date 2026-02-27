/**
 * Regression tests for workflow control ergonomics.
 * Run with: node src/test/workflow-controls.test.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const TEST_ROOT = path.join(os.tmpdir(), `switchboard-workflow-controls-${Date.now()}`);
const STATE_DIR = path.join(TEST_ROOT, '.switchboard');

process.env.SWITCHBOARD_WORKSPACE_ROOT = TEST_ROOT;
fs.mkdirSync(STATE_DIR, { recursive: true });

delete require.cache[require.resolve('../mcp-server/state-manager')];
delete require.cache[require.resolve('../mcp-server/register-tools')];

const { updateState } = require('../mcp-server/state-manager');
const { registerTools } = require('../mcp-server/register-tools');
const { WORKFLOWS } = require('../mcp-server/workflows');

const tools = {};
registerTools({
    tool(name, _schema, handler) {
        tools[name] = handler;
    },
    resource() {
        // no-op in tests
    }
});

const startWorkflow = tools.start_workflow;
const stopWorkflow = tools.stop_workflow;
const completeWorkflowPhase = tools.complete_workflow_phase;
const sendMessage = tools.send_message;
const runInTerminal = tools.run_in_terminal;

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

async function test(name, fn) {
    try {
        await resetWorkspace();
        await fn();
        console.log(`  PASS ${name}`);
        passed++;
    } catch (e) {
        console.error(`  FAIL ${name}: ${e.message}`);
        failed++;
    }
}

async function run() {
    console.log('\nRunning workflow control tests\n');

    await test('start_workflow blocks without force when another workflow is active', async () => {
        await updateState(state => {
            state.session.activeWorkflow = 'challenge';
            state.session.status = 'IN_PROGRESS';
            state.session.currentStep = 1;
            return state;
        });

        const result = await startWorkflow({ name: 'challenge' });
        assert.strictEqual(result.isError, true);
        assert.match(readText(result), /WORKFLOW LOCK/i);
    });

    await test('start_workflow force=true replaces active workflow', async () => {
        await updateState(state => {
            state.session.activeWorkflow = 'challenge';
            state.session.status = 'IN_PROGRESS';
            state.session.currentStep = 2;
            return state;
        });

        const result = await startWorkflow({ name: 'challenge', force: true });
        assert.ok(!result.isError, readText(result));
        assert.match(readText(result), /Force-stopped 'challenge'/i);
        assert.match(readText(result), /Started workflow 'Challenge/i);
    });


    await test('start_workflow clears stale session initialContext when omitted', async () => {
        await updateState(state => {
            state.session.initialContext = 'stale previous context';
            return state;
        });
    });

    await test('start_workflow switchboard alias initializes chat mode', async () => {
        const result = await startWorkflow({ name: 'switchboard' });
        assert.ok(!result.isError, readText(result));
        assert.match(readText(result), /Chat Consultation Mode/i);
    });

    await test('complete_workflow_phase resolves workspace-relative artifact paths', async () => {
        const relativeArtifact = path.join('.switchboard', 'handoff', 'relative-artifact.md');
        const artifactAbs = path.join(TEST_ROOT, relativeArtifact);
        fs.mkdirSync(path.dirname(artifactAbs), { recursive: true });
        fs.writeFileSync(artifactAbs, '# artifact');

        const start = await startWorkflow({ name: 'challenge' });
        assert.ok(!start.isError, readText(start));

        const phase = await completeWorkflowPhase({
            workflow: 'challenge',
            phase: 1,
            artifacts: [{ path: relativeArtifact, description: 'staged request' }]
        });

        assert.ok(!phase.isError, readText(phase));
        assert.match(readText(phase), /PHASE 1 COMPLETE/i);
    });

    await test('complete_workflow_phase accepts absolute artifact paths', async () => {
        const relativeArtifact = path.join('.switchboard', 'handoff', 'absolute-artifact.md');
        const artifactAbs = path.join(TEST_ROOT, relativeArtifact);
        fs.mkdirSync(path.dirname(artifactAbs), { recursive: true });
        fs.writeFileSync(artifactAbs, '# artifact');

        const start = await startWorkflow({ name: 'challenge' });
        assert.ok(!start.isError, readText(start));

        const phase = await completeWorkflowPhase({
            workflow: 'challenge',
            phase: 1,
            artifacts: [{ path: artifactAbs, description: 'absolute artifact path' }]
        });

        assert.ok(!phase.isError, readText(phase));
        assert.match(readText(phase), /PHASE 1 COMPLETE/i);
    });

    await test('challenge phase 2 accepts send_message evidence across calls', async () => {
        const stageArtifact = path.join('.switchboard', 'handoff', 'implementation_plan.md');
        const stageArtifactAbs = path.join(TEST_ROOT, stageArtifact);
        fs.mkdirSync(path.dirname(stageArtifactAbs), { recursive: true });
        fs.writeFileSync(stageArtifactAbs, '# plan');

        const start = await startWorkflow({ name: 'challenge' });
        assert.ok(!start.isError, readText(start));

        const phase1 = await completeWorkflowPhase({
            workflow: 'challenge',
            phase: 1,
            artifacts: [{ path: stageArtifact, description: 'staged request' }]
        });
        assert.ok(!phase1.isError, readText(phase1));

        const dispatch = await sendMessage({
            action: 'execute',
            payload: 'Review this plan',
            metadata: {
                review: {
                    authorized_plan: stageArtifact,
                    report_path: '.switchboard/handoff/challenge_report_test.md'
                }
            }
        });
        assert.ok(!dispatch.isError, readText(dispatch));

        const phase2 = await completeWorkflowPhase({
            workflow: 'challenge',
            phase: 2,
            artifacts: [{ path: '.switchboard/handoff', description: 'dispatch metadata captured' }]
        });
        assert.ok(!phase2.isError, readText(phase2));
        assert.match(readText(phase2), /PHASE 2 COMPLETE/i);
    });


    await test('start_workflow reports stale runtime when workflow markdown exists but runtime entry is missing', async () => {
        const workflowMdPath = path.join(TEST_ROOT, '.agent', 'workflows', 'phantom.md');
        fs.mkdirSync(path.dirname(workflowMdPath), { recursive: true });
        fs.writeFileSync(workflowMdPath, '# phantom');

        const result = await startWorkflow({ name: 'phantom' });
        assert.strictEqual(result.isError, true);
        assert.match(readText(result), /STALE_RUNTIME/i);
    });

    await test('--all flag bypasses phase-gate for handoff execute', async () => {
        const start = await startWorkflow({ name: 'handoff' });
        assert.ok(!start.isError, readText(start));

        // Without --all, execute should be blocked at phase 0
        const blocked = await sendMessage({
            action: 'execute',
            payload: 'Review this plan'
        });
        assert.strictEqual(blocked.isError, true);
        assert.match(readText(blocked), /PHASE-GATE BLOCKED/i);

        // With --all metadata, should bypass the gate
        const bypassed = await sendMessage({
            action: 'execute',
            payload: 'Review this plan',
            metadata: { all: true }
        });
        assert.ok(!bypassed.isError, readText(bypassed));
    });

    await test('routing rejection message includes valid actions for workflow', async () => {
        await updateState(state => {
            state.session.activeWorkflow = 'accuracy';
            state.session.status = 'IN_PROGRESS';
            state.session.currentStep = 1;
            return state;
        });

        const result = await sendMessage({
            action: 'delegate_task',
            payload: 'do work'
        });
        assert.strictEqual(result.isError, true);
        const text = readText(result);
        assert.match(text, /is not valid for workflow/i);
    });



    console.log(`\nResult: ${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
}

run().catch(err => {
    console.error(`Fatal test error: ${err.message}`);
    process.exit(1);
});
