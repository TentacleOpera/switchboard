'use strict';

const assert = require('assert');
const fs = require('fs');
const {
    withWorkspace,
    loadOutModule
} = require('../shared/test-harness');
const { installVsCodeMock } = require('../shared/vscode-mock');
const { SecretStorageMock } = require('../shared/secret-storage-mock');
const { installHttpsMock } = require('../shared/http-mock-helpers');

function createContext(workspaceRoot, secretSeed = {}) {
    const installed = installVsCodeMock();
    const { ClickUpSyncService } = loadOutModule('services/ClickUpSyncService.js');
    installed.restore();
    return {
        service: new ClickUpSyncService(workspaceRoot, new SecretStorageMock(secretSeed)),
        vscodeState: installed.state
    };
}

async function testHttpHeadersAndApiVersion() {
    await withWorkspace('clickup-regression-http', async ({ workspaceRoot }) => {
        const { service } = createContext(workspaceRoot, {
            'switchboard.clickup.apiToken': 'pk_header_token'
        });
        const http = installHttpsMock();

        try {
            http.queueRaw(200, 'ok');
            const result = await service.httpRequest('GET', '/team');
            assert.strictEqual(result.data, 'ok');
            assert.strictEqual(http.requests[0].hostname, 'api.clickup.com');
            assert.strictEqual(http.requests[0].path, '/api/v2/team');
            assert.strictEqual(http.requests[0].headers.Authorization, 'pk_header_token');
        } finally {
            http.restore();
        }
    });
}

async function testSetupFailureTriggersCleanup() {
    await withWorkspace('clickup-regression-cleanup', async ({ workspaceRoot }) => {
        const { service, vscodeState } = createContext(workspaceRoot);
        const http = installHttpsMock();

        try {
            vscodeState.inputBoxResponses.push('pk_cleanup_token');
            vscodeState.quickPickResponses.push('Engineering');

            http.queueJson(200, { teams: [{ id: 'team-1' }] }, (req) => req.path === '/api/v2/team');
            http.queueJson(200, { spaces: [{ id: 'space-1', name: 'Engineering' }] }, (req) => req.path === '/api/v2/team/team-1/space?archived=false');
            http.queueJson(200, { folders: [] }, (req) => req.path === '/api/v2/space/space-1/folder?archived=false');
            http.queueJson(200, { id: 'folder-1' }, (req) => req.method === 'POST' && req.path === '/api/v2/space/space-1/folder');
            http.queueJson(500, { err: 'boom' }, (req) => req.method === 'POST' && req.path === '/api/v2/folder/folder-1/list');
            http.queueJson(200, { ok: true }, (req) => req.method === 'DELETE' && req.path === '/api/v2/folder/folder-1');

            const result = await service.setup();
            assert.strictEqual(result.success, false);
            assert.match(result.error, /Failed to create list/);
            assert.ok(http.requests.some((req) => req.method === 'DELETE' && req.path === '/api/v2/folder/folder-1'));
            assert.strictEqual(fs.existsSync(service.configPath), false);
            assert.strictEqual(vscodeState.inputBoxCalls[0].password, true);
            assert.strictEqual(vscodeState.inputBoxCalls[0].placeHolder, 'pk_...');
        } finally {
            http.restore();
        }
    });
}

async function run() {
    await testHttpHeadersAndApiVersion();
    await testSetupFailureTriggersCleanup();
    console.log('clickup regression test passed');
}

run().catch((error) => {
    console.error('clickup regression test failed:', error);
    process.exit(1);
});
