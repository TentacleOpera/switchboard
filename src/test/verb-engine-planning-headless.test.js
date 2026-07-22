'use strict';

/**
 * Verb Engine · Layer-1 — PlanningProvider headless seam tests (P1: Plans & Features).
 *
 * Drives migrated PlanningProvider arms end-to-end through the generic
 * `handleServiceVerb` dispatcher under a BOOBY-TRAPPED vscode module (any
 * property access throws) and an in-memory HostSeams bundle. A passing run
 * proves the migrated arms execute with no vscode reachable, return their
 * results (the HTTP body contract), and keep the webview push additive.
 *
 * Run with:
 *   npm run compile-tests && node src/test/verb-engine-planning-headless.test.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { installVscodeTrap, createHeadlessTestSeams, createFakeStateStore } = require('./helpers/verbEngineTestSeams');

// Install the trap BEFORE any out/services module loads.
installVscodeTrap();

const { PlanningPanelProvider } = require('../../out/services/PlanningPanelProvider');
const { BroadcastHub } = require('../../out/services/broadcastHub');
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

/** Build a PlanningPanelProvider wired for headless execution against a temp workspace. */
function buildHeadlessPlanningProvider(tmpRoot, seamOpts = {}) {
    const { seams, recorders } = createHeadlessTestSeams({ roots: [tmpRoot], ...seamOpts });
    const stateStore = createFakeStateStore();
    const pushes = [];
    const fakeWebview = {
        postMessage: (msg) => {
            pushes.push(msg);
            return Promise.resolve(true);
        },
    };

    const dummyUri = { fsPath: path.join(tmpRoot, 'ext') };
    const { ResearchImportService } = require('../../out/services/ResearchImportService');
    const researchImportService = new ResearchImportService();
    const dummyService = {};
    const dummyWriter = {};
    const dummyFactories = {
        getNotionService: () => dummyService,
        getNotionBrowseService: () => dummyService,
        getLinearDocsAdapter: () => dummyService,
        getClickUpDocsAdapter: () => dummyService,
        getCacheService: () => dummyService,
        getLinearSyncService: () => dummyService,
        getClickUpSyncService: () => dummyService,
    };
    const dummyContext = { secrets: null };

    const provider = new PlanningPanelProvider(
        dummyUri,
        researchImportService,
        dummyWriter,
        () => tmpRoot,
        dummyFactories,
        dummyContext,
        stateStore
    );

    // Test-seam injection
    provider._hostSeams = seams;
    provider._broadcaster = new BroadcastHub({ webview: fakeWebview, apiServer: null });
    const projectPushes = [];
    provider.postMessageToProjectWebview = (msg) => { projectPushes.push(msg); };
    return { provider, seams, recorders, stateStore, pushes, projectPushes };
}

async function main() {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-verb-engine-planning-'));

    console.log('\n=== Verb Engine · Layer-1 — PlanningProvider headless seam tests (P1) ===\n');

    // ── Dispatch contract & Schema validation ──────────────────────────────
    await test('Planning: unknown verb is rejected by allowlist', async () => {
        const { provider } = buildHeadlessPlanningProvider(tmpRoot);
        await assert.rejects(
            () => provider.handleServiceVerb('notARealPlanningVerb', {}),
            /Unknown Planning verb/
        );
    });

    await test('Planning: schema validation rejects malformed payload (deleteFeature)', async () => {
        const { provider } = buildHeadlessPlanningProvider(tmpRoot);
        await assert.rejects(
            () => provider.handleServiceVerb('deleteFeature', {}),
            /Invalid payload for Planning verb 'deleteFeature'.*sessionId/
        );
    });

    // ── Read arms: Plans & Features family ─────────────────────────────────
    await test('fetchKanbanPlans RETURNS in-body data and keeps push additive', async () => {
        const { provider, projectPushes } = buildHeadlessPlanningProvider(tmpRoot);
        const result = await provider.handleServiceVerb('fetchKanbanPlans', { workspaceRoot: tmpRoot, requestId: 101 });
        if (!result.success) { console.error('fetchKanbanPlans failed result:', result); }
        assert.strictEqual(result.success, true);
        assert.ok(Array.isArray(result.plans));
        assert.ok(Array.isArray(result.columns));
        assert.strictEqual(result.requestId, 101);
        const push = projectPushes.find(p => p.type === 'kanbanPlansReady');
        assert.ok(push, 'webview push emitted');
        assert.strictEqual(push.requestId, 101);
    });

    await test('fetchKanbanPlanPreview RETURNS in-body data for valid plan file', async () => {
        const planDir = path.join(tmpRoot, '.switchboard', 'plans');
        fs.mkdirSync(planDir, { recursive: true });
        const planFile = path.join(planDir, 'test-plan.md');
        fs.writeFileSync(planFile, '# Test Plan\n\n## Goal\nTest goal content');

        const { provider, pushes } = buildHeadlessPlanningProvider(tmpRoot);
        const result = await provider.handleServiceVerb('fetchKanbanPlanPreview', { filePath: planFile, requestId: 202 });
        assert.strictEqual(result.success, true);
        assert.strictEqual(result.filePath, planFile);
        assert.strictEqual(result.rawContent, '# Test Plan\n\n## Goal\nTest goal content');
        const push = pushes.find(p => p.type === 'kanbanPlanPreviewReady');
        assert.ok(push, 'webview push emitted');
    });

    await test('planShown executes command and RETURNS in-body success', async () => {
        const { provider } = buildHeadlessPlanningProvider(tmpRoot);
        const result = await provider.handleServiceVerb('planShown', { sessionId: 'test-session-123' });
        assert.strictEqual(result.success, true);
        assert.strictEqual(result.sessionId, 'test-session-123');
    });

    await test('fetchKanbanPlanLog RETURNS in-body log entries and keeps push additive', async () => {
        const { provider, projectPushes } = buildHeadlessPlanningProvider(tmpRoot);
        const result = await provider.handleServiceVerb('fetchKanbanPlanLog', { sessionId: 'sess-1', workspaceRoot: tmpRoot });
        assert.strictEqual(result.success, true);
        assert.ok(Array.isArray(result.entries));
        const push = projectPushes.find(p => p.type === 'kanbanPlanLogReady');
        assert.ok(push, 'webview push emitted');
    });

    await test('getFeatureDetails RETURNS in-body feature details and keeps push additive', async () => {
        const { provider, projectPushes } = buildHeadlessPlanningProvider(tmpRoot);
        const result = await provider.handleServiceVerb('getFeatureDetails', { sessionId: 'feat-1', workspaceRoot: tmpRoot });
        assert.strictEqual(result.success, true);
        assert.strictEqual(result.feature, null);
        assert.deepStrictEqual(result.subtasks, []);
        const push = projectPushes.find(p => p.type === 'featureDetails');
        assert.ok(push, 'webview push emitted');
    });

    await test('getProjectContextEnabled RETURNS in-body state and keeps push additive', async () => {
        const { provider, projectPushes } = buildHeadlessPlanningProvider(tmpRoot);
        const result = await provider.handleServiceVerb('getProjectContextEnabled', { workspaceRoot: tmpRoot });
        assert.strictEqual(result.success, true);
        assert.strictEqual(result.enabled, false);
        const push = projectPushes.find(p => p.type === 'projectContextEnabled');
        assert.ok(push, 'webview push emitted');
    });

    await test('getSyncConfig RETURNS in-body config and keeps push additive', async () => {
        const { provider, pushes } = buildHeadlessPlanningProvider(tmpRoot);
        const result = await provider.handleServiceVerb('getSyncConfig', { workspaceRoot: tmpRoot });
        assert.strictEqual(result.success, true);
        assert.ok(result.uploadLocations !== undefined);
        const push = pushes.find(p => p.type === 'syncConfigReady');
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
