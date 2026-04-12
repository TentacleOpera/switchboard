'use strict';

const assert = require('assert');
const { withWorkspace, loadFixtureJson, loadOutModule } = require('../shared/test-harness');
const { installVsCodeMock } = require('../shared/vscode-mock');
const { SecretStorageMock } = require('../shared/secret-storage-mock');

function createService(workspaceRoot) {
    const installed = installVsCodeMock();
    const { NotionFetchService } = loadOutModule('services/NotionFetchService.js');
    installed.restore();
    return new NotionFetchService(workspaceRoot, new SecretStorageMock());
}

async function run() {
    await withWorkspace('notion-markdown', async ({ workspaceRoot }) => {
        const service = createService(workspaceRoot);
        const blocks = loadFixtureJson('notion', 'blocks-sample.json');
        const markdown = service.convertBlocksToMarkdown(blocks).trim();

        assert.strictEqual(
            markdown,
            [
                'Hello **world**',
                '## Section',
                '- Parent',
                '  - Child',
                '- [x] Done',
                '> 💡 Remember',
                '```ts',
                'const x = 1;',
                '```',
                '| Head | Value |',
                '| --- | --- |',
                '| Cell | 42 |'
            ].join('\n')
        );
    });

    console.log('notion markdown conversion test passed');
}

run().catch((error) => {
    console.error('notion markdown conversion test failed:', error);
    process.exit(1);
});
