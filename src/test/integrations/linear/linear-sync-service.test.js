'use strict';

const assert = require('assert');
const path = require('path');
const {
    withWorkspace,
    writeJson,
    readJson,
    loadOutModule,
    withFakeTimers
} = require('../shared/test-harness');
const { installVsCodeMock } = require('../shared/vscode-mock');
const { SecretStorageMock } = require('../shared/secret-storage-mock');
const { installHttpsMock } = require('../shared/http-mock-helpers');

function createContext(workspaceRoot, secretSeed = {}) {
    const installed = installVsCodeMock();
    const { LinearSyncService, CANONICAL_COLUMNS } = loadOutModule('services/LinearSyncService.js', ['services/ClickUpSyncService.js']);
    installed.restore();
    return {
        service: new LinearSyncService(workspaceRoot, new SecretStorageMock(secretSeed)),
        vscodeState: installed.state,
        CANONICAL_COLUMNS
    };
}

function baseConfig(overrides = {}) {
    return {
        teamId: 'team-1',
        teamName: 'Engineering',
        projectId: 'project-1',
        columnToStateId: {
            CREATED: 'state-created',
            BACKLOG: 'state-backlog',
            'PLAN REVIEWED': '',
            'LEAD CODED': '',
            'CODER CODED': '',
            'CODE REVIEWED': '',
            CODED: '',
            COMPLETED: ''
        },
        switchboardLabelId: 'label-switchboard',
        setupComplete: true,
        lastSync: null,
        autoPullEnabled: false,
        pullIntervalMinutes: 60,
        ...overrides
    };
}

async function testConfigAndSyncMapPersistence() {
    await withWorkspace('linear-config', async ({ workspaceRoot }) => {
        const { service } = createContext(workspaceRoot, {
            'switchboard.linear.apiToken': 'lin_api_token'
        });

        await writeJson(service.configPath, {
            teamId: 'legacy-team',
            teamName: 'Legacy',
            setupComplete: true,
            pullIntervalMinutes: 999
        });
        const config = await service.loadConfig();
        assert.strictEqual(config.pullIntervalMinutes, 60);

        await service.setIssueIdForPlan('session-1', 'issue-1');
        assert.strictEqual(await service.getIssueIdForPlan('session-1'), 'issue-1');
    });
}

async function testSetupAndSyncFallback() {
    await withWorkspace('linear-setup', async ({ workspaceRoot }) => {
        const { service, vscodeState, CANONICAL_COLUMNS } = createContext(workspaceRoot);
        const http = installHttpsMock();

        try {
            vscodeState.inputBoxResponses.push('lin_api_live_token');
            vscodeState.quickPickResponses.push(
                (items) => items[0],
                (items) => items[1],
                ...CANONICAL_COLUMNS.map(() => (items) => items[1])
            );

            http.queueJson(200, { data: { viewer: { id: 'viewer-1' } } });
            http.queueJson(200, { data: { teams: { nodes: [{ id: 'team-1', name: 'Engineering' }] } } });
            http.queueJson(200, { data: { team: { projects: { nodes: [{ id: 'project-1', name: 'Project One' }] } } } });
            http.queueJson(200, {
                data: {
                    team: {
                        states: {
                            nodes: [
                                { id: 'state-created', name: 'Todo', type: 'backlog' },
                                { id: 'state-started', name: 'In Progress', type: 'started' }
                            ]
                        }
                    }
                }
            });
            http.queueJson(200, { data: { team: { labels: { nodes: [] } } } });
            http.queueJson(200, { data: { issueLabelCreate: { issueLabel: { id: 'label-switchboard' } } } });

            const result = await service.setup();
            assert.strictEqual(result, true);

            const saved = readJson(service.configPath);
            assert.strictEqual(saved.teamId, 'team-1');
            assert.strictEqual(saved.projectId, 'project-1');
            assert.strictEqual(saved.switchboardLabelId, 'label-switchboard');
            assert.strictEqual(vscodeState.inputBoxCalls[0].password, true);

            await service.saveConfig(baseConfig());
            http.queueJson(200, { data: { issueCreate: { success: true, issue: { id: 'issue-created', identifier: 'ENG-1' } } } });
            await service.syncPlan({
                sessionId: 'session-create',
                topic: 'Create Linear issue',
                planFile: 'plan.md',
                complexity: '9'
            }, 'CREATED');
            assert.strictEqual(await service.getIssueIdForPlan('session-create'), 'issue-created');

            await service.setIssueIdForPlan('session-update', 'issue-existing');
            http.queueJson(200, { data: { issueUpdate: { success: false } } });
            http.queueJson(200, { data: { issueCreate: { success: true, issue: { id: 'issue-recreated', identifier: 'ENG-2' } } } });
            await service.syncPlan({
                sessionId: 'session-update',
                topic: 'Fallback issue',
                planFile: 'plan.md',
                complexity: '5'
            }, 'CREATED');
            assert.strictEqual(await service.getIssueIdForPlan('session-update'), 'issue-recreated');
        } finally {
            http.restore();
        }
    });
}

async function testDebouncedSyncAndUnmappedColumn() {
    await withWorkspace('linear-debounce', async ({ workspaceRoot }) => {
        const { service } = createContext(workspaceRoot, {
            'switchboard.linear.apiToken': 'lin_api_token'
        });
        await service.saveConfig(baseConfig());

        const http = installHttpsMock();
        try {
            const requestCountBefore = http.requests.length;
            await service.syncPlan({
                sessionId: 'session-unmapped',
                topic: 'Unmapped',
                planFile: 'plan.md',
                complexity: '3'
            }, 'PLAN REVIEWED');
            assert.strictEqual(http.requests.length, requestCountBefore, 'unmapped columns should not call Linear');
        } finally {
            http.restore();
        }

        await withFakeTimers(async ({ active, fire }) => {
            const synced = [];
            service.syncPlan = async (plan, column) => {
                synced.push(`${plan.sessionId}:${column}`);
            };

            service.debouncedSync('session-a', { sessionId: 'session-a' }, 'CREATED');
            const firstTimer = [...active.values()][0];
            service.debouncedSync('session-a', { sessionId: 'session-a' }, 'BACKLOG');

            assert.strictEqual(active.size, 1);
            assert.ok(firstTimer.cleared);
            await fire([...active.values()][0]);
            assert.deepStrictEqual(synced, ['session-a:BACKLOG']);
        });
    });
}

async function run() {
    await testConfigAndSyncMapPersistence();
    await testSetupAndSyncFallback();
    await testDebouncedSyncAndUnmappedColumn();
    console.log('linear sync service test passed');
}

run().catch((error) => {
    console.error('linear sync service test failed:', error);
    process.exit(1);
});
