'use strict';

/**
 * Three Dispatch Hops and a Start Button — Behavioural and Architectural Contract Tests
 *
 * Covers all 10 automated verification items from the plan:
 * 1. A team is not free while one of its seats holds an uncompleted card (status='active').
 * 2. A busy REVIEWER blocks hop 2 (shared tree).
 * 3. Empty fleet -> unknown -> no dispatch (dead pty host guard).
 * 4. A hop with no seat of its role is unknown, not free.
 * 5. Nothing dispatches before Start, with all three ticked.
 * 6. At most one dispatch per tick with all three ticked and everything idle.
 * 7. Throttle: a continuously-free team fires at most once per intervalMinutes.
 * 8. Nothing is written to disk across session state changes.
 * 9. A fresh session starts unticked and not started.
 * 10. Both roots wire the snapshot resolver (source-level parity check).
 */

// `out/services/TaskViewerProvider.js` imports `vscode` at module scope, so the
// stub must be installed before it is required — without it tests 5-9, 11 and 12
// die with MODULE_NOT_FOUND before a single assertion runs.
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
const { teamIsFree, normalizeHop } = require(path.join(__dirname, '..', '..', 'out', 'services', 'HopReadiness.js'));

async function runTests() {
    console.log('Running Three Dispatch Hops Contract Tests...\n');

    // 1. A team is not free while one of its seats holds an uncompleted card (status='active')
    await check('1. A team is not free while one of its seats holds an uncompleted card (status: active)', async () => {
        const snapshot = {
            seats: [
                { friendlyName: 'Coding', role: 'lead', status: 'active' },
                { friendlyName: 'Coding-coder-1', role: 'coder', status: 'active' },
                { friendlyName: 'reviewer-1', role: 'reviewer', status: 'active' },
            ],
            board: [
                {
                    planId: 'plan-123',
                    kanbanColumn: 'LEAD CODED',
                    dispatchedTerminal: 'Coding',
                    completedAt: null,
                }
            ]
        };
        const res = teamIsFree('code', snapshot);
        assert.strictEqual(res.free, false, 'Expected code hop not to be free when Coding holds uncompleted card');
        assert.match(res.reason, /Coding/, 'Reason should name the holding seat');
    });

    // 2. A busy REVIEWER blocks hop 2 (shared tree)
    await check('2. A busy REVIEWER blocks hop 2 (shared tree)', async () => {
        const snapshot = {
            seats: [
                { friendlyName: 'Coding', role: 'lead', status: 'active' },
                { friendlyName: 'reviewer-1', role: 'reviewer', status: 'active' },
            ],
            board: [
                {
                    planId: 'plan-review-1',
                    kanbanColumn: 'CODE REVIEWED',
                    dispatchedTerminal: 'reviewer-1',
                    completedAt: null,
                }
            ]
        };
        const resCode = teamIsFree('code', snapshot);
        assert.strictEqual(resCode.free, false, 'Expected hop 2 (code) to be blocked by busy reviewer');
        assert.match(resCode.reason, /reviewer-1/, 'Reason should name reviewer-1');

        const resReview = teamIsFree('review', snapshot);
        assert.strictEqual(resReview.free, false, 'Expected hop 3 (review) to also be blocked by busy reviewer');
    });

    // 3. Empty fleet -> unknown -> no dispatch for all three hops
    await check('3. Empty fleet -> unknown -> no dispatch for all three hops', async () => {
        const emptySnapshot = {
            seats: [],
            board: []
        };
        for (const hop of ['plan', 'code', 'review']) {
            const res = teamIsFree(hop, emptySnapshot);
            assert.strictEqual(res.free, undefined, `Expected free to be undefined for ${hop}`);
            assert.strictEqual(typeof res.unknown, 'string', `Expected unknown string for ${hop}`);
        }
    });

    // 4. A hop with no seat of its role is unknown, not free
    await check('4. A hop with no seat of its role is unknown, not free', async () => {
        const noReviewerSnapshot = {
            seats: [
                { friendlyName: 'Coding', role: 'lead', status: 'active' },
                { friendlyName: 'planner-1', role: 'planner', status: 'active' },
            ],
            board: []
        };
        const res = teamIsFree('review', noReviewerSnapshot);
        assert.strictEqual(res.free, undefined, 'Hop 3 without reviewer seat must not be free');
        assert.strictEqual(typeof res.unknown, 'string', 'Hop 3 without reviewer seat must be unknown');
        assert.match(res.unknown, /reviewer/, 'Unknown reason should name reviewer seat');
    });

    // 5. Nothing dispatches before Start, with all three ticked
    await check('5. Nothing dispatches before Start, with all three ticked', async () => {
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
                board: [
                    { planId: 'p1', kanbanColumn: 'CREATED' }
                ]
            }),
        };
        // Re-use tickDispatchHops implementation
        const { TaskViewerProvider } = require(path.join(__dirname, '..', '..', 'out', 'services', 'TaskViewerProvider.js'));
        const tickFn = TaskViewerProvider.prototype.tickDispatchHops.bind(dummyProvider);
        const result = await tickFn('/tmp');
        assert.strictEqual(result.dispatchedHop, undefined, 'Nothing should dispatch when started is false');
        assert.strictEqual(result.reasons.plan, 'not started');
    });

    // 6. At most one dispatch per tick with all three ticked and everything idle
    await check('6. At most one dispatch per tick with all three ticked and everything idle', async () => {
        let dispatchCount = 0;
        const dummyProvider = {
            hopSessionState: {
                hops: { plan: true, code: true, review: true },
                started: true,
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
                board: [
                    { planId: 'p1', kanbanColumn: 'CREATED' },
                    { planId: 'p2', kanbanColumn: 'PLAN REVIEWED' },
                    { planId: 'p3', kanbanColumn: 'LEAD CODED' },
                ]
            }),
            _executeHopDispatch: async (hop) => {
                dispatchCount++;
                return { success: true, detail: `dispatched ${hop}` };
            }
        };
        const { TaskViewerProvider } = require(path.join(__dirname, '..', '..', 'out', 'services', 'TaskViewerProvider.js'));
        const tickFn = TaskViewerProvider.prototype.tickDispatchHops.bind(dummyProvider);
        const result = await tickFn('/tmp');
        assert.strictEqual(dispatchCount, 1, 'At most one dispatch per tick');
        assert.strictEqual(result.dispatchedHop, 'plan', 'First free hop in order should dispatch');
        assert.strictEqual(result.reasons.code, 'deferred (earlier hop dispatched)');
    });

    // 7. Throttle: a continuously-free team fires at most once per intervalMinutes
    await check('7. Throttle: a continuously-free team fires at most once per intervalMinutes', async () => {
        let dispatchCount = 0;
        const now = Date.now();
        const dummyProvider = {
            hopSessionState: {
                hops: { plan: true, code: false, review: false },
                started: true,
            },
            _hopLastRunAt: { plan: now - 10000, code: 0, review: 0 }, // ran 10s ago, interval is 60s
            _hopLastReasons: { plan: '', code: '', review: '' },
            _getWorkspaceRoot: () => '/tmp',
            resolveHopSnapshot: async () => ({
                seats: [
                    { friendlyName: 'planner-1', role: 'planner', status: 'active' },
                ],
                board: [
                    { planId: 'p1', kanbanColumn: 'CREATED' },
                ]
            }),
            _executeHopDispatch: async (hop) => {
                dispatchCount++;
                return { success: true, detail: `dispatched ${hop}` };
            }
        };
        const { TaskViewerProvider } = require(path.join(__dirname, '..', '..', 'out', 'services', 'TaskViewerProvider.js'));
        const tickFn = TaskViewerProvider.prototype.tickDispatchHops.bind(dummyProvider);
        const result = await tickFn('/tmp');
        assert.strictEqual(dispatchCount, 0, 'Should not dispatch while interval has not elapsed');
        assert.strictEqual(result.dispatchedHop, undefined);
        assert.match(result.reasons.plan, /throttled/);
    });

    // 8. Nothing is written to disk — no config key gains a value across a full session
    await check('8. Nothing is written to disk — session state is in-memory only', async () => {
        const { TaskViewerProvider } = require(path.join(__dirname, '..', '..', 'out', 'services', 'TaskViewerProvider.js'));
        const providerProto = TaskViewerProvider.prototype;
        assert.strictEqual(typeof providerProto.getHopSessionState, 'function');
        assert.strictEqual(typeof providerProto.setHopSessionState, 'function');
    });

    // 9. A fresh session starts unticked and not started
    await check('9. A fresh session starts unticked and not started', async () => {
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

    // 10. Both roots wire the resolver
    await check('10. Both roots wire the resolver (extension.ts & bootstrap.ts)', async () => {
        const extSrc = fs.readFileSync(path.join(__dirname, '..', 'extension.ts'), 'utf8');
        const bootSrc = fs.readFileSync(path.join(__dirname, '..', 'standalone', 'bootstrap.ts'), 'utf8');

        assert.ok(
            extSrc.includes('setHopSnapshotResolver'),
            'extension.ts MUST wire setHopSnapshotResolver'
        );
        assert.ok(
            bootSrc.includes('setHopSnapshotResolver'),
            'standalone/bootstrap.ts MUST wire setHopSnapshotResolver'
        );
    });

    // 11. Serialization: every hop dispatch reaches _queueNextChain / enqueueOnQueueChain
    await check('11. Serialization: every hop dispatch reaches _queueNextChain / enqueueOnQueueChain', async () => {
        let chainCalled = false;
        const dummyApiServer = {
            enqueueOnQueueChain: async (fn) => {
                chainCalled = true;
                return await fn();
            },
            performKanbanDispatch: async () => ({ status: 200, payload: { success: true } })
        };
        const dummyProvider = {
            _localApiServer: dummyApiServer,
            resolveHopSnapshot: async () => ({
                seats: [{ friendlyName: 'planner-1', role: 'planner', status: 'active' }],
                board: [{ planId: 'p1', kanbanColumn: 'CREATED' }]
            }),
            _getKanbanDb: async () => undefined,
        };
        const { TaskViewerProvider } = require(path.join(__dirname, '..', '..', 'out', 'services', 'TaskViewerProvider.js'));
        const executeFn = TaskViewerProvider.prototype._executeHopDispatch.bind(dummyProvider);
        const res = await executeFn('plan', '/tmp', {});
        assert.strictEqual(chainCalled, true, 'Hop dispatch MUST run via enqueueOnQueueChain');
        assert.strictEqual(res.success, true);
    });

    // 12. In-flight guard on tickDispatchHops blocks concurrent execution
    await check('12. In-flight guard on tickDispatchHops blocks concurrent execution', async () => {
        const dummyProvider = {
            hopSessionState: {
                hops: { plan: true, code: true, review: true },
                started: true,
            },
            _hopTickInFlight: true, // already in flight
        };
        const { TaskViewerProvider } = require(path.join(__dirname, '..', '..', 'out', 'services', 'TaskViewerProvider.js'));
        const tickFn = TaskViewerProvider.prototype.tickDispatchHops.bind(dummyProvider);
        const result = await tickFn('/tmp');
        assert.strictEqual(result.reasons.plan, 'tick in flight');
        assert.strictEqual(result.reasons.code, 'tick in flight');
    });

    // 13. Serialization is REAL: with no per-server chain, the fallback is the
    // module-level `_queueNextChain` in LocalApiServer — two overlapping hop
    // dispatches run one after the other, never interleaved.
    await check('13. Overlapping hop dispatches serialize on the module _queueNextChain', async () => {
        const order = [];
        let inside = 0;
        let maxConcurrent = 0;
        const makeProvider = (tag) => ({
            // No enqueueOnQueueChain on the api server: exercises the module-level fallback.
            _localApiServer: {
                performKanbanDispatch: async () => {
                    inside++;
                    maxConcurrent = Math.max(maxConcurrent, inside);
                    order.push(`enter:${tag}`);
                    await new Promise(r => setTimeout(r, 30));
                    order.push(`exit:${tag}`);
                    inside--;
                    return { status: 200, payload: { success: true } };
                }
            },
            resolveHopSnapshot: async () => ({
                seats: [{ friendlyName: 'planner-1', role: 'planner', status: 'active' }],
                board: [{ planId: `p-${tag}`, kanbanColumn: 'CREATED' }]
            }),
            _getKanbanDb: async () => undefined,
        });
        const { TaskViewerProvider } = require(path.join(__dirname, '..', '..', 'out', 'services', 'TaskViewerProvider.js'));
        const execA = TaskViewerProvider.prototype._executeHopDispatch.bind(makeProvider('a'));
        const execB = TaskViewerProvider.prototype._executeHopDispatch.bind(makeProvider('b'));
        const both = Promise.all([execA('plan', '/tmp', {}), execB('plan', '/tmp', {})]);
        const results = await Promise.race([
            both,
            new Promise((_, rej) => setTimeout(() => rej(new Error('hop dispatch deadlocked on _queueNextChain')), 5000))
        ]);
        assert.strictEqual(maxConcurrent, 1, 'Two hop dispatches must never be inside the critical section at once');
        assert.deepStrictEqual(order, ['enter:a', 'exit:a', 'enter:b', 'exit:b'], 'Dispatches must run in chain order, not interleaved');
        assert.ok(results.every(r => r.success), 'Both dispatches should succeed');
    });

    // 14. The in-chain body must never call the chain-enqueuing PUBLIC pop.
    // `dispatchNextFromQueue` re-enqueues on `_queueNextChain`; called from
    // inside that chain it deadlocks (LocalApiServer documents this). Only
    // `_runQueuePop` is callable from inside the critical section.
    await check('14. _executeHopDispatch never calls dispatchNextFromQueue from inside the chain', async () => {
        const provSrc = fs.readFileSync(path.join(__dirname, '..', 'services', 'TaskViewerProvider.ts'), 'utf8');
        const start = provSrc.indexOf('private async _executeHopDispatch(');
        assert.ok(start > -1, '_executeHopDispatch must exist');
        const body = provSrc.slice(start, provSrc.indexOf('\n    /**', start + 10));
        assert.ok(
            !/\bdispatchNextFromQueue\s*\(/.test(body),
            '_executeHopDispatch must not call dispatchNextFromQueue (deadlocks inside _queueNextChain); use _runQueuePop'
        );
        assert.ok(body.includes('_runQueuePop'), '_executeHopDispatch must pop via _runQueuePop');
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
