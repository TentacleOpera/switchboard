'use strict';

/**
 * BREAK-TEST INSTRUCTION:
 * To verify this test actually catches missing requestId echoes:
 * 1. Open src/services/KanbanProvider.ts
 * 2. Find any of the message handlers listed in HANDLERS_UNDER_TEST below
 *    (e.g. 'getNotionFetchState', 'searchNotionPages', 'fetchLinearContent', etc.)
 * 3. Remove the `requestId` field from one of the postMessage calls
 * 4. Rebuild: `npx tsc -p tsconfig.test.json`
 * 5. Run this test - it should fail with a clear assertion message identifying
 *    which handler and which response branch lost the echo.
 * 6. Restore the requestId field and re-run to confirm the test passes.
 *
 * IMPLEMENTATION NOTES:
 * - We load the real compiled KanbanProvider from out/services/KanbanProvider.js.
 * - We do NOT construct it (its constructor touches workspaceState, etc. and is
 *   irrelevant to the wire contract). Instead we assemble the minimal instance
 *   fields and call `_handleMessage` via the prototype — this exercises the
 *   EXACT code path that runs in production, not a stub.
 * - All outbound service dependencies (Notion/Linear/ClickUp adapters, local
 *   folder service) are replaced with in-test stubs whose success/error paths
 *   we can force deterministically. This isolates the echo wire contract from
 *   network and filesystem concerns.
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const Module = require('module');

// ── Bootstrap: copy the sibling .js impl that tsc does not emit ─────
// tsc only emits .ts → .js; it does NOT copy source .js files in the tree,
// so `out/services/kanbanColumnDerivation.js`'s `require('./kanbanColumnDerivationImpl.js')`
// fails unless we mirror the source .js into out/ at test time.
(function copyJsSiblings() {
    const pairs = [
        ['src/services/kanbanColumnDerivationImpl.js', 'out/services/kanbanColumnDerivationImpl.js']
    ];
    for (const [src, dst] of pairs) {
        const srcAbs = path.join(process.cwd(), src);
        const dstAbs = path.join(process.cwd(), dst);
        if (!fs.existsSync(dstAbs) && fs.existsSync(srcAbs)) {
            fs.mkdirSync(path.dirname(dstAbs), { recursive: true });
            fs.copyFileSync(srcAbs, dstAbs);
        }
    }
})();

// ── VS Code mock: minimal surface for whatever _handleMessage branches we
//    exercise. Enough to load the module and satisfy any vscode.* references
//    the hot path touches. ─────────────────────────────────────────────────
function installFullVsCodeMock() {
    const originalLoad = Module._load;

    class EventEmitter {
        constructor() {
            this._listeners = [];
        }
        get event() {
            return (fn) => {
                this._listeners.push(fn);
                return { dispose: () => {
                    this._listeners = this._listeners.filter(l => l !== fn);
                } };
            };
        }
        fire(payload) {
            for (const fn of this._listeners) { try { fn(payload); } catch (_) {} }
        }
        dispose() { this._listeners = []; }
    }

    const mock = {
        workspace: {
            workspaceFolders: [],
            getConfiguration: (_section, _scope) => ({
                get: (_k, d) => d,
                update: async () => {},
                has: () => false,
                inspect: () => undefined
            }),
            onDidChangeConfiguration: () => ({ dispose() {} }),
            onDidChangeWorkspaceFolders: () => ({ dispose() {} }),
            createFileSystemWatcher: () => ({
                onDidCreate: () => ({ dispose() {} }),
                onDidChange: () => ({ dispose() {} }),
                onDidDelete: () => ({ dispose() {} }),
                dispose() {}
            })
        },
        window: {
            showInformationMessage: async () => undefined,
            showWarningMessage: async () => undefined,
            showErrorMessage: async () => undefined,
            showInputBox: async () => undefined,
            showQuickPick: async () => undefined,
            createWebviewPanel: () => null,
            withProgress: async (_opts, fn) => fn({ report() {} }, { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) })
        },
        env: {
            appName: 'TestHost',
            clipboard: { writeText: async () => {} },
            openExternal: async () => true
        },
        commands: {
            executeCommand: async () => undefined,
            registerCommand: () => ({ dispose() {} })
        },
        Uri: {
            parse: (v) => ({ fsPath: v, path: v, scheme: 'file', toString: () => v }),
            file: (p) => ({ fsPath: p, path: p, scheme: 'file', toString: () => p }),
            joinPath: (base, ...parts) => ({ fsPath: [base?.fsPath || '', ...parts].join('/'), path: [base?.path || '', ...parts].join('/'), scheme: 'file' })
        },
        EventEmitter,
        Disposable: class { static from() { return { dispose() {} }; } dispose() {} },
        ViewColumn: { One: 1, Two: 2, Three: 3 },
        ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
        ProgressLocation: { Notification: 15, Window: 10, SourceControl: 1 },
        ThemeIcon: class { constructor(id) { this.id = id; } },
        ThemeColor: class { constructor(id) { this.id = id; } },
        TreeItem: class {},
        TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
        RelativePattern: class { constructor(base, pattern) { this.base = base; this.pattern = pattern; } },
        MarkdownString: class { constructor(v) { this.value = v; } appendMarkdown(v) { this.value += v; return this; } appendCodeblock(v) { this.value += '\n```\n' + v + '\n```\n'; return this; } },
        FileType: { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 },
        extensions: { getExtension: () => undefined },
        version: '1.0.0-test'
    };

    Module._load = function patched(request, parent, isMain) {
        if (request === 'vscode') { return mock; }
        return originalLoad.call(this, request, parent, isMain);
    };

    return {
        mock,
        restore() { Module._load = originalLoad; }
    };
}

// ── Helpers ─────────────────────────────────────────────────────────
function makeCapturingPanel() {
    const posts = [];
    return {
        panel: {
            webview: {
                postMessage: (m) => { posts.push(m); return Promise.resolve(true); }
            },
            reveal() {},
            dispose() {},
            onDidDispose: () => ({ dispose() {} })
        },
        posts
    };
}

// Build a bare provider instance that shares the real KanbanProvider prototype.
// This avoids running the heavyweight constructor while ensuring _handleMessage
// executes the real logic.
function makeBareProvider(KanbanProviderCtor, overrides) {
    const inst = Object.create(KanbanProviderCtor.prototype);
    // Minimal instance fields that the handlers we test touch.
    inst._disposables = [];
    inst._lastRequestIds = {};
    inst._plannerPromptWriteQueue = new Map();
    inst._notionServices = new Map();
    inst._localFolderServices = new Map();
    inst._linearDocsAdapters = new Map();
    inst._clickUpDocsAdapters = new Map();
    inst._notionBrowseServices = new Map();
    inst._currentWorkspaceRoot = overrides.workspaceRoot;
    inst._selectedWorkspaceRoot = overrides.workspaceRoot;
    // _resolveWorkspaceRoot uses workspaceFolders when msg.workspaceRoot is falsy;
    // since we always pass workspaceRoot explicitly, this isn't critical, but
    // we still override to avoid surprises from other handlers.
    inst._resolveWorkspaceRoot = (requested) => requested || overrides.workspaceRoot;
    // Inject service factories so we don't hit disk/network.
    inst._getNotionService = () => overrides.notionService;
    inst._getNotionBrowseService = () => overrides.notionBrowseService;
    inst._getLocalFolderService = () => overrides.localFolderService;
    inst._getLinearDocsAdapter = () => overrides.linearDocsAdapter;
    inst._getClickUpDocsAdapter = () => overrides.clickUpDocsAdapter;
    inst._panel = overrides.panel;
    return inst;
}

// Stub service factory: by default returns "no config" state; callers can
// swap to failing/succeeding behaviors per scenario.
function stubNotionService(behavior = 'empty') {
    return {
        loadConfig: async () => behavior === 'config'
            ? { pageUrl: 'https://notion.so/x', pageId: 'x', pageTitle: 'X', setupComplete: true, lastFetchAt: '2026-04-17T00:00:00Z', designDocUrl: '' }
            : null,
        loadCachedContent: async () => behavior === 'config' ? 'cached' : null,
        fetchAndCache: async () => behavior === 'success'
            ? { success: true, pageTitle: 'Title', charCount: 42 }
            : { success: false, error: 'boom' }
    };
}

function stubNotionBrowseService(behavior = 'success') {
    return {
        searchPages: async () => behavior === 'success'
            ? { success: true, pages: [{ id: 'p1', title: 'P1' }] }
            : { success: false, error: 'search-boom' }
    };
}

function stubLocalFolderService(behavior = 'empty') {
    return {
        loadConfig: async () => behavior === 'config'
            ? { selectedFile: 'a.md', docTitle: 'A', setupComplete: true, lastFetchAt: '2026-04-17T00:00:00Z' }
            : null,
        loadCachedContent: async () => behavior === 'config' ? 'cached' : null,
        getFolderPath: () => '/tmp/folder',
        listFiles: async () => [{ name: 'a.md', relativePath: 'a.md' }],
        setFolderPath: async () => {},
        fetchDocContent: async () => behavior === 'success'
            ? { success: true, docTitle: 'A', content: 'content' }
            : { success: false, error: 'local-boom' }
    };
}

function stubLinearDocsAdapter(behavior = 'empty') {
    return {
        loadConfig: async () => behavior === 'config'
            ? { docId: 'd1', docTitle: 'D1', docUrl: '', setupComplete: true, lastFetchAt: '2026-04-17T00:00:00Z' }
            : null,
        loadCachedContent: async () => behavior === 'config' ? 'cached' : null,
        listDocuments: async () => [{ id: 'd1', title: 'D1' }],
        fetchDocContent: async () => behavior === 'success'
            ? { success: true, docTitle: 'D1', content: 'content' }
            : { success: false, error: 'linear-boom' },
        saveConfig: async () => {}
    };
}

function stubClickUpDocsAdapter(behavior = 'empty') {
    return {
        loadConfig: async () => behavior === 'config'
            ? { docId: 'c1', docTitle: 'C1', docUrl: '', setupComplete: true, lastFetchAt: '2026-04-17T00:00:00Z' }
            : null,
        loadCachedContent: async () => behavior === 'config' ? 'cached' : null,
        listDocuments: async () => [{ id: 'c1', title: 'C1' }],
        fetchDocContent: async () => behavior === 'success'
            ? { success: true, docTitle: 'C1', content: 'content' }
            : { success: false, error: 'clickup-boom' },
        saveConfig: async () => {}
    };
}

// Assertion helper: every post by this handler must carry the expected requestId.
function assertAllEcho(posts, expected, handlerLabel) {
    assert.ok(posts.length > 0, `${handlerLabel}: expected at least one outbound post, got 0`);
    for (let i = 0; i < posts.length; i++) {
        const p = posts[i];
        assert.strictEqual(
            p.requestId,
            expected,
            `${handlerLabel}: response #${i} (type=${p.type}) lost the requestId echo. ` +
            `Expected ${expected}, got ${JSON.stringify(p.requestId)}. Full payload: ${JSON.stringify(p)}`
        );
    }
}

// ── Test scenarios ──────────────────────────────────────────────────
async function run() {
    console.log('Running Planning Modal RequestId Wire Contract Tests...');

    const vscodeMock = installFullVsCodeMock();
    // Load AFTER mock is installed so the module picks up our vscode stub.
    const { KanbanProvider } = require(path.join(process.cwd(), 'out/services/KanbanProvider.js'));

    const REQUEST_ID = 424242;
    const workspaceRoot = '/tmp/fake-workspace';

    try {
        // 1. getNotionFetchState — config branch
        {
            const { panel, posts } = makeCapturingPanel();
            const provider = makeBareProvider(KanbanProvider, {
                workspaceRoot, panel,
                notionService: stubNotionService('config')
            });
            await provider._handleMessage({ type: 'getNotionFetchState', workspaceRoot, requestId: REQUEST_ID });
            assertAllEcho(posts, REQUEST_ID, 'getNotionFetchState[config]');
            console.log('  ✓ getNotionFetchState (config branch) echoes requestId');
        }

        // 2. getNotionFetchState — empty branch
        {
            const { panel, posts } = makeCapturingPanel();
            const provider = makeBareProvider(KanbanProvider, {
                workspaceRoot, panel,
                notionService: stubNotionService('empty')
            });
            await provider._handleMessage({ type: 'getNotionFetchState', workspaceRoot, requestId: REQUEST_ID });
            assertAllEcho(posts, REQUEST_ID, 'getNotionFetchState[empty]');
            console.log('  ✓ getNotionFetchState (empty branch) echoes requestId');
        }

        // 3. fetchNotionContent — success branch
        {
            const { panel, posts } = makeCapturingPanel();
            const provider = makeBareProvider(KanbanProvider, {
                workspaceRoot, panel,
                notionService: stubNotionService('success')
            });
            await provider._handleMessage({
                type: 'fetchNotionContent',
                workspaceRoot,
                url: 'https://www.notion.so/abc',
                requestId: REQUEST_ID
            });
            assertAllEcho(posts, REQUEST_ID, 'fetchNotionContent[success]');
            console.log('  ✓ fetchNotionContent (success branch) echoes requestId');
        }

        // 4. fetchNotionContent — error branch (service returns failure)
        {
            const { panel, posts } = makeCapturingPanel();
            const provider = makeBareProvider(KanbanProvider, {
                workspaceRoot, panel,
                notionService: stubNotionService('failure')
            });
            await provider._handleMessage({
                type: 'fetchNotionContent',
                workspaceRoot,
                url: 'https://www.notion.so/abc',
                requestId: REQUEST_ID
            });
            assertAllEcho(posts, REQUEST_ID, 'fetchNotionContent[error]');
            console.log('  ✓ fetchNotionContent (error branch) echoes requestId');
        }

        // 5. fetchNotionContent — thrown exception branch
        {
            const { panel, posts } = makeCapturingPanel();
            const throwingNotion = stubNotionService('failure');
            throwingNotion.fetchAndCache = async () => { throw new Error('network-down'); };
            const provider = makeBareProvider(KanbanProvider, {
                workspaceRoot, panel,
                notionService: throwingNotion
            });
            await provider._handleMessage({
                type: 'fetchNotionContent',
                workspaceRoot,
                url: 'https://www.notion.so/abc',
                requestId: REQUEST_ID
            });
            assertAllEcho(posts, REQUEST_ID, 'fetchNotionContent[thrown]');
            console.log('  ✓ fetchNotionContent (exception branch) echoes requestId');
        }

        // 6. searchNotionPages — success branch
        {
            const { panel, posts } = makeCapturingPanel();
            const provider = makeBareProvider(KanbanProvider, {
                workspaceRoot, panel,
                notionBrowseService: stubNotionBrowseService('success')
            });
            await provider._handleMessage({
                type: 'searchNotionPages', workspaceRoot, query: 'q', requestId: REQUEST_ID
            });
            assertAllEcho(posts, REQUEST_ID, 'searchNotionPages[success]');
            console.log('  ✓ searchNotionPages (success) echoes requestId');
        }

        // 7. searchNotionPages — failure branch
        {
            const { panel, posts } = makeCapturingPanel();
            const provider = makeBareProvider(KanbanProvider, {
                workspaceRoot, panel,
                notionBrowseService: stubNotionBrowseService('failure')
            });
            await provider._handleMessage({
                type: 'searchNotionPages', workspaceRoot, query: 'q', requestId: REQUEST_ID
            });
            assertAllEcho(posts, REQUEST_ID, 'searchNotionPages[failure]');
            console.log('  ✓ searchNotionPages (failure) echoes requestId');
        }

        // 8. getLocalFolderFetchState — config branch
        {
            const { panel, posts } = makeCapturingPanel();
            const provider = makeBareProvider(KanbanProvider, {
                workspaceRoot, panel,
                localFolderService: stubLocalFolderService('config')
            });
            await provider._handleMessage({
                type: 'getLocalFolderFetchState', workspaceRoot, requestId: REQUEST_ID
            });
            assertAllEcho(posts, REQUEST_ID, 'getLocalFolderFetchState[config]');
            console.log('  ✓ getLocalFolderFetchState (config) echoes requestId');
        }

        // 9. getLocalFolderFetchState — empty branch
        {
            const { panel, posts } = makeCapturingPanel();
            const provider = makeBareProvider(KanbanProvider, {
                workspaceRoot, panel,
                localFolderService: stubLocalFolderService('empty')
            });
            await provider._handleMessage({
                type: 'getLocalFolderFetchState', workspaceRoot, requestId: REQUEST_ID
            });
            assertAllEcho(posts, REQUEST_ID, 'getLocalFolderFetchState[empty]');
            console.log('  ✓ getLocalFolderFetchState (empty) echoes requestId');
        }

        // 10. setLocalFolderPath
        {
            const { panel, posts } = makeCapturingPanel();
            const provider = makeBareProvider(KanbanProvider, {
                workspaceRoot, panel,
                localFolderService: stubLocalFolderService('config')
            });
            await provider._handleMessage({
                type: 'setLocalFolderPath', workspaceRoot, folderPath: '/tmp/folder', requestId: REQUEST_ID
            });
            assertAllEcho(posts, REQUEST_ID, 'setLocalFolderPath');
            console.log('  ✓ setLocalFolderPath echoes requestId');
        }

        // 11. fetchLocalFolderContent — success
        {
            const { panel, posts } = makeCapturingPanel();
            const provider = makeBareProvider(KanbanProvider, {
                workspaceRoot, panel,
                localFolderService: stubLocalFolderService('success')
            });
            await provider._handleMessage({
                type: 'fetchLocalFolderContent', workspaceRoot, relativePath: 'a.md', requestId: REQUEST_ID
            });
            assertAllEcho(posts, REQUEST_ID, 'fetchLocalFolderContent[success]');
            console.log('  ✓ fetchLocalFolderContent (success) echoes requestId');
        }

        // 12. fetchLocalFolderContent — failure
        {
            const { panel, posts } = makeCapturingPanel();
            const provider = makeBareProvider(KanbanProvider, {
                workspaceRoot, panel,
                localFolderService: stubLocalFolderService('failure')
            });
            await provider._handleMessage({
                type: 'fetchLocalFolderContent', workspaceRoot, relativePath: 'a.md', requestId: REQUEST_ID
            });
            assertAllEcho(posts, REQUEST_ID, 'fetchLocalFolderContent[failure]');
            console.log('  ✓ fetchLocalFolderContent (failure) echoes requestId');
        }

        // 13. getLinearFetchState — config branch
        {
            const { panel, posts } = makeCapturingPanel();
            const provider = makeBareProvider(KanbanProvider, {
                workspaceRoot, panel,
                linearDocsAdapter: stubLinearDocsAdapter('config')
            });
            await provider._handleMessage({ type: 'getLinearFetchState', workspaceRoot, requestId: REQUEST_ID });
            assertAllEcho(posts, REQUEST_ID, 'getLinearFetchState[config]');
            console.log('  ✓ getLinearFetchState (config) echoes requestId');
        }

        // 14. getLinearFetchState — empty branch
        {
            const { panel, posts } = makeCapturingPanel();
            const provider = makeBareProvider(KanbanProvider, {
                workspaceRoot, panel,
                linearDocsAdapter: stubLinearDocsAdapter('empty')
            });
            await provider._handleMessage({ type: 'getLinearFetchState', workspaceRoot, requestId: REQUEST_ID });
            assertAllEcho(posts, REQUEST_ID, 'getLinearFetchState[empty]');
            console.log('  ✓ getLinearFetchState (empty) echoes requestId');
        }

        // 15. fetchLinearContent — success
        {
            const { panel, posts } = makeCapturingPanel();
            const provider = makeBareProvider(KanbanProvider, {
                workspaceRoot, panel,
                linearDocsAdapter: stubLinearDocsAdapter('success')
            });
            await provider._handleMessage({
                type: 'fetchLinearContent', workspaceRoot, docId: 'd1', requestId: REQUEST_ID
            });
            assertAllEcho(posts, REQUEST_ID, 'fetchLinearContent[success]');
            console.log('  ✓ fetchLinearContent (success) echoes requestId');
        }

        // 16. fetchLinearContent — failure
        {
            const { panel, posts } = makeCapturingPanel();
            const provider = makeBareProvider(KanbanProvider, {
                workspaceRoot, panel,
                linearDocsAdapter: stubLinearDocsAdapter('failure')
            });
            await provider._handleMessage({
                type: 'fetchLinearContent', workspaceRoot, docId: 'd1', requestId: REQUEST_ID
            });
            assertAllEcho(posts, REQUEST_ID, 'fetchLinearContent[failure]');
            console.log('  ✓ fetchLinearContent (failure) echoes requestId');
        }

        // 17. getClickUpFetchState — config branch
        {
            const { panel, posts } = makeCapturingPanel();
            const provider = makeBareProvider(KanbanProvider, {
                workspaceRoot, panel,
                clickUpDocsAdapter: stubClickUpDocsAdapter('config')
            });
            await provider._handleMessage({ type: 'getClickUpFetchState', workspaceRoot, requestId: REQUEST_ID });
            assertAllEcho(posts, REQUEST_ID, 'getClickUpFetchState[config]');
            console.log('  ✓ getClickUpFetchState (config) echoes requestId');
        }

        // 18. getClickUpFetchState — empty branch
        {
            const { panel, posts } = makeCapturingPanel();
            const provider = makeBareProvider(KanbanProvider, {
                workspaceRoot, panel,
                clickUpDocsAdapter: stubClickUpDocsAdapter('empty')
            });
            await provider._handleMessage({ type: 'getClickUpFetchState', workspaceRoot, requestId: REQUEST_ID });
            assertAllEcho(posts, REQUEST_ID, 'getClickUpFetchState[empty]');
            console.log('  ✓ getClickUpFetchState (empty) echoes requestId');
        }

        // 19. fetchClickUpContent — success
        {
            const { panel, posts } = makeCapturingPanel();
            const provider = makeBareProvider(KanbanProvider, {
                workspaceRoot, panel,
                clickUpDocsAdapter: stubClickUpDocsAdapter('success')
            });
            await provider._handleMessage({
                type: 'fetchClickUpContent', workspaceRoot, docId: 'c1', requestId: REQUEST_ID
            });
            assertAllEcho(posts, REQUEST_ID, 'fetchClickUpContent[success]');
            console.log('  ✓ fetchClickUpContent (success) echoes requestId');
        }

        // 20. fetchClickUpContent — failure
        {
            const { panel, posts } = makeCapturingPanel();
            const provider = makeBareProvider(KanbanProvider, {
                workspaceRoot, panel,
                clickUpDocsAdapter: stubClickUpDocsAdapter('failure')
            });
            await provider._handleMessage({
                type: 'fetchClickUpContent', workspaceRoot, docId: 'c1', requestId: REQUEST_ID
            });
            assertAllEcho(posts, REQUEST_ID, 'fetchClickUpContent[failure]');
            console.log('  ✓ fetchClickUpContent (failure) echoes requestId');
        }

        // 21. Negative test: omit requestId on inbound — provider should still
        //     respond; the echoed field must be undefined (not a stale number
        //     left over from a prior handler). This pins the contract that the
        //     webview guard handles the undefined case, not the provider.
        {
            const { panel, posts } = makeCapturingPanel();
            const provider = makeBareProvider(KanbanProvider, {
                workspaceRoot, panel,
                notionService: stubNotionService('empty')
            });
            await provider._handleMessage({ type: 'getNotionFetchState', workspaceRoot /* no requestId */ });
            assert.ok(posts.length > 0, 'Expected a response even without requestId');
            for (const p of posts) {
                assert.strictEqual(
                    p.requestId,
                    undefined,
                    `Without an inbound requestId, the echoed requestId must be undefined. Got: ${JSON.stringify(p.requestId)}`
                );
            }
            console.log('  ✓ Missing inbound requestId → undefined echo (webview guard handles it)');
        }

        console.log('\nPlanning Modal RequestId Wire Contract Tests Passed.');
    } finally {
        vscodeMock.restore();
    }
}

run().catch((error) => {
    console.error('Planning Modal RequestId Wire Contract Tests Failed:', error);
    process.exit(1);
});
