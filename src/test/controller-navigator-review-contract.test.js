'use strict';

/**
 * Contract: the Navigator can intervene when the Pilot is wrong
 * (plan: the-navigator-can-intervene-when-the-pilot-is-wrong).
 *
 * These are BEHAVIOURAL assertions against the compiled controller in `out/`,
 * driven end-to-end through `runController` with an injected board and a real
 * (local, stub) model endpoint. The defects this plan is about — a review whose
 * reply nothing can act on, a disagreement coerced into the nearest known name,
 * a correction that escapes the bounds the failure trigger obeys, a correction
 * of a correction, and a review that vanishes when it finds nothing — are
 * invisible to a text search and only show up when a wake actually runs.
 *
 * The load-bearing invariants:
 *   - **It reviews ACTIONS, never silence.** No Pilot action, no review, no
 *     call. The retired escalation tier's defect — paying on quiet — is not
 *     reintroduced.
 *   - **The wrong-but-effective case.** A Pilot respawns a healthy seat, the row
 *     stops firing, verification reports SUCCESS — and the review still
 *     corrects it. This is the class invisible to every other path.
 *   - **The vocabulary does not widen.** The same closed set, the same
 *     preconditions, the same per-subject rate and daily cap, the same
 *     attribution. Only the TRIGGER is new, and both triggers share ONE
 *     implementation.
 *
 * Run with:
 *   npm run compile-tests && node --require ./src/test/bootstrap/sandboxStateHome.js \
 *     src/test/controller-navigator-review-contract.test.js
 */

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const OUT = path.join(ROOT, 'out');

let failures = 0;

function check(name, fn) {
    try {
        fn();
        console.log(`  ✅ ${name}`);
    } catch (err) {
        failures++;
        console.log(`  ❌ ${name}`);
        console.log(`     ${err && err.message ? err.message : err}`);
    }
}

async function checkAsync(name, fn) {
    try {
        await fn();
        console.log(`  ✅ ${name}`);
    } catch (err) {
        failures++;
        console.log(`  ❌ ${name}`);
        console.log(`     ${err && err.message ? err.message : err}`);
    }
}

function requireOut(rel) {
    const full = path.join(OUT, rel);
    if (!fs.existsSync(full)) {
        throw new Error(`${rel} is missing from out/ — run \`npm run compile-tests\` first`);
    }
    return require(full);
}

const matrix = requireOut('standalone/controller/matrix.js');
const controllerSrc = fs.readFileSync(path.join(ROOT, 'src', 'standalone', 'controller', 'controller.ts'), 'utf8');

// ── A real model endpoint, on a loopback port the test owns ──────────────

const MARK = {
    secondOrder: 'choose exactly ONE action from this CLOSED SET',
    mission: 'has detected that ONE MISSION has stopped moving',
    escalation: 'has escalated one case to you',
    digest: 'has just finished a wake',
    board: 'You supervise a board',
    classify: 'You observe one coding seat',
};

function startModelStub(opts = {}) {
    const calls = [];
    const server = http.createServer((req, res) => {
        let raw = '';
        req.on('data', c => { raw += c; });
        req.on('end', () => {
            let body = {};
            try { body = JSON.parse(raw); } catch { /* the controller never sends a non-JSON body */ }
            const system = String(body?.messages?.[0]?.content || '');
            const user = String(body?.messages?.[1]?.content || '');
            const kind = system.includes(MARK.secondOrder) ? 'secondOrder'
                : system.includes(MARK.mission) ? 'mission'
                    : system.includes(MARK.escalation) ? 'escalation'
                        : system.includes(MARK.digest) ? 'digest'
                            : system.includes(MARK.board) ? 'board'
                                : system.includes(MARK.classify) ? 'classify'
                                    : 'unknown';
            calls.push({ kind, system, user, model: body?.model });
            const reply = typeof opts.reply === 'function' ? opts.reply(kind, { system, user, calls }) : (opts.reply || 'ok');
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ choices: [{ message: { content: reply }, finish_reason: 'stop' }] }));
        });
    });
    return new Promise(resolve => {
        server.listen(0, '127.0.0.1', () => {
            resolve({
                url: `http://127.0.0.1:${server.address().port}/v1/chat/completions`,
                calls,
                close: () => new Promise(r => server.close(r)),
                ofKind: (kind) => calls.filter(c => c.kind === kind),
            });
        });
    });
}

// ── A board the controller can drive, with no HTTP and no database ───────

function makeBoard(opts = {}) {
    const seen = {
        reports: [], paths: [], dispatchBodies: [], moves: [], teamStops: [],
        pauses: [], stateWrites: [], logFetches: {},
    };
    let liveState = opts.state || {};
    const ok = (o) => ({ status: 200, body: JSON.stringify(o), json: () => o });
    const raw = (b) => ({ status: 200, body: b, json: () => ({}) });

    const apiRequest = async (port, method, pathname, workspaceRoot, payload) => {
        seen.paths.push(`${method} ${pathname}`);
        if (pathname === '/health') { return ok({ service: 'switchboard', status: 'ok', pid: 4242 }); }
        if (pathname === '/kanban/plans') { return ok(opts.plans || []); }
        if (pathname === '/terminals/verb/ptyListTerminals') { return ok(opts.fleet || []); }
        if (pathname === '/kanban/reports') { return ok({ success: true, reports: opts.finished || [] }); }
        if (pathname === '/controller/judgement') {
            return ok({ success: true, judgement: { tiers: opts.tiers || [], globalCeilingPerDay: null, source: 'test:judgement' } });
        }
        if (pathname === '/controller/quota') {
            return method === 'PUT' ? ok({ success: true }) : ok({ success: true, quota: { value: {} } });
        }
        if (pathname === '/controller/navigator') {
            return ok({ success: true, navigator: opts.navigatorView || { source: 'unset', reason: 'no Navigator model configured' } });
        }
        if (pathname === '/controller/escalations') {
            return ok({ success: true, escalations: { value: { open: {}, answered: {}, spuriousByRule: {} } } });
        }
        if (pathname === '/controller/escalations/open') { return ok({ success: true }); }
        if (pathname === '/controller/state') {
            if (method === 'PUT') { liveState = (payload && payload.state) || {}; seen.stateWrites.push(payload); return ok({ success: true }); }
            return ok({ success: true, state: { state: liveState } });
        }
        if (pathname === '/controller/report') { seen.reports.push(payload); return ok({ success: true }); }
        if (pathname === '/kanban/dispatch') {
            seen.dispatchBodies.push(payload);
            return ok({ success: true, delivery: 'delivered', moved: true, dispatched: true });
        }
        if (pathname === '/kanban/move') { seen.moves.push(payload); return ok({ success: true }); }
        if (pathname === '/kanban/team/stop') {
            seen.teamStops.push(payload);
            return ok({
                success: true, teamId: payload && payload.teamId, head: 'Feature', status: 'stopped', rosterResolved: true,
                paused: ['mission-1'], pauseSkipped: [], released: ['plan-1'], failed: [], releasedSeats: ['coder-1'],
                alreadyClear: [], closed: ['coder-1'], alreadyGone: [], closeFailed: [],
            });
        }
        if (pathname === '/kanban/mission/pause-team') {
            seen.pauses.push(payload);
            return ok({ success: true, teamId: payload && payload.teamId, paused: ['mission-1'], skipped: [] });
        }
        if (pathname === '/kanban/missions') { return ok({ success: true, missions: opts.missions || [] }); }
        // The REAL wrapped shape: `_handleReadEndpoint` serves `{ success, data }`.
        if (pathname === '/kanban/missions/progress') {
            return ok({ success: true, data: { missions: [], summary: {}, outsideMissions: null } });
        }
        if (/^\/terminals\/.+\/log$/.test(pathname)) {
            const seat = decodeURIComponent(pathname.split('/')[2]);
            seen.logFetches[seat] = (seen.logFetches[seat] || 0) + 1;
            return raw(opts.logTail !== undefined ? opts.logTail : 'no output this round\n');
        }
        if (pathname === '/kanban/queue/done') { return ok({ success: true }); }
        return ok({ success: true });
    };
    return { apiRequest, seen, state: () => liveState };
}

// ── The pieces every scenario shares ────────────────────────────────────

const STUCK_SINCE = new Date(Date.now() - 3 * 60 * 60_000).toISOString();
const TODAY = new Date().toISOString().slice(0, 10);

/**
 * A card held by a seat that is ABSENT from the fleet, which is row 4
 * (`crashed-dead-process`) — a mechanical row, so no classifier tier is needed
 * and no CPU sample has to be seeded. With no tier configured, `supervisor`,
 * `stand-down` and `reroute` are unreachable, so the Pilot's ladder from row
 * 4's `reset-context` is `reset-context -> stop`.
 */
function deadSeatPlan(over = {}) {
    return {
        planId: 'plan-1',
        topic: 'Fix the flaky test',
        kanbanColumn: 'CODER CODED',
        ownerSeat: 'coder-1',
        ownerSince: STUCK_SINCE,
        completedAt: null,
        lastAction: 'dispatched',
        ...over,
    };
}

function navigatorConfigured(url) {
    return {
        providerId: 'local', endpoint: url, model: 'stub-navigator', keySet: false,
        locality: 'loopback', costClass: 'free', operator: 'self', source: 'row:navigator',
    };
}

/** A delivery heading with an echo after it, so a re-dispatch VERIFIES as delivered. */
const DELIVERED_LOG = '## 2026-09-22T01:02:03.004Z — Fix the flaky test\n\n> Reading the failing test now\n';

function tmpWorkspace() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'sb-review-'));
}

async function oneWake({ board, workspaceRoot }) {
    const { runController } = requireOut('standalone/controller/controller.js');
    return runController({
        workspaceRoot, port: 7777, apiRequest: board.apiRequest,
        controllerId: 'controller:test', once: true, now: () => Date.now(), log: () => {},
    });
}

const reportBody = (board, i = 0) => (board.seen.reports[i] && board.seen.reports[i].body) || '';
const lastReportBody = (board) => reportBody(board, board.seen.reports.length - 1);

/** A fresh subject (no ladder state) so the Pilot applies `reset-context` this wake. */
function freshSubjectBoard(opts = {}) {
    return makeBoard({
        plans: [deadSeatPlan()], fleet: [], missions: [], logTail: DELIVERED_LOG,
        state: {}, navigatorView: opts.navigatorView, ...opts.board,
    });
}

// ═══════════════════════════════════════════════════════════════════════

async function run() {
    console.log('\nContract: the Navigator can intervene when the Pilot is wrong\n');

    // ── 1. The vocabulary does NOT widen ─────────────────────────────────

    check('SECOND_ORDER_ACTIONS is unchanged, and the ladder and remediations are untouched', () => {
        assert.deepStrictEqual([...matrix.SECOND_ORDER_ACTIONS],
            ['redispatch', 'reset-feature-status', 'stand-down-team', 'disband-team', 'stop'],
            'the closed set must be exactly the five names — this plan changes WHEN, never WHAT');
        // The two sets the dispatch names as MUST NOT TOUCH, byte-identical.
        assert.deepStrictEqual([...matrix.ESCALATION_LADDER],
            ['bare-enter', 'redeliver-dispatch', 'respawn-seat', 'reset-context', 'reroute', 'stand-down', 'supervisor', 'stop'],
            'the first-order ladder must be unchanged in length and order');
        assert.deepStrictEqual([...matrix.MATRIX_REMEDIATIONS],
            ['mark-complete', 'bare-enter', 'redeliver-dispatch', 'respawn-seat', 'reset-context', 'reroute', 'stand-down', 'supervisor', 'record-unknown', 'post-completion-on-behalf', 'stop'],
            'MATRIX_REMEDIATIONS must be unchanged — a new name here would load as a rung');
        for (const a of matrix.SECOND_ORDER_ACTIONS) {
            if (a === 'stop') { continue; }
            assert.ok(!matrix.MATRIX_REMEDIATIONS.includes(a), `'${a}' leaked into MATRIX_REMEDIATIONS`);
            assert.ok(!matrix.ESCALATION_LADDER.includes(a), `'${a}' leaked into the ladder`);
        }
    });

    check('ONE validation path serves both triggers — a single runSecondOrder call site', () => {
        assert.strictEqual((controllerSrc.match(/await runSecondOrder\(/g) || []).length, 1,
            'runSecondOrder must have exactly ONE call site, so the two triggers cannot drift');
        assert.strictEqual((controllerSrc.match(/async function runSecondOrderCandidates\(/g) || []).length, 1,
            'the single entry point for both triggers must exist');
        assert.strictEqual((controllerSrc.match(/await runSecondOrderCandidates\(/g) || []).length, 2,
            'both entry points (verification and disagreement) must go through it');
        // The validation itself: one definition, one call site, for each.
        assert.strictEqual((controllerSrc.match(/secondOrderPrecondition\(/g) || []).length, 2,
            'the precondition check must have one definition and one call site');
        assert.strictEqual((controllerSrc.match(/recheckSecondOrderTrigger\(/g) || []).length, 2,
            'the immediately-before re-check must have one definition and one call site');
    });

    check('the digest names the superseded constraint it reverses, and the bounds it keeps', () => {
        assert.ok(/the-pilot-and-the-navigator-are-one-crew/.test(controllerSrc),
            'the amended constraint must be named');
        assert.ok(/SUPERSEDED/.test(controllerSrc), 'the reversal must say so');
        assert.ok(/the-navigator-can-intervene-when-the-pilot-is-wrong/.test(controllerSrc),
            'the plan that reverses it must be named');
        assert.ok(/Only the TRIGGER is new/.test(controllerSrc), 'the bounds must be stated as unchanged');
    });

    // The shared stub DISPUTES by default: most scenarios need a correction to
    // be named, and the ones that need a review that agrees use their own stub.
    const stub = await startModelStub({
        reply: (kind) => (kind === 'digest' ? 'NAV-DIGEST-REPLY: noted.\nCORRECT: plan-1 redispatch — the seat is gone; re-dispatching its own prompt cannot help a dead seat.'
            : kind === 'secondOrder' ? 'redispatch'
                : kind === 'board' ? 'nothing wrong'
                    : 'ok'),
    });

    try {
        // ── 2. A disputed Pilot action produces exactly one correction ────

        await checkAsync('a Pilot action the Navigator disputes produces EXACTLY ONE correction, with the action and the reason recorded', async () => {
            stub.calls.length = 0;
            const board = freshSubjectBoard({
                navigatorView: navigatorConfigured(stub.url),
                board: {
                    // The review disputes the `reset-context` the Pilot just applied.
                    logTail: DELIVERED_LOG,
                },
            });
            await oneWake({ board, workspaceRoot: tmpWorkspace() });
            assert.strictEqual(stub.ofKind('digest').length, 1, 'the review runs once per acting wake');
            assert.strictEqual(stub.ofKind('secondOrder').length, 1,
                `a disagreement must produce exactly ONE correction ask, got ${stub.ofKind('secondOrder').length}`);
            assert.strictEqual(board.seen.dispatchBodies.length, 1,
                'the correction must be applied through its board verb');
            const body = lastReportBody(board);
            assert.ok(/trigger: `disagreement`/.test(body), `the trigger must be recorded: ${body}`);
            assert.ok(/the Navigator disputed the Pilot's `reset-context`/.test(body),
                'the DISPUTED action must be named');
            assert.ok(/second-order action: `redispatch` — \*\*applied\*\*/.test(body),
                `the correction must be recorded as applied: ${body}`);
            // The disputed action is named to the correction ask, so the model
            // is not asked to correct something it cannot see.
            const ask = stub.ofKind('secondOrder')[0];
            assert.ok(/The Pilot's action you disputed: `reset-context`/.test(ask.user), ask.user);
            assert.ok(/disputed the Pilot's action/.test(ask.system) || /judged what it did WRONG/.test(ask.system),
                'the prompt must state the disagreement premise, not the failure premise');
            assert.ok(!/has applied every rung of its escalation ladder/.test(ask.system),
                'a disagreement must not be told a false premise');
            // The correction awaits verification like any other action.
            const st = board.state().subjects['card:plan-1'];
            assert.strictEqual(st.secondOrderLast, 'redispatch', 'the applied correction must persist');
            assert.ok(st.pending && st.pending.secondOrder === true && st.pending.action === 'redispatch',
                'the correction must itself await verification');
        });

        await checkAsync('the review records the reading, and the machine-read CORRECT line is not echoed as prose', async () => {
            stub.calls.length = 0;
            const board = freshSubjectBoard({ navigatorView: navigatorConfigured(stub.url) });
            await oneWake({ board, workspaceRoot: tmpWorkspace() });
            const body = lastReportBody(board);
            assert.ok(/NAV-DIGEST-REPLY: noted\./.test(body), 'the prose must be recorded');
            assert.ok(!/CORRECT:/.test(body), 'the CORRECT line is machine-read; the disposition is recorded instead');
        });

        // ── 3. The wrong-but-effective case ──────────────────────────────

        await checkAsync('THE WRONG-BUT-EFFECTIVE CASE: verification reports SUCCESS and the review still corrects the action', async () => {
            stub.calls.length = 0;
            const stubStop = await startModelStub({
                reply: (kind) => (kind === 'digest'
                    ? 'The seat was already working.\nCORRECT: plan-1 stop — that seat was mid-turn; respawning it destroyed a live context.'
                    : kind === 'secondOrder' ? 'stop' : 'ok'),
            });
            try {
                const board = makeBoard({
                    // The seat is ALIVE and producing: the row no longer fires, so
                    // the Pilot's `respawn-seat` verifies as SUCCESS. Nothing else
                    // in the controller can see that the action was wrong.
                    plans: [deadSeatPlan()],
                    fleet: [{ friendlyName: 'coder-1', status: 'active', lastDataAt: Date.now() - 60_000, cliFamily: 'claude' }],
                    missions: [],
                    logTail: DELIVERED_LOG,
                    state: {
                        subjects: {
                            'card:plan-1': {
                                rung: 7, atRung: 1, ruleId: 'crashed-dead-process',
                                firstSeenAt: Date.now() - 60 * 60_000, lastFiredAt: Date.now() - 60 * 60_000,
                                ownerSince: STUCK_SINCE, stuckPasses: 3, lastClass: null, exhausted: true,
                                pending: { action: 'respawn-seat', ruleId: 'crashed-dead-process', at: Date.now() - 60_000, secondOrder: false },
                            },
                        },
                    },
                    navigatorView: navigatorConfigured(stubStop.url),
                });
                await oneWake({ board, workspaceRoot: tmpWorkspace() });
                const body = lastReportBody(board);
                assert.ok(/verification of the previous action: \*\*success\*\*/.test(body),
                    `the verification must report SUCCESS — the symptom stopped: ${body}`);
                assert.ok(!/verification:failed/.test(body), 'there is no failure to react to');
                assert.strictEqual(stubStop.ofKind('secondOrder').length, 1,
                    'the review must still produce a correction — this is the case invisible today');
                assert.strictEqual(stubStop.ofKind('secondOrder')[0].system.includes('disputed'), true,
                    'the correction must be the DISAGREEMENT trigger, not a verification failure');
                assert.ok(/trigger: `disagreement`/.test(body), body);
                assert.ok(/the Navigator disputed the Pilot's `respawn-seat`/.test(body),
                    `the disputed action must be the respawn: ${body}`);
                assert.ok(/second-order action: `stop` — \*\*applied\*\*/.test(body),
                    `the correction must be applied: ${body}`);
                assert.strictEqual(board.state().subjects['card:plan-1'].stoppedBySecondOrder, true,
                    'the terminus must be recorded');
                // The correction names the disputed action to the model.
                const ask = stubStop.ofKind('secondOrder')[0];
                assert.ok(/The Pilot's action you disputed: `respawn-seat`/.test(ask.user), ask.user);
            } finally {
                await stubStop.close();
            }
        });

        // ── 4. It reviews actions, never silence ────────────────────────

        await checkAsync('a wake where the Pilot took NO action produces no review and no call', async () => {
            stub.calls.length = 0;
            // No cards at all: no subjects, no Pilot actions, no missions.
            const board = makeBoard({ plans: [], fleet: [], missions: [], navigatorView: navigatorConfigured(stub.url) });
            await oneWake({ board, workspaceRoot: tmpWorkspace() });
            assert.strictEqual(stub.calls.length, 0,
                `the Navigator must not be on the cadence: ${JSON.stringify(stub.calls.map(c => c.kind))}`);
        });

        await checkAsync('a wake with ONLY a mission observation produces no review and no call', async () => {
            stub.calls.length = 0;
            // A mission with no members: the watch emits its noticing entry, and
            // that entry is a READING, not something the wake DID.
            const board = makeBoard({
                plans: [],
                fleet: [],
                missions: [{ id: 'm1', name: 'M', goal: '', team: null, teams: [], ready: true, paused: false, cardsTotal: 1, cardsDone: 0, cardsInFlight: 0, cardsWorking: 0, columns: {}, startedAt: null, lastMovementAt: Date.now() - 6 * 3600_000, runState: 'in-flight', sequencing: [] }],
                missionMembers: [{ id: 'm1', plans: [], features: [] }],
                navigatorView: navigatorConfigured(stub.url),
            });
            await oneWake({ board, workspaceRoot: tmpWorkspace() });
            assert.strictEqual(stub.ofKind('digest').length, 0,
                'a mission observation must not put the Navigator on the cadence');
            assert.strictEqual(stub.calls.length, 0, 'no call at all');
        });

        // ── 5. The reply is validated, never coerced ─────────────────────

        await checkAsync('a disagreement naming an action OUTSIDE the closed set is discarded and recorded; nothing is applied', async () => {
            const stubBad = await startModelStub({
                reply: (kind) => (kind === 'digest'
                    ? 'I would nudge the seat again and ask the lead.\nCORRECT: plan-1 nudge-the-seat — it looks confused'
                    : kind === 'secondOrder' ? 'redispatch' : 'ok'),
            });
            try {
                const board = freshSubjectBoard({ navigatorView: navigatorConfigured(stubBad.url) });
                await oneWake({ board, workspaceRoot: tmpWorkspace() });
                assert.strictEqual(stubBad.ofKind('secondOrder').length, 0, 'an unknown name applies NOTHING');
                assert.strictEqual(board.seen.dispatchBodies.length, 0, 'nothing may be dispatched');
                assert.strictEqual(board.seen.teamStops.length, 0, 'nothing may be disbanded');
                assert.strictEqual(board.seen.moves.length, 0, 'nothing may be moved');
                assert.strictEqual(board.seen.pauses.length, 0, 'nothing may be stood down');
                const body = lastReportBody(board);
                assert.ok(/OUTSIDE the closed set/.test(body), `the discard must be recorded: ${body}`);
                assert.ok(/never coerced to a nearest name/.test(body), 'the report must say it was NOT coerced');
                assert.ok(/nudge-the-seat/.test(body), 'the discarded name must be recorded verbatim');
            } finally {
                await stubBad.close();
            }
        });

        await checkAsync('a review naming TWO corrections is ambiguous, and NOTHING is applied', async () => {
            const stubAmb = await startModelStub({
                reply: (kind) => (kind === 'digest'
                    ? 'Two things look wrong.\nCORRECT: plan-1 stop — first\nCORRECT: plan-1 redispatch — second'
                    : kind === 'secondOrder' ? 'redispatch' : 'ok'),
            });
            try {
                const board = freshSubjectBoard({ navigatorView: navigatorConfigured(stubAmb.url) });
                await oneWake({ board, workspaceRoot: tmpWorkspace() });
                assert.strictEqual(board.seen.dispatchBodies.length, 0, 'an ambiguous review applies nothing');
                const body = lastReportBody(board);
                assert.ok(/MORE THAN ONE is ambiguous/.test(body), `the ambiguity must be recorded: ${body}`);
            } finally {
                await stubAmb.close();
            }
        });

        // ── 6. A correction is ONE move ─────────────────────────────────

        await checkAsync('a disagreement about an action the NAVIGATOR caused is refused', async () => {
            stub.calls.length = 0;
            const stubSelf = await startModelStub({
                reply: (kind) => (kind === 'digest'
                    ? 'I now think that was wrong.\nCORRECT: plan-1 stop — I changed my mind about my own redispatch'
                    : kind === 'secondOrder' ? 'stop' : 'ok'),
            });
            try {
                // The action under verification is the Navigator's OWN correction
                // (applied last wake), and the seat is producing, so the row does
                // not fire and the verification is a SUCCESS.
                const board = makeBoard({
                    plans: [deadSeatPlan()],
                    fleet: [{ friendlyName: 'coder-1', status: 'active', lastDataAt: Date.now() - 60_000, cliFamily: 'claude' }],
                    missions: [], logTail: DELIVERED_LOG,
                    state: {
                        subjects: {
                            'card:plan-1': {
                                rung: 7, atRung: 1, ruleId: 'crashed-dead-process',
                                firstSeenAt: Date.now() - 60 * 60_000, lastFiredAt: Date.now() - 60 * 60_000,
                                ownerSince: STUCK_SINCE, stuckPasses: 3, lastClass: null, exhausted: true,
                                pending: { action: 'redispatch', ruleId: 'crashed-dead-process', at: Date.now() - 60_000, secondOrder: true },
                            },
                        },
                    },
                    navigatorView: navigatorConfigured(stubSelf.url),
                });
                await oneWake({ board, workspaceRoot: tmpWorkspace() });
                assert.strictEqual(stubSelf.ofKind('secondOrder').length, 0,
                    'a correction may not correct a correction — no ask may be made');
                assert.strictEqual(board.state().subjects['card:plan-1'].stoppedBySecondOrder, undefined,
                    'the terminus must not be applied');
                const body = lastReportBody(board);
                assert.ok(/correction may not correct a correction/.test(body), `the refusal must be recorded: ${body}`);
            } finally {
                await stubSelf.close();
            }
        });

        await checkAsync('a subject that both FAILS verification and draws a disagreement receives ONE correction, not two', async () => {
            stub.calls.length = 0;
            const stubBoth = await startModelStub({
                reply: (kind) => (kind === 'digest'
                    ? 'The redispatch did not help either.\nCORRECT: plan-1 stop — this subject is a lost cause'
                    : kind === 'secondOrder' ? 'redispatch' : 'ok'),
            });
            try {
                const board = makeBoard({
                    plans: [deadSeatPlan()], fleet: [], missions: [], logTail: DELIVERED_LOG,
                    state: {
                        subjects: {
                            'card:plan-1': {
                                rung: 7, atRung: 1, ruleId: 'crashed-dead-process',
                                firstSeenAt: Date.now() - 60 * 60_000, lastFiredAt: Date.now() - 60 * 60_000,
                                ownerSince: STUCK_SINCE, stuckPasses: 3, lastClass: null, exhausted: true,
                                pending: { action: 'stop', ruleId: 'crashed-dead-process', at: Date.now() - 60_000, secondOrder: false },
                            },
                        },
                    },
                    navigatorView: navigatorConfigured(stubBoth.url),
                });
                await oneWake({ board, workspaceRoot: tmpWorkspace() });
                // One correction: the verification-driven `redispatch`. The
                // disagreement about the same subject is refused.
                assert.strictEqual(stubBoth.ofKind('secondOrder').length, 1,
                    `exactly ONE correction ask, got ${stubBoth.ofKind('secondOrder').length}`);
                assert.strictEqual(board.seen.dispatchBodies.length, 1, 'and exactly one verb applied');
                assert.strictEqual(board.state().subjects['card:plan-1'].stoppedBySecondOrder, undefined,
                    'the second correction must NOT have been applied');
                const body = lastReportBody(board);
                assert.ok(/already corrected this wake/.test(body), `the refusal must be recorded: ${body}`);
            } finally {
                await stubBoth.close();
            }
        });

        await checkAsync('a disagreement naming a card the wake never touched is refused as out of scope', async () => {
            const stubScope = await startModelStub({
                reply: (kind) => (kind === 'digest'
                    ? 'Something from an hour ago bothers me.\nCORRECT: plan-99 stop — a previous wake\'s action'
                    : kind === 'secondOrder' ? 'stop' : 'ok'),
            });
            try {
                const board = freshSubjectBoard({ navigatorView: navigatorConfigured(stubScope.url) });
                await oneWake({ board, workspaceRoot: tmpWorkspace() });
                assert.strictEqual(stubScope.ofKind('secondOrder').length, 0, 'an out-of-scope card applies nothing');
                const body = lastReportBody(board);
                assert.ok(/no card `plan-99` was part of this wake/.test(body), `the refusal must be recorded: ${body}`);
            } finally {
                await stubScope.close();
            }
        });

        // ── 7. The bounds bite exactly as they do for a failure ─────────

        await checkAsync('the daily cap suppresses a disagreement-driven correction with the same stated reason', async () => {
            stub.calls.length = 0;
            const seeded = { secondOrderCalls: { dayKey: TODAY, count: 24 } };
            const board = freshSubjectBoard({ navigatorView: navigatorConfigured(stub.url), board: { state: seeded } });
            await oneWake({ board, workspaceRoot: tmpWorkspace() });
            assert.strictEqual(stub.ofKind('secondOrder').length, 0,
                'the daily cap must suppress the correction BEFORE the call is made');
            assert.strictEqual(board.seen.dispatchBodies.length, 0, 'nothing may be applied');
            const body = lastReportBody(board);
            assert.ok(/the daily cap is reached \(24 of 24 asks today\)/.test(body),
                `the cap must be stated: ${body}`);
            assert.ok(/trigger: `disagreement`/.test(body), 'and the trigger must still be recorded');
        });

        await checkAsync('the per-subject rate suppresses a disagreement-driven correction with the same stated reason', async () => {
            stub.calls.length = 0;
            const seeded = {
                wakes: 100,
                subjects: { 'card:plan-1': { secondOrderAskWake: 100 } },
            };
            const board = freshSubjectBoard({ navigatorView: navigatorConfigured(stub.url), board: { state: seeded } });
            await oneWake({ board, workspaceRoot: tmpWorkspace() });
            assert.strictEqual(stub.ofKind('secondOrder').length, 0,
                'the per-subject rate must suppress the correction BEFORE the call is made');
            const body = lastReportBody(board);
            assert.ok(/the per-subject rate allows one ask per 3 wakes/.test(body),
                `the rate must be stated: ${body}`);
        });

        // ── 8. A review with no correction is still a finding ───────────

        await checkAsync('a review that AGREES is recorded — silence is not the only way "no correction" is expressed', async () => {
            stub.calls.length = 0;
            const stubAgree = await startModelStub({
                reply: (kind) => (kind === 'digest' ? 'The wake looks right to me; nothing to correct.' : 'ok'),
            });
            try {
                const board = freshSubjectBoard({ navigatorView: navigatorConfigured(stubAgree.url) });
                await oneWake({ board, workspaceRoot: tmpWorkspace() });
                assert.strictEqual(stubAgree.ofKind('digest').length, 1, 'the review runs');
                assert.strictEqual(stubAgree.ofKind('secondOrder').length, 0, 'a review that agrees corrects nothing');
                const body = lastReportBody(board);
                assert.ok(/navigator-digest/.test(body), 'the review entry must exist');
                assert.ok(/named no correction/.test(body), `the no-correction finding must be recorded: ${body}`);
                assert.ok(/reviewed this wake's 1 disputable action\(s\)/.test(body),
                    'the entry must say what it reviewed');
                assert.ok(/The wake looks right to me/.test(body), 'and it must carry the reading');
            } finally {
                await stubAgree.close();
            }
        });

        // ── 9. The trigger is recorded on EVERY correction ──────────────

        await checkAsync('every correction records which trigger produced it', async () => {
            // Verification-driven.
            const stubV = await startModelStub({
                reply: (kind) => (kind === 'digest' ? 'NAV-DIGEST-REPLY: noted.' : kind === 'secondOrder' ? 'redispatch' : 'ok'),
            });
            try {
                const board = makeBoard({
                    plans: [deadSeatPlan()], fleet: [], missions: [], logTail: DELIVERED_LOG,
                    state: {
                        subjects: {
                            'card:plan-1': {
                                rung: 7, atRung: 1, ruleId: 'crashed-dead-process',
                                firstSeenAt: Date.now() - 60 * 60_000, lastFiredAt: Date.now() - 60 * 60_000,
                                ownerSince: STUCK_SINCE, stuckPasses: 3, lastClass: null, exhausted: true,
                                pending: { action: 'stop', ruleId: 'crashed-dead-process', at: Date.now() - 60_000, secondOrder: false },
                            },
                        },
                    },
                    navigatorView: navigatorConfigured(stubV.url),
                });
                await oneWake({ board, workspaceRoot: tmpWorkspace() });
                assert.ok(/trigger: `verification`/.test(lastReportBody(board)),
                    'a failure-driven correction must record its trigger too');
            } finally {
                await stubV.close();
            }
        });

        // ── 10. The review never bypasses the closed set ────────────────

        await checkAsync('a disagreement is applied ONLY through the named board verb', async () => {
            stub.calls.length = 0;
            const stubVerb = await startModelStub({
                reply: (kind) => (kind === 'digest'
                    ? 'Disagree.\nCORRECT: plan-1 stand-down-team — the team is the problem'
                    : kind === 'secondOrder' ? 'stand-down-team' : 'ok'),
            });
            try {
                const board = makeBoard({
                    plans: [deadSeatPlan()], fleet: [],
                    missions: [{ id: 'mission-1', team: 'coding-team', plans: ['plan-1'], features: [] }],
                    logTail: DELIVERED_LOG, state: {},
                    navigatorView: navigatorConfigured(stubVerb.url),
                });
                await oneWake({ board, workspaceRoot: tmpWorkspace() });
                assert.strictEqual(board.seen.pauses.length, 1, 'the correction must go through pause-team');
                assert.strictEqual(board.seen.pauses[0].teamId, 'coding-team',
                    'and the team must be the subject\'s OWN, resolved from the board');
                assert.strictEqual(board.seen.dispatchBodies.length, 0, 'nothing else may be applied');
                assert.ok(!board.seen.paths.some(p => /ptyCloseTerminal|ptyRespawnSeat|ptyWrite|ptySendPrompt/.test(p)),
                    'a correction touches no terminal directly');
            } finally {
                await stubVerb.close();
            }
        });
    } finally {
        await stub.close();
    }

    console.log(`\n${failures === 0 ? 'ALL PASSED' : `${failures} FAILED`}\n`);
    if (failures > 0) { process.exit(1); }
}

run().catch(err => {
    console.error(err);
    process.exit(1);
});
