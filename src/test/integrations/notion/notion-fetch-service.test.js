'use strict';

const assert = require('assert');
const path = require('path');
const {
    withWorkspace,
    writeText,
    readJson,
    readText,
    loadFixtureJson,
    loadOutModule
} = require('../shared/test-harness');
const { installVsCodeMock } = require('../shared/vscode-mock');
const { SecretStorageMock } = require('../shared/secret-storage-mock');
const { installHttpsMock } = require('../shared/http-mock-helpers');

function createContext(workspaceRoot, secretSeed = {}) {
    const installed = installVsCodeMock();
    const { NotionFetchService } = loadOutModule('services/NotionFetchService.js');
    installed.restore();
    const secretStorage = new SecretStorageMock(secretSeed);
    return {
        service: new NotionFetchService(workspaceRoot, secretStorage),
        secretStorage,
        vscodeState: installed.state
    };
}

async function testConfigAndCacheIo() {
    await withWorkspace('notion-io', async ({ workspaceRoot }) => {
        const { service } = createContext(workspaceRoot);
        const config = {
            pageUrl: 'https://www.notion.so/acme/123456781234123412341234567890ab',
            pageId: '123456781234123412341234567890ab',
            pageTitle: 'Roadmap',
            setupComplete: true,
            lastFetchAt: '2026-04-01T00:00:00.000Z',
            designDocUrl: 'https://www.notion.so/acme/123456781234123412341234567890ab'
        };

        await service.saveConfig(config);
        await service.saveCachedContent('# Cached content');

        assert.deepStrictEqual(await service.loadConfig(), config);
        assert.strictEqual(await service.loadCachedContent(), '# Cached content');
    });
}

async function testAvailabilityAndRecursiveBlockFetch() {
    await withWorkspace('notion-availability', async ({ workspaceRoot }) => {
        const { service } = createContext(workspaceRoot, {
            'switchboard.notion.apiToken': 'secret_test_token'
        });
        const http = installHttpsMock();

        try {
            http.queueJson(200, { bot: { owner: { type: 'user' } } }, (req) => req.path === '/v1/users/me');
            assert.strictEqual(await service.isAvailable(), true);

            service._delay = async () => {};
            http.queueJson(200, {
                results: [
                    { id: 'paragraph-1', type: 'paragraph', paragraph: { rich_text: [] }, has_children: false },
                    { id: 'toggle-1', type: 'toggle', toggle: { rich_text: [] }, has_children: true }
                ],
                has_more: true,
                next_cursor: 'cursor-1'
            }, (req) => req.path === '/v1/blocks/root-page/children?page_size=100');
            http.queueJson(200, {
                results: [
                    { id: 'child-1', type: 'paragraph', paragraph: { rich_text: [] }, has_children: false }
                ],
                has_more: false,
                next_cursor: null
            }, (req) => req.path === '/v1/blocks/toggle-1/children?page_size=100');
            http.queueJson(200, {
                results: [
                    { id: 'quote-1', type: 'quote', quote: { rich_text: [] }, has_children: false }
                ],
                has_more: false,
                next_cursor: null
            }, (req) => req.path === '/v1/blocks/root-page/children?page_size=100&start_cursor=cursor-1');

            const blocks = await service.fetchBlocksRecursive('root-page');
            assert.strictEqual(blocks.length, 3);
            assert.strictEqual(blocks[1]._children.length, 1);
            assert.strictEqual(blocks[2].id, 'quote-1');
        } finally {
            http.restore();
        }
    });
}

async function testFetchAndCacheHappyPath() {
    await withWorkspace('notion-fetch', async ({ workspaceRoot }) => {
        const { service, secretStorage, vscodeState } = createContext(workspaceRoot);
        const http = installHttpsMock();

        try {
            vscodeState.inputBoxResponses.push(' secret_live_token ');
            http.queueJson(200, { bot: { owner: { type: 'user' } } }, (req) => req.path === '/v1/users/me');
            http.queueJson(200, {
                properties: {
                    Name: {
                        type: 'title',
                        title: [{ plain_text: 'Integration Spec' }]
                    }
                }
            }, (req) => req.path === '/v1/pages/123456781234123412341234567890ab');
            http.queueJson(200, {
                results: loadFixtureJson('notion', 'blocks-sample.json'),
                has_more: false,
                next_cursor: null
            }, (req) => req.path === '/v1/blocks/123456781234123412341234567890ab/children?page_size=100');

            const result = await service.fetchAndCache(
                'https://www.notion.so/acme/Integration-Spec-123456781234123412341234567890ab'
            );

            assert.strictEqual(result.success, true);
            assert.strictEqual(result.pageTitle, 'Integration Spec');
            assert.strictEqual(await secretStorage.get('switchboard.notion.apiToken'), 'secret_live_token');

            const savedConfig = readJson(service.configPath);
            const cachedContent = readText(service.cachePath);
            assert.strictEqual(savedConfig.pageTitle, 'Integration Spec');
            assert.strictEqual(savedConfig.designDocUrl, 'https://www.notion.so/acme/Integration-Spec-123456781234123412341234567890ab');
            assert.ok(cachedContent.startsWith('# Integration Spec'));
            assert.ok(cachedContent.includes('> Fetched from Notion: https://www.notion.so/acme/Integration-Spec-123456781234123412341234567890ab'));
            assert.ok(cachedContent.includes('Hello **world**'));
        } finally {
            http.restore();
        }
    });
}

async function run() {
    await testConfigAndCacheIo();
    await testAvailabilityAndRecursiveBlockFetch();
    await testFetchAndCacheHappyPath();
    console.log('notion fetch service test passed');
}

run().catch((error) => {
    console.error('notion fetch service test failed:', error);
    process.exit(1);
});
