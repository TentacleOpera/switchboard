'use strict';

const assert = require('assert');
const path = require('path');
const {
    withWorkspace,
    writeText,
    loadOutModule,
    withFakeTimers,
    createPlanRecord
} = require('../shared/test-harness');
const { installVsCodeMock } = require('../shared/vscode-mock');
const { SecretStorageMock } = require('../shared/secret-storage-mock');

function createContext(workspaceRoot) {
    const installed = installVsCodeMock();
    const { ClickUpSyncService } = loadOutModule('services/ClickUpSyncService.js');
    installed.restore();
    return {
        service: new ClickUpSyncService(workspaceRoot, new SecretStorageMock({
            'switchboard.clickup.apiToken': 'pk_rate_limit_token'
        }))
    };
}

async function testRetryBackoff() {
    await withWorkspace('clickup-retry', async ({ workspaceRoot }) => {
        const { service } = createContext(workspaceRoot);
        const delays = [];
        let attempts = 0;
        service.delay = async (ms) => {
            delays.push(ms);
        };

        const result = await service.retry(async () => {
            attempts += 1;
            if (attempts < 3) {
                throw new Error('retry me');
            }
            return 'ok';
        });

        assert.strictEqual(result, 'ok');
        assert.deepStrictEqual(delays, [1000, 2000]);
    });
}

async function testSyncColumnBatching() {
    await withWorkspace('clickup-batch', async ({ workspaceRoot }) => {
        const { service } = createContext(workspaceRoot);
        await service.saveConfig({
            workspaceId: 'team-1',
            folderId: 'folder-1',
            spaceId: 'space-1',
            columnMappings: {
                CREATED: 'list-created',
                BACKLOG: 'list-backlog',
                'PLAN REVIEWED': '',
                'LEAD CODED': '',
                'CODER CODED': '',
                'CODE REVIEWED': '',
                CODED: '',
                COMPLETED: ''
            },
            customFields: { sessionId: '', planId: '', syncTimestamp: '' },
            setupComplete: true,
            lastSync: null,
            autoPullEnabled: false,
            pullIntervalMinutes: 60
        });

        const delays = [];
        service._batchSize = 2;
        service._rateLimitDelay = 25;
        service.delay = async (ms) => {
            delays.push(ms);
        };
        service.syncPlan = async (plan) => ({ success: plan.planId !== 'plan-bad' });

        const result = await service.syncColumn('CREATED', [
            createPlanRecord({ planId: 'plan-a' }),
            createPlanRecord({ planId: 'plan-b' }),
            createPlanRecord({ planId: 'plan-bad' })
        ]);

        assert.deepStrictEqual(result, { success: true, synced: 2, errors: 1 });
        assert.deepStrictEqual(delays, [25, 25]);
    });
}

async function testDebouncedSyncCoalescesRapidMoves() {
    await withWorkspace('clickup-debounce', async ({ workspaceRoot }) => {
        const { service } = createContext(workspaceRoot);
        await withFakeTimers(async ({ active, fire }) => {
            const syncedPlans = [];
            service.syncPlan = async (plan) => {
                syncedPlans.push(plan.planId);
                return { success: true };
            };

            service.debouncedSync('session-1', createPlanRecord({ planId: 'first-plan' }));
            const firstTimer = [...active.values()][0];
            service.debouncedSync('session-1', createPlanRecord({ planId: 'final-plan' }));

            assert.strictEqual(active.size, 1);
            assert.ok(firstTimer.cleared, 'second debounce call should clear the previous timer');

            const timer = [...active.values()][0];
            await fire(timer);
            assert.deepStrictEqual(syncedPlans, ['final-plan']);
        });
    });
}

async function run() {
    await testRetryBackoff();
    await testSyncColumnBatching();
    await testDebouncedSyncCoalescesRapidMoves();
    console.log('clickup rate limiting test passed');
}

run().catch((error) => {
    console.error('clickup rate limiting test failed:', error);
    process.exit(1);
});
