'use strict';

/**
 * Tests for the quiet-period debounce path in ContinuousSyncService (Plan:
 * fix_live_content_sync_debounce_and_reliability). Uses the same lightweight
 * harness pattern as continuous-sync-timeout-stall.test.js:
 *   - Install a minimal `vscode` stub via Module._load.
 *   - Load the compiled JS from ./out (run `npm run compile-tests` first).
 *   - Drive private methods directly where it keeps the test deterministic.
 *
 * Run with:  node src/test/continuous-sync-debounce.test.js
 */

const assert = require('assert');
const Module = require('module');
const path = require('path');
const fs = require('fs');
const os = require('os');

// ── Install minimal vscode stub ──────────────────────────────────────────
const originalLoad = Module._load;
const vscodeStub = {
    window: {
        showInformationMessage: () => {},
        showWarningMessage: () => {},
        showErrorMessage: () => {}
    },
    workspace: {
        workspaceFolders: [],
        // The new debounce path reads `switchboard.integrations.preferredProvider`;
        // our harness plans hit the ClickUp side, so force that here.
        getConfiguration: () => ({
            get: (key) => (key === 'integrations.preferredProvider' ? 'clickup' : undefined)
        })
    },
    Uri: {
        file: (p) => ({ fsPath: p })
    },
    Disposable: class { dispose() {} }
};
Module._load = function (request, parent, isMain) {
    if (request === 'vscode') return vscodeStub;
    return originalLoad.apply(this, arguments);
};

const { ContinuousSyncService } = require('../../out/services/ContinuousSyncService');
const { DEFAULT_LIVE_SYNC_CONFIG } = require('../../out/models/LiveSyncTypes');

let passed = 0;
let failed = 0;

async function test(name, fn) {
    try {
        await fn();
        console.log(`  PASS: ${name}`);
        passed++;
    } catch (err) {
        console.error(`  FAIL: ${name}`);
        console.error(err && err.stack ? err.stack : err);
        failed++;
    }
}

function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

// Build a harness with tight timing constants so tests finish in <1s each.
function makeHarness({ syncLatencyMs = 0, syncResult = { success: true } } = {}) {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'continuous-sync-debounce-'));
    const planFile = path.join(tmpRoot, 'plan.md');
    fs.writeFileSync(planFile, '# Plan\ninitial');

    const postedMessages = [];
    const kanbanProvider = {
        postMessage: (m) => { postedMessages.push(m); },
        onPlanFileChange: () => ({ dispose: () => {} })
    };

    const plan = {
        sessionId: 's-debounce',
        topic: 'Debounce Test Plan',
        planFile,
        kanbanColumn: 'PLAN REVIEWED',
        clickupTaskId: 'task-dbn',
        linearIssueId: null
    };

    const db = {
        getPlanBySessionId: async () => plan,
        getPlanByPlanFile: async () => plan,
        getWorkspaceId: async () => 'ws',
        getDominantWorkspaceId: async () => 'ws',
        getBoard: async () => [plan]
    };

    let clickupCallCount = 0;
    const clickup = {
        loadConfig: async () => ({ setupComplete: true, realTimeSyncEnabled: true }),
        syncPlanContent: async () => {
            clickupCallCount++;
            if (syncLatencyMs > 0) { await sleep(syncLatencyMs); }
            return syncResult;
        },
        httpRequest: async () => ({ status: 200, data: {} })
    };
    const linear = {
        loadConfig: async () => null,
        syncPlanContent: async () => ({ success: true }),
        graphqlRequest: async () => ({ data: {} })
    };

    const svc = new ContinuousSyncService(
        kanbanProvider,
        () => clickup,
        () => linear,
        () => db
    );
    // Tight debounce/floor constants keep the tests fast and bounded.
    svc._config = {
        ...DEFAULT_LIVE_SYNC_CONFIG,
        enabled: true,
        quietMs: 50,
        minIntervalMs: 100,
        maxDeferMs: 500
    };
    svc._serviceEnabled = true;

    return {
        svc,
        tmpRoot,
        planFile,
        plan,
        postedMessages,
        getClickupCallCount: () => clickupCallCount
    };
}

function cleanup(h) {
    try { fs.rmSync(h.tmpRoot, { recursive: true, force: true }); } catch { /* best-effort */ }
}

// ── Tests ────────────────────────────────────────────────────────────────

async function testRapidEditCoalescing() {
    // 10 rapid edits within one quiet window must collapse to a single sync.
    const h = makeHarness();
    try {
        // Mutate the file between edits so each mtime event sees a new hash.
        for (let i = 0; i < 10; i++) {
            fs.writeFileSync(h.planFile, `# Plan\nedit ${i}`);
            await h.svc._handleFileChange(vscodeStub.Uri.file(h.planFile), h.tmpRoot);
            // No sleep between edits — they all fall inside quietMs.
        }
        // Wait for the quiet timer to fire and any subsequent async work.
        await sleep(120);
        // Drain any pending resync window.
        await sleep(50);
        assert.strictEqual(
            h.getClickupCallCount(),
            1,
            `Expected 1 sync call after 10 rapid edits, got ${h.getClickupCallCount()}`
        );
    } finally {
        cleanup(h);
    }
}

async function testMaxDeferCeiling() {
    // Sustained edits across more than maxDeferMs must force at least one sync.
    const h = makeHarness();
    try {
        const start = Date.now();
        let iter = 0;
        while (Date.now() - start < 700) {
            fs.writeFileSync(h.planFile, `# Plan\nstreaming ${iter++}`);
            await h.svc._handleFileChange(vscodeStub.Uri.file(h.planFile), h.tmpRoot);
            // Keep edits well inside quietMs so only the ceiling can trigger.
            await sleep(20);
        }
        await sleep(150);
        assert.ok(
            h.getClickupCallCount() >= 1,
            `Expected at least one forced sync during sustained editing, got ${h.getClickupCallCount()}`
        );
    } finally {
        cleanup(h);
    }
}

async function testColumnReconciliationRemovesState() {
    // Moving a plan to COMPLETED during debounce must cancel the pending sync
    // and drop the tracked state entirely.
    const h = makeHarness();
    try {
        fs.writeFileSync(h.planFile, '# Plan\nchange');
        await h.svc._handleFileChange(vscodeStub.Uri.file(h.planFile), h.tmpRoot);
        const preState = h.svc._states.get(h.plan.sessionId);
        assert.ok(preState, 'State should exist after file change');
        assert.ok(preState.quietTimer, 'Quiet timer should be armed');

        // Simulate the DB being updated to COMPLETED before the hook fires.
        h.plan.kanbanColumn = 'COMPLETED';
        await h.svc.onPlanColumnChange(h.plan.sessionId, 'PLAN REVIEWED', 'COMPLETED', h.tmpRoot);

        assert.ok(
            !h.svc._states.has(h.plan.sessionId),
            'State must be removed when plan moved to COMPLETED'
        );
        const idleMsg = h.postedMessages.find(
            m => m.type === 'liveSyncUpdate' && m.sessionId === h.plan.sessionId && m.status === 'idle'
        );
        assert.ok(idleMsg, 'Expected a liveSyncUpdate(status=idle) for reconciliation');

        // Wait out any residual timers to make sure no sync fires after removal.
        await sleep(150);
        assert.strictEqual(
            h.getClickupCallCount(),
            0,
            'No sync should fire after the plan is removed from tracking'
        );
    } finally {
        cleanup(h);
    }
}

async function testEligibilityWithoutExternalIdSkipsTracking() {
    // A plan with no clickupTaskId/linearIssueId is not eligible regardless of
    // column — _initializeStatesForActivePlans must skip it.
    const h = makeHarness();
    h.plan.clickupTaskId = null;
    h.plan.linearIssueId = null;
    try {
        await h.svc._initializeStatesForActivePlans(h.tmpRoot);
        assert.ok(
            !h.svc._states.has(h.plan.sessionId),
            'Plans without an external issue ID must not be tracked'
        );
    } finally {
        cleanup(h);
    }
}

async function testEligibilityInCompletedColumnSkipsTracking() {
    // Plans in COMPLETED are ineligible even with a valid clickupTaskId.
    const h = makeHarness();
    h.plan.kanbanColumn = 'COMPLETED';
    try {
        await h.svc._initializeStatesForActivePlans(h.tmpRoot);
        assert.ok(
            !h.svc._states.has(h.plan.sessionId),
            'Plans in COMPLETED must not be tracked'
        );
    } finally {
        cleanup(h);
    }
}

// ── Runner ───────────────────────────────────────────────────────────────

(async () => {
    console.log('ContinuousSyncService quiet-period debounce tests');
    await test('rapid edits within quietMs collapse to one sync', testRapidEditCoalescing);
    await test('maxDeferMs ceiling forces sync during sustained editing', testMaxDeferCeiling);
    await test('column reconciliation cancels pending sync and removes state', testColumnReconciliationRemovesState);
    await test('plans without external issue ID are not tracked', testEligibilityWithoutExternalIdSkipsTracking);
    await test('plans in COMPLETED column are not tracked', testEligibilityInCompletedColumnSkipsTracking);

    console.log(`\n${passed} passed, ${failed} failed`);
    Module._load = originalLoad;
    process.exit(failed === 0 ? 0 : 1);
})();
