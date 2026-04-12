'use strict';

const assert = require('assert');
const {
    withWorkspace,
    flushPromises,
    readText,
    loadOutModule
} = require('../shared/test-harness');
const { installVsCodeMock } = require('../shared/vscode-mock');
const { SecretStorageMock } = require('../shared/secret-storage-mock');
const { installHttpsMock } = require('../shared/http-mock-helpers');

function createContext(workspaceRoot, secretSeed = {}) {
    const installed = installVsCodeMock();
    const { NotionFetchService } = loadOutModule('services/NotionFetchService.js');
    installed.restore();
    return {
        service: new NotionFetchService(workspaceRoot, new SecretStorageMock(secretSeed)),
        vscodeState: installed.state
    };
}

async function testHeadersAndRawResponseFallback() {
    await withWorkspace('notion-regression-http', async ({ workspaceRoot }) => {
        const { service } = createContext(workspaceRoot, {
            'switchboard.notion.apiToken': 'secret_header_token'
        });
        const http = installHttpsMock();

        try {
            http.queueRaw(200, 'not-json');
            const result = await service.httpRequest('GET', '/users/me');
            assert.strictEqual(result.data, 'not-json');

            const request = http.requests[0];
            assert.strictEqual(request.hostname, 'api.notion.com');
            assert.strictEqual(request.path, '/v1/users/me');
            assert.strictEqual(request.headers.Authorization, 'Bearer secret_header_token');
            assert.strictEqual(request.headers['Notion-Version'], '2022-06-28');
        } finally {
            http.restore();
        }
    });
}

async function testTokenValidationHappensBeforePageCalls() {
    await withWorkspace('notion-regression-auth', async ({ workspaceRoot }) => {
        const { service, vscodeState } = createContext(workspaceRoot, {
            'switchboard.notion.apiToken': 'secret_bad_token'
        });
        const http = installHttpsMock();

        try {
            vscodeState.errorMessageResponses.push('Open notion.so/profile/integrations');
            http.queueJson(401, { code: 'unauthorized' }, (req) => req.path === '/v1/users/me');

            const result = await service.fetchAndCache(
                'https://www.notion.so/acme/Bad-Token-123456781234123412341234567890ab'
            );
            await flushPromises();

            assert.strictEqual(result.success, false);
            assert.strictEqual(result.error, 'Token validation failed');
            assert.strictEqual(http.requests.length, 1, 'token validation should happen before page fetches');
            assert.strictEqual(http.requests[0].path, '/v1/users/me');
            assert.strictEqual(vscodeState.openExternalCalls[0].toString(), 'https://notion.so/profile/integrations');
        } finally {
            http.restore();
        }
    });
}

async function testLargePageTruncationAndFriendly403() {
    await withWorkspace('notion-regression-large', async ({ workspaceRoot }) => {
        const { service, vscodeState } = createContext(workspaceRoot, {
            'switchboard.notion.apiToken': 'secret_large_token'
        });

        service.isAvailable = async () => true;
        service.parsePageId = () => 'page-large';
        service.fetchPageTitle = async () => 'Large Page';
        service.fetchBlocksRecursive = async () => [];
        service.convertBlocksToMarkdown = () => ['# Chapter', '', 'x'.repeat(51000)].join('\n');

        const success = await service.fetchAndCache('https://www.notion.so/acme/Large-Page-123456781234123412341234567890ab');
        const cache = readText(service.cachePath);
        assert.strictEqual(success.success, true);
        assert.strictEqual(vscodeState.warningMessageCalls.length, 1);
        assert.ok(cache.includes('*[Content truncated at'));
        assert.ok(cache.includes('View full page'));

        service.fetchBlocksRecursive = async () => {
            throw new Error('403 Forbidden');
        };
        const forbidden = await service.fetchAndCache('https://www.notion.so/acme/Blocked-Page-123456781234123412341234567890ab');
        assert.strictEqual(forbidden.success, false);
        assert.match(forbidden.error, /Page not accessible/);
    });
}

async function run() {
    await testHeadersAndRawResponseFallback();
    await testTokenValidationHappensBeforePageCalls();
    await testLargePageTruncationAndFriendly403();
    console.log('notion regression test passed');
}

run().catch((error) => {
    console.error('notion regression test failed:', error);
    process.exit(1);
});
