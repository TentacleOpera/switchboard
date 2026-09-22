'use strict';

/**
 * Contract: a mission is watched for the whole of its life
 * (plan: a-mission-is-watched-for-the-whole-of-its-life).
 *
 * These are BEHAVIOURAL assertions against the compiled controller in `out/`,
 * driven end-to-end through `runController` with an injected board and a real
 * (local, stub) model endpoint. The defects this plan is about — a mission rule
 * that silently requires a held card, a stall window invented rather than
 * derived, a Navigator on the cadence, a failed read rendering as "no missions"
 * — are invisible to a text search and only show up when a wake actually runs.
 *
 * The two load-bearing invariants:
 *   - **An empty list is a CLAIM and needs a source.** "The host has not
 *     answered yet" and "there is genuinely nothing" must never render the same
 *     string, so the `### Missions` section is present in ALL THREE states and a
 *     failed progress read says "mission state could not be read".
 *   - **The Pilot detects, the Navigator adjudicates.** Detection is mechanical
 *     and runs every wake; the Navigator is called on exactly ONE condition,
 *     stalled AND unexplained, and every mechanical cause is asserted to make no
 *     model call.
 *
 * Run with:
 *   npm run compile-tests && node --require ./src/test/bootstrap/sandboxStateHome.js \
 *     src/test/controller-mission-watch-contract.test.js
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

const H = 3600_000;
const NOW = Date.now();
const iso = (ms) => new Date(ms).toISOString();

// ── A real model endpoint, on a loopback port the test owns ──────────────

const MARK = {
    classify: 'You observe one coding seat',
    board: 'You supervise a board',
    escalation: 'has escalated one case to you',
    digest: 'has just finished a wake',
    mission: 'ONE MISSION has stopped moving',
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
            const kind = system.includes(MARK.mission) ? 'mission'
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
                server,
                calls,
                url: `http://127.0.0.1:${server.address().port}/v1/chat/completions`,
                close: () => new Promise(r => server.close(r)),
                ofKind: (kind) => calls.filter(c => c.kind === kind),
            });
        });
    });
}

function classifierTier(url, over = {}) {
    return {
        providerId: 'local', role: 'classifier', locality: 'loopback', operator: 'self',
        costClass: 'free', endpoint: url, model: 'stub-classifier', keySet: false, source: 'test:tier', ...over,
    };
}

function navigatorConfigured(url) {
    return {
        providerId: 'local', endpoint: url, model: 'stub-navigator', keySet: false,
        locality: 'loopback', costClass: 'free', operator: 'self', source: 'row:navigator',
    };
}

// ── A board the controller can drive, with no HTTP and no database ───────

function makeBoard(opts = {}) {
    const seen = { paths: [], reports: [], logFetches: {}, stateWrites: [], progressReads: 0 };
    let liveState = opts.state || {};
    const ok = (obj) => ({ status: 200, body: JSON.stringify(obj), json: () => obj });
    const raw = (body) => ({ status: 200, body, json: () => ({}) });
    const fail = (status, obj) => ({ status, body: JSON.stringify(obj), json: () => obj });

    const apiRequest = async (port, method, pathname, workspaceRoot, payload) => {
        seen.paths.push(`${method} ${pathname}`);
        if (pathname === '/health') { return ok({ service: 'switchboard', status: 'ok', pid: 4242 }); }
        if (pathname === '/kanban/plans') { return ok(opts.plans || []); }
        if (pathname === '/terminals/verb/ptyListTerminals') {
            if (opts.fleetFails) { return fail(500, { success: false, error: 'fleet read failed' }); }
            return ok(opts.fleet || []);
        }
        if (pathname === '/kanban/reports') { return ok({ success: true, reports: opts.finished || [] }); }
        if (pathname === '/controller/judgement') {
            return ok({ success: true, judgement: { tiers: opts.tiers || [], globalCeilingPerDay: null, source: 'test:judgement' } });
        }
        if (pathname === '/controller/quota') {
            if (method === 'PUT') { return ok({ success: true }); }
            return ok({ success: true, quota: { value: opts.quota || {} } });
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
        if (pathname === '/kanban/missions/progress') {
            seen.progressReads++;
            if (opts.progressFails) { return fail(500, { success: false, error: 'progress read failed' }); }
            // The REAL shape: served through `_handleReadEndpoint`, so the
            // payload is wrapped as `{ success: true, data: {...} }`. The fake
            // board mirrors it exactly — an unwrapped fake would hide a reader
            // that cannot see a working endpoint.
            return ok({
                success: true,
                data: {
                    missions: opts.missions || [],
                    summary: {},
                    outsideMissions: opts.outsideMissions || { inFlightFeatures: 0, inFlightCards: 0, parkedFeatures: 0, parkedCards: 0, parkedCardsDone: 0 },
                },
            });
        }
        if (pathname === '/kanban/missions') {
            if (opts.membershipFails) { return fail(500, { success: false, error: 'membership read failed' }); }
            return ok({ success: true, missions: opts.missionMembers || [] });
        }
        if (pathname === '/kanban/dependencies') {
            if (opts.depsFails) { return fail(500, { success: false, error: 'dependencies read failed' }); }
            const dependencies = [];
            for (const [pid, deps] of Object.entries(opts.deps || {})) {
                for (const d of deps) { dependencies.push({ planId: pid, dependsOnPlanId: d }); }
            }
            return ok({ success: true, dependencies });
        }
        if (/^\/terminals\/.+\/log$/.test(pathname)) {
            const seat = decodeURIComponent(pathname.split('/')[2]);
            seen.logFetches[seat] = (seen.logFetches[seat] || 0) + 1;
            const tails = opts.logTails || {};
            return raw(tails[seat] !== undefined ? tails[seat] : (opts.logTail !== undefined ? opts.logTail : 'seat output line\n'));
        }
        if (pathname === '/kanban/dispatch') { return ok({ success: true }); }
        if (pathname === '/kanban/queue/done') { return ok({ success: true }); }
        if (pathname === '/terminals/clear') { return ok({ success: true, cleared: [] }); }
        return ok({ success: true });
    };
    return { apiRequest, seen, state: () => liveState };
}

function tmpWorkspace() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'sb-mission-'));
}

/** A worktree with a file written NOW, so a write scan sees this round's work. */
function writtenWorktree() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-wt-'));
    fs.writeFileSync(path.join(dir, 'work.txt'), 'the work\n');
    return dir;
}

async function oneWake({ board, workspaceRoot }) {
    const { runController } = requireOut('standalone/controller/controller.js');
    return runController({
        workspaceRoot,
        port: 7777,
        apiRequest: board.apiRequest,
        controllerId: 'controller:test',
        once: true,
        now: () => Date.now(),
        log: () => {},
    });
}

const reportBody = (board) => (board.seen.reports[0] && board.seen.reports[0].body) || '';

function planRow(id, over = {}) {
    return {
        planId: id, sessionId: id, topic: `topic ${id}`, kanbanColumn: 'STAGING', project: '',
        isFeature: 0, featureId: '', ownerSeat: '', ownerSince: null, completedAt: null,
        planFile: `/tmp/${id}.md`, ...over,
    };
}

function progressRow(over = {}) {
    return {
        id: 'm1', name: 'Mission One', goal: 'ship the thing', team: null, teams: [],
        ready: true, paused: false, cardsTotal: 3, cardsDone: 2, cardsInFlight: 0, cardsWorking: 0,
        columns: { STAGING: 1 }, startedAt: iso(NOW - 24 * H),
        lastMovementAt: NOW - 6 * H, runState: 'in-flight', sequencing: [], ...over,
    };
}

/** Two completed members one hour apart, so the derived window is 3h. */
function twoCompletions() {
    return [
        planRow('p1', { completedAt: iso(NOW - 10 * H), kanbanColumn: 'COMPLETED' }),
        planRow('p2', { completedAt: iso(NOW - 9 * H), kanbanColumn: 'COMPLETED' }),
    ];
}

const members = (ids, features = []) => [{ id: 'm1', plans: ids, features }];

// ═══════════════════════════════════════════════════════════════════════

async function run() {
    console.log('\nContract: a mission is watched for the whole of its life\n');

    const controllerSrc = fs.readFileSync(path.join(ROOT, 'src', 'standalone', 'controller', 'controller.ts'), 'utf8');

    // ── 1. The matrix is untouched, and the watch is outside the loop ─────

    check('matrix.ts carries no mission RULE — it is read, not modified', () => {
        const matrix = requireOut('standalone/controller/matrix.js');
        // The closed sets are what an operator's `matrix.json` is validated
        // against, so a mission entry added to any of them is the change that
        // must NOT happen. Asserted as a delta-free property rather than a
        // hardcoded count: a future row retirement must not fail this test.
        assert.ok(!matrix.DEFAULT_MATRIX_ROWS.some(r => /mission/i.test(r.id)),
            'no mission row may enter the shipped matrix');
        assert.ok(!matrix.MATRIX_CONDITION_KINDS.some(k => /mission/i.test(k)),
            'no mission condition kind may enter the closed set');
        assert.ok(!matrix.MATRIX_TARGETS.some(t => /mission/i.test(t)),
            'no mission target may enter the closed set');
        assert.ok(!matrix.MATRIX_REMEDIATIONS.some(r => /mission/i.test(r)),
            'no mission remediation may enter the closed values array');
        assert.ok(!/DEFAULT_MATRIX_ROWS\.push/.test(controllerSrc), 'the controller must not add a matrix row');
    });

    check('mission-stalled is reachable, and emitted from OUTSIDE the subject loop', () => {
        assert.ok(/ruleId: 'mission-stalled'/.test(controllerSrc), 'mission-stalled must be emitted');
        assert.ok(/ruleId: 'mission-out-of-order'/.test(controllerSrc), 'mission-out-of-order must be emitted');
        assert.ok(/ruleId: 'mission-unjudgeable'/.test(controllerSrc), 'mission-unjudgeable must be emitted');
        const watchIdx = controllerSrc.indexOf('await watchMissions(');
        const loopIdx = controllerSrc.indexOf('for (const subject of subjects)');
        assert.ok(watchIdx > 0, 'the mission watch must be invoked');
        assert.ok(loopIdx > 0, 'the subject loop must exist');
        assert.ok(watchIdx < loopIdx, 'the mission watch must run outside the subject loop');
    });

    check('the mission watch reuses the wake\'s evidence — one /proc read, one log fetch per seat', () => {
        const procReads = (controllerSrc.match(/readProcessTable\(/g) || []).length;
        assert.strictEqual(procReads, 1,
            `expected exactly ONE /proc snapshot per wake, got ${procReads} — the mission watch must reuse it, not rescan`);
        assert.ok(/const readLog = \(seat: string\)/.test(controllerSrc),
            'the per-wake log memo must exist so a seat is fetched once');
        assert.ok(/observeSeatByName/.test(controllerSrc),
            'the per-seat observation memo must exist so a seat is sampled once');
    });

    check('mission progress has ONE implementation — the panel\'s endpoint, read once', () => {
        assert.strictEqual((controllerSrc.match(/'\/kanban\/missions\/progress'/g) || []).length, 1,
            'the controller must read the panel\'s own progress endpoint exactly once per wake');
        assert.ok(/const lastMovementAt = mission\.lastMovementAt;/.test(controllerSrc),
            'movement must be READ from the endpoint\'s field, never recomputed from card timestamps');
    });

    // ── 2. Zero missions, and a failed read, are DIFFERENT claims ─────────

    const stub = await startModelStub({
        reply: (kind) => (kind === 'board' ? 'nothing wrong'
            : kind === 'mission' ? 'MISSION-REPLY: the remaining work looks serial.'
                : 'ok'),
    });
    try {
        await checkAsync('a board with ZERO missions still reports a ### Missions section saying none were examined', async () => {
            const board = makeBoard({
                plans: [], missions: [], tiers: [classifierTier(stub.url)], navigatorView: navigatorConfigured(stub.url),
            });
            await oneWake({ board, workspaceRoot: tmpWorkspace() });
            const body = reportBody(board);
            assert.ok(/### Missions/.test(body), `the section must be present: ${body.slice(0, 400)}`);
            assert.ok(/No missions were examined/.test(body), 'the section must say none were examined');
            assert.ok(!body.includes('No problems found.'),
                'the unscoped clean string claims more than the check examined and must be gone');
            assert.ok(/No problems found in board health\./.test(body),
                'the clean verdict must be scoped to board health');
        });

        await checkAsync('the progress endpoint\'s WRAPPED payload is read, not mistaken for an unreadable one', async () => {
            // `_handleReadEndpoint` serves `{ success: true, data: {...} }`. A
            // reader that only looked at the top level would call a WORKING
            // endpoint unreadable — and on a board with missions would say "no
            // missions". Verified against the live host before this was fixed.
            const board = makeBoard({
                plans: twoCompletions(), missions: [progressRow()], missionMembers: members(['p1', 'p2']),
            });
            await oneWake({ board, workspaceRoot: tmpWorkspace() });
            const body = reportBody(board);
            assert.ok(/missions examined: 1/.test(body), `the wrapped payload must be read: ${body.slice(-900)}`);
            assert.ok(!/Mission state could not be read/.test(body), 'a working endpoint is not unreadable');
        });

        await checkAsync('a FAILED progress read reports "mission state could not be read", never "no missions"', async () => {
            const board = makeBoard({ plans: [], missions: [], progressFails: true });
            await oneWake({ board, workspaceRoot: tmpWorkspace() });
            const body = reportBody(board);
            assert.ok(/### Missions/.test(body), 'the section is still present');
            assert.ok(/Mission state could not be read/.test(body), 'the failed read must be stated');
            assert.ok(!/No missions were examined/.test(body),
                'a failed read must NEVER render as "no missions" — the two are different claims');
        });

        await checkAsync('a mission whose member cards cannot be read is unjudgeable, not stalled', async () => {
            const board = makeBoard({
                plans: twoCompletions(), missions: [progressRow()], membershipFails: true,
            });
            await oneWake({ board, workspaceRoot: tmpWorkspace() });
            const body = reportBody(board);
            assert.ok(/member cards could not be resolved/.test(body), body.slice(-1200));
            assert.ok(!/mission-stalled/.test(body), 'an unreadable membership is NOT a stall finding');
        });

        // ── 3. The pass does NOT depend on a held card ────────────────────

        await checkAsync('with ZERO subjects a mission action is still emitted — the pass never needs a held card', async () => {
            const board = makeBoard({
                plans: [],
                missions: [progressRow({ cardsTotal: 2, cardsDone: 0 })],
                missionMembers: members([]),
            });
            await oneWake({ board, workspaceRoot: tmpWorkspace() });
            const body = reportBody(board);
            assert.ok(/### mission `mission`/.test(body),
                `a kind:'mission' action must be emitted with zero subjects: ${body.slice(0, 400)}`);
            assert.ok(/_No rule fired this pass\./.test(body),
                'no matrix row fired — proving the mission action did not come from a subject');
        });

        // ── 4. The six mechanical checks, in order ────────────────────────

        await checkAsync('CHECK 1 — an unposted completion is asked FIRST, before any board field', async () => {
            // The mission is ALSO team-down. The unposted completion must win:
            // it is the cause that is actually actionable.
            const board = makeBoard({
                plans: [
                    ...twoCompletions(),
                    planRow('p3', { kanbanColumn: 'CODER CODED', ownerSeat: 'coder-1', ownerSince: iso(NOW - 3 * H) }),
                ],
                fleet: [{ friendlyName: 'coder-1', status: 'active', lastDataAt: NOW - 3 * H, cliFamily: 'claude', worktreePath: writtenWorktree() }],
                finished: [{ plan_id: 'p3', timestamp: iso(NOW - 4 * H) }],
                missions: [progressRow({ team: 'ghost-team', cardsInFlight: 1 })],
                missionMembers: members(['p1', 'p2', 'p3']),
                navigatorView: navigatorConfigured(stub.url),
            });
            await oneWake({ board, workspaceRoot: tmpWorkspace() });
            const body = reportBody(board);
            assert.ok(/finished and never posted/.test(body), `the unposted completion must be the finding: ${body.slice(-1500)}`);
            assert.ok(/mission-stalled/.test(body), 'the rule id must be mission-stalled');
            assert.ok(!/team is not live/.test(body), 'a board-field answer must NOT arrive before the unposted completion');
            assert.strictEqual(stub.ofKind('mission').length, 0, 'a mechanical cause makes NO model call');
        });

        await checkAsync('CHECK 2 — a dead seat and a waiting-on-human seat are each named, with no model call', async () => {
            const dead = makeBoard({
                plans: [
                    ...twoCompletions(),
                    planRow('p3', { kanbanColumn: 'CODER CODED', ownerSeat: 'coder-9', ownerSince: iso(NOW - 3 * H) }),
                ],
                fleet: [{ friendlyName: 'coder-9', status: 'exited', lastDataAt: NOW - 5 * H, cliFamily: 'claude' }],
                missions: [progressRow({ cardsInFlight: 1 })],
                missionMembers: members(['p1', 'p2', 'p3']),
                navigatorView: navigatorConfigured(stub.url),
            });
            await oneWake({ board: dead, workspaceRoot: tmpWorkspace() });
            assert.ok(/seat is dead/.test(reportBody(dead)), reportBody(dead).slice(-1200));
            assert.strictEqual(stub.ofKind('mission').length, 0, 'a dead seat makes NO model call');

            const human = makeBoard({
                plans: [
                    ...twoCompletions(),
                    planRow('p3', { kanbanColumn: 'CODER CODED', ownerSeat: 'coder-1', ownerSince: iso(NOW - 3 * H) }),
                ],
                fleet: [{ friendlyName: 'coder-1', status: 'active', lastDataAt: NOW - 3 * H, cliFamily: 'claude' }],
                logTails: { 'coder-1': 'I have finished the parser.\nShould I also update the docs?\n' },
                missions: [progressRow({ cardsInFlight: 1 })],
                missionMembers: members(['p1', 'p2', 'p3']),
                navigatorView: navigatorConfigured(stub.url),
            });
            await oneWake({ board: human, workspaceRoot: tmpWorkspace() });
            assert.ok(/waiting on a human/.test(reportBody(human)), reportBody(human).slice(-1200));
            assert.strictEqual(stub.ofKind('mission').length, 0, 'a waiting-on-human seat makes NO model call');
        });

        await checkAsync('CHECK 4 — a mission whose team is not live is named, with no model call', async () => {
            const board = makeBoard({
                plans: [...twoCompletions(), planRow('p3')],
                fleet: [{ friendlyName: 'Feature Coder', status: 'active', lastDataAt: NOW, cliFamily: 'claude' }],
                missions: [progressRow({ team: 'ghost-team' })],
                missionMembers: members(['p1', 'p2', 'p3']),
                navigatorView: navigatorConfigured(stub.url),
            });
            await oneWake({ board, workspaceRoot: tmpWorkspace() });
            const body = reportBody(board);
            assert.ok(/team is not live/.test(body), body.slice(-1200));
            assert.strictEqual(stub.ofKind('mission').length, 0, 'a team-down mission makes NO model call');
        });

        await checkAsync('CHECK 5 — every unfinished member waiting on an incomplete predecessor is named', async () => {
            const board = makeBoard({
                plans: [...twoCompletions(), planRow('p3'), planRow('p9')],
                missions: [progressRow()],
                missionMembers: members(['p1', 'p2', 'p3']),
                deps: { p3: ['p9'] },
                navigatorView: navigatorConfigured(stub.url),
            });
            await oneWake({ board, workspaceRoot: tmpWorkspace() });
            assert.ok(/waits on an incomplete predecessor/.test(reportBody(board)), reportBody(board).slice(-1200));
            assert.strictEqual(stub.ofKind('mission').length, 0, 'a predecessor-wait makes NO model call');
        });

        await checkAsync('CHECK 6 — a member completed out of the recorded order is named', async () => {
            const board = makeBoard({
                plans: [
                    planRow('pA', { completedAt: iso(NOW - 11 * H), kanbanColumn: 'COMPLETED' }),
                    planRow('pB', { completedAt: iso(NOW - 9 * H), kanbanColumn: 'COMPLETED' }),
                    planRow('pC'),
                ],
                missions: [progressRow({ lastMovementAt: NOW - 20 * H })],
                missionMembers: members(['pA', 'pB', 'pC']),
                deps: { pA: ['pB'] },
                navigatorView: navigatorConfigured(stub.url),
            });
            await oneWake({ board, workspaceRoot: tmpWorkspace() });
            const body = reportBody(board);
            assert.ok(/recorded order and the real order disagree/.test(body), body.slice(-1200));
            assert.ok(/mission-out-of-order/.test(body), 'the rule id must be mission-out-of-order');
            assert.strictEqual(stub.ofKind('mission').length, 0, 'an out-of-order finding makes NO model call');
        });

        await checkAsync('a weirdness signal is emitted INDEPENDENTLY of the stall signal', async () => {
            const board = makeBoard({
                plans: [
                    planRow('pA', { completedAt: iso(NOW - 11 * H), kanbanColumn: 'COMPLETED' }),
                    planRow('pB', { completedAt: iso(NOW - 9 * H), kanbanColumn: 'COMPLETED' }),
                    planRow('pC'),
                ],
                // The mission is MOVING: last movement inside the derived window.
                missions: [progressRow({ lastMovementAt: NOW - 5 * 60_000 })],
                missionMembers: members(['pA', 'pB', 'pC']),
                deps: { pA: ['pB'] },
            });
            await oneWake({ board, workspaceRoot: tmpWorkspace() });
            const body = reportBody(board);
            assert.ok(/mission-out-of-order/.test(body), 'the weirdness signal fires while the mission is moving');
            assert.ok(/— moving/.test(body), 'and the mission is still reported as moving');
            assert.ok(!/Mission stalled/.test(body), 'a moving mission is never reported as stalled');
        });

        // ── 5. Paused, not-started, moving, unjudgeable ───────────────────

        await checkAsync('a paused mission is reported as paused, not stalled, with no model call', async () => {
            const board = makeBoard({
                plans: twoCompletions(), missions: [progressRow({ paused: true })],
                missionMembers: members(['p1', 'p2']), navigatorView: navigatorConfigured(stub.url),
            });
            await oneWake({ board, workspaceRoot: tmpWorkspace() });
            const body = reportBody(board);
            assert.ok(/— paused/.test(body), 'the section must say paused');
            assert.ok(!/Mission stalled/.test(body), 'a paused mission is not a stall');
            assert.strictEqual(stub.ofKind('mission').length, 0, 'a paused mission makes NO model call');
        });

        await checkAsync('a not-started mission is distinguished from one that stalled after starting', async () => {
            const board = makeBoard({
                plans: twoCompletions(), missions: [progressRow({ runState: 'not-started' })],
                missionMembers: members(['p1', 'p2']), navigatorView: navigatorConfigured(stub.url),
            });
            await oneWake({ board, workspaceRoot: tmpWorkspace() });
            const body = reportBody(board);
            assert.ok(/— not-started/.test(body), 'the section must say not-started');
            assert.ok(!/Mission stalled/.test(body), 'a mission nobody started is not a stall');
            assert.strictEqual(stub.ofKind('mission').length, 0);
        });

        await checkAsync('a mission moving inside its window is NOT reported as stalled', async () => {
            const board = makeBoard({
                plans: [
                    planRow('p1', { completedAt: iso(NOW - 10 * H), kanbanColumn: 'COMPLETED' }),
                    planRow('p2', { completedAt: iso(NOW - 1 * H), kanbanColumn: 'COMPLETED' }),
                    planRow('p3'),
                ],
                // Window is 9h x 3 = 27h; the last movement is 2h ago.
                missions: [progressRow({ lastMovementAt: NOW - 2 * H })],
                missionMembers: members(['p1', 'p2', 'p3']),
                navigatorView: navigatorConfigured(stub.url),
            });
            await oneWake({ board, workspaceRoot: tmpWorkspace() });
            const body = reportBody(board);
            assert.ok(/— moving/.test(body), body.slice(-1200));
            assert.ok(!/Mission stalled/.test(body), 'progress inside the window is not a stall');
            assert.strictEqual(stub.ofKind('mission').length, 0);
        });

        await checkAsync('a mission with ONE completion is unjudgeable, never stalled', async () => {
            const board = makeBoard({
                plans: [planRow('p1', { completedAt: iso(NOW - 10 * H), kanbanColumn: 'COMPLETED' }), planRow('p2')],
                missions: [progressRow()],
                missionMembers: members(['p1', 'p2']),
                navigatorView: navigatorConfigured(stub.url),
            });
            await oneWake({ board, workspaceRoot: tmpWorkspace() });
            const body = reportBody(board);
            assert.ok(/mission-unjudgeable/.test(body), body.slice(-1200));
            assert.ok(/fewer than 2 member completions/.test(body), 'the reason must be stated');
            assert.ok(!/Mission stalled/.test(body), 'no threshold may be invented');
            assert.strictEqual(stub.ofKind('mission').length, 0, 'an unjudgeable mission makes NO model call');
        });

        // ── 6. The Navigator is called on exactly one condition ───────────

        await checkAsync('a stalled and unexplained mission produces EXACTLY ONE Navigator call, and names the model', async () => {
            stub.calls.length = 0;
            const board = makeBoard({
                plans: [...twoCompletions(), planRow('p3')],
                missions: [progressRow()],
                missionMembers: members(['p1', 'p2', 'p3']),
                navigatorView: navigatorConfigured(stub.url),
            });
            await oneWake({ board, workspaceRoot: tmpWorkspace() });
            const body = reportBody(board);
            assert.strictEqual(stub.ofKind('mission').length, 1,
                `expected exactly one mission adjudication call, got ${stub.ofKind('mission').length}`);
            assert.strictEqual(stub.calls.length, 1, 'and no digest and no escalation alongside it');
            assert.ok(/stub-navigator/.test(body), 'the report must name the model that answered');
            assert.ok(/MISSION-REPLY/.test(body), 'the report must record the reply');
            assert.ok(/stalled and unexplained/.test(body), body.slice(-1500));
            // The prompt carries the mission's SHAPE, not a board histogram.
            const user = stub.ofKind('mission')[0].user;
            assert.ok(/Mission: m1 "Mission One"/.test(user), user);
            assert.ok(/waits on/.test(user), 'the members and their recorded edges must be sent');
        });

        await checkAsync('a wake with ZERO stalled missions makes ZERO Navigator calls', async () => {
            stub.calls.length = 0;
            const board = makeBoard({
                plans: [
                    planRow('p1', { completedAt: iso(NOW - 10 * H), kanbanColumn: 'COMPLETED' }),
                    planRow('p2', { completedAt: iso(NOW - 1 * H), kanbanColumn: 'COMPLETED' }),
                    planRow('p3'),
                ],
                missions: [progressRow({ lastMovementAt: NOW - 2 * H })],
                missionMembers: members(['p1', 'p2', 'p3']),
                navigatorView: navigatorConfigured(stub.url),
            });
            await oneWake({ board, workspaceRoot: tmpWorkspace() });
            assert.strictEqual(stub.calls.length, 0,
                `the Navigator must not be on the cadence: ${JSON.stringify(stub.calls.map(c => c.kind))}`);
        });

        // ── 7. Evidence reuse, and state pruning ──────────────────────────

        await checkAsync('a seat that is both a held subject and a mission member is fetched ONCE', async () => {
            const board = makeBoard({
                plans: [
                    ...twoCompletions(),
                    planRow('p3', { kanbanColumn: 'CODER CODED', ownerSeat: 'coder-1', ownerSince: iso(NOW - 3 * H) }),
                ],
                fleet: [{ friendlyName: 'coder-1', status: 'active', lastDataAt: NOW - 3 * H, cliFamily: 'claude' }],
                logTails: { 'coder-1': 'nothing notable in this tail\n' },
                missions: [progressRow({ cardsInFlight: 1 })],
                missionMembers: members(['p1', 'p2', 'p3']),
                tiers: [classifierTier(stub.url)],
            });
            await oneWake({ board, workspaceRoot: tmpWorkspace() });
            assert.strictEqual(board.seen.logFetches['coder-1'], 1,
                `the seat's log must be fetched once per wake, got ${board.seen.logFetches['coder-1']}`);
            assert.strictEqual(board.seen.progressReads, 1, 'mission progress is read once per wake');
        });

        await checkAsync('per-mission state is pruned to the LIVE mission ids', async () => {
            const workspaceRoot = tmpWorkspace();
            const withMission = makeBoard({
                plans: twoCompletions(), missions: [progressRow()], missionMembers: members(['p1', 'p2']),
            });
            await oneWake({ board: withMission, workspaceRoot });
            const afterFirst = withMission.seen.stateWrites[withMission.seen.stateWrites.length - 1];
            assert.ok(afterFirst && afterFirst.state && afterFirst.state.missions && afterFirst.state.missions.m1,
                'the first wake must persist an observation for m1');

            // The mission is DELETED between wakes; its state must not leak.
            const without = makeBoard({ plans: twoCompletions(), missions: [], state: afterFirst.state });
            await oneWake({ board: without, workspaceRoot });
            const afterSecond = without.seen.stateWrites[without.seen.stateWrites.length - 1];
            assert.ok(afterSecond && afterSecond.state && afterSecond.state.missions,
                'the missions map must be persisted');
            assert.ok(!afterSecond.state.missions.m1,
                'a deleted mission\'s observation must be pruned, exactly as state.subjects is');
        });

        await checkAsync('a mission that completed between wakes is pruned and gets no final stall', async () => {
            const board = makeBoard({
                plans: twoCompletions(),
                missions: [progressRow({ runState: 'completed' })],
                missionMembers: members(['p1', 'p2']),
            });
            await oneWake({ board, workspaceRoot: tmpWorkspace() });
            const body = reportBody(board);
            assert.ok(!/Mission stalled/.test(body), 'a completed mission is not a stall');
            assert.ok(!/### mission `m1`/.test(body), 'no finding action is emitted for a completed mission');
        });

        await checkAsync('an unreadable fleet is NOT a claim that a team is down', async () => {
            const board = makeBoard({
                plans: [...twoCompletions(), planRow('p3')],
                fleetFails: true,
                missions: [progressRow({ team: 'ghost-team' })],
                missionMembers: members(['p1', 'p2', 'p3']),
                navigatorView: navigatorConfigured(stub.url),
            });
            await oneWake({ board, workspaceRoot: tmpWorkspace() });
            const body = reportBody(board);
            assert.ok(/fleet could not be read/.test(body), 'the failed read must be stated');
            assert.ok(!/team is not live/.test(body),
                'an unreadable fleet must never be read as "no seats", which would make every team look down');
        });
    } finally {
        await stub.close();
    }

    console.log(`\n${failures === 0 ? 'ALL PASSED' : `${failures} FAILED`}\n`);
    process.exit(failures === 0 ? 0 : 1);
}

run().catch(err => {
    console.error(err);
    process.exit(1);
});
