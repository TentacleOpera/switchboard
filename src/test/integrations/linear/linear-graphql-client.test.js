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
    const { LinearSyncService } = loadOutModule('services/LinearSyncService.js', ['services/ClickUpSyncService.js']);
    installed.restore();
    return {
        service: new LinearSyncService(workspaceRoot, new SecretStorageMock(secretSeed))
    };
}

async function testGraphqlSuccessAndRequestShape() {
    await withWorkspace('linear-graphql-success', async ({ workspaceRoot }) => {
        const { service } = createContext(workspaceRoot, {
            'switchboard.linear.apiToken': 'lin_api_token'
        });
        const http = installHttpsMock();

        try {
            http.queueJson(200, { data: { viewer: { id: 'user-1' } } });
            const result = await service.graphqlRequest('query($id: String!) { viewer { id } }', { id: 'user-1' });
            assert.deepStrictEqual(result, { data: { viewer: { id: 'user-1' } } });

            const request = http.requests[0];
            assert.strictEqual(request.hostname, 'api.linear.app');
            assert.strictEqual(request.path, '/graphql');
            assert.strictEqual(request.headers.Authorization, 'lin_api_token');
            assert.strictEqual(request.jsonBody.variables.id, 'user-1');
        } finally {
            http.restore();
        }
    });
}

async function testGraphqlErrors() {
    await withWorkspace('linear-graphql-errors', async ({ workspaceRoot }) => {
        const { service } = createContext(workspaceRoot, {
            'switchboard.linear.apiToken': 'lin_api_token'
        });
        const http = installHttpsMock();

        try {
            http.queueJson(500, { data: null });
            await assert.rejects(() => service.graphqlRequest('{ viewer { id } }'), /Linear API HTTP 500/);

            http.queueJson(200, { errors: [{ message: 'Boom' }] });
            await assert.rejects(() => service.graphqlRequest('{ viewer { id } }'), /Linear GraphQL error: Boom/);

            http.queueRaw(200, 'not-json');
            await assert.rejects(() => service.graphqlRequest('{ viewer { id } }'), /Failed to parse Linear API response/);

            http.queueTimeout();
            await assert.rejects(() => service.graphqlRequest('{ viewer { id } }'), /Linear request timed out/);
        } finally {
            http.restore();
        }
    });
}

async function run() {
    await testGraphqlSuccessAndRequestShape();
    await testGraphqlErrors();
    console.log('linear graphql client test passed');
}

run().catch((error) => {
    console.error('linear graphql client test failed:', error);
    process.exit(1);
});
