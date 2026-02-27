/**
 * Regression tests for standby status derivation.
 * Run with: node src/test/standby-status.test.js
 */

const assert = require('assert');
const { deriveSystemStandbyStatus, pickActiveStandbyWorker } = require('../services/standby-status');

let passed = 0;
let failed = 0;

async function test(name, fn) {
    try {
        await fn();
        console.log(`  PASS ${name}`);
        passed++;
    } catch (e) {
        console.error(`  FAIL ${name}: ${e.message}`);
        failed++;
    }
}

async function run() {
    console.log('\nRunning standby status derivation tests\n');

    await test('ignores generic active presence when standby is not active', async () => {
        const result = deriveSystemStandbyStatus({
            sessionInStandby: false,
            liveStandbySession: null,
            chatAgents: {
                'worker-a': { status: 'active' }
            }
        });

        assert.strictEqual(result.status, 'away');
        assert.strictEqual(result.statusMessage, 'Standby workflow is not active.');
        assert.strictEqual(result.activeWorkerName, null);
    });

    await test('reports standby-ready when workflow is active and worker is listening', async () => {
        const result = deriveSystemStandbyStatus({
            sessionInStandby: true,
            liveStandbySession: null,
            chatAgents: {
                'worker-a': {
                    status: 'standby',
                    statusMessage: 'Watching inbox'
                }
            }
        });

        assert.strictEqual(result.status, 'standby-ready');
        assert.strictEqual(result.activeWorkflow, 'standby');
        assert.strictEqual(result.staleSessionInStandby, false);
    });

    await test('reports poller not yet confirmed when no readiness signal exists', async () => {
        const result = deriveSystemStandbyStatus({
            sessionInStandby: true,
            liveStandbySession: null,
            chatAgents: {}
        });

        assert.strictEqual(result.status, 'standby');
        assert.match(result.statusMessage, /poller not yet confirmed/i);
        assert.strictEqual(result.activeWorkflow, 'standby');
    });

    await test('treats fresh standby heartbeat as standby-ready during loop re-entry', async () => {
        const result = deriveSystemStandbyStatus({
            sessionInStandby: true,
            sessionStatus: 'IN_PROGRESS',
            sessionStartTime: new Date(Date.now() - 60_000).toISOString(),
            sessionEndTime: new Date(Date.now() - 10_000).toISOString(),
            sessionLastOutcome: 'Standby resumed - processing message',
            liveStandbySession: null,
            chatAgents: {
                'worker-a': {
                    status: 'standby',
                    statusMessage: 'Watching inbox for messages...'
                }
            }
        });

        assert.strictEqual(result.status, 'standby-ready');
        // Logic now considers "Watching inbox..." as valid evidence
    });

    await test('reports active only when standby is active and worker is busy', async () => {
        const result = deriveSystemStandbyStatus({
            sessionInStandby: true,
            liveStandbySession: null,
            chatAgents: {
                'worker-a': { status: 'working' }
            }
        });

        assert.strictEqual(result.status, 'active');
        assert.strictEqual(result.statusMessage, 'worker-a is processing delegated work.');
        assert.strictEqual(result.activeWorkerName, 'worker-a');
    });

    await test('prefers standby-ready when watcher session is live', async () => {
        const result = deriveSystemStandbyStatus({
            sessionInStandby: true,
            liveStandbySession: { agent: 'worker-a', pid: 1234 },
            chatAgents: {
                'worker-a': { status: 'working' }
            }
        });

        assert.strictEqual(result.status, 'standby-ready');
        assert.strictEqual(result.statusMessage, 'Ready to receive standby work');
        assert.strictEqual(result.watcherAgent, 'worker-a');
        assert.strictEqual(result.staleSessionInStandby, false);
    });

    await test('does not auto-downgrade based on ended markers when standby evidence exists', async () => {
        const result = deriveSystemStandbyStatus({
            sessionInStandby: true,
            sessionStatus: 'IN_PROGRESS',
            sessionStartTime: '2026-02-14T07:23:58.807Z',
            sessionEndTime: '2026-02-14T07:27:07.941Z',
            sessionLastOutcome: 'Standby resumed - processing message',
            liveStandbySession: null,
            chatAgents: {
                'worker-a': {
                    status: 'standby',
                    statusMessage: 'Watching inbox'
                }
            }
        });

        assert.strictEqual(result.status, 'standby-ready');
        assert.strictEqual(result.activeWorkflow, 'standby');
        assert.strictEqual(result.staleSessionInStandby, false);
    });

    await test('active worker picker only considers workflow/thinking/working', async () => {
        const worker = pickActiveStandbyWorker({
            'worker-a': { status: 'active' },
            'worker-b': { status: 'thinking' }
        });
        assert.strictEqual(worker, 'worker-b');
    });

    await test('detects stale standby session when evidence is missing and status is not IN_PROGRESS', async () => {
        const result = deriveSystemStandbyStatus({
            sessionInStandby: true,
            sessionStatus: 'IDLE', // Claims standby but session is idle
            liveStandbySession: null,
            chatAgents: {}
        });

        assert.strictEqual(result.staleSessionInStandby, true);
        assert.strictEqual(result.activeWorkflow, null);
        assert.strictEqual(result.status, 'away');
    });

    console.log(`\nResult: ${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
}

run().catch(err => {
    console.error(`Fatal test error: ${err.message}`);
    process.exit(1);
});
