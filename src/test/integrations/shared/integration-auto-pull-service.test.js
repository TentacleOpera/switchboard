'use strict';

const assert = require('assert');
const { loadOutModule, withFakeTimers } = require('./test-harness');

async function testConfigureAndStop() {
    await withFakeTimers(async ({ active }) => {
        const { IntegrationAutoPullService } = loadOutModule('services/IntegrationAutoPullService.js');
        const service = new IntegrationAutoPullService();

        service.configure('/workspace', 'clickup', true, 5, async () => {});
        assert.strictEqual(active.size, 1, 'configure() should schedule one timeout when enabled');
        const firstTimer = [...active.values()][0];
        assert.strictEqual(firstTimer.ms, 5 * 60 * 1000);

        service.configure('/workspace', 'clickup', true, 15, async () => {});
        assert.strictEqual(active.size, 1, 'reconfigure() should replace the prior timeout');
        assert.ok(firstTimer.cleared, 'reconfigure() should clear the previous timeout');
        assert.strictEqual([...active.values()][0].ms, 15 * 60 * 1000);

        service.stop('/workspace', 'clickup');
        assert.strictEqual(active.size, 0, 'stop() should clear the scheduled timeout');
        service.dispose();
    });
}

async function testNoOverlapDuringInFlightRun() {
    await withFakeTimers(async ({ active, fire }) => {
        const { IntegrationAutoPullService } = loadOutModule('services/IntegrationAutoPullService.js');
        const service = new IntegrationAutoPullService();
        let calls = 0;
        let releaseRun;

        service.configure('/workspace', 'linear', true, 5, async () => {
            calls += 1;
            if (calls === 1) {
                await new Promise((resolve) => {
                    releaseRun = resolve;
                });
            }
        });

        const firstTimer = [...active.values()][0];
        const firstRun = fire(firstTimer);
        assert.strictEqual(calls, 1);
        assert.strictEqual(active.size, 0, 'no replacement timer should exist while a run is in flight');

        service.configure('/workspace', 'linear', true, 15, async () => {
            calls += 1;
        });
        assert.strictEqual(active.size, 0, 'reconfigure should not overlap with the in-flight runner');

        releaseRun();
        await firstRun;
        assert.strictEqual(active.size, 1, 'next timeout should arm after the runner completes');
        assert.strictEqual([...active.values()][0].ms, 15 * 60 * 1000);

        service.dispose();
    });
}

async function testMultipleWorkspacesAndIntegrations() {
    await withFakeTimers(async ({ active }) => {
        const { IntegrationAutoPullService } = loadOutModule('services/IntegrationAutoPullService.js');
        const service = new IntegrationAutoPullService();

        service.configure('/workspace-a', 'clickup', true, 5, async () => {});
        service.configure('/workspace-a', 'linear', true, 15, async () => {});
        service.configure('/workspace-b', 'clickup', true, 30, async () => {});

        const intervals = [...active.values()].map((timer) => timer.ms).sort((a, b) => a - b);
        assert.deepStrictEqual(
            intervals,
            [5 * 60 * 1000, 15 * 60 * 1000, 30 * 60 * 1000],
            'each workspace/integration pair should maintain its own timeout'
        );

        service.stopWorkspace('/workspace-a');
        assert.strictEqual(active.size, 1, 'stopWorkspace() should only remove timers for the matching workspace');
        assert.strictEqual([...active.values()][0].ms, 30 * 60 * 1000);

        service.dispose();
    });
}

async function testNullRunnerAndZeroIntervalEdgeCases() {
    await withFakeTimers(async ({ active }) => {
        const { IntegrationAutoPullService } = loadOutModule('services/IntegrationAutoPullService.js');
        const service = new IntegrationAutoPullService();

        service.configure('/workspace', 'clickup', true, 5, null);
        assert.strictEqual(active.size, 0, 'a null runner should not schedule a timeout');

        service.configure('/workspace', 'linear', true, 0, async () => {});
        assert.strictEqual(active.size, 1, 'zero-minute intervals should still schedule deterministically in tests');
        assert.strictEqual([...active.values()][0].ms, 0);

        service.dispose();
    });
}

async function run() {
    await testConfigureAndStop();
    await testNoOverlapDuringInFlightRun();
    await testMultipleWorkspacesAndIntegrations();
    await testNullRunnerAndZeroIntervalEdgeCases();
    console.log('integration auto-pull service test passed');
}

run().catch((error) => {
    console.error('integration auto-pull service test failed:', error);
    process.exit(1);
});
