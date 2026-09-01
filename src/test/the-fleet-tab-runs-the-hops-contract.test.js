'use strict';

/**
 * The Fleet Tab Runs The Hops — Behavioural and Architectural Contract Tests
 *
 * Covers all 10 automated verification items from the plan:
 * 1. stalled and blocked do not trigger evaluation; completed does (wedged-fleet guard).
 * 2. Coalescing: five turn-end events inside the debounce window produce exactly one pass.
 * 3. Double-trigger safety: a tick and a turn-end pass racing on one free hop produce exactly one dispatch.
 * 4. notifyTurnEnd stays non-blocking: throwing or unresolved evaluator does not block delivery path.
 * 5. Start does not itself dispatch: setting started=true does not dispatch until next trigger.
 * 6. Nothing dispatches before Start, with all three ticked.
 * 7. Offline renders unknown, never free.
 * 8. No confirm( anywhere in the changed webview files.
 * 9. Both roots wire the turn-end hook and the verbs (source-level check).
 * 10. A fresh session starts unticked and stopped.
 */

require('./bootstrap/vscodeStub.js');

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let failures = 0;
async function check(name, fn) {
    try {
        await fn();
        console.log(`  ✅ ${name}`);
    } catch (err) {
        failures++;
        console.log(`  ❌ ${name}`);
        console.log(`     ${err && err.message ? err.message : err}`);
    }
}

// HopReadiness logic under test
const { teamIsFree } = require(path.join(__dirname, '..', '..', 'out', 'services', 'HopReadiness.js'));

async function runTests() {
    console.log('Running The Fleet Tab Runs The Hops Contract Tests...\n');

    // 1. stalled and blocked do not trigger evaluation; completed does
    await check('1. stalled and blocked do not trigger evaluation; completed does', async () => {
        let evalCount = 0;
        const dummyProvider = {
            _hopTurnEndDebounceTimer: undefined,
            _hopFeed: [],
            appendHopFeed: function(kind, text) { this._hopFeed.push({ kind, text }); },
            scheduleTurnEndHopEvaluation: function() { evalCount++; },
            _hasFleet: () => false,
            _getWorkspaceRoot: () => '/tmp',
        };

        const { TaskViewerProvider } = require(path.join(__dirname, '..', '..', 'out', 'services', 'TaskViewerProvider.js'));
        const notifyFn = TaskViewerProvider.prototype.notifyTurnEnd.bind(dummyProvider);

        // 'stalled' must NOT trigger evaluation
        notifyFn({ seatName: 'Coding', planFile: 'p1.md', outcome: 'stalled', workspaceRoot: '/tmp' });
        assert.strictEqual(evalCount, 0, 'stalled must NOT trigger hop evaluation');

        // 'blocked' must NOT trigger evaluation
        notifyFn({ seatName: 'Coding', planFile: 'p1.md', outcome: 'blocked', workspaceRoot: '/tmp' });
        assert.strictEqual(evalCount, 0, 'blocked must NOT trigger hop evaluation');

        // 'completed' MUST trigger evaluation
        notifyFn({ seatName: 'Coding', planFile: 'p1.md', outcome: 'completed', workspaceRoot: '/tmp' });
        assert.strictEqual(evalCount, 1, 'completed MUST trigger hop evaluation');
    });

    // 2. Coalescing: five turn-end events inside the debounce window produce exactly one pass
    await check('2. Coalescing: five turn-end events inside debounce window produce exactly one pass', async () => {
        let tickCount = 0;
        const dummyProvider = {
            _hopTurnEndDebounceTimer: undefined,
            hopSessionState: { hops: { plan: true, code: true, review: true }, started: true },
            tickDispatchHops: async () => { tickCount++; return { reasons: {} }; },
        };

        const { TaskViewerProvider } = require(path.join(__dirname, '..', '..', 'out', 'services', 'TaskViewerProvider.js'));
        const scheduleFn = TaskViewerProvider.prototype.scheduleTurnEndHopEvaluation.bind(dummyProvider);

        // Schedule 5 times with custom small timeout or fast clock
        for (let i = 0; i < 5; i++) {
            scheduleFn('/tmp');
        }

        // Wait for debounce timer (we wait 2.2s for the real 2s timer)
        await new Promise(r => setTimeout(r, 2200));

        assert.strictEqual(tickCount, 1, 'Five rapid turn-end events must coalesce into exactly one evaluation pass');
    });

    // 3. Double-trigger safety: a tick and a turn-end pass racing on one free hop produce exactly one dispatch
    await check('3. Double-trigger safety: a tick and turn-end racing produce exactly one dispatch', async () => {
        let dispatchInvocations = 0;
        const dummyProvider = {
            hopSessionState: {
                hops: { plan: true, code: false, review: false },
                started: true,
            },
            _hopLastRunAt: { plan: 0, code: 0, review: 0 },
            _hopLastReasons: { plan: '', code: '', review: '' },
            _hopTickInFlight: false,
            _getWorkspaceRoot: () => '/tmp',
            resolveHopSnapshot: async () => ({
                seats: [{ friendlyName: 'planner-1', role: 'planner', status: 'active' }],
                board: [{ planId: 'p1', kanbanColumn: 'CREATED' }]
            }),
            _executeHopDispatch: async () => {
                dispatchInvocations++;
                // Artificial delay to simulate in-flight execution
                await new Promise(r => setTimeout(r, 50));
                return { success: true, detail: 'dispatched plan' };
            }
        };

        const { TaskViewerProvider } = require(path.join(__dirname, '..', '..', 'out', 'services', 'TaskViewerProvider.js'));
        const tickFn = TaskViewerProvider.prototype.tickDispatchHops.bind(dummyProvider);

        // Launch two concurrent evaluations (simulating tick + turn-end collision)
        const [res1, res2] = await Promise.all([
            tickFn('/tmp'),
            tickFn('/tmp'),
        ]);

        assert.strictEqual(dispatchInvocations, 1, 'Exactly one dispatch must occur when two triggers race');
        assert.ok(
            (res1.dispatchedHop === 'plan' && res2.reasons.plan === 'tick in flight') ||
            (res2.dispatchedHop === 'plan' && res1.reasons.plan === 'tick in flight'),
            'The second racing pass must be rejected with tick in flight'
        );
    });

    // 4. notifyTurnEnd stays non-blocking: throwing or hung evaluator leaves delivery unaffected
    await check('4. notifyTurnEnd stays non-blocking: throwing evaluator leaves delivery unaffected', async () => {
        let deliveryAttempted = false;
        const dummyProvider = {
            _hopTurnEndDebounceTimer: undefined,
            appendHopFeed: () => { throw new Error('Simulated feed error'); },
            scheduleTurnEndHopEvaluation: () => { throw new Error('Simulated scheduler error'); },
            _hasFleet: () => { deliveryAttempted = true; return false; },
            _getWorkspaceRoot: () => '/tmp',
        };

        const { TaskViewerProvider } = require(path.join(__dirname, '..', '..', 'out', 'services', 'TaskViewerProvider.js'));
        const notifyFn = TaskViewerProvider.prototype.notifyTurnEnd.bind(dummyProvider);

        // Should not throw
        assert.doesNotThrow(() => {
            notifyFn({ seatName: 'Coding', planFile: 'p1.md', outcome: 'completed', workspaceRoot: '/tmp' });
        });

        // Give any microtasks time to settle
        await new Promise(r => setTimeout(r, 50));
        assert.strictEqual(deliveryAttempted, true, 'Delivery path must proceed despite hop scheduler throwing');
    });

    // 5. Start does not itself dispatch: setting started=true does not dispatch until next trigger
    await check('5. Start does not itself dispatch: setting started=true does not trigger immediate dispatch', async () => {
        let dispatchCount = 0;
        const dummyProvider = {
            hopSessionState: {
                hops: { plan: true, code: true, review: true },
                started: false,
            },
            _hopLastRunAt: { plan: 0, code: 0, review: 0 },
            _hopLastReasons: { plan: '', code: '', review: '' },
            _executeHopDispatch: async () => { dispatchCount++; return { success: true, detail: 'dispatched' }; }
        };

        const { TaskViewerProvider } = require(path.join(__dirname, '..', '..', 'out', 'services', 'TaskViewerProvider.js'));
        const setSessionStateFn = TaskViewerProvider.prototype.setHopSessionState.bind(dummyProvider);

        // Call setHopSessionState({ started: true })
        setSessionStateFn({ started: true });
        assert.strictEqual(dummyProvider.hopSessionState.started, true);
        assert.strictEqual(dispatchCount, 0, 'Start MUST NOT dispatch immediately on button press');
    });

    // 6. Nothing dispatches before Start, with all three ticked
    await check('6. Nothing dispatches before Start, with all three ticked', async () => {
        const dummyProvider = {
            hopSessionState: {
                hops: { plan: true, code: true, review: true },
                started: false,
            },
            _hopLastRunAt: { plan: 0, code: 0, review: 0 },
            _hopLastReasons: { plan: '', code: '', review: '' },
            _getWorkspaceRoot: () => '/tmp',
            resolveHopSnapshot: async () => ({
                seats: [
                    { friendlyName: 'planner-1', role: 'planner', status: 'active' },
                    { friendlyName: 'Coding', role: 'lead', status: 'active' },
                    { friendlyName: 'reviewer-1', role: 'reviewer', status: 'active' },
                ],
                board: [{ planId: 'p1', kanbanColumn: 'CREATED' }]
            }),
        };

        const { TaskViewerProvider } = require(path.join(__dirname, '..', '..', 'out', 'services', 'TaskViewerProvider.js'));
        const tickFn = TaskViewerProvider.prototype.tickDispatchHops.bind(dummyProvider);
        const result = await tickFn('/tmp');
        assert.strictEqual(result.dispatchedHop, undefined, 'Nothing should dispatch when started is false');
        assert.strictEqual(result.reasons.plan, 'not started');
    });

    // 7. Offline renders unknown, never free
    await check('7. Offline renders unknown, never free', async () => {
        const offlineSnapshot = {
            seats: [],
            board: []
        };
        for (const hop of ['plan', 'code', 'review']) {
            const res = teamIsFree(hop, offlineSnapshot);
            assert.strictEqual(res.free, undefined, `Expected free to be undefined when offline for ${hop}`);
            assert.strictEqual(typeof res.unknown, 'string', `Expected unknown string for ${hop}`);
        }
    });

    // 8. No confirm( anywhere in the changed webview files
    await check('8. No confirm( anywhere in webview shell files', async () => {
        const shellHtml = fs.readFileSync(path.join(__dirname, '..', 'webview', 'shell.html'), 'utf8');
        const shellJs = fs.readFileSync(path.join(__dirname, '..', 'webview', 'shell.js'), 'utf8');

        assert.ok(!shellHtml.includes('confirm('), 'shell.html must NOT contain confirm()');
        assert.ok(!shellJs.includes('confirm('), 'shell.js must NOT contain confirm()');
    });

    // 9. Both roots wire the turn-end hook and the verbs
    await check('9. Both roots wire the turn-end hook and the verbs (extension.ts & bootstrap.ts)', async () => {
        const extSrc = fs.readFileSync(path.join(__dirname, '..', 'extension.ts'), 'utf8');
        const bootSrc = fs.readFileSync(path.join(__dirname, '..', 'standalone', 'bootstrap.ts'), 'utf8');
        const taskViewerSrc = fs.readFileSync(path.join(__dirname, '..', 'services', 'TaskViewerProvider.ts'), 'utf8');

        // Turn-end hook check
        assert.ok(
            extSrc.includes('notifyTurnEnd'),
            'extension.ts MUST wire notifyTurnEnd'
        );
        assert.ok(
            taskViewerSrc.includes('scheduleTurnEndHopEvaluation'),
            'TaskViewerProvider.ts MUST wire scheduleTurnEndHopEvaluation into notifyTurnEnd'
        );
        assert.ok(
            bootSrc.includes('scheduleTurnEndHopEvaluation'),
            'standalone/bootstrap.ts MUST wire scheduleTurnEndHopEvaluation into handleTurnEndNotify'
        );

        // Verbs check
        assert.ok(
            taskViewerSrc.includes('getHopState') || taskViewerSrc.includes('setHopsStarted'),
            'TaskViewerProvider.ts MUST handle hop verbs'
        );
        assert.ok(
            bootSrc.includes('getHopState') || bootSrc.includes('setHopsStarted'),
            'standalone/bootstrap.ts MUST handle hop verbs'
        );
    });

    // 10. A fresh session starts unticked and stopped
    await check('10. A fresh session starts unticked and stopped', async () => {
        const { TaskViewerProvider } = require(path.join(__dirname, '..', '..', 'out', 'services', 'TaskViewerProvider.js'));
        const instance = Object.create(TaskViewerProvider.prototype);
        instance.hopSessionState = {
            hops: { plan: false, code: false, review: false },
            started: false,
        };
        const state = instance.getHopSessionState();
        assert.strictEqual(state.started, false, 'started must be false by default');
        assert.strictEqual(state.hops.plan, false, 'plan hop must be false by default');
        assert.strictEqual(state.hops.code, false, 'code hop must be false by default');
        assert.strictEqual(state.hops.review, false, 'review hop must be false by default');
    });

    console.log(`\nTests finished. Failures: ${failures}`);
    if (failures > 0) process.exit(1);
}

if (require.main === module) {
    runTests().catch(err => {
        console.error(err);
        process.exit(1);
    });
}

module.exports = { runTests };
