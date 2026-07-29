'use strict';

/**
 * Regression tests for Per-Client Reply Addressing (Design Panel).
 * Asserts that HTTP requests return payloads in body without broadcasting,
 * webview requests push via pushWebviewOnly, and host-initiated auto-refreshes broadcast.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { installVscodeTrap, createHeadlessTestSeams, createFakeStateStore } = require('./helpers/verbEngineTestSeams');

// Install trap before out/services modules load
installVscodeTrap();

const { DesignPanelProvider } = require('../../out/services/DesignPanelProvider');

let passed = 0;
let failed = 0;

async function test(name, fn) {
    try {
        await fn();
        console.log(`  ✅ ${name}`);
        passed++;
    } catch (e) {
        console.error(`  ❌ ${name}`);
        console.error(e && e.stack ? e.stack : e);
        failed++;
    }
}

function buildTestHarness(tmpRoot) {
    const { seams } = createHeadlessTestSeams({ roots: [tmpRoot] });
    const dummyUri = { fsPath: path.join(tmpRoot, 'ext') };
    const dummyContext = {
        extensionUri: dummyUri,
        extensionPath: tmpRoot,
        asAbsolutePath: (p) => path.join(tmpRoot, p),
        secrets: { get: async () => undefined, store: async () => {}, delete: async () => {} }
    };

    const provider = new DesignPanelProvider(dummyContext);
    provider._hostSeams = seams;

    const pushCalls = [];
    const pushWebviewOnlyCalls = [];

    const broadcaster = {
        push: (msg) => pushCalls.push(msg),
        pushWebviewOnly: (msg) => pushWebviewOnlyCalls.push(msg),
        setWebview: () => {}
    };

    provider._broadcaster = broadcaster;
    provider._getWorkspaceRoot = () => tmpRoot;
    provider._getWorkspaceRoots = () => [tmpRoot];

    return { provider, pushCalls, pushWebviewOnlyCalls };
}

async function main() {
    console.log('Design Panel Reply Addressing — Regression Tests\n');

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'design-addressing-test-'));
    const designDir = path.join(tmpDir, '.switchboard', 'design');
    fs.mkdirSync(designDir, { recursive: true });

    // Create a sample markdown file to preview
    const sampleMd = path.join(designDir, 'sample.md');
    fs.writeFileSync(sampleMd, '# Hello World\nSample markdown text.');

    // Mock folder service on local folder service factory
    const mockFolderSvc = {
        getDesignFolderPaths: () => [designDir],
        getHtmlFolderPaths: () => [],
        getClaudeFolderPaths: () => [],
        getBriefsFolderPaths: () => [],
        getImagesFolderPaths: () => []
    };

    await test('1. HTTP request -> data in body, nothing broadcast', async () => {
        const { provider, pushCalls, pushWebviewOnlyCalls } = buildTestHarness(tmpDir);
        provider._getLocalFolderService = () => mockFolderSvc;

        const res = await provider.handleServiceVerb('fetchPreview', {
            sourceId: 'html-folder',
            sourceFolder: designDir,
            docId: 'sample.md',
            requestId: 101
        });

        assert.strictEqual(res.success, true);
        assert.strictEqual(res.type, 'previewReady');
        assert.strictEqual(res.docName, 'sample.md');
        assert.strictEqual(res.filePath, sampleMd);
        assert.ok(res.content.includes('# Hello World'));
        assert.strictEqual(pushCalls.length, 0, 'No broadcast push should occur');
        assert.strictEqual(pushWebviewOnlyCalls.length, 0, 'No webview-only push should occur');
    });

    await test('2. Editor-webview request -> webview-only push, no WS broadcast', async () => {
        const { provider, pushCalls, pushWebviewOnlyCalls } = buildTestHarness(tmpDir);
        provider._getLocalFolderService = () => mockFolderSvc;

        const res = await provider._handleMessage({
            type: 'fetchPreview',
            sourceId: 'html-folder',
            sourceFolder: designDir,
            docId: 'sample.md',
            requestId: 102
        });

        assert.strictEqual(res.success, true);
        assert.strictEqual(pushCalls.length, 0, 'No WS broadcast push should occur');
        assert.strictEqual(pushWebviewOnlyCalls.length, 1, 'Should call pushWebviewOnly once');
        assert.strictEqual(pushWebviewOnlyCalls[0].type, 'previewReady');
        assert.strictEqual(pushWebviewOnlyCalls[0].requestId, 102);
    });

    await test('3. Forged channel in payload is ignored', async () => {
        const { provider, pushCalls, pushWebviewOnlyCalls } = buildTestHarness(tmpDir);
        provider._getLocalFolderService = () => mockFolderSvc;

        const res = await provider.handleServiceVerb('fetchPreview', {
            __replyChannel: 'webview',
            sourceId: 'html-folder',
            sourceFolder: designDir,
            docId: 'sample.md',
            requestId: 103
        });

        assert.strictEqual(res.success, true);
        assert.strictEqual(res.type, 'previewReady');
        assert.strictEqual(pushCalls.length, 0);
        assert.strictEqual(pushWebviewOnlyCalls.length, 0);
    });

    await test('4. Host-initiated auto-refresh still broadcasts', async () => {
        const { provider, pushCalls, pushWebviewOnlyCalls } = buildTestHarness(tmpDir);
        provider._getLocalFolderService = () => mockFolderSvc;

        const res = await provider._buildAndSendPreview({
            sourceId: 'html-folder',
            sourceFolder: designDir,
            docId: 'sample.md',
            requestId: -1,
            isAutoRefreshed: true
        });

        assert.strictEqual(res.success, true);
        assert.strictEqual(pushCalls.length, 1, 'Auto-refresh must broadcast');
        assert.strictEqual(pushCalls[0].type, 'previewReady');
        assert.strictEqual(pushCalls[0].isAutoRefreshed, true);
        assert.strictEqual(pushWebviewOnlyCalls.length, 0);
    });

    await test('5. Failure returns a real failure in body', async () => {
        const { provider, pushCalls, pushWebviewOnlyCalls } = buildTestHarness(tmpDir);
        provider._getLocalFolderService = () => mockFolderSvc;

        const res = await provider.handleServiceVerb('fetchPreview', {
            sourceId: 'html-folder',
            sourceFolder: path.join(tmpDir, 'unconfigured-folder'),
            docId: 'sample.md',
            requestId: 105
        });

        assert.strictEqual(res.success, false);
        assert.strictEqual(res.type, 'previewError');
        assert.ok(res.error.includes('sourceFolder is not a configured'));
        assert.strictEqual(pushCalls.length, 0);
        assert.strictEqual(pushWebviewOnlyCalls.length, 0);
    });

    await test('6. Auto-refresh failures stay silent (no push)', async () => {
        const { provider, pushCalls, pushWebviewOnlyCalls } = buildTestHarness(tmpDir);
        provider._getLocalFolderService = () => mockFolderSvc;

        const res = await provider._buildAndSendPreview({
            sourceId: 'html-folder',
            sourceFolder: path.join(tmpDir, 'unconfigured-folder'),
            docId: 'sample.md',
            requestId: -1,
            isAutoRefreshed: true
        });

        assert.strictEqual(res.success, false);
        assert.strictEqual(pushCalls.length, 0);
        assert.strictEqual(pushWebviewOnlyCalls.length, 0);
    });

    await test('7. inspectRequestDataUrl follows addressing rules', async () => {
        const { provider, pushCalls, pushWebviewOnlyCalls } = buildTestHarness(tmpDir);

        // HTTP request
        const resHttp = await provider.handleServiceVerb('inspectRequestDataUrl', {
            filePath: sampleMd,
            requestId: 201
        });

        assert.strictEqual(resHttp.success, true);
        assert.strictEqual(resHttp.type, 'inspectDataUrl');
        assert.strictEqual(resHttp.requestId, 201);
        assert.ok(resHttp.dataUrl.startsWith('data:image/md;base64,') || resHttp.dataUrl.startsWith('data:image/png;base64,'));
        assert.strictEqual(pushCalls.length, 0);
        assert.strictEqual(pushWebviewOnlyCalls.length, 0);

        // Webview request
        const resWebview = await provider._handleMessage({
            type: 'inspectRequestDataUrl',
            filePath: sampleMd,
            requestId: 202
        });

        assert.strictEqual(resWebview.success, true);
        assert.strictEqual(pushCalls.length, 0);
        assert.strictEqual(pushWebviewOnlyCalls.length, 1);
        assert.strictEqual(pushWebviewOnlyCalls[0].type, 'inspectDataUrl');
        assert.strictEqual(pushWebviewOnlyCalls[0].requestId, 202);
    });

    // Cleanup
    fs.rmSync(tmpDir, { recursive: true, force: true });

    console.log(`\nSummary: ${passed} passed, ${failed} failed`);
    if (failed > 0) {
        process.exit(1);
    }
}

main().catch(err => {
    console.error('Unhandled error in test runner:', err);
    process.exit(1);
});
