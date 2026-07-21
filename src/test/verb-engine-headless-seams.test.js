'use strict';

/**
 * Verb Engine · 1 — headless proving-slice test (the A2b acceptance signal).
 *
 * Drives the migrated DesignPanelProvider arms end-to-end through the generic
 * `handleServiceVerb` dispatcher under a BOOBY-TRAPPED vscode module (any
 * property access throws) and an in-memory HostSeams bundle. A passing run
 * proves the migrated arms execute with no vscode reachable, return their
 * results (the HTTP body contract), and keep the webview push additive.
 *
 * Run with:
 *   npm run compile-tests && node src/test/verb-engine-headless-seams.test.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { installVscodeTrap, createHeadlessTestSeams, createFakeStateStore } = require('./helpers/verbEngineTestSeams');

// Install the trap BEFORE any out/services module loads.
installVscodeTrap();

const { DesignPanelProvider } = require('../../out/services/DesignPanelProvider');
const { SetupPanelProvider } = require('../../out/services/SetupPanelProvider');
const { BroadcastHub } = require('../../out/services/broadcastHub');
const { SwitchboardCommandRegistry } = require('../../out/services/commandRegistry');
const { VscodeHostCommands } = require('../../out/services/hostSeams');
const { validateVerbPayload } = require('../../out/services/verbSchemas');
const { KanbanDatabase } = require('../../out/services/KanbanDatabase');

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

/** Build a provider wired for headless execution against a temp workspace. */
function buildHeadlessProvider(tmpRoot, seamOpts = {}) {
    const { seams, recorders } = createHeadlessTestSeams({ roots: [tmpRoot], ...seamOpts });
    const stateStore = createFakeStateStore();
    const pushes = [];
    const fakeWebview = {
        postMessage: (msg) => {
            pushes.push(msg);
            return Promise.resolve(true);
        },
    };
    const provider = new DesignPanelProvider(
        /* extensionUri */ { fsPath: path.join(tmpRoot, 'ext') },
        /* getWorkspaceRoot */ () => tmpRoot,
        /* context */ { secrets: null /* must never be reached — seams carry secrets */ },
        /* stateStore */ stateStore,
        /* taskViewerProvider */ undefined
    );
    // Test-seam injection: the harness assigns the headless bundle directly,
    // pre-empting _initDesignService's vscode-backed bundle.
    provider._hostSeams = seams;
    provider._broadcaster = new BroadcastHub({ webview: fakeWebview, apiServer: null });
    return { provider, seams, recorders, stateStore, pushes };
}

function buildHeadlessSetupProvider(tmpRoot, seamOpts = {}) {
    const { seams, recorders } = createHeadlessTestSeams({ roots: [tmpRoot], ...seamOpts });
    const pushes = [];
    const fakeWebview = {
        postMessage: (msg) => {
            pushes.push(msg);
            return Promise.resolve(true);
        },
    };
    const mockTaskViewer = {
        getIntegrationSetupStates: async () => ({ clickUp: true }),
        handleGetStartupCommands: async () => ({ commands: {} }),
        handleGetColourKanbanIconsSetting: () => true,
        postSetupPanelState: async () => {},
        exportPromptSettings: async () => true,
        importPromptSettings: async () => true,
        copyDbSettingsToGlobal: async () => ({ copied: 0 }),
        handleApplyClickUpConfig: async (token) => ({ success: true, tokenReceived: !!token }),
    };
    const provider = new SetupPanelProvider({ fsPath: path.join(tmpRoot, 'ext') });
    provider.setTaskViewerProvider(mockTaskViewer);
    provider._hostSeams = seams;
    provider._broadcaster = new BroadcastHub({ webview: fakeWebview, apiServer: null });
    return { provider, seams, recorders, pushes, mockTaskViewer };
}

async function main() {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-verb-engine-'));
    const designFolder = path.join(tmpRoot, 'designs');
    const briefsFolder = path.join(tmpRoot, 'briefs');
    fs.mkdirSync(designFolder, { recursive: true });
    fs.mkdirSync(briefsFolder, { recursive: true });

    // A real Switchboard workspace has a kanban.db; KanbanDatabase refuses to
    // auto-create one (scaffold-litter protection), and LocalFolderService
    // persists folder config into it. Provision the DB like the extension does.
    await KanbanDatabase.forWorkspace(tmpRoot).createIfMissing();

    console.log('\n=== Verb Engine · 1 — headless seam tests (DesignPanelProvider slice) ===\n');

    // ── Dispatch contract ────────────────────────────────────────────────
    await test('unknown verb is rejected by the allowlist', async () => {
        const { provider } = buildHeadlessProvider(tmpRoot);
        await assert.rejects(
            () => provider.handleServiceVerb('notARealVerb', {}),
            /Unknown Design verb/
        );
    });

    await test('schema validation rejects malformed payloads at the boundary', async () => {
        const { provider } = buildHeadlessProvider(tmpRoot);
        await assert.rejects(
            () => provider.handleServiceVerb('createBrief', { sourceFolder: briefsFolder }),
            /Invalid payload for Design verb 'createBrief'.*title/
        );
        await assert.rejects(
            () => provider.handleServiceVerb('persistTabState', { tabKey: 42 }),
            /Invalid payload.*tabKey/
        );
    });

    await test('un-migrated verb still dispatches through the generic passthrough', async () => {
        const { provider } = buildHeadlessProvider(tmpRoot);
        // `refreshDocsForTab` with an unmatched tab is a no-op arm that still `break`s.
        const result = await provider.handleServiceVerb('refreshDocsForTab', { tab: 'not-a-tab' });
        assert.strictEqual(result, undefined); // route layer acks {success:true}
    });

    // ── Read verbs return results in the body (the contract fix) ─────────
    await test('listDesignFolders RETURNS the list and keeps the push additive', async () => {
        const { provider, pushes } = buildHeadlessProvider(tmpRoot);
        const result = await provider.handleServiceVerb('listDesignFolders', { workspaceRoot: tmpRoot });
        assert.strictEqual(result.success, true);
        assert.ok(Array.isArray(result.paths));
        const push = pushes.find(p => p.type === 'designFoldersListed');
        assert.ok(push, 'webview push still emitted');
        assert.deepStrictEqual(push.paths, result.paths);
    });

    // ── Write verbs: direct payload path (HTTP callers) ──────────────────
    await test('addDesignFolder accepts folderPath from the payload (no dialog)', async () => {
        const { provider } = buildHeadlessProvider(tmpRoot);
        const result = await provider.handleServiceVerb('addDesignFolder', {
            workspaceRoot: tmpRoot,
            folderPath: designFolder,
        });
        assert.strictEqual(result.success, true);
        assert.ok(result.paths.includes(designFolder), `paths ${JSON.stringify(result.paths)} include added folder`);
    });

    await test('addDesignFolder falls back to the pickFolder seam (webview flow)', async () => {
        const otherFolder = path.join(tmpRoot, 'designs-2');
        fs.mkdirSync(otherFolder, { recursive: true });
        const { provider } = buildHeadlessProvider(tmpRoot, { pickFolderResult: otherFolder });
        const result = await provider.handleServiceVerb('addDesignFolder', { workspaceRoot: tmpRoot });
        assert.strictEqual(result.success, true);
        assert.ok(result.paths.includes(otherFolder));
    });

    await test('addDesignFolder returns success:false when the picker is cancelled', async () => {
        const { provider } = buildHeadlessProvider(tmpRoot); // pickFolderResult undefined
        const result = await provider.handleServiceVerb('addDesignFolder', { workspaceRoot: tmpRoot });
        assert.strictEqual(result.success, false);
    });

    await test('removeDesignFolder removes and returns the updated list', async () => {
        const { provider } = buildHeadlessProvider(tmpRoot);
        const result = await provider.handleServiceVerb('removeDesignFolder', {
            workspaceRoot: tmpRoot,
            folderPath: path.join(tmpRoot, 'designs-2'),
        });
        assert.strictEqual(result.success, true);
        assert.ok(!result.paths.includes(path.join(tmpRoot, 'designs-2')));
        assert.ok(result.paths.includes(designFolder), 'first folder survives');
    });

    await test('folder watchers re-arm through the HostFileWatcher seam', async () => {
        const { provider, recorders } = buildHeadlessProvider(tmpRoot);
        await provider.handleServiceVerb('addHtmlFolder', {
            workspaceRoot: tmpRoot,
            folderPath: designFolder, // any existing dir
        });
        assert.ok(recorders.watchedFolders.includes(designFolder), 'watcher seam saw the folder');
        // cleanup for later assertions
        await provider.handleServiceVerb('removeHtmlFolder', { workspaceRoot: tmpRoot, folderPath: designFolder });
    });

    // ── Secrets seam ──────────────────────────────────────────────────────
    await test('stitchSaveApiKey stores via HostSecrets and returns configured state', async () => {
        const { provider, recorders, pushes } = buildHeadlessProvider(tmpRoot);
        const result = await provider.handleServiceVerb('stitchSaveApiKey', { apiKey: 'test-key-123' });
        assert.strictEqual(result.success, true);
        assert.strictEqual(result.configured, true);
        assert.strictEqual(recorders.secrets.get('switchboard.stitch.apiKey'), 'test-key-123');
        assert.ok(pushes.some(p => p.type === 'stitchApiKeyStatus' && p.configured === true));
        assert.ok(recorders.notifications.some(n => /API Key saved/i.test(n)));
        delete process.env.STITCH_API_KEY;
    });

    // ── Clipboard + notification seams ───────────────────────────────────
    await test('copyHtmlTweakPrompt writes through the clipboard seam', async () => {
        const { provider, recorders } = buildHeadlessProvider(tmpRoot);
        const result = await provider.handleServiceVerb('copyHtmlTweakPrompt', { prompt: 'tweak this' });
        assert.strictEqual(result.success, true);
        assert.deepStrictEqual(recorders.clipboardWrites, ['tweak this']);
        assert.strictEqual(recorders.notifications.length, 1);
    });

    await test('copyStitchTweakPrompt returns success:false on empty prompt', async () => {
        const { provider, recorders } = buildHeadlessProvider(tmpRoot);
        const result = await provider.handleServiceVerb('copyStitchTweakPrompt', { prompt: '' });
        assert.strictEqual(result.success, false);
        assert.strictEqual(recorders.clipboardWrites.length, 0);
    });

    // ── State store ───────────────────────────────────────────────────────
    await test('persistTabState persists panel + per-root state and returns success', async () => {
        const { provider, stateStore } = buildHeadlessProvider(tmpRoot);
        const r1 = await provider.handleServiceVerb('persistTabState', { tabKey: 'stitch', state: { a: 1 } });
        assert.strictEqual(r1.success, true);
        assert.deepStrictEqual(stateStore.getPanelState('stitch'), { a: 1 });
        const r2 = await provider.handleServiceVerb('persistTabState', { tabKey: 'stitch', workspaceRoot: tmpRoot, state: { b: 2 } });
        assert.strictEqual(r2.success, true);
        assert.deepStrictEqual(stateStore.getRootState('stitch', tmpRoot), { b: 2 });
    });

    await test('activeTabChanged updates provider state headlessly', async () => {
        const { provider } = buildHeadlessProvider(tmpRoot);
        const result = await provider.handleServiceVerb('activeTabChanged', { tab: 'briefs' });
        assert.deepStrictEqual(result, { success: true, activeTab: 'briefs' });
    });

    // ── Briefs CRUD ───────────────────────────────────────────────────────
    await test('createBrief + deleteBrief round-trip in a configured briefs folder', async () => {
        const { provider } = buildHeadlessProvider(tmpRoot);
        const added = await provider.handleServiceVerb('addBriefsFolder', {
            workspaceRoot: tmpRoot,
            folderPath: briefsFolder,
        });
        assert.strictEqual(added.success, true);

        const created = await provider.handleServiceVerb('createBrief', {
            workspaceRoot: tmpRoot,
            sourceFolder: briefsFolder,
            title: 'My Test Brief',
        });
        assert.strictEqual(created.success, true);
        assert.ok(created.docId, 'created brief reports its docId');
        const briefPath = path.join(briefsFolder, created.docId.split(':')[1]);
        assert.ok(fs.existsSync(briefPath), 'brief file exists on disk');
        assert.ok(fs.readFileSync(briefPath, 'utf8').startsWith('# My Test Brief'));

        const deleted = await provider.handleServiceVerb('deleteBrief', {
            workspaceRoot: tmpRoot,
            sourceFolder: briefsFolder,
            docId: created.docId,
        });
        assert.strictEqual(deleted.success, true);
        assert.ok(!fs.existsSync(briefPath), 'brief file removed');
    });

    await test('createBrief refuses an unconfigured source folder', async () => {
        const { provider } = buildHeadlessProvider(tmpRoot);
        const rogue = path.join(tmpRoot, 'rogue');
        fs.mkdirSync(rogue, { recursive: true });
        const result = await provider.handleServiceVerb('createBrief', {
            workspaceRoot: tmpRoot,
            sourceFolder: rogue,
            title: 'Nope',
        });
        assert.strictEqual(result.success, false);
        assert.match(result.error, /not a configured briefs folder/);
    });

    // ── Command registry (host-agnostic switchboard.* dispatch) ──────────
    await test('registry-first HostCommands executes registered commands with no vscode', async () => {
        const registry = new SwitchboardCommandRegistry();
        let calledWith = null;
        registry.register('switchboard.fullSync', async (arg) => {
            calledWith = arg;
            return { synced: true };
        });
        const commands = new VscodeHostCommands(registry);
        const result = await commands.executeCommand('switchboard.fullSync', 'root-a');
        assert.deepStrictEqual(result, { synced: true });
        assert.strictEqual(calledWith, 'root-a');
    });

    await test('verb schema validator passes schemaless verbs through', () => {
        assert.deepStrictEqual(validateVerbPayload('design', 'stitchGenerate', { anything: 1 }), { ok: true });
        assert.deepStrictEqual(validateVerbPayload('kanban', 'whatever', null), { ok: true });
        const bad = validateVerbPayload('design', 'removeDesignFolder', {});
        assert.strictEqual(bad.ok, false);
    });

    // ── SetupPanelProvider slice ──────────────────────────────────────────
    await test('Setup: getIntegrationSetupStates RETURNS data in body and emits push', async () => {
        const { provider, pushes } = buildHeadlessSetupProvider(tmpRoot);
        const result = await provider.handleServiceVerb('getIntegrationSetupStates', {});
        assert.strictEqual(result.success, true);
        assert.strictEqual(result.clickUp, true);
        const push = pushes.find(p => p.type === 'integrationSetupStates');
        assert.ok(push, 'webview push emitted');
        assert.strictEqual(push.clickUp, true);
    });

    await test('Setup: applyClickUpConfig schema validates and RETURNS body data', async () => {
        const { provider, pushes } = buildHeadlessSetupProvider(tmpRoot);
        const result = await provider.handleServiceVerb('applyClickUpConfig', { token: 'secret-token-123' });
        assert.strictEqual(result.success, true);
        assert.strictEqual(result.tokenReceived, true);
        const push = pushes.find(p => p.type === 'clickupApplyResult');
        assert.ok(push, 'webview push emitted');
    });

    // ── Cleanup ───────────────────────────────────────────────────────────
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}

    console.log(`\n${passed} passed, ${failed} failed\n`);
    process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
