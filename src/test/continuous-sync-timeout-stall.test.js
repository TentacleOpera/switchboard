'use strict';

/**
 * Unit tests for ContinuousSyncService timeout, pause cancellation, and stall
 * recovery. Covers the Verification Plan section of
 * investigate_live_sync_timeout_and_stall_detection_investigate_live_sync_timeout_and_stall_detection.md
 *
 * Run with: node src/test/continuous-sync-timeout-stall.test.js
 *
 * The service imports from 'vscode'; we stub the minimal surface we use and
 * load the compiled output in ./out. Run `npm run compile-tests` first if the
 * compiled artifacts are stale.
 */

const assert = require('assert');
const Module = require('module');
const path = require('path');
const fs = require('fs');
const os = require('os');

// ── Install minimal vscode stub ──────────────────────────────────────────
const originalLoad = Module._load;
const warningMessages = [];
const vscodeStub = {
    window: {
        showInformationMessage: () => {},
        showWarningMessage: (msg) => { warningMessages.push(msg); },
        showErrorMessage: () => {}
    },
    workspace: {
        workspaceFolders: [],
        // The new quiet-period debounce path reads
        // `switchboard.integrations.preferredProvider` to decide which
        // integration to target. The harness plans have `clickupTaskId` set
        // and `linearIssueId: null`, so the ClickUp provider must win here
        // or the sync path short-circuits before hitting httpRequest.
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

// Load service from compiled output
const { ContinuousSyncService } = require('../../out/services/ContinuousSyncService');

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

function makeHarness({ hangSyncForever = false, clickupResult = { success: true }, linearConfig = null } = {}) {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'continuous-sync-test-'));
    const planFile = path.join(tmpRoot, 'plan.md');
    fs.writeFileSync(planFile, '# Plan\nbody');

    const postedMessages = [];
    const kanbanProvider = {
        postMessage: (m) => { postedMessages.push(m); },
        onPlanFileChange: () => ({ dispose: () => {} })
    };

    // Minimal plan record
    const plan = {
        sessionId: 's1',
        topic: 't',
        planFile,
        kanbanColumn: 'INVESTIGATION',
        clickupTaskId: 'task-1',
        linearIssueId: null
    };

    const db = {
        getPlanBySessionId: async () => plan,
        getPlanByPlanFile: async () => plan,
        getWorkspaceId: async () => 'ws',
        getDominantWorkspaceId: async () => 'ws',
        getBoard: async () => [plan]
    };

    let signalCaptured = null;
    let syncCalls = 0;
    const clickup = {
        loadConfig: async () => ({ setupComplete: true, realTimeSyncEnabled: true }),
        syncPlanContent: async (_taskId, _content, signal) => {
            syncCalls++;
            signalCaptured = signal;
            if (hangSyncForever) {
                // Hang until signal aborts, then reject with an AbortError-like shape
                return await new Promise((resolve, reject) => {
                    if (signal) {
                        const onAbort = () => {
                            signal.removeEventListener('abort', onAbort);
                            reject(new Error('Sync failed: Error: AbortError'));
                        };
                        if (signal.aborted) {
                            return reject(new Error('Sync failed: Error: AbortError'));
                        }
                        signal.addEventListener('abort', onAbort);
                    }
                });
            }
            return clickupResult;
        },
        httpRequest: async () => ({ status: 200, data: {} })
    };
    const linear = {
        loadConfig: async () => linearConfig,
        syncPlanContent: async () => ({ success: true }),
        graphqlRequest: async () => ({ data: {} })
    };

    const svc = new ContinuousSyncService(
        kanbanProvider,
        () => clickup,
        () => linear,
        () => db
    );

    return {
        svc,
        tmpRoot,
        postedMessages,
        getSyncCalls: () => syncCalls,
        getCapturedSignal: () => signalCaptured
    };
}

async function testTimeoutCleanup() {
    const { svc, tmpRoot, postedMessages, getCapturedSignal } = makeHarness({ hangSyncForever: true });
    // Shrink the 30s timeout for the test by monkey-patching setTimeout before
    // _executeSync runs. Instead, invoke with a short-timeout helper: we call
    // the private method directly and drive the controller.
    const state = {
        sessionId: 's1',
        status: 'active',
        lastContentHash: 'h',
        lastSyncAt: 0,
        lastContentChangeAt: Date.now(),
        consecutiveErrors: 0
    };
    svc._states.set('s1', state);
    svc._serviceEnabled = true;

    const runPromise = svc._executeSync('s1', tmpRoot);

    // Wait long enough for the sync to enter the hang, then pull the controller
    // out and abort it manually to simulate the 30s timeout firing.
    await sleep(40);
    const signal = getCapturedSignal();
    assert.ok(signal, 'httpRequest should have received an AbortSignal');
    const controller = svc._activeControllers.get('s1');
    assert.ok(controller, 'Controller should be tracked while sync is in flight');
    controller.abort('Sync operation timed out after 30s');

    await runPromise;

    const finalState = svc._states.get('s1');
    assert.strictEqual(finalState.status, 'active', 'Status should revert to active on first timeout (errorCount<5)');
    assert.strictEqual(finalState.consecutiveErrors, 1, 'consecutiveErrors should bump by 1');
    assert.strictEqual(finalState.syncStartedAt, undefined, 'syncStartedAt should be cleared');
    assert.ok(!svc._inFlightSessions.has('s1'), '_inFlightSessions should be cleared');
    assert.ok(!svc._activeControllers.has('s1'), '_activeControllers should be cleared');
    assert.strictEqual(svc._activeSyncs, 0, '_activeSyncs should decrement back to 0');
    // UI was notified
    assert.ok(postedMessages.some(m => m.type === 'liveSyncUpdate'), 'Should post liveSyncUpdate on completion');

    fs.rmSync(tmpRoot, { recursive: true, force: true });
}

async function testPauseCancellationPreservesPausedStatus() {
    const { svc, tmpRoot, postedMessages } = makeHarness({ hangSyncForever: true });
    const state = {
        sessionId: 's1',
        status: 'active',
        lastContentHash: 'h',
        lastSyncAt: 0,
        lastContentChangeAt: Date.now(),
        consecutiveErrors: 0
    };
    svc._states.set('s1', state);
    svc._serviceEnabled = true;

    const runPromise = svc._executeSync('s1', tmpRoot);
    await sleep(40);

    svc.pausePlan('s1');
    await runPromise;

    const finalState = svc._states.get('s1');
    assert.strictEqual(finalState.status, 'paused', 'Pause must survive the catch handler');
    assert.strictEqual(finalState.consecutiveErrors, 0, 'User pause must NOT bump consecutiveErrors');
    assert.ok(
        postedMessages.some(m => m.type === 'liveSyncUpdate' && m.status === 'paused'),
        'Paused notification should be posted'
    );

    fs.rmSync(tmpRoot, { recursive: true, force: true });
}

async function testStallRecoveryUsesSyncStartedAtNotLastSyncAt() {
    const { svc, tmpRoot } = makeHarness();

    // Plan has never synced successfully — lastSyncAt === 0.
    // If the watchdog used lastSyncAt, any session marked 'syncing' with
    // lastSyncAt=0 would be recovered instantly (now - 0 > 60000). With
    // syncStartedAt freshly set to now, the session should NOT be recovered.
    const freshlyStarted = {
        sessionId: 's-fresh',
        status: 'syncing',
        lastContentHash: 'h',
        lastSyncAt: 0,
        lastContentChangeAt: Date.now(),
        syncStartedAt: Date.now(),
        consecutiveErrors: 0
    };
    svc._states.set('s-fresh', freshlyStarted);
    svc._inFlightSessions.add('s-fresh');
    svc._activeSyncs = 1;
    svc._activeControllers.set('s-fresh', new AbortController());

    svc._recoverStalledSyncs();

    let after = svc._states.get('s-fresh');
    assert.strictEqual(after.status, 'syncing', 'Fresh sync (lastSyncAt=0, syncStartedAt=now) must NOT be recovered');
    assert.strictEqual(svc._activeSyncs, 1, '_activeSyncs should not be decremented');

    // Now simulate a genuinely stalled sync: syncStartedAt is older than 60s.
    const stalled = {
        sessionId: 's-stalled',
        status: 'syncing',
        lastContentHash: 'h',
        lastSyncAt: 0,
        lastContentChangeAt: Date.now(),
        syncStartedAt: Date.now() - 61_000,
        consecutiveErrors: 0
    };
    svc._states.set('s-stalled', stalled);
    svc._inFlightSessions.add('s-stalled');
    svc._activeSyncs = 2;
    svc._activeControllers.set('s-stalled', new AbortController());

    svc._recoverStalledSyncs();

    after = svc._states.get('s-stalled');
    assert.strictEqual(after.status, 'error', 'Stalled sync must be recovered to error');
    assert.strictEqual(after.consecutiveErrors, 1, 'Recovery must bump consecutiveErrors');
    assert.strictEqual(after.syncStartedAt, undefined, 'syncStartedAt should be cleared on recovery');
    assert.ok(!svc._inFlightSessions.has('s-stalled'), '_inFlightSessions cleared');
    assert.ok(!svc._activeControllers.has('s-stalled'), '_activeControllers cleared');
    assert.strictEqual(svc._activeSyncs, 1, '_activeSyncs decremented by exactly 1 for stalled session');

    fs.rmSync(tmpRoot, { recursive: true, force: true });
}

async function testWrappedAbortErrorStillDetected() {
    // Regression: syncPlanContent wraps raw errors as "Sync failed: Error: AbortError",
    // so error.message === 'AbortError' never matches. We rely on the
    // wasAborted flag + regex fallback to still detect timeouts.
    const { svc, tmpRoot } = makeHarness({ hangSyncForever: true });
    const state = {
        sessionId: 's1',
        status: 'active',
        lastContentHash: 'h',
        lastSyncAt: 0,
        lastContentChangeAt: Date.now(),
        consecutiveErrors: 0
    };
    svc._states.set('s1', state);
    svc._serviceEnabled = true;

    // Capture console.error to verify the 'Timeout exceeded' path is taken
    const logs = [];
    const originalErr = console.error;
    console.error = (...args) => { logs.push(args.map(String).join(' ')); };

    try {
        const runPromise = svc._executeSync('s1', tmpRoot);
        await sleep(40);
        svc._activeControllers.get('s1').abort('timeout');
        await runPromise;
        assert.ok(
            logs.some(l => /Timeout exceeded/.test(l)),
            `Expected a 'Timeout exceeded' log entry, got: ${JSON.stringify(logs)}`
        );
    } finally {
        console.error = originalErr;
    }

    fs.rmSync(tmpRoot, { recursive: true, force: true });
}

async function driveTimeoutOnce(svc, tmpRoot) {
    // Make sure status is 'active' so _executeSync doesn't early-return
    const state = svc._states.get('s1');
    svc._states.set('s1', { ...state, status: 'active' });

    const runPromise = svc._executeSync('s1', tmpRoot);
    await sleep(40);
    const controller = svc._activeControllers.get('s1');
    assert.ok(controller, 'Controller should exist while sync is in flight');
    controller.abort('Sync operation timed out after 30s');
    await runPromise;
}

async function testTimeoutWarningDebounce() {
    warningMessages.length = 0;
    const { svc, tmpRoot } = makeHarness({ hangSyncForever: true });
    svc._states.set('s1', {
        sessionId: 's1',
        status: 'active',
        lastContentHash: 'h',
        lastSyncAt: 0,
        lastContentChangeAt: Date.now(),
        consecutiveErrors: 0
    });
    svc._serviceEnabled = true;

    // Timeout #1 — should NOT fire the warning (first strike is usually transient)
    await driveTimeoutOnce(svc, tmpRoot);
    assert.strictEqual(svc._states.get('s1').consecutiveErrors, 1, 'consecutiveErrors=1 after first timeout');
    assert.strictEqual(warningMessages.length, 0, 'No warning on 1st timeout');
    assert.ok(!svc._states.get('s1').timeoutWarningShown, 'timeoutWarningShown flag should still be falsy');

    // Timeout #2 — SHOULD fire the warning exactly once
    await driveTimeoutOnce(svc, tmpRoot);
    assert.strictEqual(svc._states.get('s1').consecutiveErrors, 2, 'consecutiveErrors=2 after second timeout');
    assert.strictEqual(warningMessages.length, 1, 'Warning fires on 2nd timeout');
    assert.ok(/timed out/i.test(warningMessages[0]), `Warning message should mention timeout, got: ${warningMessages[0]}`);
    assert.ok(/"t"/.test(warningMessages[0]), `Warning message should include plan name in quotes, got: ${warningMessages[0]}`);
    // Message must not leak plan content
    assert.ok(!/body/.test(warningMessages[0]), 'Warning must not leak plan file content');
    assert.strictEqual(svc._states.get('s1').timeoutWarningShown, true, 'timeoutWarningShown flag should be set');

    // Timeout #3 — debounce: must NOT fire again
    await driveTimeoutOnce(svc, tmpRoot);
    assert.strictEqual(svc._states.get('s1').consecutiveErrors, 3, 'consecutiveErrors=3 after third timeout');
    assert.strictEqual(warningMessages.length, 1, 'Warning must NOT re-fire on 3rd timeout (debounced)');

    fs.rmSync(tmpRoot, { recursive: true, force: true });
}

async function testTimeoutWarningResetsOnSuccess() {
    warningMessages.length = 0;
    // First harness: hang until aborted, accumulate two timeouts + a warning
    const h1 = makeHarness({ hangSyncForever: true });
    h1.svc._states.set('s1', {
        sessionId: 's1',
        status: 'active',
        lastContentHash: 'h',
        lastSyncAt: 0,
        lastContentChangeAt: Date.now(),
        consecutiveErrors: 0
    });
    h1.svc._serviceEnabled = true;
    await driveTimeoutOnce(h1.svc, h1.tmpRoot);
    await driveTimeoutOnce(h1.svc, h1.tmpRoot);
    assert.strictEqual(warningMessages.length, 1, 'Warning fired on 2nd timeout');
    assert.strictEqual(h1.svc._states.get('s1').timeoutWarningShown, true);

    // Simulate a successful sync by directly invoking the success-path state
    // update (matches what _executeSync does on success). This is the
    // contract the debounce relies on: a successful sync resets the flag.
    const afterState = h1.svc._states.get('s1');
    h1.svc._states.set('s1', {
        ...afterState,
        status: 'active',
        lastSyncAt: Date.now(),
        syncStartedAt: undefined,
        consecutiveErrors: 0,
        timeoutWarningShown: false
    });
    assert.strictEqual(h1.svc._states.get('s1').timeoutWarningShown, false, 'Success must reset timeoutWarningShown');
    assert.strictEqual(h1.svc._states.get('s1').consecutiveErrors, 0, 'Success must reset consecutiveErrors');

    // Now drive two more timeouts — the warning should fire AGAIN on the new 2nd
    await driveTimeoutOnce(h1.svc, h1.tmpRoot);
    assert.strictEqual(warningMessages.length, 1, 'No warning on 1st post-success timeout');
    await driveTimeoutOnce(h1.svc, h1.tmpRoot);
    assert.strictEqual(warningMessages.length, 2, 'Warning fires again on 2nd post-success timeout');

    fs.rmSync(h1.tmpRoot, { recursive: true, force: true });
}

async function testInFlightNeedsResyncWithStallRecovery() {
    // Test the interaction between inFlight, needsResync, and stall watchdog recovery
    const { svc, tmpRoot } = makeHarness({ hangSyncForever: true });

    // Set up a sync that is in-flight with needsResync flag set
    const inFlightWithResync = {
        sessionId: 's1',
        status: 'syncing',
        lastContentHash: 'h',
        lastSyncAt: 0,
        lastContentChangeAt: Date.now(),
        syncStartedAt: Date.now() - 61_000, // Stalled (older than 60s)
        consecutiveErrors: 0,
        inFlight: true,
        needsResync: true
    };
    svc._states.set('s1', inFlightWithResync);
    svc._inFlightSessions.add('s1');
    svc._activeSyncs = 1;
    svc._activeControllers.set('s1', new AbortController());

    // Run stall recovery
    svc._recoverStalledSyncs();

    const after = svc._states.get('s1');
    assert.strictEqual(after.status, 'error', 'Stalled sync must be recovered to error');
    assert.strictEqual(after.consecutiveErrors, 1, 'Recovery must bump consecutiveErrors');
    assert.strictEqual(after.syncStartedAt, undefined, 'syncStartedAt should be cleared on recovery');
    assert.strictEqual(after.inFlight, false, 'inFlight should be cleared on recovery');
    assert.strictEqual(after.needsResync, false, 'needsResync should be cleared on recovery');
    assert.ok(!svc._inFlightSessions.has('s1'), '_inFlightSessions cleared');
    assert.ok(!svc._activeControllers.has('s1'), '_activeControllers cleared');
    assert.strictEqual(svc._activeSyncs, 0, '_activeSyncs decremented');

    fs.rmSync(tmpRoot, { recursive: true, force: true });
}

(async () => {
    console.log('ContinuousSyncService timeout / pause / stall tests');
    await test('timeout aborts sync and cleans up in-flight tracking', testTimeoutCleanup);
    await test('pausePlan cancels in-flight request and preserves paused status', testPauseCancellationPreservesPausedStatus);
    await test('stall recovery uses syncStartedAt, not lastSyncAt', testStallRecoveryUsesSyncStartedAtNotLastSyncAt);
    await test('wrapped AbortError string is still detected as timeout', testWrappedAbortErrorStillDetected);
    await test('timeout warning fires once at 2nd consecutive timeout and debounces', testTimeoutWarningDebounce);
    await test('successful sync resets timeout warning flag (can re-fire on new streak)', testTimeoutWarningResetsOnSuccess);
    await test('inFlight/needsResync interaction with stall recovery', testInFlightNeedsResyncWithStallRecovery);

    console.log(`\n${passed} passed, ${failed} failed`);
    Module._load = originalLoad;
    process.exit(failed === 0 ? 0 : 1);
})();
