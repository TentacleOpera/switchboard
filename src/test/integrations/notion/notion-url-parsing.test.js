'use strict';

const assert = require('assert');
const { withWorkspace, loadOutModule } = require('../shared/test-harness');
const { installVsCodeMock } = require('../shared/vscode-mock');
const { SecretStorageMock } = require('../shared/secret-storage-mock');

function createService(workspaceRoot) {
    const installed = installVsCodeMock();
    const { NotionFetchService } = loadOutModule('services/NotionFetchService.js');
    installed.restore();
    return new NotionFetchService(workspaceRoot, new SecretStorageMock());
}

async function run() {
    await withWorkspace('notion-url-parsing', async ({ workspaceRoot }) => {
        const service = createService(workspaceRoot);
        const cases = [
            [
                'https://www.notion.so/Team-Space/Shipping-Plan-12345678-1234-1234-1234-1234567890ab',
                '123456781234123412341234567890ab'
            ],
            [
                'https://acme.notion.site/Design-Doc-123456781234123412341234567890ab',
                '123456781234123412341234567890ab'
            ],
            [
                'https://www.notion.so/%E2%9C%85-Ready-123456781234123412341234567890ab?pvs=4',
                '123456781234123412341234567890ab'
            ],
            [
                'https://www.notion.so/workspace/12345678-1234-1234-1234-1234567890ab?v=abc',
                '123456781234123412341234567890ab'
            ],
            ['https://example.com/notion/123456781234123412341234567890ab', null],
            ['not-a-valid-url', null]
        ];

        for (const [url, expected] of cases) {
            assert.strictEqual(service.parsePageId(url), expected, `Unexpected page ID parsing result for ${url}`);
        }
    });

    console.log('notion url parsing test passed');
}

run().catch((error) => {
    console.error('notion url parsing test failed:', error);
    process.exit(1);
});
