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
    // Minimal ExtensionContext fake: globalState backed by an in-memory Map so
    // constitution/PRD/insight arms that read switchboard.* config keys work headless.
    const globalStateStore = new Map();
    const dummyContext = {
        secrets: null,
        globalState: {
            get: (key, dflt) => globalStateStore.has(key) ? globalStateStore.get(key) : dflt,
            update: async (key, value) => { globalStateStore.set(key, value); },
        },
    };

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

    // ── Read arms: Docs / PRD / Constitution / Insights family (P2) ────────
    await test('listLocalFolders RETURNS in-body paths and keeps push additive', async () => {
        const { provider, pushes } = buildHeadlessPlanningProvider(tmpRoot);
        const result = await provider.handleServiceVerb('listLocalFolders', { workspaceRoot: tmpRoot });
        assert.strictEqual(result.success, true);
        assert.ok(Array.isArray(result.paths));
        assert.strictEqual(result.type, 'localFoldersListed');
        const push = pushes.find(p => p.type === 'localFoldersListed');
        assert.ok(push, 'webview push emitted');
    });

    await test('listPlanningHtmlFolders RETURNS in-body paths and keeps push additive', async () => {
        const { provider, pushes } = buildHeadlessPlanningProvider(tmpRoot);
        const result = await provider.handleServiceVerb('listPlanningHtmlFolders', { workspaceRoot: tmpRoot });
        assert.strictEqual(result.success, true);
        assert.ok(Array.isArray(result.paths));
        const push = pushes.find(p => p.type === 'planningHtmlFoldersListed');
        assert.ok(push, 'webview push emitted');
    });

    await test('loadConstitutionFiles RETURNS in-body workspaces and keeps push additive', async () => {
        const { provider, projectPushes } = buildHeadlessPlanningProvider(tmpRoot);
        const result = await provider.handleServiceVerb('loadConstitutionFiles', {});
        assert.strictEqual(result.success, true);
        assert.ok(Array.isArray(result.workspaces));
        assert.strictEqual(result.type, 'constitutionFilesLoaded');
        const push = projectPushes.find(p => p.type === 'constitutionFilesLoaded');
        assert.ok(push, 'webview push emitted');
    });

    await test('getConstitutionStatus RETURNS in-body status string and keeps push additive', async () => {
        const { provider, projectPushes } = buildHeadlessPlanningProvider(tmpRoot);
        const result = await provider.handleServiceVerb('getConstitutionStatus', { workspaceRoot: tmpRoot });
        assert.strictEqual(result.success, true);
        assert.ok(typeof result.status === 'string');
        assert.strictEqual(result.type, 'constitutionStatus');
        const push = projectPushes.find(p => p.type === 'constitutionStatus');
        assert.ok(push, 'webview push emitted');
    });

    await test('getProjectPrd RETURNS in-body content/rawContent/exists for a fresh project and keeps push additive', async () => {
        const { provider, projectPushes } = buildHeadlessPlanningProvider(tmpRoot);
        const result = await provider.handleServiceVerb('getProjectPrd', { workspaceRoot: tmpRoot, projectName: 'fresh-project' });
        assert.strictEqual(result.success, true);
        assert.strictEqual(result.exists, false);
        assert.strictEqual(result.rawContent, '');
        assert.strictEqual(result.projectName, 'fresh-project');
        const push = projectPushes.find(p => p.type === 'projectPrdContent');
        assert.ok(push, 'webview push emitted');
    });

    await test('getConstitutionPaths RETURNS success:false for invalid workspace root', async () => {
        const { provider } = buildHeadlessPlanningProvider(tmpRoot);
        const result = await provider.handleServiceVerb('getConstitutionPaths', { workspaceRoot: '/not/a/allowed/root' });
        assert.strictEqual(result.success, false);
        assert.ok(/Invalid workspace root/.test(result.error));
    });

    await test('loadInsights RETURNS in-body insights array and keeps push additive', async () => {
        const { provider, projectPushes } = buildHeadlessPlanningProvider(tmpRoot);
        // Create the insights dir so InsightManager.listInsights doesn't throw
        fs.mkdirSync(path.join(tmpRoot, '.switchboard', 'insights'), { recursive: true });
        const result = await provider.handleServiceVerb('loadInsights', { workspaceRoot: tmpRoot });
        assert.strictEqual(result.success, true);
        assert.ok(Array.isArray(result.insights));
        assert.strictEqual(result.type, 'insightsLoaded');
        const push = projectPushes.find(p => p.type === 'insightsLoaded');
        assert.ok(push, 'webview push emitted');
    });

    await test('readInsight RETURNS success:false when missing filename', async () => {
        const { provider } = buildHeadlessPlanningProvider(tmpRoot);
        const result = await provider.handleServiceVerb('readInsight', { workspaceRoot: tmpRoot });
        assert.strictEqual(result.success, false);
        assert.ok(/Missing workspaceRoot or filename/.test(result.error));
    });

    await test('fetchContainers RETURNS in-body containers (no adapter) and keeps push additive', async () => {
        const { provider, pushes } = buildHeadlessPlanningProvider(tmpRoot);
        const result = await provider.handleServiceVerb('fetchContainers', { sourceId: 'no-such-source' });
        assert.strictEqual(result.success, true);
        assert.ok(Array.isArray(result.containers));
        assert.strictEqual(result.containers.length, 0);
        const push = pushes.find(p => p.type === 'containersReady');
        assert.ok(push, 'webview push emitted');
    });

    await test('renderMarkdownLive RETURNS in-body html via markdown.api.render seam (push routes to target panel, no panel headless)', async () => {
        const { provider } = buildHeadlessPlanningProvider(tmpRoot, {
            commandResults: {
                'markdown.api.render': (content) => `<p>${content}</p>`,
            },
        });
        const result = await provider.handleServiceVerb('renderMarkdownLive', { content: '# Hi', requestId: 42 });
        assert.strictEqual(result.success, true);
        assert.strictEqual(result.html, '<p># Hi</p>');
        assert.strictEqual(result.htmlContent, '<p># Hi</p>');
        assert.strictEqual(result.requestId, 42);
        assert.strictEqual(result.type, 'markdownLiveRendered');
    });



    await test('fetchRoots RETURNS in-body aggregate payload and emits pushes', async () => {
        const { provider, pushes } = buildHeadlessPlanningProvider(tmpRoot);
        const result = await provider.handleServiceVerb('fetchRoots', {});
        assert.strictEqual(result.success, true);
        assert.ok(Array.isArray(result.workspaceItems));
        assert.ok(result.integrationProviderStates !== undefined);
        // Multiple push types are emitted during fetchRoots
        assert.ok(pushes.find(p => p.type === 'workspaceItemsUpdated'), 'workspaceItemsUpdated push emitted');
    });

    // ── Schema validation: P2 doc/constitution family writes ──────────────
    await test('Planning: schema validation rejects malformed payload (deleteLocalDoc missing sourceFolder)', async () => {
        const { provider } = buildHeadlessPlanningProvider(tmpRoot);
        await assert.rejects(
            () => provider.handleServiceVerb('deleteLocalDoc', { docId: 'd1' }),
            /Invalid payload for Planning verb 'deleteLocalDoc'.*sourceFolder/
        );
    });

    await test('Planning: schema validation rejects malformed payload (saveProjectPrd missing projectName)', async () => {
        const { provider } = buildHeadlessPlanningProvider(tmpRoot);
        await assert.rejects(
            () => provider.handleServiceVerb('saveProjectPrd', { content: 'x' }),
            /Invalid payload for Planning verb 'saveProjectPrd'.*projectName/
        );
    });

    await test('Planning: schema validation rejects malformed payload (deleteInsight missing filename)', async () => {
        const { provider } = buildHeadlessPlanningProvider(tmpRoot);
        await assert.rejects(
            () => provider.handleServiceVerb('deleteInsight', { workspaceRoot: tmpRoot }),
            /Invalid payload for Planning verb 'deleteInsight'.*filename/
        );
    });

    // ── 2b: listTicketsFolders + browseTicketsFolder moved to TicketsPanelProvider.
    //    Their assertions now live in verb-engine-tickets-headless.test.js. ──

    // WHERE THE NO-WORKSPACE FAILURE ACTUALLY COMES FROM.
    //
    // These three used to pass a bogus `workspaceRoot` against a seeded root and
    // assert each arm's own guard shape (`status:'error'`, `scope:'hierarchy'`,
    // `type:'importAllTicketsComplete'`). Both halves of that were wrong:
    //
    //  1. A bogus explicit root does not produce "no workspace".
    //     `_resolveWorkspaceRoot` ignores an explicit root outside the allowed set
    //     and then deliberately falls back to the first allowed root, so the arm
    //     ran with the seeded root and died on the empty adapter stub.
    //
    //  2. Those per-arm guard shapes are UNREACHABLE through the verb path.
    //     `_handleMessage` opens with a global `allRoots.length === 0` guard
    //     (PlanningPanelProvider.ts) that returns a flat
    //     `{ success:false, error:'No workspace open' }` before the switch. Given
    //     non-empty roots the global guard passes, and given non-empty roots
    //     `_resolveWorkspaceRoot` always has a `firstAllowed` to return — so
    //     `if (!workspaceRoot)` inside an arm can never be true from here. The
    //     arm-level guards are dead defensive code behind the global one; keep
    //     them, but do not assert a shape the verb rail cannot emit.
    //
    // What IS the contract worth pinning, and what this suite is for: the verb
    // fails IN-BODY rather than throwing across the HTTP boundary.
    // 2b: linearLoadProject + clickupLoadSpaces moved to TicketsPanelProvider;
    //     their no-workspace assertions now live in verb-engine-tickets-headless.test.js.
    // 2f: importAllTickets moved to TicketsPanelProvider; its no-workspace
    //     assertion now lives in verb-engine-tickets-headless.test.js. ──

    // 2b: the clickupLoadSpaces fallback test moved to verb-engine-tickets-headless.test.js
    // (the verb now lives on TicketsPanelProvider).

    // ── 2c: getTicketSyncStatuses + readLocalTicketFile moved to TicketsPanelProvider.
    //    Their assertions now live in verb-engine-tickets-headless.test.js. ──





    // ── Schema validation: P3 tickets family writes ───────────────────────




    // 2b: removeTicketsFolder schema validation moved to verb-engine-tickets-headless.test.js.

    // 2c: importTicketSubtasks, fetchMoveTargets, moveTicket, changeTicketStatus and
    //     deleteTicketConfirmed moved to TicketsPanelProvider; their assertions were
    //     migrated verbatim into verb-engine-tickets-headless.test.js.

    // 2e: downloadAttachment, viewAttachments, loadTicketComments and postTicketComment
    //     moved to TicketsPanelProvider; their assertions were migrated verbatim into
    //     verb-engine-tickets-headless.test.js.

    // ── Cleanup ───────────────────────────────────────────────────────────
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}

    console.log(`\n${passed} passed, ${failed} failed\n`);
    process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
