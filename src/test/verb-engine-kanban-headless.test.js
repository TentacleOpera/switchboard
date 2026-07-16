'use strict';

/**
 * Verb Engine · 4 — KanbanProvider headless seam tests (the A2b acceptance signal).
 *
 * Drives migrated KanbanProvider arms end-to-end through the generic
 * `handleServiceVerb` dispatcher under a BOOBY-TRAPPED vscode module (any
 * property access throws) and an in-memory HostSeams bundle. A passing run
 * proves the migrated arms execute with no vscode reachable, return their
 * results (the HTTP body contract), and keep the webview push additive.
 *
 * The KanbanProvider constructor is vscode-coupled (config reads, event
 * subscriptions), so the harness builds the provider via
 * Object.create(KanbanProvider.prototype) and hand-wires exactly the state the
 * dispatch path needs — including a real KanbanService with a headless ctx
 * (pre-empting _initKanbanService, which would rebuild vscode-backed seams).
 *
 * Run with:
 *   npm run compile-tests && node src/test/verb-engine-kanban-headless.test.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { installVscodeTrap, createHeadlessTestSeams } = require('./helpers/verbEngineTestSeams');

// Install the trap BEFORE any out/services module loads.
installVscodeTrap();

// tsc does not emit plain-JS sources (allowJs off), so the hand-written
// kanbanColumnDerivationImpl.js never lands in out/ — copy it in so the
// compiled KanbanProvider's require chain resolves (pre-existing gap, same
// issue noted in sanitize-tags-regression.test.js).
{
    const implSrc = path.join(__dirname, '..', 'services', 'kanbanColumnDerivationImpl.js');
    const implOut = path.join(__dirname, '..', '..', 'out', 'services', 'kanbanColumnDerivationImpl.js');
    if (!fs.existsSync(implOut)) {
        fs.copyFileSync(implSrc, implOut);
    }
}

const { KanbanProvider } = require('../../out/services/KanbanProvider');
const { KanbanService } = require('../../out/services/kanbanService');
const { BroadcastHub } = require('../../out/services/broadcastHub');
const { validateVerbPayload } = require('../../out/services/verbSchemas');

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

/**
 * Build a KanbanProvider wired for headless execution. Constructor is skipped
 * (vscode-coupled); the fields the dispatch path reads are set directly.
 */
function buildHeadlessProvider(tmpRoot, seamOpts = {}) {
    const { seams, recorders } = createHeadlessTestSeams({ roots: [tmpRoot], ...seamOpts });
    const pushes = [];
    const fakeWebview = {
        postMessage: (msg) => {
            pushes.push(msg);
            return Promise.resolve(true);
        },
    };
    const workspaceState = new Map();

    const provider = Object.create(KanbanProvider.prototype);
    provider._context = {
        workspaceState: {
            get: (key, dflt) => (workspaceState.has(key) ? workspaceState.get(key) : dflt),
            update: async (key, value) => { workspaceState.set(key, value); },
        },
        globalState: {
            get: () => undefined,
            update: async () => {},
        },
        secrets: null, // must never be reached — seams carry secrets
        subscriptions: [],
    };
    provider._currentWorkspaceRoot = tmpRoot;
    provider._hostSeams = seams;
    provider._broadcaster = new BroadcastHub({ webview: fakeWebview, apiServer: null });
    provider._lastCards = [];
    provider._pendingWebviewMessages = [];
    provider._sessionLogs = new Map();
    provider._columnDragDropModes = {};
    provider._showingBacklog = false;
    provider._cliTriggersEnabled = true;

    const scopedSettings = new Map();
    const roleConfigs = new Map();
    // Real KanbanService with a headless ctx — pre-empts _initKanbanService.
    provider._kanbanService = new KanbanService({
        get workspaceRoot() { return provider._currentWorkspaceRoot || ''; },
        seams,
        broadcaster: provider._broadcaster,
        resolveSessionId: (planId, sessionId) => planId || sessionId,
        selectSession: (sessionId) => { recorders.selectedSessions = recorders.selectedSessions || []; recorders.selectedSessions.push(sessionId); },
        triggerPlanScan: async () => { recorders.planScans = (recorders.planScans || 0) + 1; },
        handleMessage: async (msg) => provider._handleMessage(msg),
        workspaceStateGet: (key) => workspaceState.get(key),
        workspaceStateUpdate: async (key, value) => { workspaceState.set(key, value); },
        getScopedRoleConfig: (roleName) => roleConfigs.get(roleName),
        updateScopedRoleConfig: async (roleName, value) => { roleConfigs.set(roleName, value); },
        getScopedSetting: (key, dflt) => (scopedSettings.has(key) ? scopedSettings.get(key) : dflt),
        updateScopedSetting: async (key, value) => { scopedSettings.set(key, value); },
        remoteGetConfigPayload: async () => null,
        remoteSetConfig: async () => null,
    });

    return { provider, seams, recorders, pushes, workspaceState, scopedSettings, roleConfigs };
}

async function main() {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-verb-engine-kanban-'));

    console.log('\n=== Verb Engine · 4 — KanbanProvider headless seam tests ===\n');

    // ── Dispatch contract ────────────────────────────────────────────────
    await test('unknown verb is rejected by the allowlist', async () => {
        const { provider } = buildHeadlessProvider(tmpRoot);
        await assert.rejects(
            () => provider.handleServiceVerb('notARealVerb', {}),
            /Unknown Kanban verb/
        );
    });

    await test('schema validation rejects malformed dispatch payloads (triggerAction)', async () => {
        const { provider } = buildHeadlessProvider(tmpRoot);
        await assert.rejects(
            () => provider.handleServiceVerb('triggerAction', { targetColumn: 'LEAD CODED' }),
            /Invalid payload for Kanban verb 'triggerAction'.*sessionId/
        );
        await assert.rejects(
            () => provider.handleServiceVerb('triggerAction', { sessionId: 42, targetColumn: 'LEAD CODED' }),
            /Invalid payload.*sessionId/
        );
    });

    await test('schema validation rejects malformed move payloads (moveCardForward)', async () => {
        const { provider } = buildHeadlessProvider(tmpRoot);
        await assert.rejects(
            () => provider.handleServiceVerb('moveCardForward', { sessionIds: ['a'] }),
            /Invalid payload.*targetColumn/
        );
        await assert.rejects(
            () => provider.handleServiceVerb('moveCardForward', { sessionIds: 'not-an-array', targetColumn: 'CODED' }),
            /Invalid payload.*sessionIds/
        );
    });

    // ── Error paths return {success:false, error} in the body ────────────
    await test('guard failures RETURN their error in the body (reassignPlansWorkspace)', async () => {
        const { provider } = buildHeadlessProvider(tmpRoot);
        const result = await provider.handleServiceVerb('reassignPlansWorkspace', {
            sessionIds: [],
            targetWorkspaceRoot: path.join(tmpRoot, 'other'),
        });
        assert.strictEqual(result.success, false);
        assert.match(result.error, /required/);
    });

    // ── UI seams ──────────────────────────────────────────────────────────
    await test('showWarning routes through the HostUI seam and returns success', async () => {
        const { provider, recorders } = buildHeadlessProvider(tmpRoot);
        const result = await provider.handleServiceVerb('showWarning', { message: 'heads up' });
        assert.strictEqual(result.success, true);
        assert.deepStrictEqual(recorders.warningMessages, ['heads up']);
    });

    await test('showInfo routes through the HostUI seam', async () => {
        const { provider, recorders } = buildHeadlessProvider(tmpRoot);
        const result = await provider.handleServiceVerb('showInfo', { message: 'fyi' });
        assert.strictEqual(result.success, true);
        assert.deepStrictEqual(recorders.infoMessages, ['fyi']);
    });

    // ── Config seam ───────────────────────────────────────────────────────
    await test('getDbPath reads through the HostPathConfigProvider seam and returns the path', async () => {
        const { provider, pushes } = buildHeadlessProvider(tmpRoot, { config: { 'kanban.dbPath': '/custom/kanban.db' } });
        const result = await provider.handleServiceVerb('getDbPath', {});
        assert.strictEqual(result.success, true);
        assert.strictEqual(result.path, '/custom/kanban.db');
        const push = pushes.find(p => p.type === 'dbPathUpdated');
        assert.ok(push, 'webview push still emitted');
        assert.strictEqual(push.path, result.path);
    });

    await test('getDbPath falls back to the default when unset', async () => {
        const { provider } = buildHeadlessProvider(tmpRoot);
        const result = await provider.handleServiceVerb('getDbPath', {});
        assert.strictEqual(result.path, '.switchboard/kanban.db');
    });

    // ── Command seam ──────────────────────────────────────────────────────
    await test('importFromClipboard executes switchboard.importPlanFromClipboard via the command seam', async () => {
        const { provider, recorders } = buildHeadlessProvider(tmpRoot);
        const result = await provider.handleServiceVerb('importFromClipboard', { markdownText: '# plan' });
        assert.strictEqual(result.success, true);
        assert.deepStrictEqual(recorders.executedCommands, [
            { command: 'switchboard.importPlanFromClipboard', args: ['# plan'] },
        ]);
    });

    await test('focusTerminal (folded kanbanService verb) RETURNS the service result', async () => {
        const { provider, recorders } = buildHeadlessProvider(tmpRoot);
        const result = await provider.handleServiceVerb('focusTerminal', { terminalName: 'Lead' });
        assert.deepStrictEqual(result, { success: true });
        assert.deepStrictEqual(recorders.executedCommands, [
            { command: 'switchboard.focusTerminalByName', args: ['Lead'] },
        ]);
    });

    await test('refresh (folded kanbanService verb) triggers fullSync via the command seam', async () => {
        const { provider, recorders } = buildHeadlessProvider(tmpRoot);
        const result = await provider.handleServiceVerb('refresh', {});
        assert.deepStrictEqual(result, { success: true });
        assert.deepStrictEqual(recorders.executedCommands, [
            { command: 'switchboard.fullSync', args: [] },
        ]);
    });

    // ── Read verbs return results in the body (the contract fix) ─────────
    await test('fileExists RETURNS the answer and keeps the push additive', async () => {
        const { provider, pushes } = buildHeadlessProvider(tmpRoot);
        const filePath = 'exists.txt';
        fs.writeFileSync(path.join(tmpRoot, filePath), 'x');
        const result = await provider.handleServiceVerb('fileExists', { path: filePath, workspaceRoot: tmpRoot });
        assert.strictEqual(result.success, true);
        assert.strictEqual(result.exists, true);
        const push = pushes.find(p => p.type === 'fileExistsResult');
        assert.ok(push, 'webview push still emitted');
        assert.strictEqual(push.exists, true);
    });

    await test('saveSetting + getSetting round-trip through the folded kanbanService verbs', async () => {
        const { provider, pushes } = buildHeadlessProvider(tmpRoot);
        const saved = await provider.handleServiceVerb('saveSetting', { key: 'customPrefix', value: 'hello' });
        assert.strictEqual(saved.success, true);
        const got = await provider.handleServiceVerb('getSetting', { key: 'customPrefix' });
        assert.strictEqual(got.success, true);
        assert.strictEqual(got.value, 'hello');
        const push = pushes.find(p => p.type === 'settingResult');
        assert.ok(push, 'settingResult push still emitted');
        assert.strictEqual(push.value, 'hello');
    });

    await test('openPlanByPath opens a sessionless plan file through the HostEditor seam', async () => {
        const { provider, recorders } = buildHeadlessProvider(tmpRoot);
        const rel = path.join('.switchboard', 'plans', 'p1.md');
        fs.mkdirSync(path.dirname(path.join(tmpRoot, rel)), { recursive: true });
        fs.writeFileSync(path.join(tmpRoot, rel), '# a plan with no sessionId');
        const result = await provider.handleServiceVerb('openPlanByPath', { planPath: rel });
        assert.strictEqual(result.success, true);
        assert.deepStrictEqual(recorders.openedDocuments, [path.resolve(tmpRoot, rel)]);
    });

    await test('openPlanByPath denies path traversal in the returned body', async () => {
        const { provider } = buildHeadlessProvider(tmpRoot);
        const result = await provider.handleServiceVerb('openPlanByPath', { planPath: '../outside.md' });
        assert.strictEqual(result.success, false);
        assert.match(result.error, /traversal|not found/i);
    });

    // ── No-op arms return an explicit ack ─────────────────────────────────
    await test('updateFeatureConfig acks explicitly (no hollow undefined)', async () => {
        const { provider } = buildHeadlessProvider(tmpRoot);
        const result = await provider.handleServiceVerb('updateFeatureConfig', {});
        assert.deepStrictEqual(result, { success: true });
    });

    // ── Schema registry sanity ────────────────────────────────────────────
    await test('kanban schema registry validates strictly for moves, passes schemaless verbs', () => {
        assert.strictEqual(validateVerbPayload('kanban', 'moveSelected', { sessionIds: ['a'], column: 'CREATED' }).ok, true);
        assert.strictEqual(validateVerbPayload('kanban', 'moveSelected', { column: 'CREATED' }).ok, false);
        assert.strictEqual(validateVerbPayload('kanban', 'someFutureVerb', { anything: 1 }).ok, true);
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
