'use strict';

/**
 * Contract: the Navigator verifies, and acts when the Pilot did not fix it
 * (plan: the-navigator-verifies-and-acts-when-the-pilot-did-not-fix-it).
 *
 * These are BEHAVIOURAL assertions against the compiled controller in `out/`,
 * driven end-to-end through `runController` with an injected board and a real
 * (local, stub) model endpoint. The distinction is the point: the defects this
 * plan is about — a remediation reported as done because the CALL was accepted,
 * a second-order reply coerced into the nearest known name, a verify-act loop
 * with no bound, a `disband-team` that fans out over seats itself — are
 * invisible to a text search and only show up when a wake actually runs.
 *
 * Run with:
 *   npm run compile-tests && node --require ./src/test/bootstrap/sandboxStateHome.js \
 *     src/test/controller-second-order-contract.test.js
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
    // `events` is the ORDERED interleaving of report writes and state-changing
    // verbs. It is what makes "the record was written BEFORE the effect"
    // assertable rather than merely claimable.
    const seen = {
        reports: [], paths: [], events: [], dispatchBodies: [], moves: [],
        teamStops: [], pauses: [], escalations: [], stateWrites: [],
    };
    let liveState = opts.state || {};
    let plansReads = 0;
    const ok = (o) => ({ status: 200, body: JSON.stringify(o), json: () => o });
    const raw = (b) => ({ status: 200, body: b, json: () => ({}) });

    const apiRequest = async (port, method, pathname, workspaceRoot, payload) => {
        seen.paths.push(`${method} ${pathname}`);
        if (pathname === '/health') { return ok({ service: 'switchboard', status: 'ok', pid: 4242 }); }
        if (pathname === '/kanban/plans') {
            plansReads++;
            if (plansReads > 1 && opts.plansAfterFirst) { return ok(opts.plansAfterFirst); }
            return ok(opts.plans || []);
        }
        if (pathname === '/terminals/verb/ptyListTerminals') { return ok(opts.fleet || []); }
        if (pathname === '/kanban/reports') { return ok({ success: true, reports: [] }); }
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
        if (pathname === '/controller/escalations/open') { seen.escalations.push(payload && payload.escalation); return ok({ success: true }); }
        if (pathname === '/controller/state') {
            if (method === 'PUT') { liveState = (payload && payload.state) || {}; seen.stateWrites.push(payload); return ok({ success: true }); }
            return ok({ success: true, state: { state: liveState } });
        }
        if (pathname === '/controller/report') {
            seen.reports.push(payload);
            seen.events.push({ kind: 'report', body: payload && payload.body });
            return ok({ success: true });
        }
        if (pathname === '/kanban/dispatch') {
            seen.dispatchBodies.push(payload);
            seen.events.push({ kind: 'verb', path: 'POST /kanban/dispatch' });
            return ok({ success: true, delivery: 'delivered', moved: true, dispatched: true });
        }
        if (pathname === '/kanban/move') {
            seen.moves.push(payload);
            seen.events.push({ kind: 'verb', path: 'POST /kanban/move' });
            return ok({ success: true });
        }
        if (pathname === '/kanban/team/stop') {
            seen.teamStops.push(payload);
            seen.events.push({ kind: 'verb', path: 'POST /kanban/team/stop' });
            return ok({
                success: true, teamId: payload && payload.teamId, head: 'Feature', status: 'stopped', rosterResolved: true,
                paused: ['mission-1'], pauseSkipped: [], released: ['plan-1'], failed: [], releasedSeats: ['coder-1'],
                alreadyClear: [], closed: ['coder-1'], alreadyGone: [], closeFailed: [],
            });
        }
        if (pathname === '/kanban/mission/pause-team') {
            seen.pauses.push(payload);
            seen.events.push({ kind: 'verb', path: 'POST /kanban/mission/pause-team' });
            return ok({ success: true, teamId: payload && payload.teamId, paused: ['mission-1'], skipped: [] });
        }
        if (pathname === '/kanban/missions') { return ok({ success: true, missions: opts.missions || [] }); }
        if (pathname === '/kanban/missions/progress') { return ok({ success: true, missions: [], outsideMissions: null }); }
        if (/^\/terminals\/.+\/log$/.test(pathname)) { return raw(opts.logTail !== undefined ? opts.logTail : 'no output this round\n'); }
        if (pathname === '/kanban/queue/done') { return ok({ success: true }); }
        return ok({ success: true });
    };
    return { apiRequest, seen, state: () => liveState };
}

// ── The pieces every scenario shares ────────────────────────────────────

const STUCK_SINCE = new Date(Date.now() - 3 * 60 * 60_000).toISOString();

/**
 * A card held by a seat that is ABSENT from the fleet, which is row 4
 * (`crashed-dead-process`) — a mechanical row, so no classifier tier is needed
 * and no CPU sample has to be seeded. Every scenario below therefore fires
 * exactly one row, deterministically.
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
        providerId: 'local',
        endpoint: url,
        model: 'stub-navigator',
        keySet: false,
        locality: 'loopback',
        costClass: 'free',
        operator: 'self',
        source: 'row:navigator',
    };
}

/**
 * The state a subject is in on the wake AFTER the Pilot's ladder ran out: the
 * `stop` rung was applied last wake (so `exhausted` is set and the ladder has
 * nothing higher), and the action is awaiting verification.
 */
function spentLadderState(over = {}) {
    return {
        subjects: {
            'card:plan-1': {
                rung: 7,
                atRung: 1,
                ruleId: 'crashed-dead-process',
                firstSeenAt: Date.now() - 60 * 60_000,
                lastFiredAt: Date.now() - 60 * 60_000,
                ownerSince: STUCK_SINCE,
                stuckPasses: 4,
                lastClass: null,
                exhausted: true,
                pending: { action: 'stop', ruleId: 'crashed-dead-process', at: Date.now() - 60_000, secondOrder: false },
                ...over,
            },
        },
    };
}

function tmpWorkspace() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'sb-second-order-'));
}

async function oneWake({ board, workspaceRoot, config }) {
    const { runController } = requireOut('standalone/controller/controller.js');
    return runController({
        workspaceRoot,
        port: 7777,
        apiRequest: board.apiRequest,
        controllerId: 'controller:test',
        once: true,
        config,
        now: () => Date.now(),
        log: () => {},
    });
}

const reportBody = (board, i = 0) => (board.seen.reports[i] && board.seen.reports[i].body) || '';
const lastReportBody = (board) => reportBody(board, board.seen.reports.length - 1);
const allReportBodies = (board) => board.seen.reports.map(r => r.body).join('\n\n');

/** A board with a dead seat, one held card, a Navigator, and a mission. */
function scenario(opts = {}) {
    return makeBoard({
        plans: [deadSeatPlan()],
        fleet: [],
        missions: opts.missions !== undefined ? opts.missions : [],
        // A delivery heading with an echo after it, so a re-dispatch VERIFIES as
        // delivered rather than landing on the deliberately-distinct
        // `unverified` state — that distinction has its own suite.
        logTail: '## 2026-09-22T01:02:03.004Z — Fix the flaky test\n\n> Reading the failing test now\n',
        state: opts.state || spentLadderState(),
        navigatorView: opts.navigatorView,
        plansAfterFirst: opts.plansAfterFirst,
        ...opts.board,
    });
}

// ═══════════════════════════════════════════════════════════════════════

async function run() {
    console.log('\nContract: the Navigator verifies, and acts when the Pilot did not fix it\n');

    // ── 1. The closed set is a SEPARATE AXIS ─────────────────────────────

    check('SECOND_ORDER_ACTIONS is the five declared names and nothing else', () => {
        assert.deepStrictEqual([...matrix.SECOND_ORDER_ACTIONS],
            ['redispatch', 'reset-feature-status', 'stand-down-team', 'disband-team', 'stop'],
            'the closed set must be exactly the five names the plan declares');
        assert.ok(!matrix.SECOND_ORDER_ACTIONS.includes('escalate-human'),
            "'escalate-human' must be absent — messaging an agent seat is forbidden");
        assert.ok(matrix.SECOND_ORDER_ACTIONS.includes('stop'),
            "'stop' must be present and reachable — it is the terminus");
    });

    check('no NEW second-order name is a remediation or a ladder rung, and the ladder is unchanged', () => {
        // `stop` is the one name that legitimately appears on BOTH axes: it is
        // the first-order ladder's terminus AND the second-order axis's, because
        // on both it means the same thing — "cease acting on this subject and
        // record that you have". What must not happen is a NEW name being added
        // to either set, which is what this asserts.
        for (const a of matrix.SECOND_ORDER_ACTIONS) {
            if (a === 'stop') { continue; }
            assert.ok(!matrix.MATRIX_REMEDIATIONS.includes(a),
                `'${a}' is in MATRIX_REMEDIATIONS — the axes must not be merged`);
            assert.ok(!matrix.ESCALATION_LADDER.includes(a),
                `'${a}' is a ladder rung — second-order actions are not rungs`);
        }
        // The paired positive, and the load-bearing half: the first-order ladder
        // is unchanged in length AND order. A plan that quietly inserted a rung
        // here would pass every negative above.
        assert.deepStrictEqual([...matrix.ESCALATION_LADDER],
            ['bare-enter', 'redeliver-dispatch', 'respawn-seat', 'reset-context', 'reroute', 'stand-down', 'supervisor', 'stop'],
            'the first-order ladder must be unchanged in length and order');
        assert.deepStrictEqual([...matrix.MATRIX_REMEDIATIONS],
            ['mark-complete', 'bare-enter', 'redeliver-dispatch', 'respawn-seat', 'reset-context', 'reroute', 'stand-down', 'supervisor', 'record-unknown', 'post-completion-on-behalf', 'stop'],
            'MATRIX_REMEDIATIONS must be unchanged — a second-order name added here would load as a rung');
    });

    check('every second-order action declares a board verb and a precondition', () => {
        for (const a of matrix.SECOND_ORDER_ACTIONS) {
            const spec = matrix.secondOrderSpec(a);
            assert.ok(spec, `'${a}' has no declared spec`);
            assert.strictEqual(spec.action, a, `the spec for '${a}' names a different action`);
            assert.ok(spec.boardVerb, `'${a}' declares no board verb`);
            if (a !== 'stop') {
                assert.ok(spec.precondition, `'${a}' declares no precondition — the controller would have nothing to check`);
            }
        }
        assert.strictEqual(matrix.secondOrderSpec('stop').boardVerb, 'none',
            'stop must apply through NO board verb — it is a recorded terminus');
        assert.strictEqual(matrix.secondOrderSpec('disband-team').destroysEvidence, true,
            'disband-team closes seats, so its record must be written before the effect');
    });

    check('a matrix override naming a second-order action is refused BY NAME', () => {
        const ws = tmpWorkspace();
        fs.mkdirSync(path.join(ws, '.switchboard', 'controller'), { recursive: true });
        fs.writeFileSync(path.join(ws, '.switchboard', 'controller', 'matrix.json'), JSON.stringify({
            rows: [{
                id: 'x', order: 1, cause: 'c', judge: 'model',
                condition: { kind: 'judgement' }, remediation: 'disband-team', requires: ['model'],
            }],
        }));
        let threw = null;
        try { matrix.loadMatrix(ws); } catch (e) { threw = e; }
        assert.ok(threw, 'an override naming a second-order action must be refused, not loaded inert');
        assert.ok(/disband-team/.test(threw.message), `the refusal must name it: ${threw && threw.message}`);
        assert.ok(/separate axis/.test(threw.message), `the refusal must say WHY: ${threw && threw.message}`);
    });

    check('the closed set is stated in the wake assumptions', () => {
        assert.ok(/second-order actions: at most one Navigator ask per subject per/.test(controllerSrc),
            'the bounds and the closed set must be visible in the report the operator reads');
        assert.ok(/SECOND_ORDER_ACTIONS\.join/.test(controllerSrc),
            'the assumptions line must read the closed set rather than restating it');
    });

    // ── 2. Verification is mechanical ───────────────────────────────────

    const stub = await startModelStub({
        reply: (kind) => (kind === 'secondOrder' ? 'redispatch'
            : kind === 'board' ? 'nothing wrong'
                : kind === 'digest' ? 'NAV-DIGEST-REPLY: noted.'
                    : 'ok'),
    });

    try {
        await checkAsync('a remediation that WORKED produces a success verification and ZERO Navigator calls', async () => {
            stub.calls.length = 0;
            // The action awaiting verification was applied for a DIFFERENT row,
            // so the row that was remediated no longer fires for this subject:
            // the situation changed, which is the mechanical success signal.
            const board = scenario({
                navigatorView: navigatorConfigured(stub.url),
                state: spentLadderState({ pending: { action: 'reset-context', ruleId: 'idle-no-blocker', at: Date.now() - 60_000, secondOrder: false } }),
            });
            await oneWake({ board, workspaceRoot: tmpWorkspace() });
            assert.strictEqual(stub.ofKind('secondOrder').length, 0,
                'a remediation that worked must make ZERO second-order calls');
            const body = lastReportBody(board);
            assert.ok(/verification of the previous action: \*\*success\*\*/.test(body),
                `the report must carry the success verification: ${body}`);
            assert.ok(/verification:success/.test(body), 'the entry must be identifiable as a success verification');
        });

        await checkAsync('a remediation that did NOT work, with the ladder spent, makes EXACTLY ONE Navigator call', async () => {
            stub.calls.length = 0;
            const board = scenario({ navigatorView: navigatorConfigured(stub.url) });
            await oneWake({ board, workspaceRoot: tmpWorkspace() });
            assert.strictEqual(stub.ofKind('secondOrder').length, 1,
                `expected exactly one second-order call, got ${stub.ofKind('secondOrder').length}`);
            const asked = stub.ofKind('secondOrder')[0];
            assert.ok(/The action that did not work: `stop`/.test(asked.user),
                `the prompt must name the action that failed: ${asked.user}`);
            assert.ok(/Rule that keeps firing: `crashed-dead-process`/.test(asked.user),
                'the prompt must name the row that keeps firing');
            assert.ok(/Consecutive passes this subject has been stuck: 4/.test(asked.user),
                'the prompt must carry what has already been tried');
            for (const a of matrix.SECOND_ORDER_ACTIONS) {
                assert.ok(asked.system.includes(a), `the closed set must be stated in the prompt (missing '${a}')`);
            }
            assert.ok(/never coerced to the nearest name/.test(asked.system),
                'the prompt must state the reply contract');
            assert.ok(/cannot name a team, a seat, a card, a column or a command/.test(asked.system),
                'the fence must be stated: the model has no composition surface');
            const body = lastReportBody(board);
            assert.ok(/verification of the previous action: \*\*failed\*\*/.test(body),
                `the report must carry the failed verification: ${body}`);
            assert.ok(/second-order action: `redispatch` — \*\*applied\*\*/.test(body),
                `the chosen action must be recorded as applied: ${body}`);
        });

        await checkAsync('the applied action records the model id, the evidence and the reason', async () => {
            const board = scenario({ navigatorView: navigatorConfigured(stub.url) });
            await oneWake({ board, workspaceRoot: tmpWorkspace() });
            const body = lastReportBody(board);
            assert.ok(/chosen by: `local \(stub-navigator\)`/.test(body),
                `the model that chose it must be recorded: ${body}`);
            assert.ok(/stated reason: redispatch/.test(body),
                'the Navigator\'s stated reason must be recorded');
            assert.ok(/evidence window: fleet liveness/.test(body),
                'the evidence the decision rested on must be recorded');
        });

        await checkAsync('a subject that received a Pilot remediation this wake gets NO second-order action', async () => {
            stub.calls.length = 0;
            // Rung 0 with a pending record: this wake both verifies the last
            // action AND applies the next rung, so the Pilot acted on this
            // subject. The two ladders must never both act in one wake.
            const board = scenario({
                navigatorView: navigatorConfigured(stub.url),
                state: {
                    subjects: {
                        'card:plan-1': {
                            rung: 0, atRung: 0, ruleId: 'crashed-dead-process',
                            firstSeenAt: Date.now() - 60 * 60_000, lastFiredAt: Date.now() - 60 * 60_000,
                            ownerSince: STUCK_SINCE, stuckPasses: 3, lastClass: null,
                            pending: { action: 'bare-enter', ruleId: 'crashed-dead-process', at: Date.now() - 60_000, secondOrder: false },
                        },
                    },
                },
            });
            await oneWake({ board, workspaceRoot: tmpWorkspace() });
            assert.strictEqual(stub.ofKind('secondOrder').length, 0,
                'the Navigator must not be asked on a wake where the Pilot remediated the subject');
            const body = lastReportBody(board);
            assert.ok(/verification of the previous action: \*\*failed\*\*/.test(body),
                'the failed verdict must ride the SUCCESSOR entry');
            assert.ok(/- rung: `reset-context`/.test(body),
                `the Pilot must have applied its own rung: ${body}`);
        });

        // ── 3. The reply is validated, never coerced ────────────────────

        await checkAsync('a reply outside the closed set applies NOTHING and is recorded as DISCARDED', async () => {
            const stubBad = await startModelStub({
                reply: (kind) => (kind === 'secondOrder' ? 'the seat looks confused, I would nudge it again and ask the lead'
                    : kind === 'digest' ? 'NAV-DIGEST-REPLY: noted.' : 'ok'),
            });
            try {
                const board = scenario({ navigatorView: navigatorConfigured(stubBad.url) });
                await oneWake({ board, workspaceRoot: tmpWorkspace() });
                assert.strictEqual(stubBad.ofKind('secondOrder').length, 1, 'the ask still happens');
                assert.strictEqual(board.seen.dispatchBodies.length, 0, 'nothing may be dispatched');
                assert.strictEqual(board.seen.teamStops.length, 0, 'nothing may be disbanded');
                assert.strictEqual(board.seen.moves.length, 0, 'nothing may be moved');
                assert.strictEqual(board.seen.pauses.length, 0, 'nothing may be stood down');
                const body = lastReportBody(board);
                assert.ok(/second-order action: \(none chosen\) — \*\*discarded\*\*/.test(body),
                    `the reply must be recorded as discarded: ${body}`);
                assert.ok(/never coerced to a nearest name/.test(body),
                    'the report must say the reply was NOT coerced');
            } finally {
                await stubBad.close();
            }
        });

        await checkAsync('a reply naming TWO actions is ambiguous and is discarded, not picked from', async () => {
            const stubAmb = await startModelStub({
                reply: (kind) => (kind === 'secondOrder' ? 'redispatch or disband-team'
                    : kind === 'digest' ? 'NAV-DIGEST-REPLY: noted.' : 'ok'),
            });
            try {
                const board = scenario({ navigatorView: navigatorConfigured(stubAmb.url) });
                await oneWake({ board, workspaceRoot: tmpWorkspace() });
                assert.strictEqual(board.seen.dispatchBodies.length, 0, 'an ambiguous reply must not dispatch');
                assert.strictEqual(board.seen.teamStops.length, 0, 'an ambiguous reply must not disband');
                assert.ok(/\*\*discarded\*\*/.test(lastReportBody(board)),
                    `an ambiguous reply must be discarded: ${lastReportBody(board)}`);
            } finally {
                await stubAmb.close();
            }
        });

        // ── 4. Preconditions are checked by the controller ──────────────

        await checkAsync('a reply whose PRECONDITIONS are unmet applies nothing and records the failed precondition', async () => {
            const stubPre = await startModelStub({
                reply: (kind) => (kind === 'secondOrder' ? 'disband-team'
                    : kind === 'digest' ? 'NAV-DIGEST-REPLY: noted.' : 'ok'),
            });
            try {
                // No mission holds this card, so the subject has no team of its
                // own — the precondition for disband-team is unmet.
                const board = scenario({ navigatorView: navigatorConfigured(stubPre.url), missions: [] });
                await oneWake({ board, workspaceRoot: tmpWorkspace() });
                assert.strictEqual(board.seen.teamStops.length, 0,
                    'the controller must refuse disband-team for a subject with no team');
                const body = lastReportBody(board);
                assert.ok(/second-order action: `disband-team` — \*\*refused\*\*/.test(body),
                    `the refusal must be recorded: ${body}`);
                assert.ok(/unmet precondition: no mission on the board holds this subject/.test(body),
                    `the failed precondition must be recorded verbatim: ${body}`);
            } finally {
                await stubPre.close();
            }
        });

        await checkAsync('the triggering condition is RE-CHECKED, and a resolved one aborts with its reason', async () => {
            const stubRace = await startModelStub({
                reply: (kind) => (kind === 'secondOrder' ? 'redispatch'
                    : kind === 'digest' ? 'NAV-DIGEST-REPLY: noted.' : 'ok'),
            });
            try {
                // The card is completed between the diagnosis and the action.
                const board = scenario({
                    navigatorView: navigatorConfigured(stubRace.url),
                    plansAfterFirst: [deadSeatPlan({ completedAt: new Date().toISOString() })],
                });
                await oneWake({ board, workspaceRoot: tmpWorkspace() });
                assert.strictEqual(board.seen.dispatchBodies.length, 0,
                    'a situation that resolved itself must not be acted on');
                const body = lastReportBody(board);
                assert.ok(/\*\*aborted\*\*/.test(body), `the abort must be recorded: ${body}`);
                assert.ok(/the card was completed \(/.test(body),
                    'the reason must be recorded, not merely the abort');
            } finally {
                await stubRace.close();
            }
        });

        // ── 5. The bounds bite, and they are reported ───────────────────

        await checkAsync('the per-subject rate suppresses the ask with a stated reason', async () => {
            stub.calls.length = 0;
            // `wakes` is carried in the state, so seed it explicitly: the wake
            // counter increments to 101 on this wake, one wake after the ask.
            const seeded = spentLadderState({ secondOrderAskWake: 100, secondOrderCount: 1, secondOrderLast: 'redispatch' });
            seeded.wakes = 100;
            const board = makeBoard({
                plans: [deadSeatPlan()], fleet: [], missions: [],
                navigatorView: navigatorConfigured(stub.url),
                state: seeded,
            });
            await oneWake({ board, workspaceRoot: tmpWorkspace() });
            assert.strictEqual(stub.ofKind('secondOrder').length, 0,
                'the per-subject rate must suppress the ask BEFORE the call is made');
            const body = lastReportBody(board);
            assert.ok(/\*\*suppressed\*\*/.test(body), `the suppression must be recorded: ${body}`);
            assert.ok(/the per-subject rate allows one ask per 3 wakes/.test(body),
                'the suppression must state its reason and the bound');
            assert.ok(/continues on the first-order ladder/.test(body),
                'the report must say the subject is not abandoned by the suppression');
            assert.ok(/_No rule fired this pass\./.test(body) === false, 'the suppression is an entry, not silence');
        });

        await checkAsync('the daily cap suppresses the ask with a stated reason', async () => {
            stub.calls.length = 0;
            const seeded = spentLadderState();
            seeded.secondOrderCalls = { dayKey: new Date().toISOString().slice(0, 10), count: 24 };
            const board = makeBoard({
                plans: [deadSeatPlan()], fleet: [], missions: [],
                navigatorView: navigatorConfigured(stub.url),
                state: seeded,
            });
            await oneWake({ board, workspaceRoot: tmpWorkspace() });
            assert.strictEqual(stub.ofKind('secondOrder').length, 0,
                'the daily cap must suppress the ask BEFORE the call is made');
            const body = lastReportBody(board);
            assert.ok(/the daily cap is reached \(24 of 24 asks today\)/.test(body),
                `the suppression must state the cap and the count: ${body}`);
            assert.ok(/continues on the first-order ladder/.test(body),
                'the report must say the subject is not abandoned by the suppression');
            // A suppressed ask never reached a model, so it must not name one as
            // if it had — a fallback indistinguishable from a real value.
            assert.ok(!/chosen by:/.test(body), 'a suppressed ask must not claim a model chose anything');
            assert.ok(!/asked of:/.test(body), 'a suppressed ask never reached a model');
        });

        // ── 6. Each action applies through its named board verb ─────────

        const withTeam = () => [{ id: 'mission-1', team: 'coding-team', plans: ['plan-1'], features: [] }];

        await checkAsync('disband-team goes through POST /kanban/team/stop, and closes seats by NO other path', async () => {
            const stubDisband = await startModelStub({
                reply: (kind) => (kind === 'secondOrder' ? 'disband-team'
                    : kind === 'digest' ? 'NAV-DIGEST-REPLY: noted.' : 'ok'),
            });
            try {
                const board = scenario({ navigatorView: navigatorConfigured(stubDisband.url), missions: withTeam() });
                await oneWake({ board, workspaceRoot: tmpWorkspace() });
                assert.strictEqual(board.seen.teamStops.length, 1,
                    `expected exactly one POST /kanban/team/stop, got ${board.seen.teamStops.length}`);
                assert.strictEqual(board.seen.teamStops[0].teamId, 'coding-team',
                    'the team must be the subject\'s OWN team, resolved from the board');
                assert.strictEqual(board.seen.pauses.length, 0,
                    'disband-team must NOT pause the team separately — the one route owns the order');
                assert.ok(!board.seen.paths.some(p => /ptyCloseTerminal/.test(p)),
                    'no client-side seat-closing fan-out may exist');
                assert.ok(!board.seen.paths.some(p => /ptyRespawnSeat|ptyWrite|ptySendPrompt/.test(p)),
                    'disband-team touches no terminal directly');
                const body = allReportBodies(board);
                assert.ok(/status stopped, 1 card\(s\) released \(never completed\), 1 seat\(s\) closed/.test(body),
                    `the per-step outcome must be recorded: ${body}`);
                assert.ok(/record written before the effect: true/.test(body),
                    'a destructive action must say its record preceded the effect');
                assert.ok(/record written before the effect\b/.test(body) || /recorded before the effect/.test(body),
                    'the pre-effect entry must say what it is');
                // ORDER, not merely presence: the report must precede the verb.
                const firstVerb = board.seen.events.findIndex(e => e.kind === 'verb' && e.path === 'POST /kanban/team/stop');
                const lastReport = board.seen.events.reduce((acc, e, i) => (e.kind === 'report' ? i : acc), -1);
                assert.ok(firstVerb >= 0, 'the team-stop verb must have been called');
                assert.ok(lastReport >= 0, 'a report must have been written');
                assert.ok(board.seen.events.slice(0, firstVerb).some(e => e.kind === 'report' && /record is written BEFORE the effect/.test(e.body || '')),
                    'the record must be WRITTEN BEFORE the effect for an action that destroys its own evidence');
                void lastReport;
            } finally {
                await stubDisband.close();
            }
        });

        await checkAsync('stand-down-team goes through POST /kanban/mission/pause-team with the subject\'s team', async () => {
            const stubStand = await startModelStub({
                reply: (kind) => (kind === 'secondOrder' ? 'stand-down-team'
                    : kind === 'digest' ? 'NAV-DIGEST-REPLY: noted.' : 'ok'),
            });
            try {
                const board = scenario({ navigatorView: navigatorConfigured(stubStand.url), missions: withTeam() });
                await oneWake({ board, workspaceRoot: tmpWorkspace() });
                assert.strictEqual(board.seen.pauses.length, 1, 'the pause verb must be called once');
                assert.strictEqual(board.seen.pauses[0].teamId, 'coding-team');
                assert.strictEqual(board.seen.teamStops.length, 0, 'standing down is not disbanding');
                assert.ok(/stood the team `coding-team` down — 1 mission\(s\) paused, its seats left running/.test(allReportBodies(board)),
                    `the outcome must be recorded: ${allReportBodies(board)}`);
            } finally {
                await stubStand.close();
            }
        });

        await checkAsync('reset-feature-status moves the subject\'s FEATURE through POST /kanban/move', async () => {
            const stubReset = await startModelStub({
                reply: (kind) => (kind === 'secondOrder' ? 'reset-feature-status'
                    : kind === 'digest' ? 'NAV-DIGEST-REPLY: noted.' : 'ok'),
            });
            try {
                const board = makeBoard({
                    plans: [deadSeatPlan({ featureId: 'feature-9' })],
                    fleet: [], missions: [],
                    navigatorView: navigatorConfigured(stubReset.url),
                    state: spentLadderState(),
                });
                await oneWake({ board, workspaceRoot: tmpWorkspace() });
                assert.strictEqual(board.seen.moves.length, 1, 'the move verb must be called once');
                assert.strictEqual(board.seen.moves[0].planId, 'feature-9',
                    'the FEATURE must be moved, resolved from the card\'s own row');
                assert.strictEqual(board.seen.moves[0].targetColumn, 'PLAN REVIEWED',
                    'the reset column is the board\'s own queue source');
                assert.ok(/reset the status of feature `feature-9`/.test(allReportBodies(board)),
                    'the outcome must name the feature it reset');
            } finally {
                await stubReset.close();
            }
        });

        await checkAsync('a subject with no feature refuses reset-feature-status, recording the precondition', async () => {
            const stubNoFeature = await startModelStub({
                reply: (kind) => (kind === 'secondOrder' ? 'reset-feature-status'
                    : kind === 'digest' ? 'NAV-DIGEST-REPLY: noted.' : 'ok'),
            });
            try {
                const board = scenario({ navigatorView: navigatorConfigured(stubNoFeature.url) });
                await oneWake({ board, workspaceRoot: tmpWorkspace() });
                assert.strictEqual(board.seen.moves.length, 0, 'nothing may be moved');
                assert.ok(/the subject belongs to no feature/.test(allReportBodies(board)),
                    `the failed precondition must be recorded: ${allReportBodies(board)}`);
            } finally {
                await stubNoFeature.close();
            }
        });

        // ── 7. stop is the terminus, and it is reachable ────────────────

        await checkAsync('stop applies through NO board verb, and the subject is never asked again', async () => {
            const stubStop = await startModelStub({
                reply: (kind) => (kind === 'secondOrder' ? 'stop'
                    : kind === 'digest' ? 'NAV-DIGEST-REPLY: noted.' : 'ok'),
            });
            try {
                const board = scenario({ navigatorView: navigatorConfigured(stubStop.url), missions: withTeam() });
                const ws = tmpWorkspace();
                await oneWake({ board, workspaceRoot: ws });
                assert.strictEqual(stubStop.ofKind('secondOrder').length, 1, 'stop is chosen once');
                assert.strictEqual(board.seen.teamStops.length, 0, 'stop is not disband-team');
                assert.strictEqual(board.seen.dispatchBodies.length, 0, 'stop dispatches nothing');
                assert.ok(/second-order axis is at its terminus/.test(allReportBodies(board)),
                    'the terminus must be recorded');
                const st = board.state().subjects['card:plan-1'];
                assert.strictEqual(st.stoppedBySecondOrder, true, 'the subject must be marked stopped');
                assert.strictEqual(st.exhausted, true, 'both axes must stop');
                // A following wake: the subject is a candidate no longer.
                await oneWake({ board, workspaceRoot: ws });
                assert.strictEqual(stubStop.ofKind('secondOrder').length, 1,
                    'the terminus must not be re-asked on the next wake');
            } finally {
                await stubStop.close();
            }
        });

        // ── 8. With no Navigator, the Pilot is untouched ────────────────

        await checkAsync('with NO Navigator configured the second-order axis is inert', async () => {
            stub.calls.length = 0;
            const board = scenario({ navigatorView: { source: 'unset', reason: 'no Navigator model configured' } });
            await oneWake({ board, workspaceRoot: tmpWorkspace() });
            assert.strictEqual(stub.ofKind('secondOrder').length, 0, 'no Navigator may be called');
            assert.strictEqual(board.seen.teamStops.length, 0, 'no team may be stopped');
            assert.strictEqual(board.seen.dispatchBodies.length, 0, 'nothing may be dispatched');
            assert.strictEqual(board.seen.moves.length, 0, 'nothing may be moved');
            assert.ok(!/second-order action:/.test(lastReportBody(board)),
                'no second-order entry may be emitted when there is no Navigator');
            assert.ok(!/verification:failed/.test(lastReportBody(board)),
                'a failed verdict with nothing to do about it is not emitted — the report is unchanged from today');
            assert.ok(/_No rule fired this pass\./.test(lastReportBody(board)),
                `the Pilot's own report must be untouched: ${lastReportBody(board)}`);
        });

        // ── 9. The trigger is reachable without seeding ─────────────────

        await checkAsync('the real sequence reaches the Navigator: the Pilot spends its ladder, the next wake asks', async () => {
            const stubSeq = await startModelStub({
                reply: (kind) => (kind === 'secondOrder' ? 'redispatch'
                    : kind === 'digest' ? 'NAV-DIGEST-REPLY: noted.' : 'ok'),
            });
            try {
                // Row 4 on a card with NO prior ladder state. The reachable rungs
                // with no classifier tier and one provider are
                // bare-enter -> redeliver-dispatch -> respawn-seat -> reset-context -> stop,
                // and row 4's own remediation is `reset-context`, so the ladder
                // enters at that rung and the next application is `stop`.
                const board = makeBoard({
                    plans: [deadSeatPlan()], fleet: [], missions: [],
                    navigatorView: navigatorConfigured(stubSeq.url),
                    logTail: '## 2026-09-22T01:02:03.004Z — Fix the flaky test\n\n> Reading the failing test now\n',
                    state: {},
                });
                const ws = tmpWorkspace();
                const seenRungs = [];
                for (let i = 0; i < 2; i++) {
                    await oneWake({ board, workspaceRoot: ws });
                    const m = lastReportBody(board).match(/- rung: `([a-z-]+)`/);
                    seenRungs.push(m ? m[1] : '(none)');
                }
                assert.deepStrictEqual(seenRungs, ['reset-context', 'stop'],
                    `the Pilot must apply exactly one rung per wake: ${JSON.stringify(seenRungs)}`);
                assert.strictEqual(stubSeq.ofKind('secondOrder').length, 0,
                    'the Navigator must not be asked while the Pilot still has a rung to apply');
                // The wake after `stop`: the Pilot applies NOTHING, so the
                // Navigator gets its turn — without any seeded state.
                await oneWake({ board, workspaceRoot: ws });
                assert.strictEqual(stubSeq.ofKind('secondOrder').length, 1,
                    'the wake after the ladder is spent must ask the Navigator exactly once');
                const body = lastReportBody(board);
                assert.ok(/verification of the previous action: \*\*failed\*\*/.test(body),
                    'and it must carry the failed verification of the stop rung');
                assert.ok(/second-order action: `redispatch` — \*\*applied\*\*/.test(body),
                    `the chosen action must be applied through its verb: ${body}`);
                assert.strictEqual(board.seen.dispatchBodies.length, 1,
                    'redispatch must go through POST /kanban/dispatch');
            } finally {
                await stubSeq.close();
            }
        });

        // ── 10. The call is counted against the Navigator's station ─────

        await checkAsync('the second-order ask is counted against the Navigator\'s own model', async () => {
            stub.calls.length = 0;
            const board = scenario({ navigatorView: navigatorConfigured(stub.url) });
            await oneWake({ board, workspaceRoot: tmpWorkspace() });
            assert.ok(board.seen.stateWrites.length >= 1, 'the controller must persist its state');
            const byModel = board.seen.stateWrites[0].state.modelCalls.byModel;
            assert.strictEqual(byModel['local/stub-navigator'], 2,
                `the second-order ask and the digest must both be counted against the Navigator, got ${byModel['local/stub-navigator']}`);
            assert.strictEqual(board.seen.stateWrites[0].state.secondOrderCalls.count, 1,
                'the daily cap counter must advance with the ask');
        });

        await checkAsync('the pending verification and the ask counter are CARRIED across wakes', async () => {
            const board = scenario({ navigatorView: navigatorConfigured(stub.url) });
            await oneWake({ board, workspaceRoot: tmpWorkspace() });
            const st = board.state().subjects['card:plan-1'];
            assert.strictEqual(st.secondOrderCount, 1, 'the applied count must persist');
            assert.strictEqual(st.secondOrderLast, 'redispatch', 'what was chosen must persist, for the next ask\'s history');
            assert.ok(st.pending && st.pending.secondOrder === true && st.pending.action === 'redispatch',
                'the applied second-order action must itself await verification');
            assert.ok(typeof st.secondOrderAskWake === 'number', 'the rate bound needs the wake the ask was made on');
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
