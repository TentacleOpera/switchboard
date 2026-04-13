'use strict';

const assert = require('assert');
const {
    withWorkspace,
    loadOutModule
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

async function testAuthHeaderAndEndpoint() {
    await withWorkspace('linear-regression-http', async ({ workspaceRoot }) => {
        const { service } = createContext(workspaceRoot, {
            'switchboard.linear.apiToken': 'lin_api_header'
        });
        const http = installHttpsMock();

        try {
            http.queueJson(200, { data: { viewer: { id: 'viewer' } } });
            await service.graphqlRequest('{ viewer { id } }');
            assert.strictEqual(http.requests[0].hostname, 'api.linear.app');
            assert.strictEqual(http.requests[0].path, '/graphql');
            assert.strictEqual(http.requests[0].headers.Authorization, 'lin_api_header');
        } finally {
            http.restore();
        }
    });
}

async function testApplyConfigCreatesSwitchboardLabelWithExpectedColor() {
    await withWorkspace('linear-regression-label', async ({ workspaceRoot }) => {
        const { service, vscodeState, CANONICAL_COLUMNS } = createContext(workspaceRoot);
        const http = installHttpsMock();

        try {
            vscodeState.inputBoxResponses.push('lin_api_token');
            vscodeState.quickPickResponses.push(
                (items) => items[0],
                (items) => items[0],
                ...CANONICAL_COLUMNS.map(() => (items) => items[1])
            );

            http.queueJson(200, { data: { viewer: { id: 'viewer-1' } } });
            http.queueJson(200, { data: { teams: { nodes: [{ id: 'team-1', name: 'Engineering' }] } } });
            http.queueJson(200, { data: { team: { projects: { nodes: [] } } } });
            http.queueJson(200, {
                data: {
                    team: {
                        states: {
                            nodes: [{ id: 'state-created', name: 'Todo', type: 'backlog' }]
                        }
                    }
                }
            });
            http.queueJson(200, { data: { team: { labels: { nodes: [] } } } });
            http.queueJson(200, { data: { issueLabelCreate: { issueLabel: { id: 'label-switchboard' } } } });

            const result = await service.applyConfig({
                mapColumns: true,
                createLabel: true,
                scopeProject: true,
                enableRealtimeSync: true,
                enableAutoPull: false
            });
            assert.deepStrictEqual(result, { success: true });
            const labelRequest = http.requests.find((req) => req.jsonBody && req.jsonBody.variables && req.jsonBody.variables.color);
            assert.strictEqual(labelRequest.jsonBody.variables.color, '#6366f1');
        } finally {
            http.restore();
        }
    });
}

async function run() {
    await testAuthHeaderAndEndpoint();
    await testApplyConfigCreatesSwitchboardLabelWithExpectedColor();
    console.log('linear regression test passed');
}

run().catch((error) => {
    console.error('linear regression test failed:', error);
    process.exit(1);
});
